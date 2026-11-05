# Step 18a: The sync engine, part 1 — pulling the data onto the device

> The implementation guide for "Phase 6 → Step 18", the first of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 18 (the sync engine, `packages/sync`) is split into
> three guides: this one (pull: the server's data on the device, read from there), 18b (push: work done offline sent
> to the server as commands) and 18c (conflicts, the device list and the sync status).
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `d3a1571`, your commit named
> "purchase return accoutning code added": 17d's code and its doc updates) and checked on 2026-10-21:
> `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (585 — 46 new),
> `pnpm test:integration` (502 — 19 new; 501 pass, and one older test fails because of today's date, see below),
> `pnpm test:tenant-leak` (105 — 9 new), `pnpm build`, `pnpm test:bundle-size` (first load 205.4 KB gz, budget 210;
> the biggest lazy chunks the debit note lines, 104.4 KB, the AppShell, 103.2, and the sync host with Dexie, 103.1,
> budget 105), `pnpm gen:openapi` (209 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e`
> (Playwright, 266 — 8 new, desktop and 390px; 45 timed out on a swapping machine and passed when run again with 2
> workers) — with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres (18a.2): 64 checks of migrations 0043 and 0044 as
>   `omnivo_app` and `omnivo_worker` (what each write logs, a supplier never logged, archiving a product or a list,
>   a stock row at zero, the log that the app may not change, another workspace's lines), and a race in two sessions:
>   a slow transaction that commits after a fast one is never missed by the watermark, and is missed by a plain id
>   cursor.
> - **The pull against a real database** (18a.4): registering safe to repeat and refused for the wrong person or
>   branch, a full pull in pages of 1, 2, 3, 5 and 8 giving the same rows, every way a row leaves the data set,
>   another branch's stock never sent, a pull in progress keeping its end, old cursors, a device moved to another
>   branch, a slow transaction held open in another session, the log's cleanup, and another workspace trying every
>   route.
> - **The app against the real API in a browser** (18a.6): sign-up, the silent registration, the first pull, a delta
>   on focus, the local search, the balances, both lists offline, the branch dialog and "Not now", the customer box,
>   and sign-out deleting the copy.
> - **Rules broken on purpose:** three in the API (18a.4), two Bangla keys (18a.5), three in `packages/sync` (18a.6)
>   and three against the mock (18a.7). Each was caught by the test or the type check meant for it, except the
>   offline handler of the mock, which no test needs in 18a (said in 18a.7); the code was restored after each.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm install` and
> `pnpm db:migrate` (0043 and 0044) first, then restart `pnpm dev`. (2) **Other browsers:** the browser tests ran in
> Chromium only; Safari's and Firefox's IndexedDB and Web Locks were not tried. (3) **A real shop's size:** the mock's
> 10,000 styles copy in about 2.5 seconds, but a slow 3G line and a low-end Android phone were not tried. (4) **Two tabs:** the
> Web Lock that lets one tab pull at a time was not tested; the unit tests check one pull at a time within a tab. (5) The Bangla texts were
> written by me and not reviewed by a native speaker. (6) The new tests on GitHub Actions.
>
> **One older test fails since 21 Oct 2026, because of the date, not this step:** 15c's invoice list test expects an
> invoice due on 20 Oct not to be overdue yet. 17c's supplier payments test will fail the same way from 5 Nov.
> Details in "What we found on the way"; you chose to note them and fix them separately.

## Goal

📶 **The products and customers on the device.** Until now every list in Omnivo asked the server, page by page. When
the shop's connection drops, the product list, the customer box and the price of a carton are gone with it. This
step keeps a copy of that data in the browser (IndexedDB, through the Dexie library) and keeps it up to date: the
device asks the server "what changed since my last pull?" and gets only those rows.

After this step:

- **Every browser a person signs in on is a device** of that person, in one branch. With one branch it is registered
  without a question ("Chrome on Windows"); with more, the app asks once which branch the device is in.
- **The first pull brings the "POS-ready" data set** a page at a time: the active products with their variants, packs
  and barcodes, the price lists and their prices, the VAT rates, units and categories, the active customers with their
  groups, the warehouses of the device's branch and the stock in them, and the settings a sale needs.
- **Later pulls bring only what changed.** The database writes a line in a change log for every changed row, and the
  device keeps a cursor into that log. A pull runs when the app starts, when the connection comes back, when the window
  gets the focus again, and every 60 seconds while online.
- **The products and customers pages, and the product and customer pickers, read from the device**, online or not:
  search, sort and filter run in the browser, at once. With the network turned off, they still work. The archived tabs
  stay on the server, and the customers' balances come from the server for the rows on screen.

Nothing is written offline yet: that is 18b. A reload without a connection needs the service worker of step 19.

## The whole picture

```
packages/contracts   sync.ts (new): SYNC_PROTOCOL 1 · 11 entities and the shape of each row · the pull's page
      │               {changes, cursor, hasMore, full, serverTime} · a device · keys of a price and a stock row
      │               routes sync.registerDevice (POST /sync/devices) · sync.pull (GET /sync/pull)
      │               customers: GET /customer-balances?ids= (at most 100) · 6 errors · audit device.registered
      ▼
packages/db          sync_changes (the change log: entity, key, warehouse of a stock line, xid8 of the transaction)
      │               devices (a member's browser, its branch, last sync, revoked)
      │               0044: RLS · the app may not change the log · the worker's cleanup · sync_log(): 45 statement
      │               triggers on 15 tables + 3 for archiving a product or a list and renaming the workspace
      ▼
apps/api             sync/ (new): DevicesService (register, safe to repeat) · SyncService (full and delta pages,
      │               the watermark) · sync-rows.ts (one loader per entity) · sync-cursor.ts · the 30-day cleanup
      │               products, customers: productsOf(), customersOf(), shared by their pages and the pull
      │               customers: balances(ids)
      ▼
packages/sync        (new) the Dexie database, one per person and workspace · apply a page · the pull loop (one at a
      │               time, a Web Lock across tabs, wake on online/focus, every 60 s) · the device in localStorage
      │               · the reads: search, sort, pages, pickers (no Dexie in them)
      ▼
apps/app             LocalDataHost (lazy, in the AppShell, the only chunk with Dexie) · the branch dialog
                      products and customers pages, the customer box and "Add items" read the device
                      balances from the server for the rows on screen · sign-out deletes the copy

one device, from the first sign-in to a changed price:
  Nasrin signs in on Chrome at the Chattogram depot. The workspace has three branches ──► "Which branch is this
  device in?" ──► Chattogram depot
  POST /sync/devices {id: a UUIDv7 the browser made, name "Chrome on Windows", branchId} ──► a devices row, audit
     device.registered · the same id again (a lost answer) returns the same row
  first pull ──GET /sync/pull?deviceId&protocol=1──► no cursor: a full pull
     page 1 takes the watermark W = the oldest transaction still running (pg_snapshot_xmin)
     each entity in order, settings first and stock last, 500 rows a page; each page's cursor says where to go on
     the device writes each page in one IndexedDB transaction, marked with the pull's generation
     last page (hasMore false): rows of older generations are deleted · devices.last_sync_at = now()
  products page: 10,000 styles from IndexedDB, "polo" found as it is typed, sorted in the browser
  customers page: the rows from the device ──GET /customer-balances?ids=…──► the balances of the 100 on screen
  the head office changes the Wholesale price of a polo ──► the trigger on price_list_items writes one log line
     (price_list_item, its key, the writing transaction's xid)
  a minute later, or when the window gets the focus ──GET /sync/pull?cursor=…──► a delta pull:
     the log lines with W ≤ xid < the new watermark, in (xid, id) order
     each key is read again: still in the data set → an upsert; gone or out of it (archived, at zero) → a delete
  the Wi-Fi drops: the lists and pickers still work · the balance column shows a dash · the archived tab says
     "Needs a connection"
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Writing offline: customers, sales order drafts | 18b, as commands in an outbox |
| Two people changing the same customer | 18c's conflict rules (decision 4) |
| The device list, rename, move to another branch, revoke, the 24 h and 7 day limits | 18c. The devices table has the columns already |
| The sync status in the sidebar and the Sync page | 18c (decision 8) |
| Opening the app without a connection | Step 19: the service worker keeps the app's files. In 18a the app must be loaded while online |
| A PIN lock and encrypting the local data | Step 19 |
| Serial numbers on the device | The POS step (20) decides it with the sale screen. The stock rows hold quantities per batch |
| Suppliers, purchase documents, sales documents, reports on the device | Not field or shop work (system design §7.1). They stay on the server |
| PowerSync or ElectricSQL | System design §7.5: our own engine. `packages/sync` keeps it in one place, so it can be swapped later |

## What changes in the code you already have

- **Contracts:** a new `sync.ts` with the protocol version, the eleven entities and their rows, the pull's page and
  the device. Two routes, `sync.registerDevice` and `sync.pull`, and one for the customers, `GET /customer-balances`.
  Six error codes, an audit action (`device.registered`) and its entity type (`device`). No new permission
  (decision 21).
- **Database:** two new tables, `sync_changes` and `devices` (migrations 0043 and 0044). No existing table gets a
  column. Fifteen tables get three statement triggers each that write the change log; products, price lists and the
  workspace's name get one more each. Every write the API already makes now also writes a log line, in the same
  transaction; the integration suites pass unchanged.
- **API:** the products and customers services build their rows with `productsOf()` and `customersOf()`, shared with
  the pull; what their routes send is the same as before. The unit, VAT rate and warehouse services export the
  functions that shape their rows. A new `sync` module, a balances route on the customers controller, and the
  worker's hourly cleanup also deletes change log lines older than 30 days.
- **API tests:** two new files (the sync engine, and its tenant isolation) and one new test in the customers file.
- **i18n:** two new sections (`devices`, `sync`), six error texts, the audit texts, and the offline lines of the
  products and customers pages.
- **A new package, `packages/sync`,** with two new dependencies: `dexie` and, for its tests, `fake-indexeddb`. The
  boundaries rule for browser code covers it.
- **Screens:** the products and customers pages read their active tab from the device: the server's paging and
  sorting are gone from those tabs (the archived tabs keep them). The customer box on every form and the "Add items"
  dialog of sales and purchase lines read the device; the supplier box does not. `customerSearchQuery` is removed
  from `lib/queries.ts`. `api.ts` tells the sync code after each successful write, sign-out deletes the copy, and the
  AppShell loads the sync code in its own lazy chunk.
- **Mock API and e2e tests:** the mock (`pnpm dev:mock`) answers the device and pull routes and the balances, and
  fails every request while the browser is offline. Every Playwright file imports `test` from `e2e/helpers.ts` now,
  which gives each test a device of the head office. One new file tests the copy on the device.
- **OpenAPI document:** 3 new paths (209 in all); the audit log learns the `device` entity type.

## The decisions behind this step

You made the first twelve: decisions 1–9 on 2026-10-20 for the whole step, decisions 10–12 while the contract was
written. The others came up while building it; please read them with care: they are mine.

1. **Three guides.** (You chose this.) 18a pulls the data onto the device and reads it from there. 18b sends work done
   offline as commands. 18c handles conflicts, the devices and the sync status.
2. **The "POS-ready" data set.** (You chose this.) Active products with their variants, packs and barcodes, price
   lists and their prices, VAT rates, active customers with their groups, the warehouses of the device's branch and
   their stock, and the part of the settings a sale needs. Step 20's POS uses it as it is.
3. **The first offline work is customers and sales order drafts.** (You chose this.) Creating and changing a customer,
   and a sales order draft that gets its number when it reaches the server. That is 18b; no new business feature.
4. **Changing the same customer twice.** (You chose this.) A change sends only the fields it changed and the version it
   started from. Different fields both stay. The same field: the change that reaches the server last wins. Credit
   limit, terms, price list and group changed on the server since then: the server wins, and the person is told. No
   clocks are compared. That is 18c.
5. **The synced data is always read from the device.** (You chose this.) Lists, search, sort and the pickers, online or
   not, so there is one way to read them. The products and customers pages lose the server's paging. Other pages stay
   on the server.
6. **A refused command waits in the outbox.** (You chose this.) It says "needs attention" with its error; the person
   changes it and sends it again, or drops it. Only the commands that need it wait (an order for that new customer).
   That is 18b.
7. **Devices.** (You chose this.) One browser profile is one device: a name, a person, a branch, a last sync. A revoked
   device stops syncing and wipes its data. After 24 hours without a sync the app warns; after 7 days it stops offline
   work until a sync. The registry starts here; the rest is 18c.
8. **The sync status.** (You chose this.) Online or offline and "3 changes waiting" in the sidebar, and a Sync page.
   That is 18c; step 19 adds only the service worker.
9. **The device's branch.** (You chose this.) Members belong to no branch, so the device says where it is. Its
   warehouses and their stock are pulled, and (18b) its offline orders are made there.
10. **The customers' balances come from the server, for the rows on screen.** (You chose this in 18a.1.) The list
    reads its rows from the device and, online and with `sales.customer.balance`, asks `GET /customer-balances` for
    up to 100 of them at a time. Offline the column shows a dash and says balances need a connection. A balance
    changes with every invoice and receipt, and it is worked out from the journal: keeping it on the device would mean a
    change for every customer in every posting.
11. **The archived tabs stay on the server.** (You chose this in 18a.1.) Only active rows are on the device, so the
    "Archived" tab of products and customers is the old server list, online only. A garments company's old seasons
    would otherwise fill the device with styles nobody sells.
12. **A device is registered after sign-in, without a form when it can be.** (You chose this in 18a.1.) One active
    branch: the device is registered at once, named after the browser ("Chrome on Windows"). More: a dialog asks once
    which branch the device is in. Renaming and moving it come in 18c.

**The contract (18a.1):**

13. **One pull route, with an opaque cursor.** `GET /sync/pull` answers pages until `hasMore` is false. Without a cursor
    it is a full pull; with one, only the changes since. Only the server reads the cursor, so 18a.2 and 18a.3 can
    choose what is inside it without changing the contract.
14. **A row is a whole thing, not a database row.** A product comes with its variants, packs and barcodes, a customer
    with its addresses: the shapes the API already sends (`productSchema`, `customerSchema`). The device then reads
    them the way the forms already do, and a change to one variant sends its product again. Only a price and a stock
    row are rows of their own, keyed by their ids (`priceListItemKey`, `stockKey`).
15. **The counts and sums are left out.** A price list's item count, a group's customer count, a category's product
    count and a customer's balance change when another row changes. Keeping them would send the list again for every
    price. The device counts what it needs itself.
16. **A row is taken out when it leaves the data set,** not only when it is deleted: an archived product, a customer
    that is now only a supplier, a warehouse moved to another branch, a stock row at zero. The device does not need to
    know why.
17. **A full pull keeps what the device had until its last page.** The pages of a full pull say `full`; on the last
    one, the device drops every row the full pull did not send. A resync after a long time offline never shows empty
    lists while it runs.
18. **The protocol has a version** (`SYNC_PROTOCOL`). The rule of this codebase is that a newer server must not break an
    older offline client (that is why types and statuses are `z.string()`). For the entities themselves, the client
    sends the version it was built for, and the server refuses any other with `sync_protocol_mismatch`; the app then
    asks for a reload. A client on a new version starts again with a full pull.
19. **The server's clock, never the device's.** Each page says `serverTime`. The last sync, and the 24 hour and 7 day
    limits of 18c, are counted from it. A shop computer's clock is often wrong.
20. **The device id is made by the browser** (a UUIDv7), so a registration whose answer was lost registers the same
    device again, not a second one. Another person's id answers `device_not_found`, like an unknown one.
21. **No new permission.** Everyone who signs in may read products, customers, prices and stock already, so the pull
    sends the same data to everyone. The balances and the stock values, which need permissions, are not in it.
22. **The settings on the device** are the VAT rule, negative stock, the time zone, the currency and fiscal year, and
    the company's name, legal name, BIN, phone and address for a receipt. Not the logo: its link expires.
23. **A stock row carries its batch's lot number and dates,** so a sale can take the first to expire without a table of
    batches. No serial numbers (the POS step decides them), no cost.

**The database (18a.2):**

24. **One change log for all synced tables,** `sync_changes`, written by triggers: which entity, which key, and the id
    of the transaction that wrote it (`xid8`). A trigger also sees hard deletes and rows that leave the data set.
25. **The cursor is a transaction watermark, not a sequence number.** A plain sequence misses a slow transaction that
    commits after a faster one took a higher number. The pull returns the changes of the transactions that ended
    before the oldest one still running, and that oldest one is the next cursor. A change is never missed; at worst it
    comes one pull later.
26. **The log keeps 30 days.** A cursor older than that gets a full pull. The 7 day offline limit (decision 7) keeps
    that rare.
27. **A price and a stock row follow their product, and a price its list too.** They are on the device only while
    the product is active and the list is active. Nobody sells an archived product, and an archived list already falls
    back to the products' own prices on the server (`PriceLookupService`), so the device gives the same price without
    knowing the rule. A garments company's old seasons then leave the device with their prices. Archiving a product or a
    list sends its prices and its stock again, as deletes.
28. **One log line per key per statement, not per row.** The triggers run once per statement and read the
    statement's rows (`FOR EACH STATEMENT` with transition tables). A price list save of 500 prices is one insert into
    the log, and a style's 300 variants written in one statement are one line.
29. **A supplier is not logged.** A party is logged only while it is, or was, a customer. A garments company with 300
    yarn and trims suppliers would otherwise send each of their changes to every device, as a delete of a row it never
    had.
30. **A stock line names its warehouse,** so a device's pull skips the other branches' stock without reading it. A
    depot that posts a thousand movements a day would otherwise fill the pages of every shop's device.
31. **No horizon table.** The worker's hourly cleanup deletes the lines older than 30 days of every tenant at once, as
    its own role, like the outbox's cleanup. Which cursors are too old is decided from the cursor itself in 18a.3 (it
    knows when it was given out).
32. **A device is a member's,** by a foreign key to the membership, and never deleted (revoked, step 18c). The pull
    writes `last_sync_at` alone, without the version, so 18c's rename never fails because a pull happened.

**The API (18a.3):**

33. **A product and a customer are built by the same code as their pages.** `productsOf()` and `customersOf()` take
    rows and add the children of all of them at once. The product page and the pull call the same function, so a
    device never holds a product in a shape the page would not show. A page of 1000 products is four queries, not
    four thousand.
34. **A pull has a fixed end.** Its first page takes the watermark it reads up to, and its later pages read up to that
    same point. Without it, a busy workspace (a depot posting all day) could keep `hasMore` true for ever. What
    committed after that point comes with the next pull, a minute later.
35. **A page holds up to `limit` lines of the log, not `limit` rows.** A product saved ten times is ten lines and one
    change. Counting rows would mean reading the log until enough different keys came up, with no limit on how far.
    So a page may carry fewer changes than `limit`, and `hasMore` says whether to ask again.
36. **A full pull reads newer data as it goes, never older.** It takes its watermark on its first page and reads each
    entity later, so a product changed half way through may come in its new state. Its change comes again with the
    next pull, which starts from that first watermark. A row is sent twice at worst; it is never missed.
37. **Registering is safe to repeat, and changes nothing.** The same id by the same person returns the device as it
    is, even with another name or branch: renaming and moving are 18c's, with their own audit. A revoked device is
    returned too, with its `revokedAt`, so the app sees it and wipes its data.
38. **The status codes.** `sync_protocol_mismatch` 409 (checked first: whatever else is wrong, the app must reload),
    `device_not_found` 404, `device_revoked` 403, `device_id_invalid` 409, and `device_branch_invalid` 409 under the
    branch box, like `warehouse_branch_invalid`.
39. **The clock is the database's.** `serverTime`, `last_sync_at`, the cursor's age and the log's `created_at` all
    come from `now()` in Postgres. The cleanup compares `created_at` with the cursor's age, so they must be the same
    clock: an API server a few minutes off would not break anything, but it is one thing less to think about.

**The words (18a.5):**

40. **The branch question can wait.** The dialog of decision 12 has "Not now". An accountant at the head office who
    never opens the products page is not stopped at sign-in. Until the branch is chosen, the products and customers
    pages and the pickers show "This device is not set up yet" with a "Choose the branch" button that opens the same
    dialog. Products and customers are read only from the device (decision 5), so there is nothing to show before it.
    The pickers say it in their empty line; they have no room for a button.

**The device and the app (18a.6):**

41. **Signing out deletes the copy; the device stays.** The copy is the workspace's data, and a shop computer is
    shared: the next person must not find it in the browser's tools. The device's id is kept in `localStorage`, so
    signing in again is the same device (no second row in 18c's list), with a new full pull. Step 19's PIN lock and
    encryption may let the copy stay; then this changes.
42. **Dexie loads once, with the AppShell, never with a page.** (You chose this in 18a.6.) Dexie is about 30 KB gz,
    and every sales form has a customer box. With `dexie-react-hooks` in the pickers, 12 pages went over the 105 KB
    budget. So the pages read through a small hook of ours, `useLocalQuery`, and get Dexie's `liveQuery` from the code
    that opened the database. `packages/sync` is split the same way: its reads load no Dexie.
43. **A save on this device pulls at once.** Every write goes through the app's `call()`, so `api.ts` tells the sync
    code after each successful one, and the engine pulls 300 ms later. A product saved in the form is in the list
    when the person gets back to it, not up to a minute later.
44. **The device searches and sorts like the server.** Lower case for the sort and for "contains", a barcode matched
    whole, the archived variants' SKUs and barcodes found too, a category with everything under it. The products page
    finds the same products it found before. The list reads 100 rows, and 100 more at its end: an index walks the
    rows in order and stops, so the first screen of 10,000 products reads a hundred.
45. **One pull at a time, in the whole browser.** Within a tab, a pull asked for while one runs makes one more run
    after it. Across tabs, a Web Lock per database lets one tab pull while the others wait: two tabs pulling at once
    would mix their pages and cursors. A tab in the background does not pull every minute; it pulls when it comes
    back to the front.
46. **A full pull marks what it writes.** Every row carries the generation of the pull that wrote it. A full pull
    starts a new generation when the device was not in one or sent no cursor, and its last page deletes every older
    row in one range per table (decision 17). A tab closed half way through goes on from the saved cursor with the
    same generation.
47. **The branch box starts empty.** The head office is first in the list, and a shop's device set up there with
    one quick click would pull another branch's stock. Closing the dialog any way is "Not now".
48. **Which boxes read the device.** The customer box (on every sales form, the journal and the opening balances)
    and the "Add items" dialog of sales and purchase lines. A supplier box stays on the server (suppliers are not on
    the device), and so do the price list page's "Add items" and the stock pickers: they show archived products and
    stock values, which the device does not keep.
49. **The app fixes what it can by itself.** `device_not_found` registers the same id again, once. `device_id_invalid`
    makes a new id, once. A branch archived meanwhile makes the device forget it and ask again. A revoked device
    deletes its copy and says so. `sync_protocol_mismatch` stops the pulls and shows a notice with Reload; the copy
    stays readable meanwhile.
50. **Offline, the archived tabs say "Needs a connection",** even if their pages are still in the query cache. A
    list that works offline only sometimes is harder to trust than one that says plainly what it needs.
51. **The mock works out a pull from a snapshot, not from a change log.** The mock's data is plain arrays that about a
    hundred handlers change. A log would need a line in each of them, and a forgotten one would be a change the
    device never gets. So the mock remembers what each finished pull left the device with, and the next pull sends
    the difference. A cursor the mock does not know (after a reload, which starts the mock over but keeps the copy in
    IndexedDB) starts a full pull, like a cursor older than the API's log.
52. **The end-to-end tests start with a device of the head office.** (You chose this in 18a.7.) The garments
    workspace has three branches, so every test, a new browser profile each time, would get the branch dialog a
    moment after the page opens, over whatever the test opened first. The fixture puts the device in `localStorage`
    before the app starts, with `@omnivo/sync`'s own `saveDevice()`, so the format is written in one place. For that
    the mock's workspace, owner and head office ids are fixed. The dialog has its own test, without the fixture.
53. **The mock keeps its 10,000 garments styles.** (You chose this in 18a.7.) They are the load the device's copy
    must carry: a first pull of about 2.5 seconds, a list of 10,000 rows from IndexedDB. A test that reads the copy
    first waits for the first pull to end (`waitForCopy()`), instead of a longer timeout for every assertion.
54. **Offline, the mock fails every request.** MSW answers inside the page, so Playwright's `setOffline` and the
    browser's "Offline" switch do not stop it. Its first handler sends a network error while `navigator.onLine` is
    false, so the mock behaves like a real dead network.

## 18a.1 — `packages/contracts`: the contract

As in every step, the contract comes first. One new file, `sync.ts`: what a device keeps, what a pull sends, and how a
device registers. `customers.ts` gets the balances route the customer list needs (decision 10). The rest are small:
six error codes, an audit action, and the routes.

### `sync.ts` (new)

```ts
import { z } from 'zod';

import { customerGroupSchema, customerSchema } from './customers.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { priceListSchema } from './price-lists.js';
import { productCategorySchema } from './product-categories.js';
import { productSchema } from './products.js';
import { settingsSchema } from './settings.js';
import { taxRateSchema } from './tax-rates.js';
import { unitSchema } from './units.js';
import { warehouseSchema } from './warehouses.js';

// Step 18a: the read half of the sync engine. A device (one browser profile, for one person in
// one workspace) keeps a copy of the data a shop or a sales officer needs without a connection,
// and asks the server for what changed since its last pull:
//
//   GET /sync/pull?deviceId=…&protocol=1             first pull: every row, a page at a time
//   GET /sync/pull?deviceId=…&protocol=1&cursor=…    later: only what changed since that cursor
//
// The cursor is opaque: only the server reads it. A pull answers pages until `hasMore` is false;
// the last page's cursor is the one to keep for the next pull.
//
// What a device holds ("POS-ready", decision 2): the active products with their variants, packs
// and barcodes, the price lists and their prices, the VAT rates, the units and categories, the
// active customers with their groups, the warehouses of the device's branch and the stock in them,
// and the part of the settings a sale needs. No customer balances and no stock values: they
// change with every invoice and every movement, and they need their own permissions.

// The version of this protocol: what the entities below are and what their rows hold. A client
// sends the version it was built with; the server answers sync_protocol_mismatch to any other,
// and the app asks the person to reload. That is how a new entity can be added later: an older
// client never receives a row it cannot read, and a client that moved to a new version starts
// again with a full pull, so it does not miss the rows of an entity it did not know before.
export const SYNC_PROTOCOL = 1;

// Every kind of row a device keeps. The order is the order of a full pull: the small lists that
// the others point at come first, so a page never shows a product before its units.
export const SYNC_ENTITIES = [
  'settings',
  'unit',
  'product_category',
  'tax_rate',
  'warehouse',
  'price_list',
  'customer_group',
  'product',
  'price_list_item',
  'customer',
  'stock',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

// The most rows one page sends. A product counts as one row with all its variants, so a page of
// garments styles in 300 variants each is still a few MB at most.
export const MAX_SYNC_PAGE = 1000;

// ---------------------------------------------------------------------------------------------
// The rows a device keeps: the shapes the API already sends, without the counts and sums that
// change when another row changes. A price list's itemCount changes with each price, so keeping
// it would send the list again for every price.

// What a sale needs from the settings: how to work out the VAT, whether stock may go below zero,
// the time zone of its dates, and the company's name and BIN for a receipt (step 20). Not the logo:
// its url is signed for a short time and would be dead by the next day.
export const syncSettingsSchema = settingsSchema.pick({
  companyName: true,
  legalName: true,
  bin: true,
  phone: true,
  address: true,
  baseCurrency: true,
  fiscalYearStartMonth: true,
  timezone: true,
  allowNegativeStock: true,
  pricesIncludeVat: true,
  version: true,
});
export type SyncSettings = z.infer<typeof syncSettingsSchema>;

export const syncCategorySchema = productCategorySchema.omit({ productCount: true });
export type SyncCategory = z.infer<typeof syncCategorySchema>;

export const syncPriceListSchema = priceListSchema.omit({ itemCount: true, customerCount: true });
export type SyncPriceList = z.infer<typeof syncPriceListSchema>;

export const syncCustomerGroupSchema = customerGroupSchema.omit({ customerCount: true });
export type SyncCustomerGroup = z.infer<typeof syncCustomerGroupSchema>;

// A customer with its addresses, without the balance (decision 10: the list asks the server for
// the balances of the rows it shows, online only)
export const syncCustomerSchema = customerSchema.omit({ balance: true });
export type SyncCustomer = z.infer<typeof syncCustomerSchema>;

// One price of a list: a variant, in one unit. Its key is the three ids (priceListItemKey).
export const syncPriceListItemSchema = z.object({
  priceListId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid(),
  unitId: z.uuid(),
  // Per one of this unit, 4 decimals
  price: z.string(),
  updatedAt: z.iso.datetime(),
});
export type SyncPriceListItem = z.infer<typeof syncPriceListItemSchema>;

// What is in one warehouse of the device's branch: a variant, and its batch for a batch product.
// The batch's lot number and dates come with the row, so a sale can pick the first to expire
// (FEFO) without a table of batches. Quantities only, in the base unit: never a cost
// (inventory.stock.value). A row whose quantity reaches zero is deleted from the device.
export const syncStockSchema = z.object({
  warehouseId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid(),
  batchId: z.uuid().nullable(),
  lotNumber: z.string().nullable(),
  manufacturedOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  // 4 decimals, in the product's base unit. Negative only when the workspace allows it.
  quantity: z.string(),
  updatedAt: z.iso.datetime(),
});
export type SyncStock = z.infer<typeof syncStockSchema>;

// The rows without an id of their own are keyed by the ids that make them one row. The database's
// change log (step 18a.2) writes the same keys in SQL, so the format must not change: a stock row
// of an untracked variant ends in '-', never in an empty part.
export function priceListItemKey(
  item: Pick<SyncPriceListItem, 'priceListId' | 'variantId' | 'unitId'>,
): string {
  return `${item.priceListId}:${item.variantId}:${item.unitId}`;
}

export function stockKey(row: Pick<SyncStock, 'warehouseId' | 'variantId' | 'batchId'>): string {
  return `${row.warehouseId}:${row.variantId}:${row.batchId ?? '-'}`;
}

// ---------------------------------------------------------------------------------------------
// A change: a row to put in (insert or replace), or a key to take out. A row is taken out when it
// is deleted, and also when it leaves what the device keeps: an archived product, a customer that
// is now only a supplier, a warehouse moved to another branch, a stock row at zero.

function upsertOf<const E extends SyncEntity, S extends z.ZodType>(entity: E, data: S) {
  return z.object({
    op: z.literal('upsert'),
    entity: z.literal(entity),
    // The row's id, or the key from priceListItemKey / stockKey; the settings' key is the
    // workspace's id
    key: z.string(),
    data,
  });
}

export const syncUpsertSchema = z.discriminatedUnion('entity', [
  upsertOf('settings', syncSettingsSchema),
  upsertOf('unit', unitSchema),
  upsertOf('product_category', syncCategorySchema),
  upsertOf('tax_rate', taxRateSchema),
  upsertOf('warehouse', warehouseSchema),
  upsertOf('price_list', syncPriceListSchema),
  upsertOf('customer_group', syncCustomerGroupSchema),
  upsertOf('product', productSchema),
  upsertOf('price_list_item', syncPriceListItemSchema),
  upsertOf('customer', syncCustomerSchema),
  upsertOf('stock', syncStockSchema),
]);
export type SyncUpsert = z.infer<typeof syncUpsertSchema>;

// The row type of one entity: SyncRow<'product'> is a Product
export type SyncRow<E extends SyncEntity> = Extract<SyncUpsert, { entity: E }>['data'];

export const syncDeleteSchema = z.object({
  op: z.literal('delete'),
  entity: z.enum(SYNC_ENTITIES),
  key: z.string(),
});
export type SyncDelete = z.infer<typeof syncDeleteSchema>;

export const syncChangeSchema = z.union([syncUpsertSchema, syncDeleteSchema]);
export type SyncChange = z.infer<typeof syncChangeSchema>;

// ---------------------------------------------------------------------------------------------
// The pull

export const syncPullQuerySchema = z.object({
  deviceId: z.uuid(),
  // SYNC_PROTOCOL of the client. Any number passes here; the server compares it, so the answer
  // is the one code the app looks for (sync_protocol_mismatch), not a field error.
  protocol: z.coerce.number<number>().int(),
  // None = a full pull. The server may also start a full pull itself (see `full`).
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number<number>().int().min(1).max(MAX_SYNC_PAGE).default(500),
});
export type SyncPullQuery = z.input<typeof syncPullQuerySchema>;

export const syncPullSchema = z.object({
  // In the order to apply them. A key is in a page at most once, in its latest state.
  changes: z.array(syncChangeSchema),
  // Send it with the next page, or keep it for the next pull once hasMore is false
  cursor: z.string(),
  hasMore: z.boolean(),
  // This page is part of a full pull: every row the device should keep, not only what changed.
  // The server starts one when there is no cursor, when the cursor is older than the change log
  // keeps, or when the device moved to another branch. On the last page of a full pull, the
  // device drops every row the full pull did not send. Until then it keeps showing what it had.
  full: z.boolean(),
  // The server's clock when the page was read. "Last synced" and the offline time limits (step
  // 18c) are counted from it, never from the device's clock, which may be wrong.
  serverTime: z.iso.datetime(),
});
export type SyncPull = z.infer<typeof syncPullSchema>;

// ---------------------------------------------------------------------------------------------
// Devices. Step 18a registers one; step 18c lists them, renames them, moves them to another
// branch and revokes them.

export const deviceSchema = z.object({
  id: z.uuid(),
  // "Chrome on Windows", "Counter 2"
  name: z.string(),
  // The branch whose warehouses and stock the device keeps, and (step 18b) where its offline
  // orders are made. Members have no branch, so the device says where it is (decision 9).
  branchId: z.uuid(),
  // The person who registered it. A device is one person's: another person signing in on the
  // same browser gets a device (and a local database) of their own.
  userId: z.uuid(),
  // When it last finished a pull, by the server's clock; null before the first one
  lastSyncAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
});
export type Device = z.infer<typeof deviceSchema>;

export const deviceNameSchema = z.string().trim().min(2, errorCode('device_name_required')).max(60);

export const registerDeviceInputSchema = z.object({
  // Made by the browser, a UUIDv7 like every id: if the answer is lost on a bad connection, the
  // retry registers the same device instead of a second one
  id: z.uuidv7(errorCode('device_id_invalid')),
  name: deviceNameSchema,
  // The form's empty select sends '' — "not chosen", with its own message
  branchId: z.uuid(errorCode('device_branch_invalid')),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;
export type RegisterDeviceFormValues = z.input<typeof registerDeviceInputSchema>;

// No permission: every member may work offline. What a device receives is what its person may
// read anyway (products, customers, prices and stock need no permission to read).
export const syncRoutes = {
  registerDevice: defineRoute({
    method: 'POST',
    path: '/sync/devices',
    summary: 'Register this browser as a device of the signed-in person, in one branch',
    auth: 'bearer',
    status: 201,
    body: registerDeviceInputSchema,
    response: deviceSchema,
  }),
  pull: defineRoute({
    method: 'GET',
    path: '/sync/pull',
    summary: 'The rows a device keeps: all of them, or what changed since a cursor',
    auth: 'bearer',
    status: 200,
    query: syncPullQuerySchema,
    response: syncPullSchema,
  }),
};
```

- **The header comment is the design in one place:** the two calls a device makes, the data set (decision 2), and what
  is not in it. 18a.3's service and 18a.6's sync loop both follow it.
- **`SYNC_PROTOCOL` is a number the client sends with every pull** (decision 18). Without it, a new entity from a newer
  server would make an older client's `syncPullSchema.parse` fail on the whole page, because `entity` is a list of
  literals. With it, an older client never gets a row it cannot read.
- **`SYNC_ENTITIES` is in the order of a full pull.** The device has no foreign keys, so any order would end correct;
  this order only makes sure a page that is on screen during a full pull never shows a product before its units.
- **`MAX_SYNC_PAGE` counts things, not database rows.** A product with 300 variants is one change.
- **The row schemas reuse the API's own shapes** (decision 14) with `pick` and `omit`, so a field added to a product
  later reaches the device without a second schema to update. `omit` drops the counts and the balance
  (decision 15).
- **`syncSettingsSchema` picks fields one by one,** the opposite of the others: the settings hold the logo's signed link
  and step 17's purchase settings, which a device must not keep (decision 22). A field added to the settings later then
  stays off the device until someone decides it should be there.
- **`syncStockSchema` has no id.** A stock balance has none in the database either (`stock_balances` is keyed by
  warehouse, variant and batch). The lot number and dates sit on the row (decision 23).
- **`stockKey` writes `-` for no batch.** The database builds the same key in SQL (18a.2); with an empty last part, the
  two keys of an untracked variant could be written two ways (`…:` and `…:null`). The comment says the format is fixed.
- **`upsertOf` builds one schema per entity,** with `entity` as a literal, so `syncUpsertSchema` is a discriminated
  union: `change.entity === 'product'` narrows `change.data` to a `Product`. `SyncRow<'product'>` gives the same type
  to the device's tables in 18a.6.
- **A delete has only the entity and the key** (decision 16): the row is gone, or no longer the device's, and the device
  needs nothing else to take it out.
- **`protocol` is any integer in the query.** A `z.literal(1)` would answer a wrong version with a field error
  (`invalid_value` on `protocol`), which the app would have to dig out. The server compares it and answers the one code
  the app looks for.
- **`full` explains itself in its comment** (decision 17), because the device must do one thing on the last page that
  it never does otherwise: drop what the full pull did not send.
- **`registerDeviceInputSchema.id` is `z.uuidv7()`** (decision 20): a v4 id from some other library would still work,
  but would not sort by time like every other id in the database.
- **Both routes need no permission** (decision 21), only a signed-in member.

```ts
import { describe, expect, it } from 'vitest';

import {
  priceListItemKey,
  registerDeviceInputSchema,
  stockKey,
  syncChangeSchema,
  syncCustomerSchema,
  syncPullQuerySchema,
  syncPullSchema,
} from './sync.js';

const WAREHOUSE = '0192f1c4-0000-7000-8000-00000000000a';
const VARIANT = '0192f1c4-0000-7000-8000-00000000000b';
const BATCH = '0192f1c4-0000-7000-8000-00000000000c';
const PRODUCT = '0192f1c4-0000-7000-8000-00000000000d';
const UNIT = '0192f1c4-0000-7000-8000-00000000000e';
const LIST = '0192f1c4-0000-7000-8000-00000000000f';
const AT = '2026-10-20T04:30:00.000Z';

// Napa 500 mg as the API sends it: a simple product, sold by the strip and the box of 10 strips
const napa = {
  id: PRODUCT,
  code: 'NAPA-500',
  name: 'Napa 500 mg',
  type: 'goods',
  categoryId: null,
  description: null,
  baseUnitId: UNIT,
  salesUnitId: null,
  purchaseUnitId: null,
  tracking: 'batch',
  hasExpiry: true,
  taxRateId: null,
  options: [],
  variants: [
    {
      id: VARIANT,
      sku: 'NAPA-500',
      optionValues: [],
      barcode: '8941100500019',
      salePrice: '12.0000',
      archivedAt: null,
    },
  ],
  units: [],
  customFields: {},
  archivedAt: null,
  version: 3,
  updatedAt: AT,
};

const stockRow = {
  warehouseId: WAREHOUSE,
  productId: PRODUCT,
  variantId: VARIANT,
  batchId: BATCH,
  lotNumber: 'NP24117',
  manufacturedOn: '2026-03-01',
  expiresOn: '2028-02-28',
  quantity: '240.0000',
  updatedAt: AT,
};

describe('sync keys', () => {
  it('keys a stock row by warehouse, variant and batch, with "-" for no batch', () => {
    expect(stockKey(stockRow)).toBe(`${WAREHOUSE}:${VARIANT}:${BATCH}`);
    expect(stockKey({ ...stockRow, batchId: null })).toBe(`${WAREHOUSE}:${VARIANT}:-`);
  });

  it('keys a price by list, variant and unit', () => {
    expect(priceListItemKey({ priceListId: LIST, variantId: VARIANT, unitId: UNIT })).toBe(
      `${LIST}:${VARIANT}:${UNIT}`,
    );
  });
});

describe('sync changes', () => {
  it('reads a page of upserts and deletes, each by its entity', () => {
    const page = syncPullSchema.parse({
      changes: [
        { op: 'upsert', entity: 'product', key: PRODUCT, data: napa },
        { op: 'upsert', entity: 'stock', key: stockKey(stockRow), data: stockRow },
        { op: 'delete', entity: 'customer', key: LIST },
      ],
      cursor: 'opaque',
      hasMore: false,
      full: false,
      serverTime: AT,
    });
    const [product, stock, gone] = page.changes;
    expect(product?.op === 'upsert' && product.entity === 'product' && product.data.name).toBe(
      'Napa 500 mg',
    );
    expect(stock?.op === 'upsert' && stock.entity === 'stock' && stock.data.lotNumber).toBe(
      'NP24117',
    );
    expect(gone).toEqual({ op: 'delete', entity: 'customer', key: LIST });
  });

  it('refuses a row that does not fit its entity, and an entity it does not know', () => {
    // A stock row sent as a product: the entity decides the shape
    expect(
      syncChangeSchema.safeParse({ op: 'upsert', entity: 'product', key: PRODUCT, data: stockRow })
        .success,
    ).toBe(false);
    // A newer protocol's entity never reaches this client: the server checks the protocol first
    expect(
      syncChangeSchema.safeParse({ op: 'delete', entity: 'serial', key: PRODUCT }).success,
    ).toBe(false);
  });

  it('keeps no balance on a customer, even if one is sent', () => {
    const customer = syncCustomerSchema.parse({
      id: LIST,
      code: 'C-00042',
      name: 'Rahman Traders',
      groupId: null,
      contactPerson: null,
      phone: '01711-000000',
      email: null,
      documentLanguage: 'bn',
      bin: null,
      paymentTermsDays: 30,
      creditLimit: '200000.0000',
      priceListId: null,
      notes: null,
      addresses: [],
      isSupplier: false,
      balance: '115000.0000',
      archivedAt: null,
      version: 1,
      updatedAt: AT,
    });
    expect(customer).not.toHaveProperty('balance');
  });
});

describe('pull query', () => {
  it('reads the numbers of a query string, and starts at 500 rows a page', () => {
    expect(syncPullQuerySchema.parse({ deviceId: WAREHOUSE, protocol: '1' })).toEqual({
      deviceId: WAREHOUSE,
      protocol: 1,
      limit: 500,
    });
  });

  it('refuses a page over 1000 rows', () => {
    expect(
      syncPullQuerySchema.safeParse({ deviceId: WAREHOUSE, protocol: '1', limit: '1001' }).success,
    ).toBe(false);
  });
});

describe('device registration', () => {
  it('takes a UUIDv7 made by the browser, and a trimmed name', () => {
    expect(
      registerDeviceInputSchema.parse({ id: VARIANT, name: '  Counter 2 ', branchId: WAREHOUSE }),
    ).toEqual({ id: VARIANT, name: 'Counter 2', branchId: WAREHOUSE });
  });

  it('refuses an id of another kind, a one-letter name and no branch, each with its code', () => {
    const result = registerDeviceInputSchema.safeParse({
      id: '6f1c2a4e-1111-4111-8111-111111111111',
      name: 'C',
      branchId: '',
    });
    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['id', 'device_id_invalid'],
      ['name', 'device_name_required'],
      ['branchId', 'device_branch_invalid'],
    ]);
  });
});
```

- **The fixtures are a pharmacy's:** Napa 500 mg by batch, lot NP24117. The first test checks the stock key with and
  without a batch, the exact strings 18a.2's SQL must also write.
- **"Refuses an entity it does not know"** is the protocol rule written as a test: `serial` is not an entity of
  protocol 1, so the page would not parse. The server never sends it to a client of protocol 1.
- **"Keeps no balance on a customer"** sends one on purpose: `omit` drops it while parsing, so even a server that sent
  one by mistake would not store it on the device.

### `customers.ts`: the balances of the rows on screen

```diff
@@ -195,6 +195,27 @@ export const customerCreditSchema = z.object({
 });
 export type CustomerCredit = z.infer<typeof customerCreditSchema>;
 
+// Step 18a (decision 10): the customer list reads its rows from the device, and the balances of
+// the rows it shows from here, a page of the list at a time. A comma-separated list in the query,
+// not a body: it is a read, and a GET stays a GET in the OpenAPI document and in the browser cache.
+export const MAX_BALANCE_IDS = 100;
+
+export const customerBalancesQuerySchema = z.object({
+  ids: z
+    .string()
+    .transform((value) => value.split(','))
+    .pipe(z.array(z.uuid()).min(1).max(MAX_BALANCE_IDS)),
+});
+export type CustomerBalancesQuery = z.input<typeof customerBalancesQuerySchema>;
+
+// One row per id asked for that is a customer of this workspace, archived or not. An id the
+// workspace does not know is left out, never an error: the device may hold a customer that was
+// deleted a minute ago.
+export const customerBalancesSchema = z.object({
+  items: z.array(z.object({ id: z.uuid(), balance: z.string() })),
+});
+export type CustomerBalances = z.infer<typeof customerBalancesSchema>;
+
 const customerParamsSchema = z.object({ id: z.uuid() });
 
 // Reading needs no permission, like products: every sales document picks a customer. The balance
@@ -300,6 +321,18 @@ export const customerRoutes = {
     query: ledgerQuerySchema,
     response: ledgerPageSchema,
   }),
+  // The same balance as the customer's own, for many customers at once (step 18a). Its own path,
+  // not /customers/balances: that one would be read as a customer called "balances".
+  balances: defineRoute({
+    method: 'GET',
+    path: '/customer-balances',
+    summary: 'What each of up to 100 customers owes now',
+    auth: 'bearer',
+    permission: 'sales.customer.balance',
+    status: 200,
+    query: customerBalancesQuerySchema,
+    response: customerBalancesSchema,
+  }),
   // What the forms show under the customer (step 15c), with the same numbers the credit check uses
   credit: defineRoute({
     method: 'GET',
```

- **The ids are one comma-separated string,** cut and checked by the schema. A read stays a `GET`, and the OpenAPI
  document shows one plain parameter. 100 ids are about 3.7 KB of URL, well inside every browser's and proxy's limit.
- **`MAX_BALANCE_IDS` is 100,** the size of one local page of the list (18a.6 shows 100 rows, then 100 more as the
  person scrolls), so one page of rows is one request.
- **An unknown id is left out, not refused:** the device may still hold a customer someone deleted a minute ago, and
  one stale row must not take away the balances of the other 99.
- **The path is `/customer-balances`,** not `/customers/balances`: the API's `/customers/:id` route would read
  "balances" as a customer id, and so would the mock in 18a.7.

```diff
@@ -1,6 +1,11 @@
 import { describe, expect, it } from 'vitest';
 
-import { type CustomerFormValues, customerInputSchema } from './customers.js';
+import {
+  type CustomerFormValues,
+  customerBalancesQuerySchema,
+  customerInputSchema,
+  MAX_BALANCE_IDS,
+} from './customers.js';
 import { setPriceListItemsInputSchema } from './price-lists.js';
 
 function customer(extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
@@ -67,6 +72,23 @@ describe('customer input', () => {
   });
 });
 
+describe('customer balances query', () => {
+  const id = (n: number) => `0192f1c4-0000-7000-8000-${String(n).padStart(12, '0')}`;
+
+  it('reads the comma-separated ids of the rows a page shows', () => {
+    expect(customerBalancesQuerySchema.parse({ ids: `${id(1)},${id(2)}` })).toEqual({
+      ids: [id(1), id(2)],
+    });
+  });
+
+  it('refuses an empty list, more than a page, and a part that is not an id', () => {
+    const many = Array.from({ length: MAX_BALANCE_IDS + 1 }, (_, n) => id(n)).join(',');
+    for (const ids of ['', many, `${id(1)},,${id(2)}`, `${id(1)},C-00042`]) {
+      expect(customerBalancesQuerySchema.safeParse({ ids }).success).toBe(false);
+    }
+  });
+});
+
 describe('price list changes', () => {
   const variant = '01939d1c-0000-7000-8000-000000000001';
   const carton = '01939d1c-0000-7000-8000-000000000002';
```

- `,,` in the middle makes an empty part, which is not an id: a list with a hole is a bug in the caller, not a request
  for fewer rows.

### `errors.ts`, `audit.ts`

```diff
@@ -471,6 +471,15 @@ export const ERROR_CODES = [
   // Void refused while a supplier refund paid back some of the payment's advance
   'payment_has_refunds',
   'journal_is_purchase',
+  // Step 18a: devices and the sync. device_not_found also answers another person's device: the
+  // app then registers this browser again.
+  'device_id_invalid',
+  'device_name_required',
+  'device_branch_invalid',
+  'device_not_found',
+  'device_revoked',
+  // The app was built for another version of the sync (SYNC_PROTOCOL): reload it
+  'sync_protocol_mismatch',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **`device_not_found` also answers another person's device** (decision 20): telling the two apart would let anyone
  test which device ids exist. The app's answer is the same in both cases: register this browser again.
- **`device_revoked`** is sent from 18a, though revoking comes in 18c: the pull must already refuse a revoked device,
  and the column is in 18a.2's table.
- **`sync_protocol_mismatch`** has no field: the app reacts to the code itself (decision 18).

```diff
@@ -19,6 +19,7 @@ export const AUDIT_ACTIONS = [
   'branch.archived',
   'branch.restored',
   'number_series.updated',
+  'device.registered',
   'member.invited',
   'member.invitation_resent',
   'member.invitation_revoked',
@@ -253,6 +254,7 @@ export const AUDIT_ENTITY_TYPES = [
   'purchase_return',
   'debit_note',
   'supplier_refund',
+  'device',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- **Registering a device is in the audit log,** with its own entity type: a new browser that can keep a copy of the
  customer list is something an owner wants to be able to look up. The pulls themselves are not logged; there is one a
  minute per device.

### `routes.ts` and `index.ts`

```diff
@@ -50,6 +50,7 @@ import { stockRoutes } from './stock.js';
 import { supplierPaymentRoutes } from './supplier-payments.js';
 import { supplierRefundRoutes } from './supplier-refunds.js';
 import { supplierGroupRoutes, supplierRoutes } from './suppliers.js';
+import { syncRoutes } from './sync.js';
 import { taxRateRoutes } from './tax-rates.js';
 import { unitRoutes } from './units.js';
 import { warehouseRoutes } from './warehouses.js';
@@ -131,4 +132,5 @@ export const routes = {
   purchaseReturns: purchaseReturnRoutes,
   debitNotes: debitNoteRoutes,
   supplierRefunds: supplierRefundRoutes,
+  sync: syncRoutes,
 };
```

```diff
@@ -56,6 +56,7 @@ export * from './stock-transfers.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
 export * from './suppliers.js';
+export * from './sync.js';
 export * from './tax-rates.js';
 export * from './units.js';
 export * from './warehouses.js';
```

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
```

Both pass (contracts 271 tests, 11 new). Do not run the whole `pnpm typecheck` yet: `en.ts` misses the six new error
codes and the app's audit log page the new audit action until 18a.5, and the API's route test
(`apps/api/src/contract.spec.ts`) fails until 18a.3 serves the three new routes.

## 18a.2 — `packages/db`: the change log and the devices

The contract says what a device keeps; this part makes the database say what changed. Two tables in one new schema
file: `sync_changes`, the change log, and `devices`. Migration 0043 is generated from the schema; 0044 is written by
hand: row-level security, the rights, two small key functions, and the triggers that write the log.

The rule of this part: **the log says only which thing changed, never what changed.** A line is "product 601" or
"stock 401:602:b01", nothing more. The pull (18a.3) reads each key's current state and sends it, or sends a delete
when the row is gone or no longer the device's. So the triggers need no rules about the data set: an archived product,
a customer that became only a supplier, a stock row at zero are all just "this key changed", and the pull decides.
Only a few changes that touch rows the triggers would not see get their own triggers (decision 27).

### `schema/sync.ts` (new)

```ts
import type { SyncEntity } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { memberships } from './memberships.js';
import { tenants } from './tenants.js';

// Postgres's 64-bit transaction id (xid8). It never wraps around, unlike the old 32-bit xid, so
// two of them always compare in the order the transactions started. A string in TypeScript: the
// value may pass 2^53, and only the database compares them.
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

// The change log of step 18a: one row for every row of a synced table that was written, written
// by migration 0044's triggers in the same transaction. Code never writes it. The pull reads the
// keys a device has not seen yet and sends each one in its current state (or as a delete when it
// is gone or no longer the device's), so a row says only WHICH thing changed, never what changed.
// A key is often here many times; the pull sends it once.
export const syncChanges = pgTable(
  'sync_changes',
  {
    // The order inside one transaction. Never a cursor on its own (see xid).
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // $type, no check: like the outbox's type, an old row survives an entity a later protocol
    // drops, and the pull skips what it does not know
    entity: text('entity').$type<SyncEntity>().notNull(),
    // The contract's key: the row's id, priceListItemKey() or stockKey(); the settings' key is the
    // tenant id. The triggers build exactly those strings.
    entityKey: text('entity_key').notNull(),
    // A stock row's warehouse, NULL for every other entity. A device keeps the stock of its
    // branch only, so its pull skips the other branches' stock here, without reading the rows.
    warehouseId: uuid('warehouse_id'),
    // The transaction that wrote the change. The pull's cursor is a watermark on it (decision 25):
    // it reads only the transactions that finished before the oldest one still running.
    xid: xid8('xid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    // For pruning only (the log keeps 30 days, decision 26). The pull never reads it.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The pull: a tenant's changes from the cursor on, in order
    index('sync_changes_tenant_xid_idx').on(table.tenantId, table.xid, table.id),
    // The worker's pruning: the oldest rows of every tenant
    index('sync_changes_created_idx').on(table.createdAt),
  ],
);

// A device (decision 7): one browser profile, for one person in one workspace, in one branch. The
// browser makes the id (a UUIDv7) and keeps it, so a registration whose answer was lost registers
// the same device again. Step 18c lists, renames, moves and revokes them.
// deleted_at (from baseColumns) is not used: a device is revoked, never deleted, because its
// commands (step 18b) point at it.
export const devices = pgTable(
  'devices',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    branchId: uuid('branch_id').notNull(),
    // When it last finished a pull, by the server's clock. The pull writes only this column, never
    // version or updated_at: a pull a minute must not make step 18c's rename fail on its version.
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // A person's devices (step 18c's list) — and Postgres's own check of the membership FK
    index('devices_tenant_user_idx').on(table.tenantId, table.userId),
    // The devices of a branch, and the branch FK's own check
    index('devices_tenant_branch_idx').on(table.tenantId, table.branchId),
    // A device is a member's of THIS workspace. Members are removed with deleted_at, never
    // deleted, so the FK never stops a removal.
    foreignKey({
      name: 'devices_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'devices_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
  ],
);
```

- **`xid8` is a custom type.** Drizzle has no column type for it. It is the 64-bit transaction id of Postgres 13 and
  later, which never wraps around (the old 32-bit `xid` does, every 4 billion transactions). It is a `string` in
  TypeScript: the value can pass 2^53, which a JavaScript `number` cannot hold exactly, and only the database
  compares two of them.
- **`id` is an identity column, not a UUIDv7.** It only orders the lines inside one transaction, and a `bigint` is
  half the size of a `uuid` in a table that gets a line for every write. It is never the cursor on its own: see
  decision 25 and the race in "What we checked".
- **`entity` has a type but no check,** like the outbox's `type`: a later protocol may drop an entity, and its old
  lines must not stop that migration. The pull skips an entity it does not know.
- **`entity_key` is the contract's key** (decision 14): the id, or `priceListItemKey()` / `stockKey()`. Section 4 of
  0044 builds those strings in SQL.
- **`warehouse_id` is set on stock lines only** (decision 30). The pull filters on it with the warehouses of the
  device's branch, so a page is never full of the other branches' stock.
- **`xid` defaults to `pg_current_xact_id()`,** the id of the transaction that writes the line. Every line of one
  transaction gets the same value. That is what makes the cursor safe (decision 25): the pull returns the lines of
  transactions that finished before the oldest one still running, and nothing can later commit below that point.
- **`created_at` is for the worker's cleanup only** (decision 31); the pull never reads it.
- **`sync_changes_tenant_xid_idx` is the pull's index:** one tenant's lines from the cursor on, in the order they
  were written (`xid`, then `id`). **`sync_changes_created_idx`** lets the cleanup find the old lines of every tenant
  without reading the whole table.
- **`devices` has the base columns** (`version` for 18c's rename and move), but `deleted_at` is not used: 18b's
  commands will point at a device, so it is revoked, never deleted.
- **`last_sync_at` is written alone by the pull,** never with the version (decision 32). With a pull every minute,
  bumping the version would make almost every rename in 18c fail with "changed by someone else".
- **`devices_membership_fk` points at the membership, not at the user** (decision 32): a device must belong to a
  member of THIS workspace, which a plain foreign key to `users` cannot say. Members are removed with `deleted_at`, so
  this key never blocks a removal. Its target is `memberships_tenant_user_idx`.
- **`devices_branch_fk`** is the same composite key every branch reference has: never another tenant's branch.

```diff
@@ -49,3 +49,4 @@ export * from './supplier-payments.js';
 export * from './purchase-returns.js';
 export * from './debit-notes.js';
 export * from './supplier-refunds.js';
+export * from './sync.js';
```

### Migration 0043 (generated)

Run `pnpm --filter @omnivo/db generate --name sync-devices`. The new foreign keys point at unique indexes that exist
already (`memberships_tenant_user_idx`, `branches_tenant_id_idx`), so the order Drizzle writes them in works as it is.

```sql
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"last_sync_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_key" text NOT NULL,
	"warehouse_id" uuid,
	"xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_tenant_user_idx" ON "devices" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "devices_tenant_branch_idx" ON "devices" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE INDEX "sync_changes_tenant_xid_idx" ON "sync_changes" USING btree ("tenant_id","xid","id");--> statement-breakpoint
CREATE INDEX "sync_changes_created_idx" ON "sync_changes" USING btree ("created_at");
```

- Two new tables, nothing on the existing ones, so the migration is instant on a big database. The log starts
  empty: every device's first pull is a full one, so the data that exists before step 18 needs no backfill.
- `meta/_journal.json` and `meta/0043_snapshot.json` change too. They are generated; commit them as they are.

### Migration 0044 (custom): the rights and the triggers

Run `pnpm --filter @omnivo/db generate --custom --name sync-devices-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The two new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['sync_changes', 'devices'])
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

-- 2) The change log is written by the triggers below and read by the pull. The API never edits or
--    deletes a line of it: a bug that did would make devices miss changes without anyone noticing.
--    A device is revoked (step 18c), never deleted.
REVOKE UPDATE, DELETE ON sync_changes FROM omnivo_app;
REVOKE DELETE ON devices FROM omnivo_app;

-- 3) The log keeps 30 days (decision 26). The worker's hourly cleanup deletes the older lines of
--    EVERY tenant in one statement, as its own role (omnivo_worker), like the outbox's cleanup in
--    0012: this policy applies to that role only, and omnivo_app still sees its tenant's lines only.
GRANT SELECT, DELETE ON sync_changes TO omnivo_worker;
CREATE POLICY sync_prune ON sync_changes
  TO omnivo_worker
  USING (true)
  WITH CHECK (true);

-- 4) The keys of the two entities without an id of their own. The contract's priceListItemKey()
--    and stockKey() build the same strings in TypeScript (packages/contracts/src/sync.ts), so the
--    format must not change: three ids joined by ':', and '-' for a stock row without a batch.
--    The triggers here and the pull (18a.3) use these, so the format is written once in SQL.
CREATE FUNCTION sync_price_key(price_list_id uuid, variant_id uuid, unit_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT price_list_id::text || ':' || variant_id::text || ':' || unit_id::text
$$;

CREATE FUNCTION sync_stock_key(warehouse_id uuid, variant_id uuid, batch_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT warehouse_id::text || ':' || variant_id::text || ':' || coalesce(batch_id::text, '-')
$$;

-- 5) One function writes the log for every synced table. It runs once per statement, not once per
--    row, and reads the statement's rows from its transition tables (new_rows, old_rows): a price
--    list save of 500 prices or a product import is one INSERT here, and the 300 variants of one
--    style written in one statement are one line, not 300 (DISTINCT).
--    Its arguments come from the CREATE TRIGGER statements in section 8 (fixed text, never input):
--      0  the entity (SYNC_ENTITIES)
--      1  the key, as SQL on the row r
--      2  which rows count, as SQL on r ('true' = all of them)
--      3  the warehouse of a stock row, as SQL on r ('NULL' for the others)
--    An UPDATE logs the rows before and after: a key never changes, but a filter may stop being
--    true (a customer that is now only a supplier), and the device must hear about that one too.
CREATE FUNCTION sync_log() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rows_sql text := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT * FROM new_rows'
    WHEN 'DELETE' THEN 'SELECT * FROM old_rows'
    ELSE 'SELECT * FROM old_rows UNION ALL SELECT * FROM new_rows'
  END;
BEGIN
  EXECUTE format(
    'INSERT INTO sync_changes (tenant_id, entity, entity_key, warehouse_id)
     SELECT DISTINCT r.tenant_id, %L, %s, (%s)::uuid FROM (%s) r WHERE %s',
    TG_ARGV[0], TG_ARGV[1], TG_ARGV[3], rows_sql, TG_ARGV[2]
  );
  RETURN NULL;
END $$;

-- 6) A price and a stock row are on a device only while their product is active, and a price only
--    while its list is active too: an archived list falls back to the products' own prices
--    (PriceLookupService), and nobody sells an archived product. Archiving or restoring a product
--    or a list does not touch those rows, so these two triggers log them. A stock row at zero is
--    not on any device, so it is left out.
--    The stock rows are found through the product's variants: stock_balances has an index on the
--    variant, not on the product.
CREATE FUNCTION sync_log_product_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT DISTINCT i.tenant_id, 'price_list_item', sync_price_key(i.price_list_id, i.variant_id, i.unit_id)
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
    JOIN price_list_items i ON i.tenant_id = n.tenant_id AND i.product_id = n.id
   WHERE (n.archived_at IS NULL) <> (o.archived_at IS NULL);

  INSERT INTO sync_changes (tenant_id, entity, entity_key, warehouse_id)
  SELECT DISTINCT b.tenant_id, 'stock', sync_stock_key(b.warehouse_id, b.variant_id, b.batch_id),
         b.warehouse_id
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
    JOIN product_variants v ON v.tenant_id = n.tenant_id AND v.product_id = n.id
    JOIN stock_balances b ON b.tenant_id = v.tenant_id AND b.variant_id = v.id
   WHERE (n.archived_at IS NULL) <> (o.archived_at IS NULL)
     AND b.quantity <> 0;
  RETURN NULL;
END $$;

CREATE TRIGGER products_sync_scope
  AFTER UPDATE ON products
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_product_scope();

CREATE FUNCTION sync_log_price_list_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT DISTINCT i.tenant_id, 'price_list_item', sync_price_key(i.price_list_id, i.variant_id, i.unit_id)
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
    JOIN price_list_items i ON i.tenant_id = n.tenant_id AND i.price_list_id = n.id
   WHERE (n.archived_at IS NULL) <> (o.archived_at IS NULL);
  RETURN NULL;
END $$;

CREATE TRIGGER price_lists_sync_scope
  AFTER UPDATE ON price_lists
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_price_list_scope();

-- 7) The company's name is in tenants, not in tenant_settings (0007), but it is part of the
--    device's settings row. tenants has no tenant_id column and no RLS, so it gets its own small
--    trigger, per row and only when the name changes: the setup wizard's status changes on the
--    same table must not reach the devices. The insert below passes the log's WITH CHECK only
--    inside the workspace's own tenant context, which SettingsService sets: a rename from outside
--    a tenant context (a future admin console) must set it first.
CREATE FUNCTION sync_log_tenant_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  VALUES (NEW.id, 'settings', NEW.id::text);
  RETURN NULL;
END $$;

CREATE TRIGGER tenants_sync_name
  AFTER UPDATE OF name ON tenants
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION sync_log_tenant_name();

-- 8) The synced tables. Postgres allows transition tables on a trigger of one event only, so each
--    table gets three triggers: <table>_sync_insert, _sync_update and _sync_delete.
--    - A product is one row with its variants, packs and barcodes (decision 14), so a change to
--      any of them logs the product. A product deleted for real takes its children with it (ON
--      DELETE CASCADE); their triggers log the product again, which does no harm.
--    - A party is logged only while it is (or was, for an UPDATE) a customer: a supplier that never
--      sold anything is not a device's business. An address is logged when its party is a customer
--      now; when a customer stops being one, the party's own line is the one that counts.
--    - A stock row carries its warehouse, so a device skips the other branches' stock.
--    - batches are not here: a batch's lot number and dates never change once it exists (step 13).
--      A later step that lets someone fix them must log its stock rows.
--    - warehouses log only themselves: a warehouse with stock cannot be archived
--      (warehouse_has_stock) or moved to another branch (warehouse_branch_locked), so its stock
--      rows never leave a device that way.
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT *
      FROM (VALUES
        ('tenant_settings', 'settings', 'r.tenant_id::text', 'true', 'NULL'),
        ('units', 'unit', 'r.id::text', 'true', 'NULL'),
        ('product_categories', 'product_category', 'r.id::text', 'true', 'NULL'),
        ('tax_rates', 'tax_rate', 'r.id::text', 'true', 'NULL'),
        ('warehouses', 'warehouse', 'r.id::text', 'true', 'NULL'),
        ('price_lists', 'price_list', 'r.id::text', 'true', 'NULL'),
        ('customer_groups', 'customer_group', 'r.id::text', 'true', 'NULL'),
        ('products', 'product', 'r.id::text', 'true', 'NULL'),
        ('product_variants', 'product', 'r.product_id::text', 'true', 'NULL'),
        ('product_units', 'product', 'r.product_id::text', 'true', 'NULL'),
        ('product_barcodes', 'product', 'r.product_id::text', 'true', 'NULL'),
        ('price_list_items', 'price_list_item',
           'sync_price_key(r.price_list_id, r.variant_id, r.unit_id)', 'true', 'NULL'),
        ('parties', 'customer', 'r.id::text', 'r.is_customer', 'NULL'),
        ('party_addresses', 'customer', 'r.party_id::text',
           'EXISTS (SELECT 1 FROM parties p
                     WHERE p.tenant_id = r.tenant_id AND p.id = r.party_id AND p.is_customer)',
           'NULL'),
        ('stock_balances', 'stock', 'sync_stock_key(r.warehouse_id, r.variant_id, r.batch_id)',
           'true', 'r.warehouse_id')
      ) AS v(tbl, entity, key_sql, filter_sql, warehouse_sql)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_insert', s.tbl, s.entity, s.key_sql, s.filter_sql, s.warehouse_sql
    );
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_update', s.tbl, s.entity, s.key_sql, s.filter_sql, s.warehouse_sql
    );
    EXECUTE format(
      'CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_delete', s.tbl, s.entity, s.key_sql, s.filter_sql, s.warehouse_sql
    );
  END LOOP;
END $$;
```

- **Section 1** is the same RLS loop as every step, on the two tables.
- **Section 2 takes rights away from the API.** The log is written by triggers, which run as the API's own role, so
  `INSERT` and `SELECT` stay. `UPDATE` and `DELETE` go: a bug that deleted lines would make devices silently miss
  changes, and nobody would see it until a shop sold at an old price. A device is never deleted (decision 32).
- **Section 3 is the cleanup's policy,** a copy of 0012's for the outbox. The worker deletes the old lines of every
  tenant in one statement, so `tenant_isolation` alone would show it nothing. The policy is for `omnivo_worker`
  only; policies are OR-ed, so the API's role still sees one tenant's lines. The worker gets `SELECT` and `DELETE`
  (a `DELETE … WHERE created_at < …` reads `created_at`), never `INSERT`.
- **Section 4, the two key functions.** The format of a price key and a stock key is part of the contract
  (`priceListItemKey()`, `stockKey()` in 18a.1), so it is written once in SQL: the triggers use these functions, and
  18a.3's pull will use them to find a row from its key. `coalesce(batch_id::text, '-')` is the `-` of `stockKey()`;
  without it, the key of a variant without batches would be NULL (`text || NULL` is NULL) and the line would be lost.
  `uuid::text` writes lower-case ids, the same as the ids the API sends, so the device's keys and the server's keys
  are equal strings. `IMMUTABLE` lets Postgres inline them.
- **Section 5, `sync_log()`, one function for all the synced tables** (decision 28).
  - It is a statement trigger, so it runs once however many rows the statement wrote, and reads them from the
    transition tables `new_rows` and `old_rows`. `DISTINCT` makes the 300 variants of a style one line.
  - **Its four arguments are SQL text** from section 8: the entity, how to build the key from a row `r`, which rows
    count, and the warehouse of a stock row. They are fixed strings in this migration, never input, so building the
    statement with `format()` and `EXECUTE` is safe. `%L` quotes the entity as a literal; the other three are SQL and
    go in with `%s`. A transition table can be read from `EXECUTE`: Postgres makes it visible to every query the
    function runs.
  - **An `UPDATE` logs the rows before and after** (`old_rows UNION ALL new_rows`). No key ever changes in an update,
    but a filter can stop being true: a customer whose `is_customer` turns off is not in `new_rows` any more under
    the filter, and the device must still hear about it to drop the row.
  - **`(%s)::uuid` on the warehouse:** for every entity but stock the argument is `NULL`, and a bare `NULL` in a
    `SELECT DISTINCT` is read as `text`, which does not fit the `uuid` column. The cast makes it a `uuid` NULL.
  - `RETURN NULL`: the result of an `AFTER` trigger is ignored.
- **Section 6, the two scope triggers** (decision 27).
  - Archiving a product writes only `products`, but its prices and its stock rows leave the device with it, and come
    back when it is restored. Nothing writes those rows, so `sync_log()` on their tables never sees it; these
    triggers log them. A list's archive does the same for its prices.
  - `(n.archived_at IS NULL) <> (o.archived_at IS NULL)` is "it was archived or restored by this statement". Any
    other change of a product (its name) logs only the product, through `sync_log()`.
  - **Stock at zero is left out.** It is not on any device (decision 16), so sending a delete for it is noise.
  - **The stock rows are found through the variants.** `stock_balances` has an index on the variant
    (`stock_balances_variant_idx`), not on the product: joining on `product_id` would read every stock row of the
    tenant.
- **Section 7, the company's name.** `tenants.name` is part of the device's settings row (decision 22), but it is not
  in `tenant_settings`: it lives on `tenants`, which the login reads without a tenant context. `tenants` has no
  `tenant_id` column, so `sync_log()` cannot serve it; a small row trigger does, and only when the name really
  changes (`UPDATE OF name` with `WHEN (OLD.name IS DISTINCT FROM NEW.name)`): the setup wizard writes
  `setup_status` on the same table, and that is not the device's business. One caveat, written in the comment:
  `tenants` has no RLS, but the log has, so a rename only works inside the workspace's tenant context.
  `SettingsService` renames inside it already; a future admin console must set it first, or the rename fails.
- **Section 8 creates the triggers.**
  - **Three per table.** Postgres refuses transition tables on a trigger with more than one event ("transition tables
    cannot be specified for triggers with more than one event"), so each table gets `_sync_insert`, `_sync_update`
    and `_sync_delete`, made in one loop. 15 tables, plus the two scope triggers and the name trigger: 48 triggers.
  - **The variants, packs and barcodes log their product** (decision 14): the device keeps a product as one row.
  - **A product deleted for real** (only one that never had stock can be) takes its variants, packs, barcodes and
    prices with it by `ON DELETE CASCADE`. A cascade runs as its own statement on each child table, so their triggers
    fire too: the prices are logged (the device drops them), and the product is logged a second time, which costs
    one line.
  - **The parties' filter is `r.is_customer`** (decision 29). With the before-and-after rule of section 5, a party
    is logged when it is a customer before or after the change: a supplier that becomes a customer comes onto the
    device, a customer that becomes only a supplier leaves it.
  - **An address is logged only while its party is a customer now.** When a customer stops being one, the party's own
    line takes it off the device; its addresses' later changes are nobody's business. A cascade delete of the
    addresses (the party deleted) finds no party any more, and logs nothing: the party's own line already did.
  - **`batches` has no trigger:** a stock row carries its batch's lot number and dates (decision 23), but no code ever
    changes a batch once it exists. The comment says what a later step must do if that changes.
  - **`warehouses` logs only itself.** A warehouse with stock cannot be archived (`warehouse_has_stock`) or moved to
    another branch (`warehouse_branch_locked`), so its stock never leaves a device that way.
  - **`stock_balances` is written by 0022's trigger,** once per movement, never by code. Its log lines therefore come
    in the same transaction as the movement that changed it, through an `INSERT … ON CONFLICT DO UPDATE`, which fires
    the insert trigger for a new balance and the update trigger for an existing one.

> **What we checked.** On a throwaway database with every migration up to 0044, as `omnivo_app` (64 checks, plus a
> race in three sessions). Every synced table logged the right entity and the contract's exact key: a price as
> `list:variant:unit` and a stock row as `warehouse:variant:batch` with `-` and no batch, in lower case, with its
> warehouse (and only stock lines had one). Two variants of one product in one statement made one line. A
> settings change and a rename logged the settings; the setup status and a rename to the same name logged nothing. A
> supplier, its address and its changes logged nothing; it logged once it became a customer, and a customer that
> became only a supplier logged once, then never again, nor its address. Archiving a product logged its prices and
> its stock (not the row at zero), and so did restoring it; two products in one statement worked the same way; a
> rename logged only the product. Archiving a list logged its prices; its other changes only the list. A product
> deleted for real logged its prices with it; a deleted price and a deleted customer logged their keys. Every line of
> one transaction had its transaction's id. A device of a person who is not a member, or in another tenant's branch,
> failed; a device could not be deleted, and writing its last sync kept its version. The API's role could not change
> or delete a log line, nor write another tenant's; each tenant saw only its own lines and devices, and a rename
> outside the tenant context failed. The worker's role saw every tenant's lines, deleted the ones older than 30 days,
> and could not write a line or read the devices.
>
> **The race (decision 25).** Session A wrote a unit and kept its transaction open for 4 seconds; session B wrote a
> unit a second later and committed at once. A pull while A was still open returned nothing, and its next cursor was
> the cursor it started from: B's committed line waits behind A. The pull after A committed, from that cursor,
> returned both. A plain "lines after the last id I saw" cursor got B's line on the first pull and then missed A's for
> good: A took the lower id first, but committed last. That is the bug the watermark exists to prevent.
>
> The API's integration and tenant-leak suites (`apps/api`, 52 files, 579 tests) pass on 0044 unchanged: the triggers fire
> under every existing write, from the stock postings to the price list saves.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
```

`pnpm db:migrate` applies 0043 and 0044 to your dev database. Then `pnpm --filter @omnivo/db build`, so the API sees
the two new tables in 18a.3. As in 18a.1, do not run the whole `pnpm typecheck` yet.

## 18a.3 — `apps/api`: registering a device, the pull, and the balances

The database now writes a line for every change. This part is the API that reads it. Three routes, all from the
18a.1 contract: `POST /sync/devices` registers the browser, `GET /sync/pull` sends the rows, and
`GET /customer-balances` gives the customer list its balances. The worker's hourly job also starts pruning the log.

The new code is one module, `apps/api/src/sync/`. Before it, two small changes in the products and sales modules
let the pull build a product and a customer exactly the way their pages do.

How a pull works, in short (the details are with each file):

1. The API checks the protocol and the device, and reads two things from Postgres in one statement: the oldest
   transaction still running (the **watermark**) and the database's clock.
2. **Without a cursor**, or with one that no longer fits, it starts a **full pull**: every row the device keeps,
   entity after entity in `SYNC_ENTITIES` order, a page at a time. The full pull remembers the watermark of its first
   page. When it ends, its last cursor points into the change log at that watermark.
3. **With a cursor into the log** (a **delta pull**), it reads the log's lines between the cursor's watermark and the
   current one, takes each key once, and reads those rows in their current state. A key whose row is gone, or no
   longer in the device's data set, goes out as a delete.
4. On the last page (`hasMore: false`), it writes the device's `last_sync_at`.

### Products and customers, many at a time

The device keeps a product as the product page shows it, with its variants, packs and barcodes (decision 14). Until
now only `ProductsService.read()` could build that, one product with four queries. The pull needs a page of up to
1000 at once. So the building moves into a function of its own that takes many rows, and the page calls it too
(decision 33).

```ts
import type { Product } from '@omnivo/contracts';
import { productBarcodes, type products, productUnits, productVariants } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

type ProductRow = typeof products.$inferSelect;

// Whole products from their rows: the variants, packs and barcodes of all of them in three
// queries, however many there are. The product page reads one; the sync's pull (step 18a) reads a
// page of up to 1000, and three queries per product would be 3000 round trips. The answer keeps the
// order of `rows`.
export async function productsOf(tx: Transaction, rows: ProductRow[]): Promise<Product[]> {
  if (rows.length === 0) return [];
  const tenantId = getTenantId();
  const ids = rows.map((row) => row.id);
  const [variants, packs, barcodes] = await Promise.all([
    tx
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, ids)))
      .orderBy(asc(productVariants.position)),
    tx
      .select()
      .from(productUnits)
      .where(and(eq(productUnits.tenantId, tenantId), inArray(productUnits.productId, ids)))
      .orderBy(asc(productUnits.position)),
    tx
      .select()
      .from(productBarcodes)
      .where(and(eq(productBarcodes.tenantId, tenantId), inArray(productBarcodes.productId, ids))),
  ]);
  const variantsOf = groupBy(variants, (variant) => variant.productId);
  const packsOf = groupBy(packs, (pack) => pack.productId);
  // A barcode belongs to a variant (no unit) or to a pack (its unit). A pack's unit is unique per
  // product only, so the pack's map is keyed by the product too.
  const variantBarcode = new Map(
    barcodes.flatMap((barcode) =>
      barcode.unitId === null ? [[barcode.variantId, barcode.code]] : [],
    ),
  );
  const packBarcode = new Map(
    barcodes.flatMap((barcode) =>
      barcode.unitId === null ? [] : [[`${barcode.productId}:${barcode.unitId}`, barcode.code]],
    ),
  );
  return rows.map((row) => {
    const ownPacks = packsOf.get(row.id) ?? [];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      categoryId: row.categoryId,
      description: row.description,
      baseUnitId: row.baseUnitId,
      salesUnitId: ownPacks.find((pack) => pack.isSalesDefault)?.unitId ?? null,
      purchaseUnitId: ownPacks.find((pack) => pack.isPurchaseDefault)?.unitId ?? null,
      tracking: row.tracking,
      hasExpiry: row.hasExpiry,
      taxRateId: row.taxRateId,
      options: row.options,
      variants: (variantsOf.get(row.id) ?? []).map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        optionValues: variant.optionValues,
        barcode: variantBarcode.get(variant.id) ?? null,
        salePrice: variant.salePrice,
        archivedAt: variant.archivedAt?.toISOString() ?? null,
      })),
      units: ownPacks.map((pack) => ({
        unitId: pack.unitId,
        factor: pack.factor,
        barcode: packBarcode.get(`${row.id}:${pack.unitId}`) ?? null,
      })),
      customFields: row.customFields,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

// The rows of each product, in the order the query gave them
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
```

- **It takes rows, not ids or a filter.** The page reads one row by id; the pull reads a page in id order with the
  data set's filter. Each caller writes its own `SELECT`, and this function adds the children. So it never decides
  which products are visible: it cannot leak an archived product into a pull by accident.
- **Three queries with `inArray`, whatever the number of rows,** instead of three per product. `Promise.all` sends
  them together on the transaction's one connection; Postgres runs them one after another, but there is no wait
  between them.
- **`if (rows.length === 0) return []`** avoids `inArray` with an empty list. Drizzle would write `false` for it,
  which works, but three queries that can only return nothing are three round trips for nothing.
- **The pack barcode map is keyed by product and unit together.** In the old one-product code, the unit's id alone
  was enough. Across many products it is not: two products both sold by the `case` have the same unit id, and the
  second barcode would overwrite the first in the map. This is the one line that is not a straight move of the old
  code, and the bug it avoids would show the wrong barcode under a carton on the scanner screen.
- **`groupBy` keeps the order of the query,** so the variants and packs keep their `position` order, as before.
- **The answer keeps the order of `rows`.** The full pull's cursor continues after the last product of the page, so
  the page must end with the product its query ended with.

```diff
@@ -13,14 +13,13 @@ import {
   productBarcodes,
   productCategories,
   products,
-  productUnits,
   productVariants,
   stockMovements,
   taxRates,
   tenantSettings,
   units,
 } from '@omnivo/db';
-import { and, asc, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm';
+import { and, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
@@ -32,6 +31,7 @@ import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.j
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { NumberingService } from '../numbering/numbering.service.js';
+import { productsOf } from './product-read.js';
 import {
   barcodeRows,
   checkProduct,
@@ -535,72 +535,16 @@ export class ProductsService {
     return row;
   }
 
-  // The whole product: its row, variants, units and barcodes, in four small queries
+  // The whole product: its row, then its variants, units and barcodes (productsOf)
   private async read(tx: Transaction, id: string): Promise<Product> {
-    const tenantId = getTenantId();
     const [row] = await tx
       .select()
       .from(products)
-      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));
+      .where(and(eq(products.tenantId, getTenantId()), eq(products.id, id)));
     if (!row) throw notFound('Product');
-    const [variants, packs, barcodes] = await Promise.all([
-      tx
-        .select()
-        .from(productVariants)
-        .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, id)))
-        .orderBy(asc(productVariants.position)),
-      tx
-        .select()
-        .from(productUnits)
-        .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.productId, id)))
-        .orderBy(asc(productUnits.position)),
-      tx
-        .select()
-        .from(productBarcodes)
-        .where(and(eq(productBarcodes.tenantId, tenantId), eq(productBarcodes.productId, id))),
-    ]);
-    const variantBarcode = new Map(
-      barcodes.flatMap((barcode) =>
-        barcode.unitId === null ? [[barcode.variantId, barcode.code]] : [],
-      ),
-    );
-    const packBarcode = new Map(
-      barcodes.flatMap((barcode) =>
-        barcode.unitId === null ? [] : [[barcode.unitId, barcode.code]],
-      ),
-    );
-    return {
-      id: row.id,
-      code: row.code,
-      name: row.name,
-      type: row.type,
-      categoryId: row.categoryId,
-      description: row.description,
-      baseUnitId: row.baseUnitId,
-      salesUnitId: packs.find((pack) => pack.isSalesDefault)?.unitId ?? null,
-      purchaseUnitId: packs.find((pack) => pack.isPurchaseDefault)?.unitId ?? null,
-      tracking: row.tracking,
-      hasExpiry: row.hasExpiry,
-      taxRateId: row.taxRateId,
-      options: row.options,
-      variants: variants.map((variant) => ({
-        id: variant.id,
-        sku: variant.sku,
-        optionValues: variant.optionValues,
-        barcode: variantBarcode.get(variant.id) ?? null,
-        salePrice: variant.salePrice,
-        archivedAt: variant.archivedAt?.toISOString() ?? null,
-      })),
-      units: packs.map((pack) => ({
-        unitId: pack.unitId,
-        factor: pack.factor,
-        barcode: packBarcode.get(pack.unitId) ?? null,
-      })),
-      customFields: row.customFields,
-      archivedAt: row.archivedAt?.toISOString() ?? null,
-      version: row.version,
-      updatedAt: row.updatedAt.toISOString(),
-    };
+    const [product] = await productsOf(tx, [row]);
+    if (!product) throw new Error('productsOf returned no product');
+    return product;
   }
 
   private async snapshot(tx: Transaction, product: Product): Promise<Snapshot> {
```

- `read()` now reads the one row and hands it to `productsOf()`. Its `404` stays where it was: `productsOf()` is
  never asked about a product that does not exist.
- **`if (!product) throw new Error(...)`** cannot happen (one row in, one product out), but with
  `noUncheckedIndexedAccess` the destructured `product` is `Product | undefined`. A plain `Error` is a 500 that says
  what broke; a `!` would hide it.
- The imports of `productUnits` and `asc` go: nothing else in the service uses them now. `productVariants` and
  `productBarcodes` stay, the writes use them.

The same move for customers. A customer comes with its addresses, and the pull never sends its balance (decision 10):

```ts
import type { Customer } from '@omnivo/contracts';
import { type parties, partyAddresses } from '@omnivo/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

type PartyRow = typeof parties.$inferSelect;

// A customer without its balance. The customer page adds the balance for people who may see it;
// the sync's pull (step 18a) never sends one (decision 10).
export type CustomerWithoutBalance = Omit<Customer, 'balance'>;

// Whole customers from their rows: the addresses of all of them in one query. The customer page
// reads one; the sync's pull reads a page of up to 1000. The answer keeps the order of `rows`.
export async function customersOf(
  tx: Transaction,
  rows: PartyRow[],
): Promise<CustomerWithoutBalance[]> {
  if (rows.length === 0) return [];
  const addresses = await tx
    .select()
    .from(partyAddresses)
    .where(
      and(
        eq(partyAddresses.tenantId, getTenantId()),
        inArray(
          partyAddresses.partyId,
          rows.map((row) => row.id),
        ),
      ),
    )
    // The billing address first, then the shipping ones in the order the person put them
    .orderBy(sql`${partyAddresses.kind} = 'billing' DESC`, asc(partyAddresses.position));
  const addressesOf = new Map<string, (typeof addresses)[number][]>();
  for (const address of addresses) {
    const own = addressesOf.get(address.partyId);
    if (own) own.push(address);
    else addressesOf.set(address.partyId, [address]);
  }
  return rows.map((party) => ({
    id: party.id,
    code: party.code,
    name: party.name,
    groupId: party.customerGroupId,
    contactPerson: party.contactPerson,
    phone: party.phone,
    email: party.email,
    documentLanguage: party.documentLanguage,
    bin: party.bin,
    paymentTermsDays: party.paymentTermsDays,
    creditLimit: party.creditLimit,
    priceListId: party.priceListId,
    notes: party.notes,
    addresses: (addressesOf.get(party.id) ?? []).map((address) => ({
      id: address.id,
      kind: address.kind,
      label: address.label,
      address: address.address,
      phone: address.phone,
    })),
    isSupplier: party.isSupplier,
    archivedAt: party.archivedAt?.toISOString() ?? null,
    version: party.version,
    updatedAt: party.updatedAt.toISOString(),
  }));
}
```

- **`CustomerWithoutBalance` is `Omit<Customer, 'balance'>`,** the shape `syncCustomerSchema` describes, without
  importing a sync type into the sales module. The two are the same type; the contract's interceptor checks it on
  the way out.
- **One address query for all the rows, in the order the page always used:** the billing address first, then the
  shipping ones by `position`. A device shows the addresses in the same order as the page.
- `import { type parties }`: the table is only used for its row type here, and the lint rule
  (`consistent-type-imports`) asks for a type import. Same for `products` in `product-read.ts`.

```diff
@@ -1,6 +1,7 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
   type Customer,
+  type CustomerBalances,
   type CustomerInput,
   type CustomerPage,
   type CustomerSort,
@@ -26,7 +27,7 @@ import {
   salesReturns,
   tenantSettings,
 } from '@omnivo/db';
-import { and, asc, eq, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
+import { and, eq, inArray, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
@@ -39,6 +40,7 @@ import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { NumberingService } from '../numbering/numbering.service.js';
 import { BalanceAccess } from './balance-access.js';
+import { customersOf } from './customer-read.js';
 
 type PartyRow = typeof parties.$inferSelect;
 
@@ -200,6 +202,27 @@ export class CustomersService {
     });
   }
 
+  // Step 18a (decision 10): the balances of the rows the customer list shows, which it reads from
+  // the device. The route needs sales.customer.balance, so there is no canSee() here. Archived
+  // customers count (the device may still show one archived a minute ago); an id that is not a
+  // customer of this workspace is left out. The same `balance` subquery as the list and the page,
+  // so the three never disagree.
+  balances(ids: string[]): Promise<CustomerBalances> {
+    return this.withTenant(async (tx) => {
+      const rows = await tx
+        .select({ id: parties.id, balance })
+        .from(parties)
+        .where(
+          and(
+            eq(parties.tenantId, getTenantId()),
+            inArray(parties.id, ids),
+            eq(parties.isCustomer, true),
+          ),
+        );
+      return { items: rows };
+    });
+  }
+
   async get(id: string): Promise<Customer> {
     const canSeeBalance = await this.access.canSee();
     return this.withTenant((tx) => this.read(tx, id, canSeeBalance));
@@ -570,46 +593,16 @@ export class CustomersService {
   }
 
   private async read(tx: Transaction, id: string, canSeeBalance: boolean): Promise<Customer> {
-    const tenantId = getTenantId();
     const [row] = await tx
       .select({ party: parties, balance: canSeeBalance ? balance : sql<null>`NULL` })
       .from(parties)
-      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, id), eq(parties.isCustomer, true)));
+      .where(
+        and(eq(parties.tenantId, getTenantId()), eq(parties.id, id), eq(parties.isCustomer, true)),
+      );
     if (!row) throw notFound('Customer');
-    const { party } = row;
-    const addresses = await tx
-      .select()
-      .from(partyAddresses)
-      .where(and(eq(partyAddresses.tenantId, tenantId), eq(partyAddresses.partyId, id)))
-      // The billing address first, then the shipping ones in the order the person put them
-      .orderBy(sql`${partyAddresses.kind} = 'billing' DESC`, asc(partyAddresses.position));
-    return {
-      id: party.id,
-      code: party.code,
-      name: party.name,
-      groupId: party.customerGroupId,
-      contactPerson: party.contactPerson,
-      phone: party.phone,
-      email: party.email,
-      documentLanguage: party.documentLanguage,
-      bin: party.bin,
-      paymentTermsDays: party.paymentTermsDays,
-      creditLimit: party.creditLimit,
-      priceListId: party.priceListId,
-      notes: party.notes,
-      addresses: addresses.map((address) => ({
-        id: address.id,
-        kind: address.kind,
-        label: address.label,
-        address: address.address,
-        phone: address.phone,
-      })),
-      isSupplier: party.isSupplier,
-      balance: row.balance,
-      archivedAt: party.archivedAt?.toISOString() ?? null,
-      version: party.version,
-      updatedAt: party.updatedAt.toISOString(),
-    };
+    const [customer] = await customersOf(tx, [row.party]);
+    if (!customer) throw new Error('customersOf returned no customer');
+    return { ...customer, balance: row.balance };
   }
 
   private async snapshot(tx: Transaction, customer: Customer): Promise<Snapshot> {
```

- **`read()` keeps the balance in its own query,** with the same `balance` subquery and the same rule (no
  permission: not even worked out). `customersOf()` builds the rest, and the spread adds the balance.
- **`balances()` is the new route's work** (decision 10). It uses the same `balance` subquery as the list and the
  page, so the three can never show different numbers for one customer.
- **No `canSee()` in it:** the route's `permission: 'sales.customer.balance'` already stopped everyone else with a
  403 before the service runs.
- **`eq(parties.isCustomer, true)` but no archive filter.** A customer archived a minute ago may still be on the
  device until its next pull, and asking for its balance is not an error. A supplier's id gets nothing: what a
  supplier is owed is not a customer balance.
- **An id that is not a customer of this workspace is simply missing from `items`,** never a 404. The device may hold
  a customer that was deleted a minute ago; one gone row must not break the balances of the 99 others on the screen.
  RLS hides another workspace's ids the same way.

```diff
@@ -77,6 +77,12 @@ export class CustomersController {
     return this.ledgers.statement(params.id, query);
   }
 
+  // Step 18a: what the customers on the device's list owe, online only
+  @Endpoint(routes.customers.balances)
+  balances({ query }: RouteInput<Routes['balances']>): Promise<RouteResponse<Routes['balances']>> {
+    return this.customers.balances(query.ids);
+  }
+
   // Step 15c: also sales.customer.balance — the numbers say what the customer owes
   @Endpoint(routes.customers.credit)
   credit({ params }: RouteInput<Routes['credit']>): Promise<RouteResponse<Routes['credit']>> {
```

The handler only passes the parsed `ids` on. The contract split the comma-separated string and checked every id and
the count (1 to 100) before this runs.

Three mappers become exported, unchanged, because the device keeps a unit, a VAT rate and a warehouse in exactly the
shape the API sends:

```diff
@@ -12,7 +12,7 @@ import { WITH_TENANT } from '../infra/tokens.js';
 
 type UnitRow = typeof units.$inferSelect;
 
-function toUnit(row: UnitRow): Unit {
+export function toUnit(row: UnitRow): Unit {
   return {
     id: row.id,
     code: row.code,
```

```diff
@@ -12,7 +12,7 @@ import { WITH_TENANT } from '../infra/tokens.js';
 
 type TaxRateRow = typeof taxRates.$inferSelect;
 
-function toTaxRate(row: TaxRateRow): TaxRate {
+export function toTaxRate(row: TaxRateRow): TaxRate {
   return {
     id: row.id,
     name: row.name,
```

```diff
@@ -17,7 +17,7 @@ import { WITH_TENANT } from '../infra/tokens.js';
 
 type WarehouseRow = typeof warehouses.$inferSelect;
 
-function toWarehouse(row: WarehouseRow): Warehouse {
+export function toWarehouse(row: WarehouseRow): Warehouse {
   return {
     id: row.id,
     branchId: row.branchId,
```

A category, a price list and a customer group are not reused this way: their mappers take the counts the device does
not keep (decision 15). The pull maps those three itself, in a few lines each.

### `sync/sync-cursor.ts` (new): what the cursor holds

```ts
import { SYNC_ENTITIES } from '@omnivo/contracts';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';

// The pull's cursor (decision 13). The contract calls it opaque: the device only stores it and
// sends it back, so what is inside can change without a new protocol. It is JSON in base64url,
// like the lists' cursors, and checked with these schemas when it comes back: a broken or edited
// cursor answers invalid_cursor (400), never a Postgres cast error (500).

// A transaction id (xid8) as text. It can pass 2^53, so it is never a JavaScript number; only the
// database compares two of them.
const xidSchema = z.string().regex(/^\d{1,20}$/);

const common = {
  // SYNC_PROTOCOL when the cursor was made. A cursor of another protocol starts a full pull.
  protocol: z.number().int(),
  // The device's branch when the cursor was made. A device moved to another branch (step 18c)
  // needs other warehouses and stock, so its next pull is a full one.
  branchId: z.uuid(),
  // When the watermark this cursor reads from was taken, by the database's clock. The change log
  // keeps 30 days; a cursor older than that may need lines that are gone (decision 26).
  issuedAt: z.iso.datetime(),
};

// A full pull in progress: every row the device keeps, entity by entity in SYNC_ENTITIES order,
// each in the order of its key columns.
const fullCursorSchema = z.object({
  kind: z.literal('full'),
  ...common,
  // The oldest transaction still running when the full pull started. Everything that committed
  // before it is in the pages; everything from it on comes with the next pull, from the change
  // log. That is why rows read later in the full pull may be newer: never older.
  watermark: xidSchema,
  // The next page starts in SYNC_ENTITIES[entity], after the row whose key columns are `after`
  // (null = at its first row). A stock row's batch may be null.
  entity: z.number().int().min(0).max(SYNC_ENTITIES.length),
  after: z.array(z.uuid().nullable()).min(1).max(3).nullable(),
});
export type FullCursor = z.infer<typeof fullCursorSchema>;

// Changes from the log: the lines of the transactions with `from` <= xid < `to`.
const deltaCursorSchema = z.object({
  kind: z.literal('delta'),
  ...common,
  from: xidSchema,
  // null: the next pull starts here, and its first page takes a new `to`. Set: a pull in
  // progress, which reads up to this `to` until it is done, after the line `after` (its xid and
  // id). Without a fixed `to`, a busy workspace could keep `hasMore` true for ever.
  to: xidSchema.nullable(),
  after: z.tuple([xidSchema, z.number().int()]).nullable(),
});
export type DeltaCursor = z.infer<typeof deltaCursorSchema>;

const syncCursorSchema = z.discriminatedUnion('kind', [fullCursorSchema, deltaCursorSchema]);
export type SyncCursor = z.infer<typeof syncCursorSchema>;

// encodeCursor takes the values of a list's sort columns; this cursor is one object, so it is the
// one value of that list
export function encodeSyncCursor(cursor: SyncCursor): string {
  return encodeCursor([cursor]);
}

export function decodeSyncCursor(cursor: string | undefined): SyncCursor | undefined {
  return decodeCursor(cursor, z.tuple([syncCursorSchema]))?.[0];
}
```

- **The cursor is JSON in base64url,** like the lists' cursors, and `decodeSyncCursor()` checks it with Zod when it
  comes back. The device could send anything; a broken cursor must be a `400 invalid_cursor`, not a cast error in
  Postgres (a 500). `encodeCursor()` takes a list of values, so the cursor object goes in as a list of one.
- **An xid is a string of digits,** never a `number`: it can pass 2^53, where a JavaScript number loses digits. A
  cursor whose watermark lost its last digit would skip or repeat a whole transaction. The regular expression lets
  only digits reach SQL's `::xid8`.
- **`protocol`, `branchId` and `issuedAt` are in both kinds** (`common`). Each one can make a cursor useless: another
  protocol, a device moved to another branch, or a watermark older than the log keeps. The pull then starts again
  with a full pull instead of answering with an error the app would have to handle.
- **`issuedAt` is when the cursor's watermark was taken,** by the database's clock (decision 39). The log deletes lines
  by their `created_at`; comparing the two needs one clock.
- **The full cursor's `watermark`** is taken on the full pull's first page and kept on every later page. Rows read on
  page 30 may be newer than the watermark; that is safe (decision 36). Older is impossible: every transaction below the
  watermark had ended when it was taken.
- **`entity` and `after`** say where the next page starts: an index into `SYNC_ENTITIES`, and the key columns of the
  last row sent (one id, or three for a price and a stock row). **`after` may hold a `null`:** a stock row without a
  batch.
- **The delta cursor's `to`** is `null` between pulls and set during one (decision 34). **`after`** is the last line
  sent, its xid and its `id`: two lines of one transaction have the same xid, so the `id` breaks the tie.

### `sync/sync-rows.ts` (new): one loader per entity

A loader reads one entity's rows. It is called two ways: with **keys** (a delta pull: the keys the log named) or for a
**page** (a full pull: the next rows in key order). Both ways apply the same data set rules, written once per entity,
so a delta pull and a full pull can never disagree on what a device keeps.

```ts
import {
  priceListItemKey,
  stockKey,
  type SyncCategory,
  type SyncCustomerGroup,
  type SyncEntity,
  type SyncPriceList,
  type SyncUpsert,
} from '@omnivo/contracts';
import {
  customerGroups,
  parties,
  priceLists,
  productCategories,
  products,
  taxRates,
  tenantSettings,
  tenants,
  units,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';
import { toWarehouse } from '../inventory/warehouses.service.js';
import { productsOf } from '../products/product-read.js';
import { toUnit } from '../products/units.service.js';
import { customersOf } from '../sales/customer-read.js';
import { toTaxRate } from '../tax/tax-rates.service.js';

// What one device may keep, worked out once per page from its row (SyncService)
export interface SyncScope {
  tenantId: string;
  // The device's branch (decision 9)
  branchId: string;
  // Its active warehouses: the ones the device keeps, with their stock
  warehouseIds: string[];
}

// Which rows a loader reads:
//   keys  the rows the change log named (a delta pull). A key whose row is gone, or no longer in
//         the scope, is simply not in the answer; SyncService sends it as a delete.
//   page  the rows after `after` in key order, at most `limit` (a full pull)
export type SyncPick =
  { by: 'keys'; keys: string[] } | { by: 'page'; after: (string | null)[] | null; limit: number };

// A row as the pull sends it, and its key columns: the full pull's cursor continues after them
export interface SyncLoaded {
  change: SyncUpsert;
  sort: (string | null)[];
}

type Loader = (tx: Transaction, scope: SyncScope, pick: SyncPick) => Promise<SyncLoaded[]>;

// The tables keyed by their own id: by the keys, or the next page in id order. In keys mode the
// limit is the number of keys: one row per id at most.
function byId(id: PgColumn, pick: SyncPick): { where: SQL | undefined; limit: number } {
  if (pick.by === 'keys') return { where: inArray(id, pick.keys), limit: pick.keys.length };
  const after = pick.after?.[0];
  return { where: after == null ? undefined : gt(id, after), limit: pick.limit };
}

// Timestamps of a raw query as ISO text, like ProductsService's list: Drizzle leaves them as
// Postgres's own text there, which is not ISO
function isoText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// A key the log wrote with sync_price_key() / sync_stock_key(): ids joined by ':'. A key of
// another shape cannot come from those functions; it is skipped rather than sent to SQL.
const uuidSchema = z.uuid();
function splitKey(key: string, parts: number): string[] | null {
  const ids = key.split(':');
  return ids.length === parts ? ids : null;
}

// A stock row without a batch: '-' in its key, NULL in the table. In the full pull's order (and
// in its cursor) it sorts as the nil uuid, before every batch of the variant: a row comparison
// with NULL is never true, so `(…, batch_id) > (…)` alone would loop on that row.
const NO_BATCH = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

const priceRowSchema = z.object({
  price_list_id: z.uuid(),
  product_id: z.uuid(),
  variant_id: z.uuid(),
  unit_id: z.uuid(),
  price: z.string(),
  updated_at: z.iso.datetime(),
});

const stockRowSchema = z.object({
  warehouse_id: z.uuid(),
  product_id: z.uuid(),
  variant_id: z.uuid(),
  batch_id: z.uuid().nullable(),
  lot_number: z.string().nullable(),
  manufactured_on: z.iso.date().nullable(),
  expires_on: z.iso.date().nullable(),
  quantity: z.string(),
  updated_at: z.iso.datetime(),
});

// One loader per entity. Each applies the scope of 18a.2's facts, in both modes, so a delta and a
// full pull can never disagree on what a device keeps:
//   settings, units, categories, VAT rates, price lists, groups  all of them (archived ones too:
//                       a product or a customer may still point at one)
//   warehouse           active, of the device's branch
//   product             active
//   price_list_item     its product active and its list active (decision 27)
//   customer            a customer (not only a supplier), active
//   stock               in an active warehouse of the branch, not zero, its product active
export const LOADERS: Record<SyncEntity, Loader> = {
  // One row, keyed by the workspace's id (the contract's settings key)
  settings: async (tx, scope, pick) => {
    const wanted = pick.by === 'keys' ? pick.keys.includes(scope.tenantId) : pick.after === null;
    if (!wanted) return [];
    const [row] = await tx
      .select({ settings: tenantSettings, companyName: tenants.name })
      .from(tenantSettings)
      .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
      .where(eq(tenantSettings.tenantId, scope.tenantId));
    if (!row) return [];
    const { settings } = row;
    return [
      {
        sort: [scope.tenantId],
        change: {
          op: 'upsert',
          entity: 'settings',
          key: scope.tenantId,
          data: {
            companyName: row.companyName,
            legalName: settings.legalName,
            bin: settings.bin,
            phone: settings.phone,
            address: settings.address,
            baseCurrency: settings.baseCurrency,
            fiscalYearStartMonth: settings.fiscalYearStartMonth,
            timezone: settings.timezone,
            allowNegativeStock: settings.allowNegativeStock,
            pricesIncludeVat: settings.pricesIncludeVat,
            version: settings.version,
          },
        },
      },
    ];
  },

  unit: async (tx, scope, pick) => {
    const { where, limit } = byId(units.id, pick);
    const rows = await tx
      .select()
      .from(units)
      .where(and(eq(units.tenantId, scope.tenantId), where))
      .orderBy(asc(units.id))
      .limit(limit);
    return rows.map((row) => ({
      sort: [row.id],
      change: { op: 'upsert', entity: 'unit', key: row.id, data: toUnit(row) },
    }));
  },

  // Without productCount (decision 15): the device counts what it needs itself
  product_category: async (tx, scope, pick) => {
    const { where, limit } = byId(productCategories.id, pick);
    const rows = await tx
      .select()
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, scope.tenantId), where))
      .orderBy(asc(productCategories.id))
      .limit(limit);
    return rows.map((row) => {
      const data: SyncCategory = {
        id: row.id,
        parentId: row.parentId,
        name: row.name,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      };
      return {
        sort: [row.id],
        change: { op: 'upsert', entity: 'product_category', key: row.id, data },
      };
    });
  },

  tax_rate: async (tx, scope, pick) => {
    const { where, limit } = byId(taxRates.id, pick);
    const rows = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.tenantId, scope.tenantId), where))
      .orderBy(asc(taxRates.id))
      .limit(limit);
    return rows.map((row) => ({
      sort: [row.id],
      change: { op: 'upsert', entity: 'tax_rate', key: row.id, data: toTaxRate(row) },
    }));
  },

  warehouse: async (tx, scope, pick) => {
    const { where, limit } = byId(warehouses.id, pick);
    const rows = await tx
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, scope.tenantId),
          eq(warehouses.branchId, scope.branchId),
          isNull(warehouses.archivedAt),
          where,
        ),
      )
      .orderBy(asc(warehouses.id))
      .limit(limit);
    return rows.map((row) => ({
      sort: [row.id],
      change: { op: 'upsert', entity: 'warehouse', key: row.id, data: toWarehouse(row) },
    }));
  },

  // Without itemCount and customerCount (decision 15)
  price_list: async (tx, scope, pick) => {
    const { where, limit } = byId(priceLists.id, pick);
    const rows = await tx
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, scope.tenantId), where))
      .orderBy(asc(priceLists.id))
      .limit(limit);
    return rows.map((row) => {
      const data: SyncPriceList = {
        id: row.id,
        name: row.name,
        description: row.description,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      };
      return { sort: [row.id], change: { op: 'upsert', entity: 'price_list', key: row.id, data } };
    });
  },

  // Without customerCount (decision 15)
  customer_group: async (tx, scope, pick) => {
    const { where, limit } = byId(customerGroups.id, pick);
    const rows = await tx
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.tenantId, scope.tenantId), where))
      .orderBy(asc(customerGroups.id))
      .limit(limit);
    return rows.map((row) => {
      const data: SyncCustomerGroup = {
        id: row.id,
        name: row.name,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      };
      return {
        sort: [row.id],
        change: { op: 'upsert', entity: 'customer_group', key: row.id, data },
      };
    });
  },

  // A product with its variants (archived ones too: an old order line still names one), packs and
  // barcodes, built by the same productsOf() as the product page
  product: async (tx, scope, pick) => {
    const { where, limit } = byId(products.id, pick);
    const rows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, scope.tenantId), isNull(products.archivedAt), where))
      .orderBy(asc(products.id))
      .limit(limit);
    const whole = await productsOf(tx, rows);
    return whole.map((data) => ({
      sort: [data.id],
      change: { op: 'upsert', entity: 'product', key: data.id, data },
    }));
  },

  // Raw SQL: two joins for the scope, and a row comparison on the primary key's columns, which
  // price_list_items_pkey (tenant, list, variant, unit) serves in both modes
  price_list_item: async (tx, scope, pick) => {
    let filter: SQL;
    let limit: number;
    if (pick.by === 'keys') {
      const tuples = pick.keys.flatMap((key) => {
        const ids = splitKey(key, 3);
        return ids?.every((id) => uuidSchema.safeParse(id).success) ? [ids] : [];
      });
      if (tuples.length === 0) return [];
      filter = sql`(i.price_list_id, i.variant_id, i.unit_id) IN (${sql.join(
        tuples.map(
          ([list, variant, unit]) => sql`(${list}::uuid, ${variant}::uuid, ${unit}::uuid)`,
        ),
        sql`, `,
      )})`;
      limit = tuples.length;
    } else {
      const [list, variant, unit] = pick.after ?? [];
      filter =
        list == null
          ? sql`true`
          : sql`(i.price_list_id, i.variant_id, i.unit_id) > (${list}::uuid, ${variant}::uuid, ${unit}::uuid)`;
      limit = pick.limit;
    }
    const rows = z.array(priceRowSchema).parse(
      await tx.execute(sql`
        SELECT i.price_list_id::text, i.product_id::text, i.variant_id::text, i.unit_id::text,
               i.price::text, ${isoText(sql`i.updated_at`)} AS updated_at
          FROM price_list_items i
          JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
          JOIN price_lists l ON l.tenant_id = i.tenant_id AND l.id = i.price_list_id
         WHERE i.tenant_id = ${scope.tenantId}::uuid
           AND p.archived_at IS NULL AND l.archived_at IS NULL
           AND ${filter}
         ORDER BY i.price_list_id, i.variant_id, i.unit_id
         LIMIT ${limit}`),
    );
    return rows.map((row) => {
      const data = {
        priceListId: row.price_list_id,
        productId: row.product_id,
        variantId: row.variant_id,
        unitId: row.unit_id,
        price: row.price,
        updatedAt: row.updated_at,
      };
      return {
        sort: [row.price_list_id, row.variant_id, row.unit_id],
        change: { op: 'upsert', entity: 'price_list_item', key: priceListItemKey(data), data },
      };
    });
  },

  customer: async (tx, scope, pick) => {
    const { where, limit } = byId(parties.id, pick);
    const rows = await tx
      .select()
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, scope.tenantId),
          eq(parties.isCustomer, true),
          isNull(parties.archivedAt),
          where,
        ),
      )
      .orderBy(asc(parties.id))
      .limit(limit);
    const whole = await customersOf(tx, rows);
    return whole.map((data) => ({
      sort: [data.id],
      change: { op: 'upsert', entity: 'customer', key: data.id, data },
    }));
  },

  // In keys mode the batch is compared with IS NOT DISTINCT FROM ('-' = no batch = NULL); the
  // stock_balances_key index still finds the rows by warehouse and variant
  stock: async (tx, scope, pick) => {
    if (scope.warehouseIds.length === 0) return [];
    let filter: SQL;
    let limit: number;
    if (pick.by === 'keys') {
      const tuples = pick.keys.flatMap((key) => {
        const ids = splitKey(key, 3);
        if (!ids) return [];
        const [warehouse = '', variant = '', batch = ''] = ids;
        const valid =
          uuidSchema.safeParse(warehouse).success &&
          uuidSchema.safeParse(variant).success &&
          (batch === '-' || uuidSchema.safeParse(batch).success);
        return valid ? [{ warehouse, variant, batch: batch === '-' ? null : batch }] : [];
      });
      if (tuples.length === 0) return [];
      filter = sql`(${sql.join(
        tuples.map(
          ({ warehouse, variant, batch }) =>
            sql`(b.warehouse_id = ${warehouse}::uuid AND b.variant_id = ${variant}::uuid
                 AND b.batch_id IS NOT DISTINCT FROM ${batch}::uuid)`,
        ),
        sql` OR `,
      )})`;
      limit = tuples.length;
    } else {
      const [warehouse, variant, batch = null] = pick.after ?? [];
      filter =
        warehouse == null
          ? sql`true`
          : sql`(b.warehouse_id, b.variant_id, coalesce(b.batch_id, ${NO_BATCH}))
                  > (${warehouse}::uuid, ${variant}::uuid, coalesce(${batch}::uuid, ${NO_BATCH}))`;
      limit = pick.limit;
    }
    const rows = z.array(stockRowSchema).parse(
      await tx.execute(sql`
        SELECT b.warehouse_id::text, b.product_id::text, b.variant_id::text, b.batch_id::text,
               t.lot_number, t.manufactured_on::text, t.expires_on::text, b.quantity::text,
               ${isoText(sql`b.updated_at`)} AS updated_at
          FROM stock_balances b
          JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
          LEFT JOIN batches t ON t.tenant_id = b.tenant_id AND t.id = b.batch_id
         WHERE b.tenant_id = ${scope.tenantId}::uuid
           AND b.warehouse_id IN (${sql.join(
             scope.warehouseIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
           AND b.quantity <> 0 AND p.archived_at IS NULL
           AND ${filter}
         ORDER BY b.warehouse_id, b.variant_id, coalesce(b.batch_id, ${NO_BATCH})
         LIMIT ${limit}`),
    );
    return rows.map((row) => {
      const data = {
        warehouseId: row.warehouse_id,
        productId: row.product_id,
        variantId: row.variant_id,
        batchId: row.batch_id,
        lotNumber: row.lot_number,
        manufacturedOn: row.manufactured_on,
        expiresOn: row.expires_on,
        quantity: row.quantity,
        updatedAt: row.updated_at,
      };
      return {
        sort: [row.warehouse_id, row.variant_id, row.batch_id],
        change: { op: 'upsert', entity: 'stock', key: stockKey(data), data },
      };
    });
  },
};
```

- **`SyncScope`** is worked out once per page: the tenant, the device's branch, and the active warehouses of that
  branch. Every loader reads it; none of them reads the device again.
- **`SyncPick`** is a union: TypeScript makes each loader handle both cases, and `pick.keys` exists only after
  `pick.by === 'keys'` has been checked.
- **`SyncLoaded.sort`** is the row's key columns. The full pull puts the last one in its cursor (`after`), so the next
  page starts right after it. A key string cannot do that job for prices and stock: Postgres orders uuids by their
  bytes, and comparing the text form would need the right collation everywhere.
- **`byId()`** is the whole difference between the two ways for a table keyed by its id: `inArray` on the keys, or
  `id > after`. In keys mode the limit is the number of keys (one row per id at most), so every loader can always
  call `.limit()`.
- **`isoText()`** copies `ProductsService`'s three lines: a raw query's timestamps come back from Drizzle as Postgres's
  own text (`2026-10-20 09:55:01.12+00`), and the contract wants ISO. The two raw loaders need it.
- **`splitKey()` and the uuid checks.** The keys come from the log, which only the triggers write. They cannot be
  wrong today, but a key that is not three uuids would turn into a Postgres cast error and fail every pull of that
  workspace for 30 days. Skipping it costs one `safeParse` per key.
- **`NO_BATCH`.** A stock row without a batch has `batch_id` `NULL`. In a row comparison, `NULL` makes the whole
  comparison `NULL` (not true), so a full pull would never get past such a row: page after page would start at it.
  `coalesce(batch_id, nil uuid)` sorts it first among the variant's rows, on both sides of the `>`.
- **The rows are typed by the contract.** `change` is a `SyncUpsert`, so `{ entity: 'unit', data: toUnit(row) }`
  only compiles because `toUnit()` returns a `Unit`; a loader that sent a product's data under `entity: 'stock'`
  would not compile. `LOADERS` has an explicit type (`Record<SyncEntity, Loader>`): an entity added to the contract
  without a loader is a compile error here. (With `satisfies` instead, the inferred type would name the database
  package's internal paths, which TypeScript refuses to write into a declaration: error TS2883.)
- **`settings`** has one row, keyed by the tenant's id. In page mode it is sent when the full pull starts at it
  (`after === null`). The company's name comes from `tenants`, like `SettingsService.read()`.
- **`unit`, `tax_rate`, `price_list`, `product_category`, `customer_group`** are sent archived or not: an active
  product may still use an archived unit, and an old customer may still point at an archived price list. The three
  without a reused mapper build the contract's shape with an explicit type (`SyncCategory` and the others), so a
  field the contract gains later is a compile error here, not a silent gap.
- **`warehouse`** is the device's branch's, active. A warehouse moved to another branch or archived is no longer
  found, so a delta pull sends it as a delete.
- **`product`** is active only, through `productsOf()`. Its variants come archived too: an order line from last week
  may name a variant archived since, and the device must still show its name.
- **`price_list_item`** is raw SQL: two joins (the product and the list must both be active, decision 27), and a row
  comparison on the primary key's columns. `price_list_items_pkey` (tenant, list, variant, unit) serves the page
  order and the `IN` list of keys alike. The key is built with the contract's `priceListItemKey()`, so the pull, the
  device and the triggers can never write it two ways.
- **`customer`** is a customer, active, through `customersOf()`. A customer that is now only a supplier is no longer
  found: the device gets a delete (decision 16).
- **`stock`** is raw SQL too. `if (scope.warehouseIds.length === 0) return []`: a branch without an active warehouse
  keeps no stock, and `IN ()` would be a syntax error. The batch's lot number and dates come from a `LEFT JOIN` on
  `batches` (decision 23). `quantity <> 0`: a row at zero is not kept, so a sale that empties a shelf sends a delete.
  In keys mode the batch is compared with `IS NOT DISTINCT FROM`, because `'-'` in the key means `NULL`, and
  `batch_id = NULL` is never true. The key is built with `stockKey()`.

### `sync/devices.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Device, RegisterDeviceInput } from '@omnivo/contracts';
import { branches, devices } from '@omnivo/db';
import { and, eq, isNull } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

export type DeviceRow = typeof devices.$inferSelect;

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    branchId: row.branchId,
    userId: row.userId,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

// Another person's device, an unknown id and (through RLS) another workspace's device all answer
// the same: nobody learns that an id exists somewhere else. The app registers the browser again.
function deviceNotFound(): AppError {
  return new AppError(404, 'device_not_found', 'This device is not registered. Register it again.');
}

@Injectable()
export class DevicesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // Decision 20: the browser makes the id, so registering is safe to repeat. The same id by the
  // same person returns the device as it is, even when the name or the branch sent differ (a
  // retry of a lost answer sends the same ones; changing them is step 18c's rename and move).
  register(input: RegisterDeviceInput): Promise<Device> {
    return this.withTenant(async (tx) => {
      const known = await this.ownedOrNone(tx, input.id);
      if (known) return toDevice(known);

      const branch = await this.activeBranchCode(tx, input.branchId);
      const userId = currentPrincipal().userId;
      const [row] = await tx
        .insert(devices)
        .values({
          id: input.id,
          tenantId: getTenantId(),
          userId,
          name: input.name,
          branchId: input.branchId,
          createdBy: userId,
        })
        // Two registrations of the same id at once (the app retried while the first was still
        // running): the second waits for the first to commit, inserts nothing, and reads the row
        // below. Also an id taken in another workspace: the primary key is global, RLS is not.
        .onConflictDoNothing({ target: devices.id })
        .returning();
      if (!row) {
        const raced = await this.ownedOrNone(tx, input.id);
        if (raced) return toDevice(raced);
        throw new AppError(409, 'device_id_invalid', 'Make a new id for this device.');
      }
      await audit(tx, {
        action: 'device.registered',
        entityType: 'device',
        entityId: row.id,
        changes: created({ name: row.name, branch }),
      });
      return toDevice(row);
    });
  }

  // The pull's check, inside its transaction: the device is this person's, and not revoked
  async forPull(tx: Transaction, id: string): Promise<DeviceRow> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
    if (row?.userId !== currentPrincipal().userId) throw deviceNotFound();
    if (row.revokedAt !== null) {
      throw new AppError(403, 'device_revoked', 'This device was revoked. Its data is wiped.');
    }
    return row;
  }

  // An active branch of this workspace, by its code for the audit log. FOR SHARE: nobody archives
  // it before we commit.
  private async activeBranchCode(tx: Transaction, id: string): Promise<string> {
    const [branch] = await tx
      .select({ code: branches.code })
      .from(branches)
      .where(
        and(eq(branches.tenantId, getTenantId()), eq(branches.id, id), isNull(branches.archivedAt)),
      )
      .for('share');
    if (!branch) {
      throw new AppError(409, 'device_branch_invalid', 'Pick an active branch.', {
        fieldErrors: { branchId: ['device_branch_invalid'] },
      });
    }
    return branch.code;
  }

  // The device with this id, when it is the signed-in person's. Another person's id in this
  // workspace is device_id_invalid: their device keeps its id, and this browser makes a new one.
  private async ownedOrNone(tx: Transaction, id: string): Promise<DeviceRow | undefined> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
    if (!row) return undefined;
    if (row.userId !== currentPrincipal().userId) {
      throw new AppError(409, 'device_id_invalid', 'Make a new id for this device.');
    }
    return row;
  }
}
```

- **`register()` looks for the device first.** A retry after a lost answer is the common case (decision 20), and it
  must work even if the branch was archived since: the device exists, so it is returned as it is (decision 37).
- **`activeBranchCode()`** checks the branch like the warehouse form does: active, this workspace's, `FOR SHARE` so
  nobody archives it before the insert commits. It returns the branch's code because the audit log shows what a
  person recognises ("DHK"), never an id.
- **`onConflictDoNothing({ target: devices.id })`** handles two registrations of the same id at the same moment. The
  second insert waits for the first to commit, then inserts nothing, and the `SELECT` after it (a new statement, so a
  new snapshot in READ COMMITTED) finds the row. Without it, the second request would be a 500 on the primary key.
- **The same `onConflictDoNothing` meets an id used in another workspace.** The primary key is global, but RLS hides
  the row from the `SELECT`. So the answer is `device_id_invalid` (409), and the app makes a new id. Nobody learns
  whether the id exists somewhere else.
- **`ownedOrNone()`** answers `device_id_invalid` for another person's device in this workspace. Two people on one
  shop computer each get their own device and their own local database; the second must never take over the first
  one's id.
- **`forPull()` gives the same 404 for an unknown id and for another person's device** (`device_not_found`). The app
  then registers again. `row?.userId !== …` covers both: when `row` is `undefined`, the comparison is true.
- **`device_revoked` is a 403** (decision 38): the request is understood, but this device may not have the data any
  more. 18c's app wipes the local database on it.

### `sync/sync.service.ts` (new): the pull

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  SYNC_ENTITIES,
  SYNC_PROTOCOL,
  type SyncChange,
  type SyncEntity,
  type SyncPull,
  type syncPullQuerySchema,
} from '@omnivo/contracts';
import { syncChanges, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { DevicesService } from './devices.service.js';
import {
  type DeltaCursor,
  decodeSyncCursor,
  encodeSyncCursor,
  type FullCursor,
  type SyncCursor,
} from './sync-cursor.js';
import { SYNC_LOG_DAYS } from './sync-log-cleanup.js';
import { LOADERS, type SyncScope } from './sync-rows.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// A cursor older than this gets a full pull (decision 26): one day less than the log keeps
const CURSOR_MAX_AGE_MS = (SYNC_LOG_DAYS - 1) * DAY_MS;

// The database's view of "now", read in one statement:
//   xmin  the oldest transaction still running (pg_snapshot_xmin). Every transaction below it has
//         ended, so its lines are all in the log and will never change. The watermark (decision 25).
//   now   the database's clock, as ISO text: the page's serverTime and the cursor's issuedAt
const clockSchema = z.object({ xmin: z.string(), now: z.iso.datetime() });

interface Page {
  changes: SyncChange[];
  cursor: SyncCursor;
  hasMore: boolean;
  // Part of a full pull (the contract's `full`): the device drops what it did not get by the end
  full: boolean;
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly devices: DevicesService,
  ) {}

  async pull(query: z.output<typeof syncPullQuerySchema>): Promise<SyncPull> {
    // First, before the device: an app built for another protocol must reload whatever else is
    // wrong (decision 18)
    if (query.protocol !== SYNC_PROTOCOL) {
      throw new AppError(409, 'sync_protocol_mismatch', 'Reload the app to sync again.');
    }
    const cursor = decodeSyncCursor(query.cursor);
    // One transaction per page, READ COMMITTED like every request. It writes nothing until the
    // last page's last_sync_at, so it has no transaction id of its own while it reads: it never
    // holds back its own watermark, or anyone else's.
    return this.withTenant(async (tx) => {
      const device = await this.devices.forPull(tx, query.deviceId);
      const clock = await readClock(tx);
      const scope = await this.scopeOf(tx, device.branchId);

      const page =
        cursor === undefined || this.restartsFull(cursor, device.branchId, clock.now)
          ? await fullPage(tx, scope, startFull(device.branchId, clock), query.limit)
          : cursor.kind === 'full'
            ? await fullPage(tx, scope, cursor, query.limit)
            : await deltaPage(tx, scope, cursor, clock, query.limit);

      // The device finished a pull: by the database's clock (decision 19), and without touching
      // version or updated_at (decision 32), so a raw statement: Drizzle's update() would set
      // updated_at through $onUpdate
      if (!page.hasMore) {
        await tx.execute(
          sql`UPDATE devices SET last_sync_at = now()
               WHERE tenant_id = ${getTenantId()}::uuid AND id = ${device.id}::uuid`,
        );
      }
      return {
        changes: page.changes,
        cursor: encodeSyncCursor(page.cursor),
        hasMore: page.hasMore,
        full: page.full,
        serverTime: clock.now,
      };
    });
  }

  // A full pull starts when the device has no cursor, and when its cursor no longer fits: made
  // for another protocol, for another branch (the device moved), or older than the log keeps.
  // Only a cursor between pulls is checked for age (`to` null): a pull in progress reads lines
  // its first page already found in the log.
  private restartsFull(cursor: SyncCursor, branchId: string, now: string): boolean {
    if (cursor.protocol !== SYNC_PROTOCOL || cursor.branchId !== branchId) return true;
    return (
      cursor.kind === 'delta' &&
      cursor.to === null &&
      Date.parse(now) - Date.parse(cursor.issuedAt) > CURSOR_MAX_AGE_MS
    );
  }

  // The device's branch's warehouses. The active ones are what it keeps; all of them, archived
  // too, filter the stock lines of the log (18a.2's facts): a stock row that reaches zero in a
  // warehouse archived right after must still reach the device as a delete.
  private async scopeOf(
    tx: Transaction,
    branchId: string,
  ): Promise<SyncScope & { allWarehouseIds: string[] }> {
    const tenantId = getTenantId();
    const rows = await tx
      .select({ id: warehouses.id, archivedAt: warehouses.archivedAt })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.branchId, branchId)));
    return {
      tenantId,
      branchId,
      warehouseIds: rows.filter((row) => row.archivedAt === null).map((row) => row.id),
      allWarehouseIds: rows.map((row) => row.id),
    };
  }
}

async function readClock(tx: Transaction): Promise<z.infer<typeof clockSchema>> {
  const [clock] = z.array(clockSchema).parse(
    await tx.execute(sql`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`),
  );
  if (!clock) throw new Error('The clock query returned no row');
  return clock;
}

function startFull(branchId: string, clock: z.infer<typeof clockSchema>): FullCursor {
  return {
    kind: 'full',
    protocol: SYNC_PROTOCOL,
    branchId,
    issuedAt: clock.now,
    watermark: clock.xmin,
    entity: 0,
    after: null,
  };
}

// One page of a full pull: entity after entity in SYNC_ENTITIES order, as many rows as fit. Each
// loader is asked for one row more than fits, so a page knows whether anything is left without
// counting. When the last entity is done, the cursor turns into a delta cursor from the
// watermark taken when the full pull started: the changes made while it ran come next.
async function fullPage(
  tx: Transaction,
  scope: SyncScope,
  cursor: FullCursor,
  limit: number,
): Promise<Page> {
  const changes: SyncChange[] = [];
  let remaining = limit;
  let { entity, after } = cursor;
  for (let name = SYNC_ENTITIES[entity]; name !== undefined; name = SYNC_ENTITIES[entity]) {
    const rows = await LOADERS[name](tx, scope, { by: 'page', after, limit: remaining + 1 });
    const taken = rows.slice(0, remaining);
    changes.push(...taken.map((row) => row.change));
    if (rows.length > remaining) {
      // More of this entity. With nothing taken (the page was already full), `after` stays.
      after = taken.at(-1)?.sort ?? after;
      return { changes, cursor: { ...cursor, entity, after }, hasMore: true, full: true };
    }
    remaining -= rows.length;
    entity += 1;
    after = null;
  }
  const next: DeltaCursor = {
    kind: 'delta',
    protocol: cursor.protocol,
    branchId: cursor.branchId,
    issuedAt: cursor.issuedAt,
    from: cursor.watermark,
    to: null,
    after: null,
  };
  return { changes, cursor: next, hasMore: false, full: true };
}

// One page of a delta pull: the log's lines between the cursor's watermarks, each key sent once
// in its current state, or as a delete when its row is gone or out of the device's scope.
async function deltaPage(
  tx: Transaction,
  scope: SyncScope & { allWarehouseIds: string[] },
  cursor: DeltaCursor,
  clock: z.infer<typeof clockSchema>,
  limit: number,
): Promise<Page> {
  // The first page of a pull fixes where it stops: the oldest transaction running now. xmin never
  // goes back, but a cursor is the client's: `to` is never below `from`.
  const to = cursor.to ?? (BigInt(clock.xmin) < BigInt(cursor.from) ? cursor.from : clock.xmin);
  const issuedAt = cursor.to === null ? clock.now : cursor.issuedAt;

  const conditions: (SQL | undefined)[] = [
    eq(syncChanges.tenantId, scope.tenantId),
    sql`${syncChanges.xid} >= ${cursor.from}::xid8`,
    sql`${syncChanges.xid} < ${to}::xid8`,
    cursor.after === null
      ? undefined
      : sql`(${syncChanges.xid}, ${syncChanges.id}) > (${cursor.after[0]}::xid8, ${cursor.after[1]}::bigint)`,
    // An entity a later protocol dropped stays in old lines; this server does not send it
    inArray(syncChanges.entity, [...SYNC_ENTITIES]),
    // The other branches' stock is skipped here, without reading it (decision 30)
    scope.allWarehouseIds.length === 0
      ? isNull(syncChanges.warehouseId)
      : or(
          isNull(syncChanges.warehouseId),
          inArray(syncChanges.warehouseId, scope.allWarehouseIds),
        ),
  ];
  // sync_changes_tenant_xid_idx serves the filter and the order. One line more than fits says
  // whether more are left.
  const lines = await tx
    .select({
      id: syncChanges.id,
      entity: syncChanges.entity,
      key: syncChanges.entityKey,
      xid: syncChanges.xid,
    })
    .from(syncChanges)
    .where(and(...conditions))
    .orderBy(asc(syncChanges.xid), asc(syncChanges.id))
    .limit(limit + 1);
  const served = lines.slice(0, limit);

  // A key is in the log once per statement that wrote it; the page sends it once (the contract)
  const keysOf = new Map<SyncEntity, Set<string>>();
  for (const line of served) {
    const keys = keysOf.get(line.entity) ?? new Set<string>();
    keys.add(line.key);
    keysOf.set(line.entity, keys);
  }
  // In SYNC_ENTITIES order, like a full pull: the lists a product points at come before it
  const changes: SyncChange[] = [];
  for (const entity of SYNC_ENTITIES) {
    const keys = keysOf.get(entity);
    if (!keys) continue;
    const rows = await LOADERS[entity](tx, scope, { by: 'keys', keys: [...keys] });
    for (const row of rows) {
      changes.push(row.change);
      keys.delete(row.change.key);
    }
    // What is left was named by the log but is not there to send: deleted, or out of scope
    for (const key of keys) changes.push({ op: 'delete', entity, key });
  }

  const last = served.at(-1);
  if (lines.length > limit && last !== undefined) {
    return {
      changes,
      cursor: { ...cursor, to, issuedAt, after: [last.xid, last.id] },
      hasMore: true,
      full: false,
    };
  }
  return {
    changes,
    cursor: { ...cursor, from: to, to: null, issuedAt, after: null },
    hasMore: false,
    full: false,
  };
}
```

- **`CURSOR_MAX_AGE_MS` is one day less than the log keeps.** A line's `created_at` is the start of its transaction.
  A transaction that ran for hours could have written its line before the cursor's watermark was taken, and the
  cleanup might delete it a little before the cursor's 30 days are over. One day of margin covers any real
  transaction.
- **The protocol is checked before anything else** (decision 38). An old app that also has a bad cursor must hear
  "reload", the one thing that fixes both.
- **One transaction per page,** through `withTenant()` like every service, so RLS limits everything to the workspace.
  It only reads until the last line, so it has no transaction id while it reads: Postgres gives a transaction an id
  at its first write. That matters, because a transaction with an id would hold back the watermark of everyone else
  until it ends.
- **`readClock()` reads the watermark and the clock in one statement.** `pg_snapshot_xmin(pg_current_snapshot())` is
  the oldest transaction still running; every transaction below it has ended. The lines and the rows are read in later
  statements, so with later snapshots, which see everything below that watermark. That order is the whole safety of
  the cursor (decision 25): read the watermark first, the data after.
- **`restartsFull()`** sends a device back to a full pull instead of answering with an error: the app does not have
  to know why. Only a cursor between pulls (`to === null`) is checked for age; a pull in progress reads lines its
  first page already saw in the log, so their age does not matter.
- **The device's `last_sync_at` is written with a raw `UPDATE`.** `tx.update(devices)` would add `updated_at`
  through Drizzle's `$onUpdate`; decision 32 says the pull writes `last_sync_at` alone. It is the only write of the
  pull, and the last statement, so the transaction gets its id only at the very end.
- **`scopeOf()` reads all the branch's warehouses once,** and splits them: the active ones are what the device keeps;
  all of them filter the stock lines (18a.2's facts), because a stock row that reaches zero in a warehouse archived
  right after must still reach the device as a delete.
- **`fullPage()` asks each loader for one row more than fits.** More rows than room means this entity continues on
  the next page, so the cursor keeps the entity and the last row's key columns. Fewer means the entity is done, and
  the loop moves on to the next one with the room that is left. When the page is already full at the start of an
  entity (`remaining` 0), the loader is asked for one row: if there is one, the page ends and the next page starts at
  that entity; if not, the loop goes on, so empty entities never cost a page.
- **`after = taken.at(-1)?.sort ?? after`:** when nothing of this entity fitted, the next page starts where this one
  would have (`after` as it was), not at the entity's first row again.
- **The full pull's last cursor is a delta cursor from the full pull's own watermark** (decision 36). The changes made
  while the full pull ran come with the next pull.
- **`deltaPage()` fixes `to` on the first page of a pull** and keeps it (decision 34). `BigInt` compares the two xids:
  the watermark only grows, but the cursor is the client's, and `to` below `from` would read nothing for ever.
  `issuedAt` is set to the time `to` was taken, so the final cursor's age is the age of its watermark.
- **The lines' query.** `xid >= from AND xid < to`: the transactions that ended between the two watermarks.
  `(xid, id) > after`: the rest of this pull, in the index's order. `inArray(entity, SYNC_ENTITIES)`: an entity a
  later protocol dropped stays in old lines (18a.2), and this server does not know how to send it. The stock filter
  reads only this branch's stock lines (decision 30); `warehouse_id IS NULL` keeps every other entity's lines.
- **`limit + 1` lines,** and one more than fits means `hasMore` (decision 35).
- **`keysOf` is a `Map` of `Set`s:** a key written by ten statements is ten lines and one row to read. A key may
  still come again on a later page of the same pull; the device's put is an upsert, so that costs nothing.
- **The rows are read entity by entity in `SYNC_ENTITIES` order,** like a full pull, so a page never puts a product
  on the device before a new unit it uses.
- **What a loader did not return is a delete.** The row is gone, or it left the data set. The device does not need
  to know which (decision 16).
- **The last cursor of a pull starts the next one at `to`** with `to: null`. The next pull's first page takes a new
  `to`.

### Controller, module and wiring

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DevicesService } from './devices.service.js';
import { SyncService } from './sync.service.js';

type Routes = typeof routes.sync;

// No permission on either route (decision 21): every member may work offline, and a pull sends
// only what every member may read anyway
@Controller()
export class SyncController {
  constructor(
    private readonly devices: DevicesService,
    private readonly sync: SyncService,
  ) {}

  @Endpoint(routes.sync.registerDevice)
  registerDevice({
    body,
  }: RouteInput<Routes['registerDevice']>): Promise<RouteResponse<Routes['registerDevice']>> {
    return this.devices.register(body);
  }

  @Endpoint(routes.sync.pull)
  pull({ query }: RouteInput<Routes['pull']>): Promise<RouteResponse<Routes['pull']>> {
    return this.sync.pull(query);
  }
}
```

No `permission` in the two routes (decision 21), so every member may call them. `AuthGuard` still needs a signed-in
person, and `PermissionGuard` still checks the membership on every request, permission or not (`access_revoked`), so a
member removed from the workspace stops syncing with the next pull, not when the token runs out.

```ts
import { Module } from '@nestjs/common';

import { DevicesService } from './devices.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

// Step 18a: the read half of the sync engine (devices and the pull). SyncLogCleanup is not here:
// it is the worker's (WorkerModule), on the worker's database role.
@Module({
  controllers: [SyncController],
  providers: [DevicesService, SyncService],
})
export class SyncModule {}
```

```diff
@@ -37,6 +37,7 @@ import { RolesModule } from './roles/roles.module.js';
 import { SalesModule } from './sales/sales.module.js';
 import { SettingsModule } from './settings/settings.module.js';
 import { SetupModule } from './setup/setup.module.js';
+import { SyncModule } from './sync/sync.module.js';
 import { TaxModule } from './tax/tax.module.js';
 
 @Module({})
@@ -69,6 +70,7 @@ export class AppModule implements NestModule {
         SalesModule,
         DocumentsModule,
         PurchaseModule,
+        SyncModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

### The worker's cleanup

```ts
import { Inject, Injectable } from '@nestjs/common';
import { type Db, syncChanges } from '@omnivo/db';
import { lt, sql } from 'drizzle-orm';

import { RELAY_DB } from '../infra/tokens.js';

// How long the change log keeps a line (decision 26). The pull gives a cursor older than one day
// less than this a full pull instead (SyncService): its lines may already be gone, and one day
// covers a transaction that ran long and wrote its line before the cursor's watermark was taken.
export const SYNC_LOG_DAYS = 30;

// The worker's half of the change log: the hourly job deletes the lines older than SYNC_LOG_DAYS
// of every tenant in one statement. It runs as omnivo_worker (RELAY_DB, migration 0044's
// sync_prune policy), like the outbox's cleanup: the API's role may not delete a line at all.
// Provided by WorkerModule only; the HTTP process never has it.
@Injectable()
export class SyncLogCleanup {
  constructor(@Inject(RELAY_DB) private readonly db: Db) {}

  // sync_changes_created_idx finds the old lines. An hour's worth each time, so one statement
  // is small enough; no batching.
  async deleteOld(): Promise<number> {
    const result = await this.db
      .delete(syncChanges)
      .where(lt(syncChanges.createdAt, sql`now() - make_interval(days => ${SYNC_LOG_DAYS})`));
    // postgres-js gives the number of rows deleted; RETURNING them would bring every id back
    return result.count;
  }
}
```

- **`SYNC_LOG_DAYS` lives here** and the pull imports it, so the cleanup and the cursor's age rule can never use two
  numbers. The file is in `sync/`, not in `worker/`: the `api-not-to-worker` rule forbids the API's code to import
  `worker/`, and the pull needs the constant.
- **It runs on `RELAY_DB`,** the worker's `omnivo_worker` pool, which 0044's `sync_prune` policy lets delete the lines
  of every tenant. The API's own role cannot delete a line at all (0044, section 2).
- **`result.count`, not `.returning()`.** The outbox's cleanup returns the ids it deleted; for the log that could be a
  hundred thousand ids an hour on a busy server, only to count them. postgres-js reports the count without them.
- **One statement, no batches.** It runs every hour, so it deletes about one hour of lines from 30 days ago, and
  `sync_changes_created_idx` finds them.

```diff
@@ -21,6 +21,7 @@ import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorageService } from '../storage/storage.service.js';
+import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { JobRunner } from './job-runner.js';
 import { OutboxRelay } from './outbox-relay.js';
@@ -71,6 +72,8 @@ export class WorkerModule implements OnApplicationShutdown {
         DocumentFileMaker,
         DocumentFileHandler,
         DocumentEmailHandler,
+        // Step 18a: the hourly job also prunes the sync change log, on the relay's pool
+        SyncLogCleanup,
       ],
     };
   }
```

```diff
@@ -17,6 +17,7 @@ import { runWithRequest } from '../common/request/request-context.js';
 import { runWithTenant } from '../common/tenant/tenant-context.js';
 import type { WorkerConfig } from '../config.js';
 import { CONFIG } from '../infra/tokens.js';
+import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { OutboxRelay } from './outbox-relay.js';
 import {
@@ -43,6 +44,7 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
     private readonly handlers: EventHandlers,
     private readonly queues: Queues,
     private readonly relay: OutboxRelay,
+    private readonly syncLog: SyncLogCleanup,
   ) {}
 
   async onApplicationBootstrap(): Promise<void> {
@@ -70,6 +72,9 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
     if (job.name === OUTBOX_CLEANUP) {
       const deleted = await this.relay.deletePublished();
       this.logger.log(`outbox cleanup: ${String(deleted)} old rows deleted`);
+      // Step 18a: the same hour, the sync change log's lines older than 30 days
+      const pruned = await this.syncLog.deleteOld();
+      this.logger.log(`sync log cleanup: ${String(pruned)} old lines deleted`);
       return;
     }
     // A job we cannot read will never become readable: no retries
```

The log is pruned in the outbox's hourly job, not in a scheduler of its own: one schedule to keep alive, and both are
"delete what is older than N days". The two deletes run one after the other. If the outbox's delete fails, the job
fails before the log's, and both wait for the next hour: nothing breaks if the log keeps a few lines for an hour more.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api lint
pnpm --filter @omnivo/api test
```

`test` runs the API's unit tests, including `contract.spec.ts`: it fails while a route of the contract has no
handler, so it shows that the three new routes are served. The integration tests for the pull come in 18a.4.

To try a pull by hand, start the API (`pnpm dev`), sign in, and copy the access token from the browser's dev tools.
Then:

```bash
TOKEN=…   # the access token
BRANCH=…  # an id from GET /branches
DEVICE=$(node -e "const u=crypto.randomUUID(); console.log(u.slice(0,14)+'7'+u.slice(15))")
curl -s -X POST localhost:3000/sync/devices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$DEVICE\",\"name\":\"Chrome on Windows\",\"branchId\":\"$BRANCH\"}"
curl -s "localhost:3000/sync/pull?deviceId=$DEVICE&protocol=1&limit=5" -H "Authorization: Bearer $TOKEN"
```

The first answer is the device. The second is the first page of a full pull: the settings and the first units, with
`"full": true` and `"hasMore": true`. Send its `cursor` back (`&cursor=…`) until `hasMore` is false. Then change a
price on a price list's page and pull once more with the last cursor: the answer holds that one price.

## 18a.4 — `apps/api`: the tests

This part adds two test files in `apps/api/src/sync/` and one test to the customers' tests. Like every integration
test since step 5, they run against a real Postgres and the real worker:

- `sync.int.spec.ts` follows a distributor's counter in Narsingdi through its pulls: registering the browser, the
  first full pull in pages of every size, then each kind of change in a delta (a price, a list or a product
  archived and restored, customers coming and going, stock moving in two branches), a pull that runs while people
  keep working, the cursor's age and the device moving branch, the watermark against a slow transaction, and the
  worker's cleanup of the log.
- `sync.tenant-leak.int.spec.ts`: a device of workspace A never receives a row of workspace B, never uses B's device
  and never learns B's customers' balances; and in the database, the API's role never reads or writes B's change
  log or devices.
- `customers.int.spec.ts` gets one test for `GET /customer-balances`.

**They found no bug in the 18a.3 code.** Three "break it on purpose" checks made sure the tests would have noticed
the bugs that matter most here:

- Taking the newest transaction id (`pg_snapshot_xmax`) as the watermark instead of the oldest one still running
  (`pg_snapshot_xmin`) fails the watermark test: the quick save is pulled, and the slow one's change is lost.
- Asking a loader for exactly the rows that fit, not one more, fails the paging test: a page that ends exactly at
  the last row it asked for thinks the entity is done, and the next rows of that entity are never sent.
- Taking a new `to` on every page of a delta pull (not once, on its first page) fails the "pull in progress" test:
  a change made while the pull runs ends up in it, so in a busy workspace a pull may never end.

### `sync/sync.int.spec.ts` (new): the setup

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Branch,
  branchSchema,
  type Customer,
  type CustomerFormValues,
  customerSchema,
  type Device,
  deviceSchema,
  type PriceList,
  priceListSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  settingsSchema,
  setupSchema,
  supplierSchema,
  SYNC_ENTITIES,
  type SyncChange,
  type SyncEntity,
  syncPullSchema,
  type Unit,
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
import { SyncLogCleanup } from './sync-log-cleanup.js';

// One distributor with two depots: Narsingdi (the main branch) and Chattogram. The tests follow
// a counter in Narsingdi that pulls its data: everything once, then only what changed.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser, for what the API cannot do yet: stock without the books, a revoked device
// (step 18c), a cursor's age
let sql: postgres.Sql;
let tenantId: string;
let owner: SignedIn;
// Rafiq, a salesperson with no role: syncing needs no permission
let rafiq: SignedIn;
let units: Unit[];
let narsingdi: Branch;
let chattogram: Branch;
let depot: Warehouse;
let oldStore: Warehouse;
let ctgDepot: Warehouse;
let juice: Product;
let soap: Product;
let cleaner: Product;
let dealer: PriceList;
let retail: PriceList;
let karim: Customer;
let rahim: Customer;
let soapBatch: string;
// The counter in Narsingdi
let counter: Device;

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

function variantId(product: Product, index = 0): string {
  const found = product.variants[index];
  if (!found) throw new Error(`${product.name} has no variant ${String(index)}`);
  return found.id;
}

function variant(optionValues: string[] = [], salePrice = '') {
  return { id: null, sku: '', optionValues, barcode: '', salePrice, archived: false };
}

function productForm(name: string, extra: Partial<ProductFormValues> = {}): ProductFormValues {
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
    taxRateId: '',
    options: [],
    variants: [variant()],
    units: [],
    customFields: {},
    ...extra,
  };
}

function customerForm(name: string, extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'bn',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  };
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  return created(productSchema, '/products', productForm(name, extra));
}

async function addWarehouse(branch: Branch, code: string, name: string) {
  return created(warehouseSchema, '/warehouses', { branchId: branch.id, code, name, address: '' });
}

// One PUT of a price list's page: one statement, one line per key in the log
async function setPrices(list: PriceList, prices: [string, string, string][]) {
  const res = await send('PUT', `/price-lists/${list.id}/items`, {
    changes: prices.map(([variant, unit, price]) => ({ variantId: variant, unitId: unit, price })),
  });
  expect(res.statusCode, res.body).toBe(200);
}

// The archive and restore routes of products, price lists, customers and branches take the
// version and answer the row with its new version
async function flip<T extends { version: number }>(
  schema: z.ZodType<T>,
  path: string,
  row: T,
  action: 'archive' | 'restore',
): Promise<T> {
  const res = await send('POST', `${path}/${action}`, { version: row.version });
  expect(res.statusCode, res.body).toBe(200);
  return schema.parse(res.json());
}

// Stock straight into stock_balances, as the superuser. Step 13's adjustments would need the
// books set up for every test, and the change log's trigger sees the row whoever writes it.
async function putStock(
  warehouse: Warehouse,
  product: Product,
  variant: string,
  quantity: string,
  batchId: string | null = null,
) {
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, batch_id, quantity)
    VALUES (${tenantId}, ${warehouse.id}, ${product.id}, ${variant}, ${batchId}, ${quantity})
    ON CONFLICT ON CONSTRAINT stock_balances_key DO UPDATE SET quantity = EXCLUDED.quantity`;
}

async function renameCompany(companyName: string) {
  const settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const res = await send('PUT', '/settings', {
    version: settings.version,
    companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
    pricesIncludeVat: settings.pricesIncludeVat,
    overReceiptPercent: settings.overReceiptPercent,
  });
  expect(res.statusCode, res.body).toBe(200);
}

function register(input: { id: string; name: string; branchId: string }, as = owner) {
  return send('POST', '/sync/devices', input, as);
}

async function newDevice(name: string, branch: Branch, as = owner): Promise<Device> {
  const res = await register({ id: v7(), name, branchId: branch.id }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

function pullPage(deviceId: string, cursor: string | undefined, limit: number, as = owner) {
  const query = new URLSearchParams({ deviceId, protocol: '1', limit: String(limit) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return send('GET', `/sync/pull?${query.toString()}`, undefined, as);
}

// A whole pull, page after page, as the device runs it: until hasMore is false
async function pullAll(device: Device, cursor: string | undefined, limit = 500) {
  const pages = [];
  let next = cursor;
  for (let page = 0; page < 500; page += 1) {
    const res = await pullPage(device.id, next, limit);
    expect(res.statusCode, res.body).toBe(200);
    const body = syncPullSchema.parse(res.json());
    pages.push(body);
    next = body.cursor;
    if (!body.hasMore) {
      return { pages, cursor: body.cursor, changes: pages.flatMap((p) => p.changes) };
    }
  }
  throw new Error('The pull did not end in 500 pages');
}

function keysOf(changes: SyncChange[], entity: SyncEntity, op: SyncChange['op'] = 'upsert') {
  return changes
    .filter((change) => change.entity === entity && change.op === op)
    .map((change) => change.key)
    .sort();
}

function priceKey(list: PriceList, variant: string, unit: string): string {
  return `${list.id}:${variant}:${unit}`;
}

function stockKey(warehouse: Warehouse, variant: string, batchId: string | null = null): string {
  return `${warehouse.id}:${variant}:${batchId ?? '-'}`;
}

// The cursor is opaque to the device, but a test may age it or edit it like a broken client.
// It is base64url JSON of a one-value list (sync-cursor.ts).
const cursorJsonSchema = z.tuple([z.record(z.string(), z.unknown())]);
function editCursor(cursor: string, patch: Record<string, unknown>): string {
  const [value] = cursorJsonSchema.parse(
    JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
  );
  return Buffer.from(JSON.stringify([{ ...value, ...patch }])).toString('base64url');
}

const deviceRowSchema = z.object({
  last_sync_at: z.date().nullable(),
  version: z.number(),
  created_at: z.date(),
  updated_at: z.date(),
});
async function deviceRow(id: string) {
  const [row] = z
    .array(deviceRowSchema)
    .parse(
      await sql`SELECT last_sync_at, version, created_at, updated_at FROM devices WHERE id = ${id}`,
    );
  if (!row) throw new Error(`no device ${id}`);
  return row;
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
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  const [tenant] = z
    .array(z.object({ id: z.uuid() }))
    .parse(await sql`SELECT id FROM tenants WHERE slug = 'meghna-distributors'`);
  if (!tenant) throw new Error('no tenant');
  tenantId = tenant.id;

  await signUp(app, {
    companyName: 'Rafiq Traders',
    workspaceSlug: 'rafiq-traders',
    fullName: 'Rafiq Islam',
    email: 'rafiq@meghnadistributors.com',
    password: 'Bhairab-route-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rafiq@meghnadistributors.com',
    workspace: 'meghna-distributors',
  });
  rafiq = await logIn(app, {
    workspace: 'meghna-distributors',
    email: 'rafiq@meghnadistributors.com',
    password: 'Bhairab-route-2026',
    keepSignedIn: false,
  });

  // The branches: sign-up made the head office (Narsingdi)
  const [head] = z
    .object({ items: z.array(branchSchema) })
    .parse((await send('GET', '/branches')).json()).items;
  if (!head) throw new Error('no branch');
  narsingdi = head;
  chattogram = await created(branchSchema, '/branches', {
    code: 'CTG',
    name: 'Chattogram depot',
    phone: '',
    address: 'Agrabad, Chattogram',
  });

  // Narsingdi keeps the store sign-up made and an old store it no longer uses; Chattogram has its
  // own depot
  const [main] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!main) throw new Error('no MAIN warehouse');
  depot = main;
  oldStore = await addWarehouse(narsingdi, 'NRS2', 'Old store');
  oldStore = await flip(warehouseSchema, `/warehouses/${oldStore.id}`, oldStore, 'archive');
  ctgDepot = await addWarehouse(chattogram, 'CTG1', 'Chattogram depot');

  // Products: juice sold by the piece and the case of 24, soap in two scents with batches, and
  // a glass cleaner no longer sold
  juice = await addProduct('Mango juice 250 ml', {
    variants: [variant([], '25')],
    units: [{ unitId: unitId('case'), factor: '24', barcode: '8901234567890' }],
  });
  soap = await addProduct('Beauty soap 100 g', {
    tracking: 'batch',
    hasExpiry: true,
    options: [{ name: 'Scent', values: ['Lemon', 'Rose'] }],
    variants: [variant(['Lemon'], '45'), variant(['Rose'], '45')],
  });
  cleaner = await addProduct('Glass cleaner 500 ml', { variants: [variant([], '120')] });

  // Prices: Dealer is used; Retail was archived, with its prices
  dealer = await created(priceListSchema, '/price-lists', { name: 'Dealer', description: '' });
  retail = await created(priceListSchema, '/price-lists', { name: 'Retail', description: '' });
  await setPrices(dealer, [
    [variantId(juice), unitId('pcs'), '22'],
    [variantId(juice), unitId('case'), '500'],
    [variantId(soap), unitId('pcs'), '40'],
    [variantId(cleaner), unitId('pcs'), '110'],
  ]);
  await setPrices(retail, [[variantId(juice), unitId('pcs'), '25']]);
  retail = await flip(priceListSchema, `/price-lists/${retail.id}`, retail, 'archive');
  cleaner = await flip(productSchema, `/products/${cleaner.id}`, cleaner, 'archive');

  // Customers: two shops; a packaging supplier that is not a customer; a shop that closed
  karim = await created(
    customerSchema,
    '/customers',
    customerForm('Karim Store', { priceListId: dealer.id }),
  );
  rahim = await created(customerSchema, '/customers', customerForm('Rahim Traders'));
  await created(supplierSchema, '/suppliers', {
    code: '',
    name: 'Padma Packaging',
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
  const closed = await created(customerSchema, '/customers', customerForm('Shapla Store'));
  await flip(customerSchema, `/customers/${closed.id}`, closed, 'archive');

  // Stock: juice and a batch of lemon soap in Narsingdi, nothing left of rose, cleaner that is
  // still on a shelf, and Chattogram's own juice
  const [batch] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`
      INSERT INTO batches (id, tenant_id, product_id, variant_id, lot_number, expires_on)
      VALUES (gen_random_uuid(), ${tenantId}, ${soap.id}, ${variantId(soap)}, 'NP24117', '2027-06-30')
      RETURNING id`,
  );
  if (!batch) throw new Error('no batch');
  soapBatch = batch.id;
  await putStock(depot, juice, variantId(juice), '120');
  await putStock(depot, soap, variantId(soap), '72', soapBatch);
  await putStock(depot, soap, variantId(soap, 1), '0');
  await putStock(depot, cleaner, variantId(cleaner), '6');
  await putStock(ctgDepot, juice, variantId(juice), '480');

  counter = await newDevice('Counter 1', narsingdi);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **One workspace, one story** (Meghna Distributors). The tests in `a delta pull` share one cursor, like a real
  device: each test pulls what the one before it changed. When a test fails, read the first failure first.
- **Two branches.** Narsingdi is the head office that sign-up made, with its `MAIN` store and an old store that is
  archived; Chattogram has its own depot. A device keeps one branch's warehouses and stock (decision 9), so the
  second branch is what proves that the other stock is left out.
- **Rafiq has no role at all.** Syncing needs no permission (decision 21), so he can register and pull. He is also
  the "other person" of the device rules: a device belongs to one person.
- **Every product, list and customer is there for one rule:** juice with a case of 24 (a pack's price is its own
  price list item), soap in two scents with a batch (a stock key with a batch, and a zero row for the other scent),
  a glass cleaner that is archived but still has stock and a price (the scope must leave both out), a Retail list
  that is archived (its prices stay off the device, the list itself does not), a supplier that is not a customer,
  and a closed shop.
- **`putStock()` writes `stock_balances` straight in, as the superuser.** Step 13's adjustments would need the books
  set up for every test, and the change log's trigger sees the row whoever writes it. This is also why `sql` is the
  superuser: it does what the API cannot do yet, like revoking or moving a device (step 18c) and aging a cursor.
- **`flip()` archives or restores** anything with the same route shape (products, price lists, customers, branches,
  warehouses), and returns the row with its new version for the next call.
- **`pullAll()` runs a pull the way the device will:** page after page until `hasMore` is false. It stops after 500
  pages, so a pull that never ends fails the test instead of hanging it.
- **`editCursor()` opens the cursor.** The device treats it as opaque, but a test must be able to make it old, or
  broken like a bad client would. It parses the JSON with a Zod schema, so there is no cast.
- **`deviceRow()` reads `last_sync_at`, `version` and the timestamps** straight from the table: the API does not
  return `updated_at`, and the test checks that the pull does not touch it.

### Registering a device

```ts
describe('registering a device', () => {
  const auditCount = async (id: string) => {
    const [row] = z.array(z.object({ n: z.number() })).parse(
      await sql`SELECT count(*)::int AS n FROM audit_logs
                 WHERE entity_id = ${id} AND action = 'device.registered'`,
    );
    return row?.n;
  };

  it('returns the same device when the browser registers it again', async () => {
    const id = v7();
    const first = await register({ id, name: 'Chrome on Windows', branchId: narsingdi.id });
    expect(first.statusCode, first.body).toBe(201);
    expect(deviceSchema.parse(first.json())).toMatchObject({
      id,
      name: 'Chrome on Windows',
      branchId: narsingdi.id,
      lastSyncAt: null,
      revokedAt: null,
      version: 1,
    });

    // A retry may send another name or branch: the device stays as it was (18c renames and moves)
    const again = await register({ id, name: 'Counter 2', branchId: chattogram.id });
    expect(again.statusCode).toBe(201);
    expect(deviceSchema.parse(again.json())).toEqual(deviceSchema.parse(first.json()));
    expect(await auditCount(id)).toBe(1);
  });

  it('registers once when two requests for the same id arrive together', async () => {
    const id = v7();
    const input = { id, name: 'Chrome on Android', branchId: narsingdi.id };
    const [one, two] = await Promise.all([register(input), register(input)]);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(deviceSchema.parse(one.json())).toEqual(deviceSchema.parse(two.json()));
    expect(await auditCount(id)).toBe(1);
  });

  it('refuses an id that is not a UUIDv7, a short name, and a branch that is not active', async () => {
    const v4 = await register({
      id: randomUUID(),
      name: 'Chrome on Windows',
      branchId: narsingdi.id,
    });
    expect(v4.statusCode).toBe(400);
    expect(problemOf(v4).fieldErrors).toEqual({ id: ['device_id_invalid'] });

    const short = await register({ id: v7(), name: ' X ', branchId: '' });
    expect(short.statusCode).toBe(400);
    expect(problemOf(short).fieldErrors).toEqual({
      name: ['device_name_required'],
      branchId: ['device_branch_invalid'],
    });

    const unknown = await register({ id: v7(), name: 'Chrome on Windows', branchId: v7() });
    expect(unknown.statusCode).toBe(409);
    expect(problemOf(unknown)).toMatchObject({
      code: 'device_branch_invalid',
      fieldErrors: { branchId: ['device_branch_invalid'] },
    });

    const bogura = await created(branchSchema, '/branches', {
      code: 'BOG',
      name: 'Bogura depot',
      phone: '',
      address: '',
    });
    await flip(branchSchema, `/branches/${bogura.id}`, bogura, 'archive');
    const archived = await register({ id: v7(), name: 'Chrome on Windows', branchId: bogura.id });
    expect(problemOf(archived).code).toBe('device_branch_invalid');
  });

  it("keeps a person's device their own", async () => {
    // Rafiq signs in on the counter's browser: the counter's id is not his to use
    const taken = await register(
      { id: counter.id, name: 'Chrome on Windows', branchId: narsingdi.id },
      rafiq,
    );
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).code).toBe('device_id_invalid');
    const pulled = await pullPage(counter.id, undefined, 10, rafiq);
    expect(pulled.statusCode).toBe(404);
    expect(problemOf(pulled).code).toBe('device_not_found');

    // His own device works, with no role at all
    const his = await newDevice('Rafiq on Android', narsingdi, rafiq);
    expect((await pullPage(his.id, undefined, 10, rafiq)).statusCode).toBe(200);
    const unknown = await pullPage(v7(), undefined, 10);
    expect(problemOf(unknown).code).toBe('device_not_found');
  });

  it('stops a revoked device, and checks the protocol before the device', async () => {
    const lost = await newDevice('Lost phone', narsingdi);
    // Step 18c revokes from the device list; until then, the superuser
    await sql`UPDATE devices SET revoked_at = now() WHERE id = ${lost.id}`;
    const pulled = await pullPage(lost.id, undefined, 10);
    expect(pulled.statusCode).toBe(403);
    expect(problemOf(pulled).code).toBe('device_revoked');
    // Registering it again does not bring it back: the app sees revokedAt and wipes its data
    const again = await register({ id: lost.id, name: 'Lost phone', branchId: narsingdi.id });
    expect(deviceSchema.parse(again.json()).revokedAt).not.toBeNull();

    const old = await send('GET', `/sync/pull?deviceId=${lost.id}&protocol=2`);
    expect(old.statusCode).toBe(409);
    expect(problemOf(old).code).toBe('sync_protocol_mismatch');
  });
});
```

- **The same id twice is the same device,** even when the second request sends another name and branch. A retry
  after a lost answer must not make a second device (decision 20); renaming and moving are step 18c's. The audit log
  has one `device.registered`.
- **Two requests at once:** both answer 201 with the same device and there is one audit entry. The second insert
  waits for the first one's commit, inserts nothing (`onConflictDoNothing`) and reads the row.
- **The refusals:** an id that is not a UUIDv7 and a short name are the contract's (400, under their fields), and an
  empty branch select is the contract's too. An unknown branch and an archived one are the server's (409), still
  under `branchId`, so the dialog shows it under the select.
- **A device is one person's:** Rafiq may not register the counter's id (`device_id_invalid`: his browser makes a
  new one) nor pull with it (`device_not_found`, the same answer as an id that does not exist).
- **A revoked device** is refused with `device_revoked` (403). Registering it again returns it with `revokedAt` set,
  so the app knows to wipe its data instead of syncing.
- **The protocol is checked first:** an old app is told to reload, whatever else is wrong.

### A full pull

```ts
describe('a full pull', () => {
  it('sends every row the device keeps, and nothing else', async () => {
    const { pages, changes } = await pullAll(counter, undefined, 1000);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ full: true, hasMore: false });
    expect(changes.every((change) => change.op === 'upsert')).toBe(true);

    // Entity after entity, in the contract's order: what a row points at comes before it
    const order = changes.map((change) => SYNC_ENTITIES.indexOf(change.entity));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(changes.map((c) => `${c.entity}/${c.key}`)).size).toBe(changes.length);

    expect(keysOf(changes, 'settings')).toEqual([tenantId]);
    expect(changes.find((change) => change.entity === 'settings')).toMatchObject({
      data: { companyName: 'Meghna Distributors', allowNegativeStock: false },
    });
    expect(keysOf(changes, 'unit')).toHaveLength(units.length);
    // Only the active warehouses of the device's branch
    expect(keysOf(changes, 'warehouse')).toEqual([depot.id]);
    // Every price list, the archived one too: an old customer may still point at it
    expect(keysOf(changes, 'price_list')).toEqual([dealer.id, retail.id].sort());
    expect(keysOf(changes, 'product')).toEqual([juice.id, soap.id].sort());
    // Not the archived list's prices, nor the archived product's
    expect(keysOf(changes, 'price_list_item')).toEqual(
      [
        priceKey(dealer, variantId(juice), unitId('pcs')),
        priceKey(dealer, variantId(juice), unitId('case')),
        priceKey(dealer, variantId(soap), unitId('pcs')),
      ].sort(),
    );
    // The two shops: not the supplier, not the closed shop
    expect(keysOf(changes, 'customer')).toEqual([karim.id, rahim.id].sort());
    const karimRow = changes.find((change) => change.key === karim.id);
    expect(karimRow).toMatchObject({ data: { name: 'Karim Store', priceListId: dealer.id } });
    expect(karimRow?.op === 'upsert' && 'balance' in karimRow.data).toBe(false);
    // Narsingdi's stock: no zero row, no archived product, nothing from Chattogram
    expect(keysOf(changes, 'stock')).toEqual(
      [stockKey(depot, variantId(juice)), stockKey(depot, variantId(soap), soapBatch)].sort(),
    );
    expect(changes.find((change) => change.key.endsWith(soapBatch))).toMatchObject({
      data: { lotNumber: 'NP24117', expiresOn: '2027-06-30', quantity: '72.0000' },
    });
  });

  it('gives the same rows in pages of any size', async () => {
    const whole = (await pullAll(counter, undefined, 1000)).changes;
    // Limit 1 ends every page at the end of an entity at some point (nothing left for the next
    // one), the case of a page that is full before it starts a new entity
    for (const limit of [1, 2, 3, 5, 8]) {
      const { pages, changes } = await pullAll(counter, undefined, limit);
      expect(changes, `limit ${String(limit)}`).toEqual(whole);
      expect(pages.every((page) => page.full && page.changes.length <= limit)).toBe(true);
      expect(pages.slice(0, -1).every((page) => page.hasMore)).toBe(true);
    }
  });

  it('marks the device synced when the last page is served, without a new version', async () => {
    const tablet = await newDevice('Tablet', narsingdi);
    const first = syncPullSchema.parse((await pullPage(tablet.id, undefined, 2)).json());
    expect(first.hasMore).toBe(true);
    expect((await deviceRow(tablet.id)).last_sync_at).toBeNull();

    await pullAll(tablet, first.cursor);
    const row = await deviceRow(tablet.id);
    expect(row.last_sync_at).not.toBeNull();
    expect(row.version).toBe(1);
    expect(row.updated_at).toEqual(row.created_at);
  });
});
```

- **What a device keeps, and nothing else:** the settings once (keyed by the workspace), every unit, the branch's
  active warehouse, both price lists (an old customer may still point at the archived one), the two active
  products, the three prices of the Dealer list (not the archived list's, not the archived cleaner's), the two
  shops (not the supplier, not the closed shop, and no `balance` in the row), and Narsingdi's two stock rows (no
  zero row, no cleaner, nothing from Chattogram).
- **The order:** entity after entity in `SYNC_ENTITIES` order, so a product arrives after the units it uses, and
  every key once.
- **Pages of any size give the same rows in the same order.** The test pulls everything in one page, then again
  with limits 1, 2, 3, 5 and 8, and compares the lists. Limit 1 makes every page end at the end of an entity at
  some point: the case where a page is already full before the next entity starts, which the cursor must carry over
  without losing or repeating a row.
- **Synced only at the end:** `last_sync_at` stays empty after the first page and is set on the last one, with no
  new `version` and the same `updated_at` (decision 32). "Last synced" means a whole pull, not a page.

### A delta pull

```ts
describe('a delta pull', () => {
  let cursor: string;

  beforeAll(async () => {
    cursor = (await pullAll(counter, undefined)).cursor;
  });

  // The next pull from the cursor kept by the last one
  async function changesSince() {
    const pulled = await pullAll(counter, cursor);
    expect(pulled.pages.every((page) => !page.full)).toBe(true);
    cursor = pulled.cursor;
    return pulled.changes;
  }

  it('is empty when nothing changed', async () => {
    expect(await changesSince()).toEqual([]);
  });

  it('sends a changed price, and the prices of a list archived or restored', async () => {
    await setPrices(dealer, [[variantId(juice), unitId('pcs'), '23']]);
    expect(await changesSince()).toMatchObject([
      {
        op: 'upsert',
        key: priceKey(dealer, variantId(juice), unitId('pcs')),
        data: { price: '23.0000' },
      },
    ]);

    dealer = await flip(priceListSchema, `/price-lists/${dealer.id}`, dealer, 'archive');
    const archived = await changesSince();
    expect(keysOf(archived, 'price_list')).toEqual([dealer.id]);
    // The archived cleaner's price too: the log names every price of the list, and the device
    // gets a delete for a key it never had, which changes nothing there
    const cleanerPrice = priceKey(dealer, variantId(cleaner), unitId('pcs'));
    expect(keysOf(archived, 'price_list_item', 'delete')).toHaveLength(4);
    expect(keysOf(archived, 'price_list_item', 'delete')).toContain(cleanerPrice);

    dealer = await flip(priceListSchema, `/price-lists/${dealer.id}`, dealer, 'restore');
    const restored = await changesSince();
    expect(keysOf(restored, 'price_list_item')).toHaveLength(3);
    expect(keysOf(restored, 'price_list_item', 'delete')).toEqual([cleanerPrice]);
  });

  it('sends an archived product as a delete, with its prices and its stock', async () => {
    soap = await flip(productSchema, `/products/${soap.id}`, soap, 'archive');
    expect(await changesSince()).toEqual(
      expect.arrayContaining([
        { op: 'delete', entity: 'product', key: soap.id },
        {
          op: 'delete',
          entity: 'price_list_item',
          key: priceKey(dealer, variantId(soap), unitId('pcs')),
        },
        { op: 'delete', entity: 'stock', key: stockKey(depot, variantId(soap), soapBatch) },
      ]),
    );

    soap = await flip(productSchema, `/products/${soap.id}`, soap, 'restore');
    const back = await changesSince();
    expect(keysOf(back, 'product')).toEqual([soap.id]);
    expect(keysOf(back, 'price_list_item')).toEqual([
      priceKey(dealer, variantId(soap), unitId('pcs')),
    ]);
    expect(keysOf(back, 'stock')).toEqual([stockKey(depot, variantId(soap), soapBatch)]);
  });

  it('follows customers in and out: archived, a supplier who buys, a customer deleted', async () => {
    rahim = await flip(customerSchema, `/customers/${rahim.id}`, rahim, 'archive');
    expect(await changesSince()).toEqual([{ op: 'delete', entity: 'customer', key: rahim.id }]);

    // The packaging supplier starts buying: the same party is a customer now
    const [padma] = z
      .array(z.object({ id: z.uuid(), version: z.number() }))
      .parse(await sql`SELECT id, version FROM parties WHERE name = 'Padma Packaging'`);
    if (!padma) throw new Error('no supplier');
    const made = await send('POST', `/suppliers/${padma.id}/make-customer`, {
      version: padma.version,
    });
    expect(made.statusCode, made.body).toBe(200);
    expect(keysOf(await changesSince(), 'customer')).toEqual([padma.id]);

    // ...and stops: it stays a supplier, but leaves the device. A shop added and deleted between
    // two pulls arrives as a delete of a key the device never had, which is harmless.
    const asCustomer = customerSchema.parse(made.json());
    const removed = await send(
      'DELETE',
      `/customers/${padma.id}?version=${String(asCustomer.version)}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    const brief = await created(customerSchema, '/customers', customerForm('Bakul Store'));
    expect(
      (await send('DELETE', `/customers/${brief.id}?version=${String(brief.version)}`)).statusCode,
    ).toBe(204);
    expect(await changesSince()).toEqual(
      expect.arrayContaining([
        { op: 'delete', entity: 'customer', key: padma.id },
        { op: 'delete', entity: 'customer', key: brief.id },
      ]),
    );
  });

  it("sends this branch's stock as it moves, and never the other branch's", async () => {
    await putStock(depot, soap, variantId(soap), '60', soapBatch);
    await putStock(depot, juice, variantId(juice), '0');
    await putStock(ctgDepot, juice, variantId(juice), '456');
    const changes = await changesSince();
    expect(changes).toMatchObject([
      {
        op: 'upsert',
        key: stockKey(depot, variantId(soap), soapBatch),
        data: { quantity: '60.0000' },
      },
      { op: 'delete', entity: 'stock', key: stockKey(depot, variantId(juice)) },
    ]);

    // A new warehouse in Narsingdi comes to the device; the old store, emptied, goes
    const shop = await addWarehouse(narsingdi, 'NRS3', 'Narsingdi shop');
    oldStore = await flip(warehouseSchema, `/warehouses/${oldStore.id}`, oldStore, 'restore');
    expect(keysOf(await changesSince(), 'warehouse')).toEqual([shop.id, oldStore.id].sort());
    oldStore = await flip(warehouseSchema, `/warehouses/${oldStore.id}`, oldStore, 'archive');
    expect(await changesSince()).toEqual([{ op: 'delete', entity: 'warehouse', key: oldStore.id }]);
  });

  it('keeps a pull in progress to where it started', async () => {
    await setPrices(dealer, [[variantId(juice), unitId('pcs'), '24']]);
    await setPrices(dealer, [[variantId(juice), unitId('case'), '520']]);
    await setPrices(dealer, [[variantId(soap), unitId('pcs'), '42']]);
    const first = syncPullSchema.parse((await pullPage(counter.id, cursor, 1)).json());
    expect(first.hasMore).toBe(true);

    // Made while the pull runs: it waits for the next pull, so a busy workspace cannot keep a
    // pull going for ever
    await renameCompany('Meghna Distributors Ltd.');
    const rest = await pullAll(counter, first.cursor, 1);
    const pulled = [...first.changes, ...rest.changes];
    expect(keysOf(pulled, 'price_list_item')).toHaveLength(3);
    expect(keysOf(pulled, 'settings')).toEqual([]);

    cursor = rest.cursor;
    expect(await changesSince()).toMatchObject([
      { entity: 'settings', data: { companyName: 'Meghna Distributors Ltd.' } },
    ]);
  });

  it('starts a full pull again when the cursor is too old, or the device moved branch', async () => {
    const { serverTime } = syncPullSchema.parse((await pullPage(counter.id, cursor, 10)).json());
    const daysBefore = (days: number) =>
      new Date(Date.parse(serverTime) - days * 24 * 60 * 60 * 1000).toISOString();

    // 28 days: the log still has every line since. 30 days: it may not.
    const recent = await pullPage(counter.id, editCursor(cursor, { issuedAt: daysBefore(28) }), 10);
    expect(syncPullSchema.parse(recent.json()).full).toBe(false);
    const aged = await pullPage(counter.id, editCursor(cursor, { issuedAt: daysBefore(30) }), 10);
    expect(syncPullSchema.parse(aged.json()).full).toBe(true);
    const otherProtocol = await pullPage(counter.id, editCursor(cursor, { protocol: 0 }), 10);
    expect(syncPullSchema.parse(otherProtocol.json()).full).toBe(true);

    // Step 18c moves a device from the device list; until then, the superuser
    await sql`UPDATE devices SET branch_id = ${chattogram.id} WHERE id = ${counter.id}`;
    const moved = await pullAll(counter, cursor);
    expect(moved.pages[0]?.full).toBe(true);
    expect(keysOf(moved.changes, 'warehouse')).toEqual([ctgDepot.id]);
    expect(moved.changes.find((change) => change.entity === 'stock')).toMatchObject({
      key: stockKey(ctgDepot, variantId(juice)),
      data: { quantity: '456.0000' },
    });
    await sql`UPDATE devices SET branch_id = ${narsingdi.id} WHERE id = ${counter.id}`;
    cursor = (await pullAll(counter, undefined)).cursor;
  });

  it('refuses a cursor it did not make', async () => {
    const broken = [
      'abc',
      editCursor(cursor, { from: '1; DROP TABLE devices' }),
      editCursor(cursor, { kind: 'full', watermark: '1', entity: 99 }),
      editCursor(cursor, { branchId: 'Narsingdi' }),
    ];
    for (const value of broken) {
      const res = await pullPage(counter.id, value, 10);
      expect(res.statusCode, value).toBe(400);
      expect(problemOf(res).code).toBe('invalid_cursor');
    }
  });
});
```

- **Nothing changed, nothing sent.** The first test is an empty delta, so every later test sees only its own
  changes.
- **Prices:** one changed price is one upsert. Archiving the Dealer list deletes its prices; restoring it sends them
  back. The archived cleaner's price comes as a delete both times: the log names every price of the list, and a
  delete of a key the device never had changes nothing there (decision 16).
- **A product:** archived, it goes with its price and its stock (the scope trigger of 18a.2); restored, all three
  come back.
- **Customers:** an archived shop is a delete. The packaging supplier that starts buying (`make-customer`) arrives
  as a customer. When its customer side is deleted, it stays a supplier but leaves the device. A shop added and
  deleted between two pulls arrives as a delete only.
- **Stock:** a quantity change is an upsert, a row reaching zero is a delete, and Chattogram's change is not there
  at all. A new warehouse in Narsingdi comes; the old store, restored and archived again, comes and goes.
- **A pull in progress keeps its end.** Three prices change, the pull reads one line per page, and the company is
  renamed after its first page. The pull still ends with the three prices; the rename comes with the next pull.
  Without a fixed `to`, a busy workspace could keep `hasMore` true for ever.
- **When a full pull starts again:** a cursor 28 days old is still a delta; 30 days old, or of another protocol, it
  is a full pull. A device moved to Chattogram (by the superuser, until 18c) gets a full pull with Chattogram's
  depot and stock. The test moves it back and starts a fresh cursor.
- **A cursor the server did not make** answers `invalid_cursor` (400), never a Postgres error: not base64 JSON, a
  `from` that is not a number, a full cursor with no such entity, a branch that is not an id.

### The watermark

```ts
describe('the watermark', () => {
  it('holds back what committed after a transaction still open, until that one commits', async () => {
    let cursor = (await pullAll(counter, undefined)).cursor;
    const juicePrice = priceKey(dealer, variantId(juice), unitId('pcs'));
    const soapPrice = priceKey(dealer, variantId(soap), unitId('pcs'));

    // A slow save: its transaction has an id (it wrote), and it is still open
    const slow = await sql.reserve();
    let open = false;
    try {
      await slow`BEGIN`;
      open = true;
      await slow`UPDATE price_list_items SET price = 21
                  WHERE price_list_id = ${dealer.id} AND variant_id = ${variantId(juice)}
                    AND unit_id = ${unitId('pcs')}`;
      // A quick save after it, which commits first: a later transaction id
      await setPrices(dealer, [[variantId(soap), unitId('pcs'), '39']]);

      // The quick one's line is in the log, but the pull may not pass the slow one yet: once its
      // cursor moved past the quick one, the slow one's line (a lower id) would never be read
      const early = await pullAll(counter, cursor);
      expect(early.changes).toEqual([]);
      cursor = early.cursor;
      await slow`COMMIT`;
      open = false;
    } finally {
      // A failed check must not give the pool back a connection inside an open transaction: the
      // next statements on it would never commit
      if (open) await slow`ROLLBACK`;
      slow.release();
    }

    const late = await pullAll(counter, cursor);
    const prices = late.changes.map((change) =>
      change.op === 'upsert' && change.entity === 'price_list_item'
        ? [change.key, change.data.price]
        : [change.key],
    );
    expect(prices.sort()).toEqual(
      [
        [juicePrice, '21.0000'],
        [soapPrice, '39.0000'],
      ].sort(),
    );
  });
});
```

This is the test of decision 25, with two connections at once:

1. A slow save opens a transaction and changes the juice price. Its transaction now has an id, and it is still
   open.
2. A quick save through the API changes the soap price and commits. Its transaction id is higher.
3. A pull now returns nothing. The quick save's line is in the log, but the pull may not go past the slow one: if
   its cursor moved past the quick save, the slow save's line (a lower id, committed later) would never be read.
4. The slow save commits. The next pull returns both prices.

- **`sql.reserve()`** gives the test one connection of its own, so `BEGIN` and `COMMIT` run on the same session.
- **The `finally` rolls back** when a check failed before the commit. Without it, the pool would get back a
  connection inside an open transaction, and every later statement on it would never commit (the cleanup test
  then fails for a reason that has nothing to do with the cleanup).

### The change log's cleanup

```ts
describe('the change log', () => {
  it('keeps 30 days: the worker deletes the older lines', async () => {
    const lineCount = async () => {
      const [row] = z
        .array(z.object({ n: z.number() }))
        .parse(await sql`SELECT count(*)::int AS n FROM sync_changes`);
      return row?.n ?? 0;
    };
    const before = await lineCount();
    await sql`UPDATE sync_changes SET created_at = now() - interval '31 days'
               WHERE id IN (SELECT id FROM sync_changes ORDER BY id LIMIT 5)`;
    await sql`UPDATE sync_changes SET created_at = now() - interval '29 days'
               WHERE id IN (SELECT id FROM sync_changes ORDER BY id OFFSET 5 LIMIT 5)`;

    expect(await worker.get(SyncLogCleanup).deleteOld()).toBe(5);
    expect(await lineCount()).toBe(before - 5);
    expect(await worker.get(SyncLogCleanup).deleteOld()).toBe(0);
  });
});
```

Five lines are made 31 days old and five 29 days old. The worker's `SyncLogCleanup` deletes the five old ones only,
and a second run deletes nothing. It runs on the worker's own connection (`omnivo_worker`), as in production.

### `sync/sync.tenant-leak.int.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  branchListSchema,
  type Customer,
  customerBalancesSchema,
  customerSchema,
  type Device,
  deviceSchema,
  type Product,
  productSchema,
  problemSchema,
  setupSchema,
  type SyncChange,
  syncPullSchema,
  type Unit,
  unitListSchema,
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

// Two workspaces, each with a device. A device of A must never receive a row of B, nor use B's
// device, nor learn B's customers' balances; and in the database, the API's role must never read
// or write B's change log or devices.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;

interface Workspace {
  who: SignedIn;
  tenantId: string;
  units: Unit[];
  product: Product;
  customer: Customer;
  device: Device;
}
let a: Workspace;
let b: Workspace;

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

function pull(who: SignedIn, deviceId: string, cursor?: string) {
  const query = new URLSearchParams({ deviceId, protocol: '1', limit: '1000' });
  if (cursor !== undefined) query.set('cursor', cursor);
  return as(who, 'GET', `/sync/pull?${query.toString()}`);
}

// One page is enough: each workspace has far fewer rows than the limit
async function pulled(space: Pick<Workspace, 'who' | 'device'>, cursor?: string) {
  const res = await pull(space.who, space.device.id, cursor);
  expect(res.statusCode, res.body).toBe(200);
  const page = syncPullSchema.parse(res.json());
  expect(page.hasMore).toBe(false);
  return page;
}

// A change as text: its key (a price or a stock key holds three ids) and every id inside its row,
// so one search finds an id wherever the change names it
function idsIn(change: SyncChange): string {
  return JSON.stringify(change);
}

async function workspace(input: {
  companyName: string;
  workspaceSlug: string;
  fullName: string;
  email: string;
  password: string;
  industry: 'garments' | 'pharma';
  product: string;
  // The pharma template's products need a generic name
  customFields: Record<string, string>;
  customer: string;
}): Promise<Workspace> {
  const who = await signUp(app, {
    companyName: input.companyName,
    workspaceSlug: input.workspaceSlug,
    fullName: input.fullName,
    email: input.email,
    password: input.password,
  });
  expect((await as(who, 'POST', '/setup', { industry: input.industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  const units = unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  const productRes = await as(who, 'POST', '/products', {
    code: '',
    name: input.product,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs.id,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '10', archived: false },
    ],
    units: [],
    customFields: input.customFields,
  });
  expect(productRes.statusCode, productRes.body).toBe(201);
  const customerRes = await as(who, 'POST', '/customers', {
    code: '',
    name: input.customer,
    groupId: '',
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
  expect(customerRes.statusCode, customerRes.body).toBe(201);
  const [branch] = branchListSchema.parse((await as(who, 'GET', '/branches')).json()).items;
  if (!branch) throw new Error('no branch');
  const deviceRes = await as(who, 'POST', '/sync/devices', {
    id: v7(),
    name: 'Chrome on Windows',
    branchId: branch.id,
  });
  expect(deviceRes.statusCode, deviceRes.body).toBe(201);
  const device = deviceSchema.parse(deviceRes.json());
  // The settings row's key is the workspace's id
  const settings = (await pulled({ who, device })).changes.find(
    (change) => change.entity === 'settings',
  );
  return {
    who,
    tenantId: settings?.key ?? '',
    units,
    product: productSchema.parse(productRes.json()),
    customer: customerSchema.parse(customerRes.json()),
    device,
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
  [a, b] = await Promise.all([
    workspace({
      companyName: 'Rahman Garments Ltd.',
      workspaceSlug: 'rahman-garments',
      fullName: 'Farhana Rahman',
      email: 'farhana@rahmangarments.com',
      password: 'Gazipur-knit-2026',
      industry: 'garments',
      product: 'Polo shirt',
      customFields: {},
      customer: 'Nordic Wear AB',
    }),
    workspace({
      companyName: 'Karim Pharma',
      workspaceSlug: 'karim-pharma',
      fullName: 'Karim Uddin',
      email: 'karim@karimpharma.com',
      password: 'Batch-expiry-2026',
      industry: 'pharma',
      product: 'Napa 500 mg',
      customFields: { generic_name: 'Paracetamol' },
      customer: 'Lazz Pharma',
    }),
  ]);
  expect(a.tenantId).not.toBe('');
  expect(b.tenantId).not.toBe('');
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('pulling over HTTP', () => {
  it("never sends tenant B's rows to A's device", async () => {
    const { changes } = await pulled(a);
    const warehousesOfB = warehouseListSchema.parse(
      (await as(b.who, 'GET', '/warehouses')).json(),
    ).items;
    const idsOfB = [
      b.tenantId,
      b.product.id,
      ...b.product.variants.map((variant) => variant.id),
      b.customer.id,
      ...b.units.map((unit) => unit.id),
      ...warehousesOfB.map((warehouse) => warehouse.id),
    ];
    const everything = changes.map(idsIn).join('\n');
    for (const id of idsOfB) expect(everything).not.toContain(id);

    // A gets its own, so the check above is not passing on an empty pull
    expect(changes.filter((change) => change.entity === 'settings').map((c) => c.key)).toEqual([
      a.tenantId,
    ]);
    expect(changes.map((change) => change.key)).toEqual(
      expect.arrayContaining([a.product.id, a.customer.id]),
    );
  });

  it("never sends tenant B's changes in A's delta", async () => {
    const { cursor } = await pulled(a);
    const res = await as(b.who, 'POST', `/customers/${b.customer.id}/archive`, {
      version: b.customer.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const archived = await as(b.who, 'POST', `/products/${b.product.id}/archive`, {
      version: b.product.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    expect((await pulled(a, cursor)).changes).toEqual([]);
    // B's own device does hear about them
    const ofB = (await pulled(b)).changes.map((change) => change.key);
    expect(ofB).not.toContain(b.product.id);
    expect(ofB).not.toContain(b.customer.id);
  });

  it("cannot register or pull with tenant B's device", async () => {
    const [branch] = branchListSchema.parse((await as(a.who, 'GET', '/branches')).json()).items;
    const taken = await as(a.who, 'POST', '/sync/devices', {
      id: b.device.id,
      name: 'Chrome on Windows',
      branchId: branch?.id ?? '',
    });
    expect(taken.statusCode).toBe(409);
    expect(problemSchema.parse(taken.json()).code).toBe('device_id_invalid');

    const res = await pull(a.who, b.device.id);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('device_not_found');
    // ...and B's device still answers B, with its own branch
    expect((await pull(b.who, b.device.id)).statusCode).toBe(200);
  });

  it("gives no balance of tenant B's customers", async () => {
    const res = await as(a.who, 'GET', `/customer-balances?ids=${b.customer.id},${a.customer.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(customerBalancesSchema.parse(res.json()).items).toEqual([
      { id: a.customer.id, balance: '0.0000' },
    ]);
  });
});

// Postgres error code of a statement run as the given role, or null when it worked
async function errorCodeAs(url: string, run: (sql: postgres.Sql) => Promise<unknown>) {
  const sql = postgres(url, { max: 1 });
  try {
    await run(sql);
    return null;
  } catch (error) {
    return error instanceof postgres.PostgresError ? error.code : String(error);
  } finally {
    await sql.end();
  }
}

const tenantRowsSchema = z.array(z.object({ tenant_id: z.uuid() }));

// A statement in tenant A's context, as the API's role. Its rows are checked by the caller.
async function asAppInA(run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<unknown> {
  const sql = postgres(pg.appUrl, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
      return run(tx);
    });
  } finally {
    await sql.end();
  }
}

describe('the change log and the devices as omnivo_app', () => {
  it("reads only its own tenant's lines and devices", async () => {
    const lines = tenantRowsSchema.parse(
      await asAppInA((tx) => tx`SELECT DISTINCT tenant_id FROM sync_changes`),
    );
    expect(lines).toEqual([{ tenant_id: a.tenantId }]);
    const devices = tenantRowsSchema.parse(
      await asAppInA((tx) => tx`SELECT tenant_id FROM devices`),
    );
    expect(devices).toEqual([{ tenant_id: a.tenantId }]);
  });

  it("cannot add a line for tenant B, nor change B's device", async () => {
    // 42501: a row that breaks the policy's WITH CHECK is refused as a privilege error
    expect(
      await errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
          await tx`INSERT INTO sync_changes (tenant_id, entity, entity_key)
                   VALUES (${b.tenantId}, 'product', ${b.product.id})`;
        }),
      ),
    ).toBe('42501');
    // B's device is not there to change: the UPDATE finds no row
    const updated = await asAppInA(
      (tx) => tx`UPDATE devices SET name = 'Taken' WHERE id = ${b.device.id} RETURNING id`,
    );
    expect(updated).toEqual([]);
  });

  it('cannot edit or delete a line, nor delete a device, even its own', async () => {
    const inA = (statement: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
          await statement(tx);
        }),
      );
    expect(await inA((tx) => tx`UPDATE sync_changes SET entity_key = 'x'`)).toBe('42501');
    expect(await inA((tx) => tx`DELETE FROM sync_changes`)).toBe('42501');
    expect(await inA((tx) => tx`DELETE FROM devices`)).toBe('42501');
  });
});

describe('omnivo_worker, the cleanup role', () => {
  it('sees the lines of every tenant, without a tenant context', async () => {
    const sql = postgres(pg.workerUrl, { max: 1 });
    const rows = tenantRowsSchema.parse(await sql`SELECT DISTINCT tenant_id FROM sync_changes`);
    await sql.end();
    expect(rows.map((row) => row.tenant_id).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('cannot read the devices, nor add a line', async () => {
    expect(await errorCodeAs(pg.workerUrl, (sql) => sql`SELECT 1 FROM devices LIMIT 1`)).toBe(
      '42501',
    );
    expect(
      await errorCodeAs(
        pg.workerUrl,
        (sql) => sql`INSERT INTO sync_changes (tenant_id, entity, entity_key)
                     VALUES (${a.tenantId}, 'product', ${a.product.id})`,
      ),
    ).toBe('42501');
  });
});
```

- **Each workspace has a product, a customer and a device,** and A's full pull is searched for every id of B: its
  workspace id, product, variant, customer, units and warehouses, anywhere in a key or a row. A's own rows are
  checked too, so the test cannot pass on an empty pull.
- **B's changes never reach A's delta,** while B's own device does get them.
- **B's device is not A's:** registering its id answers `device_id_invalid`, pulling with it `device_not_found`.
- **B's customer has no balance for A:** it is left out of the answer, like an id that does not exist.
- **In the database, as the API's role** (`omnivo_app`, in A's context): it reads only A's lines and devices; adding
  a line for B is refused by the policy's `WITH CHECK` (42501); an `UPDATE` of B's device finds no row; and it may
  not edit or delete a line, nor delete a device, even its own (0044's `REVOKE`).
- **As the worker's role** (`omnivo_worker`): it sees the lines of both workspaces without a tenant context (the
  `sync_prune` policy), cannot read the devices, and cannot add a line.
- The two new tables are also in the RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`), which finds every
  table with a `tenant_id` and checks that its row security is on: it needed no change.

### `sales/customers.int.spec.ts`: the balances of the rows on screen

```diff
@@ -6,11 +6,13 @@ import {
   type Customer,
   type CustomerFormValues,
   customerGroupListSchema,
+  customerBalancesSchema,
   customerGroupSchema,
   customerPageSchema,
   customerSchema,
   journalEntrySchema,
   ledgerPageSchema,
+  MAX_BALANCE_IDS,
   memberPageSchema,
   openingBalancesSchema,
   priceListSchema,
@@ -20,6 +22,7 @@ import {
 } from '@omnivo/contracts';
 import postgres from 'postgres';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
+import { z } from 'zod';
 
 import {
   createTestApp,
@@ -590,6 +593,53 @@ describe('customers in the books', () => {
     expect(problemOf(statement).params).toEqual({ permissions: 'sales.customer.balance' });
   });
 
+  // Step 18a: the customer list reads its rows from the device, and their balances from here
+  it('give the balances of the rows on screen, many at once', async () => {
+    const supplier = await send('POST', '/suppliers', {
+      code: '',
+      name: 'Chittagong Dyeing Works',
+      groupId: '',
+      contactPerson: '',
+      phone: '',
+      email: '',
+      documentLanguage: 'en',
+      bin: '',
+      paymentTermsDays: 30,
+      address: '',
+      bankAccounts: [],
+      notes: '',
+    });
+    expect(supplier.statusCode, supplier.body).toBe(201);
+    const supplierId = z.object({ id: z.uuid() }).parse(supplier.json()).id;
+
+    // The archived customer counts (the device may still show it); the supplier and an id this
+    // workspace does not know are left out, without an error
+    const unknown = '01939d1c-0000-7000-8000-000000000000';
+    const ids = [buyer.id, gone.id, supplierId, unknown].join(',');
+    const res = await send('GET', `/customer-balances?ids=${ids}`);
+    expect(res.statusCode, res.body).toBe(200);
+    const items = customerBalancesSchema.parse(res.json()).items;
+    expect(items.sort((x, y) => x.id.localeCompare(y.id))).toEqual(
+      [
+        { id: buyer.id, balance: '480000.0000' },
+        { id: gone.id, balance: '0.0000' },
+      ].sort((x, y) => x.id.localeCompare(y.id)),
+    );
+
+    // Like the statement: not for the salesperson
+    const theirs = await send('GET', `/customer-balances?ids=${buyer.id}`, undefined, seller);
+    expect(theirs.statusCode).toBe(403);
+    expect(problemOf(theirs).params).toEqual({ permissions: 'sales.customer.balance' });
+
+    // At most a page of the list at a time, and only ids
+    const tooMany = Array.from({ length: MAX_BALANCE_IDS + 1 }, () => buyer.id).join(',');
+    for (const query of [tooMany, '', 'Aarhus']) {
+      const bad = await send('GET', `/customer-balances?ids=${query}`);
+      expect(bad.statusCode, query.slice(0, 20)).toBe(400);
+      expect(Object.keys(problemOf(bad).fieldErrors ?? {})[0]).toMatch(/^ids/);
+    }
+  });
+
   it('give a statement like a ledger: opening balance, running balance, pages', async () => {
     // The buyer pays part by TT, and is invoiced again; another customer's invoice is not theirs
     await posted('2026-09-20', [debit('1110', '300000'), credit(RECEIVABLE, '300000', buyer.id)]);
```

- **The archived customer counts:** the device may still show a customer archived a minute ago. The supplier and an
  unknown id are left out, without an error.
- **The salesperson is refused** with the same permission as the statement, `sales.customer.balance`.
- **The query's limits:** 101 ids, an empty list and a name instead of an id are all a 400 under `ids`.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api lint
cd apps/api
npx vitest run src/sync/ src/sales/customers.int.spec.ts
```

The last command starts its own Postgres and Valkey containers (Docker must be running) and takes about half a
minute. All 48 tests pass. The whole suites (`pnpm test:integration`, `pnpm test:tenant-leak`) run once at the end of
18a.

## 18a.5 — `packages/i18n`: the words

The screens of 18a.6 need their words in English and Bangla, and the app cannot type-check without them, so they come
first. This part changes only the two locale files. The ui package needs nothing new: the branch question is the
dialog with a select, the "not set up" and "needs a connection" states are the empty state, and the pickers are the
`Combobox` with its own status line.

When this part starts, `packages/i18n` has one error: the `errors` object is missing the 6 new codes of 18a.1. The app
has 3 more, all in the audit log page: it builds its keys from `AUDIT_ACTIONS` and `AUDIT_ENTITY_TYPES`, which now
hold `device.registered` and `device`. When this part ends, both type-check.

### `locales/en.ts`

```diff
@@ -334,6 +334,43 @@ export const en = {
       'Ask a workspace owner for the core.branch.manage permission to add or change branches.',
     loadFailed: "Couldn't load the branches. Refresh the page to try again.",
   },
+  devices: {
+    // The name a device gets without a question (decision 12), like "Chrome on Windows". Browser
+    // and system names are product names: the app fills them in as they are
+    defaultName: '{{browser}} on {{os}}',
+    fallbackName: 'Web browser',
+    branchTitle: 'Which branch is this device in?',
+    branchDescription:
+      "Omnivo keeps a copy of the products, prices, customers and this branch's stock on this device, so they open at once and keep working when the internet drops.",
+    branch: 'Branch',
+    branchPlaceholder: 'Pick a branch',
+    branchHint: 'The branch where this computer or phone is used, like the Chattogram depot.',
+    useBranch: 'Use this branch',
+    later: 'Not now',
+    registered: 'This device is set up for {{branch}}',
+  },
+  sync: {
+    notSetUpTitle: 'This device is not set up yet',
+    notSetUpBody:
+      'Products and customers are read from a copy on this device. Choose its branch to make the copy.',
+    setUp: 'Choose the branch',
+    firstPullTitle: 'Copying the data to this device…',
+    firstPullBody: 'This happens once. After that, only the changes come over.',
+    // count picks the plural; formatted = the number in the page's language (1,250 / ১,২৫০)
+    firstPullCount_one: '{{formatted}} item copied so far',
+    firstPullCount_other: '{{formatted}} items copied so far',
+    firstPullFailedTitle: "Couldn't copy the data to this device",
+    firstPullFailedBody:
+      'Check the internet connection. Omnivo tries again by itself every minute, or you can try now.',
+    offlineEmptyTitle: 'Not on this device yet',
+    offlineEmptyBody:
+      'This device has no copy of the data yet. Connect to the internet once to make it.',
+    needsConnectionTitle: 'Needs a connection',
+    revokedTitle: 'This device was removed',
+    storageFailedTitle: "This browser can't keep the data",
+    storageFailedBody:
+      "Omnivo keeps its copy in the browser's storage. Leave private browsing or free some space on the device, then reload the page.",
+  },
   accounts: {
     title: 'Chart of accounts',
     description: 'The groups and accounts your books are kept in',
@@ -747,6 +784,8 @@ export const en = {
     noMatchBody: 'Check the spelling, or search by code, SKU or barcode.',
     archivedEmptyTitle: 'No archived products',
     archivedEmptyBody: 'A product you archive shows up here. Archive what you no longer sell.',
+    archivedOfflineBody:
+      'Archived products are not kept on this device. Connect to the internet to see them.',
     loadFailed: "Couldn't load the products. Refresh the page to try again.",
     readOnly:
       'You can see the products. To change them, ask for the inventory.product.manage permission.',
@@ -1488,6 +1527,10 @@ export const en = {
     archivedEmptyTitle: 'No archived customers',
     archivedEmptyBody:
       'A customer you archive shows up here. Their history and what they owe stay.',
+    archivedOfflineBody:
+      'Archived customers are not kept on this device. Connect to the internet to see them.',
+    balancesOffline: 'Balances need a connection',
+    balancesFailed: "Couldn't load the balances. Refresh the page to try again.",
     loadFailed: "Couldn't load the customers. Refresh the page to try again.",
     readOnly:
       'You can see the customers. To change them, ask for the sales.customer.manage permission.',
@@ -4161,6 +4204,7 @@ export const en = {
       purchase_return: 'Purchase returns',
       debit_note: 'Debit notes',
       supplier_refund: 'Supplier refunds',
+      device: 'Devices',
     },
     columns: {
       when: 'When',
@@ -4193,6 +4237,7 @@ export const en = {
         restored: 'Restored a branch',
       },
       number_series: { updated: 'Changed a numbering format' },
+      device: { registered: 'Set up a device' },
       member: {
         invited: 'Invited someone',
         invitation_resent: 'Resent an invitation',
@@ -5222,6 +5267,13 @@ export const en = {
       'The supplier paid some of this payment back. Void that supplier refund first, then the payment.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
+    device_id_invalid: "This device's id is already taken. Reload the page to set it up again.",
+    device_name_required: 'Give this device a name, like Counter 1.',
+    device_branch_invalid: 'Pick an active branch.',
+    device_not_found: "This device isn't set up in this workspace. Reload the page to set it up.",
+    device_revoked:
+      'This device was removed from the workspace and no longer syncs. Ask a workspace owner about it.',
+    sync_protocol_mismatch: 'Omnivo was updated. Reload the page to keep syncing.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, taken from `en`, so a
  key missing in Bangla fails the type check. The `errors` object ends with `satisfies Record<ErrorCode, string>`,
  so the 6 codes of 18a.1 must be here, or the package does not compile.
- **`devices` and `sync` are two sections, not one.** `devices` holds the words about the device itself (its name,
  its branch). 18c adds the device list, rename and revoke to it. `sync` holds the words about the copy of the data
  on the device. 18c adds the sidebar status and the Sync page to it. Kept apart, neither section turns into a long
  mixed list.
- **`devices.defaultName` is "{{browser}} on {{os}}".** It is the name a device gets without a question (decision
  12). The app reads "Chrome" and "Windows" from the browser and passes them in; they are product names, so they are
  never translated. The Bangla text puts them in Bangla word order ("Windows-এ Chrome"). The name is saved on the
  server once, in the language of the person who signed in; renaming is 18c's. `fallbackName` is for a browser the
  app does not know: the name must be at least 2 characters (`deviceNameSchema`), so it can never be empty.
- **The branch dialog.** `branchTitle` is the question of decision 12, word for word. `branchDescription` says why
  it is asked: what is kept on the device, and that it works without the internet. A person who knows why picks the
  branch they sit in, not the first one in the list. `later` is "Not now" (decision 40).
- **`sync.notSetUp*`** is the empty state of the products and customers pages and the pickers before the branch is
  chosen (decision 40). Its body says what to do, and its button `setUp` opens the dialog.
- **`sync.firstPull*`** is shown while the first pull runs and the device has no rows yet. A garments company with
  3,000 styles and their variants needs many pages, so the count says that something is happening. It takes `count`
  for the plural and `formatted` for the number in the page's language, like `ui.dataTable.rowCount`: `{{count}}`
  alone would print "1250" in both languages. "Item", not "row": the person does not need to know what a row is.
  `firstPullFailed*` says that the app tries again by itself (the 60-second pull), so nobody keeps clicking.
- **`sync.offlineEmpty*`** is for a device that was set up but never finished its first pull, and is now offline.
  It is not "No products yet": the workspace may have thousands; this device just does not have them.
- **`sync.needsConnectionTitle`** is the title of the archived tabs offline (decision 11). Each page brings its own
  body (`products.archivedOfflineBody`, `customers.archivedOfflineBody`), so the text names what is missing.
- **`devices.branchPlaceholder`** ("Pick a branch") is the empty first option of the branch box, and
  **`sync.revokedTitle`** ("This device was removed") the title of a revoked device's page. Both were added while
  the screens of 18a.6 were built: the box starts empty (decision 47), and a revoked device needs a title above the
  `device_revoked` text.
- **`sync.storageFailed*`** is for a browser that refuses IndexedDB. A private window in some browsers, or a full
  disk on a cheap shop computer, does this. Without the text, the products page would only say that the list could
  not be loaded, and a reload would not help.
- **`customers.balancesOffline`** is decision 10's "Balances need a connection". The column shows a dash; this text
  is its label for screen readers and the line above the table. `balancesFailed` is for the balances route failing
  while online: the rows still show, from the device, and only the balances are missing.
- **The audit log:** `device.registered` is "Set up a device", and the entity type `device` gets the filter name
  "Devices". The row's changes (`name`, `branch`) already have their names in `audit.fields`.
- **The errors.**
  - `device_id_invalid` and `device_not_found` tell the person to reload. The app answers both by itself in 18a.6 (a
    new id, or registering again), so a person sees them only if that fails too.
  - `device_branch_invalid` is the same text as `warehouse_branch_invalid`: it shows under the branch box.
  - `device_revoked` does not say how to get the device back: 18c decides that, and it is a workspace owner's call.
  - `sync_protocol_mismatch` says to reload (decision 18). The app shows this error text itself; no second key.

### `locales/bn.ts`

```diff
@@ -330,6 +330,39 @@ export const bn: Messages = {
     readOnly: 'ব্রাঞ্চ যোগ বা বদল করতে ওয়ার্কস্পেস মালিকের কাছে core.branch.manage অনুমতি চান।',
     loadFailed: 'ব্রাঞ্চের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  devices: {
+    defaultName: '{{os}}-এ {{browser}}',
+    fallbackName: 'ওয়েব ব্রাউজার',
+    branchTitle: 'এই ডিভাইসটা কোন ব্রাঞ্চে?',
+    branchDescription:
+      'প্রোডাক্ট, দাম, গ্রাহক আর এই ব্রাঞ্চের স্টকের একটা কপি Omnivo এই ডিভাইসে রাখে, যাতে সেগুলো সাথে সাথে খোলে আর ইন্টারনেট চলে গেলেও কাজ করে।',
+    branch: 'ব্রাঞ্চ',
+    branchPlaceholder: 'একটা ব্রাঞ্চ বাছুন',
+    branchHint: 'যে ব্রাঞ্চে এই কম্পিউটার বা ফোন ব্যবহার হয়, যেমন চট্টগ্রাম ডিপো।',
+    useBranch: 'এই ব্রাঞ্চ রাখুন',
+    later: 'এখন না',
+    registered: 'এই ডিভাইস {{branch}}-এর জন্য সেট করা হয়েছে',
+  },
+  sync: {
+    notSetUpTitle: 'এই ডিভাইস এখনো সেট করা হয়নি',
+    notSetUpBody:
+      'প্রোডাক্ট আর গ্রাহক এই ডিভাইসের একটা কপি থেকে দেখানো হয়। কপিটা বানাতে ডিভাইসের ব্রাঞ্চ বাছুন।',
+    setUp: 'ব্রাঞ্চ বাছুন',
+    firstPullTitle: 'ডেটা এই ডিভাইসে কপি হচ্ছে…',
+    firstPullBody: 'এটা একবারই হয়। এরপর শুধু বদলগুলো আসে।',
+    firstPullCount_one: 'এ পর্যন্ত {{formatted}}টা কপি হয়েছে',
+    firstPullCount_other: 'এ পর্যন্ত {{formatted}}টা কপি হয়েছে',
+    firstPullFailedTitle: 'ডেটা এই ডিভাইসে কপি করা যায়নি',
+    firstPullFailedBody:
+      'ইন্টারনেট সংযোগ দেখুন। Omnivo প্রতি মিনিটে নিজেই আবার চেষ্টা করে, চাইলে এখনই চেষ্টা করতে পারেন।',
+    offlineEmptyTitle: 'এখনো এই ডিভাইসে নেই',
+    offlineEmptyBody: 'এই ডিভাইসে এখনো ডেটার কোনো কপি নেই। কপিটা বানাতে একবার ইন্টারনেটে যুক্ত হন।',
+    needsConnectionTitle: 'ইন্টারনেট সংযোগ লাগবে',
+    revokedTitle: 'এই ডিভাইস সরিয়ে দেওয়া হয়েছে',
+    storageFailedTitle: 'এই ব্রাউজার ডেটা রাখতে পারছে না',
+    storageFailedBody:
+      'Omnivo তার কপি ব্রাউজারের স্টোরেজে রাখে। প্রাইভেট ব্রাউজিং থেকে বের হন বা ডিভাইসে কিছু জায়গা খালি করুন, তারপর পেজটা রিলোড করুন।',
+  },
   accounts: {
     title: 'চার্ট অফ অ্যাকাউন্টস',
     description: 'যে গ্রুপ আর অ্যাকাউন্টে আপনার হিসাবের খাতা রাখা হয়',
@@ -744,6 +777,7 @@ export const bn: Messages = {
     archivedEmptyTitle: 'কোনো আর্কাইভ করা প্রোডাক্ট নেই',
     archivedEmptyBody:
       'যে প্রোডাক্ট আর্কাইভ করবেন সেটা এখানে দেখাবে। আর বিক্রি হয় না এমনগুলো আর্কাইভ করুন।',
+    archivedOfflineBody: 'আর্কাইভ করা প্রোডাক্ট এই ডিভাইসে রাখা হয় না। দেখতে ইন্টারনেটে যুক্ত হন।',
     loadFailed: 'প্রোডাক্টের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     readOnly: 'আপনি প্রোডাক্ট দেখতে পারেন। বদলাতে inventory.product.manage অনুমতি চান।',
     back: 'প্রোডাক্ট',
@@ -1474,6 +1508,9 @@ export const bn: Messages = {
     noMatchBody: 'বানান দেখুন, অথবা কোড বা ফোন নম্বর দিয়ে খুঁজুন।',
     archivedEmptyTitle: 'কোনো আর্কাইভ করা গ্রাহক নেই',
     archivedEmptyBody: 'আর্কাইভ করা গ্রাহক এখানে দেখাবে। তাদের ইতিহাস আর পাওনা থেকে যায়।',
+    archivedOfflineBody: 'আর্কাইভ করা গ্রাহক এই ডিভাইসে রাখা হয় না। দেখতে ইন্টারনেটে যুক্ত হন।',
+    balancesOffline: 'ব্যালান্স দেখতে ইন্টারনেট সংযোগ লাগবে',
+    balancesFailed: 'ব্যালান্স আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     loadFailed: 'গ্রাহকের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     readOnly: 'আপনি গ্রাহক দেখতে পারেন। বদলাতে sales.customer.manage অনুমতি চান।',
     back: 'গ্রাহক',
@@ -4016,6 +4053,7 @@ export const bn: Messages = {
       purchase_return: 'পারচেজ রিটার্ন',
       debit_note: 'ডেবিট নোট',
       supplier_refund: 'সাপ্লায়ার রিফান্ড',
+      device: 'ডিভাইস',
     },
     columns: {
       when: 'কখন',
@@ -4046,6 +4084,7 @@ export const bn: Messages = {
         restored: 'ব্রাঞ্চ ফিরিয়ে এনেছেন',
       },
       number_series: { updated: 'নম্বরিং বদলেছেন' },
+      device: { registered: 'একটা ডিভাইস সেট করেছেন' },
       member: {
         invited: 'আমন্ত্রণ পাঠিয়েছেন',
         invitation_resent: 'আমন্ত্রণ আবার পাঠিয়েছেন',
@@ -5052,6 +5091,13 @@ export const bn: Messages = {
       'সাপ্লায়ার এই পেমেন্টের কিছুটা ফেরত দিয়েছেন। আগে সেই সাপ্লায়ার রিফান্ডটা ভয়েড করুন, তারপর পেমেন্ট।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
+    device_id_invalid: 'এই ডিভাইসের আইডি আগেই নেওয়া। আবার সেট করতে পেজটা রিলোড করুন।',
+    device_name_required: 'ডিভাইসের একটা নাম দিন, যেমন কাউন্টার ১।',
+    device_branch_invalid: 'একটা চালু ব্রাঞ্চ বাছুন।',
+    device_not_found: 'এই ডিভাইস এই ওয়ার্কস্পেসে সেট করা নেই। সেট করতে পেজটা রিলোড করুন।',
+    device_revoked:
+      'এই ডিভাইসটা ওয়ার্কস্পেস থেকে সরানো হয়েছে, তাই আর সিঙ্ক হয় না। ওয়ার্কস্পেসের মালিককে জিজ্ঞেস করুন।',
+    sync_protocol_mismatch: 'Omnivo আপডেট হয়েছে। সিঙ্ক চালু রাখতে পেজটা রিলোড করুন।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- **The same keys, in the same places.** Office words stay in English letters where the app already uses them that
  way: ব্রাঞ্চ, ডিভাইস, সিঙ্ক, ওয়ার্কস্পেস (CLAUDE.md → Language).
- **`firstPullCount_one` and `firstPullCount_other` are the same text.** Bangla has one form for one and many, but
  i18next asks for both keys, because the English type has both.
- **"Counter 1" is "কাউন্টার ১"** in the name error: it is an example of a name a person would type, so it uses
  Bangla digits.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/app typecheck
```

`@omnivo/contracts` was built in 18a.1. Build `@omnivo/i18n` before you type-check the ui package and the app: they
read its built types, so until then the app still says that `audit.actions.device.registered` is not a key.

> **What we checked in this part.** `packages/i18n` type-checks, ESLint and Prettier are clean, its unit tests pass
> (11), and it builds. `packages/ui` and `apps/app` type-check against the new build, with no errors left. To be sure
> `bn.ts` cannot fall behind, we removed two Bangla keys on purpose, one at a time (the error text `device_revoked`
> and `sync.storageFailedTitle`): the type check failed each time, and passed again with the key back.


## 18a.6 — `packages/sync` and the app: the copy on the device

The API sends the rows; this part keeps them in the browser and reads them from there. It has two halves:

- **`packages/sync`** (new) is framework-free: the IndexedDB database (through Dexie), the code that applies a page
  of changes, the pull loop, the device's identity, and the reads the pages need. Its tests run in Node with
  `fake-indexeddb`.
- **The app** registers the device after sign-in, starts the pull loop, and moves the products and customers pages
  and two pickers to the copy.

New dependencies: `dexie` (in `packages/sync`) and `fake-indexeddb` (dev, in `packages/sync`). `uuidv7` and `zod`
are already in the workspace. Install them with:

```bash
pnpm install
```

How the pieces fit, from sign-in to a row on screen:

1. The AppShell renders `LocalDataHost` lazily. It starts a **session** for the person and workspace
   (`local-session.ts`): it reads the device's identity from `localStorage`, registers the device if it is new (with
   the only branch, or after the branch dialog), opens the database and starts the **engine**.
2. The engine pulls page after page (`GET /sync/pull`), and `applyPage()` writes each page and its cursor in one
   IndexedDB transaction. It pulls again on focus, on `online`, every minute, and right after a save.
3. The session puts the database, the engine and Dexie's `liveQuery` into a small store (`local-data.ts`). A page
   reads with `useLocalQuery(read)`: the read runs again by itself whenever a pull changes a table it read.

Dexie is only in step 2's code. The pages and the pickers import the store and the reads, none of which loads Dexie,
so their chunks stay inside the 105 KB budget (decision 42).

### The package

```json
{
  "name": "@omnivo/sync",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@omnivo/contracts": "workspace:*",
    "dexie": "^4.4.6",
    "uuidv7": "^1.2.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@omnivo/config": "workspace:*",
    "fake-indexeddb": "^6.2.6",
    "typescript": "^6.0.3",
    "vitest": "^5.0.1"
  }
}
```

- **`sideEffects: false`** tells the bundler that importing a module of this package does nothing by itself. A page
  that imports only `findCustomers` then gets `queries.ts` and `records.ts`, and not `database.ts`, which imports
  Dexie. Without it, Vite would keep every module the index re-exports.
- **`"test": "vitest run"`** without `--passWithNoTests`: this package has tests from the start, and a run that
  finds none is a broken config, not a pass.
- `@omnivo/contracts` is a dependency, not a dev one: the reads use `compareMoney` at run time, and the engine
  `SYNC_PROTOCOL`.

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "lib": ["ES2023", "DOM"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "declarationMap": true
  },
  "exclude": ["src/**/*.spec.ts", "src/test-fixtures.ts"]
}
```

The same two files as `packages/i18n`: `lib` has `DOM` (IndexedDB, `navigator.locks`, `localStorage`), and the build
leaves out the specs and `test-fixtures.ts`, so neither is in `dist`.

### `database.ts`: the tables

```ts
import type {
  Product,
  SyncCategory,
  SyncCustomer,
  SyncCustomerGroup,
  SyncEntity,
  SyncPriceList,
  SyncPriceListItem,
  SyncSettings,
  SyncStock,
  TaxRate,
  Unit,
  Warehouse,
} from '@omnivo/contracts';
import { Dexie, type Table } from 'dexie';

// One row on the device: the row the server sent (`data`), under the key of its change, and the
// generation of the pull that wrote it. The generation is how a full pull finds the rows it did
// not send (apply.ts). `data` is never changed on the device: it is the server's row as it came.
export interface Stored<T> {
  // The row's id, or priceListItemKey() / stockKey(); the settings' key is the workspace's id
  key: string;
  gen: number;
  data: T;
}

// A product with what its list needs to search and sort without opening every row: the server
// sorts on lower(name) and lower(code), so the device does too.
export interface ProductRecord extends Stored<Product> {
  sortName: string;
  sortCode: string;
  // The name, the code and the SKUs in lower case, for "contains"
  text: string;
  // Every barcode of the product: its variants' and its packs'. A barcode is matched whole.
  barcodes: string[];
}

export interface CustomerRecord extends Stored<SyncCustomer> {
  sortName: string;
  // The name, the code, the contact person and the phone in lower case, for "contains"
  text: string;
}

// Where a pull is: one row in `meta`, under the key 'pull'
export interface PullState {
  key: 'pull';
  // The cursor to send next: the last page's. null = nothing pulled yet, so a full pull.
  cursor: string | null;
  // The generation every row is written with now. A full pull starts a new one.
  generation: number;
  // A full pull is under way: its last page has not come yet
  full: boolean;
  // The server's clock at the end of the last pull that finished. null = no pull has finished,
  // so the device has no complete copy yet.
  lastSyncAt: string | null;
  // The rows the running (or the last) full pull wrote, for "1,250 items copied so far"
  copied: number;
}

// The tables, by entity. The names are the ones the app reads (db.products, db.customers).
export const TABLE_OF = {
  settings: 'settings',
  unit: 'units',
  product_category: 'productCategories',
  tax_rate: 'taxRates',
  warehouse: 'warehouses',
  price_list: 'priceLists',
  customer_group: 'customerGroups',
  product: 'products',
  price_list_item: 'priceListItems',
  customer: 'customers',
  stock: 'stock',
} as const satisfies Record<SyncEntity, string>;
export type SyncTableName = (typeof TABLE_OF)[SyncEntity];

// One local database per person and workspace: two people on one shop computer never read each
// other's copy, and a person in two workspaces keeps both.
export function databaseName(tenantId: string, userId: string): string {
  return `omnivo-${tenantId}-${userId}`;
}

// Signing out deletes the copy (decision 41): the next person at a shop computer cannot read it
// in the browser's tools. A tab still holding it open closes it by itself: Dexie closes a
// database when another connection asks to delete it.
export async function deleteLocalDatabase(tenantId: string, userId: string): Promise<void> {
  await Dexie.delete(databaseName(tenantId, userId));
}

export class SyncDatabase extends Dexie {
  // `!`: Dexie makes these properties itself, from the stores() below
  settings!: Table<Stored<SyncSettings>, string>;
  units!: Table<Stored<Unit>, string>;
  productCategories!: Table<Stored<SyncCategory>, string>;
  taxRates!: Table<Stored<TaxRate>, string>;
  warehouses!: Table<Stored<Warehouse>, string>;
  priceLists!: Table<Stored<SyncPriceList>, string>;
  customerGroups!: Table<Stored<SyncCustomerGroup>, string>;
  products!: Table<ProductRecord, string>;
  priceListItems!: Table<Stored<SyncPriceListItem>, string>;
  customers!: Table<CustomerRecord, string>;
  stock!: Table<Stored<SyncStock>, string>;
  meta!: Table<PullState, string>;

  constructor(name: string) {
    super(name);
    // The first word is the primary key; the others are indexes. `gen` on every synced table:
    // the end of a full pull deletes the rows of older generations with one range each.
    // `*barcodes` is a multi-entry index (one entry per barcode), for a scanner (step 20).
    // `data.priceListId`, `data.warehouseId` and the others are key paths into the server's row:
    // a sale line (18b) looks up its price and its stock by them.
    this.version(1).stores({
      settings: 'key, gen',
      units: 'key, gen',
      productCategories: 'key, gen',
      taxRates: 'key, gen',
      warehouses: 'key, gen',
      priceLists: 'key, gen',
      customerGroups: 'key, gen',
      products: 'key, gen, sortName, sortCode, *barcodes',
      priceListItems: 'key, gen, data.priceListId, data.variantId',
      customers: 'key, gen, sortName',
      stock: 'key, gen, data.warehouseId, data.variantId',
      meta: 'key',
    });
  }

  // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
  syncTables() {
    return Object.values(TABLE_OF).map((name) => this[name]);
  }
}
```

- **A row is `{ key, gen, data }`.** `data` is the server's row exactly as it came, so the device reads a product in
  the shape the product page reads it (decision 14). `key` is the change's key, which is also what a delete sends:
  a price or a stock row has no id of its own, so a table keyed by `id` could not take its delete. `gen` is the
  full-pull mark of decision 46.
- **A product and a customer carry a few fields for the list:** `sortName` and `sortCode` in lower case (the server
  sorts on `lower(name)`), and `text`, the searched parts joined. They are worked out once, when the row is written,
  not on every key press.
- **`*barcodes` is a multi-entry index**, one entry per barcode. The search below does not need it (it filters
  anyway), but step 20's scanner does: one index lookup instead of reading every product.
- **`data.priceListId`, `data.warehouseId` and the other dotted names are key paths into the server's row.** 18b's
  sales line looks a price up by list and variant, and the stock by warehouse; Dexie indexes the nested field, so
  nothing is copied out of `data`.
- **`gen` is indexed on every synced table,** so the end of a full pull deletes the rows of older generations with
  one range per table, without reading them.
- **`meta` holds one row, the `PullState`.** The cursor lives in the database, next to the rows it describes, and is
  saved in the same transaction. In `localStorage`, a tab closed between the two writes could keep rows newer than
  its cursor, or a cursor newer than its rows; the second loses changes.
- **`TABLE_OF ... satisfies Record<SyncEntity, string>`.** A new entity in the contract does not compile until it has
  a table here.
- **`databaseName(tenantId, userId)`**: one database per person and workspace (decision 41's reason: two people on
  one shop computer never read each other's copy).
- **`deleteLocalDatabase()`** is `Dexie.delete()`. Another tab that still has the database open closes it when asked
  (Dexie listens for the browser's `versionchange` event), so a sign-out in one tab is not blocked by another.
- **`version(1)`.** When a later protocol changes the tables, the version goes up with an upgrade that clears them:
  the copy is a cache, and a full pull refills it.

### `records.ts`, `state.ts`, `problems.ts`: the parts a page may load

```ts
import type { Product, SyncCustomer } from '@omnivo/contracts';

import type { CustomerRecord, ProductRecord } from './database.js';

// The text a search looks in, in lower case. The parts are joined with a line break, which no
// search box can hold, so a search never matches across two parts ("Shirt" + "M" is not "tm").
export function searchText(parts: readonly (string | null)[]): string {
  return parts
    .filter((part) => part !== null && part !== '')
    .join('\n')
    .toLowerCase();
}

// What the search box holds, ready to compare: lower case for "contains", as typed for a barcode
export interface Needle {
  text: string;
  barcode: string;
}

export function needleOf(search: string): Needle | null {
  const typed = search.trim();
  return typed === '' ? null : { text: typed.toLowerCase(), barcode: typed };
}

// The archived variants are searched too, their SKUs and their barcodes, like the server's search
// (products.service.ts): the products page finds the same products on the device as it did
// from the server.
export function productRecord(key: string, gen: number, data: Product): ProductRecord {
  const barcodes = [
    ...data.variants.map((variant) => variant.barcode),
    ...data.units.map((unit) => unit.barcode),
  ].filter((code) => code !== null);
  return {
    key,
    gen,
    data,
    sortName: data.name.toLowerCase(),
    sortCode: data.code.toLowerCase(),
    text: searchText([data.name, data.code, ...data.variants.map((variant) => variant.sku)]),
    barcodes: [...new Set(barcodes)],
  };
}

// The server searches the phone as typed (digits have no case); lower case changes nothing in it
export function customerRecord(key: string, gen: number, data: SyncCustomer): CustomerRecord {
  return {
    key,
    gen,
    data,
    sortName: data.name.toLowerCase(),
    text: searchText([data.name, data.code, data.contactPerson, data.phone]),
  };
}

export function productMatches(record: ProductRecord, needle: Needle | null): boolean {
  return (
    needle === null || record.text.includes(needle.text) || record.barcodes.includes(needle.barcode)
  );
}

export function customerMatches(record: CustomerRecord, needle: Needle | null): boolean {
  return needle === null || record.text.includes(needle.text);
}
```

- **The parts are joined with a line break.** A search box cannot hold one, so a search never matches across two
  parts: "Polo shirt" and the code "M-01" do not make "tm-0".
- **`needleOf()` keeps two forms of the search:** lower case for "contains", and as typed for a barcode, which the
  server matches whole and case-sensitively. An empty search is `null`: no filter at all, not "contains an empty
  string", which every row does but costs a check per row.
- **Every barcode and every SKU, archived variants' too,** because the server's search finds them (decision 44). A
  scan of an old variant's label then finds its product on the device as it did on the server.
- **`new Set(barcodes)`**: a pack and a variant may share a code in an imported catalog; one index entry is enough.
- **The customer's phone is in `text` too.** The server compares it "as typed", but digits have no case, so lower
  case changes nothing: "1711" finds 01711-234567 on the device as on the server.

```ts
import type { PullState, SyncDatabase } from './database.js';

export const NO_PULL: PullState = {
  key: 'pull',
  cursor: null,
  generation: 0,
  full: false,
  lastSyncAt: null,
  copied: 0,
};

// Where the pull is. Type imports only: a page reads it (for "1,250 items copied so far") without
// loading Dexie; the database object comes from the code that opened it.
export async function readPullState(db: SyncDatabase): Promise<PullState> {
  return (await db.meta.get('pull')) ?? NO_PULL;
}
```

```ts
// The problem code of a browser that refuses IndexedDB (a private window, a full disk). Not an
// API error code: the server never sends it, so it is not in ERROR_CODES. A file of its own, with
// no imports: the app's pages read it without loading Dexie (see index.ts).
export const STORAGE_FAILED = 'storage_failed';
```

Two files of a few lines each, kept apart on purpose. The app's pages need `readPullState()` (to show "1,250 items
copied so far") and the `storage_failed` code. If they lived in `apply.ts` and `engine.ts`, importing them would bring
those files, and those files bring Dexie. `state.ts` imports `database.ts` for its types only, which TypeScript
removes from the output.

### `apply.ts`: one page into the database

```ts
import type {
  SyncCategory,
  SyncCustomerGroup,
  SyncPriceList,
  SyncPriceListItem,
  SyncPull,
  SyncSettings,
  SyncStock,
  TaxRate,
  Unit,
  Warehouse,
} from '@omnivo/contracts';

import {
  type CustomerRecord,
  type ProductRecord,
  type PullState,
  type Stored,
  type SyncDatabase,
  type SyncTableName,
  TABLE_OF,
} from './database.js';
import { customerRecord, productRecord } from './records.js';
import { readPullState } from './state.js';

// The rows of one page, grouped by table. Typed per table, so a product can only go into
// `products`: one `Record<string, unknown[]>` would need a cast to write them.
interface Writes {
  settings: Stored<SyncSettings>[];
  units: Stored<Unit>[];
  productCategories: Stored<SyncCategory>[];
  taxRates: Stored<TaxRate>[];
  warehouses: Stored<Warehouse>[];
  priceLists: Stored<SyncPriceList>[];
  customerGroups: Stored<SyncCustomerGroup>[];
  products: ProductRecord[];
  priceListItems: Stored<SyncPriceListItem>[];
  customers: CustomerRecord[];
  stock: Stored<SyncStock>[];
}

function emptyWrites(): Writes {
  return {
    settings: [],
    units: [],
    productCategories: [],
    taxRates: [],
    warehouses: [],
    priceLists: [],
    customerGroups: [],
    products: [],
    priceListItems: [],
    customers: [],
    stock: [],
  };
}

function groupChanges(page: SyncPull, gen: number) {
  const puts = emptyWrites();
  const deletes = new Map<SyncTableName, string[]>();
  for (const change of page.changes) {
    if (change.op === 'delete') {
      const table = TABLE_OF[change.entity];
      deletes.set(table, [...(deletes.get(table) ?? []), change.key]);
      continue;
    }
    // A switch on the entity narrows `data` to its own type in each case
    const { key } = change;
    switch (change.entity) {
      case 'settings':
        puts.settings.push({ key, gen, data: change.data });
        break;
      case 'unit':
        puts.units.push({ key, gen, data: change.data });
        break;
      case 'product_category':
        puts.productCategories.push({ key, gen, data: change.data });
        break;
      case 'tax_rate':
        puts.taxRates.push({ key, gen, data: change.data });
        break;
      case 'warehouse':
        puts.warehouses.push({ key, gen, data: change.data });
        break;
      case 'price_list':
        puts.priceLists.push({ key, gen, data: change.data });
        break;
      case 'customer_group':
        puts.customerGroups.push({ key, gen, data: change.data });
        break;
      case 'product':
        puts.products.push(productRecord(key, gen, change.data));
        break;
      case 'price_list_item':
        puts.priceListItems.push({ key, gen, data: change.data });
        break;
      case 'customer':
        puts.customers.push(customerRecord(key, gen, change.data));
        break;
      case 'stock':
        puts.stock.push({ key, gen, data: change.data });
        break;
    }
  }
  return { puts, deletes };
}

// Which generation this page's rows get, and whether it starts a new full pull. A full page
// starts a new generation when the device was not in a full pull, or when it sent no cursor (the
// server started from the beginning, so whatever an earlier full pull wrote does not count).
// Every later page of that full pull writes the same generation.
function nextState(state: PullState, page: SyncPull, sentCursor: string | null): PullState {
  const starts = page.full && (!state.full || sentCursor === null);
  const generation = starts ? state.generation + 1 : state.generation;
  const upserts = page.changes.filter((change) => change.op === 'upsert').length;
  return {
    key: 'pull',
    cursor: page.cursor,
    generation,
    // A delta page while a full pull was open cannot happen (the server answers a full pull's
    // cursor with full pages); if it ever does, the full pull is given up, and the next one
    // starts a new generation that sweeps whatever this one left.
    full: page.full && page.hasMore,
    lastSyncAt: page.hasMore ? state.lastSyncAt : page.serverTime,
    copied: starts ? upserts : page.full ? state.copied + upserts : state.copied,
  };
}

// One page into the database, in one transaction: the rows, the deletes and the cursor are
// saved together or not at all. A tab closed half way through a page leaves the old cursor, and
// the same page comes again; its upserts and deletes give the same result twice.
export async function applyPage(
  db: SyncDatabase,
  page: SyncPull,
  sentCursor: string | null,
): Promise<PullState> {
  return db.transaction('rw', [...db.syncTables(), db.meta], async () => {
    const state = nextState(await readPullState(db), page, sentCursor);
    const { puts, deletes } = groupChanges(page, state.generation);
    for (const [table, keys] of deletes) await db[table].bulkDelete(keys);
    // A key is in a page at most once (the contract), so no row is both put and deleted here
    await db.settings.bulkPut(puts.settings);
    await db.units.bulkPut(puts.units);
    await db.productCategories.bulkPut(puts.productCategories);
    await db.taxRates.bulkPut(puts.taxRates);
    await db.warehouses.bulkPut(puts.warehouses);
    await db.priceLists.bulkPut(puts.priceLists);
    await db.customerGroups.bulkPut(puts.customerGroups);
    await db.products.bulkPut(puts.products);
    await db.priceListItems.bulkPut(puts.priceListItems);
    await db.customers.bulkPut(puts.customers);
    await db.stock.bulkPut(puts.stock);
    // The last page of a full pull: every row it did not send is older than its generation, and
    // goes (decision 17). Until now, the lists kept showing them.
    if (page.full && !page.hasMore) {
      for (const table of db.syncTables()) {
        await table.where('gen').below(state.generation).delete();
      }
    }
    await db.meta.put(state);
    return state;
  });
}
```

- **One transaction for the whole page:** the deletes, the puts, the sweep and the cursor. If the tab closes in the
  middle, IndexedDB rolls all of it back, the old cursor stays, and the same page comes again. Its upserts and
  deletes give the same result twice (the spec "a page applied twice" checks it).
- **`Writes` has one typed array per table,** filled by a `switch` on the entity. The `switch` narrows `change.data`
  to that entity's row, so a product can only be pushed to `products`. One `Record<string, unknown[]>` and
  `db.table(name)` would have needed a cast, which CLAUDE.md does not allow.
- **`bulkPut` and `bulkDelete`, grouped by table,** instead of one `put()` per change. A page of 500 products is one
  request to IndexedDB, not 500. Grouping changes the order of the writes, and that is safe: a key is in a page at most
  once (the contract), so no row is both put and deleted in one page.
- **`nextState()` decides the generation (decision 46).** A full page starts a new one when the device was not in a
  full pull, or when it sent no cursor: then the server started from the beginning, and what an earlier, unfinished
  full pull wrote must not count. Every later page of the same full pull keeps the number, so a pull resumed after a
  reload still counts the rows of its first pages.
- **A delta page writes the current generation too,** so the next full pull still sweeps a row a delta wrote, if the
  server no longer has it.
- **`full: page.full && page.hasMore`** is true only while a full pull is open. The comment covers the one case that
  should never happen (a delta page while a full pull is open): the full pull is given up, and the next one's new
  generation sweeps whatever it left.
- **`lastSyncAt` changes only on a last page, to `serverTime`** (decision 19): the server's clock, never the device's.
  Until the first pull ends it stays `null`, which is how the pages know the copy is not complete yet.
- **`copied`** counts the upserts of the running full pull. It is in the database, not in memory, so the count also
  shows in a second tab, and goes on after a reload.
- **The sweep runs on the last full page, after the puts:** `where('gen').below(generation).delete()`. Until then,
  the lists keep showing what the device had (decision 17).

### `engine.ts`: the pull loop

```ts
import { SYNC_PROTOCOL, type SyncPull, type SyncPullQuery } from '@omnivo/contracts';
import { Dexie } from 'dexie';

import { applyPage } from './apply.js';
import type { SyncDatabase } from './database.js';
import { STORAGE_FAILED } from './problems.js';
import { readPullState } from './state.js';

// After these, pulling again cannot help until the page is reloaded (a new app version) or the
// device is set up again
const FINAL_PROBLEMS: ReadonlySet<string> = new Set([
  'sync_protocol_mismatch',
  'device_revoked',
  'device_not_found',
]);

export interface SyncStatus {
  // A pull is running in this tab
  pulling: boolean;
  // Why the last pull stopped, as an error code (network_error, storage_failed, …); null = the
  // last pull finished
  problem: string | null;
  // The engine pulls no more (decision 18's reload, a revoked device)
  stopped: boolean;
}

// Runs fn while no other tab of this browser pulls into the same database. Two tabs pulling at
// once would interleave their pages and cursors. Web Locks by default (like the token refresh in
// the app's api.ts); a test passes its own.
export type LockRunner = (name: string, fn: () => Promise<void>) => Promise<void>;

const webLock: LockRunner = async (name, fn) => {
  await navigator.locks.request(name, fn);
};

export interface SyncEngineOptions {
  db: SyncDatabase;
  deviceId: string;
  // The app's API call (routes.sync.pull). The engine knows nothing of tokens or the API's url.
  pull: (query: SyncPullQuery) => Promise<SyncPull>;
  // The error code of a failed call (the app's ApiRequestError.code), or null for anything else
  codeOf: (error: unknown) => string | null;
  // device_not_found: the server does not know this device (its database was restored from an
  // older backup, or the registration was lost). The app registers it again with the same id and
  // branch; then the engine tries once more.
  registerAgain: () => Promise<void>;
  // device_revoked: the app deletes the local data (decision 7)
  onRevoked: () => void;
  pageSize?: number;
  intervalMs?: number;
  lock?: LockRunner;
}

const IDLE: SyncStatus = { pulling: false, problem: null, stopped: false };

// The pull loop of one device: one pull at a time, each page applied before the next is asked
// for. Framework-free; the app reads its status with useSyncExternalStore.
export class SyncEngine {
  private status: SyncStatus = IDLE;
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  // Counts the pulls asked for while one ran
  private asks = 0;
  private ended = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private detach: (() => void) | null = null;

  constructor(private readonly options: SyncEngineOptions) {}

  // Arrow functions: React calls them without `this`
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getStatus = (): SyncStatus => this.status;

  // A pull now, and on every wake-up: the connection coming back, the window getting the focus
  // again, a tab coming back to the front, and every minute while online and in front
  start(): void {
    const wake = () => {
      this.request();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') this.request();
    };
    const tick = setInterval(() => {
      // A tab in the background does not pull: its lists are not on screen, and it pulls when it
      // comes back. Ten tabs left open would otherwise ask the server ten times a minute.
      if (navigator.onLine && document.visibilityState === 'visible') this.request();
    }, this.options.intervalMs ?? 60_000);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', visible);
    this.detach = () => {
      clearInterval(tick);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', visible);
    };
    void this.pullNow();
  }

  // The session ended (sign-out, another workspace). A page being applied finishes; no more.
  stop(): void {
    this.ended = true;
    this.detach?.();
    this.detach = null;
    if (this.debounce !== null) clearTimeout(this.debounce);
  }

  // A pull soon: the focus and visibility events of one tab switch, and the saves of one form,
  // come within milliseconds of each other and make one pull
  request(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.pullNow();
    }, 300);
  }

  // One pull at a time. Asked while one runs, it runs once more after it: the change that made
  // someone ask may have committed after the running pull read its watermark.
  pullNow(): Promise<void> {
    if (this.ended || this.status.stopped) return Promise.resolve();
    if (this.running) {
      this.asks += 1;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    let asked: number;
    do {
      asked = this.asks;
      await this.runOnce();
    } while (this.asks !== asked && !this.ended && !this.status.stopped);
  }

  private async runOnce(): Promise<void> {
    this.set({ ...this.status, pulling: true });
    let problem: string | null = null;
    try {
      const lock = this.options.lock ?? webLock;
      await lock(`omnivo-sync:${this.options.db.name}`, () => this.pullWithRetry());
    } catch (error) {
      problem = this.problemOf(error);
    }
    if (this.ended) return;
    if (problem === 'device_revoked') this.options.onRevoked();
    this.set({
      pulling: false,
      problem,
      stopped: problem !== null && FINAL_PROBLEMS.has(problem),
    });
  }

  private async pullWithRetry(): Promise<void> {
    try {
      await this.pullAll();
    } catch (error) {
      if (this.options.codeOf(error) !== 'device_not_found') throw error;
      await this.options.registerAgain();
      await this.pullAll();
    }
  }

  // Pages until hasMore is false. The cursor is read from the database, not kept in memory:
  // another tab may have pulled since, and it saved its own cursor there.
  private async pullAll(): Promise<void> {
    const { db, deviceId, pageSize = 500 } = this.options;
    let cursor = (await readPullState(db)).cursor;
    for (;;) {
      if (this.ended) return;
      const page = await this.options.pull({
        deviceId,
        protocol: SYNC_PROTOCOL,
        limit: pageSize,
        ...(cursor !== null && { cursor }),
      });
      await applyPage(db, page, cursor);
      if (!page.hasMore) return;
      cursor = page.cursor;
    }
  }

  private problemOf(error: unknown): string {
    const code = this.options.codeOf(error);
    if (code !== null) return code;
    // IndexedDB refused a write or an open: Dexie wraps every such failure in its own errors
    if (error instanceof Dexie.DexieError) return STORAGE_FAILED;
    return 'unknown_error';
  }

  private set(next: SyncStatus): void {
    this.status = next;
    for (const listener of this.listeners) listener();
  }
}
```

- **The engine knows nothing of the API.** It gets `pull` (the app's `call(routes.sync.pull)`), `codeOf` (the error
  code of a failed call) and two callbacks. The token, the refresh on a 401 and the API's address stay in `api.ts`,
  and the tests pass plain functions.
- **`FINAL_PROBLEMS` stop the engine.** After a protocol mismatch, a revoked device, or a `device_not_found` that a
  new registration did not fix, pulling again every minute only fills the server's log with refusals.
- **`subscribe` and `getStatus` are arrow functions** because React's `useSyncExternalStore` calls them without
  `this`. `set()` always makes a new status object, which is how `useSyncExternalStore` sees a change.
- **`start()`: the wake-ups.** `online` (the connection came back), `focus` (the person came back to the window),
  `visibilitychange` (a tab came back to the front), and a timer. **The timer skips a tab in the background**
  (decision 45): ten tabs left open would otherwise ask the server ten times a minute.
- **`request()` waits 300 ms.** Switching to a tab fires `focus` and `visibilitychange` together, and a form may make
  two saves in a row; each burst makes one pull.
- **`pullNow()`: one at a time, and one more after.** A pull asked for while one runs adds one to `asks`; when the
  run ends with `asks` changed, the loop runs once more. The change that made someone ask may have committed after the
  running pull read its watermark, so returning the running pull alone could miss it for a minute. A counter, not a
  boolean: TypeScript narrows a boolean set to `false` before an `await` and calls the later check always false.
- **The Web Lock is per database** (decision 45). `navigator.locks.request()` waits, it does not skip: the other tab
  may have started its pull before this tab's save, and this tab's pull after it brings the save.
- **`pullWithRetry()`**: on `device_not_found`, the app registers the same id again and the engine pulls once more.
  Once: if the registration fails, that error is the problem.
- **`pullAll()` reads the cursor from the database on each run,** never from memory: another tab may have pulled
  since and saved a newer cursor. The `ended` check before each page makes a sign-out stop the loop between pages.
- **`problemOf()`: `Dexie.DexieError` is `storage_failed`.** A full disk or a refusing browser fails in IndexedDB,
  and the pages say so with their own text (`sync.storageFailed*`). Anything else that is not an API error is
  `unknown_error`, never a crash of the loop.
- **A pull keeps its last problem while it runs** (`{ ...this.status, pulling: true }`), so the page does not flash
  from "Couldn't copy" to "Copying" and back on every retry.

### `live.ts`, `device.ts`

```ts
import { liveQuery } from 'dexie';

// Runs a read and runs it again whenever a write (a pull, in this tab or another) changes what it
// read: Dexie's liveQuery. The app's hook (useLocalQuery) gets this function from the code that
// opened the database, so its pages never import Dexie themselves.
export type Watch = <T>(
  query: () => Promise<T>,
  next: (value: T) => void,
  fail: (error: unknown) => void,
) => () => void;

export const watch: Watch = (query, next, fail) => {
  const subscription = liveQuery(query).subscribe({ next, error: fail });
  return () => {
    subscription.unsubscribe();
  };
};
```

`watch()` wraps Dexie's `liveQuery`: the read runs, Dexie notes which tables and ranges it read, and it runs again
when a write touches them, in this tab or another. It is a function the session hands to the pages through the store
(decision 42), so the pages never import Dexie. `Watch` is a generic function type, so one `watch` serves every read
with its own result type.

```ts
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

// This browser as a device of one person in one workspace (decision 7). Kept in localStorage, not
// in the local database: signing out deletes the database (the data is the workspace's), but the
// browser stays the same device, so the next sign-in does not register a second one.
export interface DeviceIdentity {
  // Made here, a UUIDv7 like every id (decision 20)
  id: string;
  // The branch it was registered in. null = not registered yet.
  branchId: string | null;
  // The person pressed "Not now" in the branch dialog (decision 40): do not ask again by itself
  later: boolean;
}

// What another version of the app (or a person in the browser's tools) may have left there is
// checked, not trusted: a broken value gives a new identity, never a crash
const identitySchema = z.object({
  id: z.uuidv7(),
  branchId: z.uuid().nullable(),
  later: z.boolean(),
});

function storageKey(tenantId: string, userId: string): string {
  return `omnivo.device.${tenantId}.${userId}`;
}

// A storage that can refuse: Safari in a private window throws on setItem, and a page may be
// opened where localStorage is turned off
export type IdentityStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readDevice(
  storage: IdentityStorage | null,
  tenantId: string,
  userId: string,
): DeviceIdentity {
  try {
    const saved = storage?.getItem(storageKey(tenantId, userId));
    if (saved !== null && saved !== undefined) {
      const parsed = identitySchema.safeParse(JSON.parse(saved));
      if (parsed.success) return parsed.data;
    }
  } catch {
    // Unreadable or not JSON: a new identity below
  }
  return { id: uuidv7(), branchId: null, later: false };
}

// false = not saved (the storage refused). The app keeps the identity in memory for this visit;
// the next visit registers again with a new id, which is only an extra row in the device list.
export function saveDevice(
  storage: IdentityStorage | null,
  tenantId: string,
  userId: string,
  identity: DeviceIdentity,
): boolean {
  try {
    storage?.setItem(storageKey(tenantId, userId), JSON.stringify(identity));
    return storage !== null;
  } catch {
    return false;
  }
}

export function newDeviceId(): string {
  return uuidv7();
}

// "Chrome" and "Windows" for the name a device gets without a question (decision 12). The app
// puts them into devices.defaultName in the person's language. The order matters: Edge, Opera
// and Samsung Internet also say "Chrome" in their user agent, and Chrome also says "Safari".
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Version\/.*Safari\//, 'Safari'],
];

// Android before Linux (an Android user agent says both), iPhone and iPad before Mac OS X
const SYSTEMS: readonly [RegExp, string][] = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

// null when either is unknown: the app then uses devices.fallbackName ("Web browser")
export function deviceNameParts(userAgent: string): { browser: string; os: string } | null {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return browser === undefined || os === undefined ? null : { browser, os };
}
```

- **In `localStorage`, not in the database,** because signing out deletes the database (decision 41) and the device
  must stay the same device.
- **`identitySchema.safeParse(JSON.parse(saved))`**: what is in `localStorage` may come from an older app, or be
  edited by hand. A broken value gives a new identity; it never throws into the AppShell.
- **`IdentityStorage`** is the two methods used, so a test passes a `Map`. Both calls are in `try`: Safari in a private
  window throws on `setItem`. `saveDevice()` then answers `false`, and the app goes on with the identity in memory.
- **`later`** is decision 40's "Not now", kept per device: the dialog does not come back by itself on the next visit.
- **The browser and system lists are ordered.** Edge, Opera and Samsung Internet also say "Chrome" in their user
  agent, and Chrome says "Safari"; Android also says "Linux", and an iPhone says "like Mac OS X". The first match wins,
  so the specific names come first. `null` for an unknown one: the app uses `devices.fallbackName`.

### `queries.ts` and `index.ts`

```ts
import {
  compareMoney,
  type CustomerSort,
  type CustomerSummary,
  type Product,
  type ProductSort,
  type ProductSummary,
  type SyncCustomer,
} from '@omnivo/contracts';

import type { Table } from 'dexie';

import type { CustomerRecord, ProductRecord, Stored, SyncDatabase } from './database.js';
import { customerMatches, needleOf, productMatches } from './records.js';

// The reads of the products and customers pages and of the pickers. Each is a plain async
// function of the database, so the app runs it inside Dexie's liveQuery (useLiveQuery), and it
// runs again by itself when a pull writes to the tables it read.

// What a list shows: the first `limit` rows in order, and whether there are more. The page asks
// for more as the person scrolls (the DataTable's onEndReached), like a server page.
export interface LocalPage<T> {
  rows: T[];
  more: boolean;
}

// The sorts the device keeps an index for. '-updated' is the server's only.
export type LocalProductSort = Exclude<ProductSort, '-updated'>;
export type LocalCustomerSort = Extract<CustomerSort, 'name' | '-name'>;

export interface LocalProductFilter {
  search: string;
  // The category and every category under it, like the server; null = every product
  categoryIds: ReadonlySet<string> | null;
  sort: LocalProductSort;
  limit: number;
}

// The index walks the rows in order and the filter stops once it has limit + 1 matches: the first
// screen of a long list costs as much as one screen, not the whole table. Two rows with the same
// name come in key (id) order, like the server's (lower(name), id).
export async function productPage(
  db: SyncDatabase,
  filter: LocalProductFilter,
): Promise<LocalPage<Product>> {
  const needle = needleOf(filter.search);
  const index = filter.sort === 'code' || filter.sort === '-code' ? 'sortCode' : 'sortName';
  const ordered = db.products.orderBy(index);
  const found = await (filter.sort.startsWith('-') ? ordered.reverse() : ordered)
    .filter(
      (record: ProductRecord) =>
        (filter.categoryIds === null ||
          (record.data.categoryId !== null && filter.categoryIds.has(record.data.categoryId))) &&
        productMatches(record, needle),
    )
    .limit(filter.limit + 1)
    .toArray();
  return {
    rows: found.slice(0, filter.limit).map((record) => record.data),
    more: found.length > filter.limit,
  };
}

export interface LocalCustomerFilter {
  search: string;
  // '' = every group
  groupId: string;
  sort: LocalCustomerSort;
  limit: number;
}

export async function customerPage(
  db: SyncDatabase,
  filter: LocalCustomerFilter,
): Promise<LocalPage<SyncCustomer>> {
  const needle = needleOf(filter.search);
  const ordered = db.customers.orderBy('sortName');
  const found = await (filter.sort === '-name' ? ordered.reverse() : ordered)
    .filter(
      (record: CustomerRecord) =>
        (filter.groupId === '' || record.data.groupId === filter.groupId) &&
        customerMatches(record, needle),
    )
    .limit(filter.limit + 1)
    .toArray();
  return {
    rows: found.slice(0, filter.limit).map((record) => record.data),
    more: found.length > filter.limit,
  };
}

// The pickers: the first 20 that match, by name, like the server's search
export const PICKER_LIMIT = 20;

export async function findProducts(db: SyncDatabase, search: string): Promise<Product[]> {
  const page = await productPage(db, {
    search,
    categoryIds: null,
    sort: 'name',
    limit: PICKER_LIMIT,
  });
  return page.rows;
}

export async function findCustomers(db: SyncDatabase, search: string): Promise<SyncCustomer[]> {
  const page = await customerPage(db, { search, groupId: '', sort: 'name', limit: PICKER_LIMIT });
  return page.rows;
}

// A small table whole, as the server's rows (units, categories, groups: tens of rows)
export async function allRows<T>(table: Table<Stored<T>, string>): Promise<T[]> {
  return (await table.toArray()).map((record) => record.data);
}

// The list's row from the whole product, the way the server's list works it out
// (products.service.ts): the active variants only, their lowest and highest sale price
export function productSummaryOf(product: Product): ProductSummary {
  const active = product.variants.filter((variant) => variant.archivedAt === null);
  const prices = active
    .map((variant) => variant.salePrice)
    .filter((price) => price !== null)
    .sort(compareMoney);
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    type: product.type,
    categoryId: product.categoryId,
    baseUnitId: product.baseUnitId,
    tracking: product.tracking,
    hasVariants: product.options.length > 0,
    variantCount: active.length,
    minPrice: prices[0] ?? null,
    maxPrice: prices.at(-1) ?? null,
    archivedAt: product.archivedAt,
    updatedAt: product.updatedAt,
  };
}

// The balance is not on the device (decision 10): null here, filled in by the page when it can
export function customerSummaryOf(customer: SyncCustomer): CustomerSummary {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.name,
    groupId: customer.groupId,
    contactPerson: customer.contactPerson,
    phone: customer.phone,
    paymentTermsDays: customer.paymentTermsDays,
    creditLimit: customer.creditLimit,
    balance: null,
    archivedAt: customer.archivedAt,
    updatedAt: customer.updatedAt,
  };
}
```

- **Plain async functions of the database.** They know nothing of React; the app runs them through `watch`, and the
  specs call them directly.
- **`orderBy(index)`, then `.filter()`, then `.limit(limit + 1)`** (decision 44). Dexie walks the index in order and
  stops after `limit + 1` matches, so the first screen of a long list costs about one screen. The extra row says
  whether there is more, like the server's `limit + 1`.
- **Equal names come in key order,** because IndexedDB orders equal index entries by their primary key, the id.
  That is the server's `(lower(name), id)`.
- **`categoryIds` is a set the page works out** (the category and everything under it, like the server). The query
  does not read the categories table itself, so it stays one read of one table.
- **`LocalProductSort` leaves out `'-updated'`**: the device has no index for it, and no page offers it.
- **`allRows()` takes Dexie's `Table` type,** so TypeScript infers the row type from the table. A looser
  `{ toArray(): Promise<...> }` parameter did not infer through Dexie's overloaded `toArray`.
- **`productSummaryOf()` works out the list's row the way the server does:** the active variants only, their lowest
  and highest price, `hasVariants` from the options. The products page keeps its columns unchanged.
- **`customerSummaryOf()` sets `balance: null`.** The page fills it in from the server (decision 10).

```ts
// Two kinds of module. The pages of the app import the reads (queries, records, state, problems)
// and the types: none of them loads Dexie at run time, so a page that searches customers stays
// small. The code that opens the database and pulls (database, apply, engine, live, device)
// brings Dexie, and the app loads it once, lazily, after sign-in. `sideEffects: false` in
// package.json lets the bundler leave out the modules a chunk does not use.
export { applyPage } from './apply.js';
export {
  type CustomerRecord,
  databaseName,
  deleteLocalDatabase,
  type ProductRecord,
  type PullState,
  type Stored,
  SyncDatabase,
  type SyncTableName,
  TABLE_OF,
} from './database.js';
export {
  type DeviceIdentity,
  deviceNameParts,
  type IdentityStorage,
  newDeviceId,
  readDevice,
  saveDevice,
} from './device.js';
export { type LockRunner, SyncEngine, type SyncEngineOptions, type SyncStatus } from './engine.js';
export { type Watch, watch } from './live.js';
export { STORAGE_FAILED } from './problems.js';
export {
  allRows,
  customerPage,
  customerSummaryOf,
  findCustomers,
  findProducts,
  type LocalCustomerFilter,
  type LocalCustomerSort,
  type LocalPage,
  type LocalProductFilter,
  type LocalProductSort,
  PICKER_LIMIT,
  productPage,
  productSummaryOf,
} from './queries.js';
export { customerRecord, productRecord, searchText } from './records.js';
export { NO_PULL, readPullState } from './state.js';
```

The comment at the top is the rule of the package: the reads load no Dexie; the rest does. A new export that a page
needs must come from a file without a Dexie import, or the pages grow by 30 KB without a warning other than the
budget check.

### The tests

```ts
import type { Product, SyncChange, SyncCustomer, SyncPull } from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import { SyncDatabase } from './database.js';

// Rows and pages for the specs. Not built into dist (tsconfig.build.json leaves it out).

const UPDATED = '2026-10-21T04:00:00.000Z';

export function newDatabase(): SyncDatabase {
  // A name of its own per test: fake-indexeddb keeps every database of the process in memory
  return new SyncDatabase(`test-${uuidv7()}`);
}

export function product(fields: Partial<Product> & Pick<Product, 'name'>): Product {
  const id = fields.id ?? uuidv7();
  return {
    id,
    code: 'P-0001',
    type: 'goods',
    categoryId: null,
    description: null,
    baseUnitId: '01928c4e-0000-7000-8000-000000000001',
    salesUnitId: null,
    purchaseUnitId: null,
    tracking: 'none',
    hasExpiry: false,
    taxRateId: null,
    options: [],
    variants: [
      {
        id: uuidv7(),
        sku: fields.code ?? 'P-0001',
        optionValues: [],
        barcode: null,
        salePrice: null,
        archivedAt: null,
      },
    ],
    units: [],
    customFields: {},
    archivedAt: null,
    version: 1,
    updatedAt: UPDATED,
    ...fields,
  };
}

export function customer(fields: Partial<SyncCustomer> & Pick<SyncCustomer, 'name'>): SyncCustomer {
  return {
    id: fields.id ?? uuidv7(),
    code: 'C-00001',
    groupId: null,
    contactPerson: null,
    phone: null,
    email: null,
    documentLanguage: 'en',
    bin: null,
    paymentTermsDays: 0,
    creditLimit: null,
    priceListId: null,
    notes: null,
    addresses: [],
    isSupplier: false,
    archivedAt: null,
    version: 1,
    updatedAt: UPDATED,
    ...fields,
  };
}

export function upsertProduct(row: Product): SyncChange {
  return { op: 'upsert', entity: 'product', key: row.id, data: row };
}

export function upsertCustomer(row: SyncCustomer): SyncChange {
  return { op: 'upsert', entity: 'customer', key: row.id, data: row };
}

export function page(fields: Partial<SyncPull> & Pick<SyncPull, 'changes'>): SyncPull {
  return {
    cursor: `cursor-${uuidv7()}`,
    hasMore: false,
    full: false,
    serverTime: '2026-10-21T04:30:00.000Z',
    ...fields,
  };
}
```

`newDatabase()` gives every test a database of its own name: `fake-indexeddb` keeps every database of the process in
memory, and two tests sharing one would see each other's rows. The builders fill every field of a product and a
customer, so a test names only what it is about.

```ts
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import { readPullState } from './state.js';
import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';

const shirt = product({ name: 'Polo shirt', code: 'FG-0001' });
const trouser = product({ name: 'Chino trouser', code: 'FG-0002' });
const jacket = product({ name: 'Denim jacket', code: 'FG-0003' });

async function keys(db: ReturnType<typeof newDatabase>): Promise<string[]> {
  return (await db.products.toArray()).map((record) => record.key).sort();
}

describe('applyPage', () => {
  it('keeps what the device had until the last page of a full pull, then drops what it did not send', async () => {
    const db = newDatabase();
    await applyPage(
      db,
      page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] }),
      null,
    );
    expect(await keys(db)).toEqual([shirt.id, trouser.id].sort());

    // A later full pull (a resync) that no longer has the trouser: two pages
    const first = page({ full: true, hasMore: true, changes: [upsertProduct(jacket)] });
    await applyPage(db, first, null);
    // Half way: the trouser is still there, so the list does not shrink while the pull runs
    expect(await keys(db)).toEqual([shirt.id, trouser.id, jacket.id].sort());
    expect((await readPullState(db)).full).toBe(true);

    await applyPage(db, page({ full: true, changes: [upsertProduct(shirt)] }), first.cursor);
    expect(await keys(db)).toEqual([shirt.id, jacket.id].sort());
    const state = await readPullState(db);
    expect(state.full).toBe(false);
    expect(state.copied).toBe(2);
  });

  it('applies a delta: upserts replace, deletes remove, nothing else is touched', async () => {
    const db = newDatabase();
    const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
    await applyPage(db, full, null);
    const renamed = { ...shirt, name: 'Polo shirt (piqué)', version: 2 };
    await applyPage(
      db,
      page({
        changes: [
          upsertProduct(renamed),
          { op: 'delete', entity: 'product', key: trouser.id },
          // A delete of a row the device never had is harmless (decision 27)
          { op: 'delete', entity: 'stock', key: 'not-here' },
        ],
      }),
      full.cursor,
    );
    const rows = await db.products.toArray();
    expect(rows.map((record) => record.data)).toEqual([renamed]);
    expect(rows[0]?.sortName).toBe('polo shirt (piqué)');
  });

  it('a delta upsert keeps the generation, so the next full pull still sweeps it', async () => {
    const db = newDatabase();
    const full = page({ full: true, changes: [upsertProduct(shirt)] });
    await applyPage(db, full, null);
    await applyPage(db, page({ changes: [upsertProduct(trouser)] }), full.cursor);
    // A resync without the trouser removes it, though a delta wrote it
    await applyPage(db, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    expect(await keys(db)).toEqual([shirt.id]);
  });

  it('a full pull resumed after a reload continues its generation', async () => {
    const db = newDatabase();
    await applyPage(db, page({ full: true, changes: [upsertProduct(trouser)] }), null);
    const first = page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] });
    await applyPage(db, first, null);
    // The tab closed; the next start sends the saved cursor and the server goes on
    const { cursor } = await readPullState(db);
    expect(cursor).toBe(first.cursor);
    await applyPage(db, page({ full: true, changes: [upsertProduct(jacket)] }), cursor);
    // The shirt of the first page counts: it was sent by this full pull
    expect(await keys(db)).toEqual([shirt.id, jacket.id].sort());
  });

  it('a pull sent without a cursor starts over, even in the middle of a full pull', async () => {
    const db = newDatabase();
    // A full pull stops half way (its first page had the shirt)
    await applyPage(db, page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] }), null);
    // The device starts from the beginning (a cursor the server refused, 18c's "sync again");
    // the server no longer has the shirt, so the shirt of the old half must not count
    await applyPage(db, page({ full: true, changes: [upsertProduct(jacket)] }), null);
    expect(await keys(db)).toEqual([jacket.id]);
  });

  it('a page applied twice gives the same result', async () => {
    const db = newDatabase();
    const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
    await applyPage(db, full, null);
    const delta = page({ changes: [{ op: 'delete', entity: 'product', key: shirt.id }] });
    await applyPage(db, delta, full.cursor);
    await applyPage(db, delta, full.cursor);
    expect(await keys(db)).toEqual([trouser.id]);
  });

  it('sets the last sync only when a pull ends, from the server clock', async () => {
    const db = newDatabase();
    const first = page({
      full: true,
      hasMore: true,
      changes: [],
      serverTime: '2026-10-21T04:00:00.000Z',
    });
    await applyPage(db, first, null);
    expect((await readPullState(db)).lastSyncAt).toBeNull();
    await applyPage(
      db,
      page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
      first.cursor,
    );
    expect((await readPullState(db)).lastSyncAt).toBe('2026-10-21T04:00:05.000Z');
  });

  it('keeps the price and the stock keys the server sends', async () => {
    const db = newDatabase();
    const priceKey = `${shirt.id}:${shirt.variants[0]?.id ?? ''}:${shirt.baseUnitId}`;
    await applyPage(
      db,
      page({
        full: true,
        changes: [
          {
            op: 'upsert',
            entity: 'price_list_item',
            key: priceKey,
            data: {
              priceListId: shirt.id,
              productId: shirt.id,
              variantId: shirt.variants[0]?.id ?? '',
              unitId: shirt.baseUnitId,
              price: '450.0000',
              updatedAt: shirt.updatedAt,
            },
          },
        ],
      }),
      null,
    );
    expect((await db.priceListItems.get(priceKey))?.data.price).toBe('450.0000');
  });
});
```

- `import 'fake-indexeddb/auto'` first: it puts `indexedDB` on `globalThis`, where Dexie looks for it.
- The first test is decision 17 itself: after the first page of a resync, the trouser that the server no longer has
  is still there; after the last page, it is gone.
- "A pull sent without a cursor starts over" keeps the second half of `nextState()`'s rule. Without it, the shirt of
  an unfinished full pull would survive a new full pull that no longer has it.

```ts
import 'fake-indexeddb/auto';

import type { SyncPull, SyncPullQuery } from '@omnivo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { readPullState } from './state.js';
import { SyncEngine, type SyncEngineOptions } from './engine.js';
import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';

// An API error the way the app's ApiRequestError carries it
class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const codeOf = (error: unknown) => (error instanceof CodedError ? error.code : null);
const DEVICE = '01928c4e-1111-7000-8000-000000000001';

function engineWith(
  pull: (query: SyncPullQuery) => Promise<SyncPull>,
  options: Partial<SyncEngineOptions> = {},
) {
  const db = newDatabase();
  const engine = new SyncEngine({
    db,
    deviceId: DEVICE,
    pull,
    codeOf,
    registerAgain: () => Promise.resolve(),
    onRevoked: () => undefined,
    ...options,
  });
  return { db, engine };
}

describe('SyncEngine', () => {
  it('asks page after page with the last cursor until hasMore is false', async () => {
    const pages = [
      page({
        full: true,
        hasMore: true,
        cursor: 'a',
        changes: [upsertProduct(product({ name: 'Paracetamol 500' }))],
      }),
      page({
        full: true,
        hasMore: false,
        cursor: 'b',
        changes: [upsertProduct(product({ name: 'Omeprazole 20' }))],
      }),
    ];
    const pull = vi.fn<(query: SyncPullQuery) => Promise<SyncPull>>(() =>
      Promise.resolve(pages.shift() ?? page({ changes: [] })),
    );
    const { db, engine } = engineWith(pull);
    await engine.pullNow();
    expect(pull.mock.calls.map(([query]) => query.cursor)).toEqual([undefined, 'a']);
    expect(pull.mock.calls[0]?.[0]).toMatchObject({ deviceId: DEVICE, protocol: 1, limit: 500 });
    expect(await db.products.count()).toBe(2);
    expect((await readPullState(db)).cursor).toBe('b');
    // The next pull starts from the saved cursor
    await engine.pullNow();
    expect(pull.mock.calls.at(-1)?.[0].cursor).toBe('b');
    expect(engine.getStatus()).toEqual({ pulling: false, problem: null, stopped: false });
  });

  it('runs one pull at a time, and once more when asked during one', async () => {
    let release: () => void = () => undefined;
    const pull = vi.fn(
      () =>
        new Promise<SyncPull>((resolve) => {
          release = () => {
            resolve(page({ changes: [] }));
          };
        }),
    );
    const { engine } = engineWith(pull);
    const first = engine.pullNow();
    const second = engine.pullNow();
    const third = engine.pullNow();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await vi.waitFor(() => {
      expect(pull).toHaveBeenCalledTimes(1);
    });
    release();
    // The asks made during the first run are one more run, not two
    await vi.waitFor(() => {
      expect(pull).toHaveBeenCalledTimes(2);
    });
    release();
    await first;
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('registers again on device_not_found and pulls once more', async () => {
    const pull = vi
      .fn<(query: SyncPullQuery) => Promise<SyncPull>>()
      .mockRejectedValueOnce(new CodedError('device_not_found'))
      .mockResolvedValueOnce(page({ changes: [] }));
    const registerAgain = vi.fn(() => Promise.resolve());
    const { engine } = engineWith(pull, { registerAgain });
    await engine.pullNow();
    expect(registerAgain).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(engine.getStatus().problem).toBeNull();
  });

  it('stops for good on device_revoked and tells the app', async () => {
    const pull = vi.fn(() => Promise.reject(new CodedError('device_revoked')));
    const onRevoked = vi.fn();
    const { engine } = engineWith(pull, { onRevoked });
    await engine.pullNow();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(engine.getStatus()).toEqual({
      pulling: false,
      problem: 'device_revoked',
      stopped: true,
    });
    await engine.pullNow();
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('stops on sync_protocol_mismatch: only a reload helps', async () => {
    const pull = vi.fn(() => Promise.reject(new CodedError('sync_protocol_mismatch')));
    const { engine } = engineWith(pull);
    await engine.pullNow();
    expect(engine.getStatus()).toMatchObject({ problem: 'sync_protocol_mismatch', stopped: true });
  });

  it('keeps going after a network error, and keeps the pages it had', async () => {
    const pull = vi
      .fn<(query: SyncPullQuery) => Promise<SyncPull>>()
      .mockResolvedValueOnce(
        page({
          full: true,
          hasMore: true,
          cursor: 'a',
          changes: [upsertProduct(product({ name: 'Rice 50 kg sack' }))],
        }),
      )
      .mockRejectedValueOnce(new CodedError('network_error'))
      .mockResolvedValueOnce(page({ full: true, cursor: 'b', changes: [] }));
    const { db, engine } = engineWith(pull);
    await engine.pullNow();
    expect(engine.getStatus()).toEqual({
      pulling: false,
      problem: 'network_error',
      stopped: false,
    });
    // The first page is saved with its cursor, so the next pull goes on from there
    expect(await db.products.count()).toBe(1);
    await engine.pullNow();
    expect(pull.mock.calls.at(-1)?.[0].cursor).toBe('a');
    expect(engine.getStatus().problem).toBeNull();
  });

  it('an error that is not the API’s is unknown_error', async () => {
    const { engine } = engineWith(() => Promise.reject(new TypeError('boom')));
    await engine.pullNow();
    expect(engine.getStatus().problem).toBe('unknown_error');
  });

  it('pulls no more after stop()', async () => {
    const pull = vi.fn(() => Promise.resolve(page({ changes: [] })));
    const { engine } = engineWith(pull);
    engine.stop();
    await engine.pullNow();
    expect(pull).not.toHaveBeenCalled();
  });

  it('tells its listeners when the status changes', async () => {
    const { engine } = engineWith(() => Promise.resolve(page({ changes: [] })));
    const seen: boolean[] = [];
    const unsubscribe = engine.subscribe(() => {
      seen.push(engine.getStatus().pulling);
    });
    await engine.pullNow();
    unsubscribe();
    await engine.pullNow();
    expect(seen).toEqual([true, false]);
  });
});
```

- `CodedError` stands for the app's `ApiRequestError`: the engine only needs `codeOf()` to read a code from it.
- The single-flight test holds the first pull open with a promise it resolves by hand, asks twice more, and checks
  that the two asks make one more pull, not two.
- The network test checks the part that matters most offline: the first page and its cursor are saved, and the next
  pull goes on from there instead of starting over.
- Node 24 has `navigator.locks`, so the engine's real Web Lock runs in the tests.

```ts
import { describe, expect, it } from 'vitest';

import { deviceNameParts, type IdentityStorage, readDevice, saveDevice } from './device.js';

const TENANT = '01928c4e-2222-7000-8000-000000000001';
const USER = '01928c4e-3333-7000-8000-000000000001';
const BRANCH = '01928c4e-4444-7000-8000-000000000001';

function memoryStorage(): IdentityStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

describe('readDevice / saveDevice', () => {
  it('makes a new UUIDv7 identity the first time, and reads the saved one after', () => {
    const storage = memoryStorage();
    const fresh = readDevice(storage, TENANT, USER);
    expect(fresh).toMatchObject({ branchId: null, later: false });
    expect(fresh.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(saveDevice(storage, TENANT, USER, { ...fresh, branchId: BRANCH })).toBe(true);
    expect(readDevice(storage, TENANT, USER)).toEqual({ ...fresh, branchId: BRANCH });
  });

  it('keeps one identity per person and workspace', () => {
    const storage = memoryStorage();
    const mine = readDevice(storage, TENANT, USER);
    saveDevice(storage, TENANT, USER, mine);
    const theirs = readDevice(storage, TENANT, BRANCH);
    expect(theirs.id).not.toBe(mine.id);
  });

  it('does not trust what it finds: a broken value gives a new identity', () => {
    const storage = memoryStorage();
    storage.items.set(`omnivo.device.${TENANT}.${USER}`, '{"id":"not-a-uuid","branchId":null}');
    expect(readDevice(storage, TENANT, USER).id).toMatch(/^[0-9a-f-]{36}$/);
    storage.items.set(`omnivo.device.${TENANT}.${USER}`, '{oops');
    expect(readDevice(storage, TENANT, USER).branchId).toBeNull();
  });

  it('works without a storage, or with one that throws (Safari private window)', () => {
    const refusing: IdentityStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const identity = readDevice(refusing, TENANT, USER);
    expect(saveDevice(refusing, TENANT, USER, identity)).toBe(false);
    expect(saveDevice(null, TENANT, USER, identity)).toBe(false);
    expect(readDevice(null, TENANT, USER).branchId).toBeNull();
  });
});

describe('deviceNameParts', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      { browser: 'Edge', os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
      { browser: 'Samsung Internet', os: 'Android' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:143.0) Gecko/20100101 Firefox/143.0',
      { browser: 'Firefox', os: 'macOS' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/122.0.0.0',
      { browser: 'Opera', os: 'Linux' },
    ],
  ])('%s', (userAgent, expected) => {
    expect(deviceNameParts(userAgent)).toEqual(expected);
  });

  it('gives null for a browser it does not know', () => {
    expect(deviceNameParts('curl/8.7.1')).toBeNull();
  });
});
```

```ts
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import {
  customerPage,
  customerSummaryOf,
  findCustomers,
  findProducts,
  productPage,
  productSummaryOf,
} from './queries.js';
import {
  customer,
  newDatabase,
  page,
  product,
  upsertCustomer,
  upsertProduct,
} from './test-fixtures.js';

const MEDICINE = '01928c4e-5555-7000-8000-000000000001';
const SYRUP = '01928c4e-5555-7000-8000-000000000002';

const napa = product({
  name: 'Napa 500 mg tablet',
  code: 'MED-0002',
  categoryId: MEDICINE,
  units: [{ unitId: MEDICINE, factor: '10', barcode: '8941100500017' }],
});
const ace = product({ name: 'ace Plus tablet', code: 'MED-0001', categoryId: MEDICINE });
const tusca = product({ name: 'Tusca syrup 100 ml', code: 'MED-0003', categoryId: SYRUP });
const polo = product({
  name: 'Polo shirt',
  code: 'FG-0001',
  options: [{ name: 'Size', values: ['M', 'L'] }],
  variants: [
    {
      id: SYRUP,
      sku: 'POLO-NVY-M',
      optionValues: ['M'],
      barcode: '2000000000015',
      salePrice: '650.0000',
      archivedAt: null,
    },
    {
      id: MEDICINE,
      sku: 'POLO-NVY-L',
      optionValues: ['L'],
      barcode: null,
      salePrice: '700.0000',
      archivedAt: null,
    },
    {
      id: napa.id,
      sku: 'POLO-NVY-XXL',
      optionValues: ['XXL'],
      barcode: null,
      salePrice: '900.0000',
      archivedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
});

async function loaded() {
  const db = newDatabase();
  await applyPage(
    db,
    page({
      full: true,
      changes: [napa, ace, tusca, polo].map(upsertProduct).concat(
        [
          customer({
            name: 'Rahman Traders',
            code: 'C-00001',
            phone: '01711-234567',
            groupId: MEDICINE,
          }),
          customer({ name: 'Bismillah Store', code: 'C-00002', contactPerson: 'Karim Mia' }),
          customer({ name: 'Anwar Pharmacy', code: 'C-00003', groupId: MEDICINE }),
        ].map(upsertCustomer),
      ),
    }),
    null,
  );
  return db;
}

const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);

describe('productPage', () => {
  it('sorts by name without case, like the server, and says when there is more', async () => {
    const db = await loaded();
    const first = await productPage(db, { search: '', categoryIds: null, sort: 'name', limit: 3 });
    expect(names(first.rows)).toEqual(['ace Plus tablet', 'Napa 500 mg tablet', 'Polo shirt']);
    expect(first.more).toBe(true);
    const all = await productPage(db, { search: '', categoryIds: null, sort: '-name', limit: 10 });
    expect(names(all.rows)).toEqual([
      'Tusca syrup 100 ml',
      'Polo shirt',
      'Napa 500 mg tablet',
      'ace Plus tablet',
    ]);
    expect(all.more).toBe(false);
  });

  it('sorts by code', async () => {
    const db = await loaded();
    const rows = (await productPage(db, { search: '', categoryIds: null, sort: 'code', limit: 10 }))
      .rows;
    expect(rows.map((row) => row.code)).toEqual(['FG-0001', 'MED-0001', 'MED-0002', 'MED-0003']);
  });

  it('finds by part of the name, the code or a SKU, and by a whole barcode', async () => {
    const db = await loaded();
    expect(names(await findProducts(db, 'TABLET'))).toEqual([
      'ace Plus tablet',
      'Napa 500 mg tablet',
    ]);
    expect(names(await findProducts(db, 'med-0003'))).toEqual(['Tusca syrup 100 ml']);
    // An archived variant's SKU still finds its product, like the server
    expect(names(await findProducts(db, 'nvy-xxl'))).toEqual(['Polo shirt']);
    // A pack's barcode and a variant's barcode, whole only
    expect(names(await findProducts(db, '8941100500017'))).toEqual(['Napa 500 mg tablet']);
    expect(names(await findProducts(db, '2000000000015'))).toEqual(['Polo shirt']);
    expect(await findProducts(db, '89411005')).toEqual([]);
  });

  it('filters by the categories it is given', async () => {
    const db = await loaded();
    const rows = (
      await productPage(db, { search: '', categoryIds: new Set([SYRUP]), sort: 'name', limit: 10 })
    ).rows;
    expect(names(rows)).toEqual(['Tusca syrup 100 ml']);
  });
});

describe('productSummaryOf', () => {
  it('counts and prices the active variants only, like the server list', () => {
    expect(productSummaryOf(polo)).toMatchObject({
      hasVariants: true,
      variantCount: 2,
      minPrice: '650.0000',
      maxPrice: '700.0000',
    });
    expect(productSummaryOf(napa)).toMatchObject({
      hasVariants: false,
      minPrice: null,
      maxPrice: null,
    });
  });
});

describe('customerPage', () => {
  it('sorts by name, filters by group and searches the phone and contact person', async () => {
    const db = await loaded();
    const all = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 10 });
    expect(names(all.rows)).toEqual(['Anwar Pharmacy', 'Bismillah Store', 'Rahman Traders']);
    const group = await customerPage(db, {
      search: '',
      groupId: MEDICINE,
      sort: '-name',
      limit: 10,
    });
    expect(names(group.rows)).toEqual(['Rahman Traders', 'Anwar Pharmacy']);
    expect(names(await findCustomers(db, '1711'))).toEqual(['Rahman Traders']);
    expect(names(await findCustomers(db, 'karim'))).toEqual(['Bismillah Store']);
    expect(names(await findCustomers(db, 'c-0000'))).toHaveLength(3);
  });

  it('has no balance on the device', async () => {
    const db = await loaded();
    const [first] = (await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 1 }))
      .rows;
    expect(first && customerSummaryOf(first).balance).toBeNull();
  });
});
```

The user agents are real ones (Chrome and Edge on Windows, Samsung Internet on Android, Safari on an iPhone, Firefox
on a Mac, Opera on Linux). The queries spec loads one full page and checks each rule of decision 44 against the
server's behaviour: the sort without case, the code sort, a SKU of an archived variant, a pack barcode found whole
but not in part, the category set, and the customers' phone and contact person.

### The boundaries

```diff
@@ -22,8 +22,8 @@ module.exports = {
       name: 'browser-packages-not-to-server',
       severity: 'error',
       comment:
-        'ui and i18n ship to the browser. Importing db or auth would bundle server code and secrets handling into the app.',
-      from: { path: '^packages/(ui|i18n)/' },
+        'ui, i18n and sync ship to the browser. Importing db or auth would bundle server code and secrets handling into the app.',
+      from: { path: '^packages/(ui|i18n|sync)/' },
       to: { path: ['^packages/(db|auth)/', 'node_modules/(better-auth|drizzle-orm|postgres)/'] },
     },
     {
```

`packages/sync` ships to the browser like `ui` and `i18n`, so it may not import `db` or `auth` either.

### `apps/app`: the dependency and the save signal

```diff
@@ -33,6 +33,7 @@
     "@hugeicons/react": "^1.1.10",
     "@omnivo/contracts": "workspace:*",
     "@omnivo/i18n": "workspace:*",
+    "@omnivo/sync": "workspace:*",
     "@omnivo/ui": "workspace:*",
     "@tanstack/react-query": "^5.104.0",
     "@tanstack/react-router": "^1.170.39",
```

Only `@omnivo/sync`. The app imports nothing from Dexie itself: its live reads come through `watch` (decision 42).

```diff
@@ -150,5 +150,24 @@ export async function call(route: RouteDef, input: RequestParts = {}): Promise<u
     response = await send(route, input, session.accessToken);
   }
 
-  return read(route, response);
+  const result = await read(route, response);
+  if (route.method !== 'GET') notifyWrite();
+  return result;
+}
+
+// Step 18a: a save on this device pulls its change onto the device at once, instead of up to a
+// minute later. Every write goes through call(), so one listener here covers the product form,
+// the customer form, a stock posting and every other save. The sync code subscribes; this file
+// does not import it, so the first page load stays without Dexie.
+const writeListeners = new Set<() => void>();
+
+export function onApiWrite(listener: () => void): () => void {
+  writeListeners.add(listener);
+  return () => {
+    writeListeners.delete(listener);
+  };
+}
+
+function notifyWrite(): void {
+  for (const listener of writeListeners) listener();
 }
```

- **`notifyWrite()` after a successful call that is not a `GET`** (decision 43). After `read()`, so a refused save
  (it throws) pulls nothing.
- **A listener set, not an import of the sync code.** `api.ts` is in the first page load; importing the session
  would bring Dexie into it. The session subscribes when it starts and unsubscribes when it stops.

```ts
import { useSyncExternalStore } from 'react';

// Whether the browser thinks it is online. It can be wrong one way: "online" on a network with no
// internet. That only means a request fails like any other; "offline" is always true, so it is
// what the pages use to say "Needs a connection" instead of an error.
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
```

`navigator.onLine` can say "online" on a network without internet; then a request fails like any other. "Offline" is
always right, and that is the only thing the pages use it for: to say "Needs a connection" instead of an error.
`useSyncExternalStore` re-renders on the two events and never tears between components.

### `lib/local-data.ts`: what the screens read

```ts
import type { Branch } from '@omnivo/contracts';
import {
  readPullState,
  STORAGE_FAILED,
  type SyncDatabase,
  type SyncEngine,
  type SyncStatus,
  type Watch,
} from '@omnivo/sync';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { useOnline } from './use-online';

// Step 18a: what the screens know of the device and its copy of the data, and how they read it.
// No Dexie here: this file is imported by the products and customers pages and by the pickers in
// every sales form, and Dexie is 30 KB gz. The code that opens the database (local-session.ts)
// is loaded once, lazily, by the AppShell, and puts the database, the engine and Dexie's
// liveQuery (`watch`) into this store.

export type DeviceState =
  | { kind: 'starting' }
  // More than one branch, and none chosen yet (decision 12); the dialog lists `branches`
  | { kind: 'not-set-up'; branches: Branch[] }
  // The server could not be reached to set the device up. It tries again when the connection
  // comes back, and every minute.
  | { kind: 'unreachable' }
  | { kind: 'storage-failed' }
  | { kind: 'revoked' }
  | { kind: 'ready'; db: SyncDatabase; engine: SyncEngine; watch: Watch };

interface LocalDataState {
  device: DeviceState;
  // The branch dialog is open
  asking: boolean;
  // "Try again" on a first pull that failed; set by the session
  retry: () => void;
}

export const localDataStore = createStore<LocalDataState>()(() => ({
  device: { kind: 'starting' },
  asking: false,
  retry: () => undefined,
}));

export function askForBranch(): void {
  localDataStore.setState({ asking: true });
}

export function retryLocalData(): void {
  localDataStore.getState().retry();
}

export function useDeviceState(): DeviceState {
  return useStore(localDataStore, (state) => state.device);
}

// A read of the copy that runs again by itself when a pull changes what it read. `query` must be
// stable (useCallback): a new function is a new read. null = nothing to read (the archived tab).
// While a new read runs, the last answer stays, so a list does not flash empty on each key press.
// undefined until the first answer, and while the device has no open copy.
export function useLocalQuery<T>(query: ((db: SyncDatabase) => Promise<T>) | null): T | undefined {
  const device = useDeviceState();
  const ready = device.kind === 'ready' ? device : null;
  // The answer keeps the device it came from: another workspace's copy is never shown
  const [answer, setAnswer] = useState<{ from: DeviceState; value: T } | null>(null);
  useEffect(() => {
    if (!ready || !query) return;
    return ready.watch(
      () => query(ready.db),
      (value) => {
        setAnswer({ from: ready, value });
      },
      // A read that fails (the database closed on sign-out) keeps the last answer
      () => undefined,
    );
  }, [ready, query]);
  return ready && query && answer?.from === ready ? answer.value : undefined;
}

export type LocalView =
  | { kind: 'loading' }
  // The device has a complete copy (one pull finished), so lists read it, online or not
  | { kind: 'ready'; db: SyncDatabase }
  | { kind: 'not-set-up' }
  | { kind: 'first-pull'; copied: number }
  | { kind: 'first-pull-failed' }
  | { kind: 'offline-empty' }
  | { kind: 'storage-failed' }
  | { kind: 'revoked' };

// The engine's problems a page says above its list, because they need the person: the others
// (no connection, a server error) only mean the copy is a little older, and 18c's sidebar says so
const NOTICES: ReadonlySet<string> = new Set([
  'sync_protocol_mismatch',
  'device_not_found',
  'device_id_invalid',
  'device_branch_invalid',
]);

const NO_STATUS: SyncStatus = { pulling: false, problem: null, stopped: false };
const noSubscribe = () => () => undefined;
const noStatus = () => NO_STATUS;

export function useLocalData(): { view: LocalView; notice: string | null } {
  const device = useDeviceState();
  const online = useOnline();
  const engine = device.kind === 'ready' ? device.engine : null;
  const status = useSyncExternalStore(
    engine?.subscribe ?? noSubscribe,
    engine?.getStatus ?? noStatus,
  );
  // Live: the first pull's count and its end show here as the pages arrive
  const pull = useLocalQuery(readPullState);
  const notice = status.problem !== null && NOTICES.has(status.problem) ? status.problem : null;
  return { view: viewOf(device, status, pull?.lastSyncAt, pull?.copied ?? 0, online), notice };
}

function viewOf(
  device: DeviceState,
  status: SyncStatus,
  // undefined = not read yet
  lastSyncAt: string | null | undefined,
  copied: number,
  online: boolean,
): LocalView {
  switch (device.kind) {
    case 'starting':
      return { kind: 'loading' };
    case 'not-set-up':
    case 'storage-failed':
    case 'revoked':
      return { kind: device.kind };
    case 'unreachable':
      return online ? { kind: 'first-pull-failed' } : { kind: 'offline-empty' };
    case 'ready':
      if (lastSyncAt === undefined) return { kind: 'loading' };
      if (lastSyncAt !== null) return { kind: 'ready', db: device.db };
      if (status.problem === STORAGE_FAILED) return { kind: 'storage-failed' };
      if (status.problem === null) return { kind: 'first-pull', copied };
      return online ? { kind: 'first-pull-failed' } : { kind: 'offline-empty' };
  }
}
```

- **No Dexie at run time.** Every `@omnivo/sync` import here is a type, `readPullState` or `STORAGE_FAILED`, which
  live in Dexie-free files. This module is in the chunks of the products and customers pages and of every form with
  a customer box.
- **`DeviceState` is the session's answer,** a union on `kind`. `ready` carries the database, the engine and
  `watch`; `not-set-up` carries the branches for the dialog. `unreachable` is "not registered, and the server did not
  answer": a page shows the offline or the failed state for it, and the session tries again.
- **`retry` is in the store,** set by the session. "Try again" on a page then needs no import of the session (which
  has Dexie).
- **`useLocalQuery(read)`.** The effect subscribes with `watch` and keeps the answer in state. Three details:
  - **`read` must be a stable function.** The pages pass `useCallback` reads, or functions declared outside the
    component. A new function on every render would subscribe again on every render.
  - **The answer remembers the device it came from** (`from`), and is returned only for that device. Switching to
    another workspace makes a new `ready` state, and the old workspace's rows are never shown under the new name, not
    even for one render.
  - **The last answer stays while a new read runs,** so a list does not flash empty on each key press. `null` as the
    read (the archived tab) returns `undefined`.
- **`NOTICES`** are the problems a page shows above its list. A network error is not one: the copy is only a little
  older, and 18c's sidebar shows the sync status.
- **`noSubscribe` and `noStatus` are module constants.** `useSyncExternalStore` must get the same functions on every
  render while there is no engine; inline arrows would make React subscribe again each time.
- **`viewOf()`** turns the device and the pull state into what a page draws. The copy counts as ready once one pull
  has finished (`lastSyncAt` set), whatever happens after: offline, the device reads what it has. Before that, a
  `storage_failed` problem, no problem (copying), or a failed pull (offline or not).

### `lib/local-session.ts`: the device and the engine

```ts
import { type Device, routes } from '@omnivo/contracts';
import { i18n } from '@omnivo/i18n';
import {
  databaseName,
  deleteLocalDatabase,
  type DeviceIdentity,
  deviceNameParts,
  newDeviceId,
  readDevice,
  saveDevice,
  SyncDatabase,
  SyncEngine,
  watch,
} from '@omnivo/sync';

import { ApiRequestError, call, onApiWrite } from './api';
import { localDataStore } from './local-data';

// Step 18a: this browser as a device, and its copy of the data, for the person signed in now.
// This module brings Dexie, so only lazy code imports it: the AppShell's host
// (local-data-host.tsx) and the branch dialog, and session.ts with import() to delete the copy.
// The pages read the copy through local-data.ts, which never loads Dexie itself.

// localStorage itself can throw (a sandboxed frame, storage turned off): then no storage
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function codeOf(error: unknown): string | null {
  return error instanceof ApiRequestError ? error.code : null;
}

const set = localDataStore.setState;

interface Session {
  tenantId: string;
  userId: string;
  identity: DeviceIdentity;
  // Set when the session ends: an answer that comes after it changes nothing
  stopped: boolean;
  // What the running copy needs undone: the engine, the database, the listeners
  cleanup: (() => void)[];
}

let current: Session | null = null;

function remember(session: Session, identity: DeviceIdentity): void {
  session.identity = identity;
  saveDevice(storage(), session.tenantId, session.userId, identity);
}

function runCleanup(session: Session): void {
  for (const undo of session.cleanup.splice(0)) undo();
}

export function startLocalData(input: { tenantId: string; userId: string }): () => void {
  stopLocalData();
  const session: Session = {
    ...input,
    identity: readDevice(storage(), input.tenantId, input.userId),
    stopped: false,
    cleanup: [],
  };
  current = session;
  // Saved before the first registration: if its answer is lost, the next try sends the same id
  // and the server returns the same device (decision 20)
  remember(session, session.identity);
  set({
    device: { kind: 'starting' },
    asking: false,
    retry: () => {
      retry(session);
    },
  });
  void setUp(session);
  return () => {
    if (current === session) stopLocalData();
  };
}

export function stopLocalData(): void {
  if (!current) return;
  current.stopped = true;
  runCleanup(current);
  current = null;
  set({ device: { kind: 'starting' }, asking: false });
}

// The copy is the workspace's data: signing out deletes it (decision 41). The device's id stays
// in localStorage, so the next sign-in is the same device, with a new full pull.
export async function deleteLocalData(tenantId: string, userId: string): Promise<void> {
  if (current?.tenantId === tenantId && current.userId === userId) stopLocalData();
  await deleteLocalDatabase(tenantId, userId);
}

async function setUp(session: Session): Promise<void> {
  if (session.identity.branchId !== null) {
    await open(session);
    return;
  }
  try {
    const { items: branches } = await call(routes.branches.list, { query: { status: 'active' } });
    if (session.stopped) return;
    const [only, ...others] = branches;
    // One branch: no question (decision 12)
    if (only && others.length === 0) {
      await register(session, only.id);
      return;
    }
    // Several (or none, which a workspace never has: sign-up makes the head office)
    set({ device: { kind: 'not-set-up', branches }, asking: !session.identity.later });
  } catch {
    if (!session.stopped) waitForServer(session);
  }
}

// Not set up and no answer: try again when the connection comes back, or in a minute
function waitForServer(session: Session): void {
  set({ device: { kind: 'unreachable' } });
  const again = () => {
    retry(session);
  };
  const timer = setInterval(again, 60_000);
  window.addEventListener('online', again);
  session.cleanup.push(() => {
    clearInterval(timer);
    window.removeEventListener('online', again);
  });
}

// "Try again" on the first-pull error: pull again, or set up again
function retry(session: Session): void {
  if (session.stopped) return;
  const { device } = localDataStore.getState();
  if (device.kind === 'ready') {
    void device.engine.pullNow();
    return;
  }
  runCleanup(session);
  void setUp(session);
}

// "Chrome on Windows" in the language of the person who sets it up (decision 12). The server
// keeps the name it got first; renaming is 18c's.
function deviceName(): string {
  const parts = deviceNameParts(navigator.userAgent);
  return parts ? i18n.t('devices.defaultName', parts) : i18n.t('devices.fallbackName');
}

function registerDevice(session: Session, branchId: string): Promise<Device> {
  return call(routes.sync.registerDevice, {
    body: { id: session.identity.id, name: deviceName(), branchId },
  });
}

async function register(session: Session, branchId: string): Promise<Device> {
  let device: Device;
  try {
    device = await registerDevice(session, branchId);
  } catch (error) {
    // The id is another person's device (a browser profile copied to another computer): a new
    // id, once. Any other error goes to the caller.
    if (codeOf(error) !== 'device_id_invalid') throw error;
    remember(session, { ...session.identity, id: newDeviceId() });
    device = await registerDevice(session, branchId);
  }
  if (session.stopped) return device;
  // The server's branch, not the one asked for: registering an existing device again changes
  // nothing (decision 37)
  remember(session, { id: device.id, branchId: device.branchId, later: false });
  if (device.revokedAt === null) await open(session);
  else await revoke(session);
  return device;
}

// The branch dialog's "Use this branch". The dialog shows the errors (device_branch_invalid
// under the box). null = the session ended while the dialog was open.
export async function chooseBranch(branchId: string): Promise<Device | null> {
  return current ? register(current, branchId) : null;
}

// "Not now" (decision 40): no dialog by itself any more on this device; the pages show a button
export function chooseLater(): void {
  if (current) remember(current, { ...current.identity, later: true });
  set({ asking: false });
}

async function open(session: Session): Promise<void> {
  const db = new SyncDatabase(databaseName(session.tenantId, session.userId));
  try {
    await db.open();
  } catch {
    // A private window that refuses IndexedDB, a full disk
    if (!session.stopped) set({ device: { kind: 'storage-failed' } });
    return;
  }
  if (session.stopped) {
    db.close();
    return;
  }
  const engine = new SyncEngine({
    db,
    deviceId: session.identity.id,
    pull: (query) => call(routes.sync.pull, { query }),
    codeOf,
    registerAgain: async () => {
      const { branchId } = session.identity;
      if (branchId === null) return;
      try {
        await registerDevice(session, branchId);
      } catch (error) {
        // The branch was archived while the server did not know the device: forget it and ask
        // again, like a new device
        if (codeOf(error) === 'device_branch_invalid') {
          remember(session, { ...session.identity, branchId: null });
          queueMicrotask(() => {
            runCleanup(session);
            set({ device: { kind: 'starting' } });
            void setUp(session);
          });
        }
        throw error;
      }
    },
    onRevoked: () => {
      void revoke(session);
    },
  });
  session.cleanup.push(
    // A save on this device: pull its change now (api.ts)
    onApiWrite(() => {
      engine.request();
    }),
    () => {
      engine.stop();
    },
    () => {
      db.close();
    },
  );
  set({ device: { kind: 'ready', db, engine, watch }, asking: false });
  engine.start();
}

// A revoked device keeps nothing (decision 7). The identity stays: registering it again returns
// the same revoked device, so it stays revoked until step 18c says otherwise.
async function revoke(session: Session): Promise<void> {
  runCleanup(session);
  await deleteLocalDatabase(session.tenantId, session.userId);
  if (!session.stopped) set({ device: { kind: 'revoked' }, asking: false });
}
```

- **Only lazy code imports it:** the host, the branch dialog (in the host's chunk), and `session.ts` through
  `import()`. It brings Dexie, `uuidv7` and the device's zod schema, about 37 KB gz together.
- **`startLocalData()` saves the identity before anything else.** If the registration's answer is lost on a bad
  connection, the retry sends the same id, and the server returns the same device (decision 20) instead of making a
  second one.
- **`stopped` on the session.** Every `await` can return after a sign-out or a workspace switch. Each step checks it
  before it touches the store, so a late answer never shows the old workspace's state. React's StrictMode starts and
  stops the session twice in development, which is the same case.
- **`cleanup`** is a list of undo functions: the engine's stop, the database's close, the write listener, the retry
  timer. `runCleanup()` empties it, so it is safe to call twice.
- **`setUp()`: one branch, no question** (decision 12). Several branches show the dialog unless the person pressed
  "Not now" before on this device (decision 40). Any failure to reach the server goes to `waitForServer()`: it tries
  again on `online` and every minute, the same rhythm as the pulls.
- **`deviceName()` uses `i18n.t`, not a hook,** because it runs outside React. The name is in the language of the
  person who sets the device up, and the server keeps the first one (renaming is 18c's).
- **`register()` keeps the server's branch,** not the one asked for: registering an existing device again changes
  nothing (decision 37). A device that comes back revoked deletes its copy at once.
- **`device_id_invalid` makes a new id, once** (decision 49). It means another person already has this id: a
  browser profile copied to another computer. A second refusal goes to the dialog as an error.
- **`open()`: the database first, then the engine.** `db.open()` is where a private window or a full disk fails, so
  that failure becomes the `storage-failed` state before any pull starts.
- **`registerAgain` on a branch archived in the meantime** forgets the branch and starts over. `queueMicrotask`: the
  engine is still inside its failed pull when this runs; the cleanup (which stops that engine) runs after the pull has
  returned its error.
- **`revoke()` keeps the identity.** Registering it again returns the same revoked device, so it stays revoked until
  18c decides how a device comes back.

### The host, the dialog and the states

```tsx
import { useEffect } from 'react';
import { useStore } from 'zustand';

import { localDataStore, useDeviceState } from '../lib/local-data';
import { startLocalData } from '../lib/local-session';
import { useSession } from '../lib/session-store';
import { DeviceBranchDialog } from './device-branch-dialog';

// Step 18a: the device and its copy of the data, for the person signed in now. Rendered once,
// inside the AppShell, and loaded lazily with Dexie: the login page never downloads it. A switch
// to another workspace changes the tenant id, which stops this copy and starts that one.
export function LocalDataHost() {
  const userId = useSession((state) => state.me?.user.id);
  const tenantId = useSession((state) => state.me?.tenant.id);
  const asking = useStore(localDataStore, (state) => state.asking);
  const device = useDeviceState();

  useEffect(() => {
    if (userId === undefined || tenantId === undefined) return;
    return startLocalData({ tenantId, userId });
  }, [tenantId, userId]);

  return asking && device.kind === 'not-set-up' ? (
    <DeviceBranchDialog branches={device.branches} />
  ) : null;
}
```

- **The effect depends on the tenant and the user only.** A switch to another workspace changes the tenant id: the
  effect's cleanup stops the old session and the new run starts the next one. The workspace switcher does not reload
  the page, so this is the only place that notices it.
- **The dialog shows only while `asking` and `not-set-up`.** "Choose the branch" on a page sets `asking`; the
  branches come with the state, so the dialog needs no request of its own.

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { Store01Icon } from '@hugeicons/core-free-icons';
import { type Branch, contractErrorMap, registerDeviceInputSchema } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogContent, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { applyApiError } from '../lib/field-errors';
import { chooseBranch, chooseLater } from '../lib/local-session';

// Only the branch is the person's to choose: the id and the name come from the browser
const branchFormSchema = registerDeviceInputSchema.pick({ branchId: true });
const FIELD_NAMES = branchFormSchema.keyof().options;

// "Which branch is this device in?" (decision 12), once, after sign-in, for a workspace with more
// than one branch. Closing it any way (Esc, the backdrop, "Not now") is "Not now" (decision 40):
// the products and customers pages then offer it again with a button.
export function DeviceBranchDialog({ branches }: { branches: readonly Branch[] }) {
  const { t } = useLocale();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(branchFormSchema, { error: contractErrorMap }),
    // No branch chosen for the person: the head office is first in the list, and a shop's
    // device set up there by a quick click would pull another branch's stock
    defaultValues: { branchId: '' },
  });

  const onSubmit = handleSubmit(async ({ branchId }) => {
    try {
      const device = await chooseBranch(branchId);
      const branch = branches.find((item) => item.id === device?.branchId);
      if (branch) toast(t('devices.registered', { branch: branch.name }));
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) chooseLater();
      }}
    >
      <DialogContent
        title={t('devices.branchTitle')}
        description={t('devices.branchDescription')}
        footer={
          <>
            <Button variant="secondary" onClick={chooseLater}>
              {t('devices.later')}
            </Button>
            <Button type="submit" form="device-branch-form" disabled={isSubmitting}>
              {isSubmitting ? t('common.saving') : t('devices.useBranch')}
            </Button>
          </>
        }
      >
        <form
          id="device-branch-form"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          <SelectField
            label={t('devices.branch')}
            icon={Store01Icon}
            hint={t('devices.branchHint')}
            options={[
              { value: '', label: t('devices.branchPlaceholder') },
              ...branches.map((branch) => ({
                value: branch.id,
                label: `${branch.code} · ${branch.name}`,
              })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- **`registerDeviceInputSchema.pick({ branchId: true })`**: the form checks the branch with the contract's own rule,
  so an empty box shows `device_branch_invalid` ("Pick an active branch.") under it, without a request.
- **`defaultValues: { branchId: '' }`** (decision 47).
- **Every way of closing it is "Not now":** `onOpenChange(false)` (Esc, the backdrop, the close button) calls
  `chooseLater()`, like the button. A person who closes it with Esc is not asked again on the next page.
- **The toast names the server's branch** (`device?.branchId`), which is the one the device really has.
- **`applyApiError()`** puts `device_branch_invalid` (a branch archived a moment ago) under the box, and anything else
  at the top, like every form.

```tsx
import {
  CloudDownloadIcon,
  CloudOffIcon,
  ComputerPhoneSyncIcon,
  ComputerRemoveIcon,
  HardDriveIcon,
  InformationCircleIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Button, EmptyState } from '@omnivo/ui';

import { askForBranch, type LocalView, retryLocalData } from '../lib/local-data';

export type WaitingView = Exclude<LocalView, { kind: 'ready' }>;

// What the products and customers pages show instead of their list while the device has no
// complete copy (decisions 12, 40 and the states of 18a.5). Each says what to do, so nobody
// thinks the workspace lost its products.
// `actions={false}` inside another dialog (the product picker): its button would open the branch
// dialog on top of it
export function LocalState({ view, actions = true }: { view: WaitingView; actions?: boolean }) {
  const { t, format, errorText } = useLocale();
  switch (view.kind) {
    case 'loading':
      return null;
    case 'not-set-up':
      return (
        <EmptyState
          icon={ComputerPhoneSyncIcon}
          title={t('sync.notSetUpTitle')}
          description={t('sync.notSetUpBody')}
          action={actions && <Button onClick={askForBranch}>{t('sync.setUp')}</Button>}
        />
      );
    case 'first-pull':
      return (
        <EmptyState
          icon={CloudDownloadIcon}
          title={t('sync.firstPullTitle')}
          description={t('sync.firstPullBody')}
          action={
            // A live line: a screen reader hears the count grow without moving the focus
            <p role="status" className="text-caption text-ink-3 tabular-nums">
              {view.copied > 0 &&
                t('sync.firstPullCount', {
                  count: view.copied,
                  formatted: format.number(view.copied),
                })}
            </p>
          }
        />
      );
    case 'first-pull-failed':
      return (
        <EmptyState
          icon={CloudOffIcon}
          title={t('sync.firstPullFailedTitle')}
          description={t('sync.firstPullFailedBody')}
          action={
            actions && (
              <Button variant="secondary" onClick={retryLocalData}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      );
    case 'offline-empty':
      return (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.offlineEmptyTitle')}
          description={t('sync.offlineEmptyBody')}
        />
      );
    case 'storage-failed':
      return (
        <EmptyState
          icon={HardDriveIcon}
          title={t('sync.storageFailedTitle')}
          description={t('sync.storageFailedBody')}
        />
      );
    case 'revoked':
      return (
        <EmptyState
          icon={ComputerRemoveIcon}
          title={t('sync.revokedTitle')}
          description={errorText('device_revoked')}
        />
      );
  }
}

// The one line a picker can show in its list (the Combobox has no room for a button)
export function useLocalStateText(): (view: WaitingView) => string | undefined {
  const { t } = useLocale();
  return (view) => {
    switch (view.kind) {
      case 'loading':
        return undefined;
      case 'not-set-up':
        return t('sync.notSetUpTitle');
      case 'first-pull':
        return t('sync.firstPullTitle');
      case 'first-pull-failed':
        return t('sync.firstPullFailedTitle');
      case 'offline-empty':
        return t('sync.offlineEmptyTitle');
      case 'storage-failed':
        return t('sync.storageFailedTitle');
      case 'revoked':
        return t('sync.revokedTitle');
    }
  };
}

// A problem of the engine that needs the person (local-data.ts → NOTICES, all error codes): above the list, which
// still shows the copy. Like a document notice (CLAUDE.md), neutral: the data is still there.
export function SyncNotice({ code }: { code: string }) {
  const { t, errorText } = useLocale();
  return (
    <p className="flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2">
      <HugeiconsIcon
        icon={InformationCircleIcon}
        size={17}
        strokeWidth={1.5}
        className="mt-px shrink-0"
      />
      <span>
        {errorText(code)}{' '}
        <button
          type="button"
          className="font-medium text-brand underline-offset-3 hover:underline"
          onClick={() => {
            window.location.reload();
          }}
        >
          {t('common.reload')}
        </button>
      </span>
    </p>
  );
}
```

- **One empty state per view,** each saying what to do. `first-pull` shows the count in a `role="status"` line, so a
  screen reader hears it grow without moving the focus. The count shows from the first row: "0 items copied" would
  say nothing.
- **`actions={false}`** is for the product picker, which is itself a dialog: its "Choose the branch" button would
  open the branch dialog on top of it.
- **`useLocalStateText()`** gives the pickers one line for their empty list (decision 40): the Combobox has room for
  a line, not a button.
- **`SyncNotice` looks like a neutral document notice** (CLAUDE.md), written here instead of imported from
  `sales-parts.tsx`: importing it would pull the sales parts into the products page's chunk. Reload is a text button,
  because the page's one primary button stays "Add product".

### Wiring: the AppShell, sign-out, the category helpers

```diff
@@ -78,7 +78,7 @@ import {
 } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
-import { useEffect, useState } from 'react';
+import { lazy, Suspense, useEffect, useState } from 'react';
 
 import { NotificationBell } from '../components/notification-bell';
 import { savePreference } from '../lib/preferences';
@@ -88,6 +88,12 @@ import { waitingCountQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { isTheme } from '../lib/theme';
 
+// Step 18a: the device and its copy of the data (Dexie, the sync engine, the branch dialog) in a
+// chunk of their own. The shell draws at once; the copy starts a moment later.
+const LocalDataHost = lazy(async () => ({
+  default: (await import('../components/local-data-host')).LocalDataHost,
+}));
+
 // ui-র সাধারণ <a> → TanStack-এর টাইপ-চেকড লিংক: to="/kitchn-sink" লিখলে compile error,
 // আর সক্রিয় রুটে Link নিজেই aria-current="page" বসায়
 const NavLink = createLink(NavItem);
@@ -529,6 +535,10 @@ export function AppShell() {
       }
     >
       <Outlet />
+      {/* No fallback: the host draws nothing until a branch dialog is needed */}
+      <Suspense fallback={null}>
+        <LocalDataHost />
+      </Suspense>
     </Shell>
   );
 }
```

`lazy()` with `Suspense fallback={null}`: the shell draws at once, and the host (with Dexie) arrives a moment later.
The host draws nothing until a dialog is needed, so there is nothing to wait for on screen.

```diff
@@ -70,11 +70,20 @@ export async function switchTenant(tenantId: string): Promise<void> {
 }
 
 export async function logout(): Promise<void> {
+  const me = sessionStore.getState().me;
   try {
     await call(authRoutes.logout);
   } finally {
     // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
     queryClient.clear();
     sessionStore.getState().signOut();
+    // Step 18a: the copy of the workspace's data on this device goes too (decision 41). import():
+    // local-session brings Dexie, which the first page load must not carry. A browser that refuses
+    // to delete it changes nothing for the sign-out.
+    if (me) {
+      void import('./local-session')
+        .then(({ deleteLocalData }) => deleteLocalData(me.tenant.id, me.user.id))
+        .catch(() => undefined);
+    }
   }
 }
```

- **`me` is read before `signOut()`,** which clears it.
- **`import('./local-session')` after the sign-out,** without `await`: the person sees the login page at once, and
  the copy is deleted behind it. A browser that refuses to delete it (`.catch`) does not undo the sign-out.
- Only an explicit sign-out deletes the copy. A session that ends by itself (the refresh token expired) keeps it: in
  18b it may hold commands not sent yet.

```diff
@@ -2,8 +2,8 @@ import {
   CUSTOM_FIELD_COLUMN_PREFIX,
   type CustomFieldDefinition,
   PRODUCT_IMPORT_COLUMNS,
-  type ProductCategory,
   type ProductVariantInput,
+  type SyncCategory,
 } from '@omnivo/contracts';
 import { buildTree, flattenTree, type TreeNode } from '@omnivo/ui';
 
@@ -11,7 +11,9 @@ import { buildTree, flattenTree, type TreeNode } from '@omnivo/ui';
 
 const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
 
-export function categoryTree(categories: readonly ProductCategory[]): TreeNode<ProductCategory>[] {
+// Generic: the categories page passes the server's rows (with their product counts), the products
+// page the device's (step 18a, without them)
+export function categoryTree<T extends SyncCategory>(categories: readonly T[]): TreeNode<T>[] {
   return buildTree(categories, {
     id: (category) => category.id,
     parentId: (category) => category.parentId,
@@ -19,10 +21,7 @@ export function categoryTree(categories: readonly ProductCategory[]): TreeNode<P
   });
 }
 
-function withoutBranch(
-  nodes: readonly TreeNode<ProductCategory>[],
-  id: string | undefined,
-): TreeNode<ProductCategory>[] {
+function withoutBranch<T>(nodes: readonly TreeNode<T>[], id: string | undefined): TreeNode<T>[] {
   return nodes.flatMap((node) =>
     node.id === id ? [] : [{ ...node, children: withoutBranch(node.children, id) }],
   );
@@ -31,7 +30,7 @@ function withoutBranch(
 // The categories in tree order, indented with em spaces for a native <select>. `moving` leaves out
 // a category and everything under it: it cannot go inside itself (the API refuses that too).
 export function categoryOptions(
-  categories: readonly ProductCategory[],
+  categories: readonly SyncCategory[],
   moving?: string,
 ): { value: string; label: string }[] {
   return flattenTree(withoutBranch(categoryTree(categories), moving)).map(({ node, depth }) => ({
@@ -41,7 +40,7 @@ export function categoryOptions(
 }
 
 // "Finished garments › T-shirts": where a product sits, for its row in the list
-export function categoryPath(categories: readonly ProductCategory[], id: string | null): string {
+export function categoryPath(categories: readonly SyncCategory[], id: string | null): string {
   const byId = new Map(categories.map((category) => [category.id, category]));
   const names: string[] = [];
   for (let current = id === null ? undefined : byId.get(id); current;) {
@@ -53,6 +52,23 @@ export function categoryPath(categories: readonly ProductCategory[], id: string
   return names.join(' › ');
 }
 
+// A category and every category under it: the products list's filter, like the server's
+// (products.service.ts). Step 18a: the list is filtered on the device, so it needs the same rule.
+export function categoryAndBelow(categories: readonly SyncCategory[], id: string): Set<string> {
+  const found = new Set([id]);
+  // Each pass adds the children of what was found; a broken chain (a cycle) adds nothing new
+  for (let grew = true; grew;) {
+    grew = false;
+    for (const category of categories) {
+      if (category.parentId !== null && found.has(category.parentId) && !found.has(category.id)) {
+        found.add(category.id);
+        grew = true;
+      }
+    }
+  }
+  return found;
+}
+
 // "S, M, L,, m" → ['S', 'M', 'L']: what an option's values box holds. Empty parts and repeats (in
 // any case) go, like the API's rule.
 export function splitValues(text: string): string[] {
```

- **`categoryTree()` is generic now.** The categories page passes the server's categories (with their counts) and
  reads `node.item.productCount`; the products page passes the device's (without counts). `T extends SyncCategory`
  keeps both type-checked, and the tree gives back the type it got.
- **`categoryAndBelow()`** is the server's recursive filter in a loop: each pass adds the children of what was found,
  until a pass adds nothing. A broken chain (a cycle) adds nothing new, so the loop always ends.

```diff
@@ -628,17 +628,18 @@ export function customerListQuery(tenantId: string, filter: CustomerFilter) {
   });
 }
 
-// The customer picker: the first 20 active customers that match. keepPreviousData: the old
-// matches stay in the list while the next word is searched, so the list does not flash empty.
-export function customerSearchQuery(tenantId: string, search: string) {
+// Step 18a: what the customers on screen owe (decision 10). The rows come from the device; the
+// balances, which change with every invoice and receipt, from the server, up to 100 at a time.
+// Under ['customers', tenantId], so every sales save that moves a balance refreshes them too.
+export function customerBalancesQuery(tenantId: string, ids: readonly string[]) {
   return queryOptions({
-    queryKey: ['customers', tenantId, 'search', search],
+    queryKey: ['customers', tenantId, 'balances', ids],
     queryFn: async () =>
-      (
-        await call(routes.customers.list, {
-          query: { limit: 20, status: 'active', ...(search !== '' && { search }) },
-        })
-      ).items,
+      new Map(
+        (await call(routes.customers.balances, { query: { ids: ids.join(',') } })).items.map(
+          (item) => [item.id, item.balance],
+        ),
+      ),
     placeholderData: keepPreviousData,
   });
 }
```

- **`customerBalancesQuery()`** asks for at most 100 ids. Its key is under `['customers', tenantId]`, so every sales
  save that invalidates that prefix (an invoice, a receipt) refreshes the balances on screen too.
- **`customerSearchQuery()` goes:** the customer box reads the device now, and nothing else used it.

### The products page

```diff
@@ -3,12 +3,12 @@ import {
   PackageIcon,
   PlusSignIcon,
   Search01Icon,
+  WifiDisconnected02Icon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   isTrackingMode,
   PRODUCT_STATUSES,
-  type ProductSort,
   type ProductStatus,
   type ProductSummary,
 } from '@omnivo/contracts';
@@ -24,20 +24,40 @@ import {
   Select,
   type SortingState,
 } from '@omnivo/ui';
+import {
+  allRows,
+  type LocalProductSort,
+  productPage,
+  productSummaryOf,
+  type SyncDatabase,
+} from '@omnivo/sync';
 import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
+import { LocalState, SyncNotice } from '../components/local-state';
+import { useLocalData, useLocalQuery } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
-import { categoryOptions, categoryPath } from '../lib/products';
+import { categoryAndBelow, categoryOptions, categoryPath } from '../lib/products';
 import { productCategoriesQuery, productListQuery, unitsQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { useDebounced } from '../lib/use-debounced';
+import { useOnline } from '../lib/use-online';
 
 const column = dataTableColumns<ProductSummary>();
 
-// The table's sort → the API's. Two sortable columns; the server keeps a stable order on each.
-function sortOf(state: SortingState): ProductSort {
+// Step 18a: the active products are read from the device, this many more each time the list is
+// scrolled to its end. The first screen reads a hundred rows, not the whole catalog.
+const PAGE = 100;
+
+// The small lists of the rows' categories and units, whole. Outside the component: a read must be
+// one stable function (useLocalQuery).
+const readCategories = (db: SyncDatabase) => allRows(db.productCategories);
+const readUnits = (db: SyncDatabase) => allRows(db.units);
+
+// The table's sort → the list's. Two sortable columns, each with an index on the device and a
+// stable order on the server.
+function sortOf(state: SortingState): LocalProductSort {
   const [first] = state;
   if (first?.id === 'code') return first.desc ? '-code' : 'code';
   if (first?.id === 'name') return first.desc ? '-name' : 'name';
@@ -54,18 +74,62 @@ export function ProductsPage() {
   const [status, setStatus] = useState<ProductStatus>('active');
   const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
   const settled = useDebounced(search.trim());
-  const filter = { search: settled, categoryId, status, sort: sortOf(sorting) };
-  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
-    productListQuery(tenantId, filter),
-  );
-  const categories = useQuery(productCategoriesQuery(tenantId)).data;
-  const units = useQuery(unitsQuery(tenantId)).data;
-  const products = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
+  const sort = sortOf(sorting);
+  const archived = status === 'archived';
+  const online = useOnline();
+  const { view, notice } = useLocalData();
+  const hasCopy = view.kind === 'ready';
+
+  // The categories and units of the rows: from the device, or from the server while the device
+  // has no copy (the archived tab works without one)
+  const localCategories = useLocalQuery(readCategories);
+  const localUnits = useLocalQuery(readUnits);
+  const serverCategories = useQuery({
+    ...productCategoriesQuery(tenantId),
+    enabled: !hasCopy,
+  }).data;
+  const serverUnits = useQuery({ ...unitsQuery(tenantId), enabled: !hasCopy }).data;
+  const categories = hasCopy ? localCategories : serverCategories;
+  const units = hasCopy ? localUnits : serverUnits;
   const unitCode = useMemo(() => new Map(units?.map((unit) => [unit.id, unit.code])), [units]);
 
+  // How far the list has been scrolled, for this filter only: a new search or sort starts at the
+  // top again. Kept with its filter instead of reset in an effect, so there is no render with
+  // the old length.
+  const filterKey = JSON.stringify([settled, categoryId, sort]);
+  const [grown, setGrown] = useState({ key: filterKey, limit: PAGE });
+  const limit = grown.key === filterKey ? grown.limit : PAGE;
+  const categoryIds = useMemo(
+    () => (categoryId === '' ? null : categoryAndBelow(categories ?? [], categoryId)),
+    [categories, categoryId],
+  );
+  // The active tab (decision 5): a live query, so a pull that changes a product changes its row
+  const readPage = useCallback(
+    (db: SyncDatabase) => productPage(db, { search: settled, categoryIds, sort, limit }),
+    [settled, categoryIds, sort, limit],
+  );
+  const local = useLocalQuery(archived ? null : readPage);
+  // The archived tab: the server's pages, as before, online only (decision 11)
+  const server = useInfiniteQuery({
+    ...productListQuery(tenantId, { search: settled, categoryId, status, sort }),
+    enabled: archived && online,
+  });
+  const { hasNextPage, isFetchingNextPage, fetchNextPage } = server;
+
+  const products = useMemo(
+    () =>
+      archived
+        ? server.data?.pages.flatMap((page) => page.items)
+        : local?.rows.map(productSummaryOf),
+    [archived, server.data, local],
+  );
+
+  const more = local?.more ?? false;
   const loadMore = useCallback(() => {
-    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
-  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
+    if (!archived) {
+      if (more) setGrown({ key: filterKey, limit: limit + PAGE });
+    } else if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
+  }, [archived, more, filterKey, limit, hasNextPage, isFetchingNextPage, fetchNextPage, setGrown]);
 
   const columns = useMemo(
     () =>
@@ -144,7 +208,7 @@ export function ProductsPage() {
         title={t('products.noMatchTitle', { query: settled })}
         description={t('products.noMatchBody')}
       />
-    ) : status === 'archived' ? (
+    ) : archived ? (
       <EmptyState
         icon={PackageIcon}
         title={t('products.archivedEmptyTitle')}
@@ -227,8 +291,19 @@ export function ProductsPage() {
         />
       </div>
       {!canManage && <p className="text-body-sm text-ink-3">{t('products.readOnly')}</p>}
-      {isError && <p className="text-body-sm text-crit">{t('products.loadFailed')}</p>}
-      {products && (
+      {notice !== null && <SyncNotice code={notice} />}
+      {archived && server.isError && (
+        <p className="text-body-sm text-crit">{t('products.loadFailed')}</p>
+      )}
+      {!archived && view.kind !== 'ready' && <LocalState view={view} />}
+      {archived && !online && (
+        <EmptyState
+          icon={WifiDisconnected02Icon}
+          title={t('sync.needsConnectionTitle')}
+          description={t('products.archivedOfflineBody')}
+        />
+      )}
+      {products && (archived ? online : view.kind === 'ready') && (
         <DataTable
           label={t('products.title')}
           data={products}
```

- **`readCategories` and `readUnits` are declared outside the component,** so they are the same function on every
  render (`useLocalQuery` subscribes once).
- **The server's categories and units are asked for only while the device has no copy** (`enabled: !hasCopy`): the
  archived tab works without a copy, and its rows still need their category paths.
- **`grown` keeps the list's length with its filter** (`filterKey`). A new search or sort is a new key, so the list
  starts at 100 rows again in the same render. Resetting it in an effect would draw one frame with the old length.
- **`readPage` is a `useCallback` on the filter.** A new search makes a new read, and `useLocalQuery` keeps the old
  rows until the new ones come (a few milliseconds).
- **`useLocalQuery(archived ? null : readPage)` and `enabled: archived && online`**: each tab reads only its own
  source. The archived tab is the old server list, unchanged.
- **`loadMore`** grows the device's list by 100 while `more` is true, or fetches the server's next page on the
  archived tab.
- **What shows instead of the table:** the device's state on the active tab until the copy is ready, "Needs a
  connection" on the archived tab offline (decision 50). The table shows only when its own source can answer.

### The customers page

```diff
@@ -1,10 +1,15 @@
-import { PlusSignIcon, Search01Icon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
+import {
+  PlusSignIcon,
+  Search01Icon,
+  UserMultiple02Icon,
+  WifiDisconnected02Icon,
+} from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   CUSTOMER_STATUSES,
-  type CustomerSort,
   type CustomerStatus,
   type CustomerSummary,
+  MAX_BALANCE_IDS,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
@@ -18,20 +23,58 @@ import {
   Select,
   type SortingState,
 } from '@omnivo/ui';
-import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
+import {
+  allRows,
+  customerPage,
+  customerSummaryOf,
+  type LocalCustomerSort,
+  type SyncDatabase,
+} from '@omnivo/sync';
+import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
+import { LocalState, SyncNotice } from '../components/local-state';
 import { initialsOf, useCustomerText } from '../lib/customers';
+import { useLocalData, useLocalQuery } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
-import { customerGroupsQuery, customerListQuery } from '../lib/queries';
+import { customerBalancesQuery, customerGroupsQuery, customerListQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { useDebounced } from '../lib/use-debounced';
+import { useOnline } from '../lib/use-online';
 
 const column = dataTableColumns<CustomerSummary>();
 
-// The customer column sorts by name; the server keeps a stable order (name, then id)
-function sortOf(state: SortingState): CustomerSort {
+// Step 18a: the active customers come from the device, this many more each time the list is
+// scrolled to its end. The same as the balances route's limit, so each step is one more request.
+const PAGE = MAX_BALANCE_IDS;
+
+// The ids of the rows, in groups the balances route takes. A group keeps its ids as long as the
+// rows before it do not change, so scrolling further asks only for the new group.
+function chunksOf(ids: readonly string[]): string[][] {
+  const chunks: string[][] = [];
+  for (let start = 0; start < ids.length; start += MAX_BALANCE_IDS) {
+    chunks.push(ids.slice(start, start + MAX_BALANCE_IDS));
+  }
+  return chunks;
+}
+
+// A read must be one stable function (useLocalQuery)
+const readGroups = (db: SyncDatabase) => allRows(db.customerGroups);
+
+// The groups' answers as one map. Outside the component: TanStack runs `combine` again only when
+// the answers or the function change, so an inline function would make a new map (and sort the
+// table again) on every render.
+function combineBalances(results: { data?: Map<string, string> | undefined; isError: boolean }[]) {
+  return {
+    byId: new Map(results.flatMap((result) => [...(result.data ?? [])])),
+    failed: results.some((result) => result.isError),
+  };
+}
+
+// The customer column sorts by name; the server keeps a stable order (name, then id), and the
+// device's index does the same
+function sortOf(state: SortingState): LocalCustomerSort {
   const [first] = state;
   return first?.id === 'name' && first.desc ? '-name' : 'name';
 }
@@ -50,20 +93,65 @@ export function CustomersPage() {
   const [status, setStatus] = useState<CustomerStatus>('active');
   const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
   const settled = useDebounced(search.trim());
-  const filter = { search: settled, groupId, status, sort: sortOf(sorting) };
-  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
-    customerListQuery(tenantId, filter),
-  );
-  const groups = useQuery(customerGroupsQuery(tenantId)).data;
-  const customers = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
+  const sort = sortOf(sorting);
+  const archived = status === 'archived';
+  const online = useOnline();
+  const { view, notice } = useLocalData();
+  const hasCopy = view.kind === 'ready';
+
+  const localGroups = useLocalQuery(readGroups);
+  const serverGroups = useQuery({ ...customerGroupsQuery(tenantId), enabled: !hasCopy }).data;
+  const groups = hasCopy ? localGroups : serverGroups;
   const groupName = useMemo(
     () => new Map(groups?.map((group) => [group.id, group.name])),
     [groups],
   );
 
+  // How far the list has been scrolled, for this filter only (like the products page)
+  const filterKey = JSON.stringify([settled, groupId, sort]);
+  const [grown, setGrown] = useState({ key: filterKey, limit: PAGE });
+  const limit = grown.key === filterKey ? grown.limit : PAGE;
+  const readPage = useCallback(
+    (db: SyncDatabase) => customerPage(db, { search: settled, groupId, sort, limit }),
+    [settled, groupId, sort, limit],
+  );
+  const local = useLocalQuery(archived ? null : readPage);
+  // The archived tab: the server's pages, with their balances, online only (decision 11)
+  const server = useInfiniteQuery({
+    ...customerListQuery(tenantId, { search: settled, groupId, status, sort }),
+    enabled: archived && online,
+  });
+  const { hasNextPage, isFetchingNextPage, fetchNextPage } = server;
+
+  // The balances of the rows shown (decision 10). Online and with the permission only: offline
+  // the column shows a dash.
+  const balances = useQueries({
+    queries: chunksOf(local?.rows.map((customer) => customer.id) ?? []).map((ids) => ({
+      ...customerBalancesQuery(tenantId, ids),
+      enabled: canSeeBalance && online,
+    })),
+    combine: combineBalances,
+  });
+
+  const customers = useMemo(
+    () =>
+      archived
+        ? server.data?.pages.flatMap((page) => page.items)
+        : local?.rows.map((customer) => ({
+            ...customerSummaryOf(customer),
+            // Offline, none: TanStack keeps the answers of a minute ago, and a balance that may
+            // be wrong by now is worse than a dash (decision 10)
+            balance: online ? (balances.byId.get(customer.id) ?? null) : null,
+          })),
+    [archived, server.data, local, balances.byId, online],
+  );
+
+  const more = local?.more ?? false;
   const loadMore = useCallback(() => {
-    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
-  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
+    if (!archived) {
+      if (more) setGrown({ key: filterKey, limit: limit + PAGE });
+    } else if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
+  }, [archived, more, filterKey, limit, hasNextPage, isFetchingNextPage, fetchNextPage, setGrown]);
 
   const columns = useMemo(
     () =>
@@ -126,19 +214,28 @@ export function CustomersPage() {
         }),
         ...(canSeeBalance
           ? [
-              column.accessor((customer) => customer.balance ?? '0', {
-                id: 'balance',
+              column.accessor('balance', {
                 header: t('customers.columns.balance'),
                 enableSorting: false,
                 meta: { align: 'end', card: 'trailing' },
-                cell: ({ getValue }) => (
-                  <span className="font-medium">{text.balance(getValue())}</span>
-                ),
+                // null = not here yet, or no connection (decision 10): a dash, never "Nothing
+                // owed", which would be a wrong answer
+                cell: ({ getValue }) => {
+                  const balance = getValue();
+                  return balance === null ? (
+                    <span className="text-ink-3">
+                      <span aria-hidden="true">—</span>
+                      {!online && <span className="sr-only">{t('customers.balancesOffline')}</span>}
+                    </span>
+                  ) : (
+                    <span className="font-medium">{text.balance(balance)}</span>
+                  );
+                },
               }),
             ]
           : []),
       ]),
-    [t, text, groupName, canSeeBalance],
+    [t, text, groupName, canSeeBalance, online],
   );
 
   const empty =
@@ -148,7 +245,7 @@ export function CustomersPage() {
         title={t('customers.noMatchTitle', { query: settled })}
         description={t('customers.noMatchBody')}
       />
-    ) : status === 'archived' ? (
+    ) : archived ? (
       <EmptyState
         icon={UserMultiple02Icon}
         title={t('customers.archivedEmptyTitle')}
@@ -222,8 +319,25 @@ export function CustomersPage() {
         />
       </div>
       {!canManage && <p className="text-body-sm text-ink-3">{t('customers.readOnly')}</p>}
-      {isError && <p className="text-body-sm text-crit">{t('customers.loadFailed')}</p>}
-      {customers && (
+      {notice !== null && <SyncNotice code={notice} />}
+      {archived && server.isError && (
+        <p className="text-body-sm text-crit">{t('customers.loadFailed')}</p>
+      )}
+      {!archived && canSeeBalance && view.kind === 'ready' && !online && (
+        <p className="text-body-sm text-ink-3">{t('customers.balancesOffline')}</p>
+      )}
+      {!archived && canSeeBalance && online && balances.failed && (
+        <p className="text-body-sm text-crit">{t('customers.balancesFailed')}</p>
+      )}
+      {!archived && view.kind !== 'ready' && <LocalState view={view} />}
+      {archived && !online && (
+        <EmptyState
+          icon={WifiDisconnected02Icon}
+          title={t('sync.needsConnectionTitle')}
+          description={t('customers.archivedOfflineBody')}
+        />
+      )}
+      {customers && (archived ? online : view.kind === 'ready') && (
         <DataTable
           label={t('customers.title')}
           data={customers}
```

- **`PAGE = MAX_BALANCE_IDS` (100),** so each step of scrolling is one more balances request.
- **`chunksOf()` cuts the shown ids into groups of 100.** Scrolling adds rows at the end, so the earlier groups keep
  their ids and their cached answers; only the new group is asked for.
- **`useQueries` with `combine: combineBalances`, declared outside the component.** TanStack runs `combine` again only
  when the answers or the function change. An inline function would make a new map on every render, a new `customers`
  array, and the table would sort again each time.
- **A missing balance is a dash, never "Nothing owed":** it is not here yet, or there is no connection, and zero would
  be a wrong answer about money. Offline, the dash has `customers.balancesOffline` for screen readers, and the same
  line shows above the table (decision 10). `balancesFailed` shows when the route fails online; the rows still show.
- **Offline, every balance is a dash,** also one that TanStack still keeps from a minute ago: `balance: online ? … :
  null`, with `online` in the memo's list. A balance that may be wrong by now is worse than none. (18a.7's offline
  test found this: the first version showed the cached balance under the line that says balances need a connection.)
- **The archived tab keeps the server's own balances,** which the list route already sends.

### The pickers

```diff
@@ -1,14 +1,17 @@
 import { UserIcon } from '@hugeicons/core-free-icons';
 import type { PartyRef, PartyRole } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
+import { findCustomers, type SyncDatabase } from '@omnivo/sync';
 import { Combobox, type ComboboxOption } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
-import { type Ref, useMemo, useState } from 'react';
+import { type Ref, useCallback, useMemo, useState } from 'react';
 
 import { partyLabel } from '../lib/customers';
-import { customerSearchQuery, supplierSearchQuery } from '../lib/queries';
+import { useLocalData, useLocalQuery } from '../lib/local-data';
+import { supplierSearchQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { useDebounced } from '../lib/use-debounced';
+import { useLocalStateText } from './local-state';
 
 export interface PartyPickerProps {
   id: string;
@@ -51,8 +54,9 @@ const WORDS = {
 } as const satisfies Record<PartyRole, Record<string, string>>;
 
 // The party box of a journal line and of the opening balances (step 15a's customer box, step 17a
-// for both sides): ui's Combobox with the search on the server. Active parties only, like the API
-// takes them on a new line. A receivable line picks a customer, a payable line a supplier
+// for both sides): ui's Combobox. Active parties only, like the API takes them on a new line.
+// Step 18a: a customer is searched on the device (decision 5), online or not; a supplier is not on
+// the device, so it is still searched on the server. A receivable line picks a customer, a payable line a supplier
 // (partyRoleOf in the contracts).
 // `...box`: id, name, onBlur, ref and the aria props go to the Combobox as they came. Spread, not
 // one by one: with exactOptionalPropertyTypes, `name={name}` would pass an explicit undefined.
@@ -68,18 +72,22 @@ export function PartyPicker({
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const [search, setSearch] = useState('');
   const settled = useDebounced(search.trim(), 250);
-  // Both hooks, each enabled for its side only: a hook cannot be called conditionally, and the two
-  // queries return different types, so one useQuery over a choice of options would not type-check
-  const customers = useQuery({
-    ...customerSearchQuery(tenantId, settled),
-    enabled: role === 'customer',
-  });
+  // Both reads, each for its side only: a hook cannot be called conditionally
+  const { view } = useLocalData();
+  const stateText = useLocalStateText();
+  const find = useCallback((db: SyncDatabase) => findCustomers(db, settled), [settled]);
+  const customers = useLocalQuery(role === 'customer' && view.kind === 'ready' ? find : null);
   const suppliers = useQuery({
     ...supplierSearchQuery(tenantId, settled),
     enabled: role === 'supplier',
   });
-  const found = role === 'customer' ? customers : suppliers;
-  const matches: PartyMatch[] | undefined = found.data;
+  const matches: PartyMatch[] | undefined = role === 'customer' ? customers : suppliers.data;
+  // A customer box on a device without a copy says why it is empty ("This device is not set up
+  // yet"), instead of "No active customer matches"
+  const emptyText =
+    role === 'customer' && view.kind !== 'ready'
+      ? (stateText(view) ?? t(WORDS.customer.empty))
+      : t(WORDS[role].empty);
   // The label of what was picked here. A row keeps its own picker (React's key), so a removed row
   // never hands its label to the next one.
   const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
@@ -119,12 +127,13 @@ export function PartyPicker({
         setPicked({ value: next, label: party ? partyLabel(party) : option.label });
         onChange(next);
       }}
-      // Searching for the next word: the old matches stay, marked busy
-      loading={found.isFetching}
+      // Searching the server for the next word: the old matches stay, marked busy. The device
+      // answers within a frame, so there is nothing to show for a customer.
+      loading={role === 'supplier' && suppliers.isFetching}
       icon={UserIcon}
       placeholder={allLabel ?? t(WORDS[role].placeholder)}
       searchPlaceholder={t(WORDS[role].search)}
-      emptyText={t(WORDS[role].empty)}
+      emptyText={emptyText}
     />
   );
 }
```

- **A customer from the device, a supplier from the server** (decision 48): both reads stay, each for its own side,
  because a hook cannot be called conditionally. The customer read is `null` for a supplier box, so it reads nothing.
- **`loading` only for a supplier.** The device answers within a frame; a "Searching…" line would only flicker.
- **The empty line says why** on a device without a copy ("This device is not set up yet"), instead of "No active
  customer matches", which would send the person looking for a customer that exists.

```diff
@@ -7,22 +7,24 @@ import {
   Wrench01Icon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
-import type { Product, ProductSummary } from '@omnivo/contracts';
+import type { Product } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
+import { findProducts, productSummaryOf, type SyncDatabase } from '@omnivo/sync';
 import { Button, DialogContent, EmptyState, Input, Pill } from '@omnivo/ui';
-import { useQuery, useQueryClient } from '@tanstack/react-query';
-import { useState } from 'react';
+import { useCallback, useState } from 'react';
 
-import { productQuery, productSearchQuery } from '../lib/queries';
+import { useLocalData, useLocalQuery } from '../lib/local-data';
 import { useDebounced } from '../lib/use-debounced';
 import { failureOf } from './journal-parts';
-import { useTenantId } from './stock-parts';
+import { LocalState } from './local-state';
 
 // "Add items": search the products and services, then add one. The dialog stays open, so a long
 // order is put together without closing it; each click adds the product's lines at once. Moved
 // out of sales-line-editor.tsx in step 17a: the requisition's lines (purchase-lines-editor.tsx)
 // add items the same way. `words` names the section the texts come from, so each document speaks
 // its own language ("Each click adds a line in its selling unit" or "… its buying unit").
+// Step 18a: the products are searched on the device (decision 5), and a match is the whole
+// product with its variants and packs, so adding it needs no second request.
 export function ProductPicker({
   words,
   description,
@@ -37,22 +39,22 @@ export function ProductPicker({
   maxLines: number;
 }) {
   const { t, errorText } = useLocale();
-  const tenantId = useTenantId();
-  const queryClient = useQueryClient();
   const [search, setSearch] = useState('');
   const settled = useDebounced(search.trim(), 250);
   const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
   const [loading, setLoading] = useState<string | null>(null);
   const [problem, setProblem] = useState<string | null>(null);
-  const { data: products } = useQuery(productSearchQuery(tenantId, settled));
+  const { view } = useLocalData();
+  const find = useCallback((db: SyncDatabase) => findProducts(db, settled), [settled]);
+  const products = useLocalQuery(view.kind === 'ready' ? find : null);
 
-  // The list sends a summary; the variants, the packs and the selling unit come with the product
-  const add = async (summary: ProductSummary) => {
-    setLoading(summary.id);
+  // onAdd may still ask the server (a purchase order's last price paid), so it can fail
+  const add = async (product: Product) => {
+    setLoading(product.id);
     setProblem(null);
     try {
-      const fits = await onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
-      if (fits) setAdded((before) => new Set(before).add(summary.id));
+      const fits = await onAdd(product);
+      if (fits) setAdded((before) => new Set(before).add(product.id));
       else setProblem(t(`${words}.tooMany`, { max: maxLines }));
     } catch (error) {
       setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
@@ -84,7 +86,9 @@ export function ProductPicker({
             {problem}
           </p>
         )}
-        {products?.length === 0 ? (
+        {view.kind !== 'ready' ? (
+          <LocalState view={view} actions={false} />
+        ) : products?.length === 0 ? (
           <EmptyState
             icon={PackageSearchIcon}
             title={t(`${words}.pickerEmpty`)}
@@ -92,40 +96,43 @@ export function ProductPicker({
           />
         ) : (
           <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
-            {products?.map((product) => (
-              <li
-                key={product.id}
-                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
-              >
-                <span className="grid min-w-0 flex-1">
-                  <span className="truncate text-body-sm font-medium">{product.name}</span>
-                  <span className="truncate text-caption text-ink-3">
-                    <span className="font-mono tabular-nums">{product.code}</span>
-                    {product.hasVariants &&
-                      ` · ${t('products.variantCount', { count: product.variantCount })}`}
-                  </span>
-                </span>
-                {/* A service (a repair, a delivery charge) is bought or sold, never stocked */}
-                {product.type === 'service' && (
-                  <Pill tone="neutral" icon={Wrench01Icon}>
-                    {t(`${words}.service`)}
-                  </Pill>
-                )}
-                <Button
-                  variant="secondary"
-                  size="sm"
-                  disabled={loading === product.id}
-                  onClick={() => void add(product)}
+            {products?.map((product) => {
+              const summary = productSummaryOf(product);
+              return (
+                <li
+                  key={product.id}
+                  className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
                 >
-                  <HugeiconsIcon
-                    icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
-                    size={16}
-                    strokeWidth={1.5}
-                  />
-                  {added.has(product.id) ? t(`${words}.added`) : t(`${words}.add`)}
-                </Button>
-              </li>
-            ))}
+                  <span className="grid min-w-0 flex-1">
+                    <span className="truncate text-body-sm font-medium">{product.name}</span>
+                    <span className="truncate text-caption text-ink-3">
+                      <span className="font-mono tabular-nums">{product.code}</span>
+                      {summary.hasVariants &&
+                        ` · ${t('products.variantCount', { count: summary.variantCount })}`}
+                    </span>
+                  </span>
+                  {/* A service (a repair, a delivery charge) is bought or sold, never stocked */}
+                  {product.type === 'service' && (
+                    <Pill tone="neutral" icon={Wrench01Icon}>
+                      {t(`${words}.service`)}
+                    </Pill>
+                  )}
+                  <Button
+                    variant="secondary"
+                    size="sm"
+                    disabled={loading === product.id}
+                    onClick={() => void add(product)}
+                  >
+                    <HugeiconsIcon
+                      icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
+                      size={16}
+                      strokeWidth={1.5}
+                    />
+                    {added.has(product.id) ? t(`${words}.added`) : t(`${words}.add`)}
+                  </Button>
+                </li>
+              );
+            })}
           </ul>
         )}
       </div>
```

- **A match is the whole product.** The old picker fetched it (`productQuery`) on each click; the device has it
  already, with its variants and packs, so the click adds the lines at once, offline too.
- **The `try` stays:** `onAdd` may still ask the server (a purchase order's last price paid), and that can fail.
- **`productSummaryOf()`** gives the variant count shown under the name, from the same rule as the list.
- `useTenantId` and `useQueryClient` go: nothing in the picker asks the server now.

### Check this part

```bash
pnpm install
pnpm --filter @omnivo/sync typecheck
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
```

Build `@omnivo/sync` before the app's type check: the app reads its built types, like the other packages.

The end-to-end tests do not pass yet after this part: the mock API of `pnpm dev:mock` has no `/sync` routes, so the
products and customers pages wait for a device that never registers. 18a.7 adds them.

To see it work against the real API, run `pnpm dev`, sign in, and open Products. In the browser's tools, Application
→ IndexedDB shows a database `omnivo-<workspace>-<user>` with the tables above. Save a product and go back to the
list: it is there at once (decision 43). Then turn the network off in the tools' Network tab and move between
Products and Customers: both lists, their search and their sort still work, and the Archived tab says "Needs a
connection". A reload while offline does not work yet; that is step 19's service worker.

> **What we checked in this part.** `packages/sync` type-checks, ESLint and Prettier are clean, and its 35 unit tests
> pass (apply 8, engine 9, device 11, queries 7, with `fake-indexeddb`). The app type-checks (all three tsconfigs),
> ESLint and Prettier are clean, its 135 unit tests pass, it builds, the bundle budget passes (first load 205.4 KB gz;
> the largest lazy chunk 104.3 KB, the host with Dexie 103.1 KB), and dependency-cruiser finds no violation. Three
> rules were broken on purpose, one at a time, and a test failed each time: the sweep at the end of a full pull, the
> "no cursor starts over" rule (which first had no test: we added "a pull sent without a cursor starts over"), and
> the engine's one-more-run. We also ran the app against the real API in a browser (Playwright, on throwaway
> Postgres and Valkey containers): sign-up and setup, the silent registration with one branch, the first pull, a
> delta pull on focus, the local search, the balances from the server, both lists and the archived tab offline, the
> branch dialog (empty box refused, then registered and named "Chrome on macOS"), "Not now" remembered across a
> reload with the button reopening the dialog, the customer box of a new quotation reading the device, and sign-out
> deleting the database while keeping the device's id.


## 18a.7 — `apps/app`: the mock API and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). After 18a.6 the
products and customers pages read only the device's copy, and the mock had no `/sync` routes: the pages waited for a
device that never registered, and every products and customers test failed. This part teaches the mock the three
routes of 18a (register a device, pull, the balances of the rows on screen), sets the tests' device up before the app
starts, and adds one test file for the copy: the branch dialog, working offline, a save reaching the copy, and
sign-out deleting it.

The new offline test found one mistake in 18a.6: after the connection dropped, the customer list still showed the
balances TanStack had kept from a minute ago, right under the line "Balances need a connection". The fix is in 18a.6's
`routes/customers.tsx` above (decision 10: offline, a dash). Everything else worked as written.

The files, in the order to write them: each one only uses files above it.

### The mock's sync engine: `mocks/sync-data.ts` (new)

```ts
import {
  addQuantity,
  type Device,
  isZeroQuantity,
  priceListItemKey,
  type RegisterDeviceInput,
  stockKey,
  SYNC_PROTOCOL,
  syncCategorySchema,
  type SyncChange,
  type SyncEntity,
  type SyncPull,
  syncSettingsSchema,
  type SyncStock,
  type SyncUpsert,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
// Type-only: workspace-data.ts imports this file for emptySync(), and a type import is erased
// when the code is built, so it makes no circle
import type { WorkspaceData } from './workspace-data';

// The mock's sync engine (step 18a): the devices, and pulls worked out from the mock's own data.
// The API has a change log written by triggers; the mock has plain arrays that a hundred handlers
// change. So instead of a log, the mock remembers what each finished pull left the device with,
// and the next pull sends the difference. Every mock write (a new customer, an archived product, a
// posted stock adjustment) then reaches the device without one line in its handler.

// The rows a device holds, by `${entity}|${key}`, each with the row as JSON. Comparing JSON is
// enough: the mock builds a row's fields in the same order every time.
type Rows = Map<string, { entity: SyncEntity; key: string; json: string }>;

interface Finished {
  deviceId: string;
  branchId: string;
  rows: Rows;
}

// A pull that has more pages: what is still to send, and what the device holds when it is done
interface Paging {
  deviceId: string;
  changes: SyncChange[];
  full: boolean;
  finished: Finished;
}

export interface MockSync {
  devices: Device[];
  // A finished pull's cursor → what it left the device with. Only the newest one per device is
  // kept. A cursor the mock does not know starts a full pull, like a cursor older than the API's
  // change log: that is what happens after a reload, which starts the mock over but keeps the
  // device's copy in IndexedDB.
  finished: Map<string, Finished>;
  // A page's cursor → the rest of its pull
  paging: Map<string, Paging>;
  // When a stock row last changed. Movements have dates, not times, and a row's updatedAt must
  // stay the same while its quantity does, or every pull would send every stock row again.
  stamps: Map<string, { quantity: string; at: string }>;
}

export function emptySync(): MockSync {
  return { devices: [], finished: new Map(), paging: new Map(), stamps: new Map() };
}

function now(): string {
  return new Date().toISOString();
}

// --- Devices ------------------------------------------------------------------------------------

// The API's register (decision 37): the same id by the same person returns the device as it is,
// so a retry after a lost answer is not a second device; another person's id is refused.
// branchCode is set only for a new device: the handler writes its audit row with it.
export function registerDevice(
  data: WorkspaceData,
  userId: string,
  input: RegisterDeviceInput,
): { device: Device; branchCode: string | null } {
  const known = data.sync.devices.find((device) => device.id === input.id);
  if (known) {
    if (known.userId !== userId) throw new MockProblem(409, 'device_id_invalid');
    return { device: known, branchCode: null };
  }
  const branch = data.branches.find(
    (candidate) => candidate.id === input.branchId && candidate.archivedAt === null,
  );
  if (!branch) {
    throw new MockProblem(409, 'device_branch_invalid', {
      branchId: ['device_branch_invalid'],
    });
  }
  const device: Device = {
    id: input.id,
    name: input.name,
    branchId: branch.id,
    userId,
    lastSyncAt: null,
    revokedAt: null,
    createdAt: now(),
    version: 1,
  };
  data.sync.devices.push(device);
  return { device, branchCode: branch.code };
}

// The device a pull names: the signed-in person's own, and not revoked
function deviceFor(data: WorkspaceData, userId: string, id: string): Device {
  const device = data.sync.devices.find((candidate) => candidate.id === id);
  if (device?.userId !== userId) throw new MockProblem(404, 'device_not_found');
  if (device.revokedAt !== null) throw new MockProblem(403, 'device_revoked');
  return device;
}

// --- The rows a device keeps --------------------------------------------------------------------

// The stock in the branch's active warehouses, from the movements: one row per variant and batch,
// none at zero, none of an archived product (the API's stock loader)
function stockRows(
  data: WorkspaceData,
  warehouseIds: ReadonlySet<string>,
  activeProducts: ReadonlySet<string>,
): SyncStock[] {
  const totals = new Map<string, SyncStock>();
  for (const movement of data.stock.movements) {
    if (!warehouseIds.has(movement.warehouseId) || !activeProducts.has(movement.productId)) {
      continue;
    }
    const key = stockKey(movement);
    const before = totals.get(key);
    if (before) {
      before.quantity = addQuantity(before.quantity, movement.quantity);
      continue;
    }
    const batch = data.stock.batches.find((candidate) => candidate.id === movement.batchId);
    totals.set(key, {
      warehouseId: movement.warehouseId,
      productId: movement.productId,
      variantId: movement.variantId,
      batchId: movement.batchId,
      lotNumber: batch?.lotNumber ?? null,
      manufacturedOn: batch?.manufacturedOn ?? null,
      expiresOn: batch?.expiresOn ?? null,
      // addQuantity gives 4 decimals, like the API's NUMERIC(19,4)
      quantity: addQuantity('0', movement.quantity),
      updatedAt: '',
    });
  }
  return [...totals.entries()]
    .filter(([, row]) => !isZeroQuantity(row.quantity))
    .map(([key, row]) => {
      const stamp = data.sync.stamps.get(key);
      if (stamp?.quantity === row.quantity) return { ...row, updatedAt: stamp.at };
      const at = now();
      data.sync.stamps.set(key, { quantity: row.quantity, at });
      return { ...row, updatedAt: at };
    });
}

// Every row the device of this branch keeps, in the order of SYNC_ENTITIES: what a list points at
// comes before the list
function rowsOf(data: WorkspaceData, tenantId: string, branchId: string): SyncUpsert[] {
  const { catalog, sales, stock } = data;
  const products = catalog.products.filter((product) => product.archivedAt === null);
  const activeProducts = new Set(products.map((product) => product.id));
  const activeLists = new Set(
    sales.priceLists.filter((list) => list.archivedAt === null).map((list) => list.id),
  );
  const warehouses = stock.warehouses.filter(
    (warehouse) => warehouse.branchId === branchId && warehouse.archivedAt === null,
  );
  const warehouseIds = new Set(warehouses.map((warehouse) => warehouse.id));
  return [
    // The schemas' parse keeps only the fields the device needs: the settings a sale uses, a
    // category without its product count
    {
      op: 'upsert',
      entity: 'settings',
      key: tenantId,
      data: syncSettingsSchema.parse(data.settings),
    },
    ...catalog.units.map((unit) => ({
      op: 'upsert' as const,
      entity: 'unit' as const,
      key: unit.id,
      data: unit,
    })),
    ...catalog.categories.map((category) => ({
      op: 'upsert' as const,
      entity: 'product_category' as const,
      key: category.id,
      data: syncCategorySchema.parse(category),
    })),
    ...sales.taxRates.map((rate) => ({
      op: 'upsert' as const,
      entity: 'tax_rate' as const,
      key: rate.id,
      data: rate,
    })),
    ...warehouses.map((warehouse) => ({
      op: 'upsert' as const,
      entity: 'warehouse' as const,
      key: warehouse.id,
      data: warehouse,
    })),
    ...sales.priceLists.map((list) => ({
      op: 'upsert' as const,
      entity: 'price_list' as const,
      key: list.id,
      data: list,
    })),
    ...sales.groups.map((group) => ({
      op: 'upsert' as const,
      entity: 'customer_group' as const,
      key: group.id,
      data: group,
    })),
    ...products.map((product) => ({
      op: 'upsert' as const,
      entity: 'product' as const,
      key: product.id,
      data: product,
    })),
    // A price of an active list, for an active product
    ...sales.priceItems
      .filter((item) => activeLists.has(item.priceListId) && activeProducts.has(item.productId))
      .map((item) => ({
        op: 'upsert' as const,
        entity: 'price_list_item' as const,
        key: priceListItemKey(item),
        data: item,
      })),
    ...sales.customers
      .filter((customer) => customer.archivedAt === null)
      .map((customer) => ({
        op: 'upsert' as const,
        entity: 'customer' as const,
        key: customer.id,
        data: customer,
      })),
    ...stockRows(data, warehouseIds, activeProducts).map((row) => ({
      op: 'upsert' as const,
      entity: 'stock' as const,
      key: stockKey(row),
      data: row,
    })),
  ];
}

function rowKey(change: SyncChange): string {
  return `${change.entity}|${change.key}`;
}

// The difference between what the device holds and what it should hold: the rows that are new or
// changed, then the keys of the rows that left (deleted, archived, moved to another branch, at zero)
function changesSince(before: Rows, upserts: readonly SyncUpsert[], rows: Rows): SyncChange[] {
  const changed = upserts.filter(
    (change) => before.get(rowKey(change))?.json !== rows.get(rowKey(change))?.json,
  );
  const gone = [...before]
    .filter(([id]) => !rows.has(id))
    .map(([, row]): SyncChange => ({ op: 'delete', entity: row.entity, key: row.key }));
  return [...changed, ...gone];
}

// --- The pull -----------------------------------------------------------------------------------

export function pull(
  data: WorkspaceData,
  tenantId: string,
  userId: string,
  query: { deviceId: string; protocol: number; cursor?: string | undefined; limit: number },
): SyncPull {
  // The protocol first, like the API: an old app is told to reload before anything else
  if (query.protocol !== SYNC_PROTOCOL) throw new MockProblem(409, 'sync_protocol_mismatch');
  const device = deviceFor(data, userId, query.deviceId);
  const { sync } = data;
  let paging = query.cursor === undefined ? undefined : sync.paging.get(query.cursor);
  if (query.cursor !== undefined) sync.paging.delete(query.cursor);
  if (!paging) {
    const upserts = rowsOf(data, tenantId, device.branchId);
    const rows: Rows = new Map(
      upserts.map((change) => [
        rowKey(change),
        { entity: change.entity, key: change.key, json: JSON.stringify(change.data) },
      ]),
    );
    const before = query.cursor === undefined ? undefined : sync.finished.get(query.cursor);
    // A device that moved to another branch starts again, like the API (its cursor holds the
    // branch): another branch's stock must not stay on it
    const delta = before?.deviceId === device.id && before.branchId === device.branchId;
    paging = {
      deviceId: device.id,
      changes: delta ? changesSince(before.rows, upserts, rows) : upserts,
      full: !delta,
      finished: { deviceId: device.id, branchId: device.branchId, rows },
    };
  }
  const page = paging.changes.slice(0, query.limit);
  const rest = paging.changes.slice(query.limit);
  const serverTime = now();
  const cursor = crypto.randomUUID();
  if (rest.length > 0) {
    sync.paging.set(cursor, { ...paging, changes: rest });
  } else {
    // The newest finished pull of this device is the only one kept: an older cursor would only
    // come back from a lost answer, and a full pull is the right answer to that
    for (const [key, finished] of sync.finished) {
      if (finished.deviceId === device.id) sync.finished.delete(key);
    }
    sync.finished.set(cursor, paging.finished);
    // Only the last page sets it, like the API: a pull that stops halfway has not synced
    device.lastSyncAt = serverTime;
  }
  return { changes: page, cursor, hasMore: rest.length > 0, full: paging.full, serverTime };
}
```

- **No change log; a snapshot per device** (decision 51). `Rows` holds every row a finished pull left the device with,
  as JSON, keyed by `entity|key`. The next pull builds the rows again and sends what differs: a row that is new or
  whose JSON changed is an upsert, a key that is gone is a delete. Comparing JSON is safe here because the mock builds
  each row with its fields in the same order every time. The cost is one `JSON.stringify` of every row per pull,
  about 10,000 products in the garments workspace: a few tens of milliseconds, fine for a mock.
- **Only the newest finished pull per device is kept.** An older cursor only comes back when an answer was lost; a
  full pull is the right answer to that, as it is in the API for a cursor older than the log. It also keeps the
  mock's memory to one snapshot per device.
- **A cursor the mock does not know starts a full pull.** That happens after every reload: the mock starts over, but
  the copy in IndexedDB stays, with the old cursor. The device then drops what the full pull did not send (18a.6's
  sweep), so it can never keep a row the new mock does not have.
- **`delta` also checks the device and its branch.** A cursor from another device is not this device's state, and a
  device moved to another branch must lose the old branch's stock, like the API's cursor that holds the branch.
- **`paging` holds the rest of a pull.** The first page works out all the changes at once, and the next pages only
  slice them, so a pull of 21 pages builds the rows once, not 21 times. A page's cursor is used once: it is deleted
  when it is read, like a cursor the API would refuse after the pull moved on.
- **`lastSyncAt` only on the last page,** like the API: a pull that stopped halfway has not synced.
- **`stockRows()` is the API's stock loader, on the mock's movements:** one row per warehouse, variant and batch, in
  the branch's active warehouses, never zero, never for an archived product. Lot number and dates come from the
  batch. `addQuantity('0', …)` gives the 4 decimals the API sends.
- **`stamps` keeps a stock row's `updatedAt` steady.** Movements have dates, not times. With `now()` in every pull,
  each stock row's JSON would change every time, and every pull would send all the stock again. The time changes
  only when the quantity does.
- **`rowsOf()` follows the API's scope (18a.3):** all units, categories, VAT rates, price lists and groups; active
  products; prices of active lists for active products; active customers; the branch's active warehouses. The
  settings and the categories go through their sync schemas' `parse()`, which keeps only the fields a device holds
  (no logo, no product count).
- **`registerDevice()` is the API's rules (decision 37):** the same id by the same person returns the device as it is;
  another person's id is `device_id_invalid`; a branch that is not active is `device_branch_invalid` under the box.
  It returns the branch code only for a new device, and the handler writes the audit row with it.
- **`import type` from `workspace-data.ts`, and no `record()` here.** `workspace-data.ts` imports this file for
  `emptySync()`. A value import back (such as `record`) would be a circle, which dependency-cruiser refuses; a type
  import is erased when the code is built, the way the other mock files do it.
- **`deviceFor()`:** an unknown id, or another person's, is `device_not_found` (404), which makes the app register
  again (decision 49); a revoked one is `device_revoked` (403). Revoking comes with 18c's routes.
- **The protocol is checked first,** like the API: an app of another version is told to reload before anything else.

### The workspace keeps its sync state: `mocks/workspace-data.ts`

```diff
@@ -36,7 +36,7 @@ import {
   type MockDocumentOutput,
   seedDocumentOutput,
 } from './document-output-data';
-import { OWNER, type Workspace } from './fixtures';
+import { HEAD_OFFICES, OWNER, type Workspace } from './fixtures';
 import { emptyBilling, type MockBilling } from './invoice-data';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
@@ -54,6 +54,7 @@ import {
 } from './sales-document-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
 import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
+import { emptySync, type MockSync } from './sync-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -97,15 +98,23 @@ export interface WorkspaceData {
   // Approval levels and rounds, and requisitions (step 17a); purchase orders and goods receipts
   // (step 17b)
   purchase: MockPurchase;
+  // The devices and what their pulls left them with (step 18a)
+  sync: MockSync;
 }
 
 function now(): string {
   return new Date().toISOString();
 }
 
-function branch(code: string, name: string, address: string, archived = false): Branch {
+function branch(
+  code: string,
+  name: string,
+  address: string,
+  archived = false,
+  id: string = crypto.randomUUID(),
+): Branch {
   return {
-    id: crypto.randomUUID(),
+    id,
     code,
     name,
     phone: '+880 1711-000000',
@@ -138,12 +147,26 @@ function seed(workspace: Workspace): WorkspaceData {
     },
     branches: garments
       ? [
-          branch('HO', 'Head office', 'House 42, Road 11, Banani, Dhaka 1213'),
+          branch(
+            'HO',
+            'Head office',
+            'House 42, Road 11, Banani, Dhaka 1213',
+            false,
+            HEAD_OFFICES[workspace.slug],
+          ),
           branch('GZP', 'Gazipur factory', 'BSCIC Industrial Area, Konabari, Gazipur 1751'),
           branch('CTG', 'Chattogram depot', 'Port Connecting Road, Chattogram 4100'),
           branch('NGJ', 'Narayanganj dyeing unit', 'Fatullah, Narayanganj 1421', true),
         ]
-      : [branch('HO', 'Head office', 'Tejgaon Industrial Area, Dhaka 1208')],
+      : [
+          branch(
+            'HO',
+            'Head office',
+            'Tejgaon Industrial Area, Dhaka 1208',
+            false,
+            HEAD_OFFICES[workspace.slug],
+          ),
+        ],
     series: new Map(),
     audit: [],
     people: seedPeople(workspace),
@@ -166,6 +189,7 @@ function seed(workspace: Workspace): WorkspaceData {
     documentOutput: emptyDocumentOutput(),
     suppliers: emptySuppliers(),
     purchase: emptyPurchase(),
+    sync: emptySync(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   data.salesAccounts = seedSalesAccounts(data.accounts);
```

- **`sync: emptySync()` in every workspace.** Devices are per workspace, like the API's `tenant_id`. Sign-up's
  `startFresh()` seeds the workspace again, so a new workspace starts with no devices: the app's device gets
  `device_not_found` and registers again.
- **The head office gets its fixed id** from `HEAD_OFFICES` (decision 52). The other branches keep random ids: no test
  needs to know them.

### Fixed ids: `mocks/fixtures.ts`

```diff
@@ -5,16 +5,29 @@ import {
   type SetupStatus,
 } from '@omnivo/contracts';
 
-// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে
+// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে.
+// Step 18a: fixed ids, the same after every reload. The device's copy is kept per workspace and
+// person, so a reload finds its copy again, and the e2e tests can set the device up before the
+// app starts (e2e/helpers.ts).
 export const WORKSPACES = [
-  { tenantId: crypto.randomUUID(), name: 'Rahman Garments Ltd.', slug: 'rahman-garments' },
-  { tenantId: crypto.randomUUID(), name: 'Karim Pharma', slug: 'karim-pharma' },
+  {
+    tenantId: '96d949e2-58a4-4d50-b52d-bf4619d130d1',
+    name: 'Rahman Garments Ltd.',
+    slug: 'rahman-garments',
+  },
+  { tenantId: 'e4ab91bc-b92e-4999-a5c4-538dec638d15', name: 'Karim Pharma', slug: 'karim-pharma' },
 ] as const;
 
 export type Workspace = (typeof WORKSPACES)[number];
 
+// The head office of each workspace, the branch the e2e tests' device is in
+export const HEAD_OFFICES = {
+  'rahman-garments': 'cf6fbdda-60ec-46a9-a809-e26624969bf7',
+  'karim-pharma': '07cf0e23-ec6c-4505-9410-c80aa2fc4aef',
+} as const satisfies Record<Workspace['slug'], string>;
+
 const owner = {
-  id: crypto.randomUUID(),
+  id: '71551ffc-0452-4c39-a3ec-62801c29834e',
   email: 'farhana@rahmangarments.com',
   fullName: 'Farhana Rahman',
 };
```

- **The two workspaces, the owner and the head offices have fixed ids** (decision 52). Before, they were new on every
  page load. Now the device's copy (`omnivo-<workspace>-<user>`) and its identity in `localStorage` are found again
  after a reload, as they are with the real API, and the tests can write the device before the app starts.
- **`satisfies Record<Workspace['slug'], string>`:** a third workspace without a head office id is a type error.
- Any fixed UUID works; these were made once with a UUID generator. They are not UUIDv7: the mock makes them, not the
  app, and only a device id must be a v7 (decision 20).

### The routes: `mocks/handlers.ts`

```diff
@@ -201,6 +201,7 @@ import {
   assertGroupNameFree,
   assertPriceListNameFree,
   assertProductTaxRate,
+  balanceOf,
   createTaxRate,
   customerSummaryOf,
   dropStalePrices,
@@ -302,6 +303,7 @@ import {
   toSupplier,
   toSupplierGroup,
 } from './supplier-data';
+import { pull, registerDevice } from './sync-data';
 import {
   assertCodeFree,
   checkVersion,
@@ -612,6 +614,11 @@ function paymentSnapshot(payment: MockSupplierPayment) {
 // UI-র প্রতিটা পথ দেখার জন্য: লগইনে পাসওয়ার্ড "wrong-password" → invalid_credentials,
 // সাইনআপে ঠিকানা "rahman-garments" → slug_taken
 export const handlers = [
+  // Step 18a: an offline browser (Playwright's context.setOffline, DevTools' "Offline") gets what a
+  // dead network gives, a failed fetch. MSW runs these handlers inside the page, so without this
+  // the mock would answer every request with the network off. undefined = on to the next handler.
+  http.all(`${API_URL}/*`, () => (navigator.onLine ? undefined : HttpResponse.error())),
+
   mock(routes.health.check, () => reply(routes.health.check, { status: 'ok' })),
 
   mock(routes.auth.refresh, () =>
@@ -2631,6 +2638,18 @@ export const handlers = [
     }),
   ),
 
+  // The balances of the rows the customer list shows (step 18a): archived customers too, an id
+  // that is no customer here left out
+  mock(routes.customers.balances, ({ request }) => {
+    const { ids } = readQuery(routes.customers.balances.query, request);
+    const data = current();
+    const known = new Set(data.sales.customers.map((customer) => customer.id));
+    const items = ids
+      .filter((id) => known.has(id))
+      .map((id) => ({ id, balance: balanceOf(data, id) }));
+    return reply(routes.customers.balances, { items });
+  }),
+
   // The credit line on the order and invoice forms (step 15c)
   mock(
     routes.customers.credit,
@@ -4942,4 +4961,30 @@ export const handlers = [
       return reply(routes.purchaseAccounts.update, data.purchaseAccounts);
     }),
   ),
+
+  // Step 18a: the device and its pulls (sync-data.ts). The mock's person is always the owner.
+  mock(
+    routes.sync.registerDevice,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.sync.registerDevice.body, request);
+      const data = current();
+      const { device, branchCode } = registerDevice(data, OWNER.id, body);
+      // The API's audit row, for a new device only
+      if (branchCode !== null) {
+        record(data, 'device.registered', 'device', device.id, {
+          name: { from: null, to: device.name },
+          branch: { from: null, to: branchCode },
+        });
+      }
+      return reply(routes.sync.registerDevice, device);
+    }),
+  ),
+
+  mock(
+    routes.sync.pull,
+    guarded(({ request }) => {
+      const query = readQuery(routes.sync.pull.query, request);
+      return reply(routes.sync.pull, pull(current(), workspace.tenantId, OWNER.id, query));
+    }),
+  ),
 ];
```

- **The offline handler comes first** (decision 54). MSW runs the handlers in the page: with the network off, the
  mock would still answer every request. `HttpResponse.error()` is what a dead network gives `fetch`: a `TypeError`,
  no status. Returning `undefined` passes the request on to the next handler. In 18a no test fails without it,
  because the app itself does not fetch while offline (TanStack pauses its queries, and the engine's timer waits for
  `online`). It is there so that anything that does fetch offline sees what it would see for real.
- **`/customer-balances`** answers the ids that are customers of this workspace, archived ones too, and leaves the
  others out, like the API. `balanceOf()` is the one the customer page and the list already use, so the three agree.
- **`registerDevice` and `pull` throw `MockProblem`s; `guarded()` turns them into problem responses.** The mock's
  person is always the owner, so `OWNER.id` is the user.
- **The audit row `device.registered` is written here, for a new device only** (name and branch code, like the API).
  Registering the same device again writes nothing.

### The tests' device and the wait for the copy: `e2e/helpers.ts`

```diff
@@ -1,4 +1,87 @@
-import { expect, type Locator, type Page } from '@playwright/test';
+import { syncPullSchema } from '@omnivo/contracts';
+import { newDeviceId, saveDevice } from '@omnivo/sync';
+import { test as base, expect, type Locator, type Page, type Response } from '@playwright/test';
+
+import { HEAD_OFFICES, OWNER, WORKSPACES } from '../src/mocks/fixtures.js';
+
+export { expect };
+
+const copies = new WeakMap<Page, Promise<void>>();
+
+// The first pull of the copy ends: a page of /sync/pull with nothing more to send
+function copyOf(page: Page): Promise<void> {
+  return new Promise((resolve) => {
+    const listener = (response: Response) => {
+      if (!response.url().includes('/sync/pull') || !response.ok()) return;
+      void response.json().then(
+        (body: unknown) => {
+          const parsed = syncPullSchema.pick({ hasMore: true }).safeParse(body);
+          if (parsed.success && !parsed.data.hasMore) {
+            page.off('response', listener);
+            resolve();
+          }
+        },
+        // The page closed before the body was read
+        () => undefined,
+      );
+    };
+    page.on('response', listener);
+  });
+}
+
+// Step 18a: every test imports `test` from here. The garments workspace has three active branches,
+// so a new device asks which branch it is in (decision 12), and each test is a new browser profile,
+// a new device. Before the app starts, the fixture leaves in localStorage what that dialog leaves:
+// a device of the head office. The mock does not know the device, so the first pull registers it
+// again (device_not_found → registerAgain) and the dialog never shows. The key and the value come
+// from @omnivo/sync's own saveDevice(), so their format is written in one place. A test of the
+// dialog itself turns this off with test.use({ seedDevice: false }).
+export const test = base.extend<{ seedDevice: boolean }>({
+  seedDevice: [true, { option: true }],
+  // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
+  page: async ({ page, seedDevice }, provide) => {
+    copies.set(page, copyOf(page));
+    if (seedDevice) {
+      const [garments] = WORKSPACES;
+      const saved = new Map<string, string>();
+      saveDevice(
+        { getItem: () => null, setItem: (key, value) => saved.set(key, value) },
+        garments.tenantId,
+        OWNER.id,
+        { id: newDeviceId(), branchId: HEAD_OFFICES[garments.slug], later: false },
+      );
+      // Only when nothing is there: a reload keeps what the app saved since
+      await page.addInitScript(
+        (entries) => {
+          for (const [key, value] of entries) {
+            if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
+          }
+        },
+        [...saved],
+      );
+    }
+    await provide(page);
+  },
+});
+
+// Until the device holds its first full copy. The products and customers pages and the pickers
+// read only the copy (decision 5); the garments workspace's 10,000 styles take a few seconds to
+// arrive, more than an assertion's 5 seconds on a busy machine.
+export async function waitForCopy(page: Page): Promise<void> {
+  const copy = copies.get(page);
+  if (!copy) throw new Error('waitForCopy needs the page of the test fixture in helpers.ts');
+  let timer: NodeJS.Timeout | undefined;
+  const timeout = new Promise<never>((_, reject) => {
+    timer = setTimeout(() => {
+      reject(new Error('The first pull did not finish in 25 seconds'));
+    }, 25_000);
+  });
+  try {
+    await Promise.race([copy, timeout]);
+  } finally {
+    clearTimeout(timer);
+  }
+}
 
 // ডেস্কটপে টেবিলের রো, ফোনে কার্ড (role="button") — একই টেস্ট দুই আকারেই
 export function listItem(page: Page, name: string | RegExp): Locator {
```

- **`test` is Playwright's, extended.** Every test file now imports `test` and `expect` from here, so the fixture runs
  for every test.
- **`seedDevice`** (decision 52, on by default) writes in `localStorage`, before any of the app's code runs
  (`addInitScript`), what the branch dialog would leave: a new device id in the garments head office. The key and the
  value come from `saveDevice()` itself, given a small storage that only records what it is asked to write, so the
  test never spells out `omnivo.device.…`. The mock does not know the device, so its first pull answers
  `device_not_found`, and the app registers it again with that branch (decision 49): the same path as a device whose
  workspace was started over.
- **Only when nothing is there.** `addInitScript` runs again on every reload; the app may have saved something else
  since (a new id after `device_id_invalid`), and that must win.
- **Why not answer the dialog when it shows?** We tried a Playwright locator handler first. The dialog opens a moment
  after the page, and a test that opens the bell at once had two dialogs on the screen; both bell tests failed nearly
  every run.
- **`waitForCopy()`** (decision 53) waits for a `/sync/pull` answer with `hasMore: false`, the end of the first pull.
  Playwright sees the mock's answers as responses (the service worker sends them), so the test needs no hook in the
  app. It listens from the moment the page is made, so a pull that ends before the test asks is not missed. 25
  seconds, under the test's 30, so the error says what it waited for.
- **`provide`, not `use`,** for the fixture's callback: the React hooks lint rule reads `use(page)` as a React hook.
- **`@omnivo/sync` and `../src/mocks/fixtures.js` in a Node test file:** the package's index brings Dexie, which only
  touches IndexedDB when a database is opened, so importing it in Node is fine; the fixtures file has no browser code.
  Dependency-cruiser's mock rule covers `src/` only, so the tests may import the mock's ids.

### The tests import `test` from the helpers

The products list now waits for the copy before it searches:

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, waitForCopy } from './helpers.js';
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
@@ -19,6 +19,8 @@ async function newProduct(page: Page) {
 }
 
 test('finds a product by name or by a scanned barcode, and opens it', async ({ page }) => {
+  // The list reads the device's copy (step 18a): all 10,000 styles first
+  await waitForCopy(page);
   await openFromNav(page, 'Products');
   const search = page.getByRole('searchbox', { name: 'Search products' });
   await search.fill('pique');
```

Every other test file changes only its imports: `test` and `expect` come from `./helpers.js`, and what is left from
`@playwright/test` is types, so it becomes `import type`.

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, openFromNav, test } from './helpers.js';
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { listItem, openFromNav, readOnlyItem } from './helpers.js';
+import { expect, listItem, openFromNav, readOnlyItem, test } from './helpers.js';
 
 // ডেস্কটপে সাইডবারের নিচে নিজের নাম, ফোনে টপ বারের "Account" আইকন — একই মেনু। কোনটা, সেটা
 // viewport-এর চওড়া দেখে (৮৬০px-এর নিচে ফোনের layout), isVisible() দিয়ে না: পেজ আঁকা শেষ হওয়ার আগে
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 17c in the mock garments workspace, where the signed-in person is the Owner. Bills from
 // ৳1,00,000 with VAT need the Purchase manager, payments from ৳2,00,000 a Director, and an Owner's
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 15d: credit notes in the mock garments workspace. H&M's order SO-…-0001 bills 10 dozen polo
 // shirts at ৳6,900 a dozen, zero-rated (৳69,000). Aarong buys the crew-neck T-shirt at ৳290 a piece
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 // Step 15a in the mock garments workspace: five customers (C-00001 to C-00005, the last one
 // archived). H&M owes ৳38,50,000 from last year's export sale, Primark ৳24,50,000 from this
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 15b: deliveries (challans) against the seeded confirmed orders. Garments: H&M's
 // SO-…-0001, 5 dozen polo shirts in M and in L (Navy blue), from the Main store, which holds 120
```

```diff
@@ -1,8 +1,8 @@
 import { readFile } from 'node:fs/promises';
 
-import { type Download, expect, type Page, test } from '@playwright/test';
+import type { Download, Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 16 in the mock garments workspace. Aarong reads its documents in Bangla, has no email
 // address and a mobile number; its open quotation is QT-…-0003. H&M reads English; its declined
```

```diff
@@ -1,4 +1,4 @@
-import { expect, test } from '@playwright/test';
+import { expect, test } from './helpers.js';
 
 // mocks/people-data.ts-এর DEMO_TOKENS — ইমেইল ছাড়াই join পেজ
 test('joins with a new account from the email link', async ({ page }) => {
```

```diff
@@ -1,6 +1,14 @@
-import { expect, type Page, test } from '@playwright/test';
-
-import { expectNoSideScroll, listItem, openFromNav, readOnlyItem, toastShown } from './helpers.js';
+import type { Page } from '@playwright/test';
+
+import {
+  expect,
+  expectNoSideScroll,
+  listItem,
+  openFromNav,
+  readOnlyItem,
+  test,
+  toastShown,
+} from './helpers.js';
 
 // Step 15c in the mock garments workspace. H&M's confirmed order SO-…-0001 asks for 5 dozen polo
 // shirts in M and in L at ৳6,900 a dozen, zero-rated (an export). Aarong buys the crew-neck
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll } from './helpers.js';
+import { expect, expectNoSideScroll, test } from './helpers.js';
 
 // The mock's Rahman Garments owner has three unread notifications (step 17a added a requisition
 // waiting for approval) and one read one
```

```diff
@@ -1,7 +1,6 @@
 import { periodOf, todayIn } from '@omnivo/contracts';
-import { expect, test } from '@playwright/test';
 
-import { listItem, openFromNav } from './helpers.js';
+import { expect, listItem, openFromNav, test } from './helpers.js';
 
 // তারিখ-নির্ভর: আজ কোন অর্থবছর, সেটা অ্যাপের একই ফাংশন দিয়ে হিসাব — কোনো বছর হাতে লেখা নেই
 const today = todayIn('Asia/Dhaka');
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll } from './helpers.js';
+import { expect, expectNoSideScroll, test } from './helpers.js';
 
 // The mock starts signed in (as the Rahman Garments owner). Sign out through the menu — client-side,
 // so the mock keeps its state — then create a new workspace from the sign-up page.
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 // Step 15a in the mock garments workspace: "Export FOB" (the polo shirt's six versions, per piece
 // and per dozen) and "Local wholesale" (the crew-neck T-shirt per piece, poly mailers per carton)
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 17b in the mock garments workspace, where the signed-in person is the Owner. Orders from
 // ৳50,000 with VAT need the Purchase manager (Kamal Uddin), and an Owner's own orders are approved
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 17d in the mock garments workspace, where the signed-in person is the Owner. 17b's
 // PO-…-0001 orders 1,000 gross of shirt buttons from Unitex at ৳62 a gross before VAT (15%);
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 15b in the mock garments workspace: three quotations. QT-…-0001 (H&M) was declined,
 // QT-…-0002 (Primark) is open but its date has passed, QT-…-0003 (Aarong) is open. Aarong buys
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 15c: money receipts in the mock garments workspace. Aarong buys the crew-neck T-shirt at
 // ৳290 a piece plus 15% VAT, so 10 of them are a ৳3,335 invoice. The chart's money accounts are
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 15d: refunds, and the sales returns account. Garments: Aarong pays ৳5,000 for an order that
 // is then cancelled, or is billed 10 T-shirts (৳3,335) that are paid and then credited in full;
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll, openFromNav, readOnlyItem } from './helpers.js';
+import { expect, expectNoSideScroll, openFromNav, readOnlyItem, test } from './helpers.js';
 
 // The mock garments workspace has last fiscal year in four entries (sales 38,50,000, interest
 // 54,000, cost of goods 21,00,000, salaries 9,00,000: profit 9,04,000, not closed yet) and this
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 17a in the mock garments workspace, where the signed-in person is the Owner. Requisitions
 // from ৳20,000 need the Purchase manager (Kamal Uddin), from ৳1,00,000 a Director as well, a role
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 15d: sales returns. Garments: H&M's confirmed order SO-…-0001 asks for 5 dozen polo shirts
 // in M and in L (Navy blue) at ৳6,900 a dozen; they leave the Main store at ৳410 a piece. Pharma:
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, openFromNav, test } from './helpers.js';
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
 
 // Step 15b in the mock garments workspace: SO-…-0001 is H&M's confirmed export order (5 dozen
 // polo shirts in M and in L, nothing delivered yet), and Aarong has a draft order without a
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, openFromNav, test } from './helpers.js';
 
 // ১×১ px PNG
 const PNG = Buffer.from(
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 // Step 14 in the mock garments workspace. Its opening stock was posted with costs (7,200 shirt
 // buttons at ৳0.45 = ৳3,240) as JV-…-0007, and the truck to the Chattogram depot as JV-…-0008.
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
```

```diff
@@ -1,6 +1,6 @@
-import { expect, type Page, test } from '@playwright/test';
+import type { Page } from '@playwright/test';
 
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 // Step 17a in the mock garments workspace: three suppliers, S-00001 to S-00003. The company owes
 // Meghna Spinning Mills ৳21,00,000 from last year's yarn (a payable line of the seeded journal).
```

```diff
@@ -1,6 +1,4 @@
-import { expect, test } from '@playwright/test';
-
-import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';
+import { expect, expectNoSideScroll, listItem, openFromNav, test } from './helpers.js';
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
```

### The copy on the device: `e2e/sync.e2e.ts` (new)

```ts
import type { Page } from '@playwright/test';

import { expect, listItem, openFromNav, test, toastShown, waitForCopy } from './helpers.js';

// Step 18a: the products and customers pages read the copy on this device, which the mock fills
// from its own data (src/mocks/sync-data.ts). The garments workspace has three active branches and
// an archived one, so a new device asks which branch it is in; the other tests start with a device
// of the head office (the fixture in helpers.ts). Offline is Playwright's context.setOffline: the mock then fails every
// request like a dead network (the first handler in handlers.ts). Pages change through the nav,
// never with a reload: an offline reload needs the service worker of step 19.

// The local databases of this browser profile: one per person and workspace (decision 41)
function localDatabases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((database) => database.name ?? '')
      .filter((name) => name.startsWith('omnivo-')),
  );
}

test.describe('a device without a branch', () => {
  test.use({ seedDevice: false });

  test('asks which branch it is in, and offers it again where the copy is needed', async ({
    page,
  }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Which branch is this device in?' });
    // Only the active branches: the Narayanganj dyeing unit is archived
    await expect(dialog.getByLabel('Branch').getByRole('option')).toHaveText([
      'Pick a branch',
      'CTG · Chattogram depot',
      'GZP · Gazipur factory',
      'HO · Head office',
    ]);
    // Nothing picked: no quick click sets a shop's device up for the head office
    await dialog.getByRole('button', { name: 'Use this branch' }).click();
    await expect(dialog.getByText('Pick an active branch.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();

    // "Not now": the pages that read the copy say why they are empty, with the way out
    await openFromNav(page, 'Products');
    await expect(page.getByText('This device is not set up yet')).toBeVisible();
    await page.getByRole('button', { name: 'Choose the branch' }).click();
    await dialog.getByLabel('Branch').selectOption({ label: 'CTG · Chattogram depot' });
    await dialog.getByRole('button', { name: 'Use this branch' }).click();
    await toastShown(page, 'This device is set up for Chattogram depot');
    await waitForCopy(page);

    await page.getByRole('searchbox', { name: 'Search products' }).fill('pique');
    await expect(listItem(page, /Pique polo shirt/)).toBeVisible();
    await openFromNav(page, 'Customers');
    await expect(listItem(page, /H&M Hennes & Mauritz/)).toBeVisible();
  });
});

test('keeps the products and customers working when the connection drops', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await waitForCopy(page);
  await openFromNav(page, 'Products');
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill('pique');
  await expect(listItem(page, /Pique polo shirt/)).toBeVisible();
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toContainText('৳38,50,000');

  await context.setOffline(true);
  // A balance needs the server (decision 10): a dash, never the last one seen, which may be wrong
  // by now
  await expect(page.getByText('Balances need a connection').first()).toBeVisible();
  await expect(listItem(page, /H&M Hennes & Mauritz/)).not.toContainText('৳38,50,000');
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('primark');
  await expect(listItem(page, /Primark Stores/)).toBeVisible();
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toBeHidden();

  // Search and a scanned barcode run on the device
  await openFromNav(page, 'Products');
  await search.fill('8941100500118');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
  // Archived products are not on the device (decision 11)
  await page.getByText('Archived', { exact: true }).click();
  await expect(page.getByText('Needs a connection')).toBeVisible();
  await expect(
    page.getByText('Archived products are not kept on this device. Connect to the internet'),
  ).toBeVisible();

  // Back online: the server's archived list, and the balances again
  await context.setOffline(false);
  await expect(page.getByText('Needs a connection')).toBeHidden();
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toContainText('৳38,50,000');
  await expect(page.getByText('Balances need a connection')).toBeHidden();
});

test('a change saved here reaches the copy, and an archived product leaves it', async ({
  page,
}) => {
  await page.goto('/');
  await waitForCopy(page);
  await openFromNav(page, 'Products');
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill('mailer');
  await listItem(page, /Poly mailer bag 10x14/).click();
  await page.getByLabel('Name').fill('Poly mailer bag 12x16');
  await page.getByRole('button', { name: 'Save product' }).click();
  await toastShown(page, 'Poly mailer bag 12x16 saved');
  // The save asks for a pull (api.ts → onApiWrite): the list shows the copy's new row
  await openFromNav(page, 'Products');
  await search.fill('mailer');
  await expect(listItem(page, /Poly mailer bag 12x16/)).toBeVisible();
  await expect(listItem(page, /Poly mailer bag 10x14/)).toBeHidden();

  await listItem(page, /Poly mailer bag 12x16/).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await toastShown(page, 'Poly mailer bag 12x16 archived');
  await openFromNav(page, 'Products');
  await search.fill('mailer');
  await expect(page.getByText('No product matches "mailer"')).toBeVisible();
  // The server's archived list has it
  await page.getByText('Archived', { exact: true }).click();
  await expect(listItem(page, /Poly mailer bag 12x16/)).toBeVisible();
});

test('signing out deletes the copy on this device', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toBeVisible();
  await expect.poll(() => localDatabases(page)).toHaveLength(1);

  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // The next person at a shop's computer cannot read it (decision 41)
  await expect.poll(() => localDatabases(page)).toEqual([]);
});
```

- **The branch dialog runs without the fixture** (`test.use({ seedDevice: false })`). It checks the list (active
  branches only), the empty box refused, "Not now", the page's "Choose the branch" button, and that the list fills
  after the Chattogram depot is chosen.
- **Offline is `context.setOffline(true)`:** `navigator.onLine` is false and the `offline` event fires, so the app
  sees what it would see; the mock fails every request (decision 54). The test moves through the nav only: an offline
  reload needs step 19's service worker.
- **The balance check comes first offline,** right after the switch, while the customer list is on screen: that is
  where the cached balance used to stay.
- **A save reaches the copy:** the product is renamed and then archived, and the active list (read from the device)
  follows both times. The archived tab is the server's, so it shows the product at once.
- **Sign-out deletes the database:** `indexedDB.databases()` lists the databases of the page's origin; the app's start
  with `omnivo-`. `expect.poll` because the deletion runs after the sign-in page shows.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
npx eslint apps/app/src/mocks apps/app/src/routes/customers.tsx apps/app/e2e
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app test:e2e
```

Build `@omnivo/sync` and `@omnivo/ui` first (`pnpm --filter @omnivo/sync build`), as in 18a.6: the app and the test
files read their built code.

> **What we checked in this part.** The app type-checks (all three tsconfigs), ESLint and Prettier are clean, its 135
> unit tests pass, it builds, the bundle budget is unchanged (first load 205.4 KB gz, the host 103.1 KB), and
> dependency-cruiser finds no violation (it found one circle first: `sync-data.ts` imported `record()` from
> `workspace-data.ts`; the audit row moved to the handler). The full Playwright suite, 266 tests on the desktop and the
> phone, ran once with the default workers: 249 passed and 17 failed on timeouts while the machine's load was near 20
> (a toast that did not close in 5 seconds, a heading late); those 17 then passed with `--last-failed --workers=2`.
> The 8 new tests passed 3 times in a row (`--repeat-each=3`). Two rules were broken on purpose: without the deletes
> of a delta pull, the archived product stayed in the list and the test failed; without the offline balance fix,
> the offline test failed (that is how the fix was found). Without the offline handler no test fails, as said above:
> the app does not fetch while offline.

---

## 18a.8 — The OpenAPI document, and every check once

### No role templates this time

15d's notes ask every step that adds a permission to check `apps/api/src/setup/templates.ts`. This step adds none
(decision 21): registering a device and pulling need only a signed-in member, and the balances route asks for
`sales.customer.balance`, which the templates have given since 15a. So the file does not change.

### The OpenAPI document

The root files change twice, both in 18a.6: `.dependency-cruiser.cjs` (the browser rule covers `packages/sync`) and
the lockfile (`pnpm install` writes it after the new `package.json`). No new script, no new `.env` line. Generate the
API document again and commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 209 paths (206 before)
```

The 3 new paths are `/sync/devices` (POST, register a device), `/sync/pull` (GET, a page of the pull) and
`/customer-balances` (GET, the balances of up to 100 customers). One older path changes its shape: `/audit-logs`,
whose entity type filter learns `device`. The products and customers paths do not change: their rows are now built
by `productsOf()` and `customersOf()`, in the same shape. `pnpm test:openapi` fails if the committed file and the
routes disagree.

The Drizzle snapshots (`migrations/meta/0043_snapshot.json`, `0044_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

Every check passed but one test, with the turbo cache bypassed (`--force`): `pnpm dedupe --check`, `pnpm lint`,
`pnpm format`, `pnpm typecheck`, `pnpm test` (585 — 46 new: 11 in the contracts, 35 in `packages/sync`), `pnpm
build`, `pnpm test:bundle-size`, `pnpm test:openapi`, `pnpm boundaries`, `pnpm test:tenant-leak` (105 — 9 new) and
`pnpm test:e2e` (266 — 8 new). The integration and tenant-leak suites ran with `--maxWorkers=3` (`cd apps/api && npx
vitest run .int.spec --maxWorkers=3`), because at full speed this Mac's Docker misses the test containers' start-up
time.

`pnpm test:integration` ran 502 tests (19 new), and 501 passed. The one that failed is 15c's invoice list test, and
not because of this step: it expects INV-2026-27-0006 (due 20 Oct 2026) not to be overdue yet, and the run was on
21 Oct ("What we found on the way"). You chose to leave it as it is and note it; it fails on your machine too, with
or without 18a.

The end-to-end suite ran 266 tests once on 4 workers, in 24.5 minutes (it takes about 9) while macOS was swapping
(the load reached 98, and the disk filled for a moment: one first attempt stopped with `ENOSPC`). 221 passed and
45 failed on timeouts, none of them in `sync.e2e.ts`; the 45 then passed with `--last-failed --workers=2` in 3.8
minutes.

If a test times out on your machine, run
`pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts --last-failed --workers=2` before
looking for a bug.

---

## 18a.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after "Empty state", add two entries. The design system lists every pattern, and a
pattern that is not listed there does not exist for the next screen (18b's outbox and 18c's Sync page will use both):

> - **Device copy states:** `LocalState` (`apps/app/src/components/local-state.tsx`), what a list read from the
>   device shows in its place while the copy is not ready, as an empty state: not set up (`ComputerPhoneSync`, a
>   "Choose the branch" button), copying (`CloudDownload`, a 12px `ink-3` `tabular-nums` `role="status"` count, "1,250
>   items copied so far"), copy failed (`CloudOff`, Retry), offline with no copy (`WifiDisconnected02`), storage
>   refused (`HardDrive`), device removed (`ComputerRemove`). A picker shows only the title, as its status line. A
>   problem that needs a reload (`sync_protocol_mismatch`) is a neutral document notice above the list, which still
>   shows the copy, with a Reload text link. A server-backed tab offline is the empty state "Needs a connection"
>   (`WifiDisconnected02`).
> - **Device branch dialog:** after sign-in, when the workspace has more than one active branch: the dialog, "Which
>   branch is this device in?", a select that starts empty ("Pick a branch", active branches only), "Not now"
>   (secondary) and "Use this branch" (primary), then the toast "This device is set up for Chattogram depot". Closing
>   it any way is "Not now".

In "Data table", add at the end. The products and customers lists no longer page on the server (decisions 5 and
44):

> A list whose rows are on the device (the active products and customers) searches, filters and sorts in the
> browser and shows 100 more rows at its end (`onEndReached`); its Archived tab stays a paged server list, online
> only.

In "Combobox", the sentence "The page owns the search and runs it on the server;" becomes (decision 48):

> The page owns the search and runs it on the server, or on the device for the customer box (step 18a);

In "Content and formatting", at the end of "A customer's balance", add (decision 10):

> Offline the column shows a dash, and the list says "Balances need a connection".

**system-design.bn.md** — in "৭.২ আর্কিটেকচার", under "২. **Pull**", replace the first and the third bullet. The
design said `updated_at` plus a version number; the change log and the watermark are what was built, and why
(decisions 24 and 25):

> - প্রতিটা syncable টেবিলে trigger একটা change log-এ (`sync_changes`) লাইন লেখে: কোন entity, কোন key, আর যে
>   transaction লিখেছে তার `xid8`। cursor একটা transaction watermark: সার্ভার শুধু সেই transaction-গুলোর
>   পরিবর্তন দেয় যেগুলো এখনো চলা সবচেয়ে পুরনো transaction-এর আগে শেষ হয়েছে। সাধারণ sequence number দেরিতে commit
>   হওয়া transaction-কে হারিয়ে ফেলে; watermark কখনো হারায় না, বড়জোর এক pull পরে আনে। ডিলিট বা ডেটা-সেট থেকে বেরিয়ে
>   যাওয়া (archive, স্টক শূন্য) = delete। log ৩০ দিন থাকে; এর চেয়ে পুরনো cursor-এ পুরো pull।
> - শুধু "POS-ready" ডেটা ক্লায়েন্টে যাবে: সক্রিয় প্রোডাক্ট (variant, pack, barcode সহ), price list ও দাম, VAT
>   rate, সক্রিয় কাস্টমার ও group, ডিভাইসের ব্রাঞ্চের warehouse ও তার স্টক, আর সেটিংসের দরকারি অংশ। balance আর
>   stock value না (permission লাগে, প্রতি posting-এ বদলায়)। প্রতিটা ব্রাউজার একটা device, একটা ব্রাঞ্চে।

**build-plan.bn.md** — in "ধাপ ১৮", replace the "**Pull:**" bullet with these two lines:

> **তিনটা গাইডে:** ১৮a pull, ১৮b push, ১৮c conflict + device list + sync status।
>
> - **Pull (১৮a):** `sync_changes` change log (trigger) + `xid8` watermark cursor, `GET /sync/pull` (পুরো বা শুধু
>   পরিবর্তন, পাতায় পাতায়), `POST /sync/devices` (ব্রাউজার = device, একটা ব্রাঞ্চে)। "POS-ready" ডেটা Dexie-তে;
>   products ও customers পাতা, customer box আর "Add items" সবসময় device থেকে পড়ে, অনলাইন বা অফলাইন। balance
>   সার্ভার থেকে, শুধু স্ক্রিনের সারিগুলোর।

**COMMANDS.md** — in "Look at the data", after the last query, add these three. They answer the questions you will
ask when a device looks behind (decisions 25, 26 and 32):

```bash
# devices: whose, which branch, when each last finished a pull (revoked ones too)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.name, u.email, b.name AS branch, d.last_sync_at, d.revoked_at FROM devices d JOIN users u ON u.id = d.user_id JOIN branches b ON b.tenant_id = d.tenant_id AND b.id = d.branch_id JOIN tenants t ON t.id = d.tenant_id ORDER BY t.slug, d.last_sync_at DESC NULLS LAST"
# the sync change log per workspace and entity: how many lines, and the oldest (the worker deletes lines older than 30 days every hour)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, c.entity, count(*) AS lines, min(c.created_at) AS oldest FROM sync_changes c JOIN tenants t ON t.id = c.tenant_id GROUP BY t.slug, c.entity ORDER BY t.slug, c.entity"
# write transactions open for more than a minute: every device's pull waits for them (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT pid, usename, now() - xact_start AS open_for, state, left(query, 80) AS query FROM pg_stat_activity WHERE backend_xid IS NOT NULL AND xact_start < now() - interval '1 minute'"
```

The three queries were run against a database migrated to 0044, holding 18a.2's check data: the first listed its
one device ("Chrome on Windows", Dhanmondi, with its last sync), the second the log's lines per entity. The third
printed nothing; with its interval lowered to two seconds and a write transaction held open in another session, it
printed that session.

---

## 18a.10 — Run it

```bash
pnpm install                                  # two new dependencies (packages/sync): dexie, fake-indexeddb
pnpm db:migrate                               # 0043 + 0044: two tables, their rules, 48 triggers
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: the sync routes, the worker's log cleanup
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('sync_changes', 'devices');                       -- t, two rows
SELECT count(*) FROM pg_trigger
 WHERE tgname LIKE '%\_sync\_%' AND NOT tgisinternal;                -- 48
```

The change log starts empty: rows written before 0044 have no line, and they do not need one. A device's first
pull is a full pull, which reads the tables themselves.

### What you will see

1. **The branch question:** sign in as the Owner of a workspace with more than one branch. "Which branch is this
   device in?" opens with an empty box. Pick a branch and **Use this branch**: the toast says the device is set up
   for it. (A workspace with one branch asks nothing.) `SELECT * FROM devices` has the row, named after the browser.
2. **The first copy:** open Products. The first time, "Copying the data to this device…" shows with a count that
   grows, then the list. In DevTools, Application → IndexedDB has a database named `omnivo-<workspace>-<you>`.
3. **The list reads the device:** search, filter by category and sort: the Network tab shows no request for them.
   Scroll to the end of a long list and 100 more rows show.
4. **A change comes over:** rename a product in another browser (or a private window), then come back to the first
   one: the list has the new name as soon as the window gets the focus. In the same browser, a save shows at once.
5. **Offline:** DevTools → Network → Offline. Products and customers still list, search and sort; the customer box
   on a new quotation and **Add items** still find their rows. The balance column shows a dash and "Balances need a
   connection"; the Archived tab says "Needs a connection". Saving anything fails: writing offline is 18b. Turn the
   network back on: a pull runs at once.
6. **Not now:** in another browser, sign in and click **Not now**. Products and customers say "This device is not
   set up yet" with **Choose the branch**, and the dialog does not come back by itself after a reload.
7. **Sign-out:** sign out. The IndexedDB database is gone. Sign in again: the same device (still one row in
   `devices`), with a new full pull.
8. **Bangla** and **390px:** the dialog and the device states fit, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 585: contracts 271 + api 107 + app 135 + sync 35 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 502 — 19 new (1 fails since 21 Oct 2026 because of the date: see "What we found")
pnpm test:tenant-leak        # 105 — 9 new
pnpm test:e2e                # 266: 133 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 205.4 KB gz (budget 210); debit note lines 104.4, AppShell 103.2, sync host 103.1 (105)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **Postgres refuses one trigger for three events with transition tables** (18a.2): "transition tables cannot be
  specified for triggers with more than one event". So every table has three triggers (insert, update, delete),
  made by one loop in 0044.
- **A sequence cursor loses changes** (18a.2): a script with two sessions showed it. A transaction that takes the
  lower id first and commits last is missed for good by "lines after the last id I saw"; the watermark returned both
  (decision 25).
- **Renaming the workspace changes the device's settings row** (18a.2): the company name lives in `tenants`, not in
  `tenant_settings`, so `tenants` has its own row trigger. The log has RLS and `tenants` has not, so a rename works
  only inside the workspace's tenant context: `SettingsService` has it; a future admin console must set it first.
- **No bug in the API's pull** (18a.4): the tests broke three of its rules on purpose (the watermark from `xmax`, a
  loader that reads `limit` rows instead of `limit + 1`, the pull's end taken again on every page), and a test
  failed each time.
- **`dexie-react-hooks` put Dexie into 12 pages** (18a.6): every sales form has a customer box, and each went over the
  105 KB budget. Dexie now loads once, with the AppShell (decision 42, your choice).
- **A rule had no test** (18a.6): a pull sent without a cursor must start a new generation. Breaking it failed no
  test, so we added "a pull sent without a cursor starts over".
- **The mock made a circle** (18a.7): `sync-data.ts` imported `record()` from `workspace-data.ts`, which imports it
  back. The audit row is written by the handler now.
- **The customers page showed cached balances offline** (18a.7): the balances stayed in the query cache, so the
  column kept numbers that could be a day old. Offline it shows a dash now (`balance: online ? … : null`).
- **The branch dialog came up in every browser test** (18a.7): the garments workspace has three branches. A
  Playwright locator handler answered it, but the bell tests then failed with two dialogs open. Each test starts with
  a device of the head office now (decision 52, your choice).
- **MSW does not go offline** (18a.7): it answers inside the page, so `setOffline` does not stop it. Its first handler
  fails every request while `navigator.onLine` is false (decision 54).
- **Two older tests depend on today's date** (18a.8, not 18a's code): the "overdue" filter of invoices and of
  supplier bills compares the due date with the database's real today, and the tests use fixed dates. In
  `apps/api/src/sales/invoices.int.spec.ts`, "lists invoices by status, customer and payment, page by page" (line
  1032) fails since 21 Oct 2026: INV-2026-27-0006 is due on 20 Oct, so it is overdue now, and INV-2026-27-0001 (due
  5 Nov) joins it on 6 Nov. In `apps/api/src/purchase/supplier-payments.int.spec.ts` the bills are due on 15 Oct,
  4 Nov and 9 Nov, so `openBills(yarn, 'overdue')` (line 495 and after) fails from 5 Nov. The code is right: the
  page works out "overdue" in the workspace's time zone, as it should. Left as it is in this step (your choice); see
  the notes at the end.

---

## Notes left for later steps

**18b (push):**

- **A push ends with a pull.** `api.ts` already tells the sync code after each successful write (decision 43);
  the push loop should call the same `engine.request()` after each batch, so the server's answer (the customer's code,
  the order's number) is on the device a moment later.
- **The ids are already UUIDv7.** A customer and an order made offline get their id in the browser, like the device
  (decision 20). The server checks that the id is a v7 and not used.
- **The mock's pull is a snapshot diff** (decision 51): the mock's push only has to change its arrays, and the next
  pull sends the difference. No log line to remember.

**18c (conflicts, devices, status):**

- **The devices table is ready:** `name`, `branch_id`, `last_sync_at` and `revoked_at` are there, and the app
  already wipes its copy on `device_revoked` (decision 49). 18c adds the list, rename, move and revoke, with their
  audit actions.
- **The time limits count from the server's clock** (`serverTime`, decision 19), which the device keeps as
  `lastSyncAt` in its pull state.
- **A long write transaction holds every pull back** (decision 25): a two-minute import delays every device by two
  minutes. That is correct, just late; the Sync page's "last sync" should not call it a failure.

**Step 19 (PWA):**

- **An offline reload** needs the service worker: in 18a the app must be loaded while online.
- **Sign-out deletes the copy** (decision 41). With a PIN lock and encryption, the copy may be allowed to stay.

**Step 20 (POS):**

- The data set is the POS's (decision 2). Serial numbers are not on the device yet (decision 23); a stock row has
  its batch's lot number and expiry for "first to expire".

**Notes for any step:**

- **The date-bound tests of 15c and 17c** ("What we found on the way") need a fix of their own: the expected
  overdue lists should be worked out in the test from the real today in the workspace's time zone (the dates then
  stay fixed and the paging tests do not change), or the "today" the service reads should be settable in tests.
  Until then `pnpm test:integration` has 1 failure from 21 Oct 2026, and more from 5 Nov. A test that checks
  "overdue", "late" or "expired" must never use a fixed date that the calendar can pass.

- **A new field in a synced row needs a new protocol version.** A device keeps a product or a customer in the shape
  of the day it was pulled. A field added to `productSchema`, `customerSchema` or any synced row reaches a device
  only when that row changes again, unless `SYNC_PROTOCOL` (`packages/contracts/src/sync.ts`) goes up by one: then
  every device does a full pull with its next version (decision 18).
- **A new table that a synced row reads needs its triggers.** A product's images, say, are part of its row: the new
  table needs the three `sync_log()` triggers in its migration, logging the product's key (like `product_barcodes`
  in 0044), or a change to it never reaches a device. A new entity also needs its place in `SYNC_ENTITIES`, a loader
  in `sync-rows.ts` (a compile error reminds you) and a table in `packages/sync`.
- **The lazy chunks are near their budget.** The largest are the debit note lines (104.4 KB gz), the AppShell
  (103.2, 1.2 KB more than in 17d: the branch dialog and the device states), the quotation form and the sync host
  (103.1 each), against 105 KB. Every page still loads the contracts' whole route table (17d's note), and 18b adds
  routes: split the route table by module before 18b's screens, or the next routes push these chunks over.
