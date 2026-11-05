# Step 15c: Invoices, money receipts and the credit limit — from goods delivered to money in the bank

> The implementation guide for the third part of "Phase 5 → Step 15" of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 15 (Sales) is split into four guides: 15a
> (customers, price lists, VAT), 15b (quotations, orders, deliveries), this one (15c), then 15d (returns and credit
> notes).
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `631c398`, the end of
> step 15b) and checked on 2026-10-11: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (322 — 35 new), `pnpm test:integration` (307 — 29 new), `pnpm test:tenant-leak` (59 — 4 new), `pnpm build`, `pnpm test:bundle-size` (first load 192.7 KB gz, budget 200; the receipt form 97.4 KB, the invoice list 96.8 KB, the invoice lines 90.8 KB, the invoice form 87.4 KB), `pnpm gen:openapi` (133 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 148 — 16 new, desktop and 390px; two timed out once on a busy machine and passed when run again, 15c.8) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres: 50 checks of migration 0030 run as `omnivo_app`
>   with SQL the API would never send (a posted invoice changed, "paid" written by hand, a receipt applied twice),
>   and two sessions paying one invoice at once: the second waits, then fails (15c.2's "Check this part").
> - **The whole chain in a browser**, through the end-to-end tests on a desktop and a 390px phone: a challan billed
>   with "Make invoice", an invoice that delivers its own goods, an order's service billed, an invoice going
>   overdue, a credit limit that stops a confirm, a payment applied, voided, and an advance applied later.
> - **Guards broken on purpose**: without the "higher than before" rule in `CreditService.check()`, billing a
>   confirmed order is refused; without the advisory lock in `CreditService.lock()`, or the `FOR UPDATE` in
>   `ReceiptsService.apply()`, the replay tests fail (15c.4); without the removed invoices in
>   `allocationChanges()`, the audit test fails (15c.5); without the refusal in the mock's `checkCredit()`, the
>   end-to-end credit test fails (15c.7). Each check ran its whole test file, and the code was restored after it.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` first
> (migrations 0029 and 0030), or every invoice and receipt page fails. 0030 ticks "Holds money" on your cash
> account and on the groups coded 1120 and 1130; if you renamed or moved them, tick yours by hand (15c.10). (2) The
> new tests on GitHub Actions. (3) The Bangla texts were written by me, not reviewed by a native speaker. (4) The
> screens were not looked at by eye in the dark theme. (5) **The printed page was not printed.** The end-to-end
> tests check that each document has its print sheet; nobody looked at the browser's print preview or at paper
> (page breaks, margins, a long invoice over two pages). (6) The invoice is not a Mushak 6.3 (decision 4): please
> have your VAT consultant confirm what it must say before you hand it to a VAT-registered buyer.

## Goal

🧾 **From goods on the truck to money in the bank.** 15b sent the goods out with a challan and booked their cost.
This step bills them and collects the money, the way a Bangladeshi company does: an invoice for one or more
challans, a money receipt (MR) for every taka that comes in, and a credit limit that stops a customer from owing
more than the company agreed to.

After this step:

- **Invoices** (`INV-2026-27-0001`): a draft is changed freely; posting numbers it and books Dr Accounts
  receivable / Cr Sales / Cr VAT payable. An invoice bills posted challans of one customer (each challan line
  once), an order's services (a delivery charge, logo embroidery), and lines of its own. A line of its own that
  is goods is delivered by the invoice itself: posting it also posts a challan, so a counter sale is one document.
- **Unpaid, Partly paid, Paid, Overdue**: every posted invoice knows what it was paid and when it is due (the
  customer's payment terms, or a date typed on the invoice).
- **Money receipts** (`MR-2026-27-0001`): money in by cash, bank transfer, cheque, bKash/Nagad or card, into a
  money account, booked Dr Cash or Bank / Cr Accounts receivable at once. The money is applied to invoices,
  oldest first unless you change it; what is left stays as an advance and can be applied later. A bounced cheque
  is voided, with a reason.
- **The credit limit** is checked when an order is confirmed and when an invoice is posted. Over the limit, the
  person sees by how much; someone with `sales.credit.override` may go on, and the audit log keeps a row.
- **"Holds money"** on the chart of accounts: the receipt form offers only these accounts.
- **Print** on the quotation, the order, the challan, the invoice and the receipt: one A4 layout, through the
  browser's Print / Save as PDF, offline.
- **The customer page** shows what is on order and how much credit is left, with "New invoice" and "Record
  payment"; a challan shows "Not invoiced", "Partly invoiced" or "Invoiced"; the order page counts what is billed.

## The whole picture

```
packages/contracts   invoices.ts · receipts.ts (new) · accounts: holdsMoney, moneyAccountIds() · money: priceInUnit
      │               journal: sources sales_invoice + sales_receipt · series MR · 3 permissions · 25 errors · 8 audit actions
      │               orders: invoicedQuantity, overrideCreditLimit · deliveries: invoiced, invoiceState · customer credit
      ▼
packages/db          invoices + invoice_lines · receipts + receipt_allocations · delivery_lines.invoiced
                     sales_order_lines.invoiced_quantity · ledger_accounts.holds_money
                     0029 (drizzle, indexes moved up) · 0030 (RLS, guards, the "paid" trigger, money accounts)
      │
      ▼
apps/api             sales/: InvoicesService · ReceiptsService · CreditService · SalesBooksService
                     deliveries: billed lines, deliverForInvoice() · orders: credit check at confirm, order_has_invoices
                     accounts: holdsMoney · journal: Reverse refuses sales entries · setup: money accounts, roles
      │
      ▼
apps/app             /invoices · /receipts (list, new, one) · Print on five documents · credit line and dialog
                     challan: Make invoice · order: Invoiced column · customer: On order, Credit left · accounts: Holds money
                     packages/ui: PrintSheet, print styles · packages/i18n: the words, in English and Bangla
                     MSW: the same rules · Playwright: invoices, money receipts

one invoice, from the click to the books:
  Post invoice ──POST /invoices/{id}/post──► API, one transaction:
     lock the draft · date in an open period · customer and branch still active
     lock its challans, then its orders (FOR UPDATE, by id) · every line checked again (billed? same item and quantity?)
     number INV-2026-27-0001
     lines of its own that are goods ──► deliverForInvoice(): a challan DC-…, stock out, cost of goods sold (15b)
     delivery_lines.invoiced = true · sales_order_lines.invoiced_quantity +=
     SalesBooksService: Dr Accounts receivable (the customer) / Cr Sales / Cr VAT payable, source sales_invoice
     CreditService.check(): over the limit and higher than before? ──► credit_limit_exceeded, or the override's audit row
     invoice → posted · audit · COMMIT

one money receipt:
  Save ──POST /receipts──► number MR-… · Dr Bank (a money account) / Cr Accounts receivable (the customer)
     allocations inserted ──► trigger: invoices.amount_paid and receipts.applied move with them
  Invoice page: "Partly paid" · Customer page: owes less · Journal: "Money receipt MR-…"
```

## The decisions behind this step

You made the first four on 2026-10-08; step 15's own choices (the parties table, the receivable account with a
party on each line, the credit limit with an override) are in the 15a guide. The others came up while building
it; please read 5–27 with care: they are mine.

1. **An invoice bills posted challans, or delivers its own goods.** (You chose this.) One invoice bills one or
   more posted challans of one customer, priced from the order line behind each challan line, or from the price
   lookup when the challan had no order. A "direct" invoice, with no order and no challan, posts its own challan
   in the same transaction, so the cost of goods sold is booked once, by that challan, exactly as 15b does it.
2. **Money receipts are applied to invoices, oldest first.** (You chose this.) The form suggests the oldest due
   invoice first, and the person may change every amount. What is left stays with the customer as an advance and
   can be applied later. Invoices show Unpaid, Partly paid, Paid and Overdue.
3. **The credit limit is checked at order confirm and at invoice post.** (You chose this.) What the customer
   would owe = the balance + confirmed orders not yet billed + this document. Over the limit, the save is refused
   unless the person has `sales.credit.override`; an override writes an audit row.
4. **One browser print layout.** (You chose this.) A4, through the browser's Print / Save as PDF, for the
   quotation, the order, the challan, the invoice and the receipt; it works offline. It carries the company's
   name, address, BIN and logo. The Mushak 6.3 format comes later.
5. **A challan line is billed whole.** You were told each challan line would keep an *invoiced quantity*. While
   designing the tables it became a yes/no `invoiced` flag on `delivery_lines`: the same rule ("nothing is billed
   twice") with part-billing of one line ruled out. Goods that left the gate and are not billed must come back
   with a return (15d), not stay "delivered but never sold". The order line still counts its invoiced quantity
   (`sales_order_lines.invoiced_quantity`), because one order line can go out in several challans.
6. **An invoice is numbered when it is posted** (`INV`), like a challan, so the series has no gaps. Only a draft
   is changed or deleted. A posted invoice is never changed: 15d's credit note corrects it.
7. **The due date** is the invoice date plus the customer's payment terms, unless one is typed. A draft keeps the
   due date it was saved with; it is not moved when the date changes later.
8. **An invoice has a branch, and maybe a warehouse.** Every journal line of the invoice carries the branch (whose
   sale it is). The warehouse is needed only for lines of its own that are goods, the ones the invoice delivers.
   The form takes the branch from the first challan or the warehouse, or the only branch, and never overwrites one
   the person picked.
9. **"Prices include VAT" comes from the orders** behind the lines; two orders that disagree cannot share an
   invoice (`invoice_vat_mixed`). Without an order, the draft's own setting, else the workspace's.
10. **The billing address is copied onto the invoice as text** when it is saved, like the challan's shipping
    address. A printed invoice never reads today's address.
11. **An order's services are billed straight from the order.** A service is never delivered, so a "Delivery
    charge" line on an order has no challan line to bill. The invoice's "Add order charges" adds an order's
    unbilled services, one order per click.
12. **A billed order line is frozen**, even if the order goes back to draft. Reopen is refused when any invoice
    line (even a draft's) points at the order, and Cancel when anything is billed (`order_has_invoices`, new). Close
    now also accepts an order where something was billed but nothing delivered (services only). Billing an order
    does not change the order's version.
13. **The challan of a direct invoice is an ordinary challan** (`DeliveriesService.deliverForInvoice()`), numbered
    `DC-…`, with the note "Invoice INV-…" and its own audit rows. A goods line of its own picks one batch or its
    serial numbers; there is no "Split by first expiry" on the invoice (use a challan for that).
14. **A ৳0 invoice has no journal entry**, like a delivery that cost nothing. A free sample is still billed on
    paper.
15. **An archived product can still be billed** on a line that bills a challan or an order line: the goods already
    left. A line of its own follows 15b: an archived product is refused.
16. **A money receipt has no draft.** Saving it numbers it and books it, because the money is already in the hand.
    After that only its allocations change. A wrong receipt or a bounced cheque is **voided**: a reversal entry on
    the void date, a reason, and its allocations removed (the invoices owe again).
17. **"Paid" and "applied" are kept by the database**, by a trigger on `receipt_allocations`, never by the API. The
    API inserts and deletes allocations, so the sums can never drift from the rows.
18. **Money accounts are a "Holds money" tick** on the chart of accounts. Ticked on a group, every account inside
    it holds money (a new bank account under "Bank accounts" needs no tick). Only an asset can hold money
    (`account_money_type`). New workspaces get Cash in hand, Bank accounts and Mobile wallets ticked; 0030 ticks
    the same in workspaces you already have.
19. **The credit check refuses only when the exposure goes over the limit *and* goes up.** Billing a confirmed
    order at its price adds nothing (it moves from "on order" to "owed"), so it is never refused, even for a
    customer already over the limit. A lock per customer makes two confirms at the same moment take turns.
20. **Challans without an order do not count** towards the credit limit: they have no price until they are billed.
21. **The credit dialog shows only to someone who can override.** Everyone else sees the error with the limit and
    the amount, and asks a manager. A second refusal after an override (someone else saved first) shows the text,
    not the dialog again.
22. **The journal's Reverse refuses an invoice's or a receipt's entry** (`journal_is_sales`). An invoice is
    corrected by a credit note (15d), a receipt by Void.
23. **Reading invoices and receipts needs no permission**, like every sales document. Writing needs
    `sales.invoice.manage` or `sales.receipt.manage`.
24. **New workspaces give these permissions to the people who bill and collect.** The Accountant gets invoices and
    receipts; a distributor's Sales officer ("Orders and collections from retailers") both; the Cashier receipts;
    the Shop manager and the Manager all three. The people who post challans (Store keeper, Depot manager) do not
    bill them. The override goes only to the managers, never to the Accountant alone: the person who books a sale
    should not also wave away its limit.
25. **Only a numbered document prints**: a quotation always, an order once confirmed, a challan or an invoice once
    posted, a receipt unless voided. A draft on paper looks like a real document.
26. **"Money receipts", not "Receipts"**, in the menu and on the pages: step 13's goods received note is already
    a "receipt" to a store keeper. In Bangla: ইনভয়েস and মানি রিসিট, "ধরা" for applying money, "বাতিল" for void.
27. **The mock keeps invoices and receipts in their own file** and posts them all-or-nothing through one
    `transaction()` helper; "paid" and "applied" are worked out on read, like the trigger. The seeds post no
    invoice and no receipt, so the seeded books stay what the older tests expect.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Credit notes, sales returns, cancelling a posted invoice | 15d (decision 6) |
| Mushak 6.3, the amount in words, a PDF made by the server | Step 16 (document output) and the VAT returns (decision 4) |
| Post-dated cheques, cheque clearing | A bounced cheque is voided (decision 16) |
| A receivables aging report, reminders for overdue invoices | Later, with the reports |
| Email, WhatsApp, online payment (SSLCommerz, bKash) | Step 16 for email and WhatsApp, online payment later; print or save as PDF today |
| VAT deducted at source (VDS), AIT | Later, with the VAT returns |
| A discount on the whole invoice | Later; each line has its own discount (15b) |
| Several currencies | Later, with multi-currency |
| Cash taken on the invoice form | The point-of-sale step; today a receipt is its own document |
| Billing part of a challan line | Decision 5; a return takes back what is not billed |

## What changes in the code you already have

- **No new package**, no new `.env` line, no new database role, no new worker job.
- **`pnpm db:migrate`** adds four tables (0029) and their rules (0030), ticks your money accounts and writes the
  three new permissions. Then restart `pnpm dev` so the API has the new routes.
- **Contracts:** `accounts.ts` gets `holdsMoney` (now required on the account form) and `moneyAccountIds()`;
  `money.ts` gets `priceInUnit()`; `journal.ts` the sources `sales_invoice` and `sales_receipt`; a number series
  `MR`; the order line `invoicedQuantity`, and confirming an order takes `{ version, overrideCreditLimit }`; the
  delivery `invoiced`, `invoiceState`, `invoices` and an `invoice` filter; the customer a credit route.
- **Database:** `delivery_lines.invoiced`, `sales_order_lines.invoiced_quantity`, `ledger_accounts.holds_money`;
  15b's guards on orders and challans let these change after posting; the journal's document check knows the two
  new sources.
- **API:** the account form checks "holds money"; Reverse refuses sales entries; the challan learns which lines are
  billed; confirming an order checks the credit limit; Reopen and Cancel refuse billed orders; deleting a customer,
  a product or an account that an invoice or receipt uses answers `..._in_use`; the chart and role templates give
  new workspaces money accounts and the new permissions (decision 24) — existing roles do not get them; an owner
  ticks them on the Roles page.
- **ui:** the stylesheet prints in the light palette and hides everything but the print sheet; the app shell's
  sidebar is hidden on paper; `PrintSheet` and `PrintBlock` are new.
- **app:** the quotation, order and challan pages get Print; the line editor is generic (`LinesEditor<L>`), so the
  invoice uses it too; `DocumentNotice` moves to `sales-parts.tsx`; the report hooks move to `report-hooks.ts`, and
  the journal entry form and the order form load their customer box and date picker lazily (the 100 KB budget,
  15c.6).
- **Existing tests that change:** every test that writes an account sends `holdsMoney`; the numbering test counts 14
  series; the setup test expects the Accountant's two new permissions; two app fixtures get `holdsMoney`, one
  `invoicedQuantity`; the 15b order end-to-end test takes `.first()` of the PO number (15c.7).

---

## 15c.1 — `packages/contracts`: the contract

As in every step, the contract comes first: the shapes the API sends and accepts, the permissions, the error
codes and the number series. The API and the app both read these files, so once this part type-checks, the next
parts cannot disagree about a field name.

Two new files hold the two new documents: `invoices.ts` (the sales invoice) and `receipts.ts` (the money
receipt). The rest are small changes to files you already have: a "holds money" flag on accounts, a helper that
moves a price to another pack, two journal sources, a number series, three permissions, the error codes, the
audit actions, and a few fields on the order, the delivery and the customer that 15c needs.

### `accounts.ts`: which accounts hold money

```diff
@@ -65,6 +65,10 @@ export const accountSchema = z.object({
   // z.string(), not an enum: a newer server's new purpose must not break an older offline client
   // (the same rule as error codes). The app narrows it with isAccountPurpose().
   purpose: z.string().nullable(),
+  // Step 15c: money is kept here — cash, a bank account, a bKash wallet. On a group it means every
+  // account in it, so a new bank account under "Bank accounts" needs no tick of its own. A money
+  // receipt goes into one of these (moneyAccountIds below). Asset accounts only.
+  holdsMoney: z.boolean(),
   description: z.string().nullable(),
   // null = active. An archived account is hidden from pickers but stays in old reports.
   archivedAt: z.iso.datetime().nullable(),
@@ -73,6 +77,33 @@ export const accountSchema = z.object({
 });
 export type Account = z.infer<typeof accountSchema>;
 
+type MoneyAccountFields = Pick<
+  Account,
+  'id' | 'parentId' | 'isGroup' | 'holdsMoney' | 'archivedAt'
+>;
+
+// The accounts money can go into: active, not a group, and flagged themselves or under a flagged
+// group at any depth. The app and the API both call this on the whole chart (it is small, a few
+// hundred accounts at most), so the receipt form offers exactly what the server accepts.
+export function moneyAccountIds(accounts: readonly MoneyAccountFields[]): Set<string> {
+  const byId = new Map(accounts.map((account) => [account.id, account]));
+  const ids = new Set<string>();
+  for (const account of accounts) {
+    if (account.isGroup || account.archivedAt !== null) continue;
+    // Up the tree to the top. The database refuses a loop (account_parent_loop); the step count
+    // only keeps a broken chart from hanging the page.
+    let current: MoneyAccountFields | undefined = account;
+    for (let step = 0; current !== undefined && step <= accounts.length; step += 1) {
+      if (current.holdsMoney) {
+        ids.add(account.id);
+        break;
+      }
+      current = current.parentId === null ? undefined : byId.get(current.parentId);
+    }
+  }
+  return ids;
+}
+
 // Digits, optionally split into parts by dots or hyphens: 1110, 1-1-10, 11.10. No letters: codes
 // sort and group by their digits, and every accountant in Bangladesh reads them that way.
 const accountCodeSchema = z
@@ -93,6 +124,9 @@ export const createAccountInputSchema = z.object({
   code: accountCodeSchema,
   name: accountNameSchema,
   isGroup: z.boolean(),
+  // Only on an asset account; the type comes from the parent, so the server checks it
+  // (account_money_type)
+  holdsMoney: z.boolean(),
   description: optionalText(300),
 });
 export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;
@@ -103,6 +137,7 @@ export const updateAccountInputSchema = z.object({
   parentId: parentIdSchema.nullable(),
   code: accountCodeSchema,
   name: accountNameSchema,
+  holdsMoney: z.boolean(),
   description: optionalText(300),
   version: versionSchema,
 });
```

- **Why a flag, not a purpose.** A receipt needs to know where money can go: cash in hand, a bank account, a
  bKash wallet. Step 9's `purpose` marks *one* account per job ("the receivable account"), and the database refuses
  a purpose on a group (`ledger_accounts_purpose_not_group`). But a company has many bank accounts, and it adds
  them itself under the "Bank accounts" group. So we need a different marker that can sit on many accounts and on a
  group: `holdsMoney`.
- **On a group it means every account inside.** The template flags the "Bank accounts" and "Mobile wallets"
  groups (15c.2). When the owner adds "Dutch-Bangla Bank CD A/C 1234" under "Bank accounts", it is a money account
  at once, without a second tick. A flag only on posting accounts would make every new bank account a trap: the
  owner forgets the tick, and the receipt form does not offer the account.
- **`moneyAccountIds()` lives in the contract.** The receipt form must offer exactly the accounts the server
  accepts. Both sides call this one function on the whole chart. The chart is small (a few hundred rows), and the
  app already loads it whole since step 9, so the function needs no server query of its own.
- **It skips groups and archived accounts.** Money is never posted to a group (step 9), and an archived account is
  hidden from every picker. Then it walks up the tree: the account itself, its group, that group's group, up to
  the top. The first flag it meets makes the account a money account.
- **The step counter in the loop.** The database refuses a loop in the tree (`account_parent_loop`), so a real chart
  has none. But a page must never hang on bad data, so the walk stops after as many steps as there are accounts.
  The test "stops on a chart with a loop" proves it.
- **`holdsMoney` is required in both inputs.** The account form always sends it. The server checks that only an
  asset account gets it (`account_money_type`), because the type comes from the parent, which only the server
  reads for sure.

### `money.ts`: a price moved to another pack

```diff
@@ -174,3 +174,28 @@ export function includedTaxOf(amount: string, rate: string): string {
     divideRounded(toUnits(amount) * rateUnits, (HUNDRED_PERCENT + rateUnits) * PAISA) * PAISA,
   );
 }
+
+// ---------------------------------------------------------------------------------------------
+// Invoices (step 15c): a price moved to another pack of the same product
+
+// A unit's size in the base unit, as product_units.factor stores it: up to 6 decimals ("0.914400"
+// for a yard in metres)
+const FACTOR = /^(\d+)(?:\.(\d{1,6}))?$/;
+
+function factorMicros(factor: string): bigint {
+  const match = FACTOR.exec(factor);
+  const whole = match?.[1];
+  if (match === null || whole === undefined) throw new Error(`Not a unit factor: "${factor}"`);
+  const micros = BigInt(whole) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
+  if (micros <= 0n) throw new Error(`A unit factor must be positive: "${factor}"`);
+  return micros;
+}
+
+// A price per one `from` unit, as a price per one `to` unit: price × toFactor ÷ fromFactor, to 4
+// decimals like any price. An order priced by the case of 24 at ৳504 and delivered by the piece
+// bills ৳21 a piece. The base unit's factor is "1".
+export function priceInUnit(price: string, fromFactor: string, toFactor: string): string {
+  return fromUnits(
+    divideRounded(toUnits(price) * factorMicros(toFactor), factorMicros(fromFactor)),
+  );
+}
```

- **Why it is needed.** In 15b, a challan line may use another pack than its order line: the order says
  "2 cases of 24", the store keeper sends "48 pcs" from an opened case. The invoice must bill the challan line at
  the order's price, so it needs the price per piece: `৳504 × 1 ÷ 24 = ৳21`.
- **`price × toFactor ÷ fromFactor`.** A factor is the size of a unit in the base unit (`case = 24`, `pcs = 1`).
  Multiplying first and dividing once at the end keeps the result exact until the one rounding.
- **4 decimals, like any price.** `৳500` a case is `৳20.8333…` a piece. A price column keeps 4 decimals
  (`NUMERIC(19,4)`), so the result is rounded there, half away from zero, by the same `divideRounded()` as step 14.
  The invoice form only *suggests* this price (15c.6); the person can still change it.
- **`factorMicros()`.** `product_units.factor` has 6 decimals (`0.914400` for a yard in metres), more than the 4
  that `toUnits()` reads. So factors get their own parser, in millionths. A factor of zero would divide by zero, so
  it throws; the database already refuses one (`product_units_factor_check`).

### `journal.ts`: two sales sources

```diff
@@ -21,6 +21,8 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // can change it — the journal's Reverse refuses it, or the books and the stock would disagree.
 // sales_delivery (step 15b): a delivery challan's cost of goods sold. A stock document like the
 // others: it moves stock and its value together.
+// sales_invoice, sales_receipt (step 15c): an invoice's sale (receivable, sales, VAT) and a money
+// receipt (cash or bank, receivable). They point at their document like a stock document's entry.
 export const JOURNAL_SOURCES = [
   'manual',
   'opening_balance',
@@ -30,6 +32,8 @@ export const JOURNAL_SOURCES = [
   'stock_transfer',
   'stock_revaluation',
   'sales_delivery',
+  'sales_invoice',
+  'sales_receipt',
 ] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
@@ -50,6 +54,26 @@ export function isStockJournalSource(value: string): value is StockJournalSource
   return STOCK_JOURNAL_SOURCES.some((source) => source === value);
 }
 
+// The sources a sales document posts (step 15c). Their entries are not reversed from the journal
+// either: an invoice is corrected by a credit note (15d), a receipt by voiding it on its own page,
+// so the document and the books never disagree.
+export const SALES_JOURNAL_SOURCES = [
+  'sales_invoice',
+  'sales_receipt',
+] as const satisfies readonly JournalSource[];
+export type SalesJournalSource = (typeof SALES_JOURNAL_SOURCES)[number];
+
+export function isSalesJournalSource(value: string): value is SalesJournalSource {
+  return SALES_JOURNAL_SOURCES.some((source) => source === value);
+}
+
+// Every source whose entry points at the document that made it (journal_entries_document_check in
+// the database holds the same list)
+export const DOCUMENT_JOURNAL_SOURCES = [
+  ...STOCK_JOURNAL_SOURCES,
+  ...SALES_JOURNAL_SOURCES,
+] as const satisfies readonly JournalSource[];
+
 // '2026-07-01' and -1 → '2026-06-30'. The arithmetic runs in UTC, so no time zone can move the
 // day (the same reason periodOf() reads the parts of the string, numbering.ts).
 export function shiftIsoDate(isoDate: string, days: number): string {
@@ -104,8 +128,9 @@ export const journalEntrySummarySchema = z.object({
   // This entry undoes reversalOf; reversedBy undid this entry
   reversalOf: entryRefSchema.nullable(),
   reversedBy: entryRefSchema.nullable(),
-  // The stock document that made this entry (step 14): its id and number. Which kind of document
-  // it is follows from the source. null for every other entry.
+  // The document that made this entry (a stock document, step 14; an invoice or a receipt, step
+  // 15c): its id and number. Which kind of document it is follows from the source. null for every
+  // other entry.
   document: z.object({ id: z.uuid(), number: z.string() }).nullable(),
   postedAt: z.iso.datetime().nullable(),
   version: z.number().int(),
```

- **`sales_invoice` and `sales_receipt`.** Each posted invoice and each receipt makes an entry, and the entry
  points at its document (`document_id`, `document_number`), the way a stock document's entry does since step 14.
  So the journal page can link "INV-2026-27-0001" back to the invoice.
- **`SALES_JOURNAL_SOURCES`, kept apart from the stock list.** Step 14's `STOCK_JOURNAL_SOURCES` does two jobs:
  the journal's Reverse refuses those entries, and only those entries may post to a stock account
  (`allowStock` in `posting.service.ts`). An invoice must never post to a stock account, so it cannot join that
  list. A second list says "made by a sales document" without the stock permission.
- **Why Reverse refuses them.** If someone reversed an invoice's entry in the journal, the books would say the
  sale never happened, while the invoice page still shows it posted and the customer still sees it as owed. The
  invoice is corrected by a credit note (15d), and a receipt by its own Void button (below), which reverses the
  entry *and* takes the money off the invoices in one step.
- **`DOCUMENT_JOURNAL_SOURCES`.** Every source whose entry must point at a document. The database check
  `journal_entries_document_check` holds the same list (15c.2); this constant is where the API reads it.

### `numbering.ts`, `permissions.ts`, `errors.ts`, `audit.ts`

```diff
@@ -19,6 +19,7 @@ export const DOCUMENT_TYPES = [
   'sales.customer',
   'sales.quotation',
   'sales.delivery',
+  'sales.receipt',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -47,6 +48,8 @@ const DEFAULT_PREFIXES = {
   'sales.quotation': 'QT',
   // A delivery challan
   'sales.delivery': 'DC',
+  // A money receipt: what a customer paid (step 15c)
+  'sales.receipt': 'MR',
 } satisfies Record<DocumentType, string>;
 
 // টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
```

- **`sales.receipt` (MR).** "Money receipt" is the name on the paper slip every business in Bangladesh gives for
  cash. `sales.invoice` (INV) has been in the list since step 6, so it needs no change. The receipt uses the
  default yearly style (`MR-2026-27-0001`).

```diff
@@ -27,6 +27,9 @@ export const PERMISSION_KEYS = [
   'sales.quotation.manage',
   'sales.order.manage',
   'sales.delivery.manage',
+  'sales.invoice.manage',
+  'sales.receipt.manage',
+  'sales.credit.override',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -68,4 +71,7 @@ export const PERMISSION_GROUP_OF = {
   'sales.quotation.manage': 'sales',
   'sales.order.manage': 'sales',
   'sales.delivery.manage': 'sales',
+  'sales.invoice.manage': 'sales',
+  'sales.receipt.manage': 'sales',
+  'sales.credit.override': 'sales',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

- **`sales.invoice.manage`.** Writing and posting invoices. In a distribution company this is the accountant or a
  sales officer, not the store keeper who posts challans.
- **`sales.receipt.manage`.** Recording, applying and voiding receipts: the cashier or the accountant who takes
  the money.
- **`sales.credit.override`.** Saving an order or an invoice that takes a customer over the credit limit (you
  chose: blocked unless the person has this). Usually only the owner or a manager. It is its own key, so giving
  someone "invoice" never gives them "override" by accident.

```diff
@@ -271,6 +271,32 @@ export const ERROR_CODES = [
   'delivery_order_line_required',
   'delivery_order_line_invalid',
   'delivery_over_order',
+  // invoices, money receipts and the credit limit (step 15c)
+  'sales_branch_invalid',
+  'invoice_due_date',
+  'invoice_warehouse_required',
+  'invoice_line_source',
+  'invoice_stock_not_allowed',
+  'invoice_delivery_line_invalid',
+  'invoice_line_twice',
+  'invoice_delivery_line_billed',
+  'invoice_order_line_invalid',
+  'invoice_order_line_billed',
+  'invoice_vat_mixed',
+  'order_has_invoices',
+  'receipt_amount_required',
+  'receipt_account_invalid',
+  'receipt_over_allocated',
+  'receipt_invoice_invalid',
+  'receipt_invoice_twice',
+  'receipt_over_invoice',
+  'receipt_voided',
+  'receipt_void_reason_required',
+  'receipt_void_date',
+  'credit_limit_exceeded',
+  'credit_override_forbidden',
+  'journal_is_sales',
+  'account_money_type',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **`sales_branch_invalid`** is shared by invoices and receipts: an unknown or archived branch.
- **The `invoice_*` codes.** `invoice_due_date`: a due date before the invoice date. `invoice_warehouse_required`:
  a goods line of its own (one the invoice delivers) and no warehouse to take it from. `invoice_line_source`: one
  line that names both a challan line and an order line. `invoice_stock_not_allowed`: a batch or serial number on a
  line that does not deliver anything. `invoice_line_twice`: the same challan line or order line twice on one
  invoice. `invoice_delivery_line_invalid` / `invoice_order_line_invalid`: a line that is not this customer's, not
  posted or confirmed, or not the same item, pack and quantity. `invoice_delivery_line_billed` /
  `invoice_order_line_billed`: already billed by another posted invoice. `invoice_vat_mixed`: lines from two orders
  where one has prices with VAT and the other without.
- **The `receipt_*` codes.** `receipt_amount_required` covers an empty box, `0` and `0.00`: all three are "type
  how much was paid". `receipt_over_allocated`: more applied than received. `receipt_over_invoice`: more on one
  invoice than it still owes. `receipt_voided`: a change to a voided receipt. `receipt_void_date`: a void dated
  before the receipt.
- **`credit_limit_exceeded`** goes out with `params` (`limit`, `exposure`), so the message can say "The limit is
  ৳5,00,000; this would make it ৳5,42,300". **`credit_override_forbidden`** answers someone who sends the override
  without the permission.
- **`order_has_invoices`** (added while writing the API, 15c.3): Reopen or Cancel on an order that an invoice bills.
  15b's `order_has_deliveries` does not cover it: a service line is billed straight from the order, with no
  challan.
- **`journal_is_sales`**: Reverse on an invoice's or a receipt's entry. **`account_money_type`**: "holds money" on
  an account that is not an asset.

```diff
@@ -115,6 +115,17 @@ export const AUDIT_ACTIONS = [
   'delivery.updated',
   'delivery.deleted',
   'delivery.posted',
+  // step 15c
+  'invoice.created',
+  'invoice.updated',
+  'invoice.deleted',
+  'invoice.posted',
+  'receipt.created',
+  'receipt.allocated',
+  'receipt.voided',
+  // An order confirmed or an invoice posted over the customer's credit limit, by someone with
+  // sales.credit.override. The entity is that order or invoice.
+  'credit_limit.overridden',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -151,6 +162,8 @@ export const AUDIT_ENTITY_TYPES = [
   'quotation',
   'sales_order',
   'delivery',
+  'invoice',
+  'receipt',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- **`receipt.allocated`** is its own action. Applying money again changes nothing in the books, but it changes what
  each invoice owes, and the owner will want to know who moved a payment from one invoice to another.
- **`credit_limit.overridden`** is the row you chose to have: who went over the limit, on which order or invoice,
  and by how much. It is written *next to* the normal `sales_order.confirmed` or `invoice.posted` row, so a filter
  on this one action lists every override in the workspace.

### `invoices.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema, shiftIsoDate } from './journal.js';
import { compareMoney, isZeroMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  documentRefSchema,
  salesDocumentFieldsSchema,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
} from './sales.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  MAX_STOCK_LINES,
  optionalDateSchema,
  optionalIdSchema,
  serialNumberSchema,
  stockLineRules,
} from './stock.js';

// A sales invoice asks the customer for the money. A draft can be changed; "Post" gives it its
// number (INV-2026-27-0001) and books the sale: Dr Accounts receivable (with the customer) /
// Cr Sales / Cr VAT payable. The cost of the goods was booked by the challan that took them out
// (step 15b), so the invoice never touches the stock accounts itself. A posted invoice is never
// changed or deleted: a credit note corrects it (15d).
//
// Each line bills one of three things (you chose challan + direct):
//   a challan line      deliveryLineId: goods that left on a posted challan. Billed whole and once.
//   an order's service  orderLineId: a delivery charge on the order. A service is never delivered,
//                       so it is billed straight from the order.
//   neither             a line of its own. A goods line is delivered by the invoice itself: posting
//                       it posts a challan from the invoice's warehouse in the same transaction,
//                       so a shop's counter sale needs one document, and the cost is still booked
//                       once, by that challan.

// One invoice may bill a month of challans for a distributor's depot. A direct invoice's goods
// lines become one challan, so the limit is a challan's.
export const MAX_INVOICE_LINES = MAX_STOCK_LINES;

// draft → posted. Numbered at posting, so posted numbers have no gaps (the NBR asks for that).
export const INVOICE_STATUSES = ['draft', 'posted'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// What the money receipts (receipts.ts) applied to it so far. Worked out from the total and what
// was paid, never stored, so the two can never disagree.
export const PAYMENT_STATUSES = ['unpaid', 'partly_paid', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function paymentStatusOf(invoice: { total: string; amountPaid: string }): PaymentStatus {
  // A ৳0 invoice (a free sample) owes nothing: it is paid the moment it exists
  if (compareMoney(invoice.amountPaid, invoice.total) >= 0) return 'paid';
  return isZeroMoney(invoice.amountPaid) ? 'unpaid' : 'partly_paid';
}

// Overdue: posted, not paid in full, and its due date is before today (the workspace's today,
// todayIn() in numbering.ts). On the due date itself it is still on time.
export function isOverdue(
  invoice: { status: string; dueDate: string; total: string; amountPaid: string },
  today: string,
): boolean {
  return (
    invoice.status === 'posted' && paymentStatusOf(invoice) !== 'paid' && invoice.dueDate < today
  );
}

// The due date an invoice starts with: its date plus the customer's payment terms (step 15a). 0
// days = due on receipt, the same day.
export function dueDateOf(date: string, paymentTermsDays: number): string {
  return shiftIsoDate(date, paymentTermsDays);
}

// The invoice list's payment filter. open: posted and not paid in full (what a receipt can be
// applied to); overdue: open and past its due date. Both list the oldest due date first, the order
// a receipt pays them in.
export const INVOICE_PAYMENT_FILTERS = ['open', 'overdue', 'paid'] as const;
export type InvoicePaymentFilter = (typeof INVOICE_PAYMENT_FILTERS)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const invoiceSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft
  number: z.string().nullable(),
  date: z.iso.date(),
  dueDate: z.iso.date(),
  customer: partyRefSchema,
  // The customer's own number for what is billed: a buyer's PO, a pharmacy's indent
  customerReference: z.string().nullable(),
  // Whose sale it is: every line of its journal entry carries this branch, so the profit and loss
  // by branch (step 11) shows it there
  branchId: z.uuid(),
  status: z.enum(INVOICE_STATUSES),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // What money receipts applied to it; total − amountPaid is still due
  amountPaid: z.string(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

export const invoiceLineSchema = salesLineSchema.extend({
  // The challan line this line bills; null for an order's service line and for a line of its own
  // until the invoice is posted (posting points it at the challan line it made)
  deliveryLineId: z.uuid().nullable(),
  // The order line behind it: through the challan line, or an order's service line
  orderLineId: z.uuid().nullable(),
  // Their numbers, so a draft's line says "From DC-2026-27-0042" and the printed invoice can show
  // the challan of each line. A challan line's challan is posted, so it has a number; an order
  // behind a line is confirmed or later, so it has one too.
  deliveryNumber: z.string().nullable(),
  orderNumber: z.string().nullable(),
  // The batch and serial numbers the goods left with, for the printed invoice (a pharmacy's
  // invoice shows each batch and its expiry): the challan line's, or what a line of its own picked
  batchId: z.uuid().nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.iso.date().nullable(),
  serialNumbers: z.array(z.string()),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

// A challan the invoice bills (or made, for its own goods lines). Always posted, so it has a number.
export const invoiceDeliverySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
});
export type InvoiceDelivery = z.infer<typeof invoiceDeliverySchema>;

// Money a receipt applied to this invoice
export const invoicePaymentSchema = z.object({
  receiptId: z.uuid(),
  receiptNumber: z.string(),
  date: z.iso.date(),
  amount: z.string(),
});
export type InvoicePayment = z.infer<typeof invoicePaymentSchema>;

export const invoiceSchema = invoiceSummarySchema.extend({
  // The orders' copy of the workspace setting when the invoice bills orders, else the setting's
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  // Where the invoice's own goods lines leave from; null when every goods line is on a challan
  warehouseId: z.uuid().nullable(),
  // The customer's billing address as it was when the invoice was saved
  billingAddress: z.string().nullable(),
  note: z.string().nullable(),
  lines: z.array(invoiceLineSchema),
  deliveries: z.array(invoiceDeliverySchema),
  orders: z.array(documentRefSchema),
  payments: z.array(invoicePaymentSchema),
  // The sale in the books; null for a draft, and for an invoice of ৳0
  entry: entryRefSchema.nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

interface InvoiceLineFields {
  deliveryLineId: string | null;
  orderLineId: string | null;
  batchId: string | null;
  serialNumbers: readonly string[];
}

// A line bills one thing. Only a line of its own picks its batch and serial numbers: a challan line
// already left with its own, and a service has none.
function invoiceLineRules<T extends InvoiceLineFields>(line: T, ctx: z.RefinementCtx<T>): void {
  if (line.deliveryLineId !== null && line.orderLineId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['orderLineId'],
      message: errorCode('invoice_line_source'),
    });
  }
  if (line.deliveryLineId === null && line.orderLineId === null) return;
  if (line.batchId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['batchId'],
      message: errorCode('invoice_stock_not_allowed'),
    });
  }
  if (line.serialNumbers.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['serialNumbers'],
      message: errorCode('invoice_stock_not_allowed'),
    });
  }
}

const invoiceLineInputSchema = salesLineFieldsSchema
  .extend({
    // '' = not a challan line
    deliveryLineId: optionalIdSchema,
    // '' = not an order's service line. A challan line leaves it empty: the server reads the order
    // line from the challan line.
    orderLineId: optionalIdSchema,
    // A goods line of its own, like a challan line: the batch (FEFO in the form) or the serials
    batchId: optionalIdSchema,
    serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
  })
  .superRefine((line, ctx) => {
    salesLineRules(line, ctx);
    stockLineRules(line, ctx);
    invoiceLineRules(line, ctx);
  });
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;
export type InvoiceLineFormValues = z.input<typeof invoiceLineInputSchema>;

const invoiceFieldsSchema = salesDocumentFieldsSchema.extend({
  lines: z
    .array(invoiceLineInputSchema)
    .min(1, errorCode('sales_lines_required'))
    .max(MAX_INVOICE_LINES),
  // '' = the date plus the customer's payment terms (dueDateOf)
  dueDate: optionalDateSchema,
  customerReference: optionalText(60),
  branchId: z.uuid(errorCode('sales_branch_invalid')),
  // Needed only when a goods line is a line of its own: which products are goods only the server
  // knows, so it checks that (invoice_warehouse_required). '' = none.
  warehouseId: optionalIdSchema,
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
  // Post even though it takes the customer over the credit limit. Only someone with
  // sales.credit.override may send true; the form sends it after the person saw the amount and
  // confirmed (credit_limit_exceeded → a dialog → the same request again with true).
  overrideCreditLimit: z.boolean().default(false),
});

type InvoiceRuleInput = z.output<typeof invoiceFieldsSchema>;

function invoiceRules(input: InvoiceRuleInput, ctx: z.RefinementCtx<InvoiceRuleInput>) {
  if (input.dueDate !== null && input.dueDate < input.date) {
    ctx.addIssue({ code: 'custom', path: ['dueDate'], message: errorCode('invoice_due_date') });
  }
  // A challan line or an order line twice on one invoice would bill it twice. Ids of the two kinds
  // never meet (they are UUIDs of different tables), so one set holds both.
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    const pairs = [
      ['deliveryLineId', line.deliveryLineId],
      ['orderLineId', line.orderLineId],
    ] as const;
    for (const [field, id] of pairs) {
      if (id === null) continue;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, field],
          message: errorCode('invoice_line_twice'),
        });
      }
      seen.add(id);
    }
  });
  documentSerialRules(input, ctx);
}

export const invoiceInputSchema = invoiceFieldsSchema.superRefine(invoiceRules);
export type InvoiceInput = z.infer<typeof invoiceInputSchema>;

export const updateInvoiceInputSchema = invoiceFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(invoiceRules);
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceInputSchema>;
export type InvoiceFormValues = z.input<typeof updateInvoiceInputSchema>;

export const postInvoiceInputSchema = z.object({
  version: versionSchema,
  overrideCreditLimit: z.boolean().default(false),
});
export type PostInvoiceInput = z.infer<typeof postInvoiceInputSchema>;

export const deleteInvoiceQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const invoiceListQuerySchema = pageQuerySchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  customerId: z.uuid().optional(),
  payment: z.enum(INVOICE_PAYMENT_FILTERS).optional(),
});
export type InvoiceListQuery = z.input<typeof invoiceListQuerySchema>;

export const invoicePageSchema = pageOf(invoiceSummarySchema);
export type InvoicePage = z.infer<typeof invoicePageSchema>;

const invoiceParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every sales document. Writing and posting need
// sales.invoice.manage: the accountant or the sales officer who bills.
export const invoiceRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/invoices',
    summary: 'Sales invoices, newest date first (open and overdue: oldest due date first)',
    auth: 'bearer',
    status: 200,
    query: invoiceListQuerySchema,
    response: invoicePageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/invoices/:id',
    summary: 'One invoice with its lines, challans and payments',
    auth: 'bearer',
    status: 200,
    params: invoiceParamsSchema,
    response: invoiceSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/invoices',
    summary: 'Write an invoice as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 201,
    body: invoiceInputSchema,
    response: invoiceSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/invoices/:id',
    summary: 'Change a draft invoice, and optionally post it',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 200,
    params: invoiceParamsSchema,
    body: updateInvoiceInputSchema,
    response: invoiceSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/invoices/:id',
    summary: 'Delete a draft invoice',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 204,
    params: invoiceParamsSchema,
    query: deleteInvoiceQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/invoices/:id/post',
    summary:
      'Post a draft invoice: it gets its number, delivers its own goods lines and books the sale',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 200,
    params: invoiceParamsSchema,
    body: postInvoiceInputSchema,
    response: invoiceSchema,
  }),
};
```

- **The three kinds of line.** The comment at the top is the whole design (you chose "challan + direct"). A goods
  line is billed either from a challan or, for a counter sale, by the invoice itself. A service line on an order
  (a delivery charge) is never delivered, so it is billed straight from the order. A free line is for anything
  else: a service with no order, or goods the invoice delivers.
- **`MAX_INVOICE_LINES = MAX_STOCK_LINES` (500).** A distributor bills a month of challans for a depot at once,
  and a direct invoice's goods lines become one challan, so the limit cannot be lower than a challan's.
- **`paymentStatusOf()` is worked out, never stored.** The invoice stores its `total` and `amountPaid` (what
  receipts applied). A status column next to them could disagree with them one day; a function cannot.
  `>= 0` makes a ৳0 invoice (a free sample) "paid" at once: it owes nothing.
- **`isOverdue()` takes `today` as an argument.** "Today" is the workspace's today in its time zone (`todayIn()`,
  step 6), which the server and the app each work out. On the due date itself the invoice is still on time;
  `dueDate < today` makes it overdue from the next day, which is how a person reads "due 8 October".
- **`dueDateOf()`** is the date plus the customer's payment terms (15a). It uses `shiftIsoDate()` from step 11, so
  no time zone can move the day.
- **`INVOICE_PAYMENT_FILTERS`.** `open` is what a receipt can be applied to; the receipt form asks for it. Both
  `open` and `overdue` come back oldest due date first, because that is the order the receipt suggests paying them
  in (you chose a FIFO suggestion).
- **`branchId` on the invoice.** Every line of the invoice's journal entry carries this branch, so step 11's profit
  and loss by branch shows the sale where it was made. One branch per invoice, not per line: a challan from another
  branch's warehouse can still be billed by this one, and the sale belongs to whoever billed it.
- **`deliveryNumber` and `orderNumber` on each line** (added in 15c.6, when the screens needed them). A draft's
  line says "From DC-2026-27-0042 · SO-2026-27-0007" under the item, and only the line knows which challan it
  bills: the invoice's `deliveries` list names the challans, not which line came from which. The numbers are never
  null for a line that has the id: a billed challan is posted, and the order behind a line is confirmed or later.
- **The line's batch fields.** A pharmacy's invoice prints each batch and its expiry. For a challan line they come
  from the challan line; for a line of its own, from what the line picked. So the print never needs to know which
  kind of line it is.
- **`invoiceDeliverySchema` has a non-null `number`.** Only posted challans can be billed, and the challan an
  invoice makes is posted with it, so every challan an invoice names has its number.
- **`entry` is null for a ৳0 invoice.** An entry of zero lines cannot exist (step 10), and a free sample moves no
  money. Its challan still books the cost of the goods.
- **`invoiceLineRules()`.** A line bills one thing, so both ids at once is refused on `orderLineId`. A batch or a
  serial number only makes sense on a line that delivers goods itself; on a challan line the goods already left
  with their own batch, and a service has none. Each error sits on the box the person must change.
- **The line's `superRefine` calls three rule functions.** `salesLineRules()` (15b: the discount is not more than
  the line), `stockLineRules()` (13: a serial number once per line), and the invoice's own. Each is generic over the
  line type, so it can be reused on this wider line without a cast.
- **`warehouseId` is optional in the contract.** It is needed only when a *goods* line is a line of its own, and
  whether a product is goods or a service is in the database, not in the form's data. So the server checks it
  (`invoice_warehouse_required`). A schema rule here would have to trust a type the browser sent.
- **`overrideCreditLimit` defaults to `false`.** A normal save never sends it. When the server answers
  `credit_limit_exceeded`, the form shows a dialog with the two amounts, and only after the person confirms does it
  send the same request again with `true`. Defaulting to `false` means no client can override by forgetting a
  field.
- **`invoiceRules()` and one `Set` for both ids.** A challan line and an order line have ids from different tables,
  so they never collide, and one set catches "the same thing twice" for both. The error goes on the *later* line,
  so the first stays clean and the person removes the copy.
- **`postInvoiceInputSchema`.** Posting a saved draft also checks the credit limit, so the post route takes the
  override as well, not only the version.

### `receipts.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { compareMoney, isMoneyAmount, isZeroMoney, sumMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A money receipt (MR-2026-27-0001) is money a customer paid: cash at the counter, a cheque, a
// bank transfer, a bKash payment. Saving it posts it at once — Dr the cash or bank account /
// Cr Accounts receivable (with the customer) — because the money is already in hand; there is
// nothing to approve.
//
// The money is applied to the customer's invoices (you chose this): the form suggests the oldest
// first, and the person may change it. What is not applied stays with the receipt — an advance,
// or money for an opening balance that has no invoice — and can be applied later.
//
// A saved receipt is not edited. A bounced cheque or a typing mistake is undone by voiding it:
// its entry is reversed on the void date and its money comes off the invoices again.
//   posted  in the books
//   voided  reversed; kept, with its number, so the numbers have no gaps
export const RECEIPT_STATUSES = ['posted', 'voided'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

// How the money came. It decides nothing in the books (the account does); the receipt prints it
// and the reference says which cheque or which transaction.
export const PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'cheque',
  'mobile_wallet',
  'card',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// A distributor's collection from a depot can settle a few hundred small invoices at once
export const MAX_RECEIPT_ALLOCATIONS = 200;

// An amount that must be there and above zero: a receipt of ৳0 moved no money. One error per box,
// like requiredPriceSchema: the format check leaves an empty box to the first one, and the zero
// check leaves a malformed one to the format check.
const receiptAmountSchema = z
  .string()
  .trim()
  .refine((value) => value !== '', errorCode('receipt_amount_required'))
  .refine((value) => value === '' || isMoneyAmount(value), errorCode('money_format'))
  .refine(
    (value) => !isMoneyAmount(value) || !isZeroMoney(value),
    errorCode('receipt_amount_required'),
  );

// ---------------------------------------------------------------------------------------------
// What the API sends

export const receiptSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  customer: partyRefSchema,
  amount: z.string(),
  // What is applied to invoices; amount − applied is not applied yet
  applied: z.string(),
  method: z.enum(PAYMENT_METHODS),
  // The cheque number, the bKash TrxID, the bank's transfer reference
  reference: z.string().nullable(),
  // The money account it went into (accounts.ts → moneyAccountIds)
  accountId: z.uuid(),
  branchId: z.uuid(),
  status: z.enum(RECEIPT_STATUSES),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;

// One invoice the receipt paid, with what the receipt put on it
export const receiptAllocationSchema = z.object({
  invoiceId: z.uuid(),
  invoiceNumber: z.string(),
  invoiceDate: z.iso.date(),
  dueDate: z.iso.date(),
  invoiceTotal: z.string(),
  amount: z.string(),
});
export type ReceiptAllocation = z.infer<typeof receiptAllocationSchema>;

export const receiptSchema = receiptSummarySchema.extend({
  note: z.string().nullable(),
  // Empty once voided: a voided receipt paid nothing
  allocations: z.array(receiptAllocationSchema),
  entry: entryRefSchema,
  // The reversal that voided it, its date and why; null while posted
  voidEntry: entryRefSchema.nullable(),
  voidDate: z.iso.date().nullable(),
  voidReason: z.string().nullable(),
});
export type Receipt = z.infer<typeof receiptSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const allocationInputSchema = z.object({
  invoiceId: z.uuid(errorCode('receipt_invoice_invalid')),
  amount: receiptAmountSchema,
});

const allocationsSchema = z.array(allocationInputSchema).max(MAX_RECEIPT_ALLOCATIONS);

interface AllocationFields {
  allocations: readonly { invoiceId: string; amount: string }[];
}

// An invoice once: two rows for one invoice is a slip. Whether each amount fits what the invoice
// still owes only the server knows (receipt_over_invoice).
function allocationRules<T extends AllocationFields>(input: T, ctx: z.RefinementCtx<T>): void {
  const seen = new Set<string>();
  input.allocations.forEach((allocation, index) => {
    if (seen.has(allocation.invoiceId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allocations', index, 'invoiceId'],
        message: errorCode('receipt_invoice_twice'),
      });
    }
    seen.add(allocation.invoiceId);
  });
}

// What is applied never adds up to more than the receipt
export function overAllocated(amount: string, allocations: readonly { amount: string }[]): boolean {
  return compareMoney(sumMoney(allocations.map((allocation) => allocation.amount)), amount) > 0;
}

export const receiptInputSchema = z
  .object({
    customerId: z.uuid(errorCode('sales_customer_required')),
    date: z.iso.date(errorCode('sales_date_required')),
    amount: receiptAmountSchema,
    accountId: z.uuid(errorCode('receipt_account_invalid')),
    method: z.enum(PAYMENT_METHODS),
    reference: optionalText(60),
    branchId: z.uuid(errorCode('sales_branch_invalid')),
    note: optionalText(300),
    // May be empty: the whole amount is an advance
    allocations: allocationsSchema,
  })
  .superRefine((input, ctx) => {
    allocationRules(input, ctx);
    // A bad box is reported by its own schema; with one there is nothing to add up yet
    const amounts = [input.amount, ...input.allocations.map((allocation) => allocation.amount)];
    if (!amounts.every((value) => isMoneyAmount(value))) return;
    if (overAllocated(input.amount, input.allocations)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: errorCode('receipt_over_allocated'),
      });
    }
  });
export type ReceiptInput = z.infer<typeof receiptInputSchema>;
export type ReceiptFormValues = z.input<typeof receiptInputSchema>;

// Apply the money again: the whole list, as the person left it. The amount is not sent, so the
// server checks the total against the receipt's own (receipt_over_allocated).
export const receiptAllocationsInputSchema = z
  .object({ version: versionSchema, allocations: allocationsSchema })
  .superRefine(allocationRules);
export type ReceiptAllocationsInput = z.infer<typeof receiptAllocationsInputSchema>;
export type ReceiptAllocationsFormValues = z.input<typeof receiptAllocationsInputSchema>;

export const voidReceiptInputSchema = z.object({
  version: versionSchema,
  // The day the money turned out not to be there: the bank's return date of a bounced cheque. Not
  // before the receipt's own date (receipt_void_date, checked by the server).
  date: z.iso.date(errorCode('sales_date_required')),
  reason: z.string().trim().min(1, errorCode('receipt_void_reason_required')).max(200),
});
export type VoidReceiptInput = z.infer<typeof voidReceiptInputSchema>;

export const receiptListQuerySchema = pageQuerySchema.extend({
  status: z.enum(RECEIPT_STATUSES).optional(),
  customerId: z.uuid().optional(),
});
export type ReceiptListQuery = z.input<typeof receiptListQuerySchema>;

export const receiptPageSchema = pageOf(receiptSummarySchema);
export type ReceiptPage = z.infer<typeof receiptPageSchema>;

const receiptParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the invoices. Writing needs sales.receipt.manage: the cashier
// or the accountant who takes the money.
export const receiptRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/receipts',
    summary: 'Money receipts, newest date first',
    auth: 'bearer',
    status: 200,
    query: receiptListQuerySchema,
    response: receiptPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/receipts/:id',
    summary: 'One money receipt with the invoices it paid',
    auth: 'bearer',
    status: 200,
    params: receiptParamsSchema,
    response: receiptSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/receipts',
    summary: 'Record money a customer paid; it is posted at once',
    auth: 'bearer',
    permission: 'sales.receipt.manage',
    status: 201,
    body: receiptInputSchema,
    response: receiptSchema,
  }),
  allocate: defineRoute({
    method: 'PUT',
    path: '/receipts/:id/allocations',
    summary: "Change which invoices a receipt's money is applied to",
    auth: 'bearer',
    permission: 'sales.receipt.manage',
    status: 200,
    params: receiptParamsSchema,
    body: receiptAllocationsInputSchema,
    response: receiptSchema,
  }),
  void: defineRoute({
    method: 'POST',
    path: '/receipts/:id/void',
    summary: 'Void a receipt: reverse its entry and take its money off the invoices',
    auth: 'bearer',
    permission: 'sales.receipt.manage',
    status: 200,
    params: receiptParamsSchema,
    body: voidReceiptInputSchema,
    response: receiptSchema,
  }),
};
```

- **No draft.** A receipt records money already in hand, so saving posts it. A draft receipt would be a promise
  of money, and that is not a receipt. A mistake is voided, and the number stays, so the numbers have no gaps.
- **`voided`, not deleted.** A bounced cheque is a real event with a date. Voiding reverses the entry on the void
  date (the bank's return date), so the cash book shows the cheque coming in and going out, and a closed month is
  never rewritten.
- **`PAYMENT_METHODS` decides nothing in the books.** The account the money went into decides that (Dr Cash in hand
  or Dr Dutch-Bangla Bank). The method is what the slip prints, and the reference says which cheque or which bKash
  transaction.
- **`receiptAmountSchema`, three refines.** An empty box, `0` and `0.00` all get `receipt_amount_required`; `50,000`
  gets `money_format`. Each refine lets the other cases pass, so each box gets exactly one error (the same reason as
  `requiredPriceSchema` in 15b).
- **Allocations may be empty.** Money that comes before the invoice (an advance) is a receipt with nothing applied.
  It already lowers what the customer owes in the books; it waits until an invoice exists to be applied.
- **`receipt_over_allocated` sits on `allocations`.** The mistake is the table as a whole (its total), not one row,
  so the form shows it under the table.
- **The sum is checked only when every box is a valid amount.** With a typo in one row, `sumMoney()` would throw,
  and that row already has its own error.
- **`overAllocated()` is exported.** The allocation form calls it while the person types, to show the remaining
  amount in red before they press Save.
- **`receiptAllocationsInputSchema` has no amount.** Re-applying money changes only the allocations; the amount is
  already in the books. The server compares the new total with the receipt's own amount.
- **The void needs a reason.** Months later, an auditor asks why MR-0042 was voided. "Cheque returned, insufficient
  funds" answers it. `min(1)` after `trim()` refuses a reason of spaces.

### `sales-orders.ts`, `deliveries.ts`, `customers.ts`: what 15c adds to them

```diff
@@ -54,6 +54,9 @@ export type SalesOrderSummary = z.infer<typeof salesOrderSummarySchema>;
 export const salesOrderLineSchema = salesLineSchema.extend({
   // In the base unit, by posted deliveries. A service line stays at zero: it is never delivered.
   deliveredQuantity: z.string(),
+  // In the base unit, by posted invoices (step 15c): a goods line through its challans, a service
+  // line straight from the order
+  invoicedQuantity: z.string(),
 });
 export type SalesOrderLine = z.infer<typeof salesOrderLineSchema>;
 
@@ -92,6 +95,9 @@ const salesOrderFieldsSchema = salesDocumentFieldsSchema.extend({
   shippingAddressId: optionalIdSchema,
   // true = "Confirm": save and confirm in one step, or nothing at all
   confirm: z.boolean(),
+  // Confirm even though it takes the customer over the credit limit (step 15c). Only someone with
+  // sales.credit.override may send true, after a dialog showed the amount (invoices.ts says how).
+  overrideCreditLimit: z.boolean().default(false),
 });
 
 type OrderRuleInput = z.output<typeof salesOrderFieldsSchema>;
@@ -122,6 +128,12 @@ export type SalesOrderFormValues = z.input<typeof updateSalesOrderInputSchema>;
 
 export const salesOrderVersionInputSchema = z.object({ version: versionSchema });
 
+// Confirming checks the credit limit (step 15c), so it can carry the override
+export const confirmSalesOrderInputSchema = salesOrderVersionInputSchema.extend({
+  overrideCreditLimit: z.boolean().default(false),
+});
+export type ConfirmSalesOrderInput = z.infer<typeof confirmSalesOrderInputSchema>;
+
 export const deleteSalesOrderQuerySchema = z.object({
   version: z.coerce.number<number>().int().min(1),
 });
@@ -196,7 +208,7 @@ export const salesOrderRoutes = {
     permission: 'sales.order.manage',
     status: 200,
     params: salesOrderParamsSchema,
-    body: salesOrderVersionInputSchema,
+    body: confirmSalesOrderInputSchema,
     response: salesOrderSchema,
   }),
   reopen: defineRoute({
```

- **`invoicedQuantity` on an order line.** It counts what posted invoices billed, in the base unit, the same way
  `deliveredQuantity` counts what challans took. The credit limit needs it to know how much of an order is still to
  be billed, and the order page shows it as a column.
- **The override on the order.** Confirming an order checks the credit limit (you chose: at confirm and at invoice
  post), so both ways of confirming carry it: "Confirm" on a saved draft (`confirmSalesOrderInputSchema`) and
  "Save and confirm" in the form (`overrideCreditLimit` on the fields). Close, cancel and reopen keep the plain
  version schema: they never add to what the customer owes.

```diff
@@ -26,6 +26,12 @@ import {
 // delivered in as many deliveries as it takes), or on its own, for a customer who collects goods
 // without an order. Its lines carry no prices: the invoice (15c) prices them.
 
+// How much of a posted delivery is billed (step 15c). An invoice bills each of its lines whole,
+// so a delivery is partly invoiced only when an invoice left some of its lines out. A draft is
+// not_invoiced.
+export const DELIVERY_INVOICE_STATES = ['not_invoiced', 'partly_invoiced', 'invoiced'] as const;
+export type DeliveryInvoiceState = (typeof DELIVERY_INVOICE_STATES)[number];
+
 // ---------------------------------------------------------------------------------------------
 // What the API sends
 
@@ -44,6 +50,7 @@ export const deliverySummarySchema = z.object({
   vehicle: z.string().nullable(),
   note: z.string().nullable(),
   lineCount: z.number().int(),
+  invoiceState: z.enum(DELIVERY_INVOICE_STATES),
   postedAt: z.iso.datetime().nullable(),
   version: z.number().int(),
   updatedAt: z.iso.datetime(),
@@ -56,6 +63,8 @@ export const deliveryLineSchema = stockLineSchema.extend({
   orderLineId: z.uuid().nullable(),
   // What the goods cost, once posted (step 14); null for a draft, and without inventory.stock.value
   value: z.string().nullable(),
+  // Billed by a posted invoice (step 15c)
+  invoiced: z.boolean(),
 });
 export type DeliveryLine = z.infer<typeof deliveryLineSchema>;
 
@@ -64,6 +73,8 @@ export const deliverySchema = deliverySummarySchema.extend({
   lines: z.array(deliveryLineSchema),
   // The cost of goods sold entry; null for a draft, or when the goods cost nothing in the books
   entry: entryRefSchema.nullable(),
+  // The posted invoices that bill its lines (step 15c); a direct invoice's own delivery has one
+  invoices: z.array(documentRefSchema),
 });
 export type Delivery = z.infer<typeof deliverySchema>;
 
@@ -130,10 +141,15 @@ export const deleteDeliveryQuerySchema = z.object({
   version: z.coerce.number<number>().int().min(1),
 });
 
+// to_invoice: posted, with a line no posted invoice bills yet — what the invoice form offers
+export const DELIVERY_INVOICE_FILTERS = ['to_invoice', 'invoiced'] as const;
+export type DeliveryInvoiceFilter = (typeof DELIVERY_INVOICE_FILTERS)[number];
+
 export const deliveryListQuerySchema = pageQuerySchema.extend({
   status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
   customerId: z.uuid().optional(),
   warehouseId: z.uuid().optional(),
+  invoice: z.enum(DELIVERY_INVOICE_FILTERS).optional(),
 });
 export type DeliveryListQuery = z.input<typeof deliveryListQuerySchema>;
 
```

- **`invoiced` on a delivery line, a yes/no.** You were told each challan line keeps how much is invoiced. While
  building it, we chose to bill a challan line **whole**: goods that left on a challan and are not billed must come
  back by a return (15d), or the books would show goods sold that were never billed. With whole lines, "how much is
  invoiced" is either nothing or all, so a yes/no says the same and cannot hold a half value.
- **`invoiceState` on the summary.** The list shows "Not invoiced", "Partly invoiced" or "Invoiced", so the
  accountant sees which challans still wait for a bill.
- **`invoice: 'to_invoice'` filter.** The invoice form asks for the customer's posted challans that still have an
  unbilled line, and nothing else.
- **`DeliveryInvoiceFilter`** names the filter's type, so the API's list function can take it without repeating the
  two values.
- **`invoices` on the delivery.** The challan page links to the invoices that billed it.

```diff
@@ -171,6 +171,25 @@ export type CustomerListQuery = z.input<typeof customerListQuerySchema>;
 export const customerPageSchema = pageOf(customerSummarySchema);
 export type CustomerPage = z.infer<typeof customerPageSchema>;
 
+// What counts against the credit limit (step 15c, you chose this): what the customer owes now,
+// plus what confirmed orders will still bill. An order line counts for what is not invoiced yet;
+// a closed order only for what it delivered. A challan without an order has no price yet, so it
+// does not count until its invoice. Saving an order (confirm) or an invoice (post) adds the
+// document itself and refuses to go over the limit.
+export const customerCreditSchema = z.object({
+  // null = no limit; "0.0000" = cash only
+  limit: z.string().nullable(),
+  // The receivable lines with this customer: the same number as the customer's balance
+  balance: z.string(),
+  // Confirmed orders, not invoiced yet
+  onOrder: z.string(),
+  // balance + onOrder
+  exposure: z.string(),
+  // limit − exposure; null without a limit, negative when already over it
+  available: z.string().nullable(),
+});
+export type CustomerCredit = z.infer<typeof customerCreditSchema>;
+
 const customerParamsSchema = z.object({ id: z.uuid() });
 
 // Reading needs no permission, like products: every sales document picks a customer. The balance
@@ -262,6 +281,17 @@ export const customerRoutes = {
     query: ledgerQuerySchema,
     response: ledgerPageSchema,
   }),
+  // What the forms show under the customer (step 15c), with the same numbers the credit check uses
+  credit: defineRoute({
+    method: 'GET',
+    path: '/customers/:id/credit',
+    summary: "A customer's credit limit, what counts against it, and what is left",
+    auth: 'bearer',
+    permission: 'sales.customer.balance',
+    status: 200,
+    params: customerParamsSchema,
+    response: customerCreditSchema,
+  }),
 };
 
 // ---------------------------------------------------------------------------------------------
```

- **`customerCreditSchema`.** The order and invoice forms show "Credit limit ৳5,00,000 · ৳1,20,000 left" under
  the customer. The endpoint returns the same numbers the credit check uses (15c.3), so the hint and the block can
  never disagree.
- **What counts (`onOrder`).** What confirmed orders will still bill: each line for what is not invoiced yet. A
  closed order counts only what it delivered, because the rest will never be billed. A challan without an order
  has no price until its invoice, so it cannot count. The comment says so, because a reader will ask.
- **`available` can be negative.** A customer can already be over the limit (an override, or a limit lowered
  later). The form shows that as "৳42,300 over".
- **It needs `sales.customer.balance`.** The numbers include what the customer owes, which 15a shows only with
  this permission. The check itself runs for everyone; only the hint is hidden.

### `routes.ts` and `index.ts`

```diff
@@ -7,6 +7,7 @@ import { authRoutes } from './auth.js';
 import { branchRoutes } from './branches.js';
 import { defineRoute } from './http.js';
 import { invitationRoutes } from './invitations.js';
+import { invoiceRoutes } from './invoices.js';
 import { journalRoutes, ledgerRoutes, openingBalanceRoutes, periodLockRoutes } from './journal.js';
 import { memberRoutes } from './members.js';
 import { notificationRoutes } from './notifications.js';
@@ -21,6 +22,7 @@ import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
 import { productRoutes } from './products.js';
 import { quotationRoutes } from './quotations.js';
+import { receiptRoutes } from './receipts.js';
 import { roleRoutes } from './roles.js';
 import { salesOrderRoutes } from './sales-orders.js';
 import { salesPriceRoutes } from './sales.js';
@@ -89,4 +91,6 @@ export const routes = {
   quotations: quotationRoutes,
   salesOrders: salesOrderRoutes,
   deliveries: deliveryRoutes,
+  invoices: invoiceRoutes,
+  receipts: receiptRoutes,
 };
```

```diff
@@ -10,6 +10,7 @@ export * from './errors.js';
 export * from './fields.js';
 export * from './http.js';
 export * from './invitations.js';
+export * from './invoices.js';
 export * from './journal.js';
 export * from './members.js';
 export * from './money.js';
@@ -24,6 +25,7 @@ export * from './product-imports.js';
 export * from './products.js';
 export * from './quantities.js';
 export * from './quotations.js';
+export * from './receipts.js';
 export * from './reports.js';
 export * from './roles.js';
 export * from './routes.js';
```

- **Two route groups**, `invoices` and `receipts`. The customer's `credit` route sits in the existing `customers`
  group. The API's contract test (step 5) checks that Nest has exactly these routes, so 15c.3 must add a
  controller for each.

### Tests

```diff
@@ -1,12 +1,18 @@
 import { describe, expect, it } from 'vitest';
 
-import { createAccountInputSchema, updateAccountInputSchema } from './accounts.js';
+import {
+  type Account,
+  createAccountInputSchema,
+  moneyAccountIds,
+  updateAccountInputSchema,
+} from './accounts.js';
 
 const valid = {
   parentId: '01939d1c-0000-7000-8000-000000000001',
   code: '1121',
   name: 'Dutch-Bangla Bank CD A/C 1234',
   isGroup: false,
+  holdsMoney: true,
   description: '',
 };
 
@@ -40,8 +46,52 @@ describe('account input', () => {
   });
 
   it('lets only an update keep the parent empty (a top-level group)', () => {
-    const top = { parentId: null, code: '1000', name: 'Assets', description: '', version: 3 };
+    const top = {
+      parentId: null,
+      code: '1000',
+      name: 'Assets',
+      holdsMoney: false,
+      description: '',
+      version: 3,
+    };
     expect(updateAccountInputSchema.parse(top).parentId).toBeNull();
     expect(createAccountInputSchema.safeParse({ ...valid, parentId: null }).success).toBe(false);
   });
 });
+
+describe('moneyAccountIds', () => {
+  type Row = Pick<Account, 'id' | 'parentId' | 'isGroup' | 'holdsMoney' | 'archivedAt'>;
+  const row = (id: string, parentId: string | null, isGroup: boolean, holdsMoney = false): Row => ({
+    id,
+    parentId,
+    isGroup,
+    holdsMoney,
+    archivedAt: null,
+  });
+  // Assets → Current assets → Cash in hand (flagged), Bank accounts (flagged group) → DBBL, and a
+  // receivable that holds no money
+  const chart: Row[] = [
+    row('assets', null, true),
+    row('current', 'assets', true),
+    row('cash', 'current', false, true),
+    row('banks', 'current', true, true),
+    row('dbbl', 'banks', false),
+    row('receivable', 'current', false),
+  ];
+
+  it('takes flagged accounts and every account under a flagged group, never the group', () => {
+    expect([...moneyAccountIds(chart)].sort()).toEqual(['cash', 'dbbl']);
+  });
+
+  it('leaves out an archived account', () => {
+    const archived = chart.map((account) =>
+      account.id === 'dbbl' ? { ...account, archivedAt: '2026-10-01T00:00:00.000Z' } : account,
+    );
+    expect([...moneyAccountIds(archived)]).toEqual(['cash']);
+  });
+
+  it('stops on a chart with a loop instead of hanging', () => {
+    const loop = [row('a', 'b', true), row('b', 'a', true), row('c', 'a', false)];
+    expect(moneyAccountIds(loop).size).toBe(0);
+  });
+});
```

```diff
@@ -10,6 +10,7 @@ import {
   isZeroMoney,
   multiplyMoney,
   negateMoney,
+  priceInUnit,
   percentOfMoney,
   prorateMoney,
   splitMoney,
@@ -107,4 +108,15 @@ describe('money', () => {
     expect(negateMoney('12.5')).toBe('-12.5000');
     expect(negateMoney('0')).toBe('0.0000');
   });
+
+  it('moves a price to another pack of the product', () => {
+    // A case of 24 at ৳504 is ৳21 a piece, and back
+    expect(priceInUnit('504', '24.000000', '1')).toBe('21.0000');
+    expect(priceInUnit('21', '1', '24')).toBe('504.0000');
+    // ৳500 a case is ৳20.8333… a piece: 4 decimals, rounded
+    expect(priceInUnit('500', '24', '1')).toBe('20.8333');
+    // A yard is 0.9144 m: ৳100 a metre is ৳91.44 a yard
+    expect(priceInUnit('100', '1', '0.914400')).toBe('91.4400');
+    expect(() => priceInUnit('100', '0', '1')).toThrow();
+  });
 });
```

```ts
import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  dueDateOf,
  invoiceInputSchema,
  isOverdue,
  paymentStatusOf,
  postInvoiceInputSchema,
} from './invoices.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const BRANCH = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RATE = '01920000-0000-7000-8000-000000000005';
const DELIVERY_LINE = '01920000-0000-7000-8000-000000000006';
const ORDER_LINE = '01920000-0000-7000-8000-000000000007';
const BATCH = '01920000-0000-7000-8000-000000000008';
const SERVICE_LINE = '01920000-0000-7000-8000-000000000009';

function invoiceLine(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '2',
    description: '',
    unitPrice: '504',
    discountType: 'percent',
    discount: '',
    taxRateId: RATE,
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
    ...extra,
  };
}

function invoice(extra: object = {}) {
  return {
    customerId: CUSTOMER,
    date: '2026-10-08',
    dueDate: '',
    customerReference: '',
    branchId: BRANCH,
    warehouseId: '',
    note: '',
    lines: [invoiceLine({ deliveryLineId: DELIVERY_LINE })],
    post: false,
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

describe('payment status', () => {
  it('reads unpaid, partly paid and paid from the total and what was paid', () => {
    expect(paymentStatusOf({ total: '1150.0000', amountPaid: '0.0000' })).toBe('unpaid');
    expect(paymentStatusOf({ total: '1150.0000', amountPaid: '1000.0000' })).toBe('partly_paid');
    expect(paymentStatusOf({ total: '1150.0000', amountPaid: '1150.0000' })).toBe('paid');
    // A free sample owes nothing
    expect(paymentStatusOf({ total: '0.0000', amountPaid: '0.0000' })).toBe('paid');
  });

  it('is overdue only after the due date, while money is still owed', () => {
    const posted = {
      status: 'posted',
      dueDate: '2026-10-08',
      total: '1150.0000',
      amountPaid: '0.0000',
    };
    expect(isOverdue(posted, '2026-10-08')).toBe(false);
    expect(isOverdue(posted, '2026-10-09')).toBe(true);
    expect(isOverdue({ ...posted, amountPaid: '1150.0000' }, '2026-10-09')).toBe(false);
    // A draft asks for nothing yet
    expect(isOverdue({ ...posted, status: 'draft' }, '2026-10-09')).toBe(false);
  });

  it('starts the due date at the date plus the payment terms', () => {
    expect(dueDateOf('2026-10-08', 30)).toBe('2026-11-07');
    expect(dueDateOf('2026-10-08', 0)).toBe('2026-10-08');
    expect(dueDateOf('2027-06-15', 30)).toBe('2027-07-15');
  });
});

describe('invoice input', () => {
  it('reads empty boxes as "not chosen", and never overrides the credit limit unasked', () => {
    const parsed = invoiceInputSchema.parse(invoice());
    expect(parsed).toMatchObject({
      dueDate: null,
      customerReference: null,
      warehouseId: null,
      overrideCreditLimit: false,
    });
    expect(parsed.lines[0]).toMatchObject({ orderLineId: null, batchId: null });
    expect(postInvoiceInputSchema.parse({ version: 3 }).overrideCreditLimit).toBe(false);
  });

  it('marks every mistake at once', () => {
    const result = invoiceInputSchema.safeParse(
      invoice({
        customerId: '',
        branchId: '',
        dueDate: '2026-10-01',
        lines: [
          // One line cannot bill a challan line and an order line
          invoiceLine({ deliveryLineId: DELIVERY_LINE, orderLineId: ORDER_LINE }),
          // A service of the order has no batch to pick
          invoiceLine({ orderLineId: SERVICE_LINE, batchId: BATCH, serialNumbers: ['SN-1'] }),
        ],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      customerId: 'sales_customer_required',
      branchId: 'sales_branch_invalid',
      dueDate: 'invoice_due_date',
      'lines.0.orderLineId': 'invoice_line_source',
      'lines.1.batchId': 'invoice_stock_not_allowed',
      'lines.1.serialNumbers': 'invoice_stock_not_allowed',
    });
  });

  it('bills a challan line once, and moves a serial number once', () => {
    const twice = invoiceInputSchema.safeParse(
      invoice({
        lines: [
          invoiceLine({ deliveryLineId: DELIVERY_LINE }),
          invoiceLine({ deliveryLineId: DELIVERY_LINE }),
        ],
      }),
    );
    expect(errorsOf(twice)).toEqual({ 'lines.1.deliveryLineId': 'invoice_line_twice' });

    // Two lines of its own, the same phone scanned on both
    const serials = invoiceInputSchema.safeParse(
      invoice({
        lines: [
          invoiceLine({ serialNumbers: ['IMEI-356938035643809'] }),
          invoiceLine({ serialNumbers: ['IMEI-356938035643809'] }),
        ],
      }),
    );
    expect(errorsOf(serials)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('lets a line of its own pick its batch, and keeps the discount rule of every sales line', () => {
    expect(
      invoiceInputSchema.safeParse(invoice({ lines: [invoiceLine({ batchId: BATCH })] })).success,
    ).toBe(true);
    const tooMuch = invoiceInputSchema.safeParse(
      invoice({ lines: [invoiceLine({ discountType: 'amount', discount: '1009' })] }),
    );
    // 2 × ৳504 = ৳1,008: ৳1,009 off is more than the line
    expect(errorsOf(tooMuch)).toEqual({ 'lines.0.discount': 'sales_discount_too_large' });
  });
});
```

```ts
import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  overAllocated,
  receiptAllocationsInputSchema,
  receiptInputSchema,
  voidReceiptInputSchema,
} from './receipts.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const BRANCH = '01920000-0000-7000-8000-000000000002';
const ACCOUNT = '01920000-0000-7000-8000-000000000003';
const INVOICE_A = '01920000-0000-7000-8000-000000000004';
const INVOICE_B = '01920000-0000-7000-8000-000000000005';

function receipt(extra: object = {}) {
  return {
    customerId: CUSTOMER,
    date: '2026-10-08',
    amount: '50000',
    accountId: ACCOUNT,
    method: 'cheque',
    reference: 'DBBL 0048812',
    branchId: BRANCH,
    note: '',
    allocations: [
      { invoiceId: INVOICE_A, amount: '30000' },
      { invoiceId: INVOICE_B, amount: '20000' },
    ],
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

describe('receipt input', () => {
  it('takes a receipt applied in full, in part, or not at all (an advance)', () => {
    expect(receiptInputSchema.safeParse(receipt()).success).toBe(true);
    expect(
      receiptInputSchema.safeParse(
        receipt({ allocations: [{ invoiceId: INVOICE_A, amount: '1' }] }),
      ).success,
    ).toBe(true);
    expect(receiptInputSchema.parse(receipt({ allocations: [] })).allocations).toEqual([]);
  });

  it('needs an amount above zero, one error per box', () => {
    for (const amount of ['', '0', '0.00']) {
      const result = receiptInputSchema.safeParse(receipt({ amount, allocations: [] }));
      expect(errorsOf(result)).toEqual({ amount: 'receipt_amount_required' });
    }
    const typo = receiptInputSchema.safeParse(receipt({ amount: '50,000', allocations: [] }));
    expect(errorsOf(typo)).toEqual({ amount: 'money_format' });
  });

  it('never applies more than the receipt, nor one invoice twice', () => {
    const over = receiptInputSchema.safeParse(receipt({ amount: '49999.99' }));
    expect(errorsOf(over)).toEqual({ allocations: 'receipt_over_allocated' });

    const twice = receiptInputSchema.safeParse(
      receipt({
        allocations: [
          { invoiceId: INVOICE_A, amount: '100' },
          { invoiceId: INVOICE_A, amount: '100' },
        ],
      }),
    );
    expect(errorsOf(twice)).toEqual({ 'allocations.1.invoiceId': 'receipt_invoice_twice' });
  });

  it('marks every mistake at once', () => {
    const result = receiptInputSchema.safeParse(
      receipt({
        customerId: '',
        accountId: '',
        branchId: '',
        allocations: [{ invoiceId: '', amount: '0' }],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      customerId: 'sales_customer_required',
      accountId: 'receipt_account_invalid',
      branchId: 'sales_branch_invalid',
      'allocations.0.invoiceId': 'receipt_invoice_invalid',
      'allocations.0.amount': 'receipt_amount_required',
    });
  });

  it('applies again without the amount, which the server knows', () => {
    const result = receiptAllocationsInputSchema.safeParse({
      version: 2,
      allocations: [
        { invoiceId: INVOICE_B, amount: '5000' },
        { invoiceId: INVOICE_B, amount: '5000' },
      ],
    });
    expect(errorsOf(result)).toEqual({ 'allocations.1.invoiceId': 'receipt_invoice_twice' });
    expect(overAllocated('50000', [{ amount: '30000' }, { amount: '20000.0001' }])).toBe(true);
    expect(overAllocated('50000', [{ amount: '30000' }, { amount: '20000' }])).toBe(false);
  });

  it('voids only with a reason', () => {
    const result = voidReceiptInputSchema.safeParse({
      version: 1,
      date: '2026-10-12',
      reason: '  ',
    });
    expect(errorsOf(result)).toEqual({ reason: 'receipt_void_reason_required' });
  });
});
```

- **The money account chart** in `accounts.spec.ts` is the template's shape in small: cash flagged by itself, a
  bank under a flagged group, a receivable that holds no money. The group itself is never returned.
- **`priceInUnit()` is checked both ways** (case → piece and back), with a price that does not divide evenly
  (`৳500 ÷ 24`) and with a yard, whose factor has 6 decimals.
- **`isOverdue()` on the due date itself** returns `false`. That is the line a person would argue about, so the
  test pins it.
- **"Marks every mistake at once"**, in both specs. Zod 4 runs the document's own rules even when a field has
  failed (as in 15b), so the form marks every mistake on the first save.
- **Two lines with the same IMEI** must fail on the second line's serial box (`documentSerialRules()` from step 13
  runs on the invoice too), because the invoice will deliver those goods itself.
- **`receipt_amount_required` for `''`, `'0'` and `'0.00'`**, and `money_format` for `'50,000'`: one error per box.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test          # 139 tests, 17 new
pnpm lint
```

`pnpm typecheck` for the whole repo **fails** after this part, and that is expected. The next parts fix it:
`packages/db` needs a description for each new permission and the `holds_money` column (15c.2), the API must send
the new fields and serve the new routes (15c.3), `packages/i18n` needs the new keys (15c.5), and the app's
account form and mocks need the new fields (15c.6, 15c.7).


## 15c.2 — `packages/db`: invoices, receipts and the rules on them

The contract has invoices and money receipts; this part gives them four tables. Two new schema files, mirroring the
contract: `invoices.ts` (invoices and their lines) and `receipts.ts` (receipts and the allocations that apply their
money to invoices). Four existing files change a little: the 15b sales tables get what an invoice writes into them,
the chart of accounts gets `holds_money`, the journal's document check learns the two new sources, and the
permission catalog describes the three new permissions. Migration 0029 is generated from the schema; 0030 is written
by hand: row-level security, the triggers that decide what may change when, the trigger that keeps "paid" and
"applied" equal to the allocations, and the money flag for workspaces that already exist.

### `schema/sales-documents.ts`: what 15c writes into the 15b tables

```diff
@@ -32,13 +32,16 @@ import { warehouses } from './warehouses.js';
 
 // Step 15b: quotations, sales orders and deliveries (challans). The rules on what may change when
 // (a confirmed order's lines, a posted delivery) live in migration 0028, like the stock documents'.
+// Step 15c adds what invoices write here: an order line's invoiced quantity and a challan line's
+// invoiced flag (rules in migration 0030). The invoices themselves are in invoices.ts.
 
 // The columns a quotation line and an order line share: the product, the quantity (as typed and in
 // the base unit, like a stock line), the price and discount as typed, and a copy of the VAT rate.
 // net, vat and total are what contracts' lineAmounts() gave when the line was saved: stored, not
 // worked out on every read, so a list shows the totals without the arithmetic, and a document reads
 // the same in five years whatever happens to the code.
-function salesLineColumns() {
+// Exported: an invoice line (step 15c, invoices.ts) is a sales line too.
+export function salesLineColumns() {
   return {
     id: baseColumns().id,
     tenantId: uuid('tenant_id')
@@ -70,8 +73,9 @@ function salesLineColumns() {
   };
 }
 
-// The totals every quotation and order keeps: the sums of its lines (contracts' documentTotals)
-function totalColumns() {
+// The totals every quotation, order and invoice keeps: the sums of its lines (contracts'
+// documentTotals)
+export function totalColumns() {
   return {
     discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
     net: numeric('net', { precision: 19, scale: 4 }).notNull().default('0'),
@@ -260,6 +264,12 @@ export const salesOrderLines = pgTable(
     deliveredQuantity: numeric('delivered_quantity', { precision: 19, scale: 4 })
       .notNull()
       .default('0'),
+    // In the base unit: what posted invoices billed (step 15c). A goods line through its challan
+    // lines, a service line straight from the order. Written by the invoice's posting, under a
+    // lock on the order; read by the credit check ("what confirmed orders will still bill").
+    invoicedQuantity: numeric('invoiced_quantity', { precision: 19, scale: 4 })
+      .notNull()
+      .default('0'),
   },
   (table) => [
     uniqueIndex('sales_order_lines_line_idx').on(table.tenantId, table.orderId, table.lineNo),
@@ -306,6 +316,11 @@ export const salesOrderLines = pgTable(
       'sales_order_lines_delivered_check',
       sql`${table.deliveredQuantity} BETWEEN 0 AND ${table.baseQuantity}`,
     ),
+    // Never billed more than was ordered, whatever the API checked first
+    check(
+      'sales_order_lines_invoiced_check',
+      sql`${table.invoicedQuantity} BETWEEN 0 AND ${table.baseQuantity}`,
+    ),
   ],
 );
 
@@ -378,9 +393,19 @@ export const deliveryLines = pgTable(
     orderLineId: uuid('order_line_id'),
     // What the goods cost, at the average cost when posted (step 14); NULL while a draft
     value: numeric('value', { precision: 19, scale: 4 }),
+    // Billed by a posted invoice (step 15c). An invoice bills a challan line whole, so a yes/no is
+    // enough. It goes from false to true once, when the invoice is posted (migration 0030).
+    invoiced: boolean('invoiced').notNull().default(false),
   },
   (table) => [
     uniqueIndex('delivery_lines_line_idx').on(table.tenantId, table.deliveryId, table.lineNo),
+    // The target of the invoice line's FK (step 15c)
+    uniqueIndex('delivery_lines_tenant_id_idx').on(table.tenantId, table.id),
+    // The challans still to bill (the invoice form's picker). Partial: after a year almost every
+    // line is invoiced, and only the few that are not stay in it.
+    index('delivery_lines_to_invoice_idx')
+      .on(table.tenantId, table.deliveryId)
+      .where(sql`NOT ${table.invoiced}`),
     index('delivery_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
     // The order line FK's check when a draft order's lines are replaced
     index('delivery_lines_order_line_idx')
```

- **`salesLineColumns()` and `totalColumns()` are exported.** An invoice line has exactly the columns of an order
  line: the product, the quantity, the price as typed, the copied VAT rate, and `net`/`vat`/`total`. 15c.3 fills
  them with the same contract function (`lineAmounts()`), so the columns must be the same, and one function keeps
  them so. This is what 15b did with `stockLineColumns()`.
- **`invoiced_quantity` on the order line**, in the base unit, like `delivered_quantity`. It is what posted invoices
  billed: a goods line through its challan lines, a service line straight from the order. The credit check reads it
  for every open order of a customer ("what confirmed orders will still bill"), so it is stored, not summed from
  invoice lines on every check.
- **`sales_order_lines_invoiced_check`: between 0 and `base_quantity`.** The last word on billing more than was
  ordered. It cannot say "at most what was delivered" for a goods line: that needs the product's type, which is
  not on the line. 15c.3 checks that rule, with its own error.
- **`invoiced` on the challan line is a yes/no, not a quantity.** In the questions before this step, you were told
  "each delivery line keeps an invoiced quantity". While designing the contract (15c.1) this became "an invoice bills
  a challan line whole", so the only two states are "billed" and "not billed". A quantity column would allow states
  that can never happen (half billed), and every reader would have to ask what they mean. The rule is the same:
  nothing is billed twice.
- **`delivery_lines_tenant_id_idx` (tenant, id) is unique.** The `id` is unique already; this index is the target
  of the invoice line's composite FK, like `sales_order_lines_tenant_id_idx` in 15b.
- **`delivery_lines_to_invoice_idx` is partial, `WHERE NOT invoiced`.** The invoice form's challan picker lists
  posted challans with a line still to bill (`invoice=to_invoice`). After a year almost every line is billed, so
  this index holds only the few that are not, like the open orders index in 15b.

### `schema/invoices.ts` (new): the invoice

```ts
import { INVOICE_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches } from './batches.js';
import { branches } from './branches.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import {
  deliveryLines,
  salesLineColumns,
  salesOrderLines,
  totalColumns,
} from './sales-documents.js';
import { stockLineColumns } from './stock-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 15c: sales invoices. A draft is changed freely; posting numbers it and books the sale, and
// from then on only what receipts paid (amount_paid) moves. The rules on what may change when live
// in migration 0030.

export const invoices = pgTable(
  'invoices',
  {
    // deleted_at is not used: a draft is deleted for real, a posted invoice never (15d's credit
    // note corrects it)
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('sales.invoice'), so posted numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    // Always set: the API fills an empty one with the date plus the customer's payment terms
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    customerReference: text('customer_reference'),
    // Whose sale it is: every line of its journal entry carries this branch
    branchId: uuid('branch_id').notNull(),
    // Where its own goods lines leave from; NULL when every goods line is on a challan
    warehouseId: uuid('warehouse_id'),
    // The customer's billing address text when the invoice was saved: what it prints, even after
    // the customer moves
    billingAddress: text('billing_address'),
    // The orders' copy of the setting when it bills orders, else the workspace setting
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),
    note: text('note'),
    ...totalColumns(),
    // The sum of the receipt allocations that point here. Kept by the allocations' trigger
    // (migration 0030), never written by the API, so it can never disagree with them.
    amountPaid: numeric('amount_paid', { precision: 19, scale: 4 }).notNull().default('0'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('invoices_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the receipt allocation's FK: an invoice of THIS customer
    uniqueIndex('invoices_customer_id_idx').on(table.tenantId, table.customerId, table.id),
    uniqueIndex('invoices_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('invoices_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One customer's invoices, and the customer FK's check on delete
    index('invoices_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // What is still to be paid, oldest due date first: one customer's (the receipt form's list, in
    // the order it suggests paying them) and everyone's (the overdue list). Partial: a paid
    // invoice leaves both, so they stay small however many invoices a year brings.
    index('invoices_open_customer_idx')
      .on(table.tenantId, table.customerId, table.dueDate, table.id)
      .where(sql`${table.status} = 'posted' AND ${table.amountPaid} < ${table.total}`),
    index('invoices_open_due_idx')
      .on(table.tenantId, table.dueDate, table.id)
      .where(sql`${table.status} = 'posted' AND ${table.amountPaid} < ${table.total}`),
    // No ON DELETE: a customer with an invoice cannot be deleted (customer_in_use)
    foreignKey({
      name: 'invoices_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // Branches and warehouses are archived, never deleted, so these two need no index
    foreignKey({
      name: 'invoices_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: 'invoices_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Posted ⇔ a number and a posting time, like a delivery
    check(
      'invoices_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
    check('invoices_due_date_check', sql`${table.dueDate} >= ${table.date}`),
    check(
      'invoices_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    // Never paid more than the total, and a draft is never paid: the last word on
    // receipt_over_invoice, whatever the API checked first
    check(
      'invoices_paid_check',
      sql`${table.amountPaid} >= 0 AND ${table.amountPaid} <= ${table.total} AND (${table.status} = 'posted' OR ${table.amountPaid} = 0)`,
    ),
  ],
);
```

- **Shaped like a delivery.** A draft has no number; posting gives it one (INV-2026-27-0001), and
  `invoices_posted_check` says posted ⇔ a number and a posting time, the same as `deliveries`. A number given at
  posting means posted invoices have no gaps in their numbers, which the NBR expects.
- **`due_date` is `NOT NULL`.** The form may leave it empty; the API then writes the date plus the customer's
  payment terms (`dueDateOf()`, 15c.1). Every posted invoice therefore has a due date, so "overdue" and the receipt
  form's "oldest due first" never meet a `NULL`. `invoices_due_date_check` is the contract's `invoice_due_date`
  rule again.
- **`branch_id` is required, `warehouse_id` is not.** The branch is whose sale it is: every line of the invoice's
  journal entry carries it, so step 11's profit and loss by branch shows the sale. The warehouse is only needed
  when the invoice delivers goods itself (a direct invoice). An invoice that only bills challans has none.
- **No index on the branch and warehouse FKs.** Branches and warehouses are archived, never deleted, so Postgres
  never has to check these FKs on a delete. Every other FK that can block a delete has an index.
- **`billing_address` is text, not an id.** The API copies the customer's billing address when it saves the
  invoice. A posted invoice must print the address it was sent to, even after the customer moves; there is no
  "address id" for 15a's form to delete under it, so no `ON DELETE SET NULL` trick like the orders' is needed.
- **`prices_include_vat` on the invoice.** It comes from the orders it bills (15c.1: they must agree, or
  `invoice_vat_mixed`), or from the workspace setting. Stored for the same reason as on an order: the setting may
  change later.
- **`amount_paid` is kept by a trigger, never by the API.** It is the sum of the receipt allocations that point at
  the invoice. Migration 0030 adds or removes each allocation's amount in the same statement that writes the
  allocation. If the API wrote it, two code paths (a new receipt, a re-applied one, a void) would each have to
  remember, and one day one would forget. The payment status (unpaid, partly paid, paid) is worked out from
  `total` and `amount_paid` (15c.1), so it is not stored either.
- **`invoices_customer_id_idx` (tenant, customer, id) is unique.** Like `sales_orders_customer_id_idx` in 15b: it
  adds no rule of its own, but it is the target of the allocation's FK, which includes the customer. That FK is how
  the database makes sure a receipt pays only its own customer's invoices.
- **The two open indexes are partial: `WHERE status = 'posted' AND amount_paid < total`.** The receipt form lists one
  customer's open invoices, oldest due date first: the order it suggests paying them in
  (`invoices_open_customer_idx`). The overdue list does the same for every customer (`invoices_open_due_idx`). A
  paid invoice leaves both indexes, so they stay small however many invoices a year brings. A partial index may
  compare two columns of the row; Postgres keeps it up to date when `amount_paid` changes.
- **`invoices_paid_check`.** Three rules in one: nothing negative; never more than the total; a draft is never
  paid. The API checks first and answers `receipt_over_invoice` with the row. This check is the last word, and the
  only one that holds when two people apply money to the same invoice at the same moment (see 0030, section 4).

### The invoice's lines

```ts
// The batch and serial numbers of a line of its own, the same two columns a challan line has
const { batchId, serialNumbers } = stockLineColumns();

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    ...salesLineColumns(),
    invoiceId: uuid('invoice_id').notNull(),
    // The challan line it bills. A line of its own gets the line of the challan the posting made.
    deliveryLineId: uuid('delivery_line_id'),
    // The order line behind it: the challan line's (copied by the API), or an order's service line
    orderLineId: uuid('order_line_id'),
    // Only on a goods line of its own: what the posting's challan takes out
    batchId,
    serialNumbers,
  },
  (table) => [
    uniqueIndex('invoice_lines_line_idx').on(table.tenantId, table.invoiceId, table.lineNo),
    index('invoice_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // Which invoice billed a challan line (the delivery page), and the FK's check
    index('invoice_lines_delivery_line_idx')
      .on(table.tenantId, table.deliveryLineId)
      .where(sql`${table.deliveryLineId} IS NOT NULL`),
    // An order's invoices (the order page), and the FK's check when a draft order's lines change
    index('invoice_lines_order_line_idx')
      .on(table.tenantId, table.orderLineId)
      .where(sql`${table.orderLineId} IS NOT NULL`),
    foreignKey({
      name: 'invoice_lines_invoice_fk',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('cascade'),
    // No ON DELETE on the next two: a line an invoice points at cannot be deleted. A posted
    // challan's lines never are anyway; an order line is, when a draft order is changed, and this
    // keeps an order line that a draft invoice bills from disappearing under it.
    foreignKey({
      name: 'invoice_lines_delivery_line_fk',
      columns: [table.tenantId, table.deliveryLineId],
      foreignColumns: [deliveryLines.tenantId, deliveryLines.id],
    }),
    foreignKey({
      name: 'invoice_lines_order_line_fk',
      columns: [table.tenantId, table.orderLineId],
      foreignColumns: [salesOrderLines.tenantId, salesOrderLines.id],
    }),
    foreignKey({
      name: 'invoice_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'invoice_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'invoice_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    foreignKey({
      name: 'invoice_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'invoice_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'invoice_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check('invoice_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
  ],
);
```

- **`salesLineColumns()` plus four columns.** `delivery_line_id` and `order_line_id` say what the line bills;
  `batch_id` and `serial_numbers` are for a goods line of its own.
- **`batch_id` and `serial_numbers` come from `stockLineColumns()`.** The two columns must be what a challan line
  has: posting a direct invoice copies them onto the challan line it makes (15c.3). Taking them from the same
  function means a later change to one changes both. The destructuring runs `stockLineColumns()` once, at load
  time, and uses only its two column builders.
- **Both `delivery_line_id` and `order_line_id` may be set on one line.** The contract forbids sending both
  (`invoice_line_source`), but the stored row is different: for a challan line, the API copies the challan line's
  order line onto the invoice line, so posting can add to the order line's `invoiced_quantity` without another
  join. So there is no "one or the other" check here.
- **`delivery_line_id` is `NULL` on a goods line of its own until posting.** Posting makes a challan for those
  lines, then points each invoice line at its new challan line. After posting every goods line has a challan line,
  so the invoice page and the print can show the batch, expiry and serials the same way for both kinds.
- **The delivery line and order line FKs have no `ON DELETE`.** A posted challan's lines are never deleted anyway.
  An order line is deleted when a draft order's lines are replaced; this FK keeps that from happening under a draft
  invoice that bills the line. We tried it: the delete fails on `invoice_lines_order_line_fk`.
- **Two partial indexes, on the delivery line and the order line.** They answer "which invoice billed this?" for the
  delivery page (`invoices`) and the order page, and they are what Postgres uses for the two FKs' checks.
- **The amount and VAT checks are 15b's again**, with the invoice's names.

### `schema/receipts.ts` (new): the receipt

```ts
import { PAYMENT_METHODS, RECEIPT_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { invoices } from './invoices.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { tenants } from './tenants.js';

// Step 15c: money receipts and the invoices their money is applied to. A receipt is posted when it
// is saved; afterwards only its allocations change, until it is voided. The rules live in
// migration 0030.

export const receipts = pgTable(
  'receipts',
  {
    // deleted_at is not used: a receipt is never deleted, a mistake is voided
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('sales.receipt'): saved means posted
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // The sum of its allocations, kept by their trigger (migration 0030) like invoices.amount_paid.
    // amount − applied is the customer's money not applied to an invoice yet.
    applied: numeric('applied', { precision: 19, scale: 4 }).notNull().default('0'),
    // The cash, bank or wallet account it went into (a money account: the API checks that)
    accountId: uuid('account_id').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    reference: text('reference'),
    branchId: uuid('branch_id').notNull(),
    note: text('note'),
    status: text('status', { enum: RECEIPT_STATUSES }).notNull().default('posted'),
    // Set when voided: the day the money turned out not to be there, and why
    voidDate: date('void_date', { mode: 'string' }),
    voidReason: text('void_reason'),
  },
  (table) => [
    uniqueIndex('receipts_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the allocation's FK: a receipt of THIS customer
    uniqueIndex('receipts_customer_id_idx').on(table.tenantId, table.customerId, table.id),
    uniqueIndex('receipts_tenant_number_idx').on(table.tenantId, table.number),
    index('receipts_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('receipts_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // A customer's money that is not applied yet (advances): what the invoice and receipt pages
    // offer to apply. Partial: once applied in full, a receipt leaves it.
    index('receipts_unapplied_idx')
      .on(table.tenantId, table.customerId, table.date, table.id)
      .where(sql`${table.status} = 'posted' AND ${table.applied} < ${table.amount}`),
    // The account FK's check when an account is deleted (accounts are deleted for real when unused)
    index('receipts_account_idx').on(table.tenantId, table.accountId),
    foreignKey({
      name: 'receipts_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'receipts_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'receipts_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    // A receipt of ৳0 moved no money, and its money is never applied twice over
    check(
      'receipts_amount_check',
      sql`${table.amount} > 0 AND ${table.applied} >= 0 AND ${table.applied} <= ${table.amount}`,
    ),
    // Voided ⇔ a void date and a reason. A voided receipt paid nothing: its allocations are
    // removed before it is voided.
    check(
      'receipts_void_check',
      sql`(${table.status} = 'voided') = (${table.voidDate} IS NOT NULL AND ${table.voidReason} IS NOT NULL) AND (${table.status} = 'posted' OR ${table.applied} = 0) AND (${table.voidDate} IS NULL OR ${table.voidDate} >= ${table.date})`,
    ),
  ],
);
```

- **`number` is `NOT NULL`, and there is no draft.** Saving a receipt posts it (15c.1): the money is already in hand,
  and the cashier hands over the receipt with its number. `status` is `posted` or `voided`.
- **`applied` is kept by the same trigger as `invoices.amount_paid`.** `amount − applied` is the customer's money
  that is not applied to an invoice yet: an advance, or money for an opening balance that has no invoice.
- **`receipts_unapplied_idx` is partial.** It lists one customer's receipts with money left to apply. The invoice
  page and the receipt page offer that money; once applied in full, a receipt leaves the index.
- **`account_id` is any ledger account here.** Whether it is a money account depends on the groups above it
  (`moneyAccountIds()`, 15c.1), which a check constraint cannot see. 15c.3 checks it (`receipt_account_invalid`).
  The FK only makes sure it is an account of this workspace.
- **`receipts_account_idx`.** An unused account can be deleted (step 9). Without this index, every such delete would
  read the whole receipts table to check this FK.
- **No `entry_id` column.** The receipt's journal entry points at the receipt (`document_id`, source
  `sales_receipt`), like a delivery's entry. The void's entry is the reversal of that entry (`reversal_of_id`). Both
  are found with indexes that exist already, so a second link that could disagree is not needed.
- **`receipts_amount_check`.** A receipt of ৳0 moved no money, and its money is never applied twice over
  (`applied <= amount`). Like `invoices_paid_check`, this is the last word on `receipt_over_allocated`.
- **`receipts_void_check`.** Three rules: voided ⇔ a void date and a reason; a voided receipt has nothing applied
  (its allocations are removed first, so the invoices owe that money again); the void date is not before the
  receipt's own date (`receipt_void_date`).

### The allocations

```ts
// The money of one receipt put on one invoice. The pair is unique; changing how the money is
// applied replaces the receipt's rows.
export const receiptAllocations = pgTable(
  'receipt_allocations',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    receiptId: uuid('receipt_id').notNull(),
    // The customer of both: it is in both FKs, so a receipt pays only its own customer's invoices
    customerId: uuid('customer_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('receipt_allocations_pair_idx').on(
      table.tenantId,
      table.receiptId,
      table.invoiceId,
    ),
    // An invoice's payments (its page), and the invoice FK's check
    index('receipt_allocations_invoice_idx').on(table.tenantId, table.invoiceId),
    foreignKey({
      name: 'receipt_allocations_receipt_fk',
      columns: [table.tenantId, table.customerId, table.receiptId],
      foreignColumns: [receipts.tenantId, receipts.customerId, receipts.id],
    }),
    foreignKey({
      name: 'receipt_allocations_invoice_fk',
      columns: [table.tenantId, table.customerId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.customerId, invoices.id],
    }),
    check('receipt_allocations_amount_check', sql`${table.amount} > 0`),
  ],
);
```

- **`customer_id` is on the allocation, and in both FKs.** The receipt FK is (tenant, customer, receipt) and the
  invoice FK is (tenant, customer, invoice). One column, two FKs, and an allocation can only join a receipt and an
  invoice of the same customer. This is the trick from 15b's `deliveries_order_fk`. We tried both ways round:
  naming the receipt's customer fails on the invoice FK, naming the invoice's customer fails on the receipt FK.
- **`receipt_allocations_pair_idx` is unique.** One receipt pays one invoice in one row. It is also the index for "this
  receipt's allocations".
- **No timestamps.** Re-applying a receipt replaces its rows (15c.3 deletes them and inserts the new list), so a
  row's own creation time would mean little. The audit log (`receipt.allocated`) says who changed it and when.
- **No `ON DELETE CASCADE` on the receipt FK.** Receipts are never deleted (0030), so there is nothing to cascade.

### `schema/ledger-accounts.ts`: which accounts hold money

```diff
@@ -36,6 +36,10 @@ export const ledgerAccounts = pgTable(
     isGroup: boolean('is_group').notNull().default(false),
     // What the system uses this account for (contracts: ACCOUNT_PURPOSES). NULL for most accounts.
     purpose: text('purpose', { enum: ACCOUNT_PURPOSES }),
+    // Step 15c: money is kept here (cash, a bank, a wallet). On a group it covers every account in
+    // it, at any depth: contracts' moneyAccountIds() walks up the tree. A money receipt goes into
+    // one of these.
+    holdsMoney: boolean('holds_money').notNull().default(false),
     description: text('description'),
     // Like branches: hidden from new entries, never removed from old reports
     archivedAt: timestamp('archived_at', { withTimezone: true }),
@@ -72,5 +76,8 @@ export const ledgerAccounts = pgTable(
       'ledger_accounts_purpose_not_group',
       sql`${table.purpose} IS NULL OR NOT ${table.isGroup}`,
     ),
+    // Money is an asset. The type comes from the parent, so this is the last word on
+    // account_money_type, whatever the API checked first.
+    check('ledger_accounts_money_type', sql`NOT ${table.holdsMoney} OR ${table.type} = 'asset'`),
   ],
 );
```

- **`holds_money`, `NOT NULL DEFAULT false`.** Adding a column with a constant default does not rewrite the table
  in Postgres 11 and later, so this is quick even on a large chart. Old workspaces get their flags in 0030.
- **`ledger_accounts_money_type`: assets only.** A liability (a loan, an overdraft) is not where a customer's money
  goes. The type comes from the parent, so the form cannot know it until the parent is picked; 15c.3 answers
  `account_money_type` first, and this check is the last word.
- **No rule against a flag on a group.** A flag on "Bank accounts" is the whole point: every bank account added under
  it later counts, with no tick of its own.

### `schema/journal.ts`, `schema/index.ts`, `permission-catalog.ts`

```diff
@@ -41,9 +41,9 @@ export const journalEntries = pgTable(
     source: text('source', { enum: JOURNAL_SOURCES }).notNull().default('manual'),
     // Set on a reversal: the entry it undoes
     reversalOfId: uuid('reversal_of_id'),
-    // The stock document that made this entry (step 14): which one follows from the source (an
-    // adjustment, a transfer, a revaluation); its number never changes once posted, so the
-    // journal shows it without a join
+    // The document that made this entry (step 14; sales documents since 15b): which one follows
+    // from the source (an adjustment, a transfer, a delivery, an invoice, a receipt …); its number
+    // never changes once posted, so the journal shows it without a join
     documentId: uuid('document_id'),
     documentNumber: text('document_number'),
     postedAt: timestamp('posted_at', { withTimezone: true }),
@@ -76,13 +76,15 @@ export const journalEntries = pgTable(
       'journal_entries_reversal_check',
       sql`(${table.source} = 'reversal') = (${table.reversalOfId} IS NOT NULL)`,
     ),
-    // A stock document's entry (a delivery's too, step 15b) always points at its document, and no
-    // other entry does. The list is contracts' STOCK_JOURNAL_SOURCES.
+    // A document's entry (a stock document's, a delivery's since step 15b, an invoice's and a
+    // receipt's since 15c) always points at its document, and no other entry does. The list is
+    // contracts' DOCUMENT_JOURNAL_SOURCES.
     check(
       'journal_entries_document_check',
-      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
     ),
-    // A stock document's entries (a transfer has up to two)
+    // A document's entries (a transfer has up to two; an invoice or a receipt has one, which the
+    // invoice page and the receipt page find here)
     index('journal_entries_document_idx')
       .on(table.tenantId, table.documentId)
       .where(sql`${table.documentId} IS NOT NULL`),
```

- **`sales_invoice` and `sales_receipt` join the document check.** An invoice's entry and a receipt's entry point at
  their document, like a delivery's. Without this, 15c.3's posting would fail on
  `journal_entries_document_check`. The list is the contract's `DOCUMENT_JOURNAL_SOURCES` (15c.1); a check constraint
  cannot import it, so the comment says where it comes from.
- `drizzle-kit` turns this into `DROP CONSTRAINT` + `ADD CONSTRAINT`. Adding it checks every existing entry, which
  passes: no entry has a new source yet.

```diff
@@ -34,3 +34,5 @@ export * from './tax-rates.js';
 export * from './price-lists.js';
 export * from './parties.js';
 export * from './sales-documents.js';
+export * from './invoices.js';
+export * from './receipts.js';
```

```diff
@@ -35,6 +35,9 @@ const DESCRIPTIONS = {
   'sales.quotation.manage': 'Write, edit, decline and delete quotations',
   'sales.order.manage': 'Write, confirm, reopen, close and cancel sales orders',
   'sales.delivery.manage': 'Write and post deliveries (delivery challans), which take stock out',
+  'sales.invoice.manage': 'Write, post and delete draft sales invoices',
+  'sales.receipt.manage': 'Record money receipts, apply them to invoices and void them',
+  'sales.credit.override': "Confirm orders and post invoices over a customer's credit limit",
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- **The three descriptions make `packages/db` type-check again** after 15c.1 (`satisfies Record<PermissionKey,
  string>`). `pnpm db:migrate` writes them into the `permissions` table, so no migration is needed for them.

### Migration 0029 (generated — then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name invoices-receipts`. As in every step since 9, `drizzle-kit` writes the
foreign keys before the unique indexes they point at (`delivery_lines_tenant_id_idx`, `invoices_customer_id_idx`,
`receipts_customer_id_idx`), and the migration fails with "there is no unique constraint matching given keys". Move
every `CREATE INDEX` and `CREATE UNIQUE INDEX` up, before the first `ADD CONSTRAINT … FOREIGN KEY`. The result:

```sql
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_type" text NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"invoice_id" uuid NOT NULL,
	"delivery_line_id" uuid,
	"order_line_id" uuid,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "invoice_lines_quantity_check" CHECK ("invoice_lines"."quantity" > 0 AND "invoice_lines"."factor" > 0 AND "invoice_lines"."base_quantity" > 0),
	CONSTRAINT "invoice_lines_amounts_check" CHECK ("invoice_lines"."unit_price" >= 0 AND "invoice_lines"."discount" >= 0 AND ("invoice_lines"."discount_type" = 'amount' OR "invoice_lines"."discount" <= 100) AND "invoice_lines"."net" >= 0 AND "invoice_lines"."vat" >= 0 AND "invoice_lines"."total" = "invoice_lines"."net" + "invoice_lines"."vat"),
	CONSTRAINT "invoice_lines_tax_rate_check" CHECK ("invoice_lines"."tax_rate" >= 0 AND "invoice_lines"."tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
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
	"due_date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_reference" text,
	"branch_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"billing_address" text,
	"prices_include_vat" boolean NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(19, 4) DEFAULT '0' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "invoices_posted_check" CHECK (("invoices"."status" = 'posted') = ("invoices"."number" IS NOT NULL AND "invoices"."posted_at" IS NOT NULL)),
	CONSTRAINT "invoices_due_date_check" CHECK ("invoices"."due_date" >= "invoices"."date"),
	CONSTRAINT "invoices_totals_check" CHECK ("invoices"."discount" >= 0 AND "invoices"."net" >= 0 AND "invoices"."vat" >= 0 AND "invoices"."total" = "invoices"."net" + "invoices"."vat"),
	CONSTRAINT "invoices_paid_check" CHECK ("invoices"."amount_paid" >= 0 AND "invoices"."amount_paid" <= "invoices"."total" AND ("invoices"."status" = 'posted' OR "invoices"."amount_paid" = 0))
);
--> statement-breakpoint
CREATE TABLE "receipt_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "receipt_allocations_amount_check" CHECK ("receipt_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
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
	"customer_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"applied" numeric(19, 4) DEFAULT '0' NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"branch_id" uuid NOT NULL,
	"note" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_date" date,
	"void_reason" text,
	CONSTRAINT "receipts_amount_check" CHECK ("receipts"."amount" > 0 AND "receipts"."applied" >= 0 AND "receipts"."applied" <= "receipts"."amount"),
	CONSTRAINT "receipts_void_check" CHECK (("receipts"."status" = 'voided') = ("receipts"."void_date" IS NOT NULL AND "receipts"."void_reason" IS NOT NULL) AND ("receipts"."status" = 'posted' OR "receipts"."applied" = 0) AND ("receipts"."void_date" IS NULL OR "receipts"."void_date" >= "receipts"."date"))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "holds_money" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD COLUMN "invoiced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "invoiced_quantity" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_line_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "invoice_lines_variant_idx" ON "invoice_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_delivery_line_idx" ON "invoice_lines" USING btree ("tenant_id","delivery_line_id") WHERE "invoice_lines"."delivery_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoice_lines_order_line_idx" ON "invoice_lines" USING btree ("tenant_id","order_line_id") WHERE "invoice_lines"."order_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_id_idx" ON "invoices" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("tenant_id","customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_idx" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "invoices_tenant_date_idx" ON "invoices" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "invoices_open_customer_idx" ON "invoices" USING btree ("tenant_id","customer_id","due_date","id") WHERE "invoices"."status" = 'posted' AND "invoices"."amount_paid" < "invoices"."total";--> statement-breakpoint
CREATE INDEX "invoices_open_due_idx" ON "invoices" USING btree ("tenant_id","due_date","id") WHERE "invoices"."status" = 'posted' AND "invoices"."amount_paid" < "invoices"."total";--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_allocations_pair_idx" ON "receipt_allocations" USING btree ("tenant_id","receipt_id","invoice_id");--> statement-breakpoint
CREATE INDEX "receipt_allocations_invoice_idx" ON "receipt_allocations" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_tenant_id_idx" ON "receipts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_customer_id_idx" ON "receipts" USING btree ("tenant_id","customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_tenant_number_idx" ON "receipts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "receipts_tenant_date_idx" ON "receipts" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "receipts_customer_idx" ON "receipts" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "receipts_unapplied_idx" ON "receipts" USING btree ("tenant_id","customer_id","date","id") WHERE "receipts"."status" = 'posted' AND "receipts"."applied" < "receipts"."amount";--> statement-breakpoint
CREATE INDEX "receipts_account_idx" ON "receipts" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_lines_tenant_id_idx" ON "delivery_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "delivery_lines_to_invoice_idx" ON "delivery_lines" USING btree ("tenant_id","delivery_id") WHERE NOT "delivery_lines"."invoiced";--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_delivery_line_fk" FOREIGN KEY ("tenant_id","delivery_line_id") REFERENCES "public"."delivery_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."sales_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_receipt_fk" FOREIGN KEY ("tenant_id","customer_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_invoice_fk" FOREIGN KEY ("tenant_id","customer_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_money_type" CHECK (NOT "ledger_accounts"."holds_money" OR "ledger_accounts"."type" = 'asset');--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_invoiced_check" CHECK ("sales_order_lines"."invoiced_quantity" BETWEEN 0 AND "sales_order_lines"."base_quantity");
```

- **Four new tables, three new columns, one changed constraint.** The new columns have constant defaults, so no
  existing row is rewritten, and the guards of 0028 do not fire (adding a column is not an `UPDATE`).
- The snapshot (`meta/0029_snapshot.json`) and `_journal.json` are written by `drizzle-kit`; commit them as they are.

### Migration 0030 (custom): RLS, what may change when, the sums, the money accounts

Run `pnpm --filter @omnivo/db generate --custom --name invoices-receipts-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['invoices', 'invoice_lines', 'receipts', 'receipt_allocations'])
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

-- 2) A draft invoice is changed and deleted freely. A posted one was sent to the customer and is in
--    the books: it is never deleted, and the only thing that moves is amount_paid (section 4's
--    trigger, when a receipt is applied or voided). 15d's credit note corrects a posted invoice
--    with a document of its own, not by changing this one.
CREATE FUNCTION invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - 'amount_paid' = to_jsonb(OLD) - 'amount_paid' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invoice % is posted and cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_posted_immutable';
END $$;

CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- The lines: only while the invoice is a draft, like a delivery's lines (0028). So posting writes
-- the lines first (a line of its own gets the challan line its posting made) and only then sets
-- the invoice to posted. When a draft is deleted its lines cascade; the header is gone by then,
-- so the lookup finds nothing and lets them go.
CREATE FUNCTION invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM invoices
         WHERE tenant_id = OLD.tenant_id AND id = OLD.invoice_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM invoices
         WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted invoice cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();

-- 3) A receipt is never deleted: its number is printed on the customer's copy. While posted, two
--    things may happen to it: its money is applied again (applied moves; the API bumps the
--    version), or it is voided (status, the void date and reason, and applied, which section 4
--    has brought to zero first). A voided receipt never changes again.
CREATE FUNCTION receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND (
       (NEW.status = 'posted'
        AND to_jsonb(NEW) - ARRAY['applied', 'version', 'updated_at', 'updated_by']
            = to_jsonb(OLD) - ARRAY['applied', 'version', 'updated_at', 'updated_by'])
       OR (NEW.status = 'voided'
        AND to_jsonb(NEW) - ARRAY['status', 'applied', 'void_date', 'void_reason', 'version',
                                  'updated_at', 'updated_by']
            = to_jsonb(OLD) - ARRAY['status', 'applied', 'void_date', 'void_reason', 'version',
                                    'updated_at', 'updated_by'])) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'receipt % can only have its money applied or be voided', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'receipts_immutable';
END $$;

CREATE TRIGGER receipts_guard
  BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_guard();

-- 4) invoices.amount_paid and receipts.applied are the sums of the allocations, kept here and
--    nowhere else, like stock_balances by stock_movements (0022). The API only inserts and deletes
--    allocations; the two sums follow in the same statement. The table checks then refuse what
--    must not happen, under every path that writes:
--    - paying an invoice past its total, or a draft at all (invoices_paid_check);
--    - applying more than the receipt brought, or anything of a voided one (receipts_amount_check,
--      receipts_void_check, and section 3's guard).
--    The UPDATE locks the invoice row, so two receipts paying the last ৳5,000 of one invoice at the
--    same moment run one after the other here, and the second one fails on the check.
CREATE FUNCTION receipt_allocations_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE invoices SET amount_paid = amount_paid - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.invoice_id;
    UPDATE receipts SET applied = applied - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.receipt_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE invoices SET amount_paid = amount_paid + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
    UPDATE receipts SET applied = applied + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER receipt_allocations_apply
  AFTER INSERT OR UPDATE OR DELETE ON receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION receipt_allocations_apply();

-- 5) 0028's order line guard, with what invoices write. While the order is confirmed a line may
--    have its delivered AND invoiced quantities changed; once delivered or closed, its invoiced
--    quantity only (the challans of a delivered order are still billed). A cancelled order stays
--    frozen. A draft order's lines stay free, except a line that was invoiced: an order reopened
--    after an invoice billed it cannot have the billed line rewritten under the invoice.
CREATE OR REPLACE FUNCTION sales_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status
      FROM sales_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
    -- NULL: no such order — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines cannot be added to a sales order that is not a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM sales_orders WHERE tenant_id = OLD.tenant_id AND id = OLD.order_id;
  IF v_status IS NULL OR (v_status = 'draft' AND OLD.invoiced_quantity = 0) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND v_status = 'confirmed'
     AND to_jsonb(NEW) - ARRAY['delivered_quantity', 'invoiced_quantity']
         = to_jsonb(OLD) - ARRAY['delivered_quantity', 'invoiced_quantity'] THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND v_status IN ('delivered', 'closed')
     AND to_jsonb(NEW) - 'invoiced_quantity' = to_jsonb(OLD) - 'invoiced_quantity' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a confirmed sales order cannot be changed, except what was delivered and invoiced'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
END $$;

-- 6) 0028's delivery line guard, with one change allowed on a posted challan: a line becomes
--    invoiced, false → true, with nothing else. Never back, and never twice: a second invoice that
--    tries to bill the same line fails here, even if two are posted at the same moment.
CREATE OR REPLACE FUNCTION delivery_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT OLD.invoiced AND NEW.invoiced
     AND to_jsonb(NEW) - 'invoiced' = to_jsonb(OLD) - 'invoiced' THEN
    RETURN NEW;
  END IF;
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = OLD.tenant_id AND id = OLD.delivery_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = NEW.tenant_id AND id = NEW.delivery_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted delivery cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'delivery_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

-- 7) The money accounts of the workspaces that already exist: what the template (15c.3) flags in a
--    new one. Cash in hand by its purpose (it may have been renamed or renumbered); the bank and
--    wallet groups by their template codes, as groups of assets only. A company that moved its
--    banks elsewhere ticks its own groups on the account form. FORCE RLS applies to this
--    migration's role too, so each workspace is updated with its own app.tenant_id, like 0026.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE ledger_accounts
       SET holds_money = true
     WHERE tenant_id = t
       AND type = 'asset'
       AND (purpose = 'cash' OR (is_group AND code IN ('1120', '1130')));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

Part by part:

1. **RLS on the four new tables**, exactly like 0022, 0024, 0026 and 0028. The tenant-leak suite's RLS coverage
   test fails if a table with a `tenant_id` lacks `FORCE ROW LEVEL SECURITY`.
2. **The invoice guard.** A draft is free: edit, delete. A posted invoice was sent and is in the books, so only
   `amount_paid` may change, and only section 4's trigger changes it.
   - **`to_jsonb(NEW) - 'amount_paid' = to_jsonb(OLD) - 'amount_paid'`** compares the whole row except that one
     column, the way 0028's guards do. A column added in a later step is frozen by default.
   - **No version bump when money is applied.** The version guards a person's edit against another person's edit. A
     posted invoice has no edit form, so a payment that bumped it would only make the invoice page's next refresh
     look like a conflict.
   - **The line guard** is 0028's delivery line guard with the invoice's names. It sets an order of writes for
     15c.3: posting writes the lines first (a goods line of its own gets the challan line its posting made), and
     sets the invoice to posted last. In the other order, the line guard sees a posted invoice and refuses.
3. **The receipt guard.** A receipt is never deleted: the customer holds a paper with its number. While posted it
   may do one of two things:
   - **have its money applied again**: `applied` moves (by section 4), and the API bumps `version`, because a
     person's allocation edit can race another person's;
   - **be voided**: `status`, `void_date`, `void_reason` (and `applied`, already zero) change, nothing else.
   A voided receipt never changes again, which also means no money can be applied from it: section 4's update of
   `applied` would hit this guard.
4. **The allocation trigger** keeps `invoices.amount_paid` and `receipts.applied` equal to the sums of the
   allocations. It is the same idea as step 13's `stock_movements_apply`, which keeps `stock_balances`.
   - **`AFTER` the row is written, on insert, update and delete.** An update is handled as "take the old row off,
     put the new row on", so even an allocation moved to another invoice keeps both invoices right. 15c.3 only
     inserts and deletes, but the trigger does not depend on that.
   - **It checks nothing itself.** The `UPDATE`s it runs meet the table checks and guards from above: an
     invoice paid past its total or a draft paid at all fails `invoices_paid_check`; a receipt applied past its
     amount fails `receipts_amount_check`; a voided receipt fails its guard. One rule, one place.
   - **Two receipts at the same moment.** The `UPDATE invoices` takes a lock on the invoice row. A second receipt
     that pays the same invoice waits for the first one's transaction to end, then sees its `amount_paid` and fails
     the check if the two together are too much. We tried this with two sessions and two ৳4,500 receipts on a
     ৳5,000 invoice: the second waited, then failed on `invoices_paid_check`, and the invoice stayed at ৳4,500 paid.
   - **Deadlocks.** Two receipts that pay the same two invoices in a different order could each hold one lock and
     wait for the other. 15c.3 avoids this by locking the invoices it pays in id order before writing (`FOR UPDATE
     … ORDER BY id`), the rule step 14's stock posting follows for its value and balance rows.
5. **The order line guard, again.** `CREATE OR REPLACE` swaps 0028's function; the trigger stays.
   - **Confirmed:** the delivered and the invoiced quantity may change (a challan posted, an invoice posted).
   - **Delivered or closed:** only the invoiced quantity. The challans of a delivered order are still billed after it
     is delivered, often days later.
   - **Cancelled:** frozen. An order with an invoiced line is not cancelled (15c.3 checks that first).
   - **Draft:** free, except a line that was already invoiced. An order is reopened to change it (15b), and a line an
     invoice billed must not change under the invoice. 15c.3 checks this first and answers with a readable error;
     the guard keeps it true whatever the code does. The error keeps 0028's constraint name, so the API's error mapping
     from 15b still applies.
6. **The delivery line guard, again.** One change is allowed on a posted challan: a line goes from not invoiced to
   invoiced, with nothing else changing. True to true is refused too. So when two invoices try to bill the same
   challan line, the second one fails here even if both passed the API's check at the same moment.
7. **The money accounts of existing workspaces.** New workspaces get the flags from the template (15c.3).
   - **Cash in hand by its purpose (`cash`), not its code.** The purpose is how the system knows the account; the
     company may have renumbered it.
   - **The bank and wallet groups by their template codes (1120, 1130)**, and only as groups of assets. A workspace
     whose 1120 is something else (we tried a liability group) is left alone. A company that moved its banks
     elsewhere ticks its own group on the account form.
   - **`set_config('app.tenant_id', …)` per workspace.** `FORCE ROW LEVEL SECURITY` applies to the migration's own
     role too, so without it the `UPDATE` would see no rows and change nothing, without any error. 0026 does the
     same for its outbox events. We ran this block as `omnivo_migrator` to be sure.

> **What we checked.** On a throwaway database with every migration up to 0030, as `omnivo_app`: a draft invoice
> was written, changed and deleted with its lines. A due date before the invoice date, a total that is not net + VAT,
> a paid draft, and a number with a posting time on a draft all failed on their own constraints. Posting marked a
> challan line invoiced and added to the order lines' invoiced quantities. A posted invoice then refused edits,
> going back to draft, deletion, and edits or deletion of its lines. A challan line refused being invoiced twice,
> going back to not invoiced, and a quantity change together with the flag; a second invoice that billed the same
> line could be saved as a draft but not posted. An order line refused an invoiced quantity above the ordered one.
> A delivered order's line accepted a new invoiced quantity and refused a new delivered one. A reopened order
> refused changes to and deletion of its invoiced line, and accepted changes to its other line. Deleting an order
> line that a draft invoice bills failed on `invoice_lines_order_line_fk`. A receipt of ৳0 and a second MR number
> failed. Allocations added to `amount_paid` and `applied`; paying past an invoice's total, applying past a
> receipt's amount, paying a draft invoice, paying another customer's invoice (both ways), and the same pair twice
> all failed. Moving an allocation to another invoice moved the paid amounts with it. A receipt refused edits and
> deletion; voiding it refused while money was applied, before its own date, without a reason, or with another
> change, and worked after its allocations were deleted; after that it took no money and could not go back. Two
> receipts paying the same invoice at once: the second waited and failed. A `sales_invoice` journal entry without a
> document failed. Deleting a customer with an invoice and an account with a receipt failed on their FKs. Another
> workspace saw none of the rows and could neither write into the first nor change it. Section 7 flagged 1110, 1120
> and 1130 and nothing else, also when run as `omnivo_migrator`. `drizzle-kit generate` then reports no schema
> changes.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm lint
```

`pnpm typecheck` for the whole repo still fails, as expected after 15c.1: the API must send the new fields and serve
the new routes (15c.3), `packages/i18n` needs the new keys (15c.5), and the app's account form and mocks need the new
fields (15c.6, 15c.7). The `packages/db` error from 15c.1 (the permission descriptions) is gone.

Then run `pnpm db:migrate` against your dev database. It applies 0029 and 0030, flags your money accounts, and
writes the three permissions.

## 15c.3 — `apps/api`: invoices, money receipts and the credit limit

The contract and the tables are ready; this part writes the server. Four new files in `apps/api/src/sales/` hold
the new work: `sales-books.service.ts` writes the invoice's and the receipt's journal entries,
`credit.service.ts` works out what a customer owes and checks the limit, and one service each for invoices and
receipts. Existing files change where 15c touches them: the delivery learns which of its lines are billed and can
be made by an invoice, the order counts what is billed and checks the credit limit when it is confirmed, the
account form gets "holds money", the journal's Reverse refuses the two new sources, and the controllers and the
module serve the new routes.

The design follows step 15b on purpose. An invoice is written and posted like a challan: a draft is changed
freely, and "Post" checks everything again under locks and does the whole posting in one transaction.
`SalesBooksService` is to the sales documents what step 14's `StockBooksService` is to the stock documents: the
document builds the amounts, the books service builds the entry and posts it through the journal's
`PostingService`. If you know how a challan is posted, most of an invoice will look familiar.

### `sales/sales-lines.ts`: the branch, the billing address, and archived items

```diff
@@ -11,8 +11,8 @@ import {
   type TaxRateKind,
   toBaseQuantity,
 } from '@omnivo/contracts';
-import { parties, partyAddresses, taxRates, tenantSettings } from '@omnivo/db';
-import { and, eq, inArray } from 'drizzle-orm';
+import { branches, parties, partyAddresses, taxRates, tenantSettings } from '@omnivo/db';
+import { and, eq, inArray, isNull } from 'drizzle-orm';
 
 import { AppError } from '../common/http/app-error.js';
 import { getTenantId } from '../common/tenant/tenant-context.js';
@@ -63,8 +63,15 @@ export async function assertCustomer(
   return { id: row.id, code: row.code, name: row.name };
 }
 
-// An address of this customer, and its text as the document keeps it: the label, the address and
-// the phone on their own lines, the way a challan prints them. null = no address chosen.
+// An address as a document keeps it: the label, the address and the phone on their own lines, the
+// way a challan or an invoice prints them
+function addressText(row: { label: string | null; address: string; phone: string | null }): string {
+  return [row.label, row.address, row.phone]
+    .filter((part): part is string => part !== null)
+    .join('\n');
+}
+
+// An address of this customer, and its text as the document keeps it. null = no address chosen.
 export async function shippingAddressOf(
   tx: Transaction,
   customerId: string,
@@ -92,10 +99,50 @@ export async function shippingAddressOf(
       'Pick one of this customer’s addresses.',
     );
   }
-  const text = [row.label, row.address, row.phone]
-    .filter((part): part is string => part !== null)
-    .join('\n');
-  return { id: addressId, text };
+  return { id: addressId, text: addressText(row) };
+}
+
+// The customer's billing address (one at most, step 15a) as an invoice keeps it (step 15c). The
+// invoice copies the text when it is saved: what was sent to the customer must print the same
+// after the customer moves. null = the customer has none.
+export async function billingAddressOf(
+  tx: Transaction,
+  customerId: string,
+): Promise<string | null> {
+  const [row] = await tx
+    .select({
+      label: partyAddresses.label,
+      address: partyAddresses.address,
+      phone: partyAddresses.phone,
+    })
+    .from(partyAddresses)
+    .where(
+      and(
+        eq(partyAddresses.tenantId, getTenantId()),
+        eq(partyAddresses.partyId, customerId),
+        eq(partyAddresses.kind, 'billing'),
+      ),
+    );
+  return row === undefined ? null : addressText(row);
+}
+
+// The branch an invoice or a receipt belongs to (step 15c): an active branch of this workspace.
+// Checked here, under the form's own field, before the journal would refuse it as
+// journal_branch_invalid under a line the person never saw. FOR SHARE: nobody archives it before we
+// commit.
+export async function assertBranch(tx: Transaction, branchId: string): Promise<void> {
+  const [row] = await tx
+    .select({ id: branches.id })
+    .from(branches)
+    .where(
+      and(
+        eq(branches.tenantId, getTenantId()),
+        eq(branches.id, branchId),
+        isNull(branches.archivedAt),
+      ),
+    )
+    .for('share');
+  if (!row) throw fieldError('sales_branch_invalid', 'branchId', 'Pick an active branch.');
 }
 
 // The workspace setting now (step 15a). A new document copies it and keeps its copy: when the owner
@@ -149,13 +196,16 @@ export interface ResolvedSalesLine {
 // Every rule of a sales line the contract cannot check: the variant is an active product or
 // service of this workspace, the unit is its base unit or one of its packs, the quantity fits the
 // unit, and the VAT rate is an active one. keptRateIds: the rates the document's lines already use;
-// they stay usable after the rate is archived, so an old draft can still be saved. All problems
-// come back at once, each under its own field, like resolveLines() of the stock documents.
+// they stay usable after the rate is archived, so an old draft can still be saved. keptVariantIds
+// (step 15c): items that stay usable after they are archived — an invoice bills goods that already
+// left on a challan, whatever happened to the product since. All problems come back at once, each
+// under its own field, like resolveLines() of the stock documents.
 export async function resolveSalesLines(
   tx: Transaction,
   lines: readonly SalesLineInput[],
   pricesIncludeVat: boolean,
   keptRateIds: ReadonlySet<string> = new Set(),
+  keptVariantIds: ReadonlySet<string> = new Set(),
 ): Promise<ResolvedSalesLine[]> {
   const variants = await loadVariants(
     tx,
@@ -183,7 +233,7 @@ export async function resolveSalesLines(
     // Unknown, another workspace's or archived: the same answer. A service is fine here: it is
     // sold, just never delivered.
     const variant = variants.get(line.variantId);
-    if (variant === undefined || variant.archived) {
+    if (variant === undefined || (variant.archived && !keptVariantIds.has(variant.variantId))) {
       at('variantId', 'sales_item_invalid');
       return;
     }
@@ -238,7 +288,7 @@ export async function resolveSalesLines(
   return resolved;
 }
 
-// The columns a quotation line and an order line share, for an insert
+// The columns every sales line shares (quotation, order, invoice), for an insert
 export function salesLineValues(line: ResolvedSalesLine, index: number) {
   return {
     tenantId: getTenantId(),
```

- **`addressText()`** is the old body of `shippingAddressOf()`, moved out so `billingAddressOf()` can use it too.
  A challan and an invoice print an address the same way: the label, the address and the phone on their own lines.
- **`billingAddressOf()`** returns the customer's billing address as text, or `null`. There is at most one per
  customer (the partial unique index of step 15a), so the query needs no `ORDER BY`. The invoice keeps the
  *text*, not the id (15c.2): an invoice that was sent to the customer must print the same address after the
  customer moves.
- **`assertBranch()`** checks the invoice's or the receipt's branch. Without it, an archived branch would only be
  refused deep inside the journal, as `journal_branch_invalid` under `lines.0.branchId`, a field the person never
  saw. Here it is `sales_branch_invalid` under `branchId`, the box the person can fix. `FOR SHARE`, like the
  customer: an archive of the branch waits until we commit.
- **`keptVariantIds`**, a fifth parameter next to `keptRateIds`. 15b refuses an archived product on every sales
  line ("we do not sell this any more"). An invoice line that bills a challan line is different: the goods
  already left, and the bill must go out even if the product was archived the next day. The invoice passes the
  items of its challan and order lines here, and nothing else, so a line of its own still follows 15b's rule.
  Quotations and orders do not pass it, so nothing changes for them.

### `sales/sales-books.service.ts` (new): the entries of an invoice and a receipt

```ts
import { Injectable } from '@nestjs/common';
import { type EntryRef, isZeroMoney, type SalesJournalSource } from '@omnivo/contracts';
import { journalEntries, journalLines, ledgerAccounts } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { type LineInput, PostingService } from '../journal/posting.service.js';

// A posted document, as its entry names it
interface DocumentRef {
  id: string;
  number: string;
  date: string;
}

// The accounts the sales documents post to, found by their purpose: every chart has exactly one of
// each (templates.spec.ts), and an account with a purpose can be neither archived nor deleted
// (AccountsService → locked). So only a workspace whose chart the setup job has not made yet can
// miss one, and nobody can write an invoice there: a plain error is enough.
interface Accounts {
  receivable: string;
  sales: string;
  vatOutput: string;
}

// One debit or one credit, on a line without a description
function debit(accountId: string, branchId: string, partyId: string | null, amount: string) {
  return { accountId, branchId, partyId, description: null, debit: amount, credit: '0' };
}

function credit(accountId: string, branchId: string, partyId: string | null, amount: string) {
  return { accountId, branchId, partyId, description: null, debit: '0', credit: amount };
}

// The journal half of the sales documents (step 15c), like StockBooksService for the stock
// documents: it builds the entry and posts it through the journal's PostingService, inside the
// document's own transaction, so the document and the books change together or not at all.
// The receivable line always names the customer (the party rule of step 15a): that is what makes
// the customer's balance, statement and credit check add up.
@Injectable()
export class SalesBooksService {
  constructor(private readonly posting: PostingService) {}

  // An invoice: Dr Accounts receivable (the customer) for the total / Cr Sales for the net / Cr
  // Output VAT for the VAT — every line with the invoice's branch, so the profit and loss by branch
  // shows the sale where it was made. The cost of the goods is not here: the challan booked it
  // (15b). An invoice of ৳0 (a free sample) has no entry: there is nothing to owe.
  async invoice(
    tx: Transaction,
    document: DocumentRef,
    input: { customerId: string; branchId: string; net: string; vat: string; total: string },
  ): Promise<EntryRef | null> {
    if (isZeroMoney(input.total)) return null;
    const accounts = await this.accounts(tx);
    const lines: LineInput[] = [
      debit(accounts.receivable, input.branchId, input.customerId, input.total),
      credit(accounts.sales, input.branchId, null, input.net),
      credit(accounts.vatOutput, input.branchId, null, input.vat),
    ];
    // A line of ৳0 says nothing: an exempt sale has no VAT line
    return this.write(
      tx,
      document,
      'sales_invoice',
      `Invoice ${document.number}`,
      lines.filter((line) => !isZeroMoney(line.debit) || !isZeroMoney(line.credit)),
    );
  }

  // A money receipt: Dr the cash, bank or wallet account / Cr Accounts receivable (the customer),
  // both with the receipt's branch. The receivable comes down whether or not the money is applied
  // to an invoice: what the customer owes is the books' number, not the invoices'.
  async receipt(
    tx: Transaction,
    document: DocumentRef,
    input: { customerId: string; branchId: string; accountId: string; amount: string },
  ): Promise<EntryRef> {
    const accounts = await this.accounts(tx);
    return this.write(tx, document, 'sales_receipt', `Money receipt ${document.number}`, [
      debit(input.accountId, input.branchId, null, input.amount),
      credit(accounts.receivable, input.branchId, input.customerId, input.amount),
    ]);
  }

  // A voided receipt: the journal's own reversal of its entry (source 'reversal', pointing back at
  // it), dated the day the money turned out not to be there. The same lines with debit and credit
  // swapped, each keeping its branch and customer, so the receivable goes back up on the same
  // customer. The unique index on reversal_of_id lets an entry be reversed once, whatever happens.
  async reverse(
    tx: Transaction,
    entry: EntryRef,
    input: { date: string; narration: string },
  ): Promise<EntryRef> {
    const lines = await tx
      .select({
        accountId: journalLines.accountId,
        branchId: journalLines.branchId,
        partyId: journalLines.partyId,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, entry.id)))
      .orderBy(asc(journalLines.lineNo));
    const posted = await this.posting.postNew(tx, {
      date: input.date,
      narration: input.narration,
      source: 'reversal',
      reversalOfId: entry.id,
      lines: lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
    });
    return toRef(posted);
  }

  // The posted entry a document made with this source: an invoice and a receipt make one each
  async entryOf(
    tx: Transaction,
    documentId: string,
    source: SalesJournalSource,
  ): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, getTenantId()),
          eq(journalEntries.documentId, documentId),
          eq(journalEntries.source, source),
          eq(journalEntries.status, 'posted'),
        ),
      );
    return row === undefined ? null : postedRef(row);
  }

  // The reversal of an entry, if it has one (a voided receipt's)
  async reversalOf(tx: Transaction, entryId: string): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.reversalOfId, entryId)),
      );
    return row === undefined ? null : postedRef(row);
  }

  private async write(
    tx: Transaction,
    document: DocumentRef,
    source: SalesJournalSource,
    narration: string,
    lines: readonly LineInput[],
  ): Promise<EntryRef> {
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration,
      source,
      document: { id: document.id, number: document.number },
      lines,
    });
    return toRef(entry);
  }

  // FOR SHARE, like the stock accounts: nobody changes them before we commit, while other postings
  // to the same accounts go on in parallel
  private async accounts(tx: Transaction): Promise<Accounts> {
    const rows = await tx
      .select({ id: ledgerAccounts.id, purpose: ledgerAccounts.purpose })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, getTenantId()),
          inArray(ledgerAccounts.purpose, ['accounts_receivable', 'sales', 'vat_output']),
        ),
      )
      .for('share');
    const idOf = (purpose: string): string => {
      const id = rows.find((row) => row.purpose === purpose)?.id;
      if (id === undefined) throw new Error(`No account has the ${purpose} purpose yet`);
      return id;
    };
    return {
      receivable: idOf('accounts_receivable'),
      sales: idOf('sales'),
      vatOutput: idOf('vat_output'),
    };
  }
}

// A found entry as a reference; null if it has no number (only a draft has none)
function postedRef(entry: { id: string; number: string | null }): EntryRef | null {
  return entry.number === null ? null : { id: entry.id, number: entry.number };
}

function toRef(entry: { id: string; number: string | null }): EntryRef {
  if (entry.number === null) throw new Error('A posted entry has no number');
  return { id: entry.id, number: entry.number };
}
```

- **Accounts by purpose.** The receivable, sales and output VAT accounts each have a purpose (step 9), every
  template has exactly one of each (`templates.spec.ts`), and an account with a purpose can be neither archived
  nor deleted (`account_locked`). So the only way to miss one is a workspace whose chart the setup job has not
  made yet, where nobody can write an invoice anyway. A plain `Error` (a 500) is enough; there is no error code for
  something a person cannot cause.
- **`FOR SHARE` on the three accounts**, the same lock `StockBooksService` takes. Many invoices post to the same
  sales account at the same time; a share lock lets them all go ahead, and only an archive or a delete (which
  takes `FOR UPDATE`) has to wait.
- **The invoice's entry.** Dr Accounts receivable for the total, with the customer on the line (the party rule of
  step 15a: this is what makes the customer's balance and statement add up). Cr Sales for the net, Cr Output VAT
  for the VAT. Every line carries the invoice's branch, so the profit and loss by branch (step 11) shows the sale
  where it was made. The cost of the goods is not here: the challan booked it in 15b (Dr Cost of goods sold / Cr
  Inventory), and booking it again would count it twice.
- **Lines of ৳0 are left out.** An exempt sale has no VAT; a line of 0 / 0 would only clutter the journal. A whole
  invoice of ৳0 (a free sample) has no entry at all: `invoice()` returns `null`, and the invoice page shows no
  entry, as 15c.1 promised.
- **The receipt's entry.** Dr the money account / Cr Accounts receivable with the customer. The receivable comes
  down by the whole amount, even when none of it is applied to an invoice: what the customer owes is the books'
  number. Applying money to invoices only says *which* invoices are paid, so it never touches the journal.
- **`reverse()`** is the receipt's Void. It copies the entry's lines with debit and credit swapped, keeping each
  line's branch and customer, and posts them as source `'reversal'` with `reversalOfId`. This is the same thing
  the journal's own Reverse does, but the journal's Reverse now refuses sales entries (below), so the receipt
  needs its own way in. The unique index on `reversal_of_id` (step 10) still makes sure an entry is reversed once.
- **`entryOf()` names the source it expects.** The id alone would find the row; the source also makes sure it is
  the kind of entry the page shows (an invoice's, not some other document's), at no cost. It reads only posted
  entries: a document's entry is never a draft, but the filter says so in the query.
- **`postedRef()`** turns a row into an `EntryRef`, or `null` when there is no number. Only a draft has no number;
  the `null` keeps the type honest without a cast.

### `sales/credit.service.ts` (new): the credit limit

```ts
import { Inject, Injectable } from '@nestjs/common';
import { compareMoney, type CustomerCredit, subtractMoney, sumMoney } from '@omnivo/contracts';
import {
  journalEntries,
  journalLines,
  ledgerAccounts,
  parties,
  products,
  salesOrderLines,
  salesOrders,
} from '@omnivo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';

// What a confirmed order line will still bill, to the paisa: its total × the part not invoiced
// yet. A closed order bills only what it delivered (goods) or already billed (services): the rest
// will never come. A delivered order still bills every line in full. GREATEST: a line is never
// counted below zero.
const stillToBill = sql<string>`coalesce(sum(round(
  ${salesOrderLines.total} * greatest(
    CASE WHEN ${salesOrders.status} <> 'closed' THEN ${salesOrderLines.baseQuantity}
         WHEN ${products.type} = 'goods' THEN ${salesOrderLines.deliveredQuantity}
         ELSE ${salesOrderLines.invoicedQuantity} END
    - ${salesOrderLines.invoicedQuantity}, 0) / ${salesOrderLines.baseQuantity}, 2)), 0)::text`;

// The credit limit (step 15c, you chose this): checked when an order is confirmed and when an
// invoice is posted. What counts is the customer's exposure: what they owe now (the receivable
// lines with them, the same number as their balance) plus what confirmed orders will still bill.
// The same numbers go to the form's hint (GET /customers/:id/credit), so the hint and the block
// never disagree.
@Injectable()
export class CreditService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  // The route needs sales.customer.balance (the PermissionGuard checks it): the numbers say what
  // the customer owes
  get(customerId: string): Promise<CustomerCredit> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ limit: parties.creditLimit })
        .from(parties)
        .where(
          and(
            eq(parties.tenantId, getTenantId()),
            eq(parties.id, customerId),
            eq(parties.isCustomer, true),
          ),
        );
      if (!row) throw notFound('Customer');
      const { balance, onOrder } = await this.parts(tx, customerId);
      const exposure = sumMoney([balance, onOrder]);
      return {
        limit: row.limit,
        balance,
        onOrder,
        exposure,
        available: row.limit === null ? null : subtractMoney(row.limit, exposure),
      };
    });
  }

  // Before an order is confirmed or an invoice posted, inside its transaction: from here until
  // the commit, no other credit check of this customer runs, so two orders confirmed at the same
  // moment cannot each fit under the limit and together go over it. An advisory lock (a lock on a
  // number, released at commit by itself, like lockChart) instead of a lock on the customer row:
  // every sales document holds that row FOR SHARE (assertCustomer), and turning a share lock into
  // an update lock is how two writers deadlock. Taken after the document's own row locks, in every
  // caller, so two callers never wait for each other in a circle.
  // Returns the exposure now, before the change, for check().
  async lock(tx: Transaction, customerId: string): Promise<string> {
    const key = `credit:${getTenantId()}:${customerId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return this.exposure(tx, customerId);
  }

  // After the change is written: the exposure again, now with this document in it. Refused only
  // when it is over the limit AND higher than before. An invoice that bills a confirmed order at
  // its price moves the amount from "on order" to "owed" and adds nothing: it was approved when
  // the order was confirmed, and is not asked again even if the limit was lowered since.
  // overrideCreditLimit: the person saw the amounts in a dialog and goes ahead; only with
  // sales.credit.override, and the audit log keeps a row of it.
  async check(
    tx: Transaction,
    input: {
      customerId: string;
      before: string;
      overrideCreditLimit: boolean;
      entityType: 'sales_order' | 'invoice';
      entityId: string;
    },
  ): Promise<void> {
    const [row] = await tx
      .select({ limit: parties.creditLimit })
      .from(parties)
      .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, input.customerId)));
    const limit = row?.limit ?? null;
    if (limit === null) return;
    const exposure = await this.exposure(tx, input.customerId);
    if (compareMoney(exposure, limit) <= 0 || compareMoney(exposure, input.before) <= 0) return;
    if (!input.overrideCreditLimit) {
      throw new AppError(
        409,
        'credit_limit_exceeded',
        `This takes the customer to ${exposure}, over the credit limit of ${limit}.`,
        { params: { limit, exposure } },
      );
    }
    const access = await this.permissions.ofCurrentUser();
    if (!access.permissions.includes('sales.credit.override')) {
      throw new AppError(
        403,
        'credit_override_forbidden',
        'Going over a credit limit needs the sales.credit.override permission.',
        { params: { permissions: 'sales.credit.override' } },
      );
    }
    // Next to the document's own "confirmed" or "posted" row: a filter on this action lists every
    // override in the workspace
    await audit(tx, {
      action: 'credit_limit.overridden',
      entityType: input.entityType,
      entityId: input.entityId,
      changes: created({ limit, exposure }),
    });
  }

  private async exposure(tx: Transaction, customerId: string): Promise<string> {
    const { balance, onOrder } = await this.parts(tx, customerId);
    return sumMoney([balance, onOrder]);
  }

  private async parts(
    tx: Transaction,
    customerId: string,
  ): Promise<{ balance: string; onOrder: string }> {
    const tenantId = getTenantId();
    // The customer's balance, as customers.service.ts works it out: the posted receivable lines
    // that name them (journal_lines_tenant_party_idx finds them)
    const [owed] = await tx
      .select({
        value: sql<string>`round(coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0), 4)::text`,
      })
      .from(journalLines)
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntries.tenantId, journalLines.tenantId),
          eq(journalEntries.id, journalLines.entryId),
        ),
      )
      .innerJoin(
        ledgerAccounts,
        and(
          eq(ledgerAccounts.tenantId, journalLines.tenantId),
          eq(ledgerAccounts.id, journalLines.accountId),
        ),
      )
      .where(
        and(
          eq(journalLines.tenantId, tenantId),
          eq(journalLines.partyId, customerId),
          eq(journalEntries.status, 'posted'),
          eq(ledgerAccounts.purpose, 'accounts_receivable'),
        ),
      );
    const [ordered] = await tx
      .select({ value: stillToBill })
      .from(salesOrderLines)
      .innerJoin(
        salesOrders,
        and(
          eq(salesOrders.tenantId, salesOrderLines.tenantId),
          eq(salesOrders.id, salesOrderLines.orderId),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.tenantId, salesOrderLines.tenantId),
          eq(products.id, salesOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(salesOrderLines.tenantId, tenantId),
          eq(salesOrders.customerId, customerId),
          inArray(salesOrders.status, ['confirmed', 'delivered', 'closed']),
        ),
      );
    return {
      balance: sumMoney([owed?.value ?? '0']),
      onOrder: sumMoney([ordered?.value ?? '0']),
    };
  }
}
```

- **What counts (`stillToBill`).** For each line of a confirmed, delivered or closed order: the line total × the
  part not billed yet ÷ the ordered quantity. A confirmed or delivered order still bills every line in full; a
  closed order bills only what it delivered (goods) or already billed (services), because the rest will never
  come. `greatest(…, 0)` keeps a line from counting below zero. `round(…, 2)` rounds each line to the paisa, the
  way an invoice would bill it.
- **Why the balance query is repeated here.** `customers.service.ts` has the same balance as a correlated subquery
  for its list. The credit check needs it for one customer inside another transaction, and reusing a subquery
  written for a `SELECT … FROM parties` would need a join only to feed it. Both sum the posted receivable lines
  with this customer, so they give the same number; the comment says so, for the next reader.
- **`get()`**: the route already needs `sales.customer.balance` (the contract's `permission`), because the numbers
  say what the customer owes. An unknown customer, a supplier (step 17) and another workspace's customer are all a
  404, like every other read.
- **`lock()` takes an advisory lock per customer** and returns the exposure *before* the change. Without a lock,
  two orders confirmed at the same moment would each see the other's order as not there yet, each fit under the
  limit, and together go over it. Locking the customer's row would also stop that, but every sales document holds
  that row `FOR SHARE` (`assertCustomer`), and two transactions that both turn a share lock into an update lock
  wait for each other forever (a deadlock). An advisory lock is a lock on a number, so it touches no row; the
  `_xact_` kind is released at commit or rollback by itself, like step 9's chart lock. Each caller takes it after
  its own row locks, never before, so an order and an invoice never wait for each other in a circle.
- **`check()` refuses only when the exposure is over the limit *and* higher than before.** An invoice that bills a
  confirmed order at the order's price moves the amount from "on order" to "owed": the total does not change. That
  amount was approved when the order was confirmed, and asking again would block the bill for goods that already
  left. A direct invoice, or an invoice priced above its order, does raise the exposure, and is checked.
- **`credit_limit_exceeded` carries `limit` and `exposure`** in `params`, so the form's dialog can show both
  amounts. The person then sends the same request with `overrideCreditLimit: true`.
- **The override needs the permission, checked here.** The route's permission is the document's
  (`sales.order.manage`, `sales.invoice.manage`); only this function knows that the limit was crossed. Without
  `sales.credit.override` it answers 403 `credit_override_forbidden`, with the same `params.permissions` shape the
  PermissionGuard uses for `permission_missing`. With it, an audit row `credit_limit.overridden` goes next to the
  document's own row, holding the limit and the exposure.
- **The permission is asked for only when it is needed.** `permissions.ofCurrentUser()` usually comes from the
  Redis cache, but there is no reason to ask on every save that stays under the limit.

### `sales/deliveries.service.ts`: billed lines, and the challan of a direct invoice

```diff
@@ -3,6 +3,8 @@ import {
   compareQuantity,
   type Delivery,
   type DeliveryInput,
+  type DeliveryInvoiceFilter,
+  type DeliveryInvoiceState,
   type DeliverySummary,
   type PartyRef,
   type StockDocumentStatus,
@@ -14,13 +16,15 @@ import {
 import {
   deliveries,
   deliveryLines,
+  invoiceLines,
+  invoices,
   parties,
   products,
   salesOrderLines,
   salesOrders,
   warehouses,
 } from '@omnivo/db';
-import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
+import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
@@ -58,6 +62,30 @@ const lineCount = sql<number>`(
    WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id
 )`;
 
+// Step 15c: does a line of it still wait for an invoice? (delivery_lines_to_invoice_idx)
+const lineToInvoice = sql`EXISTS (
+  SELECT 1 FROM delivery_lines l
+   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id AND NOT l.invoiced
+)`;
+const lineInvoiced = sql`EXISTS (
+  SELECT 1 FROM delivery_lines l
+   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id AND l.invoiced
+)`;
+
+// A draft is never invoiced: only posted lines can be billed
+const invoiceState = sql<DeliveryInvoiceState>`CASE
+  WHEN deliveries.status <> 'posted' OR NOT ${lineInvoiced} THEN 'not_invoiced'
+  WHEN ${lineToInvoice} THEN 'partly_invoiced'
+  ELSE 'invoiced' END`;
+
+// The list's invoice filter: posted, with a line still to bill (what the invoice form offers), or
+// with every line billed
+function invoiceFilter(filter: DeliveryInvoiceFilter | undefined): SQL | undefined {
+  if (filter === undefined) return undefined;
+  const lines = filter === 'to_invoice' ? lineToInvoice : sql`NOT ${lineToInvoice}`;
+  return and(eq(deliveries.status, 'posted'), lines);
+}
+
 function notDraft(): AppError {
   return new AppError(
     409,
@@ -71,6 +99,7 @@ function toSummary(
   customer: PartyRef,
   order: { id: string; number: string | null } | null,
   lines: number,
+  invoiced: DeliveryInvoiceState,
 ): DeliverySummary {
   return {
     id: row.id,
@@ -84,6 +113,7 @@ function toSummary(
     vehicle: row.vehicle,
     note: row.note,
     lineCount: lines,
+    invoiceState: invoiced,
     postedAt: row.postedAt?.toISOString() ?? null,
     version: row.version,
     updatedAt: row.updatedAt.toISOString(),
@@ -123,6 +153,7 @@ export class DeliveriesService {
     status?: StockDocumentStatus | undefined;
     customerId?: string | undefined;
     warehouseId?: string | undefined;
+    invoice?: DeliveryInvoiceFilter | undefined;
   }): Promise<{ items: DeliverySummary[]; nextCursor: string | null }> {
     const after = decodeCursor(query.cursor, cursorSchema);
     return this.withTenant(async (tx) => {
@@ -134,6 +165,7 @@ export class DeliveriesService {
           query.warehouseId === undefined
             ? undefined
             : eq(deliveries.warehouseId, query.warehouseId),
+          invoiceFilter(query.invoice),
           after === undefined
             ? undefined
             : sql`(${deliveries.date}, ${deliveries.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
@@ -143,7 +175,7 @@ export class DeliveriesService {
       const page = toPage(rows, query.limit, (last) => [last.delivery.date, last.delivery.id]);
       return {
         items: page.items.map((row) =>
-          toSummary(row.delivery, row.customer, row.order, row.lineCount),
+          toSummary(row.delivery, row.customer, row.order, row.lineCount, row.invoiceState),
         ),
         nextCursor: page.nextCursor,
       };
@@ -270,12 +302,58 @@ export class DeliveriesService {
     });
   }
 
+  // Step 15c: the challan a direct invoice makes for its own goods lines, posted in the invoice's
+  // transaction. It is an ordinary challan — numbered, in the stock ledger, with its cost of goods
+  // sold — so the stock, the books and the challan list need nothing new: the invoice only bills
+  // its lines. No order and no shipping address: the goods went over the counter, or the invoice
+  // says where. Returns its number and its line ids in the order of `lines`; the invoice points its
+  // lines at them, and marks them invoiced with the challan lines it bills. The line errors name
+  // this challan's lines (lines.0, lines.1 …): the caller renames them to its own.
+  async deliverForInvoice(
+    tx: Transaction,
+    input: {
+      customerId: string;
+      date: string;
+      warehouseId: string;
+      note: string;
+      lines: readonly LineInput[];
+    },
+  ): Promise<{ id: string; number: string; lineIds: string[] }> {
+    const customer = await this.customerOf(tx, input.customerId);
+    const lines = await resolveLines(tx, input.lines, 'out');
+    const orderLineIds = lines.map(() => null);
+    const [row] = await tx
+      .insert(deliveries)
+      .values({
+        tenantId: getTenantId(),
+        date: input.date,
+        customerId: input.customerId,
+        warehouseId: input.warehouseId,
+        note: input.note,
+        createdBy: currentPrincipal().userId,
+        updatedBy: currentPrincipal().userId,
+      })
+      .returning();
+    if (!row) throw new Error('Delivery insert returned no row');
+    await this.writeLines(tx, row.id, lines, orderLineIds);
+    await audit(tx, {
+      action: 'delivery.created',
+      entityType: 'delivery',
+      entityId: row.id,
+      changes: created(await this.snapshot(tx, row, customer, null, lines.length)),
+    });
+    const number = await this.postAndLog(tx, row);
+    // Posting wrote the lines again with their values, so their ids are new: read them now
+    const posted = await this.linesOf(tx, row.id);
+    return { id: row.id, number, lineIds: posted.map((line) => line.id) };
+  }
+
   // A draft out of the warehouse, like a stock adjustment "out": the date and the warehouse
   // checked, the lines checked again against their products and (for an order) against what the
   // order still has to deliver, the number taken, the stock moved at its average cost, and the
   // cost of goods sold booked — all in the caller's transaction, so a refused line leaves nothing
-  // posted and no number used.
-  private async postAndLog(tx: Transaction, draft: DeliveryRow): Promise<void> {
+  // posted and no number used. Returns the number (a direct invoice's challan needs it, step 15c).
+  private async postAndLog(tx: Transaction, draft: DeliveryRow): Promise<string> {
     await this.posting.assertDate(tx, draft.date);
     await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
     // Locked before anything moves: two deliveries of one order post one after the other, and the
@@ -330,6 +408,7 @@ export class DeliveriesService {
       entityId: draft.id,
       changes: created({ number, entry: entry?.number ?? null }),
     });
+    return number;
   }
 
   // The order of a delivery: this customer's, and confirmed (waiting for deliveries). FOR UPDATE,
@@ -536,6 +615,7 @@ export class DeliveriesService {
         customer: { id: parties.id, code: parties.code, name: parties.name },
         order: { id: salesOrders.id, number: salesOrders.number },
         lineCount,
+        invoiceState,
       })
       .from(deliveries)
       .innerJoin(
@@ -556,7 +636,7 @@ export class DeliveriesService {
     if (!found) throw notFound('Delivery');
     const { delivery: row } = found;
     const lines = await this.linesOf(tx, id);
-    const [canSee, entries, variants, batches] = await Promise.all([
+    const [canSee, entries, variants, batches, billedBy] = await Promise.all([
       this.access.canSee(),
       this.books.entriesOf(tx, id),
       loadVariants(
@@ -567,9 +647,13 @@ export class DeliveriesService {
         tx,
         lines.map((line) => line.batchId),
       ),
+      this.invoicesOf(
+        tx,
+        lines.map((line) => line.id),
+      ),
     ]);
     return {
-      ...toSummary(row, found.customer, found.order, found.lineCount),
+      ...toSummary(row, found.customer, found.order, found.lineCount, found.invoiceState),
       shippingAddressId: row.shippingAddressId,
       lines: lines.flatMap((line) => {
         const variant = variants.get(line.variantId);
@@ -585,13 +669,36 @@ export class DeliveriesService {
             orderLineId: line.orderLineId,
             // Worked out from the books: needs inventory.stock.value (step 14)
             value: canSee ? line.value : null,
+            invoiced: line.invoiced,
           },
         ];
       }),
       entry: entries[0] ?? null,
+      invoices: billedBy,
     };
   }
 
+  // The posted invoices that bill some of these lines, by number (step 15c). A draft invoice that
+  // names a line has claimed nothing yet, so it is not shown.
+  private async invoicesOf(tx: Transaction, lineIds: readonly string[]) {
+    if (lineIds.length === 0) return [];
+    return tx
+      .selectDistinct({ id: invoices.id, number: invoices.number })
+      .from(invoiceLines)
+      .innerJoin(
+        invoices,
+        and(eq(invoices.tenantId, invoiceLines.tenantId), eq(invoices.id, invoiceLines.invoiceId)),
+      )
+      .where(
+        and(
+          eq(invoiceLines.tenantId, getTenantId()),
+          inArray(invoiceLines.deliveryLineId, [...lineIds]),
+          eq(invoices.status, 'posted'),
+        ),
+      )
+      .orderBy(asc(invoices.number));
+  }
+
   private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
     const customer = (await customerRefs(tx, [customerId])).get(customerId);
     if (!customer) throw new Error(`Customer ${customerId} is missing`);
```

- **`invoiceState` is worked out in the list query**, from two `EXISTS` subqueries on the challan's lines: no line
  billed → `not_invoiced`, some → `partly_invoiced`, all → `invoiced`. A draft is always `not_invoiced`: only a
  posted line can be billed. The subqueries use `delivery_lines_to_invoice_idx` (15c.2) for the "not billed"
  half, so the list stays fast after years of challans.
- **`invoiceFilter()`.** `to_invoice` is what the invoice form asks for: posted challans with a line still to bill.
  `invoiced` is the opposite. Both require `posted`, so a draft never shows up in either.
- **`deliverForInvoice()`** is how a direct invoice delivers its own goods (you chose this). It is an ordinary
  challan in every way: numbered DC, in the stock ledger, with its cost of goods sold, and with its own
  `delivery.created` and `delivery.posted` audit rows. So the stock pages, the challan list and the books need
  nothing new. It has no order and no shipping address (the goods went over the counter, or the invoice says
  where), and its note says which invoice made it.
- **It returns the line ids after posting.** `postAndLog()` writes the lines again with their cost (the step 14
  pattern), so the ids the insert gave are gone by then. The invoice needs the final ids to point its lines at.
- **`postAndLog()` now returns the number.** The invoice does not need it (it reads the challan from its lines),
  but `deliverForInvoice()` returns it, and it costs one line.
- **The line errors keep this challan's numbering** (`lines.0`, `lines.1`). The invoice renames them to its own
  lines (`onInvoiceLines()`, below), because only the invoice knows which of its lines became the challan's.
- **`invoices` on the challan page** lists the posted invoices that bill any of its lines, with `selectDistinct`:
  one invoice usually bills many lines of one challan. A draft invoice that names a line is not listed: it has
  claimed nothing yet, and another invoice may still bill that line first.

### `sales/sales-orders.service.ts`: the credit check, and orders that are billed

```diff
@@ -10,6 +10,7 @@ import {
 } from '@omnivo/contracts';
 import {
   deliveries,
+  invoiceLines,
   parties,
   quotations,
   salesOrderLines,
@@ -27,6 +28,7 @@ import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { assertWarehousesActive } from '../inventory/stock-lines.js';
 import { NumberingService } from '../numbering/numbering.service.js';
+import { CreditService } from './credit.service.js';
 import {
   assertCustomer,
   customerRefs,
@@ -68,6 +70,14 @@ function notConfirmed(): AppError {
   return new AppError(409, 'order_not_confirmed', 'This order is not waiting for deliveries.');
 }
 
+function hasInvoices(): AppError {
+  return new AppError(
+    409,
+    'order_has_invoices',
+    'Invoices bill this order. Close it and write a new order instead.',
+  );
+}
+
 function toSummary(
   row: OrderRow,
   customer: PartyRef,
@@ -99,6 +109,7 @@ export class SalesOrdersService {
   constructor(
     @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
     private readonly numbering: NumberingService,
+    private readonly credit: CreditService,
   ) {}
 
   list(query: {
@@ -180,7 +191,7 @@ export class SalesOrdersService {
           quotation: quotation?.number ?? null,
         }),
       });
-      if (input.confirm) await this.confirmAndLog(tx, row);
+      if (input.confirm) await this.confirmAndLog(tx, row, input.overrideCreditLimit);
       return this.read(tx, row.id);
     });
   }
@@ -239,7 +250,7 @@ export class SalesOrdersService {
           await this.snapshot(tx, updated, customer, lines.length),
         ),
       });
-      if (input.confirm) await this.confirmAndLog(tx, updated);
+      if (input.confirm) await this.confirmAndLog(tx, updated, input.overrideCreditLimit);
       return this.read(tx, id);
     });
   }
@@ -279,16 +290,21 @@ export class SalesOrdersService {
     });
   }
 
-  confirm(id: string, version: number): Promise<SalesOrder> {
+  confirm(
+    id: string,
+    input: { version: number; overrideCreditLimit: boolean },
+  ): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
-      const draft = await this.lockDraft(tx, id, version);
-      await this.confirmAndLog(tx, draft);
+      const draft = await this.lockDraft(tx, id, input.version);
+      await this.confirmAndLog(tx, draft, input.overrideCreditLimit);
       return this.read(tx, id);
     });
   }
 
   // Back to draft, to be changed: only while no delivery points at it, not even a draft one (its
-  // lines point at the order's lines, which a save replaces). The number stays.
+  // lines point at the order's lines, which a save replaces). The number stays. Since step 15c the
+  // same goes for invoices: a service line billed straight from the order (no challan, so the
+  // check above misses it) must not be rewritten under its invoice.
   reopen(id: string, version: number): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
       const row = await this.lock(tx, id, version);
@@ -305,6 +321,7 @@ export class SalesOrdersService {
           'Deliveries were made for this order. Close it and write a new order instead.',
         );
       }
+      if (await this.anyInvoiceLine(tx, id)) throw hasInvoices();
       // The check sales_orders_confirmed_check: a draft has no confirmation
       await this.write(tx, id, { status: 'draft', confirmedAt: null, confirmedBy: null });
       await audit(tx, { action: 'sales_order.reopened', entityType: 'sales_order', entityId: id });
@@ -312,16 +329,18 @@ export class SalesOrdersService {
     });
   }
 
-  // Partly delivered, and the rest will not be: the customer took what there was
+  // Partly delivered, and the rest will not be: the customer took what there was. Since step 15c,
+  // also an order of services that was billed: it has nothing to deliver, so it never becomes
+  // "delivered" by itself.
   close(id: string, version: number): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
       const row = await this.lock(tx, id, version);
       if (row.status !== 'confirmed') throw notConfirmed();
-      if (!(await this.anythingDelivered(tx, id))) {
+      if (!(await this.anythingDelivered(tx, id)) && !(await this.anythingInvoiced(tx, id))) {
         throw new AppError(
           409,
           'order_nothing_delivered',
-          'Nothing was delivered for this order. Cancel it instead.',
+          'Nothing was delivered or billed for this order. Cancel it instead.',
         );
       }
       await this.write(tx, id, { status: 'closed' });
@@ -342,14 +361,24 @@ export class SalesOrdersService {
           'Some of this order was delivered. Close it instead.',
         );
       }
+      // A billed service line: the customer owes for it, so the order did happen (step 15c)
+      if (await this.anythingInvoiced(tx, id)) throw hasInvoices();
       await this.write(tx, id, { status: 'cancelled' });
       await audit(tx, { action: 'sales_order.cancelled', entityType: 'sales_order', entityId: id });
       return this.read(tx, id);
     });
   }
 
-  // The number the first time; a reopened order confirms again with the number it already has
-  private async confirmAndLog(tx: Transaction, draft: OrderRow): Promise<void> {
+  // The number the first time; a reopened order confirms again with the number it already has.
+  // Step 15c: confirming checks the credit limit (you chose this). The exposure is read before and
+  // after the order counts in it; CreditService.check refuses when the order takes the customer
+  // over the limit, unless overridden by someone allowed to.
+  private async confirmAndLog(
+    tx: Transaction,
+    draft: OrderRow,
+    overrideCreditLimit: boolean,
+  ): Promise<void> {
+    const before = await this.credit.lock(tx, draft.customerId);
     const number = draft.number ?? (await this.numbering.next(tx, 'sales.order', draft.date));
     await this.write(tx, draft.id, {
       status: 'confirmed',
@@ -363,6 +392,13 @@ export class SalesOrdersService {
       entityId: draft.id,
       changes: created({ number }),
     });
+    await this.credit.check(tx, {
+      customerId: draft.customerId,
+      before,
+      overrideCreditLimit,
+      entityType: 'sales_order',
+      entityId: draft.id,
+    });
   }
 
   // The quotation an order is made from: this customer's, and still waiting for an answer. FOR
@@ -428,6 +464,40 @@ export class SalesOrdersService {
     return line !== undefined;
   }
 
+  // Billed by a posted invoice (step 15c): a challan's goods or a service straight from the order
+  private async anythingInvoiced(tx: Transaction, orderId: string): Promise<boolean> {
+    const [line] = await tx
+      .select({ id: salesOrderLines.id })
+      .from(salesOrderLines)
+      .where(
+        and(
+          eq(salesOrderLines.tenantId, getTenantId()),
+          eq(salesOrderLines.orderId, orderId),
+          sql`${salesOrderLines.invoicedQuantity} > 0`,
+        ),
+      )
+      .limit(1);
+    return line !== undefined;
+  }
+
+  // An invoice line, even a draft's, points at one of its lines: a save of the reopened order would
+  // replace the line under it (the FK invoice_lines_order_line_fk would refuse it)
+  private async anyInvoiceLine(tx: Transaction, orderId: string): Promise<boolean> {
+    const [line] = await tx
+      .select({ id: invoiceLines.id })
+      .from(invoiceLines)
+      .innerJoin(
+        salesOrderLines,
+        and(
+          eq(salesOrderLines.tenantId, invoiceLines.tenantId),
+          eq(salesOrderLines.id, invoiceLines.orderLineId),
+        ),
+      )
+      .where(and(eq(invoiceLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, orderId)))
+      .limit(1);
+    return line !== undefined;
+  }
+
   private async write(
     tx: Transaction,
     id: string,
@@ -536,6 +606,7 @@ export class SalesOrdersService {
       lines: lines.map(({ row: line, variant }) => ({
         ...toSalesLine(line, variant),
         deliveredQuantity: line.deliveredQuantity,
+        invoicedQuantity: line.invoicedQuantity,
       })),
       quotation: quotation ?? null,
       deliveries: made,
```

- **`confirmAndLog()` checks the credit limit.** `credit.lock()` runs after the order's own lock (`lockDraft()`)
  and before the status changes, so it reads the exposure without this order. `credit.check()` runs after, with
  the order counted. Because it is the last step, a refused confirm rolls back everything: no number is taken and
  the order stays a draft.
- **`overrideCreditLimit` comes from both ways of confirming**: the Confirm button on a saved draft (the route
  body) and "Save and confirm" in the form (the order fields).
- **Reopen also refuses an order that an invoice bills** (`order_has_invoices`), even a draft invoice. A goods
  line is covered by 15b's `order_has_deliveries` already (it was billed through a challan). A service line is
  billed straight from the order, with no challan, so it needs this second check. A draft invoice counts too: the
  reopened order's next save replaces its lines, and the invoice line's foreign key would refuse it with an
  error nobody can read. The person deletes the draft invoice's line first.
- **Cancel refuses an order with anything billed.** The customer owes for that service, so the order happened; it
  is closed instead.
- **Close accepts an order with something billed but nothing delivered.** An order of services only (consulting,
  embroidery, a delivery charge) has nothing to deliver, so it never becomes "delivered" by itself. Without this,
  billing it in full would leave it confirmed forever, counting nothing but looking open.
- **`invoicedQuantity` on each line** of the order page.

### `sales/invoices.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  documentTotals,
  dueDateOf,
  type ErrorCode,
  type Invoice,
  type InvoiceInput,
  type InvoiceLineInput,
  type InvoicePaymentFilter,
  type InvoiceStatus,
  type InvoiceSummary,
  type PartyRef,
  sumQuantity,
  todayIn,
  type UpdateInvoiceInput,
} from '@omnivo/contracts';
import {
  deliveries,
  deliveryLines,
  invoiceLines,
  invoices,
  parties,
  products,
  receiptAllocations,
  receipts,
  salesOrderLines,
  salesOrders,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineInput,
  type LineIssue,
  linePath,
  linesError,
  resolveLines,
} from '../inventory/stock-lines.js';
import { assertPeriodOpen } from '../journal/period-lock.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { CreditService } from './credit.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { SalesBooksService } from './sales-books.service.js';
import {
  assertBranch,
  assertCustomer,
  billingAddressOf,
  customerRefs,
  pricesIncludeVatNow,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  toSalesLine,
  withVariants,
} from './sales-lines.js';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM invoice_lines l
   WHERE l.tenant_id = invoices.tenant_id AND l.invoice_id = invoices.id
)`;

// Posted and not paid in full: what a receipt can still be applied to. The same condition as the
// two partial indexes (invoices_open_customer_idx, invoices_open_due_idx), so they are used.
const isOpen = sql`${invoices.status} = 'posted' AND ${invoices.amountPaid} < ${invoices.total}`;

// What a line bills, once checked: a challan line (with the order line behind it, if any), an
// order's service line, or neither (a line of its own)
interface LineSource {
  deliveryLineId: string | null;
  orderLineId: string | null;
}

// What checkSources() found, for the save and the posting
interface Sources {
  lines: LineSource[];
  // The prices-with-VAT setting of the orders behind the lines; null when no line has an order
  pricesIncludeVat: boolean | null;
  // What the lines bill stays billable after it is archived: the goods already left, the service
  // was already ordered
  keptVariantIds: Set<string>;
  keptRateIds: Set<string>;
}

// What a line names, as the form sends it and as the database keeps it
interface LineRefs {
  deliveryLineId: string | null;
  orderLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'sales_not_draft',
    'Only a draft invoice can be changed. A posted one is corrected by a credit note.',
  );
}

function toSummary(row: InvoiceRow, customer: PartyRef, lines: number): InvoiceSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    dueDate: row.dueDate,
    customer,
    customerReference: row.customerReference,
    branchId: row.branchId,
    status: row.status,
    net: row.net,
    vat: row.vat,
    total: row.total,
    amountPaid: row.amountPaid,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A goods line of its own as the challan the invoice makes takes it
function stockLineOf(line: InvoiceLineInput | InvoiceLineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: [...line.serialNumbers],
  };
}

// The challan an invoice makes for its own goods lines names its lines lines.0, lines.1 …; the
// person sees the invoice, where those are, say, lines.2 and lines.5. `indexes` maps one to the
// other, so each problem shows under the invoice line it belongs to.
function onInvoiceLines(error: unknown, indexes: readonly number[]): never {
  if (!(error instanceof AppError) || error.options.fieldErrors === undefined) throw error;
  const fieldErrors = Object.fromEntries(
    Object.entries(error.options.fieldErrors).map(([path, codes]) => {
      const match = /^lines\.(\d+)\.(.+)$/.exec(path);
      const index = match === null ? undefined : indexes[Number(match[1])];
      const field = match?.[2];
      return [index === undefined || field === undefined ? path : linePath(index, field), codes];
    }),
  );
  throw new AppError(error.status, error.code, error.message, { ...error.options, fieldErrors });
}
```

- **`isOpen`** is written exactly like the `WHERE` of the two partial indexes of 15c.2. Postgres uses a partial
  index only when the query's condition matches it, so the open and overdue lists stay small and fast.
- **`LineSource`** is what a line bills after the check: the challan line, the order line, both (a challan line
  that delivered an order line), or neither (a line of its own). The form sends only one of the two ids; the
  server finds the order line behind a challan line itself.
- **`LineRefs`** is the part of a line `checkSources()` reads. Both a form line and a stored line have these
  fields, so the save and the posting call the same check with what each has.
- **`stockLineOf()`** turns a goods line of its own into what the stock code takes (`LineInput`). The spread
  `[...line.serialNumbers]` copies the contract's `readonly` array into the mutable one `LineInput` declares.
- **`onInvoiceLines()`.** The invoice's own goods lines are, say, its lines 2 and 5; on the challan they become
  lines 0 and 1. An error from the stock code ("only 40 in stock" under `lines.1.quantity`) would show under the
  invoice's line 1, a different product. This function maps each path back with `indexes` and throws the same
  error with the invoice's paths. It returns `never`, so TypeScript knows the code after a `catch` that calls it
  is not reached.

```ts
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly deliveries: DeliveriesService,
    private readonly books: SalesBooksService,
    private readonly credit: CreditService,
  ) {}

  // Newest date first; open and overdue invoices oldest due date first, the order a receipt pays
  // them in (the receipt form reads this list for its suggestion)
  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: InvoiceStatus | undefined;
    customerId?: string | undefined;
    payment?: InvoicePaymentFilter | undefined;
  }): Promise<{ items: InvoiceSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    const byDue = query.payment === 'open' || query.payment === 'overdue';
    return this.withTenant(async (tx) => {
      const today = query.payment === 'overdue' ? await this.today(tx) : null;
      const keyset = byDue
        ? sql`(${invoices.dueDate}, ${invoices.id}) > (${after?.[0]}::date, ${after?.[1]}::uuid)`
        : sql`(${invoices.date}, ${invoices.id}) < (${after?.[0]}::date, ${after?.[1]}::uuid)`;
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(invoices.status, query.status),
          query.customerId === undefined ? undefined : eq(invoices.customerId, query.customerId),
          this.paymentFilter(query.payment, today),
          after === undefined ? undefined : keyset,
        ),
        query.limit + 1,
        byDue ? [asc(invoices.dueDate), asc(invoices.id)] : undefined,
      );
      const page = toPage(rows, query.limit, (last) =>
        byDue ? [last.invoice.dueDate, last.invoice.id] : [last.invoice.date, last.invoice.id],
      );
      return {
        items: page.items.map((row) => toSummary(row.invoice, row.customer, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Invoice> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: InvoiceInput): Promise<Invoice> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      const fields = await this.check(tx, customer.id, input, null);
      const [row] = await tx
        .insert(invoices)
        .values({
          tenantId: getTenantId(),
          ...fields.header,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Invoice insert returned no row');
      await this.writeLines(tx, row.id, input.lines, fields.lines, fields.sources);
      await audit(tx, {
        action: 'invoice.created',
        entityType: 'invoice',
        entityId: row.id,
        changes: created(this.snapshot(row, customer, fields.lines.length)),
      });
      if (input.post) await this.postAndLog(tx, row, input.overrideCreditLimit);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateInvoiceInput): Promise<Invoice> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      const fields = await this.check(tx, customer.id, input, { row: before, lines: linesBefore });
      const [updated] = await tx
        .update(invoices)
        .set({
          ...fields.header,
          version: sql`${invoices.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, id)))
        .returning();
      if (!updated) throw notFound('Invoice');
      await this.writeLines(tx, id, input.lines, fields.lines, fields.sources);
      await audit(tx, {
        action: 'invoice.updated',
        entityType: 'invoice',
        entityId: id,
        changes: diff(
          this.snapshot(before, customerBefore, linesBefore.length),
          this.snapshot(updated, customer, fields.lines.length),
        ),
      });
      if (input.post) await this.postAndLog(tx, updated, input.overrideCreditLimit);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      // The lines go with it (ON DELETE CASCADE). A draft claimed no challan line: nothing to undo.
      await tx
        .delete(invoices)
        .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, id)));
      const snapshot = this.snapshot(before, customer, lines.length);
      await audit(tx, {
        action: 'invoice.deleted',
        entityType: 'invoice',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  post(id: string, input: { version: number; overrideCreditLimit: boolean }): Promise<Invoice> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, input.version);
      await this.postAndLog(tx, draft, input.overrideCreditLimit);
      return this.read(tx, id);
    });
  }
```

- **The list's two orders.** By default the newest date first, like every document list. With `payment=open` or
  `overdue`, the oldest due date first: that is the order a receipt pays invoices in, and the receipt form reads
  this list for its suggestion. The keyset cursor follows the order (`>` for ascending, `<` for descending), and
  the cursor holds the due date or the date to match.
- **`today()` only for `overdue`.** Overdue means "past its due date in the workspace's time zone". In UTC, an
  invoice due yesterday would only turn overdue at 6 in the morning in Dhaka, when the UTC date changes.
- **`create` and `update` share `check()`**, then write the header and the lines, log, and post if `post` is
  true, all in one transaction. "Save and post" either does both or nothing.
- **`update` lets a draft keep a customer that was archived since** (`assertCustomer(…, before.customerId)`), like
  every 15b draft. Posting checks it again without that exception (below).
- **`remove`** deletes a draft only (`lockDraft`). A draft claimed no challan line and no order line, so there is
  nothing to give back.

```ts
  // Every rule of a save the contract cannot check, and the header it writes. `before`: the draft
  // being changed (null for a new invoice); its VAT rates and its price setting stay usable. Its
  // items do not: like a quotation or an order (15b), an archived product is not sold any more,
  // unless the line bills a challan or an order that already sold it.
  private async check(
    tx: Transaction,
    customerId: string,
    input: InvoiceInput,
    before: { row: InvoiceRow; lines: readonly InvoiceLineRow[] } | null,
  ) {
    await assertBranch(tx, input.branchId);
    // FOR SHARE on the orders: a reopen waits until we commit, then sees this draft's lines
    const sources = await this.checkSources(tx, customerId, input.lines, 'share');
    const pricesIncludeVat =
      sources.pricesIncludeVat ?? before?.row.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
    const keptRateIds = new Set([
      ...sources.keptRateIds,
      ...(before?.lines.map((line) => line.taxRateId) ?? []),
    ]);
    const lines = await resolveSalesLines(
      tx,
      input.lines,
      pricesIncludeVat,
      keptRateIds,
      sources.keptVariantIds,
    );
    await this.checkOwnLines(tx, input, lines, sources.lines);
    const [terms] = await tx
      .select({ paymentTermsDays: parties.paymentTermsDays })
      .from(parties)
      .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, customerId)));
    return {
      header: {
        date: input.date,
        // An empty box: the customer's payment terms (step 15a), counted from the invoice date
        dueDate: input.dueDate ?? dueDateOf(input.date, terms?.paymentTermsDays ?? 0),
        customerId,
        customerReference: input.customerReference,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        billingAddress: await billingAddressOf(tx, customerId),
        pricesIncludeVat,
        note: input.note,
        ...documentTotals(lines.map((line) => line.amounts)),
      },
      lines,
      sources: sources.lines,
    };
  }

  // The lines of its own (neither a challan line nor an order line). A goods one is delivered by
  // the invoice when it is posted, so it is checked like a challan line now: the warehouse is
  // there and active, and the batch and serial numbers fit the product (resolveLines, the stock
  // documents' own check). A service one delivers nothing, so it takes no batch or serial.
  private async checkOwnLines(
    tx: Transaction,
    input: InvoiceInput,
    lines: readonly ResolvedSalesLine[],
    sources: readonly LineSource[],
  ): Promise<void> {
    const issues: LineIssue[] = [];
    const goods: number[] = [];
    lines.forEach((line, index) => {
      const source = sources[index];
      const typed = input.lines[index];
      if (source === undefined || typed === undefined) return;
      if (source.deliveryLineId !== null || source.orderLineId !== null) return;
      if (line.variant.type === 'goods') {
        goods.push(index);
        return;
      }
      if (typed.batchId !== null) {
        issues.push({ path: linePath(index, 'batchId'), code: 'invoice_stock_not_allowed' });
      }
      if (typed.serialNumbers.length > 0) {
        issues.push({ path: linePath(index, 'serialNumbers'), code: 'invoice_stock_not_allowed' });
      }
    });
    if (issues.length > 0) throw linesError(issues);
    if (goods.length === 0) return;
    if (input.warehouseId === null) {
      throw new AppError(
        409,
        'invoice_warehouse_required',
        'Pick the warehouse the goods of this invoice leave from.',
        { fieldErrors: { warehouseId: ['invoice_warehouse_required'] } },
      );
    }
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
    try {
      await resolveLines(
        tx,
        goods.flatMap((index) => {
          const line = input.lines[index];
          return line === undefined ? [] : [stockLineOf(line)];
        }),
        'out',
      );
    } catch (error) {
      onInvoiceLines(error, goods);
    }
  }
```

- **The price setting.** The orders behind the lines decide it (they must agree, `checkSources()`). With no order,
  an existing draft keeps its own setting and a new one takes the workspace's now, the same rule as 15b's
  quotations and orders.
- **`keptRateIds`** holds the rates of the orders behind the lines and of the draft's own lines. A VAT rate
  archived after the order was confirmed must still bill that order.
- **The due date.** An empty box gets the date plus the customer's payment terms (`dueDateOf()` from the
  contract, the same function the form uses for its placeholder). The column is `NOT NULL`, so the list can sort
  and filter by it without special cases.
- **The billing address is copied on every save**, so a draft picks up an address the customer added since. Once
  posted, the invoice never changes again (migration 0030), so the text is frozen from then on.
- **`checkOwnLines()`.** A goods line of its own will leave the warehouse when the invoice is posted, so it gets a
  challan line's checks now: the warehouse is set and active, and `resolveLines()` (step 13) checks its batch and
  serial numbers. Which products are goods only the server knows, so `invoice_warehouse_required` is checked here
  and not in the contract. A service line of its own delivers nothing, so a batch or a serial number on it is
  refused. The contract already refuses them on challan and order lines.

```ts
  // What each line bills, checked against the challans and orders it names: a challan line must be
  // on a posted challan of this customer, of the same item, pack and quantity, and not billed yet;
  // an order line must be a service line of a confirmed (or delivered, or closed) order of this
  // customer, billed whole, and not billed yet. All problems come back at once, under each line.
  // lock: 'share' when a draft is saved (a reopen of the order waits for us), 'update' when it is
  // posted (another invoice billing the same lines waits, then finds them billed). The challans
  // and orders are locked in id order, so two postings never wait for each other in a circle.
  private async checkSources(
    tx: Transaction,
    customerId: string,
    lines: readonly LineRefs[],
    lock: 'share' | 'update',
  ): Promise<Sources> {
    const deliveryLineIds = lines.flatMap((line) =>
      line.deliveryLineId === null ? [] : [line.deliveryLineId],
    );
    const challanLines = await this.challanLines(tx, deliveryLineIds, lock);
    // The order lines named directly, and those behind the challan lines
    const orderLineIds = [
      ...new Set([
        ...lines.flatMap((line) => (line.orderLineId === null ? [] : [line.orderLineId])),
        ...[...challanLines.values()].flatMap((line) =>
          line.orderLineId === null ? [] : [line.orderLineId],
        ),
      ]),
    ];
    const orderLines = await this.orderLines(tx, orderLineIds, lock);

    const issues: LineIssue[] = [];
    const sources: LineSource[] = [];
    const vatSettings = new Set<boolean>();
    const keptVariantIds = new Set<string>();
    const keptRateIds = new Set<string>();
    const same = (line: LineRefs, other: Omit<LineRefs, 'deliveryLineId' | 'orderLineId'>) =>
      line.variantId === other.variantId &&
      line.unitId === other.unitId &&
      compareQuantity(line.quantity, other.quantity) === 0;
    const useOrderLine = (orderLineId: string | null) => {
      const orderLine = orderLineId === null ? undefined : orderLines.get(orderLineId);
      if (orderLine === undefined) return;
      vatSettings.add(orderLine.pricesIncludeVat);
      keptRateIds.add(orderLine.taxRateId);
    };

    lines.forEach((line, index) => {
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      if (line.deliveryLineId !== null) {
        const challan = challanLines.get(line.deliveryLineId);
        if (
          challan?.customerId !== customerId ||
          challan.status !== 'posted' ||
          !same(line, challan)
        ) {
          at('deliveryLineId', 'invoice_delivery_line_invalid');
        } else if (challan.invoiced) {
          at('deliveryLineId', 'invoice_delivery_line_billed');
        }
        sources.push({
          deliveryLineId: line.deliveryLineId,
          orderLineId: challan?.orderLineId ?? null,
        });
        keptVariantIds.add(line.variantId);
        useOrderLine(challan?.orderLineId ?? null);
        return;
      }
      if (line.orderLineId !== null) {
        const orderLine = orderLines.get(line.orderLineId);
        // Goods on an order are billed through their challan: only the challan says they left
        if (
          orderLine?.customerId !== customerId ||
          !['confirmed', 'delivered', 'closed'].includes(orderLine.status) ||
          orderLine.productType !== 'service' ||
          !same(line, orderLine)
        ) {
          at('orderLineId', 'invoice_order_line_invalid');
        } else if (compareQuantity(orderLine.invoicedQuantity, '0') > 0) {
          at('orderLineId', 'invoice_order_line_billed');
        }
        sources.push({ deliveryLineId: null, orderLineId: line.orderLineId });
        keptVariantIds.add(line.variantId);
        useOrderLine(line.orderLineId);
        return;
      }
      sources.push({ deliveryLineId: null, orderLineId: null });
    });
    if (issues.length > 0) throw linesError(issues);
    // One invoice reads its prices one way: two orders that disagree cannot share an invoice
    if (vatSettings.size > 1) {
      throw new AppError(
        409,
        'invoice_vat_mixed',
        'These orders price differently (with and without VAT). Bill them on separate invoices.',
      );
    }
    const [pricesIncludeVat] = [...vatSettings];
    return {
      lines: sources,
      pricesIncludeVat: pricesIncludeVat ?? null,
      keptVariantIds,
      keptRateIds,
    };
  }

  // The challan lines an invoice names, with their challan's customer and status. The challans are
  // read (and locked) first, in id order; then the lines, so `invoiced` is read after the lock.
  private async challanLines(tx: Transaction, ids: readonly string[], lock: 'share' | 'update') {
    const tenantId = getTenantId();
    if (ids.length === 0) return new Map<string, never>();
    const owners = await tx
      .selectDistinct({ deliveryId: deliveryLines.deliveryId })
      .from(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, [...ids])));
    const challans = await tx
      .select({ id: deliveries.id, customerId: deliveries.customerId, status: deliveries.status })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenantId, tenantId),
          inArray(
            deliveries.id,
            owners.map((owner) => owner.deliveryId),
          ),
        ),
      )
      .orderBy(asc(deliveries.id))
      .for(lock);
    const byId = new Map(challans.map((challan) => [challan.id, challan]));
    const rows = await tx
      .select({
        id: deliveryLines.id,
        deliveryId: deliveryLines.deliveryId,
        variantId: deliveryLines.variantId,
        unitId: deliveryLines.unitId,
        quantity: deliveryLines.quantity,
        baseQuantity: deliveryLines.baseQuantity,
        orderLineId: deliveryLines.orderLineId,
        invoiced: deliveryLines.invoiced,
      })
      .from(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, [...ids])));
    return new Map(
      rows.flatMap((row) => {
        const challan = byId.get(row.deliveryId);
        return challan === undefined
          ? []
          : [[row.id, { ...row, customerId: challan.customerId, status: challan.status }] as const];
      }),
    );
  }

  // The order lines an invoice bills, directly or through a challan, with their order. Locked the
  // same way: the orders first, in id order, then the lines.
  private async orderLines(tx: Transaction, ids: readonly string[], lock: 'share' | 'update') {
    const tenantId = getTenantId();
    if (ids.length === 0) return new Map<string, never>();
    const owners = await tx
      .selectDistinct({ orderId: salesOrderLines.orderId })
      .from(salesOrderLines)
      .where(and(eq(salesOrderLines.tenantId, tenantId), inArray(salesOrderLines.id, [...ids])));
    const orders = await tx
      .select({
        id: salesOrders.id,
        customerId: salesOrders.customerId,
        status: salesOrders.status,
        pricesIncludeVat: salesOrders.pricesIncludeVat,
      })
      .from(salesOrders)
      .where(
        and(
          eq(salesOrders.tenantId, tenantId),
          inArray(
            salesOrders.id,
            owners.map((owner) => owner.orderId),
          ),
        ),
      )
      .orderBy(asc(salesOrders.id))
      .for(lock);
    const byId = new Map(orders.map((order) => [order.id, order]));
    const rows = await tx
      .select({
        id: salesOrderLines.id,
        orderId: salesOrderLines.orderId,
        variantId: salesOrderLines.variantId,
        unitId: salesOrderLines.unitId,
        quantity: salesOrderLines.quantity,
        invoicedQuantity: salesOrderLines.invoicedQuantity,
        taxRateId: salesOrderLines.taxRateId,
        productType: products.type,
      })
      .from(salesOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, salesOrderLines.tenantId),
          eq(products.id, salesOrderLines.productId),
        ),
      )
      .where(and(eq(salesOrderLines.tenantId, tenantId), inArray(salesOrderLines.id, [...ids])));
    return new Map(
      rows.flatMap((row) => {
        const order = byId.get(row.orderId);
        return order === undefined
          ? []
          : [
              [
                row.id,
                {
                  ...row,
                  customerId: order.customerId,
                  status: order.status,
                  pricesIncludeVat: order.pricesIncludeVat,
                },
              ] as const,
            ];
      }),
    );
  }
```

- **One check for the save and the posting.** `checkSources()` reads the challan lines and order lines the invoice
  names and checks them all, returning every problem at once under its own line (`linesError()`, like every line
  editor). The save runs it to give the person early answers; the posting runs it again because a draft holds
  nothing, and another invoice may have billed a line in between.
- **A challan line is billed whole.** It must be on a posted challan of this customer, of the same variant, unit
  and quantity, and not billed yet. Price, discount, VAT and description may differ: those are what the invoice
  decides. The quantities are compared with `compareQuantity()`, because the database sends `"24.0000"` and the
  form sends `"24"`.
- **An order line must be a service.** Goods on an order are billed through their challan, because only the
  challan says they left. A service is never delivered, so it is billed straight from a confirmed, delivered or
  closed order, whole and once.
- **One price setting per invoice.** Two orders, one with prices including VAT and one without, would make the
  same ৳115 mean two things on one invoice. `invoice_vat_mixed` asks for two invoices.
- **The locks.** On save, the orders are locked `FOR SHARE`: an order being reopened (which locks it `FOR UPDATE`)
  waits until this draft is saved, and then sees its lines (`order_has_invoices`). On posting, the challans and
  orders are locked `FOR UPDATE`: a second invoice billing the same challan line waits, and then finds it billed.
- **The locks are taken in id order**, challans first, then orders, and the lines are read *after* the lock. Two
  postings that need the same two challans take them in the same order, so they wait in a line instead of in a
  circle. Reading the lines after the lock means `invoiced` is the value the last posting committed.
- **`new Map<string, never>()`** for "no ids": the function returns early with an empty map whose values can never
  be read, which TypeScript accepts as one of the two possible map types without a cast.

```ts
  // Posting, in the caller's transaction, in the order migration 0030 needs: the invoice is still a
  // draft while its lines change (a line of its own gets its challan line), and becomes posted
  // last. A refused step leaves nothing: no number used, no stock moved, nothing billed.
  private async postAndLog(
    tx: Transaction,
    draft: InvoiceRow,
    overrideCreditLimit: boolean,
  ): Promise<void> {
    const tenantId = getTenantId();
    // The date first: a closed period refuses before anything is locked or moved
    await assertPeriodOpen(tx, draft.date);
    // Active now: the journal will not book a sale to an archived customer (the party rule)
    await assertCustomer(tx, draft.customerId);
    await assertBranch(tx, draft.branchId);
    const stored = await this.linesOf(tx, draft.id);
    // Again, under the locks: another invoice may have billed a line since the draft was saved
    const sources = await this.checkSources(tx, draft.customerId, stored, 'update');
    const before = await this.credit.lock(tx, draft.customerId);
    const number = await this.numbering.next(tx, 'sales.invoice', draft.date);

    // The goods lines of its own leave on a challan of their own
    const own = await this.ownGoodsLines(tx, stored, sources.lines);
    const billed = sources.lines.map((source) => source.deliveryLineId);
    if (own.length > 0) {
      if (draft.warehouseId === null) {
        throw new AppError(
          409,
          'invoice_warehouse_required',
          'Pick the warehouse the goods of this invoice leave from.',
          { fieldErrors: { warehouseId: ['invoice_warehouse_required'] } },
        );
      }
      let made: { lineIds: string[] };
      try {
        made = await this.deliveries.deliverForInvoice(tx, {
          customerId: draft.customerId,
          date: draft.date,
          warehouseId: draft.warehouseId,
          note: `Invoice ${number}`,
          lines: own.map((index) => {
            const line = stored[index];
            if (line === undefined) throw new Error(`Invoice line ${String(index)} is missing`);
            return stockLineOf(line);
          }),
        });
      } catch (error) {
        onInvoiceLines(error, own);
      }
      for (const [position, index] of own.entries()) {
        const line = stored[index];
        const deliveryLineId = made.lineIds[position];
        if (line === undefined || deliveryLineId === undefined) continue;
        billed[index] = deliveryLineId;
        await tx
          .update(invoiceLines)
          .set({ deliveryLineId })
          .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.id, line.id)));
      }
    }

    // Each challan line billed once: false → true, never back (migration 0030). The lock on the
    // challans makes a second invoice wait and then fail in checkSources(); the condition on
    // `invoiced` is the last word if anything slipped past.
    const challanLineIds = billed.filter((id): id is string => id !== null);
    if (challanLineIds.length > 0) {
      const marked = await tx
        .update(deliveryLines)
        .set({ invoiced: true })
        .where(
          and(
            eq(deliveryLines.tenantId, tenantId),
            inArray(deliveryLines.id, challanLineIds),
            eq(deliveryLines.invoiced, false),
          ),
        )
        .returning({ id: deliveryLines.id });
      if (marked.length !== challanLineIds.length) {
        throw new AppError(
          409,
          'invoice_delivery_line_billed',
          'Another invoice billed some of these challan lines.',
        );
      }
    }
    await this.invoiceOnOrders(tx, stored, sources.lines);

    // The books: the sale, the receivable and the VAT (SalesBooksService). Then the credit check,
    // with this invoice in what the customer owes and its order lines no longer "on order".
    const entry = await this.books.invoice(
      tx,
      { id: draft.id, number, date: draft.date },
      {
        customerId: draft.customerId,
        branchId: draft.branchId,
        net: draft.net,
        vat: draft.vat,
        total: draft.total,
      },
    );
    await this.credit.check(tx, {
      customerId: draft.customerId,
      before,
      overrideCreditLimit,
      entityType: 'invoice',
      entityId: draft.id,
    });
    await tx
      .update(invoices)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${invoices.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, draft.id)));
    await audit(tx, {
      action: 'invoice.posted',
      entityType: 'invoice',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // The indexes of the goods lines of its own: what the invoice delivers itself
  private async ownGoodsLines(
    tx: Transaction,
    stored: readonly InvoiceLineRow[],
    sources: readonly LineSource[],
  ): Promise<number[]> {
    const own = sources.flatMap((source, index) =>
      source.deliveryLineId === null && source.orderLineId === null ? [index] : [],
    );
    if (own.length === 0) return [];
    const productIds = [...new Set(own.flatMap((index) => stored[index]?.productId ?? []))];
    const goods = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.tenantId, getTenantId()),
          inArray(products.id, productIds),
          eq(products.type, 'goods'),
        ),
      );
    const isGoods = new Set(goods.map((product) => product.id));
    return own.filter((index) => isGoods.has(stored[index]?.productId ?? ''));
  }

  // What the invoice billed, onto its order lines: a challan line's quantity onto the order line it
  // delivered, a service line's onto itself. The orders are locked (checkSources); the database
  // lets invoiced_quantity change on a confirmed, delivered or closed order (migration 0030), never
  // past what was ordered. The order keeps its version: a delivered or closed order's header is
  // frozen (migration 0028), and no order action decides on a stale invoiced quantity — cancel and
  // reopen read it again under the order's lock.
  private async invoiceOnOrders(
    tx: Transaction,
    stored: readonly InvoiceLineRow[],
    sources: readonly LineSource[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, string[]>();
    stored.forEach((line, index) => {
      const orderLineId = sources[index]?.orderLineId ?? null;
      if (orderLineId === null) return;
      byOrderLine.set(orderLineId, [...(byOrderLine.get(orderLineId) ?? []), line.baseQuantity]);
    });
    for (const [orderLineId, quantities] of byOrderLine) {
      await tx
        .update(salesOrderLines)
        .set({
          invoicedQuantity: sql`${salesOrderLines.invoicedQuantity} + ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(salesOrderLines.tenantId, tenantId), eq(salesOrderLines.id, orderLineId)));
    }
  }

  // The lines as typed, with what the check found: the server's own order line for a challan line
  private async writeLines(
    tx: Transaction,
    invoiceId: string,
    typed: readonly InvoiceLineInput[],
    lines: readonly ResolvedSalesLine[],
    sources: readonly LineSource[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(invoiceLines)
      .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.invoiceId, invoiceId)));
    await tx.insert(invoiceLines).values(
      lines.map((line, index) => ({
        ...salesLineValues(line, index),
        invoiceId,
        deliveryLineId: sources[index]?.deliveryLineId ?? null,
        orderLineId: sources[index]?.orderLineId ?? null,
        batchId: typed[index]?.batchId ?? null,
        serialNumbers: [...(typed[index]?.serialNumbers ?? [])],
      })),
    );
  }
```

- **The order of posting is the order migration 0030 needs.** The invoice's lines can change only while it is a
  draft, so the challan of its own goods is made first and its lines are pointed at the new challan lines. The
  invoice becomes posted last. A refusal at any step rolls everything back: no number taken, no stock moved,
  nothing billed.
- **The date first.** `assertPeriodOpen()` refuses a closed period before anything is locked or moved, with the
  error under `date`.
- **The customer must be active now.** The journal refuses a new receivable line for an archived customer (the
  party rule of step 15a), and its error would sit under a journal line the person never saw. `assertCustomer()`
  without the "kept" exception gives `sales_customer_invalid` under the customer instead. The branch is checked
  again for the same reason.
- **`credit.lock()` comes after the challan and order locks** (the rule in `credit.service.ts`), and before
  anything is billed, so the exposure it returns is the one without this invoice.
- **The challan of its own goods.** `deliverForInvoice()` posts it with the invoice's warehouse and date, and the
  note "Invoice INV-…". A stock problem (not enough in stock, a batch of another product) comes back under the
  invoice's line through `onInvoiceLines()`. The warehouse was required when the draft was saved; the column is
  still nullable, so TypeScript needs the check here anyway, and it gives the same answer.
- **Marking the challan lines billed.** `UPDATE … SET invoiced = true … WHERE invoiced = false RETURNING id`, and
  the count must match. The challan locks already make a second invoice wait and fail in `checkSources()`; the
  condition is the last word if anything slipped past. A line already `true` is skipped by the `WHERE` instead
  of hitting migration 0030's guard, so the answer is the readable `invoice_delivery_line_billed`. The lines of
  the invoice's own challan are marked the same way, so every billed line goes through one path.
- **`invoiceOnOrders()`.** Each order line gets what was billed against it, in the base unit: a challan line's
  quantity (the challan line and the invoice line have the same quantity) or a service line's. The order's version
  is *not* raised, unlike a delivery's posting: migration 0028 freezes the header of a delivered or closed order,
  and no order action decides anything on a stale invoiced quantity (cancel and reopen read it again under the
  order's lock).
- **The books, then the credit check.** The entry is written first, so the exposure that `credit.check()` reads
  includes this invoice as owed and its order lines as no longer on order.
- **`ownGoodsLines()`** asks the products table which lines of its own are goods. A stored line has the product's
  id but not its type, and the type can be read in one query for all of them.
- **`writeLines()`** deletes and inserts, like every document's lines. It stores the order line the server found
  behind a challan line, so the order page can count what was billed without a join through the challan.

```ts
  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<InvoiceRow> {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, id)))
      .for('update');
    if (!row) throw notFound('Invoice');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, invoiceId: string) {
    return tx
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.tenantId, getTenantId()), eq(invoiceLines.invoiceId, invoiceId)))
      .orderBy(asc(invoiceLines.lineNo));
  }

  private paymentFilter(
    payment: InvoicePaymentFilter | undefined,
    today: string | null,
  ): SQL | undefined {
    if (payment === 'paid') {
      return sql`${invoices.status} = 'posted' AND ${invoices.amountPaid} >= ${invoices.total}`;
    }
    if (payment === 'open') return isOpen;
    if (payment === 'overdue') return sql`${isOpen} AND ${invoices.dueDate} < ${today}::date`;
    return undefined;
  }

  // The workspace's today: an invoice is overdue the day after its due date there, not in UTC
  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }

  private rows(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
    order: SQL[] = [desc(invoices.date), desc(invoices.id)],
  ) {
    return tx
      .select({
        invoice: invoices,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
      })
      .from(invoices)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, invoices.tenantId), eq(parties.id, invoices.customerId)),
      )
      .where(and(eq(invoices.tenantId, getTenantId()), where))
      .orderBy(...order)
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Invoice> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(invoices.id, id), 1);
    if (!found) throw notFound('Invoice');
    const { invoice: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    // A challan line left with its batch and serial numbers: the invoice prints those
    const challanLineIds = lines.flatMap(({ row: line }) =>
      line.deliveryLineId === null ? [] : [line.deliveryLineId],
    );
    const challanLines =
      challanLineIds.length === 0
        ? []
        : await tx
            .select({
              id: deliveryLines.id,
              batchId: deliveryLines.batchId,
              serialNumbers: deliveryLines.serialNumbers,
              deliveryId: deliveries.id,
              number: deliveries.number,
              date: deliveries.date,
            })
            .from(deliveryLines)
            .innerJoin(
              deliveries,
              and(
                eq(deliveries.tenantId, deliveryLines.tenantId),
                eq(deliveries.id, deliveryLines.deliveryId),
              ),
            )
            .where(
              and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, challanLineIds)),
            );
    const challanLine = new Map(challanLines.map((line) => [line.id, line]));
    const stockOf = (line: InvoiceLineRow) => {
      const challan =
        line.deliveryLineId === null ? undefined : challanLine.get(line.deliveryLineId);
      return {
        batchId: challan?.batchId ?? line.batchId,
        serialNumbers: challan?.serialNumbers ?? line.serialNumbers,
      };
    };
    const orderLineIds = lines.flatMap(({ row: line }) =>
      line.orderLineId === null ? [] : [line.orderLineId],
    );
    const [batches, orders, payments, entry] = await Promise.all([
      batchesOf(
        tx,
        lines.map(({ row: line }) => stockOf(line).batchId),
      ),
      orderLineIds.length === 0
        ? []
        : tx
            .select({
              lineId: salesOrderLines.id,
              id: salesOrders.id,
              number: salesOrders.number,
            })
            .from(salesOrderLines)
            .innerJoin(
              salesOrders,
              and(
                eq(salesOrders.tenantId, salesOrderLines.tenantId),
                eq(salesOrders.id, salesOrderLines.orderId),
              ),
            )
            .where(
              and(
                eq(salesOrderLines.tenantId, tenantId),
                inArray(salesOrderLines.id, orderLineIds),
              ),
            )
            .orderBy(asc(salesOrders.number)),
      tx
        .select({
          receiptId: receipts.id,
          receiptNumber: receipts.number,
          date: receipts.date,
          amount: receiptAllocations.amount,
        })
        .from(receiptAllocations)
        .innerJoin(
          receipts,
          and(
            eq(receipts.tenantId, receiptAllocations.tenantId),
            eq(receipts.id, receiptAllocations.receiptId),
          ),
        )
        .where(and(eq(receiptAllocations.tenantId, tenantId), eq(receiptAllocations.invoiceId, id)))
        .orderBy(asc(receipts.date), asc(receipts.number)),
      row.status === 'posted' ? this.books.entryOf(tx, id, 'sales_invoice') : null,
    ]);
    // Each order once, by number; and the number of the order behind each order line
    const orderOf = new Map(orders.map((order) => [order.lineId, order.number]));
    const orderRefs = [
      ...new Map(
        orders.map((order) => [order.id, { id: order.id, number: order.number }]),
      ).values(),
    ];
    // Each challan once, oldest first. Posted, so each has a number.
    const challans = new Map(
      challanLines.flatMap((line) =>
        line.number === null
          ? []
          : [
              [
                line.deliveryId,
                { id: line.deliveryId, number: line.number, date: line.date },
              ] as const,
            ],
      ),
    );
    return {
      ...toSummary(row, found.customer, found.lineCount),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      warehouseId: row.warehouseId,
      billingAddress: row.billingAddress,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => {
        const stock = stockOf(line);
        const batch = stock.batchId === null ? undefined : batches.get(stock.batchId);
        return {
          ...toSalesLine(line, variant),
          deliveryLineId: line.deliveryLineId,
          orderLineId: line.orderLineId,
          deliveryNumber:
            line.deliveryLineId === null
              ? null
              : (challanLine.get(line.deliveryLineId)?.number ?? null),
          orderNumber: line.orderLineId === null ? null : (orderOf.get(line.orderLineId) ?? null),
          batchId: stock.batchId,
          lotNumber: batch?.lotNumber ?? null,
          expiresOn: batch?.expiresOn ?? null,
          serialNumbers: stock.serialNumbers,
        };
      }),
      deliveries: [...challans.values()].toSorted(
        (a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
      ),
      orders: orderRefs,
      payments,
      entry,
    };
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  // What the audit log shows: the header and the size, not every line
  private snapshot(row: InvoiceRow, customer: PartyRef, lines: number) {
    return {
      number: row.number,
      date: row.date,
      dueDate: row.dueDate,
      customer: customer.code,
      customerReference: row.customerReference,
      total: row.total,
      lines,
    };
  }
}
```

- **`lockDraft()`** locks the invoice `FOR UPDATE` and checks the status and the version, like 15b. A posted
  invoice answers `sales_not_draft` with a message that points at the credit note (15d).
- **The batch on each line** comes from the challan line when there is one, else from the line itself. After
  posting, a line of its own points at its challan line too, so both cases read the same. The printed invoice
  shows the batch and its expiry (a pharmacy's invoice must).
- **The challans, the orders and the payments** are read in a few queries for the whole invoice, never one per
  line. Each challan appears once (a `Map` by id), sorted by date and number.
- **The orders query reads one row per order line** (`lineId`), not one per order, because each line also gets
  the number of its own order (`orderNumber`, 15c.6). `orderRefs` then keeps each order once, in the number order
  the query sorted by: a `Map` keeps the order its keys were first added in.
- **`entry`** is read only for a posted invoice; a draft has none, and an invoice of ৳0 has none either
  (`entryOf()` finds nothing).

### `sales/receipts.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  moneyAccountIds,
  overAllocated,
  type PartyRef,
  type Receipt,
  type ReceiptInput,
  type ReceiptStatus,
  type ReceiptSummary,
  subtractMoney,
  sumMoney,
  type VoidReceiptInput,
} from '@omnivo/contracts';
import { invoices, ledgerAccounts, parties, receiptAllocations, receipts } from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type LineIssue, linesError } from '../inventory/stock-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { SalesBooksService } from './sales-books.service.js';
import { assertBranch, assertCustomer } from './sales-lines.js';

type ReceiptRow = typeof receipts.$inferSelect;

interface Allocation {
  invoiceId: string;
  amount: string;
}

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

function toSummary(row: ReceiptRow, customer: PartyRef): ReceiptSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    amount: row.amount,
    applied: row.applied,
    method: row.method,
    reference: row.reference,
    accountId: row.accountId,
    branchId: row.branchId,
    status: row.status,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function voided(): AppError {
  return new AppError(409, 'receipt_voided', 'This receipt is voided and cannot be changed.');
}

function overAllocatedError(): AppError {
  return new AppError(
    409,
    'receipt_over_allocated',
    'More is applied than the receipt brought. Lower the amounts on the invoices.',
    { fieldErrors: { allocations: ['receipt_over_allocated'] } },
  );
}

// An allocation's problem, under its own row of the form: allocations.2.amount
function allocationPath(index: number, field: string): string {
  return `allocations.${String(index)}.${field}`;
}

// Money receipts (step 15c). Saving one posts it at once: it gets its number (MR-2026-27-0001) and
// its entry, and its money is applied to the invoices the form chose. Afterwards only two things
// happen to it: its money is applied again (allocate), or it is voided.
@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: SalesBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: ReceiptStatus | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: ReceiptSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(receipts.status, query.status),
          query.customerId === undefined ? undefined : eq(receipts.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${receipts.date}, ${receipts.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.receipt.date, last.receipt.id]);
      return {
        items: page.items.map((row) => toSummary(row.receipt, row.customer)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Receipt> {
    return this.withTenant((tx) => this.read(tx, id));
  }
```

- **`allocationPath()`** puts a problem under its row of the receipt form (`allocations.2.amount`). The step 13
  helper `linesError()` takes any path, so the receipt reuses it for "all problems at once".
- **The list** is the newest date first, filtered by status and customer, like the other documents.

```ts
  async create(input: ReceiptInput): Promise<Receipt> {
    try {
      return await this.withTenant(async (tx) => {
        const customer = await assertCustomer(tx, input.customerId);
        await assertBranch(tx, input.branchId);
        await this.assertMoneyAccount(tx, input.accountId);
        const number = await this.numbering.next(tx, 'sales.receipt', input.date);
        const [row] = await tx
          .insert(receipts)
          .values({
            tenantId: getTenantId(),
            number,
            date: input.date,
            customerId: customer.id,
            amount: input.amount,
            accountId: input.accountId,
            method: input.method,
            reference: input.reference,
            branchId: input.branchId,
            note: input.note,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Receipt insert returned no row');
        // The books first: a closed period refuses here, before any invoice is touched
        const entry = await this.books.receipt(
          tx,
          { id: row.id, number, date: row.date },
          {
            customerId: customer.id,
            branchId: row.branchId,
            accountId: row.accountId,
            amount: row.amount,
          },
        );
        await this.apply(tx, row, input.allocations);
        await audit(tx, {
          action: 'receipt.created',
          entityType: 'receipt',
          entityId: row.id,
          changes: created({
            number,
            date: row.date,
            customer: customer.code,
            amount: row.amount,
            method: row.method,
            entry: entry.number,
            invoices: input.allocations.length,
          }),
        });
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw overInvoiceRace(error);
    }
  }

  // The whole list as the person left it: the money of an advance applied to a new invoice, or
  // moved from one invoice to another. Nothing in the books changes — the receivable is one
  // number per customer — only what each invoice still owes.
  async allocate(
    id: string,
    input: { version: number; allocations: readonly Allocation[] },
  ): Promise<Receipt> {
    try {
      return await this.withTenant(async (tx) => {
        const row = await this.lock(tx, id, input.version);
        if (overAllocated(row.amount, input.allocations)) throw overAllocatedError();
        const before = await this.allocationsOf(tx, id);
        await this.apply(tx, row, input.allocations);
        await tx
          .update(receipts)
          .set({ version: sql`${receipts.version} + 1`, updatedBy: currentPrincipal().userId })
          .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, id)));
        await audit(tx, {
          action: 'receipt.allocated',
          entityType: 'receipt',
          entityId: id,
          changes: this.allocationChanges(before, await this.allocationsOf(tx, id)),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw overInvoiceRace(error);
    }
  }

  // A bounced cheque or a receipt typed by mistake: its money comes off the invoices, and its entry
  // is reversed on the void date. The receipt stays, voided, so its number is never reused or
  // missing from the series.
  void(id: string, input: VoidReceiptInput): Promise<Receipt> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (input.date < row.date) {
        throw new AppError(
          409,
          'receipt_void_date',
          'A receipt cannot be voided before the day it was received.',
          { fieldErrors: { date: ['receipt_void_date'] } },
        );
      }
      const entry = await this.books.entryOf(tx, id, 'sales_receipt');
      if (entry === null) throw new Error(`Receipt ${id} has no entry`);
      // The allocations first: the database lets a receipt be voided only once nothing of it is
      // applied (receipts_void_check). Their trigger takes the money off the invoices.
      await this.apply(tx, row, []);
      await tx
        .update(receipts)
        .set({
          status: 'voided',
          voidDate: input.date,
          voidReason: input.reason,
          version: sql`${receipts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, id)));
      const reversal = await this.books.reverse(tx, entry, {
        date: input.date,
        narration: `Money receipt ${row.number} voided: ${input.reason}`,
      });
      await audit(tx, {
        action: 'receipt.voided',
        entityType: 'receipt',
        entityId: id,
        changes: created({ date: input.date, reason: input.reason, reversal: reversal.number }),
      });
      return this.read(tx, id);
    });
  }
```

- **Saved = posted.** The receipt takes its MR number and its entry in the same transaction as the insert. There
  is no draft: the money is already in hand, and nobody approves cash that was counted.
- **The entry before the allocations.** A closed period (`journal_period_locked` under `date`) refuses before any
  invoice is locked or touched.
- **`allocate`** replaces the whole list. The amount is not in the request, so the total is checked against the
  receipt's own (`receipt_over_allocated`) before any invoice is locked. The version goes up even though only the
  allocations changed: a receipt page open somewhere else shows the old list, and its next action must reload.
- **The audit row of `allocate`** shows invoice number → amount, before and after. Moving ৳50,000 from one invoice
  to another changes nothing in the books, but it changes who owes what, and the owner will want to see who did it.
  `diff()` walks only the new snapshot, so `allocationChanges()` adds every invoice of the old list with `null`:
  without that, an invoice the money was taken off would not show in the log at all, and the row would say where
  the money went but not where it came from. (This was found while writing the audit words in 15c.5.)
- **`void`.** The void date is checked first (not before the receipt; the database checks it too). Then the
  allocations go (`apply(…, [])`), because the database allows a void only when nothing of the receipt is
  applied. Then the status, and last the reversal, dated the void date with the reason in its narration. The
  journal checks the period of the void date, so a bounced cheque in a closed month is refused there.
- **`overInvoiceRace()`** turns the database's last word into the form's codes, *outside* the transaction (after
  its rollback), the pattern of step 6. The locks in `apply()` make it rare; it is there so the rare case still
  gets a readable answer.

```ts
  // Replaces the receipt's allocations with `wanted`. Each invoice must be a posted invoice of the
  // receipt's customer, and get no more than it still owes (what this receipt had on it counts as
  // owed again: it is being replaced). The invoices are locked FOR UPDATE in id order before
  // anything is written, so two receipts paying one invoice take turns, and the second sees what
  // the first paid. amount_paid and applied are not written here: the allocations' trigger keeps
  // them (migration 0030).
  private async apply(
    tx: Transaction,
    receipt: ReceiptRow,
    wanted: readonly Allocation[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const current = await tx
      .select({ invoiceId: receiptAllocations.invoiceId, amount: receiptAllocations.amount })
      .from(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          eq(receiptAllocations.receiptId, receipt.id),
        ),
      );
    const invoiceIds = [
      ...new Set([...current, ...wanted].map((allocation) => allocation.invoiceId)),
    ];
    const rows =
      invoiceIds.length === 0
        ? []
        : await tx
            .select({
              id: invoices.id,
              customerId: invoices.customerId,
              status: invoices.status,
              total: invoices.total,
              amountPaid: invoices.amountPaid,
            })
            .from(invoices)
            .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, invoiceIds)))
            .orderBy(asc(invoices.id))
            .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const had = new Map(current.map((allocation) => [allocation.invoiceId, allocation.amount]));

    const issues: LineIssue[] = [];
    wanted.forEach((allocation, index) => {
      const invoice = byId.get(allocation.invoiceId);
      if (invoice?.customerId !== receipt.customerId || invoice.status !== 'posted') {
        issues.push({ path: allocationPath(index, 'invoiceId'), code: 'receipt_invoice_invalid' });
        return;
      }
      const due = sumMoney([
        subtractMoney(invoice.total, invoice.amountPaid),
        had.get(allocation.invoiceId) ?? '0',
      ]);
      if (compareMoney(allocation.amount, due) > 0) {
        issues.push({ path: allocationPath(index, 'amount'), code: 'receipt_over_invoice' });
      }
    });
    if (issues.length > 0) throw linesError(issues);

    await tx
      .delete(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          eq(receiptAllocations.receiptId, receipt.id),
        ),
      );
    if (wanted.length === 0) return;
    await tx.insert(receiptAllocations).values(
      wanted.map((allocation) => ({
        tenantId,
        receiptId: receipt.id,
        customerId: receipt.customerId,
        invoiceId: allocation.invoiceId,
        amount: allocation.amount,
      })),
    );
  }

  // A money account: active, not a group, and flagged itself or under a flagged group
  // (contracts' moneyAccountIds — the receipt form offers exactly the same list). The whole chart
  // is read: it is a few hundred rows at most. FOR SHARE on the chosen one: nobody archives it or
  // unticks its group's flag before we commit (the journal locks it again when posting).
  private async assertMoneyAccount(tx: Transaction, accountId: string): Promise<void> {
    const chart = await tx
      .select({
        id: ledgerAccounts.id,
        parentId: ledgerAccounts.parentId,
        isGroup: ledgerAccounts.isGroup,
        holdsMoney: ledgerAccounts.holdsMoney,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.tenantId, getTenantId()));
    const money = moneyAccountIds(
      chart.map((account) => ({
        ...account,
        archivedAt: account.archivedAt?.toISOString() ?? null,
      })),
    );
    if (!money.has(accountId)) {
      throw new AppError(
        409,
        'receipt_account_invalid',
        'Pick a cash, bank or mobile wallet account.',
        { fieldErrors: { accountId: ['receipt_account_invalid'] } },
      );
    }
    await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, accountId)))
      .for('share');
  }
```

- **`apply()` locks every invoice involved, old and new, in id order**, before it reads what they owe. Two
  receipts paying the last ৳5,000 of one invoice take turns: the second one sees the first one's payment and is
  refused with `receipt_over_invoice` under its row.
- **What this receipt already paid counts as owed again.** Moving ৳1,000 from one row to the same invoice with
  ৳1,200 must not be refused because the old ৳1,000 is still in `amount_paid`: the old rows are about to be
  deleted.
- **The API never writes `amount_paid` or `applied`.** It deletes and inserts allocation rows; the trigger of
  migration 0030 keeps both sums in the same statement. There is one place that adds them up, so they can never
  disagree with the rows.
- **The invoice must be posted and this customer's.** The allocation's foreign keys carry the customer on both
  sides (15c.2), so the database refuses another customer's invoice too; the API answers first, under the row.
- **`assertMoneyAccount()` uses the contract's `moneyAccountIds()`** on the whole chart, the same function the
  receipt form uses for its list, so the form never offers an account the server refuses. A chart is a few hundred
  rows at most. The chosen account is then locked `FOR SHARE`, so nobody archives it before we commit.

```ts
  // FOR UPDATE: an allocate and a void of one receipt take turns. A voided receipt is final.
  private async lock(tx: Transaction, id: string, version: number): Promise<ReceiptRow> {
    const [row] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, id)))
      .for('update');
    if (!row) throw notFound('Receipt');
    if (row.status === 'voided') throw voided();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  // The invoices it pays, oldest due date first: the order the form suggested them in
  private allocationsOf(tx: Transaction, receiptId: string) {
    return tx
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.number,
        invoiceDate: invoices.date,
        dueDate: invoices.dueDate,
        invoiceTotal: invoices.total,
        amount: receiptAllocations.amount,
      })
      .from(receiptAllocations)
      .innerJoin(
        invoices,
        and(
          eq(invoices.tenantId, receiptAllocations.tenantId),
          eq(invoices.id, receiptAllocations.invoiceId),
        ),
      )
      .where(
        and(
          eq(receiptAllocations.tenantId, getTenantId()),
          eq(receiptAllocations.receiptId, receiptId),
        ),
      )
      .orderBy(asc(invoices.dueDate), asc(invoices.id));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        receipt: receipts,
        customer: { id: parties.id, code: parties.code, name: parties.name },
      })
      .from(receipts)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, receipts.tenantId), eq(parties.id, receipts.customerId)),
      )
      .where(and(eq(receipts.tenantId, getTenantId()), where))
      .orderBy(desc(receipts.date), desc(receipts.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Receipt> {
    const [found] = await this.rows(tx, eq(receipts.id, id), 1);
    if (!found) throw notFound('Receipt');
    const { receipt: row } = found;
    const [allocations, entry] = await Promise.all([
      this.allocationsOf(tx, id),
      this.books.entryOf(tx, id, 'sales_receipt'),
    ]);
    if (entry === null) throw new Error(`Receipt ${id} has no entry`);
    const voidEntry = row.status === 'voided' ? await this.books.reversalOf(tx, entry.id) : null;
    return {
      ...toSummary(row, found.customer),
      note: row.note,
      // Only posted invoices are ever paid, so each has a number
      allocations: allocations.flatMap((allocation) =>
        allocation.invoiceNumber === null
          ? []
          : [{ ...allocation, invoiceNumber: allocation.invoiceNumber }],
      ),
      entry,
      voidEntry,
      voidDate: row.voidDate,
      voidReason: row.voidReason,
    };
  }

  // What the audit log shows of the allocations: one row per invoice number, with the amount
  // before and after. diff() walks the new list only, so an invoice the money was taken off is
  // added with null; without that, the log would not show where the money came from.
  private allocationChanges(
    before: readonly { invoiceNumber: string | null; amount: string }[],
    after: readonly { invoiceNumber: string | null; amount: string }[],
  ) {
    const from = allocationSnapshot(before);
    const to: Record<string, string | null> = allocationSnapshot(after);
    for (const invoiceNumber of Object.keys(from)) to[invoiceNumber] ??= null;
    return diff(from, to);
  }
}

// Invoice number → amount
function allocationSnapshot(
  allocations: readonly { invoiceNumber: string | null; amount: string }[],
): Record<string, string> {
  return Object.fromEntries(
    allocations.map((allocation) => [allocation.invoiceNumber ?? '', allocation.amount]),
  );
}

// The database's last word, if two writers got past the checks above: an invoice paid past its
// total (invoices_paid_check), or a receipt applied past its amount (receipts_amount_check). The
// locks in apply() make this rare; it still answers with the code the form knows.
function overInvoiceRace(error: unknown): unknown {
  if (isCheckViolation(error, 'invoices_paid_check')) {
    return new AppError(
      409,
      'receipt_over_invoice',
      'Another receipt paid one of these invoices first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'receipts_amount_check')) return overAllocatedError();
  return error;
}
```

- **`lock()`** refuses a voided receipt with `receipt_voided` before it looks at the version: a voided receipt is
  final, and "reload and try again" would be the wrong advice.
- **`allocationsOf()`** lists the invoices oldest due date first, the order the form suggested them in.
- **`read()`** finds the entry by source, and the void entry as the reversal of that entry. A receipt always has
  an entry; a missing one is a bug, so it is a plain `Error`.
- **`invoiceNumber`** is `string | null` in the table (a draft has none), but only posted invoices are ever paid.
  The `flatMap` narrows it without a cast.

### The routes and the module

```diff
@@ -3,14 +3,18 @@ import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
 
 import { Endpoint } from '../common/http/endpoint.js';
 import { DeliveriesService } from './deliveries.service.js';
+import { InvoicesService } from './invoices.service.js';
 import { PriceLookupService } from './price-lookup.service.js';
 import { QuotationsService } from './quotations.service.js';
+import { ReceiptsService } from './receipts.service.js';
 import { SalesOrdersService } from './sales-orders.service.js';
 
 type PriceRoutes = typeof routes.salesPrices;
 type QuotationRoutes = typeof routes.quotations;
 type OrderRoutes = typeof routes.salesOrders;
 type DeliveryRoutes = typeof routes.deliveries;
+type InvoiceRoutes = typeof routes.invoices;
+type ReceiptRoutes = typeof routes.receipts;
 
 @Controller()
 export class SalesPricesController {
@@ -118,7 +122,7 @@ export class SalesOrdersController {
     params,
     body,
   }: RouteInput<OrderRoutes['confirm']>): Promise<RouteResponse<OrderRoutes['confirm']>> {
-    return this.orders.confirm(params.id, body.version);
+    return this.orders.confirm(params.id, body);
   }
 
   @Endpoint(routes.salesOrders.reopen)
@@ -192,3 +196,88 @@ export class DeliveriesController {
     return this.deliveries.post(params.id, body.version);
   }
 }
+
+@Controller()
+export class InvoicesController {
+  constructor(private readonly invoices: InvoicesService) {}
+
+  @Endpoint(routes.invoices.list)
+  list({
+    query,
+  }: RouteInput<InvoiceRoutes['list']>): Promise<RouteResponse<InvoiceRoutes['list']>> {
+    return this.invoices.list(query);
+  }
+
+  @Endpoint(routes.invoices.get)
+  get({ params }: RouteInput<InvoiceRoutes['get']>): Promise<RouteResponse<InvoiceRoutes['get']>> {
+    return this.invoices.get(params.id);
+  }
+
+  @Endpoint(routes.invoices.create)
+  create({
+    body,
+  }: RouteInput<InvoiceRoutes['create']>): Promise<RouteResponse<InvoiceRoutes['create']>> {
+    return this.invoices.create(body);
+  }
+
+  @Endpoint(routes.invoices.update)
+  update({
+    params,
+    body,
+  }: RouteInput<InvoiceRoutes['update']>): Promise<RouteResponse<InvoiceRoutes['update']>> {
+    return this.invoices.update(params.id, body);
+  }
+
+  @Endpoint(routes.invoices.remove)
+  remove({ params, query }: RouteInput<InvoiceRoutes['remove']>): Promise<void> {
+    return this.invoices.remove(params.id, query.version);
+  }
+
+  @Endpoint(routes.invoices.post)
+  post({
+    params,
+    body,
+  }: RouteInput<InvoiceRoutes['post']>): Promise<RouteResponse<InvoiceRoutes['post']>> {
+    return this.invoices.post(params.id, body);
+  }
+}
+
+@Controller()
+export class ReceiptsController {
+  constructor(private readonly receipts: ReceiptsService) {}
+
+  @Endpoint(routes.receipts.list)
+  list({
+    query,
+  }: RouteInput<ReceiptRoutes['list']>): Promise<RouteResponse<ReceiptRoutes['list']>> {
+    return this.receipts.list(query);
+  }
+
+  @Endpoint(routes.receipts.get)
+  get({ params }: RouteInput<ReceiptRoutes['get']>): Promise<RouteResponse<ReceiptRoutes['get']>> {
+    return this.receipts.get(params.id);
+  }
+
+  @Endpoint(routes.receipts.create)
+  create({
+    body,
+  }: RouteInput<ReceiptRoutes['create']>): Promise<RouteResponse<ReceiptRoutes['create']>> {
+    return this.receipts.create(body);
+  }
+
+  @Endpoint(routes.receipts.allocate)
+  allocate({
+    params,
+    body,
+  }: RouteInput<ReceiptRoutes['allocate']>): Promise<RouteResponse<ReceiptRoutes['allocate']>> {
+    return this.receipts.allocate(params.id, body);
+  }
+
+  @Endpoint(routes.receipts.void)
+  void({
+    params,
+    body,
+  }: RouteInput<ReceiptRoutes['void']>): Promise<RouteResponse<ReceiptRoutes['void']>> {
+    return this.receipts.void(params.id, body);
+  }
+}
```

- **Two controllers, one per route group**, in the file that holds the other sales documents. Each method only
  passes the parsed request on: the contract's `Endpoint()` decorator has already checked the body, the query and
  the permission.
- **The order's confirm passes the whole body** now (`version` and `overrideCreditLimit`).

```diff
@@ -3,6 +3,7 @@ import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
 
 import { Endpoint } from '../common/http/endpoint.js';
 import { LedgerService } from '../journal/ledger.service.js';
+import { CreditService } from './credit.service.js';
 import { CustomerGroupsService } from './customer-groups.service.js';
 import { CustomersService } from './customers.service.js';
 
@@ -14,6 +15,7 @@ export class CustomersController {
   constructor(
     private readonly customers: CustomersService,
     private readonly ledgers: LedgerService,
+    private readonly credits: CreditService,
   ) {}
 
   @Endpoint(routes.customers.list)
@@ -65,6 +67,12 @@ export class CustomersController {
   }: RouteInput<Routes['statement']>): Promise<RouteResponse<Routes['statement']>> {
     return this.ledgers.statement(params.id, query);
   }
+
+  // Step 15c: also sales.customer.balance — the numbers say what the customer owes
+  @Endpoint(routes.customers.credit)
+  credit({ params }: RouteInput<Routes['credit']>): Promise<RouteResponse<Routes['credit']>> {
+    return this.credits.get(params.id);
+  }
 }
 
 @Controller()
```

- **`GET /customers/:id/credit`** sits with the customer's other routes. The service is called `credits` in the
  constructor because the method is named `credit`, after the route.

```diff
@@ -7,26 +7,34 @@ import { RbacModule } from '../rbac/rbac.module.js';
 import { BalanceAccess } from './balance-access.js';
 import { CustomerGroupsService } from './customer-groups.service.js';
 import { CustomerGroupsController, CustomersController } from './customers.controller.js';
+import { CreditService } from './credit.service.js';
 import { CustomersService } from './customers.service.js';
 import { DeliveriesService } from './deliveries.service.js';
+import { InvoicesService } from './invoices.service.js';
 import { PriceListsController } from './price-lists.controller.js';
 import { PriceListsService } from './price-lists.service.js';
 import { PriceLookupService } from './price-lookup.service.js';
 import { QuotationsService } from './quotations.service.js';
+import { ReceiptsService } from './receipts.service.js';
+import { SalesBooksService } from './sales-books.service.js';
 import {
   DeliveriesController,
+  InvoicesController,
   QuotationsController,
+  ReceiptsController,
   SalesOrdersController,
   SalesPricesController,
 } from './sales-documents.controller.js';
 import { SalesOrdersService } from './sales-orders.service.js';
 
 // Sales (step 15): customers, their groups and the price lists in 15a; quotations, orders,
-// deliveries and the price lookup in 15b; invoices and returns join in 15c–15d. NumberingModule
-// gives the codes and document numbers (C-00042, QT-, SO-, DC-), JournalModule the LedgerService
-// behind a customer's statement, RbacModule the permission check of BalanceAccess. InventoryModule
-// (15b) gives a delivery what every stock document uses: StockPostingService moves the stock,
-// StockBooksService books its cost, ValueAccess hides that cost without inventory.stock.value.
+// deliveries and the price lookup in 15b; invoices, money receipts and the credit limit in 15c;
+// returns join in 15d. NumberingModule gives the codes and document numbers (C-00042, QT-, SO-,
+// DC-, INV-, MR-), JournalModule the LedgerService behind a customer's statement and the
+// PostingService behind SalesBooksService, RbacModule the permission checks of BalanceAccess and
+// CreditService. InventoryModule (15b) gives a delivery what every stock document uses:
+// StockPostingService moves the stock, StockBooksService books its cost, ValueAccess hides that
+// cost without inventory.stock.value.
 @Module({
   imports: [NumberingModule, JournalModule, RbacModule, InventoryModule],
   controllers: [
@@ -37,6 +45,8 @@ import { SalesOrdersService } from './sales-orders.service.js';
     QuotationsController,
     SalesOrdersController,
     DeliveriesController,
+    InvoicesController,
+    ReceiptsController,
   ],
   providers: [
     CustomersService,
@@ -47,6 +57,10 @@ import { SalesOrdersService } from './sales-orders.service.js';
     QuotationsService,
     SalesOrdersService,
     DeliveriesService,
+    CreditService,
+    SalesBooksService,
+    InvoicesService,
+    ReceiptsService,
   ],
 })
 export class SalesModule {}
```

- **No new imports.** `PostingService` comes from `JournalModule` and `PermissionService` from `RbacModule`, both
  already imported for 15a and 15b.

### Accounts that hold money

```diff
@@ -21,6 +21,7 @@ function toAccount(row: AccountRow): Account {
     type: row.type,
     isGroup: row.isGroup,
     purpose: row.purpose,
+    holdsMoney: row.holdsMoney,
     description: row.description,
     archivedAt: row.archivedAt?.toISOString() ?? null,
     version: row.version,
@@ -30,8 +31,27 @@ function toAccount(row: AccountRow): Account {
 
 // What the audit log shows: the form's fields, with the group as its code — an id would mean
 // nothing to the person reading the log
-function snapshot(row: Pick<AccountRow, 'code' | 'name' | 'description'>, parent: string | null) {
-  return { code: row.code, name: row.name, description: row.description, parent };
+function snapshot(
+  row: Pick<AccountRow, 'code' | 'name' | 'description' | 'holdsMoney'>,
+  parent: string | null,
+) {
+  return {
+    code: row.code,
+    name: row.name,
+    description: row.description,
+    holdsMoney: row.holdsMoney,
+    parent,
+  };
+}
+
+// Money is an asset (step 15c). The type comes from the group, so only the server can tell; the
+// database checks it too (ledger_accounts_money_type), as the last word.
+function assertMoneyType(holdsMoney: boolean, type: AccountRow['type']): void {
+  if (holdsMoney && type !== 'asset') {
+    throw new AppError(409, 'account_money_type', 'Only an asset account can hold money.', {
+      fieldErrors: { holdsMoney: ['account_money_type'] },
+    });
+  }
 }
 
 function codeTaken(code: string): AppError {
@@ -120,6 +140,7 @@ export class AccountsService {
       return await this.withTenant(async (tx) => {
         await lockChart(tx);
         const parent = await this.parent(tx, input.parentId);
+        assertMoneyType(input.holdsMoney, parent.type);
         const [row] = await tx
           .insert(ledgerAccounts)
           .values({
@@ -130,6 +151,7 @@ export class AccountsService {
             isGroup: input.isGroup,
             code: input.code,
             name: input.name,
+            holdsMoney: input.holdsMoney,
             description: input.description,
             createdBy: currentPrincipal().userId,
           })
@@ -156,6 +178,8 @@ export class AccountsService {
         await lockChart(tx);
         const before = await this.lock(tx, id, true);
         if (before.version !== input.version) throw versionConflict();
+        // A move keeps the type (move() refuses another type), so the account's own is the one
+        assertMoneyType(input.holdsMoney, before.type);
         const parentBefore = await this.codeOf(tx, before.parentId);
         const parentAfter =
           input.parentId === before.parentId
@@ -165,6 +189,7 @@ export class AccountsService {
           parentId: input.parentId,
           code: input.code,
           name: input.name,
+          holdsMoney: input.holdsMoney,
           description: input.description,
         });
         await audit(tx, {
@@ -266,6 +291,7 @@ export class AccountsService {
             code: null,
             name: null,
             description: null,
+            holdsMoney: null,
             parent: null,
           }),
         });
@@ -282,7 +308,11 @@ export class AccountsService {
         );
       }
       // Journal lines point at it (a draft's too): the history must keep its account
-      if (isForeignKeyViolation(error, 'journal_lines_account_fk')) {
+      // Money receipts name it too (step 15c), though each one's entry already does
+      if (
+        isForeignKeyViolation(error, 'journal_lines_account_fk') ||
+        isForeignKeyViolation(error, 'receipts_account_fk')
+      ) {
         throw new AppError(409, 'account_in_use', 'Archive this account instead: entries use it.');
       }
       // Chosen for a stock use in Settings → Inventory (step 14)
@@ -362,7 +392,9 @@ export class AccountsService {
   private async write(
     tx: Transaction,
     id: string,
-    fields: Partial<Pick<AccountRow, 'parentId' | 'code' | 'name' | 'description' | 'archivedAt'>>,
+    fields: Partial<
+      Pick<AccountRow, 'parentId' | 'code' | 'name' | 'holdsMoney' | 'description' | 'archivedAt'>
+    >,
   ): Promise<AccountRow> {
     const [row] = await tx
       .update(ledgerAccounts)
```

- **`assertMoneyType()`.** Only an asset can hold money. The type comes from the group, so the form cannot know it
  and the contract cannot check it. On create, the type is the parent's; on update, the account's own (a move
  never changes the type: `move()` refuses another one). The database has the same rule as a check
  (`ledger_accounts_money_type`, 15c.2).
- **`holdsMoney` in the audit snapshot**, so the log shows who ticked or unticked it.
- **`receipts_account_fk` → `account_in_use`.** A receipt's entry already holds on to the account, so the journal
  line's foreign key would usually answer first. The receipt's own key is mapped too, so the answer never depends
  on which check Postgres runs first.

```diff
@@ -21,6 +21,8 @@ export interface AccountTemplate {
   code: string;
   name: string;
   purpose?: AccountPurpose;
+  // Step 15c: money is kept here. On a group, every account the company adds under it.
+  holdsMoney?: true;
   children?: readonly AccountTemplate[];
 }
 
@@ -145,6 +160,11 @@ function group(
   return { code, name, children };
 }
 
+// Step 15c: an account or a group that holds money (a money receipt goes into one of these)
+function money(node: AccountTemplate): AccountTemplate {
+  return { ...node, holdsMoney: true };
+}
+
 // exactOptionalPropertyTypes: `purpose: undefined` is not the same as no purpose, so the key is
 // only added when there is one
 function account(code: string, name: string, purpose?: AccountPurpose): AccountTemplate {
@@ -177,10 +197,11 @@ function standardChart(industry: IndustryAccounts): ChartTemplate {
   return {
     asset: group('1000', 'Assets', [
       group('1100', 'Current assets', [
-        account('1110', 'Cash in hand', 'cash'),
-        // Empty: every company adds its own banks ("Dutch-Bangla Bank CD A/C …") and wallets
-        group('1120', 'Bank accounts'),
-        group('1130', 'Mobile wallets (bKash, Nagad)'),
+        money(account('1110', 'Cash in hand', 'cash')),
+        // Empty: every company adds its own banks ("Dutch-Bangla Bank CD A/C …") and wallets. The
+        // groups hold money, so each bank added under them is a money account with no tick of its own.
+        money(group('1120', 'Bank accounts')),
+        money(group('1130', 'Mobile wallets (bKash, Nagad)')),
         account('1140', 'Accounts receivable', 'accounts_receivable'),
         industry.stock,
         group('1160', 'Advances, deposits and prepayments', [
```

- **`money()`** flags a template node. Cash in hand and the two groups are flagged; every bank or wallet the
  company adds under a group is then a money account without a tick of its own. Migration 0030 flagged the same
  three in workspaces that already exist.

```diff
@@ -43,6 +43,7 @@ export async function seedChart(
           type,
           isGroup: node.children !== undefined,
           purpose: node.purpose ?? null,
+          holdsMoney: node.holdsMoney ?? false,
         })),
       )
       .returning({ id: ledgerAccounts.id, code: ledgerAccounts.code });
```

```diff
@@ -60,6 +60,17 @@ describe.each(INDUSTRIES)('the %s chart', (industry) => {
     }
   });
 
+  // Step 15c: a money receipt needs somewhere to put the money from the first day
+  it('flags cash and the bank and wallet groups as money, and only assets', () => {
+    const money = ACCOUNT_TYPES.flatMap((type) =>
+      flatten(chart[type])
+        .filter((node) => node.holdsMoney === true)
+        .map((node) => ({ code: node.code, type, purpose: node.purpose })),
+    );
+    expect(money.every((node) => node.type === 'asset')).toBe(true);
+    expect(money.some((node) => node.purpose === 'cash')).toBe(true);
+  });
+
   it('starts each type with a group, and puts every code under its type digit', () => {
     ACCOUNT_TYPES.forEach((type, index) => {
       expect(chart[type].children).toBeDefined();
```

- **The test** checks every industry's chart: something is flagged, it is an asset, and cash is among it. A new
  workspace must be able to take money on its first day.

### The rest: Reverse, and what holds on to a customer or a product

```diff
@@ -1,5 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  isSalesJournalSource,
   isStockJournalSource,
   type JournalEntry,
   type JournalEntryInput,
@@ -198,6 +199,17 @@ export class JournalService {
             'This entry belongs to a stock document. Post another stock document to correct it.',
           );
         }
+        if (isSalesJournalSource(entry.source)) {
+          // An invoice's or a receipt's entry (step 15c): reversing it here would leave the
+          // document saying one thing and the books another. A credit note corrects an invoice
+          // (15d); a receipt is voided on its own page, which reverses the entry and takes its
+          // money off the invoices in one step.
+          throw new AppError(
+            409,
+            'journal_is_sales',
+            'This entry belongs to an invoice or a money receipt. Correct it from that document.',
+          );
+        }
         if (entry.version !== input.version) throw versionConflict();
         const [already] = await tx
           .select({ id: reversal.id })
```

- **`journal_is_sales`.** Reversing an invoice's entry in the journal would make the books say the sale never
  happened while the invoice still says it did. A receipt is voided on its own page, which reverses the entry *and*
  takes its money off the invoices.

```diff
@@ -42,7 +42,7 @@ export interface NewEntry {
   source: JournalSource;
   // Only for source 'reversal'
   reversalOfId?: string;
-  // Only for a stock document's entry (step 14): the document that made it
+  // Only for a document's entry: a stock document's (step 14), an invoice's or a receipt's (15c)
   document?: { id: string; number: string };
   lines: readonly LineInput[];
 }
```

```diff
@@ -84,6 +84,9 @@ const CUSTOMER_IN_USE = [
   'quotations_customer_fk',
   'sales_orders_customer_fk',
   'deliveries_customer_fk',
+  // step 15c
+  'invoices_customer_fk',
+  'receipts_customer_fk',
 ] as const;
 
 function codeTaken(): AppError {
```

```diff
@@ -62,6 +62,8 @@ const VARIANT_IN_USE = [
   'quotation_lines_variant_fk',
   'sales_order_lines_variant_fk',
   'delivery_lines_variant_fk',
+  // step 15c
+  'invoice_lines_variant_fk',
 ] as const;
 
 // The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
```

- **The new foreign keys** join the lists that turn a database error into `customer_in_use` and
  `product_variant_in_use`. A customer with an invoice or a receipt, and a product on an invoice line, can be
  archived but not deleted.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm lint
```

`apps/api` type checks, and its unit tests pass (including the new template test). We also ran a short
integration test against a real Postgres: an invoice billing a challan line and an order's service line (with its
entry, due date, billing address and the order's invoiced quantities), the same challan line billed twice, Reverse
on the invoice's entry, the customer's credit numbers, a direct invoice with its own challan (and its stock error
under the right line), an order over the limit refused and then overridden (with its audit row), a receipt applied,
re-applied, over-applied and voided, a non-money account refused, and an order of services that cannot be reopened
or cancelled once billed, but can be closed. 15b's own sales tests still pass. 15c.4 turns that test into the full
suite.

Two things still fail, as expected:

- **The accounts and journal integration tests** post accounts without `holdsMoney`, which the contract now
  requires (15c.1). 15c.4 updates them.
- **`pnpm typecheck` for the whole repo**: `packages/i18n` needs the new keys (15c.5), and the app's account form and
  mocks need the new fields (15c.6, 15c.7).

## 15c.4 — `apps/api`: the tests

This part adds one test file and extends five others. Like every integration test since step 5, they run against a
real Postgres and the real worker:

- `sales/invoices.int.spec.ts` (new) follows the distributor of 15b through its bills: challans and an order's
  service billed, a counter sale billed and delivered by one invoice, credit limits that stop an order or a bill,
  and the money receipts that pay the invoices, are applied again, and are voided.
- `sales/sales.tenant-leak.int.spec.ts` gets a third `describe`: workspace A must never see, change, pay or bill
  anything of workspace B's.
- `accounts/accounts.int.spec.ts` tests the new "holds money" tick. It and three other files send `holdsMoney`
  in every account form, because the contract now requires it (15c.1).
- `numbering/numbering.int.spec.ts` counts the number series, and 15c adds one.

The 15c.3 code passed these tests as written, so no code above was changed by this part.

### The account tests: `holdsMoney` in every form

```diff
@@ -6,6 +6,7 @@ import {
   accountSchema,
   auditPageSchema,
   meResponseSchema,
+  moneyAccountIds,
   problemSchema,
   setupSchema,
 } from '@omnivo/contracts';
@@ -114,18 +115,26 @@ async function byCode(code: string): Promise<Account> {
 
 async function create(parentCode: string, code: string, name: string, isGroup = false) {
   const parent = await byCode(parentCode);
-  return send('POST', '/accounts', { parentId: parent.id, code, name, isGroup, description: '' });
+  return send('POST', '/accounts', {
+    parentId: parent.id,
+    code,
+    name,
+    isGroup,
+    holdsMoney: false,
+    description: '',
+  });
 }
 
 // The form sends every field; these tests change one or two
 async function edit(
   account: Account,
-  change: Partial<Record<'parentId' | 'code' | 'name', string>>,
+  change: Partial<Record<'parentId' | 'code' | 'name', string> & { holdsMoney: boolean }>,
 ) {
   return send('PUT', `/accounts/${account.id}`, {
     parentId: account.parentId,
     code: account.code,
     name: account.name,
+    holdsMoney: account.holdsMoney,
     description: account.description ?? '',
     version: account.version,
     ...change,
@@ -173,6 +182,7 @@ describe('adding accounts', () => {
         code: '1199',
         name: 'Petty cash',
         isGroup: false,
+        holdsMoney: false,
         description: '',
       });
       expect(res.statusCode).toBe(409);
@@ -254,6 +264,58 @@ describe('moving accounts', () => {
   });
 });
 
+describe('money accounts', () => {
+  it('starts with cash, the bank group and the wallet group holding money', async () => {
+    const flagged = (await chart()).filter((account) => account.holdsMoney);
+    expect(flagged.map((account) => account.code)).toEqual(['1110', '1120', '1130']);
+    // Not ticked itself, but inside a group that is (moved to 1130 above), so money can go in
+    const bank = await byCode('1121');
+    expect(bank.holdsMoney).toBe(false);
+    expect(moneyAccountIds(await chart()).has(bank.id)).toBe(true);
+  });
+
+  it('lets an asset account hold money, and nothing else', async () => {
+    const res = await send('POST', '/accounts', {
+      parentId: (await byCode('1100')).id,
+      code: '1105',
+      name: 'Petty cash, Gazipur factory',
+      isGroup: false,
+      holdsMoney: true,
+      description: '',
+    });
+    expect(res.statusCode).toBe(201);
+    expect(accountSchema.parse(res.json()).holdsMoney).toBe(true);
+
+    const liability = await send('POST', '/accounts', {
+      parentId: (await byCode('2100')).id,
+      code: '2195',
+      name: 'Cash from buyers',
+      isGroup: false,
+      holdsMoney: true,
+      description: '',
+    });
+    expect(liability.statusCode).toBe(409);
+    expect(problemSchema.parse(liability.json()).fieldErrors).toEqual({
+      holdsMoney: ['account_money_type'],
+    });
+    const expense = await edit(await byCode('5200'), { holdsMoney: true });
+    expect(problemSchema.parse(expense.json()).code).toBe('account_money_type');
+  });
+
+  it('takes the tick off, and logs it', async () => {
+    const res = await edit(await byCode('1105'), { holdsMoney: false });
+    expect(res.statusCode).toBe(200);
+    expect(accountSchema.parse(res.json()).holdsMoney).toBe(false);
+    const { items } = auditPageSchema.parse(
+      (await send('GET', '/audit-logs?entityType=account')).json(),
+    );
+    expect(items[0]).toMatchObject({
+      action: 'account.updated',
+      changes: { holdsMoney: { from: true, to: false } },
+    });
+  });
+});
+
 describe('archiving and deleting', () => {
   it('protects top-level groups and system accounts', async () => {
     for (const code of ['1000', '1140']) {
@@ -328,7 +390,14 @@ describe('permissions', () => {
     const res = await send(
       'POST',
       '/accounts',
-      { parentId: parent.id, code: '1122', name: 'BRAC Bank', isGroup: false, description: '' },
+      {
+        parentId: parent.id,
+        code: '1122',
+        name: 'BRAC Bank',
+        isGroup: false,
+        holdsMoney: false,
+        description: '',
+      },
       viewer,
     );
     expect(res.statusCode).toBe(403);
```

- **`create()` and `edit()` send `holdsMoney`.** The form always sends every field, and the contract makes this one
  required (15c.1): without it every account test would get a 400 for a field it is not about. `edit()` sends the
  account's own value, and a test that is about the tick changes it like any other field.
- **The template flags three accounts**: cash in hand (1110) and the two groups, bank accounts (1120) and mobile
  wallets (1130). The bank account the earlier tests made (1121) is not ticked itself, but `moneyAccountIds()`
  still counts it, because a group above it is ticked. That is the rule the receipt form and the API share.
- **Money is an asset.** A liability and an expense group are refused with `account_money_type`, on create (the
  type comes from the new account's group) and on update (the account's own type). The error sits under
  `holdsMoney`, the box the person can untick.
- **Taking the tick off is logged** like any other change of the account form (`holdsMoney: true → false`).

```diff
@@ -375,6 +375,7 @@ describe('a posted entry', () => {
           code: '1121',
           name: 'Dutch-Bangla Bank CD A/C 1234',
           isGroup: false,
+          holdsMoney: false,
           description: '',
         })
       ).json(),
@@ -418,6 +419,7 @@ describe('the ledger', () => {
           code: '5295',
           name: 'Tea and entertainment',
           isGroup: false,
+          holdsMoney: false,
           description: '',
         })
       ).json(),
```

```diff
@@ -105,6 +105,7 @@ describe('chart of accounts isolation over HTTP', () => {
       code: '1129',
       name: 'Borrowed group',
       isGroup: false,
+      holdsMoney: false,
       description: '',
     });
     expect(res.statusCode).toBe(409);
@@ -117,6 +118,7 @@ describe('chart of accounts isolation over HTTP', () => {
       parentId: target.parentId,
       code: '5330',
       name: 'Taken over',
+      holdsMoney: false,
       description: '',
       version: 1,
     };
```

- **The same one field in the journal and tenant-leak tests.** In the tenant-leak test it matters more than it
  looks: without it, A's attempt to change B's account would be a 400 from the contract, and the test that expects
  a 404 would fail for the wrong reason, or, worse, pass on a check that never reached the tenant filter.

### `sales/invoices.int.spec.ts` (new): the setup

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  type Customer,
  customerCreditSchema,
  customerSchema,
  type Delivery,
  deliveryPageSchema,
  deliverySchema,
  type Invoice,
  type InvoiceFormValues,
  type InvoiceLineFormValues,
  invoicePageSchema,
  invoiceSchema,
  journalEntrySchema,
  memberPageSchema,
  meResponseSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type Receipt,
  type ReceiptFormValues,
  receiptPageSchema,
  receiptSchema,
  roleSchema,
  type SalesLineFormValues,
  type SalesOrder,
  type SalesOrderFormValues,
  salesOrderPageSchema,
  salesOrderSchema,
  type Settings,
  settingsSchema,
  setupSchema,
  stockCardSchema,
  stockPageSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
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

// Step 15c: invoices, money receipts and the credit limit, for the distributor of step 15b. Juice
// by the piece and the case, Napa in batches, biscuits that get archived, a delivery charge that is
// a service. Bhairab Bazar Traders buys on 30 days with no limit, Ashulia Super Shop pays on the
// day, Madhabdi Bazar Store and Raipura Traders have credit limits. Each test builds on the ones
// before it, like the 15b tests: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let tenantId: string;
// A member with no role: reads invoices and receipts, writes neither
let viewer: SignedIn;
// A sales officer: writes orders, challans, invoices and receipts, but may not go over a limit
let clerk: SignedIn;
let units: Unit[];
let accounts: Account[];
let rates: TaxRate[];
let main: Warehouse;
let juice: Product;
let napa: Product;
let biscuit: Product;
let carriage: Product;
let bhairab: Customer;
let ashulia: Customer;
let madhabdi: Customer;
let raipura: Customer;
// Bhairab's order: 48 pieces of juice and the delivery charge
let order: SalesOrder;
let challan: Delivery;
let firstInvoice: Invoice;
// Another confirmed order of Bhairab's, priced without VAT, whose delivery charge nobody billed yet
let carriageOrder: SalesOrder;
// Ashulia's counter sale, a direct invoice
let counterInvoice: Invoice;
// A draft of Ashulia's that stays a draft: the lists, the receipts and the permissions use it
let leftDraft: Invoice;
// Madhabdi's order that fits under the limit
let madhabdiOrder: SalesOrder;
let cashReceipt: Receipt;
let bankReceipt: Receipt;
// Bhairab's invoices, by the number they ended with
const bhairabInvoices = new Map<string, Invoice>();
```

- **One workspace, one story**, as in 15b. Each test builds on the ones before it: the order of the first test is
  billed by later ones, the invoices it makes are the ones the receipts pay, and every number can be followed by
  hand from the opening stock. When a test fails, read the first failure first.
- **Four customers, one for each kind of terms.** Bhairab Bazar Traders buys on 30 days with no limit (its credit
  is never checked). Ashulia Super Shop pays on the day (0 days, so its due date is the invoice date). Madhabdi
  Bazar Store has a ৳5,000 limit, Raipura Traders a ৳1,000 one, so the credit tests do not depend on the invoices
  of the others.
- **Three users.** The owner has every permission. `viewer` has no role: reading invoices and receipts needs no
  permission, writing them needs one of the new ones. `clerk` has a role that writes orders, challans, invoices and
  receipts, but not `sales.credit.override`: the one person who can be told "over the limit, and you may not go
  ahead".
- **`bhairabInvoices` keeps Bhairab's invoices by number.** The receipts pay them by number ("INV-0004 gets the
  bank transfer"), which is how an accountant talks about them, and a typo in a number fails loudly
  (`bhairabInvoice()` throws).

```ts
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

function rateId(name: string): string {
  const found = rates.find((rate) => rate.name === name);
  if (!found) throw new Error(`no VAT rate ${name}`);
  return found.id;
}

function account(code: string): string {
  const found = accounts.find((item) => item.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((item) => item.id === id)?.code ?? id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function orderLine(saved: SalesOrder, product: Product): string {
  const found = saved.lines.find((item) => item.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${saved.number ?? 'the order'}`);
  return found.id;
}

function challanLine(delivery: Delivery, index = 0): string {
  const found = delivery.lines[index];
  if (!found) throw new Error(`no line ${String(index)} on ${delivery.number ?? 'the challan'}`);
  return found.id;
}

function bhairabInvoice(number: string): Invoice {
  const found = bhairabInvoices.get(`INV-2026-27-${number}`);
  if (!found) throw new Error(`no invoice ${number}`);
  return found;
}

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
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
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  } satisfies ProductFormValues);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

async function addCustomer(name: string, extra: object = {}) {
  const res = await send('POST', '/customers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

function settingsForm(settings: Settings, pricesIncludeVat: boolean) {
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
    pricesIncludeVat,
  };
}

async function setPricesIncludeVat(on: boolean): Promise<void> {
  const settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const res = await send('PUT', '/settings', settingsForm(settings, on));
  expect(res.statusCode, res.body).toBe(200);
}

// A line as the form sends it: by the piece, at 15% VAT, no discount, the product's own name
function salesLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<SalesLineFormValues> = {},
): SalesLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    ...extra,
  };
}

// An invoice line: a line of its own unless extra names a challan line or an order line
function invoiceLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<InvoiceLineFormValues> = {},
): InvoiceLineFormValues {
  return {
    ...salesLine(product, quantity, unitPrice),
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
    ...extra,
  };
}

function invoiceForm(
  lines: InvoiceLineFormValues[],
  extra: Partial<InvoiceFormValues> = {},
): Omit<InvoiceFormValues, 'version'> {
  return {
    customerId: bhairab.id,
    date: '2026-10-06',
    dueDate: '',
    customerReference: '',
    branchId: main.branchId,
    warehouseId: '',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function invoiced(body: object, as = owner): Promise<Invoice> {
  const res = await send('POST', '/invoices', body, as);
  expect(res.statusCode, res.body).toBe(201);
  const saved = invoiceSchema.parse(res.json());
  if (saved.customer.id === bhairab.id && saved.number !== null) {
    bhairabInvoices.set(saved.number, saved);
  }
  return saved;
}

async function invoiceNow(id: string): Promise<Invoice> {
  return invoiceSchema.parse((await send('GET', `/invoices/${id}`)).json());
}

async function invoiceNumbers(query: string): Promise<(string | null)[]> {
  const page = invoicePageSchema.parse((await send('GET', `/invoices?${query}`)).json());
  return page.items.map((item) => item.number);
}

function orderForm(
  lines: SalesLineFormValues[],
  extra: Partial<SalesOrderFormValues> = {},
): Omit<SalesOrderFormValues, 'version'> {
  return {
    customerId: bhairab.id,
    date: '2026-10-02',
    deliveryDate: '',
    customerReference: '',
    warehouseId: main.id,
    shippingAddressId: '',
    note: '',
    lines,
    confirm: true,
    ...extra,
  };
}

async function ordered(body: object): Promise<SalesOrder> {
  const res = await send('POST', '/sales-orders', body);
  expect(res.statusCode, res.body).toBe(201);
  return salesOrderSchema.parse(res.json());
}

async function orderNow(id: string): Promise<SalesOrder> {
  return salesOrderSchema.parse((await send('GET', `/sales-orders/${id}`)).json());
}

function deliveryLine(product: Product, quantity: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    serialNumbers: [],
    orderLineId: '',
    ...extra,
  };
}

function deliveryForm(customer: Customer, orderId: string, lines: object[], extra: object = {}) {
  return {
    customerId: customer.id,
    orderId,
    date: '2026-10-05',
    warehouseId: main.id,
    shippingAddressId: '',
    vehicle: '',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function delivered(body: object): Promise<Delivery> {
  const res = await send('POST', '/deliveries', body);
  expect(res.statusCode, res.body).toBe(201);
  return deliverySchema.parse(res.json());
}

async function deliveryNow(id: string): Promise<Delivery> {
  return deliverySchema.parse((await send('GET', `/deliveries/${id}`)).json());
}

function receiptForm(
  amount: string,
  allocations: { invoiceId: string; amount: string }[],
  extra: Partial<ReceiptFormValues> = {},
): ReceiptFormValues {
  return {
    customerId: bhairab.id,
    date: '2026-10-07',
    amount,
    accountId: account('1110'),
    method: 'cash',
    reference: '',
    branchId: main.branchId,
    note: '',
    allocations,
    ...extra,
  };
}

async function received(body: object): Promise<Receipt> {
  const res = await send('POST', '/receipts', body);
  expect(res.statusCode, res.body).toBe(201);
  return receiptSchema.parse(res.json());
}

// A journal entry as [account code, debit, credit] rows — what an accountant reads
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [codeOf(item.accountId), item.debit, item.credit]);
}

async function credit(customer: Customer) {
  const res = await send('GET', `/customers/${customer.id}/credit`);
  expect(res.statusCode, res.body).toBe(200);
  return customerCreditSchema.parse(res.json());
}

async function auditActions(entityType: string, entityId: string): Promise<string[]> {
  const page = auditPageSchema.parse(
    (await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`)).json(),
  );
  return page.items.map((item) => item.action).toSorted();
}

async function stockNow() {
  const page = stockPageSchema.parse((await send('GET', `/stock?warehouseId=${main.id}`)).json());
  return Object.fromEntries(page.items.map((item) => [item.productName, item.onHand]));
}

async function batchOf(product: Product, lotNumber: string): Promise<string> {
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(product)}`)).json(),
  );
  const found = card.batches.find((batch) => batch.lotNumber === lotNumber);
  if (!found) throw new Error(`no batch ${lotNumber}`);
  return found.batchId;
}

function openingLine(product: Product, quantity: string, unitCost: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
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

// A user who signs up for a workspace of their own, then joins this one; with a role, if given
```

- **The form builders send every field**, like 15b's: `invoiceLine()` is a sales line plus the four invoice
  fields, empty by default (a line of its own), and each test names the challan line or the order line it bills.
  `invoiceLine()` and `invoiceForm()` are typed with the contract's `InvoiceLineFormValues` and
  `InvoiceFormValues`, `receiptForm()` with `ReceiptFormValues`, so a field renamed in the contract breaks the type
  check here, not a test at run time.
- **`orderForm()` confirms by default.** Most orders in this file are there to be billed, and only a confirmed
  order can be. The credit tests ask for a draft when they want one.
- **`invoiced()` records Bhairab's posted invoices** in `bhairabInvoices` as it goes. Invoices posted by the
  separate Post route are added by the test that posts them.
- **`invoiceNumbers()` reads a list as its numbers** (`null` for a draft). The list tests are about order and
  filters, and a list of numbers says both in one line.
- **`auditActions()` sorts the actions.** The rows of one request may share a timestamp, so the order the log returns
  them in is not something to test.
- **`entryLines()`, `stockNow()` and `batchOf()`** are 15b's: an entry as `[account code, debit, credit]` rows, the
  stock on hand per product, and a lot's batch id from the stock card. The codes are the distribution chart's:
  1140 Accounts receivable, 4110 Sales, 2120 VAT payable, 1110 Cash in hand, 5110 Cost of goods sold, 1150
  Inventory.

```ts
async function member(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[] | null,
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: email.split('@')[0] ?? 'store',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'meghna-distributors' });
  if (permissions !== null) {
    // Not "Sales officer": the distribution template has a role of that name
    const made = await send('POST', '/roles', { name: 'Route sales', description: '' });
    expect(made.statusCode, made.body).toBe(201);
    const role = roleSchema.parse(made.json());
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: role.id, version: role.version, permissions }],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const found = items.find((item) => item.email === email);
    if (!found) throw new Error(`${email} is not a member`);
    const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  }
  return logIn(app, { workspace: 'meghna-distributors', email, password, keepSignedIn: false });
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
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  tenantId = meResponseSchema.parse((await send('GET', '/auth/me')).json()).tenant.id;
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;
  // A bank account inside "Bank accounts": it holds money through its group, with no tick
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const bank = await send('POST', '/accounts', {
    parentId: account('1120'),
    code: '1121',
    name: 'Dutch-Bangla Bank CD A/C 1234',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect(bank.statusCode, bank.body).toBe(201);
  accounts = [...accounts, accountSchema.parse(bank.json())];

  juice = await addProduct('Mango juice 250 ml', {
    units: [{ unitId: unitId('case'), factor: '24', barcode: '' }],
  });
  napa = await addProduct('Napa 500 mg', {
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: rateId('Exempt'),
  });
  biscuit = await addProduct('Energy Plus biscuit');
  carriage = await addProduct('Delivery charge', { type: 'service' });

  bhairab = await addCustomer('Bhairab Bazar Traders', {
    addresses: [
      {
        id: null,
        kind: 'billing',
        label: 'Head office',
        address: 'Station Road, Bhairab',
        phone: '01712-334455',
      },
    ],
  });
  ashulia = await addCustomer('Ashulia Super Shop', { paymentTermsDays: 0 });
  madhabdi = await addCustomer('Madhabdi Bazar Store', {
    paymentTermsDays: 15,
    creditLimit: '5000',
  });
  raipura = await addCustomer('Raipura Traders', { creditLimit: '1000' });

  // Opening stock: 10 cases of juice at ৳1,200 a case (৳50 a piece), one lot of Napa at ৳0.80,
  // 50 packets of biscuits at ৳8
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      openingLine(juice, '10', '1200', { unitId: unitId('case') }),
      openingLine(napa, '120', '0.80', { lotNumber: 'NP24090', expiresOn: '2027-01-31' }),
      openingLine(biscuit, '50', '8'),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);

  viewer = await member('rina@meghnadistributors.com', 'Rina Akter', 'Counter-cash-2026', null);
  clerk = await member('tanvir@meghnadistributors.com', 'Tanvir Hasan', 'Sales-route-2026', [
    'sales.order.manage',
    'sales.delivery.manage',
    'sales.invoice.manage',
    'sales.receipt.manage',
  ]);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **`member()` signs a user up for their own workspace first**, then joins this one (`joinWithoutRoles`), as in
  the 15b tests: a membership must point at a user who exists. With a list of permissions, it also makes a role
  with exactly those and gives it to the member, through the same routes the Roles page uses.
- **The role is "Route sales", not "Sales officer".** The distribution template already has a role with that
  name, and role names are unique per workspace.
- **`permissions` is typed `PermissionKey[]`**, so a misspelt permission is a type error and not a role that
  silently has nothing.
- **`tenantId` comes from `/auth/me`.** Two tests replay what a service does inside the database (below), and the
  rows they write need the workspace's id.
- **A bank account (1121) is added under "Bank accounts" with no tick.** The receipts put a bank transfer and a
  cheque into it, so the tests also show that a group's tick is enough.
- **The opening stock** is 10 cases of juice at ৳1,200 a case (৳50 a piece), one lot of Napa at ৳0.80 a tablet, and
  50 packets of biscuits at ৳8. The cost of goods sold of every challan is then a plain multiplication.

### Invoices: billing challans and orders

```ts
describe('invoices', () => {
  it("bills a challan line and an order's service line, and books the sale", async () => {
    order = await ordered(
      orderForm([salesLine(juice, '48', '25'), salesLine(carriage, '1', '500')]),
    );
    challan = await delivered(
      deliveryForm(bhairab, order.id, [
        deliveryLine(juice, '24', { orderLineId: orderLine(order, juice) }),
      ]),
    );
    expect(challan.invoiceState).toBe('not_invoiced');
    const toBill = deliveryPageSchema.parse(
      (await send('GET', `/deliveries?invoice=to_invoice&customerId=${bhairab.id}`)).json(),
    );
    expect(toBill.items.map((item) => item.id)).toEqual([challan.id]);

    firstInvoice = await invoiced(
      invoiceForm([
        invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
        invoiceLine(carriage, '1', '500', { orderLineId: orderLine(order, carriage) }),
      ]),
    );
    expect(firstInvoice).toMatchObject({
      number: 'INV-2026-27-0001',
      status: 'posted',
      net: '1100.0000',
      vat: '165.0000',
      total: '1265.0000',
      amountPaid: '0.0000',
      dueDate: '2026-11-05',
      billingAddress: 'Head office\nStation Road, Bhairab\n01712-334455',
      pricesIncludeVat: false,
      deliveries: [{ id: challan.id, number: 'DC-2026-27-0001', date: '2026-10-05' }],
      payments: [],
    });
    expect(firstInvoice.orders.map((item) => item.id)).toEqual([order.id]);
    // The server finds the order line behind the challan line
    expect(firstInvoice.lines.map((item) => item.orderLineId)).toEqual([
      orderLine(order, juice),
      orderLine(order, carriage),
    ]);
    expect(firstInvoice.lines[1]?.deliveryLineId).toBeNull();
    // Their numbers, for the draft's "From DC-…" and the printed invoice (15c.6)
    expect(firstInvoice.lines.map((item) => [item.deliveryNumber, item.orderNumber])).toEqual([
      ['DC-2026-27-0001', order.number],
      [null, order.number],
    ]);

    // The sale only: the challan booked the cost of the goods in 15b
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${firstInvoice.entry?.id ?? ''}`)).json(),
    );
    expect(entry.source).toBe('sales_invoice');
    expect(await entryLines(entry.id)).toEqual([
      ['1140', '1265.0000', '0.0000'],
      ['4110', '0.0000', '1100.0000'],
      ['2120', '0.0000', '165.0000'],
    ]);
    expect(entry.lines.map((item) => item.branchId)).toEqual([
      main.branchId,
      main.branchId,
      main.branchId,
    ]);
    expect(entry.lines.map((item) => item.party?.id ?? null)).toEqual([bhairab.id, null, null]);
    expect(await auditActions('invoice', firstInvoice.id)).toEqual([
      'invoice.created',
      'invoice.posted',
    ]);

    const billed = await deliveryNow(challan.id);
    expect(billed.invoiceState).toBe('invoiced');
    expect(billed.lines.map((item) => item.invoiced)).toEqual([true]);
    expect(billed.invoices.map((item) => item.number)).toEqual(['INV-2026-27-0001']);
    const nothingLeft = deliveryPageSchema.parse(
      (await send('GET', `/deliveries?invoice=to_invoice&customerId=${bhairab.id}`)).json(),
    );
    expect(nothingLeft.items).toEqual([]);
    const orderAfter = await orderNow(order.id);
    expect(orderAfter.lines.map((item) => item.invoicedQuantity)).toEqual(['24.0000', '1.0000']);
  });

  it("refuses lines that are not this invoice's to bill, all of them at once", async () => {
    const draftChallan = await delivered(
      deliveryForm(
        bhairab,
        order.id,
        [deliveryLine(juice, '24', { orderLineId: orderLine(order, juice) })],
        { post: false },
      ),
    );
    const res = await send(
      'POST',
      '/invoices',
      invoiceForm(
        [
          invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
          invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(draftChallan) }),
          invoiceLine(juice, '24', '25', { orderLineId: orderLine(order, juice) }),
          invoiceLine(carriage, '1', '500', { orderLineId: orderLine(order, carriage) }),
        ],
        { post: false },
      ),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_billed'],
      'lines.1.deliveryLineId': ['invoice_delivery_line_invalid'],
      'lines.2.orderLineId': ['invoice_order_line_invalid'],
      'lines.3.orderLineId': ['invoice_order_line_billed'],
    });

    const posted = await send('POST', `/deliveries/${draftChallan.id}/post`, {
      version: draftChallan.version,
    });
    expect(posted.statusCode, posted.body).toBe(200);
    challan = deliverySchema.parse(posted.json());
    expect(challan.number).toBe('DC-2026-27-0002');
    // Billed whole: half of the line is not this line. Another customer's challan is not theirs.
    const half = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(juice, '12', '25', { deliveryLineId: challanLine(challan) })]),
    );
    expect(problemOf(half).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_invalid'],
    });
    const otherCustomer = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) })], {
        customerId: ashulia.id,
      }),
    );
    expect(problemOf(otherCustomer).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_invalid'],
    });
  });

  it("refuses what the form itself can see: a line twice, two sources, a challan line's batch", async () => {
    const twice = await send(
      'POST',
      '/invoices',
      invoiceForm([
        invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
        invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
      ]),
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.1.deliveryLineId': ['invoice_line_twice'],
    });
    const mixed = await send(
      'POST',
      '/invoices',
      invoiceForm([
        invoiceLine(juice, '24', '25', {
          deliveryLineId: challanLine(challan),
          orderLineId: orderLine(order, juice),
          batchId: await batchOf(napa, 'NP24090'),
        }),
      ]),
    );
    expect(mixed.statusCode).toBe(400);
    expect(problemOf(mixed).fieldErrors).toEqual({
      'lines.0.orderLineId': ['invoice_line_source'],
      'lines.0.batchId': ['invoice_stock_not_allowed'],
    });
  });

  it('lets two drafts name the same challan line; the first to post bills it', async () => {
    const line = invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) });
    const first = await invoiced(invoiceForm([line], { post: false }));
    const second = await invoiced(invoiceForm([line], { post: false }));
    expect([first.number, first.entry, second.number]).toEqual([null, null, null]);
    // A draft claims nothing: the challan is still waiting for its bill
    expect((await deliveryNow(challan.id)).invoiceState).toBe('not_invoiced');

    const won = await send('POST', `/invoices/${first.id}/post`, { version: first.version });
    expect(won.statusCode, won.body).toBe(200);
    bhairabInvoices.set('INV-2026-27-0002', invoiceSchema.parse(won.json()));
    expect(invoiceSchema.parse(won.json()).number).toBe('INV-2026-27-0002');
    const lost = await send('POST', `/invoices/${second.id}/post`, { version: second.version });
    expect(lost.statusCode).toBe(409);
    expect(problemOf(lost).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_billed'],
    });
    const stillDraft = await invoiceNow(second.id);
    expect([stillDraft.status, stillDraft.number]).toEqual(['draft', null]);

    const removed = await send(
      'DELETE',
      `/invoices/${second.id}?version=${String(stillDraft.version)}`,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/invoices/${second.id}`)).statusCode).toBe(404);
    expect((await orderNow(order.id)).lines.map((item) => item.invoicedQuantity)).toEqual([
      '48.0000',
      '1.0000',
    ]);
  });
```

- **The first invoice bills two kinds of line.** 24 pieces from a posted challan (DC-0001), and the order's
  delivery charge, which was never delivered. 24 × ৳25 + ৳500 = ৳1,100, plus 15% VAT = ৳1,265. The due date is
  the invoice date plus Bhairab's 30 days, and the billing address is the customer's, as text on its own lines.
- **The server finds the order line behind the challan line.** The form sent only `deliveryLineId` for the juice;
  the invoice line comes back with the order line too, which is what lets the order count what is billed. Each
  line also names its challan and its order by number (15c.6): the delivery charge has an order and no challan.
- **The entry books the sale and nothing else**: Dr Accounts receivable ৳1,265 (with Bhairab on the line), Cr Sales
  ৳1,100, Cr VAT ৳165, every line on the invoice's branch. The cost of the goods is not here: the challan booked it
  in 15b. Its source is `sales_invoice`, so the journal can link it back to the invoice.
- **The challan and the order follow.** The challan is `invoiced`, lists the invoice, and drops out of the
  "to invoice" list the invoice form picks challans from. The order counts 24 pieces and the delivery charge as
  invoiced.
- **Every bad line comes back at once, each under its own box**: a challan line already billed, a line of a draft
  challan, a goods line of the order (goods are billed through their challan, never straight from the order),
  and the delivery charge that the first invoice billed.
- **A challan line is billed whole.** Half of the 24 pieces is refused as `invoice_delivery_line_invalid`, and so is
  the same line on another customer's invoice. What did not sell goes back by a return (15d), never by billing
  part of the line.
- **What the form itself can see is a 400 from the contract**: the same challan line twice on one invoice, a line
  that names both a challan line and an order line, and a batch on a challan line (the challan already says which
  batch left). These never reach the database.
- **Drafts claim nothing.** Two drafts may bill the same challan line, and the challan still waits for its bill.
  The first to post gets INV-0002; the second is refused under its line, stays a draft with no number, and can be
  deleted. A deleted draft is gone (404); it never had a number, so the numbers have no gap.

```ts
  it('delivers the goods of a direct invoice on a challan of its own', async () => {
    counterInvoice = await invoiced(
      invoiceForm(
        [
          invoiceLine(juice, '12', '30'),
          invoiceLine(napa, '50', '1.2', {
            taxRateId: rateId('Exempt'),
            batchId: await batchOf(napa, 'NP24090'),
          }),
          invoiceLine(carriage, '1', '100'),
        ],
        { customerId: ashulia.id, warehouseId: main.id },
      ),
    );
    const counter = counterInvoice;
    expect(counter).toMatchObject({
      number: 'INV-2026-27-0003',
      net: '520.0000',
      vat: '69.0000',
      total: '589.0000',
      // Ashulia pays on the day
      dueDate: '2026-10-06',
      billingAddress: null,
      orders: [],
    });
    expect(counter.deliveries.map((item) => item.number)).toEqual(['DC-2026-27-0003']);
    expect(counter.lines.map((item) => item.deliveryLineId === null)).toEqual([false, false, true]);
    expect([counter.lines[1]?.lotNumber, counter.lines[1]?.expiresOn]).toEqual([
      'NP24090',
      '2027-01-31',
    ]);

    // An ordinary challan: numbered, out of stock, with its own cost of goods sold
    const own = await deliveryNow(counter.deliveries[0]?.id ?? '');
    expect(own).toMatchObject({
      order: null,
      note: 'Invoice INV-2026-27-0003',
      invoiceState: 'invoiced',
    });
    expect(own.lines.map((item) => item.quantity)).toEqual(['12.0000', '50.0000']);
    expect(await entryLines(own.entry?.id ?? '')).toEqual([
      ['5110', '640.0000', '0.0000'],
      ['1150', '0.0000', '640.0000'],
    ]);
    expect(await entryLines(counter.entry?.id ?? '')).toEqual([
      ['1140', '589.0000', '0.0000'],
      ['4110', '0.0000', '520.0000'],
      ['2120', '0.0000', '69.0000'],
    ]);
    const stock = await stockNow();
    expect([stock['Mango juice 250 ml'], stock['Napa 500 mg']]).toEqual(['180.0000', '70.0000']);
  });

  it('checks the goods of a direct invoice like a challan, under the invoice line', async () => {
    const counterForm = (lines: InvoiceLineFormValues[], extra: Partial<InvoiceFormValues> = {}) =>
      invoiceForm(lines, { customerId: ashulia.id, warehouseId: main.id, ...extra });
    const noWarehouse = await send(
      'POST',
      '/invoices',
      counterForm([invoiceLine(carriage, '1', '100'), invoiceLine(juice, '1', '30')], {
        warehouseId: '',
        post: false,
      }),
    );
    expect(problemOf(noWarehouse).fieldErrors).toEqual({
      warehouseId: ['invoice_warehouse_required'],
    });
    const serviceBatch = await send(
      'POST',
      '/invoices',
      counterForm([invoiceLine(carriage, '1', '100', { batchId: await batchOf(napa, 'NP24090') })]),
    );
    expect(problemOf(serviceBatch).fieldErrors).toEqual({
      'lines.0.batchId': ['invoice_stock_not_allowed'],
    });
    const noBatch = await send(
      'POST',
      '/invoices',
      counterForm([
        invoiceLine(carriage, '1', '100'),
        invoiceLine(napa, '10', '1.2', { taxRateId: rateId('Exempt') }),
      ]),
    );
    expect(Object.keys(problemOf(noBatch).fieldErrors ?? {})).toEqual(['lines.1.batchId']);
    expect(problemOf(noBatch).code).toBe('stock_batch_required');

    // Only 180 pieces left: refused at posting, under the invoice's own line 1
    const tooMany = await send(
      'POST',
      '/invoices',
      counterForm([invoiceLine(carriage, '1', '100'), invoiceLine(juice, '9999', '30')]),
    );
    expect(tooMany.statusCode).toBe(409);
    expect(Object.keys(problemOf(tooMany).fieldErrors ?? {})).toEqual(['lines.1.quantity']);
    // Save and post is one step: nothing was kept, no number was used
    expect(await invoiceNumbers(`customerId=${ashulia.id}`)).toEqual(['INV-2026-27-0003']);
  });

  it('bills the challan of a product archived since, but sells it no more', async () => {
    const loose = await delivered(
      deliveryForm(bhairab, '', [deliveryLine(biscuit, '20')], { date: '2026-10-05' }),
    );
    const archived = await send('POST', `/products/${biscuit.id}/archive`, {
      version: biscuit.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    // A challan without an order has no price: the invoice says what it costs
    const bill = await invoiced(
      invoiceForm([invoiceLine(biscuit, '20', '12', { deliveryLineId: challanLine(loose) })]),
    );
    expect(bill).toMatchObject({ number: 'INV-2026-27-0004', total: '276.0000', orders: [] });
    const more = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(biscuit, '5', '12')], { warehouseId: main.id, post: false }),
    );
    expect(problemOf(more).fieldErrors).toEqual({ 'lines.0.variantId': ['sales_item_invalid'] });
  });

  it('reads prices one way per invoice: the way its orders read them', async () => {
    await setPricesIncludeVat(true);
    const withVat = await ordered(orderForm([salesLine(carriage, '1', '575')]));
    await setPricesIncludeVat(false);
    carriageOrder = await ordered(orderForm([salesLine(carriage, '1', '500')]));

    const mixed = await send(
      'POST',
      '/invoices',
      invoiceForm([
        invoiceLine(carriage, '1', '575', { orderLineId: orderLine(withVat, carriage) }),
        invoiceLine(carriage, '1', '500', { orderLineId: orderLine(carriageOrder, carriage) }),
      ]),
    );
    expect(problemOf(mixed).code).toBe('invoice_vat_mixed');
    // The workspace now prices without VAT; the order still says ৳575 holds the VAT
    const bill = await invoiced(
      invoiceForm([
        invoiceLine(carriage, '1', '575', { orderLineId: orderLine(withVat, carriage) }),
      ]),
    );
    expect(bill).toMatchObject({
      number: 'INV-2026-27-0005',
      pricesIncludeVat: true,
      net: '500.0000',
      vat: '75.0000',
      total: '575.0000',
    });
  });
```

- **A direct invoice delivers its own goods.** Ashulia buys 12 pieces of juice, 50 tablets of Napa from lot
  NP24090 and a delivery charge over the counter. Posting makes challan DC-0003 for the two goods lines (the
  service is not delivered), with the note "Invoice INV-0003", no order, and its own cost of goods sold: 12 × ৳50 +
  50 × ৳0.80 = ৳640. The invoice's own entry is the sale: ৳520 + ৳69 VAT (Napa is exempt).
- **The invoice line keeps the batch and its expiry** (NP24090, 31 Jan 2027), so the printed invoice of 15c.6 can
  show them, as a pharmacy's invoice must.
- **The goods of a direct invoice are checked like a challan's, under the invoice's lines.** No warehouse is
  `invoice_warehouse_required` (on save, even for a draft: which lines are goods only the server knows). A batch on
  a service is `invoice_stock_not_allowed`. Napa without a batch is `stock_batch_required` under `lines.1.batchId`:
  the invoice's line 1, although it is line 0 of the challan it would make.
- **Too many pieces are refused at posting, under the invoice's line**: `lines.1.quantity`, the juice, not the
  delivery charge on line 0. Save and post is one step, so nothing was kept: Ashulia still has only INV-0003.
- **An archived product can still be billed for what already left.** The biscuits leave on a challan without an
  order, and the product is archived the next day. The bill for that challan goes out (INV-0004, priced on the
  invoice: a challan without an order has no price). A line of its own with the same biscuits is refused
  (`sales_item_invalid`): we do not sell them any more.
- **One invoice reads its prices one way.** One order of Bhairab's was confirmed while prices included VAT, one
  after the setting was switched off. Billing both on one invoice is `invoice_vat_mixed`. Billing the first alone
  reads ৳575 the order's way, with the VAT inside (৳500 + ৳75), although the workspace now says prices are before
  VAT.

```ts
  it('changes a draft until it is posted, and never after', async () => {
    const early = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(carriage, '1', '100')], {
        customerId: ashulia.id,
        dueDate: '2026-10-01',
      }),
    );
    expect(early.statusCode).toBe(400);
    expect(problemOf(early).fieldErrors).toEqual({ dueDate: ['invoice_due_date'] });

    const draft = await invoiced(
      invoiceForm([invoiceLine(carriage, '1', '100')], { customerId: ashulia.id, post: false }),
    );
    expect(draft.dueDate).toBe('2026-10-06');
    const changed = await send('PUT', `/invoices/${draft.id}`, {
      ...invoiceForm([invoiceLine(carriage, '1', '100')], {
        customerId: ashulia.id,
        dueDate: '2026-10-20',
        customerReference: 'Indent 77',
      }),
      version: draft.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const posted = invoiceSchema.parse(changed.json());
    expect(posted).toMatchObject({
      number: 'INV-2026-27-0006',
      dueDate: '2026-10-20',
      customerReference: 'Indent 77',
      total: '115.0000',
    });

    const again = await send('PUT', `/invoices/${posted.id}`, {
      ...invoiceForm([invoiceLine(carriage, '1', '1')], { customerId: ashulia.id }),
      version: posted.version,
    });
    expect(problemOf(again).code).toBe('sales_not_draft');
    const repost = await send('POST', `/invoices/${posted.id}/post`, { version: posted.version });
    expect(problemOf(repost).code).toBe('sales_not_draft');
    const remove = await send('DELETE', `/invoices/${posted.id}?version=${String(posted.version)}`);
    expect(problemOf(remove).code).toBe('sales_not_draft');

    // A free sample: a real invoice, with nothing to book and nothing to pay
    const free = await invoiced(
      invoiceForm([invoiceLine(carriage, '1', '0')], { customerId: ashulia.id }),
    );
    expect(free).toMatchObject({ number: 'INV-2026-27-0007', total: '0.0000', entry: null });

    leftDraft = await invoiced(
      invoiceForm([invoiceLine(carriage, '1', '100')], { customerId: ashulia.id, post: false }),
    );
  });

  it("stays out of the journal's Reverse", async () => {
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${firstInvoice.entry?.id ?? ''}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-07',
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('journal_is_sales');
  });

  it('lists invoices by status, customer and payment, page by page', async () => {
    expect(await invoiceNumbers('status=draft')).toEqual([null]);
    // Newest date first; one date, so the newest made first
    expect(await invoiceNumbers(`customerId=${ashulia.id}`)).toEqual([
      null,
      'INV-2026-27-0007',
      'INV-2026-27-0006',
      'INV-2026-27-0003',
    ]);
    // Open: the oldest due date first, the order a receipt pays them in
    const open = [
      'INV-2026-27-0003',
      'INV-2026-27-0006',
      'INV-2026-27-0001',
      'INV-2026-27-0002',
      'INV-2026-27-0004',
      'INV-2026-27-0005',
    ];
    expect(await invoiceNumbers('payment=open')).toEqual(open);
    expect(await invoiceNumbers('payment=overdue')).toEqual(['INV-2026-27-0003']);
    expect(await invoiceNumbers('payment=paid')).toEqual(['INV-2026-27-0007']);

    const posted = ['0007', '0006', '0005', '0004', '0003', '0002', '0001'].map(
      (number) => `INV-2026-27-${number}`,
    );
    // Four at a time, in both orders: the cursor holds the due date or the date to go on from
    for (const [query, all] of [
      ['payment=open', open],
      ['status=posted', posted],
    ] as const) {
      const first = invoicePageSchema.parse(
        (await send('GET', `/invoices?${query}&limit=4`)).json(),
      );
      expect(first.nextCursor).not.toBeNull();
      const second = invoicePageSchema.parse(
        (
          await send(
            'GET',
            `/invoices?${query}&limit=4&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
          )
        ).json(),
      );
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((item) => item.number)).toEqual(all);
    }
  });
});
```

- **A due date before the invoice date is a 400** (`invoice_due_date`). An empty one is the invoice date plus the
  customer's terms: Ashulia's 0 days give the invoice date itself.
- **A draft is changed with PUT, and PUT with `post: true` posts it** (INV-0006), with the new due date and the
  customer's reference (an indent number). After that, changing, posting again and deleting are all
  `sales_not_draft`: a posted invoice is corrected by a credit note (15d), never edited.
- **A free sample is a real invoice with no entry.** ৳0 is numbered (INV-0007) and stays in the series, but a
  journal entry of ৳0 would only clutter the journal, so `entry` is `null`. It counts as paid at once.
- **`leftDraft` stays a draft until the end.** The list, receipt, permission and period-lock tests all need a
  draft to try things on.
- **The journal's Reverse refuses an invoice's entry** (`journal_is_sales`): reversing it there would make the
  books say the sale never happened while the invoice still says it did. The entry is read first, for its
  current version.
- **The lists.** `status=draft` finds only `leftDraft`. A customer's list is the newest date first; these invoices
  share a date, so the newest made comes first (their ids are UUIDv7, in the order they were made).
- **Open and overdue are the oldest due date first**: INV-0003 (due the day it was made) comes before INV-0006 (due
  20 Oct) and Bhairab's invoices (due 5 Nov). That is the order the receipt form suggests paying them in. Only
  INV-0003 is overdue: its due date has passed, and INV-0006's has not. The free sample is the only paid one so far.
- **Paging works in both orders.** Four at a time, the two pages of the open list give the same six invoices as one
  page, and the two pages of the posted list the same seven. The open list's cursor holds a due date and goes up;
  the posted list's holds a date and goes down. A cursor that mixed the two would repeat or skip an invoice here.

### Orders that are billed

```ts
describe('orders that are billed', () => {
  it('keeps an order with a billed service from being reopened or cancelled, and closes it', async () => {
    const draft = await invoiced(
      invoiceForm(
        [invoiceLine(carriage, '1', '500', { orderLineId: orderLine(carriageOrder, carriage) })],
        { post: false },
      ),
    );
    // Even a draft: the reopened order's next save would replace the line it points at
    const reopen = await send('POST', `/sales-orders/${carriageOrder.id}/reopen`, {
      version: carriageOrder.version,
    });
    expect(problemOf(reopen).code).toBe('order_has_invoices');

    const posted = await send('POST', `/invoices/${draft.id}/post`, { version: draft.version });
    expect(posted.statusCode, posted.body).toBe(200);
    bhairabInvoices.set('INV-2026-27-0008', invoiceSchema.parse(posted.json()));
    const now = await orderNow(carriageOrder.id);
    expect(now.lines.map((item) => item.invoicedQuantity)).toEqual(['1.0000']);
    const cancel = await send('POST', `/sales-orders/${now.id}/cancel`, { version: now.version });
    expect(problemOf(cancel).code).toBe('order_has_invoices');
    // Nothing to deliver, everything billed: closing it is the way out
    const closed = await send('POST', `/sales-orders/${now.id}/close`, { version: now.version });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(salesOrderSchema.parse(closed.json()).status).toBe('closed');
  });
});
```

- **Even a draft invoice keeps an order from being reopened** (`order_has_invoices`). A reopened order's next save
  replaces its lines, and the draft invoice's line points at one of them.
- **A billed order is closed, not cancelled.** After the invoice is posted, the order line shows 1 invoiced and
  cancel is refused: the customer owes for that delivery charge, so the order happened. Close works although
  nothing was ever delivered, because everything was billed: an order of services has no other way to end.

### The credit limit

```ts
describe('the credit limit', () => {
  it('shows what a customer owes, has on order, and may still buy', async () => {
    expect(await credit(madhabdi)).toEqual({
      limit: '5000.0000',
      balance: '0.0000',
      onOrder: '0.0000',
      exposure: '0.0000',
      available: '5000.0000',
    });
    // No limit: never checked. Everything Bhairab ordered is billed: 1,265 + 690 + 276 + 575 + 575
    expect(await credit(bhairab)).toEqual({
      limit: null,
      balance: '3381.0000',
      onOrder: '0.0000',
      exposure: '3381.0000',
      available: null,
    });
  });

  it('confirms an order that fits, and stops one that does not', async () => {
    madhabdiOrder = await ordered(
      orderForm([salesLine(juice, '96', '40')], { customerId: madhabdi.id }),
    );
    expect(madhabdiOrder.status).toBe('confirmed');
    expect(await credit(madhabdi)).toMatchObject({ onOrder: '4416.0000', available: '584.0000' });

    const over = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '24', '25')], { customerId: madhabdi.id }),
    );
    expect(over.statusCode).toBe(409);
    expect(problemOf(over)).toMatchObject({
      code: 'credit_limit_exceeded',
      params: { limit: '5000.0000', exposure: '5106.0000' },
    });
    const orders = salesOrderPageSchema.parse(
      (await send('GET', `/sales-orders?customerId=${madhabdi.id}`)).json(),
    );
    expect(orders.items.map((item) => item.id)).toEqual([madhabdiOrder.id]);

    // Saved as a draft, it waits; Confirm asks again
    const draft = await ordered(
      orderForm([salesLine(juice, '24', '25')], { customerId: madhabdi.id, confirm: false }),
    );
    const refused = await send('POST', `/sales-orders/${draft.id}/confirm`, {
      version: draft.version,
    });
    expect(problemOf(refused).code).toBe('credit_limit_exceeded');
    const forbidden = await send(
      'POST',
      `/sales-orders/${draft.id}/confirm`,
      { version: draft.version, overrideCreditLimit: true },
      clerk,
    );
    expect(forbidden.statusCode).toBe(403);
    expect(problemOf(forbidden)).toMatchObject({
      code: 'credit_override_forbidden',
      params: { permissions: 'sales.credit.override' },
    });
    expect(await orderNow(draft.id)).toMatchObject({ status: 'draft', number: null });

    const overridden = await send('POST', `/sales-orders/${draft.id}/confirm`, {
      version: draft.version,
      overrideCreditLimit: true,
    });
    expect(overridden.statusCode, overridden.body).toBe(200);
    expect(salesOrderSchema.parse(overridden.json()).status).toBe('confirmed');
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=sales_order&entityId=${draft.id}`)).json(),
    );
    const overrides = log.items.filter((item) => item.action === 'credit_limit.overridden');
    expect(overrides.map((item) => [item.action, item.actor?.fullName, item.changes])).toEqual([
      [
        'credit_limit.overridden',
        'Shafiq Ahmed',
        {
          limit: { from: null, to: '5000.0000' },
          exposure: { from: null, to: '5106.0000' },
        },
      ],
    ]);
  });

  it('bills a confirmed order over the limit, but stops a bill that adds to it', async () => {
    const confirmed = await orderNow(madhabdiOrder.id);
    const out = await delivered(
      deliveryForm(madhabdi, confirmed.id, [
        deliveryLine(juice, '96', { orderLineId: orderLine(confirmed, juice) }),
      ]),
    );
    // 4,416 moves from "on order" to "owed": the exposure stays 5,106, over the limit but no higher
    const bill = await invoiced(
      invoiceForm([invoiceLine(juice, '96', '40', { deliveryLineId: challanLine(out) })], {
        customerId: madhabdi.id,
      }),
    );
    expect(bill.number).toBe('INV-2026-27-0009');
    expect(await auditActions('invoice', bill.id)).toEqual(['invoice.created', 'invoice.posted']);
    expect(await credit(madhabdi)).toMatchObject({
      balance: '4416.0000',
      onOrder: '690.0000',
      exposure: '5106.0000',
      available: '-106.0000',
    });

    const extra = invoiceForm([invoiceLine(carriage, '1', '500')], { customerId: madhabdi.id });
    const over = await send('POST', '/invoices', extra);
    expect(problemOf(over)).toMatchObject({
      code: 'credit_limit_exceeded',
      params: { limit: '5000.0000', exposure: '5681.0000' },
    });
    const forbidden = await send(
      'POST',
      '/invoices',
      { ...extra, overrideCreditLimit: true },
      clerk,
    );
    expect(problemOf(forbidden).code).toBe('credit_override_forbidden');
    const overridden = await invoiced({ ...extra, overrideCreditLimit: true });
    // The refused posts used no number
    expect(overridden.number).toBe('INV-2026-27-0010');
    expect(await auditActions('invoice', overridden.id)).toEqual([
      'credit_limit.overridden',
      'invoice.created',
      'invoice.posted',
    ]);
  });

  it('lets only one of two orders that fit alone through at the same time', async () => {
    const one = await ordered(
      orderForm([salesLine(carriage, '1', '700')], { customerId: raipura.id, confirm: false }),
    );
    const two = await ordered(
      orderForm([salesLine(carriage, '1', '700')], { customerId: raipura.id, confirm: false }),
    );
    const results = await Promise.all(
      [one, two].map((draft) =>
        send('POST', `/sales-orders/${draft.id}/confirm`, { version: draft.version }),
      ),
    );
    expect(results.map((res) => res.statusCode).toSorted()).toEqual([200, 409]);
    const refused = results.find((res) => res.statusCode === 409);
    if (!refused) throw new Error('both confirmed');
    expect(problemOf(refused).params).toEqual({ limit: '1000.0000', exposure: '1610.0000' });
    expect((await credit(raipura)).onOrder).toBe('805.0000');
  });

  it("waits for the customer's credit lock before it counts", async () => {
    const draft = await ordered(
      orderForm([salesLine(carriage, '1', '100')], { customerId: raipura.id, confirm: false }),
    );
    // Hold the lock CreditService.lock() takes, as another confirm or posting of Raipura's would,
    // and confirm in the meantime. The confirm must wait: two orders confirmed at the same moment
    // each counting without the other is exactly what the lock is there to stop.
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let settled = false;
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${tenantId}:${raipura.id}`}, 0))`;
      pending = send('POST', `/sales-orders/${draft.id}/confirm`, { version: draft.version });
      void pending.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
    });
    await superuser.end();
    // Released: it counts 805 + 115 = 920, under the limit
    expect((await pending)?.statusCode).toBe(200);
    expect((await credit(raipura)).onOrder).toBe('920.0000');
  });
});
```

- **What the form's hint shows.** Madhabdi starts with nothing owed and ৳5,000 available. Bhairab has no limit
  (`limit` and `available` are `null`) and owes the five invoices billed so far, ৳3,381, with nothing left on
  order: every line of its orders is billed.
- **An order that fits is confirmed; one that does not is refused, and nothing is saved.** 96 pieces at ৳40
  (৳4,416 with VAT) fit; 24 more at ৳25 (৳690) would make ৳5,106. "Save and confirm" is one step, so the refused
  order does not exist afterwards. The error carries the limit and the exposure, which the form's dialog shows.
- **A draft can be confirmed later, and is checked then.** Without the override the confirm is refused. The clerk
  asking for the override is `credit_override_forbidden` (403), with the permission in `params`, the same shape as
  any missing permission; the order stays a draft with no number. The owner's override confirms it and leaves an
  audit row with the limit and the exposure, next to the order's own rows.
- **Billing a confirmed order adds nothing.** Madhabdi's 96 pieces are delivered and billed at the order's price:
  ৳4,416 moves from "on order" to "owed", and the exposure stays ৳5,106. That is over the limit, but no higher than
  before, so the invoice posts with no override and no audit row. The goods already left; the amount was approved
  when the order was confirmed. `available` is now negative (−৳106), which the hint shows as it is.
- **A bill that adds to it is checked.** A delivery charge billed on its own would take Madhabdi to ৳5,681:
  refused, forbidden for the clerk, and posted with the owner's override (INV-0010, so the refused attempts used no
  number), with `credit_limit.overridden` among the invoice's audit rows.
- **Two orders at once.** Raipura's two drafts of ৳805 each fit the ৳1,000 limit alone, not together. Confirmed at
  the same moment, one goes through and the other is refused with the exposure of both (৳1,610).
- **That test alone does not prove the lock.** Two confirms also queue up behind the order number series (each
  takes the next SO number), so the second one counts after the first has committed even without the credit lock.
  An order and an invoice share no number series, so for them the credit lock is the only thing that makes the
  second wait.
- **So the next test holds the lock itself.** It opens a transaction as the database superuser and takes the same
  advisory lock `CreditService.lock()` takes, for Raipura, as another confirm or posting would. A confirm sent
  meanwhile must still be waiting 300 ms later; once the lock is released it goes through, counting ৳805 + ৳115.
  With the `pg_advisory_xact_lock` line removed from `lock()`, the confirm finishes inside the 300 ms and this test
  fails (we checked). The key is written out here as the service writes it; the accounts tests replay the chart
  lock the same way.

### Money receipts

```ts
describe('money receipts', () => {
  it('records money and applies it to invoices', async () => {
    cashReceipt = await received(
      receiptForm('2000', [
        { invoiceId: bhairabInvoice('0001').id, amount: '1265' },
        { invoiceId: bhairabInvoice('0002').id, amount: '690' },
      ]),
    );
    expect(cashReceipt).toMatchObject({
      number: 'MR-2026-27-0001',
      status: 'posted',
      amount: '2000.0000',
      applied: '1955.0000',
      voidEntry: null,
    });
    expect(cashReceipt.allocations.map((item) => [item.invoiceNumber, item.amount])).toEqual([
      ['INV-2026-27-0001', '1265.0000'],
      ['INV-2026-27-0002', '690.0000'],
    ]);
    // The receivable comes down by all of it, the ৳45 not applied too
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${cashReceipt.entry.id}`)).json(),
    );
    expect(entry.source).toBe('sales_receipt');
    expect(await entryLines(entry.id)).toEqual([
      ['1110', '2000.0000', '0.0000'],
      ['1140', '0.0000', '2000.0000'],
    ]);
    expect(entry.lines.map((item) => item.party?.id ?? null)).toEqual([null, bhairab.id]);

    const paid = await invoiceNow(bhairabInvoice('0001').id);
    expect(paid.amountPaid).toBe('1265.0000');
    expect(paid.payments).toEqual([
      {
        receiptId: cashReceipt.id,
        receiptNumber: 'MR-2026-27-0001',
        date: '2026-10-07',
        amount: '1265.0000',
      },
    ]);
    expect(await invoiceNumbers(`payment=open&customerId=${bhairab.id}`)).toEqual([
      'INV-2026-27-0004',
      'INV-2026-27-0005',
      'INV-2026-27-0008',
    ]);
    expect((await credit(bhairab)).balance).toBe('1381.0000');
  });

  it('refuses money that cannot be a receipt', async () => {
    const zero = await send('POST', '/receipts', receiptForm('0', []));
    expect(problemOf(zero).fieldErrors).toEqual({ amount: ['receipt_amount_required'] });
    const tooMuch = await send(
      'POST',
      '/receipts',
      receiptForm('100', [{ invoiceId: bhairabInvoice('0004').id, amount: '150' }]),
    );
    expect(problemOf(tooMuch).fieldErrors).toEqual({ allocations: ['receipt_over_allocated'] });
    const twice = await send(
      'POST',
      '/receipts',
      receiptForm('100', [
        { invoiceId: bhairabInvoice('0004').id, amount: '50' },
        { invoiceId: bhairabInvoice('0004').id, amount: '50' },
      ]),
    );
    expect(problemOf(twice).fieldErrors).toEqual({
      'allocations.1.invoiceId': ['receipt_invoice_twice'],
    });

    // The sales account and the bank group are not where money is kept
    for (const code of ['4110', '1120']) {
      const res = await send(
        'POST',
        '/receipts',
        receiptForm('100', [], { accountId: account(code) }),
      );
      expect(problemOf(res).fieldErrors).toEqual({ accountId: ['receipt_account_invalid'] });
    }
    // Another customer's invoice, a draft, more than the invoice owes: each under its row
    const rows = await send(
      'POST',
      '/receipts',
      receiptForm('1000', [
        { invoiceId: counterInvoice.id, amount: '10' },
        { invoiceId: leftDraft.id, amount: '10' },
        { invoiceId: bhairabInvoice('0004').id, amount: '300' },
      ]),
    );
    expect(rows.statusCode).toBe(409);
    expect(problemOf(rows).fieldErrors).toEqual({
      'allocations.0.invoiceId': ['receipt_invoice_invalid'],
      'allocations.1.invoiceId': ['receipt_invoice_invalid'],
      'allocations.2.amount': ['receipt_over_invoice'],
    });
  });

  it('keeps money as an advance, and applies it later', async () => {
    bankReceipt = await received(
      receiptForm('500', [], {
        accountId: account('1121'),
        method: 'bank_transfer',
        reference: 'DBBL TT 88213',
      }),
    );
    // The refusals above used no number
    expect(bankReceipt).toMatchObject({ number: 'MR-2026-27-0002', applied: '0.0000' });
    expect(await entryLines(bankReceipt.entry.id)).toEqual([
      ['1121', '500.0000', '0.0000'],
      ['1140', '0.0000', '500.0000'],
    ]);

    const applied = await send('PUT', `/receipts/${bankReceipt.id}/allocations`, {
      version: bankReceipt.version,
      allocations: [{ invoiceId: bhairabInvoice('0004').id, amount: '276' }],
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const after = receiptSchema.parse(applied.json());
    expect([after.applied, after.version]).toEqual(['276.0000', bankReceipt.version + 1]);
    expect((await invoiceNow(bhairabInvoice('0004').id)).amountPaid).toBe('276.0000');

    const stale = await send('PUT', `/receipts/${bankReceipt.id}/allocations`, {
      version: bankReceipt.version,
      allocations: [],
    });
    expect(problemOf(stale).code).toBe('version_conflict');
    // The amount is the receipt's, so only the server can tell
    const over = await send('PUT', `/receipts/${bankReceipt.id}/allocations`, {
      version: after.version,
      allocations: [{ invoiceId: bhairabInvoice('0005').id, amount: '575' }],
    });
    expect(problemOf(over).fieldErrors).toEqual({ allocations: ['receipt_over_allocated'] });
    bankReceipt = after;

    // The ৳45 left on the cash receipt goes to INV-0005. Its ৳1,265 on INV-0001 stays: what it
    // paid there counts as owed again while the list is replaced.
    const moved = await send('PUT', `/receipts/${cashReceipt.id}/allocations`, {
      version: cashReceipt.version,
      allocations: [
        { invoiceId: bhairabInvoice('0001').id, amount: '1265' },
        { invoiceId: bhairabInvoice('0002').id, amount: '690' },
        { invoiceId: bhairabInvoice('0005').id, amount: '45' },
      ],
    });
    expect(moved.statusCode, moved.body).toBe(200);
    cashReceipt = receiptSchema.parse(moved.json());
    expect(cashReceipt.applied).toBe('2000.0000');
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=receipt&entityId=${cashReceipt.id}`)).json(),
    );
    expect(log.items[0]).toMatchObject({
      action: 'receipt.allocated',
      changes: { 'INV-2026-27-0005': { from: null, to: '45.0000' } },
    });

    // Taken off INV-0005 and put back: the log names the invoice the money left, too
    const allocations = cashReceipt.allocations.map(({ invoiceId, amount }) => ({
      invoiceId,
      amount,
    }));
    const off = await send('PUT', `/receipts/${cashReceipt.id}/allocations`, {
      version: cashReceipt.version,
      allocations: allocations.filter((row) => row.invoiceId !== bhairabInvoice('0005').id),
    });
    expect(off.statusCode, off.body).toBe(200);
    const offLog = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=receipt&entityId=${cashReceipt.id}`)).json(),
    );
    expect(offLog.items[0]?.changes).toEqual({
      'INV-2026-27-0005': { from: '45.0000', to: null },
    });
    const back = await send('PUT', `/receipts/${cashReceipt.id}/allocations`, {
      version: receiptSchema.parse(off.json()).version,
      allocations,
    });
    expect(back.statusCode, back.body).toBe(200);
    cashReceipt = receiptSchema.parse(back.json());
  });
```

- **A receipt is posted when it is saved.** ৳2,000 in cash pays INV-0001 and INV-0002 in full, and it is
  MR-0001 at once. The allocations come back oldest due date first, with each invoice's number and total.
- **The receivable comes down by the whole ৳2,000**, the ৳45 not applied too: Dr Cash / Cr Accounts receivable with
  Bhairab on the line. What the customer owes is the books' number (৳3,381 − ৳2,000 = ৳1,381); the allocations only
  say which invoices are paid.
- **The paid invoice lists the payment** (receipt, number, date, amount), and drops out of the open list.
- **What the form can see is a 400**: an amount of zero, more applied than received, and the same invoice twice.
- **What only the server knows is a 409, under its box.** The sales account and the bank group are not where money
  is kept (`receipt_account_invalid`): one is not an asset that holds money, the other is a group, and money goes
  into one account. Another customer's invoice and a draft are `receipt_invoice_invalid`, and ৳300 on an invoice
  that owes ৳276 is `receipt_over_invoice`, all three in one answer, each under its row.
- **The refusals used no number**: the next receipt is MR-0002.
- **An advance is a receipt with nothing applied.** ৳500 by bank transfer into the bank account under "Bank
  accounts" (the group's tick is enough), with the transfer's reference.
- **Applying it later is PUT `/receipts/:id/allocations`.** ৳276 goes to INV-0004, and the receipt's version goes
  up. A second change with the old version is `version_conflict`. ৳575 is more than the receipt brought:
  `receipt_over_allocated`, which only the server can check here, because the amount is not in this request.
- **What a receipt already paid counts as owed again while its list is replaced.** The cash receipt sends its
  ৳1,265 and ৳690 again and adds its last ৳45 to INV-0005. Without that rule, INV-0001 would look paid in full
  and its own ৳1,265 would be refused. The audit row shows only what changed: INV-0005, from nothing to ৳45.
- **Money taken off an invoice shows in the log too.** The ৳45 comes off INV-0005 and goes back. The audit row of
  the first change is `INV-2026-27-0005: 45.0000 → null`. Without the `null` rows of `allocationChanges()` it is
  empty, because the new list no longer names INV-0005. The second change restores the state the later tests
  expect.

```ts
  it('lets a receipt wait for another one paying the same invoice, then answers under its row', async () => {
    const invoice = bhairabInvoice('0005');
    // Replay the bank receipt's next allocation the way apply() writes it (lock the invoice,
    // replace the rows, the trigger adds them up) and leave it uncommitted for a moment: its ৳224
    // goes to INV-0005, which then owes 306. A cash receipt for the whole 530 starts meanwhile.
    // With the invoice locked FOR UPDATE in apply(), it waits, reads 306 after the commit, and
    // answers under its row. Without the lock it would read 530, pass, and fail on the database's
    // check instead (receipt_over_invoice with no field: the form could not say which row).
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT id FROM invoices WHERE id = ${invoice.id} FOR UPDATE`;
      await tx`DELETE FROM receipt_allocations WHERE receipt_id = ${bankReceipt.id}`;
      await tx`
        INSERT INTO receipt_allocations (id, tenant_id, receipt_id, customer_id, invoice_id, amount)
        VALUES
          (gen_random_uuid(), ${tenantId}, ${bankReceipt.id}, ${bhairab.id},
           ${bhairabInvoice('0004').id}, 276),
          (gen_random_uuid(), ${tenantId}, ${bankReceipt.id}, ${bhairab.id}, ${invoice.id}, 224)`;
      await tx`UPDATE receipts SET version = version + 1 WHERE id = ${bankReceipt.id}`;
      pending = send(
        'POST',
        '/receipts',
        receiptForm('530', [{ invoiceId: invoice.id, amount: '530' }]),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await superuser.end();

    const res = await pending;
    if (!res) throw new Error('the receipt was never sent');
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'allocations.0.amount': ['receipt_over_invoice'],
    });
    const rest = await received(receiptForm('306', [{ invoiceId: invoice.id, amount: '306' }]));
    // The refused receipt used no number
    expect(rest.number).toBe('MR-2026-27-0003');
    expect((await invoiceNow(invoice.id)).amountPaid).toBe('575.0000');
  });

  it('voids a bounced cheque: its entry reversed, its money off the invoice', async () => {
    const cheque = await received(
      receiptForm('575', [{ invoiceId: bhairabInvoice('0008').id, amount: '575' }], {
        accountId: account('1121'),
        method: 'cheque',
        reference: 'Sonali Bank cheque 004512',
      }),
    );
    expect(cheque.number).toBe('MR-2026-27-0004');
    const early = await send('POST', `/receipts/${cheque.id}/void`, {
      version: cheque.version,
      date: '2026-10-06',
      reason: 'Cheque bounced',
    });
    expect(problemOf(early).fieldErrors).toEqual({ date: ['receipt_void_date'] });
    const noReason = await send('POST', `/receipts/${cheque.id}/void`, {
      version: cheque.version,
      date: '2026-10-08',
      reason: ' ',
    });
    expect(problemOf(noReason).fieldErrors).toEqual({ reason: ['receipt_void_reason_required'] });

    const res = await send('POST', `/receipts/${cheque.id}/void`, {
      version: cheque.version,
      date: '2026-10-08',
      reason: 'Cheque bounced',
    });
    expect(res.statusCode, res.body).toBe(200);
    const gone = receiptSchema.parse(res.json());
    expect(gone).toMatchObject({
      status: 'voided',
      voidDate: '2026-10-08',
      voidReason: 'Cheque bounced',
      applied: '0.0000',
      allocations: [],
    });
    const reversal = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${gone.voidEntry?.id ?? ''}`)).json(),
    );
    expect(reversal).toMatchObject({
      source: 'reversal',
      date: '2026-10-08',
      reversalOf: cheque.entry,
    });
    expect(await entryLines(reversal.id)).toEqual([
      ['1121', '0.0000', '575.0000'],
      ['1140', '575.0000', '0.0000'],
    ]);
    expect((await invoiceNow(bhairabInvoice('0008').id)).amountPaid).toBe('0.0000');

    const twice = await send('POST', `/receipts/${cheque.id}/void`, {
      version: gone.version,
      date: '2026-10-08',
      reason: 'Twice',
    });
    expect(problemOf(twice).code).toBe('receipt_voided');
    const reapply = await send('PUT', `/receipts/${cheque.id}/allocations`, {
      version: gone.version,
      allocations: [],
    });
    expect(problemOf(reapply).code).toBe('receipt_voided');
    const page = receiptPageSchema.parse(
      (await send('GET', `/receipts?status=voided&customerId=${bhairab.id}`)).json(),
    );
    expect(page.items.map((item) => item.number)).toEqual(['MR-2026-27-0004']);
  });

  it("stays out of the journal's Reverse, and leaves the books right", async () => {
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${cashReceipt.entry.id}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-08',
    });
    expect(problemOf(res).code).toBe('journal_is_sales');
    // 3,381 billed − 2,000 − 500 − 306 received; the bounced cheque came and went. What is left
    // is INV-0008, unpaid
    expect((await credit(bhairab)).balance).toBe('575.0000');
    expect(await invoiceNumbers(`payment=open&customerId=${bhairab.id}`)).toEqual([
      'INV-2026-27-0008',
    ]);
  });
});
```

- **Two receipts paying the same invoice take turns.** As with the credit lock, two receipts saved at the same
  moment already queue up behind the MR number series, so this test replays the other writer by hand instead. As
  the superuser, it does what `apply()` does for the bank receipt (locks INV-0005, replaces the bank receipt's
  allocations so ৳224 more goes to INV-0005, bumps the receipt's version) and waits 300 ms before committing.
  Meanwhile a cash receipt for the whole ৳530 INV-0005 owed starts.
- **With the lock, the second receipt answers like a form.** It waits for the invoice, reads ৳306 owed after the
  commit, and refuses under its row: `allocations.0.amount`, `receipt_over_invoice`. With the `FOR UPDATE` removed
  from `apply()`, it reads the old ৳530, passes, and is stopped only by the database's check
  (`invoices_paid_check`): the same code but no field, so the form could not say which row to fix. We checked: the
  test fails that way. A receipt for the ৳306 left then takes MR-0003 (the refused one used no number).
- **A bounced cheque is voided.** A void dated before the receipt is `receipt_void_date`, and a reason of only
  spaces is a 400. The void keeps the receipt (MR-0004 is never reused or missing from the series), takes its money
  off the invoice, and reverses its entry on the void date: the same lines with debit and credit swapped, source
  `reversal`, pointing at the receipt's entry.
- **A voided receipt is final.** Voiding it again or applying it again is `receipt_voided`, before any version
  check: "reload and try again" would be the wrong advice. The list finds it with `status=voided`.
- **The journal's Reverse refuses a receipt's entry too** (`journal_is_sales`): a receipt is voided on its own page,
  which also takes its money off the invoices.
- **The books add up at the end.** ৳3,381 billed, ৳2,000 + ৳500 + ৳306 received, the cheque came and went: Bhairab
  owes ৳575, which is exactly INV-0008, the one invoice still open.

### Permissions, foreign keys and the period lock

```ts
describe('who may do what', () => {
  it('lets anyone read invoices and receipts, and only the right people write them', async () => {
    for (const url of [
      '/invoices',
      `/invoices/${firstInvoice.id}`,
      '/receipts',
      `/receipts/${bankReceipt.id}`,
    ]) {
      expect((await send('GET', url, undefined, viewer)).statusCode).toBe(200);
    }
    const balance = await send('GET', `/customers/${bhairab.id}/credit`, undefined, viewer);
    expect(balance.statusCode).toBe(403);
    expect(problemOf(balance).params).toEqual({ permissions: 'sales.customer.balance' });

    const writes = [
      send('POST', '/invoices', invoiceForm([invoiceLine(carriage, '1', '1')]), viewer),
      send('POST', `/invoices/${leftDraft.id}/post`, { version: leftDraft.version }, viewer),
      send(
        'DELETE',
        `/invoices/${leftDraft.id}?version=${String(leftDraft.version)}`,
        undefined,
        viewer,
      ),
      send('POST', '/receipts', receiptForm('10', []), viewer),
      send(
        'PUT',
        `/receipts/${bankReceipt.id}/allocations`,
        { version: 1, allocations: [] },
        viewer,
      ),
      send(
        'POST',
        `/receipts/${bankReceipt.id}/void`,
        { version: 1, date: '2026-10-08', reason: 'x' },
        viewer,
      ),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).code).toBe('permission_missing');
    }
  });
});

describe('what invoices and receipts hold on to', () => {
  it('keeps a customer, a product and an account that they name', async () => {
    const pharmacy = await addCustomer('Palash Medicine Corner');
    const loading = await addProduct('Loading charge', { type: 'service' });
    await invoiced(
      invoiceForm([invoiceLine(loading, '1', '200')], { customerId: pharmacy.id, post: false }),
    );
    const customer = await send(
      'DELETE',
      `/customers/${pharmacy.id}?version=${String(pharmacy.version)}`,
    );
    expect(problemOf(customer).code).toBe('customer_in_use');
    const product = await send(
      'DELETE',
      `/products/${loading.id}?version=${String(loading.version)}`,
    );
    expect(problemOf(product).code).toBe('product_in_use');
    const bank = accountSchema.parse((await send('GET', `/accounts/${account('1121')}`)).json());
    const removed = await send('DELETE', `/accounts/${bank.id}?version=${String(bank.version)}`);
    expect(problemOf(removed).code).toBe('account_in_use');
  });
});

describe('the period lock', () => {
  it('refuses an invoice or a receipt on a day the books are closed', async () => {
    expect(
      (await send('PUT', '/period-lock', { lockDate: '2026-10-06', version: 0 })).statusCode,
    ).toBe(200);
    const invoice = await send('POST', `/invoices/${leftDraft.id}/post`, {
      version: leftDraft.version,
    });
    expect(problemOf(invoice).code).toBe('journal_period_locked');
    expect((await invoiceNow(leftDraft.id)).status).toBe('draft');
    const receipt = await send('POST', '/receipts', receiptForm('100', [], { date: '2026-10-06' }));
    expect(problemOf(receipt).code).toBe('journal_period_locked');
  });
});
```

- **The viewer reads every invoice and receipt, but not the credit numbers.** `/customers/:id/credit` needs
  `sales.customer.balance`, because it says what the customer owes. Every write is `permission_missing` (403),
  decided by the route's permission before the service runs.
- **A customer named only on a draft invoice cannot be deleted** (`customer_in_use`), nor can a service that is
  only on that draft's line (`product_in_use`), nor the bank account that receipts went into (`account_in_use`).
  All three come from the new foreign keys of 15c.2, through the error lists of 15c.3.
- **The period lock runs last**, because it closes the books for everything before it. Posting `leftDraft` (dated
  6 Oct, the lock date itself) is `journal_period_locked`, and the draft stays a draft. A receipt dated that day is
  refused the same way.

### `sales/sales.tenant-leak.int.spec.ts`: B's invoices and receipts

```diff
@@ -8,10 +8,14 @@ import {
   customerGroupListSchema,
   customerGroupSchema,
   customerPageSchema,
+  customerCreditSchema,
   customerSchema,
   type Delivery,
   deliveryPageSchema,
   deliverySchema,
+  type Invoice,
+  invoicePageSchema,
+  invoiceSchema,
   type PriceList,
   priceListListSchema,
   priceListSchema,
@@ -22,6 +26,9 @@ import {
   type Quotation,
   quotationPageSchema,
   quotationSchema,
+  type Receipt,
+  receiptPageSchema,
+  receiptSchema,
   type SalesOrder,
   salesOrderPageSchema,
   salesOrderSchema,
@@ -681,3 +688,283 @@ describe('sales document isolation over HTTP', () => {
     expect(quotationSchema.parse(res.json()).number).toBe(quotationOfB.number);
   });
 });
+
+describe('invoice and receipt isolation over HTTP', () => {
+  let customerOfA: Customer;
+  let serviceOfA: Product;
+  let branchOfA: string;
+  let rateOfA: string;
+  let invoiceOfB: Invoice;
+  let draftOfB: Invoice;
+  let receiptOfB: Receipt;
+  let cashOfB: string;
+
+  function invoiceBody(customerId: string, branchId: string, line: object, extra: object = {}) {
+    return {
+      customerId,
+      date: '2026-10-06',
+      dueDate: '',
+      customerReference: '',
+      branchId,
+      warehouseId: '',
+      note: '',
+      lines: [line],
+      post: true,
+      ...extra,
+    };
+  }
+
+  function serviceLine(product: Product, taxRateId: string, extra: object = {}) {
+    return {
+      variantId: product.variants[0]?.id,
+      unitId: product.baseUnitId,
+      quantity: '1',
+      description: '',
+      unitPrice: '500',
+      discountType: 'percent',
+      discount: '',
+      taxRateId,
+      deliveryLineId: '',
+      orderLineId: '',
+      batchId: '',
+      serialNumbers: [],
+      ...extra,
+    };
+  }
+
+  function receiptBody(
+    customerId: string,
+    accountId: string,
+    branchId: string,
+    allocations: object[],
+  ) {
+    return {
+      customerId,
+      date: '2026-10-07',
+      amount: '200',
+      accountId,
+      method: 'cash',
+      reference: '',
+      branchId,
+      note: '',
+      allocations,
+    };
+  }
+
+  beforeAll(async () => {
+    // B: a posted invoice for a delivery charge (no stock needed), a draft, and a cash receipt
+    // that pays part of the posted one
+    const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
+    const service = await as(
+      tenantB,
+      'POST',
+      '/products',
+      productForm('Delivery charge', unitsOfB, { type: 'service' }),
+    );
+    expect(service.statusCode, service.body).toBe(201);
+    const serviceOfB = productSchema.parse(service.json());
+    const posted = await as(
+      tenantB,
+      'POST',
+      '/invoices',
+      invoiceBody(customerOfB.id, warehouseOfB.branchId, serviceLine(serviceOfB, rateOfB.id)),
+    );
+    expect(posted.statusCode, posted.body).toBe(201);
+    const draft = await as(
+      tenantB,
+      'POST',
+      '/invoices',
+      invoiceBody(customerOfB.id, warehouseOfB.branchId, serviceLine(serviceOfB, rateOfB.id), {
+        post: false,
+      }),
+    );
+    expect(draft.statusCode, draft.body).toBe(201);
+    draftOfB = invoiceSchema.parse(draft.json());
+    const accountsOfB = accountListSchema.parse(
+      (await as(tenantB, 'GET', '/accounts')).json(),
+    ).items;
+    cashOfB = accountsOfB.find((account) => account.purpose === 'cash')?.id ?? '';
+    const receipt = await as(
+      tenantB,
+      'POST',
+      '/receipts',
+      receiptBody(customerOfB.id, cashOfB, warehouseOfB.branchId, [
+        { invoiceId: invoiceSchema.parse(posted.json()).id, amount: '200' },
+      ]),
+    );
+    expect(receipt.statusCode, receipt.body).toBe(201);
+    receiptOfB = receiptSchema.parse(receipt.json());
+    // Paid in part: a new version. A's attempts below send B's current ones.
+    invoiceOfB = invoiceSchema.parse(
+      (await as(tenantB, 'GET', `/invoices/${invoiceSchema.parse(posted.json()).id}`)).json(),
+    );
+
+    // A: its own customer, a service of its own, its branch and its VAT rate
+    customerOfA = customerSchema.parse(
+      (await as(tenantA, 'POST', '/customers', customerForm('H&M Hennes & Mauritz AB'))).json(),
+    );
+    const product = await as(
+      tenantA,
+      'POST',
+      '/products',
+      productForm('Sample courier charge', unitsOfA, { type: 'service' }),
+    );
+    expect(product.statusCode, product.body).toBe(201);
+    serviceOfA = productSchema.parse(product.json());
+    const [own] = warehouseListSchema.parse((await as(tenantA, 'GET', '/warehouses')).json()).items;
+    if (!own) throw new Error('A has no warehouse');
+    branchOfA = own.branchId;
+    const rates = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
+    const standard = rates.find((rate) => rate.isDefault);
+    if (!standard) throw new Error('A has no default rate');
+    rateOfA = standard.id;
+  });
+
+  it("never lists or reads B's invoices, receipts or credit", async () => {
+    const invoices = invoicePageSchema.parse((await as(tenantA, 'GET', '/invoices')).json());
+    expect(invoices.items).toEqual([]);
+    const open = await as(tenantA, 'GET', `/invoices?payment=open&customerId=${customerOfB.id}`);
+    expect(invoicePageSchema.parse(open.json()).items).toEqual([]);
+    const receipts = receiptPageSchema.parse((await as(tenantA, 'GET', '/receipts')).json());
+    expect(receipts.items).toEqual([]);
+    for (const url of [
+      `/invoices/${invoiceOfB.id}`,
+      `/invoices/${draftOfB.id}`,
+      `/receipts/${receiptOfB.id}`,
+      `/customers/${customerOfB.id}/credit`,
+    ]) {
+      expect((await as(tenantA, 'GET', url)).statusCode, url).toBe(404);
+    }
+    // B's own answer, for comparison: the credit route exists and B can read it
+    const own = await as(tenantB, 'GET', `/customers/${customerOfB.id}/credit`);
+    expect(customerCreditSchema.parse(own.json()).balance).toBe('13500.0000');
+  });
+
+  it('cannot change, post, delete, apply or void any of them', async () => {
+    const attempts = [
+      as(tenantA, 'PUT', `/invoices/${draftOfB.id}`, {
+        ...invoiceBody(customerOfA.id, branchOfA, serviceLine(serviceOfA, rateOfA)),
+        version: draftOfB.version,
+      }),
+      as(tenantA, 'POST', `/invoices/${draftOfB.id}/post`, { version: draftOfB.version }),
+      as(tenantA, 'DELETE', `/invoices/${draftOfB.id}?version=${String(draftOfB.version)}`),
+      as(tenantA, 'PUT', `/receipts/${receiptOfB.id}/allocations`, {
+        version: receiptOfB.version,
+        allocations: [],
+      }),
+      as(tenantA, 'POST', `/receipts/${receiptOfB.id}/void`, {
+        version: receiptOfB.version,
+        date: '2026-10-08',
+        reason: 'Taken over',
+      }),
+    ];
+    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);
+
+    const draftNow = invoiceSchema.parse(
+      (await as(tenantB, 'GET', `/invoices/${draftOfB.id}`)).json(),
+    );
+    expect(draftNow).toMatchObject({ status: 'draft', version: draftOfB.version, number: null });
+    const receiptNow = receiptSchema.parse(
+      (await as(tenantB, 'GET', `/receipts/${receiptOfB.id}`)).json(),
+    );
+    expect(receiptNow).toMatchObject({
+      status: 'posted',
+      applied: '200.0000',
+      version: receiptOfB.version,
+    });
+  });
+
+  it("cannot bill B's customer, challan, order or branch, or pay B's invoice", async () => {
+    const forB = await as(
+      tenantA,
+      'POST',
+      '/invoices',
+      invoiceBody(customerOfB.id, branchOfA, serviceLine(serviceOfA, rateOfA)),
+    );
+    expect(problemOf(forB).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
+    const branchOfB = await as(
+      tenantA,
+      'POST',
+      '/invoices',
+      invoiceBody(customerOfA.id, warehouseOfB.branchId, serviceLine(serviceOfA, rateOfA)),
+    );
+    expect(problemOf(branchOfB).fieldErrors).toEqual({ branchId: ['sales_branch_invalid'] });
+    const challanOfB = await as(
+      tenantA,
+      'POST',
+      '/invoices',
+      invoiceBody(
+        customerOfA.id,
+        branchOfA,
+        serviceLine(serviceOfA, rateOfA, { deliveryLineId: deliveryOfB.lines[0]?.id }),
+      ),
+    );
+    expect(problemOf(challanOfB).fieldErrors).toEqual({
+      'lines.0.deliveryLineId': ['invoice_delivery_line_invalid'],
+    });
+    const orderLineOfB = await as(
+      tenantA,
+      'POST',
+      '/invoices',
+      invoiceBody(
+        customerOfA.id,
+        branchOfA,
+        serviceLine(serviceOfA, rateOfA, { orderLineId: orderOfB.lines[0]?.id }),
+      ),
+    );
+    expect(problemOf(orderLineOfB).fieldErrors).toEqual({
+      'lines.0.orderLineId': ['invoice_order_line_invalid'],
+    });
+
+    const cashOfA = accountOfA('1110');
+    const receiptForB = await as(
+      tenantA,
+      'POST',
+      '/receipts',
+      receiptBody(customerOfB.id, cashOfA, branchOfA, []),
+    );
+    expect(problemOf(receiptForB).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
+    const intoCashOfB = await as(
+      tenantA,
+      'POST',
+      '/receipts',
+      receiptBody(customerOfA.id, cashOfB, branchOfA, []),
+    );
+    expect(problemOf(intoCashOfB).fieldErrors).toEqual({ accountId: ['receipt_account_invalid'] });
+    const payingB = await as(
+      tenantA,
+      'POST',
+      '/receipts',
+      receiptBody(customerOfA.id, cashOfA, branchOfA, [
+        { invoiceId: invoiceOfB.id, amount: '100' },
+      ]),
+    );
+    expect(problemOf(payingB).fieldErrors).toEqual({
+      'allocations.0.invoiceId': ['receipt_invoice_invalid'],
+    });
+    // B's invoice is as B left it
+    const after = invoiceSchema.parse(
+      (await as(tenantB, 'GET', `/invoices/${invoiceOfB.id}`)).json(),
+    );
+    expect(after.amountPaid).toBe('200.0000');
+  });
+
+  it("numbers its invoices and receipts on its own: B's numbers take nothing from A", async () => {
+    const invoice = await as(
+      tenantA,
+      'POST',
+      '/invoices',
+      invoiceBody(customerOfA.id, branchOfA, serviceLine(serviceOfA, rateOfA)),
+    );
+    expect(invoice.statusCode, invoice.body).toBe(201);
+    expect(invoiceSchema.parse(invoice.json()).number).toBe(invoiceOfB.number);
+    const receipt = await as(
+      tenantA,
+      'POST',
+      '/receipts',
+      receiptBody(customerOfA.id, accountOfA('1110'), branchOfA, []),
+    );
+    expect(receipt.statusCode, receipt.body).toBe(201);
+    expect(receiptSchema.parse(receipt.json()).number).toBe(receiptOfB.number);
+  });
+});
```

- **B's documents need no stock**: a posted invoice for a delivery charge (a service), a draft, and a cash receipt
  that pays ৳200 of the posted one. B's invoice is read again afterwards, because the payment gave it a new version,
  and A's attempts send B's current versions: only the tenant check stands between A and B's rows.
- **Every read is a 404 or an empty list**, also when A filters by B's customer, and the credit route of B's
  customer is a 404 for A. B reads its own credit for comparison: ৳13,200 from the step 15a journal entry plus the
  ৳500 invoice, minus the ৳200 receipt.
- **Every write is a 404**: change, post and delete of B's draft, apply and void of B's receipt. Afterwards B's
  draft and receipt are exactly as B left them.
- **A cannot use B's records in its own documents.** B's customer is `sales_customer_invalid`, B's branch
  `sales_branch_invalid`, B's challan line `invoice_delivery_line_invalid`, B's order line
  `invoice_order_line_invalid`, B's cash account `receipt_account_invalid`, and paying B's invoice
  `receipt_invoice_invalid`: the same answers as for an id that does not exist. B's invoice is still paid ৳200.
- **Numbers are per workspace**: A's first invoice and first receipt have the same numbers as B's.

The RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`) needs no change: it finds the four new tables by
their `tenant_id` column and checks that each has row-level security turned on and forced, with a policy.

### `numbering/numbering.int.spec.ts`: one more number series

```diff
@@ -101,7 +101,12 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(13);
+    expect(items.map((series) => series.documentType)).toHaveLength(14);
+    // Money receipts (step 15c): numbered by fiscal year, when saved (a receipt has no draft)
+    expect(items.find((series) => series.documentType === 'sales.receipt')).toMatchObject({
+      prefix: 'MR',
+      nextNumber: `MR-${today}-0001`,
+    });
     // Quotations and deliveries (step 15b): numbered by fiscal year. A quotation takes its number
     // when it is saved, a delivery when it is posted; this list only shows the next one.
     expect(items.find((series) => series.documentType === 'sales.quotation')).toMatchObject({
```

- **14 series, not 13.** 15c.1 added `sales.receipt` (MR). `sales.invoice` (INV) was in the list long before 15c.
- **The MR row is checked like the others**: the prefix, and the next number with the fiscal year in it. Reading
  the list never uses a number up, so it still starts at `0001`.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api exec vitest run src/sales src/accounts src/journal src/numbering --maxWorkers=3
pnpm --filter @omnivo/api test:tenant-leak
```

The `vitest` line runs only the files this part touches. `pnpm test:integration` runs all of them; part 15c.8 runs
every check once at the end.

> **What we checked in this part.** The API type-checks, and ESLint and Prettier are clean. All API integration
> and tenant-leak tests pass: 38 files (26 integration, 12 tenant-leak), 366 tests, run with three workers. Three
> things were also checked by breaking the code on purpose. Without the "higher than before" rule in
> `CreditService.check()`, the invoice that bills Madhabdi's confirmed order is refused. Without the
> `pg_advisory_xact_lock` in `CreditService.lock()`, the confirm no longer waits for the credit lock. Without the
> `FOR UPDATE` on the invoices in `ReceiptsService.apply()`, the second receipt gets no field in its error, and the
> later receipt numbers shift by one. The two parallel tests (two confirms, and two receipts saved at once) passed
> even with the locks removed, because the number series made them take turns; that is why the lock tests replay
> the other writer by hand.

## 15c.5 — `packages/i18n` and `packages/ui`: the words, and the printed page

The pages of 15c.6 need their words in English and Bangla. They also need one new thing from the ui package: a
way to print a document on A4 paper. Both come before the app, because the app cannot type-check without them.
After this part the app has nine type errors left. All of them are in test fixtures and in the MSW mock (accounts
without `holdsMoney`, order lines without `invoicedQuantity`, delivery lines without `invoiced`, order inputs
without `overrideCreditLimit`); 15c.6 and 15c.7 fix them. No error is about a missing word.

### `locales/en.ts`

```diff
@@ -75,6 +75,8 @@ export const en = {
     quotations: 'Quotations',
     salesOrders: 'Sales orders',
     deliveries: 'Deliveries',
+    invoices: 'Invoices',
+    receipts: 'Money receipts',
   },
   auth: {
     workspace: 'Workspace',
@@ -214,6 +216,7 @@ export const en = {
         customer: 'Customer code',
         quotation: 'Quotation',
         delivery: 'Delivery challan',
+        receipt: 'Money receipt',
       },
       purchase: { order: 'Purchase order', bill: 'Supplier bill' },
       inventory: {
@@ -322,6 +325,10 @@ export const en = {
     namePlaceholder: 'Dutch-Bangla Bank CD A/C 1234',
     about: 'Description',
     aboutPlaceholder: 'Main collection account for export proceeds',
+    holdsMoney: 'Holds money',
+    holdsMoneyHint:
+      'Cash, bank and mobile wallet accounts: a money receipt goes into one of them. Ticked on a group, it counts for every account inside.',
+    holdsMoneyFromGroup: 'Holds money, because the group {{name}} does.',
     typeLine: '{{type}} · {{balance}}',
     topLevel: 'A top-level group. It always stays at the top of the chart.',
     systemHint:
@@ -431,10 +438,16 @@ export const en = {
       stock_transfer: 'Stock transfer',
       stock_revaluation: 'Stock revaluation',
       sales_delivery: 'Delivery',
+      sales_invoice: 'Invoice',
+      sales_receipt: 'Money receipt',
     },
     fromDocument: 'From {{document}}',
     stockEntryHint:
       'A stock document made this entry. To correct it, post another stock document: an adjustment, or a revaluation.',
+    invoiceEntryHint:
+      'An invoice made this entry. A posted invoice stays as it is, so the entry is not reversed here.',
+    receiptEntryHint:
+      'A money receipt made this entry. To undo it, void the receipt on its own page.',
     draftSaved: 'Draft saved',
     posted: '{{number}} posted',
     deleted: 'Draft deleted',
@@ -1450,11 +1463,23 @@ export const en = {
       balance: 'Balance',
       creditLimit: 'Credit limit',
       terms: 'Payment terms',
+      onOrder: 'On confirmed orders',
+      creditLeft: 'Credit left',
     },
     // What the customer owes, or what the company owes back (an advance, an overpayment)
     owes: 'Owes {{amount}}',
     inAdvance: '{{amount}} in advance',
     settled: 'Nothing owed',
+    // The line under the customer on the order and invoice forms, from GET /customers/:id/credit
+    credit: {
+      onOrder: '{{amount}} on confirmed orders',
+      left: 'Credit left: {{amount}} of {{limit}}',
+      over: 'Over the credit limit by {{amount}}',
+      noLimit: 'No credit limit',
+      cashOnly: 'Cash only: no credit',
+    },
+    newInvoice: 'New invoice',
+    recordPayment: 'Record payment',
     details: 'Details',
     noAddresses: 'No addresses',
     statementTitle: 'Statement',
@@ -1727,6 +1752,7 @@ export const en = {
     keepOrder: 'Keep the order',
     delivered: 'Delivered',
     left: 'Left to deliver',
+    invoiced: 'Invoiced',
     serviceLine: 'A service: not delivered',
     deliveriesTitle: 'Deliveries',
     deliveriesSubtitle: 'Challans that took goods against this order',
@@ -1750,6 +1776,14 @@ export const en = {
     show: 'Show',
     all: 'All',
     statuses: { draft: 'Draft', posted: 'Posted' },
+    // How much of a posted challan is billed (deliveries.ts → invoiceState)
+    invoiceStates: {
+      not_invoiced: 'Not invoiced',
+      partly_invoiced: 'Partly invoiced',
+      invoiced: 'Invoiced',
+    },
+    billing: 'Billing',
+    invoiceFilters: { to_invoice: 'To invoice', invoiced: 'Invoiced' },
     columns: {
       number: 'Number',
       customer: 'Customer',
@@ -1795,6 +1829,263 @@ export const en = {
     emptyBody:
       'Deliver a confirmed order from its page, or write a delivery for a customer who collects goods without an order.',
     loadFailed: "Couldn't load the deliveries. Refresh the page to try again.",
+    makeInvoice: 'Make invoice',
+    invoicesTitle: 'Invoices',
+    invoicesSubtitle: 'Posted invoices that bill this challan',
+    notInvoicedYet: 'Not billed yet.',
+    lineInvoiced: 'Invoiced',
+  },
+  invoices: {
+    title: 'Invoices',
+    description: 'What customers are billed, and what they still owe',
+    new: 'New invoice',
+    newTitle: 'New invoice',
+    draftTitle: 'Draft invoice',
+    back: 'Invoices',
+    show: 'Show',
+    all: 'All',
+    statuses: { draft: 'Draft', posted: 'Posted' },
+    // From what was paid (invoices.ts → paymentStatusOf). Overdue is worked out by the page.
+    payment: { unpaid: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid' },
+    overdue: 'Overdue',
+    paymentFilters: { open: 'Not paid', overdue: 'Overdue', paid: 'Paid' },
+    columns: {
+      number: 'Number',
+      customer: 'Customer',
+      dueDate: 'Due date',
+      total: 'Total',
+      due: 'Still due',
+      status: 'Status',
+    },
+    customer: 'Customer',
+    customerLocked: 'Remove the challan and order lines to change the customer.',
+    date: 'Invoice date',
+    dueDate: 'Due date',
+    dueDateHint: 'Leave it empty for the customer’s payment terms.',
+    dueOn: 'Due {{date}}',
+    customerReference: 'Customer’s reference',
+    customerReferenceHint: 'Their PO or indent number',
+    customerReferencePlaceholder: 'PO-HM-2026-1187',
+    branch: 'Branch',
+    branchHint: 'Whose sale it is. The profit and loss by branch shows it there.',
+    warehouse: 'Deliver from',
+    warehouseHint:
+      'Only for items that are not on a challan: posting the invoice delivers them from here.',
+    noWarehouse: 'Every item is on a challan',
+    billingAddress: 'Bill to',
+    noBillingAddress: 'No billing address',
+    note: 'Note',
+    notePlaceholder: 'Pay by cheque or bank transfer within 30 days of this invoice.',
+    // Where each line comes from
+    addChallans: 'Add challans',
+    challanPickerTitle: 'Bill challans',
+    challanPickerDescription:
+      'Posted challans of this customer that are not billed yet. Each click adds the challan’s lines, at the order’s prices.',
+    challanPickerEmpty: 'Every posted challan of this customer is billed.',
+    challanLines_one: '{{count}} item',
+    challanLines_other: '{{count}} items',
+    addCharges: 'Add order charges',
+    chargePickerTitle: 'Bill order charges',
+    chargePickerDescription:
+      'Services on this customer’s orders that are not billed yet, like a delivery or an embroidery charge. Each click adds what is left on that order.',
+    chargePickerEmpty: 'This customer has no confirmed order.',
+    noChargesLeft: 'Every service on {{number}} is billed already.',
+    pickCustomerFirst: 'Pick the customer first.',
+    fromChallan: 'From {{number}}',
+    fromOrder: 'Service on {{number}}',
+    ownLine: 'Delivered by this invoice',
+    challanLineHint: 'The item, unit and quantity are the challan’s.',
+    saveDraft: 'Save draft',
+    post: 'Post invoice',
+    posting: 'Posting…',
+    posted: '{{number}} posted',
+    draftSaved: 'Draft saved',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning: 'A deleted draft cannot be brought back. Its challans can be billed again.',
+    deleted: 'Draft deleted',
+    postHint:
+      'Posting gives the invoice its number and books the sale. Items that are not on a challan leave the warehouse on a challan of their own. A posted invoice never changes.',
+    cantWrite:
+      'You can view invoices. Ask a workspace owner for the sales.invoice.manage permission to write and post them.',
+    postedOn: 'Posted {{date}}',
+    entry: 'Journal entry',
+    noEntry: 'No journal entry: nothing is charged on this invoice',
+    paid: 'Paid',
+    due: 'Still due',
+    overdueNotice_one: 'This invoice was due on {{date}}: {{count}} day late.',
+    overdueNotice_other: 'This invoice was due on {{date}}: {{count}} days late.',
+    challansTitle: 'Challans',
+    challansSubtitle: 'The deliveries this invoice bills',
+    ordersTitle: 'Orders',
+    paymentsTitle: 'Payments',
+    paymentsSubtitle: 'Money receipts applied to this invoice',
+    noPayments: 'Nothing paid yet.',
+    recordPayment: 'Record payment',
+    notFound: "This invoice doesn't exist, or it was a draft that was deleted.",
+    emptyTitle: 'No invoices yet',
+    emptyBody:
+      'Bill a posted challan from its page, like 400 cartons sent to the Mirpur depot, or write an invoice for a counter sale: it delivers the goods itself.',
+    loadFailed: "Couldn't load the invoices. Refresh the page to try again.",
+  },
+  receipts: {
+    title: 'Money receipts',
+    description: 'Money customers paid, and the invoices it paid',
+    new: 'Record payment',
+    newTitle: 'Record a payment',
+    back: 'Money receipts',
+    show: 'Show',
+    all: 'All',
+    statuses: { posted: 'Posted', voided: 'Voided' },
+    methods: {
+      cash: 'Cash',
+      bank_transfer: 'Bank transfer',
+      cheque: 'Cheque',
+      mobile_wallet: 'Mobile wallet',
+      card: 'Card',
+    },
+    columns: {
+      number: 'Number',
+      customer: 'Customer',
+      method: 'Paid by',
+      amount: 'Amount',
+      unapplied: 'Not applied',
+      status: 'Status',
+    },
+    customer: 'Customer',
+    date: 'Date',
+    amount: 'Amount',
+    account: 'Received into',
+    accountHint: 'A cash, bank or mobile wallet account',
+    accountPlaceholder: 'Pick an account',
+    noAccounts:
+      'No account holds money yet. Tick "Holds money" on your cash and bank accounts in the chart of accounts.',
+    method: 'Paid by',
+    reference: 'Reference',
+    // An example for each method, the way the reference is written on the slip
+    referencePlaceholders: {
+      cash: 'Collected by Rahim at the Mirpur depot',
+      bank_transfer: 'DBBL transfer ref 2026092312345',
+      cheque: 'Cheque 0045123, Sonali Bank Motijheel',
+      mobile_wallet: 'bKash TrxID 9JK3L2M8NP',
+      card: 'Card ending 4821',
+    },
+    branch: 'Branch',
+    note: 'Note',
+    notePlaceholder: 'Paid for the September deliveries to the Mirpur depot.',
+    // Applying the money to invoices
+    applyTitle: 'Apply to invoices',
+    applySubtitle:
+      'Oldest due first. Change the amounts if the customer said which invoices they pay.',
+    applyOldest: 'Apply oldest first',
+    clearAll: 'Clear',
+    allocationColumns: {
+      invoice: 'Invoice',
+      date: 'Date',
+      total: 'Total',
+      due: 'Still due',
+      amount: 'Apply',
+    },
+    applyTo: 'Amount applied to {{number}}',
+    pickCustomer: 'Pick the customer to see their unpaid invoices.',
+    noOpenInvoices: 'This customer has no unpaid invoice. The whole amount stays as an advance.',
+    applied: 'Applied',
+    unapplied: 'Left as advance',
+    overBy: 'Over by {{amount}}',
+    save: 'Save receipt',
+    saving: 'Saving…',
+    saved: '{{number}} saved',
+    saveHint:
+      'Saving posts it at once: the money goes into the account and comes off what the customer owes.',
+    // The receipt's own page
+    unappliedNotice:
+      '{{amount}} is not applied to an invoice yet. It counts as an advance until you apply it.',
+    apply: 'Apply money',
+    applyDialogTitle: 'Apply {{number}}',
+    applySave: 'Save',
+    allocated: '{{number}} applied',
+    void: 'Void receipt',
+    voidTitle: 'Void {{number}}',
+    voidBody:
+      'Its entry is reversed on the void date, and its money comes off the invoices again. The receipt stays in the list with its number.',
+    voidDate: 'Void date',
+    voidDateHint: 'The day the money turned out not to be there, like the day a cheque bounced.',
+    voidReason: 'Reason',
+    voidReasonPlaceholder: 'Cheque bounced: not enough funds',
+    confirmVoid: 'Void receipt',
+    keepReceipt: 'Keep the receipt',
+    voided: '{{number}} voided',
+    voidedNotice: 'Voided on {{date}}: {{reason}}',
+    entry: 'Journal entry',
+    voidEntry: 'Reversal',
+    invoicesTitle: 'Invoices paid',
+    noAllocations: 'Not applied to any invoice.',
+    cantWrite:
+      'You can view money receipts. Ask a workspace owner for the sales.receipt.manage permission to record them.',
+    notFound: "This money receipt doesn't exist.",
+    emptyTitle: 'No money receipts yet',
+    emptyBody:
+      'Record what a customer pays: cash at the counter, a cheque, a bank transfer or a bKash payment.',
+    loadFailed: "Couldn't load the money receipts. Refresh the page to try again.",
+  },
+  // The dialog that asks before an order or an invoice goes over the customer's credit limit
+  creditLimit: {
+    title: 'Over the credit limit',
+    body: 'This takes {{customer}} to {{exposure}}, over their credit limit of {{limit}}.',
+    counts: 'What they owe now and their confirmed orders count, with this document.',
+    audit: 'The audit log records that you went over the limit.',
+    confirmOrder: 'Confirm anyway',
+    postInvoice: 'Post anyway',
+    back: 'Go back',
+  },
+  // The printed quotation, order, challan, invoice and receipt (A4, the browser's Print)
+  print: {
+    print: 'Print',
+    titles: {
+      quotation: 'Quotation',
+      salesOrder: 'Sales order',
+      delivery: 'Delivery challan',
+      invoice: 'Invoice',
+      receipt: 'Money receipt',
+    },
+    bin: 'BIN {{bin}}',
+    phone: 'Phone {{phone}}',
+    number: 'No.',
+    date: 'Date',
+    validUntil: 'Valid until',
+    deliveryDate: 'Delivery date',
+    dueDate: 'Due date',
+    customerReference: 'Your reference',
+    order: 'Order',
+    vehicle: 'Vehicle',
+    billTo: 'Bill to',
+    shipTo: 'Ship to',
+    customer: 'Customer',
+    columns: {
+      number: '#',
+      item: 'Item',
+      quantity: 'Quantity',
+      price: 'Price',
+      discount: 'Discount',
+      vat: 'VAT',
+      amount: 'Amount',
+    },
+    batch: 'Batch {{lot}}',
+    expires: 'expires {{date}}',
+    serials: 'Serial numbers: {{serials}}',
+    receivedFrom: 'Received from',
+    amountReceived: 'Amount received',
+    paidBy: 'Paid by',
+    reference: 'Reference',
+    appliedTo: 'Applied to',
+    advance: 'Kept as an advance',
+    signatures: {
+      customer: 'Customer’s signature',
+      receivedBy: 'Received by',
+      preparedBy: 'Prepared by',
+      authorised: 'Authorised signature',
+    },
+    printedAt: 'Printed {{date}}',
   },
   yearEnd: {
     title: 'Year-end close',
@@ -1968,6 +2259,9 @@ export const en = {
       quotation: { manage: 'Write quotations, and mark them declined' },
       order: { manage: 'Write, confirm, close and cancel sales orders' },
       delivery: { manage: 'Write and post deliveries: goods leave the warehouse' },
+      invoice: { manage: 'Write and post invoices' },
+      receipt: { manage: 'Record money receipts, apply them to invoices and void them' },
+      credit: { override: 'Confirm orders and post invoices over a customer’s credit limit' },
     },
   },
   invite: {
@@ -2022,6 +2316,8 @@ export const en = {
       quotation: 'Quotations',
       sales_order: 'Sales orders',
       delivery: 'Deliveries',
+      invoice: 'Invoices',
+      receipt: 'Money receipts',
     },
     columns: {
       when: 'When',
@@ -2187,6 +2483,18 @@ export const en = {
         deleted: 'Deleted a draft delivery',
         posted: 'Posted a delivery',
       },
+      invoice: {
+        created: 'Wrote an invoice',
+        updated: 'Edited a draft invoice',
+        deleted: 'Deleted a draft invoice',
+        posted: 'Posted an invoice',
+      },
+      receipt: {
+        created: 'Recorded a money receipt',
+        allocated: 'Applied a money receipt to invoices',
+        voided: 'Voided a money receipt',
+      },
+      credit_limit: { overridden: 'Went over a customer’s credit limit' },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -2282,6 +2590,12 @@ export const en = {
       customerReference: 'Customer’s reference',
       order: 'Sales order',
       vehicle: 'Vehicle',
+      dueDate: 'Due date',
+      amount: 'Amount',
+      method: 'Paid by',
+      invoices: 'Invoices',
+      limit: 'Credit limit',
+      exposure: 'Owed with orders',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -2663,6 +2977,46 @@ export const en = {
     delivery_order_line_invalid:
       'This line does not match the chosen order. Remove it, and add it again from the order.',
     delivery_over_order: 'This is more than the order has left to deliver. Lower the quantity.',
+    sales_branch_invalid: 'Pick an active branch.',
+    invoice_due_date: 'The due date cannot be before the invoice date.',
+    invoice_warehouse_required:
+      'Pick the warehouse the goods leave from: the items that are not on a challan are delivered by this invoice.',
+    invoice_line_source:
+      'A line bills a challan line or an order line, not both. Remove it and add it again.',
+    invoice_stock_not_allowed:
+      'This line comes from a challan or an order, so its batch and serial numbers come from there. Clear them.',
+    invoice_delivery_line_invalid:
+      'This challan line is not a posted line of this customer, or its item, unit or quantity changed. Remove it and add it again from the challan.',
+    invoice_line_twice: 'This line is on the invoice twice. Remove one of them.',
+    invoice_delivery_line_billed:
+      'Another invoice already bills this challan line. Remove it from this invoice.',
+    invoice_order_line_invalid: 'Pick a service line of a confirmed order of this customer.',
+    invoice_order_line_billed:
+      'Another invoice already bills this order line. Remove it from this invoice.',
+    invoice_vat_mixed:
+      'These orders write their prices differently, some with VAT and some before VAT. Bill them on separate invoices.',
+    order_has_invoices:
+      'Invoices bill this order. Delete their drafts first; once one is posted, the order can only be closed.',
+    receipt_amount_required: 'Enter an amount above 0.',
+    receipt_account_invalid:
+      'Pick an active account that holds money, like Cash in hand or a bank account.',
+    receipt_over_allocated:
+      'This applies more than the receipt’s amount. Lower the amounts on the invoices.',
+    receipt_invoice_invalid: 'Pick a posted invoice of this customer.',
+    receipt_invoice_twice: 'This invoice is on the list twice. Remove one of them.',
+    receipt_over_invoice:
+      'This is more than the invoice still owes. Another receipt may have paid it: reload and lower the amount.',
+    receipt_voided: 'This receipt is voided and can no longer change. Reload the page.',
+    receipt_void_reason_required: 'Say why it is voided, like "Cheque bounced".',
+    receipt_void_date: 'The void date cannot be before the receipt’s date.',
+    credit_limit_exceeded:
+      'This takes the customer to {{exposure}}, over their credit limit of {{limit}}. Record a payment first, or ask someone who may go over the limit.',
+    credit_override_forbidden:
+      'Going over a credit limit needs the {{permissions}} permission. Ask a workspace owner to grant it.',
+    journal_is_sales:
+      'An invoice or a money receipt made this entry, so it is not reversed here. Void a receipt on its own page.',
+    account_money_type:
+      'Only an asset account can hold money. Clear the tick, or move the account under an asset group.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, which is taken from
  `en`, so a key that is missing in Bangla fails the type check. The `errors` object ends with
  `satisfies Record<ErrorCode, string>`: the 25 error codes that 15c.1 and 15c.3 added must all be here, or the
  i18n package itself does not compile. That was the only error in this package when this part started.
- **Keys built from contract values.** The numbering page calls `` t(`numbering.documents.${type}`) ``, the journal
  `` t(`journal.sources.${source}`) ``, the roles matrix `` t(`permissions.${key}`) `` and the audit log
  `` t(`audit.actions.${action}`) `` and `` t(`audit.entityTypes.${type}`) ``. These template strings are typed
  from the contract's unions, so the new number series (MR), the two journal sources (`sales_invoice`,
  `sales_receipt`), the three permissions, the eight audit actions and the two entity types each need a key here.
  The same goes for the new unions the pages will show: `invoices.statuses`, `invoices.payment` (from
  `PAYMENT_STATUSES`), `invoices.paymentFilters`, `receipts.statuses`, `receipts.methods`,
  `deliveries.invoiceStates` and `deliveries.invoiceFilters`. Missing one fails the type check, which is better
  than a raw key on the screen.
- **`nav.receipts` is "Money receipts", not "Receipts".** The inventory already has a "Goods receipt (GRN)" number
  series, and a store keeper reads "Receipts" as goods that came in. "Money receipt" (MR) is the name on the
  printed slip in Bangladeshi offices.
- **`accounts.holdsMoney`, `holdsMoneyHint` and `holdsMoneyFromGroup`** are the new tick on the account form
  (15c.1). The hint says what the tick changes (a money receipt can go into the account) and that a tick on a group
  counts for every account inside, so nobody ticks each new bank account by hand. `holdsMoneyFromGroup` explains
  a tick the person cannot clear: the group above holds money, so this account does too
  (`moneyAccountIds()` walks up the tree).
- **`journal.invoiceEntryHint` and `receiptEntryHint`.** The journal's Reverse refuses an entry an invoice or a
  receipt made (`journal_is_sales`, 15c.3). The entry page shows one of these lines instead of the Reverse button,
  so the person learns where to go before they click. A receipt is undone by voiding it; an invoice is not undone
  in 15c at all, so its hint says only that it stays as it is. Credit notes, which correct an invoice, are 15d.
- **`customers.credit`** is the line under the customer on the order and the invoice form. It reads the numbers
  of `GET /customers/:id/credit` (15c.1): what is on confirmed orders, and what credit is left of the limit. It has
  its own keys for the two special limits: no limit (`null`), and cash only (`0`), where "৳0 left of ৳0" would be
  true but useless. `kpis.onOrder` and `kpis.creditLeft` are the same numbers in the customer page's KPI strip.
- **`customers.newInvoice` and `recordPayment`** are the customer page's actions: the accountant who just read a
  customer's statement usually wants to bill them or record their cheque next.
- **`salesOrders.invoiced`** is the order page's new column (`invoicedQuantity` per line, 15c.1).
- **`deliveries.invoiceStates`, `billing` and `invoiceFilters`.** A posted challan shows how much of it is billed
  (`invoiceState`), and the list can show only the challans that still need an invoice ("To invoice"). `billing`
  is the label of that filter. `makeInvoice` is the challan page's button that opens a new invoice for it.
- **`invoices.payment` and `invoices.overdue`.** The contract has two statuses (draft, posted) and works out the
  payment status from what was paid (`paymentStatusOf()`, 15c.1). "Overdue" is not stored either: the page works
  it out with `isOverdue()` and the workspace's today. The list's filter (`paymentFilters`) matches the API's
  `payment` query: `open` reads "Not paid", because "open" means nothing to a shop owner.
- **`invoices.customerLocked`.** Lines from a challan or an order belong to that challan's customer. The form keeps
  the customer box read only while such lines are there, and says how to change it, instead of silently dropping
  the lines.
- **`invoices.dueDateHint`.** The due date may be left empty: the API then uses the date plus the customer's
  payment terms (`dueDateOf()`, 15c.1). The hint says so, so an empty box does not look like a missing value.
- **`invoices.branchHint` and `warehouseHint`.** Both boxes are new to the person who writes an invoice. The branch
  decides where the sale shows in the profit and loss by branch (step 11). The warehouse is needed only for items
  that are not on a challan, which this invoice delivers itself (a counter sale); `noWarehouse` is its empty
  option.
- **The three ways to add a line.** "Add challans" bills the posted challans of the customer, "Add order charges"
  bills the services on their orders, and the existing "Add items" (from `salesLines`) adds an item of its own.
  Each picker has a title, a description and an empty text. The order list cannot tell which orders still have a
  service to bill, so a click on an order with none left says so with `noChargesLeft`. Under each line,
  `fromChallan`, `fromOrder` or
  `ownLine` says what it bills, and `challanLineHint` explains why the item, unit and quantity of a challan line
  cannot be changed (a challan line is billed whole, 15c.1).
- **`invoices.postHint` says what posting does.** It books the sale, and it may also take goods out of the
  warehouse (a line of its own). The person reads both before the first post, not in the stock card afterwards.
- **`invoices.noEntry`.** An invoice of ৳0 (a free sample) has no journal entry (15c.3). The page says why, instead
  of an empty "Journal entry" row.
- **`overdueNotice_one` / `_other`.** A posted invoice past its due date shows how late it is, in days. i18next
  picks the key by `count`.
- **`receipts.methods` and `referencePlaceholders`.** The method decides nothing in the books, but it decides what
  the reference is: a cheque number, a bank's transfer reference, a bKash TrxID. The form changes the placeholder
  with the method, so the person knows what to type.
- **`receipts.noAccounts`.** A workspace made before 15c has its money accounts ticked by migration 0030, but a
  chart someone built by hand may have none. The receipt form then cannot be saved, so it says where to fix it.
- **The allocation words** (`applyTitle` to `overBy`). The form lists the customer's unpaid invoices, oldest due
  date first, and suggests amounts with "Apply oldest first" (the FIFO you chose). `applied` and `unapplied` are the
  totals under the list. What is not applied is kept as an advance, and the word "advance" is what the customer's
  balance already shows for money paid early (`customers.inAdvance`, 15a). `overBy` shows the moment the amounts
  add up to more than the receipt, before the server says `receipt_over_allocated`. Each row shows the invoice's
  due date under its number (`invoices.dueOn`, "Due 15 Oct 2026"), and the two lists show the date under the
  number, like the 15b lists, so neither `allocationColumns` nor the lists' `columns` have a date key.
- **`receipts.saveHint`.** A receipt has no draft: saving posts it (15c.1). The hint says this before the click,
  because a person used to the other documents expects a draft.
- **Void has a title, a body, a date, a reason and its own toast.** It cannot be undone. The body says what happens
  (the entry is reversed, the money comes off the invoices, the number stays), and the date hint says which date to
  pick for a bounced cheque. `keepReceipt` is the dialog's "No" button, for the same reason as `keepOrder` in 15b:
  "Cancel" next to "Void receipt" would be unclear.
- **`creditLimit`** is the dialog that asks before an order or an invoice goes over the customer's credit limit
  (decision 3). It is shown only to someone with `sales.credit.override`; it names the amount and the limit, says
  what counts, and says that the audit log records the override. `confirmOrder` and `postInvoice` are the two
  "yes" buttons: each says exactly what happens on its page.
- **`print`** holds the words of the printed documents. They are separate from the page words, because paper
  speaks to the customer ("Your reference", "Bill to"), while the page speaks to the person at the desk
  ("Customer's reference"). `titles` names each document, `columns` the line table, `signatures` the lines at the
  foot, and `printedAt` a small line that shows which copy is the latest.
- **The audit words.** `audit.fields` are the field names 15c.3 writes and the log did not know yet: `dueDate`,
  `amount`, `method`, `invoices` (how many invoices a new receipt paid), and `limit` and `exposure` (an override).
  The other fields (`number`, `date`, `customer`, `total`, `lines`, `entry`, `reason`, `reversal`) were there
  already. `receipt.allocated` writes the invoice numbers themselves as field names, so the log shows them as they
  are: one row per invoice, like "INV-2026-27-0004: 0.00 → 30000.00".
- **Each error message says how to fix the problem** (CLAUDE.md → Copy). A few notes:
  - `credit_limit_exceeded` has `{{exposure}}` and `{{limit}}`. The API sends them as plain decimal strings; the
    form formats them as money before it shows the message (15c.6), so the person reads "৳2,35,000.00", not
    "235000.0000".
  - `credit_override_forbidden` names the permission with `{{permissions}}`, like the general `forbidden` message.
  - `order_has_invoices` covers both refusals of 15c.3 in one sentence: reopening an order with any invoice (delete
    the draft invoices), and cancelling an order with a posted one (close it instead).
  - `receipt_over_invoice` also covers the race that 15c.3 maps from the database (another receipt paid the
    invoice first), so it says to reload.
  - `receipt_amount_required` is used for the receipt's amount and for each amount applied to an invoice; "above
    0" fits both.

### `locales/bn.ts`

```diff
@@ -75,6 +75,8 @@ export const bn: Messages = {
     quotations: 'কোটেশন',
     salesOrders: 'সেলস অর্ডার',
     deliveries: 'ডেলিভারি',
+    invoices: 'ইনভয়েস',
+    receipts: 'মানি রিসিট',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -214,6 +216,7 @@ export const bn: Messages = {
         customer: 'গ্রাহক কোড',
         quotation: 'কোটেশন',
         delivery: 'ডেলিভারি চালান',
+        receipt: 'মানি রিসিট',
       },
       purchase: { order: 'পারচেজ অর্ডার (PO)', bill: 'সাপ্লায়ারের বিল' },
       inventory: {
@@ -321,6 +324,10 @@ export const bn: Messages = {
     namePlaceholder: 'Dutch-Bangla Bank CD A/C 1234',
     about: 'বিবরণ',
     aboutPlaceholder: 'রপ্তানির টাকা জমা হওয়ার মূল অ্যাকাউন্ট',
+    holdsMoney: 'টাকা রাখা হয়',
+    holdsMoneyHint:
+      'নগদ, ব্যাংক আর মোবাইল ওয়ালেট অ্যাকাউন্ট: মানি রিসিটের টাকা এগুলোর একটায় যায়। গ্রুপে টিক দিলে তার ভেতরের সব অ্যাকাউন্টে খাটে।',
+    holdsMoneyFromGroup: 'টাকা রাখা হয়, কারণ {{name}} গ্রুপে টিক দেওয়া।',
     typeLine: '{{type}} · {{balance}}',
     topLevel: 'সবার উপরের গ্রুপ। এটা সবসময় চার্টের শীর্ষেই থাকে।',
     systemHint:
@@ -427,10 +434,16 @@ export const bn: Messages = {
       stock_transfer: 'স্টক ট্রান্সফার',
       stock_revaluation: 'স্টকের পুনর্মূল্যায়ন',
       sales_delivery: 'ডেলিভারি',
+      sales_invoice: 'ইনভয়েস',
+      sales_receipt: 'মানি রিসিট',
     },
     fromDocument: '{{document}} থেকে',
     stockEntryHint:
       'এই এন্ট্রিটা একটা স্টকের ডকুমেন্ট বানিয়েছে। সংশোধন করতে আরেকটা স্টকের ডকুমেন্ট পোস্ট করুন: অ্যাডজাস্টমেন্ট, বা পুনর্মূল্যায়ন।',
+    invoiceEntryHint:
+      'একটা ইনভয়েস এই এন্ট্রি বানিয়েছে। পোস্ট করা ইনভয়েস যেমন আছে তেমনই থাকে, তাই এখানে এন্ট্রিটা রিভার্স হয় না।',
+    receiptEntryHint:
+      'একটা মানি রিসিট এই এন্ট্রি বানিয়েছে। ফেরাতে চাইলে রিসিটের নিজের পেজে সেটা বাতিল করুন।',
     draftSaved: 'ড্রাফট সেভ হয়েছে',
     posted: '{{number}} পোস্ট হয়েছে',
     deleted: 'ড্রাফট মোছা হয়েছে',
@@ -1438,10 +1451,21 @@ export const bn: Messages = {
       balance: 'ব্যালান্স',
       creditLimit: 'ক্রেডিট লিমিট',
       terms: 'পেমেন্টের শর্ত',
+      onOrder: 'কনফার্ম করা অর্ডারে',
+      creditLeft: 'বাকি ক্রেডিট',
     },
     owes: '{{amount}} পাওনা',
     inAdvance: '{{amount}} অগ্রিম',
     settled: 'কোনো পাওনা নেই',
+    credit: {
+      onOrder: 'কনফার্ম করা অর্ডারে {{amount}}',
+      left: 'বাকি ক্রেডিট: {{limit}}-এর মধ্যে {{amount}}',
+      over: 'ক্রেডিট লিমিটের চেয়ে {{amount}} বেশি',
+      noLimit: 'ক্রেডিট লিমিট নেই',
+      cashOnly: 'শুধু নগদ: কোনো ক্রেডিট নেই',
+    },
+    newInvoice: 'নতুন ইনভয়েস',
+    recordPayment: 'পেমেন্ট লিখুন',
     details: 'বিস্তারিত',
     noAddresses: 'কোনো ঠিকানা নেই',
     statementTitle: 'স্টেটমেন্ট',
@@ -1706,6 +1730,7 @@ export const bn: Messages = {
     keepOrder: 'অর্ডার রাখুন',
     delivered: 'ডেলিভারি হয়েছে',
     left: 'ডেলিভারি বাকি',
+    invoiced: 'ইনভয়েস হয়েছে',
     serviceLine: 'সার্ভিস: ডেলিভারি হয় না',
     deliveriesTitle: 'ডেলিভারি',
     deliveriesSubtitle: 'যে চালানগুলো এই অর্ডারের বিপরীতে মাল নিয়েছে',
@@ -1729,6 +1754,13 @@ export const bn: Messages = {
     show: 'দেখান',
     all: 'সব',
     statuses: { draft: 'খসড়া', posted: 'পোস্ট করা' },
+    invoiceStates: {
+      not_invoiced: 'ইনভয়েস হয়নি',
+      partly_invoiced: 'কিছুটা ইনভয়েস হয়েছে',
+      invoiced: 'ইনভয়েস হয়েছে',
+    },
+    billing: 'বিল',
+    invoiceFilters: { to_invoice: 'ইনভয়েস বাকি', invoiced: 'ইনভয়েস হয়েছে' },
     columns: {
       number: 'নম্বর',
       customer: 'গ্রাহক',
@@ -1774,6 +1806,253 @@ export const bn: Messages = {
     emptyBody:
       'কনফার্ম করা অর্ডারের পেজ থেকে ডেলিভারি দিন, অথবা অর্ডার ছাড়া মাল নিতে আসা গ্রাহকের জন্য একটা ডেলিভারি লিখুন।',
     loadFailed: 'ডেলিভারিগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    makeInvoice: 'ইনভয়েস বানান',
+    invoicesTitle: 'ইনভয়েস',
+    invoicesSubtitle: 'যে পোস্ট করা ইনভয়েসগুলো এই চালানের বিল করেছে',
+    notInvoicedYet: 'এখনো বিল হয়নি।',
+    lineInvoiced: 'ইনভয়েস হয়েছে',
+  },
+  invoices: {
+    title: 'ইনভয়েস',
+    description: 'গ্রাহকদের কী বিল করা হয়েছে, আর তাদের কাছে কত বাকি',
+    new: 'নতুন ইনভয়েস',
+    newTitle: 'নতুন ইনভয়েস',
+    draftTitle: 'খসড়া ইনভয়েস',
+    back: 'ইনভয়েস',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: { draft: 'খসড়া', posted: 'পোস্ট করা' },
+    payment: { unpaid: 'পরিশোধ হয়নি', partly_paid: 'কিছুটা পরিশোধিত', paid: 'পরিশোধিত' },
+    overdue: 'সময় পার',
+    paymentFilters: { open: 'পরিশোধ বাকি', overdue: 'সময় পার', paid: 'পরিশোধিত' },
+    columns: {
+      number: 'নম্বর',
+      customer: 'গ্রাহক',
+      dueDate: 'পরিশোধের তারিখ',
+      total: 'মোট',
+      due: 'বাকি',
+      status: 'অবস্থা',
+    },
+    customer: 'গ্রাহক',
+    customerLocked: 'গ্রাহক বদলাতে আগে চালান আর অর্ডারের লাইনগুলো সরান।',
+    date: 'ইনভয়েসের তারিখ',
+    dueDate: 'পরিশোধের তারিখ',
+    dueDateHint: 'খালি রাখলে গ্রাহকের পেমেন্টের শর্ত অনুযায়ী।',
+    dueOn: '{{date}}-এর মধ্যে পরিশোধ',
+    customerReference: 'গ্রাহকের রেফারেন্স',
+    customerReferenceHint: 'তাদের PO বা ইনডেন্ট নম্বর',
+    customerReferencePlaceholder: 'PO-HM-2026-1187',
+    branch: 'ব্রাঞ্চ',
+    branchHint: 'বিক্রিটা কোন ব্রাঞ্চের। ব্রাঞ্চভিত্তিক লাভ-ক্ষতিতে সেখানেই দেখাবে।',
+    warehouse: 'যে গুদাম থেকে যাবে',
+    warehouseHint:
+      'শুধু যে আইটেম কোনো চালানে নেই তার জন্য: ইনভয়েস পোস্ট করলে সেগুলো এখান থেকে ডেলিভারি হয়।',
+    noWarehouse: 'সব আইটেম চালানে আছে',
+    billingAddress: 'বিলের ঠিকানা',
+    noBillingAddress: 'বিলের ঠিকানা নেই',
+    note: 'নোট',
+    notePlaceholder: 'ইনভয়েসের ৩০ দিনের মধ্যে চেক বা ব্যাংক ট্রান্সফারে পরিশোধ করুন।',
+    addChallans: 'চালান যোগ করুন',
+    challanPickerTitle: 'চালানের বিল',
+    challanPickerDescription:
+      'এই গ্রাহকের পোস্ট করা চালান, যার বিল এখনো হয়নি। প্রতিটা ক্লিকে চালানের লাইনগুলো অর্ডারের দামে যোগ হয়।',
+    challanPickerEmpty: 'এই গ্রাহকের সব পোস্ট করা চালানের বিল হয়ে গেছে।',
+    challanLines_one: '{{count}}টা আইটেম',
+    challanLines_other: '{{count}}টা আইটেম',
+    addCharges: 'অর্ডারের চার্জ যোগ করুন',
+    chargePickerTitle: 'অর্ডারের চার্জের বিল',
+    chargePickerDescription:
+      'এই গ্রাহকের অর্ডারের সার্ভিস, যার বিল এখনো হয়নি, যেমন ডেলিভারি বা এমব্রয়ডারির চার্জ। প্রতি ক্লিকে সেই অর্ডারের বাকিটা যোগ হয়।',
+    chargePickerEmpty: 'এই গ্রাহকের কোনো কনফার্ম করা অর্ডার নেই।',
+    noChargesLeft: '{{number}}-এর সব সার্ভিসের বিল আগেই হয়ে গেছে।',
+    pickCustomerFirst: 'আগে গ্রাহক বাছুন।',
+    fromChallan: '{{number}} থেকে',
+    fromOrder: '{{number}}-এর সার্ভিস',
+    ownLine: 'এই ইনভয়েসই ডেলিভারি দেবে',
+    challanLineHint: 'আইটেম, ইউনিট আর পরিমাণ চালানের।',
+    saveDraft: 'খসড়া সেভ করুন',
+    post: 'ইনভয়েস পোস্ট করুন',
+    posting: 'পোস্ট হচ্ছে…',
+    posted: '{{number}} পোস্ট হয়েছে',
+    draftSaved: 'খসড়া সেভ হয়েছে',
+    deleteDraft: 'খসড়া মুছুন',
+    confirmDelete: 'এই খসড়া মুছুন',
+    deleteWarning: 'মুছে ফেলা খসড়া আর ফেরানো যায় না। এর চালানগুলোর আবার বিল করা যাবে।',
+    deleted: 'খসড়া মুছে ফেলা হয়েছে',
+    postHint:
+      'পোস্ট করলে ইনভয়েস তার নম্বর পায় আর বিক্রি হিসাবে ওঠে। যে আইটেম কোনো চালানে নেই সেগুলো নিজের একটা চালানে গুদাম থেকে বের হয়। পোস্ট করা ইনভয়েস আর বদলায় না।',
+    cantWrite:
+      'আপনি ইনভয়েস দেখতে পারেন। লিখতে আর পোস্ট করতে একজন workspace owner-এর কাছে sales.invoice.manage permission চান।',
+    postedOn: '{{date}}-এ পোস্ট হয়েছে',
+    entry: 'জার্নাল এন্ট্রি',
+    noEntry: 'জার্নাল এন্ট্রি নেই: এই ইনভয়েসে কোনো টাকা ধরা হয়নি',
+    paid: 'পরিশোধিত',
+    due: 'বাকি',
+    overdueNotice_one: 'এই ইনভয়েস পরিশোধের তারিখ ছিল {{date}}: {{count}} দিন দেরি।',
+    overdueNotice_other: 'এই ইনভয়েস পরিশোধের তারিখ ছিল {{date}}: {{count}} দিন দেরি।',
+    challansTitle: 'চালান',
+    challansSubtitle: 'এই ইনভয়েস যে ডেলিভারিগুলোর বিল করেছে',
+    ordersTitle: 'অর্ডার',
+    paymentsTitle: 'পেমেন্ট',
+    paymentsSubtitle: 'এই ইনভয়েসে যে মানি রিসিটের টাকা ধরা হয়েছে',
+    noPayments: 'এখনো কিছু পরিশোধ হয়নি।',
+    recordPayment: 'পেমেন্ট লিখুন',
+    notFound: 'এই ইনভয়েস নেই, অথবা এটা একটা খসড়া ছিল যা মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো ইনভয়েস নেই',
+    emptyBody:
+      'পোস্ট করা চালানের পেজ থেকে তার বিল করুন, যেমন মিরপুর ডিপোতে পাঠানো ৪০০ কার্টন, অথবা কাউন্টারের বিক্রির জন্য একটা ইনভয়েস লিখুন: সেটা নিজেই মাল ডেলিভারি দেয়।',
+    loadFailed: 'ইনভয়েসগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  receipts: {
+    title: 'মানি রিসিট',
+    description: 'গ্রাহকেরা কত টাকা দিয়েছেন, আর সেটা কোন ইনভয়েসে গেছে',
+    new: 'পেমেন্ট লিখুন',
+    newTitle: 'একটা পেমেন্ট লিখুন',
+    back: 'মানি রিসিট',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: { posted: 'পোস্ট করা', voided: 'বাতিল' },
+    methods: {
+      cash: 'নগদ',
+      bank_transfer: 'ব্যাংক ট্রান্সফার',
+      cheque: 'চেক',
+      mobile_wallet: 'মোবাইল ওয়ালেট',
+      card: 'কার্ড',
+    },
+    columns: {
+      number: 'নম্বর',
+      customer: 'গ্রাহক',
+      method: 'যেভাবে দিয়েছেন',
+      amount: 'টাকা',
+      unapplied: 'ধরা হয়নি',
+      status: 'অবস্থা',
+    },
+    customer: 'গ্রাহক',
+    date: 'তারিখ',
+    amount: 'টাকার পরিমাণ',
+    account: 'যে অ্যাকাউন্টে জমা',
+    accountHint: 'নগদ, ব্যাংক বা মোবাইল ওয়ালেট অ্যাকাউন্ট',
+    accountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+    noAccounts:
+      'এখনো কোনো অ্যাকাউন্টে টাকা রাখা হয় না। চার্ট অফ অ্যাকাউন্টসে নগদ আর ব্যাংক অ্যাকাউন্টে "টাকা রাখা হয়" টিক দিন।',
+    method: 'যেভাবে দিয়েছেন',
+    reference: 'রেফারেন্স',
+    referencePlaceholders: {
+      cash: 'মিরপুর ডিপো থেকে রহিম এনেছেন',
+      bank_transfer: 'DBBL transfer ref 2026092312345',
+      cheque: 'চেক 0045123, সোনালী ব্যাংক মতিঝিল',
+      mobile_wallet: 'bKash TrxID 9JK3L2M8NP',
+      card: 'কার্ডের শেষ ৪ সংখ্যা 4821',
+    },
+    branch: 'ব্রাঞ্চ',
+    note: 'নোট',
+    notePlaceholder: 'মিরপুর ডিপোর সেপ্টেম্বরের ডেলিভারির জন্য।',
+    applyTitle: 'ইনভয়েসে ধরুন',
+    applySubtitle: 'সবচেয়ে পুরনোটা আগে। গ্রাহক কোন ইনভয়েস দিচ্ছেন বললে টাকার অঙ্ক বদলান।',
+    applyOldest: 'পুরনোটা আগে ধরুন',
+    clearAll: 'সব মুছুন',
+    allocationColumns: {
+      invoice: 'ইনভয়েস',
+      date: 'তারিখ',
+      total: 'মোট',
+      due: 'বাকি',
+      amount: 'ধরুন',
+    },
+    applyTo: '{{number}}-এ যত টাকা ধরা হলো',
+    pickCustomer: 'অপরিশোধিত ইনভয়েস দেখতে গ্রাহক বাছুন।',
+    noOpenInvoices: 'এই গ্রাহকের কোনো অপরিশোধিত ইনভয়েস নেই। পুরো টাকাটা অগ্রিম হিসেবে থাকবে।',
+    applied: 'ধরা হয়েছে',
+    unapplied: 'অগ্রিম হিসেবে থাকবে',
+    overBy: '{{amount}} বেশি',
+    save: 'রিসিট সেভ করুন',
+    saving: 'সেভ হচ্ছে…',
+    saved: '{{number}} সেভ হয়েছে',
+    saveHint: 'সেভ করলেই পোস্ট হয়: টাকা অ্যাকাউন্টে জমা হয় আর গ্রাহকের পাওনা থেকে কমে।',
+    unappliedNotice:
+      '{{amount}} এখনো কোনো ইনভয়েসে ধরা হয়নি। না ধরা পর্যন্ত এটা অগ্রিম হিসেবে থাকে।',
+    apply: 'টাকা ধরুন',
+    applyDialogTitle: '{{number}} ধরুন',
+    applySave: 'সেভ করুন',
+    allocated: '{{number}} ধরা হয়েছে',
+    void: 'রিসিট বাতিল করুন',
+    voidTitle: '{{number}} বাতিল করুন',
+    voidBody:
+      'বাতিলের তারিখে এর এন্ট্রি রিভার্স হয়, আর এর টাকা ইনভয়েসগুলো থেকে উঠে যায়। রিসিটটা তার নম্বর নিয়ে তালিকায় থেকে যায়।',
+    voidDate: 'বাতিলের তারিখ',
+    voidDateHint: 'যেদিন জানা গেল টাকাটা আসেনি, যেমন চেক ফেরত আসার দিন।',
+    voidReason: 'কারণ',
+    voidReasonPlaceholder: 'চেক ফেরত: অ্যাকাউন্টে যথেষ্ট টাকা নেই',
+    confirmVoid: 'রিসিট বাতিল করুন',
+    keepReceipt: 'রিসিট রাখুন',
+    voided: '{{number}} বাতিল হয়েছে',
+    voidedNotice: '{{date}}-এ বাতিল: {{reason}}',
+    entry: 'জার্নাল এন্ট্রি',
+    voidEntry: 'রিভার্সাল',
+    invoicesTitle: 'যে ইনভয়েসগুলো পরিশোধ হলো',
+    noAllocations: 'কোনো ইনভয়েসে ধরা হয়নি।',
+    cantWrite:
+      'আপনি মানি রিসিট দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে sales.receipt.manage permission চান।',
+    notFound: 'এই মানি রিসিট নেই।',
+    emptyTitle: 'এখনো কোনো মানি রিসিট নেই',
+    emptyBody: 'গ্রাহক যা দেন তা লিখুন: কাউন্টারে নগদ, চেক, ব্যাংক ট্রান্সফার বা bKash পেমেন্ট।',
+    loadFailed: 'মানি রিসিটগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  creditLimit: {
+    title: 'ক্রেডিট লিমিটের বাইরে',
+    body: 'এতে {{customer}}-এর পাওনা হবে {{exposure}}, তাদের ক্রেডিট লিমিট {{limit}}-এর বেশি।',
+    counts: 'এখনকার পাওনা আর কনফার্ম করা অর্ডার ধরা হয়েছে, এই ডকুমেন্টসহ।',
+    audit: 'লিমিট পার হওয়ার কথা অডিট লগে লেখা থাকবে।',
+    confirmOrder: 'তবুও কনফার্ম করুন',
+    postInvoice: 'তবুও পোস্ট করুন',
+    back: 'ফিরে যান',
+  },
+  print: {
+    print: 'প্রিন্ট',
+    titles: {
+      quotation: 'কোটেশন',
+      salesOrder: 'সেলস অর্ডার',
+      delivery: 'ডেলিভারি চালান',
+      invoice: 'ইনভয়েস',
+      receipt: 'মানি রিসিট',
+    },
+    bin: 'BIN {{bin}}',
+    phone: 'ফোন {{phone}}',
+    number: 'নং',
+    date: 'তারিখ',
+    validUntil: 'যে তারিখ পর্যন্ত',
+    deliveryDate: 'ডেলিভারির তারিখ',
+    dueDate: 'পরিশোধের তারিখ',
+    customerReference: 'আপনার রেফারেন্স',
+    order: 'অর্ডার',
+    vehicle: 'গাড়ি',
+    billTo: 'বিলের ঠিকানা',
+    shipTo: 'পাঠানোর ঠিকানা',
+    customer: 'গ্রাহক',
+    columns: {
+      number: '#',
+      item: 'আইটেম',
+      quantity: 'পরিমাণ',
+      price: 'দাম',
+      discount: 'ছাড়',
+      vat: 'VAT',
+      amount: 'টাকা',
+    },
+    batch: 'ব্যাচ {{lot}}',
+    expires: 'মেয়াদ {{date}}',
+    serials: 'সিরিয়াল নম্বর: {{serials}}',
+    receivedFrom: 'যার কাছ থেকে পাওয়া গেছে',
+    amountReceived: 'পাওয়া টাকা',
+    paidBy: 'যেভাবে দিয়েছেন',
+    reference: 'রেফারেন্স',
+    appliedTo: 'যে ইনভয়েসে ধরা হলো',
+    advance: 'অগ্রিম হিসেবে রাখা',
+    signatures: {
+      customer: 'গ্রাহকের স্বাক্ষর',
+      receivedBy: 'গ্রহণকারী',
+      preparedBy: 'প্রস্তুতকারী',
+      authorised: 'অনুমোদিত স্বাক্ষর',
+    },
+    printedAt: '{{date}}-এ প্রিন্ট করা',
   },
   yearEnd: {
     title: 'বছর শেষের ক্লোজিং',
@@ -1945,6 +2224,9 @@ export const bn: Messages = {
       quotation: { manage: 'কোটেশন লেখা, আর প্রত্যাখ্যাত হিসেবে চিহ্নিত করা' },
       order: { manage: 'সেলস অর্ডার লেখা, কনফার্ম, বন্ধ আর বাতিল করা' },
       delivery: { manage: 'ডেলিভারি লেখা আর পোস্ট করা: মাল গুদাম থেকে বের হয়' },
+      invoice: { manage: 'ইনভয়েস লেখা আর পোস্ট করা' },
+      receipt: { manage: 'মানি রিসিট লেখা, ইনভয়েসে ধরা আর বাতিল করা' },
+      credit: { override: 'গ্রাহকের ক্রেডিট লিমিটের বাইরে অর্ডার কনফার্ম আর ইনভয়েস পোস্ট করা' },
     },
   },
   invite: {
@@ -1999,6 +2281,8 @@ export const bn: Messages = {
       quotation: 'কোটেশন',
       sales_order: 'সেলস অর্ডার',
       delivery: 'ডেলিভারি',
+      invoice: 'ইনভয়েস',
+      receipt: 'মানি রিসিট',
     },
     columns: {
       when: 'কখন',
@@ -2162,6 +2446,18 @@ export const bn: Messages = {
         deleted: 'একটা খসড়া ডেলিভারি মুছেছেন',
         posted: 'একটা ডেলিভারি পোস্ট করেছেন',
       },
+      invoice: {
+        created: 'একটা ইনভয়েস লিখেছেন',
+        updated: 'একটা খসড়া ইনভয়েস বদলেছেন',
+        deleted: 'একটা খসড়া ইনভয়েস মুছেছেন',
+        posted: 'একটা ইনভয়েস পোস্ট করেছেন',
+      },
+      receipt: {
+        created: 'একটা মানি রিসিট লিখেছেন',
+        allocated: 'একটা মানি রিসিট ইনভয়েসে ধরেছেন',
+        voided: 'একটা মানি রিসিট বাতিল করেছেন',
+      },
+      credit_limit: { overridden: 'গ্রাহকের ক্রেডিট লিমিট পার করেছেন' },
     },
     fields: {
       name: 'নাম',
@@ -2256,6 +2552,12 @@ export const bn: Messages = {
       customerReference: 'গ্রাহকের রেফারেন্স',
       order: 'সেলস অর্ডার',
       vehicle: 'গাড়ি',
+      dueDate: 'পরিশোধের তারিখ',
+      amount: 'টাকা',
+      method: 'যেভাবে দিয়েছেন',
+      invoices: 'ইনভয়েস',
+      limit: 'ক্রেডিট লিমিট',
+      exposure: 'অর্ডারসহ পাওনা',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -2624,6 +2926,45 @@ export const bn: Messages = {
     delivery_order_line_invalid:
       'এই লাইন বাছাই করা অর্ডারের সাথে মেলে না। সরিয়ে অর্ডার থেকে আবার যোগ করুন।',
     delivery_over_order: 'অর্ডারে যা ডেলিভারি বাকি তার চেয়ে বেশি। পরিমাণ কমান।',
+    sales_branch_invalid: 'একটা চালু ব্রাঞ্চ বাছুন।',
+    invoice_due_date: 'পরিশোধের তারিখ ইনভয়েসের তারিখের আগে হতে পারে না।',
+    invoice_warehouse_required:
+      'কোন গুদাম থেকে মাল যাবে বাছুন: যে আইটেম কোনো চালানে নেই, এই ইনভয়েসই সেগুলো ডেলিভারি দেয়।',
+    invoice_line_source:
+      'একটা লাইন হয় চালানের লাইনের বিল করে, নয়তো অর্ডারের লাইনের, দুটোর না। লাইনটা সরিয়ে আবার যোগ করুন।',
+    invoice_stock_not_allowed:
+      'এই লাইন চালান বা অর্ডার থেকে এসেছে, তাই এর ব্যাচ আর সিরিয়াল নম্বর সেখান থেকেই আসে। এগুলো মুছুন।',
+    invoice_delivery_line_invalid:
+      'এই চালানের লাইনটা এই গ্রাহকের পোস্ট করা লাইন না, অথবা এর আইটেম, ইউনিট বা পরিমাণ বদলেছে। লাইনটা সরিয়ে চালান থেকে আবার যোগ করুন।',
+    invoice_line_twice: 'এই লাইন ইনভয়েসে দুবার আছে। একটা সরান।',
+    invoice_delivery_line_billed:
+      'অন্য একটা ইনভয়েস এই চালানের লাইনের বিল আগেই করেছে। এই ইনভয়েস থেকে লাইনটা সরান।',
+    invoice_order_line_invalid: 'এই গ্রাহকের কনফার্ম করা অর্ডারের একটা সার্ভিস লাইন বাছুন।',
+    invoice_order_line_billed:
+      'অন্য একটা ইনভয়েস এই অর্ডারের লাইনের বিল আগেই করেছে। এই ইনভয়েস থেকে লাইনটা সরান।',
+    invoice_vat_mixed:
+      'এই অর্ডারগুলো দাম আলাদাভাবে লেখে, কোনোটা VAT-সহ আর কোনোটা VAT-এর আগে। এগুলোর আলাদা ইনভয়েসে বিল করুন।',
+    order_has_invoices:
+      'ইনভয়েস এই অর্ডারের বিল করে। আগে সেগুলোর খসড়া মুছুন; একটাও পোস্ট হলে অর্ডারটা শুধু বন্ধ করা যায়।',
+    receipt_amount_required: '0-এর বেশি একটা অঙ্ক লিখুন।',
+    receipt_account_invalid:
+      'টাকা রাখা হয় এমন একটা চালু অ্যাকাউন্ট বাছুন, যেমন হাতে নগদ বা একটা ব্যাংক অ্যাকাউন্ট।',
+    receipt_over_allocated: 'রিসিটের টাকার চেয়ে বেশি ধরা হয়েছে। ইনভয়েসগুলোর অঙ্ক কমান।',
+    receipt_invoice_invalid: 'এই গ্রাহকের একটা পোস্ট করা ইনভয়েস বাছুন।',
+    receipt_invoice_twice: 'এই ইনভয়েস তালিকায় দুবার আছে। একটা সরান।',
+    receipt_over_invoice:
+      'ইনভয়েসে যা বাকি তার চেয়ে বেশি। অন্য রিসিট হয়তো এটা পরিশোধ করেছে: রিলোড করে অঙ্ক কমান।',
+    receipt_voided: 'এই রিসিট বাতিল হয়েছে, এটা আর বদলানো যায় না। পেজটা রিলোড করুন।',
+    receipt_void_reason_required: 'কেন বাতিল লিখুন, যেমন "চেক ফেরত এসেছে"।',
+    receipt_void_date: 'বাতিলের তারিখ রিসিটের তারিখের আগে হতে পারে না।',
+    credit_limit_exceeded:
+      'এতে গ্রাহকের পাওনা হবে {{exposure}}, তাদের ক্রেডিট লিমিট {{limit}}-এর বেশি। আগে একটা পেমেন্ট লিখুন, অথবা যিনি লিমিট পার করতে পারেন তাকে বলুন।',
+    credit_override_forbidden:
+      'ক্রেডিট লিমিট পার করতে {{permissions}} permission লাগে। একজন workspace owner-কে দিতে বলুন।',
+    journal_is_sales:
+      'একটা ইনভয়েস বা মানি রিসিট এই এন্ট্রি বানিয়েছে, তাই এখানে রিভার্স হয় না। রিসিট তার নিজের পেজে বাতিল করুন।',
+    account_money_type:
+      'শুধু অ্যাসেট অ্যাকাউন্টে টাকা রাখা যায়। টিক তুলে দিন, অথবা অ্যাকাউন্টটা একটা অ্যাসেট গ্রুপের নিচে সরান।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
```

- **The words follow the existing Bangla text.** "বিক্রয় ইনভয়েস" was already the name of the INV number series,
  so the pages say "ইনভয়েস". "মানি রিসিট" is what Bangladeshi offices call the MR slip; "রসিদ" would be correct,
  but the printed slips say "Money Receipt". Branch stays "ব্রাঞ্চ" and warehouse "গুদাম", as on the earlier pages.
  Workspace, PO, VAT, BIN and the permission keys stay in English inside the Bangla sentences (CLAUDE.md →
  Language).
- **"ধরা" for applying money to an invoice.** An accountant says "টাকাটা কোন ইনভয়েসে ধরব?". The more literal
  "প্রয়োগ" would read like a textbook.
- **"বাতিল" for void.** It is the word for cancel, too, but a receipt has nothing else that cancels, and a cashier
  says "রিসিট বাতিল". The dialog body says exactly what voiding does, so the word does not have to carry it.
- **"সময় পার" for overdue, "বাকি" for still due.** Both are short enough for a pill and a column header.
- **Typed examples use ASCII digits**: the bKash TrxID, the cheque and the card numbers in
  `referencePlaceholders`, and "0" in `receipt_amount_required`. The inputs always show ASCII digits (CLAUDE.md →
  Money input), so the example looks like what the person will type. Plain text, like "৩০ দিনের মধ্যে" or
  "৪০০ কার্টন", uses Bangla digits.
- **`_one` and `_other` have the same text.** Bangla does not change the noun for a plural. Both keys still have
  to exist, because `Messages` has both.

### `styles.css`: paper is white

```diff
@@ -97,6 +97,49 @@
   --overlay: rgb(0 0 0 / 0.6);
 }
 
+/* Paper is white, whatever the screen's theme. Without this, a dark theme prints its light text
+   on white paper, almost unreadable. The light colors again, for printing only: later in the
+   file than the dark rules and just as specific, so they win over both. */
+@media print {
+  :root,
+  :root:not([data-theme='light']),
+  :root[data-theme='dark'] {
+    color-scheme: light;
+    --bg: #ffffff;
+    --surface: #ffffff;
+    --subtle: #f1f3f6;
+    --line: #e4e7ec;
+    --line-strong: #d0d5dd;
+    --ink: #0f1728;
+    --ink-2: #475467;
+    --ink-3: #8a94a6;
+    --brand: #1f47b5;
+    --brand-hover: #193b97;
+    --brand-soft: #edf1fb;
+    --brand-line: #c9d5f3;
+    --brand-ink: #ffffff;
+    --good: #0a7a4b;
+    --good-bg: #ecf8f1;
+    --warn: #b25e09;
+    --warn-bg: #fef6e7;
+    --crit: #b42318;
+    --crit-bg: #fef1f0;
+  }
+
+  /* A document page puts its print sheet (PrintSheet) straight into <body>. While one is there,
+     only the sheet prints: the app, a toast or an open dialog stay on the screen. A page without
+     a sheet prints as it is, without the sidebar (AppShell). */
+  body:has(> [data-print-sheet]) > :not([data-print-sheet]) {
+    display: none;
+  }
+}
+
+/* Every printed document is A4, the paper offices in Bangladesh use */
+@page {
+  size: A4;
+  margin: 12mm;
+}
+
 /* shadcn/ui-র নিজের নাম আমাদের token-এ পয়েন্ট করা — shadcn থেকে কপি করা component
    (bg-primary, border-input …) কোনো বদল ছাড়াই একই রং পায়। নিজেদের কোডে brand/ink নামই লিখুন */
 :root {
```

- **Why the colors again.** The tokens change with the theme. A person who works in the dark theme and prints an
  invoice would get light grey text (`--ink` is `#EEF1F6` in dark) on white paper, almost unreadable; the browser
  drops the dark background but not the text color. Inside `@media print`, the light values come back.
- **Why three selectors.** The dark values are set by `:root:not([data-theme='light'])` (inside
  `prefers-color-scheme: dark`) and by `:root[data-theme='dark']`. Both have the specificity of two classes. The
  print rule lists the same two selectors, plus `:root`, and comes later in the file. With equal specificity the
  later rule wins, so whatever the theme, print uses the light colors. A plain `:root` alone would lose to both.
- **Only the colors.** The shadows, the focus ring and the overlay are left as they are: they do not show on paper
  in a way that matters, and a print sheet does not use them.
- **`body:has(> [data-print-sheet]) > :not([data-print-sheet])`.** When a document page renders its print sheet
  (below), everything else in `<body>` is hidden on paper: the app, a toast that is still showing, a dialog. The
  `:has()` keeps this to pages that have a sheet. On any other page, the browser's Print prints the page as it is,
  as it did before. `:has()` works in current versions of every major browser (Chrome and Edge 105+, Safari 15.4+,
  Firefox 121+). An older browser drops the whole rule: it then prints the page with the sheet under it, which is
  untidy but still readable.
- **`@page { size: A4; margin: 12mm }`.** A4 is the paper of offices in Bangladesh, and setting it here means the
  browser's print dialog starts on A4 even on a computer set up for Letter. 12 mm leaves room for the printer's own
  margin without wasting the page.

### `components/app-shell.tsx`: no sidebar on paper

```diff
@@ -30,8 +30,10 @@ export function AppShell({
   children,
 }: AppShellProps) {
   return (
-    <div className="min-h-dvh min-[860px]:grid min-[860px]:grid-cols-[244px_minmax(0,1fr)]">
-      <aside className="flex flex-col gap-3 border-b border-line bg-surface px-4 pt-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:gap-5 min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5">
+    // print:block: on paper there is no sidebar column, even when a landscape page is wider than
+    // 860px. print:hidden: the navigation is never printed.
+    <div className="min-h-dvh min-[860px]:grid min-[860px]:grid-cols-[244px_minmax(0,1fr)] print:block">
+      <aside className="flex flex-col gap-3 border-b border-line bg-surface px-4 pt-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:gap-5 min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5 print:hidden">
         <div className="flex items-center justify-between gap-3 px-2">
           {brand}
           <div className="flex items-center gap-1">
@@ -48,7 +50,9 @@ export function AppShell({
         )}
       </aside>
       {/* min-w-0: grid-এর ভেতরে চওড়া টেবিল কলামটাকে ঠেলে বড় করতে না পারে — পেজ আড়াআড়ি scroll হয় না */}
-      <main className="min-w-0 px-4 py-6 min-[860px]:px-8 min-[860px]:py-8">{children}</main>
+      <main className="min-w-0 px-4 py-6 min-[860px]:px-8 min-[860px]:py-8 print:p-0">
+        {children}
+      </main>
     </div>
   );
 }
```

- **`print:hidden` on the sidebar.** A page printed without a sheet (a list, a report) should not start with the
  navigation. Tailwind's `print:` variant is `@media print`.
- **`print:block` on the shell.** On a wide screen the shell is a grid with a 244px sidebar column. The paper's
  width decides the media queries when printing, and a landscape A4 page is wider than 860px, so the grid would
  come back with an empty 244px column. `print:block` turns the grid off on paper.
- **`print:p-0` on the content.** The page margin comes from `@page`; the screen padding on top of it would only
  shrink the printed area.

### `components/print-sheet.tsx` (new)

```tsx
import { Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// One row of the document's details, top right: "No." and "INV-2026-27-0001"
export interface PrintMeta {
  label: string;
  value: string;
}

interface PrintSheetProps {
  // The company's logo (an <img>), or nothing
  logo?: ReactNode;
  company: string;
  // Under the company's name: the address, the BIN, the phone
  companyLines?: readonly string[];
  // The document's name, like "Invoice"
  title: string;
  meta: readonly PrintMeta[];
  children: ReactNode;
  // The lines people sign at the foot, like "Received by" and "Authorised signature"
  signatures?: readonly string[];
  // A small line at the very bottom, like when it was printed
  footer?: string;
}

// A document as it goes on paper: the browser's Print (or Save as PDF) prints this and nothing
// else (styles.css → @media print). It is hidden on the screen, where the page itself shows the
// document. It is rendered straight into <body>, outside the app, so the print rule can hide
// everything around it by one selector.
export function PrintSheet({
  logo,
  company,
  companyLines = [],
  title,
  meta,
  children,
  signatures = [],
  footer,
}: PrintSheetProps) {
  return createPortal(
    <article data-print-sheet="" className="hidden bg-surface text-body-sm text-ink print:block">
      <header className="flex items-start justify-between gap-8 border-b border-ink pb-4">
        <div className="flex min-w-0 items-start gap-3">
          {logo}
          <div className="min-w-0">
            <p className="text-h3 font-semibold">{company}</p>
            {companyLines.map((line, index) => (
              // An address may repeat a line (two branches on one road); the index keeps keys unique
              <p key={`${String(index)}-${line}`} className="text-caption text-ink-2">
                {line}
              </p>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <h1 className="text-h2">{title}</h1>
          <dl className="mt-2 grid grid-cols-[auto_auto] justify-end gap-x-3 gap-y-0.5 text-caption">
            {meta.map((item) => (
              <Fragment key={item.label}>
                <dt className="text-ink-3">{item.label}</dt>
                <dd className="font-medium tabular-nums">{item.value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </header>
      <div className="mt-5 grid gap-5">{children}</div>
      {signatures.length > 0 && (
        // break-inside-avoid: the signature lines never split over two pages
        <footer className="mt-16 grid break-inside-avoid auto-cols-fr grid-flow-col gap-8">
          {signatures.map((label) => (
            <p key={label} className="border-t border-ink pt-1.5 text-caption text-ink-2">
              {label}
            </p>
          ))}
        </footer>
      )}
      {footer && <p className="mt-6 text-caption text-ink-3">{footer}</p>}
    </article>,
    document.body,
  );
}

// A labelled part of the sheet: "Bill to" over the customer's name and address
export function PrintBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="break-inside-avoid">
      <p className="text-caption font-medium text-ink-3">{label}</p>
      <div className="mt-1">{children}</div>
    </section>
  );
}
```

- **One frame for every printed document.** The quotation, the order, the challan, the invoice and the receipt all
  start with the same header (the logo, the company, its address and BIN on the left; the document's name, number
  and dates on the right) and end with signature lines. Writing that frame once keeps the five documents alike,
  which is what a customer expects from one company's papers.
- **`createPortal(…, document.body)`.** The sheet is rendered straight into `<body>`, outside the app's root. That is
  what lets one CSS rule (`body:has(> [data-print-sheet])`) hide the app around it. If the sheet were inside the
  page, the rule would have to hide every ancestor's siblings, level by level. The app is a single-page app with no
  server rendering, so `document` always exists here.
- **`hidden print:block`.** On the screen the page itself shows the document, with its buttons and links; the sheet
  is not shown and is not read by screen readers (a `display: none` element is out of the accessibility tree). On
  paper only the sheet shows.
- **No words of its own.** Every label comes in as a prop, already translated by the app. The ui package does not
  know the documents, and a `t()` call here would need a key for every document type.
- **`meta` is a list of `{ label, value }`.** Each document has different details (an invoice has a due date, a
  challan a vehicle), so the frame takes a list and renders it as a `<dl>`: the labels in `ink-3`, the values at
  weight 500 with `tabular-nums`, so dates and numbers line up.
- **The company lines get an index in their key.** An address split into lines may repeat a line, and React keys
  must be unique. The index alone would also work here (the list never reorders), but the text keeps the key
  readable.
- **`border-ink` for the rules.** On paper a `line` border (`#E4E7EC`) is often too pale for an office printer to
  print at all. The header rule and the signature lines are what the reader's eye follows, so they use `ink`.
- **The signatures use `auto-cols-fr grid-flow-col`.** A challan has three signature lines, a receipt two. Equal
  columns for any count, without a class per count.
- **`break-inside-avoid`** keeps the signature block and each `PrintBlock` on one page. A long invoice may run to a
  second page; "Bill to" split from its address, or a signature line alone at the top of a page, is what that
  prevents. Line tables are the app's own (15c.6): a `<thead>` repeats on each printed page by itself.
- **`PrintBlock`** is a labelled part, like "Bill to" over the customer's name and address. The label is a `<p>`,
  not a heading, because headings get the 600 weight and tight letter-spacing of the global style, and this is a
  caption.

```diff
@@ -52,6 +52,7 @@ export { MoneyInput } from './components/money-input.js';
 export { PageHeader, SectionHeader } from './components/page-header.js';
 export { Pill, type PillTone } from './components/pill.js';
 export { Popover, PopoverContent, PopoverTrigger } from './components/popover.js';
+export { PrintBlock, PrintSheet, type PrintMeta } from './components/print-sheet.js';
 export { SegmentedControl } from './components/segmented-control.js';
 export { SelectableCardGroup, type SelectableCardOption } from './components/selectable-card.js';
 export { Stepper } from './components/stepper.js';
```

The package exports `PrintSheet`, `PrintBlock` and the `PrintMeta` type. CLAUDE.md's design system gets a "Print
layout" entry in 15c.8, like the discount box got its own in 15b ("If something is missing, extend this section
first, then use it").

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/ui build
```

Build `@omnivo/contracts` first: the i18n package reads its built `ErrorCode` type, so until then the 25 new codes
are unknown and the `satisfies` line fails the other way round. Then build `@omnivo/i18n` before you type-check
`@omnivo/ui`, which reads the i18n package's built types.

> **What we checked in this part.** `packages/i18n` and `packages/ui` type-check, and ESLint and Prettier are clean.
> The i18n unit tests pass (11), and both packages build. The app has nine type errors left, all in fixtures and
> the MSW mock (15c.6, 15c.7). No error is about a missing translation key. Writing `audit.fields` showed that the
> `receipt.allocated` row left out an invoice the money was taken off; `ReceiptsService.allocationChanges()` (15c.3)
> and one more check in `invoices.int.spec.ts` (15c.4) fix and prove it. That spec passes (26 tests); with the
> `null` rows removed, its new check fails.

## 15c.6 — `apps/app`: the screens, and the printed page

Two lists, two documents and the pieces around them: Sales → Invoices and Money receipts. An invoice is a form
while it is a draft and a page with its challans, orders and payments once it is posted. A money receipt has no
draft: its form saves and posts at once, and its page can only apply the money again or void it. Around them, the
order form and the invoice form ask before going over a customer's credit limit, a challan gets "Make invoice",
the order page counts what is billed, the customer page bills and records payments, the account form gets the
"Holds money" tick, and the journal links an entry back to its invoice or receipt. Quotations, orders, challans,
invoices and receipts all get a Print button (one A4 layout, your decision 4).

Some earlier parts changed while the screens were built, and their bullets say so:
- 15c.1 and 15c.3: each invoice line also carries `deliveryNumber` and `orderNumber`. A draft's line must say which
  challan it bills, and the invoice's `deliveries` list does not say which line came from which. 15c.4 checks the
  two new fields.
- 15c.5: the charge picker's words changed (`noChargesLeft` is new), and three unused keys went
  (`invoices.columns.date`, `receipts.columns.date`, `receipts.allocationColumns.dueDate`).
- Four older chunks went over their 100 KB budget, because every page that calls the API carries the contracts'
  `routes`, and 15c.1 made them bigger. The last section of this part says how each one came back under.

After this part the app has six type errors left, all in the MSW mock (accounts without `holdsMoney`, order and
delivery lines without `invoicedQuantity` and `invoiced`, order inputs without `overrideCreditLimit`); 15c.7 fixes
them.

### `lib/invoices.ts` (new): the parts without React

```ts
import {
  compareMoney,
  defaultLineDescription,
  type DeliveryLine,
  type Invoice,
  type InvoiceLineFormValues,
  type InvoiceSummary,
  isMoneyAmount,
  isZeroMoney,
  isZeroQuantity,
  plainQuantity,
  priceInUnit,
  type PriceLookupItem,
  prorateMoney,
  type ReceiptAllocation,
  type SalesOrderLine,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';

import {
  formDiscount,
  isServiceLine,
  type LineMeta,
  type SalesItem,
  savedLines,
  toFormLine,
} from './sales';
import { daysUntil } from './stock';

// The pure parts of the invoice and money receipt pages (step 15c), unit-tested in
// invoices.spec.ts like lib/sales.ts.

// ---------------------------------------------------------------------------------------------
// Where an invoice line comes from

// What the form knows about a line that bills a challan line or an order's service line, by that
// line's id. The form value holds only the id the API wants; the page needs the numbers to say
// "From DC-2026-27-0042", and the order's price setting to price the invoice the same way.
export interface LineOrigin {
  deliveryNumber: string | null;
  orderNumber: string | null;
  // The order's "prices include VAT"; null when no order is behind the line
  pricesIncludeVat: boolean | null;
}

// The challan line or order line a line bills; null for a line of its own. The form's ids are ''
// or null when empty (the schema's input takes both).
export function sourceIdOf(line: {
  deliveryLineId?: string | null;
  orderLineId?: string | null;
}): string | null {
  const filled = (id: string | null | undefined) =>
    id === undefined || id === null || id === '' ? null : id;
  return filled(line.deliveryLineId) ?? filled(line.orderLineId);
}

// How the lines that come from orders write their prices: true or false, or null when no line
// does. The API prices the invoice the orders' way and refuses two ways at once
// (invoice_vat_mixed), so the form takes the same answer.
export function orderPricing(
  lines: readonly { deliveryLineId?: string | null; orderLineId?: string | null }[],
  origins: ReadonlyMap<string, LineOrigin>,
): boolean | null {
  for (const line of lines) {
    const id = sourceIdOf(line);
    const setting = id === null ? null : (origins.get(id)?.pricesIncludeVat ?? null);
    if (setting !== null) return setting;
  }
  return null;
}

// A goods line from a challan: always goods, with the challan line's own item fields
export function itemOfDeliveryLine(line: DeliveryLine): SalesItem {
  return {
    variantId: line.variantId,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    optionValues: line.optionValues,
    sku: line.sku,
    baseUnitId: line.baseUnitId,
    units: line.units,
    productType: 'goods',
    tracking: line.tracking,
    hasExpiry: line.hasExpiry,
  };
}

// A unit's size in the base unit, from the product's packs: "1" for the base unit itself
function factorOf(
  item: { baseUnitId: string; units: readonly { unitId: string; factor: string }[] },
  unitId: string,
): string {
  if (unitId === item.baseUnitId) return '1';
  const pack = item.units.find((unit) => unit.unitId === unitId);
  if (pack === undefined) throw new Error(`The product has no unit ${unitId}`);
  return pack.factor;
}

// A challan line as an invoice line. It bills the line whole: the item, unit and quantity are the
// challan's. With an order behind it, the price, discount, VAT rate and description are the
// order's, moved to the challan's unit (an order of cases delivered by the piece bills ৳21 a
// piece, not ৳504), and an amount discount goes with the share of the order this challan line
// carries. Without an order, the price lookup's price for this customer, as on a new order line.
export function challanLineToInvoice(
  line: DeliveryLine,
  orderLine: SalesOrderLine | undefined,
  price: PriceLookupItem | undefined,
): InvoiceLineFormValues {
  const fixed = {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    deliveryLineId: line.id,
    // The API reads the order line from the challan line; the contract refuses both on one line
    orderLineId: '',
    // The goods left with their own batch and serial numbers, on the challan
    batchId: '',
    serialNumbers: [],
  };
  if (orderLine === undefined) {
    return {
      ...fixed,
      description: '',
      unitPrice: price?.price ?? '',
      discountType: 'percent',
      discount: '',
      taxRateId: price?.taxRateId ?? '',
    };
  }
  const discount =
    orderLine.discountType === 'percent'
      ? orderLine.discount
      : prorateMoney(orderLine.discount, line.baseQuantity, orderLine.baseQuantity);
  return {
    ...fixed,
    description:
      orderLine.description === defaultLineDescription(orderLine) ? '' : orderLine.description,
    unitPrice: priceInUnit(
      orderLine.unitPrice,
      factorOf(line, orderLine.unitId),
      factorOf(line, line.unitId),
    ),
    discountType: orderLine.discountType,
    discount: formDiscount(discount),
    taxRateId: orderLine.taxRate.id,
  };
}

// An order's service line (a delivery charge) as an invoice line: billed whole, as it was sold
export function orderChargeToInvoice(line: SalesOrderLine): InvoiceLineFormValues {
  return {
    ...toFormLine(line),
    deliveryLineId: '',
    orderLineId: line.id,
    batchId: '',
    serialNumbers: [],
  };
}

// The lines of a challan an invoice may still bill: not billed by a posted invoice, and not on
// this form already
export function challanLinesLeft(
  lines: readonly DeliveryLine[],
  onForm: ReadonlySet<string>,
): DeliveryLine[] {
  return lines.filter((line) => !line.invoiced && !onForm.has(line.id));
}

// The service lines of an order an invoice may still bill. A goods line is billed through its
// challan: only the challan says the goods left.
export function chargesLeft(
  lines: readonly SalesOrderLine[],
  onForm: ReadonlySet<string>,
): SalesOrderLine[] {
  return lines.filter(
    (line) => isServiceLine(line) && isZeroQuantity(line.invoicedQuantity) && !onForm.has(line.id),
  );
}

// A draft invoice, as the form holds it: its lines, the editor's meta, and where each billed line
// comes from. A challan line goes back without its order line and without the challan's batch
// (the API sent them for the page and the print; the contract refuses them on such a line).
export function savedInvoiceLines(
  invoice: Pick<Invoice, 'customer' | 'pricesIncludeVat' | 'lines'>,
): {
  values: InvoiceLineFormValues[];
  meta: LineMeta[];
  origins: Map<string, LineOrigin>;
} {
  const origins = new Map<string, LineOrigin>();
  const values = invoice.lines.map((line): InvoiceLineFormValues => {
    const billed = line.deliveryLineId !== null || line.orderLineId !== null;
    const sourceId = line.deliveryLineId ?? line.orderLineId;
    if (sourceId !== null) {
      origins.set(sourceId, {
        deliveryNumber: line.deliveryNumber,
        orderNumber: line.orderNumber,
        // A draft is priced the way its orders write prices (the API checked that)
        pricesIncludeVat: line.orderNumber === null ? null : invoice.pricesIncludeVat,
      });
    }
    return {
      ...toFormLine(line),
      deliveryLineId: line.deliveryLineId ?? '',
      orderLineId: line.deliveryLineId === null ? (line.orderLineId ?? '') : '',
      batchId: billed ? '' : (line.batchId ?? ''),
      serialNumbers: billed ? [] : line.serialNumbers,
    };
  });
  return { values, meta: savedLines(invoice.lines, invoice.customer.id).meta, origins };
}
```

- **Pure functions, in their own file**, like `lib/sales.ts` in 15b: `invoices.spec.ts` tests them without a
  browser, and the invoice form, its pickers and the receipt form share them.
- **`LineOrigin` lives beside the form, not in it.** The contract allows a line to send only the id it bills
  (`deliveryLineId` or `orderLineId`). The page also needs to say "From DC-2026-27-0042" and to know how the order
  behind the line writes its prices. The form keeps these in a map by that id, so the form value stays exactly
  what the API accepts.
- **`sourceIdOf()` treats `''` and `null` the same.** The schema's input type (`optionalIdSchema`) takes both for
  "none": the form starts with `''`, and a value the resolver has parsed is `null`. Checking only `!== ''` would
  call a `null` a challan line.
- **`orderPricing()`** answers how the lines that come from orders write their prices. The API prices the whole
  invoice the orders' way and refuses two ways at once (`invoice_vat_mixed`, 15c.3). The form uses the same answer
  for its totals, so the total on the form is the total the API will save. `null` means "no order decides", and the
  form then falls back to the draft's own setting or the workspace's, in the API's order.
- **`challanLineToInvoice()` bills the challan line whole**: its item, unit and quantity, never another number
  (15c.1: a challan line is billed once and whole). With an order behind it, the price comes from the order line:
  - **`priceInUnit()` moves the price to the challan's unit.** An order of 2 cases at ৳504 a case, delivered as 12
    pieces, bills ৳21 a piece. Copying ৳504 to a line of pieces would bill 24 times too much.
  - **A percent discount is copied; an amount discount is shared** with `prorateMoney()`: ৳100 off 48 pieces gives
    ৳25 to a challan of 12. Copying the whole ৳100 to every challan of the order would give it away again on each.
  - **`formDiscount()` (15b)** turns the result into a box value with at most 2 decimals, as the contract's
    `DISCOUNT` wants.
  - **An empty description** when the order's text is just the product's name, as `toFormLine()` does in 15b, so the
    line keeps following the product.
  - **`orderLineId: ''`, `batchId: ''`, `serialNumbers: []`.** The server reads the order line from the challan
    line, and the goods left with the challan's own batch. The contract refuses either one on a challan line
    (`invoice_line_source`, `invoice_stock_not_allowed`).
- **Without an order, the price lookup's price** (15b), the price a new order line would get for this customer. A
  challan for goods collected without an order has no price anywhere else.
- **`factorOf()` throws for a unit the product does not have.** Every unit on a challan line and on its order line
  is one of the product's packs, so the throw means a bug. A silent factor of 1 would quietly bill the wrong price.
- **`challanLinesLeft()` and `chargesLeft()`** leave out what is billed and what is already on the form. A second
  click on the same challan adds nothing twice. `chargesLeft()` keeps only service lines: goods on an order are
  billed through their challan, because only the challan says the goods left.
- **`savedInvoiceLines()`** turns a draft back into form values. A challan line goes back without the order line and
  the batch that the API sent for the page and the print; sending them back would be refused. Its meta comes from
  `savedLines()` (15b), because an invoice line is a sales line with more fields.

```ts
// ---------------------------------------------------------------------------------------------
// What is owed

// What an invoice still asks for
export function amountDue(invoice: { total: string; amountPaid: string }): string {
  return subtractMoney(invoice.total, invoice.amountPaid);
}

// How many days past its due date an invoice is (0 on the due date itself)
export function daysLate(dueDate: string, today: string): number {
  return Math.max(0, -daysUntil(dueDate, today));
}

// ---------------------------------------------------------------------------------------------
// Applying a receipt's money

// One invoice the money can go to. `due` is what this receipt may put on it: what the invoice still
// owes, plus what this receipt already put there (applying it again replaces its own amounts).
export interface AllocationRow {
  invoiceId: string;
  number: string;
  date: string;
  dueDate: string;
  total: string;
  due: string;
}

// The invoices a receipt can pay: the customer's open ones, and those it already pays (one it paid
// in full is not open any more, but it is still on the receipt). The oldest due date first, the
// order the money goes in.
export function allocationRows(
  open: readonly InvoiceSummary[],
  mine: readonly ReceiptAllocation[],
): AllocationRow[] {
  const own = new Map(mine.map((allocation) => [allocation.invoiceId, allocation.amount]));
  const rows = new Map<string, AllocationRow>();
  for (const invoice of open) {
    rows.set(invoice.id, {
      invoiceId: invoice.id,
      // An open invoice is posted, so it has a number
      number: invoice.number ?? '',
      date: invoice.date,
      dueDate: invoice.dueDate,
      total: invoice.total,
      due: sumMoney([amountDue(invoice), own.get(invoice.id) ?? '0']),
    });
  }
  for (const allocation of mine) {
    if (rows.has(allocation.invoiceId)) continue;
    // Paid in full, partly by this receipt: what it may hold is what it holds now
    rows.set(allocation.invoiceId, {
      invoiceId: allocation.invoiceId,
      number: allocation.invoiceNumber,
      date: allocation.invoiceDate,
      dueDate: allocation.dueDate,
      total: allocation.invoiceTotal,
      due: allocation.amount,
    });
  }
  return [...rows.values()].toSorted(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.date.localeCompare(b.date) ||
      a.number.localeCompare(b.number),
  );
}

// "Apply oldest first": the amount over the rows in their order, each taking what it still owes
// until the money runs out. What is left after the last row stays as an advance. Nothing while
// the amount box does not hold an amount.
export function suggestAllocations(
  amount: string,
  rows: readonly AllocationRow[],
): { invoiceId: string; amount: string }[] {
  if (!isMoneyAmount(amount.trim())) return [];
  let left = amount.trim();
  const allocations: { invoiceId: string; amount: string }[] = [];
  for (const row of rows) {
    if (compareMoney(left, '0') <= 0) break;
    const take = compareMoney(left, row.due) < 0 ? left : row.due;
    if (isZeroMoney(take)) continue;
    allocations.push({ invoiceId: row.invoiceId, amount: plainQuantity(take) });
    left = subtractMoney(left, take);
  }
  return allocations;
}

// What the boxes add up to, counting only those that hold an amount (one being typed counts as
// nothing, so the line under the table never throws)
export function appliedOf(allocations: readonly { amount: string }[]): string {
  return sumMoney(
    allocations
      .map((allocation) => allocation.amount.trim())
      .filter((value) => isMoneyAmount(value)),
  );
}
```

- **`daysLate()`** is never negative: on the due date and before, an invoice is not late. It uses `daysUntil()`
  (step 13), which counts calendar days from the ISO dates, so no time zone moves a day.
- **`AllocationRow.due` is what this receipt may put on the invoice.** That is what the invoice still owes plus what
  this receipt already put there: applying the money again replaces the receipt's own amounts (15c.3), so its old
  amount is free again.
- **`allocationRows()` adds the receipt's own invoices** even when they are not open any more. An invoice the receipt
  paid in full has nothing left to pay, so the open list does not have it, but the apply dialog must still show it,
  or its amount could never be moved. The rows are sorted by due date, then date and number, the API's order for
  open invoices.
- **`suggestAllocations()` is "Apply oldest first"** (the FIFO you chose): each row takes what it still owes until
  the money runs out, and the rest stays as an advance. Nothing while the amount box does not hold an amount, so a
  half-typed "12." suggests nothing instead of throwing.
- **`appliedOf()` adds up only finished amounts.** A box being typed counts as nothing, so the total under the table
  never throws while the person types.

```ts
import type {
  DeliveryLine,
  Invoice,
  InvoiceLine,
  InvoiceSummary,
  ReceiptAllocation,
  SalesOrderLine,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  allocationRows,
  appliedOf,
  challanLineToInvoice,
  chargesLeft,
  daysLate,
  orderPricing,
  savedInvoiceLines,
  suggestAllocations,
} from './invoices';

const item = {
  variantId: 'juice',
  productId: 'p-juice',
  productCode: 'P-00012',
  productName: 'Mango juice 250 ml',
  optionValues: [],
  sku: 'P-00012',
  baseUnitId: 'pcs',
  tracking: 'none',
  hasExpiry: false,
  units: [{ unitId: 'case', factor: '24.000000' }],
};

// The order line of lib/sales.spec.ts: 2 cases of 24 at ৳504 a case, 10% off
function orderLine(extra: Partial<SalesOrderLine> = {}): SalesOrderLine {
  return {
    ...item,
    id: 'line-juice',
    productType: 'goods',
    unitId: 'case',
    quantity: '2.0000',
    baseQuantity: '48.0000',
    description: 'Mango juice 250 ml',
    unitPrice: '504.0000',
    discountType: 'percent',
    discount: '10.0000',
    taxRate: { id: 'vat15', name: 'VAT 15%', kind: 'standard', rate: '15.00' },
    net: '907.2000',
    vat: '136.0800',
    total: '1043.2800',
    deliveredQuantity: '48.0000',
    invoicedQuantity: '0.0000',
    ...extra,
  };
}

// A challan line that took 12 pieces of that order line
function challanLine(extra: Partial<DeliveryLine> = {}): DeliveryLine {
  return {
    ...item,
    id: 'dl-1',
    unitId: 'pcs',
    quantity: '12.0000',
    baseQuantity: '12.0000',
    batchId: null,
    lotNumber: null,
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
    orderLineId: 'line-juice',
    value: null,
    invoiced: false,
    ...extra,
  };
}

describe('challanLineToInvoice', () => {
  it('bills the challan line whole, at the order price moved to the challan unit', () => {
    expect(challanLineToInvoice(challanLine(), orderLine(), undefined)).toEqual({
      variantId: 'juice',
      unitId: 'pcs',
      quantity: '12',
      deliveryLineId: 'dl-1',
      orderLineId: '',
      batchId: '',
      serialNumbers: [],
      // The order's text is the product's name: an empty box, like a saved line
      description: '',
      // ৳504 a case of 24 is ৳21 a piece
      unitPrice: '21.0000',
      discountType: 'percent',
      discount: '10',
      taxRateId: 'vat15',
    });
  });

  it('gives an amount discount the share of the order this line carries', () => {
    // ৳100 off 48 pieces; 12 of them went on this challan
    const line = challanLineToInvoice(
      challanLine(),
      orderLine({ discountType: 'amount', discount: '100.0000' }),
      undefined,
    );
    expect(line.discountType).toBe('amount');
    expect(line.discount).toBe('25');
  });

  it('takes the looked-up price when no order is behind the challan', () => {
    const line = challanLineToInvoice(challanLine({ orderLineId: null }), undefined, {
      variantId: 'juice',
      unitId: 'pcs',
      price: '22.5000',
      source: 'price_list',
      taxRateId: 'vat15',
    });
    expect(line).toMatchObject({ unitPrice: '22.5000', taxRateId: 'vat15', discount: '' });
  });
});

describe('chargesLeft', () => {
  it('keeps the service lines not billed yet and not on the form', () => {
    const lines = [
      orderLine(),
      orderLine({ id: 'delivery', productType: 'service' }),
      orderLine({ id: 'billed', productType: 'service', invoicedQuantity: '1.0000' }),
      orderLine({ id: 'on-form', productType: 'service' }),
    ];
    expect(chargesLeft(lines, new Set(['on-form'])).map((line) => line.id)).toEqual(['delivery']);
  });
});

describe('orderPricing', () => {
  const origins = new Map([
    ['dl-1', { deliveryNumber: 'DC-1', orderNumber: null, pricesIncludeVat: null }],
    ['dl-2', { deliveryNumber: 'DC-2', orderNumber: 'SO-1', pricesIncludeVat: true }],
  ]);

  it('follows the first line an order prices', () => {
    expect(
      orderPricing(
        [{ deliveryLineId: '' }, { deliveryLineId: 'dl-1' }, { deliveryLineId: 'dl-2' }],
        origins,
      ),
    ).toBe(true);
  });

  it('is null when no order is behind any line', () => {
    expect(orderPricing([{ deliveryLineId: 'dl-1' }, { deliveryLineId: null }], origins)).toBe(
      null,
    );
  });
});

describe('savedInvoiceLines', () => {
  it('sends a challan line back without its order line and its batch', () => {
    const line: InvoiceLine = {
      ...orderLine(),
      id: 'il-1',
      deliveryLineId: 'dl-1',
      orderLineId: 'line-juice',
      deliveryNumber: 'DC-2026-27-0042',
      orderNumber: 'SO-2026-27-0007',
      batchId: 'batch-1',
      lotNumber: 'MJ2409',
      expiresOn: '2027-03-01',
      serialNumbers: [],
    };
    const invoice = {
      customer: { id: 'c-1', code: 'C-00001', name: 'Rahman Traders' },
      pricesIncludeVat: false,
      lines: [line],
    } satisfies Pick<Invoice, 'customer' | 'pricesIncludeVat' | 'lines'>;
    const saved = savedInvoiceLines(invoice);
    expect(saved.values[0]).toMatchObject({
      deliveryLineId: 'dl-1',
      orderLineId: '',
      batchId: '',
      serialNumbers: [],
    });
    expect(saved.origins.get('dl-1')).toEqual({
      deliveryNumber: 'DC-2026-27-0042',
      orderNumber: 'SO-2026-27-0007',
      pricesIncludeVat: false,
    });
  });
});

function invoice(id: string, dueDate: string, total: string, amountPaid: string): InvoiceSummary {
  return {
    id,
    number: `INV-${id}`,
    date: '2026-09-01',
    dueDate,
    customer: { id: 'c-1', code: 'C-00001', name: 'Rahman Traders' },
    customerReference: null,
    branchId: 'b-1',
    status: 'posted',
    net: total,
    vat: '0.0000',
    total,
    amountPaid,
    lineCount: 1,
    postedAt: '2026-09-01T04:00:00.000Z',
    version: 1,
    updatedAt: '2026-09-01T04:00:00.000Z',
  };
}

describe('allocationRows and suggestAllocations', () => {
  const open = [
    invoice('2', '2026-10-15', '800.0000', '0.0000'),
    invoice('1', '2026-10-01', '1000.0000', '200.0000'),
  ];

  it('lists the oldest due date first, with what each still owes', () => {
    expect(allocationRows(open, []).map((row) => [row.number, row.due])).toEqual([
      ['INV-1', '800.0000'],
      ['INV-2', '800.0000'],
    ]);
  });

  it("counts this receipt's own amount back in, and keeps an invoice it paid in full", () => {
    const mine: ReceiptAllocation[] = [
      {
        invoiceId: '1',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-09-01',
        dueDate: '2026-10-01',
        invoiceTotal: '1000.0000',
        amount: '200.0000',
      },
      {
        invoiceId: '0',
        invoiceNumber: 'INV-0',
        invoiceDate: '2026-08-01',
        dueDate: '2026-09-01',
        invoiceTotal: '300.0000',
        amount: '300.0000',
      },
    ];
    expect(allocationRows(open, mine).map((row) => [row.number, row.due])).toEqual([
      ['INV-0', '300.0000'],
      ['INV-1', '1000.0000'],
      ['INV-2', '800.0000'],
    ]);
  });

  it('pays the oldest first until the money runs out', () => {
    const rows = allocationRows(open, []);
    expect(suggestAllocations('1000', rows)).toEqual([
      { invoiceId: '1', amount: '800' },
      { invoiceId: '2', amount: '200' },
    ]);
    // More than is owed: every invoice in full, the rest stays as an advance
    expect(suggestAllocations('5000', rows)).toEqual([
      { invoiceId: '1', amount: '800' },
      { invoiceId: '2', amount: '800' },
    ]);
    expect(suggestAllocations('12.', rows)).toEqual([]);
  });

  it('adds up only the boxes that hold an amount', () => {
    expect(appliedOf([{ amount: '800' }, { amount: '1.' }, { amount: '' }])).toBe('800.0000');
  });
});

describe('daysLate', () => {
  it('counts the days after the due date, and none on it', () => {
    expect(daysLate('2026-10-01', '2026-10-08')).toBe(7);
    expect(daysLate('2026-10-08', '2026-10-08')).toBe(0);
    expect(daysLate('2026-10-20', '2026-10-08')).toBe(0);
  });
});
```

- **The numbers are 15b's**: 2 cases of mango juice at ৳504 with 10% off. A challan of 12 pieces bills ৳21 a piece;
  an amount discount of ৳100 gives the challan ৳25.
- **The allocation tests** have one invoice partly paid (৳1,000 with ৳200 paid) and one unpaid, due later. ৳1,000
  pays the older one in full first. The second test adds the receipt's own amounts: an invoice it paid in full comes
  back in the list, first by its due date.

### `lib/sales.ts`: the tracking of a line's product

```diff
@@ -123,7 +123,8 @@ export function formTotals(
 // ---------------------------------------------------------------------------------------------
 // The line editor's data
 
-// What a line needs to know about its product, beside what the form sends
+// What a line needs to know about its product, beside what the form sends. The tracking (step 15c):
+// an invoice's own goods line picks its batch or serial numbers like a challan line.
 export type SalesItem = Pick<
   SalesLine,
   | 'variantId'
@@ -135,6 +136,8 @@ export type SalesItem = Pick<
   | 'baseUnitId'
   | 'units'
   | 'productType'
+  | 'tracking'
+  | 'hasExpiry'
 >;
 
 // What the editor keeps per line, beside the form value, at the same index
@@ -162,7 +165,8 @@ export const SALES_LINE_FIELDS = [
   'taxRateId',
 ] as const;
 
-function salesItemOf(line: SalesLine): SalesItem {
+// The item of a saved line (step 15c: also an order's service line on an invoice)
+export function salesItemOf(line: SalesLine): SalesItem {
   return {
     variantId: line.variantId,
     productId: line.productId,
@@ -173,6 +177,8 @@ function salesItemOf(line: SalesLine): SalesItem {
     baseUnitId: line.baseUnitId,
     units: line.units,
     productType: line.productType,
+    tracking: line.tracking,
+    hasExpiry: line.hasExpiry,
   };
 }
 
```

- **`SalesItem` gets `tracking` and `hasExpiry`.** An invoice's own goods line picks a batch or serial numbers, like
  a challan line, so the editor must know the product's tracking. Both fields are on every sales line already, so
  `Pick` still takes them from the contract.
- **`salesItemOf()` is exported** for an order's service line on an invoice (`orderCharges()`, below).

```diff
@@ -40,6 +40,7 @@ function orderLine(extra: Partial<SalesOrderLine> = {}): SalesOrderLine {
     vat: '151.2000',
     total: '1159.2000',
     deliveredQuantity: '0.0000',
+    invoicedQuantity: '0.0000',
     ...extra,
   };
 }
```

- **`invoicedQuantity`** is a new field on an order line (15c.1); the fixture needs it to type-check.

### `lib/invoice-sources.ts` (new): lines from a challan or an order

```ts
import {
  type Delivery,
  type InvoiceLineFormValues,
  type PriceLookupItem,
  routes,
  type SalesOrder,
} from '@omnivo/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { call } from './api';
import {
  challanLinesLeft,
  challanLineToInvoice,
  chargesLeft,
  itemOfDeliveryLine,
  type LineOrigin,
  orderChargeToInvoice,
} from './invoices';
import { salesOrderQuery } from './queries';
import { type LineMeta, salesItemOf } from './sales';

// The lines an invoice gets from a challan or an order (step 15c), with what the editor and the
// form keep beside each: its meta, and where it came from. Shared by the invoice form's pickers
// and by "Make invoice" on a challan, which starts the form with them.

export interface SourcedLine {
  line: InvoiceLineFormValues;
  meta: LineMeta;
  // The challan line's or order line's id, and what the form says about it
  origin: readonly [string, LineOrigin];
}

let lastKey = 0;
function sourceKey(): string {
  lastKey += 1;
  return `source-${String(lastKey)}`;
}

// The challan's lines not billed yet and not on the form (`onForm`). With an order, the order's
// prices (read through the query cache: a second challan of the same order asks nothing again);
// without one, the price lookup for this customer, like a new order line.
export async function challanLines(
  queryClient: QueryClient,
  tenantId: string,
  delivery: Delivery,
  onForm: ReadonlySet<string>,
): Promise<{ lines: SourcedLine[]; order: SalesOrder | null }> {
  const left = challanLinesLeft(delivery.lines, onForm);
  const order =
    delivery.order === null
      ? null
      : await queryClient.query(salesOrderQuery(tenantId, delivery.order.id));
  const orderLines = new Map(order?.lines.map((line) => [line.id, line]));
  const unpriced = left.filter(
    (line) => line.orderLineId === null || !orderLines.has(line.orderLineId),
  );
  const prices = new Map<string, PriceLookupItem>();
  if (unpriced.length > 0) {
    const answer = await call(routes.salesPrices.lookup, {
      body: {
        customerId: delivery.customer.id,
        items: unpriced.map((line) => ({ variantId: line.variantId, unitId: line.unitId })),
      },
    });
    for (const item of answer.items) prices.set(`${item.variantId}:${item.unitId}`, item);
  }
  return {
    order,
    lines: left.map((line) => {
      const orderLine = line.orderLineId === null ? undefined : orderLines.get(line.orderLineId);
      const price = orderLine ? undefined : prices.get(`${line.variantId}:${line.unitId}`);
      return {
        line: challanLineToInvoice(line, orderLine, price),
        meta: {
          key: sourceKey(),
          item: itemOfDeliveryLine(line),
          // The order's price says nothing new; a looked-up one says where it came from
          source: orderLine ? undefined : (price?.source ?? null),
          pricedFor: delivery.customer.id,
        },
        origin: [
          line.id,
          {
            deliveryNumber: delivery.number,
            orderNumber: order?.number ?? null,
            pricesIncludeVat: order?.pricesIncludeVat ?? null,
          },
        ],
      };
    }),
  };
}

// An order's service lines not billed yet and not on the form, at the order's prices
export function orderCharges(order: SalesOrder, onForm: ReadonlySet<string>): SourcedLine[] {
  return chargesLeft(order.lines, onForm).map((line) => ({
    line: orderChargeToInvoice(line),
    meta: {
      key: sourceKey(),
      item: salesItemOf(line),
      source: undefined,
      pricedFor: order.customer.id,
    },
    origin: [
      line.id,
      {
        deliveryNumber: null,
        orderNumber: order.number,
        pricesIncludeVat: order.pricesIncludeVat,
      },
    ],
  }));
}
```

- **Not in `lib/invoices.ts`**, because it calls the API. Not in the invoice lines editor either: "Make invoice" on
  a challan uses it in the route file, and importing the editor's file there would put the editor into the route's
  chunk.
- **`SourcedLine`** is everything a picked line needs at once: the form value, the editor's meta and the origin. The
  editor and the form each take their part.
- **`sourceKey()`** gives a React key, like `nextKey()` in the editor: a picked line has no id of its own yet.
- **The order is read through the query cache** (`queryClient.query`), so a second challan of the same order asks
  nothing again.
- **One price lookup for all lines without an order**, never one per line. The lookup takes up to 300 items, more
  than a challan has. The key `variantId:unitId` matches the editor's own `keyOf()`.
- **`source: undefined` for a line priced from its order.** The price comes from the agreed order, so there is
  nothing new to say under it. A looked-up price says where it came from ("From their price list"), like a new
  order line.

### `lib/queries.ts`: invoices, receipts, the credit line and the pickers

```diff
@@ -3,13 +3,20 @@ import {
   type BranchStatus,
   type CustomerSort,
   type CustomerStatus,
+  type DeliveryInvoiceFilter,
+  type InvoicePage,
+  type InvoicePaymentFilter,
+  type InvoiceStatus,
+  type InvoiceSummary,
   type JournalStatus,
+  MAX_RECEIPT_ALLOCATIONS,
   type MemberSort,
   type OrderStatus,
   type ProductSort,
   type ProductStatus,
   type ProfitAndLossQuery,
   type QuotationStatus,
+  type ReceiptStatus,
   routes,
   type StockDocumentStatus,
   type StockFilter,
@@ -626,6 +633,16 @@ export function customerQuery(tenantId: string, customerId: string) {
   });
 }
 
+// Step 15c: the credit line under the customer on the order and invoice forms. Under
+// ['customers', tenantId]: every sales save refreshes that prefix (useSalesRefresh), because
+// confirming an order, posting an invoice and saving a receipt all move it.
+export function customerCreditQuery(tenantId: string, customerId: string) {
+  return queryOptions({
+    queryKey: ['customers', tenantId, 'credit', customerId],
+    queryFn: () => call(routes.customers.credit, { params: { id: customerId } }),
+  });
+}
+
 // The statement reads posted journal lines, so it lives under ['journal', tenantId] like the
 // ledger: posting or reversing an entry refreshes it
 export function customerStatementQuery(
@@ -712,6 +729,11 @@ export interface SalesListFilter<TStatus extends string> {
   customerId: string;
 }
 
+// The delivery list's billing filter (step 15c, '' = all)
+export interface DeliveryListFilter extends SalesListFilter<StockDocumentStatus> {
+  invoice: DeliveryInvoiceFilter | '';
+}
+
 export function quotationsQuery(tenantId: string, filter: SalesListFilter<QuotationStatus>) {
   return infiniteQueryOptions({
     queryKey: ['sales', tenantId, 'quotations', filter],
@@ -778,7 +800,7 @@ export function salesOrderQuery(tenantId: string, orderId: string) {
   });
 }
 
-export function deliveriesQuery(tenantId: string, filter: SalesListFilter<StockDocumentStatus>) {
+export function deliveriesQuery(tenantId: string, filter: DeliveryListFilter) {
   return infiniteQueryOptions({
     queryKey: ['sales', tenantId, 'deliveries', filter],
     queryFn: ({ pageParam }: { pageParam: string | null }) =>
@@ -787,6 +809,7 @@ export function deliveriesQuery(tenantId: string, filter: SalesListFilter<StockD
           limit: 50,
           ...(filter.status !== '' && { status: filter.status }),
           ...(filter.customerId !== '' && { customerId: filter.customerId }),
+          ...(filter.invoice !== '' && { invoice: filter.invoice }),
           ...(pageParam !== null && { cursor: pageParam }),
         },
       }),
@@ -803,3 +826,118 @@ export function deliveryQuery(tenantId: string, deliveryId: string) {
     retry: false,
   });
 }
+
+// ---------------------------------------------------------------------------------------------
+// Invoices and money receipts (step 15c), under the same ['sales', tenantId] prefix: posting an
+// invoice changes its challans (billed), its orders (invoiced) and the lists at once.
+
+export interface InvoiceListFilter extends SalesListFilter<InvoiceStatus> {
+  payment: InvoicePaymentFilter | '';
+}
+
+export function invoicesQuery(tenantId: string, filter: InvoiceListFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['sales', tenantId, 'invoices', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.invoices.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.customerId !== '' && { customerId: filter.customerId }),
+          ...(filter.payment !== '' && { payment: filter.payment }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function invoiceQuery(tenantId: string, invoiceId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'invoice', invoiceId],
+    queryFn: () => call(routes.invoices.get, { params: { id: invoiceId } }),
+    retry: false,
+  });
+}
+
+// The receipt form's list: the customer's posted invoices not paid in full, the oldest due date
+// first (the API's order for this filter). A receipt applies to at most MAX_RECEIPT_ALLOCATIONS
+// invoices, so the pages are read up to that many, in one go: the table and "Apply oldest first"
+// need them all at once.
+export function openInvoicesQuery(tenantId: string, customerId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'invoices', 'open', customerId],
+    queryFn: async () => {
+      const items: InvoiceSummary[] = [];
+      let cursor: string | null = null;
+      do {
+        const page: InvoicePage = await call(routes.invoices.list, {
+          query: {
+            limit: 100,
+            payment: 'open',
+            customerId,
+            ...(cursor !== null && { cursor }),
+          },
+        });
+        items.push(...page.items);
+        cursor = page.nextCursor;
+      } while (cursor !== null && items.length < MAX_RECEIPT_ALLOCATIONS);
+      return items.slice(0, MAX_RECEIPT_ALLOCATIONS);
+    },
+  });
+}
+
+// The invoice form's "Add challans": the customer's posted challans with a line not billed yet
+export function challansToInvoiceQuery(tenantId: string, customerId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'deliveries', 'to-invoice', customerId],
+    queryFn: async () =>
+      (
+        await call(routes.deliveries.list, {
+          query: { limit: 100, invoice: 'to_invoice', customerId },
+        })
+      ).items,
+  });
+}
+
+// The invoice form's "Add order charges": the customer's orders a service line can be billed from
+// (confirmed, delivered or closed), newest first. The list has no filter for "has a service left",
+// so the dialog opens an order to see its lines.
+export function billableOrdersQuery(tenantId: string, customerId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'orders', 'billable', customerId],
+    queryFn: async () =>
+      (await call(routes.salesOrders.list, { query: { limit: 100, customerId } })).items.filter(
+        (order) =>
+          order.status === 'confirmed' || order.status === 'delivered' || order.status === 'closed',
+      ),
+  });
+}
+
+export function receiptsQuery(tenantId: string, filter: SalesListFilter<ReceiptStatus>) {
+  return infiniteQueryOptions({
+    queryKey: ['sales', tenantId, 'receipts', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.receipts.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.customerId !== '' && { customerId: filter.customerId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function receiptQuery(tenantId: string, receiptId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'receipt', receiptId],
+    queryFn: () => call(routes.receipts.get, { params: { id: receiptId } }),
+    retry: false,
+  });
+}
```

- **`customerCreditQuery()` is under `['customers', tenantId]`**, not `['sales', …]`. The credit is about a customer,
  and the customer page already refreshes that prefix. `useSalesRefresh()` now refreshes it too (below), because
  confirming an order, posting an invoice and saving a receipt all move the credit.
- **The invoice and receipt queries are under `['sales', tenantId]`.** Posting an invoice changes its challans
  (billed), its orders (invoiced) and the lists, and one invalidate refreshes all of them, as in 15b.
- **`InvoiceListFilter` and `DeliveryListFilter` extend `SalesListFilter`.** The invoice list has a payment filter
  and the challan list a billing filter, and both keep 15b's status and customer.
- **`openInvoicesQuery()` reads the pages until it has them all**, up to `MAX_RECEIPT_ALLOCATIONS` (200). The table and
  "Apply oldest first" need every open invoice at once; one page of 100 would hide the newest ones from a
  distributor's big collection. The `page` variable has its type written out: TypeScript cannot work out the type
  of a variable used in its own loop condition.
- **`challansToInvoiceQuery()`** asks for `invoice: 'to_invoice'`: posted challans of the customer with a line not
  billed yet (15c.1). 100 at most, in one request, for the picker.
- **`billableOrdersQuery()` filters on the page.** The order list has one status filter, and a service can be billed
  from a confirmed, a delivered or a closed order. One request for the customer's newest 100 orders, then the three
  statuses, is simpler than three requests.

### `components/sales-parts.tsx`: refresh the customers, the notice, the new pills

```diff
@@ -4,9 +4,14 @@ import {
   CancelCircleIcon,
   CheckmarkCircle02Icon,
   Clock01Icon,
+  Coins01Icon,
   DeliveryTruck01Icon,
   FileEditIcon,
   HourglassIcon,
+  InformationCircleIcon,
+  Invoice01Icon,
+  Invoice02Icon,
+  Invoice03Icon,
   PackageDeliveredIcon,
   StopCircleIcon,
   Time04Icon,
@@ -14,29 +19,36 @@ import {
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   type CustomerAddress,
+  type DeliveryInvoiceState,
   type DocumentTotals,
+  type InvoiceStatus,
+  isOverdue,
   isZeroMoney,
   type OrderStatus,
   type PartyRef,
+  paymentStatusOf,
   type QuotationStatus,
+  type ReceiptStatus,
   type StockDocumentStatus,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { Pill } from '@omnivo/ui';
 import { useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
-import { useCallback } from 'react';
+import { type ReactNode, useCallback } from 'react';
 
 import { partyLabel } from '../lib/customers';
 import { isExpired, isLate } from '../lib/sales';
 import { useTenantId } from './stock-parts';
 
-// Shared by the quotation, order and delivery pages. Here, not in a route file: a route file is its
+// Shared by the quotation, order, delivery, invoice and money receipt pages. Here, not in a route file: a route file is its
 // own lazy chunk, and importing from one would pull that whole page into the others.
 
 // After a save. Everything under ['sales', tenant] (the lists, the documents), and the stock and
 // the books: confirming an order changes "on order" on the stock page, and posting a delivery
-// takes stock out and writes a journal entry. One hook for the three documents, so none forgets one.
+// takes stock out and writes a journal entry. Step 15c: the customers too, because an invoice and
+// a receipt change what a customer owes, and an order its credit. One hook for every sales
+// document, so none forgets one.
 export function useSalesRefresh(): () => Promise<void> {
   const tenantId = useTenantId();
   const queryClient = useQueryClient();
@@ -45,6 +57,7 @@ export function useSalesRefresh(): () => Promise<void> {
       queryClient.invalidateQueries({ queryKey: ['sales', tenantId] }),
       queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
       queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
+      queryClient.invalidateQueries({ queryKey: ['customers', tenantId] }),
     ]);
   }, [queryClient, tenantId]);
 }
@@ -53,7 +66,7 @@ export function SalesBackLink({
   to,
   label,
 }: {
-  to: '/quotations' | '/sales-orders' | '/deliveries';
+  to: '/quotations' | '/sales-orders' | '/deliveries' | '/invoices' | '/receipts';
   label: string;
 }) {
   return (
@@ -87,6 +100,36 @@ export function addressLabel(address: CustomerAddress): string {
   return address.label === null ? firstLine : `${address.label} — ${firstLine}`;
 }
 
+// A notice above a document: what its state means and what to do next. Icon plus words, never
+// colour alone; warn for an offer that has ended (step 15c: or an invoice past its due date),
+// neutral otherwise. Here since 15c, not in quotation-view.tsx: the invoice and receipt pages use it
+// too, and importing it from there would pull the quotation page into their chunks.
+export function DocumentNotice({
+  tone,
+  children,
+}: {
+  tone: 'warn' | 'neutral';
+  children: ReactNode;
+}) {
+  return (
+    <p
+      className={
+        tone === 'warn'
+          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
+          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
+      }
+    >
+      <HugeiconsIcon
+        icon={tone === 'warn' ? HourglassIcon : InformationCircleIcon}
+        size={17}
+        strokeWidth={1.5}
+        className="mt-px shrink-0"
+      />
+      <span>{children}</span>
+    </p>
+  );
+}
+
 // Open, Expired (open, but the offer has ended: attention), Accepted, Declined. Never colour alone.
 export function QuotationStatusPill({
   quotation,
@@ -210,3 +253,73 @@ export function SalesTotals({
     </div>
   );
 }
+
+// Step 15c: how much of a posted challan is billed. A draft shows nothing: it cannot be billed yet.
+const INVOICE_STATE_PILLS = {
+  not_invoiced: { tone: 'neutral', icon: Invoice01Icon },
+  partly_invoiced: { tone: 'brand', icon: Invoice03Icon },
+  invoiced: { tone: 'good', icon: Invoice02Icon },
+} as const;
+
+export function InvoiceStatePill({ state }: { state: DeliveryInvoiceState }) {
+  const { t } = useLocale();
+  const pill = INVOICE_STATE_PILLS[state];
+  return (
+    <Pill tone={pill.tone} icon={pill.icon}>
+      {t(`deliveries.invoiceStates.${state}`)}
+    </Pill>
+  );
+}
+
+const PAYMENT_PILLS = {
+  unpaid: { tone: 'brand', icon: Clock01Icon },
+  partly_paid: { tone: 'brand', icon: Coins01Icon },
+  paid: { tone: 'good', icon: CheckmarkCircle02Icon },
+} as const;
+
+// A draft says Draft. A posted invoice says what was paid (unpaid and partly paid are brand: money
+// on its way, not a problem), and beside it Overdue (crit, CLAUDE.md: overdue) once its due date
+// has passed. Worked out here from the totals and today: nothing is stored when the date passes.
+export function InvoicePills({
+  invoice,
+  today,
+}: {
+  invoice: { status: InvoiceStatus; dueDate: string; total: string; amountPaid: string };
+  today: string;
+}) {
+  const { t } = useLocale();
+  if (invoice.status === 'draft') {
+    return (
+      <Pill tone="neutral" icon={FileEditIcon}>
+        {t('invoices.statuses.draft')}
+      </Pill>
+    );
+  }
+  const payment = paymentStatusOf(invoice);
+  const pill = PAYMENT_PILLS[payment];
+  return (
+    <span className="inline-flex flex-wrap gap-1.5">
+      <Pill tone={pill.tone} icon={pill.icon}>
+        {t(`invoices.payment.${payment}`)}
+      </Pill>
+      {isOverdue(invoice, today) && (
+        <Pill tone="crit" icon={Time04Icon}>
+          {t('invoices.overdue')}
+        </Pill>
+      )}
+    </span>
+  );
+}
+
+export function ReceiptStatusPill({ status }: { status: ReceiptStatus }) {
+  const { t } = useLocale();
+  return status === 'voided' ? (
+    <Pill tone="neutral" icon={CancelCircleIcon}>
+      {t('receipts.statuses.voided')}
+    </Pill>
+  ) : (
+    <Pill tone="good" icon={CheckmarkCircle02Icon}>
+      {t('receipts.statuses.posted')}
+    </Pill>
+  );
+}
```

- **`useSalesRefresh()` also refreshes `['customers', tenantId]`.** An invoice and a receipt change what a customer
  owes, and an order its credit. Without it, the customer page and the credit line would show the old numbers until
  a reload.
- **`DocumentNotice` moved here from `quotation-view.tsx`.** The invoice and receipt pages use it too. Importing it
  from the quotation view would pull the whole quotation page into their chunks (each component file the route
  loads lazily is its own chunk).
- **`InvoiceStatePill`.** "Not invoiced" is neutral, "Partly invoiced" brand (work in progress), "Invoiced" good. Not
  `warn`: a challan waiting for its bill is the normal flow, not something wrong. Each has its own invoice icon, so
  "Invoiced" next to "Posted" does not show the same tick twice.
- **`InvoicePills`.** A draft says Draft. A posted invoice says what is paid (worked out by `paymentStatusOf()`),
  and next to it "Overdue" once the due date has passed. Overdue is `crit`, because CLAUDE.md lists overdue under
  `crit`; unpaid and partly paid are `brand`, because money on its way is work in progress, not a problem.
- **`PAYMENT_PILLS` and `INVOICE_STATE_PILLS` are `as const` maps indexed by the contract's unions**, like 15b's
  `ORDER_PILLS`: a new status in the contract is a type error here until it has its pill.

```diff
@@ -1,55 +1,28 @@
-import {
-  Delete02Icon,
-  HourglassIcon,
-  InformationCircleIcon,
-  PencilEdit02Icon,
-  ShoppingCart01Icon,
-} from '@hugeicons/core-free-icons';
+import { Delete02Icon, PencilEdit02Icon, ShoppingCart01Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { type Quotation, routes } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { Button, Card, FormAlert, PageHeader, toast } from '@omnivo/ui';
 import { useMutation } from '@tanstack/react-query';
 import { Link, useNavigate } from '@tanstack/react-router';
-import { type ReactNode, useState } from 'react';
+import { useState } from 'react';
 
 import { call } from '../lib/api';
 import { useCan } from '../lib/permissions';
 import { isExpired } from '../lib/sales';
 import { Fact } from './adjustment-view';
 import { failureOf } from './journal-parts';
+import { PrintButton, QuotationPrint } from './print-documents';
 import { SalesLinesTable } from './sales-lines-table';
-import { CustomerLink, QuotationStatusPill, SalesBackLink, useSalesRefresh } from './sales-parts';
+import {
+  CustomerLink,
+  DocumentNotice,
+  QuotationStatusPill,
+  SalesBackLink,
+  useSalesRefresh,
+} from './sales-parts';
 import { useIsoDate } from './stock-parts';
 
-// A notice above a document: what its state means and what to do next. Icon plus words, never
-// colour alone; warn for an offer that has ended, neutral otherwise.
-export function DocumentNotice({
-  tone,
-  children,
-}: {
-  tone: 'warn' | 'neutral';
-  children: ReactNode;
-}) {
-  return (
-    <p
-      className={
-        tone === 'warn'
-          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
-          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
-      }
-    >
-      <HugeiconsIcon
-        icon={tone === 'warn' ? HourglassIcon : InformationCircleIcon}
-        size={17}
-        strokeWidth={1.5}
-        className="mt-px shrink-0"
-      />
-      <span>{children}</span>
-    </p>
-  );
-}
-
 // A quotation as the customer got it, with what can be done with it next: make the order, change
 // it, mark it declined or delete it while it is open; open it again once declined.
 export function QuotationView({
@@ -106,7 +79,12 @@ export function QuotationView({
       <PageHeader
         title={quotation.number}
         description={quotation.customer.name}
-        actions={<QuotationStatusPill quotation={quotation} today={today} />}
+        actions={
+          <>
+            <QuotationStatusPill quotation={quotation} today={today} />
+            <PrintButton />
+          </>
+        }
       />
       {failure && <FormAlert message={failure} />}
       {isExpired(quotation, today) && quotation.validUntil !== null && (
@@ -224,6 +202,7 @@ export function QuotationView({
           </Button>
         </div>
       )}
+      <QuotationPrint quotation={quotation} />
     </div>
   );
 }
```

- **`DocumentNotice` comes from `sales-parts.tsx` now** (above), and the quotation gets its Print button and its
  print sheet (below). A quotation always has a number, so it can always be printed.

### `components/credit-parts.tsx` (new): the credit limit on the forms

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { absMoney, isNegativeMoney, isZeroMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, Dialog, DialogClose, DialogContent } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { ApiRequestError } from '../lib/api';
import { useCan } from '../lib/permissions';
import { customerCreditQuery } from '../lib/queries';
import { useTenantId } from './stock-parts';

// The credit limit on the order and invoice forms (step 15c): the line under the customer, and the
// dialog that asks before a document goes over the limit.

// "Credit left: ৳35,000 of ৳2,00,000 · ৳40,000 on confirmed orders", under the customer box. The
// same numbers the API checks with (GET /customers/:id/credit). Only for someone who may see what
// a customer owes (sales.customer.balance), like the customer's balance itself.
export function CreditLine({ customerId }: { customerId: string }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const canSee = useCan()('sales.customer.balance');
  const { data: credit } = useQuery({
    ...customerCreditQuery(tenantId, customerId),
    enabled: canSee && customerId !== '',
  });
  if (!canSee || customerId === '' || !credit) return null;
  const money = (value: string) => format.money(value);
  const over = credit.available !== null && isNegativeMoney(credit.available);
  const main =
    credit.limit === null
      ? t('customers.credit.noLimit')
      : isZeroMoney(credit.limit)
        ? t('customers.credit.cashOnly')
        : over
          ? t('customers.credit.over', { amount: money(absMoney(credit.available ?? '0')) })
          : t('customers.credit.left', {
              amount: money(credit.available ?? '0'),
              limit: money(credit.limit),
            });
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-label',
        over ? 'font-medium text-crit' : 'text-ink-3',
      )}
    >
      {/* Over the limit is the one state that needs attention: an icon, not colour alone */}
      {over && (
        <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      )}
      <span className="tabular-nums">
        {main}
        {!isZeroMoney(credit.onOrder) &&
          ` · ${t('customers.credit.onOrder', { amount: money(credit.onOrder) })}`}
      </span>
    </p>
  );
}

// What the API said when a document would go over the limit (409 credit_limit_exceeded): the
// limit and what the customer would owe with this document
export interface CreditStop {
  limit: string;
  exposure: string;
}

export function creditStopOf(error: unknown): CreditStop | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'credit_limit_exceeded') return null;
  const limit = error.problem.params?.limit;
  const exposure = error.problem.params?.exposure;
  return typeof limit === 'string' && typeof exposure === 'string' ? { limit, exposure } : null;
}

// The two credit errors as text, with their amounts as money ("৳2,35,000.00", not
// "235000.0000"). The form puts the text where it puts any other error. null for any other error.
export function useCreditText(): (error: unknown) => string | null {
  const { errorText, format } = useLocale();
  return useCallback(
    (error: unknown) => {
      const stop = creditStopOf(error);
      if (stop !== null) {
        return errorText('credit_limit_exceeded', {
          limit: format.money(stop.limit, { decimals: 2 }),
          exposure: format.money(stop.exposure, { decimals: 2 }),
        });
      }
      if (error instanceof ApiRequestError && error.code === 'credit_override_forbidden') {
        return errorText(error.code, error.problem.params);
      }
      return null;
    },
    [errorText, format],
  );
}

// Asked when the person may go over the limit (sales.credit.override). "Confirm anyway" sends the
// same request again with overrideCreditLimit: true; the API checks the limit again and writes the
// override in the audit log. Paisa: the two amounts may differ by less than a taka.
export function CreditLimitDialog({
  stop,
  customer,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  stop: CreditStop | null;
  customer: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t, format } = useLocale();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <Dialog
      open={stop !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {stop !== null && (
        <DialogContent
          title={t('creditLimit.title')}
          description={t('creditLimit.counts')}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">{t('creditLimit.back')}</Button>
              </DialogClose>
              <Button disabled={pending} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </>
          }
        >
          <div className="grid gap-3 text-body-sm">
            <p className="text-ink tabular-nums">
              {t('creditLimit.body', {
                customer,
                exposure: money(stop.exposure),
                limit: money(stop.limit),
              })}
            </p>
            <p className="text-ink-2">{t('creditLimit.audit')}</p>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
```

- **`CreditLine` is only for someone with `sales.customer.balance`**, the permission that shows a customer's balance
  (15a). The query does not even run without it: the API would refuse it.
- **Five ways to read the numbers**: no limit, cash only (a limit of ৳0), over the limit (`available` negative), or
  what is left of the limit; and what confirmed orders will still bill, when there is any. Over the limit is the one
  state that needs attention, so it is `crit`, with an icon (CLAUDE.md: never colour alone).
- **Whole taka on the line**, because it is a hint, like a list. The dialog shows paisa: the two amounts it compares
  can differ by less than a taka, and "৳2,00,000 over ৳2,00,000" would make no sense.
- **`creditStopOf()`** reads the limit and the amount from the error's `params` (15c.3). It checks that both are
  strings, so a newer server's different shape shows the plain error instead of a broken dialog.
- **`useCreditText()` formats the amounts before the text is made.** `FormAlert` shows an error code in the current
  language, but it cannot fill in `{{exposure}}`. So the form makes the finished sentence with the amounts as money
  and puts that text where it puts any other error. `credit_override_forbidden` gets its `{{permissions}}` the same
  way.
- **`CreditLimitDialog`** says what the customer would owe, the limit, what counts, and that the audit log records
  the override. "Go back" is the dialog's no; the yes says what happens on its page ("Confirm anyway", "Post
  anyway").

### `components/sales-order-form.tsx`: the credit line and the credit dialog

```diff
@@ -1,4 +1,4 @@
-import { Delete02Icon } from '@hugeicons/core-free-icons';
+import { Calendar03Icon, Delete02Icon, UserIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
@@ -15,8 +15,8 @@ import {
   Button,
   Card,
   FormAlert,
-  DatePicker,
   FormField,
+  Input,
   PageHeader,
   SelectField,
   TextField,
@@ -31,8 +31,15 @@ import { call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { rowPath } from '../lib/products';
 import { SALES_LINE_FIELDS, savedLines } from '../lib/sales';
+import { useCan } from '../lib/permissions';
 import { customerQuery } from '../lib/queries';
-import { CustomerPicker } from './customer-picker';
+import {
+  CreditLimitDialog,
+  CreditLine,
+  type CreditStop,
+  creditStopOf,
+  useCreditText,
+} from './credit-parts';
 import { failureOf } from './journal-parts';
 import { addressLabel, SalesBackLink, useSalesRefresh } from './sales-parts';
 import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';
@@ -45,6 +52,12 @@ import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';
 const SalesLinesEditor = lazy(async () => ({
   default: (await import('./sales-line-editor')).SalesLinesEditor,
 }));
+// The customer box and the date picker too (step 15c): both bring the popover, and with the 15c
+// contracts and the credit line this chunk went over its budget (the delivery form did the same)
+const CustomerPicker = lazy(async () => ({
+  default: (await import('./customer-picker')).CustomerPicker,
+}));
+const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
 
 type FormValues = SalesOrderFormValues;
 
@@ -92,6 +105,11 @@ export function SalesOrderForm({
   const refresh = useSalesRefresh();
   const { active } = useWarehouses();
   const [confirming, setConfirming] = useState(false);
+  // Step 15c: the limit and the amount when confirming would go over the customer's credit limit,
+  // for someone who may go over it (the dialog asks); null otherwise
+  const [stop, setStop] = useState<CreditStop | null>(null);
+  const canOverride = useCan()('sales.credit.override');
+  const creditText = useCreditText();
   const [start] = useState(() => {
     if (order) return savedLines(order.lines, order.customer.id);
     if (quotation) return savedLines(quotation.lines, quotation.customer.id);
@@ -156,10 +174,11 @@ export function SalesOrderForm({
     setValue('shippingAddressId', shippingAddresses(picked.addresses)[0]?.id ?? '');
   };
 
-  const save = (confirm: boolean) =>
+  // override: the second try, after the person saw the credit dialog and went on
+  const save = (confirm: boolean, override = false) =>
     handleSubmit(async ({ version, ...values }) => {
       try {
-        const body = { ...values, confirm };
+        const body = { ...values, confirm, overrideCreditLimit: override };
         const saved = order
           ? await call(routes.salesOrders.update, {
               params: { id: order.id },
@@ -174,6 +193,7 @@ export function SalesOrderForm({
             ? t('salesOrders.confirmed', { number: saved.number ?? '' })
             : t('salesOrders.draftSaved'),
         );
+        setStop(null);
         if (!order) {
           void navigate({
             to: '/sales-orders/$orderId',
@@ -182,7 +202,16 @@ export function SalesOrderForm({
           });
         }
       } catch (error) {
-        applyApiError(error, fieldNames(lineCount), setError);
+        // Over the credit limit: ask, if the person may go over it; else say so, with the amounts
+        const credit = creditStopOf(error);
+        if (credit !== null && canOverride && !override) {
+          setStop(credit);
+          return;
+        }
+        setStop(null);
+        const text = creditText(error);
+        if (text !== null) setError('root.server', { message: text });
+        else applyApiError(error, fieldNames(lineCount), setError);
       }
     });
 
@@ -224,24 +253,33 @@ export function SalesOrderForm({
           </p>
         )}
         <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
-          <FormField
-            control={control}
-            name="customerId"
-            label={t('salesOrders.customer')}
-            hint={customerLocked ? t('salesOrders.customerLocked') : undefined}
-          >
+          <div className="grid content-start gap-1.5">
+            <FormField
+              control={control}
+              name="customerId"
+              label={t('salesOrders.customer')}
+              hint={customerLocked ? t('salesOrders.customerLocked') : undefined}
+            >
+              {(field) => (
+                <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
+                  <CustomerPicker
+                    {...field}
+                    saved={savedCustomer}
+                    disabled={customerLocked}
+                    onChange={(next) => void changeCustomer(next)}
+                  />
+                </Suspense>
+              )}
+            </FormField>
+            <CreditLine customerId={customerId} />
+          </div>
+          <FormField control={control} name="date" label={t('salesOrders.date')}>
             {(field) => (
-              <CustomerPicker
-                {...field}
-                saved={savedCustomer}
-                disabled={customerLocked}
-                onChange={(next) => void changeCustomer(next)}
-              />
+              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
+                <DatePicker {...field} />
+              </Suspense>
             )}
           </FormField>
-          <FormField control={control} name="date" label={t('salesOrders.date')}>
-            {(field) => <DatePicker {...field} />}
-          </FormField>
           <FormField
             control={control}
             name="deliveryDate"
@@ -249,7 +287,11 @@ export function SalesOrderForm({
             optional
             hint={t('salesOrders.deliveryDateHint')}
           >
-            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
+            {(field) => (
+              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
+                <DatePicker {...field} value={field.value ?? ''} />
+              </Suspense>
+            )}
           </FormField>
           <TextField
             label={t('salesOrders.customerReference')}
@@ -338,6 +380,16 @@ export function SalesOrderForm({
         </div>
         <p className="text-right text-label text-ink-3">{t('salesOrders.confirmHint')}</p>
       </form>
+      <CreditLimitDialog
+        stop={stop}
+        customer={customer?.name ?? savedCustomer?.name ?? ''}
+        confirmLabel={t('creditLimit.confirmOrder')}
+        pending={isSubmitting}
+        onConfirm={() => void save(true, true)()}
+        onClose={() => {
+          setStop(null);
+        }}
+      />
     </div>
   );
 }
```

- **The credit line under the customer box**, in a small grid with it, so it sits right under the box and not in a
  grid cell of its own.
- **`save(confirm, override)`.** The first try never sends `overrideCreditLimit: true`. When the API answers
  `credit_limit_exceeded` and the person may go over the limit, the form opens the dialog; "Confirm anyway" sends
  the same form again with `true`, and the API checks the limit again under its lock (15c.3). The person never sends
  an override they did not see.
- **`!override` in the check.** If the second try is refused again (the customer's balance changed in between), the
  dialog does not open a second time: the text shows instead, with the new amounts.
- **Without `sales.credit.override`** the person sees the error as text, with the amounts. The dialog would offer a
  button the API refuses.
- **The customer box and the date picker are lazy now**, as on the delivery form. The credit parts and the 15c
  contracts took this chunk to 100.3 KB; without the popover it is 85.9 KB.

### `components/sales-line-editor.tsx`: one editor for three documents

```diff
@@ -11,6 +11,7 @@ import { HugeiconsIcon } from '@hugeicons/react';
 import {
   defaultLineDescription,
   MAX_SALES_LINES,
+  plainQuantity,
   type PriceLookupItem,
   type Product,
   type ProductSummary,
@@ -45,12 +46,14 @@ import { productQuery, productSearchQuery, taxRatesQuery, unitsQuery } from '../
 import { useDebounced } from '../lib/use-debounced';
 import { failureOf, LineError } from './journal-parts';
 import { SalesTotals } from './sales-parts';
-import { useQuantity, useTenantId, VariantCell } from './stock-parts';
+import { useQuantity, useTenantId, useUnitCode, VariantCell } from './stock-parts';
 
-// The lines of a quotation or an order: one editor for both. The form holds the lines as one
-// controlled value (a Controller on "lines"), and this editor changes that array. A field array
-// would need the form's own type here, and the two forms have different types; one array value has
-// the same type in both (SalesLineFormValues[]), so neither form needs a cast.
+// The lines of a quotation, an order and (step 15c) an invoice: one editor for all three. The form
+// holds the lines as one controlled value (a Controller on "lines"), and this editor changes that
+// array. A field array would need the form's own type here, and the forms have different types;
+// one array value has the same type in the quotation and the order (SalesLineFormValues[]), so
+// neither form needs a cast. An invoice line has more fields, so the editor is generic over the
+// line (LinesEditor<L>), and SalesLinesEditor is its plain sales-line form.
 
 export type SalesLinesErrors = FieldErrors<{ lines: SalesLineFormValues[] }>['lines'];
 
@@ -68,8 +71,9 @@ const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;
 const COLUMNS =
   '@5xl:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_8.5rem_8.5rem_8.5rem_7.5rem_2.25rem] @5xl:items-start @5xl:gap-2';
 
-// LineField's look, with the label hidden at @5xl (LineField hides it at @3xl)
-function SalesField({
+// LineField's look, with the label hidden at @5xl (LineField hides it at @3xl). Exported for the
+// invoice's own boxes under a line (invoice-lines.tsx).
+export function SalesField({
   id,
   label,
   error,
@@ -93,28 +97,79 @@ function SalesField({
   );
 }
 
-export function SalesLinesEditor({
-  lines,
-  onChange,
-  getLines,
-  initialMeta,
-  customerId,
-  pricesIncludeVat,
-  errors,
+// A unit or a quantity a line cannot change (a challan line on an invoice): the same cell, as text
+function FixedValue({
+  label,
+  value,
+  className,
 }: {
-  lines: SalesLineFormValues[];
-  onChange: (lines: SalesLineFormValues[]) => void;
+  label: string;
+  value: string;
+  className?: string;
+}) {
+  return (
+    <div className="grid content-start gap-1.5">
+      <span className="text-label font-medium text-ink @5xl:sr-only">{label}</span>
+      <span className={cn('py-2.5 text-body-sm text-ink-2 tabular-nums', className)}>{value}</span>
+    </div>
+  );
+}
+
+export interface LinesEditorProps<L extends SalesLineFormValues> {
+  lines: L[];
+  onChange: (lines: L[]) => void;
   // The form's lines right now (react-hook-form's getValues): an add that waited for the price
   // lookup appends to these, not to the lines of the render that started it
-  getLines: () => SalesLineFormValues[];
+  getLines: () => L[];
   initialMeta: LineMeta[];
   customerId: string;
   pricesIncludeVat: boolean;
   errors: SalesLinesErrors;
-}) {
+  // The form's own line for a product added with "Add items" (an invoice line has more fields)
+  newLine: (line: SalesLineFormValues) => L;
+  // The most lines the document takes
+  maxLines?: number;
+  // A line whose item, unit and quantity come from elsewhere (a challan line on an invoice, billed
+  // whole): they are shown, not changed. Its price, discount and VAT rate still are.
+  fixed?: (line: L) => boolean;
+  // Under the item: where the line comes from, or the batch of an invoice's own goods line.
+  // `update` changes this line's own fields.
+  lineNote?: (line: {
+    value: L;
+    index: number;
+    item: SalesItem;
+    update: (patch: Partial<L>) => void;
+  }) => ReactNode;
+  // More buttons beside "Add items" (an invoice's "Add challans"). They add lines with their meta
+  // through `add`, which adds nothing and says false when the document would hold too many.
+  moreAdds?: (add: (entries: readonly { line: L; meta: LineMeta }[]) => boolean) => ReactNode;
+}
+
+const sameLine = (line: SalesLineFormValues): SalesLineFormValues => line;
+
+// The quotation's and the order's editor: a product added is a plain sales line
+export function SalesLinesEditor(props: Omit<LinesEditorProps<SalesLineFormValues>, 'newLine'>) {
+  return <LinesEditor {...props} newLine={sameLine} />;
+}
+
+export function LinesEditor<L extends SalesLineFormValues>({
+  lines,
+  onChange,
+  getLines,
+  initialMeta,
+  customerId,
+  pricesIncludeVat,
+  errors,
+  newLine,
+  maxLines = MAX_SALES_LINES,
+  fixed = () => false,
+  lineNote,
+  moreAdds,
+}: LinesEditorProps<L>) {
   const { t, format, errorText } = useLocale();
   const tenantId = useTenantId();
   const quantityText = useQuantity();
+  const unitCode = useUnitCode();
   const rateText = useRateText();
   const units = useQuery(unitsQuery(tenantId)).data ?? [];
   const rates = useQuery(taxRatesQuery(tenantId)).data;
@@ -150,11 +205,19 @@ export function SalesLinesEditor({
     );
   };
 
+  // Lines made elsewhere (an invoice's challan picker), with their meta. false = too many.
+  const add = (entries: readonly { line: L; meta: LineMeta }[]): boolean => {
+    if (getLines().length + entries.length > maxLines) return false;
+    onChange([...getLines(), ...entries.map((entry) => entry.line)]);
+    setMeta((before) => [...before, ...entries.map((entry) => entry.meta)]);
+    return true;
+  };
+
   // "Add": every active variant of the product, in its selling unit, at the looked-up price.
   // false = the document would hold too many lines; nothing is added.
   const addProduct = async (product: Product): Promise<boolean> => {
     const variants = product.variants.filter((variant) => variant.archivedAt === null);
-    if (getLines().length + variants.length > MAX_SALES_LINES) return false;
+    if (getLines().length + variants.length > maxLines) return false;
     const unitId = product.salesUnitId ?? product.baseUnitId;
     const prices = await lookUp(variants.map((variant) => ({ variantId: variant.id, unitId })));
     const added = variants.map((variant) => {
@@ -180,15 +243,16 @@ export function SalesLinesEditor({
         baseUnitId: product.baseUnitId,
         units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
         productType: product.type,
+        tracking: product.tracking,
+        hasExpiry: product.hasExpiry,
       };
       return {
-        line,
+        line: newLine(line),
         meta: { key: nextKey(), item, source: found?.source ?? null, pricedFor: customerId },
       };
     });
-    onChange([...getLines(), ...added.map((entry) => entry.line)]);
-    setMeta((before) => [...before, ...added.map((entry) => entry.meta)]);
-    return true;
+    // Checked above, before the wait; another add may have come in meanwhile
+    return add(added);
   };
 
   const remove = (index: number) => {
@@ -196,9 +260,13 @@ export function SalesLinesEditor({
     setMeta((before) => before.filter((_, at) => at !== index));
   };
 
+  // The sales fields every line has, and (lineNote) the fields of the form's own line type
   const update = (index: number, patch: Partial<SalesLineFormValues>) => {
     onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
   };
+  const updateOwn = (index: number, patch: Partial<L>) => {
+    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
+  };
 
   // A price is per unit: a carton has its own price on a price list. A new unit asks for its
   // price; a unit with no price anywhere keeps what was typed.
@@ -302,6 +370,7 @@ export function SalesLinesEditor({
         const id = (field: string) => `lines.${String(index)}.${field}`;
         const preview = basePreview(item, line.unitId, line.quantity, units);
         const amount = amounts[index];
+        const locked = fixed(line);
         const removeButton = (
           <IconButton
             icon={Delete02Icon}
@@ -332,6 +401,14 @@ export function SalesLinesEditor({
                 </span>
                 <span className="@5xl:hidden">{removeButton}</span>
               </div>
+              {lineNote?.({
+                value: line,
+                index,
+                item,
+                update: (patch) => {
+                  updateOwn(index, patch);
+                },
+              })}
               <SalesField
                 id={id('description')}
                 label={t('salesLines.description')}
@@ -349,42 +426,55 @@ export function SalesLinesEditor({
                 />
               </SalesField>
             </div>
-            <SalesField
-              id={id('unitId')}
-              label={t('salesLines.unit')}
-              error={lineErrors?.unitId?.message}
-            >
-              <Select
-                id={id('unitId')}
-                options={unitChoices(item, units)}
-                value={line.unitId}
-                invalid={lineErrors?.unitId !== undefined}
-                onChange={(event) => void changeUnit(index, event.target.value)}
-              />
-            </SalesField>
-            <SalesField
-              id={id('quantity')}
-              label={t('salesLines.quantity')}
-              error={lineErrors?.quantity?.message}
-            >
-              <Input
-                id={id('quantity')}
-                inputMode="decimal"
-                autoComplete="off"
-                align="end"
-                value={line.quantity}
-                invalid={lineErrors?.quantity !== undefined}
-                aria-describedby={lineErrors?.quantity ? `${id('quantity')}-error` : undefined}
-                onChange={(event) => {
-                  update(index, { quantity: event.target.value });
-                }}
-              />
-              {preview !== null && (
-                <span className="text-right text-caption text-ink-3 tabular-nums">
-                  {t('stockLines.equals', { quantity: quantityText(preview, item.baseUnitId) })}
-                </span>
-              )}
-            </SalesField>
+            {locked ? (
+              <>
+                <FixedValue label={t('salesLines.unit')} value={unitCode(line.unitId)} />
+                <FixedValue
+                  label={t('salesLines.quantity')}
+                  value={plainQuantity(line.quantity)}
+                  className="text-right"
+                />
+              </>
+            ) : (
+              <>
+                <SalesField
+                  id={id('unitId')}
+                  label={t('salesLines.unit')}
+                  error={lineErrors?.unitId?.message}
+                >
+                  <Select
+                    id={id('unitId')}
+                    options={unitChoices(item, units)}
+                    value={line.unitId}
+                    invalid={lineErrors?.unitId !== undefined}
+                    onChange={(event) => void changeUnit(index, event.target.value)}
+                  />
+                </SalesField>
+                <SalesField
+                  id={id('quantity')}
+                  label={t('salesLines.quantity')}
+                  error={lineErrors?.quantity?.message}
+                >
+                  <Input
+                    id={id('quantity')}
+                    inputMode="decimal"
+                    autoComplete="off"
+                    align="end"
+                    value={line.quantity}
+                    invalid={lineErrors?.quantity !== undefined}
+                    aria-describedby={lineErrors?.quantity ? `${id('quantity')}-error` : undefined}
+                    onChange={(event) => {
+                      update(index, { quantity: event.target.value });
+                    }}
+                  />
+                  {preview !== null && (
+                    <span className="text-right text-caption text-ink-3 tabular-nums">
+                      {t('stockLines.equals', { quantity: quantityText(preview, item.baseUnitId) })}
+                    </span>
+                  )}
+                </SalesField>
+              </>
+            )}
             <SalesField
               id={id('unitPrice')}
               label={
@@ -467,7 +557,7 @@ export function SalesLinesEditor({
           {errorText(listError)}
         </p>
       )}
-      <div className="border-t border-line px-5 py-3">
+      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
         <Button
           variant="secondary"
           size="sm"
@@ -478,11 +568,12 @@ export function SalesLinesEditor({
           <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
           {t('salesLines.addItems')}
         </Button>
+        {moreAdds?.(add)}
       </div>
       {lines.length > 0 && <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />}
 
       <Dialog open={picking} onOpenChange={setPicking}>
-        {picking && <SalesItemPicker onAdd={addProduct} />}
+        {picking && <SalesItemPicker onAdd={addProduct} maxLines={maxLines} />}
       </Dialog>
     </Card>
   );
@@ -490,7 +581,13 @@ export function SalesLinesEditor({
 
 // "Add items": search the products and services, then add one. The dialog stays open, so a long
 // order is put together without closing it; each click adds the product's lines at once.
-function SalesItemPicker({ onAdd }: { onAdd: (product: Product) => Promise<boolean> }) {
+function SalesItemPicker({
+  onAdd,
+  maxLines,
+}: {
+  onAdd: (product: Product) => Promise<boolean>;
+  maxLines: number;
+}) {
   const { t, errorText } = useLocale();
   const tenantId = useTenantId();
   const queryClient = useQueryClient();
@@ -508,7 +605,7 @@ function SalesItemPicker({ onAdd }: { onAdd: (product: Product) => Promise<boole
     try {
       const fits = await onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
       if (fits) setAdded((before) => new Set(before).add(summary.id));
-      else setProblem(t('salesLines.tooMany', { max: MAX_SALES_LINES }));
+      else setProblem(t('salesLines.tooMany', { max: maxLines }));
     } catch (error) {
       setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
     } finally {
```

- **`LinesEditor<L>` is generic over the line.** An invoice line is a sales line with four more fields. The quotation
  and the order still get `SalesLinesEditor`, which is `LinesEditor` with plain sales lines, so their forms do not
  change. A generic component cannot be loaded with `lazy()` and keep its type parameter, which is why the invoice
  has its own non-generic `InvoiceLinesEditor` (below) that the invoice form loads.
- **`newLine`** makes the form's own line from a product added with "Add items". The editor cannot add the invoice's
  extra fields itself without knowing them, and a cast to `L` would hide a missing field.
- **`update()` and `updateOwn()`.** The editor's own boxes change sales fields (`Partial<SalesLineFormValues>`); the
  invoice's batch and serial boxes change fields only `L` has (`Partial<L>`). TypeScript cannot check that a fixed
  object like `{ unitId }` fits `Partial<L>` for every possible `L`, so the two kinds of change have two functions.
- **`fixed`** shows the unit and the quantity as text (`FixedValue`) instead of boxes. A challan line is billed whole
  (15c.1): a box the person may not change would only invite a refused save. The price, the discount and the VAT
  rate stay boxes, because the bill may differ from the order (a late price agreement).
- **`lineNote`** is a slot under the item, like `note` on the stock line row in 15b. The editor stays free of the
  invoice's types; the invoice fills the slot with where the line comes from, or with its batch box.
- **`moreAdds` gets `add()`**, which the pickers use to add lines with their meta. `add()` checks the line limit
  first and adds nothing over it, like `addProduct()`. `addProduct()` now ends with `add()`, so both ways go through
  the same check and the same state change.
- **`maxLines`.** An invoice takes up to 500 lines (`MAX_INVOICE_LINES`, 15c.1), a quotation or an order 300.
- **`SalesField` is exported** for the invoice's own boxes under a line, so they hide their labels at the same width
  as the editor's.

### `components/invoice-lines.tsx` (new): the lines of an invoice

```tsx
import {
  Alert02Icon,
  DeliveryTruck01Icon,
  PlusSignIcon,
  Tick02Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type InvoiceLineFormValues,
  MAX_INVOICE_LINES,
  type SalesLineFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogContent, Dialog, EmptyState, Select } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { challanLines, orderCharges, type SourcedLine } from '../lib/invoice-sources';
import { type LineOrigin, sourceIdOf } from '../lib/invoices';
import {
  billableOrdersQuery,
  challansToInvoiceQuery,
  deliveryQuery,
  salesOrderQuery,
  stockCardQuery,
} from '../lib/queries';
import { isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
import { firstMessage } from '../lib/stock';
import { failureOf } from './journal-parts';
import { LinesEditor, SalesField } from './sales-line-editor';
import { SerialNumbersInput } from './serial-numbers-input';
import { useIsoDate, useQuantity, useTenantId } from './stock-parts';

// The lines of an invoice (step 15c): the sales line editor of the quotation and the order, with
// three kinds of line. A challan line and an order's service line are billed whole, so their item,
// unit and quantity are fixed; a line of its own is a normal sales line, and a goods one picks its
// batch or serial numbers, because posting the invoice delivers it. Its own chunk, loaded by the
// invoice form (sales-line-editor.tsx says why the editor is lazy).

export type InvoiceLinesErrors = FieldErrors<{ lines: InvoiceLineFormValues[] }>['lines'];

// A product added with "Add items": a line of its own
function ownLine(line: SalesLineFormValues): InvoiceLineFormValues {
  return { ...line, deliveryLineId: '', orderLineId: '', batchId: '', serialNumbers: [] };
}

// Billed whole: a challan line, or an order's service line
function isBilled(line: InvoiceLineFormValues): boolean {
  return sourceIdOf(line) !== null;
}

type Add = (entries: readonly { line: InvoiceLineFormValues; meta: LineMeta }[]) => boolean;

export function InvoiceLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  customerId,
  pricesIncludeVat,
  errors,
  warehouseId,
  origins,
  orderPricing,
  onSourced,
}: {
  lines: InvoiceLineFormValues[];
  onChange: (lines: InvoiceLineFormValues[]) => void;
  getLines: () => InvoiceLineFormValues[];
  initialMeta: LineMeta[];
  customerId: string;
  pricesIncludeVat: boolean;
  errors: InvoiceLinesErrors;
  // Where the invoice's own goods leave from ('' = none picked)
  warehouseId: string;
  origins: ReadonlyMap<string, LineOrigin>;
  // How the order lines on the form write their prices (null = no order line yet)
  orderPricing: boolean | null;
  // Lines a picker added: the form keeps their origins, and takes a branch from the challan
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void;
}) {
  const { t } = useLocale();
  const [picking, setPicking] = useState<'challans' | 'charges' | null>(null);
  const onForm = new Set(lines.flatMap((line) => sourceIdOf(line) ?? []));

  const note = ({
    value,
    index,
    item,
    update,
  }: {
    value: InvoiceLineFormValues;
    index: number;
    item: SalesItem;
    update: (patch: Partial<InvoiceLineFormValues>) => void;
  }): ReactNode => {
    const lineErrors = errors?.[index];
    const origin = origins.get(sourceIdOf(value) ?? '');
    // The billed line's own problem (billed by another invoice since, not this customer's any more)
    const sourceError = lineErrors?.deliveryLineId?.message ?? lineErrors?.orderLineId?.message;
    if (value.deliveryLineId) {
      return (
        <span className="grid gap-0.5 text-caption text-ink-3">
          <span className="font-medium text-ink-2">
            {t('invoices.fromChallan', { number: origin?.deliveryNumber ?? '' })}
            {origin?.orderNumber && ` · ${origin.orderNumber}`}
          </span>
          <span>{t('invoices.challanLineHint')}</span>
          <SourceError message={sourceError} />
        </span>
      );
    }
    if (value.orderLineId) {
      return (
        <span className="grid gap-0.5 text-caption">
          <span className="font-medium text-ink-2">
            {t('invoices.fromOrder', { number: origin?.orderNumber ?? '' })}
          </span>
          <SourceError message={sourceError} />
        </span>
      );
    }
    if (isServiceLine(item)) return null;
    return (
      <OwnStock
        index={index}
        item={item}
        line={value}
        warehouseId={warehouseId}
        update={update}
        errors={{
          batchId: lineErrors?.batchId?.message,
          serialNumbers: firstMessage(lineErrors?.serialNumbers),
        }}
      />
    );
  };

  return (
    <LinesEditor<InvoiceLineFormValues>
      lines={lines}
      onChange={onChange}
      getLines={getLines}
      initialMeta={initialMeta}
      customerId={customerId}
      pricesIncludeVat={pricesIncludeVat}
      errors={errors}
      newLine={ownLine}
      maxLines={MAX_INVOICE_LINES}
      fixed={isBilled}
      lineNote={note}
      moreAdds={(add) => (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={customerId === ''}
            onClick={() => {
              setPicking('challans');
            }}
          >
            <HugeiconsIcon icon={DeliveryTruck01Icon} size={16} strokeWidth={1.5} />
            {t('invoices.addChallans')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={customerId === ''}
            onClick={() => {
              setPicking('charges');
            }}
          >
            <HugeiconsIcon icon={Wrench01Icon} size={16} strokeWidth={1.5} />
            {t('invoices.addCharges')}
          </Button>
          {customerId === '' && (
            <span className="self-center text-label text-ink-3">
              {t('invoices.pickCustomerFirst')}
            </span>
          )}
          <Dialog
            open={picking !== null}
            onOpenChange={(open) => {
              if (!open) setPicking(null);
            }}
          >
            {picking === 'challans' && (
              <ChallanPicker
                customerId={customerId}
                onForm={onForm}
                orderPricing={orderPricing}
                add={add}
                onSourced={onSourced}
              />
            )}
            {picking === 'charges' && (
              <ChargePicker
                customerId={customerId}
                onForm={onForm}
                orderPricing={orderPricing}
                add={add}
                onSourced={onSourced}
              />
            )}
          </Dialog>
        </>
      )}
    />
  );
}
```

- **A chunk of its own**, loaded by the invoice form, like the quotation's editor. It holds the generic editor with
  the invoice's type written once (`LinesEditor<InvoiceLineFormValues>`), so the form does not need the generic.
- **`ownLine()`** is a product added with "Add items": a line of its own, with empty ids and no batch yet.
- **`isBilled()` is the editor's `fixed`.** Both kinds of billed line, a challan line and an order's service line,
  are billed whole, so neither may change its item, unit or quantity.
- **`onForm`** is the set of challan and order line ids already on the form. The pickers use it to add each line
  only once; the contract would refuse a line twice (`invoice_line_twice`), but only after the person clicked Save.
- **The note under each line** says what it bills:
  - a challan line: "From DC-…" and the order's number, the hint that the item and quantity are the challan's, and
    the line's own error (`invoice_delivery_line_billed` when another invoice billed it since);
  - an order's service line: "Service on SO-…" and its error;
  - a goods line of its own: the batch or serial boxes (`OwnStock`); a service of its own needs nothing.
- **The two picker buttons are disabled until a customer is picked**, with the reason next to them: the pickers list
  that customer's challans and orders.
- **One `Dialog` for both pickers.** Each picker renders only while open, so its query does not run in the
  background, as in 15b.

```tsx
function SourceError({ message }: { message: string | undefined }) {
  const { errorText } = useLocale();
  if (message === undefined) return null;
  return (
    <span className="flex items-start gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      {errorText(message)}
    </span>
  );
}

// The batch (from what the invoice's warehouse holds) or the serial numbers of a goods line the
// invoice delivers itself, like a challan line. The server checks them when it saves
// (resolveLines, the stock documents' own check), so a batch that ran out since says so there.
function OwnStock({
  index,
  item,
  line,
  warehouseId,
  update,
  errors,
}: {
  index: number;
  item: SalesItem;
  line: InvoiceLineFormValues;
  warehouseId: string;
  update: (patch: Partial<InvoiceLineFormValues>) => void;
  errors: { batchId: string | undefined; serialNumbers: string | undefined };
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const card = useQuery({
    ...stockCardQuery(tenantId, item.variantId),
    enabled: item.tracking === 'batch' && warehouseId !== '',
  }).data;
  const batches = (card?.batches ?? []).filter((batch) => batch.warehouseId === warehouseId);
  const id = (field: string) => `lines.${String(index)}.${field}`;
  return (
    <div className="grid gap-2">
      <span className="text-caption font-medium text-ink-2">{t('invoices.ownLine')}</span>
      {item.tracking === 'batch' && (
        <SalesField id={id('batchId')} label={t('stockLines.batch')} error={errors.batchId}>
          <Select
            id={id('batchId')}
            value={line.batchId ?? ''}
            invalid={errors.batchId !== undefined}
            // The batches are the warehouse's: none to pick before the warehouse is
            disabled={warehouseId === ''}
            options={[
              {
                value: '',
                label:
                  warehouseId === ''
                    ? t('stockLines.pickWarehouse')
                    : t('stockLines.batchPlaceholder'),
              },
              ...batches.map((batch) => ({
                value: batch.batchId,
                label: t('stockLines.batchOption', {
                  lot: batch.lotNumber,
                  quantity: quantityText(batch.quantity, item.baseUnitId),
                  expiry: batch.expiresOn === null ? t('stock.noExpiry') : isoDate(batch.expiresOn),
                }),
              })),
            ]}
            onChange={(event) => {
              update({ batchId: event.target.value });
            }}
          />
        </SalesField>
      )}
      {item.tracking === 'serial' && (
        <SalesField
          id={id('serialNumbers')}
          label={t('stockLines.serials')}
          error={errors.serialNumbers}
        >
          <SerialNumbersInput
            id={id('serialNumbers')}
            value={line.serialNumbers}
            invalid={errors.serialNumbers !== undefined}
            onChange={(serialNumbers) => {
              update({ serialNumbers });
            }}
          />
          <span className="text-caption text-ink-3">{t('stockLines.serialsHint')}</span>
        </SalesField>
      )}
    </div>
  );
}
```

- **`SourceError`** shows a billed line's problem with an icon and words, under the note. The line has no box for
  its id, so the error goes where the person reads about the line.
- **`OwnStock` is the challan line's batch box**, for goods the invoice delivers itself. The batches are the
  warehouse's (the stock card, step 13), so the box is disabled until the invoice has a warehouse, and its first
  option says to pick one. The server checks the batch and the serials again when it saves (15c.3), so a batch that
  ran out since is refused there.
- **No "Split by first expiry" here.** A counter sale is usually a few pieces from one batch. A large delivery goes
  on a challan, which has the split, and the invoice then bills the challan.

```tsx
// What both pickers share: add the lines unless they would mix the orders' two ways of writing
// prices (the API's invoice_vat_mixed) or pass the line limit; say why in the dialog otherwise
function useAddSourced(
  orderPricing: boolean | null,
  add: Add,
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void,
) {
  const { t, errorText } = useLocale();
  return (
    sourced: readonly SourcedLine[],
    pricing: boolean | null,
    warehouseId: string | null,
  ): string | null => {
    if (pricing !== null && orderPricing !== null && pricing !== orderPricing) {
      return errorText('invoice_vat_mixed');
    }
    if (!add(sourced.map(({ line, meta }) => ({ line, meta })))) {
      return t('salesLines.tooMany', { max: MAX_INVOICE_LINES });
    }
    onSourced(sourced, warehouseId);
    return null;
  };
}

// "Add challans": the customer's posted challans with something left to bill. Each click adds what
// is left of that challan, priced from its order. The dialog stays open: a month of challans for
// one depot goes on one invoice.
function ChallanPicker({
  customerId,
  onForm,
  orderPricing,
  add,
  onSourced,
}: {
  customerId: string;
  onForm: ReadonlySet<string>;
  orderPricing: boolean | null;
  add: Add;
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const addSourced = useAddSourced(orderPricing, add, onSourced);
  const { data: challans } = useQuery(challansToInvoiceQuery(tenantId, customerId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (deliveryId: string) => {
    setLoading(deliveryId);
    setProblem(null);
    try {
      const delivery = await queryClient.query(deliveryQuery(tenantId, deliveryId));
      const { lines, order } = await challanLines(queryClient, tenantId, delivery, onForm);
      const failed = addSourced(lines, order?.pricesIncludeVat ?? null, delivery.warehouseId);
      if (failed === null) setAdded((before) => new Set(before).add(deliveryId));
      else setProblem(failed);
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('invoices.challanPickerTitle')}
      description={t('invoices.challanPickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Problem message={problem} />
        {challans?.length === 0 ? (
          <EmptyState
            icon={DeliveryTruck01Icon}
            title={t('invoices.challanPickerEmpty')}
            description={t('invoices.challanPickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {challans?.map((challan) => (
              <li
                key={challan.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {challan.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {isoDate(challan.date)} ·{' '}
                    {t('invoices.challanLines', { count: challan.lineCount })}
                    {challan.order?.number && ` · ${challan.order.number}`}
                  </span>
                </span>
                <PickButton
                  added={added.has(challan.id)}
                  loading={loading === challan.id}
                  onClick={() => void pick(challan.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

// "Add order charges": the customer's orders; a click adds the order's services not billed yet
// (a delivery charge, an embroidery charge). The list cannot tell which orders still have one, so
// an order with nothing left says so when it is opened.
function ChargePicker({
  customerId,
  onForm,
  orderPricing,
  add,
  onSourced,
}: {
  customerId: string;
  onForm: ReadonlySet<string>;
  orderPricing: boolean | null;
  add: Add;
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const addSourced = useAddSourced(orderPricing, add, onSourced);
  const { data: orders } = useQuery(billableOrdersQuery(tenantId, customerId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (orderId: string) => {
    setLoading(orderId);
    setProblem(null);
    try {
      const order = await queryClient.query(salesOrderQuery(tenantId, orderId));
      const charges = orderCharges(order, onForm);
      if (charges.length === 0) {
        setProblem(t('invoices.noChargesLeft', { number: order.number ?? '' }));
        return;
      }
      const failed = addSourced(charges, order.pricesIncludeVat, order.warehouseId);
      if (failed === null) setAdded((before) => new Set(before).add(orderId));
      else setProblem(failed);
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('invoices.chargePickerTitle')}
      description={t('invoices.chargePickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Problem message={problem} />
        {orders?.length === 0 ? (
          <EmptyState
            icon={Wrench01Icon}
            title={t('invoices.chargePickerEmpty')}
            description={t('invoices.chargePickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {orders?.map((order) => (
              <li
                key={order.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {order.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {[isoDate(order.date), order.customerReference]
                      .filter((part) => part !== null)
                      .join(' · ')}
                  </span>
                </span>
                <PickButton
                  added={added.has(order.id)}
                  loading={loading === order.id}
                  onClick={() => void pick(order.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

// Problems stay in the dialog, next to the button that caused them (a toast would hide behind it)
function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="status" className="flex items-center gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
      {message}
    </p>
  );
}

function PickButton({
  added,
  loading,
  onClick,
}: {
  added: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const { t } = useLocale();
  return (
    <Button variant="secondary" size="sm" disabled={loading || added} onClick={onClick}>
      <HugeiconsIcon icon={added ? Tick02Icon : PlusSignIcon} size={16} strokeWidth={1.5} />
      {added ? t('salesLines.added') : t('salesLines.add')}
    </Button>
  );
}
```

- **`useAddSourced()`** is what both pickers do with picked lines: refuse to mix the orders' two ways of writing
  prices, refuse to pass the line limit, and otherwise add the lines and tell the form where they came from. The
  answer is the problem to show, or `null`.
- **The challan picker** lists the customer's posted challans with something left to bill. Each click reads the
  challan (through the query cache), works out what is left, prices it, and adds it. The dialog stays open: a month
  of challans for one depot goes on one invoice.
- **The charge picker** lists the customer's orders. The list cannot say which orders still have a service to bill,
  so an order with none left says so when it is clicked (`noChargesLeft`), instead of adding nothing silently.
- **Each picker passes the warehouse** of its challan or order, so the form can take its branch (below).
- **Problems stay in the dialog** (`role="status"`), next to the button that caused them, as in 15b's item picker.
- **`PickButton`** turns into "Added" with a tick and stays disabled, so nobody adds the same challan twice by
  clicking again while the dialog is open.

### `components/invoice-form.tsx` (new)

```tsx
import { Calendar03Icon, Delete02Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Delivery,
  dueDateOf,
  type Invoice,
  type InvoiceFormValues,
  type PartyRef,
  routes,
  updateInvoiceInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import type { SourcedLine } from '../lib/invoice-sources';
import { type LineOrigin, orderPricing, savedInvoiceLines, sourceIdOf } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { rowPath } from '../lib/products';
import { branchesQuery, customerQuery } from '../lib/queries';
import { SALES_LINE_FIELDS } from '../lib/sales';
import { serialPath } from '../lib/stock';
import {
  CreditLimitDialog,
  CreditLine,
  type CreditStop,
  creditStopOf,
  useCreditText,
} from './credit-parts';
import { failureOf } from './journal-parts';
import { SalesBackLink, useSalesRefresh } from './sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The invoice form (step 15c): its own chunk, loaded by routes/invoice.tsx, like the order's.

// The lines are a chunk of their own (sales-line-editor.tsx says why), and so are the customer box
// and the date picker: both bring the popover, as on the delivery form
const InvoiceLinesEditor = lazy(async () => ({
  default: (await import('./invoice-lines')).InvoiceLinesEditor,
}));
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = InvoiceFormValues;
type LineValues = FormValues['lines'][number];

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'dueDate',
    'customerReference',
    'branchId',
    'warehouseId',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      ...SALES_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
      rowPath('lines', index, 'deliveryLineId'),
      rowPath('lines', index, 'orderLineId'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'serialNumbers'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}
```

- **Three lazy parts**: the lines (the editor brings decimal.js with its money boxes), and the customer box and the
  date picker (both bring the popover), as on the delivery form. The form's chunk is 87 KB and the lines' 91 KB;
  together they would be far over 100 KB.
- **`fieldNames()`** lists every path the server may name, the invoice line's four extra fields and each serial
  number included, so `applyApiError()` can put each error under its own box.

```tsx
// Writing a new invoice (from nothing, from a challan, or for a customer), or changing a draft.
// "Save draft" keeps it a draft; "Post invoice" saves and posts in one request: the number, the
// sale in the books, and a challan for the goods it delivers itself, all or nothing.
export function InvoiceForm({
  invoice,
  start,
  customer: startCustomer,
  today,
  pricesIncludeVat: workspacePricing,
}: {
  invoice: Invoice | null;
  // "Make invoice" on a challan: the challan and its lines, priced
  start: { delivery: Delivery; lines: SourcedLine[] } | null;
  // "New invoice" on a customer's page
  customer: PartyRef | null;
  today: string;
  // The workspace's setting now: the price setting of an invoice no order prices
  pricesIncludeVat: boolean;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  const canOverride = useCan()('sales.credit.override');
  const creditText = useCreditText();
  const [confirming, setConfirming] = useState(false);
  const [stop, setStop] = useState<CreditStop | null>(null);
  const [saved] = useState(() => {
    if (invoice) return savedInvoiceLines(invoice);
    return {
      values: start?.lines.map((entry) => entry.line) ?? [],
      meta: start?.lines.map((entry) => entry.meta) ?? [],
      origins: new Map(start?.lines.map((entry) => entry.origin)),
    };
  });
  // Where each challan line and order line on the form comes from, by its id
  const [origins, setOrigins] = useState<ReadonlyMap<string, LineOrigin>>(saved.origins);
  const savedCustomer = invoice?.customer ?? start?.delivery.customer ?? startCustomer;
  // A challan's branch is the branch of the warehouse it left from; one branch needs no choice
  const branchOf = (warehouseId: string | null) =>
    (warehouseId === null ? undefined : byId.get(warehouseId)?.branchId) ??
    (branches.length === 1 ? branches[0]?.id : undefined);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateInvoiceInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      date: invoice?.date ?? today,
      // A draft's due date is kept as saved; the API filled an empty one from the terms
      dueDate: invoice?.dueDate ?? '',
      customerReference: invoice?.customerReference ?? '',
      branchId: invoice?.branchId ?? branchOf(start?.delivery.warehouseId ?? null) ?? '',
      warehouseId: invoice?.warehouseId ?? '',
      note: invoice?.note ?? '',
      lines: saved.values,
      post: false,
      overrideCreditLimit: false,
      version: invoice?.version ?? 1,
    },
  });
  const lines = useWatch({ control, name: 'lines' });
  const customerId = useWatch({ control, name: 'customerId' });
  const date = useWatch({ control, name: 'date' });
  const dueDate = useWatch({ control, name: 'dueDate' }) ?? '';
  const warehouseId = useWatch({ control, name: 'warehouseId' }) ?? '';
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  // The orders' way of writing prices, else the draft's, else the workspace's (the API's order)
  const linePricing = orderPricing(lines, origins);
  const pricesIncludeVat = linePricing ?? invoice?.pricesIncludeVat ?? workspacePricing;
  // A challan line or an order line belongs to its customer: the customer stays while one is here
  const customerLocked = lines.some((line) => sourceIdOf(line) !== null);
  const billingAddress =
    customer?.addresses.find((address) => address.kind === 'billing')?.address ?? null;

  // Lines a picker added: keep where they came from, and take the branch of the challan's
  // warehouse when none is picked yet
  const sourced = (added: readonly SourcedLine[], fromWarehouse: string | null) => {
    setOrigins((before) => new Map([...before, ...added.map((entry) => entry.origin)]));
    const branchId = branchOf(fromWarehouse);
    if (getValues('branchId') === '' && branchId !== undefined) setValue('branchId', branchId);
  };

  // override: the second try, after the person saw the credit dialog and went on
  const save = (post: boolean, override = false) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post, overrideCreditLimit: override };
        const result = invoice
          ? await call(routes.invoices.update, {
              params: { id: invoice.id },
              body: { ...body, version },
            })
          : await call(routes.invoices.create, { body });
        await refresh();
        setStop(null);
        toast(
          result.status === 'posted'
            ? t('invoices.posted', { number: result.number ?? '' })
            : t('invoices.draftSaved'),
        );
        if (!invoice) {
          void navigate({
            to: '/invoices/$invoiceId',
            params: { invoiceId: result.id },
            replace: true,
          });
        }
      } catch (error) {
        const credit = creditStopOf(error);
        if (credit !== null && canOverride && !override) {
          setStop(credit);
          return;
        }
        setStop(null);
        const text = creditText(error);
        if (text !== null) setError('root.server', { message: text });
        else applyApiError(error, fieldNames(getValues('lines')), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: Invoice) =>
      call(routes.invoices.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('invoices.deleted'));
      void navigate({ to: '/invoices' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const terms = customer?.paymentTermsDays;
```

- **`start`** is "Make invoice" on a challan: the challan and its priced lines, read by the route before the form
  opens (below). **`customer`** is "New invoice" on a customer's page.
- **`saved` is kept in state**, like `start` in the 15b forms: the form's first lines, the editor's meta and the
  origins come from one call and stay in step.
- **`origins` is state; the price setting is worked out.** `pricesIncludeVat` follows the order lines on the form
  (`orderPricing()`), else the draft's own setting, else the workspace's: the API's order (15c.3). Removing the last
  line from an order gives the decision back to the draft, as the API would on the next save.
- **`branchOf()`** finds the branch of a warehouse (warehouses belong to branches, step 13), or the only branch.
  "Make invoice" starts with the challan's branch; a picked challan and the "Deliver from" box set it when none is
  picked yet. A branch the person picked is never changed: the invoice belongs to whoever bills it (15c.1).
- **The due date starts empty for a new invoice.** The API fills an empty box from the customer's payment terms
  (`dueDateOf()`). A draft shows its saved due date as it is.
- **`customerLocked`** while a challan line or an order line is on the form. Those lines belong to their customer;
  the API would refuse them on another one. The hint says how to change the customer: remove those lines.
- **The billing address is shown, not picked.** A customer has one billing address (15a), and the API copies its
  text onto the invoice when it saves (15c.3). The box shows what will be copied, and says where to change it.
- **`save(post, override)`** works like the order form's: "Save draft" or "Post invoice" in one request, and the
  credit dialog only for someone who may go over the limit. The API checks the limit when it posts, so a draft never
  asks.
- **A new invoice goes to its page** (`replace`, so "Back" does not open an empty form). A posted draft stays on the
  same page: the query refreshes, the status is posted, and the route shows the read-only page.

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/invoices" label={t('invoices.back')} />
      <PageHeader
        title={invoice ? t('invoices.draftTitle') : t('invoices.newTitle')}
        description={t('invoices.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <FormField
              control={control}
              name="customerId"
              label={t('invoices.customer')}
              hint={customerLocked ? t('invoices.customerLocked') : undefined}
            >
              {(field) => (
                <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                  <CustomerPicker
                    {...field}
                    saved={savedCustomer}
                    disabled={customerLocked}
                    onChange={(next) => {
                      setValue('customerId', next, {
                        shouldValidate: errors.customerId !== undefined,
                      });
                    }}
                  />
                </Suspense>
              )}
            </FormField>
            <CreditLine customerId={customerId} />
          </div>
          <FormField control={control} name="date" label={t('invoices.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField
            control={control}
            name="dueDate"
            label={t('invoices.dueDate')}
            optional
            // Empty: what the customer's payment terms make it, worked out the API's way
            hint={
              dueDate === '' && terms !== undefined
                ? `${t('invoices.dueDateHint')} ${t('invoices.dueOn', {
                    date: isoDate(dueDateOf(date, terms)),
                  })}`
                : t('invoices.dueDateHint')
            }
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <TextField
            label={t('invoices.customerReference')}
            optional
            hint={t('invoices.customerReferenceHint')}
            placeholder={t('invoices.customerReferencePlaceholder')}
            {...register('customerReference')}
            error={errors.customerReference?.message}
          />
          <SelectField
            label={t('invoices.branch')}
            hint={t('invoices.branchHint')}
            options={[
              { value: '', label: t('invoices.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <SelectField
            label={t('invoices.warehouse')}
            optional
            hint={t('invoices.warehouseHint')}
            options={[
              { value: '', label: t('invoices.noWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId', {
              // The goods leave a branch's warehouse: its branch, when none is picked yet
              onChange: () => {
                const branchId = branchOf(getValues('warehouseId') ?? null);
                if (getValues('branchId') === '' && branchId !== undefined) {
                  setValue('branchId', branchId);
                }
              },
            })}
            error={errors.warehouseId?.message}
          />
          <div className="grid min-w-0 content-start gap-1.5">
            <span className="text-label font-medium text-ink">{t('invoices.billingAddress')}</span>
            {/* Copied onto the invoice when it is saved; changed on the customer's page */}
            <span className="text-body-sm whitespace-pre-line text-ink-2">
              {billingAddress ?? t('invoices.noBillingAddress')}
            </span>
          </div>
          <div className="sm:col-span-2">
            <TextField
              label={t('invoices.note')}
              optional
              placeholder={t('invoices.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Controller
          control={control}
          name="lines"
          render={({ field }) => (
            <Suspense fallback={<Card className="min-h-24" />}>
              <InvoiceLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={saved.meta}
                customerId={customerId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
                warehouseId={warehouseId}
                origins={origins}
                orderPricing={linePricing}
                onSourced={sourced}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {invoice && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(invoice);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('invoices.confirmDelete') : t('invoices.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('invoices.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('invoices.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || lines.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('invoices.posting') : t('invoices.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('invoices.postHint')}</p>
      </form>
      <CreditLimitDialog
        stop={stop}
        customer={customer?.name ?? savedCustomer?.name ?? ''}
        confirmLabel={t('creditLimit.postInvoice')}
        pending={isSubmitting}
        onConfirm={() => void save(true, true)()}
        onClose={() => {
          setStop(null);
        }}
      />
    </div>
  );
}
```

- **The due date's hint shows the date the API will use** when the box is empty ("Due 5 Nov 2026"), worked out with
  the contract's own `dueDateOf()` from the date and the customer's terms. The person sees the result before saving.
- **"Deliver from" is optional**, and its empty option says when that is right ("Every item is on a challan"). The
  server asks for it only when a goods line is a line of its own (`invoice_warehouse_required`), because only the
  server knows which products are goods.
- **The Post button is disabled with no lines**, as on the other documents. The contract would refuse an empty
  invoice anyway (`sales_lines_required`).
- **`postHint`** says what posting does before the first post: the number, the sale in the books, and a challan for
  the items not on one.
- **Delete is two clicks, on the left**, with its warning. A draft has no number, so nothing is lost but the draft.

### `components/invoice-view.tsx` (new)

```tsx
import { MoneyReceive02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Invoice, isOverdue, paymentStatusOf } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { amountDue, daysLate } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { InvoicePrint, PrintButton } from './print-documents';
import { SalesLinesTable } from './sales-lines-table';
import { CustomerLink, DocumentNotice, InvoicePills, SalesBackLink } from './sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// A list of document links in a card: the challans an invoice bills, its orders, its payments
function LinkList({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} subtitle={subtitle} />
      <ul className="mt-3 grid grid-cols-1">{children}</ul>
    </Card>
  );
}

const ROW =
  'flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-body-sm hover:bg-subtle';
const NUMBER = 'font-mono font-medium text-brand tabular-nums';

// A posted invoice (or a draft for someone who may not write invoices), read only. A posted one
// never changes: a credit note corrects it (15d). What it was paid with, and "Record payment"
// while something is still due.
export function InvoiceView({ invoice, today }: { invoice: Invoice; today: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const branches = useQuery(branchesQuery(useTenantId(), 'active')).data;
  const canPay = useCan()('sales.receipt.manage');
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = invoice.status === 'posted';
  const late = isOverdue(invoice, today) ? daysLate(invoice.dueDate, today) : 0;
  const open = posted && paymentStatusOf(invoice) !== 'paid';

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/invoices" label={t('invoices.back')} />
      <PageHeader
        title={invoice.number ?? t('invoices.draftTitle')}
        description={invoice.customer.name}
        actions={
          <>
            <InvoicePills invoice={invoice} today={today} />
            {posted && <PrintButton />}
          </>
        }
      />
      {late > 0 && (
        <DocumentNotice tone="warn">
          {t('invoices.overdueNotice', { count: late, date: isoDate(invoice.dueDate) })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('invoices.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={invoice.customer} />
          </span>
        </div>
        <Fact label={t('invoices.date')} value={isoDate(invoice.date)} />
        <Fact label={t('invoices.dueDate')} value={isoDate(invoice.dueDate)} />
        {invoice.customerReference !== null && (
          <Fact label={t('invoices.customerReference')} value={invoice.customerReference} />
        )}
        <Fact
          label={t('invoices.branch')}
          value={branches?.find((branch) => branch.id === invoice.branchId)?.name ?? '—'}
        />
        {invoice.warehouseId !== null && (
          <Fact
            label={t('invoices.warehouse')}
            value={warehouseLabel(byId.get(invoice.warehouseId))}
          />
        )}
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">
            {t('invoices.billingAddress')}
          </span>
          {/* The address as it was when the invoice was saved, one part per line */}
          <span className="text-body-sm whitespace-pre-line text-ink">
            {invoice.billingAddress ?? t('invoices.noBillingAddress')}
          </span>
        </div>
        {invoice.postedAt !== null && (
          <Fact
            label={t('invoices.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('invoices.postedOn', { date: format.date(new Date(invoice.postedAt)) })}
          />
        )}
        {posted && (
          <EntryLinks
            label={t('invoices.entry')}
            entries={invoice.entry ? [invoice.entry] : []}
            none={t('invoices.noEntry')}
          />
        )}
        {posted && (
          <>
            <Fact label={t('invoices.paid')} value={money(invoice.amountPaid)} />
            <Fact label={t('invoices.due')} value={money(amountDue(invoice))} />
          </>
        )}
        {invoice.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('invoices.note')} value={invoice.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={invoice.lines}
        totals={invoice}
        pricesIncludeVat={invoice.pricesIncludeVat}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {invoice.deliveries.length > 0 && (
          <LinkList title={t('invoices.challansTitle')} subtitle={t('invoices.challansSubtitle')}>
            {invoice.deliveries.map((delivery) => (
              <li key={delivery.id}>
                <Link
                  to="/deliveries/$deliveryId"
                  params={{ deliveryId: delivery.id }}
                  className={ROW}
                >
                  <span className={NUMBER}>{delivery.number}</span>
                  <span className="text-ink-3 tabular-nums">{isoDate(delivery.date)}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {invoice.orders.length > 0 && (
          <LinkList title={t('invoices.ordersTitle')}>
            {invoice.orders.map((order) => (
              <li key={order.id}>
                <Link to="/sales-orders/$orderId" params={{ orderId: order.id }} className={ROW}>
                  <span className={NUMBER}>{order.number ?? ''}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {posted && (
          <Card className="overflow-hidden">
            <CardHeader
              title={t('invoices.paymentsTitle')}
              subtitle={t('invoices.paymentsSubtitle')}
            />
            {invoice.payments.length === 0 ? (
              <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">{t('invoices.noPayments')}</p>
            ) : (
              <ul className="mt-3 grid grid-cols-1">
                {invoice.payments.map((payment) => (
                  <li key={payment.receiptId}>
                    <Link
                      to="/receipts/$receiptId"
                      params={{ receiptId: payment.receiptId }}
                      className={ROW}
                    >
                      <span className={NUMBER}>{payment.receiptNumber}</span>
                      <span className="text-ink-3 tabular-nums">{isoDate(payment.date)}</span>
                      <span className="ml-auto font-medium tabular-nums">
                        {money(payment.amount)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {open && canPay && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              void navigate({
                to: '/receipts/new',
                search: { customerId: invoice.customer.id, invoiceId: invoice.id },
              })
            }
          >
            <HugeiconsIcon icon={MoneyReceive02Icon} size={17} strokeWidth={1.5} />
            {t('invoices.recordPayment')}
          </Button>
        </div>
      )}
      {posted && <InvoicePrint invoice={invoice} />}
    </div>
  );
}
```

- **A posted invoice is read only.** It never changes; a credit note corrects it (15d).
- **The overdue notice** says how many days late it is, with the due date, in a `warn` notice. The pill already says
  "Overdue"; the notice says by how much, which is what the person calls the customer about.
- **Paid and still due, in paisa**, in the facts card. An invoice is an accounting document whose numbers must add up.
- **The challans, orders and payments link to their pages.** Everyone may read them (reading sales documents needs no
  permission, 15b.1). A payment is a money receipt; its amount is what that receipt put on this invoice.
- **"Record payment" only while something is due**, and only with `sales.receipt.manage`. It opens the receipt form
  with this invoice: its customer, what it still owes, already applied to it.
- **The print sheet only for a posted invoice.** A draft has no number, and a customer must never get one.

### The invoice pages: `routes/invoice.tsx`, `routes/invoices.tsx` (new)

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { challanLines } from '../lib/invoice-sources';
import { useCan } from '../lib/permissions';
import {
  branchesQuery,
  customerQuery,
  deliveryQuery,
  invoiceQuery,
  settingsQuery,
  taxRatesQuery,
  unitsQuery,
} from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own
const InvoiceForm = lazy(async () => ({
  default: (await import('../components/invoice-form')).InvoiceForm,
}));
const InvoiceView = lazy(async () => ({
  default: (await import('../components/invoice-view')).InvoiceView,
}));

// The units, the VAT rates, the warehouses, the branches and the settings: the form's lines and
// boxes need them all
function useReady(): { pricesIncludeVat: boolean } | null {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const { active } = useWarehouses();
  if (!units || !rates || !settings || !branches || !active) return null;
  return { pricesIncludeVat: settings.pricesIncludeVat };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/invoices" label={t('invoices.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('invoices.title')} description={message} />
    </div>
  );
}

// A new invoice. "Make invoice" on a challan comes with ?deliveryId=: the form starts with what is
// left to bill on it, priced from its order. "New invoice" on a customer's page comes with
// ?customerId=.
export function NewInvoicePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const canWrite = useCan()('sales.invoice.manage');
  const today = useToday();
  const ready = useReady();
  const { deliveryId = '', customerId = '' } = useSearch({ strict: false });
  const delivery = useQuery({
    ...deliveryQuery(tenantId, deliveryId),
    enabled: deliveryId !== '',
  });
  const start = useQuery({
    queryKey: ['sales', tenantId, 'invoice-start', deliveryId],
    queryFn: async () => {
      if (!delivery.data) throw new Error('No challan');
      return {
        delivery: delivery.data,
        ...(await challanLines(queryClient, tenantId, delivery.data, new Set())),
      };
    },
    enabled: delivery.data !== undefined,
    // Read once for this form: the next "Make invoice" asks again, after whatever was billed since
    gcTime: 0,
    retry: false,
  });
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/invoices" label={t('invoices.back')} />
        <p className="text-body-sm text-ink-3">{t('invoices.cantWrite')}</p>
      </div>
    );
  }
  if (delivery.isError || start.isError) return <CantFind message={t('deliveries.notFound')} />;
  if (customer.isError) return <CantFind message={t('customers.notFound')} />;
  // The form waits for the challan's lines or the customer: drawing it empty and filling it a
  // moment later would let the person type into a form that is about to be replaced
  if (!ready || (deliveryId !== '' && !start.data) || (customerId !== '' && !customer.data)) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <InvoiceForm
        invoice={null}
        start={start.data ? { delivery: start.data.delivery, lines: start.data.lines } : null}
        customer={customer.data ?? null}
        today={today}
        pricesIncludeVat={ready.pricesIncludeVat}
      />
    </Suspense>
  );
}

export function InvoicePage() {
  const { t } = useLocale();
  const { invoiceId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.invoice.manage');
  const today = useToday();
  const ready = useReady();
  const { data: invoice, isError } = useQuery({
    ...invoiceQuery(useTenantId(), invoiceId),
    enabled: invoiceId !== '',
  });

  if (isError) return <CantFind message={t('invoices.notFound')} />;
  if (!invoice || !ready) return null;
  if (invoice.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <InvoiceForm
          key={`${invoice.id}-${String(invoice.version)}`}
          invoice={invoice}
          start={null}
          customer={null}
          today={today}
          pricesIncludeVat={ready.pricesIncludeVat}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <InvoiceView invoice={invoice} today={today} />
    </Suspense>
  );
}
```

- **The route loads the data and picks the form or the view**, each a lazy chunk, as in 15b.
- **`useReady()` waits for the branches too.** The form's branch box and `branchOf()` need them at once.
- **"Make invoice" reads the challan and prices its lines before the form opens** (`challanLines()` in a query). The
  form then starts with the lines filled, instead of drawing empty and filling a moment later. `gcTime: 0` throws the
  answer away when the form closes: the next "Make invoice" must see what was billed since.
- **The invoice-start query's key is under `['sales', tenantId]`.** If something else is billed while the form is
  open, the refresh asks again; the form has taken its lines already and does not change.
- **A missing challan or customer says so**, like a missing order in 15b.

```tsx
import { Invoice03Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { INVOICE_PAYMENT_FILTERS, type InvoiceSummary } from '@omnivo/contracts';
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

import { CustomerPicker } from '../components/customer-picker';
import { InvoicePills } from '../components/sales-parts';
import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
import { amountDue } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { type InvoiceListFilter, invoicesQuery } from '../lib/queries';

const column = dataTableColumns<InvoiceSummary>();

// One control for what the person asks: drafts, or posted invoices by what is paid. A draft has
// nothing paid yet, so the two filters of the API never need to be set together.
const SHOW = ['', 'draft', ...INVOICE_PAYMENT_FILTERS] as const;
type Show = (typeof SHOW)[number];

function filterOf(show: Show, customerId: string): InvoiceListFilter {
  if (show === 'draft') return { status: 'draft', payment: '', customerId };
  return { status: '', payment: show, customerId };
}

export function InvoicesPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.invoice.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const [show, setShow] = useState<Show>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    invoicesQuery(useTenantId(), filterOf(show, customerId)),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('invoices.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('invoices.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((invoice) => invoice.customer.name, {
          id: 'customer',
          header: t('invoices.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              {/* The buyer's own number, the one they ask about */}
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customerReference ?? row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('dueDate', {
          header: t('invoices.columns.dueDate'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="tabular-nums">{isoDate(getValue())}</span>,
        }),
        column.accessor('total', {
          header: t('invoices.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka; the invoice's page shows paisa
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor((invoice) => amountDue(invoice), {
          id: 'due',
          header: t('invoices.columns.due'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A draft asks for nothing yet
          cell: ({ row, getValue }) =>
            row.original.status === 'draft' ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-medium">{format.money(getValue())}</span>
            ),
        }),
        column.display({
          id: 'status',
          header: t('invoices.columns.status'),
          meta: { card: 'trailing' },
          cell: ({ row }) => <InvoicePills invoice={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, today],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/invoices/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('invoices.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('invoices.title')}
        description={t('invoices.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="invoices-customer"
            aria-label={t('invoices.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('invoices.show')}
          value={show}
          options={SHOW.map((value) => ({
            value,
            label:
              value === ''
                ? t('invoices.all')
                : value === 'draft'
                  ? t('invoices.statuses.draft')
                  : t(`invoices.paymentFilters.${value}`),
          }))}
          onChange={setShow}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('invoices.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('invoices.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/invoices/$invoiceId', params: { invoiceId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Invoice03Icon}
              title={t('invoices.emptyTitle')}
              description={t('invoices.emptyBody')}
              action={write}
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

- **One control for what to show**: All, Draft, Not paid, Overdue, Paid. A draft has nothing paid yet, so the API's
  two filters (status and payment) never need to be set together. `filterOf()` turns the one choice into the two.
- **Still due in the list, in whole taka**, with a dash for a draft (it asks for nothing yet). The customer's own
  reference under their name: a buyer asks about their PO, not about INV-2026-27-0042.
- **The pills get `today`**, so an invoice past its due date shows "Overdue" in the list too.

### Money receipts: `components/allocation-table.tsx` (new)

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { compareMoney, isMoneyAmount, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, MoneyInput } from '@omnivo/ui';
import type { FieldErrors } from 'react-hook-form';

import { type AllocationRow, appliedOf, suggestAllocations } from '../lib/invoices';
import { useIsoDate } from './stock-parts';

// Where a money receipt's money goes (step 15c): one row per invoice the customer still owes on,
// the oldest due date first, with a box for what this receipt puts on it. Used by the receipt form
// and by "Apply money" on a saved receipt.

interface Allocation {
  invoiceId: string;
  amount: string;
}
export type AllocationErrors = FieldErrors<{ allocations: Allocation[] }>['allocations'];

export function AllocationTable({
  rows,
  value,
  onChange,
  amount,
  errors,
  empty,
}: {
  rows: readonly AllocationRow[];
  // Only the invoices that get something: the contract refuses an empty or ৳0 amount, so a box
  // left empty is not in the list at all
  value: readonly Allocation[];
  onChange: (value: Allocation[]) => void;
  // The receipt's amount: what "Apply oldest first" spreads, and what the line below adds up to
  amount: string;
  errors: AllocationErrors;
  // What to say when there is no row (no customer yet, or nothing owed)
  empty: string;
}) {
  const { t, format, errorText } = useLocale();
  const isoDate = useIsoDate();
  const money = (text: string) => format.money(text, { decimals: 2 });
  const applied = appliedOf(value);
  const left = isMoneyAmount(amount.trim()) ? subtractMoney(amount.trim(), applied) : null;
  const over = left !== null && compareMoney(left, '0') < 0;
  const listError = errors?.root?.message ?? errors?.message;

  // A box changed: the row's amount replaces the old one, or the row leaves the list when emptied
  const change = (invoiceId: string, next: string) => {
    const rest = value.filter((allocation) => allocation.invoiceId !== invoiceId);
    if (next.trim() === '') {
      onChange(rest);
      return;
    }
    // In the rows' order, so the server's "allocations.3" points at the row it means
    const order = new Map(rows.map((row, index) => [row.invoiceId, index]));
    onChange(
      [...rest, { invoiceId, amount: next }].toSorted(
        (a, b) => (order.get(a.invoiceId) ?? 0) - (order.get(b.invoiceId) ?? 0),
      ),
    );
  };

  if (rows.length === 0) return <p className="px-5 py-4 text-body-sm text-ink-2">{empty}</p>;

  return (
    <div className="grid grid-cols-1">
      <div className="flex flex-wrap gap-2 px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!isMoneyAmount(amount.trim())}
          onClick={() => {
            onChange(suggestAllocations(amount, rows));
          }}
        >
          {t('receipts.applyOldest')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={value.length === 0}
          onClick={() => {
            onChange([]);
          }}
        >
          {t('receipts.clearAll')}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-body-sm">
          <caption className="sr-only">{t('receipts.applyTitle')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('receipts.allocationColumns.invoice')}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t('receipts.allocationColumns.total')}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t('receipts.allocationColumns.due')}
              </th>
              <th scope="col" className="w-40 px-5 py-2.5 text-right">
                {t('receipts.allocationColumns.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const index = value.findIndex((allocation) => allocation.invoiceId === row.invoiceId);
              const rowErrors = index === -1 ? undefined : errors?.[index];
              const error = rowErrors?.amount?.message ?? rowErrors?.invoiceId?.message;
              const id = `allocation-${row.invoiceId}`;
              return (
                <tr key={row.invoiceId} className="border-t border-line align-top">
                  <td className="px-5 py-3">
                    <span className="block font-mono font-medium tabular-nums">{row.number}</span>
                    <span className="block text-caption text-ink-3 tabular-nums">
                      {t('invoices.dueOn', { date: isoDate(row.dueDate) })}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                    {money(row.total)}
                  </td>
                  <td className="px-3 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {money(row.due)}
                  </td>
                  <td className="px-5 py-2">
                    <MoneyInput
                      id={id}
                      aria-label={t('receipts.applyTo', { number: row.number })}
                      value={index === -1 ? '' : (value[index]?.amount ?? '')}
                      invalid={error !== undefined}
                      aria-describedby={error ? `${id}-error` : undefined}
                      onChange={(next) => {
                        change(row.invoiceId, next);
                      }}
                    />
                    {error && (
                      <span id={`${id}-error`} className="mt-1 block text-label text-crit">
                        {errorText(error)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 border-t border-line bg-subtle px-5 py-3 text-body-sm tabular-nums">
        <span>
          <span className="text-ink-2">{t('receipts.applied')}</span>{' '}
          <span className="font-medium">{money(applied)}</span>
        </span>
        {left !== null &&
          (over ? (
            // More applied than received: the one state that needs attention, with an icon
            <span className="flex items-center gap-1.5 font-medium text-crit">
              <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} />
              {t('receipts.overBy', { amount: money(subtractMoney('0', left)) })}
            </span>
          ) : (
            <span>
              <span className="text-ink-2">{t('receipts.unapplied')}</span>{' '}
              <span className="font-medium">{money(left)}</span>
            </span>
          ))}
      </div>
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
      )}
    </div>
  );
}
```

- **Shared by the receipt form and the apply dialog**: both show the same rows and the same boxes.
- **The form value holds only the invoices that get something.** The contract refuses an empty or ৳0 amount
  (`receipt_amount_required`), so a box left empty is not in the list at all, and emptying a box removes its row
  from the value.
- **The value stays in the rows' order.** The server names an error by its place in the list (`allocations.3.amount`);
  keeping the list in the table's order keeps the error under the right row.
- **Each row finds its error by its own place in the value**, not by the row's place in the table: the value has
  fewer entries than the table has rows.
- **The line under the table** shows what is applied and what is left as an advance, or "Over by" with an icon the
  moment the amounts add up to more than the receipt, before the server says `receipt_over_allocated`.
- **Four columns, so it fits a dialog** (520px): the invoice with its due date under the number, the total, what is
  still due, and the box. On a phone it scrolls inside its own box.

### `components/receipt-form.tsx` (new)

```tsx
import { Calendar03Icon, UserIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Invoice,
  moneyAccountIds,
  type PartyRef,
  PAYMENT_METHODS,
  plainQuantity,
  receiptInputSchema,
  type ReceiptFormValues,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  FormAlert,
  FormField,
  Input,
  MoneyInput,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useMemo } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { allocationRows, amountDue } from '../lib/invoices';
import { rowPath } from '../lib/products';
import { accountsQuery, branchesQuery, openInvoicesQuery } from '../lib/queries';
import { AllocationTable } from './allocation-table';
import { CreditLine } from './credit-parts';
import { SalesBackLink, useSalesRefresh } from './sales-parts';
import { useTenantId } from './stock-parts';

// The money receipt form (step 15c): its own chunk, loaded by routes/receipt.tsx. A receipt is
// never a draft: saving it posts it, so there is only this form for a new one.

// Both bring the popover; the delivery form says why that matters for the chunk
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = ReceiptFormValues;

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'amount',
    'accountId',
    'method',
    'reference',
    'branchId',
    'note',
    'allocations',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('allocations', index, 'invoiceId'),
      rowPath('allocations', index, 'amount'),
    ]).flat(),
  ];
}

export function ReceiptForm({
  customer: startCustomer,
  invoice,
  today,
}: {
  // "Record payment" on a customer's page
  customer: PartyRef | null;
  // "Record payment" on an invoice: its customer, what it still owes, applied to it
  invoice: Invoice | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  // The accounts money goes into: the contracts' own list, the one the API checks against
  const moneyAccounts = useMemo(() => {
    const all = accounts ?? [];
    const ids = moneyAccountIds(all);
    return all
      .filter((account) => ids.has(account.id))
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts]);
  const savedCustomer = invoice?.customer ?? startCustomer;
  const due = invoice ? plainQuantity(amountDue(invoice)) : '';
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(receiptInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      date: today,
      amount: due,
      // One cash box or bank account needs no choice
      accountId: moneyAccounts.length === 1 ? (moneyAccounts[0]?.id ?? '') : '',
      method: 'cash',
      reference: '',
      branchId: invoice?.branchId ?? (branches.length === 1 ? (branches[0]?.id ?? '') : ''),
      note: '',
      allocations: invoice ? [{ invoiceId: invoice.id, amount: due }] : [],
    },
  });
  const customerId = useWatch({ control, name: 'customerId' });
  const amount = useWatch({ control, name: 'amount' });
  const method = useWatch({ control, name: 'method' });
  const { data: open } = useQuery({
    ...openInvoicesQuery(tenantId, customerId),
    enabled: customerId !== '',
  });
  const rows = useMemo(() => allocationRows(open ?? [], []), [open]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.receipts.create, { body: values });
      await refresh();
      toast(t('receipts.saved', { number: saved.number }));
      void navigate({
        to: '/receipts/$receiptId',
        params: { receiptId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(getValues('allocations').length), setError);
    }
  });

  const failure = errors.root?.server?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/receipts" label={t('receipts.back')} />
      <PageHeader title={t('receipts.newTitle')} description={t('receipts.description')} />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <FormField control={control} name="customerId" label={t('receipts.customer')}>
              {(field) => (
                <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                  <CustomerPicker
                    {...field}
                    saved={savedCustomer}
                    onChange={(next) => {
                      setValue('customerId', next, {
                        shouldValidate: errors.customerId !== undefined,
                      });
                      // Another customer's invoices are not this one's to pay
                      setValue('allocations', []);
                    }}
                  />
                </Suspense>
              )}
            </FormField>
            <CreditLine customerId={customerId} />
          </div>
          <FormField control={control} name="date" label={t('receipts.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="amount" label={t('receipts.amount')}>
            {(field) => <MoneyInput {...field} />}
          </FormField>
          <SelectField
            label={t('receipts.account')}
            hint={moneyAccounts.length === 0 ? t('receipts.noAccounts') : t('receipts.accountHint')}
            disabled={moneyAccounts.length === 0}
            options={[
              { value: '', label: t('receipts.accountPlaceholder') },
              ...moneyAccounts.map((account) => ({
                value: account.id,
                label: `${account.code} · ${account.name}`,
              })),
            ]}
            {...register('accountId')}
            error={errors.accountId?.message}
          />
          <SelectField
            label={t('receipts.method')}
            options={PAYMENT_METHODS.map((value) => ({
              value,
              label: t(`receipts.methods.${value}`),
            }))}
            {...register('method')}
            error={errors.method?.message}
          />
          <TextField
            label={t('receipts.reference')}
            optional
            // How this kind of payment is usually written down: the cheque, the TrxID
            placeholder={t(`receipts.referencePlaceholders.${method}`)}
            {...register('reference')}
            error={errors.reference?.message}
          />
          <SelectField
            label={t('receipts.branch')}
            options={[
              { value: '', label: t('receipts.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <div className="sm:col-span-2">
            <TextField
              label={t('receipts.note')}
              optional
              placeholder={t('receipts.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title={t('receipts.applyTitle')} subtitle={t('receipts.applySubtitle')} />
          <Controller
            control={control}
            name="allocations"
            render={({ field }) => (
              <AllocationTable
                rows={rows}
                value={field.value}
                onChange={field.onChange}
                amount={amount}
                errors={errors.allocations}
                empty={
                  customerId === '' ? t('receipts.pickCustomer') : t('receipts.noOpenInvoices')
                }
              />
            )}
          />
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('receipts.saving') : t('receipts.save')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('receipts.saveHint')}</p>
      </form>
    </div>
  );
}
```

- **No draft.** Saving posts the receipt (15c.1), so this form is only for a new one, and its single button says
  "Save receipt" with the hint that it posts at once.
- **The money accounts come from `moneyAccountIds()`**, the contract's own list, the one the API checks against
  (`receipt_account_invalid`). The select offers exactly what the server accepts. With one account, it is picked.
  With none, the select is disabled and its hint says how to tick "Holds money".
- **"Record payment" on an invoice** starts with that invoice's customer, what it still owes as the amount, applied to
  it, and its branch. The cashier usually only checks the amount and saves.
- **Another customer clears the allocations.** The invoices belong to the old customer; the API would refuse them
  (`receipt_invoice_invalid`).
- **The reference's placeholder follows the method**: a cheque number for a cheque, a TrxID for bKash. The method
  decides nothing in the books; the placeholder only says what to write down.
- **The credit line under the customer** shows what they owe before the cashier takes the money.

### `components/receipt-view.tsx` (new) and `components/receipt-dialogs.tsx` (new)

```tsx
import { isZeroMoney, type Receipt, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Dialog, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PrintButton, ReceiptPrint } from './print-documents';
import { CustomerLink, DocumentNotice, ReceiptStatusPill, SalesBackLink } from './sales-parts';
import { useIsoDate, useTenantId } from './stock-parts';

// The two dialogs as a chunk of their own, loaded when one opens: they bring the form library, the
// money boxes (decimal.js) and the date picker, and inside this chunk they took it to 113 KB, over
// its 100 KB budget. Most visits only read the receipt.
const ApplyForm = lazy(async () => ({
  default: (await import('./receipt-dialogs')).ApplyForm,
}));
const VoidForm = lazy(async () => ({ default: (await import('./receipt-dialogs')).VoidForm }));

// A saved money receipt, read only: it is posted the moment it is saved. What can still change is
// where its money goes ("Apply money"), and a bounced cheque or a typing mistake is undone by
// "Void receipt". A voided one stays in the list with its number.
export function ReceiptView({ receipt, today }: { receipt: Receipt; today: string }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const canWrite = useCan()('sales.receipt.manage');
  const [dialog, setDialog] = useState<'apply' | 'void' | null>(null);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = receipt.status === 'posted';
  const unapplied = subtractMoney(receipt.amount, receipt.applied);
  const account = accounts?.find((item) => item.id === receipt.accountId);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/receipts" label={t('receipts.back')} />
      <PageHeader
        title={receipt.number}
        description={receipt.customer.name}
        actions={
          <>
            <ReceiptStatusPill status={receipt.status} />
            {posted && <PrintButton />}
          </>
        }
      />
      {receipt.voidDate !== null && (
        <DocumentNotice tone="neutral">
          {t('receipts.voidedNotice', {
            date: isoDate(receipt.voidDate),
            reason: receipt.voidReason ?? '',
          })}
        </DocumentNotice>
      )}
      {posted && !isZeroMoney(unapplied) && (
        <DocumentNotice tone="neutral">
          {t('receipts.unappliedNotice', { amount: money(unapplied) })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('receipts.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={receipt.customer} />
          </span>
        </div>
        <Fact label={t('receipts.date')} value={isoDate(receipt.date)} />
        <Fact label={t('receipts.amount')} value={money(receipt.amount)} />
        <Fact label={t('receipts.method')} value={t(`receipts.methods.${receipt.method}`)} />
        {receipt.reference !== null && (
          <Fact label={t('receipts.reference')} value={receipt.reference} />
        )}
        <Fact
          label={t('receipts.account')}
          value={account ? `${account.code} · ${account.name}` : '—'}
        />
        <Fact
          label={t('receipts.branch')}
          value={branches?.find((branch) => branch.id === receipt.branchId)?.name ?? '—'}
        />
        <EntryLinks label={t('receipts.entry')} entries={[receipt.entry]} none="" />
        {receipt.voidEntry !== null && (
          <EntryLinks label={t('receipts.voidEntry')} entries={[receipt.voidEntry]} none="" />
        )}
        {receipt.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('receipts.note')} value={receipt.note} />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title={t('receipts.invoicesTitle')} />
        {receipt.allocations.length === 0 ? (
          <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">{t('receipts.noAllocations')}</p>
        ) : (
          <ul className="mt-3 grid grid-cols-1">
            {receipt.allocations.map((allocation) => (
              <li key={allocation.invoiceId}>
                <Link
                  to="/invoices/$invoiceId"
                  params={{ invoiceId: allocation.invoiceId }}
                  className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-body-sm hover:bg-subtle"
                >
                  <span className="font-mono font-medium text-brand tabular-nums">
                    {allocation.invoiceNumber}
                  </span>
                  <span className="text-ink-3 tabular-nums">
                    {t('invoices.dueOn', { date: isoDate(allocation.dueDate) })}
                  </span>
                  <span className="ml-auto font-medium tabular-nums">
                    {money(allocation.amount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {posted && canWrite && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Away from "Apply money": voiding cannot be undone */}
          <div className="mr-auto">
            <Button
              variant="secondary"
              onClick={() => {
                setDialog('void');
              }}
            >
              {t('receipts.void')}
            </Button>
          </div>
          <Button
            onClick={() => {
              setDialog('apply');
            }}
          >
            {t('receipts.apply')}
          </Button>
        </div>
      )}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <Suspense fallback={null}>
          {dialog === 'apply' && (
            <ApplyForm
              receipt={receipt}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
          {dialog === 'void' && (
            <VoidForm
              receipt={receipt}
              today={today}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && <ReceiptPrint receipt={receipt} />}
    </div>
  );
}
```

- **Two notices.** A voided receipt says when and why. A posted receipt with money not applied says how much: it
  counts as an advance until someone applies it, and the notice is the reminder.
- **The journal entry and its reversal** link to the journal for someone who reads it (`EntryLinks`, step 14). A
  posted receipt always has an entry, so the "none" text is never shown.
- **"Void receipt" on the left, "Apply money" on the right.** Voiding cannot be undone, so it sits away from the
  everyday action.
- **The two dialogs are a lazy chunk.** They bring the form library, the money boxes and the date picker, and with
  them inside, this chunk was 113 KB. Most visits only read the receipt; the dialogs load when one opens.
- **No print sheet for a voided receipt.** Its money comes off the invoices, so the slip would say the whole amount is
  an advance, which is wrong.

```tsx
import { Calendar03Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  type Receipt,
  receiptAllocationsInputSchema,
  type ReceiptAllocationsFormValues,
  routes,
  voidReceiptInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  Input,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo } from 'react';
import { Controller, type Path, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { allocationRows } from '../lib/invoices';
import { rowPath } from '../lib/products';
import { openInvoicesQuery } from '../lib/queries';
import { AllocationTable } from './allocation-table';
import { useSalesRefresh } from './sales-parts';
import { useTenantId } from './stock-parts';

// The receipt page's two dialogs (step 15c), a lazy chunk of their own (receipt-view.tsx says why)

// The void date's picker as a chunk of its own: with the popover inside, the dialogs stood at
// 106 KB of their 100 KB budget
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// "Apply money": the receipt's money over the customer's invoices again, the whole list at once
// (an advance that came before its invoice, or money put on the wrong invoice)
export function ApplyForm({ receipt, onDone }: { receipt: Receipt; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const { data: open } = useQuery(openInvoicesQuery(tenantId, receipt.customer.id));
  // Its own invoices too: one it paid in full is not open any more
  const rows = useMemo(
    () => allocationRows(open ?? [], receipt.allocations),
    [open, receipt.allocations],
  );
  const {
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ReceiptAllocationsFormValues>({
    resolver: zodResolver(receiptAllocationsInputSchema, { error: contractErrorMap }),
    defaultValues: {
      version: receipt.version,
      allocations: receipt.allocations.map((allocation) => ({
        invoiceId: allocation.invoiceId,
        amount: plainQuantity(allocation.amount),
      })),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.receipts.allocate, {
        params: { id: receipt.id },
        body: values,
      });
      await refresh();
      toast(t('receipts.allocated', { number: saved.number }));
      onDone();
    } catch (error) {
      const count = getValues('allocations').length;
      const names: Path<ReceiptAllocationsFormValues>[] = [
        'allocations',
        ...Array.from({ length: count }, (_, index) => [
          rowPath('allocations', index, 'invoiceId'),
          rowPath('allocations', index, 'amount'),
        ]).flat(),
      ];
      applyApiError(error, names, setError);
    }
  });

  return (
    <DialogContent
      title={t('receipts.applyDialogTitle', { number: receipt.number })}
      description={t('receipts.applySubtitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="apply-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('receipts.applySave')}
          </Button>
        </>
      }
    >
      <form id="apply-form" noValidate onSubmit={(event) => void onSubmit(event)}>
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* The table's own padding is a card's; the dialog has its own, so it runs edge to edge */}
        <div className="-mx-[18px] sm:-mx-6">
          <Controller
            control={control}
            name="allocations"
            render={({ field }) => (
              <AllocationTable
                rows={rows}
                value={field.value}
                onChange={field.onChange}
                amount={receipt.amount}
                errors={errors.allocations}
                empty={t('receipts.noOpenInvoices')}
              />
            )}
          />
        </div>
      </form>
    </DialogContent>
  );
}

// "Void receipt": the date the money turned out not to be there, and why
export function VoidForm({
  receipt,
  today,
  onDone,
}: {
  receipt: Receipt;
  today: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useSalesRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(voidReceiptInputSchema, { error: contractErrorMap }),
    defaultValues: { version: receipt.version, date: today, reason: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.receipts.void, { params: { id: receipt.id }, body: values });
      await refresh();
      toast(t('receipts.voided', { number: saved.number }));
      onDone();
    } catch (error) {
      applyApiError(error, ['date', 'reason'], setError);
    }
  });

  return (
    <DialogContent
      title={t('receipts.voidTitle', { number: receipt.number })}
      description={t('receipts.voidBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('receipts.keepReceipt')}</Button>
          </DialogClose>
          <Button type="submit" form="void-form" disabled={isSubmitting}>
            {t('receipts.confirmVoid')}
          </Button>
        </>
      }
    >
      <form
        id="void-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <FormField
          control={control}
          name="date"
          label={t('receipts.voidDate')}
          hint={t('receipts.voidDateHint')}
        >
          {(field) => (
            <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
              <DatePicker {...field} />
            </Suspense>
          )}
        </FormField>
        <TextField
          label={t('receipts.voidReason')}
          placeholder={t('receipts.voidReasonPlaceholder')}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}
```

- **`ApplyForm` sends the whole list**, as the person left it (15c.3 replaces all of the receipt's allocations). Its
  rows include the receipt's own invoices (`allocationRows()` with `mine`), so a payment can move from one invoice to
  another.
- **`plainQuantity()` on the saved amounts.** The API sends "1500.0000"; the box shows 2 decimals, and a value with
  4 would look changed the moment the box loses focus.
- **The table runs edge to edge in the dialog** (`-mx-[18px] sm:-mx-6`, the dialog's own padding). The table's rows
  have a card's padding, and inside the dialog's padding they would be indented twice.
- **`VoidForm`** asks for the void date (the day the cheque bounced) and the reason; the server checks that the date
  is not before the receipt's (`receipt_void_date`). The date picker is lazy too: with the popover inside, this chunk
  was 106 KB.

### The receipt pages: `routes/receipt.tsx`, `routes/receipts.tsx` (new)

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { paymentStatusOf } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import {
  accountsQuery,
  branchesQuery,
  customerQuery,
  invoiceQuery,
  receiptQuery,
} from '../lib/queries';

const ReceiptForm = lazy(async () => ({
  default: (await import('../components/receipt-form')).ReceiptForm,
}));
const ReceiptView = lazy(async () => ({
  default: (await import('../components/receipt-view')).ReceiptView,
}));

// The chart (for the money accounts) and the branches: the form's defaults are worked out from
// them once, as it opens
function useReady(): boolean {
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  return accounts !== undefined && branches !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/receipts" label={t('receipts.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('receipts.title')} description={message} />
    </div>
  );
}

// A new receipt. "Record payment" on an invoice comes with ?customerId= and ?invoiceId=, on a
// customer's page with ?customerId= alone.
export function NewReceiptPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canWrite = useCan()('sales.receipt.manage');
  const today = useToday();
  const ready = useReady();
  const { customerId = '', invoiceId = '' } = useSearch({ strict: false });
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '' && invoiceId === '',
  });
  const invoice = useQuery({
    ...invoiceQuery(tenantId, invoiceId),
    enabled: invoiceId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/receipts" label={t('receipts.back')} />
        <p className="text-body-sm text-ink-3">{t('receipts.cantWrite')}</p>
      </div>
    );
  }
  if (invoice.isError) return <CantFind message={t('invoices.notFound')} />;
  if (customer.isError) return <CantFind message={t('customers.notFound')} />;
  if (!ready || (invoiceId !== '' && !invoice.data)) return null;
  if (customerId !== '' && invoiceId === '' && !customer.data) return null;
  // Only an invoice that still owes something starts the form; one paid since (or a draft) is
  // left out, and the form starts with its customer alone
  const owing =
    invoice.data?.status === 'posted' && paymentStatusOf(invoice.data) !== 'paid'
      ? invoice.data
      : null;
  return (
    <Suspense fallback={null}>
      <ReceiptForm
        customer={invoice.data?.customer ?? customer.data ?? null}
        invoice={owing}
        today={today}
      />
    </Suspense>
  );
}

export function ReceiptPage() {
  const { t } = useLocale();
  const { receiptId = '' } = useParams({ strict: false });
  const today = useToday();
  const { data: receipt, isError } = useQuery({
    ...receiptQuery(useTenantId(), receiptId),
    enabled: receiptId !== '',
  });
  if (isError) return <CantFind message={t('receipts.notFound')} />;
  if (!receipt) return null;
  return (
    <Suspense fallback={null}>
      <ReceiptView receipt={receipt} today={today} />
    </Suspense>
  );
}
```

- **Only an invoice that still owes something starts the form.** A link to "Record payment" may be old: the invoice
  may have been paid since. Then the form starts with its customer alone, instead of applying money to an invoice
  the API would refuse.
- **The customer query runs only without an invoice.** With one, the invoice brings its customer.
- **A receipt page has no form.** A receipt is never a draft, so the route always shows the view.

```tsx
import { MoneyReceive02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  RECEIPT_STATUSES,
  type ReceiptStatus,
  type ReceiptSummary,
  subtractMoney,
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

import { CustomerPicker } from '../components/customer-picker';
import { ReceiptStatusPill } from '../components/sales-parts';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { receiptsQuery } from '../lib/queries';

const column = dataTableColumns<ReceiptSummary>();

export function ReceiptsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.receipt.manage');
  const isoDate = useIsoDate();
  const [status, setStatus] = useState<ReceiptStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    receiptsQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('receipts.columns.number'),
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
        column.accessor((receipt) => receipt.customer.name, {
          id: 'customer',
          header: t('receipts.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('method', {
          header: t('receipts.columns.method'),
          enableSorting: false,
          meta: { card: 'detail' },
          // The cheque number or the TrxID under the method: what a cashier looks for
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span>{t(`receipts.methods.${row.original.method}`)}</span>
              {row.original.reference !== null && (
                <span className="truncate text-caption text-ink-3">{row.original.reference}</span>
              )}
            </span>
          ),
        }),
        column.accessor('amount', {
          header: t('receipts.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor((receipt) => subtractMoney(receipt.amount, receipt.applied), {
          id: 'unapplied',
          header: t('receipts.columns.unapplied'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A voided receipt holds no money: nothing is waiting to be applied
          cell: ({ row, getValue }) =>
            row.original.status === 'voided' ? (
              <span className="text-ink-3">—</span>
            ) : (
              format.money(getValue())
            ),
        }),
        column.accessor('status', {
          header: t('receipts.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <ReceiptStatusPill status={getValue()} />,
        }),
      ]),
    [t, format, isoDate],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/receipts/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('receipts.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('receipts.title')}
        description={t('receipts.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="receipts-customer"
            aria-label={t('receipts.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('receipts.show')}
          value={status}
          options={[
            { value: '', label: t('receipts.all') },
            ...RECEIPT_STATUSES.map((value) => ({
              value,
              label: t(`receipts.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('receipts.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('receipts.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/receipts/$receiptId', params: { receiptId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={MoneyReceive02Icon}
              title={t('receipts.emptyTitle')}
              description={t('receipts.emptyBody')}
              action={write}
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

- **The reference under the method.** A cashier looks for a receipt by its cheque number or TrxID.
- **"Not applied" is a dash on a voided receipt.** Its money is gone from the books, so nothing waits to be applied.

### The printed page: `components/print-documents.tsx` (new)

```tsx
import { PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Delivery,
  type DocumentTotals,
  defaultLineDescription,
  type Invoice,
  isZeroMoney,
  plainQuantity,
  type Quotation,
  type Receipt,
  type SalesLine,
  type SalesOrder,
  subtractMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, PrintBlock, type PrintMeta, PrintSheet } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { amountDue } from '../lib/invoices';
import { settingsQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { useIsoDate, useQuantity, useTenantId } from './stock-parts';

// The printed quotation, order, challan, invoice and money receipt (step 15c): one A4 layout, the
// browser's own Print (or Save as PDF), so it works offline and needs no PDF service. Each page
// renders its sheet next to itself; PrintSheet keeps it hidden on the screen and alone on paper.

// "Print" in a document's header: the browser prints the sheet of the page
export function PrintButton() {
  const { t } = useLocale();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        window.print();
      }}
    >
      <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
      {t('print.print')}
    </Button>
  );
}

// The company at the top of every sheet: its legal name (the name on the trade licence) or the
// workspace's, the address one line per line, the BIN (the NBR asks for it on a VAT invoice), the
// phone, and the logo. null until the settings arrive.
function useCompany(): { company: string; lines: string[]; logo: ReactNode } | null {
  const { t } = useLocale();
  const settings = useQuery(settingsQuery(useTenantId())).data;
  if (!settings) return null;
  return {
    company: settings.legalName ?? settings.companyName,
    lines: [
      ...(settings.address?.split('\n') ?? []),
      ...(settings.bin === null ? [] : [t('print.bin', { bin: settings.bin })]),
      ...(settings.phone === null ? [] : [t('print.phone', { phone: settings.phone })]),
    ],
    logo:
      settings.logo === null ? undefined : (
        // Decoration next to the name, which says the same: an empty alt
        <img src={settings.logo.url} alt="" className="h-12 w-auto max-w-32 object-contain" />
      ),
  };
}

// The sheet with the company filled in, and the time it was printed at the foot
function Sheet({
  title,
  meta,
  signatures,
  children,
}: {
  title: string;
  meta: (PrintMeta | null)[];
  signatures: string[];
  children: ReactNode;
}) {
  const { t, format } = useLocale();
  const company = useCompany();
  if (!company) return null;
  return (
    <PrintSheet
      logo={company.logo}
      company={company.company}
      companyLines={company.lines}
      title={title}
      meta={meta.filter((item): item is PrintMeta => item !== null)}
      signatures={signatures}
      footer={t('print.printedAt', { date: format.date(new Date()) })}
    >
      {children}
    </PrintSheet>
  );
}

// The customer: name and code, then an address as it was saved, one part per line
function PartyBlock({
  label,
  name,
  code,
  address,
}: {
  label: string;
  name: string;
  code?: string;
  address?: string | null;
}) {
  return (
    <PrintBlock label={label}>
      <p className="font-medium">{name}</p>
      {code !== undefined && <p className="font-mono text-caption text-ink-2">{code}</p>}
      {address !== null && address !== undefined && (
        <p className="whitespace-pre-line text-ink-2">{address}</p>
      )}
    </PrintBlock>
  );
}

// A sales line on paper, with what a pharmacy or an electronics shop asks to see under it: the
// batch and its expiry, the serial numbers, the challan it left on
interface PricedLine extends SalesLine {
  lotNumber?: string | null;
  expiresOn?: string | null;
  serialNumbers?: string[];
  deliveryNumber?: string | null;
}

const CELL = 'border-b border-line px-2 py-1.5 align-top';
const HEAD = 'border-b border-ink px-2 py-1.5 text-left text-caption font-medium text-ink-2';
```

- **The browser's own Print.** "Print" calls `window.print()`; the person prints or saves a PDF. It works offline and
  needs no PDF service (your decision 4). `PrintSheet` (15c.5) keeps the sheet hidden on the screen and alone on the
  paper.
- **`useCompany()`** prints the legal name when there is one (the name on the trade licence), else the workspace's.
  The address is printed one line per line, then the BIN and the phone. The BIN is on every document because the NBR
  asks for it on a VAT invoice.
- **The logo's `alt` is empty.** The company's name is printed next to it, so a screen reader would read the name
  twice.
- **`Sheet` waits for the settings** and fills in the company and the time it was printed. "Printed 8 Oct 2026" at the
  foot tells which paper copy is the latest.
- **`PartyBlock`** prints the customer and an address as it was saved on the document, with its line breaks.

```tsx
function PricedLines({
  lines,
  totals,
  pricesIncludeVat,
  after,
}: {
  lines: readonly PricedLine[];
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
  // Rows under the total: what an invoice was paid and still asks for
  after?: { label: string; value: string }[];
}) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const isoDate = useIsoDate();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const sums = [
    ...(isZeroMoney(totals.discount)
      ? []
      : [{ label: t('salesLines.lineDiscounts'), value: `−${money(totals.discount)}` }]),
    { label: t('salesLines.net'), value: money(totals.net) },
    { label: t('salesLines.vat'), value: money(totals.vat) },
  ];
  return (
    <>
      <table className="w-full border-collapse text-caption">
        {/* <thead> repeats at the top of every printed page of a long invoice */}
        <thead>
          <tr>
            <th scope="col" className={HEAD}>
              {t('print.columns.number')}
            </th>
            <th scope="col" className={HEAD}>
              {t('print.columns.item')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.quantity')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.price')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.discount')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.vat')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const notes = [
              ...(line.description === defaultLineDescription(line) ? [] : [variantName(line)]),
              ...(line.lotNumber === null || line.lotNumber === undefined
                ? []
                : [
                    [
                      t('print.batch', { lot: line.lotNumber }),
                      ...(line.expiresOn === null || line.expiresOn === undefined
                        ? []
                        : [t('print.expires', { date: isoDate(line.expiresOn) })]),
                    ].join(', '),
                  ]),
              ...(line.serialNumbers === undefined || line.serialNumbers.length === 0
                ? []
                : [t('print.serials', { serials: line.serialNumbers.join(', ') })]),
              ...(line.deliveryNumber === null || line.deliveryNumber === undefined
                ? []
                : [t('invoices.fromChallan', { number: line.deliveryNumber })]),
            ];
            return (
              // break-inside-avoid: a line and its notes stay on one page
              <tr key={line.id} className="break-inside-avoid">
                <td className={cn(CELL, 'tabular-nums')}>{index + 1}</td>
                <td className={CELL}>
                  <span className="block text-body-sm text-ink">{line.description}</span>
                  <span className="block font-mono text-ink-3">{line.sku}</span>
                  {notes.map((note) => (
                    <span key={note} className="block text-ink-2">
                      {note}
                    </span>
                  ))}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {quantity(line.quantity, line.unitId)}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {money(line.unitPrice)}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {isZeroMoney(line.discount)
                    ? '—'
                    : line.discountType === 'percent'
                      ? `${format.number(plainQuantity(line.discount), 2)}%`
                      : money(line.discount)}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {line.taxRate.name}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {money(pricesIncludeVat ? line.total : line.net)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex break-inside-avoid items-end justify-between gap-6">
        <p className="text-caption text-ink-2">
          {pricesIncludeVat ? t('salesLines.pricesWithVat') : t('salesLines.pricesWithoutVat')}
        </p>
        <dl className="grid min-w-64 grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
          {sums.map((sum) => (
            <div key={sum.label} className="contents">
              <dt className="text-ink-2">{sum.label}</dt>
              <dd className="text-right">{sum.value}</dd>
            </div>
          ))}
          <dt className="border-t border-ink pt-1 font-medium">{t('salesLines.total')}</dt>
          <dd className="border-t border-ink pt-1 text-right font-medium">{money(totals.total)}</dd>
          {after?.map((sum) => (
            <div key={sum.label} className="contents">
              <dt className="text-ink-2">{sum.label}</dt>
              <dd className="text-right">{sum.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

function Note({ note }: { note: string | null }) {
  const { t } = useLocale();
  if (note === null) return null;
  return (
    <PrintBlock label={t('salesOrders.note')}>
      <p className="whitespace-pre-line">{note}</p>
    </PrintBlock>
  );
}
```

- **`PricedLines` is a plain table** with 1px rules and no colour fills: it prints well on any printer, even in black
  and white.
- **`<thead>` repeats on every page** of a long invoice; the browser does that for a table header by itself.
- **`cn(HEAD, 'text-right')`, not `` `${HEAD} text-right` ``.** `HEAD` already says `text-left`. Glued together as a
  string, both classes are on the cell, and which one wins depends on the order Tailwind writes them into the CSS,
  not on the order in the string. `cn()` (tailwind-merge, CLAUDE.md "Class names") drops `text-left`, so the money
  columns are right-aligned for sure. (The first version glued them; 15c.8 found it.)
- **`break-inside-avoid` on each row** keeps a line and its notes (batch, expiry, serial numbers, challan) on one page.
- **The notes under each line** are what a pharmacy and an electronics shop must print: the batch and its expiry, the
  serial numbers, and on an invoice the challan the goods left on. A line whose description is not the product's
  name also prints the product, so the customer knows what it is.
- **The VAT column prints the rate's name** ("VAT 15%"), the rate the line keeps. The amount column follows the
  document's price setting, like the page.
- **`after`** adds what was paid and what is still due under an invoice's total, when something was paid.

```tsx
export function QuotationPrint({ quotation }: { quotation: Quotation }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  return (
    <Sheet
      title={t('print.titles.quotation')}
      meta={[
        { label: t('print.number'), value: quotation.number },
        { label: t('print.date'), value: isoDate(quotation.date) },
        quotation.validUntil === null
          ? null
          : { label: t('print.validUntil'), value: isoDate(quotation.validUntil) },
      ]}
      signatures={[t('print.signatures.preparedBy'), t('print.signatures.authorised')]}
    >
      <PartyBlock
        label={t('print.customer')}
        name={quotation.customer.name}
        code={quotation.customer.code}
      />
      <PricedLines
        lines={quotation.lines}
        totals={quotation}
        pricesIncludeVat={quotation.pricesIncludeVat}
      />
      <Note note={quotation.note} />
    </Sheet>
  );
}

export function SalesOrderPrint({ order }: { order: SalesOrder }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  return (
    <Sheet
      title={t('print.titles.salesOrder')}
      meta={[
        { label: t('print.number'), value: order.number ?? '' },
        { label: t('print.date'), value: isoDate(order.date) },
        order.deliveryDate === null
          ? null
          : { label: t('print.deliveryDate'), value: isoDate(order.deliveryDate) },
        order.customerReference === null
          ? null
          : { label: t('print.customerReference'), value: order.customerReference },
      ]}
      signatures={[t('print.signatures.customer'), t('print.signatures.authorised')]}
    >
      <div className="grid grid-cols-2 gap-6">
        <PartyBlock
          label={t('print.customer')}
          name={order.customer.name}
          code={order.customer.code}
        />
        {order.shippingAddress !== null && (
          <PartyBlock
            label={t('print.shipTo')}
            name={order.customer.name}
            address={order.shippingAddress}
          />
        )}
      </div>
      <PricedLines lines={order.lines} totals={order} pricesIncludeVat={order.pricesIncludeVat} />
      <Note note={order.note} />
    </Sheet>
  );
}

// The challan goes with the truck: what left and how much, with the batch and serial numbers, and
// no prices (the invoice prices it)
export function DeliveryPrint({ delivery }: { delivery: Delivery }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  return (
    <Sheet
      title={t('print.titles.delivery')}
      meta={[
        { label: t('print.number'), value: delivery.number ?? '' },
        { label: t('print.date'), value: isoDate(delivery.date) },
        delivery.order === null
          ? null
          : { label: t('print.order'), value: delivery.order.number ?? '' },
        delivery.vehicle === null ? null : { label: t('print.vehicle'), value: delivery.vehicle },
      ]}
      signatures={[
        t('print.signatures.receivedBy'),
        t('print.signatures.preparedBy'),
        t('print.signatures.authorised'),
      ]}
    >
      <div className="grid grid-cols-2 gap-6">
        <PartyBlock
          label={t('print.customer')}
          name={delivery.customer.name}
          code={delivery.customer.code}
        />
        {delivery.shippingAddress !== null && (
          <PartyBlock
            label={t('print.shipTo')}
            name={delivery.customer.name}
            address={delivery.shippingAddress}
          />
        )}
      </div>
      <table className="w-full border-collapse text-caption">
        <thead>
          <tr>
            <th scope="col" className={HEAD}>
              {t('print.columns.number')}
            </th>
            <th scope="col" className={HEAD}>
              {t('print.columns.item')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.quantity')}
            </th>
          </tr>
        </thead>
        <tbody>
          {delivery.lines.map((line, index) => (
            <tr key={line.id} className="break-inside-avoid">
              <td className={cn(CELL, 'tabular-nums')}>{index + 1}</td>
              <td className={CELL}>
                <span className="block text-body-sm text-ink">{variantName(line)}</span>
                <span className="block font-mono text-ink-3">{line.sku}</span>
                {line.lotNumber !== null && (
                  <span className="block text-ink-2">
                    {t('print.batch', { lot: line.lotNumber })}
                    {line.expiresOn !== null &&
                      `, ${t('print.expires', { date: isoDate(line.expiresOn) })}`}
                  </span>
                )}
                {line.serialNumbers.length > 0 && (
                  <span className="block break-all text-ink-2">
                    {t('print.serials', { serials: line.serialNumbers.join(', ') })}
                  </span>
                )}
              </td>
              <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                {quantity(line.quantity, line.unitId)}
                {line.unitId !== line.baseUnitId && (
                  <span className="block text-ink-3">
                    {t('stockLines.equals', {
                      quantity: quantity(line.baseQuantity, line.baseUnitId),
                    })}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Note note={delivery.note} />
    </Sheet>
  );
}

export function InvoicePrint({ invoice }: { invoice: Invoice }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const orders = invoice.orders.flatMap((order) => (order.number === null ? [] : [order.number]));
  return (
    <Sheet
      title={t('print.titles.invoice')}
      meta={[
        { label: t('print.number'), value: invoice.number ?? '' },
        { label: t('print.date'), value: isoDate(invoice.date) },
        { label: t('print.dueDate'), value: isoDate(invoice.dueDate) },
        invoice.customerReference === null
          ? null
          : { label: t('print.customerReference'), value: invoice.customerReference },
        orders.length === 0 ? null : { label: t('print.order'), value: orders.join(', ') },
      ]}
      signatures={[t('print.signatures.customer'), t('print.signatures.authorised')]}
    >
      <PartyBlock
        label={t('print.billTo')}
        name={invoice.customer.name}
        code={invoice.customer.code}
        address={invoice.billingAddress}
      />
      <PricedLines
        lines={invoice.lines}
        totals={invoice}
        pricesIncludeVat={invoice.pricesIncludeVat}
        // What is paid by the day it is printed, and what is still due
        after={
          isZeroMoney(invoice.amountPaid)
            ? []
            : [
                { label: t('invoices.paid'), value: money(invoice.amountPaid) },
                { label: t('invoices.due'), value: money(amountDue(invoice)) },
              ]
        }
      />
      <Note note={invoice.note} />
    </Sheet>
  );
}

// The slip a cashier hands over: who paid, how much, how, and which invoices it paid
export function ReceiptPrint({ receipt }: { receipt: Receipt }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const advance = subtractMoney(receipt.amount, receipt.applied);
  return (
    <Sheet
      title={t('print.titles.receipt')}
      meta={[
        { label: t('print.number'), value: receipt.number },
        { label: t('print.date'), value: isoDate(receipt.date) },
      ]}
      signatures={[t('print.signatures.receivedBy'), t('print.signatures.authorised')]}
    >
      <div className="grid grid-cols-2 gap-6">
        <PartyBlock
          label={t('print.receivedFrom')}
          name={receipt.customer.name}
          code={receipt.customer.code}
        />
        <PrintBlock label={t('print.amountReceived')}>
          <p className="text-h2 tabular-nums">{money(receipt.amount)}</p>
        </PrintBlock>
        <PrintBlock label={t('print.paidBy')}>
          <p>{t(`receipts.methods.${receipt.method}`)}</p>
        </PrintBlock>
        {receipt.reference !== null && (
          <PrintBlock label={t('print.reference')}>
            <p>{receipt.reference}</p>
          </PrintBlock>
        )}
      </div>
      {receipt.allocations.length > 0 && (
        <PrintBlock label={t('print.appliedTo')}>
          <table className="w-full border-collapse text-caption">
            <thead>
              <tr>
                <th scope="col" className={HEAD}>
                  {t('receipts.allocationColumns.invoice')}
                </th>
                <th scope="col" className={HEAD}>
                  {t('receipts.allocationColumns.date')}
                </th>
                <th scope="col" className={cn(HEAD, 'text-right')}>
                  {t('receipts.allocationColumns.total')}
                </th>
                <th scope="col" className={cn(HEAD, 'text-right')}>
                  {t('receipts.allocationColumns.amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {receipt.allocations.map((allocation) => (
                <tr key={allocation.invoiceId} className="break-inside-avoid">
                  <td className={cn(CELL, 'font-mono tabular-nums')}>{allocation.invoiceNumber}</td>
                  <td className={cn(CELL, 'tabular-nums')}>{isoDate(allocation.invoiceDate)}</td>
                  <td className={cn(CELL, 'text-right tabular-nums')}>
                    {money(allocation.invoiceTotal)}
                  </td>
                  <td className={cn(CELL, 'text-right tabular-nums')}>
                    {money(allocation.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PrintBlock>
      )}
      {!isZeroMoney(advance) && (
        <p className="tabular-nums">
          {t('print.advance')}: {money(advance)}
        </p>
      )}
      <Note note={receipt.note} />
    </Sheet>
  );
}
```

- **One function per document**, each with its own title, details and signature lines. A quotation has a validity
  date; an order the delivery date and the buyer's reference; a challan its order and vehicle and no prices (the
  invoice prices it); an invoice the due date, the buyer's reference and its orders; a receipt who paid, how much, how,
  and which invoices it paid.
- **The challan prints what left and how much**, with the base quantity under a pack ("= 72 pcs"), the way the store
  keeper counts it on the truck.
- **The signature lines** are the ones Bangladeshi offices use: the customer's (an order, an invoice), "Received by"
  (the challan, the receipt), "Prepared by" and "Authorised signature".
- **The receipt prints the advance** when not all of the money went to invoices, so the customer's slip shows it too.

### Deliveries: `routes/deliveries.tsx`, `components/delivery-view.tsx`, `components/stock-lines-table.tsx`

```diff
@@ -1,6 +1,8 @@
 import { DeliveryTruck01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
+  DELIVERY_INVOICE_FILTERS,
+  type DeliveryInvoiceFilter,
   type DeliverySummary,
   STOCK_DOCUMENT_STATUSES,
   type StockDocumentStatus,
@@ -19,7 +21,7 @@ import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
 import { CustomerPicker } from '../components/customer-picker';
-import { DeliveryStatusPill } from '../components/sales-parts';
+import { DeliveryStatusPill, InvoiceStatePill } from '../components/sales-parts';
 import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
 import { deliveriesQuery } from '../lib/queries';
@@ -34,8 +36,10 @@ export function DeliveriesPage() {
   const { byId } = useWarehouses();
   const [status, setStatus] = useState<StockDocumentStatus | ''>('');
   const [customerId, setCustomerId] = useState('');
+  // Step 15c: "To invoice" is the accountant's queue: posted challans with a line not billed yet
+  const [invoice, setInvoice] = useState<DeliveryInvoiceFilter | ''>('');
   const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
-    deliveriesQuery(useTenantId(), { status, customerId }),
+    deliveriesQuery(useTenantId(), { status, customerId, invoice }),
   );
   const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
   const loadMore = useCallback(() => {
@@ -106,7 +110,13 @@ export function DeliveriesPage() {
           header: t('deliveries.columns.status'),
           enableSorting: false,
           meta: { card: 'trailing' },
-          cell: ({ getValue }) => <DeliveryStatusPill status={getValue()} />,
+          // A posted challan also says how much of it is billed; a draft cannot be billed yet
+          cell: ({ row, getValue }) => (
+            <span className="inline-flex flex-wrap gap-1.5">
+              <DeliveryStatusPill status={getValue()} />
+              {getValue() === 'posted' && <InvoiceStatePill state={row.original.invoiceState} />}
+            </span>
+          ),
         }),
       ]),
     [t, isoDate, byId],
@@ -149,6 +159,18 @@ export function DeliveriesPage() {
           ]}
           onChange={setStatus}
         />
+        <SegmentedControl
+          label={t('deliveries.billing')}
+          value={invoice}
+          options={[
+            { value: '', label: t('deliveries.all') },
+            ...DELIVERY_INVOICE_FILTERS.map((value) => ({
+              value,
+              label: t(`deliveries.invoiceFilters.${value}`),
+            })),
+          ]}
+          onChange={setInvoice}
+        />
       </div>
       {isError && <p className="text-body-sm text-crit">{t('deliveries.loadFailed')}</p>}
       {rows && (
```

- **A billing filter next to the status filter**: All, To invoice, Invoiced. "To invoice" is the accountant's queue,
  the API's `invoice` query (15c.1).
- **The billing pill only for a posted challan.** A draft cannot be billed, so "Not invoiced" on it would be noise.

```diff
@@ -1,27 +1,41 @@
+import { Invoice03Icon } from '@hugeicons/core-free-icons';
+import { HugeiconsIcon } from '@hugeicons/react';
 import type { Delivery } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { Card, PageHeader } from '@omnivo/ui';
-import { Link } from '@tanstack/react-router';
+import { Button, Card, CardHeader, PageHeader } from '@omnivo/ui';
+import { Link, useNavigate } from '@tanstack/react-router';
 
+import { useCan } from '../lib/permissions';
 import { Fact } from './adjustment-view';
 import { EntryLinks } from './entry-links';
-import { CustomerLink, DeliveryStatusPill, SalesBackLink } from './sales-parts';
+import { DeliveryPrint, PrintButton } from './print-documents';
+import { CustomerLink, DeliveryStatusPill, InvoiceStatePill, SalesBackLink } from './sales-parts';
 import { StockLinesTable } from './stock-lines-table';
 import { useIsoDate, useWarehouses, warehouseLabel } from './stock-parts';
 
 // A posted delivery (or a draft for someone who may not write deliveries), read only. A posted one
-// never changes: goods that come back are a return (15d).
+// never changes: goods that come back are a return (15d). Step 15c: what bills it, "Make invoice"
+// while some of it is not billed, and the printed challan.
 export function DeliveryView({ delivery }: { delivery: Delivery }) {
   const { t, format } = useLocale();
+  const navigate = useNavigate();
   const isoDate = useIsoDate();
   const { byId } = useWarehouses();
+  const canBill = useCan()('sales.invoice.manage');
+  const posted = delivery.status === 'posted';
   return (
     <div className="grid max-w-6xl grid-cols-1 gap-5">
       <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
       <PageHeader
         title={delivery.number ?? t('deliveries.draftTitle')}
         description={delivery.customer.name}
-        actions={<DeliveryStatusPill status={delivery.status} />}
+        actions={
+          <>
+            <DeliveryStatusPill status={delivery.status} />
+            {posted && <InvoiceStatePill state={delivery.invoiceState} />}
+            {posted && <PrintButton />}
+          </>
+        }
       />
       <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
         <div className="grid min-w-0 gap-0.5">
@@ -83,6 +97,50 @@ export function DeliveryView({ delivery }: { delivery: Delivery }) {
         )}
       </Card>
       <StockLinesTable lines={delivery.lines} />
+      {posted && (
+        <Card className="overflow-hidden">
+          <CardHeader
+            title={t('deliveries.invoicesTitle')}
+            subtitle={t('deliveries.invoicesSubtitle')}
+          />
+          {delivery.invoices.length === 0 ? (
+            <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">
+              {t('deliveries.notInvoicedYet')}
+            </p>
+          ) : (
+            <ul className="mt-3 grid grid-cols-1">
+              {delivery.invoices.map((invoice) => (
+                <li key={invoice.id}>
+                  <Link
+                    to="/invoices/$invoiceId"
+                    params={{ invoiceId: invoice.id }}
+                    className="flex items-center gap-3 border-t border-line px-5 py-3 text-body-sm hover:bg-subtle"
+                  >
+                    {/* A posted invoice: it has a number */}
+                    <span className="font-mono font-medium text-brand tabular-nums">
+                      {invoice.number ?? ''}
+                    </span>
+                  </Link>
+                </li>
+              ))}
+            </ul>
+          )}
+        </Card>
+      )}
+      {/* The accountant's next step: bill what is left on the challan */}
+      {posted && canBill && delivery.invoiceState !== 'invoiced' && (
+        <div className="flex justify-end">
+          <Button
+            onClick={() =>
+              void navigate({ to: '/invoices/new', search: { deliveryId: delivery.id } })
+            }
+          >
+            <HugeiconsIcon icon={Invoice03Icon} size={17} strokeWidth={1.5} />
+            {t('deliveries.makeInvoice')}
+          </Button>
+        </div>
+      )}
+      {posted && <DeliveryPrint delivery={delivery} />}
     </div>
   );
 }
```

- **"Make invoice" while some of the challan is not billed**, for someone with `sales.invoice.manage`. It opens a new
  invoice with this challan's unbilled lines (`?deliveryId=`).
- **The invoices that bill it**, linked. A posted challan with none yet says "Not billed yet".
- **Print** in the header, and the challan's sheet, only for a posted challan: a draft has no number.

```diff
@@ -1,4 +1,4 @@
-import { Alert02Icon } from '@hugeicons/core-free-icons';
+import { Alert02Icon, Invoice02Icon } from '@hugeicons/core-free-icons';
 import {
   type AdjustmentLine,
   compareQuantity,
@@ -113,8 +113,16 @@ export function StockLinesTable({
                       {line.serialNumbers.join(', ')}
                     </span>
                   )}
-                  {line.lotNumber === null && line.serialNumbers.length === 0 && (
-                    <span className="text-ink-3">—</span>
+                  {line.lotNumber === null &&
+                    line.serialNumbers.length === 0 &&
+                    !('invoiced' in line && line.invoiced) && <span className="text-ink-3">—</span>}
+                  {/* Step 15c: a challan line a posted invoice bills (it is billed whole) */}
+                  {'invoiced' in line && line.invoiced && (
+                    <span className="mt-1 block">
+                      <Pill tone="good" icon={Invoice02Icon}>
+                        {t('deliveries.lineInvoiced')}
+                      </Pill>
+                    </span>
                   )}
                 </td>
                 {received && (
```

- **An "Invoiced" pill on each billed challan line.** An invoice bills lines whole, so a partly invoiced challan shows
  exactly which lines are still to bill. The `'invoiced' in line` check narrows the union without a cast; the other
  stock documents have no such field.

### Orders: `components/sales-lines-table.tsx`, `components/sales-order-view.tsx`

```diff
@@ -17,7 +17,8 @@ import { useQuantity } from './stock-parts';
 
 // The lines of a quotation or an order that is no longer edited here: a real <table> in a card,
 // scrolling inside its own box on a phone, with the document's totals under it. An order's lines
-// (`delivered`) also say how much went out and how much is left.
+// (`delivered`) also say how much went out and how much is left, and (step 15c) how much of it
+// posted invoices bill. An invoice's lines use the table as they are.
 export function SalesLinesTable({
   lines,
   totals,
@@ -27,6 +28,7 @@ export function SalesLinesTable({
   lines: readonly (SalesLine | SalesOrderLine)[];
   totals: DocumentTotals;
   pricesIncludeVat: boolean;
+  // An order past its draft: the Delivered and Invoiced columns
   delivered?: boolean;
 }) {
   const { t, format } = useLocale();
@@ -63,6 +65,11 @@ export function SalesLinesTable({
                   {t('salesOrders.delivered')}
                 </th>
               )}
+              {delivered && (
+                <th scope="col" className="px-5 py-2.5 text-right">
+                  {t('salesOrders.invoiced')}
+                </th>
+              )}
             </tr>
           </thead>
           <tbody>
@@ -124,6 +131,12 @@ export function SalesLinesTable({
                     )}
                   </td>
                 )}
+                {/* In the base unit, like Delivered: a challan in pieces bills part of a case */}
+                {delivered && 'invoicedQuantity' in line && (
+                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
+                    {quantity(line.invoicedQuantity, line.baseUnitId)}
+                  </td>
+                )}
               </tr>
             ))}
           </tbody>
```

- **An "Invoiced" column next to "Delivered"**, in the base unit, like Delivered. A challan in pieces bills part of a
  case, so the base unit is the only unit both columns can always show.

```diff
@@ -21,6 +21,7 @@ import { call } from '../lib/api';
 import { useCan } from '../lib/permissions';
 import { Fact } from './adjustment-view';
 import { failureOf } from './journal-parts';
+import { PrintButton, SalesOrderPrint } from './print-documents';
 import { SalesLinesTable } from './sales-lines-table';
 import {
   CustomerLink,
@@ -81,7 +82,13 @@ export function SalesOrderView({ order, today }: { order: SalesOrder; today: str
       <PageHeader
         title={order.number ?? t('salesOrders.draftTitle')}
         description={order.customer.name}
-        actions={<OrderStatusPills order={order} today={today} />}
+        actions={
+          <>
+            <OrderStatusPills order={order} today={today} />
+            {/* A draft has no number yet: nothing to send the customer */}
+            {order.number !== null && <PrintButton />}
+          </>
+        }
       />
       {failureOf(act.error) && asking === null && (
         <FormAlert message={failureOf(act.error) ?? ''} />
@@ -255,6 +262,7 @@ export function SalesOrderView({ order, today }: { order: SalesOrder; today: str
           </DialogContent>
         )}
       </Dialog>
+      {order.number !== null && <SalesOrderPrint order={order} />}
     </div>
   );
 }
```

- **Print once the order has a number.** A draft is not sent to a customer.

### `routes/customer.tsx`: bill, take money, and the credit

```diff
@@ -1,6 +1,8 @@
 import {
   Archive02Icon,
+  Invoice03Icon,
   Location01Icon,
+  MoneyReceive02Icon,
   Notebook02Icon,
   PencilEdit02Icon,
   TruckDeliveryIcon,
@@ -42,6 +44,7 @@ import { useCustomerText } from '../lib/customers';
 import { fiscalYearStart } from '../lib/journal';
 import { useCan } from '../lib/permissions';
 import {
+  customerCreditQuery,
   customerGroupsQuery,
   customerQuery,
   customerStatementQuery,
@@ -211,12 +214,20 @@ function Statement({ customerId }: { customerId: string }) {
 }
 
 function CustomerView({ customer }: { customer: Customer }) {
-  const { t } = useLocale();
+  const { t, format } = useLocale();
   const navigate = useNavigate();
   const queryClient = useQueryClient();
   const tenantId = useTenantId();
   const can = useCan();
   const canManage = can('sales.customer.manage');
+  // Step 15c: bill the customer, take their money. An archived customer is not sold to any more.
+  const canBill = can('sales.invoice.manage') && customer.archivedAt === null;
+  const canPay = can('sales.receipt.manage');
+  // What counts against the credit limit, with the numbers the order and invoice forms check
+  const credit = useQuery({
+    ...customerCreditQuery(tenantId, customer.id),
+    enabled: customer.balance !== null,
+  }).data;
   const text = useCustomerText();
   const [confirming, setConfirming] = useState(false);
   const groups = useQuery(customerGroupsQuery(tenantId)).data;
@@ -265,43 +276,67 @@ function CustomerView({ customer }: { customer: Customer }) {
         title={customer.name}
         description={<span className="font-mono tabular-nums">{customer.code}</span>}
         actions={
-          canManage && (
-            <>
-              {/* Delete takes two clicks: it cannot be undone */}
+          <>
+            {canBill && (
               <Button
                 variant="secondary"
-                disabled={busy}
-                onClick={() => {
-                  if (confirming) remove.mutate();
-                  else setConfirming(true);
-                }}
+                onClick={() =>
+                  void navigate({ to: '/invoices/new', search: { customerId: customer.id } })
+                }
               >
-                {confirming
-                  ? t('customers.confirmDelete', { code: customer.code })
-                  : t('customers.delete')}
+                <HugeiconsIcon icon={Invoice03Icon} size={17} strokeWidth={1.5} />
+                {t('customers.newInvoice')}
               </Button>
+            )}
+            {canPay && (
               <Button
                 variant="secondary"
-                disabled={busy}
-                onClick={() => {
-                  toggle.mutate();
-                }}
-              >
-                {customer.archivedAt === null ? t('customers.archive') : t('customers.restore')}
-              </Button>
-              <Button
                 onClick={() =>
-                  void navigate({
-                    to: '/customers/$customerId/edit',
-                    params: { customerId: customer.id },
-                  })
+                  void navigate({ to: '/receipts/new', search: { customerId: customer.id } })
                 }
               >
-                <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
-                {t('customers.edit')}
+                <HugeiconsIcon icon={MoneyReceive02Icon} size={17} strokeWidth={1.5} />
+                {t('customers.recordPayment')}
               </Button>
-            </>
-          )
+            )}
+            {canManage && (
+              <>
+                {/* Delete takes two clicks: it cannot be undone */}
+                <Button
+                  variant="secondary"
+                  disabled={busy}
+                  onClick={() => {
+                    if (confirming) remove.mutate();
+                    else setConfirming(true);
+                  }}
+                >
+                  {confirming
+                    ? t('customers.confirmDelete', { code: customer.code })
+                    : t('customers.delete')}
+                </Button>
+                <Button
+                  variant="secondary"
+                  disabled={busy}
+                  onClick={() => {
+                    toggle.mutate();
+                  }}
+                >
+                  {customer.archivedAt === null ? t('customers.archive') : t('customers.restore')}
+                </Button>
+                <Button
+                  onClick={() =>
+                    void navigate({
+                      to: '/customers/$customerId/edit',
+                      params: { customerId: customer.id },
+                    })
+                  }
+                >
+                  <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
+                  {t('customers.edit')}
+                </Button>
+              </>
+            )}
+          </>
         }
       />
       {confirming && <p className="text-body-sm text-ink-2">{t('customers.deleteWarning')}</p>}
@@ -330,6 +365,20 @@ function CustomerView({ customer }: { customer: Customer }) {
             ? { label: t('customers.fields.group'), value: group?.name ?? '—' }
             : { label: t('customers.kpis.balance'), value: text.balance(customer.balance) },
           { label: t('customers.kpis.creditLimit'), value: text.creditLimit(customer.creditLimit) },
+          // Step 15c, with the balance's permission: what confirmed orders will still bill, and
+          // what is left under the limit (negative once over it)
+          ...(credit
+            ? [
+                { label: t('customers.kpis.onOrder'), value: format.money(credit.onOrder) },
+                {
+                  label: t('customers.kpis.creditLeft'),
+                  value:
+                    credit.available === null
+                      ? t('customers.credit.noLimit')
+                      : format.money(credit.available),
+                },
+              ]
+            : []),
           { label: t('customers.kpis.terms'), value: text.terms(customer.paymentTermsDays) },
         ]}
       />
```

- **"New invoice" and "Record payment"**, each with its own permission, as secondary buttons: Edit stays the page's
  one primary button. An archived customer gets no "New invoice"; their money can still come in.
- **"On confirmed orders" and "Credit left"** in the KPI strip, only with `sales.customer.balance` (the query runs
  only when the balance came back, which is that permission's sign). Credit left is negative once the customer is over
  the limit, which is the true number.

### Accounts: `lib/account-tree.ts`, `routes/accounts.tsx`

```diff
@@ -82,3 +82,19 @@ export function suggestCode(parent: Account, accounts: readonly Account[]): stri
     next += step;
   }
 }
+
+// Step 15c: the group at or above `parentId` that holds money, if any. An account under it holds
+// money already (moneyAccountIds in the contracts walks up the same way), so its own tick says
+// nothing more. The step count only keeps a broken chart from hanging the page.
+export function moneyGroupOf(
+  accounts: readonly Account[],
+  parentId: string | null,
+): Account | undefined {
+  const byId = new Map(accounts.map((account) => [account.id, account]));
+  let current = parentId === null ? undefined : byId.get(parentId);
+  for (let step = 0; current !== undefined && step <= accounts.length; step += 1) {
+    if (current.holdsMoney) return current;
+    current = current.parentId === null ? undefined : byId.get(current.parentId);
+  }
+  return undefined;
+}
```

- **`moneyGroupOf()`** walks up from a group to the top, like `moneyAccountIds()` in the contracts, and returns the
  first group that holds money. The step count only keeps a broken chart from hanging the page.

```diff
@@ -45,7 +45,7 @@ import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { type ChangeEvent, useCallback, useMemo, useState } from 'react';
 import { Controller, useForm, useWatch } from 'react-hook-form';
 
-import { accountTree, groupOptions, suggestCode } from '../lib/account-tree';
+import { accountTree, groupOptions, moneyGroupOf, suggestCode } from '../lib/account-tree';
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { useCan } from '../lib/permissions';
@@ -71,6 +71,46 @@ function TypeLine({ type, prefix }: { type: AccountType; prefix?: string }) {
   return <p className="text-label text-ink-3">{prefix ? `${prefix} · ${line}` : line}</p>;
 }
 
+// Step 15c: "Holds money", for asset accounts only (the server's account_money_type). Under a
+// group that holds money, the box shows ticked and cannot be changed, and says why: the group
+// counts for every account inside it. A plain controlled box: each form wraps it in a Controller
+// of its own type.
+function HoldsMoneyBox({
+  checked,
+  onChange,
+  accounts,
+  type,
+  parentId,
+}: {
+  checked: boolean;
+  onChange: (checked: boolean) => void;
+  accounts: readonly Account[];
+  type: AccountType | undefined;
+  parentId: string | null;
+}) {
+  const { t } = useLocale();
+  if (type !== 'asset') return null;
+  const group = moneyGroupOf(accounts, parentId);
+  return (
+    <div className="grid gap-1.5">
+      <Checkbox
+        id="account-holds-money"
+        label={t('accounts.holdsMoney')}
+        checked={group !== undefined || checked}
+        disabled={group !== undefined}
+        onCheckedChange={(next) => {
+          onChange(next === true);
+        }}
+      />
+      <p className="pl-[27px] text-label text-ink-3">
+        {group === undefined
+          ? t('accounts.holdsMoneyHint')
+          : t('accounts.holdsMoneyFromGroup', { name: group.name })}
+      </p>
+    </div>
+  );
+}
+
 function useRefresh() {
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const queryClient = useQueryClient();
@@ -105,6 +145,7 @@ function NewAccountForm({
       code: start ? suggestCode(start, accounts) : '',
       name: '',
       isGroup: false,
+      holdsMoney: false,
       description: '',
     },
   });
@@ -204,6 +245,19 @@ function NewAccountForm({
             error={errors.name?.message}
           />
         </div>
+        <Controller
+          control={control}
+          name="holdsMoney"
+          render={({ field }) => (
+            <HoldsMoneyBox
+              checked={field.value}
+              onChange={field.onChange}
+              accounts={accounts}
+              type={parent?.type}
+              parentId={chosen === '' ? null : chosen}
+            />
+          )}
+        />
         <TextAreaField
           label={t('accounts.about')}
           optional
@@ -237,6 +291,7 @@ function EditAccountForm({
     account.purpose !== null && isAccountPurpose(account.purpose) ? account.purpose : null;
   const {
     register,
+    control,
     handleSubmit,
     setError,
     formState: { errors, isSubmitting },
@@ -246,10 +301,13 @@ function EditAccountForm({
       parentId: account.parentId,
       code: account.code,
       name: account.name,
+      holdsMoney: account.holdsMoney,
       description: account.description ?? '',
       version: account.version,
     },
   });
+  // The group the account sits in now, as the person may have just changed it
+  const parentId = useWatch({ control, name: 'parentId' });
 
   const toggle = useMutation({
     mutationFn: () =>
@@ -381,6 +439,19 @@ function EditAccountForm({
             error={errors.name?.message}
           />
         </div>
+        <Controller
+          control={control}
+          name="holdsMoney"
+          render={({ field }) => (
+            <HoldsMoneyBox
+              checked={field.value}
+              onChange={field.onChange}
+              accounts={accounts}
+              type={account.type}
+              parentId={parentId}
+            />
+          )}
+        />
         <TextAreaField
           label={t('accounts.about')}
           optional
```

- **"Holds money" only for asset accounts**, the server's rule (`account_money_type`, 15c.3). The new form takes the
  type from the chosen group; the edit form from the account.
- **Under a group that holds money**, the box shows ticked, cannot be changed, and says why. The group already counts
  for every account inside it, so the account's own tick says nothing more.
- **`HoldsMoneyBox` is a plain controlled box**, and each form wraps it in its own `Controller`. The two forms have
  different types, and react-hook-form's `Control` type does not let one component take both.
- **The edit form watches `parentId`**, so moving the account under a money group shows the reason at once.

```diff
@@ -13,6 +13,7 @@ function account(code: string, parent: Account | null, fields: Partial<Account>
     name: `Account ${code}`,
     type: parent?.type ?? 'asset',
     isGroup: false,
+    holdsMoney: false,
     purpose: null,
     description: null,
     archivedAt: null,
```

```diff
@@ -11,6 +11,7 @@ function account(code: string, fields: Partial<Account> = {}): Account {
     name: `Account ${code}`,
     type: 'asset',
     isGroup: false,
+    holdsMoney: false,
     purpose: null,
     description: null,
     archivedAt: null,
```

- **`holdsMoney: false`** in the two test fixtures: an account has the field now (15c.1).

### `components/journal-entry-view.tsx`: the entries of an invoice and a receipt

```diff
@@ -7,6 +7,7 @@ import {
   contractErrorMap,
   isJournalSource,
   isPartyAccountPurpose,
+  isSalesJournalSource,
   isStockJournalSource,
   type JournalEntry,
   reverseJournalEntryInputSchema,
@@ -103,8 +104,8 @@ function ReverseForm({
   );
 }
 
-// A posted entry (read only, with Reverse), or a draft for someone who may post but not edit
-// The document a stock entry came from (step 14), or a delivery's (15b): its page, by the source
+// The document a stock entry came from (step 14), a delivery's (15b), or an invoice's or a money
+// receipt's (15c): its page, by the source
 function documentLinkOf(entry: JournalEntry) {
   const id = entry.document?.id;
   if (id === undefined) return null;
@@ -121,6 +122,13 @@ function documentLinkOf(entry: JournalEntry) {
   if (entry.source === 'sales_delivery') {
     return { to: '/deliveries/$deliveryId', params: { deliveryId: id } } as const;
   }
+  // Step 15c: the sale of an invoice, and the money of a receipt
+  if (entry.source === 'sales_invoice') {
+    return { to: '/invoices/$invoiceId', params: { invoiceId: id } } as const;
+  }
+  if (entry.source === 'sales_receipt') {
+    return { to: '/receipts/$receiptId', params: { receiptId: id } } as const;
+  }
   return null;
 }
 
@@ -154,16 +162,19 @@ export function EntryView({
     },
   });
 
-  // A closing entry is undone by reopening its year (the Year-end close page), and a stock
-  // document's entry by another stock document (step 14) — not from here
+  // A closing entry is undone by reopening its year (the Year-end close page), a stock document's
+  // entry by another stock document (step 14), and a sales document's by the document (15c: a
+  // credit note for an invoice, Void for a receipt) — not from here
   const fromStock = isStockJournalSource(entry.source);
+  const fromSales = isSalesJournalSource(entry.source);
   const canReverse =
     canPost &&
     entry.status === 'posted' &&
     entry.reversedBy === null &&
     entry.source !== 'reversal' &&
     entry.source !== 'year_close' &&
-    !fromStock;
+    !fromStock &&
+    !fromSales;
   const documentLink = documentLinkOf(entry);
   const failure = failureOf(post.error);
   const amount = (value: string) =>
@@ -235,6 +246,12 @@ export function EntryView({
         )}
       </div>
       {fromStock && <p className="text-label text-ink-3">{t('journal.stockEntryHint')}</p>}
+      {entry.source === 'sales_invoice' && (
+        <p className="text-label text-ink-3">{t('journal.invoiceEntryHint')}</p>
+      )}
+      {entry.source === 'sales_receipt' && (
+        <p className="text-label text-ink-3">{t('journal.receiptEntryHint')}</p>
+      )}
       {entry.narration && <p className="text-body text-ink">{entry.narration}</p>}
       {/* A plain table in its own scroll box: four columns, a handful of rows, a totals row */}
       <Card className="overflow-x-auto">
```

- **The entry links back to its invoice or receipt**, by its source, like the stock documents' entries (step 14).
- **No Reverse button for a sales entry.** The API refuses it (`journal_is_sales`, 15c.3); the page shows the hint that
  says where to go instead.

### `router.tsx` and `routes/app-shell.tsx`

```diff
@@ -445,6 +445,61 @@ const deliveryRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/delivery'), 'DeliveryPage'),
 });
 
+// Invoices and money receipts (step 15c). "Make invoice" on a challan comes with ?deliveryId=, and
+// "New invoice" on a customer's page with ?customerId=; "Record payment" on an invoice comes with
+// ?customerId= and ?invoiceId=, on a customer's page with ?customerId= alone.
+const invoicesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/invoices',
+  component: lazyRouteComponent(() => import('./routes/invoices'), 'InvoicesPage'),
+});
+
+const newInvoiceRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/invoices/new',
+  validateSearch: (
+    search: Record<string, unknown>,
+  ): { deliveryId?: string; customerId?: string } => ({
+    ...(typeof search.deliveryId === 'string' &&
+      UUID.test(search.deliveryId) && { deliveryId: search.deliveryId }),
+    ...(typeof search.customerId === 'string' &&
+      UUID.test(search.customerId) && { customerId: search.customerId }),
+  }),
+  component: lazyRouteComponent(() => import('./routes/invoice'), 'NewInvoicePage'),
+});
+
+const invoiceRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/invoices/$invoiceId',
+  component: lazyRouteComponent(() => import('./routes/invoice'), 'InvoicePage'),
+});
+
+const receiptsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/receipts',
+  component: lazyRouteComponent(() => import('./routes/receipts'), 'ReceiptsPage'),
+});
+
+const newReceiptRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/receipts/new',
+  validateSearch: (
+    search: Record<string, unknown>,
+  ): { customerId?: string; invoiceId?: string } => ({
+    ...(typeof search.customerId === 'string' &&
+      UUID.test(search.customerId) && { customerId: search.customerId }),
+    ...(typeof search.invoiceId === 'string' &&
+      UUID.test(search.invoiceId) && { invoiceId: search.invoiceId }),
+  }),
+  component: lazyRouteComponent(() => import('./routes/receipt'), 'NewReceiptPage'),
+});
+
+const receiptRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/receipts/$receiptId',
+  component: lazyRouteComponent(() => import('./routes/receipt'), 'ReceiptPage'),
+});
+
 const customFieldsRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/custom-fields',
@@ -539,6 +594,12 @@ const routeTree = rootRoute.addChildren([
     deliveriesRoute,
     newDeliveryRoute,
     deliveryRoute,
+    invoicesRoute,
+    newInvoiceRoute,
+    invoiceRoute,
+    receiptsRoute,
+    newReceiptRoute,
+    receiptRoute,
     customFieldsRoute,
     teamRoute,
     rolesRoute,
```

- **`?deliveryId=`, `?customerId=` and `?invoiceId=`** are checked with the `UUID` pattern, as in 15b: a value typed into
  the address bar that is not a UUID is dropped, and the page starts empty instead of asking the API for nonsense.

```diff
@@ -12,11 +12,13 @@ import {
   FileImportIcon,
   FolderTreeIcon,
   HourglassIcon,
+  Invoice03Icon,
   Layers01Icon,
   LayoutGridIcon,
   LeftToRightListNumberIcon,
   Logout01Icon,
   MoneyExchange01Icon,
+  MoneyReceive02Icon,
   Note01Icon,
   Notebook02Icon,
   PackageIcon,
@@ -300,7 +302,8 @@ export function AppShell() {
           {/* Sales (step 15a): everyone reads the customers and the price lists — every sales
               document picks them. Changing them is checked on the pages and by the API. Step 15b:
               the documents come first, in the order they follow each other; everyone reads them
-              too (a store keeper looks up an order before loading the truck). */}
+              too (a store keeper looks up an order before loading the truck). Step 15c: the
+              invoice and the money receipt end the chain. */}
           <NavGroup label={t('nav.sales')}>
             <NavLink to="/quotations" icon={Note01Icon}>
               {t('nav.quotations')}
@@ -311,6 +314,12 @@ export function AppShell() {
             <NavLink to="/deliveries" icon={DeliveryTruck01Icon}>
               {t('nav.deliveries')}
             </NavLink>
+            <NavLink to="/invoices" icon={Invoice03Icon}>
+              {t('nav.invoices')}
+            </NavLink>
+            <NavLink to="/receipts" icon={MoneyReceive02Icon}>
+              {t('nav.receipts')}
+            </NavLink>
             <NavLink to="/customers" icon={UserMultiple02Icon}>
               {t('nav.customers')}
             </NavLink>
```

- **Invoices and Money receipts come right after Deliveries**: the chain in the order it happens.

### The 100 KB budget: `report-hooks.ts`, `report-parts.tsx`, `year-end.tsx`, `journal-entry-form.tsx`

Every page that calls the API imports `routes` from the contracts, and with it every schema. 15c.1 added the invoice
and receipt schemas, so pages this step never touched grew too: the year-end page went to 101.5 KB and the journal
entry form to 100.1 KB. `pnpm test:bundle-size` fails above 100 KB.

```ts
import { DEFAULT_SETTINGS, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { useQuery } from '@tanstack/react-query';

import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Two hooks of the report pages without any of their components (step 15c). The year-end page uses
// only these; importing them from report-parts.tsx brought that file's date picker and export menu
// into its chunk, and the 15c contracts took the chunk over its 100 KB budget.

// Today and the fiscal year's first month, on the company's clock (not the browser's): the
// presets are worked out from them
export function useReportCalendar(): { today: string; startMonth: number } {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const settings = useQuery(settingsQuery(tenantId)).data;
  return {
    today: todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone),
    startMonth: settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
  };
}

// "৳18,42,600.50": 2 decimals, so a statement's totals visibly add up (CLAUDE.md → Money)
export function useAmount(): (value: string) => string {
  const { format } = useLocale();
  return (value: string) => format.money(value, { decimals: 2 });
}
```

```diff
@@ -8,13 +8,11 @@ import {
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
-  DEFAULT_SETTINGS,
   type ExportFormat,
   isZeroMoney,
   type ReportExportInput,
   type ReportSection,
   routes,
-  todayIn,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
@@ -30,31 +28,23 @@ import {
   SelectField,
   toast,
 } from '@omnivo/ui';
-import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
+import { useMutation, useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
 import { type ReactNode, useState } from 'react';
 
 import { call } from '../lib/api';
 import { balanceSide } from '../lib/journal';
-import { settingsQuery } from '../lib/queries';
 import { type DateRange, PERIOD_PRESETS, type PeriodPreset, presetRange } from '../lib/reports';
 import { useSession } from '../lib/session-store';
 import { failureOf } from './journal-parts';
+import { useAmount, useReportCalendar } from './report-hooks';
+
+// Step 15c: the two hooks live in report-hooks.ts; the report pages still import them from here
+export { useAmount, useReportCalendar } from './report-hooks';
 
 // Shared by the three report pages. Here, not in a route file: each route is its own lazy chunk,
 // and importing from one would pull that whole page into the others.
 
-// Today and the fiscal year's first month, on the company's clock (not the browser's): the
-// presets are worked out from them
-export function useReportCalendar(): { today: string; startMonth: number } {
-  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
-  const settings = useQuery(settingsQuery(tenantId)).data;
-  return {
-    today: todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone),
-    startMonth: settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
-  };
-}
-
 // A report's period: a preset ("This fiscal year") until someone picks a date by hand, then
 // "Custom dates" with what they picked. The preset's dates follow the settings once they load.
 export function usePeriod(initial: Exclude<PeriodPreset, 'custom'> = 'this_year') {
@@ -82,12 +72,6 @@ export function usePeriod(initial: Exclude<PeriodPreset, 'custom'> = 'this_year'
   };
 }
 
-// "৳18,42,600.50": 2 decimals, so a statement's totals visibly add up (CLAUDE.md → Money)
-export function useAmount(): (value: string) => string {
-  const { format } = useLocale();
-  return (value: string) => format.money(value, { decimals: 2 });
-}
-
 // The period: a preset, and the two dates it stands for. Changing a date makes it "Custom dates".
 export function PeriodFields({
   preset,
```

```diff
@@ -23,7 +23,7 @@ import { Link } from '@tanstack/react-router';
 import { useMemo, useState } from 'react';
 
 import { useIsoDate } from '../components/journal-parts';
-import { useAmount, useReportCalendar } from '../components/report-parts';
+import { useAmount, useReportCalendar } from '../components/report-hooks';
 import { ApiRequestError, call } from '../lib/api';
 import { useCan } from '../lib/permissions';
 import { fiscalYearsQuery } from '../lib/queries';
```

- **The year-end page uses two hooks of `report-parts.tsx` and none of its components.** A module goes into a chunk
  whole, so the page carried the date picker and the export menu it never shows. The two hooks now live in
  `report-hooks.ts`; `report-parts.tsx` re-exports them, so the three report pages do not change. The year-end page is
  at 75.5 KB.

```diff
@@ -1,9 +1,11 @@
 import {
   AlertCircleIcon,
+  Calendar03Icon,
   CheckmarkCircle02Icon,
   Delete02Icon,
   Alert02Icon,
   PlusSignIcon,
+  UserIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
@@ -22,7 +24,6 @@ import {
   Button,
   Card,
   cn,
-  DatePicker,
   FormAlert,
   FormField,
   IconButton,
@@ -36,7 +37,7 @@ import {
 } from '@omnivo/ui';
 import { useMutation } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
-import { useMemo, useState } from 'react';
+import { lazy, Suspense, useMemo, useState } from 'react';
 import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
 import type { z } from 'zod';
 
@@ -44,9 +45,15 @@ import { call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { balanceSide, formAmount, ledgerOptions, linePath, totalsOf } from '../lib/journal';
 import { useCan } from '../lib/permissions';
-import { CustomerPicker } from './customer-picker';
 import { BackLink, failureOf, LineField, useJournalRefresh } from './journal-parts';
 
+// The date picker and the customer box as chunks of their own (step 15c): both bring the popover,
+// and the 15c contracts took this chunk over its 100 KB budget (the delivery form's fix)
+const CustomerPicker = lazy(async () => ({
+  default: (await import('./customer-picker')).CustomerPicker,
+}));
+const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
+
 // The entry form: a chunk of its own (loaded by routes/journal-entry.tsx), because the form
 // library, the date picker and the money input are only needed to write — a posted entry, the most
 // common page, is read without them.
@@ -218,7 +225,11 @@ export function EntryForm({
         {failure && <FormAlert message={failure} />}
         <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-4">
           <FormField control={control} name="date" label={t('journal.date')}>
-            {(field) => <DatePicker {...field} />}
+            {(field) => (
+              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
+                <DatePicker {...field} />
+              </Suspense>
+            )}
           </FormField>
           <TextField
             label={t('journal.narration')}
@@ -312,17 +323,21 @@ export function EntryForm({
                           label={t('journal.customer')}
                           error={fieldState.error?.message}
                         >
-                          <CustomerPicker
-                            id={field.name}
-                            name={field.name}
-                            ref={field.ref}
-                            value={field.value ?? ''}
-                            saved={savedParties.get(field.value ?? '') ?? null}
-                            onChange={field.onChange}
-                            onBlur={field.onBlur}
-                            invalid={fieldState.error !== undefined}
-                            aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
-                          />
+                          <Suspense fallback={<Input id={field.name} icon={UserIcon} disabled />}>
+                            <CustomerPicker
+                              id={field.name}
+                              name={field.name}
+                              ref={field.ref}
+                              value={field.value ?? ''}
+                              saved={savedParties.get(field.value ?? '') ?? null}
+                              onChange={field.onChange}
+                              onBlur={field.onBlur}
+                              invalid={fieldState.error !== undefined}
+                              aria-describedby={
+                                fieldState.error ? `${field.name}-error` : undefined
+                              }
+                            />
+                          </Suspense>
                         </LineField>
                       )}
                     />
```

- **The date picker and the customer box become lazy**, the delivery form's fix. Both bring the popover, about 23 KB
  gzipped. The fallbacks are the same boxes, empty and disabled, for the moment the chunk loads. The form is at
  74 KB.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app exec tsc --noEmit
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app exec vite build
pnpm --filter @omnivo/app test:bundle-size
```

The type check shows six errors, all in `mocks/` (`holdsMoney`, `invoicedQuantity`, `invoiced` and
`overrideCreditLimit`); 15c.7 fixes them. Build the contracts first: the app reads their built types, and invoice
lines have two new fields.

> **What we checked in this part.** The app type-checks except for the six known mock errors, and ESLint and Prettier
> are clean. The app's unit tests pass (64, 12 of them new in `invoices.spec.ts`). The API's `invoices.int.spec.ts`
> passes (26), with its new check of the line numbers. The app builds and every chunk is inside its budget: the first
> load is 192.7 KB of 200 KB, the largest lazy chunks are the opening balances page (98.9 KB, unchanged) and the
> receipt form (97.4 KB), and the invoice form and its lines are 87 KB and 91 KB. The screens are clicked through in
> 15c.7, on the mock API, on a desktop and a phone; that part says what it found.

---

## 15c.7 — `apps/app`: the mock API and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). This part
teaches the mock invoices, money receipts and the credit limit, with the API's rules, shortened. It also fixes the
six mock type errors that 15c.6 left. Then two new test files click through the screens of 15c.6 on a desktop and
on a phone: bill a challan, write an invoice that delivers its own goods, bill an order's service, see an invoice
go overdue, go over a credit limit, take a payment, void it, and apply an advance later. One more test checks
"Holds money" on the chart of accounts.

This was the first time the 15c screens ran in a browser. They worked as built. One older test needed a change: the
order page now carries its printed copy (15c.6), hidden until the browser prints, so the buyer's PO number is on
the page twice (below).

Decisions made while building this part (you were not asked):

- **Invoices and receipts live in their own file**, `mocks/invoice-data.ts`, and in a new `billing` field of the
  mock workspace. `sales-document-data.ts` was already 960 lines. When a challan or an order needs to know about
  invoices (is this line billed? which invoices bill this challan?), it reads `data.billing` through the
  `WorkspaceData` type only, never through a function of the new file. The new file imports the sales file, so an
  import back would close a circle, which `pnpm boundaries` refuses (15b.7 explains why).
- **The seeds post no invoice and no receipt.** Both write journal entries, and the journal, report and customer
  tests read the seeded books to the taka, as in 15b. Every invoice and receipt in the tests is the test's own.
- **A posting is all or nothing through one helper, `transaction()`.** Posting an invoice may post a challan, move
  stock, mark challan lines billed, move order lines' invoiced quantities and book the sale, and the credit check
  comes last. Undoing each step by hand (as the 15b delivery handlers do for their one step) would be easy to get
  wrong. The helper keeps a copy of the parts that change and puts them back if anything throws, like the API's
  database transaction.
- **What an invoice was paid, and what a receipt applied, are worked out on read.** The API keeps
  `invoices.amount_paid` and `receipts.applied` with a trigger (15c.2). The mock adds up the allocations each time,
  so the two numbers can never disagree there either.
- **A service product, "Logo embroidery" (code `SVC-EMB`), joins the garments catalog**, so an order can carry a
  charge that the invoice form's "Add order charges" bills. The mock had no service before.
- **No end-to-end test of `credit_override_forbidden` or of the read-only views.** The mock always signs in as the
  owner, who has every permission (as 15b.7 said for its views). The API's tests (15c.4) check both 403 answers.

### `mocks/workspace-data.ts`: the billing field, and a transaction

```diff
@@ -23,6 +23,7 @@ import {
 
 import { noStockAccounts, seedAccounts, seedStockAccounts } from './accounting-data';
 import { OWNER, type Workspace } from './fixtures';
+import { emptyBilling, type MockBilling } from './invoice-data';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
@@ -62,6 +63,8 @@ export interface WorkspaceData {
   sales: MockSales;
   // Quotations, sales orders and deliveries (step 15b)
   salesDocuments: MockSalesDocuments;
+  // Invoices and money receipts (step 15c)
+  billing: MockBilling;
 }
 
 function now(): string {
@@ -122,6 +125,7 @@ function seed(workspace: Workspace): WorkspaceData {
     stock: emptyStock(),
     sales: emptySales(),
     salesDocuments: emptySalesDocuments(),
+    billing: emptyBilling(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   // Before the journal: its receivable lines name the customers
@@ -198,6 +202,27 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   store.set(workspace.tenantId, data);
 }
 
+// The API's transaction, for the mock's postings that change many things at once (step 15c: an
+// invoice posts a challan, moves stock, marks lines billed and books the sale, and the credit check
+// comes last). If fn throws, the parts it can change are put back as they were, so a refused
+// posting leaves nothing behind: no number used, no stock moved. Only these parts are copied: the
+// garments catalog alone holds 10,000 products.
+export function transaction<T>(data: WorkspaceData, fn: () => T): T {
+  const before = structuredClone({
+    journal: data.journal,
+    stock: data.stock,
+    salesDocuments: data.salesDocuments,
+    billing: data.billing,
+    audit: data.audit,
+  });
+  try {
+    return fn();
+  } catch (error) {
+    Object.assign(data, before);
+    throw error;
+  }
+}
+
 export function dataOf(workspace: Workspace): WorkspaceData {
   let data = store.get(workspace.tenantId);
   if (!data) {
@@ -265,6 +290,8 @@ function usedNumbers(data: WorkspaceData, documentType: DocumentType, period: st
   if (documentType === 'sales.quotation') return data.salesDocuments.counters.quotation;
   if (documentType === 'sales.order') return data.salesDocuments.counters.order;
   if (documentType === 'sales.delivery') return data.salesDocuments.counters.delivery;
+  if (documentType === 'sales.invoice') return data.billing.counters.invoice;
+  if (documentType === 'sales.receipt') return data.billing.counters.receipt;
   return 0;
 }
 
```

- **`billing` holds the invoices, the receipts and their two number counters.** `usedNumbers()` reads the counters,
  so the Numbering page shows the right "next number" for `sales.invoice` and `sales.receipt`.
- **`transaction()` copies only five parts** of the workspace: the journal, the stock, the sales documents, the
  billing and the audit log. These are everything a posting can change. The catalog is left out on purpose: the
  garments workspace holds 10,000 generated products, and copying them on every click would be slow.
- **`structuredClone`, not a JSON copy.** The journal keeps its number counters in a `Map`, which JSON would turn
  into an empty object. `structuredClone` copies `Map`s, arrays and dates as they are.
- **`Object.assign(data, before)` puts the copy back in place.** The workspace object itself stays the same, so
  `current()` and every other reference to it still work. Objects a handler found before the failure (the draft it
  was posting) are now detached copies, but the handler is already on its way out with the error.

### `mocks/sales-document-data.ts`: shared parts, and what 15c changes on orders and challans

```diff
@@ -6,6 +6,8 @@ import {
   defaultNumberFormat,
   type Delivery,
   type DeliveryInput,
+  type DeliveryInvoiceFilter,
+  type DeliveryInvoiceState,
   documentTotals,
   type DocumentType,
   type ErrorCode,
@@ -64,8 +66,12 @@ export type MockOrder = Omit<SalesOrder, 'partlyDelivered' | 'quotation' | 'deli
   quotationId: string | null;
 };
 
-// A delivery as stored, with its order's id: the order's number is looked up on read
-export type MockDelivery = Omit<Delivery, 'order'> & { orderId: string | null };
+// A delivery as stored, with its order's id: the order's number is looked up on read. So are the
+// invoices that bill it and how much of it is billed (step 15c): an invoice posted a second ago
+// shows on its challan at once.
+export type MockDelivery = Omit<Delivery, 'order' | 'invoiceState' | 'invoices'> & {
+  orderId: string | null;
+};
 
 export interface MockSalesDocuments {
   quotations: MockQuotation[];
@@ -85,11 +91,11 @@ export function emptySalesDocuments(): MockSalesDocuments {
   };
 }
 
-function now(): string {
+export function now(): string {
   return new Date().toISOString();
 }
 
-function fieldProblem(code: ErrorCode, field: string): MockProblem {
+export function fieldProblem(code: ErrorCode, field: string): MockProblem {
   return new MockProblem(409, code, { [field]: [code] });
 }
 
@@ -106,7 +112,7 @@ export function pageOf<T>(
 
 // Newest date first, like the API. Two documents of one day keep the array's order: a new one is
 // put first, so it comes first, like the API's uuidv7 ids.
-function newestFirst<T extends { date: string }>(items: readonly T[]): T[] {
+export function newestFirst<T extends { date: string }>(items: readonly T[]): T[] {
   return items.toSorted((a, b) => b.date.localeCompare(a.date));
 }
 
@@ -118,23 +124,36 @@ const SERIES = {
   delivery: 'sales.delivery',
 } as const satisfies Record<Series, DocumentType>;
 
-// The next number of a series, in the format saved on the Numbering page (or the default one)
-function nextNumber(data: WorkspaceData, series: Series, date: string): string {
-  const type = SERIES[series];
+// A number of a series, in the format saved on the Numbering page (or the default one). The
+// invoices and receipts (invoice-data.ts) keep their own counters and use this too.
+export function seriesNumber(
+  data: WorkspaceData,
+  type: DocumentType,
+  value: number,
+  date: string,
+): string {
   const format = data.series.get(type) ?? defaultNumberFormat(type);
-  data.salesDocuments.counters[series] += 1;
   return formatDocumentNumber(
     format,
     periodOf(date, format.yearStyle, data.settings.fiscalYearStartMonth),
-    data.salesDocuments.counters[series],
+    value,
   );
 }
 
+function nextNumber(data: WorkspaceData, series: Series, date: string): string {
+  data.salesDocuments.counters[series] += 1;
+  return seriesNumber(data, SERIES[series], data.salesDocuments.counters[series], date);
+}
+
 // --- What every sales document checks -----------------------------------------------------------
 
 // An active customer. A draft keeps its customer (keptId) even after the customer is archived,
 // like the API's assertCustomer(), so the person can still finish it.
-function customerOf(data: WorkspaceData, customerId: string, keptId: string | null): PartyRef {
+export function customerOf(
+  data: WorkspaceData,
+  customerId: string,
+  keptId: string | null,
+): PartyRef {
   const found = data.sales.customers.find((item) => item.id === customerId);
   if (!found || (found.archivedAt !== null && found.id !== keptId)) {
     throw fieldProblem('sales_customer_invalid', 'customerId');
@@ -160,19 +179,21 @@ function shippingAddressOf(
   return { id: address.id, text };
 }
 
-interface ResolvedLine {
+export interface ResolvedLine {
   line: SalesLine;
   amounts: LineAmounts;
 }
 
 // The API's resolveSalesLines(): an active product or service, its unit, the decimals, and an
 // active VAT rate (or one the document's lines already use: keptRateIds). Every problem at once,
-// each under its own field.
-function resolveSalesLines(
+// each under its own field. keptVariantIds (step 15c): an archived product still billed on an
+// invoice line, because the challan or the order behind that line already sold it.
+export function resolveSalesLines(
   data: WorkspaceData,
   lines: readonly SalesLineInput[],
   pricesIncludeVat: boolean,
   keptRateIds: ReadonlySet<string>,
+  keptVariantIds: ReadonlySet<string> = new Set(),
 ): ResolvedLine[] {
   const issues: { path: string; code: ErrorCode }[] = [];
   const resolved = lines.flatMap((input, index): ResolvedLine[] => {
@@ -180,7 +201,8 @@ function resolveSalesLines(
       issues.push({ path: `lines.${String(index)}.${field}`, code });
     };
     const found = findVariant(data, input.variantId);
-    if (found?.product.archivedAt !== null || found.variant.archivedAt !== null) {
+    const archived = found?.product.archivedAt !== null || found.variant.archivedAt !== null;
+    if (!found || (archived && !keptVariantIds.has(input.variantId))) {
       at('variantId', 'sales_item_invalid');
       return [];
     }
@@ -247,12 +269,12 @@ function resolveSalesLines(
   return resolved;
 }
 
-function totalsOf(resolved: readonly ResolvedLine[]) {
+export function totalsOf(resolved: readonly ResolvedLine[]) {
   return documentTotals(resolved.map((item) => item.amounts));
 }
 
 // The VAT rates a document's lines use now: they stay usable on it after they are archived
-function ratesOf(lines: readonly SalesLine[]): Set<string> {
+export function ratesOf(lines: readonly SalesLine[]): Set<string> {
   return new Set(lines.map((line) => line.taxRate.id));
 }
 
@@ -402,7 +424,8 @@ export function answerQuotation(target: MockQuotation, action: 'decline' | 'reop
 
 // --- Sales orders -------------------------------------------------------------------------------
 
-type OrderFields = Omit<SalesOrderInput, 'confirm' | 'quotationId'>;
+// overrideCreditLimit is the handler's (invoice-data.ts → confirmWithCredit)
+type OrderFields = Omit<SalesOrderInput, 'confirm' | 'quotationId' | 'overrideCreditLimit'>;
 
 export function findOrder(data: WorkspaceData, id: string): MockOrder {
   const found = data.salesDocuments.orders.find((item) => item.id === id);
@@ -414,6 +437,19 @@ function anythingDelivered(order: MockOrder): boolean {
   return order.lines.some((line) => !isZeroQuantity(line.deliveredQuantity));
 }
 
+function anythingInvoiced(order: MockOrder): boolean {
+  return order.lines.some((line) => !isZeroQuantity(line.invoicedQuantity));
+}
+
+// An invoice line, even a draft's, that bills a line of this order (step 15c). Read through the
+// WorkspaceData type, not a function of invoice-data.ts: that file imports this one.
+function anyInvoiceLine(data: WorkspaceData, order: MockOrder): boolean {
+  const lineIds = new Set(order.lines.map((line) => line.id));
+  return data.billing.invoices.some((invoice) =>
+    invoice.lines.some((line) => line.orderLineId !== null && lineIds.has(line.orderLineId)),
+  );
+}
+
 export function toOrder(data: WorkspaceData, stored: MockOrder): SalesOrder {
   const { quotationId, ...order } = stored;
   const quotation = data.salesDocuments.quotations.find((item) => item.id === quotationId);
@@ -465,7 +501,11 @@ function orderParts(
     pricesIncludeVat,
     ...totalsOf(resolved),
     lineCount: resolved.length,
-    lines: resolved.map((item) => ({ ...item.line, deliveredQuantity: '0.0000' })),
+    lines: resolved.map((item) => ({
+      ...item.line,
+      deliveredQuantity: '0.0000',
+      invoicedQuantity: '0.0000',
+    })),
   };
 }
 
@@ -552,7 +592,9 @@ export function removeOrder(data: WorkspaceData, target: MockOrder): void {
 }
 
 // Back to draft (no delivery at all, not even a draft one), close (something delivered) or cancel
-// (nothing delivered): the API's three rules
+// (nothing delivered): the API's three rules. Step 15c adds the invoices: no reopen while an
+// invoice line points at the order, a billed services-only order may close, and nothing billed
+// may be cancelled.
 export function changeOrderStatus(
   data: WorkspaceData,
   target: MockOrder,
@@ -565,12 +607,18 @@ export function changeOrderStatus(
   ) {
     throw new MockProblem(409, 'order_has_deliveries');
   }
-  if (action === 'close' && !anythingDelivered(target)) {
+  if (action === 'reopen' && anyInvoiceLine(data, target)) {
+    throw new MockProblem(409, 'order_has_invoices');
+  }
+  if (action === 'close' && !anythingDelivered(target) && !anythingInvoiced(target)) {
     throw new MockProblem(409, 'order_nothing_delivered');
   }
   if (action === 'cancel' && anythingDelivered(target)) {
     throw new MockProblem(409, 'order_partly_delivered');
   }
+  if (action === 'cancel' && anythingInvoiced(target)) {
+    throw new MockProblem(409, 'order_has_invoices');
+  }
   const status = action === 'reopen' ? 'draft' : action === 'close' ? 'closed' : 'cancelled';
   Object.assign(target, {
     status,
@@ -590,10 +638,46 @@ export function findDelivery(data: WorkspaceData, id: string): MockDelivery {
   return found;
 }
 
+// How much of a delivery is billed: a draft never is; a posted one by the `invoiced` flags its
+// lines got from the invoices that billed them (the API's invoiceState)
+function invoiceStateOf(delivery: MockDelivery): DeliveryInvoiceState {
+  if (delivery.status !== 'posted' || !delivery.lines.some((line) => line.invoiced)) {
+    return 'not_invoiced';
+  }
+  return delivery.lines.every((line) => line.invoiced) ? 'invoiced' : 'partly_invoiced';
+}
+
+function matchesInvoiceFilter(
+  delivery: MockDelivery,
+  filter: DeliveryInvoiceFilter | undefined,
+): boolean {
+  if (filter === undefined) return true;
+  if (delivery.status !== 'posted') return false;
+  const toInvoice = delivery.lines.some((line) => !line.invoiced);
+  return filter === 'to_invoice' ? toInvoice : !toInvoice;
+}
+
 export function toDelivery(data: WorkspaceData, stored: MockDelivery): Delivery {
   const { orderId, ...delivery } = stored;
   const order = data.salesDocuments.orders.find((item) => item.id === orderId);
-  return { ...delivery, order: order ? { id: order.id, number: order.number } : null };
+  // The posted invoices that bill a line of it, by number. A draft has claimed nothing yet.
+  const lineIds = new Set(stored.lines.map((line) => line.id));
+  const invoices = data.billing.invoices
+    .filter(
+      (invoice) =>
+        invoice.status === 'posted' &&
+        invoice.lines.some(
+          (line) => line.deliveryLineId !== null && lineIds.has(line.deliveryLineId),
+        ),
+    )
+    .map((invoice) => ({ id: invoice.id, number: invoice.number }))
+    .toSorted((a, b) => (a.number ?? '').localeCompare(b.number ?? ''));
+  return {
+    ...delivery,
+    order: order ? { id: order.id, number: order.number } : null,
+    invoiceState: invoiceStateOf(stored),
+    invoices,
+  };
 }
 
 export function listDeliveries(
@@ -602,6 +686,7 @@ export function listDeliveries(
     status?: string | undefined;
     customerId?: string | undefined;
     warehouseId?: string | undefined;
+    invoice?: DeliveryInvoiceFilter | undefined;
   },
 ): Delivery[] {
   return newestFirst(data.salesDocuments.deliveries)
@@ -609,7 +694,8 @@ export function listDeliveries(
       (item) =>
         (query.status === undefined || item.status === query.status) &&
         (query.customerId === undefined || item.customer.id === query.customerId) &&
-        (query.warehouseId === undefined || item.warehouseId === query.warehouseId),
+        (query.warehouseId === undefined || item.warehouseId === query.warehouseId) &&
+        matchesInvoiceFilter(item, query.invoice),
     )
     .map((item) => toDelivery(data, item));
 }
@@ -692,6 +778,8 @@ export function saveDelivery(
       ...line,
       orderLineId: orderLineIds[index] ?? null,
       value: null,
+      // Set by the invoice that bills it, at posting (invoice-data.ts → postInvoice)
+      invoiced: false,
     })),
     entry: null,
   };
```

- **Exported, not copied:** `now()`, `fieldProblem()`, `newestFirst()`, `customerOf()`, `resolveSalesLines()`,
  `totalsOf()` and `ratesOf()`. An invoice line is a sales line, checked the same way, so one copy of the rules
  serves quotations, orders and invoices.
- **`seriesNumber()` is split out of `nextNumber()`.** The format and the period come from one place; the invoices
  and receipts keep their counters in `billing` and pass their own value in.
- **`keptVariantIds` in `resolveSalesLines()`.** An archived product can still be billed when the line bills a
  challan or an order that already sold it, like the API (15c.3). The default is an empty set, so quotations and
  orders behave as before.
- **`MockDelivery` no longer stores `invoiceState` or `invoices`.** `toDelivery()` works both out from the lines'
  `invoiced` flags and from the posted invoices, so a challan shows "Invoiced" the moment its invoice is posted. A
  draft invoice has claimed nothing yet, so it is not listed.
- **`matchesInvoiceFilter()`** is the API's list filter: "To invoice" is a posted challan with a line not billed;
  "Invoiced" is a posted challan with every line billed.
- **The order rules of 15c.3**: back to draft is refused while any invoice line (even a draft's) points at the
  order (`order_has_invoices`); a services-only order that was billed may be closed; an order with anything billed
  may not be cancelled.
- **`OrderFields` leaves out `overrideCreditLimit`.** That flag belongs to the handler, which runs the credit check.
  This also fixes the three seed type errors of 15c.6 without touching the seeds.
- **New lines start at `invoicedQuantity: '0.0000'` and `invoiced: false`**, in the shape Postgres sends.

### `mocks/invoice-data.ts` (new): the shapes

```ts
import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type CustomerCredit,
  dueDateOf,
  type EntryRef,
  type ErrorCode,
  type Invoice,
  type InvoiceInput,
  type InvoiceLine,
  type InvoicePaymentFilter,
  isOverdue,
  isZeroMoney,
  isZeroQuantity,
  moneyAccountIds,
  overAllocated,
  paymentStatusOf,
  prorateMoney,
  type Receipt,
  type ReceiptInput,
  type StockLine,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';

import { findEntry, postNew, reverseEntry } from './journal-data';
import { MockProblem } from './mock';
import { balanceOf } from './sales-data';
import {
  confirmOrder,
  customerOf,
  fieldProblem,
  type MockDelivery,
  type MockOrder,
  newestFirst,
  now,
  postDelivery,
  ratesOf,
  type ResolvedLine,
  resolveSalesLines,
  saveDelivery,
  seriesNumber,
  totalsOf,
} from './sales-document-data';
import { assertWarehouses, issuesError, resolveLines } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 15c: invoices, money receipts and the credit limit. The API's rules
// (invoices.service.ts, receipts.service.ts, credit.service.ts, sales-books.service.ts) on plain
// arrays, shortened, so `pnpm dev:mock` and the e2e tests walk the same paths as the real API.

// An invoice as stored. What receipts paid on it, its challans, its orders and its payments are
// worked out on read, like the API's joins: a receipt saved a second ago shows on the invoice.
export type MockInvoice = Omit<Invoice, 'amountPaid' | 'deliveries' | 'orders' | 'payments'>;

export interface MockAllocation {
  invoiceId: string;
  amount: string;
}

// A receipt as stored: the invoices it pays, by id. What it applied and the invoices' numbers,
// dates and totals are looked up on read.
export type MockReceipt = Omit<Receipt, 'applied' | 'allocations'> & {
  allocations: MockAllocation[];
};

export interface MockBilling {
  invoices: MockInvoice[];
  receipts: MockReceipt[];
  // The last number given from each series, like the other mock documents
  counters: { invoice: number; receipt: number };
}

export function emptyBilling(): MockBilling {
  return { invoices: [], receipts: [], counters: { invoice: 0, receipt: 0 } };
}
```

- **`MockInvoice` leaves out `amountPaid`, `deliveries`, `orders` and `payments`**: the API's joins, worked out on
  read by `toInvoice()`. The lines are stored whole, with the challan and order numbers, because those never change
  once a document has its number.
- **`MockReceipt` stores its allocations as `{ invoiceId, amount }`.** The invoice's number, dates and total are
  looked up on read, as the API joins them.

### What every invoice and receipt checks

```ts
// --- What every invoice and receipt checks ------------------------------------------------------

// An active branch: whose sale it is, or whose money (the API's assertBranch)
function assertBranch(data: WorkspaceData, branchId: string): void {
  const branch = data.branches.find((item) => item.id === branchId);
  if (branch?.archivedAt !== null) throw fieldProblem('sales_branch_invalid', 'branchId');
}

// The accounts the sales documents post to, by their purpose (the API's SalesBooksService). Every
// chart has one of each, and an account with a purpose is never archived or deleted.
function salesAccounts(data: WorkspaceData) {
  const idOf = (purpose: string): string => {
    const id = data.accounts.find((account) => account.purpose === purpose)?.id;
    if (id === undefined) throw new Error(`The mock chart has no ${purpose} account`);
    return id;
  };
  return {
    receivable: idOf('accounts_receivable'),
    sales: idOf('sales'),
    vatOutput: idOf('vat_output'),
  };
}

// A journal line with one side only
function side(
  accountId: string,
  branchId: string,
  partyId: string | null,
  amount: { debit?: string; credit?: string },
) {
  return {
    accountId,
    branchId,
    partyId,
    description: null,
    debit: amount.debit ?? '0',
    credit: amount.credit ?? '0',
  };
}

function refOf(entry: { id: string; number: string | null }): EntryRef {
  return { id: entry.id, number: entry.number ?? '' };
}
```

- **`assertBranch()`**: an unknown branch and an archived one get the same answer, `sales_branch_invalid` under
  `branchId`, as in the API.
- **`salesAccounts()` throws a plain `Error`, not a `MockProblem`.** Every mock chart has the three accounts; a
  missing one is a bug in the mock, not something a person can fix on the form.
- **`side()`** writes a journal line with one side filled and the other `'0'`, so the entry code reads as
  Dr / Cr instead of a wall of zeros.

### The credit limit

```ts
// --- The credit limit ---------------------------------------------------------------------------

// What a confirmed order line will still bill: its total × the part not invoiced yet. A closed
// order bills only what it delivered (goods) or already billed (services). The API's stillToBill.
function stillToBill(order: MockOrder, line: MockOrder['lines'][number]): string {
  const expected =
    order.status !== 'closed'
      ? line.baseQuantity
      : line.productType === 'goods'
        ? line.deliveredQuantity
        : line.invoicedQuantity;
  const left = subtractQuantity(expected, line.invoicedQuantity);
  if (compareQuantity(left, '0') <= 0) return '0';
  return prorateMoney(line.total, left, line.baseQuantity);
}

// The API's CreditService.get(): what the customer owes now, plus what confirmed orders will still
// bill. The forms' credit line and the checks below use the same numbers.
export function creditOf(data: WorkspaceData, customerId: string): CustomerCredit {
  const customer = data.sales.customers.find((item) => item.id === customerId);
  if (!customer) throw new MockProblem(404, 'not_found');
  const balance = sumMoney([balanceOf(data, customerId)]);
  const onOrder = sumMoney(
    data.salesDocuments.orders
      .filter(
        (order) =>
          order.customer.id === customerId &&
          ['confirmed', 'delivered', 'closed'].includes(order.status),
      )
      .flatMap((order) => order.lines.map((line) => stillToBill(order, line))),
  );
  const exposure = sumMoney([balance, onOrder]);
  return {
    limit: customer.creditLimit,
    balance,
    onOrder,
    exposure,
    available: customer.creditLimit === null ? null : subtractMoney(customer.creditLimit, exposure),
  };
}

// After the change: refused when the exposure is over the limit AND higher than before (billing a
// confirmed order at its price adds nothing). With overrideCreditLimit it goes ahead, and the
// handler writes the audit row. The mock signs in as the owner, who has sales.credit.override, so
// credit_override_forbidden never comes from here (the API's tests, 15c.4, cover it).
function checkCredit(
  data: WorkspaceData,
  customerId: string,
  before: string,
  overrideCreditLimit: boolean,
): { limit: string; exposure: string } | null {
  const { limit, exposure } = creditOf(data, customerId);
  if (limit === null) return null;
  if (compareMoney(exposure, limit) <= 0 || compareMoney(exposure, before) <= 0) return null;
  if (!overrideCreditLimit) {
    throw new MockProblem(409, 'credit_limit_exceeded', undefined, { limit, exposure });
  }
  return { limit, exposure };
}

// "Confirm order" (step 15b) with the credit check of 15c. The handler runs it in a transaction(),
// so a refused confirmation leaves the order a draft, as the API's does.
export function confirmWithCredit(
  data: WorkspaceData,
  target: MockOrder,
  overrideCreditLimit: boolean,
): { limit: string; exposure: string } | null {
  const before = creditOf(data, target.customer.id).exposure;
  confirmOrder(data, target);
  return checkCredit(data, target.customer.id, before, overrideCreditLimit);
}
```

- **`stillToBill()` is the API's SQL, line by line:** the line's total × the part not invoiced ÷ the line's
  quantity, to the paisa (`prorateMoney()`). A closed order counts only what it delivered (goods) or billed
  (services); the rest will never be billed. Never below zero.
- **`creditOf()` starts from `balanceOf()`** of `sales-data.ts`, the same number the customer page shows. The credit
  line on the forms, the check and the customer page can then never disagree.
- **`checkCredit()` refuses only when the exposure is over the limit AND higher than before.** Billing a confirmed
  order at its price moves the amount from "on order" to "owed" and adds nothing (15c.3).
- **The error carries `limit` and `exposure` as params**, which the form turns into the dialog's amounts.
- **`confirmWithCredit()` lives here, not in the sales file.** The credit check reads the invoices' side of things,
  and the sales file must not import this file.

### Invoices: reading

```ts
// --- Invoices: reading --------------------------------------------------------------------------

type InvoiceFields = Omit<InvoiceInput, 'post' | 'overrideCreditLimit'>;

export function findInvoice(data: WorkspaceData, id: string): MockInvoice {
  const found = data.billing.invoices.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// A challan line, with its challan
function challanLineOf(data: WorkspaceData, deliveryLineId: string) {
  for (const delivery of data.salesDocuments.deliveries) {
    const line = delivery.lines.find((item) => item.id === deliveryLineId);
    if (line) return { delivery, line };
  }
  return undefined;
}

// An order line, with its order
function orderLineOf(data: WorkspaceData, orderLineId: string) {
  for (const order of data.salesDocuments.orders) {
    const line = order.lines.find((item) => item.id === orderLineId);
    if (line) return { order, line };
  }
  return undefined;
}

// What posted receipts applied to it. Worked out, not kept: the API keeps invoices.amount_paid
// with a trigger on the allocations, and the two can never disagree here either.
function paidOn(data: WorkspaceData, invoiceId: string): string {
  return sumMoney(
    data.billing.receipts.flatMap((receipt) =>
      receipt.allocations
        .filter((allocation) => allocation.invoiceId === invoiceId)
        .map((allocation) => allocation.amount),
    ),
  );
}

export function toInvoice(data: WorkspaceData, stored: MockInvoice): Invoice {
  const deliveries = new Map<string, { id: string; number: string; date: string }>();
  const orders = new Map<string, { id: string; number: string | null }>();
  for (const line of stored.lines) {
    const challan =
      line.deliveryLineId === null ? undefined : challanLineOf(data, line.deliveryLineId);
    // A billed challan is posted, so it has a number
    const number = challan?.delivery.number ?? null;
    if (challan && number !== null) {
      deliveries.set(challan.delivery.id, {
        id: challan.delivery.id,
        number,
        date: challan.delivery.date,
      });
    }
    const order = line.orderLineId === null ? undefined : orderLineOf(data, line.orderLineId);
    if (order) orders.set(order.order.id, { id: order.order.id, number: order.order.number });
  }
  const payments = data.billing.receipts.flatMap((receipt) =>
    receipt.allocations
      .filter((allocation) => allocation.invoiceId === stored.id)
      .map((allocation) => ({
        receiptId: receipt.id,
        receiptNumber: receipt.number,
        date: receipt.date,
        amount: allocation.amount,
      })),
  );
  return {
    ...stored,
    amountPaid: paidOn(data, stored.id),
    deliveries: [...deliveries.values()].toSorted((a, b) => a.date.localeCompare(b.date)),
    orders: [...orders.values()],
    payments: payments.toSorted((a, b) => a.date.localeCompare(b.date)),
  };
}

function matchesPayment(
  invoice: Invoice,
  payment: InvoicePaymentFilter | undefined,
  today: string,
): boolean {
  if (payment === undefined) return true;
  if (invoice.status !== 'posted') return false;
  const paid = paymentStatusOf(invoice) === 'paid';
  if (payment === 'paid') return paid;
  if (payment === 'open') return !paid;
  return isOverdue(invoice, today);
}

// Newest date first, like every list; "not paid" and "overdue" list the oldest due date first,
// the order a receipt pays them in. Two of the same due date: the older invoice first, like the
// API's (due_date, id) with uuidv7 ids. The array keeps the newest first, so it is reversed before
// the stable sort.
export function listInvoices(
  data: WorkspaceData,
  query: {
    status?: string | undefined;
    customerId?: string | undefined;
    payment?: InvoicePaymentFilter | undefined;
  },
): Invoice[] {
  const today = todayIn(data.settings.timezone);
  const byDue = query.payment === 'open' || query.payment === 'overdue';
  const stored = byDue
    ? data.billing.invoices.toReversed().toSorted((a, b) => a.dueDate.localeCompare(b.dueDate))
    : newestFirst(data.billing.invoices);
  return stored
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toInvoice(data, item))
    .filter((item) => matchesPayment(item, query.payment, today));
}
```

- **`paidOn()` adds up the allocations of every receipt.** A voided receipt has none left (voiding removes them),
  so it needs no special case.
- **`listInvoices()` sorts "Not paid" and "Overdue" by due date, oldest first**, the order the receipt form pays
  them in. Two invoices with the same due date: the older one first, like the API's `(due_date, id)` order with
  uuidv7 ids. The array keeps the newest first, so it is reversed before the stable sort.
- **The payment filter runs after `toInvoice()`**, because it needs `amountPaid`. `isOverdue()` and
  `paymentStatusOf()` are the contracts' functions, the same ones the pages use for their pills.

### Invoices: what a save checks

```ts
// --- Invoices: what a save checks ---------------------------------------------------------------

interface LineRefs {
  deliveryLineId: string | null;
  orderLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
}

// What a line bills: the challan line, and the order line (its own, or the challan line's)
interface LineSource {
  deliveryLineId: string | null;
  orderLineId: string | null;
}

// The API's checkSources(): a challan line is on a posted challan of this customer, of the same
// item, unit and quantity, and not billed yet; an order line is a service line of a confirmed (or
// delivered, or closed) order of this customer, billed whole and not billed yet. The orders behind
// the lines must read prices the same way. Run at save and again at posting: drafts claim nothing,
// so another invoice may have billed a line in between.
function checkSources(data: WorkspaceData, customerId: string, lines: readonly LineRefs[]) {
  const issues: { path: string; code: ErrorCode }[] = [];
  const vatSettings = new Set<boolean>();
  const keptVariantIds = new Set<string>();
  const keptRateIds = new Set<string>();
  const same = (line: LineRefs, other: { variantId: string; unitId: string; quantity: string }) =>
    line.variantId === other.variantId &&
    line.unitId === other.unitId &&
    compareQuantity(line.quantity, other.quantity) === 0;
  const useOrder = (found: ReturnType<typeof orderLineOf>) => {
    if (!found) return;
    vatSettings.add(found.order.pricesIncludeVat);
    keptRateIds.add(found.line.taxRate.id);
  };
  const sources = lines.map((line, index): LineSource => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    if (line.deliveryLineId !== null) {
      const challan = challanLineOf(data, line.deliveryLineId);
      if (
        challan?.delivery.customer.id !== customerId ||
        challan.delivery.status !== 'posted' ||
        !same(line, challan.line)
      ) {
        at('deliveryLineId', 'invoice_delivery_line_invalid');
      } else if (challan.line.invoiced) {
        at('deliveryLineId', 'invoice_delivery_line_billed');
      }
      const orderLineId = challan?.line.orderLineId ?? null;
      keptVariantIds.add(line.variantId);
      useOrder(orderLineId === null ? undefined : orderLineOf(data, orderLineId));
      return { deliveryLineId: line.deliveryLineId, orderLineId };
    }
    if (line.orderLineId !== null) {
      const found = orderLineOf(data, line.orderLineId);
      // Goods on an order are billed through their challan: only the challan says they left
      if (
        found?.order.customer.id !== customerId ||
        !['confirmed', 'delivered', 'closed'].includes(found.order.status) ||
        found.line.productType !== 'service' ||
        !same(line, found.line)
      ) {
        at('orderLineId', 'invoice_order_line_invalid');
      } else if (!isZeroQuantity(found.line.invoicedQuantity)) {
        at('orderLineId', 'invoice_order_line_billed');
      }
      keptVariantIds.add(line.variantId);
      useOrder(found);
      return { deliveryLineId: null, orderLineId: line.orderLineId };
    }
    return { deliveryLineId: null, orderLineId: null };
  });
  if (issues.length > 0) throw issuesError(issues);
  if (vatSettings.size > 1) throw new MockProblem(409, 'invoice_vat_mixed');
  const [pricesIncludeVat] = [...vatSettings];
  return { sources, pricesIncludeVat: pricesIncludeVat ?? null, keptVariantIds, keptRateIds };
}

// The challan an invoice makes for its own goods names its lines lines.0, lines.1 …; on the
// invoice they are, say, lines.2 and lines.5. Each problem moves under the invoice line it belongs
// to, like the API's onInvoiceLines().
function onInvoiceLines<T>(indexes: readonly number[], fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof MockProblem) || error.fieldErrors === undefined) throw error;
    const fieldErrors = Object.fromEntries(
      Object.entries(error.fieldErrors).map(([path, codes]) => {
        const match = /^lines\.(\d+)\.(.+)$/.exec(path);
        const index = match ? indexes[Number(match[1])] : undefined;
        return [
          match && index !== undefined ? `lines.${String(index)}.${match[2] ?? ''}` : path,
          codes,
        ];
      }),
    );
    throw new MockProblem(error.status, error.code, fieldErrors, error.params);
  }
}

// A goods line of the invoice's own, as the challan it makes takes it
function stockLineOf(line: {
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: readonly string[];
}) {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: [...line.serialNumbers],
  };
}

// The lines of its own (neither a challan line nor an order line). A goods one is checked like a
// challan line now (warehouse, batch, serial numbers), because posting delivers it; a service one
// takes no batch or serial. Returns the stock line of each goods one, by its index: the invoice
// keeps its batch, lot and expiry for print.
function checkOwnLines(
  data: WorkspaceData,
  input: InvoiceFields,
  resolved: readonly ResolvedLine[],
  sources: readonly LineSource[],
): Map<number, StockLine> {
  const issues: { path: string; code: ErrorCode }[] = [];
  const goods: number[] = [];
  input.lines.forEach((typed, index) => {
    const source = sources[index];
    // A challan line or an order line (or no source at all) is not a line of its own
    if (source?.deliveryLineId !== null || source.orderLineId !== null) return;
    if (resolved[index]?.line.productType === 'goods') {
      goods.push(index);
      return;
    }
    const at = (field: string) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code: 'invoice_stock_not_allowed' });
    };
    if (typed.batchId !== null) at('batchId');
    if (typed.serialNumbers.length > 0) at('serialNumbers');
  });
  if (issues.length > 0) throw issuesError(issues);
  if (goods.length === 0) return new Map();
  if (input.warehouseId === null) throw fieldProblem('invoice_warehouse_required', 'warehouseId');
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const typed = goods.flatMap((index) => {
    const line = input.lines[index];
    return line ? [stockLineOf(line)] : [];
  });
  const stockLines = onInvoiceLines(goods, () => resolveLines(data, typed, 'out'));
  return new Map(
    goods.flatMap((index, position) => {
      const line = stockLines[position];
      return line ? [[index, line] as const] : [];
    }),
  );
}

// The customer's billing address as one text, the way the invoice prints it (15a has one per
// customer). Kept on the invoice, so a later change does not rewrite a posted invoice.
function billingAddressOf(data: WorkspaceData, customerId: string): string | null {
  const address = data.sales.customers
    .find((item) => item.id === customerId)
    ?.addresses.find((item) => item.kind === 'billing');
  if (!address) return null;
  return [address.label, address.address, address.phone]
    .filter((part): part is string => part !== null)
    .join('\n');
}
```

- **`checkSources()` runs at save and again at posting.** Drafts claim nothing, so another invoice may have billed
  a challan line in between; the second posting is refused with `invoice_delivery_line_billed`.
- **A challan line's order line comes from the challan, not from the form.** The form sends only
  `deliveryLineId`; the mock stores the order line behind it, as the API does, so the order's invoiced quantity and
  the "back to draft" rule find it.
- **Every line problem at once**, each under its own row (`lines.2.orderLineId`), so the form marks every wrong
  line after one click.
- **`onInvoiceLines()` moves the challan's errors to the invoice's rows.** The challan made for the invoice's own
  goods numbers its lines from 0. Without the move, "not enough stock" for invoice line 3 would show under line 1.
- **`checkOwnLines()` checks a goods line of its own like a challan line at save time**: the warehouse, the batch and
  the serial numbers (`resolveLines()`, the stock documents' own check). The person sees a problem when saving the
  draft, not only when posting. A service line of its own may not carry a batch or serials.
- **The billing address is kept as text** on the invoice, so a later change to the customer does not rewrite a
  posted invoice.

### Invoices: saving and posting

```ts
// --- Invoices: saving and posting ---------------------------------------------------------------

// A new draft, or a draft changed. Its number comes at posting.
export function saveInvoice(
  data: WorkspaceData,
  input: InvoiceFields,
  existing?: MockInvoice,
): MockInvoice {
  if (existing && existing.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  const customer = customerOf(data, input.customerId, existing?.customer.id ?? null);
  assertBranch(data, input.branchId);
  const checked = checkSources(data, customer.id, input.lines);
  // The orders' way of reading prices, else the draft's own, else the workspace's now
  const pricesIncludeVat =
    checked.pricesIncludeVat ?? existing?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
  const resolved = resolveSalesLines(
    data,
    input.lines,
    pricesIncludeVat,
    new Set([...checked.keptRateIds, ...ratesOf(existing?.lines ?? [])]),
    checked.keptVariantIds,
  );
  const own = checkOwnLines(data, input, resolved, checked.sources);
  const terms = data.sales.customers.find((item) => item.id === customer.id)?.paymentTermsDays;
  const lines = resolved.map(({ line }, index): InvoiceLine => {
    const source = checked.sources[index] ?? { deliveryLineId: null, orderLineId: null };
    const challan =
      source.deliveryLineId === null ? undefined : challanLineOf(data, source.deliveryLineId);
    const order = source.orderLineId === null ? undefined : orderLineOf(data, source.orderLineId);
    // The batch and serial numbers the goods leave with: the challan line's, or the line's own
    const stock = challan?.line ?? own.get(index);
    return {
      ...line,
      deliveryLineId: source.deliveryLineId,
      orderLineId: source.orderLineId,
      deliveryNumber: challan?.delivery.number ?? null,
      orderNumber: order?.order.number ?? null,
      batchId: stock?.batchId ?? null,
      lotNumber: stock?.lotNumber ?? null,
      expiresOn: stock?.expiresOn ?? null,
      serialNumbers: stock?.serialNumbers ?? [],
    };
  });
  const saved: MockInvoice = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    // An empty box: the customer's payment terms (step 15a), counted from the invoice date
    dueDate: input.dueDate ?? dueDateOf(input.date, terms ?? 0),
    customer,
    customerReference: input.customerReference,
    branchId: input.branchId,
    warehouseId: input.warehouseId,
    status: 'draft',
    pricesIncludeVat,
    ...totalsOf(resolved),
    billingAddress: billingAddressOf(data, customer.id),
    note: input.note,
    lines,
    lineCount: lines.length,
    entry: null,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
  const { invoices } = data.billing;
  data.billing.invoices = existing
    ? invoices.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...invoices];
  return saved;
}

// Only a draft. It claimed no challan line, so nothing is undone.
export function removeInvoice(data: WorkspaceData, target: MockInvoice): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  data.billing.invoices = data.billing.invoices.filter((item) => item.id !== target.id);
}

// What a posting did besides the invoice itself, for the handler's audit rows
export interface InvoicePosted {
  challan: MockDelivery | null;
  overridden: { limit: string; exposure: string } | null;
}

// The API's postAndLog(), in its order: the date, the customer and the branch checked again, the
// sources checked again, the number, the invoice's own goods out on a challan of their own, the
// challan lines marked billed, the order lines' invoiced quantity, the sale in the books, the
// credit check, and the invoice posted last. The handler runs it in a transaction(): a refused
// step leaves nothing, not even the challan it made.
export function postInvoice(
  data: WorkspaceData,
  draft: MockInvoice,
  overrideCreditLimit: boolean,
): InvoicePosted {
  if (draft.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  if (data.journal.lockDate !== null && draft.date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
  // Active now: the journal will not book a sale to an archived customer
  customerOf(data, draft.customer.id, null);
  assertBranch(data, draft.branchId);
  checkSources(data, draft.customer.id, draft.lines);
  const before = creditOf(data, draft.customer.id).exposure;
  data.billing.counters.invoice += 1;
  const number = seriesNumber(data, 'sales.invoice', data.billing.counters.invoice, draft.date);

  // The goods lines of its own leave on a challan of their own, from the invoice's warehouse
  const own = draft.lines.flatMap((line, index) =>
    line.deliveryLineId === null && line.orderLineId === null && line.productType === 'goods'
      ? [index]
      : [],
  );
  let challan: MockDelivery | null = null;
  if (own.length > 0) {
    const { warehouseId } = draft;
    if (warehouseId === null) throw fieldProblem('invoice_warehouse_required', 'warehouseId');
    const made = onInvoiceLines(own, () =>
      postDelivery(
        data,
        saveDelivery(data, {
          customerId: draft.customer.id,
          orderId: null,
          date: draft.date,
          warehouseId,
          shippingAddressId: null,
          vehicle: null,
          note: `Invoice ${number}`,
          lines: own.flatMap((index) => {
            const line = draft.lines[index];
            return line ? [{ ...stockLineOf(line), orderLineId: null }] : [];
          }),
        }),
      ),
    );
    own.forEach((index, position) => {
      const line = draft.lines[index];
      const out = made.lines[position];
      if (!line || !out) return;
      Object.assign(line, {
        deliveryLineId: out.id,
        deliveryNumber: made.number,
        batchId: out.batchId,
        lotNumber: out.lotNumber,
        expiresOn: out.expiresOn,
        serialNumbers: out.serialNumbers,
      });
    });
    challan = made;
  }

  // Each challan line billed once; what was billed onto its order line (a challan line's through
  // the order line it delivered, a service line's directly). The order keeps its version, like the
  // API's: a delivered or closed order's header is frozen.
  for (const line of draft.lines) {
    const billed =
      line.deliveryLineId === null ? undefined : challanLineOf(data, line.deliveryLineId);
    if (billed) billed.line.invoiced = true;
    const ordered = line.orderLineId === null ? undefined : orderLineOf(data, line.orderLineId);
    if (ordered) {
      ordered.line.invoicedQuantity = addQuantity(ordered.line.invoicedQuantity, line.baseQuantity);
    }
  }

  // Dr Accounts receivable (the customer) / Cr Sales / Cr Output VAT, every line with the
  // invoice's branch. A ৳0 invoice has no entry; an exempt sale has no VAT line.
  let entry: EntryRef | null = null;
  if (!isZeroMoney(draft.total)) {
    const accounts = salesAccounts(data);
    const lines = [
      side(accounts.receivable, draft.branchId, draft.customer.id, { debit: draft.total }),
      side(accounts.sales, draft.branchId, null, { credit: draft.net }),
      side(accounts.vatOutput, draft.branchId, null, { credit: draft.vat }),
    ].filter((line) => !isZeroMoney(line.debit) || !isZeroMoney(line.credit));
    entry = refOf(
      postNew(data, { date: draft.date, narration: `Invoice ${number}`, lines }, 'sales_invoice', {
        id: draft.id,
        number,
      }),
    );
  }
  const overridden = checkCredit(data, draft.customer.id, before, overrideCreditLimit);
  Object.assign(draft, {
    status: 'posted',
    number,
    entry,
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  return { challan, overridden };
}
```

- **The due date**: an empty box is the invoice date plus the customer's payment terms (`dueDateOf()`, the same
  function the form's hint uses).
- **The batch and serial numbers of each line** come from the challan line it bills, or from the stock check of a
  line of its own. The printed invoice shows them (a pharmacy's invoice lists each batch and its expiry).
- **`postInvoice()` follows the API's order of steps.** The checks come first, then the number, then the challan
  for the invoice's own goods (made with the 15b `saveDelivery()` and `postDelivery()`, so the stock and the cost
  of goods sold move exactly as for any challan), then the billed flags, the invoiced quantities, the sale in the
  books, and the credit check last, with this invoice counted.
- **The credit check comes after the change on purpose.** The exposure "after" must include this invoice and must
  no longer count its order lines as "on order". Working that out in advance would be a second copy of the rule.
  `transaction()` makes it safe: a refusal puts everything back.
- **The challan's lines point back at the invoice lines** (`deliveryLineId`), and the invoice line takes the
  challan's number and the batch it really left with.
- **The order keeps its version**, as in the API: a delivered or closed order's header is frozen.
- **A ৳0 invoice has no entry; an exempt sale has no VAT line.** Zero lines are dropped before `postNew()`, which
  also refuses an entry of fewer than two lines.
- **`postInvoice()` returns the challan it made and the override**, and the handler writes their audit rows.
  `record()` lives in `workspace-data.ts`, which imports this file, so calling it from here would close a circle.

### Money receipts

```ts
// --- Money receipts -----------------------------------------------------------------------------

export function findReceipt(data: WorkspaceData, id: string): MockReceipt {
  const found = data.billing.receipts.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The invoices it pays, oldest due date first: the order the form suggested them in
export function toReceipt(data: WorkspaceData, stored: MockReceipt): Receipt {
  const { allocations, ...receipt } = stored;
  return {
    ...receipt,
    applied: sumMoney(allocations.map((allocation) => allocation.amount)),
    allocations: allocations
      .flatMap((allocation) => {
        const invoice = data.billing.invoices.find((item) => item.id === allocation.invoiceId);
        // Only posted invoices are paid, so each has a number
        const number = invoice?.number ?? null;
        if (!invoice || number === null) return [];
        return [
          {
            invoiceId: invoice.id,
            invoiceNumber: number,
            invoiceDate: invoice.date,
            dueDate: invoice.dueDate,
            invoiceTotal: invoice.total,
            amount: allocation.amount,
          },
        ];
      })
      .toSorted((a, b) => a.dueDate.localeCompare(b.dueDate)),
  };
}

export function listReceipts(
  data: WorkspaceData,
  query: { status?: string | undefined; customerId?: string | undefined },
): Receipt[] {
  return newestFirst(data.billing.receipts)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toReceipt(data, item));
}

// The API's apply(): the whole list replaces the old one. Each invoice is a posted invoice of the
// receipt's customer, and gets no more than it still owes; what this receipt had on it counts as
// owed again, because it is being replaced. Every problem at once, under its own row.
function applyAllocations(
  data: WorkspaceData,
  receipt: MockReceipt,
  wanted: readonly MockAllocation[],
): void {
  const had = new Map(receipt.allocations.map((item) => [item.invoiceId, item.amount]));
  const issues: { path: string; code: ErrorCode }[] = [];
  wanted.forEach((allocation, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `allocations.${String(index)}.${field}`, code });
    };
    const invoice = data.billing.invoices.find((item) => item.id === allocation.invoiceId);
    if (invoice?.customer.id !== receipt.customer.id || invoice.status !== 'posted') {
      at('invoiceId', 'receipt_invoice_invalid');
      return;
    }
    const due = sumMoney([
      subtractMoney(invoice.total, paidOn(data, invoice.id)),
      had.get(invoice.id) ?? '0',
    ]);
    if (compareMoney(allocation.amount, due) > 0) at('amount', 'receipt_over_invoice');
  });
  if (issues.length > 0) throw issuesError(issues);
  receipt.allocations = wanted.map((allocation) => ({
    invoiceId: allocation.invoiceId,
    amount: addMoney(allocation.amount, '0'),
  }));
}

// Saved = posted: numbered, booked (Dr the money account / Cr Accounts receivable with the
// customer), then applied. The handler runs it in a transaction(): a refused allocation leaves no
// receipt and no entry.
export function createReceipt(data: WorkspaceData, input: ReceiptInput): MockReceipt {
  const customer = customerOf(data, input.customerId, null);
  assertBranch(data, input.branchId);
  // Exactly the list the form offers (contracts' moneyAccountIds)
  if (!moneyAccountIds(data.accounts).has(input.accountId)) {
    throw fieldProblem('receipt_account_invalid', 'accountId');
  }
  data.billing.counters.receipt += 1;
  const number = seriesNumber(data, 'sales.receipt', data.billing.counters.receipt, input.date);
  const id = crypto.randomUUID();
  const amount = addMoney(input.amount, '0');
  const accounts = salesAccounts(data);
  // The books first: a closed period refuses here, before any invoice is touched
  const entry = postNew(
    data,
    {
      date: input.date,
      narration: `Money receipt ${number}`,
      lines: [
        side(input.accountId, input.branchId, null, { debit: amount }),
        side(accounts.receivable, input.branchId, customer.id, { credit: amount }),
      ],
    },
    'sales_receipt',
    { id, number },
  );
  const receipt: MockReceipt = {
    id,
    number,
    date: input.date,
    customer,
    amount,
    method: input.method,
    reference: input.reference,
    accountId: input.accountId,
    branchId: input.branchId,
    status: 'posted',
    note: input.note,
    allocations: [],
    entry: refOf(entry),
    voidEntry: null,
    voidDate: null,
    voidReason: null,
    version: 1,
    updatedAt: now(),
  };
  data.billing.receipts = [receipt, ...data.billing.receipts];
  applyAllocations(data, receipt, input.allocations);
  return receipt;
}

// A voided receipt is final: before the version check, like the API's lock()
export function assertNotVoided(receipt: MockReceipt): void {
  if (receipt.status === 'voided') throw new MockProblem(409, 'receipt_voided');
}

// Apply the money again: an advance onto a new invoice, or moved from one invoice to another.
// Nothing in the books changes, only what each invoice still owes.
export function allocateReceipt(
  data: WorkspaceData,
  receipt: MockReceipt,
  allocations: readonly MockAllocation[],
): void {
  if (overAllocated(receipt.amount, allocations)) {
    throw new MockProblem(409, 'receipt_over_allocated', {
      allocations: ['receipt_over_allocated'],
    });
  }
  applyAllocations(data, receipt, allocations);
  Object.assign(receipt, { version: receipt.version + 1, updatedAt: now() });
}

// A bounced cheque: the money comes off the invoices, and the entry is reversed on the void date
// with the reason in its narration. The receipt stays, so its number is never missing.
export function voidReceipt(
  data: WorkspaceData,
  receipt: MockReceipt,
  input: { date: string; reason: string },
): void {
  if (input.date < receipt.date) throw fieldProblem('receipt_void_date', 'date');
  receipt.allocations = [];
  const reversal = reverseEntry(data, findEntry(data, receipt.entry.id), input.date, {
    allowSales: true,
    narration: `Money receipt ${receipt.number} voided: ${input.reason}`,
  });
  Object.assign(receipt, {
    status: 'voided',
    voidDate: input.date,
    voidReason: input.reason,
    voidEntry: refOf(reversal),
    version: receipt.version + 1,
    updatedAt: now(),
  });
}
```

- **`applyAllocations()` is the API's `apply()`.** The whole list replaces the old one, and what this receipt had
  on an invoice counts as owed again, because it is being replaced. Every problem comes back under its own row.
- **`createReceipt()` books first, then applies.** A closed period refuses at `postNew()`, before any invoice is
  touched. Only accounts from `moneyAccountIds()` are accepted: exactly the list the form's "Received into" offers.
- **`assertNotVoided()` runs before the version check**, like the API's `lock()`. A voided receipt is final, and
  "this receipt is voided" says more than "someone changed it".
- **`allocateReceipt()` checks the total against the receipt's own amount**, because the request does not send the
  amount (`receipt_over_allocated` under `allocations`).
- **`voidReceipt()` takes the money off the invoices, then reverses the entry** on the void date with the reason in
  the narration. It uses the journal's own `reverseEntry()` with `allowSales`: the Reverse button refuses sales
  entries, but a void is the receipt's own correction.

### `mocks/sales-data.ts`, `mocks/accounting-data.ts`, `mocks/journal-data.ts`, `mocks/product-data.ts`

```diff
@@ -432,8 +432,9 @@ function isReceivable(data: WorkspaceData, accountId: string): boolean {
   );
 }
 
-// What the customer owes: debit − credit of its posted receivable lines
-function balanceOf(data: WorkspaceData, partyId: string): string {
+// What the customer owes: debit − credit of its posted receivable lines. The credit limit
+// (invoice-data.ts) starts from the same number, like the API's CreditService.
+export function balanceOf(data: WorkspaceData, partyId: string): string {
   const lines = data.journal.entries
     .filter((entry) => entry.status === 'posted')
     .flatMap((entry) => entry.lines)
@@ -591,18 +592,23 @@ export function refreshPartyRefs(data: WorkspaceData, saved: MockCustomer): void
     }
   }
   const { quotations, orders, deliveries } = data.salesDocuments;
-  for (const document of [...quotations, ...orders, ...deliveries]) {
+  const { invoices, receipts } = data.billing;
+  for (const document of [...quotations, ...orders, ...deliveries, ...invoices, ...receipts]) {
     if (document.customer.id === saved.id) document.customer = ref;
   }
 }
 
 // Only a customer no entry and no sales document names, drafts included (the API's
-// journal_lines_party_fk, and step 15b's quotations/sales_orders/deliveries_customer_fk)
+// journal_lines_party_fk, step 15b's quotations/sales_orders/deliveries_customer_fk, and step
+// 15c's invoices/receipts_customer_fk)
 export function assertCustomerUnused(data: WorkspaceData, id: string): void {
   const { quotations, orders, deliveries } = data.salesDocuments;
+  const { invoices, receipts } = data.billing;
   const used =
     data.journal.entries.some((entry) => entry.lines.some((line) => line.party?.id === id)) ||
-    [...quotations, ...orders, ...deliveries].some((document) => document.customer.id === id);
+    [...quotations, ...orders, ...deliveries, ...invoices, ...receipts].some(
+      (document) => document.customer.id === id,
+    );
   if (used) throw new MockProblem(409, 'customer_in_use');
 }
 
```

- **`balanceOf()` is exported** for the credit limit.
- **A customer named on an invoice or a receipt cannot be deleted** (`customer_in_use`, the API's two new foreign
  keys), and a renamed customer shows the new name on them too.

```diff
@@ -17,6 +17,8 @@ interface MockNode {
   purpose?: AccountPurpose;
   children?: MockNode[];
   archived?: boolean;
+  // Step 15c: a money receipt goes into it (on a group: every account inside)
+  holdsMoney?: boolean;
 }
 
 const MAKERS: readonly Industry[] = ['garments', 'pharma', 'manufacturing'];
@@ -47,17 +49,23 @@ function template(industry: Industry): Record<AccountType, MockNode> {
           code: '1100',
           name: 'Current assets',
           children: [
-            { code: '1110', name: 'Cash in hand', purpose: 'cash' },
+            { code: '1110', name: 'Cash in hand', purpose: 'cash', holdsMoney: true },
             {
               code: '1120',
               name: 'Bank accounts',
+              holdsMoney: true,
               children: [
                 { code: '1121', name: 'Dutch-Bangla Bank CD A/C 1234' },
                 // Closed last year: shows up with "Show archived"
                 { code: '1122', name: 'Sonali Bank CD A/C 0071', archived: true },
               ],
             },
-            { code: '1130', name: 'Mobile wallets (bKash, Nagad)', children: [] },
+            {
+              code: '1130',
+              name: 'Mobile wallets (bKash, Nagad)',
+              holdsMoney: true,
+              children: [],
+            },
             { code: '1140', name: 'Accounts receivable', purpose: 'accounts_receivable' },
             stock,
             { code: '1170', name: 'Input VAT', purpose: 'vat_input' },
@@ -171,6 +179,7 @@ export function seedAccounts(industry: Industry): Account[] {
       type,
       isGroup: node.children !== undefined,
       purpose: node.purpose ?? null,
+      holdsMoney: node.holdsMoney ?? false,
       description: null,
       archivedAt: node.archived ? now : null,
       version: 1,
```

- **The money flags of the API's templates:** 1110 Cash in hand, and the groups 1120 Bank accounts and 1130 Mobile
  wallets. Every account inside a flagged group holds money, so the Dutch-Bangla Bank account is offered on the
  receipt form without a flag of its own.

```diff
@@ -8,6 +8,7 @@ import {
   formatDocumentNumber,
   isNegativeMoney,
   isPartyAccountPurpose,
+  isSalesJournalSource,
   isStockJournalSource,
   isZeroMoney,
   type JournalEntry,
@@ -274,12 +275,18 @@ export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
   });
 }
 
-// allowYearClose: only the year-end reopen (report-data.ts) may reverse a closing entry
+// allowYearClose: only the year-end reopen (report-data.ts) may reverse a closing entry.
+// allowSales: only a voided money receipt (invoice-data.ts) reverses its own entry, with its own
+// narration; the Reverse button refuses every sales entry (journal_is_sales, step 15c).
 export function reverseEntry(
   data: WorkspaceData,
   entry: JournalEntry,
   date: string,
-  { allowYearClose = false }: { allowYearClose?: boolean } = {},
+  {
+    allowYearClose = false,
+    allowSales = false,
+    narration,
+  }: { allowYearClose?: boolean; allowSales?: boolean; narration?: string } = {},
 ): JournalEntry {
   if (entry.status !== 'posted') throw new MockProblem(409, 'journal_not_posted');
   if (entry.source === 'reversal') throw new MockProblem(409, 'journal_is_reversal');
@@ -287,6 +294,10 @@ export function reverseEntry(
     throw new MockProblem(409, 'journal_is_year_close');
   }
   if (isStockJournalSource(entry.source)) throw new MockProblem(409, 'journal_is_stock');
+  // An invoice is corrected by a credit note (15d), a receipt by Void
+  if (isSalesJournalSource(entry.source) && !allowSales) {
+    throw new MockProblem(409, 'journal_is_sales');
+  }
   if (entry.reversedBy !== null) throw new MockProblem(409, 'journal_already_reversed');
   if (date < entry.date) {
     throw new MockProblem(409, 'journal_reversal_date', { date: ['journal_reversal_date'] });
@@ -295,7 +306,7 @@ export function reverseEntry(
     data,
     {
       date,
-      narration: `Reversal of ${entry.number ?? ''}`,
+      narration: narration ?? `Reversal of ${entry.number ?? ''}`,
       lines: entry.lines.map((line) => ({
         ...asInput(line),
         debit: line.credit,
```

- **Reverse refuses a sales entry** (`journal_is_sales`), as 15c.3 made the API do: an invoice is corrected by a
  credit note (15d), a receipt by Void.
- **`allowSales` and `narration` are options**, used only by `voidReceipt()`. The year-end reopen's
  `allowYearClose` works the same way.

```diff
@@ -321,6 +321,20 @@ export function garmentsCatalog(): MockCatalog {
       categoryId: null,
       tracking: 'serial',
     },
+    // Step 15c: a service an order can carry, billed straight from the order (no challan: a
+    // service is never delivered). A code of its own, outside the P-… series, so the next new
+    // product is still P-00006.
+    {
+      ...product(catalog, {
+        code: 'SVC-EMB',
+        name: 'Logo embroidery',
+        category: 'Finished garments',
+        base: 'pcs',
+        price: '18.0000',
+      }),
+      categoryId: null,
+      type: 'service',
+    },
   ];
   const generated = Array.from({ length: 10_000 }, (_, index) => {
     const garment = GARMENTS[index % GARMENTS.length] ?? 'T-shirt';
```

- **Its own code, `SVC-EMB`, outside the P-… series.** `products.e2e.ts` expects the next new product to be
  P-00006; a sixth P-number would have moved that.

### `mocks/handlers.ts`: the routes

```diff
@@ -13,6 +13,24 @@ import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';
 
 import { API_URL } from '../lib/api';
 import { meIn, OWNER, WORKSPACES, type Workspace } from './fixtures';
+import {
+  allocateReceipt,
+  assertNotVoided,
+  confirmWithCredit,
+  createReceipt,
+  creditOf,
+  findInvoice,
+  findReceipt,
+  listInvoices,
+  listReceipts,
+  type MockInvoice,
+  postInvoice,
+  removeInvoice,
+  saveInvoice,
+  toInvoice,
+  toReceipt,
+  voidReceipt,
+} from './invoice-data';
 import { mock, MockProblem, problem, readBody, readQuery, reply } from './mock';
 import {
   assertCanChange,
@@ -100,7 +118,6 @@ import {
 import {
   answerQuotation,
   changeOrderStatus,
-  confirmOrder,
   createOrder,
   findDelivery,
   findOrder,
@@ -109,6 +126,7 @@ import {
   listOrders,
   listQuotations,
   lookupPrices,
+  type MockOrder,
   pageOf,
   postDelivery,
   removeDelivery,
@@ -151,6 +169,8 @@ import {
   record,
   seriesList,
   startFresh,
+  transaction,
+  type WorkspaceData,
 } from './workspace-data';
 
 // mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
@@ -245,6 +265,37 @@ function assertCategoryPlace(
   if (taken) throw new MockProblem(409, 'category_name_taken', { name: ['category_name_taken'] });
 }
 
+// Only an asset account holds money (step 15c, the API's assertMoneyType)
+function assertMoneyType(holdsMoney: boolean, type: Account['type']): void {
+  if (holdsMoney && type !== 'asset') {
+    throw new MockProblem(409, 'account_money_type', { holdsMoney: ['account_money_type'] });
+  }
+}
+
+// Confirming an order checks the credit limit (step 15c). The audit rows are the API's: confirmed,
+// then the override when there was one, with the limit and what the customer owes now.
+function confirmAndRecord(data: WorkspaceData, order: MockOrder, overrideCreditLimit: boolean) {
+  const overridden = confirmWithCredit(data, order, overrideCreditLimit);
+  record(data, 'sales_order.confirmed', 'sales_order', order.id);
+  if (overridden) {
+    record(data, 'credit_limit.overridden', 'sales_order', order.id, diff({}, overridden));
+  }
+}
+
+// Posting an invoice, with the audit rows the API writes: the challan it made for its own goods
+// (created and posted), the credit override, then the invoice posted
+function postAndRecord(data: WorkspaceData, draft: MockInvoice, overrideCreditLimit: boolean) {
+  const { challan, overridden } = postInvoice(data, draft, overrideCreditLimit);
+  if (challan) {
+    record(data, 'delivery.created', 'delivery', challan.id);
+    record(data, 'delivery.posted', 'delivery', challan.id);
+  }
+  if (overridden) {
+    record(data, 'credit_limit.overridden', 'invoice', draft.id, diff({}, overridden));
+  }
+  record(data, 'invoice.posted', 'invoice', draft.id);
+}
+
 // UI-র প্রতিটা পথ দেখার জন্য: লগইনে পাসওয়ার্ড "wrong-password" → invalid_credentials,
 // সাইনআপে ঠিকানা "rahman-garments" → slug_taken
 export const handlers = [
@@ -712,6 +763,8 @@ export const handlers = [
       const data = current();
       const parent = parentFor(data.accounts, body.parentId);
       assertAccountCodeFree(data.accounts, body.code);
+      // A new account takes its parent's type
+      assertMoneyType(body.holdsMoney, parent.type);
       const created = {
         ...body,
         id: crypto.randomUUID(),
@@ -729,7 +782,13 @@ export const handlers = [
         created.id,
         diff(
           {},
-          { code: body.code, name: body.name, description: body.description, parent: parent.code },
+          {
+            code: body.code,
+            name: body.name,
+            description: body.description,
+            parent: parent.code,
+            holdsMoney: body.holdsMoney,
+          },
         ),
       );
       await delay();
@@ -750,11 +809,13 @@ export const handlers = [
         parentFor(data.accounts, fields.parentId, target);
       }
       assertAccountCodeFree(data.accounts, fields.code, id);
+      assertMoneyType(fields.holdsMoney, target.type);
       const snapshot = (account: Account) => ({
         code: account.code,
         name: account.name,
         description: account.description,
         parent: codeOf(data.accounts, account.parentId),
+        holdsMoney: account.holdsMoney,
       });
       const before = snapshot(target);
       Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
@@ -2222,6 +2283,15 @@ export const handlers = [
     }),
   ),
 
+  // The credit line on the order and invoice forms (step 15c)
+  mock(
+    routes.customers.credit,
+    guarded(({ params }) => {
+      const { id } = routes.customers.credit.params.parse(params);
+      return reply(routes.customers.credit, creditOf(current(), id));
+    }),
+  ),
+
   mock(routes.customerGroups.list, () => {
     const { sales } = current();
     return reply(routes.customerGroups.list, {
@@ -2513,18 +2583,19 @@ export const handlers = [
   mock(
     routes.salesOrders.create,
     guarded(async ({ request }) => {
-      const { confirm, quotationId, ...input } = await readBody(
+      const { confirm, quotationId, overrideCreditLimit, ...input } = await readBody(
         routes.salesOrders.create.body,
         request,
       );
       const data = current();
-      const saved = createOrder(data, input, quotationId);
-      record(data, 'sales_order.created', 'sales_order', saved.id);
-      // "Confirm order" on a new form: saved and confirmed in one step, like the API
-      if (confirm) {
-        confirmOrder(data, saved);
-        record(data, 'sales_order.confirmed', 'sales_order', saved.id);
-      }
+      // "Confirm order" on a new form: saved and confirmed in one step, or nothing at all, like
+      // the API (step 15c: the credit check may refuse the confirmation)
+      const saved = transaction(data, () => {
+        const created = createOrder(data, input, quotationId);
+        record(data, 'sales_order.created', 'sales_order', created.id);
+        if (confirm) confirmAndRecord(data, created, overrideCreditLimit);
+        return created;
+      });
       await delay();
       return reply(routes.salesOrders.create, toOrder(data, saved));
     }),
@@ -2534,19 +2605,18 @@ export const handlers = [
     routes.salesOrders.update,
     guarded(async ({ request, params }) => {
       const { id } = routes.salesOrders.update.params.parse(params);
-      const { confirm, version, ...input } = await readBody(
+      const { confirm, version, overrideCreditLimit, ...input } = await readBody(
         routes.salesOrders.update.body,
         request,
       );
       const data = current();
       const target = findOrder(data, id);
       checkVersion(target.version, version);
-      updateOrder(data, target, input);
-      record(data, 'sales_order.updated', 'sales_order', id);
-      if (confirm) {
-        confirmOrder(data, target);
-        record(data, 'sales_order.confirmed', 'sales_order', id);
-      }
+      transaction(data, () => {
+        updateOrder(data, target, input);
+        record(data, 'sales_order.updated', 'sales_order', id);
+        if (confirm) confirmAndRecord(data, target, overrideCreditLimit);
+      });
       await delay();
       return reply(routes.salesOrders.update, toOrder(data, target));
     }),
@@ -2570,12 +2640,16 @@ export const handlers = [
     routes.salesOrders.confirm,
     guarded(async ({ request, params }) => {
       const { id } = routes.salesOrders.confirm.params.parse(params);
-      const { version } = await readBody(routes.salesOrders.confirm.body, request);
+      const { version, overrideCreditLimit } = await readBody(
+        routes.salesOrders.confirm.body,
+        request,
+      );
       const data = current();
       const target = findOrder(data, id);
       checkVersion(target.version, version);
-      confirmOrder(data, target);
-      record(data, 'sales_order.confirmed', 'sales_order', id);
+      transaction(data, () => {
+        confirmAndRecord(data, target, overrideCreditLimit);
+      });
       return reply(routes.salesOrders.confirm, toOrder(data, target));
     }),
   ),
@@ -2694,4 +2768,154 @@ export const handlers = [
       return reply(routes.deliveries.post, toDelivery(data, target));
     }),
   ),
+
+  // Invoices and money receipts (step 15c). Every save that also posts runs in a transaction():
+  // a refused posting (stock, period lock, credit limit) leaves nothing behind, not even the draft.
+
+  mock(routes.invoices.list, ({ request }) => {
+    const query = readQuery(routes.invoices.list.query, request);
+    return reply(routes.invoices.list, pageOf(listInvoices(current(), query), query));
+  }),
+
+  mock(
+    routes.invoices.get,
+    guarded(({ params }) => {
+      const { id } = routes.invoices.get.params.parse(params);
+      const data = current();
+      return reply(routes.invoices.get, toInvoice(data, findInvoice(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.invoices.create,
+    guarded(async ({ request }) => {
+      const { post, overrideCreditLimit, ...input } = await readBody(
+        routes.invoices.create.body,
+        request,
+      );
+      const data = current();
+      const saved = transaction(data, () => {
+        const draft = saveInvoice(data, input);
+        record(data, 'invoice.created', 'invoice', draft.id);
+        if (post) postAndRecord(data, draft, overrideCreditLimit);
+        return draft;
+      });
+      await delay();
+      return reply(routes.invoices.create, toInvoice(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.invoices.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.invoices.update.params.parse(params);
+      const { post, overrideCreditLimit, version, ...input } = await readBody(
+        routes.invoices.update.body,
+        request,
+      );
+      const data = current();
+      const target = findInvoice(data, id);
+      checkVersion(target.version, version);
+      const saved = transaction(data, () => {
+        const draft = saveInvoice(data, input, target);
+        record(data, 'invoice.updated', 'invoice', id);
+        if (post) postAndRecord(data, draft, overrideCreditLimit);
+        return draft;
+      });
+      await delay();
+      return reply(routes.invoices.update, toInvoice(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.invoices.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.invoices.remove.params.parse(params);
+      const { version } = readQuery(routes.invoices.remove.query, request);
+      const data = current();
+      const target = findInvoice(data, id);
+      checkVersion(target.version, version);
+      removeInvoice(data, target);
+      record(data, 'invoice.deleted', 'invoice', id);
+      return reply(routes.invoices.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.invoices.post,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.invoices.post.params.parse(params);
+      const { version, overrideCreditLimit } = await readBody(routes.invoices.post.body, request);
+      const data = current();
+      const target = findInvoice(data, id);
+      checkVersion(target.version, version);
+      transaction(data, () => {
+        postAndRecord(data, target, overrideCreditLimit);
+      });
+      return reply(routes.invoices.post, toInvoice(data, target));
+    }),
+  ),
+
+  mock(routes.receipts.list, ({ request }) => {
+    const query = readQuery(routes.receipts.list.query, request);
+    return reply(routes.receipts.list, pageOf(listReceipts(current(), query), query));
+  }),
+
+  mock(
+    routes.receipts.get,
+    guarded(({ params }) => {
+      const { id } = routes.receipts.get.params.parse(params);
+      const data = current();
+      return reply(routes.receipts.get, toReceipt(data, findReceipt(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.receipts.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.receipts.create.body, request);
+      const data = current();
+      const saved = transaction(data, () => {
+        const receipt = createReceipt(data, body);
+        record(data, 'receipt.created', 'receipt', receipt.id);
+        return receipt;
+      });
+      await delay();
+      return reply(routes.receipts.create, toReceipt(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.receipts.allocate,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.receipts.allocate.params.parse(params);
+      const { version, allocations } = await readBody(routes.receipts.allocate.body, request);
+      const data = current();
+      const target = findReceipt(data, id);
+      assertNotVoided(target);
+      checkVersion(target.version, version);
+      allocateReceipt(data, target, allocations);
+      record(data, 'receipt.allocated', 'receipt', id);
+      await delay();
+      return reply(routes.receipts.allocate, toReceipt(data, target));
+    }),
+  ),
+
+  mock(
+    routes.receipts.void,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.receipts.void.params.parse(params);
+      const { version, ...input } = await readBody(routes.receipts.void.body, request);
+      const data = current();
+      const target = findReceipt(data, id);
+      assertNotVoided(target);
+      checkVersion(target.version, version);
+      transaction(data, () => {
+        voidReceipt(data, target, input);
+        record(data, 'receipt.voided', 'receipt', id);
+      });
+      await delay();
+      return reply(routes.receipts.void, toReceipt(data, target));
+    }),
+  ),
 ];
```

- **Every invoice and receipt handler follows the pattern of the other documents:** parse the body with the
  contract's schema, check the version, call the data function, write the audit rows, and reply through `reply()`,
  which checks the answer against the contract's response schema.
- **Every save that posts, and every void, runs in `transaction()`.** The audit rows are written inside it too, so
  a refused posting leaves no "invoice.created" row for an invoice that does not exist.
- **The order handlers now confirm through `confirmAndRecord()`.** A refused confirmation (over the limit) leaves
  the order as it was before the request; with "Confirm anyway" the audit log gets `credit_limit.overridden` with
  the limit and the exposure, after the "confirmed" row.
- **`postAndRecord()` writes the API's audit rows in the API's order:** the challan created and posted, the
  override, then the invoice posted.
- **`assertMoneyType()`**: "Holds money" only on an asset account. A new account takes its parent's type, so the
  check uses the parent's.

### `e2e/invoices.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, readOnlyItem, toastShown } from './helpers.js';

// Step 15c in the mock garments workspace. H&M's confirmed order SO-…-0001 asks for 5 dozen polo
// shirts in M and in L at ৳6,900 a dozen, zero-rated (an export). Aarong buys the crew-neck
// T-shirt at ৳290 a piece from the "Local wholesale" list, VAT 15% on top; it has a ৳5,00,000
// credit limit and 30 days to pay. Bengal Buying House buys for cash only (a ৳0 limit). The mock
// posts no invoice of its own: every invoice here is the test's.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

async function pickCustomer(page: Page, search: string, name: RegExp) {
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(search);
  await page.getByRole('option', { name }).click();
}

// Search the picker, add the product, and close the dialog (as in quotations.e2e.ts)
async function addItem(page: Page, search: string, name: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill(search);
  const row = dialog.getByRole('listitem').filter({ hasText: name });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
}

// A counter sale with no order: the invoice delivers its own goods from the Main store
async function newDirectInvoice(page: Page, search: string, customer: RegExp, quantity: string) {
  await openFromNav(page, 'Invoices');
  // The page header's button; the empty list has one too
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  await pickCustomer(page, search, customer);
  await addItem(page, 'crew-neck', 'Basic crew-neck T-shirt');
  await line(page, 1).getByLabel('Quantity').fill(quantity);
  await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
}

test('bills a challan at the order’s prices, and the challan shows it billed', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await listItem(page, /SO-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'New delivery' }).click();
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText('Not invoiced').first()).toBeVisible();

  await page.getByRole('button', { name: 'Make invoice' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  // Both challan lines, priced from the order: 10 dozen at ৳6,900, zero-rated
  await expect(line(page, 1).getByText(/From DC-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(line(page, 2).getByText(/From DC-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(page.getByText('৳69,000.00').first()).toBeVisible();
  // The challan's warehouse belongs to the head office: whose sale it is
  await expect(page.getByLabel('Branch')).toHaveValue(/.+/);
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Unpaid', { exact: true }).first()).toBeVisible();
  await expectNoSideScroll(page);

  // The printed page is in the document, hidden until the browser prints it
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toBeHidden();
  await expect(sheet).toContainText(/INV-\d{4}-\d{2}-0001/);
  await expect(sheet).toContainText('Rahman Garments Ltd.');

  // The sale in the books, and back from the entry to the invoice
  await page.getByRole('link', { name: /JV-\d{4}-\d{2}-\d{4}/ }).click();
  await expect(page.getByText('৳69,000.00').first()).toBeVisible();
  await page.getByRole('link', { name: /From INV-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();

  await page.getByRole('link', { name: /DC-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Invoiced', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make invoice' })).toHaveCount(0);

  // Billed in full: gone from "To invoice", listed under "Invoiced"
  await openFromNav(page, 'Deliveries');
  await page.getByRole('radio', { name: 'To invoice' }).check({ force: true });
  await expect(listItem(page, /DC-\d{4}-\d{2}-0001/)).toHaveCount(0);
  await page.getByRole('radio', { name: 'Invoiced' }).check({ force: true });
  await expect(listItem(page, /DC-\d{4}-\d{2}-0001/)).toBeVisible();
});

test('writes an invoice that delivers its own goods', async ({ page }) => {
  await newDirectInvoice(page, 'aarong', /Aarong/, '10');
  // The customer's credit: nothing owed or on order yet
  await expect(page.getByText('Credit left: ৳5,00,000 of ৳5,00,000')).toBeVisible();
  await expect(line(page, 1).getByText('Delivered by this invoice')).toBeVisible();
  // 10 at ৳290 = ৳2,900, plus 15% VAT = ৳3,335
  await expect(page.getByText('৳3,335.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

  // Posting made the challan that took the goods out: listed under "Challans"
  await page.getByRole('link', { name: /DC-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  // Its note names the invoice (the printed challan says it too)
  await expect(page.getByText(/Invoice INV-\d{4}-\d{2}-0001/).first()).toBeVisible();
  await expect(page.getByText('Invoiced', { exact: true }).first()).toBeVisible();

  await openFromNav(page, 'Invoices');
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Aarong');
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Unpaid');
  await expectNoSideScroll(page);
});

// The 1st of last month in the calendar of a date box: always before today, whatever today is
async function firstOfLastMonth(page: Page, box: string | RegExp) {
  await page.getByRole('button', { name: box }).click();
  await page.getByRole('button', { name: /previous month/i }).click();
  await page.locator('td[data-day$="-01"]:not([data-outside]) button').click();
}

test('shows an invoice past its due date as overdue', async ({ page }) => {
  await newDirectInvoice(page, 'aarong', /Aarong/, '1');
  await firstOfLastMonth(page, 'Invoice date');
  await firstOfLastMonth(page, /^Due date/);
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText('Overdue', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/This invoice was due on .+ days late\./)).toBeVisible();

  await openFromNav(page, 'Invoices');
  await page.getByRole('radio', { name: 'Overdue' }).check({ force: true });
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Overdue');
  await page.getByRole('radio', { name: 'Paid', exact: true }).check({ force: true });
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toHaveCount(0);
});

test('bills a service straight from its order', async ({ page }) => {
  // Aarong's draft order gets an embroidery charge, and is confirmed
  await openFromNav(page, 'Sales orders');
  await listItem(page, /Aarong/).click();
  await addItem(page, 'embroidery', 'Logo embroidery');
  await line(page, 2).getByLabel('Quantity').fill('100');
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0002 confirmed/);

  await openFromNav(page, 'Invoices');
  // The page header's button; the empty list has one too
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await page.getByRole('button', { name: 'Add order charges' }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('listitem')
    .filter({ hasText: /SO-\d{4}-\d{2}-0002/ })
    .getByRole('button', { name: 'Add', exact: true })
    .click();
  await page.keyboard.press('Escape');
  // Only the service: the T-shirts are billed from their challan once they leave
  await expect(line(page, 1).getByText(/Service on SO-\d{4}-\d{2}-0002/)).toBeVisible();
  await expect(line(page, 2)).toHaveCount(0);
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
  // 100 at ৳18 = ৳1,800, plus 15% VAT = ৳2,070
  await expect(page.getByText('৳2,070.00').first()).toBeVisible();

  // Billed: the order can no longer be taken back to draft
  await page
    .getByRole('link', { name: /SO-\d{4}-\d{2}-0002/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0002/ })).toBeVisible();
  await page.getByRole('button', { name: 'Back to draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Back to draft' }).click();
  await expect(page.getByText(/Invoices bill this order/)).toBeVisible();
});

test('asks before going over a credit limit, and records the override', async ({ page }) => {
  await newDirectInvoice(page, 'bengal', /Bengal Buying House/, '2');
  await expect(page.getByText('Cash only: no credit')).toBeVisible();
  await page.getByRole('button', { name: 'Post invoice' }).click();

  const dialog = page.getByRole('dialog', { name: 'Over the credit limit' });
  await expect(dialog).toContainText(/to ৳\S+, over their credit limit of ৳0\.00/);
  await dialog.getByRole('button', { name: 'Post anyway' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

  await openFromNav(page, 'Audit log');
  await expect(readOnlyItem(page, /credit limit/i).first()).toBeVisible();
});
```

- **The first test is the whole chain from 15b to 15c:** deliver H&M's order, "Make invoice" from the challan, see
  both lines priced from the order (10 dozen at ৳6,900, zero-rated = ৳69,000), post, follow the journal entry and
  come back through "From INV-…", then find the challan "Invoiced", without "Make invoice", and under the
  "Invoiced" filter of the deliveries list.
- **The printed page is checked hidden but present.** `toBeHidden()` proves the screen does not show it;
  `toContainText()` reads hidden text too, so the test proves the invoice number and the company name are on the
  paper without printing.
- **The direct invoice checks the credit line before posting** ("Credit left: ৳5,00,000 of ৳5,00,000") and the
  challan the posting made, with its note "Invoice INV-…".
- **`firstOfLastMonth()` picks the 1st of last month in the calendar.** That day is always before today, whatever
  day the test runs, so the invoice is overdue by at least a day. The `:not([data-outside])` skips the greyed days
  of the month before, which the calendar also shows.
- **The service test confirms Aarong's seeded draft with an embroidery line**, bills it through "Add order
  charges", and then finds "Back to draft" refused with the `order_has_invoices` text.
- **The credit test uses Bengal Buying House**, which buys for cash only (a ৳0 limit), so any invoice goes over. It
  posts through the dialog and finds the override in the audit log.
- **The form's heading is awaited before picking the customer.** The list page has a "Customer" filter button of
  its own; clicking too early opens the filter, and the page then changes under it.

### `e2e/receipts.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15c: money receipts in the mock garments workspace. Aarong buys the crew-neck T-shirt at
// ৳290 a piece plus 15% VAT, so 10 of them are a ৳3,335 invoice. The chart's money accounts are
// 1110 Cash in hand and everything inside the groups 1120 Bank accounts and 1130 Mobile wallets.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function pickCustomer(page: Page, search: string, name: RegExp) {
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(search);
  await page.getByRole('option', { name }).click();
}

// INV-…-0001 for Aarong: 10 T-shirts, delivered by the invoice itself from the Main store
async function postAarongInvoice(page: Page) {
  await openFromNav(page, 'Invoices');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill('crew-neck');
  const row = dialog.getByRole('listitem').filter({ hasText: 'Basic crew-neck T-shirt' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('10');
  await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);
}

test('takes a payment from the invoice, and voids it when the cheque bounces', async ({ page }) => {
  await postAarongInvoice(page);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Record a payment' })).toBeVisible();
  // What the invoice still owes, applied to it
  await expect(page.getByLabel(/Amount applied to INV-\d{4}-\d{2}-0001/)).toHaveValue('3,335.00');

  // Only money accounts: cash, and the bank account inside the "Bank accounts" group
  const account = page.getByLabel('Received into');
  await expect(
    account.getByRole('option', { name: '1121 · Dutch-Bangla Bank CD A/C 1234' }),
  ).toHaveCount(1);
  await expect(account.getByRole('option', { name: /Accounts receivable/ })).toHaveCount(0);
  await account.selectOption({ label: '1121 · Dutch-Bangla Bank CD A/C 1234' });
  await page.getByLabel('Paid by').selectOption({ label: 'Cheque' });
  await page.getByLabel('Reference (optional)').fill('Cheque 0045123, Sonali Bank Motijheel');
  // Three active branches: none is picked for the person
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 saved/);
  await expect(page.getByRole('heading', { level: 1, name: /MR-\d{4}-\d{2}-0001/ })).toBeVisible();

  await page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: /MR-\d{4}-\d{2}-0001/ }).click();

  await page.getByRole('button', { name: 'Void receipt' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Cheque bounced: not enough funds');
  await dialog.getByRole('button', { name: 'Void receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 voided/);
  await expect(page.getByText('Voided', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Voided on .+: Cheque bounced: not enough funds/)).toBeVisible();
  await expect(page.getByText('Not applied to any invoice.')).toBeVisible();

  // The money came off the invoice again
  await openFromNav(page, 'Invoices');
  await expect(listItem(page, /INV-\d{4}-\d{2}-0001/)).toContainText('Unpaid');
});

test('keeps an advance, and applies it to a later invoice', async ({ page }) => {
  await openFromNav(page, 'Money receipts');
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  // The list has a "Customer" filter too: wait for the form before picking
  await expect(page.getByRole('heading', { level: 1, name: 'Record a payment' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);
  await expect(
    page.getByText('This customer has no unpaid invoice. The whole amount stays as an advance.'),
  ).toBeVisible();
  await page.getByLabel('Amount').fill('5000');
  await page.getByLabel('Received into').selectOption({ label: '1110 · Cash in hand' });
  await page.getByLabel('Branch').selectOption({ label: 'Head office' });
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 saved/);
  await expect(page.getByText(/৳5,000\.00 is not applied to an invoice yet/)).toBeVisible();

  await postAarongInvoice(page);
  await openFromNav(page, 'Money receipts');
  await listItem(page, /MR-\d{4}-\d{2}-0001/).click();
  await page.getByRole('button', { name: 'Apply money' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Apply oldest first' }).click();
  await expect(dialog.getByLabel(/Amount applied to INV-\d{4}-\d{2}-0001/)).toHaveValue('3,335.00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toastShown(page, /MR-\d{4}-\d{2}-0001 applied/);
  // ৳5,000 − ৳3,335 = ৳1,665 still waits for an invoice
  await expect(page.getByText(/৳1,665\.00 is not applied to an invoice yet/)).toBeVisible();
  await expect(page.getByRole('link', { name: /INV-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expectNoSideScroll(page);
});
```

- **"Record payment" from the invoice opens the form with the invoice's balance already applied** (৳3,335.00). The
  test then checks the "Received into" list: the bank account inside the "Bank accounts" group is there, the
  receivable is not.
- **The branch is picked by hand.** The garments workspace has three active branches, so the form leaves the box
  empty rather than guess (15c.6).
- **Void comes back through the invoice**: after the void, the receipt shows "Voided" with its reason and no
  invoices, and the invoice is "Unpaid" again.
- **The advance test saves the money first, with no invoice to pay**, then posts an invoice and applies the money
  with "Apply oldest first" in the dialog: ৳3,335 applied, ৳1,665 left as an advance.

### `e2e/accounts.e2e.ts` and `e2e/sales-orders.e2e.ts`

```diff
@@ -114,3 +114,31 @@ test('protects system accounts, archives only empty groups and deletes in two cl
   await expect(page.getByText('Accumulated depreciation deleted')).toBeVisible();
   await expect(account(page, 'Accumulated depreciation')).toBeHidden();
 });
+
+// Step 15c: a money receipt goes into an account that holds money, ticked on the account itself or
+// on a group above it
+test('marks an account as holding money, or shows that its group does', async ({ page }) => {
+  await group(page, 'Bank accounts')
+    .getByRole('button', { name: 'Add an account to Bank accounts' })
+    .click();
+  const inBank = page.getByRole('dialog', { name: 'Add account' });
+  await expect(inBank.getByRole('checkbox', { name: 'Holds money' })).toBeChecked();
+  await expect(inBank.getByRole('checkbox', { name: 'Holds money' })).toBeDisabled();
+  await expect(
+    inBank.getByText('Holds money, because the group Bank accounts does.'),
+  ).toBeVisible();
+  await page.keyboard.press('Escape');
+
+  await group(page, 'Current assets')
+    .getByRole('button', { name: 'Add an account to Current assets' })
+    .click();
+  const dialog = page.getByRole('dialog', { name: 'Add account' });
+  await dialog.getByLabel('Name').fill('Petty cash, Gazipur factory');
+  await dialog.getByRole('checkbox', { name: 'Holds money' }).check();
+  await dialog.getByRole('button', { name: 'Add account' }).click();
+  await expect(dialog).toBeHidden();
+  await account(page, 'Petty cash, Gazipur factory').click();
+  await expect(
+    page.getByRole('dialog').getByRole('checkbox', { name: 'Holds money' }),
+  ).toBeChecked();
+});
```

- **A new account under "Bank accounts" shows the box ticked and locked**, with the reason; a new account under
  "Current assets" gets the box ticked by hand and keeps it after saving.

```diff
@@ -54,7 +54,8 @@ test('cancels a confirmed order that delivered nothing', async ({ page }) => {
   await openFromNav(page, 'Sales orders');
   await listItem(page, /SO-\d{4}-\d{2}-0001/).click();
   await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0001/ })).toBeVisible();
-  await expect(page.getByText('PO-HM-2026-1187')).toBeVisible();
+  // The first is the page's; the printed order (step 15c) has it too, hidden until printing
+  await expect(page.getByText('PO-HM-2026-1187').first()).toBeVisible();
   // Nothing went out yet: "Close" (stop delivering the rest) is for a partly delivered order
   await expect(page.getByRole('button', { name: 'Close order' })).toHaveCount(0);
 
```

- **`.first()` on the PO number.** The printed order of 15c.6 sits at the end of `<body>`, hidden on screen, and
  holds the same text. Playwright's strict mode refuses a locator that finds two elements, even if one is hidden.
  The page's own copy comes first in the document, so `.first()` is the one on screen.

### Check this part

```bash
pnpm --filter @omnivo/app exec tsc --noEmit
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts invoices receipts accounts sales-orders
```

The type check now has no errors left. The second line runs the new and the changed test files on both screen sizes
(30 tests, about a minute). Part 15c.8 runs the whole suite once more.

> **What we checked in this part.** The app type-checks with no errors (the six mock errors of 15c.6 are gone), and
> ESLint and Prettier are clean in `src/mocks` and `e2e`. The app's unit tests pass (64), and `pnpm boundaries`
> finds no circular import with the new file. The whole end-to-end suite ran once: 146 of 148 tests passed, and the
> two that failed were the 15b order test that found the PO number twice (fixed above); the fixed file passes
> (6 tests). All 16 new tests pass on desktop and phone. One check by breaking the mock on purpose: without the
> refusal in `checkCredit()`, the credit limit test fails.

---

## 15c.8 — Role templates, the OpenAPI document, and every check once

### `setup/templates.ts`: who bills and who collects

The role templates give a new workspace its roles (step 8). Each module's step adds its permissions to them; the
comment above `ACCOUNTANT` asks for it. 15b found this the hard way: nothing failed, a new workspace simply gave
nobody but the owner the right to write a quotation. So this part does it on purpose (decision 24):

```diff
@@ -106,6 +108,16 @@ const SALES_ADMIN = [...SELLING, 'sales.price_list.manage'] as const;
 const ORDERING = ['sales.quotation.manage', 'sales.order.manage'] as const;
 const DELIVERING = ['sales.delivery.manage'] as const;
 
+// Step 15c. The accountant bills and takes the money in, and so does a distributor's sales officer,
+// who collects from the retailers they sell to. The people who post challans do not bill them: the
+// person who lets goods out of the gate should not also decide what they cost the customer (a shop
+// manager or a small company's manager runs everything, so they get it all). A cashier takes money.
+// Going over a credit limit is a manager's decision, never the accountant's alone: the person who
+// books the sale should not also wave away the limit on it.
+const INVOICING = ['sales.invoice.manage'] as const;
+const COLLECTING = ['sales.receipt.manage'] as const;
+const CREDIT_OVERRIDE = ['sales.credit.override'] as const;
+
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
 const ACCOUNTANT: RoleTemplate = {
@@ -125,6 +137,9 @@ const ACCOUNTANT: RoleTemplate = {
     'inventory.stock.revalue',
     // Step 15a: the customers' accounts, their balances and statements, and the price lists
     ...SALES_ADMIN,
+    // Step 15c: invoices and money receipts
+    ...INVOICING,
+    ...COLLECTING,
   ],
 };
 
@@ -477,7 +498,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Sales officer',
         description: 'Orders and collections from retailers',
-        permissions: [...SELLING, ...ORDERING],
+        permissions: [...SELLING, ...ORDERING, ...INVOICING, ...COLLECTING],
       },
     ],
     chart: standardChart({
@@ -572,9 +593,12 @@ export const INDUSTRY_TEMPLATES = {
           ...SALES_ADMIN,
           ...ORDERING,
           ...DELIVERING,
+          ...INVOICING,
+          ...COLLECTING,
+          ...CREDIT_OVERRIDE,
         ],
       },
-      { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
+      { name: 'Cashier', description: 'Sells at the counter', permissions: [...COLLECTING] },
     ],
     chart: standardChart({
       stock: TRADER_STOCK,
@@ -620,6 +644,9 @@ export const INDUSTRY_TEMPLATES = {
           ...SALES_ADMIN,
           ...ORDERING,
           ...DELIVERING,
+          ...INVOICING,
+          ...COLLECTING,
+          ...CREDIT_OVERRIDE,
         ],
       },
     ],
```

- **Three constants, like 15b's `ORDERING` and `DELIVERING`.** A role lists what it does (`...INVOICING`), not
  permission keys, so a later step that splits a permission changes one line.
- **The Accountant bills and collects.** In most Bangladeshi companies the accounts desk raises the invoice from
  the challan and writes the money receipt. It does not get `sales.credit.override`: the person who books a sale
  should not also be the one who lets it past the limit.
- **The Sales officer of a distributor bills and collects.** The role's own description says "Orders and
  collections from retailers": the officer takes the money in the market and gives the shop an MR.
- **The Store keeper and the Depot manager do not bill.** They post the challans; the price is somebody else's
  decision. A direct invoice posts its own challan, but that is the invoice's permission, not theirs.
- **The Cashier takes money** (`sales.receipt.manage`). A retail cashier had no permission at all; the point-of-sale
  step will add more.
- **The Shop manager and the Manager get all three.** They run a small business alone; a template that made them
  ask someone else to bill would be wrong for them.

```diff
@@ -143,7 +143,9 @@ describe('starting the setup', () => {
           'inventory.stock.value',
           'sales.customer.balance',
           'sales.customer.manage',
+          'sales.invoice.manage',
           'sales.price_list.manage',
+          'sales.receipt.manage',
         ],
       ],
       [
```

- **The setup test** names every permission of the garments roles, so the Accountant's two new ones are added. The
  other industries are not in this test; `templates.spec.ts` checks that every key exists.

As in 15b, this changes **new** workspaces only. Your existing roles keep what they have; tick the new permissions
on the Roles page (15c.10).

### The OpenAPI document

No root file changes: no new package, no new script, no new `.env` line. Generate the API document again and
commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 133 paths (125 before)
```

The 8 new paths are `/invoices` (list and create), `/invoices/{id}` (one, change, delete), `/invoices/{id}/post`,
`/receipts` (list and create), `/receipts/{id}`, `/receipts/{id}/allocations`, `/receipts/{id}/void` and
`/customers/{id}/credit`. The order confirm path is not new, but its body is (`overrideCreditLimit`), and the
delivery list has a new `invoice` filter; both are in the regenerated file. `pnpm test:openapi` fails if the
committed file and the routes disagree.

The Drizzle snapshots (`migrations/meta/0029_snapshot.json`, `0030_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together. In the copy of the repo it found one thing, and it is fixed in the parts
above:

- **The printed table glued class names together** (`` `${HEAD} text-right` ``), against CLAUDE.md's "Class names"
  rule. It looked right, but only because of the order Tailwind happens to write the two `text-align` classes in.
  15c.6 now uses `cn()`, and its bullet says why.

The first full end-to-end run had 146 of 148 tests pass. The two others (the settings VAT test on a desktop and
"bills a service straight from its order" on a phone) ran out of time while the machine was busy (a load of about
20, with the type check running next to it); both passed when run again with two workers, together with every
test file that prints a document (42 tests). If a test times out on your machine, run
`pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts --last-failed --workers=2` before
looking for a bug.

---

## 15c.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components". The design system lists every pattern, and a pattern that is not listed there
does not exist for the next screen. After "Sales document statuses", add the new statuses:

> - **Invoice and receipt statuses:** invoice Draft (neutral, `FileEdit`), then by payment Unpaid (`brand`,
>   `Clock01`), Partly paid (`brand`, `Coins01`), Paid (`good`, `CheckmarkCircle02`), plus a second `crit` "Overdue"
>   pill (`Time04`) for a posted invoice not paid by its due date (worked out by the page, in the workspace's time
>   zone). Money receipt Posted (`good`, `CheckmarkCircle02`), Voided (neutral, `CancelCircle`). A challan's billing:
>   Not invoiced (neutral, `Invoice01`), Partly invoiced (`brand`, `Invoice03`), Invoiced (`good`, `Invoice02`), also
>   per line. An overdue invoice has a `warn` document notice (`Hourglass`) that says how many days.

After "Document notice":

> - **Credit line and credit dialog:** under the customer box on an order or invoice form, a 13px line: "Credit
>   left: ৳35,000 of ৳2,00,000 · ৳40,000 on confirmed orders" in `ink-3`, whole taka, `tabular-nums`; over the limit
>   it is `crit`/500 with a 15px `Alert02` icon. Shown only with `sales.customer.balance`. When the API refuses a
>   document over the limit, someone with `sales.credit.override` gets a dialog (what the customer would owe and the
>   limit, in paisa; "The audit log records that you went over the limit."; Back and "Confirm anyway" / "Post anyway"); everyone else
>   gets the error text under the form with the same amounts.
> - **Allocation table (money receipts):** the invoices the customer still owes on, oldest due date first, in an
>   `overflow-x-auto` box: invoice number (`Geist Mono`) with its dates under it, the total, what is still due
>   (500), and a money input for this receipt. Above it "Apply oldest first" and "Clear" (secondary `sm`); below
>   it a `subtle` row with Applied and "Left as advance" (or a `crit` "Over by ৳x" with an `Alert02` icon).

After "Logo", a new entry:

> - **Print layout:** `PrintSheet` and `PrintBlock` from `@omnivo/ui`. A document page renders its sheet into
>   `<body>`, hidden on screen; the browser's Print (`window.print()`) prints only the sheet, in the light palette
>   whatever the theme, on A4 with 12mm margins. White paper, `ink` text, 1px rules (`ink` under the header and the
>   table head, `line` between rows), no fills, no shadows, no radius. The header has the logo, the company (legal
>   name, address lines, BIN, phone) on the left, the document's title (24px) and its details on the right. Lines
>   are a real `<table>` whose `<thead>` repeats on every page; rows, blocks, totals and the signature lines use
>   `break-inside-avoid`. Only a numbered document prints (a draft on paper looks real); a voided receipt does not.

And in "Sidebar nav", nothing changes in the rules; the two new items are Sales → Invoices (`Invoice03`) and Money
receipts (`MoneyReceive02`).

**build-plan.bn.md** — in the "ধাপ ১৫: Sales — চারটা গাইডে" block, replace the line
`**১৫c** invoice, payment, credit limit · **১৫d** return ও credit note।` with:

> **১৫c (invoice → money receipt → credit limit):** invoice (post করলে INV নম্বর; এক কাস্টমারের এক বা একাধিক posted
> challan বিল করে — challan-এর প্রতিটা লাইন পুরোটা, একবারই; order-এর service লাইন সরাসরি; নিজের goods লাইন থাকলে
> invoice নিজেই একটা challan post করে, তাই COGS একবারই)। Post করলে Dr AR (কাস্টমার) / Cr Sales / Cr VAT payable।
> Unpaid / Partly paid / Paid, due date পেরোলে Overdue। Money receipt (MR, save করলেই নম্বর ও entry; Dr টাকার
> account / Cr AR), পুরনো invoice আগে (FIFO) ধরা হয়, বাকিটা advance; ভুল বা চেক ফেরত হলে বাতিল (reversal)।
> Credit limit order confirm ও invoice post-এ চেক, `sales.credit.override` থাকলে এগিয়ে যাওয়া যায় (audit log)।
> Chart of accounts-এ "Holds money"। কোটেশন, order, challan, invoice, receipt — এক A4 প্রিন্ট লেআউট (ব্রাউজারের
> Print / Save as PDF, offline)। Mushak 6.3 পরে।
> **১৫d** return ও credit note।

**COMMANDS.md** — in "Look at the data", after the sales order queries:

````markdown
```sh
# posted invoices not fully paid, oldest due first (overdue = due before today, in the database's date)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.number, p.name AS customer, i.due_date, i.total - i.amount_paid AS due, i.due_date < current_date AS overdue FROM invoices i JOIN tenants t ON t.id = i.tenant_id JOIN parties p ON p.tenant_id = i.tenant_id AND p.id = i.customer_id WHERE i.status = 'posted' AND i.amount_paid < i.total ORDER BY i.due_date"
# money receipts with money not yet applied to an invoice (advances)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, r.number, p.name AS customer, r.date, r.amount - r.applied AS unapplied FROM receipts r JOIN tenants t ON t.id = r.tenant_id JOIN parties p ON p.tenant_id = r.tenant_id AND p.id = r.customer_id WHERE r.status = 'posted' AND r.applied < r.amount ORDER BY r.date"
# invoices whose "paid" differs from their allocations (should print nothing; a trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.number, i.amount_paid, coalesce(sum(a.amount), 0) AS allocated FROM invoices i JOIN tenants t ON t.id = i.tenant_id LEFT JOIN receipt_allocations a ON a.tenant_id = i.tenant_id AND a.invoice_id = i.id GROUP BY t.slug, i.id, i.number, i.amount_paid HAVING i.amount_paid <> coalesce(sum(a.amount), 0)"
# posted invoices with an amount but no journal entry (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.number, i.date FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.status = 'posted' AND i.total > 0 AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.tenant_id = i.tenant_id AND e.source = 'sales_invoice' AND e.document_id = i.id)"
```
````

The four queries were run against a database migrated to 0030. The last two are checks, like 15b's: if one of them
ever prints a row, something wrote to the tables without going through the API. The first one's "overdue" uses the
database's date (UTC in Docker); the app uses the workspace's time zone, so the two can differ for a few hours
after midnight.

---

## 15c.10 — Run it

```bash
pnpm install
pnpm db:migrate                               # 0029 + 0030: four tables, their rules, money accounts, three permissions
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: the API has new routes
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('invoices', 'invoice_lines', 'receipts', 'receipt_allocations');   -- t
SELECT key FROM permissions WHERE key LIKE 'sales.%' ORDER BY key;   -- nine keys: 15a's three, 15b's three, 15c's three
SELECT t.slug, a.code, a.name FROM ledger_accounts a JOIN tenants t ON t.id = a.tenant_id
 WHERE a.holds_money ORDER BY t.slug, a.code;                        -- your cash account and the two money groups
```

### What you will see

1. **Your existing roles do not have the new permissions.** As the owner you have them all. For your team: Roles
   → Sales → tick "Write, post and delete draft sales invoices" and "Record money receipts, apply them to invoices
   and void them" for the accounts desk, and "Confirm orders and post invoices over a customer's credit limit"
   only for a manager.
2. **Accounting → Chart of accounts**: Cash in hand, "Bank accounts" and "Mobile wallets" hold money (the third
   query above). If the list is empty or misses one (you renamed or moved them), open the account or the group and
   tick **Holds money**; the receipt form offers only these accounts.
3. **Settings → Numbering** has a new series: Money receipt (`MR`). Invoice (`INV`) was there since step 6.
4. **Sales → Customers** → a customer → **Edit**: set a credit limit, say ৳50,000. The customer page shows "On
   order" and "Credit left".
5. **A posted challan** (15b) now says "Not invoiced". **Make invoice**: the form has the challan's lines at the
   order's prices, the branch from the challan's warehouse, and the due date from the payment terms. **Post
   invoice**: `INV-…-0001`. The challan says "Invoiced", the order's lines count what is billed, and the invoice
   says "Unpaid".
6. **Accounting → Journal**: an entry "Invoice INV-…": Dr Accounts receivable (with the customer) / Cr Sales / Cr
   VAT payable. Its document link opens the invoice; Reverse is not offered.
7. **Sales → Invoices → New invoice**, no challan: **Add items**, pick a warehouse, post. The invoice delivered its
   own goods: a new challan `DC-…` with the note "Invoice INV-…", and its cost of goods sold, are there too.
8. **Confirm an order** that takes the customer over ৳50,000: as the owner you get the dialog with both amounts;
   "Confirm anyway" confirms it, and Settings → Audit log has a row "Went over a customer’s credit limit".
9. **Record payment** on an invoice: the money receipt form has the invoice applied. Pick the bank account,
   "Cheque" and its number, **Save**: `MR-…-0001`, the invoice says "Partly paid" or "Paid". Save a receipt with
   more than the customer owes: the rest shows as "Left as advance", and **Apply money** on the receipt puts
   it on the next invoice.
10. **Void** the receipt with a reason ("Cheque bounced: not enough funds"): the receipt says "Voided", the invoice owes
    again, and the journal has the reversal.
11. **Print** on an invoice → the browser's print preview shows one A4 page with your company, the BIN and the lines,
    without the sidebar or the buttons, white even in the dark theme. Please look at it here, and at a long invoice
    over two pages: this is the one thing the tests could not look at.
12. **Bangla** and **390px**: the invoice lines stack each line's controls with their labels, the allocation table
    scrolls inside its own box, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 322: contracts 139 + api 82 + app 64 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 307 — 29 new
pnpm test:tenant-leak        # 59 — 4 new
pnpm test:e2e                # 148: 74 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 192.7 KB gz; receipt form 97.4, invoice list 96.8, invoice lines 90.8, invoice form 87.4
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **"Invoiced quantity" per challan line became a yes/no flag** (15c.1, decision 5). You were told the first; the
  second is the same rule with part-billing ruled out, and much simpler to guard.
- **A service billed straight from an order slipped past 15b's `order_has_deliveries`** (seen while writing the
  guards in 15c.2): nothing was delivered, so Reopen and Cancel were allowed on a billed order. The new
  `order_has_invoices` refuses them (15c.3).
- **Two parallel tests proved nothing about the locks** (15c.4). Two confirms and two receipts at the same moment
  passed even with the locks removed, because taking the next number from the series already made them wait for
  each other. Two tests now replay the other writer by hand, and they fail without the locks.
- **The `receipt.allocated` audit row left out an invoice the money was taken off** (15c.5, found while writing
  the audit words): the diff walked only the new list. Removed invoices are now listed as `null`, and a test proves
  it.
- **Four older pages went over the 100 KB budget without being touched** (15c.6): the contracts' `routes` chunk
  grew with the two new documents. The report hooks moved to their own file, and the journal entry form and the
  order form load their customer box and date picker lazily.
- **The hidden print sheet repeats the page's text** (15c.7): Playwright's strict mode found the buyer's PO number
  twice on the order page. Any test that reads text that is also printed needs `.first()` or a role locator.
- **Class names glued with a template string** in the printed table (15c.8, above).
- **No bug in the API was found by its tests** (15c.4): every failure while writing them was in the test itself.
  The break-it-on-purpose checks show the tests can fail.

---

## Notes left for later steps

**Step 15d (returns and credit notes):**

- **A credit note corrects a posted invoice** (decision 6): Dr Sales, Dr VAT payable / Cr Accounts receivable, with
  the customer. Give it the invoice it corrects, and let a money receipt be applied to it the other way (a refund),
  or let its amount reduce the invoice's due. `amount_paid` is kept by a trigger (decision 17); a credit note
  needs its own column or its own allocation rows, never a write to `amount_paid`.
- **A sales return brings goods back** at the cost they left with (the delivery line's `value`), not today's
  average, and reverses that part of the cost of goods sold. A billed challan line (decision 5) is returned in
  part; an unbilled one can be returned and then billed for the rest — decide which, and say how the challan's
  "Invoiced" pill reads after a return.
- **The credit limit must count credit notes** as money the customer no longer owes. `CreditService.exposure()`
  reads the receivable's balance, so a credit note's entry is enough; check that a return of goods not yet billed
  lowers "on order" only if it belongs to an order.
- **The journal's Reverse refuses sales sources** (`isSalesJournalSource`): add the credit note's source to that
  list, or Reverse would undo a credit note without touching its document.
- **The bundle budget**: the receipt form is at 97.4 KB, the invoice list at 96.8 KB, the receipt and order lists
  at 96 KB. 15d's contracts will grow the shared `routes` chunk again; split those first, the way 15c.6 did.

**Step 16 (document output):**

- **The PDF in the worker** can start from `print-documents.tsx`: the same blocks, the same words, the same
  `print.*` keys. The amount in words ("কথায় টাকা") and Mushak 6.3 belong there.

**Notes for any step:**

- **Run `pnpm boundaries` and a whole-repo `pnpm typecheck` while building**, not only at the end. 15c's parts each
  checked their own package; an earlier part's change that breaks a later file shows up only in the whole run.
- **A module's role-template permissions are part of its step** (15c.8). Check `apps/api/src/setup/templates.ts`
  whenever a step adds a permission.
