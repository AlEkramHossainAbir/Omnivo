# Step 18b: The sync engine, part 2 — work done offline, sent later

> The implementation guide for "Phase 6 → Step 18", the second of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 18 (the sync engine, `packages/sync`) is split into
> three guides: 18a (pull: the server's data on the device, read from there), this one (push: work done offline sent
> to the server as commands, and the sync status) and 18c (the device list, revoking a device, and the time limits).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `834f1db`, your commit named
> "error fixed": 18a's code, the fixes of the date-bound tests and of the invoice's billed quantity, and 18a's doc
> updates) and checked on 2026-10-21 and 2026-10-22: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm
> typecheck`, `pnpm test` (641 — 56 new), `pnpm test:integration` (533 — 31 new), `pnpm test:tenant-leak` (109 — 4
> new), `pnpm build`, `pnpm test:bundle-size` (first load 208.6 KB gz, budget 210; the biggest lazy chunks the debit
> note lines, 106.7 KB, the quotation form, 105.5, and the AppShell, 105.3, budget 110), `pnpm gen:openapi` (210
> paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 276 — 10 new, desktop and 390px;
> on a machine that was swapping, 62 timed out and passed when run again with fewer workers, see 18b.8) — with the
> turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres (18b.2): 18 checks of migrations 0045 and 0046 as
>   `omnivo_app` and `omnivo_worker` (an answer written once and never changed, its checks, its device in the same
>   workspace, another workspace's answers, the worker's cleanup), and a race in two sessions: the same command sent
>   twice at the same moment runs once with the lock, and twice without it.
> - **The push against a real database** (18b.4): every merge rule (a head-office field kept or taken, the same field
>   from two devices, addresses added, removed and changed, one removed on the server), a replay of an accepted and
>   of a refused command, the same command twice at once, lost roles, a revoked device, the answers' cleanup, the
>   device on the audit rows, and another workspace trying the ids of this one.
> - **The app against the real API in a browser** (18b.8): a customer edited offline while the head office changed
>   its credit limit, a new customer and its draft order saved offline, then back online: the C- number, the draft
>   in the server's list, the credit limit kept with its notice on the Sync page, and the audit rows naming the
>   device.
> - **Rules broken on purpose:** one in the API (18b.3), three in its tests (18b.4), two in the words (18b.5), two in
>   `packages/sync` (18b.6) and two in the app (18b.7). Each was caught by the test or the type check meant for it;
>   the code was restored after each.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` (0045 and
> 0046) first, then restart `pnpm dev`. (2) **Other browsers:** the browser tests ran in Chromium only; Safari's and
> Firefox's IndexedDB upgrade from version 1 to 2 was not tried. (3) **Two tabs** saving offline at the same time:
> the outbox is in one database per person and workspace, and the push runs under 18a's Web Lock, but two tabs were
> not tested together. (4) **A real bad line:** answers lost halfway were tested in the API (a replay), not with a
> network that drops in the middle of a push. (5) The Bangla texts were written by me and not reviewed by a native
> speaker. (6) The new tests on GitHub Actions.

## Goal

✍️ **Writing without a connection.** After 18a, a shop or a sales officer can read the products, the prices and the
customers with the Wi-Fi gone, but cannot write anything. This step lets them add a customer, change one, and write a
sales order, offline. What they do is kept on the device as a command in an outbox, and sent to the server when the
connection comes back.

After this step:

- **Online, nothing changes.** The forms save through the API as before: confirming an order, the credit dialog and
  "Make order" from a quotation work as they did.
- **Offline, the customer form and the sales order form save on the device** ("Save on this device"). An order is
  a draft: it gets its number when someone confirms it online.
- **When the connection comes back, the device sends its outbox,** oldest first, and the server runs each command with
  the person's roles of now. A command sent twice (an answer lost on a bad line) is run once.
- **Two people changing one customer both keep their change** when they changed different fields. The same field:
  the later one to reach the server wins. The credit limit, the payment terms, the price list and the group are the
  head office's: if the server changed one since the device read it, the server keeps it, and the person is told.
- **A refused command waits on the device** ("Needs attention", with the reason). The person fixes it and sends it
  again, or drops it. Only what needs it waits: an order for that new customer.
- **The sidebar says whether the device is online, and how many changes are waiting.** A Sync page lists them, with
  Retry, Discard, Edit and "Sync now", and when the device last synced.
- **The sales orders page shows the orders that are still on this device,** above the server's list, online and
  offline.

## The whole picture

```
packages/contracts   sync.ts: 3 commands (customer.create, customer.update {from, to} per field + addresses
      │               add/remove/change, sales_order.create_draft) · POST /sync/push {deviceId, protocol, commands
      │               ≤ 50} → a result per command: accepted {notices, changes} | rejected {error}
      │               sales.ts: startingPrice(), the price rule shared by the API and the device
      │               3 errors (sync_id_taken, sync_command_invalid, sync_customer_gone) · audit entry's device
      ▼
packages/db          sync_commands (0045): one answer per command id, written once, never changed (0046: RLS,
      │               insert-only for the app, the worker's 30-day cleanup) · audit_logs.device_id
      ▼
apps/api             sync/sync-push.service.ts: per command one transaction, an advisory lock on its id, the
      │               stored answer if there is one, else a savepoint runs it and the answer is written
      │               sales/customer-merge.ts: the field and address merge (pure) · createFromDevice,
      │               updateFromDevice, createDraftFromDevice: the services' second door · the device in the
      │               request's context, so every audit row of the push names it
      ▼
packages/sync        outbox + notices tables (Dexie version 2) · outbox.ts: add, rewrite while never sent, discard
      │               with what needs it · push.ts: batches, what waits · overlay.ts: the outbox on top of the copy
      │               prices.ts: startingPrice() on the device · one sync = push, then pull, under one lock
      ▼
apps/app             customer form and sales order form: "Save on this device" offline · the sidebar's sync line
                      · the Sync page (/sync) · "On this device · not synced" above the orders · the sign-out
                      question · lib/offline-screens.ts loads the offline screens' code while online

one sales officer in Sylhet, with no signal for an hour:
  the Wi-Fi drops ──► the sidebar says "Offline"
  New customer "Sylhet Pharmacy", code left empty ──► "Save on this device"
     outbox: customer.create {id, customerId and the address ids made on the device (UUIDv7)} ──► "1 change waiting"
     the customers list shows it from the outbox: "Not synced", "No number yet"
  New sales order for it, 200 Napa from the main store ──► the price from the device's copy (startingPrice)
     outbox: sales_order.create_draft · on the Sync page it "waits for Sylhet Pharmacy to sync first"
  Rahman Traders' phone and credit limit changed ──► customer.update {phone: {from, to}, creditLimit: {from, to}}
  meanwhile the head office sets Rahman Traders' credit limit on the server
  the signal is back ──POST /sync/push {3 commands}──► the server, one command at a time:
     its id answered before? ──► the stored answer, nothing runs again (a lost answer, sent twice)
     customer.create ──► C-00002, accepted, the customer's row comes back in `changes`
     sales_order.create_draft ──► a draft, accepted (its number comes when someone confirms it online)
     customer.update ──► the phone is changed · the credit limit is not: the server's value is no longer the
        `from` the device had, and the credit limit is the head office's ──► notice kept_server_value [creditLimit]
     every audit row says "· from Chrome on Windows"
  the device: the changed rows are written, the commands leave the outbox, then a pull
     toast "Some fields kept the value the server had" · the Sync page lists "Not changed: Credit limit"
  had the code been taken ──► rejected, "Needs attention": Edit, then sent again under a new command id; or
     Discard, which takes the order with it
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Confirming an order, or an invoice, offline | A confirmation checks the credit limit against what the customer owes now, which only the server knows (decision 15). The POS of step 20 decides how a cash sale works offline |
| Writing anything else offline (products, receipts, stock) | Not in the step 18 decisions (decision 5). Each needs its own merge rules |
| The device list, rename, move to another branch, revoke | 18c |
| The 24 hour warning and the 7 day stop | 18c. The Sync page shows the last sync already |
| Opening the app without a connection | Step 19: the service worker. In 18b the app must be loaded while online, and may then go offline |
| A PIN lock and encrypting the outbox | Step 19 |
| Comparing the clocks of devices | Never: the order in which commands reach the server decides (decision 6). A shop computer's clock is often wrong |

## What changes in the code you already have

- **Contracts:** `sync.ts` gains the three commands, the push route `sync.push` (`POST /sync/push`) and its answer,
  the limits (50 commands, 512 KB) and the notice code `kept_server_value`. `sales.ts` gains `startingPrice()`, the
  price rule the API already had, so the device can use it too. `sales-orders.ts` gains the draft's input without
  confirm, the credit override and the quotation. `customers.ts` gains the change shapes. Three new error codes. The
  audit entry gets `device` (`{id, name}` or `null`). No new permission (decision 17), no new dependency, and
  `SYNC_PROTOCOL` stays 1 (decision 21).
- **Database:** one new table, `sync_commands` (migrations 0045 and 0046), and one new column, `audit_logs.device_id`
  (null, no foreign key). The app may only insert into `sync_commands`; the worker may delete old rows.
- **API:** a new `sync/sync-push.service.ts`, the route on the sync controller, and `sales/customer-merge.ts`.
  `CustomersService` and `SalesOrdersService` get a second way in for a command (`createFromDevice`,
  `updateFromDevice`, `createDraftFromDevice`); their API routes run the same code as before. The price lookup
  calls `startingPrice()`, with the same answers. The audit writer reads the device from the request's context, and
  the audit list joins the devices for their names. The worker's hourly cleanup deletes answers older than 30 days.
  `DevicesService.forPull` is renamed `forSync`.
- **API tests:** one new file (`sync/sync-push.int.spec.ts`), a new unit spec for the merge, and a push part in
  `sync/sync.tenant-leak.int.spec.ts`.
- **i18n:** the `sync.*` section grows (the outbox, the Sync page, the toasts, the sign-out question), plus
  `nav.sync`, an offline credit line and the audit log's "· from <device>".
- **`packages/sync`:** version 2 of the device's database adds two tables (`outbox`, `notices`) and an index by
  variant on the products. New files `outbox.ts`, `push.ts`, `overlay.ts` and `prices.ts`. The engine's pull becomes
  `syncNow()`: a push, then a pull. The queries read the outbox on top of the copy.
- **Screens:** the customer form and the sales order form save on the device offline. The sidebar has a sync line,
  and there is a Sync page (`/sync`). The customers list shows customers waiting on the device, the sales orders
  page has the "On this device · not synced" part, and the audit log names the device. Sign-out asks first when
  changes are waiting. Offline, units, VAT rates, warehouses, a customer and the settings come from the device
  (`lib/device-reads.ts`). `@omnivo/ui` exports `loadCalendar`, so the date picker's code can load before it is
  needed. The lazy chunk budget goes from 105 to 110 KB (your choice in 18b.6).
- **Mock API and e2e tests:** the mock answers the push (`mocks/push-data.ts`) and its audit entries have
  `device: null`. One new Playwright file, `e2e/outbox.e2e.ts`.
- **OpenAPI document:** 1 new path, `/sync/push` (210 in all); `/audit-logs` gains the entry's `device`.

## The decisions behind this step

You made the first eight: decisions 1–4 on 2026-10-21 for this guide, and 5–8 on 2026-10-20 for the whole of step 18.
The others came up while building it; please read them with care: they are mine.

1. **What 18b holds.** (You chose this.) The outbox, `POST /sync/push` and running a command only once, the three
   commands (a new customer, a change to a customer with the full merge, and a sales order draft), the online and
   offline line and the "3 changes waiting" badge in the sidebar, and the Sync page (Retry, Discard, Edit, "Sync now",
   the last sync). The device list, revoking, and the 24 hour and 7 day limits are 18c.
2. **Online keeps the API.** (You chose this.) Online, the forms call the API as they do today, so confirming, the
   credit dialog and "Make order" stay as they are. Offline, the form saves to the outbox, and an order only as a
   draft. A customer that already has a waiting command is changed through the outbox even online, so its changes
   reach the server in the order they were made.
3. **The orders still on the device are shown above the orders list.** (You chose this.) A part "On this device · not
   synced", read from the outbox, online and offline; the server's list below it ("Needs a connection" offline).
   Opening one opens its waiting command in the form.
4. **Addresses are merged one by one, by id.** (You chose this.) A new address comes with an id made on the device, a
   removed one by its id, and a changed one with its id and the fields that changed. The same field of the same address
   changed in two places: the later arrival wins. The rule of one billing address is checked again after the merge.
5. **The first offline work is customers and sales order drafts.** (You chose this for step 18.) Nothing else is
   written offline in step 18, and no new business feature comes with it.
6. **Two changes to one customer.** (You chose this for step 18.) A change sends only the fields it changed. Different
   fields both stay; the same field: the change that reaches the server last wins. The credit limit, terms, price list
   and group changed on the server since the device read them: the server wins, and the person is told. No clocks are
   compared.
7. **A refused command waits in the outbox.** (You chose this for step 18.) It says "Needs attention" with its error;
   the person changes it and sends it again, or drops it. Only the commands that need it wait.
8. **The device's branch.** (You chose this for step 18.) An order written offline uses the warehouses of the device's
   branch, the ones it keeps a copy of (18a).

**The contract (18b.1):**

9. **One push route; each command on its own.** `POST /sync/push` takes up to 50 commands and answers one result per
   command, in the same order. The server runs them in the order sent, each in its own transaction, so a refused
   command does not undo or stop the ones after it. A sales officer's 30 changes of a day in the field are one request
   on a slow line, not thirty.
10. **A command has an id of its own, and the server keeps every answer.** The answer to a push can be lost on a bad
    line after the server ran it. The device then sends the same commands again, and the server answers from what it
    kept, without running them twice: one customer, not two. A refused command is kept as refused, so the device
    sends a fixed command under a new id. The command's id is not the customer's id: a customer may have several
    commands.
11. **The server reads each command on its own.** The request checks only that each command has an id and a type.
    The server then reads every command with the full schema, and one it cannot read is refused alone, with its field
    errors. If the whole request were checked at once, one bad command would refuse every push of that device for
    ever, and the outbox would never empty: the worst way an offline app can break.
12. **The device makes the ids of what it creates:** the customer, each of its addresses, and the order, as UUIDv7
    like every id. An order written offline for a customer added offline points at that customer, and at one of its
    addresses, before the server has seen either. The server checks that an id is still free; one used by something
    else refuses the command with `sync_id_taken`.
13. **The device decides what waits, not the server.** The contract has no "this needs that": the device puts a
    command in a batch only when every command it needs was accepted, and stops the batch before it. An order for a
    new customer goes in the push after that customer's. A change to a customer whose earlier change was refused waits
    for that one too, so a customer's changes always arrive in the order they were made (decision 2).
14. **A change says what the device had, and what it wants.** Each changed field is sent as `{from, to}`: `from` as the
    API sent it, `to` as the form sends it. For the four head-office fields (`SERVER_WINS_CUSTOMER_FIELDS`), "changed on
    the server since" means "the server's value is not `from`" — no history table is needed, and a change made and
    undone on the server does not count. `baseVersion` is the version the device changed; it is never refused (offline
    there is no "someone saved first, reload"). An address the server removed meanwhile is not changed again: the
    removal was a person's decision too.
15. **An order written offline is a draft, and nothing more.** Confirming checks the credit limit against what the
    customer owes now, and only the server knows that, so a device cannot confirm (the `confirm` field is not in the
    command). No quotation either: "Make order" is on the quotation's page, online. The prices are kept as the device
    worked them out, like a draft typed online; the server works out the totals from the lines again. The warehouse
    must be active, like online; it is not checked against the device's branch, so an order that waited while the
    device was moved to another branch (18c) is not lost.
16. **The customer code comes from the server.** An empty code gets the next number of the C- series when the command
    arrives, not when the customer was typed: two devices offline cannot both know the next number. A code the person
    typed may be taken by then; the command is refused with `customer_code_taken`, and the person changes it in the
    outbox.
17. **The person's roles of now.** Each command needs the permission its API route needs (`sales.customer.manage`,
    `sales.order.manage`), checked when it arrives. A person whose role lost it since gets the command refused with
    `permission_missing`, like online. The push route itself needs no permission: a person without either may still
    have commands from before.
18. **An accepted command sends the rows it changed back,** as they are now, so the device shows the customer with its
    new code at once instead of a minute later. They are read when the answer is made, also when a command is sent
    again: an answer kept from an hour ago would put an older row back on the device, and the pull would not correct
    it until the customer changed again.
19. **The price rule moves into the contracts.** `startingPrice()` is the rule of the price lookup (the customer's price
    list, else the product's price in the unit, else none). The order form offline starts its lines with it from the
    device's copy, and the API's lookup will call the same function (18b.3), so a line starts at the same price online
    and offline.
20. **The audit log says which device a change came from.** A customer changed offline and sent an hour later is still
    written in the audit log under the person who made it, and now also under the device. An owner who sees a credit
    limit changed at 9 in the evening can find it was the counter computer in Chattogram. 18b.2 adds the column; the
    audit page shows the device's name.
21. **The protocol stays at 1.** The push is new, and the rows of the pull do not change. A new protocol number would
    send every device into a full pull for nothing. An app from 18a never pushes, so it needs no new number either.
22. **A refused command's field errors use the form's paths,** so the same form shows them under the same boxes when
    the person opens the command to fix it: inside the input for a new customer or an order (`lines.2.quantity`), and
    the customer's own field for a change (`creditLimit`). An address of a change is named by its id, not its place:
    the server merges the addresses, and the place it sees is not the place in the form.

23. **An answer is written once, with the command, and never changed.** The push (18b.3) runs each command in one
    transaction: it takes a lock on the command's id, looks the id up in `sync_commands`, runs the command behind a
    savepoint, and inserts the finished answer, accepted or refused. A second push of the same command waits on the
    lock and then finds the answer. The other way, a "claim" row inserted first and filled in at the end, needs the
    API to update the table, and an update is how a refusal could turn into an acceptance that never ran. So the API
    may only insert (migration 0046).
24. **A command the server could not read has no answer row.** No such type, a field the schema refuses: the same
    bytes always get the same refusal, so there is nothing to keep, and the table holds only the three real types.
25. **Answers are kept 30 days,** like the change log, and the worker's hourly job deletes the older ones. A device
    sends a command again minutes after a lost answer, at its next sync, not a month later; and from 18c a device that
    has not synced for 7 days will have to sync before it works offline again.
26. **`audit_logs.device_id` has no foreign key,** like `actor_user_id` and `entity_id`: an audit row records what
    happened and points at nothing. A foreign key would also make the migration read the whole audit log, one of the
    biggest tables, while every write of the app waits.

**The API (18b.3):**

27. **The device rides in the request's context, not in a parameter.** The push runs each command inside
    `runFromDevice(deviceId, …)`, and the audit writer reads the device from there, like it reads the person. The
    customer and order services write their audit rows deep inside; passing a device id down through every one of
    them would change a dozen signatures for one column.
28. **The services get a second door, not a second copy.** `CustomersService` and `SalesOrdersService` keep their
    routes' methods as they were. The work inside them moves into private methods that take a transaction
    (`insert`, `save`), and three new public methods (`createFromDevice`, `updateFromDevice`,
    `createDraftFromDevice`) call the same ones inside the push's transaction. A rule added to a customer's save
    later holds for a change from a device too, without anyone remembering it.
29. **An error that is not a refusal fails the whole push.** A refusal is an `AppError` (a rule the person can fix)
    or an id the device made that is already used. Anything else — a bug, the database gone — answers the push with
    a 500. The commands before it are already committed with their answers; the device sends the batch again, and
    those are answered from what was kept. Keeping a 500 as a refusal would tell the person to fix a command that
    has nothing wrong with it.
30. **The roles are read once per push.** One request is one moment; reading them again for each of 50 commands
    would be 50 Redis reads for the same answer.
31. **The merged addresses are checked again.** An added address whose id the customer already has is refused
    with `sync_id_taken`; more than 20 after the merge is `too_long` on `addresses`; and two billing addresses put
    the error on the one this change made or changed, the one the person can fix in the outbox.

**The device and the app (18b.6):**

32. **The outbox is in the device's database.** Two new tables, `outbox` and `notices`, in version 2 of the
    database 18a made. The copy stays: Dexie adds the tables and keeps the rows. Signing out deletes the database,
    so it deletes the outbox too (18a, decision 41); the app asks first when changes are still on the device.
33. **A command is rewritten only while the server surely never ran it:** never sent, or refused. A command sent
    without an answer may have run (the answer was lost), so it is sent again as it is, and a later edit becomes a
    command of its own. The open commands of one customer fold into the first of them, which keeps its place in the
    outbox, so an order for a new customer stays behind that customer. A rewritten command always gets a new id
    (a refused id is answered from what the server kept, decision 10). An order saved again moves to the end of
    the outbox. An order being sent cannot be changed for that moment (`sync.busy`).
34. **The screens show the outbox on top of the copy.** The rows in the database stay the server's, exactly as the
    pull wrote them. The customers list, the customer box and the forms read the server's row with the waiting
    commands applied, or the customer made on the device. Writing the device's version into the table instead
    would be overwritten by the next pull, and swept by a full pull, while the command still waits.
35. **Offline, the small lists come from the copy.** The queries for units, VAT rates, warehouses and one customer
    read the device when the browser is offline, so every component deep inside the order form works without a
    change. A customer with commands waiting is read from the device online too. The time zone and "prices with
    VAT" come from the device's settings when the server's were never loaded.
36. **An order goes into the outbox offline, and online when its customer has commands waiting.** This extends
    decision 2: a customer made offline is not on the server yet, so an order for it can only wait behind it. A
    draft that is already on the server, and an order made from a quotation, stay with the API: neither is a
    command.
37. **One sync is a push, then a pull, under one lock.** The push sends batches until nothing more can go: an
    accepted customer frees its order for the next round. A command waits while an earlier command on the same
    customer is still on the device, refused or in the same batch. The answers are written in one transaction
    with the rows they bring. A push that fails as a whole puts its commands back as waiting; they stay marked as
    sent.
38. **Products get an index by variant.** The price lookup on the device and a draft opened again both start
    from a variant id. Version 2's upgrade fills the new field for the products the device already has, so no
    full pull is needed.
39. **After a push, the screens read again and one toast says what happened.** A refused change comes first in
    the toast, then a kept head-office field, then the count synced. The sidebar count leads to the same page for
    someone who misses the toast.
40. **A customer made on the device opens its form from the list.** It has no page on the server yet (no
    statement, no balance). After any save into the outbox, the form goes back to the list, where the change
    shows as "Not synced".
41. **The shell and the shared parts stay light.** The sign-out question and 18a's branch dialog load when they
    open. The sidebar reads three numbers from a store of its own, which the session fills (`sync-summary.ts`).
    The queries read the device through functions the session hands them (`device-reads.ts`), so the files on
    every page's path carry no code of `@omnivo/sync`. With all three, four chunks were still 0.2–1.7 KB over 105
    KB, and the lazy budget is 110 KB (you chose this).
42. **The offline screens' code is loaded while there is a connection.** Every page is a chunk of its own, loaded
    the first time it opens, and until step 19's service worker keeps them, a chunk the browser never loaded cannot
    load offline. Once the app is open, it fetches in the background the code of every screen that works offline:
    the products and customers lists, the customer and order forms with their parts, the Sync page, the sign-out
    question and the sign-in page. The first load stays as it is; the rest comes once per page load. Found by
    18b.7's tests.

## 18b.1 — `packages/contracts`: the contract

The contract first, as always. `sync.ts` gets the push: the three commands, the request and the answers. The sales
order and customer files share two schemas with it, `sales.ts` gets the price rule both the API and the offline form
use, and the rest are small: three error codes, and the device on an audit entry.

### `sync.ts`: the push

```diff
@@ -1,11 +1,19 @@
 import { z } from 'zod';
 
-import { customerGroupSchema, customerSchema } from './customers.js';
-import { errorCode } from './errors.js';
+import {
+  customerAddressInputSchema,
+  customerGroupSchema,
+  customerInputSchema,
+  customerSchema,
+  MAX_CUSTOMER_ADDRESSES,
+} from './customers.js';
+import { errorCode, problemSchema } from './errors.js';
+import { versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
 import { priceListSchema } from './price-lists.js';
 import { productCategorySchema } from './product-categories.js';
 import { productSchema } from './products.js';
+import { salesOrderDraftInputSchema } from './sales-orders.js';
 import { settingsSchema } from './settings.js';
 import { taxRateSchema } from './tax-rates.js';
 import { unitSchema } from './units.js';
@@ -210,6 +218,207 @@ export const syncPullSchema = z.object({
 });
 export type SyncPull = z.infer<typeof syncPullSchema>;
 
+// ---------------------------------------------------------------------------------------------
+// The push (step 18b): work done on a device without a connection, sent later as commands.
+//
+//   POST /sync/push {deviceId, protocol, commands}   → one result per command, in the same order
+//
+// A command is one thing the person did ("added the customer Rahman Pharmacy", "wrote an order
+// for Tasnim Traders"), kept on the device in its outbox until the server took it. The server runs
+// the commands in the order sent, each in its own transaction, with the person's roles of now:
+// one refused command does not stop the ones after it. The device sends the outbox oldest first,
+// and never puts a command in a batch before the commands it needs are accepted (an order for a
+// customer made on the device waits for that customer).
+//
+// Every command has an id of its own, made by the device. The server keeps each command's answer
+// (sync_commands, step 18b.2), so a batch sent again after a lost answer gets the same answers
+// and changes nothing twice. A refused command is kept as refused: the person changes it and the
+// device sends it again under a new id.
+
+// The most commands one push sends. A sales officer back from a day in the field may have 30.
+export const MAX_PUSH_COMMANDS = 50;
+
+// And the most JSON one push sends: the API takes bodies up to 1 MiB (Fastify's default). An order
+// of 300 lines is about 60 KB, so the device stops a batch before it passes this, and a single
+// command always fits on its own.
+export const MAX_PUSH_BYTES = 512 * 1024;
+
+// An address a device adds: its id is made on the device too, because an order written on the
+// same device may already point at it (shippingAddressId) before the server has seen either
+const newAddressSchema = customerAddressInputSchema.extend({ id: z.uuidv7() });
+export type NewAddressInput = z.input<typeof newAddressSchema>;
+
+// A new customer: the form's input, with the device's ids for the customer and every address.
+// An empty code gets the next number of the C- series on the server, when the command arrives.
+export const syncCustomerInputSchema = customerInputSchema.safeExtend({
+  addresses: z.array(newAddressSchema).max(MAX_CUSTOMER_ADDRESSES),
+});
+export type SyncCustomerInput = z.infer<typeof syncCustomerInputSchema>;
+
+// One field of a customer changed on the device: the value the device had (as the API sends it,
+// so the server can compare it with its own) and the new one (as the form sends it)
+function changeOf<From extends z.ZodType, To extends z.ZodType>(from: From, to: To) {
+  return z.object({ from, to });
+}
+
+const row = customerSchema.shape;
+const input = customerInputSchema.shape;
+
+// Only the fields the person changed (decision 4): a field that is not here stays as the server
+// has it, so two people changing different fields of one customer both keep their change
+export const customerChangesSchema = z
+  .object({
+    code: changeOf(row.code, input.code),
+    name: changeOf(row.name, input.name),
+    groupId: changeOf(row.groupId, input.groupId),
+    contactPerson: changeOf(row.contactPerson, input.contactPerson),
+    phone: changeOf(row.phone, input.phone),
+    email: changeOf(row.email, input.email),
+    documentLanguage: changeOf(row.documentLanguage, input.documentLanguage),
+    bin: changeOf(row.bin, input.bin),
+    paymentTermsDays: changeOf(row.paymentTermsDays, input.paymentTermsDays),
+    creditLimit: changeOf(row.creditLimit, input.creditLimit),
+    priceListId: changeOf(row.priceListId, input.priceListId),
+    notes: changeOf(row.notes, input.notes),
+  })
+  .partial();
+export type CustomerChanges = z.infer<typeof customerChangesSchema>;
+export type CustomerField = keyof CustomerChanges;
+
+// The fields where the server wins (decision 4). They decide what a customer may buy on credit and
+// at what price, and the head office sets them: if one was changed on the server since the device
+// read it (the server's value is not the change's `from`), the server keeps its value and the
+// answer says so (a kept_server_value notice). Any other field: the change that reaches the
+// server last wins, whatever the server had.
+export const SERVER_WINS_CUSTOMER_FIELDS = [
+  'creditLimit',
+  'paymentTermsDays',
+  'priceListId',
+  'groupId',
+] as const satisfies readonly CustomerField[];
+
+// The addresses, one by one, by id (you chose this in 18b): an address added, one taken away, and
+// the fields changed in one. The same field of the same address changed in two places: the later
+// arrival wins. An address the server no longer has is not changed again.
+const addressChangeSchema = customerAddressInputSchema
+  .omit({ id: true })
+  .partial()
+  .extend({ id: z.uuid() });
+
+export const customerAddressChangesSchema = z.object({
+  add: z.array(newAddressSchema).max(MAX_CUSTOMER_ADDRESSES),
+  remove: z.array(z.uuid()).max(MAX_CUSTOMER_ADDRESSES),
+  change: z.array(addressChangeSchema).max(MAX_CUSTOMER_ADDRESSES),
+});
+export type CustomerAddressChanges = z.infer<typeof customerAddressChangesSchema>;
+
+export const SYNC_COMMAND_TYPES = [
+  'customer.create',
+  'customer.update',
+  'sales_order.create_draft',
+] as const;
+export type SyncCommandType = (typeof SYNC_COMMAND_TYPES)[number];
+
+export const customerCreateCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('customer.create'),
+  // The new customer's id, made on the device: its orders on the same device point at it
+  customerId: z.uuidv7(),
+  input: syncCustomerInputSchema,
+});
+
+export const customerUpdateCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('customer.update'),
+  customerId: z.uuid(),
+  // The version of the customer the device changed. Not checked against the server's: offline
+  // there is no "someone else saved first, reload" (decision 4). When it is still the server's
+  // version, nobody changed the customer since, and the changes apply as they are.
+  baseVersion: versionSchema,
+  changes: customerChangesSchema,
+  addresses: customerAddressChangesSchema,
+});
+
+export const salesOrderDraftCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('sales_order.create_draft'),
+  // The order's id, made on the device. It has no number until someone confirms it online.
+  orderId: z.uuidv7(),
+  input: salesOrderDraftInputSchema,
+});
+
+export const syncCommandSchema = z.discriminatedUnion('type', [
+  customerCreateCommandSchema,
+  customerUpdateCommandSchema,
+  salesOrderDraftCommandSchema,
+]);
+export type SyncCommand = z.infer<typeof syncCommandSchema>;
+export type SyncCommandInput = z.input<typeof syncCommandSchema>;
+
+// What the request holds per command: an id and a type, and the rest unread. The server reads each
+// command with syncCommandSchema on its own, so one it cannot read is refused alone, with its
+// field errors, and the commands after it still run. If the whole batch were checked here, one
+// bad command would refuse every push of that device, and its outbox would never empty.
+const pushedCommandSchema = z.looseObject({ id: z.uuid(), type: z.string().max(60) });
+
+export const syncPushInputSchema = z.object({
+  deviceId: z.uuid(),
+  // SYNC_PROTOCOL of the client, as in the pull
+  protocol: z.number().int(),
+  commands: z.array(pushedCommandSchema).min(1).max(MAX_PUSH_COMMANDS),
+});
+export type SyncPushInput = z.input<typeof syncPushInputSchema>;
+
+// Something the person should know about an accepted command. kept_server_value: these fields
+// (SERVER_WINS_CUSTOMER_FIELDS) were changed on the server since the device read them, so the
+// server kept its values. z.string() like an error code: the app shows the ones it knows.
+export const SYNC_NOTICE_CODES = ['kept_server_value'] as const;
+export type SyncNoticeCode = (typeof SYNC_NOTICE_CODES)[number];
+
+export const syncNoticeSchema = z.object({
+  code: z.string(),
+  fields: z.array(z.string()),
+});
+export type SyncNotice = z.infer<typeof syncNoticeSchema>;
+
+// Why a command was refused: the same code, params and field errors as an API error. A field's
+// path is the path in the form the command came from: inside `input` for a new customer or an
+// order ("name", "lines.2.quantity"); a customer field for a change ("creditLimit"), and an
+// address by its id, not its place ("addresses.<id>.kind").
+export const syncCommandErrorSchema = problemSchema.pick({
+  code: true,
+  params: true,
+  fieldErrors: true,
+});
+export type SyncCommandError = z.infer<typeof syncCommandErrorSchema>;
+
+export const syncResultSchema = z.discriminatedUnion('status', [
+  z.object({
+    // The command's id
+    id: z.uuid(),
+    status: z.literal('accepted'),
+    notices: z.array(syncNoticeSchema),
+    // The rows the command changed, as they are now, for the device to write at once instead of
+    // waiting for its next pull: the customer for a customer command, nothing for an order (orders
+    // are not on the device). Read when the answer is made, also for a command sent again, so an
+    // old answer never puts an older row back on the device.
+    changes: z.array(syncChangeSchema),
+  }),
+  z.object({
+    id: z.uuid(),
+    status: z.literal('rejected'),
+    error: syncCommandErrorSchema,
+  }),
+]);
+export type SyncResult = z.infer<typeof syncResultSchema>;
+
+export const syncPushSchema = z.object({
+  // One per command sent, in the same order
+  results: z.array(syncResultSchema),
+  serverTime: z.iso.datetime(),
+});
+export type SyncPush = z.infer<typeof syncPushSchema>;
+
 // ---------------------------------------------------------------------------------------------
 // Devices. Step 18a registers one; step 18c lists them, renames them, moves them to another
 // branch and revokes them.
@@ -266,4 +475,16 @@ export const syncRoutes = {
     query: syncPullQuerySchema,
     response: syncPullSchema,
   }),
+  // No permission for the route: each command needs the permission its API route needs
+  // (sales.customer.manage, sales.order.manage), checked per command with the roles of now. A
+  // person whose role lost it since gets that command refused with permission_missing.
+  push: defineRoute({
+    method: 'POST',
+    path: '/sync/push',
+    summary: 'Run the commands a device saved without a connection, in order',
+    auth: 'bearer',
+    status: 200,
+    body: syncPushInputSchema,
+    response: syncPushSchema,
+  }),
 };
```

- **The header comment is the design in one place:** what a command is, the order the server runs them in, what the
  device must do about commands that need others (decision 13), and why each one has an id (decision 10). 18b.3's
  service and 18b.6's outbox both follow it.
- **`MAX_PUSH_COMMANDS` is 50, and `MAX_PUSH_BYTES` 512 KB.** The API takes a body up to 1 MiB (Fastify's default,
  which this codebase never changed), and an order of 300 lines is about 60 KB as JSON, so 50 big orders would not
  fit. The device stops a batch at whichever limit comes first; the rest go in the next push, a moment later. Half of
  the limit leaves room for the request's own fields and for a command bigger than expected, and a batch on a slow
  line finishes before a timeout.
- **`newAddressSchema` takes `z.uuidv7()` for the id,** where the online form sends `null` for a new address. The device
  makes the id because an order written on the same device may already point at the address (decision 12).
- **`syncCustomerInputSchema` uses `safeExtend`,** not `extend`. `customerInputSchema` has a refinement (one billing
  address), and Zod 4 refuses `extend` on a schema with refinements; `safeExtend` keeps the refinement and checks at
  compile time that the new `addresses` still fits the old one (an id that is always there fits "an id or null").
- **`changeOf()` gives each field two schemas:** `from` is the API's shape (`creditLimit: "200000.0000"` or `null`) and
  `to` is the form's (`''` for no limit). The server compares `from` with its own row as the API would send it, so the
  two must be the same shape, and it writes `to` through the same rules as the form. The schemas come from
  `customerSchema.shape` and `customerInputSchema.shape`, so a new field's rules are never written twice.
- **The twelve fields are listed by hand,** not built with a loop over the keys: a loop would lose the types, and
  `addresses` is not a field like the others (it has its own merge, below).
- **`.partial()`:** a field left out is a field not changed. That is the whole of decision 6's "different fields both
  stay".
- **`SERVER_WINS_CUSTOMER_FIELDS` uses `satisfies readonly CustomerField[]`,** so a misspelled field fails the type
  check, and the list keeps its literal types for 18b.3 and the Sync page.
- **`addressChangeSchema` is the address's input made `partial()`, with an `id` that must be there:** a change names
  the address it changes and only the fields that changed. `add`, `remove` and `change` have no defaults: the device
  always sends all three, and a missing one is a bug to see, not an empty list to guess.
- **The commands are a discriminated union on `type`,** so `command.type === 'customer.update'` narrows the rest in
  the service and in the outbox. Each command's `id` is `z.uuidv7()`: the server keeps the answers by it (decision
  10), and v7 ids sort by time, like every id in the database.
- **`customerUpdateCommandSchema.customerId` is `z.uuid()`,** not v7: it is the id of a customer that already
  exists, which the server only looks up. Whether that id is v7 is not the device's business.
- **`pushedCommandSchema` is a `z.looseObject`** with only `id` and `type` (decision 11). A loose object keeps the rest
  of the command as it came, for the server to read with `syncCommandSchema`; a plain object would drop it.
  `SyncCommandInput` fits it, so the device's outbox sends its commands without a cast.
- **`protocol` is a `z.number()` here,** not `z.coerce`: the push is a JSON body, where a number is a number. The pull
  reads it from a query string.
- **A notice's `code` is `z.string()`,** with the codes the app knows in `SYNC_NOTICE_CODES`, like error codes and
  audit actions: a newer server's notice must not make an older app refuse the whole answer.
- **`syncCommandErrorSchema` picks from `problemSchema`,** so a refused command carries what an API error carries, and
  the form shows it with the same code that maps errors to fields today. Its comment says what the paths are
  (decision 22).
- **An accepted result carries `changes` in the pull's shape** (`syncChangeSchema`), so the device writes them with the
  code that writes a pull's page (decision 18).
- **`push` is a `POST` that answers `200`,** not `201`: one push may create nothing (every command refused) or a few
  things of different kinds.

```diff
@@ -1,13 +1,21 @@
 import { describe, expect, it } from 'vitest';
 
+import { contractErrorMap } from './errors.js';
 import {
+  customerUpdateCommandSchema,
   priceListItemKey,
   registerDeviceInputSchema,
+  salesOrderDraftCommandSchema,
   stockKey,
   syncChangeSchema,
+  syncCommandSchema,
   syncCustomerSchema,
   syncPullQuerySchema,
   syncPullSchema,
+  syncPushInputSchema,
+  syncPushSchema,
+  type SyncCommandInput,
+  type SyncPushInput,
 } from './sync.js';
 
 const WAREHOUSE = '0192f1c4-0000-7000-8000-00000000000a';
@@ -172,3 +180,214 @@ describe('device registration', () => {
     ]);
   });
 });
+
+// ---------------------------------------------------------------------------------------------
+// The push (step 18b)
+
+const COMMAND = '0192f1c5-0000-7000-8000-000000000001';
+const CUSTOMER = '0192f1c5-0000-7000-8000-000000000002';
+const ADDRESS = '0192f1c5-0000-7000-8000-000000000003';
+const ORDER = '0192f1c5-0000-7000-8000-000000000004';
+const RATE = '0192f1c5-0000-7000-8000-000000000005';
+// A v4 id: what another library would make
+const V4 = '6f1c2a4e-1111-4111-8111-111111111111';
+
+// The error codes where the form will show them: field path → code
+function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
+  return Object.fromEntries(
+    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
+  );
+}
+
+// A pharmacy a sales officer adds in Chattogram with no signal: as the customer form sends it
+function newCustomer(extra: object = {}) {
+  return {
+    code: '',
+    name: 'Rahman Pharmacy',
+    groupId: '',
+    contactPerson: 'Abdur Rahman',
+    phone: '01819-123456',
+    email: '',
+    documentLanguage: 'bn' as const,
+    bin: '',
+    paymentTermsDays: 15,
+    creditLimit: '',
+    priceListId: '',
+    notes: '',
+    addresses: [
+      {
+        id: ADDRESS,
+        kind: 'billing' as const,
+        label: '',
+        address: 'Agrabad C/A, Chattogram',
+        phone: '',
+      },
+    ],
+    ...extra,
+  };
+}
+
+describe('sync commands', () => {
+  it('adds a customer with the device ids, and leaves the code to the server', () => {
+    const command = syncCommandSchema.parse({
+      id: COMMAND,
+      type: 'customer.create',
+      customerId: CUSTOMER,
+      input: newCustomer(),
+    });
+    expect(command.type === 'customer.create' && command.input).toMatchObject({
+      code: null,
+      creditLimit: null,
+      addresses: [{ id: ADDRESS, label: null, phone: null }],
+    });
+  });
+
+  it('needs a UUIDv7 for every new id, an address too', () => {
+    const result = syncCommandSchema.safeParse(
+      {
+        id: V4,
+        type: 'customer.create',
+        customerId: V4,
+        input: newCustomer({
+          addresses: [
+            { id: null, kind: 'billing', label: '', address: 'Agrabad C/A, Chattogram', phone: '' },
+          ],
+        }),
+      },
+      { error: contractErrorMap },
+    );
+    expect(errorsOf(result)).toEqual({
+      id: 'invalid_format',
+      customerId: 'invalid_format',
+      'input.addresses.0.id': 'invalid_value',
+    });
+  });
+
+  it("keeps the form's one-billing rule", () => {
+    const result = syncCommandSchema.safeParse({
+      id: COMMAND,
+      type: 'customer.create',
+      customerId: CUSTOMER,
+      input: newCustomer({
+        addresses: [
+          {
+            id: ADDRESS,
+            kind: 'billing',
+            label: '',
+            address: 'Agrabad C/A, Chattogram',
+            phone: '',
+          },
+          { id: ORDER, kind: 'billing', label: '', address: 'GEC Circle, Chattogram', phone: '' },
+        ],
+      }),
+    });
+    expect(errorsOf(result)).toEqual({ 'input.addresses.1.kind': 'customer_billing_twice' });
+  });
+
+  it('changes only the fields sent: the old value as the API sent it, the new as the form', () => {
+    const command = customerUpdateCommandSchema.parse({
+      id: COMMAND,
+      type: 'customer.update',
+      customerId: CUSTOMER,
+      baseVersion: 4,
+      changes: {
+        creditLimit: { from: '200000.0000', to: '' },
+        phone: { from: null, to: ' 01711-000000 ' },
+      },
+      addresses: {
+        add: [],
+        remove: [],
+        change: [{ id: ADDRESS, label: 'Head office' }],
+      },
+    });
+    // '' is "no limit" in the form, null on the server
+    expect(command.changes).toEqual({
+      creditLimit: { from: '200000.0000', to: null },
+      phone: { from: null, to: '01711-000000' },
+    });
+    expect(command.addresses.change).toEqual([{ id: ADDRESS, label: 'Head office' }]);
+  });
+
+  it('writes an order as a draft only, and still checks its dates', () => {
+    const order = {
+      customerId: CUSTOMER,
+      date: '2026-10-21',
+      customerReference: '',
+      deliveryDate: '2026-10-20',
+      warehouseId: CUSTOMER,
+      shippingAddressId: ADDRESS,
+      note: '',
+      lines: [
+        {
+          variantId: VARIANT,
+          unitId: UNIT,
+          quantity: '20',
+          description: '',
+          unitPrice: '120',
+          discountType: 'percent',
+          discount: '',
+          taxRateId: RATE,
+        },
+      ],
+      // A device cannot confirm: the field is dropped, not obeyed
+      confirm: true,
+    };
+    const command = { id: COMMAND, type: 'sales_order.create_draft', orderId: ORDER };
+    expect(errorsOf(salesOrderDraftCommandSchema.safeParse({ ...command, input: order }))).toEqual({
+      'input.deliveryDate': 'order_delivery_date',
+    });
+    const parsed = salesOrderDraftCommandSchema.parse({
+      ...command,
+      input: { ...order, deliveryDate: '' },
+    });
+    expect(parsed.input).not.toHaveProperty('confirm');
+  });
+});
+
+describe('push', () => {
+  it('takes a command it cannot read, so the server can refuse that one alone', () => {
+    const command: SyncCommandInput = {
+      id: COMMAND,
+      type: 'customer.create',
+      customerId: CUSTOMER,
+      input: newCustomer(),
+    };
+    // A command the device made fits what the request takes, as a type too
+    const commands: SyncPushInput['commands'] = [command, { id: ORDER, type: 'sale.refund' }];
+    const input = syncPushInputSchema.parse({ deviceId: CUSTOMER, protocol: 1, commands });
+    expect(input.commands[0]).toEqual(command);
+    expect(syncCommandSchema.safeParse(input.commands[1]).success).toBe(false);
+  });
+
+  it('sends at most 50 commands, and at least one', () => {
+    const commands = Array.from({ length: 51 }, () => ({ id: COMMAND, type: 'customer.create' }));
+    expect(
+      syncPushInputSchema.safeParse({ deviceId: CUSTOMER, protocol: 1, commands }).success,
+    ).toBe(false);
+    expect(
+      syncPushInputSchema.safeParse({ deviceId: CUSTOMER, protocol: 1, commands: [] }).success,
+    ).toBe(false);
+  });
+
+  it('answers each command: accepted with its rows and notices, or refused with its error', () => {
+    const answer = syncPushSchema.parse({
+      results: [
+        {
+          id: COMMAND,
+          status: 'accepted',
+          notices: [{ code: 'kept_server_value', fields: ['creditLimit'] }],
+          changes: [],
+        },
+        {
+          id: ORDER,
+          status: 'rejected',
+          error: { code: 'customer_code_taken', fieldErrors: { code: ['customer_code_taken'] } },
+        },
+      ],
+      serverTime: AT,
+    });
+    const [accepted, rejected] = answer.results;
+    expect(accepted?.status === 'accepted' && accepted.notices[0]?.fields).toEqual(['creditLimit']);
+    expect(rejected?.status === 'rejected' && rejected.error.code).toBe('customer_code_taken');
+  });
+});
```

- **The fixtures are a sales officer's day in Chattogram:** Rahman Pharmacy added with no signal, then an order for it
  that points at its billing address.
- **"Needs a UUIDv7 for every new id"** sends a v4 id and a `null` address id: the codes are the ones the outbox shows
  if a bug ever made such a command.
- **"Keeps the form's one-billing rule" is a separate test.** Zod 4 runs an object's refinements only when its fields
  passed, so the rule cannot be seen in the test with the bad ids. Here every id is right, and the error sits on the
  second billing address, like in the form.
- **"Writes an order as a draft only"** sends `confirm: true` on purpose: it is dropped while parsing, so even a device
  with a bug cannot confirm an order.
- **"Takes a command it cannot read"** is decision 11 as a test: `sale.refund` is not a command, yet the request
  parses, and only `syncCommandSchema` refuses it. The typed `commands` line checks at compile time that a
  `SyncCommandInput` fits the request.

### `sales-orders.ts`, `customers.ts`: two shared schemas

```diff
@@ -100,9 +100,11 @@ const salesOrderFieldsSchema = salesDocumentFieldsSchema.extend({
   overrideCreditLimit: z.boolean().default(false),
 });
 
-type OrderRuleInput = z.output<typeof salesOrderFieldsSchema>;
-
-function orderRules(input: OrderRuleInput, ctx: z.RefinementCtx<OrderRuleInput>) {
+// Generic, so the offline draft below (without confirm and the override) shares the rule
+function orderRules<T extends { date: string; deliveryDate: string | null }>(
+  input: T,
+  ctx: z.RefinementCtx<T>,
+) {
   if (input.deliveryDate !== null && input.deliveryDate < input.date) {
     ctx.addIssue({
       code: 'custom',
@@ -126,6 +128,16 @@ export const updateSalesOrderInputSchema = salesOrderFieldsSchema
 export type UpdateSalesOrderInput = z.infer<typeof updateSalesOrderInputSchema>;
 export type SalesOrderFormValues = z.input<typeof updateSalesOrderInputSchema>;
 
+// A draft written on a device without a connection (step 18b), sent later in a sync command.
+// Only a draft: confirming checks the credit limit against what the customer owes now, which only
+// the server knows, so the order is confirmed online. No quotation either: "Make order" opens the
+// quotation's page, which is online. The order's id is the device's (sync.ts).
+export const salesOrderDraftInputSchema = salesOrderFieldsSchema
+  .omit({ confirm: true, overrideCreditLimit: true })
+  .superRefine(orderRules);
+export type SalesOrderDraftInput = z.infer<typeof salesOrderDraftInputSchema>;
+export type SalesOrderDraftFormValues = z.input<typeof salesOrderDraftInputSchema>;
+
 export const salesOrderVersionInputSchema = z.object({ version: versionSchema });
 
 // Confirming checks the credit limit (step 15c), so it can carry the override
```

- **`orderRules` becomes generic.** It only reads `date` and `deliveryDate`, and its old parameter type was the whole
  online input (with `confirm`), which the draft schema does not have. A generic over "anything with these two fields"
  lets both schemas share the rule, and `z.RefinementCtx<T>` keeps the issue's path typed.
- **`salesOrderDraftInputSchema` omits `confirm` and `overrideCreditLimit`** (decision 15). `omit` works here because
  `salesOrderFieldsSchema` has no refinement yet; the rule is added after.
- **The draft has no `quotationId`:** it is built from the fields, not from `salesOrderInputSchema`.

```diff
@@ -97,7 +97,7 @@ const optionalIdSchema = z
   .transform((value) => (value === '' ? null : value))
   .nullable();
 
-const customerAddressInputSchema = z.object({
+export const customerAddressInputSchema = z.object({
   // An existing address keeps its id: a delivery (step 15b) points at the address it went to
   id: z.uuid().nullable(),
   kind: z.enum(ADDRESS_KINDS),
```

- **`customerAddressInputSchema` is exported,** for the new address and the address change in `sync.ts`. Its rules
  (the address at least 5 letters, a label up to 60) then hold for an address written offline too.

### `sales.ts`: the price a line starts with

```diff
@@ -10,6 +10,7 @@ import {
   isMoneyAmount,
   multiplyMoney,
   percentOfMoney,
+  priceInUnit,
   requiredPriceSchema,
   subtractMoney,
   sumMoney,
@@ -274,6 +275,25 @@ export const priceLookupItemSchema = z.object({
 });
 export type PriceLookupItem = z.infer<typeof priceLookupItemSchema>;
 
+// The price rule of the lookup, in one place (step 18b): the API's lookup and the order form on a
+// device without a connection both start a line with it, so a line gets the same price online and
+// offline.
+//   listPrice  the price of the customer's price list for this variant in this unit, if the list is
+//              active and has one; else null
+//   salePrice  the variant's own sale price, per base unit; null = none set
+//   factor     the unit's size in the base unit, as product_units.factor keeps it: "1" for the base
+//              unit, "24" for a case of 24, "0.914400" for a yard in metres
+export function startingPrice(input: {
+  listPrice: string | null;
+  salePrice: string | null;
+  factor: string;
+}): Pick<PriceLookupItem, 'price' | 'source'> {
+  if (input.listPrice !== null) return { price: sumMoney([input.listPrice]), source: 'price_list' };
+  if (input.salePrice === null) return { price: null, source: null };
+  // salePrice × factor, to the 4 decimals a price keeps: a case of 24 at ৳21 a piece is ৳504
+  return { price: priceInUnit(input.salePrice, '1', input.factor), source: 'product' };
+}
+
 export const priceLookupSchema = z.object({
   // The workspace setting now: a new document copies it
   pricesIncludeVat: z.boolean(),
```

- **`startingPrice()` is the rule of `PriceLookupService`,** written once (decision 19). The API's SQL works out the
  same numbers today; 18b.3 makes the lookup read the three values and call this function.
- **`sumMoney([listPrice])`** only writes the list's price with 4 decimals, the way Postgres sends a `NUMERIC(19,4)`:
  the device's copy and the API's answer then hold the same string.
- **`priceInUnit(salePrice, '1', factor)`** multiplies by the unit's factor and rounds once, half away from zero, to 4
  decimals: exactly Postgres's `round(sale_price * factor, 4)`. A yard of fabric priced by the metre is the case that
  shows it (the factor has 6 decimals).
- **The VAT rate is not in it:** "the product's own rate if it is active, else the default" is one line, and the
  device and the API each have the rate in a different form.

```diff
@@ -10,6 +10,7 @@ import {
   draftLineAmounts,
   lineAmounts,
   salesLineInputSchema,
+  startingPrice,
 } from './sales.js';
 
 const CUSTOMER = '01920000-0000-7000-8000-000000000001';
@@ -202,6 +203,35 @@ describe('sales line input', () => {
   });
 });
 
+describe('starting price', () => {
+  it("takes the price list's price as it is", () => {
+    expect(startingPrice({ listPrice: '504', salePrice: '21.0000', factor: '24' })).toEqual({
+      price: '504.0000',
+      source: 'price_list',
+    });
+  });
+
+  it("works out the product's price in the unit, to 4 decimals", () => {
+    // A case of 24 at ৳21 a piece
+    expect(startingPrice({ listPrice: null, salePrice: '21.0000', factor: '24' })).toEqual({
+      price: '504.0000',
+      source: 'product',
+    });
+    // A yard of fabric priced by the metre: 0.8512 × 0.9144 = 0.77833728
+    expect(startingPrice({ listPrice: null, salePrice: '0.8512', factor: '0.914400' })).toEqual({
+      price: '0.7783',
+      source: 'product',
+    });
+  });
+
+  it('starts with no price when there is none anywhere', () => {
+    expect(startingPrice({ listPrice: null, salePrice: null, factor: '1' })).toEqual({
+      price: null,
+      source: null,
+    });
+  });
+});
+
 describe('sales documents', () => {
   it('ends a quotation on or after its date', () => {
     const quotation = {
```

### `errors.ts`, `audit.ts`

```diff
@@ -480,6 +480,12 @@ export const ERROR_CODES = [
   'device_revoked',
   // The app was built for another version of the sync (SYNC_PROTOCOL): reload it
   'sync_protocol_mismatch',
+  // Step 18b: a command from a device. An id the device made (a customer, an address, an order) is
+  // already used by something else; a command type this server does not run; the customer a
+  // change is for was deleted, or is no longer a customer.
+  'sync_id_taken',
+  'sync_command_invalid',
+  'sync_customer_gone',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **`sync_id_taken`** (decision 12). It is not an error the person caused: two devices cannot make the same UUIDv7,
  so in practice it means a command was built from another command's ids by a bug. The outbox shows it like any
  refusal, and Discard is the way out.
- **`sync_command_invalid`** answers a type this server does not run. The protocol check (decision 21) keeps an older
  server from ever seeing a newer command, so this is a bug too, but it must refuse the command alone, not the push.
- **`sync_customer_gone`:** a change for a customer deleted on the server, or one that is now only a supplier. The
  change cannot be applied anywhere, and the person must know it was not.
- **No new codes for the rest:** a code taken, a warehouse archived, a permission lost are the API's own codes, and
  their texts already say how to fix them.

```diff
@@ -278,6 +278,9 @@ export const auditEntrySchema = z.object({
   entityId: z.uuid(),
   // null = the system itself: a background job in the worker (step 8)
   actor: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
+  // The device the change was made on without a connection (step 18b), sent later in a sync
+  // command; null for a change made online
+  device: z.object({ id: z.uuid(), name: z.string() }).nullable(),
   changes: auditChangesSchema,
   ipAddress: z.string().nullable(),
   requestId: z.string().nullable(),
```

- **`device` is `{id, name}` or `null`** (decision 20): the audit page shows the name, and the id finds the device in
  18c's list even after it is renamed. Every audit entry the API and the mock send must now have it; the mock's
  entries get `device: null` in 18b.7.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
```

Both pass (contracts 282 tests, 11 new). Do not run the whole `pnpm typecheck` yet: `en.ts` misses the three new error
codes until 18b.5, the API's audit list does not send `device` until 18b.3, and the API's route test
(`apps/api/src/contract.spec.ts`) fails until 18b.3 serves `POST /sync/push`.

## 18b.2 — `packages/db`: the answers, and the device on the audit log

One new table, `sync_commands`: the answer to every command a device pushed, so a command sent twice runs once
(decision 10). And one new column, `audit_logs.device_id` (decision 20). Migration 0045 is generated from the schema,
with one statement moved by hand; 0046 is written by hand: row-level security and the rights.

### `schema/sync.ts`: the answers table

```diff
@@ -1,13 +1,23 @@
-import type { SyncEntity } from '@omnivo/contracts';
+import type {
+  SyncCommandError,
+  SyncCommandType,
+  SyncEntity,
+  SyncNotice,
+  SyncResult,
+} from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
 import {
   bigint,
   customType,
   foreignKey,
+  check,
   index,
+  jsonb,
   pgTable,
+  primaryKey,
   text,
   timestamp,
+  uniqueIndex,
   uuid,
 } from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
@@ -81,6 +91,8 @@ export const devices = pgTable(
     revokedAt: timestamp('revoked_at', { withTimezone: true }),
   },
   (table) => [
+    // The target of the composite FKs from sync_commands and audit_logs: never another tenant's device
+    uniqueIndex('devices_tenant_id_idx').on(table.tenantId, table.id),
     // A person's devices (step 18c's list) — and Postgres's own check of the membership FK
     index('devices_tenant_user_idx').on(table.tenantId, table.userId),
     // The devices of a branch, and the branch FK's own check
@@ -99,3 +111,57 @@ export const devices = pgTable(
     }),
   ],
 );
+
+const SYNC_COMMAND_STATUSES = [
+  'accepted',
+  'rejected',
+] as const satisfies readonly SyncResult['status'][];
+
+// The answer to every command a device pushed (step 18b, decision 10). The push looks a command
+// up here first: one found is answered from this row, never run again, so a batch sent again
+// after its answer was lost makes one customer, not two. A row is written once, in the same
+// transaction as the command's own work, and never changed (migration 0046 takes UPDATE and
+// DELETE away from the API); the worker deletes the rows older than 30 days, like the change log.
+// A command the server could not read at all (no such type, a bad field) has no row: the same
+// bytes always give the same refusal, so there is nothing to keep.
+export const syncCommands = pgTable(
+  'sync_commands',
+  {
+    // The command's own id, made by the device (not the customer's or the order's)
+    id: uuid('id').notNull(),
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    deviceId: uuid('device_id').notNull(),
+    // $type, no check, like the change log's entity: a type a later step drops keeps its old rows
+    type: text('type').$type<SyncCommandType>().notNull(),
+    // The customer or the order the command is about. An accepted command sent again is answered
+    // with this row as it is NOW (decision 18), so the answer needs to know which one it was.
+    entityId: uuid('entity_id').notNull(),
+    status: text('status', { enum: SYNC_COMMAND_STATUSES }).notNull(),
+    // An accepted command's notices (kept_server_value), [] when there are none
+    notices: jsonb('notices').$type<SyncNotice[]>().notNull().default([]),
+    // A refused command's error: code, params and field errors, as the device was told
+    error: jsonb('error').$type<SyncCommandError>(),
+    // When the server ran it. For pruning, and for support ("when did this order arrive?")
+    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
+  },
+  (table) => [
+    // The lookup of a pushed command. The tenant first: another tenant's command is never found,
+    // and its id never blocks this tenant's.
+    primaryKey({ name: 'sync_commands_pkey', columns: [table.tenantId, table.id] }),
+    // The worker's pruning: the oldest rows of every tenant
+    index('sync_commands_created_idx').on(table.createdAt),
+    foreignKey({
+      name: 'sync_commands_device_fk',
+      columns: [table.tenantId, table.deviceId],
+      foreignColumns: [devices.tenantId, devices.id],
+    }),
+    check('sync_commands_status_check', sql`${table.status} IN ('accepted', 'rejected')`),
+    // A refused command has its error, an accepted one has none
+    check(
+      'sync_commands_error_check',
+      sql`(${table.status} = 'rejected') = (${table.error} IS NOT NULL)`,
+    ),
+  ],
+);
```

- **`devices_tenant_id_idx` is new on `devices`.** A composite foreign key needs a unique index on exactly its target
  columns, and `devices` had only its primary key on `id`. Every table that other tables point at with the tenant
  has one (`branches_tenant_id_idx`, `parties_tenant_id_idx`).
- **`SYNC_COMMAND_STATUSES ... satisfies readonly SyncResult['status'][]`:** the two statuses are the contract's,
  and `satisfies` makes the type check fail if the contract ever renames one, without widening the tuple Drizzle
  needs for `{ enum }`.
- **The primary key is `(tenant_id, id)`, not `id`.** The push looks a command up by both, so this index is the
  lookup. With the tenant first, another tenant's row is never found, and its id can never make this tenant's insert
  fail: with `id` alone, the unique check sees every tenant's rows, under RLS too, and the error would tell one
  workspace that an id exists in another.
- **The command's id is not the entity's id** (decision 10). A customer may have many commands: its create, then
  three changes. `entity_id` is the customer or the order the command is about. An accepted command sent again is
  answered with that row as it is now (decision 18), so the answer must know which row it was; the stored answer
  itself holds no row.
- **`type` has a `$type`, no check,** like the change log's `entity` (18a.2): a type a later step drops keeps its
  old rows until they are pruned.
- **`status`, `notices`, `error` are the answer** (the contract's `syncResultSchema` without the rows). `notices`
  defaults to `[]`, so a plain accepted insert needs no value. `error` is the `{code, params, fieldErrors}` the device
  was told, as `jsonb`: the server never looks inside it, it only sends it back.
- **`sync_commands_status_check` and `sync_commands_error_check`.** A row with a status of its own, or a refused
  command without its error, would be answered as a broken result to a device that cannot ask again. The second
  check says it in one line: refused exactly when there is an error.
- **`sync_commands_device_fk`** is the same composite key as every reference: the device is this workspace's.
- **`sync_commands_created_idx`** is for the worker's cleanup only, like `sync_changes_created_idx`.
- **No `updated_at`, `version`, `deleted_at`** (no `baseColumns()`): a row is written once and never changed
  (decision 23).

### `schema/audit-logs.ts`: the device

```diff
@@ -29,6 +29,11 @@ export const auditLogs = pgTable(
     // inet: Postgres নিজেই IP-র আকার যাচাই করে, আর পরে "এই subnet থেকে" খোঁজা যায়
     ipAddress: inet('ip_address'),
     userAgent: text('user_agent'),
+    // The device a command came from (step 18b, decision 20): a change made offline is written when
+    // it reaches the server, maybe hours later, so the request alone does not say where it was made.
+    // NULL for everything done online. No FK, like actor_user_id and entity_id: an audit row only
+    // records what happened. The audit list joins devices on (tenant_id, device_id) for the name.
+    deviceId: uuid('device_id'),
     createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
   },
   (table) => [
```

- **A plain nullable `uuid`, and no foreign key** (decision 26). Every row written online leaves it `NULL`. The audit
  list in 18b.3 finds the name with `LEFT JOIN devices ON devices.tenant_id = audit_logs.tenant_id AND devices.id =
  audit_logs.device_id`; devices are never deleted, so the name is always there.
- **No index on it.** Nothing asks "everything this device did" yet; 18c's device list may, and adds one then.

### Migration 0045 (generated, one statement moved)

Run `pnpm --filter @omnivo/db generate --name sync-commands`. Drizzle writes the new unique index on `devices` last,
after the foreign key that needs it, and Postgres refuses that ("there is no unique constraint matching given keys
for referenced table"). Move the `CREATE UNIQUE INDEX "devices_tenant_id_idx"` statement up, before the two
`ALTER TABLE "sync_commands" ADD CONSTRAINT` statements, with its `--> statement-breakpoint`:

```sql
CREATE TABLE "sync_commands" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"status" text NOT NULL,
	"notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_commands_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "sync_commands_status_check" CHECK ("sync_commands"."status" IN ('accepted', 'rejected')),
	CONSTRAINT "sync_commands_error_check" CHECK (("sync_commands"."status" = 'rejected') = ("sync_commands"."error" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "device_id" uuid;--> statement-breakpoint
-- Moved up by hand: the FK below needs this unique index to exist already
CREATE UNIQUE INDEX "devices_tenant_id_idx" ON "devices" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_commands_created_idx" ON "sync_commands" USING btree ("created_at");
```

- **`ALTER TABLE "audit_logs" ADD COLUMN "device_id" uuid`** is instant on any size of table: a nullable column with
  no default changes only the catalog, not the rows.
- **The unique index on `devices` reads the devices table once,** which holds a few rows per person. Nothing waits.
- `meta/_journal.json` and `meta/0045_snapshot.json` change too. They are generated; commit them as they are. The
  snapshot does not record the order of the statements, so the next `generate` does not undo the move.

### Migration 0046 (custom): row-level security and the rights

Run `pnpm --filter @omnivo/db generate --custom --name sync-commands-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
ALTER TABLE sync_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) An answer is written once and never changed (decision 10). A device that sends a command
--    again must get the answer it would have got the first time; an UPDATE could turn a refusal
--    into an acceptance that never ran, or the other way round. So the push (18b.3) never claims
--    a command with a row it fills in later: it locks the command's id, looks it up, runs the
--    command behind a savepoint, and inserts the finished answer, all in one transaction.
REVOKE UPDATE, DELETE ON sync_commands FROM omnivo_app;

-- 3) The answers keep 30 days, like the change log (0044): a device sends a command again within
--    minutes of a lost answer, never a month later. The worker's hourly cleanup deletes the older
--    rows of EVERY tenant in one statement, as omnivo_worker: this policy is for that role only.
GRANT SELECT, DELETE ON sync_commands TO omnivo_worker;
CREATE POLICY sync_prune ON sync_commands
  TO omnivo_worker
  USING (true)
  WITH CHECK (true);
```

- **Section 1** is the RLS of every tenant table, written out for one table instead of the usual loop.
- **Section 2 makes the table insert-only for the API** (decision 23). The comment says how the push stays correct
  without an update; 18b.3 builds exactly that. The lock is a transaction-level advisory lock on the command id
  (`pg_advisory_xact_lock(hashtextextended(id::text, 0))`): two pushes of one command wait for each other, two
  different commands never do, and the lock ends with the transaction, so a crashed request never leaves one behind.
- **Section 3 is the cleanup's policy and rights,** the same as `sync_changes` in 0044: the worker deletes the old
  answers of every tenant in one statement, so its policy lets it see them all; the API's role still sees one
  tenant's rows. The worker gets `SELECT` and `DELETE`, never `INSERT`.

> **What we checked.** On a throwaway database with every migration up to 0046, as `omnivo_app` (18 checks). An
> accepted answer got `[]` notices by itself, and a refused one kept its error. The same command id twice failed on
> the primary key; a refused answer without an error, an accepted one with an error, and a third status all failed
> on their checks; another tenant's device and a device that does not exist failed on the device key; a row for
> another tenant failed on row-level security; and the API's role could neither change nor delete an answer. An
> audit row with a device found its name through the join, and an online row had none. The other tenant saw none of
> these answers and could use the same command id for a command of its own; without a tenant context there was
> nothing to see. The worker's role saw both tenants' answers, deleted the ones older than 30 days, and could not
> insert one.
>
> **The race (decision 23).** Session A took the lock on a command, found no answer, wrote a unit behind a savepoint,
> held its transaction for 3 seconds, and inserted the accepted answer. Session B sent the same command a second
> later: it waited on the lock, then found "accepted" and did nothing. One unit. The same two sessions without the
> lock both found nothing, so B would have run the command a second time. A command whose work failed (an id already
> taken) rolled back to its savepoint, and its refusal was kept: refused, with its code, and no unit.
>
> The API's integration and tenant-leak suites (`apps/api`, 54 files, 607 tests) fail the same 47 tests with this
> part's migrations and without them. They fail because of 18b.1, not this part: the audit list does not send the new
> `device` field until 18b.3, so 43 tests that read it fail, and 4 more tests later in those files fail with them.
> 18b.3 makes them pass again.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
```

`pnpm db:migrate` applies 0045 and 0046 to your dev database. Then `pnpm --filter @omnivo/db build`, so the API sees
the new table and column in 18b.3. As in 18b.1, do not run the whole `pnpm typecheck` yet.

## 18b.3 — `apps/api`: the push

The server half of the push: one new service that runs the commands, a pure merge for a customer changed on a
device, a second door into the customer and order services, the price lookup on the shared rule, and the device on
the audit log. At the end of this part the API's integration suites pass again (18b.1's audit `device` broke 47 of
them).

### `common/tenant/tenant-context.ts`, `common/audit/audit.ts`: the device on every audit row

```diff
@@ -5,6 +5,8 @@ export interface TenantStore {
   tenantId: string;
   // HTTP request-এ AuthMiddleware বসায়; background job-এ (ধাপ ৮) শুধু tenantId থাকবে
   principal?: Principal;
+  // Step 18b: the device a sync command came from. The audit rows its work writes carry it.
+  deviceId?: string;
 }
 
 export const tenantStorage = new AsyncLocalStorage<TenantStore>();
@@ -32,3 +34,16 @@ export function currentPrincipal(): Principal {
   }
   return principal;
 }
+
+// Step 18b: run one pushed command as the device's work. The tenant and the person stay as they
+// are; only the device is added, so every audit row the command's services write names it without
+// each service passing it on.
+export function runFromDevice<T>(deviceId: string, fn: () => T): T {
+  const store = tenantStorage.getStore();
+  if (!store) throw new Error('No tenant context — runFromDevice needs a signed-in request');
+  return tenantStorage.run({ ...store, deviceId }, fn);
+}
+
+export function currentDeviceId(): string | null {
+  return tenantStorage.getStore()?.deviceId ?? null;
+}
```

- **`deviceId` sits next to the principal in the same store** (decision 27). The push wraps each command in
  `runFromDevice()`, and everything the command's services do inside it — down to the audit writer — sees the
  device without being told.
- **`runFromDevice` copies the store and adds one field.** `tenantStorage.run()` replaces the store for the code
  inside it, so the tenant and the principal must be copied in, or `getTenantId()` would throw inside the command.
  It throws when there is no store at all: a push always runs in a signed-in request, so that would be a bug.
- **The store is not changed in place** (`store.deviceId = …`): the next command of the same push, or code that runs
  after the push in the same request, would still see the device.

```diff
@@ -3,7 +3,7 @@ import { auditLogs } from '@omnivo/db';
 import { sql } from 'drizzle-orm';
 
 import { currentRequest } from '../request/request-context.js';
-import { tenantStorage } from '../tenant/tenant-context.js';
+import { currentDeviceId, tenantStorage } from '../tenant/tenant-context.js';
 import type { Transaction } from '../tenant/with-tenant.js';
 
 export interface AuditEvent {
@@ -28,6 +28,8 @@ export async function audit(tx: Transaction, event: AuditEvent): Promise<void> {
     action: event.action,
     entityType: event.entityType,
     entityId: event.entityId,
+    // Step 18b: set while a pushed command runs (runFromDevice); null for work done online
+    deviceId: currentDeviceId(),
     payload: { changes: event.changes ?? {} },
     requestId: request?.id ?? null,
     ipAddress: request?.ipAddress ?? null,
```

- **`deviceId: currentDeviceId()`** is the only change: `NULL` online, the device inside a push. 18b.2's column has
  no foreign key (decision 26), so a device id is never refused here.

### `audit/audit.controller.ts`: the device's name

```diff
@@ -1,6 +1,6 @@
 import { Controller, Inject } from '@nestjs/common';
 import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
-import { auditLogs, users } from '@omnivo/db';
+import { auditLogs, devices, users } from '@omnivo/db';
 import { and, desc, eq, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
@@ -38,10 +38,19 @@ export class AuditController {
           createdAtText: sql<string>`${auditLogs.createdAt}::text`,
           actorId: users.id,
           actorName: users.fullName,
+          deviceId: devices.id,
+          deviceName: devices.name,
         })
         .from(auditLogs)
         // users-এ RLS নেই — কিন্তু join শুধু এই টেন্যান্টের audit রো-র actor-এ, তাই বাইরের কেউ আসে না
         .leftJoin(users, eq(users.id, auditLogs.actorUserId))
+        // Step 18b: the device a change was sent from. No foreign key (18b's decision 26), but
+        // devices are never deleted, so the name is there; the tenant in the join keeps it to this
+        // workspace's devices (RLS does too)
+        .leftJoin(
+          devices,
+          and(eq(devices.tenantId, auditLogs.tenantId), eq(devices.id, auditLogs.deviceId)),
+        )
         .where(
           and(
             eq(auditLogs.tenantId, tenantId),
@@ -71,6 +80,10 @@ export class AuditController {
             row.actorId !== null && row.actorName !== null
               ? { id: row.actorId, fullName: row.actorName }
               : null,
+          device:
+            row.deviceId !== null && row.deviceName !== null
+              ? { id: row.deviceId, name: row.deviceName }
+              : null,
           changes: row.payload?.changes ?? {},
           ipAddress: row.ipAddress,
           requestId: row.requestId,
```

- **A `LEFT JOIN`, with the tenant in the condition.** Most rows have no device. The tenant keeps the join to this
  workspace's devices even if a wrong id ever got into a row; row-level security on `devices` says the same.
- **`device` is `null` unless both the id and the name came back,** like `actor`. This is what makes the 43 failing
  tests of 18b.2 pass again: each entry now has the field the contract asks for.

### `sync/sync-log-cleanup.ts`, `worker/job-runner.ts`: answers are kept 30 days

```diff
@@ -1,10 +1,11 @@
 import { Inject, Injectable } from '@nestjs/common';
-import { type Db, syncChanges } from '@omnivo/db';
+import { type Db, syncChanges, syncCommands } from '@omnivo/db';
 import { lt, sql } from 'drizzle-orm';
 
 import { RELAY_DB } from '../infra/tokens.js';
 
-// How long the change log keeps a line (decision 26). The pull gives a cursor older than one day
+// How long the change log keeps a line (decision 26), and since step 18b how long the push keeps
+// the answer to a command (18b's decision 25). The pull gives a cursor older than one day
 // less than this a full pull instead (SyncService): its lines may already be gone, and one day
 // covers a transaction that ran long and wrote its line before the cursor's watermark was taken.
 export const SYNC_LOG_DAYS = 30;
@@ -26,4 +27,14 @@ export class SyncLogCleanup {
     // postgres-js gives the number of rows deleted; RETURNING them would bring every id back
     return result.count;
   }
+
+  // Step 18b: the answers to pushed commands, the same way (sync_commands_created_idx, migration
+  // 0046's sync_prune policy). A device sends a command again minutes after a lost answer, not a
+  // month later.
+  async deleteOldAnswers(): Promise<number> {
+    const result = await this.db
+      .delete(syncCommands)
+      .where(lt(syncCommands.createdAt, sql`now() - make_interval(days => ${SYNC_LOG_DAYS})`));
+    return result.count;
+  }
 }
```

- **A second method, not a second job.** The hourly cleanup already deletes the change log's old lines as
  `omnivo_worker`; the answers go in the same hour, with the same 30 days (decision 25) and the policy 0046 made.
- **Two methods, not one that deletes both:** the 18a test of `deleteOld()` counts lines of the change log, and keeps
  doing so.

```diff
@@ -75,6 +75,9 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
       // Step 18a: the same hour, the sync change log's lines older than 30 days
       const pruned = await this.syncLog.deleteOld();
       this.logger.log(`sync log cleanup: ${String(pruned)} old lines deleted`);
+      // Step 18b: and the answers to pushed commands older than 30 days
+      const answers = await this.syncLog.deleteOldAnswers();
+      this.logger.log(`sync answers cleanup: ${String(answers)} old answers deleted`);
       return;
     }
     // A job we cannot read will never become readable: no retries
```

### `sales/customer-merge.ts`: a change from a device, merged

```ts
import {
  type AddressKind,
  type CustomerAddressChanges,
  type CustomerChanges,
  type CustomerField,
  type CustomerInput,
  MAX_CUSTOMER_ADDRESSES,
  SERVER_WINS_CUSTOMER_FIELDS,
} from '@omnivo/contracts';

import { AppError } from '../common/http/app-error.js';
import type { CustomerWithoutBalance } from './customer-read.js';

// An address as the table keeps it, with its kind typed (the API's customer has it as a string)
export interface CurrentAddress {
  id: string;
  kind: AddressKind;
  label: string | null;
  address: string;
  phone: string | null;
}

// Step 18b: a change made on a device, merged into the customer as the server has it now. Pure,
// so the rules are tested without a database (customer-merge.spec.ts); CustomersService locks
// the customer, reads it, calls this, and saves the result like a save from the form.
export interface MergedCustomer {
  // The customer to save, as the form would send it
  input: CustomerInput;
  // The head-office fields the server kept (the kept_server_value notice)
  kept: CustomerField[];
}

const SERVER_WINS: ReadonlySet<CustomerField> = new Set(SERVER_WINS_CUSTOMER_FIELDS);

export function mergeCustomer(
  now: CustomerWithoutBalance,
  addresses: CurrentAddress[],
  command: { changes: CustomerChanges; addresses: CustomerAddressChanges },
): MergedCustomer {
  const { changes } = command;
  const kept: CustomerField[] = [];

  // One field. Not changed on the device: the server's value. A head-office field the server
  // changed since the device read it (its value is no longer `from`): the server's value, and the
  // field is named in the answer. Anything else: the device's value, whatever the server had —
  // the later arrival wins (decision 6). `From extends To`: every value the API sends for a field
  // is also a value the form may send, so the server's value fits the input as it is.
  function take<From extends To, To>(
    field: CustomerField,
    change: { from: From; to: To } | undefined,
    current: From,
  ): To {
    if (change === undefined) return current;
    if (SERVER_WINS.has(field) && change.from !== current) {
      kept.push(field);
      return current;
    }
    return change.to;
  }

  // Written out field by field, not in a loop over the keys: a loop loses each field's type
  const input: CustomerInput = {
    code: take('code', changes.code, now.code),
    name: take('name', changes.name, now.name),
    groupId: take('groupId', changes.groupId, now.groupId),
    contactPerson: take('contactPerson', changes.contactPerson, now.contactPerson),
    phone: take('phone', changes.phone, now.phone),
    email: take('email', changes.email, now.email),
    documentLanguage: take('documentLanguage', changes.documentLanguage, now.documentLanguage),
    bin: take('bin', changes.bin, now.bin),
    paymentTermsDays: take('paymentTermsDays', changes.paymentTermsDays, now.paymentTermsDays),
    creditLimit: take('creditLimit', changes.creditLimit, now.creditLimit),
    priceListId: take('priceListId', changes.priceListId, now.priceListId),
    notes: take('notes', changes.notes, now.notes),
    addresses: mergeAddresses(addresses, command.addresses),
  };
  return { input, kept };
}

// The addresses, one by one, by id (decision 4). Removed: gone, if the server still has it.
// Changed: only the fields sent, on an address the server still has; one the server removed in
// the meantime stays removed (the removal was a person's decision too, decision 14). Added: at
// the end, with the device's id. Then the form's two rules again, on the merged list: two changes
// that are each fine can together give two billing addresses, or more than 20.
export function mergeAddresses(
  current: CurrentAddress[],
  changes: CustomerAddressChanges,
): CustomerInput['addresses'] {
  const removed = new Set(changes.remove);
  const changed = new Map(changes.change.map((change) => [change.id, change]));
  const own = new Set(current.map((address) => address.id));
  const taken = changes.add.find((address) => own.has(address.id));
  if (taken) throw idTaken(taken.id);

  // Every id is known here: the server's, or the device's for an added one
  const merged: (CustomerInput['addresses'][number] & { id: string })[] = [
    ...current
      .filter((address) => !removed.has(address.id))
      .map((address) => {
        const change = changed.get(address.id);
        // A field left out of the change is undefined; a field cleared on the device is null
        return {
          id: address.id,
          kind: change?.kind ?? address.kind,
          label: change?.label === undefined ? address.label : change.label,
          address: change?.address ?? address.address,
          phone: change?.phone === undefined ? address.phone : change.phone,
        };
      }),
    ...changes.add,
  ];

  if (merged.length > MAX_CUSTOMER_ADDRESSES) {
    throw new AppError(409, 'too_long', 'This customer would have too many addresses.', {
      fieldErrors: { addresses: ['too_long'] },
    });
  }
  const billing = merged.filter((address) => address.kind === 'billing');
  const second = billing[1];
  if (second !== undefined) {
    // The error sits on a billing address this change made, the one the person can fix in the
    // outbox; the other one was made on the server. Paths name an address by its id (decision 22).
    const touched = new Set([
      ...changes.add.map((address) => address.id),
      ...changes.change.flatMap((change) => (change.kind === undefined ? [] : [change.id])),
    ]);
    const { id } = billing.find((address) => touched.has(address.id)) ?? second;
    throw new AppError(409, 'customer_billing_twice', 'A customer has one billing address.', {
      fieldErrors: { [`addresses.${id}.kind`]: ['customer_billing_twice'] },
    });
  }
  return merged;
}

function idTaken(id: string): AppError {
  return new AppError(409, 'sync_id_taken', 'An id made on the device is already used.', {
    fieldErrors: { [`addresses.${id}`]: ['sync_id_taken'] },
  });
}
```

- **A pure function in a file of its own,** so 18b.4 can test every rule of decisions 4, 6 and 14 without a
  database. The service locks the customer, reads it, calls this, and saves what comes back.
- **`take()` is the whole field rule.** No change: the server's value. A head-office field whose server value is
  no longer the change's `from`: the server's value, and the field goes into `kept` (the `kept_server_value` notice).
  Anything else: the device's `to`, even when the server changed that field too — the later arrival wins.
- **`From extends To`.** `from` has the API's shape and `to` the form's. Every value the API sends for a field is
  also a value the form may send (a code `"C-00042"` is a code; `"200000.0000"` is a limit), so the server's own
  value can be returned as the input's value without a cast. If a later field ever breaks that, the type check
  fails on its line.
- **`change.from !== current` compares the strings as the API sends them.** That is why 18b.1 made `from` the API's
  shape: a limit typed `"2,00,000"` on the device and kept as `"200000.0000"` in Postgres would never be equal.
- **The twelve fields are written out,** like in the contract: a loop over the keys would make every value `unknown`.
- **`mergeAddresses()` works on the addresses as the table has them now:** removed ones dropped, changed ones with
  only the sent fields, then the added ones. `change?.label === undefined` and not `??`: a label cleared on the device
  is `null`, and `null ?? old` would quietly put the old label back.
- **An address change for an address the server no longer has is dropped,** with no error (decision 14): someone
  removed it on purpose, and the person who changed its phone number offline has nothing to fix.
- **An added id the customer already has is refused** (`sync_id_taken`, decision 31). Without the check, the add and
  the old address would both be in the list with the same id, and the save would write the address twice.
- **The form's two rules run again on the merged list** (decision 4). Two changes that are each fine — one device
  adds a billing address, the head office adds another — break the rule only together, so only the merge can see
  it. The billing error sits on the address this change touched, by its id (decision 22).

### `sales/customers.service.ts`: the second door

```diff
@@ -6,6 +6,8 @@ import {
   type CustomerPage,
   type CustomerSort,
   type ErrorCode,
+  type SyncCommand,
+  type SyncNotice,
   todayIn,
   type UpdateCustomerInput,
 } from '@omnivo/contracts';
@@ -27,7 +29,7 @@ import {
   salesReturns,
   tenantSettings,
 } from '@omnivo/db';
-import { and, eq, inArray, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
+import { and, asc, eq, inArray, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
@@ -40,10 +42,16 @@ import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { NumberingService } from '../numbering/numbering.service.js';
 import { BalanceAccess } from './balance-access.js';
+import { type CurrentAddress, mergeCustomer } from './customer-merge.js';
 import { customersOf } from './customer-read.js';
 
 type PartyRow = typeof parties.$inferSelect;
 
+type CustomerUpdateCommand = Extract<SyncCommand, { type: 'customer.update' }>;
+
+// Where a new address's id comes from: the database (the form), or the device (step 18b)
+type NewAddressIds = 'server' | 'device';
+
 // What a customer owes: debit − credit of the posted receivable lines that name it. A correlated
 // subquery on the parties row it is selected with, run for the rows of one page only;
 // journal_lines_tenant_party_idx finds the lines. Drafts are left out: they are not in the books.
@@ -231,32 +239,7 @@ export class CustomersService {
   async create(input: CustomerInput): Promise<Customer> {
     const canSeeBalance = await this.access.canSee();
     try {
-      return await this.withTenant(async (tx) => {
-        await this.checkLinks(tx, input, null);
-        const code = input.code ?? (await this.newCode(tx));
-        if (await this.codeUsed(tx, code, null)) throw codeTaken();
-        const [row] = await tx
-          .insert(parties)
-          .values({
-            tenantId: getTenantId(),
-            code,
-            isCustomer: true,
-            ...this.fields(input),
-            createdBy: currentPrincipal().userId,
-            updatedBy: currentPrincipal().userId,
-          })
-          .returning({ id: parties.id });
-        if (!row) throw new Error('Customer insert returned no row');
-        await this.saveAddresses(tx, row.id, input.addresses);
-        const customer = await this.read(tx, row.id, canSeeBalance);
-        await audit(tx, {
-          action: 'customer.created',
-          entityType: 'customer',
-          entityId: row.id,
-          changes: created(await this.snapshot(tx, customer)),
-        });
-        return customer;
-      });
+      return await this.withTenant((tx) => this.insert(tx, input, null, canSeeBalance));
     } catch (error) {
       // Two saves with the same code at the same moment: both passed codeUsed()
       if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
@@ -264,35 +247,26 @@ export class CustomersService {
     }
   }
 
+  // Step 18b: a customer added on a device without a connection, inside the push's transaction
+  // (SyncPushService). The device made the ids of the customer and of every address: an order
+  // written on the same device may already point at them. Its code, when empty, is the next
+  // number now, when the command arrives (decision 16).
+  async createFromDevice(tx: Transaction, id: string, input: CustomerInput): Promise<void> {
+    try {
+      await this.insert(tx, input, id, false);
+    } catch (error) {
+      if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
+      throw error;
+    }
+  }
+
   async update(id: string, input: UpdateCustomerInput): Promise<Customer> {
     const canSeeBalance = await this.access.canSee();
     try {
       return await this.withTenant(async (tx) => {
         const before = await this.lock(tx, id);
         if (before.version !== input.version) throw versionConflict();
-        await this.checkLinks(tx, input, before);
-        const old = await this.read(tx, id, canSeeBalance);
-        // An empty code keeps the one it has, like a product's
-        const code = input.code ?? before.code;
-        if (await this.codeUsed(tx, code, id)) throw codeTaken();
-        await tx
-          .update(parties)
-          .set({
-            code,
-            ...this.fields(input),
-            version: sql`${parties.version} + 1`,
-            updatedBy: currentPrincipal().userId,
-          })
-          .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
-        await this.saveAddresses(tx, id, input.addresses);
-        const customer = await this.read(tx, id, canSeeBalance);
-        await audit(tx, {
-          action: 'customer.updated',
-          entityType: 'customer',
-          entityId: id,
-          changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, customer)),
-        });
-        return customer;
+        return await this.save(tx, before, input, 'server', canSeeBalance);
       });
     } catch (error) {
       if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
@@ -300,6 +274,29 @@ export class CustomersService {
     }
   }
 
+  // Step 18b: a change made on a device, merged into the customer as the server has it now
+  // (decisions 4, 6 and 14). Only the fields the person changed are written. A head-office field
+  // (SERVER_WINS_CUSTOMER_FIELDS) the server changed since the device read it keeps the server's
+  // value, and the answer names it. The addresses are merged one by one, by id. Then the merged
+  // customer is saved like a save from the form: the same checks, the same audit row.
+  async updateFromDevice(
+    tx: Transaction,
+    command: Pick<CustomerUpdateCommand, 'customerId' | 'changes' | 'addresses'>,
+  ): Promise<SyncNotice[]> {
+    const before = await this.lockForDevice(tx, command.customerId);
+    // The customer as the API sends it: the shape the changes' `from` values were read in
+    const [now] = await customersOf(tx, [before]);
+    if (!now) throw new Error('customersOf returned no customer');
+    const merged = mergeCustomer(now, await this.addressesOf(tx, before.id), command);
+    try {
+      await this.save(tx, before, merged.input, 'device', false);
+    } catch (error) {
+      if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
+      throw error;
+    }
+    return merged.kept.length === 0 ? [] : [{ code: 'kept_server_value', fields: merged.kept }];
+  }
+
   // Archived: hidden from new documents. Its entries, its balance and its statement stay; a
   // customer who still owes money can be archived, and the money is still owed.
   async setArchived(id: string, version: number, archived: boolean): Promise<Customer> {
@@ -453,6 +450,75 @@ export class CustomersService {
       );
   }
 
+  // A new customer, with its addresses and its audit row. `id` is the device's id for a customer
+  // added offline (step 18b), or null for the database's own.
+  private async insert(
+    tx: Transaction,
+    input: CustomerInput,
+    id: string | null,
+    canSeeBalance: boolean,
+  ): Promise<Customer> {
+    await this.checkLinks(tx, input, null);
+    const code = input.code ?? (await this.newCode(tx));
+    if (await this.codeUsed(tx, code, null)) throw codeTaken();
+    const [row] = await tx
+      .insert(parties)
+      .values({
+        ...(id === null ? {} : { id }),
+        tenantId: getTenantId(),
+        code,
+        isCustomer: true,
+        ...this.fields(input),
+        createdBy: currentPrincipal().userId,
+        updatedBy: currentPrincipal().userId,
+      })
+      .returning({ id: parties.id });
+    if (!row) throw new Error('Customer insert returned no row');
+    await this.saveAddresses(tx, row.id, input.addresses, id === null ? 'server' : 'device');
+    const customer = await this.read(tx, row.id, canSeeBalance);
+    await audit(tx, {
+      action: 'customer.created',
+      entityType: 'customer',
+      entityId: row.id,
+      changes: created(await this.snapshot(tx, customer)),
+    });
+    return customer;
+  }
+
+  // A locked customer saved with new values, and its audit row: the form's save (after the version
+  // check) and a device's merged change (step 18b) both end here
+  private async save(
+    tx: Transaction,
+    before: PartyRow,
+    input: CustomerInput,
+    newAddressIds: NewAddressIds,
+    canSeeBalance: boolean,
+  ): Promise<Customer> {
+    await this.checkLinks(tx, input, before);
+    const old = await this.read(tx, before.id, canSeeBalance);
+    // An empty code keeps the one it has, like a product's
+    const code = input.code ?? before.code;
+    if (await this.codeUsed(tx, code, before.id)) throw codeTaken();
+    await tx
+      .update(parties)
+      .set({
+        code,
+        ...this.fields(input),
+        version: sql`${parties.version} + 1`,
+        updatedBy: currentPrincipal().userId,
+      })
+      .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, before.id)));
+    await this.saveAddresses(tx, before.id, input.addresses, newAddressIds);
+    const customer = await this.read(tx, before.id, canSeeBalance);
+    await audit(tx, {
+      action: 'customer.updated',
+      entityType: 'customer',
+      entityId: before.id,
+      changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, customer)),
+    });
+    return customer;
+  }
+
   // The columns the form sets, the same on create and update
   private fields(input: CustomerInput) {
     return {
@@ -528,6 +594,9 @@ export class CustomersService {
   // The addresses sent replace the ones the customer had. An address sent back with its id is
   // changed in place, so its id stays (a delivery in step 15b points at it); one whose id is not
   // this customer's — another customer's, or made up — is added as a new address, never moved.
+  // Step 18b: from a device, a new address keeps the id the device made ('device'); an id used
+  // anywhere else then fails on party_addresses_pkey, and the push refuses the command with
+  // sync_id_taken. From the form it gets a new one ('server'), as before.
   // The order matters because of party_addresses_billing_idx, checked on every row: first the
   // removed ones go, then the kept ones that are no longer billing are changed, then the one that
   // is billing now, and last the new ones. At no moment are there two billing addresses.
@@ -535,6 +604,7 @@ export class CustomersService {
     tx: Transaction,
     partyId: string,
     addresses: CustomerInput['addresses'],
+    newAddressIds: NewAddressIds,
   ): Promise<void> {
     const tenantId = getTenantId();
     const ofParty = and(eq(partyAddresses.tenantId, tenantId), eq(partyAddresses.partyId, partyId));
@@ -542,6 +612,7 @@ export class CustomersService {
     const own = new Set(existing.map((row) => row.id));
     const rows = addresses.map((address, position) => ({
       id: address.id !== null && own.has(address.id) ? address.id : null,
+      newId: newAddressIds === 'device' ? address.id : null,
       fields: {
         kind: address.kind,
         position,
@@ -572,7 +643,9 @@ export class CustomersService {
         .set(row.fields)
         .where(and(ofParty, eq(partyAddresses.id, row.id)));
     }
-    const added = rows.flatMap(({ id, fields }) => (id === null ? [fields] : []));
+    const added = rows.flatMap(({ id, newId, fields }) =>
+      id !== null ? [] : [newId === null ? fields : { id: newId, ...fields }],
+    );
     if (added.length > 0) {
       await tx
         .insert(partyAddresses)
@@ -580,6 +653,35 @@ export class CustomersService {
     }
   }
 
+  // A device's change finds the customer gone when it was deleted, or is now only a supplier,
+  // since the device read it: the change has nowhere to go, and the person must know
+  private async lockForDevice(tx: Transaction, id: string): Promise<PartyRow> {
+    try {
+      return await this.lock(tx, id);
+    } catch (error) {
+      if (error instanceof AppError && error.code === 'not_found') {
+        throw new AppError(409, 'sync_customer_gone', 'This customer is no longer on the server.');
+      }
+      throw error;
+    }
+  }
+
+  // The customer's addresses as the table keeps them (the kind typed), in the order the API sends
+  // them: billing first, then the shipping ones by position
+  private addressesOf(tx: Transaction, partyId: string): Promise<CurrentAddress[]> {
+    return tx
+      .select({
+        id: partyAddresses.id,
+        kind: partyAddresses.kind,
+        label: partyAddresses.label,
+        address: partyAddresses.address,
+        phone: partyAddresses.phone,
+      })
+      .from(partyAddresses)
+      .where(and(eq(partyAddresses.tenantId, getTenantId()), eq(partyAddresses.partyId, partyId)))
+      .orderBy(sql`${partyAddresses.kind} = 'billing' DESC`, asc(partyAddresses.position));
+  }
+
   private async lock(tx: Transaction, id: string): Promise<PartyRow> {
     const [row] = await tx
       .select()
```

- **`insert()` and `save()` are the old bodies of `create()` and `update()`,** moved, not rewritten (decision 28).
  The routes' methods keep their transaction, their version check and their `customer_code_taken` mapping; what they
  return is unchanged, and so is the number of queries.
- **`insert()` takes the id:** `null` lets the database make one, as before; a device's id is written as it came.
  The spread `...(id === null ? {} : { id })` leaves the column out instead of writing `undefined`, so Drizzle's
  `$defaultFn` still makes the id for the form.
- **`createFromDevice()` and `updateFromDevice()` take the push's transaction** and return nothing the device needs
  but the notices: the answer's rows are read by the push (decision 18), the same way for a new answer and for one
  sent again.
- **`createFromDevice()` maps `parties_tenant_code_idx` too.** Two devices offline cannot both know the next number,
  but two people can type the same code; the second one to arrive gets `customer_code_taken` on `code`, the same as
  online (decision 16).
- **`saveAddresses()` gets `newAddressIds`.** From the form, an id the customer does not have is a new address with
  a new id, as 15a decided (it is never moved from another customer). From a device, the new id is the device's: an
  order on the same device may already point at it. If that id is taken anywhere, `party_addresses_pkey` fails, and
  the push turns it into `sync_id_taken`.
- **`lockForDevice()` turns `not_found` into `sync_customer_gone`.** `lock()` finds only a customer, so a party that
  is now only a supplier is gone too. "Not found" would tell the person to look for something; "gone" tells them the
  change has nowhere to go and can be discarded.
- **`addressesOf()` reads the table's rows,** not the API's customer: the table types `kind` as `'billing' |
  'shipping'`, the API's customer as a string (a newer kind must not break an older app). The order is the API's.
- **`customersOf(tx, [before])`** gives the customer exactly as the pull and the customer page send it, without the
  balance, from the locked row: the shape the device's `from` values came in.

### `sales/sales-orders.service.ts`: a draft from a device

```diff
@@ -4,6 +4,7 @@ import {
   type OrderStatus,
   type PartyRef,
   type SalesOrder,
+  type SalesOrderDraftInput,
   type SalesOrderInput,
   type SalesOrderSummary,
   type UpdateSalesOrderInput,
@@ -147,55 +148,26 @@ export class SalesOrdersService {
 
   create(input: SalesOrderInput): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
-      const customer = await assertCustomer(tx, input.customerId);
-      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
-      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
-      const quotation =
-        input.quotationId === null
-          ? null
-          : await this.openQuotation(tx, input.quotationId, customer);
-      // An order made from a quotation reads its prices the way the quotation did: the form copied
-      // them from there. Otherwise the workspace setting now.
-      const pricesIncludeVat = quotation?.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
-      const lines = await resolveSalesLines(tx, input.lines, pricesIncludeVat);
-      const [row] = await tx
-        .insert(salesOrders)
-        .values({
-          tenantId: getTenantId(),
-          date: input.date,
-          deliveryDate: input.deliveryDate,
-          customerId: customer.id,
-          customerReference: input.customerReference,
-          warehouseId: input.warehouseId,
-          shippingAddressId: address?.id ?? null,
-          shippingAddress: address?.text ?? null,
-          quotationId: quotation?.id ?? null,
-          pricesIncludeVat,
-          note: input.note,
-          ...documentTotals(lines.map((line) => line.amounts)),
-          createdBy: currentPrincipal().userId,
-          updatedBy: currentPrincipal().userId,
-        })
-        .returning();
-      if (!row) throw new Error('Sales order insert returned no row');
-      await this.writeLines(tx, row.id, lines);
-      // The customer said yes: the quotation is accepted by the order made from it. No audit row
-      // of its own: this one names it.
-      if (quotation !== null) await this.setQuotationStatus(tx, quotation.id, 'accepted');
-      await audit(tx, {
-        action: 'sales_order.created',
-        entityType: 'sales_order',
-        entityId: row.id,
-        changes: created({
-          ...(await this.snapshot(tx, row, customer, lines.length)),
-          quotation: quotation?.number ?? null,
-        }),
-      });
+      const row = await this.insert(tx, input, null);
       if (input.confirm) await this.confirmAndLog(tx, row, input.overrideCreditLimit);
       return this.read(tx, row.id);
     });
   }
 
+  // Step 18b: an order written on a device without a connection, inside the push's transaction
+  // (SyncPushService). A draft only, with the device's id, and the same checks as a draft saved
+  // online: an active customer and warehouse, one of the customer's addresses, the lines' units
+  // and VAT rates. The prices stay as the device worked them out; the totals are worked out here
+  // again from the lines (decision 15). An id used by anything else fails on sales_orders_pkey,
+  // and the push refuses the command with sync_id_taken.
+  async createDraftFromDevice(
+    tx: Transaction,
+    id: string,
+    input: SalesOrderDraftInput,
+  ): Promise<void> {
+    await this.insert(tx, { ...input, quotationId: null }, id);
+  }
+
   update(id: string, input: UpdateSalesOrderInput): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
       const before = await this.lockDraft(tx, id, input.version);
@@ -369,6 +341,59 @@ export class SalesOrdersService {
     });
   }
 
+  // A new draft, its lines and its audit row: the form's order (confirmed after, when asked) and
+  // a device's draft (step 18b). `id` is the device's id, or null for the database's own.
+  private async insert(
+    tx: Transaction,
+    input: SalesOrderDraftInput & { quotationId: string | null },
+    id: string | null,
+  ): Promise<OrderRow> {
+    const customer = await assertCustomer(tx, input.customerId);
+    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
+    const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
+    const quotation =
+      input.quotationId === null ? null : await this.openQuotation(tx, input.quotationId, customer);
+    // An order made from a quotation reads its prices the way the quotation did: the form copied
+    // them from there. Otherwise the workspace setting now.
+    const pricesIncludeVat = quotation?.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
+    const lines = await resolveSalesLines(tx, input.lines, pricesIncludeVat);
+    const [row] = await tx
+      .insert(salesOrders)
+      .values({
+        ...(id === null ? {} : { id }),
+        tenantId: getTenantId(),
+        date: input.date,
+        deliveryDate: input.deliveryDate,
+        customerId: customer.id,
+        customerReference: input.customerReference,
+        warehouseId: input.warehouseId,
+        shippingAddressId: address?.id ?? null,
+        shippingAddress: address?.text ?? null,
+        quotationId: quotation?.id ?? null,
+        pricesIncludeVat,
+        note: input.note,
+        ...documentTotals(lines.map((line) => line.amounts)),
+        createdBy: currentPrincipal().userId,
+        updatedBy: currentPrincipal().userId,
+      })
+      .returning();
+    if (!row) throw new Error('Sales order insert returned no row');
+    await this.writeLines(tx, row.id, lines);
+    // The customer said yes: the quotation is accepted by the order made from it. No audit row
+    // of its own: this one names it.
+    if (quotation !== null) await this.setQuotationStatus(tx, quotation.id, 'accepted');
+    await audit(tx, {
+      action: 'sales_order.created',
+      entityType: 'sales_order',
+      entityId: row.id,
+      changes: created({
+        ...(await this.snapshot(tx, row, customer, lines.length)),
+        quotation: quotation?.number ?? null,
+      }),
+    });
+    return row;
+  }
+
   // The number the first time; a reopened order confirms again with the number it already has.
   // Step 15c: confirming checks the credit limit (you chose this). The exposure is read before and
   // after the order counts in it; CreditService.check refuses when the order takes the customer
```

- **`insert()` is the old body of `create()` without the confirmation,** moved below the public methods. The form's
  `create()` still confirms in the same transaction when asked, so nothing changes online.
- **`createDraftFromDevice()` passes `quotationId: null`:** a draft from a device never comes from a quotation
  (decision 15), and the type of `insert()` makes the caller say so, instead of `insert()` guessing.
- **Every check of an online draft runs:** the customer must be active (a customer added offline and archived online
  before the order arrived refuses it with `sales_customer_invalid`), the warehouse active (`stock_warehouse_invalid`),
  the address the customer's, the lines' units and VAT rates real. The lines' prices are kept; `documentTotals()`
  works out the totals again, so a device with a rounding bug cannot store a wrong total.
- **The warehouse is not checked against the device's branch** (decision 15).

### `sales/price-lookup.service.ts`: the shared rule

```diff
@@ -1,5 +1,10 @@
 import { Inject, Injectable } from '@nestjs/common';
-import type { PriceLookup, PriceLookupInput, PriceLookupItem } from '@omnivo/contracts';
+import {
+  type PriceLookup,
+  type PriceLookupInput,
+  type PriceLookupItem,
+  startingPrice,
+} from '@omnivo/contracts';
 import { parties, priceLists } from '@omnivo/db';
 import { and, eq, isNull, sql } from 'drizzle-orm';
 import { z } from 'zod';
@@ -13,7 +18,8 @@ const rowSchema = z.object({
   variant_id: z.uuid(),
   unit_id: z.uuid(),
   list_price: z.string().nullable(),
-  product_price: z.string().nullable(),
+  sale_price: z.string().nullable(),
+  factor: z.string(),
   tax_rate_id: z.uuid().nullable(),
 });
 
@@ -21,7 +27,8 @@ const rowSchema = z.object({
 // the line: this is only where they start.
 //   price     the customer's price list, if it is active and has this variant in this unit (15a);
 //             else the variant's own sale price (per base unit) × the unit's factor;
-//             else none (null): the person types it
+//             else none (null): the person types it. Since step 18b this rule is startingPrice()
+//             in the contracts, which the order form on a device without a connection uses too.
 //   VAT rate  the product's own rate if it is active, else the workspace default
 @Injectable()
 export class PriceLookupService {
@@ -56,9 +63,9 @@ export class PriceLookupService {
       const priceListId = customer?.priceListId ?? null;
 
       // One query for every item, in the order they were asked for (ord). A unit that is neither
-      // the base unit nor a pack of the product drops out, like an unknown variant. The product's
-      // price is worked out in Postgres: a factor has 6 decimals (a yard is 0.914400 m), and NUMERIC
-      // multiplies it exactly before rounding to the 4 decimals a price keeps.
+      // the base unit nor a pack of the product drops out, like an unknown variant. The query
+      // reads the three values the price comes from, as the device's copy has them; the price
+      // itself is startingPrice()'s, below (step 18b).
       const wanted = sql.join(
         input.items.map(
           (item, index) => sql`(${index}::int, ${item.variantId}::uuid, ${item.unitId}::uuid)`,
@@ -69,9 +76,9 @@ export class PriceLookupService {
         await tx.execute(sql`
           WITH wanted(ord, variant_id, unit_id) AS (VALUES ${wanted})
           SELECT w.variant_id::text AS variant_id, w.unit_id::text AS unit_id,
-                 round(pli.price, 4)::text AS list_price,
-                 round(v.sale_price * CASE WHEN w.unit_id = p.base_unit_id THEN 1 ELSE pu.factor END,
-                       4)::text AS product_price,
+                 pli.price::text AS list_price,
+                 v.sale_price::text AS sale_price,
+                 CASE WHEN w.unit_id = p.base_unit_id THEN '1' ELSE pu.factor::text END AS factor,
                  coalesce(own.id, d.id)::text AS tax_rate_id
             FROM wanted w
             JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = w.variant_id
@@ -91,13 +98,15 @@ export class PriceLookupService {
       const items = rows.flatMap((row): PriceLookupItem[] => {
         // No rate at all: a workspace whose setup job has not made its rates yet
         if (row.tax_rate_id === null) return [];
-        const price = row.list_price ?? row.product_price;
         return [
           {
             variantId: row.variant_id,
             unitId: row.unit_id,
-            price,
-            source: row.list_price !== null ? 'price_list' : price === null ? null : 'product',
+            ...startingPrice({
+              listPrice: row.list_price,
+              salePrice: row.sale_price,
+              factor: row.factor,
+            }),
             taxRateId: row.tax_rate_id,
           },
         ];
```

- **The query reads the three values, not the price:** the list's price, the variant's sale price, and the unit's
  factor (`'1'` for the base unit). These are the values the device keeps in its copy, so the API and the offline
  form give `startingPrice()` the same input (decision 19).
- **The answer does not change.** `sumMoney()` writes the list's price with 4 decimals like `round(pli.price, 4)` did,
  and `priceInUnit()` rounds the sale price × factor once, half away from zero, like Postgres's `round()`. The 15b
  tests of the lookup (`price-lists.int.spec.ts`, `sales-documents.int.spec.ts`) pass as they are.

### `sync/sync-push.service.ts`: the push

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  contractErrorMap,
  type ErrorCode,
  isErrorCode,
  type PermissionKey,
  routes,
  SYNC_COMMAND_TYPES,
  SYNC_PROTOCOL,
  type SyncChange,
  type SyncCommand,
  type SyncCommandError,
  type SyncCommandType,
  type SyncNotice,
  type SyncPush,
  type syncPushInputSchema,
  type SyncResult,
  syncCommandSchema,
} from '@omnivo/contracts';
import { syncCommands } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError } from '../common/http/app-error.js';
import { getTenantId, runFromDevice } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type Access, PermissionService } from '../rbac/permission.service.js';
import { CustomersService } from '../sales/customers.service.js';
import { SalesOrdersService } from '../sales/sales-orders.service.js';
import { type DeviceRow, DevicesService } from './devices.service.js';
import { LOADERS } from './sync-rows.js';

type PushedCommand = z.output<typeof syncPushInputSchema>['commands'][number];
type StoredAnswer = typeof syncCommands.$inferSelect;

// The permission each command needs: its API route's own (decision 17), read from the contract,
// so a route that changes its permission changes the command's too
const PERMISSION_OF = {
  'customer.create': routes.customers.create.permission,
  'customer.update': routes.customers.update.permission,
  'sales_order.create_draft': routes.salesOrders.create.permission,
} satisfies Record<SyncCommandType, PermissionKey>;

// The ids a device makes (decision 12). One already used — in this workspace or another, the
// primary keys are global — fails the insert on its primary key, and the command is refused.
const DEVICE_ID_KEYS = ['parties_pkey', 'party_addresses_pkey', 'sales_orders_pkey'] as const;

function isSyncCommandType(type: string): type is SyncCommandType {
  return SYNC_COMMAND_TYPES.some((known) => known === type);
}

// The customer or the order a command is about: the answer's entity_id
function entityOf(command: SyncCommand): string {
  return command.type === 'sales_order.create_draft' ? command.orderId : command.customerId;
}

// Step 18b: the push. Every command of a batch in the order sent, each in its own transaction:
//   1. a lock on the command's id, so a second push of the same command waits for this one;
//   2. the answer kept from before, if there is one: the command is answered from it, not run;
//   3. the command's work behind a savepoint, with the person's roles of now;
//   4. the answer inserted, accepted or refused, and the transaction committed.
// A refusal rolls back to the savepoint, so its half-done work goes and its answer stays. Any
// other error (a bug, the database gone) fails the whole push with a 500: the commands before it
// are committed with their answers, and the device sends the batch again (decision 23).
@Injectable()
export class SyncPushService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly devices: DevicesService,
    private readonly permissions: PermissionService,
    private readonly customers: CustomersService,
    private readonly orders: SalesOrdersService,
  ) {}

  async push(input: z.output<typeof syncPushInputSchema>): Promise<SyncPush> {
    // As in the pull: an app built for another protocol reloads first (decision 21)
    if (input.protocol !== SYNC_PROTOCOL) {
      throw new AppError(409, 'sync_protocol_mismatch', 'Reload the app to sync again.');
    }
    const device = await this.withTenant((tx) => this.devices.forSync(tx, input.deviceId));
    // The person's roles of now (decision 17), read once for the batch: one request is one moment
    const access = await this.permissions.ofCurrentUser();
    const results: SyncResult[] = [];
    for (const pushed of input.commands) {
      // One after the other, never in parallel: an order may need the customer before it
      results.push(await runFromDevice(device.id, () => this.run(device, access, pushed)));
    }
    return { results, serverTime: new Date().toISOString() };
  }

  private async run(device: DeviceRow, access: Access, pushed: PushedCommand): Promise<SyncResult> {
    // A command the server cannot read is refused alone, and keeps no answer (decision 24): the
    // same bytes always get the same refusal
    if (!isSyncCommandType(pushed.type)) {
      return refused(pushed.id, { code: 'sync_command_invalid' });
    }
    const parsed = syncCommandSchema.safeParse(pushed, { error: contractErrorMap });
    if (!parsed.success) {
      return refused(pushed.id, {
        code: 'invalid_input',
        fieldErrors: fieldErrorsOf(pushed, parsed.error.issues),
      });
    }
    const command = parsed.data;

    return this.withTenant(async (tx) => {
      // Released by the commit or the rollback; a different command never waits for this one
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.id}::text, 0))`);
      const [stored] = await tx
        .select()
        .from(syncCommands)
        .where(and(eq(syncCommands.tenantId, getTenantId()), eq(syncCommands.id, command.id)));
      // Sent before: answered from what was kept. Even from another device of the workspace (its
      // ids are its own, so only a bug sends one): the answer is still the true one.
      if (stored) return this.answerFrom(tx, device, stored);

      let notices: SyncNotice[];
      try {
        // A nested transaction is a savepoint: a refusal undoes this command's work only
        notices = await tx.transaction((work) => this.apply(work, access, command));
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === null) throw error;
        await tx.insert(syncCommands).values({
          ...this.answerKey(device, command),
          status: 'rejected',
          error: refusal,
        });
        return refused(command.id, refusal);
      }
      await tx.insert(syncCommands).values({
        ...this.answerKey(device, command),
        status: 'accepted',
        notices,
      });
      return {
        id: command.id,
        status: 'accepted',
        notices,
        changes: await this.changesOf(tx, device, command.type, entityOf(command)),
      };
    });
  }

  // The command's work, with the same service methods as the API's routes
  private async apply(
    tx: Transaction,
    access: Access,
    command: SyncCommand,
  ): Promise<SyncNotice[]> {
    const permission = PERMISSION_OF[command.type];
    if (!access.permissions.includes(permission)) {
      throw new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
        params: { permissions: permission },
      });
    }
    switch (command.type) {
      case 'customer.create':
        await this.customers.createFromDevice(tx, command.customerId, command.input);
        return [];
      case 'customer.update':
        return this.customers.updateFromDevice(tx, command);
      case 'sales_order.create_draft':
        await this.orders.createDraftFromDevice(tx, command.orderId, command.input);
        return [];
    }
  }

  private answerKey(device: DeviceRow, command: SyncCommand) {
    return {
      id: command.id,
      tenantId: getTenantId(),
      deviceId: device.id,
      type: command.type,
      entityId: entityOf(command),
    };
  }

  private async answerFrom(
    tx: Transaction,
    device: DeviceRow,
    stored: StoredAnswer,
  ): Promise<SyncResult> {
    if (stored.status === 'rejected') {
      // sync_commands_error_check: a refused answer always has its error
      if (stored.error === null) throw new Error(`Refused answer ${stored.id} has no error`);
      return refused(stored.id, stored.error);
    }
    return {
      id: stored.id,
      status: 'accepted',
      notices: stored.notices,
      // The rows as they are now, not as they were then (decision 18)
      changes: await this.changesOf(tx, device, stored.type, stored.entityId),
    };
  }

  // The customer a command made or changed, in the pull's shape: the device writes it at once. A
  // customer the device may not keep (archived since) goes as a delete, like in a delta pull. An
  // order sends nothing: orders are not on the device.
  private async changesOf(
    tx: Transaction,
    device: DeviceRow,
    type: SyncCommandType,
    entityId: string,
  ): Promise<SyncChange[]> {
    if (type === 'sales_order.create_draft') return [];
    // The customer loader reads only the tenant; the branch's warehouses do not matter to it
    const scope = { tenantId: getTenantId(), branchId: device.branchId, warehouseIds: [] };
    const rows = await LOADERS.customer(tx, scope, { by: 'keys', keys: [entityId] });
    if (rows.length === 0) return [{ op: 'delete', entity: 'customer', key: entityId }];
    return rows.map((row) => row.change);
  }
}

function refused(id: string, error: SyncCommandError): SyncResult {
  return { id, status: 'rejected', error };
}

// A refusal the person can act on: a rule of the API (AppError, with its code and field errors),
// or an id the device made that is already used. null: anything else, which fails the push.
function refusalOf(error: unknown): SyncCommandError | null {
  if (error instanceof AppError) return { code: error.code, ...error.options };
  if (DEVICE_ID_KEYS.some((key) => isUniqueViolation(error, key))) {
    return { code: 'sync_id_taken' };
  }
  return null;
}

// A command's field errors, with the paths of the form it came from (decision 22): inside `input`
// for a new customer or an order, the field's name for a change ("creditLimit", not
// "changes.creditLimit.to"), and an address of a change by its id, not its place in the command
function fieldErrorsOf(pushed: PushedCommand, issues: z.core.$ZodIssue[]) {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) {
    const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
    (fieldErrors[formPath(pushed, issue.path)] ??= []).push(code);
  }
  return fieldErrors;
}

function formPath(pushed: PushedCommand, path: PropertyKey[]): string {
  const [head, field, index, ...rest] = path;
  if (head === 'input' && field !== undefined) return path.slice(1).map(String).join('.');
  if (head === 'changes' && field !== undefined) return String(field);
  if (
    head === 'addresses' &&
    (field === 'add' || field === 'change') &&
    typeof index === 'number'
  ) {
    const id = addressIdAt(pushed, field, index);
    if (id !== null) return ['addresses', id, ...rest].map(String).join('.');
  }
  return path.map(String).join('.') || 'command';
}

// The id of the address at this place of the command, when it is a real id: only then may it
// stand in a path
const pushedAddressesSchema = z.object({
  addresses: z.object({ add: z.array(z.unknown()), change: z.array(z.unknown()) }),
});
const addressIdSchema = z.object({ id: z.uuid() });

function addressIdAt(pushed: PushedCommand, list: 'add' | 'change', index: number): string | null {
  const lists = pushedAddressesSchema.safeParse(pushed);
  if (!lists.success) return null;
  const address = addressIdSchema.safeParse(lists.data.addresses[list][index]);
  return address.success ? address.data.id : null;
}
```

- **`PERMISSION_OF` reads each permission from the contract's routes** (decision 17). `satisfies Record<…,
  PermissionKey>` fails the type check if a route ever loses its permission, so a command can never run with none.
- **`DEVICE_ID_KEYS` are the three primary keys a device's id can collide with.** The keys are global (not per tenant),
  so an id used in another workspace fails too, and the answer is the same `sync_id_taken`: nobody learns which.
- **`push()` checks the protocol first and the device second,** like the pull, then reads the person's roles once
  (decision 30). The device check runs in a transaction of its own; each command gets its own after it.
- **Commands run one after the other** (`for … await`), never with `Promise.all`: an order for a customer made on the
  device must find that customer, and the device sent them in that order.
- **`run()` reads the command before it opens a transaction.** An unknown type is `sync_command_invalid`; a command the
  schema refuses is `invalid_input` with its field errors. Neither keeps an answer (decision 24), and neither costs a
  database round trip.
- **The lock comes before the look-up.** Two pushes of the same command (a retry while the first is still running)
  would both find no answer without it, and both run the command. Built once without the lock on purpose: the second
  push failed with a 500 (the customer's id was taken by the first, and then the answer's own key), where with the lock
  it waits and is answered from the first one's row. `hashtextextended()` turns the id into the lock's 64-bit number;
  two different ids with the same number only wait for each other a moment.
- **`tx.transaction()` inside `withTenant()` is a savepoint.** The tenant setting was made before it, so it survives a
  rollback to the savepoint, and the refusal's answer is inserted in the same transaction, after the command's work is
  undone.
- **`refusalOf()` decides what is a refusal** (decision 29): an `AppError` keeps its code, params and field errors as
  the device should see them; a device's id taken is `sync_id_taken`; anything else is thrown again and fails the push.
- **`answerFrom()` answers a command sent before** from its row, and reads the customer again for an accepted one
  (decision 18). A refused row without an error cannot exist (`sync_commands_error_check`), and the code says so
  instead of sending a broken answer.
- **`changesOf()` uses the pull's customer loader,** so the row the device writes at once is exactly the row a pull
  would send. A customer the device may not keep (archived meanwhile) goes as a delete, like in a delta pull. The
  loader reads only the tenant, so the scope's warehouses are left empty.
- **`formPath()` makes the paths of decision 22** from Zod's: `input.name` → `name`, `changes.creditLimit.to` →
  `creditLimit`, `addresses.change.1.label` → `addresses.<id>.label`. An address's id goes into a path only when it is
  a real UUID; otherwise the path stays as Zod gave it.
- **`serverTime` is the API's clock,** not the database's: the push's answer only shows it, and nothing compares it
  with a cursor.

### `sync/devices.service.ts`, `sync/sync.service.ts`, `sync/sync.controller.ts`, `sync/sync.module.ts`, `sales/sales.module.ts`

```diff
@@ -74,8 +74,9 @@ export class DevicesService {
     });
   }
 
-  // The pull's check, inside its transaction: the device is this person's, and not revoked
-  async forPull(tx: Transaction, id: string): Promise<DeviceRow> {
+  // The pull's and the push's check, inside a transaction: the device is this person's, and not
+  // revoked
+  async forSync(tx: Transaction, id: string): Promise<DeviceRow> {
     const [row] = await tx
       .select()
       .from(devices)
```

- **`forPull()` becomes `forSync()`:** the push checks the device the same way. The pull's call changes with it:

```diff
@@ -63,7 +63,7 @@ export class SyncService {
     // last page's last_sync_at, so it has no transaction id of its own while it reads: it never
     // holds back its own watermark, or anyone else's.
     return this.withTenant(async (tx) => {
-      const device = await this.devices.forPull(tx, query.deviceId);
+      const device = await this.devices.forSync(tx, query.deviceId);
       const clock = await readClock(tx);
       const scope = await this.scopeOf(tx, device.branchId);
 
```

```diff
@@ -4,16 +4,18 @@ import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
 import { Endpoint } from '../common/http/endpoint.js';
 import { DevicesService } from './devices.service.js';
 import { SyncService } from './sync.service.js';
+import { SyncPushService } from './sync-push.service.js';
 
 type Routes = typeof routes.sync;
 
-// No permission on either route (decision 21): every member may work offline, and a pull sends
-// only what every member may read anyway
+// No permission on any route (decision 21): every member may work offline, and a pull sends only
+// what every member may read anyway. A push checks each command's own permission (18b).
 @Controller()
 export class SyncController {
   constructor(
     private readonly devices: DevicesService,
     private readonly sync: SyncService,
+    private readonly pushes: SyncPushService,
   ) {}
 
   @Endpoint(routes.sync.registerDevice)
@@ -27,4 +29,9 @@ export class SyncController {
   pull({ query }: RouteInput<Routes['pull']>): Promise<RouteResponse<Routes['pull']>> {
     return this.sync.pull(query);
   }
+
+  @Endpoint(routes.sync.push)
+  push({ body }: RouteInput<Routes['push']>): Promise<RouteResponse<Routes['push']>> {
+    return this.pushes.push(body);
+  }
 }
```

- **The route has no permission of its own** (the contract's), so the controller only hands the body over.

```diff
@@ -1,13 +1,19 @@
 import { Module } from '@nestjs/common';
 
+import { RbacModule } from '../rbac/rbac.module.js';
+import { SalesModule } from '../sales/sales.module.js';
 import { DevicesService } from './devices.service.js';
 import { SyncController } from './sync.controller.js';
 import { SyncService } from './sync.service.js';
+import { SyncPushService } from './sync-push.service.js';
 
 // Step 18a: the read half of the sync engine (devices and the pull). SyncLogCleanup is not here:
-// it is the worker's (WorkerModule), on the worker's database role.
+// it is the worker's (WorkerModule), on the worker's database role. Step 18b: the push, which
+// runs a device's commands with the sales services (SalesModule) and checks each command's
+// permission (RbacModule).
 @Module({
+  imports: [RbacModule, SalesModule],
   controllers: [SyncController],
-  providers: [DevicesService, SyncService],
+  providers: [DevicesService, SyncService, SyncPushService],
 })
 export class SyncModule {}
```

```diff
@@ -80,7 +80,15 @@ import { SalesReturnsService } from './sales-returns.service.js';
     SalesAccountsService,
   ],
   // Step 16: the PDF of a quotation, an invoice, a receipt or a credit note is built from what
-  // their get() returns (documents/models.service.ts)
-  exports: [QuotationsService, InvoicesService, ReceiptsService, CreditNotesService],
+  // their get() returns (documents/models.service.ts). Step 18b: the sync's push runs a device's
+  // customers and order drafts through CustomersService and SalesOrdersService.
+  exports: [
+    QuotationsService,
+    InvoicesService,
+    ReceiptsService,
+    CreditNotesService,
+    CustomersService,
+    SalesOrdersService,
+  ],
 })
 export class SalesModule {}
```

- **`SalesModule` exports the two services, and `SyncModule` imports it.** Nest builds one `CustomersService` for
  both, so the push and the routes share the same code and the same numbering. `SalesModule` does not import
  `SyncModule`, so there is no cycle.

> **What we checked.** The API's integration and tenant-leak suites (`apps/api`, 54 files, 607 tests) pass again,
> the 47 that 18b.1's audit `device` broke among them, and so do the 15b price lookup tests on the shared rule. A
> first run of the push against a real database (the start of 18b.4's tests, 5 tests) covered: a customer added on a
> device with an empty code got its C- number and kept the device's address id; an order draft for it, in the same
> push, pointed at that address, had no number, and its audit entry named the device; the same two commands sent
> again were answered "accepted" and made nothing twice; a credit limit changed on the server since the device read
> it was kept (with the `kept_server_value` notice) while the phone changed in the same command was taken; one push
> with a second billing address, an unknown type, a name too short and a customer id already used got four refusals,
> each alone, with `name` as the field path; a refusal sent again was answered from its row; a member without
> `sales.customer.manage` got `permission_missing`; and the same command pushed twice at the same moment made one
> customer. Built once without the advisory lock, that last test failed with a 500.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api lint
pnpm --filter @omnivo/api test
```

All three pass. The API's integration and tenant-leak suites pass again too (see "What we checked"). The whole
`pnpm typecheck` still fails until 18b.5, on the three new error codes `en.ts` does not have yet.

## 18b.4 — `apps/api`: the tests

This part adds one integration test file and one unit test file, and grows the sync tenant-leak test:

- `sales/customer-merge.spec.ts` tests the pure merge of 18b.3 without a database: every field rule and every
  address rule of decisions 4, 6, 14 and 31.
- `sync/sync-push.int.spec.ts` follows a distributor in Narsingdi whose sales officer writes customers and orders
  on a laptop and a tablet, and pushes them later: the request's checks, a new customer, an order draft, a customer
  changed on a device (the merge against a real database), a command sent again, the roles of now, and the
  worker's cleanup of the answers. It starts from the five smoke tests of 18b.3.
- `sync/sync.tenant-leak.int.spec.ts` gets a push part: a device of workspace A never changes or reaches B's
  customers and never gets B's answers; and in the database, the API's role never reads or writes B's answers, and
  never changes or deletes one of its own.

**They found no bug in the 18b.3 code.** Three "break it on purpose" checks made sure the tests would have noticed
the bugs that matter most here:

- Running the command's work straight in the push's transaction, not behind a savepoint, fails three tests with a
  500. After a Postgres error (an id that is taken), the transaction can do nothing more, so the refusal's answer
  cannot be inserted and the push fails, instead of refusing that one command.
- Answering a command sent again with no rows (not reading the customer again) fails the "sent again" test: a device
  whose first answer was lost would never hear of the head office's rename.
- Taking the device's value of a head-office field always (no `from` check) fails three tests: two unit tests and
  the integration test of the credit limit kept by the server.

### `sales/customer-merge.spec.ts` (new)

```ts
import type { CustomerAddressChanges, CustomerChanges } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { AppError } from '../common/http/app-error.js';
import type { CustomerWithoutBalance } from './customer-read.js';
import { type CurrentAddress, mergeAddresses, mergeCustomer } from './customer-merge.js';

const dealerList = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c30';
const retailList = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c31';
const pharmacyGroup = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c32';
const billing = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c40';
const depot = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c41';
const godown = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c42';
const added = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c43';

// Karim Store as the server has it now: the API's shape, the `from` values come in this shape
const now: CustomerWithoutBalance = {
  id: '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c3d',
  code: 'C-00007',
  name: 'Karim Store',
  groupId: null,
  contactPerson: 'Abdul Karim',
  phone: '01711-000000',
  email: null,
  documentLanguage: 'bn',
  bin: null,
  paymentTermsDays: 30,
  creditLimit: '50000.0000',
  priceListId: dealerList,
  notes: null,
  addresses: [],
  isSupplier: false,
  archivedAt: null,
  version: 4,
  updatedAt: '2026-10-21T04:00:00.000Z',
};

// And its addresses as the table keeps them: the billing one first, then two shipping ones
const addresses: CurrentAddress[] = [
  { id: billing, kind: 'billing', label: null, address: 'Bazar Road, Narsingdi', phone: null },
  { id: depot, kind: 'shipping', label: 'Depot', address: 'Station Road, Bhairab', phone: null },
  { id: godown, kind: 'shipping', label: 'Godown', address: 'Ghat Road, Narsingdi', phone: '017' },
];

const noAddressChanges: CustomerAddressChanges = { add: [], remove: [], change: [] };

function merge(changes: CustomerChanges, addressChanges = noAddressChanges) {
  return mergeCustomer(now, addresses, { changes, addresses: addressChanges });
}

// The refusal a merge throws, as the push would put it in the answer
function refusalOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, ...error.options };
    throw error;
  }
  throw new Error('the merge did not refuse');
}

describe('mergeCustomer: the fields', () => {
  it('keeps the server customer as it is when nothing changed', () => {
    const { input, kept } = merge({});
    expect(kept).toEqual([]);
    expect(input).toEqual({
      code: 'C-00007',
      name: 'Karim Store',
      groupId: null,
      contactPerson: 'Abdul Karim',
      phone: '01711-000000',
      email: null,
      documentLanguage: 'bn',
      bin: null,
      paymentTermsDays: 30,
      creditLimit: '50000.0000',
      priceListId: dealerList,
      notes: null,
      addresses,
    });
  });

  it('takes the device value of an ordinary field, even one the server changed since', () => {
    // The device read "01700-000000"; the server has another number now. The later arrival wins.
    const { input, kept } = merge({
      phone: { from: '01700-000000', to: '01811-111111' },
      name: { from: 'Karim Store', to: 'Karim General Store' },
      notes: { from: null, to: 'Pays on Thursdays' },
    });
    expect(kept).toEqual([]);
    expect(input).toMatchObject({
      phone: '01811-111111',
      name: 'Karim General Store',
      notes: 'Pays on Thursdays',
      contactPerson: 'Abdul Karim',
    });
  });

  it('takes a head-office field the server did not change since the device read it', () => {
    const { input, kept } = merge({
      creditLimit: { from: '50000.0000', to: '75000' },
      paymentTermsDays: { from: 30, to: 45 },
    });
    expect(kept).toEqual([]);
    expect(input).toMatchObject({ creditLimit: '75000', paymentTermsDays: 45 });
  });

  it('keeps each head-office field the server changed, and takes the rest of the command', () => {
    const { input, kept } = merge({
      creditLimit: { from: '40000.0000', to: '90000' },
      paymentTermsDays: { from: 15, to: 60 },
      priceListId: { from: retailList, to: null },
      groupId: { from: pharmacyGroup, to: pharmacyGroup },
      phone: { from: '01711-000000', to: '01811-111111' },
    });
    // In the order of the fields, the order the notice lists them in
    expect(kept).toEqual(['groupId', 'paymentTermsDays', 'creditLimit', 'priceListId']);
    expect(input).toMatchObject({
      creditLimit: '50000.0000',
      paymentTermsDays: 30,
      priceListId: dealerList,
      groupId: null,
      phone: '01811-111111',
    });
  });

  it('does not keep a head-office field the server changed and then changed back', () => {
    // Only the value counts, not its history: 50,000 → 80,000 → 50,000 is still what the device read
    const { input, kept } = merge({ creditLimit: { from: '50000.0000', to: null } });
    expect(kept).toEqual([]);
    expect(input.creditLimit).toBeNull();
  });

  it('compares a limit as the API sends it, so a limit typed another way is changed on the server', () => {
    // "50000" is what the form sends, not what the API sends: the server reads it as changed
    const { kept } = merge({ creditLimit: { from: '50000', to: '60000' } });
    expect(kept).toEqual(['creditLimit']);
  });

  it('clears a field the device cleared', () => {
    const { input } = merge({
      contactPerson: { from: 'Abdul Karim', to: null },
      priceListId: { from: dealerList, to: null },
    });
    expect(input).toMatchObject({ contactPerson: null, priceListId: null });
  });
});

describe('mergeAddresses', () => {
  it('adds an address at the end, with the id the device made', () => {
    const merged = mergeAddresses(addresses, {
      ...noAddressChanges,
      add: [
        { id: added, kind: 'shipping', label: null, address: 'College Road, Bhairab', phone: null },
      ],
    });
    expect(merged.map((address) => address.id)).toEqual([billing, depot, godown, added]);
  });

  it('removes an address, and ignores one the server removed already', () => {
    const merged = mergeAddresses(addresses, { ...noAddressChanges, remove: [depot, added] });
    expect(merged.map((address) => address.id)).toEqual([billing, godown]);
  });

  it('changes only the fields sent, and clears a field sent as null', () => {
    const merged = mergeAddresses(addresses, {
      ...noAddressChanges,
      change: [
        { id: depot, phone: '01911-222222' },
        { id: godown, label: null },
      ],
    });
    expect(merged[1]).toEqual({
      id: depot,
      kind: 'shipping',
      label: 'Depot',
      address: 'Station Road, Bhairab',
      phone: '01911-222222',
    });
    // Not the old "Godown": `?? old` would have put it back
    expect(merged[2]).toMatchObject({ id: godown, label: null, phone: '017' });
  });

  it('drops a change of an address the server removed, without an error', () => {
    const removedOnServer = addresses.filter((address) => address.id !== depot);
    const merged = mergeAddresses(removedOnServer, {
      ...noAddressChanges,
      change: [{ id: depot, address: 'New Station Road, Bhairab' }],
    });
    expect(merged.map((address) => address.id)).toEqual([billing, godown]);
  });

  it('lets the device move the billing address: the old one removed, a new one added', () => {
    const merged = mergeAddresses(addresses, {
      add: [
        { id: added, kind: 'billing', label: null, address: 'Court Road, Narsingdi', phone: null },
      ],
      remove: [billing],
      change: [],
    });
    expect(merged.filter((address) => address.kind === 'billing').map((a) => a.id)).toEqual([
      added,
    ]);
  });

  it('refuses an added id the customer has already', () => {
    expect(
      refusalOf(() =>
        mergeAddresses(addresses, {
          ...noAddressChanges,
          add: [{ id: godown, kind: 'shipping', label: null, address: 'Ghat Road', phone: null }],
        }),
      ),
    ).toEqual({
      code: 'sync_id_taken',
      fieldErrors: { [`addresses.${godown}`]: ['sync_id_taken'] },
    });
  });

  it('refuses a second billing address, on the address this change made', () => {
    expect(
      refusalOf(() =>
        mergeAddresses(addresses, {
          ...noAddressChanges,
          add: [{ id: added, kind: 'billing', label: null, address: 'Court Road', phone: null }],
        }),
      ),
    ).toEqual({
      code: 'customer_billing_twice',
      fieldErrors: { [`addresses.${added}.kind`]: ['customer_billing_twice'] },
    });
    // A shipping address turned into a billing one: the error is on that one, not on the server's
    expect(
      refusalOf(() =>
        mergeAddresses(addresses, {
          ...noAddressChanges,
          change: [{ id: godown, kind: 'billing' }],
        }),
      ),
    ).toMatchObject({ fieldErrors: { [`addresses.${godown}.kind`]: ['customer_billing_twice'] } });
  });

  it('refuses more addresses than a customer may have, counted after the merge', () => {
    const many = Array.from({ length: 18 }, (_, n) => ({
      id: `0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2d${String(n).padStart(2, '0')}`,
      kind: 'shipping' as const,
      label: null,
      address: `Shop ${String(n + 1)}, Bazar Road`,
      phone: null,
    }));
    // 3 + 17 = 20 is fine, 3 + 18 is one too many, and 3 − 1 + 18 is fine again
    expect(mergeAddresses(addresses, { ...noAddressChanges, add: many.slice(1) })).toHaveLength(20);
    expect(refusalOf(() => mergeAddresses(addresses, { ...noAddressChanges, add: many }))).toEqual({
      code: 'too_long',
      fieldErrors: { addresses: ['too_long'] },
    });
    expect(mergeAddresses(addresses, { add: many, remove: [godown], change: [] })).toHaveLength(20);
  });

  it('merges the addresses of a whole customer change too', () => {
    const { input } = merge(
      { phone: { from: '01711-000000', to: '01811-111111' } },
      { add: [], remove: [godown], change: [{ id: depot, label: 'Bhairab depot' }] },
    );
    expect(input.addresses).toEqual([addresses[0], { ...addresses[1], label: 'Bhairab depot' }]);
  });
});
```

- **Karim Store as the server has it now** is the one fixture: the API's shape for the customer (the shape the
  `from` values come in) and the table's shape for its addresses. Each test changes one thing on top of it.
- **"Nothing changed" checks the whole input.** It is the one test that would see a field forgotten in
  `mergeCustomer()`'s list of twelve, or a field taken from the wrong place.
- **The four head-office fields in one test,** with `kept` in the order of the fields: the order the
  `kept_server_value` notice lists them in, which the Sync page shows (18b.6). A phone in the same command is still
  taken: a kept field never refuses the rest.
- **"Changed and then changed back" is not kept.** Decision 14 compares values, not history: 50,000 → 90,000 →
  50,000 is what the device read, so the device's change is a real change of the value it saw.
- **"A limit typed another way"** is why `from` has the API's shape (18b.1): `"50000"` is not `"50000.0000"`, so a
  device that sent the form's text would always lose its change. The test pins this, so nobody "fixes" the compare
  into a number compare that would hide such a device bug.
- **`label: null` and the phone left out** in one change: a field sent as `null` is cleared, a field not sent stays.
  The comment names the bug it guards (`?? old` puts the old label back).
- **Moving the billing address** (remove the old one, add a new one, in one change) must be allowed: the billing rule
  runs on the merged list, not on the added addresses alone.
- **The address limit is counted after the merge:** 3 + 17 is fine, 3 + 18 is one too many, and 3 − 1 + 18 is fine
  again. A check on the added addresses alone would get the last case wrong.
- **`refusalOf()`** turns a thrown `AppError` into what the push puts in the answer, so the tests compare the code
  and the field paths the device will see. It throws when the merge did not refuse, so a test cannot pass by
  accident.

### `sync/sync-push.int.spec.ts` (new): the setup

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  branchSchema,
  type Customer,
  type CustomerFormValues,
  customerSchema,
  type Device,
  deviceSchema,
  memberPageSchema,
  type NewAddressInput,
  problemSchema,
  type Product,
  productSchema,
  roleSchema,
  salesOrderSchema,
  setupSchema,
  type SyncChange,
  type SyncCommandInput,
  type SyncResult,
  syncPushSchema,
  taxRateListSchema,
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

// A distributor in Narsingdi whose sales officers write customers and orders on a laptop and a
// tablet without a connection, and push them later. Every test makes its own shop, so a test can
// run on its own; the order of the tests matters only for the roles (Rafiq's role comes and goes).
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: what the API cannot do yet (revoke a device: 18c) or never does (age an answer)
let sql: postgres.Sql;
let owner: SignedIn;
let rafiq: SignedIn;
let laptop: Device;
let tablet: Device;
let rafiqLaptop: Device;
let depot: Warehouse;
let ctgDepot: Warehouse;
let oldStore: Warehouse;
let taxRateId: string;
let pcs: string;
let juice: Product;
let karim: Customer;

type CreateCommand = Extract<SyncCommandInput, { type: 'customer.create' }>;
type UpdateCommand = Extract<SyncCommandInput, { type: 'customer.update' }>;
type OrderCommand = Extract<SyncCommandInput, { type: 'sales_order.create_draft' }>;

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

function pushRequest(
  commands: (SyncCommandInput | Record<string, unknown>)[],
  {
    as = owner,
    device = laptop,
    protocol = 1,
  }: { as?: SignedIn; device?: Device; protocol?: number } = {},
) {
  return send('POST', '/sync/push', { deviceId: device.id, protocol, commands }, as);
}

async function push(
  commands: (SyncCommandInput | Record<string, unknown>)[],
  options: { as?: SignedIn; device?: Device } = {},
): Promise<SyncResult[]> {
  const res = await pushRequest(commands, options);
  expect(res.statusCode, res.body).toBe(200);
  const { results } = syncPushSchema.parse(res.json());
  // One answer per command, in the order sent
  expect(results.map((result) => result.id)).toEqual(
    commands.map((command) => (typeof command.id === 'string' ? command.id : '')),
  );
  return results;
}

function accepted(result: SyncResult | undefined) {
  if (result?.status !== 'accepted') throw new Error(`not accepted: ${JSON.stringify(result)}`);
  return result;
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

// The customer row an answer sends the device to write at once
function customerIn(changes: SyncChange[]) {
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (change?.op !== 'upsert' || change.entity !== 'customer') {
    throw new Error(`not a customer row: ${JSON.stringify(change)}`);
  }
  return change.data;
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

// The form as the customer page fills it from a customer
function formOf(customer: Customer): CustomerFormValues {
  return {
    code: customer.code,
    name: customer.name,
    groupId: customer.groupId ?? '',
    contactPerson: customer.contactPerson ?? '',
    phone: customer.phone ?? '',
    email: customer.email ?? '',
    documentLanguage: customer.documentLanguage,
    bin: customer.bin ?? '',
    paymentTermsDays: customer.paymentTermsDays,
    creditLimit: customer.creditLimit ?? '',
    priceListId: customer.priceListId ?? '',
    notes: customer.notes ?? '',
    addresses: customer.addresses.map((address) => ({
      id: address.id,
      kind: address.kind === 'billing' ? 'billing' : 'shipping',
      label: address.label ?? '',
      address: address.address,
      phone: address.phone ?? '',
    })),
  };
}

// A shop saved online, through the form's route
async function shop(name: string, extra: Partial<CustomerFormValues> = {}): Promise<Customer> {
  return created(customerSchema, '/customers', customerForm(name, extra));
}

// A change saved online by the head office, from the customer as it is now
async function editOnline(
  customer: Customer,
  edit: (form: CustomerFormValues) => CustomerFormValues,
): Promise<Customer> {
  const now = await customerNow(customer.id);
  const res = await send('PUT', `/customers/${customer.id}`, {
    ...edit(formOf(now)),
    version: now.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return customerSchema.parse(res.json());
}

async function customerNow(id: string): Promise<Customer> {
  const res = await send('GET', `/customers/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return customerSchema.parse(res.json());
}

function address(kind: 'billing' | 'shipping', text: string): NewAddressInput {
  return { id: v7(), kind, label: '', address: text, phone: '' };
}

function newCustomer(name: string, extra: Partial<CreateCommand['input']> = {}): CreateCommand {
  return {
    id: v7(),
    type: 'customer.create',
    customerId: v7(),
    input: { ...customerForm(name), addresses: [], ...extra },
  };
}

// A change made on a device from the customer as the device read it
function changeOf(
  customer: Customer,
  changes: UpdateCommand['changes'],
  addresses: Partial<UpdateCommand['addresses']> = {},
): UpdateCommand {
  return {
    id: v7(),
    type: 'customer.update',
    customerId: customer.id,
    baseVersion: customer.version,
    changes,
    addresses: { add: [], remove: [], change: [], ...addresses },
  };
}

// Two dozen mango juice at ৳25, 15% VAT: net ৳600, total ৳690
function newOrder(customerId: string, extra: Partial<OrderCommand['input']> = {}): OrderCommand {
  return {
    id: v7(),
    type: 'sales_order.create_draft',
    orderId: v7(),
    input: {
      customerId,
      date: '2026-10-21',
      deliveryDate: '',
      customerReference: '',
      warehouseId: depot.id,
      shippingAddressId: '',
      note: '',
      lines: [
        {
          variantId: juice.variants[0]?.id ?? '',
          unitId: pcs,
          quantity: '24',
          description: '',
          unitPrice: '25',
          discountType: 'percent',
          discount: '0',
          taxRateId,
        },
      ],
      ...extra,
    },
  };
}

// The answer the server kept for a command, straight from the table
const answerRowSchema = z.object({
  device_id: z.uuid(),
  type: z.string(),
  entity_id: z.uuid(),
  status: z.string(),
  notices: z.unknown(),
  error: z.unknown(),
});

async function answerRow(id: string) {
  const rows = z.array(answerRowSchema).parse(
    await sql`SELECT device_id, type, entity_id, status, notices, error
                FROM sync_commands WHERE id = ${id}`,
  );
  return rows[0] ?? null;
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  return auditPageSchema.parse(res.json()).items;
}

async function registerDevice(as: SignedIn, name: string): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId: depot.branchId }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
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
  // Rafiq is a member with no role yet: syncing needs no permission, each command does
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

  // Narsingdi's MAIN store and an old store that is archived; Chattogram has its own depot
  const [main] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!main) throw new Error('no MAIN warehouse');
  depot = main;
  const store = await created(warehouseSchema, '/warehouses', {
    branchId: depot.branchId,
    code: 'NRS2',
    name: 'Old store',
    address: '',
  });
  const archived = await send('POST', `/warehouses/${store.id}/archive`, {
    version: store.version,
  });
  expect(archived.statusCode, archived.body).toBe(200);
  oldStore = warehouseSchema.parse(archived.json());
  const chattogram = await created(branchSchema, '/branches', {
    code: 'CTG',
    name: 'Chattogram depot',
    phone: '',
    address: 'Agrabad, Chattogram',
  });
  ctgDepot = await created(warehouseSchema, '/warehouses', {
    branchId: chattogram.id,
    code: 'CTG1',
    name: 'Chattogram depot',
    address: '',
  });

  // The two devices of the sales officer (the owner here), and Rafiq's laptop, all in Narsingdi
  laptop = await registerDevice(owner, 'Laptop');
  tablet = await registerDevice(owner, 'Tablet');
  rafiqLaptop = await registerDevice(rafiq, 'Rafiq laptop');

  taxRateId = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items[0]?.id ?? '';
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';
  juice = await created(productSchema, '/products', {
    code: '',
    name: 'Mango juice 250 ml',
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
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '25', archived: false },
    ],
    units: [],
    customFields: {},
  });
  karim = await shop('Karim Store', {
    phone: '01711-000000',
    addresses: [
      { id: null, kind: 'billing', label: '', address: 'Bazar Road, Narsingdi', phone: '' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **Every test makes its own shop** (`shop()`), so each test starts from a customer nobody else changed, and a
  failing test does not break the next one. Only "the roles of now" depends on order: Rafiq's role is given and
  taken away inside it.
- **Three devices:** the owner's laptop and tablet (two devices of one person, for "two devices changed one
  customer"), and Rafiq's laptop. All are in Narsingdi; the Chattogram depot is there only to prove that an order
  may use a warehouse of another branch (decision 15).
- **`push()` checks that there is one answer per command, in the order sent,** on every push of the file. The device
  matches the answers to its outbox by id, so a missing or reordered answer is a bug even when every status is
  right.
- **`accepted()` and `refusal()` narrow a result** (or throw with the whole result in the message), so a test reads
  `notices` or `error.fieldErrors` without a cast, and a wrong status fails with what came back.
- **`customerIn()`** takes the one customer row out of an answer's changes and narrows it on `op` and `entity`, so
  the row has the pull's customer type.
- **`formOf()` fills the form from a customer, as the customer page does.** `editOnline()` uses it for the head
  office's change, always from the customer as it is now (with its current version), so the online save never
  gets a `version_conflict`.
- **`changeOf()` builds a change from the customer as the device read it:** `baseVersion` is that customer's version,
  and each test writes the `from` values from the same object. That is exactly what the device does (18b.6).
- **`v7()` sets only the version digit.** The server checks that the device's ids are UUIDv7 (decision 12) and never
  reads the time in them.
- **`answerRow()` reads `sync_commands` as the superuser,** like `sql` in the 18a tests: the API never shows an
  answer's row, and a test must see that one was kept (or not kept, for an unreadable command).

### The request

```ts
describe('the request', () => {
  it('checks the protocol first, then the device', async () => {
    const stranger = { ...laptop, id: v7() };
    // An old app is told to reload, whatever else is wrong
    const old = await pushRequest([newCustomer('Old App Store')], {
      device: stranger,
      protocol: 2,
    });
    expect(old.statusCode).toBe(409);
    expect(problemSchema.parse(old.json()).code).toBe('sync_protocol_mismatch');

    const unknown = await pushRequest([newCustomer('Unknown Store')], { device: stranger });
    expect(unknown.statusCode).toBe(404);
    expect(problemSchema.parse(unknown.json()).code).toBe('device_not_found');
    // A device is one person's: Rafiq may not push with the owner's laptop
    const other = await pushRequest([newCustomer('Borrowed Store')], { as: rafiq, device: laptop });
    expect(other.statusCode).toBe(404);
    expect(problemSchema.parse(other.json()).code).toBe('device_not_found');
  });

  it('refuses a revoked device, and runs none of its commands', async () => {
    const lost = await registerDevice(owner, 'Lost phone');
    await sql`UPDATE devices SET revoked_at = now() WHERE id = ${lost.id}`;
    const command = newCustomer('Lost Phone Store');
    const res = await pushRequest([command], { device: lost });
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).code).toBe('device_revoked');
    expect(await answerRow(command.id)).toBeNull();
  });

  it('takes 1 to 50 commands', async () => {
    expect((await pushRequest([])).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, () => newCustomer('Too Many Store'));
    expect((await pushRequest(many)).statusCode).toBe(400);
  });
});
```

- **The protocol before the device:** an app built for protocol 2 is told to reload even when its device does not
  exist, the same order as the pull.
- **Another person's device is "not found"** (404), the same answer as an id that does not exist, as in 18a.
- **A revoked device (403) runs none of its commands:** the check is before the first command, and no answer row is
  written. Revoking is 18c's route; the test sets `revoked_at` as the superuser.
- **0 and 51 commands are the contract's 400.** The device never sends either (it stops a batch at 50).

### A new customer

```ts
describe('a new customer', () => {
  it('gets the next C- number, keeps the ids the device made, and names the device', async () => {
    const billing = address('billing', 'Station Road, Chattogram');
    const command = newCustomer('Rahman Pharmacy', { addresses: [billing] });
    const result = accepted((await push([command]))[0]);
    expect(result.notices).toEqual([]);
    // The row the device writes at once: the pull's shape, with no balance
    const row = customerIn(result.changes);
    expect(row).toMatchObject({ id: command.customerId, name: 'Rahman Pharmacy' });
    expect(row.code).toMatch(/^C-\d{5}$/);
    expect(row.addresses.map((a) => a.id)).toEqual([billing.id]);
    expect(row).not.toHaveProperty('balance');

    expect(await answerRow(command.id)).toEqual({
      device_id: laptop.id,
      type: 'customer.create',
      entity_id: command.customerId,
      status: 'accepted',
      notices: [],
      error: null,
    });
    const [entry] = await auditOf('customer', command.customerId);
    expect(entry).toMatchObject({
      action: 'customer.created',
      device: { id: laptop.id, name: 'Laptop' },
    });
  });

  it('keeps a typed code, and refuses one another customer has', async () => {
    const first = accepted((await push([newCustomer('Bhai Bhai Store', { code: 'BB-01' })]))[0]);
    expect(customerIn(first.changes).code).toBe('BB-01');
    const second = refusal((await push([newCustomer('Bhai Bhai Traders', { code: 'BB-01' })]))[0]);
    expect(second).toEqual({
      code: 'customer_code_taken',
      fieldErrors: { code: ['customer_code_taken'] },
    });
  });

  it('refuses an id that is taken, and keeps nothing of the command', async () => {
    const billing = address('billing', 'College Road, Bhairab');
    const made = newCustomer('Nayeem Store', { addresses: [billing] });
    accepted((await push([made]))[0]);

    // The customer's id again, under a new command id: the same customer cannot be made twice
    const again = { ...made, id: v7() };
    expect(refusal((await push([again]))[0])).toEqual({ code: 'sync_id_taken' });
    // A new customer with an address id that is taken: the customer is rolled back with it
    const reused = newCustomer('Nayeem Traders', { addresses: [billing] });
    expect(refusal((await push([reused]))[0])).toEqual({ code: 'sync_id_taken' });
    expect((await send('GET', `/customers/${reused.customerId}`)).statusCode).toBe(404);
    expect(await answerRow(reused.id)).toMatchObject({ status: 'rejected' });
  });

  it("refuses what the form refuses, under the form's own fields", async () => {
    const results = await push([
      newCustomer('R'),
      newCustomer('Sumon Store', { addresses: [address('shipping', 'Bus')] }),
      { ...newCustomer('Sumon Store'), customerId: randomUUID() },
      { ...newCustomer('Sumon Store'), id: randomUUID() },
    ]);
    expect(outcomes(results)).toEqual(Array(4).fill('invalid_input'));
    expect(results.map((result) => Object.keys(refusal(result).fieldErrors ?? {}))).toEqual([
      ['name'],
      ['addresses.0.address'],
      ['customerId'],
      ['id'],
    ]);
    expect(refusal(results[0]).fieldErrors).toEqual({ name: ['customer_name_required'] });
    // A command the server cannot read keeps no answer: sent again, it gets the same refusal
    for (const result of results) expect(await answerRow(result.id)).toBeNull();
  });

  it('refuses a command of a type it does not know, alone', async () => {
    const unknown = { id: v7(), type: 'sale.refund', amount: '500' };
    const results = await push([unknown, newCustomer('Kamal Store')]);
    expect(outcomes(results)).toEqual(['sync_command_invalid', 'accepted']);
    expect(await answerRow(unknown.id)).toBeNull();
  });
});
```

- **The answer's row is the pull's row:** the C- number given on arrival (decision 16), the device's address id, and
  no `balance` (the device keeps no balances). The kept answer has the device, the type and the customer's id; the
  audit entry names the laptop.
- **A typed code is kept; the same code typed on another device is `customer_code_taken` under `code`,** the same
  error the form shows online.
- **An id that is taken refuses the command and keeps nothing of it.** The second test is the important one: the
  customer's own insert works, then its address's insert fails on `party_addresses_pkey`. After the rollback to the
  savepoint, the customer is not there (404), and the refusal is kept. This is the test that fails without the
  savepoint.
- **The form's rules, under the form's paths** (decision 22): `name` and `addresses.0.address` inside `input`, and
  `customerId` and `id` for the command's own ids (a v4 id, not v7). None of the four keeps an answer (decision 24).
- **An unknown type is refused alone:** the next command of the same push still runs.

### An order written on a device

```ts
describe('an order written on a device', () => {
  it('is a draft for the customer made just before it, in the same push', async () => {
    const shipping = address('shipping', 'Godown 4, Ghat Road, Narsingdi');
    const customer = newCustomer('Sonar Bangla Store', { addresses: [shipping] });
    const order = newOrder(customer.customerId, { shippingAddressId: shipping.id });
    const [made, written] = await push([customer, order]);
    accepted(made);
    // Orders are not on the device: nothing to write
    expect(accepted(written).changes).toEqual([]);

    const saved = salesOrderSchema.parse(
      (await send('GET', `/sales-orders/${order.orderId}`)).json(),
    );
    expect(saved).toMatchObject({
      status: 'draft',
      number: null,
      customer: { id: customer.customerId },
      shippingAddressId: shipping.id,
      net: '600.0000',
      total: '690.0000',
    });
    const [entry] = await auditOf('sales_order', order.orderId);
    expect(entry?.device).toEqual({ id: laptop.id, name: 'Laptop' });
    expect(await answerRow(order.id)).toMatchObject({
      type: 'sales_order.create_draft',
      entity_id: order.orderId,
      status: 'accepted',
    });

    // Online, someone confirms it: it gets its number then
    const confirmed = await send('POST', `/sales-orders/${order.orderId}/confirm`, {
      version: saved.version,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(salesOrderSchema.parse(confirmed.json()).number).toMatch(/^SO-/);
  });

  it("may use a warehouse of another branch than the device's", async () => {
    const order = newOrder(karim.id, { warehouseId: ctgDepot.id });
    accepted((await push([order]))[0]);
    const saved = salesOrderSchema.parse(
      (await send('GET', `/sales-orders/${order.orderId}`)).json(),
    );
    expect(saved.warehouseId).toBe(ctgDepot.id);
  });

  it('is refused for what an online draft is refused for', async () => {
    const closed = await shop('Closed Shop');
    const archived = await send('POST', `/customers/${closed.id}/archive`, {
      version: closed.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const [billing] = karim.addresses;
    const taken = newOrder(karim.id);
    accepted((await push([taken]))[0]);

    const results = await push([
      newOrder(karim.id, { warehouseId: oldStore.id }),
      newOrder(closed.id),
      newOrder(v7()),
      newOrder((await shop('Other Shop')).id, { shippingAddressId: billing?.id ?? '' }),
      { ...newOrder(karim.id), orderId: taken.orderId },
    ]);
    expect(outcomes(results)).toEqual([
      'stock_warehouse_invalid',
      'sales_customer_invalid',
      'sales_customer_invalid',
      'sales_address_invalid',
      'sync_id_taken',
    ]);
    expect(refusal(results[0]).fieldErrors).toEqual({ warehouseId: ['stock_warehouse_invalid'] });
    expect(refusal(results[1]).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
  });

  it('puts a bad line under its place in the lines', async () => {
    const order = newOrder(karim.id);
    const [line] = order.input.lines;
    if (!line) throw new Error('no line');
    const result = refusal(
      (
        await push([{ ...order, input: { ...order.input, lines: [{ ...line, quantity: '0' }] } }])
      )[0],
    );
    expect(result.code).toBe('invalid_input');
    expect(Object.keys(result.fieldErrors ?? {})).toEqual(['lines.0.quantity']);
  });

  it('is refused when its customer was refused before it', async () => {
    // A device should not send it (decision 13), but the server must stay right if one does
    const customer = newCustomer('S');
    const results = await push([customer, newOrder(customer.customerId)]);
    expect(outcomes(results)).toEqual(['invalid_input', 'sales_customer_invalid']);
  });
});
```

- **The customer and its order in one push:** the order finds the customer made one command before, and points at
  the address the device made. It is a draft with no number; its totals are the server's (net ৳600, VAT 15%, total
  ৳690); its audit entry names the laptop; its answer has no rows (orders are not on the device). Confirmed online, it
  gets its SO- number then.
- **A warehouse of Chattogram is taken** from a Narsingdi device (decision 15).
- **The refusals of an online draft:** an archived warehouse, an archived customer, a customer that does not exist,
  an address of another customer, an order id already used. The first two are checked with their field paths: the
  Sync page puts the error under the warehouse or the customer box.
- **A bad line is `lines.0.quantity`,** inside `input`, so the order form shows it on that line.
- **An order whose customer was refused before it** is refused too (`sales_customer_invalid`). The device should not
  send it (decision 13: it waits for its customer), but the server must not depend on that.

### A customer changed on a device

```ts
describe('a customer changed on a device', () => {
  it('keeps both changes when two devices changed different fields', async () => {
    const read = await shop('Nadia Cosmetics', { phone: '01712-345678' });
    const fromLaptop = changeOf(read, { phone: { from: read.phone, to: '01812-345678' } });
    const fromTablet = changeOf(read, {
      email: { from: read.email, to: 'nadia@nadiacosmetics.com' },
    });
    expect(accepted((await push([fromLaptop]))[0]).notices).toEqual([]);
    const second = accepted((await push([fromTablet], { device: tablet }))[0]);
    expect(second.notices).toEqual([]);
    // The answer of the second already has both: the device writes the customer as it is now
    expect(customerIn(second.changes)).toMatchObject({
      phone: '01812-345678',
      email: 'nadia@nadiacosmetics.com',
      version: read.version + 2,
    });
  });

  it('takes the later arrival when two devices changed the same field', async () => {
    const read = await shop('Hasan Medical Hall', { contactPerson: 'Hasan Ali' });
    await push([changeOf(read, { contactPerson: { from: 'Hasan Ali', to: 'Rubel Hasan' } })]);
    await push([changeOf(read, { contactPerson: { from: 'Hasan Ali', to: 'Mita Hasan' } })], {
      device: tablet,
    });
    expect((await customerNow(read.id)).contactPerson).toBe('Mita Hasan');
  });

  it('keeps a head-office field the server changed, says so, and takes the rest', async () => {
    const read = await shop('Tasnim Store', { creditLimit: '50000', paymentTermsDays: 30 });
    await editOnline(read, (form) => ({ ...form, creditLimit: '80000' }));
    const command = changeOf(read, {
      creditLimit: { from: read.creditLimit, to: '60000' },
      paymentTermsDays: { from: 30, to: 45 },
      phone: { from: read.phone, to: '01811-111111' },
    });
    const result = accepted((await push([command]))[0]);
    expect(result.notices).toEqual([{ code: 'kept_server_value', fields: ['creditLimit'] }]);
    // The terms were not changed on the server, so the device's 45 days are taken
    expect(customerIn(result.changes)).toMatchObject({
      creditLimit: '80000.0000',
      paymentTermsDays: 45,
      phone: '01811-111111',
    });
    // The notice is kept with the answer: sent again, the device is told the same
    expect(accepted((await push([command]))[0]).notices).toEqual(result.notices);
  });

  it('takes a head-office field the server changed back to what the device read', async () => {
    const read = await shop('Mollah Traders', { creditLimit: '50000' });
    const raised = await editOnline(read, (form) => ({ ...form, creditLimit: '90000' }));
    await editOnline(raised, (form) => ({ ...form, creditLimit: '50000' }));
    const result = accepted(
      (await push([changeOf(read, { creditLimit: { from: read.creditLimit, to: '' } })]))[0],
    );
    expect(result.notices).toEqual([]);
    expect(customerIn(result.changes).creditLimit).toBeNull();
  });

  it('merges the addresses one by one, and an order may use one added in the same push', async () => {
    const read = await shop('Al-Amin Store', {
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'Bazar Road, Bhairab', phone: '' },
        { id: null, kind: 'shipping', label: 'Depot', address: 'Station Road, Bhairab', phone: '' },
      ],
    });
    const [billing, shipping] = read.addresses;
    if (!billing || !shipping) throw new Error('no addresses');
    // Meanwhile the head office adds a godown
    await editOnline(read, (form) => ({
      ...form,
      addresses: [
        ...form.addresses,
        { id: null, kind: 'shipping', label: 'Godown', address: 'Ghat Road, Bhairab', phone: '' },
      ],
    }));
    const shop2 = address('shipping', 'Shop 12, New Market, Bhairab');
    const command = changeOf(
      read,
      {},
      { add: [shop2], change: [{ id: billing.id, phone: '01911-222222' }], remove: [shipping.id] },
    );
    const results = await push([command, newOrder(read.id, { shippingAddressId: shop2.id })]);
    expect(outcomes(results)).toEqual(['accepted', 'accepted']);
    const now = await customerNow(read.id);
    expect(now.addresses.map((a) => [a.label ?? a.address, a.phone])).toEqual([
      ['Bazar Road, Bhairab', '01911-222222'],
      ['Godown', null],
      ['Shop 12, New Market, Bhairab', null],
    ]);
    expect(now.addresses[2]?.id).toBe(shop2.id);
  });

  it('drops the change of an address the server removed, and keeps the rest', async () => {
    const read = await shop('Shapla Store', {
      addresses: [
        { id: null, kind: 'shipping', label: 'Depot', address: 'Station Road, Bhairab', phone: '' },
      ],
    });
    const [depotAddress] = read.addresses;
    if (!depotAddress) throw new Error('no address');
    await editOnline(read, (form) => ({ ...form, addresses: [] }));
    const result = accepted(
      (
        await push([
          changeOf(
            read,
            { name: { from: read.name, to: 'Shapla General Store' } },
            { change: [{ id: depotAddress.id, label: 'Old depot' }] },
          ),
        ])
      )[0],
    );
    expect(customerIn(result.changes)).toMatchObject({
      name: 'Shapla General Store',
      addresses: [],
    });
  });

  it('refuses a second billing address that only the merge makes', async () => {
    // Each change alone is fine: the head office and the device both add the billing address
    const read = await shop('Joy Telecom');
    await editOnline(read, (form) => ({
      ...form,
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'Court Road, Narsingdi', phone: '' },
      ],
    }));
    const billing = address('billing', 'College Road, Narsingdi');
    const command = changeOf(read, {}, { add: [billing] });
    expect(refusal((await push([command]))[0])).toEqual({
      code: 'customer_billing_twice',
      fieldErrors: { [`addresses.${billing.id}.kind`]: ['customer_billing_twice'] },
    });
    expect((await customerNow(read.id)).addresses).toHaveLength(1);
  });

  it('refuses a code another customer has, and a field the form refuses', async () => {
    const read = await shop('Bismillah Store');
    const addressId = v7();
    const results = await push([
      changeOf(read, { code: { from: read.code, to: karim.code } }),
      changeOf(read, { name: { from: read.name, to: 'B' } }),
      changeOf(read, {}, { change: [{ id: addressId, label: 'L'.repeat(61) }] }),
    ]);
    expect(refusal(results[0])).toEqual({
      code: 'customer_code_taken',
      fieldErrors: { code: ['customer_code_taken'] },
    });
    expect(refusal(results[1]).fieldErrors).toEqual({ name: ['customer_name_required'] });
    // An address by its id, not by its place in the command
    expect(Object.keys(refusal(results[2]).fieldErrors ?? {})).toEqual([
      `addresses.${addressId}.label`,
    ]);
  });

  it('changes an archived customer, and tells the device to drop it', async () => {
    const read = await shop('Sabbir Store');
    const res = await send('POST', `/customers/${read.id}/archive`, { version: read.version });
    expect(res.statusCode, res.body).toBe(200);
    const result = accepted(
      (await push([changeOf(read, { phone: { from: read.phone, to: '01733-333333' } })]))[0],
    );
    expect(result.changes).toEqual([{ op: 'delete', entity: 'customer', key: read.id }]);
    expect((await customerNow(read.id)).phone).toBe('01733-333333');
  });

  it('refuses a change of a customer the server no longer has', async () => {
    const read = await shop('Gone Store');
    const deleted = await send('DELETE', `/customers/${read.id}?version=${String(read.version)}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    const results = await push([
      changeOf(read, { phone: { from: read.phone, to: '01744-444444' } }),
      changeOf({ ...read, id: randomUUID() }, { phone: { from: null, to: '01744-444444' } }),
    ]);
    expect(outcomes(results)).toEqual(['sync_customer_gone', 'sync_customer_gone']);
  });

  it('names the device on the audit entry, and no device for a change saved online', async () => {
    const read = await shop('Audit Store');
    await push([changeOf(read, { notes: { from: null, to: 'Pays on Thursdays' } })], {
      device: tablet,
    });
    await editOnline(read, (form) => ({ ...form, notes: 'Pays on Fridays' }));
    const entries = await auditOf('customer', read.id);
    expect(entries.map((entry) => [entry.action, entry.device?.name ?? null])).toEqual([
      ['customer.updated', null],
      ['customer.updated', 'Tablet'],
      ['customer.created', null],
    ]);
  });
});
```

- **Different fields from two devices: both stay,** and the second answer already has both: the device writes the
  customer as it is now, with its new version (two saves, two versions more).
- **The same field: the later arrival wins** (decision 6). The tablet's push arrives second, so its contact person
  stays, whatever the devices' clocks say.
- **A head-office field the server changed is kept, the device is told, and the rest is taken.** The terms in the
  same command were not changed on the server, so the device's 45 days are taken. Sent again, the answer has the
  same notice: it was kept with the answer.
- **Changed and changed back on the server:** the device's change is taken, as in the unit test, here through the
  real save (an empty limit becomes `null`, no limit).
- **The addresses, one by one, against a real customer:** the head office added a godown while the device added a
  shop address, changed the billing phone and removed the depot. All four changes are in the result, in the
  table's order, and an order in the same push already uses the shop address by the device's id.
- **A change of an address the server removed is dropped,** with no error, and the name in the same command is still
  saved.
- **Two billing addresses that only the merge makes:** each save alone is fine. The refusal names the device's
  address by its id, and nothing is saved.
- **A taken code, a bad name, and a bad label** of an address by its id (`addresses.<id>.label`, decision 22).
- **An archived customer still takes the change,** and the answer is a delete: the device does not keep archived
  customers, the same as a delta pull would say.
- **A deleted customer, and an id that was never a customer, are `sync_customer_gone`:** there is nothing to fix, so
  the Sync page offers Discard (18b.6).
- **The audit log names the tablet** for the device's change and no device for the online one (newest first).

### A command sent again

```ts
describe('a command sent again', () => {
  it('is answered from what was kept, with the rows as they are now', async () => {
    const command = newCustomer('Jamuna Store');
    accepted((await push([command]))[0]);
    // The head office renames it before the device hears the first answer
    const made = await customerNow(command.customerId);
    await editOnline(made, (form) => ({ ...form, name: 'Jamuna General Store' }));

    const again = accepted((await push([command]))[0]);
    expect(customerIn(again.changes).name).toBe('Jamuna General Store');
    const entries = await auditOf('customer', command.customerId);
    expect(entries.map((entry) => entry.action)).toEqual(['customer.updated', 'customer.created']);

    // Archived meanwhile: the answer tells the device to drop it
    const now = await customerNow(command.customerId);
    const res = await send('POST', `/customers/${now.id}/archive`, { version: now.version });
    expect(res.statusCode, res.body).toBe(200);
    expect(accepted((await push([command]))[0]).changes).toEqual([
      { op: 'delete', entity: 'customer', key: command.customerId },
    ]);
  });

  it('runs once when it is twice in the same push', async () => {
    const command = newCustomer('Twice In One Store');
    expect(outcomes(await push([command, command]))).toEqual(['accepted', 'accepted']);
    const list = await send('GET', '/customers?search=Twice%20In%20One');
    expect(z.object({ items: z.array(z.unknown()) }).parse(list.json()).items).toHaveLength(1);
  });

  it('runs once when two pushes send it at the same moment', async () => {
    const command = newCustomer('Twice Traders');
    const [a, b] = await Promise.all([push([command]), push([command])]);
    expect([a[0]?.status, b[0]?.status]).toEqual(['accepted', 'accepted']);
    const list = await send('GET', '/customers?search=Twice%20Traders');
    expect(z.object({ items: z.array(z.unknown()) }).parse(list.json()).items).toHaveLength(1);
  });

  it('stays refused when the reason is gone; under a new id it runs', async () => {
    const holder = await shop('Code Holder', { code: 'MG-01' });
    const command = newCustomer('Meghna Grocery', { code: 'MG-01' });
    expect(refusal((await push([command]))[0]).code).toBe('customer_code_taken');
    await editOnline(holder, (form) => ({ ...form, code: 'MG-99' }));
    // The same id gets the same answer: the device cannot tell a resend from a lost answer
    expect(refusal((await push([command]))[0]).code).toBe('customer_code_taken');
    // Edited on the Sync page and sent again, it is a new command (18b.6)
    expect(accepted((await push([{ ...command, id: v7() }]))[0]).notices).toEqual([]);
  });
});
```

- **Answered from what was kept, with the rows of now** (decision 18): renamed online after the first push, the
  resend's row has the new name, and the audit log has one `customer.created` (the command did not run again).
  Archived after that, the resend's answer is a delete.
- **Twice in the same push:** the second is answered from the first one's row, in the same request.
- **Twice at the same moment,** from 18b.3's smoke test: the advisory lock makes the second wait, and both answers
  are "accepted" with one customer.
- **A refusal stays a refusal** even after its reason is gone (the other customer's code changed): the server cannot
  tell a resend from an answer that was lost, so the same id always gets the same answer. Under a new id, it runs.
  This is why the Sync page sends an edited command under a new id (18b.6).

### The roles of now

```ts
describe('the roles of now', () => {
  async function giveRafiq(roleIds: string[]) {
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const member = items.find((item) => item.email === 'rafiq@meghnadistributors.com');
    if (!member) throw new Error('Rafiq is not a member');
    const res = await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds,
      version: member.version,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  it('refuses each command whose permission the person does not have', async () => {
    const results = await push([newCustomer('Rafiq Store'), newOrder(karim.id)], {
      as: rafiq,
      device: rafiqLaptop,
    });
    expect(results.map((result) => refusal(result))).toEqual([
      { code: 'permission_missing', params: { permissions: 'sales.customer.manage' } },
      { code: 'permission_missing', params: { permissions: 'sales.order.manage' } },
    ]);
  });

  it('runs what a role given since allows, and refuses it again once the role is gone', async () => {
    const fieldSales = await created(roleSchema, '/roles', {
      name: 'Field sales',
      description: '',
    });
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [
        { id: fieldSales.id, version: fieldSales.version, permissions: ['sales.customer.manage'] },
      ],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    await giveRafiq([fieldSales.id]);
    const customer = newCustomer('Bhairab Route Store');
    expect(
      outcomes(
        await push([customer, newOrder(customer.customerId)], { as: rafiq, device: rafiqLaptop }),
      ),
    ).toEqual(['accepted', 'permission_missing']);

    // Taken away while his laptop was offline: what he wrote then is refused when it arrives
    await giveRafiq([]);
    const later = changeOf(await customerNow(customer.customerId), {
      phone: { from: null, to: '01755-555555' },
    });
    expect(refusal((await push([later], { as: rafiq, device: rafiqLaptop }))[0])).toMatchObject({
      code: 'permission_missing',
    });
  });
});
```

- **Each command needs its route's permission** (decision 17): Rafiq without a role pushes (syncing needs none), and
  each of his two commands is refused with the permission it needed.
- **Given a role with `sales.customer.manage` only,** his customer is made and his order is still refused, in the same
  push.
- **Taken away while his laptop was offline,** what he wrote then is refused when it arrives. The role change empties
  the permission cache (step 6), so the next push reads the roles of now.

### The answers kept

```ts
describe('the answers kept', () => {
  it('are kept 30 days: the worker deletes older ones, and a resend after that runs again', async () => {
    const old = newCustomer('Old Answer Store');
    const recent = newCustomer('Recent Answer Store');
    accepted((await push([old, recent]))[0]);
    await sql`UPDATE sync_commands SET created_at = now() - interval '31 days' WHERE id = ${old.id}`;
    await sql`UPDATE sync_commands SET created_at = now() - interval '29 days'
              WHERE id = ${recent.id}`;

    expect(await worker.get(SyncLogCleanup).deleteOldAnswers()).toBe(1);
    expect(await answerRow(old.id)).toBeNull();
    expect(await answerRow(recent.id)).not.toBeNull();
    expect(await worker.get(SyncLogCleanup).deleteOldAnswers()).toBe(0);
    // A device that kept a command this long is past the pull's 30 days too, so it starts over
    // with a full pull; if it still sent it, the customer is not made twice
    expect(refusal((await push([old]))[0])).toEqual({ code: 'sync_id_taken' });
  });
});
```

- **30 days, then the worker deletes them** (decision 25): one answer made 31 days old goes, one 29 days old stays,
  and a second run deletes nothing. It runs as `omnivo_worker`, as in production.
- **A resend after that is `sync_id_taken`:** the command runs again, but the customer it would make is there, so
  nothing is made twice. A device that old has a cursor older than 30 days too, so it starts over with a full pull
  anyway.

### `sync/sync.tenant-leak.int.spec.ts`: the push

```diff
@@ -13,7 +13,10 @@ import {
   problemSchema,
   setupSchema,
   type SyncChange,
+  type SyncCommandInput,
   syncPullSchema,
+  syncPushSchema,
+  taxRateListSchema,
   type Unit,
   unitListSchema,
   warehouseListSchema,
@@ -85,6 +88,40 @@ async function pulled(space: Pick<Workspace, 'who' | 'device'>, cursor?: string)
   return page;
 }
 
+// One push of a workspace's own device; every answer back, in order
+async function pushed(space: Pick<Workspace, 'who' | 'device'>, commands: SyncCommandInput[]) {
+  const res = await as(space.who, 'POST', '/sync/push', {
+    deviceId: space.device.id,
+    protocol: 1,
+    commands,
+  });
+  expect(res.statusCode, res.body).toBe(200);
+  return syncPushSchema.parse(res.json()).results;
+}
+
+function newCustomer(name: string, customerId = v7()): SyncCommandInput {
+  return {
+    id: v7(),
+    type: 'customer.create',
+    customerId,
+    input: {
+      code: '',
+      name,
+      groupId: '',
+      contactPerson: '',
+      phone: '',
+      email: '',
+      documentLanguage: 'en',
+      bin: '',
+      paymentTermsDays: 30,
+      creditLimit: '',
+      priceListId: '',
+      notes: '',
+      addresses: [],
+    },
+  };
+}
+
 // A change as text: its key (a price or a stock key holds three ids) and every id inside its row,
 // so one search finds an id wherever the change names it
 function idsIn(change: SyncChange): string {
@@ -290,6 +327,88 @@ describe('pulling over HTTP', () => {
   });
 });
 
+describe('pushing over HTTP', () => {
+  it("cannot change tenant B's customer, nor take its id", async () => {
+    const results = await pushed(a, [
+      {
+        id: v7(),
+        type: 'customer.update',
+        customerId: b.customer.id,
+        baseVersion: b.customer.version,
+        changes: { name: { from: b.customer.name, to: 'Taken by A' } },
+        addresses: { add: [], remove: [], change: [] },
+      },
+      newCustomer('Copy of Lazz Pharma', b.customer.id),
+    ]);
+    // "Gone" and "taken", as for an id of A's own: nothing says the id is B's
+    expect(results.map((r) => r.status === 'rejected' && r.error.code)).toEqual([
+      'sync_customer_gone',
+      'sync_id_taken',
+    ]);
+    const res = await as(b.who, 'GET', `/customers/${b.customer.id}`);
+    expect(customerSchema.parse(res.json()).name).toBe('Lazz Pharma');
+  });
+
+  it("writes no order for tenant B's customer", async () => {
+    const [warehouse] = warehouseListSchema.parse(
+      (await as(a.who, 'GET', '/warehouses')).json(),
+    ).items;
+    const [taxRate] = taxRateListSchema.parse((await as(a.who, 'GET', '/tax-rates')).json()).items;
+    const [result] = await pushed(a, [
+      {
+        id: v7(),
+        type: 'sales_order.create_draft',
+        orderId: v7(),
+        input: {
+          customerId: b.customer.id,
+          date: '2026-10-21',
+          deliveryDate: '',
+          customerReference: '',
+          warehouseId: warehouse?.id ?? '',
+          shippingAddressId: '',
+          note: '',
+          lines: [
+            {
+              variantId: a.product.variants[0]?.id ?? '',
+              unitId: a.product.baseUnitId,
+              quantity: '1',
+              description: '',
+              unitPrice: '10',
+              discountType: 'percent',
+              discount: '0',
+              taxRateId: taxRate?.id ?? '',
+            },
+          ],
+        },
+      },
+    ]);
+    expect(result?.status === 'rejected' && result.error.code).toBe('sales_customer_invalid');
+  });
+
+  it("is never answered from tenant B's answer to the same command id", async () => {
+    const ofB = newCustomer('Tamanna Pharmacy');
+    const [answerOfB] = await pushed(b, [ofB]);
+    expect(answerOfB?.status).toBe('accepted');
+    // A device of A sends a command with the same id (ids are global, so only a bug would)
+    const ofA = { ...newCustomer('Tamanna Fashion'), id: ofB.id };
+    const [answerOfA] = await pushed(a, [ofA]);
+    if (answerOfA?.status !== 'accepted') throw new Error('not accepted');
+    // A's own command ran: the row is A's new customer, not B's
+    expect(JSON.stringify(answerOfA.changes)).toContain('Tamanna Fashion');
+    expect(JSON.stringify(answerOfA.changes)).not.toContain('Tamanna Pharmacy');
+  });
+
+  it("cannot push with tenant B's device", async () => {
+    const res = await as(a.who, 'POST', '/sync/push', {
+      deviceId: b.device.id,
+      protocol: 1,
+      commands: [newCustomer('Through B')],
+    });
+    expect(res.statusCode).toBe(404);
+    expect(problemSchema.parse(res.json()).code).toBe('device_not_found');
+  });
+});
+
 // Postgres error code of a statement run as the given role, or null when it worked
 async function errorCodeAs(url: string, run: (sql: postgres.Sql) => Promise<unknown>) {
   const sql = postgres(url, { max: 1 });
@@ -328,6 +447,10 @@ describe('the change log and the devices as omnivo_app', () => {
       await asAppInA((tx) => tx`SELECT tenant_id FROM devices`),
     );
     expect(devices).toEqual([{ tenant_id: a.tenantId }]);
+    const answers = tenantRowsSchema.parse(
+      await asAppInA((tx) => tx`SELECT DISTINCT tenant_id FROM sync_commands`),
+    );
+    expect(answers).toEqual([{ tenant_id: a.tenantId }]);
   });
 
   it("cannot add a line for tenant B, nor change B's device", async () => {
@@ -346,6 +469,16 @@ describe('the change log and the devices as omnivo_app', () => {
       (tx) => tx`UPDATE devices SET name = 'Taken' WHERE id = ${b.device.id} RETURNING id`,
     );
     expect(updated).toEqual([]);
+    expect(
+      await errorCodeAs(pg.appUrl, (sql) =>
+        sql.begin(async (tx) => {
+          await tx`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
+          await tx`INSERT INTO sync_commands (id, tenant_id, device_id, type, entity_id, status)
+                   VALUES (${v7()}, ${b.tenantId}, ${b.device.id}, 'customer.create',
+                           ${b.customer.id}, 'accepted')`;
+        }),
+      ),
+    ).toBe('42501');
   });
 
   it('cannot edit or delete a line, nor delete a device, even its own', async () => {
@@ -359,15 +492,21 @@ describe('the change log and the devices as omnivo_app', () => {
     expect(await inA((tx) => tx`UPDATE sync_changes SET entity_key = 'x'`)).toBe('42501');
     expect(await inA((tx) => tx`DELETE FROM sync_changes`)).toBe('42501');
     expect(await inA((tx) => tx`DELETE FROM devices`)).toBe('42501');
+    // An answer is written once: changing it would change what a resend is told
+    expect(await inA((tx) => tx`UPDATE sync_commands SET status = 'rejected'`)).toBe('42501');
+    expect(await inA((tx) => tx`DELETE FROM sync_commands`)).toBe('42501');
   });
 });
 
 describe('omnivo_worker, the cleanup role', () => {
-  it('sees the lines of every tenant, without a tenant context', async () => {
+  it('sees the lines and the answers of every tenant, without a tenant context', async () => {
     const sql = postgres(pg.workerUrl, { max: 1 });
     const rows = tenantRowsSchema.parse(await sql`SELECT DISTINCT tenant_id FROM sync_changes`);
+    // The answers too: the worker deletes the old ones of every workspace (0046's sync_prune)
+    const answers = tenantRowsSchema.parse(await sql`SELECT DISTINCT tenant_id FROM sync_commands`);
     await sql.end();
     expect(rows.map((row) => row.tenant_id).sort()).toEqual([a.tenantId, b.tenantId].sort());
+    expect(answers.map((row) => row.tenant_id).sort()).toEqual([a.tenantId, b.tenantId].sort());
   });
 
   it('cannot read the devices, nor add a line', async () => {
```

- **B's customer, from A's device:** a change is `sync_customer_gone`, and a new customer with its id is
  `sync_id_taken` — the same answers as for an id of A's own, so nothing says that the id is B's. B's customer keeps
  its name.
- **No order for B's customer:** `sales_customer_invalid`, as for a customer that does not exist.
- **A command id that B used is A's own command in A:** the answers' key is (tenant, id), so A's command runs and its
  answer has A's new customer, never B's row. Ids are made per device and never collide; only a bug would send the
  same id, and even then nothing leaks.
- **B's device:** `device_not_found`, as for the pull.
- **In the database, as `omnivo_app` in A's context:** it reads only A's answers, cannot insert one for B (42501, the
  policy's `WITH CHECK`), and cannot change or delete an answer, even its own (0046's `REVOKE`). An answer that could
  change would change what a resend is told.
- **As `omnivo_worker`:** it sees the answers of both workspaces with no tenant context (`sync_prune`), which is what
  the cleanup needs.
- `sync_commands` is also in the RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`), which finds every table
  with a `tenant_id` by itself: it needed no change.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
cd apps/api
npx vitest run src/sync/
```

The last command starts its own Postgres and Valkey containers (Docker must be running) and takes about half a
minute. All 62 tests pass (18a's pull tests, the 31 push tests, and the 13 tenant-leak tests). `pnpm --filter
@omnivo/api test` runs the unit tests: 123, the 16 merge tests among them. The whole suites (`pnpm test:integration`,
`pnpm test:tenant-leak`) run once at the end of 18b.

## 18b.5 — `packages/i18n`: the words

The screens of 18b.6 need their words in English and Bangla, and the app cannot type-check without them, so they come
first. This part changes only the two locale files. The ui package needs nothing new: the Sync page is a page header,
cards with rows, pills and the dialog; the sidebar line is a nav item with a count; the offline notice is the
document notice.

When this part starts, `packages/i18n` has one error: the `errors` object is missing the 3 new codes of 18b.1. When
it ends, the package and the ui package type-check. The app still has one error, in its MSW mocks: an audit entry
there has no `device` (18b.1's `auditEntrySchema`). 18b.7 gives every mock entry `device: null`.

### `locales/en.ts`

```diff
@@ -93,6 +93,7 @@ export const en = {
     debitNotes: 'Debit notes',
     supplierRefunds: 'Supplier refunds',
     approvals: 'Approvals',
+    sync: 'Sync',
   },
   auth: {
     workspace: 'Workspace',
@@ -370,6 +371,97 @@ export const en = {
     storageFailedTitle: "This browser can't keep the data",
     storageFailedBody:
       "Omnivo keeps its copy in the browser's storage. Leave private browsing or free some space on the device, then reload the page.",
+    // The sidebar line and the Sync page (step 18b): work saved on the device, sent later.
+    // count picks the plural; formatted = the number in the page's language (3 / ৩)
+    online: 'Online',
+    offline: 'Offline',
+    syncing: 'Syncing…',
+    allSynced: 'All changes synced',
+    waiting_one: '{{formatted}} change waiting',
+    waiting_other: '{{formatted}} changes waiting',
+    needsAttention_one: '{{formatted}} change needs attention',
+    needsAttention_other: '{{formatted}} changes need attention',
+    title: 'Sync',
+    description: 'Work saved on this device, and when it last reached the server',
+    syncNow: 'Sync now',
+    syncNowOffline: 'Connect to the internet to sync.',
+    lastSynced: 'Last synced {{time}}',
+    neverSynced: 'Not synced yet',
+    changesTitle: 'Changes on this device',
+    changesSubtitle: 'Sent to the server oldest first, as soon as there is a connection',
+    emptyTitle: 'Everything is synced',
+    emptyBody: 'A customer or an order saved while offline waits here until it reaches the server.',
+    // One per SYNC_COMMAND_TYPES entry, so the app can write t(`sync.commands.${type}`)
+    commands: {
+      customer: {
+        create: 'New customer {{name}}',
+        update: 'Changes to {{name}}',
+      },
+      sales_order: {
+        create_draft: 'Draft order for {{name}}',
+      },
+    },
+    savedAt: 'Saved {{time}}',
+    // fields = the form's own labels, joined in the page's language ("Phone and Credit limit")
+    changedFields: 'Changed: {{fields}}',
+    orderLines_one: '{{formatted}} line · {{total}}',
+    orderLines_other: '{{formatted}} lines · {{total}}',
+    statuses: {
+      waiting: 'Waiting',
+      sending: 'Sending',
+      failed: 'Needs attention',
+    },
+    // A command that needs one not accepted yet (decision 13), like an order for a new customer
+    waitsFor: 'Waits for {{name}} to sync first',
+    fixHint: 'Open it, fix what is marked, and save it again.',
+    edit: 'Edit',
+    discard: 'Discard',
+    discardTitle: 'Discard this change?',
+    discardBody:
+      'It is removed from this device and never reaches the server. This cannot be undone.',
+    discardDependents_one: 'The {{formatted}} change that needs it is discarded too.',
+    discardDependents_other: 'The {{formatted}} changes that need it are discarded too.',
+    discardConfirm: 'Discard change',
+    discarded: 'Change discarded',
+    // kept_server_value notices: a head-office field changed on the server since the device read it
+    noticesTitle: 'Kept from the server',
+    noticesSubtitle:
+      'The head office changed these while you were offline, so their value stays as it is',
+    keptFields: 'Not changed: {{fields}}',
+    dismiss: 'Dismiss',
+    synced_one: '{{formatted}} change synced',
+    synced_other: '{{formatted}} changes synced',
+    someFailed: 'Some changes need attention. Open Sync to fix them.',
+    someKept: 'Some fields kept the value the server had. Open Sync to see which.',
+    // The customer and order forms offline (decision 2)
+    saveOnDevice: 'Save on this device',
+    savedOnDevice: 'Saved on this device. It syncs when the connection is back.',
+    saveFailed: "Couldn't save on this device. Free some space, then try again.",
+    offlineNotice:
+      "You're offline. This is saved on this device and sent when the connection is back.",
+    orderOfflineNotice:
+      "You're offline. The order is saved on this device as a draft. Confirm it once it has synced.",
+    waitingNotice:
+      'This customer has changes on this device that have not synced yet, so this change is saved after them.',
+    codeOfflineHint: 'Leave empty for the next number. It is given when the customer syncs.',
+    notSynced: 'Not synced',
+    noNumberYet: 'No number yet',
+    unsyncedTitle: 'On this device · not synced',
+    unsyncedSubtitle: 'Drafts saved while offline. They move to the list below once they sync.',
+    // Signing out deletes the device's copy (18a, decision 41), and the changes with it
+    signOutTitle: 'Sign out and lose the changes?',
+    signOutBody_one:
+      '{{formatted}} change on this device has not synced. Signing out removes it for good.',
+    signOutBody_other:
+      '{{formatted}} changes on this device have not synced. Signing out removes them for good.',
+    signOutAnyway: 'Sign out anyway',
+    stay: 'Stay signed in',
+    // Added in 18b.6, for the screens: a waiting command that is on its way to the server cannot
+    // be changed, and the server's orders cannot be read offline
+    busy: 'This change is being sent now. Try again in a moment.',
+    orderOffline: 'This order is on the server. Connect to the internet to open it.',
+    ordersOffline:
+      'The orders on the server need a connection. Drafts saved on this device are listed above.',
   },
   accounts: {
     title: 'Chart of accounts',
@@ -1627,6 +1719,8 @@ export const en = {
       over: 'Over the credit limit by {{amount}}',
       noLimit: 'No credit limit',
       cashOnly: 'Cash only: no credit',
+      // Offline: what the customer owes is on the server only
+      offline: 'Credit left needs a connection. It is checked when the order is confirmed.',
     },
     newInvoice: 'New invoice',
     recordPayment: 'Record payment',
@@ -4213,6 +4307,8 @@ export const en = {
       changes: 'Changes',
     },
     system: 'System',
+    // The line under the person's name when the change came from a device's outbox (step 18b)
+    fromDevice: '{{time}} · from {{device}}',
     noChanges: 'No field changed',
     emptyTitle: 'Nothing here yet',
     emptyBody:
@@ -5274,6 +5370,12 @@ export const en = {
     device_revoked:
       'This device was removed from the workspace and no longer syncs. Ask a workspace owner about it.',
     sync_protocol_mismatch: 'Omnivo was updated. Reload the page to keep syncing.',
+    sync_id_taken:
+      'Something on the server already has the id of this change. Discard it and enter it again.',
+    sync_command_invalid:
+      "The server can't read this change. Reload the page, and discard the change if it is still refused.",
+    sync_customer_gone:
+      'This customer was deleted, or is no longer a customer. Discard the change.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, taken from `en`, so a
  key missing in Bangla fails the type check. The `errors` object ends with `satisfies Record<ErrorCode, string>`,
  so the 3 codes of 18b.1 must be here, or the package does not compile.
- **Everything about the outbox goes into `sync`.** 18a said the sidebar status and the Sync page would come with
  18c; they came with 18b (decision 1), into the same section. `devices` stays the words about the device itself,
  which 18c fills with the device list.
- **The sidebar line.** `online` / `offline` is the state, and the count beside it is `waiting_*`, or
  `needsAttention_*` when at least one command was refused: a refused command is the one the person must act on, so
  it is the one the sidebar names. `allSynced` is the line with nothing waiting, and the screen-reader text of the
  link when there is no count. Each count takes `count` for the plural and `formatted` for the number in the page's
  language, like 18a's `firstPullCount`: `{{count}}` alone would print "3" in Bangla too.
- **`sync.commands` is shaped like `SYNC_COMMAND_TYPES`.** `customer.create` is `commands.customer.create`, and so
  on. i18next reads a dot in a key as a step into an object, so the app can write ``t(`sync.commands.${type}`, { name
  })`` and the type check knows every type has its words: a fourth command type added to the contracts later (the
  POS sale of step 20) fails the app's type check until it has them. The audit log does the same with
  `audit.actions`.
- **Each row of the Sync page says what the change is, and how big.** `changedFields` lists the fields of a change
  with the form's own labels (`customers.fields.*`), joined by the page's `Intl.ListFormat`, so the words match the
  boxes the person filled in. An order says its lines and its total (`orderLines_*`). `savedAt` is when it was saved
  on the device, not when it will be sent: that is what the person remembers.
- **Three pills, not four.** `statuses` are `waiting`, `sending` and `failed` ("Needs attention"). A command that
  waits for another one (decision 13) is `waiting` too, with the line `waitsFor` under it ("Waits for Rahman Traders to
  sync first"): it is not wrong, and a fourth colour for it would make the page look worse than it is.
- **Discard.** `discardBody` says that a discarded change never reaches the server and cannot be undone. When other
  commands need the one discarded (an order for a customer added offline), they go with it, and
  `discardDependents_*` says how many. An order for a customer the server never saw could only be refused.
- **The notices.** `keptFields` is the line under the customer's name in "Kept from the server": the head-office
  fields of decision 6 that the server kept (`kept_server_value`). "Not changed" is what happened to the person's
  change; the subtitle says why. `someKept` and `someFailed` are the toasts after a sync that point to the page, so
  a person at a counter who misses the toast still finds the page by the sidebar count.
- **The offline forms.** `saveOnDevice` replaces the form's save button offline (decision 2). `offlineNotice` and
  `orderOfflineNotice` are the document notice above the form; the order's notice says it is saved as a draft and must
  be confirmed online, so nobody promises a customer a confirmed order. `waitingNotice` is for a customer that has a
  waiting command while online: its change also goes to the outbox, and the person must know why the button says
  "Save on this device" with the Wi-Fi up. `codeOfflineHint` replaces `customers.fields.codeHint`: offline the next
  number is not known (decision 16), so the hint gives no example number.
- **`customers.credit.offline`** is the credit line under the customer box of an offline order. What the customer owes
  is only on the server, and the order is a draft, so the line says when the credit is checked.
- **`notSynced`** is the pill on a customer in the list that has a waiting create or change, and on an order in the
  part above the orders list (`unsyncedTitle`, `unsyncedSubtitle`, decision 3). Such an order has no number yet
  (`noNumberYet`): it gets one when it is confirmed online.
- **Signing out.** Signing out deletes the device's copy (18a, decision 41), and the outbox is in that copy. With
  waiting or refused commands, the app asks first: `signOutTitle` and `signOutBody_*` name what is lost, and the two
  buttons say what each does ("Sign out anyway", "Stay signed in").
- **Three keys came in while 18b.6's screens were built,** and are part of this diff: `busy` (a waiting
  command that is being sent right now cannot be changed; try again in a moment), `orderOffline` (an order of the
  server opened offline) and `ordersOffline` (the server's orders list offline, under the drafts saved on the
  device).
- **`audit.fromDevice`** is the line under the person's name in the audit log, after the time, when a change came
  through a device's outbox (decision 20): "Sep 23, 2026, 09:12 PM · from Counter 1".
- **The errors.** Each says what to do, because the Sync page shows it under the change and the person must act:
  - `sync_id_taken` and `sync_customer_gone` say to discard: the change cannot work any more, whatever the person
    fixes. `sync_customer_gone` is what a change to a customer deleted on the server meanwhile gets.
  - `sync_command_invalid` (the server does not know the command's type) says to reload first: the usual reason is
    an app older or newer than the server, and a reload loads the server's app. Only if it is still refused after
    that is the change lost.

### `locales/bn.ts`

```diff
@@ -93,6 +93,7 @@ export const bn: Messages = {
     debitNotes: 'ডেবিট নোট',
     supplierRefunds: 'সাপ্লায়ার রিফান্ড',
     approvals: 'অনুমোদন',
+    sync: 'সিঙ্ক',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -362,6 +363,83 @@ export const bn: Messages = {
     storageFailedTitle: 'এই ব্রাউজার ডেটা রাখতে পারছে না',
     storageFailedBody:
       'Omnivo তার কপি ব্রাউজারের স্টোরেজে রাখে। প্রাইভেট ব্রাউজিং থেকে বের হন বা ডিভাইসে কিছু জায়গা খালি করুন, তারপর পেজটা রিলোড করুন।',
+    online: 'অনলাইন',
+    offline: 'অফলাইন',
+    syncing: 'সিঙ্ক হচ্ছে…',
+    allSynced: 'সব পরিবর্তন সিঙ্ক হয়েছে',
+    waiting_one: '{{formatted}}টা পরিবর্তন অপেক্ষায়',
+    waiting_other: '{{formatted}}টা পরিবর্তন অপেক্ষায়',
+    needsAttention_one: '{{formatted}}টা পরিবর্তন দেখা দরকার',
+    needsAttention_other: '{{formatted}}টা পরিবর্তন দেখা দরকার',
+    title: 'সিঙ্ক',
+    description: 'এই ডিভাইসে সেভ করা কাজ, আর শেষবার কখন সেটা সার্ভারে পৌঁছেছে',
+    syncNow: 'এখনই সিঙ্ক করুন',
+    syncNowOffline: 'সিঙ্ক করতে ইন্টারনেটে যুক্ত হন।',
+    lastSynced: 'শেষ সিঙ্ক {{time}}',
+    neverSynced: 'এখনো সিঙ্ক হয়নি',
+    changesTitle: 'এই ডিভাইসের পরিবর্তন',
+    changesSubtitle: 'সংযোগ পেলেই সার্ভারে যায়, সবচেয়ে পুরনোটা আগে',
+    emptyTitle: 'সব সিঙ্ক হয়ে গেছে',
+    emptyBody: 'অফলাইনে সেভ করা গ্রাহক বা অর্ডার সার্ভারে না পৌঁছানো পর্যন্ত এখানে থাকে।',
+    commands: {
+      customer: {
+        create: 'নতুন গ্রাহক {{name}}',
+        update: '{{name}}-এর পরিবর্তন',
+      },
+      sales_order: {
+        create_draft: '{{name}}-এর খসড়া অর্ডার',
+      },
+    },
+    savedAt: 'সেভ হয়েছে {{time}}',
+    changedFields: 'বদলেছে: {{fields}}',
+    orderLines_one: '{{formatted}}টা লাইন · {{total}}',
+    orderLines_other: '{{formatted}}টা লাইন · {{total}}',
+    statuses: {
+      waiting: 'অপেক্ষায়',
+      sending: 'পাঠানো হচ্ছে',
+      failed: 'দেখা দরকার',
+    },
+    waitsFor: 'আগে {{name}} সিঙ্ক হওয়ার অপেক্ষায়',
+    fixHint: 'খুলুন, চিহ্নিত জায়গাগুলো ঠিক করুন, তারপর আবার সেভ করুন।',
+    edit: 'বদলান',
+    discard: 'বাদ দিন',
+    discardTitle: 'এই পরিবর্তন বাদ দেবেন?',
+    discardBody: 'এটা এই ডিভাইস থেকে মুছে যাবে, সার্ভারে কখনো পৌঁছাবে না। এটা আর ফেরানো যাবে না।',
+    discardDependents_one: 'এর ওপর নির্ভর করা {{formatted}}টা পরিবর্তনও বাদ যাবে।',
+    discardDependents_other: 'এর ওপর নির্ভর করা {{formatted}}টা পরিবর্তনও বাদ যাবে।',
+    discardConfirm: 'পরিবর্তন বাদ দিন',
+    discarded: 'পরিবর্তন বাদ দেওয়া হয়েছে',
+    noticesTitle: 'সার্ভারের মান রাখা হয়েছে',
+    noticesSubtitle: 'আপনি অফলাইনে থাকার সময় হেড অফিস এগুলো বদলেছে, তাই সেই মানই থাকল',
+    keptFields: 'বদলায়নি: {{fields}}',
+    dismiss: 'সরিয়ে দিন',
+    synced_one: '{{formatted}}টা পরিবর্তন সিঙ্ক হয়েছে',
+    synced_other: '{{formatted}}টা পরিবর্তন সিঙ্ক হয়েছে',
+    someFailed: 'কিছু পরিবর্তন দেখা দরকার। ঠিক করতে সিঙ্ক পেজ খুলুন।',
+    someKept: 'কিছু ঘরে সার্ভারের মানই থেকেছে। কোনগুলো, দেখতে সিঙ্ক পেজ খুলুন।',
+    saveOnDevice: 'এই ডিভাইসে সেভ করুন',
+    savedOnDevice: 'এই ডিভাইসে সেভ হয়েছে। সংযোগ ফিরলে সিঙ্ক হবে।',
+    saveFailed: 'এই ডিভাইসে সেভ করা যায়নি। কিছু জায়গা খালি করে আবার চেষ্টা করুন।',
+    offlineNotice: 'আপনি অফলাইনে। এটা এই ডিভাইসে সেভ হবে, সংযোগ ফিরলে সার্ভারে যাবে।',
+    orderOfflineNotice:
+      'আপনি অফলাইনে। অর্ডারটা এই ডিভাইসে খসড়া হিসেবে সেভ হবে। সিঙ্ক হওয়ার পর কনফার্ম করুন।',
+    waitingNotice:
+      'এই গ্রাহকের কিছু পরিবর্তন এই ডিভাইসে এখনো সিঙ্ক হয়নি, তাই এই পরিবর্তন সেগুলোর পরে সেভ হবে।',
+    codeOfflineHint: 'পরের নম্বরের জন্য খালি রাখুন। গ্রাহক সিঙ্ক হলে নম্বর দেওয়া হবে।',
+    notSynced: 'সিঙ্ক হয়নি',
+    noNumberYet: 'এখনো নম্বর নেই',
+    unsyncedTitle: 'এই ডিভাইসে · সিঙ্ক হয়নি',
+    unsyncedSubtitle: 'অফলাইনে সেভ করা খসড়া। সিঙ্ক হলে নিচের তালিকায় চলে যাবে।',
+    signOutTitle: 'সাইন আউট করে পরিবর্তনগুলো হারাবেন?',
+    signOutBody_one:
+      'এই ডিভাইসের {{formatted}}টা পরিবর্তন সিঙ্ক হয়নি। সাইন আউট করলে সেটা চিরতরে মুছে যাবে।',
+    signOutBody_other:
+      'এই ডিভাইসের {{formatted}}টা পরিবর্তন সিঙ্ক হয়নি। সাইন আউট করলে সেগুলো চিরতরে মুছে যাবে।',
+    signOutAnyway: 'তবুও সাইন আউট করুন',
+    stay: 'সাইন ইন থাকুন',
+    busy: 'এই পরিবর্তনটি এখন পাঠানো হচ্ছে। একটু পরে আবার চেষ্টা করুন।',
+    orderOffline: 'এই অর্ডারটি সার্ভারে আছে। খুলতে ইন্টারনেটে যুক্ত হোন।',
+    ordersOffline: 'সার্ভারের অর্ডার দেখতে সংযোগ লাগবে। এই ডিভাইসে সেভ করা খসড়াগুলো উপরে আছে।',
   },
   accounts: {
     title: 'চার্ট অফ অ্যাকাউন্টস',
@@ -1603,6 +1681,7 @@ export const bn: Messages = {
       over: 'ক্রেডিট লিমিটের চেয়ে {{amount}} বেশি',
       noLimit: 'ক্রেডিট লিমিট নেই',
       cashOnly: 'শুধু নগদ: কোনো ক্রেডিট নেই',
+      offline: 'বাকি ক্রেডিট দেখতে ইন্টারনেট সংযোগ লাগবে। অর্ডার কনফার্ম করার সময় এটা যাচাই হয়।',
     },
     newInvoice: 'নতুন ইনভয়েস',
     recordPayment: 'পেমেন্ট লিখুন',
@@ -4062,6 +4141,7 @@ export const bn: Messages = {
       changes: 'পরিবর্তন',
     },
     system: 'সিস্টেম',
+    fromDevice: '{{time}} · {{device}} থেকে',
     noChanges: 'কোনো ঘর বদলায়নি',
     emptyTitle: 'এখনো কিছু নেই',
     emptyBody: 'সেটিংস, ব্রাঞ্চ, নম্বরিং আর টিমের পরিবর্তন এখানে দেখা যাবে, কে করেছেন সহ।',
@@ -5098,6 +5178,10 @@ export const bn: Messages = {
     device_revoked:
       'এই ডিভাইসটা ওয়ার্কস্পেস থেকে সরানো হয়েছে, তাই আর সিঙ্ক হয় না। ওয়ার্কস্পেসের মালিককে জিজ্ঞেস করুন।',
     sync_protocol_mismatch: 'Omnivo আপডেট হয়েছে। সিঙ্ক চালু রাখতে পেজটা রিলোড করুন।',
+    sync_id_taken: 'সার্ভারে আরেকটা জিনিসের এই পরিবর্তনের আইডি আছে। এটা বাদ দিয়ে আবার লিখুন।',
+    sync_command_invalid:
+      'সার্ভার এই পরিবর্তনটা পড়তে পারছে না। পেজটা রিলোড করুন, তারপরও না নিলে পরিবর্তনটা বাদ দিন।',
+    sync_customer_gone: 'এই গ্রাহক মুছে ফেলা হয়েছে, বা আর গ্রাহক নেই। পরিবর্তনটা বাদ দিন।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. Office words stay as the app
  already writes them: সিঙ্ক, ডিভাইস, সার্ভার, আইডি (CLAUDE.md → Language).
- **"Draft" is খসড়া, as on the sales order pages,** and "confirm" is কনফার্ম, so the offline notice uses the same
  words as the buttons it talks about.
- **The `_one` and `_other` keys are the same text.** Bangla has one form for one and many, but i18next asks for
  both keys, because the English type has both.
- **`fromDevice` puts the device after its name** ("Counter 1 থেকে"), the Bangla word order, so the app passes the
  device's name as it is and adds nothing around it.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/app typecheck
```

Build `@omnivo/i18n` before you type-check the ui package and the app: they read its built types. The app's type
check still shows the one MSW error above (`src/mocks/workspace-data.ts`); 18b.7 fixes it.

> **What we checked in this part.** `packages/i18n` type-checks, ESLint and Prettier are clean, its unit tests pass
> (11), and it builds. `packages/ui` type-checks against the new build; `apps/app` has only the MSW error above. To
> be sure the two files cannot drift apart, we removed one key at a time on purpose: the Bangla
> `sync.commands.sales_order.create_draft` (the type check named it as missing in `bn.ts`) and the English error
> text `sync_customer_gone` (`en.ts` failed its `satisfies`, and `bn.ts` failed for a key that `en.ts` no longer
> has). Both came back after the keys were put back.

## 18b.6 — `packages/sync` and the app: the outbox

The API takes commands (18b.3); this part makes them on the device and sends them. It has two halves, like 18a.6:

- **`packages/sync`** keeps the outbox in the device's database, turns a saved form into a command (or folds it
  into the one already waiting), shows the outbox on top of the copy, starts a line's price from the copy, and
  pushes before every pull. Its tests run in Node with `fake-indexeddb`, as before.
- **The app** saves the customer form and the order form into the outbox offline, shows what waits (the
  customers list, the orders still on the device, the sidebar line, the Sync page), asks before a sign-out loses
  work, and names the device in the audit log.

No new dependency: `uuidv7` (the command ids) and Dexie are in `packages/sync` since 18a.

How a change travels, from the Save button to the server:

1. **The form decides where it saves** (`useSaveMode`, decision 2 and 36): online with nothing waiting for the
   customer, the API as before; otherwise the outbox. `saveCustomer()` / `saveOrderDraft()` write one entry in one
   IndexedDB transaction, and the form asks for a sync (`requestSync()`).
2. **The screens read the outbox at once.** Dexie's live reads see the new entry: the customers list shows the
   customer with "Not synced", the orders page lists the draft, the sidebar counts it.
3. **The engine syncs:** under the Web Lock, it pushes batch after batch (`takeBatch()` → `POST /sync/push` →
   `applyAnswers()`), then pulls. An accepted command leaves the outbox in the same transaction that writes the
   customer the server sent back; a refused one stays, with its error, for the Sync page.
4. **The session refreshes the screens and shows one toast** (decision 39).

The rule of 18a.6 still holds: the pages and the forms import nothing that loads Dexie. Everything they call
(`saveCustomer`, `customerPage`, `outboxEntries`) goes through the database object the session opened.

### `database.ts`: the outbox and its notices

```diff
@@ -1,6 +1,8 @@
 import type {
   Product,
   SyncCategory,
+  SyncCommand,
+  SyncCommandError,
   SyncCustomer,
   SyncCustomerGroup,
   SyncEntity,
@@ -33,6 +35,8 @@ export interface ProductRecord extends Stored<Product> {
   text: string;
   // Every barcode of the product: its variants' and its packs'. A barcode is matched whole.
   barcodes: string[];
+  // Its variants' ids (step 18b): the order form offline finds a line's product by its variant
+  variantIds: string[];
 }
 
 export interface CustomerRecord extends Stored<SyncCustomer> {
@@ -57,6 +61,52 @@ export interface PullState {
   copied: number;
 }
 
+// Step 18b: one thing the person did on this device, waiting to reach the server. The outbox is in
+// the same database as the copy, so signing out deletes both (the app asks first).
+export type OutboxStatus = 'waiting' | 'sending' | 'failed';
+
+export interface OutboxEntry {
+  // The order the person did things in: the push sends the outbox by seq, oldest first.
+  // Auto-increment, so it is missing until Dexie adds the row.
+  seq?: number;
+  // What the server gets, as the schema reads it (its output). Its own id is the command's id.
+  command: SyncCommand;
+  // waiting: not sent, or sent with no answer yet. sending: in the push that runs now.
+  // failed: the server refused it (error), so it never ran.
+  status: OutboxStatus;
+  // Sent at least once. A sent command with no answer may have run on the server (the answer was
+  // lost), so it is sent again as it is, and never rewritten (decision 33).
+  sent: boolean;
+  error: SyncCommandError | null;
+  // The customer the command is about: its own, or the order's. Two commands on one customer
+  // reach the server in the order they were made (decision 13).
+  customerId: string;
+  // The thing the command makes or changes: the customer, or the order. A form opens its
+  // waiting command by it.
+  key: string;
+  // A change to a customer: the customer as the person saw it when they started, so a second edit
+  // keeps the first `from` values. null for the other commands.
+  base: SyncCustomer | null;
+  // What the Sync page calls it: the customer's name
+  name: string;
+  // An order: its lines and total, for the Sync page and the unsynced orders. null otherwise.
+  lines: number | null;
+  total: string | null;
+  // When it was saved, by this device's clock: shown, never sent (decision 6)
+  savedAt: string;
+}
+
+// A head-office field the server kept (a kept_server_value notice), shown on the Sync page until
+// the person dismisses it. The command itself is gone: it was accepted.
+export interface SyncNoticeRecord {
+  commandId: string;
+  customerId: string;
+  name: string;
+  fields: string[];
+  // The server's time of the push that brought it
+  at: string;
+}
+
 // The tables, by entity. The names are the ones the app reads (db.products, db.customers).
 export const TABLE_OF = {
   settings: 'settings',
@@ -100,6 +150,8 @@ export class SyncDatabase extends Dexie {
   customers!: Table<CustomerRecord, string>;
   stock!: Table<Stored<SyncStock>, string>;
   meta!: Table<PullState, string>;
+  outbox!: Table<OutboxEntry, number>;
+  notices!: Table<SyncNoticeRecord, string>;
 
   constructor(name: string) {
     super(name);
@@ -122,6 +174,24 @@ export class SyncDatabase extends Dexie {
       stock: 'key, gen, data.warehouseId, data.variantId',
       meta: 'key',
     });
+    // Step 18b: the outbox and its notices, and the products by variant. The copy stays: Dexie
+    // keeps the tables of version 1, adds the new ones, and the upgrade fills the new field of the
+    // products it already has. `++seq` counts up by itself. `key` and `customerId` find a form's
+    // waiting command and the commands of one customer.
+    this.version(2)
+      .stores({
+        products: 'key, gen, sortName, sortCode, *barcodes, *variantIds',
+        outbox: '++seq, key, customerId',
+        notices: 'commandId',
+      })
+      .upgrade(async (tx) => {
+        await tx
+          .table<ProductRecord, string>('products')
+          .toCollection()
+          .modify((record) => {
+            record.variantIds = record.data.variants.map((variant) => variant.id);
+          });
+      });
   }
 
   // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
```

- **`OutboxEntry.command` is the schema's output** (`SyncCommand`), what the server reads. The server parses each
  command again (decision 11), and parsing an output gives the same output: every `''` is already `null`, a
  discount is already `"0"`. The spec checks this with `syncCommandSchema.parse(entry.command)` for each command
  type, so a later schema whose output does not parse again fails a test instead of every push.
- **`seq` is the primary key, counting up by itself (`++seq`).** The push sends by `seq`, which is the order the
  person did things in. The command's own id cannot be the key: a rewritten command gets a new id (decision 33),
  but it must keep its place.
- **`status` and `sent` are two fields, not one.** `waiting` covers "never sent" and "sent, no answer yet"; only
  `sent` tells them apart, and only the first may be rewritten. `sending` is the push in progress; `failed` is a
  refusal, with its `error`.
- **`customerId` on every entry, the order's too,** indexed. It is the one key the outbox needs: the push holds a
  command back while an earlier one on the same customer is still there (decision 13), discard takes a new
  customer's orders with it, and a form asks "does this customer have commands waiting?".
- **`key`** is what the entry makes or changes (the customer, or the order): the form that opens a waiting draft
  finds it by the order's id.
- **`base`** is the customer as the person saw it when they started a change. A second edit works its `from`
  values out from it again, never from the row a later pull wrote (decision 14 depends on `from` being what the
  person saw).
- **`name`, `lines`, `total`, `savedAt` are for the screens only.** The Sync page names a change without reading
  the customers table, and the draft's total is worked out once, when it is saved, not on every render.
- **`SyncNoticeRecord`** keeps a kept-head-office-field notice after its command is gone (it was accepted), until
  the person dismisses it on the Sync page.
- **`version(2)`** adds the two tables and the `*variantIds` index on products (decision 38). The upgrade fills the
  new field on the products the device already has, with `modify()` on every row, inside Dexie's upgrade
  transaction: a device on 18a's app keeps its copy and its cursor, and needs no full pull. `tx.table<ProductRecord,
  string>('products')` gives the row its type, so the callback needs no cast.

```diff
@@ -38,6 +38,7 @@ export function productRecord(key: string, gen: number, data: Product): ProductR
     sortCode: data.code.toLowerCase(),
     text: searchText([data.name, data.code, ...data.variants.map((variant) => variant.sku)]),
     barcodes: [...new Set(barcodes)],
+    variantIds: data.variants.map((variant) => variant.id),
   };
 }
 
```

`variantIds` is written with every product from now on, by the same function that writes `barcodes`.

### `overlay.ts`: a customer as the outbox will leave it

```ts
import type {
  CustomerAddress,
  CustomerAddressChanges,
  CustomerChanges,
  SyncCustomer,
  SyncCustomerInput,
} from '@omnivo/contracts';

import type { OutboxEntry } from './database.js';

// A customer as it will be once the outbox reaches the server (decision 34): the server's row on
// the device, with the waiting commands applied on top, in their order. The rows in the database
// are never changed: they stay the server's, and a pull keeps them right. Pure functions, so the
// specs check them without a database.

// The server's order: the billing address first, then the shipping ones as they were put.
// Array.prototype.sort is stable, so the shipping ones keep their order.
function billingFirst(addresses: CustomerAddress[]): CustomerAddress[] {
  return addresses.sort((a, b) => Number(b.kind === 'billing') - Number(a.kind === 'billing'));
}

// A customer.create as a row. The code is '' until the server gives the next number (decision
// 16); the version is 0, which no server row has.
export function createdCustomer(
  customerId: string,
  input: SyncCustomerInput,
  savedAt: string,
): SyncCustomer {
  return {
    id: customerId,
    code: input.code ?? '',
    name: input.name,
    groupId: input.groupId,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email,
    documentLanguage: input.documentLanguage,
    bin: input.bin,
    paymentTermsDays: input.paymentTermsDays,
    creditLimit: input.creditLimit,
    priceListId: input.priceListId,
    notes: input.notes,
    // In the order typed, not billing first: a refusal names an address of a new customer by its
    // place in the command (decision 22), and the form that opens it must have it in that place
    addresses: input.addresses.map((address) => ({
      id: address.id,
      kind: address.kind,
      label: address.label,
      address: address.address,
      phone: address.phone,
    })),
    isSupplier: false,
    archivedAt: null,
    version: 0,
    updatedAt: savedAt,
  };
}

// A changed field's new value, or the current one when the field did not change. `to` may be null
// (a phone taken away), so `??` would be wrong here.
function valueOf<T>(change: { to: T } | undefined, current: T): T {
  return change === undefined ? current : change.to;
}

function changedAddresses(
  current: readonly CustomerAddress[],
  changes: CustomerAddressChanges,
): CustomerAddress[] {
  const removed = new Set(changes.remove);
  const kept = current
    .filter((address) => !removed.has(address.id))
    .map((address) => {
      const change = changes.change.find((item) => item.id === address.id);
      if (!change) return address;
      // A field the change does not name is undefined; a label taken away is null
      return {
        id: address.id,
        kind: change.kind ?? address.kind,
        label: change.label === undefined ? address.label : change.label,
        address: change.address ?? address.address,
        phone: change.phone === undefined ? address.phone : change.phone,
      };
    });
  const added = changes.add.map((address) => ({
    id: address.id,
    kind: address.kind,
    label: address.label,
    address: address.address,
    phone: address.phone,
  }));
  return billingFirst([...kept, ...added]);
}

// A customer.update on a row. The code: an empty box keeps the code the customer has.
export function changedCustomer(
  row: SyncCustomer,
  changes: CustomerChanges,
  addresses: CustomerAddressChanges,
): SyncCustomer {
  return {
    ...row,
    code: valueOf(changes.code, row.code) ?? row.code,
    name: valueOf(changes.name, row.name),
    groupId: valueOf(changes.groupId, row.groupId),
    contactPerson: valueOf(changes.contactPerson, row.contactPerson),
    phone: valueOf(changes.phone, row.phone),
    email: valueOf(changes.email, row.email),
    documentLanguage: valueOf(changes.documentLanguage, row.documentLanguage),
    bin: valueOf(changes.bin, row.bin),
    paymentTermsDays: valueOf(changes.paymentTermsDays, row.paymentTermsDays),
    creditLimit: valueOf(changes.creditLimit, row.creditLimit),
    priceListId: valueOf(changes.priceListId, row.priceListId),
    notes: valueOf(changes.notes, row.notes),
    addresses: changedAddresses(row.addresses, addresses),
  };
}

// The row the screens show: `row` is the server's (null when the device does not have it), and
// `entries` the outbox in seq order; the ones of other customers and the orders are passed over.
// null = no such customer on this device.
export function projectCustomer(
  customerId: string,
  row: SyncCustomer | null,
  entries: readonly OutboxEntry[],
): SyncCustomer | null {
  let current = row;
  for (const entry of entries) {
    const { command } = entry;
    if (command.type === 'customer.create' && command.customerId === customerId) {
      current = createdCustomer(customerId, command.input, entry.savedAt);
    } else if (command.type === 'customer.update' && command.customerId === customerId) {
      // A change to a customer the device no longer has (archived on the server meanwhile): it
      // is still sent, and the server answers it (sync_customer_gone)
      if (current !== null) current = changedCustomer(current, command.changes, command.addresses);
    }
  }
  return current;
}
```

- **Pure functions, no database.** `projectCustomer()` takes the server's row (or none) and the outbox, and
  applies the customer's commands in order. The specs and the reads call the same code.
- **`createdCustomer()` gives a new customer the code `''` and the version 0.** The code comes from the server
  (decision 16), and no server row has version 0, so the app can tell "made on this device" from "changed on this
  device" without another field. The addresses keep the order they were typed in: a refusal names an address of a
  new customer by its place in the command (decision 22), and the form that opens it must have it in that place.
- **`valueOf(change, current)`, not `change?.to ?? current`.** A change may set a field to `null` (a phone taken
  away); `??` would put the old phone back on screen.
- **`code: valueOf(...) ?? row.code`.** An empty code box sends `null`; the customer still has a code, and the
  server keeps it.
- **An address change names only the fields that changed.** zod's `partial()` leaves the others `undefined`, so each
  field is read on its own; a label set to `null` is a real change, an `undefined` one is no change.
- **`changedAddresses()` puts the billing address first,** as the server sends them. `sort()` is stable, so the
  shipping addresses keep their order, and the first one stays the default on a delivery.
- **A change to a customer the device does not have** (archived on the server meanwhile) projects to nothing: the
  command is still sent, and the server answers it (`sync_customer_gone`).

### `outbox.ts`: saving, folding, discarding

```ts
import {
  compareMoney,
  type CustomerAddress,
  type CustomerAddressChanges,
  type CustomerChanges,
  type CustomerInput,
  type SalesOrderDraftInput,
  type SyncCommand,
  type SyncCustomer,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { OutboxEntry, SyncDatabase } from './database.js';

// Saving work done on the device as commands (step 18b), and the outbox's own changes: retry,
// discard. No Dexie import: everything goes through the database the session opened, so the
// forms that save here stay small (see index.ts).

// saved: in the outbox. unchanged: the form holds what the customer already has, so nothing is
// sent. busy: the command is on its way to the server, or was sent without an answer, so it
// cannot be changed now (decision 33).
export type SaveResult = 'saved' | 'unchanged' | 'busy';

// A command the server certainly never ran: it was refused, or never sent. Only these may be
// rewritten. A sent command without an answer may have run (the answer was lost), so it is sent
// again as it is, and a change after it is a command of its own.
export function isOpen(entry: OutboxEntry): boolean {
  return entry.status === 'failed' || (entry.status === 'waiting' && !entry.sent);
}

// ---------------------------------------------------------------------------------------------
// What changed

function sameMoney(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : compareMoney(a, b) === 0;
}

// Only the fields that differ from what the person started from (decision 6): `from` as the
// device had it, `to` as the form sends it. The credit limit compares as money: "200000" is the
// "200000.0000" the API sent, not a change.
export function customerChangesOf(base: SyncCustomer, input: CustomerInput): CustomerChanges {
  return {
    ...(input.code !== base.code && { code: { from: base.code, to: input.code } }),
    ...(input.name !== base.name && { name: { from: base.name, to: input.name } }),
    ...(input.groupId !== base.groupId && { groupId: { from: base.groupId, to: input.groupId } }),
    ...(input.contactPerson !== base.contactPerson && {
      contactPerson: { from: base.contactPerson, to: input.contactPerson },
    }),
    ...(input.phone !== base.phone && { phone: { from: base.phone, to: input.phone } }),
    ...(input.email !== base.email && { email: { from: base.email, to: input.email } }),
    ...(input.documentLanguage !== base.documentLanguage && {
      documentLanguage: { from: base.documentLanguage, to: input.documentLanguage },
    }),
    ...(input.bin !== base.bin && { bin: { from: base.bin, to: input.bin } }),
    ...(input.paymentTermsDays !== base.paymentTermsDays && {
      paymentTermsDays: { from: base.paymentTermsDays, to: input.paymentTermsDays },
    }),
    ...(!sameMoney(input.creditLimit, base.creditLimit) && {
      creditLimit: { from: base.creditLimit, to: input.creditLimit },
    }),
    ...(input.priceListId !== base.priceListId && {
      priceListId: { from: base.priceListId, to: input.priceListId },
    }),
    ...(input.notes !== base.notes && { notes: { from: base.notes, to: input.notes } }),
  };
}

// The addresses one by one, by id (decision 4). An address without an id, or with an id the base
// does not have (one this device added in an earlier, still waiting change), is added with that
// id; an address of the base that the form no longer has is removed.
export function addressChangesOf(
  base: readonly CustomerAddress[],
  input: CustomerInput['addresses'],
): CustomerAddressChanges {
  const before = new Map(base.map((address) => [address.id, address]));
  const kept = new Set<string>();
  const changes: CustomerAddressChanges = { add: [], remove: [], change: [] };
  for (const address of input) {
    const old = address.id === null ? undefined : before.get(address.id);
    if (!old) {
      changes.add.push({ ...address, id: address.id ?? uuidv7() });
      continue;
    }
    kept.add(old.id);
    const fields = {
      ...(address.kind !== old.kind && { kind: address.kind }),
      ...(address.label !== old.label && { label: address.label }),
      ...(address.address !== old.address && { address: address.address }),
      ...(address.phone !== old.phone && { phone: address.phone }),
    };
    if (Object.keys(fields).length > 0) changes.change.push({ id: old.id, ...fields });
  }
  changes.remove = base.filter((address) => !kept.has(address.id)).map((address) => address.id);
  return changes;
}

function nothingChanged(changes: CustomerChanges, addresses: CustomerAddressChanges): boolean {
  return (
    Object.keys(changes).length === 0 &&
    addresses.add.length === 0 &&
    addresses.remove.length === 0 &&
    addresses.change.length === 0
  );
}

// ---------------------------------------------------------------------------------------------
// Saving

export interface CustomerSave {
  // The customer the form started from, as the screens showed it (the server's row with the
  // waiting changes on it); null = a new customer
  base: SyncCustomer | null;
  input: CustomerInput;
  // This device's clock, for the Sync page only
  savedAt: string;
}

function createCommand(customerId: string, input: CustomerInput): SyncCommand {
  return {
    id: uuidv7(),
    type: 'customer.create',
    customerId,
    // Every address gets the device's id now: an order on this device may point at it
    input: {
      ...input,
      addresses: input.addresses.map((address) => ({ ...address, id: address.id ?? uuidv7() })),
    },
  };
}

function updateCommand(base: SyncCustomer, input: CustomerInput): SyncCommand | null {
  const changes = customerChangesOf(base, input);
  const addresses = addressChangesOf(base.addresses, input.addresses);
  if (nothingChanged(changes, addresses)) return null;
  return {
    id: uuidv7(),
    type: 'customer.update',
    customerId: base.id,
    baseVersion: base.version,
    changes,
    addresses,
  };
}

function entryOf(
  command: SyncCommand,
  fields: Pick<OutboxEntry, 'customerId' | 'key' | 'base' | 'name' | 'savedAt'> &
    Partial<Pick<OutboxEntry, 'lines' | 'total'>>,
): OutboxEntry {
  return {
    command,
    status: 'waiting',
    sent: false,
    error: null,
    lines: null,
    total: null,
    ...fields,
  };
}

// A new customer, or a change to one (decision 33). The customer's open commands (never sent, or
// refused) are folded into the first of them, which keeps its place in the outbox: an order on
// this device for a new customer stays behind that customer's create. The folded command gets a
// new id: a refused id is answered from what the server kept (decision 10).
export async function saveCustomer(db: SyncDatabase, save: CustomerSave): Promise<SaveResult> {
  const customerId = save.base?.id ?? uuidv7();
  return db.transaction('rw', db.outbox, async () => {
    const entries = await db.outbox.where('customerId').equals(customerId).sortBy('seq');
    const open = entries.filter(
      (entry) => entry.command.type !== 'sales_order.create_draft' && isOpen(entry),
    );
    const [first, ...rest] = open;
    if (first?.seq !== undefined) {
      // A create stays a create, with what the form holds now. A change is worked out again from
      // the first change's base, so its `from` values stay the ones the person first saw.
      const base = first.base ?? save.base;
      const command =
        first.command.type === 'customer.create'
          ? createCommand(customerId, save.input)
          : base && updateCommand(base, save.input);
      await db.outbox.bulkDelete(
        rest.flatMap((entry) => (entry.seq === undefined ? [] : [entry.seq])),
      );
      if (command === null) {
        // Changed back to what the customer has: nothing is left to send
        await db.outbox.delete(first.seq);
        return 'saved';
      }
      await db.outbox.put({
        ...entryOf(command, {
          customerId,
          key: customerId,
          base: first.base,
          name: save.input.name,
          savedAt: save.savedAt,
        }),
        seq: first.seq,
      });
      return 'saved';
    }
    if (save.base === null) {
      await db.outbox.add(
        entryOf(createCommand(customerId, save.input), {
          customerId,
          key: customerId,
          base: null,
          name: save.input.name,
          savedAt: save.savedAt,
        }),
      );
      return 'saved';
    }
    const command = updateCommand(save.base, save.input);
    if (command === null) return 'unchanged';
    await db.outbox.add(
      entryOf(command, {
        customerId,
        key: customerId,
        base: save.base,
        name: save.input.name,
        savedAt: save.savedAt,
      }),
    );
    return 'saved';
  });
}

export interface OrderSave {
  // A waiting order opened again; null = a new one
  orderId: string | null;
  input: SalesOrderDraftInput;
  // The customer's name and the order's total, for the Sync page and the unsynced orders
  name: string;
  total: string;
  savedAt: string;
}

// A draft order (decision 15). Saved again, it goes to the end of the outbox: an order needs
// nothing after it, and its customer may now be one added on this device after it.
export async function saveOrderDraft(db: SyncDatabase, save: OrderSave): Promise<SaveResult> {
  const orderId = save.orderId ?? uuidv7();
  return db.transaction('rw', db.outbox, async () => {
    const [entry] = await db.outbox.where('key').equals(orderId).toArray();
    if (entry && !isOpen(entry)) return 'busy';
    if (entry?.seq !== undefined) await db.outbox.delete(entry.seq);
    await db.outbox.add(
      entryOf(
        { id: uuidv7(), type: 'sales_order.create_draft', orderId, input: save.input },
        {
          customerId: save.input.customerId,
          key: orderId,
          base: null,
          name: save.name,
          savedAt: save.savedAt,
          lines: save.input.lines.length,
          total: save.total,
        },
      ),
    );
    return 'saved';
  });
}

// ---------------------------------------------------------------------------------------------
// The Sync page

// What goes with an entry when it is discarded: a new customer takes every later command on that
// customer (its changes and its orders), which the server could only refuse without it. A change
// or an order goes alone.
export function dependentsOf(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
  if (entry.command.type !== 'customer.create' || entry.seq === undefined) return [];
  const { seq } = entry;
  return entries.filter((other) => other.customerId === entry.customerId && (other.seq ?? 0) > seq);
}

// Discard: the entry and its dependents leave the device and never reach the server. A command
// being sent is left alone (busy); the page offers Discard again once it has its answer.
export async function discardEntry(db: SyncDatabase, seq: number): Promise<SaveResult> {
  return db.transaction('rw', db.outbox, async () => {
    const entry = await db.outbox.get(seq);
    if (!entry) return 'unchanged';
    if (entry.status === 'sending') return 'busy';
    const others = await db.outbox.where('customerId').equals(entry.customerId).toArray();
    const gone = [entry, ...dependentsOf(others, entry)].filter(
      (item) => item.status !== 'sending',
    );
    await db.outbox.bulkDelete(gone.flatMap((item) => (item.seq === undefined ? [] : [item.seq])));
    return 'saved';
  });
}

// Retry a refused command as it is, under a new id (the old id's refusal is kept on the server).
// For a refusal that was not the command's fault: a permission given back, a code freed.
export async function retryEntry(db: SyncDatabase, seq: number): Promise<SaveResult> {
  return db.transaction('rw', db.outbox, async () => {
    const entry = await db.outbox.get(seq);
    if (entry?.status !== 'failed') return 'unchanged';
    await db.outbox.put({
      ...entry,
      command: { ...entry.command, id: uuidv7() },
      status: 'waiting',
      sent: false,
      error: null,
    });
    return 'saved';
  });
}

export async function dismissNotice(db: SyncDatabase, commandId: string): Promise<void> {
  await db.notices.delete(commandId);
}
```

- **No Dexie import.** `db.transaction()`, `db.outbox.where()` are methods of the database object the session
  opened, so this file is safe in a form's chunk. `uuidv7` is about 1 KB.
- **`isOpen()` is decision 33 in one line:** refused, or never sent. Only an open command is rewritten.
- **`customerChangesOf()` sends only what differs from `base`** (decision 6). Each field is a conditional spread
  (`...(a !== b && { field: {from, to} })`): with `exactOptionalPropertyTypes`, a field set to `undefined` would not
  type-check, and a generic loop over the keys would need a cast.
- **The credit limit compares as money** (`sameMoney`). The API sends `"200000.0000"`; a person who types
  `200000` into the box changed nothing, and sending it would trigger a head-office check for no reason.
- **`addressChangesOf()`: an id the base does not have is an add, with that id.** An address added in an earlier
  waiting change shows in the form with its device id; folded into one change, it is still an add. An address
  without an id gets its UUIDv7 here, once.
- **`saveCustomer()` runs in one transaction on `outbox`.** The push marks commands `sending` in its own
  transaction on the same table; IndexedDB runs the two one after the other, so a form never rewrites a command
  the push has just taken.
- **The open commands fold into the first of them,** which keeps its `seq`. The rest are deleted. A create stays
  a create with what the form holds now; a change is worked out again from the first change's `base`, so its
  `from` values stay the ones the person first saw. Every fold gets a new command id.
- **Changed back to what the customer has: the entry goes.** `'saved'`, not `'unchanged'`: the person's intent
  ("the customer as it was") is now true.
- **`'unchanged'`** is a change with nothing in it and nothing waiting: no command is written at all.
- **`saveOrderDraft()` deletes and adds again,** so a saved-again order goes to the end of the outbox: its
  customer may now be one added on this device after it was first saved, and the push must meet that customer
  first. A draft that is sending, or was sent without an answer, is `'busy'`: a second `create_draft` with the
  same order id would be refused as `sync_id_taken` if the first one ran.
- **`dependentsOf()`: only a new customer has dependents** (every later entry on that customer). Without the
  customer, the server could only refuse them. A discarded change leaves the orders alone.
- **`retryEntry()` sends a refused command as it is, under a new id.** For a refusal that was not the command's
  fault: a permission given back, a code freed on the server.

### `push.ts`: one round of the push

```ts
import {
  MAX_PUSH_BYTES,
  MAX_PUSH_COMMANDS,
  type SyncPush,
  type SyncResult,
} from '@omnivo/contracts';

import { writeChanges } from './apply.js';
import type { OutboxEntry, SyncDatabase } from './database.js';
import { readPullState } from './state.js';

// The two halves of one push round (step 18b): which commands go now, and what their answers
// change on the device. The engine sends the request between them.

// What a push did, for the app's toasts
export interface PushOutcome {
  accepted: number;
  rejected: number;
  // Accepted, but the server kept some head-office fields (kept_server_value)
  kept: number;
}

export const NO_PUSH: PushOutcome = { accepted: 0, rejected: 0, kept: 0 };

const encoder = new TextEncoder();

// The commands to send now, oldest first (decision 13). A command waits while an earlier command
// on the same customer is still on the device: refused (it needs the person), or in this batch
// (it needs its answer first). So the order for a new customer goes in the push after the
// customer's, and two changes to one customer arrive in the order they were made. Commands on
// other customers go on. The batch stops at 50 commands or 512 KB of JSON; the first command
// always goes, so a big order is never stuck.
export function pickBatch(entries: readonly OutboxEntry[]): OutboxEntry[] {
  const held = new Set<string>();
  const batch: OutboxEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length === MAX_PUSH_COMMANDS) break;
    const free = entry.status === 'waiting' && !held.has(entry.customerId);
    held.add(entry.customerId);
    if (!free) continue;
    const size = encoder.encode(JSON.stringify(entry.command)).length;
    if (batch.length > 0 && bytes + size > MAX_PUSH_BYTES) break;
    bytes += size;
    batch.push(entry);
  }
  return batch;
}

// Takes the next batch and marks it as being sent, in one transaction: a form that opens one of
// these commands now sees that it cannot rewrite it (outbox.ts → isOpen). `sent` stays true from
// here on: the server may run it even if its answer never comes.
export async function takeBatch(db: SyncDatabase): Promise<OutboxEntry[]> {
  return db.transaction('rw', db.outbox, async () => {
    const batch = pickBatch(await db.outbox.toArray());
    const sending = batch.map((entry) => ({ ...entry, status: 'sending' as const, sent: true }));
    await db.outbox.bulkPut(sending);
    return sending;
  });
}

// The push failed as a whole (no connection, a server error): its commands wait for the next
// sync. They stay `sent`, so they go again as they are.
export async function releaseBatch(db: SyncDatabase, batch: readonly OutboxEntry[]): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    for (const entry of batch) {
      if (entry.seq !== undefined) await db.outbox.update(entry.seq, { status: 'waiting' });
    }
  });
}

// A tab closed in the middle of a push left its commands 'sending'. Called inside the sync lock,
// when no other tab pushes: whatever says 'sending' now is not being sent.
export async function resetSending(db: SyncDatabase): Promise<void> {
  await db.outbox.filter((entry) => entry.status === 'sending').modify({ status: 'waiting' });
}

// The answers, in one transaction with the rows they bring: an accepted command leaves the outbox
// in the same moment its customer is written, so a list never shows it twice or not at all. A
// refused one stays, with its error, until the person fixes or discards it (decision 7).
export async function applyAnswers(
  db: SyncDatabase,
  batch: readonly OutboxEntry[],
  answer: SyncPush,
): Promise<PushOutcome> {
  const results = new Map<string, SyncResult>(answer.results.map((result) => [result.id, result]));
  return db.transaction('rw', [...db.syncTables(), db.meta, db.outbox, db.notices], async () => {
    const { generation } = await readPullState(db);
    const outcome = { ...NO_PUSH };
    for (const entry of batch) {
      if (entry.seq === undefined) continue;
      const result = results.get(entry.command.id);
      if (!result) {
        // Not answered: the server stopped part way (it never does; the contract answers every
        // command). It is sent again.
        await db.outbox.update(entry.seq, { status: 'waiting' });
        continue;
      }
      if (result.status === 'rejected') {
        outcome.rejected += 1;
        await db.outbox.update(entry.seq, { status: 'failed', error: result.error });
        continue;
      }
      outcome.accepted += 1;
      // The rows as they are on the server now, at the generation of the running pull: a full
      // pull that is half way keeps them (apply.ts)
      await writeChanges(db, result.changes, generation);
      await db.outbox.delete(entry.seq);
      const kept = result.notices.filter((notice) => notice.code === 'kept_server_value');
      if (kept.length > 0) {
        outcome.kept += 1;
        await db.notices.put({
          commandId: entry.command.id,
          customerId: entry.customerId,
          name: entry.name,
          fields: kept.flatMap((notice) => notice.fields),
          at: answer.serverTime,
        });
      }
    }
    return outcome;
  });
}
```

- **`pickBatch()` is pure.** It walks the outbox in order and holds a customer as soon as it meets a command on
  it, whether that command is refused or goes in this batch. Commands on other customers go on (decision 7: only
  what needs the refused one waits). The spec checks both holds and the limits.
- **50 commands or 512 KB** (decision 9's limits from 18b.1). The size is the UTF-8 length (`TextEncoder`): a
  Bangla name is three bytes a letter, and `JSON.stringify().length` would count one. The first command always
  goes, so one big order cannot block the outbox for ever.
- **`takeBatch()` marks the batch `sending` and `sent` in the same transaction it reads it in.** From here, the
  forms see that these commands may run.
- **`releaseBatch()`**: the push failed as a whole (no connection, a 500). The commands wait again, still `sent`, so
  they go again as they are, and the server answers from what it kept if it ran them.
- **`resetSending()`** runs at the start of every push, inside the lock: a tab closed in the middle of a push left
  its commands `sending`, and while this tab holds the lock no other tab is sending anything.
- **`applyAnswers()` writes everything in one transaction:** the rows the server sent back (`writeChanges()`, at
  the running pull's generation, so a half-done full pull does not sweep them), the deleted entry, the refusal,
  the notices. A list never shows a new customer twice (the outbox's and the server's) or not at all.
- **A command without a result** goes back to waiting. The contract answers every command, so this is only a guard.
- **`kept_server_value` notices are kept** with the customer's name; the fields are listed in the server's order.

```diff
@@ -1,5 +1,6 @@
 import type {
   SyncCategory,
+  SyncChange,
   SyncCustomerGroup,
   SyncPriceList,
   SyncPriceListItem,
@@ -55,10 +56,10 @@ function emptyWrites(): Writes {
   };
 }
 
-function groupChanges(page: SyncPull, gen: number) {
+function groupChanges(changes: readonly SyncChange[], gen: number) {
   const puts = emptyWrites();
   const deletes = new Map<SyncTableName, string[]>();
-  for (const change of page.changes) {
+  for (const change of changes) {
     if (change.op === 'delete') {
       const table = TABLE_OF[change.entity];
       deletes.set(table, [...(deletes.get(table) ?? []), change.key]);
@@ -126,6 +127,29 @@ function nextState(state: PullState, page: SyncPull, sentCursor: string | null):
   };
 }
 
+// Rows into their tables, with the generation given. Called inside a transaction that holds every
+// synced table: a page of the pull (below), or the rows a push's answer sent back (push.ts).
+export async function writeChanges(
+  db: SyncDatabase,
+  changes: readonly SyncChange[],
+  gen: number,
+): Promise<void> {
+  const { puts, deletes } = groupChanges(changes, gen);
+  for (const [table, keys] of deletes) await db[table].bulkDelete(keys);
+  // A key is in a page at most once (the contract), so no row is both put and deleted here
+  await db.settings.bulkPut(puts.settings);
+  await db.units.bulkPut(puts.units);
+  await db.productCategories.bulkPut(puts.productCategories);
+  await db.taxRates.bulkPut(puts.taxRates);
+  await db.warehouses.bulkPut(puts.warehouses);
+  await db.priceLists.bulkPut(puts.priceLists);
+  await db.customerGroups.bulkPut(puts.customerGroups);
+  await db.products.bulkPut(puts.products);
+  await db.priceListItems.bulkPut(puts.priceListItems);
+  await db.customers.bulkPut(puts.customers);
+  await db.stock.bulkPut(puts.stock);
+}
+
 // One page into the database, in one transaction: the rows, the deletes and the cursor are
 // saved together or not at all. A tab closed half way through a page leaves the old cursor, and
 // the same page comes again; its upserts and deletes give the same result twice.
@@ -136,20 +160,7 @@ export async function applyPage(
 ): Promise<PullState> {
   return db.transaction('rw', [...db.syncTables(), db.meta], async () => {
     const state = nextState(await readPullState(db), page, sentCursor);
-    const { puts, deletes } = groupChanges(page, state.generation);
-    for (const [table, keys] of deletes) await db[table].bulkDelete(keys);
-    // A key is in a page at most once (the contract), so no row is both put and deleted here
-    await db.settings.bulkPut(puts.settings);
-    await db.units.bulkPut(puts.units);
-    await db.productCategories.bulkPut(puts.productCategories);
-    await db.taxRates.bulkPut(puts.taxRates);
-    await db.warehouses.bulkPut(puts.warehouses);
-    await db.priceLists.bulkPut(puts.priceLists);
-    await db.customerGroups.bulkPut(puts.customerGroups);
-    await db.products.bulkPut(puts.products);
-    await db.priceListItems.bulkPut(puts.priceListItems);
-    await db.customers.bulkPut(puts.customers);
-    await db.stock.bulkPut(puts.stock);
+    await writeChanges(db, page.changes, state.generation);
     // The last page of a full pull: every row it did not send is older than its generation, and
     // goes (decision 17). Until now, the lists kept showing them.
     if (page.full && !page.hasMore) {
```

`writeChanges()` is the body of `applyPage()` without the cursor and the sweep, so the push writes its rows with
the same code: one product can only go into `products`, as in 18a.

### `engine.ts`: a push before every pull

```diff
@@ -1,12 +1,26 @@
-import { SYNC_PROTOCOL, type SyncPull, type SyncPullQuery } from '@omnivo/contracts';
+import {
+  SYNC_PROTOCOL,
+  type SyncPull,
+  type SyncPullQuery,
+  type SyncPush,
+  type SyncPushInput,
+} from '@omnivo/contracts';
 import { Dexie } from 'dexie';
 
 import { applyPage } from './apply.js';
 import type { SyncDatabase } from './database.js';
 import { STORAGE_FAILED } from './problems.js';
+import {
+  applyAnswers,
+  NO_PUSH,
+  type PushOutcome,
+  releaseBatch,
+  resetSending,
+  takeBatch,
+} from './push.js';
 import { readPullState } from './state.js';
 
-// After these, pulling again cannot help until the page is reloaded (a new app version) or the
+// After these, syncing again cannot help until the page is reloaded (a new app version) or the
 // device is set up again
 const FINAL_PROBLEMS: ReadonlySet<string> = new Set([
   'sync_protocol_mismatch',
@@ -15,17 +29,17 @@ const FINAL_PROBLEMS: ReadonlySet<string> = new Set([
 ]);
 
 export interface SyncStatus {
-  // A pull is running in this tab
-  pulling: boolean;
-  // Why the last pull stopped, as an error code (network_error, storage_failed, …); null = the
+  // A sync is running in this tab: the outbox going up (step 18b), then the pull
+  syncing: boolean;
+  // Why the last sync stopped, as an error code (network_error, storage_failed, …); null = the
   // last pull finished
   problem: string | null;
-  // The engine pulls no more (decision 18's reload, a revoked device)
+  // The engine syncs no more (decision 18's reload, a revoked device)
   stopped: boolean;
 }
 
-// Runs fn while no other tab of this browser pulls into the same database. Two tabs pulling at
-// once would interleave their pages and cursors. Web Locks by default (like the token refresh in
+// Runs fn while no other tab of this browser syncs the same database. Two tabs pulling at once
+// would interleave their pages and cursors; two pushing at once would send one command twice. Web Locks by default (like the token refresh in
 // the app's api.ts); a test passes its own.
 export type LockRunner = (name: string, fn: () => Promise<void>) => Promise<void>;
 
@@ -38,6 +52,10 @@ export interface SyncEngineOptions {
   deviceId: string;
   // The app's API call (routes.sync.pull). The engine knows nothing of tokens or the API's url.
   pull: (query: SyncPullQuery) => Promise<SyncPull>;
+  // Step 18b: the app's call(routes.sync.push)
+  push: (input: SyncPushInput) => Promise<SyncPush>;
+  // After a push that sent something: the app refreshes what it shows, and says what happened
+  onPushed?: (outcome: PushOutcome) => void;
   // The error code of a failed call (the app's ApiRequestError.code), or null for anything else
   codeOf: (error: unknown) => string | null;
   // device_not_found: the server does not know this device (its database was restored from an
@@ -51,10 +69,11 @@ export interface SyncEngineOptions {
   lock?: LockRunner;
 }
 
-const IDLE: SyncStatus = { pulling: false, problem: null, stopped: false };
+const IDLE: SyncStatus = { syncing: false, problem: null, stopped: false };
 
-// The pull loop of one device: one pull at a time, each page applied before the next is asked
-// for. Framework-free; the app reads its status with useSyncExternalStore.
+// The sync loop of one device: one sync at a time. A sync sends the outbox first (step 18b), then
+// pulls page after page, each applied before the next is asked for. Framework-free; the app reads
+// its status with useSyncExternalStore.
 export class SyncEngine {
   private status: SyncStatus = IDLE;
   private readonly listeners = new Set<() => void>();
@@ -77,7 +96,7 @@ export class SyncEngine {
 
   getStatus = (): SyncStatus => this.status;
 
-  // A pull now, and on every wake-up: the connection coming back, the window getting the focus
+  // A sync now, and on every wake-up: the connection coming back, the window getting the focus
   // again, a tab coming back to the front, and every minute while online and in front
   start(): void {
     const wake = () => {
@@ -100,7 +119,7 @@ export class SyncEngine {
       window.removeEventListener('focus', wake);
       document.removeEventListener('visibilitychange', visible);
     };
-    void this.pullNow();
+    void this.syncNow();
   }
 
   // The session ended (sign-out, another workspace). A page being applied finishes; no more.
@@ -111,19 +130,20 @@ export class SyncEngine {
     if (this.debounce !== null) clearTimeout(this.debounce);
   }
 
-  // A pull soon: the focus and visibility events of one tab switch, and the saves of one form,
-  // come within milliseconds of each other and make one pull
+  // A sync soon: the focus and visibility events of one tab switch, and the saves of one form,
+  // come within milliseconds of each other and make one sync
   request(): void {
     if (this.debounce !== null) clearTimeout(this.debounce);
     this.debounce = setTimeout(() => {
       this.debounce = null;
-      void this.pullNow();
+      void this.syncNow();
     }, 300);
   }
 
-  // One pull at a time. Asked while one runs, it runs once more after it: the change that made
-  // someone ask may have committed after the running pull read its watermark.
-  pullNow(): Promise<void> {
+  // One sync at a time. Asked while one runs, it runs once more after it: the change that made
+  // someone ask may have committed after the running pull read its watermark, or a command may
+  // have been saved after the push read the outbox.
+  syncNow(): Promise<void> {
     if (this.ended || this.status.stopped) return Promise.resolve();
     if (this.running) {
       this.asks += 1;
@@ -144,30 +164,68 @@ export class SyncEngine {
   }
 
   private async runOnce(): Promise<void> {
-    this.set({ ...this.status, pulling: true });
+    this.set({ ...this.status, syncing: true });
     let problem: string | null = null;
     try {
       const lock = this.options.lock ?? webLock;
-      await lock(`omnivo-sync:${this.options.db.name}`, () => this.pullWithRetry());
+      await lock(`omnivo-sync:${this.options.db.name}`, async () => {
+        // The outbox first: the pull after it then brings what the commands changed, and a full
+        // pull's sweep never meets a customer that is only in the outbox
+        const outcome = await this.withRegistration(() => this.pushAll());
+        if (outcome.accepted + outcome.rejected > 0) this.options.onPushed?.(outcome);
+        await this.withRegistration(() => this.pullAll());
+      });
     } catch (error) {
       problem = this.problemOf(error);
     }
     if (this.ended) return;
     if (problem === 'device_revoked') this.options.onRevoked();
     this.set({
-      pulling: false,
+      syncing: false,
       problem,
       stopped: problem !== null && FINAL_PROBLEMS.has(problem),
     });
   }
 
-  private async pullWithRetry(): Promise<void> {
+  // device_not_found: register the same id again, and try once more
+  private async withRegistration<T>(run: () => Promise<T>): Promise<T> {
     try {
-      await this.pullAll();
+      return await run();
     } catch (error) {
       if (this.options.codeOf(error) !== 'device_not_found') throw error;
       await this.options.registerAgain();
-      await this.pullAll();
+      return run();
+    }
+  }
+
+  // Batch after batch until nothing more can go: each round takes the commands that are free now
+  // (push.ts), and an accepted customer frees the order that waited for it in the next round. A
+  // refused command is marked failed and is not taken again, so the loop always ends.
+  private async pushAll(): Promise<PushOutcome> {
+    const { db, deviceId } = this.options;
+    await resetSending(db);
+    const outcome = { ...NO_PUSH };
+    for (;;) {
+      if (this.ended) return outcome;
+      const batch = await takeBatch(db);
+      if (batch.length === 0) return outcome;
+      let answer: SyncPush;
+      try {
+        answer = await this.options.push({
+          deviceId,
+          protocol: SYNC_PROTOCOL,
+          commands: batch.map((entry) => entry.command),
+        });
+      } catch (error) {
+        await releaseBatch(db, batch);
+        throw error;
+      }
+      const round = await applyAnswers(db, batch, answer);
+      outcome.accepted += round.accepted;
+      outcome.rejected += round.rejected;
+      outcome.kept += round.kept;
+      // Nothing answered: the next round would send the same commands again
+      if (round.accepted + round.rejected === 0) return outcome;
     }
   }
 
```

- **`pulling` becomes `syncing`, `pullNow()` becomes `syncNow()`.** A run is now both halves, and the Sync page's
  button and the sidebar's "Syncing…" read it.
- **The push runs inside the same Web Lock as the pull.** Two tabs pushing at once would send one command twice;
  the server would answer the second from what it kept, but the device would apply the answer twice.
- **Push first, then pull** (decision 37). The pull after a push brings what the commands changed, and a full
  pull's sweep never meets a customer that is only in the outbox.
- **`withRegistration()`** is 18a's `pullWithRetry()` made generic: a `device_not_found` registers the same id again
  and tries once more, for the push too.
- **`pushAll()` loops until a round takes nothing.** An accepted customer frees its order in the next round; a
  refused command becomes `failed` and is not taken again; a round that answered nothing stops the loop, so it
  always ends.
- **`onPushed` is called once per run, after the push,** only when something was answered. The app refreshes and
  toasts from it; the engine knows nothing of either.
- The 18a spec changes only the names, and gives `engineWith()` a `push` that fails if it is ever called: its tests
  have an empty outbox.

### `prices.ts`: the price lookup on the device

```ts
import {
  type PriceLookupItem,
  priceListItemKey,
  type Product,
  startingPrice,
} from '@omnivo/contracts';

import type { SyncDatabase } from './database.js';

// The sales price lookup on the device (step 18b, decision 19): the same answer as
// POST /sales-prices/lookup, from the copy, for the order form without a connection.

// The products of some variants, by variant, with one index read (`*variantIds`)
export async function productsOfVariants(
  db: SyncDatabase,
  variantIds: readonly string[],
): Promise<Map<string, Product>> {
  const records = await db.products.where('variantIds').anyOf(variantIds).distinct().toArray();
  return new Map(
    records.flatMap((record) => record.variantIds.map((id) => [id, record.data] as const)),
  );
}

// priceListId: the customer's list, or null. Like the server: the list counts only while it is
// active (the device keeps the items of active lists only, 18a); a unit that is neither the
// product's base unit nor one of its packs drops out, like an unknown variant; the VAT rate is
// the product's own while it is active, else the workspace's default; no rate at all drops the
// item (a workspace whose rates are not made yet).
export async function lookUpPrices(
  db: SyncDatabase,
  priceListId: string | null,
  items: readonly { variantId: string; unitId: string }[],
): Promise<PriceLookupItem[]> {
  const list = priceListId === null ? undefined : await db.priceLists.get(priceListId);
  const activeList = list?.data.archivedAt === null ? list.data.id : null;
  const rates = (await db.taxRates.toArray()).map((record) => record.data);
  const defaultRate = rates.find((rate) => rate.isDefault);
  const products = await productsOfVariants(
    db,
    items.map((item) => item.variantId),
  );
  const found: PriceLookupItem[] = [];
  for (const item of items) {
    const product = products.get(item.variantId);
    const variant = product?.variants.find((one) => one.id === item.variantId);
    if (!product || !variant) continue;
    const factor =
      item.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === item.unitId)?.factor;
    if (factor === undefined) continue;
    const own = rates.find((rate) => rate.id === product.taxRateId && rate.archivedAt === null);
    const taxRateId = own?.id ?? defaultRate?.id;
    if (taxRateId === undefined) continue;
    const listItem =
      activeList === null
        ? undefined
        : await db.priceListItems.get(priceListItemKey({ priceListId: activeList, ...item }));
    found.push({
      ...item,
      ...startingPrice({
        listPrice: listItem?.data.price ?? null,
        salePrice: variant.salePrice,
        factor,
      }),
      taxRateId,
    });
  }
  return found;
}
```

- **The same rule as `PriceLookupService` (18b.3), from the copy:** `startingPrice()` for the price, the product's
  own active rate or the default for the VAT rate, and a unit that is neither the base unit nor a pack drops out.
  Decision 19 is why: a line starts at the same price online and offline.
- **The list counts only while it is active.** The device keeps the items of active lists only (18a), but the
  customer may still point at an archived list, so its row is read and checked.
- **`productsOfVariants()`** is one index read (`*variantIds`), with `distinct()`: two lines of one product would
  otherwise read it twice.
- **`priceListItemKey()`** is the key 18a stores a list price under, so the lookup is one `get()` per line.

### `queries.ts`, `index.ts`: the reads with the outbox on top

```diff
@@ -10,8 +10,16 @@ import {
 
 import type { Table } from 'dexie';
 
-import type { CustomerRecord, ProductRecord, Stored, SyncDatabase } from './database.js';
-import { customerMatches, needleOf, productMatches } from './records.js';
+import type {
+  CustomerRecord,
+  OutboxEntry,
+  ProductRecord,
+  Stored,
+  SyncDatabase,
+  SyncNoticeRecord,
+} from './database.js';
+import { projectCustomer } from './overlay.js';
+import { customerMatches, customerRecord, needleOf, productMatches } from './records.js';
 
 // The reads of the products and customers pages and of the pickers. Each is a plain async
 // function of the database, so the app runs it inside Dexie's liveQuery (useLiveQuery), and it
@@ -69,26 +77,79 @@ export interface LocalCustomerFilter {
   limit: number;
 }
 
+// The customers the outbox changes (step 18b, decision 34), as the screens show them: the
+// server's row with the waiting commands on top, or a customer made on this device. null = the
+// device does not have it (a change to a customer archived meanwhile). A handful at most: the
+// outbox of one person.
+async function pendingCustomers(db: SyncDatabase): Promise<Map<string, SyncCustomer | null>> {
+  const entries = await db.outbox.toArray();
+  const ids = new Set(
+    entries.flatMap((entry) =>
+      entry.command.type === 'sales_order.create_draft' ? [] : [entry.customerId],
+    ),
+  );
+  const pending = new Map<string, SyncCustomer | null>();
+  for (const id of ids) {
+    const row = await db.customers.get(id);
+    pending.set(id, projectCustomer(id, row?.data ?? null, entries));
+  }
+  return pending;
+}
+
+// The server's order: lower(name), then the id. Plain `<` compares strings by code unit, the
+// way IndexedDB orders its index.
+function byName(a: CustomerRecord, b: CustomerRecord): number {
+  if (a.sortName !== b.sortName) return a.sortName < b.sortName ? -1 : 1;
+  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
+}
+
+// `pending`: the ids the outbox changes, for the "Not synced" pill
+export interface LocalCustomerPage extends LocalPage<SyncCustomer> {
+  pending: ReadonlySet<string>;
+}
+
+// The walk of the index skips the customers the outbox changes, and their projected rows are put
+// back in their place. There are only a few, so the first `limit` of the two lists merged are the
+// first `limit` of all: every row past the walk's limit + 1 comes after all of them.
 export async function customerPage(
   db: SyncDatabase,
   filter: LocalCustomerFilter,
-): Promise<LocalPage<SyncCustomer>> {
+): Promise<LocalCustomerPage> {
   const needle = needleOf(filter.search);
+  const pending = await pendingCustomers(db);
+  const matches = (record: CustomerRecord) =>
+    (filter.groupId === '' || record.data.groupId === filter.groupId) &&
+    customerMatches(record, needle);
   const ordered = db.customers.orderBy('sortName');
-  const found = await (filter.sort === '-name' ? ordered.reverse() : ordered)
-    .filter(
-      (record: CustomerRecord) =>
-        (filter.groupId === '' || record.data.groupId === filter.groupId) &&
-        customerMatches(record, needle),
-    )
+  const walked = await (filter.sort === '-name' ? ordered.reverse() : ordered)
+    .filter((record: CustomerRecord) => !pending.has(record.key) && matches(record))
     .limit(filter.limit + 1)
     .toArray();
+  const projected = [...pending.values()]
+    .flatMap((row) => (row?.archivedAt !== null ? [] : [customerRecord(row.id, 0, row)]))
+    .filter(matches);
+  const direction = filter.sort === '-name' ? -1 : 1;
+  const found = [...walked, ...projected].sort((a, b) => direction * byName(a, b));
   return {
     rows: found.slice(0, filter.limit).map((record) => record.data),
     more: found.length > filter.limit,
+    pending: new Set(pending.keys()),
   };
 }
 
+// One customer as the screens show it: the server's row with the outbox on top (step 18b). null =
+// not on this device.
+export async function localCustomer(
+  db: SyncDatabase,
+  customerId: string,
+): Promise<SyncCustomer | null> {
+  const [row, entries] = await Promise.all([
+    db.customers.get(customerId),
+    db.outbox.where('customerId').equals(customerId).sortBy('seq'),
+  ]);
+  return projectCustomer(customerId, row?.data ?? null, entries);
+}
+
 // The pickers: the first 20 that match, by name, like the server's search
 export const PICKER_LIMIT = 20;
 
@@ -153,3 +214,35 @@ export function customerSummaryOf(customer: SyncCustomer): CustomerSummary {
     updatedAt: customer.updatedAt,
   };
 }
+
+// ---------------------------------------------------------------------------------------------
+// The outbox (step 18b)
+
+// Every waiting command, oldest first (the primary key is the seq)
+export function outboxEntries(db: SyncDatabase): Promise<OutboxEntry[]> {
+  return db.outbox.toArray();
+}
+
+// The commands of one customer or one order: a form opens its waiting command by its key, and a
+// customer with commands is changed through the outbox, even online (decision 2)
+export function outboxOf(db: SyncDatabase, key: string): Promise<OutboxEntry[]> {
+  return db.outbox.where('key').equals(key).sortBy('seq');
+}
+
+export function customerCommands(db: SyncDatabase, customerId: string): Promise<OutboxEntry[]> {
+  return db.outbox.where('customerId').equals(customerId).sortBy('seq');
+}
+
+// What the sidebar counts: every command on the device, and the refused ones among them
+export async function outboxCounts(db: SyncDatabase): Promise<{ total: number; failed: number }> {
+  const entries = await db.outbox.toArray();
+  return {
+    total: entries.length,
+    failed: entries.filter((entry) => entry.status === 'failed').length,
+  };
+}
+
+// The kept-from-the-server notices, newest first
+export async function syncNotices(db: SyncDatabase): Promise<SyncNoticeRecord[]> {
+  return (await db.notices.toArray()).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
+}
```

- **`pendingCustomers()`** projects every customer the outbox touches. The outbox of one person is a handful of
  commands, so this is a few reads.
- **`customerPage()` walks the index without them, then puts them back in their place** (decision 34). The walk
  takes `limit + 1` rows as in 18a; the projected rows are merged in and the whole is sorted by the server's order
  (`lower(name)`, then the id). The first `limit` rows of the merge are right: every row the walk did not reach
  comes after all the walked ones.
- **`byName()` compares with `<`,** by code unit, the way IndexedDB orders its index; `localeCompare()` would put a
  projected row in another place than the walk would.
- **`pending`** comes back with the page, for the "Not synced" pill.
- **`localCustomer()`** is one customer as the screens show it: the order form's customer box and the edit page.
- **The outbox reads** (`outboxEntries`, `outboxOf`, `customerCommands`, `outboxCounts`, `syncNotices`) are plain
  functions of the database, like the others, so the app runs them through `useLocalQuery`.

```diff
@@ -1,17 +1,21 @@
-// Two kinds of module. The pages of the app import the reads (queries, records, state, problems)
-// and the types: none of them loads Dexie at run time, so a page that searches customers stays
-// small. The code that opens the database and pulls (database, apply, engine, live, device)
-// brings Dexie, and the app loads it once, lazily, after sign-in. `sideEffects: false` in
+// Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
+// the outbox's saves (outbox, overlay, prices; step 18b) and the types: none of them loads Dexie
+// at run time, so a page that searches customers or a form that saves offline stays small. The
+// code that opens the database and syncs (database, apply, push, engine, live, device) brings
+// Dexie, and the app loads it once, lazily, after sign-in. `sideEffects: false` in
 // package.json lets the bundler leave out the modules a chunk does not use.
-export { applyPage } from './apply.js';
+export { applyPage, writeChanges } from './apply.js';
 export {
   type CustomerRecord,
   databaseName,
   deleteLocalDatabase,
+  type OutboxEntry,
+  type OutboxStatus,
   type ProductRecord,
   type PullState,
   type Stored,
   SyncDatabase,
+  type SyncNoticeRecord,
   type SyncTableName,
   TABLE_OF,
 } from './database.js';
@@ -25,21 +29,53 @@ export {
 } from './device.js';
 export { type LockRunner, SyncEngine, type SyncEngineOptions, type SyncStatus } from './engine.js';
 export { type Watch, watch } from './live.js';
+export {
+  addressChangesOf,
+  type CustomerSave,
+  customerChangesOf,
+  dependentsOf,
+  discardEntry,
+  dismissNotice,
+  isOpen,
+  type OrderSave,
+  retryEntry,
+  saveCustomer,
+  saveOrderDraft,
+  type SaveResult,
+} from './outbox.js';
+export { changedCustomer, createdCustomer, projectCustomer } from './overlay.js';
+export { lookUpPrices, productsOfVariants } from './prices.js';
 export { STORAGE_FAILED } from './problems.js';
+export {
+  applyAnswers,
+  NO_PUSH,
+  pickBatch,
+  type PushOutcome,
+  releaseBatch,
+  resetSending,
+  takeBatch,
+} from './push.js';
 export {
   allRows,
+  customerCommands,
   customerPage,
   customerSummaryOf,
   findCustomers,
   findProducts,
+  localCustomer,
   type LocalCustomerFilter,
+  type LocalCustomerPage,
   type LocalCustomerSort,
   type LocalPage,
   type LocalProductFilter,
   type LocalProductSort,
+  outboxCounts,
+  outboxEntries,
+  outboxOf,
   PICKER_LIMIT,
   productPage,
   productSummaryOf,
+  syncNotices,
 } from './queries.js';
 export { customerRecord, productRecord, searchText } from './records.js';
 export { NO_PULL, readPullState } from './state.js';
```

The comment at the top now lists the new Dexie-free files (`outbox`, `overlay`, `prices`). `push.ts` is on the
other side: the engine uses it, and the engine is only in the host's chunk.

### The tests

```diff
@@ -1,4 +1,11 @@
-import type { Product, SyncChange, SyncCustomer, SyncPull } from '@omnivo/contracts';
+import type {
+  CustomerInput,
+  Product,
+  SalesOrderDraftInput,
+  SyncChange,
+  SyncCustomer,
+  SyncPull,
+} from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
 
 import { SyncDatabase } from './database.js';
@@ -86,3 +93,76 @@ export function page(fields: Partial<SyncPull> & Pick<SyncPull, 'changes'>): Syn
     ...fields,
   };
 }
+
+// What the customer form sends (the schema's output): every empty box is null
+export function customerInput(
+  fields: Partial<CustomerInput> & Pick<CustomerInput, 'name'>,
+): CustomerInput {
+  return {
+    code: null,
+    groupId: null,
+    contactPerson: null,
+    phone: null,
+    email: null,
+    documentLanguage: 'en',
+    bin: null,
+    paymentTermsDays: 0,
+    creditLimit: null,
+    priceListId: null,
+    notes: null,
+    addresses: [],
+    ...fields,
+  };
+}
+
+// The form's values of a customer the device has: what a form opened on it sends unchanged
+export function inputOf(row: SyncCustomer): CustomerInput {
+  return {
+    code: row.code,
+    name: row.name,
+    groupId: row.groupId,
+    contactPerson: row.contactPerson,
+    phone: row.phone,
+    email: row.email,
+    documentLanguage: row.documentLanguage,
+    bin: row.bin,
+    paymentTermsDays: row.paymentTermsDays,
+    creditLimit: row.creditLimit,
+    priceListId: row.priceListId,
+    notes: row.notes,
+    addresses: row.addresses.map((address) => ({
+      id: address.id,
+      kind: address.kind === 'billing' ? 'billing' : 'shipping',
+      label: address.label,
+      address: address.address,
+      phone: address.phone,
+    })),
+  };
+}
+
+export const WAREHOUSE = '01928c4e-7777-7000-8000-000000000001';
+export const VAT_15 = '01928c4e-7777-7000-8000-000000000002';
+
+export function orderDraft(customerId: string, variantId: string): SalesOrderDraftInput {
+  return {
+    customerId,
+    date: '2026-10-21',
+    deliveryDate: null,
+    customerReference: null,
+    warehouseId: WAREHOUSE,
+    shippingAddressId: null,
+    note: null,
+    lines: [
+      {
+        variantId,
+        unitId: '01928c4e-0000-7000-8000-000000000001',
+        quantity: '12',
+        description: null,
+        unitPrice: '50',
+        discountType: 'percent',
+        discount: '0',
+        taxRateId: VAT_15,
+      },
+    ],
+  };
+}
```

`customerInput()` is what the customer form sends (the schema's output), `inputOf()` the same for a customer the
device has (a form opened and saved unchanged), and `orderDraft()` one order line of 12 at ৳50.

```ts
import 'fake-indexeddb/auto';

import { syncCommandSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import type { SyncDatabase } from './database.js';
import { discardEntry, retryEntry, saveCustomer, saveOrderDraft } from './outbox.js';
import { customer, customerInput, inputOf, newDatabase, orderDraft } from './test-fixtures.js';

const SAVED = '2026-10-21T15:00:00.000Z';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';

const rahman = customer({
  name: 'Rahman Traders',
  code: 'C-00042',
  phone: '01711-234567',
  creditLimit: '200000.0000',
  addresses: [
    {
      id: '01928c4e-9999-7000-8000-000000000001',
      kind: 'billing',
      label: null,
      address: 'House 12, Road 7, Uttara, Dhaka',
      phone: null,
    },
  ],
});

async function entries(db: SyncDatabase) {
  return db.outbox.toArray();
}

async function only(db: SyncDatabase) {
  const [entry, ...more] = await entries(db);
  expect(more).toEqual([]);
  if (!entry) throw new Error('the outbox is empty');
  return entry;
}

describe('saveCustomer', () => {
  it('saves a new customer as a create, with the device’s ids, that the server reads as it is', async () => {
    const db = newDatabase();
    const input = customerInput({
      name: 'Tasnim Pharmacy',
      addresses: [
        { id: null, kind: 'billing', label: null, address: 'Agrabad, Chattogram', phone: null },
      ],
    });
    expect(await saveCustomer(db, { base: null, input, savedAt: SAVED })).toBe('saved');
    const entry = await only(db);
    expect(entry).toMatchObject({ status: 'waiting', sent: false, name: 'Tasnim Pharmacy' });
    if (entry.command.type !== 'customer.create') throw new Error('not a create');
    expect(entry.key).toBe(entry.command.customerId);
    expect(entry.command.input.addresses[0]?.id).toMatch(/^[0-9a-f-]{14}7/);
    // The outbox keeps the schema's output; the server parses it again and gets the same command
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
  });

  it('sends only what changed, and a credit limit typed without decimals is no change', async () => {
    const db = newDatabase();
    const same = { ...inputOf(rahman), creditLimit: '200000' };
    expect(await saveCustomer(db, { base: rahman, input: same, savedAt: SAVED })).toBe('unchanged');
    expect(await entries(db)).toEqual([]);

    await saveCustomer(db, {
      base: rahman,
      input: { ...same, phone: '01819-000111' },
      savedAt: SAVED,
    });
    const entry = await only(db);
    if (entry.command.type !== 'customer.update') throw new Error('not an update');
    expect(entry.command.changes).toEqual({
      phone: { from: '01711-234567', to: '01819-000111' },
    });
    expect(entry.command.addresses).toEqual({ add: [], remove: [], change: [] });
    expect(entry.command.baseVersion).toBe(1);
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
  });

  it('folds a second edit into the waiting change, with the first `from`, under a new id', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    const first = await only(db);
    // The form opens on the customer with the change on it, and changes the limit too
    const shown = { ...rahman, phone: '01819-000111' };
    await saveCustomer(db, {
      base: shown,
      input: { ...inputOf(shown), creditLimit: '250000' },
      savedAt: SAVED,
    });
    const second = await only(db);
    expect(second.seq).toBe(first.seq);
    expect(second.command.id).not.toBe(first.command.id);
    if (second.command.type !== 'customer.update') throw new Error('not an update');
    expect(second.command.changes).toEqual({
      phone: { from: '01711-234567', to: '01819-000111' },
      creditLimit: { from: '200000.0000', to: '250000' },
    });

    // Changed back to what the server has: nothing is left to send
    await saveCustomer(db, { base: shown, input: inputOf(rahman), savedAt: SAVED });
    expect(await entries(db)).toEqual([]);
  });

  it('adds a new change after one that was sent without an answer', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    const sent = await only(db);
    if (sent.seq === undefined) throw new Error('no seq');
    // It may have run on the server: it is never rewritten
    await db.outbox.update(sent.seq, { sent: true });
    const shown = { ...rahman, phone: '01819-000111' };
    await saveCustomer(db, {
      base: shown,
      input: { ...inputOf(shown), name: 'Rahman Traders Ltd' },
      savedAt: SAVED,
    });
    const [kept, added] = await entries(db);
    expect(kept?.command).toEqual(sent.command);
    if (added?.command.type !== 'customer.update') throw new Error('not an update');
    expect(added.command.changes).toEqual({
      name: { from: 'Rahman Traders', to: 'Rahman Traders Ltd' },
    });
  });

  it('turns a refused create, fixed, into a waiting create with a new id', async () => {
    const db = newDatabase();
    const input = customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' });
    await saveCustomer(db, { base: null, input, savedAt: SAVED });
    const refused = await only(db);
    if (refused.seq === undefined || refused.command.type !== 'customer.create') {
      throw new Error('not a create');
    }
    await db.outbox.update(refused.seq, {
      status: 'failed',
      sent: true,
      error: { code: 'customer_code_taken' },
    });
    const shown = { ...customer({ name: 'Tasnim Pharmacy', code: 'C-00042' }), id: refused.key };
    await saveCustomer(db, {
      base: shown,
      input: { ...input, code: null },
      savedAt: SAVED,
    });
    const fixed = await only(db);
    expect(fixed).toMatchObject({ status: 'waiting', sent: false, error: null, seq: refused.seq });
    if (fixed.command.type !== 'customer.create') throw new Error('not a create');
    expect(fixed.command.id).not.toBe(refused.command.id);
    expect(fixed.command.customerId).toBe(refused.command.customerId);
    expect(fixed.command.input.code).toBeNull();
  });

  it('changes addresses one by one, by id', async () => {
    const db = newDatabase();
    const input = inputOf(rahman);
    await saveCustomer(db, {
      base: rahman,
      input: {
        ...input,
        addresses: [
          {
            id: null,
            kind: 'shipping',
            label: 'Mirpur depot',
            address: 'Mirpur 10, Dhaka',
            phone: null,
          },
        ],
      },
      savedAt: SAVED,
    });
    const entry = await only(db);
    if (entry.command.type !== 'customer.update') throw new Error('not an update');
    expect(entry.command.addresses.remove).toEqual([rahman.addresses[0]?.id]);
    expect(entry.command.addresses.change).toEqual([]);
    expect(entry.command.addresses.add).toMatchObject([
      { kind: 'shipping', label: 'Mirpur depot', address: 'Mirpur 10, Dhaka' },
    ]);
    expect(entry.command.addresses.add[0]?.id).toMatch(/^[0-9a-f-]{14}7/);

    await db.outbox.clear();
    await saveCustomer(db, {
      base: rahman,
      input: {
        ...input,
        addresses: input.addresses.map((address) => ({ ...address, label: 'Head office' })),
      },
      savedAt: SAVED,
    });
    const changed = await only(db);
    if (changed.command.type !== 'customer.update') throw new Error('not an update');
    expect(changed.command.addresses.change).toEqual([
      { id: rahman.addresses[0]?.id, label: 'Head office' },
    ]);
  });
});

describe('saveOrderDraft', () => {
  it('saves a draft, and a second save moves it to the end of the outbox', async () => {
    const db = newDatabase();
    const draft = orderDraft(rahman.id, VARIANT);
    await saveOrderDraft(db, {
      orderId: null,
      input: draft,
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const [order] = await entries(db);
    expect(order).toMatchObject({ customerId: rahman.id, lines: 1, total: '690' });
    if (order?.command.type !== 'sales_order.create_draft') throw new Error('not an order');
    expect(syncCommandSchema.parse(order.command)).toEqual(order.command);

    await saveOrderDraft(db, {
      orderId: order.key,
      input: { ...draft, note: 'Deliver before Friday' },
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    const [, moved] = await entries(db);
    expect(moved?.key).toBe(order.key);
    expect(moved?.command.id).not.toBe(order.command.id);
  });

  it('does not change an order that is being sent', async () => {
    const db = newDatabase();
    const draft = orderDraft(rahman.id, VARIANT);
    await saveOrderDraft(db, {
      orderId: null,
      input: draft,
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    const order = await only(db);
    if (order.seq === undefined) throw new Error('no seq');
    await db.outbox.update(order.seq, { status: 'sending', sent: true });
    expect(
      await saveOrderDraft(db, {
        orderId: order.key,
        input: draft,
        name: 'Rahman Traders',
        total: '690',
        savedAt: SAVED,
      }),
    ).toBe('busy');
  });
});

describe('discardEntry and retryEntry', () => {
  it('discards a new customer with the orders that need it, and a change alone', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const created = await only(db);
    await saveOrderDraft(db, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: null },
      savedAt: SAVED,
    });
    if (created.seq === undefined) throw new Error('no seq');
    expect(await discardEntry(db, created.seq)).toBe('saved');
    const left = await only(db);
    expect(left.customerId).toBe(rahman.id);
  });

  it('retries a refused command under a new id', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: null },
      savedAt: SAVED,
    });
    const entry = await only(db);
    if (entry.seq === undefined) throw new Error('no seq');
    expect(await retryEntry(db, entry.seq)).toBe('unchanged');
    await db.outbox.update(entry.seq, {
      status: 'failed',
      sent: true,
      error: { code: 'permission_missing' },
    });
    expect(await retryEntry(db, entry.seq)).toBe('saved');
    const again = await only(db);
    expect(again).toMatchObject({ status: 'waiting', sent: false, error: null });
    expect(again.command.id).not.toBe(entry.command.id);
  });
});
```

- Every command type is parsed again with `syncCommandSchema` (the output parses to itself).
- The fold test is decision 33: the second edit keeps seq and the first `from`, gets a new id, and changing back
  deletes the entry.
- "Adds a new change after one that was sent without an answer" is the rule that keeps a lost answer from
  turning into a lost change.

```ts
import 'fake-indexeddb/auto';

import type { SyncPush, SyncPushInput } from '@omnivo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxEntry } from './database.js';
import { SyncEngine } from './engine.js';
import { saveCustomer, saveOrderDraft } from './outbox.js';
import { pickBatch } from './push.js';
import {
  customer,
  customerInput,
  inputOf,
  newDatabase,
  orderDraft,
  page,
  upsertCustomer,
} from './test-fixtures.js';

const SAVED = '2026-10-21T15:00:00.000Z';
const SERVER = '2026-10-21T16:00:00.000Z';
const DEVICE = '01928c4e-1111-7000-8000-000000000001';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';

class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function entry(customerId: string, fields: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    command: {
      id: crypto.randomUUID(),
      type: 'customer.update',
      customerId,
      baseVersion: 1,
      changes: {},
      addresses: { add: [], remove: [], change: [] },
    },
    status: 'waiting',
    sent: false,
    error: null,
    customerId,
    key: customerId,
    base: null,
    name: 'Rahman Traders',
    lines: null,
    total: null,
    savedAt: SAVED,
    ...fields,
  };
}

describe('pickBatch', () => {
  it('holds a command behind a refused one or one in the batch on the same customer', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(
      (letter) => `01928c4e-2222-7000-8000-00000000000${letter}`,
    );
    if (a === undefined || b === undefined || c === undefined) throw new Error('ids');
    const refused = entry(a, { status: 'failed' });
    const behindRefused = entry(a);
    const first = entry(b);
    const behindFirst = entry(b);
    const other = entry(c);
    expect(pickBatch([refused, behindRefused, first, behindFirst, other])).toEqual([first, other]);
  });

  it('stops at 50 commands, and before a command that would pass 512 KB', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      entry(`01928c4e-3333-7000-8000-${String(index).padStart(12, '0')}`),
    );
    expect(pickBatch(many)).toHaveLength(50);
    const big = (id: string) =>
      entry(id, {
        command: {
          id: crypto.randomUUID(),
          type: 'customer.update',
          customerId: id,
          baseVersion: 1,
          changes: { notes: { from: null, to: 'x'.repeat(300 * 1024) } },
          addresses: { add: [], remove: [], change: [] },
        },
      });
    const one = big('01928c4e-4444-7000-8000-000000000001');
    const two = big('01928c4e-4444-7000-8000-000000000002');
    // The first always goes, even alone
    expect(pickBatch([one, two])).toEqual([one]);
  });
});

function engineWith(push: (input: SyncPushInput) => Promise<SyncPush>) {
  const db = newDatabase();
  const onPushed = vi.fn();
  const engine = new SyncEngine({
    db,
    deviceId: DEVICE,
    pull: () => Promise.resolve(page({ changes: [] })),
    push,
    onPushed,
    codeOf: (error) => (error instanceof CodedError ? error.code : null),
    registerAgain: () => Promise.resolve(),
    onRevoked: () => undefined,
  });
  return { db, engine, onPushed };
}

describe('SyncEngine push', () => {
  it('sends a new customer, writes its row, then sends its order in the next round', async () => {
    const sent: string[][] = [];
    const { db, engine, onPushed } = engineWith((input) => {
      sent.push(input.commands.map((command) => command.type));
      return Promise.resolve({
        serverTime: SERVER,
        results: input.commands.map((command) => {
          if (command.type !== 'customer.create') {
            return { id: command.id, status: 'accepted' as const, notices: [], changes: [] };
          }
          const id = String(command.customerId);
          return {
            id: command.id,
            status: 'accepted' as const,
            notices: [],
            changes: [upsertCustomer(customer({ id, name: 'Tasnim Pharmacy', code: 'C-00043' }))],
          };
        }),
      });
    });
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const [created] = await db.outbox.toArray();
    if (!created) throw new Error('no create');
    await saveOrderDraft(db, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(sent).toEqual([['customer.create'], ['sales_order.create_draft']]);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.customers.get(created.customerId))?.data.code).toBe('C-00043');
    expect(onPushed).toHaveBeenCalledWith({ accepted: 2, rejected: 0, kept: 0 });
    expect(engine.getStatus()).toEqual({ syncing: false, problem: null, stopped: false });
  });

  it('keeps a refused command with its error, and its order waits', async () => {
    const pushed = vi.fn((input: SyncPushInput) =>
      Promise.resolve<SyncPush>({
        serverTime: SERVER,
        results: input.commands.map((command) => ({
          id: command.id,
          status: 'rejected' as const,
          error: { code: 'customer_code_taken', fieldErrors: { code: ['customer_code_taken'] } },
        })),
      }),
    );
    const { db, engine } = engineWith(pushed);
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' }),
      savedAt: SAVED,
    });
    const [created] = await db.outbox.toArray();
    if (!created) throw new Error('no create');
    await saveOrderDraft(db, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(pushed).toHaveBeenCalledTimes(1);
    const [failed, order] = await db.outbox.toArray();
    expect(failed).toMatchObject({
      status: 'failed',
      sent: true,
      error: { code: 'customer_code_taken' },
    });
    expect(order).toMatchObject({ status: 'waiting', sent: false });
  });

  it('puts a batch back when the push fails, still marked as sent', async () => {
    const { db, engine } = engineWith(() => Promise.reject(new CodedError('network_error')));
    const rahman = customer({ name: 'Rahman Traders' });
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(engine.getStatus().problem).toBe('network_error');
    const [waiting] = await db.outbox.toArray();
    expect(waiting).toMatchObject({ status: 'waiting', sent: true });
  });

  it('keeps the notice of a head-office field the server kept', async () => {
    const rahman = customer({ name: 'Rahman Traders', creditLimit: '200000.0000' });
    const { db, engine, onPushed } = engineWith((input) =>
      Promise.resolve({
        serverTime: SERVER,
        results: input.commands.map((command) => ({
          id: command.id,
          status: 'accepted' as const,
          notices: [{ code: 'kept_server_value', fields: ['creditLimit'] }],
          changes: [upsertCustomer(rahman)],
        })),
      }),
    );
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), creditLimit: '500000' },
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(await db.notices.toArray()).toMatchObject([
      { name: 'Rahman Traders', fields: ['creditLimit'], at: SERVER },
    ]);
    expect(onPushed).toHaveBeenCalledWith({ accepted: 1, rejected: 0, kept: 1 });
  });

  it('sends a command left "sending" by a closed tab again', async () => {
    const pushed = vi.fn((input: SyncPushInput) =>
      Promise.resolve<SyncPush>({
        serverTime: SERVER,
        results: input.commands.map((command) => ({
          id: command.id,
          status: 'accepted' as const,
          notices: [],
          changes: [],
        })),
      }),
    );
    const { db, engine } = engineWith(pushed);
    const rahman = customer({ name: 'Rahman Traders' });
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    await db.outbox.toCollection().modify({ status: 'sending', sent: true });
    await engine.syncNow();
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(await db.outbox.count()).toBe(0);
  });
});
```

- The engine tests run a real push loop against a fake `push`: a new customer and its order go in two rounds,
  the customer's row from the answer is written, and `onPushed` gets the totals.
- "Keeps a refused command with its error, and its order waits": one push call only, the order still waiting.
- The size test uses a 300 KB note: two such commands do not fit in one batch, and the first goes alone.

```ts
import 'fake-indexeddb/auto';

import type { SyncChange, TaxRate } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import { lookUpPrices } from './prices.js';
import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';

const PCS = '01928c4e-0000-7000-8000-000000000001';
const CASE = '01928c4e-0000-7000-8000-000000000002';
const DOZEN = '01928c4e-0000-7000-8000-000000000003';
const LIST = '01928c4e-6666-7000-8000-000000000001';
const OLD_LIST = '01928c4e-6666-7000-8000-000000000002';
const VAT_15 = '01928c4e-6666-7000-8000-000000000003';
const VAT_5 = '01928c4e-6666-7000-8000-000000000004';
const UPDATED = '2026-10-21T04:00:00.000Z';

function rate(id: string, fields: Partial<TaxRate>): SyncChange {
  return {
    op: 'upsert',
    entity: 'tax_rate',
    key: id,
    data: {
      id,
      name: 'VAT 15%',
      kind: 'standard',
      rate: '15.00',
      isDefault: false,
      archivedAt: null,
      version: 1,
      updatedAt: UPDATED,
      ...fields,
    },
  };
}

function list(id: string, archivedAt: string | null): SyncChange {
  return {
    op: 'upsert',
    entity: 'price_list',
    key: id,
    data: {
      id,
      name: 'Dealer prices',
      description: null,
      archivedAt,
      version: 1,
      updatedAt: UPDATED,
    },
  };
}

const juice = product({
  name: 'Mango juice 250 ml',
  taxRateId: VAT_5,
  units: [{ unitId: CASE, factor: '24', barcode: null }],
});
const variant = juice.variants[0];
if (!variant) throw new Error('no variant');
const pricedJuice = { ...juice, variants: [{ ...variant, salePrice: '21.0000' }] };

function item(priceListId: string, unitId: string, price: string): SyncChange {
  const data = {
    priceListId,
    productId: juice.id,
    variantId: variant?.id ?? '',
    unitId,
    price,
    updatedAt: UPDATED,
  };
  return {
    op: 'upsert',
    entity: 'price_list_item',
    key: `${priceListId}:${data.variantId}:${unitId}`,
    data,
  };
}

async function loaded() {
  const db = newDatabase();
  await applyPage(
    db,
    page({
      full: true,
      changes: [
        rate(VAT_15, { isDefault: true }),
        rate(VAT_5, { name: 'VAT 5%', rate: '5.00' }),
        list(LIST, null),
        list(OLD_LIST, '2026-09-01T00:00:00.000Z'),
        upsertProduct(pricedJuice),
        item(LIST, CASE, '480.0000'),
        item(OLD_LIST, CASE, '450.0000'),
      ],
    }),
    null,
  );
  return db;
}

describe('lookUpPrices', () => {
  it('starts a line like the server: the price list, else the product price in the unit', async () => {
    const db = await loaded();
    const variantId = variant.id;
    expect(
      await lookUpPrices(db, LIST, [
        { variantId, unitId: CASE },
        { variantId, unitId: PCS },
      ]),
    ).toEqual([
      { variantId, unitId: CASE, price: '480.0000', source: 'price_list', taxRateId: VAT_5 },
      { variantId, unitId: PCS, price: '21.0000', source: 'product', taxRateId: VAT_5 },
    ]);
    // An archived list counts for nothing: a case is 24 × ৳21
    expect(await lookUpPrices(db, OLD_LIST, [{ variantId, unitId: CASE }])).toEqual([
      { variantId, unitId: CASE, price: '504.0000', source: 'product', taxRateId: VAT_5 },
    ]);
    // A unit the product does not have drops out, like on the server
    expect(await lookUpPrices(db, null, [{ variantId, unitId: DOZEN }])).toEqual([]);
  });

  it('falls back to the default rate when the product’s own is archived', async () => {
    const db = await loaded();
    await applyPage(
      db,
      page({ changes: [rate(VAT_5, { archivedAt: '2026-10-01T00:00:00.000Z' })] }),
      'cursor',
    );
    const [found] = await lookUpPrices(db, null, [{ variantId: variant.id, unitId: PCS }]);
    expect(found?.taxRateId).toBe(VAT_15);
  });
});
```

```ts
import 'fake-indexeddb/auto';

import { Dexie } from 'dexie';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import { SyncDatabase } from './database.js';
import { productRecord } from './records.js';
import { product } from './test-fixtures.js';

describe('SyncDatabase version 2', () => {
  it('keeps the copy of version 1 and gives its products their variant ids', async () => {
    const name = `test-${uuidv7()}`;
    const shirt = product({ name: 'Polo shirt' });
    // A device on 18a's app: version 1, products without variantIds
    const old = new Dexie(name);
    old.version(1).stores({ products: 'key, gen, sortName, sortCode, *barcodes' });
    const full = productRecord(shirt.id, 1, shirt);
    await old.table('products').put({
      key: full.key,
      gen: full.gen,
      data: full.data,
      sortName: full.sortName,
      sortCode: full.sortCode,
      text: full.text,
      barcodes: full.barcodes,
    });
    old.close();

    const db = new SyncDatabase(name);
    const variantId = shirt.variants[0]?.id ?? '';
    expect((await db.products.get(shirt.id))?.variantIds).toEqual([variantId]);
    expect(await db.products.where('variantIds').equals(variantId).count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });
});
```

The price spec checks the three sources (list, product × factor, none) and the archived rate falling back to the
default. The database spec opens a version 1 database with a product in it, then opens it as `SyncDatabase`: the
product has its `variantIds`, and the index finds it.

```diff
@@ -3,16 +3,20 @@ import 'fake-indexeddb/auto';
 import { describe, expect, it } from 'vitest';
 
 import { applyPage } from './apply.js';
+import { saveCustomer } from './outbox.js';
 import {
   customerPage,
   customerSummaryOf,
   findCustomers,
   findProducts,
+  localCustomer,
   productPage,
   productSummaryOf,
 } from './queries.js';
 import {
   customer,
+  customerInput,
+  inputOf,
   newDatabase,
   page,
   product,
@@ -176,3 +180,60 @@ describe('customerPage', () => {
     expect(first && customerSummaryOf(first).balance).toBeNull();
   });
 });
+
+describe('the outbox on top of the copy', () => {
+  const SAVED = '2026-10-21T15:00:00.000Z';
+
+  it('shows a customer made on the device in its place, and a renamed one in its new place', async () => {
+    const db = await loaded();
+    await saveCustomer(db, {
+      base: null,
+      input: customerInput({ name: 'Chowdhury Medicine Corner' }),
+      savedAt: SAVED,
+    });
+    const all = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 10 });
+    expect(names(all.rows)).toEqual([
+      'Anwar Pharmacy',
+      'Bismillah Store',
+      'Chowdhury Medicine Corner',
+      'Rahman Traders',
+    ]);
+    const made = all.rows.find((row) => row.name === 'Chowdhury Medicine Corner');
+    expect(made).toMatchObject({ code: '', version: 0 });
+    expect(made && all.pending.has(made.id)).toBe(true);
+    expect(names(await findCustomers(db, 'chowdhury'))).toEqual(['Chowdhury Medicine Corner']);
+
+    const anwar = all.rows.find((row) => row.name === 'Anwar Pharmacy');
+    if (!anwar) throw new Error('no Anwar');
+    await saveCustomer(db, {
+      base: anwar,
+      input: { ...inputOf(anwar), name: 'Zaman Pharmacy' },
+      savedAt: SAVED,
+    });
+    const after = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 10 });
+    expect(names(after.rows).at(-1)).toBe('Zaman Pharmacy');
+    // The server's row in the database is unchanged; only the screens see the change
+    expect((await db.customers.get(anwar.id))?.data.name).toBe('Anwar Pharmacy');
+    expect((await localCustomer(db, anwar.id))?.name).toBe('Zaman Pharmacy');
+  });
+
+  it('keeps the page size and says there is more with the outbox merged in', async () => {
+    const db = await loaded();
+    await saveCustomer(db, {
+      base: null,
+      input: customerInput({ name: 'Aarong Dairy Depot' }),
+      savedAt: SAVED,
+    });
+    const first = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 2 });
+    expect(names(first.rows)).toEqual(['Aarong Dairy Depot', 'Anwar Pharmacy']);
+    expect(first.more).toBe(true);
+    const last = await customerPage(db, { search: '', groupId: '', sort: '-name', limit: 4 });
+    expect(names(last.rows)).toEqual([
+      'Rahman Traders',
+      'Bismillah Store',
+      'Anwar Pharmacy',
+      'Aarong Dairy Depot',
+    ]);
+    expect(last.more).toBe(false);
+  });
+});
```

```diff
@@ -26,6 +26,8 @@ function engineWith(
     db,
     deviceId: DEVICE,
     pull,
+    // Nothing in the outbox: the 18a tests never push
+    push: () => Promise.reject(new Error('no push expected')),
     codeOf,
     registerAgain: () => Promise.resolve(),
     onRevoked: () => undefined,
@@ -54,15 +56,15 @@ describe('SyncEngine', () => {
       Promise.resolve(pages.shift() ?? page({ changes: [] })),
     );
     const { db, engine } = engineWith(pull);
-    await engine.pullNow();
+    await engine.syncNow();
     expect(pull.mock.calls.map(([query]) => query.cursor)).toEqual([undefined, 'a']);
     expect(pull.mock.calls[0]?.[0]).toMatchObject({ deviceId: DEVICE, protocol: 1, limit: 500 });
     expect(await db.products.count()).toBe(2);
     expect((await readPullState(db)).cursor).toBe('b');
     // The next pull starts from the saved cursor
-    await engine.pullNow();
+    await engine.syncNow();
     expect(pull.mock.calls.at(-1)?.[0].cursor).toBe('b');
-    expect(engine.getStatus()).toEqual({ pulling: false, problem: null, stopped: false });
+    expect(engine.getStatus()).toEqual({ syncing: false, problem: null, stopped: false });
   });
 
   it('runs one pull at a time, and once more when asked during one', async () => {
@@ -76,9 +78,9 @@ describe('SyncEngine', () => {
         }),
     );
     const { engine } = engineWith(pull);
-    const first = engine.pullNow();
-    const second = engine.pullNow();
-    const third = engine.pullNow();
+    const first = engine.syncNow();
+    const second = engine.syncNow();
+    const third = engine.syncNow();
     expect(second).toBe(first);
     expect(third).toBe(first);
     await vi.waitFor(() => {
@@ -101,7 +103,7 @@ describe('SyncEngine', () => {
       .mockResolvedValueOnce(page({ changes: [] }));
     const registerAgain = vi.fn(() => Promise.resolve());
     const { engine } = engineWith(pull, { registerAgain });
-    await engine.pullNow();
+    await engine.syncNow();
     expect(registerAgain).toHaveBeenCalledTimes(1);
     expect(pull).toHaveBeenCalledTimes(2);
     expect(engine.getStatus().problem).toBeNull();
@@ -111,21 +113,21 @@ describe('SyncEngine', () => {
     const pull = vi.fn(() => Promise.reject(new CodedError('device_revoked')));
     const onRevoked = vi.fn();
     const { engine } = engineWith(pull, { onRevoked });
-    await engine.pullNow();
+    await engine.syncNow();
     expect(onRevoked).toHaveBeenCalledTimes(1);
     expect(engine.getStatus()).toEqual({
-      pulling: false,
+      syncing: false,
       problem: 'device_revoked',
       stopped: true,
     });
-    await engine.pullNow();
+    await engine.syncNow();
     expect(pull).toHaveBeenCalledTimes(1);
   });
 
   it('stops on sync_protocol_mismatch: only a reload helps', async () => {
     const pull = vi.fn(() => Promise.reject(new CodedError('sync_protocol_mismatch')));
     const { engine } = engineWith(pull);
-    await engine.pullNow();
+    await engine.syncNow();
     expect(engine.getStatus()).toMatchObject({ problem: 'sync_protocol_mismatch', stopped: true });
   });
 
@@ -143,22 +145,22 @@ describe('SyncEngine', () => {
       .mockRejectedValueOnce(new CodedError('network_error'))
       .mockResolvedValueOnce(page({ full: true, cursor: 'b', changes: [] }));
     const { db, engine } = engineWith(pull);
-    await engine.pullNow();
+    await engine.syncNow();
     expect(engine.getStatus()).toEqual({
-      pulling: false,
+      syncing: false,
       problem: 'network_error',
       stopped: false,
     });
     // The first page is saved with its cursor, so the next pull goes on from there
     expect(await db.products.count()).toBe(1);
-    await engine.pullNow();
+    await engine.syncNow();
     expect(pull.mock.calls.at(-1)?.[0].cursor).toBe('a');
     expect(engine.getStatus().problem).toBeNull();
   });
 
   it('an error that is not the API’s is unknown_error', async () => {
     const { engine } = engineWith(() => Promise.reject(new TypeError('boom')));
-    await engine.pullNow();
+    await engine.syncNow();
     expect(engine.getStatus().problem).toBe('unknown_error');
   });
 
@@ -166,7 +168,7 @@ describe('SyncEngine', () => {
     const pull = vi.fn(() => Promise.resolve(page({ changes: [] })));
     const { engine } = engineWith(pull);
     engine.stop();
-    await engine.pullNow();
+    await engine.syncNow();
     expect(pull).not.toHaveBeenCalled();
   });
 
@@ -174,11 +176,11 @@ describe('SyncEngine', () => {
     const { engine } = engineWith(() => Promise.resolve(page({ changes: [] })));
     const seen: boolean[] = [];
     const unsubscribe = engine.subscribe(() => {
-      seen.push(engine.getStatus().pulling);
+      seen.push(engine.getStatus().syncing);
     });
-    await engine.pullNow();
+    await engine.syncNow();
     unsubscribe();
-    await engine.pullNow();
+    await engine.syncNow();
     expect(seen).toEqual([true, false]);
   });
 });
```

The overlay tests put a customer made on the device in its place by name, move a renamed customer to its new
place, check that the server's row in the table is untouched, and check `limit` and `more` with the outbox merged
in, in both directions.

### `apps/app`: the store, the session, the queries

```diff
@@ -1,5 +1,6 @@
 import type { Branch } from '@omnivo/contracts';
 import {
+  customerCommands,
   readPullState,
   STORAGE_FAILED,
   type SyncDatabase,
@@ -7,7 +8,7 @@ import {
   type SyncStatus,
   type Watch,
 } from '@omnivo/sync';
-import { useEffect, useState, useSyncExternalStore } from 'react';
+import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
 import { useStore } from 'zustand';
 import { createStore } from 'zustand/vanilla';
 
@@ -56,6 +57,18 @@ export function useDeviceState(): DeviceState {
   return useStore(localDataStore, (state) => state.device);
 }
 
+// Step 18b: a sync soon, after a save into the outbox (the engine waits 300 ms for more)
+export function requestSync(): void {
+  const { device } = localDataStore.getState();
+  if (device.kind === 'ready') device.engine.request();
+}
+
+// The device's database, when it has one open: the outbox is in it
+export function useLocalDb(): SyncDatabase | null {
+  const device = useDeviceState();
+  return device.kind === 'ready' ? device.db : null;
+}
+
 // A read of the copy that runs again by itself when a pull changes what it read. `query` must be
 // stable (useCallback): a new function is a new read. null = nothing to read (the archived tab).
 // While a new read runs, the last answer stays, so a list does not flash empty on each key press.
@@ -99,18 +112,21 @@ const NOTICES: ReadonlySet<string> = new Set([
   'device_branch_invalid',
 ]);
 
-const NO_STATUS: SyncStatus = { pulling: false, problem: null, stopped: false };
+const NO_STATUS: SyncStatus = { syncing: false, problem: null, stopped: false };
 const noSubscribe = () => () => undefined;
 const noStatus = () => NO_STATUS;
 
+// The engine's status (syncing, its problem), for the sidebar and the Sync page
+export function useSyncStatus(): SyncStatus {
+  const device = useDeviceState();
+  const engine = device.kind === 'ready' ? device.engine : null;
+  return useSyncExternalStore(engine?.subscribe ?? noSubscribe, engine?.getStatus ?? noStatus);
+}
+
 export function useLocalData(): { view: LocalView; notice: string | null } {
   const device = useDeviceState();
   const online = useOnline();
-  const engine = device.kind === 'ready' ? device.engine : null;
-  const status = useSyncExternalStore(
-    engine?.subscribe ?? noSubscribe,
-    engine?.getStatus ?? noStatus,
-  );
+  const status = useSyncStatus();
   // Live: the first pull's count and its end show here as the pages arrive
   const pull = useLocalQuery(readPullState);
   const notice = status.problem !== null && NOTICES.has(status.problem) ? status.problem : null;
@@ -142,3 +158,24 @@ function viewOf(
       return online ? { kind: 'first-pull-failed' } : { kind: 'offline-empty' };
   }
 }
+
+// Where a customer form or an order form saves (decision 2): through the API online, into the
+// outbox offline, and into the outbox online too while the customer has commands waiting, so
+// its changes reach the server in the order they were made. '' = no customer (yet).
+// undefined while the device's answer is not read yet: the form waits for it.
+export type SaveMode = 'api' | 'device';
+
+export function useSaveMode(customerId: string): SaveMode | undefined {
+  const online = useOnline();
+  const db = useLocalDb();
+  const read = useCallback(
+    (database: SyncDatabase) =>
+      customerId === '' ? Promise.resolve([]) : customerCommands(database, customerId),
+    [customerId],
+  );
+  const commands = useLocalQuery(db ? read : null);
+  if (!online) return 'device';
+  if (!db) return 'api';
+  if (commands === undefined) return undefined;
+  return commands.length > 0 ? 'device' : 'api';
+}
```

- **`requestSync()`** asks the engine for a sync after a save into the outbox. The engine waits 300 ms (18a), so
  a form that saves twice makes one sync.
- **`useSyncStatus()`** is 18a's engine status read, moved into a hook of its own for the Sync page; `useLocalData()`
  uses it too.
- **`useSaveMode(customerId)`** is decision 2 and 36 in one place: offline, the device; online with a database and
  commands waiting for this customer, the device; else the API. `undefined` while the outbox is being read, so a
  form does not open in one mode and jump to the other a frame later. A customer id of `''` (a new customer, or no
  customer chosen yet) has no commands.

```ts
import type {
  Customer,
  PriceLookupItem,
  SyncSettings,
  TaxRate,
  Unit,
  Warehouse,
} from '@omnivo/contracts';

// Step 18b (decision 35): what the queries and the line editor read from the device's copy. The
// session that opens the copy (local-session.ts) fills it, and empties it when the copy closes.
// queries.ts and stock-parts.tsx are on the path of almost every page: through this file they
// carry no code of @omnivo/sync, which took a dozen chunks over their budget.
export interface DeviceReads {
  units: () => Promise<Unit[]>;
  taxRates: () => Promise<TaxRate[]>;
  // The active warehouses of the device's branch: the only ones it keeps
  warehouses: () => Promise<Warehouse[]>;
  // The server's row with the outbox on top; null = not on this device
  customer: (customerId: string) => Promise<Customer | null>;
  // The customer has commands waiting in the outbox
  hasCommands: (customerId: string) => Promise<boolean>;
  // The workspace's settings in the copy: its time zone and how it writes prices
  settings: () => Promise<SyncSettings | null>;
  // The sales price lookup on the device ('' = no customer), with the customer as the outbox has it
  prices: (
    customerId: string,
    items: readonly { variantId: string; unitId: string }[],
  ) => Promise<PriceLookupItem[]>;
}

let reads: DeviceReads | null = null;

export function setDeviceReads(next: DeviceReads | null): void {
  reads = next;
}

export function deviceReads(): DeviceReads | null {
  return reads;
}
```

- **The device's reads the queries need, filled by the session** (decision 41). `queries.ts` and `stock-parts.tsx`
  are on the path of almost every page. Importing `@omnivo/sync` (or `local-data.ts`) there put the device's reads
  into a dozen chunks and took them over their budget; through this file they carry only types.
- **`customer()` and `prices()` read the customer with the outbox on top,** so a customer made offline has its
  addresses and its price list.

```ts
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Step 18b: the three numbers the sidebar shows of the sync (decision 1). The session writes them
// (local-session.ts: the engine's status and a live count of the outbox), and the AppShell reads
// them. A file of its own that imports nothing of @omnivo/sync: the shell is on every page's path,
// and local-data.ts with the device's reads took it over its budget.
export interface SyncSummary {
  // A push or a pull runs in this tab
  syncing: boolean;
  // Commands on the device, and the refused ones among them
  waiting: number;
  failed: number;
}

export const NO_SUMMARY: SyncSummary = { syncing: false, waiting: 0, failed: 0 };

export const syncSummaryStore = createStore<SyncSummary>()(() => NO_SUMMARY);

export function useSyncSummary(): SyncSummary {
  return useStore(syncSummaryStore);
}
```

- **Three numbers in a store of their own,** written by the session, read by the sidebar. The AppShell is on the
  path of every page; reading the outbox there through `local-data.ts` brought `@omnivo/sync`'s reads into it and
  took its chunk over the 105 KB budget. This file imports only zustand, which the first load has already.

```diff
@@ -1,20 +1,30 @@
 import { type Device, routes } from '@omnivo/contracts';
-import { i18n } from '@omnivo/i18n';
+import { formatNumber, i18n, isLanguage } from '@omnivo/i18n';
 import {
+  allRows,
+  customerCommands,
   databaseName,
   deleteLocalDatabase,
   type DeviceIdentity,
   deviceNameParts,
+  localCustomer,
+  lookUpPrices,
   newDeviceId,
+  outboxCounts,
+  type PushOutcome,
   readDevice,
   saveDevice,
   SyncDatabase,
   SyncEngine,
   watch,
 } from '@omnivo/sync';
+import { toast } from '@omnivo/ui';
 
 import { ApiRequestError, call, onApiWrite } from './api';
+import { setDeviceReads } from './device-reads';
 import { localDataStore } from './local-data';
+import { queryClient } from './query-client';
+import { NO_SUMMARY, syncSummaryStore } from './sync-summary';
 
 // Step 18a: this browser as a device, and its copy of the data, for the person signed in now.
 // This module brings Dexie, so only lazy code imports it: the AppShell's host
@@ -88,6 +98,7 @@ export function stopLocalData(): void {
   runCleanup(current);
   current = null;
   set({ device: { kind: 'starting' }, asking: false });
+  syncSummaryStore.setState(NO_SUMMARY);
 }
 
 // The copy is the workspace's data: signing out deletes it (decision 41). The device's id stays
@@ -137,7 +148,7 @@ function retry(session: Session): void {
   if (session.stopped) return;
   const { device } = localDataStore.getState();
   if (device.kind === 'ready') {
-    void device.engine.pullNow();
+    void device.engine.syncNow();
     return;
   }
   runCleanup(session);
@@ -151,6 +162,26 @@ function deviceName(): string {
   return parts ? i18n.t('devices.defaultName', parts) : i18n.t('devices.fallbackName');
 }
 
+// Step 18b: after a push that sent something. The screens that show customers read them again (a
+// customer page, the credit line, a form's customer box), and one toast says what happened. A
+// refusal comes first: it is the one the person must act on, and the sidebar count leads there
+// too, for someone who misses the toast.
+function pushed(session: Session, outcome: PushOutcome): void {
+  void queryClient.invalidateQueries({ queryKey: ['customers', session.tenantId] });
+  void queryClient.invalidateQueries({ queryKey: ['sales', session.tenantId, 'orders'] });
+  const language = isLanguage(i18n.language) ? i18n.language : 'en';
+  if (outcome.rejected > 0) toast(i18n.t('sync.someFailed'));
+  else if (outcome.kept > 0) toast(i18n.t('sync.someKept'));
+  else {
+    toast(
+      i18n.t('sync.synced', {
+        count: outcome.accepted,
+        formatted: formatNumber(outcome.accepted, language),
+      }),
+    );
+  }
+}
+
 function registerDevice(session: Session, branchId: string): Promise<Device> {
   return call(routes.sync.registerDevice, {
     body: { id: session.identity.id, name: deviceName(), branchId },
@@ -206,6 +237,10 @@ async function open(session: Session): Promise<void> {
     db,
     deviceId: session.identity.id,
     pull: (query) => call(routes.sync.pull, { query }),
+    push: (body) => call(routes.sync.push, { body }),
+    onPushed: (outcome) => {
+      if (!session.stopped) pushed(session, outcome);
+    },
     codeOf,
     registerAgain: async () => {
       const { branchId } = session.identity;
@@ -230,11 +265,43 @@ async function open(session: Session): Promise<void> {
       void revoke(session);
     },
   });
+  // Step 18b: the queries read the copy offline through these (device-reads.ts). The balance is the
+  // server's only, so a customer from the device has none.
+  setDeviceReads({
+    units: () => allRows(db.units),
+    taxRates: () => allRows(db.taxRates),
+    warehouses: () => allRows(db.warehouses),
+    customer: async (customerId) => {
+      const local = await localCustomer(db, customerId);
+      return local && { ...local, balance: null };
+    },
+    hasCommands: async (customerId) => (await customerCommands(db, customerId)).length > 0,
+    settings: async () => (await allRows(db.settings))[0] ?? null,
+    prices: async (customerId, items) => {
+      const customer = customerId === '' ? null : await localCustomer(db, customerId);
+      return lookUpPrices(db, customer?.priceListId ?? null, items);
+    },
+  });
   session.cleanup.push(
     // A save on this device: pull its change now (api.ts)
     onApiWrite(() => {
       engine.request();
     }),
+    // Step 18b: the sidebar's numbers (sync-summary.ts), live: a save, a push or another tab
+    // changes the outbox, and the count follows
+    watch(
+      () => outboxCounts(db),
+      (counts) => {
+        syncSummaryStore.setState({ waiting: counts.total, failed: counts.failed });
+      },
+      () => undefined,
+    ),
+    engine.subscribe(() => {
+      syncSummaryStore.setState({ syncing: engine.getStatus().syncing });
+    }),
+    () => {
+      setDeviceReads(null);
+    },
     () => {
       engine.stop();
     },
```

- **`push: (body) => call(routes.sync.push, { body })`.** The engine knows nothing of tokens; the session gives it
  the call, like the pull.
- **`pushed()`** refreshes everything under `['customers', tenant]` (a customer's page, the credit line, a form's
  customer box read the outbox until now) and the orders list, and shows one toast (decision 39). It uses
  `i18n.t` and `formatNumber`, not a hook: it runs outside React.
- **`setDeviceReads({...})`** right after the database opens, and `setDeviceReads(null)` in `cleanup`: the queries
  read this copy only while it is open, and never another workspace's.
- **`watch(() => outboxCounts(db), …)`** keeps the sidebar's count live: a save, a push, or another tab changes the
  outbox, and Dexie runs the count again. The engine's `subscribe` feeds `syncing`. Both are in `cleanup`, and
  `stopLocalData()` puts the numbers back to zero, so another workspace never shows this one's count.

```diff
@@ -45,6 +45,27 @@ import {
 import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
 
 import { call } from './api';
+import { type DeviceReads, deviceReads } from './device-reads';
+
+// Step 18b (decision 35): without a connection, the small lists a sales form needs (units, VAT
+// rates, warehouses) and a customer come from the device's copy, so the order and customer
+// forms work offline, down to the components deep inside them that read these queries. Online,
+// nothing changes. networkMode 'always': TanStack would otherwise pause a query while the browser
+// is offline, and never call the function that knows about the device.
+function offline(): DeviceReads | null {
+  return navigator.onLine ? null : deviceReads();
+}
+
+// The device's copy of the settings (its time zone, prices with VAT), for when the server's were
+// never loaded. null while the copy has none. Under ['settings', tenant], so a settings save
+// refreshes it with the server's.
+export function deviceSettingsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['settings', tenantId, 'device'],
+    queryFn: async () => (await deviceReads()?.settings()) ?? null,
+    networkMode: 'always',
+  });
+}
 
 // কয়েকটা পেজ একই settings চায় (টাইমজোন, অর্থবছর) — key আর আনার নিয়ম এক জায়গায়, তাই একবার আনা
 // ডেটা সবাই ক্যাশ থেকে পায়, আর সেভের পরে এক জায়গায় হালনাগাদ করলেই সব পেজে নতুন মান
@@ -263,7 +284,11 @@ export function reportExportsQuery(tenantId: string) {
 export function unitsQuery(tenantId: string) {
   return queryOptions({
     queryKey: ['products', tenantId, 'units'],
-    queryFn: async () => (await call(routes.units.list)).items,
+    queryFn: async () => {
+      const device = offline();
+      return device ? device.units() : (await call(routes.units.list)).items;
+    },
+    networkMode: 'always',
     refetchInterval: (query) => (query.state.data?.length === 0 ? 3_000 : false),
   });
 }
@@ -348,7 +373,14 @@ export function productImportQuery(tenantId: string, importId: string) {
 export function warehousesQuery(tenantId: string, status: WarehouseStatus) {
   return queryOptions({
     queryKey: ['warehouses', tenantId, status],
-    queryFn: async () => (await call(routes.warehouses.list, { query: { status } })).items,
+    // The device has the active warehouses of its branch only: offline, an order is written for
+    // one of them (decision 8), and no archived one is known
+    queryFn: async () => {
+      const device = offline();
+      if (device) return status === 'active' ? device.warehouses() : [];
+      return (await call(routes.warehouses.list, { query: { status } })).items;
+    },
+    networkMode: 'always',
   });
 }
 
@@ -587,7 +619,11 @@ export function stockAccountsQuery(tenantId: string) {
 export function taxRatesQuery(tenantId: string) {
   return queryOptions({
     queryKey: ['tax-rates', tenantId],
-    queryFn: async () => (await call(routes.taxRates.list)).items,
+    queryFn: async () => {
+      const device = offline();
+      return device ? device.taxRates() : (await call(routes.taxRates.list)).items;
+    },
+    networkMode: 'always',
   });
 }
 
@@ -647,7 +683,18 @@ export function customerBalancesQuery(tenantId: string, ids: readonly string[])
 export function customerQuery(tenantId: string, customerId: string) {
   return queryOptions({
     queryKey: ['customers', tenantId, 'customer', customerId],
-    queryFn: () => call(routes.customers.get, { params: { id: customerId } }),
+    // A customer with commands waiting is read from the device online too: the server does not
+    // have a customer made offline yet, and has an older one when it was changed offline. The
+    // balance is the server's only (null). The session refreshes this key after every push.
+    queryFn: async () => {
+      const device = deviceReads();
+      if (device && (!navigator.onLine || (await device.hasCommands(customerId)))) {
+        const local = await device.customer(customerId);
+        if (local) return local;
+      }
+      return call(routes.customers.get, { params: { id: customerId } });
+    },
+    networkMode: 'always',
     retry: false,
   });
 }
```

- **`offline()`** is the device's reads only while the browser is offline and the copy is open (decision 35).
- **`networkMode: 'always'`.** TanStack Query pauses a query while `navigator.onLine` is false and never calls its
  function. With `'always'` the function runs, and offline it reads the device instead of the API.
- **The warehouses offline are the active ones of the device's branch,** and no archived one: the device has no
  other. An order offline is written for one of them (decision 8).
- **`customerQuery` reads the device whenever the customer has commands waiting,** online too: the server does not
  have a customer made offline, and has an older one when it was changed offline. Its balance is `null`: the
  balance is the server's only. A customer the device does not have falls through to the API.
- **`deviceSettingsQuery`** is the device's settings row, for when the server's were never loaded. Its key is
  under `['settings', tenant]`, so a settings save refreshes it too.
- **Back online, TanStack refetches these queries by itself** (`refetchOnReconnect`), so the server's lists come
  back without anyone doing anything.

```diff
@@ -22,7 +22,7 @@ import { useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
 import { useCallback, useMemo } from 'react';
 
-import { settingsQuery, unitsQuery, warehousesQuery } from '../lib/queries';
+import { deviceSettingsQuery, settingsQuery, unitsQuery, warehousesQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { daysUntil, expiryTone, variantName } from '../lib/stock';
 
@@ -79,10 +79,17 @@ export function warehouseLabel(place: Warehouse | undefined): string {
 }
 
 // "Today" in the company's time zone: the forms' default date, and the expiry countdown
+// The company's time zone. Step 18b: offline, before the settings were ever loaded, the device's
+// copy has it.
+export function useTimeZone(): string {
+  const tenantId = useTenantId();
+  const server = useQuery(settingsQuery(tenantId)).data;
+  const local = useQuery({ ...deviceSettingsQuery(tenantId), enabled: !server }).data;
+  return server?.timezone ?? local?.timezone ?? DEFAULT_SETTINGS.timezone;
+}
+
 export function useToday(): string {
-  const timeZone =
-    useQuery(settingsQuery(useTenantId())).data?.timezone ?? DEFAULT_SETTINGS.timezone;
-  return todayIn(timeZone);
+  return todayIn(useTimeZone());
 }
 
 // After a posting: everything under ['stock', tenant] — the list, the cards, the reports and the
```

`useTimeZone()` is the server's time zone, else the device's (offline, before the settings were ever loaded),
else the default. `useToday()` uses it, so an offline order's date is the company's today, not the browser's.
`enabled: !server`: the device is read only when the server's answer is missing.

```diff
@@ -1,4 +1,4 @@
-import { isErrorCode } from '@omnivo/contracts';
+import { isErrorCode, type SyncCommandError } from '@omnivo/contracts';
 import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
 
 import { ApiRequestError } from './api';
@@ -17,15 +17,45 @@ export function applyApiError<TValues extends FieldValues>(
     setError('root.server', { message: 'unknown_error' });
     return;
   }
+  placeErrors(error.code, error.problem.fieldErrors, fieldNames, setError);
+}
+
+// Step 18b: a refused command's error, when the person opens the command to fix it (decision 22).
+// The same paths as the form's, so it lands under the same boxes. `rename` turns a path the
+// server wrote by an address's id ("addresses.<id>.kind") into the form's place in the list.
+export function applyCommandError<TValues extends FieldValues>(
+  error: SyncCommandError,
+  fieldNames: readonly Path<TValues>[],
+  setError: UseFormSetError<TValues>,
+  rename: (path: string) => string = (path) => path,
+): void {
+  const fieldErrors = Object.fromEntries(
+    Object.entries(error.fieldErrors ?? {}).map(([path, codes]) => [rename(path), codes]),
+  );
+  // The command's code comes from the server: one this app does not know reads as unknown_error
+  placeErrors(
+    isErrorCode(error.code) ? error.code : 'unknown_error',
+    fieldErrors,
+    fieldNames,
+    setError,
+  );
+}
+
+function placeErrors<TValues extends FieldValues>(
+  code: string,
+  fieldErrors: Record<string, string[]> | undefined,
+  fieldNames: readonly Path<TValues>[],
+  setError: UseFormSetError<TValues>,
+): void {
   let placed = false;
-  for (const [field, codes] of Object.entries(error.problem.fieldErrors ?? {})) {
+  for (const [field, codes] of Object.entries(fieldErrors ?? {})) {
     // find: cast ছাড়াই string → Path<TValues>; ফর্মে নেই এমন নাম বাদ পড়ে
     const name = fieldNames.find((candidate) => candidate === field);
-    const code = codes[0];
-    if (name && code !== undefined) {
-      setError(name, { message: isErrorCode(code) ? code : 'invalid_value' });
+    const first = codes[0];
+    if (name && first !== undefined) {
+      setError(name, { message: isErrorCode(first) ? first : 'invalid_value' });
       placed = true;
     }
   }
-  if (!placed) setError('root.server', { message: error.code });
+  if (!placed) setError('root.server', { message: code });
 }
```

- **`applyCommandError()`** puts a refused command's errors under the form's boxes when the person opens it
  (decision 22), with the same placing as `applyApiError()` (`placeErrors()`, shared).
- **`rename`** turns a path the server wrote by an address's id (`addresses.<id>.kind`) into the form's place in
  the list (`addresses.1.kind`); the customer form passes it.
- **A code this app does not know is `unknown_error`:** the error was stored on the device, maybe by an older or a
  newer server.

```diff
@@ -3,7 +3,7 @@ import type { ErrorOption, Path } from 'react-hook-form';
 import { describe, expect, it } from 'vitest';
 
 import { ApiRequestError } from './api';
-import { applyApiError } from './field-errors';
+import { applyApiError, applyCommandError } from './field-errors';
 
 const FIELDS: Path<SignUpInput>[] = [
   'companyName',
@@ -56,3 +56,50 @@ describe('applyApiError', () => {
     expect(collect(new TypeError('boom'))).toEqual({ 'root.server': 'unknown_error' });
   });
 });
+
+describe('applyCommandError', () => {
+  interface Values {
+    name: string;
+    addresses: { kind: string }[];
+  }
+  const fields: Path<Values>[] = ['name', 'addresses.0.kind', 'addresses.1.kind'];
+
+  function placedFrom(
+    error: Parameters<typeof applyCommandError>[0],
+    rename?: (path: string) => string,
+  ) {
+    const placed: Record<string, string | undefined> = {};
+    applyCommandError<Values>(
+      error,
+      fields,
+      (name: string, option: ErrorOption) => {
+        placed[name] = option.message;
+      },
+      rename,
+    );
+    return placed;
+  }
+
+  it('puts a refused command’s field errors under the boxes, by the form’s place', () => {
+    const id = '01928c4e-9999-7000-8000-000000000002';
+    const rename = (path: string) => path.replace(`addresses.${id}.`, 'addresses.1.');
+    expect(
+      placedFrom(
+        {
+          code: 'customer_billing_twice',
+          fieldErrors: { [`addresses.${id}.kind`]: ['customer_billing_twice'] },
+        },
+        rename,
+      ),
+    ).toEqual({ 'addresses.1.kind': 'customer_billing_twice' });
+  });
+
+  it('puts an error without a field, or a code this app does not know, at the top', () => {
+    expect(placedFrom({ code: 'sync_customer_gone' })).toEqual({
+      'root.server': 'sync_customer_gone',
+    });
+    expect(placedFrom({ code: 'a_newer_servers_code' })).toEqual({
+      'root.server': 'unknown_error',
+    });
+  });
+});
```

### The customer form offline

```diff
@@ -12,11 +12,12 @@ import {
   ADDRESS_KINDS,
   contractErrorMap,
   type Customer,
-  type CustomerGroup,
   MAX_CUSTOMER_ADDRESSES,
   MAX_PAYMENT_TERMS_DAYS,
-  type PriceList,
   routes,
+  type SyncCommandError,
+  type SyncCustomerGroup,
+  type SyncPriceList,
   updateCustomerInputSchema,
 } from '@omnivo/contracts';
 import { LANGUAGES, useLocale } from '@omnivo/i18n';
@@ -36,17 +37,21 @@ import {
   TextField,
   toast,
 } from '@omnivo/ui';
+import { saveCustomer } from '@omnivo/sync';
 import { useQueryClient } from '@tanstack/react-query';
 import { Link, useNavigate } from '@tanstack/react-router';
-import type { ReactNode } from 'react';
+import { type ReactNode, useEffect } from 'react';
 import { type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
 import type { z } from 'zod';
 
-import { applyApiError } from '../lib/field-errors';
+import { applyApiError, applyCommandError } from '../lib/field-errors';
 import { call } from '../lib/api';
+import { requestSync, type SaveMode, useLocalDb } from '../lib/local-data';
 import { rowPath } from '../lib/products';
 import { customerQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
+import { useOnline } from '../lib/use-online';
+import { DocumentNotice } from './sales-parts';
 
 // The customer form: a chunk of its own (loaded by routes/customer.tsx), like the product form.
 // The schema is the contract's own, so the form refuses what the API refuses, in the same words.
@@ -81,8 +86,10 @@ function valuesOf(customer: Customer | null): FormValues {
         address: address.address,
         phone: address.phone ?? '',
       })) ?? [],
-    // A new customer has no version; 1 passes the schema, and the create route never reads it
-    version: customer?.version ?? 1,
+    // A new customer has no version; 1 passes the schema, and the create route never reads it.
+    // Step 18b: nor does one made on this device (version 0, overlay.ts), whose save goes to the
+    // outbox. With its 0 the schema refused every save, and showed no box to fix.
+    version: customer === null || customer.version === 0 ? 1 : customer.version,
   };
 }
 
@@ -130,23 +137,45 @@ function SectionCard({
   );
 }
 
+// A path of a refused change names an address by its id (decision 22): the form's errors go by
+// the address's place in the list
+function addressPlaces(customer: Customer | null): (path: string) => string {
+  const ids = customer?.addresses.map((address) => address.id) ?? [];
+  return (path) =>
+    path.replace(/^addresses\.([0-9a-f-]{36})\./, (whole, id: string) => {
+      const index = ids.indexOf(id);
+      return index === -1 ? whole : `addresses.${String(index)}.`;
+    });
+}
+
 export function CustomerForm({
   customer,
   groups,
   priceLists,
   canManage,
+  mode,
+  failed,
 }: {
+  // Step 18b: in device mode, the server's customer with the waiting changes on it
   customer: Customer | null;
-  groups: CustomerGroup[];
+  // The server's or the device's (step 18b): the form needs only their ids and names
+  groups: SyncCustomerGroup[];
   // All of them, archived ones too: the customer's own list stays in the select if it was
   // archived since (like an archived unit on a product), and the server keeps it on save
-  priceLists: PriceList[];
+  priceLists: SyncPriceList[];
   canManage: boolean;
+  // Step 18b (decision 2): 'api' saves through the API as before; 'device' into the outbox
+  mode: SaveMode;
+  // The error of the customer's refused command, shown under its boxes until the next save
+  failed: SyncCommandError | null;
 }) {
   const { t, errorText } = useLocale();
   const navigate = useNavigate();
   const queryClient = useQueryClient();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
+  const online = useOnline();
+  const db = useLocalDb();
+  const onDevice = mode === 'device';
   const {
     register,
     control,
@@ -159,6 +188,18 @@ export function CustomerForm({
     defaultValues: valuesOf(customer),
   });
   const addressArray = useFieldArray({ control, name: 'addresses' });
+
+  // Once, when the form opens a refused command: its errors where the person fixes them
+  useEffect(() => {
+    if (failed) {
+      applyCommandError(
+        failed,
+        fieldNames(customer?.addresses.length ?? 0),
+        setError,
+        addressPlaces(customer),
+      );
+    }
+  }, [failed, customer, setError]);
   const addresses = useWatch({ control, name: 'addresses' });
   // The first shipping address is the default on a delivery (step 15b): the form says so
   const defaultShipping = addresses.findIndex((address) => address.kind === 'shipping');
@@ -180,6 +221,26 @@ export function CustomerForm({
   });
 
   const onSubmit = handleSubmit(async ({ version, ...values }) => {
+    if (onDevice) {
+      if (!db) return;
+      try {
+        await saveCustomer(db, {
+          base: customer,
+          input: values,
+          savedAt: new Date().toISOString(),
+        });
+      } catch {
+        // IndexedDB refused the write (a full disk): the text, not a code, like the credit errors
+        setError('root.server', { message: t('sync.saveFailed') });
+        return;
+      }
+      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
+      requestSync();
+      toast(t('sync.savedOnDevice'));
+      // The list, where it shows "Not synced": the customer's page needs the server
+      void navigate({ to: '/customers', replace: true });
+      return;
+    }
     try {
       const saved = customer
         ? await call(routes.customers.update, {
@@ -205,7 +266,7 @@ export function CustomerForm({
 
   return (
     <div className="grid max-w-4xl grid-cols-1 gap-5">
-      {customer ? (
+      {customer && !onDevice ? (
         <Link
           to="/customers/$customerId"
           params={{ customerId: customer.id }}
@@ -228,6 +289,11 @@ export function CustomerForm({
         description={customer?.name}
       />
       {!canManage && <p className="text-body-sm text-ink-3">{t('customers.readOnly')}</p>}
+      {canManage && onDevice && (
+        <DocumentNotice tone="neutral">
+          {online ? t('sync.waitingNotice') : t('sync.offlineNotice')}
+        </DocumentNotice>
+      )}
       <form noValidate onSubmit={(event) => void onSubmit(event)}>
         {/* Without the permission the same page reads, every control disabled at once */}
         <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
@@ -244,7 +310,12 @@ export function CustomerForm({
             <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
               <TextField
                 label={t('customers.fields.code')}
-                hint={customer ? undefined : t('customers.fields.codeHint')}
+                hint={
+                  customer
+                    ? undefined
+                    : // Offline the next number is not known (decision 16)
+                      t(onDevice ? 'sync.codeOfflineHint' : 'customers.fields.codeHint')
+                }
                 optional={!customer}
                 autoCapitalize="characters"
                 spellCheck={false}
@@ -447,7 +518,7 @@ export function CustomerForm({
               <Button
                 variant="secondary"
                 onClick={() =>
-                  void (customer
+                  void (customer && !onDevice
                     ? navigate({
                         to: '/customers/$customerId',
                         params: { customerId: customer.id },
@@ -460,9 +531,11 @@ export function CustomerForm({
               <Button type="submit" disabled={isSubmitting}>
                 {isSubmitting
                   ? t('common.saving')
-                  : customer
-                    ? t('customers.save')
-                    : t('customers.create')}
+                  : onDevice
+                    ? t('sync.saveOnDevice')
+                    : customer
+                      ? t('customers.save')
+                      : t('customers.create')}
               </Button>
             </div>
           )}
```

- **`mode` and `failed` are props.** The page decides the mode (it already reads the customer), and the form only
  follows it.
- **`groups` and `priceLists` take the device's types** (`SyncCustomerGroup`, `SyncPriceList`): the server's
  types have them plus counts, so both sources fit without a cast.
- **The device save** calls `saveCustomer()` with the customer the form opened on as `base`. A refusal from
  IndexedDB (a full disk) puts `sync.saveFailed` at the top. After the save: the customer queries are refreshed
  (the edit page, a customer box), a sync is asked for, and the form goes to the list (decision 40).
- **`addressPlaces()`** is the `rename` for this form, from the addresses the form opened with.
- **`useEffect` on `failed`** places the errors once when the form opens. The next submit clears them, like any
  server error.
- **`version` is 1 for a customer made on this device.** Its row has version 0 (`overlay.ts`: no server row has
  it, which is how the list knows it was made here), and the form's schema wants 1 or more. With the 0, every save
  of such a customer was refused by the schema, with no box marked and no message: the person pressed "Save on
  this device" and nothing happened. The version is never sent from device mode (a change takes its base version
  from `base`), so 1 changes nothing else. Found by 18b.7's test of a refused customer.
- **The notice above the form** says why the button reads "Save on this device": offline, or (online) because the
  customer has changes waiting (`sync.waitingNotice`). The code's hint offline gives no example number.
- **The back link and Cancel go to the list** in device mode: the customer's page needs the server.

```diff
@@ -1,10 +1,14 @@
+import { allRows, customerCommands, type SyncDatabase } from '@omnivo/sync';
 import { useQuery } from '@tanstack/react-query';
 import { useParams } from '@tanstack/react-router';
-import { lazy, Suspense } from 'react';
+import { lazy, Suspense, useCallback } from 'react';
 
 import { CustomerNotFound, useTenantId } from '../components/customer-parts';
+import { LocalState, type WaitingView } from '../components/local-state';
+import { useLocalData, useLocalDb, useLocalQuery, useSaveMode } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
 import { customerGroupsQuery, customerQuery, priceListsQuery } from '../lib/queries';
+import { useOnline } from '../lib/use-online';
 
 // The new and edit pages, apart from the customer's page (routes/customer.tsx): that page's
 // statement brings the data table and the date pickers, which the form never uses. In one file,
@@ -16,21 +20,50 @@ const CustomerForm = lazy(async () => ({
   default: (await import('../components/customer-form')).CustomerForm,
 }));
 
-// What the form needs besides the customer: the groups and the price lists to pick from
+// Reads of the device's copy: stable functions, so useLocalQuery subscribes once
+const readGroups = (db: SyncDatabase) => allRows(db.customerGroups);
+const readPriceLists = (db: SyncDatabase) => allRows(db.priceLists);
+
+// What the form needs besides the customer: the groups and the price lists to pick from. Step
+// 18b: offline, the device's copy has them.
 function useFormData() {
   const tenantId = useTenantId();
-  const groups = useQuery(customerGroupsQuery(tenantId)).data;
-  const priceLists = useQuery(priceListsQuery(tenantId)).data;
-  return { groups, priceLists };
+  const online = useOnline();
+  const groups = useQuery({ ...customerGroupsQuery(tenantId), enabled: online }).data;
+  const priceLists = useQuery({ ...priceListsQuery(tenantId), enabled: online }).data;
+  const localGroups = useLocalQuery(online ? null : readGroups);
+  const localPriceLists = useLocalQuery(online ? null : readPriceLists);
+  return online ? { groups, priceLists } : { groups: localGroups, priceLists: localPriceLists };
+}
+
+// Offline without a complete copy of the data, there is nothing to pick from: the device's state
+// says what to do instead
+function NoCopy({ view }: { view: WaitingView }) {
+  return (
+    <div className="grid max-w-4xl grid-cols-1 gap-5">
+      <LocalState view={view} />
+    </div>
+  );
 }
 
 export function NewCustomerPage() {
   const canManage = useCan()('sales.customer.manage');
   const { groups, priceLists } = useFormData();
-  if (!groups || !priceLists) return null;
+  // A new customer has no commands: online it is the API, offline the device
+  const mode = useSaveMode('');
+  const { view } = useLocalData();
+  if (mode === 'device' && view.kind !== 'ready') return <NoCopy view={view} />;
+  if (!groups || !priceLists || mode === undefined) return null;
   return (
     <Suspense fallback={null}>
-      <CustomerForm customer={null} groups={groups} priceLists={priceLists} canManage={canManage} />
+      <CustomerForm
+        customer={null}
+        groups={groups}
+        priceLists={priceLists}
+        canManage={canManage}
+        mode={mode}
+        failed={null}
+      />
     </Suspense>
   );
 }
@@ -39,21 +72,36 @@ export function EditCustomerPage() {
   const { customerId = '' } = useParams({ strict: false });
   const canManage = useCan()('sales.customer.manage');
   const { groups, priceLists } = useFormData();
+  const mode = useSaveMode(customerId);
+  const db = useLocalDb();
+  // The customer's refused command, if any: the form shows its errors under the boxes
+  const readCommands = useCallback(
+    (database: SyncDatabase) => customerCommands(database, customerId),
+    [customerId],
+  );
+  const commands = useLocalQuery(db ? readCommands : null);
+  const failed = commands?.find((command) => command.status === 'failed')?.error ?? null;
+  // In device mode the query reads the device (queries.ts): the customer with its changes on it
   const { data: customer, isError } = useQuery({
     ...customerQuery(useTenantId(), customerId),
     enabled: customerId !== '',
   });
+  const { view } = useLocalData();
+  if (mode === 'device' && view.kind !== 'ready') return <NoCopy view={view} />;
   if (isError) return <CustomerNotFound />;
-  if (!customer || !groups || !priceLists) return null;
+  if (!customer || !groups || !priceLists || mode === undefined) return null;
   return (
     <Suspense fallback={null}>
-      {/* key: a customer saved elsewhere comes back with a new version; start from it again */}
+      {/* key: a customer saved elsewhere comes back with a new version, and a customer whose
+          commands synced goes back to the API: start from it again */}
       <CustomerForm
-        key={`${customer.id}-${String(customer.version)}`}
+        key={`${customer.id}-${String(customer.version)}-${mode}`}
         customer={customer}
         groups={groups}
         priceLists={priceLists}
         canManage={canManage}
+        mode={mode}
+        failed={failed}
       />
     </Suspense>
   );
```

- **`useFormData()`** reads the groups and the price lists from the server online and from the device offline.
- **`NoCopy`**: offline without a complete copy, there are no groups to pick and no customer to change; the device's
  state (18a's `LocalState`) says what to do.
- **The edit page reads the customer through `customerQuery`,** which reads the device in device mode
  (`queries.ts`). The failed command's error comes from `customerCommands()`.
- **`key` has the mode in it:** when the customer's commands sync while the form is open, the mode goes back to
  the API and the form starts again from the server's customer.

### The order form offline

```diff
@@ -12,6 +12,7 @@ import {
   type ProductVariant,
   type SalesLine,
   type SalesLineFormValues,
+  type SalesLineInput,
   type SalesOrderLine,
   subtractQuantity,
   sumQuantity,
@@ -242,3 +243,52 @@ export function savedLines(
     })),
   };
 }
+
+// Step 18b: a draft order waiting in the outbox, opened again. Its lines are the command's (what
+// the schema made of the form), so they go back into the boxes the way a saved line does; their
+// products come from the device's copy, by variant. A product no longer on the device (archived
+// meanwhile) keeps the line under its description: the server refuses it when it is sent, and the
+// person sees which line.
+export function draftLines(
+  lines: readonly SalesLineInput[],
+  products: ReadonlyMap<string, Product>,
+  customerId: string,
+): { values: SalesLineFormValues[]; meta: LineMeta[] } {
+  return {
+    values: lines.map((line) => ({
+      variantId: line.variantId,
+      unitId: line.unitId,
+      quantity: plainQuantity(line.quantity),
+      description: line.description ?? '',
+      unitPrice: line.unitPrice,
+      discountType: line.discountType,
+      discount: formDiscount(line.discount),
+      taxRateId: line.taxRateId,
+    })),
+    meta: lines.map((line, index) => {
+      const product = products.get(line.variantId);
+      const variant = product?.variants.find((one) => one.id === line.variantId);
+      return {
+        key: `draft-${String(index)}`,
+        item:
+          product && variant
+            ? productItemOf(product, variant)
+            : {
+                variantId: line.variantId,
+                productId: '',
+                productCode: '',
+                productName: line.description ?? '',
+                optionValues: [],
+                sku: '',
+                baseUnitId: line.unitId,
+                units: [],
+                productType: 'goods',
+                tracking: 'none',
+                hasExpiry: false,
+              },
+        source: undefined,
+        pricedFor: customerId,
+      };
+    }),
+  };
+}
```

```diff
@@ -1,8 +1,9 @@
-import type { SalesLineFormValues, SalesOrderLine } from '@omnivo/contracts';
+import type { Product, SalesLineFormValues, SalesOrderLine } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import {
   baseByOrderLine,
+  draftLines,
   fillFromOrder,
   formDiscount,
   formTotals,
@@ -156,3 +157,75 @@ describe('sales helpers', () => {
     });
   });
 });
+
+describe('draftLines', () => {
+  const juice: Product = {
+    id: 'juice-product',
+    code: 'BEV-0001',
+    name: 'Mango juice 250 ml',
+    type: 'goods',
+    categoryId: null,
+    description: null,
+    baseUnitId: 'pcs',
+    salesUnitId: 'case',
+    purchaseUnitId: null,
+    tracking: 'none',
+    hasExpiry: false,
+    taxRateId: null,
+    options: [],
+    variants: [
+      {
+        id: 'juice',
+        sku: 'BEV-0001',
+        optionValues: [],
+        barcode: null,
+        salePrice: '21.0000',
+        archivedAt: null,
+      },
+    ],
+    units: [{ unitId: 'case', factor: '24', barcode: null }],
+    customFields: {},
+    archivedAt: null,
+    version: 1,
+    updatedAt: '2026-10-21T04:00:00.000Z',
+  };
+  const line = {
+    variantId: 'juice',
+    unitId: 'case',
+    quantity: '2',
+    description: null,
+    unitPrice: '480',
+    discountType: 'percent' as const,
+    discount: '0',
+    taxRateId: 'vat-15',
+  };
+
+  it('puts a waiting draft’s lines back into the boxes, with their products from the device', () => {
+    const { values, meta } = draftLines([line], new Map([['juice', juice]]), 'rahman');
+    expect(values).toEqual([
+      {
+        variantId: 'juice',
+        unitId: 'case',
+        quantity: '2',
+        description: '',
+        unitPrice: '480',
+        discountType: 'percent',
+        discount: '',
+        taxRateId: 'vat-15',
+      },
+    ]);
+    expect(meta[0]).toMatchObject({
+      item: { productName: 'Mango juice 250 ml', units: [{ unitId: 'case', factor: '24' }] },
+      pricedFor: 'rahman',
+    });
+  });
+
+  it('keeps a line whose product is no longer on the device, under its description', () => {
+    const { meta } = draftLines(
+      [{ ...line, description: 'Mango juice, old pack' }],
+      new Map(),
+      'rahman',
+    );
+    expect(meta[0]?.item).toMatchObject({ productName: 'Mango juice, old pack', units: [] });
+  });
+});
```

`draftLines()` puts a waiting draft's lines back into the boxes, like `savedLines()` does for a saved order. The
products come from the device by variant (`productsOfVariants()`). A line whose product left the device keeps its
description as the name: the server refuses it when it is sent, and the person sees which line.

```diff
@@ -27,6 +27,7 @@ import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
 import type { FieldErrors } from 'react-hook-form';
 
 import { call } from '../lib/api';
+import { deviceReads } from '../lib/device-reads';
 import {
   formTotals,
   isServiceLine,
@@ -92,18 +93,25 @@ export interface LinePricing {
 export const linePriceKey = keyOf;
 
 // The quotation's, the order's and the invoice's pricing: the customer's price list, else the
-// product's price, in the selling unit
-export function useSalesPricing(customerId: string): LinePricing {
+// product's price, in the selling unit. Step 18b: an order saved on the device prices its lines
+// from the device's copy, with the same rule (startingPrice in the contracts, decision 19), and
+// with the customer as the outbox has it: a customer made offline is not on the server yet.
+export function useSalesPricing(customerId: string, onDevice = false): LinePricing {
   const { t } = useLocale();
   return {
     partyId: customerId,
     unitOf: (product) => product.salesUnitId ?? product.baseUnitId,
     lookUp: async (items) => {
-      const answer = await call(routes.salesPrices.lookup, {
-        body: { customerId: customerId === '' ? null : customerId, items: [...items] },
-      });
+      const device = onDevice ? deviceReads() : null;
+      const answer = device
+        ? await device.prices(customerId, items)
+        : (
+            await call(routes.salesPrices.lookup, {
+              body: { customerId: customerId === '' ? null : customerId, items: [...items] },
+            })
+          ).items;
       return new Map(
-        answer.items.map((item) => [
+        answer.map((item) => [
           keyOf(item.variantId, item.unitId),
           { price: item.price, source: item.source, taxRateId: item.taxRateId },
         ]),
@@ -212,12 +220,16 @@ export interface LinesEditorProps<L extends SalesLineFormValues> {
 const sameLine = (line: SalesLineFormValues): SalesLineFormValues => line;
 
 // The quotation's and the order's editor: a product added is a plain sales line, priced for the
-// customer
+// customer. onDevice (step 18b): an order saved into the outbox, priced from the device.
 export function SalesLinesEditor({
   customerId,
+  onDevice = false,
   ...props
-}: Omit<LinesEditorProps<SalesLineFormValues>, 'newLine' | 'pricing'> & { customerId: string }) {
-  const pricing = useSalesPricing(customerId);
+}: Omit<LinesEditorProps<SalesLineFormValues>, 'newLine' | 'pricing'> & {
+  customerId: string;
+  onDevice?: boolean;
+}) {
+  const pricing = useSalesPricing(customerId, onDevice);
   return <LinesEditor {...props} pricing={pricing} newLine={sameLine} />;
 }
 
```

`useSalesPricing(customerId, onDevice)`: on the device, the session's `prices()` (`lookUpPrices()` with the
customer's price list as the outbox has it), because a customer made offline is not on the server, and one changed
offline may have a new list. The rest of the editor does not change.

```diff
@@ -17,15 +17,26 @@ import { useTenantId } from './stock-parts';
 // "Credit left: ৳35,000 of ৳2,00,000 · ৳40,000 on confirmed orders", under the customer box. The
 // same numbers the API checks with (GET /customers/:id/credit). Only for someone who may see what
 // a customer owes (sales.customer.balance), like the customer's balance itself.
-export function CreditLine({ customerId }: { customerId: string }) {
+// Step 18b: an order saved on the device (offline, or for a customer whose changes wait) has no
+// credit to show: what the customer owes is on the server, and a draft is checked when it is
+// confirmed online. The line says so instead of numbers that may be wrong.
+export function CreditLine({
+  customerId,
+  onDevice = false,
+}: {
+  customerId: string;
+  onDevice?: boolean;
+}) {
   const { t, format } = useLocale();
   const tenantId = useTenantId();
   const canSee = useCan()('sales.customer.balance');
   const { data: credit } = useQuery({
     ...customerCreditQuery(tenantId, customerId),
-    enabled: canSee && customerId !== '',
+    enabled: canSee && customerId !== '' && !onDevice,
   });
-  if (!canSee || customerId === '' || !credit) return null;
+  if (!canSee || customerId === '') return null;
+  if (onDevice) return <p className="text-label text-ink-3">{t('customers.credit.offline')}</p>;
+  if (!credit) return null;
   const money = (value: string) => format.money(value);
   const over = credit.available !== null && isNegativeMoney(credit.available);
   const main =
```

On the device, the credit line says that the credit is checked when the order is confirmed, instead of numbers
that may be wrong. The server's credit is not asked for (`enabled: … && !onDevice`).

```diff
@@ -7,7 +7,9 @@ import {
   type Quotation,
   routes,
   type SalesOrder,
+  type SalesOrderDraftInput,
   type SalesOrderFormValues,
+  type SyncCommandError,
   updateSalesOrderInputSchema,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
@@ -22,17 +24,20 @@ import {
   TextField,
   toast,
 } from '@omnivo/ui';
+import { saveOrderDraft } from '@omnivo/sync';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
-import { lazy, Suspense, useState } from 'react';
+import { lazy, Suspense, useEffect, useState } from 'react';
 import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
 
 import { call } from '../lib/api';
-import { applyApiError } from '../lib/field-errors';
+import { applyApiError, applyCommandError } from '../lib/field-errors';
+import { requestSync, useLocalDb, useSaveMode } from '../lib/local-data';
 import { rowPath } from '../lib/products';
-import { SALES_LINE_FIELDS, savedLines } from '../lib/sales';
+import { formTotals, type LineMeta, SALES_LINE_FIELDS, savedLines } from '../lib/sales';
 import { useCan } from '../lib/permissions';
-import { customerQuery } from '../lib/queries';
+import { customerQuery, taxRatesQuery } from '../lib/queries';
+import { useOnline } from '../lib/use-online';
 import {
   CreditLimitDialog,
   CreditLine,
@@ -41,7 +46,7 @@ import {
   useCreditText,
 } from './credit-parts';
 import { failureOf } from './journal-parts';
-import { addressLabel, SalesBackLink, useSalesRefresh } from './sales-parts';
+import { addressLabel, DocumentNotice, SalesBackLink, useSalesRefresh } from './sales-parts';
 import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';
 
 // The order form: its own chunk (loaded by routes/sales-order.tsx), like the quotation's.
@@ -82,17 +87,30 @@ function shippingAddresses(addresses: readonly CustomerAddress[]): CustomerAddre
   return addresses.filter((address) => address.kind === 'shipping');
 }
 
+// Step 18b: a draft order waiting in the outbox, opened again from the unsynced orders or the
+// Sync page. Its lines come with their products from the device (sales.ts → draftLines).
+export interface OutboxDraft {
+  orderId: string;
+  input: SalesOrderDraftInput;
+  lines: { values: SalesOrderFormValues['lines']; meta: LineMeta[] };
+  // Refused by the server: its errors go under the boxes
+  error: SyncCommandError | null;
+}
+
 // Writing a new order (from nothing, or from a quotation), or changing a draft. "Save draft" keeps
-// it a draft; "Confirm order" saves and confirms in one request, all or nothing.
+// it a draft; "Confirm order" saves and confirms in one request, all or nothing. Step 18b: offline,
+// or for a customer whose changes wait on this device, it saves a draft into the outbox instead.
 export function SalesOrderForm({
   order,
   quotation,
+  draft = null,
   today,
   pricesIncludeVat,
 }: {
   order: SalesOrder | null;
   // The quotation a new order is made from ("Make order"); null otherwise
   quotation: Quotation | null;
+  draft?: OutboxDraft | null;
   today: string;
   // The order's own copy, the quotation's (an order keeps its quotation's prices), or the
   // workspace's now
@@ -113,6 +131,7 @@ export function SalesOrderForm({
   const [start] = useState(() => {
     if (order) return savedLines(order.lines, order.customer.id);
     if (quotation) return savedLines(quotation.lines, quotation.customer.id);
+    if (draft) return draft.lines;
     return { values: [], meta: [] };
   });
   // A draft that has a number, or comes from a quotation, keeps its customer (the API refuses a
@@ -134,13 +153,13 @@ export function SalesOrderForm({
   } = useForm({
     resolver: zodResolver(updateSalesOrderInputSchema, { error: contractErrorMap }),
     defaultValues: {
-      customerId: savedCustomer?.id ?? '',
-      date: order?.date ?? today,
-      deliveryDate: order?.deliveryDate ?? '',
-      customerReference: order?.customerReference ?? '',
-      warehouseId: order?.warehouseId ?? onlyWarehouse ?? '',
-      shippingAddressId: order?.shippingAddressId ?? '',
-      note: order?.note ?? '',
+      customerId: savedCustomer?.id ?? draft?.input.customerId ?? '',
+      date: order?.date ?? draft?.input.date ?? today,
+      deliveryDate: order?.deliveryDate ?? draft?.input.deliveryDate ?? '',
+      customerReference: order?.customerReference ?? draft?.input.customerReference ?? '',
+      warehouseId: order?.warehouseId ?? draft?.input.warehouseId ?? onlyWarehouse ?? '',
+      shippingAddressId: order?.shippingAddressId ?? draft?.input.shippingAddressId ?? '',
+      note: order?.note ?? draft?.input.note ?? '',
       lines: start.values,
       confirm: false,
       version: order?.version ?? 1,
@@ -153,6 +172,23 @@ export function SalesOrderForm({
     enabled: customerId !== '',
   }).data;
   const addresses = shippingAddresses(customer?.addresses ?? []);
+  // Step 18b (decision 2): a new order goes into the outbox offline, and online when its customer
+  // has changes waiting on this device (a customer made offline is not on the server yet). A
+  // server draft and an order from a quotation stay with the API: neither can be a command.
+  const online = useOnline();
+  const db = useLocalDb();
+  const customerMode = useSaveMode(customerId);
+  const onDevice =
+    order === null &&
+    quotation === null &&
+    (draft !== null || !online || customerMode === 'device');
+  const rates = useQuery(taxRatesQuery(tenantId)).data;
+
+  // Once, when the form opens a refused draft: its errors where the person fixes them
+  useEffect(() => {
+    if (draft?.error)
+      applyCommandError(draft.error, fieldNames(draft.lines.values.length), setError);
+  }, [draft, setError]);
   // The address the draft was saved with, if it is no longer one of the customer's shipping
   // addresses: it still shows as chosen, by the text the order kept
   const keptId = order?.shippingAddressId ?? null;
@@ -215,6 +251,43 @@ export function SalesOrderForm({
       }
     });
 
+  // Into the outbox (decision 15): a draft only, so no confirm and no credit check. The name and
+  // the total are kept with it for the Sync page and the unsynced orders.
+  const saveOnDevice = handleSubmit(async (values) => {
+    if (!db) return;
+    const input: SalesOrderDraftInput = {
+      customerId: values.customerId,
+      date: values.date,
+      deliveryDate: values.deliveryDate,
+      customerReference: values.customerReference,
+      warehouseId: values.warehouseId,
+      shippingAddressId: values.shippingAddressId,
+      note: values.note,
+      lines: values.lines,
+    };
+    const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
+    let result;
+    try {
+      result = await saveOrderDraft(db, {
+        orderId: draft?.orderId ?? null,
+        input,
+        name: customer?.name ?? '',
+        total: formTotals(values.lines, rateOf, pricesIncludeVat).totals.total,
+        savedAt: new Date().toISOString(),
+      });
+    } catch {
+      setError('root.server', { message: t('sync.saveFailed') });
+      return;
+    }
+    if (result === 'busy') {
+      setError('root.server', { message: t('sync.busy') });
+      return;
+    }
+    requestSync();
+    toast(t('sync.savedOnDevice'));
+    void navigate({ to: '/sales-orders', replace: true });
+  });
+
   const removeDraft = useMutation({
     mutationFn: (draft: SalesOrder) =>
       call(routes.salesOrders.remove, {
@@ -234,7 +307,13 @@ export function SalesOrderForm({
     <div className="grid max-w-6xl grid-cols-1 gap-5">
       <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
       <PageHeader
-        title={order ? (order.number ?? t('salesOrders.draftTitle')) : t('salesOrders.newTitle')}
+        title={
+          order
+            ? (order.number ?? t('salesOrders.draftTitle'))
+            : draft
+              ? t('salesOrders.draftTitle')
+              : t('salesOrders.newTitle')
+        }
         description={
           quotation
             ? `${t('salesOrders.quotation')}: ${quotation.number}`
@@ -243,9 +322,14 @@ export function SalesOrderForm({
       />
       <form
         noValidate
-        onSubmit={(event) => void save(false)(event)}
+        onSubmit={(event) => void (onDevice ? saveOnDevice(event) : save(false)(event))}
         className="grid grid-cols-1 gap-5"
       >
+        {onDevice && (
+          <DocumentNotice tone="neutral">
+            {online ? t('sync.waitingNotice') : t('sync.orderOfflineNotice')}
+          </DocumentNotice>
+        )}
         {failure && <FormAlert message={failure} />}
         {keptNumber !== null && (
           <p className="text-body-sm text-ink-2">
@@ -271,7 +355,7 @@ export function SalesOrderForm({
                 </Suspense>
               )}
             </FormField>
-            <CreditLine customerId={customerId} />
+            <CreditLine customerId={customerId} onDevice={onDevice} />
           </div>
           <FormField control={control} name="date" label={t('salesOrders.date')}>
             {(field) => (
@@ -344,6 +428,7 @@ export function SalesOrderForm({
                 getLines={() => getValues('lines')}
                 initialMeta={start.meta}
                 customerId={customerId}
+                onDevice={onDevice}
                 pricesIncludeVat={pricesIncludeVat}
                 errors={errors.lines}
               />
@@ -351,34 +436,44 @@ export function SalesOrderForm({
           )}
         />
 
-        <div className="flex flex-wrap items-center justify-end gap-2">
-          {/* A reopened draft keeps its number and cannot be deleted (it says so above) */}
-          {order?.number === null && (
-            <div className="mr-auto flex flex-wrap items-center gap-2">
-              <Button
-                variant="secondary"
-                disabled={removeDraft.isPending}
-                onClick={() => {
-                  if (confirming) removeDraft.mutate(order);
-                  else setConfirming(true);
-                }}
-              >
-                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
-                {confirming ? t('salesOrders.confirmDelete') : t('salesOrders.deleteDraft')}
-              </Button>
-              {confirming && (
-                <span className="text-body-sm text-ink-2">{t('salesOrders.deleteWarning')}</span>
-              )}
-            </div>
-          )}
-          <Button type="submit" variant="secondary" disabled={isSubmitting}>
-            {t('salesOrders.saveDraft')}
-          </Button>
-          <Button disabled={isSubmitting || lineCount === 0} onClick={() => void save(true)()}>
-            {isSubmitting ? t('salesOrders.confirming') : t('salesOrders.confirm')}
-          </Button>
-        </div>
-        <p className="text-right text-label text-ink-3">{t('salesOrders.confirmHint')}</p>
+        {onDevice ? (
+          <div className="flex flex-wrap items-center justify-end gap-2">
+            <Button type="submit" disabled={isSubmitting}>
+              {t('sync.saveOnDevice')}
+            </Button>
+          </div>
+        ) : (
+          <div className="flex flex-wrap items-center justify-end gap-2">
+            {/* A reopened draft keeps its number and cannot be deleted (it says so above) */}
+            {order?.number === null && (
+              <div className="mr-auto flex flex-wrap items-center gap-2">
+                <Button
+                  variant="secondary"
+                  disabled={removeDraft.isPending}
+                  onClick={() => {
+                    if (confirming) removeDraft.mutate(order);
+                    else setConfirming(true);
+                  }}
+                >
+                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
+                  {confirming ? t('salesOrders.confirmDelete') : t('salesOrders.deleteDraft')}
+                </Button>
+                {confirming && (
+                  <span className="text-body-sm text-ink-2">{t('salesOrders.deleteWarning')}</span>
+                )}
+              </div>
+            )}
+            <Button type="submit" variant="secondary" disabled={isSubmitting}>
+              {t('salesOrders.saveDraft')}
+            </Button>
+            <Button disabled={isSubmitting || lineCount === 0} onClick={() => void save(true)()}>
+              {isSubmitting ? t('salesOrders.confirming') : t('salesOrders.confirm')}
+            </Button>
+          </div>
+        )}
+        {!onDevice && (
+          <p className="text-right text-label text-ink-3">{t('salesOrders.confirmHint')}</p>
+        )}
       </form>
       <CreditLimitDialog
         stop={stop}
```

- **`OutboxDraft`** is a waiting draft opened again: its command input, its lines with their products, and its
  error.
- **`onDevice`** (decision 36): a new order (not a server draft, not from a quotation) goes into the outbox when it
  was a waiting draft, when the browser is offline, or when its customer has commands waiting. It is worked out on
  every render, so picking a customer made offline turns the form to device mode at once.
- **`saveOnDevice`** builds the draft input field by field: the form's values also hold `confirm`,
  `overrideCreditLimit` and `version`, which the command does not have. The total is worked out with the same
  `formTotals()` the editor shows, to the paisa. `'busy'` puts `sync.busy` at the top.
- **One button in device mode, "Save on this device".** No Confirm and no Delete draft: a draft written offline is
  confirmed online (decision 15), and is discarded on the Sync page.

```diff
@@ -1,14 +1,21 @@
-import { AlertCircleIcon } from '@hugeicons/core-free-icons';
+import { AlertCircleIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
 import { useLocale } from '@omnivo/i18n';
+import { outboxOf, productsOfVariants, type SyncDatabase } from '@omnivo/sync';
 import { EmptyState } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { useParams, useSearch } from '@tanstack/react-router';
-import { lazy, Suspense } from 'react';
+import { lazy, Suspense, useCallback } from 'react';
 
+import { LocalState } from '../components/local-state';
+import type { OutboxDraft } from '../components/sales-order-form';
 import { SalesBackLink } from '../components/sales-parts';
 import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
+import { useLocalData, useLocalDb, useLocalQuery } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
+import { draftLines } from '../lib/sales';
+import { useOnline } from '../lib/use-online';
 import {
+  deviceSettingsQuery,
   quotationQuery,
   salesOrderQuery,
   settingsQuery,
@@ -24,15 +31,39 @@ const SalesOrderView = lazy(async () => ({
   default: (await import('../components/sales-order-view')).SalesOrderView,
 }));
 
-// The units, the VAT rates, the warehouses and the settings: the form and the view need them all
+// The units, the VAT rates, the warehouses and the settings: the form and the view need them all.
+// Step 18b: offline, the first three come from the device (queries.ts), and the way prices are
+// written from the device's copy of the settings.
 function useReady(): { pricesIncludeVat: boolean } | null {
   const tenantId = useTenantId();
   const units = useQuery(unitsQuery(tenantId)).data;
   const rates = useQuery(taxRatesQuery(tenantId)).data;
   const settings = useQuery(settingsQuery(tenantId)).data;
+  const local = useQuery({ ...deviceSettingsQuery(tenantId), enabled: !settings }).data;
+  const pricesIncludeVat = settings?.pricesIncludeVat ?? local?.pricesIncludeVat;
   const { active } = useWarehouses();
-  if (units === undefined || rates === undefined || settings === undefined || !active) return null;
-  return { pricesIncludeVat: settings.pricesIncludeVat };
+  if (units === undefined || rates === undefined || pricesIncludeVat === undefined || !active) {
+    return null;
+  }
+  return { pricesIncludeVat };
+}
+
+// A draft order waiting in the outbox under this id, with its lines' products from the device;
+// null = none (the order is the server's)
+async function readDraft(db: SyncDatabase, orderId: string): Promise<OutboxDraft | null> {
+  const [entry] = await outboxOf(db, orderId);
+  if (entry?.command.type !== 'sales_order.create_draft') return null;
+  const { input } = entry.command;
+  const products = await productsOfVariants(
+    db,
+    input.lines.map((line) => line.variantId),
+  );
+  return {
+    orderId,
+    input,
+    lines: draftLines(input.lines, products, input.customerId),
+    error: entry.error,
+  };
 }
 
 function CantFind({ message }: { message: string }) {
@@ -56,6 +87,8 @@ export function NewSalesOrderPage() {
     ...quotationQuery(useTenantId(), quotationId),
     enabled: quotationId !== '',
   });
+  const online = useOnline();
+  const { view } = useLocalData();
   if (!canWrite) {
     return (
       <div className="grid max-w-6xl grid-cols-1 gap-5">
@@ -65,6 +98,15 @@ export function NewSalesOrderPage() {
     );
   }
   if (isError) return <CantFind message={t('quotations.notFound')} />;
+  // Offline, an order is saved on the device: without a complete copy, its state says what to do
+  if (!online && quotationId === '' && view.kind !== 'ready') {
+    return (
+      <div className="grid max-w-6xl grid-cols-1 gap-5">
+        <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
+        <LocalState view={view} />
+      </div>
+    );
+  }
   if (!ready || (quotationId !== '' && !quotation)) return null;
   return (
     <Suspense fallback={null}>
@@ -85,11 +127,43 @@ export function SalesOrderPage() {
   const canWrite = useCan()('sales.order.manage');
   const today = useToday();
   const ready = useReady();
+  const online = useOnline();
+  const db = useLocalDb();
+  // Step 18b: a draft saved on this device opens from the outbox; the server is asked only when
+  // there is none (it does not know the order yet)
+  const read = useCallback((database: SyncDatabase) => readDraft(database, orderId), [orderId]);
+  const draft = useLocalQuery(db ? read : null);
   const { data: order, isError } = useQuery({
     ...salesOrderQuery(useTenantId(), orderId),
-    enabled: orderId !== '',
+    enabled: orderId !== '' && (db === null || draft === null),
   });
 
+  if (db && draft === undefined) return null;
+  if (draft && ready) {
+    return (
+      <Suspense fallback={null}>
+        <SalesOrderForm
+          order={null}
+          quotation={null}
+          draft={draft}
+          today={today}
+          pricesIncludeVat={ready.pricesIncludeVat}
+        />
+      </Suspense>
+    );
+  }
+  if (!online && !order) {
+    return (
+      <div className="grid max-w-6xl grid-cols-1 gap-5">
+        <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
+        <EmptyState
+          icon={WifiDisconnected02Icon}
+          title={t('sync.needsConnectionTitle')}
+          description={t('sync.orderOffline')}
+        />
+      </div>
+    );
+  }
   if (isError) return <CantFind message={t('salesOrders.notFound')} />;
   if (!order || !ready) return null;
   if (order.status === 'draft' && canWrite) {
```

- **A waiting draft opens from the outbox first;** the server is asked only when there is none
  (`enabled: … && (db === null || draft === null)`), because the server does not know the order yet.
- **`import type { OutboxDraft }`**: a type only, so the form's chunk is not pulled into the page's.
- **`useReady()` reads "prices with VAT" from the device** (`deviceSettingsQuery`) when the server's settings never
  loaded.
- **Offline, a server order shows "Needs a connection"** with `sync.orderOffline`, and a new order without a
  complete copy shows the device's state.

### The lists

```diff
@@ -1,4 +1,5 @@
 import {
+  CloudUploadIcon,
   PlusSignIcon,
   Search01Icon,
   UserMultiple02Icon,
@@ -19,6 +20,7 @@ import {
   EmptyState,
   Input,
   PageHeader,
+  Pill,
   SegmentedControl,
   Select,
   type SortingState,
@@ -116,6 +118,13 @@ export function CustomersPage() {
     [settled, groupId, sort, limit],
   );
   const local = useLocalQuery(archived ? null : readPage);
+  // Step 18b: the customers with changes waiting on this device (decision 34). A customer made
+  // here has version 0: no page on the server yet, so it opens in its form.
+  const pending = local?.pending;
+  const madeHere = useMemo(
+    () => new Set(local?.rows.filter((row) => row.version === 0).map((row) => row.id)),
+    [local],
+  );
   // The archived tab: the server's pages, with their balances, online only (decision 11)
   const server = useInfiniteQuery({
     ...customerListQuery(tenantId, { search: settled, groupId, status, sort }),
@@ -126,7 +135,10 @@ export function CustomersPage() {
   // The balances of the rows shown (decision 10). Online and with the permission only: offline
   // the column shows a dash.
   const balances = useQueries({
-    queries: chunksOf(local?.rows.map((customer) => customer.id) ?? []).map((ids) => ({
+    // A customer made here has no balance on the server: it is not asked for
+    queries: chunksOf(
+      local?.rows.filter((row) => row.version !== 0).map((customer) => customer.id) ?? [],
+    ).map((ids) => ({
       ...customerBalancesQuery(tenantId, ids),
       enabled: canSeeBalance && online,
     })),
@@ -169,8 +181,16 @@ export function CustomersPage() {
               </span>
               <span className="grid min-w-0 max-w-[20rem]">
                 <span className="truncate font-medium">{row.original.name}</span>
-                <span className="truncate font-mono text-caption text-ink-3 tabular-nums">
-                  {row.original.code}
+                <span className="flex min-w-0 items-center gap-2">
+                  {/* No code yet: the server gives the next number when it arrives */}
+                  <span className="truncate font-mono text-caption text-ink-3 tabular-nums">
+                    {row.original.code === '' ? t('sync.noNumberYet') : row.original.code}
+                  </span>
+                  {pending?.has(row.original.id) && (
+                    <Pill tone="neutral" icon={CloudUploadIcon}>
+                      {t('sync.notSynced')}
+                    </Pill>
+                  )}
                 </span>
               </span>
             </span>
@@ -235,7 +255,7 @@ export function CustomersPage() {
             ]
           : []),
       ]),
-    [t, text, groupName, canSeeBalance, online],
+    [t, text, groupName, canSeeBalance, online, pending],
   );
 
   const empty =
@@ -345,7 +365,12 @@ export function CustomersPage() {
           getRowId={(customer) => customer.id}
           sorting={{ state: sorting, onChange: setSorting }}
           onRowClick={(customer) =>
-            void navigate({ to: '/customers/$customerId', params: { customerId: customer.id } })
+            void (madeHere.has(customer.id)
+              ? navigate({
+                  to: '/customers/$customerId/edit',
+                  params: { customerId: customer.id },
+                })
+              : navigate({ to: '/customers/$customerId', params: { customerId: customer.id } }))
           }
           onEndReached={loadMore}
           maxHeight={640}
```

- **"Not synced"** beside the code of every customer the outbox changes (`local.pending`), and "No number yet" for
  a code the server has not given.
- **`madeHere`**: version 0 is a customer made on this device (`overlay.ts`). It opens in its form, and its
  balance is not asked for: the server does not know it.

```tsx
import { Alert02Icon, Clock01Icon, CloudUploadIcon } from '@hugeicons/core-free-icons';
import type { CustomerField } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { OutboxEntry, OutboxStatus } from '@omnivo/sync';
import { Pill } from '@omnivo/ui';
import { useCallback } from 'react';

// Step 18b: the outbox as the screens show it, on the Sync page and above the sales orders list.
// No Dexie here: the entries come through useLocalQuery.

// Three pills, not four (18b.5): a command that waits for another one is `waiting` too, with a
// line that says for which. Waiting and sending are work in progress (brand); a refused command
// needs the person (warn), CLAUDE.md → Sales document statuses.
const PILLS = {
  waiting: { tone: 'brand', icon: Clock01Icon },
  sending: { tone: 'brand', icon: CloudUploadIcon },
  failed: { tone: 'warn', icon: Alert02Icon },
} as const satisfies Record<OutboxStatus, { tone: string; icon: unknown }>;

export function OutboxStatusPill({ status }: { status: OutboxStatus }) {
  const { t } = useLocale();
  const pill = PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`sync.statuses.${status}`)}
    </Pill>
  );
}

// "Not synced": a customer or an order that is only on this device so far
export function NotSyncedPill() {
  const { t } = useLocale();
  return (
    <Pill tone="neutral" icon={CloudUploadIcon}>
      {t('sync.notSynced')}
    </Pill>
  );
}

// The form's own labels for the fields of a change, so the Sync page says "Phone and Credit limit"
// in the words of the boxes the person filled in. satisfies: a new field in the contract does not
// compile until it has its label here.
const FIELD_LABELS = {
  code: 'customers.fields.code',
  name: 'customers.fields.name',
  groupId: 'customers.fields.group',
  contactPerson: 'customers.fields.contactPerson',
  phone: 'customers.fields.phone',
  email: 'customers.fields.email',
  documentLanguage: 'customers.fields.documentLanguage',
  bin: 'customers.fields.bin',
  paymentTermsDays: 'customers.fields.paymentTerms',
  creditLimit: 'customers.fields.creditLimit',
  priceListId: 'customers.fields.priceList',
  notes: 'customers.fields.notes',
} as const satisfies Record<CustomerField, string>;

function isCustomerField(field: string): field is CustomerField {
  return Object.hasOwn(FIELD_LABELS, field);
}

// Field names as one line in the page's language ("Phone and Credit limit" / "ফোন ও ক্রেডিট লিমিট")
export function useFieldList(): (fields: readonly string[]) => string {
  const { t, language } = useLocale();
  return useCallback(
    (fields) =>
      new Intl.ListFormat(language === 'bn' ? 'bn-BD' : 'en', { type: 'conjunction' }).format(
        fields.map((field) => (isCustomerField(field) ? t(FIELD_LABELS[field]) : field)),
      ),
    [t, language],
  );
}

// The two lines of an entry: what it is ("Changes to Rahman Traders") and how big ("Changed:
// Phone and Credit limit", "3 lines · ৳4,140")
export function useCommandText(): (entry: OutboxEntry) => { title: string; detail: string } {
  const { t, format } = useLocale();
  const fieldList = useFieldList();
  return useCallback(
    (entry) => {
      const { command } = entry;
      const title = t(`sync.commands.${command.type}`, { name: entry.name });
      switch (command.type) {
        case 'customer.create':
          return { title, detail: '' };
        case 'customer.update': {
          const { add, remove, change } = command.addresses;
          const fields: string[] = Object.keys(command.changes);
          if (add.length + remove.length + change.length > 0) {
            fields.push(t('customers.sections.addresses'));
          }
          return { title, detail: t('sync.changedFields', { fields: fieldList(fields) }) };
        }
        case 'sales_order.create_draft':
          return {
            title,
            detail: t('sync.orderLines', {
              count: entry.lines ?? 0,
              formatted: format.number(entry.lines ?? 0),
              total: format.money(entry.total ?? '0'),
            }),
          };
      }
    },
    [t, format, fieldList],
  );
}
```

- **Three pills** (18b.5): waiting and sending are work in progress (`brand`), a refusal needs the person
  (`warn`), as CLAUDE.md says of the sales statuses. "Not synced" is neutral: it only says where the data is.
- **`FIELD_LABELS … satisfies Record<CustomerField, string>`**: a new customer field in the contract does not
  compile until the Sync page can name it.
- **`useFieldList()`** joins the labels with `Intl.ListFormat` in the page's language ("Phone and Credit limit").
- **`useCommandText()`** is the switch on the command type; TypeScript checks that every type has a case.

```diff
@@ -1,13 +1,19 @@
-import { PlusSignIcon, ShoppingCart01Icon } from '@hugeicons/core-free-icons';
+import {
+  PlusSignIcon,
+  ShoppingCart01Icon,
+  WifiDisconnected02Icon,
+} from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { ORDER_STATUSES, type OrderStatus, type SalesOrderSummary } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
+import { type OutboxEntry, outboxEntries, type SyncDatabase } from '@omnivo/sync';
 import {
   Button,
   DataTable,
   dataTableColumns,
   EmptyState,
   PageHeader,
+  SectionHeader,
   SegmentedControl,
 } from '@omnivo/ui';
 import { useInfiniteQuery } from '@tanstack/react-query';
@@ -17,11 +23,102 @@ import { useCallback, useMemo, useState } from 'react';
 import { CustomerFilter } from '../components/customer-filter';
 import { OrderStatusPills } from '../components/sales-pills';
 import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
+import { NotSyncedPill, OutboxStatusPill } from '../components/sync-parts';
+import { useLocalDb, useLocalQuery } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
 import { salesOrdersQuery } from '../lib/queries';
+import { useOnline } from '../lib/use-online';
 
 const column = dataTableColumns<SalesOrderSummary>();
 
+// Step 18b (decision 3): the drafts written on this device that the server does not have yet, read
+// from the outbox, online and offline. Opening one opens its waiting command in the form.
+interface UnsyncedOrder {
+  id: string;
+  entry: OutboxEntry;
+  date: string;
+}
+
+const unsyncedColumn = dataTableColumns<UnsyncedOrder>();
+
+// A stable read (useLocalQuery): the outbox's orders, oldest first
+const readUnsynced = async (db: SyncDatabase) =>
+  (await outboxEntries(db)).flatMap((entry): UnsyncedOrder[] =>
+    entry.command.type === 'sales_order.create_draft'
+      ? [{ id: entry.key, entry, date: entry.command.input.date }]
+      : [],
+  );
+
+function UnsyncedOrders() {
+  const { t, format } = useLocale();
+  const navigate = useNavigate();
+  const isoDate = useIsoDate();
+  const db = useLocalDb();
+  const rows = useLocalQuery(db ? readUnsynced : null);
+  const columns = useMemo(
+    () =>
+      unsyncedColumn.columns([
+        unsyncedColumn.accessor('date', {
+          id: 'number',
+          header: t('salesOrders.columns.number'),
+          enableSorting: false,
+          meta: { card: 'title' },
+          cell: ({ row }) => (
+            <span className="grid">
+              <span className="font-medium text-ink-3">{t('sync.noNumberYet')}</span>
+              <span className="text-caption text-ink-3 tabular-nums">
+                {isoDate(row.original.date)}
+              </span>
+            </span>
+          ),
+        }),
+        unsyncedColumn.accessor((order) => order.entry.name, {
+          id: 'customer',
+          header: t('salesOrders.columns.customer'),
+          enableSorting: false,
+          meta: { card: 'subtitle' },
+          cell: ({ getValue }) => (
+            <span className="block max-w-[18rem] truncate">{getValue()}</span>
+          ),
+        }),
+        unsyncedColumn.accessor((order) => order.entry.total ?? '0', {
+          id: 'total',
+          header: t('salesOrders.columns.total'),
+          enableSorting: false,
+          meta: { align: 'end', card: 'detail' },
+          cell: ({ getValue }) => format.money(getValue()),
+        }),
+        unsyncedColumn.accessor((order) => order.entry.status, {
+          id: 'status',
+          header: t('salesOrders.columns.status'),
+          enableSorting: false,
+          meta: { card: 'trailing' },
+          // A refused draft says so; one that only waits is "Not synced"
+          cell: ({ getValue }) => {
+            const status = getValue();
+            return status === 'failed' ? <OutboxStatusPill status={status} /> : <NotSyncedPill />;
+          },
+        }),
+      ]),
+    [t, format, isoDate],
+  );
+  if (!rows || rows.length === 0) return null;
+  return (
+    <section className="grid grid-cols-1 gap-3">
+      <SectionHeader title={t('sync.unsyncedTitle')} subtitle={t('sync.unsyncedSubtitle')} />
+      <DataTable
+        label={t('sync.unsyncedTitle')}
+        data={rows}
+        columns={columns}
+        getRowId={(row) => row.id}
+        onRowClick={(row) =>
+          void navigate({ to: '/sales-orders/$orderId', params: { orderId: row.id } })
+        }
+      />
+    </section>
+  );
+}
+
 export function SalesOrdersPage() {
   const { t, format } = useLocale();
   const navigate = useNavigate();
@@ -30,6 +127,7 @@ export function SalesOrdersPage() {
   const today = useToday();
   const [status, setStatus] = useState<OrderStatus | ''>('');
   const [customerId, setCustomerId] = useState('');
+  const online = useOnline();
   const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
     salesOrdersQuery(useTenantId(), { status, customerId }),
   );
@@ -135,8 +233,17 @@ export function SalesOrdersPage() {
           onChange={setStatus}
         />
       </div>
+      <UnsyncedOrders />
       {isError && <p className="text-body-sm text-crit">{t('salesOrders.loadFailed')}</p>}
-      {rows && (
+      {/* The server's list offline: what it showed a minute ago may be wrong by now */}
+      {!online && (
+        <EmptyState
+          icon={WifiDisconnected02Icon}
+          title={t('sync.needsConnectionTitle')}
+          description={t('sync.ordersOffline')}
+        />
+      )}
+      {online && rows && (
         <DataTable
           label={t('salesOrders.title')}
           data={rows}
```

- **`UnsyncedOrders`** reads the outbox's orders live and draws them as a data table under a section header
  (decision 3). It draws nothing when there are none.
- **A refused draft shows its "Needs attention" pill,** a waiting one "Not synced".
- **Offline, the server's list is "Needs a connection"** (`sync.ordersOffline`): its cached pages may be wrong by
  now, and the drafts on the device are right above.

### The Sync page

```tsx
import {
  Alert02Icon,
  ArrowReloadHorizontalIcon,
  CloudSavingDone01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import {
  dependentsOf,
  discardEntry,
  dismissNotice,
  isOpen,
  type OutboxEntry,
  outboxEntries,
  readPullState,
  retryEntry,
  syncNotices,
} from '@omnivo/sync';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { LocalState } from '../components/local-state';
import { useTenantId, useTimeZone } from '../components/stock-parts';
import { OutboxStatusPill, useCommandText, useFieldList } from '../components/sync-parts';
import {
  requestSync,
  useLocalData,
  useLocalDb,
  useLocalQuery,
  useSyncStatus,
} from '../lib/local-data';
import { useOnline } from '../lib/use-online';

// Step 18b (decision 1): the work saved on this device, oldest first, as the push sends it; what
// the server kept from a change; and when the device last synced. Retry, Edit and Discard per
// change, and "Sync now".

// The earlier command an entry waits for (decision 13): one on the same customer still on the
// device. Only a waiting entry waits; a refused one says why it was refused instead.
function waitsFor(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry | undefined {
  if (entry.status !== 'waiting' || entry.seq === undefined) return undefined;
  const { seq } = entry;
  return entries.find((other) => other.customerId === entry.customerId && (other.seq ?? 0) < seq);
}

// Where Edit opens a command: the customer's form, or the order's
function EditLink({ entry }: { entry: OutboxEntry }) {
  const { t } = useLocale();
  const className =
    'inline-flex min-h-9 items-center rounded-control border border-line-strong bg-surface px-3 text-body-sm font-medium text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';
  return entry.command.type === 'sales_order.create_draft' ? (
    <Link to="/sales-orders/$orderId" params={{ orderId: entry.key }} className={className}>
      {t('sync.edit')}
    </Link>
  ) : (
    <Link
      to="/customers/$customerId/edit"
      params={{ customerId: entry.customerId }}
      className={className}
    >
      {t('sync.edit')}
    </Link>
  );
}

export function SyncPage() {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const online = useOnline();
  const timeZone = useTimeZone();
  const { view } = useLocalData();
  const status = useSyncStatus();
  const db = useLocalDb();
  const entries = useLocalQuery(db ? outboxEntries : null);
  const notices = useLocalQuery(db ? syncNotices : null);
  const pull = useLocalQuery(readPullState);
  const commandText = useCommandText();
  const fieldList = useFieldList();
  const [discarding, setDiscarding] = useState<OutboxEntry | null>(null);
  const dependents = discarding && entries ? dependentsOf(entries, discarding).length : 0;

  const retry = async (entry: OutboxEntry) => {
    if (!db || entry.seq === undefined) return;
    await retryEntry(db, entry.seq);
    requestSync();
  };

  const discard = async (entry: OutboxEntry) => {
    if (!db || entry.seq === undefined) return;
    const result = await discardEntry(db, entry.seq);
    setDiscarding(null);
    if (result === 'busy') {
      toast(t('sync.busy'));
      return;
    }
    // A customer made here leaves the lists and the pickers
    await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
    toast(t('sync.discarded'));
  };

  const lastSync = pull?.lastSyncAt ?? null;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('sync.title')}
        description={t('sync.description')}
        actions={
          <Button
            disabled={!online || !db || status.syncing}
            onClick={() => {
              requestSync();
            }}
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={17} strokeWidth={1.5} />
            {status.syncing ? t('sync.syncing') : t('sync.syncNow')}
          </Button>
        }
      />
      <p className="text-body-sm text-ink-2 tabular-nums">
        {lastSync === null
          ? t('sync.neverSynced')
          : t('sync.lastSynced', { time: format.dateTime(new Date(lastSync), timeZone) })}
        {!online && ` · ${t('sync.syncNowOffline')}`}
      </p>

      {!db && view.kind !== 'ready' && <LocalState view={view} />}

      {notices && notices.length > 0 && (
        <Card>
          <CardHeader title={t('sync.noticesTitle')} subtitle={t('sync.noticesSubtitle')} />
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {notices.map((notice) => (
              <li
                key={notice.commandId}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
              >
                <span className="grid min-w-0">
                  <span className="text-body-sm font-medium">{notice.name}</span>
                  <span className="text-caption text-ink-3">
                    {t('sync.keptFields', { fields: fieldList(notice.fields) })}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
                  onClick={() => {
                    if (db) void dismissNotice(db, notice.commandId);
                  }}
                >
                  {t('sync.dismiss')}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {entries && (
        <Card>
          <CardHeader title={t('sync.changesTitle')} subtitle={t('sync.changesSubtitle')} />
          {entries.length === 0 ? (
            <div className="py-6">
              <EmptyState
                icon={CloudSavingDone01Icon}
                title={t('sync.emptyTitle')}
                description={t('sync.emptyBody')}
              />
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {entries.map((entry) => {
                const text = commandText(entry);
                const before = waitsFor(entries, entry);
                return (
                  <li
                    key={entry.seq}
                    className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="grid min-w-0 content-start gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-body-sm font-medium">{text.title}</span>
                        <OutboxStatusPill status={entry.status} />
                      </span>
                      <span className="text-caption text-ink-3 tabular-nums">
                        {[
                          t('sync.savedAt', {
                            time: format.dateTime(new Date(entry.savedAt), timeZone),
                          }),
                          text.detail,
                        ]
                          .filter((part) => part !== '')
                          .join(' · ')}
                      </span>
                      {before && (
                        <span className="text-caption text-ink-2">
                          {t('sync.waitsFor', { name: before.name })}
                        </span>
                      )}
                      {entry.status === 'failed' && entry.error && (
                        <span className="flex items-start gap-1.5 text-label text-crit">
                          <HugeiconsIcon
                            icon={Alert02Icon}
                            size={15}
                            strokeWidth={1.5}
                            className="mt-px shrink-0"
                          />
                          <span>
                            {errorText(entry.error.code)} {t('sync.fixHint')}
                          </span>
                        </span>
                      )}
                    </div>
                    {/* Nothing to do with a command on its way: its answer decides */}
                    {entry.status !== 'sending' && (
                      <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                        {isOpen(entry) && <EditLink entry={entry} />}
                        {entry.status === 'failed' && (
                          <Button variant="secondary" size="sm" onClick={() => void retry(entry)}>
                            {t('common.retry')}
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setDiscarding(entry);
                          }}
                        >
                          {t('sync.discard')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <Dialog
        open={discarding !== null}
        onOpenChange={(open) => {
          if (!open) setDiscarding(null);
        }}
      >
        {discarding && (
          <DialogContent
            title={t('sync.discardTitle')}
            description={commandText(discarding).title}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button onClick={() => void discard(discarding)}>{t('sync.discardConfirm')}</Button>
              </>
            }
          >
            <p className="text-body-sm text-ink-2">
              {t('sync.discardBody')}
              {dependents > 0 &&
                ` ${t('sync.discardDependents', {
                  count: dependents,
                  formatted: format.number(dependents),
                })}`}
            </p>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
```

- **The rows are the outbox in order,** as the push sends them. Each says what it is, when it was saved (the
  device's clock, decision 6: shown, never sent), what changed, its pill, and, for a waiting command, what it waits
  for (`waitsFor()`, decision 13).
- **A refused row shows its error in the page's language** with the fix hint, in `crit` with an icon.
- **Edit** only for an open command (decision 33), as a link to the customer's form or the order. **Retry** only
  for a refused one. **Discard** for anything not being sent; the dialog says how many dependents go with it.
- **Discard refreshes the customer queries:** a customer made on the device disappears from the boxes.
- **"Sync now"** asks the engine for a sync, and says "Syncing…" while one runs. It is disabled offline, and the
  line under the title says why.
- **The last sync is the server's time** (`lastSyncAt`, 18a decision 19), shown in the company's time zone.

```diff
@@ -641,6 +641,13 @@ const approvalsRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/approvals'), 'ApprovalsPage'),
 });
 
+// Step 18b: the outbox and the last sync of this device
+const syncRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/sync',
+  component: lazyRouteComponent(() => import('./routes/sync'), 'SyncPage'),
+});
+
 // Step 17b: purchase orders ("Make purchase order" on a requisition comes with ?requisitionId=) and
 // goods receipts ("Receive goods" on an order comes with ?orderId=). '/…/new' beats '/…/$id'.
 const purchaseOrdersRoute = createRoute({
@@ -941,6 +948,7 @@ const routeTree = rootRoute.addChildren([
     newRequisitionRoute,
     requisitionRoute,
     approvalsRoute,
+    syncRoute,
     purchaseOrdersRoute,
     newPurchaseOrderRoute,
     purchaseOrderRoute,
```

### The shell, sign-out, the branch dialog, the audit log

```diff
@@ -54,6 +54,8 @@ import {
   UserGroupIcon,
   UserMultiple02Icon,
   WarehouseIcon,
+  Wifi01Icon,
+  WifiDisconnected02Icon,
   WorkHistoryIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
@@ -86,13 +88,21 @@ import { logout, switchTenant } from '../lib/session';
 import { useCan } from '../lib/permissions';
 import { waitingCountQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
+import { useSyncSummary } from '../lib/sync-summary';
 import { isTheme } from '../lib/theme';
+import { useOnline } from '../lib/use-online';
 
 // Step 18a: the device and its copy of the data (Dexie, the sync engine, the branch dialog) in a
 // chunk of their own. The shell draws at once; the copy starts a moment later.
 const LocalDataHost = lazy(async () => ({
   default: (await import('../components/local-data-host')).LocalDataHost,
 }));
+// Step 18b: the question before signing out with changes on the device. Loaded when it is asked:
+// the dialog's code (about 14 KB gz with its focus trap and scroll lock) took the shell over its
+// budget, for a dialog most sessions never open.
+const SignOutDialog = lazy(async () => ({
+  default: (await import('../components/sign-out-dialog')).SignOutDialog,
+}));
 
 // ui-র সাধারণ <a> → TanStack-এর টাইপ-চেকড লিংক: to="/kitchn-sink" লিখলে compile error,
 // আর সক্রিয় রুটে Link নিজেই aria-current="page" বসায়
@@ -194,8 +204,36 @@ function WorkspaceSwitcher() {
   );
 }
 
+// Step 18b (decision 1): the sidebar line. It says whether the device is online, and how many
+// changes wait (a refused one first, in crit, since the person must act on it). It links to the
+// Sync page. The screen reader hears the whole sentence, not "Offline 3".
+function SyncNavItem() {
+  const { t, format } = useLocale();
+  const online = useOnline();
+  const { syncing, waiting: total, failed } = useSyncSummary();
+  const state = !online ? t('sync.offline') : syncing ? t('sync.syncing') : t('sync.online');
+  const count = failed > 0 ? failed : total;
+  const counted =
+    failed > 0
+      ? t('sync.needsAttention', { count: failed, formatted: format.number(failed) })
+      : total > 0
+        ? t('sync.waiting', { count: total, formatted: format.number(total) })
+        : t('sync.allSynced');
+  return (
+    <NavLink
+      to="/sync"
+      icon={online ? Wifi01Icon : WifiDisconnected02Icon}
+      count={count > 0 ? count : undefined}
+      countTone={failed > 0 ? 'crit' : 'neutral'}
+      aria-label={`${t('nav.sync')}: ${state}, ${counted}`}
+    >
+      {state}
+    </NavLink>
+  );
+}
+
 // ডেস্কটপের সাইডবার-তলা আর ফোনের টপ বার — দুই trigger, একই মেনু
-function UserMenuContent({ align }: { align: 'start' | 'end' }) {
+function UserMenuContent({ align, onSignOut }: { align: 'start' | 'end'; onSignOut: () => void }) {
   const { t, language } = useLocale();
   const theme = useSession((state) => state.me?.preferences.theme ?? 'system');
   return (
@@ -231,12 +269,7 @@ function UserMenuContent({ align }: { align: 'start' | 'end' }) {
         ))}
       </DropdownMenuRadioGroup>
       <DropdownMenuSeparator />
-      <DropdownMenuItem
-        icon={Logout01Icon}
-        onSelect={() => {
-          void logout();
-        }}
-      >
+      <DropdownMenuItem icon={Logout01Icon} onSelect={onSignOut}>
         {t('common.signOut')}
       </DropdownMenuItem>
     </DropdownMenuContent>
@@ -252,6 +285,13 @@ export function AppShell() {
   const can = useCan();
   // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
   const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
+  // Step 18b: sign out at once with nothing on the device, else ask
+  const { waiting: unsynced } = useSyncSummary();
+  const [asking, setAsking] = useState(false);
+  const signOut = () => {
+    if (unsynced > 0) setAsking(true);
+    else void logout();
+  };
 
   // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
   useEffect(() => {
@@ -267,7 +307,7 @@ export function AppShell() {
           <DropdownMenuTrigger asChild>
             <IconButton icon={UserCircleIcon} label={t('shell.account')} />
           </DropdownMenuTrigger>
-          <UserMenuContent align="end" />
+          <UserMenuContent align="end" onSignOut={signOut} />
         </DropdownMenu>
       }
       sidebarHeader={<WorkspaceSwitcher />}
@@ -278,6 +318,7 @@ export function AppShell() {
             <NavLink to="/" icon={DashboardSquare01Icon} activeOptions={{ exact: true }}>
               {t('nav.overview')}
             </NavLink>
+            <SyncNavItem />
             {import.meta.env.DEV && (
               <NavLink to="/kitchen-sink" icon={LayoutGridIcon}>
                 {t('nav.kitchenSink')}
@@ -530,11 +571,21 @@ export function AppShell() {
               />
             </button>
           </DropdownMenuTrigger>
-          <UserMenuContent align="start" />
+          <UserMenuContent align="start" onSignOut={signOut} />
         </DropdownMenu>
       }
     >
       <Outlet />
+      {asking && (
+        <Suspense fallback={null}>
+          <SignOutDialog
+            count={unsynced}
+            onClose={() => {
+              setAsking(false);
+            }}
+          />
+        </Suspense>
+      )}
       {/* No fallback: the host draws nothing until a branch dialog is needed */}
       <Suspense fallback={null}>
         <LocalDataHost />
```

- **`SyncNavItem`** is the sidebar line (decision 1): "Online", "Syncing…" or "Offline" with its icon, and the
  count. With a refused command, the count is the refused ones, in `crit`, and the screen-reader label says they
  need attention; otherwise the count is all waiting commands. The link goes to the Sync page. It is the second
  item, right under Overview, so on a phone it is in sight in the row of the top bar.
- **Sign-out asks first when commands are still on the device;** with none, it signs out at once, as before.
- **`SignOutDialog` is lazy** (decision 41).

```tsx
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogClose, DialogContent } from '@omnivo/ui';

import { logout } from '../lib/session';

// Signing out deletes the device's copy, and the outbox with it (18a, decision 41): with changes
// still on the device, the person is asked first
export function SignOutDialog({ count, onClose }: { count: number; onClose: () => void }) {
  const { t, format } = useLocale();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('sync.signOutTitle')}
        footer={
          <>
            {/* The way that loses work is the secondary one, pushed left (CLAUDE.md → Dialog) */}
            <Button
              variant="secondary"
              className="mr-auto"
              onClick={() => {
                onClose();
                void logout();
              }}
            >
              {t('sync.signOutAnyway')}
            </Button>
            <DialogClose asChild>
              <Button>{t('sync.stay')}</Button>
            </DialogClose>
          </>
        }
      >
        <p className="text-body-sm text-ink-2">
          {t('sync.signOutBody', { count, formatted: format.number(count) })}
        </p>
      </DialogContent>
    </Dialog>
  );
}
```

"Sign out anyway" is the secondary button pushed to the left (CLAUDE.md → Dialog: the action that loses work goes
there); "Stay signed in" is the primary one, and Esc or the backdrop also stay.

```diff
@@ -1,10 +1,16 @@
-import { useEffect } from 'react';
+import { lazy, Suspense, useEffect } from 'react';
 import { useStore } from 'zustand';
 
 import { localDataStore, useDeviceState } from '../lib/local-data';
-import { startLocalData } from '../lib/local-session';
+import { chooseBranch, chooseLater, startLocalData } from '../lib/local-session';
+import { preloadOfflineScreens } from '../lib/offline-screens';
 import { useSession } from '../lib/session-store';
-import { DeviceBranchDialog } from './device-branch-dialog';
+
+// Step 18b: loaded when it opens, once per device at most. The push took this chunk (with Dexie)
+// over its budget, and the dialog's code is 14 KB gz of it.
+const DeviceBranchDialog = lazy(async () => ({
+  default: (await import('./device-branch-dialog')).DeviceBranchDialog,
+}));
 
 // Step 18a: the device and its copy of the data, for the person signed in now. Rendered once,
 // inside the AppShell, and loaded lazily with Dexie: the login page never downloads it. A switch
@@ -20,7 +26,22 @@ export function LocalDataHost() {
     return startLocalData({ tenantId, userId });
   }, [tenantId, userId]);
 
+  // Step 18b (decision 42): the offline screens' code, while there is a connection
+  useEffect(() => {
+    preloadOfflineScreens();
+    window.addEventListener('online', preloadOfflineScreens);
+    return () => {
+      window.removeEventListener('online', preloadOfflineScreens);
+    };
+  }, []);
+
   return asking && device.kind === 'not-set-up' ? (
-    <DeviceBranchDialog branches={device.branches} />
+    <Suspense fallback={null}>
+      <DeviceBranchDialog
+        branches={device.branches}
+        chooseBranch={chooseBranch}
+        chooseLater={chooseLater}
+      />
+    </Suspense>
   ) : null;
 }
```

The second `useEffect` loads the code of the offline screens (decision 42). 18b.7's tests found it was needed; its
file, `lib/offline-screens.ts`, is explained there.

```diff
@@ -1,12 +1,16 @@
 import { zodResolver } from '@hookform/resolvers/zod';
 import { Store01Icon } from '@hugeicons/core-free-icons';
-import { type Branch, contractErrorMap, registerDeviceInputSchema } from '@omnivo/contracts';
+import {
+  type Branch,
+  contractErrorMap,
+  type Device,
+  registerDeviceInputSchema,
+} from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { Button, Dialog, DialogContent, FormAlert, SelectField, toast } from '@omnivo/ui';
 import { useForm } from 'react-hook-form';
 
 import { applyApiError } from '../lib/field-errors';
-import { chooseBranch, chooseLater } from '../lib/local-session';
 
 // Only the branch is the person's to choose: the id and the name come from the browser
 const branchFormSchema = registerDeviceInputSchema.pick({ branchId: true });
@@ -15,7 +19,17 @@ const FIELD_NAMES = branchFormSchema.keyof().options;
 // "Which branch is this device in?" (decision 12), once, after sign-in, for a workspace with more
 // than one branch. Closing it any way (Esc, the backdrop, "Not now") is "Not now" (decision 40):
 // the products and customers pages then offer it again with a button.
-export function DeviceBranchDialog({ branches }: { branches: readonly Branch[] }) {
+// Step 18b: the session's two answers come as props from the host, which has the session already.
+// An import of local-session here would count Dexie into this lazy chunk a second time.
+export function DeviceBranchDialog({
+  branches,
+  chooseBranch,
+  chooseLater,
+}: {
+  branches: readonly Branch[];
+  chooseBranch: (branchId: string) => Promise<Device | null>;
+  chooseLater: () => void;
+}) {
   const { t } = useLocale();
   const {
     register,
```

The branch dialog of 18a is lazy now too, and gets `chooseBranch` and `chooseLater` from the host. With the push,
the host's chunk went over its budget; the dialog's code is a large part of it and opens once per device at most.
Importing `local-session` in the dialog itself would count Dexie into its own lazy chunk again.

```diff
@@ -101,7 +101,13 @@ export function AuditLogPage() {
             <span className="min-w-0">
               <span className="block truncate font-medium">{getValue()}</span>
               <span className="block truncate text-caption text-ink-3 tabular-nums">
-                {format.dateTime(new Date(row.original.createdAt), timeZone)}
+                {/* Step 18b (decision 20): a change sent from a device's outbox names the device */}
+                {row.original.device
+                  ? t('audit.fromDevice', {
+                      time: format.dateTime(new Date(row.original.createdAt), timeZone),
+                      device: row.original.device.name,
+                    })
+                  : format.dateTime(new Date(row.original.createdAt), timeZone)}
               </span>
             </span>
           </span>
```

A change sent from a device's outbox says so under the person's name (decision 20): "Sep 23, 2026, 09:12 PM ·
from Counter 1".

### The budget

```diff
@@ -13,8 +13,10 @@ const INITIAL_BUDGET = 210 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
-// pages is the real fix, a step of its own, like the words above.
-const CHUNK_BUDGET = 105 * 1024;
+// pages is the real fix, a step of its own, like the words above. Step 18b: 110 KB (you chose this).
+// The customer box and the pickers now read the device's customers with the outbox on top, and the
+// line editors and the shell were already at 104–105 KB.
+const CHUNK_BUDGET = 110 * 1024;
 
 const dist = path.resolve(import.meta.dirname, '../dist');
 
```

A lazy chunk may be 110 KB now (you chose this). The customer box and the pickers read the device's customers
with the outbox on top, and the line editors and the shell were at 104–105 KB before this step. The real fix is
still the one 17d named: each module's routes loaded with its own pages.

### Check this part

```bash
pnpm --filter @omnivo/sync typecheck
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
```

Build `@omnivo/sync` and `@omnivo/i18n` before the app's type check: the app reads their built types. The app's
type check still shows the one MSW error of 18b.5 (`src/mocks/workspace-data.ts`), so `pnpm --filter @omnivo/app
build` stops at its `tsc` step until 18b.7; to measure the bundle now, run `npx vite build` in `apps/app`, then the
bundle check.

To see it work against the real API, run `pnpm dev`, sign in, and open Customers. Turn the network off in the
browser tools' Network tab: the sidebar says "Offline". Add a customer and change another: both show "Not synced",
and the sidebar counts 2. Write an order for the new customer: it is listed above the orders, "On this device ·
not synced". Turn the network back on: the sidebar says "Syncing…", a toast says "3 changes synced", the new
customer has its C- number, and the order is a draft in the server's list.

> **What we checked in this part.** `packages/sync` type-checks, ESLint and Prettier are clean, and its 57 unit tests
> pass (18a's 35, and outbox 10, push 7, prices 2, the version 2 upgrade 1, the overlay 2, with `fake-indexeddb`).
> The app type-checks except the one MSW error that 18b.7 fixes, ESLint and Prettier are clean, its 142 unit tests
> pass, `vite build` builds it, the bundle check passes (first load 208.6 KB gz; the largest lazy chunk
> `debit-note-lines` 106.7 KB under the new 110 KB; the host with Dexie 66.6 KB, the Sync page 76.5 KB), and
> dependency-cruiser finds no violation. Two rules were broken on purpose, one at a time, and tests failed each
> time: holding a customer only behind a refused command (not behind one in the same batch) failed 3 tests, among
> them "sends a new customer, then its order in the next round"; folding a second edit from the form's base
> instead of the first change's base failed the fold test. Not checked yet: the screens in a browser and the push
> against the real API. 18b.7 adds the mock API's push and the end-to-end tests; 18b.8 runs the app against the
> real API once.

---

## 18b.7 — `apps/app`: the mock API's push and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). After 18b.6
the app sends the outbox to `POST /sync/push`, which the mock did not have: every change saved offline stayed
"Waiting" for good. This part gives the mock the push, with the API's rules on its own arrays, fixes the one type
error 18b.5 left (the audit entries' `device`), and adds one test file for the outbox: a customer and an order
saved offline, a refused change fixed and sent again, a discard that takes the order with it, a change to a
customer made offline, and signing out with changes on the device.

The new tests found two mistakes in 18b.6, both fixed above, in 18b.6's files:

- **A customer made on the device could not be saved again.** Its form's version was 0, which the form's schema
  refuses, so "Save on this device" did nothing and said nothing. The fix is the `version` line of 18b.6's
  `customer-form.tsx`.
- **A screen the browser had not opened yet could not open offline.** Each page's code is a chunk loaded when the
  page first opens, and offline that load fails: "Add customer" opened online had worked, the same click after the
  connection dropped showed nothing. The fix is decision 42 and the new `lib/offline-screens.ts` below, called by
  18b.6's `local-data-host.tsx`.

The files, in the order to write them: each one only uses files above it.

### The audit entries' device: `mocks/workspace-data.ts`

```diff
@@ -322,6 +322,8 @@ export function record(
   entityType: AuditEntityType,
   entityId: string,
   changes: AuditChanges = {},
+  // Step 18b: the device a pushed command came from; null for everything done online
+  device: AuditEntry['device'] = null,
 ): void {
   // নতুন আগে — আসল API-র ক্রম
   data.audit.unshift({
@@ -330,6 +332,7 @@ export function record(
     entityType,
     entityId,
     actor: { id: OWNER.id, fullName: OWNER.fullName },
+    device,
     changes,
     ipAddress: '103.4.145.2',
     requestId: crypto.randomUUID(),
```

- **`device` on every audit entry** (18b.1's contract): `null` for everything done online, which is everything the
  mock does except a push. This is the one error the app's type check showed since 18b.5.
- **A parameter with a default, not a second function:** the hundred `record()` calls of the mock stay as they are,
  and the push passes the device.

### A device's ids kept: `mocks/sales-data.ts`, `mocks/sales-document-data.ts`

```diff
@@ -535,11 +535,14 @@ function newCode(data: WorkspaceData): string {
 
 // Create (no `existing`) or update. The addresses sent replace the old ones; one sent back with
 // its id keeps it, one with an id that is not this customer's becomes a new address. The billing
-// address comes first, then the shipping ones in the order sent.
+// address comes first, then the shipping ones in the order sent. Step 18b: a save from a device
+// (`device`) keeps the ids the device made, for a new customer and its new addresses, because an
+// order written on the same device already points at them. push-data.ts has checked they are free.
 export function saveCustomer(
   data: WorkspaceData,
   input: CustomerInput,
   existing?: MockCustomer,
+  device?: { customerId: string },
 ): MockCustomer {
   const { sales } = data;
   if (input.groupId !== null && !sales.groups.some((item) => item.id === input.groupId)) {
@@ -561,14 +564,17 @@ export function saveCustomer(
   }
   const own = new Set(existing?.addresses.map((address) => address.id));
   const addresses = input.addresses.map((address) => ({
-    id: address.id !== null && own.has(address.id) ? address.id : crypto.randomUUID(),
+    id:
+      address.id !== null && (own.has(address.id) || device !== undefined)
+        ? address.id
+        : crypto.randomUUID(),
     kind: address.kind,
     label: address.label,
     address: address.address,
     phone: address.phone,
   }));
   return {
-    id: existing?.id ?? crypto.randomUUID(),
+    id: existing?.id ?? device?.customerId ?? crypto.randomUUID(),
     code,
     name: input.name,
     groupId: input.groupId,
```

- **`device` keeps the ids the device made** (decision 20): the customer's own, and every address id as sent. An
  order written on the same device may already point at an address (`shippingAddressId`), so a new id given here
  would break it. Without `device`, an id the customer does not have still becomes a new id, as before: that is
  what the form sends for a new address online (`id: null`).
- **`existing?.id ?? device?.customerId`:** a change keeps the customer's id; only a new one takes the device's.

```diff
@@ -526,17 +526,19 @@ function openQuotation(data: WorkspaceData, quotationId: string, customerId: str
   return quotation;
 }
 
+// Step 18b: an order written on a device comes with the id the device made (push-data.ts)
 export function createOrder(
   data: WorkspaceData,
   input: OrderFields,
   quotationId: string | null,
+  id: string = crypto.randomUUID(),
 ): MockOrder {
   const customer = customerOf(data, input.customerId, null);
   const quotation = quotationId === null ? null : openQuotation(data, quotationId, customer.id);
   // An order made from a quotation reads its prices the way the quotation did
   const pricesIncludeVat = quotation?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
   const created: MockOrder = {
-    id: crypto.randomUUID(),
+    id,
     number: null,
     status: 'draft',
     confirmedAt: null,
```

- **`id` with a default:** the order routes give none and get a new id as before; the push gives the device's.

### The answers kept: `mocks/sync-data.ts`

```diff
@@ -8,7 +8,10 @@ import {
   SYNC_PROTOCOL,
   syncCategorySchema,
   type SyncChange,
+  type SyncCommandError,
+  type SyncCommandType,
   type SyncEntity,
+  type SyncNotice,
   type SyncPull,
   syncSettingsSchema,
   type SyncStock,
@@ -44,6 +47,12 @@ interface Paging {
   finished: Finished;
 }
 
+// What the mock kept of a command it ran (step 18b): the API's sync_commands row. An accepted one
+// reads its customer again when it is sent again, so the answer holds no rows.
+export type MockAnswer = { type: SyncCommandType; entityId: string } & (
+  { status: 'accepted'; notices: SyncNotice[] } | { status: 'rejected'; error: SyncCommandError }
+);
+
 export interface MockSync {
   devices: Device[];
   // A finished pull's cursor → what it left the device with. Only the newest one per device is
@@ -56,10 +65,18 @@ export interface MockSync {
   // When a stock row last changed. Movements have dates, not times, and a row's updatedAt must
   // stay the same while its quantity does, or every pull would send every stock row again.
   stamps: Map<string, { quantity: string; at: string }>;
+  // A pushed command's id → its answer (push-data.ts)
+  answers: Map<string, MockAnswer>;
 }
 
 export function emptySync(): MockSync {
-  return { devices: [], finished: new Map(), paging: new Map(), stamps: new Map() };
+  return {
+    devices: [],
+    finished: new Map(),
+    paging: new Map(),
+    stamps: new Map(),
+    answers: new Map(),
+  };
 }
 
 function now(): string {
@@ -103,8 +120,8 @@ export function registerDevice(
   return { device, branchCode: branch.code };
 }
 
-// The device a pull names: the signed-in person's own, and not revoked
-function deviceFor(data: WorkspaceData, userId: string, id: string): Device {
+// The device a pull or a push names: the signed-in person's own, and not revoked
+export function deviceFor(data: WorkspaceData, userId: string, id: string): Device {
   const device = data.sync.devices.find((candidate) => candidate.id === id);
   if (device?.userId !== userId) throw new MockProblem(404, 'device_not_found');
   if (device.revokedAt !== null) throw new MockProblem(403, 'device_revoked');
```

- **`MockAnswer`** is the API's `sync_commands` row (18b.2): the command's type, the customer or the order it is
  about, and accepted with its notices or refused with its error. No rows: an accepted answer reads its customer
  again each time it is sent (decision 18).
- **`answers` lives in the workspace's sync state,** next to the devices. Like the rest of the mock, it starts over
  on a reload, so a reload is a server that has never seen the device's commands. The device then sends its
  waiting commands as new; a command that was accepted before the reload is no longer in the outbox, so nothing is
  sent twice.
- **`deviceFor` is exported:** a push checks its device like a pull does.

### The push: `mocks/push-data.ts` (new)

```ts
import {
  ADDRESS_KINDS,
  type AddressKind,
  type AuditEntry,
  contractErrorMap,
  type CustomerAddressChanges,
  type CustomerChanges,
  type CustomerField,
  type CustomerInput,
  type ErrorCode,
  isErrorCode,
  MAX_CUSTOMER_ADDRESSES,
  SERVER_WINS_CUSTOMER_FIELDS,
  SYNC_COMMAND_TYPES,
  SYNC_PROTOCOL,
  type SyncChange,
  type SyncCommand,
  type SyncCommandError,
  syncCommandSchema,
  type SyncCommandType,
  type SyncNotice,
  type syncPushInputSchema,
  type SyncPush,
  type SyncResult,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { MockProblem } from './mock';
import { type MockCustomer, refreshPartyRefs, saveCustomer } from './sales-data';
import { createOrder } from './sales-document-data';
import { copyToSupplier } from './supplier-data';
import { deviceFor, type MockAnswer } from './sync-data';
import { diff, record, transaction, type WorkspaceData } from './workspace-data';

// The mock's step 18b: the push. The API's sync-push.service.ts and customer-merge.ts on plain
// arrays, shortened: the commands run in the order sent, each on its own, and one refused command
// does not stop the ones after it. Each answer is kept by the command's id (MockSync.answers), so
// a batch sent again after a lost answer changes nothing twice. The mock's person is the owner,
// who has every permission, so the per-command permission check (decision 17) is left out.

type PushInput = z.output<typeof syncPushInputSchema>;
type PushedCommand = PushInput['commands'][number];

function isSyncCommandType(type: string): type is SyncCommandType {
  return SYNC_COMMAND_TYPES.some((known) => known === type);
}

export function push(data: WorkspaceData, userId: string, input: PushInput): SyncPush {
  // The protocol first, like the pull: an old app is told to reload before anything else
  if (input.protocol !== SYNC_PROTOCOL) throw new MockProblem(409, 'sync_protocol_mismatch');
  const device = deviceFor(data, userId, input.deviceId);
  const from = { id: device.id, name: device.name };
  return {
    results: input.commands.map((pushed) => run(data, from, pushed)),
    serverTime: new Date().toISOString(),
  };
}

function run(
  data: WorkspaceData,
  device: NonNullable<AuditEntry['device']>,
  pushed: PushedCommand,
): SyncResult {
  // A command the mock cannot read is refused alone and keeps no answer (decision 24). The app's
  // forms check the same schemas, so only a bug gets here: the paths are the command's own, not
  // the form's (the API's decision 22 is not repeated here).
  if (!isSyncCommandType(pushed.type)) return refused(pushed.id, { code: 'sync_command_invalid' });
  const parsed = syncCommandSchema.safeParse(pushed, { error: contractErrorMap });
  if (!parsed.success) {
    const fieldErrors: Record<string, ErrorCode[]> = {};
    for (const issue of parsed.error.issues) {
      const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
      (fieldErrors[issue.path.map(String).join('.') || 'command'] ??= []).push(code);
    }
    return refused(pushed.id, { code: 'invalid_input', fieldErrors });
  }
  const command = parsed.data;

  // Sent before: answered from what was kept, accepted or refused
  const stored = data.sync.answers.get(command.id);
  if (stored) return answerOf(data, command.id, stored);

  const key = { type: command.type, entityId: entityOf(command) };
  try {
    // transaction() puts the documents, the stock and the audit log back if the command throws,
    // like the API's savepoint. A customer is checked in full before it is written.
    const notices = transaction(data, () => apply(data, device, command));
    const answer: MockAnswer = { ...key, status: 'accepted', notices };
    data.sync.answers.set(command.id, answer);
    return answerOf(data, command.id, answer);
  } catch (error) {
    // A rule of the mock refused it: kept as refused. Anything else is a bug in the mock.
    if (!(error instanceof MockProblem)) throw error;
    const refusal: SyncCommandError = {
      code: error.code,
      ...(error.fieldErrors && { fieldErrors: error.fieldErrors }),
      ...(error.params && { params: error.params }),
    };
    data.sync.answers.set(command.id, { ...key, status: 'rejected', error: refusal });
    return refused(command.id, refusal);
  }
}

function entityOf(command: SyncCommand): string {
  return command.type === 'sales_order.create_draft' ? command.orderId : command.customerId;
}

function refused(id: string, error: SyncCommandError): SyncResult {
  return { id, status: 'rejected', error };
}

// An accepted answer brings the customer as it is now, also when it is sent again (decision 18):
// an old answer never puts an older row back on the device. Archived since: a delete, like in a
// delta pull. An order brings nothing: orders are not on the device.
function answerOf(data: WorkspaceData, id: string, answer: MockAnswer): SyncResult {
  if (answer.status === 'rejected') return refused(id, answer.error);
  return { id, status: 'accepted', notices: answer.notices, changes: changesOf(data, answer) };
}

function changesOf(data: WorkspaceData, answer: MockAnswer): SyncChange[] {
  if (answer.type === 'sales_order.create_draft') return [];
  const found = data.sales.customers.find((item) => item.id === answer.entityId);
  // Not found (undefined), or archived
  if (found?.archivedAt !== null) {
    return [{ op: 'delete', entity: 'customer', key: answer.entityId }];
  }
  return [{ op: 'upsert', entity: 'customer', key: found.id, data: found }];
}

// --- The commands -------------------------------------------------------------------------------

function apply(
  data: WorkspaceData,
  device: NonNullable<AuditEntry['device']>,
  command: SyncCommand,
): SyncNotice[] {
  switch (command.type) {
    case 'customer.create': {
      assertIdsFree(data, [command.customerId], command.input.addresses);
      const saved = saveCustomer(data, command.input, undefined, {
        customerId: command.customerId,
      });
      data.sales.customers.push(saved);
      record(
        data,
        'customer.created',
        'customer',
        saved.id,
        diff({}, { code: saved.code, name: saved.name }),
        device,
      );
      return [];
    }
    case 'customer.update': {
      const target = data.sales.customers.find((item) => item.id === command.customerId);
      // Deleted since the device read it, or no longer a customer
      if (!target) throw new MockProblem(409, 'sync_customer_gone');
      const { input, kept } = mergeCustomer(data, target, command);
      const saved = saveCustomer(data, input, target, { customerId: target.id });
      data.sales.customers = data.sales.customers.map((item) =>
        item.id === target.id ? saved : item,
      );
      refreshPartyRefs(data, saved);
      copyToSupplier(data, saved);
      record(
        data,
        'customer.updated',
        'customer',
        target.id,
        diff(
          { code: target.code, name: target.name, paymentTermsDays: target.paymentTermsDays },
          { code: saved.code, name: saved.name, paymentTermsDays: saved.paymentTermsDays },
        ),
        device,
      );
      return kept.length === 0 ? [] : [{ code: 'kept_server_value', fields: kept }];
    }
    case 'sales_order.create_draft': {
      if (data.salesDocuments.orders.some((item) => item.id === command.orderId)) {
        throw new MockProblem(409, 'sync_id_taken');
      }
      // A draft only (decision 15): confirming it is done online, with the credit check
      const created = createOrder(data, command.input, null, command.orderId);
      record(data, 'sales_order.created', 'sales_order', created.id, {}, device);
      return [];
    }
  }
}

// The ids a device made must still be free (decision 20): a new party's (a customer, or a
// supplier: one party table in the API) and its new addresses'. In the API the tables' primary
// keys say so, with sync_id_taken and no field.
function assertIdsFree(
  data: WorkspaceData,
  partyIds: readonly string[],
  addresses: readonly { id: string }[],
): void {
  const parties = new Set(
    [...data.sales.customers, ...data.suppliers.suppliers].map((party) => party.id),
  );
  const addressIds = new Set(
    data.sales.customers.flatMap((item) => item.addresses.map((address) => address.id)),
  );
  if (
    partyIds.some((id) => parties.has(id)) ||
    addresses.some((address) => addressIds.has(address.id))
  ) {
    throw new MockProblem(409, 'sync_id_taken');
  }
}

// --- The merge (the API's customer-merge.ts) ----------------------------------------------------

// A customer's address kind is a string in the contract, like the API's; the mock saved one of
// ADDRESS_KINDS, so anything else is a bug
function kindOf(kind: string): AddressKind {
  const known = ADDRESS_KINDS.find((candidate) => candidate === kind);
  if (!known) throw new Error(`Unknown address kind ${kind}`);
  return known;
}

const SERVER_WINS: ReadonlySet<CustomerField> = new Set(SERVER_WINS_CUSTOMER_FIELDS);

// Only the fields the person changed. A head-office field the server changed since the device read
// it (its value is no longer `from`) keeps the server's value, and the answer names it; any other
// field takes the device's value, whatever the server had: the later arrival wins (decision 6).
function mergeCustomer(
  data: WorkspaceData,
  now: MockCustomer,
  command: { changes: CustomerChanges; addresses: CustomerAddressChanges },
): { input: CustomerInput; kept: CustomerField[] } {
  const { changes } = command;
  const kept: CustomerField[] = [];
  function take<From extends To, To>(
    field: CustomerField,
    change: { from: From; to: To } | undefined,
    current: From,
  ): To {
    if (change === undefined) return current;
    if (SERVER_WINS.has(field) && change.from !== current) {
      kept.push(field);
      return current;
    }
    return change.to;
  }
  // Field by field, in the form's order: the notice lists the kept fields in that order
  const input: CustomerInput = {
    code: take('code', changes.code, now.code),
    name: take('name', changes.name, now.name),
    groupId: take('groupId', changes.groupId, now.groupId),
    contactPerson: take('contactPerson', changes.contactPerson, now.contactPerson),
    phone: take('phone', changes.phone, now.phone),
    email: take('email', changes.email, now.email),
    documentLanguage: take('documentLanguage', changes.documentLanguage, now.documentLanguage),
    bin: take('bin', changes.bin, now.bin),
    paymentTermsDays: take('paymentTermsDays', changes.paymentTermsDays, now.paymentTermsDays),
    creditLimit: take('creditLimit', changes.creditLimit, now.creditLimit),
    priceListId: take('priceListId', changes.priceListId, now.priceListId),
    notes: take('notes', changes.notes, now.notes),
    addresses: mergeAddresses(data, now, command.addresses),
  };
  return { input, kept };
}

// The addresses one by one, by id (decision 4): removed ones go, changed ones take the fields
// sent (an address the server removed meanwhile stays removed), added ones go at the end with the
// device's ids. Then the form's two rules again, on the merged list.
function mergeAddresses(
  data: WorkspaceData,
  now: MockCustomer,
  changes: CustomerAddressChanges,
): CustomerInput['addresses'] {
  const removed = new Set(changes.remove);
  const changed = new Map(changes.change.map((change) => [change.id, change]));
  assertIdsFree(data, [], changes.add);
  const merged = [
    ...now.addresses
      .filter((address) => !removed.has(address.id))
      .map((address) => {
        const change = changed.get(address.id);
        return {
          id: address.id,
          kind: change?.kind ?? kindOf(address.kind),
          label: change?.label === undefined ? address.label : change.label,
          address: change?.address ?? address.address,
          phone: change?.phone === undefined ? address.phone : change.phone,
        };
      }),
    ...changes.add,
  ];
  if (merged.length > MAX_CUSTOMER_ADDRESSES) {
    throw new MockProblem(409, 'too_long', { addresses: ['too_long'] });
  }
  const billing = merged.filter((address) => address.kind === 'billing');
  const second = billing[1];
  if (second !== undefined) {
    // On a billing address this change made: the one the person can fix in the outbox
    const touched = new Set([
      ...changes.add.map((address) => address.id),
      ...changes.change.flatMap((change) => (change.kind === undefined ? [] : [change.id])),
    ]);
    const { id } = billing.find((address) => touched.has(address.id)) ?? second;
    throw new MockProblem(409, 'customer_billing_twice', {
      [`addresses.${id}.kind`]: ['customer_billing_twice'],
    });
  }
  return merged;
}
```

- **The protocol first, then the device,** in the order of the API's `push()`. The device's id and name go into
  every audit row the push writes (decision 20), so the audit log says "· from Chrome on macOS".
- **One command at a time, in the order sent.** `map()` runs them one after the other, and each sees what the ones
  before it did: the order finds the customer that the command before it made.
- **`isSyncCommandType`, then `syncCommandSchema.safeParse`:** a command the mock cannot read is refused alone, and
  no answer is kept (decision 24). The field paths are the command's own (`input.name`), not the form's: the app's
  forms check the same schemas before anything reaches the outbox, so only a bug would get here, and the API's
  path rules (decision 22) would add 40 lines to the mock for that.
- **A kept answer is the answer** (decision 18): a batch sent again after a lost answer gets the same results, and
  nothing runs twice.
- **`transaction()` is the API's savepoint.** It puts back the documents, the stock and the audit log if the
  command throws, so a refused order leaves no half order and no audit row. It does not cover the customers; it
  does not need to: a customer is checked in full (`saveCustomer`, the merge) before it is written.
- **Only a `MockProblem` is a refusal.** It is what every rule of the mock throws; anything else is a bug in the
  mock, and it fails the whole push with a 500, as an unexpected error does in the API (decision 29).
- **`changesOf()`** is the customer as it is now, or a delete when it is gone or archived, in the pull's shape, so
  the device writes it at once (18b.6's `applyAnswers`). An order brings nothing: orders are not on the device.
- **`customer.create`:** the ids must be free first (`assertIdsFree`). A customer id or an address id that is
  taken is `sync_id_taken` with no field, as the API's primary keys give it. Then the same `saveCustomer()` as
  the create route: its code rule (an empty code gets the next C- number, a typed one must be free), its group and
  price list checks, and the same audit row.
- **`customer.update`:** a customer that is gone is `sync_customer_gone`. Then the merge, and the same save,
  `refreshPartyRefs` and `copyToSupplier` as the edit route, so the new name shows on its documents and on its
  supplier side too. The notice lists the head-office fields the server kept.
- **`sales_order.create_draft`:** an order id that is taken is `sync_id_taken`. Then `createOrder()` with the
  device's id, as a draft (decision 15): no quotation, no confirmation. Its checks are the order route's: an
  active customer, an active warehouse, the lines.
- **No permission check.** The mock's person is the owner, who has every permission; the API checks each command
  with the roles of now (decision 17).
- **`mergeCustomer()` and `mergeAddresses()` are the API's `customer-merge.ts`,** with `MockProblem` in place of
  `AppError`. The mock cannot import the API's file (dependency-cruiser keeps the apps apart), and the rules are
  short enough to repeat. The fields are written out one by one, in the form's order, so the notice lists them in
  that order, as the API's does.
- **`kindOf()`:** a customer's address kind is a string in the contract, like every enum the API sends (an unknown
  value from a newer server must not break an older app), and the form's input needs one of `ADDRESS_KINDS`. The
  mock only ever saved one of them, so anything else is a bug and throws.

### The route: `mocks/handlers.ts`

```diff
@@ -303,6 +303,7 @@ import {
   toSupplier,
   toSupplierGroup,
 } from './supplier-data';
+import { push } from './push-data';
 import { pull, registerDevice } from './sync-data';
 import {
   assertCodeFree,
@@ -4987,4 +4988,15 @@ export const handlers = [
       return reply(routes.sync.pull, pull(current(), workspace.tenantId, OWNER.id, query));
     }),
   ),
+
+  // Step 18b: the commands a device saved offline (push-data.ts)
+  mock(
+    routes.sync.push,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.sync.push.body, request);
+      const answer = push(current(), OWNER.id, body);
+      await delay();
+      return reply(routes.sync.push, answer);
+    }),
+  ),
 ];
```

- **`guarded()`** turns the device and protocol errors into problem responses, as for the pull. A refused command
  is not an error of the request: it is one of the results, with status 200.
- **`delay()`**, the mock's usual wait, so the sidebar shows "Syncing…" for a moment, as it would with a real
  server.

### The offline screens' code: `lib/offline-screens.ts` (new)

```ts
import { loadCalendar } from '@omnivo/ui';

// Step 18b (decision 42): the code of every screen that works without a connection, fetched in
// the background while there is one. Each page is a chunk of its own, loaded the first time it
// opens. Until step 19's service worker keeps them, a chunk the browser never loaded cannot load
// offline: someone who opened the app at the office and lost the connection before ever opening
// "Add customer" would get an error page instead of the form. Each import() here is the same one
// the router or the form makes later, so the screen then finds its module already loaded.
const SCREENS = [
  // The lists read from the device (18a)
  () => import('../routes/products'),
  () => import('../routes/customers'),
  // A customer saved on the device
  () => import('../routes/customer-edit'),
  () => import('../components/customer-form'),
  // A draft order saved on the device, with its lines, the customer box and the date boxes
  () => import('../routes/sales-orders'),
  () => import('../routes/sales-order'),
  () => import('../components/sales-order-form'),
  () => import('../components/sales-line-editor'),
  () => import('../components/customer-picker'),
  () => import('../components/date-input'),
  loadCalendar,
  // The Sync page, the question before signing out with changes on the device, and the sign-in
  // page that signing out offline ends on
  () => import('../routes/sync'),
  () => import('../components/sign-out-dialog'),
  () => import('../routes/login'),
];

let loading: Promise<unknown> | null = null;

// Once per page load. A load that failed (the connection dropped half way) is tried again the
// next time it is called: the host calls it again when the browser is back online.
export function preloadOfflineScreens(): void {
  if (loading) return;
  loading = Promise.all(SCREENS.map((load) => load())).catch(() => {
    loading = null;
  });
}
```

- **Why it is needed** (decision 42). The router loads each page's code the first time the page opens
  (`lazyRouteComponent`), and a form loads its line editor and pickers the same way (`lazy()`). Online, that is a
  short wait. Offline, before step 19's service worker keeps a copy of every chunk, it is a failed request: the
  page stays empty. A sales officer opens Omnivo at the office, drives to a market with no signal, and taps "Add
  customer" for the first time that day: without this file, nothing opens.
- **The same `import()` as the router's and the form's.** Vite makes one chunk per module, and the browser keeps
  each module once it has loaded: when the router later asks for `../routes/customer-edit`, it gets the module
  already there, with no request.
- **The list is every screen that works offline in 18b:** the two lists that read the device (18a), the customer
  form, the order form with the parts it loads lazily (the line editor, the customer box, the date box and the
  calendar), the Sync page, the sign-out question, and the sign-in page that signing out ends on. A screen that
  needs the server anyway (a customer's page with its statement) is left out: it would not work offline even with
  its code.
- **`loadCalendar` comes from `@omnivo/ui`,** because the calendar is a lazy chunk of the ui package's date picker,
  which the app cannot name by path.
- **Once per page load, and again after a failure.** `loading` stops a second call from fetching again; a failed
  load (the connection dropped half way) clears it, and the host calls this again on the `online` event.
- **Not in the first load.** The chunks come after the shell has drawn, next to the first pull. The bundle check
  is unchanged: the first load is still 208.6 KB gz.

```diff
@@ -8,7 +8,14 @@ import { parseIsoDate, toIsoDate } from '../lib/iso-date.js';
 import { controlBoxClass } from './field.js';
 import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
 
-const Calendar = lazy(async () => ({ default: (await import('./calendar.js')).Calendar }));
+// Step 18b: also called by the app while it is online, so that a date can be picked offline later
+// (the app's offline-screens.ts): before step 19's service worker, a chunk the browser never
+// loaded cannot load without a connection
+export function loadCalendar() {
+  return import('./calendar.js');
+}
+
+const Calendar = lazy(async () => ({ default: (await loadCalendar()).Calendar }));
 
 interface DatePickerProps {
   id?: string;
```

```diff
@@ -15,7 +15,7 @@ export {
   type DataTableColumnMeta,
   type SortingState,
 } from './components/data-table.js';
-export { DatePicker } from './components/date-picker.js';
+export { DatePicker, loadCalendar } from './components/date-picker.js';
 export { DiscountInput, type DiscountType } from './components/discount-input.js';
 export { Dialog, DialogClose, DialogContent, DialogTrigger } from './components/dialog.js';
 export {
```

`loadCalendar()` is the date picker's own `import()` of the calendar, now with a name the app can call. The picker
still loads it the first time it opens, as before.

### The tests: `e2e/outbox.e2e.ts` (new)

```ts
import type { Page } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  readOnlyItem,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 18b: work saved on the device without a connection, and sent when it is back. The mock
// runs the commands with the API's rules (src/mocks/push-data.ts). The garments workspace has five
// customers, C-00001 to C-00005, so a customer added here gets C-00006. Offline is
// context.setOffline, and pages change through the nav, as in sync.e2e.ts.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForCopy(page);
});

// The sidebar line (desktop) or the top bar's (phone): the whole sentence is its name
function syncLink(page: Page, name: string) {
  return page
    .getByRole('navigation')
    .getByRole('link', { name: `Sync: ${name}`, exact: true })
    .filter({ visible: true });
}

// One change on the Sync page, by its first line
function change(page: Page, title: string) {
  return page.getByRole('listitem').filter({ hasText: title });
}

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

// A new customer with one billing address, saved on the device
async function addCustomerOffline(page: Page, name: string, code?: string) {
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New customer' })).toBeVisible();
  await expect(
    page.getByText("You're offline. This is saved on this device and sent when the connection"),
  ).toBeVisible();
  // The number is given by the server, when the customer arrives
  await expect(
    page.getByText('Leave empty for the next number. It is given when the customer syncs.'),
  ).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (code !== undefined) await page.getByLabel(/^Code/).fill(code);
  await page.getByRole('button', { name: 'Add an address' }).click();
  await page
    .getByRole('group', { name: 'Address 1' })
    .getByLabel('Address', { exact: true })
    .fill('Zindabazar, Sylhet 3100');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
}

// A draft order for that customer, from the main store, with ten T-shirts at the product's price
async function addOrderOffline(page: Page, customer: string) {
  await openFromNav(page, 'Sales orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales order' })).toBeVisible();
  await expect(page.getByText('The order is saved on this device as a draft.')).toBeVisible();
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(customer.slice(0, 6));
  await page.getByRole('option', { name: new RegExp(customer) }).click();
  // What the customer owes is the server's (decision 10)
  await expect(page.getByText('Credit left needs a connection.')).toBeVisible();
  await page.getByLabel('Send from').selectOption({ label: 'MAIN · Main store' });

  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill('crew-neck');
  const row = dialog.getByRole('listitem').filter({ hasText: 'Basic crew-neck T-shirt' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
  // The price comes from the device's copy, by the same rule as the server's (decision 9)
  await expect(line(page, 1).getByText('Product price')).toBeVisible();
  await expect(line(page, 1).getByLabel(/^Price/)).toHaveValue('320.00');
  await line(page, 1).getByLabel('Quantity').fill('10');

  // A draft only: confirming needs the server's credit check
  await expect(page.getByRole('button', { name: 'Confirm order' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect(page.getByRole('heading', { level: 1, name: 'Sales orders' })).toBeVisible();
}

test('a customer and an order saved offline reach the server when the connection is back', async ({
  page,
  context,
}) => {
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();
  await context.setOffline(true);
  await expect(syncLink(page, 'Offline, All changes synced')).toBeVisible();

  await addCustomerOffline(page, 'Sylhet Tea Traders');
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('Not synced');
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('No number yet');
  await expect(syncLink(page, 'Offline, 1 change waiting')).toBeVisible();

  await addOrderOffline(page, 'Sylhet Tea Traders');
  // Above the server's list, which needs the connection
  const unsynced = page
    .getByRole('table', { name: 'On this device · not synced' })
    .or(page.getByRole('list', { name: 'On this device · not synced' }));
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('Not synced');
  await expect(unsynced).toBeVisible();
  await expect(page.getByText('The orders on the server need a connection.')).toBeVisible();
  await expect(syncLink(page, 'Offline, 2 changes waiting')).toBeVisible();
  await expectNoSideScroll(page);

  await openFromNav(page, 'Sync');
  await expect(page.getByText('Connect to the internet to sync.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  await expect(change(page, 'New customer Sylhet Tea Traders')).toContainText('Waiting');
  // The order needs the customer first (decision 13)
  await expect(change(page, 'Draft order for Sylhet Tea Traders')).toContainText(
    'Waits for Sylhet Tea Traders to sync first',
  );
  await expect(change(page, 'Draft order for Sylhet Tea Traders')).toContainText('1 line · ৳3,680');
  await expectNoSideScroll(page);

  // Back online: the customer goes, then the order that waited for it, in one sync
  await context.setOffline(false);
  await toastShown(page, '2 changes synced');
  await expect(page.getByText('Everything is synced')).toBeVisible();
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();

  await openFromNav(page, 'Customers');
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('C-00006');
  await expect(listItem(page, /Sylhet Tea Traders/)).not.toContainText('Not synced');
  await openFromNav(page, 'Sales orders');
  await expect(unsynced).toHaveCount(0);
  await expect(listItem(page, /Sylhet Tea Traders/)).toContainText('Draft');

  // The audit log names the device the change came from
  await openFromNav(page, 'Audit log');
  await expect(readOnlyItem(page, /Added a customer/).first()).toContainText(/· from /);
});

test('a refused change waits on the Sync page until it is fixed', async ({ page, context }) => {
  await context.setOffline(true);
  // H&M's code: the device cannot know it is taken
  await addCustomerOffline(page, 'Moulvibazar Garments', 'C-00001');
  await addOrderOffline(page, 'Moulvibazar Garments');

  await context.setOffline(false);
  await toastShown(page, 'Some changes need attention. Open Sync to fix them.');
  await expect(syncLink(page, 'Online, 1 change needs attention')).toBeVisible();
  await openFromNav(page, 'Sync');
  const customer = change(page, 'New customer Moulvibazar Garments');
  await expect(customer).toContainText('Needs attention');
  await expect(customer).toContainText('Another customer has this code.');
  // The order is not refused: it waits for its customer
  await expect(change(page, 'Draft order for Moulvibazar Garments')).toContainText(
    'Waits for Moulvibazar Garments to sync first',
  );

  // Discard says that the order goes with it; not now
  await customer.getByRole('button', { name: 'Discard' }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard this change?' });
  await expect(dialog).toContainText('The 1 change that needs it is discarded too.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Edit opens the form with the refusal under the box. Online, a customer with a change on the
  // device is still saved on the device, after it (decision 2).
  await customer.getByRole('link', { name: 'Edit' }).click();
  await expect(page.getByText('Another customer has this code.')).toBeVisible();
  await page.getByLabel(/^Code/).fill('');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, '2 changes synced');
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /Moulvibazar Garments/)).toContainText('C-00006');
});

test('discarding a new customer discards the order that needs it', async ({ page, context }) => {
  await context.setOffline(true);
  await addCustomerOffline(page, 'Habiganj Knit Ltd.');
  await addOrderOffline(page, 'Habiganj Knit Ltd.');

  await openFromNav(page, 'Sync');
  await change(page, 'New customer Habiganj Knit Ltd.')
    .getByRole('button', { name: 'Discard' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Discard this change?' });
  await dialog.getByRole('button', { name: 'Discard change' }).click();
  await toastShown(page, 'Change discarded');
  await expect(page.getByText('Everything is synced')).toBeVisible();
  await expect(syncLink(page, 'Offline, All changes synced')).toBeVisible();

  await openFromNav(page, 'Customers');
  await expect(listItem(page, /Habiganj Knit/)).toHaveCount(0);
});

test('a change to a customer made offline syncs, field by field', async ({ page, context }) => {
  await openFromNav(page, 'Customers');
  await listItem(page, /Aarong/).click();
  await expect(page.getByRole('heading', { level: 1, name: /Aarong/ })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Edit C-/ })).toBeVisible();

  // The form opens again from the device's copy
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save on this device' })).toBeVisible();
  await page.getByLabel('Phone (optional)', { exact: true }).fill('+880 1711-202020');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect(listItem(page, /Aarong/)).toContainText('Not synced');

  await openFromNav(page, 'Sync');
  await expect(change(page, 'Changes to Aarong')).toContainText('Changed: Phone');

  await context.setOffline(false);
  await toastShown(page, '1 change synced');
  await openFromNav(page, 'Customers');
  await listItem(page, /Aarong/).click();
  await expect(page.getByText('+880 1711-202020').first()).toBeVisible();
});

test('signing out with changes on the device asks first', async ({ page, context }) => {
  await context.setOffline(true);
  await addCustomerOffline(page, 'Sunamganj Traders');

  const signOut = async () => {
    await page
      .getByRole('button', { name: /Farhana Rahman/ })
      .or(page.getByRole('button', { name: 'Account' }))
      .filter({ visible: true })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
  };
  await signOut();
  const dialog = page.getByRole('dialog', { name: 'Sign out and lose the changes?' });
  await expect(dialog).toContainText(
    '1 change on this device has not synced. Signing out removes it for good.',
  );
  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(dialog).toBeHidden();
  await expect(listItem(page, /Sunamganj Traders/)).toBeVisible();

  await signOut();
  await dialog.getByRole('button', { name: 'Sign out anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
```

- **`waitForCopy` before every test:** the forms and the pickers read the device's copy offline, so it must be
  complete first. It also leaves time for the offline screens' code to arrive, which starts loading at the same
  moment and is much smaller than the copy.
- **`syncLink()` finds the sidebar line by its whole name,** "Sync: Offline, 2 changes waiting": the name a screen
  reader reads (18b.6's `SyncNavItem`). `filter({ visible: true })`: on a phone the same link is in the top bar.
- **`addCustomerOffline()` and `addOrderOffline()`** check, on the way, what the forms say offline: the notice, the
  code's hint without an example number, the credit line that needs a connection, no "Confirm order" button, and
  the price that the device worked out (৳320, the product's price: the new customer has no price list).
- **The first test is the whole path:** a customer and an order saved offline, the "Not synced" pill and "No
  number yet" in the list, the orders on the device above the server's list (which needs the connection), the Sync
  page with the order waiting for its customer, then back online: one toast for both, C-00006 from the server, the
  order in the server's list as a draft, and the audit log naming the device.
- **The refused test uses H&M's code, C-00001:** the device cannot know it is taken, the server refuses it, and
  the order waits behind it, not refused itself (decision 13). The discard dialog says the order would go too.
  Edit opens the form with the refusal under the box; an empty code then syncs both. This is the test that found
  the version mistake.
- **The discard test** confirms the discard: the customer and its order both leave the outbox, and the customer
  leaves the list.
- **The change test opens Aarong's form online, then goes offline.** The form opens again from the device (its
  `key` has the mode in it, 18b.6) and saves to the outbox. Only the phone changed, so the command carries only
  the phone (decision 4), and the Sync page says "Changed: Phone".
- **The sign-out test** answers "Stay signed in" first, then "Sign out anyway". Offline, the logout request fails;
  the app signs out anyway (step 3), and the sign-in page opens from the code loaded earlier. The failed request
  logs an "Unhandled rejection" in the console: `logout()` throws its error after it has signed out, and both
  callers ignore it with `void`. That is step 3's code and harmless; it is noted here, not changed.
- **What is not tested end to end:** a head-office field kept by the server (`kept_server_value`) and its notice
  on the Sync page. The mock's state lives in the page, so nothing can change a customer "on the server" while the
  page is offline. The merge rule is tested in the API (18b.4), and the notice's writing in `packages/sync`
  (18b.6).

### Check this part

```bash
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/app typecheck
npx eslint apps/app/src apps/app/e2e packages/ui/src
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
pnpm --filter @omnivo/app test:e2e
```

Build `@omnivo/ui` first: the app reads its built code, and `loadCalendar` is new.

> **What we checked in this part.** The app type-checks (all three tsconfigs) with no error left, ESLint and
> Prettier are clean, its 142 unit tests pass, it builds, the bundle check passes (first load 208.6 KB gz, as in
> 18b.6: the offline screens' code is not in it), and dependency-cruiser finds no violation. The 10 new tests (5 on
> the desktop, 5 on the phone) passed 3 times in a row (`--repeat-each=3`). The full Playwright suite, 276 tests,
> ran once with 4 workers: 247 passed and 29 failed on timeouts, while the machine's load was near 20 and the Mac
> went to sleep once in the middle (`ERR_NETWORK_IO_SUSPENDED`); the 29 then passed with `--last-failed
> --workers=2`, except two account tests that timed out in their `beforeEach` on a cold dev server, and passed when
> their file ran alone. Two rules were broken on purpose, one at a time: without the offline screens' code loaded
> early, all 10 new tests failed (the forms never opened offline); with the form's version back to 0, the refused
> test failed (that is how the mistake was found). Not checked here: the push against the real API, which 18b.8
> runs once.

---

## 18b.8 — The OpenAPI document, the real API, and every check once

### No role templates this time

This step adds no permission (decision 17): a command needs the permission of the API route that does the same
thing (`sales.customer.manage`, `sales.order.manage`), read from the route itself, which the templates have given since
15a and 15b. So
`apps/api/src/setup/templates.ts` does not change.

### The OpenAPI document

No root file changes in this step: no new dependency, no new script, no new `.env` line, and the boundaries rules
already cover `packages/sync`. Generate the API document again and commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 210 paths (209 before)
```

The new path is `/sync/push` (POST, up to 50 commands, a result for each). One older path changes its shape:
`/audit-logs`, whose entries gain `device` (`{id, name}` or `null`). The price lookup's path does not change: it
calls `startingPrice()` now, with the same answers. `pnpm test:openapi` fails if the committed file and the routes
disagree.

The Drizzle snapshots (`migrations/meta/0045_snapshot.json`, `0046_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

### The app against the real API

18b.6 and 18b.7 promised one run of the app against the real API, not the mock. It ran in a browser (Chromium,
driven by a Playwright script that is not part of the guide), with the API, the worker and the app built from this
guide's code, on a throwaway Postgres and Valkey on other ports. The script:

- signed up a pharma workspace through the API, added a product (৳2.50) and a customer, Rahman Traders, with a
  credit limit of ৳50,000, and opened the customers page: the first pull ran, and the sidebar said "Online, All
  changes synced";
- opened Rahman Traders' form online, turned the browser's network off, changed the phone and the credit limit
  (৳80,000) and saved it on the device. Meanwhile the "head office" (a second API client that stayed online) set
  the credit limit to ৳60,000 on the server;
- still offline, added Sylhet Pharmacy with an empty code and one address, and a draft order for it from the main
  store, 200 tablets at ৳2.50, the price the device worked out. The sidebar said "Offline, 3 changes waiting", and
  the Sync page showed the order waiting for its customer;
- turned the network back on. The Sync page said "Everything is synced", and "Kept from the server" listed Rahman
  Traders with "Not changed: Credit limit"; Dismiss removed it;
- asked the API what it holds now: Rahman Traders has the new phone and the server's ৳60,000 (decision 14);
  Sylhet Pharmacy has the code C-00002 (decision 16); the order is a draft; the audit log has three rows from
  "Chrome on macOS" (decision 20);
- went back to the customers and the orders pages: the device's copy has C-00002, no "Not synced" pill, and the
  draft in the server's list.

No error was thrown in the page. `sync_commands` then held the three answers, all accepted, for that device.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

Every check passed, with the turbo cache bypassed (`--force`): `pnpm dedupe --check`, `pnpm lint`, `pnpm format`
(after one fix, see "What we found on the way"), `pnpm typecheck`, `pnpm test` (641 — 56 new: 11 in the contracts,
16 in the API, 22 in `packages/sync`, 7 in the app), `pnpm build`, `pnpm test:bundle-size` (first load 208.6 KB gz,
budget 210; the largest lazy chunks the debit note lines, 106.7 KB, the quotation form, 105.5, and the AppShell,
105.3, budget 110), `pnpm test:openapi`, `pnpm boundaries`, `pnpm test:integration` (533 — 31 new) and `pnpm
test:tenant-leak` (109 — 4 new). No test failed because of the date this time: your fix of the date-bound tests
(in `834f1db`) holds.

The machine was not well while they ran. The first run went overnight, with macOS swapping (6 GB of swap used) and
the load near 67. The integration suites timed out in the hooks that start their test containers (22 of 36 files);
run again with `--maxWorkers=2`, all 533 passed in 3 minutes, and the tenant-leak suite's 109 in 77 seconds. The
end-to-end suite ran 276 tests once on 4 workers, in 4.3 hours (it takes about 10 minutes): 214 passed and 62
failed, none of them in `outbox.e2e.ts`. The 62 ran again with `--last-failed --workers=2`: 56 passed, and the
other 6 (three purchase return tests, a quotation and two refunds) passed when their files ran alone with one
worker.

If a test times out on your machine, run
`pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts --last-failed --workers=2` before
looking for a bug. For the API suites, run them with fewer workers:
`cd apps/api && npx vitest run .int.spec --maxWorkers=2`.

---

## 18b.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after "Device branch dialog", add these entries. The design system lists every
pattern, and a pattern that is not listed there does not exist for the next screen (18c's device list and step
20's POS will use them):

> - **Sync line (sidebar):** the item after Overview in the sidebar nav (and in the phone's top bar), linking to `/sync`:
>   `Wifi01` and "Online" (or "Syncing…"), `WifiDisconnected02` and "Offline". The count on the right is the changes
>   waiting on the device, or, when any was refused, the refused ones in `crit`. Its accessible name is the whole
>   sentence ("Sync: Offline, 2 changes waiting").
> - **Outbox pills:** a change on the device is Waiting (`brand`, `Clock01`), Sending (`brand`, `CloudUpload`) or
>   Needs attention (`warn`, `Alert02`). A row read from the device that the server has not got yet has a neutral
>   "Not synced" pill (`CloudUpload`); a customer without its code yet says "No number yet". A change that waits for
>   another stays Waiting, with "Waits for Sylhet Pharmacy to sync first" under it.
> - **Device mode on a form:** offline (or online, for a customer with changes still on the device), the customer
>   and sales order forms show a neutral document notice that says the work is saved on this device and sent when
>   the connection is back, and their primary button says "Save on this device". An order saved this way is a
>   draft: no "Confirm order". Then the toast "Saved on this device. It syncs when the connection is back."
> - **Sync page (`/sync`):** the page header (title, description, "Sync now" secondary with
>   `ArrowReloadHorizontal`, disabled offline), a 13px `ink-3` "Last synced …" line, then two cards: "Kept from the
>   server" (only when there is a notice: the customer's name and "Not changed: Credit limit" in 12px `ink-3`, a Dismiss text link per row) and "Changes on
>   this device", a list with 1px `line` rules. A row: what the change is ("New customer Sylhet Pharmacy"), when it
>   was saved, its pill, and for a refused one the error in `crit` with an `Alert02` icon. On the right, Edit (a
>   text link), Retry (secondary `sm`, refused ones only) and Discard (secondary `sm`); none while it is Sending.
>   Discard asks first in a dialog that says how many changes
>   that need it go with it. With nothing waiting: the empty state with `CloudSavingDone01`, "Everything is synced".
> - **Orders on the device:** above the sales orders list, a section header "On this device · not synced" and its
>   own table (cards on a phone) of the drafts in the outbox, each with "No number yet" and its pill. Offline, the
>   server's list below is the empty state "Needs a connection".
> - **Sign-out with changes waiting:** the dialog "Sign out and lose the changes?", which says how many changes have
>   not synced; "Sign out anyway" (secondary, pushed left) and "Stay signed in" (primary).

In "Interaction", add at the end (decision 42):

> - **A screen that works offline** has its route in `apps/app/src/lib/offline-screens.ts`. Until step 19's service
>   worker keeps the app's files, a lazy chunk cannot load without a connection, so these chunks load in the
>   background while the device is online.

**system-design.bn.md** — in "৭.২ আর্কিটেকচার", under "৩. **Push**", replace the code block and the two bullets
after it. The design's command had a free `payload` and the device's clock; what was built has one schema per
command, and the order of arrival at the server decides, never a clock (decisions 6, 9–14):

> - অফলাইনে প্রতিটা কাজ একটা **command** হিসেবে Dexie-র `outbox` টেবিলে জমা হয়: `{id: UUIDv7, type, ...}`,
>   প্রতিটা type-এর নিজের Zod schema (`customer.create`, `customer.update`, `sales_order.create_draft`)। নতুন
>   কাস্টমার, তার ঠিকানা আর অর্ডারের id ডিভাইস নিজেই বানায় (UUIDv7)।
> - অনলাইন হলে `POST /sync/push`-এ ক্রমানুসারে যায়, এক বারে সর্বোচ্চ ৫০টা। প্রতিটা command নিজের transaction-এ
>   চলে; একটা refuse হলে বাকিগুলো থামে না। সার্ভার প্রতিটা উত্তর `sync_commands`-এ রাখে (৩০ দিন): একই `id` আবার
>   এলে (হারানো উত্তর) আগের উত্তরটাই ফেরত দেয়, কিছু দ্বিতীয়বার চলে না।
> - সার্ভার আসল business rule আবার যাচাই করে, এখনকার role দিয়ে। ক্লায়েন্টকে কখনো অন্ধভাবে বিশ্বাস করবেন না।
>   refuse হওয়া command ডিভাইসে "Needs attention" হয়ে থাকে; ঠিক করে আবার পাঠানো বা বাদ দেওয়া যায়, আর যেগুলো
>   ওটার উপর নির্ভর করে (নতুন কাস্টমারের অর্ডার) সেগুলো অপেক্ষা করে।

In "৭.৩ Conflict Resolution", in the table, the "মাস্টার ডেটা" row's strategy becomes:

> ফিল্ড-লেভেল: শুধু বদলানো ফিল্ড যায় (`{from, to}`), ভিন্ন ফিল্ড দুটোই থাকে, একই ফিল্ডে সার্ভারে যেটা পরে পৌঁছায়
> সেটা জেতে (ডিভাইসের ঘড়ি দেখা হয় না)। ঠিকানা id ধরে আলাদা আলাদা merge হয়।

and the "সংবেদনশীল ফিল্ড" row's example becomes:

> কাস্টমারের ক্রেডিট লিমিট, payment terms, price list, group: device পড়ার পরে সার্ভারে বদলালে সার্ভারেরটা থাকে
> (`from` আর এখনকার মান আলাদা), আর Sync পাতায় জানানো হয়

**build-plan.bn.md** — in "ধাপ ১৮", replace the "**Push:**" and "**Conflict:**" bullets with:

> - **Push (১৮b):** Dexie-তে `outbox`, তিনটা command: কাস্টমার তৈরি, কাস্টমার বদল (field-level merge, ঠিকানা id
>   ধরে, ক্রেডিট লিমিট/terms/price list/group = server-wins + নোটিস), sales order draft। `POST /sync/push`,
>   `sync_commands`-এ উত্তর রেখে idempotent। অনলাইনে ফর্ম আগের মতো API-তে যায়; অফলাইনে "Save on this device"।
>   সাইডবারে online/offline + অপেক্ষায় থাকা পরিবর্তনের সংখ্যা, Sync পাতা (retry, discard, edit, Sync now)।
> - **১৮c:** device list, নাম বদল, ব্রাঞ্চ বদল, revoke + মুছে ফেলা, ২৪ ঘণ্টা / ৭ দিনের সীমা।

**COMMANDS.md** — in "Look at the data", after the last query, add these two. They answer the questions you will
ask when a person says "I synced, but my customer is not there" (decisions 10, 23 and 25):

```bash
# the push's answers per workspace and device: how many accepted and refused, and the newest (kept 30 days)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.name AS device, c.status, count(*) AS commands, max(c.created_at) AS newest FROM sync_commands c JOIN tenants t ON t.id = c.tenant_id JOIN devices d ON d.tenant_id = c.tenant_id AND d.id = c.device_id GROUP BY t.slug, d.name, c.status ORDER BY t.slug, d.name, c.status"
# the last 20 refused commands: which type, which record, and why
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, c.type, c.entity_id, c.error->>'code' AS error, c.created_at FROM sync_commands c JOIN tenants t ON t.id = c.tenant_id WHERE c.status = 'rejected' ORDER BY c.created_at DESC LIMIT 20"
```

The two queries were run against the database of 18b.8's run of the app: the first listed the device "Chrome on
macOS" with its three accepted commands per workspace, and, after one more command was pushed with a code another
customer has, "Firefox on Windows" with one refused. The second printed that one: `customer.create`, its customer
id, `customer_code_taken`.

---

## 18b.10 — Run it

```bash
pnpm install                                  # no new dependency; the workspace links stay the same
pnpm db:migrate                               # 0045 + 0046: sync_commands and its rules, audit_logs.device_id
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: the push route, the worker's cleanup of old answers
```

In `pnpm db:psql`:

```sql
SELECT relforcerowsecurity FROM pg_class WHERE relname = 'sync_commands';            -- t
SELECT has_table_privilege('omnivo_app', 'sync_commands', 'UPDATE');                 -- f
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'audit_logs' AND column_name = 'device_id';                      -- device_id
```

The app's device database goes from version 1 to version 2 the first time the new code opens it (two new tables
and an index); the copy from 18a stays, and no new full pull is needed.

### What you will see

1. **The sync line:** the sidebar's last item says "Online", with no count. Open it: the Sync page says "Everything
   is synced" and when the device last synced.
2. **A customer offline:** load Customers, then DevTools → Network → Offline. The sidebar says "Offline". Add a
   customer and leave the code empty: the form says it is saved on this device, the code's hint says the number
   comes when it syncs, and the button is "Save on this device". The list shows the customer with "Not synced" and
   "No number yet"; the sidebar says 1.
3. **An order offline:** Sales orders → New order, for that customer, from your warehouse. The credit line says it
   needs a connection, the price comes from the device, and there is no "Confirm order". After saving, the order is
   in "On this device · not synced" above the list, and the list itself says it needs a connection. The Sync page
   shows the order waiting for its customer.
4. **A change offline:** open a customer's form while online, go offline, change the phone and the credit limit,
   save. In another browser (or a private window), change the same customer's credit limit and save it there.
5. **Back online:** turn the network on. Within a moment the changes go: the toast says what happened, the customer
   has its C- number, the draft is in the server's list, and the Sync page's "Kept from the server" says "Not
   changed: Credit limit" (the head office's value stays; the phone changed). Dismiss it. The audit log shows the
   rows with "· from Chrome on …".
6. **A refused change:** offline, add a customer with a code another customer has, then go online: the Sync page
   says "Needs attention" with the reason. Edit, clear the code, save: it goes. Or Discard: the dialog says the
   order that needs it goes too.
7. **Sign-out:** with a change waiting, sign out: the app asks first and says how many changes would be lost.
8. **Bangla** and **390px:** the Sync page, the forms' notice and the orders on the device fit, and no page scrolls
   sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 641: contracts 282 + api 123 + app 142 + sync 57 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 533 — 31 new
pnpm test:tenant-leak        # 109 — 4 new
pnpm test:e2e                # 276: 138 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 208.6 KB gz (budget 210); debit note lines 106.7, quotation form 105.5 (110)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **The audit list broke 47 tests before the database knew the device** (18b.2): 18b.1 made `device` a required
  field of an audit entry, and the API could not send it until 18b.3 joined the devices. Every test that read
  `/audit-logs` failed on the response's schema. The same 47 failed with and without 18b.2's migrations, so the
  migrations were not the cause; 18b.3 brought the suites back to no failure.
- **Two pushes of the same command at the same moment made two customers** (18b.3): without the advisory lock on
  the command's id, both found no answer and both ran it; the second then failed on the primary key with a 500. The
  lock makes the second wait and answer from the first's row (decision 23).
- **No bug in the merge or the push** (18b.4): the tests broke three of their rules on purpose (no savepoint, a
  resend with no rows, no head-office `from` check), and tests failed each time.
- **A customer made on the device could not be saved again** (18b.7): its form opened with version 0, which the
  form's schema refuses, and the Save button did nothing, with no message. A customer that never reached the server
  still has version 0 on the device (`overlay.ts`), and the form now gives its own value 1, which the create command
  never reads. The end-to-end test of a refused customer found it.
- **The forms did not open offline** (18b.7): every page is a lazy chunk, and a chunk that was never loaded cannot
  be fetched without a connection. The offline screens' code now loads in the background while online (decision
  42, `lib/offline-screens.ts`). Step 19's service worker makes this unnecessary.
- **Prettier and a Bangla line** (18b.8): one line of `bn.ts` added in 18b.6 was broken in two by hand; `pnpm
  format` wanted it on one line. The guide has the formatted file.

---

## Notes left for later steps

**18c (devices, limits):**

- **A revoked device may have changes waiting.** The push already refuses a revoked device (`device_revoked`, as the
  pull does), and the app then deletes its database, outbox included. 18c should say so in the revoke dialog ("2 changes
  on that device have not synced") using the device's last push, or let the device show what will be lost.
- **The answers know the device:** `sync_commands.device_id` and `audit_logs.device_id` give the device list its
  "last change sent" and "changes this week" without a new column.
- **The 24 hour and 7 day limits** can count from the last accepted push as well as the last pull: a device that
  pulls but whose pushes are all refused is not really in sync.

**Step 19 (PWA):**

- **`lib/offline-screens.ts` goes away** (or shrinks to a list for the service worker's precache) once the service
  worker keeps every chunk (decision 42).
- **The outbox is not encrypted.** A lost laptop holds the waiting customers and orders in IndexedDB; step 19's
  encryption should cover the `outbox` and `notices` tables too.
- **Offline sign-out** logs an unhandled rejection: step 3's `logout()` rethrows its error after it has signed out,
  and both callers ignore it with `void`. Harmless; worth tidying when the PWA's sign-out is reworked.

**Step 20 (POS):**

- **A sale is a new command type:** add it to `SYNC_COMMAND_TYPES`, its schema to `syncCommandSchema`, a branch to
  `SyncPushService.apply`, and the type's permission. It is append-only (system design §7.3), so it needs no merge,
  only the idempotency the push already has. Decision 2 says the POS is outbox-only, online too.
- **The price on the device is `startingPrice()`**, the same function the server uses; a POS discount or a promotion
  belongs in that shared code too, never in the screen.

**Notes for any step:**

- **A new command must be safe to send twice.** The answer row makes the server run it once, but only if the
  command's id stays the same on a resend. A command rewritten after it was sent must get a new id (decision 33).
- **A field added to `customerInputSchema` needs a place in `customerChangesSchema`** (`sync.ts`) and in the merge
  (`customer-merge.ts`), or a change made offline never sends it. If it belongs to the head office, add it to
  `SERVER_WINS_CUSTOMER_FIELDS`.
