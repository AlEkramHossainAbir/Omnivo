# Step 20c: The POS, part 3 — returns, exchanges and the shift reports

> The implementation guide for "Phase 6 → Step 20", the last of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 20 (the POS screen) is split into three guides: 20a
> (registers, receipt numbers, the sale screen, payment, posting and the thermal receipt), 20b (shifts, the cash count,
> pay in and pay out, held bills, the idle lock) and this one (returns, refunds, exchanges and the X and Z reports).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `d10de0e`, your commit named
> "implemented pos screen": 20b's code and its doc updates) and checked from 2026-11-01 to 2026-11-02: `pnpm dedupe
> --check` (see 20c.8: it fails for a reason outside this step), `pnpm lint`, `pnpm format`, `pnpm typecheck`,
> `pnpm test` (833 — 44 new), `pnpm test:integration` (638 — 21 new), `pnpm test:tenant-leak` (125 — 3 new), `pnpm build`,
> `pnpm test:bundle-size` (first load 224.8 KB gz, budget 225; the return dialog 133.6 KB and the payment 130.0 KB,
> budget 135; the worker's list 431 files, 1440.4 KB gz, budget 2 MB), `pnpm test:openapi`, `pnpm boundaries`,
> `pnpm test:e2e` (Playwright on the mocks, 346 — 8 new) and `pnpm test:e2e:pwa` (the worker on a production build,
> 4) — with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database's rules on Postgres** (20c.2): 73 SQL checks (row-level security, the register's return settings, a
>   return's lines, batches and refunds that must add up, a line or a batch of another sale, a return that never
>   changes, the exchange's rules on a sale's payment, a return after its shift was closed, the shift's cash refunded,
>   the change log of the `pos_sale` rows). No race script: the register's row lock and the unique indexes are the
>   only places two sessions meet.
> - **The return through the API** (20c.3, 20c.4): a temporary end-to-end test before the tests were written (a return,
>   an exchange with the clearing account back at zero, an over-return after the window with its four audit rows, the
>   pages), then the tests. Broken on purpose: the batch order and the pull's register filter; their tests failed.
> - **The device** (20c.6a): the outbox's `after` rule taken out on purpose made the order test fail. The tests found
>   the rounding of decision 65.
> - **The managers' pages** (20c.6b): `zReportOf()` made to keep every tender failed the Z report's test.
> - **The return in the mock app** (20c.7): a cash return with the slip and the X and Z reports, an exchange (and
>   dropping it), a return offline of a sale made offline, and the register's return settings, on both screen sizes,
>   three times over. The tests failed before the three fixes they led to (decisions 96 to 98), and with
>   `withWaitingReturns()`'s `sent` filter taken out.
> - **The return against the real API in a browser** (20c.8): a cash return online, a sale and its exchange offline,
>   the sync in order, the X report, the close with the cash refunds out of the drawer, the Z report, and the managers'
>   pages.

## Goal

🔁 **Taking goods back at the counter.** After step 20b, a counter sells inside a shift and counts its drawer. But a
customer who comes back with the wrong size has nowhere to go: the sale cannot change, and the books of steps 15d and
17d are for invoices, not for receipts. This step adds the POS return: the cashier scans the receipt, ticks what came
back, and pays the money back, or uses it at once for the next sale. And a shift now prints its report.

After this step:

- **A return is a document of its own** (POS1-R000012), made on the device, offline too. The sale never changes; its
  page lists its returns.
- **Never more than was sold,** at the price it was sold for: each line's own share of the discounts and the VAT,
  to the paisa, so all the returns of a line add up to the line.
- **The money goes back by cash or the way it came,** or as an **exchange**: the return's money pays for a new sale
  saved with it, so the cash never leaves the drawer and comes back.
- **Goods go back into the register's warehouse,** at what they cost when they were sold.
- **A register takes goods back for some days** (7 by default). The screen refuses an older sale; the server takes it
  and writes the audit log.
- **The X report** (any time during the shift, offline too) and **the Z report** (after the close) print on the
  receipt printer. The X report is blind, like the count.

## The whole picture

```
packages/contracts   pos-returns.ts: the return (POS1-R000012) · posReturnAmounts() · the window · the sale a
      │               return reads (online by number, offline from the device) · the managers' list and page
      │               pos.ts: the exchange tender · a register's exchange account, return days, last return number ·
      │               a sale's returns · pos-shifts.ts: cash refunded · the X and Z report
      │               sync.ts: protocol 4, pos_sale rows, pos_return.create · pos.return.create · 16 errors ·
      │               the pos_return journal source and movement kind
      ▼
packages/db          pos_returns, their lines, batches and refunds; the register's new columns (20c.2)
      ▼
apps/api             the return posted · the exchange · the sale by number · the returns list (20c.3)
      ▼
packages/sync        the register's recent sales on the device, the return and the exchange in the outbox (20c.6)
      ▼
apps/app             F6 Return on /pos · the exchange in the pay dialog · X and Z · POS returns pages (20c.6)

the front counter of a super shop in Agrabad, Chattogram, on a Saturday:
  10:42 a customer brings back a polo shirt, size M, from Thursday's POS1-000164 (2 shirts, ৳736 each with VAT)
        Sumi presses F6 and scans the receipt: "1 of 2 left to return" ──► she ticks 1
        "Exchange: use on a new sale" ──► the cart opens with "From return POS1-R000012 · ৳736"
        she scans a size L shirt at ৳850 ──► Pay: exchange ৳736 + cash ৳114 ──► Complete sale
        outbox: pos_return.create (POS1-R000012) then pos_sale.create (POS1-000377, pays with the return)
  14:10 a walk-in brings back a phone case: POS1-R000013, ৳450 back in cash
  16:00 X report: 214 sales, 2 returns, taken and paid back by each way ── no drawer total (the count is blind)
  the server, in that order:
     return R000012  Dr Sales returns 640 · Dr VAT payable 96 / Cr POS exchange clearing 736
                     Dr Inventory / Cr Cost of goods sold at the shirt's cost on Thursday; the shirt is back in stock
     sale 000377     Dr POS exchange clearing 736 · Dr Cash at counter 114 / Cr Sales 739.13 · Cr VAT 110.87 …
                     ──► the clearing account is back at zero
     return R000013  Dr Sales returns 391.30 · Dr VAT 58.70 / Cr Cash at counter 450
  21:30 the close: expected cash is ৳450 less ──► Z report: counted, expected, the difference
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| A store credit or gift voucher kept for a later visit | An exchange is used at once, with the return (decision 7); a voucher is a liability of its own |
| A damage or quarantine warehouse on the register | Goods come back to the register's warehouse; damaged ones leave with a stock adjustment (decision 3) |
| Returning part of a pack (1 piece of a dozen) | A return is in the sale line's unit (decision 17) |
| Day and branch summaries, a cashier's sales report | Step 21's reports; the X and Z are one shift's only (decision 4) |
| Card or bKash refunds sent through the gateway | The cashier refunds on the machine or the app; the books record it with its reference |
| Undoing a return | A return is final, like a sale; a mistake is a new sale |

## What changes in the code you already have

- **The contract (20c.1):** a new `pos-returns.ts` (the return's number, window and arithmetic, the sale a return reads,
  the device's input, the managers' list and page, three routes). `pos.ts`: the exchange tender, a register's exchange
  account, return days and last return number, a sale's exchange payment and its returns. `pos-shifts.ts`: the cash
  the returns paid back, the shift's returns and refunds, and the X and Z report's shape. `sync.ts` moves to protocol
  4, with the `pos_sale` rows and the `pos_return.create` command. One permission, 16 error codes, the audit actions,
  the `pos_return` journal source and movement kind, and the routes. `openapi.json` is generated again.
- **The database (20c.2):** four new tables (`pos_returns`, their lines, batches and refunds) in `schema/pos.ts`; a
  register's exchange account, return days and last return number; a sale payment's `return_id` and the `exchange`
  tender. Migration 0055 (generated) and 0056 (the rules: row-level security, the return's checks at commit, the
  exchange check on a sale, the shift's cash refunds, the change log of the `pos_sale` rows). The journal's document
  check lists `pos_return`; the permission catalog has the new permission's text.
- **The API (20c.3):** a new `PosReturnsService` posts a return from the push and answers the four return routes; a
  shared `pos-returnable.ts` builds the sale a return reads. The sale takes an exchange payment and lists its returns;
  the register has its exchange account and return days; the shift's page has the refunds and the Z report's sums; the
  pull sends the `pos_sale` rows of the register the device holds; the push runs `pos_return.create`. The books get a
  `posReturn` entry, the account guard two new foreign keys, and the retail template the exchange account and the new
  permission. One contract route is added (decision 45).
- **The API tests (20c.4):** a new `pos-returns.int.spec.ts`; two checks of the 20a and 20b suites follow the new
  answers (a sale's `pos_sale` row and a payment's `return`, the shift's `cashRefunded`), and the tenant-leak suite also
  covers the returns.
- **The words (20c.5):** `en.ts` and `bn.ts` get the return screen, the exchange, the X and Z reports, the managers'
  POS returns pages, the register's two new fields, the 16 error codes, the permission, the audit actions and fields,
  the journal source and the movement kind, and the Sync page's name of a return.
- **The device and the counter (20c.6a):** `packages/sync` keeps the register's recent sales (`posSales`, Dexie version
  6), saves a return and an exchange with its sale, adds up the X report's sums in the shift, and sends a return after
  its sale. The POS screen gets the return flow (F6), the exchange in the cart and the pay dialog, the return slip and
  the X and Z reports. Two fixes of earlier parts: a sale's line ids are made on the device (decision 64) and a return
  shares the total, not the net (decision 65). Four new words; the lazy budget is 135 KB.
- **The managers' pages (20c.6b):** two new pages, the POS returns list and a return's page, with their routes and a
  nav item under Sales. The register form gets the return days and the exchange account; a sale's page shows what came
  back, its exchange payment's return and its returns; a shift's page the cash paid back, the refunds, the Z report's
  sums, a link to its returns and "Print Z report". The journal and the stock card link a POS sale and a POS return.
  Two new words.
- **The mock server and the browser tests (20c.7):** the mock gets the returns (a new `mocks/pos-return-data.ts`), the
  exchange payment, a register's return fields, the shift's refunds and the `pos_sale` rows of the pull and the push;
  a new `e2e/pos-returns.e2e.ts`. Three fixes of earlier parts, found by the tests: the POS bar on a phone (`Logo` in
  `packages/ui` gets `markOnPhone`, decision 97), the second return of a receipt (decision 98) and the register form's
  account selects (decision 96).
- **The finish (20c.8):** no code. A return and an exchange run once against the real API in a browser, and every
  check runs once.
- **Not touched:** `packages/auth`, the service worker (`apps/app/sw/`), the sign-in and the device set-up, and the
  documents of steps 15 to 17. `packages/ui` gets only `Logo`'s `markOnPhone` (decision 97).

## The decisions behind this step

You made the first nine: 1–4 on 2026-11-01 for this guide, on top of step 20's decisions 2 and 8, and 5–9 on
2026-11-01 while the contract was written. The others came up while building it; please read them with care: they are
mine.

1. **An exchange is one flow.** (You chose this.) The return's money can become a payment line of the next sale ("From
   return POS1-R000012"), so the cash does not go out of the drawer and come back in. It passes through a clearing
   account and links the two documents.
2. **The return window is a register setting.** (You chose this.) "Returns allowed for N days" (7 by default). The
   screen refuses an older sale; the server never refuses one when it arrives, it writes an audit row (like 20a's
   discount rule).
3. **Goods always go back into the register's warehouse,** whatever register sold them. (You chose this.) Damaged
   goods leave it later with a stock adjustment. The register has no damage warehouse.
4. **X and Z reports print on the receipt printer.** (You chose this.) X at any time during the shift, from the shift
   menu, offline too (from the device's data). Z after the close, from the close's result and from the shift's page.
   Day and branch summaries wait for step 21.
5. **A return's number is `POS1-R000012`.** (You chose this.) Each register has its own return series, 6 digits, and
   the device numbers it like a sale; the register keeps its last return number. The R keeps a return apart from a
   receipt on paper.
6. **The exchange account is a field of the register,** like its over/short account. (You chose this.) It may be
   empty: that counter makes no exchanges, only refunds. The retail template adds a "POS exchange clearing" account
   (a liability). You chose retail and pharmacy; while building 20c.3 it turned out that the pharma template is a
   pharmaceutical company with depots, with no cashier role and no over/short account, so it gets none.
7. **The return and its exchange sale are saved together** at "Complete sale", the return first. (You chose this.) The
   sale never uses more of the return's money than it costs; the rest is the return's refund, by cash or the way the
   sale was paid. If the cashier drops the new cart, the return goes back to the refund dialog. No open credit is left
   anywhere.
8. **The window is 0 to 365 days.** (You chose this.) A return is allowed while today is at most N days after the
   sale's date; 0 = the same day only. There is no "off" and no "no limit": a counter that takes nothing back has
   cashiers without `pos.return.create`.
9. **The X report is blind.** (You chose this.) It shows the sales, the returns, what each tender took and paid back,
   VAT, discounts, pay ins and pay outs, but never what the drawer should hold. The Z report shows the expected cash,
   the count and the difference.

**The contract (20c.1):**

10. **Exchange is a tender, not a payment method.** `POS_TENDERS` is the four methods and `exchange`. A sale's payment
    and a return's refund take a tender; a register's accounts and the pay dialog's buttons (`registerMethods()`) stay
    the four methods. Nobody picks exchange by hand, and it has no account per method but the register's exchange
    account. Folding it into `POS_PAYMENT_METHODS` would have put a liability account among the money accounts, and an
    "Exchange" button in the pay dialog.
11. **An exchange payment names its return** (`returnId`), and only an exchange does; a sale uses one return. The
    device always makes them so, so one code covers every break of the rule (`pos_exchange_invalid`). The existing
    rule "what is not cash is at most the total" (`pos_change_not_cash`) already keeps an exchange from paying more
    than the sale costs. `returnId` defaults to `null`, so a sale from before this update, still in an outbox, parses.
12. **The register's last return number is in what the claim answers,** and left out of the device's row, like the
    last sale number: it changes with every return.
13. **A return's money is worked out by shares up to a point** (`posReturnAmounts()`). What a return of `q` pays back
    is what the line carries up to the end of this return less what it carries up to its start. Three returns of one
    shirt each, of a line of three at ৳100, give back 33.33, 33.34 and 33.33: they add up to the line, and only the
    quantity returned before is needed, never the amounts. A whole line comes back exactly as it was sold, not rounded.
    The total and the VAT are shared this way, and the net is the total less the VAT (decision 65, found in 20c.6a).
14. **The device sends the amounts it worked out** (`net` and `vat` per line), and the books take them: the money was
    paid back already, and the drawer and the books must agree. The server works them out again and writes
    `pos_return.amounts_differ` when the two differ (another counter took some of the line back first).
15. **The refunds add up to the return's total exactly** (`pos_refund_mismatch`). A return gives no change. A return of
    ৳0 (a free sample) has no refund at all.
16. **A batch product's line sends no batch.** The server puts the goods back into the batches the sale line left
    from. A serial product's line sends the serial numbers that came back, ticked from the sale line's.
17. **A return line is in the sale line's unit.** Two dozen sold come back as dozens, at the line's price. Returning
    one piece of a dozen would need a price per piece the sale never had.
18. **The screen offers cash and the ways the sale was paid** (`refundMethodsOf()`); money that came from an exchange
    goes back as cash. The server takes any method the register has an account for, and refuses one it has none for
    (`pos_method_not_set`, like a sale).
19. **A return needs a shift,** of the register that takes the goods back: the cash leaves that drawer. Its `shiftId`
    is required (there is no return from before 20b to read).
20. **A return is never refused for the window, for more than is left, or for permission.** The server posts it and
    writes the audit log (`outside_window`, `over_returned`, `amounts_differ`, `without_permission`). It refuses only
    what someone can put right (`pos_method_not_set`, `pos_exchange_not_set`) and bugs.
21. **The device keeps its register's sales of the last 30 days** as rows of a new entity, `pos_sale`, with what was
    returned of each line, for returns offline. Only the register the device holds: a supermarket's ten counters over
    a month would be too much for one browser. Online, the screen asks the server by the receipt number, for any
    register (`GET /pos/sales/by-number/:number`, `pos.return.create`). The device drops rows older than 30 days
    itself: nothing changes on the server when a sale turns 31 days old. How the rows reach the device after it takes
    a register is decision 45.
22. **One shape for both** (`posReturnableSaleSchema`): the route's answer and the device's row are the same, so the
    return screen reads either the same way.
23. **An accepted sale or return sends the sale's row back,** so the screen knows at once what is left to return.
24. **Protocol 4.** A new entity and new register fields: every device does one full pull after the update.
25. **One journal source, `pos_return`,** a stock document's source like `pos_sale`, and one movement kind,
    `pos_return`. The journal's Reverse refuses it; a return is never undone.
26. **The drawer should hold less by the cash refunds** (`ShiftCash.cashRefunded`). An exchange never touches the cash.
27. **A shift's page has what the Z report needs:** the returns' count and total in the summary, and the refunds per
    tender, the sales' discount and VAT, and the returns' VAT on the page.
28. **The report is a TypeScript shape, not a schema** (`PosShiftReport`): the API never sends it. The device makes it
    from its own data and the shift's page from `posShiftSchema`, and both print one sheet. Its `drawer` is `null` on an
    X report (blind) and on the Z of a shift closed without a count.
29. **The window counts calendar days in UTC** (`lastReturnDayOf()` uses `shiftIsoDate()`), so no time zone moves a day.
    The form's box is text; an empty box is an error, not 0, because 0 is the strictest rule.
30. **Reading the returns needs no permission,** like the sales. Finding a sale to take back needs `pos.return.create`:
    only the cashier's screen asks.
31. **A sale's page lists its returns** and, per line, what came back; an exchange payment names its return.
32. **A return's list row says whether it came after the window** (`outsideWindow`) and which sale its money paid for
    (`exchangeSale`).
33. **The cashier's own mistakes have error codes too** (`pos_return_too_old`, `pos_return_nothing_left`,
    `pos_return_quantity_too_large`), though only the device checks them: the screen shows every message through
    `errors.*`.

**The database (20c.2):**

34. **A return has no customer and no "prices include VAT" of its own.** Both are the sale's, read through `sale_id`.
    A copy on the return could only disagree with the sale.
35. **A return line keeps only what is its own:** the quantity, the money, the cost and the serial numbers. The
    product, the unit, the description, the price and the VAT rate are the sale line's. `variant_id` stays on the
    line because the foreign key to the sale line uses 20a's index on `(tenant_id, variant_id, id)`, so
    `pos_sale_lines` needs no new index.
36. **"A line of another sale" is caught at commit, not by a foreign key** (`pos_return_lines_sale_match`). A
    foreign key would need `sale_id` on every line and a new unique index on `pos_sale_lines`, a table with rows that
    is locked while the index is built. The same check makes sure a serial number that comes back is one the line
    sold.
37. **A batch row points at a batch row of the sale line.** Goods can only go back into a batch the line left from:
    the foreign key to `pos_sale_line_batches` says so. The row carries `sale_line_id` for it, and its foreign key to
    the return line carries the same `sale_line_id`, so the two cannot disagree.
38. **The exchange link is on the sale's payment** (`return_id`), not on the return. The return is written first,
    so it cannot point at a sale that is not there yet. A unique index lets one sale use a return; the sale's commit
    check makes sure the return is of the same shift and that the payment is exactly its exchange refund
    (`pos_sale_payments_exchange_match`).
39. **The database does not check "no more than is left" or the window.** The server takes both and writes the audit
    log (decision 20). It checks that the return adds up, is of its sale, pays back its total exactly, and puts batch
    goods back in amounts that add up.
40. **A return may arrive after its shift was closed,** like a late sale (20b). The foreign key checks the shift's
    register and device, not that it is open.
41. **The shift's cash function gets a column, `cash_refunded`.** Postgres cannot change what a function returns with
    `CREATE OR REPLACE`, so 0056 drops it and makes it again. Every caller reads its columns by name.
42. **A sale's row is logged with the sale's warehouse.** The change log's `warehouse_id` was only for stock; now a
    POS sale uses it too, so only the devices of the sale's branch hear about it. A return logs its sale (what is left
    to return changed), with the sale's warehouse, also when another branch took the goods back. Which device of the
    branch keeps the row is the loader's business (20c.3).
43. **The last return number works like the last number:** it only grows, a return moves it in the same
    transaction, and moving it sends nothing to the devices.
44. **The new register columns fill themselves:** `return_days` is 7 on every old register, `last_return_number` 0,
    and `exchange_account_id` stays empty, so an old register makes no exchanges until someone picks the account.

**The API (20c.3):**

45. **The device reads its register's recent sales once, right after it takes the register**
    (`GET /pos/registers/:id/sales`, a route added to the contract in this part), and the pulls keep them up to date
    from then on. A sign-out deletes the device's copy and lets go of the register, and a sign-in starts with a full
    pull while no register is held, so no pull would ever bring those sales: they were logged before the device held
    the register. The other way, logging every recent sale again at each claim, would send thousands of deletes to
    every other device of the branch at each change of cashier. The pages follow the register's own receipt numbers,
    which no device's clock can put out of order.
46. **The pull knows which register the device holds** (`SyncScope.registerId`) and the first day it keeps
    (`posSalesFrom`, 30 days before the workspace's today). The other devices of the branch hear a sale's key too and
    get a delete for a row they never had: one small line per sale, like the stock rows they already get.
47. **An exchange payment posts to the account its return's exchange refund used,** not the register's exchange
    account of now. The two always meet on one account and it comes back to zero, even when someone changed the
    register's account between the return and the sale. So a sale never needs `pos_exchange_not_set`; only the return
    does.
48. **A return locks its sale `FOR UPDATE`.** Two counters taking back the same receipt are written one after the
    other, so the second sees the first's lines, and `over_returned` is right. Nothing else locks a sale (it never
    changes), so a return waits only for another return of the same receipt.
49. **A return's entry is in two branches, like a sales return of 15d.** The sales returns, the VAT and the cost come
    off the branch of the sale's warehouse; the refunds and the goods are in the branch of the register that took them
    back. Online a counter may take back another branch's receipt, and that branch's sales should fall, not this one's.
50. **A return line's base quantity uses the sale line's unit as the product has it now.** A pack that a document used
    is never removed (step 12), so the factor is there; the screen and the server work it out the same way.
51. **The goods come back at the same shares of their cost as the money** (`posReturnAmounts()` on the line's value),
    so all the returns of a line take back exactly what it cost. A quantity beyond what was sold comes back at no cost:
    it is a race between two counters, and the audit log has it.
52. **A batch line goes back into the batches the sale line left from,** in the order the sale took them (the
    cashier's batch first), each up to what it gave less what earlier returns put back. Anything beyond goes into the
    first one, because the database wants every piece in a batch the line left from.
53. **A serial number comes back with its number only when it can:** it left with the sale, it is in no warehouse now
    and on no truck. One the sale took as a piece without its number (sold short, 20a), or one back in stock since,
    comes back as a piece without one. Posting it with its number would be refused (`stock_serial_in_stock`), and a
    return is never refused for stock.
54. **A refund's missing account names the right fix:** the first problem's code is the answer's code
    (`pos_exchange_not_set` or `pos_method_not_set`), and each refund's own code is under `refunds.N.method`.
55. **A receipt number that is not there is `pos_return_sale_not_found` with 404** on the route, so the screen shows its
    own sentence ("No receipt with this number"), not a general "not found". In the push the same code is a 409 under
    `saleId`: a bug, since a return waits for its sale in the outbox.
56. **The shift's page lists every method the register takes for payments and refunds** (৳0 when nothing), and the
    exchange only when a sale or a return used it: a register's exchange account is not a way of taking money.
57. **The sales returns account is read by a function** (`salesReturnsAccount()`), not a method of
    `SalesBooksService`, so the POS return's entry reads the same setting with the same checks.

**The words (20c.5):**

58. **The words come before the mockup.** The screens of 20c.6 are drawn from them, and the mockup may still rename a
    few. A key that 20c.6 adds or changes shows in that part's diff of the two locale files, like 20b.6a's one key.
59. **Exchange has a name among the methods** (`pos.methods.exchange`), because the shift's page, the sale's page and
    the reports list amounts by tender (decision 10). The register's accounts (`registers.accounts`) and the pay
    dialog's reference placeholders stay the four methods: nobody picks exchange by hand.
60. **The cashier's words are "take goods back" and "pay back"; the document is a "return".** "Refund" is the 15d
    document of a sales return, and the sentence on a busy counter is "give back ৳450 in cash". The list's money column
    says "Given back", not "Total", so nobody reads it as a sale.
61. **The Sync page names a return by its number and counts its lines** (`sync.returnLines`), with no money, like
    20b's shift commands. A sale keeps its "3 lines · ৳2,300" from 20a.
62. **"No receipt with this number" is one sentence for online and offline** (`pos_return_sale_not_found`, decision
    55). Offline it is the common case (another counter's receipt), so the sentence says what to do: connect.
63. **The X report prints why it has no drawer total** (`pos.report.blind`). A cashier who reads an X report for the
    first time looks for the cash; the line says the count at the close shows it (decision 9).

**The device and the counter's screens (20c.6a):**

64. **A sale's line ids are made on the device** (you chose this, asked in 20c.6a). The server made them before, so a
    return could not name a line of a sale still in the outbox, sold offline ten minutes earlier. `savePosSale()` gives
    every line a UUIDv7, the server keeps it (a line from an old outbox gets one of the server's), and a line id used
    twice is `sync_id_taken`. The device writes the sale into its own sales in the same transaction, so the return
    screen finds it at once. Cross-part fix: 20c.1 (`pos.ts`), 20c.3 (`pos-sales.service.ts`, `sync-push.service.ts`),
    20c.4 (one test).
65. **A return shares the line's total and VAT, and the net is the rest** (found in 20c.6a, fixed in 20c.1's
    `posReturnAmounts()`). Sharing the net and the VAT one by one rounded twice: one shirt of two sold at ৳420 came back
    at ৳420.01, the other at ৳419.99. The cost (decision 51) has no VAT, so it comes out the same as before.
66. **The device keeps its sales in a table of their own, `posSales`** (Dexie version 6, no upgrade: protocol 4 makes the
    next pull a full one). The receipt number and the day stay clear, like a barcode and a date: the return screen
    searches the number exactly, and the old rows go by the day. Everything else is sealed.
67. **The device drops a sale older than 30 days at the end of every pull,** by the server's clock in UTC less 30 days.
    UTC's day is never after Dhaka's, so the device keeps a day more at most, never less than the server sends.
68. **The POS screen reads the register's recent sales, not the chooser.** The claim says whether they are on the device
    (`salesLoaded`); while not, the screen reads them as soon as it is online, inside the sync lock
    (`SyncEngine.exclusive()`), so a pull never writes the same rows at the same moment. A read that fails is tried
    again the next time the screen is drawn online. Change register drops them in the claim's own transaction.
69. **An outbox row can wait for another by its key** (`after`). A return waits for its sale while the sale is on the
    device; an exchange's sale waits for its return. The return's own chain is its id, so a refused change to the sale's
    customer holds no return back.
70. **A return is a counter command** (`isCounterCommand()`): discarded only once the server refused it, like a sale.
    The money went back and the slip was printed.
71. **The X report's sums are counted on the device** (`ShiftTally`), in the same transaction as each sale and return,
    like 20b's cash. A shift opened before the update has no tally and no cash refunded in its box; it reads as zero,
    so its X report counts the sales made since the update.
72. **An exchange waits in the cart until "Complete sale"** (`PosCartExchange`). Nothing is saved before, so dropping
    it moves no money. A reload keeps it; Hold and the held list are off while it is there, Clear leaves it, and the
    close asks to complete or drop it first: the close drops held carts, and the goods came back already.
73. **The banner and the pay row show the return's next number** from the claim. The save gives the real one; only a
    return in another tab at the same moment could take it first.
74. **"Drop the exchange" asks first** (the mockup's open point 3), and the return goes back to paying the money back
    with the same lines and note. Two new words (`dropTitle`, `keep`), one for the close (`closeFirst`) and the refund
    step's Back (`pos.return.back`).
75. **The return screen asks the server first when online** (any register's receipt), and the device's own sales when
    the server does not have it (sold offline) or does not answer. Either way the returns still in the outbox are added.
76. **The screen checks the window and "nothing left" when the receipt is found, and "more than is left" per line.**
    The server takes the return anyway and writes the audit log (decision 20); these are the cashier's rules.
77. **The refund's methods are cash and the ways the sale was paid that this register takes** (`refundMethodsAt()`).
    A method the register has no account for would be refused at the server.
78. **An exchange prints its return slip and its sale's receipt in one print,** the slip first, with a cut between.
    Two prints in a row would open two print dialogs.
79. **The X and Z reports are printed by the page, from the device's own shift,** offline too. The X report needs no
    cart, so the shift menu's request stops at the page; the sheet leaves once printed.
80. **A return still in the outbox does not add stock back on the screen.** The screen shows less, never more, until the
    next pull.
81. **The lazy budget is 135 KB** (you chose this): the return dialog with `/pos` is 133 KB and the pay dialog 129.5 KB,
    after the refund rows moved to a file of their own. The first load stays at 225 KB.

**The managers' pages (20c.6b):**

82. **The POS returns pages are the POS sales pages' twins:** the same register filter, the same "needs a connection"
    offline, no permission to read them (decision 30), and the same facts in the same order on a return's page.
83. **A shift's page links to its own returns** (`/pos/returns?shiftId=…`). The list then has no register filter (the
    shift has one register) and names the shift instead, with "Show every return" (two new words, `posReturns.ofShift`
    and `showAll`). The shift's number comes from the rows: the link is there only when the shift has returns. A
    `shiftId` that is not a uuid is dropped, so a hand-typed link shows every return, not an error.
84. **A return's pills:** Posted (`good`, `CheckmarkCircle02`) like a sale; After the window (`warn`, `Hourglass`), like
    a credit note long after its invoice; Exchanged for POS1-000377 (neutral, `ArrowLeftRight`, the counter's exchange
    icon): a fact, nothing to act on. The page's notice for the window is `warn` with `Hourglass` too.
85. **A return's lines are a small table of their own,** not `SalesLinesTable`: a return line has no discount and no VAT
    rate of its own (decision 35), so two of the shared table's columns would always be empty. The totals are the same
    `SalesTotals` block, with no discount row.
86. **An exchange is a refund row that links its sale** ("Used on POS1-000188"), and the sale's exchange payment links
    its return ("From return POS1-R000012"), so a manager can walk from one document to the other.
87. **"Print return slip" prints the counter's slip again** from the server's return (`slipOfReturn()`), on the
    register's paper and footer of today, like a sale's reprint.
88. **The Z report prints from a closed shift's page** (`zReportOf()`), from the server's sums: on any computer of the
    workspace, for a shift closed on a device that is gone. An open shift has no Z (its sums still change), and the X
    report stays the counter's (decision 79). A shift closed without a count prints a Z without the drawer.
89. **The shift's page shows what the Z report prints:** "Cash paid back" in the drawer's sum, the sales' discounts and
    VAT under what they took, and a third card, "Paid back by method", with the returns' count, total and VAT.
90. **The register form's "Returns" group** has the days and the exchange account side by side. The account select
    offers active liability accounts that are not groups, the ones the API takes (`pos_exchange_account_invalid`), and
    its empty choice says "No exchanges: refunds only". The days go to the route as text, as the box has them: the route
    reads the form's input, and the schema makes them a number.
91. **The journal and the stock card link a POS sale and a POS return.** 20a left the sale's link out; a return's entry
    would have been the only stock document without one. A return's entry shows its own hint (decision 25), not the
    stock documents' "post another stock document", which does not put a return right.
92. **`ShiftFact` moved to `pos-sale-parts.tsx`,** for the return's page. Not to `pos-shift-parts.tsx`: the bell imports
    that file, so it is in the first load, and the link and the permission check would grow it.

**The mock server and the browser tests (20c.7):**

93. **The mock keeps the returns in `data.pos.returns`, beside the sales and the shifts** (`pos-data.ts`), because a sale
    reads what came back of each line and a shift what its returns paid back. What a return does is a new file,
    `pos-return-data.ts`, like `pos-shift-data.ts` in 20b: it imports `pos-data.ts`, never the other way round.
94. **The seed adds 2190 POS exchange clearing** under current liabilities, and the head office's two counters (POS1,
    POS2) make exchanges through it. The depot's counter and the pharmacy's pay money back only, so both register states
    are in the mock. Like 5340 in 20b, the account is added where the counters are seeded, not in the chart template,
    which the sign-up's "50 accounts" counts.
95. **The mock's sale line keeps what its goods cost** (`value`, the API's column), because a return takes its share of
    that back into stock. What came back of a line is not kept on it: it is read from the returns when the sale is read,
    like the API's join, so it can never go stale.
96. **The register form waits for the accounts, not only the warehouses** (a fix in 20c.6b's `pos-registers.tsx`). The
    form's account selects got their values before their options arrived, showed the empty choice, and a save then
    cleared the exchange account without a word (or was refused for the over/short account). It was there since 20a, for
    the cash and card selects too; the test that opens POS1's form on a fresh page found it.
97. **On a phone the POS bar shows the logo's mark without the word** (`<Logo markOnPhone />`, a new prop in
    `packages/ui`; the word stays for screen readers). 20c.6a's Return button made the bar 437px wide on a 390px phone:
    the page scrolled sideways and the product tiles covered the cart bar, so no Pay button could be pressed. Every POS
    test on a phone failed. 20b's decision 99 hid the POS pill for the same reason; the word "Omnivo" is the next
    widest thing that says nothing the screen does not show.
98. **Online, the return screen asks for the sale inside the sync lock, and adds only the returns never sent** (a fix
    in 20c.6a's `findSale()` and `withWaitingReturns()`). A second return of a receipt right after the first said
    "Everything on this receipt came back already": the server had counted the first return, and the outbox still had it
    because its push's answer was on the way. Leaving the sent ones out alone made the opposite race (sent, not run yet:
    counted nowhere). Inside the lock no push runs, so an outbox return either never reached the server or went with a
    push whose answer was lost; only that last, rare case counts nowhere, and the server takes the over-return with its
    audit row (decision 20). The cost: a find waits for a sync that is running, a moment on a counter's small pulls.
99. **The browser tests seed no old POS sales.** A sale in the seed moves stock and posts an entry, which the stock,
    journal and report tests of other steps count. So a receipt older than the window, and another register's receipt
    found online, are checked by the unit tests (`saleProblem()`) and the API tests (20c.4), not in the browser.

## 20c.1 — `packages/contracts`: the contract

The contract first. A new file, `pos-returns.ts`, holds the return: its number, its window, its arithmetic, the sale it
reads, what the device sends and what the managers read. `pos.ts` gets the exchange tender and the register's return
settings, `pos-shifts.ts` the refunds and the report, `sync.ts` the sales on the device and the command. The rest are
short lists.

### `pos-returns.ts` (new): the return, its money and its sale

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema, shiftIsoDate } from './journal.js';
import {
  addMoney,
  compareMoney,
  isMoneyAmount,
  prorateMoney,
  subtractMoney,
  sumMoney,
} from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  MAX_POS_LINES,
  MAX_POS_PAYMENTS,
  POS_NUMBER_PADDING,
  POS_PAYMENT_METHODS,
  POS_TENDERS,
  type PosPaymentMethod,
} from './pos.js';
import {
  addQuantity,
  compareQuantity,
  isQuantity,
  quantitySchema,
  subtractQuantity,
} from './quantities.js';
import { positiveAmountSchema } from './receipts.js';
import { taxRateRefSchema } from './sales.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  serialNumberSchema,
  stockLineRules,
  variantRefSchema,
} from './stock.js';

// Step 20c: returns at a POS counter. A customer brings goods back with the receipt; the cashier
// scans or types its number, ticks what came back, and pays the money back. A return is a document
// of its own (POS1-R000012): the sale never changes (20a), and its page lists the returns of it.
//
//   the sale    online, any register's sale, asked from the server by its number; offline, a sale of
//               this register from the last POS_SALES_ON_DEVICE_DAYS days, from the device's copy
//               (the pos_sale rows, sync.ts), or one still in its outbox. Never more of a line than
//               it sold less what earlier returns took back, at the price it was sold for: each
//               line's own net and VAT, after its share of the bill's discount (posReturnAmounts).
//   the money   back in cash, or by a way the sale was paid (card, bKash, Nagad), split if need be,
//               always the return's whole total. Or an exchange (you chose this): the money pays
//               for a new sale at once, so it never leaves the drawer and comes back. The return and
//               its new sale are saved together at "Complete sale", the return first; the sale pays
//               with the tender `exchange`, which names the return (pos.ts), and never uses more of
//               the money than it costs: the rest is the return's refund in cash or another way.
//   the goods   back into the register's warehouse (you chose this), whatever register sold them;
//               damaged goods leave it later with a stock adjustment. At what they cost when sold.
//
// The window (you chose this): a register takes goods back for `returnDays` days after the sale
// (0 = the same day). The screen refuses an older sale; the server never does.
//
// Like a sale, a return is done when it reaches the server: the money was paid back. It comes as a
// pos_return.create command (sync.ts) and is posted then, in the shift of the register that took
// the goods back. The server never refuses it for the window, for a quantity more than is left (a
// race between two counters) or for permission: it posts it and writes the audit log. It refuses
// only what someone can put right (a register with no account for a refund's method) and bugs.

// POS1-R000012: the register's code, an R and the return's number in that register's own series,
// 6 digits like a receipt's. A series of its own (you chose this): a return never takes a sale's
// number, and the R tells the two apart on paper.
export function formatReturnNumber(registerCode: string, sequence: number): string {
  return `${registerCode}-R${String(sequence).padStart(POS_NUMBER_PADDING, '0')}`;
}

// How long the device keeps its register's sales for returns without a connection. A register
// that takes goods back for longer finds the older sales online.
export const POS_SALES_ON_DEVICE_DAYS = 30;

// The last day a sale's goods come back at a register: "Returns until 30 Oct 2026"
export function lastReturnDayOf(saleDate: string, returnDays: number): string {
  return shiftIsoDate(saleDate, returnDays);
}

// ISO dates compare as strings
export function isWithinReturnWindow(saleDate: string, today: string, returnDays: number): boolean {
  return lastReturnDayOf(saleDate, returnDays) >= today;
}

// ---------------------------------------------------------------------------------------------
// The arithmetic of a return

// What a line sold, and what earlier returns took back of it, in the line's own unit
interface SoldLine {
  quantity: string;
  net: string;
  vat: string;
  returnedQuantity: string;
}

// Never below zero: a race between two counters may have taken back more than the line sold
export function returnableQuantityOf(
  line: Pick<SoldLine, 'quantity' | 'returnedQuantity'>,
): string {
  const left = subtractQuantity(line.quantity, line.returnedQuantity);
  return compareQuantity(left, '0') > 0 ? left : '0.0000';
}

// The share of `amount` that the first `upTo` of `sold` carry, to the paisa. The whole line is the
// amount itself, not rounded: a line of ৳1,234.5678 is still that when it all comes back.
function shareUpTo(amount: string, upTo: string, sold: string): string {
  if (compareQuantity(upTo, '0') <= 0) return '0.0000';
  if (compareQuantity(upTo, sold) >= 0) return amount;
  return prorateMoney(amount, upTo, sold);
}

// What a return of `quantity` pays back for a line: its share of the line's total and of its VAT,
// as the difference between what the line carries up to the end of this return and up to the start
// of it; the net is what is left of the total after the VAT. Three returns of one piece each of a
// line of 3 at ৳100 give back 33.33, 33.34 and 33.33: they add up to the line, with no paisa lost
// to rounding and none given back twice. The total is shared, not the net and the VAT one by one:
// one shirt of two sold at ৳420 with VAT comes back at ৳420.00, where two rounded parts would make
// it ৳420.01 and the next one ৳419.99. The device works it out from what it knows was returned
// before; the server again, and writes the audit log when the two differ (another counter took
// some back first).
export function posReturnAmounts(
  line: SoldLine,
  quantity: string,
): { net: string; vat: string; total: string } {
  const before = line.returnedQuantity;
  const after = addQuantity(before, quantity);
  const shareOf = (amount: string) =>
    subtractMoney(
      shareUpTo(amount, after, line.quantity),
      shareUpTo(amount, before, line.quantity),
    );
  const total = shareOf(addMoney(line.net, line.vat));
  const vat = shareOf(line.vat);
  return { net: subtractMoney(total, vat), vat, total };
}

// ---------------------------------------------------------------------------------------------
// The sale a return comes from: what the return screen reads, from the server (online) or from
// the device's copy (offline, the pos_sale rows)

export const posReturnableLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  // 'none' | 'batch' | 'serial', z.string() like the product's own
  tracking: z.string(),
  // The line's unit; the quantities below are in it
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  description: z.string(),
  unitPrice: z.string(),
  taxRate: taxRateRefSchema,
  // After the line's discount and its share of the bill's
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // What the scanner read at the sale, and which of them came back since
  serialNumbers: z.array(z.string()),
  returnedSerialNumbers: z.array(z.string()),
  // What posted returns took back, in the line's unit
  returnedQuantity: z.string(),
});
export type PosReturnableLine = z.infer<typeof posReturnableLineSchema>;

export const posReturnableSaleSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  // The register it was sold on: any of the workspace's online, this one offline
  registerId: z.uuid(),
  // The day it is in the books: the window counts from it
  date: z.iso.date(),
  soldAt: z.iso.datetime(),
  // null = walk-in. The return is the same customer's.
  customer: partyRefSchema.nullable(),
  pricesIncludeVat: z.boolean(),
  total: z.string(),
  lines: z.array(posReturnableLineSchema),
  // How it was paid: a refund goes back by cash or by one of these (an exchange's money as cash)
  payments: z.array(z.object({ method: z.enum(POS_TENDERS), amount: z.string() })),
});
export type PosReturnableSale = z.infer<typeof posReturnableSaleSchema>;

// The receipt number the cashier scanned or typed: "POS1-000123", in any case
export const posSaleNumberParamsSchema = z.object({
  number: z.string().trim().toUpperCase().min(1).max(30),
});

// ---------------------------------------------------------------------------------------------
// What the device sends (inside a pos_return.create command, sync.ts)

// A device-made amount: never typed, so no empty box; 4 decimals, like the arithmetic gives it
const deviceAmountSchema = z
  .string()
  .refine((value) => isMoneyAmount(value), errorCode('money_format'));

const posReturnLineInputSchema = z
  .object({
    saleLineId: z.uuid(),
    // In the sale line's unit
    quantity: quantitySchema,
    // posReturnAmounts on the device, as the return receipt printed them. The books take these:
    // the money was paid back.
    net: deviceAmountSchema,
    vat: deviceAmountSchema,
    // A serial product: the serial numbers that came back, out of the line's (the screen ticks
    // them). A batch product sends no batch: the goods go back into the batches the line left from.
    serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
  })
  .superRefine(stockLineRules);
export type PosReturnLineInput = z.infer<typeof posReturnLineInputSchema>;

const posRefundInputSchema = z.object({
  method: z.enum(POS_TENDERS),
  amount: positiveAmountSchema('pos_refund_amount_required'),
  // The card's approval code, the bKash TrxID of the money sent back
  reference: optionalText(60),
});
export type PosRefundInput = z.infer<typeof posRefundInputSchema>;

const posReturnFieldsSchema = z.object({
  // The register that took the goods back, and the return's number in its series
  registerId: z.uuid(),
  sequence: z.number().int().min(1),
  // The shift of this register (the cash leaves its drawer), whatever shift the sale was in
  shiftId: z.uuid(),
  // The device's today and the moment, like a sale's: booked on `date`, or the first open day
  date: z.iso.date(),
  returnedAt: z.iso.datetime(),
  saleId: z.uuid(),
  lines: z
    .array(posReturnLineInputSchema)
    .min(1, errorCode('pos_return_lines_required'))
    .max(MAX_POS_LINES),
  // Empty only for a return of ৳0 (a free sample brought back)
  refunds: z.array(posRefundInputSchema).max(MAX_POS_PAYMENTS),
  // "Wrong size, exchanged for L"
  note: optionalText(200),
});

type PosReturnRuleInput = z.output<typeof posReturnFieldsSchema>;

// One line of the sale at most once; the refunds add up to the return's total exactly (there is no
// change to give back); at most one exchange. The amounts are checked only once each is complete,
// and only with a line: with none, "does not add up" would only repeat the error the lines have.
function posReturnRules(input: PosReturnRuleInput, ctx: z.RefinementCtx<PosReturnRuleInput>): void {
  documentSerialRules(input, ctx);
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    if (seen.has(line.saleLineId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'saleLineId'],
        message: errorCode('pos_return_line_twice'),
      });
    }
    seen.add(line.saleLineId);
  });
  const exchanges = input.refunds.filter((refund) => refund.method === 'exchange');
  if (exchanges.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['refunds'], message: errorCode('pos_exchange_invalid') });
  }
  const complete =
    input.lines.length > 0 &&
    input.lines.every(
      (line) => isQuantity(line.quantity) && isMoneyAmount(line.net) && isMoneyAmount(line.vat),
    ) &&
    input.refunds.every((refund) => isMoneyAmount(refund.amount));
  if (!complete) return;
  const total = sumMoney(input.lines.map((line) => addMoney(line.net, line.vat)));
  const refunded = sumMoney(input.refunds.map((refund) => refund.amount));
  if (compareMoney(refunded, total) !== 0) {
    ctx.addIssue({ code: 'custom', path: ['refunds'], message: errorCode('pos_refund_mismatch') });
  }
}

export const posReturnInputSchema = posReturnFieldsSchema.superRefine(posReturnRules);
export type PosReturnInput = z.infer<typeof posReturnInputSchema>;
export type PosReturnFormValues = z.input<typeof posReturnInputSchema>;

// The methods a refund may go back by: cash always, the others only when the sale was paid so (a
// card refund goes back to the card). The money of an exchange came from a return, so it goes
// back as cash. Exchange is not in the list: it is the screen's own button. The device offers
// these; the server takes any method the register has an account for.
export function refundMethodsOf(sale: Pick<PosReturnableSale, 'payments'>): PosPaymentMethod[] {
  const paid = new Set(sale.payments.map((payment) => payment.method));
  return POS_PAYMENT_METHODS.filter((method) => method === 'cash' || paid.has(method));
}

// ---------------------------------------------------------------------------------------------
// What the API sends: the posted returns, for the managers' list and page

export const posReturnSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  register: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  shift: z.object({ id: z.uuid(), number: z.string() }),
  branchId: z.uuid(),
  // The register's warehouse: where the goods came back into
  warehouseId: z.uuid(),
  date: z.iso.date(),
  returnedAt: z.iso.datetime(),
  sale: z.object({ id: z.uuid(), number: z.string(), date: z.iso.date() }),
  // The sale's customer; null = walk-in
  customer: partyRefSchema.nullable(),
  cashier: z.object({ id: z.uuid(), fullName: z.string() }),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  // The sale its money paid for; null when it was all paid back
  exchangeSale: z.object({ id: z.uuid(), number: z.string() }).nullable(),
  // It came after the register's window (the server took it anyway, and the audit log says so)
  outsideWindow: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PosReturnSummary = z.infer<typeof posReturnSummarySchema>;

export const posReturnLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  saleLineId: z.uuid(),
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  description: z.string(),
  unitPrice: z.string(),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // The batches it went back into: the ones the sale line left from
  batches: z.array(
    z.object({
      batchId: z.uuid(),
      lotNumber: z.string(),
      expiresOn: z.iso.date().nullable(),
      quantity: z.string(),
    }),
  ),
  serialNumbers: z.array(z.string()),
});
export type PosReturnLine = z.infer<typeof posReturnLineSchema>;

export const posRefundSchema = z.object({
  method: z.enum(POS_TENDERS),
  amount: z.string(),
  reference: z.string().nullable(),
  // The register's account for the method when the return was posted; its exchange account for
  // an exchange
  accountId: z.uuid(),
});
export type PosRefund = z.infer<typeof posRefundSchema>;

export const posReturnSchema = posReturnSummarySchema.extend({
  pricesIncludeVat: z.boolean(),
  note: z.string().nullable(),
  lines: z.array(posReturnLineSchema),
  refunds: z.array(posRefundSchema),
  device: z.object({ id: z.uuid(), name: z.string() }),
  // The money and the stock in the books; null only for a return of ৳0 that cost nothing
  entry: entryRefSchema.nullable(),
});
export type PosReturn = z.infer<typeof posReturnSchema>;

export const posReturnListQuerySchema = pageQuerySchema.extend({
  registerId: z.uuid().optional(),
  saleId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
});
export type PosReturnListQuery = z.input<typeof posReturnListQuerySchema>;

export const posReturnPageSchema = pageOf(posReturnSummarySchema);
export type PosReturnPage = z.infer<typeof posReturnPageSchema>;

const idParamsSchema = z.object({ id: z.uuid() });

// A register's recent sales, read by the device that just took the register (20c.3). Bigger pages
// than a list's: a busy counter sells a few hundred times a day, and a month comes in a few pages.
export const POS_REGISTER_SALES_PAGE = 200;
export const posRegisterSalesQuerySchema = z.object({
  limit: z.coerce.number<number>().int().min(1).max(500).default(POS_REGISTER_SALES_PAGE),
  cursor: z.string().min(1).max(512).optional(),
});
export type PosRegisterSalesQuery = z.input<typeof posRegisterSalesQuerySchema>;

export const posRegisterSalesPageSchema = pageOf(posReturnableSaleSchema);
export type PosRegisterSalesPage = z.infer<typeof posRegisterSalesPageSchema>;

// Reading the returns needs no permission, like the sales. Finding a sale to take back needs
// pos.return.create: the cashier's screen asks it. A return is never written through these routes:
// it arrives as a sync command. A register's recent sales need the cashier's permission, the
// claim's: the device reads them right after it takes the register, because nothing in the change
// log brings them (they were written before this device held it); the pulls keep them up to date
// from then on.
export const posReturnRoutes = {
  registerSales: defineRoute({
    method: 'GET',
    path: '/pos/registers/:id/sales',
    summary: `A register's sales of the last ${String(POS_SALES_ON_DEVICE_DAYS)} days, oldest first`,
    auth: 'bearer',
    permission: 'pos.sale.create',
    status: 200,
    params: idParamsSchema,
    query: posRegisterSalesQuerySchema,
    response: posRegisterSalesPageSchema,
  }),
  returnableSale: defineRoute({
    method: 'GET',
    path: '/pos/sales/by-number/:number',
    summary: 'A POS sale by its receipt number, with what is left to return of each line',
    auth: 'bearer',
    permission: 'pos.return.create',
    status: 200,
    params: posSaleNumberParamsSchema,
    response: posReturnableSaleSchema,
  }),
  listReturns: defineRoute({
    method: 'GET',
    path: '/pos/returns',
    summary: 'POS returns the server has received, newest first',
    auth: 'bearer',
    status: 200,
    query: posReturnListQuerySchema,
    response: posReturnPageSchema,
  }),
  getReturn: defineRoute({
    method: 'GET',
    path: '/pos/returns/:id',
    summary: 'One POS return with its lines, refunds and entry',
    auth: 'bearer',
    status: 200,
    params: idParamsSchema,
    response: posReturnSchema,
  }),
};
```

**The header and the number:**

- **The header comment is the design in one place:** where the sale comes from, where the money and the goods go, the
  window, and why the server never refuses a return. 20c.3's posting and 20c.6's screen both follow it.
- **`formatReturnNumber()` uses the receipt's padding** (`POS_NUMBER_PADDING`), so a return and a receipt line up on
  the Sync page and the shift's page, and grows past 6 digits the same way.
- **`isWithinReturnWindow()` compares ISO dates as strings:** `'2026-10-30' >= '2026-10-28'` is true for the same
  reason the dates sort. `lastReturnDayOf()` is its own function because the screen shows it ("Returns until 30 Oct").

**The arithmetic:**

- **`returnableQuantityOf()` never goes below zero.** Two counters can take back the same strips while one is offline
  (decision 20); the screen then shows "nothing left", not a minus.
- **`shareUpTo()` returns the amount itself for the whole line,** not `prorateMoney(amount, sold, sold)`: prorating
  rounds to the paisa, and a line of ৳1,234.5678 would lose its last digits when it all came back.
- **`posReturnAmounts()` subtracts two shares** (decision 13) instead of prorating the return's own quantity. Prorated
  one by one, three shirts would each give back 33.33, and a paisa of the line would never come back.
- **The total and the VAT are shared, and the net is what is left** (decision 65, fixed in 20c.6a). The sale rounded
  its net and its VAT to the paisa one by one, so sharing each again rounds twice: one shirt of two sold at ৳420 with
  VAT (net 730.43, VAT 109.57) would come back at 365.22 + 54.79 = ৳420.01, and the next at ৳419.99. The total of a line
  is what the customer paid for it, so it is the share that must come out right; the net then makes the parts add up.

**The sale a return reads:**

- **`posReturnableLineSchema` has the variant's name and SKU** (`variantRefSchema`), the unit and the VAT rate, so the
  screen draws a line without looking anything up, offline too.
- **`returnedSerialNumbers` sits next to `serialNumbers`:** the screen ticks from the ones not back yet.
- **`payments` takes any tender,** exchange too: `refundMethodsOf()` reads it to offer the ways back.
- **`posSaleNumberParamsSchema` trims and upper-cases** what the cashier typed: a scanner sends `POS1-000123`, a person
  may type `pos1-000123 `.

**What the device sends:**

- **`deviceAmountSchema` has no empty box:** a person never types these amounts; the device works them out.
- **A line's `serialNumbers` go through `stockLineRules`** (each serial once), and the whole return through
  `documentSerialRules` (each serial on one line only), like a sale.
- **`shiftId` is required** (decision 19), unlike a sale's.
- **`refunds` has no `.min(1)`:** a ৳0 return has none (decision 15). `pos_refund_mismatch` catches a return of money
  with no refund.
- **`posReturnRules` checks the money only when every box is complete and there is a line:** a bad quantity already has
  its own error, and with no line "does not add up" would only repeat `pos_return_lines_required`.
- **`refundMethodsOf()` returns `PosPaymentMethod`, never `exchange`:** the exchange is its own button on the screen,
  not one of the ways back.

**What the API sends:**

- **`posReturnSummarySchema.shift` is never null:** every return is in a shift (decision 19).
- **`exchangeSale` is the sale the return's money paid for,** found from the sale's payment, so the list links both
  ways.
- **`posRefundSchema.accountId` is the account it was posted to,** the register's for the method or its exchange
  account, like a sale's payment.
- **`posReturnRoutes.returnableSale` sits under `/pos/sales/`** with a fixed `by-number` part and one more segment
  than `/pos/sales/:id`, so the two routes never match the same address.
- **`registerSales` is the register's recent sales for its device** (decision 45, added while the API was built). Its
  pages are bigger than a list's (200, up to 500): a busy counter sells a few hundred times a day, and a month should
  come in a few requests. Its cursor is the register's own number, so it has its own query schema, not
  `pageQuerySchema`. It needs `pos.sale.create`, the claim's permission: the device asks right after its claim.

```ts
import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  formatReturnNumber,
  isWithinReturnWindow,
  lastReturnDayOf,
  posReturnAmounts,
  posReturnInputSchema,
  posSaleNumberParamsSchema,
  refundMethodsOf,
  returnableQuantityOf,
} from './pos-returns.js';

const REGISTER = '0192f1f0-0000-7000-8000-000000000001';
const SHIFT = '0192f1f0-0000-7000-8000-000000000002';
const SALE = '0192f1f0-0000-7000-8000-000000000003';
const SHIRT_LINE = '0192f1f0-0000-7000-8000-000000000004';
const PHONE_LINE = '0192f1f0-0000-7000-8000-000000000005';

// The error codes where the form will show them: field path → code
function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('return numbers', () => {
  it("puts an R between the register's code and 6 digits, and grows past them", () => {
    expect(formatReturnNumber('POS1', 12)).toBe('POS1-R000012');
    expect(formatReturnNumber('CTG2', 1234567)).toBe('CTG2-R1234567');
  });
});

describe('the return window', () => {
  // Sold on Friday 23 October; the counter takes goods back for 7 days
  it('takes goods back up to the last day, and not the day after', () => {
    expect(lastReturnDayOf('2026-10-23', 7)).toBe('2026-10-30');
    expect(isWithinReturnWindow('2026-10-23', '2026-10-30', 7)).toBe(true);
    expect(isWithinReturnWindow('2026-10-23', '2026-10-31', 7)).toBe(false);
  });

  it('reads 0 days as the same day only, also across the end of a month', () => {
    expect(isWithinReturnWindow('2026-10-31', '2026-10-31', 0)).toBe(true);
    expect(isWithinReturnWindow('2026-10-31', '2026-11-01', 0)).toBe(false);
  });
});

describe('the money of a return', () => {
  // Three polo shirts at ৳100 each before VAT, ৳15 VAT on the line
  const shirts = { quantity: '3.0000', net: '100.0000', vat: '15.0000' };

  it('gives back each piece of a line so that the pieces add up to the line', () => {
    const first = posReturnAmounts({ ...shirts, returnedQuantity: '0.0000' }, '1');
    const second = posReturnAmounts({ ...shirts, returnedQuantity: '1.0000' }, '1');
    const third = posReturnAmounts({ ...shirts, returnedQuantity: '2.0000' }, '1');
    expect([first.net, second.net, third.net]).toEqual(['33.3300', '33.3400', '33.3300']);
    expect([first.vat, second.vat, third.vat]).toEqual(['5.0000', '5.0000', '5.0000']);
    expect(first.total).toBe('38.3300');
  });

  it('gives back one shirt of two at the price it was sold for, to the paisa', () => {
    // 2 × ৳420 with VAT: net 730.43 and VAT 109.57, each rounded on its own at the sale
    const pair = { quantity: '2.0000', net: '730.4300', vat: '109.5700' };
    const first = posReturnAmounts({ ...pair, returnedQuantity: '0' }, '1');
    const second = posReturnAmounts({ ...pair, returnedQuantity: '1' }, '1');
    expect(first).toEqual({ net: '365.2100', vat: '54.7900', total: '420.0000' });
    expect(second).toEqual({ net: '365.2200', vat: '54.7800', total: '420.0000' });
  });

  it('gives back a whole line as it was sold, without rounding it', () => {
    const line = { quantity: '2.0000', net: '1234.5678', vat: '185.1852', returnedQuantity: '0' };
    expect(posReturnAmounts(line, '2')).toEqual({
      net: '1234.5678',
      vat: '185.1852',
      total: '1419.7530',
    });
  });

  it('leaves what was not returned yet, and never less than nothing', () => {
    expect(returnableQuantityOf({ quantity: '10.0000', returnedQuantity: '3.0000' })).toBe(
      '7.0000',
    );
    // Two counters took back the same strips while one was offline
    expect(returnableQuantityOf({ quantity: '10.0000', returnedQuantity: '12.0000' })).toBe(
      '0.0000',
    );
  });

  it('pays back by cash, or by a way the sale was paid, never by its exchange', () => {
    const sale = {
      payments: [
        { method: 'exchange' as const, amount: '1200.0000' },
        { method: 'bkash' as const, amount: '500.0000' },
      ],
    };
    expect(refundMethodsOf(sale)).toEqual(['cash', 'bkash']);
  });
});

describe('return input', () => {
  // A customer brings back one of two shirts (৳736 with VAT) and a phone with its IMEI
  function input(extra: object = {}) {
    return {
      registerId: REGISTER,
      sequence: 12,
      shiftId: SHIFT,
      date: '2026-10-28',
      returnedAt: '2026-10-28T10:42:00.000Z',
      saleId: SALE,
      lines: [
        {
          saleLineId: SHIRT_LINE,
          quantity: '1',
          net: '640.0000',
          vat: '96.0000',
          serialNumbers: [],
        },
      ],
      refunds: [{ method: 'cash', amount: '736', reference: '' }],
      note: ' Wrong size ',
      ...extra,
    };
  }

  it('pays the whole total back, split if need be', () => {
    const parsed = posReturnInputSchema.parse(input());
    expect(parsed.note).toBe('Wrong size');
    const split = [
      { method: 'exchange', amount: '500', reference: '' },
      { method: 'cash', amount: '236', reference: '' },
    ];
    expect(posReturnInputSchema.safeParse(input({ refunds: split })).success).toBe(true);
  });

  it('refuses refunds that do not add up to the total, and a second exchange', () => {
    const short = posReturnInputSchema.safeParse(
      input({ refunds: [{ method: 'cash', amount: '700', reference: '' }] }),
    );
    expect(errorsOf(short)).toEqual({ refunds: 'pos_refund_mismatch' });
    const twice = [
      { method: 'exchange', amount: '368', reference: '' },
      { method: 'exchange', amount: '368', reference: '' },
    ];
    expect(errorsOf(posReturnInputSchema.safeParse(input({ refunds: twice })))).toEqual({
      refunds: 'pos_exchange_invalid',
    });
  });

  it('needs a line, each line of the sale once, and an amount in each refund box', () => {
    const none = posReturnInputSchema.safeParse(input({ lines: [] }), { error: contractErrorMap });
    expect(errorsOf(none)).toEqual({ lines: 'pos_return_lines_required' });
    const [shirt] = input().lines;
    const twice = posReturnInputSchema.safeParse(
      input({
        lines: [shirt, shirt],
        refunds: [{ method: 'cash', amount: '1472', reference: '' }],
      }),
    );
    expect(errorsOf(twice)).toEqual({ 'lines.1.saleLineId': 'pos_return_line_twice' });
    const empty = posReturnInputSchema.safeParse(
      input({ refunds: [{ method: 'cash', amount: '', reference: '' }] }),
      { error: contractErrorMap },
    );
    expect(errorsOf(empty)).toEqual({ 'refunds.0.amount': 'pos_refund_amount_required' });
  });

  it('takes back a free sample with no refund at all', () => {
    const free = { saleLineId: SHIRT_LINE, quantity: '1', net: '0', vat: '0', serialNumbers: [] };
    expect(posReturnInputSchema.safeParse(input({ lines: [free], refunds: [] })).success).toBe(
      true,
    );
  });

  it('refuses a serial number ticked on two lines', () => {
    const phone = {
      saleLineId: PHONE_LINE,
      quantity: '1',
      net: '0',
      vat: '0',
      serialNumbers: ['356938035643809'],
    };
    const lines = [phone, { ...phone, saleLineId: SHIRT_LINE }];
    const result = posReturnInputSchema.safeParse(input({ lines, refunds: [] }));
    expect(errorsOf(result)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('finds a receipt typed in small letters', () => {
    expect(posSaleNumberParamsSchema.parse({ number: ' pos1-000123 ' }).number).toBe('POS1-000123');
  });
});
```

- **The fixtures are the Saturday of "The whole picture" above:** a shirt at ৳736 (৳640 and ৳96 VAT) and a phone with
  its IMEI.
- **"Gives back each piece of a line"** is decision 13 in numbers: 33.33, 33.34 and 33.33, the VAT 5.00 each.
- **"Gives back one shirt of two at the price it was sold for"** is decision 65: ৳420.00 twice, the VAT 54.79 and
  54.78.
- **"Reads 0 days as the same day only"** crosses the end of a month, where adding a day by hand is easy to get wrong.
- **"Takes back a free sample with no refund at all"** keeps decision 15 from turning into a `.min(1)` later.

### `pos.ts`: the exchange tender, the register's return settings, the sale's returns

```diff
@@ -65,6 +65,12 @@ import { TAX_RATE_FORMAT } from './tax-rates.js';
 // count of the drawer at the start to the count at the end (pos-shifts.ts). The register holds
 // what its shifts need: the account a difference in the cash goes to, how big a difference rings
 // a bell, and how long /pos waits before it locks the screen.
+//
+// Step 20c: returns (pos-returns.ts). A customer brings goods back with the receipt; the counter
+// pays the money back by cash or by a way the sale was paid, or gives it as an exchange: the money
+// pays for the next sale at once. The register holds what a return needs: the account an
+// exchange passes through, how many days after a sale it still takes the goods back, and the last
+// number of its own return series (POS1-R000012).
 
 // ---------------------------------------------------------------------------------------------
 // Registers
@@ -75,6 +81,13 @@ import { TAX_RATE_FORMAT } from './tax-rates.js';
 export const POS_PAYMENT_METHODS = ['cash', 'card', 'bkash', 'nagad'] as const;
 export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];
 
+// Step 20c: a tender is one way money changes hands at the counter: the four methods above, and
+// exchange, the money of a return used to pay for a sale made with it (pos-returns.ts). A sale's
+// payment and a return's refund each have one. Exchange is not a method of the register: nobody
+// picks it in the pay dialog, and it has no account per method but the register's exchange account.
+export const POS_TENDERS = [...POS_PAYMENT_METHODS, 'exchange'] as const;
+export type PosTender = (typeof POS_TENDERS)[number];
+
 // The thermal paper's width in millimetres: 58 mm for a small shop's printer, 80 mm for a
 // supermarket's. The receipt's layout follows it (@page size).
 export const POS_PAPER_WIDTHS = ['58', '80'] as const;
@@ -118,6 +131,12 @@ export function formatPosNumber(registerCode: string, sequence: number): string
   return `${registerCode}-${String(sequence).padStart(POS_NUMBER_PADDING, '0')}`;
 }
 
+// Step 20c: how many days after a sale a counter takes its goods back. The screen counts the days
+// from the sale's date to today: 0 = the same day only. The default, 7, is the "exchanged within 7
+// days" most shops print on the receipt.
+export const POS_DEFAULT_RETURN_DAYS = 7;
+export const POS_MAX_RETURN_DAYS = 365;
+
 // The account per method. Cash is always there; null = this register does not take that method.
 export const posRegisterAccountsSchema = z.object({
   cash: z.uuid(),
@@ -155,11 +174,19 @@ export const posRegisterSchema = z.object({
   // A difference bigger than this, either way, rings a bell to the managers. Whole taka: "500".
   varianceAlert: z.string(),
   lockAfter: z.enum(POS_LOCK_AFTER),
+  // Step 20c. The account an exchange passes through, "POS exchange clearing" (a liability): the
+  // return puts the money on it, the sale made with it takes it off, so it comes back to zero.
+  // null = this counter makes no exchanges, only refunds.
+  exchangeAccountId: z.uuid().nullable(),
+  // 0 to POS_MAX_RETURN_DAYS
+  returnDays: z.number().int(),
   // The device that holds it now; null = free
   deviceId: z.uuid().nullable(),
   // The highest number the server has received from it; 0 = none yet. A device that takes the
   // register goes on from here.
   lastNumber: z.number().int().min(0),
+  // Step 20c: the same for its returns (POS1-R000012)
+  lastReturnNumber: z.number().int().min(0),
   // Step 20b: its latest shift; null = it never had one
   lastShift: posLastShiftSchema.nullable(),
   archivedAt: z.iso.datetime().nullable(),
@@ -204,6 +231,17 @@ const varianceAlertSchema = z
   .regex(/^\d{0,9}$/, errorCode('pos_variance_alert_format'))
   .transform((value) => (value === '' ? '0' : value));
 
+// A whole number of days, 0 to 365. An empty box is an error, not 0: 0 means "the same day only",
+// a rule too strict to set by leaving the box empty.
+const returnDaysSchema = z
+  .string()
+  .trim()
+  .refine(
+    (value) => /^\d{1,3}$/.test(value) && Number(value) <= POS_MAX_RETURN_DAYS,
+    errorCode('pos_return_days_format'),
+  )
+  .transform(Number);
+
 const registerFieldsSchema = z.object({
   name: z.string().trim().min(2, errorCode('pos_register_name_required')).max(60),
   // The form's empty select sends '' — "not chosen", with its own message
@@ -221,6 +259,9 @@ const registerFieldsSchema = z.object({
   overShortAccountId: z.uuid(errorCode('pos_over_short_required')),
   varianceAlert: varianceAlertSchema,
   lockAfter: z.enum(POS_LOCK_AFTER),
+  // Step 20c. The form's empty select sends '': no exchanges at this counter
+  exchangeAccountId: optionalIdSchema,
+  returnDays: returnDaysSchema,
 });
 
 export const posRegisterInputSchema = registerFieldsSchema.extend({ code: registerCodeSchema });
@@ -333,7 +374,7 @@ export function posSaleAmounts(
 }
 
 interface PaymentFields {
-  method: PosPaymentMethod;
+  method: PosTender;
   amount: string;
 }
 
@@ -402,6 +443,10 @@ export const MAX_POS_PAYMENTS = 6;
 
 const posLineInputSchema = salesLineFieldsSchema
   .extend({
+    // Step 20c: the line's id, made on the device (a UUIDv7), so a return of the sale can name the
+    // line before the sale reaches the server. null = a sale saved before 20c, still in an outbox:
+    // the server gives that line an id of its own.
+    id: z.uuid().nullable().default(null),
     // The VAT rate the device used, in percent ("15.00"): the receipt was printed with it, so the
     // server works the sale out with the same rate, also when the rate was changed meanwhile
     rate: z.string().regex(TAX_RATE_FORMAT, errorCode('tax_rate_format')),
@@ -420,10 +465,13 @@ export type PosLineInput = z.infer<typeof posLineInputSchema>;
 export type PosLineFormValues = z.input<typeof posLineInputSchema>;
 
 const posPaymentInputSchema = z.object({
-  method: z.enum(POS_PAYMENT_METHODS),
+  method: z.enum(POS_TENDERS),
   amount: positiveAmountSchema('pos_payment_amount_required'),
   // The card's last 4 digits or the approval code, the bKash or Nagad TrxID
   reference: optionalText(60),
+  // Step 20c: an exchange's return, the one saved with this sale (pos-returns.ts); null for every
+  // other tender. The default reads a sale from before 20c, still in an outbox, as one without it.
+  returnId: z.uuid().nullable().default(null),
 });
 export type PosPaymentInput = z.infer<typeof posPaymentInputSchema>;
 
@@ -474,11 +522,34 @@ function isComplete(input: PosSaleRuleInput): boolean {
   );
 }
 
+// Step 20c: an exchange payment names its return, and only an exchange does; one sale uses one
+// return. The device always makes them so: anything else is a bug, so one code for all of it.
+function exchangeRules(
+  payments: readonly { method: PosTender; returnId: string | null }[],
+  ctx: z.RefinementCtx<PosSaleRuleInput>,
+): void {
+  let exchanges = 0;
+  payments.forEach((payment, index) => {
+    const exchange = payment.method === 'exchange';
+    if (exchange) exchanges += 1;
+    if (exchange !== (payment.returnId !== null) || exchanges > 1) {
+      ctx.addIssue({
+        code: 'custom',
+        path: ['payments', index, 'method'],
+        message: errorCode('pos_exchange_invalid'),
+      });
+    }
+  });
+}
+
 // The rules of the whole sale: the bill's discount not more than the bill, the money paid at least
-// the total, and change only from cash (a card is charged the exact amount). They read the device's
-// own rates, so the same rules hold on the device before the sale and on the server after it.
+// the total, and change only from cash (a card is charged the exact amount, and an exchange uses
+// no more of a return's money than the sale costs: the rest is the return's refund). They read the
+// device's own rates, so the same rules hold on the device before the sale and on the server after
+// it.
 function posSaleRules(input: PosSaleRuleInput, ctx: z.RefinementCtx<PosSaleRuleInput>): void {
   documentSerialRules(input, ctx);
+  exchangeRules(input.payments, ctx);
   if (!isComplete(input)) return;
   const afters = input.lines.map((line) => {
     const gross = multiplyMoney(line.quantity, line.unitPrice);
@@ -559,15 +630,29 @@ export const posSaleLineSchema = salesLineSchema.extend({
   serialNumbers: z.array(z.string()),
   // What the warehouse did not have when it was posted, in the base unit; "0.0000" = none
   shortQuantity: z.string(),
+  // Step 20c: what posted returns brought back of it, in the line's unit; "0.0000" = nothing
+  returnedQuantity: z.string(),
 });
 export type PosSaleLine = z.infer<typeof posSaleLineSchema>;
 
+// A POS return as another document lists it: its number and its money back
+export const posReturnRefSchema = z.object({
+  id: z.uuid(),
+  number: z.string(),
+  date: z.iso.date(),
+  total: z.string(),
+});
+export type PosReturnRef = z.infer<typeof posReturnRefSchema>;
+
 export const posSalePaymentSchema = z.object({
-  method: z.enum(POS_PAYMENT_METHODS),
+  method: z.enum(POS_TENDERS),
   amount: z.string(),
   reference: z.string().nullable(),
-  // The register's account for the method when the sale was posted
+  // The register's account for the method when the sale was posted; for an exchange, its
+  // exchange account
   accountId: z.uuid(),
+  // Step 20c: an exchange's return; null for the other tenders
+  return: z.object({ id: z.uuid(), number: z.string() }).nullable(),
 });
 export type PosSalePayment = z.infer<typeof posSalePaymentSchema>;
 
@@ -583,6 +668,8 @@ export const posSaleSchema = posSaleSummarySchema.extend({
   change: z.string(),
   lines: z.array(posSaleLineSchema),
   payments: z.array(posSalePaymentSchema),
+  // Step 20c: the posted returns of it, oldest first
+  returns: z.array(posReturnRefSchema),
   // The device it was sold on (its name now)
   device: z.object({ id: z.uuid(), name: z.string() }),
   // The sale, its cost and its stock in the books; null only for a sale of ৳0 that cost nothing
```

- **`POS_TENDERS` spreads `POS_PAYMENT_METHODS`** and adds `exchange`, so a fifth method added later is a tender at
  once, and the four stay in one place.
- **`exchangeAccountId` is nullable in the form too** (`optionalIdSchema`), unlike the over/short account: a shift
  cannot run without over/short, but a counter can take goods back without exchanges (decision 6).
- **`returnDaysSchema` checks the digits before `Number()`:** `Number('')` is 0 and `Number('7.5')` is 7.5, so a plain
  `z.coerce.number()` would read an empty box as "the same day only" (decision 29).
- **`exchangeRules` runs before `isComplete`:** it reads only the tenders and the return ids, which are complete
  whenever the payments parse.
- **`posReturnRefSchema` is in `pos.ts`, not `pos-returns.ts`:** the sale's schema needs it, and `pos-returns.ts`
  imports `pos.ts`; the other way round would be a cycle (the reason of 20b's `posLastShiftSchema`).
- **`returnedQuantity` on the sale's line** is what the sale's page shows next to each line.
- **A sale line has an `id` the device made** (decision 64, added in 20c.6a), so a return made offline can name a line of
  a sale that is still in the outbox. `nullable().default(null)` reads a sale saved before 20c, still in an outbox, as
  one without ids: the server gives those lines ids of its own, as it always did.

```diff
@@ -22,6 +22,8 @@ const VARIANT = '0192f1d0-0000-7000-8000-000000000005';
 const UNIT = '0192f1d0-0000-7000-8000-000000000006';
 const RATE = '0192f1d0-0000-7000-8000-000000000007';
 const OVER_SHORT = '0192f1d0-0000-7000-8000-000000000008';
+const EXCHANGE = '0192f1d0-0000-7000-8000-000000000009';
+const RETURN = '0192f1d0-0000-7000-8000-00000000000a';
 
 // The error codes where the form will show them: field path → code
 function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
@@ -50,6 +52,8 @@ describe('register input', () => {
     overShortAccountId: OVER_SHORT,
     varianceAlert: '',
     lockAfter: '5',
+    exchangeAccountId: '',
+    returnDays: '7',
   };
 
   it('upper-cases the code, and reads the empty boxes as nothing', () => {
@@ -59,6 +63,8 @@ describe('register input', () => {
     expect(input.maxDiscountPercent).toBe('0');
     expect(input.receiptFooter).toBeNull();
     expect(input.varianceAlert).toBe('0');
+    expect(input.exchangeAccountId).toBeNull();
+    expect(input.returnDays).toBe(7);
     expect(registerMethods({ ...input.accounts, cash: CASH })).toEqual(['cash', 'bkash']);
   });
 
@@ -71,6 +77,7 @@ describe('register input', () => {
         maxDiscountPercent: '100.5',
         overShortAccountId: '',
         varianceAlert: '500.50',
+        returnDays: '400',
       },
       { error: contractErrorMap },
     );
@@ -80,9 +87,23 @@ describe('register input', () => {
       maxDiscountPercent: 'pos_discount_limit_format',
       overShortAccountId: 'pos_over_short_required',
       varianceAlert: 'pos_variance_alert_format',
+      returnDays: 'pos_return_days_format',
     });
   });
 
+  it('takes returns from the same day only to a year, and an exchange account', () => {
+    const same = posRegisterInputSchema.parse({ ...counter, returnDays: '0' });
+    expect(same.returnDays).toBe(0);
+    expect(posRegisterInputSchema.parse({ ...counter, returnDays: '365' }).returnDays).toBe(365);
+    const input = posRegisterInputSchema.parse({ ...counter, exchangeAccountId: EXCHANGE });
+    expect(input.exchangeAccountId).toBe(EXCHANGE);
+    // An empty box is not "the same day": the rule is too strict to set by leaving it empty
+    for (const returnDays of ['', '7.5', '-1']) {
+      const result = posRegisterInputSchema.safeParse({ ...counter, returnDays });
+      expect(errorsOf(result)).toEqual({ returnDays: 'pos_return_days_format' });
+    }
+  });
+
   it('locks the screen after the minutes chosen, or never', () => {
     expect(lockAfterMs('5')).toBe(300_000);
     expect(lockAfterMs('off')).toBeNull();
@@ -269,6 +290,46 @@ describe('sale input', () => {
     expect(errorsOf(none)).toEqual({ payments: 'pos_payments_required' });
   });
 
+  it("keeps the line's id the device made, and reads a line from before 20c without one", () => {
+    const [first] = sale().lines;
+    const line = '0193f0a8-7b2c-7c41-9d3e-5a6b7c8d9e0f';
+    const payments = [{ method: 'cash', amount: '3400', reference: '' }];
+    const lines = [{ ...first, id: line }, first];
+    const input = posSaleInputSchema.parse(sale({ lines, payments }));
+    expect(input.lines.map((one) => one.id)).toEqual([line, null]);
+  });
+
+  it("pays with a return's money, and the rest in cash with the change", () => {
+    const payments = [
+      { method: 'exchange', amount: '1200', reference: '', returnId: RETURN },
+      { method: 'cash', amount: '1000', reference: '' },
+    ];
+    const input = posSaleInputSchema.parse(sale({ payments }));
+    expect(input.payments.map((payment) => payment.returnId)).toEqual([RETURN, null]);
+    expect(posChangeOf(input.payments, '1700.0000')).toBe('500.0000');
+  });
+
+  it("never uses more of a return's money than the sale costs", () => {
+    const result = posSaleInputSchema.safeParse(
+      sale({ payments: [{ method: 'exchange', amount: '2000', reference: '', returnId: RETURN }] }),
+    );
+    expect(errorsOf(result)).toEqual({ payments: 'pos_change_not_cash' });
+  });
+
+  it('needs the return on an exchange, and only there, once', () => {
+    const none = posSaleInputSchema.safeParse(
+      sale({ payments: [{ method: 'exchange', amount: '1700', reference: '' }] }),
+    );
+    expect(errorsOf(none)).toEqual({ 'payments.0.method': 'pos_exchange_invalid' });
+    const cash = posSaleInputSchema.safeParse(
+      sale({ payments: [{ method: 'cash', amount: '1700', reference: '', returnId: RETURN }] }),
+    );
+    expect(errorsOf(cash)).toEqual({ 'payments.0.method': 'pos_exchange_invalid' });
+    const exchange = { method: 'exchange', amount: '850', reference: '', returnId: RETURN };
+    const twice = posSaleInputSchema.safeParse(sale({ payments: [exchange, exchange] }));
+    expect(errorsOf(twice)).toEqual({ 'payments.1.method': 'pos_exchange_invalid' });
+  });
+
   it('never takes more off the bill than the bill', () => {
     const result = posSaleInputSchema.safeParse(
       sale({ billDiscountType: 'amount', billDiscount: '1800' }),
```

- **The register fixture gets the two new boxes,** and the refusal test one more: 400 days.
- **"Pays with a return's money, and the rest in cash with the change"** is the Saturday's exchange: the return's ৳1,200
  and ৳1,000 in cash for ৳1,700 give ৳500 back in cash.
- **"Keeps the line's id the device made"** checks both ways of decision 64: an id sent comes out as it is, a line
  without one comes out `null`.

### `pos-shifts.ts`: the refunds and the X and Z reports

```diff
@@ -13,7 +13,7 @@ import {
   sumMoney,
 } from './money.js';
 import { pageOf, pageQuerySchema } from './pagination.js';
-import { POS_PAYMENT_METHODS, POS_SHIFT_STATUSES } from './pos.js';
+import { POS_SHIFT_STATUSES, POS_TENDERS, type PosTender } from './pos.js';
 import { positiveAmountSchema } from './receipts.js';
 import { optionalIdSchema } from './stock.js';
 
@@ -41,6 +41,12 @@ import { optionalIdSchema } from './stock.js';
 // when it arrives and never refuses one for money or for permission: the money was counted or
 // moved already. A shift that nobody can close (a lost device, a cashier gone home) is closed
 // without a count: by a revoke of its device, or online by someone with pos.shift.manage.
+//
+// Step 20c: a return in the shift pays money back (pos-returns.ts), so the drawer should hold less
+// by its cash refunds. And a shift prints two reports on the receipt printer (you chose this): the
+// X report at any time while it is open, from the device's own data, offline too; the Z report
+// after the close, from the close's result and from the shift's page. The X report is blind like
+// the count: it says what was sold and paid back, never what the drawer should hold.
 
 // POS1-S0042: the register's code, an S and the shift's number in that register, 4 digits (a
 // receipt has 6 and no S, so the two never look alike). Like a receipt number (formatPosNumber),
@@ -197,6 +203,8 @@ export interface ShiftCash {
   // Pay ins and pay outs
   paidIn: string;
   paidOut: string;
+  // Step 20c: cash the returns paid back (an exchange's money never leaves the drawer)
+  cashRefunded: string;
 }
 
 // What the drawer should hold. The float of a register's first shift is its opening count, not a
@@ -204,7 +212,7 @@ export interface ShiftCash {
 export function expectedCashOf(cash: ShiftCash): string {
   return subtractMoney(
     addMoney(addMoney(cash.opening, cash.cashTaken), cash.paidIn),
-    addMoney(cash.changeGiven, cash.paidOut),
+    sumMoney([cash.changeGiven, cash.paidOut, cash.cashRefunded]),
   );
 }
 
@@ -300,6 +308,9 @@ export const posShiftSummarySchema = z.object({
   // The sales the server has received in it
   saleCount: z.number().int(),
   salesTotal: z.string(),
+  // Step 20c: and the returns, whatever shift their sales were in
+  returnCount: z.number().int(),
+  returnsTotal: z.string(),
 });
 export type PosShiftSummary = z.infer<typeof posShiftSummarySchema>;
 
@@ -318,6 +329,8 @@ export const posCashMovementSchema = z.object({
 });
 export type PosCashMovement = z.infer<typeof posCashMovementSchema>;
 
+const tenderAmountSchema = z.object({ method: z.enum(POS_TENDERS), amount: z.string() });
+
 export const posShiftSchema = posShiftSummarySchema.extend({
   opening: z.object({
     count: cashCountSchema,
@@ -351,9 +364,17 @@ export const posShiftSchema = posShiftSummarySchema.extend({
     changeGiven: z.string(),
     paidIn: z.string(),
     paidOut: z.string(),
-  }),
-  // What the sales took by each method, every method of the register, cash before the change
-  payments: z.array(z.object({ method: z.enum(POS_PAYMENT_METHODS), amount: z.string() })),
+    cashRefunded: z.string(),
+  } satisfies Record<keyof ShiftCash, z.ZodType>),
+  // What the sales took by each tender, every method of the register (cash before the change),
+  // and exchange when a sale used one. Step 20c: what the returns paid back, the same way.
+  payments: z.array(tenderAmountSchema),
+  refunds: z.array(tenderAmountSchema),
+  // Step 20c, for the Z report: the sales' discounts (the lines' and the bills') and VAT, and the
+  // returns' VAT
+  salesDiscount: z.string(),
+  salesVat: z.string(),
+  returnsVat: z.string(),
   movements: z.array(posCashMovementSchema),
 });
 export type PosShift = z.infer<typeof posShiftSchema>;
@@ -372,6 +393,64 @@ export type PosShiftPage = z.infer<typeof posShiftPageSchema>;
 export const posShiftCloseWithoutCountInputSchema = z.object({ note: optionalText(200) });
 export type PosShiftCloseWithoutCountInput = z.infer<typeof posShiftCloseWithoutCountInputSchema>;
 
+// ---------------------------------------------------------------------------------------------
+// Step 20c: the X and Z reports, on the receipt printer. Not sent by the API: the device makes one
+// from its own sales, returns and movements (packages/sync), and a shift's page from posShiftSchema,
+// and both print the same sheet.
+
+// x = while the shift is open, z = after its close
+export const POS_SHIFT_REPORT_KINDS = ['x', 'z'] as const;
+export type PosShiftReportKind = (typeof POS_SHIFT_REPORT_KINDS)[number];
+
+export interface TenderAmount {
+  method: PosTender;
+  amount: string;
+}
+
+export interface PosShiftReport {
+  kind: PosShiftReportKind;
+  register: { code: string; name: string };
+  shiftNumber: string;
+  cashierName: string;
+  openedAt: string;
+  // null on an X report
+  closedAt: string | null;
+  // By the clock of the device that prints it
+  printedAt: string;
+  saleCount: number;
+  // With VAT, after every discount
+  salesTotal: string;
+  salesDiscount: string;
+  salesVat: string;
+  returnCount: number;
+  returnsTotal: string;
+  returnsVat: string;
+  // Only the tenders with an amount, in POS_TENDERS order
+  taken: TenderAmount[];
+  refunded: TenderAmount[];
+  paidIn: string;
+  paidOut: string;
+  // The Z report's cash: the parts, what the drawer should have held, the count and the
+  // difference. null on an X report (blind), and on the Z of a shift closed without a count,
+  // which has no count to set against it.
+  drawer: (ShiftCash & { expected: string; counted: string; difference: string }) | null;
+}
+
+// Sold less given back: what the shift took in the end
+export function shiftNetOf(report: Pick<PosShiftReport, 'salesTotal' | 'returnsTotal'>): string {
+  return subtractMoney(report.salesTotal, report.returnsTotal);
+}
+
+// The amounts per tender a report prints: the ones above zero, in the tenders' order
+export function tenderAmountsOf(amounts: readonly TenderAmount[]): TenderAmount[] {
+  return POS_TENDERS.flatMap((method) => {
+    const amount = sumMoney(
+      amounts.filter((item) => item.method === method).map((item) => item.amount),
+    );
+    return compareMoney(amount, '0') > 0 ? [{ method, amount }] : [];
+  });
+}
+
 const idParamsSchema = z.object({ id: z.uuid() });
 
 // The reasons are read by everyone (the settings page shows them, read-only without the
```

- **`expectedCashOf()` takes three things off with `sumMoney()`,** the change, the pay outs and the cash refunds, so the
  sentence of 20b's decision 19 still reads in one expression.
- **The shift page's `cash` object is checked with `satisfies Record<keyof ShiftCash, z.ZodType>`:** a part added to
  `ShiftCash` later fails the type check until the page sends it.
- **`tenderAmountSchema` is defined once** for the payments and the refunds, both per tender.
- **`PosShiftReport.drawer` joins `ShiftCash` with the three results,** so the Z report prints every part of the
  expected cash, the way the shift's page shows them.
- **`tenderAmountsOf()` adds up per tender and drops zeros,** so the device can pass every payment of the shift as it
  is, and the sheet prints "bKash ৳2,750.50" once, in the tenders' order.

```diff
@@ -11,6 +11,8 @@ import {
   posCashMovementInputSchema,
   posCashReasonInputSchema,
   posShiftCloseInputSchema,
+  shiftNetOf,
+  tenderAmountsOf,
   updatePosCashReasonInputSchema,
 } from './pos-shifts.js';
 
@@ -83,12 +85,17 @@ describe('the cash of a shift', () => {
     changeGiven: '1320',
     paidIn: '2000',
     paidOut: '10000',
+    cashRefunded: '0',
   };
 
   it('expects the opening, plus what came in, less what went out', () => {
     expect(expectedCashOf(cash)).toBe('8160.0000');
   });
 
+  it('takes the cash the returns paid back off too', () => {
+    expect(expectedCashOf({ ...cash, cashRefunded: '736.50' })).toBe('7423.5000');
+  });
+
   it('is short when less was counted, and rings the bell only above the limit', () => {
     const short = cashDifferenceOf('7640', expectedCashOf(cash));
     expect(short).toBe('-520.0000');
@@ -99,6 +106,27 @@ describe('the cash of a shift', () => {
   });
 });
 
+describe('the X and Z reports', () => {
+  it("lists each tender's amount once, in the tenders' order, and leaves out nothing taken", () => {
+    const taken = tenderAmountsOf([
+      { method: 'bkash', amount: '2300' },
+      { method: 'cash', amount: '12480' },
+      { method: 'exchange', amount: '1200' },
+      { method: 'bkash', amount: '450.50' },
+      { method: 'card', amount: '0.0000' },
+    ]);
+    expect(taken).toEqual([
+      { method: 'cash', amount: '12480.0000' },
+      { method: 'bkash', amount: '2750.5000' },
+      { method: 'exchange', amount: '1200.0000' },
+    ]);
+  });
+
+  it('nets the returns off the sales', () => {
+    expect(shiftNetOf({ salesTotal: '58420.50', returnsTotal: '1936.50' })).toBe('56484.0000');
+  });
+});
+
 describe('reasons', () => {
   it('keeps the direction on a new reason, and drops it from a change', () => {
     const input = posCashReasonInputSchema.parse({
```

- **The 20b drawer gets `cashRefunded: '0'`,** so its ৳8,160 still holds, and a new test takes ৳736.50 off it.

### `sync.ts`: the sales on the device and the return command

```diff
@@ -11,6 +11,7 @@ import { errorCode, problemSchema } from './errors.js';
 import { versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
 import { posRegisterSchema, posSaleInputSchema } from './pos.js';
+import { posReturnableSaleSchema, posReturnInputSchema } from './pos-returns.js';
 import {
   posCashMovementInputSchema,
   posCashReasonSchema,
@@ -41,7 +42,8 @@ import { warehouseSchema } from './warehouses.js';
 // active customers with their groups, the warehouses of the device's branch and the stock in them,
 // and the part of the settings a sale needs. No customer balances and no stock values: they
 // change with every invoice and every movement, and they need their own permissions. Step 20a adds
-// the POS registers of the branch, step 20b the pay in and pay out reasons.
+// the POS registers of the branch, step 20b the pay in and pay out reasons, step 20c the recent
+// sales of the register the device holds (for returns offline).
 
 // The version of this protocol: what the entities below are and what their rows hold. A client
 // sends the version it was built with; the server answers sync_protocol_mismatch to any other,
@@ -51,7 +53,9 @@ import { warehouseSchema } from './warehouses.js';
 // 2 (step 20a): the POS registers (pos_register) and the pos_sale.create command.
 // 3 (step 20b): the pay in / pay out reasons (pos_cash_reason), a register's shift settings and
 // latest shift, a sale's shift, and the three shift commands.
-export const SYNC_PROTOCOL = 3;
+// 4 (step 20c): the register's recent sales (pos_sale), a register's return settings, the
+// exchange tender, and the pos_return.create command.
+export const SYNC_PROTOCOL = 4;
 
 // Every kind of row a device keeps. The order is the order of a full pull: the small lists that
 // the others point at come first, so a page never shows a product before its units.
@@ -69,6 +73,7 @@ export const SYNC_ENTITIES = [
   'price_list_item',
   'customer',
   'stock',
+  'pos_sale',
 ] as const;
 export type SyncEntity = (typeof SYNC_ENTITIES)[number];
 
@@ -112,7 +117,10 @@ export type SyncCustomerGroup = z.infer<typeof syncCustomerGroupSchema>;
 // numbers, the methods it takes, its discount limit and its receipt, and whether this device holds
 // it. Without lastNumber, which changes with every sale: the device that holds the register counts
 // on from the number the claim answered, and every sale would send the row again for nothing.
-export const syncPosRegisterSchema = posRegisterSchema.omit({ lastNumber: true });
+export const syncPosRegisterSchema = posRegisterSchema.omit({
+  lastNumber: true,
+  lastReturnNumber: true,
+});
 export type SyncPosRegister = z.infer<typeof syncPosRegisterSchema>;
 
 // A pay in or pay out reason (step 20b), active ones only: every device of the workspace gets all
@@ -121,6 +129,15 @@ export type SyncPosRegister = z.infer<typeof syncPosRegisterSchema>;
 export const syncPosCashReasonSchema = posCashReasonSchema;
 export type SyncPosCashReason = z.infer<typeof syncPosCashReasonSchema>;
 
+// A sale of the register this device holds (step 20c), from the last POS_SALES_ON_DEVICE_DAYS
+// days, with what was returned of each line: what the return screen needs offline. The device
+// reads them once when it takes the register (routes.posReturns.registerSales: they were logged
+// before it held the register, so no pull brings them), and the pulls send a sale again when a
+// sale or a return changes it. The device drops them itself when it lets go of the register, and
+// drops the older ones, since nothing changes on the server when a sale turns 31 days old.
+export const syncPosSaleSchema = posReturnableSaleSchema;
+export type SyncPosSale = z.infer<typeof syncPosSaleSchema>;
+
 // A customer with its addresses, without the balance (decision 10: the list asks the server for
 // the balances of the rows it shows, online only)
 export const syncCustomerSchema = customerSchema.omit({ balance: true });
@@ -200,6 +217,7 @@ export const syncUpsertSchema = z.discriminatedUnion('entity', [
   upsertOf('price_list_item', syncPriceListItemSchema),
   upsertOf('customer', syncCustomerSchema),
   upsertOf('stock', syncStockSchema),
+  upsertOf('pos_sale', syncPosSaleSchema),
 ]);
 export type SyncUpsert = z.infer<typeof syncUpsertSchema>;
 
@@ -349,6 +367,7 @@ export const SYNC_COMMAND_TYPES = [
   'pos_shift.open',
   'pos_cash_movement.create',
   'pos_shift.close',
+  'pos_return.create',
 ] as const;
 export type SyncCommandType = (typeof SYNC_COMMAND_TYPES)[number];
 
@@ -419,6 +438,18 @@ export const posShiftCloseCommandSchema = z.object({
   input: posShiftCloseInputSchema,
 });
 
+// Step 20c: a return at a POS counter, the money already paid back (pos-returns.ts). Posted when it
+// arrives, never refused for the window, the quantity left or permission. It waits for its shift's
+// open, and for its sale when that sale is still in the same outbox. An exchange's sale is saved
+// with it and waits for it: its payment names the return.
+export const posReturnCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('pos_return.create'),
+  // The return's id, made on the device: the exchange's sale points at it
+  returnId: z.uuidv7(),
+  input: posReturnInputSchema,
+});
+
 export const syncCommandSchema = z.discriminatedUnion('type', [
   customerCreateCommandSchema,
   customerUpdateCommandSchema,
@@ -427,6 +458,7 @@ export const syncCommandSchema = z.discriminatedUnion('type', [
   posShiftOpenCommandSchema,
   posCashMovementCommandSchema,
   posShiftCloseCommandSchema,
+  posReturnCommandSchema,
 ]);
 export type SyncCommand = z.infer<typeof syncCommandSchema>;
 export type SyncCommandInput = z.input<typeof syncCommandSchema>;
@@ -475,10 +507,12 @@ export const syncResultSchema = z.discriminatedUnion('status', [
     status: z.literal('accepted'),
     notices: z.array(syncNoticeSchema),
     // The rows the command changed, as they are now, for the device to write at once instead of
-    // waiting for its next pull: the customer for a customer command; nothing for an order, a POS
-    // sale or a shift's command (none of them is on the device as a row; the stock a sale took and
-    // the register's latest shift come with the next pull). Read when the answer is made, also for
-    // a command sent again, so an old answer never puts an older row back on the device.
+    // waiting for its next pull: the customer for a customer command; the sale (pos_sale) for a
+    // POS sale or return of the register the device holds, so the return screen knows at once what
+    // is left of it; nothing for an order or a shift's command (neither is on the device as a row;
+    // the stock and the register's latest shift come with the next pull). Read when the answer is
+    // made, also for a command sent again, so an old answer never puts an older row back on the
+    // device.
     changes: z.array(syncChangeSchema),
   }),
   z.object({
```

- **`SYNC_PROTOCOL` is 4** (decision 24), with its line in the comment's list.
- **`pos_sale` is the last entity:** a sale points at products, customers and the register, so it comes after all of
  them in a full pull.
- **`syncPosRegisterSchema` leaves out `lastReturnNumber` too** (decision 12).
- **The return's id is made on the device** (`z.uuidv7()`): its exchange sale points at it before the server has seen
  either.
- **The accepted result's comment says which rows come back** (decision 23); the API follows it in 20c.3.

```diff
@@ -4,6 +4,7 @@ import { contractErrorMap } from './errors.js';
 import {
   customerUpdateCommandSchema,
   deviceKeySchema,
+  posReturnCommandSchema,
   posSaleCommandSchema,
   posShiftOpenCommandSchema,
   priceListItemKey,
@@ -436,15 +437,18 @@ describe('POS on the device', () => {
     overShortAccountId: RATE,
     varianceAlert: '500',
     lockAfter: '5',
+    exchangeAccountId: null,
+    returnDays: 7,
     deviceId: COMMAND,
     lastNumber: 122,
+    lastReturnNumber: 11,
     lastShift: { id: CUSTOMER, sequence: 41, status: 'closed', cashLeft: '5000.0000' },
     archivedAt: null,
     version: 4,
     updatedAt: AT,
   };
 
-  it('keeps a register without its last number, which changes with every sale', () => {
+  it('keeps a register without its last numbers, which change with every sale and return', () => {
     const change = syncUpsertSchema.parse({
       op: 'upsert',
       entity: 'pos_register',
@@ -453,6 +457,7 @@ describe('POS on the device', () => {
     });
     expect(change.entity === 'pos_register' && change.data.code).toBe('POS1');
     expect(change.data).not.toHaveProperty('lastNumber');
+    expect(change.data).not.toHaveProperty('lastReturnNumber');
     expect(change.entity === 'pos_register' && change.data.lastShift?.sequence).toBe(41);
   });
 
@@ -557,10 +562,86 @@ describe('POS on the device', () => {
     const command = { id: COMMAND, type: 'pos_sale.create', saleId: CUSTOMER, input };
     const parsed = syncCommandSchema.parse(command);
     expect(parsed.type).toBe('pos_sale.create');
-    // A sale made before 20b, still in an outbox when the app was updated, has no shift
+    // A sale made before 20b, still in an outbox when the app was updated, has no shift; one
+    // made before 20c has no return on its payments
     expect(parsed.type === 'pos_sale.create' && parsed.input.shiftId).toBeNull();
+    expect(parsed.type === 'pos_sale.create' && parsed.input.payments[0]?.returnId).toBeNull();
     expect(errorsOf(posSaleCommandSchema.safeParse({ ...command, saleId: V4 }))).toEqual({
       saleId: 'Invalid UUID',
     });
   });
+
+  // Ten strips of Napa sold at POS1 on 27 October, three of them brought back since
+  const sold = {
+    id: CUSTOMER,
+    number: 'POS1-000123',
+    registerId: ORDER,
+    date: '2026-10-27',
+    soldAt: AT,
+    customer: null,
+    pricesIncludeVat: true,
+    total: '120.0000',
+    lines: [
+      {
+        id: ADDRESS,
+        variantId: VARIANT,
+        productId: PRODUCT,
+        productCode: 'P-0012',
+        productName: 'Napa 500 mg',
+        optionValues: [],
+        sku: 'NAPA-500',
+        baseUnitId: UNIT,
+        tracking: 'batch',
+        unitId: UNIT,
+        quantity: '10.0000',
+        baseQuantity: '10.0000',
+        description: 'Napa 500 mg',
+        unitPrice: '12.0000',
+        taxRate: { id: RATE, name: 'Exempt', kind: 'exempt', rate: '0.00' },
+        net: '120.0000',
+        vat: '0.0000',
+        total: '120.0000',
+        serialNumbers: [],
+        returnedSerialNumbers: [],
+        returnedQuantity: '3.0000',
+      },
+    ],
+    payments: [{ method: 'cash', amount: '120.0000' }],
+  };
+
+  it("keeps the register's recent sales, with what came back of each line", () => {
+    const change = syncUpsertSchema.parse({
+      op: 'upsert',
+      entity: 'pos_sale',
+      key: CUSTOMER,
+      data: sold,
+    });
+    expect(change.entity === 'pos_sale' && change.data.lines[0]?.returnedQuantity).toBe('3.0000');
+  });
+
+  it('takes a return back under an id the device made, so its exchange can point at it', () => {
+    const command = {
+      id: COMMAND,
+      type: 'pos_return.create',
+      returnId: BATCH,
+      input: {
+        registerId: ORDER,
+        sequence: 12,
+        shiftId: PRODUCT,
+        date: '2026-10-28',
+        returnedAt: AT,
+        saleId: CUSTOMER,
+        lines: [
+          { saleLineId: ADDRESS, quantity: '2', net: '24.0000', vat: '0.0000', serialNumbers: [] },
+        ],
+        refunds: [{ method: 'cash', amount: '24', reference: '' }],
+        note: '',
+      },
+    };
+    const parsed = syncCommandSchema.parse(command);
+    expect(parsed.type === 'pos_return.create' && parsed.input.note).toBeNull();
+    expect(errorsOf(posReturnCommandSchema.safeParse({ ...command, returnId: V4 }))).toEqual({
+      returnId: 'Invalid UUID',
+    });
+  });
 });
```

- **The sale test also checks a payment without `returnId`** (decision 11).
- **The `pos_sale` row is ten strips of Napa,** three back already: the row carries `returnedQuantity`.

### `permissions.ts`, `errors.ts`, `audit.ts`

```diff
@@ -48,6 +48,7 @@ export const PERMISSION_KEYS = [
   'pos.price.override',
   'pos.register.manage',
   'pos.shift.manage',
+  'pos.return.create',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -118,4 +119,5 @@ export const PERMISSION_GROUP_OF = {
   'pos.price.override': 'pos',
   'pos.register.manage': 'pos',
   'pos.shift.manage': 'pos',
+  'pos.return.create': 'pos',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

```diff
@@ -547,6 +547,33 @@ export const ERROR_CODES = [
   // last one open, and a sale, movement or close for a shift the server does not know
   'pos_shift_already_open',
   'pos_shift_unknown',
+  // Step 20c: returns. A register's return window is not a whole number of days up to 365; its
+  // exchange account is not an active liability account that is not a group
+  'pos_return_days_format',
+  'pos_exchange_account_invalid',
+  // The cashier's return screen: no receipt with this number (offline: not on this device), a sale
+  // older than the register's window, a sale with nothing left to return, more of a line than is
+  // left, nothing ticked, a refund box left empty, refunds that do not add up to the return's total
+  'pos_return_sale_not_found',
+  'pos_return_too_old',
+  'pos_return_nothing_left',
+  'pos_return_quantity_too_large',
+  'pos_return_lines_required',
+  'pos_refund_amount_required',
+  'pos_refund_mismatch',
+  // The register has no exchange account (any more): someone with pos.register.manage sets one,
+  // then the cashier sends the return again from the Sync page, like pos_method_not_set
+  'pos_exchange_not_set',
+  // Bugs, never a cashier's mistake: an exchange that does not match its return (another amount, a
+  // return used twice, another register's), a sale's exchange for a return the server does not
+  // have, a return number already taken, a sale line twice, a line or a serial number that is not
+  // the sale's
+  'pos_exchange_invalid',
+  'pos_return_unknown',
+  'pos_return_number_taken',
+  'pos_return_line_twice',
+  'pos_return_line_unknown',
+  'pos_return_serial_invalid',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **The codes are in three groups,** as the comments say: the register's form, the cashier's screen, and the server's
  refusals, the fixable one (`pos_exchange_not_set`) apart from the bugs.

```diff
@@ -236,6 +236,16 @@ export const AUDIT_ACTIONS = [
   'pos_shift.closed_without_count',
   'pos_shift.expected_differs',
   'pos_shift.without_permission',
+  // step 20c. A return's rows name its device like a sale's. The server takes every return, and
+  // writes what it would have refused: outside_window (after the register's window),
+  // over_returned (more of a line than was left: another counter took some back first),
+  // amounts_differ (the device's money back was not the server's arithmetic, for the same reason),
+  // without_permission (the cashier no longer had pos.return.create).
+  'pos_return.created',
+  'pos_return.outside_window',
+  'pos_return.over_returned',
+  'pos_return.amounts_differ',
+  'pos_return.without_permission',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -292,6 +302,7 @@ export const AUDIT_ENTITY_TYPES = [
   'pos_sale',
   'pos_cash_reason',
   'pos_shift',
+  'pos_return',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- **The four "would have refused" actions are separate,** not one action with a reason: the audit page filters by
  action, and a manager looks for "outside the window" on its own.

### `journal.ts` and `stock.ts`: the return's entry and movement

```diff
@@ -42,6 +42,10 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // pos_shift (step 20b): the cash of a shift. Its opening difference (or a first shift's float),
 // each pay in and pay out, and its closing difference, each an entry of its own, all pointing at
 // the shift.
+// pos_return (step 20c): a POS return, in one entry like a sale: Dr Sales returns (or Sales) and
+// VAT payable, Cr each refund's account (an exchange's: the register's exchange account), and Dr
+// Inventory / Cr Cost of goods sold for the goods at what they cost when sold. A stock document's
+// entry, and never undone: a mistake is a new sale.
 export const JOURNAL_SOURCES = [
   'manual',
   'opening_balance',
@@ -64,6 +68,7 @@ export const JOURNAL_SOURCES = [
   'purchase_refund',
   'pos_sale',
   'pos_shift',
+  'pos_return',
 ] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
@@ -81,6 +86,7 @@ export const STOCK_JOURNAL_SOURCES = [
   'purchase_receipt',
   'purchase_return',
   'pos_sale',
+  'pos_return',
 ] as const satisfies readonly JournalSource[];
 export type StockJournalSource = (typeof STOCK_JOURNAL_SOURCES)[number];
 
```

```diff
@@ -15,6 +15,7 @@ import { levelSchema, quantitySchema } from './quantities.js';
 // purchase_receipt (step 17b): goods a supplier delivered against a purchase order.
 // purchase_return (step 17d): goods sent back to a supplier.
 // pos_sale (step 20a): goods sold at a POS counter.
+// pos_return (step 20c): goods a customer brought back to a POS counter.
 export const MOVEMENT_KINDS = [
   'adjustment',
   'transfer_out',
@@ -25,6 +26,7 @@ export const MOVEMENT_KINDS = [
   'purchase_receipt',
   'purchase_return',
   'pos_sale',
+  'pos_return',
 ] as const;
 export type MovementKind = (typeof MOVEMENT_KINDS)[number];
 
```

- **`pos_return` is in `STOCK_JOURNAL_SOURCES`,** like `pos_sale`: its entry moves stock and its value together, and
  `DOCUMENT_JOURNAL_SOURCES` (and the database's `journal_entries_document_check`, 20c.2) take it from there.

### `routes.ts`, `index.ts`

```diff
@@ -25,6 +25,7 @@ import { deviceRoutes } from './devices.js';
 import { documentOutputRoutes, publicDocumentRoutes } from './document-output.js';
 import { goodsReceiptRoutes } from './goods-receipts.js';
 import { posRoutes } from './pos.js';
+import { posReturnRoutes } from './pos-returns.js';
 import { posShiftRoutes } from './pos-shifts.js';
 import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
@@ -139,4 +140,5 @@ export const routes = {
   devices: deviceRoutes,
   pos: posRoutes,
   posShifts: posShiftRoutes,
+  posReturns: posReturnRoutes,
 };
```

```diff
@@ -26,6 +26,7 @@ export * from './notifications.js';
 export * from './numbering.js';
 export * from './pagination.js';
 export * from './pos.js';
+export * from './pos-returns.js';
 export * from './pos-shifts.js';
 export * from './permissions.js';
 export * from './preferences.js';
```

The OpenAPI document is generated from the built package (`@omnivo/contracts` points at `dist/`), so build it first:

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts gen:openapi
```

It adds the three return routes, the register's new fields, the sale's returns and the sync command's shape to
`packages/contracts/openapi.json`. Commit it as it is. Without the build, the generator reads the old `dist/` and writes
the old document, and says it is valid.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
```

All pass (contracts 350 tests, 24 new). Do not run the whole `pnpm typecheck` yet. Until their parts, these fail, as
expected: `packages/db` (the permission catalog has no text for `pos.return.create`, 20c.2), `packages/i18n` (`en.ts`
misses the new error codes, 20c.5), `apps/api` (the register's new fields, the cash refunded, the sale's returns, the
journal source and movement kind in the posting code, the push's new command, 20c.3), `packages/sync` (no table for
`pos_sale`, the cash refunded, the payment's `returnId`, 20c.6) and `apps/app` (the new tender, register fields, journal
source and command have no text or mock yet, 20c.5 to 20c.7).

## 20c.2 — `packages/db`: returns, their refunds, and the exchange

Four new tables and four new columns, all in `schema/pos.ts`. Migration 0055 is generated from the schema, with its
indexes moved up as in every step. Migration 0056 is written by hand: row-level security, the checks a return must pass
at commit, a new version of the sale's check (the exchange), the shift's cash with the refunds, the register's guard
and change log, and the change log of the sales on the devices.

### `schema/pos.ts`: the register's return settings, the exchange, four new tables

```diff
@@ -4,8 +4,8 @@ import {
   POS_CASH_DIRECTIONS,
   POS_LOCK_AFTER,
   POS_PAPER_WIDTHS,
-  POS_PAYMENT_METHODS,
   POS_SHIFT_STATUSES,
+  POS_TENDERS,
 } from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
 import {
@@ -48,6 +48,12 @@ import { warehouses } from './warehouses.js';
 // the drawer at the start to the count at the end, with money put in or taken out for a reason in
 // between. The shift's tables sit between the registers and the sales, because a sale points at
 // its shift. The rules live in migration 0054.
+//
+// Step 20c: returns. A customer brings goods back to a counter with the receipt; the return is a
+// document of its own (POS1-R000012), made on the device and posted when it arrives
+// (pos_return.create), like a sale. It points at the sale and at the shift of the register that
+// took the goods back. Its money goes back by refunds, or as an exchange: a refund of the tender
+// 'exchange' that a sale saved with it uses as a payment. The rules live in migration 0056.
 
 // ---------------------------------------------------------------------------------------------
 // Registers
```

- **`POS_TENDERS` replaces `POS_PAYMENT_METHODS` in the imports.** A sale payment and a refund now take a tender (the
  four methods and `exchange`, decision 10), and nothing else in this file used the methods' list.
- **The file's header says where the rules are:** 0056, like 0052 and 0054 for the earlier parts.

```diff
@@ -86,6 +92,12 @@ export const posRegisters = pgTable(
     varianceAlert: numeric('variance_alert', { precision: 12, scale: 0 }).notNull().default('500'),
     // Minutes of no key, click or touch before /pos locks the screen; 'off' = never
     lockAfter: text('lock_after', { enum: POS_LOCK_AFTER }).notNull().default('5'),
+    // Step 20c. The account an exchange passes through ("POS exchange clearing", a liability): a
+    // return puts the money on it, the sale made with it takes it off. NULL = this counter makes
+    // no exchanges, only refunds.
+    exchangeAccountId: uuid('exchange_account_id'),
+    // How many days after a sale's date the counter takes its goods back; 0 = the same day only
+    returnDays: smallint('return_days').notNull().default(7),
     // The device that holds it (decision 14); NULL = free. Set by a claim, cleared by a release,
     // and by the database itself when that device is revoked or moved to another branch (0052).
     deviceId: uuid('device_id'),
@@ -94,6 +106,8 @@ export const posRegisters = pgTable(
     // grows (0052). Written without touching version: a sale must not make a manager's edit of
     // the register fail on its version.
     lastNumber: integer('last_number').notNull().default(0),
+    // Step 20c: the same for its own series of returns (POS1-R000012), with the same rules
+    lastReturnNumber: integer('last_return_number').notNull().default(0),
     archivedAt: timestamp('archived_at', { withTimezone: true }),
   },
   (table) => [
@@ -145,11 +159,20 @@ export const posRegisters = pgTable(
       columns: [table.tenantId, table.overShortAccountId],
       foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
     }),
+    foreignKey({
+      name: 'pos_registers_exchange_account_fk',
+      columns: [table.tenantId, table.exchangeAccountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
     // The contract's format: the code is split from the number at the hyphen
     check('pos_registers_code_check', sql`${table.code} ~ '^[A-Z][A-Z0-9]{1,7}$'`),
     check('pos_registers_discount_check', sql`${table.maxDiscountPercent} BETWEEN 0 AND 100`),
     check('pos_registers_paper_check', sql`${table.paperWidth} IN ('58', '80')`),
-    check('pos_registers_last_number_check', sql`${table.lastNumber} >= 0`),
+    check(
+      'pos_registers_last_number_check',
+      sql`${table.lastNumber} >= 0 AND ${table.lastReturnNumber} >= 0`,
+    ),
+    check('pos_registers_return_days_check', sql`${table.returnDays} BETWEEN 0 AND 365`),
     check('pos_registers_variance_alert_check', sql`${table.varianceAlert} >= 0`),
     check(
       'pos_registers_lock_after_check',
```

**`pos_registers`:**

- **`exchange_account_id` is nullable** (decisions 6 and 44): empty means the counter makes no exchanges. Like the
  over/short account, it has a real foreign key, so an account a register uses cannot be deleted and another
  workspace's account cannot be named. The API checks that it is an active liability account that is not a group
  (`pos_exchange_account_invalid`); a check here could not read the account's type.
- **`return_days` is a `smallint` with a default of 7** (decisions 2 and 8). The default fills every register made
  before this step, so the migration needs no value from you. `pos_registers_return_days_check` keeps it between 0 and
  365, the contract's limits.
- **`last_return_number` works like `last_number`** (decision 43): 0 = no return yet; the claim answers it, so the next
  device numbers its returns on from it. The existing check is widened to cover both numbers instead of adding a second
  check with the same meaning.

```diff
@@ -634,7 +657,8 @@ export const posSaleLineBatches = pgTable(
   ],
 );
 
-// How the customer paid: cash and a card, or bKash with the rest in cash
+// How the customer paid: cash and a card, or bKash with the rest in cash. Step 20c: or with the
+// money of a return saved with the sale (the tender 'exchange'), the rest by any method.
 export const posSalePayments = pgTable(
   'pos_sale_payments',
   {
@@ -644,13 +668,15 @@ export const posSalePayments = pgTable(
     saleId: uuid('sale_id').notNull(),
     // The order the cashier took them in
     lineNo: smallint('line_no').notNull(),
-    method: text('method', { enum: POS_PAYMENT_METHODS }).notNull(),
+    method: text('method', { enum: POS_TENDERS }).notNull(),
     amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
     // The card's last 4 digits or approval code, the bKash or Nagad TrxID
     reference: text('reference'),
     // The register's account for the method when the sale was posted: a later change of the
-    // register does not move old money
+    // register does not move old money. An exchange's is the register's exchange account.
     accountId: uuid('account_id').notNull(),
+    // Step 20c: an exchange's return; NULL for the other tenders
+    returnId: uuid('return_id'),
   },
   (table) => [
     primaryKey({
@@ -659,6 +685,11 @@ export const posSalePayments = pgTable(
     }),
     // The account FK's check when an account is deleted: a busy counter has thousands of rows
     index('pos_sale_payments_account_idx').on(table.tenantId, table.accountId),
+    // A return's money pays for one sale: the last word on pos_exchange_invalid when two sales
+    // name the same return. Also the return FK's own index.
+    uniqueIndex('pos_sale_payments_return_idx')
+      .on(table.tenantId, table.returnId)
+      .where(sql`${table.returnId} IS NOT NULL`),
     foreignKey({
       name: 'pos_sale_payments_sale_fk',
       columns: [table.tenantId, table.saleId],
```

**`pos_sale_payments`:**

- **`method` takes a tender,** so an exchange is a payment like any other in the sale's sums: 0052's check adds it to
  what was paid, counts it as "not cash" (so it can never be more than the total), and the change stays a cash thing.
- **`return_id` is the exchange's return** (decision 38). It is on the payment, not on the return, because the return is
  written first: it cannot point at a sale that is not there yet.
- **`pos_sale_payments_return_idx` is unique and partial:** a return's money pays for one sale, and only the few
  exchange payments are in the index. It is the last word when two sales name the same return, and the index the
  foreign key's own check needs.
- **The account of an exchange payment is the register's exchange account,** copied like the other methods' accounts:
  changing the register later moves no old money.

```diff
@@ -669,10 +700,257 @@ export const posSalePayments = pgTable(
       columns: [table.tenantId, table.accountId],
       foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
     }),
+    // The return is never deleted (0056), so no ON DELETE
+    foreignKey({
+      name: 'pos_sale_payments_return_fk',
+      columns: [table.tenantId, table.returnId],
+      foreignColumns: [posReturns.tenantId, posReturns.id],
+    }),
+    // Exchange, and only exchange, names a return
     check(
       'pos_sale_payments_method_check',
-      sql`${table.method} IN ('cash', 'card', 'bkash', 'nagad')`,
+      sql`${table.method} IN ('cash', 'card', 'bkash', 'nagad', 'exchange') AND (${table.method} = 'exchange') = (${table.returnId} IS NOT NULL)`,
     ),
     check('pos_sale_payments_amount_check', sql`${table.amount} > 0`),
   ],
 );
+
+// ---------------------------------------------------------------------------------------------
+// Returns (step 20c)
+
+// Goods a customer brought back with the receipt of a POS sale. Posted when it arrives, like a
+// sale: no draft, no status, never changed and never deleted (0056). The id is made by the device
+// (the command's returnId), so an exchange sale saved with it can point at it before the server
+// has seen either. created_by is the cashier; created_at is when the server received it.
+// The customer and "prices include VAT" are the sale's, read through sale_id: a return has no
+// customer of its own.
+export const posReturns = pgTable(
+  'pos_returns',
+  {
+    ...baseColumns(),
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    // The register that took the goods back, and its shift: the money left that drawer, whatever
+    // register and shift the sale was in
+    registerId: uuid('register_id').notNull(),
+    shiftId: uuid('shift_id').notNull(),
+    deviceId: uuid('device_id').notNull(),
+    // Its place in the register's series of returns, and the number it makes (formatReturnNumber)
+    sequence: integer('sequence').notNull(),
+    number: text('number').notNull(),
+    // The day it is in the books (the device's day, or the first open day after it), and when it
+    // happened by the device's clock
+    date: date('date', { mode: 'string' }).notNull(),
+    returnedAt: timestamp('returned_at', { withTimezone: true }).notNull(),
+    saleId: uuid('sale_id').notNull(),
+    // Where the goods came back into: the register's warehouse when it was posted (decision 3)
+    warehouseId: uuid('warehouse_id').notNull(),
+    // The sums of its lines: what it paid back, with and without VAT
+    net: numeric('net', { precision: 19, scale: 4 }).notNull(),
+    vat: numeric('vat', { precision: 19, scale: 4 }).notNull(),
+    total: numeric('total', { precision: 19, scale: 4 }).notNull(),
+    note: text('note'),
+    // It came after the register's window: posted anyway, with an audit row (decision 20)
+    outsideWindow: boolean('outside_window').notNull().default(false),
+  },
+  (table) => [
+    // The target of the composite FKs from the lines, the refunds and the exchange payments
+    uniqueIndex('pos_returns_tenant_id_idx').on(table.tenantId, table.id),
+    // A number is never given twice (POS1-R000012): the last word on pos_return_number_taken
+    uniqueIndex('pos_returns_tenant_number_idx').on(table.tenantId, table.number),
+    uniqueIndex('pos_returns_register_sequence_idx').on(
+      table.tenantId,
+      table.registerId,
+      table.sequence,
+    ),
+    // The list: newest date first, keyset on (date, id); and the same for one register
+    index('pos_returns_tenant_date_idx').on(table.tenantId, table.date, table.id),
+    index('pos_returns_register_idx').on(table.tenantId, table.registerId, table.date, table.id),
+    // A sale's returns (its page, what is left to return) and a shift's (its page, its cash)
+    index('pos_returns_sale_idx').on(table.tenantId, table.saleId),
+    index('pos_returns_shift_idx').on(table.tenantId, table.shiftId),
+    foreignKey({
+      name: 'pos_returns_register_fk',
+      columns: [table.tenantId, table.registerId],
+      foreignColumns: [posRegisters.tenantId, posRegisters.id],
+    }),
+    // The shift is of this return's register and device, like a sale's
+    foreignKey({
+      name: 'pos_returns_shift_fk',
+      columns: [table.tenantId, table.shiftId, table.registerId, table.deviceId],
+      foreignColumns: [posShifts.tenantId, posShifts.id, posShifts.registerId, posShifts.deviceId],
+    }),
+    foreignKey({
+      name: 'pos_returns_sale_fk',
+      columns: [table.tenantId, table.saleId],
+      foreignColumns: [posSales.tenantId, posSales.id],
+    }),
+    // Warehouses and devices are never deleted: no index for these two
+    foreignKey({
+      name: 'pos_returns_warehouse_fk',
+      columns: [table.tenantId, table.warehouseId],
+      foreignColumns: [warehouses.tenantId, warehouses.id],
+    }),
+    foreignKey({
+      name: 'pos_returns_device_fk',
+      columns: [table.tenantId, table.deviceId],
+      foreignColumns: [devices.tenantId, devices.id],
+    }),
+    check('pos_returns_sequence_check', sql`${table.sequence} >= 1`),
+    check(
+      'pos_returns_totals_check',
+      sql`${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
+    ),
+  ],
+);
+
+// One line of the sale coming back, in the sale line's unit (decision 17). The product, the unit,
+// the description, the price and the VAT rate are the sale line's, read through sale_line_id.
+export const posReturnLines = pgTable(
+  'pos_return_lines',
+  {
+    id: baseColumns().id,
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    returnId: uuid('return_id').notNull(),
+    lineNo: smallint('line_no').notNull(),
+    saleLineId: uuid('sale_line_id').notNull(),
+    // The sale line's variant: in the key of the sale line's FK, and what the stock moves
+    variantId: uuid('variant_id').notNull(),
+    // In the sale line's unit, and in the base unit
+    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
+    baseQuantity: numeric('base_quantity', { precision: 19, scale: 4 }).notNull(),
+    // The device's share of the sale line's money (posReturnAmounts); the books take these
+    net: numeric('net', { precision: 19, scale: 4 }).notNull(),
+    vat: numeric('vat', { precision: 19, scale: 4 }).notNull(),
+    total: numeric('total', { precision: 19, scale: 4 }).notNull(),
+    // What the goods cost when they were sold: the sale line's value, pro rata (a positive number)
+    value: numeric('value', { precision: 19, scale: 4 }).notNull(),
+    // A serial product: the serial numbers that came back, out of the sale line's
+    serialNumbers: text('serial_numbers')
+      .array()
+      .notNull()
+      .default(sql`'{}'::text[]`),
+  },
+  (table) => [
+    uniqueIndex('pos_return_lines_line_idx').on(table.tenantId, table.returnId, table.lineNo),
+    // A sale line once per return: the last word on pos_return_line_twice. Also the target of
+    // the line batches' FK, which carries the sale line.
+    uniqueIndex('pos_return_lines_sale_line_idx').on(
+      table.tenantId,
+      table.returnId,
+      table.saleLineId,
+    ),
+    uniqueIndex('pos_return_lines_batch_key_idx').on(table.tenantId, table.id, table.saleLineId),
+    // What came back of a sale line so far: a return, the sale's page, the device's row
+    index('pos_return_lines_returned_idx').on(table.tenantId, table.saleLineId),
+    foreignKey({
+      name: 'pos_return_lines_return_fk',
+      columns: [table.tenantId, table.returnId],
+      foreignColumns: [posReturns.tenantId, posReturns.id],
+    }),
+    // variant_id is in the key: the line moves the sale line's own variant
+    foreignKey({
+      name: 'pos_return_lines_sale_line_fk',
+      columns: [table.tenantId, table.variantId, table.saleLineId],
+      foreignColumns: [posSaleLines.tenantId, posSaleLines.variantId, posSaleLines.id],
+    }),
+    check(
+      'pos_return_lines_quantity_check',
+      sql`${table.quantity} > 0 AND ${table.baseQuantity} > 0`,
+    ),
+    check(
+      'pos_return_lines_amounts_check',
+      sql`${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat} AND ${table.value} >= 0`,
+    ),
+  ],
+);
+
+// The batches a batch product's line went back into, in the base unit: always batches the sale
+// line left from (the FK on sale_line_id, batch_id). The rows add up to the line's base quantity
+// (0056).
+export const posReturnLineBatches = pgTable(
+  'pos_return_line_batches',
+  {
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    lineId: uuid('line_id').notNull(),
+    // The return line's sale line, so the batch below is checked against that line's batches
+    saleLineId: uuid('sale_line_id').notNull(),
+    batchId: uuid('batch_id').notNull(),
+    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
+  },
+  (table) => [
+    primaryKey({
+      name: 'pos_return_line_batches_pkey',
+      columns: [table.tenantId, table.lineId, table.batchId],
+    }),
+    foreignKey({
+      name: 'pos_return_line_batches_line_fk',
+      columns: [table.tenantId, table.lineId, table.saleLineId],
+      foreignColumns: [posReturnLines.tenantId, posReturnLines.id, posReturnLines.saleLineId],
+    }),
+    // A batch the sale line left from. Sale line batches are never deleted, so no index here.
+    foreignKey({
+      name: 'pos_return_line_batches_sale_batch_fk',
+      columns: [table.tenantId, table.saleLineId, table.batchId],
+      foreignColumns: [
+        posSaleLineBatches.tenantId,
+        posSaleLineBatches.lineId,
+        posSaleLineBatches.batchId,
+      ],
+    }),
+    check('pos_return_line_batches_quantity_check', sql`${table.quantity} > 0`),
+  ],
+);
+
+// How the money went back: cash, the card or bKash it came by, or an exchange. They add up to the
+// return's total (0056); a return of ৳0 has none.
+export const posReturnRefunds = pgTable(
+  'pos_return_refunds',
+  {
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    returnId: uuid('return_id').notNull(),
+    // The order the cashier gave them in
+    lineNo: smallint('line_no').notNull(),
+    method: text('method', { enum: POS_TENDERS }).notNull(),
+    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
+    // The card's approval code, the TrxID of the bKash money sent back
+    reference: text('reference'),
+    // The register's account for the method when the return was posted (its exchange account
+    // for an exchange): a later change of the register does not move old money
+    accountId: uuid('account_id').notNull(),
+  },
+  (table) => [
+    primaryKey({
+      name: 'pos_return_refunds_pkey',
+      columns: [table.tenantId, table.returnId, table.lineNo],
+    }),
+    // One exchange per return: the last word on the input's rule
+    uniqueIndex('pos_return_refunds_exchange_idx')
+      .on(table.tenantId, table.returnId)
+      .where(sql`${table.method} = 'exchange'`),
+    // The account FK's check when an account is deleted, like the sale payments'
+    index('pos_return_refunds_account_idx').on(table.tenantId, table.accountId),
+    foreignKey({
+      name: 'pos_return_refunds_return_fk',
+      columns: [table.tenantId, table.returnId],
+      foreignColumns: [posReturns.tenantId, posReturns.id],
+    }),
+    foreignKey({
+      name: 'pos_return_refunds_account_fk',
+      columns: [table.tenantId, table.accountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
+    check(
+      'pos_return_refunds_method_check',
+      sql`${table.method} IN ('cash', 'card', 'bkash', 'nagad', 'exchange')`,
+    ),
+    check('pos_return_refunds_amount_check', sql`${table.amount} > 0`),
+  ],
+);
```

- **The payment's foreign key to the return** has no `ON DELETE`: a return is never deleted (0056). The method check now
  also says that `exchange`, and only `exchange`, names a return. A check, not a trigger: it is about one row.

**`pos_returns`:**

- **The id comes from the device** (the command's `returnId`), like a sale's: the exchange sale saved with it points at
  it before the server has seen either.
- **The register, the shift and the device are the ones that took the goods back** (decision 19): the money left that
  drawer, whatever register and shift the sale was in. `pos_returns_shift_fk` uses the same index as a sale's
  (`pos_shifts_sale_key_idx`), so a return of shift 42 is from that shift's own register and device. It does not check
  that the shift is open (decision 40).
- **`sequence` and `number` are both stored,** like a sale's: the series is per register (`pos_returns_register_sequence_idx`)
  and the number is unique in the workspace (`pos_returns_tenant_number_idx`, the last word on
  `pos_return_number_taken`).
- **`warehouse_id` is the register's warehouse when the return was posted** (decision 3), so the stock card and the
  branch of the entry stay right when the register moves later.
- **No customer and no "prices include VAT"** (decision 34): the list and the page read them from the sale.
- **No entry column:** like a sale's, the return's entry points at the return (`document_id`), and
  `journal_entries_document_idx` finds it.
- **`outside_window`** is set by the API when the return came after the register's window (decision 20); the list shows
  it. The default is `false`, so the column is never `NULL`.
- **`net`, `vat` and `total` are the sums of the lines** (0056 checks it at commit); `pos_returns_totals_check` keeps
  the row itself consistent. There is no discount column: a line's money is already after its discounts.
- **The indexes:** the list by date and by register (keyset on `(date, id)`, like the sales), a sale's returns (its page,
  what is left to return) and a shift's (its page and its cash).

**`pos_return_lines`:**

- **The line keeps only what is its own** (decision 35). The sale line, which never changes, has the rest.
- **`variant_id` is in the sale line's foreign key** (`pos_return_lines_sale_line_fk`), which uses 20a's
  `pos_sale_lines_variant_id_idx`: a return line moves the variant its sale line sold, and the old table needs no new
  index.
- **`quantity` is in the sale line's unit, `base_quantity` in the base unit** (decision 17). The stock moves the base
  quantity.
- **`net`, `vat` and `total` are the device's** (decision 14), and `value` is what the goods cost when they were sold,
  pro rata (decision 3): the goods come back at that cost, so the return undoes exactly the cost the sale took out.
- **`pos_return_lines_sale_line_idx`** puts a sale line once in a return: the last word on `pos_return_line_twice`.
  `pos_return_lines_batch_key_idx` exists only as the target of the batch rows' foreign key, which carries the sale
  line.
- **`pos_return_lines_returned_idx`** adds up what came back of a sale line so far: for the next return, for the sale's
  page and for the device's row.
- **No `ON DELETE CASCADE`** on the return's foreign key, unlike 15d's draft returns: a POS return is never deleted.

**`pos_return_line_batches`:**

- **One row per batch a line went back into,** like `pos_sale_line_batches`.
- **`pos_return_line_batches_sale_batch_fk` points at the sale line's batch row** (decision 37): goods go back only into
  a batch the line left from. `sale_line_id` is on the row for this key, and `pos_return_line_batches_line_fk` carries
  the same `sale_line_id`, so the batch row and its line cannot name different sale lines.
- **No `variant_id`:** the sale line's batch row already has the variant, and its own foreign key checks it.

**`pos_return_refunds`:**

- **Like a sale's payments,** one row per tender, in the order the cashier gave them, with the account copied from the
  register (the exchange account for an exchange).
- **`pos_return_refunds_exchange_idx`** keeps one exchange per return (decision 11's rule, for the refund).
- **No refund is a valid return** of ৳0: 0056 checks that the refunds add up to the total, and the sum of no rows is 0.
- **`pos_return_refunds_account_idx`:** the account foreign key's check when an account is deleted, as for the sale
  payments.

### `schema/journal.ts`: the entry may point at a return

```diff
@@ -80,11 +80,11 @@ export const journalEntries = pgTable(
     // receipt's since 15c, a sales return's, a credit note's and a refund's since 15d, a goods
     // receipt's since 17b, a bill's and a supplier payment's since 17c, a purchase return's, a
     // debit note's and a supplier refund's since 17d, a POS sale's since 20a, a POS shift's since
-    // 20b) always points at its document, and no other entry does. The list is
+    // 20b, a POS return's since 20c) always points at its document, and no other entry does. The list is
     // contracts' DOCUMENT_JOURNAL_SOURCES.
     check(
       'journal_entries_document_check',
-      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift', 'pos_return')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
     ),
     // A document's entries (a transfer has up to two; an invoice or a receipt has one, which the
     // invoice page and the receipt page find here)
```

- **`pos_return` joins the sources whose entry points at a document** (decision 25). The check is the contract's
  `DOCUMENT_JOURNAL_SOURCES` written out. Without it, a return's entry would be refused for having a `document_id`.
- **The movement kind needs nothing here:** `stock_movements.kind` has no check in the database, only the TypeScript
  type from the contract's list.

### `schema/sync.ts`: the change log's warehouse is a sale's too

```diff
@@ -58,8 +58,9 @@ export const syncChanges = pgTable(
     // The contract's key: the row's id, priceListItemKey() or stockKey(); the settings' key is the
     // tenant id. The triggers build exactly those strings.
     entityKey: text('entity_key').notNull(),
-    // A stock row's warehouse, NULL for every other entity. A device keeps the stock of its
-    // branch only, so its pull skips the other branches' stock here, without reading the rows.
+    // A stock row's warehouse, and a POS sale's (step 20c); NULL for every other entity. A device
+    // keeps the stock and the POS sales of its branch only, so its pull skips the other branches'
+    // here, without reading the rows.
     warehouseId: uuid('warehouse_id'),
     // The transaction that wrote the change. The pull's cursor is a watermark on it (decision 25):
     // it reads only the transactions that finished before the oldest one still running.
```

- **Only the comment changes** (decision 42). The column and the pull's filter stay as they are: the pull already skips
  every change whose `warehouse_id` is outside the device's branch.

### `permission-catalog.ts`

```diff
@@ -60,6 +60,8 @@ const DESCRIPTIONS = {
   'pos.register.manage': 'Add, edit and archive POS registers and the pay in and pay out reasons',
   'pos.shift.manage':
     "See every register's shifts and cash differences, and close a stuck shift without a count",
+  'pos.return.create':
+    'Take goods back at a POS register and pay the money back, or use it for an exchange',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- **`pos.return.create` gets its description.** The `satisfies Record<PermissionKey, string>` has failed the db type
  check since 20c.1 until it was there. `pnpm db:migrate` writes the new permission (`syncPermissions()`).

### Migration 0055 (generated, then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name pos-returns`. As in every step, `drizzle-kit` writes the foreign keys
before the unique indexes they point at (`pos_returns_tenant_id_idx`, `pos_return_lines_batch_key_idx`), and the
migration fails with "there is no unique constraint matching given keys". Move every `CREATE INDEX` and
`CREATE UNIQUE INDEX` up, before the first `ADD CONSTRAINT … FOREIGN KEY`. The result:

```sql
CREATE TABLE "pos_return_line_batches" (
	"tenant_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	CONSTRAINT "pos_return_line_batches_pkey" PRIMARY KEY("tenant_id","line_id","batch_id"),
	CONSTRAINT "pos_return_line_batches_quantity_check" CHECK ("pos_return_line_batches"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"value" numeric(19, 4) NOT NULL,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "pos_return_lines_quantity_check" CHECK ("pos_return_lines"."quantity" > 0 AND "pos_return_lines"."base_quantity" > 0),
	CONSTRAINT "pos_return_lines_amounts_check" CHECK ("pos_return_lines"."net" >= 0 AND "pos_return_lines"."vat" >= 0 AND "pos_return_lines"."total" = "pos_return_lines"."net" + "pos_return_lines"."vat" AND "pos_return_lines"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos_return_refunds" (
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reference" text,
	"account_id" uuid NOT NULL,
	CONSTRAINT "pos_return_refunds_pkey" PRIMARY KEY("tenant_id","return_id","line_no"),
	CONSTRAINT "pos_return_refunds_method_check" CHECK ("pos_return_refunds"."method" IN ('cash', 'card', 'bkash', 'nagad', 'exchange')),
	CONSTRAINT "pos_return_refunds_amount_check" CHECK ("pos_return_refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"returned_at" timestamp with time zone NOT NULL,
	"sale_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"note" text,
	"outside_window" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pos_returns_sequence_check" CHECK ("pos_returns"."sequence" >= 1),
	CONSTRAINT "pos_returns_totals_check" CHECK ("pos_returns"."net" >= 0 AND "pos_returns"."vat" >= 0 AND "pos_returns"."total" = "pos_returns"."net" + "pos_returns"."vat")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "pos_registers" DROP CONSTRAINT "pos_registers_last_number_check";--> statement-breakpoint
ALTER TABLE "pos_sale_payments" DROP CONSTRAINT "pos_sale_payments_method_check";--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "exchange_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "return_days" smallint DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "last_return_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD COLUMN "return_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_lines_line_idx" ON "pos_return_lines" USING btree ("tenant_id","return_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_lines_sale_line_idx" ON "pos_return_lines" USING btree ("tenant_id","return_id","sale_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_lines_batch_key_idx" ON "pos_return_lines" USING btree ("tenant_id","id","sale_line_id");--> statement-breakpoint
CREATE INDEX "pos_return_lines_returned_idx" ON "pos_return_lines" USING btree ("tenant_id","sale_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_refunds_exchange_idx" ON "pos_return_refunds" USING btree ("tenant_id","return_id") WHERE "pos_return_refunds"."method" = 'exchange';--> statement-breakpoint
CREATE INDEX "pos_return_refunds_account_idx" ON "pos_return_refunds" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_returns_tenant_id_idx" ON "pos_returns" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_returns_tenant_number_idx" ON "pos_returns" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_returns_register_sequence_idx" ON "pos_returns" USING btree ("tenant_id","register_id","sequence");--> statement-breakpoint
CREATE INDEX "pos_returns_tenant_date_idx" ON "pos_returns" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_returns_register_idx" ON "pos_returns" USING btree ("tenant_id","register_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_returns_sale_idx" ON "pos_returns" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "pos_returns_shift_idx" ON "pos_returns" USING btree ("tenant_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_payments_return_idx" ON "pos_sale_payments" USING btree ("tenant_id","return_id") WHERE "pos_sale_payments"."return_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_return_line_batches" ADD CONSTRAINT "pos_return_line_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_line_batches" ADD CONSTRAINT "pos_return_line_batches_line_fk" FOREIGN KEY ("tenant_id","line_id","sale_line_id") REFERENCES "public"."pos_return_lines"("tenant_id","id","sale_line_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_line_batches" ADD CONSTRAINT "pos_return_line_batches_sale_batch_fk" FOREIGN KEY ("tenant_id","sale_line_id","batch_id") REFERENCES "public"."pos_sale_line_batches"("tenant_id","line_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."pos_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_sale_line_fk" FOREIGN KEY ("tenant_id","variant_id","sale_line_id") REFERENCES "public"."pos_sale_lines"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_refunds" ADD CONSTRAINT "pos_return_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_refunds" ADD CONSTRAINT "pos_return_refunds_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."pos_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_refunds" ADD CONSTRAINT "pos_return_refunds_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."pos_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_shift_fk" FOREIGN KEY ("tenant_id","shift_id","register_id","device_id") REFERENCES "public"."pos_shifts"("tenant_id","id","register_id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."pos_sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_exchange_account_fk" FOREIGN KEY ("tenant_id","exchange_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."pos_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift', 'pos_return')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_return_days_check" CHECK ("pos_registers"."return_days" BETWEEN 0 AND 365);--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_last_number_check" CHECK ("pos_registers"."last_number" >= 0 AND "pos_registers"."last_return_number" >= 0);--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_method_check" CHECK ("pos_sale_payments"."method" IN ('cash', 'card', 'bkash', 'nagad', 'exchange') AND ("pos_sale_payments"."method" = 'exchange') = ("pos_sale_payments"."return_id" IS NOT NULL));
```

- **Four new tables:** creating them takes no time and locks nothing that exists.
- **The three register columns have constant defaults** (or none), so adding them is quick: Postgres stores a constant
  default once instead of writing every row.
- **The two checks on existing tables are dropped and added again.** Adding `pos_registers_last_number_check` reads the
  few registers. Adding `pos_sale_payments_method_check` reads every sale payment once, and blocks writes to the table
  while it does; a shop's POS payments since step 20a are not many, so it takes moments. Run the migration outside shop
  hours anyway.
- **`pos_sale_payments_return_idx` is built on a table with rows,** but it is partial and no row has a `return_id` yet,
  so it is empty and quick.
- **The journal check is dropped and added again,** like in 20a and 20b: it reads every journal entry once.
- `meta/_journal.json`, `meta/0055_snapshot.json` and `meta/0056_snapshot.json` change too. They are generated; commit
  them as they are.

### Migration 0056 (custom): the rules

Run `pnpm --filter @omnivo/db generate --custom --name pos-returns-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_returns', 'pos_return_lines', 'pos_return_line_batches', 'pos_return_refunds'
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

-- 2) A register's last return number only grows, like its last number: a device that claims the
--    register numbers its returns on from it (decision 5). The rest is 0054's guard as it was.
CREATE OR REPLACE FUNCTION pos_registers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active boolean;
  v_device_branch uuid;
  v_register_branch uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code <> OLD.code THEN
      RAISE EXCEPTION 'the code of POS register % cannot be changed', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_code_locked';
    END IF;
    IF NEW.last_number < OLD.last_number THEN
      RAISE EXCEPTION 'the last number of POS register % cannot go down from % to %',
          OLD.id, OLD.last_number, NEW.last_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_last_number_grows';
    END IF;
    IF NEW.last_return_number < OLD.last_return_number THEN
      RAISE EXCEPTION 'the last return number of POS register % cannot go down from % to %',
          OLD.id, OLD.last_return_number, NEW.last_return_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_last_number_grows';
    END IF;
    IF NEW.device_id IS DISTINCT FROM OLD.device_id AND EXISTS (
      SELECT 1 FROM pos_shifts s
       WHERE s.tenant_id = OLD.tenant_id AND s.register_id = OLD.id AND s.status = 'open'
    ) THEN
      RAISE EXCEPTION 'POS register % has an open shift, so its device keeps it', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_shift_open';
    END IF;
  END IF;

  IF NEW.device_id IS NOT NULL AND (
       TG_OP = 'INSERT'
       OR NEW.device_id IS DISTINCT FROM OLD.device_id
       OR NEW.warehouse_id <> OLD.warehouse_id) THEN
    SELECT d.revoked_at IS NULL, d.branch_id INTO v_active, v_device_branch
      FROM devices d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.device_id
       FOR SHARE;
    SELECT w.branch_id INTO v_register_branch
      FROM warehouses w WHERE w.tenant_id = NEW.tenant_id AND w.id = NEW.warehouse_id
       FOR SHARE;
    -- Nothing found: no such device or warehouse, which the foreign keys report
    IF v_active IS NOT NULL AND v_register_branch IS NOT NULL
       AND (NOT v_active OR v_device_branch <> v_register_branch) THEN
      RAISE EXCEPTION 'device % cannot hold POS register %: it is revoked or in another branch',
          NEW.device_id, NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_holder_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 3) The device does not keep the last return number either (syncPosRegisterSchema), so a return
--    that moves it does not send the register's row again. The rest is 0052's function as it was.
CREATE OR REPLACE FUNCTION sync_log_pos_registers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT n.tenant_id, 'pos_register', n.id::text
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
   WHERE to_jsonb(n) - ARRAY['last_number', 'last_return_number', 'updated_at']
         IS DISTINCT FROM to_jsonb(o) - ARRAY['last_number', 'last_return_number', 'updated_at'];
  RETURN NULL;
END $$;

-- 4) A return moves its register's last return number up to its own, in the same transaction,
--    like a sale moves the last number (0052)
CREATE FUNCTION pos_returns_last_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pos_registers
     SET last_return_number = NEW.sequence
   WHERE tenant_id = NEW.tenant_id AND id = NEW.register_id AND last_return_number < NEW.sequence;
  RETURN NULL;
END $$;

CREATE TRIGGER pos_returns_last_number
  AFTER INSERT ON pos_returns
  FOR EACH ROW EXECUTE FUNCTION pos_returns_last_number();

-- 5) A POS return is posted the moment it is written, and never changes: no line, batch or refund
--    is changed or removed. It is final, like a sale; a mistake is put right by a new sale.
CREATE FUNCTION pos_returns_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a POS return cannot be changed or deleted; a new sale puts a mistake right'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_returns_immutable';
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_returns', 'pos_return_lines', 'pos_return_line_batches', 'pos_return_refunds'
    ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION pos_returns_immutable()',
      t || '_immutable', t
    );
  END LOOP;
END $$;

-- 6) A return adds up, checked at COMMIT like a sale (0052): by then every line, batch and refund is
--    in place. Its totals are the sums of its lines; every line is a line of its own sale, and a
--    serial number that came back is one the sale line sold; the refunds add up to the total (a
--    return gives no change; one of ৳0 has none); and a line of a sale line that left from batches
--    went back into batches that add up to its quantity. More than is left to return is NOT
--    checked here: the server takes it and writes the audit log (decision 20).
CREATE FUNCTION pos_return_check(p_tenant uuid, p_return uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r pos_returns%ROWTYPE;
  v_lines integer;
  v_net numeric;
  v_vat numeric;
  v_total numeric;
  v_refunded numeric;
BEGIN
  SELECT * INTO r FROM pos_returns WHERE tenant_id = p_tenant AND id = p_return;

  SELECT count(*), coalesce(sum(net), 0), coalesce(sum(vat), 0), coalesce(sum(total), 0)
    INTO v_lines, v_net, v_vat, v_total
    FROM pos_return_lines WHERE tenant_id = p_tenant AND return_id = p_return;
  IF v_lines = 0 OR v_net <> r.net OR v_vat <> r.vat OR v_total <> r.total THEN
    RAISE EXCEPTION 'POS return % does not add up: % lines, net %, VAT %, total %',
        p_return, v_lines, v_net, v_vat, v_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_returns_lines_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_return_lines l
      JOIN pos_sale_lines sl ON sl.tenant_id = l.tenant_id AND sl.id = l.sale_line_id
     WHERE l.tenant_id = p_tenant AND l.return_id = p_return
       AND (sl.sale_id <> r.sale_id OR NOT l.serial_numbers <@ sl.serial_numbers)
  ) THEN
    RAISE EXCEPTION 'a line of POS return % is not a line of sale %, or brings back a serial it did not sell',
        p_return, r.sale_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_return_lines_sale_match';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_refunded
    FROM pos_return_refunds WHERE tenant_id = p_tenant AND return_id = p_return;
  IF v_refunded <> r.total THEN
    RAISE EXCEPTION 'the refunds of POS return % add up to %, not its total %',
        p_return, v_refunded, r.total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_returns_refunds_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_return_lines l
     WHERE l.tenant_id = p_tenant AND l.return_id = p_return
       AND EXISTS (SELECT 1 FROM pos_sale_line_batches sb
                    WHERE sb.tenant_id = l.tenant_id AND sb.line_id = l.sale_line_id)
       AND l.base_quantity <> (SELECT coalesce(sum(b.quantity), 0)
                                 FROM pos_return_line_batches b
                                WHERE b.tenant_id = l.tenant_id AND b.line_id = l.id)
  ) THEN
    RAISE EXCEPTION 'the batches of a line of POS return % do not add up to its quantity', p_return
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_return_line_batches_match';
  END IF;
END $$;

-- The return each kind of row belongs to. IF, not CASE, for the reason in 0052.
CREATE FUNCTION pos_returns_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_return uuid;
BEGIN
  IF TG_TABLE_NAME = 'pos_returns' THEN
    v_return := NEW.id;
  ELSIF TG_TABLE_NAME = 'pos_return_line_batches' THEN
    SELECT l.return_id INTO v_return
      FROM pos_return_lines l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.line_id;
  ELSE
    v_return := NEW.return_id;
  END IF;
  PERFORM pos_return_check(NEW.tenant_id, v_return);
  RETURN NULL;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_returns', 'pos_return_lines', 'pos_return_line_batches', 'pos_return_refunds'
    ])
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION pos_returns_complete()',
      t || '_complete', t
    );
  END LOOP;
END $$;

-- 7) A sale's exchange payment uses its return's exchange refund exactly (decision 7): the same
--    amount, and a return of the same shift (so of the same register and device: the return was
--    saved with the sale). The unique index on return_id keeps a second sale from using it. The
--    rest is 0052's check as it was.
CREATE OR REPLACE FUNCTION pos_sale_check(p_tenant uuid, p_sale uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s pos_sales%ROWTYPE;
  v_lines integer;
  v_net numeric;
  v_vat numeric;
  v_total numeric;
  v_bill numeric;
  v_payments integer;
  v_paid numeric;
  v_not_cash numeric;
BEGIN
  SELECT * INTO s FROM pos_sales WHERE tenant_id = p_tenant AND id = p_sale;

  SELECT count(*), coalesce(sum(net), 0), coalesce(sum(vat), 0), coalesce(sum(total), 0),
         coalesce(sum(bill_discount), 0)
    INTO v_lines, v_net, v_vat, v_total, v_bill
    FROM pos_sale_lines WHERE tenant_id = p_tenant AND sale_id = p_sale;
  IF v_lines = 0 OR v_net <> s.net OR v_vat <> s.vat OR v_total <> s.total
     OR v_bill <> s.bill_discount_amount THEN
    RAISE EXCEPTION 'POS sale % does not add up: % lines, net %, VAT %, total %, bill discount %',
        p_sale, v_lines, v_net, v_vat, v_total, v_bill
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sales_lines_match';
  END IF;

  SELECT count(*), coalesce(sum(amount), 0),
         coalesce(sum(amount) FILTER (WHERE method <> 'cash'), 0)
    INTO v_payments, v_paid, v_not_cash
    FROM pos_sale_payments WHERE tenant_id = p_tenant AND sale_id = p_sale;
  IF v_payments = 0 OR v_paid <> s.paid OR v_not_cash > s.total THEN
    RAISE EXCEPTION 'the payments of POS sale % do not match: % payments, paid %, not in cash %',
        p_sale, v_payments, v_paid, v_not_cash
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sales_payments_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_sale_payments p
      LEFT JOIN pos_returns r ON r.tenant_id = p.tenant_id AND r.id = p.return_id
      LEFT JOIN pos_return_refunds f
        ON f.tenant_id = p.tenant_id AND f.return_id = p.return_id AND f.method = 'exchange'
     WHERE p.tenant_id = p_tenant AND p.sale_id = p_sale AND p.method = 'exchange'
       AND (r.shift_id IS DISTINCT FROM s.shift_id OR f.amount IS DISTINCT FROM p.amount)
  ) THEN
    RAISE EXCEPTION 'the exchange payment of POS sale % does not match its return''s exchange', p_sale
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sale_payments_exchange_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_sale_lines l
      JOIN pos_sale_line_batches b ON b.tenant_id = l.tenant_id AND b.line_id = l.id
     WHERE l.tenant_id = p_tenant AND l.sale_id = p_sale
     GROUP BY l.id, l.base_quantity
    HAVING sum(b.quantity) <> l.base_quantity
  ) THEN
    RAISE EXCEPTION 'the batches of a line of POS sale % do not add up to its quantity', p_sale
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sale_line_batches_match';
  END IF;
END $$;

-- 8) The cash of a shift, with the cash its returns paid back (decision 26): the drawer should
--    hold that much less. An exchange's money never leaves the drawer, so only the cash refunds
--    count. The return type grows by a column, which CREATE OR REPLACE cannot do, so the function
--    is dropped and made again; 0054's revoke and the API call it by name and read the columns by
--    name. The rest is 0054's function as it was.
DROP FUNCTION pos_shift_cash(uuid, uuid);

CREATE FUNCTION pos_shift_cash(p_tenant uuid, p_shift uuid)
RETURNS TABLE (
  opening numeric,
  cash_taken numeric,
  change_given numeric,
  paid_in numeric,
  paid_out numeric,
  cash_refunded numeric,
  expected numeric
)
LANGUAGE sql STABLE AS $$
  WITH sales AS (
    SELECT coalesce(sum(x.paid - x.total), 0) AS change_given,
           coalesce(sum((SELECT sum(p.amount)
                           FROM pos_sale_payments p
                          WHERE p.tenant_id = x.tenant_id AND p.sale_id = x.id
                            AND p.method = 'cash')), 0) AS cash_taken
      FROM pos_sales x
     WHERE x.tenant_id = p_tenant AND x.shift_id = p_shift
  ), moves AS (
    SELECT coalesce(sum(m.amount) FILTER (WHERE m.direction = 'in'), 0) AS paid_in,
           coalesce(sum(m.amount) FILTER (WHERE m.direction = 'out'), 0) AS paid_out
      FROM pos_cash_movements m
     WHERE m.tenant_id = p_tenant AND m.shift_id = p_shift
  ), refunds AS (
    SELECT coalesce(sum(f.amount), 0) AS cash_refunded
      FROM pos_returns r
      JOIN pos_return_refunds f ON f.tenant_id = r.tenant_id AND f.return_id = r.id
     WHERE r.tenant_id = p_tenant AND r.shift_id = p_shift AND f.method = 'cash'
  )
  SELECT s.opening_cash, sales.cash_taken, sales.change_given, moves.paid_in, moves.paid_out,
         refunds.cash_refunded,
         s.opening_cash + sales.cash_taken + moves.paid_in
           - sales.change_given - moves.paid_out - refunds.cash_refunded
    FROM pos_shifts s, sales, moves, refunds
   WHERE s.tenant_id = p_tenant AND s.id = p_shift
$$;

-- 9) The devices keep the recent sales of the register they hold (pos_sale, step 18a's change log,
--    decision 21), with what was returned of each line. A sale logs itself when it is written; a
--    return logs its sale, because the sale's row now has less to return. Both are logged with the
--    SALE's warehouse, so only the devices of the sale's branch hear about it (the pull skips the
--    other branches' here), even when a counter of another branch took the goods back. Which
--    device of the branch keeps the row is the API's loader's business. Neither is ever changed or
--    deleted, so there is nothing else to log; a sale that turns 31 days old leaves the device by
--    the device's own clean-up.
CREATE TRIGGER pos_sales_sync_insert
  AFTER INSERT ON pos_sales
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log('pos_sale', 'r.id::text', 'true', 'r.warehouse_id');

CREATE FUNCTION sync_log_pos_returns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key, warehouse_id)
  SELECT DISTINCT s.tenant_id, 'pos_sale', s.id::text, s.warehouse_id
    FROM new_rows n
    JOIN pos_sales s ON s.tenant_id = n.tenant_id AND s.id = n.sale_id;
  RETURN NULL;
END $$;

CREATE TRIGGER pos_returns_sync_insert
  AFTER INSERT ON pos_returns
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_pos_returns();
```

- **Section 1** is the loop of every step: row-level security on, forced, and the `tenant_isolation` policy on the four
  tables. The RLS coverage test fails for any tenant table without it.
- **Section 2, the register's guard,** 0054's function with one more rule (decision 43): the last return number only
  grows. It raises the same constraint name as the last number: the rule is the same, and only a bug could break
  either, so one name is enough to find it in the logs. `CREATE OR REPLACE` keeps 0052's trigger, which calls the
  function by name.
- **Section 3, the register's change log,** 0052's function with `last_return_number` in the keys it ignores. Without it,
  every return would send the register's row to every device of the branch for nothing: the device does not keep the
  number (`syncPosRegisterSchema`).
- **Section 4** moves the register's last return number up to the return's own, in the same transaction, like a sale's
  (0052 section 7). The `last_return_number < NEW.sequence` condition means a return that arrives late (an older number)
  changes nothing, and the guard never sees a number go down.
- **Section 5:** a return, its lines, batches and refunds refuse every change and every delete (decision 1 of 20a,
  carried over: a posted document never changes). It has its own function, because 0052's message says "a POS sale".
- **Section 6, `pos_return_check()`** (decisions 36, 37 and 39), run at commit like 0052's check of a sale, by a
  constraint trigger on each of the four tables. At commit every row is in place, whatever order the API wrote them in.
  - The lines add up to the header, and there is at least one (a return of nothing is a bug).
  - Every line's sale line is a line of the return's sale, and its serial numbers are among the sale line's
    (`<@`, "is contained in"). A join, so one query checks every line.
  - The refunds add up to the total exactly: a return gives no change, and one of ৳0 has none.
  - A line whose sale line left from batches went back into batches that add up to its base quantity. This is stronger
    than the sale's check: a batch product's line with no batch rows at all fails too, because the sale line's batch rows
    say it is a batch line.
  - "No more than is left" and the window are not checked (decision 20): the API takes both and writes the audit log.
- **Section 7, `pos_sale_check()`,** 0052's function with the exchange rule (decision 38). An exchange payment's return
  must be of the same shift as the sale, and its exchange refund must be exactly the payment. `LEFT JOIN`s and
  `IS DISTINCT FROM`, so a return with no exchange refund (a `NULL` amount) fails too, instead of passing as "unknown".
  A sale without a shift (from 20a) has a `NULL` shift, which never matches, so an old sale cannot use an exchange
  either. It runs at the sale's commit, when the return (pushed first) is already in.
- **Section 8, `pos_shift_cash()`** (decisions 26 and 41), 0054's function with a fourth part: the cash the shift's
  returns paid back. Only `cash` refunds: an exchange never leaves the drawer, and a card or bKash refund never was in
  it. The refunds are summed in their own sub-query, so a return with two refunds is not counted twice. 0054's revoke
  (which closes a shift and stores its expected cash) calls the function by name inside PL/pgSQL, so dropping and making
  it again needs no change there.
- **Section 9, the change log of `pos_sale`** (decisions 21 and 42). A sale logs itself with step 18a's `sync_log()`; the
  fourth argument is the warehouse the change belongs to, which only stock used until now. A return logs its sale with
  its own function, because the warehouse is the sale's, which is not on the return's row. `DISTINCT` sends a sale once
  when one statement writes many returns of it. Nothing else is logged: a sale and a return never change, and a sale
  older than 30 days leaves the device by the device's own clean-up (decision 21).

> **What we checked.** On a throwaway Postgres with every migration up to 0056, as `omnivo_app`, in one transaction
> that rolls back (73 checks). The new permission had its text. A register from 20b got 7 return days, no exchange
> account and last return number 0; 366 days, −1 days, a last return number below zero and another workspace's account
> were refused; new return settings were logged for the devices, a new last return number was not, and it could not go
> down.
>
> The journal took a `pos_return` entry with its document and refused one without. POS1-R000001 brought back a shirt,
> 3 Napa (into LOT-B) and phone SN-001 of Thursday's POS1-000164, with ৳766 in cash and ৳11,500 to the card: it moved
> POS1's last return number to 1 without logging the register, and logged the sale in its warehouse. Each of these was
> refused by its own rule: lines that do not add up, no lines, a line of another sale, a serial the line did not sell,
> a variant that is not the sale line's, a sale line twice, a quantity of 0, a line or a header whose total is not net +
> VAT, a cost below zero, sequence 0, a taken sequence, a taken number, a shift of another register, a device that is
> not the shift's, an unknown sale; a batch line without batches, batches that do not add up, a batch the line did not
> leave from, a batch row of another sale line, a batch quantity of 0; refunds that do not add up, a return with money
> and no refund, two exchanges, a method that is not a tender, an amount of 0, another workspace's account, a refund
> number used twice. A return, a line, a batch row and a refund could not be changed or deleted.
>
> Two more shirts of a line of two that had one back went in (3 of 2, decision 20), and a free sample came back for
> ৳0 with no refund. GEC1-000041's shirt (another branch's sale) came back at POS1 as an exchange of ৳736, logged in the
> GEC warehouse only. A sale paid by an exchange without a return, a card naming a return, an exchange of ৳700 for a
> refund of ৳736, a return with no exchange refund and an unknown return were refused; POS1-000165 then paid ৳736 by the
> exchange and ৳114 in cash and was logged, and a second sale with the same return was refused. A return at POS2 could
> not pay for a sale at POS1 (another shift). POS1's shift cash was 5,000 + 1,714 taken − 28 change − 2,238 refunded in
> cash = 4,448. A return arriving after a manager closed POS2's shift still went in, and counted in that shift's cash
> refunded. Revoking the GEC counter's PC closed its shift with the new function's expected cash (1,000 + 736). The other
> workspace saw no return, line, batch or refund, could not read a shift's cash and could not add a refund.
>
> No race test this time: the only thing two sessions can fight over is the register's row (the last return number,
> the same row lock as a sale's) and the unique indexes (a number, a sale line in a return, a return used by two
> sales), where Postgres makes the second one wait and then fail. Two returns of the same line at two counters both go
> in, on purpose (decision 20).
>
> The API's RLS coverage, stock (26) and valuation (18) suites pass with 0055 and 0056. The POS suites fail where they
> make a register without the new fields, and the device and POS suites fail where they pull (no `pos_sale` loader):
> both until 20c.3 and 20c.4.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
pnpm --filter @omnivo/db build
```

`pnpm db:migrate` applies 0055 and 0056 to your dev database and writes the new permission. The build lets the API see
the new tables in 20c.3. Do not run the whole `pnpm typecheck` yet: the API, i18n, sync and app packages still fail as
listed at the end of 20c.1, until their parts.

## 20c.3 — `apps/api`: the return posted, the exchange, the sale by number

The API gets one new service, `PosReturnsService`, with its controller. It posts a return from the push, and answers
the four return routes: the sale by its receipt number, the register's recent sales, and the managers' list and page.
A small shared file builds the sale a return reads, for those routes and for the pull. Around them: the register's two
new fields, the sale's exchange payment and its returns, the shift's refunds, the pull's `pos_sale` rows, the push's
new command, the return's journal entry, the account guard and the retail template.

### `pos/pos-registers.service.ts`: the exchange account and the return days

```diff
@@ -9,6 +9,7 @@ import {
   type PosRegisterInput,
   type PosRegisterListItem,
   type PosRegisterStatus,
+  type PosTender,
   type SyncPosRegister,
   type UpdatePosRegisterInput,
 } from '@omnivo/contracts';
@@ -33,9 +34,10 @@ const ACCOUNT_COLUMN = {
   nagad: 'nagadAccountId',
 } as const satisfies Record<PosPaymentMethod, keyof PosRegisterRow>;
 
-// The register's account for a method; null = it does not take that method (cash always has one)
-export function accountOf(row: PosRegisterRow, method: PosPaymentMethod): string | null {
-  return row[ACCOUNT_COLUMN[method]];
+// The register's account for a tender; null = it does not take that method (cash always has one).
+// Step 20c: an exchange goes through the register's exchange account; null = no exchanges here.
+export function accountOf(row: PosRegisterRow, tender: PosTender): string | null {
+  return tender === 'exchange' ? row.exchangeAccountId : row[ACCOUNT_COLUMN[tender]];
 }
 
 // A register as the devices keep it (decision 20): without the last number, which changes with
@@ -64,6 +66,8 @@ export function toSyncPosRegister(
     overShortAccountId: row.overShortAccountId,
     varianceAlert: row.varianceAlert,
     lockAfter: row.lockAfter,
+    exchangeAccountId: row.exchangeAccountId,
+    returnDays: row.returnDays,
     deviceId: row.deviceId,
     lastShift,
     archivedAt: row.archivedAt?.toISOString() ?? null,
@@ -77,7 +81,11 @@ export function toPosRegister(
   branchId: string,
   lastShift: PosLastShift | null,
 ): PosRegister {
-  return { ...toSyncPosRegister(row, branchId, lastShift), lastNumber: row.lastNumber };
+  return {
+    ...toSyncPosRegister(row, branchId, lastShift),
+    lastNumber: row.lastNumber,
+    lastReturnNumber: row.lastReturnNumber,
+  };
 }
 
 // Step 20b (decision 36): each register's latest shift, by the highest sequence, read and not
@@ -243,6 +251,7 @@ export class PosRegistersService {
         const warehouse = await this.activeWarehouse(tx, input.warehouseId);
         await this.checkAccounts(tx, input.accounts);
         await this.checkOverShort(tx, input.overShortAccountId);
+        await this.checkExchange(tx, input.exchangeAccountId);
         const [row] = await tx
           .insert(posRegisters)
           .values({
@@ -294,6 +303,7 @@ export class PosRegistersService {
         }
         await this.checkAccounts(tx, input.accounts);
         await this.checkOverShort(tx, input.overShortAccountId);
+        await this.checkExchange(tx, input.exchangeAccountId);
         const [after] = await tx
           .update(posRegisters)
           .set({
@@ -608,11 +618,43 @@ export class PosRegistersService {
     }
   }
 
+  // Step 20c: an exchange passes through a liability account, like any money a shop holds for a
+  // customer for a moment: the return puts it there and the sale made with it takes it off, so it
+  // comes back to zero. An active one that is not a group; FOR SHARE like the others. null = this
+  // counter makes no exchanges.
+  private async checkExchange(tx: Transaction, id: string | null): Promise<void> {
+    if (id === null) return;
+    const [account] = await tx
+      .select({
+        type: ledgerAccounts.type,
+        isGroup: ledgerAccounts.isGroup,
+        archivedAt: ledgerAccounts.archivedAt,
+      })
+      .from(ledgerAccounts)
+      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)))
+      .for('share');
+    if (
+      !account ||
+      account.isGroup ||
+      account.archivedAt !== null ||
+      account.type !== 'liability'
+    ) {
+      throw fieldError(
+        'pos_exchange_account_invalid',
+        'exchangeAccountId',
+        'Pick an active liability account, such as "POS exchange clearing".',
+      );
+    }
+  }
+
   private shiftColumns(input: PosRegisterInput | UpdatePosRegisterInput) {
     return {
       overShortAccountId: input.overShortAccountId,
       varianceAlert: input.varianceAlert,
       lockAfter: input.lockAfter,
+      // Step 20c: the return settings live in the same part of the form
+      exchangeAccountId: input.exchangeAccountId,
+      returnDays: input.returnDays,
     };
   }
 
@@ -632,6 +674,7 @@ export class PosRegistersService {
         return id === null ? [] : [id];
       }),
       ...(row.overShortAccountId === null ? [] : [row.overShortAccountId]),
+      ...(row.exchangeAccountId === null ? [] : [row.exchangeAccountId]),
     ];
     const codes = new Map(
       (
@@ -663,6 +706,9 @@ export class PosRegistersService {
         row.overShortAccountId === null ? null : (codes.get(row.overShortAccountId) ?? null),
       varianceAlert: row.varianceAlert,
       lockAfter: row.lockAfter,
+      exchangeAccount:
+        row.exchangeAccountId === null ? null : (codes.get(row.exchangeAccountId) ?? null),
+      returnDays: String(row.returnDays),
     };
   }
 }
```

- **`accountOf()` takes any tender** (decision 10). `exchange` reads the register's exchange account; the four methods
  read their own columns as before. The return's refunds and the shift's page both call it with a tender, so the rule
  lives in one place.
- **The device's row and the API's register get `exchangeAccountId` and `returnDays`;** only the API's gets
  `lastReturnNumber` (decision 12). The device numbers its returns on from the claim's answer, like its sales.
- **`checkExchange()` wants an active liability account that is not a group** (`pos_exchange_account_invalid` under
  `exchangeAccountId`). An exchange is money the shop holds for a customer for a moment, between the return and the
  sale. An asset or an income account would make the clearing look like cash or like a sale. `null` (the form's
  empty select) skips the check: that counter makes no exchanges. `FOR SHARE` keeps the account from being archived
  until we commit, like the other accounts of the form.
- **`shiftColumns()` carries the two new fields,** so `create()` and `update()` both write them without new code in
  either.
- **The audit snapshot names the exchange account by its code** and the days as text, like the other fields: a reader
  of the log sees "2190" and "7".

### `pos/pos-returnable.ts` (new): the sale a return reads

```ts
import {
  POS_SALES_ON_DEVICE_DAYS,
  type PosReturnableSale,
  shiftIsoDate,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';
import type { posSales } from '@omnivo/db';
import { posReturnLines, posSaleLines, posSalePayments, tenantSettings } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { customerRefs, toSalesLine, withVariants } from '../sales/sales-lines.js';

type SaleRow = typeof posSales.$inferSelect;

// The first day of the sales a device keeps (decision 21): POS_SALES_ON_DEVICE_DAYS before the
// workspace's today. The device drops older rows by its own clock; a day either way at the edge
// only means a row kept a day longer or sent a day less.
export async function posSalesFrom(tx: Transaction): Promise<string> {
  const tenantId = getTenantId();
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  return shiftIsoDate(todayIn(settings.timezone), -POS_SALES_ON_DEVICE_DAYS);
}

// What the posted returns brought back of each sale line so far: the quantity in the line's unit,
// and the serial numbers, in the order they came back
export interface Returned {
  quantity: string;
  serialNumbers: string[];
}

const NOTHING_RETURNED: Returned = { quantity: '0.0000', serialNumbers: [] };

// Summed in TypeScript, not with SQL's sum(): a line has a handful of returns at most, and the
// quantity comes back in the 4 decimals every quantity of the API has. pos_return_lines_returned_idx
// finds the rows by sale line.
export async function returnedOf(
  tx: Transaction,
  saleLineIds: readonly string[],
): Promise<Map<string, Returned>> {
  if (saleLineIds.length === 0) return new Map();
  const rows = await tx
    .select({
      saleLineId: posReturnLines.saleLineId,
      quantity: posReturnLines.quantity,
      serialNumbers: posReturnLines.serialNumbers,
    })
    .from(posReturnLines)
    .where(
      and(
        eq(posReturnLines.tenantId, getTenantId()),
        inArray(posReturnLines.saleLineId, [...saleLineIds]),
      ),
    )
    .orderBy(asc(posReturnLines.id));
  const returned = new Map<string, Returned>();
  for (const row of rows) {
    const before = returned.get(row.saleLineId) ?? NOTHING_RETURNED;
    returned.set(row.saleLineId, {
      quantity: sumQuantity([before.quantity, row.quantity]),
      serialNumbers: [...before.serialNumbers, ...row.serialNumbers],
    });
  }
  return returned;
}

export function returnedFor(returned: Map<string, Returned>, saleLineId: string): Returned {
  return returned.get(saleLineId) ?? NOTHING_RETURNED;
}

// The sales a return reads (decision 22): the route's answer by receipt number, the register's
// recent sales and the device's pos_sale rows are all this one shape, so the return screen reads
// any of them the same way. In the order of `sales`; the caller picked and sorted them.
export async function returnableSalesOf(
  tx: Transaction,
  sales: readonly SaleRow[],
): Promise<PosReturnableSale[]> {
  if (sales.length === 0) return [];
  const tenantId = getTenantId();
  const saleIds = sales.map((sale) => sale.id);
  const lineRows = await tx
    .select()
    .from(posSaleLines)
    .where(and(eq(posSaleLines.tenantId, tenantId), inArray(posSaleLines.saleId, saleIds)))
    .orderBy(asc(posSaleLines.saleId), asc(posSaleLines.lineNo));
  const lines = await withVariants(tx, lineRows);
  const returned = await returnedOf(
    tx,
    lineRows.map((row) => row.id),
  );
  const payments = await tx
    .select({
      saleId: posSalePayments.saleId,
      method: posSalePayments.method,
      amount: posSalePayments.amount,
    })
    .from(posSalePayments)
    .where(and(eq(posSalePayments.tenantId, tenantId), inArray(posSalePayments.saleId, saleIds)))
    .orderBy(asc(posSalePayments.saleId), asc(posSalePayments.lineNo));
  const customers = await customerRefs(
    tx,
    sales.flatMap((sale) => (sale.customerId === null ? [] : [sale.customerId])),
  );

  return sales.map((sale) => ({
    id: sale.id,
    number: sale.number,
    registerId: sale.registerId,
    date: sale.date,
    soldAt: sale.soldAt.toISOString(),
    customer: sale.customerId === null ? null : (customers.get(sale.customerId) ?? null),
    pricesIncludeVat: sale.pricesIncludeVat,
    total: sale.total,
    lines: lines
      .filter(({ row }) => row.saleId === sale.id)
      .map(({ row, variant }) => {
        const line = toSalesLine(row, variant);
        const back = returnedFor(returned, row.id);
        return {
          variantId: line.variantId,
          productId: line.productId,
          productCode: line.productCode,
          productName: line.productName,
          optionValues: line.optionValues,
          sku: line.sku,
          baseUnitId: line.baseUnitId,
          id: row.id,
          tracking: variant.tracking,
          unitId: row.unitId,
          quantity: row.quantity,
          baseQuantity: row.baseQuantity,
          description: row.description,
          unitPrice: row.unitPrice,
          taxRate: line.taxRate,
          net: row.net,
          vat: row.vat,
          total: row.total,
          serialNumbers: row.serialNumbers,
          returnedSerialNumbers: back.serialNumbers,
          returnedQuantity: back.quantity,
        };
      }),
    payments: payments
      .filter((payment) => payment.saleId === sale.id)
      .map((payment) => ({ method: payment.method, amount: payment.amount })),
  }));
}
```

- **`posSalesFrom()` is 30 days before the workspace's today** (decision 46), in its time zone (`todayIn()`), like the
  booking day. The device drops older rows by its own clock; a day either way only keeps a row a day longer.
- **`returnedOf()` sums in TypeScript, not with SQL's `sum()`.** A line has a few returns at most, and `sumQuantity()`
  gives the 4 decimals every quantity of the API has; SQL's sum would need a cast and a format for the same result.
  It keeps the serial numbers in the order they came back.
- **`returnedFor()` answers "nothing" for a line with no return** (`'0.0000'`, no serials), so no caller handles
  `undefined`.
- **`returnableSalesOf()` takes sale rows that the caller picked and sorted** (decision 22). The route by number, the
  register's recent sales and the pull's loader each choose their own sales, and all three send one shape. The lines,
  the returns, the payments and the customers are read once for all the sales of a page, not once per sale: a full
  pull's page has hundreds.
- **The line's name, SKU and VAT rate come from `toSalesLine()`,** the same function every sales document uses, so a
  renamed VAT rate looks the same here as on the sale's page.

### `sales/sales-books.service.ts`: the sales returns account, shared

```diff
@@ -96,7 +96,7 @@ export class SalesBooksService {
   ): Promise<EntryRef | null> {
     if (isZeroMoney(input.total)) return null;
     const accounts = await this.accounts(tx);
-    const returns = (await this.returnsAccount(tx)) ?? accounts.sales;
+    const returns = (await salesReturnsAccount(tx)) ?? accounts.sales;
     const lines: LineInput[] = [
       debit(returns, input.branchId, null, input.net),
       debit(accounts.vatOutput, input.branchId, null, input.vat),
@@ -230,40 +230,41 @@ export class SalesBooksService {
       vatOutput: idOf('vat_output'),
     };
   }
+}
 
-  // The account chosen in Settings → Sales for sales returns (step 15d), or null when none is
-  // chosen. FOR SHARE like the others. AccountsService refuses to archive or delete the chosen
-  // account (account_used_by_sales), so an unusable one is only a safety net: the person is sent
-  // to the setting, like stock_account_missing, and nothing is posted.
-  private async returnsAccount(tx: Transaction): Promise<string | null> {
-    const tenantId = getTenantId();
-    const [settings] = await tx
-      .select({ accountId: tenantSettings.salesReturnsAccountId })
-      .from(tenantSettings)
-      .where(eq(tenantSettings.tenantId, tenantId));
-    const accountId = settings?.accountId ?? null;
-    if (accountId === null) return null;
-    const [usable] = await tx
-      .select({ id: ledgerAccounts.id })
-      .from(ledgerAccounts)
-      .where(
-        and(
-          eq(ledgerAccounts.tenantId, tenantId),
-          eq(ledgerAccounts.id, accountId),
-          eq(ledgerAccounts.isGroup, false),
-          isNull(ledgerAccounts.archivedAt),
-        ),
-      )
-      .for('share');
-    if (!usable) {
-      throw new AppError(
-        409,
-        'sales_account_invalid',
-        'The sales returns account cannot be used. Choose another one in Settings → Sales.',
-      );
-    }
-    return usable.id;
+// The account chosen in Settings → Sales for sales returns (step 15d), or null when none is
+// chosen. FOR SHARE like the others. AccountsService refuses to archive or delete the chosen
+// account (account_used_by_sales), so an unusable one is only a safety net: the person is sent
+// to the setting, like stock_account_missing, and nothing is posted. Step 20c: a function, not a
+// method, because a POS return books on it too (StockBooksService.posReturn).
+export async function salesReturnsAccount(tx: Transaction): Promise<string | null> {
+  const tenantId = getTenantId();
+  const [settings] = await tx
+    .select({ accountId: tenantSettings.salesReturnsAccountId })
+    .from(tenantSettings)
+    .where(eq(tenantSettings.tenantId, tenantId));
+  const accountId = settings?.accountId ?? null;
+  if (accountId === null) return null;
+  const [usable] = await tx
+    .select({ id: ledgerAccounts.id })
+    .from(ledgerAccounts)
+    .where(
+      and(
+        eq(ledgerAccounts.tenantId, tenantId),
+        eq(ledgerAccounts.id, accountId),
+        eq(ledgerAccounts.isGroup, false),
+        isNull(ledgerAccounts.archivedAt),
+      ),
+    )
+    .for('share');
+  if (!usable) {
+    throw new AppError(
+      409,
+      'sales_account_invalid',
+      'The sales returns account cannot be used. Choose another one in Settings → Sales.',
+    );
   }
+  return usable.id;
 }
 
 // A found entry as a reference; null if it has no number (only a draft has none)
```

- **The private method becomes an exported function** (decision 57) with the same body. The credit note calls it as
  before; the POS return's entry calls it from `StockBooksService`. A second copy of the query would drift from the
  first the day someone changes the rule.

### `inventory/stock-books.service.ts`: the return's entry

```diff
@@ -17,6 +17,7 @@ import { AppError } from '../common/http/app-error.js';
 import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction } from '../common/tenant/with-tenant.js';
 import { type LineInput, PostingService } from '../journal/posting.service.js';
+import { salesReturnsAccount } from '../sales/sales-books.service.js';
 
 // One amount on one side of the entry before lines are summed: + debit, − credit
 interface Amount {
@@ -334,6 +335,55 @@ export class StockBooksService {
     ]);
   }
 
+  // A POS return (step 20c): the sale's entry the other way round, for what came back. Dr the
+  // sales returns account (Settings → Sales; the Sales account itself when none is chosen) for the
+  // net / Dr Output VAT for the VAT / Cr each refund's account (an exchange's: the register's
+  // exchange account), and Dr Inventory / Cr Cost of goods sold for what the goods cost when sold.
+  // Two branches, like a sales return of 15d: the money and the goods are where they came back
+  // (the register's warehouse), the sale and its cost come off where it was made (the sale's
+  // warehouse). Online a counter takes back another branch's receipt, and that branch's sales
+  // should fall, not this one's. A return of ৳0 that cost nothing has no entry.
+  async posReturn(
+    tx: Transaction,
+    document: { id: string; number: string; date: string },
+    input: {
+      warehouseId: string;
+      saleWarehouseId: string;
+      refunds: readonly { accountId: string; amount: string }[];
+      net: string;
+      vat: string;
+      cost: string;
+    },
+  ): Promise<EntryRef | null> {
+    const accounts = await this.accounts(tx);
+    const returns = (await salesReturnsAccount(tx)) ?? accounts.sales();
+    const branchOf = await this.branches(tx, [
+      { warehouseId: input.warehouseId, value: '0' },
+      { warehouseId: input.saleWarehouseId, value: '0' },
+    ]);
+    const here = branchOf(input.warehouseId);
+    const sold = branchOf(input.saleWarehouseId);
+    return this.write(tx, document, 'pos_return', `POS return ${document.number}`, [
+      { accountId: returns, branchId: sold, amount: input.net },
+      { accountId: accounts.vatOutput(), branchId: sold, amount: input.vat },
+      ...input.refunds.map((refund) => ({
+        accountId: refund.accountId,
+        branchId: here,
+        amount: negateMoney(refund.amount),
+      })),
+      ...(isZeroMoney(input.cost)
+        ? []
+        : [
+            { accountId: accounts.inventory, branchId: here, amount: input.cost },
+            {
+              accountId: accounts.costOfGoodsSold(),
+              branchId: sold,
+              amount: negateMoney(input.cost),
+            },
+          ]),
+    ]);
+  }
+
   // The posted entries of a document, oldest first: an adjustment has at most one, a transfer two
   async entriesOf(tx: Transaction, documentId: string): Promise<EntryRef[]> {
     const rows = await tx
```

- **`posReturn()` is `posSale()` the other way round:** Dr the sales returns account (the Sales account when none is
  chosen, like a credit note) and Dr Output VAT, Cr each refund's account; Dr Inventory and Cr Cost of goods sold for
  what the goods cost.
- **Two branches** (decision 49): the returns, the VAT and the cost on the sale's branch, the refunds and the goods on
  the register's. `branches()` reads both warehouses in one query; when they are the same branch, `write()` sums the
  lines as usual.
- **An exchange refund is an ordinary refund line here:** its account is the register's exchange account, so the
  clearing account gets the credit, and the sale made with it debits the same account (decision 47).
- **A return of ৳0 that cost nothing writes no entry,** like a sale: `write()` returns `null` when fewer than two lines
  are left.

### `pos/pos-returns.service.ts` (new): the return

The longest file of the part, in seven pieces.

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type ErrorCode,
  formatReturnNumber,
  isQuantity,
  isWholeQuantity,
  isWithinReturnWindow,
  type PartyRef,
  type PosRegisterSalesPage,
  type PosReturn,
  type PosReturnableSale,
  type PosReturnInput,
  posReturnAmounts,
  returnableQuantityOf,
  type PosReturnSummary,
  prorateMoney,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  wholeCount,
} from '@omnivo/contracts';
import {
  batches,
  devices,
  posRegisters,
  posReturnLineBatches,
  posReturnLines,
  posReturnRefunds,
  posReturns,
  posSaleLineBatches,
  posSaleLines,
  posSalePayments,
  posSales,
  posShifts,
  serials,
  stockTransferLines,
  stockTransfers,
  users,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, gt, gte, inArray, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentDeviceId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import {
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';
import { type StockMove, StockPostingService } from '../inventory/stock-posting.service.js';
import type { Access } from '../rbac/permission.service.js';
import { customerRefs } from '../sales/sales-lines.js';
import { bookingDay } from './booking-day.js';
import { accountOf } from './pos-registers.service.js';
import { posSalesFrom, returnableSalesOf, returnedFor, returnedOf } from './pos-returnable.js';
import { deviceShift } from './pos-shifts.service.js';

type ReturnRow = typeof posReturns.$inferSelect;
type SaleRow = typeof posSales.$inferSelect;
type SaleLineRow = typeof posSaleLines.$inferSelect;

const listCursorSchema = z.tuple([z.iso.date(), z.uuid()]);
const salesCursorSchema = z.tuple([z.number().int()]);

// The sale an exchange paid for, as the return's row names it
const exchangeSales = alias(posSales, 'exchange_sales');

function notHeld(): AppError {
  return new AppError(
    409,
    'pos_register_not_held',
    'This device does not hold the register the return was made on.',
    { fieldErrors: { registerId: ['pos_register_not_held'] } },
  );
}

// Like a sale's number (step 20a, decision 34): the register is locked, so only a bug gets here
function numberTaken(number: string): AppError {
  return new AppError(
    409,
    'pos_return_number_taken',
    `Another return already has number ${number}.`,
    {
      fieldErrors: { sequence: ['pos_return_number_taken'] },
    },
  );
}

// The device found the sale on itself or on the server, and a return waits for its sale in the
// outbox: a sale the server does not have is a bug, or a sale of another workspace
function saleUnknown(status: 404 | 409): AppError {
  return new AppError(status, 'pos_return_sale_not_found', 'No POS sale has this receipt number.', {
    fieldErrors: { saleId: ['pos_return_sale_not_found'] },
  });
}

// A return line, worked out against its sale line before anything is written
interface PlannedLine {
  index: number;
  input: PosReturnInput['lines'][number];
  sale: SaleLineRow;
  variant: VariantInfo;
  baseQuantity: string;
  // What posted returns took back of the sale line before this one, in its unit
  before: string;
  // What the goods cost when they were sold, this return's share of it
  value: string;
}

// `value` cut by the quantities, adding up to it exactly: the last part takes what is left
function splitByQuantity(value: string, quantities: readonly string[]): string[] {
  const whole = sumQuantity(quantities);
  let left = value;
  return quantities.map((quantity, index) => {
    if (index === quantities.length - 1) return left;
    const part = prorateMoney(value, quantity, whole);
    left = subtractMoney(left, part);
    return part;
  });
}

// POS returns (step 20c). Like a sale, a return is written in one place: the sync's push, through
// createFromDevice. It is posted the moment it is written: its lines, the batches the goods went
// back into, its refunds, its stock movements and its journal entry, in the push's savepoint for
// that command. The money was paid back at the counter, so it is never refused for the window,
// for more than is left or for permission (decision 20): those go into the audit log. The refusals
// left are what someone can put right (a register with no account for a refund's method, or no
// exchange account) and bugs (a sale, a line or a serial number that is not the sale's).
@Injectable()
export class PosReturnsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly stock: StockPostingService,
    private readonly books: StockBooksService,
  ) {}

  // The work of one pos_return.create command, inside the push's savepoint. `access` is the
```

**The top of the file:**

- **`exchangeSales` is a second name for `pos_sales`:** the list joins the return's own sale and the sale its money paid
  for, and one table cannot be joined twice under one name.
- **`numberTaken()` and `saleUnknown()` are bugs, never a cashier's slip:** the register is locked while a return is
  written, and a return waits for its sale in the outbox. `saleUnknown()` takes the status because the route answers
  404 and the push 409 (decision 55).
- **`PlannedLine` is everything a line needs before anything is written:** its sale line, its variant, its base
  quantity, what was returned before it, and its cost. The stock plan and the audit read it; nothing is looked up twice.
- **`splitByQuantity()` cuts a line's cost between its moves** (two batches, or serial numbers and pieces without one).
  The last part takes what is left, so the parts add up to the line exactly; prorating each part on its own could lose
  a paisa.

```ts
  // person's roles of now, for the audit log only.
  async createFromDevice(
    tx: Transaction,
    access: Access,
    returnId: string,
    input: PosReturnInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = currentDeviceId();
    if (deviceId === null) throw new Error('A POS return is written only from a device');

    // The device, then the register: the lock order of a sale (0052). FOR UPDATE on the register:
    // its returns are written one after the other, and 0056 moves its last return number.
    await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.tenantId, tenantId), eq(devices.id, deviceId)))
      .for('share');
    const [register] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, input.registerId)))
      .for('update');
    if (register?.deviceId !== deviceId) throw notHeld();
    const number = formatReturnNumber(register.code, input.sequence);
    // Decision 19: the shift of this register and this device. A shift closed since still takes
    // it, like a late sale (decision 40).
    await deviceShift(tx, input.shiftId, deviceId, register.id);

    // Where each refund's money came from: the register's account for the method now, or its
    // exchange account. Both can be put right in Settings → POS, then sent again from the Sync page.
    const issues: LineIssue[] = [];
    const refunds = input.refunds.map((refund, index) => {
      const accountId = accountOf(register, refund.method);
      if (accountId === null) {
        issues.push({
          path: `refunds.${String(index)}.method`,
          code: refund.method === 'exchange' ? 'pos_exchange_not_set' : 'pos_method_not_set',
        });
      }
      return { ...refund, accountId: accountId ?? '' };
    });
    const [firstIssue] = issues;
    if (firstIssue !== undefined) {
      throw new AppError(
        409,
        firstIssue.code,
        firstIssue.code === 'pos_exchange_not_set'
          ? 'The register has no exchange account. Set one in Settings → POS.'
          : 'The register has no account for a way this return paid back. Set one in Settings → POS.',
        { fieldErrors: Object.fromEntries(issues.map((issue) => [issue.path, [issue.code]])) },
      );
    }

    // The sale, FOR UPDATE: two counters taking back the same receipt at once are written one
    // after the other, so the second sees what the first took back. Nothing else locks a sale
    // (it never changes), so this waits only for another return of it.
    const [sale] = await tx
      .select()
      .from(posSales)
      .where(and(eq(posSales.tenantId, tenantId), eq(posSales.id, input.saleId)))
      .for('update');
    if (!sale) throw saleUnknown(409);
    const lines = await this.planLines(tx, sale, input);

    const window = isWithinReturnWindow(sale.date, input.date, register.returnDays);
    const net = sumMoney(input.lines.map((line) => line.net));
    const vat = sumMoney(input.lines.map((line) => line.vat));
    const total = addMoney(net, vat);
    // Decision 26 of 20a: on the device's day, or the first day the books take
    const date = await bookingDay(tx, input.date);

    try {
      await tx.insert(posReturns).values({
        id: returnId,
        tenantId,
        registerId: register.id,
        shiftId: input.shiftId,
        deviceId,
        sequence: input.sequence,
        number,
        date,
        returnedAt: new Date(input.returnedAt),
        saleId: sale.id,
        warehouseId: register.warehouseId,
        net,
        vat,
        total,
        note: input.note,
        outsideWindow: !window,
        createdBy: currentPrincipal().userId,
        updatedBy: currentPrincipal().userId,
      });
    } catch (error) {
      if (
        isUniqueViolation(error, 'pos_returns_register_sequence_idx') ||
        isUniqueViolation(error, 'pos_returns_tenant_number_idx')
      ) {
        throw numberTaken(number);
      }
      throw error;
    }

    // The goods come back into the register's warehouse (decision 3), at what they cost when sold
    const planned = await this.planStock(tx, register.warehouseId, lines);
    const moves = planned.flatMap((plan) => plan.moves);
    await this.stock.post(tx, {
      date,
      kind: 'pos_return',
      direction: 'in',
      documentId: returnId,
      documentNumber: number,
      moves,
    });

    const written = await tx
      .insert(posReturnLines)
      .values(
        lines.map((line) => ({
          tenantId,
          returnId,
          lineNo: line.index + 1,
          saleLineId: line.sale.id,
          variantId: line.sale.variantId,
          quantity: line.input.quantity,
          baseQuantity: line.baseQuantity,
          net: line.input.net,
          vat: line.input.vat,
          total: addMoney(line.input.net, line.input.vat),
          value: line.value,
          serialNumbers: line.input.serialNumbers,
        })),
      )
      .returning({ id: posReturnLines.id, lineNo: posReturnLines.lineNo });
    const lineIds = new Map(written.map((row) => [row.lineNo, row.id]));
    const batchRows = planned.flatMap((plan) => {
      const lineId = lineIds.get(plan.line.index + 1);
      if (lineId === undefined) return [];
      return plan.batches.map((part) => ({
        tenantId,
        lineId,
        saleLineId: plan.line.sale.id,
        batchId: part.batchId,
        quantity: part.quantity,
      }));
    });
    if (batchRows.length > 0) await tx.insert(posReturnLineBatches).values(batchRows);
    if (refunds.length > 0) {
      await tx.insert(posReturnRefunds).values(
        refunds.map((refund, index) => ({
          tenantId,
          returnId,
          lineNo: index + 1,
          method: refund.method,
          amount: refund.amount,
          reference: refund.reference,
          accountId: refund.accountId,
        })),
      );
    }

    const entry = await this.books.posReturn(
      tx,
      { id: returnId, number, date },
      {
        warehouseId: register.warehouseId,
        saleWarehouseId: sale.warehouseId,
        refunds,
        net,
        vat,
        cost: sumMoney(lines.map((line) => line.value)),
      },
    );

    await this.auditReturn(tx, access, { id: returnId, number, date, total }, input, {
      register,
      sale,
      lines,
      window,
      entryNumber: entry?.number ?? null,
    });

    // The return's own checks (0056's deferred triggers) here, inside the savepoint, like a sale's
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  }

  // Decision 43, like a sale's number (20a, decision 37): a refused return's slip was printed, so
  // its number is used. The push calls this after the savepoint rolled back. Only up.
  async keepNumber(tx: Transaction, input: { registerId: string; sequence: number }) {
    await tx
      .update(posRegisters)
      .set({ lastReturnNumber: input.sequence })
      .where(
        and(
          eq(posRegisters.tenantId, getTenantId()),
          eq(posRegisters.id, input.registerId),
          sql`${posRegisters.lastReturnNumber} < ${input.sequence}`,
        ),
      );
  }
```

**Posting a return** (`createFromDevice()`), in the order the locks must be taken:

- **The device `FOR SHARE`, then the register `FOR UPDATE`:** the lock order of a sale (0052), so a revoke that is
  running finishes first. A register the device does not hold is `pos_register_not_held`, like a sale.
- **`deviceShift()` is 20b's check:** the shift is of this register and this device. A shift closed since still takes
  the return (decision 40); the drawer's cash is counted again by the close's late rule.
- **The refunds' accounts are checked before anything is written.** A missing one is the only refusal a person can put
  right; the error names the fix (decision 54).
- **The sale is locked `FOR UPDATE`** (decision 48) after the register, so the order is always device, register, sale.
  A sale of another workspace is not found, because every query is scoped by the tenant and by row-level security.
- **The window is checked on the device's day, not the booking day** (decision 29): a return made offline on the 7th
  day and sent on the 9th is inside the window. The answer goes into the audit log, never into a refusal.
- **The totals are the device's line amounts** (decision 14): the money was paid back, and the drawer and the books
  must agree. The database checks that they add up (`pos_returns_lines_match`).
- **The insert's unique indexes answer `pos_return_number_taken`,** like a sale's number: only a bug gets there.
- **The stock is planned, then posted `in`** with the values the plan gives each move. `post()` takes those values as
  they are (a move in with a value), so the goods come back at what they cost when sold (decision 51), not at today's
  average.
- **The lines, then their batches, then the refunds:** the batch rows need the line ids that the insert returns, by
  line number.
- **The audit rows come after the entry,** so `pos_return.created` names the entry's number.
- **`SET CONSTRAINTS ALL IMMEDIATE` runs 0056's checks inside the savepoint,** like a sale's: a return that does not add
  up fails with this command, not at the push's commit.
- **`keepNumber()` moves `last_return_number` for a refused return** (decision 43): its slip was printed, so its number
  is used. Only up, and without the version, like the trigger's own move.

```ts
  // The return screen online: any register's receipt (decision 21). The number is unique in the
  // workspace (pos_sales_tenant_number_idx). The window is the screen's to check: it knows today.
  returnableSale(number: string): Promise<PosReturnableSale> {
    return this.withTenant(async (tx) => {
      const [sale] = await tx
        .select()
        .from(posSales)
        .where(and(eq(posSales.tenantId, getTenantId()), eq(posSales.number, number)));
      if (!sale) throw saleUnknown(404);
      const [found] = await returnableSalesOf(tx, [sale]);
      if (!found) throw saleUnknown(404);
      return found;
    });
  }

  // Decision 45: the sales the device reads right after it takes a register, in the order they
  // were sold in: by the register's own numbers (pos_sales_register_sequence_idx), which no device's
  // clock can disorder. The same days as the pull's pos_sale rows.
  registerSales(
    registerId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<PosRegisterSalesPage> {
    const after = decodeCursor(query.cursor, salesCursorSchema);
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const [register] = await tx
        .select({ id: posRegisters.id })
        .from(posRegisters)
        .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, registerId)));
      if (!register) throw notFound('POS register');
      const rows = await tx
        .select()
        .from(posSales)
        .where(
          and(
            eq(posSales.tenantId, tenantId),
            eq(posSales.registerId, registerId),
            gte(posSales.date, await posSalesFrom(tx)),
            after === undefined ? undefined : gt(posSales.sequence, after[0]),
          ),
        )
        .orderBy(asc(posSales.sequence))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.sequence]);
      return { items: await returnableSalesOf(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  list(query: {
    limit: number;
    cursor?: string | undefined;
    registerId?: string | undefined;
    saleId?: string | undefined;
    shiftId?: string | undefined;
  }): Promise<{ items: PosReturnSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, listCursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.registerId === undefined ? undefined : eq(posReturns.registerId, query.registerId),
          query.saleId === undefined ? undefined : eq(posReturns.saleId, query.saleId),
          query.shiftId === undefined ? undefined : eq(posReturns.shiftId, query.shiftId),
          after === undefined
            ? undefined
            : sql`(${posReturns.date}, ${posReturns.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<PosReturn> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const [summary] = await this.summaries(tx, eq(posReturns.id, id), 1);
      if (!summary) throw notFound('POS return');
      const [header] = await tx
        .select({
          note: posReturns.note,
          deviceId: posReturns.deviceId,
          deviceName: devices.name,
          pricesIncludeVat: posSales.pricesIncludeVat,
        })
        .from(posReturns)
        .innerJoin(
          devices,
          and(eq(devices.tenantId, posReturns.tenantId), eq(devices.id, posReturns.deviceId)),
        )
        .innerJoin(
          posSales,
          and(eq(posSales.tenantId, posReturns.tenantId), eq(posSales.id, posReturns.saleId)),
        )
        .where(and(eq(posReturns.tenantId, tenantId), eq(posReturns.id, id)));
      if (!header) throw notFound('POS return');
      const lineRows = await tx
        .select({
          line: posReturnLines,
          unitId: posSaleLines.unitId,
          description: posSaleLines.description,
          unitPrice: posSaleLines.unitPrice,
        })
        .from(posReturnLines)
        .innerJoin(
          posSaleLines,
          and(
            eq(posSaleLines.tenantId, posReturnLines.tenantId),
            eq(posSaleLines.id, posReturnLines.saleLineId),
          ),
        )
        .where(and(eq(posReturnLines.tenantId, tenantId), eq(posReturnLines.returnId, id)))
        .orderBy(asc(posReturnLines.lineNo));
      const variants = await loadVariants(
        tx,
        lineRows.map((row) => row.line.variantId),
      );
      const parts =
        lineRows.length === 0
          ? []
          : await tx
              .select({
                lineId: posReturnLineBatches.lineId,
                batchId: posReturnLineBatches.batchId,
                lotNumber: batches.lotNumber,
                expiresOn: batches.expiresOn,
                quantity: posReturnLineBatches.quantity,
              })
              .from(posReturnLineBatches)
              .innerJoin(
                batches,
                and(
                  eq(batches.tenantId, posReturnLineBatches.tenantId),
                  eq(batches.id, posReturnLineBatches.batchId),
                ),
              )
              .where(
                and(
                  eq(posReturnLineBatches.tenantId, tenantId),
                  inArray(
                    posReturnLineBatches.lineId,
                    lineRows.map((row) => row.line.id),
                  ),
                ),
              )
              .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.id));
      const refundRows = await tx
        .select()
        .from(posReturnRefunds)
        .where(and(eq(posReturnRefunds.tenantId, tenantId), eq(posReturnRefunds.returnId, id)))
        .orderBy(asc(posReturnRefunds.lineNo));
      const [entry] = await this.books.entriesOf(tx, id);
      return {
        ...summary,
        pricesIncludeVat: header.pricesIncludeVat,
        note: header.note,
        lines: lineRows.flatMap(({ line, unitId, description, unitPrice }) => {
          // The FK keeps the variant while a line points at it
          const variant = variants.get(line.variantId);
          if (variant === undefined) return [];
          return [
            {
              variantId: variant.variantId,
              productId: variant.productId,
              productCode: variant.productCode,
              productName: variant.productName,
              optionValues: variant.optionValues,
              sku: variant.sku,
              baseUnitId: variant.baseUnitId,
              id: line.id,
              saleLineId: line.saleLineId,
              unitId,
              quantity: line.quantity,
              baseQuantity: line.baseQuantity,
              description,
              unitPrice,
              net: line.net,
              vat: line.vat,
              total: line.total,
              batches: parts
                .filter((part) => part.lineId === line.id)
                .map((part) => ({
                  batchId: part.batchId,
                  lotNumber: part.lotNumber,
                  expiresOn: part.expiresOn,
                  quantity: part.quantity,
                })),
              serialNumbers: line.serialNumbers,
            },
          ];
        }),
        refunds: refundRows.map((refund) => ({
          method: refund.method,
          amount: refund.amount,
          reference: refund.reference,
          accountId: refund.accountId,
        })),
        device: { id: header.deviceId, name: header.deviceName },
        entry: entry ?? null,
      };
    });
  }
```

**The reads:**

- **`returnableSale()` finds any register's receipt** (decision 21) by its unique number. It does not check the window:
  only the screen knows the device's today, and an old sale must still show its lines with "Returns ended on…".
- **`registerSales()` pages by the register's own numbers** (decision 45), with `pos_sales_register_sequence_idx`: no
  device's clock can put two sales out of order, and the keyset is one integer. An unknown register is a 404, so a
  wrong id is not an empty page.
- **`list()` is newest first by date and id,** with the keyset of every other list, and the three filters of the
  contract: the sale's page lists its returns, the shift's page its own.
- **`get()` reads the line's unit, description and price from the sale line** (decision 35 of 20c.2): a return line
  keeps only what is its own. "Prices include VAT" is the sale's (decision 34).
- **A line's batches are listed by expiry,** like the sale's page, so the two pages read alike.

```ts

  // Each line against its sale line: a line of this sale, its quantity in the base unit by the
  // sale line's own unit, its serial numbers out of the sale line's, and its share of what the
  // goods cost. A refusal here is a bug: the screen offers only the sale's lines and serials.
  private async planLines(
    tx: Transaction,
    sale: SaleRow,
    input: PosReturnInput,
  ): Promise<PlannedLine[]> {
    const saleLines = await tx
      .select()
      .from(posSaleLines)
      .where(and(eq(posSaleLines.tenantId, getTenantId()), eq(posSaleLines.saleId, sale.id)));
    const byId = new Map(saleLines.map((line) => [line.id, line]));
    const variants = await loadVariants(
      tx,
      saleLines.map((line) => line.variantId),
    );
    const returned = await returnedOf(
      tx,
      saleLines.map((line) => line.id),
    );
    const issues: LineIssue[] = [];
    const planned: PlannedLine[] = [];
    input.lines.forEach((line, index) => {
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      const saleLine = byId.get(line.saleLineId);
      const variant = saleLine === undefined ? undefined : variants.get(saleLine.variantId);
      if (saleLine === undefined || variant === undefined) {
        at('saleLineId', 'pos_return_line_unknown');
        return;
      }
      // Decision 17: in the sale line's unit. The product's pack is still there: a pack a
      // document used is never removed (step 12).
      const unit =
        saleLine.unitId === variant.baseUnitId
          ? { factor: '1' }
          : variant.units.find((pack) => pack.unitId === saleLine.unitId);
      const baseQuantity =
        unit === undefined
          ? null
          : toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
      if (baseQuantity === null || !isQuantity(baseQuantity)) {
        at('quantity', 'quantity_format');
        return;
      }
      // A serial product's line brings back one serial number of the sale line per piece; any
      // other line brings back none
      const sold = new Set(saleLine.serialNumbers);
      const serialsOk =
        variant.tracking === 'serial'
          ? isWholeQuantity(baseQuantity) &&
            wholeCount(baseQuantity) === line.serialNumbers.length &&
            line.serialNumbers.every((serial) => sold.has(serial))
          : line.serialNumbers.length === 0;
      if (!serialsOk) {
        at('serialNumbers', 'pos_return_serial_invalid');
        return;
      }
      // The same shares as the money (posReturnAmounts), so all the returns of a line take back
      // exactly what it cost, to the paisa
      const before = returnedFor(returned, saleLine.id).quantity;
      const value = posReturnAmounts(
        { quantity: saleLine.quantity, net: saleLine.value, vat: '0', returnedQuantity: before },
        line.quantity,
      ).net;
      planned.push({ index, input: line, sale: saleLine, variant, baseQuantity, before, value });
    });
    if (issues.length > 0) throw linesError(issues);
    return planned;
  }
```

**Checking each line** (`planLines()`):

- **One query for the sale's lines, one for their variants, one for what came back:** a return of 30 lines makes three
  queries, not ninety.
- **A line that is not of this sale is `pos_return_line_unknown`** under its own path, so the Sync page points at the
  line. The database checks it again at commit (`pos_return_lines_sale_match`).
- **The base quantity uses the sale line's unit** (decision 50) with `toBaseQuantity()`, the rule a sale's line uses.
  A unit that is not there, or a result that is not a quantity, is a bug (`quantity_format`).
- **A serial line brings back one of its sale line's serial numbers per piece,** and every other line none
  (`pos_return_serial_invalid`). The device ticks them from the sale line's, so anything else is a bug.
- **The cost is `posReturnAmounts()` on the line's value** (decision 51) with a VAT of zero: the same shares as the
  money, so the returns of a line add up to its cost.

```ts

  // Where each line's goods go back to, in the register's warehouse:
  //   no tracking  the line's base quantity
  //   batch        into the batches the sale line left from (decision 16), in the order it took
  //                them (the cashier's batch first), each up to what it gave less what earlier
  //                returns put back; what is still left (more than was sold) into the first
  //   serial       a serial number that left with the sale comes back with it; one the sale took
  //                as a piece without its number (sold short, 20a), or one in stock or on a
  //                truck since, comes back as a piece without one, so a return is never refused
  // Each move carries its share of the line's cost, by quantity.
  private async planStock(
    tx: Transaction,
    warehouseId: string,
    lines: readonly PlannedLine[],
  ): Promise<
    { line: PlannedLine; moves: StockMove[]; batches: { batchId: string; quantity: string }[] }[]
  > {
    const tenantId = getTenantId();
    const goods = lines.filter((line) => line.variant.type === 'goods');
    const batchLines = goods.filter((line) => line.variant.tracking === 'batch');
    const saleBatches =
      batchLines.length === 0
        ? []
        : await tx
            .select({
              lineId: posSaleLineBatches.lineId,
              batchId: posSaleLineBatches.batchId,
              quantity: posSaleLineBatches.quantity,
              expiresOn: batches.expiresOn,
            })
            .from(posSaleLineBatches)
            .innerJoin(
              batches,
              and(
                eq(batches.tenantId, posSaleLineBatches.tenantId),
                eq(batches.id, posSaleLineBatches.batchId),
              ),
            )
            .where(
              and(
                eq(posSaleLineBatches.tenantId, tenantId),
                inArray(
                  posSaleLineBatches.lineId,
                  batchLines.map((line) => line.sale.id),
                ),
              ),
            )
            .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.id));
    const backBefore =
      batchLines.length === 0
        ? []
        : await tx
            .select({
              saleLineId: posReturnLineBatches.saleLineId,
              batchId: posReturnLineBatches.batchId,
              quantity: posReturnLineBatches.quantity,
            })
            .from(posReturnLineBatches)
            .where(
              and(
                eq(posReturnLineBatches.tenantId, tenantId),
                inArray(
                  posReturnLineBatches.saleLineId,
                  batchLines.map((line) => line.sale.id),
                ),
              ),
            );
    const withNumber = await this.serialsBack(
      tx,
      goods.filter((line) => line.variant.tracking === 'serial'),
    );

    return lines.map((line) => {
      if (line.variant.type !== 'goods') return { line, moves: [], batches: [] };
      const move = (
        batchId: string | null,
        quantity: string,
        value: string,
        serialNumbers: string[] = [],
      ): StockMove => ({
        line: line.index,
        warehouseId,
        variant: line.variant,
        batchId,
        quantity,
        serialNumbers,
        value,
      });

      if (line.variant.tracking === 'batch') {
        const own = line.sale.batchId;
        const rows = saleBatches
          .filter((row) => row.lineId === line.sale.id)
          .sort((a, b) => Number(b.batchId === own) - Number(a.batchId === own));
        const taken = new Map<string, string>();
        let wanted = line.baseQuantity;
        for (const row of rows) {
          if (compareQuantity(wanted, '0') <= 0) break;
          const back = backBefore
            .filter((part) => part.saleLineId === line.sale.id && part.batchId === row.batchId)
            .reduce((sum, part) => addQuantity(sum, part.quantity), '0');
          const room = subtractQuantity(row.quantity, back);
          if (compareQuantity(room, '0') <= 0) continue;
          const part = compareQuantity(room, wanted) < 0 ? room : wanted;
          taken.set(row.batchId, part);
          wanted = subtractQuantity(wanted, part);
        }
        const [first] = rows;
        // A batch line always left from at least one batch (0052's pos_sale_line_batches_match)
        if (first === undefined) throw new Error(`POS sale line ${line.sale.id} has no batches`);
        if (compareQuantity(wanted, '0') > 0) {
          taken.set(first.batchId, addQuantity(taken.get(first.batchId) ?? '0', wanted));
        }
        const parts = [...taken].map(([batchId, quantity]) => ({ batchId, quantity }));
        const values = splitByQuantity(
          line.value,
          parts.map((part) => part.quantity),
        );
        return {
          line,
          moves: parts.map((part, at) => move(part.batchId, part.quantity, values[at] ?? '0')),
          batches: parts,
        };
      }

      if (line.variant.tracking === 'serial') {
        const found = line.input.serialNumbers.filter((serial) =>
          withNumber.has(`${line.variant.variantId}|${serial}`),
        );
        const pieces = line.input.serialNumbers.length - found.length;
        const quantities = [
          ...(found.length > 0 ? [String(found.length)] : []),
          ...(pieces > 0 ? [String(pieces)] : []),
        ];
        const values = splitByQuantity(line.value, quantities);
        return {
          line,
          moves: [
            ...(found.length > 0
              ? [move(null, String(found.length), values[0] ?? '0', found)]
              : []),
            ...(pieces > 0
              ? [move(null, String(pieces), values[found.length > 0 ? 1 : 0] ?? '0')]
              : []),
          ],
          batches: [],
        };
      }

      return { line, moves: [move(null, line.baseQuantity, line.value)], batches: [] };
    });
  }

  // The serial numbers that can come back with their number: sold with the sale (not sold short),
  // out of every warehouse now and not on a truck. FOR UPDATE in id order, post()'s own order, so
  // nothing moves them between this and the posting. Returns variant|serial keys.
  private async serialsBack(tx: Transaction, lines: readonly PlannedLine[]): Promise<Set<string>> {
    const tenantId = getTenantId();
    const wanted = lines.flatMap((line) =>
      line.input.serialNumbers
        .filter((serial) => !line.sale.shortSerials.includes(serial))
        .map((serial) => ({ variantId: line.variant.variantId, serial })),
    );
    if (wanted.length === 0) return new Set();
    const variantIds = [...new Set(wanted.map((item) => item.variantId))];
    const numbers = [...new Set(wanted.map((item) => item.serial))];
    const rows = await tx
      .select({
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
    const sent = await tx
      .select({
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
    const onTruck = new Set(
      sent.flatMap((line) => line.serialNumbers.map((serial) => `${line.variantId}|${serial}`)),
    );
    const out = new Set(
      rows
        .filter((row) => row.warehouseId === null)
        .map((row) => `${row.variantId}|${row.serialNumber}`),
    );
    return new Set(
      wanted
        .map((item) => `${item.variantId}|${item.serial}`)
        .filter((key) => out.has(key) && !onTruck.has(key)),
    );
  }
```

**Where the goods go back** (`planStock()` and `serialsBack()`):

- **A service line moves no stock,** like a sale's: it was never delivered.
- **A batch line fills the sale line's batches in the order it took them** (decision 52): the cashier's batch first,
  then the others by expiry. Each takes at most what it gave less what earlier returns put back there, read from
  `pos_return_line_batches`. Anything beyond goes into the first, because the database wants every piece in a batch the
  line left from (`pos_return_line_batches_sale_batch_fk`).
- **A serial line splits into two moves at most** (decision 53): the serial numbers that can come back with their
  number, and a piece for each of the others. Each gets its share of the line's cost.
- **`serialsBack()` locks the serial rows `FOR UPDATE` in id order,** `post()`'s own order, so nothing moves them
  between the plan and the posting, and two postings never wait for each other in a circle.
- **A serial number on a truck is not "free" even though it is in no warehouse:** `post()` would refuse it as
  `stock_serial_in_stock`, so it comes back as a piece without its number. The truck's own receipt then brings the
  numbered piece in.

```ts

  // Decision 20: what the server would have refused, written down instead. Each row says what the
  // device sent and what the server knew.
  private async auditReturn(
    tx: Transaction,
    access: Access,
    document: { id: string; number: string; date: string; total: string },
    input: PosReturnInput,
    known: {
      register: typeof posRegisters.$inferSelect;
      sale: SaleRow;
      lines: readonly PlannedLine[];
      window: boolean;
      entryNumber: string | null;
    },
  ): Promise<void> {
    const { register, sale, lines } = known;
    const row = { entityType: 'pos_return' as const, entityId: document.id };
    await audit(tx, {
      ...row,
      action: 'pos_return.created',
      changes: created({
        number: document.number,
        date: document.date,
        returnedOn: input.date,
        register: register.code,
        sale: sale.number,
        total: document.total,
        refunds: input.refunds.map((refund) => `${refund.method} ${refund.amount}`).join(', '),
        entry: known.entryNumber,
      }),
    });
    if (!known.window) {
      await audit(tx, {
        ...row,
        action: 'pos_return.outside_window',
        changes: created({
          sale: sale.number,
          soldOn: sale.date,
          returnedOn: input.date,
          returnDays: String(register.returnDays),
        }),
      });
    }
    // Against what was returned before this one, as the server knows it (the sale is locked)
    const over = lines.filter((line) => {
      const left = returnableQuantityOf({
        quantity: line.sale.quantity,
        returnedQuantity: line.before,
      });
      return compareQuantity(line.input.quantity, left) > 0;
    });
    if (over.length > 0) {
      await audit(tx, {
        ...row,
        action: 'pos_return.over_returned',
        changes: created({
          lines: over
            .map(
              (line) =>
                `line ${String(line.index + 1)}: ${line.input.quantity} of ${line.sale.quantity}, ${line.before} back before`,
            )
            .join('; '),
        }),
      });
    }
    const differ = lines.flatMap((line) => {
      const server = posReturnAmounts(
        {
          quantity: line.sale.quantity,
          net: line.sale.net,
          vat: line.sale.vat,
          returnedQuantity: line.before,
        },
        line.input.quantity,
      );
      return compareMoney(server.net, line.input.net) === 0 &&
        compareMoney(server.vat, line.input.vat) === 0
        ? []
        : [
            `line ${String(line.index + 1)}: ${line.input.net} + ${line.input.vat} sent, ${server.net} + ${server.vat} worked out`,
          ];
    });
    if (differ.length > 0) {
      await audit(tx, {
        ...row,
        action: 'pos_return.amounts_differ',
        changes: created({ lines: differ.join('; ') }),
      });
    }
    if (!access.permissions.includes('pos.return.create')) {
      await audit(tx, {
        ...row,
        action: 'pos_return.without_permission',
        changes: created({
          number: document.number,
          returnedOn: input.date,
          missing: 'pos.return.create',
        }),
      });
    }
  }
```

**The audit log** (`auditReturn()`, decision 20):

- **`pos_return.created` always,** with the refunds as text ("exchange 736.0000"), so a manager reads where the money
  went without opening the return.
- **The other four only when they apply,** each with what the device sent and what the server knew: the window and the
  days, the quantity and what was back before, the amounts sent and worked out. A manager can see why without
  rebuilding the arithmetic.
- **"Returned before" is the server's, read with the sale locked** (decision 48), so two returns at the same moment
  never both look fine.

```ts

  // The list's rows, and the page's header
  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<PosReturnSummary[]> {
    const rows = await tx
      .select({
        ret: posReturns,
        register: { id: posRegisters.id, code: posRegisters.code, name: posRegisters.name },
        shiftNumber: posShifts.number,
        branchId: warehouses.branchId,
        cashierName: users.fullName,
        sale: {
          id: posSales.id,
          number: posSales.number,
          date: posSales.date,
          customerId: posSales.customerId,
        },
        exchangeSale: { id: exchangeSales.id, number: exchangeSales.number },
        lineCount: sql<number>`(SELECT count(*)::int FROM pos_return_lines l
          WHERE l.tenant_id = ${posReturns.tenantId} AND l.return_id = ${posReturns.id})`,
      })
      .from(posReturns)
      .innerJoin(
        posRegisters,
        and(
          eq(posRegisters.tenantId, posReturns.tenantId),
          eq(posRegisters.id, posReturns.registerId),
        ),
      )
      .innerJoin(
        posShifts,
        and(eq(posShifts.tenantId, posReturns.tenantId), eq(posShifts.id, posReturns.shiftId)),
      )
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, posReturns.tenantId),
          eq(warehouses.id, posReturns.warehouseId),
        ),
      )
      .innerJoin(
        posSales,
        and(eq(posSales.tenantId, posReturns.tenantId), eq(posSales.id, posReturns.saleId)),
      )
      // One sale at most uses a return (pos_sale_payments_return_idx), so no row is doubled
      .leftJoin(
        posSalePayments,
        and(
          eq(posSalePayments.tenantId, posReturns.tenantId),
          eq(posSalePayments.returnId, posReturns.id),
        ),
      )
      .leftJoin(
        exchangeSales,
        and(
          eq(exchangeSales.tenantId, posSalePayments.tenantId),
          eq(exchangeSales.id, posSalePayments.saleId),
        ),
      )
      .leftJoin(users, eq(users.id, posReturns.createdBy))
      .where(and(eq(posReturns.tenantId, getTenantId()), where))
      .orderBy(desc(posReturns.date), desc(posReturns.id))
      .limit(limit);
    const customers = await customerRefs(
      tx,
      rows.flatMap((row) => (row.sale.customerId === null ? [] : [row.sale.customerId])),
    );
    return rows.map((row) => toSummary(row, customers));
  }
}

function toSummary(
  row: {
    ret: ReturnRow;
    register: { id: string; code: string; name: string };
    shiftNumber: string;
    branchId: string;
    cashierName: string | null;
    sale: { id: string; number: string; date: string; customerId: string | null };
    exchangeSale: { id: string; number: string } | null;
    lineCount: number;
  },
  customers: Map<string, PartyRef>,
): PosReturnSummary {
  const { ret, sale } = row;
  // created_by is the person who pushed it: never empty for a return (createFromDevice sets it)
  if (ret.createdBy === null) throw new Error(`POS return ${ret.id} has no cashier`);
  return {
    id: ret.id,
    number: ret.number,
    register: row.register,
    shift: { id: ret.shiftId, number: row.shiftNumber },
    branchId: row.branchId,
    warehouseId: ret.warehouseId,
    date: ret.date,
    returnedAt: ret.returnedAt.toISOString(),
    sale: { id: sale.id, number: sale.number, date: sale.date },
    customer: sale.customerId === null ? null : (customers.get(sale.customerId) ?? null),
    cashier: { id: ret.createdBy, fullName: row.cashierName ?? '' },
    net: ret.net,
    vat: ret.vat,
    total: ret.total,
    lineCount: row.lineCount,
    exchangeSale: row.exchangeSale,
    outsideWindow: ret.outsideWindow,
    createdAt: ret.createdAt.toISOString(),
  };
}
```

**The list's rows:**

- **The branch is the return's warehouse's,** the register's: the list filters by where the goods came back.
- **The exchange sale comes from a left join on the payments' `return_id`:** one sale at most uses a return
  (`pos_sale_payments_return_idx`), so no row is doubled. Drizzle answers the nested object as `null` when the join
  finds nothing, which is what `exchangeSale` wants.
- **The customer is the sale's,** read in one query for the whole page (`customerRefs()`).

### `pos/pos-returns.controller.ts` (new) and `pos/pos.module.ts`

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PosReturnsService } from './pos-returns.service.js';

type Routes = typeof routes.posReturns;

// Step 20c. No route writes a return: it arrives as a sync command, like a sale (decision 21 of
// 20a). These read: the sale a cashier takes goods back from, a register's recent sales for its
// device's copy, and the managers' list and page.
@Controller()
export class PosReturnsController {
  constructor(private readonly returns: PosReturnsService) {}

  @Endpoint(routes.posReturns.registerSales)
  registerSales({
    params,
    query,
  }: RouteInput<Routes['registerSales']>): Promise<RouteResponse<Routes['registerSales']>> {
    return this.returns.registerSales(params.id, query);
  }

  @Endpoint(routes.posReturns.returnableSale)
  returnableSale({
    params,
  }: RouteInput<Routes['returnableSale']>): Promise<RouteResponse<Routes['returnableSale']>> {
    return this.returns.returnableSale(params.number);
  }

  @Endpoint(routes.posReturns.listReturns)
  listReturns({
    query,
  }: RouteInput<Routes['listReturns']>): Promise<RouteResponse<Routes['listReturns']>> {
    return this.returns.list(query);
  }

  @Endpoint(routes.posReturns.getReturn)
  getReturn({
    params,
  }: RouteInput<Routes['getReturn']>): Promise<RouteResponse<Routes['getReturn']>> {
    return this.returns.get(params.id);
  }
}
```

```diff
@@ -5,6 +5,8 @@ import { JournalModule } from '../journal/journal.module.js';
 import { PosController } from './pos.controller.js';
 import { PosCashReasonsService } from './pos-cash-reasons.service.js';
 import { PosRegistersService } from './pos-registers.service.js';
+import { PosReturnsController } from './pos-returns.controller.js';
+import { PosReturnsService } from './pos-returns.service.js';
 import { PosSalesService } from './pos-sales.service.js';
 import { PosShiftsController } from './pos-shifts.controller.js';
 import { PosShiftsService } from './pos-shifts.service.js';
@@ -18,10 +20,18 @@ import { PosShiftsService } from './pos-shifts.service.js';
 // PosShiftsService posts them with the journal's PostingService (JournalModule). It is exported
 // for the push too, which writes a shift's three commands; the variance bell's handler is wired
 // in the worker like the sold-short one.
+// Step 20c: the returns. A return moves stock and books like a sale (InventoryModule), and is
+// written only by the push, so PosReturnsService is exported for it too.
 @Module({
   imports: [InventoryModule, JournalModule],
-  controllers: [PosController, PosShiftsController],
-  providers: [PosRegistersService, PosSalesService, PosCashReasonsService, PosShiftsService],
-  exports: [PosSalesService, PosShiftsService],
+  controllers: [PosController, PosShiftsController, PosReturnsController],
+  providers: [
+    PosRegistersService,
+    PosSalesService,
+    PosCashReasonsService,
+    PosShiftsService,
+    PosReturnsService,
+  ],
+  exports: [PosSalesService, PosShiftsService, PosReturnsService],
 })
 export class PosModule {}
```

- **No route writes a return:** it arrives as a sync command, like a sale. The routes only read.
- **`PosReturnsService` is exported** for the push, the only place a return is written.

### `pos/pos-sales.service.ts`: the exchange payment and the sale's returns

```diff
@@ -22,6 +22,8 @@ import {
   batches,
   devices,
   posRegisters,
+  posReturnRefunds,
+  posReturns,
   posSaleLineBatches,
   posSaleLines,
   posSalePayments,
@@ -60,6 +62,7 @@ import {
 } from '../sales/sales-lines.js';
 import { bookingDay } from './booking-day.js';
 import { accountOf } from './pos-registers.service.js';
+import { returnedFor, returnedOf } from './pos-returnable.js';
 import { deviceShift } from './pos-shifts.service.js';
 
 type SaleRow = typeof posSales.$inferSelect;
@@ -85,6 +88,22 @@ function numberTaken(number: string): AppError {
   });
 }
 
+// Step 20c: an exchange payment that does not match its return. A bug, like a number taken.
+function exchangeInvalid(issues: readonly LineIssue[]): AppError {
+  const [first] = issues;
+  return new AppError(
+    409,
+    first?.code ?? 'pos_exchange_invalid',
+    "This sale's exchange does not match the return it uses.",
+    {
+      fieldErrors:
+        issues.length === 0
+          ? { payments: ['pos_exchange_invalid'] }
+          : Object.fromEntries(issues.map((issue) => [issue.path, [issue.code]])),
+    },
+  );
+}
+
 // "price on line 2, discount on line 3, bill discount": what the audit log shows of the
 // overrides, counted from 1 like the receipt
 function overrideText(overrides: readonly PosOverride[]): string {
@@ -154,10 +173,16 @@ export class PosSalesService {
       await deviceShift(tx, input.shiftId, deviceId, register.id);
     }
 
-    // The register's account for each method now: the money goes where the register says today
+    // The register's account for each method now: the money goes where the register says today.
+    // Step 20c: an exchange's money goes through the account its return put it on, so the two
+    // always meet on one account and it comes back to zero, even after a change of the register.
+    const exchanges = await this.checkExchange(tx, input, register.id);
     const issues: LineIssue[] = [];
     const payments = input.payments.map((payment, index) => {
-      const accountId = accountOf(register, payment.method);
+      const accountId =
+        payment.method === 'exchange'
+          ? (exchanges.get(index) ?? null)
+          : accountOf(register, payment.method);
       if (accountId === null) {
         issues.push({ path: `payments.${String(index)}.method`, code: 'pos_method_not_set' });
       }
@@ -285,6 +310,8 @@ export class PosSalesService {
           }
           return {
             ...salesLineValues(line, index),
+            // Step 20c: the device's own id, which a return made offline may already point at
+            ...(sent.id !== null && { id: sent.id }),
             // The device's rate and the amounts worked out with it (decision 22)
             taxRate: sent.rate,
             net: lineAmounts.net,
@@ -316,17 +343,25 @@ export class PosSalesService {
       }));
     });
     if (batchRows.length > 0) await tx.insert(posSaleLineBatches).values(batchRows);
-    await tx.insert(posSalePayments).values(
-      payments.map((payment, index) => ({
-        tenantId,
-        saleId,
-        lineNo: index + 1,
-        method: payment.method,
-        amount: payment.amount,
-        reference: payment.reference,
-        accountId: payment.accountId,
-      })),
-    );
+    try {
+      await tx.insert(posSalePayments).values(
+        payments.map((payment, index) => ({
+          tenantId,
+          saleId,
+          lineNo: index + 1,
+          method: payment.method,
+          amount: payment.amount,
+          reference: payment.reference,
+          accountId: payment.accountId,
+          returnId: payment.returnId,
+        })),
+      );
+    } catch (error) {
+      // Step 20c: another sale used the return at the same moment. checkExchange() looked first;
+      // this is the race it cannot see, and a bug either way (one device makes both).
+      if (isUniqueViolation(error, 'pos_sale_payments_return_idx')) throw exchangeInvalid([]);
+      throw error;
+    }
 
     // The books: the change came out of the cash, so it is a minus on the cash account
     const cost = sumMoney(lineValues);
@@ -484,10 +519,32 @@ export class PosSalesService {
               )
               .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.id));
       const paymentRows = await tx
-        .select()
+        .select({ payment: posSalePayments, returnNumber: posReturns.number })
         .from(posSalePayments)
+        .leftJoin(
+          posReturns,
+          and(
+            eq(posReturns.tenantId, posSalePayments.tenantId),
+            eq(posReturns.id, posSalePayments.returnId),
+          ),
+        )
         .where(and(eq(posSalePayments.tenantId, getTenantId()), eq(posSalePayments.saleId, id)))
         .orderBy(asc(posSalePayments.lineNo));
+      // Step 20c (decision 31): what came back of each line, and the returns, oldest first
+      const returned = await returnedOf(
+        tx,
+        lineRows.map((row) => row.id),
+      );
+      const returns = await tx
+        .select({
+          id: posReturns.id,
+          number: posReturns.number,
+          date: posReturns.date,
+          total: posReturns.total,
+        })
+        .from(posReturns)
+        .where(and(eq(posReturns.tenantId, getTenantId()), eq(posReturns.saleId, id)))
+        .orderBy(asc(posReturns.returnedAt), asc(posReturns.id));
       const [entry] = await this.books.entriesOf(tx, id);
       return {
         ...summary,
@@ -497,7 +554,10 @@ export class PosSalesService {
         billDiscount: sale.billDiscount,
         billDiscountAmount: sale.billDiscountAmount,
         paid: sale.paid,
-        change: posChangeOf(paymentRows, sale.total),
+        change: posChangeOf(
+          paymentRows.map((row) => row.payment),
+          sale.total,
+        ),
         lines: (await withVariants(tx, lineRows)).map(({ row, variant }) => ({
           ...toSalesLine(row, variant),
           billDiscount: row.billDiscount,
@@ -514,13 +574,19 @@ export class PosSalesService {
             })),
           serialNumbers: row.serialNumbers,
           shortQuantity: row.shortQuantity,
+          returnedQuantity: returnedFor(returned, row.id).quantity,
         })),
-        payments: paymentRows.map((payment) => ({
+        payments: paymentRows.map(({ payment, returnNumber }) => ({
           method: payment.method,
           amount: payment.amount,
           reference: payment.reference,
           accountId: payment.accountId,
+          return:
+            payment.returnId === null || returnNumber === null
+              ? null
+              : { id: payment.returnId, number: returnNumber },
         })),
+        returns,
         device: { id: sale.deviceId, name: header.deviceName },
         entry: entry ?? null,
       };
@@ -615,6 +681,75 @@ export class PosSalesService {
     });
   }
 
+  // Step 20c (decision 38): an exchange payment uses a return saved with this sale, at the same
+  // register and in the same shift, for exactly the return's exchange refund, and no other sale
+  // used it. The device makes both, so any of these is a bug, and one code says it (the database
+  // checks the same at commit: pos_sale_payments_exchange_match). Answers each exchange payment's
+  // account: the one its return's refund went to.
+  private async checkExchange(
+    tx: Transaction,
+    input: PosSaleInput,
+    registerId: string,
+  ): Promise<Map<number, string>> {
+    const wanted = input.payments.flatMap((payment, index) =>
+      payment.method === 'exchange' && payment.returnId !== null
+        ? [{ index, returnId: payment.returnId, amount: payment.amount }]
+        : [],
+    );
+    if (wanted.length === 0) return new Map();
+    const tenantId = getTenantId();
+    const returnIds = wanted.map((payment) => payment.returnId);
+    const found = await tx
+      .select({
+        id: posReturns.id,
+        registerId: posReturns.registerId,
+        shiftId: posReturns.shiftId,
+        amount: posReturnRefunds.amount,
+        accountId: posReturnRefunds.accountId,
+      })
+      .from(posReturns)
+      .leftJoin(
+        posReturnRefunds,
+        and(
+          eq(posReturnRefunds.tenantId, posReturns.tenantId),
+          eq(posReturnRefunds.returnId, posReturns.id),
+          eq(posReturnRefunds.method, 'exchange'),
+        ),
+      )
+      .where(and(eq(posReturns.tenantId, tenantId), inArray(posReturns.id, returnIds)));
+    const used = await tx
+      .select({ returnId: posSalePayments.returnId })
+      .from(posSalePayments)
+      .where(
+        and(eq(posSalePayments.tenantId, tenantId), inArray(posSalePayments.returnId, returnIds)),
+      );
+    const usedIds = new Set(used.map((row) => row.returnId));
+    const accounts = new Map<number, string>();
+    const issues: LineIssue[] = [];
+    for (const payment of wanted) {
+      const path = `payments.${String(payment.index)}.method`;
+      const ret = found.find((row) => row.id === payment.returnId);
+      if (ret === undefined) {
+        issues.push({ path, code: 'pos_return_unknown' });
+        continue;
+      }
+      if (
+        ret.registerId !== registerId ||
+        ret.shiftId !== input.shiftId ||
+        ret.amount === null ||
+        ret.accountId === null ||
+        compareMoney(ret.amount, payment.amount) !== 0 ||
+        usedIds.has(payment.returnId)
+      ) {
+        issues.push({ path, code: 'pos_exchange_invalid' });
+        continue;
+      }
+      accounts.set(payment.index, ret.accountId);
+    }
+    if (issues.length > 0) throw exchangeInvalid(issues);
+    return accounts;
+  }
+
   // Every rule of a goods line that resolveSalesLines() leaves to the stock documents: a batch
   // product names a batch of its own variant, a serial product one serial number per piece in the
   // base unit (resolveLines()'s rules, with the same codes). The device always sends them; a
```

- **`checkExchange()` runs before the accounts are chosen** (decision 38 of 20c.2): the return must exist
  (`pos_return_unknown`), be of this register and this shift, have an exchange refund of exactly this amount, and not
  be used by another sale (`pos_exchange_invalid`). The device makes both documents, so each failure is a bug; the
  database checks the same at commit.
- **The exchange payment's account is the return's refund's** (decision 47), not the register's exchange account of now.
- **The payments' insert catches `pos_sale_payments_return_idx`:** two sales using one return at the same moment, the
  race `checkExchange()` cannot see.
- **The page reads the payments with their return's number** (a left join), the returns of the sale oldest first, and
  each line's `returnedQuantity` from `returnedOf()` (decision 31).
- **`posChangeOf()` gets the payment rows,** now under `row.payment` because of the join.
- **A line keeps the id the device sent** (decision 64), so a return made on the device before this sale arrived points
  at the right line. The spread leaves the id out when it is `null`, and the column's default makes one.

### `pos/pos-shifts.service.ts`: the refunds and the Z report's sums

```diff
@@ -7,7 +7,7 @@ import {
   formatShiftNumber,
   isOverVarianceAlert,
   isZeroMoney,
-  POS_PAYMENT_METHODS,
+  POS_TENDERS,
   type PosCashMovementInput,
   type PosShift,
   type PosShiftCloseInput,
@@ -23,6 +23,8 @@ import {
   posCashMovements,
   posCashReasons,
   posRegisters,
+  posReturnRefunds,
+  posReturns,
   posSalePayments,
   posSales,
   posShifts,
@@ -59,6 +61,7 @@ const cashRowSchema = z.object({
   change_given: z.string(),
   paid_in: z.string(),
   paid_out: z.string(),
+  cash_refunded: z.string(),
   expected: z.string(),
 });
 type ShiftCashRow = z.infer<typeof cashRowSchema>;
@@ -577,6 +580,7 @@ export class PosShiftsService {
                change_given::numeric(19, 4)::text AS change_given,
                paid_in::numeric(19, 4)::text AS paid_in,
                paid_out::numeric(19, 4)::text AS paid_out,
+               cash_refunded::numeric(19, 4)::text AS cash_refunded,
                expected::numeric(19, 4)::text AS expected
           FROM pos_shift_cash(${getTenantId()}::uuid, ${shiftId}::uuid)`),
     );
@@ -678,6 +682,12 @@ export class PosShiftsService {
           WHERE x.tenant_id = ${posShifts.tenantId} AND x.shift_id = ${posShifts.id})`,
         salesTotal: sql<string>`(SELECT coalesce(sum(x.total), 0)::numeric(19, 4)::text FROM pos_sales x
           WHERE x.tenant_id = ${posShifts.tenantId} AND x.shift_id = ${posShifts.id})`,
+        // Step 20c: the returns this shift's drawer paid back, whatever shift sold the goods
+        returnCount: sql<number>`(SELECT count(*)::int FROM pos_returns r
+          WHERE r.tenant_id = ${posShifts.tenantId} AND r.shift_id = ${posShifts.id})`,
+        returnsTotal: sql<string>`(SELECT coalesce(sum(r.total), 0)::numeric(19, 4)::text
+          FROM pos_returns r
+          WHERE r.tenant_id = ${posShifts.tenantId} AND r.shift_id = ${posShifts.id})`,
       })
       .from(posShifts)
       .innerJoin(
@@ -726,6 +736,8 @@ export class PosShiftsService {
             : cashDifferenceOf(shift.countedCash, shift.expectedCash),
         saleCount: row.saleCount,
         salesTotal: row.salesTotal,
+        returnCount: row.returnCount,
+        returnsTotal: row.returnsTotal,
       };
     });
   }
@@ -769,8 +781,8 @@ export class PosShiftsService {
       .where(and(eq(posCashMovements.tenantId, tenantId), eq(posCashMovements.shiftId, id)))
       .orderBy(asc(posCashMovements.movedAt), asc(posCashMovements.id));
 
-    // What the sales took by each method: every method the register takes now, and any other one
-    // a sale of the shift was paid with, in the contract's order (cash first)
+    // What the sales took by each tender: every method the register takes now, and any other
+    // tender a sale of the shift was paid with (an exchange), in the contract's order (cash first)
     const paid = await tx
       .select({
         method: posSalePayments.method,
@@ -787,11 +799,50 @@ export class PosShiftsService {
       .where(and(eq(posSalePayments.tenantId, tenantId), eq(posSales.shiftId, id)))
       .groupBy(posSalePayments.method);
     const paidBy = new Map(paid.map((row) => [row.method, row.amount]));
-    const payments = POS_PAYMENT_METHODS.flatMap((method) => {
-      const amount = paidBy.get(method);
-      if (amount === undefined && accountOf(register, method) === null) return [];
-      return [{ method, amount: amount ?? '0.0000' }];
-    });
+    // Step 20c: and what the returns paid back by each tender, the same way
+    const refunded = await tx
+      .select({
+        method: posReturnRefunds.method,
+        amount: sql<string>`sum(${posReturnRefunds.amount})::text`,
+      })
+      .from(posReturnRefunds)
+      .innerJoin(
+        posReturns,
+        and(
+          eq(posReturns.tenantId, posReturnRefunds.tenantId),
+          eq(posReturns.id, posReturnRefunds.returnId),
+        ),
+      )
+      .where(and(eq(posReturnRefunds.tenantId, tenantId), eq(posReturns.shiftId, id)))
+      .groupBy(posReturnRefunds.method);
+    const refundedBy = new Map(refunded.map((row) => [row.method, row.amount]));
+    // Exchange is never "taken" by a register: shown only when a sale or a return used it
+    const perTender = (amounts: Map<string, string>) =>
+      POS_TENDERS.flatMap((method) => {
+        const amount = amounts.get(method);
+        if (amount === undefined && accountOf(register, method) === null) return [];
+        if (amount === undefined && method === 'exchange') return [];
+        return [{ method, amount: amount ?? '0.0000' }];
+      });
+    // Step 20c, for the Z report: the sales' discounts (each line's and the bill's) and VAT, and
+    // the returns' VAT
+    const [totals] = z
+      .array(
+        z.object({ sales_discount: z.string(), sales_vat: z.string(), returns_vat: z.string() }),
+      )
+      .parse(
+        await tx.execute(sql`
+          SELECT (SELECT coalesce(sum(x.discount + x.bill_discount_amount), 0) FROM pos_sales x
+                   WHERE x.tenant_id = ${tenantId}::uuid AND x.shift_id = ${id}::uuid
+                 )::numeric(19, 4)::text AS sales_discount,
+                 (SELECT coalesce(sum(x.vat), 0) FROM pos_sales x
+                   WHERE x.tenant_id = ${tenantId}::uuid AND x.shift_id = ${id}::uuid
+                 )::numeric(19, 4)::text AS sales_vat,
+                 (SELECT coalesce(sum(r.vat), 0) FROM pos_returns r
+                   WHERE r.tenant_id = ${tenantId}::uuid AND r.shift_id = ${id}::uuid
+                 )::numeric(19, 4)::text AS returns_vat`),
+      );
+    if (!totals) throw new Error(`POS shift ${id} has no totals`);
 
     const reasonIds = shift.floatReasonId === null ? [] : [shift.floatReasonId];
     const [floatReason] =
@@ -847,8 +898,13 @@ export class PosShiftsService {
         changeGiven: cash.change_given,
         paidIn: cash.paid_in,
         paidOut: cash.paid_out,
+        cashRefunded: cash.cash_refunded,
       },
-      payments,
+      payments: perTender(paidBy),
+      refunds: perTender(refundedBy),
+      salesDiscount: totals.sales_discount,
+      salesVat: totals.sales_vat,
+      returnsVat: totals.returns_vat,
       movements: movementRows.map(({ movement, reasonName, entryNumber }) => {
         // A movement's entry is posted the moment it is written (openFromDevice): it has a number
         if (entryNumber === null) throw new Error(`Entry of movement ${movement.id} is a draft`);
```

- **`cash_refunded` is read by name from `pos_shift_cash()`** (decision 41), with its cast to text like the others.
- **The list's row counts the returns of the shift and their total,** by the return's own shift: the drawer that paid
  them back, whatever shift sold the goods.
- **`perTender()` builds the payments and the refunds the same way** (decision 56): every method the register takes,
  and the exchange only when used.
- **The discount, the VAT and the returns' VAT come in one raw query** of three subqueries, parsed with Zod like the cash.
  The discount is the lines' discounts plus the bill's, as the receipt prints them.

### `sync/sync-rows.ts` and `sync/sync.service.ts`: the sales on the device

```diff
@@ -12,6 +12,7 @@ import {
   parties,
   posCashReasons,
   posRegisters,
+  posSales,
   priceLists,
   productCategories,
   products,
@@ -21,7 +22,7 @@ import {
   units,
   warehouses,
 } from '@omnivo/db';
-import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
+import { and, asc, eq, gt, gte, inArray, isNull, type SQL, sql } from 'drizzle-orm';
 import type { PgColumn } from 'drizzle-orm/pg-core';
 import { z } from 'zod';
 
@@ -29,6 +30,7 @@ import type { Transaction } from '../common/tenant/with-tenant.js';
 import { toWarehouse } from '../inventory/warehouses.service.js';
 import { toPosCashReason } from '../pos/pos-cash-reasons.service.js';
 import { lastShiftsOf, toSyncPosRegister } from '../pos/pos-registers.service.js';
+import { posSalesFrom, returnableSalesOf } from '../pos/pos-returnable.js';
 import { productsOf } from '../products/product-read.js';
 import { toUnit } from '../products/units.service.js';
 import { customersOf } from '../sales/customer-read.js';
@@ -41,6 +43,24 @@ export interface SyncScope {
   branchId: string;
   // Its active warehouses: the ones the device keeps, with their stock
   warehouseIds: string[];
+  // Step 20c: the POS register it holds (null = none), whose recent sales it keeps, and the first
+  // day of those (posSalesFrom())
+  registerId: string | null;
+  posSalesFrom: string;
+}
+
+// Step 20c: the POS part of a device's scope. A device holds one register at most
+// (pos_registers_device_idx).
+export async function posScopeOf(
+  tx: Transaction,
+  tenantId: string,
+  deviceId: string,
+): Promise<Pick<SyncScope, 'registerId' | 'posSalesFrom'>> {
+  const [held] = await tx
+    .select({ id: posRegisters.id })
+    .from(posRegisters)
+    .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.deviceId, deviceId)));
+  return { registerId: held?.id ?? null, posSalesFrom: await posSalesFrom(tx) };
 }
 
 // Which rows a loader reads:
@@ -118,6 +138,7 @@ const stockRowSchema = z.object({
 //   pos_register        active, its warehouse in the device's branch (step 20a), with its latest
 //                       shift (step 20b)
 //   pos_cash_reason     active, all of them (step 20b): a reason belongs to no branch
+//   pos_sale            of the register the device holds, from the last 30 days (step 20c)
 export const LOADERS: Record<SyncEntity, Loader> = {
   // One row, keyed by the workspace's id (the contract's settings key)
   settings: async (tx, scope, pick) => {
@@ -430,6 +451,33 @@ export const LOADERS: Record<SyncEntity, Loader> = {
     }));
   },
 
+  // Step 20c (decision 21): the sales of the register this device holds, of the last
+  // POS_SALES_ON_DEVICE_DAYS days, with what came back of each line. 0056 logs a sale with its
+  // warehouse when it is written and again when a return of it is; another device of the branch
+  // finds no row of that key here, and the pull sends it a delete of a row it never had.
+  pos_sale: async (tx, scope, pick) => {
+    if (scope.registerId === null) return [];
+    const { where, limit } = byId(posSales.id, pick);
+    const rows = await tx
+      .select()
+      .from(posSales)
+      .where(
+        and(
+          eq(posSales.tenantId, scope.tenantId),
+          eq(posSales.registerId, scope.registerId),
+          gte(posSales.date, scope.posSalesFrom),
+          where,
+        ),
+      )
+      .orderBy(asc(posSales.id))
+      .limit(limit);
+    const sales = await returnableSalesOf(tx, rows);
+    return sales.map((sale) => ({
+      sort: [sale.id],
+      change: { op: 'upsert', entity: 'pos_sale', key: sale.id, data: sale },
+    }));
+  },
+
   // In keys mode the batch is compared with IS NOT DISTINCT FROM ('-' = no batch = NULL); the
   // stock_balances_key index still finds the rows by warehouse and variant
   stock: async (tx, scope, pick) => {
```

```diff
@@ -15,7 +15,7 @@ import { AppError } from '../common/http/app-error.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
-import { DevicesService } from './devices.service.js';
+import { type DeviceRow, DevicesService } from './devices.service.js';
 import {
   type DeltaCursor,
   decodeSyncCursor,
@@ -24,7 +24,7 @@ import {
   type SyncCursor,
 } from './sync-cursor.js';
 import { SYNC_LOG_DAYS } from './sync-log-cleanup.js';
-import { LOADERS, type SyncScope } from './sync-rows.js';
+import { LOADERS, posScopeOf, type SyncScope } from './sync-rows.js';
 
 const DAY_MS = 24 * 60 * 60 * 1000;
 
@@ -65,7 +65,7 @@ export class SyncService {
     return this.withTenant(async (tx) => {
       const device = await this.devices.forSync(tx, query.deviceId);
       const clock = await readClock(tx);
-      const scope = await this.scopeOf(tx, device.branchId);
+      const scope = await this.scopeOf(tx, device);
 
       const page =
         cursor === undefined || this.restartsFull(cursor, device.branchId, clock.now)
@@ -114,21 +114,23 @@ export class SyncService {
 
   // The device's branch's warehouses. The active ones are what it keeps; all of them, archived
   // too, filter the stock lines of the log (18a.2's facts): a stock row that reaches zero in a
-  // warehouse archived right after must still reach the device as a delete.
+  // warehouse archived right after must still reach the device as a delete. Step 20c: and the
+  // register it holds, for its recent sales.
   private async scopeOf(
     tx: Transaction,
-    branchId: string,
+    device: DeviceRow,
   ): Promise<SyncScope & { allWarehouseIds: string[] }> {
     const tenantId = getTenantId();
     const rows = await tx
       .select({ id: warehouses.id, archivedAt: warehouses.archivedAt })
       .from(warehouses)
-      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.branchId, branchId)));
+      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.branchId, device.branchId)));
     return {
       tenantId,
-      branchId,
+      branchId: device.branchId,
       warehouseIds: rows.filter((row) => row.archivedAt === null).map((row) => row.id),
       allWarehouseIds: rows.map((row) => row.id),
+      ...(await posScopeOf(tx, tenantId, device.id)),
     };
   }
 }
```

- **`posScopeOf()` finds the register the device holds** (one at most, `pos_registers_device_idx`) and the first day
  (decision 46). The pull and the push's answer both use it.
- **The `pos_sale` loader sends nothing to a device that holds no register,** and only that register's sales of the
  last 30 days. In keys mode a key of another register, or an older sale, is "not in the scope", and the pull sends a
  delete the device ignores.
- **`scopeOf()` takes the device row now,** not only its branch: the register is found by the device's id.

### `sync/sync-push.service.ts`: the return command

```diff
@@ -17,7 +17,7 @@ import {
   type SyncResult,
   syncCommandSchema,
 } from '@omnivo/contracts';
-import { syncCommands } from '@omnivo/db';
+import { posReturns, syncCommands } from '@omnivo/db';
 import { and, eq, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
@@ -26,13 +26,14 @@ import { AppError } from '../common/http/app-error.js';
 import { getTenantId, runFromDevice } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
+import { PosReturnsService } from '../pos/pos-returns.service.js';
 import { PosSalesService } from '../pos/pos-sales.service.js';
 import { PosShiftsService } from '../pos/pos-shifts.service.js';
 import { type Access, PermissionService } from '../rbac/permission.service.js';
 import { CustomersService } from '../sales/customers.service.js';
 import { SalesOrdersService } from '../sales/sales-orders.service.js';
 import { type DeviceRow, DevicesService } from './devices.service.js';
-import { LOADERS } from './sync-rows.js';
+import { LOADERS, posScopeOf } from './sync-rows.js';
 
 type PushedCommand = z.output<typeof syncPushInputSchema>['commands'][number];
 type StoredAnswer = typeof syncCommands.$inferSelect;
@@ -50,16 +51,19 @@ const PERMISSION_OF = {
   'pos_shift.open': routes.pos.claimRegister.permission,
   'pos_cash_movement.create': routes.pos.claimRegister.permission,
   'pos_shift.close': routes.pos.claimRegister.permission,
+  // Step 20c: the permission that finds a sale to take back (decision 30)
+  'pos_return.create': routes.posReturns.returnableSale.permission,
 } satisfies Record<SyncCommandType, PermissionKey>;
 
 // Step 20a (decision 28), step 20b (decision 25): never refused for the permission. The money is
 // in the drawer (and the goods have left), so a refusal would only leave it out of the books; each
-// writes its own audit row instead.
+// writes its own audit row instead. Step 20c (decision 20): a return too, whose money was paid back.
 const DONE_AT_THE_COUNTER: ReadonlySet<SyncCommandType> = new Set([
   'pos_sale.create',
   'pos_shift.open',
   'pos_cash_movement.create',
   'pos_shift.close',
+  'pos_return.create',
 ]);
 
 // The ids a device makes (decision 12). One already used — in this workspace or another, the
@@ -69,16 +73,18 @@ const DEVICE_ID_KEYS = [
   'party_addresses_pkey',
   'sales_orders_pkey',
   'pos_sales_pkey',
+  'pos_sale_lines_pkey',
   'pos_shifts_pkey',
   'pos_cash_movements_pkey',
+  'pos_returns_pkey',
 ] as const;
 
 function isSyncCommandType(type: string): type is SyncCommandType {
   return SYNC_COMMAND_TYPES.some((known) => known === type);
 }
 
-// The customer, the order, the POS sale, the shift or the pay in / pay out a command is about:
-// the answer's entity_id
+// The customer, the order, the POS sale, the shift, the pay in / pay out or the POS return a
+// command is about: the answer's entity_id
 function entityOf(command: SyncCommand): string {
   switch (command.type) {
     case 'sales_order.create_draft':
@@ -90,6 +96,8 @@ function entityOf(command: SyncCommand): string {
       return command.shiftId;
     case 'pos_cash_movement.create':
       return command.movementId;
+    case 'pos_return.create':
+      return command.returnId;
     case 'customer.create':
     case 'customer.update':
       return command.customerId;
@@ -114,6 +122,7 @@ export class SyncPushService {
     private readonly orders: SalesOrdersService,
     private readonly posSales: PosSalesService,
     private readonly posShifts: PosShiftsService,
+    private readonly posReturns: PosReturnsService,
   ) {}
 
   async push(input: z.output<typeof syncPushInputSchema>): Promise<SyncPush> {
@@ -170,8 +179,12 @@ export class SyncPushService {
       } catch (error) {
         const refusal = refusalOf(error);
         if (refusal === null) throw error;
-        // Step 20a (decision 37): the refused sale's receipt was printed, so its number stays used
+        // Step 20a (decision 37): the refused sale's receipt was printed, so its number stays used.
+        // Step 20c (decision 43): a refused return's slip too.
         if (command.type === 'pos_sale.create') await this.posSales.keepNumber(tx, command.input);
+        if (command.type === 'pos_return.create') {
+          await this.posReturns.keepNumber(tx, command.input);
+        }
         await tx.insert(syncCommands).values({
           ...this.answerKey(device, command),
           status: 'rejected',
@@ -226,6 +239,9 @@ export class SyncPushService {
       case 'pos_shift.close':
         await this.posShifts.closeFromDevice(tx, access, command.shiftId, command.input);
         return [];
+      case 'pos_return.create':
+        await this.posReturns.createFromDevice(tx, access, command.returnId, command.input);
+        return [];
     }
   }
 
@@ -260,21 +276,47 @@ export class SyncPushService {
 
   // The customer a command made or changed, in the pull's shape: the device writes it at once. A
   // customer the device may not keep (archived since) goes as a delete, like in a delta pull. An
-  // order, a POS sale and a shift's commands send nothing: none is on the device as a row
-  // (decision 35; step 20b, decision 30: the register's new lastShift comes with the next pull).
+  // order and a shift's commands send nothing: neither is on the device as a row (decision 35;
+  // step 20b, decision 30: the register's new lastShift comes with the next pull). Step 20c
+  // (decision 23): a POS sale or return sends the sale's pos_sale row, so the return screen knows
+  // at once what is left of it; a sale the device does not keep (another register's, or older than
+  // its days) goes as a delete, which it ignores.
   private async changesOf(
     tx: Transaction,
     device: DeviceRow,
     type: SyncCommandType,
     entityId: string,
   ): Promise<SyncChange[]> {
+    const tenantId = getTenantId();
+    // The customer loader reads only the tenant, the sale loader the register the device holds:
+    // the branch's warehouses matter to neither
+    const scope = {
+      tenantId,
+      branchId: device.branchId,
+      warehouseIds: [],
+      ...(await posScopeOf(tx, tenantId, device.id)),
+    };
+    if (type === 'pos_sale.create' || type === 'pos_return.create') {
+      const saleId = type === 'pos_sale.create' ? entityId : await this.saleOfReturn(tx, entityId);
+      if (saleId === null) return [];
+      const rows = await LOADERS.pos_sale(tx, scope, { by: 'keys', keys: [saleId] });
+      if (rows.length === 0) return [{ op: 'delete', entity: 'pos_sale', key: saleId }];
+      return rows.map((row) => row.change);
+    }
     if (type !== 'customer.create' && type !== 'customer.update') return [];
-    // The customer loader reads only the tenant; the branch's warehouses do not matter to it
-    const scope = { tenantId: getTenantId(), branchId: device.branchId, warehouseIds: [] };
     const rows = await LOADERS.customer(tx, scope, { by: 'keys', keys: [entityId] });
     if (rows.length === 0) return [{ op: 'delete', entity: 'customer', key: entityId }];
     return rows.map((row) => row.change);
   }
+
+  // An accepted return is there for good (0056 keeps it): null only for a bug
+  private async saleOfReturn(tx: Transaction, returnId: string): Promise<string | null> {
+    const [row] = await tx
+      .select({ saleId: posReturns.saleId })
+      .from(posReturns)
+      .where(and(eq(posReturns.tenantId, getTenantId()), eq(posReturns.id, returnId)));
+    return row?.saleId ?? null;
+  }
 }
 
 function refused(id: string, error: SyncCommandError): SyncResult {
```

- **The command's permission is the route's that finds a sale to take back** (`pos.return.create`), read from the
  contract like the others, and it is in `DONE_AT_THE_COUNTER`: never refused for it (decision 20).
- **`pos_returns_pkey` is a device-made id,** so a used one is `sync_id_taken`. **So is `pos_sale_lines_pkey`**
  (decision 64): a line id used twice is a bug of the device, refused like any id it made, and the sale keeps its number.
  Without it, the insert's error would fail the whole push with a 500, and the outbox would send it again for ever.
- **A refused return keeps its number** (decision 43), like a refused sale.
- **An accepted sale or return answers with the sale's `pos_sale` row** (decision 23). A return's answer is stored by
  the return's id, so `saleOfReturn()` finds its sale when the answer is sent again.

### `accounts/accounts.service.ts` and `setup/templates.ts`

```diff
@@ -366,7 +366,7 @@ export class AccountsService {
       // Money receipts and refunds name it too (steps 15c, 15d), though each one's entry already does,
       // and so do a bill's lines and expenses and a supplier payment (step 17c), even as a draft,
       // and a supplier refund (step 17d), and a POS register's method and a POS sale's payment
-      // (step 20a)
+      // (step 20a), and a register's exchange account and a POS return's refund (step 20c)
       if (
         isForeignKeyViolation(error, 'journal_lines_account_fk') ||
         isForeignKeyViolation(error, 'receipts_account_fk') ||
@@ -382,7 +382,9 @@ export class AccountsService {
         isForeignKeyViolation(error, 'pos_sale_payments_account_fk') ||
         isForeignKeyViolation(error, 'pos_registers_over_short_account_fk') ||
         isForeignKeyViolation(error, 'pos_cash_reasons_account_fk') ||
-        isForeignKeyViolation(error, 'pos_cash_movements_account_fk')
+        isForeignKeyViolation(error, 'pos_cash_movements_account_fk') ||
+        isForeignKeyViolation(error, 'pos_registers_exchange_account_fk') ||
+        isForeignKeyViolation(error, 'pos_return_refunds_account_fk')
       ) {
         throw new AppError(409, 'account_in_use', 'Archive this account instead: entries use it.');
       }
```

- **Two new foreign keys point at an account:** the register's exchange account and a return's refund. Deleting an
  account they use answers `account_in_use`, like the other POS accounts.

```diff
@@ -170,6 +170,10 @@ const TAKING_REFUNDS = ['purchase.refund.manage'] as const;
 const SELLING_AT_COUNTER = ['pos.sale.create'] as const;
 // Step 20b: they also read every counter's shifts and close one nobody can close
 const RUNNING_COUNTERS = ['pos.register.manage', 'pos.price.override', 'pos.shift.manage'] as const;
+// Step 20c: the cashier who sold takes goods back at the counter and pays the money back from the
+// drawer, like a sale the other way round. A shop that wants only its manager to take goods back
+// takes it off the Cashier role in Settings → Roles.
+const TAKING_BACK_AT_COUNTER = ['pos.return.create'] as const;
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
@@ -720,17 +724,21 @@ export const INDUSTRY_TEMPLATES = {
           ...TAKING_REFUNDS,
           ...SELLING_AT_COUNTER,
           ...RUNNING_COUNTERS,
+          ...TAKING_BACK_AT_COUNTER,
         ],
       },
       {
         name: 'Cashier',
         description: 'Sells at the counter',
-        permissions: [...COLLECTING, ...SELLING_AT_COUNTER],
+        permissions: [...COLLECTING, ...SELLING_AT_COUNTER, ...TAKING_BACK_AT_COUNTER],
       },
     ],
     chart: standardChart({
       stock: TRADER_STOCK,
       currentAssets: [account('1180', 'Card and wallet settlements receivable')],
+      // Step 20c: what a POS return's exchange passes through on its way to the new sale (a
+      // register's exchange account, Settings → POS). Always back at zero once both are posted.
+      currentLiabilities: [account('2190', 'POS exchange clearing')],
       revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Sales returns')],
       costOfSales: [COGS],
       selling: [
```

- **The Cashier and the Shop manager take goods back** (`pos.return.create`): the person who sold pays the money back
  from the same drawer. A shop that wants only its manager to do it takes the permission off the Cashier role.
- **Retail gets "2190 POS exchange clearing"** under current liabilities (decision 6). Only new workspaces get it; an
  old one adds the account and picks it on its registers, or makes no exchanges.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts gen:openapi
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src packages/contracts/src
pnpm --filter @omnivo/api test
```

The build and the OpenAPI document come first because this part adds a route to the contract (decision 45). The API
package has no `lint` script of its own (`pnpm --filter @omnivo/api lint` would do nothing and still pass), so ESLint
runs directly on the two folders; the whole `pnpm lint` waits for the packages that still fail. All pass
(API 123 unit tests). The API's integration suites are 20c.4's, and two of their old checks fail until then, on
purpose: the shift page's cash now has `cashRefunded`, and an accepted sale now answers with its `pos_sale` row.
`packages/sync` and `apps/app` still fail to type check until 20c.5 to 20c.7.

> **What was checked while building it.** Besides the commands above: the POS, sync and device integration suites with
> the old tests' register forms given the two new fields (157 of 159 pass, the two above), and a temporary end-to-end
> test of a return, an exchange (the clearing account back at zero), an over-return after the window (four audit rows),
> a refused card refund that keeps its number, the shift's page, the sale's page, the list, the return's page and the
> register's recent sales in two pages. The setup, accounts and sales return suites pass, and `pnpm boundaries` finds
> no violation. Batch and serial returns are 20c.4's tests.

## 20c.4 — `apps/api`: the tests

One new integration test file, and the three POS suites of 20a and 20b:

- `pos/pos-returns.int.spec.ts` (new): the template's account and permission, a register's return settings, the receipt
  found by its number, the returns of one front counter (money, batches, serial numbers, refunds by method, the window,
  the refusals, the list), the exchange, another branch's receipt, the shift, the pull, two counters at the same moment,
  and what a return points at.
- `pos/pos.int.spec.ts` and `pos/pos-shifts.int.spec.ts`: two old checks that the new answers changed.
- `pos/pos.tenant-leak.int.spec.ts`: one shop never sees, finds or uses another shop's returns.

The tests found no problem in the 20c.3 code; the code above is what they ran against.

### The suites of 20a and 20b: what the new answers changed

```diff
@@ -275,6 +275,9 @@ function registerForm(code: string, warehouse: Warehouse, extra: object = {}) {
     overShortAccountId: accountId('5350'),
     varianceAlert: '500',
     lockAfter: '5',
+    // Step 20c: no exchanges, and the form's 7 days
+    exchangeAccountId: '',
+    returnDays: '7',
     ...extra,
   };
 }
@@ -300,6 +303,8 @@ function editForm(register: PosRegister, extra: object = {}) {
     overShortAccountId: register.overShortAccountId ?? '',
     varianceAlert: register.varianceAlert,
     lockAfter: register.lockAfter,
+    exchangeAccountId: register.exchangeAccountId ?? '',
+    returnDays: String(register.returnDays),
     version: register.version,
     ...extra,
   };
@@ -1022,8 +1027,26 @@ describe('a sale pushed from the counter', () => {
       [paid('cash', '100'), paid('cash', '100')],
     );
     const [result] = await push([command]);
-    // Nothing for the device to write: sales are not on the device
-    expect(result).toEqual({ id: command.id, status: 'accepted', notices: [], changes: [] });
+    // Step 20c: the device keeps its register's recent sales, so the answer brings the new one at
+    // once, with nothing taken back yet
+    expect(result).toMatchObject({ id: command.id, status: 'accepted', notices: [] });
+    const changes = result?.status === 'accepted' ? result.changes : [];
+    expect(changes).toMatchObject([
+      {
+        op: 'upsert',
+        entity: 'pos_sale',
+        key: command.saleId,
+        data: {
+          number: numberOf(command, 'POS1'),
+          total: '115.0000',
+          lines: [{ returnedQuantity: '0.0000' }, { returnedQuantity: '0.0000' }],
+          payments: [
+            { method: 'cash', amount: '100.0000' },
+            { method: 'cash', amount: '100.0000' },
+          ],
+        },
+      },
+    ]);
     const done = await saleNow(command.saleId);
     expect(done).toMatchObject({
       number: numberOf(command, 'POS1'),
@@ -1042,9 +1065,11 @@ describe('a sale pushed from the counter', () => {
       soldShort: false,
       device: { id: counterPc.id, name: 'Front counter PC' },
     });
+    // Step 20c: `return` names the return an exchange payment used; a ৳100 note uses none
+    const hundred = { method: 'cash', amount: '100.0000', reference: null, return: null };
     expect(done.payments).toEqual([
-      { method: 'cash', amount: '100.0000', reference: null, accountId: accountId('1110') },
-      { method: 'cash', amount: '100.0000', reference: null, accountId: accountId('1110') },
+      { ...hundred, accountId: accountId('1110') },
+      { ...hundred, accountId: accountId('1110') },
     ]);
     expect(done.lines.map((item) => [item.total, item.shortQuantity, item.batches])).toEqual([
       ['57.5000', '0.0000', []],
```

- **An accepted sale's answer now has a change:** the device keeps its register's recent sales (decision 23), so the
  push answers with the sale's `pos_sale` row, with nothing taken back of either line. `toMatchObject()` checks the
  parts that matter and leaves the rest of the row (the item's names, the units) to the contract's schema.
- **A sale's payment has `return: null`.** Only an exchange payment names a return. The two ৳100 notes share one
  object, so the check says what is the same and what is not (the account).

```diff
@@ -210,6 +210,9 @@ function registerForm(code: string, extra: object = {}) {
     overShortAccountId: accountId('5350'),
     varianceAlert: '500',
     lockAfter: '5',
+    // Step 20c: no exchanges, and the form's 7 days
+    exchangeAccountId: '',
+    returnDays: '7',
     ...extra,
   };
 }
@@ -924,6 +927,8 @@ describe('A shift at the front counter', () => {
       changeGiven: '0.0000',
       paidIn: '500.0000',
       paidOut: '3200.0000',
+      // Step 20c: what returns paid back in cash
+      cashRefunded: '0.0000',
     });
     expect(shift.expectedCash).toBe('2300.0000');
     // A pay in brings cash in from the reason's account; a pay out the other way
@@ -1428,6 +1433,8 @@ describe('What a shift posts', () => {
       overShortAccountId: spare.id,
       varianceAlert: now.varianceAlert,
       lockAfter: now.lockAfter,
+      exchangeAccountId: now.exchangeAccountId ?? '',
+      returnDays: String(now.returnDays),
       version: now.version,
     });
     expect(edited.statusCode, edited.body).toBe(200);
```

- **The shift's cash has `cashRefunded`.** No return was made in that shift, so it is `0.0000`, and the expected cash
  is the same as before. `toEqual()` is kept on purpose: a new field in the cash should fail this test, so someone
  checks that the expected cash still adds up.

### `pos/pos-returns.int.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  addMoney,
  auditPageSchema,
  type Branch,
  branchSchema,
  type Customer,
  customerSchema,
  type Device,
  deviceSchema,
  type EntryRef,
  journalEntrySchema,
  memberPageSchema,
  type PosCashReason,
  posCashReasonSchema,
  type PosRegister,
  posRegisterSalesPageSchema,
  posRegisterSchema,
  type PosReturn,
  type PosReturnableSale,
  posReturnableSaleSchema,
  posReturnAmounts,
  posReturnPageSchema,
  posReturnSchema,
  type PosSale,
  type PosSaleLine,
  posSaleSchema,
  type PosShift,
  posShiftSchema,
  problemSchema,
  type Product,
  productSchema,
  roleListSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  sumMoney,
  SYNC_PROTOCOL,
  type SyncCommandInput,
  type SyncResult,
  syncPullSchema,
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
import { z } from 'zod';

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

// Step 20c. Agora Mini Mart again, with a second shop in Uttara. Nusrat (the owner) runs the front
// counter (POS1), Sumi the pharmacy counter (POS2, cash only, returns on the day of the sale only)
// and the Uttara counter (UTT1) takes back receipts of either shop. Rafiq is a member with no role.
// The tests run in order: the setup and the registers, then the returns of the front counter, the
// exchange, the other branch, the shift, the pull, and what happens at the same moment.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the batches, the serial numbers and the clearing account's balance, which no
// route shows this way, and the immutable rows
let sql: postgres.Sql;
let owner: SignedIn;
let sumi: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let uttara: Branch;
let uttaraStore: Warehouse;
let accounts: Account[];
let vat: TaxRate;
let pcs: string;
let juice: Product;
let napa: Product;
let phone: Product;
let wrap: Product;
let farhana: Customer;
let counterPc: Device;
let sumiTablet: Device;
let uttaraPc: Device;
let officeLaptop: Device;
let floatIn: PosCashReason;
let pos1: PosRegister;
let pos2: PosRegister;
let utt1: PosRegister;
// The open shift of each counter
let shift1: string;
let shift2: string;
let shiftU: string;
// The front counter's first sale: two juices and a gift wrapping, for Farhana
let saleA: PosSale;
// Two phones, IMEI-1 and IMEI-2, paid by card
let phones: PosSale;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type Payment = SaleCommand['input']['payments'][number];
type ReturnCommand = Extract<SyncCommandInput, { type: 'pos_return.create' }>;
type ReturnLine = ReturnCommand['input']['lines'][number];
type Refund = ReturnCommand['input']['refunds'][number];
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;
type Command = SaleCommand | ReturnCommand | OpenCommand;
// What a return line needs of its sale line, from the sale's page or the return screen's copy
type SoldLine = Pick<PosSaleLine, 'id' | 'quantity' | 'net' | 'vat' | 'returnedQuantity'>;

// A UUIDv7 as a device makes it: the time first, so an id made later sorts later. The lists of
// returns break a tie of dates by the id, and the tests read them in the order they were made.
let idClock = Date.now();
function v7(): string {
  idClock += 1;
  const time = idClock.toString(16).padStart(12, '0');
  const random = randomUUID().replaceAll('-', '');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(13, 16)}-${random.slice(16, 20)}-${random.slice(20)}`;
}

// The device's clock, one second later at every command: the lists are by date and time
let clock = Date.now();
function moment(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

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

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
}

// The branch's code, so an entry line reads "DHN" or "UTT"
function branchCodeOf(id: string | null): string {
  if (id === main.branchId) return 'DHN';
  if (id === uttara.id) return 'UTT';
  return String(id);
}

async function member(fullName: string, email: string, password: string): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: `${email.split('@')[0] ?? 'member'}-store`,
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'agora-mini-mart' });
  return logIn(app, { workspace: 'agora-mini-mart', email, password, keepSignedIn: false });
}

async function giveRoles(email: string, roleNames: string[]): Promise<void> {
  const roles = roleListSchema.parse((await send('GET', '/roles')).json()).items;
  const roleIds = roleNames.map((name) => {
    const role = roles.find((item) => item.name === name);
    if (!role) throw new Error(`no role ${name}`);
    return role.id;
  });
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const res = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds,
    version: found.version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function registerDevice(name: string, branchId: string, as = owner): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function addProduct(
  name: string,
  salePrice: string,
  extra: { type?: string; tracking?: string; hasExpiry?: boolean } = {},
): Promise<Product> {
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
    ...extra,
  });
}

function inLine(product: Product, quantity: string, unitCost: string, extra: object = {}) {
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
    ...extra,
  };
}

function registerForm(code: string, extra: object = {}) {
  return {
    code,
    name: `Counter ${code}`,
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
    ...extra,
  };
}

function editForm(register: PosRegister, extra: object = {}) {
  return {
    name: register.name,
    warehouseId: register.warehouseId,
    accounts: {
      cash: register.accounts.cash,
      card: register.accounts.card ?? '',
      bkash: register.accounts.bkash ?? '',
      nagad: register.accounts.nagad ?? '',
    },
    maxDiscountPercent: register.maxDiscountPercent,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter ?? '',
    overShortAccountId: register.overShortAccountId ?? '',
    varianceAlert: register.varianceAlert,
    lockAfter: register.lockAfter,
    exchangeAccountId: register.exchangeAccountId ?? '',
    returnDays: String(register.returnDays),
    version: register.version,
    ...extra,
  };
}

async function registerNow(register: PosRegister): Promise<PosRegister> {
  const res = await send('GET', `/pos/registers/${register.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

// The last sale and the last return number each register gave, as its device keeps them
const sequences = new Map<string, number>();
const returnSequences = new Map<string, number>();

async function claimed(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await send(
    'POST',
    `/pos/registers/${register.id}/claim`,
    { deviceId: device.id },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  const held = posRegisterSchema.parse(res.json());
  sequences.set(held.id, held.lastNumber);
  returnSequences.set(held.id, held.lastReturnNumber);
  return held;
}

// The register's first shift, ৳1,000 from the owner
function open(register: PosRegister): OpenCommand {
  return {
    id: v7(),
    type: 'pos_shift.open',
    shiftId: v7(),
    input: {
      registerId: register.id,
      sequence: 1,
      date: today,
      openedAt: moment(),
      opening: { notes: null, total: '1000' },
      floatReasonId: floatIn.id,
    },
  };
}

// A line at its shelf price, 15% VAT
function line(
  product: Product,
  quantity: string,
  price: string,
  extra: Partial<SaleLine> = {},
): SaleLine {
  return {
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
    ...extra,
  };
}

function paid(method: Payment['method'], amount: string, reference = ''): Payment {
  return { method, amount, reference };
}

// A sale with the register's next number, today, to a walk-in
function sale(
  register: PosRegister,
  shiftId: string | null,
  lines: SaleLine[],
  payments: Payment[],
  extra: Partial<SaleCommand['input']> = {},
): SaleCommand {
  const sequence = (sequences.get(register.id) ?? 0) + 1;
  sequences.set(register.id, sequence);
  return {
    id: v7(),
    type: 'pos_sale.create',
    saleId: v7(),
    input: {
      registerId: register.id,
      sequence,
      shiftId,
      date: today,
      soldAt: moment(),
      customerId: '',
      pricesIncludeVat: false,
      lines,
      billDiscountType: 'amount',
      billDiscount: '0',
      payments,
      ...extra,
    },
  };
}

// A return line as the device works it out: its share of the sale line's money, from what the
// device knows came back before (the line's returnedQuantity, or more for a return after another
// one in the same outbox)
function back(sold: SoldLine, quantity: string, extra: Partial<ReturnLine> = {}): ReturnLine {
  const amounts = posReturnAmounts(sold, quantity);
  return {
    saleLineId: sold.id,
    quantity,
    net: amounts.net,
    vat: amounts.vat,
    serialNumbers: [],
    ...extra,
  };
}

// What the lines pay back together
function totalOf(lines: readonly ReturnLine[]): string {
  return sumMoney(lines.map((item) => addMoney(item.net, item.vat)));
}

function cashBack(lines: readonly ReturnLine[]): Refund[] {
  return [{ method: 'cash', amount: totalOf(lines), reference: '' }];
}

// A return with the register's next return number, today
function giveBack(
  register: PosRegister,
  shiftId: string,
  saleId: string,
  lines: ReturnLine[],
  refunds: Refund[],
  extra: Partial<ReturnCommand['input']> = {},
): ReturnCommand {
  const sequence = (returnSequences.get(register.id) ?? 0) + 1;
  returnSequences.set(register.id, sequence);
  return {
    id: v7(),
    type: 'pos_return.create',
    returnId: v7(),
    input: {
      registerId: register.id,
      sequence,
      shiftId,
      date: today,
      returnedAt: moment(),
      saleId,
      lines,
      refunds,
      note: '',
      ...extra,
    },
  };
}

async function push(commands: Command[], device = counterPc, as = owner): Promise<SyncResult[]> {
  const res = await send(
    'POST',
    '/sync/push',
    { deviceId: device.id, protocol: SYNC_PROTOCOL, commands },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return syncPushSchema.parse(res.json()).results;
}

function outcomes(results: SyncResult[]): string[] {
  return results.map((result) =>
    result.status === 'rejected' ? result.error.code : result.status,
  );
}

function refusal(result: SyncResult | undefined) {
  if (result?.status !== 'rejected') throw new Error(`not refused: ${JSON.stringify(result)}`);
  return result.error;
}

async function accepted(commands: Command[], device = counterPc, as = owner): Promise<void> {
  const results = await push(commands, device, as);
  expect(outcomes(results), JSON.stringify(results)).toEqual(commands.map(() => 'accepted'));
}

async function saleNow(id: string): Promise<PosSale> {
  const res = await send('GET', `/pos/sales/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posSaleSchema.parse(res.json());
}

// One sale, pushed alone, that must be accepted
async function sold(command: SaleCommand, device = counterPc, as = owner): Promise<PosSale> {
  await accepted([command], device, as);
  return saleNow(command.saleId);
}

async function returnNow(id: string): Promise<PosReturn> {
  const res = await send('GET', `/pos/returns/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posReturnSchema.parse(res.json());
}

async function returnable(number: string, as = owner): Promise<PosReturnableSale> {
  const res = await send('GET', `/pos/sales/by-number/${number}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return posReturnableSaleSchema.parse(res.json());
}

async function shiftNow(id: string): Promise<PosShift> {
  const res = await send('GET', `/pos/shifts/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posShiftSchema.parse(res.json());
}

function lineOf<T>(lines: readonly T[], at: number): T {
  const found = lines[at];
  if (found === undefined) throw new Error(`no line ${String(at + 1)}`);
  return found;
}

// An entry as [account code, debit, credit, branch], by code: what an accountant reads
async function entryLines(entry: EntryRef | null) {
  if (entry === null) throw new Error('no entry');
  const res = await send('GET', `/journal-entries/${entry.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return journalEntrySchema
    .parse(res.json())
    .lines.map((item) => [
      codeOf(item.accountId),
      item.debit,
      item.credit,
      branchCodeOf(item.branchId),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  // Oldest first, as the tests tell the story
  return auditPageSchema.parse(res.json()).items.reverse();
}

const quantityRows = z.array(z.object({ quantity: z.string() }));

// The stock of a variant in a warehouse now, every batch together
async function onHand(warehouse: Warehouse, product: Product): Promise<string> {
  const [row] = quantityRows.parse(
    await sql`SELECT coalesce(sum(quantity), 0)::numeric(18, 4)::text AS quantity
                FROM stock_balances
                WHERE warehouse_id = ${warehouse.id} AND variant_id = ${variantOf(product)}`,
  );
  return row?.quantity ?? '0';
}

// A batch's id, by its lot number
async function lotId(lotNumber: string): Promise<string> {
  const [row] = z
    .array(z.object({ id: z.string() }))
    .parse(await sql`SELECT id::text FROM batches WHERE lot_number = ${lotNumber}`);
  if (!row) throw new Error(`no batch ${lotNumber}`);
  return row.id;
}

// The stock of one batch, by its lot number, in the front counter's store
async function lotStock(lotNumber: string): Promise<string> {
  const [row] = quantityRows.parse(
    await sql`SELECT coalesce(sum(s.quantity), 0)::numeric(18, 4)::text AS quantity
                FROM stock_balances s JOIN batches b ON b.id = s.batch_id
                WHERE s.warehouse_id = ${main.id} AND b.lot_number = ${lotNumber}`,
  );
  return row?.quantity ?? '0';
}

// Where a serial number is now: the warehouse's code, or null when it is out of every one
async function serialAt(serialNumber: string): Promise<string | null | undefined> {
  const [row] = z.array(z.object({ code: z.string().nullable() })).parse(
    await sql`SELECT w.code FROM serials s LEFT JOIN warehouses w ON w.id = s.warehouse_id
                  WHERE s.serial_number = ${serialNumber}`,
  );
  return row?.code;
}

// What the books hold on an account, debit less credit
async function balanceOf(code: string): Promise<string> {
  const [row] = z.array(z.object({ balance: z.string() })).parse(
    await sql`SELECT coalesce(sum(debit - credit), 0)::numeric(18, 4)::text AS balance
                  FROM journal_lines WHERE account_id = ${accountId(code)}`,
  );
  return row?.balance ?? '0';
}

// One page is the whole pull: a new workspace has a few hundred rows at most
async function pulled(device: Device, as = owner, cursor?: string) {
  const query = new URLSearchParams({
    deviceId: device.id,
    protocol: String(SYNC_PROTOCOL),
    limit: '1000',
  });
  if (cursor !== undefined) query.set('cursor', cursor);
  const res = await send('GET', `/sync/pull?${query.toString()}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  const page = syncPullSchema.parse(res.json());
  expect(page.hasMore).toBe(false);
  return page;
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
    companyName: 'Agora Mini Mart',
    workspaceSlug: 'agora-mini-mart',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@agoramart.com',
    password: 'Dhanmondi-shop-2026',
  });
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);

  sumi = await member('Sumi Akter', 'sumi@agoramart.com', 'Counter-two-2026');
  rafiq = await member('Rafiq Islam', 'rafiq@agoramart.com', 'No-role-yet-2026');
  await giveRoles('sumi@agoramart.com', ['Cashier']);

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

  // The card machine's bank account, under the bank group
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await created(accountSchema, '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'City Bank card settlement',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;

  const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const fifteen = rates.find((rate) => rate.name === 'VAT 15%');
  if (!fifteen) throw new Error('no VAT 15%');
  vat = fifteen;
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';
  juice = await addProduct('Mango juice 250 ml', '25');
  napa = await addProduct('Napa 500 mg strip', '30', { tracking: 'batch', hasExpiry: true });
  phone = await addProduct('Walton Primo phone', '15000', { tracking: 'serial' });
  wrap = await addProduct('Gift wrapping', '50', { type: 'service' });
  const stocked = await send('POST', '/stock-adjustments', {
    date: shiftIsoDate(today, -40),
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines: [
      inLine(juice, '50', '15'),
      inLine(napa, '3', '20', { lotNumber: 'NP-A', expiresOn: shiftIsoDate(today, 200) }),
      inLine(napa, '5', '20', { lotNumber: 'NP-B', expiresOn: shiftIsoDate(today, 90) }),
      inLine(phone, '3', '9000', { serialNumbers: ['IMEI-1', 'IMEI-2', 'IMEI-3'] }),
    ],
    post: true,
  });
  expect(stocked.statusCode, stocked.body).toBe(201);
  farhana = await created(customerSchema, '/customers', {
    code: '',
    name: 'Farhana Akter',
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
  floatIn = await created(posCashReasonSchema, '/pos/cash-reasons', {
    name: 'Float from the owner',
    direction: 'in',
    accountId: accountId('3100'),
  });

  counterPc = await registerDevice('Front counter PC', main.branchId);
  sumiTablet = await registerDevice('Pharmacy tablet', main.branchId, sumi);
  uttaraPc = await registerDevice('Uttara counter PC', uttara.id);
  officeLaptop = await registerDevice('Back office laptop', main.branchId);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('A new retail workspace', () => {
  it('has an exchange clearing account, and cashiers who take goods back', async () => {
    const clearing = accounts.find((account) => account.code === '2190');
    expect(clearing).toMatchObject({
      name: 'POS exchange clearing',
      type: 'liability',
      isGroup: false,
      parentId: accountId('2100'),
    });
    const roles = roleListSchema.parse((await send('GET', '/roles')).json()).items;
    const holders = roles
      .filter((role) => role.permissions.includes('pos.return.create'))
      .map((role) => role.name)
      .sort();
    expect(holders).toEqual(['Cashier', 'Owner', 'Shop manager']);
  });
});

describe("A register's return settings", () => {
  it('are an exchange account that is a liability, and 0 to 365 days', async () => {
    pos1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS1', {
        name: 'Front counter',
        accounts: { cash: accountId('1110'), card: accountId('1121'), bkash: '', nagad: '' },
        exchangeAccountId: accountId('2190'),
      }),
    );
    expect(pos1).toMatchObject({
      exchangeAccountId: accountId('2190'),
      returnDays: 7,
      lastReturnNumber: 0,
    });
    // The pharmacy counter: no exchanges, and a return on the day of the sale only
    pos2 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS2', { name: 'Pharmacy counter' }),
    );
    expect(pos2).toMatchObject({ exchangeAccountId: null, returnDays: 7 });
    const edited = await send(
      'PUT',
      `/pos/registers/${pos2.id}`,
      editForm(pos2, { returnDays: '0' }),
    );
    expect(edited.statusCode, edited.body).toBe(200);
    pos2 = posRegisterSchema.parse(edited.json());
    expect(pos2.returnDays).toBe(0);
    const [change] = (await auditOf('pos_register', pos2.id)).filter(
      (row) => row.action === 'pos_register.updated',
    );
    expect(change?.changes).toEqual({ returnDays: { from: '7', to: '0' } });
    utt1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('UTT1', {
        name: 'Uttara counter',
        warehouseId: uttaraStore.id,
        exchangeAccountId: accountId('2190'),
      }),
    );

    // The cash account is an asset, and 2100 a group: neither can hold the money of an exchange
    for (const code of ['1110', '2100']) {
      const res = await send(
        'POST',
        '/pos/registers',
        registerForm('POS9', { exchangeAccountId: accountId(code) }),
      );
      expect(problemOf(res).fieldErrors).toEqual({
        exchangeAccountId: ['pos_exchange_account_invalid'],
      });
    }
    for (const returnDays of ['', '7.5', '366', '-1']) {
      const res = await send('POST', '/pos/registers', registerForm('POS9', { returnDays }));
      expect(res.statusCode, returnDays).toBe(400);
      expect(problemOf(res).fieldErrors).toEqual({ returnDays: ['pos_return_days_format'] });
    }
    const longest = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS9', { returnDays: '365' }),
    );
    expect(longest.returnDays).toBe(365);
  });

  it('come with the register to the device that takes it, and its shift opens', async () => {
    pos1 = await claimed(pos1, counterPc);
    pos2 = await claimed(pos2, sumiTablet, sumi);
    utt1 = await claimed(utt1, uttaraPc);
    const opens = [open(pos1), open(pos2), open(utt1)];
    await accepted([lineOf(opens, 0)], counterPc);
    await accepted([lineOf(opens, 1)], sumiTablet, sumi);
    await accepted([lineOf(opens, 2)], uttaraPc);
    shift1 = lineOf(opens, 0).shiftId;
    shift2 = lineOf(opens, 1).shiftId;
    shiftU = lineOf(opens, 2).shiftId;
    // The device's copy of the register has the settings, never the last numbers
    const page = await pulled(counterPc);
    const row = page.changes.find(
      (change) => change.entity === 'pos_register' && change.key === pos1.id,
    );
    expect(row?.op === 'upsert' ? row.data : null).toMatchObject({
      exchangeAccountId: accountId('2190'),
      returnDays: 7,
    });
    expect(JSON.stringify(row)).not.toContain('lastReturnNumber');
  });
});

describe('A receipt to take back', () => {
  it('is found by its number at any counter, with what is left of each line', async () => {
    // Two juices and a gift wrapping for Farhana, ৳115 with VAT, paid with ৳200
    saleA = await sold(
      sale(pos1, shift1, [line(juice, '2', '25'), line(wrap, '1', '50')], [paid('cash', '200')], {
        customerId: farhana.id,
      }),
    );
    // Typed in small letters at the pharmacy counter
    const found = await returnable(saleA.number.toLowerCase(), sumi);
    expect(found).toMatchObject({
      id: saleA.id,
      number: 'POS1-000001',
      registerId: pos1.id,
      date: today,
      customer: { id: farhana.id, name: 'Farhana Akter' },
      pricesIncludeVat: false,
      total: '115.0000',
      payments: [{ method: 'cash', amount: '200.0000' }],
    });
    expect(
      found.lines.map((item) => [
        item.productName,
        item.quantity,
        item.total,
        item.returnedQuantity,
      ]),
    ).toEqual([
      ['Mango juice 250 ml', '2.0000', '57.5000', '0.0000'],
      ['Gift wrapping', '1.0000', '57.5000', '0.0000'],
    ]);

    const unknown = await send('GET', '/pos/sales/by-number/POS1-999999');
    expect(unknown.statusCode).toBe(404);
    expect(problemOf(unknown).code).toBe('pos_return_sale_not_found');
    // Finding a sale to take back is the return's permission
    expect(
      (await send('GET', `/pos/sales/by-number/${saleA.number}`, undefined, rafiq)).statusCode,
    ).toBe(403);
  });
});

describe('A return at the counter', () => {
  it('is posted at once: its number, the money back, the goods back and one entry', async () => {
    const juiceBefore = await onHand(main, juice);
    const lines = [back(lineOf(saleA.lines, 0), '1'), back(lineOf(saleA.lines, 1), '1')];
    const command = giveBack(pos1, shift1, saleA.id, lines, cashBack(lines), {
      note: 'Juice was warm, wrapping torn',
    });
    const [result] = await push([command]);
    // The answer brings the sale's row again, with what came back: the next return screen knows
    expect(result).toMatchObject({ id: command.id, status: 'accepted', notices: [] });
    expect(result?.status === 'accepted' ? result.changes : []).toMatchObject([
      {
        op: 'upsert',
        entity: 'pos_sale',
        key: saleA.id,
        data: { lines: [{ returnedQuantity: '1.0000' }, { returnedQuantity: '1.0000' }] },
      },
    ]);

    const done = await returnNow(command.returnId);
    expect(done).toMatchObject({
      number: 'POS1-R000001',
      register: { id: pos1.id, code: 'POS1', name: 'Front counter' },
      shift: { id: shift1 },
      branchId: main.branchId,
      warehouseId: main.id,
      date: today,
      sale: { id: saleA.id, number: 'POS1-000001', date: today },
      customer: { id: farhana.id, name: 'Farhana Akter' },
      cashier: { fullName: 'Nusrat Jahan' },
      net: '75.0000',
      vat: '11.2500',
      total: '86.2500',
      lineCount: 2,
      exchangeSale: null,
      outsideWindow: false,
      pricesIncludeVat: false,
      note: 'Juice was warm, wrapping torn',
      device: { id: counterPc.id, name: 'Front counter PC' },
    });
    expect(
      done.lines.map((item) => [item.productName, item.quantity, item.net, item.vat, item.total]),
    ).toEqual([
      ['Mango juice 250 ml', '1.0000', '25.0000', '3.7500', '28.7500'],
      ['Gift wrapping', '1.0000', '50.0000', '7.5000', '57.5000'],
    ]);
    expect(done.refunds).toEqual([
      { method: 'cash', amount: '86.2500', reference: null, accountId: accountId('1110') },
    ]);
    // The sale the other way round, on 4120 "Sales returns" (the retail template's choice): the
    // juice comes back at the ৳15 it cost; the wrapping is a service, with no stock and no cost
    expect(await entryLines(done.entry)).toEqual([
      ['1110', '0.0000', '86.2500', 'DHN'],
      ['1150', '15.0000', '0.0000', 'DHN'],
      ['2120', '11.2500', '0.0000', 'DHN'],
      ['4120', '75.0000', '0.0000', 'DHN'],
      ['5110', '0.0000', '15.0000', 'DHN'],
    ]);
    expect(Number(await onHand(main, juice))).toBe(Number(juiceBefore) + 1);
    expect((await registerNow(pos1)).lastReturnNumber).toBe(1);

    const saleNowA = await saleNow(saleA.id);
    expect(saleNowA.lines.map((item) => item.returnedQuantity)).toEqual(['1.0000', '1.0000']);
    expect(saleNowA.returns).toEqual([
      { id: command.returnId, number: 'POS1-R000001', date: today, total: '86.2500' },
    ]);
    const [entry] = await auditOf('pos_return', command.returnId);
    expect(entry).toMatchObject({
      action: 'pos_return.created',
      device: { id: counterPc.id, name: 'Front counter PC' },
      changes: {
        number: { from: null, to: 'POS1-R000001' },
        register: { from: null, to: 'POS1' },
        sale: { from: null, to: 'POS1-000001' },
        total: { from: null, to: '86.2500' },
        refunds: { from: null, to: 'cash 86.2500' },
      },
    });
  });

  it('pays a line back to the paisa, the last return taking what is left', async () => {
    // Three juices with ৳10 off the bill: ৳65 + ৳9.75 VAT, which does not split into three evenly
    const three = await sold(
      sale(pos1, shift1, [line(juice, '3', '25')], [paid('cash', '74.75')], {
        billDiscount: '10',
      }),
    );
    const sold3 = lineOf(three.lines, 0);
    expect([sold3.net, sold3.vat, sold3.total]).toEqual(['65.0000', '9.7500', '74.7500']);
    // One juice at a time, all three in one push, each worked out after the one before it
    const first = back(sold3, '1');
    const second = back({ ...sold3, returnedQuantity: '1' }, '1');
    const third = back({ ...sold3, returnedQuantity: '2' }, '1');
    const commands = [first, second, third].map((item) =>
      giveBack(pos1, shift1, three.id, [item], cashBack([item])),
    );
    await accepted(commands);
    const done = await Promise.all(commands.map((command) => returnNow(command.returnId)));
    expect(done.map((item) => [item.number, item.net, item.vat, item.total])).toEqual([
      ['POS1-R000002', '21.6700', '3.2500', '24.9200'],
      ['POS1-R000003', '21.6600', '3.2500', '24.9100'],
      ['POS1-R000004', '21.6700', '3.2500', '24.9200'],
    ]);
    expect(sumMoney(done.map((item) => item.total))).toBe('74.7500');
    // The server worked out the same: nothing for the log
    for (const command of commands) {
      const actions = (await auditOf('pos_return', command.returnId)).map((row) => row.action);
      expect(actions).toEqual(['pos_return.created']);
    }
    expect(lineOf((await saleNow(three.id)).lines, 0).returnedQuantity).toBe('3.0000');
  });

  it('puts batches back into the batches the sale took them from', async () => {
    // Five strips from batch A, which has 3: A gives 3, B (by its expiry) the other 2
    const strips = await sold(
      sale(
        pos1,
        shift1,
        [line(napa, '5', '30', { batchId: await lotId('NP-A') })],
        [paid('cash', '172.50')],
      ),
    );
    expect([await lotStock('NP-A'), await lotStock('NP-B')]).toEqual(['0.0000', '3.0000']);
    const soldStrips = lineOf(strips.lines, 0);
    // Four back: the cashier's batch A first (3), then B (1)
    const four = back(soldStrips, '4');
    const first = giveBack(pos1, shift1, strips.id, [four], cashBack([four]));
    // The last one: A has had all of its 3, so B
    const last = back({ ...soldStrips, returnedQuantity: '4' }, '1');
    const second = giveBack(pos1, shift1, strips.id, [last], cashBack([last]));
    await accepted([first, second]);
    const [done, doneLast] = await Promise.all([
      returnNow(first.returnId),
      returnNow(second.returnId),
    ]);
    const lotsOf = (item: PosReturn) =>
      lineOf(item.lines, 0).batches.map((part) => [part.lotNumber, part.quantity]);
    // By their expiry, like a sale's batches
    expect(lotsOf(done)).toEqual([
      ['NP-B', '1.0000'],
      ['NP-A', '3.0000'],
    ]);
    expect(lotsOf(doneLast)).toEqual([['NP-B', '1.0000']]);
    expect([await lotStock('NP-A'), await lotStock('NP-B')]).toEqual(['3.0000', '5.0000']);
    // At the ৳20 a strip cost
    expect((await entryLines(done.entry)).filter((row) => row[0] === '1150')).toEqual([
      ['1150', '80.0000', '0.0000', 'DHN'],
    ]);
  });

  it('brings a serial number back into stock, or a piece without its number', async () => {
    // Two phones by card, ৳34,500
    phones = await sold(
      sale(
        pos1,
        shift1,
        [line(phone, '2', '15000', { serialNumbers: ['IMEI-1', 'IMEI-2'] })],
        [paid('card', '34500', '7731')],
      ),
    );
    const soldPhones = lineOf(phones.lines, 0);
    expect(await serialAt('IMEI-2')).toBeNull();
    // A phone the sale did not sell, or one with no number: only a broken device sends them
    const wrong = await push([
      giveBack(
        pos1,
        shift1,
        phones.id,
        [back(soldPhones, '1', { serialNumbers: ['IMEI-3'] })],
        [{ method: 'card', amount: '17250', reference: '' }],
      ),
      giveBack(
        pos1,
        shift1,
        phones.id,
        [back(soldPhones, '1')],
        [{ method: 'card', amount: '17250', reference: '' }],
      ),
    ]);
    expect(wrong.map((result) => refusal(result))).toEqual([
      {
        code: 'pos_return_serial_invalid',
        fieldErrors: { 'lines.0.serialNumbers': ['pos_return_serial_invalid'] },
      },
      {
        code: 'pos_return_serial_invalid',
        fieldErrors: { 'lines.0.serialNumbers': ['pos_return_serial_invalid'] },
      },
    ]);
    // IMEI-2 back to the card it was paid with
    const two = back(soldPhones, '1', { serialNumbers: ['IMEI-2'] });
    const command = giveBack(
      pos1,
      shift1,
      phones.id,
      [two],
      [{ method: 'card', amount: totalOf([two]), reference: 'RV-7731' }],
    );
    await accepted([command]);
    const done = await returnNow(command.returnId);
    expect(lineOf(done.lines, 0).serialNumbers).toEqual(['IMEI-2']);
    expect(done.refunds).toEqual([
      { method: 'card', amount: '17250.0000', reference: 'RV-7731', accountId: accountId('1121') },
    ]);
    expect(await serialAt('IMEI-2')).toBe('MAIN');

    // A phone whose number the store never had (20a: sold short as a piece): it comes back as
    // a piece, and lifts the stock where it was
    const phonesBefore = await onHand(main, phone);
    const short = await sold(
      sale(
        pos1,
        shift1,
        [line(phone, '1', '15000', { serialNumbers: ['IMEI-9'] })],
        [paid('cash', '17250')],
      ),
    );
    expect(short.soldShort).toBe(true);
    const nine = back(lineOf(short.lines, 0), '1', { serialNumbers: ['IMEI-9'] });
    const shortBack = giveBack(pos1, shift1, short.id, [nine], cashBack([nine]));
    await accepted([shortBack]);
    expect(lineOf((await returnNow(shortBack.returnId)).lines, 0).serialNumbers).toEqual([
      'IMEI-9',
    ]);
    expect(await onHand(main, phone)).toBe(phonesBefore);
    expect(await serialAt('IMEI-9')).toBeUndefined();
  });

  it('pays back by the ways the sale was paid, split, each from its own account', async () => {
    // What came back of the two phones so far: IMEI-2
    const phoneSale = await saleNow(phones.id);
    // IMEI-1: ৳10,000 back on the card, the rest in cash
    const one = back(lineOf(phoneSale.lines, 0), '1', { serialNumbers: ['IMEI-1'] });
    const command = giveBack(
      pos1,
      shift1,
      phoneSale.id,
      [one],
      [
        { method: 'card', amount: '10000', reference: 'RV-7732' },
        { method: 'cash', amount: '7250', reference: '' },
      ],
    );
    await accepted([command]);
    const done = await returnNow(command.returnId);
    expect(done.refunds.map((item) => [item.method, item.amount, codeOf(item.accountId)])).toEqual([
      ['card', '10000.0000', '1121'],
      ['cash', '7250.0000', '1110'],
    ]);
    expect(await entryLines(done.entry)).toEqual([
      ['1110', '0.0000', '7250.0000', 'DHN'],
      ['1121', '0.0000', '10000.0000', 'DHN'],
      ['1150', '9000.0000', '0.0000', 'DHN'],
      ['2120', '2250.0000', '0.0000', 'DHN'],
      ['4120', '15000.0000', '0.0000', 'DHN'],
      ['5110', '0.0000', '9000.0000', 'DHN'],
    ]);
    expect(lineOf((await saleNow(phoneSale.id)).lines, 0).returnedQuantity).toBe('2.0000');
  });

  it('is refused a way of paying back the register has no account for, and keeps its number', async () => {
    // The pharmacy counter takes cash only, and makes no exchanges
    const strip = await sold(
      sale(pos2, shift2, [line(juice, '1', '25')], [paid('cash', '28.75')]),
      sumiTablet,
      sumi,
    );
    const one = back(lineOf(strip.lines, 0), '1');
    const results = await push(
      [
        giveBack(
          pos2,
          shift2,
          strip.id,
          [one],
          [{ method: 'card', amount: '28.75', reference: '' }],
        ),
        giveBack(
          pos2,
          shift2,
          strip.id,
          [one],
          [{ method: 'exchange', amount: '28.75', reference: '' }],
        ),
      ],
      sumiTablet,
      sumi,
    );
    expect(results.map((result) => refusal(result))).toEqual([
      {
        code: 'pos_method_not_set',
        fieldErrors: { 'refunds.0.method': ['pos_method_not_set'] },
      },
      {
        code: 'pos_exchange_not_set',
        fieldErrors: { 'refunds.0.method': ['pos_exchange_not_set'] },
      },
    ]);
    // The two slips were printed: their numbers are used, and the next one is 3
    expect((await registerNow(pos2)).lastReturnNumber).toBe(2);
    const command = giveBack(pos2, shift2, strip.id, [one], cashBack([one]));
    await accepted([command], sumiTablet, sumi);
    expect((await returnNow(command.returnId)).number).toBe('POS2-R000003');
  });

  it('is posted after the window, beyond what is left, with its own amounts and without the permission, and the log says so', async () => {
    // Yesterday's juice at the pharmacy counter, which takes back on the day of the sale only
    const yesterday = shiftIsoDate(today, -1);
    const old = await sold(
      sale(pos2, null, [line(juice, '1', '25')], [paid('cash', '28.75')], { date: yesterday }),
      sumiTablet,
      sumi,
    );
    // Sumi lost her role while the tablet was offline. Two juices of a line of one, at ৳26 each.
    await giveRoles('sumi@agoramart.com', []);
    const two = back(lineOf(old.lines, 0), '2', { net: '52', vat: '7.80' });
    const command = giveBack(pos2, shift2, old.id, [two], cashBack([two]));
    const juiceBefore = await onHand(main, juice);
    await accepted([command], sumiTablet, sumi);
    await giveRoles('sumi@agoramart.com', ['Cashier']);

    // The money was paid back: posted as the device sent it
    const done = await returnNow(command.returnId);
    expect(done).toMatchObject({ outsideWindow: true, net: '52.0000', vat: '7.8000' });
    expect(Number(await onHand(main, juice))).toBe(Number(juiceBefore) + 2);
    // Only the one juice that was sold had a cost
    expect((await entryLines(done.entry)).filter((row) => row[0] === '1150')).toEqual([
      ['1150', '15.0000', '0.0000', 'DHN'],
    ]);
    const rows = await auditOf('pos_return', command.returnId);
    expect(rows.map((row) => [row.action, row.changes])).toEqual([
      ['pos_return.created', expect.any(Object)],
      [
        'pos_return.outside_window',
        {
          sale: { from: null, to: old.number },
          soldOn: { from: null, to: yesterday },
          returnedOn: { from: null, to: today },
          returnDays: { from: null, to: '0' },
        },
      ],
      [
        'pos_return.over_returned',
        // What the device sent, as it sent it, and what the server knew
        { lines: { from: null, to: 'line 1: 2 of 1.0000, 0.0000 back before' } },
      ],
      [
        'pos_return.amounts_differ',
        {
          lines: {
            from: null,
            to: 'line 1: 52 + 7.80 sent, 25.0000 + 3.7500 worked out',
          },
        },
      ],
      [
        'pos_return.without_permission',
        {
          number: { from: null, to: done.number },
          returnedOn: { from: null, to: today },
          missing: { from: null, to: 'pos.return.create' },
        },
      ],
    ]);
    // Nothing is left to take back, and never less than nothing
    const found = await returnable(old.number);
    expect(lineOf(found.lines, 0).returnedQuantity).toBe('2.0000');
  });

  it('is refused what only a broken device sends, and keeps the number', async () => {
    // The wrapping is all back; one of the two juices is left
    const one = back({ ...lineOf(saleA.lines, 0), returnedQuantity: '1' }, '1');
    const lastBefore = (await registerNow(pos1)).lastReturnNumber;
    const notHeld = giveBack(pos2, shift2, saleA.id, [one], cashBack([one]));
    const results = await push([
      // A line of another sale
      giveBack(pos1, shift1, saleA.id, [{ ...one, saleLineId: v7() }], cashBack([one])),
      // A sale the server does not have
      giveBack(pos1, shift1, v7(), [one], cashBack([one])),
      // The pharmacy counter's shift
      giveBack(pos1, shift2, saleA.id, [one], cashBack([one])),
      // The pharmacy counter, which this PC does not hold
      notHeld,
    ]);
    expect(results.map((result) => refusal(result))).toEqual([
      {
        code: 'pos_return_line_unknown',
        fieldErrors: { 'lines.0.saleLineId': ['pos_return_line_unknown'] },
      },
      {
        code: 'pos_return_sale_not_found',
        fieldErrors: { saleId: ['pos_return_sale_not_found'] },
      },
      { code: 'pos_shift_unknown', fieldErrors: { shiftId: ['pos_shift_unknown'] } },
      { code: 'pos_register_not_held', fieldErrors: { registerId: ['pos_register_not_held'] } },
    ]);
    expect((await registerNow(pos1)).lastReturnNumber).toBe(lastBefore + 3);

    // What the device's own form refuses never reaches the books, and keeps no number
    const twice = giveBack(pos1, shift1, saleA.id, [one, one], cashBack([one, one]));
    const short = giveBack(
      pos1,
      shift1,
      saleA.id,
      [one],
      [{ method: 'cash', amount: '20', reference: '' }],
    );
    const formResults = await push([twice, short]);
    expect(formResults.map((result) => refusal(result))).toEqual([
      {
        code: 'invalid_input',
        fieldErrors: { 'lines.1.saleLineId': ['pos_return_line_twice'] },
      },
      { code: 'invalid_input', fieldErrors: { refunds: ['pos_refund_mismatch'] } },
    ]);

    // The same command again gets the same answer; its number again is a bug
    const good = giveBack(pos1, shift1, saleA.id, [one], cashBack([one]));
    await accepted([good]);
    const again = await push([good]);
    expect(outcomes(again)).toEqual(['accepted']);
    const taken = await push([{ ...good, id: v7(), returnId: v7() }]);
    expect(refusal(taken[0])).toEqual({
      code: 'pos_return_number_taken',
      fieldErrors: { sequence: ['pos_return_number_taken'] },
    });
    const returns = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?saleId=${saleA.id}`)).json(),
    );
    expect(returns.items.map((item) => item.number)).toEqual(
      [good.input.sequence, 1].map((sequence) => `POS1-R${String(sequence).padStart(6, '0')}`),
    );
  });

  it('is listed newest first, by register, sale and shift, one page at a time', async () => {
    const all = posReturnPageSchema.parse((await send('GET', '/pos/returns?limit=100')).json());
    const firstPage = posReturnPageSchema.parse((await send('GET', '/pos/returns?limit=3')).json());
    expect(firstPage.items).toEqual(all.items.slice(0, 3));
    if (firstPage.nextCursor === null) throw new Error('one page only');
    const secondPage = posReturnPageSchema.parse(
      (
        await send('GET', `/pos/returns?limit=3&cursor=${encodeURIComponent(firstPage.nextCursor)}`)
      ).json(),
    );
    expect(secondPage.items).toEqual(all.items.slice(3, 6));
    const byRegister = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?registerId=${pos2.id}`)).json(),
    );
    expect(byRegister.items.map((item) => item.number)).toEqual(['POS2-R000004', 'POS2-R000003']);
    const byShift = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?shiftId=${shift2}`)).json(),
    );
    expect(byShift.items).toEqual(byRegister.items);
    // Reading them needs no permission, like the sales
    const res = await send('GET', '/pos/returns', undefined, rafiq);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('An exchange', () => {
  it("pays for the next sale with the return's money, through the clearing account", async () => {
    // Two juices back (৳57.50); the customer takes a strip of Napa (৳34.50) and the rest in cash
    const juices = await sold(
      sale(pos1, shift1, [line(juice, '2', '25')], [paid('cash', '57.50')]),
    );
    const two = back(lineOf(juices.lines, 0), '2');
    const returned = giveBack(
      pos1,
      shift1,
      juices.id,
      [two],
      [
        { method: 'exchange', amount: '34.50', reference: '' },
        { method: 'cash', amount: '23', reference: '' },
      ],
    );
    const next = sale(
      pos1,
      shift1,
      [line(napa, '1', '30', { batchId: await lotId('NP-B') })],
      [{ method: 'exchange', amount: '34.50', reference: '', returnId: returned.returnId }],
    );
    await accepted([returned, next]);
    expect(await balanceOf('2190')).toBe('0.0000');

    const bought = await saleNow(next.saleId);
    expect(bought).toMatchObject({ total: '34.5000', paid: '34.5000', change: '0.0000' });
    expect(bought.payments).toEqual([
      {
        method: 'exchange',
        amount: '34.5000',
        reference: null,
        accountId: accountId('2190'),
        return: {
          id: returned.returnId,
          number: `POS1-R${String(returned.input.sequence).padStart(6, '0')}`,
        },
      },
    ]);
    const done = await returnNow(returned.returnId);
    expect(done.exchangeSale).toEqual({ id: next.saleId, number: bought.number });
    expect(done.refunds.map((item) => [item.method, item.amount, codeOf(item.accountId)])).toEqual([
      ['exchange', '34.5000', '2190'],
      ['cash', '23.0000', '1110'],
    ]);
    expect(await entryLines(bought.entry)).toEqual(
      expect.arrayContaining([['2190', '34.5000', '0.0000', 'DHN']]),
    );
  });

  it('is refused when the sale does not match its return', async () => {
    const juices = await sold(
      sale(pos1, shift1, [line(juice, '2', '25')], [paid('cash', '57.50')]),
    );
    const soldJuice = lineOf(juices.lines, 0);
    const one = back(soldJuice, '1');
    const credit = (amount: string) => [{ method: 'exchange' as const, amount, reference: '' }];
    const ret = giveBack(pos1, shift1, juices.id, [one], credit('28.75'));
    // Uttara's counter takes back the other juice, in its own shift
    const uttaraOne = back({ ...soldJuice, returnedQuantity: '1' }, '1');
    const atUttara = giveBack(utt1, shiftU, juices.id, [uttaraOne], credit('28.75'));
    await accepted([ret]);
    await accepted([atUttara], uttaraPc);
    const pay = (returnId: string, amount = '28.75'): Payment => ({
      method: 'exchange',
      amount,
      reference: '',
      returnId,
    });
    const juice1 = [line(juice, '1', '25')];
    // A return that was refused in the same push: the sale after it cannot use it
    const refusedReturn = giveBack(pos1, shift1, v7(), [one], credit('28.75'));
    const results = await push([
      sale(pos1, shift1, juice1, [pay(v7())]),
      sale(pos1, shift1, juice1, [pay(ret.returnId, '20'), paid('cash', '8.75')]),
      sale(pos1, shift1, juice1, [pay(atUttara.returnId)]),
      sale(pos1, shift1, juice1, [pay(ret.returnId)]),
      sale(pos1, shift1, juice1, [pay(ret.returnId)]),
      refusedReturn,
      sale(pos1, shift1, juice1, [pay(refusedReturn.returnId)]),
    ]);
    expect(outcomes(results)).toEqual([
      'pos_return_unknown',
      'pos_exchange_invalid',
      'pos_exchange_invalid',
      'accepted',
      'pos_exchange_invalid',
      'pos_return_sale_not_found',
      'pos_return_unknown',
    ]);
    expect(refusal(results[0]).fieldErrors).toEqual({
      'payments.0.method': ['pos_return_unknown'],
    });
    expect(refusal(results[4]).fieldErrors).toEqual({
      'payments.0.method': ['pos_exchange_invalid'],
    });
    // Uttara's exchange credit is still waiting on the clearing account for its own sale
    expect(await balanceOf('2190')).toBe('-28.7500');
    await accepted([sale(utt1, shiftU, juice1, [pay(atUttara.returnId)])], uttaraPc);
    expect(await balanceOf('2190')).toBe('0.0000');
  });
});

describe("Another branch's receipt", () => {
  it("comes back into this counter's store, and the sale's branch takes the sale back", async () => {
    // Farhana buys two juices at the front counter, and brings one to Uttara. Online, the Uttara
    // counter finds the receipt on the server.
    const hers = await sold(
      sale(pos1, shift1, [line(juice, '2', '25')], [paid('cash', '57.50')], {
        customerId: farhana.id,
      }),
    );
    const found = await returnable(hers.number);
    const juiceLine = lineOf(found.lines, 0);
    const cursor = (await pulled(counterPc)).cursor;
    const [mainBefore, uttaraBefore] = await Promise.all([
      onHand(main, juice),
      onHand(uttaraStore, juice),
    ]);
    const one = back(juiceLine, '1');
    const command = giveBack(utt1, shiftU, hers.id, [one], cashBack([one]));
    const [result] = await push([command], uttaraPc);
    // Uttara's counter does not keep POS1's sales: the answer is a delete, which it ignores
    expect(result?.status === 'accepted' ? result.changes : null).toEqual([
      { op: 'delete', entity: 'pos_sale', key: hers.id },
    ]);
    const done = await returnNow(command.returnId);
    expect(done).toMatchObject({
      number: 'UTT1-R000002',
      branchId: uttara.id,
      warehouseId: uttaraStore.id,
      sale: { id: hers.id, number: hers.number },
      customer: { id: farhana.id },
    });
    expect([await onHand(main, juice), Number(await onHand(uttaraStore, juice))]).toEqual([
      mainBefore,
      Number(uttaraBefore) + 1,
    ]);
    // The sale, its VAT and its cost come off Dhanmondi; the cash and the juice are in Uttara. The
    // juice cost ৳14.71 when she bought it: the average fell below ৳15 when the pharmacy took back
    // a juice it never sold, at no cost (above).
    expect(await entryLines(done.entry)).toEqual([
      ['1110', '0.0000', '28.7500', 'UTT'],
      ['1150', '14.7100', '0.0000', 'UTT'],
      ['2120', '3.7500', '0.0000', 'DHN'],
      ['4120', '25.0000', '0.0000', 'DHN'],
      ['5110', '0.0000', '14.7100', 'DHN'],
    ]);
    // The front counter hears of it with its next pull
    const next = await pulled(counterPc, owner, cursor);
    const row = next.changes.find(
      (change) => change.entity === 'pos_sale' && change.key === hers.id,
    );
    expect(row?.op === 'upsert' ? row.data : null).toMatchObject({
      lines: [{ returnedQuantity: '1.0000' }],
    });
  });
});

describe('The shift', () => {
  it('takes the cash refunds out of the drawer, and counts the returns made in it', async () => {
    const shift = await shiftNow(shift1);
    const returns = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?shiftId=${shift1}&limit=100`)).json(),
    ).items;
    // Every return the front counter took, and no other: Uttara's return of a POS1 receipt is in
    // Uttara's shift
    const all = posReturnPageSchema.parse((await send('GET', '/pos/returns?limit=100')).json());
    expect(returns).toEqual(all.items.filter((item) => item.register.id === pos1.id));
    expect(shift.returnCount).toBe(returns.length);
    expect(shift.returnsTotal).toBe(sumMoney(returns.map((item) => item.total)));
    expect(shift.returnsVat).toBe(sumMoney(returns.map((item) => item.vat)));
    const refunds = await Promise.all(returns.map((item) => returnNow(item.id)));
    const cashRefunds = refunds.flatMap((item) =>
      item.refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
    );
    expect(shift.cash.cashRefunded).toBe(sumMoney(cashRefunds));
    expect(shift.refunds).toEqual([
      { method: 'cash', amount: sumMoney(cashRefunds) },
      { method: 'card', amount: '27250.0000' },
      { method: 'exchange', amount: '63.2500' },
    ]);
    const { cash } = shift;
    expect(shift.expectedCash).toBe(
      sumMoney([
        cash.opening,
        cash.cashTaken,
        cash.paidIn,
        `-${cash.changeGiven}`,
        `-${cash.paidOut}`,
        `-${cash.cashRefunded}`,
      ]),
    );
  });
});

describe('The pull', () => {
  it('brings the recent sales of the register a device holds, and no other', async () => {
    // A sale of 31 days ago, from an outbox of long ago: posted, and on no device
    const old = sale(pos1, null, [line(juice, '1', '25')], [paid('cash', '28.75')], {
      date: shiftIsoDate(today, -31),
    });
    const [result] = await push([old]);
    expect(result?.status === 'accepted' ? result.changes : null).toEqual([
      { op: 'delete', entity: 'pos_sale', key: old.saleId },
    ]);
    const salesOf = async (register: PosRegister) =>
      z
        .array(z.object({ id: z.string() }))
        .parse(
          await sql`SELECT id::text FROM pos_sales
                     WHERE register_id = ${register.id} AND date >= ${shiftIsoDate(today, -30)}
                     ORDER BY sequence`,
        )
        .map((row) => row.id);
    const keysOf = async (device: Device, as = owner) =>
      (await pulled(device, as)).changes
        .filter((change) => change.entity === 'pos_sale')
        .map((change) => change.key)
        .sort();
    const ofPos1 = await salesOf(pos1);
    expect(ofPos1).not.toContain(old.saleId);
    expect(await keysOf(counterPc)).toEqual([...ofPos1].sort());
    expect(await keysOf(sumiTablet, sumi)).toEqual([...(await salesOf(pos2))].sort());
    expect(await keysOf(uttaraPc)).toEqual([...(await salesOf(utt1))].sort());
    expect(await keysOf(officeLaptop)).toEqual([]);

    // Right after a claim, the device reads the same sales by the register's numbers
    const firstPage = posRegisterSalesPageSchema.parse(
      (await send('GET', `/pos/registers/${pos1.id}/sales?limit=4`)).json(),
    );
    expect(firstPage.items.map((item) => item.id)).toEqual(ofPos1.slice(0, 4));
    if (firstPage.nextCursor === null) throw new Error('one page only');
    const rest = posRegisterSalesPageSchema.parse(
      (
        await send(
          'GET',
          `/pos/registers/${pos1.id}/sales?limit=100&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
        )
      ).json(),
    );
    expect(rest.nextCursor).toBeNull();
    expect(rest.items.map((item) => item.id)).toEqual(ofPos1.slice(4));
    // With the cashier's permission, of a register this workspace has
    expect(
      (await send('GET', `/pos/registers/${pos1.id}/sales`, undefined, rafiq)).statusCode,
    ).toBe(403);
    expect((await send('GET', `/pos/registers/${v7()}/sales`)).statusCode).toBe(404);
  });
});

describe('At the same moment', () => {
  it('two counters take back the last juice of a line: both posted, the second written down', async () => {
    const one = await sold(
      sale(pos2, shift2, [line(juice, '1', '25')], [paid('cash', '28.75')]),
      sumiTablet,
      sumi,
    );
    const soldJuice = lineOf(one.lines, 0);
    const atPharmacy = back(soldJuice, '1');
    const atUttara = back(soldJuice, '1');
    const commands = [
      giveBack(pos2, shift2, one.id, [atPharmacy], cashBack([atPharmacy])),
      giveBack(utt1, shiftU, one.id, [atUttara], cashBack([atUttara])),
    ] as const;
    const [pharmacy, uttaraAnswer] = await Promise.all([
      push([commands[0]], sumiTablet, sumi),
      push([commands[1]], uttaraPc),
    ]);
    expect([...outcomes(pharmacy), ...outcomes(uttaraAnswer)]).toEqual(['accepted', 'accepted']);
    // The sale was locked: whichever came second saw the first, and the log says so once
    const over = await Promise.all(
      commands.map(async (command) =>
        (await auditOf('pos_return', command.returnId)).some(
          (row) => row.action === 'pos_return.over_returned',
        ),
      ),
    );
    expect(over.filter(Boolean)).toHaveLength(1);
    expect(lineOf((await saleNow(one.id)).lines, 0).returnedQuantity).toBe('2.0000');
  });
});

describe('What a return points at', () => {
  it('is never changed, and the exchange account of a register is not deleted', async () => {
    const [first] = posReturnPageSchema.parse((await send('GET', '/pos/returns')).json()).items;
    if (!first) throw new Error('no return');
    // Not even by the superuser: a mistake is put right with a new sale (0056)
    await expect(
      sql`UPDATE pos_returns SET note = 'changed' WHERE id = ${first.id}`,
    ).rejects.toThrow('a POS return cannot be changed or deleted');
    await expect(sql`DELETE FROM pos_return_refunds WHERE return_id = ${first.id}`).rejects.toThrow(
      'a POS return cannot be changed or deleted',
    );
    // An exchange account no entry uses yet, only a register: still in use
    const spare = await created(accountSchema, '/accounts', {
      parentId: accountId('2100'),
      code: '2195',
      name: 'POS exchange clearing (Uttara)',
      isGroup: false,
      holdsMoney: false,
      description: '',
    });
    accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
    await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('UTT2', { warehouseId: uttaraStore.id, exchangeAccountId: spare.id }),
    );
    const res = await send('DELETE', `/accounts/${spare.id}?version=${String(spare.version)}`);
    expect(res.statusCode, res.body).toBe(409);
    expect(problemOf(res).code).toBe('account_in_use');
  });
});

describe('A sale still in the outbox', () => {
  it('is taken back in the same push, by the line ids the device made', async () => {
    // Sold offline, and the goods came back ten minutes later: the device knows the line by the id
    // it made, before the server has seen the sale
    const lineId = v7();
    const soldOffline = sale(
      pos2,
      shift2,
      [line(juice, '2', '25', { id: lineId })],
      [paid('cash', '57.50')],
    );
    const amounts = posReturnAmounts(
      { quantity: '2', net: '50', vat: '7.5', returnedQuantity: '0' },
      '1',
    );
    const taken = giveBack(
      pos2,
      shift2,
      soldOffline.saleId,
      [{ saleLineId: lineId, quantity: '1', ...amounts, serialNumbers: [] }],
      [paid('cash', amounts.total)],
    );
    expect(outcomes(await push([soldOffline, taken], sumiTablet, sumi))).toEqual([
      'accepted',
      'accepted',
    ]);
    const posted = await saleNow(soldOffline.saleId);
    expect(lineOf(posted.lines, 0)).toMatchObject({ id: lineId, returnedQuantity: '1.0000' });

    // An id used once is never a second line's: the sale is refused, and keeps its number
    const again = sale(
      pos2,
      shift2,
      [line(juice, '1', '25', { id: lineId })],
      [paid('cash', '28.75')],
    );
    const [answer] = await push([again], sumiTablet, sumi);
    expect(refusal(answer)).toMatchObject({ code: 'sync_id_taken' });
    expect((await registerNow(pos2)).lastNumber).toBe(again.input.sequence);
  });
});
```

The file is long, so here it is part by part, in its own order.

**The world.** Agora Mini Mart again, a retail shop, so 4120 "Sales returns", 2190 "POS exchange clearing" and the
Cashier role come from the template. Nusrat runs the front counter (POS1: cash, a card machine, the exchange account,
7 days), Sumi the pharmacy counter (POS2: cash only, no exchange, returns on the day of the sale only), and the Uttara
shop has its own counter (UTT1, with the exchange account) and store. Rafiq is a member with no role. The stock is 50
mango juices at ৳15, Napa in two batches (A: 3 strips, B: 5, B expires first) and three phones with their IMEIs, all at
cost 40 days ago, so every sale has stock and a known cost.

**The helpers.**

- **`v7()` makes a real UUIDv7: the time first.** The returns list is newest first by date, then by id. All the returns
  of the test are made on one day, so the id decides the order. The earlier suites made a random UUID with a 7 in it,
  which is enough for the server's version check but sorts at random; a device's ids sort by the time they were made,
  and so do these. `idClock` goes up by 1 ms for every id, so two ids made in the same millisecond still sort in order.
- **`back()` builds a return line the way the device does:** `posReturnAmounts()` from the contract, on the sale line
  and what the device knows came back before it. A test that sends two returns of one line in one push passes the line
  with a higher `returnedQuantity` for the second, as the device does with the returns still in its outbox. The server
  works out the same and writes no `amounts_differ` row; a test that wants that row sends its own amounts in `extra`.
- **`giveBack()` numbers the returns per register,** like `sale()` numbers the sales. `claimed()` starts both counters
  from the register's last numbers, as the device does after a claim.
- **`cashBack()` refunds the lines' total in cash.** The contract refuses a refund that does not add up to the lines,
  so a test about something else cannot fail on that by mistake.
- **`entryLines()` reads an entry as `[code, debit, credit, branch]`, sorted by code.** The branch is written as `DHN` or
  `UTT`, so the test of another branch's receipt can say in one table which line went to which branch.
- **`lotStock()`, `serialAt()` and `balanceOf()` read as the superuser:** no route shows one batch's stock, where one
  serial number is, or an account's balance this way. `serialAt()` answers `undefined` when the number is in no row at
  all, which is different from `null` (a row, in no warehouse).

**A new retail workspace.** 2190 is a liability under 2100 (current liabilities), not a group (decision 6). Exactly
three roles hold `pos.return.create`: Owner, Shop manager and Cashier (20c.3's templates). The list is sorted, so a role
added in another order does not fail the test.

**A register's return settings.**

- **POS1 with the exchange account and the form's 7 days;** POS2 is made with 7 and edited to 0, and the audit row has
  `returnDays` from `7` to `0` as text, like the register's other numbers.
- **Refusals:** the cash account (an asset) and the 2100 group are both `pos_exchange_account_invalid`, one answer for
  every reason. An empty box, `7.5`, `366` and `-1` are each a 400 with `pos_return_days_format`. 365 is the largest
  allowed, and a register with it is made (POS9, never used again).
- **The claim gives each device its register,** and each counter opens its first shift with ৳1,000 from the owner. The
  pull's copy of POS1 has the exchange account and the days, and no `lastReturnNumber` (decision 12: the device counts
  its own numbers).

**A receipt to take back.** Farhana's sale, POS1-000001: two juices and a gift wrapping, ৳115, paid with ৳200. Sumi
finds it at the pharmacy counter in small letters: the route takes any register's receipt (decision 21), and the
contract makes the number upper case. The answer has the customer, the payments as they were made (the ৳200 note, not
less the change) and each line with nothing taken back yet. An unknown number is a 404 with its own code; Rafiq, without
`pos.return.create`, gets 403.

**A return at the counter.** These tests use the front counter, one after the other.

- **Posted at once.** One juice and the wrapping come back for ৳86.25 in cash. The push answers with the sale's row,
  each line one taken back, so the next return screen knows. The return's page has the number `POS1-R000001`, the
  sale, Farhana (from the sale), the note and the device. Its entry is the sale the other way round on 4120: the juice
  comes back at the ৳15 it cost (Dr inventory / Cr cost of goods sold); the wrapping is a service, so no stock and no
  cost. The register's last return number is 1, the sale lists the return, and the audit row has the refunds as text.
- **To the paisa.** Three juices with ৳10 off the bill are ৳65 + ৳9.75, which does not split into three. Three returns
  of one, in one push, give back 21.67, 21.66 and 21.67 of the net and 3.25 of the VAT each: together exactly the line.
  Each return's audit has `pos_return.created` alone, which proves the server worked out the same amounts in the same
  order (each savepoint sees the return before it).
- **Batches.** Five strips sold from batch A, which has 3: A gives 3 and B 2 (20a). Four come back: the cashier's batch
  A first (3), then B (1), shown by expiry like a sale's batches. The last strip goes to B, because A has had all it
  gave. Both batches are back where they started, at ৳20 a strip.
- **Serial numbers.** Two phones by card. IMEI-3 (the sale did not sell it) and a phone with no number are both
  `pos_return_serial_invalid`: only a broken device sends them. IMEI-2 goes back to the card with its own reference and
  is in MAIN again. Then a phone whose number the store never had (IMEI-9, sold short in 20a): it comes back as a piece
  without its number, so the phone's stock is what it was before that sale, and no serial row exists for IMEI-9
  (decision 53).
- **Split refunds.** IMEI-1 comes back as ৳10,000 on the card and the rest in cash: two credit lines on two accounts.
- **A refund with no account.** At the pharmacy counter, a card refund is `pos_method_not_set` and an exchange is
  `pos_exchange_not_set`, each under `refunds.0.method` (decision 54). The two slips were printed, so numbers 1 and 2
  are used and the next return is `POS2-R000003` (decision 43).
- **Written down, not refused (decision 20).** Yesterday's juice comes back at a counter of 0 days, two of a line of
  one, at ৳26 each, from Sumi with no role (she lost it while the tablet was offline; the role comes back right after).
  The return is posted as sent, `outsideWindow` is true, and the audit log has four rows after `created`: the window,
  more than was sold, other amounts, and no permission. The rows quote the device as it sent the numbers (`2`, `52 +
  7.80`) next to what the server knew, like 20b's `expected_differs`. Only the one juice that was sold has a cost
  (decision 51): the other comes back at ৳0. The sale now says 2 taken back of 1; the return screen offers 0
  (`returnableQuantityOf()` never goes below zero).
- **What only a broken device sends.** A line of another sale, a sale nobody has, another counter's shift, and a
  register the PC does not hold each get their own code and field. The three on POS1 used three numbers. Two that the
  contract refuses (a line twice, refunds that do not add up) are `invalid_input` with the field's code. The same
  command again is accepted again (its stored answer), and its number with another id is `pos_return_number_taken`.
- **The list.** Two pages of three are the first six of one page of 100. POS2's returns, and the returns of POS2's
  shift, are the same two (a refused return has no row). Rafiq reads the list: like the sales, reading needs no
  permission.

**An exchange.**

- **Through the clearing account.** Two juices come back (৳57.50): ৳34.50 as an exchange and ৳23 in cash. One push
  sends the return and then the sale of a Napa strip paid with the exchange alone (decision 38). 2190 is back at zero.
  The sale's payment names the return and its account is 2190 (decision 47); the return names the sale. The sale's
  entry has Dr 2190.
- **Refusals.** A sale that uses a return nobody has is `pos_return_unknown`. One for ৳20 of a ৳28.75 exchange, one that
  uses Uttara's return (another register and shift), and a second sale of a return already used are each
  `pos_exchange_invalid` (decision 11: one code, because only a bug gets there). A return refused in the push (its
  sale is unknown) leaves the sale after it `pos_return_unknown`. While Uttara's exchange waits, 2190 holds its
  ৳28.75 (Cr); Uttara's own sale then uses it and 2190 is at zero again.

**Another branch's receipt.** Farhana buys two juices at the front counter and brings one to Uttara. Uttara finds the
receipt online and takes it back. The push answers with a delete of the sale's row: Uttara's counter does not keep
POS1's sales (decision 23), and the device ignores a delete of a row it does not have. The juice goes into the Uttara
store (decision 3), and the return's branch and warehouse are Uttara's. The entry splits by branch (decision 49): the
sales returns, the VAT and the cost come off Dhanmondi, where the sale was; the cash and the juice are in Uttara. The cost
is ৳14.71, not ৳15: the average fell when the pharmacy took back a juice it never sold, at no cost. The front counter's
next pull brings the sale's row again with one juice back.

**The shift.** The front counter's shift counts every return POS1 took and no other (Uttara's return of a POS1 receipt is
Uttara's shift's, decision 19). Its returns total and VAT are the sum of its returns; `cashRefunded` is the sum of their
cash refunds; refunds per method are cash, the card's ৳27,250 (৳17,250 + ৳10,000) and the two exchanges' ৳63.25, in the
contract's tender order. The expected cash is the opening plus cash taken and paid in, less the change, the pay outs and
the cash refunds (`expectedCashOf()`, 20c.1). The test works these out from the returns themselves, so it does not
depend on how many returns the earlier tests made.

**The pull.**

- **A sale of 31 days ago** (from an old outbox, no shift) is posted, and its answer is a delete: it is older than the
  days a device keeps.
- **A full pull** gives each device the sales of the register it holds from the last 30 days, and no other: the front
  counter POS1's, Sumi's tablet POS2's, Uttara UTT1's, the office laptop (no register) none. The test reads the truth
  from the database by register and date.
- **The register's sales route** gives the same sales in the register's own number order, a page of 4 and then the
  rest. Rafiq (no `pos.sale.create`) gets 403, an unknown register 404.

**At the same moment.** The pharmacy counter and Uttara take back the last juice of one sale with two pushes at once. Both
are posted: the money was paid back at both counters (decision 20). The sale is locked `FOR UPDATE` (decision 48), so the
second one sees the first, and exactly one of the two has an `over_returned` row; which one depends on the order. The
sale says 2 back of 1.

**What a return points at.** Not even the superuser can change a return or delete a refund (0056's
`pos_returns_immutable`, checked by its message). An exchange account that only a register points at, with no entry yet
(2195, on a new UTT2 register), cannot be deleted: `account_in_use`, from the new foreign key in 20c.3. The refund's own
foreign key is not tested alone, because every refund also has a journal line, whose key answers first.

**A sale still in the outbox** (added in 20c.6a, decision 64). A sale sold offline and its return ten minutes later go
in one push: the return names the line by the id the device made, both are accepted, and the posted sale's line has
that id with one piece taken back. A second sale that uses the same line id is refused with `sync_id_taken` and keeps
its number. It is the last test of the file, so the numbers the earlier tests check do not move.

### `pos/pos.tenant-leak.int.spec.ts`: the returns

```diff
@@ -13,7 +13,10 @@ import {
   posCashReasonSchema,
   type PosRegister,
   posRegisterListSchema,
+  posRegisterSalesPageSchema,
   posRegisterSchema,
+  posReturnAmounts,
+  posReturnPageSchema,
   type PosSale,
   posSalePageSchema,
   posSaleSchema,
@@ -86,6 +89,9 @@ let saleOfB: PosSale;
 // B's float reason, and the shift B's counter has open
 let reasonOfB: PosCashReason;
 let shiftOfB: string;
+// Step 20c: A's open shift (from "are not used by A's counter"), and B's return of its sale
+let shiftOfA: string;
+let returnOfB: string;
 
 type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
 type SaleLine = SaleCommand['input']['lines'][number];
@@ -176,6 +182,9 @@ function registerForm(code: string, warehouseId: string, cash: string, overShort
     overShortAccountId: overShort,
     varianceAlert: '500',
     lockAfter: '5',
+    // Step 20c: no exchanges, and the form's 7 days
+    exchangeAccountId: '',
+    returnDays: '7',
   };
 }
 
@@ -618,6 +627,7 @@ describe("another workspace's reasons and shifts", () => {
     const opening = shiftOpen(a, 1, '0');
     const [opened] = await pushed(a, [opening]);
     expect(opened?.status, JSON.stringify(opened)).toBe('accepted');
+    shiftOfA = opening.shiftId;
     const [ownReason] = posCashReasonListSchema.parse(
       (await as(a.who, 'GET', '/pos/cash-reasons')).json(),
     ).items;
@@ -658,3 +668,139 @@ describe("another workspace's reasons and shifts", () => {
     });
   });
 });
+
+describe("another workspace's returns", () => {
+  it("are not read, listed or found by A, nor is B's receipt", async () => {
+    // B takes back one strip of its sale, in cash, in its open shift
+    const [sold] = saleOfB.lines;
+    if (!sold) throw new Error('B sold no line');
+    const amounts = posReturnAmounts(sold, '1');
+    returnOfB = v7();
+    const [taken] = await pushed(b, [
+      {
+        id: v7(),
+        type: 'pos_return.create',
+        returnId: returnOfB,
+        input: {
+          registerId: b.register.id,
+          sequence: 1,
+          shiftId: shiftOfB,
+          date: '2026-10-27',
+          returnedAt: '2026-10-27T09:00:00.000Z',
+          saleId: saleOfB.id,
+          lines: [
+            {
+              saleLineId: sold.id,
+              quantity: '1',
+              net: amounts.net,
+              vat: amounts.vat,
+              serialNumbers: [],
+            },
+          ],
+          refunds: [{ method: 'cash', amount: amounts.total, reference: '' }],
+          note: '',
+        },
+      },
+    ]);
+    expect(taken?.status, JSON.stringify(taken)).toBe('accepted');
+
+    const answers = await Promise.all([
+      as(a.who, 'GET', `/pos/returns/${returnOfB}`),
+      as(a.who, 'GET', `/pos/sales/by-number/${saleOfB.number}`),
+      as(a.who, 'GET', `/pos/registers/${b.register.id}/sales`),
+    ]);
+    expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404]);
+    for (const query of [
+      '',
+      `?registerId=${b.register.id}`,
+      `?saleId=${saleOfB.id}`,
+      `?shiftId=${shiftOfB}`,
+    ]) {
+      const page = posReturnPageSchema.parse(
+        (await as(a.who, 'GET', `/pos/returns${query}`)).json(),
+      );
+      expect(page.items).toEqual([]);
+    }
+    // A's own register lists A's sales only
+    const own = posRegisterSalesPageSchema.parse(
+      (await as(a.who, 'GET', `/pos/registers/${a.register.id}/sales`)).json(),
+    );
+    expect(own.items.map((item) => item.id)).not.toContain(saleOfB.id);
+  });
+
+  it("are not made of B's sale by A's counter, nor spent on A's sale", async () => {
+    const [sold] = saleOfB.lines;
+    if (!sold) throw new Error('B sold no line');
+    const amounts = posReturnAmounts(sold, '1');
+    const onB = sale(a, 7, [line(a)]);
+    const results = await pushed(a, [
+      // A's counter takes back a strip of B's receipt
+      {
+        id: v7(),
+        type: 'pos_return.create',
+        returnId: v7(),
+        input: {
+          registerId: a.register.id,
+          sequence: 1,
+          shiftId: shiftOfA,
+          date: '2026-10-27',
+          returnedAt: '2026-10-27T10:00:00.000Z',
+          saleId: saleOfB.id,
+          lines: [
+            {
+              saleLineId: sold.id,
+              quantity: '1',
+              net: amounts.net,
+              vat: amounts.vat,
+              serialNumbers: [],
+            },
+          ],
+          refunds: [{ method: 'cash', amount: amounts.total, reference: '' }],
+          note: '',
+        },
+      },
+      // A's sale paid with B's return as an exchange
+      {
+        ...onB,
+        input: {
+          ...onB.input,
+          shiftId: shiftOfA,
+          payments: [
+            // The ৳150 of five strips (prices with VAT), all of it
+            { method: 'exchange', amount: '150', reference: '', returnId: returnOfB },
+          ],
+        },
+      },
+    ]);
+    expect(results.map((result) => (result.status === 'rejected' ? result.error : null))).toEqual([
+      {
+        code: 'pos_return_sale_not_found',
+        fieldErrors: { saleId: ['pos_return_sale_not_found'] },
+      },
+      {
+        code: 'pos_return_unknown',
+        fieldErrors: { 'payments.0.method': ['pos_return_unknown'] },
+      },
+    ]);
+    // B's sale and B's return are as they were
+    const saleNow = posSaleSchema.parse(
+      (await as(b.who, 'GET', `/pos/sales/${saleOfB.id}`)).json(),
+    );
+    expect(saleNow.returns.map((item) => item.id)).toEqual([returnOfB]);
+    expect(saleNow.lines[0]?.returnedQuantity).toBe('1.0000');
+  });
+
+  it("are not in A's pull", async () => {
+    const query = new URLSearchParams({
+      deviceId: a.device.id,
+      protocol: String(SYNC_PROTOCOL),
+      limit: '1000',
+    });
+    const res = await as(a.who, 'GET', `/sync/pull?${query.toString()}`);
+    expect(res.statusCode, res.body).toBe(200);
+    const changes = syncPullSchema.parse(res.json()).changes;
+    const sales = changes.filter((change) => change.entity === 'pos_sale');
+    expect(sales.map((change) => change.key)).not.toContain(saleOfB.id);
+    expect(JSON.stringify(changes)).not.toContain(returnOfB);
+  });
+});
```

- **`shiftOfA` keeps A's open shift** from the test that opens it, so A's counter can try a return.
- **B takes back one strip of its sale** in its open shift, in cash. Then every return route answers A with 404: B's
  return, B's receipt by its number, and B's register's sales. A's list is empty with any filter of B's, and A's own
  register's sales do not have B's sale.
- **A's counter cannot take back B's receipt** (`pos_return_sale_not_found`, like a sale nobody has) **or spend B's
  return on a sale** (`pos_return_unknown`). B's sale still has its one return and one strip taken back.
- **A's pull has no row of B's sales and no word of B's return.**

### Check this part

```bash
pnpm exec prettier --check apps/api/src
pnpm exec eslint apps/api/src
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
cd apps/api && npx vitest run src/pos src/sync --maxWorkers=2
```

The last line runs the integration suites of the POS and the sync (eight files), each against its own Postgres and
Valkey in Docker. `--maxWorkers=2` keeps a laptop with other containers responsive; more workers can time out the start
of the containers. All pass: API unit 123; POS and sync 183 (21 of them in the new file, 3 new in the tenant-leak suite). `packages/sync` and
`apps/app` still fail to type check until 20c.5 to 20c.7.

> **What was checked while building it.** Besides the commands above, two rules of 20c.3 were broken on purpose, one at a
> time with the file copied back after: the batch order (the cashier's batch first) and the pull's register filter. The
> batch test, the other-branch test (its push answer) and the pull test failed, as they should.

## 20c.5 — `packages/i18n`: the words

The screens of 20c.6 need their words in English and Bangla, so they come first. This part changes only the two locale
files. The ui package needs nothing new: the return flow is dialogs with checkboxes, number boxes and the pay dialog's
rows, the reports are print sheets like the receipt, and the managers' pages are a data table and a document page.

When this part starts, `packages/i18n` does not type-check: the `errors` object misses the 16 return codes of 20c.1. The
app also looks up the words of every permission, audit action and entity type, journal source, movement kind and sync
command, and 20c.1 added one of each. When this part ends, the i18n package and the ui package type-check, and the app
fails only in its own code that 20c.6 and 20c.7 change, all on the new contract types, not on words: `pos-pay.tsx` and
`routes/pos-sale.tsx` (a payment's tender and `returnId`), `sync-parts.tsx` (the return command's name),
`routes/pos-registers.tsx` (the form's two new fields) and the mocks (`mocks/pos-data.ts`, `mocks/pos-shift-data.ts`,
`mocks/push-data.ts`).

### `locales/en.ts`

```diff
@@ -135,6 +135,8 @@ export const en = {
     // setting, next to POS registers)
     posShifts: 'POS shifts',
     cashReasons: 'POS cash reasons',
+    // Step 20c: what the counters took back (under Sales, next to POS sales)
+    posReturns: 'POS returns',
   },
   auth: {
     workspace: 'Workspace',
@@ -543,12 +545,17 @@ export const en = {
       // pos.cash.done ("৳10,000 paid out for Bank deposit")
       pos_shift: { open: 'Shift {{name}} opened', close: 'Shift {{name}} closed' },
       pos_cash_movement: { create: 'Drawer: {{name}}' },
+      // Step 20c: {{name}} is the return's number (POS1-R000012)
+      pos_return: { create: 'Return {{name}}' },
     },
     savedAt: 'Saved {{time}}',
     // fields = the form's own labels, joined in the page's language ("Phone and Credit limit")
     changedFields: 'Changed: {{fields}}',
     orderLines_one: '{{formatted}} line · {{total}}',
     orderLines_other: '{{formatted}} lines · {{total}}',
+    // Step 20c: a POS return's line on the Sync page counts its lines, and shows no money
+    returnLines_one: '{{formatted}} line',
+    returnLines_other: '{{formatted}} lines',
     statuses: {
       waiting: 'Waiting',
       sending: 'Sending',
@@ -884,6 +891,7 @@ export const en = {
       purchase_refund: 'Supplier refund',
       pos_sale: 'POS sale',
       pos_shift: 'POS shift',
+      pos_return: 'POS return',
     },
     fromDocument: 'From {{document}}',
     stockEntryHint:
@@ -906,6 +914,9 @@ export const en = {
     // Step 20b (decision 28): the journal's Reverse refuses a shift's entries
     posShiftEntryHint:
       'A POS shift made this entry. It is not reversed: a wrong count is put right by the next shift’s opening count, and a wrong pay in or pay out by one the other way.',
+    // Step 20c (decision 25): a return is final, like a sale
+    posReturnEntryHint:
+      'A POS return made this entry. A return is final, so the entry is not reversed: goods taken back by mistake are sold again.',
     draftSaved: 'Draft saved',
     posted: '{{number}} posted',
     deleted: 'Draft deleted',
@@ -1520,6 +1531,7 @@ export const en = {
       purchase_receipt: 'Goods receipt',
       purchase_return: 'Sent back',
       pos_sale: 'Sold at a counter',
+      pos_return: 'Came back to a counter',
     },
     historyEmpty: 'No movement in these dates.',
   },
```

- **One new page, one nav item.** `posReturns` is under Sales, next to POS sales: a manager reads the returns where
  they read the sales.
- **`sync.commands.pos_return`** names a waiting return by its number (`POS1-R000012`), and **`returnLines`** says how
  many lines it has, never the money (decision 61). An exchange sale keeps 20a's name and line, and waits for its return
  with the Sync page's own "Waits for … to sync first".
- **`journal.sources.pos_return`** names the entries of a return, and **`posReturnEntryHint`** is the line the journal
  shows under one (decision 25). It says why there is no Reverse and what to do instead: goods taken back by mistake are
  sold again.
- **`stock.kinds.pos_return`** is the stock card's word for the movement. "Came back to a counter" sits next to 15d's
  "Came back", so a manager sees where the goods came in.

```diff
@@ -4003,6 +4015,16 @@ export const en = {
       '10': '10 minutes',
       '15': '15 minutes',
     },
+    // Step 20c: returns and exchanges (decisions 2, 6, 8)
+    returnsTitle: 'Returns',
+    returnsHint: 'A cashier with pos.return.create takes goods back by the receipt number.',
+    returnDays: 'Returns allowed for (days)',
+    returnDaysHint:
+      'Days after the sale, up to 365. 0 means the same day only. The POS refuses an older receipt.',
+    exchangeAccount: 'Exchange account',
+    exchangeHint:
+      'A return’s money that pays for a new sale passes through it and comes back to zero. A liability account, like 2190 POS exchange clearing.',
+    noExchange: 'No exchanges: refunds only',
     show: 'Show',
     statuses: { active: 'Active', archived: 'Archived' },
     columns: {
@@ -4097,7 +4119,8 @@ export const en = {
     // Taking the money (decision 5)
     payTitle: 'Take payment',
     payDescription: 'Total {{total}}. Split it over several methods if the customer asks.',
-    methods: { cash: 'Cash', card: 'Card', bkash: 'bKash', nagad: 'Nagad' },
+    // Step 20c (decision 10): exchange is a tender, never a button of the pay dialog
+    methods: { cash: 'Cash', card: 'Card', bkash: 'bKash', nagad: 'Nagad', exchange: 'Exchange' },
     method: 'Paid by',
     amount: 'Amount',
     reference: 'Reference',
```

The register's form gets a "Returns" group of two fields (decisions 2, 6, 8):

- **`returnDaysHint` says what 0 means and what the screen does with an older receipt.** "Days after the sale" is
  decision 8's rule, said the way a shop's notice says it ("exchanged within 7 days").
- **`exchangeHint` says why the account comes back to zero** and gives the example the retail template adds, 2190. An
  older workspace has no such account, and the hint tells the person what kind to add.
- **`noExchange` is the select's empty choice,** like `notTaken` for a method: it says what the empty box means for the
  counter, "refunds only", where an empty "Pick an account" would look like a field left out.
- **`pos.methods.exchange`** is decision 59. The comment above `methods` says why it is there and why the pay dialog
  never shows it.

```diff
@@ -4164,6 +4187,8 @@ export const en = {
       payOut: 'Pay out',
       close: 'Close shift',
       changeRegisterOpen: 'Shift {{number}} is open. Close it, then change the register.',
+      // Step 20c (decision 4): the X report, from the shift menu, offline too
+      xReport: 'Print X report',
     },
     // Pay in and pay out (decision 4), keyed by the reason's direction. The cashier never sees
     // what the drawer holds: that would end the blind count
@@ -4230,6 +4255,113 @@ export const en = {
       signOutBody:
         'Shift {{number}} is open on this device. Count the drawer and close the shift, then sign out.',
       signOutClose: 'Close shift',
+      // Step 20c (decision 4): the Z report, from the result
+      printZ: 'Print Z report',
+    },
+    // Step 20c: taking goods back (F6; decisions 7, 8, 13–19). By the receipt number: online any
+    // register's sale, offline this register's recent sales on the device
+    return: {
+      open: 'Return',
+      title: 'Take goods back',
+      description: 'Type the number on the customer’s receipt.',
+      number: 'Receipt number',
+      numberPlaceholder: 'POS1-000164',
+      find: 'Find the sale',
+      finding: 'Finding the sale…',
+      offlineHint:
+        'Offline, this device finds only the sales of {{code}} from the last {{days}} days.',
+      needsShift: 'Open a shift before you take goods back: the money leaves this drawer.',
+      cantReturn:
+        'Taking goods back needs the pos.return.create permission. Ask a workspace owner for it.',
+      // The sale and what is left of each line, in the sale line's unit (decision 17)
+      saleTitle: 'Return from {{number}}',
+      soldAt: 'Sold {{time}}',
+      lastDay: 'Goods can come back until {{date}}.',
+      take: 'Take back {{name}}',
+      left: '{{left}} of {{sold}} left to return',
+      allBack: 'All of it came back',
+      quantity: 'Coming back',
+      serials: 'Serial numbers that came back',
+      serialsHint: 'Tick one for each item that came back.',
+      lineBack: 'Back {{amount}}',
+      note: 'Why it came back',
+      notePlaceholder: 'Wrong size',
+      total: 'Money back',
+      next: 'Pay back {{amount}}',
+      // Paying the money back (decision 18): cash, or the ways the sale was paid
+      refundTitle: 'Pay the money back',
+      refundDescription: '{{total}} goes back. Give it in cash, or the way the customer paid.',
+      method: 'Paid back by',
+      addRefund: 'Add another method',
+      removeRefund: 'Remove refund {{number}}',
+      due: 'Still to give back',
+      given: 'Given back',
+      // Decision 1: the money pays for a new sale, so it never leaves the drawer
+      exchange: 'Exchange: use on a new sale',
+      exchangeHint: 'The money pays for the next sale, so the cash stays in the drawer.',
+      noExchange:
+        '{{code}} makes no exchanges. Someone with pos.register.manage picks an exchange account in Settings → POS registers.',
+      complete: 'Complete return',
+      completing: 'Saving the return…',
+      // Step 20c.6a: from the money back to what came back
+      back: 'Back',
+      // After the return. The slip prints at once; the return goes through the outbox
+      doneTitle: '{{number}} is done',
+      giveCash: 'Give back {{amount}} in cash',
+      giveOther: 'Send {{amount}} back by {{method}}',
+      noCash: 'No cash to give back',
+      // The thermal slip, like the receipt (the company lines reuse print.*)
+      receipt: {
+        title: 'Return',
+        ofSale: 'Return of {{number}}',
+        soldOn: 'Sold on {{date}}',
+        given: 'Given back',
+        usedOn: 'Used on sale {{number}}',
+      },
+    },
+    // Decision 7: the return's money on the next sale, saved with it at "Complete sale"
+    exchange: {
+      title: 'Exchange from {{number}}',
+      credit: '{{amount}} to spend on this sale',
+      payment: 'From return {{number}}',
+      rest: '{{amount}} of the return is left over. Give it back in cash, or the way the customer paid.',
+      drop: 'Drop the exchange',
+      dropHint: 'The cart is cleared, and the return goes back to paying the money back.',
+      // Step 20c.6a: Drop asks first (the mockup's open point 3)
+      dropTitle: 'Drop the exchange?',
+      keep: 'Keep the exchange',
+      // The close holds the cart; a cart with an exchange is not held (the goods came back)
+      closeFirst: 'Complete the exchange or drop it before you close the shift.',
+    },
+    // Decision 4: the X and Z reports on the receipt printer. The X report is blind (decision 9);
+    // the drawer's lines reuse posShifts.cash
+    report: {
+      titles: { x: 'X report', z: 'Z report' },
+      states: { x: 'Shift still open', z: 'Shift closed' },
+      shift: 'Shift {{number}}',
+      opened: 'Opened {{time}}',
+      closed: 'Closed {{time}}',
+      printed: 'Printed {{time}}',
+      sales_one: '{{formatted}} sale',
+      sales_other: '{{formatted}} sales',
+      returns_one: '{{formatted}} return',
+      returns_other: '{{formatted}} returns',
+      sold: 'Sold',
+      givenBack: 'Given back',
+      net: 'Taken in the end',
+      discount: 'Discounts given',
+      salesVat: 'VAT on sales',
+      returnsVat: 'VAT on returns',
+      taken: 'Taken',
+      refunded: 'Paid back',
+      nothing: 'Nothing',
+      paidIn: 'Paid in',
+      paidOut: 'Paid out',
+      drawer: 'Cash in the drawer',
+      counted: 'Counted',
+      difference: 'Difference',
+      blind: 'An X report has no drawer total: the count at the close shows it.',
+      noCount: 'Closed without a count, so there is no count to set against the expected cash.',
     },
     // Keyboard shortcuts (decision 12)
     shortcuts: 'Keyboard shortcuts',
@@ -4243,6 +4375,7 @@ export const en = {
       help: 'Show these shortcuts',
       hold: 'Hold the bill',
       held: 'Held bills',
+      return: 'Take goods back',
     },
     // The thermal receipt (decision 6), 58 or 80 mm. The company lines reuse print.*
     receipt: {
```

**`pos.shift.xReport` and `pos.close.printZ`** are the two buttons of decision 4: the X report from the shift menu, the
Z report from the close's result. **`pos.keys.return`** is the shortcuts dialog's line for F6.

**`pos.return`, taking goods back:**

- **The first step asks one thing, the receipt number,** with the paper's own format as the placeholder. `offlineHint`
  says what an offline device can find, with the register's code and the 30 days (decision 21), so a cashier knows why
  another counter's receipt is not found.
- **`needsShift` and `cantReturn`** are the two reasons the flow does not start (decisions 19 and 30). Both say what to
  do.
- **`left` says what is left in the sale line's unit** ("1 of 2 left to return", decision 17), and `allBack` replaces it
  when nothing is. `lastDay` gives the last day as a date, not a count, so 0 days reads "until 1 Nov 2026" like any
  other window.
- **`note` and `notePlaceholder`** are the return's optional note (20c.1, at most 200 characters): why it came back,
  the first thing a manager asks.
- **The refund dialog reads like the pay dialog,** row for row: `method`, the amount and the reference reuse
  `pos.amount` and `pos.reference`, and `due` and `given` sit where the pay dialog has "Still to pay" and "Paid".
  `refundDescription` says decision 18's rule: cash, or the way the customer paid.
- **`exchange` and `exchangeHint`** are decision 1's button, and say what it does for the drawer. `noExchange` takes
  its place on a register without an exchange account (decision 6), and says who sets one.
- **`giveCash`, `giveOther` and `noCash`** are the done dialog's headline, like the sale's "Give back ৳200 in cash".
  `giveOther` names the method, because a bKash refund is sent from the shop's phone, not handed over.
- **`receipt`** holds the slip's own lines; the company lines, the date and the items reuse the receipt's.

**`pos.exchange`, the return's money on the next sale** (decision 7): the cart's banner (`title`, `credit`), the pay
dialog's row (`payment`, the same words as the sale page's `fromReturn`), the sentence when the sale costs less than
the return (`rest`), and the way back (`drop`, `dropHint`): dropping the cart sends the return back to the refund
dialog, so no money is left open.

**`pos.report`, the X and Z reports:**

- **`titles` and `states` are keyed by `PosShiftReportKind`** (`x`, `z`), so the sheet writes
  `` t(`pos.report.titles.${kind}`) `` with no map of its own.
- **The counts have plural keys** (`sales_one` / `_other`), and the amounts are labelled the way a shopkeeper adds them:
  sold, given back, taken in the end (`shiftNetOf()`).
- **`taken` and `refunded` head the per-tender lists,** and each row is `pos.methods.*` (decision 59). `nothing` is the
  line under a heading with no amount, so an empty list still prints.
- **The drawer's lines reuse `posShifts.cash`,** with `counted` and `difference` added, so the Z report and the shift's
  page use the same words for the same numbers.
- **`blind` is decision 63, and `noCount` is the Z of a shift closed without a count** (`drawer` is `null`).

```diff
@@ -4297,6 +4430,12 @@ export const en = {
     payments: 'Payments',
     paid: 'Paid',
     change: 'Change',
+    // Step 20c (decision 31): what came back of a line, an exchange payment's return, the returns
+    lineReturned: '{{quantity}} came back',
+    fromReturn: 'From return {{number}}',
+    returnsTitle: 'Returns',
+    returnsSubtitle: 'The POS returns that took goods of this sale back, oldest first',
+    noReturns: 'Nothing came back.',
     entry: 'Journal entry',
     print: 'Print receipt',
     // Decision 26: the day it was sold was closed, so the books hold it on the first open day
@@ -4382,11 +4521,22 @@ export const en = {
       changeGiven: 'Change given',
       paidIn: 'Paid in',
       paidOut: 'Paid out',
+      // Step 20c (decision 26)
+      cashRefunded: 'Cash paid back',
       expected: 'Expected',
     },
     payments: 'Taken by method',
     sales_one: '{{formatted}} sale · {{total}}',
     sales_other: '{{formatted}} sales · {{total}}',
+    // Step 20c (decision 27): what the returns paid back, and the Z report's sums
+    refunds: 'Paid back by method',
+    returns_one: '{{formatted}} return · {{total}}',
+    returns_other: '{{formatted}} returns · {{total}}',
+    seeReturns: 'See the returns',
+    salesDiscount: 'Discounts on sales',
+    salesVat: 'VAT on sales',
+    returnsVat: 'VAT on returns',
+    printZ: 'Print Z report',
     movements: 'Pay ins and pay outs',
     movementColumns: {
       time: 'Time',
```

- **`posSales`** gets what decision 31 shows on a sale's page: `lineReturned` under a line, `fromReturn` on an exchange
  payment, and a "Returns" block with its empty line.
- **`posShifts.cash.cashRefunded`** sits before `expected`, in the order of `expectedCashOf()` (decision 26), so a
  manager can add the column up by hand.
- **`posShifts`** also gets the Z report's sums of decision 27, with the same labels as the report, the returns' count
  line (`returns_one` / `_other`, like `sales_*`), a link to the shift's returns (`seeReturns`) and `printZ`.

```diff
@@ -4465,6 +4615,59 @@ export const en = {
       'A reason you no longer use can be archived. The money it moved stays in the books.',
     loadFailed: "Couldn't load the reasons. Refresh the page to try again.",
   },
+  // Step 20c: the managers' list of POS returns and a return's page (decisions 30–32)
+  posReturns: {
+    title: 'POS returns',
+    description: 'What the counters took back, and how the money went back',
+    back: 'POS returns',
+    register: 'Register',
+    allRegisters: 'All registers',
+    // Step 20c (20c.6b): the list opened from a shift's page ("See the returns") names its shift
+    ofShift: 'The returns of shift {{number}}',
+    showAll: 'Show every return',
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      sale: 'Sale',
+      register: 'Register',
+      customer: 'Customer',
+      cashier: 'Cashier',
+      total: 'Given back',
+      status: 'Status',
+    },
+    posted: 'Posted',
+    // Decision 32: it came after the register's window; the server took it all the same
+    outsideWindow: 'After the window',
+    // Decision 1: its money paid for a new sale
+    exchangeFor: 'Exchanged for {{number}}',
+    walkIn: 'Walk-in',
+    sale: 'Sale',
+    soldOn: 'Sold on',
+    shift: 'Shift',
+    returnedAt: 'Taken back at',
+    device: 'Device',
+    cashier: 'Cashier',
+    customer: 'Customer',
+    note: 'Why it came back',
+    lines: 'Items',
+    batches: 'Back into batch {{lot}} · {{quantity}}',
+    serials: 'Serial numbers: {{serials}}',
+    refunds: 'Paid back',
+    usedOn: 'Used on {{number}}',
+    entry: 'Journal entry',
+    print: 'Print return slip',
+    // Like a sale (20a decision 26): the day it came back was closed in the books
+    bookedLater:
+      'Taken back on {{returned}}. That day was closed in the books, so the return is on {{date}}.',
+    outsideWindowNotice:
+      '{{number}} was older than {{register}} takes goods back for. The books took the return all the same, and the audit log has it.',
+    notFound: "This POS return doesn't exist.",
+    needsConnection: 'POS returns are read from the server. Connect to the internet to see them.',
+    emptyTitle: 'No POS returns yet',
+    emptyBody:
+      'Goods a counter takes back show here once its device syncs: a shirt in the wrong size, a phone case that does not fit.',
+    loadFailed: "Couldn't load the POS returns. Refresh the page to try again.",
+  },
   approvals: {
     title: 'Approvals',
     description: 'Documents waiting for your decision, oldest first',
```

**`posReturns`, the managers' list and a return's page,** a new section before `approvals`:

- **`columns.total` is "Given back"** (decision 60), and `sale` links the receipt it came from.
- **`outsideWindow` and `exchangeFor`** are decision 32's two facts as pills: "After the window" and "Exchanged for
  POS1-000377". `outsideWindowNotice` is the page's longer sentence: what happened and that the audit log has it, so a
  manager knows where to look for who did it.
- **`batches` says "Back into batch …",** because on a return the batch is where the goods went, not where they came
  from (decision 52).
- **`bookedLater`** is 20a's rule for a sale, for a return: the day on the device was closed in the books.
- **The rest follows `posSales`,** key for key, so the two pages read alike.

```diff
@@ -5009,6 +5212,10 @@ export const en = {
       shift: {
         manage: 'See every register’s shifts and counts, and close a stuck shift without a count',
       },
+      // Step 20c (decision 30)
+      return: {
+        create: 'Take goods back at a POS counter, and pay the money back or use it on a new sale',
+      },
     },
   },
   invite: {
@@ -5083,6 +5290,7 @@ export const en = {
       pos_sale: 'POS sales',
       pos_cash_reason: 'POS cash reasons',
       pos_shift: 'POS shifts',
+      pos_return: 'POS returns',
     },
     columns: {
       when: 'When',
@@ -5390,6 +5598,15 @@ export const en = {
         expected_differs: 'The device and the server expected different cash at a close',
         without_permission: 'Worked a POS shift after losing the permission',
       },
+      // Step 20c (decision 20): the server takes every return, and writes what it would have
+      // refused
+      pos_return: {
+        created: 'Took goods back at a POS counter',
+        outside_window: 'Took goods back after the register’s days for returns',
+        over_returned: 'Took back more of a sale line than was left',
+        amounts_differ: 'The device and the server worked out different money back',
+        without_permission: 'Took goods back at a POS counter after losing the permission',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -5557,6 +5774,12 @@ export const en = {
       heldDropped: 'Held bills dropped',
       kept: 'Saved on the shift',
       by: 'Closed by',
+      // Step 20c: a register's return settings, and a return's rows
+      exchangeAccount: 'Exchange account',
+      returnDays: 'Returns allowed for (days)',
+      returnedOn: 'Date on the device',
+      sale: 'Sale',
+      refunds: 'Paid back',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
```

- **`permissions.pos.return.create`** says the three things it allows in the cashier's words: take goods back, pay the
  money back, or use it on a new sale.
- **`audit.actions.pos_return`** say what happened in each of decision 20's rows. `amounts_differ` names the two sides,
  like 20b's `expected_differs`.
- **`audit.fields`** label the keys 20c.3 writes: the register's `exchangeAccount` and `returnDays`, and a return's
  `returnedOn` (the day on the device, like `soldOn`), `sale` and `refunds`. The others (`number`, `date`, `register`,
  `total`, `entry`, `lines`, `soldOn`, `missing`) are there from earlier steps.

```diff
@@ -6307,6 +6530,38 @@ export const en = {
       'The server still has the last shift of this register open. This should not happen: keep the drawer as it is and tell your Omnivo administrator.',
     pos_shift_unknown:
       'The server doesn’t know this shift. This should not happen: keep the paper receipts and tell your Omnivo administrator.',
+    // Step 20c: returns
+    pos_return_days_format: 'Type whole days from 0 to 365, like 7. 0 means the same day only.',
+    pos_exchange_account_invalid:
+      'Pick an active liability account that is not a group, like 2190 POS exchange clearing.',
+    // The cashier's return screen (decision 33)
+    pos_return_sale_not_found:
+      'No sale has this receipt number. Check the number on the paper. Offline, this device finds only its own register’s recent sales: connect to find another counter’s.',
+    pos_return_too_old:
+      'This sale is older than this register takes goods back for. Someone with pos.register.manage can allow more days in Settings → POS registers.',
+    pos_return_nothing_left:
+      'Everything on this receipt came back already. The sale’s page lists its returns.',
+    pos_return_quantity_too_large:
+      'That is more than is left to return. Type no more than the line shows.',
+    pos_return_lines_required: 'Tick at least one item that came back.',
+    pos_refund_amount_required: 'Type an amount above zero, or remove this row.',
+    pos_refund_mismatch:
+      'The money back must add up to the return’s total. Change an amount until nothing is left to give back.',
+    pos_exchange_not_set:
+      'This register has no exchange account now. Someone with pos.register.manage picks one in Settings → POS registers; then send the return again from the Sync page.',
+    // Bugs: never a cashier's mistake
+    pos_exchange_invalid:
+      'This exchange does not match its return. This should not happen: keep the paper receipts and tell your Omnivo administrator.',
+    pos_return_unknown:
+      'The server doesn’t know the return this sale pays with. This should not happen: keep the paper receipts and tell your Omnivo administrator.',
+    pos_return_number_taken:
+      'Another return of this register has this number. This should not happen: keep the paper slip and tell your Omnivo administrator.',
+    pos_return_line_twice:
+      'A line of the sale is on this return twice. This should not happen: keep the paper slip and tell your Omnivo administrator.',
+    pos_return_line_unknown:
+      'A line of this return is not on its sale. This should not happen: keep the paper slip and tell your Omnivo administrator.',
+    pos_return_serial_invalid:
+      'A serial number on this return is not one the sale sold. This should not happen: keep the paper slip and tell your Omnivo administrator.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **The errors say how to fix the problem** (CLAUDE.md → Copy). Four are worth a word:
  - **`pos_return_sale_not_found`** is decision 62: one sentence for online and offline, ending with what to do.
  - **`pos_return_too_old`** names who can change the rule and where, because the cashier can't (decision 2).
  - **`pos_refund_mismatch`** says the money back must add up exactly (decision 15): a return gives no change.
  - **`pos_exchange_not_set`** is a refusal someone can fix (decision 20), so it says the two steps: set the account,
    then send the return again from the Sync page, like `pos_method_not_set`.
- **The six bugs** (`pos_exchange_invalid` to `pos_return_serial_invalid`) end like 20a's `pos_number_taken`: what to
  keep (the paper receipts, or the return slip) while someone looks for the bug.

### `locales/bn.ts`

```diff
@@ -122,6 +122,7 @@ export const bn: Messages = {
     soldShort: 'স্টকের বেশি বিক্রি',
     posShifts: 'POS শিফট',
     cashReasons: 'POS ক্যাশের কারণ',
+    posReturns: 'POS ফেরত',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -499,11 +500,14 @@ export const bn: Messages = {
       pos_sale: { create: 'বিক্রি {{name}}' },
       pos_shift: { open: 'শিফট {{name}} খোলা', close: 'শিফট {{name}} বন্ধ' },
       pos_cash_movement: { create: 'ড্রয়ার: {{name}}' },
+      pos_return: { create: 'ফেরত {{name}}' },
     },
     savedAt: 'সেভ হয়েছে {{time}}',
     changedFields: 'বদলেছে: {{fields}}',
     orderLines_one: '{{formatted}}টা লাইন · {{total}}',
     orderLines_other: '{{formatted}}টা লাইন · {{total}}',
+    returnLines_one: '{{formatted}}টা লাইন',
+    returnLines_other: '{{formatted}}টা লাইন',
     statuses: {
       waiting: 'অপেক্ষায়',
       sending: 'পাঠানো হচ্ছে',
@@ -801,6 +805,7 @@ export const bn: Messages = {
       purchase_refund: 'সাপ্লায়ার রিফান্ড',
       pos_sale: 'POS বিক্রি',
       pos_shift: 'POS শিফট',
+      pos_return: 'POS ফেরত',
     },
     fromDocument: '{{document}} থেকে',
     stockEntryHint:
@@ -823,6 +828,8 @@ export const bn: Messages = {
       'একটা সাপ্লায়ার রিফান্ড এই এন্ট্রি বানিয়েছে। ফেরাতে চাইলে রিফান্ডের নিজের পেজে সেটা ভয়েড করুন।',
     posShiftEntryHint:
       'একটা POS শিফট এই এন্ট্রি বানিয়েছে। এটা রিভার্স হয় না: ভুল গোনা ঠিক হয় পরের শিফটের শুরুর গোনায়, আর ভুল ক্যাশ ইন বা ক্যাশ আউট উল্টো দিকের আরেকটা দিয়ে।',
+    posReturnEntryHint:
+      'একটা POS ফেরত এই এন্ট্রি বানিয়েছে। ফেরত চূড়ান্ত, তাই এন্ট্রিটা রিভার্স হয় না: ভুল করে ফেরত নেওয়া মাল আবার বিক্রি করুন।',
     draftSaved: 'ড্রাফট সেভ হয়েছে',
     posted: '{{number}} পোস্ট হয়েছে',
     deleted: 'ড্রাফট মোছা হয়েছে',
@@ -1433,6 +1440,7 @@ export const bn: Messages = {
       purchase_receipt: 'মাল গ্রহণ',
       purchase_return: 'ফেরত পাঠানো',
       pos_sale: 'কাউন্টারে বিক্রি',
+      pos_return: 'কাউন্টারে ফেরত এসেছে',
     },
     historyEmpty: 'এই তারিখগুলোর মধ্যে কোনো মুভমেন্ট নেই।',
   },
@@ -3799,6 +3807,15 @@ export const bn: Messages = {
       '10': '১০ মিনিট পর',
       '15': '১৫ মিনিট পর',
     },
+    returnsTitle: 'ফেরত',
+    returnsHint: 'pos.return.create আছে এমন ক্যাশিয়ার রিসিট নম্বর দিয়ে মাল ফেরত নেন।',
+    returnDays: 'কত দিন পর্যন্ত ফেরত নেওয়া যাবে',
+    returnDaysHint:
+      'বিক্রির পর কত দিন, ৩৬৫ পর্যন্ত। ০ মানে শুধু সেদিনই। এর চেয়ে পুরনো রিসিট POS নেয় না।',
+    exchangeAccount: 'এক্সচেঞ্জ অ্যাকাউন্ট',
+    exchangeHint:
+      'ফেরতের যে টাকা নতুন বিক্রির দাম মেটায়, তা এর ভেতর দিয়ে যায় আর আবার শূন্যে ফেরে। একটা দায়ের অ্যাকাউন্ট, যেমন 2190 POS exchange clearing।',
+    noExchange: 'এক্সচেঞ্জ নয়: শুধু টাকা ফেরত',
     show: 'দেখান',
     statuses: { active: 'চালু', archived: 'আর্কাইভ' },
     columns: {
@@ -3883,7 +3900,7 @@ export const bn: Messages = {
     priceChanged: '{{price}} থেকে বদলানো',
     payTitle: 'টাকা নিন',
     payDescription: 'মোট {{total}}। গ্রাহক চাইলে কয়েকভাবে ভাগ করে নিন।',
-    methods: { cash: 'নগদ', card: 'কার্ড', bkash: 'bKash', nagad: 'Nagad' },
+    methods: { cash: 'নগদ', card: 'কার্ড', bkash: 'bKash', nagad: 'Nagad', exchange: 'এক্সচেঞ্জ' },
     method: 'যেভাবে দিয়েছেন',
     amount: 'টাকা',
     reference: 'রেফারেন্স',
@@ -3941,6 +3958,7 @@ export const bn: Messages = {
       payOut: 'ক্যাশ আউট',
       close: 'শিফট বন্ধ করুন',
       changeRegisterOpen: 'শিফট {{number}} খোলা আছে। এটা বন্ধ করে তারপর রেজিস্টার বদলান।',
+      xReport: 'X রিপোর্ট প্রিন্ট করুন',
     },
     cash: {
       titles: { in: 'ক্যাশ ইন', out: 'ক্যাশ আউট' },
@@ -4004,6 +4022,98 @@ export const bn: Messages = {
       signOutBody:
         'এই ডিভাইসে শিফট {{number}} খোলা আছে। ড্রয়ার গুনে শিফট বন্ধ করুন, তারপর সাইন আউট করুন।',
       signOutClose: 'শিফট বন্ধ করুন',
+      printZ: 'Z রিপোর্ট প্রিন্ট করুন',
+    },
+    return: {
+      open: 'ফেরত',
+      title: 'মাল ফেরত নিন',
+      description: 'গ্রাহকের রিসিটের নম্বরটা লিখুন।',
+      number: 'রিসিট নম্বর',
+      numberPlaceholder: 'POS1-000164',
+      find: 'বিক্রিটা খুঁজুন',
+      finding: 'বিক্রিটা খোঁজা হচ্ছে…',
+      offlineHint: 'অফলাইনে এই ডিভাইস শুধু {{code}}-এর গত {{days}} দিনের বিক্রি খুঁজে পায়।',
+      needsShift: 'মাল ফেরত নেওয়ার আগে একটা শিফট খুলুন: টাকা এই ড্রয়ার থেকেই যায়।',
+      cantReturn:
+        'মাল ফেরত নিতে pos.return.create permission লাগে। একজন workspace owner-এর কাছে সেটা চান।',
+      saleTitle: '{{number}} থেকে ফেরত',
+      soldAt: 'বিক্রি {{time}}',
+      lastDay: '{{date}} পর্যন্ত মাল ফেরত নেওয়া যাবে।',
+      take: '{{name}} ফেরত নিন',
+      left: '{{sold}}-এর মধ্যে {{left}} এখনো ফেরত নেওয়া যায়',
+      allBack: 'সবটাই ফেরত এসেছে',
+      quantity: 'ফেরত আসছে',
+      serials: 'যে সিরিয়াল নম্বরগুলো ফেরত এল',
+      serialsHint: 'ফেরত আসা প্রতিটা আইটেমের জন্য একটা করে টিক দিন।',
+      lineBack: 'ফেরত {{amount}}',
+      note: 'কেন ফেরত এল',
+      notePlaceholder: 'সাইজ মেলেনি',
+      total: 'ফেরতের টাকা',
+      next: '{{amount}} ফেরত দিন',
+      refundTitle: 'টাকা ফেরত দিন',
+      refundDescription: '{{total}} ফেরত যাবে। নগদে দিন, বা গ্রাহক যেভাবে দিয়েছিলেন সেভাবে।',
+      method: 'যেভাবে ফেরত',
+      addRefund: 'আরেকভাবে ফেরত যোগ করুন',
+      removeRefund: 'ফেরত {{number}} সরান',
+      due: 'এখনো ফেরত দেওয়া বাকি',
+      given: 'ফেরত দেওয়া হয়েছে',
+      exchange: 'এক্সচেঞ্জ: নতুন বিক্রিতে লাগান',
+      exchangeHint: 'টাকাটা পরের বিক্রির দাম মেটায়, তাই নগদ ড্রয়ারেই থাকে।',
+      noExchange:
+        '{{code}}-এ এক্সচেঞ্জ হয় না। pos.register.manage আছে এমন কেউ সেটিংস → POS রেজিস্টারে একটা এক্সচেঞ্জ অ্যাকাউন্ট বাছবেন।',
+      complete: 'ফেরত শেষ করুন',
+      back: 'পেছনে',
+      completing: 'ফেরত সেভ হচ্ছে…',
+      doneTitle: '{{number}} শেষ',
+      giveCash: 'নগদে {{amount}} ফেরত দিন',
+      giveOther: '{{method}}-এ {{amount}} ফেরত পাঠান',
+      noCash: 'নগদ ফেরত দেওয়ার কিছু নেই',
+      receipt: {
+        title: 'ফেরত',
+        ofSale: '{{number}}-এর ফেরত',
+        soldOn: 'বিক্রি {{date}}',
+        given: 'ফেরত দেওয়া',
+        usedOn: 'বিক্রি {{number}}-এ লাগানো হয়েছে',
+      },
+    },
+    exchange: {
+      title: '{{number}} থেকে এক্সচেঞ্জ',
+      credit: 'এই বিক্রিতে {{amount}} লাগানো যাবে',
+      payment: 'ফেরত {{number}} থেকে',
+      rest: 'ফেরতের {{amount}} বাকি থাকে। সেটা নগদে দিন, বা গ্রাহক যেভাবে দিয়েছিলেন সেভাবে।',
+      drop: 'এক্সচেঞ্জ বাদ দিন',
+      dropHint: 'কার্ট খালি হয়, আর ফেরতটা আবার টাকা ফেরত দেওয়ার ধাপে যায়।',
+      dropTitle: 'এক্সচেঞ্জ বাদ দেবেন?',
+      keep: 'এক্সচেঞ্জ রাখুন',
+      closeFirst: 'শিফট বন্ধ করার আগে এক্সচেঞ্জটা শেষ করুন, বা বাদ দিন।',
+    },
+    report: {
+      titles: { x: 'X রিপোর্ট', z: 'Z রিপোর্ট' },
+      states: { x: 'শিফট এখনো খোলা', z: 'শিফট বন্ধ' },
+      shift: 'শিফট {{number}}',
+      opened: 'খোলা {{time}}',
+      closed: 'বন্ধ {{time}}',
+      printed: 'প্রিন্ট {{time}}',
+      sales_one: '{{formatted}}টা বিক্রি',
+      sales_other: '{{formatted}}টা বিক্রি',
+      returns_one: '{{formatted}}টা ফেরত',
+      returns_other: '{{formatted}}টা ফেরত',
+      sold: 'বিক্রি',
+      givenBack: 'ফেরত দেওয়া',
+      net: 'শেষে নেওয়া',
+      discount: 'দেওয়া ছাড়',
+      salesVat: 'বিক্রির VAT',
+      returnsVat: 'ফেরতের VAT',
+      taken: 'নেওয়া',
+      refunded: 'ফেরত দেওয়া',
+      nothing: 'কিছু নয়',
+      paidIn: 'ক্যাশ ইন',
+      paidOut: 'ক্যাশ আউট',
+      drawer: 'ড্রয়ারের নগদ',
+      counted: 'গোনা',
+      difference: 'পার্থক্য',
+      blind: 'X রিপোর্টে ড্রয়ারের মোট থাকে না: বন্ধের সময়ের গোনা সেটা দেখায়।',
+      noCount: 'না গুনে বন্ধ হয়েছে, তাই থাকার কথা নগদের সাথে মেলানোর মতো কোনো গোনা নেই।',
     },
     shortcuts: 'কিবোর্ড শর্টকাট',
     keys: {
@@ -4016,6 +4126,7 @@ export const bn: Messages = {
       help: 'এই শর্টকাটগুলো দেখান',
       hold: 'বিল হোল্ড',
       held: 'হোল্ড করা বিল',
+      return: 'মাল ফেরত নিন',
     },
     receipt: {
       title: 'রিসিট',
@@ -4067,6 +4178,11 @@ export const bn: Messages = {
     payments: 'পেমেন্ট',
     paid: 'দেওয়া হয়েছে',
     change: 'ভাংতি',
+    lineReturned: '{{quantity}} ফেরত এসেছে',
+    fromReturn: 'ফেরত {{number}} থেকে',
+    returnsTitle: 'ফেরত',
+    returnsSubtitle: 'যে POS ফেরতে এই বিক্রির মাল ফেরত এসেছে, পুরনোটা আগে',
+    noReturns: 'কিছু ফেরত আসেনি।',
     entry: 'জার্নাল এন্ট্রি',
     print: 'রিসিট প্রিন্ট করুন',
     bookedLater:
@@ -4145,11 +4261,20 @@ export const bn: Messages = {
       changeGiven: 'ভাংতি দেওয়া',
       paidIn: 'ক্যাশ ইন',
       paidOut: 'ক্যাশ আউট',
+      cashRefunded: 'নগদ ফেরত দেওয়া',
       expected: 'থাকার কথা',
     },
     payments: 'যেভাবে টাকা নেওয়া হয়েছে',
     sales_one: '{{formatted}}টা বিক্রি · {{total}}',
     sales_other: '{{formatted}}টা বিক্রি · {{total}}',
+    refunds: 'যেভাবে টাকা ফেরত দেওয়া হয়েছে',
+    returns_one: '{{formatted}}টা ফেরত · {{total}}',
+    returns_other: '{{formatted}}টা ফেরত · {{total}}',
+    seeReturns: 'ফেরতগুলো দেখুন',
+    salesDiscount: 'বিক্রিতে ছাড়',
+    salesVat: 'বিক্রির VAT',
+    returnsVat: 'ফেরতের VAT',
+    printZ: 'Z রিপোর্ট প্রিন্ট করুন',
     movements: 'ক্যাশ ইন আর ক্যাশ আউট',
     movementColumns: {
       time: 'সময়',
@@ -4223,6 +4348,54 @@ export const bn: Messages = {
       'যে কারণ আর লাগে না, সেটা আর্কাইভ করা যায়। তার সরানো টাকা খাতায় থেকে যায়।',
     loadFailed: 'কারণের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  posReturns: {
+    title: 'POS ফেরত',
+    description: 'কাউন্টারগুলো যা ফেরত নিয়েছে, আর টাকা যেভাবে ফেরত গেছে',
+    back: 'POS ফেরত',
+    register: 'রেজিস্টার',
+    allRegisters: 'সব রেজিস্টার',
+    ofShift: 'শিফট {{number}}-এর ফেরত',
+    showAll: 'সব ফেরত দেখুন',
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      sale: 'বিক্রি',
+      register: 'রেজিস্টার',
+      customer: 'গ্রাহক',
+      cashier: 'ক্যাশিয়ার',
+      total: 'ফেরত দেওয়া',
+      status: 'অবস্থা',
+    },
+    posted: 'পোস্ট করা',
+    outsideWindow: 'মেয়াদের পরে',
+    exchangeFor: '{{number}}-এর সাথে এক্সচেঞ্জ',
+    walkIn: 'ওয়াক-ইন',
+    sale: 'বিক্রি',
+    soldOn: 'বিক্রির তারিখ',
+    shift: 'শিফট',
+    returnedAt: 'ফেরত নেওয়ার সময়',
+    device: 'ডিভাইস',
+    cashier: 'ক্যাশিয়ার',
+    customer: 'গ্রাহক',
+    note: 'কেন ফেরত এল',
+    lines: 'আইটেম',
+    batches: 'ব্যাচ {{lot}}-এ ফেরত · {{quantity}}',
+    serials: 'সিরিয়াল নম্বর: {{serials}}',
+    refunds: 'ফেরত দেওয়া',
+    usedOn: '{{number}}-এ লাগানো হয়েছে',
+    entry: 'জার্নাল এন্ট্রি',
+    print: 'ফেরতের স্লিপ প্রিন্ট করুন',
+    bookedLater:
+      '{{returned}} তারিখে ফেরত নেওয়া। সেই দিন হিসাবের খাতায় বন্ধ ছিল, তাই ফেরতটা {{date}} তারিখে উঠেছে।',
+    outsideWindowNotice:
+      '{{register}} যত দিন পর্যন্ত মাল ফেরত নেয়, {{number}} তার চেয়ে পুরনো ছিল। খাতা তবুও ফেরতটা নিয়েছে, আর অডিট লগে সেটা লেখা আছে।',
+    notFound: 'এই POS ফেরত নেই।',
+    needsConnection: 'POS ফেরত সার্ভার থেকে পড়া হয়। দেখতে ইন্টারনেটে যুক্ত হন।',
+    emptyTitle: 'এখনো কোনো POS ফেরত নেই',
+    emptyBody:
+      'কাউন্টার যা ফেরত নেয়, তার ডিভাইস সিঙ্ক হলে এখানে দেখা যায়: ভুল সাইজের শার্ট, না মেলা ফোন কভার।',
+    loadFailed: 'POS ফেরতের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   approvals: {
     title: 'অনুমোদন',
     description: 'যে ডকুমেন্টগুলো আপনার সিদ্ধান্তের অপেক্ষায়, সবচেয়ে পুরনোটা আগে',
@@ -4736,6 +4909,9 @@ export const bn: Messages = {
       price: { override: 'POS-এ দাম বদলানো, বা রেজিস্টারের সীমার বেশি ছাড় দেওয়া' },
       register: { manage: 'POS রেজিস্টার যোগ, বদল আর আর্কাইভ' },
       shift: { manage: 'সব রেজিস্টারের শিফট আর গোনা দেখা, আর আটকে থাকা শিফট না গুনে বন্ধ করা' },
+      return: {
+        create: 'POS কাউন্টারে মাল ফেরত নেওয়া, আর টাকা ফেরত দেওয়া বা নতুন বিক্রিতে লাগানো',
+      },
     },
   },
   invite: {
@@ -4810,6 +4986,7 @@ export const bn: Messages = {
       pos_sale: 'POS বিক্রি',
       pos_cash_reason: 'POS ক্যাশের কারণ',
       pos_shift: 'POS শিফট',
+      pos_return: 'POS ফেরত',
     },
     columns: {
       when: 'কখন',
@@ -5110,6 +5287,13 @@ export const bn: Messages = {
         expected_differs: 'বন্ধের সময় ডিভাইস আর সার্ভার আলাদা নগদ আশা করেছিল',
         without_permission: 'অনুমতি চলে যাওয়ার পরে POS শিফটে কাজ করেছেন',
       },
+      pos_return: {
+        created: 'POS কাউন্টারে মাল ফেরত নিয়েছেন',
+        outside_window: 'রেজিস্টারের ফেরতের মেয়াদ পার হওয়ার পরে মাল ফেরত নিয়েছেন',
+        over_returned: 'বিক্রির একটা লাইনের যতটা বাকি ছিল, তার বেশি ফেরত নিয়েছেন',
+        amounts_differ: 'ডিভাইস আর সার্ভার ফেরতের টাকা আলাদা হিসাব করেছে',
+        without_permission: 'অনুমতি চলে যাওয়ার পরে POS কাউন্টারে মাল ফেরত নিয়েছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -5274,6 +5458,11 @@ export const bn: Messages = {
       heldDropped: 'বাদ দেওয়া হোল্ড বিল',
       kept: 'শিফটে সেভ হয়েছে',
       by: 'যে বন্ধ করেছে',
+      exchangeAccount: 'এক্সচেঞ্জ অ্যাকাউন্ট',
+      returnDays: 'ফেরতের মেয়াদ (দিন)',
+      returnedOn: 'ডিভাইসের তারিখ',
+      sale: 'বিক্রি',
+      refunds: 'ফেরত দেওয়া',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -5990,6 +6179,35 @@ export const bn: Messages = {
       'সার্ভারে এই রেজিস্টারের আগের শিফট এখনো খোলা। এমন হওয়ার কথা নয়: ড্রয়ার যেমন আছে রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
     pos_shift_unknown:
       'সার্ভার এই শিফট চেনে না। এমন হওয়ার কথা নয়: কাগজের রিসিটগুলো রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_return_days_format: '০ থেকে ৩৬৫-এর মধ্যে পুরো দিন লিখুন, যেমন ৭। ০ মানে শুধু সেদিনই।',
+    pos_exchange_account_invalid:
+      'একটা চালু দায়ের অ্যাকাউন্ট বাছুন, যেটা গ্রুপ নয়, যেমন 2190 POS exchange clearing।',
+    pos_return_sale_not_found:
+      'এই রিসিট নম্বরে কোনো বিক্রি নেই। কাগজের নম্বরটা মিলিয়ে দেখুন। অফলাইনে এই ডিভাইস শুধু নিজের রেজিস্টারের সাম্প্রতিক বিক্রি খুঁজে পায়: আরেক কাউন্টারের বিক্রি খুঁজতে ইন্টারনেটে যুক্ত হন।',
+    pos_return_too_old:
+      'এই রেজিস্টার যত দিন পর্যন্ত মাল ফেরত নেয়, বিক্রিটা তার চেয়ে পুরনো। pos.register.manage আছে এমন কেউ সেটিংস → POS রেজিস্টারে দিন বাড়াতে পারেন।',
+    pos_return_nothing_left:
+      'এই রিসিটের সবকিছু আগেই ফেরত এসেছে। বিক্রির পেজে তার ফেরতগুলোর তালিকা আছে।',
+    pos_return_quantity_too_large:
+      'যতটা ফেরত নেওয়া বাকি, এটা তার বেশি। লাইনে যা দেখাচ্ছে, তার বেশি লিখবেন না।',
+    pos_return_lines_required: 'ফেরত আসা অন্তত একটা আইটেমে টিক দিন।',
+    pos_refund_amount_required: 'শূন্যের বেশি একটা অঙ্ক দিন, বা এই সারিটা সরান।',
+    pos_refund_mismatch:
+      'ফেরতের টাকা যোগ করে ফেরতের মোটের সমান হতে হবে। ফেরত দেওয়া বাকি কিছু না থাকা পর্যন্ত অঙ্ক বদলান।',
+    pos_exchange_not_set:
+      'রেজিস্টারে এখন কোনো এক্সচেঞ্জ অ্যাকাউন্ট নেই। pos.register.manage আছে এমন কেউ সেটিংস → POS রেজিস্টারে একটা বাছবেন; তারপর Sync পেজ থেকে ফেরতটা আবার পাঠান।',
+    pos_exchange_invalid:
+      'এই এক্সচেঞ্জ তার ফেরতের সাথে মেলে না। এমন হওয়ার কথা নয়: কাগজের রিসিটগুলো রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_return_unknown:
+      'এই বিক্রি যে ফেরতের টাকায় দাম মেটায়, সার্ভার সেটা চেনে না। এমন হওয়ার কথা নয়: কাগজের রিসিটগুলো রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_return_number_taken:
+      'এই রেজিস্টারের আরেকটা ফেরতে এই নম্বর আছে। এমন হওয়ার কথা নয়: কাগজের স্লিপটা রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_return_line_twice:
+      'বিক্রির একটা লাইন এই ফেরতে দুবার আছে। এমন হওয়ার কথা নয়: কাগজের স্লিপটা রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_return_line_unknown:
+      'এই ফেরতের একটা লাইন তার বিক্রিতে নেই। এমন হওয়ার কথা নয়: কাগজের স্লিপটা রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_return_serial_invalid:
+      'এই ফেরতের একটা সিরিয়াল নম্বর বিক্রিটা বিক্রি করেনি। এমন হওয়ার কথা নয়: কাগজের স্লিপটা রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. Office words stay in English as the
  app already writes them: POS, permission, workspace, Sync, and the permission keys themselves (CLAUDE.md → Language).
- **A return is ফেরত, and taking goods back is মাল ফেরত নেওয়া,** the words of 15d's sales returns. Paying back is টাকা
  ফেরত দেওয়া. An exchange is এক্সচেঞ্জ, as shops in Bangladesh say it, and the window is ফেরতের মেয়াদ.
- **The examples that are typed values stay as typed:** 2190 POS exchange clearing and POS1-000164. A number in a
  sentence is in Bangla digits (০ থেকে ৩৬৫, যেমন ৭), and the settings path is the Bangla menu's (সেটিংস → POS
  রেজিস্টার), like 20b.
- **`*_one` / `*_other` are the same text.** Bangla has one form here, but i18next asks for both keys, because the
  English type has both.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src/locales
```

Build `@omnivo/contracts` before `@omnivo/i18n` (the locale files read `ErrorCode` from its build), and `@omnivo/i18n`
before the ui package and the app. All pass: 15 i18n tests (none new: this part adds words, and the type check is
their test). `pnpm --filter @omnivo/app typecheck` fails only in `pos-pay.tsx`, `sync-parts.tsx`,
`routes/pos-registers.tsx`, `routes/pos-sale.tsx` and the three mocks, which 20c.6 and 20c.7 change.

## 20c.6a — `packages/sync` and `/pos`: the return, the exchange and the reports at the counter

This part is the counter's side of the step: the device keeps its register's recent sales, saves a return or an
exchange with its sale, and adds up the shift's sums for the X report; the POS screen takes goods back (F6), carries an
exchange into the cart and the pay dialog, and prints the return slip and the X and Z reports. The managers' pages
(the POS returns list and page, the register's two new fields, the sale's and the shift's pages) are 20c.6b, and the
mock server and the browser tests are 20c.7.

It starts with two fixes of earlier parts, found while building the screens. A sale's line ids are made on the device
now (decision 64): without them a return made offline could not name a line of a sale still in the outbox. And a
return shares a line's total and VAT, not its net and VAT (decision 65): one shirt of two sold at ৳420 came back at
৳420.01. Both are in the diffs of 20c.1, 20c.3 and 20c.4 above, with their notes there; this part's checks run them
again.

When this part starts, `packages/sync` does not type check (no table for `pos_sale`, the cash refunded, the payment's
`returnId`), and the app fails in `pos-pay.tsx` and `sync-parts.tsx`. When it ends, both type check except the app's
files of the next two parts: `routes/pos-registers.tsx` (20c.6b) and the three mocks (20c.7).

### `packages/sync`: the device

#### `database.ts`: the sales, the claim's return number, the shift's sums

```diff
@@ -10,11 +10,13 @@ import type {
   SyncEntity,
   SyncPosCashReason,
   SyncPosRegister,
+  SyncPosSale,
   SyncPriceList,
   SyncPriceListItem,
   SyncSettings,
   SyncStock,
   TaxRate,
+  TenderAmount,
   Unit,
   Warehouse,
 } from '@omnivo/contracts';
@@ -56,6 +58,15 @@ export interface StockRow extends SealedRow<SyncStock> {
   variantId: string;
 }
 
+// Step 20c: a sale of the register this device holds, for returns without a connection. The receipt
+// number is clear, for the return screen's exact search (like a barcode), and the day, for dropping
+// the rows older than POS_SALES_ON_DEVICE_DAYS. What was sold, to whom and for how much is in the
+// box.
+export interface PosSaleRow extends SealedRow<SyncPosSale> {
+  number: string;
+  date: string;
+}
+
 // Step 19b: the two tables the app keeps opened in memory (copy.ts), and how many times each was
 // written. A write to one counts up its mark in the same transaction; a list waits until the
 // in-memory copy has caught up with the mark it reads, so it never shows a half-done write.
@@ -124,6 +135,10 @@ export interface OutboxEntry {
   // for the order the push sends them in (push.ts). Missing on every other command, and on a sale
   // saved before 20b.
   shiftId?: string;
+  // Step 20c: the key of another entry this one waits for while it is on the device: a return waits
+  // for its sale (sold offline, still in the outbox), and an exchange's sale for its return. Missing
+  // on every other command.
+  after?: string;
 }
 
 // The part of an entry that is sealed: everything a person typed or read
@@ -137,7 +152,7 @@ export type OutboxBody = Pick<
 // outbox from these alone, inside one transaction (a transaction cannot wait for Web Crypto).
 export interface OutboxRow extends Pick<
   OutboxEntry,
-  'seq' | 'status' | 'sent' | 'customerId' | 'key' | 'shiftId'
+  'seq' | 'status' | 'sent' | 'customerId' | 'key' | 'shiftId' | 'after'
 > {
   // The command's id: the box is sealed under it, and an answer finds its row by it
   commandId: string;
@@ -172,12 +187,33 @@ export interface RegisterClaim {
   key: 'claim';
   registerId: string;
   last: number;
+  // Step 20c: the last number it gave a return (POS1-R000012), counted up the same way. Missing on a
+  // claim made before 20c: no return was made then, so it counts from 0.
+  lastReturn?: number;
+  // Step 20c: the register's recent sales are on the device (returns.ts → loadRegisterSales). A new
+  // claim starts without them; the POS screen reads them as soon as it is online. Missing = no.
+  salesLoaded?: boolean;
 }
 
 // Step 20b: this device's latest shift, opened: the open one it sells on, or the last one it closed
 // (the next open numbers on from it and compares with what it counted). Its cash is added up here
 // as the sales and the movements are saved, so the close's result needs no sale the outbox has
 // sent already.
+// Step 20c: what the shift's X report adds up (shift.ts → shiftReportOf), counted as the sales and
+// the returns are saved, like the cash. Per tender, only the tenders with an amount
+// (tenderAmountsOf).
+export interface ShiftTally {
+  saleCount: number;
+  salesTotal: string;
+  salesDiscount: string;
+  salesVat: string;
+  returnCount: number;
+  returnsTotal: string;
+  returnsVat: string;
+  taken: TenderAmount[];
+  refunded: TenderAmount[];
+}
+
 export interface DeviceShift {
   id: string;
   registerId: string;
@@ -190,12 +226,20 @@ export interface DeviceShift {
   openingDate: string;
   opening: CashCount;
   cash: ShiftCash;
+  tally: ShiftTally;
   // Set by the close: the count and what the device expected
   closedAt: string | null;
   counted: string | null;
   expected: string | null;
 }
 
+// Step 20c: a shift as its box may hold it. A shift opened before the update has no cash refunded
+// and no tally yet; shift.ts reads every box through deviceShiftOf(), which fills them in.
+export type StoredShift = Omit<DeviceShift, 'cash' | 'tally'> & {
+  cash: Omit<ShiftCash, 'cashRefunded'> & Partial<Pick<ShiftCash, 'cashRefunded'>>;
+  tally?: ShiftTally;
+};
+
 // One row, under the key 'shift'. The shift's ids, its number and whether it is open stay clear:
 // the lock screen's Sign out and the sidebar's sign-out ask about an open shift without the key,
 // and a number like POS1-S0042 says nothing about the money. `rev` counts every write: a save
@@ -207,7 +251,7 @@ export interface ShiftRow {
   number: string;
   status: DeviceShift['status'];
   rev: number;
-  box: Box<DeviceShift>;
+  box: Box<StoredShift>;
 }
 
 // Step 20b: a held cart (decision 10), or the cart on the screen (key 'current'), so a reload or
@@ -245,6 +289,7 @@ export const TABLE_OF = {
   price_list_item: 'priceListItems',
   customer: 'customers',
   stock: 'stock',
+  pos_sale: 'posSales',
 } as const satisfies Record<SyncEntity, string>;
 export type SyncTableName = (typeof TABLE_OF)[SyncEntity];
 
@@ -308,6 +353,8 @@ export class SyncDatabase extends Dexie {
   // Step 20b: one row (ShiftRow), and the carts
   posShift!: Table<ShiftRow, string>;
   posCarts!: Table<CartRow, string>;
+  // Step 20c: the register's recent sales (PosSaleRow)
+  posSales!: Table<PosSaleRow, string>;
 
   constructor(name: string) {
     super(name);
@@ -390,6 +437,11 @@ export class SyncDatabase extends Dexie {
       posShift: 'key',
       posCarts: 'key, shiftId',
     });
+    // Step 20c: the register's recent sales. No upgrade: SYNC_PROTOCOL is 4 now, so the next pull is
+    // a full one. `number` finds a receipt, `date` the rows to drop.
+    this.version(6).stores({
+      posSales: 'key, gen, number, date',
+    });
   }
 
   // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
```

- **`PosSaleRow` keeps the receipt number and the day clear** (decision 66). The return screen finds a receipt with one
  index read (`where('number').equals(...)`), and the drop of old sales is one range on `date`. Both say nothing a
  person typed about a customer or money, like a SKU and a date (CLAUDE.md → The device's copy is sealed).
- **`RegisterClaim.lastReturn` and `salesLoaded` are optional.** A claim saved by 20b's app has neither: no return was
  made then, so its series starts at 0, and its sales are still to read. A required field would read as `undefined`
  anyway, with a type that says it cannot be.
- **`OutboxEntry.after`** is decision 69, kept clear on the row (`OutboxRow`) so the push picks a batch without opening
  a command.
- **`ShiftTally` is the X report's sums, per tender only where there is an amount** (`tenderAmountsOf()`), so the
  report lists what the shift used, like the shift's page.
- **`StoredShift` is the box's type, not `DeviceShift`.** A shift opened before the update was sealed without
  `cashRefunded` and `tally`. Typing the box as what it may hold makes `shift.ts` fill them in once, in one function,
  instead of a cast that would claim they are there.
- **Version 6 adds only the table.** Protocol 4 (20c.1) makes the server answer the next pull with a full one, which
  brings every sale the register holds (decision 24), so there is nothing to copy.

#### `apply.ts`: the sales from the pull

```diff
@@ -5,6 +5,7 @@ import type {
   SyncCustomerGroup,
   SyncPosCashReason,
   SyncPosRegister,
+  SyncPosSale,
   SyncPriceList,
   SyncPull,
   SyncSettings,
@@ -15,6 +16,7 @@ import type {
 
 import type { LocalCopy } from './copy.js';
 import type {
+  PosSaleRow,
   PriceListItemRow,
   ProductRow,
   PullState,
@@ -25,6 +27,7 @@ import type {
 } from './database.js';
 import { TABLE_OF } from './database.js';
 import { productIndex } from './records.js';
+import { dropOldSales } from './returns.js';
 import { readPullState } from './state.js';
 
 // A row before the transaction gives it its generation (step 19b): it is sealed first, and the
@@ -48,6 +51,7 @@ export interface SealedChanges {
     priceListItems: Unstamped<PriceListItemRow>[];
     customers: Unstamped<SealedRow<SyncCustomer>>[];
     stock: Unstamped<StockRow>[];
+    posSales: Unstamped<PosSaleRow>[];
   };
   deletes: Map<SyncTableName, string[]>;
 }
@@ -83,6 +87,7 @@ export async function sealChanges(
       priceListItems: [],
       customers: [],
       stock: [],
+      posSales: [],
     },
     deletes: new Map(),
   };
@@ -147,6 +152,14 @@ export async function sealChanges(
             variantId: change.data.variantId,
           });
           break;
+        // Step 20c: the receipt number and the day stay clear, for the return screen and the drop
+        case 'pos_sale':
+          puts.posSales.push({
+            ...(await boxed<SyncPosSale>(copy, 'posSales', key, change.data)),
+            number: change.data.number,
+            date: change.data.date,
+          });
+          break;
       }
     }),
   );
@@ -207,6 +220,7 @@ export async function writeSealed(
   await db.priceListItems.bulkPut(stamp(puts.priceListItems, gen));
   await db.customers.bulkPut(stamp(puts.customers, gen));
   await db.stock.bulkPut(stamp(puts.stock, gen));
+  await db.posSales.bulkPut(stamp(puts.posSales, gen));
   // Step 19b: only a write that touched them, so a page of stock alone leaves the in-memory
   // copies as they are
   if (puts.products.length > 0 || deletes.has('products')) await db.markWritten('products');
@@ -239,6 +253,8 @@ export async function applyPage(
         }
       }
     }
+    // Step 20c: the end of a pull, full or not: the sales older than the device keeps go
+    if (!page.hasMore) await dropOldSales(db, page.serverTime);
     await db.meta.put(state);
     return state;
   });
```

- **A `pos_sale` row is sealed with its number and day beside it,** like a stock row with its warehouse and variant.
  `boxed<SyncPosSale>` names the type: the switch narrows `change.data`, and the row's box gets the right type.
- **The old sales go at the end of every pull, full or not** (decision 67). Nothing on the server changes when a sale
  turns 31 days old, so no pull would ever delete it. It runs inside the page's transaction, so the drop and the
  cursor are saved together.

#### `carts.ts`: an exchange in the cart

```diff
@@ -1,4 +1,9 @@
-import { type DiscountType, MAX_HELD_CARTS } from '@omnivo/contracts';
+import {
+  type DiscountType,
+  MAX_HELD_CARTS,
+  type PosReturnableSale,
+  type PosReturnLineInput,
+} from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
 
 import type { LocalCopy } from './copy.js';
@@ -52,12 +57,29 @@ export interface PosCartCustomer {
   priceListId: string | null;
 }
 
+// Step 20c: a return whose money pays for the cart (an exchange, decision 1). Nothing is saved yet:
+// the return is saved with the sale, before it, at "Complete sale" (pos.ts), so dropping the cart
+// drops the return too and no money moved. Kept in the cart, so a reload does not lose it.
+export interface PosCartExchange {
+  // Made when the exchange starts: the sale's exchange payment names it
+  returnId: string;
+  // The sale the goods came from, as the return screen read it (the slip and the refund's methods)
+  sale: PosReturnableSale;
+  // What came back, as posReturnInputSchema reads it
+  lines: PosReturnLineInput[];
+  note: string | null;
+  // The return's money: what the lines pay back, with VAT
+  total: string;
+}
+
 export interface PosCart {
   // null = walk-in
   customer: PosCartCustomer | null;
   lines: PosCartLine[];
   billDiscountType: DiscountType;
   billDiscount: string;
+  // Step 20c: missing on a cart saved before 20c, and on one without an exchange
+  exchange?: PosCartExchange;
 }
 
 // The key of the cart on the screen. Held carts have a UUIDv7 each. A sale deletes it in its own
@@ -151,14 +173,16 @@ export async function dropCart(copy: LocalCopy, id: string): Promise<void> {
   await copy.db.posCarts.delete(id);
 }
 
-// The cart on the screen, saved as it changes; null or no lines = nothing to keep. Last write wins:
-// only the screen writes it, and a second tab on /pos shows the same shift's cart from its reload.
+// The cart on the screen, saved as it changes; null or no lines = nothing to keep, unless an
+// exchange waits for its lines (step 20c: the goods came back, and the customer is still choosing).
+// Last write wins: only the screen writes it, and a second tab on /pos shows the same shift's cart
+// from its reload.
 export async function saveScreenCart(
   copy: LocalCopy,
   shiftId: string,
   cart: HeldCart | null,
 ): Promise<void> {
-  if (!cart || cart.cart.lines.length === 0) {
+  if (!cart || (cart.cart.lines.length === 0 && !cart.cart.exchange)) {
     await copy.db.posCarts.delete(SCREEN_CART);
     return;
   }
```

- **`PosCartExchange` holds everything the return needs at "Complete sale"** (decision 72): its id (the sale's payment
  names it), the sale as the return screen read it (the slip and the refund's methods), the lines with their money,
  the note and the total. Nothing is saved before, so a dropped exchange moved no money.
- **`exchange` is optional on `PosCart`:** a cart held or kept by 20b's app has none, and its box still opens.
- **`saveScreenCart()` keeps a cart with an exchange and no lines.** The customer brought goods back and is still
  choosing; a reload or the idle lock must not lose the return.

#### `shift.ts`: the cash refunded and the X and Z reports

```diff
@@ -8,16 +8,26 @@ import {
   type PosCashMovementInput,
   type PosShiftCloseInput,
   type PosShiftOpenInput,
-  type ShiftCash,
+  type PosShiftReport,
+  type PosShiftReportKind,
   type SyncCommand,
   type SyncPosCashReason,
   type SyncPosRegister,
+  type TenderAmount,
+  tenderAmountsOf,
 } from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
 
 import { SCREEN_CART } from './carts.js';
 import type { LocalCopy } from './copy.js';
-import type { DeviceShift, OutboxEntry, ShiftRow, SyncDatabase } from './database.js';
+import type {
+  DeviceShift,
+  OutboxEntry,
+  ShiftRow,
+  ShiftTally,
+  StoredShift,
+  SyncDatabase,
+} from './database.js';
 import { openRows, sealEntry } from './sealed.js';
 
 // Step 20b: the shift on the device. The device opens it, adds up its cash as it sells and moves
@@ -34,9 +44,36 @@ export async function shiftState(db: SyncDatabase): Promise<ShiftState | null> {
     : null;
 }
 
+// Step 20c: nothing counted yet. A shift opened before the update starts its X report from here.
+export const EMPTY_TALLY: ShiftTally = {
+  saleCount: 0,
+  salesTotal: '0',
+  salesDiscount: '0',
+  salesVat: '0',
+  returnCount: 0,
+  returnsTotal: '0',
+  returnsVat: '0',
+  taken: [],
+  refunded: [],
+};
+
+// Step 20c: a box as a DeviceShift. A shift opened before the update was saved without the cash
+// refunded and the tally: no return was made in it, so they start at nothing.
+function deviceShiftOf(stored: StoredShift): DeviceShift {
+  return {
+    ...stored,
+    cash: { ...stored.cash, cashRefunded: stored.cash.cashRefunded ?? '0' },
+    tally: stored.tally ?? EMPTY_TALLY,
+  };
+}
+
+async function openStored(copy: LocalCopy, row: ShiftRow): Promise<DeviceShift> {
+  return deviceShiftOf(await copy.open('posShift', 'shift', row.box));
+}
+
 export async function readShift(copy: LocalCopy): Promise<DeviceShift | null> {
   const row = await copy.db.posShift.get('shift');
-  return row ? copy.open('posShift', 'shift', row.box) : null;
+  return row ? openStored(copy, row) : null;
 }
 
 // The reasons the cashier picks from, "in" first, then by name, like the settings page (decision
@@ -70,7 +107,7 @@ async function openShiftOf(
 ): Promise<{ row: ShiftRow; shift: DeviceShift } | null> {
   const row = await copy.db.posShift.get('shift');
   if (row?.shiftId !== shiftId || row.status !== 'open') return null;
-  return { row, shift: await copy.open('posShift', 'shift', row.box) };
+  return { row, shift: await openStored(copy, row) };
 }
 
 // A command of the shift, as the outbox keeps it. `chain` is its customerId: the push holds a
@@ -161,7 +198,7 @@ export async function openShift(copy: LocalCopy, save: ShiftOpenSave): Promise<S
     const claim = await db.registerClaim.get('claim');
     if (claim?.registerId !== register.id) return { kind: 'not-held' };
     const before = await db.posShift.get('shift');
-    const own = before ? await copy.open('posShift', 'shift', before.box) : null;
+    const own = before ? await openStored(copy, before) : null;
     if (own?.status === 'open') return { kind: 'open-already' };
     const start = shiftStart(register, own);
     const shift: DeviceShift = {
@@ -180,7 +217,9 @@ export async function openShift(copy: LocalCopy, save: ShiftOpenSave): Promise<S
         changeGiven: '0',
         paidIn: '0',
         paidOut: '0',
+        cashRefunded: '0',
       },
+      tally: EMPTY_TALLY,
       closedAt: null,
       counted: null,
       expected: null,
@@ -225,31 +264,74 @@ export async function openShift(copy: LocalCopy, save: ShiftOpenSave): Promise<S
 }
 
 // ---------------------------------------------------------------------------------------------
-// A sale's cash (pos.ts calls this inside its own save)
+// A sale's and a return's money (pos.ts and returns.ts call these inside their own saves)
+
+// What a sale brings into its shift: the cash it took and the change it gave back, and for the X
+// report its total, its discounts (the lines' and the bill's), its VAT and what each tender paid
+export interface SaleEffect {
+  cashTaken: string;
+  changeGiven: string;
+  total: string;
+  discount: string;
+  vat: string;
+  payments: readonly TenderAmount[];
+}
 
-// The cash a sale brings into the shift: what it took in cash, and the change it gave back
-export function cashAfterSale(
-  cash: ShiftCash,
-  sale: { cashTaken: string; changeGiven: string },
-): ShiftCash {
+// Step 20c: what a return takes out of its shift: the cash given back, and for the X report its
+// total, its VAT and what each tender paid back (an exchange's money as `exchange`)
+export interface ReturnEffect {
+  cashRefunded: string;
+  total: string;
+  vat: string;
+  refunds: readonly TenderAmount[];
+}
+
+export function shiftAfterSale(shift: DeviceShift, sale: SaleEffect): DeviceShift {
+  const { cash, tally } = shift;
   return {
-    ...cash,
-    cashTaken: addMoney(cash.cashTaken, sale.cashTaken),
-    changeGiven: addMoney(cash.changeGiven, sale.changeGiven),
+    ...shift,
+    cash: {
+      ...cash,
+      cashTaken: addMoney(cash.cashTaken, sale.cashTaken),
+      changeGiven: addMoney(cash.changeGiven, sale.changeGiven),
+    },
+    tally: {
+      ...tally,
+      saleCount: tally.saleCount + 1,
+      salesTotal: addMoney(tally.salesTotal, sale.total),
+      salesDiscount: addMoney(tally.salesDiscount, sale.discount),
+      salesVat: addMoney(tally.salesVat, sale.vat),
+      taken: tenderAmountsOf([...tally.taken, ...sale.payments]),
+    },
   };
 }
 
-// The sale's save reads the shift and writes it back with the sale; null = no open shift with
-// this id. pos.ts checks the rev inside its transaction.
-export async function shiftForSale(
+export function shiftAfterReturn(shift: DeviceShift, given: ReturnEffect): DeviceShift {
+  const { cash, tally } = shift;
+  return {
+    ...shift,
+    cash: { ...cash, cashRefunded: addMoney(cash.cashRefunded, given.cashRefunded) },
+    tally: {
+      ...tally,
+      returnCount: tally.returnCount + 1,
+      returnsTotal: addMoney(tally.returnsTotal, given.total),
+      returnsVat: addMoney(tally.returnsVat, given.vat),
+      refunded: tenderAmountsOf([...tally.refunded, ...given.refunds]),
+    },
+  };
+}
+
+// The save reads the shift and writes it back changed, with its sale or its return; null = no open
+// shift with this id. The save checks the rev inside its transaction.
+export async function shiftAfter(
   copy: LocalCopy,
   shiftId: string,
-  sale: { cashTaken: string; changeGiven: string },
-): Promise<{ before: ShiftRow; row: ShiftRow } | null> {
+  change: (shift: DeviceShift) => DeviceShift,
+): Promise<{ before: ShiftRow; row: ShiftRow; shift: DeviceShift } | null> {
   const open = await openShiftOf(copy, shiftId);
   if (!open) return null;
-  const shift = { ...open.shift, cash: cashAfterSale(open.shift.cash, sale) };
-  return { before: open.row, row: await sealShift(copy, shift, open.row.rev + 1) };
+  const shift = change(open.shift);
+  return { before: open.row, row: await sealShift(copy, shift, open.row.rev + 1), shift };
 }
 
 // ---------------------------------------------------------------------------------------------
@@ -384,3 +466,51 @@ export async function closeShift(copy: LocalCopy, save: ShiftCloseSave): Promise
   }
   return tooManyTries();
 }
+
+// ---------------------------------------------------------------------------------------------
+// Step 20c: the shift's reports
+
+export interface ShiftReportFields {
+  kind: PosShiftReportKind;
+  register: { code: string; name: string };
+  cashierName: string;
+  printedAt: string;
+}
+
+// The X report (the shift still open) or the Z report (closed), from the device's own shift: the
+// device prints it offline too. The X report is blind (decision 9): no drawer, so it never tells
+// the cashier what the count should come to. The Z report has the drawer, once the shift is closed
+// with a count.
+export function shiftReportOf(shift: DeviceShift, fields: ShiftReportFields): PosShiftReport {
+  const { cash, tally } = shift;
+  const drawer =
+    fields.kind === 'z' && shift.counted !== null && shift.expected !== null
+      ? {
+          ...cash,
+          expected: shift.expected,
+          counted: shift.counted,
+          difference: cashDifferenceOf(shift.counted, shift.expected),
+        }
+      : null;
+  return {
+    kind: fields.kind,
+    register: fields.register,
+    shiftNumber: shift.number,
+    cashierName: fields.cashierName,
+    openedAt: shift.openedAt,
+    closedAt: fields.kind === 'z' ? shift.closedAt : null,
+    printedAt: fields.printedAt,
+    saleCount: tally.saleCount,
+    salesTotal: tally.salesTotal,
+    salesDiscount: tally.salesDiscount,
+    salesVat: tally.salesVat,
+    returnCount: tally.returnCount,
+    returnsTotal: tally.returnsTotal,
+    returnsVat: tally.returnsVat,
+    taken: tally.taken,
+    refunded: tally.refunded,
+    paidIn: cash.paidIn,
+    paidOut: cash.paidOut,
+    drawer,
+  };
+}
```

- **`deviceShiftOf()` is the one place a box becomes a shift** (decision 71): `readShift()`, `openShiftOf()` and
  `openShift()` all read through it, so no caller meets a shift without `cashRefunded` or `tally`.
- **A new shift starts with `cashRefunded: '0'` and `EMPTY_TALLY`,** so `expectedCashOf()` (20c.1) has every part.
- **`shiftAfterSale()` and `shiftAfterReturn()` replace 20b's `cashAfterSale()`.** A sale changes the cash and the sums
  together; a return takes its cash refunds out and adds to the returns' sums. Both are plain functions on a shift,
  so `savePosSale()` applies a return and its exchange sale in one go.
- **`shiftAfter()` takes a change function** instead of a sale. The return's save and the sale's use the same read,
  seal and `rev` check, and the exchange applies both changes to one read of the shift.
- **`shiftReportOf()` makes the report from the shift alone** (decision 79). The X report's `drawer` is always `null`
  (decision 9, blind); the Z report's is there only when the close counted (a shift closed from the managers' page
  without a count has none). `closedAt` is left out of an X report even if the box had one.

#### `returns.ts` (new): the sales a return reads, and the return's save

```ts
import {
  addMoney,
  defaultLineDescription,
  formatReturnNumber,
  POS_SALES_ON_DEVICE_DAYS,
  type PosReturnableLine,
  type PosReturnableSale,
  type PosReturnInput,
  type PosSaleInput,
  posSaleAmounts,
  shiftIsoDate,
  sumMoney,
  sumQuantity,
  type SyncCommand,
  type SyncPosSale,
  type TaxRate,
  toBaseQuantity,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { LocalCopy } from './copy.js';
import type { OutboxEntry, PosSaleRow, SyncDatabase } from './database.js';
import { productsOfVariants } from './prices.js';
import { localCustomer } from './queries.js';
import { openEntries, openRows, sealEntry } from './sealed.js';
import { type ReturnEffect, shiftAfter, shiftAfterReturn } from './shift.js';
import { readPullState } from './state.js';

// Step 20c: returns at the counter, on the device. The sales a return can come from are rows of
// the posSales table: the register's recent sales from the server, and each sale this device makes,
// written when it is saved (pos.ts), so the goods of a sale sold offline can come back before it
// syncs. A return goes into the outbox like a sale, with the next number of the register's return
// series, and takes its cash out of the shift. No Dexie import, like pos.ts.

type Unstamped<R> = Omit<R, 'gen'>;

// The id of a return the screen starts. Made before the save: an exchange's sale names it in its
// payment while the cart is still on the screen.
export function newReturnId(): string {
  return uuidv7();
}

// ---------------------------------------------------------------------------------------------
// The sales on the device

export async function sealSale(copy: LocalCopy, sale: SyncPosSale): Promise<Unstamped<PosSaleRow>> {
  return {
    key: sale.id,
    number: sale.number,
    date: sale.date,
    box: await copy.seal('posSales', sale.id, sale),
  };
}

// The sale as the server would send it, made from what the device saved: the products' names and
// the VAT rates from the copy, the money from the same arithmetic as the server's (posSaleAmounts).
// null when the copy cannot say it all (a product archived since the cart was made, a line saved
// before 20c without an id): that sale comes back only once the server has it.
export async function localSaleOf(
  copy: LocalCopy,
  sale: { id: string; number: string; input: Omit<PosSaleInput, 'sequence'> },
): Promise<SyncPosSale | null> {
  const { input } = sale;
  const rateIds = [...new Set(input.lines.map((line) => line.taxRateId))];
  const [products, rateRows, customer] = await Promise.all([
    productsOfVariants(
      copy,
      input.lines.map((line) => line.variantId),
    ),
    copy.db.taxRates.where('key').anyOf(rateIds).toArray(),
    input.customerId === null ? null : localCustomer(copy, input.customerId),
  ]);
  const rates = await openRows<TaxRate>(copy, 'taxRates', rateRows);
  const { lines: amounts, totals } = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const lines: PosReturnableLine[] = [];
  for (const [index, line] of input.lines.entries()) {
    const product = products.get(line.variantId);
    const variant = product?.variants.find((one) => one.id === line.variantId);
    const rate = rates.find((one) => one.id === line.taxRateId);
    const amount = amounts[index];
    const factor =
      line.unitId === product?.baseUnitId
        ? '1'
        : product?.units.find((pack) => pack.unitId === line.unitId)?.factor;
    if (!product || !variant || !rate || !amount || factor === undefined || line.id === null) {
      return null;
    }
    const ref = { productName: product.name, optionValues: variant.optionValues };
    lines.push({
      id: line.id,
      variantId: variant.id,
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      optionValues: variant.optionValues,
      sku: variant.sku,
      baseUnitId: product.baseUnitId,
      tracking: product.tracking,
      unitId: line.unitId,
      // 4 decimals, like the server's rows: the screen compares them with the return's
      quantity: sumQuantity([line.quantity]),
      baseQuantity: toBaseQuantity(line.quantity, factor, 4),
      description: line.description ?? defaultLineDescription(ref),
      unitPrice: sumMoney([line.unitPrice]),
      // The rate the sale used, with the name the copy has for it
      taxRate: { id: rate.id, name: rate.name, kind: rate.kind, rate: line.rate },
      net: amount.net,
      vat: amount.vat,
      total: amount.total,
      serialNumbers: line.serialNumbers,
      returnedSerialNumbers: [],
      returnedQuantity: '0.0000',
    });
  }
  return {
    id: sale.id,
    number: sale.number,
    registerId: input.registerId,
    date: input.date,
    soldAt: input.soldAt,
    customer: customer && { id: customer.id, code: customer.code, name: customer.name },
    pricesIncludeVat: input.pricesIncludeVat,
    total: totals.total,
    lines,
    payments: input.payments.map((payment) => ({
      method: payment.method,
      amount: sumMoney([payment.amount]),
    })),
  };
}

// A receipt of this register by its number (the screen trims it and makes it upper case, like the
// route). null = not on the device: older than POS_SALES_ON_DEVICE_DAYS, another register's, or a
// typing mistake.
export async function localSale(
  copy: LocalCopy,
  number: string,
): Promise<PosReturnableSale | null> {
  const row = await copy.db.posSales.where('number').equals(number).first();
  return row ? copy.open('posSales', row.key, row.box) : null;
}

// What earlier returns took back, with the returns still on this device: the server's row (or its
// answer online) counts only the returns it has posted. A return refused by the server counts too:
// the goods came back and the money went out all the same, like a refused sale's stock (pos.ts).
export function withReturns(
  sale: PosReturnableSale,
  returns: readonly Pick<PosReturnInput, 'lines'>[],
): PosReturnableSale {
  const back = returns.flatMap((item) => item.lines);
  if (back.length === 0) return sale;
  return {
    ...sale,
    lines: sale.lines.map((line) => {
      const mine = back.filter((item) => item.saleLineId === line.id);
      if (mine.length === 0) return line;
      return {
        ...line,
        returnedQuantity: sumQuantity([
          line.returnedQuantity,
          ...mine.map((item) => item.quantity),
        ]),
        returnedSerialNumbers: [
          ...line.returnedSerialNumbers,
          ...mine.flatMap((item) => item.serialNumbers),
        ],
      };
    }),
  };
}

// The returns of one sale still in the outbox: each waits for its sale (`after`), so the clear
// field finds them, and only those are opened. `fromServer`: the sale is the server's answer of
// just now, which counts every return the server has. A return sent already (`sent`) may be one of
// them, its answer still on the way, so only the ones never sent are added: counted twice, the
// screen would say less is left than is (step 20c.7 found it, a second return right after the
// first). One sent that the server has not run yet then counts nowhere; the server takes that
// over-return and writes the audit log (decision 20). The device's own row (a sale from the copy)
// leaves the outbox in the same transaction that writes its returns, so it counts every one.
export async function withWaitingReturns(
  copy: LocalCopy,
  sale: PosReturnableSale,
  fromServer = false,
): Promise<PosReturnableSale> {
  const rows = await copy.db.outbox
    .filter(
      (row) =>
        row.type === 'pos_return.create' && row.after === sale.id && !(fromServer && row.sent),
    )
    .toArray();
  const returns = (await openEntries(copy, rows)).flatMap(({ command }) =>
    command.type === 'pos_return.create' ? [command.input] : [],
  );
  return withReturns(sale, returns);
}

// One page of the register's recent sales (routes.posReturns.registerSales)
export interface RegisterSalesPage {
  items: SyncPosSale[];
  nextCursor: string | null;
}

// The register's recent sales, right after the device took it (decision 45), page after page.
// Each page is written in its own transaction, at the generation of the pull, and only while the
// claim is still this register's: Change register in another tab stops it. The last page marks the
// claim, so the screen does not read them again. The app runs this inside the sync lock (engine.ts
// → exclusive): a pull writes the same rows, and the older of two answers must not win.
export async function loadRegisterSales(
  copy: LocalCopy,
  registerId: string,
  fetchPage: (cursor: string | null) => Promise<RegisterSalesPage>,
): Promise<'loaded' | 'not-held'> {
  const { db } = copy;
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    const rows = await Promise.all(page.items.map((sale) => sealSale(copy, sale)));
    const last = page.nextCursor === null;
    const held = await db.transaction('rw', [db.registerClaim, db.posSales, db.meta], async () => {
      const claim = await db.registerClaim.get('claim');
      if (claim?.registerId !== registerId) return false;
      const { generation } = await readPullState(db);
      await db.posSales.bulkPut(rows.map((row) => ({ ...row, gen: generation })));
      if (last) await db.registerClaim.put({ ...claim, salesLoaded: true });
      return true;
    });
    if (!held) return 'not-held';
    if (last) return 'loaded';
    cursor = page.nextCursor;
  }
}

// The first day the device keeps: like the server's posSalesFrom, but from the server's clock in
// UTC, which is never after the workspace's own day, so the device keeps a day more at most
export function keptSalesFrom(serverTime: string): string {
  return shiftIsoDate(serverTime.slice(0, 10), -POS_SALES_ON_DEVICE_DAYS);
}

// Nothing on the server changes when a sale turns 31 days old, so no pull deletes it: the device
// drops it itself, at the end of each pull (apply.ts). Inside that pull's transaction.
export async function dropOldSales(db: SyncDatabase, serverTime: string): Promise<void> {
  await db.posSales.where('date').below(keptSalesFrom(serverTime)).delete();
}

// ---------------------------------------------------------------------------------------------
// Saving a return

export interface PosReturnSave {
  // newReturnId()
  returnId: string;
  // posReturnInputSchema's output, less the number the save gives
  input: Omit<PosReturnInput, 'sequence'>;
  // For the number (POS1-R000012), which the Sync page and the slip show
  registerCode: string;
  // This device's clock, for the Sync page only
  savedAt: string;
}

// saved: in the outbox with this number. not-held / no-shift: as for a sale (pos.ts).
export type PosReturnResult =
  { kind: 'saved'; sequence: number; number: string } | { kind: 'not-held' } | { kind: 'no-shift' };

// What a return takes out of its shift (shift.ts): the cash refunds, and its sums for the X report
export function returnEffectOf(input: Pick<PosReturnInput, 'lines' | 'refunds'>): ReturnEffect {
  return {
    cashRefunded: sumMoney(
      input.refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
    ),
    total: sumMoney(input.lines.map((line) => addMoney(line.net, line.vat))),
    vat: sumMoney(input.lines.map((line) => line.vat)),
    refunds: input.refunds.map(({ method, amount }) => ({ method, amount })),
  };
}

// The return as the outbox keeps it. Its own chain (its id): it waits for its sale through `after`,
// not through the customer, so a refused change to the sale's customer holds no return back. The
// Sync page names it by its number and counts its lines, with no money (decision 61).
export function returnEntry(save: PosReturnSave, sequence: number, number: string): OutboxEntry {
  const command: SyncCommand = {
    id: uuidv7(),
    type: 'pos_return.create',
    returnId: save.returnId,
    input: { ...save.input, sequence },
  };
  return {
    command,
    status: 'waiting',
    sent: false,
    error: null,
    customerId: save.returnId,
    key: save.returnId,
    base: null,
    name: number,
    lines: save.input.lines.length,
    total: null,
    savedAt: save.savedAt,
    shiftId: save.input.shiftId,
    after: save.input.saleId,
  };
}

// The next return number of the claim: 0 on a claim from before 20c (no return was made then)
export function nextReturnSequence(claim: { lastReturn?: number }): number {
  return (claim.lastReturn ?? 0) + 1;
}

const SAVE_ATTEMPTS = 3;

// The number, the shift and the outbox in one transaction, like a sale's (pos.ts): sealed first,
// written only if the claim's return number and the shift are still the ones read, else again. A
// return with an exchange is saved by savePosSale, with its sale.
export async function savePosReturn(
  copy: LocalCopy,
  save: PosReturnSave,
): Promise<PosReturnResult> {
  const { db } = copy;
  const { input } = save;
  const effect = returnEffectOf(input);
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const claim = await db.registerClaim.get('claim');
    if (claim?.registerId !== input.registerId) return { kind: 'not-held' };
    const shift = await shiftAfter(copy, input.shiftId, (open) => shiftAfterReturn(open, effect));
    if (!shift) return { kind: 'no-shift' };
    const sequence = nextReturnSequence(claim);
    const number = formatReturnNumber(save.registerCode, sequence);
    const row = await sealEntry(copy, returnEntry(save, sequence, number));
    const saved = await db.transaction(
      'rw',
      [db.registerClaim, db.outbox, db.posShift],
      async () => {
        const now = await db.registerClaim.get('claim');
        if (now?.registerId !== claim.registerId || now.lastReturn !== claim.lastReturn) {
          return false;
        }
        if ((await db.posShift.get('shift'))?.rev !== shift.before.rev) return false;
        await db.registerClaim.put({ ...now, lastReturn: sequence });
        await db.outbox.add(row);
        await db.posShift.put(shift.row);
        return true;
      },
    );
    if (saved) return { kind: 'saved', sequence, number };
  }
  throw new Error('The register kept changing during the save');
}
```

- **`newReturnId()` is made before the save.** An exchange's sale names its return in its payment while the cart is
  still on the screen; the id cannot wait for the save that gives the number.
- **`localSaleOf()` builds the sale the way the server's `pos-returnable.ts` does:** names from the copy's products,
  the rate's name from the copy, the money from `posSaleAmounts()`, the description from `defaultLineDescription()`,
  quantities and prices in 4 decimals. The return screen then reads a sale saved on this device and one from the
  server the same way. When the copy cannot say it all (a product archived since the cart was filled, a line without an
  id), it returns `null`: that sale comes back once the server has it, never half known.
- **`localCustomer()` reads the customer with the outbox on top,** so a customer made on this device a minute ago has
  its name on the return screen too.
- **`withReturns()` adds the returns still in the outbox** to what the server counted (decision 75). A refused return
  counts too: the goods came back and the money went out, like a refused sale's stock in `pos.ts`. The outbox finds a
  sale's returns by the clear `after` field, so only those are opened.
- **`withWaitingReturns(copy, sale, fromServer)`** leaves out the returns sent already when the sale is the server's
  answer (`fromServer`): the server may have counted them. 20c.7 found this (decision 98); the code above is the fixed
  one. The device's own row needs no such care: an accepted return leaves the outbox in the same transaction that
  writes its sale's row (`applyAnswers()` in `push.ts`).
- **`loadRegisterSales()` writes page by page, each in its own transaction, only while the claim is still this
  register's.** A Change register in another tab stops it, and a page never lands on another register's device copy.
  The last page sets `salesLoaded`, so the screen does not read them again. The rows get the pull's generation, like
  the rows a push's answer writes: a full pull under way keeps them.
- **`keptSalesFrom()` uses the server's time in UTC** (decision 67), and `dropOldSales()` runs inside the pull's
  transaction, so it gets the database, not the copy.
- **`returnEffectOf()` counts only cash refunds as cash.** An exchange's money and a bKash refund never touch the drawer.
- **`returnEntry()` gives a return its own chain** (`customerId` is the return's id) and `after: saleId` (decision 69),
  and `total: null`: the Sync page shows no money for a return (decision 61). `shiftId` puts it in its shift's order,
  so the close waits for it.
- **`savePosReturn()` is `savePosSale()`'s pattern:** seal first, then one transaction that writes only if the claim's
  return number and the shift's `rev` are still the ones read; else again, three times at most. The return number
  counts up in the claim in the same transaction as the outbox row, so a number is never used twice, also from two
  tabs.

#### `pos.ts`: line ids, the sale on the device, an exchange saved with its sale

```diff
@@ -1,8 +1,11 @@
 import {
+  addMoney,
   addQuantity,
   formatPosNumber,
+  formatReturnNumber,
   type PosRegister,
   posChangeOf,
+  posSaleAmounts,
   type PosSaleInput,
   type Product,
   subtractQuantity,
@@ -18,8 +21,17 @@ import { SCREEN_CART } from './carts.js';
 import type { LocalCopy } from './copy.js';
 import type { RegisterClaim } from './database.js';
 import { isCounterCommand } from './outbox.js';
+import {
+  localSaleOf,
+  nextReturnSequence,
+  type PosReturnSave,
+  returnEffectOf,
+  returnEntry,
+  sealSale,
+} from './returns.js';
 import { openEntries, openRows, sealEntry } from './sealed.js';
-import { shiftForSale } from './shift.js';
+import { type SaleEffect, shiftAfter, shiftAfterReturn, shiftAfterSale } from './shift.js';
+import { readPullState } from './state.js';
 
 // Step 20a: the POS on the device. The registers of the branch come with the pull; the claim says
 // which one this device holds and the last number it gave; a sale goes into the outbox with the
@@ -43,27 +55,37 @@ export async function readClaim(copy: LocalCopy): Promise<RegisterClaim | null>
 // (a reload that lost nothing, the claim is idempotent) answers the last number the server has
 // received, and the sales still in the outbox are past it. A claim of another register starts
 // from the server's number alone: the device let the old one go only with no sale of it waiting.
+// Step 20c: the return numbers the same way, and the register's recent sales are still to read
+// (returns.ts → loadRegisterSales) unless the claim is the one the device had.
 export async function keepClaim(
   copy: LocalCopy,
-  register: Pick<PosRegister, 'id' | 'lastNumber'>,
+  register: Pick<PosRegister, 'id' | 'lastNumber' | 'lastReturnNumber'>,
 ): Promise<RegisterClaim> {
   const { db } = copy;
   return db.transaction('rw', db.registerClaim, async () => {
     const old = await db.registerClaim.get('claim');
-    const own = old?.registerId === register.id ? old.last : 0;
+    const same = old?.registerId === register.id ? old : null;
     const claim: RegisterClaim = {
       key: 'claim',
       registerId: register.id,
-      last: Math.max(own, register.lastNumber),
+      last: Math.max(same?.last ?? 0, register.lastNumber),
+      lastReturn: Math.max(same?.lastReturn ?? 0, register.lastReturnNumber),
+      salesLoaded: same?.salesLoaded ?? false,
     };
     await db.registerClaim.put(claim);
     return claim;
   });
 }
 
-// After the server let the register go (Change register, sign-out)
+// After the server let the register go (Change register, sign-out). Step 20c: its sales go with
+// it, in the same transaction: the device keeps only the sales of the register it holds, and no
+// pull would delete them (the server sends a register's sales to its holder only).
 export async function dropClaim(copy: LocalCopy): Promise<void> {
-  await copy.db.registerClaim.delete('claim');
+  const { db } = copy;
+  await db.transaction('rw', [db.registerClaim, db.posSales], async () => {
+    await db.registerClaim.delete('claim');
+    await db.posSales.clear();
+  });
 }
 
 // The POS commands still on the device. A device holds one register at a time and lets it go only
@@ -83,17 +105,42 @@ export interface PosSaleSave {
   total: string;
   // This device's clock, for the Sync page only
   savedAt: string;
+  // Step 20c: the return whose money pays for this sale (an exchange), saved with it and before it.
+  // The sale's exchange payment names its returnId. Missing = no exchange.
+  exchange?: PosReturnSave;
 }
 
 // saved: in the outbox, with this number and the sale's id (a UUIDv7 made here, like every id the
-// device makes; step 20c's return points at it). not-held: the claim is gone or is another
-// register's (another tab changed the register meanwhile); the screen asks for a register again.
-// no-shift (step 20b): the sale's shift is not open on the device any more (closed in another tab).
+// device makes; step 20c's return points at it), and the number of its exchange's return (null =
+// none). not-held: the claim is gone or is another register's (another tab changed the register
+// meanwhile); the screen asks for a register again. no-shift (step 20b): the sale's shift is not
+// open on the device any more (closed in another tab).
 export type PosSaveResult =
-  | { kind: 'saved'; saleId: string; sequence: number; number: string }
+  | { kind: 'saved'; saleId: string; sequence: number; number: string; returnNumber: string | null }
   | { kind: 'not-held' }
   | { kind: 'no-shift' };
 
+// Step 20c: what a sale brings into its shift, for the cash and the X report. Change is given in
+// cash, whatever the methods.
+function saleEffectOf(input: Omit<PosSaleInput, 'sequence'>, total: string): SaleEffect {
+  const { totals } = posSaleAmounts(
+    input.lines,
+    { type: input.billDiscountType, value: input.billDiscount },
+    input.pricesIncludeVat,
+  );
+  const { payments } = input;
+  return {
+    cashTaken: sumMoney(
+      payments.filter((payment) => payment.method === 'cash').map((payment) => payment.amount),
+    ),
+    changeGiven: posChangeOf(payments, total),
+    total: totals.total,
+    discount: addMoney(totals.discount, totals.billDiscount),
+    vat: totals.vat,
+    payments: payments.map(({ method, amount }) => ({ method, amount })),
+  };
+}
+
 const SAVE_ATTEMPTS = 3;
 
 // The number and the outbox in one transaction: the claim counts up only when the sale is in the
@@ -103,31 +150,50 @@ const SAVE_ATTEMPTS = 3;
 // next number. Three times in a row would take three tabs selling at the same moment.
 // Step 20b: the shift's cash goes in the same transaction (the cash the sale took, the change it
 // gave), checked the same way, so the close's expected cash counts every sale exactly once.
+//
+// Step 20c: every line gets its id here (decision 64), and the sale goes into the device's own
+// sales (posSales) in the same transaction, so its goods can come back before it syncs. An
+// exchange's return is saved first in the same transaction, with the next return number: the two
+// are in the outbox together or not at all, and the return's cash and the sale's go into the shift
+// together.
 export async function savePosSale(copy: LocalCopy, save: PosSaleSave): Promise<PosSaveResult> {
   const { db } = copy;
   const saleId = uuidv7();
-  const { payments } = save.input;
-  const sale = {
-    cashTaken: sumMoney(
-      payments.filter((payment) => payment.method === 'cash').map((payment) => payment.amount),
-    ),
-    // Change is given in cash, whatever the methods
-    changeGiven: posChangeOf(payments, save.total),
+  const input = {
+    ...save.input,
+    lines: save.input.lines.map((line) => ({ ...line, id: line.id ?? uuidv7() })),
   };
+  const sale = saleEffectOf(input, save.total);
+  const exchange = save.exchange ?? null;
+  const given = exchange && returnEffectOf(exchange.input);
+  // Made once, without its number: the number is added at each attempt
+  const local = await localSaleOf(copy, { id: saleId, number: '', input });
   for (let attempt = 1; ; attempt += 1) {
     const claim = await db.registerClaim.get('claim');
-    if (claim?.registerId !== save.input.registerId) return { kind: 'not-held' };
-    // A sale saved before 20b's screen has no shift; every new one has
+    if (claim?.registerId !== input.registerId) return { kind: 'not-held' };
+    // A sale saved before 20b's screen has no shift; every new one has. An exchange's return is in
+    // the same shift: it is the same cart.
     const shift =
-      save.input.shiftId === null ? null : await shiftForSale(copy, save.input.shiftId, sale);
-    if (save.input.shiftId !== null && !shift) return { kind: 'no-shift' };
+      input.shiftId === null
+        ? null
+        : await shiftAfter(copy, input.shiftId, (open) =>
+            shiftAfterSale(given ? shiftAfterReturn(open, given) : open, sale),
+          );
+    if (input.shiftId !== null && !shift) return { kind: 'no-shift' };
     const sequence = claim.last + 1;
     const number = formatPosNumber(save.registerCode, sequence);
+    const returnSequence = nextReturnSequence(claim);
+    const returnNumber = exchange && formatReturnNumber(exchange.registerCode, returnSequence);
+    const returnRow =
+      exchange &&
+      returnNumber !== null &&
+      (await sealEntry(copy, returnEntry(exchange, returnSequence, returnNumber)));
+    const saleRow = local && (await sealSale(copy, { ...local, number }));
     const command: SyncCommand = {
       id: uuidv7(),
       type: 'pos_sale.create',
       saleId,
-      input: { ...save.input, sequence },
+      input: { ...input, sequence },
     };
     const row = await sealEntry(copy, {
       command,
@@ -138,29 +204,48 @@ export async function savePosSale(copy: LocalCopy, save: PosSaleSave): Promise<P
       // A sale to a customer made on this device waits for that customer, like an order. A walk-in
       // sale waits for nothing: its own id here, so a hundred walk-in sales go in one push, and a
       // refused one holds back no other.
-      customerId: save.input.customerId ?? saleId,
+      customerId: input.customerId ?? saleId,
       key: saleId,
       base: null,
       // The Sync page says "Sale POS1-000124" (sync.commands.pos_sale.create)
       name: number,
-      lines: save.input.lines.length,
+      lines: input.lines.length,
       total: save.total,
       savedAt: save.savedAt,
-      ...(save.input.shiftId !== null && { shiftId: save.input.shiftId }),
+      ...(input.shiftId !== null && { shiftId: input.shiftId }),
+      // Step 20c: an exchange's sale waits for its return, which the server must have first
+      ...(exchange && { after: exchange.returnId }),
     });
-    const tables = [db.registerClaim, db.outbox, db.posShift, db.posCarts];
+    const tables = [db.registerClaim, db.outbox, db.posShift, db.posCarts, db.posSales, db.meta];
     const saved = await db.transaction('rw', tables, async () => {
       const now = await db.registerClaim.get('claim');
-      if (now?.registerId !== claim.registerId || now.last !== claim.last) return false;
+      if (
+        now?.registerId !== claim.registerId ||
+        now.last !== claim.last ||
+        now.lastReturn !== claim.lastReturn
+      ) {
+        return false;
+      }
       if (shift && (await db.posShift.get('shift'))?.rev !== shift.before.rev) return false;
-      await db.registerClaim.put({ ...claim, last: sequence });
+      await db.registerClaim.put({
+        ...now,
+        last: sequence,
+        ...(exchange && { lastReturn: returnSequence }),
+      });
+      // The return first: the outbox sends in this order, and the sale's payment names it
+      if (returnRow) await db.outbox.add(returnRow);
       await db.outbox.add(row);
       if (shift) await db.posShift.put(shift.row);
       // The cart on the screen is this sale now: a reload must not bring it back to be sold twice
       await db.posCarts.delete(SCREEN_CART);
+      // At the generation of the pull, like a row the pull wrote: a full pull under way keeps it
+      if (saleRow) {
+        const { generation } = await readPullState(db);
+        await db.posSales.put({ ...saleRow, gen: generation });
+      }
       return true;
     });
-    if (saved) return { kind: 'saved', saleId, sequence, number };
+    if (saved) return { kind: 'saved', saleId, sequence, number, returnNumber };
     if (attempt === SAVE_ATTEMPTS) throw new Error('The register kept changing during the save');
   }
 }
```

- **`keepClaim()` keeps the return number and `salesLoaded` of the register it holds,** and starts both from the
  server for another register. A reload that claims the same register again must not read its sales again or go back
  to the server's return number while returns wait in the outbox.
- **`dropClaim()` clears the sales in the claim's transaction** (decision 68). The server sends a register's sales to
  its holder only, so no pull would remove them from a device that let the register go.
- **`saleEffectOf()` works the sale out once,** with the same `posSaleAmounts()` as the server, for the cash and the X
  report's sums. The discount is the lines' own and the bill's, like the shift's page (20c.3).
- **Every line gets its id here** (decision 64), before anything is sealed, so the command, the device's sale and a
  later return all name the same line.
- **`localSaleOf()` runs once, before the loop,** without the number; each attempt adds the number it got. The products
  and rates are read outside the transaction (a transaction cannot wait for Web Crypto), and they do not change with
  the number.
- **An exchange is applied to the shift before the sale** (`shiftAfterReturn` inside `shiftAfterSale`): the order does
  not change the sums, but it is the order the server posts them in.
- **The transaction checks `last` and `lastReturn` both,** and puts the return's row before the sale's: the outbox
  sends in `seq` order, and the sale's payment names the return. The sale waits for its return (`after`) in case the
  return is refused.
- **The device's sale is written at the pull's generation,** inside the same transaction, so a full pull under way does
  not sweep it, and the return screen finds the sale the moment its receipt prints.
- **`returnNumber` in the answer** is what the done dialog and the return slip print. `null` without an exchange.

#### `push.ts`, `outbox.ts`, `sealed.ts`, `engine.ts` and `index.ts`

```diff
@@ -39,8 +39,13 @@ export const NO_PUSH: PushOutcome = { accepted: 0, rejected: 0, kept: 0 };
 // no shift while the register's last one is open. "Still on the device" counts the batch being
 // made too, as for a customer: the answer comes first. A walk-in sale holds back no other sale, so
 // a shift's hundred sales still go fifty at a time.
+//
+// Step 20c: a row with `after` waits while the entry it names is still on the device before it: a
+// return for its sale sold offline, an exchange's sale for its return. Gone from the outbox =
+// accepted, so the server has it.
 export function pickBatch(rows: readonly OutboxRow[]): OutboxRow[] {
   const held = new Set<string>();
+  const keys = new Set<string>();
   // The shifts with a command on the device before this row, and those of them whose open is
   const shifts = new Set<string>();
   const opening = new Set<string>();
@@ -51,8 +56,10 @@ export function pickBatch(rows: readonly OutboxRow[]): OutboxRow[] {
     const free =
       row.status === 'waiting' &&
       !held.has(row.customerId) &&
+      (row.after === undefined || !keys.has(row.after)) &&
       (row.shiftId === undefined || shiftMayGo(row, row.shiftId, shifts, opening));
     held.add(row.customerId);
+    keys.add(row.key);
     if (row.shiftId !== undefined) {
       shifts.add(row.shiftId);
       if (row.type === 'pos_shift.open') opening.add(row.shiftId);
```

- **`keys` holds the key of every row before this one,** and a row with `after` waits while its key is there (decision
  69). Gone from the outbox means accepted, so the server has it. Like the customer's chain, a row waits for a refused
  one: the person must retry or discard it first.

```diff
@@ -307,12 +307,14 @@ function later<E extends Pick<OutboxEntry, 'seq' | 'customerId'>>(
 // register never prints it again. A sale never sent has a number the server does not know yet, and
 // a paper receipt already has it.
 // Step 20b: so does a shift's command. The drawer was counted, the money moved: the books must get
-// it, and only a refusal (a bug, decision 25) lets the person throw it away.
+// it, and only a refusal (a bug, decision 25) lets the person throw it away. Step 20c: and a return,
+// whose money was paid back and whose slip was printed.
 const DONE_AT_THE_COUNTER: ReadonlySet<OutboxRow['type']> = new Set([
   'pos_sale.create',
   'pos_shift.open',
   'pos_cash_movement.create',
   'pos_shift.close',
+  'pos_return.create',
 ]);
 
 export function isCounterCommand(type: OutboxRow['type']): boolean {
```

- **A return is a counter command** (decision 70): Discard only after a refusal, and `waitingAtCounter()` counts it, so
  the register is not let go while a return waits.

```diff
@@ -34,6 +34,8 @@ export async function sealEntry(copy: LocalCopy, entry: OutboxEntry): Promise<Ou
     ...(seq !== undefined && { seq }),
     // Step 20b: clear, like the customer's id: the push orders a shift's commands by it
     ...(entry.shiftId !== undefined && { shiftId: entry.shiftId }),
+    // Step 20c: clear too, for the same reason; and the return screen finds a sale's returns by it
+    ...(entry.after !== undefined && { after: entry.after }),
     commandId: command.id,
     type: command.type,
     status,
@@ -58,6 +60,7 @@ export async function openEntry(copy: LocalCopy, row: OutboxRow): Promise<Outbox
   return {
     ...(row.seq !== undefined && { seq: row.seq }),
     ...(row.shiftId !== undefined && { shiftId: row.shiftId }),
+    ...(row.after !== undefined && { after: row.after }),
     status: row.status,
     sent: row.sent,
     customerId: row.customerId,
```

- **`after` is copied clear both ways,** like `shiftId`. Left out of `sealEntry()`, the push would never see it.

```diff
@@ -97,6 +97,14 @@ export class SyncEngine {
 
   getStatus = (): SyncStatus => this.status;
 
+  // Step 20c: fn while no sync of this database runs, in any tab of the browser. The register's
+  // recent sales come from the claim (returns.ts → loadRegisterSales) and from the pulls: one
+  // after the other, never at once, so an older answer never overwrites a newer row.
+  async exclusive(fn: () => Promise<void>): Promise<void> {
+    const lock = this.options.lock ?? webLock;
+    await lock(`omnivo-sync:${this.options.copy.db.name}`, fn);
+  }
+
   // A sync now, and on every wake-up: the connection coming back, the window getting the focus
   // again, a tab coming back to the front, and every minute while online and in front
   start(): void {
```

- **`exclusive()` runs a function under the sync's own Web Lock,** the one `runOnce()` takes, so the register's sales
  read at the claim and a pull never write the same rows at once, in any tab (decision 68). The app reaches it through
  `withSyncLock()` (below).

```diff
@@ -1,7 +1,8 @@
 // Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
 // the outbox's saves (outbox, overlay, prices; step 18b), the key's code (crypto, keys; step 19b),
-// the POS's register and sale (pos; step 20a), its shift and carts (shift, carts; step 20b) and the
-// types: none of them loads Dexie at run time, so a page that searches customers or a
+// the POS's register and sale (pos; step 20a), its shift and carts (shift, carts; step 20b), its
+// returns (returns; step 20c) and the types: none of them loads Dexie at run time, so a page that
+// searches customers or a
 // form that saves offline stays small. The code that opens the database and syncs (database,
 // copy, apply, push, engine, live, device) brings Dexie, and the app loads it once, lazily, after
 // sign-in. `sideEffects: false` in package.json lets the bundler leave out the modules a chunk
@@ -15,6 +16,7 @@ export {
   holdCart,
   type PosCart,
   type PosCartCustomer,
+  type PosCartExchange,
   type PosCartLine,
   resumeCart,
   saveScreenCart,
@@ -35,13 +37,16 @@ export {
   type OutboxEntry,
   type OutboxRow,
   type OutboxStatus,
+  type PosSaleRow,
   type PriceListItemRow,
   type ProductRow,
   type PullState,
   type RegisterClaim,
   type SealedRow,
   type ShiftRow,
+  type ShiftTally,
   type StockRow,
+  type StoredShift,
   SyncDatabase,
   type SyncNoticeRecord,
   type SyncTableName,
@@ -104,6 +109,21 @@ export {
   waitingAtCounter,
 } from './pos.js';
 export { lookUpPrices, productsOfVariants } from './prices.js';
+export {
+  dropOldSales,
+  keptSalesFrom,
+  loadRegisterSales,
+  localSale,
+  localSaleOf,
+  newReturnId,
+  type PosReturnResult,
+  type PosReturnSave,
+  type RegisterSalesPage,
+  returnEffectOf,
+  savePosReturn,
+  withReturns,
+  withWaitingReturns,
+} from './returns.js';
 export { STORAGE_FAILED } from './problems.js';
 export {
   applyAnswers,
@@ -145,18 +165,24 @@ export {
   searchText,
 } from './records.js';
 export {
-  cashAfterSale,
   type CashMoveResult,
   type CashMoveSave,
   closeShift,
+  EMPTY_TALLY,
   localCashReasons,
   moveCash,
   openShift,
   readShift,
+  type ReturnEffect,
+  type SaleEffect,
   type ShiftCloseResult,
   type ShiftCloseSave,
   type ShiftOpenResult,
   type ShiftOpenSave,
+  shiftAfterReturn,
+  shiftAfterSale,
+  shiftReportOf,
+  type ShiftReportFields,
   type ShiftStart,
   shiftStart,
   type ShiftState,
```

- **`returns.ts` is a module the pages may import** (the comment's first list): it loads no Dexie at run time, like
  `pos.ts` and `shift.ts`. `cashAfterSale` is gone from the exports; nothing outside used it.

#### The tests

```diff
@@ -187,7 +187,7 @@ export function orderDraft(customerId: string, variantId: string): SalesOrderDra
 }
 
 // Step 20a: a register of the branch, as the pull sends it. Step 20b: with its shift settings, an
-// over/short account and no shift yet.
+// over/short account and no shift yet. Step 20c: no exchanges, returns for 7 days.
 export function posRegister(
   fields: Partial<SyncPosRegister> & Pick<SyncPosRegister, 'code'>,
 ): SyncPosRegister {
@@ -203,6 +203,8 @@ export function posRegister(
     overShortAccountId: uuidv7(),
     varianceAlert: '500',
     lockAfter: '5',
+    exchangeAccountId: null,
+    returnDays: 7,
     deviceId: null,
     lastShift: null,
     archivedAt: null,
```

- **The register fixture has no exchange account and 7 days,** the contract's defaults; a test that needs an exchange
  sets one.

```diff
@@ -77,11 +77,12 @@ function sale(
         startingPrice: '420.0000',
         batchId: null,
         serialNumbers: [],
+        id: null,
       },
     ],
     billDiscountType: 'amount',
     billDiscount: '0',
-    payments: [{ method: 'cash', amount: '1000', reference: null }],
+    payments: [{ method: 'cash', amount: '1000', reference: null, returnId: null }],
   };
 }
 
@@ -122,21 +123,27 @@ describe('keepClaim', () => {
   it('starts from the server’s last number, and keeps the device’s own when it is ahead', async () => {
     const copy = await newCopy();
     const pos1 = register({ code: 'POS1' });
-    expect(await keepClaim(copy, { id: pos1.id, lastNumber: 123 })).toMatchObject({ last: 123 });
+    expect(
+      await keepClaim(copy, { id: pos1.id, lastNumber: 123, lastReturnNumber: 0 }),
+    ).toMatchObject({ last: 123 });
     await save(copy, pos1.id);
     await save(copy, pos1.id);
     // A claim again of the register it holds: the server has not received 124 and 125 yet
-    expect(await keepClaim(copy, { id: pos1.id, lastNumber: 123 })).toMatchObject({ last: 125 });
+    expect(
+      await keepClaim(copy, { id: pos1.id, lastNumber: 123, lastReturnNumber: 0 }),
+    ).toMatchObject({ last: 125 });
   });
 
   it('starts another register from the server’s number alone', async () => {
     const copy = await newCopy();
-    await keepClaim(copy, { id: uuidv7(), lastNumber: 900 });
+    await keepClaim(copy, { id: uuidv7(), lastNumber: 900, lastReturnNumber: 0 });
     const pos2 = uuidv7();
-    expect(await keepClaim(copy, { id: pos2, lastNumber: 7 })).toEqual({
+    expect(await keepClaim(copy, { id: pos2, lastNumber: 7, lastReturnNumber: 0 })).toEqual({
       key: 'claim',
       registerId: pos2,
       last: 7,
+      lastReturn: 0,
+      salesLoaded: false,
     });
     await dropClaim(copy);
     expect(await readClaim(copy)).toBeNull();
@@ -147,7 +154,7 @@ describe('savePosSale', () => {
   it('gives the next number and puts a command in the outbox that the server reads as it is', async () => {
     const copy = await newCopy();
     const registerId = uuidv7();
-    await keepClaim(copy, { id: registerId, lastNumber: 123 });
+    await keepClaim(copy, { id: registerId, lastNumber: 123, lastReturnNumber: 0 });
     const result = await save(copy, registerId);
     expect(result).toMatchObject({ kind: 'saved', sequence: 124, number: 'POS1-000124' });
     const [entry] = await outboxEntries(copy);
@@ -166,7 +173,7 @@ describe('savePosSale', () => {
     const copy = await newCopy();
     const registerId = uuidv7();
     const customerId = uuidv7();
-    await keepClaim(copy, { id: registerId, lastNumber: 0 });
+    await keepClaim(copy, { id: registerId, lastNumber: 0, lastReturnNumber: 0 });
     await save(copy, registerId, customerId);
     const [entry] = await outboxEntries(copy);
     expect(entry?.customerId).toBe(customerId);
@@ -175,7 +182,7 @@ describe('savePosSale', () => {
   it('gives two sales saved at the same moment two numbers', async () => {
     const copy = await newCopy();
     const registerId = uuidv7();
-    await keepClaim(copy, { id: registerId, lastNumber: 41 });
+    await keepClaim(copy, { id: registerId, lastNumber: 41, lastReturnNumber: 0 });
     const results = await Promise.all([save(copy, registerId), save(copy, registerId)]);
     expect(results.map((result) => result.kind === 'saved' && result.sequence).sort()).toEqual([
       42, 43,
@@ -186,7 +193,7 @@ describe('savePosSale', () => {
   it('saves nothing without the claim of that register', async () => {
     const copy = await newCopy();
     expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
-    await keepClaim(copy, { id: uuidv7(), lastNumber: 3 });
+    await keepClaim(copy, { id: uuidv7(), lastNumber: 3, lastReturnNumber: 0 });
     expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
     expect(await waitingAtCounter(copy)).toBe(0);
   });
@@ -196,7 +203,7 @@ describe('discarding a POS sale', () => {
   it('keeps a sale the server has not refused, and lets a refused one go', async () => {
     const copy = await newCopy();
     const registerId = uuidv7();
-    await keepClaim(copy, { id: registerId, lastNumber: 0 });
+    await keepClaim(copy, { id: registerId, lastNumber: 0, lastReturnNumber: 0 });
     await save(copy, registerId);
     const [entry] = await outboxEntries(copy);
     if (entry?.seq === undefined) throw new Error('no entry');
@@ -276,7 +283,7 @@ describe('the stock and the scanner', () => {
       }),
       null,
     );
-    await keepClaim(copy, { id: pos1.id, lastNumber: 0 });
+    await keepClaim(copy, { id: pos1.id, lastNumber: 0, lastReturnNumber: 0 });
     // 2 bags, then a pack of 5: 7 of the 38 left the counter
     await save(copy, pos1.id);
     const pack = sale(pos1.id);
@@ -293,7 +300,7 @@ describe('the stock and the scanner', () => {
       '31.0000',
     ]);
     // A sale of a register on another warehouse takes nothing from this one
-    await keepClaim(copy, { id: pos2.id, lastNumber: 0 });
+    await keepClaim(copy, { id: pos2.id, lastNumber: 0, lastReturnNumber: 0 });
     await save(copy, pos2.id);
     expect((await stockOf(copy, WAREHOUSE, [VARIANT])).map((one) => one.quantity)).toEqual([
       '31.0000',
```

```diff
@@ -25,6 +25,7 @@ import { keepClaim, savePosSale } from './pos.js';
 import { outboxEntries } from './queries.js';
 import {
   closeShift,
+  EMPTY_TALLY,
   localCashReasons,
   moveCash,
   openShift,
@@ -43,7 +44,7 @@ const BASE_UNIT = '01928c4e-0000-7000-8000-000000000001';
 async function counter(fields: Partial<SyncPosRegister> = {}) {
   const copy = await newCopy();
   const register = posRegister({ code: 'POS1', ...fields });
-  await keepClaim(copy, { id: register.id, lastNumber: 0 });
+  await keepClaim(copy, { id: register.id, lastNumber: 0, lastReturnNumber: 0 });
   return { copy, register };
 }
 
@@ -89,11 +90,12 @@ function sale(registerId: string, shiftId: string): Omit<PosSaleInput, 'sequence
         startingPrice: '420.0000',
         batchId: null,
         serialNumbers: [],
+        id: null,
       },
     ],
     billDiscountType: 'amount',
     billDiscount: '0',
-    payments: [{ method: 'cash', amount: '1000', reference: null }],
+    payments: [{ method: 'cash', amount: '1000', reference: null, returnId: null }],
   };
 }
 
@@ -189,7 +191,15 @@ describe('shiftStart', () => {
       openedAt: OPENED,
       openingDate: DAY,
       opening: count('5000.00'),
-      cash: { opening: '5000', cashTaken: '0', changeGiven: '0', paidIn: '0', paidOut: '0' },
+      cash: {
+        opening: '5000',
+        cashTaken: '0',
+        changeGiven: '0',
+        paidIn: '0',
+        paidOut: '0',
+        cashRefunded: '0',
+      },
+      tally: EMPTY_TALLY,
       closedAt: OPENED,
       counted: '7640.00',
       expected: '8160.0000',
@@ -276,6 +286,16 @@ describe('a shift on the device', () => {
       changeGiven: '320.0000',
       paidIn: '2000.0000',
       paidOut: '1000.0000',
+      cashRefunded: '0',
+    });
+    // Step 20c: and the X report's sums of the two sales
+    expect((await readShift(copy))?.tally).toMatchObject({
+      saleCount: 2,
+      salesTotal: '1680.0000',
+      salesDiscount: '0.0000',
+      taken: [{ method: 'cash', amount: '2000.0000' }],
+      returnCount: 0,
+      refunded: [],
     });
 
     await holdCart(copy, shift.id, held('Customer in the blue shirt'));
```

- **The old fixtures get the new fields:** a line's `id: null` (a sale from before 20c), a payment's `returnId: null`,
  a claim's `lastReturnNumber: 0`, a stored shift's `cashRefunded` and `tally`. `keepClaim()`'s exact answer now has
  `lastReturn` and `salesLoaded`.
- **"Adds up the cash of its sales and movements" also checks the X report's sums** of its two sales: 2 sales, ৳1,680,
  ৳2,000 taken in cash, no return.

```ts
import 'fake-indexeddb/auto';

import {
  type PosReturnableLine,
  type PosSaleInput,
  posReturnAmounts,
  syncCommandSchema,
  type SyncPosSale,
  type TaxRate,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import type { LocalCopy } from './copy.js';
import type { StoredShift } from './database.js';
import { dropClaim, keepClaim, readClaim, savePosSale } from './pos.js';
import { pickBatch } from './push.js';
import { outboxEntries } from './queries.js';
import {
  loadRegisterSales,
  localSale,
  newReturnId,
  type PosReturnSave,
  savePosReturn,
  withReturns,
  withWaitingReturns,
} from './returns.js';
import { closeShift, openShift, readShift, shiftReportOf } from './shift.js';
import { newCopy, page, posRegister, product, upsertProduct, VAT_15 } from './test-fixtures.js';

const DAY = '2026-10-29';
const AT = '2026-10-29T05:00:00.000Z';

const vat15: TaxRate = {
  id: VAT_15,
  name: 'VAT 15%',
  kind: 'standard',
  rate: '15.00',
  isDefault: true,
  archivedAt: null,
  version: 1,
  updatedAt: AT,
};
const polo = product({ name: 'Polo shirt', code: 'POLO-M' });
const POLO = polo.variants[0]?.id ?? '';

// A copy that holds POS1, with the shirt and the rate in it and a shift open
async function counter() {
  const copy = await newCopy();
  const register = posRegister({ code: 'POS1', exchangeAccountId: uuidv7() });
  await applyPage(
    copy,
    page({
      changes: [
        upsertProduct(polo),
        { op: 'upsert', entity: 'tax_rate', key: vat15.id, data: vat15 },
      ],
      serverTime: AT,
    }),
    null,
  );
  await keepClaim(copy, { id: register.id, lastNumber: 0, lastReturnNumber: 0 });
  const opened = await openShift(copy, {
    register,
    input: {
      date: DAY,
      openedAt: AT,
      opening: { notes: null, total: '5000' },
      floatReasonId: null,
    },
    savedAt: AT,
  });
  if (opened.kind !== 'opened') throw new Error(`The shift did not open: ${opened.kind}`);
  return { copy, register, shiftId: opened.shift.id };
}

// Shirts at ৳420 with VAT, paid in cash
function sale(
  registerId: string,
  shiftId: string,
  quantity = '2',
  payments: PosSaleInput['payments'] = [
    { method: 'cash', amount: '1000', reference: null, returnId: null },
  ],
): Omit<PosSaleInput, 'sequence'> {
  return {
    registerId,
    shiftId,
    date: DAY,
    soldAt: AT,
    customerId: null,
    pricesIncludeVat: true,
    lines: [
      {
        id: null,
        variantId: POLO,
        unitId: polo.baseUnitId,
        quantity,
        description: null,
        unitPrice: '420',
        discountType: 'percent',
        discount: '0',
        taxRateId: VAT_15,
        rate: '15.00',
        startingPrice: '420.0000',
        batchId: null,
        serialNumbers: [],
      },
    ],
    billDiscountType: 'amount',
    billDiscount: '0',
    payments,
  };
}

async function sold(copy: LocalCopy, input: Omit<PosSaleInput, 'sequence'>) {
  const saved = await savePosSale(copy, {
    input,
    registerCode: 'POS1',
    total: '840.0000',
    savedAt: AT,
  });
  if (saved.kind !== 'saved') throw new Error(`The sale was not saved: ${saved.kind}`);
  const found = await localSale(copy, saved.number);
  if (!found) throw new Error('The sale is not on the device');
  return found;
}

// One shirt of the sale's first line back, paid back by `refunds`
function giveBack(
  sale: SyncPosSale,
  shiftId: string,
  refunds: (amount: string) => PosReturnSave['input']['refunds'] = (amount) => [
    { method: 'cash', amount, reference: null },
  ],
): PosReturnSave {
  const line = sale.lines[0];
  if (!line) throw new Error('The sale has no line');
  const amounts = posReturnAmounts(line, '1');
  return {
    returnId: newReturnId(),
    registerCode: 'POS1',
    savedAt: AT,
    input: {
      registerId: sale.registerId,
      shiftId,
      date: DAY,
      returnedAt: AT,
      saleId: sale.id,
      lines: [
        {
          saleLineId: line.id,
          quantity: '1',
          net: amounts.net,
          vat: amounts.vat,
          serialNumbers: [],
        },
      ],
      refunds: refunds(amounts.total),
      note: 'Wrong size',
    },
  };
}

// A sale as the server sends it (the pull, the register's recent sales)
function serverSale(number: string, date: string, registerId: string): SyncPosSale {
  return {
    id: uuidv7(),
    number,
    registerId,
    date,
    soldAt: `${date}T05:00:00.000Z`,
    customer: { id: uuidv7(), code: 'C-00042', name: 'Farhana Akter' },
    pricesIncludeVat: true,
    total: '420.0000',
    lines: [],
    payments: [{ method: 'cash', amount: '420.0000' }],
  };
}

describe('a sale on the device', () => {
  it('is kept with the ids of its lines, so its goods can come back before it syncs', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    expect(found).toMatchObject({
      number: 'POS1-000001',
      date: DAY,
      customer: null,
      total: '840.0000',
      payments: [{ method: 'cash', amount: '1000.0000' }],
    });
    expect(found.lines).toMatchObject([
      {
        productName: 'Polo shirt',
        sku: 'POLO-M',
        description: 'Polo shirt',
        quantity: '2.0000',
        baseQuantity: '2.0000',
        unitPrice: '420.0000',
        taxRate: { id: VAT_15, name: 'VAT 15%', rate: '15.00' },
        total: '840.0000',
        returnedQuantity: '0.0000',
      },
    ]);
    // The command names the same line: the server keeps the device's id
    const [, saleEntry] = await outboxEntries(copy);
    const command = syncCommandSchema.parse(saleEntry?.command);
    expect(command.type === 'pos_sale.create' && command.input.lines[0]?.id).toBe(
      found.lines[0]?.id,
    );
    // The number is clear for the search, the rest sealed
    const [row] = await copy.db.posSales.toArray();
    expect(row?.number).toBe('POS1-000001');
    expect(JSON.stringify(row)).not.toContain('Polo shirt');
  });
});

describe('a return on the device', () => {
  it('takes the next return number, its cash out of the drawer, and less is left to return', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    const first = giveBack(found, shiftId);
    expect(await savePosReturn(copy, first)).toEqual({
      kind: 'saved',
      sequence: 1,
      number: 'POS1-R000001',
    });
    const [, , entry] = await outboxEntries(copy);
    expect(entry).toMatchObject({
      key: first.returnId,
      customerId: first.returnId,
      name: 'POS1-R000001',
      lines: 1,
      total: null,
      shiftId,
      after: found.id,
    });
    expect(syncCommandSchema.parse(entry?.command)).toMatchObject({
      type: 'pos_return.create',
      returnId: first.returnId,
      input: { sequence: 1, saleId: found.id },
    });
    expect((await readClaim(copy))?.lastReturn).toBe(1);
    // ৳420 back in cash: out of the drawer, and in the X report's sums
    const shift = await readShift(copy);
    expect(shift?.cash.cashRefunded).toBe('420.0000');
    expect(shift?.tally).toMatchObject({
      returnCount: 1,
      returnsTotal: '420.0000',
      refunded: [{ method: 'cash', amount: '420.0000' }],
    });

    // The sale's row still says nothing came back (the server's word); the outbox says one did
    const left = await withWaitingReturns(copy, found);
    expect(left.lines[0]?.returnedQuantity).toBe('1.0000');
    const second = giveBack(left, shiftId);
    expect(await savePosReturn(copy, second)).toMatchObject({ number: 'POS1-R000002' });
    // The second shirt takes the rest of the line, to the paisa
    expect(second.input.lines[0]).toMatchObject({ net: '365.2200', vat: '54.7800' });
  });

  it("adds only the returns never sent to the server's answer, which counted the others", async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    await savePosReturn(copy, giveBack(found, shiftId));
    // The server's answer counts the return once it ran it; the device's copy still says none
    const server = withReturns(found, [
      {
        lines: [
          {
            saleLineId: found.lines[0]?.id ?? '',
            quantity: '1',
            net: '0',
            vat: '0',
            serialNumbers: [],
          },
        ],
      },
    ]);
    // Not sent yet: the server cannot have it, so it is added
    expect((await withWaitingReturns(copy, found, true)).lines[0]?.returnedQuantity).toBe('1.0000');
    // Sent, its answer on the way: the server's own count has it already
    await copy.db.outbox.toCollection().modify({ sent: true, status: 'sending' });
    expect((await withWaitingReturns(copy, server, true)).lines[0]?.returnedQuantity).toBe(
      '1.0000',
    );
    // The device's own row still counts it, sent or not
    expect((await withWaitingReturns(copy, found)).lines[0]?.returnedQuantity).toBe('1.0000');
  });

  it('needs the register and its open shift', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    const other = giveBack({ ...found, registerId: uuidv7() }, shiftId);
    expect(await savePosReturn(copy, other)).toEqual({ kind: 'not-held' });
    expect(await savePosReturn(copy, giveBack(found, uuidv7()))).toEqual({ kind: 'no-shift' });
  });

  it('counts the serial numbers and quantities of every return of a line', () => {
    const line: PosReturnableLine = {
      id: uuidv7(),
      variantId: POLO,
      productId: polo.id,
      productCode: 'POLO-M',
      productName: 'Polo shirt',
      optionValues: [],
      sku: 'POLO-M',
      baseUnitId: polo.baseUnitId,
      tracking: 'serial',
      unitId: polo.baseUnitId,
      quantity: '3.0000',
      baseQuantity: '3.0000',
      description: 'Polo shirt',
      unitPrice: '420.0000',
      taxRate: { id: VAT_15, name: 'VAT 15%', kind: 'standard', rate: '15.00' },
      net: '1095.6522',
      vat: '164.3478',
      total: '1260.0000',
      serialNumbers: ['A1', 'A2', 'A3'],
      returnedSerialNumbers: ['A1'],
      returnedQuantity: '1.0000',
    };
    const back = withReturns({ ...serverSale('POS1-000009', DAY, uuidv7()), lines: [line] }, [
      {
        lines: [{ saleLineId: line.id, quantity: '1', net: '0', vat: '0', serialNumbers: ['A2'] }],
      },
    ]);
    expect(back.lines[0]).toMatchObject({
      returnedQuantity: '2.0000',
      returnedSerialNumbers: ['A1', 'A2'],
    });
  });
});

describe('an exchange', () => {
  it('is saved with its sale: the return first, the sale waiting for it, no cash out', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    // One shirt back (৳420), two new ones (৳840): the return's money and ৳500 in cash, ৳80 change
    const back = giveBack(found, shiftId, (amount) => [
      { method: 'exchange', amount, reference: null },
    ]);
    const saved = await savePosSale(copy, {
      input: sale(register.id, shiftId, '2', [
        { method: 'exchange', amount: '420', reference: null, returnId: back.returnId },
        { method: 'cash', amount: '500', reference: null, returnId: null },
      ]),
      registerCode: 'POS1',
      total: '840.0000',
      savedAt: AT,
      exchange: back,
    });
    expect(saved).toMatchObject({
      kind: 'saved',
      number: 'POS1-000002',
      returnNumber: 'POS1-R000001',
    });
    const entries = await outboxEntries(copy);
    expect(entries.map((entry) => [entry.name, entry.after ?? null])).toEqual([
      ['POS1-S0001', null],
      ['POS1-000001', null],
      ['POS1-R000001', found.id],
      ['POS1-000002', back.returnId],
    ]);
    expect(await readClaim(copy)).toMatchObject({ last: 2, lastReturn: 1 });
    const shift = await readShift(copy);
    // The exchange never touches the drawer: ৳1,000 and ৳500 in cash, ৳160 and ৳80 change, nothing
    // refunded
    expect(shift?.cash).toMatchObject({
      cashTaken: '1500.0000',
      changeGiven: '240.0000',
      cashRefunded: '0.0000',
    });
    expect(shift?.tally).toMatchObject({
      saleCount: 2,
      returnCount: 1,
      taken: [
        { method: 'cash', amount: '1500.0000' },
        { method: 'exchange', amount: '420.0000' },
      ],
      refunded: [{ method: 'exchange', amount: '420.0000' }],
    });
  });

  it('goes to the server in its order: the sale, its return, the exchange sale', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    const back = giveBack(found, shiftId, (amount) => [
      { method: 'exchange', amount, reference: null },
    ]);
    await savePosSale(copy, {
      input: sale(register.id, shiftId, '1', [
        { method: 'exchange', amount: '420', reference: null, returnId: back.returnId },
      ]),
      registerCode: 'POS1',
      total: '420.0000',
      savedAt: AT,
      exchange: back,
    });
    // Each batch as the push would take it, its commands then accepted (gone from the outbox)
    const batches: string[][] = [];
    for (let round = 0; round < 5; round += 1) {
      const rows = await copy.db.outbox.toArray();
      const batch = pickBatch(rows);
      if (batch.length === 0) break;
      batches.push(batch.map((row) => row.type));
      await copy.db.outbox.bulkDelete(batch.flatMap((row) => row.seq ?? []));
    }
    expect(batches).toEqual([
      ['pos_shift.open'],
      ['pos_sale.create'],
      ['pos_return.create'],
      ['pos_sale.create'],
    ]);
  });
});

describe("the register's recent sales", () => {
  it('are read page by page once after the claim, and leave with the claim', async () => {
    const { copy, register } = await counter();
    const pages = [
      { items: [serverSale('POS1-000117', '2026-10-02', register.id)], nextCursor: 'next' },
      { items: [serverSale('POS1-000118', '2026-10-28', register.id)], nextCursor: null },
    ];
    const asked: (string | null)[] = [];
    const loaded = await loadRegisterSales(copy, register.id, (cursor) => {
      asked.push(cursor);
      return Promise.resolve(pages[asked.length - 1] ?? { items: [], nextCursor: null });
    });
    expect(loaded).toBe('loaded');
    expect(asked).toEqual([null, 'next']);
    expect((await readClaim(copy))?.salesLoaded).toBe(true);
    expect((await localSale(copy, 'POS1-000117'))?.customer?.name).toBe('Farhana Akter');
    // The same claim again keeps them; a sign-out or Change register takes them away
    await keepClaim(copy, { id: register.id, lastNumber: 118, lastReturnNumber: 0 });
    expect((await readClaim(copy))?.salesLoaded).toBe(true);
    await dropClaim(copy);
    expect(await copy.db.posSales.count()).toBe(0);
  });

  it('are not written once another register is held', async () => {
    const { copy, register } = await counter();
    const loaded = await loadRegisterSales(copy, uuidv7(), () =>
      Promise.resolve({
        items: [serverSale('POS2-000001', DAY, register.id)],
        nextCursor: null,
      }),
    );
    expect(loaded).toBe('not-held');
    expect(await copy.db.posSales.count()).toBe(0);
  });

  it('come with the pull, sealed, and go after 30 days at the end of a pull', async () => {
    const { copy, register } = await counter();
    const old = serverSale('POS1-000001', '2026-09-20', register.id);
    const recent = serverSale('POS1-000090', '2026-10-27', register.id);
    await applyPage(
      copy,
      page({
        changes: [old, recent].map((data) => ({
          op: 'upsert' as const,
          entity: 'pos_sale' as const,
          key: data.id,
          data,
        })),
        serverTime: '2026-10-29T18:30:00.000Z',
      }),
      null,
    );
    const rows = await copy.db.posSales.toArray();
    expect(rows.map((row) => row.number)).toEqual(['POS1-000090']);
    expect(JSON.stringify(rows)).not.toContain('Farhana Akter');
  });
});

describe('the shift reports', () => {
  it('are blind while the shift is open, and have the drawer once it is closed', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    await savePosReturn(copy, giveBack(found, shiftId));
    const fields = { register, cashierName: 'Sumi Akter', printedAt: AT };
    const open = await readShift(copy);
    if (!open) throw new Error('no shift');
    const x = shiftReportOf(open, { ...fields, kind: 'x' });
    expect(x).toMatchObject({
      kind: 'x',
      shiftNumber: 'POS1-S0001',
      closedAt: null,
      saleCount: 1,
      salesTotal: '840.0000',
      returnCount: 1,
      returnsTotal: '420.0000',
      drawer: null,
    });
    const closed = await closeShift(copy, {
      shiftId,
      input: { date: DAY, closedAt: AT, counted: { notes: null, total: '5420' } },
      savedAt: AT,
    });
    if (closed.kind !== 'closed') throw new Error('not closed');
    // 5,000 + 1,000 − 160 change − 420 back = ৳5,420
    expect(shiftReportOf(closed.shift, { ...fields, kind: 'z' }).drawer).toMatchObject({
      cashRefunded: '420.0000',
      expected: '5420.0000',
      counted: '5420',
      difference: '0.0000',
    });
  });

  it('read a shift opened before 20c as one with no returns yet', async () => {
    const { copy, shiftId } = await counter();
    const row = await copy.db.posShift.get('shift');
    if (!row) throw new Error('no shift');
    const shift = await copy.open('posShift', 'shift', row.box);
    // What 20b's app saved: no cash refunded, no tally
    const old: StoredShift = {
      ...shift,
      cash: {
        opening: shift.cash.opening,
        cashTaken: '0',
        changeGiven: '0',
        paidIn: '0',
        paidOut: '0',
      },
    };
    delete old.tally;
    await copy.db.posShift.put({ ...row, box: await copy.seal('posShift', 'shift', old) });
    expect(await readShift(copy)).toMatchObject({
      id: shiftId,
      cash: { cashRefunded: '0' },
      tally: { saleCount: 0, returnCount: 0, taken: [] },
    });
  });
});
```

- **The world is one counter with the shirt and its VAT rate in the copy,** because `localSaleOf()` reads both. Every
  test opens a shift: a return needs one (decision 19).
- **"A sale on the device"** checks decision 64 end to end: the sale is found by its number before any sync, the line's
  id is the command's, and the row on the disk has the number but not the shirt's name.
- **"Takes the next return number…"** checks the outbox row's clear fields (`after`, its own chain, no total), the
  command against the contract's schema, the claim, the drawer and the sums, and that `withWaitingReturns()` counts the
  return before the server does. The second shirt then takes the rest of the line to the paisa (decision 65).
- **"Adds only the returns never sent to the server's answer"** (added in 20c.7, decision 98): unsent, the return is
  added; sent, the server's own count is taken as it is; the device's own row counts it either way.
- **"Is saved with its sale"** is decision 72's save: the outbox's order and `after` fields, both numbers in the claim,
  and a drawer that never sees the exchange's money.
- **"Goes to the server in its order"** runs `pickBatch()` round after round, deleting each batch as an accepted push
  would: the shift's open, the sale, its return, the exchange sale, one at a time.
- **"Are read page by page once after the claim"** checks the cursor, `salesLoaded`, that a claim of the same register
  keeps them, and that `dropClaim()` takes them away. **"Are not written once another register is held"** is the guard
  in each page's transaction.
- **"Come with the pull… and go after 30 days"** sends a sale of 20 Sep with a server time of 29 Oct: dropped at the
  end of the pull, and the kept one has no customer name on the disk.
- **"Read a shift opened before 20c"** writes a box without `cashRefunded` and `tally`, the way 20b's app saved it, and
  reads zeros back (decision 71).

### `packages/i18n`: four words

The four keys of decision 74 (`pos.exchange.dropTitle`, `keep`, `closeFirst` and `pos.return.back`) are in 20c.5's diffs
of `en.ts` and `bn.ts` above, in the blocks they belong to (decision 58).

### `apps/app`: the counter

#### `lib/pos-returns.ts` (new): the return screen's rules

```ts
import {
  addMoney,
  compareMoney,
  compareQuantity,
  isQuantity,
  isWithinReturnWindow,
  type PosPaperWidth,
  type PosReturnableLine,
  type PosReturnableSale,
  type PosReturnLineInput,
  posReturnAmounts,
  type PosTender,
  returnableQuantityOf,
  subtractMoney,
  sumMoney,
  type SyncPosRegister,
} from '@omnivo/contracts';

// Step 20c: the return screen's rules, worked out without React, so they are tested on their own
// (pos-returns.spec.ts), like the cart's (pos.ts).

// What the cashier ticked of one sale line: the quantity coming back, as typed, in the line's unit;
// for a serial product, the serial numbers ticked (its quantity is how many)
export interface ReturnPick {
  quantity: string;
  serials: string[];
}

// By the sale line's id. A line that is not here is not coming back.
export type ReturnPicks = Readonly<Record<string, ReturnPick>>;

// The serial numbers of a line that have not come back yet: the only ones offered
export function serialsLeft(line: PosReturnableLine): string[] {
  const back = new Set(line.returnedSerialNumbers);
  return line.serialNumbers.filter((serial) => !back.has(serial));
}

// A line with nothing left to return is shown, not offered ("All of it came back")
export function hasLeft(line: PosReturnableLine): boolean {
  return compareQuantity(returnableQuantityOf(line), '0') > 0;
}

// Ticking a line starts with one coming back, or all of it when less than one is left (a sale of
// 0.5 kg); a serial line starts with none ticked: the scanner or the cashier ticks them
export function firstPick(line: PosReturnableLine): ReturnPick {
  const left = returnableQuantityOf(line);
  if (line.tracking === 'serial') return { quantity: '0', serials: [] };
  return { quantity: compareQuantity(left, '1') >= 0 ? '1' : left, serials: [] };
}

function quantityOf(line: PosReturnableLine, pick: ReturnPick): string {
  return line.tracking === 'serial' ? String(pick.serials.length) : pick.quantity;
}

// One line as posReturnInputSchema reads it, with its money (posReturnAmounts, from what came back
// before). null for a line still being typed ("1.") or at 0.
export function returnLineOf(line: PosReturnableLine, pick: ReturnPick): PosReturnLineInput | null {
  const quantity = quantityOf(line, pick);
  if (!isQuantity(quantity) || compareQuantity(quantity, '0') <= 0) return null;
  const amounts = posReturnAmounts(line, quantity);
  return {
    saleLineId: line.id,
    quantity,
    net: amounts.net,
    vat: amounts.vat,
    serialNumbers: line.tracking === 'serial' ? pick.serials : [],
  };
}

// The lines ticked, each with its money
export function returnLinesOf(sale: PosReturnableSale, picks: ReturnPicks): PosReturnLineInput[] {
  return sale.lines.flatMap((line) => {
    const pick = picks[line.id];
    const back = pick && returnLineOf(line, pick);
    return back ? [back] : [];
  });
}

// "2" for the box from "2.0000": the arithmetic's 4 decimals without the zeros at the end
export function plainQuantity(quantity: string): string {
  const [whole = '0', fraction = ''] = quantity.split('.');
  const kept = fraction.replace(/0+$/, '');
  return kept === '' ? whole : `${whole}.${kept}`;
}

// What the lines pay back, with VAT
export function returnTotalOf(lines: readonly Pick<PosReturnLineInput, 'net' | 'vat'>[]): string {
  return sumMoney(lines.map((line) => addMoney(line.net, line.vat)));
}

// Why the sale cannot come back at this counter today: an error code the dialog says, or null.
// The window is the register's (decision 8); the server would take the return all the same and
// write the audit log, so this is the screen's rule.
export function saleProblem(
  sale: PosReturnableSale,
  today: string,
  register: Pick<SyncPosRegister, 'returnDays'>,
): 'pos_return_too_old' | 'pos_return_nothing_left' | null {
  if (!isWithinReturnWindow(sale.date, today, register.returnDays)) return 'pos_return_too_old';
  if (!sale.lines.some(hasLeft)) return 'pos_return_nothing_left';
  return null;
}

// Why the ticked lines cannot be paid back yet, with the line it is about: none ticked, or more
// than is left of one
export function picksProblem(
  sale: PosReturnableSale,
  picks: ReturnPicks,
): {
  code: 'pos_return_lines_required' | 'pos_return_quantity_too_large';
  line: string | null;
} | null {
  for (const line of sale.lines) {
    const pick = picks[line.id];
    if (!pick) continue;
    const quantity = quantityOf(line, pick);
    if (isQuantity(quantity) && compareQuantity(quantity, returnableQuantityOf(line)) > 0) {
      return { code: 'pos_return_quantity_too_large', line: line.id };
    }
  }
  if (returnLinesOf(sale, picks).length === 0) {
    return { code: 'pos_return_lines_required', line: null };
  }
  return null;
}

// An exchange's money on the new sale (decision 7): it pays the sale up to its total, never more;
// what is left over is paid back now, the return's other refund
export function exchangeSplit(credit: string, saleTotal: string): { used: string; rest: string } {
  const used = compareMoney(credit, saleTotal) > 0 ? saleTotal : credit;
  return { used: sumMoney([used]), rest: subtractMoney(credit, used) };
}

// ---------------------------------------------------------------------------------------------
// The return slip (pos-slips.tsx), printed by itself after the return

export interface ReturnSlipLine {
  key: string;
  name: string;
  quantity: string;
  decimals: number;
  unitCode: string;
  unitPrice: string;
  total: string;
  serialNumbers: string[];
}

export interface ReturnSlipData {
  number: string;
  returnedAt: string;
  registerCode: string;
  paperWidth: PosPaperWidth;
  receiptFooter: string | null;
  cashier: string;
  sale: { number: string; date: string };
  // null = walk-in
  customerName: string | null;
  lines: ReturnSlipLine[];
  net: string;
  vat: string;
  total: string;
  // How the money went back; an exchange's money is "Used on sale POS1-000188" instead
  refunds: { method: PosTender; amount: string; reference: string | null }[];
  usedOn: string | null;
  note: string | null;
}

// A unit's code and decimals, from the copy (the screen reads the units once)
export type UnitOf = (unitId: string) => { code: string; decimals: number } | undefined;

export function returnSlipOf(input: {
  number: string;
  returnedAt: string;
  register: Pick<SyncPosRegister, 'code' | 'paperWidth' | 'receiptFooter'>;
  cashier: string;
  sale: PosReturnableSale;
  lines: readonly PosReturnLineInput[];
  refunds: ReturnSlipData['refunds'];
  usedOn: string | null;
  note: string | null;
  unitOf: UnitOf;
}): ReturnSlipData {
  const { sale, register } = input;
  return {
    number: input.number,
    returnedAt: input.returnedAt,
    registerCode: register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: input.cashier,
    sale: { number: sale.number, date: sale.date },
    customerName: sale.customer?.name ?? null,
    lines: input.lines.flatMap((line) => {
      const sold = sale.lines.find((one) => one.id === line.saleLineId);
      if (!sold) return [];
      const unit = input.unitOf(sold.unitId);
      return [
        {
          key: line.saleLineId,
          name: sold.description,
          quantity: line.quantity,
          decimals: unit?.decimals ?? 0,
          unitCode: unit?.code ?? '',
          unitPrice: sold.unitPrice,
          total: addMoney(line.net, line.vat),
          serialNumbers: line.serialNumbers,
        },
      ];
    }),
    net: sumMoney(input.lines.map((line) => line.net)),
    vat: sumMoney(input.lines.map((line) => line.vat)),
    total: returnTotalOf(input.lines),
    refunds: input.refunds.filter((refund) => refund.method !== 'exchange'),
    usedOn: input.usedOn,
    note: input.note,
  };
}
```

- **A pick is what the cashier ticked, as typed.** The quantity stays a string while it is typed ("1."), like the cart's;
  a serial line's quantity is how many numbers are ticked, so the two can never disagree.
- **`firstPick()` starts with one piece, or with what is left when that is less than one** (half a kilo sold), and a
  serial line with nothing ticked: the cashier ticks the number on the item in hand.
- **`returnLineOf()` leaves out a box still being typed or at 0,** and works the money out with the contract's
  `posReturnAmounts()`, from what came back before (the server's count plus this device's outbox).
- **`saleProblem()` and `picksProblem()` return error codes** (decision 76), which the dialog's `FormAlert` and the
  line's own message say in the page's language. The window is the register's, not the sale's register's: the goods
  come back at this counter.
- **`exchangeSplit()` is decision 7 in numbers:** the return's money pays up to the sale's total, never more, and the
  rest is paid back now.
- **`returnSlipOf()` leaves the exchange out of the refunds** and prints the sale it paid for instead ("Used on sale
  POS1-000188"), as the mockup's slip does.

```ts
import type { PosReturnableLine, PosReturnableSale } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  exchangeSplit,
  firstPick,
  picksProblem,
  returnLinesOf,
  returnSlipOf,
  returnTotalOf,
  saleProblem,
  serialsLeft,
} from './pos-returns';

const PCS = '01928c4e-0000-7000-8000-000000000001';

function line(
  fields: Partial<PosReturnableLine> & Pick<PosReturnableLine, 'id'>,
): PosReturnableLine {
  return {
    variantId: '01928c4e-8888-7000-8000-000000000001',
    productId: '01928c4e-8888-7000-8000-000000000002',
    productCode: 'POLO',
    productName: 'Men’s polo shirt',
    optionValues: ['M'],
    sku: 'POLO-M',
    baseUnitId: PCS,
    tracking: 'none',
    unitId: PCS,
    quantity: '2.0000',
    baseQuantity: '2.0000',
    description: 'Men’s polo shirt — M',
    unitPrice: '850.0000',
    taxRate: {
      id: '01928c4e-7777-7000-8000-000000000002',
      name: 'VAT 15%',
      kind: 'standard',
      rate: '15.00',
    },
    net: '1478.2600',
    vat: '221.7400',
    total: '1700.0000',
    serialNumbers: [],
    returnedSerialNumbers: [],
    returnedQuantity: '0.0000',
    ...fields,
  };
}

const shirts = line({ id: '01928c4e-1111-7000-8000-000000000001' });
const charger = line({
  id: '01928c4e-1111-7000-8000-000000000002',
  description: 'USB-C charger 20 W',
  tracking: 'serial',
  quantity: '2.0000',
  net: '1478.2600',
  vat: '221.7400',
  total: '1700.0000',
  serialNumbers: ['CHG20-7Q41K', 'CHG20-7Q41L'],
  returnedSerialNumbers: ['CHG20-7Q41L'],
  returnedQuantity: '1.0000',
});
const tea = line({
  id: '01928c4e-1111-7000-8000-000000000003',
  description: 'Black tea 400 g',
  quantity: '1.0000',
  returnedQuantity: '1.0000',
});

const sale: PosReturnableSale = {
  id: '01928c4e-2222-7000-8000-000000000001',
  number: 'POS1-000164',
  registerId: '01928c4e-3333-7000-8000-000000000001',
  date: '2026-10-28',
  soldAt: '2026-10-28T10:12:00.000Z',
  customer: null,
  pricesIncludeVat: true,
  total: '4250.0000',
  lines: [shirts, charger, tea],
  payments: [{ method: 'cash', amount: '4250.0000' }],
};

describe('the lines coming back', () => {
  it('start with one piece, or with no serial number ticked', () => {
    expect(firstPick(shirts)).toEqual({ quantity: '1', serials: [] });
    expect(firstPick(charger)).toEqual({ quantity: '0', serials: [] });
    expect(serialsLeft(charger)).toEqual(['CHG20-7Q41K']);
  });

  it('pay each line back at its share, a serial line by the numbers ticked', () => {
    const lines = returnLinesOf(sale, {
      [shirts.id]: { quantity: '1', serials: [] },
      [charger.id]: { quantity: '0', serials: ['CHG20-7Q41K'] },
    });
    expect(lines).toEqual([
      { saleLineId: shirts.id, quantity: '1', net: '739.1300', vat: '110.8700', serialNumbers: [] },
      // The last charger takes what is left of its line
      {
        saleLineId: charger.id,
        quantity: '1',
        net: '739.1300',
        vat: '110.8700',
        serialNumbers: ['CHG20-7Q41K'],
      },
    ]);
    expect(returnTotalOf(lines)).toBe('1700.0000');
  });

  it('leave out a box still being typed, and say what stops the next step', () => {
    expect(returnLinesOf(sale, { [shirts.id]: { quantity: '1.', serials: [] } })).toEqual([]);
    expect(picksProblem(sale, {})).toEqual({ code: 'pos_return_lines_required', line: null });
    expect(picksProblem(sale, { [shirts.id]: { quantity: '3', serials: [] } })).toEqual({
      code: 'pos_return_quantity_too_large',
      line: shirts.id,
    });
    expect(picksProblem(sale, { [shirts.id]: { quantity: '2', serials: [] } })).toBeNull();
  });
});

describe('the sale', () => {
  it('comes back inside the register’s window only, and only with something left', () => {
    expect(saleProblem(sale, '2026-11-04', { returnDays: 7 })).toBeNull();
    expect(saleProblem(sale, '2026-11-05', { returnDays: 7 })).toBe('pos_return_too_old');
    expect(saleProblem(sale, '2026-10-28', { returnDays: 0 })).toBeNull();
    const back = { ...sale, lines: [tea] };
    expect(saleProblem(back, '2026-10-28', { returnDays: 7 })).toBe('pos_return_nothing_left');
  });
});

describe('an exchange', () => {
  it('pays the new sale up to its total, and the rest goes back', () => {
    expect(exchangeSplit('1700', '1750')).toEqual({ used: '1700.0000', rest: '0.0000' });
    expect(exchangeSplit('1700', '850')).toEqual({ used: '850.0000', rest: '850.0000' });
  });
});

describe('the return slip', () => {
  it('prints the lines with their units, and an exchange as the sale it paid for', () => {
    const lines = returnLinesOf(sale, { [shirts.id]: { quantity: '1', serials: [] } });
    const slip = returnSlipOf({
      number: 'POS1-R000012',
      returnedAt: '2026-11-01T09:12:00.000Z',
      register: { code: 'POS1', paperWidth: '80', receiptFooter: null },
      cashier: 'Nusrat Jahan',
      sale,
      lines,
      refunds: [{ method: 'exchange', amount: '850.0000', reference: null }],
      usedOn: 'POS1-000188',
      note: 'Wrong size',
      unitOf: () => ({ code: 'pcs', decimals: 0 }),
    });
    expect(slip).toMatchObject({
      sale: { number: 'POS1-000164', date: '2026-10-28' },
      customerName: null,
      lines: [{ name: 'Men’s polo shirt — M', quantity: '1', unitCode: 'pcs', total: '850.0000' }],
      total: '850.0000',
      refunds: [],
      usedOn: 'POS1-000188',
    });
  });
});
```

- **The sale is the mockup's:** two polo shirts, a charger with one of its two serial numbers back already, and tea
  that all came back. The tests check the first ticks, the money of a serial line (the last charger takes the rest of
  its line), a box being typed, both problems, the window at 0 and 7 days, the exchange's split both ways and the slip.

#### `lib/pos.ts` and `lib/local-data.ts`

```diff
@@ -11,6 +11,7 @@ import {
   posSaleAmounts,
   type PosSaleFormValues,
   type PosSaleTotals,
+  type PosTender,
   type Product,
   type ProductVariant,
   subtractMoney,
@@ -322,7 +323,8 @@ export interface ReceiptData {
   net: string;
   vat: string;
   total: string;
-  payments: { method: PosPaymentMethod; amount: string; reference: string | null }[];
+  // Step 20c: any tender, an exchange's money too ("Exchange 850.00")
+  payments: { method: PosTender; amount: string; reference: string | null }[];
   paid: string;
   change: string;
 }
```

- **A receipt's payment is any tender now:** an exchange's sale prints "Exchange 850.00" among its payments.

```diff
@@ -151,6 +151,14 @@ export function requestSync(): void {
   if (device.kind === 'ready') device.engine.request();
 }
 
+// Step 20c: fn while no sync of the device's copy runs, in any tab (engine.ts → exclusive). The
+// register's recent sales are written by the POS screen and by the pulls: one after the other.
+export async function withSyncLock(fn: () => Promise<void>): Promise<void> {
+  const { device } = localDataStore.getState();
+  if (device.kind !== 'ready') return;
+  await device.engine.exclusive(fn);
+}
+
 // The device's copy, when it has one open: the outbox is in it
 export function useLocalCopy(): LocalCopy | null {
   const device = useDeviceState();
```

- **`withSyncLock()` does nothing without an open copy:** the POS screen only calls it with one, and a sign-out in the
  middle must not throw.

#### `components/pos-refund-rows.tsx` (new) and `components/pos-return.tsx` (new)

```tsx
import { Cancel01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareMoney,
  MAX_POS_PAYMENTS,
  type PosPaymentMethod,
  type PosReturnableSale,
  refundMethodsOf,
  registerMethods,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, IconButton, Input, MoneyInput, Select } from '@omnivo/ui';

import { dueOf, newLineKey, type PaymentRow } from '../lib/pos';

// Step 20c: the rows that pay a return's money back, shared by the return dialog (pos-return.tsx)
// and the pay dialog's money left over from an exchange (pos-pay.tsx). A file of their own: the pay
// dialog's chunk takes these rows only, not the whole return dialog (the budget of routes/pos.tsx).

// Cash first, with the whole amount: most money goes back in cash. Also the pay dialog's first
// "Paid back by" row for an exchange's money left over.
export function refundRow(method: PosPaymentMethod, amount: string): PaymentRow {
  return { key: newLineKey(), method, amount, reference: '' };
}

// The ways the money may go back at this register: cash, and the ways the sale was paid that the
// register takes (decision 18: the server refuses a method the register has no account for)
export function refundMethodsAt(
  register: SyncPosRegister,
  sale: Pick<PosReturnableSale, 'payments'>,
): PosPaymentMethod[] {
  const taken = new Set(registerMethods(register.accounts));
  return refundMethodsOf(sale).filter((method) => taken.has(method));
}

// The refund rows: a select of the methods, the amount, the reference, and a remove button. Also
// the pay dialog's "Paid back by" rows for an exchange's money left over (pos-pay.tsx).
export function RefundRows({
  rows,
  onRows,
  methods,
  total,
}: {
  rows: readonly PaymentRow[];
  onRows: (rows: PaymentRow[]) => void;
  methods: readonly PosPaymentMethod[];
  total: string;
}) {
  const { t } = useLocale();
  const change = (key: string, fields: Partial<PaymentRow>) => {
    onRows(rows.map((row) => (row.key === key ? { ...row, ...fields } : row)));
  };
  const due = dueOf(rows, total);
  return (
    <div className="grid gap-3">
      <ul className="grid gap-3">
        {rows.map((row, index) => {
          const id = `pos-refund-${row.key}`;
          return (
            <li
              key={row.key}
              className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 sm:grid-cols-[8rem_9rem_minmax(0,1fr)_auto]"
            >
              <Select
                id={`${id}-method`}
                aria-label={t('pos.return.method')}
                value={row.method}
                onChange={(event) => {
                  const method = methods.find((one) => one === event.target.value);
                  if (method) change(row.key, { method });
                }}
                options={methods.map((method) => ({
                  value: method,
                  label: t(`pos.methods.${method}`),
                }))}
              />
              <MoneyInput
                id={`${id}-amount`}
                aria-label={t('pos.amount')}
                autoFocus={index === 0}
                value={row.amount}
                onChange={(amount) => {
                  change(row.key, { amount });
                }}
              />
              <Input
                id={`${id}-reference`}
                aria-label={t('pos.reference')}
                placeholder={t(`pos.referencePlaceholders.${row.method}`)}
                value={row.reference}
                onChange={(event) => {
                  change(row.key, { reference: event.target.value });
                }}
              />
              {rows.length > 1 && (
                <IconButton
                  icon={Cancel01Icon}
                  label={t('pos.return.removeRefund', { number: index + 1 })}
                  onClick={() => {
                    onRows(rows.filter((one) => one.key !== row.key));
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {rows.length < MAX_POS_PAYMENTS && methods.length > 1 && (
        <Button
          variant="secondary"
          size="sm"
          className="w-fit gap-1.5"
          onClick={() => {
            // The next way no row has yet, with what is still to give back
            const used = new Set(rows.map((row) => row.method));
            const method = methods.find((one) => !used.has(one)) ?? 'cash';
            onRows([...rows, refundRow(method, compareMoney(due, '0') > 0 ? due : '')]);
          }}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
          {t('pos.return.addRefund')}
        </Button>
      )}
    </div>
  );
}

// The rows as posReturnInputSchema reads them (its input: the schema turns '' into null)
export function refundValues(rows: readonly PaymentRow[]) {
  return rows.map((row) => ({ method: row.method, amount: row.amount, reference: row.reference }));
}
```

- **A file of its own** (decision 81): the pay dialog needs these rows for an exchange's money left over, and importing
  them from `pos-return.tsx` put the whole return dialog into the pay dialog's chunk.
- **The rows look and work like the pay dialog's,** row for row (the select, the money box, the reference, remove), and
  "Add another method" starts with what is still to give back, like "Add another method" in the pay dialog.
- **`refundMethodsAt()`** is decision 77: the contract's `refundMethodsOf()` (cash and the sale's methods) less the ones
  this register has no account for.
- **`refundValues()` gives the schema its input,** `''` and all: `posReturnInputSchema` turns an empty reference into
  `null`, as the pay dialog's sale does.

```tsx
import {
  ArrowLeftRightIcon,
  BarCode01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  MinusSignIcon,
  PlusSignIcon,
  PrinterIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addQuantity,
  compareQuantity,
  isMoneyAmount,
  isQuantity,
  isZeroMoney,
  lastReturnDayOf,
  POS_SALES_ON_DEVICE_DAYS,
  type PosReturnableLine,
  type PosReturnableSale,
  type PosReturnLineInput,
  posReturnInputSchema,
  returnableQuantityOf,
  routes,
  subtractQuantity,
  sumMoney,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  type DeviceShift,
  type LocalCopy,
  localSale,
  newReturnId,
  type PosCartExchange,
  savePosReturn,
  withWaitingReturns,
} from '@omnivo/sync';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  Input,
  parseIsoDate,
} from '@omnivo/ui';
import { useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { requestSync, withSyncLock } from '../lib/local-data';
import { dueOf, type PaymentRow } from '../lib/pos';
import {
  firstPick,
  hasLeft,
  picksProblem,
  plainQuantity,
  type ReturnPick,
  type ReturnPicks,
  type ReturnSlipData,
  returnLineOf,
  returnLinesOf,
  returnSlipOf,
  returnTotalOf,
  saleProblem,
  serialsLeft,
  type UnitOf,
} from '../lib/pos-returns';
import { useOnline } from '../lib/use-online';
import { DocumentNotice } from './document-notice';
import { hasPaisa, Kbd } from './pos-parts';
import { refundMethodsAt, RefundRows, refundRow, refundValues } from './pos-refund-rows';

// Step 20c: taking goods back at the counter (F6, the top bar's Return): find the receipt, tick
// what came back, pay the money back, or use it on a new sale (an exchange). One dialog that goes
// through the three steps, then the done dialog; the slip prints by itself. Its own chunk, loaded
// the first time it opens (routes/pos.tsx's budget).

// A saved return, for the done dialog and its slip
export interface DoneReturn {
  number: string;
  slip: ReturnSlipData;
}

type Step =
  | { step: 'find' }
  | { step: 'lines'; sale: PosReturnableSale }
  | {
      step: 'refund';
      sale: PosReturnableSale;
      lines: PosReturnLineInput[];
      note: string;
    };

function screenMoney(format: ReturnType<typeof useLocale>['format'], value: string): string {
  return format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// Online: the server, for any register's receipt, with what came back of it at every counter.
// Offline, or when the server does not have it (sold offline, not synced yet) or does not answer:
// this register's own sales on the device. Either way with the returns still in this device's
// outbox, which no server has counted yet. Step 20c.7: the server is asked inside the sync lock,
// so no push runs meanwhile: a return in the outbox then never reached the server, or went with
// a push whose answer was lost (withWaitingReturns leaves those out). Without the lock, a second
// return right after the first was counted twice, or not at all, by the moment of the push.
async function findSale(
  copy: LocalCopy,
  number: string,
  online: boolean,
): Promise<PosReturnableSale | null> {
  if (online) {
    try {
      // A holder, not a `let`: the lock runs the function, which TypeScript cannot follow
      const found: { sale: PosReturnableSale | null } = { sale: null };
      await withSyncLock(async () => {
        const sale = await call(routes.posReturns.returnableSale, { params: { number } });
        found.sale = await withWaitingReturns(copy, sale, true);
      });
      if (found.sale) return found.sale;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code !== 'pos_return_sale_not_found') {
        throw error;
      }
    }
  }
  const sale = await localSale(copy, number);
  return sale && withWaitingReturns(copy, sale);
}

// The ticks of a return that comes back from an exchange the cashier dropped
function picksOf(lines: readonly PosReturnLineInput[]): ReturnPicks {
  return Object.fromEntries(
    lines.map((line) => [
      line.saleLineId,
      { quantity: line.quantity, serials: line.serialNumbers },
    ]),
  );
}

export function ReturnDialog({
  copy,
  register,
  shift,
  today,
  cashier,
  timeZone,
  canReturn,
  stopped,
  unitOf,
  dropped,
  onClose,
  onDone,
  onExchange,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  shift: DeviceShift;
  today: string;
  cashier: string;
  // The workspace's, for "Sold 28 Oct 2026, 4:12 pm"
  timeZone: string;
  // pos.return.create
  canReturn: boolean;
  // Why no new work is taken now (the 7-day limit offline, a shift left open on an earlier day):
  // the screen's own notice, said here too. null = none.
  stopped: string | null;
  unitOf: UnitOf;
  // An exchange the cashier dropped: the return starts again at paying the money back
  dropped: PosCartExchange | null;
  onClose: () => void;
  onDone: (done: DoneReturn) => void;
  onExchange: (exchange: PosCartExchange) => void;
}) {
  const [step, setStep] = useState<Step>(() =>
    dropped
      ? {
          step: 'refund',
          sale: dropped.sale,
          lines: dropped.lines,
          note: dropped.note ?? '',
        }
      : { step: 'find' },
  );
  const [picks, setPicks] = useState<ReturnPicks>(() => (dropped ? picksOf(dropped.lines) : {}));
  const [note, setNote] = useState(dropped?.note ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {step.step === 'find' && (
        <FindStep
          copy={copy}
          register={register}
          today={today}
          canReturn={canReturn}
          stopped={stopped}
          onFound={(sale) => {
            setPicks({});
            setNote('');
            setStep({ step: 'lines', sale });
          }}
        />
      )}
      {step.step === 'lines' && (
        <LinesStep
          sale={step.sale}
          register={register}
          timeZone={timeZone}
          unitOf={unitOf}
          picks={picks}
          onPicks={setPicks}
          note={note}
          onNote={setNote}
          onNext={(lines) => {
            setStep({ step: 'refund', sale: step.sale, lines, note });
          }}
        />
      )}
      {step.step === 'refund' && (
        <RefundStep
          copy={copy}
          register={register}
          shift={shift}
          today={today}
          cashier={cashier}
          sale={step.sale}
          lines={step.lines}
          note={step.note}
          unitOf={unitOf}
          busy={busy}
          onBusy={setBusy}
          onBack={() => {
            setStep({ step: 'lines', sale: step.sale });
          }}
          onDone={onDone}
          onExchange={onExchange}
        />
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// 1. The receipt's number

function FindStep({
  copy,
  register,
  today,
  canReturn,
  stopped,
  onFound,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  today: string;
  canReturn: boolean;
  stopped: string | null;
  onFound: (sale: PosReturnableSale) => void;
}) {
  const { t, format } = useLocale();
  const online = useOnline();
  const [number, setNumber] = useState('');
  // An error code: FormAlert says it in the page's language
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const open = canReturn && stopped === null;

  const find = async () => {
    // Like the route: "pos1-000164" is POS1-000164
    const typed = number.trim().toUpperCase();
    if (typed === '') return;
    setFinding(true);
    setError(null);
    try {
      const sale = await findSale(copy, typed, online);
      if (!sale) {
        setError('pos_return_sale_not_found');
        return;
      }
      const problem = saleProblem(sale, today, register);
      if (problem) {
        setError(problem);
        return;
      }
      onFound(sale);
    } catch (failure) {
      setError(failure instanceof ApiRequestError ? failure.code : 'unknown_error');
    } finally {
      setFinding(false);
    }
  };

  return (
    <DialogContent
      title={t('pos.return.title')}
      description={t('pos.return.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="pos-return-find" disabled={!open || finding}>
            {finding ? t('pos.return.finding') : t('pos.return.find')}
          </Button>
        </>
      }
    >
      {!canReturn ? (
        <DocumentNotice tone="neutral">{t('pos.return.cantReturn')}</DocumentNotice>
      ) : stopped !== null ? (
        <DocumentNotice tone="warn">{stopped}</DocumentNotice>
      ) : (
        <form
          id="pos-return-find"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!finding) void find();
          }}
        >
          {error && <FormAlert message={error} />}
          <label className="grid gap-1.5">
            <span className="text-label font-medium">{t('pos.return.number')}</span>
            <Input
              // A scanner reads the receipt's barcode into it, like the search box
              icon={BarCode01Icon}
              autoFocus
              autoComplete="off"
              placeholder={t('pos.return.numberPlaceholder')}
              value={number}
              onChange={(event) => {
                setNumber(event.target.value);
                setError(null);
              }}
            />
          </label>
          {!online && (
            <DocumentNotice tone="neutral" icon={WifiDisconnected02Icon}>
              {t('pos.return.offlineHint', {
                code: register.code,
                days: format.number(POS_SALES_ON_DEVICE_DAYS),
              })}
            </DocumentNotice>
          )}
        </form>
      )}
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. What came back

function LinesStep({
  sale,
  register,
  timeZone,
  unitOf,
  picks,
  onPicks,
  note,
  onNote,
  onNext,
}: {
  sale: PosReturnableSale;
  register: SyncPosRegister;
  timeZone: string;
  unitOf: UnitOf;
  picks: ReturnPicks;
  onPicks: (picks: ReturnPicks) => void;
  note: string;
  onNote: (note: string) => void;
  onNext: (lines: PosReturnLineInput[]) => void;
}) {
  const { t, format } = useLocale();
  const lines = returnLinesOf(sale, picks);
  const total = returnTotalOf(lines);
  const problem = picksProblem(sale, picks);
  const lastDay = parseIsoDate(lastReturnDayOf(sale.date, register.returnDays));
  const description = [
    t('pos.return.soldAt', { time: format.dateTime(new Date(sale.soldAt), timeZone) }),
    lastDay ? t('pos.return.lastDay', { date: format.date(lastDay) }) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  const pick = (line: PosReturnableLine, next: ReturnPick | null) => {
    const others = Object.fromEntries(Object.entries(picks).filter(([id]) => id !== line.id));
    onPicks(next ? { ...others, [line.id]: next } : others);
  };

  return (
    <DialogContent
      title={t('pos.return.saleTitle', { number: sale.number })}
      description={description}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            type="submit"
            form="pos-return-lines"
            // A return of ৳0 (a free sample) still needs a line; the amount may be nothing
            disabled={problem !== null}
          >
            {t('pos.return.next', { amount: screenMoney(format, total) })}
          </Button>
        </>
      }
    >
      <form
        id="pos-return-lines"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null) onNext(lines);
        }}
      >
        <ul className="divide-y divide-line overflow-hidden rounded-control border border-line">
          {sale.lines.map((line) => (
            <ReturnLineRow
              key={line.id}
              line={line}
              unitOf={unitOf}
              pick={picks[line.id] ?? null}
              onPick={(next) => {
                pick(line, next);
              }}
              tooLarge={problem?.line === line.id}
            />
          ))}
        </ul>
        <label className="grid gap-1.5">
          <span className="text-label font-medium">
            {t('pos.return.note')}{' '}
            <span className="font-normal text-ink-3">{t('common.optional')}</span>
          </span>
          <Input
            maxLength={200}
            placeholder={t('pos.return.notePlaceholder')}
            value={note}
            onChange={(event) => {
              onNote(event.target.value);
            }}
          />
        </label>
        <div className="flex items-baseline justify-between gap-3 rounded-control bg-subtle px-4 py-3">
          <span className="text-body-sm font-medium">{t('pos.return.total')}</span>
          <span className="text-kpi font-semibold tracking-[-0.03em] tabular-nums">
            {screenMoney(format, total)}
          </span>
        </div>
      </form>
    </DialogContent>
  );
}

function ReturnLineRow({
  line,
  unitOf,
  pick,
  onPick,
  tooLarge,
}: {
  line: PosReturnableLine;
  unitOf: UnitOf;
  pick: ReturnPick | null;
  onPick: (pick: ReturnPick | null) => void;
  tooLarge: boolean;
}) {
  const { t, format, errorText } = useLocale();
  const unit = unitOf(line.unitId);
  const decimals = unit?.decimals ?? 0;
  const code = unit?.code ?? '';
  const left = returnableQuantityOf(line);
  const id = `pos-return-${line.id}`;

  if (!hasLeft(line)) {
    return (
      <li className="flex items-start gap-2.5 bg-subtle px-3.5 py-3">
        <Checkbox
          id={id}
          label={t('pos.return.take', { name: line.description })}
          hideLabel
          disabled
        />
        <span className="grid">
          <span className="text-body-sm text-ink-2">{line.description}</span>
          <span className="text-caption text-ink-3">{t('pos.return.allBack')}</span>
        </span>
      </li>
    );
  }

  const amount = pick && returnLineOf(line, pick);
  const step = (by: number) => {
    if (!pick) return;
    const now = isQuantity(pick.quantity) ? pick.quantity : '0';
    const next = by > 0 ? addQuantity(now, '1') : subtractQuantity(now, '1');
    // Never below one, never above what is left: the arrows keep the box sensible
    if (compareQuantity(next, '1') < 0 || compareQuantity(next, left) > 0) return;
    onPick({ ...pick, quantity: plainQuantity(next) });
  };

  return (
    <li className="grid gap-2.5 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={id}
          label={t('pos.return.take', { name: line.description })}
          hideLabel
          checked={pick !== null}
          onCheckedChange={(checked) => {
            onPick(checked === true ? firstPick(line) : null);
          }}
        />
        <label htmlFor={id} className="grid min-w-0 flex-1">
          <span className="text-body-sm font-medium">{line.description}</span>
          <span className="text-caption text-ink-3 tabular-nums">
            {t('pos.return.left', {
              left: format.number(left, decimals),
              sold: `${format.number(line.quantity, decimals)} ${code}`,
            })}{' '}
            · × {screenMoney(format, line.unitPrice)}
          </span>
        </label>
        {amount && (
          <span className="text-body-sm font-medium whitespace-nowrap tabular-nums">
            {t('pos.return.lineBack', {
              amount: screenMoney(format, sumMoney([amount.net, amount.vat])),
            })}
          </span>
        )}
      </div>
      {pick && line.tracking !== 'serial' && (
        <div className="flex flex-wrap items-center gap-2.5 pl-[27px]">
          <label htmlFor={`${id}-quantity`} className="text-label font-medium text-ink-2">
            {t('pos.return.quantity')}
          </label>
          <span className="inline-flex items-center rounded-control border border-line-strong bg-surface">
            <button
              type="button"
              aria-label={`${t('pos.return.quantity')} −1`}
              onClick={() => {
                step(-1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.5} />
            </button>
            <input
              id={`${id}-quantity`}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={tooLarge}
              value={pick.quantity}
              onChange={(event) => {
                onPick({ ...pick, quantity: event.target.value });
              }}
              className="w-14 bg-transparent text-center text-body-sm font-medium tabular-nums outline-none"
            />
            <button
              type="button"
              aria-label={`${t('pos.return.quantity')} +1`}
              onClick={() => {
                step(1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.5} />
            </button>
          </span>
          <span className="text-label text-ink-3">{code}</span>
          {tooLarge && (
            <span className="w-full text-label text-crit">
              {errorText('pos_return_quantity_too_large')}
            </span>
          )}
        </div>
      )}
      {pick && line.tracking === 'serial' && (
        <div className="pl-[27px]">
          <CheckboxGroup
            legend={t('pos.return.serials')}
            options={serialsLeft(line).map((serial) => ({
              value: serial,
              label: <span className="font-mono">{serial}</span>,
            }))}
            value={pick.serials}
            onChange={(serials) => {
              onPick({ ...pick, serials });
            }}
            hint={t('pos.return.serialsHint')}
          />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. The money back

function RefundStep({
  copy,
  register,
  shift,
  today,
  cashier,
  sale,
  lines,
  note,
  unitOf,
  busy,
  onBusy,
  onBack,
  onDone,
  onExchange,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  shift: DeviceShift;
  today: string;
  cashier: string;
  sale: PosReturnableSale;
  lines: PosReturnLineInput[];
  note: string;
  unitOf: UnitOf;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onBack: () => void;
  onDone: (done: DoneReturn) => void;
  onExchange: (exchange: PosCartExchange) => void;
}) {
  const { t, format } = useLocale();
  const total = returnTotalOf(lines);
  const free = isZeroMoney(total);
  const methods = refundMethodsAt(register, sale);
  const [rows, setRows] = useState<PaymentRow[]>(() => (free ? [] : [refundRow('cash', total)]));
  const [error, setError] = useState<string | null>(null);
  const amountOf = (value: string) => (isMoneyAmount(value) ? value : '0');
  const given = sumMoney(rows.map((row) => amountOf(row.amount)));
  const due = dueOf(rows, total);

  const complete = async () => {
    setError(null);
    const returnedAt = new Date().toISOString();
    const parsed = posReturnInputSchema.safeParse({
      registerId: register.id,
      // Only for the check: the save gives the return its number (savePosReturn)
      sequence: 1,
      shiftId: shift.id,
      date: today,
      returnedAt,
      saleId: sale.id,
      lines,
      refunds: refundValues(rows),
      note,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'unknown_error');
      return;
    }
    // The sequence was only for the check: the save gives the return its number
    const input = parsed.data;
    onBusy(true);
    try {
      const result = await savePosReturn(copy, {
        returnId: newReturnId(),
        input,
        registerCode: register.code,
        savedAt: returnedAt,
      });
      if (result.kind === 'not-held') {
        setError('pos_register_not_held');
        return;
      }
      if (result.kind === 'no-shift') {
        setError('pos_shift_closed');
        return;
      }
      requestSync();
      onDone({
        number: result.number,
        slip: returnSlipOf({
          number: result.number,
          returnedAt,
          register,
          cashier,
          sale,
          lines: input.lines,
          refunds: input.refunds,
          usedOn: null,
          note: input.note,
          unitOf,
        }),
      });
    } catch {
      setError(t('sync.saveFailed'));
    } finally {
      onBusy(false);
    }
  };

  return (
    <DialogContent
      title={t('pos.return.refundTitle')}
      description={t('pos.return.refundDescription', { total: screenMoney(format, total) })}
      footer={
        <>
          <Button variant="secondary" className="mr-auto" disabled={busy} onClick={onBack}>
            {t('pos.return.back')}
          </Button>
          <Button type="submit" form="pos-return-refund" disabled={busy} className="gap-2">
            {busy ? t('pos.return.completing') : t('pos.return.complete')}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <form
        id="pos-return-refund"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void complete();
        }}
      >
        {error && <FormAlert message={error} />}
        {!free && <RefundRows rows={rows} onRows={setRows} methods={methods} total={total} />}
        <dl className="grid gap-1.5 rounded-control bg-subtle px-4 py-3 text-body-sm tabular-nums">
          <div className="flex justify-between gap-3 text-ink-2">
            <dt>{t('pos.return.due')}</dt>
            <dd>{screenMoney(format, due)}</dd>
          </div>
          <div className="flex justify-between gap-3 font-medium">
            <dt>{t('pos.return.given')}</dt>
            <dd>{screenMoney(format, given)}</dd>
          </div>
        </dl>
        {/* Decision 1: the other way out. Only at a register with an exchange account (decision 6),
            and only for money: a free sample has nothing to spend */}
        {register.exchangeAccountId === null ? (
          <p className="text-label text-ink-3">
            {t('pos.return.noExchange', { code: register.code })}
          </p>
        ) : (
          !free && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onExchange({
                  returnId: newReturnId(),
                  sale,
                  lines,
                  note: note.trim() === '' ? null : note.trim(),
                  total,
                });
              }}
              className="flex items-center gap-3 rounded-control border border-line-strong bg-surface px-3.5 py-3 text-left shadow-sm transition-colors duration-150 hover:bg-subtle"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={ArrowLeftRightIcon} size={17} strokeWidth={1.5} />
              </span>
              <span className="grid flex-1">
                <span className="text-body-sm font-medium">{t('pos.return.exchange')}</span>
                <span className="text-caption text-ink-3">{t('pos.return.exchangeHint')}</span>
              </span>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={16}
                strokeWidth={1.5}
                className="text-ink-3"
              />
            </button>
          )
        )}
      </form>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// After the return

// What the cashier hands over, big, like the sale's change: the cash, and a line for each other
// way the money goes back ("Send ৳500 back by bKash"). The slip has gone to the printer already.
export function ReturnDoneDialog({
  done,
  offline,
  onPrint,
  onNew,
}: {
  done: DoneReturn;
  offline: boolean;
  onPrint: () => void;
  onNew: () => void;
}) {
  const { t, format } = useLocale();
  const { refunds } = done.slip;
  const cash = sumMoney(
    refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
  );
  const others = refunds.filter((refund) => refund.method !== 'cash');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onNew();
      }}
    >
      <DialogContent
        title={t('pos.return.doneTitle', { number: done.number })}
        footer={
          <>
            <Button variant="secondary" className="mr-auto gap-1.5" onClick={onPrint}>
              <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
              {t('pos.printAgain')}
            </Button>
            <Button autoFocus onClick={onNew} className="gap-2">
              {t('pos.newSale')}
              <Kbd>Enter</Kbd>
            </Button>
          </>
        }
      >
        <div className="grid justify-items-center gap-3 py-2 text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-good-bg text-good">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={20} strokeWidth={1.5} />
          </span>
          <p
            role="status"
            className={
              isZeroMoney(cash) ? 'text-body text-ink-2' : 'text-kpi font-semibold tabular-nums'
            }
          >
            {isZeroMoney(cash)
              ? t('pos.return.noCash')
              : t('pos.return.giveCash', { amount: screenMoney(format, cash) })}
          </p>
          {others.map((refund, index) => (
            <p key={`${String(index)}-${refund.method}`} className="text-body-sm text-ink-2">
              {t('pos.return.giveOther', {
                amount: screenMoney(format, refund.amount),
                method: t(`pos.methods.${refund.method}`),
              })}
            </p>
          ))}
          {offline && <p className="text-label text-ink-3">{t('pos.savedOnDevice')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The cart's "Drop the exchange" asks first (the mockup's open point 3): the return goes back to
// paying the money back, and the new cart is cleared
export function DropExchangeDialog({
  onClose,
  onDrop,
}: {
  onClose: () => void;
  onDrop: () => void;
}) {
  const { t } = useLocale();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('pos.exchange.dropTitle')}
        description={t('pos.exchange.dropHint')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t('pos.exchange.keep')}</Button>
            </DialogClose>
            <Button autoFocus onClick={onDrop}>
              {t('pos.exchange.drop')}
            </Button>
          </>
        }
      >
        {null}
      </DialogContent>
    </Dialog>
  );
}
```

- **One dialog, three steps** (`Step`), as the mockup draws them: the receipt's number, what came back, the money back.
  Back on the third step keeps the ticks and the note. `busy` is the dialog's, so it cannot close while a return saves.
- **`findSale()` is decision 75.** A 404 (`pos_return_sale_not_found`) and a failed request both fall back to the
  device; any other refusal (a permission taken away) is said as it is.
- **The server is asked inside `withSyncLock()`** (decision 98, fixed in 20c.7), with `fromServer` set. `found` is an
  object, not a `let`: TypeScript does not follow an assignment made inside the function the lock runs, and would type
  a `let` as `null` after it. When the lock does not run (no device copy open), `found.sale` stays `null` and the
  device's own sales are read, as offline.
- **The number is trimmed and upper-cased** like the route's schema, so "pos1-000164" typed by hand is found offline
  too. The box has the barcode icon and the focus: a scanner reads the receipt's barcode into it.
- **The find step shows why it cannot start** in its place: no `pos.return.create` (`cantReturn`), or the screen's own
  stop (the 7-day limit offline, a shift left open on an earlier day). The Find button is off in both cases.
- **A line with nothing left is shown, not offered** (`allBack`, on `subtle`), so the cashier sees why the tea cannot be
  ticked.
- **The quantity box has −/+ and accepts typing.** The arrows never go below 1 or above what is left; typed, a too large
  number shows its message under the box, and Next stays off (`picksProblem()`).
- **A serial line ticks its numbers in a `CheckboxGroup`,** only the ones not back yet (`serialsLeft()`).
- **"Pay back ৳1,700" says the money on the button,** like the sale's "Pay ৳2,300". A return of ৳0 (a free sample)
  still needs a line, and its refund step has no rows (decision 15).
- **`complete()` checks the return with the server's schema** before saving it, like the pay dialog does a sale: what
  the device saves is what the server accepts. The sequence there is only for the check.
- **The exchange button is there only at a register with an exchange account** (decision 6); elsewhere the sentence
  says who can set one. It hands the screen a `PosCartExchange`; nothing is saved yet (decision 72).
- **`ReturnDoneDialog` says the cash at the KPI size and each other way on its own line** ("Send ৳500 back by bKash"),
  because a bKash refund is sent from the shop's phone, not handed over.
- **`DropExchangeDialog`** is decision 74's question.

#### `components/pos-receipt.tsx`: the slips

```diff
@@ -1,10 +1,18 @@
-import { isZeroMoney } from '@omnivo/contracts';
+import {
+  isZeroMoney,
+  type PosPaperWidth,
+  type PosShiftReport,
+  POS_TENDERS,
+  shiftNetOf,
+} from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { cn } from '@omnivo/ui';
+import { cn, parseIsoDate } from '@omnivo/ui';
 import { type ReactNode, useEffect, useRef } from 'react';
 import { createPortal } from 'react-dom';
 
 import type { ReceiptCompany, ReceiptData } from '../lib/pos';
+import type { ReturnSlipData } from '../lib/pos-returns';
+import { differenceKind } from '../lib/pos-shift';
 
 // Step 20a (decision 6): the thermal receipt. Printed by the browser (window.print()), like every
 // document since step 15c, so it works offline, in every browser and with any printer driver; no
@@ -19,44 +27,88 @@ import type { ReceiptCompany, ReceiptData } from '../lib/pos';
 // @page wins while the receipt is there, and goes with it.
 const PRINTABLE_WIDTH = { '58': 'w-[48mm]', '80': 'w-[72mm]' } as const;
 
+// Step 20c: the paper every slip shares (the receipt, the return slip, the X and Z reports), so
+// they print the same way. printKey: printOnMount prints once per key; the ref keeps the key it
+// printed, so React's second run of the effect in development does not print twice. Each slip is
+// lazy, so printing from the screen's own effect could run before the sheet exists and print the
+// screen. onPrinted: after the print dialog closed (window.print() waits for it), for a report that
+// leaves the page once printed.
+function ThermalSheet({
+  paperWidth,
+  printKey,
+  printOnMount,
+  onPrinted,
+  children,
+}: {
+  paperWidth: PosPaperWidth;
+  printKey: string;
+  printOnMount: boolean;
+  onPrinted?: (() => void) | undefined;
+  children: ReactNode;
+}) {
+  const printed = useRef<string | null>(null);
+  useEffect(() => {
+    if (!printOnMount || printed.current === printKey) return;
+    printed.current = printKey;
+    window.print();
+    onPrinted?.();
+  }, [printOnMount, printKey, onPrinted]);
+  return createPortal(
+    <article
+      data-print-sheet=""
+      className={cn(
+        'hidden bg-surface text-caption text-ink print:block',
+        PRINTABLE_WIDTH[paperWidth],
+      )}
+    >
+      <style>{'@page { size: auto; margin: 0; }'}</style>
+      {children}
+    </article>,
+    document.body,
+  );
+}
+
+function CompanyHeader({ company }: { company: ReceiptCompany }) {
+  return (
+    <header className="grid justify-items-center gap-0.5 border-b border-dashed border-ink pb-2 text-center">
+      <p className="text-body-sm font-semibold">{company.name}</p>
+      {company.lines.map((line, index) => (
+        <p key={`${String(index)}-${line}`}>{line}</p>
+      ))}
+    </header>
+  );
+}
+
 // printOnMount: the screen prints the receipt of the sale just paid as soon as it is drawn. The
-// sale's page draws it hidden and prints it from its button.
+// sale's page draws it hidden and prints it from its button. Step 20c: an exchange's sale prints
+// its return's slip first, on the same paper (returnSlip): one print, two slips.
 export function PosReceipt({
   receipt,
   company,
   printOnMount = false,
+  returnSlip,
 }: {
   receipt: ReceiptData;
   company: ReceiptCompany;
   printOnMount?: boolean;
+  returnSlip?: ReturnSlipData | undefined;
 }) {
   const { t, format } = useLocale();
   // Always to the paisa: a receipt is a document, and its lines must add up to its total
   const money = (value: string) => format.money(value, { decimals: 2 });
-  // Once it is drawn (decision 6), once per sale: the ref keeps the number it printed, so React's
-  // second run of the effect in development does not print twice. The receipt is lazy, so
-  // printing from the screen's own effect could run before the sheet exists and print the screen.
-  const printed = useRef<string | null>(null);
-  useEffect(() => {
-    if (!printOnMount || printed.current === receipt.number) return;
-    printed.current = receipt.number;
-    window.print();
-  }, [printOnMount, receipt.number]);
-  return createPortal(
-    <article
-      data-print-sheet=""
-      className={cn(
-        'hidden bg-surface text-caption text-ink print:block',
-        PRINTABLE_WIDTH[receipt.paperWidth],
-      )}
+  return (
+    <ThermalSheet
+      paperWidth={receipt.paperWidth}
+      printKey={receipt.number}
+      printOnMount={printOnMount}
     >
-      <style>{'@page { size: auto; margin: 0; }'}</style>
-      <header className="grid justify-items-center gap-0.5 border-b border-dashed border-ink pb-2 text-center">
-        <p className="text-body-sm font-semibold">{company.name}</p>
-        {company.lines.map((line, index) => (
-          <p key={`${String(index)}-${line}`}>{line}</p>
-        ))}
-      </header>
+      {returnSlip && (
+        // break-after-page: the driver cuts the paper between the two slips
+        <div className="break-after-page pb-4">
+          <ReturnSlipBody slip={returnSlip} company={company} />
+        </div>
+      )}
+      <CompanyHeader company={company} />
       <div className="grid gap-0.5 border-b border-dashed border-ink py-2">
         <p className="text-center text-body-sm font-semibold">{t('pos.receipt.title')}</p>
         <p className="font-mono">{t('pos.receipt.number', { number: receipt.number })}</p>
@@ -127,11 +179,239 @@ export function PosReceipt({
         {receipt.receiptFooter && <p className="whitespace-pre-line">{receipt.receiptFooter}</p>}
         <p>{t('pos.receipt.thanks')}</p>
       </footer>
-    </article>,
-    document.body,
+    </ThermalSheet>
+  );
+}
+
+// Step 20c: the return slip (decision 4's look, the receipt's paper). Printed by itself after the
+// return; an exchange's prints with its sale's receipt (above).
+export function PosReturnSlip({
+  slip,
+  company,
+  printOnMount = false,
+}: {
+  slip: ReturnSlipData;
+  company: ReceiptCompany;
+  printOnMount?: boolean;
+}) {
+  return (
+    <ThermalSheet paperWidth={slip.paperWidth} printKey={slip.number} printOnMount={printOnMount}>
+      <ReturnSlipBody slip={slip} company={company} />
+    </ThermalSheet>
+  );
+}
+
+function ReturnSlipBody({ slip, company }: { slip: ReturnSlipData; company: ReceiptCompany }) {
+  const { t, format } = useLocale();
+  const money = (value: string) => format.money(value, { decimals: 2 });
+  // The sale's day, read with local date parts (CLAUDE.md → Dates)
+  const soldOn = parseIsoDate(slip.sale.date);
+  return (
+    <>
+      <CompanyHeader company={company} />
+      <div className="grid gap-0.5 border-b border-dashed border-ink py-2">
+        <p className="text-center text-body-sm font-semibold">{t('pos.return.receipt.title')}</p>
+        <p className="font-mono">{t('pos.receipt.number', { number: slip.number })}</p>
+        <p className="font-mono">{t('pos.return.receipt.ofSale', { number: slip.sale.number })}</p>
+        {soldOn && <p>{t('pos.return.receipt.soldOn', { date: format.date(soldOn) })}</p>}
+        <p>{format.dateTime(new Date(slip.returnedAt), company.timeZone)}</p>
+        <p>
+          {t('pos.receipt.register', { code: slip.registerCode })} ·{' '}
+          {t('pos.receipt.cashier', { name: slip.cashier })}
+        </p>
+        {slip.customerName && <p>{t('pos.receipt.customer', { name: slip.customerName })}</p>}
+      </div>
+      <table className="w-full border-b border-dashed border-ink">
+        <thead>
+          <tr className="text-left">
+            <th className="py-1 font-medium">{t('pos.receipt.item')}</th>
+            <th className="py-1 text-right font-medium">{t('pos.receipt.amount')}</th>
+          </tr>
+        </thead>
+        <tbody>
+          {slip.lines.map((line) => (
+            <tr key={line.key} className="break-inside-avoid align-top">
+              <td className="py-0.5 pr-2">
+                <p>{line.name}</p>
+                <p className="text-ink-2 tabular-nums">
+                  {format.number(line.quantity, line.decimals)} {line.unitCode} ×{' '}
+                  {money(line.unitPrice)}
+                </p>
+                {line.serialNumbers.map((serial) => (
+                  <p key={serial} className="font-mono text-ink-2">
+                    {serial}
+                  </p>
+                ))}
+              </td>
+              {/* What the line pays back, with VAT: the lines add up to the total */}
+              <td className="py-0.5 text-right tabular-nums">{money(line.total)}</td>
+            </tr>
+          ))}
+        </tbody>
+      </table>
+      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
+        <Line label={t('pos.receipt.net')}>{money(slip.net)}</Line>
+        <Line label={t('pos.receipt.vat')}>{money(slip.vat)}</Line>
+        <Line label={t('pos.receipt.total')} strong>
+          {money(slip.total)}
+        </Line>
+      </dl>
+      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
+        <p className="font-medium">{t('pos.return.receipt.given')}</p>
+        {slip.refunds.map((refund, index) => (
+          <Line
+            key={`${String(index)}-${refund.method}`}
+            label={[t(`pos.methods.${refund.method}`), refund.reference]
+              .filter((part) => part !== null)
+              .join(' · ')}
+          >
+            {money(refund.amount)}
+          </Line>
+        ))}
+        {slip.usedOn && (
+          <p className="font-mono">{t('pos.return.receipt.usedOn', { number: slip.usedOn })}</p>
+        )}
+      </dl>
+      <footer className="grid justify-items-center gap-1 pt-2 text-center">
+        {slip.note && <p>{slip.note}</p>}
+        {slip.receiptFooter && <p className="whitespace-pre-line">{slip.receiptFooter}</p>}
+        <p>{t('pos.receipt.thanks')}</p>
+      </footer>
+    </>
   );
 }
 
+// Step 20c (decision 4): the shift's X report (the shift still open, blind: decision 9) or Z report
+// (closed, with the drawer). The same sums as the shift's page; every tender the shift used, in
+// the order the menus list them.
+export function PosShiftReportSheet({
+  report,
+  paperWidth,
+  company,
+  onPrinted,
+}: {
+  report: PosShiftReport;
+  paperWidth: PosPaperWidth;
+  company: ReceiptCompany;
+  onPrinted: () => void;
+}) {
+  const { t, format } = useLocale();
+  const money = (value: string) => format.money(value, { decimals: 2 });
+  const time = (value: string) => format.dateTime(new Date(value), company.timeZone);
+  const tenders = (amounts: PosShiftReport['taken']) =>
+    amounts.length === 0 ? (
+      <Line label={t('pos.report.nothing')}>{money('0')}</Line>
+    ) : (
+      POS_TENDERS.flatMap((method) => {
+        const found = amounts.find((amount) => amount.method === method);
+        return found
+          ? [
+              <Line key={method} label={t(`pos.methods.${method}`)}>
+                {money(found.amount)}
+              </Line>,
+            ]
+          : [];
+      })
+    );
+  const { drawer } = report;
+  return (
+    <ThermalSheet
+      paperWidth={paperWidth}
+      printKey={`${report.kind}-${report.printedAt}`}
+      printOnMount
+      onPrinted={onPrinted}
+    >
+      <CompanyHeader company={company} />
+      <div className="grid gap-0.5 border-b border-dashed border-ink py-2">
+        <p className="text-center text-body-sm font-semibold">
+          {t(`pos.report.titles.${report.kind}`)}
+        </p>
+        <p className="text-center">{t(`pos.report.states.${report.kind}`)}</p>
+        <p className="font-mono">{t('pos.report.shift', { number: report.shiftNumber })}</p>
+        <p>
+          {report.register.code} · {report.register.name}
+        </p>
+        <p>{t('pos.receipt.cashier', { name: report.cashierName })}</p>
+        <p>{t('pos.report.opened', { time: time(report.openedAt) })}</p>
+        {report.closedAt && <p>{t('pos.report.closed', { time: time(report.closedAt) })}</p>}
+        <p>{t('pos.report.printed', { time: time(report.printedAt) })}</p>
+      </div>
+      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
+        <Line
+          label={`${t('pos.report.sold')} · ${t('pos.report.sales', {
+            count: report.saleCount,
+            formatted: format.number(report.saleCount),
+          })}`}
+        >
+          {money(report.salesTotal)}
+        </Line>
+        <Line
+          label={`${t('pos.report.givenBack')} · ${t('pos.report.returns', {
+            count: report.returnCount,
+            formatted: format.number(report.returnCount),
+          })}`}
+        >
+          {money(report.returnsTotal)}
+        </Line>
+        <Line label={t('pos.report.net')} strong>
+          {money(shiftNetOf(report))}
+        </Line>
+        <Line label={t('pos.report.discount')}>{money(report.salesDiscount)}</Line>
+        <Line label={t('pos.report.salesVat')}>{money(report.salesVat)}</Line>
+        <Line label={t('pos.report.returnsVat')}>{money(report.returnsVat)}</Line>
+      </dl>
+      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
+        <p className="font-medium">{t('pos.report.taken')}</p>
+        {tenders(report.taken)}
+        <p className="pt-1 font-medium">{t('pos.report.refunded')}</p>
+        {tenders(report.refunded)}
+      </dl>
+      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
+        <Line label={t('pos.report.paidIn')}>{money(report.paidIn)}</Line>
+        <Line label={t('pos.report.paidOut')}>{money(report.paidOut)}</Line>
+      </dl>
+      {drawer ? (
+        <dl className="grid gap-0.5 py-2">
+          <p className="font-medium">{t('pos.report.drawer')}</p>
+          <Line label={t('posShifts.cash.opening')}>{money(drawer.opening)}</Line>
+          <Line label={t('posShifts.cash.cashTaken')}>{money(drawer.cashTaken)}</Line>
+          <Line label={t('posShifts.cash.changeGiven')}>−{money(drawer.changeGiven)}</Line>
+          <Line label={t('posShifts.cash.paidIn')}>{money(drawer.paidIn)}</Line>
+          <Line label={t('posShifts.cash.paidOut')}>−{money(drawer.paidOut)}</Line>
+          <Line label={t('posShifts.cash.cashRefunded')}>−{money(drawer.cashRefunded)}</Line>
+          <Line label={t('posShifts.cash.expected')} strong>
+            {money(drawer.expected)}
+          </Line>
+          <Line label={t('pos.report.counted')} strong>
+            {money(drawer.counted)}
+          </Line>
+          <Line label={t('pos.report.difference')} strong>
+            {differenceText(t, money, drawer.difference)}
+          </Line>
+        </dl>
+      ) : (
+        // An X report says why it has no drawer total (decision 63); a Z without a count, why
+        <p className="pt-2 text-center">
+          {report.kind === 'x' ? t('pos.report.blind') : t('pos.report.noCount')}
+        </p>
+      )}
+    </ThermalSheet>
+  );
+}
+
+// "৳50.00 short", "৳20.00 over", "No difference": the close's words (differenceWords in
+// pos-shift-parts.tsx), with paisa like every amount on the paper
+function differenceText(
+  t: ReturnType<typeof useLocale>['t'],
+  money: (value: string) => string,
+  difference: string,
+): string {
+  const kind = differenceKind(difference);
+  if (kind === 'even') return t('posShifts.even');
+  const amount = money(difference.replace(/^-/, ''));
+  return kind === 'over' ? t('posShifts.over', { amount }) : t('posShifts.short', { amount });
+}
+
 function Line({
   label,
   strong = false,
```

- **`ThermalSheet` is 20a's receipt paper, shared:** the `@page` rule, the printable width, the portal into `<body>`
  and the print once per key. The return slip and the reports print exactly like the receipt.
- **`onPrinted` lets a report leave the page once printed.** `window.print()` waits for the print dialog, so the next
  line runs after it closes. A report left in the page would print again with the next receipt (the print rule prints
  every sheet).
- **`PosReceipt` takes an exchange's `returnSlip`** and prints it first, with `break-after-page` for the cut (decision
  78).
- **The slip's sale date is read with `parseIsoDate()`,** never `new Date('2026-10-28')`, which is midnight UTC and the
  day before in some time zones (CLAUDE.md → Dates).
- **`PosShiftReportSheet` lists the tenders in `POS_TENDERS` order** and prints "Nothing" under a heading with none, so
  an empty list still prints. Its amounts always have 2 decimals, like every amount on paper.
- **The drawer's minus lines carry their sign,** in the order of `expectedCashOf()`, so the cashier can add the column
  up by hand. The difference is the close's words with paisa (`posShifts.over` / `short` / `even`).

#### `components/pos-pay.tsx`: the exchange in the pay dialog

```diff
@@ -5,11 +5,14 @@ import {
   PrinterIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
+import { ArrowLeftRightIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
 import {
   compareMoney,
   isMoneyAmount,
+  isZeroMoney,
   MAX_POS_PAYMENTS,
   posChangeOf,
+  posReturnInputSchema,
   posSaleInputSchema,
   registerMethods,
   subtractMoney,
@@ -17,7 +20,7 @@ import {
   type SyncPosRegister,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { type LocalCopy, savePosSale } from '@omnivo/sync';
+import { type LocalCopy, type PosReturnSave, savePosSale } from '@omnivo/sync';
 import {
   Button,
   Dialog,
@@ -42,7 +45,10 @@ import {
   receiptOfCart,
   saleValues,
 } from '../lib/pos';
+import { exchangeSplit, type ReturnSlipData, returnSlipOf, type UnitOf } from '../lib/pos-returns';
+import { DocumentNotice } from './document-notice';
 import { hasPaisa, Kbd } from './pos-parts';
+import { refundMethodsAt, RefundRows, refundRow, refundValues } from './pos-refund-rows';
 
 // Step 20a: taking the money (decision 5), the sale saved on the device, and what follows.
 
@@ -52,6 +58,9 @@ export interface DoneSale {
   // In cash, for the done dialog's "Give back ৳200"
   change: string;
   receipt: ReceiptData;
+  // Step 20c: an exchange's return, saved with the sale: its slip prints before the receipt, and
+  // the done dialog says what of its money goes back
+  returnSlip?: ReturnSlipData;
 }
 
 function money(format: ReturnType<typeof useLocale>['format'], value: string): string {
@@ -72,6 +81,8 @@ export function PayDialog({
   date,
   pricesIncludeVat,
   cashier,
+  returnNumber,
+  unitOf,
   onClose,
   onDone,
 }: {
@@ -84,21 +95,38 @@ export function PayDialog({
   date: string;
   pricesIncludeVat: boolean;
   cashier: string;
+  // Step 20c: the number an exchange's return will most likely get ("From return POS1-R000012");
+  // the save gives the real one
+  returnNumber: string;
+  unitOf: UnitOf;
   onClose: () => void;
   onDone: (sale: DoneSale) => void;
 }) {
   const { t, format } = useLocale();
   const methods = registerMethods(register.accounts);
-  const [rows, setRows] = useState<PaymentRow[]>(() => [firstRow()]);
+  // Step 20c: an exchange's money pays first, up to the total (decision 7). What is left of it goes
+  // back now ("Paid back by"); what it does not cover the other rows pay.
+  const exchange = cart.exchange ?? null;
+  const split = exchange && exchangeSplit(exchange.total, total);
+  const credit = split?.used ?? '0';
+  const owed = subtractMoney(total, credit);
+  const leftOver = split !== null && !isZeroMoney(split.rest);
+  const [rows, setRows] = useState<PaymentRow[]>(() =>
+    compareMoney(owed, '0') > 0 ? [firstRow()] : [],
+  );
+  const [restRows, setRestRows] = useState<PaymentRow[]>(() =>
+    split && leftOver ? [refundRow('cash', split.rest)] : [],
+  );
   // An error code (the schema's, the save's) or a sentence: FormAlert says either
   const [error, setError] = useState<string | null>(null);
   const [saving, setSaving] = useState(false);
 
   // A box still being typed counts as 0, like the cart's totals
   const amountOf = (value: string) => (isMoneyAmount(value) ? value : '0');
-  const paid = sumMoney(rows.map((row) => amountOf(row.amount)));
-  const due = dueOf(rows, total);
+  const paid = sumMoney([credit, ...rows.map((row) => amountOf(row.amount))]);
+  const due = dueOf(rows, owed);
   const change = compareMoney(paid, total) > 0 ? subtractMoney(paid, total) : '0';
+  const givenBack = sumMoney(restRows.map((row) => amountOf(row.amount)));
 
   const changeRow = (key: string, change: Partial<PaymentRow>) => {
     setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
@@ -113,29 +141,67 @@ export function PayDialog({
   const othersPaid = sumMoney(
     rows.filter((row) => row !== cashRow).map((row) => amountOf(row.amount)),
   );
-  const exact = compareMoney(total, othersPaid) > 0 ? subtractMoney(total, othersPaid) : '0';
+  const exact = compareMoney(owed, othersPaid) > 0 ? subtractMoney(owed, othersPaid) : '0';
+
+  // Step 20c: the exchange's return as posReturnInputSchema reads it, its money split between the
+  // sale and the rows that pay back what is left. null = no exchange; an error code = not right.
+  const returnOf = (soldAt: string): PosReturnSave | string | null => {
+    if (!exchange) return null;
+    const parsed = posReturnInputSchema.safeParse({
+      registerId: register.id,
+      sequence: 1,
+      shiftId,
+      date,
+      returnedAt: soldAt,
+      saleId: exchange.sale.id,
+      lines: exchange.lines,
+      refunds: [{ method: 'exchange', amount: credit, reference: '' }, ...refundValues(restRows)],
+      note: exchange.note ?? '',
+    });
+    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'unknown_error';
+    // The sequence was only for the check: the save gives the return its number
+    return {
+      returnId: exchange.returnId,
+      input: parsed.data,
+      registerCode: register.code,
+      savedAt: soldAt,
+    };
+  };
 
   const complete = async () => {
     setError(null);
     const soldAt = new Date().toISOString();
     // The same schema the server reads, so a sale the device saves is one the server accepts. The
     // sequence is only for the check: the save gives the sale its number (savePosSale).
+    const values = saleValues({
+      cart,
+      registerId: register.id,
+      shiftId,
+      date,
+      soldAt,
+      pricesIncludeVat,
+      payments: rows,
+    });
     const parsed = posSaleInputSchema.safeParse({
-      ...saleValues({
-        cart,
-        registerId: register.id,
-        shiftId,
-        date,
-        soldAt,
-        pricesIncludeVat,
-        payments: rows,
-      }),
+      ...values,
+      // Step 20c: the exchange's money first, naming its return
+      payments: [
+        ...(exchange
+          ? [{ method: 'exchange', amount: credit, reference: '', returnId: exchange.returnId }]
+          : []),
+        ...values.payments,
+      ],
       sequence: 1,
     });
     if (!parsed.success) {
       setError(parsed.error.issues[0]?.message ?? 'unknown_error');
       return;
     }
+    const given = returnOf(soldAt);
+    if (typeof given === 'string') {
+      setError(given);
+      return;
+    }
     setSaving(true);
     try {
       const result = await savePosSale(copy, {
@@ -143,6 +209,7 @@ export function PayDialog({
         registerCode: register.code,
         total,
         savedAt: soldAt,
+        ...(given && { exchange: given }),
       });
       if (result.kind === 'not-held') {
         setError('pos_register_not_held');
@@ -156,9 +223,25 @@ export function PayDialog({
       // Online it goes at once; offline it waits in the outbox (the done dialog says so)
       requestSync();
       const change = posChangeOf(parsed.data.payments, total);
+      const returnSlip =
+        exchange && given && result.returnNumber !== null
+          ? returnSlipOf({
+              number: result.returnNumber,
+              returnedAt: soldAt,
+              register,
+              cashier,
+              sale: exchange.sale,
+              lines: given.input.lines,
+              refunds: given.input.refunds,
+              usedOn: result.number,
+              note: given.input.note,
+              unitOf,
+            })
+          : null;
       onDone({
         number: result.number,
         change,
+        ...(returnSlip && { returnSlip }),
         receipt: receiptOfCart({
           number: result.number,
           soldAt,
@@ -212,6 +295,27 @@ export function PayDialog({
           }}
         >
           {error && <FormAlert message={error} />}
+          {/* Step 20c: the return's money, the first payment, fixed: an exchange is never a
+              choice in the select (decision 10) */}
+          {exchange && (
+            <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[8rem_9rem_minmax(0,1fr)_auto]">
+              <span className="flex h-[42px] items-center gap-2 rounded-control border border-line bg-subtle px-3 text-body-sm text-ink-2">
+                <HugeiconsIcon
+                  icon={ArrowLeftRightIcon}
+                  size={17}
+                  strokeWidth={1.5}
+                  className="text-ink-3"
+                />
+                {t('pos.methods.exchange')}
+              </span>
+              <span className="flex h-[42px] items-center justify-end rounded-control border border-line bg-subtle px-3 text-body-sm tabular-nums">
+                {money(format, credit)}
+              </span>
+              <span className="text-label text-ink-2 max-sm:col-span-2">
+                {t('pos.exchange.payment', { number: returnNumber })}
+              </span>
+            </div>
+          )}
           <ul className="grid gap-3">
             {rows.map((row, index) => {
               const id = `pos-pay-${row.key}`;
@@ -265,30 +369,33 @@ export function PayDialog({
               );
             })}
           </ul>
-          {/* The notes the customer handed over: one tap, and the change shows */}
-          <fieldset className="grid gap-2">
-            <legend className="mb-2 text-label font-medium">{t('pos.quickCash')}</legend>
-            <div className="flex flex-wrap gap-2">
-              <Chip
-                onClick={() => {
-                  setCash(exact);
-                }}
-              >
-                {t('pos.exact')}
-              </Chip>
-              {quickCash(total).map((amount) => (
+          {/* The notes the customer handed over: one tap, and the change shows. Not when an
+              exchange's money pays it all */}
+          {compareMoney(owed, '0') > 0 && (
+            <fieldset className="grid gap-2">
+              <legend className="mb-2 text-label font-medium">{t('pos.quickCash')}</legend>
+              <div className="flex flex-wrap gap-2">
                 <Chip
-                  key={amount}
                   onClick={() => {
-                    setCash(amount);
+                    setCash(exact);
                   }}
                 >
-                  {format.money(amount)}
+                  {t('pos.exact')}
                 </Chip>
-              ))}
-            </div>
-          </fieldset>
-          {rows.length < MAX_POS_PAYMENTS && methods.length > 1 && (
+                {quickCash(owed).map((amount) => (
+                  <Chip
+                    key={amount}
+                    onClick={() => {
+                      setCash(amount);
+                    }}
+                  >
+                    {format.money(amount)}
+                  </Chip>
+                ))}
+              </div>
+            </fieldset>
+          )}
+          {rows.length > 0 && rows.length < MAX_POS_PAYMENTS && methods.length > 1 && (
             <Button
               variant="secondary"
               size="sm"
@@ -308,11 +415,28 @@ export function PayDialog({
               {t('pos.addPayment')}
             </Button>
           )}
+          {/* Step 20c: a sale smaller than the return: what is left of its money goes back now,
+              in this dialog (decision 7) */}
+          {exchange && split && leftOver && (
+            <div className="grid gap-3">
+              <DocumentNotice tone="neutral" icon={InformationCircleIcon}>
+                {t('pos.exchange.rest', { amount: money(format, split.rest) })}
+              </DocumentNotice>
+              <RefundRows
+                rows={restRows}
+                onRows={setRestRows}
+                methods={refundMethodsAt(register, exchange.sale)}
+                total={split.rest}
+              />
+            </div>
+          )}
           <dl className="grid gap-1.5 rounded-control bg-subtle px-4 py-3 text-body-sm">
             <SummaryRow label={t('pos.receipt.total')} value={money(format, total)} />
             <SummaryRow label={t('pos.paid')} value={money(format, paid)} />
             {compareMoney(due, '0') > 0 ? (
               <SummaryRow label={t('pos.due')} value={money(format, due)} strong />
+            ) : leftOver ? (
+              <SummaryRow label={t('pos.return.given')} value={money(format, givenBack)} strong />
             ) : (
               <SummaryRow label={t('pos.change')} value={money(format, change)} strong />
             )}
@@ -369,6 +493,17 @@ export function DoneDialog({
 }) {
   const { t, format } = useLocale();
   const changeDue = compareMoney(sale.change, '0') > 0;
+  // Step 20c: an exchange's money left over goes back too: in cash with the change, or another way
+  const refunds = sale.returnSlip?.refunds ?? [];
+  const cashBack = sumMoney(
+    refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
+  );
+  const others = refunds.filter((refund) => refund.method !== 'cash');
+  const big = changeDue
+    ? t('pos.giveChange', { amount: money(format, sale.change) })
+    : !isZeroMoney(cashBack)
+      ? t('pos.return.giveCash', { amount: money(format, cashBack) })
+      : null;
   return (
     <Dialog
       open
@@ -397,12 +532,23 @@ export function DoneDialog({
           </span>
           <p
             role="status"
-            className={changeDue ? 'text-kpi font-semibold tabular-nums' : 'text-body text-ink-2'}
+            className={big ? 'text-kpi font-semibold tabular-nums' : 'text-body text-ink-2'}
           >
-            {changeDue
-              ? t('pos.giveChange', { amount: money(format, sale.change) })
-              : t('pos.noChange')}
+            {big ?? t('pos.noChange')}
           </p>
+          {changeDue && !isZeroMoney(cashBack) && (
+            <p className="text-body-sm text-ink-2">
+              {t('pos.return.giveCash', { amount: money(format, cashBack) })}
+            </p>
+          )}
+          {others.map((refund, index) => (
+            <p key={`${String(index)}-${refund.method}`} className="text-body-sm text-ink-2">
+              {t('pos.return.giveOther', {
+                amount: money(format, refund.amount),
+                method: t(`pos.methods.${refund.method}`),
+              })}
+            </p>
+          ))}
           {offline && <p className="text-label text-ink-3">{t('pos.savedOnDevice')}</p>}
         </div>
       </DialogContent>
@@ -416,6 +562,7 @@ export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
   const keys = [
     ['F2', t('pos.keys.search')],
     ['F4', t('pos.keys.customer')],
+    ['F6', t('pos.keys.return')],
     ['F7', t('pos.keys.billDiscount')],
     ['F8', t('pos.keys.hold')],
     ['F9', t('pos.keys.held')],
```

- **The exchange is a fixed first row,** on `subtle`, never a choice in the select (decision 10). Its amount is
  `exchangeSplit()`'s `used`; what the other rows must pay is the total less it (`owed`), and the notes' chips and
  "Exact amount" work on `owed`.
- **A sale that costs less than the return has no payment rows,** and the dialog shows the left-over sentence and the
  "Paid back by" rows in their place (the mockup's smaller case). The summary's last line is "Given back" then.
- **`returnOf()` checks the return with the server's schema too,** its refunds the exchange's part and the left-over
  rows. A return that does not add up is an error in the dialog before anything is saved.
- **The sale's payments put the exchange first, naming the return,** and the return is passed to `savePosSale()`: both
  are saved in one transaction (decision 72).
- **The done dialog adds what goes back of the return's money:** the cash at the KPI size when there is no change,
  else under it, and a line for each other way.
- **F6 is in the shortcuts.**

#### `components/pos-cart.tsx` and `components/pos-screen.tsx`

```diff
@@ -1,6 +1,7 @@
 import {
   Alert02Icon,
   ArrowLeft01Icon,
+  ArrowLeftRightIcon,
   Delete02Icon,
   MinusSignIcon,
   Note01Icon,
@@ -73,6 +74,9 @@ interface PosCartProps {
   onHold: () => void;
   held: number;
   onHeld: () => void;
+  // Step 20c: the number an exchange's return will most likely get, and "Drop the exchange"
+  returnNumber: string;
+  onDropExchange: () => void;
 }
 
 // Money on the screen: whole taka unless it has paisa (hasPaisa)
@@ -106,6 +110,8 @@ export function PosCart({
   onHold,
   held,
   onHeld,
+  returnNumber,
+  onDropExchange,
 }: PosCartProps) {
   const { t, format } = useLocale();
   const money = useScreenMoney();
@@ -115,6 +121,9 @@ export function PosCart({
     formatted: format.number(cart.lines.length),
   });
   const billOver = overrides.some((override) => override.kind === 'bill_discount');
+  // Step 20c: a cart with an exchange is not held or swapped for a held one: the goods came back
+  // already, and the close drops held carts. It is finished or dropped.
+  const exchange = cart.exchange ?? null;
 
   return (
     <>
@@ -144,14 +153,20 @@ export function PosCart({
             variant="secondary"
             size="sm"
             className="gap-1.5"
-            disabled={cart.lines.length === 0}
+            disabled={cart.lines.length === 0 || exchange !== null}
             onClick={onHold}
           >
             <HugeiconsIcon icon={PauseIcon} size={16} strokeWidth={1.5} />
             {t('pos.hold.hold')}
             <Kbd>F8</Kbd>
           </Button>
-          <Button variant="secondary" size="sm" className="gap-1.5" onClick={onHeld}>
+          <Button
+            variant="secondary"
+            size="sm"
+            className="gap-1.5"
+            disabled={exchange !== null}
+            onClick={onHeld}
+          >
             <HugeiconsIcon icon={Note01Icon} size={16} strokeWidth={1.5} />
             {t('pos.hold.list', { formatted: format.number(held) })}
           </Button>
@@ -160,11 +175,40 @@ export function PosCart({
             label={t('pos.clear')}
             disabled={cart.lines.length === 0}
             onClick={() => {
-              onCart(() => EMPTY_CART);
+              // The lines go; an exchange stays (it is dropped with its own link, which asks)
+              onCart((current) =>
+                current.exchange ? { ...EMPTY_CART, exchange: current.exchange } : EMPTY_CART,
+              );
               onSelect(null);
             }}
           />
         </div>
+        {/* Step 20c: an exchange cart starts with the return's money */}
+        {exchange && (
+          <div className="mx-4 mt-3 flex items-start gap-3 rounded-control border border-brand-line bg-brand-soft px-3.5 py-3">
+            <HugeiconsIcon
+              icon={ArrowLeftRightIcon}
+              size={17}
+              strokeWidth={1.5}
+              className="mt-0.5 shrink-0 text-brand"
+            />
+            <div className="grid min-w-0 flex-1 gap-0.5">
+              <span className="text-body-sm font-medium">
+                {t('pos.exchange.title', { number: returnNumber })}
+              </span>
+              <span className="text-label text-ink-2 tabular-nums">
+                {t('pos.exchange.credit', { amount: money(exchange.total) })}
+              </span>
+            </div>
+            <button
+              type="button"
+              onClick={onDropExchange}
+              className="text-label font-medium whitespace-nowrap text-brand underline-offset-[3px] hover:underline"
+            >
+              {t('pos.exchange.drop')}
+            </button>
+          </div>
+        )}
         <div className="border-b border-line px-4 py-3">
           <CustomerBox cart={cart} onCart={onCart} buttonRef={customerRef} />
         </div>
```

- **The banner is `brand-soft` with a `brand-line` border,** like a selected card: the cart has money in it already.
  It names the return's next number (decision 73) and has the Drop link.
- **Hold and the held list are off while an exchange is in the cart, and Clear leaves the exchange** (decision 72).

```diff
@@ -1,6 +1,7 @@
 import { Search01Icon } from '@hugeicons/core-free-icons';
 import {
   compareQuantity,
+  formatReturnNumber,
   MAX_HELD_CARTS,
   type Product,
   type ProductVariant,
@@ -20,8 +21,10 @@ import {
   holdCart,
   type LocalCopy,
   lookUpPrices,
+  type PosCartExchange,
   productByBarcode,
   productPage,
+  readClaim,
   saveScreenCart,
   screenCart,
   type ShiftCloseResult,
@@ -59,6 +62,7 @@ import {
   removeLine,
   shortLines,
 } from '../lib/pos';
+import type { UnitOf } from '../lib/pos-returns';
 import { leftOpen } from '../lib/pos-shift';
 import { useSession } from '../lib/session-store';
 import { useSyncAge } from '../lib/sync-summary';
@@ -67,6 +71,7 @@ import { DocumentNotice } from './document-notice';
 import { PosCart } from './pos-cart';
 import { hasPaisa, Kbd, useReceiptCompany } from './pos-parts';
 import type { DoneSale } from './pos-pay';
+import type { DoneReturn } from './pos-return';
 
 // The payment, the done dialog, the shortcuts and the receipt: a chunk of their own, loaded the
 // first time one opens (the screen's chunk stays in its budget). Offline too: the service worker
@@ -86,10 +91,23 @@ const CloseShiftDialog = lazy(async () => ({
 }));
 const HoldDialog = lazy(async () => ({ default: (await import('./pos-held')).HoldDialog }));
 const HeldDialog = lazy(async () => ({ default: (await import('./pos-held')).HeldDialog }));
+// Step 20c: taking goods back, and its slip; the X report's sheet
+const ReturnDialog = lazy(async () => ({ default: (await import('./pos-return')).ReturnDialog }));
+const ReturnDoneDialog = lazy(async () => ({
+  default: (await import('./pos-return')).ReturnDoneDialog,
+}));
+const DropExchangeDialog = lazy(async () => ({
+  default: (await import('./pos-return')).DropExchangeDialog,
+}));
+const PosReturnSlip = lazy(async () => ({
+  default: (await import('./pos-receipt')).PosReturnSlip,
+}));
 
 // Step 20b: what the top bar's shift menu asks the screen for. The screen opens the dialogs, because
-// they need its cart: Hold takes it, Resume replaces it, Close holds it first.
-export type ShiftRequest = 'pay-in' | 'pay-out' | 'held' | 'close';
+// they need its cart: Hold takes it, Resume replaces it, Close holds it first. Step 20c: Return
+// (the top bar's button, F6) puts an exchange into it. The X report needs no cart: the page prints
+// it (routes/pos.tsx), and it never comes here.
+export type ShiftRequest = 'pay-in' | 'pay-out' | 'held' | 'close' | 'return' | 'x-report';
 
 // Step 20a (decision 12): the products on the left, the cart on the right; on a phone the products
 // alone, with the cart as a bar at the bottom that opens over them. A whole sale works from the
@@ -175,6 +193,11 @@ export function PosScreen({
   // until then nothing is saved over it.
   const [holding, setHolding] = useState(false);
   const [restored, setRestored] = useState(false);
+  // Step 20c: the return just saved (its done dialog and slip); "Drop the exchange?" asking; the
+  // exchange dropped, whose return starts again at paying the money back
+  const [doneReturn, setDoneReturn] = useState<DoneReturn | null>(null);
+  const [dropping, setDropping] = useState(false);
+  const [dropped, setDropped] = useState<PosCartExchange | null>(null);
   const searchRef = useRef<HTMLInputElement>(null);
   const customerRef = useRef<HTMLButtonElement>(null);
   const billDiscountRef = useRef<HTMLInputElement>(null);
@@ -189,6 +212,15 @@ export function PosScreen({
   const blocked = !online && age?.age === 'blocked';
   // Decision 6: a shift left open on an earlier day sells nothing more; the menu's Close is the way
   const stale = leftOpen(shift.openingDate, today);
+  // Step 20c: and takes nothing back; the return dialog says why, like the screen does
+  const stopped = blocked
+    ? t('sync.blockedFormNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })
+    : stale
+      ? t('pos.shift.leftOpen', {
+          number: shift.number,
+          time: format.dateTime(new Date(shift.openedAt), settings.timezone),
+        })
+      : null;
 
   const findTiles = useCallback(
     async (open: LocalCopy) =>
@@ -207,6 +239,17 @@ export function PosScreen({
   const tiles = useLocalQuery(findTiles);
   const rates = useLocalQuery(readRates);
   const units = useLocalQuery(readUnits);
+  const claim = useLocalQuery(readClaim);
+  // Step 20c: the number the next return will most likely get, for the exchange's banner and pay
+  // row. The save gives the real one (another tab may take this one first).
+  const returnNumber = formatReturnNumber(register.code, (claim?.lastReturn ?? 0) + 1);
+  const unitOf = useCallback<UnitOf>(
+    (unitId) => {
+      const unit = units?.find((one) => one.id === unitId);
+      return unit && { code: unit.code, decimals: unit.decimals };
+    },
+    [units],
+  );
 
   // The stock of what is on the screen: the tiles and the cart. One read, again when either
   // changes or a pull writes stock. The ids as one sorted string, so the same set is the same read.
@@ -270,7 +313,8 @@ export function PosScreen({
   const total = amounts.totals.total;
   useEffect(() => {
     if (!restored) return;
-    const saved = cart.lines.length === 0 ? null : heldCartOf(cart, total, null);
+    // Step 20c: an exchange with no lines yet is kept too (the goods came back already)
+    const saved = cart.lines.length === 0 && !cart.exchange ? null : heldCartOf(cart, total, null);
     writes.current = writes.current
       .then(() => saveScreenCart(copy, shift.id, saved))
       .catch(() => undefined);
@@ -290,6 +334,13 @@ export function PosScreen({
   useEffect(() => {
     if (request !== 'close') return;
     const now = latest.current;
+    // Step 20c: an exchange is never held (the close drops held carts, and its goods came back):
+    // it is completed or dropped first
+    if (now.cart.exchange) {
+      toast(t('pos.exchange.closeFirst'));
+      onRequest(null);
+      return;
+    }
     if (now.cart.lines.length === 0) return;
     void holdCart(copy, shift.id, heldCartOf(now.cart, now.total, null)).then(
       (answer) => {
@@ -404,7 +455,14 @@ export function PosScreen({
   // the sale, or starts the next one). F12 opens the browser's tools in some browsers; the page
   // asks first, and Chrome lets it. Step 20b: F8 holds the cart, F9 lists the held bills
   // (decision 68).
-  const dialogOpen = paying || done !== null || shortcuts || holding || request !== null;
+  const dialogOpen =
+    paying ||
+    done !== null ||
+    shortcuts ||
+    holding ||
+    request !== null ||
+    doneReturn !== null ||
+    dropping;
   useEffect(() => {
     if (dialogOpen) return;
     const onKey = (event: KeyboardEvent) => {
@@ -417,6 +475,11 @@ export function PosScreen({
           event.preventDefault();
           customerRef.current?.click();
           break;
+        // Step 20c: take goods back (the top bar's Return)
+        case 'F6':
+          event.preventDefault();
+          onRequest('return');
+          break;
         case 'F7':
           event.preventDefault();
           billDiscountRef.current?.focus();
@@ -427,11 +490,11 @@ export function PosScreen({
           break;
         case 'F8':
           event.preventDefault();
-          if (cart.lines.length > 0) setHolding(true);
+          if (cart.lines.length > 0 && !cart.exchange) setHolding(true);
           break;
         case 'F9':
           event.preventDefault();
-          onRequest('held');
+          if (!cart.exchange) onRequest('held');
           break;
         case '?':
           if (isTyping(event.target)) return;
@@ -444,10 +507,11 @@ export function PosScreen({
     return () => {
       window.removeEventListener('keydown', onKey);
     };
-  }, [dialogOpen, payable, onShortcuts, cart.lines.length, onRequest]);
+  }, [dialogOpen, payable, onShortcuts, cart.lines.length, cart.exchange, onRequest]);
 
   const newSale = () => {
     setDone(null);
+    setDoneReturn(null);
     setCartOpen(false);
     searchRef.current?.focus();
   };
@@ -576,6 +640,10 @@ export function PosScreen({
         onHeld={() => {
           onRequest('held');
         }}
+        returnNumber={returnNumber}
+        onDropExchange={() => {
+          setDropping(true);
+        }}
       />
       <Suspense fallback={null}>
         {paying && (
@@ -588,6 +656,8 @@ export function PosScreen({
             date={today}
             pricesIncludeVat={pricesIncludeVat}
             cashier={cashier}
+            returnNumber={returnNumber}
+            unitOf={unitOf}
             onClose={() => {
               setPaying(false);
             }}
@@ -609,9 +679,74 @@ export function PosScreen({
               }}
               onNew={newSale}
             />
-            <PosReceipt receipt={done.receipt} company={company} printOnMount />
+            <PosReceipt
+              receipt={done.receipt}
+              company={company}
+              printOnMount
+              returnSlip={done.returnSlip}
+            />
+          </>
+        )}
+        {request === 'return' && (
+          <ReturnDialog
+            copy={copy}
+            register={register}
+            shift={shift}
+            today={today}
+            cashier={cashier}
+            timeZone={settings.timezone}
+            canReturn={can('pos.return.create')}
+            stopped={stopped}
+            unitOf={unitOf}
+            dropped={dropped}
+            onClose={() => {
+              setDropped(null);
+              onRequest(null);
+            }}
+            onDone={(saved) => {
+              setDropped(null);
+              onRequest(null);
+              setDoneReturn(saved);
+            }}
+            onExchange={(exchange) => {
+              // The cart is the new sale now: what is on it stays, and the return's money pays
+              // for it at "Complete sale"
+              setDropped(null);
+              onRequest(null);
+              setCart((current) => ({ ...current, exchange }));
+              searchRef.current?.focus();
+            }}
+          />
+        )}
+        {doneReturn && (
+          <>
+            <ReturnDoneDialog
+              done={doneReturn}
+              offline={!online}
+              onPrint={() => {
+                window.print();
+              }}
+              onNew={newSale}
+            />
+            <PosReturnSlip slip={doneReturn.slip} company={company} printOnMount />
           </>
         )}
+        {dropping && cart.exchange && (
+          <DropExchangeDialog
+            onClose={() => {
+              setDropping(false);
+            }}
+            onDrop={() => {
+              // The new cart goes, and the return goes back to paying the money back
+              setDropping(false);
+              setDropped(cart.exchange ?? null);
+              setCart(EMPTY_CART);
+              setSelected(null);
+              onRequest('return');
+            }}
+          />
+        )}
+
         {shortcuts && (
           <ShortcutsDialog
             onClose={() => {
```

- **`ShiftRequest` gets `return` and `x-report`.** The top bar's Return and F6 ask for the return, which needs the cart;
  the X report never reaches the screen (below).
- **`returnNumber` reads the claim live,** so the banner's number follows a return made meanwhile. `unitOf` reads the
  copy's units for the slips and the lines.
- **`stopped` is the screen's own notices,** passed to the return dialog: no new work offline after 7 days, and a shift
  left open on an earlier day takes nothing back either.
- **The cart is saved with an exchange and no lines,** and the close's hold refuses a cart with an exchange
  (`closeFirst`) instead of holding it.
- **F8 and F9 do nothing while an exchange is in the cart,** like their buttons.
- **The exchange keeps what is in the cart already:** the customer may have picked the new size before the cashier
  took the old one back.
- **Dropping the exchange clears the cart and opens the return at its refund step** with the same lines (`dropped`).

#### The shift's menu, the close's result, the Sync page

```diff
@@ -3,6 +3,7 @@ import {
   MoneyAdd01Icon,
   MoneyRemove01Icon,
   Note01Icon,
+  PrinterIcon,
 } from '@hugeicons/core-free-icons';
 import { useLocale } from '@omnivo/i18n';
 import type { DeviceShift } from '@omnivo/sync';
@@ -19,6 +20,7 @@ import type { ShiftRequest } from './pos-screen';
 
 // Step 20b: "Shift POS1-S0042 ▾": who opened it and when, pay in, pay out, the held bills and the
 // close. The screen opens the dialogs (they need its cart). A chunk of its own (routes/pos.tsx).
+// Step 20c: Print X report, before the close (the mockup's shift menu).
 export function ShiftMenu({
   shift,
   held,
@@ -70,6 +72,14 @@ export function ShiftMenu({
           <span className="flex-1">{t('pos.hold.listTitle')}</span>
           <span className="text-caption text-ink-3 tabular-nums">{format.number(held)}</span>
         </DropdownMenuItem>
+        <DropdownMenuItem
+          icon={PrinterIcon}
+          onSelect={() => {
+            onRequest('x-report');
+          }}
+        >
+          {t('pos.shift.xReport')}
+        </DropdownMenuItem>
         <DropdownMenuSeparator />
         <DropdownMenuItem
           icon={LockIcon}
```

- **Print X report sits before Close shift,** where the mockup has it.

```diff
@@ -1,4 +1,4 @@
-import { CheckmarkCircle02Icon, Coins01Icon } from '@hugeicons/core-free-icons';
+import { CheckmarkCircle02Icon, Coins01Icon, PrinterIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   CASH_DENOMINATIONS,
@@ -569,10 +569,13 @@ export function CloseShiftDialog({
 export function ShiftClosedDialog({
   result,
   onSignOut,
+  onPrintZ,
   onNext,
 }: {
   result: Extract<ShiftCloseResult, { kind: 'closed' }>;
   onSignOut: () => void;
+  // Step 20c: the Z report on the receipt printer (decision 4), from the device's own shift
+  onPrintZ: () => void;
   onNext: () => void;
 }) {
   const { t, format } = useLocale();
@@ -593,6 +596,10 @@ export function ShiftClosedDialog({
             <Button variant="secondary" className="mr-auto" onClick={onSignOut}>
               {t('common.signOut')}
             </Button>
+            <Button variant="secondary" className="gap-1.5" onClick={onPrintZ}>
+              <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
+              {t('pos.close.printZ')}
+            </Button>
             <Button autoFocus onClick={onNext}>
               {t('pos.close.next')}
             </Button>
```

- **Print Z report sits between Sign out and "Open the next shift",** a secondary button: the primary stays the next
  shift.

```diff
@@ -73,7 +73,7 @@ export function useFieldList(): (fields: readonly string[]) => string {
 
 // The two lines of an entry: what it is ("Changes to Rahman Traders") and how big ("Changed:
 // Phone and Credit limit", "3 lines · ৳4,140"). A POS sale's name is its number (pos.ts in sync),
-// a shift's too (shift.ts).
+// a shift's too (shift.ts), and a return's (returns.ts).
 export function useCommandText(): (entry: OutboxEntry) => { title: string; detail: string } {
   const { t, format } = useLocale();
   const fieldList = useFieldList();
@@ -111,6 +111,15 @@ export function useCommandText(): (entry: OutboxEntry) => { title: string; detai
         case 'pos_shift.close':
         case 'pos_cash_movement.create':
           return { title, detail: '' };
+        // Step 20c: "Return POS1-R000012", then its lines, with no money (decision 61)
+        case 'pos_return.create':
+          return {
+            title,
+            detail: t('sync.returnLines', {
+              count: entry.lines ?? 0,
+              formatted: format.number(entry.lines ?? 0),
+            }),
+          };
       }
     },
     [t, format, fieldList],
```

- **A return is "Return POS1-R000012" and its line count,** with no money (decision 61).

#### `routes/pos.tsx`: the register's sales, the reports, the Return button

#### `packages/ui`: the logo's mark alone on a phone

```diff
@@ -1,12 +1,14 @@
 // দুটো সরানো বর্গ — ভরাট আর ফাঁকা, খাতার ডেবিট/ক্রেডিট কলাম (CLAUDE.md → Logo)
-export function Logo() {
+// markOnPhone: the mark alone below sm (the word stays for screen readers), for a bar that has
+// no room for it on a 390px phone (the POS screen, step 20c.7)
+export function Logo({ markOnPhone = false }: { markOnPhone?: boolean }) {
   return (
     <span className="inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.02em] text-ink">
       <span aria-hidden="true" className="relative size-[26px] shrink-0">
         <span className="absolute top-0 left-0 size-4 rounded-[5px] bg-brand" />
         <span className="absolute right-0 bottom-0 size-4 rounded-[5px] border-2 border-brand bg-surface" />
       </span>
-      Omnivo
+      <span className={markOnPhone ? 'max-sm:sr-only' : undefined}>Omnivo</span>
     </span>
   );
 }
```

- **`markOnPhone`** hides the word "Omnivo" below `sm` with `sr-only`, not `hidden`: a screen reader still reads the
  logo's name. Off by default, so the sidebar, the sign-in page and the wizard keep the word. 20c.7 found that the POS
  bar did not fit a phone without it (decision 97). Build ui again before the app: the app reads it from `dist/`.

```diff
@@ -1,6 +1,7 @@
 import {
   ArrowLeft01Icon,
   ArrowLeftRightIcon,
+  ArrowTurnBackwardIcon,
   CashierIcon,
   KeyboardIcon,
   LockKeyIcon,
@@ -11,6 +12,7 @@ import { HugeiconsIcon } from '@hugeicons/react';
 import {
   formatPosNumber,
   lockAfterMs,
+  type PosShiftReport,
   routes,
   type SyncPosRegister,
   type SyncSettings,
@@ -22,6 +24,7 @@ import {
   type DeviceShift,
   dropClaim,
   heldCount,
+  loadRegisterSales,
   type LocalCopy,
   localCashReasons,
   localRegisters,
@@ -29,6 +32,7 @@ import {
   readShift,
   type RegisterClaim,
   type ShiftCloseResult,
+  shiftReportOf,
   shiftStart,
   waitingAtCounter,
 } from '@omnivo/sync';
@@ -37,7 +41,7 @@ import { Link, useNavigate, useSearch } from '@tanstack/react-router';
 import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
 
 import { LocalState, SyncNotice } from '../components/local-state';
-import { ShiftButton } from '../components/pos-parts';
+import { Kbd, ShiftButton, useReceiptCompany } from '../components/pos-parts';
 import { PosScreen, type ShiftRequest } from '../components/pos-screen';
 import { ApiRequestError, call } from '../lib/api';
 import {
@@ -47,6 +51,7 @@ import {
   useLocalData,
   useLocalQuery,
   useThisDeviceId,
+  withSyncLock,
 } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
 import { logout } from '../lib/session';
@@ -70,6 +75,9 @@ const RegisterChooser = lazy(async () => ({
 const OpenShiftCard = lazy(async () => ({
   default: (await import('../components/pos-shift')).OpenShiftCard,
 }));
+const PosShiftReportSheet = lazy(async () => ({
+  default: (await import('../components/pos-receipt')).PosShiftReportSheet,
+}));
 const ShiftClosedDialog = lazy(async () => ({
   default: (await import('../components/pos-shift')).ShiftClosedDialog,
 }));
@@ -133,6 +141,65 @@ function useIdleLock(lockAfter: SyncPosRegister['lockAfter'] | null) {
   }, [lockAfter]);
 }
 
+// Step 20c (decision 45): the register's recent sales, read once after the device took it, for
+// returns without a connection. Online only; a claim that has them already (salesLoaded) reads
+// nothing. Inside the sync lock: a pull writes the same rows (withSyncLock). A failure tries again
+// the next time the screen is drawn online: nothing else brings those sales.
+function useRegisterSales(
+  copy: LocalCopy | null,
+  registerId: string | null,
+  loaded: boolean,
+): void {
+  const online = useOnline();
+  useEffect(() => {
+    if (!copy || registerId === null || loaded || !online) return;
+    void withSyncLock(async () => {
+      await loadRegisterSales(copy, registerId, (cursor) =>
+        call(routes.posReturns.registerSales, {
+          params: { id: registerId },
+          query: cursor === null ? {} : { cursor },
+        }),
+      );
+    }).catch(() => undefined);
+  }, [copy, registerId, loaded, online]);
+}
+
+// Step 20c (decision 4): the X report of the open shift (the shift menu) or the Z report of the
+// one just closed (its result dialog), from the device's own shift, so it prints offline too. Made
+// once, when asked: the sheet prints itself and leaves (onPrinted).
+function ShiftReport({
+  kind,
+  shift,
+  register,
+  settings,
+  onPrinted,
+}: {
+  kind: PosShiftReport['kind'];
+  shift: DeviceShift;
+  register: SyncPosRegister;
+  settings: SyncSettings;
+  onPrinted: () => void;
+}) {
+  const company = useReceiptCompany(settings);
+  const cashier = useSession((state) => state.me?.user.fullName) ?? '';
+  const [report] = useState<PosShiftReport>(() =>
+    shiftReportOf(shift, {
+      kind,
+      register: { code: register.code, name: register.name },
+      cashierName: cashier,
+      printedAt: new Date().toISOString(),
+    }),
+  );
+  return (
+    <PosShiftReportSheet
+      report={report}
+      paperWidth={register.paperWidth}
+      company={company}
+      onPrinted={onPrinted}
+    />
+  );
+}
+
 export function PosPage() {
   const { t } = useLocale();
   const can = useCan();
@@ -150,6 +217,13 @@ export function PosPage() {
   const [shortcuts, setShortcuts] = useState(false);
   const [request, setRequest] = useState<ShiftRequest | null>(null);
   const [closed, setClosed] = useState<ClosedShift | null>(null);
+  // Step 20c: the shift report printing: X of the open shift, Z of the one just closed
+  const [printing, setPrinting] = useState<PosShiftReport['kind'] | null>(null);
+  // The X report needs no cart, so the shift menu's request stops here (pos-screen.tsx)
+  const onRequest = useCallback((next: ShiftRequest | null) => {
+    if (next === 'x-report') setPrinting('x');
+    else setRequest(next);
+  }, []);
   const [asking, setAsking] = useState(false);
   const { waiting: unsynced } = useSyncSummary();
 
@@ -157,6 +231,11 @@ export function PosPage() {
     registers && claim !== undefined ? heldRegister(registers, claim, deviceId) : undefined;
   // The shift this screen sells on: open, and of the register the device holds
   const openShift = shift?.status === 'open' && shift.registerId === register?.id ? shift : null;
+  useRegisterSales(
+    view.kind === 'ready' ? view.copy : null,
+    register?.id ?? null,
+    claim?.salesLoaded === true,
+  );
 
   // By the id: the shift's row is a new object after every write (each sale), the same read
   const openShiftId = openShift?.id ?? null;
@@ -183,6 +262,10 @@ export function PosPage() {
       : null,
   );
 
+  // The shift a report is printed of: the open one (X), the one just closed (Z)
+  const reportShift =
+    printing === 'x' ? openShift : printing === 'z' ? (closed?.shift ?? null) : null;
+
   const signOut = () => {
     setClosed(null);
     if (unsynced > 0) setAsking(true);
@@ -231,7 +314,7 @@ export function PosPage() {
           shift={openShift}
           reasons={reasons}
           request={request}
-          onRequest={setRequest}
+          onRequest={onRequest}
           onClosed={setClosed}
           shortcuts={shortcuts}
           onShortcuts={setShortcuts}
@@ -293,7 +376,7 @@ export function PosPage() {
         shift={openShift}
         held={held}
         timeZone={settings?.timezone ?? 'Asia/Dhaka'}
-        onRequest={setRequest}
+        onRequest={onRequest}
         onShortcuts={
           openShift
             ? () => {
@@ -314,11 +397,27 @@ export function PosPage() {
           <div className="grid flex-1 place-items-center overflow-y-auto p-4">{content()}</div>
         )}
       </main>
+      {printing && reportShift && register && settings && (
+        <Suspense fallback={null}>
+          <ShiftReport
+            kind={printing}
+            shift={reportShift}
+            register={register}
+            settings={settings}
+            onPrinted={() => {
+              setPrinting(null);
+            }}
+          />
+        </Suspense>
+      )}
       {closed && (
         <Suspense fallback={null}>
           <ShiftClosedDialog
             result={closed}
             onSignOut={signOut}
+            onPrintZ={() => {
+              setPrinting('z');
+            }}
             onNext={() => {
               setClosed(null);
             }}
@@ -365,7 +464,8 @@ function PosTopBar({
   const cashier = useSession((state) => state.me?.user.fullName) ?? '';
   return (
     <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 print:hidden">
-      <Logo />
+      {/* Step 20c.7: the mark alone on a phone, so the bar with the Return button still fits 390px */}
+      <Logo markOnPhone />
       {/* Step 20b: not on a phone, where the shift's button (POS1-S0042) says it is the POS */}
       <span className={cn('inline-flex', shift && 'max-sm:hidden')}>
         <Pill tone="brand" icon={CashierIcon}>
@@ -387,6 +487,28 @@ function PosTopBar({
               />
             </Suspense>
           )}
+          {/* Step 20c: take goods back (F6), after the shift's button: only in a shift (the money
+              leaves its drawer). On a phone the icon alone: the bar fits 390px. */}
+          {shift && (
+            <Button
+              variant="secondary"
+              size="sm"
+              className="shrink-0 gap-1.5 max-sm:px-2"
+              aria-label={t('pos.keys.return')}
+              onClick={() => {
+                onRequest('return');
+              }}
+            >
+              <HugeiconsIcon
+                icon={ArrowTurnBackwardIcon}
+                size={17}
+                strokeWidth={1.5}
+                className="text-ink-3"
+              />
+              <span className="max-sm:hidden">{t('pos.return.open')}</span>
+              <Kbd>F6</Kbd>
+            </Button>
+          )}
           <span className="text-body-sm text-ink-2 max-lg:hidden">
             {t('pos.cashier', { name: cashier })}
           </span>
```

- **`useRegisterSales()` is decision 68.** It runs while the claim says the sales are not on the device and the device
  is online, under the sync lock. A failure is caught and tried again the next time the screen is drawn online.
- **`ShiftReport` makes the report once, when asked** (`useState`'s first value), so a sale saved while the print dialog
  is open does not change the paper being printed.
- **`onRequest` stops the X report at the page** (decision 79). Setting state from an effect in the screen would draw
  the screen twice (React's `set-state-in-effect` rule).
- **The Return button is there only in a shift** (the money leaves its drawer). On a phone it is the icon alone, with
  its label for screen readers, and the logo is its mark alone (`<Logo markOnPhone />`, decision 97), so the bar still
  fits 390px. Without the second, the bar was 437px wide.

#### `scripts/check-bundle-size.ts`

```diff
@@ -23,8 +23,11 @@ const INITIAL_BUDGET = 225 * 1024;
 // script counts a lazy chunk together with the chunk it loads from, so the POS screen with its
 // payment dialog is one number: 112.3 KB. Step 20b: 125 KB (you chose this). The screen sells inside a
 // shift now (the shift's cash, the cart kept on the device), so /pos is 115.9 KB and its dialogs with
-// it 120–124 KB, after the shift menu moved to a chunk of its own.
-const CHUNK_BUDGET = 125 * 1024;
+// it 120–124 KB, after the shift menu moved to a chunk of its own. Step 20c: 135 KB (you chose
+// this). The screen takes goods back and pays with a return's money (/pos is 121 KB), so the return
+// dialog with it is 133 KB and the pay dialog 129.5 KB, after the refund rows moved to a file of
+// their own.
+const CHUNK_BUDGET = 135 * 1024;
 // Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
 // 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
 // changed.
```

- **135 KB** is decision 81, with the numbers in the comment like the earlier raises.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/sync typecheck
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/ui build
pnpm exec eslint packages/sync/src packages/ui/src/components/logo.tsx apps/app/src/components apps/app/src/lib apps/app/src/routes/pos.tsx
pnpm exec prettier --check packages/sync/src packages/ui/src apps/app/src
pnpm --filter @omnivo/app test
cd apps/app && npx vite build && node scripts/check-bundle-size.ts
cd apps/api && npx vitest run src/pos/pos-returns.int.spec.ts src/pos/pos.int.spec.ts src/pos/pos-shifts.int.spec.ts --maxWorkers=2
```

Build the sync and ui packages before the app: the app reads them from `dist/`. All pass: contracts 350 tests, sync 115
(12 new in `returns.spec.ts`, one of them added in 20c.7; one more check in `shift.spec.ts`), app 201 (6 new), the three
POS integration suites 79. The app's
`pnpm build` runs `tsc` first, which still fails in `routes/pos-registers.tsx` (20c.6b) and the three mocks (20c.7), so
the bundle is measured with `vite build` alone here; the whole build runs in 20c.8.

> **What was checked while building it.** The outbox's `after` rule was taken out on purpose: "goes to the server in its
> order" failed (the return went with its sale), and passed again with the file copied back. The screens were not
> opened in a browser in this part: mock mode has no return until 20c.7.

## 20c.6b — `apps/app`: the managers' pages

This part is the office's side of the step: the pages a manager reads after the counters have synced. A new list of
the POS returns and a return's page, the register's two new fields, what a sale's page and a shift's page now show,
and the Z report printed from a closed shift's page. The journal and the stock card link to the new page, and the
sidebar gets one item.

When this part starts, the app fails to type check in `routes/pos-registers.tsx` (the register's new fields) and in
the three mocks. When it ends, only the three mocks fail: their part is 20c.7.

### `lib/pos-queries.ts` and `lib/pos-shift.ts`

```diff
@@ -115,3 +115,30 @@ export function posShiftQuery(tenantId: string, shiftId: string) {
     queryFn: () => call(routes.posShifts.getShift, { params: { id: shiftId } }),
   });
 }
+
+// Step 20c: the returns, newest first. '' = every register; a shift's page links to its own
+// returns ('' = every shift).
+export function posReturnsQuery(tenantId: string, registerId: string, shiftId: string) {
+  return infiniteQueryOptions({
+    queryKey: ['pos', tenantId, 'returns', registerId, shiftId],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.posReturns.listReturns, {
+        query: {
+          limit: 50,
+          ...(registerId !== '' && { registerId }),
+          ...(shiftId !== '' && { shiftId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function posReturnQuery(tenantId: string, returnId: string) {
+  return queryOptions({
+    queryKey: ['pos', tenantId, 'return', returnId],
+    queryFn: () => call(routes.posReturns.getReturn, { params: { id: returnId } }),
+  });
+}
```

- **Both new queries start with `['pos', tenantId]`,** like every POS read, so one refresh after a sync or a register's
  save refreshes the returns too.
- **`shiftId` is part of the list's key** (decision 83): the shift's own list and the whole list are two caches, and
  "Show every return" does not flash the shift's rows.

```diff
@@ -6,6 +6,9 @@ import {
   compareMoney,
   MAX_NOTES,
   multiplyMoney,
+  type PosShift,
+  type PosShiftReport,
+  tenderAmountsOf,
 } from '@omnivo/contracts';
 
 // Step 20b: the count of the drawer and the shift's result, worked out without React, so the
@@ -99,3 +102,40 @@ export function differenceKind(difference: string): DifferenceKind {
 export function leftOpen(openingDate: string, today: string): boolean {
   return openingDate < today;
 }
+
+// Step 20c (decision 4): the Z report of a closed shift, from its page (the server's sums, so a
+// manager prints it again on any computer of the workspace). The drawer is there only when the
+// shift was counted; a shift closed without a count has nothing to set the expected cash against.
+export function zReportOf(shift: PosShift, printedAt: string): PosShiftReport {
+  const { cash } = shift;
+  return {
+    kind: 'z',
+    register: { code: shift.register.code, name: shift.register.name },
+    shiftNumber: shift.number,
+    cashierName: shift.cashier.fullName,
+    openedAt: shift.openedAt,
+    closedAt: shift.closedAt,
+    printedAt,
+    saleCount: shift.saleCount,
+    salesTotal: shift.salesTotal,
+    salesDiscount: shift.salesDiscount,
+    salesVat: shift.salesVat,
+    returnCount: shift.returnCount,
+    returnsTotal: shift.returnsTotal,
+    returnsVat: shift.returnsVat,
+    // The page lists every method of the register with its 0; the paper only the ones used
+    taken: tenderAmountsOf(shift.payments),
+    refunded: tenderAmountsOf(shift.refunds),
+    paidIn: cash.paidIn,
+    paidOut: cash.paidOut,
+    drawer:
+      shift.countedCash === null || shift.difference === null
+        ? null
+        : {
+            ...cash,
+            expected: shift.expectedCash,
+            counted: shift.countedCash,
+            difference: shift.difference,
+          },
+  };
+}
```

- **`zReportOf()` is decision 88:** the same `PosShiftReport` the counter makes (`shiftReportOf()` in
  `packages/sync`), from the server's shift instead of the device's. The page lists every method of the register
  with its 0; `tenderAmountsOf()` keeps the ones used, in the tenders' order, like the counter's paper.
- **The drawer needs both the count and the difference.** A shift closed without a count has neither, and a Z report
  with an expected cash but no count would look like a count of ৳0.
- **`printedAt` is a parameter,** not `new Date()` inside: the function stays pure, so the test can check it.

```diff
@@ -1,4 +1,4 @@
-import { cashCountSchema } from '@omnivo/contracts';
+import { cashCountSchema, type PosShift } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import {
@@ -9,6 +9,7 @@ import {
   leftOpen,
   noteAmount,
   noteDigits,
+  zReportOf,
 } from './pos-shift';
 
 describe('the count', () => {
@@ -54,3 +55,101 @@ describe('the result', () => {
     expect(leftOpen('2026-10-29', '2026-10-29')).toBe(false);
   });
 });
+
+// A closed shift as the shift's page has it: two sales by cash and bKash, one return paid back in
+// cash and one used on an exchange (step 20c)
+const closed: PosShift = {
+  id: '0195f0a0-0000-7000-8000-000000000001',
+  number: 'POS1-S0042',
+  register: { id: '0195f0a0-0000-7000-8000-000000000002', code: 'POS1', name: 'Front counter' },
+  branchId: '0195f0a0-0000-7000-8000-000000000003',
+  sequence: 42,
+  status: 'closed',
+  cashier: { id: '0195f0a0-0000-7000-8000-000000000004', fullName: 'Sumi Akter' },
+  device: { id: '0195f0a0-0000-7000-8000-000000000005', name: 'Front counter PC' },
+  openedAt: '2026-09-23T03:02:00.000Z',
+  closedAt: '2026-09-23T13:10:00.000Z',
+  openingCash: '2000.0000',
+  expectedCash: '3420.0000',
+  countedCash: '3400.0000',
+  difference: '-20.0000',
+  saleCount: 2,
+  salesTotal: '2300.0000',
+  returnCount: 2,
+  returnsTotal: '1260.0000',
+  opening: {
+    count: { notes: null, total: '2000.00' },
+    date: '2026-09-23',
+    comparedWith: '2000.0000',
+    difference: '0.0000',
+    floatReason: null,
+    entry: null,
+  },
+  closing: {
+    count: { notes: null, total: '3400.00' },
+    date: '2026-09-23',
+    deviceExpected: '3420.0000',
+    heldDropped: 0,
+    entry: null,
+  },
+  closedBy: null,
+  cash: {
+    opening: '2000.0000',
+    cashTaken: '2000.0000',
+    changeGiven: '160.0000',
+    paidIn: '0.0000',
+    paidOut: '0.0000',
+    cashRefunded: '420.0000',
+  },
+  payments: [
+    { method: 'cash', amount: '1840.0000' },
+    { method: 'card', amount: '0.0000' },
+    { method: 'bkash', amount: '460.0000' },
+  ],
+  refunds: [
+    { method: 'cash', amount: '420.0000' },
+    { method: 'card', amount: '0.0000' },
+    { method: 'exchange', amount: '840.0000' },
+  ],
+  salesDiscount: '115.0000',
+  salesVat: '300.0000',
+  returnsVat: '164.3500',
+  movements: [],
+};
+
+describe('the Z report of a shift page', () => {
+  it('has the server sums, only the tenders used, and the drawer of the count', () => {
+    const report = zReportOf(closed, '2026-09-24T04:00:00.000Z');
+    expect(report.kind).toBe('z');
+    expect(report.shiftNumber).toBe('POS1-S0042');
+    expect(report.closedAt).toBe(closed.closedAt);
+    expect(report.taken).toEqual([
+      { method: 'cash', amount: '1840.0000' },
+      { method: 'bkash', amount: '460.0000' },
+    ]);
+    expect(report.refunded).toEqual([
+      { method: 'cash', amount: '420.0000' },
+      { method: 'exchange', amount: '840.0000' },
+    ]);
+    expect(report.drawer).toEqual({
+      ...closed.cash,
+      expected: '3420.0000',
+      counted: '3400.0000',
+      difference: '-20.0000',
+    });
+  });
+
+  it('has no drawer for a shift closed without a count', () => {
+    const report = zReportOf(
+      {
+        ...closed,
+        status: 'closed_without_count',
+        countedCash: null,
+        difference: null,
+        closing: null,
+      },
+      '2026-09-24T04:00:00.000Z',
+    );
+    expect(report.drawer).toBeNull();
+  });
+});
```

- **The shift is a day at the front counter:** two sales by cash and bKash, one return paid back in cash and one used
  on an exchange. The test checks that a method at 0 (card) is not on the paper, that the exchange is among the refunds,
  and that the drawer is the shift's cash plus its three numbers; a shift closed without a count has no drawer.

### `components/pos-sale-parts.tsx`: the return's pills and the shift fact

```diff
@@ -1,6 +1,15 @@
-import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
+import {
+  Alert02Icon,
+  ArrowLeftRightIcon,
+  CheckmarkCircle02Icon,
+  HourglassIcon,
+} from '@hugeicons/core-free-icons';
+import type { PosReturnSummary, PosSale } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { Pill } from '@omnivo/ui';
+import { Link } from '@tanstack/react-router';
+
+import { useCan } from '../lib/permissions';
 
 // Step 20a: a POS sale's pills, for its list and its page. A sale reaches the server already paid
 // and is posted when it arrives, so it is always Posted (good). A second, warn pill when a line went
@@ -21,3 +30,57 @@ export function PosSalePills({ soldShort }: { soldShort: boolean }) {
     </span>
   );
 }
+
+// Step 20c: a POS return's pills (decision 32). Posted, like a sale: it is posted when it arrives.
+// After the window is warn with the Hourglass, like a credit note long after its invoice (15d): the
+// counter took back more than the register allows, and a manager may want to ask why. An exchange
+// is a fact, not a problem: neutral, with the exchange's icon from the counter.
+export function PosReturnPills({
+  item,
+}: {
+  item: Pick<PosReturnSummary, 'outsideWindow' | 'exchangeSale'>;
+}) {
+  const { t } = useLocale();
+  return (
+    <span className="flex flex-wrap gap-1.5">
+      <Pill tone="good" icon={CheckmarkCircle02Icon}>
+        {t('posReturns.posted')}
+      </Pill>
+      {item.outsideWindow && (
+        <Pill tone="warn" icon={HourglassIcon}>
+          {t('posReturns.outsideWindow')}
+        </Pill>
+      )}
+      {item.exchangeSale && (
+        <Pill tone="neutral" icon={ArrowLeftRightIcon}>
+          {t('posReturns.exchangeFor', { number: item.exchangeSale.number })}
+        </Pill>
+      )}
+    </span>
+  );
+}
+
+// Step 20b: the shift a sale was made in (step 20c: or a return), a link for the people who read
+// the shifts (pos.shift.manage, decision 26). A sale made before step 20b has none. Moved here from
+// the sale's page in 20c, for the return's page.
+export function ShiftFact({ label, shift }: { label: string; shift: PosSale['shift'] }) {
+  const canRead = useCan()('pos.shift.manage');
+  return (
+    <div className="grid min-w-0 gap-0.5">
+      <span className="text-caption font-medium text-ink-3">{label}</span>
+      {shift === null ? (
+        <span className="text-body-sm text-ink-3">—</span>
+      ) : canRead ? (
+        <Link
+          to="/pos/shifts/$shiftId"
+          params={{ shiftId: shift.id }}
+          className="w-fit font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
+        >
+          {shift.number}
+        </Link>
+      ) : (
+        <span className="font-mono text-body-sm tabular-nums">{shift.number}</span>
+      )}
+    </div>
+  );
+}
```

- **`PosReturnPills` is decision 84.** It takes only the two fields it reads (`Pick`), so the list's summary row and the
  page's full return both fit.
- **`ShiftFact` moved here from the sale's page** (decision 92) and takes its label: the sale's page says "Shift" from
  `posSales`, the return's page from `posReturns`, so each page keeps its own words.

### `routes/pos-registers.tsx`: the return days and the exchange account

```diff
@@ -10,6 +10,7 @@ import {
   contractErrorMap,
   formatPosNumber,
   moneyAccountIds,
+  POS_DEFAULT_RETURN_DAYS,
   POS_LOCK_AFTER,
   POS_PAPER_WIDTHS,
   POS_PAYMENT_METHODS,
@@ -83,6 +84,8 @@ const FIELD_NAMES = [
   'overShortAccountId',
   'varianceAlert',
   'lockAfter',
+  'returnDays',
+  'exchangeAccountId',
 ] as const satisfies readonly Path<FormValues>[];
 
 function RegisterForm({
@@ -121,6 +124,18 @@ function RegisterForm({
         .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
     [accounts],
   );
+  // Step 20c: where an exchange's money passes through. The API takes an active liability account
+  // that is not a group (pos_exchange_account_invalid), like the over/short select above.
+  const exchangeAccounts = useMemo(
+    () =>
+      (accounts ?? [])
+        .filter(
+          (account) =>
+            !account.isGroup && account.archivedAt === null && account.type === 'liability',
+        )
+        .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
+    [accounts],
+  );
   const {
     register,
     handleSubmit,
@@ -147,6 +162,10 @@ function RegisterForm({
       overShortAccountId: current?.overShortAccountId ?? '',
       varianceAlert: current?.varianceAlert ?? '500',
       lockAfter: current?.lockAfter ?? '5',
+      // Step 20c: every register has its days (7 on the old ones, 0056); an empty account means
+      // no exchanges at this counter, which is where every old register starts (decision 44)
+      returnDays: String(current?.returnDays ?? POS_DEFAULT_RETURN_DAYS),
+      exchangeAccountId: current?.exchangeAccountId ?? '',
       version: current?.version ?? 1,
     } satisfies FormValues,
   });
@@ -171,14 +190,16 @@ function RegisterForm({
     },
   });
 
-  const onSubmit = handleSubmit(async ({ code, version, ...fields }) => {
+  const onSubmit = handleSubmit(async ({ code, version, returnDays, ...fields }) => {
+    // The routes read the form's text, as the box has it; the schema made the days a number
+    const body = { ...fields, returnDays: String(returnDays) };
     try {
       const saved = current
         ? await call(routes.pos.updateRegister, {
             params: { id: current.id },
-            body: { ...fields, version },
+            body: { ...body, version },
           })
-        : await call(routes.pos.createRegister, { body: { ...fields, code } });
+        : await call(routes.pos.createRegister, { body: { ...body, code } });
       await refresh();
       toast(t(current ? 'registers.updated' : 'registers.created', { name: saved.name }));
       onDone();
@@ -359,6 +380,36 @@ function RegisterForm({
             />
           </div>
         </fieldset>
+        {/* Step 20c: what the counter takes back, and whether its money can pay for a new sale
+            (decisions 2 and 6) */}
+        <fieldset className="grid gap-4">
+          <legend className="text-label font-medium">{t('registers.returnsTitle')}</legend>
+          <p className="-mt-2 text-label text-ink-3">{t('registers.returnsHint')}</p>
+          <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
+            <TextField
+              label={t('registers.returnDays')}
+              hint={t('registers.returnDaysHint')}
+              inputMode="numeric"
+              align="end"
+              placeholder="7"
+              {...register('returnDays')}
+              error={errors.returnDays?.message}
+            />
+            <SelectField
+              label={t('registers.exchangeAccount')}
+              hint={t('registers.exchangeHint')}
+              options={[
+                { value: '', label: t('registers.noExchange') },
+                ...exchangeAccounts.map((account) => ({
+                  value: account.id,
+                  label: `${account.code} · ${account.name}`,
+                })),
+              ]}
+              {...register('exchangeAccountId')}
+              error={errors.exchangeAccountId?.message}
+            />
+          </div>
+        </fieldset>
         <TextAreaField
           label={t('registers.receiptFooter')}
           optional
@@ -386,6 +437,8 @@ export function PosRegistersPage() {
   });
   const warehouses = useQuery(warehousesQuery(tenantId, 'active')).data;
   const archivedWarehouses = useQuery(warehousesQuery(tenantId, 'archived')).data;
+  // Step 20c.7: the form's account selects read the same query (from the cache)
+  const accounts = useQuery(accountsQuery(tenantId)).data;
   const warehouseName = useMemo(
     () =>
       new Map(
@@ -524,8 +577,10 @@ export function PosRegistersPage() {
           if (!open) setEditing(null);
         }}
       >
-        {/* The form opens with the warehouses loaded: its select lists them */}
-        {editing !== null && warehouses && (
+        {/* The form opens with the warehouses and the accounts loaded: its selects list them.
+            A select that gets its value before its option is there shows the empty one, and a
+            save would then clear a saved account (step 20c.7 found it: the exchange account) */}
+        {editing !== null && warehouses && accounts && (
           <RegisterForm
             key={editing === 'new' ? 'new' : editing.id}
             register={editing === 'new' ? null : editing}
```

- **`exchangeAccounts` filters like the over/short select above it,** by the API's own rule (decision 90), so the
  person never picks an account the save refuses.
- **The days start as the register's own, as text** (`String(current?.returnDays …)`): the box is text, and every
  register has its days since 0056 (7 on the old ones). A new register starts at `POS_DEFAULT_RETURN_DAYS`.
- **An empty exchange account means no exchanges at this counter.** Every register made before 20c starts there
  (decision 44): someone picks the account on purpose before the counter can exchange.
- **`String(returnDays)` in `onSubmit`:** the routes are typed with the schema's input (text), and `handleSubmit` hands
  over its output (a number). Sending the number would not type check; the API parses the text again either way.
- **`returnDays` and `exchangeAccountId` join `FIELD_NAMES`,** so `pos_return_days_format` and
  `pos_exchange_account_invalid` from the server show under their boxes, not at the top of the form.
- **The page opens the form only once the accounts are loaded** (`&& accounts`), like the warehouses. A native select
  that gets its value before its option exists shows its first option, and a save then sends that. 20c.7's test found
  it (decision 96); the code above is the fixed one. The form still reads the accounts itself: the query is cached.

### `routes/pos-returns.tsx` (new): the list

```tsx
import { ReturnRequestIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import type { PosReturnSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { PosReturnPills } from '../components/pos-sale-parts';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { posRegistersQuery, posReturnsQuery } from '../lib/pos-queries';
import { useOnline } from '../lib/use-online';

// Step 20c: what the counters took back, as it reached the books, newest first. The POS sales
// list's twin (decision 30: everyone reads it, like the sales): the same register filter, the
// same "needs a connection" offline. A shift's page opens it with ?shiftId=, for that shift's
// returns only; the register filter makes no sense then, so a line names the shift instead.

const column = dataTableColumns<PosReturnSummary>();

export function PosReturnsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  const { shiftId = '' } = useSearch({ strict: false });
  // '' = every register
  const [registerId, setRegisterId] = useState('');
  const registers = useQuery(posRegistersQuery(tenantId, 'active')).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...posReturnsQuery(tenantId, shiftId === '' ? registerId : '', shiftId),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  // Every row of a shift's list has the shift's number; a shift with no returns has no link to
  // this list (its page shows none), so an empty list needs no number
  const shiftNumber = shiftId === '' ? null : (rows?.[0]?.shift.number ?? null);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('posReturns.columns.number'),
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
        // The receipt it came from. Plain text: the row opens the return, whose page links it.
        column.accessor((item) => item.sale.number, {
          id: 'sale',
          header: t('posReturns.columns.sale'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="font-mono tabular-nums">{getValue()}</span>,
        }),
        column.accessor((item) => item.register.code, {
          id: 'register',
          header: t('posReturns.columns.register'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="font-mono">{row.original.register.code}</span>
              <span className="truncate text-caption text-ink-3">{row.original.register.name}</span>
            </span>
          ),
        }),
        // The sale's customer; null = walk-in
        column.accessor((item) => item.customer?.name ?? '', {
          id: 'customer',
          header: t('posReturns.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            row.original.customer ? (
              <span className="block max-w-[16rem] truncate">{row.original.customer.name}</span>
            ) : (
              <span className="text-ink-3">{t('posReturns.walkIn')}</span>
            ),
        }),
        column.accessor((item) => item.cashier.fullName, {
          id: 'cashier',
          header: t('posReturns.columns.cashier'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        column.accessor('total', {
          header: t('posReturns.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.display({
          id: 'status',
          header: t('posReturns.columns.status'),
          meta: { card: 'trailing' },
          cell: ({ row }) => <PosReturnPills item={row.original} />,
        }),
      ]),
    [t, format, isoDate],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('posReturns.title')} description={t('posReturns.description')} />
      {shiftId === '' ? (
        <div className="max-w-72">
          <Select
            aria-label={t('posReturns.register')}
            value={registerId}
            onChange={(event) => {
              setRegisterId(event.target.value);
            }}
            options={[
              { value: '', label: t('posReturns.allRegisters') },
              ...(registers ?? []).map((register) => ({
                value: register.id,
                label: `${register.code} · ${register.name}`,
              })),
            ]}
          />
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-ink-2">
          {shiftNumber !== null && (
            <span className="tabular-nums">{t('posReturns.ofShift', { number: shiftNumber })}</span>
          )}
          <Link
            to="/pos/returns"
            className="font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('posReturns.showAll')}
          </Link>
        </p>
      )}
      {isError && <p className="text-body-sm text-crit">{t('posReturns.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('posReturns.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('posReturns.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/pos/returns/$returnId', params: { returnId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ReturnRequestIcon}
              title={t('posReturns.emptyTitle')}
              description={t('posReturns.emptyBody')}
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

- **Read from the server only, so offline it says it needs a connection** (decision 82). The returns are not on the
  devices (the device keeps only its register's sales).
- **With `shiftId`, the register filter is not sent** (`shiftId === '' ? registerId : ''`): a register picked before
  the shift's link was followed would filter the shift's returns to nothing.
- **The sale is plain text in the list:** the whole row opens the return, and a link inside a clickable row would do
  two things at once. The return's page links the sale.
- **The status column is a display column,** because it reads two fields (`outsideWindow` and `exchangeSale`).
- **The empty state names real returns** ("a shirt in the wrong size, a phone case that does not fit", 20c.5) and
  says when they show: once the device syncs.

### `routes/pos-return.tsx` (new): one return

```tsx
import { AlertCircleIcon, HourglassIcon, PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  defaultLineDescription,
  type PosRegister,
  type PosReturn,
  todayIn,
  type Unit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { Fact } from '../components/adjustment-view';
import { DocumentNotice } from '../components/document-notice';
import { EntryLinks } from '../components/entry-links';
import { useReceiptCompany } from '../components/pos-parts';
import { PosReturnPills, ShiftFact } from '../components/pos-sale-parts';
import { SalesBackLink, SalesTotals } from '../components/sales-parts';
import { useIsoDate, useQuantity, useTenantId, useTimeZone } from '../components/stock-parts';
import type { ReturnSlipData } from '../lib/pos-returns';
import { posRegisterQuery, posReturnQuery } from '../lib/pos-queries';
import { settingsQuery, unitsQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { useOnline } from '../lib/use-online';

// Step 20c: one POS return, as the server posted it: the sale it came from, what came back and
// into which batch, how the money went back (or which sale it paid for), and its journal entry.
// The POS sale's page's twin, key for key. "Print return slip" prints the slip the counter
// printed, for a customer who needs it again.

const PosReturnSlip = lazy(async () => ({
  default: (await import('../components/pos-receipt')).PosReturnSlip,
}));

// The slip from the server's return, as the counter made it (returnSlipOf in lib/pos-returns.ts):
// a line pays back its total with VAT, and an exchange's money is "Used on" its sale, not a refund
// row. The register's paper and footer are today's, like a sale's reprint.
function slipOfReturn(
  item: PosReturn,
  register: Pick<PosRegister, 'paperWidth' | 'receiptFooter'>,
  units: readonly Unit[],
): ReturnSlipData {
  return {
    number: item.number,
    returnedAt: item.returnedAt,
    registerCode: item.register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: item.cashier.fullName,
    sale: { number: item.sale.number, date: item.sale.date },
    customerName: item.customer?.name ?? null,
    lines: item.lines.map((line) => {
      const unit = units.find((one) => one.id === line.unitId);
      return {
        key: line.id,
        name: line.description,
        quantity: line.quantity,
        decimals: unit?.decimals ?? 0,
        unitCode: unit?.code ?? '',
        unitPrice: line.unitPrice,
        total: line.total,
        serialNumbers: line.serialNumbers,
      };
    }),
    net: item.net,
    vat: item.vat,
    total: item.total,
    refunds: item.refunds
      .filter((refund) => refund.method !== 'exchange')
      .map(({ method, amount, reference }) => ({ method, amount, reference })),
    usedOn: item.exchangeSale?.number ?? null,
    note: item.note,
  };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/returns" label={t('posReturns.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('posReturns.title')} description={message} />
    </div>
  );
}

export function PosReturnPage() {
  const { t } = useLocale();
  const online = useOnline();
  const { returnId = '' } = useParams({ strict: false });
  const { data: item, isError } = useQuery({
    ...posReturnQuery(useTenantId(), returnId),
    enabled: returnId !== '',
  });
  if (isError) return <CantFind message={t('posReturns.notFound')} />;
  // Offline before it ever loaded: the returns are read from the server only
  if (!item) return online ? null : <CantFind message={t('posReturns.needsConnection')} />;
  return <PosReturnView item={item} />;
}

function PosReturnView({ item }: { item: PosReturn }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const register = useQuery(posRegisterQuery(tenantId, item.register.id)).data;
  const units = useQuery(unitsQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const money = (value: string) => format.money(value, { decimals: 2 });
  // Like a sale (20a decision 26): the day it came back by the device, against its day in the books
  const returnedOn = todayIn(timeZone, new Date(item.returnedAt));
  const registerName = `${item.register.code} · ${item.register.name}`;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/returns" label={t('posReturns.back')} />
      <PageHeader
        title={item.number}
        description={item.customer?.name ?? t('posReturns.walkIn')}
        actions={
          <>
            <PosReturnPills item={item} />
            {/* Ready once the register (its paper) and the company are loaded */}
            {register && units && settings && (
              <Button
                variant="secondary"
                className="gap-1.5"
                onClick={() => {
                  window.print();
                }}
              >
                <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
                {t('posReturns.print')}
              </Button>
            )}
          </>
        }
      />
      {returnedOn !== item.date && (
        <DocumentNotice tone="neutral">
          {t('posReturns.bookedLater', { returned: isoDate(returnedOn), date: isoDate(item.date) })}
        </DocumentNotice>
      )}
      {/* Decision 20: the server took it anyway; the warn tone, like a credit note long after
          its invoice, because a manager may want to ask the counter why */}
      {item.outsideWindow && (
        <DocumentNotice tone="warn" icon={HourglassIcon}>
          {t('posReturns.outsideWindowNotice', {
            number: item.sale.number,
            register: registerName,
          })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('posReturns.sale')}</span>
          <Link
            to="/pos/sales/$saleId"
            params={{ saleId: item.sale.id }}
            className="w-fit font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
          >
            {item.sale.number}
          </Link>
        </div>
        <Fact label={t('posReturns.soldOn')} value={isoDate(item.sale.date)} />
        <Fact
          label={t('posReturns.customer')}
          value={item.customer?.name ?? t('posReturns.walkIn')}
        />
        <Fact label={t('posReturns.columns.date')} value={isoDate(item.date)} />
        <Fact
          label={t('posReturns.returnedAt')}
          value={format.dateTime(new Date(item.returnedAt), timeZone)}
        />
        <Fact label={t('posReturns.register')} value={registerName} />
        <Fact label={t('posReturns.cashier')} value={item.cashier.fullName} />
        <Fact label={t('posReturns.device')} value={item.device.name} />
        <ShiftFact label={t('posReturns.shift')} shift={item.shift} />
        <EntryLinks
          label={t('posReturns.entry')}
          entries={item.entry ? [item.entry] : []}
          none="—"
        />
        {item.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('posReturns.note')} value={item.note} />
          </div>
        )}
      </Card>
      <LinesCard item={item} money={money} quantity={quantity} />
      <RefundsCard item={item} money={money} />
      {register && units && settings && (
        <Suspense fallback={null}>
          <ReprintSheet item={item} register={register} units={units} settings={settings} />
        </Suspense>
      )}
    </div>
  );
}

// What came back, in the sale line's unit and at its price (decision 17). Not SalesLinesTable: a
// return line has no discount and no VAT rate of its own (they are the sale line's, decision 35),
// so its columns would be empty. Its own small table with the same look, and the same totals.
function LinesCard({
  item,
  money,
  quantity,
}: {
  item: PosReturn;
  money: (value: string) => string;
  quantity: ReturnType<typeof useQuantity>;
}) {
  const { t } = useLocale();
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-body-sm">
          <caption className="sr-only">{t('posReturns.lines')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('salesLines.item')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {item.pricesIncludeVat
                  ? t('salesLines.priceWithVat')
                  : t('salesLines.priceWithoutVat')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {item.lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <span className="grid max-w-[24rem] min-w-0">
                    <span className="font-medium text-ink">{line.description}</span>
                    <span className="truncate text-caption text-ink-3">
                      {line.description !== defaultLineDescription(line) &&
                        `${variantName(line)} · `}
                      <span className="font-mono">{line.sku}</span>
                    </span>
                    {/* Decision 52: where the goods went, in the base unit like the batch */}
                    {line.batches.map((batch) => (
                      <span key={batch.batchId} className="text-caption text-ink-3 tabular-nums">
                        {t('posReturns.batches', {
                          lot: batch.lotNumber,
                          quantity: quantity(batch.quantity, line.baseUnitId),
                        })}
                      </span>
                    ))}
                    {line.serialNumbers.length > 0 && (
                      <span className="font-mono text-caption text-ink-3">
                        {t('posReturns.serials', { serials: line.serialNumbers.join(', ') })}
                      </span>
                    )}
                  </span>
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
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {money(line.unitPrice)}
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {money(item.pricesIncludeVat ? line.total : line.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* No discount row: what came back was already after its discounts */}
      <SalesTotals
        totals={{ discount: '0', net: item.net, vat: item.vat, total: item.total }}
        pricesIncludeVat={item.pricesIncludeVat}
      />
    </Card>
  );
}

// How the money went back, in the order the cashier typed it. An exchange is a row too, with the
// sale its money paid for (decision 1): the money did not leave the shop, it bought something else.
function RefundsCard({ item, money }: { item: PosReturn; money: (value: string) => string }) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader title={t('posReturns.refunds')} />
      <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
        {item.refunds.map((refund, index) => (
          <div key={`${String(index)}-${refund.method}`} className="flex justify-between gap-3">
            <dt className="text-ink-2">
              {t(`pos.methods.${refund.method}`)}
              {refund.reference !== null && (
                <span className="text-ink-3"> · {refund.reference}</span>
              )}
              {refund.method === 'exchange' && item.exchangeSale && (
                <span className="block text-caption">
                  <Link
                    to="/pos/sales/$saleId"
                    params={{ saleId: item.exchangeSale.id }}
                    className="font-medium text-brand underline-offset-3 hover:underline"
                  >
                    {t('posReturns.usedOn', { number: item.exchangeSale.number })}
                  </Link>
                </span>
              )}
            </dt>
            <dd className="tabular-nums">{money(refund.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-line pt-2 font-medium">
          <dt>{t('posReturns.columns.total')}</dt>
          <dd className="tabular-nums">{money(item.total)}</dd>
        </div>
      </dl>
    </Card>
  );
}

// The slip, hidden on the screen, for Print. Its own component: useReceiptCompany is a hook, and
// the settings are only known to be there inside this branch (like the sale's page).
function ReprintSheet({
  item,
  register,
  units,
  settings,
}: {
  item: PosReturn;
  register: PosRegister;
  units: readonly Unit[];
  settings: Parameters<typeof useReceiptCompany>[0];
}) {
  const company = useReceiptCompany(settings);
  return <PosReturnSlip slip={slipOfReturn(item, register, units)} company={company} />;
}
```

- **`slipOfReturn()` is decision 87.** It builds the counter's `ReturnSlipData` from the server's return: a line pays
  back its total with VAT, and the exchange is not a refund row on the paper but "Used on" its sale, exactly as
  `returnSlipOf()` does at the counter, so the reprint matches the slip the customer had.
- **`bookedLater` compares the day the goods came back (by the device's clock, in the workspace's time zone) with the
  return's day in the books,** like a sale (20a decision 26): they differ when that day was closed.
- **The window's notice is `warn`** (decision 84) and names the sale and the register: "POS1-000123 was older than POS1
  · Front counter takes goods back for". The audit log has who did it.
- **The facts are the sale page's, in the same order,** plus the sale it came from (a link) and the day it was sold.
  The note ("Why it came back") takes the whole width: it is a sentence, not a value.
- **`LinesCard` is decision 85.** The batches say where the goods went ("Back into batch L-0425 · 12 pcs", decision
  52), in the base unit like the batch rows; the quantity is the sale line's unit, with "= 24 pcs" under it when the
  unit is a pack.
- **`RefundsCard` is decision 86.** The exchange's link is on its own line under the method, so the amount column stays
  a column. The last row is the return's total, "Given back", so the rows can be checked against it.
- **The slip is drawn only when the register, the units and the settings are loaded,** and so is the Print button: a
  click before that would print the page itself.

### `routes/pos-sale.tsx` and `components/sales-parts.tsx`: what came back of a sale

```diff
@@ -21,7 +21,7 @@ import { Fact } from '../components/adjustment-view';
 import { DocumentNotice } from '../components/document-notice';
 import { EntryLinks } from '../components/entry-links';
 import { useReceiptCompany } from '../components/pos-parts';
-import { PosSalePills } from '../components/pos-sale-parts';
+import { PosSalePills, ShiftFact } from '../components/pos-sale-parts';
 import { SalesBackLink } from '../components/sales-parts';
 import { SalesLinesTable } from '../components/sales-lines-table';
 import {
@@ -33,14 +33,14 @@ import {
   warehouseLabel,
 } from '../components/stock-parts';
 import type { ReceiptData } from '../lib/pos';
-import { useCan } from '../lib/permissions';
 import { posRegisterQuery, posSaleQuery } from '../lib/pos-queries';
 import { settingsQuery, unitsQuery } from '../lib/queries';
 import { useOnline } from '../lib/use-online';
 
 // Step 20a: one POS sale, as the server posted it: its lines with the batches and serial numbers
 // they left with, what went below zero, the payments, and its journal entry. "Print receipt" prints
-// the same thermal receipt the counter printed (a customer who lost it).
+// the same thermal receipt the counter printed (a customer who lost it). Step 20c (decision 31):
+// what came back of each line, the return an exchange payment came from, and the sale's returns.
 
 const PosReceipt = lazy(async () => ({
   default: (await import('../components/pos-receipt')).PosReceipt,
@@ -175,7 +175,7 @@ function PosSaleView({ sale }: { sale: PosSale }) {
         />
         <Fact label={t('posSales.cashier')} value={sale.cashier.fullName} />
         <Fact label={t('posSales.device')} value={sale.device.name} />
-        <ShiftFact shift={sale.shift} />
+        <ShiftFact label={t('posSales.shift')} shift={sale.shift} />
         <EntryLinks label={t('posSales.entry')} entries={sale.entry ? [sale.entry] : []} none="—" />
       </Card>
       <SalesLinesTable
@@ -205,6 +205,14 @@ function PosSaleView({ sale }: { sale: PosSale }) {
                 })}
               </span>
             )}
+            {/* Step 20c: in the line's own unit, like the quantity it was sold in */}
+            {compareQuantity(line.returnedQuantity, '0') > 0 && (
+              <span className="text-caption text-ink-2 tabular-nums">
+                {t('posSales.lineReturned', {
+                  quantity: quantity(line.returnedQuantity, line.unitId),
+                })}
+              </span>
+            )}
           </>
         )}
       />
@@ -218,6 +226,18 @@ function PosSaleView({ sale }: { sale: PosSale }) {
                 {payment.reference !== null && (
                   <span className="text-ink-3"> · {payment.reference}</span>
                 )}
+                {/* Step 20c: an exchange names the return its money came from */}
+                {payment.return && (
+                  <span className="block text-caption">
+                    <Link
+                      to="/pos/returns/$returnId"
+                      params={{ returnId: payment.return.id }}
+                      className="font-medium text-brand underline-offset-3 hover:underline"
+                    >
+                      {t('posSales.fromReturn', { number: payment.return.number })}
+                    </Link>
+                  </span>
+                )}
               </dt>
               <dd className="tabular-nums">{money(payment.amount)}</dd>
             </div>
@@ -238,6 +258,7 @@ function PosSaleView({ sale }: { sale: PosSale }) {
           </div>
         </dl>
       </Card>
+      <ReturnsCard returns={sale.returns} money={money} isoDate={isoDate} />
       {register && units && settings && (
         <Suspense fallback={null}>
           <ReprintSheet sale={sale} register={register} units={units} settings={settings} />
@@ -247,28 +268,46 @@ function PosSaleView({ sale }: { sale: PosSale }) {
   );
 }
 
-// Step 20b: the shift the sale was made in, a link for the people who read the shifts
-// (pos.shift.manage, decision 26). A sale made before step 20b has none.
-function ShiftFact({ shift }: { shift: PosSale['shift'] }) {
+// Step 20c: the sale's returns, oldest first, each a link to its page. Nothing came back is a
+// line of its own, so a manager who looks for a return sees there is none.
+function ReturnsCard({
+  returns,
+  money,
+  isoDate,
+}: {
+  returns: PosSale['returns'];
+  money: (value: string) => string;
+  isoDate: (iso: string) => string;
+}) {
   const { t } = useLocale();
-  const canRead = useCan()('pos.shift.manage');
   return (
-    <div className="grid min-w-0 gap-0.5">
-      <span className="text-caption font-medium text-ink-3">{t('posSales.shift')}</span>
-      {shift === null ? (
-        <span className="text-body-sm text-ink-3">—</span>
-      ) : canRead ? (
-        <Link
-          to="/pos/shifts/$shiftId"
-          params={{ shiftId: shift.id }}
-          className="w-fit font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
-        >
-          {shift.number}
-        </Link>
+    <Card>
+      <CardHeader title={t('posSales.returnsTitle')} subtitle={t('posSales.returnsSubtitle')} />
+      {returns.length === 0 ? (
+        <p className="px-5 pt-3 pb-5 text-body-sm text-ink-3">{t('posSales.noReturns')}</p>
       ) : (
-        <span className="font-mono text-body-sm tabular-nums">{shift.number}</span>
+        <ul className="mt-3 grid">
+          {returns.map((item) => (
+            <li
+              key={item.id}
+              className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-body-sm"
+            >
+              <span className="grid">
+                <Link
+                  to="/pos/returns/$returnId"
+                  params={{ returnId: item.id }}
+                  className="w-fit font-mono font-medium text-brand tabular-nums underline-offset-3 hover:underline"
+                >
+                  {item.number}
+                </Link>
+                <span className="text-caption text-ink-3 tabular-nums">{isoDate(item.date)}</span>
+              </span>
+              <span className="font-medium tabular-nums">{money(item.total)}</span>
+            </li>
+          ))}
+        </ul>
       )}
-    </div>
+    </Card>
   );
 }
 
```

- **What came back of a line is in the line's own unit** (`line.unitId`), like the quantity it was sold in: "1 dozen
  came back" under "2 dozen". The server counts it that way (`returnedQuantity`, 20c.1).
- **An exchange payment links its return** (decision 86); the other payments are as before.
- **`ReturnsCard` lists the sale's returns, oldest first, or says nothing came back** (decision 31). Each is a link with
  its day and its total; a sale with returns of other registers lists those too.

```diff
@@ -52,7 +52,8 @@ export function SalesBackLink({
     | '/credit-notes'
     | '/refunds'
     | '/pos/sales'
-    | '/pos/shifts';
+    | '/pos/shifts'
+    | '/pos/returns';
   label: string;
 }) {
   return (
```

- **`/pos/returns` joins the back link's routes,** typed, so a wrong path is a type error and not a dead link.

### `routes/pos-shift.tsx`: the refunds and the Z report

```diff
@@ -1,4 +1,4 @@
-import { AlertCircleIcon, MinusSignCircleIcon } from '@hugeicons/core-free-icons';
+import { AlertCircleIcon, MinusSignCircleIcon, PrinterIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
@@ -8,7 +8,9 @@ import {
   contractErrorMap,
   type EntryRef,
   multiplyMoney,
+  type PosRegister,
   type PosShift,
+  type PosShiftReport,
   posShiftCloseWithoutCountInputSchema,
   routes,
 } from '@omnivo/contracts';
@@ -29,20 +31,23 @@ import {
 } from '@omnivo/ui';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link, useParams } from '@tanstack/react-router';
-import { useState } from 'react';
+import { lazy, Suspense, useState } from 'react';
 import { useForm } from 'react-hook-form';
 
 import { Fact } from '../components/adjustment-view';
 import { DocumentNotice } from '../components/document-notice';
 import { EntryLinks } from '../components/entry-links';
 import { failureOf } from '../components/journal-parts';
+import { useReceiptCompany } from '../components/pos-parts';
 import { counterMoney, differenceWords, PosShiftPill } from '../components/pos-shift-parts';
 import { SalesBackLink } from '../components/sales-parts';
 import { useIsoDate, useTenantId, useTimeZone } from '../components/stock-parts';
 import { call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { useCan } from '../lib/permissions';
-import { posShiftQuery } from '../lib/pos-queries';
+import { posRegisterQuery, posShiftQuery } from '../lib/pos-queries';
+import { zReportOf } from '../lib/pos-shift';
+import { settingsQuery } from '../lib/queries';
 import { useOnline } from '../lib/use-online';
 
 // Step 20b: one shift, as the server has it (pos.shift.manage): the two counts, what the drawer
@@ -50,6 +55,12 @@ import { useOnline } from '../lib/use-online';
 // entries. An open shift that nobody can close is closed here without a count (decisions 11, 27).
 // Every amount has its paisa, like a document; the three numbers at the top read like the
 // counter's result (whole taka unless there is paisa), so a manager compares them at a glance.
+// Step 20c: what the returns paid back, the Z report's sums, a link to the shift's returns, and
+// "Print Z report" for a closed shift (decision 4), on the register's receipt printer.
+
+const PosShiftReportSheet = lazy(async () => ({
+  default: (await import('../components/pos-receipt')).PosShiftReportSheet,
+}));
 
 function CantFind({ message }: { message: string }) {
   const { t } = useLocale();
@@ -77,9 +88,14 @@ export function PosShiftPage() {
 
 function PosShiftView({ shift }: { shift: PosShift }) {
   const { t, format } = useLocale();
+  const tenantId = useTenantId();
   const timeZone = useTimeZone();
   const isoDate = useIsoDate();
   const [closing, setClosing] = useState(false);
+  const [printing, setPrinting] = useState(false);
+  // The Z report prints on the register's paper, with the company's header
+  const register = useQuery(posRegisterQuery(tenantId, shift.register.id)).data;
+  const settings = useQuery(settingsQuery(tenantId)).data;
   const money = (value: string) => format.money(value, { decimals: 2 });
   const time = (iso: string) => format.dateTime(new Date(iso), timeZone);
   // Decision 22: the books use the server's number; the page says when the device's differed
@@ -100,6 +116,21 @@ function PosShiftView({ shift }: { shift: PosShift }) {
         actions={
           <>
             <PosShiftPill status={shift.status} />
+            {/* Only after the close: an open shift's sums still change (its X report is the
+                counter's, from the device) */}
+            {shift.status !== 'open' && register && settings && (
+              <Button
+                variant="secondary"
+                className="gap-1.5"
+                disabled={printing}
+                onClick={() => {
+                  setPrinting(true);
+                }}
+              >
+                <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
+                {t('posShifts.printZ')}
+              </Button>
+            )}
             {shift.status === 'open' && (
               <Button
                 variant="secondary"
@@ -169,7 +200,7 @@ function PosShiftView({ shift }: { shift: PosShift }) {
           value={shift.closedAt === null ? '—' : time(shift.closedAt)}
         />
       </Card>
-      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
+      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
         <CashCard shift={shift} money={money} />
         <Card>
           {/* The sales the server has received in the shift, and what they took by method */}
@@ -183,13 +214,21 @@ function PosShiftView({ shift }: { shift: PosShift }) {
           />
           <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
             {shift.payments.map((payment) => (
-              <div key={payment.method} className="flex justify-between gap-3">
-                <dt className="text-ink-2">{t(`pos.methods.${payment.method}`)}</dt>
-                <dd className="tabular-nums">{money(payment.amount)}</dd>
-              </div>
+              <Row
+                key={payment.method}
+                label={t(`pos.methods.${payment.method}`)}
+                value={money(payment.amount)}
+              />
             ))}
+            {/* Step 20c: the Z report's two sums of the sales, under a rule: they are not money
+                taken, they are inside the total above */}
+            <div className="grid gap-2 border-t border-line pt-2">
+              <Row label={t('posShifts.salesDiscount')} value={money(shift.salesDiscount)} />
+              <Row label={t('posShifts.salesVat')} value={money(shift.salesVat)} />
+            </div>
           </dl>
         </Card>
+        <RefundsCard shift={shift} money={money} />
       </div>
       <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
         <Card>
@@ -251,6 +290,18 @@ function PosShiftView({ shift }: { shift: PosShift }) {
           none="—"
         />
       </Card>
+      {printing && register && settings && (
+        <Suspense fallback={null}>
+          <ZReport
+            shift={shift}
+            register={register}
+            settings={settings}
+            onPrinted={() => {
+              setPrinting(false);
+            }}
+          />
+        </Suspense>
+      )}
       {closing && (
         <CloseWithoutCountDialog
           shift={shift}
@@ -272,8 +323,8 @@ function Row({ label, value }: { label: string; value: string }) {
   );
 }
 
-// Why the drawer should hold what it does: expectedCashOf()'s five parts, then the sum. Change and
-// pay outs take money away, so they have a minus.
+// Why the drawer should hold what it does: expectedCashOf()'s parts, then the sum. Change, pay outs
+// and (step 20c) the cash paid back take money away, so they have a minus.
 function CashCard({ shift, money }: { shift: PosShift; money: (value: string) => string }) {
   const { t } = useLocale();
   const { cash } = shift;
@@ -286,6 +337,7 @@ function CashCard({ shift, money }: { shift: PosShift; money: (value: string) =>
         <Row label={t('posShifts.cash.changeGiven')} value={`−${money(cash.changeGiven)}`} />
         <Row label={t('posShifts.cash.paidIn')} value={money(cash.paidIn)} />
         <Row label={t('posShifts.cash.paidOut')} value={`−${money(cash.paidOut)}`} />
+        <Row label={t('posShifts.cash.cashRefunded')} value={`−${money(cash.cashRefunded)}`} />
         <div className="flex justify-between gap-3 border-t border-line pt-2 font-medium">
           <dt>{t('posShifts.cash.expected')}</dt>
           <dd className="tabular-nums">{money(shift.expectedCash)}</dd>
@@ -295,6 +347,71 @@ function CashCard({ shift, money }: { shift: PosShift; money: (value: string) =>
   );
 }
 
+// Step 20c (decision 27): what the returns taken back in the shift paid back, by tender: cash (in
+// the drawer's sum above), the register's other methods, and an exchange when one was used. The
+// returns' VAT for the Z report, and a link to the returns themselves when there are any.
+function RefundsCard({ shift, money }: { shift: PosShift; money: (value: string) => string }) {
+  const { t, format } = useLocale();
+  return (
+    <Card>
+      <CardHeader
+        title={t('posShifts.refunds')}
+        subtitle={t('posShifts.returns', {
+          count: shift.returnCount,
+          formatted: format.number(shift.returnCount),
+          total: money(shift.returnsTotal),
+        })}
+      />
+      <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
+        {shift.refunds.map((refund) => (
+          <Row
+            key={refund.method}
+            label={t(`pos.methods.${refund.method}`)}
+            value={money(refund.amount)}
+          />
+        ))}
+        <div className="grid gap-2 border-t border-line pt-2">
+          <Row label={t('posShifts.returnsVat')} value={money(shift.returnsVat)} />
+        </div>
+        {shift.returnCount > 0 && (
+          <Link
+            to="/pos/returns"
+            search={{ shiftId: shift.id }}
+            className="w-fit font-medium text-brand underline-offset-3 hover:underline"
+          >
+            {t('posShifts.seeReturns')}
+          </Link>
+        )}
+      </dl>
+    </Card>
+  );
+}
+
+// The Z report, made once when asked (useState's first value), so the paper does not change while
+// the print dialog is open; it leaves the page once printed (onPrinted), like the counter's.
+function ZReport({
+  shift,
+  register,
+  settings,
+  onPrinted,
+}: {
+  shift: PosShift;
+  register: PosRegister;
+  settings: Parameters<typeof useReceiptCompany>[0];
+  onPrinted: () => void;
+}) {
+  const company = useReceiptCompany(settings);
+  const [report] = useState<PosShiftReport>(() => zReportOf(shift, new Date().toISOString()));
+  return (
+    <PosShiftReportSheet
+      report={report}
+      paperWidth={register.paperWidth}
+      company={company}
+      onPrinted={onPrinted}
+    />
+  );
+}
+
 // A count by notes as the cashier typed it (only the notes there were), or one line for a count
 // typed as a total
 function CountTable({ count, money }: { count: CashCount; money: (value: string) => string }) {
```

- **"Print Z report" shows only for a closed shift, once the register and the settings are loaded** (decision 88): the
  paper's width is the register's, the header the company's. It is disabled while the report prints, so a second click
  does not queue a second print.
- **`ZReport` makes the report once** (`useState`'s first value), like the counter's `ShiftReport`: a refetch while the
  print dialog is open does not change the paper. The sheet leaves the page when the print dialog closes
  (`onPrinted`).
- **"Cash paid back" has a minus,** like change and pay outs: it is money that left the drawer (decision 26).
- **The sales' discounts and VAT sit under a rule** in "Taken by method": they are inside the sales' total, not more
  money, and the rule keeps a reader from adding them to the methods.
- **`RefundsCard`** lists the refunds per tender the way "Taken by method" lists the payments (the register's methods
  with their 0, an exchange when one was used), then the returns' VAT, then "See the returns" when there are any
  (decision 83).
- **Three cards in a row from `xl`** (cash, taken, paid back), two from `lg`, one on a phone.

### `router.tsx` and `routes/app-shell.tsx`

```diff
@@ -703,6 +703,25 @@ const posCashReasonsRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/pos-cash-reasons'), 'PosCashReasonsPage'),
 });
 
+// Step 20c: the returns the counters took back, and one return. A shift's page links to its own
+// returns with ?shiftId=, so the list opens filtered to it.
+const posReturnsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/returns',
+  validateSearch: (search: Record<string, unknown>): { shiftId?: string } => ({
+    // Not a uuid (a link typed by hand): every return, not a 400 from the API
+    ...(typeof search.shiftId === 'string' &&
+      UUID.test(search.shiftId) && { shiftId: search.shiftId }),
+  }),
+  component: lazyRouteComponent(() => import('./routes/pos-returns'), 'PosReturnsPage'),
+});
+
+const posReturnRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/returns/$returnId',
+  component: lazyRouteComponent(() => import('./routes/pos-return'), 'PosReturnPage'),
+});
+
 const soldShortRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/stock/sold-short',
@@ -1030,6 +1049,8 @@ const routeTree = rootRoute.addChildren([
     posSaleRoute,
     posShiftsRoute,
     posShiftRoute,
+    posReturnsRoute,
+    posReturnRoute,
     posCashReasonsRoute,
     soldShortRoute,
     myDevicesRoute,
```

- **`validateSearch` keeps a `shiftId` only when it is a uuid,** like the other links that carry an id (`?orderId=`):
  the API would answer a bad one with a 400 and the page with an error.
- **Both pages are lazy, under the app route,** so they have the sidebar; only `/pos` itself is bare.

```diff
@@ -42,6 +42,7 @@ import {
   Payment02Icon,
   PieChartIcon,
   ReceiptDollarIcon,
+  ReturnRequestIcon,
   RulerIcon,
   SecurityCheckIcon,
   Settings02Icon,
@@ -453,6 +454,10 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
             <NavLink to="/pos/sales" icon={ReceiptDollarIcon}>
               {t('nav.posSales')}
             </NavLink>
+            {/* Step 20c: what the counters took back, read by everyone like the sales */}
+            <NavLink to="/pos/returns" icon={ReturnRequestIcon}>
+              {t('nav.posReturns')}
+            </NavLink>
             {/* Step 20b (decision 26): the shifts show how short a drawer was, so only for the
                 people who look after the counters */}
             {can('pos.shift.manage') && (
```

- **POS returns sits right after POS sales, for everyone** (decision 30), with HugeIcons' `ReturnRequest` icon. The
  counter's Return button keeps its `ArrowTurnBackward`.

### `components/journal-entry-view.tsx`, `lib/stock.ts`, `routes/stock-card.tsx`

```diff
@@ -172,6 +172,13 @@ function documentLinkOf(entry: JournalEntry) {
   if (entry.source === 'pos_shift') {
     return { to: '/pos/shifts/$shiftId', params: { shiftId: id } } as const;
   }
+  // Step 20c: a POS sale's entry (20a had no link for it) and a return's
+  if (entry.source === 'pos_sale') {
+    return { to: '/pos/sales/$saleId', params: { saleId: id } } as const;
+  }
+  if (entry.source === 'pos_return') {
+    return { to: '/pos/returns/$returnId', params: { returnId: id } } as const;
+  }
   return null;
 }
 
@@ -301,7 +308,14 @@ export function EntryView({
           )
         )}
       </div>
-      {fromStock && <p className="text-label text-ink-3">{t('journal.stockEntryHint')}</p>}
+      {/* Step 20c: a POS return is a stock source too, but another stock document does not put it
+          right: goods taken back by mistake are sold again (decision 25) */}
+      {fromStock && entry.source !== 'pos_return' && (
+        <p className="text-label text-ink-3">{t('journal.stockEntryHint')}</p>
+      )}
+      {entry.source === 'pos_return' && (
+        <p className="text-label text-ink-3">{t('journal.posReturnEntryHint')}</p>
+      )}
       {entry.source === 'sales_invoice' && (
         <p className="text-label text-ink-3">{t('journal.invoiceEntryHint')}</p>
       )}
```

- **"From POS1-R000012" links the return, and "From POS1-000123" the sale** (decision 91). Reverse stays hidden for both:
  they are stock sources (`isStockJournalSource`).
- **A return's entry shows `posReturnEntryHint` instead of `stockEntryHint`** (decision 25): another stock document
  does not undo a return; goods taken back by mistake are sold again.

```diff
@@ -108,6 +108,8 @@ export function documentRoute(
   | '/sales-returns/$returnId'
   | '/goods-receipts/$receiptId'
   | '/purchase-returns/$returnId'
+  | '/pos/sales/$saleId'
+  | '/pos/returns/$returnId'
   | null {
   if (kind === 'adjustment') return '/stock/adjustments/$adjustmentId';
   if (kind === 'transfer_out' || kind === 'transfer_in') return '/stock/transfers/$transferId';
@@ -121,6 +123,9 @@ export function documentRoute(
   if (kind === 'purchase_receipt') return '/goods-receipts/$receiptId';
   // Step 17d: goods sent back to a supplier, on a purchase return
   if (kind === 'purchase_return') return '/purchase-returns/$returnId';
+  // Step 20c: goods sold at a counter (20a had no link for them), and goods it took back
+  if (kind === 'pos_sale') return '/pos/sales/$saleId';
+  if (kind === 'pos_return') return '/pos/returns/$returnId';
   return null;
 }
 
```

```diff
@@ -425,6 +425,10 @@ export function StockCardPage() {
                 void navigate({ to: route, params: { receiptId: movement.documentId } });
               } else if (route === '/purchase-returns/$returnId') {
                 void navigate({ to: route, params: { returnId: movement.documentId } });
+              } else if (route === '/pos/sales/$saleId') {
+                void navigate({ to: route, params: { saleId: movement.documentId } });
+              } else if (route === '/pos/returns/$returnId') {
+                void navigate({ to: route, params: { returnId: movement.documentId } });
               }
             }}
             onEndReached={loadMore}
```

```diff
@@ -102,6 +102,8 @@ describe('stock helpers', () => {
     expect(documentRoute('sales_return')).toBe('/sales-returns/$returnId');
     expect(documentRoute('purchase_receipt')).toBe('/goods-receipts/$receiptId');
     expect(documentRoute('purchase_return')).toBe('/purchase-returns/$returnId');
+    expect(documentRoute('pos_sale')).toBe('/pos/sales/$saleId');
+    expect(documentRoute('pos_return')).toBe('/pos/returns/$returnId');
     expect(documentRoute('sales_invoice')).toBeNull();
   });
 });
```

- **The stock card's row opens the sale or the return** its movement came from, like every other stock document. The
  movement's `documentId` is the sale's or the return's id (20a.3, 20c.3), so no new field is needed.

### `packages/i18n`: two words

`posReturns.ofShift` and `posReturns.showAll` (decision 83) are in 20c.5's diffs of `en.ts` and `bn.ts` above, in the
`posReturns` block they belong to (decision 58).

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n test
cd apps/app && npx tsc --noEmit -p .
pnpm exec eslint apps/app/src/routes apps/app/src/components apps/app/src/lib apps/app/src/router.tsx
pnpm exec prettier --check apps/app/src packages/i18n/src
pnpm --filter @omnivo/app test
cd apps/app && npx vite build && node scripts/check-bundle-size.ts
```

The type check fails only in `mocks/pos-data.ts`, `mocks/pos-shift-data.ts` and `mocks/push-data.ts` (20c.7). The rest
pass: i18n 15 tests, app 203 (2 new, for the Z report; the stock card's test checks the two new links), the bundle at 224.8 KB of 225
for the first load (the two routes and the nav item; 224.6 after 20c.6a) and 103.8 KB for the shift's page, the
largest of the new chunks.

> **What was checked while building it.** `zReportOf()` was made to keep every tender and to drop the difference check
> on purpose: the Z report's test failed, and passed again with the file copied back. The pages were not opened in a
> browser in this part: the mock server has no return, no register fields and no shift refunds until 20c.7.

## 20c.7 — `apps/app`: the mock server's returns and the browser tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). After 20c.6 the
app type checked everywhere but in three mock files, and the mock had nothing a return needs: no route to find a sale by
its number, no register's recent sales, no `pos_return.create` in its push, no `pos_sale` rows, and no return fields on
a register or a shift. This part gives the mock the API's rules for all of it, on its own arrays, and adds one test file
for the returns, the exchange and the X and Z reports.

Writing these tests found three mistakes in earlier parts, fixed there (so their code above is already the fixed one):
**the POS bar on a phone was 437px wide** once 20c.6a's Return button was in it, so no POS test on a phone could press
Pay (decision 97, `packages/ui`'s `Logo` and `routes/pos.tsx`); **a second return of a receipt right after the first
counted the first one twice**, or not at all (decision 98, `findSale()` and `withWaitingReturns()`); and **the register
form could clear its account selects** when it opened before the accounts arrived (decision 96, `routes/pos-registers.tsx`).

The files, in the order to write them: each one only uses files above it.

### `mocks/pos-data.ts`: the register's return fields, the exchange payment, the returns' rows

```diff
@@ -18,6 +18,7 @@ import {
   type PosCashReason,
   type PosLastShift,
   type PosOverride,
+  POS_DEFAULT_RETURN_DAYS,
   posChangeOf,
   posOverridesOf,
   type PosRegister,
@@ -32,7 +33,9 @@ import {
   type posSaleListQuerySchema,
   type PosSalePage,
   posSaleSummarySchema,
+  type PosRefund,
   type PosShiftStatus,
+  type PosTender,
   type ShiftCash,
   shiftIsoDate,
   type SoldShortItem,
@@ -72,6 +75,8 @@ import type { WorkspaceData } from './workspace-data';
 // Step 20b: the shifts, their pay ins and outs, and the reasons, kept here beside the registers
 // and the sales, because a register's latest shift and a sale's shift are read with them. What
 // the devices and the managers do with a shift is pos-shift-data.ts.
+// Step 20c: the returns, kept here too, because a sale reads what came back of each line and a
+// shift what its returns paid back. What a return does is pos-return-data.ts.
 
 // A register without its branch: the branch is its warehouse's, worked out when it is read, so a
 // warehouse moved to another branch takes its free registers along (the API joins warehouses).
@@ -79,18 +84,65 @@ import type { WorkspaceData } from './workspace-data';
 export type MockRegister = Omit<PosRegister, 'branchId' | 'lastShift'>;
 
 // A sale's line as the mock keeps it: the contract's line, plus what the Sold short list reads
-// (the API's short_serials column, and the lot of the batch that went below zero)
-export interface MockPosLine extends PosSaleLine {
+// (the API's short_serials column, and the lot of the batch that went below zero). Step 20c:
+// without what came back of it, read from the returns when the sale is read, and with what its
+// goods cost (the API's value column): a return takes its share of that back into stock.
+export interface MockPosLine extends Omit<PosSaleLine, 'returnedQuantity'> {
   shortSerials: string[];
   shortLot: string | null;
+  value: string;
 }
 
-// The device by its id: its name is the one it has now when the sale is read
-export type MockPosSale = Omit<PosSale, 'lines' | 'device'> & {
+// The device by its id: its name is the one it has now when the sale is read. Step 20c: its
+// returns are read from data.pos.returns, like the API's join.
+export type MockPosSale = Omit<PosSale, 'lines' | 'device' | 'returns'> & {
   deviceId: string;
   lines: MockPosLine[];
 };
 
+// Step 20c: a POS return as the API's pos_returns row keeps it, with its lines (the product,
+// unit, description and price are the sale line's), the batches each went back into and its
+// refunds. Never changed once written (0056).
+export interface MockReturnLine {
+  id: string;
+  saleLineId: string;
+  // In the sale line's unit, and in the base unit
+  quantity: string;
+  baseQuantity: string;
+  net: string;
+  vat: string;
+  total: string;
+  // This return's share of what the goods cost when sold
+  value: string;
+  batches: { batchId: string; quantity: string }[];
+  serialNumbers: string[];
+}
+
+export interface MockReturn {
+  id: string;
+  registerId: string;
+  shiftId: string;
+  deviceId: string;
+  // The person who pushed it (created_by)
+  cashierId: string;
+  sequence: number;
+  number: string;
+  date: string;
+  returnedAt: string;
+  saleId: string;
+  // The register's warehouse: where the goods came back into
+  warehouseId: string;
+  net: string;
+  vat: string;
+  total: string;
+  note: string | null;
+  outsideWindow: boolean;
+  createdAt: string;
+  lines: MockReturnLine[];
+  refunds: PosRefund[];
+  entry: EntryRef | null;
+}
+
 // A shift as the API's pos_shifts row keeps it (step 20b). The cashier is the device's person
 // (created_by); the counts keep the device's notes and a 4-decimal total.
 export interface MockShift {
@@ -147,10 +199,12 @@ export interface MockPos {
   reasons: PosCashReason[];
   shifts: MockShift[];
   movements: MockMovement[];
+  // Step 20c: in the order they arrived; the list sorts them
+  returns: MockReturn[];
 }
 
 export function emptyPos(): MockPos {
-  return { registers: [], sales: [], reasons: [], shifts: [], movements: [] };
+  return { registers: [], sales: [], reasons: [], shifts: [], movements: [], returns: [] };
 }
 
 function now(): string {
@@ -175,17 +229,28 @@ type SeedRegister = Omit<
   | 'overShortAccountId'
   | 'varianceAlert'
   | 'lockAfter'
+  | 'exchangeAccountId'
+  | 'returnDays'
+  | 'lastReturnNumber'
 >;
 
 // Step 20b: every seeded counter has the over/short account, so a shift opens on it, a bell for a
-// difference over ৳500, and no idle lock: the device in the tests has no PIN until a test sets one
-function register(fields: SeedRegister, overShortAccountId: string | null): MockRegister {
+// difference over ৳500, and no idle lock: the device in the tests has no PIN until a test sets one.
+// Step 20c: goods come back for the default 7 days; `exchangeAccountId` null = refunds only.
+function register(
+  fields: SeedRegister,
+  overShortAccountId: string | null,
+  exchangeAccountId: string | null = null,
+): MockRegister {
   return {
     id: crypto.randomUUID(),
     ...fields,
     overShortAccountId,
     varianceAlert: '500',
     lockAfter: 'off',
+    exchangeAccountId,
+    returnDays: POS_DEFAULT_RETURN_DAYS,
+    lastReturnNumber: 0,
     archivedAt: null,
     version: 1,
     updatedAt: now(),
@@ -197,7 +262,9 @@ function register(fields: SeedRegister, overShortAccountId: string | null): Mock
 // held by the store office PC (seedDevices()), and stays in the list with that name. The
 // Chattogram depot's counter was held by the depot computer revoked 12 days ago: the revoke freed
 // it, and its numbers go on from 1,260. The pharma distributor has one counter at its depot.
-// After seedDevices(): the outlet's counter names one of its devices.
+// After seedDevices(): the outlet's counter names one of its devices. Step 20c: the head office's
+// two counters make exchanges, through 2190 POS exchange clearing; the depot's counter and the
+// pharmacy's only pay money back.
 export function seedPos(data: WorkspaceData, garments: boolean): void {
   const byCode = (code: string) => data.stock.warehouses.find((place) => place.code === code);
   const account = (code: string) => data.accounts.find((row) => row.code === code)?.id ?? null;
@@ -228,6 +295,7 @@ export function seedPos(data: WorkspaceData, garments: boolean): void {
   }
   const storePc = data.sync.devices.find((device) => device.name === 'Store office PC');
   const depot = byCode('CTG');
+  const exchange = addExchangeAccount(data);
   data.pos.registers.push(
     register(
       {
@@ -242,6 +310,7 @@ export function seedPos(data: WorkspaceData, garments: boolean): void {
         lastNumber: 0,
       },
       overShort,
+      exchange,
     ),
     register(
       {
@@ -256,6 +325,7 @@ export function seedPos(data: WorkspaceData, garments: boolean): void {
         lastNumber: 214,
       },
       overShort,
+      exchange,
     ),
   );
   if (depot) {
@@ -302,6 +372,30 @@ function addOverShortAccount(data: WorkspaceData): string | null {
   return id;
 }
 
+// Step 20c: the liability an exchange's money passes through, like the API's retail template
+// (2190). The garments chart has none, so it is added beside the over/short account, for the same
+// reason.
+function addExchangeAccount(data: WorkspaceData): string | null {
+  const parent = data.accounts.find((row) => row.code === '2100');
+  if (!parent) return null;
+  const id = crypto.randomUUID();
+  data.accounts.push({
+    id,
+    parentId: parent.id,
+    code: '2190',
+    name: 'POS exchange clearing',
+    type: parent.type,
+    isGroup: false,
+    purpose: null,
+    holdsMoney: false,
+    description: null,
+    archivedAt: null,
+    version: 1,
+    updatedAt: now(),
+  });
+  return id;
+}
+
 // --- Registers ----------------------------------------------------------------------------------
 
 function branchOfRegister(data: WorkspaceData, stored: MockRegister): string {
@@ -323,7 +417,8 @@ export function toRegister(data: WorkspaceData, stored: MockRegister): PosRegist
 
 // The API's pos_shift_cash(): the opening count, the cash the shift's sales took and the change
 // they gave, its pay ins and pay outs, read from the rows now. A sale that arrives after a close
-// without a count is counted too (decision 63).
+// without a count is counted too (decision 63). Step 20c: less the cash its returns paid back,
+// whatever shift sold the goods; an exchange's money never left the drawer.
 export function shiftCash(data: WorkspaceData, shift: MockShift): ShiftCash & { expected: string } {
   const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
   const moved = (direction: PosCashDirection) =>
@@ -344,6 +439,13 @@ export function shiftCash(data: WorkspaceData, shift: MockShift): ShiftCash & {
     changeGiven: sumMoney(sales.map((sale) => sale.change)),
     paidIn: moved('in'),
     paidOut: moved('out'),
+    cashRefunded: sumMoney(
+      data.pos.returns
+        .filter((item) => item.shiftId === shift.id)
+        .flatMap((item) =>
+          item.refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
+        ),
+    ),
   };
   return { ...cash, expected: expectedCashOf(cash) };
 }
@@ -416,14 +518,23 @@ export function registerSnapshot(
     overShortAccount: codeOf(data.accounts, stored.overShortAccountId),
     varianceAlert: stored.varianceAlert,
     lockAfter: stored.lockAfter,
+    exchangeAccount: codeOf(data.accounts, stored.exchangeAccountId),
+    returnDays: String(stored.returnDays),
   };
 }
 
+// Step 20c: the register's account for a tender, the API's accountOf(): an exchange goes through
+// its exchange account; null = it does not take that method, or makes no exchanges
+export function accountOf(stored: MockRegister, tender: PosTender): string | null {
+  return tender === 'exchange' ? stored.exchangeAccountId : stored.accounts[tender];
+}
+
 type RegisterFields = Omit<PosRegisterInput, 'code'>;
 
 // The API's create() and update() checks, all but the code: an active warehouse when it is new or
-// changed, a held register kept in its device's branch, every account a money account, and (step
-// 20b) an over/short account that is an active income or expense account, not a group
+// changed, a held register kept in its device's branch, every account a money account, (step 20b)
+// an over/short account that is an active income or expense account, not a group, and (step 20c)
+// an exchange account, when one is picked, that is an active liability, not a group
 function checkFields(data: WorkspaceData, fields: RegisterFields, before?: MockRegister): void {
   if (before?.warehouseId !== fields.warehouseId) {
     const place = data.stock.warehouses.find(
@@ -457,6 +568,17 @@ function checkFields(data: WorkspaceData, fields: RegisterFields, before?: MockR
   ) {
     throw fieldProblem('pos_over_short_invalid', 'overShortAccountId');
   }
+  if (fields.exchangeAccountId !== null) {
+    const exchange = data.accounts.find((account) => account.id === fields.exchangeAccountId);
+    if (
+      !exchange ||
+      exchange.isGroup ||
+      exchange.archivedAt !== null ||
+      exchange.type !== 'liability'
+    ) {
+      throw fieldProblem('pos_exchange_account_invalid', 'exchangeAccountId');
+    }
+  }
 }
 
 function formOf(fields: RegisterFields) {
@@ -470,6 +592,8 @@ function formOf(fields: RegisterFields) {
     overShortAccountId: fields.overShortAccountId,
     varianceAlert: fields.varianceAlert,
     lockAfter: fields.lockAfter,
+    exchangeAccountId: fields.exchangeAccountId,
+    returnDays: fields.returnDays,
   };
 }
 
@@ -484,6 +608,7 @@ export function createRegister(data: WorkspaceData, input: PosRegisterInput): Mo
     ...formOf(input),
     deviceId: null,
     lastNumber: 0,
+    lastReturnNumber: 0,
     archivedAt: null,
     version: 1,
     updatedAt: now(),
@@ -579,19 +704,22 @@ export function assertNoHeldRegister(data: WorkspaceData, warehouseId: string):
 }
 
 // An account a register or a POS payment names stays (the API's foreign keys, account_in_use).
-// Step 20b: also a register's over/short account, a reason's, and a pay in or out's.
+// Step 20b: also a register's over/short account, a reason's, and a pay in or out's. Step 20c: a
+// register's exchange account and a return's refund.
 export function usedByPos(data: WorkspaceData, accountId: string): boolean {
   return (
     data.pos.registers.some(
       (item) =>
         item.overShortAccountId === accountId ||
+        item.exchangeAccountId === accountId ||
         POS_PAYMENT_METHODS.some((method) => item.accounts[method] === accountId),
     ) ||
     data.pos.sales.some((sale) =>
       sale.payments.some((payment) => payment.accountId === accountId),
     ) ||
     data.pos.reasons.some((reason) => reason.accountId === accountId) ||
-    data.pos.movements.some((movement) => movement.accountId === accountId)
+    data.pos.movements.some((movement) => movement.accountId === accountId) ||
+    data.pos.returns.some((item) => item.refunds.some((refund) => refund.accountId === accountId))
   );
 }
 
@@ -740,9 +868,16 @@ export function createSale(
   const shift =
     input.shiftId === null ? null : deviceShift(data, input.shiftId, deviceId, register.id);
 
-  // Decision 34: the register's account for each method now
-  const missing = input.payments.flatMap((payment, index) =>
-    register.accounts[payment.method] === null ? [`payments.${String(index)}.method`] : [],
+  // Decision 34: the register's account for each method now. Step 20c: an exchange's money goes
+  // through the account its return put it on (the API's checkExchange()).
+  const exchanges = exchangeAccounts(data, input, register.id);
+  const accountIds = input.payments.map((payment, index) =>
+    payment.method === 'exchange'
+      ? (exchanges.get(index) ?? null)
+      : accountOf(target, payment.method),
+  );
+  const missing = accountIds.flatMap((accountId, index) =>
+    accountId === null ? [`payments.${String(index)}.method`] : [],
   );
   if (missing.length > 0) {
     throw new MockProblem(
@@ -794,6 +929,12 @@ export function createSale(
   if (data.pos.sales.some((sale) => sale.number === number)) {
     throw fieldProblem('pos_number_taken', 'sequence');
   }
+  // Step 20c: the line ids the device made, which a return made offline may already point at.
+  // One already used is the API's pos_sale_lines_pkey (sync_id_taken, no field).
+  const usedLineIds = new Set(data.pos.sales.flatMap((sale) => sale.lines.map((line) => line.id)));
+  if (input.lines.some((line) => line.id !== null && usedLineIds.has(line.id))) {
+    throw new MockProblem(409, 'sync_id_taken');
+  }
 
   const amounts = posSaleAmounts(
     input.lines,
@@ -853,8 +994,8 @@ export function createSale(
     document: { id: saleId, number },
     narration: `POS sale ${number}`,
     amounts: [
-      ...input.payments.map((payment) => ({
-        accountId: register.accounts[payment.method] ?? cashAccount,
+      ...input.payments.map((payment, index) => ({
+        accountId: accountIds[index] ?? cashAccount,
         branchId,
         amount: payment.amount,
       })),
@@ -881,6 +1022,8 @@ export function createSale(
       data.stock.batches.find((batch) => batch.id === batchId);
     return {
       ...line,
+      // Step 20c: the device's own id
+      id: sent.id ?? line.id,
       // The device's rate and the amounts worked out with it (decision 22)
       taxRate: { ...line.taxRate, rate: sent.rate },
       net: lineAmounts.net,
@@ -901,6 +1044,7 @@ export function createSale(
         line.tracking === 'batch' && compareQuantity(plan.shortQuantity, '0') > 0
           ? (batchOf(sent.batchId)?.lotNumber ?? null)
           : null,
+      value: addMoney(costs[index] ?? '0', '0'),
     };
   });
 
@@ -929,12 +1073,17 @@ export function createSale(
     paid,
     change,
     lines: saleLines,
-    payments: input.payments.map((payment) => ({
-      method: payment.method,
-      amount: addMoney(payment.amount, '0'),
-      reference: payment.reference,
-      accountId: register.accounts[payment.method] ?? cashAccount,
-    })),
+    payments: input.payments.map((payment, index) => {
+      // The return's number never changes, so it is kept with the payment
+      const used = data.pos.returns.find((item) => item.id === payment.returnId);
+      return {
+        method: payment.method,
+        amount: addMoney(payment.amount, '0'),
+        reference: payment.reference,
+        accountId: accountIds[index] ?? cashAccount,
+        return: used ? { id: used.id, number: used.number } : null,
+      };
+    }),
     deviceId,
     entry,
   };
@@ -967,6 +1116,52 @@ export function createSale(
   };
 }
 
+// Step 20c (decision 38), the API's checkExchange(): an exchange payment uses a return saved with
+// this sale (the push ran it first), at the same register and in the same shift, for exactly the
+// return's exchange refund, and no other sale used it. The device makes both, so each is a bug.
+// Answers each exchange payment's account: the one its return's refund went to.
+function exchangeAccounts(
+  data: WorkspaceData,
+  input: PosSaleInput,
+  registerId: string,
+): Map<number, string> {
+  const accounts = new Map<number, string>();
+  const issues: { path: string; code: ErrorCode }[] = [];
+  input.payments.forEach((payment, index) => {
+    if (payment.method !== 'exchange' || payment.returnId === null) return;
+    const path = `payments.${String(index)}.method`;
+    const used = data.pos.returns.find((item) => item.id === payment.returnId);
+    if (!used) {
+      issues.push({ path, code: 'pos_return_unknown' });
+      return;
+    }
+    const refund = used.refunds.find((item) => item.method === 'exchange');
+    const taken = data.pos.sales.some((sale) =>
+      sale.payments.some((other) => other.return?.id === used.id),
+    );
+    if (
+      used.registerId !== registerId ||
+      used.shiftId !== input.shiftId ||
+      refund === undefined ||
+      compareMoney(refund.amount, payment.amount) !== 0 ||
+      taken
+    ) {
+      issues.push({ path, code: 'pos_exchange_invalid' });
+      return;
+    }
+    accounts.set(index, refund.accountId);
+  });
+  const [first] = issues;
+  if (first !== undefined) {
+    throw new MockProblem(
+      409,
+      first.code,
+      Object.fromEntries(issues.map((issue) => [issue.path, [issue.code]])),
+    );
+  }
+  return accounts;
+}
+
 // Decision 26, for every POS command (step 20b: a shift's open, pay ins and outs, close too): the
 // device's day, unless its clock is ahead of today or the day is locked (the API's bookingDay())
 export function bookingDay(data: WorkspaceData, deviceDate: string): string {
@@ -1020,13 +1215,38 @@ export function findSale(data: WorkspaceData, id: string): MockPosSale {
   return found;
 }
 
-// The schemas' parse leaves out what only the mock keeps (shortSerials, shortLot)
+// Step 20c: what the returns brought back of a sale line so far, in its unit, and the serial
+// numbers in the order they came back (the API's returnedOf())
+export function returnedOf(
+  data: WorkspaceData,
+  saleLineId: string,
+): { quantity: string; serialNumbers: string[] } {
+  const lines = data.pos.returns.flatMap((item) =>
+    item.lines.filter((line) => line.saleLineId === saleLineId),
+  );
+  return {
+    quantity: addQuantity(
+      lines.reduce((sum, line) => addQuantity(sum, line.quantity), '0'),
+      '0',
+    ),
+    serialNumbers: lines.flatMap((line) => line.serialNumbers),
+  };
+}
+
+// The schemas' parse leaves out what only the mock keeps (shortSerials, shortLot, value). Step
+// 20c: with what came back of each line, and the returns of it, oldest first.
 export function toPosSale(data: WorkspaceData, stored: MockPosSale): PosSale {
   const { deviceId, lines, ...rest } = stored;
   const device = data.sync.devices.find((candidate) => candidate.id === deviceId);
   return {
     ...rest,
-    lines: lines.map((line) => posSaleLineSchema.parse(line)),
+    lines: lines.map((line) =>
+      posSaleLineSchema.parse({ ...line, returnedQuantity: returnedOf(data, line.id).quantity }),
+    ),
+    returns: data.pos.returns
+      .filter((item) => item.saleId === stored.id)
+      .toSorted((a, b) => a.returnedAt.localeCompare(b.returnedAt) || a.id.localeCompare(b.id))
+      .map((item) => ({ id: item.id, number: item.number, date: item.date, total: item.total })),
     device: { id: deviceId, name: device?.name ?? '' },
   };
 }
```

- **`MockPosLine` leaves out `returnedQuantity` and keeps `value`** (decision 95). What came back is read from the
  returns by `returnedOf()` whenever the sale is read; the cost is what a return takes its share of.
- **`MockPosSale` leaves out `returns`:** `toPosSale()` reads them from `data.pos.returns`, oldest first, like the API's
  query (`returnedAt`, then the id).
- **`MockReturn` and `MockReturnLine` are the API's rows,** shortened: the line keeps its quantities, amounts, cost,
  batches and serial numbers; the product, unit, description and price are the sale line's, read when the return is
  read. `emptyPos()` starts the list empty.
- **The seed (decision 94):** `register()` takes the exchange account as a third argument (null = refunds only) and
  gives every counter the default 7 days and a last return number of 0. `addExchangeAccount()` adds 2190 under 2100
  Current liabilities, like `addOverShortAccount()` adds 5340.
- **`shiftCash()` subtracts the cash refunds** of the shift's returns, whatever shift sold the goods: the API's
  `pos_shift_cash()` after 0056. An exchange's refund is not cash, so it never touches the drawer.
- **`accountOf(register, tender)`** is the API's: the exchange tender goes through the register's exchange account.
- **`checkFields()` checks the exchange account** like the API's `checkExchange()`: active, not a group, a liability.
  `null` (the form's "No exchanges: refunds only") is not checked.
- **`registerSnapshot()` writes `exchangeAccount` (by code) and `returnDays` (as text)** into the audit log, the API's
  two new fields.
- **`usedByPos()`** also keeps a register's exchange account and a return's refund account from being deleted: the
  API's two new foreign keys.
- **`exchangeAccounts()` is the API's `checkExchange()`** for a sale: an exchange payment names a return that exists
  (`pos_return_unknown`), of the same register and shift, for exactly its exchange refund, not used by another sale
  (`pos_exchange_invalid`). The push runs the return first, so it is there. It answers each exchange payment's account:
  the return's refund account, so the two meet on one account even after the register's account changed.
- **A sale's line keeps the device's id** (`sent.id ?? line.id`, decision 64), and an id used already is
  `sync_id_taken`, the API's `pos_sale_lines_pkey`.
- **A payment keeps its return's number** (`return: { id, number }`): a return's number never changes, so it is safe to
  keep, and the sale's page links it.

### `mocks/pos-shift-data.ts`: the shift's refunds

```diff
@@ -9,7 +9,7 @@ import {
   isOverVarianceAlert,
   isPartyAccountPurpose,
   isZeroMoney,
-  POS_PAYMENT_METHODS,
+  POS_TENDERS,
   type PosCashMovementInput,
   type PosCashReason,
   type PosCashReasonInput,
@@ -20,6 +20,7 @@ import {
   type PosShiftOpenInput,
   type PosShiftPage,
   type PosShiftSummary,
+  type PosTender,
   subtractMoney,
   sumMoney,
   todayIn,
@@ -32,6 +33,7 @@ import { OWNER } from './fixtures';
 import { postNew, stockAccountIds } from './journal-data';
 import { MockProblem } from './mock';
 import {
+  accountOf,
   bookingDay,
   deviceShift,
   type MockMovement,
@@ -60,7 +62,7 @@ function storedCount(count: CashCount): CashCount {
   return { notes: count.notes, total: addMoney(count.total, '0').replace(/(\.\d{2})00$/, '$1') };
 }
 
-function personName(data: WorkspaceData, userId: string): string {
+export function personName(data: WorkspaceData, userId: string): string {
   if (userId === OWNER.id) return OWNER.fullName;
   return data.people.members.find((member) => member.userId === userId)?.fullName ?? '';
 }
@@ -519,10 +521,12 @@ export function findShift(data: WorkspaceData, id: string): MockShift {
 }
 
 // A list row. A counted shift shows what the drawer should have held at its close; an open one,
-// and one closed without a count, what it should hold now (late sales count, decision 63).
+// and one closed without a count, what it should hold now (late sales count, decision 63). Step
+// 20c: with the returns its drawer paid back, whatever shift sold the goods.
 function toSummary(data: WorkspaceData, shift: MockShift): PosShiftSummary {
   const register = toRegister(data, registerOf(data, shift));
   const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
+  const returns = data.pos.returns.filter((item) => item.shiftId === shift.id);
   const counted = shift.closing === null ? null : addMoney(shift.closing.count.total, '0');
   return {
     id: shift.id,
@@ -550,6 +554,8 @@ function toSummary(data: WorkspaceData, shift: MockShift): PosShiftSummary {
         : cashDifferenceOf(counted, shift.expectedCash),
     saleCount: sales.length,
     salesTotal: sumMoney(sales.map((sale) => sale.total)),
+    returnCount: returns.length,
+    returnsTotal: sumMoney(returns.map((item) => item.total)),
   };
 }
 
@@ -574,15 +580,18 @@ export function toShift(data: WorkspaceData, shift: MockShift): PosShift {
   const register = registerOf(data, shift);
   const cash = shiftCash(data, shift);
   const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
-  // What the sales took by each method: every method the register takes now, and any other one
-  // a sale of the shift was paid with, cash first
-  const payments = POS_PAYMENT_METHODS.flatMap((method) => {
-    const amounts = sales.flatMap((sale) =>
-      sale.payments.filter((payment) => payment.method === method).map((payment) => payment.amount),
-    );
-    if (amounts.length === 0 && register.accounts[method] === null) return [];
-    return [{ method, amount: sumMoney(amounts) }];
-  });
+  const returns = data.pos.returns.filter((item) => item.shiftId === shift.id);
+  // What the sales took by each tender: every method the register takes now, and any other one a
+  // sale of the shift was paid with, cash first. Step 20c: and what its returns paid back, the
+  // same way. Exchange is never "taken" by a register: shown only when a sale or a return used it.
+  const perTender = (paid: readonly { method: PosTender; amount: string }[]) =>
+    POS_TENDERS.flatMap((method) => {
+      const amounts = paid.filter((item) => item.method === method).map((item) => item.amount);
+      if (amounts.length === 0 && (method === 'exchange' || accountOf(register, method) === null)) {
+        return [];
+      }
+      return [{ method, amount: sumMoney(amounts) }];
+    });
   const floatReason = data.pos.reasons.find((item) => item.id === shift.opening.floatReasonId);
   const { opening } = shift;
   return {
@@ -609,8 +618,14 @@ export function toShift(data: WorkspaceData, shift: MockShift): PosShift {
       changeGiven: cash.changeGiven,
       paidIn: cash.paidIn,
       paidOut: cash.paidOut,
+      cashRefunded: cash.cashRefunded,
     },
-    payments,
+    payments: perTender(sales.flatMap((sale) => sale.payments)),
+    refunds: perTender(returns.flatMap((item) => item.refunds)),
+    // For the Z report: the sales' discounts (each line's and the bill's) and VAT, the returns' VAT
+    salesDiscount: sumMoney(sales.map((sale) => addMoney(sale.discount, sale.billDiscountAmount))),
+    salesVat: sumMoney(sales.map((sale) => sale.vat)),
+    returnsVat: sumMoney(returns.map((item) => item.vat)),
     movements: data.pos.movements
       .filter((movement) => movement.shiftId === shift.id)
       .toSorted((a, b) => a.movedAt.localeCompare(b.movedAt) || a.id.localeCompare(b.id))
```

- **`toSummary()` counts the shift's returns** (`returnCount`, `returnsTotal`): the returns its drawer paid back.
- **`perTender()` builds both lists the same way,** what the sales took and what the returns paid back: every method
  the register takes now, any other one used, cash first, and the exchange only when a sale or a return used it (a
  register never "takes" an exchange). The API's `perTender()`.
- **The Z report's sums:** the sales' discounts (each line's and the bill's), the sales' VAT and the returns' VAT.
- **`personName()` is exported** for the return's cashier (`pos-return-data.ts`).

### `mocks/pos-return-data.ts` (new): the return

```ts
import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type ErrorCode,
  formatReturnNumber,
  isQuantity,
  isWholeQuantity,
  isWithinReturnWindow,
  isZeroMoney,
  negateMoney,
  POS_SALES_ON_DEVICE_DAYS,
  type PosRegisterSalesPage,
  type PosReturn,
  type PosReturnableSale,
  posReturnableSaleSchema,
  type PosReturnInput,
  posReturnAmounts,
  posReturnLineSchema,
  type posReturnListQuerySchema,
  type PosReturnPage,
  type PosReturnSummary,
  prorateMoney,
  returnableQuantityOf,
  shiftIsoDate,
  stockLineSchema,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  todayIn,
  toBaseQuantity,
  wholeCount,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { salesAccounts } from './invoice-data';
import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import {
  accountOf,
  bookingDay,
  deviceShift,
  findRegister,
  type MockPosLine,
  type MockPosSale,
  type MockReturn,
  type MockReturnLine,
  returnedOf,
  toRegister,
} from './pos-data';
import { personName } from './pos-shift-data';
import { deliveryAccounts, fieldProblem, pageOf } from './sales-document-data';
import { branchOf, decimalsOf, issuesError, type Move, postMoves } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 20c: POS returns. The API's pos-returnable.ts and pos-returns.service.ts on
// plain arrays, shortened. A return is written only by the push (push-data.ts calls
// createPosReturn), like a sale: the money was paid back at the counter, so it is never refused
// for the register's window, for more than is left, or for permission; those go into the audit
// log, which push-data.ts writes from what createPosReturn() answers (record() lives in
// workspace-data.ts, like for pos-data.ts). The returns live in data.pos.returns (pos-data.ts),
// where a sale reads what came back of each line and a shift what its returns paid back.

// --- What a return reads of a sale --------------------------------------------------------------

// The first day of the sales a device keeps: POS_SALES_ON_DEVICE_DAYS before the workspace's today
function posSalesFrom(data: WorkspaceData): string {
  return shiftIsoDate(todayIn(data.settings.timezone), -POS_SALES_ON_DEVICE_DAYS);
}

// A sale's number in its register's series: POS1-000123 → 123. The mock keeps the number only.
function sequenceOf(sale: MockPosSale): number {
  return Number(sale.number.slice(sale.register.code.length + 1));
}

// The one shape the return screen reads (the API's returnableSalesOf()): the route's answer, the
// register's recent sales and the device's pos_sale rows. The parse keeps only the contract's
// fields of each line.
export function toReturnable(data: WorkspaceData, sale: MockPosSale): PosReturnableSale {
  return posReturnableSaleSchema.parse({
    id: sale.id,
    number: sale.number,
    registerId: sale.register.id,
    date: sale.date,
    soldAt: sale.soldAt,
    customer: sale.customer,
    pricesIncludeVat: sale.pricesIncludeVat,
    total: sale.total,
    lines: sale.lines.map((line) => {
      const back = returnedOf(data, line.id);
      return {
        ...line,
        returnedSerialNumbers: back.serialNumbers,
        returnedQuantity: back.quantity,
      };
    }),
    payments: sale.payments.map((payment) => ({
      method: payment.method,
      amount: payment.amount,
    })),
  });
}

// Online, any register's receipt. The window is the screen's to check: it knows today.
export function returnableSale(data: WorkspaceData, number: string): PosReturnableSale {
  const found = data.pos.sales.find((sale) => sale.number === number);
  if (!found) {
    throw new MockProblem(404, 'pos_return_sale_not_found', {
      saleId: ['pos_return_sale_not_found'],
    });
  }
  return toReturnable(data, found);
}

// The sales the device reads right after it takes a register (decision 45), in the order they
// were sold in: by the register's own numbers, which no device's clock can disorder
export function registerSales(
  data: WorkspaceData,
  registerId: string,
  query: { limit: number; cursor?: string | undefined },
): PosRegisterSalesPage {
  findRegister(data, registerId);
  const from = posSalesFrom(data);
  const sales = data.pos.sales
    .filter((sale) => sale.register.id === registerId && sale.date >= from)
    .toSorted((a, b) => sequenceOf(a) - sequenceOf(b));
  const page = pageOf(sales, query);
  return { ...page, items: page.items.map((sale) => toReturnable(data, sale)) };
}

// The pos_sale rows a device keeps (the API's loader): the sales of the register it holds, of the
// last POS_SALES_ON_DEVICE_DAYS days. None for a device without a register.
export function keptSalesOf(data: WorkspaceData, deviceId: string): MockPosSale[] {
  const held = data.pos.registers.find((item) => item.deviceId === deviceId);
  if (!held) return [];
  const from = posSalesFrom(data);
  return data.pos.sales.filter((sale) => sale.register.id === held.id && sale.date >= from);
}

// --- The return (the API's createFromDevice) ----------------------------------------------------

// A return line, worked out against its sale line before anything is written
interface PlannedLine {
  index: number;
  input: PosReturnInput['lines'][number];
  sale: MockPosLine;
  baseQuantity: string;
  // What earlier returns took back of the sale line, in its unit
  before: string;
  // This return's share of what the goods cost when sold
  value: string;
}

// What the audit log needs of a return, besides the return: the push writes the rows
export interface PosReturnAudit {
  stored: MockReturn;
  registerCode: string;
  returnDays: number;
  sale: MockPosSale;
  // "line 1: 2 of 1.0000, 0.0000 back before", one per line that took back more than was left
  over: string[];
  // "line 1: 52 + 7.80 sent, 52.17 + 7.83 worked out", one per line whose amounts differ
  differ: string[];
}

// `value` cut by the quantities, adding up to it exactly: the last part takes what is left
function splitByQuantity(value: string, quantities: readonly string[]): string[] {
  const whole = sumQuantity(quantities);
  let left = value;
  return quantities.map((quantity, index) => {
    if (index === quantities.length - 1) return left;
    const part = prorateMoney(value, quantity, whole);
    left = subtractMoney(left, part);
    return part;
  });
}

// One pos_return.create command's work, inside push-data.ts's transaction(): the checks, the goods
// back into the register's warehouse, the refunds, the entry, the return written.
export function createPosReturn(
  data: WorkspaceData,
  device: { id: string; userId: string },
  returnId: string,
  input: PosReturnInput,
): PosReturnAudit {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  if (target?.deviceId !== device.id) throw fieldProblem('pos_register_not_held', 'registerId');
  const register = toRegister(data, target);
  const number = formatReturnNumber(register.code, input.sequence);
  // Decision 19: this register's shift on this device; one closed since still takes it
  deviceShift(data, input.shiftId, device.id, register.id);

  // Where each refund's money came from: the register's account for the method now, or its
  // exchange account. Both are put right in Settings → POS registers, then sent again.
  const issues: { path: string; code: ErrorCode }[] = [];
  const refunds = input.refunds.map((refund, index) => {
    const accountId = accountOf(target, refund.method);
    if (accountId === null) {
      issues.push({
        path: `refunds.${String(index)}.method`,
        code: refund.method === 'exchange' ? 'pos_exchange_not_set' : 'pos_method_not_set',
      });
    }
    return {
      method: refund.method,
      amount: addMoney(refund.amount, '0'),
      reference: refund.reference,
      accountId: accountId ?? '',
    };
  });
  if (issues.length > 0) throw issuesError(issues);

  const sale = data.pos.sales.find((item) => item.id === input.saleId);
  if (!sale) throw fieldProblem('pos_return_sale_not_found', 'saleId');
  const lines = planLines(data, sale, input);
  const window = isWithinReturnWindow(sale.date, input.date, target.returnDays);
  const net = sumMoney(input.lines.map((line) => line.net));
  const vat = sumMoney(input.lines.map((line) => line.vat));
  const total = addMoney(net, vat);
  const date = bookingDay(data, input.date);
  // The register is the device's alone, so only a bug gets here (pos_returns_tenant_number_idx)
  if (
    data.pos.returns.some(
      (item) =>
        item.number === number ||
        (item.registerId === target.id && item.sequence === input.sequence),
    )
  ) {
    throw fieldProblem('pos_return_number_taken', 'sequence');
  }

  // Decision 3: the goods come back into the register's warehouse, at what they cost when sold
  const planned = planStock(data, register.warehouseId, lines);
  postMoves(
    data,
    { date, kind: 'pos_return', direction: 'in', documentId: returnId, number },
    planned.flatMap((plan) => plan.moves),
  );

  // The books (the API's StockBooksService.posReturn()): the sale and its cost come off the
  // sale's branch, the money and the goods are where they came back
  const books = salesAccounts(data);
  const here = register.branchId;
  const sold = branchOf(data, sale.warehouseId);
  const cost = sumMoney(lines.map((line) => line.value));
  const goodsAccounts = isZeroMoney(cost) ? null : deliveryAccounts(data);
  const entry = postStockEntry(data, {
    date,
    source: 'pos_return',
    document: { id: returnId, number },
    narration: `POS return ${number}`,
    amounts: [
      { accountId: data.salesAccounts.returns ?? books.sales, branchId: sold, amount: net },
      { accountId: books.vatOutput, branchId: sold, amount: vat },
      ...refunds.map((refund) => ({
        accountId: refund.accountId,
        branchId: here,
        amount: negateMoney(refund.amount),
      })),
      ...(goodsAccounts === null
        ? []
        : [
            { accountId: goodsAccounts.inventory, branchId: here, amount: cost },
            {
              accountId: goodsAccounts.costOfGoodsSold,
              branchId: sold,
              amount: negateMoney(cost),
            },
          ]),
    ],
  });

  const stored: MockReturn = {
    id: returnId,
    registerId: target.id,
    shiftId: input.shiftId,
    deviceId: device.id,
    cashierId: device.userId,
    sequence: input.sequence,
    number,
    date,
    returnedAt: input.returnedAt,
    saleId: sale.id,
    warehouseId: register.warehouseId,
    net,
    vat,
    total,
    note: input.note,
    outsideWindow: !window,
    createdAt: new Date().toISOString(),
    lines: planned.map(({ line, batches }): MockReturnLine => ({
      id: crypto.randomUUID(),
      saleLineId: line.sale.id,
      quantity: addQuantity(line.input.quantity, '0'),
      baseQuantity: addQuantity(line.baseQuantity, '0'),
      net: addMoney(line.input.net, '0'),
      vat: addMoney(line.input.vat, '0'),
      total: addMoney(line.input.net, line.input.vat),
      value: line.value,
      batches,
      serialNumbers: line.input.serialNumbers,
    })),
    refunds,
    entry,
  };
  data.pos.returns.push(stored);
  // The database moves the last return number with the return (0056's pos_returns_last_number)
  keepReturnNumber(data, input);

  return {
    stored,
    registerCode: register.code,
    returnDays: target.returnDays,
    sale,
    // Against what came back before this one, as the server knows it
    over: lines.flatMap((line) =>
      compareQuantity(
        line.input.quantity,
        returnableQuantityOf({ quantity: line.sale.quantity, returnedQuantity: line.before }),
      ) > 0
        ? [
            `line ${String(line.index + 1)}: ${line.input.quantity} of ${line.sale.quantity}, ${line.before} back before`,
          ]
        : [],
    ),
    differ: lines.flatMap((line) => {
      const server = posReturnAmounts(
        {
          quantity: line.sale.quantity,
          net: line.sale.net,
          vat: line.sale.vat,
          returnedQuantity: line.before,
        },
        line.input.quantity,
      );
      return compareMoney(server.net, line.input.net) === 0 &&
        compareMoney(server.vat, line.input.vat) === 0
        ? []
        : [
            `line ${String(line.index + 1)}: ${line.input.net} + ${line.input.vat} sent, ${server.net} + ${server.vat} worked out`,
          ];
    }),
  };
}

// Decision 43: a refused return's slip was printed, so its number is used. Only up.
export function keepReturnNumber(
  data: WorkspaceData,
  input: { registerId: string; sequence: number },
): void {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  if (target && target.lastReturnNumber < input.sequence) target.lastReturnNumber = input.sequence;
}

// Each line against its sale line (the API's planLines()): a line of this sale, its quantity in
// the base unit by the sale line's own unit, its serial numbers out of the sale line's, and its
// share of what the goods cost. A refusal here is a bug: the screen offers only the sale's lines.
function planLines(data: WorkspaceData, sale: MockPosSale, input: PosReturnInput): PlannedLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const planned: PlannedLine[] = [];
  input.lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const saleLine = sale.lines.find((item) => item.id === line.saleLineId);
    if (!saleLine) {
      at('saleLineId', 'pos_return_line_unknown');
      return;
    }
    // Decision 17: in the sale line's unit. A pack a document used is never removed (step 12).
    const factor =
      saleLine.unitId === saleLine.baseUnitId
        ? '1'
        : saleLine.units.find((pack) => pack.unitId === saleLine.unitId)?.factor;
    const baseQuantity =
      factor === undefined
        ? null
        : toBaseQuantity(line.quantity, factor, decimalsOf(data, saleLine.baseUnitId));
    if (baseQuantity === null || !isQuantity(baseQuantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    // A serial product's line brings back one serial number of the sale line per piece; any
    // other line brings back none
    const serialsOk =
      saleLine.tracking === 'serial'
        ? isWholeQuantity(baseQuantity) &&
          wholeCount(baseQuantity) === line.serialNumbers.length &&
          line.serialNumbers.every((serial) => saleLine.serialNumbers.includes(serial))
        : line.serialNumbers.length === 0;
    if (!serialsOk) {
      at('serialNumbers', 'pos_return_serial_invalid');
      return;
    }
    const before = returnedOf(data, saleLine.id).quantity;
    // The same shares as the money, so all the returns of a line take back exactly its cost
    const value = posReturnAmounts(
      { quantity: saleLine.quantity, net: saleLine.value, vat: '0', returnedQuantity: before },
      line.quantity,
    ).net;
    planned.push({ index, input: line, sale: saleLine, baseQuantity, before, value });
  });
  if (issues.length > 0) throw issuesError(issues);
  return planned;
}

// Where each line's goods go back to, in the register's warehouse (the API's planStock()):
//   no tracking  the line's base quantity
//   batch        into the batches the sale line left from, in the order it took them (the
//                cashier's batch first), each up to what it gave less what earlier returns put
//                back; what is still left (more than was sold) into the first
//   serial       a serial number that left with the sale comes back with it; one the sale took as
//                a piece without its number (sold short), or one in stock or on a truck since,
//                comes back as a piece without one, so a return is never refused
// Each move carries its share of the line's cost, by quantity.
function planStock(
  data: WorkspaceData,
  warehouseId: string,
  lines: readonly PlannedLine[],
): { line: PlannedLine; moves: Move[]; batches: { batchId: string; quantity: string }[] }[] {
  const { stock } = data;
  return lines.map((line) => {
    if (line.sale.productType !== 'goods') return { line, moves: [], batches: [] };
    const tracking = line.sale.tracking;
    const stockLine = stockLineSchema.parse({
      ...line.sale,
      quantity: line.input.quantity,
      baseQuantity: line.baseQuantity,
      batchId: null,
      lotNumber: null,
      expiresOn: null,
      manufacturedOn: null,
      serialNumbers: [],
    });
    const move = (
      batchId: string | null,
      quantity: string,
      value: string,
      serialNumbers: string[] = [],
    ): Move => ({
      line: line.index,
      warehouseId,
      stockLine,
      batchId,
      quantity,
      serialNumbers,
      value,
    });

    if (tracking === 'batch') {
      const rows = line.sale.batches;
      const backBefore = data.pos.returns.flatMap((item) =>
        item.lines
          .filter((other) => other.saleLineId === line.sale.id)
          .flatMap((other) => other.batches),
      );
      const taken = new Map<string, string>();
      let wanted = line.baseQuantity;
      for (const row of rows) {
        if (compareQuantity(wanted, '0') <= 0) break;
        const back = backBefore
          .filter((part) => part.batchId === row.batchId)
          .reduce((sum, part) => addQuantity(sum, part.quantity), '0');
        const room = subtractQuantity(row.quantity, back);
        if (compareQuantity(room, '0') <= 0) continue;
        const part = compareQuantity(room, wanted) < 0 ? room : wanted;
        taken.set(row.batchId, part);
        wanted = subtractQuantity(wanted, part);
      }
      const [first] = rows;
      // A batch line always left from at least one batch (createSale's plan)
      if (first === undefined) throw new Error(`POS sale line ${line.sale.id} has no batches`);
      if (compareQuantity(wanted, '0') > 0) {
        taken.set(first.batchId, addQuantity(taken.get(first.batchId) ?? '0', wanted));
      }
      const parts = [...taken].map(([batchId, quantity]) => ({
        batchId,
        quantity: addQuantity(quantity, '0'),
      }));
      const values = splitByQuantity(
        line.value,
        parts.map((part) => part.quantity),
      );
      return {
        line,
        moves: parts.map((part, at) => move(part.batchId, part.quantity, values[at] ?? '0')),
        batches: parts,
      };
    }

    if (tracking === 'serial') {
      const travelling = (serial: string) =>
        stock.transfers.some(
          (transfer) =>
            transfer.status === 'in_transit' &&
            transfer.lines.some(
              (sent) =>
                sent.variantId === line.sale.variantId && sent.serialNumbers.includes(serial),
            ),
        );
      // Out of every warehouse now (null; undefined = a number the stock never knew)
      const found = line.input.serialNumbers.filter(
        (serial) =>
          !line.sale.shortSerials.includes(serial) &&
          stock.serials.get(`${line.sale.variantId}|${serial}`) === null &&
          !travelling(serial),
      );
      const pieces = line.input.serialNumbers.length - found.length;
      const quantities = [
        ...(found.length > 0 ? [String(found.length)] : []),
        ...(pieces > 0 ? [String(pieces)] : []),
      ];
      const values = splitByQuantity(line.value, quantities);
      return {
        line,
        moves: [
          ...(found.length > 0
            ? [move(null, addQuantity(String(found.length), '0'), values[0] ?? '0', found)]
            : []),
          ...(pieces > 0
            ? [
                move(
                  null,
                  addQuantity(String(pieces), '0'),
                  values[found.length > 0 ? 1 : 0] ?? '0',
                ),
              ]
            : []),
        ],
        batches: [],
      };
    }

    return { line, moves: [move(null, line.baseQuantity, line.value)], batches: [] };
  });
}

// --- What the managers read ---------------------------------------------------------------------

export function findPosReturn(data: WorkspaceData, id: string): MockReturn {
  const found = data.pos.returns.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function saleOf(data: WorkspaceData, stored: MockReturn): MockPosSale {
  // A sale is never deleted, and a return always names one
  const sale = data.pos.sales.find((item) => item.id === stored.saleId);
  if (!sale) throw new Error(`POS return ${stored.number} has no sale`);
  return sale;
}

function toSummary(data: WorkspaceData, stored: MockReturn): PosReturnSummary {
  const register = toRegister(data, findRegister(data, stored.registerId));
  const shift = data.pos.shifts.find((item) => item.id === stored.shiftId);
  const sale = saleOf(data, stored);
  // One sale at most uses a return (pos_sale_payments_return_idx)
  const exchangeSale = data.pos.sales.find((item) =>
    item.payments.some((payment) => payment.return?.id === stored.id),
  );
  return {
    id: stored.id,
    number: stored.number,
    register: { id: register.id, code: register.code, name: register.name },
    shift: { id: stored.shiftId, number: shift?.number ?? '' },
    branchId: branchOf(data, stored.warehouseId) ?? register.branchId,
    warehouseId: stored.warehouseId,
    date: stored.date,
    returnedAt: stored.returnedAt,
    sale: { id: sale.id, number: sale.number, date: sale.date },
    customer: sale.customer,
    cashier: { id: stored.cashierId, fullName: personName(data, stored.cashierId) },
    net: stored.net,
    vat: stored.vat,
    total: stored.total,
    lineCount: stored.lines.length,
    exchangeSale: exchangeSale ? { id: exchangeSale.id, number: exchangeSale.number } : null,
    outsideWindow: stored.outsideWindow,
    createdAt: stored.createdAt,
  };
}

// Newest date first, then by id, like the API's cursor
export function listPosReturns(
  data: WorkspaceData,
  query: z.output<typeof posReturnListQuerySchema>,
): PosReturnPage {
  const matching = data.pos.returns
    .filter(
      (item) =>
        (query.registerId === undefined || item.registerId === query.registerId) &&
        (query.saleId === undefined || item.saleId === query.saleId) &&
        (query.shiftId === undefined || item.shiftId === query.shiftId),
    )
    .toSorted((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const page = pageOf(matching, query);
  return { ...page, items: page.items.map((item) => toSummary(data, item)) };
}

// The product, unit, description and price are the sale line's; the batches by expiry, like the
// API's join
export function toPosReturn(data: WorkspaceData, stored: MockReturn): PosReturn {
  const sale = saleOf(data, stored);
  const device = data.sync.devices.find((candidate) => candidate.id === stored.deviceId);
  const batchOf = (batchId: string) => data.stock.batches.find((batch) => batch.id === batchId);
  return {
    ...toSummary(data, stored),
    pricesIncludeVat: sale.pricesIncludeVat,
    note: stored.note,
    lines: stored.lines.flatMap((line) => {
      const saleLine = sale.lines.find((item) => item.id === line.saleLineId);
      if (!saleLine) return [];
      return [
        posReturnLineSchema.parse({
          ...saleLine,
          id: line.id,
          saleLineId: line.saleLineId,
          quantity: line.quantity,
          baseQuantity: line.baseQuantity,
          net: line.net,
          vat: line.vat,
          total: line.total,
          batches: line.batches
            .map((part) => ({
              batchId: part.batchId,
              lotNumber: batchOf(part.batchId)?.lotNumber ?? '',
              expiresOn: batchOf(part.batchId)?.expiresOn ?? null,
              quantity: part.quantity,
            }))
            .toSorted((a, b) =>
              (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31'),
            ),
          serialNumbers: line.serialNumbers,
        }),
      ];
    }),
    refunds: stored.refunds,
    device: { id: stored.deviceId, name: device?.name ?? '' },
    entry: stored.entry,
  };
}
```

**Why a new file:** what a return does is its own subject, like a shift's in 20b (decision 93). It imports
`pos-data.ts` and `pos-shift-data.ts`; neither imports it, so there is no import circle.

- **`toReturnable()` is the API's `returnableSalesOf()` for one sale,** and the one shape for the route's answer, the
  register's recent sales and the device's `pos_sale` rows. The schema's parse keeps only the contract's fields of each
  line (the mock's line has many more).
- **`sequenceOf()` reads the number back from the receipt number:** the mock keeps the number, not the sequence, and
  `registerSales()` must page in the register's own order, which no device's clock can disorder.
- **`returnableSale()` answers 404 `pos_return_sale_not_found`,** which the screen reads as "try the device's sales".
- **`keptSalesOf()` is the pull's scope:** the register the device holds, the last 30 days. The pull and the push's
  answer both use it, so they never disagree on what the device keeps.
- **`createPosReturn()` follows `createFromDevice()` in order:** the holder, the shift (a closed one still takes it),
  each refund's account (`pos_exchange_not_set` or `pos_method_not_set`), the sale, the lines, the window, the booking
  day, a number taken, then the goods, the entry and the row. It never refuses for the window, for more than is left or
  for permission: it answers `over` and `differ` for the audit rows instead.
- **`planLines()`** converts the quantity by the sale line's own unit (a pack used once is never removed), checks a
  serial line's numbers against the sale line's, and takes the cost share with the same `posReturnAmounts()` as the
  money, so all the returns of a line take back exactly what it cost.
- **`planStock()` is the API's,** case by case: a batch line back into the batches it left from, in the order it took
  them, each up to what it gave less what earlier returns put back; a serial number back with its number only when it
  is out of every warehouse and not on a truck; anything else back as plain quantity. `splitByQuantity()` cuts the cost
  so the parts add up to it exactly.
- **The entry has two branches,** like the API's `posReturn()`: the sale and its cost come off the sale's branch, the
  money and the goods are where they came back.
- **`keepReturnNumber()`** keeps a refused return's number used (decision 43): its slip was printed.
- **`toSummary()` finds the exchange sale by its payment** (`payment.return?.id`): one sale at most uses a return.

### `mocks/push-data.ts`: the return command and the `pos_sale` rows

```diff
@@ -28,6 +28,7 @@ import type { z } from 'zod';
 
 import { MockProblem } from './mock';
 import { createSale, keepNumber, overrideText } from './pos-data';
+import { createPosReturn, keepReturnNumber, keptSalesOf, toReturnable } from './pos-return-data';
 import { closeShift, moveCash, openShift } from './pos-shift-data';
 import { type MockCustomer, refreshPartyRefs, saveCustomer } from './sales-data';
 import { createOrder } from './sales-document-data';
@@ -41,7 +42,8 @@ import { diff, record, transaction, type WorkspaceData } from './workspace-data'
 // a batch sent again after a lost answer changes nothing twice. The mock's person is the owner,
 // who has every permission, so the per-command permission check (decision 17) is left out.
 // Step 20a: a POS sale (pos-data.ts's createSale) is posted when it arrives. Step 20b: so are a
-// shift's open, its pay ins and outs, and its close (pos-shift-data.ts).
+// shift's open, its pay ins and outs, and its close (pos-shift-data.ts). Step 20c: and a return
+// (pos-return-data.ts).
 
 type PushInput = z.output<typeof syncPushInputSchema>;
 type PushedCommand = PushInput['commands'][number];
@@ -82,7 +84,7 @@ function run(data: WorkspaceData, device: From, pushed: PushedCommand): SyncResu
 
   // Sent before: answered from what was kept, accepted or refused
   const stored = data.sync.answers.get(command.id);
-  if (stored) return answerOf(data, command.id, stored);
+  if (stored) return answerOf(data, device.id, command.id, stored);
 
   const key = { type: command.type, entityId: entityOf(command) };
   try {
@@ -91,13 +93,15 @@ function run(data: WorkspaceData, device: From, pushed: PushedCommand): SyncResu
     const notices = transaction(data, () => apply(data, device, command));
     const answer: MockAnswer = { ...key, status: 'accepted', notices };
     data.sync.answers.set(command.id, answer);
-    return answerOf(data, command.id, answer);
+    return answerOf(data, device.id, command.id, answer);
   } catch (error) {
     // A rule of the mock refused it: kept as refused. Anything else is a bug in the mock.
     if (!(error instanceof MockProblem)) throw error;
     // Step 20a (decision 37): the refused sale's receipt was printed, so its number stays used.
     // After transaction() put everything back, like the API's keepNumber() after the savepoint.
     if (command.type === 'pos_sale.create') keepNumber(data, command.input);
+    // Step 20c (decision 43): a refused return's slip too
+    if (command.type === 'pos_return.create') keepReturnNumber(data, command.input);
     const refusal: SyncCommandError = {
       code: error.code,
       ...(error.fieldErrors && { fieldErrors: error.fieldErrors }),
@@ -122,6 +126,8 @@ function entityOf(command: SyncCommand): string {
       return command.shiftId;
     case 'pos_cash_movement.create':
       return command.movementId;
+    case 'pos_return.create':
+      return command.returnId;
   }
 }
 
@@ -131,14 +137,37 @@ function refused(id: string, error: SyncCommandError): SyncResult {
 
 // An accepted answer brings the customer as it is now, also when it is sent again (decision 18):
 // an old answer never puts an older row back on the device. Archived since: a delete, like in a
-// delta pull. An order, a POS sale and a shift's command bring nothing: they are not on the device
-// as rows (the register's latest shift comes with the next pull).
-function answerOf(data: WorkspaceData, id: string, answer: MockAnswer): SyncResult {
+// delta pull. An order and a shift's command bring nothing: they are not on the device as rows
+// (the register's latest shift comes with the next pull). Step 20c (decision 23): a POS sale or
+// return brings the sale's pos_sale row, so the return screen knows at once what is left of it; a
+// sale the device does not keep (another register's, or older than its days) is a delete, which
+// it ignores.
+function answerOf(
+  data: WorkspaceData,
+  deviceId: string,
+  id: string,
+  answer: MockAnswer,
+): SyncResult {
   if (answer.status === 'rejected') return refused(id, answer.error);
-  return { id, status: 'accepted', notices: answer.notices, changes: changesOf(data, answer) };
+  return {
+    id,
+    status: 'accepted',
+    notices: answer.notices,
+    changes: changesOf(data, deviceId, answer),
+  };
 }
 
-function changesOf(data: WorkspaceData, answer: MockAnswer): SyncChange[] {
+function changesOf(data: WorkspaceData, deviceId: string, answer: MockAnswer): SyncChange[] {
+  if (answer.type === 'pos_sale.create' || answer.type === 'pos_return.create') {
+    const saleId =
+      answer.type === 'pos_sale.create'
+        ? answer.entityId
+        : data.pos.returns.find((item) => item.id === answer.entityId)?.saleId;
+    if (saleId === undefined) return [];
+    const kept = keptSalesOf(data, deviceId).find((sale) => sale.id === saleId);
+    if (!kept) return [{ op: 'delete', entity: 'pos_sale', key: saleId }];
+    return [{ op: 'upsert', entity: 'pos_sale', key: kept.id, data: toReturnable(data, kept) }];
+  }
   if (answer.type !== 'customer.create' && answer.type !== 'customer.update') return [];
   const found = data.sales.customers.find((item) => item.id === answer.entityId);
   // Not found (undefined), or archived
@@ -366,6 +395,75 @@ function apply(data: WorkspaceData, from: From, command: SyncCommand): SyncNotic
       }
       return [];
     }
+    // Step 20c: the API's audit rows (decision 20). The mock's person is the owner, who has
+    // pos.return.create, so pos_return.without_permission is never written.
+    case 'pos_return.create': {
+      if (data.pos.returns.some((item) => item.id === command.returnId)) {
+        throw new MockProblem(409, 'sync_id_taken');
+      }
+      const { input } = command;
+      const done = createPosReturn(data, from, command.returnId, input);
+      const { stored } = done;
+      record(
+        data,
+        'pos_return.created',
+        'pos_return',
+        stored.id,
+        diff(
+          {},
+          {
+            number: stored.number,
+            date: stored.date,
+            returnedOn: input.date,
+            register: done.registerCode,
+            sale: done.sale.number,
+            total: stored.total,
+            refunds: input.refunds.map((refund) => `${refund.method} ${refund.amount}`).join(', '),
+            entry: stored.entry?.number ?? null,
+          },
+        ),
+        device,
+      );
+      if (stored.outsideWindow) {
+        record(
+          data,
+          'pos_return.outside_window',
+          'pos_return',
+          stored.id,
+          diff(
+            {},
+            {
+              sale: done.sale.number,
+              soldOn: done.sale.date,
+              returnedOn: input.date,
+              returnDays: String(done.returnDays),
+            },
+          ),
+          device,
+        );
+      }
+      if (done.over.length > 0) {
+        record(
+          data,
+          'pos_return.over_returned',
+          'pos_return',
+          stored.id,
+          diff({}, { lines: done.over.join('; ') }),
+          device,
+        );
+      }
+      if (done.differ.length > 0) {
+        record(
+          data,
+          'pos_return.amounts_differ',
+          'pos_return',
+          stored.id,
+          diff({}, { lines: done.differ.join('; ') }),
+          device,
+        );
+      }
+      return [];
+    }
   }
 }
 
```

- **`entityOf()` names the return command:** with its `case`, the `switch` covers every command again, the type error
  20c.1 left in this file.
- **A refused return keeps its number** after `transaction()` put everything back, like a refused sale.
- **The audit rows are the API's** (`pos_return.created`, and `outside_window`, `over_returned`, `amounts_differ` when
  they apply). The mock's person is the owner, who has `pos.return.create`, so `without_permission` is never written.
- **`changesOf()` answers the sale's `pos_sale` row** for an accepted sale or return (decision 23), or a delete when the
  device does not keep that sale. It needs the device now, so `answerOf()` takes its id; a stored answer is read the
  same way, so a batch sent again gets the row as it is now.

### `mocks/sync-data.ts`: the pull

```diff
@@ -24,6 +24,7 @@ import {
 import { OWNER } from './fixtures';
 import { MockProblem } from './mock';
 import { lastShiftOf } from './pos-data';
+import { keptSalesOf, toReturnable } from './pos-return-data';
 // Type-only: workspace-data.ts imports this file for emptySync(), and a type import is erased
 // when the code is built, so it makes no circle
 import type { WorkspaceData } from './workspace-data';
@@ -254,8 +255,9 @@ function stockRows(
 }
 
 // Every row the device of this branch keeps, in the order of SYNC_ENTITIES: what a list points at
-// comes before the list
-function rowsOf(data: WorkspaceData, tenantId: string, branchId: string): SyncUpsert[] {
+// comes before the list. Step 20c: and the recent sales of the register the device holds.
+function rowsOf(data: WorkspaceData, tenantId: string, device: Device): SyncUpsert[] {
+  const { branchId } = device;
   const { catalog, sales, stock } = data;
   const products = catalog.products.filter((product) => product.archivedAt === null);
   const activeProducts = new Set(products.map((product) => product.id));
@@ -374,6 +376,15 @@ function rowsOf(data: WorkspaceData, tenantId: string, branchId: string): SyncUp
       key: stockKey(row),
       data: row,
     })),
+    // Step 20c (decision 21): the sales of the register this device holds, of the last 30 days,
+    // with what came back of each line. A return changes its sale's row, so the next pull sends
+    // it again; a device that lets go of the register gets deletes (it clears them itself first).
+    ...keptSalesOf(data, device.id).map((sale) => ({
+      op: 'upsert' as const,
+      entity: 'pos_sale' as const,
+      key: sale.id,
+      data: toReturnable(data, sale),
+    })),
   ];
 }
 
@@ -408,7 +419,7 @@ export function pull(
   let paging = query.cursor === undefined ? undefined : sync.paging.get(query.cursor);
   if (query.cursor !== undefined) sync.paging.delete(query.cursor);
   if (!paging) {
-    const upserts = rowsOf(data, tenantId, device.branchId);
+    const upserts = rowsOf(data, tenantId, device);
     const rows: Rows = new Map(
       upserts.map((change) => [
         rowKey(change),
```

- **`rowsOf()` takes the device,** not only its branch: the `pos_sale` rows are the register it holds. They come last,
  in the order of `SYNC_ENTITIES`.
- **A return changes its sale's row** (what came back of a line), so the next delta pull sends it again, the way the
  API's 0056 logs the sale again with each return. A device that lets go of its register gets deletes for the rows it
  already cleared itself; deleting a row that is not there does nothing.

### `mocks/handlers.ts`: the routes

```diff
@@ -329,6 +329,13 @@ import {
   updateRegister,
   usedByPos,
 } from './pos-data';
+import {
+  findPosReturn,
+  listPosReturns,
+  registerSales,
+  returnableSale,
+  toPosReturn,
+} from './pos-return-data';
 import {
   closeWithoutCount,
   createCashReason,
@@ -5364,4 +5371,41 @@ export const handlers = [
       return reply(routes.posShifts.closeWithoutCount, toShift(data, target));
     }),
   ),
+
+  // Step 20c: the returns (pos-return-data.ts; push-data.ts writes them). A register's recent
+  // sales and a sale by its receipt number are the cashier's (pos.sale.create, pos.return.create);
+  // the list and the page need no permission, like the API. The mock's owner has all of them.
+  mock(
+    routes.posReturns.registerSales,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.posReturns.registerSales.params.parse(params);
+      const query = readQuery(routes.posReturns.registerSales.query, request);
+      await delay();
+      return reply(routes.posReturns.registerSales, registerSales(current(), id, query));
+    }),
+  ),
+
+  mock(
+    routes.posReturns.returnableSale,
+    guarded(async ({ params }) => {
+      const { number } = routes.posReturns.returnableSale.params.parse(params);
+      await delay();
+      return reply(routes.posReturns.returnableSale, returnableSale(current(), number));
+    }),
+  ),
+
+  mock(routes.posReturns.listReturns, async ({ request }) => {
+    const query = readQuery(routes.posReturns.listReturns.query, request);
+    await delay();
+    return reply(routes.posReturns.listReturns, listPosReturns(current(), query));
+  }),
+
+  mock(
+    routes.posReturns.getReturn,
+    guarded(({ params }) => {
+      const { id } = routes.posReturns.getReturn.params.parse(params);
+      const data = current();
+      return reply(routes.posReturns.getReturn, toPosReturn(data, findPosReturn(data, id)));
+    }),
+  ),
 ];
```

- **Four handlers, in the contract's order,** at the end of the list. `/pos/sales/by-number/:number` cannot be taken
  for `/pos/sales/:id`: MSW matches whole paths, and the sale's route has one segment less.
- **The list and the page need no permission,** like the API; the mock's person is the owner, who has the cashier's two
  permissions too.

### `mocks/offline-screens.ts`: the return offline

```diff
@@ -36,6 +36,9 @@ const SCREENS = [
   () => import('../components/pos-shift'),
   () => import('../components/pos-held'),
   () => import('../components/pos-shift-menu'),
+  // Step 20c: taking goods back works offline too, from the device's own sales (its refund rows
+  // come with the payment's chunk as well)
+  () => import('../components/pos-return'),
 ];
 
 // Once, by main.tsx's enableMocking. The dev server is on this computer, so it does not fail.
```

- **The return dialog is a chunk of its own,** loaded the first time F6 opens it. The offline test goes offline after
  the screen is open, so mock mode must have fetched it at start (step 19a's decision 11). Its refund rows come with the
  payment's chunk, which is in the list already.

### `e2e/pos-returns.e2e.ts` (new)

```ts
import type { Page, TestInfo } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 20c: taking goods back at the counter. The garments workspace's POS1 Showroom counter
// takes goods back for 7 days and makes exchanges through 2190 POS exchange clearing
// (src/mocks/pos-data.ts → seedPos). Each test opens POS1's first shift with ৳2,000 and sells
// first, so the receipt it takes back is its own. A crew-neck T-shirt is ৳368 with VAT.
//
// The receipt, the return slip and the X and Z reports print with window.print(): a counter on
// <body> instead of the print dialog, like pos.e2e.ts.

// Two sales, a return and a close each, while the mock copies 10,000 styles: 30 seconds is too
// tight on a busy machine
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {
      document.body.dataset.printed = String(Number(document.body.dataset.printed ?? '0') + 1);
    };
  });
  await page.goto('/');
  await waitForCopy(page);
});

function isPhone(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'phone';
}

async function expectPrinted(page: Page, times: number): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-printed', String(times));
}

// POS1, then its first shift: ৳2,000 from the owner
async function openShift(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'POS', exact: true }).click();
  await page.getByLabel('Register').selectOption({ label: 'POS1 · Showroom counter' });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await toastShown(page, 'This device is POS1 now. The next receipt is POS1-000001.');
  await page.getByText('As a total').click();
  await page.getByLabel('Cash in the drawer').fill('2000');
  await page.getByLabel('Brought in as').selectOption({ label: 'Float from the owner' });
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'Shift POS1-S0001 is open');
}

async function scanTshirt(page: Page): Promise<void> {
  const search = page.getByRole('searchbox', { name: 'Scan or search' });
  await search.fill('8941100500118');
  await search.press('Enter');
  await expect(search).toHaveValue('');
}

function payButton(page: Page, amount: string) {
  return page.getByRole('button', { name: `Pay ${amount}` }).filter({ visible: true });
}

// T-shirts for the exact amount in cash, then the next sale
async function sell(page: Page, count: number, amount: string, number: string): Promise<void> {
  for (let scanned = 0; scanned < count; scanned += 1) await scanTshirt(page);
  await payButton(page, amount).click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await pay.getByRole('button', { name: 'Exact amount' }).click();
  await pay.getByRole('button', { name: 'Complete sale' }).click();
  const done = page.getByRole('dialog', { name: `${number} is done` });
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(done).toBeHidden();
}

// F6, the receipt's number (in any case, like a scanner may send it), and the shirt ticked: the
// first tick takes one back
async function findAndTick(page: Page, number: string): Promise<void> {
  await page.keyboard.press('F6');
  const find = page.getByRole('dialog', { name: 'Take goods back' });
  await find.getByLabel('Receipt number').fill(number.toLowerCase());
  await find.getByRole('button', { name: 'Find the sale' }).click();
  const lines = page.getByRole('dialog', { name: `Return from ${number}` });
  await expect(lines).toContainText('Goods can come back until');
  await lines.getByRole('checkbox', { name: /^Take back Basic crew-neck T-shirt/ }).check();
}

function shiftMenu(page: Page) {
  return page.getByRole('button', { name: 'Shift POS1-S0001 menu' });
}

test('takes a shirt back for cash, prints the slip and the X and Z reports', async ({ page }) => {
  await openShift(page);
  await sell(page, 2, '৳736', 'POS1-000001');
  await expectPrinted(page, 1);

  // One of the two comes back: the line says what is left of it
  await findAndTick(page, 'POS1-000001');
  const lines = page.getByRole('dialog', { name: 'Return from POS1-000001' });
  await expect(lines).toContainText('2 of 2 pcs left to return');
  await lines.getByLabel('Why it came back').fill('Wrong size');
  await lines.getByRole('button', { name: 'Pay back ৳368' }).click();

  // The money goes back in cash, the whole of it
  const refund = page.getByRole('dialog', { name: 'Pay the money back' });
  await expect(refund).toContainText('Given back৳368');
  await refund.getByRole('button', { name: 'Complete return' }).click();
  const done = page.getByRole('dialog', { name: 'POS1-R000001 is done' });
  await expect(done).toContainText('Give back ৳368 in cash');
  await expectPrinted(page, 2);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(done).toBeHidden();

  // The same receipt again: one shirt is left of it
  await findAndTick(page, 'POS1-000001');
  await expect(page.getByRole('dialog', { name: 'Return from POS1-000001' })).toContainText(
    '1 of 2 pcs left to return',
  );
  await page.keyboard.press('Escape');

  // The X report, from the shift menu: blind, so no drawer total
  await shiftMenu(page).click();
  await page.getByRole('menuitem', { name: 'Print X report' }).click();
  await expectPrinted(page, 3);

  // ৳2,000 + ৳736 − ৳368 = ৳2,368, counted as it is; the Z report from the result
  await shiftMenu(page).click();
  await page.getByRole('menuitem', { name: 'Close shift' }).click();
  const close = page.getByRole('dialog', { name: 'Close shift POS1-S0001' });
  await close.getByText('As a total').click();
  await close.getByLabel('Cash in the drawer').fill('2368');
  await close.getByRole('button', { name: 'Close the shift' }).click();
  const result = page.getByRole('dialog', { name: 'POS1-S0001 is closed' });
  await expect(result).toContainText('DifferenceNo difference');
  await result.getByRole('button', { name: 'Print Z report' }).click();
  await expectPrinted(page, 4);
  await page.keyboard.press('Escape');

  // The managers' side: the return, its sale, and the shift's returns
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS returns');
  const row = listItem(page, /POS1-R000001/);
  await expect(row).toContainText('POS1-000001');
  await expect(row).toContainText('৳368');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-R000001' })).toBeVisible();
  await expect(page.getByText('Wrong size')).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-\d{4}$/ })).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('link', { name: 'POS1-000001' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-000001' })).toBeVisible();
  await expect(page.getByText('1 pcs came back')).toBeVisible();
  await expect(page.getByRole('link', { name: 'POS1-R000001' })).toBeVisible();

  await openFromNav(page, 'POS shifts');
  await listItem(page, /POS1-S0001/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-S0001' })).toBeVisible();
  await page.getByRole('link', { name: 'See the returns' }).click();
  await expect(page.getByText('The returns of shift POS1-S0001')).toBeVisible();
  await expect(listItem(page, /POS1-R000001/)).toBeVisible();
});

test('an exchange pays for a bigger sale, and dropping it asks first', async ({
  page,
}, testInfo) => {
  await openShift(page);
  await sell(page, 1, '৳368', 'POS1-000001');

  await findAndTick(page, 'POS1-000001');
  await page
    .getByRole('dialog', { name: 'Return from POS1-000001' })
    .getByRole('button', { name: 'Pay back ৳368' })
    .click();
  const refund = page.getByRole('dialog', { name: 'Pay the money back' });
  await refund.getByRole('button', { name: /^Exchange: use on a new sale/ }).click();
  await expect(refund).toBeHidden();

  // The cart starts with the return's money; on a phone it is a bar until opened
  if (isPhone(testInfo)) await page.getByRole('button', { name: /^0 items/ }).click();
  const cart = page.getByRole('complementary', { name: 'Cart' });
  await expect(cart).toContainText('Exchange from POS1-R000001');
  await expect(cart).toContainText('৳368 to spend on this sale');

  // Drop asks first; keeping it changes nothing
  await cart.getByRole('button', { name: 'Drop the exchange' }).click();
  const drop = page.getByRole('dialog', { name: 'Drop the exchange?' });
  await drop.getByRole('button', { name: 'Keep the exchange' }).click();
  await expect(cart).toContainText('Exchange from POS1-R000001');
  if (isPhone(testInfo)) await page.keyboard.press('Escape');

  // Two shirts for one: the return pays ৳368, cash the rest
  await scanTshirt(page);
  await scanTshirt(page);
  await payButton(page, '৳736').click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await expect(pay).toContainText('From return POS1-R000001');
  await pay.getByRole('button', { name: 'Exact amount' }).click();
  await expect(pay).toContainText('Paid৳736');
  await pay.getByRole('button', { name: 'Complete sale' }).click();
  const done = page.getByRole('dialog', { name: 'POS1-000002 is done' });
  await expect(done).toContainText('No change to give');
  // One print, both slips: the return's and the sale's (decision 76)
  await expectPrinted(page, 2);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(
    page
      .getByRole('link', { name: 'Sync: Online, All changes synced', exact: true })
      .filter({ visible: true }),
  ).toBeVisible();

  // The server has both, linked
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS returns');
  await expect(listItem(page, /POS1-R000001/)).toContainText('Exchanged for POS1-000002');
  await openFromNav(page, 'POS sales');
  await listItem(page, /POS1-000002/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-000002' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'From return POS1-R000001' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('takes back offline a sale made offline, and both sync later', async ({ page, context }) => {
  await openShift(page);
  await context.setOffline(true);
  await expect(
    page.getByRole('link', { name: /^Sync: Offline/ }).filter({ visible: true }),
  ).toBeVisible();

  // The sale is still in the outbox: the return finds it on the device
  await sell(page, 1, '৳368', 'POS1-000001');
  await findAndTick(page, 'POS1-000001');
  await page
    .getByRole('dialog', { name: 'Return from POS1-000001' })
    .getByRole('button', { name: 'Pay back ৳368' })
    .click();
  await page
    .getByRole('dialog', { name: 'Pay the money back' })
    .getByRole('button', { name: 'Complete return' })
    .click();
  const done = page.getByRole('dialog', { name: 'POS1-R000001 is done' });
  await expect(done).toContainText('Give back ৳368 in cash');
  await expect(done).toContainText('Saved on this device');
  await done.getByRole('button', { name: 'New sale' }).click();

  // Back online, the sale goes first, then its return
  await context.setOffline(false);
  await expect(
    page
      .getByRole('link', { name: 'Sync: Online, All changes synced', exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS returns');
  await expect(listItem(page, /POS1-R000001/)).toContainText('POS1-000001');
});

test('a register takes goods back for its own days, with or without exchanges', async ({
  page,
}) => {
  await openFromNav(page, 'POS registers');
  await listItem(page, /POS1/).click();
  const edit = page.getByRole('dialog', { name: 'Edit POS1' });
  await expect(edit.getByLabel('Returns allowed for (days)')).toHaveValue('7');
  await expect(edit.getByLabel('Exchange account')).toHaveValue(/.+/);

  // Whole days only
  await edit.getByLabel('Returns allowed for (days)').fill('7.5');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    edit.getByText('Type whole days from 0 to 365, like 7. 0 means the same day only.'),
  ).toBeVisible();

  // 14 days, and no exchanges: refunds only
  await edit.getByLabel('Returns allowed for (days)').fill('14');
  await edit.getByLabel('Exchange account').selectOption({ label: 'No exchanges: refunds only' });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, /saved/);
  await listItem(page, /POS1/).click();
  await expect(edit.getByLabel('Returns allowed for (days)')).toHaveValue('14');
  await expect(edit.getByLabel('Exchange account')).toHaveValue('');
  await expectNoSideScroll(page);
});
```

- **Each test sells first and takes back its own receipt** (decision 99), so it needs nothing in the seed but POS1 and
  its exchange account.
- **The receipt number is typed in lower case:** the route's schema and the screen both upper-case it, so a hand-typed
  or scanned "pos1-000001" is found.
- **"Takes a shirt back for cash…"** follows the money: ৳2,000 + ৳736 − ৳368 = ৳2,368 counted with no difference, which
  is only true if the cash refund left the drawer's sum. The second find of the same receipt says "1 of 2 pcs left": that
  line is what found decision 98. The print counter checks the sale's receipt, the return slip, the X report and the Z
  report, one each.
- **"An exchange pays for a bigger sale…"** checks that Drop asks first and that keeping it changes nothing, then one
  print for both slips (decision 76) and the link both ways on the server's pages. It waits for "All changes synced"
  before it leaves the POS: the sale waits for its return in the outbox, so the two reach the server one push apart.
- **"Takes back offline a sale made offline…"** is the whole offline path: the sale is still in the outbox, the return
  finds it on the device, and both go in their order once the connection is back.
- **"A register takes goods back for its own days…"** opens POS1's form on a fresh page: the test that found decision
  96. "7.5" shows the contract's message under the box.

### Check this part

```bash
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/sync test
cd apps/app && npx tsc --noEmit -p . && npx tsc --noEmit -p e2e
pnpm exec eslint apps/app/src/mocks apps/app/src/components apps/app/src/routes apps/app/e2e packages/sync/src packages/ui/src/components/logo.tsx
pnpm exec prettier --check apps/app/src apps/app/e2e packages/sync/src packages/ui/src
pnpm --filter @omnivo/app test
cd apps/app && npx playwright test -c e2e/playwright.config.ts e2e/pos-returns.e2e.ts e2e/pos.e2e.ts e2e/pos-shifts.e2e.ts --workers=2
cd apps/app && npx vite build && node scripts/check-bundle-size.ts
pnpm boundaries
```

All pass: sync 115 tests, app 203, no dependency violations. The POS browser tests pass on the desktop and the phone:
the new file 24 of 24 three times over (`--repeat-each=3`), `pos.e2e.ts` and `pos-shifts.e2e.ts` 18 of 18. The related
files (sync, outbox, devices, device PIN, journal, accounts, reports, notifications, onboarding, stock, settings) pass
too, 103 of 103. The bundle stays at 224.8 KB of 225 for the first load; the return dialog's own chunk grew by 0.03 KB
(the lock), 133.6 KB of 135 counted with the POS screen it loads from.

> **What was checked while building it.** `withWaitingReturns()`'s `sent` filter was taken out on purpose: the new sync
> test failed, and passed again with the file copied back. Before the fixes, the phone run of `pos.e2e.ts` and
> `pos-shifts.e2e.ts` failed 4 of 9 (the bar), the second find failed in most runs (decision 98), and the register
> test failed on its first run (decision 96). Not checked in this part: the full browser suite, the integration
> and tenant-leak suites and the installed app's offline test; they run once in 20c.8.

## 20c.8 — The real API, and every check once

This part changes no code. No API route, table, permission or role template changes here.

### The return against the real API

The e2e tests take goods back against the mock API, and the integration tests send the return's command without a
browser. So once, the whole path ran in a real browser (Chromium, driven by a Playwright script that is not part of the
guide) against the real API, as in 20b.8: a production build of this guide's code with `VITE_API_URL` set to the API,
served by `vite preview`, the API and the worker built from this guide's code, and a throwaway Postgres and Valkey on
other ports. "No connection" meant three things at once: the API stopped, the preview server stopped, and the browser
set offline. The script:

1. **Set-up through the API:** a retail workspace, "Mango juice 250 ml" (৳25 before VAT, ৳28.75 with it, a barcode, 50 in
   stock at ৳15), a register typed as `pos1` with a cash account, the template's 5350 for over and short, the template's
   2190 "POS exchange clearing" as its exchange account and 7 return days, and the reason "Float from the safe".
2. **The first shift:** `/pos` ("Not now" to the PIN), POS1, and ৳2,000 as a total, brought in as the float.
3. **A return online:** two juices for the exact amount (POS1-000001). F6, the receipt's number, one juice ticked,
   "Wrong flavour", "Pay back ৳28.75", cash, Complete return: "POS1-R000001 is done", "Give back ৳28.75 in cash", and
   the slip printed. The server has it inside the window: 25 + 3.75 = 28.75, and its entry is Sales returns 4120 Dr 25,
   Output VAT 2120 Dr 3.75, cash 1110 Cr 28.75, Inventory 1150 Dr 15, Cost of goods sold 5110 Cr 15. 49 juices on hand.
4. **Offline:** one juice (POS1-000002), then F6 with its number: the device found the sale in its own outbox. "Pay
   back", then "Exchange: use on a new sale": the cart said "Exchange from POS1-R000002"; two juices, and the pay
   dialog's first row was "From return POS1-R000002"; Exact amount, Complete sale. "POS1-000003 is done" said "Saved on
   this device", one print had both slips, and the sync line said 3 changes waiting.
5. **Back online,** the three went in their order. The exchange payment of POS1-000003 names POS1-R000002 (৳28.75); the
   return's entry credits 2190 instead of the cash, and 2190 is back at zero. 47 juices on hand (50 − 2 + 1 − 1 + 1 − 2).
6. **The X report** printed from the shift menu. `pos_shift_cash()` said 2,000 + 115 taken − 0 change − 28.75 paid back
   in cash = 2,086.25: the exchange never touched the cash.
7. **The close at ৳2,086.25:** "No difference", and the server stored the same 2,086.25 as expected (no
   `pos_shift.expected_differs` row). The Z report printed from the result.
8. **The managers' pages:** "Leave the POS", POS returns: "Exchanged for POS1-000003" on the second return; the first
   return's page had "Wrong flavour", and its sale's page "1 pcs came back". The audit log had one
   `pos_return.created` row per return and nothing else (no return outside the window, over what was left, or with
   other amounts).

No page error, and no failed request.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

Everything passed, some only on a second run:

- `pnpm test:integration`: 6 of the 40 files (sales documents, reports, suppliers, goods receipts, requisitions,
  invitations) failed in their `beforeAll`: "Hook timed out in 120000ms", the Postgres and Valkey containers did not
  start in time while the machine was busy (load 26). The other 526 tests passed. Run again on their own, the 6 files
  passed (112 tests): 638 in all. None of them is a file this step changed. The POS and sync suites alone, as 20c.4
  runs them, pass 183 of 183.
- `pnpm test:e2e`: 342 passed, 1 skipped and 3 failed: quotations and sales orders on the desktop (a status radio did
  not change) and a journal test on the phone (a timeout). Run again, the journal test passed and the other two failed
  again; in three more runs each, quotations passed and sales orders failed once. The trace shows why, and it is not this step: "Set a PIN for this device" (19b) opens by
  itself when the device's copy is ready, and in these tests it opened in the middle of a click. Its backdrop took the
  click, and the helper that closes the dialog then closed the customer popover too. The POS tests wait for the copy
  first (`waitForCopy()`) and never meet it. See the notes at the end.
- `pnpm test:e2e:pwa`: 4 passed.
- `pnpm dedupe --check` **fails, for a reason outside this guide.** The lockfile is the same as in your repo (it has not
  changed since 19b), but since 20b.8's run the authors of `@smithy/core` 3.35.0 (a package `@aws-sdk/client-s3` uses)
  marked it deprecated, "due to a bug in custom logger data redaction". `pnpm dedupe` would add that one
  `deprecated:` line to `pnpm-lock.yaml` and change no version. It fails in your repo the same way (checked). Run `pnpm dedupe`
  to take the line, or update `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (3.1161.0 uses a later
  `@smithy/core`, 3.38.1 is out); this guide does neither.

Everything else passed at the first run: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (833: contracts
350, app 203, api 123, sync 115, ui 19, i18n 15, auth 8), `pnpm build`, `pnpm test:bundle-size` (first load 224.8 KB of
225; the return dialog 133.6, the payment 130.0 and the held bills 125.4 of 135, the POS screen 121.4; the worker's
list 431 files, 1440.4 KB gz), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:tenant-leak` (125).

---

## 20c.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components":

In **POS screen (`/pos`)**, change "With a shift open, the bar also has the shift's button (…so the bar fits 390px)."
by adding after it:

> Then "Return" (secondary `sm`, `ArrowTurnBackward`, with its `F6` key; on a phone the icon alone).

and in the same entry change "Keys: F2 search, F4 customer, F7 bill discount, F8 hold, F9 held bills, F12 pay, Enter
complete and new sale, `?` the shortcuts dialog." to:

> Keys: F2 search, F4 customer, F6 return, F7 bill discount, F8 hold, F9 held bills, F12 pay, Enter complete and new
> sale, `?` the shortcuts dialog.

In **Thermal receipt**, after "a sale's page prints it again from a button.", add:

> The return slip ("Return of POS1-000164", what came back, "Given back", and "Used on sale POS1-000188" for an
> exchange) and the X and Z reports use the same sheet. An exchange prints its slip and the new sale's receipt in one
> print, the slip first.

In **POS registers (Settings)**, change "and a "Shifts" group: … and "Lock the POS after"." by adding after it:

> Then a "Returns" group: "Returns allowed for (days)" (whole days 0–365, 7 by default, 0 = the same day only) and the
> exchange account (an active liability, not a group; empty = "No exchanges: refunds only").

After **POS cash reasons (Settings, after POS registers)**, add these entries:

> - **POS return (`/pos`, F6):** a dialog in three steps, inside a shift only. "Take goods back": the receipt number
>   (any case, a scanner's too) and "Find the sale"; offline a neutral document notice (`WifiDisconnected02`) says the
>   device finds only this register's sales of the last 30 days. "Return from POS1-000164": "Goods can come back until
>   30 Sep 2026.", the lines in a 1px `line` box, each a checkbox ("Take back …"), "2 of 3 pcs left to return" in 12px
>   `ink-3`, the amount on the right, and once ticked a quantity stepper (in the sale line's unit) or serial ticks; a
>   line that all came back is a `subtle` row, "All of it came back". "Why it came back (optional)", the money back on
>   `subtle` at the KPI size, "Pay back ৳368" (primary). "Pay the money back": refund rows like the pay dialog's (cash
>   first, then the ways the sale was paid that the register takes), Still to give back / Given back on `subtle`, then
>   the exchange as a button row (`brand-soft` `ArrowLeftRight` tile, "Exchange: use on a new sale", its hint, an
>   `ArrowRight01`), Back (secondary, pushed left) and "Complete return" (primary). Then "POS1-R000012 is done": the
>   40px `good-bg` tile, "Give back ৳368 in cash" at the KPI size (or "No cash to give back"), "Saved on this device…"
>   offline, "Print again" and "New sale" (primary, with the focus). The slip prints by itself.
> - **Exchange in the cart:** a `brand-soft` box with a 1px `brand-line` border at the top of the cart
>   (`ArrowLeftRight`, "Exchange from POS1-R000012", "৳368 to spend on this sale" in 13px `ink-2`, a "Drop the exchange"
>   text link that asks first: "Keep the exchange" / "Drop the exchange"). In the pay dialog, a fixed first row (the
>   method's name and the amount read-only on `subtle`, "From return POS1-R000012"); a sale smaller than the return has a
>   neutral document notice ("৳120 of the return is left over…") and "Paid back by" rows for the rest. The return and
>   the sale are saved together at "Complete sale"; the close waits until the exchange is completed or dropped.
> - **X and Z reports:** "Print X report" (`Printer`) in the shift menu before Close shift, offline too, and "Print Z
>   report" (secondary, `Printer`) on the close's result and a closed shift's page. The thermal sheet: register, shift,
>   cashier, opened (and closed), sales and returns with their counts, sold, given back, taken in the end, discounts,
>   VAT on sales and on returns, what each method took and paid back, paid in and out. The X report is blind: no drawer
>   total, and a line that says the count at the close shows it. The Z report adds the drawer (expected, counted,
>   difference), or "Closed without a count…".
> - **POS return statuses:** Posted (`good`, `CheckmarkCircle02`), plus After the window (`warn`, `Hourglass`) when it
>   came after the register's days (the books took it, the audit log has it) and "Exchanged for POS1-000188" (neutral,
>   `ArrowLeftRight`).
> - **POS returns (Sales, after POS sales, everyone):** a data table like POS sales (number in `Geist Mono`, date, sale,
>   register, customer, cashier, given back, status) with the register select; from a shift's page "See the returns"
>   opens it filtered, "The returns of shift POS1-S0042" with a "Show every return" text link. A return's page: the
>   page header with "Print return slip" (secondary, `Printer`), its facts (sale, sold on, shift, taken back at,
>   device, cashier, customer, why), the lines (the batch it went back into, its serial numbers), what was paid back
>   (an exchange says "Used on POS1-000188" as a link) and its journal entry. A neutral document notice when it came
>   after the window or its day was closed in the books. A sale's page says per line "1 pcs came back", lists its
>   returns, and its exchange payment links "From return POS1-R000012". A shift's page has "Cash paid back" in the
>   drawer's sum, the sales' discounts and VAT, and a refunds card (count, VAT on returns, per method).

In **Sync page (`/sync`)**, after "A shift's open and close are named by the shift's number, a pay in or out by its
sentence; none shows an amount.", add:

> A return is "Return POS1-R000012" with its line count under it ("2 lines"), and no amount.

**docs/system-design.bn.md** — in ৩ (মডিউল), under **৬. POS**, change "হোল্ড/রিজিউম বিল, রিটার্ন" to:

> - হোল্ড/রিজিউম বিল (ধাপ ২০b)
> - রিসিট নম্বর দিয়ে রিটার্ন, অফলাইনেও (register-এর ৩০ দিনের বিক্রি ডিভাইসে); ক্যাশে বা যেভাবে দিয়েছিল সেভাবে
>   টাকা ফেরত, বা এক ধাপে এক্সচেঞ্জ (ফেরতের টাকায় নতুন বিক্রি); X ও Z শিফট রিপোর্ট থার্মাল কাগজে (ধাপ ২০c)

and in ৭.৪, after the row "ক্যাশ ড্রয়ারের হিসাব", add:

> | **একই রিসিটের ফেরত দুই কাউন্টারে** (বা যতটা বিক্রি হয়েছিল তার বেশি) | ধাপ ২০c: রিটার্ন নিজের ডকুমেন্ট (`POS1-R000012`), বিক্রি কখনো বদলায় না। স্ক্রিন যতটা বাকি তার বেশি নিতে দেয় না (ডিভাইসের না-পাঠানো রিটার্নও গোনে), কিন্তু সার্ভার অফলাইনের কাজ কখনো refuse করে না: বিক্রিটা `FOR UPDATE` করে একটার পর একটা লেখে, বেশি হলে বা window পার হলে post করে audit log-এ রাখে। টাকা লাইনের ভাগে (paisa পর্যন্ত), লাইনের শেষ রিটার্ন বাকিটা নেয়, তাই সব রিটার্ন মিলে লাইনের সমান |

**docs/build-plan.bn.md** — under "ধাপ ২০: POS স্ক্রিন", after the "শিফট (২০b)" bullet, add:

> - **রিটার্ন (২০c):** রিসিট নম্বর দিয়ে ফেরত (F6), অফলাইনেও; যতটা বিক্রি হয়েছিল তার বেশি না, বিক্রির দামে (লাইনের
>   ছাড় আর VAT-এর ভাগ সহ)। নিজস্ব `pos_returns` ডকুমেন্ট (`POS1-R000012`), মাল register-এর warehouse-এ ফেরত, টাকা
>   ক্যাশে বা যেভাবে দিয়েছিল, বা এক্সচেঞ্জ (register-এর exchange account দিয়ে নতুন বিক্রির পেমেন্ট, একসাথে save)।
>   register-এর return window (ডিফল্ট ৭ দিন; স্ক্রিন থামায়, সার্ভার audit করে)। X রিপোর্ট (blind, শিফটের মাঝে) আর Z
>   রিপোর্ট (close-এর পরে) থার্মাল কাগজে। Sales → POS returns (তালিকা, রিটার্নের পাতা)।

and in section ৯ (অগ্রগতি), tick step 20 — this is its last part:

> - [x] **ধাপ ২০** — POS স্ক্রিন

**COMMANDS.md** — no change: this step adds no command.

---

## 20c.10 — Run it

```bash
pnpm db:migrate       # 0055 + 0056: the returns, their lines, batches and refunds, the exchange and their rules
pnpm dev
```

No new package, no new environment variable. The sync protocol is 4: every device does one full pull after the update
(decision 24). New retail workspaces get "2190 POS exchange clearing" and the new
permission in their Cashier and Shop manager roles; in an existing workspace, add a current liability account for the
exchange and give `pos.return.create` in Settings → Roles.

### What you will see

1. **The register's return settings:** Settings → POS registers → your register. The "Returns" group says 7 days; pick
   the exchange account (empty means refunds only).
2. **A return for cash:** POS, open a shift, sell two of something for cash. Return (F6), type the receipt's number,
   tick the line (one comes back), "Wrong size", "Pay back". Cash is already the whole amount: Complete return. The
   slip prints, and "Give back ৳… in cash".
3. **The same receipt again:** F6 and the same number: "1 of 2 pcs left to return". Escape.
4. **An exchange:** take the other one back, then "Exchange: use on a new sale". The cart starts with the return's
   money; add something dearer, Pay: the first row is "From return POS1-R000002", Exact amount, Complete sale. One print,
   the slip and the receipt.
5. **A smaller exchange:** the same with something cheaper: the pay dialog says what is left over and asks how it goes
   back.
6. **Offline:** DevTools → Network → Offline. Sell, then take it back at once: the device finds the sale in its outbox.
   The Sync page lists "Return POS1-R000004" (1 line) after its sale; online again, they go in that order.
7. **The X report:** Shift menu → Print X report. It has the sales, the returns and what each method paid back, and no
   drawer total.
8. **The close and the Z report:** close the shift with what should be there (the cash refunds are out of it): "No
   difference". Print Z report. Sales → POS shifts → the shift: "Cash paid back", the refunds card, "See the returns"
   and "Print Z report".
9. **The managers' pages:** Sales → POS returns → a return: its lines, what was paid back, the journal entry (Sales
   returns and VAT Dr, cash Cr; stock back at its cost). Its sale's page says "1 pcs came back". The exchange's return
   says "Exchanged for …", and the sale's payment links back. The 2190 account's balance is zero.
10. **The window:** set the register's days to 0 and take back a sale of yesterday: the screen says it is too old.
11. **Bangla** and **390px:** the three return steps, the exchange banner and the pay row in Bangla, and the POS bar
    with the Return button fits a phone.

---

## Checklist

```bash
pnpm dedupe --check           # fails on @smithy/core's deprecation note, not this step (see 20c.8)
pnpm lint                    # 6 GB heap for ESLint (19b decision 53)
pnpm format
pnpm typecheck
pnpm test                    # 833: contracts 350 + app 203 + api 123 + sync 115 + ui 19 + i18n 15 + auth 8
pnpm test:integration        # 638
pnpm test:tenant-leak        # 125
pnpm test:e2e                # 346: 173 flows × desktop and 390px (the sort test is skipped on the phone)
pnpm test:e2e:pwa            # 4: unchanged from 19b
pnpm build
pnpm test:bundle-size        # first load 224.8 KB gz (budget 225); the return dialog 133.6, the payment 130.0 (135); the worker's list 431 files, 1440.4 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **A return of one shirt of two came to ৳420.01, and the other to ৳419.99** (20c.6a): `posReturnAmounts()` rounded the
  net and the VAT apart. It now shares the total and the VAT, and the net is the rest (decision 65).
- **A sale still in the outbox could not be returned** (20c.6a): the server made a sale's line ids, so the device did
  not know them until the sale was synced. The device makes them now (decision 64), and the API and its tests use them.
- **The register form opened before its account lists** (20c.7): the exchange and over/short selects came up empty, so
  saving cleared them. The form waits for the accounts too (decision 96).
- **The POS bar was wider than a phone** (20c.7): the Return button made it 437px, and every phone POS test failed.
  On a phone the logo shows its mark alone (`Logo markOnPhone`, decision 97).
- **A second return of a receipt counted the first one twice** (20c.7): online, the server's sale already had the
  first return, and the device added it again from its outbox. It adds only the returns never sent, inside the sync
  lock (decision 98).

---

## Notes left for later steps

**Step 21 (reports):**

- **Day and branch summaries of the counters** wait for the reports (decision D): the X and Z reports are one shift's.
  `pos_returns` and the shift's `cash_refunded` have what a day's summary needs.
- **The sales returns account** is the 15d tenant setting, else Sales: a sales report that splits counter returns
  from invoice returns reads the journal source (`pos_return` or `sales_return`).

**Later:**

- **The PIN dialog can open in the middle of a browser test** (seen in 20c.8, since 19b): "Set a PIN for this device"
  opens when the device's copy is ready, and a test that does not wait for the copy (`waitForCopy()`) may be clicking
  then. The quotations and sales orders list tests failed this way about one run in three. Either those tests wait for
  the copy, like the POS tests, or the mock's seeded e2e device already has its PIN question answered.
- **Damaged goods** come back into the register's warehouse like any other (decision 3); take them out with a stock
  adjustment. A "damaged" box on the return line could do that in one step.
- **A return of another register's sale online** goes into this register's warehouse and drawer; offline the device
  finds only its own register's sales of the last 30 days.
- **The shell's sign-out race of 20b's notes** still stands; a return saved the moment before the sign-out is in the
  outbox and is asked about like any change.
