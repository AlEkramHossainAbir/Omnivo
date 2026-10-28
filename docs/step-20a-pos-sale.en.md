# Step 20a: The POS, part 1 — a sale at the counter

> The implementation guide for "Phase 6 → Step 20", the first of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 20 (the POS screen) is split into three guides: this
> one (registers, receipt numbers, the sale screen, payment, posting and the thermal receipt), 20b (shifts, the cash
> count, pay in and pay out, held bills, the idle lock) and 20c (returns, refunds and the shift reports).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `2d7ccec`, your commit named
> "checklist updated": 19b's code, its doc updates and the checklist) and checked from 2026-10-27 to 2026-10-28:
> `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (761 — 39 new), `pnpm
> test:integration` (590 — 31 new), `pnpm test:tenant-leak` (118 — 6 new), `pnpm build`, `pnpm test:bundle-size`
> (first load 218.3 KB gz, budget 220; the POS screen with its payment 113.4 KB, budget 115; the worker's list 412
> files, 1382.4 KB gz, budget 2 MB), `pnpm test:openapi`, `pnpm boundaries`, `pnpm test:e2e` (Playwright on the
> mocks, 328 — 8 new) and `pnpm test:e2e:pwa` (the worker on a production build, 4) — with the turbo cache bypassed
> (`--force`).
>
> Also checked:
>
> - **The database's rules on Postgres** (20a.2): 69 SQL checks (row-level security, the register let go on a revoke
>   or a move, the last number, sales that never change, the checks at commit, a movement below zero only for a POS
>   sale) and 4 races in two sessions (a claim and a revoke, and a claim and a move of the register's warehouse, each
>   in both orders).
> - **The posting through the API** (20a.3, 20a.4): a smoke run of the claim and a sale before the tests were written,
>   then the tests: two devices claiming one register at once, a sale that goes below zero, each refusal keeping the
>   number, a command sent twice, and two pushes of one register at the same moment.
> - **The counter in the mock app** (20a.7): an offline sale on both screen sizes, then broken on purpose twice, one
>   at a time: the payment's chunk left out of the offline list, and the stock that ignores the device's own sales.
> - **The counter against the real API in a browser** (20a.8): the claim, a scanned sale with its journal entry and
>   its FEFO batch, an offline split sale, a sale that went below zero, the bell and the Sold short list, and the
>   register let go at sign-out.

## Goal

🧾 **Selling at the counter, with or without a connection.** After step 19, a shop can read its products, prices and
stock offline, and save customers and order drafts, but it cannot sell. This step adds the point of sale: a screen
where a cashier scans items, takes the money (cash, card, bKash, Nagad, or a mix), and prints a receipt on a thermal
printer, in a few seconds and without a mouse.

After this step:

- **A register is a counter.** Someone with `pos.register.manage` adds "POS1 · Front counter": the warehouse its goods
  leave from, an account for each way of paying, the most a cashier may take off, and the receipt's paper width and
  footer.
- **A device takes a register,** and gives every sale the register's next number itself: `POS1-000123`. Only one device
  holds a register at a time, so a number is never used twice. The device lets go when its person signs out.
- **The POS screen (`/pos`)** fills the whole window: search and scan on the left, the cart on the right, keyboard
  shortcuts for everything. A walk-in customer is the default; a customer can be picked from the device's copy.
- **A sale is paid in full at the counter.** Cash with change, a card, bKash or Nagad, or a split. Line and bill
  discounts up to the register's limit; more, or a changed price, needs `pos.price.override`.
- **The receipt prints at once,** on 58 mm or 80 mm paper, through the browser's print, offline too.
- **The server posts the sale when it arrives:** one journal entry (the money, the sale, the VAT, the cost) and the
  stock. It never refuses a sale for stock. What was sold without stock goes below zero and onto a "Sold short" list,
  and the people who adjust stock get a bell.

## The whole picture

```
packages/contracts   pos.ts: registers (code, warehouse, an account per method, discount limit, paper, footer,
      │               the device that holds it, the last number) · claim / release · formatPosNumber() ·
      │               posSaleAmounts() (the bill discount shared over the lines) · posOverridesOf() · the sale's
      │               input and the posted sale · the "Sold short" list
      │               sync.ts: protocol 2, the pos_register rows, the pos_sale.create command
      │               3 permissions (pos.sale.create, pos.price.override, pos.register.manage) · 18 errors ·
      │               the pos_sale journal source and movement kind · pos.sold_short bell
      ▼
packages/db          pos_registers, pos_sales + lines + payments (20a.2)
      ▼
apps/api             registers, claim / release · the push posts a POS sale (journal + stock, below zero
      │               allowed) · sold short + bell · the sales list (20a.3)
      ▼
packages/sync        the registers on the device · the sale in the outbox · the numbers (20a.6)
      ▼
apps/app             /pos: the screen, the cart, payment, the receipt · Settings → Registers · POS sales ·
                      Sold short (20a.6)

one cashier at a pharmacy in Dhanmondi, the line down since the morning:
  the device holds POS1 (claimed yesterday, online: the server's last number was 122)
  scans Napa 500 mg ×10 strips, Seclo 20 ×1 box ──► the prices from the device's copy, the batch by FEFO
  F12 Pay ──► ৳1,180 · bKash ৳1,000 (TrxID BK7XQ2M4) + cash ৳500 ──► change ৳320
  outbox: pos_sale.create {saleId (UUIDv7), registerId, sequence 123, lines, payments}
  the receipt prints: "POS1-000123", the lines, VAT, paid, change
  ... 40 more sales, POS1-000124 to POS1-000163, all on the device
  the line is back ──POST /sync/push──► one command at a time:
     pos_sale.create ──► the number free? the sale is posted:
        Dr bKash wallet 1,000 · Dr Cash at counter 180 · Cr Sales · Cr VAT payable
        Dr Cost of goods sold / Cr Inventory, at the moving average
        Seclo 20 had 0 boxes left on the server ──► stock goes to −1, the line is "sold short"
     the register's last number becomes 163
  the store manager's bell: "POS1-000123 sold 1 item short in Main store"
  the cashier signs out ──► the outbox is empty, so the device lets go of POS1
  the next cashier signs in on the same PC ──► takes POS1, goes on from 164
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Shifts, the cash count, pay in and pay out, held bills, the idle lock | 20b (decisions 1, 9, 10) |
| Returns, refunds and the shift reports | 20c (decisions 1, 8) |
| Selling on credit at the counter | A credit sale needs the customer's balance and limit, which only the server knows (step 18b, decision 15). Credit sales stay on invoices (decision 5) |
| ESC/POS commands, a USB or Bluetooth printer driver in the app | Browser print works with any printer driver, offline, in every browser (decision 6) |
| A camera barcode scanner | USB and Bluetooth scanners type like a keyboard and already work. A camera needs a library and a permission |
| Two cashiers on one device at the same time | One device is one person (step 18a); a cashier change is a sign-out and a sign-in (decision 4) |
| The NBR's electronic fiscal device (EFD / SDC) | Its rules and its devices are a project of their own |
| Loyalty points, gift vouchers, a customer display | Not in the step 20 decisions |

## What changes in the code you already have

- **The contract (20a.1):** `packages/contracts` gets `pos.ts` (registers, claim and release, the number's format,
  the sale's arithmetic, what needs an override, the sale's input, the posted sale and the "Sold short" list). `sync.ts`
  moves to protocol 2, with the `pos_register` rows and the `pos_sale.create` command. Three permissions, 18 error
  codes, the audit actions, the `pos.sold_short` bell, the `pos_sale` journal source and movement kind, and the routes.
  `discountSchema` (`sales.ts`) and `TAX_RATE_FORMAT` (`tax-rates.ts`) become public. `openapi.json` is generated
  again.
- **The database (20a.2):** five new tables in `schema/pos.ts` (`pos_registers`, `pos_sales`, `pos_sale_lines`,
  `pos_sale_line_batches`, `pos_sale_payments`). A journal entry may point at a sale. Migration 0051 is generated;
  0052 holds the rules: row-level security, the database letting go of a register on a revoke or a move, the last
  number, sales that never change, the checks at commit, and only a POS sale's movements going below zero.
- **The server (20a.3):** a new `pos` module (registers with claim and release, the sale's posting, the sold-short
  bell, the lists). The stock posting learns to plan a sale that may go below zero (`planSale`, `belowZero`), the
  stock books post a sale and its cost in one entry, and the period lock finds the first open day. The push takes the
  sale command, the pull sends the registers, and three services that refuse a delete know the new foreign keys. The
  retail templates get a Shop manager and a Cashier.
- **The tests (20a.4):** `pos.int.spec.ts` (31) and `pos.tenant-leak.int.spec.ts` (6). The sync suites read the
  protocol from the contract instead of writing `'1'`.
- **The words (20a.5):** `en.ts` and `bn.ts` only.
- **The device and the screen (20a.6a):** `packages/sync` moves to database version 4 (the registers and the claim)
  and gets `pos.ts` (the claim, the number, the sale's save, the stock and barcode reads). The app gets `/pos` outside
  the shell, the cart, the payment, the done dialog and the thermal receipt. Signing out lets go of the register first.
  The Sync page names a sale and never offers to edit one. The bundle budgets become 220 KB and 115 KB.
- **The pages (20a.6b):** Settings → POS registers, the POS sales list and a sale's page (with the receipt printed
  again), the Sold short list under Stock, and the bell's link to it.
- **The mock API and the e2e tests (20a.7):** the mock server sells too (`mocks/pos-data.ts`), and `e2e/pos.e2e.ts`
  has 4 tests on both screen sizes. The screen counts the device's own unsynced sales against the stock (decision 78).
- **The finish (20a.8):** no code. The counter runs once against the real API in a browser, and every check runs
  once.
- **Not touched:** `packages/ui`, `packages/auth`, the service worker (`apps/app/sw/`), the sign-in and the device
  set-up, and every document of steps 15 to 17.

## The decisions behind this step

You made the first fifteen: decisions 1–12 on 2026-10-27 for the whole of step 20, and 13–15 on 2026-10-27 for this
guide. The others came up while building it; please read them with care: they are mine.

1. **Three guides.** (You chose this.) 20a: registers, the number series, the POS screen, the cart, split payment, the
   offline sale command, posting and the thermal receipt. 20b: shifts, the cash count, pay in and pay out, held bills
   and the idle lock. 20c: returns, refunds and the shift reports.
2. **A POS sale is its own document.** (You chose this.) Lines and payments in one document, `pos_sales`, with its own
   journal entry and its own stock movements when it is posted. Not an invoice, a challan and a money receipt: three
   documents and three numbers for one bottle of oil, and a challan and an invoice cannot be made on a device.
3. **A number series per register.** (You chose this.) A register (a counter) is a new master: a code (POS1), a branch
   and a warehouse. A device works on one register and gives the next number itself (`POS1-000123`), unique per
   register. The server knows each register's last number, so another device on the same counter carries on the
   series.
4. **A cashier change is a sign-out and a sign-in.** (You chose this.) One device is one person (steps 18 and 19).
   Sales must sync before a sign-out; the existing "Sign out and lose the changes?" dialog covers it.
5. **The customer is optional, and the whole amount is paid now.** (You chose this.) A walk-in customer by default, or
   one picked from the device's copy. Cash, card, bKash, Nagad, a split, and change given in cash. Each register has
   an account per method. Credit sales stay on invoices.
6. **The receipt prints through the browser.** (You chose this.) `window.print()` with an `@page` of 58 mm or 80 mm,
   like the print layout of step 15c. It works with any printer driver, offline, in every browser. Chrome's
   `--kiosk-printing` skips the print dialog, and the printer driver's "open the drawer" setting opens the cash
   drawer. No new dependency, no ESC/POS.
7. **A sale is never refused for stock.** (You chose this.) When it arrives and the stock is not there, the stock goes
   below zero, the people who adjust stock get a bell, and the line is on a "Sold short" list. While selling, the
   screen checks the device's copy and stops the sale when the workspace does not allow negative stock.
8. **(20c) Returns by receipt number,** offline too: online any register's receipt, offline the last 30 days of this
   register kept on the device.
9. **(20b) The shift close counts the cash** by notes or as a total; the difference posts to a "Cash over/short"
   account. Pay in and pay out with a reason, offline too.
10. **(20b) A held bill stays on the device only,** sealed, never sent, and holds no stock.
11. **Discounts up to the register's limit.** (You chose this.) A line discount and a bill discount, in % or ৳. More
    than the register's limit, or a changed price, needs `pos.price.override`. Offline the device checks with the
    permissions it has; the server checks again and writes it to the audit log, but never refuses the sale for it.
12. **The screen.** (You chose this.) `/pos` fills the window inside `AppFrame` (so the lock and the sync keep
    working), outside the shell: a slim top bar, search and the product grid on the left, the cart on the right, and
    on a phone the cart as a bar at the bottom. Its own lazy chunk. Keyboard shortcuts (F2 search, F12 pay) so a whole
    sale works without a mouse.
13. **The number is the register's code and 6 digits, with no year.** (You chose this.) `POS1-000123`, the example of
    the build plan. The series never restarts, so a receipt is found by its number alone, and a register that passes
    999999 simply gets a seventh digit.
14. **A register moves to another device only after it is free.** (You chose this.) A device takes a register when no
    device holds it: the last one let go of it online (its person signed out with no sale waiting), was moved to
    another branch, or was revoked. A lost or broken computer is revoked (step 18c), which also says that the sales on
    it that never synced are lost. So two devices never number on one register, and a number is never used twice. A
    cashier change needs a connection; another person cannot sign in offline on a device anyway (step 19).
15. **Short batches and serials go below zero too.** (You chose this.) A batch line takes the device's batch first,
    then the other batches by FEFO, and what is still missing goes below zero on the device's batch. A serial number
    in this warehouse leaves as usual; an unknown one, or one in another warehouse, leaves the quantity without the
    serial. Both are on the "Sold short" list. The database lets only a POS sale's movements go below zero (20a.2).

**The contract (20a.1):**

16. **A register's code never changes.** It is part of every receipt number. Changed, a new register could take the old
    code and give numbers the old register's receipts already have. So the code is in the create form only, like a
    number series' prefix in shape: a capital letter, then up to 7 letters and digits, no hyphen.
17. **A register's branch is its warehouse's branch.** Not a field of its own, so the two can never disagree. It says
    whose sale it is in the books, and which devices may take it (a device works in one branch, step 18a).
18. **The POS has four payment methods of its own:** cash, card, bKash and Nagad. A money receipt's methods
    (`mobile_wallet`, step 15c) put bKash and Nagad in one; at a counter they are two wallets, two accounts and two
    names on the receipt. A register has an account per method; cash is always there, because change is given in
    cash. An empty account means the register does not take that method, and the pay screen does not show it.
19. **The device sends the number's sequence, not its text.** Both sides build the text with `formatPosNumber()`, so
    the receipt and the books hold the same number. The server keeps the highest sequence it received
    (`lastNumber`); a claim answers it, and the device goes on from there.
20. **The registers come to the device in the pull.** A new entity, `pos_register`: the active registers of the
    device's branch, without `lastNumber`, which changes with every sale and would send the row again for nothing.
    A new entity raises `SYNC_PROTOCOL` to 2 (the rule of step 18a): every device does one full pull after the update,
    and an app from before asks to be reloaded.
21. **A sale always goes through the outbox, online too.** Its number is made on the device either way, and the receipt
    must print without waiting for an answer. Online, the outbox sends it at once. One path means one piece of code
    posts every sale, and a sale made while the line flickers is never half online and half offline. There is no API
    route that writes a sale.
22. **A line carries the VAT rate the device used.** The receipt was printed with it, so the server works the sale out
    with the same rate, and the books hold what the customer paid. When the NBR changes a rate on 1 July, a sale made
    offline on 30 June still has the old one. The rate's id is still checked.
23. **The bill discount is shared over the lines,** in proportion to what each line is after its own discount, and
    the VAT is worked out after it, line by line (`posSaleAmounts()`). The paisa left over by rounding goes to the
    biggest line; on the last line, it could take a paisa off a free line and make it negative.
24. **The money rules are in the schema:** the bill discount not more than the bill, the payments at least the total,
    change only from cash (a card or a wallet is charged the exact amount). They read the device's rates, so the device
    checks them before the sale and the server again when it arrives, with the same code.
25. **What needs `pos.price.override` is one function,** `posOverridesOf()`: a price other than the one the line started
    with, or a discount over the limit on a line or on the bill. The line sends the price it started with
    (`startingPrice`), so the server compares with what the cashier saw, not with today's price. A price typed where
    there was none is not an override. The server writes the list to the audit log (`pos_sale.overridden`).
26. **The device sends its date and its time.** `date` is the device's today in the workspace's time zone, `soldAt`
    the moment; the receipt prints both. The server books the sale on `date`, unless it is after the server's today
    (a clock set ahead) or in a closed period: then on the first day it can. A sale is not refused for its date.
27. **A walk-in customer is `null`.** The whole amount is paid, so nobody owes anything: the entry debits the money
    accounts and needs no customer.
28. **A POS sale is never refused for `pos.sale.create`** (your choice, 2026-10-28). Every other command needs its
    permission with the roles of now (step 18b, decision 17). A sale is different: when it arrives, the money is in the
    drawer and the goods have left, so a refusal would only leave them out of the books. When the cashier's role lost
    the permission while the device was offline, the server posts the sale and writes a second audit row,
    `pos_sale.without_permission`, with the number and the device's day. It is safe for three reasons. Taking a
    register needs the permission, and a sale needs a register this device holds, so someone who never had it cannot
    sell. Once online, the device learns the new role and the screen stops selling. And the hard stop is still a
    revoke (step 18c): a revoked device's push is refused before any command runs. A person removed from the workspace
    has their devices revoked, so their unsynced sales are still lost (step 18c).
29. **One journal entry, `pos_sale`, counted as a stock document's.** It touches the inventory account, so it is in
    `STOCK_JOURNAL_SOURCES`: the journal's Reverse refuses it, and only a POS return (20c) undoes it. Its stock
    movements are of a new kind, `pos_sale`.
30. **A sold-short line keeps what was missing** (`shortQuantity`, in the base unit). The "Sold short" list shows those
    lines with the stock there now, so a manager sees when it was put right; it needs no "solved" state of its own.
    The bell (`pos.sold_short`) goes to the people with `inventory.stock.adjust`, who put it right.
31. **Reading needs no permission,** like warehouses, stock and every sales document. Setting registers up needs
    `pos.register.manage`, taking one `pos.sale.create`. Letting go has no permission on the route: only the device's
    own person may, and the service checks it. The three permissions are a new group, "POS".
32. **A device holds one register,** and lets go of it before it takes another (`pos_device_has_register`). Only the
    device knows whether a sale of the old register still waits in its outbox, so the app checks that first; the server
    cannot.
33. **A register is archived only while no device holds it** (`pos_register_in_use`), for the same reason.
34. **Two refusals that are not the cashier's to fix.** `pos_method_not_set`: the register no longer has an account for
    the method a sale was paid by; someone sets it, and the cashier sends the sale again. `pos_number_taken`: another
    sale of the register has the number, which the rules of decision 14 make impossible; it shows a bug.
35. **An accepted sale sends no rows back.** A sale is not kept on the device in 20a, and the stock it took comes with
    the next pull, a moment later.
36. **Limits:** 200 lines and 6 payments. A supermarket's monthly shopping is about a hundred lines.

**The database (20a.2):**

37. **The last number is a column of the register, and it counts refused sales too.** A sale moves it up when it is
    written (a trigger), and the API moves it for a sale it refuses (20a.3): that receipt was printed, so its number
    is used. Working it out as the highest sequence of the posted sales would miss a refused sale, and the next device
    could print its number again. It is written without a new `version`, so a sale never makes a manager's edit of the
    register fail, and the change log skips an update that moves only it.
38. **The database lets go of a register when its device is revoked or moved to another branch.** Three pieces of code
    revoke a device (its person, a manager with `core.device.manage`, removing the member), and a later one could
    forget the register. A register held by a revoked device could never be taken again. For the same reason, a
    warehouse whose register is held cannot move to another branch, and a device can take a register only while it is
    active and in the register's branch.
39. **A sale is checked at commit, like a journal entry** (step 10): the header's totals are the sums of its lines, the
    payments add up to what was paid, no more than the total was paid by card or wallet, and a batch line's batches add
    up to its quantity. A sale is posted when it is written, so there is no "post" step where the API could check it,
    and a line added to an old sale later fails the same check.
40. **Where a line's goods left from is a table of its own,** `pos_sale_line_batches`: one row per batch, because a line
    may take from several batches (decision 15). The stock movements cannot say it: two lines of the same product in one
    sale would share them.
41. **A line keeps what its goods cost** (`value`), for the margin and for a return at the same cost (20c), and the
    serial numbers that were not there (`short_serials`) beside what was short.
42. **A sale keeps its warehouse.** The register may move to another warehouse later; the sale's stock left from the
    one it had then.

**The API (20a.3):**

43. **A claim and a release do not change the register's version.** Who holds a register is not part of its form, so a
    manager's open form does not fail because a cashier signed in. The database's own release (decision 38) does the
    same. The devices still hear about it: the change log logs a new holder.
44. **A sale from a device that does not hold its register is refused** (`pos_register_not_held`), and its number is
    still kept as used. Under decisions 14 and 32 it cannot happen, so it is a bug; refused, the sale waits on the
    device instead of putting a number into a series another device is giving out.
45. **When the device's batch is short, the other batches are taken by FEFO, but never an expired one.** An expired
    lot is not on the shelf, so the goods did not come from it. What no batch had goes below zero on the device's batch.
46. **"Sold short" means below zero against the rules.** A product without batches or serials in a workspace that
    allows negative stock goes below zero like after any delivery, so it is not on the list and rings no bell. A batch
    or a serial product is always on it, because neither may ever go below zero otherwise.
47. **Items, VAT rates and customers archived after the sale do not refuse it.** It was sold already; only an item or
    a rate the server does not know (another workspace's, a bug) is refused.
48. **The bell goes through the outbox** (`pos.sold_short`, like the low-stock bell), to the owners and the people with
    `inventory.stock.adjust`. A new event type is only a line in `packages/db`'s typed list: the column is plain text,
    so no migration.
49. **The role templates:** the retail Shop manager gets all three POS permissions, the retail Cashier
    `pos.sale.create`. No other industry's role sells at a counter; an owner gives the permission in Settings → Roles
    where a depot also has one.
50. **The day in the books is the device's day, or the server's today when the device's clock is ahead, then the
    first open day after the lock date** (`firstOpenDay()`). Its shared lock is taken first, so the lock date cannot
    move between that answer and the posting.
51. **A release by the database (revoke, move) writes no audit row for the register.** The device's own row
    (`device.revoked`, `device.moved`) already says it, and the register list shows it free.
52. **A sale that does not add up fails inside its command, not at the push's commit** (`SET CONSTRAINTS ALL IMMEDIATE`
    at the end of the sale). It is a bug either way, and the push answers it with a 500 either way. Checked there, the
    error comes from the sale's own code, inside its savepoint, and not later from the commit of the push's answer row,
    where it would look like the answer itself had failed.
53. **The claim and the numbers live in one clear row on the device** (`registerClaim`), and a sale takes its number in
    the transaction that puts it in the outbox. A number is never given twice (two tabs) and never skipped (a save that
    fails takes no number).
54. **A POS sale is discarded only once the server refused it, and it has no Edit.** The server keeps a refused sale's
    number; a sale never sent has a number only the paper knows.
55. **A walk-in sale waits for nothing in the outbox:** its own id stands in for the customer, so walk-in sales never
    queue behind each other. A sale to a customer made on the device waits for that customer, like an order.
56. **"Which counter is this?" reads the server's list** (who holds what, by device name), online only, and picks the
    register the server says this device holds already.
57. **Signing out lets go of the register before the session ends,** when the copy is open and no sale waits. A failure
    never stops the sign-out; the register then stays with this device.
58. **Changing the customer never reprices the cart,** as on every sales document; the items added after it get the
    customer's prices.
59. **The receipt is `@page { size: auto; margin: 0 }` at 72 or 48 mm wide,** and prints once it is drawn, once per
    sale. The roll's size is the printer driver's.
60. **A tile is an active variant; the first 48 of the search show.** A tile adds the sales unit; a variant's barcode
    adds a base unit, a pack's barcode a pack; Enter adds the only match.
61. **A serial item's quantity is its serial numbers' count,** and Pay waits until each line has one per base unit.
62. **A batch line takes its batch by FEFO from the device's copy when it is added,** and the cashier may pick another
    batch with stock. With nothing in stock and negative stock allowed: the batch that expires last.
63. **The screen's stock check is per variant, over all its lines and all its batches,** only when the workspace does
    not sell below zero.
64. **Money on the screen is whole taka unless it has paisa; the receipt always shows 2 decimals.**
65. **The payment, done, shortcuts and receipt parts, and the register chooser, are lazy chunks** of the POS screen.
66. **The bundle budgets: the first load 220 KB, a lazy chunk 115 KB** (you chose this). The first load was 217.1 KB
    after 20a.5's words; the POS screen with its payment dialog is 112.3 KB.
67. **A sold-short row carries its line's id** (`lineId`, added in 20a.6b to 20a.1's `soldShortItemSchema` and to
    20a.3's list). One sale may sell the same item short on two lines (two prices), and the list needs a key per row.
68. **The `pos.sold_short` bell opens the Sold short list,** the one place where every short line waits to be put right.
69. **The POS sales and Sold short lists need a connection,** like the orders list: offline they say so. The sales are
    not on the devices.
70. **Where the pages are:** POS sales right after POS in Sales, Sold short in Stock before Reorder, POS registers in
    Workspace before Branches. Everyone reads all three; the registers are read-only without `pos.register.manage`.
71. **A sale's page prints the same thermal receipt the counter printed,** from one shared receipt shape.
72. **The pills:** a POS sale is Posted (`good`) and, when a line went below zero, Sold short (`warn`). A sold-short line
    is Below zero (`warn`) until the variant's stock there is back at zero or above, then Put right (`good`).
73. **The register form's warehouse select starts empty** (the warehouse decides the branch), and an existing
    register's code is shown, not offered as a box.
74. **The mock seeds registers, not sales.** A seeded sale would post a journal entry, which moves the JV numbers other
    tests read (JV-…-0009), and ring a bell, which changes the bell test's unread count. The tests make their own sales
    through the POS screen, as a cashier would.
75. **The mock posts a pushed POS sale in full,** with the API's rules on its own arrays: the stock (below zero when it
    must), the entry, the sale and the bell, inside the mock's `transaction()`, which now puts the POS data back too.
76. **The end-to-end test reaches "Sold short" with a serial number that is not in the store.** The device cannot check
    serial numbers (they are not in its copy), so the sale goes through and the server lists it, every time. Taking
    stock below zero would need the server's stock to change between the device's last pull and the sale: a race with
    the pull every minute.
77. **The tests replace `window.print()` with a counter on `<body>`,** so the receipt's print is checked without the
    browser's print dialog.
78. **The screen counts the device's own unsynced sales against the stock** (found in 20a.7, you chose to fix it in
    20a). `stockOf()` takes off every POS sale still in the outbox, refused ones too, of a register on that warehouse.
    So the last piece cannot be sold twice offline.

## 20a.1 — `packages/contracts`: the contract

The contract first, as always. A new file, `pos.ts`, holds the registers, the sale and its arithmetic, and the routes.
`sync.ts` gets the registers on the device and the sale command. The rest are small: three permissions, the error
codes, the audit actions, a bell, a journal source and a movement kind, and two helpers made public.

### `pos.ts`: registers, sales and their arithmetic

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import {
  addMoney,
  compareMoney,
  includedTaxOf,
  isMoneyAmount,
  isZeroMoney,
  multiplyMoney,
  percentOfMoney,
  priceSchema,
  prorateMoney,
  subtractMoney,
  sumMoney,
} from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { isQuantity } from './quantities.js';
import { positiveAmountSchema } from './receipts.js';
import {
  DISCOUNT_TYPES,
  discountSchema,
  type DiscountType,
  type DocumentTotals,
  type LineAmountInput,
  type LineAmounts,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
} from './sales.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  optionalIdSchema,
  serialNumberSchema,
  stockLineRules,
  variantRefSchema,
} from './stock.js';
import { TAX_RATE_FORMAT } from './tax-rates.js';

// Step 20a: the point of sale. A shop's counter sells for cash, card, bKash or Nagad, with or
// without a connection, and prints a receipt on a thermal printer.
//
// A register is one counter: a code (POS1), the warehouse its goods leave from, and an account for
// each way of paying. A device (one browser, step 18a) works on one register at a time, and only
// one device holds a register: the device gives every sale the register's next number itself
// (POS1-000123), so two devices on one register would give the same number twice. Another device
// takes the register only after it is free (you chose this):
//
//   POST /pos/registers/:id/claim     a device takes a free register (or the one it holds)
//   POST /pos/registers/:id/release   it lets it go: its person signs out, with no sale waiting
//   moving the device to another branch, or revoking it (step 18c), frees it too
//
// A sale is made on the device and kept in its outbox (step 18b) as a pos_sale.create command,
// with the number already on it and the money already taken. The server posts it when the command
// arrives: its journal entry (the money accounts; sales and VAT; the cost of goods and the stock)
// and its stock movements. It never refuses a sale for stock (you chose this): the money was taken
// and the receipt printed, so stock that is not there goes below zero, and the sale is listed as
// "sold short" for someone to put right.

// ---------------------------------------------------------------------------------------------
// Registers

// How a customer pays at the counter. Each register has an account for each one it takes: cash
// always (the change is given in cash), the others only where the shop has the machine or the
// wallet. z.enum in the input, like receipts' methods.
export const POS_PAYMENT_METHODS = ['cash', 'card', 'bkash', 'nagad'] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

// The thermal paper's width in millimetres: 58 mm for a small shop's printer, 80 mm for a
// supermarket's. The receipt's layout follows it (@page size).
export const POS_PAPER_WIDTHS = ['58', '80'] as const;
export type PosPaperWidth = (typeof POS_PAPER_WIDTHS)[number];

// POS1-000123: the register's code and the sale's number in it, 6 digits. The series never
// restarts (no year, you chose this), and a register that passes 999999 simply gets 7 digits.
// The device and the server both call this, so the receipt and the books hold the same number.
export const POS_NUMBER_PADDING = 6;

export function formatPosNumber(registerCode: string, sequence: number): string {
  return `${registerCode}-${String(sequence).padStart(POS_NUMBER_PADDING, '0')}`;
}

// The account per method. Cash is always there; null = this register does not take that method.
export const posRegisterAccountsSchema = z.object({
  cash: z.uuid(),
  card: z.uuid().nullable(),
  bkash: z.uuid().nullable(),
  nagad: z.uuid().nullable(),
} satisfies Record<PosPaymentMethod, z.ZodType>);
export type PosRegisterAccounts = z.infer<typeof posRegisterAccountsSchema>;

// The methods a register takes, in the order the pay screen shows them
export function registerMethods(accounts: PosRegisterAccounts): PosPaymentMethod[] {
  return POS_PAYMENT_METHODS.filter((method) => accounts[method] !== null);
}

export const posRegisterSchema = z.object({
  id: z.uuid(),
  // Upper case, part of every receipt number. Never changed after the register is made: a new
  // register with an old code would give numbers an old receipt already has.
  code: z.string(),
  // "Front counter", "Pharmacy counter"
  name: z.string(),
  // The warehouse's branch: whose sale it is in the books, and which devices may take it
  branchId: z.uuid(),
  // Where its goods leave from
  warehouseId: z.uuid(),
  accounts: posRegisterAccountsSchema,
  // The most a cashier may take off without pos.price.override, in percent with 2 places: "10.00"
  maxDiscountPercent: z.string(),
  paperWidth: z.enum(POS_PAPER_WIDTHS),
  // A line or two at the end of the receipt: "Goods once sold are exchanged within 7 days"
  receiptFooter: z.string().nullable(),
  // The device that holds it now; null = free
  deviceId: z.uuid().nullable(),
  // The highest number the server has received from it; 0 = none yet. A device that takes the
  // register goes on from here.
  lastNumber: z.number().int().min(0),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PosRegister = z.infer<typeof posRegisterSchema>;

// A register as the settings list shows it: who holds it, by name
export const posRegisterListItemSchema = posRegisterSchema.extend({
  holder: z.object({ deviceName: z.string(), userName: z.string() }).nullable(),
});
export type PosRegisterListItem = z.infer<typeof posRegisterListItemSchema>;

// A shop has a few counters, a supermarket a few dozen: the whole list at once
export const posRegisterListSchema = z.object({ items: z.array(posRegisterListItemSchema) });

// Like a number series' prefix (numbering.ts): a capital letter first, up to 8 letters and digits,
// no hyphen, because the hyphen separates the code from the number
const registerCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,7}$/, errorCode('pos_register_code_format'));

// 0 to 100, at most 2 decimals. '' (an empty box) = 0: no discount without the permission.
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;

const discountLimitSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || (PERCENT.test(value) && compareMoney(value, '100') <= 0),
    errorCode('pos_discount_limit_format'),
  )
  .transform((value) => (value === '' ? '0' : value));

const registerFieldsSchema = z.object({
  name: z.string().trim().min(2, errorCode('pos_register_name_required')).max(60),
  // The form's empty select sends '' — "not chosen", with its own message
  warehouseId: z.uuid(errorCode('pos_register_warehouse_invalid')),
  accounts: z.object({
    cash: z.uuid(errorCode('pos_register_cash_required')),
    card: optionalIdSchema,
    bkash: optionalIdSchema,
    nagad: optionalIdSchema,
  } satisfies Record<PosPaymentMethod, z.ZodType>),
  maxDiscountPercent: discountLimitSchema,
  paperWidth: z.enum(POS_PAPER_WIDTHS),
  receiptFooter: optionalText(200),
});

export const posRegisterInputSchema = registerFieldsSchema.extend({ code: registerCodeSchema });
export type PosRegisterInput = z.infer<typeof posRegisterInputSchema>;
export type PosRegisterFormValues = z.input<typeof posRegisterInputSchema>;

// No code: it is on every receipt the register printed
export const updatePosRegisterInputSchema = registerFieldsSchema.extend({
  version: versionSchema,
});
export type UpdatePosRegisterInput = z.infer<typeof updatePosRegisterInputSchema>;
export type UpdatePosRegisterFormValues = z.input<typeof updatePosRegisterInputSchema>;

export const posRegisterVersionInputSchema = z.object({ version: versionSchema });

// The device that takes or lets go of the register: the person's own, in this workspace
export const posRegisterDeviceInputSchema = z.object({ deviceId: z.uuid() });
export type PosRegisterDeviceInput = z.infer<typeof posRegisterDeviceInputSchema>;

export const POS_REGISTER_STATUSES = ['active', 'archived'] as const;
export type PosRegisterStatus = (typeof POS_REGISTER_STATUSES)[number];

export const posRegisterListQuerySchema = z.object({
  status: z.enum(POS_REGISTER_STATUSES).default('active'),
  branchId: z.uuid().optional(),
});
export type PosRegisterListQuery = z.input<typeof posRegisterListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The arithmetic of a sale

// A sale's lines are worked out like any sales line (sales.ts → lineAmounts), with one more thing:
// a discount on the whole bill ("10% off today", "৳50 off to make it round"). It is shared out over
// the lines in proportion to what each line is after its own discount, to the paisa, so each line
// still has its own VAT. The VAT is worked out after both discounts: what the customer paid less.
//   billDiscount  the line's share of the bill's discount
//   net, vat, total  after both discounts
export interface PosLineAmounts extends LineAmounts {
  billDiscount: string;
}

export interface PosSaleTotals extends DocumentTotals {
  // discount = the lines' own discounts; billDiscount = the bill's, worked out in taka
  billDiscount: string;
}

export interface BillDiscount {
  type: DiscountType;
  // '0' for none; a percent or an amount, with at most 2 decimals
  value: string;
}

// The bill's discount in taka, before it is shared out
function billDiscountAmount(base: string, bill: BillDiscount): string {
  return bill.type === 'percent' ? percentOfMoney(base, bill.value) : sumMoney([bill.value]);
}

// `amount` shared out over `weights`, adding up to it exactly. The rounding left over goes to the
// biggest weight: on the last line it could take a paisa off a line of ৳0 and make it negative.
function shareOut(amount: string, weights: readonly string[]): string[] {
  const whole = sumMoney(weights);
  if (isZeroMoney(amount) || isZeroMoney(whole)) return weights.map(() => '0.0000');
  const shares = weights.map((weight) => prorateMoney(amount, weight, whole));
  let biggest = 0;
  weights.forEach((weight, index) => {
    if (compareMoney(weight, weights[biggest] ?? '0') > 0) biggest = index;
  });
  const others = sumMoney(shares.filter((_, index) => index !== biggest));
  shares[biggest] = subtractMoney(amount, others);
  return shares;
}

export function posSaleAmounts(
  lines: readonly LineAmountInput[],
  bill: BillDiscount,
  pricesIncludeVat: boolean,
): { lines: PosLineAmounts[]; totals: PosSaleTotals } {
  const firsts = lines.map((line) => {
    const gross = multiplyMoney(line.quantity, line.unitPrice);
    const discount =
      line.discountType === 'percent'
        ? percentOfMoney(gross, line.discount)
        : sumMoney([line.discount]);
    return { gross, discount, after: subtractMoney(gross, discount) };
  });
  const afters = firsts.map((line) => line.after);
  const shares = shareOut(billDiscountAmount(sumMoney(afters), bill), afters);
  const amounts = firsts.map((first, index): PosLineAmounts => {
    const rate = lines[index]?.rate ?? '0';
    const billDiscount = shares[index] ?? '0.0000';
    const paid = subtractMoney(first.after, billDiscount);
    const base = { gross: first.gross, discount: first.discount, billDiscount };
    if (pricesIncludeVat) {
      const vat = includedTaxOf(paid, rate);
      return { ...base, net: subtractMoney(paid, vat), vat, total: paid };
    }
    const vat = percentOfMoney(paid, rate);
    return { ...base, net: paid, vat, total: addMoney(paid, vat) };
  });
  return {
    lines: amounts,
    totals: {
      discount: sumMoney(amounts.map((line) => line.discount)),
      billDiscount: sumMoney(amounts.map((line) => line.billDiscount)),
      net: sumMoney(amounts.map((line) => line.net)),
      vat: sumMoney(amounts.map((line) => line.vat)),
      total: sumMoney(amounts.map((line) => line.total)),
    },
  };
}

interface PaymentFields {
  method: PosPaymentMethod;
  amount: string;
}

// The change given back: what was paid less the total, never below zero. Only cash gives change
// (posSaleRules), so this always comes out of the cash.
export function posChangeOf(payments: readonly PaymentFields[], total: string): string {
  const change = subtractMoney(sumMoney(payments.map((payment) => payment.amount)), total);
  return compareMoney(change, '0') > 0 ? change : '0.0000';
}

// What a cashier did that needs pos.price.override (decision 11): a price other than the one the
// line started with, or a discount above the register's limit, on a line or on the bill. The device
// asks for the permission before the sale; the server writes the same list to the audit log, and
// never refuses the sale for it (the money was taken).
export type PosOverride =
  { kind: 'price'; line: number } | { kind: 'discount'; line: number } | { kind: 'bill_discount' };

interface OverrideLine {
  quantity: string;
  unitPrice: string;
  discountType: DiscountType;
  discount: string;
  // The price the line started with on the device (startingPrice in sales.ts); null = there was
  // none and the cashier typed it, which is not an override
  startingPrice: string | null;
}

// Over the limit = more taka off than the limit's percent of what it comes off
function overLimit(off: string, of: string, limit: string): boolean {
  return compareMoney(off, percentOfMoney(of, limit)) > 0;
}

export function posOverridesOf(
  sale: { lines: readonly OverrideLine[]; billDiscountType: DiscountType; billDiscount: string },
  maxDiscountPercent: string,
): PosOverride[] {
  const overrides: PosOverride[] = [];
  const afters: string[] = [];
  sale.lines.forEach((line, index) => {
    if (line.startingPrice !== null && compareMoney(line.unitPrice, line.startingPrice) !== 0) {
      overrides.push({ kind: 'price', line: index });
    }
    const gross = multiplyMoney(line.quantity, line.unitPrice);
    const off =
      line.discountType === 'percent'
        ? percentOfMoney(gross, line.discount)
        : sumMoney([line.discount]);
    if (overLimit(off, gross, maxDiscountPercent))
      overrides.push({ kind: 'discount', line: index });
    afters.push(subtractMoney(gross, off));
  });
  const base = sumMoney(afters);
  const bill = billDiscountAmount(base, { type: sale.billDiscountType, value: sale.billDiscount });
  if (overLimit(bill, base, maxDiscountPercent)) overrides.push({ kind: 'bill_discount' });
  return overrides;
}

// ---------------------------------------------------------------------------------------------
// What the device sends (inside a pos_sale.create command, sync.ts)

// A counter sale runs to a few dozen items; a supermarket's monthly shopping to a hundred or so
export const MAX_POS_LINES = 200;

// Cash and a card, or bKash with the rest in cash: a few at most
export const MAX_POS_PAYMENTS = 6;

const posLineInputSchema = salesLineFieldsSchema
  .extend({
    // The VAT rate the device used, in percent ("15.00"): the receipt was printed with it, so the
    // server works the sale out with the same rate, also when the rate was changed meanwhile
    rate: z.string().regex(TAX_RATE_FORMAT, errorCode('tax_rate_format')),
    // The price the line started with on the device (posOverridesOf). '' or null = none.
    startingPrice: priceSchema,
    // A batch product: the batch the device took it from (FEFO from its copy). '' = none.
    batchId: optionalIdSchema,
    // A serial product: what the scanner read, one per base unit
    serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
  })
  .superRefine((line, ctx) => {
    salesLineRules(line, ctx);
    stockLineRules(line, ctx);
  });
export type PosLineInput = z.infer<typeof posLineInputSchema>;
export type PosLineFormValues = z.input<typeof posLineInputSchema>;

const posPaymentInputSchema = z.object({
  method: z.enum(POS_PAYMENT_METHODS),
  amount: positiveAmountSchema('pos_payment_amount_required'),
  // The card's last 4 digits or the approval code, the bKash or Nagad TrxID
  reference: optionalText(60),
});
export type PosPaymentInput = z.infer<typeof posPaymentInputSchema>;

const posSaleFieldsSchema = z.object({
  // The register it was sold on, and its number in that register's series (formatPosNumber)
  registerId: z.uuid(),
  sequence: z.number().int().min(1),
  // The device's today in the workspace's time zone, and the moment, by the device's clock. The
  // receipt prints them. The server books the sale on `date`, unless the date is after the server's
  // own today (a clock set ahead) or in a closed period (step 11): then on the first day it can.
  date: z.iso.date(),
  soldAt: z.iso.datetime(),
  // null = a walk-in customer (you chose this): the whole amount is paid now, so nobody owes
  // anything and the sale needs no customer. '' from the form is a walk-in too.
  customerId: optionalIdSchema,
  // The device's copy of the workspace setting when the sale was made, like an order keeps it
  pricesIncludeVat: z.boolean(),
  lines: z.array(posLineInputSchema).min(1, errorCode('sales_lines_required')).max(MAX_POS_LINES),
  billDiscountType: z.enum(DISCOUNT_TYPES),
  billDiscount: discountSchema,
  payments: z
    .array(posPaymentInputSchema)
    .min(1, errorCode('pos_payments_required'))
    .max(MAX_POS_PAYMENTS),
});

type PosSaleRuleInput = z.output<typeof posSaleFieldsSchema>;

// The rules below work the sale out, so they wait until every box they read is complete. Zod runs
// an object's refinement even when one of its fields failed a format check, and the arithmetic
// throws on "15%"; with no payment at all, "pays less than the total" would only repeat the error
// the payments already have.
function isComplete(input: PosSaleRuleInput): boolean {
  return (
    isMoneyAmount(input.billDiscount) &&
    input.payments.length > 0 &&
    input.payments.every((payment) => isMoneyAmount(payment.amount)) &&
    input.lines.every(
      (line) =>
        isQuantity(line.quantity) &&
        isMoneyAmount(line.unitPrice) &&
        isMoneyAmount(line.discount) &&
        TAX_RATE_FORMAT.test(line.rate),
    )
  );
}

// The rules of the whole sale: the bill's discount not more than the bill, the money paid at least
// the total, and change only from cash (a card is charged the exact amount). They read the device's
// own rates, so the same rules hold on the device before the sale and on the server after it.
function posSaleRules(input: PosSaleRuleInput, ctx: z.RefinementCtx<PosSaleRuleInput>): void {
  documentSerialRules(input, ctx);
  if (!isComplete(input)) return;
  const afters = input.lines.map((line) => {
    const gross = multiplyMoney(line.quantity, line.unitPrice);
    return line.discountType === 'percent'
      ? subtractMoney(gross, percentOfMoney(gross, line.discount))
      : subtractMoney(gross, line.discount);
  });
  const limit = input.billDiscountType === 'percent' ? '100' : sumMoney(afters);
  if (compareMoney(input.billDiscount, limit) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['billDiscount'],
      message: errorCode('sales_discount_too_large'),
    });
    return;
  }
  const { totals } = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const paid = sumMoney(input.payments.map((payment) => payment.amount));
  if (compareMoney(paid, totals.total) < 0) {
    ctx.addIssue({ code: 'custom', path: ['payments'], message: errorCode('pos_payment_short') });
  }
  const notCash = input.payments.filter((payment) => payment.method !== 'cash');
  if (compareMoney(sumMoney(notCash.map((payment) => payment.amount)), totals.total) > 0) {
    ctx.addIssue({ code: 'custom', path: ['payments'], message: errorCode('pos_change_not_cash') });
  }
}

export const posSaleInputSchema = posSaleFieldsSchema.superRefine(posSaleRules);
export type PosSaleInput = z.infer<typeof posSaleInputSchema>;
export type PosSaleFormValues = z.input<typeof posSaleInputSchema>;

// ---------------------------------------------------------------------------------------------
// What the API sends: the posted sales, for the managers' list and page

export const posSaleSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  register: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  // The day it is in the books (see posSaleInputSchema), and when it was sold by the device's clock
  date: z.iso.date(),
  soldAt: z.iso.datetime(),
  // null = walk-in
  customer: partyRefSchema.nullable(),
  cashier: z.object({ id: z.uuid(), fullName: z.string() }),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  // A line went below zero when it was posted: it is on the "Sold short" list
  soldShort: z.boolean(),
  // When the server received it
  createdAt: z.iso.datetime(),
});
export type PosSaleSummary = z.infer<typeof posSaleSummarySchema>;

export const posSaleLineSchema = salesLineSchema.extend({
  // The line's share of the bill's discount (posSaleAmounts); net, vat and total are after it
  billDiscount: z.string(),
  // The price it started with on the device; differs from unitPrice when the cashier changed it
  startingPrice: z.string().nullable(),
  // The batch it left from: the device's, and the others it took when that one was short
  batches: z.array(
    z.object({
      batchId: z.uuid(),
      lotNumber: z.string(),
      expiresOn: z.iso.date().nullable(),
      quantity: z.string(),
    }),
  ),
  serialNumbers: z.array(z.string()),
  // What the warehouse did not have when it was posted, in the base unit; "0.0000" = none
  shortQuantity: z.string(),
});
export type PosSaleLine = z.infer<typeof posSaleLineSchema>;

export const posSalePaymentSchema = z.object({
  method: z.enum(POS_PAYMENT_METHODS),
  amount: z.string(),
  reference: z.string().nullable(),
  // The register's account for the method when the sale was posted
  accountId: z.uuid(),
});
export type PosSalePayment = z.infer<typeof posSalePaymentSchema>;

export const posSaleSchema = posSaleSummarySchema.extend({
  pricesIncludeVat: z.boolean(),
  // The lines' own discounts, and the bill's discount as typed and in taka
  discount: z.string(),
  billDiscountType: z.enum(DISCOUNT_TYPES),
  billDiscount: z.string(),
  billDiscountAmount: z.string(),
  // What was paid, and the change given back in cash (posChangeOf)
  paid: z.string(),
  change: z.string(),
  lines: z.array(posSaleLineSchema),
  payments: z.array(posSalePaymentSchema),
  // The device it was sold on (its name now)
  device: z.object({ id: z.uuid(), name: z.string() }),
  // The sale, its cost and its stock in the books; null only for a sale of ৳0 that cost nothing
  entry: entryRefSchema.nullable(),
});
export type PosSale = z.infer<typeof posSaleSchema>;

export const posSaleListQuerySchema = pageQuerySchema.extend({
  registerId: z.uuid().optional(),
  customerId: z.uuid().optional(),
});
export type PosSaleListQuery = z.input<typeof posSaleListQuerySchema>;

export const posSalePageSchema = pageOf(posSaleSummarySchema);
export type PosSalePage = z.infer<typeof posSalePageSchema>;

// One line that went below zero, for the "Sold short" list under Inventory: what was sold that the
// warehouse did not have, as the server saw it when the sale arrived
export const soldShortItemSchema = variantRefSchema.extend({
  // The sale's line: one sale may sell the same item short on two lines (two prices), so the list
  // needs the line to tell its rows apart (20a.6b)
  lineId: z.uuid(),
  saleId: z.uuid(),
  saleNumber: z.string(),
  date: z.iso.date(),
  warehouseId: z.uuid(),
  // In the base unit
  shortQuantity: z.string(),
  // The batch it went below zero on; null for a product without batches
  lotNumber: z.string().nullable(),
  // Serial numbers the scanner read that were not in this warehouse: they left without a serial
  serialNumbers: z.array(z.string()),
  // The variant's stock in that warehouse now: back at zero or above once someone put it right
  onHandNow: z.string(),
});
export type SoldShortItem = z.infer<typeof soldShortItemSchema>;

export const soldShortQuerySchema = pageQuerySchema.extend({ warehouseId: z.uuid().optional() });
export type SoldShortQuery = z.input<typeof soldShortQuerySchema>;

export const soldShortPageSchema = pageOf(soldShortItemSchema);
export type SoldShortPage = z.infer<typeof soldShortPageSchema>;

const posParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like warehouses and every sales document. Registers are set up with
// pos.register.manage; taking one needs pos.sale.create, the cashier's permission. Letting go has
// no permission on the route: only the device's own person may, and the service checks it.
// A sale is never written through these routes: it arrives as a sync command (sync.ts).
export const posRoutes = {
  listRegisters: defineRoute({
    method: 'GET',
    path: '/pos/registers',
    summary: 'The POS registers (counters) of the workspace',
    auth: 'bearer',
    status: 200,
    query: posRegisterListQuerySchema,
    response: posRegisterListSchema,
  }),
  getRegister: defineRoute({
    method: 'GET',
    path: '/pos/registers/:id',
    summary: 'One POS register, with its last number',
    auth: 'bearer',
    status: 200,
    params: posParamsSchema,
    response: posRegisterSchema,
  }),
  createRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers',
    summary: 'Add a POS register: a counter with its warehouse and payment accounts',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 201,
    body: posRegisterInputSchema,
    response: posRegisterSchema,
  }),
  updateRegister: defineRoute({
    method: 'PUT',
    path: '/pos/registers/:id',
    summary: "Change a POS register's name, warehouse, accounts, discount limit or receipt",
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: posParamsSchema,
    body: updatePosRegisterInputSchema,
    response: posRegisterSchema,
  }),
  archiveRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/archive',
    summary: 'Stop using a POS register; refused while a device holds it',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: posParamsSchema,
    body: posRegisterVersionInputSchema,
    response: posRegisterSchema,
  }),
  restoreRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/restore',
    summary: 'Bring an archived POS register back',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: posParamsSchema,
    body: posRegisterVersionInputSchema,
    response: posRegisterSchema,
  }),
  claimRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/claim',
    summary: 'This device takes a free register; it numbers its sales from the last number on',
    auth: 'bearer',
    permission: 'pos.sale.create',
    status: 200,
    params: posParamsSchema,
    body: posRegisterDeviceInputSchema,
    response: posRegisterSchema,
  }),
  releaseRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/release',
    summary: 'This device lets go of its register, so another device can take it',
    auth: 'bearer',
    status: 200,
    params: posParamsSchema,
    body: posRegisterDeviceInputSchema,
    response: posRegisterSchema,
  }),
  listSales: defineRoute({
    method: 'GET',
    path: '/pos/sales',
    summary: 'POS sales the server has received, newest first',
    auth: 'bearer',
    status: 200,
    query: posSaleListQuerySchema,
    response: posSalePageSchema,
  }),
  getSale: defineRoute({
    method: 'GET',
    path: '/pos/sales/:id',
    summary: 'One POS sale with its lines, payments and entry',
    auth: 'bearer',
    status: 200,
    params: posParamsSchema,
    response: posSaleSchema,
  }),
  soldShort: defineRoute({
    method: 'GET',
    path: '/pos/sold-short',
    summary: 'POS sale lines that took stock below zero, newest first',
    auth: 'bearer',
    status: 200,
    query: soldShortQuerySchema,
    response: soldShortPageSchema,
  }),
};
```

**The header and the registers:**

- **The header comment is the design in one place:** what a register is, why one device holds it, the two routes that
  move it, and that the server posts a sale when the command arrives and never refuses it for stock. 20a.3's services
  and 20a.6's screen both follow it.
- **`POS_PAYMENT_METHODS` is its own list** (decision 18), not `PAYMENT_METHODS` from `receipts.ts`.
- **`formatPosNumber()`** pads to 6 digits with `padStart`, which never cuts a longer string: sale 1,234,567 of a busy
  register is `CTG2-1234567`, not a wrong number.
- **`posRegisterAccountsSchema` is checked with `satisfies Record<PosPaymentMethod, z.ZodType>`.** A fifth method added
  to the list later fails the type check here until the register has an account for it.
- **`registerMethods()` keeps the list's order,** so the pay screen always shows cash first, whatever order the
  accounts were set in.
- **`deviceId` and `lastNumber`** are the two fields decisions 14 and 19 rest on. `lastNumber` is a number, not a
  string: a sequence is counted, never added up like money, and it fits a JavaScript number for ever.
- **`posRegisterListItemSchema` adds the holder's names** for the settings list ("Front desk PC · Nusrat Jahan"). The
  register itself only keeps the device's id: names change, and the pull would send the register again with every
  rename.
- **`registerCodeSchema` upper-cases before the check,** like a warehouse code, so `pos1` and `POS1` are one code.
- **`discountLimitSchema` takes an empty box as `'0'`:** no discount without the permission. It compares with
  `compareMoney`, not `Number()`, like every amount in this package.
- **The create input adds the code, the update input does not** (decision 16). An update that sends a code anyway has
  it dropped by the object's parse, so a changed form cannot change it.
- **`posRegisterDeviceInputSchema` names the device** for the claim and the release. The person is known from the
  sign-in; the device is not, and one person may have several (step 18c).

**The arithmetic:**

- **`posSaleAmounts()` works each line like `lineAmounts()` in `sales.ts`,** then takes the line's share of the bill
  discount off before the VAT (decision 23). With no bill discount the answer is exactly `lineAmounts()`'s, and
  the test checks that.
- **`shareOut()` uses `prorateMoney()`** for each share and gives the rest to the biggest line. With `amount` or the
  weights at zero, every share is zero: there is nothing to share, or nothing to share it over, and `prorateMoney()`
  would throw on a whole of zero.
- **`billDiscountAmount()`** is shared by the arithmetic and by `posOverridesOf()`, so the limit is checked on the same
  taka the receipt shows.
- **`posChangeOf()` never goes below zero.** It is called on a sale already checked (paid at least the total), but the
  pay screen calls it while the cashier is still typing the amounts.
- **`posOverridesOf()` returns a list, not a yes or no.** The device needs only "is there any", but the audit row says
  what was done: "Line 2: price changed".
- **`overLimit()` compares taka with taka:** the limit's percent of the line, worked out to the paisa, against the taka
  off. Comparing percents would need a division and a rounding of its own; ৳20 off ৳200 at a 10% limit is exactly the
  limit, and not over it.

**The sale's input:**

- **`posLineInputSchema` is a sales line plus three things:** the device's `rate` (decision 22), `startingPrice`
  (decision 25) and the stock fields of a delivery line (`batchId`, `serialNumbers`). Its rules are the sales line's
  (a discount never more than the line) and the stock line's (a serial number once).
- **`rate` uses `TAX_RATE_FORMAT`** from `tax-rates.ts`, the rule the VAT rate form uses, so a rate the device got from
  the server always passes.
- **`startingPrice` uses `priceSchema`:** an empty box and `null` are both "no price was there".
- **`registerId` is a plain `z.uuid()`:** the register exists already, and only the server can say whether it is this
  workspace's.
- **`sequence` starts at 1,** so 0 can mean "no sale yet" in `lastNumber`.
- **`customerId` uses `optionalIdSchema`,** so the form's empty select is a walk-in (decision 27).
- **`isComplete()` guards the sale's rules.** Zod still runs an object's refinement when a field inside failed a format
  check: a rate of "15%" reached the arithmetic, which threw, in the first run of the tests. The rules wait until
  every value they read is complete; the field errors are already there. With no payment at all, "pays less than the
  total" would only repeat the error the payments have.
- **`documentSerialRules()` runs before the guard:** it reads no amount, and a serial scanned twice is worth showing
  while a price is still wrong.
- **`posSaleRules()` returns after a bill discount that is too large:** the totals would be below zero, and "paid less
  than the total" would then be false for the wrong reason.

**What the API sends:**

- **`posSaleSummarySchema` has no status.** A sale is posted when it exists; 20c adds what came back.
- **`soldShort` is on the summary,** so the sales list can mark those rows without opening each one.
- **`posSaleLineSchema.batches` is a list:** a short batch line may have left from several batches (decision 15).
- **`soldShortItemSchema.onHandNow`** is the variant's stock in the warehouse when the list is read (decision 30).
- **`posRoutes` has no route that writes a sale** (decision 21). The claim is a `POST` that answers `200`: it changes
  a register, it makes nothing.

```ts
import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  formatPosNumber,
  posChangeOf,
  posOverridesOf,
  posRegisterInputSchema,
  posSaleAmounts,
  posSaleInputSchema,
  registerMethods,
  updatePosRegisterInputSchema,
} from './pos.js';
import { lineAmounts } from './sales.js';

const WAREHOUSE = '0192f1d0-0000-7000-8000-000000000001';
const CASH = '0192f1d0-0000-7000-8000-000000000002';
const BKASH = '0192f1d0-0000-7000-8000-000000000003';
const REGISTER = '0192f1d0-0000-7000-8000-000000000004';
const VARIANT = '0192f1d0-0000-7000-8000-000000000005';
const UNIT = '0192f1d0-0000-7000-8000-000000000006';
const RATE = '0192f1d0-0000-7000-8000-000000000007';

// The error codes where the form will show them: field path → code
function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('receipt numbers', () => {
  it("puts the register's code before 6 digits, and grows past them", () => {
    expect(formatPosNumber('POS1', 123)).toBe('POS1-000123');
    expect(formatPosNumber('CTG2', 1234567)).toBe('CTG2-1234567');
  });
});

describe('register input', () => {
  // The front counter of a pharmacy in Dhanmondi: cash and bKash, no card machine
  const counter = {
    code: ' pos1 ',
    name: 'Front counter',
    warehouseId: WAREHOUSE,
    accounts: { cash: CASH, card: '', bkash: BKASH, nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
  };

  it('upper-cases the code, and reads the empty boxes as nothing', () => {
    const input = posRegisterInputSchema.parse(counter);
    expect(input.code).toBe('POS1');
    expect(input.accounts).toEqual({ cash: CASH, card: null, bkash: BKASH, nagad: null });
    expect(input.maxDiscountPercent).toBe('0');
    expect(input.receiptFooter).toBeNull();
    expect(registerMethods({ ...input.accounts, cash: CASH })).toEqual(['cash', 'bkash']);
  });

  it('refuses a hyphen in the code, no cash account and a limit over 100%, each with its code', () => {
    const result = posRegisterInputSchema.safeParse(
      {
        ...counter,
        code: 'POS-1',
        accounts: { ...counter.accounts, cash: '' },
        maxDiscountPercent: '100.5',
      },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      code: 'pos_register_code_format',
      'accounts.cash': 'pos_register_cash_required',
      maxDiscountPercent: 'pos_discount_limit_format',
    });
  });

  it('never changes the code once the register exists', () => {
    const update = updatePosRegisterInputSchema.parse({ ...counter, code: 'POS9', version: 2 });
    expect(update).not.toHaveProperty('code');
  });
});

describe('sale amounts', () => {
  const line = (extra: object) => ({
    quantity: '1',
    unitPrice: '100',
    discountType: 'percent' as const,
    discount: '0',
    rate: '15.00',
    ...extra,
  });

  it('works a line out like any sales line when the bill has no discount', () => {
    const one = line({ quantity: '3', unitPrice: '1200.50', discount: '10' });
    const { lines } = posSaleAmounts([one], { type: 'percent', value: '0' }, false);
    expect(lines[0]).toEqual({ ...lineAmounts(one, false), billDiscount: '0.0000' });
  });

  it("shares the bill's discount by what each line is after its own, then adds the VAT", () => {
    const { lines, totals } = posSaleAmounts(
      [line({ quantity: '2', unitPrice: '500', discount: '10' }), line({ unitPrice: '300' })],
      { type: 'percent', value: '5' },
      false,
    );
    // 5% of 900 + 300: ৳45 and ৳15
    expect(lines.map((amounts) => [amounts.billDiscount, amounts.net, amounts.vat])).toEqual([
      ['45.0000', '855.0000', '128.2500'],
      ['15.0000', '285.0000', '42.7500'],
    ]);
    expect(totals).toEqual({
      discount: '100.0000',
      billDiscount: '60.0000',
      net: '1140.0000',
      vat: '171.0000',
      total: '1311.0000',
    });
  });

  it('gives the paisa left over to the biggest line, never to a free one', () => {
    const { lines, totals } = posSaleAmounts(
      [line({}), line({}), line({}), line({ unitPrice: '0' })],
      { type: 'amount', value: '10' },
      false,
    );
    expect(lines.map((amounts) => amounts.billDiscount)).toEqual([
      '3.3400',
      '3.3300',
      '3.3300',
      '0.0000',
    ]);
    expect(totals.billDiscount).toBe('10.0000');
  });

  it('takes the VAT out of what was paid when prices include it', () => {
    const { lines } = posSaleAmounts(
      [line({ unitPrice: '115' })],
      { type: 'amount', value: '11.50' },
      true,
    );
    expect(lines[0]).toMatchObject({ net: '90.0000', vat: '13.5000', total: '103.5000' });
  });
});

describe('change and overrides', () => {
  it('gives back what was paid over the total, and never less than nothing', () => {
    const payments = [
      { method: 'bkash' as const, amount: '1000' },
      { method: 'cash' as const, amount: '1000' },
    ];
    expect(posChangeOf(payments, '1700.0000')).toBe('300.0000');
    expect(posChangeOf(payments, '2500.0000')).toBe('0.0000');
  });

  it('lists a changed price and every discount over the limit, but not a price typed from none', () => {
    const sale = {
      lines: [
        // ৳120 on the shelf, sold for ৳110
        {
          quantity: '1',
          unitPrice: '110',
          discountType: 'percent' as const,
          discount: '0',
          startingPrice: '120',
        },
        // No price anywhere, so the cashier typed ৳50; 15% off is over the 10% limit
        {
          quantity: '1',
          unitPrice: '50',
          discountType: 'percent' as const,
          discount: '15',
          startingPrice: null,
        },
        // ৳20 off ৳200 is exactly 10%: not over
        {
          quantity: '1',
          unitPrice: '200',
          discountType: 'amount' as const,
          discount: '20',
          startingPrice: '200',
        },
      ],
      // ৳40 off ৳332.50 is over 10% (৳33.25)
      billDiscountType: 'amount' as const,
      billDiscount: '40',
    };
    expect(posOverridesOf(sale, '10')).toEqual([
      { kind: 'price', line: 0 },
      { kind: 'discount', line: 1 },
      { kind: 'bill_discount' },
    ]);
    expect(posOverridesOf({ ...sale, lines: [], billDiscount: '0' }, '10')).toEqual([]);
  });
});

describe('sale input', () => {
  // Two bottles of soybean oil at a super shop in Chattogram, ৳850 each with VAT
  function sale(extra: object = {}) {
    return {
      registerId: REGISTER,
      sequence: 123,
      date: '2026-10-27',
      soldAt: '2026-10-27T11:42:10.000Z',
      customerId: '',
      pricesIncludeVat: true,
      lines: [
        {
          variantId: VARIANT,
          unitId: UNIT,
          quantity: '2',
          description: '',
          unitPrice: '850',
          discountType: 'percent',
          discount: '',
          taxRateId: RATE,
          rate: '15.00',
          startingPrice: '850.0000',
          batchId: '',
          serialNumbers: [],
        },
      ],
      billDiscountType: 'percent',
      billDiscount: '',
      payments: [{ method: 'cash', amount: '2000', reference: '' }],
      ...extra,
    };
  }

  it('sells to a walk-in customer, and gives the change in cash', () => {
    const input = posSaleInputSchema.parse(sale());
    expect(input.customerId).toBeNull();
    expect(input.billDiscount).toBe('0');
    expect(posChangeOf(input.payments, '1700.0000')).toBe('300.0000');
  });

  it('takes a split payment: part by bKash, the rest in cash', () => {
    const payments = [
      { method: 'bkash', amount: '1000', reference: 'BK7XQ2M4' },
      { method: 'cash', amount: '1000', reference: '' },
    ];
    expect(posSaleInputSchema.safeParse(sale({ payments })).success).toBe(true);
  });

  it('needs the whole amount, and change only from cash', () => {
    const short = posSaleInputSchema.safeParse(
      sale({ payments: [{ method: 'cash', amount: '1500', reference: '' }] }),
    );
    expect(errorsOf(short)).toEqual({ payments: 'pos_payment_short' });
    const card = posSaleInputSchema.safeParse(
      sale({ payments: [{ method: 'card', amount: '2000', reference: '4417' }] }),
    );
    expect(errorsOf(card)).toEqual({ payments: 'pos_change_not_cash' });
    const none = posSaleInputSchema.safeParse(sale({ payments: [] }), {
      error: contractErrorMap,
    });
    expect(errorsOf(none)).toEqual({ payments: 'pos_payments_required' });
  });

  it('never takes more off the bill than the bill', () => {
    const result = posSaleInputSchema.safeParse(
      sale({ billDiscountType: 'amount', billDiscount: '1800' }),
    );
    expect(errorsOf(result)).toEqual({ billDiscount: 'sales_discount_too_large' });
  });

  it("checks the device's rate, and a serial number scanned on two lines", () => {
    const [first] = sale().lines;
    const phone = { ...first, quantity: '1', serialNumbers: ['356938035643809'] };
    const twice = posSaleInputSchema.safeParse(sale({ lines: [phone, phone] }));
    expect(errorsOf(twice)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
    const rate = posSaleInputSchema.safeParse(sale({ lines: [{ ...first, rate: '15%' }] }));
    expect(errorsOf(rate)).toEqual({ 'lines.0.rate': 'tax_rate_format' });
  });
});
```

- **The fixtures are a pharmacy's front counter in Dhanmondi** (cash and bKash, no card machine) and two bottles of
  soybean oil at a super shop in Chattogram.
- **"Shares the bill's discount…"** uses round numbers on purpose: 5% of ৳1,200 is ৳60, ৳45 and ৳15 by the lines, and
  the VAT after it. Anyone can check them on paper.
- **"Gives the paisa left over to the biggest line"** shares ৳10 over three lines of ৳100 and a free one: 3.34, 3.33,
  3.33 and 0. The free line keeps nothing.
- **"Lists a changed price…"** has one line exactly at the limit, which is not over it.
- **"Checks the device's rate…"** is the test that found the need for `isComplete()`.

### `sync.ts`: the registers and the sale

```diff
@@ -10,6 +10,7 @@ import {
 import { errorCode, problemSchema } from './errors.js';
 import { versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
+import { posRegisterSchema, posSaleInputSchema } from './pos.js';
 import { priceListSchema } from './price-lists.js';
 import { productCategorySchema } from './product-categories.js';
 import { productSchema } from './products.js';
@@ -33,14 +34,16 @@ import { warehouseSchema } from './warehouses.js';
 // and barcodes, the price lists and their prices, the VAT rates, the units and categories, the
 // active customers with their groups, the warehouses of the device's branch and the stock in them,
 // and the part of the settings a sale needs. No customer balances and no stock values: they
-// change with every invoice and every movement, and they need their own permissions.
+// change with every invoice and every movement, and they need their own permissions. Step 20a adds
+// the POS registers of the branch.
 
 // The version of this protocol: what the entities below are and what their rows hold. A client
 // sends the version it was built with; the server answers sync_protocol_mismatch to any other,
 // and the app asks the person to reload. That is how a new entity can be added later: an older
 // client never receives a row it cannot read, and a client that moved to a new version starts
 // again with a full pull, so it does not miss the rows of an entity it did not know before.
-export const SYNC_PROTOCOL = 1;
+// 2 (step 20a): the POS registers (pos_register) and the pos_sale.create command.
+export const SYNC_PROTOCOL = 2;
 
 // Every kind of row a device keeps. The order is the order of a full pull: the small lists that
 // the others point at come first, so a page never shows a product before its units.
@@ -50,6 +53,7 @@ export const SYNC_ENTITIES = [
   'product_category',
   'tax_rate',
   'warehouse',
+  'pos_register',
   'price_list',
   'customer_group',
   'product',
@@ -95,6 +99,13 @@ export type SyncPriceList = z.infer<typeof syncPriceListSchema>;
 export const syncCustomerGroupSchema = customerGroupSchema.omit({ customerCount: true });
 export type SyncCustomerGroup = z.infer<typeof syncCustomerGroupSchema>;
 
+// A POS register of the device's branch (step 20a), active ones only: its code for the receipt
+// numbers, the methods it takes, its discount limit and its receipt, and whether this device holds
+// it. Without lastNumber, which changes with every sale: the device that holds the register counts
+// on from the number the claim answered, and every sale would send the row again for nothing.
+export const syncPosRegisterSchema = posRegisterSchema.omit({ lastNumber: true });
+export type SyncPosRegister = z.infer<typeof syncPosRegisterSchema>;
+
 // A customer with its addresses, without the balance (decision 10: the list asks the server for
 // the balances of the rows it shows, online only)
 export const syncCustomerSchema = customerSchema.omit({ balance: true });
@@ -146,7 +157,8 @@ export function stockKey(row: Pick<SyncStock, 'warehouseId' | 'variantId' | 'bat
 // ---------------------------------------------------------------------------------------------
 // A change: a row to put in (insert or replace), or a key to take out. A row is taken out when it
 // is deleted, and also when it leaves what the device keeps: an archived product, a customer that
-// is now only a supplier, a warehouse moved to another branch, a stock row at zero.
+// is now only a supplier, a warehouse moved to another branch, a stock row at zero, a register
+// archived or moved to another branch with its warehouse.
 
 function upsertOf<const E extends SyncEntity, S extends z.ZodType>(entity: E, data: S) {
   return z.object({
@@ -165,6 +177,7 @@ export const syncUpsertSchema = z.discriminatedUnion('entity', [
   upsertOf('product_category', syncCategorySchema),
   upsertOf('tax_rate', taxRateSchema),
   upsertOf('warehouse', warehouseSchema),
+  upsertOf('pos_register', syncPosRegisterSchema),
   upsertOf('price_list', syncPriceListSchema),
   upsertOf('customer_group', syncCustomerGroupSchema),
   upsertOf('product', productSchema),
@@ -316,6 +329,7 @@ export const SYNC_COMMAND_TYPES = [
   'customer.create',
   'customer.update',
   'sales_order.create_draft',
+  'pos_sale.create',
 ] as const;
 export type SyncCommandType = (typeof SYNC_COMMAND_TYPES)[number];
 
@@ -347,10 +361,22 @@ export const salesOrderDraftCommandSchema = z.object({
   input: salesOrderDraftInputSchema,
 });
 
+// Step 20a: a sale at a POS counter, already paid and printed. Unlike an order it is not a draft:
+// the server posts it when the command arrives, and never refuses it for stock (pos.ts). It waits
+// for nothing but a customer made on the same device, like an order.
+export const posSaleCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('pos_sale.create'),
+  // The sale's id, made on the device: the receipt, and from step 20c a return, point at it
+  saleId: z.uuidv7(),
+  input: posSaleInputSchema,
+});
+
 export const syncCommandSchema = z.discriminatedUnion('type', [
   customerCreateCommandSchema,
   customerUpdateCommandSchema,
   salesOrderDraftCommandSchema,
+  posSaleCommandSchema,
 ]);
 export type SyncCommand = z.infer<typeof syncCommandSchema>;
 export type SyncCommandInput = z.input<typeof syncCommandSchema>;
@@ -399,8 +425,8 @@ export const syncResultSchema = z.discriminatedUnion('status', [
     status: z.literal('accepted'),
     notices: z.array(syncNoticeSchema),
     // The rows the command changed, as they are now, for the device to write at once instead of
-    // waiting for its next pull: the customer for a customer command, nothing for an order (orders
-    // are not on the device). Read when the answer is made, also for a command sent again, so an
+    // waiting for its next pull: the customer for a customer command, nothing for an order or a POS
+    // sale (neither is on the device; the stock a sale took comes with the next pull). Read when the answer is made, also for a command sent again, so an
     // old answer never puts an older row back on the device.
     changes: z.array(syncChangeSchema),
   }),
@@ -501,8 +527,9 @@ export const syncRoutes = {
     response: syncPullSchema,
   }),
   // No permission for the route: each command needs the permission its API route needs
-  // (sales.customer.manage, sales.order.manage), checked per command with the roles of now. A
-  // person whose role lost it since gets that command refused with permission_missing.
+  // (sales.customer.manage, sales.order.manage; pos.sale.create for a POS sale), checked per
+  // command with the roles of now. A person whose role lost it since gets that command refused
+  // with permission_missing.
   push: defineRoute({
     method: 'POST',
     path: '/sync/push',
```

- **`SYNC_PROTOCOL` is 2** (decision 20). The comment above it keeps a line per version, so the next person sees why
  each one came.
- **`pos_register` sits after `warehouse` in `SYNC_ENTITIES`:** a register points at a warehouse, and a full pull sends
  the entities in this order.
- **`syncPosRegisterSchema` omits `lastNumber`** (decision 20).
- **`posSaleCommandSchema` makes the device give the sale's id** as a UUIDv7, like an order's: the receipt points at it
  before the server has seen it, and 20c's returns will too.
- **The comment on an accepted result** now says that a POS sale sends no rows back (decision 35).

```diff
@@ -4,6 +4,7 @@ import { contractErrorMap } from './errors.js';
 import {
   customerUpdateCommandSchema,
   deviceKeySchema,
+  posSaleCommandSchema,
   priceListItemKey,
   registerDeviceInputSchema,
   salesOrderDraftCommandSchema,
@@ -15,6 +16,7 @@ import {
   syncPullSchema,
   syncPushInputSchema,
   syncPushSchema,
+  syncUpsertSchema,
   type SyncCommandInput,
   type SyncPushInput,
 } from './sync.js';
@@ -415,3 +417,71 @@ describe('push', () => {
     expect(rejected?.status === 'rejected' && rejected.error.code).toBe('customer_code_taken');
   });
 });
+
+// ---------------------------------------------------------------------------------------------
+// The POS (step 20a)
+
+describe('POS on the device', () => {
+  const register = {
+    id: ORDER,
+    code: 'POS1',
+    name: 'Front counter',
+    branchId: CUSTOMER,
+    warehouseId: WAREHOUSE,
+    accounts: { cash: RATE, card: null, bkash: null, nagad: null },
+    maxDiscountPercent: '10.00',
+    paperWidth: '58',
+    receiptFooter: null,
+    deviceId: COMMAND,
+    lastNumber: 122,
+    archivedAt: null,
+    version: 4,
+    updatedAt: AT,
+  };
+
+  it('keeps a register without its last number, which changes with every sale', () => {
+    const change = syncUpsertSchema.parse({
+      op: 'upsert',
+      entity: 'pos_register',
+      key: ORDER,
+      data: register,
+    });
+    expect(change.entity === 'pos_register' && change.data.code).toBe('POS1');
+    expect(change.data).not.toHaveProperty('lastNumber');
+  });
+
+  it('sends a sale under an id the device made, and refuses one of another kind', () => {
+    const input = {
+      registerId: ORDER,
+      sequence: 123,
+      date: '2026-10-27',
+      soldAt: AT,
+      customerId: null,
+      pricesIncludeVat: true,
+      lines: [
+        {
+          variantId: VARIANT,
+          unitId: UNIT,
+          quantity: '10',
+          description: '',
+          unitPrice: '12',
+          discountType: 'percent',
+          discount: '',
+          taxRateId: RATE,
+          rate: '0.00',
+          startingPrice: '12.0000',
+          batchId: BATCH,
+          serialNumbers: [],
+        },
+      ],
+      billDiscountType: 'percent',
+      billDiscount: '',
+      payments: [{ method: 'cash', amount: '120', reference: '' }],
+    };
+    const command = { id: COMMAND, type: 'pos_sale.create', saleId: CUSTOMER, input };
+    expect(syncCommandSchema.parse(command).type).toBe('pos_sale.create');
+    expect(errorsOf(posSaleCommandSchema.safeParse({ ...command, saleId: V4 }))).toEqual({
+      saleId: 'Invalid UUID',
+    });
+  });
+});
```

- **"Keeps a register without its last number"** sends `lastNumber` and checks it is dropped while parsing, like the
  customer's balance above it.
- **"Sends a sale under an id the device made"** checks that the union knows the new type, and that a v4 `saleId` is
  refused.

### `permissions.ts`, `errors.ts`, `audit.ts`, `notifications.ts`

```diff
@@ -44,6 +44,9 @@ export const PERMISSION_KEYS = [
   'purchase.return.manage',
   'purchase.debit_note.manage',
   'purchase.refund.manage',
+  'pos.sale.create',
+  'pos.price.override',
+  'pos.register.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -63,6 +66,7 @@ export const PERMISSION_GROUPS = [
   'inventory',
   'sales',
   'purchase',
+  'pos',
 ] as const;
 export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];
 
@@ -109,4 +113,7 @@ export const PERMISSION_GROUP_OF = {
   'purchase.return.manage': 'purchase',
   'purchase.debit_note.manage': 'purchase',
   'purchase.refund.manage': 'purchase',
+  'pos.sale.create': 'pos',
+  'pos.price.override': 'pos',
+  'pos.register.manage': 'pos',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

- **A new group, `pos`,** for the three permissions (decision 31). The role matrix shows it as its own block, after
  Purchase.

```diff
@@ -489,6 +489,34 @@ export const ERROR_CODES = [
   // Step 18c: a branch is archived only when no active device is in it. Move or revoke them
   // first: a device's next pull would otherwise copy a branch that is gone.
   'branch_has_devices',
+  // Step 20a: POS registers. A register's code is part of every receipt number, so it is checked
+  // like a number series' prefix.
+  'pos_register_code_format',
+  'pos_register_code_taken',
+  'pos_register_name_required',
+  'pos_register_warehouse_invalid',
+  'pos_register_cash_required',
+  // A payment method's account is not an active money account (accounts.ts → moneyAccountIds)
+  'pos_register_account_invalid',
+  'pos_discount_limit_format',
+  // Another device holds the register (claim, archive); it is archived; it is in another branch
+  // than the device; the device already holds another register (it lets go of that one first);
+  // the device lets go of a register it does not hold
+  'pos_register_in_use',
+  'pos_register_archived',
+  'pos_register_branch',
+  'pos_device_has_register',
+  'pos_register_not_held',
+  // A POS sale (the device's schema, and the server again when the command arrives)
+  'pos_payments_required',
+  'pos_payment_amount_required',
+  'pos_payment_short',
+  'pos_change_not_cash',
+  // The register no longer has an account for a method the sale was paid by: someone with
+  // pos.register.manage sets one, then the cashier sends the sale again from the Sync page
+  'pos_method_not_set',
+  // Another sale of the register already has this number: a bug, never a cashier's mistake
+  'pos_number_taken',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **The register's codes** follow the warehouse's (`…_format`, `…_taken`, `…_name_required`, `…_invalid`).
- **`pos_payments_required` and `pos_payment_amount_required`** are the empty states of the pay screen; `pos_payment_short`
  and `pos_change_not_cash` are the rules of decision 24.
- **No new code for stock:** a POS sale is never refused for it (decision 7).

```diff
@@ -206,6 +206,21 @@ export const AUDIT_ACTIONS = [
   'approval.approved',
   'approval.rejected',
   'approval.reopened',
+  // step 20a. claimed/released: a device took the register or let it go (the changes name the
+  // device). A sale arrives from a device, so its rows name the device too (step 18b).
+  // pos_sale.overridden: what the cashier did that needs pos.price.override (posOverridesOf),
+  // written whether or not the cashier had it. The sale is never refused for it.
+  // pos_sale.without_permission: the cashier no longer had pos.sale.create when the sale arrived
+  // (it was taken away while the device was offline). The sale is posted anyway (decision 28).
+  'pos_register.created',
+  'pos_register.updated',
+  'pos_register.archived',
+  'pos_register.restored',
+  'pos_register.claimed',
+  'pos_register.released',
+  'pos_sale.created',
+  'pos_sale.overridden',
+  'pos_sale.without_permission',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -258,6 +273,8 @@ export const AUDIT_ENTITY_TYPES = [
   'debit_note',
   'supplier_refund',
   'device',
+  'pos_register',
+  'pos_sale',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- **`pos_register.claimed` and `.released`** let an owner see which device held a counter when.
- **`pos_sale.overridden` is an action of its own,** not part of `pos_sale.created`, so the audit log's filter finds
  every override at once. **`pos_sale.without_permission`** is one for the same reason: a manager finds every sale
  made after a role lost `pos.sale.create` (decision 28).

```diff
@@ -15,6 +15,9 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // that is now waiting (document = an ApprovalDocument kind)
 // approval.approved / approval.rejected: params { document, id, number } — sent to the person who
 // submitted the document, when the last step approves it or any step rejects it
+// pos.sold_short: params { id, number, warehouse, count } — a POS sale (step 20a) took count
+// variants below zero in that warehouse; sent to the people who adjust stock, and the bell opens
+// the sale
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -28,6 +31,7 @@ export const NOTIFICATION_TYPES = [
   'approval.requested',
   'approval.approved',
   'approval.rejected',
+  'pos.sold_short',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

### `journal.ts`, `stock.ts`: the entry and the movements

```diff
@@ -36,6 +36,9 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // purchase_debit_note, purchase_refund (step 17d): a debit note takes money off what the company
 // owes a supplier (the payable, goods received not billed, the price difference, VAT input), and a
 // supplier refund is money a supplier paid back into a cash or bank account.
+// pos_sale (step 20a): a POS sale books everything in one entry: Dr each payment's account, Cr Sales
+// and VAT payable, and Dr Cost of goods sold / Cr Inventory for its goods. It moves stock, so it is
+// a stock document's entry too: only a POS return (step 20c) undoes it.
 export const JOURNAL_SOURCES = [
   'manual',
   'opening_balance',
@@ -56,6 +59,7 @@ export const JOURNAL_SOURCES = [
   'purchase_return',
   'purchase_debit_note',
   'purchase_refund',
+  'pos_sale',
 ] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
@@ -72,6 +76,7 @@ export const STOCK_JOURNAL_SOURCES = [
   'sales_return',
   'purchase_receipt',
   'purchase_return',
+  'pos_sale',
 ] as const satisfies readonly JournalSource[];
 export type StockJournalSource = (typeof STOCK_JOURNAL_SOURCES)[number];
 
```

- **`pos_sale` is in `STOCK_JOURNAL_SOURCES`** (decision 29). `PostingService` lets a stock document's entry touch the
  inventory account, and the journal page then links the entry to its document instead of offering Reverse.

```diff
@@ -14,6 +14,7 @@ import { levelSchema, quantitySchema } from './quantities.js';
 // sales_return (step 15d): goods a customer sent back.
 // purchase_receipt (step 17b): goods a supplier delivered against a purchase order.
 // purchase_return (step 17d): goods sent back to a supplier.
+// pos_sale (step 20a): goods sold at a POS counter.
 export const MOVEMENT_KINDS = [
   'adjustment',
   'transfer_out',
@@ -23,6 +24,7 @@ export const MOVEMENT_KINDS = [
   'sales_return',
   'purchase_receipt',
   'purchase_return',
+  'pos_sale',
 ] as const;
 export type MovementKind = (typeof MOVEMENT_KINDS)[number];
 
```

### `sales.ts`, `tax-rates.ts`: two helpers made public

```diff
@@ -32,10 +32,10 @@ export const DISCOUNT_TYPES = ['percent', 'amount'] as const;
 export type DiscountType = (typeof DISCOUNT_TYPES)[number];
 
 // At most 2 decimals: the line is worked out to the paisa, so ৳10.555 off could not be shown.
-// '' (an empty box) is no discount.
+// '' (an empty box) is no discount. Exported for the bill discount of a POS sale (step 20a).
 const DISCOUNT = /^\d{1,15}(?:\.\d{1,2})?$/;
 
-const discountSchema = z
+export const discountSchema = z
   .string()
   .trim()
   .refine((value) => value === '' || DISCOUNT.test(value), errorCode('money_format'))
```

```diff
@@ -28,14 +28,15 @@ export const taxRateSchema = z.object({
 });
 export type TaxRate = z.infer<typeof taxRateSchema>;
 
-// 0 to 99.99, at most 2 decimals: "15", "7.5". VAT is never 100% or more.
-const RATE = /^\d{1,2}(?:\.\d{1,2})?$/;
+// 0 to 99.99, at most 2 decimals: "15", "7.5". VAT is never 100% or more. Exported for a POS sale's
+// line (step 20a), which sends the rate the device used.
+export const TAX_RATE_FORMAT = /^\d{1,2}(?:\.\d{1,2})?$/;
 
 export const taxRateInputSchema = z
   .object({
     name: z.string().trim().min(2, errorCode('tax_rate_name_required')).max(60),
     kind: z.enum(TAX_RATE_KINDS),
-    rate: z.string().trim().regex(RATE, errorCode('tax_rate_format')),
+    rate: z.string().trim().regex(TAX_RATE_FORMAT, errorCode('tax_rate_format')),
     isDefault: z.boolean(),
   })
   // standard and reduced charge something; zero_rated and exempt charge nothing. A "standard 0%"
```

- **Exported, not copied.** The bill discount follows the line discount's rule (2 decimals, an empty box is none),
  and the line's rate the VAT rate form's. Two copies would one day disagree.

### `routes.ts`, `index.ts`

```diff
@@ -24,6 +24,7 @@ import { deliveryRoutes } from './deliveries.js';
 import { deviceRoutes } from './devices.js';
 import { documentOutputRoutes, publicDocumentRoutes } from './document-output.js';
 import { goodsReceiptRoutes } from './goods-receipts.js';
+import { posRoutes } from './pos.js';
 import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
@@ -135,4 +136,5 @@ export const routes = {
   supplierRefunds: supplierRefundRoutes,
   sync: syncRoutes,
   devices: deviceRoutes,
+  pos: posRoutes,
 };
```

```diff
@@ -25,6 +25,7 @@ export * from './money.js';
 export * from './notifications.js';
 export * from './numbering.js';
 export * from './pagination.js';
+export * from './pos.js';
 export * from './permissions.js';
 export * from './preferences.js';
 export * from './price-lists.js';
```

The OpenAPI document is generated from the routes. Run `pnpm --filter @omnivo/contracts gen:openapi`; it adds the
nine POS paths and the sync command's new shape to `packages/contracts/openapi.json`. Commit it as it is. (This guide
first forgot it; 20a.8's `pnpm test:openapi` found it: "openapi.json is out of date".)

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
```

All pass (contracts 310 tests, 17 new). Do not run the whole `pnpm typecheck` yet. Until their parts, these fail, as
expected: `packages/db` (the permission catalog has no text for the three new permissions, 20a.2), `packages/i18n`
(`en.ts` misses the new error codes, 20a.5), `apps/api` (the push does not know `pos_sale.create`, and the pull has no
loader for `pos_register`, 20a.3), `packages/sync` (no table for `pos_register`, 20a.6) and `apps/app` (the new
permissions, audit actions, bell, journal source, movement kind and command have no text yet, 20a.5 and 20a.6).

## 20a.2 — `packages/db`: registers, sales, and their rules

Five new tables in a new schema file, `pos.ts`. Migration 0051 is generated from the schema, with its indexes moved
up as in every step. Migration 0052 is written by hand: row-level security, the rules of a register, the database's
own release of a register (decision 38), the change log for the devices, the check at commit (decision 39), and the one
change to an older function: a POS sale's stock may go below zero (decision 7).

### `schema/pos.ts`: the five tables

```ts
import { DISCOUNT_TYPES, POS_PAPER_WIDTHS, POS_PAYMENT_METHODS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
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
import { batches } from './batches.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { salesLineColumns, totalColumns } from './sales-documents.js';
import { devices } from './sync.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 20a: the point of sale. A register is a counter; a POS sale is made on a device, already
// paid, and arrives as a sync command (pos_sale.create). The server writes the sale, its lines,
// the batches they left from and its payments in one go, and never changes them afterwards. The
// rules live in migration 0052.

// ---------------------------------------------------------------------------------------------
// Registers

// One counter: the warehouse its goods leave from and an account for each way of paying. Archived,
// never deleted: its sales point at it, and its code is in their numbers. deleted_at (from
// baseColumns) is not used, like warehouses.
export const posRegisters = pgTable(
  'pos_registers',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // "POS1": the first part of every receipt number. Never changes (migration 0052).
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Its branch is the warehouse's: no branch_id column that could say something else
    warehouseId: uuid('warehouse_id').notNull(),
    // The account each payment method goes into (a money account: the API checks that). Cash is
    // always there, because the change is given in cash; NULL = the register does not take it.
    cashAccountId: uuid('cash_account_id').notNull(),
    cardAccountId: uuid('card_account_id'),
    bkashAccountId: uuid('bkash_account_id'),
    nagadAccountId: uuid('nagad_account_id'),
    // The most a cashier may take off without pos.price.override: 10.00 = 10%
    maxDiscountPercent: numeric('max_discount_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    paperWidth: text('paper_width', { enum: POS_PAPER_WIDTHS }).notNull(),
    receiptFooter: text('receipt_footer'),
    // The device that holds it (decision 14); NULL = free. Set by a claim, cleared by a release,
    // and by the database itself when that device is revoked or moved to another branch (0052).
    deviceId: uuid('device_id'),
    // The highest number the server has received from it, accepted or refused; 0 = none yet. A
    // device that claims the register numbers from here + 1, so no number is given twice. Only
    // grows (0052). Written without touching version: a sale must not make a manager's edit of
    // the register fail on its version.
    lastNumber: integer('last_number').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // An archived register keeps its code: POS1-000123 on an old receipt means one counter
    uniqueIndex('pos_registers_tenant_code_idx').on(table.tenantId, table.code),
    // The target of the composite FK from pos_sales
    uniqueIndex('pos_registers_tenant_id_idx').on(table.tenantId, table.id),
    // A warehouse's registers (0052's trigger when a warehouse moves), and the FK's own check
    index('pos_registers_warehouse_idx').on(table.tenantId, table.warehouseId),
    // A device holds one register at most: the last word on pos_device_has_register
    uniqueIndex('pos_registers_device_idx')
      .on(table.tenantId, table.deviceId)
      .where(sql`${table.deviceId} IS NOT NULL`),
    foreignKey({
      name: 'pos_registers_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Devices are revoked, never deleted, so this never blocks anything
    foreignKey({
      name: 'pos_registers_device_fk',
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }),
    // No index for the four account FKs: a workspace has a few registers, so the check when an
    // account is deleted reads a few rows
    foreignKey({
      name: 'pos_registers_cash_account_fk',
      columns: [table.tenantId, table.cashAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'pos_registers_card_account_fk',
      columns: [table.tenantId, table.cardAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'pos_registers_bkash_account_fk',
      columns: [table.tenantId, table.bkashAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'pos_registers_nagad_account_fk',
      columns: [table.tenantId, table.nagadAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    // The contract's format: the code is split from the number at the hyphen
    check('pos_registers_code_check', sql`${table.code} ~ '^[A-Z][A-Z0-9]{1,7}$'`),
    check('pos_registers_discount_check', sql`${table.maxDiscountPercent} BETWEEN 0 AND 100`),
    check('pos_registers_paper_check', sql`${table.paperWidth} IN ('58', '80')`),
    check('pos_registers_last_number_check', sql`${table.lastNumber} >= 0`),
    // An archived register is held by no device: the last word on archiving a held one
    check(
      'pos_registers_archived_check',
      sql`${table.archivedAt} IS NULL OR ${table.deviceId} IS NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Sales

// A sale is posted when it arrives: there is no draft and no status. It never changes and is
// never deleted (0052); a return (step 20c) is a document of its own. version and updated_* (from
// baseColumns) stay as they were written, deleted_at is not used.
// created_by is the cashier: the device's person, who pushed it. created_at is when the server
// received it; sold_at is when it was sold, by the device's clock.
export const posSales = pgTable(
  'pos_sales',
  {
    // The id is made by the device (the command's saleId), so the receipt can point at it
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    registerId: uuid('register_id').notNull(),
    // Its place in the register's series, and the number it makes (formatPosNumber): stored, so
    // the list, the journal and the stock card show it without the register's code
    sequence: integer('sequence').notNull(),
    number: text('number').notNull(),
    // The day it is in the books (the device's day, or the first open day after it)
    date: date('date', { mode: 'string' }).notNull(),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull(),
    // NULL = walk-in
    customerId: uuid('customer_id'),
    // The register's warehouse when it was sold: a register may move to another warehouse later
    warehouseId: uuid('warehouse_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    // The bill's discount as typed (10 = 10% or ৳10), and what it came to in taka
    billDiscountType: text('bill_discount_type', { enum: DISCOUNT_TYPES }).notNull(),
    billDiscount: numeric('bill_discount', { precision: 19, scale: 4 }).notNull(),
    billDiscountAmount: numeric('bill_discount_amount', { precision: 19, scale: 4 }).notNull(),
    // discount = the lines' own discounts in taka; net, vat and total after both discounts
    ...totalColumns(),
    // What the customer handed over, all methods: the sum of the payments. paid − total is the
    // change given back in cash.
    paid: numeric('paid', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    // The target of the composite FKs from the lines and the payments
    uniqueIndex('pos_sales_tenant_id_idx').on(table.tenantId, table.id),
    // A number is never given twice (POS1-000123), whatever the devices did: the last word on
    // pos_number_taken. Also the search by number (a return in step 20c starts from one).
    uniqueIndex('pos_sales_tenant_number_idx').on(table.tenantId, table.number),
    uniqueIndex('pos_sales_register_sequence_idx').on(
      table.tenantId,
      table.registerId,
      table.sequence,
    ),
    // The list: newest date first, keyset on (date, id)
    index('pos_sales_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // The list filtered by register, in the same order
    index('pos_sales_register_idx').on(table.tenantId, table.registerId, table.date, table.id),
    // A customer's sales, and the customer FK's check on delete. Partial: most sales are walk-in.
    index('pos_sales_customer_idx')
      .on(table.tenantId, table.customerId, table.date, table.id)
      .where(sql`${table.customerId} IS NOT NULL`),
    foreignKey({
      name: 'pos_sales_register_fk',
      columns: [table.tenantId, table.registerId],
      foreignColumns: [posRegisters.tenantId, posRegisters.id],
    }),
    // No ON DELETE: a customer with a sale cannot be deleted (customer_in_use)
    foreignKey({
      name: 'pos_sales_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // Warehouses and devices are never deleted: no index for these two
    foreignKey({
      name: 'pos_sales_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'pos_sales_device_fk',
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }),
    check('pos_sales_sequence_check', sql`${table.sequence} >= 1`),
    check(
      'pos_sales_bill_discount_check',
      sql`${table.billDiscount} >= 0 AND (${table.billDiscountType} = 'amount' OR ${table.billDiscount} <= 100) AND ${table.billDiscountAmount} >= 0`,
    ),
    // Paid in full at the counter: never less than the total (decision 5)
    check(
      'pos_sales_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat} AND ${table.paid} >= ${table.total}`,
    ),
  ],
);

export const posSaleLines = pgTable(
  'pos_sale_lines',
  {
    ...salesLineColumns(),
    saleId: uuid('sale_id').notNull(),
    // The price the line started with on the device; NULL = there was none and it was typed
    startingPrice: numeric('starting_price', { precision: 19, scale: 4 }),
    // The line's share of the bill's discount; net, vat and total are after it
    billDiscount: numeric('bill_discount', { precision: 19, scale: 4 }).notNull(),
    // A batch product: the batch the device chose. Where the goods really left from is in
    // pos_sale_line_batches: this one, then others when it was short.
    batchId: uuid('batch_id'),
    // A serial product: what the scanner read, one per base unit
    serialNumbers: text('serial_numbers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // What the goods cost (step 14's value of its movements, a positive number), for the gross
    // margin and for a return (step 20c)
    value: numeric('value', { precision: 19, scale: 4 }).notNull(),
    // What the warehouse did not have when the sale was posted, in the base unit: the part that
    // went below zero (decision 7)
    shortQuantity: numeric('short_quantity', { precision: 19, scale: 4 }).notNull().default('0'),
    // The serial numbers that were not in the warehouse: they left without a serial
    shortSerials: text('short_serials')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (table) => [
    uniqueIndex('pos_sale_lines_line_idx').on(table.tenantId, table.saleId, table.lineNo),
    // The target of the line batches' FK: a line of THIS variant
    uniqueIndex('pos_sale_lines_variant_id_idx').on(table.tenantId, table.variantId, table.id),
    // "Does this product have sales?" (product_variant_in_use), and the variant FK's own check
    index('pos_sale_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // The "Sold short" list. Partial: almost every line had its stock.
    index('pos_sale_lines_short_idx')
      .on(table.tenantId, table.saleId)
      .where(sql`${table.shortQuantity} > 0 OR cardinality(${table.shortSerials}) > 0`),
    foreignKey({
      name: 'pos_sale_lines_sale_fk',
      columns: [table.tenantId, table.saleId],
      foreignColumns: [posSales.tenantId, posSales.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'pos_sale_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // A sales line's rules (sales_order_lines_amounts_check), with the bill's share
    check(
      'pos_sale_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.billDiscount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'pos_sale_lines_starting_price_check',
      sql`${table.startingPrice} IS NULL OR ${table.startingPrice} >= 0`,
    ),
    check('pos_sale_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
    check('pos_sale_lines_value_check', sql`${table.value} >= 0`),
    // Never short of more than was sold, and a short serial is one the scanner read
    check(
      'pos_sale_lines_short_check',
      sql`${table.shortQuantity} BETWEEN 0 AND ${table.baseQuantity} AND ${table.shortSerials} <@ ${table.serialNumbers}`,
    ),
  ],
);

// The batches a batch product's line left from, in the base unit: the device's batch first, then
// the others first-expiry-first-out when it was short (decision 15). A line has one row per batch
// it touched, and none for a product without batches. The rows add up to the line's base quantity
// (0052).
export const posSaleLineBatches = pgTable(
  'pos_sale_line_batches',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    lineId: uuid('line_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'pos_sale_line_batches_pkey',
      columns: [table.tenantId, table.lineId, table.batchId],
    }),
    // variant_id is in both keys: the batch is of the line's own variant
    foreignKey({
      name: 'pos_sale_line_batches_line_fk',
      columns: [table.tenantId, table.variantId, table.lineId],
      foreignColumns: [posSaleLines.tenantId, posSaleLines.variantId, posSaleLines.id],
    }),
    foreignKey({
      name: 'pos_sale_line_batches_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check('pos_sale_line_batches_quantity_check', sql`${table.quantity} > 0`),
  ],
);

// How the customer paid: cash and a card, or bKash with the rest in cash
export const posSalePayments = pgTable(
  'pos_sale_payments',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    saleId: uuid('sale_id').notNull(),
    // The order the cashier took them in
    lineNo: smallint('line_no').notNull(),
    method: text('method', { enum: POS_PAYMENT_METHODS }).notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // The card's last 4 digits or approval code, the bKash or Nagad TrxID
    reference: text('reference'),
    // The register's account for the method when the sale was posted: a later change of the
    // register does not move old money
    accountId: uuid('account_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'pos_sale_payments_pkey',
      columns: [table.tenantId, table.saleId, table.lineNo],
    }),
    // The account FK's check when an account is deleted: a busy counter has thousands of rows
    index('pos_sale_payments_account_idx').on(table.tenantId, table.accountId),
    foreignKey({
      name: 'pos_sale_payments_sale_fk',
      columns: [table.tenantId, table.saleId],
      foreignColumns: [posSales.tenantId, posSales.id],
    }),
    foreignKey({
      name: 'pos_sale_payments_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    check(
      'pos_sale_payments_method_check',
      sql`${table.method} IN ('cash', 'card', 'bkash', 'nagad')`,
    ),
    check('pos_sale_payments_amount_check', sql`${table.amount} > 0`),
  ],
);
```

**`pos_registers`:**

- **No `branch_id`** (decision 17). A register's branch is read through its warehouse, so the two cannot disagree. The
  code that needs the branch (the pull, a claim) joins `warehouses`.
- **Four account columns, not one JSON field.** Each has a real foreign key to `ledger_accounts`, so an account with a
  register on it cannot be deleted, and another workspace's account cannot be named. `cash_account_id` is `NOT NULL`:
  change is given in cash (decision 18). No index on them: a workspace has a few registers, so the foreign key's check
  when an account is deleted reads a few rows.
- **`max_discount_percent` is `numeric(5,2)`,** like `tax_rate`: "12.50" at most 100. The contract sends it as a string,
  so it never becomes a JavaScript number.
- **`paper_width` is text with a check,** `'58'` or `'80'`, the contract's `POS_PAPER_WIDTHS`. The `{ enum }` on the
  column only types it in TypeScript; the check is what stops a bad value in the database.
- **`device_id` is the holder** (decision 14). The partial unique index `pos_registers_device_idx` lets a device hold one
  register at most (decision 32): two claims at the same moment by one device, the second fails here whatever the API
  read first. Partial, because many registers are free (`NULL`), and `NULL`s would never collide anyway; the `WHERE`
  keeps the free ones out of the index.
- **`last_number` is a plain integer** (decision 37). 2,147,483,647 sales on one counter is far beyond any shop. The
  check keeps it at 0 or more; 0052 keeps it from going down.
- **`pos_registers_code_check` repeats the contract's rule.** The receipt number is the code, a hyphen and the sequence,
  so a hyphen or a small letter in the code would make a number that cannot be read back.
- **`pos_registers_archived_check`:** an archived register has no holder. The API refuses to archive a held one
  (`pos_register_in_use`, decision 33); this is the last word.
- **The unique code index includes the archived registers,** on purpose (decision 16): an old receipt's `POS1` must mean
  one counter forever.

**`pos_sales`:**

- **The id comes from the device** (the command's `saleId`, 20a.1). `baseColumns()` gives a UUIDv7 only when none is
  passed. The receipt and, in 20c, a return point at this id.
- **No `status`.** A sale is posted when it is written (decision 21); there is no draft. `version`, `updated_at` and
  `updated_by` stay as the insert wrote them, because the sale never changes (0052).
- **`created_by` is the cashier,** as for every document: the person whose device pushed it. No `cashier_id` of its own;
  one device is one person (decision 4).
- **`sequence` and `number` are both stored.** `sequence` is what the uniqueness and the last number are about;
  `number` is what the list, the journal (`document_number`), the stock card and the receipt show, without the
  register's code.
- **Two unique indexes for one number.** `pos_sales_register_sequence_idx` is the rule (a register gives a number once:
  the last word on `pos_number_taken`). `pos_sales_tenant_number_idx` is the lookup by number (the list's search, and
  a return in 20c), and it is unique as well because codes never repeat.
- **`warehouse_id` is stored** (decision 42), while the branch is still read through the warehouse: a warehouse with
  stock movements cannot move to another branch (step 13's `warehouse_branch_locked`), and a posted sale has
  movements.
- **`paid` is stored, the change is not.** The change is `paid − total`. With `paid` on the header, the check at commit
  can say the payments add up to it exactly, which catches a payment added to the sale later.
- **`bill_discount` as typed, and `bill_discount_amount` in taka.** The receipt and the page show "10%" and "৳58.65";
  the sum of the lines' shares must equal the amount (0052, decision 39).
- **`pos_sales_totals_check`:** besides the usual totals rule, `paid >= total`. A POS sale is paid in full at the
  counter (decision 5).
- **The indexes follow the reads:** the list (newest date first, keyset on date and id, like every document), the list
  of one register, and one customer's sales. The customer index is partial: most sales are walk-in, and a `NULL`
  customer is never looked up. No index for the device and warehouse foreign keys: devices and warehouses are never
  deleted, so their foreign keys never need to look a sale up.

**`pos_sale_lines`:**

- **`salesLineColumns()`** gives the usual sales line (step 15b): the product, the quantity in its unit and in the base
  unit, the price and discount as typed, a copy of the VAT rate, and net, VAT and total. A POS line adds:
  `starting_price` (decision 25), `bill_discount` (its share, decision 23), the device's batch and the serial numbers
  the scanner read, `value` (the cost of its goods, decision 41), and what was short.
- **net, vat and total are after the bill's share.** So the lines add up to the header, and each line's VAT is what the
  customer paid on it.
- **`pos_sale_lines_variant_id_idx` (`tenant_id, variant_id, id`)** is there for the line batches' foreign key, which
  carries the variant: a batch row can only be of its line's own product.
- **`pos_sale_lines_short_idx` is the "Sold short" list.** Partial: almost every line had its stock, so the index stays
  tiny. A short serial counts too, even when the quantity did not go below zero.
- **`pos_sale_lines_short_check`:** short not more than the line's quantity, and every short serial is one the scanner
  read (`<@` is "is contained in" for arrays).
- **No `ON DELETE CASCADE` from the sale,** unlike a draft document's lines: a sale is never deleted.

**`pos_sale_line_batches`** (decision 40):

- **The key is the line and the batch,** so a line names each batch once. Each foreign key carries `variant_id`, the
  same trick as the stock tables (step 13): the batch and the line are both of this variant, checked by the database.
- **`quantity > 0`, in the base unit.** The batch that went below zero has its whole share here, the missing part
  included; the line's `short_quantity` says how much of it was missing.

**`pos_sale_payments`:**

- **The key is the sale and a line number,** the order the cashier took them in, as on the receipt. Two cash payments
  are allowed (the customer handed over ৳500, then another ৳100).
- **`account_id` is a copy of the register's account at that moment.** A register changed later (a new bKash account)
  does not move old money; the journal entry already used this account.
- **`pos_sale_payments_account_idx`:** a busy counter has thousands of payment rows. Without it, deleting any unused
  account would read them all to check the foreign key.
- **The method check repeats the contract's four methods** in the database, like `paper_width`.

### `schema/journal.ts`: the entry may point at a sale

```diff
@@ -79,12 +79,12 @@ export const journalEntries = pgTable(
     // A document's entry (a stock document's, a delivery's since step 15b, an invoice's and a
     // receipt's since 15c, a sales return's, a credit note's and a refund's since 15d, a goods
     // receipt's since 17b, a bill's and a supplier payment's since 17c, a purchase return's, a
-    // debit note's and a supplier refund's since 17d) always points at its document, and no other
-    // entry does. The list is
+    // debit note's and a supplier refund's since 17d, a POS sale's since 20a) always points at its
+    // document, and no other entry does. The list is
     // contracts' DOCUMENT_JOURNAL_SOURCES.
     check(
       'journal_entries_document_check',
-      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
     ),
     // A document's entries (a transfer has up to two; an invoice or a receipt has one, which the
     // invoice page and the receipt page find here)
```

- **`pos_sale` joins the list of sources whose entry points at a document** (decision 29). The check is the contract's
  `DOCUMENT_JOURNAL_SOURCES`, written out, because a check cannot import TypeScript. Without this line, the entry of a
  sale would be refused for having a `document_id`.

### `schema/index.ts`, `permission-catalog.ts`

```diff
@@ -50,3 +50,4 @@ export * from './purchase-returns.js';
 export * from './debit-notes.js';
 export * from './supplier-refunds.js';
 export * from './sync.js';
+export * from './pos.js';
```

```diff
@@ -53,6 +53,11 @@ const DESCRIPTIONS = {
   'purchase.return.manage': 'Write and post purchase returns, which send stock back to suppliers',
   'purchase.debit_note.manage': 'Write and post debit notes, and apply their money to bills',
   'purchase.refund.manage': 'Record money suppliers paid back, and void supplier refunds',
+  'pos.sale.create': 'Sell at a POS register, and take a free register for this device',
+  'pos.price.override':
+    "Change a price at the POS, or give more discount than the register's limit",
+  'pos.register.manage':
+    'Add, edit and archive POS registers, with their warehouse, accounts and receipt',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- **The three descriptions fill the `permissions` table.** The `satisfies Record<PermissionKey, string>` has failed the
  db type check since 20a.1 until these lines were there. `pnpm db:migrate` inserts the new keys after the migrations
  (`syncPermissions()`); no migration is needed for them.
- **The role templates are not here.** They live in `apps/api/src/setup/templates.ts` and change in 20a.3.

### Migration 0051 (generated, then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name pos-sales`. As in every step, `drizzle-kit` writes the foreign keys
before the unique indexes they point at (`pos_registers_tenant_id_idx`, `pos_sales_tenant_id_idx`,
`pos_sale_lines_variant_id_idx`), and the migration fails with "there is no unique constraint matching given keys".
Move every `CREATE INDEX` and `CREATE UNIQUE INDEX` up, before the first `ADD CONSTRAINT … FOREIGN KEY`. The result:

```sql
CREATE TABLE "pos_registers" (
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
	"warehouse_id" uuid NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"card_account_id" uuid,
	"bkash_account_id" uuid,
	"nagad_account_id" uuid,
	"max_discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"paper_width" text NOT NULL,
	"receipt_footer" text,
	"device_id" uuid,
	"last_number" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pos_registers_code_check" CHECK ("pos_registers"."code" ~ '^[A-Z][A-Z0-9]{1,7}$'),
	CONSTRAINT "pos_registers_discount_check" CHECK ("pos_registers"."max_discount_percent" BETWEEN 0 AND 100),
	CONSTRAINT "pos_registers_paper_check" CHECK ("pos_registers"."paper_width" IN ('58', '80')),
	CONSTRAINT "pos_registers_last_number_check" CHECK ("pos_registers"."last_number" >= 0),
	CONSTRAINT "pos_registers_archived_check" CHECK ("pos_registers"."archived_at" IS NULL OR "pos_registers"."device_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "pos_sale_line_batches" (
	"tenant_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	CONSTRAINT "pos_sale_line_batches_pkey" PRIMARY KEY("tenant_id","line_id","batch_id"),
	CONSTRAINT "pos_sale_line_batches_quantity_check" CHECK ("pos_sale_line_batches"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_sale_lines" (
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
	"sale_id" uuid NOT NULL,
	"starting_price" numeric(19, 4),
	"bill_discount" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"value" numeric(19, 4) NOT NULL,
	"short_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"short_serials" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "pos_sale_lines_quantity_check" CHECK ("pos_sale_lines"."quantity" > 0 AND "pos_sale_lines"."factor" > 0 AND "pos_sale_lines"."base_quantity" > 0),
	CONSTRAINT "pos_sale_lines_amounts_check" CHECK ("pos_sale_lines"."unit_price" >= 0 AND "pos_sale_lines"."discount" >= 0 AND ("pos_sale_lines"."discount_type" = 'amount' OR "pos_sale_lines"."discount" <= 100) AND "pos_sale_lines"."bill_discount" >= 0 AND "pos_sale_lines"."net" >= 0 AND "pos_sale_lines"."vat" >= 0 AND "pos_sale_lines"."total" = "pos_sale_lines"."net" + "pos_sale_lines"."vat"),
	CONSTRAINT "pos_sale_lines_starting_price_check" CHECK ("pos_sale_lines"."starting_price" IS NULL OR "pos_sale_lines"."starting_price" >= 0),
	CONSTRAINT "pos_sale_lines_tax_rate_check" CHECK ("pos_sale_lines"."tax_rate" >= 0 AND "pos_sale_lines"."tax_rate" < 100),
	CONSTRAINT "pos_sale_lines_value_check" CHECK ("pos_sale_lines"."value" >= 0),
	CONSTRAINT "pos_sale_lines_short_check" CHECK ("pos_sale_lines"."short_quantity" BETWEEN 0 AND "pos_sale_lines"."base_quantity" AND "pos_sale_lines"."short_serials" <@ "pos_sale_lines"."serial_numbers")
);
--> statement-breakpoint
CREATE TABLE "pos_sale_payments" (
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reference" text,
	"account_id" uuid NOT NULL,
	CONSTRAINT "pos_sale_payments_pkey" PRIMARY KEY("tenant_id","sale_id","line_no"),
	CONSTRAINT "pos_sale_payments_method_check" CHECK ("pos_sale_payments"."method" IN ('cash', 'card', 'bkash', 'nagad')),
	CONSTRAINT "pos_sale_payments_amount_check" CHECK ("pos_sale_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"customer_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"prices_include_vat" boolean NOT NULL,
	"bill_discount_type" text NOT NULL,
	"bill_discount" numeric(19, 4) NOT NULL,
	"bill_discount_amount" numeric(19, 4) NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"paid" numeric(19, 4) NOT NULL,
	CONSTRAINT "pos_sales_sequence_check" CHECK ("pos_sales"."sequence" >= 1),
	CONSTRAINT "pos_sales_bill_discount_check" CHECK ("pos_sales"."bill_discount" >= 0 AND ("pos_sales"."bill_discount_type" = 'amount' OR "pos_sales"."bill_discount" <= 100) AND "pos_sales"."bill_discount_amount" >= 0),
	CONSTRAINT "pos_sales_totals_check" CHECK ("pos_sales"."discount" >= 0 AND "pos_sales"."net" >= 0 AND "pos_sales"."vat" >= 0 AND "pos_sales"."total" = "pos_sales"."net" + "pos_sales"."vat" AND "pos_sales"."paid" >= "pos_sales"."total")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_tenant_code_idx" ON "pos_registers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_tenant_id_idx" ON "pos_registers" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "pos_registers_warehouse_idx" ON "pos_registers" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_device_idx" ON "pos_registers" USING btree ("tenant_id","device_id") WHERE "pos_registers"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_lines_line_idx" ON "pos_sale_lines" USING btree ("tenant_id","sale_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_lines_variant_id_idx" ON "pos_sale_lines" USING btree ("tenant_id","variant_id","id");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_variant_idx" ON "pos_sale_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_short_idx" ON "pos_sale_lines" USING btree ("tenant_id","sale_id") WHERE "pos_sale_lines"."short_quantity" > 0 OR cardinality("pos_sale_lines"."short_serials") > 0;--> statement-breakpoint
CREATE INDEX "pos_sale_payments_account_idx" ON "pos_sale_payments" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_tenant_id_idx" ON "pos_sales" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_tenant_number_idx" ON "pos_sales" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_register_sequence_idx" ON "pos_sales" USING btree ("tenant_id","register_id","sequence");--> statement-breakpoint
CREATE INDEX "pos_sales_tenant_date_idx" ON "pos_sales" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_sales_register_idx" ON "pos_sales" USING btree ("tenant_id","register_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_sales_customer_idx" ON "pos_sales" USING btree ("tenant_id","customer_id","date","id") WHERE "pos_sales"."customer_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_cash_account_fk" FOREIGN KEY ("tenant_id","cash_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_card_account_fk" FOREIGN KEY ("tenant_id","card_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_bkash_account_fk" FOREIGN KEY ("tenant_id","bkash_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_nagad_account_fk" FOREIGN KEY ("tenant_id","nagad_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_line_batches" ADD CONSTRAINT "pos_sale_line_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_line_batches" ADD CONSTRAINT "pos_sale_line_batches_line_fk" FOREIGN KEY ("tenant_id","variant_id","line_id") REFERENCES "public"."pos_sale_lines"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_line_batches" ADD CONSTRAINT "pos_sale_line_batches_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."pos_sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."pos_sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."pos_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));
```

- **Five new tables:** creating them takes no time and locks nothing that exists.
- **The journal check is dropped and added again.** Adding it reads every journal entry once to validate it, while it
  holds a lock that stops writes to `journal_entries`. Every row passes (no entry has the new source yet). On a large
  journal this takes a few seconds; run the migration outside office hours.
- `meta/_journal.json`, `meta/0051_snapshot.json` and `meta/0052_snapshot.json` change too. They are generated; commit
  them as they are.

### Migration 0052 (custom): the rules

Run `pnpm --filter @omnivo/db generate --custom --name pos-sales-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The five new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_registers', 'pos_sales', 'pos_sale_lines', 'pos_sale_line_batches', 'pos_sale_payments'
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

-- 2) A register is archived, never deleted: its sales point at it and its code is in their numbers
REVOKE DELETE ON pos_registers FROM omnivo_app;

-- 3) The rules of a register that keep a receipt number from being given twice:
--    - its code never changes: it is the first part of every number the register gave;
--    - its last number only grows: a claim numbers on from it;
--    - the device that holds it is active and in the register's branch (its warehouse's). Checked
--      when a device takes it, and when a held register moves to another warehouse. Both rows are
--      read FOR SHARE: a revoke or a move of the device, or a move of the warehouse, that is running
--      at the same moment finishes first, and this check sees its result (sections 4 and 5).
CREATE FUNCTION pos_registers_guard() RETURNS trigger
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

CREATE TRIGGER pos_registers_guard
  BEFORE INSERT OR UPDATE ON pos_registers
  FOR EACH ROW EXECUTE FUNCTION pos_registers_guard();

-- 4) A device that is revoked or moved to another branch lets go of its register at once, whoever
--    revoked or moved it (the device's person, a manager, removing the member). A revoked device
--    never pushes again, so a sale it did not send is lost with it (decision 14: a lost PC is
--    revoked), and the next device may number on. Step 18c moves a device only when nothing waits
--    on it. version is left as it is: the register's form does not change who holds it, so a
--    manager's open form must not fail on it.
CREATE FUNCTION devices_pos_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pos_registers
     SET device_id = NULL
   WHERE tenant_id = NEW.tenant_id AND device_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER devices_pos_release
  AFTER UPDATE OF revoked_at, branch_id ON devices
  FOR EACH ROW
  WHEN ((OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) OR OLD.branch_id <> NEW.branch_id)
  EXECUTE FUNCTION devices_pos_release();

-- 5) A warehouse that moves to another branch takes its registers with it (a register's branch is
--    its warehouse's). Refused while one of them is held: its device stays in the old branch and
--    may still have sales to send. A free one moves, and the devices of both branches hear about
--    it here: the register row itself did not change, so its own triggers log nothing. The API
--    already refuses to move a warehouse with stock movements (warehouse_branch_locked), so this
--    is rare: a new warehouse set up in the wrong branch.
CREATE FUNCTION warehouses_pos_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pos_registers r
     WHERE r.tenant_id = NEW.tenant_id AND r.warehouse_id = NEW.id AND r.device_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'warehouse % has a POS register a device holds', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'warehouses_register_held';
  END IF;
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT r.tenant_id, 'pos_register', r.id::text
    FROM pos_registers r
   WHERE r.tenant_id = NEW.tenant_id AND r.warehouse_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER warehouses_pos_branch
  AFTER UPDATE OF branch_id ON warehouses
  FOR EACH ROW
  WHEN (OLD.branch_id <> NEW.branch_id)
  EXECUTE FUNCTION warehouses_pos_branch();

-- 6) The devices keep the registers of their branch (pos_register, step 18a's change log). An
--    insert and a delete use 0044's sync_log. An update is logged only when something other than
--    last_number and updated_at changed: every sale moves the last number (section 7), and the
--    device does not keep it (syncPosRegisterSchema), so logging it would send the row again after
--    every sale for nothing. to_jsonb(row) minus those two keys compares every other column, also
--    the ones a later step adds.
CREATE TRIGGER pos_registers_sync_insert
  AFTER INSERT ON pos_registers
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log('pos_register', 'r.id::text', 'true', 'NULL');

CREATE TRIGGER pos_registers_sync_delete
  AFTER DELETE ON pos_registers
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log('pos_register', 'r.id::text', 'true', 'NULL');

CREATE FUNCTION sync_log_pos_registers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT n.tenant_id, 'pos_register', n.id::text
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
   WHERE to_jsonb(n) - ARRAY['last_number', 'updated_at']
         IS DISTINCT FROM to_jsonb(o) - ARRAY['last_number', 'updated_at'];
  RETURN NULL;
END $$;

CREATE TRIGGER pos_registers_sync_update
  AFTER UPDATE ON pos_registers
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_pos_registers();

-- 7) A sale moves its register's last number up to its own, in the same transaction, whoever
--    writes it. So the next device that claims the register can never start at a number a sale
--    already has. The API moves it for a refused sale too (its number was printed), which this
--    trigger cannot see.
CREATE FUNCTION pos_sales_last_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pos_registers
     SET last_number = NEW.sequence
   WHERE tenant_id = NEW.tenant_id AND id = NEW.register_id AND last_number < NEW.sequence;
  RETURN NULL;
END $$;

CREATE TRIGGER pos_sales_last_number
  AFTER INSERT ON pos_sales
  FOR EACH ROW EXECUTE FUNCTION pos_sales_last_number();

-- 8) A POS sale is posted the moment it is written, and never changes: no line, batch or payment
--    is changed or removed. A wrong sale is put right by a return (step 20c), like a posted
--    document by another document.
CREATE FUNCTION pos_sales_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a POS sale cannot be changed or deleted; a return brings the goods back'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sales_immutable';
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['pos_sales', 'pos_sale_lines', 'pos_sale_line_batches', 'pos_sale_payments'])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION pos_sales_immutable()',
      t || '_immutable', t
    );
  END LOOP;
END $$;

-- 9) A sale adds up, checked at COMMIT like a journal entry (0016): by then every line, batch and
--    payment is in place, whatever order the code wrote them in. The header's totals are the sums
--    of its lines; it has a payment, the payments add up to what was paid, and no more than the
--    total was paid by anything but cash (only cash gives change); a batch product's line left
--    from batches that add up to its quantity. A line or a payment added to an old sale later
--    fires this too, and fails it. It runs once per row written, so a sale of 50 lines is checked
--    about 50 times at its commit: a few thousand rows read, once per sale.
CREATE FUNCTION pos_sale_check(p_tenant uuid, p_sale uuid) RETURNS void
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

-- The sale each kind of row belongs to. IF, not CASE: a CASE would read NEW.sale_id on a
-- pos_sales row, which has no such field, and fail.
CREATE FUNCTION pos_sales_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sale uuid;
BEGIN
  IF TG_TABLE_NAME = 'pos_sales' THEN
    v_sale := NEW.id;
  ELSIF TG_TABLE_NAME = 'pos_sale_line_batches' THEN
    SELECT l.sale_id INTO v_sale
      FROM pos_sale_lines l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.line_id;
  ELSE
    v_sale := NEW.sale_id;
  END IF;
  PERFORM pos_sale_check(NEW.tenant_id, v_sale);
  RETURN NULL;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['pos_sales', 'pos_sale_lines', 'pos_sale_line_batches', 'pos_sale_payments'])
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION pos_sales_complete()',
      t || '_complete', t
    );
  END LOOP;
END $$;

-- 10) A POS sale is never refused for stock (decision 7): the money was taken and the receipt
--     printed. So its movements may take a warehouse below zero even when the workspace does not
--     allow it, and even on a batch (decision 15: what is missing goes below zero on the device's
--     batch). Every other document keeps 0022's rule. The rest is 0024's function as it was.
--     A serial number is still never sold twice: the API leaves the serial off a line whose serial
--     is not in this warehouse, so serials_not_here never fires for a sale.
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

    IF v_balance < 0 AND NEW.quantity < 0 AND NEW.kind <> 'pos_sale' THEN
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
```

- **Section 1** is the loop of every step: row-level security on, forced, and the `tenant_isolation` policy on the five
  tables. The RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`) fails for any tenant table without it.
- **Section 2:** the API's role loses `DELETE` on registers, like devices (step 18a). There is no delete route; this
  makes sure a bug cannot add one.
- **Section 3, the register's guard.** `pos_registers_code_locked` and `pos_registers_last_number_grows` are the two
  rules that keep a printed number from coming back (decisions 16 and 37). The holder check runs only when the holder
  or the warehouse changes, so a sale moving the last number does not read two more rows. Both rows are read `FOR
  SHARE`: a revoke (an `UPDATE` of the device) that is running waits for this claim to finish, or this claim waits for
  the revoke and then sees the device as revoked. Without the lock, both could pass at the same time and a revoked
  device would hold the register. A device or warehouse that does not exist is left to the foreign keys, which give
  their own error. The errors use `check_violation` with a constraint name, like every guard here, so the API catches
  them with `isCheckViolation()`.
- **Section 4, the release** (decision 38). An `AFTER UPDATE OF revoked_at, branch_id` trigger with a `WHEN`: a rename
  or a pull's `last_sync_at` does not even call the function. The `UPDATE` it runs goes through the register's own
  triggers, so the devices hear that the register is free. It leaves `version` alone: who holds a register is not
  part of the register's form, so a manager's open form must not fail on it.
- **A note on lock order for the API (20a.3):** a revoke locks the device, then (here) the register. A claim must lock
  in the same order, the device first (`FOR SHARE`, before its `UPDATE` of the register), or a claim and a revoke at the
  same moment could each wait for the other, and Postgres would end one of them with a deadlock error.
- **Section 5, a warehouse that moves.** Refused while a register on it is held; a free register moves with it. The
  register row does not change, so this trigger writes the change log lines itself: the old branch's devices must drop
  the register, and the new branch's devices must get it.
- **Section 6, the change log.** Insert and delete use step 18a's `sync_log()` as they are. The update has its own
  function, because `sync_log()` cannot compare the row before and after. `to_jsonb(n) - ARRAY[...]` turns each row
  into JSON without the two keys and compares the rest, so a column added in a later step is compared too, without
  anyone remembering to add it here. `updated_at` is left out with `last_number` because Drizzle's `$onUpdate` writes
  it on every update, also one that only moves the last number.
- **Section 7, the last number.** One `UPDATE` per sale, with `last_number < NEW.sequence` in the `WHERE`: a sale that
  arrives late with a lower number (it waited longer in an outbox) changes nothing, and the guard of section 3 would
  refuse a step down anyway. The push locks the register row here; 20a.3 takes the device first, for the order above.
- **Section 8:** the sale and its three child tables refuse every `UPDATE` and `DELETE`. Unlike a posted invoice, a sale
  has no field that may still change, so one function serves all four tables.
- **Section 9, the check at commit** (decision 39). A `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` runs at
  `COMMIT`, when every line, batch and payment is there, whatever order the API wrote them in. It fires on an insert
  into any of the four tables, so a line or a payment added to an old sale in a later transaction checks that sale
  again and fails. `pos_sales_complete()` finds the sale with `IF`, because each kind of row reaches it differently.
  The three constraint names tell the tests (and a log) which rule failed. The cost is small: a 50-line sale is
  checked about 50 times at its commit, each a sum over its own lines by the line index.
- **Section 10, below zero** (decisions 7 and 15). The whole of 0024's `stock_movements_apply()`, with one change:
  `AND NEW.kind <> 'pos_sale'` in the "would go below zero" test. `CREATE OR REPLACE` keeps the trigger that calls it.
  The serial checks stay: the API sends a serial only when it is in this warehouse, and a serial is never sold twice.
  Every other document keeps the old rule, also for batches.

> **What we checked.** On a throwaway Postgres with every migration up to 0052, as `omnivo_app`, in one transaction
> that rolls back (69 checks). The three permissions were in the table. A register was logged for the devices when it
> was made; a small-letter code, a hyphen, a taken code, a limit over 100, an `'76'` paper, another workspace's
> warehouse, an unknown account and a register without cash were each refused by their own rule. A device took a
> register (logged); took a second one (`pos_registers_device_idx`); a device of another branch, a revoked one and
> another workspace's were refused. The code could not change, the last number could not go down or below 0, a held
> register could not be archived, and no register could be deleted. Moving the last number (with `updated_at`) wrote no
> change log line; changing the footer did. A held register moved to a warehouse of its own branch, not of another.
> Moving the device to another branch, and revoking another device, let go of their registers (logged); renaming a
> device or a pull did not. A warehouse with a held register could not move; a free one moved and logged its register,
> which the new branch's device could then take.
>
> A sale of three lines went in: 17 strips of Napa (10 and 5 on two batches, 2 short on the device's batch), 4 bags of
> rice with 3 on hand, and two phones, one serial here and one in another branch (left without its serial), paid ৳40,000
> by card and ৳9,000 in cash. The stock went to −2, 0, −1 and −1 with negative stock off; the serial here left, the other
> stayed where it was. The journal check took a `pos_sale` entry with its document and refused one without. At the
> commit point the sale passed; the last number moved to 7 with no change log line; three lines were on the "Sold short"
> list. An adjustment still could not go below zero, nor a batch with negative stock on, nor a POS sale's serial that is
> elsewhere (`serials_not_here`). The sale, a line, a batch row and a payment could not be changed or deleted; a line or
> a payment added later failed at commit. A number given twice in a register, or the same number on another register,
> was refused. At commit, a sale without lines, with lines that do not add up, without a payment, with payments that do
> not add up, with a card paying more than the total, and with batches that do not add up to the line were each refused
> by their own rule, and so were paying less than the total, sequence 0, a short larger than the line, a short serial
> the scanner did not read, a batch of another product and a cheque. A later sale with a lower number left the last
> number at 7. The other workspace saw none of the rows, changed none and could not add one.
>
> Four races, each with two sessions, the second starting while the first held its transaction: a claim, then a revoke
> of the same device (the revoke waited, then let go of the register); a revoke, then a claim (the claim waited, then
> was refused); a claim, then the warehouse's move to another branch (the move waited, then was refused); the move, then
> a claim (the claim waited, then was refused).
>
> The API's stock, valuation and RLS coverage suites pass with 0051 and 0052. The sync and device suites fail where a
> test pulls with `protocol: '1'`: the 20a.1 contract asks for 2, and those tests change in 20a.4.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
pnpm --filter @omnivo/db build
```

`pnpm db:migrate` applies 0051 and 0052 to your dev database and adds the three permissions. The build lets the API see
the new tables in 20a.3. Do not run the whole `pnpm typecheck` yet: the API, i18n, sync and app packages still fail as
listed at the end of 20a.1, until their parts.

## 20a.3 — `apps/api`: registers, the sale's posting, the pull

The API gets a new module, `pos/`: the registers' routes (set up, claim, release), the POS sales list and page, and
the "Sold short" list. A sale itself is never written through a route (decision 21): it arrives in the sync's push as a
`pos_sale.create` command, and `PosSalesService.createFromDevice()` posts it. Around it, a few existing services learn
something new: the stock posting can take a sale below zero, the stock books can book a sale and its cost in one entry,
the period lock can say which day a sale goes on, and the pull sends the registers.

The order below is the order to write it in: what the new module uses first, then the module, then the wiring.

### `journal/period-lock.service.ts`: the first open day

```diff
@@ -74,6 +74,20 @@ export async function assertPeriodOpen(tx: Transaction, date: string): Promise<v
   }
 }
 
+// Step 20a: the day a POS sale is booked on. The sale was paid and printed on `date`, so it is
+// never refused for it: a closed period moves it to the day after the lock date. The same shared
+// lock as assertPeriodOpen(), taken first, so the lock date cannot move between this answer and
+// the posting (which takes the lock again; a lock already held is granted at once).
+export async function firstOpenDay(tx: Transaction, date: string): Promise<string> {
+  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockKey()}, 0))`);
+  const lockDate = (await readLock(tx))?.lockDate ?? null;
+  if (lockDate === null || date > lockDate) return date;
+  // Day arithmetic in UTC: a date has no time zone, and UTC has no summer time to skip a day
+  const next = new Date(`${lockDate}T00:00:00Z`);
+  next.setUTCDate(next.getUTCDate() + 1);
+  return next.toISOString().slice(0, 10);
+}
+
 @Injectable()
 export class PeriodLockService {
   constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}
```

- **A sale is never refused for its date** (decision 26). `assertPeriodOpen()` refuses a closed day; this answers the
  day after the lock date instead. The caller has already moved a date after today back to today.
- **The shared advisory lock comes first,** the same one `assertPeriodOpen()` takes. Without it, someone could move the
  lock date between this answer and the posting, and the posting would then be refused with `journal_period_locked`,
  which a POS sale must never get. The posting takes the lock again later; Postgres grants a lock the transaction
  already holds at once.
- **The day after is worked out in UTC.** `lockDate` is a plain date. `new Date('2026-06-30T00:00:00Z')` plus one day
  in UTC is always `2026-07-01`; in local time a summer-time change could make one day 23 or 25 hours long.

### `inventory/stock-posting.service.ts`: a sale that may go below zero

```diff
@@ -95,6 +95,35 @@ export interface StockPosting {
   // A transfer's receipt: its serial numbers are on that transfer's lines, in transit, not "in
   // stock somewhere else"
   receivingTransferId?: string;
+  // Step 20a: a POS sale, which is never refused for stock (decision 7). planSale() already worked
+  // out where its goods leave from and what is missing; what is missing goes below zero.
+  belowZero?: boolean;
+}
+
+// Step 20a: one line of a POS sale that takes stock out, as planSale() gets it. batchId is the
+// batch the device chose; serialNumbers what the scanner read.
+export interface SaleDemand {
+  line: number;
+  variant: VariantInfo;
+  baseQuantity: string;
+  batchId: string | null;
+  serialNumbers: string[];
+}
+
+// Where that line's goods leave from: the moves to post, the batches they take (for
+// pos_sale_line_batches), and what the warehouse did not have
+export interface SalePlan {
+  moves: StockMove[];
+  batches: { batchId: string; quantity: string }[];
+  shortQuantity: string;
+  shortSerials: string[];
+}
+
+// What can be taken of `wanted` from `left`: the smaller of the two, and nothing from stock at
+// zero or below
+function takeable(left: string, wanted: string): string {
+  if (compareQuantity(left, '0') <= 0) return '0';
+  return compareQuantity(left, wanted) < 0 ? left : wanted;
 }
 
 // The trigger's refusals as the API's answers, without a field: the trigger does not know which
@@ -353,6 +382,186 @@ export class StockPostingService {
     return values;
   }
 
+  // Step 20a: where the goods of a POS sale leave from, worked out before post() (decision 15).
+  // The sale was paid and printed, so nothing here refuses it for stock:
+  //   no tracking  the line leaves as it is; what the warehouse does not have goes below zero
+  //   batch        the device's batch first, then the other batches here by FEFO (not expired on
+  //                the day of the sale), and what is still missing below zero on the device's batch
+  //   serial       a serial number in this warehouse leaves with it; one that is not here
+  //                (unknown, sold already, in another warehouse) leaves as a piece without one
+  // The rows are locked in post()'s order (serials, values, balances), so post() takes the same
+  // locks again without waiting, and the stock cannot change between the plan and the posting.
+  // Two lines of one variant count against the same stock, one after the other.
+  // shortQuantity is what went below zero against the rules: an untracked product in a workspace
+  // that allows negative stock is never short, because any document may take it there.
+  async planSale(
+    tx: Transaction,
+    warehouseId: string,
+    date: string,
+    demands: readonly SaleDemand[],
+  ): Promise<SalePlan[]> {
+    const tenantId = getTenantId();
+    if (demands.length === 0) return [];
+    const variantIds = [...new Set(demands.map((demand) => demand.variant.variantId))];
+
+    const numbers = [...new Set(demands.flatMap((demand) => demand.serialNumbers))];
+    const here = new Set<string>();
+    if (numbers.length > 0) {
+      const rows = await tx
+        .select({
+          variantId: serials.variantId,
+          serialNumber: serials.serialNumber,
+          warehouseId: serials.warehouseId,
+        })
+        .from(serials)
+        .where(
+          and(
+            eq(serials.tenantId, tenantId),
+            inArray(serials.variantId, variantIds),
+            inArray(serials.serialNumber, numbers),
+          ),
+        )
+        .orderBy(asc(serials.id))
+        .for('update');
+      for (const row of rows) {
+        if (row.warehouseId === warehouseId) here.add(`${row.variantId}|${row.serialNumber}`);
+      }
+    }
+
+    await this.lockValues(tx, variantIds);
+    // checkAvailable()'s order. The batch's expiry and lot come along for FEFO; only the balance
+    // rows are locked (a batch row never changes its expiry).
+    const balances = await tx
+      .select({
+        variantId: stockBalances.variantId,
+        batchId: stockBalances.batchId,
+        quantity: stockBalances.quantity,
+        lotNumber: batches.lotNumber,
+        expiresOn: batches.expiresOn,
+      })
+      .from(stockBalances)
+      .leftJoin(
+        batches,
+        and(eq(batches.tenantId, stockBalances.tenantId), eq(batches.id, stockBalances.batchId)),
+      )
+      .where(
+        and(
+          eq(stockBalances.tenantId, tenantId),
+          eq(stockBalances.warehouseId, warehouseId),
+          inArray(stockBalances.variantId, variantIds),
+        ),
+      )
+      .orderBy(
+        asc(stockBalances.warehouseId),
+        asc(stockBalances.variantId),
+        sql`${stockBalances.batchId} NULLS FIRST`,
+      )
+      .for('update', { of: stockBalances });
+    const left = new Map(
+      balances.map((row) => [balanceKey(warehouseId, row.variantId, row.batchId), row.quantity]),
+    );
+    const [settings] = await tx
+      .select({ allowNegativeStock: tenantSettings.allowNegativeStock })
+      .from(tenantSettings)
+      .where(eq(tenantSettings.tenantId, tenantId));
+
+    return demands.map((demand): SalePlan => {
+      const { variant } = demand;
+      const key = (batchId: string | null) => balanceKey(warehouseId, variant.variantId, batchId);
+      const leftOf = (batchId: string | null) => left.get(key(batchId)) ?? '0';
+      const take = (batchId: string | null, quantity: string) => {
+        left.set(key(batchId), subtractQuantity(leftOf(batchId), quantity));
+      };
+      const move = (batchId: string | null, quantity: string, serialNumbers: string[] = []) => ({
+        line: demand.line,
+        warehouseId,
+        variant,
+        batchId,
+        quantity,
+        serialNumbers,
+      });
+
+      if (variant.tracking === 'batch') {
+        const own = demand.batchId;
+        // The caller refuses a batch line without a batch (stock_batch_required)
+        if (own === null) throw new Error(`POS line ${String(demand.line)} has no batch`);
+        const taken = new Map<string, string>();
+        const add = (batchId: string, quantity: string) => {
+          if (compareQuantity(quantity, '0') <= 0) return;
+          taken.set(batchId, sumQuantity([taken.get(batchId) ?? '0', quantity]));
+          take(batchId, quantity);
+        };
+        let wanted = demand.baseQuantity;
+        const first = takeable(leftOf(own), wanted);
+        add(own, first);
+        wanted = subtractQuantity(wanted, first);
+        // FEFO: the batch that expires first, no expiry last, then by lot; an expired batch is
+        // not on the shelf, so the goods did not come from it
+        const others = balances
+          .filter(
+            (row): row is typeof row & { batchId: string } =>
+              row.variantId === variant.variantId &&
+              row.batchId !== null &&
+              row.batchId !== own &&
+              (row.expiresOn === null || row.expiresOn >= date),
+          )
+          .sort(
+            (a, b) =>
+              (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31') ||
+              (a.lotNumber ?? '').toLowerCase().localeCompare((b.lotNumber ?? '').toLowerCase()) ||
+              a.batchId.localeCompare(b.batchId),
+          );
+        for (const other of others) {
+          if (compareQuantity(wanted, '0') <= 0) break;
+          const part = takeable(leftOf(other.batchId), wanted);
+          add(other.batchId, part);
+          wanted = subtractQuantity(wanted, part);
+        }
+        // What no batch had goes below zero on the device's batch: the batch the cashier sold
+        const short = wanted;
+        add(own, short);
+        const parts = [...taken].map(([batchId, quantity]) => ({ batchId, quantity }));
+        return {
+          moves: parts.map((part) => move(part.batchId, part.quantity)),
+          batches: parts,
+          shortQuantity: short,
+          shortSerials: [],
+        };
+      }
+
+      const available = leftOf(null);
+      const short = subtractQuantity(demand.baseQuantity, takeable(available, demand.baseQuantity));
+      take(null, demand.baseQuantity);
+
+      if (variant.tracking === 'serial') {
+        // A serial number is on one line at most (documentSerialRules)
+        const found = demand.serialNumbers.filter((serial) =>
+          here.has(`${variant.variantId}|${serial}`),
+        );
+        const missing = demand.serialNumbers.filter(
+          (serial) => !here.has(`${variant.variantId}|${serial}`),
+        );
+        return {
+          moves: [
+            ...(found.length > 0 ? [move(null, String(found.length), found)] : []),
+            ...(missing.length > 0 ? [move(null, String(missing.length))] : []),
+          ],
+          batches: [],
+          shortQuantity: short,
+          shortSerials: missing,
+        };
+      }
+
+      const allowed = settings?.allowNegativeStock === true;
+      return {
+        moves: [move(null, demand.baseQuantity)],
+        batches: [],
+        shortQuantity: allowed ? '0' : short,
+        shortSerials: [],
+      };
+    });
+  }
+
   // A revaluation (step 14): each variant gets a new average cost, and its stock's value changes
   // by the difference — no piece moves. The difference is written as movements of quantity 0
   // (kind 'revaluation'), one per warehouse that holds the variant, split by the quantity there,
@@ -615,7 +824,8 @@ export class StockPostingService {
       .from(tenantSettings)
       .where(eq(tenantSettings.tenantId, tenantId));
     const issues: LineIssue[] = [];
-    for (const move of posting.moves) {
+    // Step 20a: a POS sale's shortages were counted by planSale(); they go below zero
+    for (const move of posting.belowZero === true ? [] : posting.moves) {
       // Below zero is allowed only when the workspace says so, and never for a batch or an IMEI
       if (move.variant.tracking === 'none' && settings?.allowNegativeStock === true) continue;
       const key = balanceKey(move.warehouseId, move.variant.variantId, move.batchId);
```

- **`belowZero` on a posting** skips only the "not enough stock" loop of `checkAvailable()`. That function still locks
  the balance rows and returns the stock before the posting, so the reorder bell (`reportLow()`) works for a POS sale
  like for a delivery. The database lets the movements through because their kind is `pos_sale` (20a.2, section 10).
- **`planSale()` works out where the goods leave from before `post()` runs.** `post()` takes moves that already say
  which batch and which serials; a POS line only says what the device chose. So the plan turns one line into the moves
  of decision 15: the device's batch, the other batches, and what is short.
- **The locks are taken in `post()`'s order:** the serial rows, then the value rows (`lockValues()`), then the balance
  rows. Every posting locks in this order, so two of them never wait for each other in a circle. `post()` then asks for
  the same rows again, which this transaction already holds, so it does not wait. And because the rows stay locked
  from the plan to the posting, nobody can sell the same stock in between.
- **`FOR UPDATE … OF stock_balances`:** the batch is joined for its lot and expiry, but only the balance rows are
  locked. Postgres refuses `FOR UPDATE` on the nullable side of a `LEFT JOIN`, and a batch row never changes anyway.
- **`left` counts down as lines take stock.** Two lines of the same product (the cashier scanned it twice) take from the
  same stock one after the other, so the second one sees what the first one left.
- **Batch lines:** first what the device's batch has, then the other batches by FEFO (decision 45: an expired batch is
  skipped, because it is not on the shelf), and the rest on the device's batch. The rest is `shortQuantity`. A batch
  line without a batch is a bug here, because the sales service refuses it first, so it throws a plain `Error`.
- **Serial lines:** a serial that is in this warehouse leaves with its serial; the others leave as pieces without one,
  in a second move (decision 15). `post()` writes one movement per serial for the first move, and one movement for the
  quantity of the second. The short quantity is what the balance did not have; the short serials are the ones that were
  not here. Both can happen at once, or each alone: a scanned serial that is unknown while the shelf still has stock.
- **Untracked lines are short only against the rules** (decision 46): when the workspace allows negative stock, any
  document may take them below zero, so `shortQuantity` is `0` and nobody is told.
- **`takeable()`** never takes from stock at zero or below. Without the first check, a balance of −2 would "give" −2 and
  the line would leave with more short than it sold.

### `inventory/stock-books.service.ts`: a sale and its cost in one entry

```diff
@@ -38,6 +38,9 @@ interface Accounts {
   inventory: string;
   openingEquity: string;
   costOfGoodsSold: () => string;
+  // Step 20a: a POS sale books the sale itself too, not only its cost
+  sales: () => string;
+  vatOutput: () => string;
   use: (use: StockAccountUse) => string;
 }
 
@@ -293,6 +296,44 @@ export class StockBooksService {
     ]);
   }
 
+  // A POS sale (step 20a, decision 29): the sale and its cost in one entry, all with the branch of
+  // the warehouse it sold from. Dr each payment's account for what it brought (the cash less the
+  // change: `payments` carries the change as a minus on the cash account) / Cr Sales for the net /
+  // Cr Output VAT for the VAT, and Dr Cost of goods sold / Cr Inventory for what the goods cost.
+  // No receivable and no customer on any line: the whole amount was paid at the counter. write()
+  // sums per account, so two cash payments are one line; a sale of ৳0 that cost nothing has no
+  // entry.
+  async posSale(
+    tx: Transaction,
+    document: { id: string; number: string; date: string },
+    input: {
+      warehouseId: string;
+      payments: readonly { accountId: string; amount: string }[];
+      net: string;
+      vat: string;
+      cost: string;
+    },
+  ): Promise<EntryRef | null> {
+    const accounts = await this.accounts(tx);
+    const branchOf = await this.branches(tx, [{ warehouseId: input.warehouseId, value: '0' }]);
+    const branchId = branchOf(input.warehouseId);
+    return this.write(tx, document, 'pos_sale', `POS sale ${document.number}`, [
+      ...input.payments.map((payment) => ({
+        accountId: payment.accountId,
+        branchId,
+        amount: payment.amount,
+      })),
+      { accountId: accounts.sales(), branchId, amount: negateMoney(input.net) },
+      { accountId: accounts.vatOutput(), branchId, amount: negateMoney(input.vat) },
+      ...(isZeroMoney(input.cost)
+        ? []
+        : [
+            { accountId: accounts.costOfGoodsSold(), branchId, amount: input.cost },
+            { accountId: accounts.inventory, branchId, amount: negateMoney(input.cost) },
+          ]),
+    ]);
+  }
+
   // The posted entries of a document, oldest first: an adjustment has at most one, a transfer two
   async entriesOf(tx: Transaction, documentId: string): Promise<EntryRef[]> {
     const rows = await tx
@@ -366,6 +407,8 @@ export class StockBooksService {
             'inventory',
             'opening_balance_equity',
             'cost_of_goods_sold',
+            'sales',
+            'vat_output',
           ]),
         ),
       )
@@ -373,6 +416,8 @@ export class StockBooksService {
     const inventory = purposes.find((row) => row.purpose === 'inventory')?.id;
     const openingEquity = purposes.find((row) => row.purpose === 'opening_balance_equity')?.id;
     const costOfGoodsSold = purposes.find((row) => row.purpose === 'cost_of_goods_sold')?.id;
+    const sales = purposes.find((row) => row.purpose === 'sales')?.id;
+    const vatOutput = purposes.find((row) => row.purpose === 'vat_output')?.id;
     // A workspace whose chart is still being made by the setup job
     if (inventory === undefined) throw missing('inventory');
     if (openingEquity === undefined) throw missing('opening_balance_equity');
@@ -404,6 +449,16 @@ export class StockBooksService {
         if (costOfGoodsSold === undefined) throw missing('cost_of_goods_sold');
         return costOfGoodsSold;
       },
+      // Asked for only by a POS sale. Every chart has both (templates.spec.ts); only a workspace
+      // whose chart the setup job has not made yet misses them.
+      sales: () => {
+        if (sales === undefined) throw missing('sales');
+        return sales;
+      },
+      vatOutput: () => {
+        if (vatOutput === undefined) throw missing('vat_output');
+        return vatOutput;
+      },
       use: (use) => {
         const id = byUse.get(use);
         if (id === undefined) throw missing(use);
```

- **`posSale()` is here and not in `SalesBooksService`,** because a POS sale is a stock journal source (decision 29) and
  needs the inventory and cost of goods sold accounts that this service already finds. It reads `sales` and
  `vat_output` by their purpose too, as `SalesBooksService` does.
- **The change is a minus on the cash account.** The customer handed over ৳100 for ৳51.75; the drawer keeps ৳51.75.
  The caller passes the ৳100 payment and −৳48.25 on the same account, and `write()` sums them per account into one
  debit of ৳51.75. A card and cash payment stay two lines, on two accounts.
- **No receivable and no customer on any line** (decision 27): the whole amount was paid, so nobody owes anything,
  also when a customer was picked at the counter. The customer is on the sale itself.
- **`write()` drops zero lines and writes no entry with fewer than two lines,** so a free sample of an item with no
  cost has no entry, and a service line adds no cost lines. Everything has the warehouse's branch, so the branch's
  profit and loss has the sale where it was made.
- **`sales()` and `vatOutput()` are functions,** like `costOfGoodsSold()`: only a POS sale asks for them, so a chart
  still being made by the setup job fails only the documents that need them, with `stock_account_missing`.

### `sync/devices.service.ts`: two errors made public

```diff
@@ -49,11 +49,12 @@ function toDevice(row: DeviceFields): Device {
 
 // Another person's device, an unknown id and (through RLS) another workspace's device all answer
 // the same: nobody learns that an id exists somewhere else. The app registers the browser again.
-function deviceNotFound(): AppError {
+// Exported for the POS registers (step 20a), which a device claims and releases.
+export function deviceNotFound(): AppError {
   return new AppError(404, 'device_not_found', 'This device is not registered. Register it again.');
 }
 
-function deviceRevoked(): AppError {
+export function deviceRevoked(): AppError {
   return new AppError(403, 'device_revoked', 'This device was revoked. Its data is wiped.');
 }
 
```

- A claim and a release name a device, like a pull. They answer an unknown or another person's device, and a revoked
  one, with the same two errors, so the app handles them in one place.

### `common/outbox/outbox.ts`, `worker/queues.ts` and `packages/db`'s event list: the bell's event

```diff
@@ -20,6 +20,7 @@ export const OUTBOX_EVENT_TYPES = [
   'workspace.tax_rates_requested',
   'document.file_requested',
   'document.email_requested',
+  'pos.sold_short',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

```diff
@@ -39,6 +39,9 @@ export const outboxPayloadSchemas = {
   // The document_emails row says what to send; the file is the PDF to attach, drawn by the email
   // job itself when it is not ready yet (the customer should not wait on a second queue)
   'document.email_requested': z.object({ emailId: z.uuid(), fileId: z.uuid() }),
+  // Step 20a: a POS sale took stock below zero when it was posted. The sale's lines say what and
+  // where (short_quantity, short_serials); the worker tells the people who put stock right.
+  'pos.sold_short': z.object({ saleId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

```diff
@@ -26,6 +26,7 @@ const QUEUE_OF = {
   'workspace.stock_accounts_requested': 'jobs',
   'workspace.tax_rates_requested': 'jobs',
   'document.file_requested': 'jobs',
+  'pos.sold_short': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

- **The event carries only the sale's id** (decision 48), like every event: the worker reads the lines when it runs.
- **The list in `packages/db` is a TypeScript list, not a database check:** the column is plain text. So the new type
  needs no migration, only a rebuild of `@omnivo/db` (`pnpm --filter @omnivo/db build`) before the API sees it.
- **`queues.ts` puts it on the jobs queue,** with the other bells. Its `satisfies` fails the type check until every
  event has a queue.

### `pos/pos-registers.service.ts`: registers, claim and release

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type ErrorCode,
  moneyAccountIds,
  POS_PAYMENT_METHODS,
  type PosPaymentMethod,
  type PosRegister,
  type PosRegisterInput,
  type PosRegisterListItem,
  type PosRegisterStatus,
  type SyncPosRegister,
  type UpdatePosRegisterInput,
} from '@omnivo/contracts';
import { devices, ledgerAccounts, posRegisters, users, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { deviceNotFound, deviceRevoked } from '../sync/devices.service.js';

export type PosRegisterRow = typeof posRegisters.$inferSelect;

// The account column of each payment method
const ACCOUNT_COLUMN = {
  cash: 'cashAccountId',
  card: 'cardAccountId',
  bkash: 'bkashAccountId',
  nagad: 'nagadAccountId',
} as const satisfies Record<PosPaymentMethod, keyof PosRegisterRow>;

// The register's account for a method; null = it does not take that method (cash always has one)
export function accountOf(row: PosRegisterRow, method: PosPaymentMethod): string | null {
  return row[ACCOUNT_COLUMN[method]];
}

// A register as the devices keep it (decision 20): without the last number, which changes with
// every sale. branchId is the warehouse's (decision 17): the caller reads it with the row.
export function toSyncPosRegister(row: PosRegisterRow, branchId: string): SyncPosRegister {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    branchId,
    warehouseId: row.warehouseId,
    accounts: {
      cash: row.cashAccountId,
      card: row.cardAccountId,
      bkash: row.bkashAccountId,
      nagad: row.nagadAccountId,
    },
    maxDiscountPercent: row.maxDiscountPercent,
    paperWidth: row.paperWidth,
    receiptFooter: row.receiptFooter,
    deviceId: row.deviceId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPosRegister(row: PosRegisterRow, branchId: string): PosRegister {
  return { ...toSyncPosRegister(row, branchId), lastNumber: row.lastNumber };
}

// What the audit log shows of a register's form: the warehouse by its code, the accounts by
// their codes, so a reader sees "1110" and not an id
type Snapshot = Record<string, string | null>;

function fieldError(code: ErrorCode, field: string, detail: string): AppError {
  return new AppError(409, code, detail, { fieldErrors: { [field]: [code] } });
}

function codeTaken(): AppError {
  return fieldError('pos_register_code_taken', 'code', 'Another register uses this code.');
}

function wrongBranch(): AppError {
  return fieldError(
    'pos_register_branch',
    'warehouseId',
    'A device holds this register, so its warehouse stays in that branch.',
  );
}

function inUse(): AppError {
  return new AppError(
    409,
    'pos_register_in_use',
    'Another device holds this register. Sign out there first, or revoke that device.',
  );
}

function deviceHasRegister(): AppError {
  return new AppError(
    409,
    'pos_device_has_register',
    'This device holds another register. Let go of that one first.',
  );
}

// The database's last words (migration 0052, schema/pos.ts), caught outside the transaction after
// its rollback (step 6's pattern). Each has a check before it in the code; these are for the race
// the check cannot see: two creates with one code, a claim and a revoke at the same moment.
function databaseError(error: unknown): unknown {
  if (isUniqueViolation(error, 'pos_registers_tenant_code_idx')) return codeTaken();
  if (isUniqueViolation(error, 'pos_registers_device_idx')) return deviceHasRegister();
  if (isCheckViolation(error, 'pos_registers_holder_check')) return wrongBranch();
  if (isCheckViolation(error, 'pos_registers_archived_check')) return inUse();
  return error;
}

// POS registers (step 20a): set up by someone with pos.register.manage, claimed and released by
// the devices that sell on them. A claim and a release never change the register's version: who
// holds it is not part of its form, so a manager's open form does not fail on it (the database's
// own release, when a device is revoked or moved, does the same).
@Injectable()
export class PosRegistersService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}
```

- **`accountOf()`** turns a method into its column, through a `satisfies` map: a fifth method in the contract fails
  the type check here until it has a column. The sales service uses it to find where a payment's money goes.
- **`toSyncPosRegister()` and `toPosRegister()`:** the devices keep a register without `lastNumber` (decision 20); the
  API sends it with. Building one from the other keeps the two shapes the same, field for field, and nothing has to
  take `lastNumber` back out of a finished object.
- **`databaseError()`** maps the constraint names of 20a.2 to the contract's codes. Each one has a check in the code
  before it; these are for the races the checks cannot see. It runs outside the transaction, after the rollback,
  like every service since step 6.

```ts

  list(query: {
    status: PosRegisterStatus;
    branchId?: string | undefined;
  }): Promise<PosRegisterListItem[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({
          register: posRegisters,
          branchId: warehouses.branchId,
          deviceName: devices.name,
          userName: users.fullName,
        })
        .from(posRegisters)
        .innerJoin(
          warehouses,
          and(
            eq(warehouses.tenantId, posRegisters.tenantId),
            eq(warehouses.id, posRegisters.warehouseId),
          ),
        )
        .leftJoin(
          devices,
          and(eq(devices.tenantId, posRegisters.tenantId), eq(devices.id, posRegisters.deviceId)),
        )
        .leftJoin(users, eq(users.id, devices.userId))
        .where(
          and(
            eq(posRegisters.tenantId, getTenantId()),
            query.status === 'active'
              ? isNull(posRegisters.archivedAt)
              : isNotNull(posRegisters.archivedAt),
            query.branchId === undefined ? undefined : eq(warehouses.branchId, query.branchId),
          ),
        )
        .orderBy(asc(posRegisters.code));
      return rows.map((row) => ({
        ...toPosRegister(row.register, row.branchId),
        holder:
          row.deviceName === null || row.userName === null
            ? null
            : { deviceName: row.deviceName, userName: row.userName },
      }));
    });
  }

  get(id: string): Promise<PosRegister> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, id);
      return toPosRegister(row, await this.branchOf(tx, row.warehouseId));
    });
  }

  async create(input: PosRegisterInput): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        const warehouse = await this.activeWarehouse(tx, input.warehouseId);
        await this.checkAccounts(tx, input.accounts);
        const [row] = await tx
          .insert(posRegisters)
          .values({
            tenantId: getTenantId(),
            code: input.code,
            name: input.name,
            warehouseId: input.warehouseId,
            ...this.accountColumns(input.accounts),
            maxDiscountPercent: input.maxDiscountPercent,
            paperWidth: input.paperWidth,
            receiptFooter: input.receiptFooter,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('POS register insert returned no row');
        await audit(tx, {
          action: 'pos_register.created',
          entityType: 'pos_register',
          entityId: row.id,
          changes: created({ code: row.code, ...(await this.snapshot(tx, row)) }),
        });
        return toPosRegister(row, warehouse.branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }

  async update(id: string, input: UpdatePosRegisterInput): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        // An archived register's warehouse may be archived since: only a new choice must be active
        const warehouse =
          input.warehouseId === before.warehouseId
            ? { branchId: await this.branchOf(tx, before.warehouseId) }
            : await this.activeWarehouse(tx, input.warehouseId);
        // A held register stays in its device's branch: the device may still have sales of it to
        // send. The database checks it again (pos_registers_holder_check).
        if (
          before.deviceId !== null &&
          warehouse.branchId !== (await this.branchOf(tx, before.warehouseId))
        ) {
          throw wrongBranch();
        }
        await this.checkAccounts(tx, input.accounts);
        const [after] = await tx
          .update(posRegisters)
          .set({
            name: input.name,
            warehouseId: input.warehouseId,
            ...this.accountColumns(input.accounts),
            maxDiscountPercent: input.maxDiscountPercent,
            paperWidth: input.paperWidth,
            receiptFooter: input.receiptFooter,
            version: sql`${posRegisters.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
          .returning();
        if (!after) throw notFound('POS register');
        await audit(tx, {
          action: 'pos_register.updated',
          entityType: 'pos_register',
          entityId: id,
          changes: diff(await this.snapshot(tx, before), await this.snapshot(tx, after)),
        });
        return toPosRegister(after, warehouse.branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }

  async setArchived(id: string, version: number, archived: boolean): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        if ((before.archivedAt !== null) === archived) {
          return toPosRegister(before, await this.branchOf(tx, before.warehouseId));
        }
        // Decision 33: only the device knows whether a sale of it still waits in its outbox
        if (archived && before.deviceId !== null) throw inUse();
        // Its warehouse may have been archived meanwhile: a register comes back to an active one
        const branchId = archived
          ? await this.branchOf(tx, before.warehouseId)
          : (await this.activeWarehouse(tx, before.warehouseId)).branchId;
        const [after] = await tx
          .update(posRegisters)
          .set({
            archivedAt: archived ? new Date() : null,
            version: sql`${posRegisters.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
          .returning();
        if (!after) throw notFound('POS register');
        await audit(tx, {
          action: archived ? 'pos_register.archived' : 'pos_register.restored',
          entityType: 'pos_register',
          entityId: id,
        });
        return toPosRegister(after, branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }
```

- **The list joins the holder's device and person** for the settings page ("Counter PC · Nusrat Jahan"). `users`, not
  `memberships`: the name stays after the person left (step 18c's rule).
- **Create and update check the warehouse and the accounts first,** each with the register's own codes, so the form
  shows the error under the right box. The database would refuse a warehouse of another workspace too, but with a
  foreign key error that says nothing to a person.
- **A held register keeps its branch.** Its device may still have sales of the old warehouse's branch to send. The check
  here gives a field error; the database's `pos_registers_holder_check` is the last word for a race.
- **Archive is refused while a device holds the register** (decision 33). A restore checks that the warehouse is still
  active, like a warehouse's restore checks its branch.

```ts
  // Decision 14: a device takes a register only when no device holds it. The answer carries the
  // last number, and the device numbers its sales on from there. Taking the one it holds already
  // answers the same, so a claim sent again after a lost answer is harmless.
  async claim(id: string, deviceId: string): Promise<PosRegister> {
    try {
      return await this.withTenant(async (tx) => {
        // The device first, then the register: a revoke locks them in that order (0052), and a
        // claim in the other order could wait for it in a circle
        const device = await this.ownDevice(tx, deviceId);
        const before = await this.lock(tx, id);
        const branchId = await this.branchOf(tx, before.warehouseId);
        if (before.deviceId === device.id) return toPosRegister(before, branchId);
        if (before.archivedAt !== null) {
          throw new AppError(409, 'pos_register_archived', 'This register is archived.');
        }
        if (before.deviceId !== null) throw inUse();
        if (branchId !== device.branchId) {
          throw new AppError(
            409,
            'pos_register_branch',
            "This register is in another branch than this device. Pick one of the device's branch.",
          );
        }
        const [held] = await tx
          .select({ id: posRegisters.id })
          .from(posRegisters)
          .where(
            and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.deviceId, device.id)),
          );
        if (held) throw deviceHasRegister();
        const after = await this.setHolder(tx, id, device.id);
        await audit(tx, {
          action: 'pos_register.claimed',
          entityType: 'pos_register',
          entityId: id,
          changes: { device: { from: null, to: device.name } },
        });
        return toPosRegister(after, branchId);
      });
    } catch (error) {
      throw databaseError(error);
    }
  }

  // The device lets go of its register: the app calls it at sign-out, after it checked that no
  // sale of the register waits in its outbox (decision 32). A register that is free already
  // answers as it is (a release sent again); one another device holds is not this device's to free.
  release(id: string, deviceId: string): Promise<PosRegister> {
    return this.withTenant(async (tx) => {
      const device = await this.ownDevice(tx, deviceId);
      const before = await this.lock(tx, id);
      const branchId = await this.branchOf(tx, before.warehouseId);
      if (before.deviceId === null) return toPosRegister(before, branchId);
      if (before.deviceId !== device.id) {
        throw new AppError(409, 'pos_register_not_held', 'This device does not hold the register.');
      }
      const after = await this.setHolder(tx, id, null);
      await audit(tx, {
        action: 'pos_register.released',
        entityType: 'pos_register',
        entityId: id,
        changes: { device: { from: device.name, to: null } },
      });
      return toPosRegister(after, branchId);
    });
  }

  // No version: see the class's comment
  private async setHolder(
    tx: Transaction,
    id: string,
    deviceId: string | null,
  ): Promise<PosRegisterRow> {
    const [after] = await tx
      .update(posRegisters)
      .set({ deviceId, updatedBy: currentPrincipal().userId })
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
      .returning();
    if (!after) throw notFound('POS register');
    return after;
  }

  // The signed-in person's own active device, FOR SHARE: a revoke or a move of it that is running
  // finishes first, and this sees its result. Another person's device answers like an unknown one.
  private async ownDevice(tx: Transaction, id: string) {
    const [row] = await tx
      .select({
        id: devices.id,
        name: devices.name,
        userId: devices.userId,
        branchId: devices.branchId,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)))
      .for('share');
    if (row?.userId !== currentPrincipal().userId) throw deviceNotFound();
    if (row.revokedAt !== null) throw deviceRevoked();
    return row;
  }
```

- **The device is locked before the register** (the lock order of 20a.2): a revoke locks the device and then, through
  its trigger, the register. A claim the other way round could wait for the revoke while the revoke waits for it, and
  Postgres would end one of them with a deadlock error.
- **A claim of the register the device already holds answers it as it is.** The app may send the claim again after an
  answer was lost; a second "in use" for its own register would stop the cashier for nothing.
- **The order of the refusals:** archived, then held by another device, then another branch, then "this device holds
  another register". Each says what to do; the last one asks the app to let go of the old register first, because only
  the device knows whether a sale of it still waits (decision 32).
- **Two claims by one device for two registers at the same moment** both pass the "holds another" check. The unique
  index `pos_registers_device_idx` lets one through and the other gets `pos_device_has_register` from
  `databaseError()`.
- **Release:** a free register answers as it is (a release sent twice). One held by another device is not this
  device's to free: `pos_register_not_held`. There is no permission on the route; `ownDevice()` is the check.
- **`setHolder()` does not touch `version`** (decision 43). `updated_at` still moves; the change log logs the new holder,
  because only `last_number` and `updated_at` are skipped (20a.2, section 6).

```ts
  private async find(tx: Transaction, id: string): Promise<PosRegisterRow> {
    const [row] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)));
    if (!row) throw notFound('POS register');
    return row;
  }

  private async lock(tx: Transaction, id: string): Promise<PosRegisterRow> {
    const [row] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)))
      .for('update');
    if (!row) throw notFound('POS register');
    return row;
  }

  // A warehouse is never deleted, so the FK keeps it while a register points at it
  private async branchOf(tx: Transaction, warehouseId: string): Promise<string> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, warehouseId)));
    if (!row) throw new Error(`Warehouse ${warehouseId} of a POS register is missing`);
    return row.branchId;
  }

  // An active warehouse of this workspace, FOR SHARE: nobody archives it or moves it to another
  // branch until we commit
  private async activeWarehouse(tx: Transaction, id: string): Promise<{ branchId: string }> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, getTenantId()),
          eq(warehouses.id, id),
          isNull(warehouses.archivedAt),
        ),
      )
      .for('share');
    if (!row) {
      throw fieldError(
        'pos_register_warehouse_invalid',
        'warehouseId',
        'Pick an active warehouse.',
      );
    }
    return row;
  }

  // Every chosen account is a money account (contracts' moneyAccountIds, the form's own list), all
  // problems at once under accounts.card and so on. The chart is read once: a few hundred rows.
  // FOR SHARE on the chosen ones: nobody archives them before we commit.
  private async checkAccounts(tx: Transaction, accounts: PosRegisterInput['accounts']) {
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
    const chosen = POS_PAYMENT_METHODS.flatMap((method) => {
      const id = accounts[method];
      return id === null ? [] : [{ method, id }];
    });
    const bad = chosen.filter((choice) => !money.has(choice.id));
    if (bad.length > 0) {
      throw new AppError(
        409,
        'pos_register_account_invalid',
        'Pick a cash, bank or mobile wallet account.',
        {
          fieldErrors: Object.fromEntries(
            bad.map((choice) => [`accounts.${choice.method}`, ['pos_register_account_invalid']]),
          ),
        },
      );
    }
    await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, getTenantId()),
          inArray(
            ledgerAccounts.id,
            chosen.map((choice) => choice.id),
          ),
        ),
      )
      .for('share');
  }

  private accountColumns(accounts: PosRegisterInput['accounts']) {
    return {
      cashAccountId: accounts.cash,
      cardAccountId: accounts.card,
      bkashAccountId: accounts.bkash,
      nagadAccountId: accounts.nagad,
    };
  }

  private async snapshot(tx: Transaction, row: PosRegisterRow): Promise<Snapshot> {
    const ids = POS_PAYMENT_METHODS.flatMap((method) => {
      const id = accountOf(row, method);
      return id === null ? [] : [id];
    });
    const codes = new Map(
      (
        await tx
          .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.tenantId, getTenantId()), inArray(ledgerAccounts.id, ids)))
      ).map((account) => [account.id, account.code]),
    );
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    const codeOf = (method: PosPaymentMethod) => {
      const id = accountOf(row, method);
      return id === null ? null : (codes.get(id) ?? null);
    };
    return {
      name: row.name,
      warehouse: warehouse?.code ?? null,
      cashAccount: codeOf('cash'),
      cardAccount: codeOf('card'),
      bkashAccount: codeOf('bkash'),
      nagadAccount: codeOf('nagad'),
      maxDiscountPercent: row.maxDiscountPercent,
      paperWidth: row.paperWidth,
      receiptFooter: row.receiptFooter,
    };
  }
}
```

- **`activeWarehouse()` locks `FOR SHARE`:** nobody archives the warehouse or moves it to another branch until the
  register is saved.
- **`checkAccounts()` reads the chart once** and checks every chosen account against `moneyAccountIds()`, the same list
  the form offers, so the person gets every wrong account at once, under `accounts.card` and so on.
  `assertMoneyAccount()` of the sales documents checks one account and reads the chart each time.
- **The audit snapshot names the warehouse and the accounts by their codes,** so the log says "cash account 1110 →
  1120", not two ids.

### `pos/pos-sales.service.ts`: posting a sale

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  compareQuantity,
  type ErrorCode,
  formatPosNumber,
  isWholeQuantity,
  negateMoney,
  type PartyRef,
  type PosOverride,
  posOverridesOf,
  type PosSale,
  type PosSaleInput,
  type PosSaleSummary,
  posSaleAmounts,
  posChangeOf,
  type SoldShortItem,
  sumMoney,
  todayIn,
  wholeCount,
} from '@omnivo/contracts';
import {
  batches,
  devices,
  posRegisters,
  posSaleLineBatches,
  posSaleLines,
  posSalePayments,
  posSales,
  tenantSettings,
  users,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentDeviceId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { type LineIssue, linePath, linesError, loadVariants } from '../inventory/stock-lines.js';
import {
  type SaleDemand,
  type SalePlan,
  StockPostingService,
} from '../inventory/stock-posting.service.js';
import { firstOpenDay } from '../journal/period-lock.service.js';
import type { Access } from '../rbac/permission.service.js';
import {
  assertCustomer,
  customerRefs,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  toSalesLine,
  withVariants,
} from '../sales/sales-lines.js';
import { accountOf } from './pos-registers.service.js';

type SaleRow = typeof posSales.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// A plan for a line that moves no stock: a service, which is sold but never delivered
const NO_STOCK: SalePlan = { moves: [], batches: [], shortQuantity: '0', shortSerials: [] };

function notHeld(): AppError {
  return new AppError(
    409,
    'pos_register_not_held',
    'This device does not hold the register the sale was made on.',
    { fieldErrors: { registerId: ['pos_register_not_held'] } },
  );
}

// Decision 34: not the cashier's to fix, and impossible under decision 14. It shows a bug.
function numberTaken(number: string): AppError {
  return new AppError(409, 'pos_number_taken', `Another sale already has number ${number}.`, {
    fieldErrors: { sequence: ['pos_number_taken'] },
  });
}

// "price on line 2, discount on line 3, bill discount": what the audit log shows of the
// overrides, counted from 1 like the receipt
function overrideText(overrides: readonly PosOverride[]): string {
  return overrides
    .map((override) =>
      override.kind === 'bill_discount'
        ? 'bill discount'
        : `${override.kind} on line ${String(override.line + 1)}`,
    )
    .join(', ');
}

// What a line moved short of: below zero, or serial numbers that were not there
function isShort(plan: SalePlan): boolean {
  return compareQuantity(plan.shortQuantity, '0') > 0 || plan.shortSerials.length > 0;
}

// POS sales (step 20a). A sale is written in one place: the sync's push, through createFromDevice
// (decision 21). It is posted the moment it is written (no draft, no status): its lines, the
// batches they left from, its payments, its stock movements and its journal entry, in the push's
// transaction for that command. It is never refused for stock or for its date (decisions 7, 26);
// the refusals left are a missing permission (decision 28), a register the device does not hold,
// a method the register lost (decision 34), and lines the server cannot read (an unknown item).
@Injectable()
export class PosSalesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly stock: StockPostingService,
    private readonly books: StockBooksService,
  ) {}
```

- **`NO_STOCK`** is the plan of a line that moves nothing: a service. Every line has a plan, so the lines, the plans
  and the values can be read by the same index.
- **`overrideText()`** writes the overrides for the audit log in words, counted from 1 like the receipt. An audit value
  is a string, a number or a boolean, so a list goes in as text.

```ts
  // The work of one pos_sale.create command, inside the push's savepoint. `access` is the
  // person's roles of now: whether the sale and its overrides were theirs to make goes into the
  // audit log, never into a refusal.
  async createFromDevice(
    tx: Transaction,
    access: Access,
    saleId: string,
    input: PosSaleInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = currentDeviceId();
    if (deviceId === null) throw new Error('A POS sale is written only from a device');

    // The device first, then the register (the lock order of 0052): a revoke of this device that
    // is running finishes first, and frees the register, which this then sees
    await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.tenantId, tenantId), eq(devices.id, deviceId)))
      .for('share');
    // FOR UPDATE: the sales of one register are written one after the other. The database
    // moves its last number in the same transaction (0052's pos_sales_last_number).
    const [register] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, input.registerId)))
      .for('update');
    // The device holds its register while a sale of it waits (decisions 14 and 32), so this is a
    // bug or a register of another workspace
    if (register?.deviceId !== deviceId) throw notHeld();
    const number = formatPosNumber(register.code, input.sequence);

    // The register's account for each method now: the money goes where the register says today
    const issues: LineIssue[] = [];
    const payments = input.payments.map((payment, index) => {
      const accountId = accountOf(register, payment.method);
      if (accountId === null) {
        issues.push({ path: `payments.${String(index)}.method`, code: 'pos_method_not_set' });
      }
      return { ...payment, accountId: accountId ?? '' };
    });
    if (issues.length > 0) {
      throw new AppError(
        409,
        'pos_method_not_set',
        'The register has no account for a way this sale was paid. Set one in Settings → POS.',
        { fieldErrors: Object.fromEntries(issues.map((issue) => [issue.path, [issue.code]])) },
      );
    }

    // A customer archived after the sale keeps it (assertCustomer's keptId): it was sold already
    const customer =
      input.customerId === null
        ? null
        : await assertCustomer(tx, input.customerId, input.customerId);
    // Items and VAT rates archived after the sale stay usable for the same reason. The amounts
    // come from posSaleAmounts() below, with the device's rates (decision 22), not from here.
    const lines = await resolveSalesLines(
      tx,
      input.lines,
      input.pricesIncludeVat,
      new Set(input.lines.map((line) => line.taxRateId)),
      new Set(input.lines.map((line) => line.variantId)),
    );
    await this.checkTracking(tx, input, lines);
    const amounts = posSaleAmounts(
      input.lines,
      { type: input.billDiscountType, value: input.billDiscount },
      input.pricesIncludeVat,
    );
    const paid = sumMoney(input.payments.map((payment) => payment.amount));
    const change = posChangeOf(input.payments, amounts.totals.total);

    // Decision 26: on the device's day, unless the device's clock is ahead of the server's today,
    // or the books are closed for that day: then on the first day they take
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
    const today = todayIn(settings.timezone);
    const date = await firstOpenDay(tx, input.date > today ? today : input.date);

    try {
      await tx.insert(posSales).values({
        id: saleId,
        tenantId,
        registerId: register.id,
        sequence: input.sequence,
        number,
        date,
        soldAt: new Date(input.soldAt),
        customerId: customer?.id ?? null,
        warehouseId: register.warehouseId,
        deviceId,
        pricesIncludeVat: input.pricesIncludeVat,
        billDiscountType: input.billDiscountType,
        billDiscount: input.billDiscount,
        billDiscountAmount: amounts.totals.billDiscount,
        discount: amounts.totals.discount,
        net: amounts.totals.net,
        vat: amounts.totals.vat,
        total: amounts.totals.total,
        paid,
        createdBy: currentPrincipal().userId,
        updatedBy: currentPrincipal().userId,
      });
    } catch (error) {
      // The register is locked, so only a bug gets here (decision 34). The savepoint rolls back
      // when this leaves the push's nested transaction.
      if (
        isUniqueViolation(error, 'pos_sales_register_sequence_idx') ||
        isUniqueViolation(error, 'pos_sales_tenant_number_idx')
      ) {
        throw numberTaken(number);
      }
      throw error;
    }
```

- **The device comes from the push** (`currentDeviceId()`, set by `runFromDevice()`), never from the command: a
  command cannot say it came from another device.
- **Device first, then the register, `FOR SHARE` then `FOR UPDATE`.** The order is the revoke's (see the claim). The
  register's lock makes the sales of one register go in one after the other, which `pos_sales_last_number` needs.
- **`register?.deviceId !== deviceId`** covers three cases with one answer: no such register, another workspace's
  (row-level security hides it), and one this device does not hold (decision 44).
- **The payment accounts are the register's now,** not when the sale was made: the device does not know the accounts.
  A method the register lost gives `pos_method_not_set` under the payment (decision 34); someone sets the account and
  the cashier sends the sale again.
- **`assertCustomer(tx, id, id)`:** the second id is the "kept" one, so a customer archived since the sale still takes
  it (decision 47). The same for items and rates: every id of the sale is passed as kept.
- **`resolveSalesLines()` is used for its checks only:** the unit, the decimals, the base quantity, the rate's id. The
  amounts it works out use the rate in the database; the sale's amounts come from `posSaleAmounts()` with the device's
  rates (decision 22), the same function the device ran.
- **The day:** the device's date, or the server's today when the device's clock is ahead, then `firstOpenDay()`
  (decision 50).
- **The header goes in first,** so a number given twice fails before any stock moves. The register is locked, so this
  can only be a bug (decision 34): `pos_number_taken`. The primary key is not caught here: a sale id used before gives
  `pos_sales_pkey`, which the push turns into `sync_id_taken`, like a customer's or an order's id.

```ts
    // The stock: where each goods line leaves from (decision 15), then the movements, which take
    // what is missing below zero
    const demands: SaleDemand[] = lines.flatMap((line, index) => {
      if (line.variant.type !== 'goods') return [];
      const sent = input.lines[index];
      return [
        {
          line: index,
          variant: line.variant,
          baseQuantity: line.baseQuantity,
          batchId: line.variant.tracking === 'batch' ? (sent?.batchId ?? null) : null,
          serialNumbers: line.variant.tracking === 'serial' ? (sent?.serialNumbers ?? []) : [],
        },
      ];
    });
    const planned = await this.stock.planSale(tx, register.warehouseId, input.date, demands);
    const plans = lines.map((_, index) => {
      const at = demands.findIndex((demand) => demand.line === index);
      return at === -1 ? NO_STOCK : (planned[at] ?? NO_STOCK);
    });
    const moves = plans.flatMap((plan) => plan.moves);
    const values = await this.stock.post(tx, {
      date,
      kind: 'pos_sale',
      direction: 'out',
      documentId: saleId,
      documentNumber: number,
      moves,
      belowZero: true,
    });
    // post() answers in the order of the moves: each line's value is the sum of its own
    let next = 0;
    const lineValues = plans.map((plan) => {
      const own = values.slice(next, next + plan.moves.length);
      next += plan.moves.length;
      return sumMoney(own);
    });

    const written = await tx
      .insert(posSaleLines)
      .values(
        lines.map((line, index) => {
          const sent = input.lines[index];
          const lineAmounts = amounts.lines[index];
          const plan = plans[index] ?? NO_STOCK;
          if (sent === undefined || lineAmounts === undefined) {
            throw new Error(`POS line ${String(index)} has no input`);
          }
          return {
            ...salesLineValues(line, index),
            // The device's rate and the amounts worked out with it (decision 22)
            taxRate: sent.rate,
            net: lineAmounts.net,
            vat: lineAmounts.vat,
            total: lineAmounts.total,
            saleId,
            startingPrice: sent.startingPrice,
            billDiscount: lineAmounts.billDiscount,
            batchId: line.variant.tracking === 'batch' ? sent.batchId : null,
            serialNumbers: line.variant.tracking === 'serial' ? sent.serialNumbers : [],
            value: lineValues[index] ?? '0',
            shortQuantity: plan.shortQuantity,
            shortSerials: plan.shortSerials,
          };
        }),
      )
      .returning({ id: posSaleLines.id, lineNo: posSaleLines.lineNo });
    const lineIds = new Map(written.map((row) => [row.lineNo, row.id]));
    const batchRows = plans.flatMap((plan, index) => {
      const lineId = lineIds.get(index + 1);
      const variantId = lines[index]?.variant.variantId;
      if (lineId === undefined || variantId === undefined) return [];
      return plan.batches.map((part) => ({
        tenantId,
        lineId,
        variantId,
        batchId: part.batchId,
        quantity: part.quantity,
      }));
    });
    if (batchRows.length > 0) await tx.insert(posSaleLineBatches).values(batchRows);
    await tx.insert(posSalePayments).values(
      payments.map((payment, index) => ({
        tenantId,
        saleId,
        lineNo: index + 1,
        method: payment.method,
        amount: payment.amount,
        reference: payment.reference,
        accountId: payment.accountId,
      })),
    );

    // The books: the change came out of the cash, so it is a minus on the cash account
    const cost = sumMoney(lineValues);
    const entry = await this.books.posSale(
      tx,
      { id: saleId, number, date },
      {
        warehouseId: register.warehouseId,
        payments: [
          ...payments.map((payment) => ({ accountId: payment.accountId, amount: payment.amount })),
          ...(compareMoney(change, '0') > 0
            ? [{ accountId: register.cashAccountId, amount: negateMoney(change) }]
            : []),
        ],
        net: amounts.totals.net,
        vat: amounts.totals.vat,
        cost,
      },
    );

    const shortLines = plans.filter(isShort).length;
    await audit(tx, {
      action: 'pos_sale.created',
      entityType: 'pos_sale',
      entityId: saleId,
      changes: created({
        number,
        date,
        soldOn: input.date,
        register: register.code,
        customer: customer?.code ?? null,
        total: amounts.totals.total,
        paid,
        entry: entry?.number ?? null,
        soldShort: shortLines,
      }),
    });
    // Decision 28: the push let it through without the permission (taken away while the device was
    // offline); the log says so, with the device's day, so a manager can see when it was sold
    if (!access.permissions.includes('pos.sale.create')) {
      await audit(tx, {
        action: 'pos_sale.without_permission',
        entityType: 'pos_sale',
        entityId: saleId,
        changes: created({ number, soldOn: input.date, missing: 'pos.sale.create' }),
      });
    }
    // Decision 25: written whether or not the cashier had the permission; never a refusal
    const overrides = posOverridesOf(input, register.maxDiscountPercent);
    if (overrides.length > 0) {
      await audit(tx, {
        action: 'pos_sale.overridden',
        entityType: 'pos_sale',
        entityId: saleId,
        changes: created({
          overrides: overrideText(overrides),
          maxDiscountPercent: register.maxDiscountPercent,
          allowed: access.permissions.includes('pos.price.override'),
        }),
      });
    }
    // Decision 30: the people who put stock right hear about it after the commit
    if (shortLines > 0) await emit(tx, 'pos.sold_short', { saleId });

    // The sale's own check (0052's deferred triggers) runs here, inside the savepoint, rather than
    // at the push's COMMIT after the answer row: a sale that does not add up fails with this
    // command, on this line of code. It is a bug either way, and the push answers it with a 500.
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  }
```

- **Only goods lines make demands.** Each keeps its line's index, so the plan of line 3 is found again even when line 2
  is a service.
- **The movements are dated the day in the books; the plan uses the device's date** for "expired". On the day of the
  sale, a batch that expired that night was still on the shelf.
- **`post()` answers one value per move, in order.** A batch line may have three moves and a service line none, so the
  values are cut back into lines by counting each plan's moves.
- **Each line stores the device's rate and the amounts made with it,** over what `salesLineValues()` copied from the
  database's rate. `batchId` and `serialNumbers` are kept only where the product tracks them.
- **The line batches need the lines' ids,** which the database makes; `returning()` gives them back by line number.
- **The entry, then the audit rows, then the bell.** `pos_sale.without_permission` is written when the cashier has
  no `pos.sale.create` now: the push let the sale through (decision 28), and this row is where that shows. It keeps
  `soldOn`, the device's day, because the sale may be booked on another day (decision 26), and a manager compares it
  with the day the role changed. The `pos_sale.overridden` row is written whether or not the cashier had
  `pos.price.override`; `allowed` says which (decision 25). The bell's event is in the same transaction, so a sale
  that rolls back rings nothing.
- **`SET CONSTRAINTS ALL IMMEDIATE`** runs 20a.2's checks at commit time now, inside the savepoint (decision 52).

```ts

  // Decision 37: a refused sale's receipt was printed, so its number is used. The push calls this
  // after the savepoint rolled back. Without a version, like the trigger's own move, and only up.
  async keepNumber(tx: Transaction, input: { registerId: string; sequence: number }) {
    await tx
      .update(posRegisters)
      .set({ lastNumber: input.sequence })
      .where(
        and(
          eq(posRegisters.tenantId, getTenantId()),
          eq(posRegisters.id, input.registerId),
          lt(posRegisters.lastNumber, input.sequence),
        ),
      );
  }
```

- **`keepNumber()`** moves the last number for a refused sale (decision 37). The push calls it after the savepoint
  rolled back, so it stays when everything else of the sale is gone. `lt()` in the `WHERE` keeps it from going down
  (the guard of 20a.2 would refuse that anyway), and it does not touch `version` (decision 43's reason).

```ts

  list(query: {
    limit: number;
    cursor?: string | undefined;
    registerId?: string | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: PosSaleSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.registerId === undefined ? undefined : eq(posSales.registerId, query.registerId),
          query.customerId === undefined ? undefined : eq(posSales.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${posSales.date}, ${posSales.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<PosSale> {
    return this.withTenant(async (tx) => {
      const [summary] = await this.summaries(tx, eq(posSales.id, id), 1);
      if (!summary) throw notFound('POS sale');
      const [header] = await tx
        .select({ sale: posSales, deviceName: devices.name })
        .from(posSales)
        .innerJoin(
          devices,
          and(eq(devices.tenantId, posSales.tenantId), eq(devices.id, posSales.deviceId)),
        )
        .where(and(eq(posSales.tenantId, getTenantId()), eq(posSales.id, id)));
      if (!header) throw notFound('POS sale');
      const { sale } = header;
      const lineRows = await tx
        .select()
        .from(posSaleLines)
        .where(and(eq(posSaleLines.tenantId, getTenantId()), eq(posSaleLines.saleId, id)))
        .orderBy(asc(posSaleLines.lineNo));
      const parts =
        lineRows.length === 0
          ? []
          : await tx
              .select({
                lineId: posSaleLineBatches.lineId,
                batchId: posSaleLineBatches.batchId,
                lotNumber: batches.lotNumber,
                expiresOn: batches.expiresOn,
                quantity: posSaleLineBatches.quantity,
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
                  eq(posSaleLineBatches.tenantId, getTenantId()),
                  inArray(
                    posSaleLineBatches.lineId,
                    lineRows.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.id));
      const paymentRows = await tx
        .select()
        .from(posSalePayments)
        .where(and(eq(posSalePayments.tenantId, getTenantId()), eq(posSalePayments.saleId, id)))
        .orderBy(asc(posSalePayments.lineNo));
      const [entry] = await this.books.entriesOf(tx, id);
      return {
        ...summary,
        pricesIncludeVat: sale.pricesIncludeVat,
        discount: sale.discount,
        billDiscountType: sale.billDiscountType,
        billDiscount: sale.billDiscount,
        billDiscountAmount: sale.billDiscountAmount,
        paid: sale.paid,
        change: posChangeOf(paymentRows, sale.total),
        lines: (await withVariants(tx, lineRows)).map(({ row, variant }) => ({
          ...toSalesLine(row, variant),
          billDiscount: row.billDiscount,
          startingPrice: row.startingPrice,
          // The device's batch first, then the others by expiry, as planSale() took them
          batches: parts
            .filter((part) => part.lineId === row.id)
            .sort((a, b) => Number(b.batchId === row.batchId) - Number(a.batchId === row.batchId))
            .map((part) => ({
              batchId: part.batchId,
              lotNumber: part.lotNumber,
              expiresOn: part.expiresOn,
              quantity: part.quantity,
            })),
          serialNumbers: row.serialNumbers,
          shortQuantity: row.shortQuantity,
        })),
        payments: paymentRows.map((payment) => ({
          method: payment.method,
          amount: payment.amount,
          reference: payment.reference,
          accountId: payment.accountId,
        })),
        device: { id: sale.deviceId, name: header.deviceName },
        entry: entry ?? null,
      };
    });
  }

  // The lines that went below zero, newest sale first (decision 30). onHandNow is the variant's
  // stock in that warehouse now, every batch together, so a manager sees it was put right.
  soldShort(query: {
    limit: number;
    cursor?: string | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: SoldShortItem[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const rows = await tx
        .select({
          lineId: posSaleLines.id,
          variantId: posSaleLines.variantId,
          saleId: posSales.id,
          saleNumber: posSales.number,
          date: posSales.date,
          warehouseId: posSales.warehouseId,
          shortQuantity: posSaleLines.shortQuantity,
          shortSerials: posSaleLines.shortSerials,
          lotNumber: batches.lotNumber,
          onHandNow: sql<string>`coalesce((SELECT sum(sb.quantity) FROM stock_balances sb
            WHERE sb.tenant_id = ${posSales.tenantId} AND sb.warehouse_id = ${posSales.warehouseId}
              AND sb.variant_id = ${posSaleLines.variantId}), 0)::text`,
        })
        .from(posSaleLines)
        .innerJoin(
          posSales,
          and(eq(posSales.tenantId, posSaleLines.tenantId), eq(posSales.id, posSaleLines.saleId)),
        )
        .leftJoin(
          batches,
          and(eq(batches.tenantId, posSaleLines.tenantId), eq(batches.id, posSaleLines.batchId)),
        )
        .where(
          and(
            eq(posSaleLines.tenantId, tenantId),
            // The partial index's own condition (pos_sale_lines_short_idx)
            or(
              sql`${posSaleLines.shortQuantity} > 0`,
              sql`cardinality(${posSaleLines.shortSerials}) > 0`,
            ),
            query.warehouseId === undefined
              ? undefined
              : eq(posSales.warehouseId, query.warehouseId),
            after === undefined
              ? undefined
              : sql`(${posSales.date}, ${posSaleLines.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(desc(posSales.date), desc(posSaleLines.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.date, last.lineId]);
      const variants = await loadVariants(
        tx,
        page.items.map((row) => row.variantId),
      );
      return {
        items: page.items.flatMap((row) => {
          // The FK keeps the variant while a line points at it
          const variant = variants.get(row.variantId);
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
              lineId: row.lineId,
              saleId: row.saleId,
              saleNumber: row.saleNumber,
              date: row.date,
              warehouseId: row.warehouseId,
              shortQuantity: row.shortQuantity,
              lotNumber: row.lotNumber,
              serialNumbers: row.shortSerials,
              onHandNow: row.onHandNow,
            },
          ];
        }),
        nextCursor: page.nextCursor,
      };
    });
  }
```

- **The list's cursor is (date, id),** newest first, on the index `pos_sales_tenant_date_idx`. The line count and "sold
  short" are subqueries per row, which read the line index of that sale only.
- **The page's batches:** the device's batch first, then the others by expiry, the order `planSale()` took them in. The
  change is worked out from the payments again (`posChangeOf()`), not stored.
- **"Sold short" filters on the partial index's own condition,** word for word, so Postgres uses
  `pos_sale_lines_short_idx`. `onHandNow` adds every batch of the variant in that warehouse: a manager sees the shortage
  was put right when it is back at zero or above.

```ts

  // Every rule of a goods line that resolveSalesLines() leaves to the stock documents: a batch
  // product names a batch of its own variant, a serial product one serial number per piece in the
  // base unit (resolveLines()'s rules, with the same codes). The device always sends them; a
  // refusal here is a bug, not a cashier's slip.
  private async checkTracking(
    tx: Transaction,
    input: PosSaleInput,
    lines: readonly ResolvedSalesLine[],
  ): Promise<void> {
    const batchIds = [
      ...new Set(input.lines.flatMap((line) => (line.batchId === null ? [] : [line.batchId]))),
    ];
    const known =
      batchIds.length === 0
        ? []
        : await tx
            .select({ id: batches.id, variantId: batches.variantId })
            .from(batches)
            .where(and(eq(batches.tenantId, getTenantId()), inArray(batches.id, batchIds)));
    const batchVariant = new Map(known.map((batch) => [batch.id, batch.variantId]));
    const issues: LineIssue[] = [];
    lines.forEach((line, index) => {
      const sent = input.lines[index];
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      if (sent === undefined || line.variant.type !== 'goods') return;
      if (line.variant.tracking === 'batch') {
        if (sent.batchId === null) at('batchId', 'stock_batch_required');
        else if (batchVariant.get(sent.batchId) !== line.variant.variantId) {
          at('batchId', 'stock_batch_invalid');
        }
      }
      // A pack of 2 phones is 2 pieces in the base unit, and 2 IMEIs
      if (
        line.variant.tracking === 'serial' &&
        (!isWholeQuantity(line.baseQuantity) ||
          wholeCount(line.baseQuantity) !== sent.serialNumbers.length)
      ) {
        at('serialNumbers', 'stock_serial_count');
      }
    });
    if (issues.length > 0) throw linesError(issues);
  }

  // The list's rows, and the page's header: the register, the branch, the cashier, the customer
  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<PosSaleSummary[]> {
    const rows = await tx
      .select({
        sale: posSales,
        register: { id: posRegisters.id, code: posRegisters.code, name: posRegisters.name },
        branchId: warehouses.branchId,
        cashierName: users.fullName,
        lineCount: sql<number>`(SELECT count(*)::int FROM pos_sale_lines l
          WHERE l.tenant_id = ${posSales.tenantId} AND l.sale_id = ${posSales.id})`,
        soldShort: sql<boolean>`EXISTS (SELECT 1 FROM pos_sale_lines l
          WHERE l.tenant_id = ${posSales.tenantId} AND l.sale_id = ${posSales.id}
            AND (l.short_quantity > 0 OR cardinality(l.short_serials) > 0))`,
      })
      .from(posSales)
      .innerJoin(
        posRegisters,
        and(eq(posRegisters.tenantId, posSales.tenantId), eq(posRegisters.id, posSales.registerId)),
      )
      .innerJoin(
        warehouses,
        and(eq(warehouses.tenantId, posSales.tenantId), eq(warehouses.id, posSales.warehouseId)),
      )
      .leftJoin(users, eq(users.id, posSales.createdBy))
      .where(and(eq(posSales.tenantId, getTenantId()), where))
      .orderBy(desc(posSales.date), desc(posSales.id))
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
    sale: SaleRow;
    register: { id: string; code: string; name: string };
    branchId: string;
    cashierName: string | null;
    lineCount: number;
    soldShort: boolean;
  },
  customers: Map<string, PartyRef>,
): PosSaleSummary {
  const { sale } = row;
  // created_by is the person who pushed it: never empty for a sale (createFromDevice sets it)
  if (sale.createdBy === null) throw new Error(`POS sale ${sale.id} has no cashier`);
  return {
    id: sale.id,
    number: sale.number,
    register: row.register,
    branchId: row.branchId,
    warehouseId: sale.warehouseId,
    date: sale.date,
    soldAt: sale.soldAt.toISOString(),
    customer: sale.customerId === null ? null : (customers.get(sale.customerId) ?? null),
    cashier: { id: sale.createdBy, fullName: row.cashierName ?? '' },
    net: sale.net,
    vat: sale.vat,
    total: sale.total,
    lineCount: row.lineCount,
    soldShort: row.soldShort,
    createdAt: sale.createdAt.toISOString(),
  };
}
```

- **`checkTracking()`** has the rules of `resolveLines()` that `resolveSalesLines()` does not know: a batch of the line's
  own variant, and one serial number per piece in the base unit. The codes are the stock documents' own. The device
  always sends them right; a refusal here shows a bug.
- **The cashier is `created_by`,** the person who pushed. A `LEFT JOIN` on `users` keeps a sale in the list even if that
  could ever be missing; `toSummary()` then says plainly that it is a bug.

### `pos/sold-short.handler.ts`: the bell

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  membershipRoles,
  memberships,
  permissions,
  posSaleLines,
  posSales,
  rolePermissions,
  roles,
  warehouses,
} from '@omnivo/db';
import { and, countDistinct, eq, isNull, or, sql } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "POS1-000123 sold 2 items Main store did not have" in the bell of everyone who adjusts stock
// (decision 30: they put it right with an adjustment or a transfer) and of the owners. The bell
// opens the sale. Like LowStockHandler: it reads the rows when it runs, and the event id is each
// notification's key, so a second run of the job adds nothing.
@Injectable()
export class SoldShortHandler implements EventHandler<'pos.sold_short'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'pos.sold_short'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // A sale never changes (0052), so what was short then is short in these rows for good
      const [sale] = await tx
        .select({
          id: posSales.id,
          number: posSales.number,
          warehouse: warehouses.name,
          count: countDistinct(posSaleLines.variantId),
        })
        .from(posSales)
        .innerJoin(
          warehouses,
          and(eq(warehouses.tenantId, posSales.tenantId), eq(warehouses.id, posSales.warehouseId)),
        )
        .innerJoin(
          posSaleLines,
          and(
            eq(posSaleLines.tenantId, posSales.tenantId),
            eq(posSaleLines.saleId, posSales.id),
            or(
              sql`${posSaleLines.shortQuantity} > 0`,
              sql`cardinality(${posSaleLines.shortSerials}) > 0`,
            ),
          ),
        )
        .where(and(eq(posSales.tenantId, tenantId), eq(posSales.id, event.payload.saleId)))
        .groupBy(posSales.id, posSales.number, warehouses.name);
      if (!sale) return;

      // Owners, and members with a role that has inventory.stock.adjust
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
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'inventory.stock.adjust')),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'pos.sold_short',
          params: {
            id: sale.id,
            number: sale.number,
            warehouse: sale.warehouse,
            count: sale.count,
          },
          eventId: event.id,
        });
      }
    });
  }
}
```

- **The handler counts the variants that were short** (`countDistinct`): two lines of one product are one item in the
  bell ("2 items Main store did not have").
- **The recipients are the owners and the people with `inventory.stock.adjust`** (decision 30), found like the
  low-stock bell's. The event id is each notification's key, so a job that runs twice adds nothing.

### `pos/pos.controller.ts` and `pos/pos.module.ts`

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PosRegistersService } from './pos-registers.service.js';
import { PosSalesService } from './pos-sales.service.js';

type Routes = typeof routes.pos;

// No route writes a sale: a sale arrives as a sync command (decision 21)
@Controller()
export class PosController {
  constructor(
    private readonly registers: PosRegistersService,
    private readonly sales: PosSalesService,
  ) {}

  @Endpoint(routes.pos.listRegisters)
  async listRegisters({
    query,
  }: RouteInput<Routes['listRegisters']>): Promise<RouteResponse<Routes['listRegisters']>> {
    return { items: await this.registers.list(query) };
  }

  @Endpoint(routes.pos.getRegister)
  getRegister({
    params,
  }: RouteInput<Routes['getRegister']>): Promise<RouteResponse<Routes['getRegister']>> {
    return this.registers.get(params.id);
  }

  @Endpoint(routes.pos.createRegister)
  createRegister({
    body,
  }: RouteInput<Routes['createRegister']>): Promise<RouteResponse<Routes['createRegister']>> {
    return this.registers.create(body);
  }

  @Endpoint(routes.pos.updateRegister)
  updateRegister({
    params,
    body,
  }: RouteInput<Routes['updateRegister']>): Promise<RouteResponse<Routes['updateRegister']>> {
    return this.registers.update(params.id, body);
  }

  @Endpoint(routes.pos.archiveRegister)
  archiveRegister({
    params,
    body,
  }: RouteInput<Routes['archiveRegister']>): Promise<RouteResponse<Routes['archiveRegister']>> {
    return this.registers.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.pos.restoreRegister)
  restoreRegister({
    params,
    body,
  }: RouteInput<Routes['restoreRegister']>): Promise<RouteResponse<Routes['restoreRegister']>> {
    return this.registers.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.pos.claimRegister)
  claimRegister({
    params,
    body,
  }: RouteInput<Routes['claimRegister']>): Promise<RouteResponse<Routes['claimRegister']>> {
    return this.registers.claim(params.id, body.deviceId);
  }

  @Endpoint(routes.pos.releaseRegister)
  releaseRegister({
    params,
    body,
  }: RouteInput<Routes['releaseRegister']>): Promise<RouteResponse<Routes['releaseRegister']>> {
    return this.registers.release(params.id, body.deviceId);
  }

  @Endpoint(routes.pos.listSales)
  listSales({
    query,
  }: RouteInput<Routes['listSales']>): Promise<RouteResponse<Routes['listSales']>> {
    return this.sales.list(query);
  }

  @Endpoint(routes.pos.getSale)
  getSale({ params }: RouteInput<Routes['getSale']>): Promise<RouteResponse<Routes['getSale']>> {
    return this.sales.get(params.id);
  }

  @Endpoint(routes.pos.soldShort)
  soldShort({
    query,
  }: RouteInput<Routes['soldShort']>): Promise<RouteResponse<Routes['soldShort']>> {
    return this.sales.soldShort(query);
  }
}
```

```ts
import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { PosController } from './pos.controller.js';
import { PosRegistersService } from './pos-registers.service.js';
import { PosSalesService } from './pos-sales.service.js';

// Step 20a: the point of sale. InventoryModule gives a sale what every stock document uses:
// StockPostingService moves the stock (planSale() first, decision 15), StockBooksService books
// the sale and its cost in one entry. PosSalesService is exported for the sync's push, which is
// the only place a sale is written (SyncModule imports this module). The "Sold short" bell's
// worker half (sold-short.handler.ts) is wired in worker/worker.module.ts, like every handler.
@Module({
  imports: [InventoryModule],
  controllers: [PosController],
  providers: [PosRegistersService, PosSalesService],
  exports: [PosSalesService],
})
export class PosModule {}
```

- **Every route of `routes.pos` has its method,** and the contract test (`contract.spec.ts`) fails while one is
  missing. There is no route that writes a sale.
- **`PosModule` exports `PosSalesService` only:** the push is its one other user. It imports `InventoryModule` for the
  stock posting and the stock books.

### `sync/sync-push.service.ts`: the sale command

```diff
@@ -26,6 +26,7 @@ import { AppError } from '../common/http/app-error.js';
 import { getTenantId, runFromDevice } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
+import { PosSalesService } from '../pos/pos-sales.service.js';
 import { type Access, PermissionService } from '../rbac/permission.service.js';
 import { CustomersService } from '../sales/customers.service.js';
 import { SalesOrdersService } from '../sales/sales-orders.service.js';
@@ -41,19 +42,34 @@ const PERMISSION_OF = {
   'customer.create': routes.customers.create.permission,
   'customer.update': routes.customers.update.permission,
   'sales_order.create_draft': routes.salesOrders.create.permission,
+  // Step 20a: no route writes a sale (decision 21), so the cashier's permission comes from the
+  // route that takes a register, which is the same one (decision 31)
+  'pos_sale.create': routes.pos.claimRegister.permission,
 } satisfies Record<SyncCommandType, PermissionKey>;
 
 // The ids a device makes (decision 12). One already used — in this workspace or another, the
 // primary keys are global — fails the insert on its primary key, and the command is refused.
-const DEVICE_ID_KEYS = ['parties_pkey', 'party_addresses_pkey', 'sales_orders_pkey'] as const;
+const DEVICE_ID_KEYS = [
+  'parties_pkey',
+  'party_addresses_pkey',
+  'sales_orders_pkey',
+  'pos_sales_pkey',
+] as const;
 
 function isSyncCommandType(type: string): type is SyncCommandType {
   return SYNC_COMMAND_TYPES.some((known) => known === type);
 }
 
-// The customer or the order a command is about: the answer's entity_id
+// The customer, the order or the POS sale a command is about: the answer's entity_id
 function entityOf(command: SyncCommand): string {
-  return command.type === 'sales_order.create_draft' ? command.orderId : command.customerId;
+  switch (command.type) {
+    case 'sales_order.create_draft':
+      return command.orderId;
+    case 'pos_sale.create':
+      return command.saleId;
+    default:
+      return command.customerId;
+  }
 }
 
 // Step 18b: the push. Every command of a batch in the order sent, each in its own transaction:
@@ -72,6 +88,7 @@ export class SyncPushService {
     private readonly permissions: PermissionService,
     private readonly customers: CustomersService,
     private readonly orders: SalesOrdersService,
+    private readonly posSales: PosSalesService,
   ) {}
 
   async push(input: z.output<typeof syncPushInputSchema>): Promise<SyncPush> {
@@ -128,6 +145,8 @@ export class SyncPushService {
       } catch (error) {
         const refusal = refusalOf(error);
         if (refusal === null) throw error;
+        // Step 20a (decision 37): the refused sale's receipt was printed, so its number stays used
+        if (command.type === 'pos_sale.create') await this.posSales.keepNumber(tx, command.input);
         await tx.insert(syncCommands).values({
           ...this.answerKey(device, command),
           status: 'rejected',
@@ -156,7 +175,10 @@ export class SyncPushService {
     command: SyncCommand,
   ): Promise<SyncNotice[]> {
     const permission = PERMISSION_OF[command.type];
-    if (!access.permissions.includes(permission)) {
+    // Step 20a (decision 28): a POS sale is never refused for it. The money is in the drawer and
+    // the goods have left, so refusing would only leave them out of the books; the sale writes
+    // its own audit row instead.
+    if (!access.permissions.includes(permission) && command.type !== 'pos_sale.create') {
       throw new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
         params: { permissions: permission },
       });
@@ -170,6 +192,9 @@ export class SyncPushService {
       case 'sales_order.create_draft':
         await this.orders.createDraftFromDevice(tx, command.orderId, command.input);
         return [];
+      case 'pos_sale.create':
+        await this.posSales.createFromDevice(tx, access, command.saleId, command.input);
+        return [];
     }
   }
 
@@ -204,14 +229,14 @@ export class SyncPushService {
 
   // The customer a command made or changed, in the pull's shape: the device writes it at once. A
   // customer the device may not keep (archived since) goes as a delete, like in a delta pull. An
-  // order sends nothing: orders are not on the device.
+  // order and a POS sale send nothing: neither is on the device (decision 35).
   private async changesOf(
     tx: Transaction,
     device: DeviceRow,
     type: SyncCommandType,
     entityId: string,
   ): Promise<SyncChange[]> {
-    if (type === 'sales_order.create_draft') return [];
+    if (type === 'sales_order.create_draft' || type === 'pos_sale.create') return [];
     // The customer loader reads only the tenant; the branch's warehouses do not matter to it
     const scope = { tenantId: getTenantId(), branchId: device.branchId, warehouseIds: [] };
     const rows = await LOADERS.customer(tx, scope, { by: 'keys', keys: [entityId] });
```

- **The permission is read from the claim route's,** `pos.sale.create` (decision 31). There is no sale route to read it
  from, and the claim route asks for the same permission on purpose.
- **The check in `apply()` skips a POS sale** (decision 28): the other commands are still refused without their
  permission. The sale gets `access` and writes its own `pos_sale.without_permission` row, so the skip always leaves a
  trace. It is a condition on the command's type, not a separate `PERMISSION_OF` entry, so the table still says which
  permission a sale is about.
- **`pos_sales_pkey` joins the ids a device makes:** a sale id used before is `sync_id_taken`.
- **`keepNumber()` runs in the refusal branch,** in the command's own transaction, after the savepoint rolled back and
  before the answer row: the refusal and the used number commit together.
- **An accepted sale sends no rows back** (decision 35).

### `sync/sync-rows.ts`: the registers in the pull

```diff
@@ -10,6 +10,7 @@ import {
 import {
   customerGroups,
   parties,
+  posRegisters,
   priceLists,
   productCategories,
   products,
@@ -25,6 +26,7 @@ import { z } from 'zod';
 
 import type { Transaction } from '../common/tenant/with-tenant.js';
 import { toWarehouse } from '../inventory/warehouses.service.js';
+import { toSyncPosRegister } from '../pos/pos-registers.service.js';
 import { productsOf } from '../products/product-read.js';
 import { toUnit } from '../products/units.service.js';
 import { customersOf } from '../sales/customer-read.js';
@@ -111,6 +113,7 @@ const stockRowSchema = z.object({
 //   price_list_item     its product active and its list active (decision 27)
 //   customer            a customer (not only a supplier), active
 //   stock               in an active warehouse of the branch, not zero, its product active
+//   pos_register        active, its warehouse in the device's branch (step 20a)
 export const LOADERS: Record<SyncEntity, Loader> = {
   // One row, keyed by the workspace's id (the contract's settings key)
   settings: async (tx, scope, pick) => {
@@ -221,6 +224,43 @@ export const LOADERS: Record<SyncEntity, Loader> = {
     }));
   },
 
+  // Step 20a (decision 20): the registers of the branch, active ones, without the last number. The
+  // branch is the warehouse's, so the join decides it: a register whose warehouse moved to another
+  // branch drops out here (0052 logs it). Its warehouse may be archived: the register still is the
+  // branch's, and the device keeps it.
+  pos_register: async (tx, scope, pick) => {
+    const { where, limit } = byId(posRegisters.id, pick);
+    const rows = await tx
+      .select({ register: posRegisters, branchId: warehouses.branchId })
+      .from(posRegisters)
+      .innerJoin(
+        warehouses,
+        and(
+          eq(warehouses.tenantId, posRegisters.tenantId),
+          eq(warehouses.id, posRegisters.warehouseId),
+        ),
+      )
+      .where(
+        and(
+          eq(posRegisters.tenantId, scope.tenantId),
+          eq(warehouses.branchId, scope.branchId),
+          isNull(posRegisters.archivedAt),
+          where,
+        ),
+      )
+      .orderBy(asc(posRegisters.id))
+      .limit(limit);
+    return rows.map((row) => ({
+      sort: [row.register.id],
+      change: {
+        op: 'upsert',
+        entity: 'pos_register',
+        key: row.register.id,
+        data: toSyncPosRegister(row.register, row.branchId),
+      },
+    }));
+  },
+
   // Without itemCount and customerCount (decision 15)
   price_list: async (tx, scope, pick) => {
     const { where, limit } = byId(priceLists.id, pick);
```

- **The branch comes from the join with the warehouse,** in both pull modes. A register whose warehouse moved to another
  branch is simply not in the answer any more, and the pull sends it as a delete; 20a.2's warehouse trigger logged it.
- **An archived register drops out the same way.** An archived warehouse does not drop its register: the register is
  still the branch's, and a manager may move it to another warehouse.

### Wiring: `sync.module.ts`, `app.module.ts`, `worker/handlers.ts`, `worker/worker.module.ts`

```diff
@@ -1,5 +1,6 @@
 import { Module } from '@nestjs/common';
 
+import { PosModule } from '../pos/pos.module.js';
 import { RbacModule } from '../rbac/rbac.module.js';
 import { SalesModule } from '../sales/sales.module.js';
 import { DevicesController } from './devices.controller.js';
@@ -12,9 +13,10 @@ import { SyncPushService } from './sync-push.service.js';
 // it is the worker's (WorkerModule), on the worker's database role. Step 18b: the push, which
 // runs a device's commands with the sales services (SalesModule) and checks each command's
 // permission (RbacModule). Step 18c: the device lists, rename, move and revoke (DevicesController),
-// which also read the person's permissions.
+// which also read the person's permissions. Step 20a: the push posts a device's POS sales
+// (PosModule).
 @Module({
-  imports: [RbacModule, SalesModule],
+  imports: [RbacModule, SalesModule, PosModule],
   controllers: [SyncController, DevicesController],
   providers: [DevicesService, SyncService, SyncPushService],
 })
```

```diff
@@ -28,6 +28,7 @@ import { JournalModule } from './journal/journal.module.js';
 import { MembersModule } from './members/members.module.js';
 import { NotificationsModule } from './notifications/notifications.module.js';
 import { NumberingModule } from './numbering/numbering.module.js';
+import { PosModule } from './pos/pos.module.js';
 import { PermissionGuard } from './rbac/permission.guard.js';
 import { ProductsModule } from './products/products.module.js';
 import { PurchaseModule } from './purchase/purchase.module.js';
@@ -71,6 +72,7 @@ export class AppModule implements NestModule {
         DocumentsModule,
         PurchaseModule,
         SyncModule,
+        PosModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

```diff
@@ -7,6 +7,7 @@ import { DocumentFileHandler } from '../documents/file.handler.js';
 import { LowStockHandler } from '../inventory/low-stock.handler.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
+import { SoldShortHandler } from '../pos/sold-short.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
@@ -40,6 +41,7 @@ export class EventHandlers {
     taxRates: TaxRatesHandler,
     documentFile: DocumentFileHandler,
     documentEmail: DocumentEmailHandler,
+    soldShort: SoldShortHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -55,6 +57,7 @@ export class EventHandlers {
       'workspace.tax_rates_requested': taxRates,
       'document.file_requested': documentFile,
       'document.email_requested': documentEmail,
+      'pos.sold_short': soldShort,
     };
   }
 
```

```diff
@@ -12,6 +12,7 @@ import { InvitationEmailHandler } from '../invitations/invitation-email.handler.
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { MailService } from '../mail/mail.service.js';
 import { NumberingService } from '../numbering/numbering.service.js';
+import { SoldShortHandler } from '../pos/sold-short.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
@@ -72,6 +73,8 @@ export class WorkerModule implements OnApplicationShutdown {
         DocumentFileMaker,
         DocumentFileHandler,
         DocumentEmailHandler,
+        // Step 20a: the bell for a POS sale that took stock below zero
+        SoldShortHandler,
         // Step 18a: the hourly job also prunes the sync change log, on the relay's pool
         SyncLogCleanup,
       ],
```

- `SyncModule` imports `PosModule` for the push; `PosModule` does not import `SyncModule`, so there is no circle. The
  claim's device check is its own small query, with the two errors `devices.service.ts` exports.
- The handler map's type fails until `pos.sold_short` has a handler.

### The services that refuse a delete: `customers`, `products`, `accounts`

```diff
@@ -109,6 +109,8 @@ const CUSTOMER_IN_USE = [
   'sales_returns_customer_fk',
   'credit_notes_customer_fk',
   'refunds_customer_fk',
+  // step 20a: a POS sale made for a customer picked at the counter
+  'pos_sales_customer_fk',
 ] as const;
 
 function codeTaken(): AppError {
```

```diff
@@ -74,6 +74,8 @@ const VARIANT_IN_USE = [
   'goods_receipt_lines_variant_fk',
   // step 17c
   'bill_lines_variant_fk',
+  // step 20a
+  'pos_sale_lines_variant_fk',
 ] as const;
 
 // The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
```

```diff
@@ -365,7 +365,8 @@ export class AccountsService {
       // Journal lines point at it (a draft's too): the history must keep its account
       // Money receipts and refunds name it too (steps 15c, 15d), though each one's entry already does,
       // and so do a bill's lines and expenses and a supplier payment (step 17c), even as a draft,
-      // and a supplier refund (step 17d)
+      // and a supplier refund (step 17d), and a POS register's method and a POS sale's payment
+      // (step 20a)
       if (
         isForeignKeyViolation(error, 'journal_lines_account_fk') ||
         isForeignKeyViolation(error, 'receipts_account_fk') ||
@@ -373,7 +374,12 @@ export class AccountsService {
         isForeignKeyViolation(error, 'bill_lines_account_fk') ||
         isForeignKeyViolation(error, 'bill_expenses_account_fk') ||
         isForeignKeyViolation(error, 'supplier_payments_account_fk') ||
-        isForeignKeyViolation(error, 'supplier_refunds_account_fk')
+        isForeignKeyViolation(error, 'supplier_refunds_account_fk') ||
+        isForeignKeyViolation(error, 'pos_registers_cash_account_fk') ||
+        isForeignKeyViolation(error, 'pos_registers_card_account_fk') ||
+        isForeignKeyViolation(error, 'pos_registers_bkash_account_fk') ||
+        isForeignKeyViolation(error, 'pos_registers_nagad_account_fk') ||
+        isForeignKeyViolation(error, 'pos_sale_payments_account_fk')
       ) {
         throw new AppError(409, 'account_in_use', 'Archive this account instead: entries use it.');
       }
```

- **A customer, an item or an account a POS sale or a register points at cannot be deleted.** The foreign keys of 20a.2
  already refuse it; these lines turn the refusal into `customer_in_use`, `product_variant_in_use` and
  `account_in_use`, so the person reads "Archive it instead" and not a 500.

### `inventory/warehouses.service.ts`: a warehouse with a held register

```diff
@@ -9,7 +9,7 @@ import { branches, stockBalances, stockMovements, stockTransfers, warehouses } f
 import { and, asc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../common/audit/audit.js';
-import { isUniqueViolation } from '../common/db/pg-errors.js';
+import { isCheckViolation, isUniqueViolation } from '../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
@@ -35,6 +35,15 @@ function snapshot(row: Pick<WarehouseRow, 'code' | 'name' | 'address'>, branch:
   return { code: row.code, name: row.name, address: row.address, branch };
 }
 
+function branchLocked(): AppError {
+  return new AppError(
+    409,
+    'warehouse_branch_locked',
+    'A warehouse with stock history stays in its branch.',
+    { fieldErrors: { branchId: ['warehouse_branch_locked'] } },
+  );
+}
+
 function codeTaken(code: string): AppError {
   return new AppError(409, 'warehouse_code_taken', `Warehouse code ${code} is already used.`, {
     fieldErrors: { code: ['warehouse_code_taken'] },
@@ -100,12 +109,7 @@ export class WarehousesService {
         // Its history belongs to the branch it was in: moving a warehouse that already has
         // movements would move years of stock (and, from step 14, its value) to another branch
         if (fields.branchId !== before.branchId && (await this.hasMovements(tx, id))) {
-          throw new AppError(
-            409,
-            'warehouse_branch_locked',
-            'A warehouse with stock history stays in its branch.',
-            { fieldErrors: { branchId: ['warehouse_branch_locked'] } },
-          );
+          throw branchLocked();
         }
         const [after] = await tx
           .update(warehouses)
@@ -127,6 +131,10 @@ export class WarehousesService {
       });
     } catch (error) {
       if (isUniqueViolation(error, 'warehouses_tenant_code_idx')) throw codeTaken(input.code);
+      // Step 20a (migration 0052): a POS register on it is held by a device of the old branch,
+      // which may still have sales of it to send. Rare: hasMovements() above refuses a warehouse
+      // that sold anything, so this is a new warehouse a register was put on at once.
+      if (isCheckViolation(error, 'warehouses_register_held')) throw branchLocked();
       throw error;
     }
   }
```

- **`warehouses_register_held` (20a.2, section 5) answers `warehouse_branch_locked`,** the code a warehouse with stock
  history already gets. The text fits both: the warehouse stays in its branch. A new code would need a text that says
  something the person cannot act on any better.

### `setup/templates.ts`: who sells at a counter

```diff
@@ -163,6 +163,13 @@ const SENDING_BACK = ['purchase.return.manage'] as const;
 const DEBITING = ['purchase.debit_note.manage'] as const;
 const TAKING_REFUNDS = ['purchase.refund.manage'] as const;
 
+// Step 20a. A cashier sells at the counter; the person who runs the shop also sets the registers up
+// and may change a price or give more than the register's discount (a cashier who could would give
+// any discount). Nobody else sells at a counter: an owner gives pos.sale.create to a role in
+// Settings → Roles where a depot also has a counter.
+const SELLING_AT_COUNTER = ['pos.sale.create'] as const;
+const RUNNING_COUNTERS = ['pos.register.manage', 'pos.price.override'] as const;
+
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
 const ACCOUNTANT: RoleTemplate = {
@@ -710,9 +717,15 @@ export const INDUSTRY_TEMPLATES = {
           ...PAYING,
           ...DEBITING,
           ...TAKING_REFUNDS,
+          ...SELLING_AT_COUNTER,
+          ...RUNNING_COUNTERS,
         ],
       },
-      { name: 'Cashier', description: 'Sells at the counter', permissions: [...COLLECTING] },
+      {
+        name: 'Cashier',
+        description: 'Sells at the counter',
+        permissions: [...COLLECTING, ...SELLING_AT_COUNTER],
+      },
     ],
     chart: standardChart({
       stock: TRADER_STOCK,
```

- **The retail Shop manager gets all three permissions, the Cashier `pos.sale.create`** (decision 49). A cashier who
  could change a price or give any discount would not need the register's limit.
- Templates fill only new workspaces. An old workspace's owner gives the permissions in Settings → Roles.

> **What we checked.** The API's type check, lint and its 123 unit tests (with the contract test: every route of
> `routes.pos` is served). The stock, valuation, invoice and setup suites pass with the changed stock posting and stock
> books (83 tests). One throwaway test against a real Postgres and Redis (not part of this guide; 20a.4 writes the real
> ones) went through a retail workspace: a register made (`POS1`, limit `5.00`), the same code again refused; a laptop
> claimed it (twice, the same answer), a tablet was refused with `pos_register_in_use`; three sales pushed in one
> batch: two juices with a 10% bill discount paid ৳100 (total ৳51.75, change ৳48.25, an entry, an override row), 20
> juices with 8 on hand and 10 strips of Napa from a batch with 3 (3 from it, 5 from the other batch by FEFO, 2 below
> zero on the first), and one paid by card on a register without a card account (`pos_method_not_set`). Sent again,
> the same answers. The stock went to −12 and −2, both lines were on "Sold short" with the stock now, every `pos_sale`
> entry balanced, and the bell reached the owner. After the laptop let go, the tablet's claim answered last number 3
> (the refused sale's), the laptop's next sale was refused with `pos_register_not_held`, and the tablet's pull carried
> the register.

### Check this part

```bash
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src
pnpm --filter @omnivo/api test
```

The db build is for the new event type. The API's sync and device integration suites still pull with protocol 1 and
fail until 20a.4. The i18n, sync and app packages still fail as listed at the end of 20a.1, until their parts.

## 20a.4 — `apps/api`: the tests

Two new integration test files, and four old ones that name the sync protocol:

- `pos/pos.int.spec.ts` (new): registers, the devices that hold them, the pull, and the sales a counter pushes.
- `pos/pos.tenant-leak.int.spec.ts` (new): one shop never sees or touches another shop's registers and sales.
- `sync/sync.int.spec.ts`, `sync/sync-push.int.spec.ts`, `sync/devices.int.spec.ts`, `sync/sync.tenant-leak.int.spec.ts`:
  the protocol from the contract, not a number typed by hand.

### The sync tests: the protocol from the contract

```diff
@@ -19,6 +19,7 @@ import {
   setupSchema,
   supplierSchema,
   SYNC_ENTITIES,
+  SYNC_PROTOCOL,
   type SyncChange,
   type SyncEntity,
   syncPullSchema,
@@ -239,7 +240,11 @@ async function newDevice(name: string, branch: Branch, as = owner): Promise<Devi
 }
 
 function pullPage(deviceId: string, cursor: string | undefined, limit: number, as = owner) {
-  const query = new URLSearchParams({ deviceId, protocol: '1', limit: String(limit) });
+  const query = new URLSearchParams({
+    deviceId,
+    protocol: String(SYNC_PROTOCOL),
+    limit: String(limit),
+  });
   if (cursor !== undefined) query.set('cursor', cursor);
   return send('GET', `/sync/pull?${query.toString()}`, undefined, as);
 }
@@ -555,7 +560,10 @@ describe('registering a device', () => {
     const again = await register({ id: lost.id, name: 'Lost phone', branchId: narsingdi.id });
     expect(deviceSchema.parse(again.json()).revokedAt).not.toBeNull();
 
-    const old = await send('GET', `/sync/pull?deviceId=${lost.id}&protocol=2`);
+    const old = await send(
+      'GET',
+      `/sync/pull?deviceId=${lost.id}&protocol=${String(SYNC_PROTOCOL + 1)}`,
+    );
     expect(old.statusCode).toBe(409);
     expect(problemOf(old).code).toBe('sync_protocol_mismatch');
   });
```

```diff
@@ -17,6 +17,7 @@ import {
   roleSchema,
   salesOrderSchema,
   setupSchema,
+  SYNC_PROTOCOL,
   type SyncChange,
   type SyncCommandInput,
   type SyncResult,
@@ -100,7 +101,7 @@ function pushRequest(
   {
     as = owner,
     device = laptop,
-    protocol = 1,
+    protocol = SYNC_PROTOCOL,
   }: { as?: SignedIn; device?: Device; protocol?: number } = {},
 ) {
   return send('POST', '/sync/push', { deviceId: device.id, protocol, commands }, as);
@@ -426,7 +427,7 @@ describe('the request', () => {
     // An old app is told to reload, whatever else is wrong
     const old = await pushRequest([newCustomer('Old App Store')], {
       device: stranger,
-      protocol: 2,
+      protocol: SYNC_PROTOCOL + 1,
     });
     expect(old.statusCode).toBe(409);
     expect(problemSchema.parse(old.json()).code).toBe('sync_protocol_mismatch');
```

```diff
@@ -16,6 +16,7 @@ import {
   problemSchema,
   roleListSchema,
   setupSchema,
+  SYNC_PROTOCOL,
   syncPullSchema,
   syncPushSchema,
   type Warehouse,
@@ -153,7 +154,11 @@ function itemOf(res: Awaited<ReturnType<typeof send>>): DeviceListItem {
 }
 
 function pull(device: { id: string }, as = owner, cursor?: string) {
-  const query = new URLSearchParams({ deviceId: device.id, protocol: '1', limit: '1000' });
+  const query = new URLSearchParams({
+    deviceId: device.id,
+    protocol: String(SYNC_PROTOCOL),
+    limit: '1000',
+  });
   if (cursor !== undefined) query.set('cursor', cursor);
   return send('GET', `/sync/pull?${query.toString()}`, undefined, as);
 }
@@ -174,7 +179,7 @@ function push(device: { id: string }, as = owner) {
     '/sync/push',
     {
       deviceId: device.id,
-      protocol: 1,
+      protocol: SYNC_PROTOCOL,
       commands: [
         {
           id: v7(),
```

```diff
@@ -14,6 +14,7 @@ import {
   productSchema,
   problemSchema,
   setupSchema,
+  SYNC_PROTOCOL,
   type SyncChange,
   type SyncCommandInput,
   syncPullSchema,
@@ -81,7 +82,7 @@ function as(
 }
 
 function pull(who: SignedIn, deviceId: string, cursor?: string) {
-  const query = new URLSearchParams({ deviceId, protocol: '1', limit: '1000' });
+  const query = new URLSearchParams({ deviceId, protocol: String(SYNC_PROTOCOL), limit: '1000' });
   if (cursor !== undefined) query.set('cursor', cursor);
   return as(who, 'GET', `/sync/pull?${query.toString()}`);
 }
@@ -99,7 +100,7 @@ async function pulled(space: Pick<Workspace, 'who' | 'device'>, cursor?: string)
 async function pushed(space: Pick<Workspace, 'who' | 'device'>, commands: SyncCommandInput[]) {
   const res = await as(space.who, 'POST', '/sync/push', {
     deviceId: space.device.id,
-    protocol: 1,
+    protocol: SYNC_PROTOCOL,
     commands,
   });
   expect(res.statusCode, res.body).toBe(200);
@@ -408,7 +409,7 @@ describe('pushing over HTTP', () => {
   it("cannot push with tenant B's device", async () => {
     const res = await as(a.who, 'POST', '/sync/push', {
       deviceId: b.device.id,
-      protocol: 1,
+      protocol: SYNC_PROTOCOL,
       commands: [newCustomer('Through B')],
     });
     expect(res.statusCode).toBe(404);
```

- **Why these change at all:** 20a.1 moved `SYNC_PROTOCOL` from 1 to 2, because an old app does not know the new
  `pos_register` rows. These tests sent `protocol: 1`, so every pull and push was answered `sync_protocol_mismatch`.
- **`SYNC_PROTOCOL`, not `2`:** the next step that changes the protocol would break the same tests again. The tests are
  about the device, the cursor and the commands, not about which protocol number is current.
- **"An old app" is `SYNC_PROTOCOL + 1`:** any other number is wrong, and this one stays wrong whatever the current
  number is. `String(...)` in the URL: the lint rule `restrict-template-expressions` refuses a bare number in a
  template, so a `NaN` or an object never slips into a URL unseen.

### `pos/pos.int.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  type Branch,
  branchSchema,
  type Customer,
  customerSchema,
  type Device,
  deviceListItemSchema,
  deviceSchema,
  journalEntrySchema,
  memberPageSchema,
  myDeviceListSchema,
  periodLockSchema,
  type PosRegister,
  posRegisterListSchema,
  posRegisterSchema,
  type PosSale,
  posSalePageSchema,
  posSaleSchema,
  problemSchema,
  type Product,
  productSchema,
  roleListSchema,
  settingsSchema,
  setupSchema,
  soldShortPageSchema,
  SYNC_PROTOCOL,
  type SyncChange,
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

// Agora Mini Mart: a shop in Dhanmondi (the main branch) with a back store, and a second shop in
// Uttara. Nusrat (the owner) sells at the front counter, Sumi is a cashier, Kamal the shop manager,
// and Rafiq a member with no role. The tests run in order: the registers first, then the devices
// that take them, then the sales.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the stock balances and the bell, which no route of this step shows
let sql: postgres.Sql;
let owner: SignedIn;
let sumi: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let backStore: Warehouse;
let closedStore: Warehouse;
let uttara: Branch;
let uttaraStore: Warehouse;
let accounts: Account[];
let vat: TaxRate;
let pcs: string;
let juice: Product;
let napa: Product;
let phone: Product;
let wrap: Product;
// Napa's batches: A and B on sale, OLD past its expiry date
let batchA: string;
let counterPc: Device;
let officeLaptop: Device;
let uttaraPc: Device;
let sumiTablet: Device;
let pos1: PosRegister;
let pos2: PosRegister;
let pos3: PosRegister;
let utt1: PosRegister;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type Payment = SaleCommand['input']['payments'][number];

// A UUIDv7 as a device makes it. Only the version digit matters to the server's checks.
function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
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

// A day before or after another, as an ISO date
function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
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

// Stock brought in at a cost, before the counter opens
async function stockIn(warehouse: Warehouse, lines: object[]): Promise<void> {
  const res = await send('POST', '/stock-adjustments', {
    date: addDays(today, -20),
    warehouseId: warehouse.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines,
    post: true,
  });
  expect(res.statusCode, res.body).toBe(201);
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

// A member who signs in to the shop with no role yet; the roles come from the retail templates
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

// The register form, with a cash drawer and nothing else unless asked
function registerForm(code: string, warehouse: Warehouse, extra: object = {}) {
  return {
    code,
    name: `Counter ${code}`,
    warehouseId: warehouse.id,
    accounts: { cash: accountId('1110'), card: '', bkash: '', nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
    ...extra,
  };
}

function accountsForm(register: PosRegister) {
  return {
    cash: register.accounts.cash,
    card: register.accounts.card ?? '',
    bkash: register.accounts.bkash ?? '',
    nagad: register.accounts.nagad ?? '',
  };
}

// The form as the settings page fills it from a register
function editForm(register: PosRegister, extra: object = {}) {
  return {
    name: register.name,
    warehouseId: register.warehouseId,
    accounts: accountsForm(register),
    maxDiscountPercent: register.maxDiscountPercent,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter ?? '',
    version: register.version,
    ...extra,
  };
}

async function registerNow(register: PosRegister): Promise<PosRegister> {
  const res = await send('GET', `/pos/registers/${register.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

async function listRegisters(query = '', as = owner) {
  const res = await send('GET', `/pos/registers${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterListSchema.parse(res.json()).items;
}

// The last number each register gave, as a device keeps it: from the claim's answer on
const sequences = new Map<string, number>();

function claim(register: PosRegister, device: Device, as = owner) {
  return send('POST', `/pos/registers/${register.id}/claim`, { deviceId: device.id }, as);
}

async function claimed(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await claim(register, device, as);
  expect(res.statusCode, res.body).toBe(200);
  const held = posRegisterSchema.parse(res.json());
  sequences.set(register.id, held.lastNumber);
  return held;
}

function release(register: PosRegister, device: Device, as = owner) {
  return send('POST', `/pos/registers/${register.id}/release`, { deviceId: device.id }, as);
}

async function released(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await release(register, device, as);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
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

// A sale with the register's next number, sold today by the device's clock, to a walk-in
function sale(
  register: PosRegister,
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
      date: today,
      soldAt: new Date().toISOString(),
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

async function push(
  commands: SaleCommand[],
  device: Device = counterPc,
  as = owner,
): Promise<SyncResult[]> {
  const res = await send(
    'POST',
    '/sync/push',
    { deviceId: device.id, protocol: SYNC_PROTOCOL, commands },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return syncPushSchema.parse(res.json()).results;
}

function refusal(result: SyncResult | undefined) {
  if (result?.status !== 'rejected') throw new Error(`not refused: ${JSON.stringify(result)}`);
  return result.error;
}

// What each answer was: "accepted", or the refusal's code
function outcomes(results: SyncResult[]): string[] {
  return results.map((result) =>
    result.status === 'rejected' ? result.error.code : result.status,
  );
}

async function saleNow(id: string): Promise<PosSale> {
  const res = await send('GET', `/pos/sales/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posSaleSchema.parse(res.json());
}

// One sale, pushed alone, that must be accepted
async function sold(command: SaleCommand, device = counterPc, as = owner): Promise<PosSale> {
  const [result] = await push([command], device, as);
  expect(result?.status, JSON.stringify(result)).toBe('accepted');
  return saleNow(command.saleId);
}

function numberOf(command: SaleCommand, code: string): string {
  return `${code}-${String(command.input.sequence).padStart(6, '0')}`;
}

// A sale's journal entry as [account code, debit, credit], by code — what an accountant reads
async function entryLines(of: PosSale) {
  if (of.entry === null) throw new Error(`${of.number} has no entry`);
  const entry = journalEntrySchema.parse(
    (await send('GET', `/journal-entries/${of.entry.id}`)).json(),
  );
  return entry.lines
    .map((item) => [codeOf(item.accountId), item.debit, item.credit])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

// The stock of a variant in a warehouse now, every batch together
async function onHand(warehouse: Warehouse, product: Product): Promise<string> {
  const [row] = z.array(z.object({ quantity: z.string() })).parse(
    await sql`SELECT coalesce(sum(quantity), 0)::numeric(18, 4)::text AS quantity
                FROM stock_balances
                WHERE warehouse_id = ${warehouse.id} AND variant_id = ${variantOf(product)}`,
  );
  return row?.quantity ?? '0';
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  return auditPageSchema.parse(res.json()).items;
}

// One page is the whole pull: a new workspace has a few hundred rows at most
async function pulled(device: Device, cursor?: string) {
  const query = new URLSearchParams({
    deviceId: device.id,
    protocol: String(SYNC_PROTOCOL),
    limit: '1000',
  });
  if (cursor !== undefined) query.set('cursor', cursor);
  const res = await send('GET', `/sync/pull?${query.toString()}`);
  expect(res.statusCode, res.body).toBe(200);
  const page = syncPullSchema.parse(res.json());
  expect(page.hasMore).toBe(false);
  return page;
}

function registersIn(changes: SyncChange[]) {
  return changes.filter((change) => change.entity === 'pos_register');
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
  await member('Kamal Hossain', 'kamal@agoramart.com', 'Shop-manager-2026');
  rafiq = await member('Rafiq Islam', 'rafiq@agoramart.com', 'No-role-yet-2026');
  await giveRoles('sumi@agoramart.com', ['Cashier']);
  await giveRoles('kamal@agoramart.com', ['Shop manager']);

  // Dhanmondi's MAIN store, an empty back store and a closed godown; Uttara has its own store
  const [found] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!found) throw new Error('no MAIN warehouse');
  main = found;
  backStore = await created(warehouseSchema, '/warehouses', {
    branchId: main.branchId,
    code: 'BACK',
    name: 'Back store',
    address: '',
  });
  const old = await created(warehouseSchema, '/warehouses', {
    branchId: main.branchId,
    code: 'OLD',
    name: 'Old godown',
    address: '',
  });
  const archived = await send('POST', `/warehouses/${old.id}/archive`, { version: old.version });
  expect(archived.statusCode, archived.body).toBe(200);
  closedStore = warehouseSchema.parse(archived.json());
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

  // The card machine's bank account and the bKash merchant wallet, under the money groups
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await created(accountSchema, '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'City Bank card settlement',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  await created(accountSchema, '/accounts', {
    parentId: accountId('1130'),
    code: '1131',
    name: 'bKash merchant 01711',
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
  await stockIn(main, [
    inLine(juice, '50', '15'),
    inLine(napa, '3', '20', { lotNumber: 'NP-A', expiresOn: addDays(today, 200) }),
    inLine(napa, '5', '20', { lotNumber: 'NP-B', expiresOn: addDays(today, 90) }),
    inLine(napa, '4', '20', { lotNumber: 'NP-OLD', expiresOn: addDays(today, -5) }),
    inLine(phone, '2', '9000', { serialNumbers: ['IMEI-1', 'IMEI-2'] }),
  ]);
  const [lot] = z
    .array(z.object({ id: z.string() }))
    .parse(await sql`SELECT id::text FROM batches WHERE lot_number = 'NP-A'`);
  batchA = lot?.id ?? '';

  counterPc = await registerDevice('Front counter PC', main.branchId);
  officeLaptop = await registerDevice('Back office laptop', main.branchId);
  uttaraPc = await registerDevice('Uttara counter PC', uttara.id);
  sumiTablet = await registerDevice('Counter 2 tablet', main.branchId, sumi);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('POS registers', () => {
  it('are made with an upper-case code, and listed with their branch and who holds them', async () => {
    pos1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('pos1', main, {
        name: 'Front counter',
        accounts: {
          cash: accountId('1110'),
          card: accountId('1121'),
          bkash: accountId('1131'),
          nagad: '',
        },
        maxDiscountPercent: '5',
        receiptFooter: 'Goods once sold are exchanged within 7 days',
      }),
    );
    expect(pos1).toMatchObject({
      code: 'POS1',
      name: 'Front counter',
      branchId: main.branchId,
      warehouseId: main.id,
      accounts: {
        cash: accountId('1110'),
        card: accountId('1121'),
        bkash: accountId('1131'),
        nagad: null,
      },
      maxDiscountPercent: '5.00',
      paperWidth: '80',
      deviceId: null,
      lastNumber: 0,
      archivedAt: null,
    });
    // An empty limit is 0: no discount at all without the permission
    pos2 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS2', main, { paperWidth: '58' }),
    );
    expect([pos2.maxDiscountPercent, pos2.receiptFooter]).toEqual(['0.00', null]);
    pos3 = await created(posRegisterSchema, '/pos/registers', registerForm('POS3', backStore));
    utt1 = await created(posRegisterSchema, '/pos/registers', registerForm('UTT1', uttaraStore));
    expect(utt1.branchId).toBe(uttara.id);

    const all = await listRegisters();
    expect(all.map((item) => [item.code, item.holder])).toEqual([
      ['POS1', null],
      ['POS2', null],
      ['POS3', null],
      ['UTT1', null],
    ]);
    expect((await listRegisters(`?branchId=${uttara.id}`)).map((item) => item.code)).toEqual([
      'UTT1',
    ]);
    // The audit log names the warehouse and the accounts by their codes
    const [entry] = await auditOf('pos_register', pos1.id);
    expect(entry).toMatchObject({
      action: 'pos_register.created',
      changes: {
        code: { from: null, to: 'POS1' },
        warehouse: { from: null, to: 'MAIN' },
        cashAccount: { from: null, to: '1110' },
        cardAccount: { from: null, to: '1121' },
        bkashAccount: { from: null, to: '1131' },
        maxDiscountPercent: { from: null, to: '5.00' },
      },
    });
    expect(entry?.changes).not.toHaveProperty('nagadAccount');
  });

  it('refuse a code that is taken, a warehouse that is not active, and an account that holds no money', async () => {
    const taken = await send('POST', '/pos/registers', registerForm('pos1', main));
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken)).toMatchObject({
      code: 'pos_register_code_taken',
      fieldErrors: { code: ['pos_register_code_taken'] },
    });
    const closed = await send('POST', '/pos/registers', registerForm('POS8', closedStore));
    expect(problemOf(closed).fieldErrors).toEqual({
      warehouseId: ['pos_register_warehouse_invalid'],
    });
    // Sales is not a money account, and the wallets' group itself takes no entries
    const wrong = await send(
      'POST',
      '/pos/registers',
      registerForm('POS8', main, {
        accounts: {
          cash: accountId('1110'),
          card: accountId('4110'),
          bkash: accountId('1130'),
          nagad: '',
        },
      }),
    );
    expect(problemOf(wrong)).toMatchObject({
      code: 'pos_register_account_invalid',
      fieldErrors: {
        'accounts.card': ['pos_register_account_invalid'],
        'accounts.bkash': ['pos_register_account_invalid'],
      },
    });
    // What the form itself refuses
    const form = await send(
      'POST',
      '/pos/registers',
      registerForm('POS-8', main, {
        name: 'C',
        warehouseId: '',
        accounts: { cash: '', card: '', bkash: '', nagad: '' },
        maxDiscountPercent: '120',
      }),
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      code: ['pos_register_code_format'],
      name: ['pos_register_name_required'],
      warehouseId: ['pos_register_warehouse_invalid'],
      'accounts.cash': ['pos_register_cash_required'],
      maxDiscountPercent: ['pos_discount_limit_format'],
    });
    expect((await listRegisters()).map((item) => item.code)).toEqual([
      'POS1',
      'POS2',
      'POS3',
      'UTT1',
    ]);
  });

  it('are set up with pos.register.manage, and read by anyone', async () => {
    const cashier = await send('POST', '/pos/registers', registerForm('POS9', main), sumi);
    expect(cashier.statusCode).toBe(403);
    expect(problemOf(cashier).code).toBe('permission_missing');
    expect(await listRegisters('', rafiq)).toHaveLength(4);
    const one = await send('GET', `/pos/registers/${pos1.id}`, undefined, rafiq);
    expect(one.statusCode, one.body).toBe(200);
  });

  it('change everything but the code, with the version', async () => {
    const res = await send(
      'PUT',
      `/pos/registers/${pos2.id}`,
      // A code in the body is not part of the edit form: it is dropped
      editForm(pos2, {
        code: 'POS9',
        name: 'Pharmacy counter',
        maxDiscountPercent: '2.5',
        receiptFooter: 'Medicines are not taken back',
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = posRegisterSchema.parse(res.json());
    expect(after).toMatchObject({
      code: 'POS2',
      name: 'Pharmacy counter',
      maxDiscountPercent: '2.50',
      receiptFooter: 'Medicines are not taken back',
      version: pos2.version + 1,
    });
    const stale = await send('PUT', `/pos/registers/${pos2.id}`, editForm(pos2));
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
    const [entry] = await auditOf('pos_register', pos2.id);
    expect(entry).toMatchObject({
      action: 'pos_register.updated',
      changes: {
        name: { from: 'Counter POS2', to: 'Pharmacy counter' },
        maxDiscountPercent: { from: '0.00', to: '2.50' },
        receiptFooter: { from: null, to: 'Medicines are not taken back' },
      },
    });
    pos2 = after;
  });

  it('are archived and restored; an archived one is not taken', async () => {
    const archived = await send('POST', `/pos/registers/${pos3.id}/archive`, {
      version: pos3.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const gone = posRegisterSchema.parse(archived.json());
    expect(gone.archivedAt).not.toBeNull();
    expect((await listRegisters()).map((item) => item.code)).not.toContain('POS3');
    expect((await listRegisters('?status=archived')).map((item) => item.code)).toEqual(['POS3']);

    const taken = await claim(gone, officeLaptop);
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).code).toBe('pos_register_archived');

    const restored = await send('POST', `/pos/registers/${pos3.id}/restore`, {
      version: gone.version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    pos3 = posRegisterSchema.parse(restored.json());
    expect(pos3.archivedAt).toBeNull();
  });
});

describe('a device and its register', () => {
  it('takes a free register, and the same answer when it asks again', async () => {
    const held = await claimed(pos1, counterPc);
    // Who holds it is not part of the form: the version stays, and a manager's open form still saves
    expect(held).toMatchObject({ deviceId: counterPc.id, lastNumber: 0, version: pos1.version });
    expect(await claimed(pos1, counterPc)).toEqual(held);
    const [item] = await listRegisters();
    expect(item?.holder).toEqual({ deviceName: 'Front counter PC', userName: 'Nusrat Jahan' });
    const entries = await auditOf('pos_register', pos1.id);
    expect(entries.map((entry) => [entry.action, entry.changes])).toEqual([
      ['pos_register.claimed', { device: { from: null, to: 'Front counter PC' } }],
      ['pos_register.created', expect.anything()],
    ]);
    pos1 = held;
  });

  it('is refused a held register, a second register, or one of another branch', async () => {
    const held = await claim(pos1, officeLaptop);
    expect(held.statusCode).toBe(409);
    expect(problemOf(held).code).toBe('pos_register_in_use');
    const second = await claim(pos2, counterPc);
    expect(problemOf(second).code).toBe('pos_device_has_register');
    const branch = await claim(pos2, uttaraPc);
    expect(problemOf(branch).code).toBe('pos_register_branch');
    expect((await registerNow(pos2)).deviceId).toBeNull();
  });

  it("takes only a person's own device, and needs pos.sale.create", async () => {
    // Rafiq has no role: the route's guard refuses him first
    const rafiqPhone = await registerDevice('Rafiq phone', main.branchId, rafiq);
    const noRole = await claim(pos2, rafiqPhone, rafiq);
    expect(noRole.statusCode).toBe(403);
    expect(problemOf(noRole).code).toBe('permission_missing');
    // Sumi may sell, but not on the owner's PC, nor on a device nobody registered
    const other = await claim(pos2, counterPc, sumi);
    expect(other.statusCode).toBe(404);
    expect(problemOf(other).code).toBe('device_not_found');
    const unknown = await claim(pos2, { ...counterPc, id: v7() }, sumi);
    expect(problemOf(unknown).code).toBe('device_not_found');
    pos2 = await claimed(pos2, sumiTablet, sumi);
    expect(pos2.deviceId).toBe(sumiTablet.id);
  });

  it('is let go only by the device that holds it', async () => {
    const other = await release(pos1, officeLaptop);
    expect(other.statusCode).toBe(409);
    expect(problemOf(other).code).toBe('pos_register_not_held');
    // A cashier lets go without pos.register.manage: it is her device's register
    const free = await released(pos2, sumiTablet, sumi);
    expect(free).toMatchObject({ deviceId: null, version: pos2.version });
    // Sent again after a lost answer: the register is free, and it says so
    expect(await released(pos2, sumiTablet, sumi)).toEqual(free);
    const [entry] = await auditOf('pos_register', pos2.id);
    expect(entry).toMatchObject({
      action: 'pos_register.released',
      changes: { device: { from: 'Counter 2 tablet', to: null } },
    });
    pos2 = await claimed(pos2, sumiTablet, sumi);
  });

  it('goes to one device when two take it at the same moment', async () => {
    const spare = await registerDevice('Spare PC', main.branchId);
    const answers = await Promise.all([claim(pos3, officeLaptop), claim(pos3, spare)]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const lost = answers.find((res) => res.statusCode === 409);
    if (!lost) throw new Error('nobody lost');
    expect(problemOf(lost).code).toBe('pos_register_in_use');
    const winner = (await registerNow(pos3)).deviceId === spare.id ? spare : officeLaptop;
    await released(pos3, winner);

    // One device taking two free registers at once: the database's index refuses the second
    const pos4 = await created(posRegisterSchema, '/pos/registers', registerForm('POS4', main));
    const both = await Promise.all([claim(pos3, spare), claim(pos4, spare)]);
    expect(both.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const refused = both.find((res) => res.statusCode === 409);
    if (!refused) throw new Error('nothing refused');
    expect(problemOf(refused).code).toBe('pos_device_has_register');
    // Tidy up: POS3 free again, POS4 archived
    for (const register of [pos3, pos4]) {
      if ((await registerNow(register)).deviceId !== null) await released(register, spare);
    }
    const archived = await send('POST', `/pos/registers/${pos4.id}/archive`, {
      version: (await registerNow(pos4)).version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
  });

  it('is let go when its device is revoked or moved to another branch', async () => {
    const lost = await registerDevice('Lost tablet', main.branchId);
    await claimed(pos3, lost);
    const revoked = await send('POST', `/devices/${lost.id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    // The database let go of it in the revoke's own transaction, without a version
    expect(await registerNow(pos3)).toMatchObject({ deviceId: null, version: pos3.version });
    const again = await claim(pos3, lost);
    expect(again.statusCode).toBe(403);
    expect(problemOf(again).code).toBe('device_revoked');

    const moving = await registerDevice('Moving laptop', main.branchId);
    await claimed(pos3, moving);
    const mine = myDeviceListSchema
      .parse((await send('GET', '/me/devices')).json())
      .items.find((device) => device.id === moving.id);
    if (!mine) throw new Error('no moving laptop');
    const moved = await send('PUT', `/devices/${moving.id}/branch`, {
      branchId: uttara.id,
      version: mine.version,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(deviceListItemSchema.parse(moved.json()).branchId).toBe(uttara.id);
    expect((await registerNow(pos3)).deviceId).toBeNull();
  });
});

describe("a register's warehouse", () => {
  it('stays in its branch while a device holds the register; a free one moves it along', async () => {
    await claimed(pos3, officeLaptop);
    const toUttara = await send('PUT', `/pos/registers/${pos3.id}`, {
      ...editForm(await registerNow(pos3)),
      warehouseId: uttaraStore.id,
    });
    expect(toUttara.statusCode).toBe(409);
    expect(problemOf(toUttara)).toMatchObject({
      code: 'pos_register_branch',
      fieldErrors: { warehouseId: ['pos_register_branch'] },
    });
    const store = await send('PUT', `/warehouses/${backStore.id}`, {
      branchId: uttara.id,
      code: backStore.code,
      name: backStore.name,
      address: '',
      version: backStore.version,
    });
    expect(store.statusCode).toBe(409);
    expect(problemOf(store).code).toBe('warehouse_branch_locked');
    // Another warehouse of the same branch is fine: the device's sales stay in its branch
    const sameBranch = await send('PUT', `/pos/registers/${pos3.id}`, {
      ...editForm(await registerNow(pos3)),
      warehouseId: main.id,
    });
    expect(sameBranch.statusCode, sameBranch.body).toBe(200);
    const back = await send('PUT', `/pos/registers/${pos3.id}`, {
      ...editForm(posRegisterSchema.parse(sameBranch.json())),
      warehouseId: backStore.id,
    });
    expect(back.statusCode, back.body).toBe(200);

    // Free, the back store goes to Uttara and takes the register with it
    await released(pos3, officeLaptop);
    const freeStore = await send('PUT', `/warehouses/${backStore.id}`, {
      branchId: uttara.id,
      code: backStore.code,
      name: backStore.name,
      address: '',
      version: backStore.version,
    });
    expect(freeStore.statusCode, freeStore.body).toBe(200);
    backStore = warehouseSchema.parse(freeStore.json());
    pos3 = await registerNow(pos3);
    expect(pos3.branchId).toBe(uttara.id);
    expect(problemOf(await claim(pos3, officeLaptop)).code).toBe('pos_register_branch');
  });
});

describe('the pull', () => {
  it("sends the registers of the device's branch, without their last number", async () => {
    const rows = registersIn((await pulled(officeLaptop)).changes);
    expect(rows.map((row) => row.key).sort()).toEqual([pos1.id, pos2.id].sort());
    const first = rows.find((row) => row.key === pos1.id);
    if (first?.op !== 'upsert' || first.entity !== 'pos_register') throw new Error('no POS1');
    expect(first.data).toMatchObject({
      code: 'POS1',
      deviceId: counterPc.id,
      branchId: main.branchId,
    });
    expect(first.data).not.toHaveProperty('lastNumber');
    // Uttara's counter sees its own two, the back store's register among them
    const uttaraRows = registersIn((await pulled(uttaraPc)).changes);
    expect(uttaraRows.map((row) => row.key).sort()).toEqual([utt1.id, pos3.id].sort());
  });

  it('sends a register again when it is made, taken or archived, not when it sold', async () => {
    const { cursor } = await pulled(officeLaptop);
    await sold(sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]));
    expect(registersIn((await pulled(officeLaptop, cursor)).changes)).toEqual([]);

    const pos5 = await created(posRegisterSchema, '/pos/registers', registerForm('POS5', main));
    const made = await pulled(officeLaptop, cursor);
    expect(registersIn(made.changes).map((row) => [row.op, row.key])).toEqual([
      ['upsert', pos5.id],
    ]);
    await claimed(pos5, officeLaptop);
    expect(registersIn((await pulled(officeLaptop, made.cursor)).changes)).toMatchObject([
      { op: 'upsert', key: pos5.id, data: { deviceId: officeLaptop.id } },
    ]);
    await released(pos5, officeLaptop);
    const archived = await send('POST', `/pos/registers/${pos5.id}/archive`, {
      version: pos5.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(registersIn((await pulled(officeLaptop, made.cursor)).changes)).toEqual([
      { op: 'delete', entity: 'pos_register', key: pos5.id },
    ]);
  });
});

describe('a sale pushed from the counter', () => {
  it('is posted at once: its number, its money, its stock and one journal entry', async () => {
    const juiceBefore = await onHand(main, juice);
    // Two juices and a gift wrapping, ৳115 with VAT; the customer gives ৳200 as two notes
    const command = sale(
      pos1,
      [line(juice, '2', '25'), line(wrap, '1', '50')],
      [paid('cash', '100'), paid('cash', '100')],
    );
    const [result] = await push([command]);
    // Nothing for the device to write: sales are not on the device
    expect(result).toEqual({ id: command.id, status: 'accepted', notices: [], changes: [] });
    const done = await saleNow(command.saleId);
    expect(done).toMatchObject({
      number: numberOf(command, 'POS1'),
      register: { id: pos1.id, code: 'POS1', name: 'Front counter' },
      branchId: main.branchId,
      warehouseId: main.id,
      date: today,
      customer: null,
      cashier: { fullName: 'Nusrat Jahan' },
      net: '100.0000',
      vat: '15.0000',
      total: '115.0000',
      paid: '200.0000',
      change: '85.0000',
      lineCount: 2,
      soldShort: false,
      device: { id: counterPc.id, name: 'Front counter PC' },
    });
    expect(done.payments).toEqual([
      { method: 'cash', amount: '100.0000', reference: null, accountId: accountId('1110') },
      { method: 'cash', amount: '100.0000', reference: null, accountId: accountId('1110') },
    ]);
    expect(done.lines.map((item) => [item.total, item.shortQuantity, item.batches])).toEqual([
      ['57.5000', '0.0000', []],
      ['57.5000', '0.0000', []],
    ]);
    // The two notes are one cash line, less the change; the juices cost ৳15 each
    expect(await entryLines(done)).toEqual([
      ['1110', '115.0000', '0.0000'],
      ['1150', '0.0000', '30.0000'],
      ['2120', '0.0000', '15.0000'],
      ['4110', '0.0000', '100.0000'],
      ['5110', '30.0000', '0.0000'],
    ]);
    expect(Number(await onHand(main, juice))).toBe(Number(juiceBefore) - 2);
    expect((await registerNow(pos1)).lastNumber).toBe(command.input.sequence);
    const [entry] = await auditOf('pos_sale', command.saleId);
    expect(entry).toMatchObject({
      action: 'pos_sale.created',
      device: { id: counterPc.id, name: 'Front counter PC' },
      changes: {
        number: { from: null, to: done.number },
        register: { from: null, to: 'POS1' },
        total: { from: null, to: '115.0000' },
        paid: { from: null, to: '200.0000' },
        soldShort: { from: null, to: 0 },
      },
    });
  });

  it('takes each way of paying into its own account', async () => {
    // A phone at ৳15,000 + 15% = ৳17,250: ৳10,000 on the card, ৳5,000 by bKash, ৳3,000 in cash
    const done = await sold(
      sale(
        pos1,
        [line(phone, '1', '15000', { serialNumbers: ['IMEI-1'] })],
        [paid('card', '10000', '4242'), paid('bkash', '5000', 'TRX8KD2Q1'), paid('cash', '3000')],
      ),
    );
    expect([done.total, done.paid, done.change]).toEqual(['17250.0000', '18000.0000', '750.0000']);
    expect(
      done.payments.map((item) => [item.method, item.reference, codeOf(item.accountId)]),
    ).toEqual([
      ['card', '4242', '1121'],
      ['bkash', 'TRX8KD2Q1', '1131'],
      ['cash', null, '1110'],
    ]);
    expect(done.lines[0]?.serialNumbers).toEqual(['IMEI-1']);
    expect(await entryLines(done)).toEqual([
      ['1110', '2250.0000', '0.0000'],
      ['1121', '10000.0000', '0.0000'],
      ['1131', '5000.0000', '0.0000'],
      ['1150', '0.0000', '9000.0000'],
      ['2120', '0.0000', '2250.0000'],
      ['4110', '0.0000', '15000.0000'],
      ['5110', '9000.0000', '0.0000'],
    ]);
  });

  it('is for the customer the cashier picked, also one archived since', async () => {
    const lalmatia = await addCustomer('Lalmatia Pharmacy');
    const first = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '28.75')], { customerId: lalmatia.id }),
    );
    expect(first.customer).toEqual({ id: lalmatia.id, code: lalmatia.code, name: lalmatia.name });
    // No receivable: the whole amount was paid at the counter
    expect((await entryLines(first)).map((row) => row[0])).not.toContain('1140');
    const archived = await send('POST', `/customers/${lalmatia.id}/archive`, {
      version: lalmatia.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    // Sold while the device still had the customer: it was sold already
    const second = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { customerId: lalmatia.id }),
    );
    const page = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?customerId=${lalmatia.id}`)).json(),
    );
    expect(page.items.map((item) => item.number).sort()).toEqual(
      [first.number, second.number].sort(),
    );
    const unknown = await push([
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { customerId: v7() }),
    ]);
    expect(refusal(unknown[0])).toMatchObject({
      code: 'sales_customer_invalid',
      fieldErrors: { customerId: ['sales_customer_invalid'] },
    });
  });

  it("works VAT out of prices that include it, shares the bill's discount, and logs the overrides", async () => {
    // Four juices at ৳23 (the shelf says ৳25) and a wrapping at ৳46, VAT inside: ৳138. Half off
    // the bill (৳69), shared 92 : 46, so the juices pay ৳46 (VAT ৳6) and the wrapping ৳23 (VAT ৳3).
    const done = await sold(
      sale(
        pos1,
        [line(juice, '4', '23', { startingPrice: '25' }), line(wrap, '1', '46')],
        [paid('cash', '100')],
        { pricesIncludeVat: true, billDiscountType: 'percent', billDiscount: '50' },
      ),
    );
    expect(done).toMatchObject({
      pricesIncludeVat: true,
      billDiscountType: 'percent',
      billDiscount: '50.0000',
      billDiscountAmount: '69.0000',
      net: '60.0000',
      vat: '9.0000',
      total: '69.0000',
      change: '31.0000',
    });
    expect(
      done.lines.map((item) => [item.billDiscount, item.net, item.vat, item.startingPrice]),
    ).toEqual([
      ['46.0000', '40.0000', '6.0000', '25.0000'],
      ['23.0000', '20.0000', '3.0000', '46.0000'],
    ]);
    expect(await entryLines(done)).toEqual([
      ['1110', '69.0000', '0.0000'],
      ['1150', '0.0000', '60.0000'],
      ['2120', '0.0000', '9.0000'],
      ['4110', '0.0000', '60.0000'],
      ['5110', '60.0000', '0.0000'],
    ]);
    // Nusrat may: the audit log says what she did, and that she was allowed to
    const entries = await auditOf('pos_sale', done.id);
    expect(entries.map((entry) => [entry.action, entry.changes])).toContainEqual([
      'pos_sale.overridden',
      {
        overrides: { from: null, to: 'price on line 1, bill discount' },
        maxDiscountPercent: { from: null, to: '5.00' },
        allowed: { from: null, to: true },
      },
    ]);
  });

  it("is taken from a cashier who went over the register's limit, and the log says so", async () => {
    // POS2's limit is 2.5%; Sumi gives 10% off a juice without pos.price.override
    const done = await sold(
      sale(pos2, [line(juice, '1', '25', { discount: '10' })], [paid('cash', '30')]),
      sumiTablet,
      sumi,
    );
    // ৳22.50 after the discount; the VAT of ৳3.375 is rounded to the paisa
    expect(done).toMatchObject({ cashier: { fullName: 'Sumi Akter' }, total: '25.8800' });
    const entries = await auditOf('pos_sale', done.id);
    expect(entries.find((entry) => entry.action === 'pos_sale.overridden')?.changes).toEqual({
      overrides: { from: null, to: 'discount on line 1' },
      maxDiscountPercent: { from: null, to: '2.50' },
      allowed: { from: null, to: false },
    });
  });

  it("is booked on the device's day, unless that day is ahead or closed", async () => {
    const yesterday = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { date: addDays(today, -1) }),
    );
    expect(yesterday.date).toBe(addDays(today, -1));
    // A clock set a day ahead: the books take today
    const ahead = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { date: addDays(today, 1) }),
    );
    expect(ahead.date).toBe(today);

    // The books closed up to yesterday: a sale of two days ago goes on today, the first open day
    const lock = periodLockSchema.parse((await send('GET', '/period-lock')).json());
    const closed = await send('PUT', '/period-lock', {
      lockDate: addDays(today, -1),
      version: lock.version,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const late = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { date: addDays(today, -2) }),
    );
    expect(late.date).toBe(today);
    const [entry] = await auditOf('pos_sale', late.id);
    expect(entry?.changes).toMatchObject({
      date: { from: null, to: today },
      soldOn: { from: null, to: addDays(today, -2) },
    });
    const opened = await send('PUT', '/period-lock', {
      lockDate: '',
      version: periodLockSchema.parse(closed.json()).version,
    });
    expect(opened.statusCode, opened.body).toBe(200);
  });

  it('goes below zero rather than be refused, and tells the people who keep the stock', async () => {
    // All the juice and 5 more; 10 strips of Napa from batch A, which has 3; and a phone whose
    // serial number the store does not have
    const juiceLeft = await onHand(main, juice);
    const done = await sold(
      sale(
        pos1,
        [
          line(juice, String(Number(juiceLeft) + 5), '25'),
          line(napa, '10', '30', { batchId: batchA }),
          line(phone, '1', '15000', { serialNumbers: ['IMEI-9'] }),
        ],
        [paid('cash', '50000')],
      ),
    );
    expect(done.soldShort).toBe(true);
    // A first, then B by its expiry (the expired OLD batch is skipped), the rest below zero on A
    expect(done.lines[1]?.batches.map((part) => [part.lotNumber, part.quantity])).toEqual([
      ['NP-A', '5.0000'],
      ['NP-B', '5.0000'],
    ]);
    expect(done.lines.map((item) => item.shortQuantity)).toEqual(['5.0000', '2.0000', '0.0000']);
    expect(await onHand(main, juice)).toBe('-5.0000');
    const lots = z.array(z.object({ lot_number: z.string(), quantity: z.string() })).parse(
      await sql`SELECT b.lot_number, s.quantity::text FROM stock_balances s
                  JOIN batches b ON b.id = s.batch_id
                  WHERE s.warehouse_id = ${main.id} ORDER BY b.lot_number`,
    );
    expect(lots).toEqual([
      { lot_number: 'NP-A', quantity: '-2.0000' },
      { lot_number: 'NP-B', quantity: '0.0000' },
      { lot_number: 'NP-OLD', quantity: '4.0000' },
    ]);

    const short = soldShortPageSchema.parse((await send('GET', '/pos/sold-short')).json());
    expect(
      short.items.map((item) => [
        item.productName,
        item.saleNumber,
        item.shortQuantity,
        item.lotNumber,
        item.serialNumbers,
        item.onHandNow,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['Mango juice 250 ml', done.number, '5.0000', null, [], '-5.0000'],
        ['Napa 500 mg strip', done.number, '2.0000', 'NP-A', [], '2.0000'],
        ['Walton Primo phone', done.number, '0.0000', null, ['IMEI-9'], '0.0000'],
      ]),
    );
    const elsewhere = soldShortPageSchema.parse(
      (await send('GET', `/pos/sold-short?warehouseId=${uttaraStore.id}`)).json(),
    );
    expect(elsewhere.items).toEqual([]);

    // The owner and the shop manager hear about it; the cashier and Rafiq do not
    await eventually(async () => {
      const bells = z
        .array(z.object({ email: z.string(), params: z.record(z.string(), z.unknown()) }))
        .parse(
          await sql`SELECT u.email, n.params FROM notifications n JOIN users u ON u.id = n.user_id
                     WHERE n.type = 'pos.sold_short' ORDER BY u.email`,
        );
      expect(bells.map((bell) => bell.email)).toEqual([
        'kamal@agoramart.com',
        'nusrat@agoramart.com',
      ]);
      expect(bells[0]?.params).toEqual({
        id: done.id,
        number: done.number,
        warehouse: main.name,
        count: 3,
      });
    });

    // Put right with an adjustment: the list shows the stock now
    await stockIn(main, [inLine(juice, '24', '15')]);
    const after = soldShortPageSchema.parse((await send('GET', '/pos/sold-short')).json());
    expect(after.items.find((item) => item.productName === 'Mango juice 250 ml')?.onHandNow).toBe(
      '19.0000',
    );
  });

  it('is refused a batch or serial numbers a device never sends, and keeps the number', async () => {
    const results = await push([
      sale(pos1, [line(napa, '1', '30')], [paid('cash', '40')]),
      sale(pos1, [line(napa, '1', '30', { batchId: v7() })], [paid('cash', '40')]),
      sale(
        pos1,
        [line(phone, '2', '15000', { serialNumbers: ['IMEI-2'] })],
        [paid('cash', '40000')],
      ),
    ]);
    expect(results.map((result) => refusal(result))).toEqual([
      {
        code: 'stock_batch_required',
        fieldErrors: { 'lines.0.batchId': ['stock_batch_required'] },
      },
      { code: 'stock_batch_invalid', fieldErrors: { 'lines.0.batchId': ['stock_batch_invalid'] } },
      {
        code: 'stock_serial_count',
        fieldErrors: { 'lines.0.serialNumbers': ['stock_serial_count'] },
      },
    ]);
    // Their receipts were printed: the numbers are used, and the next device goes on after them
    expect((await registerNow(pos1)).lastNumber).toBe(sequences.get(pos1.id));
  });

  it('is refused a way of paying the register has no account for, and keeps the number', async () => {
    const results = await push(
      [sale(pos2, [line(juice, '1', '25')], [paid('cash', '10'), paid('bkash', '20', 'TRX1')])],
      sumiTablet,
      sumi,
    );
    expect(refusal(results[0])).toEqual({
      code: 'pos_method_not_set',
      fieldErrors: { 'payments.1.method': ['pos_method_not_set'] },
    });
    expect((await registerNow(pos2)).lastNumber).toBe(sequences.get(pos2.id));

    // POS1 stops taking cards while a card sale waits on the counter PC
    const before = await registerNow(pos1);
    const noCard = await send(
      'PUT',
      `/pos/registers/${pos1.id}`,
      editForm(before, { accounts: { ...accountsForm(before), card: '' } }),
    );
    expect(noCard.statusCode, noCard.body).toBe(200);
    const card = await push([
      sale(pos1, [line(juice, '1', '25')], [paid('card', '28.75', '4242')]),
    ]);
    expect(refusal(card[0]).code).toBe('pos_method_not_set');
    const back = await send(
      'PUT',
      `/pos/registers/${pos1.id}`,
      editForm(posRegisterSchema.parse(noCard.json()), { accounts: accountsForm(before) }),
    );
    expect(back.statusCode, back.body).toBe(200);
    // The number after the refused one is free
    await sold(sale(pos1, [line(juice, '1', '25')], [paid('card', '28.75', '4242')]));
  });

  it('is refused for a register the device does not hold', async () => {
    const results = await push(
      [sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')])],
      officeLaptop,
    );
    expect(refusal(results[0])).toEqual({
      code: 'pos_register_not_held',
      fieldErrors: { registerId: ['pos_register_not_held'] },
    });
  });

  it("is refused for what the device's own form refuses, and keeps no answer", async () => {
    const commands = [
      // ৳28.75 to pay, ৳20 given
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '20')]),
      // A card charged more than the total: change comes only from the cash
      sale(pos1, [line(juice, '1', '25')], [paid('card', '30', '4242')]),
      sale(pos1, [line(juice, '1', '25')], []),
    ];
    const results = await push(commands);
    expect(results.map((result) => refusal(result))).toEqual([
      { code: 'invalid_input', fieldErrors: { payments: ['pos_payment_short'] } },
      { code: 'invalid_input', fieldErrors: { payments: ['pos_change_not_cash'] } },
      { code: 'invalid_input', fieldErrors: { payments: ['pos_payments_required'] } },
    ]);
    const kept = await sql`SELECT id FROM sync_commands
                            WHERE id IN ${sql(commands.map((command) => command.id))}`;
    expect(kept).toHaveLength(0);
    // The device never saves such a sale, so the server does not keep its number either
    sequences.set(pos1.id, (await registerNow(pos1)).lastNumber);
  });

  it('is posted when the cashier lost pos.sale.create since, and the log says so', async () => {
    // Taken away while Sumi's tablet was offline: the sale she made then is in the drawer already,
    // so it is posted when it arrives (decision 28)
    await giveRoles('sumi@agoramart.com', []);
    const command = sale(pos2, [line(juice, '1', '25')], [paid('cash', '30')]);
    const done = await sold(command, sumiTablet, sumi);
    expect(done.number).toBe(numberOf(command, 'POS2'));
    const entries = await auditOf('pos_sale', done.id);
    expect(entries.map((entry) => [entry.action, entry.changes])).toContainEqual([
      'pos_sale.without_permission',
      {
        number: { from: null, to: done.number },
        soldOn: { from: null, to: command.input.date },
        missing: { from: null, to: 'pos.sale.create' },
      },
    ]);
    await giveRoles('sumi@agoramart.com', ['Cashier']);

    // With the permission back, a sale writes no such row
    const next = await sold(
      sale(pos2, [line(juice, '1', '25')], [paid('cash', '30')]),
      sumiTablet,
      sumi,
    );
    const nextEntries = await auditOf('pos_sale', next.id);
    expect(nextEntries.map((entry) => entry.action)).not.toContain('pos_sale.without_permission');
  });

  it('runs once when sent again; its id and its number are used once', async () => {
    const command = sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]);
    expect(outcomes(await push([command, command]))).toEqual(['accepted', 'accepted']);
    expect(outcomes(await push([command]))).toEqual(['accepted']);
    const page = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos1.id}&limit=100`)).json(),
    );
    expect(page.items.filter((item) => item.number === numberOf(command, 'POS1'))).toHaveLength(1);

    // The sale's id under a new command, and the same number with a new sale id: only a bug sends
    // either, and each is refused rather than written twice
    const sameId = {
      ...sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]),
      saleId: command.saleId,
    };
    const sameNumber = { ...command, id: v7(), saleId: v7() };
    const results = await push([sameId, sameNumber]);
    expect(refusal(results[0])).toEqual({ code: 'sync_id_taken' });
    expect(refusal(results[1])).toEqual({
      code: 'pos_number_taken',
      fieldErrors: { sequence: ['pos_number_taken'] },
    });
  });

  it('is written one after the other when two pushes of one register arrive together', async () => {
    const first = sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]);
    const second = sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]);
    // The later number may arrive first: the last number is the highest, whatever the order
    const [a, b] = await Promise.all([push([second]), push([first])]);
    expect(outcomes([...a, ...b])).toEqual(['accepted', 'accepted']);
    expect((await registerNow(pos1)).lastNumber).toBe(second.input.sequence);
  });

  it('is listed newest first, by register, one page at a time', async () => {
    const byRegister = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos2.id}`)).json(),
    );
    // Only POS2's: Sumi's three on her tablet
    expect(byRegister.items.map((item) => item.register.code)).toEqual(['POS2', 'POS2', 'POS2']);
    const numbers: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = posSalePageSchema.parse(
        (await send('GET', `/pos/sales?registerId=${pos1.id}&limit=3${after}`)).json(),
      );
      numbers.push(...page.items.map((item) => item.number));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos1.id}&limit=100`)).json(),
    );
    expect(numbers).toEqual(all.items.map((item) => item.number));
    // Newest day first: the sale of yesterday is last
    expect(all.items.at(-1)?.date).toBe(addDays(today, -1));
    const missing = await send('GET', `/pos/sales/${v7()}`);
    expect(missing.statusCode).toBe(404);
  });

  it("keeps its entry out of the journal's Reverse", async () => {
    const [latest] = posSalePageSchema.parse(
      (await send('GET', '/pos/sales?limit=1')).json(),
    ).items;
    if (!latest) throw new Error('no sale');
    const done = await saleNow(latest.id);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${done.entry?.id ?? ''}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: today,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('journal_is_stock');
  });
});

describe('what a POS sale or a register points at', () => {
  it('is not deleted: the customer, the item and the account', async () => {
    const customer = await addCustomer('Mohammadpur Store');
    await sold(
      sale(pos1, [line(wrap, '1', '50')], [paid('cash', '60')], { customerId: customer.id }),
    );
    const gone = await send(
      'DELETE',
      `/customers/${customer.id}?version=${String(customer.version)}`,
    );
    expect(gone.statusCode).toBe(409);
    expect(problemOf(gone).code).toBe('customer_in_use');

    const item = await send('DELETE', `/products/${wrap.id}?version=${String(wrap.version)}`);
    expect(item.statusCode).toBe(409);
    expect(problemOf(item).code).toBe('product_in_use');

    // A wallet only a register uses
    const nagad = await created(accountSchema, '/accounts', {
      parentId: accountId('1130'),
      code: '1132',
      name: 'Nagad merchant 01811',
      isGroup: false,
      holdsMoney: false,
      description: '',
    });
    const now = await registerNow(pos2);
    const res = await send(
      'PUT',
      `/pos/registers/${pos2.id}`,
      editForm(now, { accounts: { ...accountsForm(now), nagad: nagad.id } }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const account = await send('DELETE', `/accounts/${nagad.id}?version=${String(nagad.version)}`);
    expect(account.statusCode).toBe(409);
    expect(problemOf(account).code).toBe('account_in_use');
  });
});
```

The file is long, so here it is part by part, in its own order.

**The world.** Agora Mini Mart, a retail shop (`POST /setup` with `retail`, then wait for `ready`), so the Cashier and
Shop manager roles of 20a.3 exist. Dhanmondi is the main branch with three warehouses: MAIN (the stock), BACK (empty,
so it can still change branch) and OLD (archived). Uttara is a second branch with UTT1. Four people: Nusrat the owner,
Sumi with the Cashier role, Kamal with the Shop manager role, and Rafiq with no role.

- **`member()` signs the person up in a shop of their own first,** then joins them to Agora Mini Mart with no role
  (`joinWithoutRoles`, the helper of step 7) and signs them in there. There is no invitation in a test; the roles come
  next, from the retail templates, by name.
- **`today` comes from the workspace's time zone** (`todayIn(settings.timezone)`), the same day the server books on.
  Every date in the file is worked out from it with `addDays()`: the opening stock 20 days back, batch expiry dates
  90 and 200 days ahead, one batch expired 5 days ago. A date typed by hand (`2027-01-31`) would make the test fail on
  the day it passes; step 18a had such tests and they had to be fixed.
- **The card's bank account (1121) and the bKash wallet (1131) are made under the money groups** (1120, 1130). The
  retail chart has the groups but no bank: every company adds its own. Under a money group, an account needs no tick of
  its own (step 15c).
- **Four items, one of each kind the sale treats differently:** Mango juice (no tracking), Napa (batches with expiry),
  a Walton phone (serial numbers) and Gift wrapping (a service: no stock, no cost).
- **The opening stock costs ৳15 a juice, ৳20 a strip, ৳9,000 a phone,** so every cost in an entry below is easy to check
  by hand: the moving average stays at those prices.
- **Four devices:** the owner's front counter PC and back office laptop in Dhanmondi, her Uttara PC, and Sumi's tablet.

**The helpers.**

- **`sequences` keeps each register's last number the way a device does:** `claimed()` sets it from the claim's
  `lastNumber`, and `sale()` takes the next one. So every sale has the number the app would give it, and a test that
  checks "the number was kept" compares the register's `lastNumber` with this map.
- **`sale()` builds a whole `pos_sale.create` command** with new UUIDv7 ids (the push checks the version digit), sold
  today to a walk-in. `line()` puts the shelf price in both `unitPrice` and `startingPrice`, so a line is no override
  unless a test says so.
- **`entryLines()` reads the sale's journal entry as `[code, debit, credit]`, sorted by code.** An accountant checks
  an entry this way, and the sort makes the order of `write()`'s sums not matter.
- **`onHand()` reads `stock_balances` as the superuser,** every batch together. No route of this step shows one
  warehouse's stock of one item, and the stock card would need a page of its own.
- **`pulled()` expects one page:** a new workspace has a few hundred rows, far under the limit of 1,000.

**POS registers.**

- **The code is upper-cased** (`pos1` → `POS1`), and an empty discount limit is `0.00`: no discount at all without the
  permission. The list is sorted by code and says who holds each one; the branch filter goes through the warehouse.
- **The audit row names the warehouse and the accounts by their codes** (`MAIN`, `1110`), and leaves out an account the
  register does not have (`created()` drops `null` values).
- **The refusals:** a code that is taken (409, under `code`), an archived warehouse, and two accounts that hold no
  money at once (Sales, and the wallets' group itself: a group takes no entries). The form's own checks come back as a
  400 with one code per field. The list after them still has four registers: nothing was half made.
- **A cashier cannot make a register; Rafiq, with no role, can read them** (reading needs no permission, like
  warehouses).
- **The edit drops a `code` in the body:** the edit schema has no code, and Zod drops keys it does not know. The audit
  row shows only what changed. An old version is `version_conflict`, like every edit.
- **An archived register is not in the default list, is in `?status=archived`, and cannot be taken**
  (`pos_register_archived`). Restoring brings it back.

**A device and its register.**

- **A claim does not change the version** (decision 43): `toMatchObject` checks it is still the register's first
  version. The same claim again answers the same JSON: an app that lost the first answer sends it again.
- **Three refusals in one test:** another device holds it (`pos_register_in_use`), this device holds another
  (`pos_device_has_register`), and a device of Uttara asking for a Dhanmondi register (`pos_register_branch`).
- **Rafiq is refused by the route's guard** (`permission_missing`, 403) before his device is even looked at. Sumi has
  the permission but asks with the owner's PC: `device_not_found`, the same answer as an id nobody registered, so she
  cannot learn which devices exist.
- **Release:** only the holder may (`pos_register_not_held` for the laptop). Sumi lets go without
  `pos.register.manage`: it is her device's register. A second release answers the free register as it is.
- **Two claims at the same moment:** `Promise.all` sends both before either answers. The register is locked `FOR
  UPDATE`, so the second sees the first one's device: one 200 and one `pos_register_in_use`. The order is not fixed,
  so the test sorts the status codes and then asks the register who won.
- **One device asking for two registers at the same moment** takes the other path: each claim locks a different
  register, both see "this device holds nothing yet", and the database's unique index on `device_id` refuses the
  second insert. `databaseError()` turns it into `pos_device_has_register`, not a 500. The test then archives POS4,
  so it does not show up in the later lists.
- **Revoked or moved, the device lets go:** the revoke route and the move route of step 18c say nothing about
  registers; 0052's triggers free the register in the same transaction, without a version (`version: pos3.version`).
  The revoked device cannot claim again (`device_revoked`).

**A register's warehouse.** While a device holds POS3, its warehouse cannot go to another branch: not by editing the
register (`pos_register_branch`, under `warehouseId`) and not by editing the warehouse (`warehouse_branch_locked`).
Another warehouse of the same branch is fine. Once the register is free, moving BACK to Uttara takes POS3 with it,
and a Dhanmondi device can no longer claim it.

**The pull.**

- **A device gets its own branch's registers only, without `lastNumber`** (decision 20): the laptop sees POS1 and
  POS2 (POS3 moved away, POS4 is archived), Uttara's PC sees UTT1 and POS3.
- **The delta pull after a sale has no register in it.** This is the reason for 0052's rule that a change of
  `last_number` alone writes no change log line: otherwise every sale would send every device of the branch the
  register again.
- **A new register, a claim and an archive each come in the next delta pull.** The archive comes as a `delete`, so the
  device drops it.

**A sale pushed from the counter.**

- **The first sale is checked whole:** the answer (accepted, no notices, no rows: sales are not kept on the device), the
  number (`POS1-000002`: the pull test sold number 1), the totals, the two ৳100 notes as two payments, a service line
  with no batches, the stock down by 2, the register's last number, and the audit row with the device on it.
- **Its entry:** the two notes are one cash line, and the change is taken off it: Dr cash ৳115, Cr sales ৳100, Cr VAT
  ৳15, Dr COGS / Cr inventory ৳30 (two juices at ৳15; the wrapping costs nothing).
- **Three ways of paying:** each payment goes to the register's account for its method, with its reference. The change
  (৳750) comes off the cash line only, so cash is ৳2,250 in the books.
- **A customer archived after the sale still gets it** (decision 47): the device sold to the customer it had. The
  entry has no receivable line. An id that is no customer is refused (`sales_customer_invalid`), and that refusal still
  uses the number.
- **Prices with VAT inside, and half off the bill.** The numbers are picked so every amount is whole: ৳138 of goods,
  ৳69 off shared 92 : 46, VAT of 15/115 on what is left. The price change (৳23 instead of ৳25) and the bill discount
  over the 5% limit are both in the override row, with `allowed: true` because Nusrat has `pos.price.override`.
- **Sumi's 10% on a register that allows 2.5%** is accepted (decision 25) and logged with `allowed: false`. The total
  is ৳25.88, not ৳25.875: the VAT is rounded to the paisa.
- **The booking date:** yesterday stays yesterday; a device clock a day ahead books today; with the books closed up to
  yesterday, a sale of two days ago books today, and the audit row keeps the device's day as `soldOn`. The test opens
  the books again at the end, or the next tests' stock adjustment (20 days back) would be refused.
- **Selling short.** The juice line asks for 5 more than the shop has, the Napa line 10 from batch A (which has 3), and
  the phone line has a serial number the shop never had. Napa leaves A, then B by its expiry; the expired OLD batch is
  skipped (decision 45), and the 2 still missing go below zero on A. The phone leaves without its serial: its quantity
  was there (IMEI-2), so `shortQuantity` is 0 and the serial is on the list. The bell reaches the owner and the shop
  manager (`inventory.stock.adjust`), not the cashier or Rafiq; `eventually()` waits for the worker. An adjustment in
  afterwards moves `onHandNow` on the list, so a manager sees it was put right.
- **Refusals the device never causes** (a batch item with no batch, a batch nobody has, two phones with one serial)
  each answer their own code, and their numbers are kept: the receipts were printed.
- **A way of paying the register has no account for** is refused under `payments.1.method`, for a register that never
  had it and for one that lost it while the sale waited. The number after a refused one is free.
- **A register the device does not hold** is refused under `registerId`.
- **What the sale's own schema refuses** (paid too little, change from a card, no payment) is `invalid_input` and keeps
  no answer: the same bytes always get the same refusal (step 18b). Its number is not kept either: the app never saves
  such a sale, so the test takes the map back to the register's last number.
- **The roles of now:** Sumi's role is taken away while her tablet waits, and her sale is still posted, with its
  number and a `pos_sale.without_permission` row (decision 28). With the role back, her next sale writes no such row.
  The list test after it now expects POS2's three sales.
- **Sent again:** twice in one push and once more, one sale. The same sale id under a new command is `sync_id_taken`; the
  same number with a new sale id is `pos_number_taken`, refused and not written twice.
- **Two pushes of one register at the same moment,** the later number first: both are written (the register is locked
  `FOR UPDATE`, so one waits), and the last number is the higher one.
- **The list** walks POS1's sales three at a time and must give the same numbers, in the same order, as one page of
  100. Yesterday's sale is last: newest day first.
- **The journal's Reverse refuses the entry** (`journal_is_stock`): only a POS return (20c) may undo a sale.

**What a sale or a register points at** cannot be deleted: the customer (`customer_in_use`), the product
(`product_in_use`, the product's own delete answer) and a wallet only a register uses (`account_in_use`). Each says
"Archive it instead" in the app, not a 500.

### `pos/pos.tenant-leak.int.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Customer,
  customerSchema,
  type Device,
  deviceSchema,
  type PosRegister,
  posRegisterListSchema,
  posRegisterSchema,
  type PosSale,
  posSalePageSchema,
  posSaleSchema,
  problemSchema,
  type Product,
  productSchema,
  setupSchema,
  soldShortPageSchema,
  SYNC_PROTOCOL,
  type SyncCommandInput,
  syncPullSchema,
  syncPushSchema,
  type TaxRate,
  taxRateListSchema,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Step 20a. Two shops: A must never see, change, take or let go of B's registers, nor read B's
// sales or what B sold short; and a sale A's counter pushes takes none of B's registers,
// customers, items, VAT rates or batches. Every answer is 404, or the same refusal as for an id
// that does not exist.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the batches and the bell, which no route of this step lists
let sql: postgres.Sql;

// What each workspace has: its owner, its store, its chart, a VAT rate, Napa with a batch, a
// customer, and a counter PC that holds its register
interface Shop {
  who: SignedIn;
  store: Warehouse;
  accounts: Account[];
  vat: TaxRate;
  pcs: string;
  napa: Product;
  batchId: string;
  customer: Customer;
  device: Device;
  register: PosRegister;
}

let a: Shop;
let b: Shop;
// B's sale: Napa it did not have enough of, for its customer
let saleOfB: PosSale;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];

function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

function as(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof as>>) {
  return problemSchema.parse(res.json());
}

function cashOf(shop: Pick<Shop, 'accounts'>): string {
  const cash = shop.accounts.find((account) => account.code === '1110');
  if (!cash) throw new Error('no cash account');
  return cash.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function registerForm(code: string, warehouseId: string, cash: string) {
  return {
    code,
    name: `Counter ${code}`,
    warehouseId,
    accounts: { cash, card: '', bkash: '', nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
  };
}

function claim(shop: Pick<Shop, 'who' | 'device'>, register: PosRegister) {
  return as(shop.who, 'POST', `/pos/registers/${register.id}/claim`, {
    deviceId: shop.device.id,
  });
}

async function open(company: string, slug: string, fullName: string, email: string) {
  const who = await signUp(app, {
    companyName: company,
    workspaceSlug: slug,
    fullName,
    email,
    password: 'Counter-shop-2026',
  });
  expect((await as(who, 'POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  const [store] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!store) throw new Error('no warehouse');
  const accounts = accountListSchema.parse((await as(who, 'GET', '/accounts')).json()).items;
  const [vat] = taxRateListSchema.parse((await as(who, 'GET', '/tax-rates')).json()).items;
  if (!vat) throw new Error('no VAT rate');
  const units = unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
  const pcs = units.find((unit) => unit.code === 'pcs')?.id ?? '';

  const made = await as(who, 'POST', '/products', {
    code: '',
    name: 'Napa 500 mg strip',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'batch',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '30', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(made.statusCode, made.body).toBe(201);
  const napa = productSchema.parse(made.json());
  const lotNumber = `${slug.toUpperCase()}-LOT`;
  const stocked = await as(who, 'POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: store.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      {
        variantId: variantOf(napa),
        unitId: pcs,
        quantity: '2',
        batchId: '',
        lotNumber,
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        unitCost: '20',
      },
    ],
  });
  expect(stocked.statusCode, stocked.body).toBe(201);
  const [lot] = z
    .array(z.object({ id: z.string() }))
    .parse(await sql`SELECT id::text FROM batches WHERE lot_number = ${lotNumber}`);

  const customer = await as(who, 'POST', '/customers', {
    code: '',
    name: `${company} regular`,
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
  expect(customer.statusCode, customer.body).toBe(201);
  const device = await as(who, 'POST', '/sync/devices', {
    id: v7(),
    name: 'Front counter PC',
    branchId: store.branchId,
  });
  expect(device.statusCode, device.body).toBe(201);
  const made1 = await as(
    who,
    'POST',
    '/pos/registers',
    registerForm('POS1', store.id, cashOf({ accounts })),
  );
  expect(made1.statusCode, made1.body).toBe(201);
  const shop: Shop = {
    who,
    store,
    accounts,
    vat,
    pcs,
    napa,
    batchId: lot?.id ?? '',
    customer: customerSchema.parse(customer.json()),
    device: deviceSchema.parse(device.json()),
    register: posRegisterSchema.parse(made1.json()),
  };
  const held = await claim(shop, shop.register);
  expect(held.statusCode, held.body).toBe(200);
  return { ...shop, register: posRegisterSchema.parse(held.json()) };
}

// Five strips of Napa from the shop's own batch
function line(shop: Shop, extra: Partial<SaleLine> = {}): SaleLine {
  return {
    variantId: variantOf(shop.napa),
    unitId: shop.pcs,
    quantity: '5',
    description: '',
    unitPrice: '30',
    discountType: 'percent',
    discount: '0',
    taxRateId: shop.vat.id,
    rate: shop.vat.rate,
    startingPrice: '30',
    batchId: shop.batchId,
    serialNumbers: [],
    ...extra,
  };
}

function sale(
  shop: Shop,
  sequence: number,
  lines: SaleLine[],
  extra: Partial<SaleCommand['input']> = {},
): SaleCommand {
  return {
    id: v7(),
    type: 'pos_sale.create',
    saleId: v7(),
    input: {
      registerId: shop.register.id,
      sequence,
      date: '2026-10-27',
      soldAt: '2026-10-27T08:30:00.000Z',
      customerId: '',
      pricesIncludeVat: true,
      lines,
      billDiscountType: 'amount',
      billDiscount: '0',
      payments: [{ method: 'cash', amount: '500', reference: '' }],
      ...extra,
    },
  };
}

async function pushed(shop: Shop, commands: SaleCommand[]) {
  const res = await as(shop.who, 'POST', '/sync/push', {
    deviceId: shop.device.id,
    protocol: SYNC_PROTOCOL,
    commands,
  });
  expect(res.statusCode, res.body).toBe(200);
  return syncPushSchema.parse(res.json()).results;
}

async function registerOfBNow(): Promise<PosRegister> {
  return posRegisterSchema.parse(
    (await as(b.who, 'GET', `/pos/registers/${b.register.id}`)).json(),
  );
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
  [a, b] = await Promise.all([
    open('Agora Mini Mart', 'agora-mini-mart', 'Nusrat Jahan', 'nusrat@agoramart.com'),
    open('Banani Super Shop', 'banani-super-shop', 'Tareq Aziz', 'tareq@bananisupershop.com'),
  ]);
  // B sells 5 strips with 2 on hand, to its regular customer: a sold-short line and a bell
  const [result] = await pushed(b, [sale(b, 1, [line(b)], { customerId: b.customer.id })]);
  expect(result?.status, JSON.stringify(result)).toBe('accepted');
  const [first] = posSalePageSchema.parse((await as(b.who, 'GET', '/pos/sales')).json()).items;
  if (!first) throw new Error('B has no sale');
  saleOfB = posSaleSchema.parse((await as(b.who, 'GET', `/pos/sales/${first.id}`)).json());
  expect(saleOfB.soldShort).toBe(true);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("another workspace's registers", () => {
  it('are not read, changed, archived, restored, taken or let go', async () => {
    const id = b.register.id;
    const version = { version: b.register.version };
    const answers = await Promise.all([
      as(a.who, 'GET', `/pos/registers/${id}`),
      // A valid form of A's own, so the answer is about whose register it is
      as(a.who, 'PUT', `/pos/registers/${id}`, {
        ...registerForm('POS1', a.store.id, cashOf(a)),
        ...version,
      }),
      as(a.who, 'POST', `/pos/registers/${id}/archive`, version),
      as(a.who, 'POST', `/pos/registers/${id}/restore`, version),
      as(a.who, 'POST', `/pos/registers/${id}/claim`, { deviceId: a.device.id }),
      as(a.who, 'POST', `/pos/registers/${id}/release`, { deviceId: a.device.id }),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    // Still B's, held by B's counter, with B's one sale
    expect(await registerOfBNow()).toEqual({ ...b.register, lastNumber: 1 });
    const list = posRegisterListSchema.parse((await as(a.who, 'GET', '/pos/registers')).json());
    expect(list.items.map((item) => item.id)).toEqual([a.register.id]);
    const branch = posRegisterListSchema.parse(
      (await as(a.who, 'GET', `/pos/registers?branchId=${b.store.branchId}`)).json(),
    );
    expect(branch.items).toEqual([]);
  });

  it("are not taken by A's devices, and A's are not taken by B's", async () => {
    // A lets go of its own register, then asks for it with B's counter PC: a device A does not have
    const free = await as(a.who, 'POST', `/pos/registers/${a.register.id}/release`, {
      deviceId: a.device.id,
    });
    expect(free.statusCode, free.body).toBe(200);
    const res = await as(a.who, 'POST', `/pos/registers/${a.register.id}/claim`, {
      deviceId: b.device.id,
    });
    expect(res.statusCode).toBe(404);
    expect(problemOf(res).code).toBe('device_not_found');
    const back = await claim(a, a.register);
    expect(back.statusCode, back.body).toBe(200);
  });

  it("are not made with B's warehouses or accounts", async () => {
    const store = await as(
      a.who,
      'POST',
      '/pos/registers',
      registerForm('POS2', b.store.id, cashOf(a)),
    );
    expect(problemOf(store).fieldErrors).toEqual({
      warehouseId: ['pos_register_warehouse_invalid'],
    });
    const cash = await as(
      a.who,
      'POST',
      '/pos/registers',
      registerForm('POS2', a.store.id, cashOf(b)),
    );
    expect(problemOf(cash).fieldErrors).toEqual({
      'accounts.cash': ['pos_register_account_invalid'],
    });
  });

  it("are not in A's pull", async () => {
    const query = new URLSearchParams({
      deviceId: a.device.id,
      protocol: String(SYNC_PROTOCOL),
      limit: '1000',
    });
    const res = await as(a.who, 'GET', `/sync/pull?${query.toString()}`);
    expect(res.statusCode, res.body).toBe(200);
    const keys = syncPullSchema
      .parse(res.json())
      .changes.filter((change) => change.entity === 'pos_register')
      .map((change) => change.key);
    expect(keys).toEqual([a.register.id]);
  });
});

describe("another workspace's sales", () => {
  it('are not read or listed, nor what they sold short', async () => {
    expect((await as(a.who, 'GET', `/pos/sales/${saleOfB.id}`)).statusCode).toBe(404);
    for (const query of ['', `?registerId=${b.register.id}`, `?customerId=${b.customer.id}`]) {
      const page = posSalePageSchema.parse((await as(a.who, 'GET', `/pos/sales${query}`)).json());
      expect(page.items).toEqual([]);
    }
    for (const query of ['', `?warehouseId=${b.store.id}`]) {
      const page = soldShortPageSchema.parse(
        (await as(a.who, 'GET', `/pos/sold-short${query}`)).json(),
      );
      expect(page.items).toEqual([]);
    }
    // B's bell reached B's owner only
    await eventually(async () => {
      const bells = z.array(z.object({ email: z.string() })).parse(
        await sql`SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id
                    WHERE n.type = 'pos.sold_short'`,
      );
      expect(bells.map((bell) => bell.email)).toEqual(['tareq@bananisupershop.com']);
    });
  });

  it("take none of B's registers, customers, items, VAT rates or batches", async () => {
    // Number 9 of B's register: if it leaked, B's last number would jump from 1 to 9
    const onB = sale(a, 9, [line(a)]);
    const results = await pushed(a, [
      { ...onB, input: { ...onB.input, registerId: b.register.id } },
      sale(a, 2, [line(a)], { customerId: b.customer.id }),
      sale(a, 3, [line(a, { variantId: variantOf(b.napa), batchId: '' })]),
      sale(a, 4, [line(a, { taxRateId: b.vat.id })]),
      sale(a, 5, [line(a, { batchId: b.batchId })]),
    ]);
    expect(results.map((result) => (result.status === 'rejected' ? result.error : null))).toEqual([
      { code: 'pos_register_not_held', fieldErrors: { registerId: ['pos_register_not_held'] } },
      { code: 'sales_customer_invalid', fieldErrors: { customerId: ['sales_customer_invalid'] } },
      { code: 'sales_item_invalid', fieldErrors: { 'lines.0.variantId': ['sales_item_invalid'] } },
      { code: 'tax_rate_invalid', fieldErrors: { 'lines.0.taxRateId': ['tax_rate_invalid'] } },
      { code: 'stock_batch_invalid', fieldErrors: { 'lines.0.batchId': ['stock_batch_invalid'] } },
    ]);
    // The refused sales kept their numbers in A's register, never in B's
    expect((await registerOfBNow()).lastNumber).toBe(1);
    const own = posRegisterSchema.parse(
      (await as(a.who, 'GET', `/pos/registers/${a.register.id}`)).json(),
    );
    expect(own.lastNumber).toBe(5);
  });
});
```

- **Two retail shops, built the same way by `open()`,** each with a register its counter PC holds, a Napa batch with 2
  strips, and a customer. B sells 5 strips to its customer before the tests: a sale, a sold-short line and a bell.
- **Every route of a register answers A with 404** for B's id, and B's register is the same afterwards (only its last
  number moved, by B's own sale). The PUT sends a valid form of A's own, so the 404 is about whose register it is.
- **The devices:** A's device cannot take B's register, and A cannot take its own register with B's device id
  (`device_not_found`).
- **A register of A with B's warehouse or B's cash account** is refused with the same codes as an id that does not exist.
- **A's pull has A's register only.**
- **B's sales, B's sold-short lines and B's bell stay B's,** whatever filter A uses.
- **A's sales cannot use B's register, customer, item, VAT rate or batch.** The sale on B's register has number 9 on
  purpose: the refusal keeps its number, and if that leaked, B's last number would jump from 1 to 9. A's own register
  keeps the numbers of A's refused sales (2 to 5).

> **What we checked.** The API's type check and lint; `pos.int.spec.ts` (31 tests) and `pos.tenant-leak.int.spec.ts`
> (6 tests) against a real Postgres and Redis; the four sync suites with `SYNC_PROTOCOL` (91 tests). Broken on purpose:
> with the holder check taken out of `release()`, "is let go only by the device that holds it" fails (and with it most
> of the later tests, since the laptop then frees the front counter's register).

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src
cd apps/api
npx vitest run src/pos src/sync --maxWorkers=3
```

The i18n, sync and app packages still fail as listed at the end of 20a.1, until their parts.

## 20a.5 — `packages/i18n`: the words

The screens of 20a.6 need their words in English and Bangla, so they come first. This part changes only the two locale
files. The ui package needs nothing new: the registers page is a data table with a form dialog like the warehouses
page, the POS screen is built in the app from the input, the select, the combobox, `DiscountInput` and `MoneyInput`
that exist, and the receipt is the app's own print component.

When this part starts, `packages/i18n` does not type-check: the `errors` object misses the 18 POS codes of 20a.1. The
app has more hidden errors of the same kind: the role matrix, the audit log, the journal, the stock card, the Sync page
and the bell look up the words of every permission group, permission, audit action and entity type, journal source,
movement kind, sync command and bell type, and 20a.1 added one or more of each. When this part ends, the i18n package
and the ui package type-check, and the app fails only in three files of its own code (20a.6 and 20a.7):
`notification-bell.tsx` (where the bell's row opens), `sync-parts.tsx` (how the Sync page names a sale) and
`mocks/push-data.ts` (the mock push).

### `locales/en.ts`

```diff
@@ -125,6 +125,12 @@ export const en = {
     supplierRefunds: 'Supplier refunds',
     approvals: 'Approvals',
     sync: 'Sync',
+    // Step 20a: the counter screen, its registers (a workspace setting), its sales (under Sales)
+    // and what it sold without stock (under Inventory)
+    pointOfSale: 'POS',
+    registers: 'POS registers',
+    posSales: 'POS sales',
+    soldShort: 'Sold short',
   },
   auth: {
     workspace: 'Workspace',
@@ -527,6 +533,8 @@ export const en = {
       sales_order: {
         create_draft: 'Draft order for {{name}}',
       },
+      // Step 20a: {{name}} is the sale's number (POS1-000123)
+      pos_sale: { create: 'Sale {{name}}' },
     },
     savedAt: 'Saved {{time}}',
     // fields = the form's own labels, joined in the page's language ("Phone and Credit limit")
@@ -863,6 +871,7 @@ export const en = {
       purchase_return: 'Purchase return',
       purchase_debit_note: 'Debit note',
       purchase_refund: 'Supplier refund',
+      pos_sale: 'POS sale',
     },
     fromDocument: 'From {{document}}',
     stockEntryHint:
@@ -1495,6 +1504,7 @@ export const en = {
       sales_return: 'Came back',
       purchase_receipt: 'Goods receipt',
       purchase_return: 'Sent back',
+      pos_sale: 'Sold at a counter',
     },
     historyEmpty: 'No movement in these dates.',
   },
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, taken from `en`, so a
  key missing in Bangla fails the type check.
- **Four ways in, in four places** (decision 12). `pointOfSale` is the POS screen; its sidebar item opens `/pos`, which
  fills the window. `registers` is a workspace setting, next to branches and devices. `posSales` is under Sales, next to
  invoices, and `soldShort` under Inventory, because the people who adjust stock act on it (decision 30). The words say
  "POS" where the page would be unclear without it: "Registers" alone could be a cash book.
- **`sync.commands.pos_sale.create`** is how the Sync page names a waiting sale: "Sale POS1-000123". The Sync page passes
  every command's name as `name`; for a sale the app passes the number (20a.6), which is what the cashier sees on the
  paper receipt.
- **`journal.sources.pos_sale`** and **`stock.kinds.pos_sale`** are the journal's and the stock card's names for the new
  source and movement kind of 20a.1. The stock card says "Sold at a counter", next to "Delivered", so the two ways goods
  leave to a customer read apart.

```diff
@@ -3924,6 +3934,259 @@ export const en = {
   },
   // The approval of any document that needs one: the "Waiting for me" page, the approval card on the
   // document's page, and its two dialogs
+  // Step 20a: Settings → POS registers. A register is one counter (decision 3)
+  registers: {
+    title: 'POS registers',
+    description: 'The counters that sell: where their goods leave from, and where their money goes',
+    add: 'Add register',
+    newTitle: 'Add a register',
+    editTitle: 'Edit {{code}}',
+    code: 'Code',
+    codeHint:
+      'A capital letter, then up to 7 letters or digits. Every receipt number starts with it: POS1-000123',
+    // Decision 16: the edit form shows the code, but not as a box
+    codeLocked: 'The code is on every receipt this register printed, so it never changes.',
+    name: 'Name',
+    namePlaceholder: 'Front counter',
+    warehouse: 'Warehouse',
+    warehouseHint: 'Its goods leave from here. The register is in this warehouse’s branch.',
+    warehousePlaceholder: 'Pick a warehouse',
+    // Decision 18: one account per method; an empty one = the counter does not take it
+    accountsTitle: 'Where the money goes',
+    accountsHint:
+      'An account for each way this counter takes money. Leave one empty and the counter does not take it.',
+    accounts: { cash: 'Cash', card: 'Card', bkash: 'bKash', nagad: 'Nagad' },
+    accountPlaceholder: 'Pick an account',
+    notTaken: 'Not taken here',
+    cashHint: 'Always needed: change is given in cash.',
+    noMoneyAccounts:
+      'No account holds money yet. Tick "Holds money" on your cash, bank and wallet accounts in the chart of accounts.',
+    maxDiscount: 'Most discount a cashier may give (%)',
+    maxDiscountHint:
+      'On a line or on the whole bill. More than this, or a changed price, needs pos.price.override. Empty means no discount.',
+    paperWidth: 'Receipt paper',
+    paperWidths: { '58': '58 mm', '80': '80 mm' },
+    paperWidthHint: 'The width of the roll in this counter’s receipt printer.',
+    receiptFooter: 'Receipt footer',
+    receiptFooterPlaceholder: 'Goods once sold are exchanged within 7 days with this receipt.',
+    show: 'Show',
+    statuses: { active: 'Active', archived: 'Archived' },
+    columns: {
+      register: 'Register',
+      warehouse: 'Warehouse',
+      holder: 'Held by',
+      lastNumber: 'Last receipt',
+      status: 'Status',
+    },
+    // Who holds it (decision 14): the device's name and its person, or nobody
+    holder: '{{device}} · {{person}}',
+    free: 'Free',
+    noSaleYet: 'No sale yet',
+    archive: 'Archive',
+    restore: 'Restore',
+    created: '{{name}} added',
+    updated: 'Changes to {{name}} saved',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    readOnly: 'Ask a workspace owner for the pos.register.manage permission to change registers.',
+    emptyTitle: 'No registers yet',
+    emptyBody:
+      'Add a register for each counter that sells: a pharmacy’s front counter, a superstore’s checkout.',
+    emptyArchivedTitle: 'No archived registers',
+    emptyArchivedBody: 'A counter you close can be archived once no device holds it.',
+    loadFailed: "Couldn't load the registers. Refresh the page to try again.",
+  },
+  // Step 20a: the POS screen (/pos, decision 12), its payment and its receipt
+  pos: {
+    title: 'POS',
+    exit: 'Leave the POS',
+    // The top bar
+    register: '{{code}} · {{name}}',
+    cashier: 'Cashier: {{name}}',
+    nextNumber: 'Next receipt {{number}}',
+    // Taking a register (decision 14). Online only: the server says which ones are free
+    chooseTitle: 'Which counter is this?',
+    chooseDescription:
+      'This device gives the receipt numbers of the register it takes. Only one device holds a register at a time.',
+    chooseLabel: 'Register',
+    choosePlaceholder: 'Pick a register',
+    choose: 'Use this register',
+    heldBy: '{{code}} · held by {{device}}',
+    claimed: 'This device is {{code}} now. The next receipt is {{number}}.',
+    chooseOffline: 'Taking a register needs a connection. Connect to the internet, then try again.',
+    noRegistersTitle: 'No register in this branch',
+    noRegistersBody:
+      'Someone with pos.register.manage adds one in Settings → POS registers: the counter, its warehouse and its accounts.',
+    changeRegister: 'Change register',
+    // Decision 32: the device lets go only when no sale of the register waits in its outbox
+    changeRegisterWaiting:
+      'Sales of {{code}} wait on this device. Sync them, then change the register.',
+    cantSell:
+      'You can look at the POS, but not sell. Ask a workspace owner for the pos.sale.create permission.',
+    // Searching and scanning. A scanner types the barcode and Enter, like a keyboard
+    search: 'Scan or search',
+    searchPlaceholder: 'Name, SKU or barcode',
+    noMatch: 'No active product matches "{{query}}".',
+    noBarcode: 'No product has the barcode {{code}}.',
+    inStock: '{{quantity}} in stock',
+    outOfStock: 'Out of stock',
+    // The cart
+    cart: 'Cart',
+    cartEmptyTitle: 'Nothing in the cart',
+    cartEmptyBody: 'Scan an item, or search for it.',
+    walkIn: 'Walk-in customer',
+    customer: 'Customer',
+    customerPlaceholder: 'Search by name, code or phone',
+    noCustomerMatch: 'No active customer matches',
+    walkInAgain: 'Back to walk-in',
+    quantity: 'Quantity',
+    price: 'Price',
+    discount: 'Discount',
+    lineAmount: 'Amount',
+    removeLine: 'Remove {{name}}',
+    batch: 'Batch',
+    batchPlaceholder: 'Pick a batch',
+    serials: 'Serial numbers',
+    serialsHint: 'Scan one serial number for each item.',
+    billDiscount: 'Bill discount',
+    itemCount_one: '{{formatted}} item',
+    itemCount_other: '{{formatted}} items',
+    clear: 'Clear the cart',
+    pay: 'Pay {{amount}}',
+    // Decision 7: the device's copy stops a sale the workspace would not allow
+    shortStock: 'Only {{quantity}} here. This workspace does not sell below zero.',
+    noStock: 'None in stock here. This workspace does not sell below zero.',
+    // Decision 11: what needs pos.price.override, said where the cashier types it
+    overLimit: 'More than {{max}}% off needs pos.price.override.',
+    priceLocked: 'Changing the price needs pos.price.override.',
+    priceChanged: 'Changed from {{price}}',
+    // Taking the money (decision 5)
+    payTitle: 'Take payment',
+    payDescription: 'Total {{total}}. Split it over several methods if the customer asks.',
+    methods: { cash: 'Cash', card: 'Card', bkash: 'bKash', nagad: 'Nagad' },
+    method: 'Paid by',
+    amount: 'Amount',
+    reference: 'Reference',
+    referencePlaceholders: {
+      cash: 'Optional',
+      card: 'Card ending 4821',
+      bkash: 'TrxID BK7XQ2M4',
+      nagad: 'TxnID 73K9QW2P',
+    },
+    quickCash: 'Notes the customer gave',
+    exact: 'Exact amount',
+    addPayment: 'Add another method',
+    removePayment: 'Remove payment {{number}}',
+    due: 'Still to pay',
+    paid: 'Paid',
+    change: 'Change',
+    complete: 'Complete sale',
+    completing: 'Saving the sale…',
+    // After the sale. The receipt prints at once; the sale goes through the outbox (decision 21)
+    doneTitle: '{{number}} is done',
+    giveChange: 'Give back {{amount}} in cash',
+    noChange: 'No change to give',
+    savedOnDevice: 'Saved on this device. It syncs when the connection is back.',
+    printAgain: 'Print again',
+    newSale: 'New sale',
+    // Keyboard shortcuts (decision 12)
+    shortcuts: 'Keyboard shortcuts',
+    keys: {
+      search: 'Search or scan',
+      customer: 'Pick a customer',
+      billDiscount: 'Bill discount',
+      pay: 'Pay',
+      complete: 'Complete the sale',
+      newSale: 'New sale',
+      help: 'Show these shortcuts',
+    },
+    // The thermal receipt (decision 6), 58 or 80 mm. The company lines reuse print.*
+    receipt: {
+      title: 'Receipt',
+      number: 'No. {{number}}',
+      register: 'Counter {{code}}',
+      cashier: 'Cashier: {{name}}',
+      customer: 'Customer: {{name}}',
+      item: 'Item',
+      quantity: 'Qty',
+      amount: 'Amount',
+      discount: 'Discount',
+      billDiscount: 'Bill discount',
+      net: 'Before VAT',
+      vat: 'VAT',
+      total: 'Total',
+      pricesWithVat: 'Prices include VAT',
+      paid: 'Paid',
+      change: 'Change',
+      thanks: 'Thank you. Please come again.',
+    },
+  },
+  // Step 20a: the managers' list of POS sales, as the server posted them
+  posSales: {
+    title: 'POS sales',
+    description: 'What the counters sold, as it reached the books',
+    back: 'POS sales',
+    register: 'Register',
+    allRegisters: 'All registers',
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      register: 'Register',
+      customer: 'Customer',
+      cashier: 'Cashier',
+      total: 'Total',
+      status: 'Status',
+    },
+    walkIn: 'Walk-in',
+    posted: 'Posted',
+    soldShort: 'Sold short',
+    soldAt: 'Sold at',
+    device: 'Device',
+    cashier: 'Cashier',
+    customer: 'Customer',
+    lines: 'Items',
+    batches: 'Batch {{lot}} · {{quantity}}',
+    serials: 'Serial numbers: {{serials}}',
+    shortLine: '{{quantity}} sold below zero',
+    payments: 'Payments',
+    paid: 'Paid',
+    change: 'Change',
+    entry: 'Journal entry',
+    print: 'Print receipt',
+    // Decision 26: the day it was sold was closed, so the books hold it on the first open day
+    bookedLater: 'Sold on {{sold}}. That day was closed in the books, so the sale is on {{date}}.',
+    soldShortNotice:
+      'Some items were sold without stock at {{warehouse}}. They stay on the Sold short list until the stock is put right.',
+    notFound: "This POS sale doesn't exist.",
+    needsConnection: 'POS sales are read from the server. Connect to the internet to see them.',
+    emptyTitle: 'No POS sales yet',
+    emptyBody: 'Sales made at a counter show here once their device syncs.',
+    loadFailed: "Couldn't load the POS sales. Refresh the page to try again.",
+  },
+  // Step 20a: what the counters sold that the warehouse did not have (decision 30)
+  soldShort: {
+    title: 'Sold short',
+    description:
+      'POS sales that took more than the warehouse had. Count the shelf, then post an adjustment or receive the goods.',
+    warehouse: 'Warehouse',
+    allWarehouses: 'All warehouses',
+    columns: {
+      item: 'Item',
+      sale: 'Sale',
+      short: 'Sold short',
+      batch: 'Batch',
+      onHand: 'In stock now',
+      status: 'Status',
+    },
+    // warn while the stock is below zero, good once it is back at zero or above
+    statuses: { open: 'Below zero', fixed: 'Put right' },
+    noBatch: 'No batch',
+    serials: 'Left without a serial number: {{serials}}',
+    needsConnection: 'This list is read from the server. Connect to the internet to see it.',
+    emptyTitle: 'Nothing sold short',
+    emptyBody: 'When a counter sells more than its warehouse has, the item shows here.',
+    loadFailed: "Couldn't load the list. Refresh the page to try again.",
+  },
   approvals: {
     title: 'Approvals',
     description: 'Documents waiting for your decision, oldest first',
```

Four new sections, before `approvals`, one per page, like the rest of the file.

**`registers`, the settings page:**

- **The code's hint shows a whole receipt number** (`POS1-000123`), because that is why the code matters: a person
  picking "FRONT-COUNTER" sees at once that it would be on every receipt. `codeLocked` is what the edit form shows in
  place of the box (decision 16), with the reason, so nobody asks for a way to change it.
- **The warehouse's hint says the branch comes with it** (decision 17). There is no branch field, and a person looking
  for one finds the answer under the warehouse.
- **"Where the money goes" is one group of four selects** (decision 18). `notTaken` is the empty choice of card, bKash
  and Nagad, and says what an empty one means; cash has none, and `cashHint` says why. `noMoneyAccounts` repeats the
  money receipt's sentence, with wallets added, for a workspace that has not ticked "Holds money" yet.
- **`maxDiscountHint` names the permission and what it allows** (decision 11), and that an empty box means no discount
  (the schema turns it into `0`).
- **`paperWidths` keys are `'58'` and `'80'`,** the values of `POS_PAPER_WIDTHS`, so the page writes
  `` t(`registers.paperWidths.${width}`) `` with no map of its own.
- **`holder`, `free` and `noSaleYet`** fill the "Held by" and "Last receipt" columns. Who holds a register is the first
  thing a manager needs when a cashier says "POS1 is taken" (decision 14). `emptyArchivedBody` says when a counter can
  be archived: when no device holds it (decision 33).

**`pos`, the screen:**

- **Taking a register** (decision 14) is a dialog, like the device's branch dialog of 18a: `chooseTitle` asks the
  question the cashier can answer ("which counter is this?"), and `chooseDescription` says why only one device may hold
  it. `heldBy` is the select's text for a register another device holds, so the cashier sees which PC to sign out on.
  `claimed` is the toast, with the next receipt number, so a cashier who expected 164 and sees 001 stops at once.
  `chooseOffline` is the dialog's state without a connection: the claim is an API call.
- **`changeRegisterWaiting`** is decision 32: the device lets go only when no sale of the register waits.
- **`cantSell`** is the screen for someone without `pos.sale.create`: they can look, like every page without its
  permission.
- **The search names what it finds** (`Name, SKU or barcode`). A USB scanner types the barcode and Enter like a
  keyboard; `noBarcode` is what Enter says when no product has it, with the code, so the cashier sees a misread.
- **`shortStock` and `noStock`** are decision 7 at sale time: they say the quantity there is, and why the screen stops
  (the workspace's setting), not just "not allowed".
- **`overLimit`, `priceLocked` and `priceChanged`** are decision 11, said under the box the cashier typed in.
  `priceChanged` shows the price the line started with, the `startingPrice` the server compares with.
- **The payment dialog:** `methods` are the POS's own four (decision 18), not the money receipt's. Each method has a
  reference example in the form the slip prints it (a bKash TrxID, the card's last four digits); cash needs none.
  `quickCash` labels the buttons of common notes (৳500, ৳1,000), and `exact` fills what is still to pay. `due` and
  `change` are the two numbers the cashier reads while the customer counts.
- **After the sale:** `giveChange` is the biggest line on the screen, because it is what the cashier does next.
  `savedOnDevice` shows only offline: online the outbox sends it at once (decision 21).
- **`itemCount_one` and `itemCount_other`** take `formatted`, the count in the page's language, like the Sync page's
  counts.
- **`keys` are the words of the shortcuts dialog;** the keys themselves (F2, F12) are not words, so they are not here.
- **`receipt` is the thermal receipt** (decision 6). Short words, because 58 mm paper holds about 32 characters a line:
  "Qty", "No.". The company's lines reuse `print.bin` and `print.phone`. `thanks` prints when the register has no footer
  of its own.

**`posSales` and `soldShort`, the managers' lists:**

- **`bookedLater`** is decision 26 on the sale's page: the day it was sold was closed, so the books hold it later. It
  names both days, because the paper receipt shows the first and the ledger the second.
- **`soldShortNotice`** is the sale's own notice; the list's `statuses` are its two pills: `open` (`warn`, below zero)
  and `fixed` (`good`, back at zero or above). The list needs no "solved" state of its own (decision 30): the pill comes
  from the stock there now.
- **`needsConnection`** in both: the two lists are read from the server, like the orders list offline.

```diff
@@ -4351,6 +4614,7 @@ export const en = {
       inventory: 'Inventory',
       sales: 'Sales',
       purchase: 'Purchase',
+      pos: 'POS',
     },
     members_one: '{{count}} person',
     members_other: '{{count}} people',
@@ -4456,6 +4720,14 @@ export const en = {
       debit_note: { manage: 'Write and post debit notes, and apply them to bills' },
       refund: { manage: 'Record money suppliers pay back, and void supplier refunds' },
     },
+    // Step 20a (decisions 11, 31)
+    pos: {
+      sale: { create: 'Sell at a POS counter: take a register, ring up sales and take the money' },
+      price: {
+        override: 'At the POS, change a price or give more discount than the register allows',
+      },
+      register: { manage: 'Add, edit and archive POS registers' },
+    },
   },
   invite: {
     checking: 'Checking your invitation…',
@@ -4525,6 +4797,8 @@ export const en = {
       debit_note: 'Debit notes',
       supplier_refund: 'Supplier refunds',
       device: 'Devices',
+      pos_register: 'POS registers',
+      pos_sale: 'POS sales',
     },
     columns: {
       when: 'When',
@@ -4801,6 +5075,21 @@ export const en = {
         rejected: 'Rejected: sent back to draft',
         reopened: 'Reopened: back to draft',
       },
+      // Step 20a. claimed and released are a device taking a register and letting it go
+      // (decision 14); a release by a revoke or a move writes no row (decision 51)
+      pos_register: {
+        created: 'Added a POS register',
+        updated: 'Edited a POS register',
+        archived: 'Archived a POS register',
+        restored: 'Restored a POS register',
+        claimed: 'Took a register on a device',
+        released: 'Let go of a register on a device',
+      },
+      pos_sale: {
+        created: 'Sold at a POS counter',
+        overridden: 'Changed a price or gave more discount at the POS',
+        without_permission: 'Sold at a POS counter after losing the permission',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -4931,6 +5220,22 @@ export const en = {
       priceDifference: 'Purchase price difference',
       services: 'Purchased services',
       revokedAt: 'Revoked at',
+      // Step 20a: a register's form, and a POS sale's two rows
+      cashAccount: 'Cash account',
+      cardAccount: 'Card account',
+      bkashAccount: 'bKash account',
+      nagadAccount: 'Nagad account',
+      maxDiscountPercent: 'Most discount (%)',
+      paperWidth: 'Receipt paper',
+      receiptFooter: 'Receipt footer',
+      device: 'Device',
+      register: 'Register',
+      soldOn: 'Date on the device',
+      paid: 'Paid',
+      soldShort: 'Lines sold short',
+      overrides: 'Needs pos.price.override',
+      allowed: 'Permission',
+      missing: 'Missing permission',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
```

- **`roles.groups.pos` and `permissions.pos`** are the role matrix's new group and its three lines (decision 31). Each
  line says what it allows in the words of the counter, so an owner knows what they give a cashier.
- **`audit.entityTypes`** are the audit log's two new filters. **`audit.actions`** say `claimed` and `released` as what
  happened to the register on a device: the row's "Who" is the cashier, and its "from" line names the device.
- **`audit.fields`** label what 20a.3 writes: a register's form (the accounts by code, the discount limit, the paper,
  the footer), the device on a claim or a release, and a sale's two rows. On `pos_sale.overridden`, `overrides` reads
  "Needs pos.price.override: price on line 2", and `allowed` shows "Allowed" or "Not allowed" (the log's words for
  `true` and `false`): whether the cashier had the permission (decision 11). On `pos_sale.without_permission`,
  `missing` reads "Missing permission: pos.sale.create" (decision 28).

```diff
@@ -5024,6 +5329,12 @@ export const en = {
         approved: '{{document}} {{number}} is approved.',
         rejected: '{{document}} {{number}} was sent back to draft. Open it to see why.',
       },
+      // Step 20a (decision 30). {{count}} is the number of items, so no plural keys: the sentence
+      // reads right for 1 and for many
+      pos: {
+        sold_short:
+          '{{number}} sold more than {{warehouse}} had. Items below zero: {{count}}. Count them and put the stock right.',
+      },
     },
   },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
@@ -5611,6 +5922,35 @@ export const en = {
     // params.count = the active devices in the branch (decision 20)
     branch_has_devices:
       'Active devices in this branch: {{count}}. Change their branch on each device, or revoke them, first.',
+    // Step 20a: POS registers and sales
+    pos_register_code_format:
+      'Use a capital letter, then 1 to 7 capital letters or digits, like POS1.',
+    pos_register_code_taken: 'Another register uses this code. Pick another one, like POS2.',
+    pos_register_name_required: 'Give the register a name, like Front counter.',
+    pos_register_warehouse_invalid: 'Pick an active warehouse for the register’s goods.',
+    pos_register_cash_required:
+      'Pick the cash account. Every register takes cash, because change is given in cash.',
+    pos_register_account_invalid:
+      'Pick an active account that holds money. Tick "Holds money" on it in the chart of accounts.',
+    pos_discount_limit_format: 'Type a percent from 0 to 100, with up to 2 decimals.',
+    pos_register_in_use:
+      'Another device holds this register. Sign out on that device first, or revoke it if it is lost.',
+    pos_register_archived: 'This register is archived. Restore it, or pick another one.',
+    pos_register_branch:
+      'A register and the device that holds it are in the same branch. Pick a register, or a warehouse, of that branch.',
+    pos_device_has_register:
+      'This device holds another register. Let go of it first with "Change register" on the POS screen.',
+    pos_register_not_held:
+      'This device no longer holds this register. Open the POS and take a register again.',
+    pos_payments_required: 'Add how the customer paid.',
+    pos_payment_amount_required: 'Type an amount above zero, or remove this payment.',
+    pos_payment_short: 'The payments are less than the total. Add what is still to pay.',
+    pos_change_not_cash:
+      'Change is given only from cash. Lower the card or wallet amount to what is still to pay.',
+    pos_method_not_set:
+      'The register has no account for this payment method now. Someone with pos.register.manage sets one in Settings → POS registers, then retry the sale.',
+    pos_number_taken:
+      'Another sale of this register has this number. This should not happen: keep the paper receipt and tell your Omnivo administrator.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **The bell** (`pos.sold_short`) names the sale and the warehouse, and says what to do. `count` is the number of items,
  so it is written "Items below zero: 2", like `branch_has_devices` of 18c, and reads right for 1 and for many.
- **The 18 errors say how to fix the problem** (CLAUDE.md → Copy), each with an example where one helps (POS1, POS2,
  Front counter). Three of them are worth a word:
  - **`pos_register_branch`** answers two things: a claim from a device in another branch, and a held register's
    warehouse moved to another branch (20a.3). One sentence states the rule both break.
  - **`pos_method_not_set`** shows on the Sync page under a refused sale (decision 34). The cashier cannot fix it, so it
    says who can, where, and that the sale is then retried.
  - **`pos_number_taken`** should never happen (decision 34). It says to keep the paper receipt: that is the proof of
    the money taken while someone looks for the bug.

### `locales/bn.ts`

```diff
@@ -116,6 +116,10 @@ export const bn: Messages = {
     supplierRefunds: 'সাপ্লায়ার রিফান্ড',
     approvals: 'অনুমোদন',
     sync: 'সিঙ্ক',
+    pointOfSale: 'POS',
+    registers: 'POS রেজিস্টার',
+    posSales: 'POS বিক্রি',
+    soldShort: 'স্টকের বেশি বিক্রি',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -490,6 +494,7 @@ export const bn: Messages = {
       sales_order: {
         create_draft: '{{name}}-এর খসড়া অর্ডার',
       },
+      pos_sale: { create: 'বিক্রি {{name}}' },
     },
     savedAt: 'সেভ হয়েছে {{time}}',
     changedFields: 'বদলেছে: {{fields}}',
@@ -788,6 +793,7 @@ export const bn: Messages = {
       purchase_return: 'পারচেজ রিটার্ন',
       purchase_debit_note: 'ডেবিট নোট',
       purchase_refund: 'সাপ্লায়ার রিফান্ড',
+      pos_sale: 'POS বিক্রি',
     },
     fromDocument: '{{document}} থেকে',
     stockEntryHint:
@@ -1417,6 +1423,7 @@ export const bn: Messages = {
       sales_return: 'ফেরত এসেছে',
       purchase_receipt: 'মাল গ্রহণ',
       purchase_return: 'ফেরত পাঠানো',
+      pos_sale: 'কাউন্টারে বিক্রি',
     },
     historyEmpty: 'এই তারিখগুলোর মধ্যে কোনো মুভমেন্ট নেই।',
   },
@@ -3733,6 +3740,240 @@ export const bn: Messages = {
       'সাপ্লায়ার যে টাকা ফেরত দেন তা লিখুন: ডেবিট নোটের বাকি টাকা, বা যে অর্ডার তাঁরা দিতে পারেননি তার অগ্রিম।',
     loadFailed: 'সাপ্লায়ার রিফান্ডগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  registers: {
+    title: 'POS রেজিস্টার',
+    description: 'যে কাউন্টারগুলো বিক্রি করে: তাদের মাল কোথা থেকে যায়, আর টাকা কোথায় জমা হয়',
+    add: 'রেজিস্টার যোগ করুন',
+    newTitle: 'নতুন রেজিস্টার',
+    editTitle: '{{code}} বদলান',
+    code: 'কোড',
+    codeHint:
+      'একটা বড় হাতের অক্ষর, তারপর বড়জোর ৭টা অক্ষর বা অঙ্ক। প্রতিটা রিসিট নম্বর এটা দিয়ে শুরু হয়: POS1-000123',
+    codeLocked: 'এই রেজিস্টারের ছাপা প্রতিটা রিসিটে কোডটা আছে, তাই এটা কখনো বদলায় না।',
+    name: 'নাম',
+    namePlaceholder: 'Front counter',
+    warehouse: 'গুদাম',
+    warehouseHint: 'এর মাল এখান থেকে যায়। রেজিস্টারটা এই গুদামের ব্রাঞ্চে থাকে।',
+    warehousePlaceholder: 'একটা গুদাম বাছুন',
+    accountsTitle: 'টাকা কোথায় জমা হয়',
+    accountsHint:
+      'এই কাউন্টার যেভাবে টাকা নেয়, তার প্রতিটার জন্য একটা অ্যাকাউন্ট। কোনোটা খালি রাখলে কাউন্টার সেভাবে টাকা নেয় না।',
+    accounts: { cash: 'নগদ', card: 'কার্ড', bkash: 'bKash', nagad: 'Nagad' },
+    accountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+    notTaken: 'এখানে নেওয়া হয় না',
+    cashHint: 'সবসময় লাগে: ভাংতি ফেরত দেওয়া হয় নগদে।',
+    noMoneyAccounts:
+      'এখনো কোনো অ্যাকাউন্টে টাকা রাখা হয় না। চার্ট অফ অ্যাকাউন্টসে নগদ, ব্যাংক আর ওয়ালেটের অ্যাকাউন্টে "টাকা রাখা হয়" টিক দিন।',
+    maxDiscount: 'ক্যাশিয়ার সর্বোচ্চ কত ছাড় দিতে পারেন (%)',
+    maxDiscountHint:
+      'একটা লাইনে বা পুরো বিলে। এর বেশি, বা দাম বদলাতে, pos.price.override লাগে। খালি মানে কোনো ছাড় নেই।',
+    paperWidth: 'রিসিটের কাগজ',
+    paperWidths: { '58': '৫৮ মিমি', '80': '৮০ মিমি' },
+    paperWidthHint: 'এই কাউন্টারের রিসিট প্রিন্টারের রোল কত চওড়া।',
+    receiptFooter: 'রিসিটের নিচের লেখা',
+    receiptFooterPlaceholder: 'বিক্রি করা মাল এই রিসিট দেখিয়ে ৭ দিনের মধ্যে বদলানো যায়।',
+    show: 'দেখান',
+    statuses: { active: 'চালু', archived: 'আর্কাইভ' },
+    columns: {
+      register: 'রেজিস্টার',
+      warehouse: 'গুদাম',
+      holder: 'কে ধরে আছে',
+      lastNumber: 'শেষ রিসিট',
+      status: 'অবস্থা',
+    },
+    holder: '{{device}} · {{person}}',
+    free: 'খালি',
+    noSaleYet: 'এখনো বিক্রি নেই',
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}}-এর পরিবর্তন সেভ হয়েছে',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
+    readOnly: 'রেজিস্টার বদলাতে একজন workspace owner-এর কাছে pos.register.manage permission চান।',
+    emptyTitle: 'এখনো কোনো রেজিস্টার নেই',
+    emptyBody:
+      'যে কাউন্টার বিক্রি করে, তার প্রতিটার জন্য একটা রেজিস্টার যোগ করুন: ফার্মেসির সামনের কাউন্টার, সুপারশপের চেকআউট।',
+    emptyArchivedTitle: 'কোনো আর্কাইভ করা রেজিস্টার নেই',
+    emptyArchivedBody: 'বন্ধ করা কাউন্টার কোনো ডিভাইস না ধরে থাকলে আর্কাইভ করা যায়।',
+    loadFailed: 'রেজিস্টারের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  pos: {
+    title: 'POS',
+    exit: 'POS থেকে বের হন',
+    register: '{{code}} · {{name}}',
+    cashier: 'ক্যাশিয়ার: {{name}}',
+    nextNumber: 'পরের রিসিট {{number}}',
+    chooseTitle: 'এটা কোন কাউন্টার?',
+    chooseDescription:
+      'এই ডিভাইস যে রেজিস্টার নেয়, তার রিসিট নম্বর দেয়। একটা রেজিস্টার একবারে একটাই ডিভাইস ধরে রাখে।',
+    chooseLabel: 'রেজিস্টার',
+    choosePlaceholder: 'একটা রেজিস্টার বাছুন',
+    choose: 'এই রেজিস্টার নিন',
+    heldBy: '{{code}} · ধরে আছে {{device}}',
+    claimed: 'এই ডিভাইস এখন {{code}}। পরের রিসিট {{number}}।',
+    chooseOffline: 'রেজিস্টার নিতে কানেকশন লাগে। ইন্টারনেটে যুক্ত হয়ে আবার চেষ্টা করুন।',
+    noRegistersTitle: 'এই ব্রাঞ্চে কোনো রেজিস্টার নেই',
+    noRegistersBody:
+      'pos.register.manage আছে এমন কেউ সেটিংস → POS রেজিস্টারে একটা যোগ করবেন: কাউন্টার, তার গুদাম আর অ্যাকাউন্ট।',
+    changeRegister: 'রেজিস্টার বদলান',
+    changeRegisterWaiting:
+      '{{code}}-এর বিক্রি এই ডিভাইসে অপেক্ষায় আছে। আগে সেগুলো সিঙ্ক করুন, তারপর রেজিস্টার বদলান।',
+    cantSell:
+      'আপনি POS দেখতে পারেন, কিন্তু বিক্রি করতে পারেন না। একজন workspace owner-এর কাছে pos.sale.create permission চান।',
+    search: 'স্ক্যান বা খুঁজুন',
+    searchPlaceholder: 'নাম, SKU বা বারকোড',
+    noMatch: '"{{query}}"-এর সাথে কোনো চালু প্রোডাক্ট মেলে না।',
+    noBarcode: '{{code}} বারকোডের কোনো প্রোডাক্ট নেই।',
+    inStock: 'স্টকে {{quantity}}',
+    outOfStock: 'স্টক নেই',
+    cart: 'কার্ট',
+    cartEmptyTitle: 'কার্টে কিছু নেই',
+    cartEmptyBody: 'একটা আইটেম স্ক্যান করুন, বা খুঁজে নিন।',
+    walkIn: 'ওয়াক-ইন গ্রাহক',
+    customer: 'গ্রাহক',
+    customerPlaceholder: 'নাম, কোড বা ফোন দিয়ে খুঁজুন',
+    noCustomerMatch: 'কোনো চালু গ্রাহক মেলে না',
+    walkInAgain: 'ওয়াক-ইনে ফিরুন',
+    quantity: 'পরিমাণ',
+    price: 'দাম',
+    discount: 'ছাড়',
+    lineAmount: 'টাকা',
+    removeLine: '{{name}} সরান',
+    batch: 'ব্যাচ',
+    batchPlaceholder: 'একটা ব্যাচ বাছুন',
+    serials: 'সিরিয়াল নম্বর',
+    serialsHint: 'প্রতিটা আইটেমের একটা করে সিরিয়াল নম্বর স্ক্যান করুন।',
+    billDiscount: 'বিলে ছাড়',
+    itemCount_one: '{{formatted}}টা আইটেম',
+    itemCount_other: '{{formatted}}টা আইটেম',
+    clear: 'কার্ট খালি করুন',
+    pay: '{{amount}} নিন',
+    shortStock: 'এখানে আছে মাত্র {{quantity}}। এই workspace শূন্যের নিচে বিক্রি করে না।',
+    noStock: 'এখানে স্টক নেই। এই workspace শূন্যের নিচে বিক্রি করে না।',
+    overLimit: '{{max}}%-এর বেশি ছাড়ে pos.price.override লাগে।',
+    priceLocked: 'দাম বদলাতে pos.price.override লাগে।',
+    priceChanged: '{{price}} থেকে বদলানো',
+    payTitle: 'টাকা নিন',
+    payDescription: 'মোট {{total}}। গ্রাহক চাইলে কয়েকভাবে ভাগ করে নিন।',
+    methods: { cash: 'নগদ', card: 'কার্ড', bkash: 'bKash', nagad: 'Nagad' },
+    method: 'যেভাবে দিয়েছেন',
+    amount: 'টাকা',
+    reference: 'রেফারেন্স',
+    referencePlaceholders: {
+      cash: 'ঐচ্ছিক',
+      card: 'Card ending 4821',
+      bkash: 'TrxID BK7XQ2M4',
+      nagad: 'TxnID 73K9QW2P',
+    },
+    quickCash: 'গ্রাহক যে নোট দিলেন',
+    exact: 'ঠিক যত টাকা',
+    addPayment: 'আরেকভাবে টাকা যোগ করুন',
+    removePayment: '{{number}} নম্বর পেমেন্ট সরান',
+    due: 'বাকি',
+    paid: 'দেওয়া হয়েছে',
+    change: 'ভাংতি',
+    complete: 'বিক্রি শেষ করুন',
+    completing: 'বিক্রি সেভ হচ্ছে…',
+    doneTitle: '{{number}} শেষ',
+    giveChange: 'নগদে {{amount}} ফেরত দিন',
+    noChange: 'কোনো ভাংতি ফেরত নেই',
+    savedOnDevice: 'এই ডিভাইসে সেভ হয়েছে। কানেকশন ফিরলে সিঙ্ক হবে।',
+    printAgain: 'আবার প্রিন্ট করুন',
+    newSale: 'নতুন বিক্রি',
+    shortcuts: 'কিবোর্ড শর্টকাট',
+    keys: {
+      search: 'খুঁজুন বা স্ক্যান করুন',
+      customer: 'গ্রাহক বাছুন',
+      billDiscount: 'বিলে ছাড়',
+      pay: 'টাকা নিন',
+      complete: 'বিক্রি শেষ করুন',
+      newSale: 'নতুন বিক্রি',
+      help: 'এই শর্টকাটগুলো দেখান',
+    },
+    receipt: {
+      title: 'রিসিট',
+      number: 'নং {{number}}',
+      register: 'কাউন্টার {{code}}',
+      cashier: 'ক্যাশিয়ার: {{name}}',
+      customer: 'গ্রাহক: {{name}}',
+      item: 'আইটেম',
+      quantity: 'পরিমাণ',
+      amount: 'টাকা',
+      discount: 'ছাড়',
+      billDiscount: 'বিলে ছাড়',
+      net: 'VAT-এর আগে',
+      vat: 'VAT',
+      total: 'মোট',
+      pricesWithVat: 'দামে VAT ধরা আছে',
+      paid: 'দেওয়া হয়েছে',
+      change: 'ভাংতি',
+      thanks: 'ধন্যবাদ। আবার আসবেন।',
+    },
+  },
+  posSales: {
+    title: 'POS বিক্রি',
+    description: 'কাউন্টারগুলো যা বিক্রি করেছে, হিসাবের খাতায় যেভাবে উঠেছে',
+    back: 'POS বিক্রি',
+    register: 'রেজিস্টার',
+    allRegisters: 'সব রেজিস্টার',
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      register: 'রেজিস্টার',
+      customer: 'গ্রাহক',
+      cashier: 'ক্যাশিয়ার',
+      total: 'মোট',
+      status: 'অবস্থা',
+    },
+    walkIn: 'ওয়াক-ইন',
+    posted: 'পোস্ট করা',
+    soldShort: 'স্টকের বেশি বিক্রি',
+    soldAt: 'বিক্রির সময়',
+    device: 'ডিভাইস',
+    cashier: 'ক্যাশিয়ার',
+    customer: 'গ্রাহক',
+    lines: 'আইটেম',
+    batches: 'ব্যাচ {{lot}} · {{quantity}}',
+    serials: 'সিরিয়াল নম্বর: {{serials}}',
+    shortLine: '{{quantity}} শূন্যের নিচে বিক্রি হয়েছে',
+    payments: 'পেমেন্ট',
+    paid: 'দেওয়া হয়েছে',
+    change: 'ভাংতি',
+    entry: 'জার্নাল এন্ট্রি',
+    print: 'রিসিট প্রিন্ট করুন',
+    bookedLater:
+      '{{sold}} তারিখে বিক্রি। সেই দিন হিসাবের খাতায় বন্ধ ছিল, তাই বিক্রিটা {{date}} তারিখে উঠেছে।',
+    soldShortNotice:
+      '{{warehouse}}-এ স্টক ছাড়াই কিছু আইটেম বিক্রি হয়েছে। স্টক ঠিক না হওয়া পর্যন্ত সেগুলো "স্টকের বেশি বিক্রি" তালিকায় থাকবে।',
+    notFound: 'এই POS বিক্রি নেই।',
+    needsConnection: 'POS বিক্রি সার্ভার থেকে পড়া হয়। দেখতে ইন্টারনেটে যুক্ত হন।',
+    emptyTitle: 'এখনো কোনো POS বিক্রি নেই',
+    emptyBody: 'কাউন্টারের বিক্রি তার ডিভাইস সিঙ্ক হলে এখানে দেখা যায়।',
+    loadFailed: 'POS বিক্রির তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  soldShort: {
+    title: 'স্টকের বেশি বিক্রি',
+    description:
+      'যে POS বিক্রিতে গুদামে যা ছিল তার বেশি গেছে। তাক গুনে দেখুন, তারপর একটা অ্যাডজাস্টমেন্ট পোস্ট করুন বা মাল রিসিভ করুন।',
+    warehouse: 'গুদাম',
+    allWarehouses: 'সব গুদাম',
+    columns: {
+      item: 'আইটেম',
+      sale: 'বিক্রি',
+      short: 'স্টকের বেশি',
+      batch: 'ব্যাচ',
+      onHand: 'এখন স্টকে',
+      status: 'অবস্থা',
+    },
+    statuses: { open: 'শূন্যের নিচে', fixed: 'ঠিক করা হয়েছে' },
+    noBatch: 'ব্যাচ নেই',
+    serials: 'সিরিয়াল নম্বর ছাড়া গেছে: {{serials}}',
+    needsConnection: 'এই তালিকা সার্ভার থেকে পড়া হয়। দেখতে ইন্টারনেটে যুক্ত হন।',
+    emptyTitle: 'স্টকের বেশি কিছু বিক্রি হয়নি',
+    emptyBody: 'কোনো কাউন্টার তার গুদামের স্টকের বেশি বিক্রি করলে আইটেমটা এখানে দেখা যায়।',
+    loadFailed: 'তালিকাটা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   approvals: {
     title: 'অনুমোদন',
     description: 'যে ডকুমেন্টগুলো আপনার সিদ্ধান্তের অপেক্ষায়, সবচেয়ে পুরনোটা আগে',
@@ -4141,6 +4382,7 @@ export const bn: Messages = {
       inventory: 'ইনভেন্টরি',
       sales: 'বিক্রি',
       purchase: 'কেনাকাটা',
+      pos: 'POS',
     },
     members_one: '{{count}} জন',
     members_other: '{{count}} জন',
@@ -4240,6 +4482,11 @@ export const bn: Messages = {
       debit_note: { manage: 'ডেবিট নোট লেখা, পোস্ট করা আর বিলে ধরা' },
       refund: { manage: 'সাপ্লায়ারের ফেরত দেওয়া টাকা লেখা, আর সাপ্লায়ার রিফান্ড ভয়েড করা' },
     },
+    pos: {
+      sale: { create: 'POS কাউন্টারে বিক্রি: রেজিস্টার নেওয়া, বিক্রি লেখা আর টাকা নেওয়া' },
+      price: { override: 'POS-এ দাম বদলানো, বা রেজিস্টারের সীমার বেশি ছাড় দেওয়া' },
+      register: { manage: 'POS রেজিস্টার যোগ, বদল আর আর্কাইভ' },
+    },
   },
   invite: {
     checking: 'আপনার আমন্ত্রণ দেখা হচ্ছে…',
@@ -4309,6 +4556,8 @@ export const bn: Messages = {
       debit_note: 'ডেবিট নোট',
       supplier_refund: 'সাপ্লায়ার রিফান্ড',
       device: 'ডিভাইস',
+      pos_register: 'POS রেজিস্টার',
+      pos_sale: 'POS বিক্রি',
     },
     columns: {
       when: 'কখন',
@@ -4582,6 +4831,19 @@ export const bn: Messages = {
         rejected: 'খসড়ায় ফেরত পাঠিয়েছেন',
         reopened: 'আবার খুলে খসড়ায় ফিরিয়েছেন',
       },
+      pos_register: {
+        created: 'একটা POS রেজিস্টার যোগ করেছেন',
+        updated: 'একটা POS রেজিস্টার বদলেছেন',
+        archived: 'একটা POS রেজিস্টার আর্কাইভ করেছেন',
+        restored: 'একটা POS রেজিস্টার ফিরিয়ে এনেছেন',
+        claimed: 'একটা ডিভাইসে রেজিস্টার নিয়েছেন',
+        released: 'একটা ডিভাইস থেকে রেজিস্টার ছেড়ে দিয়েছেন',
+      },
+      pos_sale: {
+        created: 'POS কাউন্টারে বিক্রি করেছেন',
+        overridden: 'POS-এ দাম বদলেছেন বা বেশি ছাড় দিয়েছেন',
+        without_permission: 'অনুমতি চলে যাওয়ার পরে POS কাউন্টারে বিক্রি করেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -4711,6 +4973,21 @@ export const bn: Messages = {
       priceDifference: 'ক্রয়মূল্যের পার্থক্য',
       services: 'কেনা সার্ভিস',
       revokedAt: 'রিভোকের সময়',
+      cashAccount: 'নগদের অ্যাকাউন্ট',
+      cardAccount: 'কার্ডের অ্যাকাউন্ট',
+      bkashAccount: 'bKash-এর অ্যাকাউন্ট',
+      nagadAccount: 'Nagad-এর অ্যাকাউন্ট',
+      maxDiscountPercent: 'সর্বোচ্চ ছাড় (%)',
+      paperWidth: 'রিসিটের কাগজ',
+      receiptFooter: 'রিসিটের নিচের লেখা',
+      device: 'ডিভাইস',
+      register: 'রেজিস্টার',
+      soldOn: 'ডিভাইসের তারিখ',
+      paid: 'দেওয়া হয়েছে',
+      soldShort: 'স্টকের বেশি বিক্রির লাইন',
+      overrides: 'pos.price.override লাগে',
+      allowed: 'অনুমতি',
+      missing: 'যে অনুমতি ছিল না',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -4798,6 +5075,10 @@ export const bn: Messages = {
         approved: '{{document}} {{number}} অনুমোদিত হয়েছে।',
         rejected: '{{document}} {{number}} খসড়ায় ফেরত এসেছে। কেন, খুলে দেখুন।',
       },
+      pos: {
+        sold_short:
+          '{{number}}-এ {{warehouse}}-এর স্টকের চেয়ে বেশি বিক্রি হয়েছে। শূন্যের নিচে নামা আইটেম: {{count}}। গুনে স্টক ঠিক করুন।',
+      },
     },
   },
   errors: {
@@ -5366,6 +5647,34 @@ export const bn: Messages = {
     sync_customer_gone: 'এই গ্রাহক মুছে ফেলা হয়েছে, বা আর গ্রাহক নেই। পরিবর্তনটা বাদ দিন।',
     branch_has_devices:
       'এই ব্রাঞ্চে চালু ডিভাইস: {{count}}টা। আগে প্রতিটা ডিভাইস থেকে তার ব্রাঞ্চ বদলান, বা সেগুলো রিভোক করুন।',
+    pos_register_code_format:
+      'প্রথমে একটা বড় হাতের অক্ষর, তারপর ১ থেকে ৭টা বড় হাতের অক্ষর বা অঙ্ক দিন, যেমন POS1।',
+    pos_register_code_taken: 'এই কোড আরেকটা রেজিস্টারের। অন্য কোড দিন, যেমন POS2।',
+    pos_register_name_required: 'রেজিস্টারের একটা নাম দিন, যেমন Front counter।',
+    pos_register_warehouse_invalid: 'রেজিস্টারের মালের জন্য একটা চালু গুদাম বাছুন।',
+    pos_register_cash_required:
+      'নগদের অ্যাকাউন্ট বাছুন। প্রতিটা রেজিস্টার নগদ নেয়, কারণ ভাংতি ফেরত দেওয়া হয় নগদে।',
+    pos_register_account_invalid:
+      'টাকা রাখা হয় এমন একটা চালু অ্যাকাউন্ট বাছুন। চার্ট অফ অ্যাকাউন্টসে সেটায় "টাকা রাখা হয়" টিক দিন।',
+    pos_discount_limit_format: '০ থেকে ১০০-র মধ্যে একটা শতাংশ দিন, দশমিকের পরে বড়জোর ২ ঘর।',
+    pos_register_in_use:
+      'আরেকটা ডিভাইস এই রেজিস্টার ধরে আছে। আগে সেই ডিভাইসে সাইন আউট করুন, হারিয়ে গেলে সেটা রিভোক করুন।',
+    pos_register_archived: 'এই রেজিস্টার আর্কাইভ করা। এটা ফিরিয়ে আনুন, বা অন্য একটা বাছুন।',
+    pos_register_branch:
+      'রেজিস্টার আর যে ডিভাইস সেটা ধরে আছে, দুটো একই ব্রাঞ্চে থাকে। সেই ব্রাঞ্চের একটা রেজিস্টার, বা গুদাম, বাছুন।',
+    pos_device_has_register:
+      'এই ডিভাইস আরেকটা রেজিস্টার ধরে আছে। আগে POS স্ক্রিনের "রেজিস্টার বদলান" দিয়ে সেটা ছাড়ুন।',
+    pos_register_not_held:
+      'এই ডিভাইস এখন আর এই রেজিস্টার ধরে নেই। POS খুলে আবার একটা রেজিস্টার নিন।',
+    pos_payments_required: 'গ্রাহক কীভাবে টাকা দিলেন, সেটা যোগ করুন।',
+    pos_payment_amount_required: 'শূন্যের বেশি একটা অঙ্ক দিন, বা এই পেমেন্ট সরান।',
+    pos_payment_short: 'পেমেন্ট মোটের চেয়ে কম। যা বাকি আছে সেটা যোগ করুন।',
+    pos_change_not_cash:
+      'ভাংতি শুধু নগদ থেকে ফেরত হয়। কার্ড বা ওয়ালেটের অঙ্ক বাকি টাকার সমান করুন।',
+    pos_method_not_set:
+      'রেজিস্টারে এখন এই পেমেন্টের ধরনের কোনো অ্যাকাউন্ট নেই। pos.register.manage আছে এমন কেউ সেটিংস → POS রেজিস্টারে সেটা দিলে বিক্রিটা আবার চেষ্টা করুন।',
+    pos_number_taken:
+      'এই রেজিস্টারের আরেকটা বিক্রিতে এই নম্বর আছে। এমন হওয়ার কথা নয়: কাগজের রিসিটটা রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. Office words stay in English as
  the app already writes them: POS, VAT, SKU, workspace, permission, and the permission keys themselves (CLAUDE.md →
  Language). bKash and Nagad keep their own names, as the wallets write them.
- **The counter's words are the ones a Bangladeshi shop uses:** রিসিট, ক্যাশিয়ার, কাউন্টার, ওয়াক-ইন গ্রাহক, and ভাংতি for
  change. "Sold short" is স্টকের বেশি বিক্রি ("sold more than the stock"), which says what happened without the English
  idiom.
- **The examples that are typed values stay as typed:** POS1, `POS1-000123`, Front counter, the TrxID and the card's
  digits. A number in a sentence is in Bangla digits (৭ দিনের মধ্যে, ৫৮ মিমি).
- **`itemCount_one` and `itemCount_other` are the same text.** Bangla has one form here, but i18next asks for both keys,
  because the English type has both.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src/locales
```

Build `@omnivo/contracts` before `@omnivo/i18n` (the locale files read `ErrorCode` from its build), and `@omnivo/i18n`
before the ui package and the app. All pass: 15 i18n tests (none new: this part adds words, and the type check is
their test). `pnpm --filter @omnivo/app typecheck` fails only in `notification-bell.tsx`, `sync-parts.tsx` and
`mocks/push-data.ts`, which 20a.6 and 20a.7 change.

## 20a.6a — `packages/sync` and the POS screen

This part makes the counter work: the device keeps the registers of its branch and the one it holds, a sale gets the
next number and goes into the outbox, and the `/pos` screen sells, takes the money and prints the receipt. The
registers settings page, the POS sales list and the "Sold short" list are the next part (20a.6b).

The order of the files:

1. `packages/sync`: the registers table and the claim on the device, the sale's save, the stock and barcode reads,
   and the outbox rule for a POS sale.
2. `apps/app/src/lib/pos.ts`: the cart, worked out without React.
3. The session: letting go of the register at sign-out.
4. The frame without the shell (the route and the sidebar link are in 20a.6b, with the other POS pages').
5. The screen: the page and its bar, the register chooser, the products, the cart, the payment and the receipt.
6. The Sync page: how it names a sale, and what it lets you do with one.

### `packages/sync/src/database.ts`: the registers and the claim

```diff
@@ -6,6 +6,7 @@ import type {
   SyncCustomer,
   SyncCustomerGroup,
   SyncEntity,
+  SyncPosRegister,
   SyncPriceList,
   SyncPriceListItem,
   SyncSettings,
@@ -155,6 +156,16 @@ export interface NoticeRow {
   box: Box<SyncNoticeRecord>;
 }
 
+// Step 20a: the register this device holds, and the last number it gave a sale of it. One row,
+// under the key 'claim'. The claim's answer starts it (the server's last number), and every sale
+// counts it up in the same transaction that puts the sale in the outbox, so two sales never get one
+// number, also from two tabs. Clear, not sealed: an id and a count, nothing a person typed.
+export interface RegisterClaim {
+  key: 'claim';
+  registerId: string;
+  last: number;
+}
+
 // The tables, by entity. The names are the ones the app reads (db.products, db.customers).
 export const TABLE_OF = {
   settings: 'settings',
@@ -162,6 +173,7 @@ export const TABLE_OF = {
   product_category: 'productCategories',
   tax_rate: 'taxRates',
   warehouse: 'warehouses',
+  pos_register: 'posRegisters',
   price_list: 'priceLists',
   customer_group: 'customerGroups',
   product: 'products',
@@ -171,6 +183,23 @@ export const TABLE_OF = {
 } as const satisfies Record<SyncEntity, string>;
 export type SyncTableName = (typeof TABLE_OF)[SyncEntity];
 
+// The synced tables as they were in version 3, for its upgrade. Not TABLE_OF: a device that skips
+// versions (2 → 4) runs version 3's upgrade before version 4 makes posRegisters, and clearing a
+// table that does not exist yet fails the whole upgrade, so the copy would never open.
+const VERSION_3_TABLES = [
+  'settings',
+  'units',
+  'productCategories',
+  'taxRates',
+  'warehouses',
+  'priceLists',
+  'customerGroups',
+  'products',
+  'priceListItems',
+  'customers',
+  'stock',
+] as const satisfies readonly SyncTableName[];
+
 // One local database per person and workspace: two people on one shop computer never read each
 // other's copy, and a person in two workspaces keeps both.
 export function databaseName(tenantId: string, userId: string): string {
@@ -191,6 +220,7 @@ export class SyncDatabase extends Dexie {
   productCategories!: Table<SealedRow<SyncCategory>, string>;
   taxRates!: Table<SealedRow<TaxRate>, string>;
   warehouses!: Table<SealedRow<Warehouse>, string>;
+  posRegisters!: Table<SealedRow<SyncPosRegister>, string>;
   priceLists!: Table<SealedRow<SyncPriceList>, string>;
   customerGroups!: Table<SealedRow<SyncCustomerGroup>, string>;
   products!: Table<ProductRow, string>;
@@ -207,6 +237,8 @@ export class SyncDatabase extends Dexie {
   // copy.ts seals them (an upgrade cannot wait for Web Crypto). Empty after that.
   legacyOutbox!: Table<OutboxEntry, number>;
   legacyNotices!: Table<SyncNoticeRecord, string>;
+  // Step 20a: one row (RegisterClaim)
+  registerClaim!: Table<RegisterClaim, string>;
 
   constructor(name: string) {
     super(name);
@@ -266,7 +298,7 @@ export class SyncDatabase extends Dexie {
         legacyNotices: 'commandId',
       })
       .upgrade(async (tx) => {
-        for (const name of Object.values(TABLE_OF)) await tx.table(name).clear();
+        for (const name of VERSION_3_TABLES) await tx.table(name).clear();
         await tx.table('meta').delete('pull');
         const outbox = tx.table<OutboxEntry, number>('outbox');
         await tx.table<OutboxEntry, number>('legacyOutbox').bulkAdd(await outbox.toArray());
@@ -275,6 +307,13 @@ export class SyncDatabase extends Dexie {
         await tx.table<SyncNoticeRecord, string>('legacyNotices').bulkAdd(await notices.toArray());
         await notices.clear();
       });
+    // Step 20a: the registers of the branch, and the claim. No upgrade: the copy stays, and the
+    // registers come with the next pull. SYNC_PROTOCOL is 2 now, and the server answers a cursor of
+    // protocol 1 with a full pull, which brings every register (and sweeps nothing it should keep).
+    this.version(4).stores({
+      posRegisters: 'key, gen',
+      registerClaim: 'key',
+    });
   }
 
   // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
```

- **`RegisterClaim`, one clear row:** the register this device holds and the last number it gave. It is not sealed:
  it holds an id and a count, nothing a person typed or read (the rule in CLAUDE.md: ids, codes and dates may stay
  clear). Being clear also lets the save check it inside a transaction, which cannot wait for Web Crypto.
- **`pos_register: 'posRegisters'` in `TABLE_OF`:** `TABLE_OF` is `satisfies Record<SyncEntity, string>`, so the
  contract's new entity (20a.1) made this file fail to compile until the table was named. The pull, the sweep at the
  end of a full pull and the sign-out's delete all walk `TABLE_OF`, so the registers get all three for free.
- **`version(4)` with no upgrade:** a new table needs a new version, but nothing in the old tables changes. The
  registers arrive with the next pull: `SYNC_PROTOCOL` is 2 now, and the server answers a cursor of protocol 1 with a
  full pull (20a.3), which brings every register.
- **`VERSION_3_TABLES`, a fixed list:** this is a bug fix the old tests found. Version 3's upgrade cleared every table
  in `TABLE_OF`. A device still on step 18b's database (version 2) runs version 3's upgrade before version 4 creates
  `posRegisters`, and clearing a table that does not exist fails the whole upgrade: the copy would never open again.
  An upgrade must list the tables of its own version, never the list of today.

### `packages/sync/src/apply.ts`: registers in a page

```diff
@@ -3,6 +3,7 @@ import type {
   SyncChange,
   SyncCustomer,
   SyncCustomerGroup,
+  SyncPosRegister,
   SyncPriceList,
   SyncPull,
   SyncSettings,
@@ -38,6 +39,7 @@ export interface SealedChanges {
     productCategories: Unstamped<SealedRow<SyncCategory>>[];
     taxRates: Unstamped<SealedRow<TaxRate>>[];
     warehouses: Unstamped<SealedRow<Warehouse>>[];
+    posRegisters: Unstamped<SealedRow<SyncPosRegister>>[];
     priceLists: Unstamped<SealedRow<SyncPriceList>>[];
     customerGroups: Unstamped<SealedRow<SyncCustomerGroup>>[];
     products: Unstamped<ProductRow>[];
@@ -71,6 +73,7 @@ export async function sealChanges(
       productCategories: [],
       taxRates: [],
       warehouses: [],
+      posRegisters: [],
       priceLists: [],
       customerGroups: [],
       products: [],
@@ -106,6 +109,9 @@ export async function sealChanges(
         case 'warehouse':
           puts.warehouses.push(await boxed(copy, 'warehouses', key, change.data));
           break;
+        case 'pos_register':
+          puts.posRegisters.push(await boxed(copy, 'posRegisters', key, change.data));
+          break;
         case 'price_list':
           puts.priceLists.push(await boxed(copy, 'priceLists', key, change.data));
           break;
@@ -187,6 +193,7 @@ export async function writeSealed(
   await db.productCategories.bulkPut(stamp(puts.productCategories, gen));
   await db.taxRates.bulkPut(stamp(puts.taxRates, gen));
   await db.warehouses.bulkPut(stamp(puts.warehouses, gen));
+  await db.posRegisters.bulkPut(stamp(puts.posRegisters, gen));
   await db.priceLists.bulkPut(stamp(puts.priceLists, gen));
   await db.customerGroups.bulkPut(stamp(puts.customerGroups, gen));
   await db.products.bulkPut(stamp(puts.products, gen));
```

- **A case in the switch, a list in `SealedChanges`, a `bulkPut` in `writeSealed`:** the same three lines every
  entity has. The switch narrows `change.data` to `SyncPosRegister`, so a register can only go into `posRegisters`.
- **Sealed whole, no clear index:** the screen reads all the registers of a branch at once (a few, a few dozen), so
  it needs no index, and the name stays in the box.

### `packages/sync/src/pos.ts` (new): the register, the number, the sale

```ts
import {
  addQuantity,
  formatPosNumber,
  type PosRegister,
  type PosSaleInput,
  type Product,
  subtractQuantity,
  type SyncCommand,
  type SyncPosRegister,
  type SyncStock,
  toBaseQuantity,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { LocalCopy } from './copy.js';
import type { RegisterClaim } from './database.js';
import { openEntries, openRows, sealEntry } from './sealed.js';

// Step 20a: the POS on the device. The registers of the branch come with the pull; the claim says
// which one this device holds and the last number it gave; a sale goes into the outbox with the
// next number. No Dexie import, like outbox.ts: the POS screen's chunk calls these with the copy
// the session opened, and carries no Dexie of its own.

// The registers of the device's branch, by code: the choose dialog lists them, and the screen
// finds the one it sells on. The codes are capital letters and digits, so `<` sorts them as a
// person reads them.
export async function localRegisters(copy: LocalCopy): Promise<SyncPosRegister[]> {
  const registers = await openRows(copy, 'posRegisters', await copy.db.posRegisters.toArray());
  return registers.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export async function readClaim(copy: LocalCopy): Promise<RegisterClaim | null> {
  return (await copy.db.registerClaim.get('claim')) ?? null;
}

// The server answered a claim: this device holds `register` now. It counts on from the server's
// last number, or from its own when its own is ahead: claiming the register it already holds
// (a reload that lost nothing, the claim is idempotent) answers the last number the server has
// received, and the sales still in the outbox are past it. A claim of another register starts
// from the server's number alone: the device let the old one go only with no sale of it waiting.
export async function keepClaim(
  copy: LocalCopy,
  register: Pick<PosRegister, 'id' | 'lastNumber'>,
): Promise<RegisterClaim> {
  const { db } = copy;
  return db.transaction('rw', db.registerClaim, async () => {
    const old = await db.registerClaim.get('claim');
    const own = old?.registerId === register.id ? old.last : 0;
    const claim: RegisterClaim = {
      key: 'claim',
      registerId: register.id,
      last: Math.max(own, register.lastNumber),
    };
    await db.registerClaim.put(claim);
    return claim;
  });
}

// After the server let the register go (Change register, sign-out)
export async function dropClaim(copy: LocalCopy): Promise<void> {
  await copy.db.registerClaim.delete('claim');
}

// The POS sales still on the device. A device holds one register at a time and lets it go only
// when this is 0 (decision 14), so they are all sales of the register it holds. The command's type
// is a clear field of the row: nothing is opened.
export async function waitingSales(copy: LocalCopy): Promise<number> {
  return copy.db.outbox.filter((row) => row.type === 'pos_sale.create').count();
}

// What the POS screen saves. The sale is complete and checked (posSaleInputSchema's output),
// except its number: the save gives it the next one.
export interface PosSaleSave {
  input: Omit<PosSaleInput, 'sequence'>;
  // For the number (POS1-000124), which the Sync page and the receipt show
  registerCode: string;
  total: string;
  // This device's clock, for the Sync page only
  savedAt: string;
}

// saved: in the outbox, with this number and the sale's id (a UUIDv7 made here, like every id the
// device makes; step 20c's return points at it). not-held: the claim is gone or is another
// register's (another tab changed the register meanwhile); the screen asks for a register again.
export type PosSaveResult =
  { kind: 'saved'; saleId: string; sequence: number; number: string } | { kind: 'not-held' };

const SAVE_ATTEMPTS = 3;

// The number and the outbox in one transaction: the claim counts up only when the sale is in the
// outbox, so a number is never used twice and never skipped. The command is sealed first, with the
// number the claim gives now (a transaction cannot wait for Web Crypto), and written only if the
// claim still says the same; else another tab sold meanwhile, and the save starts again with the
// next number. Three times in a row would take three tabs selling at the same moment.
export async function savePosSale(copy: LocalCopy, save: PosSaleSave): Promise<PosSaveResult> {
  const { db } = copy;
  const saleId = uuidv7();
  for (let attempt = 1; ; attempt += 1) {
    const claim = await db.registerClaim.get('claim');
    if (claim?.registerId !== save.input.registerId) return { kind: 'not-held' };
    const sequence = claim.last + 1;
    const number = formatPosNumber(save.registerCode, sequence);
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_sale.create',
      saleId,
      input: { ...save.input, sequence },
    };
    const row = await sealEntry(copy, {
      command,
      status: 'waiting',
      sent: false,
      error: null,
      // The push holds a command back while an earlier one on the same customer waits (push.ts).
      // A sale to a customer made on this device waits for that customer, like an order. A walk-in
      // sale waits for nothing: its own id here, so a hundred walk-in sales go in one push, and a
      // refused one holds back no other.
      customerId: save.input.customerId ?? saleId,
      key: saleId,
      base: null,
      // The Sync page says "Sale POS1-000124" (sync.commands.pos_sale.create)
      name: number,
      lines: save.input.lines.length,
      total: save.total,
      savedAt: save.savedAt,
    });
    const saved = await db.transaction('rw', [db.registerClaim, db.outbox], async () => {
      const now = await db.registerClaim.get('claim');
      if (now?.registerId !== claim.registerId || now.last !== claim.last) return false;
      await db.registerClaim.put({ ...claim, last: sequence });
      await db.outbox.add(row);
      return true;
    });
    if (saved) return { kind: 'saved', saleId, sequence, number };
    if (attempt === SAVE_ATTEMPTS) throw new Error('The register kept changing during the save');
  }
}

// What this device's own POS sales took from a warehouse that its copy does not show yet: every sale
// still in the outbox, by variant and batch (`${variantId}|${batchId}`), in the base unit. Waiting,
// sending or refused: the goods left the counter all the same, and the server's stock (which the
// next pull brings) has none of them until the sale is posted. Without this, the last T-shirt could
// be sold twice offline, and the second sale would go below zero when it syncs. A sale of a
// register on another warehouse does not count (a device sells on one register, but the manager
// may have moved the register meanwhile; the server posts it at the register's warehouse).
async function takenByWaitingSales(
  copy: LocalCopy,
  warehouseId: string,
  variantIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const taken = new Map<string, string>();
  const rows = await copy.db.outbox.filter((row) => row.type === 'pos_sale.create').toArray();
  if (rows.length === 0) return taken;
  const registers = new Set(
    (await localRegisters(copy))
      .filter((register) => register.warehouseId === warehouseId)
      .map((register) => register.id),
  );
  const lines = (await openEntries(copy, rows)).flatMap(({ command }) =>
    command.type === 'pos_sale.create' && registers.has(command.input.registerId)
      ? command.input.lines.filter((line) => variantIds.has(line.variantId))
      : [],
  );
  if (lines.length === 0) return taken;
  // The products of those lines, by the variant index: the unit's factor and whether it is goods
  const products = await openRows<Product>(
    copy,
    'products',
    await copy.db.products
      .where('variantIds')
      .anyOf([...new Set(lines.map((line) => line.variantId))])
      .toArray(),
  );
  for (const line of lines) {
    const product = products.find((one) =>
      one.variants.some((variant) => variant.id === line.variantId),
    );
    // An archived product left the copy; a service moves no stock
    if (product?.type !== 'goods') continue;
    const factor =
      line.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === line.unitId)?.factor;
    if (factor === undefined) continue;
    // 4 decimals, like the cart's own baseQuantity() (apps/app/src/lib/pos.ts)
    const key = `${line.variantId}|${line.batchId ?? ''}`;
    taken.set(key, addQuantity(taken.get(key) ?? '0', toBaseQuantity(line.quantity, factor, 4)));
  }
  return taken;
}

// The stock of some variants in one warehouse, every batch of them: the tiles' "38 in stock", the
// cart's check (decision 7) and the batch a line takes (FEFO). By the variant index, then the
// warehouse: a device keeps the stock of every warehouse of its branch. Less what this device's
// own unsynced sales took (above), so the screen counts a sale the moment it is saved. It reads
// the outbox, so the screen's live read runs again when a sale is saved or leaves the outbox.
// Between a sale's accepted answer and the pull right after it (engine.ts), the copy shows it
// once more: the push and the pull are one sync, so that lasts one request.
export async function stockOf(
  copy: LocalCopy,
  warehouseId: string,
  variantIds: readonly string[],
): Promise<SyncStock[]> {
  if (variantIds.length === 0) return [];
  const rows = await copy.db.stock
    .where('variantId')
    .anyOf(variantIds)
    .filter((row) => row.warehouseId === warehouseId)
    .toArray();
  const [stock, taken] = await Promise.all([
    openRows<SyncStock>(copy, 'stock', rows),
    takenByWaitingSales(copy, warehouseId, new Set(variantIds)),
  ]);
  if (taken.size === 0) return stock;
  // Only rows the copy has: a variant with no row has none here, and less than none changes
  // nothing the screen decides (it stops the sale either way, or the workspace sells below zero)
  return stock.map((row) => {
    const less = taken.get(`${row.variantId}|${row.batchId ?? ''}`);
    return less === undefined ? row : { ...row, quantity: subtractQuantity(row.quantity, less) };
  });
}

// The product a scanned barcode belongs to: a variant's or a pack's. By the multi-entry index, so
// a scan costs one read however many products the shop has. null = no active product has it.
export async function productByBarcode(copy: LocalCopy, code: string): Promise<Product | null> {
  const row = await copy.db.products.where('barcodes').equals(code).first();
  return row ? copy.open('products', row.key, row.box) : null;
}
```

- **No Dexie import:** like `outbox.ts`, every function takes the open `LocalCopy`. The POS screen's chunk calls them,
  and Dexie (30 KB gz) stays in the one chunk the AppFrame loads after sign-in.
- **`localRegisters()` sorts by `<`:** codes are capital letters and digits (20a.1's format), so plain comparison
  puts POS1 before POS2 the way a person reads them. `localeCompare` would also work, at more cost, for no gain.
- **`keepClaim()` takes the larger of the two numbers:** the claim is idempotent (20a.3). A device that claims the
  register it already holds gets back the last number the *server* has received, and its own sales still in the
  outbox are past it. Taking the server's number alone would give those numbers a second time. A claim of another
  register starts from the server's number: the device let the old one go only with no sale of it waiting.
- **`waitingSales()` counts by the clear `type`:** nothing is opened, so it is cheap enough for every "Change
  register" click and for the sign-out. It counts refused sales too: they still have to reach the server (Retry) or
  be discarded before the register may move.
- **`savePosSale()`, the number and the outbox in one transaction:** the claim counts up only in the transaction
  that adds the sale, so a number is never given twice and never skipped. The command is sealed before the
  transaction (a transaction cannot wait for Web Crypto) with the number the claim gives *now*; the transaction writes
  only if the claim still says the same, else another tab sold in between, and the save starts again with the next
  number. This is the same "read, seal, check, write" loop `saveCustomer()` uses (18b, 19b).
- **The sale's id is made here:** it must be a UUIDv7 (`posSaleCommandSchema`), and the app has no UUID library of
  its own; `@omnivo/sync` already has `uuidv7`. It is made once, before the loop, so a retry keeps the same sale.
- **`customerId: save.input.customerId ?? saleId`:** the push holds a command back while an earlier one on the same
  `customerId` waits (`pickBatch`). With `''` for every walk-in sale, all walk-in sales would be one queue: one per
  push, and one refused sale would stop all the rest. With its own id a walk-in sale waits for nothing. A sale to a
  customer made on this device keeps that customer's id, so it waits for the customer's create, like an order.
- **`name: number`:** the Sync page's title is `Sale {{name}}` (20a.5), so the number is the name.
- **`stockOf()` by the variant index, then the warehouse:** a device keeps the stock of every warehouse of its branch,
  and the screen needs one warehouse's stock of a few dozen variants. The variant index finds the rows; the filter
  keeps the register's warehouse.
- **`stockOf()` takes off the device's own sales in the outbox** (decision 78, found in 20a.7): the copy's stock changes
  only when a pull brings the server's, and the server has none of these sales yet. Without it, the last T-shirt
  could be sold twice offline, and the second sale would go below zero at sync.
- **Every POS sale in the outbox counts, refused ones too:** the goods left the counter, whatever the server said.
  Only a sale of a register on this warehouse counts (`localRegisters()`): a manager may have moved the register.
- **The base quantity is worked out like the cart's** (`toBaseQuantity(…, 4)`), from the product's own pack factor,
  found by the `*variantIds` index (18b). A product that left the copy, or a service, takes nothing.
- **It reads the outbox, so the screen's live read runs again by itself** when a sale is saved, sent or discarded
  (Dexie's `liveQuery` watches every table a read touched). One short gap stays: between a sale's accepted answer and
  the pull right after it, in the same sync, the copy shows the sale's stock once more.
- **`productByBarcode()` by the multi-entry index:** `*barcodes` has every variant's and pack's barcode (18a), so a
  scan is one indexed read, whatever the size of the catalogue.

### `packages/sync/src/outbox.ts`: discarding a POS sale

```diff
@@ -302,26 +302,36 @@ function later<E extends Pick<OutboxEntry, 'seq' | 'customerId'>>(
   return items.filter((other) => other.customerId === item.customerId && (other.seq ?? 0) > seq);
 }
 
+// Step 20a: a POS sale leaves the device only once the server refused it. The server keeps the
+// number of a refused sale (the register's last number counts it), so the next device on the
+// register never prints it again. A sale never sent has a number the server does not know yet, and
+// a paper receipt already has it.
+function mayGo(item: Pick<OutboxRow, 'type' | 'status'>): boolean {
+  return item.status !== 'sending' && (item.type !== 'pos_sale.create' || item.status === 'failed');
+}
+
 // What goes with an entry when it is discarded: a new customer takes every later command on that
-// customer (its changes and its orders), which the server could only refuse without it. A change
-// or an order goes alone.
+// customer (its changes, its orders, its refused POS sales), which the server could only refuse
+// without it. A change, an order or a sale goes alone.
 export function dependentsOf(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
-  return entry.command.type === 'customer.create' ? later(entries, entry) : [];
+  return entry.command.type === 'customer.create'
+    ? later(entries, entry).filter((item) =>
+        mayGo({ type: item.command.type, status: item.status }),
+      )
+    : [];
 }
 
 // Discard: the entry and its dependents leave the device and never reach the server. A command
-// being sent is left alone (busy); the page offers Discard again once it has its answer. The
-// clear fields say all of it: nothing is opened.
+// being sent is left alone (busy); the page offers Discard again once it has its answer. So is a
+// POS sale the server has not refused (mayGo). The clear fields say all of it: nothing is opened.
 export async function discardEntry(copy: LocalCopy, seq: number): Promise<SaveResult> {
   const { db } = copy;
   return db.transaction('rw', db.outbox, async () => {
     const row = await db.outbox.get(seq);
     if (!row) return 'unchanged';
-    if (row.status === 'sending') return 'busy';
+    if (!mayGo(row)) return 'busy';
     const others = await db.outbox.where('customerId').equals(row.customerId).toArray();
-    const gone = [row, ...(row.type === 'customer.create' ? later(others, row) : [])].filter(
-      (item) => item.status !== 'sending',
-    );
+    const gone = [row, ...(row.type === 'customer.create' ? later(others, row) : [])].filter(mayGo);
     await db.outbox.bulkDelete(gone.flatMap((item) => item.seq ?? []));
     return 'saved';
   });
```

- **`mayGo()`: a POS sale goes only once refused.** The money was taken and a paper receipt has the number. The
  server keeps the number of a refused sale (20a.3 counts it in the register's last number), so after a discard the
  next device on the register still never prints it again. A sale never sent has a number the server does not know;
  discarding it and then letting the register go would let the next device print the same number.
- **The same rule for the dependents:** discarding a new customer takes its later commands. Its POS sales go with it
  only when refused, for the same reason. A waiting sale stays, and the server refuses it later
  (`sales_customer_invalid`), so it can then be discarded on its own.
- **`dependentsOf()` uses the same rule:** the dialog's "2 more changes go with it" must count what the discard
  really deletes.

### `packages/sync/src/index.ts` and `engine.spec.ts`

```diff
@@ -1,6 +1,6 @@
 // Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
-// the outbox's saves (outbox, overlay, prices; step 18b), the key's code (crypto, keys; step 19b)
-// and the types: none of them loads Dexie at run time, so a page that searches customers or a
+// the outbox's saves (outbox, overlay, prices; step 18b), the key's code (crypto, keys; step 19b),
+// the POS's register and sale (pos; step 20a) and the types: none of them loads Dexie at run time, so a page that searches customers or a
 // form that saves offline stays small. The code that opens the database and syncs (database,
 // copy, apply, push, engine, live, device) brings Dexie, and the app loads it once, lazily, after
 // sign-in. `sideEffects: false` in package.json lets the bundler leave out the modules a chunk
@@ -20,6 +20,7 @@ export {
   type PriceListItemRow,
   type ProductRow,
   type PullState,
+  type RegisterClaim,
   type SealedRow,
   type StockRow,
   SyncDatabase,
@@ -70,6 +71,18 @@ export {
   type SaveResult,
 } from './outbox.js';
 export { changedCustomer, createdCustomer, projectCustomer } from './overlay.js';
+export {
+  dropClaim,
+  keepClaim,
+  localRegisters,
+  type PosSaleSave,
+  type PosSaveResult,
+  productByBarcode,
+  readClaim,
+  savePosSale,
+  stockOf,
+  waitingSales,
+} from './pos.js';
 export { lookUpPrices, productsOfVariants } from './prices.js';
 export { STORAGE_FAILED } from './problems.js';
 export {
```

```diff
@@ -1,6 +1,6 @@
 import 'fake-indexeddb/auto';
 
-import type { SyncPull, SyncPullQuery } from '@omnivo/contracts';
+import { SYNC_PROTOCOL, type SyncPull, type SyncPullQuery } from '@omnivo/contracts';
 import { describe, expect, it, vi } from 'vitest';
 
 import { readPullState } from './state.js';
@@ -59,7 +59,11 @@ describe('SyncEngine', () => {
     const { db, engine } = await engineWith(pull);
     await engine.syncNow();
     expect(pull.mock.calls.map(([query]) => query.cursor)).toEqual([undefined, 'a']);
-    expect(pull.mock.calls[0]?.[0]).toMatchObject({ deviceId: DEVICE, protocol: 1, limit: 500 });
+    expect(pull.mock.calls[0]?.[0]).toMatchObject({
+      deviceId: DEVICE,
+      protocol: SYNC_PROTOCOL,
+      limit: 500,
+    });
     expect(await db.products.count()).toBe(2);
     expect((await readPullState(db)).cursor).toBe('b');
     // The next pull starts from the saved cursor
```

- **`pos.js` listed with the page modules:** the comment at the top sorts the modules by whether they load Dexie;
  `pos.ts` does not, so a page may import it.
- **`SYNC_PROTOCOL` in the engine test:** the test sent `protocol: 1` and failed when 20a.1 moved it to 2. It is
  about the cursor and the pages, not the number.

### `packages/sync/src/pos.spec.ts` (new)

```ts
import 'fake-indexeddb/auto';

import {
  type PosSaleInput,
  stockKey,
  type SyncPosRegister,
  type SyncStock,
  syncCommandSchema,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import type { LocalCopy } from './copy.js';
import { discardEntry } from './outbox.js';
import {
  dropClaim,
  keepClaim,
  localRegisters,
  productByBarcode,
  readClaim,
  savePosSale,
  stockOf,
  waitingSales,
} from './pos.js';
import { outboxEntries } from './queries.js';
import { sealEntry } from './sealed.js';
import { newCopy, page, product, upsertProduct, VAT_15, WAREHOUSE } from './test-fixtures.js';

const SAVED = '2026-10-27T10:15:00.000Z';
const OTHER_WAREHOUSE = '01928c4e-7777-7000-8000-000000000009';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';
const BASE_UNIT = '01928c4e-0000-7000-8000-000000000001';
const BOX = '01928c4e-0000-7000-8000-000000000002';

function register(fields: Partial<SyncPosRegister> & Pick<SyncPosRegister, 'code'>) {
  return {
    id: uuidv7(),
    name: 'Front counter',
    branchId: '01928c4e-6666-7000-8000-000000000001',
    warehouseId: WAREHOUSE,
    accounts: { cash: uuidv7(), card: null, bkash: null, nagad: null },
    maxDiscountPercent: '10.00',
    paperWidth: '80',
    receiptFooter: null,
    deviceId: null,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-10-27T04:00:00.000Z',
    ...fields,
  } satisfies SyncPosRegister;
}

function stock(fields: Partial<SyncStock>): SyncStock {
  return {
    warehouseId: WAREHOUSE,
    productId: uuidv7(),
    variantId: VARIANT,
    batchId: null,
    lotNumber: null,
    manufacturedOn: null,
    expiresOn: null,
    quantity: '38.0000',
    updatedAt: '2026-10-27T04:00:00.000Z',
    ...fields,
  };
}

// A walk-in sale of 2 bags at ৳420, paid ৳1,000 in cash: what the POS screen saves
function sale(
  registerId: string,
  customerId: string | null = null,
): Omit<PosSaleInput, 'sequence'> {
  return {
    registerId,
    date: '2026-10-27',
    soldAt: SAVED,
    customerId,
    pricesIncludeVat: true,
    lines: [
      {
        variantId: VARIANT,
        unitId: BASE_UNIT,
        quantity: '2',
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
    payments: [{ method: 'cash', amount: '1000', reference: null }],
  };
}

async function save(copy: LocalCopy, registerId: string, customerId: string | null = null) {
  return savePosSale(copy, {
    input: sale(registerId, customerId),
    registerCode: 'POS1',
    total: '840.0000',
    savedAt: SAVED,
  });
}

describe('the registers on the device', () => {
  it('keeps the registers the pull sends, sealed, and lists them by code', async () => {
    const copy = await newCopy();
    const second = register({ code: 'POS2', name: 'Pharmacy counter' });
    const first = register({ code: 'POS1' });
    await applyPage(
      copy,
      page({
        changes: [second, first].map((row) => ({
          op: 'upsert' as const,
          entity: 'pos_register' as const,
          key: row.id,
          data: row,
        })),
      }),
      null,
    );
    expect((await localRegisters(copy)).map((row) => row.code)).toEqual(['POS1', 'POS2']);
    // The box holds the name: it is not readable on the disk
    const [stored] = await copy.db.posRegisters.toArray();
    expect(JSON.stringify(stored)).not.toContain('Pharmacy counter');
  });
});

describe('keepClaim', () => {
  it('starts from the server’s last number, and keeps the device’s own when it is ahead', async () => {
    const copy = await newCopy();
    const pos1 = register({ code: 'POS1' });
    expect(await keepClaim(copy, { id: pos1.id, lastNumber: 123 })).toMatchObject({ last: 123 });
    await save(copy, pos1.id);
    await save(copy, pos1.id);
    // A claim again of the register it holds: the server has not received 124 and 125 yet
    expect(await keepClaim(copy, { id: pos1.id, lastNumber: 123 })).toMatchObject({ last: 125 });
  });

  it('starts another register from the server’s number alone', async () => {
    const copy = await newCopy();
    await keepClaim(copy, { id: uuidv7(), lastNumber: 900 });
    const pos2 = uuidv7();
    expect(await keepClaim(copy, { id: pos2, lastNumber: 7 })).toEqual({
      key: 'claim',
      registerId: pos2,
      last: 7,
    });
    await dropClaim(copy);
    expect(await readClaim(copy)).toBeNull();
  });
});

describe('savePosSale', () => {
  it('gives the next number and puts a command in the outbox that the server reads as it is', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 123 });
    const result = await save(copy, registerId);
    expect(result).toMatchObject({ kind: 'saved', sequence: 124, number: 'POS1-000124' });
    const [entry] = await outboxEntries(copy);
    if (entry?.command.type !== 'pos_sale.create') throw new Error('not a POS sale');
    expect(result.kind === 'saved' && result.saleId).toBe(entry.command.saleId);
    expect(entry.command.input.sequence).toBe(124);
    expect(entry).toMatchObject({ name: 'POS1-000124', lines: 1, total: '840.0000' });
    // A walk-in sale waits for nothing: its own id stands in for the customer (push.ts)
    expect(entry.customerId).toBe(entry.command.saleId);
    expect(entry.key).toBe(entry.command.saleId);
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
    expect(await readClaim(copy)).toMatchObject({ last: 124 });
  });

  it('waits for a customer made on the device, like an order', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    const customerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 0 });
    await save(copy, registerId, customerId);
    const [entry] = await outboxEntries(copy);
    expect(entry?.customerId).toBe(customerId);
  });

  it('gives two sales saved at the same moment two numbers', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 41 });
    const results = await Promise.all([save(copy, registerId), save(copy, registerId)]);
    expect(results.map((result) => result.kind === 'saved' && result.sequence).sort()).toEqual([
      42, 43,
    ]);
    expect(await waitingSales(copy)).toBe(2);
  });

  it('saves nothing without the claim of that register', async () => {
    const copy = await newCopy();
    expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
    await keepClaim(copy, { id: uuidv7(), lastNumber: 3 });
    expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
    expect(await waitingSales(copy)).toBe(0);
  });
});

describe('discarding a POS sale', () => {
  it('keeps a sale the server has not refused, and lets a refused one go', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 0 });
    await save(copy, registerId);
    const [entry] = await outboxEntries(copy);
    if (entry?.seq === undefined) throw new Error('no entry');
    // Never sent: its number is on a paper receipt, and the server does not know it yet
    expect(await discardEntry(copy, entry.seq)).toBe('busy');
    await copy.db.outbox.put(
      await sealEntry(copy, {
        ...entry,
        status: 'failed',
        sent: true,
        error: { code: 'pos_register_not_held', fieldErrors: {} },
      }),
    );
    expect(await discardEntry(copy, entry.seq)).toBe('saved');
    expect(await waitingSales(copy)).toBe(0);
  });
});

describe('the stock and the scanner', () => {
  it('reads one warehouse’s stock of the variants asked for, every batch', async () => {
    const copy = await newCopy();
    const rows = [
      stock({ batchId: uuidv7(), lotNumber: 'PCM-2611', quantity: '120.0000' }),
      stock({ batchId: uuidv7(), lotNumber: 'PCM-2702', quantity: '40.0000' }),
      stock({ warehouseId: OTHER_WAREHOUSE }),
      stock({ variantId: uuidv7() }),
    ];
    await applyPage(
      copy,
      page({
        changes: rows.map((row) => ({
          op: 'upsert' as const,
          entity: 'stock' as const,
          key: stockKey(row),
          data: row,
        })),
      }),
      null,
    );
    const found = await stockOf(copy, WAREHOUSE, [VARIANT]);
    expect(found.map((row) => row.lotNumber).sort()).toEqual(['PCM-2611', 'PCM-2702']);
    expect(await stockOf(copy, WAREHOUSE, [])).toEqual([]);
  });

  it('takes off what the device’s own unsynced sales took, at the register’s warehouse only', async () => {
    const copy = await newCopy();
    const pos1 = register({ code: 'POS1' });
    const pos2 = register({ code: 'POS2', warehouseId: OTHER_WAREHOUSE });
    const rice = product({
      name: 'Miniket rice 25 kg',
      variants: [
        {
          id: VARIANT,
          sku: 'RC-MIN-25',
          optionValues: [],
          barcode: null,
          salePrice: '420',
          archivedAt: null,
        },
      ],
      units: [{ unitId: BOX, factor: '5', barcode: null }],
    });
    const row = stock({ productId: rice.id });
    await applyPage(
      copy,
      page({
        changes: [
          upsertProduct(rice),
          ...[pos1, pos2].map((item) => ({
            op: 'upsert' as const,
            entity: 'pos_register' as const,
            key: item.id,
            data: item,
          })),
          { op: 'upsert' as const, entity: 'stock' as const, key: stockKey(row), data: row },
        ],
      }),
      null,
    );
    await keepClaim(copy, { id: pos1.id, lastNumber: 0 });
    // 2 bags, then a pack of 5: 7 of the 38 left the counter
    await save(copy, pos1.id);
    const pack = sale(pos1.id);
    await savePosSale(copy, {
      input: {
        ...pack,
        lines: pack.lines.map((line) => ({ ...line, unitId: BOX, quantity: '1' })),
      },
      registerCode: 'POS1',
      total: '2100.0000',
      savedAt: SAVED,
    });
    expect((await stockOf(copy, WAREHOUSE, [VARIANT])).map((one) => one.quantity)).toEqual([
      '31.0000',
    ]);
    // A sale of a register on another warehouse takes nothing from this one
    await keepClaim(copy, { id: pos2.id, lastNumber: 0 });
    await save(copy, pos2.id);
    expect((await stockOf(copy, WAREHOUSE, [VARIANT])).map((one) => one.quantity)).toEqual([
      '31.0000',
    ]);
    // Once the sales leave the outbox, the copy's stock counts alone (the pull brings the rest)
    await copy.db.outbox.clear();
    expect((await stockOf(copy, WAREHOUSE, [VARIANT])).map((one) => one.quantity)).toEqual([
      '38.0000',
    ]);
  });

  it('finds a product by a variant’s barcode or a pack’s', async () => {
    const copy = await newCopy();
    const strip = product({
      name: 'Paracetamol 500 mg strip',
      variants: [
        {
          id: VARIANT,
          sku: 'PH-PCM-500',
          optionValues: [],
          barcode: '8941100500017',
          salePrice: '12',
          archivedAt: null,
        },
      ],
      units: [{ unitId: BOX, factor: '10', barcode: '8941100500024' }],
    });
    await applyPage(copy, page({ changes: [upsertProduct(strip)] }), null);
    expect((await productByBarcode(copy, '8941100500017'))?.name).toBe(strip.name);
    expect((await productByBarcode(copy, '8941100500024'))?.id).toBe(strip.id);
    expect(await productByBarcode(copy, '0000000000000')).toBeNull();
  });
});
```

- **"keeps the device's own when it is ahead":** two sales after a claim at 123, then the same claim again: the claim
  must stay at 125. This is the case a lost-and-found claim answer would get wrong.
- **"two sales saved at the same moment":** `Promise.all` runs both saves on the same `fake-indexeddb`, so their
  transactions really race; one of them must start again and take 43.
- **The parse check:** `syncCommandSchema.parse(command)` equals the command, so what the outbox keeps is exactly
  what the server reads (the output of the schema, not the form's values).
- **"keeps a sale the server has not refused":** the rule of `mayGo()`, from the outside.
- **"takes off what the device's own unsynced sales took":** 2 bags and a pack of 5 come off 38; a sale of a register on
  another warehouse takes nothing; once the outbox is empty the copy counts alone. Broken on purpose (`stockOf()`
  returning the copy's rows as they are), it fails with 38 for 31.

### `apps/app/src/lib/pos.ts` (new): the cart

```ts
import {
  compareMoney,
  compareQuantity,
  type DiscountType,
  isMoneyAmount,
  isQuantity,
  type PosLineAmounts,
  type PosOverride,
  posOverridesOf,
  type PosPaperWidth,
  type PosPaymentMethod,
  posSaleAmounts,
  type PosSaleFormValues,
  type PosSaleTotals,
  type Product,
  type ProductVariant,
  subtractMoney,
  sumMoney,
  sumQuantity,
  type SyncPosRegister,
  type SyncStock,
  toBaseQuantity,
} from '@omnivo/contracts';

// Step 20a: the POS screen's cart, worked out without React, so the rules are tested on their own
// (pos.spec.ts). The screen keeps one Cart in state and changes it only through these functions.

// One line of the cart. Everything the receipt and the sale need is copied in when the line is
// added (the product may change in the copy while the cart is open; the line keeps what the
// cashier saw).
export interface CartLine {
  // For React and for picking a line; never sent
  key: string;
  productId: string;
  variantId: string;
  // The base unit, the product's sales unit or the pack a barcode named, and its size in the base
  // unit ("1", "10"): stock is counted in base units
  unitId: string;
  factor: string;
  name: string;
  sku: string;
  unitCode: string;
  // The unit's decimals (0 for pcs, 3 for kg): quantities show with them
  decimals: number;
  // 'none' | 'batch' | 'serial' (a string in the contract, so a newer server's mode does not break)
  tracking: string;
  // A service has no stock: no check, no batch
  goods: boolean;
  // As the cashier types them: they may be half typed ("1.") until the sale is paid
  quantity: string;
  // '' while there is no price (a product without one); the cashier types it
  unitPrice: string;
  // The price the line started with (posOverridesOf); null = there was none
  startingPrice: string | null;
  discountType: DiscountType;
  discount: string;
  taxRateId: string;
  // The rate in percent ("15.00"), kept with the line: the receipt is printed with it
  rate: string;
  batchId: string | null;
  serialNumbers: string[];
}

export interface CartCustomer {
  id: string;
  name: string;
  priceListId: string | null;
}

export interface Cart {
  // null = walk-in
  customer: CartCustomer | null;
  lines: CartLine[];
  billDiscountType: DiscountType;
  billDiscount: string;
}

export const EMPTY_CART: Cart = {
  customer: null,
  lines: [],
  billDiscountType: 'amount',
  billDiscount: '',
};

let lineKeys = 0;

// A counter, not crypto.randomUUID(): a key only has to be unique on this screen
export function newLineKey(): string {
  lineKeys += 1;
  return `line-${String(lineKeys)}`;
}

// "Polo shirt — M, Navy blue", like the sales documents' line (description null)
export function itemName(product: Pick<Product, 'name'>, variant: ProductVariant): string {
  return variant.optionValues.length === 0
    ? product.name
    : `${product.name} — ${variant.optionValues.join(', ')}`;
}

// A value still being typed counts as 0 in the totals. The arithmetic of the contracts throws on
// "1." or "", and the totals are worked out on every key press.
function money(value: string): string {
  return isMoneyAmount(value) ? value : '0';
}

function quantity(value: string): string {
  return isQuantity(value) ? value : '0';
}

// A scan of the same item again adds one to its line, the way a cashier expects. A serial item
// never merges: each scan is another serial number, and the line of serials is filled by the
// scanner (pos-cart.tsx). Nor does a line whose price or discount the cashier changed: the new one
// starts from the price again.
export function addToCart(cart: Cart, line: CartLine): Cart {
  const same = cart.lines.find(
    (other) =>
      other.tracking !== 'serial' &&
      other.variantId === line.variantId &&
      other.unitId === line.unitId &&
      other.batchId === line.batchId &&
      other.unitPrice === line.unitPrice &&
      money(other.discount) === '0',
  );
  if (!same || line.tracking === 'serial') return { ...cart, lines: [...cart.lines, line] };
  return changeLine(cart, same.key, {
    quantity: sumQuantity([quantity(same.quantity), quantity(line.quantity)]),
  });
}

export function changeLine(cart: Cart, key: string, change: Partial<CartLine>): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) => (line.key === key ? { ...line, ...change } : line)),
  };
}

export function removeLine(cart: Cart, key: string): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.key !== key) };
}

export interface CartAmounts {
  lines: PosLineAmounts[];
  totals: PosSaleTotals;
}

// The same arithmetic the server runs (posSaleAmounts in the contracts), so the screen's total is
// the receipt's and the books'
export function cartAmounts(cart: Cart, pricesIncludeVat: boolean): CartAmounts {
  return posSaleAmounts(
    cart.lines.map((line) => ({
      quantity: quantity(line.quantity),
      unitPrice: money(line.unitPrice),
      discountType: line.discountType,
      discount: money(line.discount),
      rate: line.rate,
    })),
    { type: cart.billDiscountType, value: money(cart.billDiscount) },
    pricesIncludeVat,
  );
}

// The line's quantity in the base unit, as the stock counts it
export function baseQuantity(line: Pick<CartLine, 'quantity' | 'factor'>): string {
  return toBaseQuantity(quantity(line.quantity), line.factor, 4);
}

// A line ready to sell: a quantity above 0, a price, and for a serial item one serial number per
// base unit (the server refuses anything else: stock_serial_count). Pay waits for every line.
export function lineReady(line: CartLine): boolean {
  if (!isQuantity(line.quantity) || !isMoneyAmount(line.unitPrice)) return false;
  return (
    line.tracking !== 'serial' ||
    compareQuantity(baseQuantity(line), String(line.serialNumbers.length)) === 0
  );
}

// What a variant has in the warehouse, every batch together, in the base unit
export function onHandOf(stock: readonly SyncStock[], variantId: string): string {
  return sumQuantity(stock.filter((row) => row.variantId === variantId).map((row) => row.quantity));
}

// Decision 7: when the workspace does not sell below zero, the screen stops a sale the copy says
// the warehouse cannot fill. Per variant, over all its lines (two lines of rice take from the same
// sacks). Every batch counts: the server takes the other batches when the line's own is short.
// The answer is per line: what the warehouse has of that line's variant.
export function shortLines(
  cart: Cart,
  stock: readonly SyncStock[],
  allowNegativeStock: boolean,
): Map<string, string> {
  const short = new Map<string, string>();
  if (allowNegativeStock) return short;
  const goods = cart.lines.filter((line) => line.goods);
  for (const variantId of new Set(goods.map((line) => line.variantId))) {
    const lines = goods.filter((line) => line.variantId === variantId);
    const wanted = sumQuantity(lines.map(baseQuantity));
    const onHand = onHandOf(stock, variantId);
    if (compareQuantity(wanted, onHand) > 0) {
      for (const line of lines) short.set(line.key, onHand);
    }
  }
  return short;
}

// Decision 11: what the cashier did that needs pos.price.override, worked out like the server's
// audit. Someone with the permission may; for everyone else the screen says it at the box and the
// Pay button waits.
export function overridesOf(
  cart: Cart,
  register: Pick<SyncPosRegister, 'maxDiscountPercent'>,
): PosOverride[] {
  return posOverridesOf(
    {
      lines: cart.lines.map((line) => ({
        quantity: quantity(line.quantity),
        unitPrice: money(line.unitPrice),
        discountType: line.discountType,
        discount: money(line.discount),
        startingPrice: line.startingPrice,
      })),
      billDiscountType: cart.billDiscountType,
      billDiscount: money(cart.billDiscount),
    },
    register.maxDiscountPercent,
  );
}

// The batch a line of a batch product takes: first expiry first (FEFO), among the batches with
// stock that have not expired. With none, a workspace that sells below zero still needs a batch
// (the server refuses a batch line without one): the one that expires last, so the shortfall lands
// on the freshest stock to come. null = this warehouse never had a batch of it.
export function fefoBatch(
  rows: readonly SyncStock[],
  today: string,
  allowNegativeStock: boolean,
): string | null {
  const batches = rows.filter(
    (row): row is SyncStock & { batchId: string } =>
      row.batchId !== null && (row.expiresOn === null || row.expiresOn >= today),
  );
  // No expiry date sorts after every date: '9' is after any ISO date
  const expiry = (row: SyncStock) => row.expiresOn ?? '9';
  const order = [...batches].sort(
    (a, b) =>
      expiry(a).localeCompare(expiry(b)) || (a.lotNumber ?? '').localeCompare(b.lotNumber ?? ''),
  );
  const inStock = order.find((row) => compareQuantity(row.quantity, '0') > 0);
  if (inStock) return inStock.batchId;
  return allowNegativeStock ? (order.at(-1)?.batchId ?? null) : null;
}

export interface PaymentRow {
  // For React; never sent
  key: string;
  method: PosPaymentMethod;
  amount: string;
  reference: string;
}

// What is still to pay after the rows typed so far ('0' once the total is covered)
export function dueOf(payments: readonly PaymentRow[], total: string): string {
  const due = subtractMoney(total, sumMoney(payments.map((row) => money(row.amount))));
  return compareMoney(due, '0') > 0 ? due : '0.0000';
}

// The notes a customer may hand over for this total, for the cash chips: the next ৳10, ৳50, ৳100,
// ৳500 and ৳1,000 above it, without repeats and without the exact total (it has its own button).
// In whole taka: a note is never ৳0.50.
export function quickCash(total: string): string[] {
  const whole = BigInt(money(total).split('.')[0] ?? '0');
  const amounts = [10n, 50n, 100n, 500n, 1000n].map((note) => (whole / note + 1n) * note);
  return [...new Set(amounts)]
    .filter((amount) => compareMoney(String(amount), total) > 0)
    .slice(0, 4)
    .map(String);
}

// The sale as posSaleInputSchema reads it. The form values (z.input): the schema trims, checks and
// turns '' into null, and the screen saves its output only (pos-pay.tsx).
export function saleValues(input: {
  cart: Cart;
  registerId: string;
  date: string;
  soldAt: string;
  pricesIncludeVat: boolean;
  payments: readonly PaymentRow[];
}): Omit<PosSaleFormValues, 'sequence'> {
  const { cart } = input;
  return {
    registerId: input.registerId,
    date: input.date,
    soldAt: input.soldAt,
    customerId: cart.customer?.id ?? null,
    pricesIncludeVat: input.pricesIncludeVat,
    lines: cart.lines.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      description: null,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discount: line.discount,
      taxRateId: line.taxRateId,
      rate: line.rate,
      startingPrice: line.startingPrice,
      batchId: line.batchId,
      serialNumbers: line.serialNumbers,
    })),
    billDiscountType: cart.billDiscountType,
    billDiscount: cart.billDiscount,
    payments: input.payments.map((row) => ({
      method: row.method,
      amount: row.amount,
      reference: row.reference,
    })),
  };
}

// What a receipt prints, from either side: the sale just paid on the screen (pos-screen.tsx) or a
// posted sale from the server, printed again from its page (pos-sale.tsx). Both fill this, so the
// two print the same paper.
export interface ReceiptLine {
  key: string;
  name: string;
  quantity: string;
  // The unit's decimals and code: "1.250 kg"
  decimals: number;
  unitCode: string;
  unitPrice: string;
  // The line's own discount in taka, and the line after it, in the price as typed
  discount: string;
  after: string;
}

export interface ReceiptData {
  number: string;
  soldAt: string;
  registerCode: string;
  paperWidth: PosPaperWidth;
  receiptFooter: string | null;
  cashier: string;
  // null = walk-in
  customerName: string | null;
  lines: ReceiptLine[];
  pricesIncludeVat: boolean;
  billDiscount: string;
  net: string;
  vat: string;
  total: string;
  payments: { method: PosPaymentMethod; amount: string; reference: string | null }[];
  paid: string;
  change: string;
}

// The company at the top, like useCompany() in print-documents.tsx: its legal name or the
// workspace's, the address one line per line, the BIN and the phone. From the device's copy of
// the settings on the screen (it works offline), from the server's on the sale's page.
export interface ReceiptCompany {
  name: string;
  lines: string[];
  timeZone: string;
}

// The receipt of the sale just paid, from the cart as it was paid (the pay dialog). A line's
// discount and its amount after it come from the same arithmetic as the saved sale.
export function receiptOfCart(input: {
  number: string;
  soldAt: string;
  register: Pick<SyncPosRegister, 'code' | 'paperWidth' | 'receiptFooter'>;
  cashier: string;
  cart: Cart;
  pricesIncludeVat: boolean;
  payments: ReceiptData['payments'];
  paid: string;
  change: string;
}): ReceiptData {
  const { cart, register } = input;
  const amounts = cartAmounts(cart, input.pricesIncludeVat);
  return {
    number: input.number,
    soldAt: input.soldAt,
    registerCode: register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: input.cashier,
    customerName: cart.customer?.name ?? null,
    lines: cart.lines.map((line, index) => {
      const amount = amounts.lines[index];
      return {
        key: line.key,
        name: line.name,
        quantity: line.quantity,
        decimals: line.decimals,
        unitCode: line.unitCode,
        unitPrice: line.unitPrice,
        discount: amount?.discount ?? '0',
        after: amount ? subtractMoney(amount.gross, amount.discount) : '0',
      };
    }),
    pricesIncludeVat: input.pricesIncludeVat,
    billDiscount: amounts.totals.billDiscount,
    net: amounts.totals.net,
    vat: amounts.totals.vat,
    total: amounts.totals.total,
    payments: input.payments,
    paid: input.paid,
    change: input.change,
  };
}
```

- **The cart is plain data plus functions:** the screen keeps one `Cart` in React state and changes it only through
  `addToCart`, `changeLine` and `removeLine`. The rules can then be tested without a browser (`pos.spec.ts`).
- **A line copies what it needs when it is added** (name, SKU, unit code, decimals, factor, rate): a pull may change
  the product while the cart is open, and the receipt must say what the cashier saw.
- **`money()` and `quantity()` turn a half-typed box into 0:** the totals are worked out on every key press, and the
  contracts' arithmetic throws on `"1."` or `""`. The sale itself is checked by the schema before it is saved.
- **`addToCart()` merges only an untouched line of the same item:** a second scan of the rice adds 1 to its line. Not
  a serial item (each scan is another serial number), and not a line whose price or discount the cashier changed
  (the new item starts from the price again).
- **`cartAmounts()` is `posSaleAmounts()`:** the screen's total, the receipt's and the books' come from one function
  in the contracts (20a.1), so they cannot differ by a paisa.
- **`lineReady()`:** Pay waits until every line has a quantity above 0, a price, and for a serial item one serial
  number per base unit. The server refuses anything else (`stock_serial_count`), and a refused sale is a sale whose
  money was taken; it is far better to stop it at the counter.
- **`shortLines()` per variant, every batch:** two lines of the same rice take from the same sacks, so their sum is
  compared with the stock. Every batch counts, because the server takes the other batches when the line's own one is
  short (decision 15). Only when the workspace does not allow negative stock (decision 7).
- **`overridesOf()` is the contract's `posOverridesOf()`:** the screen asks for `pos.price.override` for exactly what
  the server writes to the audit log.
- **`fefoBatch()`:** first expiry first, among batches with stock that have not expired; a batch with no expiry date
  sorts last (`'9'` is after any ISO date). With nothing in stock, a workspace that sells below zero still needs a
  batch (the server refuses a batch line without one, `stock_batch_required`): the one that expires last, so the
  shortfall lands on the freshest stock to come.
- **`quickCash()` in `BigInt`:** money is never a JavaScript `number` (CLAUDE.md). Notes are whole taka, so the
  integer part is enough, and `BigInt` divides it exactly.
- **`saleValues()` returns the form's values (`z.input`):** the pay dialog runs them through `posSaleInputSchema`,
  which trims, checks and turns `''` into `null`. Only the schema's output is saved.
- **`ReceiptData` and `receiptOfCart()`:** what a receipt prints, as plain data. The pay dialog fills it from the cart
  just paid; 20a.6b's sale page fills it from the server's sale. One receipt component prints both, so the paper is
  the same. A receipt line is after its own discount (`gross − discount`), in the price as typed: with the bill's
  discount as one row under the lines, "lines − bill discount" is the total when prices include VAT, and the amount
  before VAT when they do not. The types live here, not in the receipt's module: that module is lazy, and importing
  from it would pull it into the screen's chunk.

### `apps/app/src/lib/pos.spec.ts` (new)

```ts
import { posSaleInputSchema, type SyncStock } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  addToCart,
  type Cart,
  cartAmounts,
  type CartLine,
  changeLine,
  dueOf,
  EMPTY_CART,
  fefoBatch,
  lineReady,
  newLineKey,
  overridesOf,
  quickCash,
  receiptOfCart,
  removeLine,
  saleValues,
  shortLines,
} from './pos';

const RICE = '01928c4e-8888-7000-8000-000000000001';
const PHONE = '01928c4e-8888-7000-8000-000000000002';
const BAG = '01928c4e-0000-7000-8000-000000000001';
const VAT_15 = '01928c4e-7777-7000-8000-000000000002';
const REGISTER = '01928c4e-5555-7000-8000-000000000001';
const WAREHOUSE = '01928c4e-7777-7000-8000-000000000001';

function line(fields: Partial<CartLine> = {}): CartLine {
  return {
    key: newLineKey(),
    productId: '01928c4e-4444-7000-8000-000000000001',
    variantId: RICE,
    unitId: BAG,
    factor: '1',
    name: 'Miniket rice 5 kg',
    sku: 'GR-RICE-05',
    unitCode: 'bag',
    decimals: 0,
    tracking: 'none',
    goods: true,
    quantity: '1',
    unitPrice: '420.0000',
    startingPrice: '420.0000',
    discountType: 'percent',
    discount: '0',
    taxRateId: VAT_15,
    rate: '15.00',
    batchId: null,
    serialNumbers: [],
    ...fields,
  };
}

function stock(fields: Partial<SyncStock>): SyncStock {
  return {
    warehouseId: WAREHOUSE,
    productId: '01928c4e-4444-7000-8000-000000000001',
    variantId: RICE,
    batchId: null,
    lotNumber: null,
    manufacturedOn: null,
    expiresOn: null,
    quantity: '3.0000',
    updatedAt: '2026-10-27T04:00:00.000Z',
    ...fields,
  };
}

function cartOf(...lines: CartLine[]): Cart {
  return { ...EMPTY_CART, lines };
}

describe('addToCart', () => {
  it('adds one to the line of the same item, and keeps a serial item on lines of its own', () => {
    let cart = addToCart(EMPTY_CART, line());
    cart = addToCart(cart, line());
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.quantity).toBe('2.0000');

    const phone = { variantId: PHONE, tracking: 'serial', serialNumbers: ['SN-8841207'] };
    cart = addToCart(addToCart(cart, line(phone)), line(phone));
    expect(cart.lines).toHaveLength(3);
  });

  it('starts a new line when the cashier changed the old one’s price or discount', () => {
    const first = line();
    let cart = changeLine(cartOf(first), first.key, { discount: '5' });
    cart = addToCart(cart, line());
    expect(cart.lines.map((item) => item.quantity)).toEqual(['1', '1']);
    expect(removeLine(cart, first.key).lines).toHaveLength(1);
  });
});

describe('cartAmounts', () => {
  it('works out the receipt like the server, and counts a half-typed box as 0', () => {
    // 2 bags at ৳420 with VAT in the price, ৳40 off the bill: ৳800, of which VAT ৳104.35
    const cart = {
      ...cartOf(line({ quantity: '2' }), line({ quantity: '1.' })),
      billDiscount: '40',
    };
    const { totals } = cartAmounts(cart, true);
    expect(totals).toMatchObject({ billDiscount: '40.0000', total: '800.0000', vat: '104.3500' });
  });
});

describe('lineReady', () => {
  it('waits for a quantity, a price and one serial number per base unit', () => {
    expect(lineReady(line())).toBe(true);
    expect(lineReady(line({ quantity: '0' }))).toBe(false);
    expect(lineReady(line({ quantity: '1.' }))).toBe(false);
    expect(lineReady(line({ unitPrice: '' }))).toBe(false);
    const phone = line({ tracking: 'serial', quantity: '2', serialNumbers: ['SN-1'] });
    expect(lineReady(phone)).toBe(false);
    expect(lineReady({ ...phone, serialNumbers: ['SN-1', 'SN-2'] })).toBe(true);
  });
});

describe('shortLines', () => {
  it('stops a variant whose lines together need more than the warehouse has', () => {
    const a = line({ quantity: '2' });
    const b = line({ quantity: '2', unitPrice: '400.0000' });
    const service = line({ variantId: PHONE, goods: false, quantity: '9' });
    const rows = [stock({ quantity: '1.0000', batchId: 'x' }), stock({ quantity: '2.0000' })];
    const short = shortLines(cartOf(a, b, service), rows, false);
    expect([...short.entries()]).toEqual([
      [a.key, '3.0000'],
      [b.key, '3.0000'],
    ]);
    expect(shortLines(cartOf(a, b), rows, true).size).toBe(0);
  });
});

describe('overridesOf', () => {
  it('names a changed price and a discount above the register’s limit', () => {
    const changed = line({ unitPrice: '400' });
    const typed = line({ startingPrice: null, unitPrice: '500' });
    const generous = line({ discount: '12' });
    const cart = {
      ...cartOf(changed, typed, generous),
      billDiscountType: 'percent' as const,
      billDiscount: '10',
    };
    expect(overridesOf(cart, { maxDiscountPercent: '10.00' })).toEqual([
      { kind: 'price', line: 0 },
      { kind: 'discount', line: 2 },
    ]);
    expect(
      overridesOf({ ...cart, billDiscount: '10.5' }, { maxDiscountPercent: '10.00' }),
    ).toContainEqual({
      kind: 'bill_discount',
    });
  });
});

describe('fefoBatch', () => {
  const rows = [
    stock({ batchId: 'late', lotNumber: 'B', expiresOn: '2027-11-30' }),
    stock({ batchId: 'early', lotNumber: 'A', expiresOn: '2027-01-31' }),
    stock({ batchId: 'gone', lotNumber: 'C', expiresOn: '2026-10-01' }),
    stock({ batchId: 'empty', lotNumber: 'D', expiresOn: '2026-12-31', quantity: '0.0000' }),
  ];

  it('takes the first expiry with stock, never an expired batch', () => {
    expect(fefoBatch(rows, '2026-10-27', false)).toBe('early');
  });

  it('falls back to the batch that expires last only when the workspace sells below zero', () => {
    const empty = rows.map((row) => ({ ...row, quantity: '0.0000' }));
    expect(fefoBatch(empty, '2026-10-27', false)).toBeNull();
    expect(fefoBatch(empty, '2026-10-27', true)).toBe('late');
    expect(fefoBatch([], '2026-10-27', true)).toBeNull();
  });
});

describe('the payment', () => {
  it('offers the notes above the total, and says what is still to pay', () => {
    expect(quickCash('2300.0000')).toEqual(['2310', '2350', '2400', '2500']);
    expect(quickCash('47.5000')).toEqual(['50', '100', '500', '1000']);
    const rows = [
      { key: 'a', method: 'card' as const, amount: '1500', reference: '' },
      { key: 'b', method: 'cash' as const, amount: '50.', reference: '' },
    ];
    expect(dueOf(rows, '2300.0000')).toBe('800.0000');
    expect(dueOf([{ key: 'c', method: 'card', amount: '2500', reference: '' }], '2300.0000')).toBe(
      '0.0000',
    );
  });

  it('builds the sale the schema reads, walk-in, with empty boxes as the form has them', () => {
    const values = saleValues({
      cart: { ...cartOf(line({ quantity: '2' })), billDiscount: '' },
      registerId: REGISTER,
      date: '2026-10-27',
      soldAt: '2026-10-27T10:15:00.000Z',
      pricesIncludeVat: true,
      payments: [{ key: 'a', method: 'cash', amount: '1000', reference: '' }],
    });
    const parsed = posSaleInputSchema.parse({ ...values, sequence: 1 });
    expect(parsed).toMatchObject({ customerId: null, billDiscount: '0' });
    expect(parsed.payments[0]?.reference).toBeNull();
  });
});

describe('receiptOfCart', () => {
  it('prints lines that, less the bill discount, add up to the total', () => {
    // 2 bags at ৳420 with 5% off, 1 bag at ৳400, ৳20 off the bill, VAT in the price
    const cart = {
      ...cartOf(line({ quantity: '2', discount: '5' }), line({ unitPrice: '400.0000' })),
      billDiscount: '20',
    };
    const receipt = receiptOfCart({
      number: 'POS1-000124',
      soldAt: '2026-10-27T10:15:00.000Z',
      register: { code: 'POS1', paperWidth: '80', receiptFooter: null },
      cashier: 'Nusrat Jahan',
      cart,
      pricesIncludeVat: true,
      payments: [{ method: 'cash', amount: '1200', reference: null }],
      paid: '1200.0000',
      change: '2.0000',
    });
    expect(receipt.lines.map((item) => [item.discount, item.after])).toEqual([
      ['42.0000', '798.0000'],
      ['0.0000', '400.0000'],
    ]);
    expect(receipt).toMatchObject({
      billDiscount: '20.0000',
      total: '1178.0000',
      customerName: null,
    });
  });
});
```

- **The VAT in the totals test is `104.3500`, not `104.3478`:** `posSaleAmounts()` rounds each line's VAT to the paisa,
  like every sales document. The test pins that, so a change to the rounding shows up here first.
- **`shortLines` with a service line:** a service has no stock and is never short, whatever its quantity.
- **`receiptOfCart`:** a 5% discount on 2 bags at ৳420 is ৳42, the line prints ৳798, and the lines less the bill's ৳20
  are the total.

### `apps/app/src/lib/local-session.ts` and `session.ts`: letting go at sign-out

```diff
@@ -22,6 +22,7 @@ import {
   outboxCounts,
   type PushOutcome,
   readDevice,
+  readClaim,
   readPullState,
   renewServerKey,
   saveDevice,
@@ -30,6 +31,7 @@ import {
   SyncEngine,
   syncedAtOf,
   type Unlock,
+  waitingSales,
   watch,
 } from '@omnivo/sync';
 import { toast } from '@omnivo/ui';
@@ -732,6 +734,25 @@ async function revoke(session: Session): Promise<void> {
   await setUp(session);
 }
 
+// Step 20a (decision 14): signing out lets go of the register this device holds, so the next
+// cashier's device can take it. Only with no sale of it waiting in the outbox: the server must
+// receive every number before another device goes on from its last one. logout() calls this
+// before the server's session ends (the release needs it). No copy open (locked, not set up), no
+// connection, or a refusal: the register stays with this device, and the sign-out goes on. The
+// next sign-in on this browser is the same device and takes it back; a lost PC is revoked, which
+// frees it (20a.2).
+export async function releaseRegister(): Promise<void> {
+  const session = current;
+  const { device } = localDataStore.getState();
+  if (!session || device.kind !== 'ready') return;
+  const claim = await readClaim(device.copy);
+  if (!claim || (await waitingSales(device.copy)) > 0) return;
+  await call(routes.pos.releaseRegister, {
+    params: { id: claim.registerId },
+    body: { deviceId: session.identity.id },
+  });
+}
+
 // Step 18c (decision 2): this device to another branch, from its own list. Only with an empty
 // outbox: its commands were made for the old branch's warehouses, and the server cannot see them
 // to check. The dialog checked it already; this checks again, because another tab may have saved
```

```diff
@@ -149,6 +149,12 @@ export function signInAgain(): Promise<void> {
 
 export async function logout(): Promise<void> {
   const me = sessionStore.getState().me;
+  // Step 20a: the device lets go of its POS register first, while the session still works. The
+  // module is loaded already (the AppFrame's host brought it); a release that fails never stops
+  // the sign-out.
+  await import('./local-session')
+    .then(({ releaseRegister }) => releaseRegister())
+    .catch(() => undefined);
   try {
     await endSession();
   } finally {
```

- **Before `endSession()`:** the release is an API call, so it needs the session that the sign-out is about to end.
- **Only with an open copy, a claim and no sale waiting (decision 14):** the server must have received every number
  before another device goes on from its last one. "Sign out anyway" with sales waiting keeps the register on this
  device: those sales are lost with the copy, and their numbers may be on paper.
- **Every failure is swallowed:** no connection, a locked copy (no key, so no copy open) or a refusal must never stop
  a sign-out. The register stays with this device; the next sign-in on the same browser is the same device and takes
  it back with a claim, and a lost PC is revoked, which frees it in the database (20a.2).
- **`import('./local-session')` in `logout()`:** `session.ts` is in the first load, and `local-session.ts` brings Dexie.
  The AppFrame's host has loaded it already, so the import costs nothing at sign-out.

### `apps/app/src/routes/app-frame.tsx`: a page without the shell

```diff
@@ -1,4 +1,4 @@
-import { useNavigate } from '@tanstack/react-router';
+import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
 import { lazy, Suspense, useEffect } from 'react';
 
 import { askForPin, lockNow, useDeviceState, useKeyStatus } from '../lib/local-data';
@@ -21,8 +21,13 @@ const LocalDataHost = lazy(async () => ({
   default: (await import('../components/local-data-host')).LocalDataHost,
 }));
 
+// Step 20a: the pages drawn without the shell's sidebar and top bar. The POS screen has its own
+// slim bar, and a counter needs the whole screen for the products and the cart.
+const BARE_PATHS: ReadonlySet<string> = new Set(['/pos']);
+
 export function AppFrame() {
   const navigate = useNavigate();
+  const bare = useRouterState({ select: (state) => BARE_PATHS.has(state.location.pathname) });
   const status = useSession((state) => state.status);
   const openedOffline = useSession((state) => state.openedOffline);
   const device = useDeviceState();
@@ -54,7 +59,9 @@ export function AppFrame() {
 
   return (
     <>
-      <Suspense fallback={null}>{locked ? <LockScreen /> : <AppShell lock={lock} />}</Suspense>
+      <Suspense fallback={null}>
+        {locked ? <LockScreen /> : bare ? <Outlet /> : <AppShell lock={lock} />}
+      </Suspense>
       {/* No fallback: the host draws nothing until a dialog is needed */}
       <Suspense fallback={null}>
         <LocalDataHost />
```

- **The route and the sidebar link** are shown in 20a.6b, together with the routes of the other POS pages: they change
  the same lines of `router.tsx` and `app-shell.tsx`, so one diff of each shows them all.
- **`BARE_PATHS` in the AppFrame:** the shell is the AppFrame's child, so the frame decides. For `/pos` it draws the
  route's page (`<Outlet />`) without the sidebar and top bar. The lock screen still wins: a locked device shows the
  lock screen, never the POS. A set and the path, not a flag on the route: the frame is the only place that reads it.

### `apps/app/src/routes/pos.tsx` (new): the page, its bar and the register

```tsx
import {
  ArrowLeft01Icon,
  ArrowLeftRightIcon,
  CashierIcon,
  KeyboardIcon,
  Wifi01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  formatPosNumber,
  routes,
  type SyncPosRegister,
  type SyncSettings,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  allRows,
  dropClaim,
  type LocalCopy,
  localRegisters,
  readClaim,
  type RegisterClaim,
  waitingSales,
} from '@omnivo/sync';
import { cn, EmptyState, IconButton, Logo, Pill, toast } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { LocalState, SyncNotice } from '../components/local-state';
import { PosScreen } from '../components/pos-screen';
import { ApiRequestError, call } from '../lib/api';
import { useLocalData, useLocalQuery, useThisDeviceId } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';
import { useSyncSummary } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';

// Step 20a: the POS screen (decision 12). The AppFrame draws it without the shell: a slim bar on
// top, then the register this device sells on, then the products and the cart (pos-screen.tsx).
// Everything it sells from is the device's copy, so it works the same with or without a
// connection; only taking or changing a register needs one.

// "Which counter is this?": once per device, online, so in a chunk of its own (with the server
// query it needs), and the selling screen's chunk stays in its budget
const RegisterChooser = lazy(async () => ({
  default: (await import('../components/pos-register')).RegisterChooser,
}));

// Module level, so they are stable for useLocalQuery (a new function is a new read)
async function readSettings(copy: LocalCopy): Promise<SyncSettings | null> {
  const [settings] = await allRows(copy, copy.db.settings);
  return settings ?? null;
}

// The register the device sells on: the one its claim names, as the copy has it. A row that says
// another device holds it means the register was taken from this device (a revoke or a move frees
// it, 20a.2, and someone else took it), so the claim no longer counts. A row with no holder is
// this device's claim before the next pull brings the holder.
function heldRegister(
  registers: readonly SyncPosRegister[],
  claim: RegisterClaim | null,
  deviceId: string | null,
): SyncPosRegister | null {
  if (!claim) return null;
  const register = registers.find((row) => row.id === claim.registerId);
  return register && (register.deviceId === null || register.deviceId === deviceId)
    ? register
    : null;
}

export function PosPage() {
  const { t } = useLocale();
  const can = useCan();
  const deviceId = useThisDeviceId();
  const { view, notice } = useLocalData();
  const ready = view.kind === 'ready';
  const registers = useLocalQuery(ready ? localRegisters : null);
  const claim = useLocalQuery(ready ? readClaim : null);
  const settings = useLocalQuery(ready ? readSettings : null);
  const [shortcuts, setShortcuts] = useState(false);

  const register =
    registers && claim !== undefined ? heldRegister(registers, claim, deviceId) : undefined;

  const content = () => {
    if (view.kind !== 'ready') return <LocalState view={view} />;
    // Still reading the copy: a moment, nothing to draw
    if (registers === undefined || register === undefined || settings === undefined) return null;
    if (!can('pos.sale.create')) {
      return (
        <EmptyState icon={CashierIcon} title={t('pos.title')} description={t('pos.cantSell')} />
      );
    }
    if (registers.length === 0) {
      return (
        <EmptyState
          icon={CashierIcon}
          title={t('pos.noRegistersTitle')}
          description={t('pos.noRegistersBody')}
        />
      );
    }
    if (!register || !claim || !settings) {
      return (
        <Suspense fallback={null}>
          <RegisterChooser copy={view.copy} registers={registers} />
        </Suspense>
      );
    }
    return (
      <PosScreen
        copy={view.copy}
        register={register}
        settings={settings}
        shortcuts={shortcuts}
        onShortcuts={setShortcuts}
      />
    );
  };

  return (
    // h-dvh and a column: the bar stays, the screen below takes the rest and scrolls inside its
    // own parts, never the page (a phone's address bar comes and goes: dvh follows it)
    <div className="flex h-dvh flex-col bg-bg text-ink">
      <PosTopBar
        copy={view.kind === 'ready' ? view.copy : null}
        register={register ?? null}
        claim={claim ?? null}
        onShortcuts={
          register
            ? () => {
                setShortcuts(true);
              }
            : undefined
        }
      />
      {notice && (
        <div className="px-4 pt-3">
          <SyncNotice code={notice} />
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col">
        {view.kind === 'ready' && register && claim && settings ? (
          content()
        ) : (
          <div className="grid flex-1 place-items-center overflow-y-auto p-4">{content()}</div>
        )}
      </main>
    </div>
  );
}

// The bar: the logo, the register and who sells, the next number, the sync line and the way out.
// On a phone only what fits: the register's code, the sync icon and the exit icon.
function PosTopBar({
  copy,
  register,
  claim,
  onShortcuts,
}: {
  copy: LocalCopy | null;
  register: SyncPosRegister | null;
  claim: RegisterClaim | null;
  onShortcuts: (() => void) | undefined;
}) {
  const { t } = useLocale();
  const cashier = useSession((state) => state.me?.user.fullName) ?? '';
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 print:hidden">
      <Logo />
      <Pill tone="brand" icon={CashierIcon}>
        {t('pos.title')}
      </Pill>
      {register && claim && copy && (
        <>
          <span aria-hidden="true" className="h-6 w-px bg-line max-sm:hidden" />
          <ChangeRegister copy={copy} register={register} />
          <span className="text-body-sm text-ink-2 max-lg:hidden">
            {t('pos.cashier', { name: cashier })}
          </span>
          <span className="text-body-sm text-ink-3 tabular-nums max-md:hidden">
            {t('pos.nextNumber', { number: formatPosNumber(register.code, claim.last + 1) })}
          </span>
        </>
      )}
      <span className="flex-1" />
      <PosSyncLink />
      {onShortcuts && (
        <IconButton
          icon={KeyboardIcon}
          label={t('pos.shortcuts')}
          onClick={onShortcuts}
          className="max-md:hidden"
        />
      )}
      <Link
        to="/"
        aria-label={t('pos.exit')}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle hover:text-ink"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={18} strokeWidth={1.5} />
        <span className="max-sm:hidden">{t('pos.exit')}</span>
      </Link>
    </header>
  );
}

// The register's name, and the way to let it go (decision 14). Only online, and only with no sale
// of it waiting on the device: the server must have every number before another device goes on
// from its last one. The claim goes after the server let go, so the chooser comes back.
function ChangeRegister({ copy, register }: { copy: LocalCopy; register: SyncPosRegister }) {
  const { t, errorText } = useLocale();
  const online = useOnline();
  const deviceId = useThisDeviceId();
  const [busy, setBusy] = useState(false);
  const change = async () => {
    if (!deviceId) return;
    if ((await waitingSales(copy)) > 0) {
      toast(t('pos.changeRegisterWaiting', { code: register.code }));
      return;
    }
    if (!online) {
      toast(t('pos.chooseOffline'));
      return;
    }
    setBusy(true);
    try {
      await call(routes.pos.releaseRegister, {
        params: { id: register.id },
        body: { deviceId },
      });
      await dropClaim(copy);
    } catch (error) {
      toast(errorText(error instanceof ApiRequestError ? error.code : 'unknown_error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void change()}
      title={t('pos.changeRegister')}
      className="inline-flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-body-sm font-medium transition-colors duration-150 hover:bg-subtle"
    >
      <span className="truncate">
        <span className="sm:hidden">{register.code}</span>
        <span className="max-sm:hidden">
          {t('pos.register', { code: register.code, name: register.name })}
        </span>
      </span>
      <HugeiconsIcon
        icon={ArrowLeftRightIcon}
        size={16}
        strokeWidth={1.5}
        className="shrink-0 text-ink-3"
      />
      <span className="sr-only">{t('pos.changeRegister')}</span>
    </button>
  );
}

// The sidebar's sync line, small: online or not, and the changes waiting (a refused one in crit).
// It links to the Sync page, which opens in the shell; the browser's Back comes back here.
function PosSyncLink() {
  const { t, format } = useLocale();
  const online = useOnline();
  const { syncing, waiting, failed } = useSyncSummary();
  const state = !online ? t('sync.offline') : syncing ? t('sync.syncing') : t('sync.online');
  const count = failed > 0 ? failed : waiting;
  const counted =
    failed > 0
      ? t('sync.needsAttention', { count: failed, formatted: format.number(failed) })
      : waiting > 0
        ? t('sync.waiting', { count: waiting, formatted: format.number(waiting) })
        : t('sync.allSynced');
  return (
    <Link
      to="/sync"
      aria-label={`${t('nav.sync')}: ${state}, ${counted}`}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle"
    >
      <HugeiconsIcon
        icon={online ? Wifi01Icon : WifiDisconnected02Icon}
        size={18}
        strokeWidth={1.5}
        className="text-ink-3"
      />
      <span className="max-sm:hidden">{state}</span>
      {count > 0 && (
        <span
          className={cn(
            'text-caption text-ink-3 tabular-nums',
            failed > 0 && 'font-medium text-crit',
          )}
        >
          {format.number(count)}
        </span>
      )}
    </Link>
  );
}
```

- **What it shows, in order:** the copy's own state while it is not ready (`LocalState`: not set up, copying, …), then
  a sentence for someone without `pos.sale.create`, then "No register in this branch", then the chooser, then the
  screen. Each case says what to do next, so nobody sits at an empty screen.
- **`heldRegister()`:** the claim names the register; the copy's row says who holds it. A row naming *another* device
  means the register was taken from this one (a move or a revoke frees it in the database, and someone else took
  it), so the claim no longer counts. A row with no holder is this device's own claim before the next pull brings the
  holder, so it counts.
- **`h-dvh` and a column:** the bar stays; the products and the cart scroll inside their own parts, never the page. A
  phone's address bar comes and goes, and `dvh` follows it.
- **The register chooser is lazy:** it is needed once per device, online, and it brings a server query. Out of the
  screen's chunk, the selling screen stays in its budget.
- **`ChangeRegister`:** only online (the server must agree) and only with no sale waiting (decision 14); the claim on
  the device goes after the server let go, so the chooser comes back. Each refusal is a toast that says why.
- **`PosSyncLink`:** the sidebar's sync line, small, because the POS has no sidebar. The cashier still sees offline and
  "3 waiting", and the link opens the Sync page in the shell; the browser's Back comes back.

### `apps/app/src/components/pos-register.tsx` (new): "Which counter is this?"

```tsx
import { CashierIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { formatPosNumber, routes, type SyncPosRegister } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { keepClaim, type LocalCopy } from '@omnivo/sync';
import { Button, Card, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { requestSync, useThisDeviceId } from '../lib/local-data';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';
import { DocumentNotice } from './document-notice';

// Step 20a (decision 14): "Which counter is this?". The device takes a register once, online: the
// server says which ones are free and gives the last number, and the device counts on from it.
// The list comes from the server, not the copy: who holds a register changes at the counter next
// door, and the copy hears of it only at its next pull. The copy's registers say only which branch
// to ask for (a device sees its own branch's).
export function RegisterChooser({
  copy,
  registers,
}: {
  copy: LocalCopy;
  registers: readonly SyncPosRegister[];
}) {
  const { t } = useLocale();
  const online = useOnline();
  const deviceId = useThisDeviceId();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const branchId = registers[0]?.branchId;
  const list = useQuery({
    queryKey: ['pos-registers', tenantId, branchId],
    queryFn: () => call(routes.pos.listRegisters, { query: { status: 'active', branchId } }),
    enabled: online && branchId !== undefined,
  });
  // The one the server says this device holds already (the claim was lost): picked at once
  const held = list.data?.items.find(
    (item) => item.deviceId !== null && item.deviceId === deviceId,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? held?.id ?? '';
  // An error code: FormAlert says it in the page's language
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Starts empty, like the branch dialog: a counter is picked on purpose, never by default. A
  // register another device holds stays in the list, named with that device, so the cashier sees
  // why it cannot be taken (the claim says pos_register_in_use).
  const options = [
    { value: '', label: t('pos.choosePlaceholder') },
    ...(list.data?.items ?? []).map((item) => ({
      value: item.id,
      label:
        item.holder && item.deviceId !== deviceId
          ? t('pos.heldBy', { code: item.code, device: item.holder.deviceName })
          : t('pos.register', { code: item.code, name: item.name }),
    })),
  ];

  const choose = async () => {
    if (!deviceId || value === '') return;
    setBusy(true);
    setError(null);
    try {
      const claimed = await call(routes.pos.claimRegister, {
        params: { id: value },
        body: { deviceId },
      });
      const claim = await keepClaim(copy, claimed);
      // The next pull brings the register with this device as its holder
      requestSync();
      toast(
        t('pos.claimed', {
          code: claimed.code,
          number: formatPosNumber(claimed.code, claim.last + 1),
        }),
      );
    } catch (failure) {
      setError(failure instanceof ApiRequestError ? failure.code : 'unknown_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-[440px] p-6 max-sm:p-[18px]">
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void choose();
        }}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={CashierIcon} size={20} strokeWidth={1.5} />
          </span>
          <div className="grid gap-1">
            <h1 className="text-h3 font-semibold text-balance">{t('pos.chooseTitle')}</h1>
            <p className="text-label text-ink-3">{t('pos.chooseDescription')}</p>
          </div>
        </div>
        {error && <FormAlert message={error} />}
        {online ? (
          <SelectField
            id="pos-register"
            label={t('pos.chooseLabel')}
            options={options}
            value={value}
            onChange={(event) => {
              setPicked(event.target.value);
            }}
          />
        ) : (
          <DocumentNotice tone="neutral" icon={WifiDisconnected02Icon}>
            {t('pos.chooseOffline')}
          </DocumentNotice>
        )}
        <Button type="submit" disabled={!online || value === '' || busy}>
          {t('pos.choose')}
        </Button>
      </form>
    </Card>
  );
}
```

- **The server's list, not the copy's:** who holds a register changes at the counter next door, and the copy hears of
  it only at its next pull. The server's list also has the holder's device name (`heldBy`), which the copy does not
  keep. The copy's registers give only the branch to ask for.
- **The select starts empty:** a counter is picked on purpose, like the device's branch (18c). The one the server says
  this device holds already is picked at once: the claim was lost (a reload with a new copy), and taking it back is
  the obvious next step.
- **A register held by another device stays in the list,** named with that device, so the cashier sees why the claim
  fails (`pos_register_in_use`, whose words say to sign out there or revoke a lost PC).
- **`requestSync()` after the claim:** the next pull brings the register with this device as its holder.

### `apps/app/src/components/pos-parts.tsx` (new)

```tsx
import type { SyncSettings } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';

import type { ReceiptCompany } from '../lib/pos';

// Step 20a: the small pieces the POS screen's chunks share. Here, not in pos-screen.tsx: the pay
// dialog's chunk (lazy) imports them, and importing them from the screen would tie the two chunks
// to each other.

// A whole amount shows without paisa (৳420); one with paisa shows them (৳247.50). The receipt
// always shows 2 decimals: it is a document the customer keeps.
export function hasPaisa(value: string): boolean {
  const [, fraction = ''] = value.split('.');
  return /[1-9]/.test(fraction.slice(0, 2));
}

// A key's name next to what it does (decision 12). Hidden on a phone, which has no F keys.
export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-[5px] border border-line-strong bg-subtle px-1.5 font-mono text-caption text-ink-3 max-[860px]:hidden">
      {children}
    </kbd>
  );
}

type CompanySettings = Pick<
  SyncSettings,
  'companyName' | 'legalName' | 'address' | 'bin' | 'phone' | 'timezone'
>;

export function useReceiptCompany(settings: CompanySettings): ReceiptCompany {
  const { t } = useLocale();
  return {
    name: settings.legalName ?? settings.companyName,
    lines: [
      ...(settings.address?.split('\n') ?? []),
      ...(settings.bin === null ? [] : [t('print.bin', { bin: settings.bin })]),
      ...(settings.phone === null ? [] : [t('print.phone', { phone: settings.phone })]),
    ],
    timeZone: settings.timezone,
  };
}
```

- **Its own file:** the cart, the screen and the lazy pay chunk all use these two. If the pay chunk imported them from
  the screen's file, the two chunks would be tied to each other.
- **`useReceiptCompany()`:** the company at the top of the receipt, like `useCompany()` for the A4 documents: the legal
  name, the address line by line, the BIN and the phone. The screen gives it the device's copy of the settings (it
  prints offline); 20a.6b's sale page gives it the server's. Here, not in the lazy receipt module, for the same reason as
  the types.
- **`hasPaisa()`:** whole taka shows as `৳420`, an amount with paisa as `৳247.50`. CLAUDE.md shows money without
  decimals except prices; at a counter a line can have paisa (5% off ৳260), and hiding them would make the lines not
  add up on the screen. The receipt always shows 2 decimals: it is a document.

### `apps/app/src/components/pos-screen.tsx` (new): the products and the keys

```tsx
import { Search01Icon } from '@hugeicons/core-free-icons';
import {
  compareQuantity,
  type Product,
  type ProductVariant,
  SYNC_BLOCK_AFTER_DAYS,
  type SyncPosRegister,
  type SyncSettings,
  type TaxRate,
  todayIn,
  type Unit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  allRows,
  type LocalCopy,
  lookUpPrices,
  productByBarcode,
  productPage,
  stockOf,
} from '@omnivo/sync';
import { cn, Input } from '@omnivo/ui';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useLocalQuery } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import {
  addToCart,
  type Cart,
  cartAmounts,
  type CartLine,
  changeLine,
  EMPTY_CART,
  fefoBatch,
  itemName,
  lineReady,
  newLineKey,
  onHandOf,
  overridesOf,
  removeLine,
  shortLines,
} from '../lib/pos';
import { useSession } from '../lib/session-store';
import { useSyncAge } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';
import { DocumentNotice } from './document-notice';
import { PosCart } from './pos-cart';
import { hasPaisa, Kbd, useReceiptCompany } from './pos-parts';
import type { DoneSale } from './pos-pay';

// The payment, the done dialog, the shortcuts and the receipt: a chunk of their own, loaded the
// first time one opens (the screen's chunk stays in its budget). Offline too: the service worker
// keeps every chunk (step 19a).
const PayDialog = lazy(async () => ({ default: (await import('./pos-pay')).PayDialog }));
const DoneDialog = lazy(async () => ({ default: (await import('./pos-pay')).DoneDialog }));
const ShortcutsDialog = lazy(async () => ({
  default: (await import('./pos-pay')).ShortcutsDialog,
}));
const PosReceipt = lazy(async () => ({ default: (await import('./pos-receipt')).PosReceipt }));

// Step 20a (decision 12): the products on the left, the cart on the right; on a phone the products
// alone, with the cart as a bar at the bottom that opens over them. A whole sale works from the
// keyboard: a scanner types the barcode and Enter into the search box, which has the focus.

// How many tiles at once: two screens of a desktop's grid. A search narrows them; nobody scrolls
// through 10,000 products at a counter.
const TILE_LIMIT = 48;

async function readRates(copy: LocalCopy): Promise<TaxRate[]> {
  return allRows(copy, copy.db.taxRates);
}

async function readUnits(copy: LocalCopy): Promise<Unit[]> {
  return allRows(copy, copy.db.units);
}

// One tile: a variant of a product. Archived variants are not sold (the server keeps them for old
// documents only).
interface Tile {
  product: Product;
  variant: ProductVariant;
}

function tilesOf(products: readonly Product[]): Tile[] {
  return products
    .flatMap((product) =>
      product.variants
        .filter((variant) => variant.archivedAt === null)
        .map((variant) => ({ product, variant })),
    )
    .slice(0, TILE_LIMIT);
}

// A key press inside a box is typing, not a shortcut ("?" in a reference)
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function PosScreen({
  copy,
  register,
  settings,
  shortcuts,
  onShortcuts,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  settings: SyncSettings;
  shortcuts: boolean;
  onShortcuts: (open: boolean) => void;
}) {
  const { t, format, errorText } = useLocale();
  const can = useCan();
  const online = useOnline();
  const age = useSyncAge();
  const cashier = useSession((state) => state.me?.user.fullName) ?? '';
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search);
  // What the last scan or Enter found nothing for, said under the box
  const [message, setMessage] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [selected, setSelected] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<DoneSale | null>(null);
  // A phone: the cart over the products
  const [cartOpen, setCartOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLButtonElement>(null);
  const billDiscountRef = useRef<HTMLInputElement>(null);

  const today = todayIn(settings.timezone);
  // The company on the receipt, from the device's copy of the settings (it prints offline)
  const company = useReceiptCompany(settings);
  const { allowNegativeStock, pricesIncludeVat } = settings;
  // Decision 11: without the permission the boxes say so, and Pay waits
  const canOverride = can('pos.price.override');
  // Step 18c's limit: offline more than 7 days after the last sync, no new work on this device
  const blocked = !online && age?.age === 'blocked';

  const findTiles = useCallback(
    async (open: LocalCopy) =>
      tilesOf(
        (
          await productPage(open, {
            search: deferred,
            categoryIds: null,
            sort: 'name',
            limit: TILE_LIMIT,
          })
        ).rows,
      ),
    [deferred],
  );
  const tiles = useLocalQuery(findTiles);
  const rates = useLocalQuery(readRates);
  const units = useLocalQuery(readUnits);

  // The stock of what is on the screen: the tiles and the cart. One read, again when either
  // changes or a pull writes stock. The ids as one sorted string, so the same set is the same read.
  const variantIds = useMemo(
    () =>
      [
        ...new Set([
          ...(tiles ?? []).map((tile) => tile.variant.id),
          ...cart.lines.map((line) => line.variantId),
        ]),
      ]
        .sort()
        .join(','),
    [tiles, cart.lines],
  );
  const readStock = useCallback(
    (open: LocalCopy) =>
      stockOf(open, register.warehouseId, variantIds === '' ? [] : variantIds.split(',')),
    [register.warehouseId, variantIds],
  );
  const stock = useLocalQuery(readStock);

  const amounts = useMemo(() => cartAmounts(cart, pricesIncludeVat), [cart, pricesIncludeVat]);
  const short = useMemo(
    () => shortLines(cart, stock ?? [], allowNegativeStock),
    [cart, stock, allowNegativeStock],
  );
  const overrides = useMemo(
    () => (canOverride ? [] : overridesOf(cart, register)),
    [cart, register, canOverride],
  );

  const payable =
    cart.lines.length > 0 &&
    cart.lines.every(lineReady) &&
    short.size === 0 &&
    overrides.length === 0 &&
    !blocked;

  // A tile's click, a scan or Enter: the line with its price, VAT rate and batch, from the copy.
  // The price as the customer's price list has it now (lookUpPrices, step 18b).
  const add = async (product: Product, variant: ProductVariant, unitId: string) => {
    setMessage(null);
    const [price] = await lookUpPrices(copy, cart.customer?.priceListId ?? null, [
      { variantId: variant.id, unitId },
    ]);
    // No VAT rate at all: a workspace whose rates are not set up yet
    if (!price) {
      setMessage(errorText('tax_rate_invalid'));
      return;
    }
    const goods = product.type === 'goods';
    const batched = goods && product.tracking === 'batch';
    const rows = batched ? await stockOf(copy, register.warehouseId, [variant.id]) : [];
    const batchId = batched ? fefoBatch(rows, today, allowNegativeStock) : null;
    if (batched && batchId === null) {
      setMessage(t('pos.noStock'));
      return;
    }
    const unit = units?.find((one) => one.id === unitId);
    const line: CartLine = {
      key: newLineKey(),
      productId: product.id,
      variantId: variant.id,
      unitId,
      factor:
        unitId === product.baseUnitId
          ? '1'
          : (product.units.find((pack) => pack.unitId === unitId)?.factor ?? '1'),
      name: itemName(product, variant),
      sku: variant.sku,
      unitCode: unit?.code ?? '',
      decimals: unit?.decimals ?? 0,
      tracking: product.tracking,
      goods,
      quantity: '1',
      unitPrice: price.price ?? '',
      startingPrice: price.price,
      discountType: 'percent',
      discount: '0',
      taxRateId: price.taxRateId,
      rate: rates?.find((rate) => rate.id === price.taxRateId)?.rate ?? '0',
      batchId,
      serialNumbers: [],
    };
    setCart((current) => addToCart(current, line));
    // A serial item opens at once: the next scan is its serial number
    setSelected(line.tracking === 'serial' ? line.key : null);
  };

  // The sales unit a tile adds: the one the product's sales forms start with, else the base unit
  const addTile = (tile: Tile) =>
    void add(tile.product, tile.variant, tile.product.salesUnitId ?? tile.product.baseUnitId);

  // Enter in the search box. A scanner's barcode first: a variant's (one base unit) or a pack's
  // (a product without variants has its packs' barcodes). Else the only tile that matches, like the
  // "Add items" dialog. The box empties after a hit, ready for the next scan.
  const enter = async () => {
    const typed = search.trim();
    if (typed === '') return;
    const product = await productByBarcode(copy, typed);
    if (product) {
      const variant = product.variants.find((one) => one.barcode === typed);
      const pack = product.units.find((one) => one.barcode === typed);
      const target = variant ?? product.variants.find((one) => one.archivedAt === null);
      if (target) {
        await add(
          product,
          target,
          variant ? product.baseUnitId : (pack?.unitId ?? product.baseUnitId),
        );
        setSearch('');
        return;
      }
    }
    const [only, ...more] = tiles ?? [];
    if (only && more.length === 0) {
      addTile(only);
      setSearch('');
      return;
    }
    if (!tiles?.length) {
      setMessage(
        /^\d+$/.test(typed)
          ? t('pos.noBarcode', { code: typed })
          : t('pos.noMatch', { query: typed }),
      );
    }
  };

  // The shortcuts (decision 12). Not while a dialog is open: it has its own keys (Enter completes
  // the sale, or starts the next one). F12 opens the browser's tools in some browsers; the page
  // asks first, and Chrome lets it.
  useEffect(() => {
    if (paying || done || shortcuts) return;
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'F2':
          event.preventDefault();
          searchRef.current?.focus();
          break;
        case 'F4':
          event.preventDefault();
          customerRef.current?.click();
          break;
        case 'F7':
          event.preventDefault();
          billDiscountRef.current?.focus();
          break;
        case 'F12':
          event.preventDefault();
          if (payable) setPaying(true);
          break;
        case '?':
          if (isTyping(event.target)) return;
          event.preventDefault();
          onShortcuts(true);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [paying, done, shortcuts, payable, onShortcuts]);

  const newSale = () => {
    setDone(null);
    setCartOpen(false);
    searchRef.current?.focus();
  };

  return (
    <div className="grid min-h-0 flex-1 min-[860px]:grid-cols-[minmax(0,1fr)_400px] print:hidden">
      <section className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pb-24 min-[860px]:p-6">
        {blocked && (
          <DocumentNotice tone="warn">
            {t('sync.blockedFormNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })}
          </DocumentNotice>
        )}
        <label className="grid gap-1.5">
          <span className="text-label font-medium">{t('pos.search')}</span>
          <Input
            ref={searchRef}
            icon={Search01Icon}
            type="search"
            // The focus starts here: a scanner types into whatever has it
            autoFocus
            autoComplete="off"
            enterKeyHint="search"
            placeholder={t('pos.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setMessage(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void enter();
              }
            }}
            trailing={<Kbd>F2</Kbd>}
          />
          <span role="status" className="text-label text-ink-3">
            {message}
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
          {(tiles ?? []).map((tile) => {
            const goods = tile.product.type === 'goods';
            const onHand = onHandOf(stock ?? [], tile.variant.id);
            const out = goods && !allowNegativeStock && compareQuantity(onHand, '0') <= 0;
            const unit = units?.find((one) => one.id === tile.product.baseUnitId);
            return (
              <button
                key={tile.variant.id}
                type="button"
                disabled={out}
                onClick={() => {
                  addTile(tile);
                }}
                className={cn(
                  'flex min-h-[104px] flex-col gap-1 rounded-control border border-line bg-surface p-3 text-left shadow-sm transition-colors duration-150 hover:border-ink-3',
                  'disabled:border-line disabled:bg-subtle disabled:shadow-none',
                )}
              >
                <span className="line-clamp-2 text-body-sm font-medium text-ink">
                  {itemName(tile.product, tile.variant)}
                </span>
                <span className="font-mono text-caption text-ink-3">{tile.variant.sku}</span>
                <span className="mt-auto flex items-baseline justify-between gap-2">
                  <span className="text-body-sm font-semibold tabular-nums">
                    {tile.variant.salePrice === null
                      ? '—'
                      : format.money(tile.variant.salePrice, {
                          decimals: hasPaisa(tile.variant.salePrice) ? 2 : 0,
                        })}
                  </span>
                  {goods && (
                    <span
                      className={cn('text-caption tabular-nums', out ? 'text-ink-3' : 'text-ink-2')}
                    >
                      {out
                        ? t('pos.outOfStock')
                        : `${format.number(onHand, unit?.decimals ?? 0)} ${unit?.code ?? ''}`}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <PosCart
        register={register}
        cart={cart}
        amounts={amounts}
        stock={stock ?? []}
        today={today}
        pricesIncludeVat={pricesIncludeVat}
        selected={selected}
        onSelect={setSelected}
        onCart={setCart}
        onLine={(key, change) => {
          setCart((current) => changeLine(current, key, change));
        }}
        onRemove={(key) => {
          setCart((current) => removeLine(current, key));
        }}
        short={short}
        overrides={overrides}
        canOverride={canOverride}
        payable={payable}
        onPay={() => {
          setPaying(true);
        }}
        open={cartOpen}
        onOpen={setCartOpen}
        customerRef={customerRef}
        billDiscountRef={billDiscountRef}
      />
      <Suspense fallback={null}>
        {paying && (
          <PayDialog
            copy={copy}
            register={register}
            cart={cart}
            total={amounts.totals.total}
            date={today}
            pricesIncludeVat={pricesIncludeVat}
            cashier={cashier}
            onClose={() => {
              setPaying(false);
            }}
            onDone={(sale: DoneSale) => {
              setPaying(false);
              setCart(EMPTY_CART);
              setSelected(null);
              setDone(sale);
            }}
          />
        )}
        {done && (
          <>
            <DoneDialog
              sale={done}
              offline={!online}
              onPrint={() => {
                window.print();
              }}
              onNew={newSale}
            />
            <PosReceipt receipt={done.receipt} company={company} printOnMount />
          </>
        )}
        {shortcuts && (
          <ShortcutsDialog
            onClose={() => {
              onShortcuts(false);
            }}
          />
        )}
      </Suspense>
    </div>
  );
}
```

- **A tile per active variant, the first 48 of the search:** the in-memory copy (19b) searches name, code, SKU and
  barcode at once (`productPage()`), so typing narrows the tiles at once. Nobody scrolls through 10,000 products at a
  counter; 48 is about two screens of a desktop's grid.
- **`useDeferredValue(search)`:** the box answers each key at once, and the tiles follow a moment later, so a fast
  typist or a scanner is never slowed by the grid.
- **One stock read for the tiles and the cart:** the ids are joined in sorted order into one string, so the same set
  of variants is the same read, and a pull that writes stock refreshes it by itself (`useLocalQuery`).
- **`add()` reads the price from the copy (`lookUpPrices()`, 18b):** the chosen customer's price list, else the
  product's price, in the unit added, with the VAT rate the product has now. No price is a line the cashier prices;
  no VAT rate at all (a workspace not set up) stops with the rate's own error.
- **The batch is chosen when the line is added (`fefoBatch()`), from a fresh read** of that variant's stock, not from
  the tiles' read, which may be a moment old.
- **The tile adds the sales unit** (`salesUnitId`, else the base unit): the unit the product's sales forms start with.
- **Enter in the search box:** a scanner types the barcode and Enter. A variant's barcode adds one base unit; a pack's
  barcode (only products without variants have them) adds one pack. Not a barcode: the only tile that matches, like
  the "Add items" dialog. The box empties after a hit, ready for the next scan. Nothing found: a status line under
  the box, "No product has the barcode …" for digits, else "No active product matches …".
- **The keys (decision 12) on `window`,** and not while a dialog is open: the pay dialog's Enter completes the sale,
  the done dialog's Enter starts the next one. `?` only outside a box, so it can still be typed in a reference.
  `preventDefault()` keeps F2 to F12 from the browser (F12 opens the developer tools; Chrome lets a page take it).
- **The pay, done, shortcuts and receipt parts are lazy:** a chunk of their own, loaded the first time one opens.
  Offline too: the service worker keeps every chunk (19a). The mock mode's list of offline screens gets them in 20a.7.
- **Offline more than 7 days after the last sync (18c):** the same `warn` notice as the order form, and Pay is off.
  The sales already waiting still go when the connection is back.

### `apps/app/src/components/pos-cart.tsx` (new): the cart

```tsx
import {
  Alert02Icon,
  ArrowLeft01Icon,
  Delete02Icon,
  MinusSignIcon,
  PlusSignIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addQuantity,
  compareQuantity,
  isQuantity,
  isZeroMoney,
  type PosOverride,
  subtractQuantity,
  type SyncPosRegister,
  type SyncStock,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { findCustomers, type LocalCopy } from '@omnivo/sync';
import {
  Button,
  cn,
  Combobox,
  type ComboboxOption,
  DiscountInput,
  Field,
  IconButton,
  Input,
  MoneyInput,
  parseIsoDate,
  Select,
} from '@omnivo/ui';
import { type ReactNode, type Ref, useCallback, useDeferredValue, useState } from 'react';

import { useLocalQuery } from '../lib/local-data';
import { type Cart, type CartAmounts, type CartLine, EMPTY_CART } from '../lib/pos';
import { hasPaisa, Kbd } from './pos-parts';
import { SerialNumbersInput } from './serial-numbers-input';

// Step 20a: the cart (decision 12). A line folds to one row (name, amount, a −/+ stepper, its price
// and unit); the line picked opens its boxes: quantity, price, discount, batch, serial numbers.
// Under the lines, the totals on `subtle` and the Pay button. On a phone the cart is a bar at the
// bottom (the item count, the total, Pay) and opens over the products.

interface PosCartProps {
  register: SyncPosRegister;
  cart: Cart;
  amounts: CartAmounts;
  stock: readonly SyncStock[];
  today: string;
  pricesIncludeVat: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onCart: (update: (cart: Cart) => Cart) => void;
  onLine: (key: string, change: Partial<CartLine>) => void;
  onRemove: (key: string) => void;
  // shortLines(): the line's key → what the warehouse has of its variant
  short: ReadonlyMap<string, string>;
  // overridesOf(); empty for someone with pos.price.override
  overrides: readonly PosOverride[];
  canOverride: boolean;
  payable: boolean;
  onPay: () => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  customerRef: Ref<HTMLButtonElement>;
  billDiscountRef: Ref<HTMLInputElement>;
}

// Money on the screen: whole taka unless it has paisa (hasPaisa)
function useScreenMoney(): (value: string) => string {
  const { format } = useLocale();
  return (value) => format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// Destructured whole: the React compiler's lint takes any read of the props object in the markup
// for a ref read, because two of the props are refs
export function PosCart({
  register,
  cart,
  amounts,
  stock,
  pricesIncludeVat,
  selected,
  onSelect,
  onCart,
  onLine,
  onRemove,
  short,
  overrides,
  canOverride,
  payable,
  onPay,
  open,
  onOpen,
  customerRef,
  billDiscountRef,
}: PosCartProps) {
  const { t, format } = useLocale();
  const money = useScreenMoney();
  const total = amounts.totals.total;
  const count = t('pos.itemCount', {
    count: cart.lines.length,
    formatted: format.number(cart.lines.length),
  });
  const billOver = overrides.some((override) => override.kind === 'bill_discount');

  return (
    <>
      <aside
        aria-label={t('pos.cart')}
        className={cn(
          'flex min-h-0 flex-col border-line bg-surface min-[860px]:border-l',
          // A phone: hidden until the bar opens it, then over the products, under the top bar
          open
            ? 'max-[860px]:fixed max-[860px]:inset-x-0 max-[860px]:top-14 max-[860px]:bottom-0 max-[860px]:z-30'
            : 'max-[860px]:hidden',
        )}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <IconButton
            icon={ArrowLeft01Icon}
            label={t('common.close')}
            className="min-[860px]:hidden"
            onClick={() => {
              onOpen(false);
            }}
          />
          <h2 className="text-h3 font-semibold">{t('pos.cart')}</h2>
          <span className="text-caption text-ink-3 tabular-nums">{count}</span>
          <span className="flex-1" />
          <IconButton
            icon={Delete02Icon}
            label={t('pos.clear')}
            disabled={cart.lines.length === 0}
            onClick={() => {
              onCart(() => EMPTY_CART);
              onSelect(null);
            }}
          />
        </div>
        <div className="border-b border-line px-4 py-3">
          <CustomerBox cart={cart} onCart={onCart} buttonRef={customerRef} />
        </div>
        {cart.lines.length === 0 ? (
          <div className="grid flex-1 place-content-center gap-1 p-6 text-center">
            <p className="text-h3 font-semibold">{t('pos.cartEmptyTitle')}</p>
            <p className="text-body-sm text-ink-2">{t('pos.cartEmptyBody')}</p>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {cart.lines.map((line, index) => (
              <LineRow
                key={line.key}
                register={register}
                stock={stock}
                selected={selected}
                onSelect={onSelect}
                onLine={onLine}
                onRemove={onRemove}
                short={short}
                overrides={overrides}
                canOverride={canOverride}
                line={line}
                index={index}
                amount={amounts.lines[index]?.total ?? '0'}
              />
            ))}
          </ul>
        )}
        <div className="grid gap-2 border-t border-line bg-subtle px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="pos-bill-discount"
              className="flex items-center gap-2 text-body-sm text-ink-2"
            >
              {t('pos.billDiscount')} <Kbd>F7</Kbd>
            </label>
            <div className="w-40">
              <DiscountInput
                ref={billDiscountRef}
                id="pos-bill-discount"
                value={cart.billDiscount}
                onChange={(value) => {
                  onCart((current) => ({ ...current, billDiscount: value }));
                }}
                discountType={cart.billDiscountType}
                onDiscountTypeChange={(type) => {
                  onCart((current) => ({ ...current, billDiscountType: type }));
                }}
                invalid={billOver}
                aria-describedby={billOver ? 'pos-bill-discount-error' : undefined}
              />
            </div>
          </div>
          {billOver && (
            <Problem id="pos-bill-discount-error">
              {t('pos.overLimit', { max: format.number(register.maxDiscountPercent, 2) })}
            </Problem>
          )}
          {/* The lines' own discounts, only when there are any (like the sales totals block) */}
          {!isZeroMoney(amounts.totals.discount) && (
            <TotalRow
              label={t('pos.receipt.discount')}
              value={`−${money(amounts.totals.discount)}`}
            />
          )}
          <TotalRow
            label={
              pricesIncludeVat
                ? `${t('pos.receipt.vat')} (${t('pos.receipt.pricesWithVat')})`
                : t('pos.receipt.vat')
            }
            value={money(amounts.totals.vat)}
          />
          <div className="flex items-baseline justify-between gap-3 pt-1">
            <span className="text-body font-medium">{t('pos.receipt.total')}</span>
            <span className="text-kpi font-semibold tracking-[-0.03em] tabular-nums">
              {money(total)}
            </span>
          </div>
          <Button className="mt-1 w-full gap-2" disabled={!payable} onClick={onPay}>
            {t('pos.pay', { amount: money(total) })}
            <Kbd>F12</Kbd>
          </Button>
        </div>
      </aside>
      {/* A phone: the bar under the products. Hidden while the cart is open: it has its own Pay. */}
      {!open && (
        <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 border-t border-line bg-surface px-4 py-3 shadow-lg min-[860px]:hidden">
          <button
            type="button"
            onClick={() => {
              onOpen(true);
            }}
            className="flex min-w-0 flex-1 flex-col items-start rounded-control px-1 text-left"
          >
            <span className="text-caption text-ink-3 tabular-nums">{count}</span>
            <span className="text-h3 font-semibold tabular-nums">{money(total)}</span>
          </button>
          <Button disabled={!payable} onClick={onPay}>
            {t('pos.pay', { amount: money(total) })}
          </Button>
        </div>
      )}
    </>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-body-sm">
      <span className="text-ink-2">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

// What stops the sale, said where it happens: crit text with an icon, never colour alone
function Problem({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// The customer, from the device's copy (decision 5): walk-in until one is picked, and the first
// option takes the sale back to walk-in. A customer's price list prices the items added after it;
// the lines already in the cart keep their price (changing the customer never reprices by itself,
// as on every sales document).
function CustomerBox({
  cart,
  onCart,
  buttonRef,
}: {
  cart: Cart;
  onCart: (update: (cart: Cart) => Cart) => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const { t } = useLocale();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const find = useCallback((open: LocalCopy) => findCustomers(open, deferred), [deferred]);
  const matches = useLocalQuery(find);
  const options: ComboboxOption[] = [
    ...(cart.customer ? [{ value: '', label: t('pos.walkInAgain') }] : []),
    ...(matches ?? []).map((customer) => ({
      value: customer.id,
      label: customer.name,
      detail: [customer.code, customer.phone].filter((part) => part !== null).join(' · '),
    })),
  ];
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Combobox
          ref={buttonRef}
          aria-label={t('pos.customer')}
          value={cart.customer?.id ?? ''}
          selectedLabel={cart.customer?.name ?? null}
          options={options}
          search={search}
          onSearchChange={setSearch}
          onChange={(value) => {
            const customer = matches?.find((one) => one.id === value);
            onCart((current) => ({
              ...current,
              customer: customer
                ? { id: customer.id, name: customer.name, priceListId: customer.priceListId }
                : null,
            }));
          }}
          icon={UserIcon}
          placeholder={t('pos.walkIn')}
          searchPlaceholder={t('pos.customerPlaceholder')}
          emptyText={t('pos.noCustomerMatch')}
        />
      </div>
      <Kbd>F4</Kbd>
    </div>
  );
}

function LineRow({
  line,
  index,
  amount,
  selected,
  onSelect,
  onLine,
  onRemove,
  short,
  overrides,
  canOverride,
  register,
  stock,
}: Pick<
  PosCartProps,
  | 'register'
  | 'stock'
  | 'selected'
  | 'onSelect'
  | 'onLine'
  | 'onRemove'
  | 'short'
  | 'overrides'
  | 'canOverride'
> & { line: CartLine; index: number; amount: string }) {
  const { t, format } = useLocale();
  const money = useScreenMoney();
  const open = selected === line.key;
  const onHand = short.get(line.key);
  const priceOver = overrides.some((item) => item.kind === 'price' && item.line === index);
  const discountOver = overrides.some((item) => item.kind === 'discount' && item.line === index);
  const batch = stock.find((row) => row.batchId !== null && row.batchId === line.batchId);
  const id = `pos-line-${line.key}`;
  // The price box: anyone may type a price the line did not have; changing one it had needs the
  // permission (decision 11)
  const priceLocked = !canOverride && line.startingPrice !== null;
  const changed =
    line.startingPrice !== null && line.unitPrice !== '' && line.unitPrice !== line.startingPrice;
  // The stepper: never below 1 (the remove button takes a line away). A serial item's quantity
  // follows its serial numbers' count, so it has no stepper.
  const step = (by: 1 | -1) => {
    const quantity = isQuantity(line.quantity) ? line.quantity : '1';
    const next = by === 1 ? addQuantity(quantity, '1') : subtractQuantity(quantity, '1');
    if (compareQuantity(next, '1') >= 0) onLine(line.key, { quantity: next });
  };
  // The batches of this variant here, for the batch select: the one it has, and every other with
  // stock, first expiry first
  const batches = stock
    .filter(
      (row) =>
        row.variantId === line.variantId &&
        row.batchId !== null &&
        (row.batchId === line.batchId || compareQuantity(row.quantity, '0') > 0),
    )
    .sort((a, b) => (a.expiresOn ?? '9').localeCompare(b.expiresOn ?? '9'));
  const expiry = (date: string | null) => {
    const day = date === null ? undefined : parseIsoDate(date);
    return day ? format.date(day) : '';
  };

  return (
    <li className={cn('grid gap-2 px-4 py-3', open && 'bg-subtle')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-boxes`}
        onClick={() => {
          onSelect(open ? null : line.key);
        }}
        className="flex items-baseline justify-between gap-3 rounded-lg text-left"
      >
        <span className="min-w-0 text-body-sm font-medium">{line.name}</span>
        <span className="shrink-0 text-body-sm font-semibold tabular-nums">{money(amount)}</span>
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {line.tracking !== 'serial' && (
          <span className="inline-flex items-center rounded-lg border border-line-strong bg-surface">
            <button
              type="button"
              aria-label={`${t('pos.quantity')} −1`}
              onClick={() => {
                step(-1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.5} />
            </button>
            <span className="min-w-8 text-center text-body-sm font-medium tabular-nums">
              {format.number(isQuantity(line.quantity) ? line.quantity : '0', line.decimals)}
            </span>
            <button
              type="button"
              aria-label={`${t('pos.quantity')} +1`}
              onClick={() => {
                step(1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.5} />
            </button>
          </span>
        )}
        <span className="text-caption text-ink-3 tabular-nums">
          × {line.unitPrice === '' ? '—' : money(line.unitPrice)} · {line.unitCode}
        </span>
        <span className="flex-1" />
        <IconButton
          icon={Delete02Icon}
          label={t('pos.removeLine', { name: line.name })}
          onClick={() => {
            onRemove(line.key);
          }}
        />
      </div>
      {batch && (
        <p className="text-caption text-ink-3">
          {t('pos.batch')} <span className="font-mono text-ink-2">{batch.lotNumber}</span>
          {batch.expiresOn !== null && ` · ${expiry(batch.expiresOn)}`}
        </p>
      )}
      {onHand !== undefined && (
        <Problem>
          {compareQuantity(onHand, '0') > 0
            ? t('pos.shortStock', {
                quantity: `${format.number(onHand, line.decimals)} ${line.unitCode}`,
              })
            : t('pos.noStock')}
        </Problem>
      )}
      {open && (
        <div id={`${id}-boxes`} className="grid gap-3 pt-1">
          <div className="grid grid-cols-3 gap-2">
            {line.tracking !== 'serial' && (
              <Field id={`${id}-quantity`} label={t('pos.quantity')}>
                <Input
                  id={`${id}-quantity`}
                  inputMode="decimal"
                  align="end"
                  value={line.quantity}
                  onChange={(event) => {
                    onLine(line.key, { quantity: event.target.value.trim() });
                  }}
                />
              </Field>
            )}
            <Field
              id={`${id}-price`}
              label={t('pos.price')}
              hint={
                changed && line.startingPrice !== null
                  ? t('pos.priceChanged', { price: money(line.startingPrice) })
                  : undefined
              }
              error={priceOver ? t('pos.priceLocked') : undefined}
            >
              <MoneyInput
                id={`${id}-price`}
                readOnly={priceLocked}
                value={line.unitPrice}
                invalid={priceOver}
                onChange={(value) => {
                  onLine(line.key, { unitPrice: value });
                }}
              />
            </Field>
            <Field
              id={`${id}-discount`}
              label={t('pos.discount')}
              error={
                discountOver
                  ? t('pos.overLimit', { max: format.number(register.maxDiscountPercent, 2) })
                  : undefined
              }
            >
              <DiscountInput
                id={`${id}-discount`}
                value={line.discount}
                discountType={line.discountType}
                invalid={discountOver}
                onChange={(value) => {
                  onLine(line.key, { discount: value });
                }}
                onDiscountTypeChange={(type) => {
                  onLine(line.key, { discountType: type });
                }}
              />
            </Field>
          </div>
          {priceLocked && !priceOver && (
            <p className="text-caption text-ink-3">{t('pos.priceLocked')}</p>
          )}
          {line.tracking === 'batch' && batches.length > 1 && (
            <Field id={`${id}-batch`} label={t('pos.batch')}>
              <Select
                id={`${id}-batch`}
                value={line.batchId ?? ''}
                onChange={(event) => {
                  onLine(line.key, { batchId: event.target.value });
                }}
                options={batches.map((row) => ({
                  value: row.batchId ?? '',
                  label: [row.lotNumber, expiry(row.expiresOn), format.number(row.quantity, 0)]
                    .filter((part) => part !== null && part !== '')
                    .join(' · '),
                }))}
              />
            </Field>
          )}
          {line.tracking === 'serial' && (
            <Field id={`${id}-serials`} label={t('pos.serials')} hint={t('pos.serialsHint')}>
              <SerialNumbersInput
                id={`${id}-serials`}
                value={line.serialNumbers}
                aria-describedby={`${id}-serials-hint`}
                // One serial number per item: the count is the quantity
                onChange={(serials) => {
                  onLine(line.key, {
                    serialNumbers: serials,
                    quantity: String(Math.max(serials.length, 1)),
                  });
                }}
              />
            </Field>
          )}
        </div>
      )}
    </li>
  );
}
```

- **Destructured whole:** the React compiler's lint (`react-hooks/refs`) takes any read of the props object in the
  markup for a ref read, because two of the props are refs. Destructuring the props is what the rule expects.
- **A line folds to one row and opens on a click** (`aria-expanded`): a cart of 20 lines still fits, and the one being
  changed shows all its boxes.
- **The stepper never goes below 1:** the remove button takes a line away, so a stray click on − never makes a line of
  0. A serial item has no stepper: its quantity follows its serial numbers.
- **The price box:** anyone may type a price the line did not have; changing one it had is read-only without
  `pos.price.override` (decision 11), with the sentence that says why under it. Someone with the permission sees
  "Changed from ৳420" under a changed price, so they know what they did.
- **The discount and the bill discount** say "More than 10% off needs pos.price.override" where they are typed, and
  Pay waits. The server would not refuse the sale (it audits it), but a cashier without the permission must not give
  it.
- **The customer box searches the device's customers** (decision 5), and its first option goes back to walk-in. A
  customer's price list prices the items added after it; the lines already in the cart keep their price: changing the
  customer never reprices by itself, as on every sales document.
- **The totals block on `subtle`:** the bill discount, the lines' own discounts only when there are any, the VAT (with
  "Prices include VAT" when they do), the total at the KPI size, and Pay with its key.
- **A phone:** the cart is hidden under a bar with the item count, the total and Pay; the bar opens the cart over the
  products, under the top bar. Pay is in both places, so a sale needs no extra tap.

### `apps/app/src/components/pos-pay.tsx` (new): the money, then "done"

```tsx
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
  PrinterIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareMoney,
  isMoneyAmount,
  MAX_POS_PAYMENTS,
  posChangeOf,
  posSaleInputSchema,
  registerMethods,
  subtractMoney,
  sumMoney,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { type LocalCopy, savePosSale } from '@omnivo/sync';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  IconButton,
  Input,
  MoneyInput,
  Select,
} from '@omnivo/ui';
import { useState } from 'react';

import { requestSync } from '../lib/local-data';
import {
  type Cart,
  dueOf,
  newLineKey,
  type PaymentRow,
  quickCash,
  type ReceiptData,
  receiptOfCart,
  saleValues,
} from '../lib/pos';
import { hasPaisa, Kbd } from './pos-parts';

// Step 20a: taking the money (decision 5), the sale saved on the device, and what follows.

// A saved sale, for the done dialog and the receipt: the cart as it was paid, with its number
export interface DoneSale {
  number: string;
  // In cash, for the done dialog's "Give back ৳200"
  change: string;
  receipt: ReceiptData;
}

function money(format: ReturnType<typeof useLocale>['format'], value: string): string {
  return format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// Cash first, empty: the cashier types what the customer handed over, or taps a note
function firstRow(): PaymentRow {
  return { key: newLineKey(), method: 'cash', amount: '', reference: '' };
}

export function PayDialog({
  copy,
  register,
  cart,
  total,
  date,
  pricesIncludeVat,
  cashier,
  onClose,
  onDone,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  cart: Cart;
  total: string;
  date: string;
  pricesIncludeVat: boolean;
  cashier: string;
  onClose: () => void;
  onDone: (sale: DoneSale) => void;
}) {
  const { t, format } = useLocale();
  const methods = registerMethods(register.accounts);
  const [rows, setRows] = useState<PaymentRow[]>(() => [firstRow()]);
  // An error code (the schema's, the save's) or a sentence: FormAlert says either
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A box still being typed counts as 0, like the cart's totals
  const amountOf = (value: string) => (isMoneyAmount(value) ? value : '0');
  const paid = sumMoney(rows.map((row) => amountOf(row.amount)));
  const due = dueOf(rows, total);
  const change = compareMoney(paid, total) > 0 ? subtractMoney(paid, total) : '0';

  const changeRow = (key: string, change: Partial<PaymentRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  };
  // The cash row the note chips fill: the first one, or a new one when there is none
  const cashRow = rows.find((row) => row.method === 'cash');
  const setCash = (amount: string) => {
    if (cashRow) changeRow(cashRow.key, { amount });
    else setRows((current) => [...current, { ...firstRow(), amount }]);
  };
  // "Exact amount": the cash row pays what the other rows leave
  const othersPaid = sumMoney(
    rows.filter((row) => row !== cashRow).map((row) => amountOf(row.amount)),
  );
  const exact = compareMoney(total, othersPaid) > 0 ? subtractMoney(total, othersPaid) : '0';

  const complete = async () => {
    setError(null);
    const soldAt = new Date().toISOString();
    // The same schema the server reads, so a sale the device saves is one the server accepts. The
    // sequence is only for the check: the save gives the sale its number (savePosSale).
    const parsed = posSaleInputSchema.safeParse({
      ...saleValues({
        cart,
        registerId: register.id,
        date,
        soldAt,
        pricesIncludeVat,
        payments: rows,
      }),
      sequence: 1,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'unknown_error');
      return;
    }
    setSaving(true);
    try {
      const result = await savePosSale(copy, {
        input: parsed.data,
        registerCode: register.code,
        total,
        savedAt: soldAt,
      });
      if (result.kind === 'not-held') {
        setError('pos_register_not_held');
        return;
      }
      // Online it goes at once; offline it waits in the outbox (the done dialog says so)
      requestSync();
      const change = posChangeOf(parsed.data.payments, total);
      onDone({
        number: result.number,
        change,
        receipt: receiptOfCart({
          number: result.number,
          soldAt,
          register,
          cashier,
          cart,
          pricesIncludeVat,
          payments: parsed.data.payments,
          paid: sumMoney(parsed.data.payments.map((payment) => payment.amount)),
          change,
        }),
      });
    } catch {
      setError(t('sync.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        title={t('pos.payTitle')}
        description={t('pos.payDescription', { total: money(format, total) })}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form="pos-pay" disabled={saving} className="gap-2">
              {saving ? t('pos.completing') : t('pos.complete')}
              <Kbd>Enter</Kbd>
            </Button>
          </>
        }
      >
        {/* A form, so Enter in any box completes the sale (decision 12) */}
        <form
          id="pos-pay"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving) void complete();
          }}
        >
          {error && <FormAlert message={error} />}
          <ul className="grid gap-3">
            {rows.map((row, index) => {
              const id = `pos-pay-${row.key}`;
              return (
                <li
                  key={row.key}
                  className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 sm:grid-cols-[8rem_9rem_minmax(0,1fr)_auto]"
                >
                  <Select
                    id={`${id}-method`}
                    aria-label={t('pos.method')}
                    value={row.method}
                    onChange={(event) => {
                      const method = methods.find((one) => one === event.target.value);
                      if (method) changeRow(row.key, { method });
                    }}
                    options={methods.map((method) => ({
                      value: method,
                      label: t(`pos.methods.${method}`),
                    }))}
                  />
                  <MoneyInput
                    id={`${id}-amount`}
                    aria-label={t('pos.amount')}
                    // The first box takes the focus: the cashier types the amount at once
                    autoFocus={index === 0}
                    value={row.amount}
                    onChange={(amount) => {
                      changeRow(row.key, { amount });
                    }}
                  />
                  <Input
                    id={`${id}-reference`}
                    aria-label={t('pos.reference')}
                    placeholder={t(`pos.referencePlaceholders.${row.method}`)}
                    value={row.reference}
                    onChange={(event) => {
                      changeRow(row.key, { reference: event.target.value });
                    }}
                  />
                  {rows.length > 1 && (
                    <IconButton
                      icon={Cancel01Icon}
                      label={t('pos.removePayment', { number: index + 1 })}
                      onClick={() => {
                        setRows((current) => current.filter((one) => one.key !== row.key));
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {/* The notes the customer handed over: one tap, and the change shows */}
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-label font-medium">{t('pos.quickCash')}</legend>
            <div className="flex flex-wrap gap-2">
              <Chip
                onClick={() => {
                  setCash(exact);
                }}
              >
                {t('pos.exact')}
              </Chip>
              {quickCash(total).map((amount) => (
                <Chip
                  key={amount}
                  onClick={() => {
                    setCash(amount);
                  }}
                >
                  {format.money(amount)}
                </Chip>
              ))}
            </div>
          </fieldset>
          {rows.length < MAX_POS_PAYMENTS && methods.length > 1 && (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit gap-1.5"
              onClick={() => {
                // The next method this register takes that no row has yet, else cash again
                const used = new Set(rows.map((row) => row.method));
                const method = methods.find((one) => !used.has(one)) ?? 'cash';
                // It starts with what is still to pay: a card is charged the exact rest
                setRows((current) => [
                  ...current,
                  { ...firstRow(), method, amount: compareMoney(due, '0') > 0 ? due : '' },
                ]);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('pos.addPayment')}
            </Button>
          )}
          <dl className="grid gap-1.5 rounded-control bg-subtle px-4 py-3 text-body-sm">
            <SummaryRow label={t('pos.receipt.total')} value={money(format, total)} />
            <SummaryRow label={t('pos.paid')} value={money(format, paid)} />
            {compareMoney(due, '0') > 0 ? (
              <SummaryRow label={t('pos.due')} value={money(format, due)} strong />
            ) : (
              <SummaryRow label={t('pos.change')} value={money(format, change)} strong />
            )}
          </dl>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-medium text-ink' : 'text-ink-2'}>{label}</dt>
      <dd className={strong ? 'text-h3 font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}

// A filter chip's look (CLAUDE.md → Filter chips): radius 8px, a line-strong border
function Chip({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-body-sm font-medium tabular-nums transition-colors duration-150 hover:bg-subtle"
    >
      {children}
    </button>
  );
}

// After the sale: the change to give back, big, because the cashier reads it with the customer
// waiting. The receipt has gone to the printer already. Enter starts the next sale (the button
// has the focus); closing the dialog any way does the same.
export function DoneDialog({
  sale,
  offline,
  onPrint,
  onNew,
}: {
  sale: DoneSale;
  offline: boolean;
  onPrint: () => void;
  onNew: () => void;
}) {
  const { t, format } = useLocale();
  const changeDue = compareMoney(sale.change, '0') > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onNew();
      }}
    >
      <DialogContent
        title={t('pos.doneTitle', { number: sale.number })}
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
            className={changeDue ? 'text-kpi font-semibold tabular-nums' : 'text-body text-ink-2'}
          >
            {changeDue
              ? t('pos.giveChange', { amount: money(format, sale.change) })
              : t('pos.noChange')}
          </p>
          {offline && <p className="text-label text-ink-3">{t('pos.savedOnDevice')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// "?" on the screen: every key the counter uses
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const keys = [
    ['F2', t('pos.keys.search')],
    ['F4', t('pos.keys.customer')],
    ['F7', t('pos.keys.billDiscount')],
    ['F12', t('pos.keys.pay')],
    ['Enter', t('pos.keys.complete')],
    ['Enter', t('pos.keys.newSale')],
    ['?', t('pos.keys.help')],
  ] as const;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title={t('pos.shortcuts')}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-body-sm">
          {keys.map(([key, label]) => (
            <div key={label} className="contents">
              <dt>
                <kbd className="rounded-[5px] border border-line-strong bg-subtle px-1.5 font-mono text-caption text-ink-2">
                  {key}
                </kbd>
              </dt>
              <dd className="text-ink-2">{label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
```

- **Cash first, empty, with the focus:** most sales are cash; the cashier types what the customer handed over, or taps
  a note.
- **The note chips** (`quickCash()`) and "Exact amount" fill the cash row. "Exact" pays what the other rows leave, so
  "card ৳1,500, the rest in cash" is two taps.
- **"Add another method"** starts the new row at what is still to pay: a card is charged the exact rest.
- **The same schema as the server (`posSaleInputSchema`) before the save:** a sale the device saves is one the server
  accepts, so a "paid less than the total" or "change from a card" is said here, not after the push. The sequence
  `1` is only for the check; `savePosSale()` gives the number.
- **A form:** Enter in any box completes the sale (decision 12). The submit button is in the dialog's footer, outside
  the form's element, so it names the form (`form="pos-pay"`).
- **`requestSync()` after the save:** online the sale goes at once; offline it waits, and the done dialog says so.
- **The receipt is built here (`receiptOfCart()`),** because the dialog has everything at that moment: the parsed
  payments, the number the save gave and the cart as it was paid.
- **The done dialog:** the change to give back at the KPI size, because the cashier reads it with the customer
  waiting. "New sale" has the focus, so Enter starts the next sale; closing the dialog any way does the same.

### `apps/app/src/components/pos-receipt.tsx` (new): the thermal receipt

```tsx
import { isZeroMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { cn } from '@omnivo/ui';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { ReceiptCompany, ReceiptData } from '../lib/pos';

// Step 20a (decision 6): the thermal receipt. Printed by the browser (window.print()), like every
// document since step 15c, so it works offline, in every browser and with any printer driver; no
// ESC/POS. Like PrintSheet it goes straight into <body> with data-print-sheet, so the print rule
// in styles.css prints it and nothing else; it is hidden on the screen.
//
// The paper: the roll's width is the printer driver's paper size (set once on the counter's PC),
// so the page rule says `size: auto` and no margin, and the receipt draws itself at the roll's
// printable width: 72 mm on an 80 mm roll, 48 mm on a 58 mm one. A fixed `size: 80mm 200mm` would
// cut every receipt at 20 cm; `80mm auto` is not valid CSS, and the browser would ignore it and
// print on the A4 of the global rule. This <style> comes after styles.css in the page, so its
// @page wins while the receipt is there, and goes with it.
const PRINTABLE_WIDTH = { '58': 'w-[48mm]', '80': 'w-[72mm]' } as const;

// printOnMount: the screen prints the receipt of the sale just paid as soon as it is drawn. The
// sale's page draws it hidden and prints it from its button.
export function PosReceipt({
  receipt,
  company,
  printOnMount = false,
}: {
  receipt: ReceiptData;
  company: ReceiptCompany;
  printOnMount?: boolean;
}) {
  const { t, format } = useLocale();
  // Always to the paisa: a receipt is a document, and its lines must add up to its total
  const money = (value: string) => format.money(value, { decimals: 2 });
  // Once it is drawn (decision 6), once per sale: the ref keeps the number it printed, so React's
  // second run of the effect in development does not print twice. The receipt is lazy, so
  // printing from the screen's own effect could run before the sheet exists and print the screen.
  const printed = useRef<string | null>(null);
  useEffect(() => {
    if (!printOnMount || printed.current === receipt.number) return;
    printed.current = receipt.number;
    window.print();
  }, [printOnMount, receipt.number]);
  return createPortal(
    <article
      data-print-sheet=""
      className={cn(
        'hidden bg-surface text-caption text-ink print:block',
        PRINTABLE_WIDTH[receipt.paperWidth],
      )}
    >
      <style>{'@page { size: auto; margin: 0; }'}</style>
      <header className="grid justify-items-center gap-0.5 border-b border-dashed border-ink pb-2 text-center">
        <p className="text-body-sm font-semibold">{company.name}</p>
        {company.lines.map((line, index) => (
          <p key={`${String(index)}-${line}`}>{line}</p>
        ))}
      </header>
      <div className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <p className="text-center text-body-sm font-semibold">{t('pos.receipt.title')}</p>
        <p className="font-mono">{t('pos.receipt.number', { number: receipt.number })}</p>
        <p>{format.dateTime(new Date(receipt.soldAt), company.timeZone)}</p>
        <p>
          {t('pos.receipt.register', { code: receipt.registerCode })} ·{' '}
          {t('pos.receipt.cashier', { name: receipt.cashier })}
        </p>
        {receipt.customerName && <p>{t('pos.receipt.customer', { name: receipt.customerName })}</p>}
      </div>
      <table className="w-full border-b border-dashed border-ink">
        <thead>
          <tr className="text-left">
            <th className="py-1 font-medium">{t('pos.receipt.item')}</th>
            <th className="py-1 text-right font-medium">{t('pos.receipt.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((line) => (
            // break-inside-avoid: a line never splits where a driver cuts a long receipt
            <tr key={line.key} className="break-inside-avoid align-top">
              <td className="py-0.5 pr-2">
                <p>{line.name}</p>
                <p className="text-ink-2 tabular-nums">
                  {format.number(line.quantity, line.decimals)} {line.unitCode} ×{' '}
                  {money(line.unitPrice)}
                </p>
                {!isZeroMoney(line.discount) && (
                  <p className="text-ink-2 tabular-nums">
                    {t('pos.receipt.discount')} −{money(line.discount)}
                  </p>
                )}
              </td>
              {/* The line after its own discount, in the price as typed. The bill's discount is
                  one row under the lines, so: lines − bill discount = the total when prices
                  include VAT, = the amount before VAT when they do not */}
              <td className="py-0.5 text-right tabular-nums">{money(line.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        {!isZeroMoney(receipt.billDiscount) && (
          <Line label={t('pos.receipt.billDiscount')}>−{money(receipt.billDiscount)}</Line>
        )}
        <Line label={t('pos.receipt.net')}>{money(receipt.net)}</Line>
        <Line label={t('pos.receipt.vat')}>{money(receipt.vat)}</Line>
        <Line label={t('pos.receipt.total')} strong>
          {money(receipt.total)}
        </Line>
        {receipt.pricesIncludeVat && <p className="text-ink-2">{t('pos.receipt.pricesWithVat')}</p>}
      </dl>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        {receipt.payments.map((payment, index) => (
          <Line
            key={`${String(index)}-${payment.method}`}
            label={[t(`pos.methods.${payment.method}`), payment.reference]
              .filter((part) => part !== null)
              .join(' · ')}
          >
            {money(payment.amount)}
          </Line>
        ))}
        <Line label={t('pos.receipt.paid')}>{money(receipt.paid)}</Line>
        <Line label={t('pos.receipt.change')}>{money(receipt.change)}</Line>
      </dl>
      <footer className="grid justify-items-center gap-1 pt-2 text-center">
        {receipt.receiptFooter && <p className="whitespace-pre-line">{receipt.receiptFooter}</p>}
        <p>{t('pos.receipt.thanks')}</p>
      </footer>
    </article>,
    document.body,
  );
}

function Line({
  label,
  strong = false,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex justify-between gap-2', strong && 'text-body-sm font-semibold')}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}
```

- **`data-print-sheet` in `<body>`:** the print rule in `styles.css` (15c) prints the sheet and nothing else, and hides
  it on the screen. The receipt reuses it instead of a print rule of its own.
- **`@page { size: auto; margin: 0 }` and a width of 72 or 48 mm:** the roll's width is the printer driver's paper
  size, set once on the counter's PC. A fixed `size: 80mm 200mm` would cut every receipt at 20 cm, and `80mm auto` is
  not valid CSS (the browser would drop it and print on the global A4). The `<style>` comes after `styles.css` in the
  page, so its `@page` wins while the receipt is there, and goes away with it.
- **`printOnMount`: it prints once it is drawn, once per sale.** The receipt is lazy, so printing from the screen's own
  effect could run before the sheet exists and print the screen. The ref keeps the number it printed, so React's second
  run of effects in development does not print twice. 20a.6b's sale page leaves it off and prints from its button.
- **It prints `ReceiptData`,** not the cart: the same component prints a sale from the server (20a.6b).
- **No logo:** the device's copy of the settings has none (18a), and a thermal printer prints a logo badly anyway.

### `apps/app/src/routes/sync.tsx` and `components/sync-parts.tsx`

```diff
@@ -61,11 +61,13 @@ function waitsFor(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEn
   return entries.find((other) => other.customerId === entry.customerId && (other.seq ?? 0) < seq);
 }
 
-// Where Edit opens a command: the customer's form, or the order's
+// Where Edit opens a command: the customer's form, or the order's. Step 20a: a POS sale has none:
+// it was paid and its receipt printed, so what it says is what happened.
 function EditLink({ entry }: { entry: OutboxEntry }) {
   const { t } = useLocale();
   const className =
     'inline-flex min-h-9 items-center rounded-control border border-line-strong bg-surface px-3 text-body-sm font-medium text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';
+  if (entry.command.type === 'pos_sale.create') return null;
   return entry.command.type === 'sales_order.create_draft' ? (
     <Link to="/sales-orders/$orderId" params={{ orderId: entry.key }} className={className}>
       {t('sync.edit')}
@@ -254,15 +256,19 @@ export function SyncPage() {
                             {t('common.retry')}
                           </Button>
                         )}
-                        <Button
-                          variant="secondary"
-                          size="sm"
-                          onClick={() => {
-                            setDiscarding(entry);
-                          }}
-                        >
-                          {t('sync.discard')}
-                        </Button>
+                        {/* Step 20a: a POS sale only once refused (outbox.ts → mayGo) */}
+                        {(entry.command.type !== 'pos_sale.create' ||
+                          entry.status === 'failed') && (
+                          <Button
+                            variant="secondary"
+                            size="sm"
+                            onClick={() => {
+                              setDiscarding(entry);
+                            }}
+                          >
+                            {t('sync.discard')}
+                          </Button>
+                        )}
                       </div>
                     )}
                   </li>
```

```diff
@@ -72,7 +72,7 @@ export function useFieldList(): (fields: readonly string[]) => string {
 }
 
 // The two lines of an entry: what it is ("Changes to Rahman Traders") and how big ("Changed:
-// Phone and Credit limit", "3 lines · ৳4,140")
+// Phone and Credit limit", "3 lines · ৳4,140"). A POS sale's name is its number (pos.ts in sync).
 export function useCommandText(): (entry: OutboxEntry) => { title: string; detail: string } {
   const { t, format } = useLocale();
   const fieldList = useFieldList();
@@ -91,7 +91,9 @@ export function useCommandText(): (entry: OutboxEntry) => { title: string; detai
           }
           return { title, detail: t('sync.changedFields', { fields: fieldList(fields) }) };
         }
+        // Step 20a: a POS sale is "Sale POS1-000124", then its lines and total like an order's
         case 'sales_order.create_draft':
+        case 'pos_sale.create':
           return {
             title,
             detail: t('sync.orderLines', {
```

- **No Edit for a POS sale:** it was paid and its receipt printed, so what it says is what happened.
- **Discard only once refused:** the same rule as `mayGo()` in the outbox, so the button is never offered where the
  outbox would answer "busy".
- **"Sale POS1-000124", then "3 lines · ৳2,300":** the order's case is reused, because a sale's outbox entry keeps its
  line count and total the same way. The comment sits above both cases: a comment between them reads as a
  fallthrough to the lint rule.

### `apps/app/scripts/check-bundle-size.ts`: the budgets

```diff
@@ -10,15 +10,18 @@ import { z } from 'zod';
 // its pages is the real fix, a step of its own; until then the budget still stops anything else
 // from growing the first load unnoticed. Step 19a: 215 KB (you chose this). 19a's words and the
 // offline sign-in took it to 211.6 KB; from now on the service worker keeps these files, so only
-// the very first visit downloads them.
-const INITIAL_BUDGET = 215 * 1024;
+// the very first visit downloads them. Step 20a: 220 KB (you chose this). 20a's words (the
+// registers, the POS screen, its sales and the sold-short list) took it to 217.9 KB.
+const INITIAL_BUDGET = 220 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
 // pages is the real fix, a step of its own, like the words above. Step 18b: 110 KB (you chose this).
 // The customer box and the pickers now read the device's customers with the outbox on top, and the
-// line editors and the shell were already at 104–105 KB.
-const CHUNK_BUDGET = 110 * 1024;
+// line editors and the shell were already at 104–105 KB. Step 20a: 115 KB (you chose this). The
+// script counts a lazy chunk together with the chunk it loads from, so the POS screen with its
+// payment dialog is one number: 112.3 KB.
+const CHUNK_BUDGET = 115 * 1024;
 // Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
 // 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
 // changed.
```

- **Why the first load grew:** every English word loads with the first page (the comment above the constant says
  why), and 20a.5 added the words of four new screens. This part adds 0.8 KB on top: the route and the sign-out's
  release.
- **Why the POS needs 115:** the script measures a lazy chunk with everything it needs that the first load does not
  have, and that includes the screen it is opened from. Moving the payment into its own chunk keeps the screen alone at
  106.5 KB, but "the screen and its payment" is still 112.3 KB, because a cashier always needs both.

### Check this part

```bash
pnpm --filter @omnivo/sync typecheck
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/sync build
pnpm exec eslint packages/sync/src
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm exec eslint apps/app/src/lib/pos.ts apps/app/src/components/pos-*.tsx apps/app/src/routes/pos.tsx
pnpm exec prettier --check packages/sync/src apps/app/src
```

Build `@omnivo/sync` before the app: the app reads it from `dist/`. All pass: 95 sync tests (10 new), 189 app unit
tests (10 new), and `pnpm --filter @omnivo/app test:bundle-size` after `vite build`. The app's type check still fails in `notification-bell.tsx` (20a.6b) and `mocks/push-data.ts` (20a.7).

## 20a.6b — the registers page, the POS sales, the sold-short list

The pages around the counter, all in the shell and all read from the server: Settings → POS registers, the list of
POS sales with each sale's page, and the Sold short list under Stock. The bell's new kind gets its page, and the
receipt learns to print a sale the server has, so a sale's page can print it again.

### `packages/contracts/src/pos.ts` and `apps/api/src/pos/pos-sales.service.ts`: the line's id

Both files are new in this step, so their code above (20a.1, 20a.3) already has the change: `lineId` in
`soldShortItemSchema`, and `lineId: row.lineId` in `soldShort()`'s answer.

- **Why now:** the Sold short list is a data table, and a table needs one key per row. A row is a sale's line, and one
  sale may sell the same item short on two lines (the cashier changed the price of the second one), so the sale, the
  variant and the batch together are not unique. The service already read the line's id (it is the cursor's second
  half); it now sends it. 20a.1's contract shows the field (`lineId`) where `soldShortItemSchema` is.
- **Nothing else changes:** the integration tests parse the answer with the schema, so they now check the field is
  there too (31 pass).

### `apps/app/src/lib/pos-queries.ts` (new)

```ts
import { type PosRegisterStatus, routes } from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 20a: the server's reads of the POS, for the managers' pages: the registers, the posted
// sales and what sold short. Its own file, not queries.ts: queries.ts is in the chunk of almost
// every page, and only these three pages need these. All of them start with ['pos', tenantId], so
// one refresh after a register's save or a sync refreshes every POS list.

// The registers settings page: every register of the workspace, with who holds it
export function posRegistersQuery(tenantId: string, status: PosRegisterStatus) {
  return queryOptions({
    queryKey: ['pos', tenantId, 'registers', status],
    queryFn: async () => (await call(routes.pos.listRegisters, { query: { status } })).items,
  });
}

// One register, for a sale's page: its paper width and receipt footer, to print the receipt again
export function posRegisterQuery(tenantId: string, registerId: string) {
  return queryOptions({
    queryKey: ['pos', tenantId, 'register', registerId],
    queryFn: () => call(routes.pos.getRegister, { params: { id: registerId } }),
  });
}

// '' = every register
export function posSalesQuery(tenantId: string, registerId: string) {
  return infiniteQueryOptions({
    queryKey: ['pos', tenantId, 'sales', registerId],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.pos.listSales, {
        query: {
          limit: 50,
          ...(registerId !== '' && { registerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // A new register filter keeps the old rows until its first page comes: no flash of empty
    placeholderData: keepPreviousData,
  });
}

export function posSaleQuery(tenantId: string, saleId: string) {
  return queryOptions({
    queryKey: ['pos', tenantId, 'sale', saleId],
    queryFn: () => call(routes.pos.getSale, { params: { id: saleId } }),
  });
}

// '' = every warehouse
export function soldShortQuery(tenantId: string, warehouseId: string) {
  return infiniteQueryOptions({
    queryKey: ['pos', tenantId, 'sold-short', warehouseId],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.pos.soldShort, {
        query: {
          limit: 50,
          ...(warehouseId !== '' && { warehouseId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}
```

- **Its own file, not `queries.ts`:** `queries.ts` is in the chunk of almost every page, and only these pages need these.
- **Every key starts with `['pos', tenantId]`:** a register's save refreshes the registers page, the POS chooser's list
  and the sales filter with one `invalidateQueries`.
- **`keepPreviousData`** on the paged lists: a new filter keeps the old rows until its first page comes, so the table
  does not flash empty.

### `apps/app/src/routes/pos-registers.tsx` (new): Settings → POS registers

```tsx
import {
  Archive02Icon,
  CashierIcon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  formatPosNumber,
  moneyAccountIds,
  POS_PAPER_WIDTHS,
  POS_PAYMENT_METHODS,
  POS_REGISTER_STATUSES,
  type PosRegisterListItem,
  posRegisterInputSchema,
  type PosRegisterStatus,
  routes,
  updatePosRegisterInputSchema,
  type Warehouse,
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
  Field,
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
import { type Path, useForm } from 'react-hook-form';
import type { z } from 'zod';

import { failureOf } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { posRegistersQuery } from '../lib/pos-queries';
import { accountsQuery, warehousesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Step 20a: Settings → POS registers (decision 3). A register is one counter: its code (on every
// receipt number), its warehouse, an account per way of paying, the most discount a cashier may
// give, and its receipt. Like the warehouses page: a data table, and one form dialog for a new
// register and a change. Everyone may read it; pos.register.manage changes it.

const column = dataTableColumns<PosRegisterListItem>();

// One form for both, like the warehouse form: the create schema plus the version. A change sends
// everything but the code, which never changes (20a.1); a new register sends everything but the
// version (1, which the create route never reads).
const formSchema = posRegisterInputSchema.extend({
  version: updatePosRegisterInputSchema.shape.version,
});
type FormValues = z.input<typeof formSchema>;

// The paths the server may name in fieldErrors, typed against the form (accounts.card and so on)
const FIELD_NAMES = [
  'code',
  'name',
  'warehouseId',
  'accounts.cash',
  'accounts.card',
  'accounts.bkash',
  'accounts.nagad',
  'maxDiscountPercent',
  'paperWidth',
  'receiptFooter',
] as const satisfies readonly Path<FormValues>[];

function RegisterForm({
  register: current,
  warehouses,
  onDone,
}: {
  register: PosRegisterListItem | null;
  warehouses: readonly Warehouse[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  // The accounts money goes into: the contracts' own list, the one the API checks against
  // (moneyAccountIds), by code
  const moneyAccounts = useMemo(() => {
    const all = accounts ?? [];
    const ids = moneyAccountIds(all);
    return all
      .filter((account) => ids.has(account.id))
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts]);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(formSchema, { error: contractErrorMap }),
    defaultValues: {
      code: current?.code ?? '',
      name: current?.name ?? '',
      // The select starts empty: the warehouse decides the branch, so it is picked on purpose
      warehouseId: current?.warehouseId ?? '',
      accounts: {
        cash: current?.accounts.cash ?? '',
        card: current?.accounts.card ?? '',
        bkash: current?.accounts.bkash ?? '',
        nagad: current?.accounts.nagad ?? '',
      },
      maxDiscountPercent: current?.maxDiscountPercent ?? '',
      paperWidth: current?.paperWidth ?? '80',
      receiptFooter: current?.receiptFooter ?? '',
      version: current?.version ?? 1,
    } satisfies FormValues,
  });

  // The registers page, the POS chooser and the POS sales filter all read ['pos', tenant]
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pos', tenantId] });

  const toggle = useMutation({
    mutationFn: (item: PosRegisterListItem) =>
      call(item.archivedAt === null ? routes.pos.archiveRegister : routes.pos.restoreRegister, {
        params: { id: item.id },
        body: { version: item.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'registers.restoredToast' : 'registers.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ code, version, ...fields }) => {
    try {
      const saved = current
        ? await call(routes.pos.updateRegister, {
            params: { id: current.id },
            body: { ...fields, version },
          })
        : await call(routes.pos.createRegister, { body: { ...fields, code } });
      await refresh();
      toast(t(current ? 'registers.updated' : 'registers.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // archive/restore's errors (pos_register_in_use, version_conflict) belong to no field
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);
  const accountOptions = moneyAccounts.map((account) => ({
    value: account.id,
    label: `${account.code} · ${account.name}`,
  }));

  return (
    <DialogContent
      title={current ? t('registers.editTitle', { code: current.code }) : t('registers.newTitle')}
      footer={
        <>
          {current && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(current);
              }}
            >
              {current.archivedAt === null ? t('registers.archive') : t('registers.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="register-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : current ? t('common.save') : t('registers.add')}
          </Button>
        </>
      }
    >
      <form
        id="register-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          {current ? (
            // Decision 16: the code is on every receipt the register printed, so it is shown,
            // not offered as a box
            <Field id="register-code" label={t('registers.code')} hint={t('registers.codeLocked')}>
              <p id="register-code" className="py-2.5 font-mono text-body">
                {current.code}
              </p>
            </Field>
          ) : (
            <TextField
              label={t('registers.code')}
              hint={t('registers.codeHint')}
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="POS1"
              {...register('code')}
              error={errors.code?.message}
            />
          )}
          <TextField
            label={t('registers.name')}
            icon={CashierIcon}
            placeholder={t('registers.namePlaceholder')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <SelectField
          label={t('registers.warehouse')}
          hint={t('registers.warehouseHint')}
          options={[
            { value: '', label: t('registers.warehousePlaceholder') },
            ...warehouses.map((warehouse) => ({
              value: warehouse.id,
              label: `${warehouse.code} · ${warehouse.name}`,
            })),
          ]}
          {...register('warehouseId')}
          error={errors.warehouseId?.message}
        />
        <fieldset className="grid gap-4">
          <legend className="text-label font-medium">{t('registers.accountsTitle')}</legend>
          <p className="-mt-2 text-label text-ink-3">
            {moneyAccounts.length === 0 && accounts
              ? t('registers.noMoneyAccounts')
              : t('registers.accountsHint')}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {POS_PAYMENT_METHODS.map((method) => (
              <SelectField
                key={method}
                label={t(`registers.accounts.${method}`)}
                // Cash is always there (change is given in cash); an empty box = not taken here
                hint={method === 'cash' ? t('registers.cashHint') : undefined}
                options={[
                  {
                    value: '',
                    label:
                      method === 'cash'
                        ? t('registers.accountPlaceholder')
                        : t('registers.notTaken'),
                  },
                  ...accountOptions,
                ]}
                {...register(`accounts.${method}`)}
                error={errors.accounts?.[method]?.message}
              />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
          <TextField
            label={t('registers.maxDiscount')}
            hint={t('registers.maxDiscountHint')}
            inputMode="decimal"
            suffix="%"
            align="end"
            placeholder="10"
            {...register('maxDiscountPercent')}
            error={errors.maxDiscountPercent?.message}
          />
          <SelectField
            label={t('registers.paperWidth')}
            hint={t('registers.paperWidthHint')}
            options={POS_PAPER_WIDTHS.map((width) => ({
              value: width,
              label: t(`registers.paperWidths.${width}`),
            }))}
            {...register('paperWidth')}
            error={errors.paperWidth?.message}
          />
        </div>
        <TextAreaField
          label={t('registers.receiptFooter')}
          optional
          placeholder={t('registers.receiptFooterPlaceholder')}
          {...register('receiptFooter')}
          error={errors.receiptFooter?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | PosRegisterListItem;

export function PosRegistersPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('pos.register.manage');
  const [status, setStatus] = useState<PosRegisterStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({
    ...posRegistersQuery(tenantId, status),
    enabled: me !== null,
  });
  const warehouses = useQuery(warehousesQuery(tenantId, 'active')).data;
  const archivedWarehouses = useQuery(warehousesQuery(tenantId, 'archived')).data;
  const warehouseName = useMemo(
    () =>
      new Map(
        [...(warehouses ?? []), ...(archivedWarehouses ?? [])].map((warehouse) => [
          warehouse.id,
          `${warehouse.code} · ${warehouse.name}`,
        ]),
      ),
    [warehouses, archivedWarehouses],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('registers.columns.register'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid h-[30px] min-w-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft px-1 text-[11px] font-semibold text-brand">
                {row.original.code}
              </span>
              <span className="block min-w-0 truncate font-medium">{row.original.name}</span>
            </span>
          ),
        }),
        column.accessor('warehouseId', {
          header: t('registers.columns.warehouse'),
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => warehouseName.get(getValue()) ?? '—',
        }),
        // Decision 14: who holds it, by the device's name and its person, or free
        column.accessor('holder', {
          header: t('registers.columns.holder'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const holder = getValue();
            return holder ? (
              t('registers.holder', { device: holder.deviceName, person: holder.userName })
            ) : (
              <span className="text-ink-3">{t('registers.free')}</span>
            );
          },
        }),
        column.accessor('lastNumber', {
          header: t('registers.columns.lastNumber'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row, getValue }) =>
            getValue() === 0 ? (
              <span className="text-ink-3">{t('registers.noSaleYet')}</span>
            ) : (
              <span className="font-mono tabular-nums">
                {formatPosNumber(row.original.code, getValue())}
              </span>
            ),
        }),
        column.accessor('archivedAt', {
          header: t('registers.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('registers.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('registers.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t, warehouseName],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('registers.title')}
        description={t('registers.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('registers.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('registers.show')}
          value={status}
          options={POS_REGISTER_STATUSES.map((value) => ({
            value,
            label: t(`registers.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('registers.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('registers.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('registers.title')}
          data={data}
          columns={columns}
          getRowId={(item) => item.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('registers.emptyArchivedTitle')}
                description={t('registers.emptyArchivedBody')}
              />
            ) : (
              <EmptyState
                icon={CashierIcon}
                title={t('registers.emptyTitle')}
                description={t('registers.emptyBody')}
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
        {/* The form opens with the warehouses loaded: its select lists them */}
        {editing !== null && warehouses && (
          <RegisterForm
            key={editing === 'new' ? 'new' : editing.id}
            register={editing === 'new' ? null : editing}
            warehouses={warehouses}
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

- **One form for a new register and a change,** like the warehouse form: the create schema plus the version. A change
  sends everything but the code (the update route has no code), a new register everything but the version.
- **`FIELD_NAMES` lists `accounts.card` and the others:** the server names a bad account by its path
  (`pos_register_account_invalid` under `accounts.card`), and `applyApiError` puts it under that box. `satisfies
  Path<FormValues>[]` makes a typo a type error.
- **The accounts are the money accounts only** (`moneyAccountIds`, the contracts' own list, the same one the API checks
  against), by code. With none, the hint says how to make one ("Holds money" in the chart of accounts).
- **An empty account box means "not taken here"** for card, bKash and Nagad (the schema turns `''` into `null`). Cash
  has its own placeholder and hint: it is always needed, because change is given in cash.
- **The code is shown, not a box, on an existing register** (decision 16): it is on every receipt the register printed.
- **The list shows who holds each register** (the device and its person) and its last receipt number, so a manager
  sees at once which counter a lost PC still holds (revoke it on the Devices page to free it).

### `apps/app/src/components/pos-sale-parts.tsx` (new)

```tsx
import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';

// Step 20a: a POS sale's pills, for its list and its page. A sale reaches the server already paid
// and is posted when it arrives, so it is always Posted (good). A second, warn pill when a line went
// below zero: someone must count the shelf and put the stock right (decision 30), and warn is for
// what a person must act on.
export function PosSalePills({ soldShort }: { soldShort: boolean }) {
  const { t } = useLocale();
  return (
    <span className="flex flex-wrap gap-1.5">
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('posSales.posted')}
      </Pill>
      {soldShort && (
        <Pill tone="warn" icon={Alert02Icon}>
          {t('posSales.soldShort')}
        </Pill>
      )}
    </span>
  );
}
```

- **Always Posted:** a sale reaches the server paid, and is posted when it arrives; there is no draft.
- **Sold short in `warn`:** someone must count the shelf and put the stock right, and `warn` is for what a person must
  act on.

### `apps/app/src/routes/pos-sales.tsx` (new): the list

```tsx
import { ReceiptDollarIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import type { PosSaleSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { PosSalePills } from '../components/pos-sale-parts';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { posRegistersQuery, posSalesQuery } from '../lib/pos-queries';
import { useOnline } from '../lib/use-online';

// Step 20a: what the counters sold, as it reached the books, newest first. For the managers: the
// cashier sees their own sales on the POS screen and its receipts. Read from the server (the sales
// are not on the devices), so offline it says it needs a connection, like the orders list.

const column = dataTableColumns<PosSaleSummary>();

export function PosSalesPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  // '' = every register
  const [registerId, setRegisterId] = useState('');
  const registers = useQuery(posRegistersQuery(tenantId, 'active')).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...posSalesQuery(tenantId, registerId),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('posSales.columns.number'),
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
        column.accessor((sale) => sale.register.code, {
          id: 'register',
          header: t('posSales.columns.register'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="font-mono">{row.original.register.code}</span>
              <span className="truncate text-caption text-ink-3">{row.original.register.name}</span>
            </span>
          ),
        }),
        // null = walk-in (decision 5)
        column.accessor((sale) => sale.customer?.name ?? '', {
          id: 'customer',
          header: t('posSales.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            row.original.customer ? (
              <span className="block max-w-[16rem] truncate">{row.original.customer.name}</span>
            ) : (
              <span className="text-ink-3">{t('posSales.walkIn')}</span>
            ),
        }),
        column.accessor((sale) => sale.cashier.fullName, {
          id: 'cashier',
          header: t('posSales.columns.cashier'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        column.accessor('total', {
          header: t('posSales.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('soldShort', {
          header: t('posSales.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <PosSalePills soldShort={getValue()} />,
        }),
      ]),
    [t, format, isoDate],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('posSales.title')} description={t('posSales.description')} />
      <div className="max-w-72">
        <Select
          aria-label={t('posSales.register')}
          value={registerId}
          onChange={(event) => {
            setRegisterId(event.target.value);
          }}
          options={[
            { value: '', label: t('posSales.allRegisters') },
            ...(registers ?? []).map((register) => ({
              value: register.id,
              label: `${register.code} · ${register.name}`,
            })),
          ]}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('posSales.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('posSales.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('posSales.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/pos/sales/$saleId', params: { saleId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ReceiptDollarIcon}
              title={t('posSales.emptyTitle')}
              description={t('posSales.emptyBody')}
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

- **Offline, "Needs a connection":** the sales are not on the devices, and a list shown from the cache could be hours
  old. The query does not even run (`enabled: online`).
- **The register filter is a native select** of the active registers: a few counters, a fixed list.
- **Walk-in in `ink-3`:** no customer is not a missing value, it is the usual case at a counter.

### `apps/app/src/routes/pos-sale.tsx` (new): one sale

```tsx
import { Alert02Icon, AlertCircleIcon, PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addMoney,
  compareQuantity,
  isZeroMoney,
  multiplyMoney,
  type PosRegister,
  type PosSale,
  subtractMoney,
  todayIn,
  type Unit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { Fact } from '../components/adjustment-view';
import { DocumentNotice } from '../components/document-notice';
import { EntryLinks } from '../components/entry-links';
import { useReceiptCompany } from '../components/pos-parts';
import { PosSalePills } from '../components/pos-sale-parts';
import { SalesBackLink } from '../components/sales-parts';
import { SalesLinesTable } from '../components/sales-lines-table';
import {
  useIsoDate,
  useQuantity,
  useTenantId,
  useTimeZone,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import type { ReceiptData } from '../lib/pos';
import { posRegisterQuery, posSaleQuery } from '../lib/pos-queries';
import { settingsQuery, unitsQuery } from '../lib/queries';
import { useOnline } from '../lib/use-online';

// Step 20a: one POS sale, as the server posted it: its lines with the batches and serial numbers
// they left with, what went below zero, the payments, and its journal entry. "Print receipt" prints
// the same thermal receipt the counter printed (a customer who lost it).

const PosReceipt = lazy(async () => ({
  default: (await import('../components/pos-receipt')).PosReceipt,
}));

// The receipt from the server's sale. A line's amount on the receipt is after its own discount
// and before the bill's share: the server's net or total (whichever the prices are written in)
// plus that share. Its own discount is the rest of quantity × price.
function receiptOfSale(
  sale: PosSale,
  register: Pick<PosRegister, 'paperWidth' | 'receiptFooter'>,
  units: readonly Unit[],
): ReceiptData {
  return {
    number: sale.number,
    soldAt: sale.soldAt,
    registerCode: sale.register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: sale.cashier.fullName,
    customerName: sale.customer?.name ?? null,
    lines: sale.lines.map((line) => {
      const unit = units.find((one) => one.id === line.unitId);
      const after = addMoney(sale.pricesIncludeVat ? line.total : line.net, line.billDiscount);
      return {
        key: line.id,
        name: line.description,
        quantity: line.quantity,
        decimals: unit?.decimals ?? 0,
        unitCode: unit?.code ?? '',
        unitPrice: line.unitPrice,
        discount: subtractMoney(multiplyMoney(line.quantity, line.unitPrice), after),
        after,
      };
    }),
    pricesIncludeVat: sale.pricesIncludeVat,
    billDiscount: sale.billDiscountAmount,
    net: sale.net,
    vat: sale.vat,
    total: sale.total,
    payments: sale.payments,
    paid: sale.paid,
    change: sale.change,
  };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/sales" label={t('posSales.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('posSales.title')} description={message} />
    </div>
  );
}

export function PosSalePage() {
  const { t } = useLocale();
  const online = useOnline();
  const { saleId = '' } = useParams({ strict: false });
  const { data: sale, isError } = useQuery({
    ...posSaleQuery(useTenantId(), saleId),
    enabled: saleId !== '',
  });
  if (isError) return <CantFind message={t('posSales.notFound')} />;
  // Offline before it ever loaded: the sales are read from the server only
  if (!sale) return online ? null : <CantFind message={t('posSales.needsConnection')} />;
  return <PosSaleView sale={sale} />;
}

function PosSaleView({ sale }: { sale: PosSale }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const warehouses = useWarehouses();
  const register = useQuery(posRegisterQuery(tenantId, sale.register.id)).data;
  const units = useQuery(unitsQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const money = (value: string) => format.money(value, { decimals: 2 });
  // Decision 26: the day it was sold, by the device, against the day it is in the books. They
  // differ when that day was closed (or the device's clock was ahead): the page says why.
  const soldOn = todayIn(timeZone, new Date(sale.soldAt));
  const warehouse = warehouseLabel(warehouses.byId.get(sale.warehouseId));

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/sales" label={t('posSales.back')} />
      <PageHeader
        title={sale.number}
        description={sale.customer?.name ?? t('posSales.walkIn')}
        actions={
          <>
            <PosSalePills soldShort={sale.soldShort} />
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
                {t('posSales.print')}
              </Button>
            )}
          </>
        }
      />
      {soldOn !== sale.date && (
        <DocumentNotice tone="neutral">
          {t('posSales.bookedLater', { sold: isoDate(soldOn), date: isoDate(sale.date) })}
        </DocumentNotice>
      )}
      {sale.soldShort && (
        <DocumentNotice tone="warn" icon={Alert02Icon}>
          {t('posSales.soldShortNotice', { warehouse })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('posSales.customer')} value={sale.customer?.name ?? t('posSales.walkIn')} />
        <Fact label={t('posSales.columns.date')} value={isoDate(sale.date)} />
        <Fact
          label={t('posSales.soldAt')}
          value={format.dateTime(new Date(sale.soldAt), timeZone)}
        />
        <Fact
          label={t('posSales.register')}
          value={`${sale.register.code} · ${sale.register.name}`}
        />
        <Fact label={t('posSales.cashier')} value={sale.cashier.fullName} />
        <Fact label={t('posSales.device')} value={sale.device.name} />
        <EntryLinks label={t('posSales.entry')} entries={sale.entry ? [sale.entry] : []} none="—" />
      </Card>
      <SalesLinesTable
        lines={sale.lines}
        totals={{ discount: sale.discount, net: sale.net, vat: sale.vat, total: sale.total }}
        pricesIncludeVat={sale.pricesIncludeVat}
        // Under the item: the batches it left from, its serial numbers, and what went below zero
        note={(line) => (
          <>
            {line.batches.map((batch) => (
              <span key={batch.batchId} className="text-caption text-ink-3 tabular-nums">
                {t('posSales.batches', {
                  lot: batch.lotNumber,
                  quantity: quantity(batch.quantity, line.baseUnitId),
                })}
              </span>
            ))}
            {line.serialNumbers.length > 0 && (
              <span className="font-mono text-caption text-ink-3">
                {t('posSales.serials', { serials: line.serialNumbers.join(', ') })}
              </span>
            )}
            {compareQuantity(line.shortQuantity, '0') > 0 && (
              <span className="text-caption font-medium text-warn">
                {t('posSales.shortLine', {
                  quantity: quantity(line.shortQuantity, line.baseUnitId),
                })}
              </span>
            )}
          </>
        )}
      />
      <Card>
        <CardHeader title={t('posSales.payments')} />
        <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
          {sale.payments.map((payment, index) => (
            <div key={`${String(index)}-${payment.method}`} className="flex justify-between gap-3">
              <dt className="text-ink-2">
                {t(`pos.methods.${payment.method}`)}
                {payment.reference !== null && (
                  <span className="text-ink-3"> · {payment.reference}</span>
                )}
              </dt>
              <dd className="tabular-nums">{money(payment.amount)}</dd>
            </div>
          ))}
          {!isZeroMoney(sale.billDiscountAmount) && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">{t('pos.receipt.billDiscount')}</dt>
              <dd className="tabular-nums">−{money(sale.billDiscountAmount)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3 border-t border-line pt-2 font-medium">
            <dt>{t('posSales.paid')}</dt>
            <dd className="tabular-nums">{money(sale.paid)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-2">{t('posSales.change')}</dt>
            <dd className="tabular-nums">{money(sale.change)}</dd>
          </div>
        </dl>
      </Card>
      {register && units && settings && (
        <Suspense fallback={null}>
          <ReprintSheet sale={sale} register={register} units={units} settings={settings} />
        </Suspense>
      )}
    </div>
  );
}

// The receipt, hidden on the screen, for Print. Its own component: useReceiptCompany is a hook,
// and the settings are only known to be there inside this branch.
function ReprintSheet({
  sale,
  register,
  units,
  settings,
}: {
  sale: PosSale;
  register: PosRegister;
  units: readonly Unit[];
  settings: Parameters<typeof useReceiptCompany>[0];
}) {
  const company = useReceiptCompany(settings);
  return <PosReceipt receipt={receiptOfSale(sale, register, units)} company={company} />;
}
```

- **`SalesLinesTable` as it is:** a POS line is a sales line (`posSaleLineSchema` extends `salesLineSchema`), so the
  invoice's table shows it, and `note` adds what only a POS line has: the batches it left from, its serial numbers, and
  what went below zero. A line's net and total are after the bill's discount, so the lines add up to the totals.
- **"Sold on … , so the sale is on …" (decision 26):** the day the device sold it, in the workspace's time zone, against
  the day in the books. They differ only when that day was closed or the device's clock was ahead.
- **The sold-short notice names the warehouse,** so the manager knows which shelf to count.
- **The bill discount is in the payments card,** with what was paid and the change: it is how the money was worked out.
- **Print receipt:** the button shows once the register (its paper and footer), the units and the company are loaded;
  the hidden receipt is drawn then too, so Print prints it.
- **`receiptOfSale()`:** a receipt line is after its own discount and before the bill's share, so it is the server's
  net or total (whichever the prices are written in) plus that share, and its own discount is the rest of quantity ×
  price. Then the reprint adds up exactly like the paper the counter printed.

### `apps/app/src/routes/sold-short.tsx` (new): the Sold short list

```tsx
import {
  CheckmarkCircle02Icon,
  PackageRemoveIcon,
  TimeQuarterPassIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { compareQuantity, type SoldShortItem } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Pill, Select } from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  useIsoDate,
  useQuantity,
  useTenantId,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import { soldShortQuery } from '../lib/pos-queries';
import { variantName } from '../lib/stock';
import { useOnline } from '../lib/use-online';

// Step 20a (decision 30): what the counters sold that the warehouse did not have. A POS sale is
// never refused for stock, so its lines go below zero, and each such line is listed here until
// someone counts the shelf and posts an adjustment or receives the goods. Newest first, from the
// server. A row opens its sale.

const column = dataTableColumns<SoldShortItem>();

export function SoldShortPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const warehouses = useWarehouses();
  // '' = every warehouse
  const [warehouseId, setWarehouseId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...soldShortQuery(tenantId, warehouseId),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor((item) => variantName(item), {
          id: 'item',
          header: t('soldShort.columns.item'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[20rem]">
              <span className="truncate font-medium">{variantName(row.original)}</span>
              <span className="truncate font-mono text-caption text-ink-3">{row.original.sku}</span>
              {/* Serial numbers the scanner read that were not in this warehouse (decision 15) */}
              {row.original.serialNumbers.length > 0 && (
                <span className="truncate text-caption text-ink-3">
                  {t('soldShort.serials', { serials: row.original.serialNumbers.join(', ') })}
                </span>
              )}
            </span>
          ),
        }),
        column.accessor('saleNumber', {
          header: t('soldShort.columns.sale'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono tabular-nums">{row.original.saleNumber}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)} ·{' '}
                {warehouseLabel(warehouses.byId.get(row.original.warehouseId))}
              </span>
            </span>
          ),
        }),
        column.accessor('shortQuantity', {
          header: t('soldShort.columns.short'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row, getValue }) => (
            <span className="font-medium">{quantity(getValue(), row.original.baseUnitId)}</span>
          ),
        }),
        column.accessor('lotNumber', {
          header: t('soldShort.columns.batch'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const lot = getValue();
            return lot === null ? (
              <span className="text-ink-3">{t('soldShort.noBatch')}</span>
            ) : (
              <span className="font-mono">{lot}</span>
            );
          },
        }),
        column.accessor('onHandNow', {
          header: t('soldShort.columns.onHand'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row, getValue }) => quantity(getValue(), row.original.baseUnitId),
        }),
        // warn while the variant is below zero there, good once it is back at zero or above
        column.accessor((item) => compareQuantity(item.onHandNow, '0') < 0, {
          id: 'status',
          header: t('soldShort.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() ? (
              <Pill tone="warn" icon={TimeQuarterPassIcon}>
                {t('soldShort.statuses.open')}
              </Pill>
            ) : (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('soldShort.statuses.fixed')}
              </Pill>
            ),
        }),
      ]),
    [t, isoDate, quantity, warehouses.byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('soldShort.title')} description={t('soldShort.description')} />
      <div className="max-w-72">
        <Select
          aria-label={t('soldShort.warehouse')}
          value={warehouseId}
          onChange={(event) => {
            setWarehouseId(event.target.value);
          }}
          options={[
            { value: '', label: t('soldShort.allWarehouses') },
            ...(warehouses.active ?? []).map((warehouse) => ({
              value: warehouse.id,
              label: warehouseLabel(warehouse),
            })),
          ]}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('soldShort.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('soldShort.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('soldShort.title')}
          data={rows}
          columns={columns}
          // One sale may have several short lines: the key is the line, not the sale
          getRowId={(row) => row.lineId}
          onRowClick={(row) =>
            void navigate({ to: '/pos/sales/$saleId', params: { saleId: row.saleId } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={PackageRemoveIcon}
              title={t('soldShort.emptyTitle')}
              description={t('soldShort.emptyBody')}
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

- **Below zero or Put right, from `onHandNow`:** the server sends the variant's stock in that warehouse now, every batch
  together. Once an adjustment or a receipt brings it back to zero or above, the line says Put right, and stays on the
  list as a record.
- **Serial numbers that were not in the warehouse** show under the item (decision 15): they left without a serial, and
  someone should find out where those phones really were.
- **A row opens its sale:** the receipt, the cashier and the time are what a manager asks about first.
- **`getRowId` is the line's id** (decision 67).

### The receipt, printed again

Nothing new to write here: 20a.6a's receipt prints `ReceiptData` (`lib/pos.ts`), and the company comes from
`useReceiptCompany()` (`pos-parts.tsx`), so `receiptOfSale()` above is all the sale's page needs. The receipt's
`printOnMount` stays off on that page.

### `apps/app/src/router.tsx`, `routes/app-shell.tsx`, `components/notification-bell.tsx`, `components/sales-parts.tsx`

```diff
@@ -649,6 +649,42 @@ const syncRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/sync'), 'SyncPage'),
 });
 
+// Step 20a: the POS screen. Under the app route, so the session, the lock screen and the device's
+// copy work as on every page, but the AppFrame draws it without the shell (POS_PATH in
+// app-frame.tsx): a counter needs the whole screen. Its own chunk, like every page.
+const posRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos',
+  component: lazyRouteComponent(() => import('./routes/pos'), 'PosPage'),
+});
+
+// Step 20a: the POS's pages in the shell: the registers (a workspace setting), the posted sales
+// and their page, and what the counters sold short (under Stock). Only '/pos' itself is bare
+// (app-frame.tsx), so these keep the sidebar.
+const posRegistersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/registers',
+  component: lazyRouteComponent(() => import('./routes/pos-registers'), 'PosRegistersPage'),
+});
+
+const posSalesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/sales',
+  component: lazyRouteComponent(() => import('./routes/pos-sales'), 'PosSalesPage'),
+});
+
+const posSaleRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/sales/$saleId',
+  component: lazyRouteComponent(() => import('./routes/pos-sale'), 'PosSalePage'),
+});
+
+const soldShortRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/sold-short',
+  component: lazyRouteComponent(() => import('./routes/sold-short'), 'SoldShortPage'),
+});
+
 // Step 18c: your own devices (the account menu) and every device of the workspace (the sidebar,
 // with core.device.manage)
 const myDevicesRoute = createRoute({
@@ -964,6 +1000,11 @@ const routeTree = rootRoute.addChildren([
     requisitionRoute,
     approvalsRoute,
     syncRoute,
+    posRoute,
+    posRegistersRoute,
+    posSalesRoute,
+    posSaleRoute,
+    soldShortRoute,
     myDevicesRoute,
     devicesRoute,
     purchaseOrdersRoute,
```

```diff
@@ -4,6 +4,8 @@ import {
   Book02Icon,
   BookOpen02Icon,
   CalendarLock01Icon,
+  Cashier02Icon,
+  CashierIcon,
   ChartIncreaseIcon,
   CheckmarkBadge01Icon,
   Coins01Icon,
@@ -35,8 +37,10 @@ import {
   PackageIcon,
   PackageOutOfStockIcon,
   PackageReceiveIcon,
+  PackageRemoveIcon,
   Payment02Icon,
   PieChartIcon,
+  ReceiptDollarIcon,
   RulerIcon,
   SecurityCheckIcon,
   Settings02Icon,
@@ -428,6 +432,17 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
               invoice and the money receipt end the chain. Step 15d: what goes back the other way
               comes after them, goods first, then money. */}
           <NavGroup label={t('nav.sales')}>
+            {/* Step 20a: the counter screen first, for the cashiers who sell there (it opens
+                without this sidebar) */}
+            {can('pos.sale.create') && (
+              <NavLink to="/pos" icon={CashierIcon}>
+                {t('nav.pointOfSale')}
+              </NavLink>
+            )}
+            {/* Everyone reads the posted sales, like every sales document */}
+            <NavLink to="/pos/sales" icon={ReceiptDollarIcon}>
+              {t('nav.posSales')}
+            </NavLink>
             <NavLink to="/quotations" icon={Note01Icon}>
               {t('nav.quotations')}
             </NavLink>
@@ -544,6 +559,9 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
             <NavLink to="/stock/batches" icon={HourglassIcon}>
               {t('nav.expiry')}
             </NavLink>
+            <NavLink to="/stock/sold-short" icon={PackageRemoveIcon}>
+              {t('nav.soldShort')}
+            </NavLink>
             <NavLink to="/stock/reorder" icon={PackageOutOfStockIcon}>
               {t('nav.reorder')}
             </NavLink>
@@ -583,6 +601,10 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
             <NavLink to="/custom-fields" icon={TextIcon}>
               {t('nav.customFields')}
             </NavLink>
+            {/* Step 20a: everyone reads the registers (read-only without pos.register.manage) */}
+            <NavLink to="/pos/registers" icon={Cashier02Icon}>
+              {t('nav.registers')}
+            </NavLink>
             <NavLink to="/branches" icon={Store01Icon}>
               {t('nav.branches')}
             </NavLink>
```

```diff
@@ -47,6 +47,8 @@ const TARGET = {
   'import.done': '/products/imports',
   'import.failed': '/products/imports',
   'stock.low': '/stock/reorder',
+  // Step 20a: the list that has every line a counter sold short, the one to act on (decision 30)
+  'pos.sold_short': '/stock/sold-short',
 } as const satisfies Record<Exclude<NotificationType, DocumentNotificationType>, string>;
 
 // A document's page from the notification's kind and id. The list of that kind when the id is
```

```diff
@@ -50,7 +50,8 @@ export function SalesBackLink({
     | '/receipts'
     | '/sales-returns'
     | '/credit-notes'
-    | '/refunds';
+    | '/refunds'
+    | '/pos/sales';
   label: string;
 }) {
   return (
```

- **`/pos` under the app route (20a.6a):** the session check, the lock screen, the device's copy and the update notice all
  work on it as on every page (decision 12: inside the AppFrame).
- **Only `/pos` is bare:** `BARE_PATHS` holds the exact path, so `/pos/sales` and `/pos/registers` keep the sidebar.
- **The POS link only with `pos.sale.create`:** hiding is a convenience; the server refuses the claim without the
  permission anyway. First in the Sales group, for the cashiers who open it every morning.
- **The bell's `TARGET`** is `satisfies Record<…>`: 20a.1's new kind made it fail to compile until the kind had a page.
- **`SalesBackLink`** takes `/pos/sales` too: the sale's page goes back to its list like every sales document.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/api typecheck
cd apps/api && npx vitest run src/pos/pos.int.spec.ts --maxWorkers=2 && cd ../..
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm exec eslint apps/app/src/routes/pos*.tsx apps/app/src/routes/sold-short.tsx apps/app/src/components/pos-*.tsx
pnpm --filter @omnivo/app exec vite build && pnpm --filter @omnivo/app test:bundle-size
```

All pass: 310 contract tests, 31 POS integration tests, 190 app unit tests (1 new). The app's type check fails only in
`mocks/push-data.ts`, which 20a.7 changes. The bundle: the first load 218.3 KB, the POS screen with its payment
113.0 KB, the registers page 106.4 KB.

## 20a.7 — `apps/app`: the mock API's POS and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). After 20a.6 the
POS screen had nothing to sell on: the mock's pull sent no register, the chooser's list and the claim did not exist,
and a pushed sale broke the mock's push (its `customerId` is inside the input, so `push-data.ts` did not even type
check). This part gives the mock the registers, the claim and the release, the sale's posting and the two lists, with
the API's rules on its own arrays, and adds one test file: a sale for cash online, a split payment offline, the
register change, and the registers page.

Writing these tests found one mistake in 20a.6a (fixed there, so its code above is already the fixed one): **the screen
checked stock against the device's copy alone, without the device's own sales still in the outbox.** Offline, the last
T-shirt could be sold twice, and the second sale went below zero at sync. `stockOf()` in `packages/sync/src/pos.ts` now
takes them off (decision 78), with a test in `pos.spec.ts`, and the offline test here checks the tile.

The files, in the order to write them: each one only uses files above it.

### `mocks/stock-data.ts`: below zero for a POS sale

```diff
@@ -226,8 +226,9 @@ export function decimalsOf(data: WorkspaceData, unitId: string): number {
   return data.catalog.units.find((unit) => unit.id === unitId)?.decimals ?? 0;
 }
 
-// warehouse|variant → on hand, and warehouse|variant|batch → on hand, from every movement
-function balancesOf(stock: MockStock) {
+// warehouse|variant → on hand, and warehouse|variant|batch → on hand, from every movement. Step
+// 20a: the POS sale's plan (pos-data.ts) reads them too.
+export function balancesOf(stock: MockStock) {
   const byPlace = new Map<string, string>();
   const byBatch = new Map<string, string>();
   for (const movement of stock.movements) {
@@ -759,7 +760,7 @@ function nextNumber(
   );
 }
 
-interface Move {
+export interface Move {
   line: number;
   warehouseId: string;
   stockLine: StockLine;
@@ -774,7 +775,8 @@ interface Move {
 
 // The API's StockPostingService.post(), shortened: serial numbers and stock checked, the values
 // worked out (step 14), then the movements written (one per serial number for a serial product).
-// Returns each move's value.
+// Returns each move's value. Step 20a: `belowZero` skips the stock check for a POS sale, which is
+// never refused for stock (its plan already worked out what goes below zero).
 export function postMoves(
   data: WorkspaceData,
   posting: {
@@ -783,6 +785,7 @@ export function postMoves(
     direction: 'in' | 'out';
     documentId: string;
     number: string;
+    belowZero?: boolean;
   },
   moves: readonly Move[],
   receivingTransferId?: string,
@@ -818,7 +821,7 @@ export function postMoves(
         code: posting.direction === 'in' ? 'stock_serial_in_stock' : 'stock_serial_not_here',
       });
     }
-    if (posting.direction === 'out') {
+    if (posting.direction === 'out' && posting.belowZero !== true) {
       const key = `${move.warehouseId}|${move.stockLine.variantId}|${move.batchId ?? ''}`;
       const allowed = move.stockLine.tracking === 'none' && data.settings.allowNegativeStock;
       if (
```

- **`balancesOf()` is exported:** the sale's plan reads the same balances the stock posting checks, so both agree on
  what is in a warehouse.
- **`belowZero` on the posting, not a new function:** everything else a POS sale's movements need (the values at the
  average cost, one movement per serial number) is what `postMoves()` already does. Only the stock check is skipped,
  like the API's `belowZero` flag (decision 7): the plan worked out what goes below zero before.
- **`Move` is exported** so the plan's moves are typed as what `postMoves()` takes, not as a copy of its shape.

### `mocks/pos-data.ts` (new): registers, the sale, the lists

```ts
import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type Device,
  type ErrorCode,
  formatPosNumber,
  isZeroMoney,
  isWholeQuantity,
  moneyAccountIds,
  negateMoney,
  POS_PAYMENT_METHODS,
  type PosOverride,
  posChangeOf,
  posOverridesOf,
  type PosRegister,
  type PosRegisterInput,
  type PosRegisterListItem,
  type posRegisterListQuerySchema,
  type PosSale,
  type PosSaleInput,
  type PosSaleLine,
  posSaleAmounts,
  posSaleLineSchema,
  type posSaleListQuerySchema,
  type PosSalePage,
  posSaleSummarySchema,
  shiftIsoDate,
  type SoldShortItem,
  soldShortItemSchema,
  type soldShortQuerySchema,
  type SoldShortPage,
  stockLineSchema,
  subtractQuantity,
  sumMoney,
  todayIn,
  type UpdatePosRegisterInput,
  wholeCount,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { codeOf } from './accounting-data';
import { OWNER } from './fixtures';
import { salesAccounts } from './invoice-data';
import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import {
  customerOf,
  deliveryAccounts,
  fieldProblem,
  newestFirst,
  pageOf,
  resolveSalesLines,
} from './sales-document-data';
import { balancesOf, branchOf, issuesError, type Move, postMoves } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 20a: the POS registers, who holds them, and the sales the devices push. The
// API's pos-registers.service.ts and pos-sales.service.ts on plain arrays, shortened. A sale is
// written only by the push (push-data.ts calls createSale), like the API (decision 21). The audit
// rows are written by the callers (handlers.ts, push-data.ts), which import workspace-data.ts:
// this file is imported by it, for the seed.

// A register without its branch: the branch is its warehouse's, worked out when it is read, so a
// warehouse moved to another branch takes its free registers along (the API joins warehouses)
export type MockRegister = Omit<PosRegister, 'branchId'>;

// A sale's line as the mock keeps it: the contract's line, plus what the Sold short list reads
// (the API's short_serials column, and the lot of the batch that went below zero)
export interface MockPosLine extends PosSaleLine {
  shortSerials: string[];
  shortLot: string | null;
}

// The device by its id: its name is the one it has now when the sale is read
export type MockPosSale = Omit<PosSale, 'lines' | 'device'> & {
  deviceId: string;
  lines: MockPosLine[];
};

export interface MockPos {
  registers: MockRegister[];
  // Newest first: a new sale is put first
  sales: MockPosSale[];
}

export function emptyPos(): MockPos {
  return { registers: [], sales: [] };
}

function now(): string {
  return new Date().toISOString();
}

// "7.5" → "7.50", the way Postgres sends NUMERIC(5,2). The schema let only 0–100 with at most 2
// decimals through, so the whole part is a plain number.
function percentText(value: string): string {
  const [whole = '0', part = ''] = value.split('.');
  return `${String(Number(whole))}.${part.padEnd(2, '0')}`;
}

// --- The seed -----------------------------------------------------------------------------------

function register(fields: Omit<MockRegister, 'id' | 'archivedAt' | 'version' | 'updatedAt'>) {
  return { id: crypto.randomUUID(), ...fields, archivedAt: null, version: 1, updatedAt: now() };
}

// The garments maker sells its export surplus at a factory outlet in the head office: the
// showroom counter is free, so this browser's device can take it; the outlet's second counter is
// held by the store office PC (seedDevices()), and stays in the list with that name. The
// Chattogram depot's counter was held by the depot computer revoked 12 days ago: the revoke freed
// it, and its numbers go on from 1,260. The pharma distributor has one counter at its depot.
// After seedDevices(): the outlet's counter names one of its devices.
export function seedPos(data: WorkspaceData, garments: boolean): void {
  const byCode = (code: string) => data.stock.warehouses.find((place) => place.code === code);
  const account = (code: string) => data.accounts.find((row) => row.code === code)?.id ?? null;
  const main = byCode('MAIN');
  const cash = account('1110');
  if (!main || cash === null) return;
  const card = account('1121');
  if (!garments) {
    data.pos.registers.push(
      register({
        code: 'POS1',
        name: 'Pharmacy counter',
        warehouseId: main.id,
        accounts: { cash, card, bkash: null, nagad: null },
        maxDiscountPercent: '5.00',
        paperWidth: '80',
        receiptFooter: 'Medicines once sold are not taken back. Keep this receipt for your doctor.',
        deviceId: null,
        lastNumber: 0,
      }),
    );
    return;
  }
  const storePc = data.sync.devices.find((device) => device.name === 'Store office PC');
  const depot = byCode('CTG');
  data.pos.registers.push(
    register({
      code: 'POS1',
      name: 'Showroom counter',
      warehouseId: main.id,
      accounts: { cash, card, bkash: null, nagad: null },
      maxDiscountPercent: '10.00',
      paperWidth: '80',
      receiptFooter: 'Goods once sold are exchanged within 7 days with this receipt.',
      deviceId: null,
      lastNumber: 0,
    }),
    register({
      code: 'POS2',
      name: 'Factory outlet counter',
      warehouseId: main.id,
      accounts: { cash, card: null, bkash: null, nagad: null },
      maxDiscountPercent: '5.00',
      paperWidth: '58',
      receiptFooter: null,
      deviceId: storePc?.id ?? null,
      lastNumber: 214,
    }),
  );
  if (depot) {
    data.pos.registers.push(
      register({
        code: 'CTG1',
        name: 'Depot counter',
        warehouseId: depot.id,
        accounts: { cash, card: null, bkash: null, nagad: null },
        maxDiscountPercent: '0.00',
        paperWidth: '80',
        receiptFooter: null,
        deviceId: null,
        lastNumber: 1260,
      }),
    );
  }
}

// --- Registers ----------------------------------------------------------------------------------

function branchOfRegister(data: WorkspaceData, stored: MockRegister): string {
  // A warehouse is never deleted, so a register's warehouse is always there
  const branchId = branchOf(data, stored.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${stored.warehouseId} of a register is gone`);
  return branchId;
}

export function toRegister(data: WorkspaceData, stored: MockRegister): PosRegister {
  return { ...stored, branchId: branchOfRegister(data, stored) };
}

export function findRegister(data: WorkspaceData, id: string): MockRegister {
  const found = data.pos.registers.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// By code, with who holds it: the device's name and its person
export function listRegisters(
  data: WorkspaceData,
  query: z.output<typeof posRegisterListQuerySchema>,
): PosRegisterListItem[] {
  return data.pos.registers
    .filter((item) => (item.archivedAt === null) === (query.status === 'active'))
    .map((item) => toRegister(data, item))
    .filter((item) => query.branchId === undefined || item.branchId === query.branchId)
    .toSorted((a, b) => a.code.localeCompare(b.code))
    .map((item) => {
      const device = data.sync.devices.find((candidate) => candidate.id === item.deviceId);
      const person = data.people.members.find((member) => member.userId === device?.userId);
      return {
        ...item,
        holder: device && person ? { deviceName: device.name, userName: person.fullName } : null,
      };
    });
}

// What the audit log shows of a register's form, like the API's snapshot(): the warehouse and the
// accounts by their codes
export function registerSnapshot(
  data: WorkspaceData,
  stored: MockRegister,
): Record<string, string | null> {
  return {
    name: stored.name,
    warehouse: data.stock.warehouses.find((place) => place.id === stored.warehouseId)?.code ?? null,
    cashAccount: codeOf(data.accounts, stored.accounts.cash),
    cardAccount: codeOf(data.accounts, stored.accounts.card),
    bkashAccount: codeOf(data.accounts, stored.accounts.bkash),
    nagadAccount: codeOf(data.accounts, stored.accounts.nagad),
    maxDiscountPercent: stored.maxDiscountPercent,
    paperWidth: stored.paperWidth,
    receiptFooter: stored.receiptFooter,
  };
}

type RegisterFields = Omit<PosRegisterInput, 'code'>;

// The API's create() and update() checks, all but the code: an active warehouse when it is new or
// changed, a held register kept in its device's branch, and every account a money account
function checkFields(data: WorkspaceData, fields: RegisterFields, before?: MockRegister): void {
  if (before?.warehouseId !== fields.warehouseId) {
    const place = data.stock.warehouses.find(
      (candidate) => candidate.id === fields.warehouseId && candidate.archivedAt === null,
    );
    if (!place) throw fieldProblem('pos_register_warehouse_invalid', 'warehouseId');
    if (before && before.deviceId !== null && place.branchId !== branchOfRegister(data, before)) {
      throw fieldProblem('pos_register_branch', 'warehouseId');
    }
  }
  const money = moneyAccountIds(data.accounts);
  const bad = POS_PAYMENT_METHODS.filter((method) => {
    const id = fields.accounts[method];
    return id !== null && !money.has(id);
  });
  if (bad.length > 0) {
    throw new MockProblem(
      409,
      'pos_register_account_invalid',
      Object.fromEntries(
        bad.map((method) => [`accounts.${method}`, ['pos_register_account_invalid' as const]]),
      ),
    );
  }
}

function formOf(fields: RegisterFields) {
  return {
    name: fields.name,
    warehouseId: fields.warehouseId,
    accounts: fields.accounts,
    maxDiscountPercent: percentText(fields.maxDiscountPercent),
    paperWidth: fields.paperWidth,
    receiptFooter: fields.receiptFooter,
  };
}

export function createRegister(data: WorkspaceData, input: PosRegisterInput): MockRegister {
  if (data.pos.registers.some((item) => item.code === input.code)) {
    throw fieldProblem('pos_register_code_taken', 'code');
  }
  checkFields(data, input);
  const created: MockRegister = {
    id: crypto.randomUUID(),
    code: input.code,
    ...formOf(input),
    deviceId: null,
    lastNumber: 0,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
  data.pos.registers.push(created);
  return created;
}

// The code is not in the input: it is on every receipt the register printed
export function updateRegister(
  data: WorkspaceData,
  target: MockRegister,
  input: Omit<UpdatePosRegisterInput, 'version'>,
): void {
  checkFields(data, input, target);
  Object.assign(target, formOf(input), { version: target.version + 1, updatedAt: now() });
}

// Decision 33: not while a device holds it. A register comes back only to an active warehouse.
export function setRegisterArchived(
  data: WorkspaceData,
  target: MockRegister,
  archived: boolean,
): void {
  if ((target.archivedAt !== null) === archived) return;
  if (archived && target.deviceId !== null) throw new MockProblem(409, 'pos_register_in_use');
  if (
    !archived &&
    !data.stock.warehouses.some(
      (place) => place.id === target.warehouseId && place.archivedAt === null,
    )
  ) {
    throw fieldProblem('pos_register_warehouse_invalid', 'warehouseId');
  }
  Object.assign(target, {
    archivedAt: archived ? now() : null,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// Decision 14: a device takes a register only when no device holds it. Taking the one it holds
// answers it as it is (a claim sent again). No version change: who holds it is not part of the
// form (decision 43). Returns whether the device took it now, for the audit row.
export function claimRegister(data: WorkspaceData, target: MockRegister, device: Device): boolean {
  if (target.deviceId === device.id) return false;
  if (target.archivedAt !== null) throw new MockProblem(409, 'pos_register_archived');
  if (target.deviceId !== null) throw new MockProblem(409, 'pos_register_in_use');
  if (branchOfRegister(data, target) !== device.branchId) {
    throw new MockProblem(409, 'pos_register_branch');
  }
  if (data.pos.registers.some((item) => item.deviceId === device.id)) {
    throw new MockProblem(409, 'pos_device_has_register');
  }
  Object.assign(target, { deviceId: device.id, updatedAt: now() });
  return true;
}

// A free register answers as it is (a release sent again); one another device holds is not this
// device's to free. Returns whether it was let go now.
export function releaseRegister(target: MockRegister, device: Device): boolean {
  if (target.deviceId === null) return false;
  if (target.deviceId !== device.id) throw new MockProblem(409, 'pos_register_not_held');
  Object.assign(target, { deviceId: null, updatedAt: now() });
  return true;
}

// Migration 0052's triggers: revoking a device, or moving it to another branch, frees the register
// it holds. No audit row (decision 51).
export function releaseHeldBy(data: WorkspaceData, deviceId: string): void {
  for (const item of data.pos.registers) {
    if (item.deviceId === deviceId) Object.assign(item, { deviceId: null, updatedAt: now() });
  }
}

// A held register keeps its warehouse in the device's branch (the API's warehouses_register_held,
// mapped to warehouse_branch_locked)
export function assertNoHeldRegister(data: WorkspaceData, warehouseId: string): void {
  if (
    data.pos.registers.some((item) => item.warehouseId === warehouseId && item.deviceId !== null)
  ) {
    throw fieldProblem('warehouse_branch_locked', 'branchId');
  }
}

// An account a register or a POS payment names stays (the API's foreign keys, account_in_use)
export function usedByPos(data: WorkspaceData, accountId: string): boolean {
  return (
    data.pos.registers.some((item) =>
      POS_PAYMENT_METHODS.some((method) => item.accounts[method] === accountId),
    ) ||
    data.pos.sales.some((sale) => sale.payments.some((payment) => payment.accountId === accountId))
  );
}

// --- The sale's stock (the API's planSale) ------------------------------------------------------

interface Plan {
  moves: Move[];
  batches: { batchId: string; quantity: string }[];
  shortQuantity: string;
  shortSerials: string[];
}

const NO_STOCK: Plan = { moves: [], batches: [], shortQuantity: '0', shortSerials: [] };

// What can be taken of `wanted` from `left`: none below zero
function takeable(left: string, wanted: string): string {
  if (compareQuantity(left, '0') <= 0) return '0';
  return compareQuantity(left, wanted) < 0 ? left : wanted;
}

// Where each goods line leaves from (decisions 7 and 15): an untracked item from the warehouse,
// what is missing below zero (none is "short" when the workspace allows below zero); a batch item
// from the device's batch, then the others by FEFO (none expired), the rest below zero on the
// device's batch; a serial item with the serial numbers that are in this warehouse, the others
// leave without one. The lines are planned in order, each from what the ones before left.
function planSale(
  data: WorkspaceData,
  warehouseId: string,
  date: string,
  lines: readonly { stockLine: z.output<typeof stockLineSchema>; goods: boolean }[],
): Plan[] {
  const { byBatch } = balancesOf(data.stock);
  const keyOf = (variantId: string, batchId: string | null) =>
    `${warehouseId}|${variantId}|${batchId ?? ''}`;
  const left = new Map(byBatch);
  const leftOf = (variantId: string, batchId: string | null) =>
    left.get(keyOf(variantId, batchId)) ?? '0';
  const take = (variantId: string, batchId: string | null, quantity: string) => {
    left.set(keyOf(variantId, batchId), subtractQuantity(leftOf(variantId, batchId), quantity));
  };

  return lines.map(({ stockLine, goods }, line): Plan => {
    if (!goods) return NO_STOCK;
    const { variantId, baseQuantity } = stockLine;
    const move = (batchId: string | null, quantity: string, serialNumbers: string[] = []) => ({
      line,
      warehouseId,
      stockLine,
      batchId,
      quantity,
      serialNumbers,
    });

    if (stockLine.tracking === 'batch') {
      // createSale() refused a batch line without a batch (stock_batch_required)
      const own = stockLine.batchId;
      if (own === null) throw new Error(`POS line ${String(line)} has no batch`);
      const taken = new Map<string, string>();
      const add = (batchId: string, quantity: string) => {
        if (compareQuantity(quantity, '0') <= 0) return;
        taken.set(batchId, addQuantity(taken.get(batchId) ?? '0', quantity));
        take(variantId, batchId, quantity);
      };
      let wanted = baseQuantity;
      const first = takeable(leftOf(variantId, own), wanted);
      add(own, first);
      wanted = subtractQuantity(wanted, first);
      const others = data.stock.batches
        .filter(
          (batch) =>
            batch.variantId === variantId &&
            batch.id !== own &&
            (batch.expiresOn === null || batch.expiresOn >= date),
        )
        .toSorted(
          (a, b) =>
            (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31') ||
            a.lotNumber.toLowerCase().localeCompare(b.lotNumber.toLowerCase()),
        );
      for (const other of others) {
        if (compareQuantity(wanted, '0') <= 0) break;
        const part = takeable(leftOf(variantId, other.id), wanted);
        add(other.id, part);
        wanted = subtractQuantity(wanted, part);
      }
      add(own, wanted);
      const parts = [...taken].map(([batchId, quantity]) => ({ batchId, quantity }));
      return {
        moves: parts.map((part) => move(part.batchId, part.quantity)),
        batches: parts,
        shortQuantity: wanted,
        shortSerials: [],
      };
    }

    const short = subtractQuantity(baseQuantity, takeable(leftOf(variantId, null), baseQuantity));
    take(variantId, null, baseQuantity);

    if (stockLine.tracking === 'serial') {
      const isHere = (serial: string) =>
        data.stock.serials.get(`${variantId}|${serial}`) === warehouseId;
      const found = stockLine.serialNumbers.filter(isHere);
      const missing = stockLine.serialNumbers.filter((serial) => !isHere(serial));
      return {
        moves: [
          ...(found.length > 0 ? [move(null, addQuantity(String(found.length), '0'), found)] : []),
          ...(missing.length > 0 ? [move(null, addQuantity(String(missing.length), '0'))] : []),
        ],
        batches: [],
        shortQuantity: short,
        shortSerials: missing,
      };
    }

    return {
      moves: [move(null, baseQuantity)],
      batches: [],
      shortQuantity: data.settings.allowNegativeStock ? '0' : short,
      shortSerials: [],
    };
  });
}

function isShort(line: { shortQuantity: string; shortSerials: readonly string[] }): boolean {
  return compareQuantity(line.shortQuantity, '0') > 0 || line.shortSerials.length > 0;
}

// --- The sale (the API's createFromDevice) ------------------------------------------------------

// One pos_sale.create command's work, inside push-data.ts's transaction(): the checks, the stock
// moved (below zero when it must), the entry, the sale written. Never refused for stock or for its
// date (decisions 7 and 26). Returns what the audit log and the bell need.
export function createSale(
  data: WorkspaceData,
  deviceId: string,
  saleId: string,
  input: PosSaleInput,
): { sale: MockPosSale; overrides: PosOverride[]; shortLines: number } {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  // Decision 44: only the device that holds the register numbers its sales
  if (target?.deviceId !== deviceId) throw fieldProblem('pos_register_not_held', 'registerId');
  const register = toRegister(data, target);
  const number = formatPosNumber(register.code, input.sequence);

  // Decision 34: the register's account for each method now
  const missing = input.payments.flatMap((payment, index) =>
    register.accounts[payment.method] === null ? [`payments.${String(index)}.method`] : [],
  );
  if (missing.length > 0) {
    throw new MockProblem(
      409,
      'pos_method_not_set',
      Object.fromEntries(missing.map((path) => [path, ['pos_method_not_set' as const]])),
    );
  }

  // Archived since the sale: kept, it was sold already (the ids sent are the kept ones)
  const customer =
    input.customerId === null ? null : customerOf(data, input.customerId, input.customerId);
  const resolved = resolveSalesLines(
    data,
    input.lines,
    input.pricesIncludeVat,
    new Set(input.lines.map((line) => line.taxRateId)),
    new Set(input.lines.map((line) => line.variantId)),
  );
  // The API's checkTracking(): a batch item names one of its batches, a serial item one serial
  // number per base unit
  const issues: { path: string; code: ErrorCode }[] = [];
  resolved.forEach(({ line }, index) => {
    const sent = input.lines[index];
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    if (line.productType !== 'goods' || !sent) return;
    if (line.tracking === 'batch') {
      if (sent.batchId === null) at('batchId', 'stock_batch_required');
      else if (
        !data.stock.batches.some(
          (batch) => batch.id === sent.batchId && batch.variantId === line.variantId,
        )
      ) {
        at('batchId', 'stock_batch_invalid');
      }
    }
    if (
      line.tracking === 'serial' &&
      (!isWholeQuantity(line.baseQuantity) ||
        wholeCount(line.baseQuantity) !== sent.serialNumbers.length)
    ) {
      at('serialNumbers', 'stock_serial_count');
    }
  });
  if (issues.length > 0) throw issuesError(issues);
  // Decision 34: impossible while one device holds the register, so a bug
  if (data.pos.sales.some((sale) => sale.number === number)) {
    throw fieldProblem('pos_number_taken', 'sequence');
  }

  const amounts = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const paid = sumMoney(input.payments.map((payment) => payment.amount));
  const change = posChangeOf(input.payments, amounts.totals.total);
  // Decision 26: the device's day, unless its clock is ahead of today or the day is locked
  const today = todayIn(data.settings.timezone);
  const soldOn = input.date > today ? today : input.date;
  const { lockDate } = data.journal;
  const date = lockDate !== null && soldOn <= lockDate ? shiftIsoDate(lockDate, 1) : soldOn;

  const lines = resolved.map(({ line }, index) => {
    const sent = input.lines[index];
    const goods = line.productType === 'goods';
    return {
      goods,
      // The line as the stock posting reads it; the schema's parse leaves out the sales fields
      stockLine: stockLineSchema.parse({
        ...line,
        batchId: goods && line.tracking === 'batch' ? (sent?.batchId ?? null) : null,
        lotNumber: null,
        expiresOn: null,
        manufacturedOn: null,
        serialNumbers: goods && line.tracking === 'serial' ? (sent?.serialNumbers ?? []) : [],
      }),
    };
  });
  const plans = planSale(data, register.warehouseId, input.date, lines);
  const values = postMoves(
    data,
    {
      date,
      kind: 'pos_sale',
      direction: 'out',
      documentId: saleId,
      number,
      belowZero: true,
    },
    plans.flatMap((plan) => plan.moves),
  );
  // postMoves() answers in the order of the moves: each line's cost is the sum of its own
  let next = 0;
  const costs = plans.map((plan) => {
    const own = values.slice(next, next + plan.moves.length);
    next += plan.moves.length;
    return sumMoney(own);
  });

  // The books (decision 29): the money in, the sale and its VAT, the cost of the goods
  const books = salesAccounts(data);
  const branchId = register.branchId;
  const cost = sumMoney(costs);
  const goodsAccounts = isZeroMoney(cost) ? null : deliveryAccounts(data);
  const cashAccount = register.accounts.cash;
  const entry = postStockEntry(data, {
    date,
    source: 'pos_sale',
    document: { id: saleId, number },
    narration: `POS sale ${number}`,
    amounts: [
      ...input.payments.map((payment) => ({
        accountId: register.accounts[payment.method] ?? cashAccount,
        branchId,
        amount: payment.amount,
      })),
      ...(compareMoney(change, '0') > 0
        ? [{ accountId: cashAccount, branchId, amount: negateMoney(change) }]
        : []),
      { accountId: books.sales, branchId, amount: negateMoney(amounts.totals.net) },
      { accountId: books.vatOutput, branchId, amount: negateMoney(amounts.totals.vat) },
      ...(goodsAccounts === null
        ? []
        : [
            { accountId: goodsAccounts.costOfGoodsSold, branchId, amount: cost },
            { accountId: goodsAccounts.inventory, branchId, amount: negateMoney(cost) },
          ]),
    ],
  });

  const saleLines = resolved.map(({ line }, index): MockPosLine => {
    const sent = input.lines[index];
    const lineAmounts = amounts.lines[index];
    const plan = plans[index] ?? NO_STOCK;
    if (!sent || !lineAmounts) throw new Error(`POS line ${String(index)} has no input`);
    const batchOf = (batchId: string | null) =>
      data.stock.batches.find((batch) => batch.id === batchId);
    return {
      ...line,
      // The device's rate and the amounts worked out with it (decision 22)
      taxRate: { ...line.taxRate, rate: sent.rate },
      net: lineAmounts.net,
      vat: lineAmounts.vat,
      total: lineAmounts.total,
      billDiscount: lineAmounts.billDiscount,
      startingPrice: sent.startingPrice === null ? null : addMoney(sent.startingPrice, '0'),
      batches: plan.batches.map((part) => ({
        batchId: part.batchId,
        lotNumber: batchOf(part.batchId)?.lotNumber ?? '',
        expiresOn: batchOf(part.batchId)?.expiresOn ?? null,
        quantity: addQuantity(part.quantity, '0'),
      })),
      serialNumbers: line.tracking === 'serial' ? sent.serialNumbers : [],
      shortQuantity: addQuantity(plan.shortQuantity, '0'),
      shortSerials: plan.shortSerials,
      shortLot:
        line.tracking === 'batch' && compareQuantity(plan.shortQuantity, '0') > 0
          ? (batchOf(sent.batchId)?.lotNumber ?? null)
          : null,
    };
  });

  const sale: MockPosSale = {
    id: saleId,
    number,
    register: { id: register.id, code: register.code, name: register.name },
    branchId,
    warehouseId: register.warehouseId,
    date,
    soldAt: input.soldAt,
    customer,
    cashier: { id: OWNER.id, fullName: OWNER.fullName },
    net: amounts.totals.net,
    vat: amounts.totals.vat,
    total: amounts.totals.total,
    lineCount: saleLines.length,
    soldShort: saleLines.some(isShort),
    createdAt: now(),
    pricesIncludeVat: input.pricesIncludeVat,
    discount: amounts.totals.discount,
    billDiscountType: input.billDiscountType,
    billDiscount: addMoney(input.billDiscount, '0'),
    billDiscountAmount: amounts.totals.billDiscount,
    paid,
    change,
    lines: saleLines,
    payments: input.payments.map((payment) => ({
      method: payment.method,
      amount: addMoney(payment.amount, '0'),
      reference: payment.reference,
      accountId: register.accounts[payment.method] ?? cashAccount,
    })),
    deviceId,
    entry,
  };
  data.pos.sales.unshift(sale);
  // The database moves the last number with the sale (0052's pos_sales_last_number)
  keepNumber(data, input);

  // Decision 30: the bell, to the people who put stock right. The mock's person is the owner, who
  // is always one of them. Last: nothing after it can throw, so a refused sale rings nothing.
  const short = saleLines.filter(isShort);
  if (short.length > 0) {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'pos.sold_short',
      params: {
        id: saleId,
        number,
        warehouse:
          data.stock.warehouses.find((place) => place.id === register.warehouseId)?.name ?? '',
        count: new Set(short.map((line) => line.variantId)).size,
      },
      readAt: null,
      createdAt: now(),
    });
  }
  return {
    sale,
    overrides: posOverridesOf(input, register.maxDiscountPercent),
    shortLines: short.length,
  };
}

// Decision 37: a refused sale's receipt was printed, so its number is used too. Only up, without a
// version, like the API's keepNumber().
export function keepNumber(data: WorkspaceData, input: { registerId: string; sequence: number }) {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  if (target && target.lastNumber < input.sequence) target.lastNumber = input.sequence;
}

// "price on line 2, bill discount": the audit log's text, counted from 1 like the receipt
export function overrideText(overrides: readonly PosOverride[]): string {
  return overrides
    .map((override) =>
      override.kind === 'bill_discount'
        ? 'bill discount'
        : `${override.kind} on line ${String(override.line + 1)}`,
    )
    .join(', ');
}

// --- What the managers read ---------------------------------------------------------------------

export function findSale(data: WorkspaceData, id: string): MockPosSale {
  const found = data.pos.sales.find((sale) => sale.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The schemas' parse leaves out what only the mock keeps (shortSerials, shortLot)
export function toPosSale(data: WorkspaceData, stored: MockPosSale): PosSale {
  const { deviceId, lines, ...rest } = stored;
  const device = data.sync.devices.find((candidate) => candidate.id === deviceId);
  return {
    ...rest,
    lines: lines.map((line) => posSaleLineSchema.parse(line)),
    device: { id: deviceId, name: device?.name ?? '' },
  };
}

export function listSales(
  data: WorkspaceData,
  query: z.output<typeof posSaleListQuerySchema>,
): PosSalePage {
  const matching = data.pos.sales.filter(
    (sale) =>
      (query.registerId === undefined || sale.register.id === query.registerId) &&
      (query.customerId === undefined || sale.customer?.id === query.customerId),
  );
  const page = pageOf(newestFirst(matching), query);
  return {
    ...page,
    items: page.items.map((sale) => posSaleSummarySchema.parse(toPosSale(data, sale))),
  };
}

// Every line that went below zero or left without its serial numbers, newest sale first, with the
// variant's stock in that warehouse now (every batch together)
export function soldShortList(
  data: WorkspaceData,
  query: z.output<typeof soldShortQuerySchema>,
): SoldShortPage {
  const { byPlace } = balancesOf(data.stock);
  const rows = newestFirst(data.pos.sales)
    .filter((sale) => query.warehouseId === undefined || sale.warehouseId === query.warehouseId)
    .flatMap((sale) =>
      sale.lines.filter(isShort).map((line): SoldShortItem =>
        soldShortItemSchema.parse({
          ...line,
          lineId: line.id,
          saleId: sale.id,
          saleNumber: sale.number,
          date: sale.date,
          warehouseId: sale.warehouseId,
          shortQuantity: line.shortQuantity,
          lotNumber: line.shortLot,
          serialNumbers: line.shortSerials,
          onHandNow: addQuantity(byPlace.get(`${sale.warehouseId}|${line.variantId}`) ?? '0', '0'),
        }),
      ),
    );
  return pageOf(rows, query);
}
```

**Why this file has no `record()`:** `workspace-data.ts` imports it for the seed, and `record()` lives in
`workspace-data.ts`. A value import back would be an import circle, like the one step 18c's `device-data.ts` avoids. So
this file only changes the data, and its callers (`handlers.ts`, `push-data.ts`) write the audit rows.

**The registers:**

- **`MockRegister` has no `branchId`:** the branch is the warehouse's, worked out when a register is read
  (`toRegister()`). Stored, it would go stale when a free register's warehouse moves to another branch; the API joins
  the warehouse for the same reason.
- **The seed (decision 74):** POS1 is free, so the test's device can take it; POS2 is held by the Store office PC, so the
  chooser shows a register the device cannot take and the registers page shows a holder; CTG1 is free with a last
  number of 1,260, as after the revoke of the depot's computer (decision 14). The pharma workspace has one counter.
- **`percentText()`:** the schema gives "7.5" or "0"; the API sends NUMERIC(5,2) as "7.50" and "0.00". The form and
  the discount check read the API's form.
- **`checkFields()` checks the warehouse only when it is new or changed,** like the API: an archived warehouse keeps
  the registers it has. A held register's warehouse stays in its device's branch (`pos_register_branch`).
- **`claimRegister()` and `releaseRegister()` return whether they changed anything,** so the handler writes an audit
  row only for a real claim or release, not for one sent again. Neither changes the version (decision 43).
- **`releaseHeldBy()`** is the API's database trigger: a revoked device, or one moved to another branch, frees its
  register.

**The sale:**

- **`planSale()` follows the API's plan line by line** (decision 15): the lines are planned in order, each from what the
  ones before left, so two lines of one item cannot both take the last piece. `takeable()` never takes from a balance
  that is already below zero.
- **The batch order is FEFO with expired batches left out,** except the device's own batch, which goes first even if it
  expired: it is the one the cashier scanned.
- **A serial number not in this warehouse leaves without its serial number** and is kept in `shortSerials`, which only
  the mock stores beside the contract's line (`MockPosLine`). The Sold short list reads it.
- **`createSale()` checks in the API's order:** the holder, the methods, the customer, the lines, their tracking, the
  number. A sale is refused only for these; never for stock or its date (decisions 7 and 26).
- **The date:** the device's day, unless its clock is ahead of today; a day on or before the lock date moves to the day
  after it (the mock has only the lock date, not the closed years).
- **The entry is `postStockEntry()`,** which sums per account: two cash payments are one line, the change is a minus on
  the cash account, and a sale that cost nothing has no cost lines.
- **The line keeps the device's VAT rate** (decision 22) in `taxRate.rate`, and its amounts are the ones worked out with
  it, not the rate's value now.
- **`keepNumber()` runs for a refused sale too** (decision 37): its receipt was printed, so the number is used.
- **The bell is the last thing a sale does:** nothing after it can throw, so a refused sale rings nothing.
- **`toPosSale()` and the lists parse with the contract's schemas:** the parse leaves out what only the mock keeps
  (`shortSerials`, `shortLot`), and `reply()` would otherwise send it.

### `mocks/workspace-data.ts`: the data, the seed, the transaction

```diff
@@ -41,6 +41,7 @@ import { emptyBilling, type MockBilling } from './invoice-data';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
+import { emptyPos, type MockPos, seedPos } from './pos-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import { seedPurchaseOrders } from './purchase-order-data';
 import type { MockExport } from './report-data';
@@ -100,6 +101,8 @@ export interface WorkspaceData {
   purchase: MockPurchase;
   // The devices and what their pulls left them with (step 18a)
   sync: MockSync;
+  // POS registers and the sales their devices pushed (step 20a)
+  pos: MockPos;
 }
 
 function now(): string {
@@ -190,6 +193,7 @@ function seed(workspace: Workspace): WorkspaceData {
     suppliers: emptySuppliers(),
     purchase: emptyPurchase(),
     sync: emptySync(),
+    pos: emptyPos(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   data.salesAccounts = seedSalesAccounts(data.accounts);
@@ -211,6 +215,8 @@ function seed(workspace: Workspace): WorkspaceData {
   seedBills(data, garments);
   // Step 18c: after the team, whose people own them
   if (garments) seedDevices(data);
+  // Step 20a: after the devices and the stock: a counter is held by one of them, in a warehouse
+  seedPos(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -278,6 +284,8 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.purchase = emptyPurchase();
   // The seeded devices belong to the people and branches just removed
   data.sync = emptySync();
+  // A new shop adds its counters in Settings → POS registers
+  data.pos = emptyPos();
   // Sign-up gives a new workspace its Main store, in its one branch (like auth.service.ts)
   data.stock = emptyStock();
   const [first] = data.branches;
@@ -301,6 +309,8 @@ export function transaction<T>(data: WorkspaceData, fn: () => T): T {
     // Step 17b: a goods receipt moves its order's received quantities and takes a number. Step
     // 17c: a bill makes a goods receipt and marks receipt lines billed; a payment pays bills.
     purchase: data.purchase,
+    // Step 20a: a POS sale moves stock, posts an entry and writes the sale; a refused one none
+    pos: data.pos,
     audit: data.audit,
   });
   try {
```

- **`seedPos()` runs after `seedDevices()`:** POS2's holder is one of the seeded devices. A signed-up workspace starts
  with no counters.
- **`transaction()` copies `data.pos` too:** a refused sale must leave no sale and no moved last number behind; the
  stock and the journal were already in the copy.

### `mocks/sync-data.ts`: the registers in the pull

```diff
@@ -13,6 +13,7 @@ import {
   type SyncCommandType,
   type SyncEntity,
   type SyncNotice,
+  syncPosRegisterSchema,
   type SyncPull,
   syncSettingsSchema,
   type SyncStock,
@@ -296,6 +297,21 @@ function rowsOf(data: WorkspaceData, tenantId: string, branchId: string): SyncUp
       key: warehouse.id,
       data: warehouse,
     })),
+    // Step 20a: the active registers of the branch, by their warehouse's branch (an archived
+    // warehouse keeps its register, like the API's loader). The parse leaves out the last number:
+    // it moves with every sale, and the device counts its own.
+    ...data.pos.registers.flatMap((register) => {
+      const place = stock.warehouses.find((warehouse) => warehouse.id === register.warehouseId);
+      if (register.archivedAt !== null || place?.branchId !== branchId) return [];
+      return [
+        {
+          op: 'upsert' as const,
+          entity: 'pos_register' as const,
+          key: register.id,
+          data: syncPosRegisterSchema.parse({ ...register, branchId }),
+        },
+      ];
+    }),
     ...sales.priceLists.map((list) => ({
       op: 'upsert' as const,
       entity: 'price_list' as const,
```

- **After the warehouses, like `SYNC_ENTITIES`:** a register points at its warehouse.
- **By the warehouse's branch, archived warehouse or not:** the API's loader keeps a register whose warehouse was
  archived, so the device can still send the sales of it.
- **`syncPosRegisterSchema.parse()` leaves out `lastNumber`:** it moves with every sale, so every sale would send every
  register again, and the device counts its own numbers anyway.

### `mocks/push-data.ts`: the sale command

```diff
@@ -26,6 +26,7 @@ import {
 import type { z } from 'zod';
 
 import { MockProblem } from './mock';
+import { createSale, keepNumber, overrideText } from './pos-data';
 import { type MockCustomer, refreshPartyRefs, saveCustomer } from './sales-data';
 import { createOrder } from './sales-document-data';
 import { copyToSupplier } from './supplier-data';
@@ -37,6 +38,7 @@ import { diff, record, transaction, type WorkspaceData } from './workspace-data'
 // does not stop the ones after it. Each answer is kept by the command's id (MockSync.answers), so
 // a batch sent again after a lost answer changes nothing twice. The mock's person is the owner,
 // who has every permission, so the per-command permission check (decision 17) is left out.
+// Step 20a: a POS sale (pos-data.ts's createSale) is posted when it arrives.
 
 type PushInput = z.output<typeof syncPushInputSchema>;
 type PushedCommand = PushInput['commands'][number];
@@ -91,6 +93,9 @@ function run(
   } catch (error) {
     // A rule of the mock refused it: kept as refused. Anything else is a bug in the mock.
     if (!(error instanceof MockProblem)) throw error;
+    // Step 20a (decision 37): the refused sale's receipt was printed, so its number stays used.
+    // After transaction() put everything back, like the API's keepNumber() after the savepoint.
+    if (command.type === 'pos_sale.create') keepNumber(data, command.input);
     const refusal: SyncCommandError = {
       code: error.code,
       ...(error.fieldErrors && { fieldErrors: error.fieldErrors }),
@@ -102,7 +107,14 @@ function run(
 }
 
 function entityOf(command: SyncCommand): string {
-  return command.type === 'sales_order.create_draft' ? command.orderId : command.customerId;
+  switch (command.type) {
+    case 'sales_order.create_draft':
+      return command.orderId;
+    case 'pos_sale.create':
+      return command.saleId;
+    default:
+      return command.customerId;
+  }
 }
 
 function refused(id: string, error: SyncCommandError): SyncResult {
@@ -111,14 +123,14 @@ function refused(id: string, error: SyncCommandError): SyncResult {
 
 // An accepted answer brings the customer as it is now, also when it is sent again (decision 18):
 // an old answer never puts an older row back on the device. Archived since: a delete, like in a
-// delta pull. An order brings nothing: orders are not on the device.
+// delta pull. An order and a POS sale bring nothing: they are not on the device.
 function answerOf(data: WorkspaceData, id: string, answer: MockAnswer): SyncResult {
   if (answer.status === 'rejected') return refused(id, answer.error);
   return { id, status: 'accepted', notices: answer.notices, changes: changesOf(data, answer) };
 }
 
 function changesOf(data: WorkspaceData, answer: MockAnswer): SyncChange[] {
-  if (answer.type === 'sales_order.create_draft') return [];
+  if (answer.type === 'sales_order.create_draft' || answer.type === 'pos_sale.create') return [];
   const found = data.sales.customers.find((item) => item.id === answer.entityId);
   // Not found (undefined), or archived
   if (found?.archivedAt !== null) {
@@ -184,6 +196,58 @@ function apply(
       record(data, 'sales_order.created', 'sales_order', created.id, {}, device);
       return [];
     }
+    case 'pos_sale.create': {
+      if (data.pos.sales.some((sale) => sale.id === command.saleId)) {
+        throw new MockProblem(409, 'sync_id_taken');
+      }
+      const { sale, overrides, shortLines } = createSale(
+        data,
+        device.id,
+        command.saleId,
+        command.input,
+      );
+      record(
+        data,
+        'pos_sale.created',
+        'pos_sale',
+        sale.id,
+        diff(
+          {},
+          {
+            number: sale.number,
+            date: sale.date,
+            soldOn: command.input.date,
+            register: sale.register.code,
+            customer: sale.customer?.code ?? null,
+            total: sale.total,
+            paid: sale.paid,
+            entry: sale.entry?.number ?? null,
+            soldShort: shortLines,
+          },
+        ),
+        device,
+      );
+      // Decision 25: written, never a refusal. The mock's owner has pos.price.override.
+      if (overrides.length > 0) {
+        const register = data.pos.registers.find((item) => item.id === sale.register.id);
+        record(
+          data,
+          'pos_sale.overridden',
+          'pos_sale',
+          sale.id,
+          diff(
+            {},
+            {
+              overrides: overrideText(overrides),
+              maxDiscountPercent: register?.maxDiscountPercent ?? null,
+              allowed: true,
+            },
+          ),
+          device,
+        );
+      }
+      return [];
+    }
   }
 }
 
```

- **`entityOf()` is a `switch`:** with three commands, the ternary read every command that is not an order as a
  customer, which a POS sale is not (this was the type error).
- **`keepNumber()` after `transaction()` put everything back,** like the API's call after the savepoint rolled back.
- **`sync_id_taken` for a sale id that is there:** the same rule as a new customer or order (decision 20 of step 18b). A
  command sent again never gets here: its kept answer is found first.
- **The audit rows are the API's** (`pos_sale.created`, and `pos_sale.overridden` when there was an override). The mock's
  person is the owner, so `allowed` is always true.
- **An accepted sale's answer brings no rows,** like an order: sales are not on the device.

### `mocks/device-data.ts` and `mocks/sales-data.ts`

```diff
@@ -11,6 +11,7 @@ import type { z } from 'zod';
 
 import { OWNER } from './fixtures';
 import { MockProblem } from './mock';
+import { releaseHeldBy } from './pos-data';
 import { checkVersion, diff, record, type WorkspaceData } from './workspace-data';
 
 // The mock's step 18c (decisions 1–4): the two device lists, rename, move and revoke. The devices
@@ -155,6 +156,8 @@ export function moveDevice(
     // The next pull is a full pull of the new branch: sync-data.ts's pull compares the branch its
     // cursor was made for
     Object.assign(device, { branchId: branch.id, version: device.version + 1 });
+    // Step 20a: its register stays in the old branch, so it is free for another device there
+    releaseHeldBy(data, id);
   }
   return toListItem(data, device);
 }
@@ -171,6 +174,8 @@ export function revokeDevice(
   const revokedAt = now();
   Object.assign(device, { revokedAt, version: device.version + 1 });
   data.sync.revokedBy.set(id, OWNER.id);
+  // Step 20a: a lost or broken PC is revoked, and its counter is free for the next one
+  releaseHeldBy(data, id);
   record(data, 'device.revoked', 'device', id, { revokedAt: { from: null, to: revokedAt } });
   return {
     device: toListItem(data, device),
```

```diff
@@ -628,7 +628,8 @@ export function refreshPartyRefs(data: WorkspaceData, saved: PartyRef): void {
   }
 }
 
-// Every document that names a customer: step 15b's, 15c's and 15d's
+// Every document that names a customer: step 15b's, 15c's and 15d's, and step 20a's POS sales that
+// are not a walk-in's
 function salesDocumentsOf(data: WorkspaceData): { customer: PartyRef }[] {
   const { quotations, orders, deliveries } = data.salesDocuments;
   const { invoices, receipts } = data.billing;
@@ -642,6 +643,9 @@ function salesDocumentsOf(data: WorkspaceData): { customer: PartyRef }[] {
     ...salesReturns,
     ...creditNotes,
     ...refunds,
+    ...data.pos.sales.filter(
+      (sale): sale is typeof sale & { customer: PartyRef } => sale.customer !== null,
+    ),
   ];
 }
 
```

- **A move or a revoke frees the register** (20a.2's triggers): a lost PC is revoked, and its counter is free for the
  next device. Without this, revoking the Store office PC on the Devices page would leave POS2 held for good.
- **A POS sale with a customer counts as one of the customer's documents:** the customer cannot be deleted
  (`customer_in_use`), and a rename shows on the sale. A walk-in sale names nobody.

### `mocks/handlers.ts`: the routes

```diff
@@ -312,8 +312,25 @@ import {
   renameDevice,
   revokeDevice,
 } from './device-data';
+import {
+  assertNoHeldRegister,
+  claimRegister,
+  createRegister,
+  findRegister,
+  findSale,
+  listRegisters,
+  listSales,
+  registerSnapshot,
+  releaseRegister,
+  setRegisterArchived,
+  soldShortList,
+  toPosSale,
+  toRegister,
+  updateRegister,
+  usedByPos,
+} from './pos-data';
 import { push } from './push-data';
-import { deviceKey, pull, registerDevice } from './sync-data';
+import { deviceFor, deviceKey, pull, registerDevice } from './sync-data';
 import {
   assertCodeFree,
   checkVersion,
@@ -1239,7 +1256,9 @@ export const handlers = [
       }
       if (
         data.journal.entries.some((entry) => entry.lines.some((line) => line.accountId === id)) ||
-        usedByPurchase(data, id)
+        usedByPurchase(data, id) ||
+        // Step 20a: a POS register's account, or one a POS sale was paid into
+        usedByPos(data, id)
       ) {
         throw new MockProblem(409, 'account_in_use');
       }
@@ -2080,6 +2099,8 @@ export const handlers = [
       if (data.stock.warehouses.some((place) => place.code === fields.code && place.id !== id)) {
         throw new MockProblem(409, 'warehouse_code_taken', { code: ['warehouse_code_taken'] });
       }
+      // Step 20a: a register a device holds keeps its warehouse in that device's branch
+      if (fields.branchId !== target.branchId) assertNoHeldRegister(data, id);
       Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
       record(data, 'warehouse.updated', 'warehouse', id);
       return reply(routes.warehouses.update, target);
@@ -5077,4 +5098,144 @@ export const handlers = [
       return reply(routes.devices.revoke, device);
     }),
   ),
+
+  // Step 20a: the POS registers (pos-data.ts). Reading needs no permission, like the API; the
+  // mock's person is the owner, who has pos.register.manage and pos.sale.create.
+  mock(routes.pos.listRegisters, async ({ request }) => {
+    const query = readQuery(routes.pos.listRegisters.query, request);
+    await delay();
+    return reply(routes.pos.listRegisters, { items: listRegisters(current(), query) });
+  }),
+
+  mock(
+    routes.pos.getRegister,
+    guarded(({ params }) => {
+      const { id } = routes.pos.getRegister.params.parse(params);
+      const data = current();
+      return reply(routes.pos.getRegister, toRegister(data, findRegister(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.pos.createRegister,
+    guarded(async ({ request }) => {
+      const input = await readBody(routes.pos.createRegister.body, request);
+      const data = current();
+      const created = createRegister(data, input);
+      record(
+        data,
+        'pos_register.created',
+        'pos_register',
+        created.id,
+        diff({}, { code: created.code, ...registerSnapshot(data, created) }),
+      );
+      await delay();
+      return reply(routes.pos.createRegister, toRegister(data, created));
+    }),
+  ),
+
+  mock(
+    routes.pos.updateRegister,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.pos.updateRegister.params.parse(params);
+      const { version, ...input } = await readBody(routes.pos.updateRegister.body, request);
+      const data = current();
+      const target = findRegister(data, id);
+      checkVersion(target.version, version);
+      const before = registerSnapshot(data, target);
+      updateRegister(data, target, input);
+      record(
+        data,
+        'pos_register.updated',
+        'pos_register',
+        id,
+        diff(before, registerSnapshot(data, target)),
+      );
+      await delay();
+      return reply(routes.pos.updateRegister, toRegister(data, target));
+    }),
+  ),
+
+  ...(['archiveRegister', 'restoreRegister'] as const).map((action) =>
+    mock(
+      routes.pos[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.pos[action].params.parse(params);
+        const { version } = await readBody(routes.pos[action].body, request);
+        const data = current();
+        const target = findRegister(data, id);
+        checkVersion(target.version, version);
+        const archived = action === 'archiveRegister';
+        const changes = (target.archivedAt !== null) !== archived;
+        setRegisterArchived(data, target, archived);
+        if (changes) {
+          record(
+            data,
+            archived ? 'pos_register.archived' : 'pos_register.restored',
+            'pos_register',
+            id,
+          );
+        }
+        return reply(routes.pos[action], toRegister(data, target));
+      }),
+    ),
+  ),
+
+  // Decision 14: the device is the signed-in person's own and not revoked (the pull's check)
+  mock(
+    routes.pos.claimRegister,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.pos.claimRegister.params.parse(params);
+      const { deviceId } = await readBody(routes.pos.claimRegister.body, request);
+      const data = current();
+      const device = deviceFor(data, OWNER.id, deviceId);
+      const target = findRegister(data, id);
+      if (claimRegister(data, target, device)) {
+        record(data, 'pos_register.claimed', 'pos_register', id, {
+          device: { from: null, to: device.name },
+        });
+      }
+      await delay();
+      return reply(routes.pos.claimRegister, toRegister(data, target));
+    }),
+  ),
+
+  mock(
+    routes.pos.releaseRegister,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.pos.releaseRegister.params.parse(params);
+      const { deviceId } = await readBody(routes.pos.releaseRegister.body, request);
+      const data = current();
+      const device = deviceFor(data, OWNER.id, deviceId);
+      const target = findRegister(data, id);
+      if (releaseRegister(target, device)) {
+        record(data, 'pos_register.released', 'pos_register', id, {
+          device: { from: device.name, to: null },
+        });
+      }
+      return reply(routes.pos.releaseRegister, toRegister(data, target));
+    }),
+  ),
+
+  // The sales the devices pushed (push-data.ts writes them), and the lines that went below zero
+  mock(routes.pos.listSales, async ({ request }) => {
+    const query = readQuery(routes.pos.listSales.query, request);
+    await delay();
+    return reply(routes.pos.listSales, listSales(current(), query));
+  }),
+
+  mock(
+    routes.pos.getSale,
+    guarded(({ params }) => {
+      const { id } = routes.pos.getSale.params.parse(params);
+      const data = current();
+      return reply(routes.pos.getSale, toPosSale(data, findSale(data, id)));
+    }),
+  ),
+
+  mock(routes.pos.soldShort, async ({ request }) => {
+    const query = readQuery(routes.pos.soldShort.query, request);
+    await delay();
+    return reply(routes.pos.soldShort, soldShortList(current(), query));
+  }),
 ];
```

- **Twelve handlers, in the contract's order,** at the end of the list. Reading needs no permission; the mock's person
  is the owner, who has `pos.register.manage` and `pos.sale.create`.
- **The claim and the release check the device with `deviceFor()`,** the pull's own check: another person's device is
  `device_not_found`, a revoked one `device_revoked`.
- **The archive and restore handler is one, for both routes,** like the warehouses'; it writes the audit row only when
  the state changed.
- **An account a register or a POS payment names cannot be deleted** (`account_in_use`), and **a warehouse with a held
  register keeps its branch** (`warehouse_branch_locked` on `branchId`): the API's foreign key and trigger.

### `mocks/offline-screens.ts`: the POS offline

```diff
@@ -26,6 +26,11 @@ const SCREENS = [
   // dialog (a change with the current PIN works offline)
   () => import('../components/lock-screen'),
   () => import('../components/pin-dialog'),
+  // Step 20a: the POS screen sells from the device's copy, and its payment, done dialog and
+  // receipt are a chunk of their own (taking a register needs a connection, so not its chooser)
+  () => import('../routes/pos'),
+  () => import('../components/pos-pay'),
+  () => import('../components/pos-receipt'),
 ];
 
 // Once, by main.tsx's enableMocking. The dev server is on this computer, so it does not fail.
```

- **The POS screen and its payment chunk:** the test goes offline after the screen is open, and the payment dialog's
  code loads only when Pay is pressed. Without it in this list, mock mode cannot load it offline (step 19a's decision
  11). The register chooser is left out: taking a register needs a connection.

### `e2e/pos.e2e.ts` (new)

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

// Step 20a: the POS. The garments workspace's head office has two counters in its main store
// (src/mocks/pos-data.ts → seedPos): POS1 Showroom counter, free, and POS2 Factory outlet counter,
// held by Abdul Karim's Store office PC. The Chattogram depot has CTG1. This browser's device is in
// the head office (helpers.ts), takes POS1, and its first receipt is POS1-000001. A crew-neck
// T-shirt is ৳320 before VAT at 15% (the garments workspace prices before VAT), so two are ৳736.
//
// The receipt prints with window.print(), which would open the browser's print dialog: each test
// replaces it with a counter on <body> before the app starts, and reads the counter.

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

// "POS" alone: "POS sales" and "POS registers" are links too
async function openPos(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'POS', exact: true }).click();
}

// The register chooser, once per device (decision 14)
async function takeRegister(page: Page, label: string, toast: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Which counter is this?' })).toBeVisible();
  await page.getByLabel('Register').selectOption({ label });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await toastShown(page, toast);
  await expect(page.getByRole('searchbox', { name: 'Scan or search' })).toBeFocused();
}

// The Pay button: in the cart on a desktop, in the bar at the bottom on a phone
function payButton(page: Page, amount: string) {
  return page.getByRole('button', { name: `Pay ${amount}` }).filter({ visible: true });
}

// On a phone the cart is a bar until it is opened; a desktop shows it beside the products
async function openCart(page: Page, testInfo: TestInfo, count: string): Promise<void> {
  if (isPhone(testInfo)) await page.getByRole('button', { name: new RegExp(`^${count}`) }).click();
  await expect(page.getByRole('complementary', { name: 'Cart' })).toBeVisible();
}

// Out of the POS (it has no sidebar), then a page of the shell from its nav
async function leavePos(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, name);
}

test('takes a register, sells for cash and prints the receipt', async ({ page }, testInfo) => {
  await openPos(page);
  // POS2 stays in the list with its holder: the claim would say pos_register_in_use
  await expect(page.getByLabel('Register').getByRole('option')).toContainText([
    'Pick a register',
    'POS1 · Showroom counter',
    'POS2 · held by Store office PC',
  ]);
  await takeRegister(
    page,
    'POS1 · Showroom counter',
    'This device is POS1 now. The next receipt is POS1-000001.',
  );

  // A scanner types the barcode and Enter; the box empties for the next scan
  const search = page.getByRole('searchbox', { name: 'Scan or search' });
  await search.fill('8941100500118');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await expect(payButton(page, '৳368')).toBeEnabled();
  // A tile adds one more of the same item to its line
  await search.fill('crew-neck');
  await page.getByRole('button', { name: /^Basic crew-neck T-shirt P-/ }).click();
  await expect(payButton(page, '৳736')).toBeEnabled();
  await openCart(page, testInfo, '1 item');
  await expect(page.getByRole('complementary', { name: 'Cart' })).toContainText('Walk-in customer');
  await expectNoSideScroll(page);

  await payButton(page, '৳736').click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  // The notes the customer handed over: one tap, and the change shows
  await pay.getByRole('button', { name: '৳1,000' }).click();
  await expect(pay).toContainText('Change৳264');
  await pay.getByRole('button', { name: 'Complete sale' }).click();

  const done = page.getByRole('dialog', { name: 'POS1-000001 is done' });
  await expect(done).toContainText('Give back ৳264 in cash');
  await expectPrinted(page, 1);
  await done.getByRole('button', { name: 'Print again' }).click();
  await expectPrinted(page, 2);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(done).toBeHidden();
  // The top bar's next number (a phone's bar has no room for it)
  if (!isPhone(testInfo)) await expect(page.getByText('Next receipt POS1-000002')).toBeVisible();

  // Online, the sale went at once: the server posted it, with its entry
  await leavePos(page, 'POS sales');
  const row = listItem(page, /POS1-000001/);
  await expect(row).toContainText('Walk-in');
  await expect(row).toContainText('৳736');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-000001' })).toBeVisible();
  await expect(page.getByText('Basic crew-neck T-shirt')).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-\d{4}$/ })).toBeVisible();
  // The receipt again, from the sale's page
  await page.getByRole('button', { name: 'Print receipt' }).click();
  await expectPrinted(page, 3);
  await expectNoSideScroll(page);
});

test('sells offline, and lists the serial number that was not in the store', async ({
  page,
}, testInfo) => {
  await openPos(page);
  await takeRegister(
    page,
    'POS1 · Showroom counter',
    'This device is POS1 now. The next receipt is POS1-000001.',
  );
  await page.context().setOffline(true);

  // The sewing machine has no price: the cashier types one (not an override). Its line opens at
  // once for the serial numbers; 0199 is not in the main store, so the server lets it leave
  // without its serial number and lists it (decision 15).
  await page.getByRole('searchbox', { name: 'Scan or search' }).fill('Juki');
  const machine = page.getByRole('button', { name: /^Juki DDL-8000A lockstitch machine P-/ });
  await expect(machine).toContainText('3 pcs');
  await machine.click();
  await openCart(page, testInfo, '1 item');
  const cart = page.getByRole('complementary', { name: 'Cart' });
  await cart.getByLabel('Price').fill('85000');
  await cart.getByLabel('Serial numbers').fill('JK8000-24-0117\nJK8000-24-0199');
  // Two machines at ৳85,000 + 15% VAT
  await payButton(page, '৳1,95,500').click();

  // Split: a card for most of it, the rest in cash
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await pay.getByLabel('Amount').fill('5500');
  await pay.getByRole('button', { name: 'Add another method' }).click();
  await expect(pay.getByLabel('Paid by').nth(1)).toHaveValue('card');
  await expect(pay.getByLabel('Amount').nth(1)).toHaveValue(/1,90,000|190000/);
  await pay.getByLabel('Reference').nth(1).fill('Card ending 4821');
  await pay.getByRole('button', { name: 'Complete sale' }).click();

  const done = page.getByRole('dialog', { name: 'POS1-000001 is done' });
  await expect(done).toContainText('No change to give');
  await expect(done).toContainText('Saved on this device. It syncs when the connection is back.');
  await expectPrinted(page, 1);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(
    page.getByRole('link', { name: 'Sync: Offline, 1 change waiting', exact: true }),
  ).toBeVisible();
  // The sale is not in the copy's stock yet, but the screen counts it: 1 machine is left, so the
  // last one cannot be sold twice
  await page.getByRole('searchbox', { name: 'Scan or search' }).fill('Juki');
  await expect(machine).toContainText('1 pcs');

  // Back online, the outbox sends it
  await page.context().setOffline(false);
  await expect(
    page.getByRole('link', { name: 'Sync: Online, All changes synced', exact: true }),
  ).toBeVisible();

  await leavePos(page, 'POS sales');
  const row = listItem(page, /POS1-000001/);
  await expect(row).toContainText('Sold short');
  await row.click();
  await expect(
    page.getByText(/^Some items were sold without stock at MAIN · Main store\./),
  ).toBeVisible();

  // The bell tells the people who put stock right (decision 30), and opens the list
  await page.getByRole('button', { name: 'Notifications, 4 unread' }).click();
  await page.getByText(/^POS1-000001 sold more than Main store had/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sold short' })).toBeVisible();
  await expect(listItem(page, /Juki DDL-8000A/)).toContainText(
    'Left without a serial number: JK8000-24-0199',
  );
  await expectNoSideScroll(page);
});

test('changes the register only when the server lets it go', async ({ page }) => {
  await openPos(page);
  await takeRegister(
    page,
    'POS1 · Showroom counter',
    'This device is POS1 now. The next receipt is POS1-000001.',
  );
  await page.getByRole('button', { name: 'Change register' }).click();
  // Free again: the chooser is back, and POS1 is not held by anyone
  await expect(page.getByRole('heading', { name: 'Which counter is this?' })).toBeVisible();
  await expect(page.getByLabel('Register').getByRole('option')).toContainText([
    'Pick a register',
    'POS1 · Showroom counter',
  ]);
  // Another device's register cannot be taken
  await page.getByLabel('Register').selectOption({ label: 'POS2 · held by Store office PC' });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await expect(
    page.getByText('Another device holds this register. Sign out on that device first'),
  ).toBeVisible();
});

test('adds a register, and keeps a held one from being archived', async ({ page }) => {
  await openFromNav(page, 'POS registers');
  await expect(listItem(page, /POS2/)).toContainText('Store office PC · Abdul Karim');
  await expect(listItem(page, /POS1/)).toContainText('Free');
  // The depot's counter, freed by the revoke of its computer, goes on from its last receipt
  await expect(listItem(page, /CTG1/)).toContainText('CTG1-001260');

  await page.getByRole('button', { name: 'Add register' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a register' });
  await dialog.getByLabel('Code').fill('pos3');
  await dialog.getByLabel('Name').fill('Export surplus counter');
  await dialog.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await dialog.getByLabel('Cash', { exact: true }).selectOption({ label: '1110 · Cash in hand' });
  await dialog.getByRole('button', { name: 'Add register' }).click();
  await toastShown(page, 'Export surplus counter added');
  // The code is upper case, as on every receipt
  await expect(listItem(page, /POS3/)).toContainText('No sale yet');

  // Its code is taken now
  await page.getByRole('button', { name: 'Add register' }).click();
  await dialog.getByLabel('Code').fill('POS3');
  await dialog.getByLabel('Name').fill('Second outlet counter');
  await dialog.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await dialog.getByLabel('Cash', { exact: true }).selectOption({ label: '1110 · Cash in hand' });
  await dialog.getByRole('button', { name: 'Add register' }).click();
  await expect(dialog.getByText('Another register uses this code.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Decision 33: only the device knows whether a sale of it still waits
  await listItem(page, /POS2/).click();
  const edit = page.getByRole('dialog', { name: 'Edit POS2' });
  await edit.getByRole('button', { name: 'Archive' }).click();
  await expect(edit.getByText('Another device holds this register.')).toBeVisible();
  await expectNoSideScroll(page);
});
```

- **`window.print()` becomes a counter** (decision 77), set by `addInitScript` before the app starts, so the receipt
  printed on mount is counted too.
- **`openPos()` uses `exact: true`:** "POS sales" and "POS registers" are links whose names contain "POS".
- **`payButton()` filters to the visible one:** a desktop's Pay is in the cart, a phone's in the bar at the bottom,
  and the hidden one is still in the page.
- **The first test sells by scanning:** the barcode and Enter, as a USB scanner types it, then a tile for one more of
  the same item. Then it checks what the server did with the sale: the list, the page, the entry, and the reprint.
- **The second test sells offline with a split payment.** "Add another method" starts the card at what is still due;
  the cash covers the rest. After the sale the machine's tile says 1 left, not 3 (decision 78): the copy has not heard
  of the sale, the screen has. Back online, the outbox sends the sale, and the serial number that is not in the main store
  shows on the sale, in the bell and on the Sold short list (decision 76).
- **The third test lets a register go and tries another device's:** the claim's refusal shows above the select.
- **The fourth test is the registers page:** the holder, the free one, the depot's numbers, a new register with its code
  made upper case, a taken code, and a held register that cannot be archived (decision 33).
- **Each test runs on the desktop and on the phone** (`openCart()` opens the phone's cart from its bar), and checks that
  the page never scrolls sideways.

### Check this part

```bash
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/app typecheck
pnpm exec eslint packages/sync/src/pos.ts packages/sync/src/pos.spec.ts apps/app/src/mocks apps/app/e2e/pos.e2e.ts
pnpm exec prettier --check apps/app/src/mocks apps/app/e2e/pos.e2e.ts
pnpm --filter @omnivo/app test
cd apps/app && pnpm exec playwright test -c e2e/playwright.config.ts pos.e2e.ts && cd ../..
```

All pass: 96 sync tests (1 new), 190 app unit tests, and the 4 POS tests on both screen sizes (8). The app's type check
passes again: the POS command no longer breaks `push-data.ts`. Broken on purpose: without `pos-pay` in
`offline-screens.ts`, the offline test fails when it presses Pay ("Failed to fetch dynamically imported module"); with
`stockOf()` ignoring the outbox, it fails at the tile ("3 pcs"). The bundle: the POS screen with its payment 113.4 KB
(budget 115). The app reads `@omnivo/sync` from its build, so `pnpm --filter @omnivo/sync build` runs before the
Playwright tests.

---

## 20a.8 — The real API, and every check once

This part changes no code. No API route, table, permission or role template changes here.

### The counter against the real API

The e2e tests sell against the mock API, and the integration tests send the sale command without a browser. So once,
the whole path ran in a real browser (Chromium, driven by a Playwright script that is not part of the guide) against
the real API: a production build of this guide's code with `VITE_API_URL` set to the API, served by `vite preview`,
the API and the worker built from this guide's code, and a throwaway Postgres and Valkey on other ports. "No
connection" meant three things at once, as in 19a.6: the API stopped, the preview server stopped, and the browser set
offline. The script:

1. **Set-up through the API:** a retail workspace, a bKash wallet account (1131), "Mango juice 250 ml" (৳25 before
   VAT, a barcode, 50 in stock at ৳15) and "Napa 500 mg strip" (batches: NP-B 4 pcs ending January 2027, NP-A 6 pcs
   ending June 2027), and a register typed as `pos1` with cash and bKash accounts, 5%, 80 mm and a footer. The code
   came back as `POS1`.
2. **The claim:** `/pos` asked "Which counter is this?" ("Not now" to the PIN first). After "Use this register", the
   toast said the next receipt is POS1-000001, the search box had the focus, and `pos_registers.device_id` was this
   device.
3. **Online sale:** the juice scanned twice (barcode + Enter), a Napa strip from its tile, Pay, "Exact amount",
   "Complete sale". "POS1-000001 is done", "No change to give", the receipt printed once with the register's footer.
   The server posted it: paid ৳92, one journal entry with cash 1110 Dr 92, sales 4110 Cr 80, VAT 2120 Cr 12, COGS 5110
   Dr 50 and inventory 1150 Cr 50. The Napa strip left from NP-B, the batch that ends first (FEFO). Last number 1.
4. **Offline sale:** three juices from the tile, ৳20 in cash, "Add another method" started bKash at what was left,
   TrxID BK7XQ2M4. "POS1-000002 is done" with "Saved on this device…", printed, and the sync line said 1 change
   waiting. The juice tile then said 45 pcs: 50, less 2 synced, less 3 waiting (decision 78).
5. **Sold short:** while the browser was offline, 46 juices were written off on the server, so 2 were left for a
   sale of 3. Online again, the sync line went back to "All changes synced", and the sale was posted anyway: line
   short by 1, juice on hand −1, payments cash ৳20 (1110) and bKash ৳66.25 (1131, its TrxID), and the
   `pos.sold_short` bell was there.
6. **The manager's pages:** "Leave the POS", POS sales listed both numbers; the bell's row opened Sold short with the
   juice.
7. **Sign-out:** no dialog (nothing waited), the sign-in page, and POS1 was free with last number 2.

No page error. The only failed requests were six 401s at the sign-out itself, from the page's open queries (see the
notes at the end); they are not new in this step.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

All passed, two of them only after a change or a second run:

- `pnpm test:openapi` failed: "openapi.json is out of date". 20a.1 had not generated it (see "What we found"); after
  `gen:openapi` it passes.
- `pnpm test:e2e`: the first try with four workers filled the machine's swap and then its disk, and was stopped. After
  a restart, with two workers (load about 27 at the start, Spotlight indexing), 321 passed, 1 skipped and 6 failed, all on desktop,
  on timeouts or a checkbox that did not change in time: bills (4), purchase orders and sales orders, none of them a
  POS file. All 6 passed when run again (load 6).

Everything else passed at the first run: `pnpm dedupe --check`, `pnpm format`, `pnpm lint`, `pnpm typecheck`,
`pnpm test` (761), `pnpm build`, `pnpm test:bundle-size` (first load 218.3 KB of 220; the POS screen with its payment
113.4 of 115; the worker's list 412 files, 1382.4 KB gz), `pnpm boundaries`, `pnpm test:integration` (590),
`pnpm test:tenant-leak` (118) and `pnpm test:e2e:pwa` (4, in 12 seconds).

---

## 20a.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after "App icon badge", add these entries. A pattern that is not listed there does
not exist for the next screen, and 20b's shift close and 20c's returns will reuse them:

> - **POS screen (`/pos`):** full screen inside `AppFrame` (the lock, the sync and the update notice still work), no
>   sidebar. A 56px `surface` top bar with a 1px `line` rule: "Leave the POS" (`ArrowLeft01`), a `brand` register pill
>   (`CashierIcon`, "POS1 · Front counter"), the cashier and the next receipt number in `ink-3` `tabular-nums` (hidden
>   as the screen narrows), the sync line, Change register (`ArrowLeftRight`) and a shortcuts icon button
>   (`Keyboard`). Below it, from 860px, the products on the left and a 400px cart on the right, each scrolling inside
>   itself (`h-dvh`; the page never scrolls). The search box ("Scan or search") has the focus; a scanner types the
>   barcode and Enter. Tiles: radius 10px, 1px `line`, the name (13.5px/500, two lines), the SKU in `Geist Mono` `ink-3`,
>   the price (600) and the stock (`ink-2`, or "Out of stock" on a disabled `subtle` tile when the workspace does not
>   sell below zero), two columns on a phone. Keys: F2 search, F4 customer, F7 bill discount, F12 pay, Enter complete
>   and new sale, `?` the shortcuts dialog.
> - **POS cart:** the customer box (walk-in by default), then one row per line that opens on a click
>   (`aria-expanded`): a quantity stepper that never goes below 1, "× ৳420 · bag", a `brand` "5% off" pill, the batch;
>   open, the quantity, price, discount, batch and serial boxes. A price the cashier may not change is read-only with
>   a 12px `ink-3` sentence saying why; over the register's limit, the discount says it needs `pos.price.override` and
>   Pay waits. The totals block on `subtle`: bill discount (`DiscountInput`), line discounts only when there are any,
>   VAT, the total at the KPI size, and "Pay ৳2,300" (primary, full width). On a phone the cart is a bar at the bottom
>   (count, total, Pay) that opens it over the products.
> - **Pay and done dialogs:** "Take payment": rows of method select, amount and reference (each method's own
>   placeholder, "TrxID BK7XQ2M4"), a remove icon button; cash first with the focus; note chips ("Notes the customer
>   gave", the filter chip style) and "Exact amount"; "Add another method" starts at what is still to pay; Still to
>   pay / Paid / Change on `subtle`; "Complete sale" (primary). Then "POS1-000123 is done": a 40px `good-bg` tile with
>   `CheckmarkCircle02`, "Give back ৳200 in cash" at the KPI size (or "No change to give"), "Saved on this device…"
>   when offline, "Print again" (secondary, `Printer`) and "New sale" (primary, with the focus).
> - **Register chooser ("Which counter is this?"):** a card (max 440px) in the screen's place with a `brand-soft`
>   `CashierIcon` tile, a select of the branch's registers that starts empty ("Pick a register"), a register held by
>   another device named "POS2 · held by Store office PC", and "Use this register" (primary). Online only; offline a
>   sentence with `WifiDisconnected02`. The toast: "This device is POS1 now. The next receipt is POS1-000001."
> - **Thermal receipt:** `PosReceipt` (`apps/app/src/components/pos-receipt.tsx`), a print sheet like `PrintSheet`:
>   `@page { size: auto; margin: 0 }`, 72mm wide on 80mm paper and 48mm on 58mm, black on white, no fills and no
>   logo. The company (legal name, address, BIN, phone), the number, counter, cashier, date and customer, the lines,
>   the totals, the payments and change, the register's footer, then "Thank you. Please come again." Amounts always
>   with 2 decimals. It prints by itself after a sale, once; a sale's page prints it again from a button.
> - **POS sale statuses:** Posted (`good`, `CheckmarkCircle02`), plus a second `warn` "Sold short" pill (`Alert02`)
>   when a line went below zero. A sold-short line: Below zero (`warn`, `TimeQuarterPass`) until the stock there is
>   back at zero or above, then Put right (`good`, `CheckmarkCircle02`).
> - **POS registers (Settings):** a data table (code, name, warehouse, holder "Front counter PC · Sumi Akter" or
>   "Free", last number, status) and a dialog form: code (shown, not a box, once saved), name, warehouse (starts
>   empty), an account per method (cash required, the others "Not taken here"), the most a cashier may take off (%),
>   paper width (58 / 80 mm) and the receipt's footer. A held register cannot be archived. Read-only without
>   `pos.register.manage`.

In the same section, add one sentence to the end of **Sync page (`/sync`)**:

> A POS sale ("Sale POS1-000124", "3 lines · ৳2,300") has no Edit, and Discard only once the server refused it.

In "Content and formatting", after **Money**, add:

> - **Money at the counter:** the POS screen shows whole taka unless an amount has paisa (`৳420`, `৳247.50`), so the
>   lines add up on the screen; the receipt always shows 2 decimals.

**docs/system-design.bn.md** — in ৭.৪, change the row "ইনভয়েস নম্বর ডুপ্লিকেট" to:

> | **ইনভয়েস নম্বর** ডুপ্লিকেট (দুই ডিভাইস একই নম্বর দিল) | রেজিস্টার-ভিত্তিক সিরিজ (ধাপ ২০a): প্রতিটা কাউন্টার একটা register (`POS1`), একসাথে শুধু একটা ডিভাইস সেটা ধরে রাখে, আর ডিভাইস নিজেই পরের নম্বর দেয় (`POS1-000123`)। অন্য ডিভাইস নেয় শুধু register খালি হলে: sign-out (কোনো বিক্রি বাকি না থাকলে), অন্য ব্রাঞ্চে সরানো বা revoke। সার্ভার শেষ নম্বরটা জানে, তাই নতুন ডিভাইস সেখান থেকে চালিয়ে যায় |

and change the row "স্টক নেগেটিভ" to:

> | **স্টক নেগেটিভ** (অফলাইনে দুই কাউন্টারে শেষ পিস বিক্রি) | POS বিক্রি সার্ভার কখনো স্টকের জন্য refuse করে না (ধাপ ২০a): স্টক শূন্যের নিচে যায়, batch/serial থাকলেও; "Sold short" তালিকায় ওঠে আর `inventory.stock.adjust`-ওয়ালাদের bell যায়। "negative stock allowed" বন্ধ থাকলে স্ক্রিন বিক্রির সময়েই ডিভাইসের কপি দেখে থামায়, ডিভাইসের নিজের না-পাঠানো বিক্রিও গুনে |

**docs/build-plan.bn.md** — under "ধাপ ২০: POS স্ক্রিন", after the paragraph that starts "দ্রুত বিক্রি স্ক্রিন",
add:

> - **বিক্রি (২০a):** register (কাউন্টার: warehouse, প্রতি পেমেন্ট মেথডের account, সর্বোচ্চ ছাড় %, কাগজ ৫৮/৮০ mm,
>   footer); একটা ডিভাইস একটা register ধরে রাখে আর নিজেই নম্বর দেয় (`POS1-000123`), sign-out-এ ছেড়ে দেয়। `/pos`
>   স্ক্রিন (shell ছাড়া, বারকোড, শর্টকাট), walk-in বা কাস্টমার, পুরো টাকা তখনই (ক্যাশ/কার্ড/bKash/Nagad, split,
>   ভাংতি), `pos_sale.create` সবসময় outbox দিয়ে; সার্ভারে নিজস্ব `pos_sales` ডকুমেন্ট, একটা journal entry আর স্টক,
>   স্টকের জন্য কখনো refuse না ("Sold short" + bell)। ব্রাউজার প্রিন্টে থার্মাল রিসিট। POS sales তালিকা, Settings →
>   POS registers।

**COMMANDS.md** — no change: this step adds no command.

---

## 20a.10 — Run it

```bash
pnpm db:migrate       # 0051 + 0052: the registers, the sales and their rules
pnpm dev
```

No new package, no new environment variable. The role templates change only for new retail workspaces: in an
existing workspace, give the three new permissions in Settings → Roles.

### What you will see

1. **A register:** Settings → POS registers → Add register. Code `pos1` (it becomes `POS1`), "Front counter", the
   MAIN warehouse, Cash at counter for cash, a bKash wallet account if you have one, 5% as the limit, 80 mm, a footer.
2. **Taking it:** POS in the sidebar (Sales). "Which counter is this?" → POS1 → "Use this register". The toast says
   the next receipt is POS1-000001. Settings → POS registers now shows this browser and you as its holder.
3. **A cash sale with the keyboard only:** type a product's name or its barcode and Enter, F12, type 1000, Enter. The
   done dialog says the change; the receipt prints (Chrome's print preview shows a narrow strip); Enter starts the
   next sale. Sales → POS sales lists it, and its page links its journal entry: the cash, the sale, the VAT and the
   cost in one.
4. **Offline:** DevTools → Network → Offline. Sell two of something with a split: some cash, the rest by bKash with
   a TrxID. "Saved on this device", and the sync line says 1 change waiting; the tile's stock already counts the sale.
   Online again, the sale goes and is posted.
5. **Sold short:** in another tab, take the item's stock to 1 with a stock adjustment while this one is offline, then
   sell 3 offline and go online. The sale is posted anyway, Stock → Sold short lists the line as "Below zero", and the
   bell tells you. Bring stock in: the line says "Put right".
6. **Letting go:** sign out (nothing waits, so no dialog). The register is free again in Settings → POS registers.
   Sign in as a Cashier on the same browser: POS1 again, and the next number goes on from where it was.
7. **A limit:** as a Cashier, 10% off a line says it needs `pos.price.override`, and Pay waits.
8. **Bangla** and **390px:** the screen, the cart bar, the dialogs and the receipt in Bangla, and no page scrolls
   sideways.
9. **A real printer (optional):** on the counter's PC, set the thermal printer's paper to 80 mm (or 58 mm) in its
   driver, and its "open cash drawer" option if it has one. Chrome started with `--kiosk-printing` prints without the
   dialog (decision 6).

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint                    # 6 GB heap for ESLint (19b decision 53)
pnpm format
pnpm typecheck
pnpm test                    # 761: contracts 310 + app 190 + api 123 + sync 96 + ui 19 + i18n 15 + auth 8
pnpm test:integration        # 590
pnpm test:tenant-leak        # 118
pnpm test:e2e                # 328: 164 flows × desktop and 390px (the sort test is skipped on the phone)
pnpm test:e2e:pwa            # 4: unchanged from 19b
pnpm build
pnpm test:bundle-size        # first load 218.3 KB gz (budget 220); the POS screen with its payment 113.4 (115); the worker's list 412 files, 1382.4 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **Zod runs an object's refinements even when a field failed** (20a.1): the sale's money rules read the lines and the
  payments, which may not be valid yet. `isComplete()` guards each rule, and a test sends a bad rate to prove it.
- **A deadlock between a revoke and a claim** (20a.2): a revoke locks the device, then its register (the trigger); a
  claim that locked the register first could wait for the revoke while it waited for the claim. Every path now locks
  the device first.
- **The push lost its answer when a sale did not add up** (20a.2, 20a.3): the sale's checks run at commit, after the
  savepoint that holds the command's work, so a broken sale failed the whole push (500) and its kept answer with it.
  `SET CONSTRAINTS ALL IMMEDIATE` at the end of the sale moves the failure inside the savepoint (decision 52).
- **A device copy from before step 19b could not be opened** (20a.6a): version 3's upgrade walked `TABLE_OF`, which now
  has the registers, a table version 3 does not have. The upgrade has its own fixed list (`VERSION_3_TABLES`).
- **The Sold short list had no key for a row** (20a.6b): one sale can sell the same item short on two lines. The row
  carries its line's id (decision 67).
- **The mock push read the customer at the command's top level** (20a.7): a POS sale has it inside `input`.
- **The same last item could be sold twice offline** (20a.7): the copy's stock does not hear of a sale until the server
  posts it. The screen subtracts the device's own sales in the outbox (decision 78).
- **A stale `openapi.json`** (20a.8): 20a.1 added the POS routes but did not run `gen:openapi`, so `pnpm test:openapi`
  failed at the end ("openapi.json is out of date"). 20a.1 now says to run it.

---

## Notes left for later steps

**Step 20b (shifts):**

- **The shift belongs to the register the device holds** (decision 32): one device, one register, one person at a time
  (decision 4). Opening a shift can ask for the claim first; closing it is the natural moment to let go.
- **A held bill is a new table on the device, so it is sealed** (19b): add it through `sealed.ts`. The claim row
  (`registerClaim`) is clear on purpose: it holds only ids and a number.
- **The idle lock is 19b's lock** (`lockNow()`), not a new one.
- **A POS device should have a PIN** (19b's note, still open): a till works offline all day, and without a PIN an
  offline reload does not open the copy. 20b can make "Not now" disappear on a device that holds a register.
- **The bundle has little room:** the first load is 218.3 KB of 220 KB and the POS screen with its payment
  113.4 KB of 115 KB. The shift close and the cash count belong in lazy chunks of their own.

**Step 20c (returns):**

- **A line keeps what its goods cost** (`pos_sale_lines.value`, decision 41) and the batches it left from
  (`pos_sale_line_batches`), so a return goes back at the same cost into the same batch.
- **The journal's Reverse refuses a POS sale's entry** (`journal_is_stock`): only a POS return undoes it.
- **The device does not keep its own sales after they sync:** the outbox entry goes when the server answers. Returns
  offline (decision 8) need a new pulled table of the register's last 30 days of sales.

**Known, not handled in 20a:**

- **Archiving a register's warehouse is not refused,** and archiving one of its accounts is not either: the register's
  next sale is then refused with the journal's own code, and waits as "Needs attention" until a manager gives the
  register another account. A check in the warehouse and account services (`pos_register_in_use`) would say it earlier.
- **A register let go by the database (a revoke or a move) has no audit row of its own** (decision 51): the device's
  audit row says why.
- **The sign-out sends a few requests that get a 401** (from 18c, not this step): `endSession()` clears the query
  cache while the page is still there, so its open queries fetch again with a token whose session just ended. The
  sign-in page then takes over and nothing shows. Clearing after the sign-in page is drawn would stop them.
- **A sale after a lost permission only reaches the audit log** (decision 28): nobody is told at the time. If owners
  want to hear of it, a bell like Sold short's can follow the same audit row.
