# Step 17a: Suppliers, the payable, purchase requisitions and approvals

> The implementation guide for "Phase 5 → Step 17", part a of four, of [build-plan.bn.md](build-plan.bn.md): which
> file gets what code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `3a82bf8`, your step 16
> commit named "POS added") and checked on 2026-10-15: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`,
> `pnpm typecheck`, `pnpm test` (437 — 30 new), `pnpm test:integration` (396 — 46 new), `pnpm test:tenant-leak`
> (77 — 10 new), `pnpm build`, `pnpm test:bundle-size` (first load 193.5 KB gz, budget 200, which is 3.8 KB less
> than after step 16, see decision 46; the biggest lazy chunk is the team page, 100.0 KB, at its limit),
> `pnpm gen:openapi` (172 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 218 — 26
> new, desktop and 390px; every test passed on the first run) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres: 121 checks of migrations 0035 and 0036 run as
>   `omnivo_app` with SQL the API would never send (a customer group on a supplier-only party, a side dropped
>   without clearing its columns, a 21-digit account number, a role twice in one rule, a second waiting round,
>   step 2 decided before step 1, a rejection without a comment, a closed round changed, another workspace's rows),
>   and a race: two sessions submitting the same draft at once make one round (17a.2).
> - **The whole flow against a real database** (17a.4): a supplier with bank accounts, a party made both and one
>   side deleted, the payable by supplier in the journal and the opening balances, approval levels by amount, a
>   requisition submitted, approved, rejected with a comment, reopened and cancelled, a role deleted while a step
>   waits for it, two approvers deciding at once (one wins), the bell's recipients, and another workspace trying
>   every route.
> - **Guards broken on purpose**: four in the API (17a.4: the supplier balance counting the receivable, the waiting
>   list showing people their own submissions, the bell not falling back to the Owners, the customer-side check
>   forgetting quotations), one Bangla key removed (17a.5), two in the app (17a.6), four against the mock
>   (17a.7) and the money box fix taken out again (decision 53). Each was caught by the test or the type check meant for it, and the code was restored after it.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` (0035 and
> 0036) first, then restart `pnpm dev`. Your database may hold an opening balance or entries on the payable with no
> supplier; see "What changes". (2) **The screens against the real API:** they were clicked through by the
> Playwright tests against the mock API (17a.7), which signs in as the Owner only, so "waiting for someone else"
> was seen with the seeded requisition, not with two real people. The API side of it was tested with real people
> in real roles (17a.4). Please try 17a.10's steps 10 and 11 with a second member. (3) The Bangla texts were written
> by me, not reviewed by a native speaker. (4) The new tests on GitHub Actions.

## Goal

🛒 **Buying starts with a request.** Steps 15 and 16 sold goods and sent the papers out. Buying is the other half:
a garments factory buys yarn, trims and cartons every week, and a pharmaceutical company buys raw material worth
lakhs. Today Omnivo knows no supplier. The payable account is one big number, and nobody can tell from it how much
the company owes Meghna Spinning Mills and how much it owes the carton maker. And in most companies here, nobody
may buy before someone senior says yes. That "yes" is a signature on paper or a WhatsApp message, and nobody can
find it a month later.

17a is the first of four purchase guides. It brings the supplier, the payable kept per supplier, the purchase
requisition (a written request to buy), and the approval that a requisition must pass. From 17b on, a purchase
order uses the same approval.

After this step:

- **Suppliers:** a list, a form and a page, like customers. A code from its own series (`S-00001`), groups (Yarn and
  fabric, Accessories, Packaging), a contact, BIN, document language, the supplier's own payment terms and up to
  five bank accounts. A distributor that sells to you and buys from you is one party: "Make supplier too" on a
  customer, "Make customer too" on a supplier.
- **The payable is kept per supplier:** every payable line in the journal names a supplier, as every receivable
  line names a customer since step 15a. The supplier page shows what the company owes it and a statement (only with
  `purchase.supplier.balance`). The opening balances page splits the payable by supplier.
- **Requisitions** (`PR-2026-27-0001`): a store keeper or a merchandiser asks for goods or services for a warehouse.
  Each line has an estimated cost, filled in from the average cost. A requisition is a draft, then waiting for
  approval, then approved; or it is sent back to draft with a comment.
- **Approval levels** in Settings: for each kind of document, up to five levels, each "from ৳X, someone with the
  role Y". With "Purchase manager from ৳20,000, Director from ৳1,00,000", a requisition of ৳2,11,240 waits for both,
  one after the other; one of ৳1,944 needs nobody. Nobody approves their own document, and an Owner may approve any
  level.
- **Approvals** in everyone's navigation: the documents waiting for me, with a count. The bell tells the next
  approver, and at the end the person who wrote the document.

## The whole picture

```
packages/contracts   suppliers.ts (new): the supplier, its bank accounts (≤ 5), groups, statement, make customer/supplier too
      │               accounts.ts: the payable is a party account too, partyRoleOf() · series S and PR
      │               approvals.ts (new): rules (≤ 5 levels: from an amount, a role), rounds, steps, levelsFor()
      │               requisitions.ts (new) · purchase.ts (new): the cost lookup · 3 permissions in a Purchase group
      │               31 errors · bell approval.requested / approved / rejected · 21 new API paths
      ▼
packages/db          parties: supplier group, supplier terms, a check per side · supplier_groups · party_bank_accounts
                     approval_rules, approval_levels, approval_rounds, approval_steps · requisitions, requisition_lines
                     0035 (drizzle) · 0036 (RLS, the posting check knows the payable, the guards)
      │
      ▼
apps/api             purchase/: suppliers, supplier groups, the approvals engine (APPROVAL_TARGETS), requisitions,
                     the cost lookup · posting: the party by side · ledger: a supplier's statement · opening
                     balances by supplier · customers: delete one side · roles: a role a level needs stays
      │
      ▼
apps/app             Purchase in the navigation: Requisitions, Approvals (with a count), Suppliers, Supplier groups
                     supplier pages · Settings → Approval levels · requisition form, page and approval card
                     approve and reject dialogs · PartyPicker in the journal and opening balances · the bell
                     packages/i18n: the words · MSW: the same rules · Playwright: suppliers, requisitions

one requisition of ৳2,11,240; levels: Purchase manager from ৳20,000 · Director from ৳1,00,000
  Sadia (merchandiser) saves it ──POST /requisitions──► PR-2026-27-0003, a draft; amount = the sum of its lines
  Submit for approval ──POST /requisitions/{id}/submit {version}──► one transaction:
     lock the requisition · levelsFor(levels, 211240) = both · a round (pending) + 2 steps (role names copied)
     requisition → pending · bell approval.requested to the Purchase managers
     (no level reached, or the Owner's own: the steps are decided at once, round and requisition → approved)
  Kamal opens it from the bell ──POST /approvals/requisition/{id}/approve {roundId}──► one transaction:
     lock the requisition, then the round · still pending, and the round the page showed? · step 1 waiting?
     Kamal holds its role (read now, not from the cache)? not his own document? → step 1 approved
     bell to the people with the Director role; nobody has it → to the Owners
  the Owner approves step 2 ──► round approved · requisition → approved (locked) · bell approval.approved to Sadia
  or a reject ──{roundId, comment}──► round rejected · requisition → draft · bell approval.rejected to Sadia
  Reopen (pending or approved) ──► draft; the next submit is a new round from level 1, the old rounds stay
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Purchase orders and goods receipts | 17b. An order made from an approved requisition (which then cannot be reopened, decision 6); the receipt posts Dr Inventory / Cr Goods received not billed (decision 2). The PO PDF and email come with it (decision 4) |
| Bills and supplier payments | 17c. The payment shows the supplier's bank accounts (decision 8) |
| Purchase returns and debit notes | 17d |
| Approval of a purchase order, a bill or a payment | 17b and 17c add each kind to `APPROVAL_DOCUMENTS` and `APPROVAL_TARGETS`; Settings → Approval levels then shows a card for it |
| The last purchase price as a line's starting cost | 17b: there are no purchase prices before purchase orders. 17a starts from the average cost (decision 20) |
| Landed cost (LC, customs duty, freight), VDS and AIT (Mushak 6.6), supplier price lists | Later steps (decision 4) |
| A supplier's TIN, mobile wallet number and lead time | Left out (decision 8) |
| A level for a named person, a department, or "any two of three" | A level is a role (decision 5). A level for one person is a role that only that person has |
| Handing a level to someone else while its approver is on leave | An Owner may approve any level (decision 5), and the Owner can give someone the role for a while in Settings → Roles |
| Approving in one click from the bell or the list | A person approves what they have read (decision 44) |
| Emails about approvals | The bell only, like every notification so far |
| A supplier on payable lines posted before this step | They keep no party (decision 11); the rule is checked when an entry is posted, so old entries are never touched |
| A fix for the routes registry that every page carries | Decision 46: ask again in 17b if pages go over their budget |

## What changes in the code you already have

- **`pnpm db:migrate`** adds 0035 (eight tables and two `parties` columns) and 0036 (their rules). Every party you
  have stays a customer only; none becomes a supplier until someone clicks "Make supplier too". No new package, no
  new `.env` line and no new worker job (the bell uses step 8's notifications as they are).
- **A payable line needs a supplier.** From now on, posting a journal entry with a line on the payable account
  (purpose `accounts_payable`) without a supplier is refused with `journal_party_required`, and a receivable line
  must name a party that is a customer (decision 27). A draft may still leave the party empty, and a reversal is
  exempt. Entries posted before stay as they are. If your dev database has an opening balance on the payable, the
  opening balances page shows it on a line without a supplier ("Saved before suppliers were kept"); the next save
  of that page needs you to pick one.
- **Deleting a customer that is also a supplier** removes only its customer side (decisions 10 and 32). A
  customer-only party is deleted as before.
- **A role cannot be deleted while an approval level uses it** or a waiting step needs it. The refusal is the old
  `role_in_use`; its text now names approval levels too (decision 47).
- **A product used on a requisition cannot be deleted** (`product_variant_in_use`), like every other document line.
- **The role templates** give the three new permissions to new workspaces only (decision 33). In a workspace you
  already have, give `purchase.supplier.manage`, `purchase.supplier.balance` and `purchase.requisition.manage` in
  Settings → Roles. The Owner has every permission already.
- **Contracts:** `'accounts_payable'` joins `PARTY_ACCOUNT_PURPOSES`, so every place that asks "is this account kept
  per party?" now says yes for the payable too, and `partyRoleOf()` says which kind of party it takes. The
  customers' routes get `fromSupplier` (Make customer too).
- **app:** `CustomerPicker` is now one line that calls the new `PartyPicker`, so the sales screens did not change.
  The journal entry form and view, the ledger and the opening balances page show a supplier on payable lines. The
  customer page's statement moved into `PartyStatement` (a lazy chunk, shared with the supplier page). The sales
  line editor's product picker moved into `product-picker.tsx`. The bell opens a requisition.
- **Every money box selects its amount on focus** (decision 53, `packages/ui` `money-input.tsx`): Tab or a click,
  then typing, replaces the amount instead of adding to it. This is every money, cost and discount box in the app.
- **The first load got smaller** (decision 46): toasts load right after the first render (`packages/ui`
  `toast.tsx`), and the transfer form, the stock card and the money receipt form load one part a moment later.
- **Existing tests that change:** in the API, `journal.int.spec.ts` (the opening balance on the payable names a
  supplier), `numbering.int.spec.ts` (19 series) and `setup.int.spec.ts` (the garments roles' new permissions); in
  the app, `journal.e2e.ts` (the payable line by supplier) and `notifications.e2e.ts` (three unread now). The mock
  API's garments workspace gets a supplier, two new people (Sadia, Kamal) and two new roles (Purchase manager,
  Director).

## The decisions behind this step

You made the first eight on 2026-10-15. The others came up while building it; please read them with care: they are
mine.

1. **Purchase is four guides,** like sales: 17a suppliers, the payable, requisitions and approvals (this guide); 17b
   purchase orders and goods receipts; 17c bills and supplier payments; 17d purchase returns and debit notes. (You
   chose this.)
2. **A goods receipt is booked at the order's price.** (You chose this; it is built in 17b and 17c.) The goods
   receipt posts Dr Inventory / Cr "Goods received not billed" and updates the moving average at once. The bill
   posts Dr Goods received not billed / Dr VAT input / Cr Accounts payable. When the bill's price differs from the
   order's, the difference goes to a "Purchase price difference" account in Settings, not into the stock's value.
3. **Approvals are levels by amount and role,** per kind of document. (You chose this.) "A requisition from ৳50,000
   needs the Purchase manager; from ৳5,00,000 also the Owner." The levels are decided one after another. Rejecting
   sends the document back to draft. The bell and the audit log follow every step.
4. **A purchase order can be sent as a PDF or an email** (17b, with step 16's machinery). (You chose this.) Landed
   cost (LC, customs duty, freight), VAT and tax deducted at source (VDS/AIT, Mushak 6.6) and supplier price lists
   are later steps.
5. **A level is a role.** (You chose this.) Anyone with the level's role may approve it, and an Owner may approve any
   level, so a level never waits forever because its one manager is on leave.
6. **An approved document is locked.** (You chose this.) To change it, "Reopen" takes it back to draft; it is then
   approved again from the first level. The earlier rounds stay in its history. Once a later document uses it (a
   purchase order made from a requisition, 17b), it cannot be reopened.
7. **A requisition line has an estimated cost.** (You chose this.) The form fills it in (the last purchase price,
   else the average cost) and the person may change it. The requisition's amount, the sum of its lines, chooses the
   approval levels.
8. **A supplier keeps bank accounts.** (You chose this.) Bank, branch, account name and number, routing number. The
   payment screen (17c) shows them. A TIN, a mobile wallet number and a lead time were left out.

**The contract (17a.1):**

9. **A supplier is a party, like a customer.** The same row in `parties`, with `is_supplier` set (step 15a made the
   table for this). Its code comes from its own series, `S-00042`, a code for good like a customer's `C-00042`. The
   name, phone, email, BIN, document language and address are the party's: a distributor that is both has them once,
   and either page changes them. The supplier group, the supplier's payment terms and the bank accounts are the
   supplier's own. A supplier has one address, the party's billing address (what a purchase order prints).
10. **A party becomes both with one click,** "Make supplier too" on a customer and "Make customer too" on a supplier.
    The new side starts with its defaults. Archiving hides the party from both sides (it is one business). Deleting a
    party that is both removes only that side; this changes step 15a's customer delete too.
11. **The payable is kept per party, like the receivable.** Every line on the payable account names a supplier, and
    every line on the receivable a customer (`partyRoleOf`). The opening balances page splits the payable by supplier.
    Payable lines posted before this step keep no party; like step 15a's receivable, the rule is checked when an entry
    is posted, so old entries are never touched.
12. **A supplier's balance is what the company owes it** (credit minus debit of its payable lines). It is shown only
    with a new permission, `purchase.supplier.balance`, like a customer's balance.
13. **The levels of a kind of document:** at most five, each from an amount at least the one above it, each role
    once. `0` means every document; no levels means no approval. When a document is submitted, the levels it reaches
    are copied onto it, so a later change in Settings never moves a document that is already waiting.
14. **Nobody approves their own document, except an Owner.** The Owner answers to nobody, so the Owner's own document
    is approved when it is submitted, and the history says so.
15. **A rejection says why** (`approval_comment_required`), and the document goes back to draft. Every time a
    document is submitted makes a round; a round ends approved, rejected or reopened, and the history shows them all.
16. **Approve and reject have one path for every kind,** `/approvals/:document/:id/…`, like step 16's documents. The
    body names the round the page showed: if the document was reopened and submitted again since, the person would
    be approving something they never saw, so the server refuses (`approval_not_pending`). The route has no
    permission: holding the level's role is the right, and the server checks it.
17. **"Waiting for me":** a list of the documents whose waiting step the person may decide, oldest first, and a count
    for the navigation.
18. **The bell:** `approval.requested` to everyone who may decide the step that is now waiting;
    `approval.approved` and `approval.rejected` to the person who submitted it. A step in the middle that is approved
    rings nobody but the next level.
19. **A requisition is numbered when it is saved,** like a quotation. It names a warehouse (its branch is the
    warehouse's) and may name a date the goods are needed by. Its lines may be goods or services. It is a draft,
    pending, approved or cancelled. A draft that was never submitted may be deleted; after that it is cancelled
    instead, so its approval history stays. A pending one is reopened first.
20. **The starting cost is the average cost** in 17a (17b puts the last purchase price before it). It is sent only to
    someone with `inventory.stock.value`, because it was worked out from the books. Everyone else types a cost.
21. **Three permissions in a new "Purchase" group:** `purchase.supplier.manage`, `purchase.supplier.balance`,
    `purchase.requisition.manage`. The approval levels are a workspace setting (`core.settings.manage`). The error
    codes of the purchase documents start with `purchase_`, so 17b–17d reuse them.

**The database (17a.2):**

22. **A side the party is not on keeps its defaults.** A supplier-only party has no customer group, no customer
    terms, no credit limit and no price list; a customer-only party has no supplier group and no supplier terms. The
    database checks it. So removing the customer side of a party that is both clears those columns, and "Make
    customer too" later starts fresh (decision 10).
23. **The supplier's terms are a column of their own,** `supplier_payment_terms_days`, next to the customer's
    `payment_terms_days`. A distributor that buys and sells with the same company usually gets different terms each
    way. Supplier groups are a table of their own too, not a kind of customer group.
24. **Bank accounts are rows,** like addresses, so 17c's payment can point at the account it was sent to. The
    database checks the number formats (6 to 20 digits, a 9-digit routing number). "At most five" is left to the
    contract and the API: the supplier's save locks the party row first, so two saves cannot both add a fifth.
25. **Approval history is never deleted.** A round and its steps are written once; a step is decided once, after
    every step above it was approved. When a role is deleted, its old steps keep the role's name and lose only the
    link. A round names its document without a foreign key (the document is in a different table for each kind); a
    trigger checks that the document exists instead.
26. **A requisition's status follows its newest round, in the database.** It is pending only while a round waits,
    approved only when that round was approved, and goes from pending back to draft only when the round was
    rejected or reopened. Approval always passes through pending, even when no level applies or the Owner submits
    it: the API makes both moves in one transaction. Without that rule, a requisition reopened after approval could
    be set to approved again with its old round.
27. **The posting check knows the payable.** A payable line must name a party, and the party must be a supplier; a
    receivable line's party must be a customer. A reversal is exempt from both rules, so an old entry can always be
    undone.

**The API (17a.3):**

28. **The bell for a waiting step goes to the people who hold its role,** and to the Owners only when nobody holds
    it. Decision 18 says "everyone who may decide", and an Owner may decide any level; but ringing every Owner for
    every step of every requisition would teach them to ignore the bell. When nobody holds the role (or it was
    deleted), the Owners are told, so a document never waits with nobody knowing.
29. **Who may decide is read from the database at that moment,** not from the permission cache (which may be ten
    minutes old). A person whose Purchase manager role was taken away this morning cannot approve this afternoon.
30. **One approvals engine, in the purchase module.** Every document that needs an approval is a purchase document,
    so the engine lives next to them. Each kind gives it three small functions (lock, set the status, describe), in
    `APPROVAL_TARGETS`; 17b adds the purchase order there. Every path locks the document first and its round
    second, so no two of them can deadlock.
31. **A supplier's address is the party's billing address,** as text. Changing it on the supplier page changes only
    the address and keeps the label and phone a customer page gave it; clearing it removes the party's billing
    address, from both pages.
32. **Removing one side checks that side by hand.** No foreign key fires when only a flag changes, so the API looks
    for what uses the side: the sales documents and receivable lines for the customer side, the payable lines for
    the supplier side (17b–17d add their documents). Removing the customer side also removes its shipping
    addresses: they are where the customer's goods went.
33. **The role templates:** the Accountant gets the suppliers and their balances; the people who run the stock (Store
    keeper, Depot manager, Production manager, Merchandiser) get requisitions; a Shop manager and a Manager get
    both. No template sets approval levels: a new workspace has none until the owner sets them.
34. **The audit log shows bank accounts by their last four digits** ("Dutch-Bangla Bank …0123"): enough to see which
    one changed, without copying every account number into the log.

**The screens (17a.6):**

35. **One party box for both sides.** `PartyPicker` searches customers or suppliers, by the role of the line's
    account (`partyRoleOf`). The old `CustomerPicker` is now one line that calls it, so the eight sales lists and
    forms that use it did not change.
36. **One statement for both sides.** The customer's statement moved out of the customer page into
    `PartyStatement`, and the supplier page uses the same table. It is a chunk of its own on both pages: it brings
    the data table and two date pickers, and only people with the balance permission see it.
37. **"Make supplier too" opens the supplier's page** (and "Make customer too" the customer's). The new side
    starts with its defaults (decision 22): no group, terms on receipt, no bank account. The person almost always
    wants to set those next, so the page they need is the one they land on.
38. **Two query prefixes.** Everything about suppliers is under `['suppliers', tenant]`. A supplier save refreshes
    `['customers', tenant]` too, because a party that is both is one row: its name changed on one page is its name
    on the other. Requisitions, the "waiting for me" list and its count are under `['purchase', tenant]`, so one
    refresh after a decision updates all of them (17b's orders join it).
39. **"Approvals" is in everyone's navigation,** with a `crit` count while something waits. Any member may hold a
    level's role, and no permission says who. The count is polled like the bell's badge, every 30 seconds while the
    tab is visible.
40. **"Approval levels" is in the navigation only for people who may change it** (`core.settings.manage`), like
    Numbering. Everyone may still open the page and read it. One card per kind of document, each its own form, so
    saving one kind never touches another. The amounts are whole taka.
41. **A requisition opens as a page, not as a form.** A draft shows Edit and "Submit for approval"; Edit turns the
    page into the form until it is saved, like a quotation. Submitting from the page, not from the form, means the
    person sees the saved amount, and so the levels it will need, before sending it.
42. **The statuses:** a requisition Draft (neutral, `FileEdit`), Waiting for approval (`brand`, `Clock01`),
    Approved (`good`, `CheckmarkCircle02`), Cancelled (neutral, `CancelCircle`). A round Waiting (`brand`), Approved
    (`good`), Rejected (`warn`, `ArrowTurnBackward`: its writer must act), Reopened (neutral, `Undo02`). A step
    Approved, Rejected and Waiting the same way, and "Not yet" / "Not decided" neutral (`MinusSignCircle`).
43. **A requisition sent back shows a `warn` notice with the comment,** at the top of its page. Every other state
    gets the neutral notice. The rejection is the one state where the writer must do something.
44. **Approve and Reject are on the document's page only,** never on the "waiting for me" list. A person approves
    what they have read; the list only takes them there.
45. **One "Add items" dialog.** The sales line editor's product picker moved to `product-picker.tsx`; the
    requisition lines use it too, each with its own words (`salesLines.*` or `purchaseLines.*`).
46. **Toasts load after the first render, and three pages load a part later.** (You chose this.) The contracts and
    words of 17a.1 and 17a.5 took the first load to 201.5 KB and three pages over their 100 KB budget before any
    screen of this part was added. The cause is the contracts' route registry: every page that calls the API
    carries all of it (27.6 KB gz), so every step's new routes make every page bigger. The fix here: sonner (the
    toast library) became a chunk of its own, and the transfer form, the stock card and the money receipt form load
    a date picker or the credit line later. Removing the routes' `summary` texts from the app build, or importing
    route groups instead of the whole registry, would fix the cause; that is a later decision.

**The mock API (17a.7):**

47. **The `role_in_use` message names the approval levels.** Since 17a.3 a role that an approval level uses cannot
    be deleted, but the message still said "someone has this role, an open invitation gives it, or a document waits
    for its approval". A person deleting "Director", which nobody holds, would read that and not know where to look.
    The message now adds "an approval level uses it" and names Settings → Approval levels, in English, in Bangla and
    in the API's own message. The three file changes are shown in this part; 17a.3 and 17a.5 are not repeated.
48. **A party on both sides is two records with one id in the mock.** The API keeps one `parties` row. The mock
    keeps its customers in `sales.customers` (since 15a) and its suppliers in the new `suppliers.suppliers`, so a
    party on both sides has one record in each, under the same id. After a save on one side, the fields they share
    (code, name, contact, phone, email, language, BIN, notes, archived, version) are copied to the other side, and
    the supplier's address goes to the customer's billing address. So the version a page sends back is the party's
    version, whichever page it came from, exactly like the API.
49. **The seeded purchase desk follows the bell rule of decision 28.** The garments workspace gets two roles,
    Purchase manager and Director, and two members: Sadia Islam (a merchandiser who writes requisitions) and Kamal
    Uddin (the purchase manager). Nobody holds Director. Requisitions from ৳20,000 need the purchase manager, from
    ৳1,00,000 the director as well. Sadia's jersey requisition (PR-…-0003, ৳2,11,240) was approved by Kamal at step
    1, and step 2 waits for a Director. Because nobody holds that role, the bell rang the Owners: that is the
    approval notification the mock's owner finds on the first page load. A seed that simply put a notification in
    the bell would show something the API never sends.
50. **In the mock every requisition the person submits is approved at once.** The mock always signs in as the Owner
    (as every earlier step said), and an Owner's own documents are approved when submitted (decision 14). So the
    waiting requisition comes from the seed, and the end-to-end tests cannot click "You submitted it, so someone else
    approves it" or `approval_not_allowed`. The API's tests (17a.4) check those, with real people in real roles.
51. **The handlers write 17a's audit rows, not the data files.** `requisition-data.ts` is imported by
    `workspace-data.ts` (for its seed), so it cannot import `record()` from it: `pnpm boundaries` refuses circular
    imports. The data functions return what the audit row needs (the step decided, the number of steps), and the
    handler writes it, like the customer handlers of 15a.
52. **No party is on both sides in the seed.** Making Bengal Buying House a supplier too in the seed would change
    what older tests see (its delete would only drop a side). The new suppliers test makes a party both, from the
    customer's page, and takes the supplier side away again.

**Your fix (17a.7):**

53. **The money box selects its amount when it gets the focus.** (You asked for this.) The box shows "1,00,000"
    until it has the focus and the plain digits ("100000") while it is edited. Before, React swapped the text on its
    next render, after the browser had selected the old text, so the caret jumped to the end and a person who
    tabbed in and typed got the new digits after the old ones. Now the box swaps the text in the focus event itself
    and selects all of it. Tab and a click both select the whole amount, so typing replaces it; a second click puts
    the caret where it lands. This is `DecimalInput` in `packages/ui`, so every money, cost and discount box in the
    app gets it, not only the requisition's.

## 17a.1 — `packages/contracts`: the contract

As in every step, the contract comes first. Four new files: `suppliers.ts` (the supplier and its groups),
`approvals.ts` (the levels, a document's rounds and the "waiting for me" list), `purchase.ts` (what every purchase
document shares) and `requisitions.ts`. The rest are small changes: the payable becomes a party account, two new
number series, three permissions, the error codes, the audit actions, three bell types and the routes.

### `accounts.ts`: the payable is kept per party

```diff
@@ -38,17 +38,34 @@ export const ACCOUNT_PURPOSES = [
 ] as const;
 export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number];
 
-// The accounts kept per party (step 15a): the receivable is one account in the chart, and every line
-// on it names the customer, so the customers' balances add up to the account's balance. Step 17
-// adds 'accounts_payable' for suppliers.
+// The accounts kept per party: the receivable (step 15a) and the payable (step 17a) are each one
+// account in the chart, and every line on them names the party, so the customers' balances add up
+// to the receivable and the suppliers' balances to the payable.
 export const PARTY_ACCOUNT_PURPOSES = [
   'accounts_receivable',
+  'accounts_payable',
 ] as const satisfies readonly AccountPurpose[];
+export type PartyAccountPurpose = (typeof PARTY_ACCOUNT_PURPOSES)[number];
 
-export function isPartyAccountPurpose(value: string | null): boolean {
+export function isPartyAccountPurpose(value: string | null): value is PartyAccountPurpose {
   return PARTY_ACCOUNT_PURPOSES.some((purpose) => purpose === value);
 }
 
+// Which kind of party a line on that account names: a customer owes on the receivable, the company
+// owes a supplier on the payable. A party that is both has lines on both accounts.
+export const PARTY_ROLES = ['customer', 'supplier'] as const;
+export type PartyRole = (typeof PARTY_ROLES)[number];
+
+export const PARTY_ROLE_OF = {
+  accounts_receivable: 'customer',
+  accounts_payable: 'supplier',
+} as const satisfies Record<PartyAccountPurpose, PartyRole>;
+
+// null for an account that is not kept per party: its lines name nobody
+export function partyRoleOf(purpose: string | null): PartyRole | null {
+  return isPartyAccountPurpose(purpose) ? PARTY_ROLE_OF[purpose] : null;
+}
+
 export function isAccountPurpose(value: string): value is AccountPurpose {
   return ACCOUNT_PURPOSES.some((purpose) => purpose === value);
 }
```

- **`'accounts_payable'` joins `PARTY_ACCOUNT_PURPOSES`** (decision 11). Every place that already asks "is this
  account kept per party?" (the posting check, the journal form, the ledger, the opening balances page) now says yes
  for the payable as well. What they still need is to look for a supplier there instead of a customer: the API in
  17a.3, the pages in 17a.6.
- **`isPartyAccountPurpose` became a type guard** (`value is PartyAccountPurpose`). Its callers pass a plain
  `string | null`; inside an `if`, TypeScript now knows the value is one of the two purposes, so `partyRoleOf` can
  index `PARTY_ROLE_OF` without a cast.
- **`PARTY_ROLE_OF` says which kind of party a line names.** The API checks a receivable line against customers and
  a payable line against suppliers; the journal form shows the customer picker or the supplier picker. `satisfies
  Record<PartyAccountPurpose, PartyRole>` makes a third party purpose a type error here until it has a role.

### `numbering.ts`: two new series

```diff
@@ -23,6 +23,8 @@ export const DOCUMENT_TYPES = [
   'sales.return',
   'sales.credit_note',
   'sales.refund',
+  'purchase.supplier',
+  'purchase.requisition',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -57,14 +59,25 @@ const DEFAULT_PREFIXES = {
   'sales.return': 'SR',
   'sales.credit_note': 'CN',
   'sales.refund': 'RF',
+  // A supplier's code (step 17a): S-00042, a code for good like a customer's
+  'purchase.supplier': 'S',
+  // A purchase requisition: a request to buy, before any supplier is asked (step 17a)
+  'purchase.requisition': 'PR',
 } satisfies Record<DocumentType, string>;
 
 // টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
 // A product code is not a yearly document: P-00042 stays P-00042 for the product's whole life, so
 // its series never restarts (no year) and has room for 99,999 products before it grows a digit.
-// A customer code (step 15a) is the same kind of code: C-00042 for good.
+// A customer code (step 15a) and a supplier code (step 17a) are the same kind of code: C-00042 and
+// S-00042 for good.
+const CODE_SERIES: readonly DocumentType[] = [
+  'inventory.product',
+  'sales.customer',
+  'purchase.supplier',
+];
+
 export function defaultNumberFormat(documentType: DocumentType): NumberFormat {
-  if (documentType === 'inventory.product' || documentType === 'sales.customer') {
+  if (CODE_SERIES.includes(documentType)) {
     return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'none', padding: 5 };
   }
   return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'fiscal', padding: 4 };
```

- **`purchase.supplier` (`S`) and `purchase.requisition` (`PR`).** `DEFAULT_PREFIXES` is `satisfies
  Record<DocumentType, string>`, so a document type without a prefix does not compile.
- **`CODE_SERIES` replaces the `||` chain.** A supplier's code is a code for good, like a product's and a customer's:
  no year, five digits. A third `||` would have made the line hard to read; a named list says what the three have in
  common. `defaultNumberFormat` is used by the API and by the mock API, so both give `S-00001` first.

### `permissions.ts`: the Purchase group

```diff
@@ -33,6 +33,9 @@ export const PERMISSION_KEYS = [
   'sales.return.manage',
   'sales.credit_note.manage',
   'sales.refund.manage',
+  'purchase.supplier.manage',
+  'purchase.supplier.balance',
+  'purchase.requisition.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -45,7 +48,14 @@ export function isPermissionKey(value: string): value is PermissionKey {
 
 // matrix-এর সারি কোন দলে: key-র মাঝের অংশ (resource) দিয়ে না, হাতে বাছা — "Team" দলে user আর role
 // দুটোই থাকে, কারণ মানুষ দুটোকে একই কাজ ভাবে। Record<PermissionKey, …>: নতুন key দল ছাড়া থাকতে পারে না
-export const PERMISSION_GROUPS = ['team', 'workspace', 'accounting', 'inventory', 'sales'] as const;
+export const PERMISSION_GROUPS = [
+  'team',
+  'workspace',
+  'accounting',
+  'inventory',
+  'sales',
+  'purchase',
+] as const;
 export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];
 
 export const PERMISSION_GROUP_OF = {
@@ -80,4 +90,7 @@ export const PERMISSION_GROUP_OF = {
   'sales.return.manage': 'sales',
   'sales.credit_note.manage': 'sales',
   'sales.refund.manage': 'sales',
+  'purchase.supplier.manage': 'purchase',
+  'purchase.supplier.balance': 'purchase',
+  'purchase.requisition.manage': 'purchase',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

- **Three keys, one new group** (decision 21). `PERMISSION_GROUP_OF` is `satisfies Record<PermissionKey,
  PermissionGroup>`, so a key without a group does not compile, and the roles page shows a new "Purchase" block in
  the matrix. 17b–17d add their own keys to it.
- **No approve permission.** Who approves is set by the levels' roles (decision 5). A permission would be a second
  list to keep in step with them, and "may approve requisitions" says nothing about the amount.

### `suppliers.ts` (new)

```ts
import { z } from 'zod';

import { MAX_PAYMENT_TERMS_DAYS } from './customers.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { ledgerPageSchema, ledgerQuerySchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { LANGUAGE_CODES } from './preferences.js';
import { optionalCode } from './products.js';
import { binSchema, optionalEmailSchema } from './settings.js';
import { optionalIdSchema } from './stock.js';

// A supplier is a party, like a customer (step 15a): the same row in the parties table with
// is_supplier set. A distributor that both sells to the company and buys from it is one party with
// one code, and its customer and supplier pages edit the same name, phone and address.

// A company pays a supplier into one of a few accounts: a current account for cheques, another
// bank for BEFTN transfers
export const MAX_SUPPLIER_BANK_ACCOUNTS = 5;

// ---------------------------------------------------------------------------------------------
// What the API sends

// Where the company pays the supplier. The payment screen (step 17c) shows the first one.
export const supplierBankAccountSchema = z.object({
  id: z.uuid(),
  bankName: z.string(),
  // The bank's branch ("Motijheel"); null when the person did not type one
  branchName: z.string().nullable(),
  // The name on the account, which may differ from the supplier's trade name
  accountName: z.string(),
  accountNumber: z.string(),
  // The 9-digit BEFTN routing number of the branch; null when not typed
  routingNumber: z.string().nullable(),
});
export type SupplierBankAccount = z.infer<typeof supplierBankAccountSchema>;

export const supplierSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  // The supplier group, not the customer group: a party that is both has one of each
  groupId: z.uuid().nullable(),
  contactPerson: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  // The language of the purchase orders the supplier gets (step 17b), shared with the customer side
  documentLanguage: z.enum(LANGUAGE_CODES),
  bin: z.string().nullable(),
  // Days from a bill's date to its due date (step 17c). The supplier's own terms: a party that is
  // also a customer has separate customer terms.
  paymentTermsDays: z.number().int(),
  // The party's billing address: what a purchase order prints. null = none typed.
  address: z.string().nullable(),
  bankAccounts: z.array(supplierBankAccountSchema),
  notes: z.string().nullable(),
  // The same party is also a customer
  isCustomer: z.boolean(),
  // What the company owes the supplier now: credit minus debit of the payable lines that carry this
  // party. null when the person may not see balances (purchase.supplier.balance).
  balance: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Supplier = z.infer<typeof supplierSchema>;

// One row of the list: no bank accounts, address or notes
export const supplierSummarySchema = supplierSchema.pick({
  id: true,
  code: true,
  name: true,
  groupId: true,
  contactPerson: true,
  phone: true,
  paymentTermsDays: true,
  isCustomer: true,
  balance: true,
  archivedAt: true,
  updatedAt: true,
});
export type SupplierSummary = z.infer<typeof supplierSummarySchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// What a cheque book prints: "0123-4567890-01". Spaces and hyphens are dropped, so the same account
// typed two ways is one number.
const accountNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => /^\d{6,20}$/.test(value), errorCode('bank_account_number_format'));

const routingNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => value === '' || /^\d{9}$/.test(value), errorCode('routing_number_format'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

const supplierBankAccountInputSchema = z.object({
  // An existing account keeps its id: a payment (step 17c) remembers which account it went to
  id: z.uuid().nullable(),
  bankName: z.string().trim().min(2, errorCode('supplier_bank_name_required')).max(80),
  branchName: optionalText(80),
  accountName: z.string().trim().min(2, errorCode('supplier_account_name_required')).max(120),
  accountNumber: accountNumberSchema,
  routingNumber: routingNumberSchema,
});
export type SupplierBankAccountInput = z.input<typeof supplierBankAccountInputSchema>;

export const supplierInputSchema = z.object({
  // null = the next number from the 'purchase.supplier' series (S-00042)
  code: optionalCode('supplier_code_format'),
  name: z.string().trim().min(2, errorCode('supplier_name_required')).max(120),
  groupId: optionalIdSchema,
  contactPerson: optionalText(80),
  phone: optionalText(30),
  email: optionalEmailSchema,
  documentLanguage: z.enum(LANGUAGE_CODES),
  bin: binSchema,
  paymentTermsDays: z.number().int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
  address: optionalText(300),
  bankAccounts: z.array(supplierBankAccountInputSchema).max(MAX_SUPPLIER_BANK_ACCOUNTS),
  notes: optionalText(500),
});
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export type SupplierFormValues = z.input<typeof supplierInputSchema>;

export const updateSupplierInputSchema = supplierInputSchema.extend({ version: versionSchema });
export type UpdateSupplierInput = z.infer<typeof updateSupplierInputSchema>;

export const supplierVersionInputSchema = z.object({ version: versionSchema });

export const deleteSupplierQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// ---------------------------------------------------------------------------------------------
// The list

export const SUPPLIER_SORTS = ['name', '-name', 'code', '-code', '-updated'] as const;
export type SupplierSort = (typeof SUPPLIER_SORTS)[number];

export const SUPPLIER_STATUSES = ['active', 'archived'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const supplierListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code, the contact person or the phone number
  search: z.string().trim().max(100).optional(),
  groupId: z.uuid().optional(),
  status: z.enum(SUPPLIER_STATUSES).default('active'),
  sort: z.enum(SUPPLIER_SORTS).default('name'),
});
export type SupplierListQuery = z.input<typeof supplierListQuerySchema>;

export const supplierPageSchema = pageOf(supplierSummarySchema);
export type SupplierPage = z.infer<typeof supplierPageSchema>;

const supplierParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like customers: a requisition and a purchase order pick a supplier.
// The balance is shown only with purchase.supplier.balance, and the statement needs it too.
export const supplierRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/suppliers',
    summary: 'Suppliers, a page at a time, searched, filtered and sorted on the server',
    auth: 'bearer',
    status: 200,
    query: supplierListQuerySchema,
    response: supplierPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/suppliers/:id',
    summary: 'One supplier with its address and bank accounts',
    auth: 'bearer',
    status: 200,
    params: supplierParamsSchema,
    response: supplierSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/suppliers',
    summary: 'Add a supplier',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 201,
    body: supplierInputSchema,
    response: supplierSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/suppliers/:id',
    summary: 'Change a supplier: the bank accounts sent replace the ones it had',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: updateSupplierInputSchema,
    response: supplierSchema,
  }),
  // A customer the company starts buying from: the same party, now also a supplier, with the
  // supplier's own fields at their defaults (no group, terms 0, no bank account)
  fromCustomer: defineRoute({
    method: 'POST',
    path: '/customers/:id/make-supplier',
    summary: 'Make a customer a supplier too',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: supplierVersionInputSchema,
    response: supplierSchema,
  }),
  // Archived = the party: a party that is also a customer is hidden from sales documents too
  archive: defineRoute({
    method: 'POST',
    path: '/suppliers/:id/archive',
    summary: 'Hide a supplier from new documents; its history and balance stay',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: supplierVersionInputSchema,
    response: supplierSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/suppliers/:id/restore',
    summary: 'Bring an archived supplier back',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: supplierVersionInputSchema,
    response: supplierSchema,
  }),
  // A supplier that is also a customer stays as a customer: only the supplier side goes
  remove: defineRoute({
    method: 'DELETE',
    path: '/suppliers/:id',
    summary: 'Delete a supplier that no entry or document uses yet',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 204,
    params: supplierParamsSchema,
    query: deleteSupplierQuerySchema,
    response: z.void(),
  }),
  // The payable lines of this supplier, like a customer's statement. Credit = the company owes more.
  statement: defineRoute({
    method: 'GET',
    path: '/suppliers/:id/statement',
    summary: "A supplier's posted payable lines in date order, with the running balance",
    auth: 'bearer',
    permission: 'purchase.supplier.balance',
    status: 200,
    params: supplierParamsSchema,
    query: ledgerQuerySchema,
    response: ledgerPageSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Supplier groups: Local, Importer, Raw material, Packaging — for filtering the list

export const supplierGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  // Archived suppliers count too: a group that holds any supplier cannot be deleted
  supplierCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type SupplierGroup = z.infer<typeof supplierGroupSchema>;

export const supplierGroupInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('supplier_group_name_required')).max(60),
});
export type SupplierGroupInput = z.infer<typeof supplierGroupInputSchema>;

export const updateSupplierGroupInputSchema = supplierGroupInputSchema.extend({
  version: versionSchema,
});

export const deleteSupplierGroupQuerySchema = deleteSupplierQuerySchema;

// A handful of groups: the whole list at once
export const supplierGroupListSchema = z.object({ items: z.array(supplierGroupSchema) });

const supplierGroupParamsSchema = z.object({ id: z.uuid() });

export const supplierGroupRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/supplier-groups',
    summary: 'The supplier groups of the workspace',
    auth: 'bearer',
    status: 200,
    response: supplierGroupListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/supplier-groups',
    summary: 'Add a supplier group',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 201,
    body: supplierGroupInputSchema,
    response: supplierGroupSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/supplier-groups/:id',
    summary: 'Rename a supplier group',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierGroupParamsSchema,
    body: updateSupplierGroupInputSchema,
    response: supplierGroupSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/supplier-groups/:id',
    summary: 'Delete a supplier group that holds no supplier',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 204,
    params: supplierGroupParamsSchema,
    query: deleteSupplierGroupQuerySchema,
    response: z.void(),
  }),
};
```

- **The shape mirrors `customers.ts` on purpose.** The list, the form, the groups and the statement work the same,
  so 17a.6 can reuse the customer pages' parts. What differs is only what a supplier has and a customer does not.
- **`address` is one string, not a list of addresses.** A supplier needs one address, the one a purchase order
  prints (decision 9). It is the party's billing address. For a party that is also a customer, the customer page
  edits the same address, and the shipping addresses stay the customer's.
- **`paymentTermsDays` is the supplier's own.** A distributor may give its customers 30 days and get 60 from its
  supplier. One column for both would make one of them wrong.
- **`balance` is what the company owes** (decision 12): credit minus debit, so a positive number means "we owe".
  Showing it the other way round (negative for a normal supplier) would confuse every reader.
- **`accountNumberSchema` drops spaces and hyphens.** A cheque book prints `0123-4567890-01`; a person types
  `01234567890 01`. Both are the same account, and a later search or a bank file (17c) needs one form. 6 to 20 digits
  covers every Bangladeshi bank's account numbers. A letter is refused: no bank in the country uses one.
- **`routingNumberSchema` is 9 digits or nothing.** The BEFTN routing number of a Bangladeshi bank branch has 9
  digits. It is optional, because a cheque payment does not need it.
- **A bank account keeps its `id`.** A payment (17c) will remember which account the money went to. Replacing the
  rows on every save would break that link, so the form sends the id of an existing row, and `null` for a new one.
- **`fromCustomer` sits in the supplier routes but on the customer's path** (`/customers/:id/make-supplier`). It is
  a supplier action (it needs `purchase.supplier.manage` and answers with a supplier), but its target is a customer,
  so the path names what the id is. The version in the body is the customer's: the party is one row.
- **`remove` on a party that is both removes only the supplier side** (decision 10). The comment says so, because a
  person reading the route would expect the row to go.

```ts
import { describe, expect, it } from 'vitest';

import { partyRoleOf } from './accounts.js';
import { defaultNumberFormat, formatDocumentNumber } from './numbering.js';
import { type SupplierFormValues, supplierInputSchema } from './suppliers.js';

function supplier(extra: Partial<SupplierFormValues> = {}): SupplierFormValues {
  return {
    code: '',
    name: 'Karim Fabrics Ltd.',
    groupId: '',
    contactPerson: '',
    phone: '01811-000000',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 45,
    address: '',
    bankAccounts: [],
    notes: '',
    ...extra,
  };
}

const bankAccount = {
  id: null,
  bankName: 'Dutch-Bangla Bank',
  branchName: 'Motijheel',
  accountName: 'Karim Fabrics Ltd.',
  accountNumber: '',
  routingNumber: '',
};

describe('supplier input', () => {
  it('reads empty boxes as "not set": no code, no group, no address', () => {
    expect(supplierInputSchema.parse(supplier())).toMatchObject({
      code: null,
      groupId: null,
      email: null,
      bin: null,
      address: null,
    });
  });

  it('cleans an account number typed with spaces and hyphens, and keeps an empty routing as null', () => {
    const parsed = supplierInputSchema.parse(
      supplier({ bankAccounts: [{ ...bankAccount, accountNumber: '0123-4567 890-01' }] }),
    );
    expect(parsed.bankAccounts[0]).toMatchObject({
      accountNumber: '0123456789001',
      routingNumber: null,
    });
  });

  it('refuses a short account number and a routing number that is not 9 digits, on each box', () => {
    const result = supplierInputSchema.safeParse(
      supplier({
        bankAccounts: [{ ...bankAccount, accountNumber: '12345', routingNumber: '0901234' }],
      }),
    );
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['bankAccounts', 0, 'accountNumber'],
        message: 'bank_account_number_format',
      }),
      expect.objectContaining({
        path: ['bankAccounts', 0, 'routingNumber'],
        message: 'routing_number_format',
      }),
    ]);
  });

  it('holds at most five bank accounts', () => {
    const account = { ...bankAccount, accountNumber: '1234567890' };
    expect(
      supplierInputSchema.safeParse(
        supplier({ bankAccounts: Array.from({ length: 6 }, () => account) }),
      ).success,
    ).toBe(false);
  });

  it('gives a supplier its own code series, a code for good like a customer', () => {
    expect(formatDocumentNumber(defaultNumberFormat('purchase.supplier'), '', 42)).toBe('S-00042');
    expect(defaultNumberFormat('purchase.requisition')).toMatchObject({
      prefix: 'PR',
      yearStyle: 'fiscal',
    });
  });
});

describe('partyRoleOf', () => {
  it('names a customer on the receivable, a supplier on the payable, nobody elsewhere', () => {
    expect(partyRoleOf('accounts_receivable')).toBe('customer');
    expect(partyRoleOf('accounts_payable')).toBe('supplier');
    expect(partyRoleOf('cash')).toBeNull();
    expect(partyRoleOf(null)).toBeNull();
  });
});
```

- The tests check the form's empty boxes, the cleaned account number, one error per bad box, the five-account
  limit, the new code series, and `partyRoleOf`.

### `customers.ts`: "Make customer too"

```diff
@@ -10,7 +10,7 @@ import { LANGUAGE_CODES } from './preferences.js';
 import { optionalCode } from './products.js';
 import { binSchema, optionalEmailSchema } from './settings.js';
 
-// A customer is a party: one row in the parties table, which step 17 also uses for suppliers. A
+// A customer is a party: one row in the parties table, which step 17a also uses for suppliers. A
 // distributor that both buys from a company and sells to it is one party with one statement, not
 // two records that have to be netted by hand.
 
@@ -61,7 +61,7 @@ export const customerSchema = z.object({
   // The billing address first (if there is one), then the shipping addresses in the order the
   // person put them. The first shipping address is the default on a delivery.
   addresses: z.array(customerAddressSchema),
-  // The same party is also a supplier (step 17)
+  // The same party is also a supplier (step 17a)
   isSupplier: z.boolean(),
   // What the customer owes now: debit minus credit of the receivable lines that carry this party.
   // null when the person may not see balances (sales.customer.balance).
@@ -262,6 +262,20 @@ export const customerRoutes = {
     body: customerVersionInputSchema,
     response: customerSchema,
   }),
+  // A supplier the company starts selling to (step 17a): the same party, now also a customer, with
+  // the customer's own fields at their defaults (no group, terms 0, no limit, no price list)
+  fromSupplier: defineRoute({
+    method: 'POST',
+    path: '/suppliers/:id/make-customer',
+    summary: 'Make a supplier a customer too',
+    auth: 'bearer',
+    permission: 'sales.customer.manage',
+    status: 200,
+    params: customerParamsSchema,
+    body: customerVersionInputSchema,
+    response: customerSchema,
+  }),
+  // A customer that is also a supplier (step 17a) stays as a supplier: only the customer side goes
   remove: defineRoute({
     method: 'DELETE',
     path: '/customers/:id',
```

- **`fromSupplier`** is the same action the other way round. It needs `sales.customer.manage`: a purchase clerk who
  may add suppliers may not decide who buys on credit.

### `journal.ts`: comments only

```diff
@@ -103,9 +103,9 @@ export const MAX_OPENING_BALANCE_LINES = 5000;
 export const entryRefSchema = z.object({ id: z.uuid(), number: z.string() });
 export type EntryRef = z.infer<typeof entryRefSchema>;
 
-// The customer (later also the supplier) a line belongs to, as a page shows it. Sent with its code
-// and name because a workspace has too many customers for the app to load them all, the way it
-// loads the chart of accounts.
+// The customer or supplier a line belongs to, as a page shows it. Sent with its code and name
+// because a workspace has too many parties for the app to load them all, the way it loads the
+// chart of accounts.
 export const partyRefSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });
 export type PartyRef = z.infer<typeof partyRefSchema>;
 
@@ -113,7 +113,8 @@ export const journalLineSchema = z.object({
   id: z.uuid(),
   accountId: z.uuid(),
   branchId: z.uuid().nullable(),
-  // Set on every line of the receivable account (step 15a), and on no other line
+  // A customer on every line of the receivable account (step 15a), a supplier on every line of the
+  // payable (step 17a), and nobody on any other line
   party: partyRefSchema.nullable(),
   description: z.string().nullable(),
   // Decimal strings with 4 places, as Postgres sends NUMERIC(19,4): "18500.0000". One side is
@@ -349,7 +350,8 @@ export const ledgerRoutes = {
 // purpose is 'opening_balance_equity'.
 
 // The receivable account's opening balance is split by customer (step 15a): one line per customer
-// who owed money on the go-live date. Every other account has one line, without a party.
+// who owed money on the go-live date. The payable is split by supplier the same way (step 17a): one
+// line per supplier the company owed. Every other account has one line, without a party.
 export const openingBalanceLineSchema = z.object({
   accountId: z.uuid(),
   party: partyRefSchema.nullable(),
@@ -389,10 +391,10 @@ export const openingBalancesInputSchema = z.object({
         }),
     )
     .max(MAX_OPENING_BALANCE_LINES)
-    // One line per account, and per customer on the receivable: two lines for the same customer
-    // would be added up silently, and the person would not see the number they typed. Empty lines
-    // do not count: the server drops them, and the page may hold a few customer rows not filled in
-    // yet (step 15a.6).
+    // One line per account, and per party on the receivable and the payable: two lines for the same
+    // customer would be added up silently, and the person would not see the number they typed.
+    // Empty lines do not count: the server drops them, and the page may hold a few party rows not
+    // filled in yet (step 15a.6).
     .superRefine((lines, ctx) => {
       const seen = new Set<string>();
       lines.forEach((line, index) => {
```

- Nothing in the shapes changes: a line already has a `partyId`, and the opening balances already allow one line per
  party. The comments say that the payable is split by supplier now.

### `approvals.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { roleRefSchema } from './members.js';
import { compareMoney, isMoneyAmount } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// An approval (step 17a, you chose this): per kind of document, an ordered list of levels. Each
// level has an amount and a role. A document needs every level whose amount it reaches, one after
// another: "a requisition from ৳50,000 needs the Purchase manager, from ৳5,00,000 also the Owner".
// Anyone with the level's role may approve it, and an Owner may approve any level. Nobody approves
// their own document, except an Owner: the Owner answers to nobody, so the Owner's own document is
// approved when it is submitted.

// The documents that can need an approval. Each guide adds its own: 17b the purchase order, 17c the
// bill and the supplier payment.
export const APPROVAL_DOCUMENTS = ['requisition'] as const;
export type ApprovalDocument = (typeof APPROVAL_DOCUMENTS)[number];

export function isApprovalDocument(value: string): value is ApprovalDocument {
  return APPROVAL_DOCUMENTS.some((document) => document === value);
}

// More than five signatures on one purchase is a process nobody follows
export const MAX_APPROVAL_LEVELS = 5;

// ---------------------------------------------------------------------------------------------
// The rules (Settings → Approvals)

export const approvalLevelSchema = z.object({
  // A document whose amount is at least this needs the level. "0.0000" = every document.
  minAmount: z.string(),
  role: roleRefSchema,
});
export type ApprovalLevel = z.infer<typeof approvalLevelSchema>;

export const approvalRuleSchema = z.object({
  // z.string(), not the enum: a newer server's new document must not break an older client
  document: z.string(),
  // In order: the first one approves first. Empty = documents of this kind need no approval.
  levels: z.array(approvalLevelSchema),
  // 0 = the workspace never saved levels for this kind (no row yet)
  version: z.number().int().min(0),
  updatedAt: z.iso.datetime().nullable(),
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

// One rule per kind of document, in APPROVAL_DOCUMENTS order
export const approvalRuleListSchema = z.object({ items: z.array(approvalRuleSchema) });
export type ApprovalRuleList = z.infer<typeof approvalRuleListSchema>;

// The amount a level starts at: "0" is a real amount (every document). Any number of decimals up to
// 4, like every amount, though a person types whole taka here.
const minAmountSchema = z
  .string()
  .trim()
  .refine((value) => value !== '', errorCode('required'))
  .refine((value) => value === '' || isMoneyAmount(value), errorCode('money_format'));

export const approvalRuleInputSchema = z
  .object({
    levels: z
      .array(
        z.object({
          minAmount: minAmountSchema,
          roleId: z.uuid(errorCode('approval_role_invalid')),
        }),
      )
      .max(MAX_APPROVAL_LEVELS),
    // The version the page was opened with (0 when it had no levels yet)
    version: z.number().int().min(0),
  })
  // The levels read from top to bottom, each from a bigger (or the same) amount than the one above:
  // a level that starts lower than the one before it would make the order mean nothing. And a role
  // once: the same people would approve the same document twice.
  .superRefine((input, ctx) => {
    const roles = new Set<string>();
    input.levels.forEach((level, index) => {
      const previous = input.levels[index - 1];
      if (
        previous !== undefined &&
        isMoneyAmount(previous.minAmount) &&
        isMoneyAmount(level.minAmount) &&
        compareMoney(level.minAmount, previous.minAmount) < 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['levels', index, 'minAmount'],
          message: errorCode('approval_level_order'),
        });
      }
      if (roles.has(level.roleId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['levels', index, 'roleId'],
          message: errorCode('approval_role_twice'),
        });
      }
      roles.add(level.roleId);
    });
  });
export type ApprovalRuleInput = z.infer<typeof approvalRuleInputSchema>;
export type ApprovalRuleFormValues = z.input<typeof approvalRuleInputSchema>;

// The levels a document of this amount needs, in order. The server copies them onto the document
// when it is submitted; the form uses the same function to say "Needs 2 approvals" before that.
export function levelsFor<L extends { minAmount: string }>(
  levels: readonly L[],
  amount: string,
): L[] {
  return levels.filter((level) => compareMoney(amount, level.minAmount) >= 0);
}

// ---------------------------------------------------------------------------------------------
// A document's approval: one round per time it was submitted

// pending: waiting for a step · approved: every step approved (or none was needed) · rejected: a
// step said no, the document went back to draft · reopened: taken back to draft by its writer while
// pending, or reopened after it was approved
export const APPROVAL_ROUND_STATUSES = ['pending', 'approved', 'rejected', 'reopened'] as const;
export type ApprovalRoundStatus = (typeof APPROVAL_ROUND_STATUSES)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

const personSchema = z.object({ id: z.uuid(), name: z.string() });

// One level as it was copied onto the round when the document was submitted. A later change in
// Settings does not touch it.
export const approvalStepSchema = z.object({
  // 1, 2, 3: the order the steps are decided in
  position: z.number().int().min(1),
  minAmount: z.string(),
  // The level's role. Its id is null once the role was deleted: the name it had stays, so the
  // history still says who it was for. (A role a waiting step needs cannot be deleted.)
  role: z.object({ id: z.uuid().nullable(), name: z.string() }),
  // null = not decided yet: the step waiting now, or one after it
  decision: z.enum(APPROVAL_DECISIONS).nullable(),
  decidedBy: personSchema.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  // Why it was rejected (always there), or a note with an approval
  comment: z.string().nullable(),
});
export type ApprovalStep = z.infer<typeof approvalStepSchema>;

export const approvalRoundSchema = z.object({
  id: z.uuid(),
  status: z.enum(APPROVAL_ROUND_STATUSES),
  // The document's amount when it was submitted: what chose the steps
  amount: z.string(),
  submittedBy: personSchema,
  submittedAt: z.iso.datetime(),
  // When it was approved, rejected or reopened; null while pending
  closedAt: z.iso.datetime().nullable(),
  // Empty when no level applied: approved at once
  steps: z.array(approvalStepSchema),
});
export type ApprovalRound = z.infer<typeof approvalRoundSchema>;

export const documentApprovalSchema = z.object({
  // Newest first: the first one is the round now (or the last one)
  rounds: z.array(approvalRoundSchema),
  // The reader may approve or reject the step that is waiting now
  canDecide: z.boolean(),
});
export type DocumentApproval = z.infer<typeof documentApprovalSchema>;

// The step a pending round waits for: the first one without a decision
export function waitingStep(round: ApprovalRound): ApprovalStep | null {
  if (round.status !== 'pending') return null;
  return round.steps.find((step) => step.decision === null) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Deciding

const documentParamsSchema = z.object({
  document: z.enum(APPROVAL_DOCUMENTS),
  id: z.uuid(),
});

// The round the page showed. If the document was reopened and submitted again since, the person
// would be approving something they never saw: the server answers approval_not_pending.
export const approveInputSchema = z.object({
  roundId: z.uuid(),
  comment: optionalText(500),
});
export type ApproveInput = z.infer<typeof approveInputSchema>;

// A rejection always says why, so the writer knows what to change
export const rejectInputSchema = z.object({
  roundId: z.uuid(),
  comment: z.string().trim().min(2, errorCode('approval_comment_required')).max(500),
});
export type RejectInput = z.infer<typeof rejectInputSchema>;
export type RejectFormValues = z.input<typeof rejectInputSchema>;

// ---------------------------------------------------------------------------------------------
// What waits for me

export const waitingApprovalSchema = z.object({
  // An ApprovalDocument kind; z.string() for the same reason as the rule's
  document: z.string(),
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // What the document is about, for the list: the warehouse of a requisition, the supplier of an
  // order (17b)
  subject: z.string(),
  amount: z.string(),
  submittedBy: personSchema,
  submittedAt: z.iso.datetime(),
  roundId: z.uuid(),
  // "Step 2 of 3"
  position: z.number().int().min(1),
  stepCount: z.number().int().min(1),
});
export type WaitingApproval = z.infer<typeof waitingApprovalSchema>;

export const waitingApprovalPageSchema = pageOf(waitingApprovalSchema);
export type WaitingApprovalPage = z.infer<typeof waitingApprovalPageSchema>;

export const waitingCountSchema = z.object({ count: z.number().int().min(0) });

// Reading the rules needs no permission, like the roles: a requisition form says which approvals
// it will need. Changing them is a workspace setting. Deciding needs no permission either: the
// level's role (or being an Owner) is the right, checked by the server.
export const approvalRuleRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/approval-rules',
    summary: 'The approval levels of every kind of document that can need one',
    auth: 'bearer',
    status: 200,
    response: approvalRuleListSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/approval-rules/:document',
    summary: 'Replace the approval levels of one kind of document',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: z.object({ document: z.enum(APPROVAL_DOCUMENTS) }),
    body: approvalRuleInputSchema,
    response: approvalRuleSchema,
  }),
};

export const approvalRoutes = {
  waiting: defineRoute({
    method: 'GET',
    path: '/approvals/waiting',
    summary: 'Documents waiting for a step the signed-in person may approve, oldest first',
    auth: 'bearer',
    status: 200,
    query: pageQuerySchema,
    response: waitingApprovalPageSchema,
  }),
  // The navigation's count, polled with the bell: a tiny call of its own
  waitingCount: defineRoute({
    method: 'GET',
    path: '/approvals/waiting/count',
    summary: 'How many documents wait for the signed-in person',
    auth: 'bearer',
    status: 200,
    response: waitingCountSchema,
  }),
  approve: defineRoute({
    method: 'POST',
    path: '/approvals/:document/:id/approve',
    summary: 'Approve the step a document waits for',
    auth: 'bearer',
    status: 204,
    params: documentParamsSchema,
    body: approveInputSchema,
    response: z.void(),
  }),
  reject: defineRoute({
    method: 'POST',
    path: '/approvals/:document/:id/reject',
    summary: 'Reject a document: it goes back to draft with the reason',
    auth: 'bearer',
    status: 204,
    params: documentParamsSchema,
    body: rejectInputSchema,
    response: z.void(),
  }),
};
```

- **`APPROVAL_DOCUMENTS` grows with each guide.** It holds only `requisition` now; 17b adds the purchase order, 17c
  the bill and the payment. A kind on the list without its document would show in Settings and do nothing.
- **`approvalRuleSchema.version` can be 0.** A workspace starts with no levels and no row. The page sends version 0
  for "nothing saved yet", and the server answers `version_conflict` if someone saved levels in the meantime.
- **`minAmountSchema` accepts `0` but not an empty box.** "Every document needs this level" is a real rule (a
  company that wants every requisition seen by the store manager). An empty box is a level nobody finished.
- **The order check skips a level whose amount is not a valid number yet.** That box already has its own
  `money_format` error, and comparing it would throw inside `compareMoney`.
- **`levelsFor` is a shared function.** The server copies its result onto the document at submit; the form shows
  "Needs 2 approvals: Purchase manager, Owner" while the person types. One function means the two never disagree. A
  generic `L extends { minAmount: string }` lets the server pass its database rows and the page pass the API's
  levels.
- **A step's role has a nullable `id`, unlike `roleRefSchema`.** When a role is deleted, the steps it decided keep
  the role's name and lose the link (decision 25), so the history must still parse. (Found while writing 17a.3: the
  first version reused `roleRefSchema` and would have failed the response check on such a history.)
- **A step is decided or not (`decision: null`).** There is no separate "skipped" state: once a round is rejected or
  reopened, the steps after it simply stay undecided, and the round's status says why.
- **`waitingStep` is the first undecided step of a pending round.** The page uses it to show "Waiting for: Purchase
  manager", and the API uses the same rule to decide whose turn it is.
- **`approveInputSchema` carries `roundId`, not the document's version** (decision 16). The document does not change
  while it waits (it is locked), so a version would not catch the one real problem: the document was reopened and
  submitted again with other lines since the page was opened.
- **`waitingApprovalSchema.subject`** is a short line for the list (the warehouse of a requisition, the supplier of
  an order), written by the server, so the list needs no extra requests per row.
- **`waitingCount` is its own tiny route.** The navigation shows the count on every page, polled with the bell; the
  full list loads only on the Approvals page.

```ts
import { describe, expect, it } from 'vitest';

import {
  type ApprovalRound,
  approvalRuleInputSchema,
  levelsFor,
  rejectInputSchema,
  waitingStep,
} from './approvals.js';

const MANAGER = '01920000-0000-7000-8000-000000000001';
const OWNER = '01920000-0000-7000-8000-000000000002';
const ROUND = '01920000-0000-7000-8000-000000000003';

describe('approval rule input', () => {
  it('takes levels from a bigger or the same amount, each role once', () => {
    const result = approvalRuleInputSchema.safeParse({
      levels: [
        { minAmount: '50000', roleId: MANAGER },
        { minAmount: '500000', roleId: OWNER },
      ],
      version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('refuses a level that starts lower than the one above it, and a role twice', () => {
    const result = approvalRuleInputSchema.safeParse({
      levels: [
        { minAmount: '500000', roleId: MANAGER },
        { minAmount: '50000', roleId: MANAGER },
      ],
      version: 3,
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['levels', 1, 'minAmount'],
        message: 'approval_level_order',
      }),
      expect.objectContaining({ path: ['levels', 1, 'roleId'], message: 'approval_role_twice' }),
    ]);
  });

  it('takes "0" as a real amount (every document) but not an empty box', () => {
    expect(
      approvalRuleInputSchema.safeParse({
        levels: [{ minAmount: '0', roleId: MANAGER }],
        version: 0,
      }).success,
    ).toBe(true);
    expect(
      approvalRuleInputSchema.safeParse({
        levels: [{ minAmount: ' ', roleId: MANAGER }],
        version: 0,
      }).error?.issues[0]?.message,
    ).toBe('required');
  });

  it('takes no levels at all: documents of this kind need no approval', () => {
    expect(approvalRuleInputSchema.parse({ levels: [], version: 2 }).levels).toEqual([]);
  });
});

describe('levelsFor', () => {
  const levels = [
    { minAmount: '0.0000', name: 'store' },
    { minAmount: '50000.0000', name: 'manager' },
    { minAmount: '500000.0000', name: 'owner' },
  ];

  it('picks every level the amount reaches, an amount equal to the start included', () => {
    expect(levelsFor(levels, '49999.9900').map((level) => level.name)).toEqual(['store']);
    expect(levelsFor(levels, '50000.0000').map((level) => level.name)).toEqual([
      'store',
      'manager',
    ]);
    expect(levelsFor(levels, '1842600.5000')).toHaveLength(3);
  });

  it('needs nothing when no level starts low enough', () => {
    expect(levelsFor(levels.slice(1), '1200.0000')).toEqual([]);
  });
});

describe('waitingStep', () => {
  const step = {
    minAmount: '0.0000',
    role: { id: MANAGER, name: 'Purchase manager' },
    decidedBy: null,
    decidedAt: null,
    comment: null,
  };
  const round: ApprovalRound = {
    id: ROUND,
    status: 'pending',
    amount: '600000.0000',
    submittedBy: { id: OWNER, name: 'Nusrat Jahan' },
    submittedAt: '2026-10-15T04:00:00.000Z',
    closedAt: null,
    steps: [
      {
        ...step,
        position: 1,
        decision: 'approved',
        decidedBy: { id: MANAGER, name: 'Rafiq' },
        decidedAt: '2026-10-15T05:00:00.000Z',
      },
      { ...step, position: 2, decision: null },
    ],
  };

  it('is the first step without a decision while the round is pending', () => {
    expect(waitingStep(round)?.position).toBe(2);
  });

  it('is nothing once the round is closed', () => {
    expect(waitingStep({ ...round, status: 'rejected' })).toBeNull();
  });
});

describe('reject input', () => {
  it('needs a reason', () => {
    expect(rejectInputSchema.safeParse({ roundId: ROUND, comment: ' ' }).error?.issues).toEqual([
      expect.objectContaining({ path: ['comment'], message: 'approval_comment_required' }),
    ]);
  });
});
```

- The tests cover the rule form (order, a role twice, `0`, no levels), `levelsFor` at the edge (an amount equal to a
  level's start needs it), `waitingStep`, and the required reason.

### `purchase.ts` (new)

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';

// What the purchase documents share (step 17): requisitions now, purchase orders, goods receipts
// and bills in 17b and 17c.

// The most lines one purchase document holds: a pharmacy's monthly requisition runs to a few
// hundred items, like a distributor's sales order (MAX_SALES_LINES)
export const MAX_PURCHASE_LINES = 300;

// ---------------------------------------------------------------------------------------------
// The cost a line starts with

// Where a line's starting cost came from. average_cost: the company-wide average per base unit
// (step 14) × the unit's factor, shown only to someone with inventory.stock.value. 17b adds the
// last purchase price, which comes first (you chose this).
export const PURCHASE_COST_SOURCES = ['average_cost'] as const;
export type PurchaseCostSource = (typeof PURCHASE_COST_SOURCES)[number];

export const costLookupInputSchema = z.object({
  items: z
    .array(z.object({ variantId: z.uuid(), unitId: z.uuid() }))
    .min(1)
    .max(MAX_PURCHASE_LINES),
});
export type CostLookupInput = z.infer<typeof costLookupInputSchema>;

export const costLookupItemSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // Per one of the unit, 4 decimals. null = nothing to start from (a new product, a person
  // without inventory.stock.value): the person types it.
  cost: z.string().nullable(),
  // z.string(), not the enum: 17b adds a source, and an older client must still parse the answer
  source: z.string().nullable(),
});
export type CostLookupItem = z.infer<typeof costLookupItemSchema>;

// An item that is not a variant and unit of this workspace is left out
export const costLookupSchema = z.object({ items: z.array(costLookupItemSchema) });
export type CostLookup = z.infer<typeof costLookupSchema>;

// Reading needs no permission, like the sales price lookup: the server leaves out what the person
// may not see. POST, because a form asks for up to 300 items at once.
export const purchaseCostRoutes = {
  lookup: defineRoute({
    method: 'POST',
    path: '/purchase/cost-lookup',
    summary: 'The cost new purchase lines start with',
    auth: 'bearer',
    status: 200,
    body: costLookupInputSchema,
    response: costLookupSchema,
  }),
};
```

- **What every purchase document shares.** 17a puts the line limit and the cost lookup here; 17b adds the line
  arithmetic of an order.
- **`PURCHASE_COST_SOURCES` has one source in 17a** (decision 20). There is no purchase yet, so there is no last
  purchase price; 17b adds `last_purchase` before it. `source` in the answer is `z.string()`, so an older client
  still reads an answer with the new source.
- **`cost` is per one of the line's unit**, 4 decimals, like a stock line's cost. A carton of 24 at an average of
  ৳12.5000 a piece starts at ৳300.0000.

### `requisitions.ts` (new)

```ts
import { z } from 'zod';

import { documentApprovalSchema } from './approvals.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { isMoneyAmount, multiplyMoney, sumMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { MAX_PURCHASE_LINES } from './purchase.js';
import { isQuantity, quantitySchema } from './quantities.js';
import { optionalDateSchema, stockUnitSchema, variantRefSchema } from './stock.js';

// A purchase requisition (step 17a): a request from inside the company to buy, before any supplier
// is asked. A store keeper in the Gazipur factory asks for 40 rolls of 220 GSM fabric; a pharmacy
// branch asks for its monthly medicines. It names the warehouse the goods are for and roughly what
// they will cost, so the right person can approve it. It moves no stock and posts nothing.
//
// It is numbered as soon as it is saved (PR-2026-27-0001), like a quotation: people refer to it
// while it waits. draft: being written, or sent back by a rejection · pending: submitted, waiting
// for approval · approved: may be ordered (17b turns it into purchase orders) · cancelled: will not
// be bought. 17b adds the ordered states.
export const REQUISITION_STATUSES = ['draft', 'pending', 'approved', 'cancelled'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// The arithmetic

// What a line is worth: quantity × estimated cost, to the paisa (multiplyMoney rounds once)
export function requisitionLineAmount(quantity: string, estimatedCost: string): string {
  return multiplyMoney(quantity, estimatedCost);
}

// The same while the line is being typed: null until both boxes hold a complete value, so the
// form's total never throws on "1." or an empty cost
export function draftRequisitionLineAmount(quantity: string, estimatedCost: string): string | null {
  const q = quantity.trim();
  const cost = estimatedCost.trim();
  return isQuantity(q) && isMoneyAmount(cost) ? requisitionLineAmount(q, cost) : null;
}

// The requisition's amount: the sum of its lines, each already rounded. The approval levels are
// chosen by this number.
export function requisitionAmount(
  lines: readonly { quantity: string; estimatedCost: string }[],
): string {
  return sumMoney(lines.map((line) => requisitionLineAmount(line.quantity, line.estimatedCost)));
}

// ---------------------------------------------------------------------------------------------
// What the API sends

const personSchema = z.object({ id: z.uuid(), name: z.string() });

export const requisitionSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // When the goods are needed; null = no date given
  neededBy: z.iso.date().nullable(),
  // Where the goods are for. Its branch is the requisition's branch.
  warehouseId: z.uuid(),
  status: z.enum(REQUISITION_STATUSES),
  // The sum of the lines' estimated amounts
  amount: z.string(),
  lineCount: z.number().int(),
  // Who wrote it
  requestedBy: personSchema,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type RequisitionSummary = z.infer<typeof requisitionSummarySchema>;

export const requisitionLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  // 'goods' or 'service': a repair or a service contract can be requested too
  productType: z.string(),
  units: z.array(stockUnitSchema),
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  // What the person typed, or the product's name with its variant's options
  description: z.string(),
  // Per one of the unit, 4 decimals
  estimatedCost: z.string(),
  // requisitionLineAmount() when it was saved
  amount: z.string(),
});
export type RequisitionLine = z.infer<typeof requisitionLineSchema>;

export const requisitionSchema = requisitionSummarySchema.extend({
  note: z.string().nullable(),
  lines: z.array(requisitionLineSchema),
  // Every time it was submitted, newest first; no rounds while it was never submitted
  approval: documentApprovalSchema,
});
export type Requisition = z.infer<typeof requisitionSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// The cost a person expects to pay, per one of the line's unit. The form fills it in from the
// cost lookup (purchase.ts); an empty box is a cost nobody typed. ৳0 is a cost (a free sample).
const estimatedCostSchema = z
  .string()
  .trim()
  .refine((value) => value !== '', errorCode('requisition_cost_required'))
  .refine((value) => value === '' || isMoneyAmount(value), errorCode('money_format'));

export const requisitionLineInputSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  // The base unit or one of the product's packs; the quantity and the cost are per this unit
  unitId: z.uuid(errorCode('stock_unit_invalid')),
  quantity: quantitySchema,
  // null = the product's name with its variant's options
  description: optionalText(300),
  estimatedCost: estimatedCostSchema,
});
export type RequisitionLineInput = z.infer<typeof requisitionLineInputSchema>;
export type RequisitionLineFormValues = z.input<typeof requisitionLineInputSchema>;

const requisitionFieldsSchema = z.object({
  date: z.iso.date(errorCode('purchase_date_required')),
  warehouseId: z.uuid(errorCode('purchase_warehouse_required')),
  neededBy: optionalDateSchema,
  note: optionalText(500),
  lines: z
    .array(requisitionLineInputSchema)
    .min(1, errorCode('purchase_lines_required'))
    .max(MAX_PURCHASE_LINES),
});

type RequisitionRuleInput = z.output<typeof requisitionFieldsSchema>;

// Goods cannot be needed before they were asked for. ISO dates compare as strings.
function requisitionRules(input: RequisitionRuleInput, ctx: z.RefinementCtx<RequisitionRuleInput>) {
  if (input.neededBy !== null && input.neededBy < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['neededBy'],
      message: errorCode('requisition_needed_by'),
    });
  }
}

export const requisitionInputSchema = requisitionFieldsSchema.superRefine(requisitionRules);
export type RequisitionInput = z.infer<typeof requisitionInputSchema>;

export const updateRequisitionInputSchema = requisitionFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(requisitionRules);
export type UpdateRequisitionInput = z.infer<typeof updateRequisitionInputSchema>;
export type RequisitionFormValues = z.input<typeof updateRequisitionInputSchema>;

export const requisitionVersionInputSchema = z.object({ version: versionSchema });

export const deleteRequisitionQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const requisitionListQuerySchema = pageQuerySchema.extend({
  status: z.enum(REQUISITION_STATUSES).optional(),
  warehouseId: z.uuid().optional(),
});
export type RequisitionListQuery = z.input<typeof requisitionListQuerySchema>;

export const requisitionPageSchema = pageOf(requisitionSummarySchema);
export type RequisitionPage = z.infer<typeof requisitionPageSchema>;

const requisitionParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every other document. Writing, submitting, reopening and
// cancelling need purchase.requisition.manage; approving needs the level's role (approvals.ts).
export const requisitionRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/requisitions',
    summary: 'Purchase requisitions, newest date first',
    auth: 'bearer',
    status: 200,
    query: requisitionListQuerySchema,
    response: requisitionPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/requisitions/:id',
    summary: 'One requisition with its lines and its approval history',
    auth: 'bearer',
    status: 200,
    params: requisitionParamsSchema,
    response: requisitionSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/requisitions',
    summary: 'Write a requisition; it gets its number at once and stays a draft',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 201,
    body: requisitionInputSchema,
    response: requisitionSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/requisitions/:id',
    summary: 'Change a draft requisition',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: updateRequisitionInputSchema,
    response: requisitionSchema,
  }),
  // A draft that was ever submitted keeps its approval history: it is cancelled, not deleted
  remove: defineRoute({
    method: 'DELETE',
    path: '/requisitions/:id',
    summary: 'Delete a draft requisition that was never submitted',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 204,
    params: requisitionParamsSchema,
    query: deleteRequisitionQuerySchema,
    response: z.void(),
  }),
  // The levels its amount reaches are copied onto a new round; with none it is approved at once
  submit: defineRoute({
    method: 'POST',
    path: '/requisitions/:id/submit',
    summary: 'Send a draft requisition for approval',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: requisitionVersionInputSchema,
    response: requisitionSchema,
  }),
  // Pending: taken back to change it. Approved: changed after all, and approved again from step 1.
  reopen: defineRoute({
    method: 'POST',
    path: '/requisitions/:id/reopen',
    summary: 'Take a pending or approved requisition back to draft',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: requisitionVersionInputSchema,
    response: requisitionSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/requisitions/:id/cancel',
    summary: 'Cancel a draft or approved requisition: it will not be bought',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: requisitionVersionInputSchema,
    response: requisitionSchema,
  }),
};
```

- **The amount is worked out here** (`requisitionLineAmount`, `requisitionAmount`). The form shows the same total the
  server stores and the approval levels are chosen by. Each line is rounded to the paisa first, then added, like a
  sales document: the lines are what people read.
- **`draftRequisitionLineAmount` returns null for a half-typed line.** `multiplyMoney` throws on "1." or an empty box;
  the form's running total must not.
- **`number` is never null** (decision 19): it is given at the first save.
- **`warehouseId`, not a branch.** Every warehouse belongs to a branch (step 13), so the warehouse says both where the
  goods go and whose request it is. A separate branch field could disagree with it.
- **`estimatedCostSchema` has its own error code.** Reusing `sales_price_required` would show "Type a price" on a
  box called "Estimated cost".
- **`approval` is part of the requisition.** The page shows the rounds under the lines and the Approve and Reject
  buttons when `canDecide` is true, from one request.
- **`REQUISITION_STATUSES` grows in 17b** (ordered, partly ordered). The list filter takes only the statuses that
  exist now.

```ts
import { describe, expect, it } from 'vitest';

import {
  draftRequisitionLineAmount,
  requisitionAmount,
  requisitionInputSchema,
  type RequisitionFormValues,
} from './requisitions.js';

const WAREHOUSE = '01920000-0000-7000-8000-000000000001';
const VARIANT = '01920000-0000-7000-8000-000000000002';
const UNIT = '01920000-0000-7000-8000-000000000003';

function requisition(extra: Partial<Omit<RequisitionFormValues, 'version'>> = {}) {
  return {
    date: '2026-10-15',
    warehouseId: WAREHOUSE,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: VARIANT,
        unitId: UNIT,
        quantity: '40',
        description: '',
        estimatedCost: '4250.50',
      },
    ],
    ...extra,
  };
}

describe('requisition input', () => {
  it('reads empty boxes as "not set": no date needed by, no description', () => {
    expect(requisitionInputSchema.parse(requisition())).toMatchObject({
      neededBy: null,
      note: null,
      lines: [expect.objectContaining({ description: null, estimatedCost: '4250.50' })],
    });
  });

  it('refuses a "needed by" date before the requisition, on that box', () => {
    expect(
      requisitionInputSchema.safeParse(requisition({ neededBy: '2026-10-14' })).error?.issues,
    ).toEqual([expect.objectContaining({ path: ['neededBy'], message: 'requisition_needed_by' })]);
  });

  it('needs a cost on every line, one error per box', () => {
    const line = requisition().lines[0];
    if (line === undefined) throw new Error('no line');
    expect(
      requisitionInputSchema.safeParse(requisition({ lines: [{ ...line, estimatedCost: '' }] }))
        .error?.issues,
    ).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'estimatedCost'],
        message: 'requisition_cost_required',
      }),
    ]);
  });

  it('needs a warehouse and at least one line', () => {
    const issues = requisitionInputSchema.safeParse(requisition({ warehouseId: '', lines: [] }))
      .error?.issues;
    expect(issues?.map((issue) => issue.message)).toEqual([
      'purchase_warehouse_required',
      'purchase_lines_required',
    ]);
  });
});

describe('requisition amount', () => {
  it('rounds each line to the paisa, then adds them', () => {
    // 3 × 0.8512 = 2.5536 → 2.55; 7 × 1.005 = 7.035 → 7.04
    expect(
      requisitionAmount([
        { quantity: '3', estimatedCost: '0.8512' },
        { quantity: '7', estimatedCost: '1.005' },
      ]),
    ).toBe('9.5900');
  });

  it('waits for complete boxes while the line is typed', () => {
    expect(draftRequisitionLineAmount('40', '')).toBeNull();
    expect(draftRequisitionLineAmount('1.', '100')).toBeNull();
    expect(draftRequisitionLineAmount(' 40 ', '4250.50')).toBe('170020.0000');
  });
});
```

- The rounding test uses a tablet's cost (`0.8512`) and a half paisa (`7 × 1.005 = 7.035`), where adding first and
  rounding once would give a different total.

### `errors.ts`, `audit.ts`, `notifications.ts`

```diff
@@ -335,6 +335,39 @@ export const ERROR_CODES = [
   'email_subject_required',
   // The public page behind a share link: an unknown, expired or turned-off link all look the same
   'share_link_not_found',
+  // Step 17a: suppliers, approvals and purchase requisitions
+  'supplier_code_format',
+  'supplier_code_taken',
+  'supplier_name_required',
+  'supplier_group_invalid',
+  'supplier_in_use',
+  'supplier_group_name_required',
+  'supplier_group_name_taken',
+  'supplier_group_in_use',
+  'supplier_bank_name_required',
+  'supplier_account_name_required',
+  'bank_account_number_format',
+  'routing_number_format',
+  // "Make supplier too" on a party that already is one (or "Make customer too" on a customer)
+  'party_role_exists',
+  'approval_level_order',
+  'approval_role_twice',
+  'approval_role_invalid',
+  'approval_not_pending',
+  'approval_not_allowed',
+  'approval_own_document',
+  'approval_comment_required',
+  'purchase_warehouse_required',
+  'purchase_warehouse_invalid',
+  'purchase_date_required',
+  'purchase_lines_required',
+  'purchase_item_invalid',
+  'purchase_not_draft',
+  'purchase_was_submitted',
+  'purchase_cannot_reopen',
+  'purchase_cannot_cancel',
+  'requisition_needed_by',
+  'requisition_cost_required',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- The supplier codes mirror the customer ones. `party_role_exists` answers "Make supplier too" on a party that is
  already a supplier (two clicks, two tabs). `purchase_was_submitted` refuses to delete a requisition that has an
  approval history (decision 19). The `purchase_*` codes are worded for any purchase document, so 17b–17d reuse them.

```diff
@@ -140,6 +140,28 @@ export const AUDIT_ACTIONS = [
   'refund.voided',
   // The sales returns account in Settings → Sales. The entity is the workspace, like settings.
   'sales_accounts.changed',
+  // step 17a
+  'supplier.created',
+  'supplier.updated',
+  'supplier.archived',
+  'supplier.restored',
+  'supplier.deleted',
+  'supplier_group.created',
+  'supplier_group.updated',
+  'supplier_group.deleted',
+  // The approval levels of one kind of document, in Settings → Approvals. The entity is the
+  // workspace, like settings.
+  'approval_rules.changed',
+  'requisition.created',
+  'requisition.updated',
+  'requisition.deleted',
+  'requisition.cancelled',
+  // The approval steps of any document that needs one. The entity is that document (a requisition
+  // now; an order, a bill and a payment from 17b and 17c), so its history reads in one place.
+  'approval.submitted',
+  'approval.approved',
+  'approval.rejected',
+  'approval.reopened',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -181,6 +203,9 @@ export const AUDIT_ENTITY_TYPES = [
   'sales_return',
   'credit_note',
   'refund',
+  'supplier',
+  'supplier_group',
+  'requisition',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- **`approval.*` actions use the document as their entity.** The audit log of a requisition then reads in one place:
  created, submitted, approved by Rafiq, rejected by the Owner ("price too high"), reopened, submitted again.
- **`approval_rules.changed` has the workspace as its entity,** like every setting.

```diff
@@ -11,6 +11,10 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // stock.low: params { warehouse, count } — count = variants that fell to their reorder level
 // document.email_failed: params { document, id, number } — document = an OutputDocument kind, id =
 // the document's id (the bell opens its page)
+// approval.requested: params { document, id, number } — sent to everyone who may approve the step
+// that is now waiting (document = an ApprovalDocument kind)
+// approval.approved / approval.rejected: params { document, id, number } — sent to the person who
+// submitted the document, when the last step approves it or any step rejects it
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -21,6 +25,9 @@ export const NOTIFICATION_TYPES = [
   'import.failed',
   'stock.low',
   'document.email_failed',
+  'approval.requested',
+  'approval.approved',
+  'approval.rejected',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

- Three bell types (decision 18). Like `document.email_failed`, each carries the document's kind and id, so a click
  opens its page.

### `routes.ts` and `index.ts`

```diff
@@ -1,6 +1,7 @@
 import { z } from 'zod';
 
 import { accountRoutes } from './accounts.js';
+import { approvalRoutes, approvalRuleRoutes } from './approvals.js';
 import { attachmentRoutes } from './attachments.js';
 import { auditRoutes } from './audit.js';
 import { authRoutes } from './auth.js';
@@ -23,9 +24,11 @@ import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
 import { productRoutes } from './products.js';
+import { purchaseCostRoutes } from './purchase.js';
 import { quotationRoutes } from './quotations.js';
 import { receiptRoutes } from './receipts.js';
 import { refundRoutes } from './refunds.js';
+import { requisitionRoutes } from './requisitions.js';
 import { roleRoutes } from './roles.js';
 import { salesAccountRoutes } from './sales-accounts.js';
 import { salesOrderRoutes } from './sales-orders.js';
@@ -38,6 +41,7 @@ import { stockAdjustmentRoutes } from './stock-adjustments.js';
 import { stockRevaluationRoutes } from './stock-revaluations.js';
 import { stockTransferRoutes } from './stock-transfers.js';
 import { stockRoutes } from './stock.js';
+import { supplierGroupRoutes, supplierRoutes } from './suppliers.js';
 import { taxRateRoutes } from './tax-rates.js';
 import { unitRoutes } from './units.js';
 import { warehouseRoutes } from './warehouses.js';
@@ -104,4 +108,10 @@ export const routes = {
   salesAccounts: salesAccountRoutes,
   documentOutput: documentOutputRoutes,
   publicDocuments: publicDocumentRoutes,
+  suppliers: supplierRoutes,
+  supplierGroups: supplierGroupRoutes,
+  approvalRules: approvalRuleRoutes,
+  approvals: approvalRoutes,
+  purchaseCosts: purchaseCostRoutes,
+  requisitions: requisitionRoutes,
 };
```

```diff
@@ -1,5 +1,6 @@
 export * from './accounts.js';
 export * from './amount-words.js';
+export * from './approvals.js';
 export * from './attachments.js';
 export * from './audit.js';
 export * from './auth.js';
@@ -26,11 +27,13 @@ export * from './price-lists.js';
 export * from './product-categories.js';
 export * from './product-imports.js';
 export * from './products.js';
+export * from './purchase.js';
 export * from './quantities.js';
 export * from './quotations.js';
 export * from './receipts.js';
 export * from './refunds.js';
 export * from './reports.js';
+export * from './requisitions.js';
 export * from './roles.js';
 export * from './routes.js';
 export * from './sales.js';
@@ -44,6 +47,7 @@ export * from './stock-accounts.js';
 export * from './stock-adjustments.js';
 export * from './stock-revaluations.js';
 export * from './stock-transfers.js';
+export * from './suppliers.js';
 export * from './tax-rates.js';
 export * from './units.js';
 export * from './warehouses.js';
```

- Six route groups. The API's route test (`contract.spec.ts`) fails until 17a.3 adds their controllers, which is
  the point of that test.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
```

Both pass (contracts 197 tests, 21 new). Do not run the whole `pnpm typecheck` yet: the translations do not know the
new error codes, permissions and bell types until 17a.5, and the API's route test fails until 17a.3.

---

## 17a.2 — `packages/db`: suppliers, approvals and requisitions

Eight new tables. Two belong to suppliers: `supplier_groups` and `party_bank_accounts`. Four belong to approvals:
`approval_rules` and `approval_levels` say what a kind of document needs (set in Settings), and `approval_rounds`
and `approval_steps` record what happened to one document. Two belong to requisitions: `requisitions` and
`requisition_lines`. The `parties` table gets the supplier's own columns. Migration 0035 is generated from the
schema; 0036 is written by hand: row-level security, one foreign key Drizzle cannot write, the posting check for the
payable, and the guards that decide what may change.

### `schema/parties.ts`: the supplier's side

```diff
@@ -35,9 +35,28 @@ export const customerGroups = pgTable(
   ],
 );
 
-// Everyone the company trades with on credit (step 15a): customers now, suppliers from step 17.
-// One row per business, so a distributor that is both has one code and one statement. The
-// customer's columns (group, terms, limit, price list) mean nothing for a supplier-only party.
+// Step 17a: the same for suppliers (Fabric mills, Accessories, Packaging). A table of its own and
+// not a kind column on customer_groups: the two lists are managed on different pages, by people
+// with different permissions, and a group of one side must never be offered on the other.
+export const supplierGroups = pgTable(
+  'supplier_groups',
+  {
+    ...baseColumns(),
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    name: text('name').notNull(),
+  },
+  (table) => [
+    uniqueIndex('supplier_groups_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
+    uniqueIndex('supplier_groups_tenant_id_idx').on(table.tenantId, table.id),
+  ],
+);
+
+// Everyone the company trades with on credit (step 15a): customers, and suppliers from step 17a.
+// One row per business, so a distributor that is both has one code and one statement. The name,
+// contact, phone, email, BIN, language and addresses are the party's; the group, the terms (and a
+// customer's limit and price list) belong to one side, and stay empty while the party is not on it.
 // deleted_at is not used: a party is deleted for real (only while nothing uses it) or archived.
 export const parties = pgTable(
   'parties',
@@ -46,7 +65,8 @@ export const parties = pgTable(
     tenantId: uuid('tenant_id')
       .notNull()
       .references(() => tenants.id),
-    // C-00042 from the 'sales.customer' series, or the company's own
+    // C-00042 from the 'sales.customer' series, S-00042 from 'purchase.supplier', or the
+    // company's own. A party that becomes both keeps the code it was made with.
     code: text('code').notNull(),
     name: text('name').notNull(),
     isCustomer: boolean('is_customer').notNull().default(false),
@@ -57,7 +77,7 @@ export const parties = pgTable(
     email: text('email'),
     // 13 digits, cleaned by the contract's binSchema
     bin: text('bin'),
-    // Days from an invoice to its due date (step 15c)
+    // Days from an invoice to its due date (step 15c). The customer's terms.
     paymentTermsDays: smallint('payment_terms_days').notNull().default(0),
     // NULL = no limit; 0 = cash only. NUMERIC(19,4) like every amount.
     creditLimit: numeric('credit_limit', { precision: 19, scale: 4 }),
@@ -66,6 +86,10 @@ export const parties = pgTable(
     // Step 16: the language of the PDFs, emails and links this party gets. The default fills the
     // parties that already exist.
     documentLanguage: text('document_language', { enum: LANGUAGE_CODES }).notNull().default('en'),
+    // Step 17a: the supplier's side. Its terms are what the supplier gives the company, often not
+    // what the company gives the same party as a customer, so they are a column of their own.
+    supplierGroupId: uuid('supplier_group_id'),
+    supplierPaymentTermsDays: smallint('supplier_payment_terms_days').notNull().default(0),
     notes: text('notes'),
     archivedAt: timestamp('archived_at', { withTimezone: true }),
   },
@@ -82,8 +106,16 @@ export const parties = pgTable(
     index('parties_customer_updated_idx')
       .on(table.tenantId, table.updatedAt, table.id)
       .where(sql`${table.isCustomer}`),
+    // The same two orders for the supplier list (step 17a)
+    index('parties_supplier_name_idx')
+      .on(table.tenantId, sql`lower(${table.name})`, table.id)
+      .where(sql`${table.isSupplier}`),
+    index('parties_supplier_updated_idx')
+      .on(table.tenantId, table.updatedAt, table.id)
+      .where(sql`${table.isSupplier}`),
     // A group's customers (the filter, customerCount), and the FK's check when a group is deleted
     index('parties_tenant_group_idx').on(table.tenantId, table.customerGroupId),
+    index('parties_tenant_supplier_group_idx').on(table.tenantId, table.supplierGroupId),
     index('parties_tenant_price_list_idx').on(table.tenantId, table.priceListId),
     // No ON DELETE: a group that still holds a customer cannot be deleted (customer_group_in_use)
     foreignKey({
@@ -91,6 +123,12 @@ export const parties = pgTable(
       columns: [table.tenantId, table.customerGroupId],
       foreignColumns: [customerGroups.tenantId, customerGroups.id],
     }),
+    // The same for supplier groups: supplier_group_in_use
+    foreignKey({
+      name: 'parties_supplier_group_fk',
+      columns: [table.tenantId, table.supplierGroupId],
+      foreignColumns: [supplierGroups.tenantId, supplierGroups.id],
+    }),
     foreignKey({
       name: 'parties_price_list_fk',
       columns: [table.tenantId, table.priceListId],
@@ -98,7 +136,21 @@ export const parties = pgTable(
     }),
     check('parties_role_check', sql`${table.isCustomer} OR ${table.isSupplier}`),
     // 365 = the contract's MAX_PAYMENT_TERMS_DAYS
-    check('parties_terms_check', sql`${table.paymentTermsDays} BETWEEN 0 AND 365`),
+    check(
+      'parties_terms_check',
+      sql`${table.paymentTermsDays} BETWEEN 0 AND 365 AND ${table.supplierPaymentTermsDays} BETWEEN 0 AND 365`,
+    ),
+    // A side the party is not on keeps its defaults. Removing the customer side of a party that is
+    // both (step 17a) must clear it, so "Make customer too" later starts fresh (decision 10), and
+    // a customer group never counts, nor blocks, a party that is no longer a customer.
+    check(
+      'parties_customer_side_check',
+      sql`${table.isCustomer} OR (${table.customerGroupId} IS NULL AND ${table.paymentTermsDays} = 0 AND ${table.creditLimit} IS NULL AND ${table.priceListId} IS NULL)`,
+    ),
+    check(
+      'parties_supplier_side_check',
+      sql`${table.isSupplier} OR (${table.supplierGroupId} IS NULL AND ${table.supplierPaymentTermsDays} = 0)`,
+    ),
     check(
       'parties_credit_limit_check',
       sql`${table.creditLimit} IS NULL OR ${table.creditLimit} >= 0`,
@@ -139,3 +191,42 @@ export const partyAddresses = pgTable(
     }).onDelete('cascade'),
   ],
 );
+
+// Step 17a: the bank accounts a supplier is paid into (decision 8). The payment screen (17c) shows
+// them, so a cashier copies the number from the system and not from an old invoice. Rows of their
+// own, like the addresses: 17c's payment may point at the one it was sent to.
+// Bangladesh needs no IBAN or SWIFT here: a local transfer (BEFTN, RTGS) takes the account number
+// and the branch's 9-digit routing number.
+export const partyBankAccounts = pgTable(
+  'party_bank_accounts',
+  {
+    id: baseColumns().id,
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    partyId: uuid('party_id').notNull(),
+    // The order the form shows them in, from 0; the first is the one a payment suggests
+    position: smallint('position').notNull(),
+    bankName: text('bank_name').notNull(),
+    branchName: text('branch_name'),
+    // As the bank has it, which is often not the trading name
+    accountName: text('account_name').notNull(),
+    // Digits only, as the contract cleaned them (spaces and dashes removed)
+    accountNumber: text('account_number').notNull(),
+    routingNumber: text('routing_number'),
+  },
+  (table) => [
+    // A party's accounts, and the target of a later FK: an account of THIS supplier
+    uniqueIndex('party_bank_accounts_party_id_idx').on(table.tenantId, table.partyId, table.id),
+    foreignKey({
+      name: 'party_bank_accounts_party_fk',
+      columns: [table.tenantId, table.partyId],
+      foreignColumns: [parties.tenantId, parties.id],
+    }).onDelete('cascade'),
+    // The contract's formats again, so a row written by other code is still a usable account
+    check(
+      'party_bank_accounts_number_check',
+      sql`${table.accountNumber} ~ '^[0-9]{6,20}$' AND (${table.routingNumber} IS NULL OR ${table.routingNumber} ~ '^[0-9]{9}$')`,
+    ),
+  ],
+);
```

- **`supplier_groups` is a copy of `customer_groups`, not a shared table with a "kind" column.** The two lists live
  on different pages and need different permissions. With one table, every query would need `WHERE kind = …`, and
  forgetting it once would show a supplier group in the customer form. Two small tables cannot be mixed up.
- **`supplier_payment_terms_days` is a new column, not `payment_terms_days` again.** The customer's terms are what
  the company gives the party; the supplier's terms are what the party gives the company. For a distributor that
  is both, they are usually different (30 days to pay them, 7 days for them to pay us).
- **The name, phone, email, BIN, language and addresses stay shared** (decision 9). That is why there is no
  `supplier_name` or `supplier_phone`: a business has one phone number, whichever page you open.
- **The two partial indexes copy the customer ones** with `WHERE is_supplier`. The supplier list orders by name or
  by last change, like the customer list, and must not scan every customer to find the suppliers.
- **`parties_supplier_group_fk` has no `ON DELETE`,** like the customer group's: deleting a group that still holds
  a supplier fails, and the API turns that into `supplier_group_in_use`.
- **`parties_terms_check` now covers both terms.** Drizzle drops and adds the check again in 0035, which is fine:
  every existing row has supplier terms 0.
- **`parties_customer_side_check` and `parties_supplier_side_check`** (decision 22). A side the party is not on must
  keep its defaults. Without these, removing the customer side of a party that is both would leave a customer
  group on a supplier-only party: the group would count it, and refuse to be deleted because of it, while nobody
  can see why. They also make "Make customer too" start from a clean customer. Every existing party passes: before
  this step every party is a customer, and the new supplier columns start empty.
- **`party_bank_accounts` copies `party_addresses`.** `position` is the order on the form, from 0, with no unique
  index: the form saves a reordered list row by row, and a unique `(party, position)` would fail in the middle of
  that. The unique index on `(tenant_id, party_id, id)` is the target for a later foreign key that must point at an
  account of *this* supplier (17c), the same trick as the shipping address in 15b. `ON DELETE CASCADE`: a party is
  only deleted when nothing uses it, and then its bank accounts mean nothing.
- **`party_bank_accounts_number_check` repeats the contract's formats.** The contract cleans "1051-100-012345" into
  digits before saving. The check makes sure a row written by other code (a later import, a script) is still a
  number a bank accepts. A 9-digit routing number is what a BEFTN or RTGS transfer in Bangladesh needs; no IBAN or
  SWIFT code is needed for a local supplier.
- **"At most five accounts" is not in the database.** A count needs a trigger, and a trigger alone would not stop
  two saves at once. The API locks the party row (`FOR UPDATE`, with the version check) before it writes the
  accounts, so two saves of the same supplier run one after the other, and the contract's `max(5)` is enough.

### `schema/approvals.ts` (new)

```ts
import { APPROVAL_DECISIONS, APPROVAL_DOCUMENTS, APPROVAL_ROUND_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
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
import { roles } from './roles.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// Step 17a: approvals. Two tables say what a kind of document needs (the rule and its levels, set
// in Settings), and two record what happened to one document (its rounds and their steps). The
// rules on what may change when live in migration 0036.

// ---------------------------------------------------------------------------------------------
// The rule of a kind of document

// One row per kind of document that was ever set up. No row = no levels = no approval (the
// contract's version 0). Saving the levels changes the row's version, so two people editing the
// levels at once cannot overwrite each other.
export const approvalRules = pgTable(
  'approval_rules',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    document: text('document', { enum: APPROVAL_DOCUMENTS }).notNull(),
  },
  (table) => [
    uniqueIndex('approval_rules_tenant_document_idx').on(table.tenantId, table.document),
    uniqueIndex('approval_rules_tenant_id_idx').on(table.tenantId, table.id),
  ],
);

// "From ৳50,000: Purchase manager". A save replaces all of a rule's levels.
export const approvalLevels = pgTable(
  'approval_levels',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ruleId: uuid('rule_id').notNull(),
    // 1 = decided first
    position: smallint('position').notNull(),
    // The level applies to a document of this amount or more; 0 = every document
    minAmount: numeric('min_amount', { precision: 19, scale: 4 }).notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (table) => [
    uniqueIndex('approval_levels_position_idx').on(table.tenantId, table.ruleId, table.position),
    // The contract's approval_role_twice again: one role decides once per document
    uniqueIndex('approval_levels_role_idx').on(table.tenantId, table.ruleId, table.roleId),
    // The role FK's check when a role is deleted
    index('approval_levels_tenant_role_idx').on(table.tenantId, table.roleId),
    foreignKey({
      name: 'approval_levels_rule_fk',
      columns: [table.tenantId, table.ruleId],
      foreignColumns: [approvalRules.tenantId, approvalRules.id],
    }).onDelete('cascade'),
    // No ON DELETE: a role a level names cannot be deleted (role_in_use)
    foreignKey({
      name: 'approval_levels_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    // 5 = the contract's MAX_APPROVAL_LEVELS; with the unique position, a rule never has more
    check('approval_levels_position_check', sql`${table.position} BETWEEN 1 AND 5`),
    check('approval_levels_amount_check', sql`${table.minAmount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// What happened to one document

// One row each time a document is submitted (decision 15). document_id has no foreign key: it
// points into a different table for each kind (requisitions now, purchase orders in 17b). A
// document that was ever submitted is never deleted (its own guard), so the id never dangles.
export const approvalRounds = pgTable(
  'approval_rounds',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    document: text('document', { enum: APPROVAL_DOCUMENTS }).notNull(),
    documentId: uuid('document_id').notNull(),
    status: text('status', { enum: APPROVAL_ROUND_STATUSES }).notNull().default('pending'),
    // The document's amount when it was submitted: the amount its levels were chosen by
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    // When it ended: approved, rejected or reopened
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('approval_rounds_tenant_id_idx').on(table.tenantId, table.id),
    // At most one round waits per document, whatever two people do at once
    uniqueIndex('approval_rounds_pending_idx')
      .on(table.tenantId, table.document, table.documentId)
      .where(sql`${table.status} = 'pending'`),
    // A document's history, newest first
    index('approval_rounds_document_idx').on(
      table.tenantId,
      table.document,
      table.documentId,
      table.submittedAt,
    ),
    // "Waiting for me" for an Owner, who may decide every waiting step: oldest first
    index('approval_rounds_waiting_idx')
      .on(table.tenantId, table.submittedAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    check('approval_rounds_amount_check', sql`${table.amount} >= 0`),
    check(
      'approval_rounds_closed_check',
      sql`(${table.status} = 'pending') = (${table.closedAt} IS NULL)`,
    ),
  ],
);

// The levels the round's amount reached, copied when it was submitted (decision 13): a change in
// Settings never moves a document that is already waiting.
export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roundId: uuid('round_id').notNull(),
    position: smallint('position').notNull(),
    minAmount: numeric('min_amount', { precision: 19, scale: 4 }).notNull(),
    // NULL once the role is deleted (the FK's ON DELETE SET NULL is in migration 0036); the name
    // below still says who it was for
    roleId: uuid('role_id'),
    roleName: text('role_name').notNull(),
    decision: text('decision', { enum: APPROVAL_DECISIONS }),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // Why it was rejected (required), or a note with an approval
    comment: text('comment'),
  },
  (table) => [
    uniqueIndex('approval_steps_position_idx').on(table.tenantId, table.roundId, table.position),
    // "Waiting for me": the undecided steps of the roles a person has. Also the role FK's check.
    index('approval_steps_open_role_idx')
      .on(table.tenantId, table.roleId, table.roundId)
      .where(sql`${table.decision} IS NULL`),
    index('approval_steps_tenant_role_idx').on(table.tenantId, table.roleId),
    foreignKey({
      name: 'approval_steps_round_fk',
      columns: [table.tenantId, table.roundId],
      foreignColumns: [approvalRounds.tenantId, approvalRounds.id],
    }),
    check('approval_steps_position_check', sql`${table.position} BETWEEN 1 AND 5`),
    check('approval_steps_amount_check', sql`${table.minAmount} >= 0`),
    // Decided means decided by someone, at a time; undecided means none of the three
    check(
      'approval_steps_decided_check',
      sql`(${table.decision} IS NULL AND ${table.decidedBy} IS NULL AND ${table.decidedAt} IS NULL) OR (${table.decision} IS NOT NULL AND ${table.decidedBy} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`,
    ),
    // A rejection says why (decision 15); 500 = the contract's limit
    check(
      'approval_steps_comment_check',
      sql`(${table.decision} IS DISTINCT FROM 'rejected' OR ${table.comment} IS NOT NULL) AND (${table.comment} IS NULL OR (${table.decision} IS NOT NULL AND char_length(${table.comment}) BETWEEN 1 AND 500))`,
    ),
  ],
);
```

- **`approval_rules` has one row per kind of document,** made the first time someone saves levels for it. No row
  means no levels, which is the contract's `version: 0`. The row's `version` is what stops two people from saving
  the levels at the same time and losing one change. When the levels are cleared, the row stays (with no levels),
  so its version keeps counting.
- **A save replaces all of a rule's levels** (delete, then insert). This is why `approval_levels` has no `version`
  of its own, and why its unique indexes cause no trouble: there is never a moment with two rows at position 2.
- **`approval_levels_role_idx`** is the contract's `approval_role_twice` again. One role deciding twice on the same
  document is never meaningful: the same person would approve both levels.
- **`approval_levels_position_check` (1 to 5) together with the unique position caps a rule at five levels,**
  `MAX_APPROVAL_LEVELS`, without a trigger. The "amounts go up" rule spans rows, so it stays in the contract and the
  API.
- **`approval_levels_role_fk` has no `ON DELETE`:** a role a level names cannot be deleted. The roles service
  (17a.3) turns this into the existing `role_in_use`, so the Owner first changes the level and then deletes the
  role. The other choice, quietly dropping the level, would remove an approval nobody decided to remove.
- **`approval_rounds.document_id` has no foreign key.** It points into `requisitions` now and into
  `purchase_orders` in 17b, and one column cannot have a foreign key to two tables. Migration 0036 checks that the
  document exists when the round is made, and a document that was ever submitted can never be deleted, so the id
  never points at nothing.
- **`amount` is copied onto the round.** It is the amount the levels were chosen by. If the document is reopened
  and changed, the old round still says what was approved.
- **`approval_rounds_pending_idx`: one waiting round per document.** Two people clicking "Submit" at the same moment
  both insert a round; the second one waits for the first and then fails on this index. The API turns that into a
  version conflict.
- **`approval_rounds_waiting_idx`** serves the Owner's "waiting for me" list: an Owner may decide every waiting step,
  so the list is simply every pending round, oldest first.
- **`approval_rounds_closed_check`:** a closed round has a closing time and a pending one has none. The API cannot
  forget to set it.
- **`approval_steps` copies the levels when a document is submitted** (decision 13): `position`, `min_amount`, the
  role and its name. A change in Settings later never moves a document that is already waiting.
- **`role_id` may be NULL and `role_name` is a copy.** When a role is deleted, its old steps lose the link (0036's
  foreign key sets it to NULL) and keep the name, so the history still reads "Purchase manager approved". The roles
  service refuses to delete a role while a waiting step needs it (17a.3), so the NULL only appears on closed steps.
- **`approval_steps_open_role_idx`** is the "waiting for me" lookup for everyone else: the undecided steps of the
  roles the person has. It is partial (`decision IS NULL`), so it stays small while the history grows.
  `approval_steps_tenant_role_idx` covers every row, for the foreign key's work when a role is deleted.
- **`approval_steps_decided_check`:** decided means decided by someone, at a time. The three columns are set
  together or not at all, so a half-written decision cannot exist.
- **`approval_steps_comment_check`:** a rejection must say why (decision 15), a comment belongs only to a decision,
  and it is at most 500 characters like the contract. An approval may carry a note ("Rates checked against last
  month") or none.

### `schema/requisitions.ts` (new)

```ts
import { REQUISITION_STATUSES } from '@omnivo/contracts';
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { users } from './users.js';
import { warehouses } from './warehouses.js';

// Step 17a: purchase requisitions. The rules on what may change when (and when one may be
// deleted) live in migration 0036.
export const requisitions = pgTable(
  'requisitions',
  {
    // deleted_at is not used: a draft that was never submitted is deleted for real, any other
    // requisition never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('purchase.requisition'), like a quotation's
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    neededBy: date('needed_by', { mode: 'string' }),
    // Where the goods are for; the warehouse's branch is the requisition's
    warehouseId: uuid('warehouse_id').notNull(),
    status: text('status', { enum: REQUISITION_STATUSES }).notNull().default('draft'),
    // contracts' requisitionAmount() when it was saved: the approval levels are chosen by it
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull().default('0'),
    note: text('note'),
    // Who wrote it. Not created_by: that one has no foreign key and may be empty on old rows of
    // other tables; this one is shown on the document, so it must name a real person.
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    uniqueIndex('requisitions_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('requisitions_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('requisitions_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One warehouse's requisitions (the list's filter), and the warehouse FK's check
    index('requisitions_warehouse_idx').on(table.tenantId, table.warehouseId, table.date, table.id),
    foreignKey({
      name: 'requisitions_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check(
      'requisitions_needed_by_check',
      sql`${table.neededBy} IS NULL OR ${table.neededBy} >= ${table.date}`,
    ),
    check('requisitions_amount_check', sql`${table.amount} >= 0`),
  ],
);

// A line: the product, the quantity as typed and in the base unit (like a stock line), and the
// cost the person expects per one of the unit. No batch, no serial numbers and no VAT: nothing
// is bought yet.
export const requisitionLines = pgTable(
  'requisition_lines',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requisitionId: uuid('requisition_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    baseQuantity: numeric('base_quantity', { precision: 19, scale: 4 }).notNull(),
    // The person's own text, or the product's name with its variant's options
    description: text('description').notNull(),
    estimatedCost: numeric('estimated_cost', { precision: 19, scale: 4 }).notNull(),
    // contracts' requisitionLineAmount() when it was saved
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('requisition_lines_line_idx').on(table.tenantId, table.requisitionId, table.lineNo),
    // A line blocks deleting its variant (product_variant_in_use), and finds where it is used
    index('requisition_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'requisition_lines_requisition_fk',
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'requisition_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'requisition_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    check(
      'requisition_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'requisition_lines_amount_check',
      sql`${table.estimatedCost} >= 0 AND ${table.amount} >= 0`,
    ),
  ],
);
```

- **`number` is NOT NULL** because a requisition is numbered when it is saved (decision 19), unlike a sales order.
  People quote "PR-2026-27-0014" while it waits for approval.
- **No `branch_id`.** The warehouse belongs to a branch, so the branch is always the warehouse's. A second column
  could disagree with it.
- **`requested_by` is a new column with a foreign key,** not the `created_by` from `baseColumns()`. `created_by` has
  no foreign key and is empty on some older tables. This one is shown on the document and in "waiting for me", so it
  must name a real person.
- **`amount` is stored,** the sum of the lines as the contract's `requisitionAmount()` gave it. The approval levels
  are chosen by it, and the list shows it without adding up lines on every read.
- **The line has no batch, no serial numbers and no VAT.** Nothing is bought yet. That is why it does not reuse
  `stockLineColumns()` (which carries batch and serials) or `salesLineColumns()` (which carries prices and VAT).
  The quantity columns are the same as a stock line's: as typed, the factor, and the base quantity.
- **`requisition_lines_variant_fk`** blocks deleting a product that a requisition asks for. 17a.3 adds it to the
  products service's `VARIANT_IN_USE` list, so the person sees `product_variant_in_use` and not a server error.
- **`estimated_cost >= 0`, not `> 0`:** a free sample costs ৳0 and is still requested.

### `schema/index.ts` and `permission-catalog.ts`

```diff
@@ -40,3 +40,5 @@ export * from './sales-returns.js';
 export * from './credit-notes.js';
 export * from './refunds.js';
 export * from './document-output.js';
+export * from './approvals.js';
+export * from './requisitions.js';
```

```diff
@@ -41,6 +41,9 @@ const DESCRIPTIONS = {
   'sales.return.manage': 'Write and post sales returns, which bring stock back in',
   'sales.credit_note.manage': 'Write and post credit notes, and apply their money to invoices',
   'sales.refund.manage': 'Pay money back to customers and void refunds',
+  'purchase.supplier.manage': 'Add, edit, archive and delete suppliers and supplier groups',
+  'purchase.supplier.balance': 'See what the company owes suppliers, and their statements',
+  'purchase.requisition.manage': 'Write, submit, reopen, cancel and delete purchase requisitions',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- The catalog's `satisfies Record<PermissionKey, string>` already failed the type check after 17a.1 added the three
  keys; these three lines fix it. `syncPermissions()` runs with the migrations and adds them to the `permissions`
  table.

### Migration 0035 (generated — then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name suppliers-requisitions`. As in every step since 9, `drizzle-kit` writes
the foreign keys before the unique indexes they point at (`approval_rules_tenant_id_idx`,
`approval_rounds_tenant_id_idx`, `requisitions_tenant_id_idx`), and the migration fails with "there is no unique
constraint matching given keys". Move every `CREATE INDEX` and `CREATE UNIQUE INDEX` up, before the first
`ADD CONSTRAINT … FOREIGN KEY`. The result:

```sql
CREATE TABLE "party_bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"bank_name" text NOT NULL,
	"branch_name" text,
	"account_name" text NOT NULL,
	"account_number" text NOT NULL,
	"routing_number" text,
	CONSTRAINT "party_bank_accounts_number_check" CHECK ("party_bank_accounts"."account_number" ~ '^[0-9]{6,20}$' AND ("party_bank_accounts"."routing_number" IS NULL OR "party_bank_accounts"."routing_number" ~ '^[0-9]{9}$'))
);
--> statement-breakpoint
CREATE TABLE "supplier_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"min_amount" numeric(19, 4) NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "approval_levels_position_check" CHECK ("approval_levels"."position" BETWEEN 1 AND 5),
	CONSTRAINT "approval_levels_amount_check" CHECK ("approval_levels"."min_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "approval_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document" text NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "approval_rounds_amount_check" CHECK ("approval_rounds"."amount" >= 0),
	CONSTRAINT "approval_rounds_closed_check" CHECK (("approval_rounds"."status" = 'pending') = ("approval_rounds"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"document" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"min_amount" numeric(19, 4) NOT NULL,
	"role_id" uuid,
	"role_name" text NOT NULL,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	CONSTRAINT "approval_steps_position_check" CHECK ("approval_steps"."position" BETWEEN 1 AND 5),
	CONSTRAINT "approval_steps_amount_check" CHECK ("approval_steps"."min_amount" >= 0),
	CONSTRAINT "approval_steps_decided_check" CHECK (("approval_steps"."decision" IS NULL AND "approval_steps"."decided_by" IS NULL AND "approval_steps"."decided_at" IS NULL) OR ("approval_steps"."decision" IS NOT NULL AND "approval_steps"."decided_by" IS NOT NULL AND "approval_steps"."decided_at" IS NOT NULL)),
	CONSTRAINT "approval_steps_comment_check" CHECK (("approval_steps"."decision" IS DISTINCT FROM 'rejected' OR "approval_steps"."comment" IS NOT NULL) AND ("approval_steps"."comment" IS NULL OR ("approval_steps"."decision" IS NOT NULL AND char_length("approval_steps"."comment") BETWEEN 1 AND 500)))
);
--> statement-breakpoint
CREATE TABLE "requisition_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"estimated_cost" numeric(19, 4) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "requisition_lines_quantity_check" CHECK ("requisition_lines"."quantity" > 0 AND "requisition_lines"."factor" > 0 AND "requisition_lines"."base_quantity" > 0),
	CONSTRAINT "requisition_lines_amount_check" CHECK ("requisition_lines"."estimated_cost" >= 0 AND "requisition_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "requisitions" (
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
	"needed_by" date,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"requested_by" uuid NOT NULL,
	CONSTRAINT "requisitions_needed_by_check" CHECK ("requisitions"."needed_by" IS NULL OR "requisitions"."needed_by" >= "requisitions"."date"),
	CONSTRAINT "requisitions_amount_check" CHECK ("requisitions"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "parties" DROP CONSTRAINT "parties_terms_check";--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "supplier_group_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "supplier_payment_terms_days" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "party_bank_accounts_party_id_idx" ON "party_bank_accounts" USING btree ("tenant_id","party_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_groups_tenant_name_idx" ON "supplier_groups" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_groups_tenant_id_idx" ON "supplier_groups" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_levels_position_idx" ON "approval_levels" USING btree ("tenant_id","rule_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_levels_role_idx" ON "approval_levels" USING btree ("tenant_id","rule_id","role_id");--> statement-breakpoint
CREATE INDEX "approval_levels_tenant_role_idx" ON "approval_levels" USING btree ("tenant_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rounds_tenant_id_idx" ON "approval_rounds" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rounds_pending_idx" ON "approval_rounds" USING btree ("tenant_id","document","document_id") WHERE "approval_rounds"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_rounds_document_idx" ON "approval_rounds" USING btree ("tenant_id","document","document_id","submitted_at");--> statement-breakpoint
CREATE INDEX "approval_rounds_waiting_idx" ON "approval_rounds" USING btree ("tenant_id","submitted_at","id") WHERE "approval_rounds"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rules_tenant_document_idx" ON "approval_rules" USING btree ("tenant_id","document");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rules_tenant_id_idx" ON "approval_rules" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_steps_position_idx" ON "approval_steps" USING btree ("tenant_id","round_id","position");--> statement-breakpoint
CREATE INDEX "approval_steps_open_role_idx" ON "approval_steps" USING btree ("tenant_id","role_id","round_id") WHERE "approval_steps"."decision" IS NULL;--> statement-breakpoint
CREATE INDEX "approval_steps_tenant_role_idx" ON "approval_steps" USING btree ("tenant_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisition_lines_line_idx" ON "requisition_lines" USING btree ("tenant_id","requisition_id","line_no");--> statement-breakpoint
CREATE INDEX "requisition_lines_variant_idx" ON "requisition_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisitions_tenant_id_idx" ON "requisitions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisitions_tenant_number_idx" ON "requisitions" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "requisitions_tenant_date_idx" ON "requisitions" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "requisitions_warehouse_idx" ON "requisitions" USING btree ("tenant_id","warehouse_id","date","id");--> statement-breakpoint
CREATE INDEX "parties_supplier_name_idx" ON "parties" USING btree ("tenant_id",lower("name"),"id") WHERE "parties"."is_supplier";--> statement-breakpoint
CREATE INDEX "parties_supplier_updated_idx" ON "parties" USING btree ("tenant_id","updated_at","id") WHERE "parties"."is_supplier";--> statement-breakpoint
CREATE INDEX "parties_tenant_supplier_group_idx" ON "parties" USING btree ("tenant_id","supplier_group_id");--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_groups" ADD CONSTRAINT "supplier_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."approval_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rounds" ADD CONSTRAINT "approval_rounds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rounds" ADD CONSTRAINT "approval_rounds_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_round_fk" FOREIGN KEY ("tenant_id","round_id") REFERENCES "public"."approval_rounds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_requisition_fk" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_supplier_group_fk" FOREIGN KEY ("tenant_id","supplier_group_id") REFERENCES "public"."supplier_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_customer_side_check" CHECK ("parties"."is_customer" OR ("parties"."customer_group_id" IS NULL AND "parties"."payment_terms_days" = 0 AND "parties"."credit_limit" IS NULL AND "parties"."price_list_id" IS NULL));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_supplier_side_check" CHECK ("parties"."is_supplier" OR ("parties"."supplier_group_id" IS NULL AND "parties"."supplier_payment_terms_days" = 0));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_terms_check" CHECK ("parties"."payment_terms_days" BETWEEN 0 AND 365 AND "parties"."supplier_payment_terms_days" BETWEEN 0 AND 365);
```

- **The two new `parties` columns are instant.** `supplier_group_id` is NULL and `supplier_payment_terms_days` has a
  constant default, so Postgres does not rewrite the table.
- **The two new side checks are checked against every existing party** when they are added. All of them pass:
  every party is a customer, and the new supplier columns are empty.
- `meta/_journal.json` and `meta/0035_snapshot.json` change too. They are generated; commit them as they are.

### Migration 0036 (custom): RLS, the posting check, the guards

Run `pnpm --filter @omnivo/db generate --custom --name suppliers-requisitions-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! ---- 1) The eight new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'supplier_groups', 'party_bank_accounts', 'approval_rules', 'approval_levels',
      'approval_rounds', 'approval_steps', 'requisitions', 'requisition_lines'
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

-- 2) A step names the role it waits for. When that role is deleted later, the step keeps its
--    role_name and only role_id becomes NULL: the history still reads "Purchase manager". A plain
--    ON DELETE SET NULL would also clear tenant_id (NOT NULL, so the role's delete would fail).
--    As in 0028, the column list needs Postgres 15 or later, and Drizzle cannot write it.
ALTER TABLE approval_steps
  ADD CONSTRAINT approval_steps_role_fk
  FOREIGN KEY (tenant_id, role_id)
  REFERENCES roles (tenant_id, id)
  ON DELETE SET NULL (role_id);

-- 3) The posting check from 0026, with the payable (decision 11):
--    - a line has a party exactly when its account is kept per party: the receivable or, from
--      now on, the payable (contracts' PARTY_ACCOUNT_PURPOSES);
--    - the party is on the right side: a receivable line names a customer, a payable line a
--      supplier (contracts' partyRoleOf). Without this a supplier's statement could show a sale.
--    Both run when an entry is posted, so lines posted before this step are never checked, and
--    the payable lines of old opening balances (with no party) stay as they are. A reversal is
--    let through both rules: it copies its original's lines as they were, and a party that has
--    left a side since must not make an old entry impossible to undo.
CREATE OR REPLACE FUNCTION journal_entries_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  debits numeric;
  credits numeric;
  lines integer;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO debits, credits, lines
    FROM journal_lines
   WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id;
  IF lines < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'journal entry % does not balance: % lines, debits %, credits %',
        NEW.id, lines, debits, credits
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_balanced';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
      JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id AND a.is_group
  ) THEN
    RAISE EXCEPTION 'journal entry % posts to a group account', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_ledger_only';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
      JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
       AND (l.party_id IS NOT NULL)
           <> coalesce(a.purpose IN ('accounts_receivable', 'accounts_payable'), false)
       AND NOT (NEW.source = 'reversal' AND l.party_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'journal entry % has a party on the wrong line', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_party_check';
  END IF;
  IF NEW.source <> 'reversal' AND EXISTS (
    SELECT 1 FROM journal_lines l
      JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
       AND NOT CASE a.purpose
                 WHEN 'accounts_receivable' THEN p.is_customer
                 WHEN 'accounts_payable' THEN p.is_supplier
                 ELSE true
               END
  ) THEN
    RAISE EXCEPTION 'journal entry % names a party that is not a customer or supplier there', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_party_role_check';
  END IF;
  RETURN NULL;
END $$;

-- 4) An approval round is history. It names a real document of its kind when it is made. Its
--    document, amount and who submitted it never change. Its status moves once, from pending, and
--    only to what its steps say: approved when every step is approved (a round with no steps, for
--    a document no level reaches, is approved at once), rejected when a step was rejected. Once
--    closed, nothing changes, and no round is ever deleted.
CREATE FUNCTION approval_rounds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval round % is history and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_history_immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The foreign key a polymorphic column cannot have. 17b adds the purchase order here.
    IF NEW.document = 'requisition' AND NOT EXISTS (
         SELECT 1 FROM requisitions WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id) THEN
      RAISE EXCEPTION 'approval round names requisition %, which does not exist', NEW.document_id
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'approval_rounds_document_fk';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.tenant_id, NEW.document, NEW.document_id, NEW.amount, NEW.submitted_by, NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.document, OLD.document_id, OLD.amount, OLD.submitted_by, OLD.submitted_at) THEN
    RAISE EXCEPTION 'approval round % cannot move to another document or amount', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_identity_immutable';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval round % is % and cannot be changed', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_closed_immutable';
  END IF;
  IF (NEW.status = 'approved' AND EXISTS (
        SELECT 1 FROM approval_steps
         WHERE tenant_id = NEW.tenant_id AND round_id = NEW.id
           AND decision IS DISTINCT FROM 'approved'))
     OR (NEW.status = 'rejected' AND NOT EXISTS (
        SELECT 1 FROM approval_steps
         WHERE tenant_id = NEW.tenant_id AND round_id = NEW.id AND decision = 'rejected')) THEN
    RAISE EXCEPTION 'approval round % cannot be % with these steps', OLD.id, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_steps_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER approval_rounds_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_rounds
  FOR EACH ROW EXECUTE FUNCTION approval_rounds_guard();

-- 5) A step is written once, when its round is submitted, and decided once, while its round is
--    pending: only the decision, who, when and the comment change, from empty. A step is decided
--    after every step before it was approved (decision 3: the levels go one after another). The
--    order is checked on UPDATE only: the Owner's own document (decision 14) inserts its steps
--    already approved, in one statement, and a row trigger may see that statement's rows in any
--    order. The one change after that is section 2's: role_id becomes NULL when the role is
--    deleted. No step is ever deleted.
CREATE FUNCTION approval_steps_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval step % is history and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_history_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role_id IS NULL AND OLD.role_id IS NOT NULL
     AND to_jsonb(NEW) - 'role_id' = to_jsonb(OLD) - 'role_id' THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM approval_rounds WHERE tenant_id = NEW.tenant_id AND id = NEW.round_id;
  -- NULL: no such round — the foreign key gives that error
  IF v_status IS NOT NULL AND v_status <> 'pending' THEN
    RAISE EXCEPTION 'the steps of a % approval round cannot be changed', v_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_closed_immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.decision IS NOT NULL
     OR to_jsonb(NEW) - ARRAY['decision', 'decided_by', 'decided_at', 'comment']
        <> to_jsonb(OLD) - ARRAY['decision', 'decided_by', 'decided_at', 'comment'] THEN
    RAISE EXCEPTION 'approval step % was decided, or would change more than its decision', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_decided_immutable';
  END IF;
  IF NEW.decision IS NOT NULL AND EXISTS (
       SELECT 1 FROM approval_steps
        WHERE tenant_id = NEW.tenant_id AND round_id = NEW.round_id
          AND position < NEW.position AND decision IS DISTINCT FROM 'approved') THEN
    RAISE EXCEPTION 'approval step % is decided before the steps above it', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_order_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER approval_steps_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_steps
  FOR EACH ROW EXECUTE FUNCTION approval_steps_guard();

-- 6) A requisition (decisions 6 and 19):
--    - its number and who asked never change;
--    - a draft is changed freely; anything else keeps what was asked for, and only its status
--      moves (reopen first, to change it);
--    - the moves are draft → pending or cancelled; pending → approved or draft; approved → draft
--      or cancelled. Cancelled is final (17b adds the ordered states). Approval always passes
--      through pending, even when no level applies or the Owner submits it (the API makes both
--      moves in one transaction): a reopened requisition's newest round is still the old,
--      approved one, and draft → approved would approve its changes with nobody looking;
--    - the status follows its newest approval round: pending while a round waits, approved only
--      when that round was approved, back from pending to draft only when it was rejected or
--      reopened. So no bug can approve a requisition that nobody approved;
--    - only a draft that was never submitted is deleted; any other is cancelled, so its approval
--      history stays.
CREATE FUNCTION requisitions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_round text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR EXISTS (
         SELECT 1 FROM approval_rounds
          WHERE tenant_id = OLD.tenant_id AND document = 'requisition' AND document_id = OLD.id) THEN
      RAISE EXCEPTION 'requisition % was submitted and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_submitted_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.number <> OLD.number OR NEW.requested_by <> OLD.requested_by
     OR (OLD.status <> 'draft'
         AND to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']
             <> to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'requisition % is % and cannot be changed; reopen it first', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_locked';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'pending'), ('draft', 'cancelled'),
       ('pending', 'approved'), ('pending', 'draft'),
       ('approved', 'draft'), ('approved', 'cancelled')) THEN
    RAISE EXCEPTION 'requisition % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_status_check';
  END IF;

  SELECT status INTO v_round
    FROM approval_rounds
   WHERE tenant_id = NEW.tenant_id AND document = 'requisition' AND document_id = NEW.id
   ORDER BY submitted_at DESC, id DESC
   LIMIT 1;
  IF (NEW.status = 'pending' AND v_round IS DISTINCT FROM 'pending')
     OR (NEW.status = 'approved' AND v_round IS DISTINCT FROM 'approved')
     OR (OLD.status = 'pending' AND NEW.status = 'draft'
         AND coalesce(v_round, 'missing') NOT IN ('rejected', 'reopened')) THEN
    RAISE EXCEPTION 'requisition % cannot be % while its approval round is %',
        OLD.id, NEW.status, coalesce(v_round, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_approval_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER requisitions_guard
  BEFORE UPDATE OR DELETE ON requisitions
  FOR EACH ROW EXECUTE FUNCTION requisitions_guard();

-- The lines: only while the requisition is a draft, checked before (OLD) and after (NEW) like
-- 0028's quotation lines. When a draft is deleted, its lines go by ON DELETE CASCADE; the header
-- is gone by then, so the lookup finds nothing and lets them go.
CREATE FUNCTION requisition_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM requisitions
         WHERE tenant_id = OLD.tenant_id AND id = OLD.requisition_id AND status <> 'draft'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM requisitions
         WHERE tenant_id = NEW.tenant_id AND id = NEW.requisition_id AND status <> 'draft')) THEN
    RAISE EXCEPTION 'the lines of a requisition that is not a draft cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisition_lines_locked';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER requisition_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON requisition_lines
  FOR EACH ROW EXECUTE FUNCTION requisition_lines_guard();
```

- **Section 1** is the same loop as every step: row-level security on, forced (so the table owner obeys it too),
  and the `tenant_isolation` policy on all eight tables.
- **Section 2, the step's role.** A composite foreign key `(tenant_id, role_id)` with a plain `ON DELETE SET NULL`
  would set *both* columns to NULL, and `tenant_id` is NOT NULL, so deleting the role would fail. Postgres 15 can
  name the column to clear: `SET NULL (role_id)`. Drizzle cannot write that, so it lives here, like 15b's shipping
  address.
- **Section 3, the posting check** (decision 27). It is the whole function from 0026 again, because `CREATE OR
  REPLACE` needs the whole body. Two changes:
  - `a.purpose IN ('accounts_receivable', 'accounts_payable')`: a payable line must now name a party, and a party
    on any other line is still refused.
  - A new block joins the line's party and checks its side with a `CASE` on the account's purpose. The `ELSE true`
    covers lines that are not on a party account; the block before has already refused a party there.
  - Payable lines posted before this step (old opening balances, manual entries) have no party. They are never
    checked again, because the check runs only when an entry is posted. The opening balances page reverses its old
    entry when it is saved; the existing reversal exception (`NEW.source = 'reversal' AND l.party_id IS NULL`) lets
    that reversal through.
  - **A reversal skips the side check entirely.** Imagine a party that was a customer, got an invoice, and later
    had its customer side removed. Undoing that old entry must still work: a reversal copies its original's lines
    exactly, and the original was right when it was posted.
  - The check is a deferred constraint trigger (from 0016), so it reads the party's flags at COMMIT, after
    everything in the transaction has been written.
- **Section 4, the round's guard.**
  - On INSERT it checks that the document exists, the foreign key a polymorphic column cannot have. 17b adds a
    `purchase_order` branch. The error uses `foreign_key_violation`, the same code a real foreign key would give.
  - It refuses DELETE always. A round is the record of who approved what; an ERP that lets anyone delete it cannot
    be audited.
  - The document, the amount and who submitted it never change, so a round cannot be moved onto another document.
  - Only a pending round changes, and its new status must match its steps: `approved` needs every step approved,
    `rejected` needs a rejected step. A round with no steps (no level reached the amount) may be approved at once.
    This stops a bug in the API from approving a document no person approved.
- **Section 5, the step's guard.**
  - A step changes only while its round is pending, only once (`OLD.decision IS NOT NULL` is refused), and only in
    its four decision columns. The `to_jsonb(NEW) - ARRAY[…]` comparison freezes every other column, including any
    column added later, without anyone remembering to list it here.
  - **The order rule** (decision 3): a step is decided only when every step above it is approved. It runs on
    UPDATE only. The Owner's own document (decision 14) inserts its steps already approved, in one statement, and
    a row trigger may see the other rows of the same statement in any order, so an INSERT check could fail at
    random.
  - The first `IF` lets through the one change a closed step can get: `role_id` becoming NULL when the role is
    deleted (section 2). Without it, deleting a role that ever approved anything would fail.
- **Section 6, the requisition's guard.**
  - The number and who asked never change, even on a draft.
  - A requisition that is not a draft changes only its status. Same JSON comparison as above. To change a pending
    or approved one, "Reopen" first (decision 6).
  - The allowed moves are listed as pairs, so a new status in 17b is refused until it is added here.
  - **The status follows the newest round** (decision 26). It is read with `ORDER BY submitted_at DESC, id DESC`.
    Two rounds of the same document can never be submitted in one transaction (only one can wait), so
    `submitted_at` (the transaction's start time) always tells them apart. The `id` is only a tie-breaker.
  - **There is no `draft → approved` move.** After an approved requisition is reopened, its newest round is still
    the old, approved one. A direct `draft → approved` would pass the round check and approve the changes with
    nobody looking. So even a requisition that needs no approval goes `draft → pending → approved` in one
    transaction (17a.3).
  - DELETE: only a draft that was never submitted (decision 19). Once a round exists, the requisition is cancelled
    instead, so the round's history keeps a document to point at.
- **The lines' guard** is 15b's quotation line guard: lines change only while the requisition is a draft, checked
  on both the old and the new row (so a line cannot be moved into a pending requisition either). When a draft is
  deleted, its lines go by `ON DELETE CASCADE`; the header is already gone then, so the check finds nothing and lets
  them go.

> **What we checked.** On a throwaway database with every migration up to 0036, as `omnivo_app` (121 checks, plus a
> race in two sessions). Parties: a supplier-only, a customer-only and a both party were accepted with their own
> groups and terms, and existing-style customers got supplier terms 0. Terms of 366 or -1, a customer group, customer
> terms or a credit limit on a supplier-only party, a supplier group or supplier terms on a customer-only party,
> dropping a side without clearing it, dropping the last side, another workspace's supplier group, deleting a group
> in use and a group name in another case all failed; dropping the customer side with its columns cleared passed,
> and a supplier group could share a customer group's name. Bank accounts: 6 to 20 digits passed with and without a
> routing number; 5 digits, 21 digits, dashes, an 8-digit routing number and another workspace's party failed;
> deleting a party deleted its accounts. Levels: a second rule for the same document, a repeated position, a role
> twice, position 0 or 6, a negative amount, another workspace's role, and deleting a role a level names failed;
> deleting a rule deleted its levels. Requisitions: a needed-by date before the date, a duplicate number, another
> workspace's warehouse, a negative amount, no requester, a zero quantity, a negative cost, a repeated line number
> and deleting a requested product failed; a draft and its lines changed; its number and requester did not.
> Approval: a round for a missing requisition, a second waiting round and a step at position 6 failed; pending
> without a round, approved while the round waited, and draft while it waited failed. Deciding step 2 before step 1,
> a decision without a person, a rejection without a comment or with 501 characters, a comment on an undecided step
> and changing a step's role name failed; approving step 1 with a note passed and then could not be changed, moved
> or deleted. Approving or rejecting a round against its steps failed; rejecting it after step 2 was rejected passed
> (but not without `closed_at`), and the requisition went back to draft; the closed round and its steps then refused
> every change and every delete, and the requisition could not be deleted. A reopened round let it go back to draft;
> an approved round let it be approved. An approved requisition refused changes to it and its lines, refused pending
> and deletion, went back to draft on reopen, and then could not be approved without a new round. Deleting a role
> cleared it on a closed step and on a waiting one, keeping the name. The Owner's own requisition, with its steps
> inserted approved in reverse order, and one that no level reached (no steps) were approved. Cancelled was final.
> A never-submitted draft was deleted with its lines. Posting: a payable line without a party, a payable line to a
> customer-only party, a receivable line to a supplier-only party and a party on an expense line failed; a payable
> line to a supplier, both sides of a party that is both, and a receivable to a customer posted; reversals with a
> payable line without a party and a receivable line to a supplier-only party posted. Another workspace saw none of
> the eight tables except its own group, could not write into them, and changed and deleted nothing; with no
> workspace nothing was visible. The three purchase permissions were in the catalog. Two sessions submitting the
> same draft at once: the second waited for the first, then failed on `approval_rounds_pending_idx`; one round.
> `drizzle-kit generate` then reports no schema changes.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db typecheck
pnpm lint
```

`packages/db` reads the contract from its build, so build it first after 17a.1. The whole repo still does not
type-check: on top of what 17a.1 left, nothing uses the new tables yet, and the API's posting service still only
accepts customers on a party line. 17a.3 changes both.

Then run `pnpm db:migrate` against your dev database. It applies 0035 and 0036. Your customers are unchanged; they
are not suppliers until you click "Make supplier too" (17a.6).

---

## 17a.3 — `apps/api`: suppliers, approvals and requisitions

The API in four groups:

1. **Changes to code you already have:** the posting check knows the payable, a statement can be a supplier's, the
   opening balances count suppliers, a customer that is also a supplier is deleted as a customer only, roles used by
   an approval cannot be deleted, a requisition line holds on to its product, and the role templates get the new
   permissions.
2. **Suppliers** (`src/purchase/`): the groups, the suppliers with their bank accounts, and "Make supplier too".
3. **The approvals engine:** the rules of Settings → Approvals, a document's rounds, approve and reject, the waiting
   list and the bell.
4. **Requisitions** and the cost a line starts with, then the controllers and the module.

### The posting check knows the payable: `journal/posting.service.ts`

```diff
@@ -1,9 +1,9 @@
 import { Injectable } from '@nestjs/common';
 import {
   type ErrorCode,
-  isPartyAccountPurpose,
   isStockJournalSource,
   type JournalSource,
+  partyRoleOf,
   sumMoney,
 } from '@omnivo/contracts';
 import {
@@ -29,7 +29,8 @@ export type EntryRow = typeof journalEntries.$inferSelect;
 export interface LineInput {
   accountId: string;
   branchId: string | null;
-  // Step 15a: the customer on a receivable line; null on every other line
+  // The customer on a receivable line (step 15a), the supplier on a payable line (step 17a); null
+  // on every other line
   partyId: string | null;
   description: string | null;
   debit: string;
@@ -68,21 +69,23 @@ export interface PartyIssue {
 // marks every wrong row at once
 export function partyError(issues: readonly PartyIssue[]): AppError {
   const first = issues[0]?.code ?? 'journal_party_invalid';
-  return new AppError(409, first, 'Some lines have a wrong customer, or need one.', {
+  return new AppError(409, first, 'Some lines have a wrong customer or supplier, or need one.', {
     fieldErrors: Object.fromEntries(
       issues.map((issue) => [`lines.${String(issue.index)}.partyId`, [issue.code]]),
     ),
   });
 }
 
-// The party rule (step 15a): a line on an account kept per party (the receivable) names a
-// customer, and no other line names anyone. Migration 0026 checks the same at posting, as a safety
-// net; here a person gets an answer per line instead of one database error.
+// The party rule: a line on an account kept per party names a party of the right kind, a customer
+// on the receivable (step 15a) and a supplier on the payable (step 17a), and no other line names
+// anyone. Migration 0036 checks the same at posting, as a safety net; here a person gets an answer
+// per line instead of one database error.
 // purposeOf: each line's account → its purpose, from a query the caller already made.
-// allowMissing: the receivable line may have no customer yet — a draft (the person picks the
-// customer before posting), or a reversal of an entry posted before step 15a, which had none.
-// allowArchived: a reversal undoes old work, even for a customer archived since.
-// FOR SHARE on the parties, like the accounts: nobody archives one until we commit.
+// allowMissing: the party line may have no party yet — a draft (the person picks the party before
+// posting), or a reversal of an entry posted before the rule, which had none.
+// allowArchived: a reversal undoes old work, even for a party archived since.
+// FOR SHARE on the parties, like the accounts: nobody archives one, or removes the side the line
+// needs, until we commit.
 export async function checkParties(
   tx: Transaction,
   lines: readonly { accountId: string; partyId: string | null }[],
@@ -96,27 +99,32 @@ export async function checkParties(
     partyIds.length === 0
       ? []
       : await tx
-          .select({ id: parties.id })
+          .select({
+            id: parties.id,
+            isCustomer: parties.isCustomer,
+            isSupplier: parties.isSupplier,
+          })
           .from(parties)
           .where(
             and(
               eq(parties.tenantId, getTenantId()),
               inArray(parties.id, partyIds),
-              // Step 17 adds suppliers: a payable line will need is_supplier instead
-              eq(parties.isCustomer, true),
               allowArchived ? undefined : isNull(parties.archivedAt),
             ),
           )
           .for('share');
-  const usable = new Set(found.map((party) => party.id));
+  const sides = new Map(found.map((party) => [party.id, party]));
   return lines.flatMap((line, index): PartyIssue[] => {
-    const perParty = isPartyAccountPurpose(purposeOf.get(line.accountId) ?? null);
+    const role = partyRoleOf(purposeOf.get(line.accountId) ?? null);
     if (line.partyId === null) {
-      return perParty && !allowMissing ? [{ index, code: 'journal_party_required' }] : [];
+      return role !== null && !allowMissing ? [{ index, code: 'journal_party_required' }] : [];
     }
-    if (!perParty) return [{ index, code: 'journal_party_not_allowed' }];
-    // Unknown, archived, not a customer, another tenant's: one answer, like the accounts
-    return usable.has(line.partyId) ? [] : [{ index, code: 'journal_party_invalid' }];
+    if (role === null) return [{ index, code: 'journal_party_not_allowed' }];
+    // Unknown, archived, another tenant's, or not on this side (a customer on the payable): one
+    // answer, like the accounts
+    const party = sides.get(line.partyId);
+    const onSide = role === 'customer' ? party?.isCustomer : party?.isSupplier;
+    return onSide === true ? [] : [{ index, code: 'journal_party_invalid' }];
   });
 }
 
```

- **`checkParties()` now asks which side a line needs.** `partyRoleOf()` (17a.1) turns the account's purpose into
  `customer`, `supplier` or `null`. The query no longer filters `is_customer`; it reads both flags, and each line is
  checked against its own side. One query still serves the whole entry, however many lines it has.
- **A customer on the payable is `journal_party_invalid`,** the same answer as an unknown or archived party. The
  form shows the error under the line, and the person picks from the right list.
- **The `FOR SHARE` lock now also protects the side.** Removing a side (below) locks the party `FOR UPDATE`, so a
  posting that read "is a supplier" cannot commit a payable line after the supplier side is gone. Migration 0036
  checks the same rule again when the entry is posted (decision 27), as a net under this one.
- **The error's English text says "customer or supplier".** The app never shows it (it shows the code's own
  words), but the API's other users read it.

### A statement for either side: `journal/ledger.service.ts`

```diff
@@ -1,5 +1,11 @@
 import { Inject, Injectable } from '@nestjs/common';
-import { addMoney, type LedgerPage, subtractMoney } from '@omnivo/contracts';
+import {
+  addMoney,
+  type LedgerPage,
+  type PartyAccountPurpose,
+  type PartyRole,
+  subtractMoney,
+} from '@omnivo/contracts';
 import { journalEntries, journalLines, ledgerAccounts, parties } from '@omnivo/db';
 import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
@@ -20,6 +26,12 @@ function balanceWhere(condition: SQL | undefined): SQL<string> {
   return sql<string>`round(coalesce(sum(${journalLines.debit} - ${journalLines.credit}) FILTER (WHERE ${filter}), 0), 4)`;
 }
 
+// The account a party's lines are on: contracts' PARTY_ROLE_OF the other way round
+const PARTY_ACCOUNT = {
+  customer: 'accounts_receivable',
+  supplier: 'accounts_payable',
+} as const satisfies Record<PartyRole, PartyAccountPurpose>;
+
 interface LedgerQuery {
   limit: number;
   cursor?: string | undefined;
@@ -43,10 +55,17 @@ export class LedgerService {
     });
   }
 
-  // A customer's statement (step 15a): the same page as a ledger, over the lines of the receivable
-  // that carry this customer. The account filter matters from step 17 on: a party that is also a
-  // supplier has payable lines too, and those are not what the customer owes.
-  statement(partyId: string, query: LedgerQuery): Promise<LedgerPage> {
+  // A party's statement: the same page as a ledger, over the lines that carry this party on the
+  // account of its side: the receivable for a customer (step 15a), the payable for a supplier (step
+  // 17a). A party that is both has lines on both accounts, and each page shows only its own: what
+  // the customer owes is not netted with what the company owes the supplier. The balance is
+  // debit − credit like every ledger, so a supplier's is negative while the company owes it; the
+  // app turns the sign round.
+  statement(
+    partyId: string,
+    query: LedgerQuery,
+    role: PartyRole = 'customer',
+  ): Promise<LedgerPage> {
     const tenantId = getTenantId();
     return this.withTenant(async (tx) => {
       const [party] = await tx
@@ -56,22 +75,22 @@ export class LedgerService {
           and(
             eq(parties.tenantId, tenantId),
             eq(parties.id, partyId),
-            eq(parties.isCustomer, true),
+            role === 'customer' ? eq(parties.isCustomer, true) : eq(parties.isSupplier, true),
           ),
         );
-      if (!party) throw notFound('Customer');
-      const receivable = tx
+      if (!party) throw notFound(role === 'customer' ? 'Customer' : 'Supplier');
+      const accounts = tx
         .select({ id: ledgerAccounts.id })
         .from(ledgerAccounts)
         .where(
           and(
             eq(ledgerAccounts.tenantId, tenantId),
-            eq(ledgerAccounts.purpose, 'accounts_receivable'),
+            eq(ledgerAccounts.purpose, PARTY_ACCOUNT[role]),
           ),
         );
       return this.page(
         tx,
-        and(eq(journalLines.partyId, partyId), inArray(journalLines.accountId, receivable)),
+        and(eq(journalLines.partyId, partyId), inArray(journalLines.accountId, accounts)),
         query,
       );
     });
```

- **`statement()` takes the side,** with `'customer'` as the default, so step 15a's caller does not change. The party
  must be on that side, or it is `not_found`: a customer-only party has no supplier statement to show.
- **`PARTY_ACCOUNT` is `PARTY_ROLE_OF` turned round.** `satisfies Record<PartyRole, PartyAccountPurpose>` makes the
  type checker refuse a missing side, should a third one ever be added. A hand-written map is simpler to read than
  searching `PARTY_ROLE_OF` for a value.
- **The balance keeps the ledger's sign** (debit − credit). A supplier the company owes ৳40,000 shows −40,000.00, as
  the payable account's own ledger does. The supplier page turns the sign round for the person (17a.6); the API
  sends one kind of number for every ledger.

### Opening balances count suppliers: `journal/opening-balances.service.ts`

```diff
@@ -5,6 +5,7 @@ import {
   type OpeningBalances,
   type OpeningBalancesInput,
   absMoney,
+  partyRoleOf,
   shiftIsoDate,
   subtractMoney,
   sumMoney,
@@ -68,7 +69,7 @@ export class OpeningBalancesService {
       if ((current?.id ?? null) !== input.replaces) throw versionConflict();
 
       // Keep each line's index in the request, so an error lands under the right row of the page
-      // The same account (and customer) twice is refused by the contract (opening_balance_twice)
+      // The same account (and party) twice is refused by the contract (opening_balance_twice)
       const filled = input.lines.flatMap((line, index) =>
         isZeroMoney(line.debit) && isZeroMoney(line.credit) ? [] : [{ ...line, index }],
       );
@@ -104,14 +105,12 @@ export class OpeningBalancesService {
       const stock = await stockAccountIds(tx);
       const onStock = filled.flatMap((line) => (stock.has(line.accountId) ? [line.index] : []));
       if (onStock.length > 0) throw invalidLines('journal_account_stock', onStock);
-      // Step 15a: the receivable is split by customer, and only the receivable names one. Checked
-      // here and not only when the entry is posted below: the posted entry has no zero lines and an
-      // extra equity line, so its line numbers are not the page's rows.
-      const partyIssues = await checkParties(
-        tx,
-        filled,
-        new Map(accounts.map((account) => [account.id, account.purpose])),
-      );
+      // The receivable is split by customer (step 15a) and the payable by supplier (step 17a), and
+      // no other account names a party. Checked here and not only when the entry is posted below:
+      // the posted entry has no zero lines and an extra equity line, so its line numbers are not
+      // the page's rows.
+      const purposeOf = new Map(accounts.map((account) => [account.id, account.purpose]));
+      const partyIssues = await checkParties(tx, filled, purposeOf);
       if (partyIssues.length > 0) {
         // An issue's index is its place in `filled`; the page needs the row it came from
         throw partyError(
@@ -177,8 +176,13 @@ export class OpeningBalancesService {
         changes: created({
           goLiveDate: filled.length > 0 ? input.goLiveDate : null,
           accounts: new Set(filled.map((line) => line.accountId)).size,
-          // How many customers' dues came in with it (step 15a)
-          customers: filled.filter((line) => line.partyId !== null).length,
+          // How many customers' dues (step 15a) and suppliers' bills (step 17a) came in with it
+          customers: filled.filter(
+            (line) => partyRoleOf(purposeOf.get(line.accountId) ?? null) === 'customer',
+          ).length,
+          suppliers: filled.filter(
+            (line) => partyRoleOf(purposeOf.get(line.accountId) ?? null) === 'supplier',
+          ).length,
           entry: number,
         }),
       });
```

- Nothing changes in how the page is checked: `checkParties()` already does both sides. The map of purposes now has
  a name (`purposeOf`), because the audit row uses it too.
- **The audit row counts customers and suppliers apart.** Before, it counted every line with a party as a customer;
  with payable lines that would be wrong, and an auditor reading "42 customers" would look for 42 receivables.

### Deleting a customer that is also a supplier: `sales/customers.service.ts`

```diff
@@ -9,13 +9,21 @@ import {
   type UpdateCustomerInput,
 } from '@omnivo/contracts';
 import {
+  creditNotes,
   customerGroups,
+  deliveries,
+  invoices,
   journalEntries,
   journalLines,
   ledgerAccounts,
   parties,
   partyAddresses,
   priceLists,
+  quotations,
+  receipts,
+  refunds,
+  salesOrders,
+  salesReturns,
   tenantSettings,
 } from '@omnivo/db';
 import { and, asc, eq, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
@@ -99,6 +107,14 @@ function codeTaken(): AppError {
   });
 }
 
+function customerInUse(): AppError {
+  return new AppError(
+    409,
+    'customer_in_use',
+    'Entries or sales documents use this customer. Archive it instead.',
+  );
+}
+
 function fieldError(code: ErrorCode, field: string): AppError {
   return new AppError(400, code, 'Check the highlighted fields and try again.', {
     fieldErrors: { [field]: [code] },
@@ -287,17 +303,62 @@ export class CustomersService {
     });
   }
 
-  // Only a customer nothing uses yet: one added by mistake. Step 17 will keep a party that is also
-  // a supplier, as a supplier.
+  // A supplier the company starts selling to (step 17a): the same party, now also a customer. Its
+  // customer fields start at their defaults (the database keeps them so while it was not a
+  // customer): no group, terms 0, no credit limit, no price list. The person fills them in next.
+  async fromSupplier(id: string, version: number): Promise<Customer> {
+    const canSeeBalance = await this.access.canSee();
+    return this.withTenant(async (tx) => {
+      const [before] = await tx
+        .select()
+        .from(parties)
+        .where(
+          and(
+            eq(parties.tenantId, getTenantId()),
+            eq(parties.id, id),
+            eq(parties.isSupplier, true),
+          ),
+        )
+        .for('update');
+      if (!before) throw notFound('Supplier');
+      if (before.version !== version) throw versionConflict();
+      if (before.isCustomer) {
+        throw new AppError(409, 'party_role_exists', 'This supplier is already a customer.');
+      }
+      await tx
+        .update(parties)
+        .set({
+          isCustomer: true,
+          version: sql`${parties.version} + 1`,
+          updatedBy: currentPrincipal().userId,
+        })
+        .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
+      const customer = await this.read(tx, id, canSeeBalance);
+      await audit(tx, {
+        action: 'customer.created',
+        entityType: 'customer',
+        entityId: id,
+        changes: created(await this.snapshot(tx, customer)),
+      });
+      return customer;
+    });
+  }
+
+  // Only a customer nothing uses yet: one added by mistake. A party that is also a supplier (step
+  // 17a) stays, as a supplier: only its customer side goes.
   async remove(id: string, version: number): Promise<void> {
     try {
       await this.withTenant(async (tx) => {
         const before = await this.lock(tx, id);
         if (before.version !== version) throw versionConflict();
-        // Its addresses go with it (ON DELETE CASCADE)
-        await tx
-          .delete(parties)
-          .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
+        if (before.isSupplier) {
+          await this.dropCustomerSide(tx, before);
+        } else {
+          // Its addresses go with it (ON DELETE CASCADE)
+          await tx
+            .delete(parties)
+            .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
+        }
         await audit(tx, {
           action: 'customer.deleted',
           entityType: 'customer',
@@ -308,16 +369,67 @@ export class CustomersService {
     } catch (error) {
       // No "is it used?" query first: the FK is the check, here and on every sales document
       if (CUSTOMER_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
-        throw new AppError(
-          409,
-          'customer_in_use',
-          'Entries or sales documents use this customer. Archive it instead.',
-        );
+        throw customerInUse();
       }
       throw error;
     }
   }
 
+  // The party stays, so no foreign key speaks up: the documents and receivable lines that name it
+  // are looked for here. The party row is locked FOR UPDATE (lock() above), and every sales
+  // document and every posting locks it FOR SHARE first (assertCustomer, checkParties): one that
+  // started before us has committed when this runs, and one that starts after finds no customer.
+  // The customer's own columns go back to their defaults in the same UPDATE, as the database
+  // demands (parties_customer_side_check), and so do its shipping addresses: they are where the
+  // customer's goods went. The billing address is the party's, and the supplier keeps it.
+  private async dropCustomerSide(tx: Transaction, party: PartyRow): Promise<void> {
+    const tenantId = getTenantId();
+    // The tables of CUSTOMER_IN_USE: the same list the delete's foreign keys check
+    const documents = [
+      quotations,
+      salesOrders,
+      deliveries,
+      invoices,
+      receipts,
+      salesReturns,
+      creditNotes,
+      refunds,
+    ].map(
+      (table) =>
+        sql`SELECT 1 FROM ${table} WHERE tenant_id = ${tenantId}::uuid AND customer_id = ${party.id}::uuid`,
+    );
+    const used = await tx.execute(sql`
+      ${sql.join(documents, sql` UNION ALL `)}
+      UNION ALL
+      SELECT 1 FROM ${journalLines} l
+        JOIN ${ledgerAccounts} a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
+       WHERE l.tenant_id = ${tenantId}::uuid AND l.party_id = ${party.id}::uuid
+         AND a.purpose = 'accounts_receivable'
+      LIMIT 1`);
+    if (used.length > 0) throw customerInUse();
+    await tx
+      .update(parties)
+      .set({
+        isCustomer: false,
+        customerGroupId: null,
+        paymentTermsDays: 0,
+        creditLimit: null,
+        priceListId: null,
+        version: sql`${parties.version} + 1`,
+        updatedBy: currentPrincipal().userId,
+      })
+      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, party.id)));
+    await tx
+      .delete(partyAddresses)
+      .where(
+        and(
+          eq(partyAddresses.tenantId, tenantId),
+          eq(partyAddresses.partyId, party.id),
+          eq(partyAddresses.kind, 'shipping'),
+        ),
+      );
+  }
+
   // The columns the form sets, the same on create and update
   private fields(input: CustomerInput) {
     return {
```

- **`fromSupplier()` is "Make customer too"** (decision 10). It locks the party, checks the version, refuses a party
  that is already a customer (`party_role_exists`) and sets `is_customer`. The customer's columns are already at
  their defaults: the database kept them so while the party was not a customer (decision 22). The audit row is
  `customer.created`, because for the customer list that is what happened.
- **`remove()` on a party that is both drops the customer side only.** A `DELETE` would also delete the supplier
  (or fail on its payable lines). `dropCustomerSide()` runs instead, and the audit row stays `customer.deleted`.
- **`dropCustomerSide()` looks for what uses the side itself.** With a `DELETE`, the foreign keys of
  `CUSTOMER_IN_USE` are the check. With an `UPDATE` of a flag, no foreign key fires, so the API asks the same tables
  in one `UNION ALL … LIMIT 1` query: the first row found is enough. The tables are passed as Drizzle objects
  (`${quotations}`), not typed as names, so a renamed table breaks the type check instead of this query.
- **The race is closed by the lock order.** `lock()` holds the party `FOR UPDATE`. Every sales document
  (`assertCustomer`) and every posting (`checkParties`) takes it `FOR SHARE` first. A document that started before
  us has committed by the time our query runs (our lock waited for it), so the query sees it; a document that starts
  after us waits, then finds no customer.
- **The `UPDATE` clears the customer's columns together with the flag.** `parties_customer_side_check` (decision 22)
  refuses a non-customer with a group, terms, a limit or a price list, and it is checked per row: setting the flag
  first and clearing later, in two statements, would fail on the first.
- **The shipping addresses go, the billing address stays.** Shipping addresses are where the customer's goods went;
  the billing address is the party's, and the supplier page shows it (decision 9). No sales order points at those
  shipping addresses: the side was not used.

```diff
@@ -54,6 +54,15 @@ export class CustomersController {
     return this.customers.setArchived(params.id, body.version, false);
   }
 
+  // Step 17a: "Make customer too" on a supplier's page
+  @Endpoint(routes.customers.fromSupplier)
+  fromSupplier({
+    params,
+    body,
+  }: RouteInput<Routes['fromSupplier']>): Promise<RouteResponse<Routes['fromSupplier']>> {
+    return this.customers.fromSupplier(params.id, body.version);
+  }
+
   @Endpoint(routes.customers.remove)
   remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
     return this.customers.remove(params.id, query.version);
```

- The route is `POST /suppliers/:id/make-customer`, but it answers a customer and needs `sales.customer.manage`, so
  it lives with the customers.

### A role an approval needs cannot be deleted: `roles/roles.service.ts`

```diff
@@ -7,6 +7,8 @@ import type {
   RoleInput,
 } from '@omnivo/contracts';
 import {
+  approvalRounds,
+  approvalSteps,
   invitationRoles,
   invitations,
   membershipRoles,
@@ -47,7 +49,7 @@ function roleInUse(): AppError {
   return new AppError(
     409,
     'role_in_use',
-    'Someone has this role or an open invitation gives it. Change that first.',
+    'Someone has this role, an open invitation gives it, an approval level uses it, or an approval waits for it. Change that first.',
   );
 }
 
@@ -165,7 +167,31 @@ export class RolesService {
               isNull(invitations.revokedAt),
             ),
           );
-        if ((members?.total ?? 0) + (open?.total ?? 0) > 0) throw roleInUse();
+        // Step 17a: a document waiting for this role's approval would wait for nobody (only an
+        // Owner could still decide it). A step that was already decided keeps the role's name, so
+        // old history does not stop a delete. A new step can only be copied from a level, and a
+        // level's own foreign key stops the delete below (approval_levels_role_fk).
+        const [waiting] = await tx
+          .select({ total: count() })
+          .from(approvalSteps)
+          .innerJoin(
+            approvalRounds,
+            and(
+              eq(approvalRounds.tenantId, approvalSteps.tenantId),
+              eq(approvalRounds.id, approvalSteps.roundId),
+            ),
+          )
+          .where(
+            and(
+              eq(approvalSteps.tenantId, tenantId),
+              eq(approvalSteps.roleId, id),
+              isNull(approvalSteps.decision),
+              eq(approvalRounds.status, 'pending'),
+            ),
+          );
+        if ((members?.total ?? 0) + (open?.total ?? 0) + (waiting?.total ?? 0) > 0) {
+          throw roleInUse();
+        }
 
         await tx
           .delete(rolePermissions)
@@ -183,6 +209,9 @@ export class RolesService {
       // গোনার পরে, মোছার আগে আরেকজন কাউকে এই রোল দিয়ে ফেলল — তার insert এই রোলের রো-তে FK-র lock
       // নেয়, তাই আমাদের DELETE তার commit পর্যন্ত অপেক্ষা করে তারপর FK-তে ভাঙে। শেষ পাহারা DB নিজে
       if (isForeignKeyViolation(error, 'membership_roles_role_fk')) throw roleInUse();
+      // Step 17a: an approval level names the role (Settings → Approvals). No count first: the FK
+      // is the check.
+      if (isForeignKeyViolation(error, 'approval_levels_role_fk')) throw roleInUse();
       throw error;
     }
   }
```

- **A level names the role:** the foreign key `approval_levels_role_fk` refuses the delete, and the API turns it into
  the same `role_in_use` as a member who has the role. No count first, like the members' race already handled here.
- **A waiting step names the role:** there is no foreign key to stop it (a step's link is `ON DELETE SET NULL`, so
  history survives a delete), so the API counts undecided steps of pending rounds. Without this, a document would
  wait for a role nobody can ever hold again, and only an Owner could move it.
- **Old, decided steps do not count.** They keep the role's name (`role_name`), and losing the link costs nothing.
- **Why the count cannot miss a step added at the same moment:** a new step is copied from a level, and a level holds
  the role through its foreign key. While a level names the role, the delete fails anyway.
- The message names the new reason, so the person knows where to look.

### Smaller changes

```diff
@@ -67,6 +67,8 @@ const VARIANT_IN_USE = [
   // step 15d
   'sales_return_lines_variant_fk',
   'credit_note_lines_variant_fk',
+  // step 17a
+  'requisition_lines_variant_fk',
 ] as const;
 
 // The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
```

- A requisition line holds on to its product, like every other document line: deleting the product is refused with
  `product_variant_in_use`.

```diff
@@ -131,6 +131,14 @@ const RETURNING = ['sales.return.manage'] as const;
 const CREDITING = ['sales.credit_note.manage'] as const;
 const REFUNDING = ['sales.refund.manage'] as const;
 
+// Step 17a. The accountant keeps the suppliers' accounts and sees what the company owes each one;
+// bills and payments follow in 17c. The people who run the stock (a store keeper, a depot manager,
+// a production manager, a garments merchandiser buying fabric and trims for a buyer's order) ask
+// for goods with a requisition. Nobody gets an approval: the levels are set by the owner in
+// Settings → Approvals, by role, and a workspace starts with none.
+const SUPPLYING = ['purchase.supplier.manage', 'purchase.supplier.balance'] as const;
+const REQUESTING = ['purchase.requisition.manage'] as const;
+
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
 const ACCOUNTANT: RoleTemplate = {
@@ -156,6 +164,8 @@ const ACCOUNTANT: RoleTemplate = {
     // Step 15d: credit notes and refunds
     ...CREDITING,
     ...REFUNDING,
+    // Step 17a: the suppliers and what the company owes them
+    ...SUPPLYING,
   ],
 };
 
@@ -165,7 +175,13 @@ const STOCK_WORK = ['inventory.stock.adjust', 'inventory.stock.transfer'] as con
 const STORE_KEEPER: RoleTemplate = {
   name: 'Store keeper',
   description: 'Receives goods and writes GRNs',
-  permissions: ['inventory.product.manage', ...STOCK_WORK, ...DELIVERING, ...RETURNING],
+  permissions: [
+    'inventory.product.manage',
+    ...STOCK_WORK,
+    ...DELIVERING,
+    ...RETURNING,
+    ...REQUESTING,
+  ],
 };
 
 function group(
@@ -378,6 +394,7 @@ export const INDUSTRY_TEMPLATES = {
           'inventory.product.manage',
           'sales.customer.manage',
           ...ORDERING,
+          ...REQUESTING,
         ],
       },
       STORE_KEEPER,
@@ -441,6 +458,7 @@ export const INDUSTRY_TEMPLATES = {
           ...STOCK_WORK,
           ...DELIVERING,
           ...RETURNING,
+          ...REQUESTING,
         ],
       },
       {
@@ -513,6 +531,7 @@ export const INDUSTRY_TEMPLATES = {
           ...STOCK_WORK,
           ...DELIVERING,
           ...RETURNING,
+          ...REQUESTING,
         ],
       },
       {
@@ -561,7 +580,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Production manager',
         description: 'Production orders and material use',
-        permissions: ['core.user.read', 'inventory.product.manage', ...STOCK_WORK],
+        permissions: ['core.user.read', 'inventory.product.manage', ...STOCK_WORK, ...REQUESTING],
       },
       STORE_KEEPER,
     ],
@@ -621,6 +640,8 @@ export const INDUSTRY_TEMPLATES = {
           ...RETURNING,
           ...CREDITING,
           ...REFUNDING,
+          ...SUPPLYING,
+          ...REQUESTING,
         ],
       },
       { name: 'Cashier', description: 'Sells at the counter', permissions: [...COLLECTING] },
@@ -676,6 +697,8 @@ export const INDUSTRY_TEMPLATES = {
           ...RETURNING,
           ...CREDITING,
           ...REFUNDING,
+          ...SUPPLYING,
+          ...REQUESTING,
         ],
       },
     ],
```

- **`SUPPLYING` and `REQUESTING`** are new lists, like `SELLING` and `ORDERING` (decision 33). The accountant keeps
  the suppliers' accounts, because the payable is the accountant's book. The people who run the stock ask for goods.
  A Shop manager and a Manager run everything, so they get both.
- **No approval permission:** there is none. Who approves is set by role in Settings → Approvals, and a new workspace
  has no levels, so its requisitions are approved when submitted until the owner sets some.
- Like every template change, this reaches new workspaces only. An existing workspace's owner gives the permissions
  in Settings → Roles.

```diff
@@ -30,6 +30,7 @@ import { NotificationsModule } from './notifications/notifications.module.js';
 import { NumberingModule } from './numbering/numbering.module.js';
 import { PermissionGuard } from './rbac/permission.guard.js';
 import { ProductsModule } from './products/products.module.js';
+import { PurchaseModule } from './purchase/purchase.module.js';
 import { RbacModule } from './rbac/rbac.module.js';
 import { ReportsModule } from './reports/reports.module.js';
 import { RolesModule } from './roles/roles.module.js';
@@ -67,6 +68,7 @@ export class AppModule implements NestModule {
         TaxModule,
         SalesModule,
         DocumentsModule,
+        PurchaseModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

### Who sees what the company owes: `purchase/payable-access.ts` (new)

```ts
import { Injectable } from '@nestjs/common';

import { PermissionService } from '../rbac/permission.service.js';

// Who may see what the company owes its suppliers (step 17a): purchase.supplier.balance. Like
// BalanceAccess for customers (step 15a): reading suppliers needs no permission, so the list and
// the detail go to everyone, with the balance set to null for someone without it.
@Injectable()
export class PayableAccess {
  constructor(private readonly permissions: PermissionService) {}

  async canSee(): Promise<boolean> {
    const access = await this.permissions.ofCurrentUser();
    return access.permissions.includes('purchase.supplier.balance');
  }
}
```

- A copy of step 15a's `BalanceAccess` with the supplier's permission. Two small classes are easier to read than one
  that takes a permission key, and each service asks one plain question: "may this person see balances?"

### Supplier groups: `purchase/supplier-groups.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { SupplierGroup, SupplierGroupInput } from '@omnivo/contracts';
import { supplierGroups, parties } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type GroupRow = typeof supplierGroups.$inferSelect;

// Every supplier in the group, archived ones too: they still hold the FK that stops a delete.
// The outer table by its name: Drizzle would print ${supplierGroups.id} as a bare "id", which
// inside this subquery means the party's own id.
const supplierCount = sql<number>`(
  SELECT count(*)::int FROM ${parties} p
   WHERE p.tenant_id = supplier_groups.tenant_id AND p.supplier_group_id = supplier_groups.id
)`;

function toGroup(row: GroupRow, count: number): SupplierGroup {
  return {
    id: row.id,
    name: row.name,
    supplierCount: count,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'supplier_group_name_taken', 'Another group already has this name.', {
    fieldErrors: { name: ['supplier_group_name_taken'] },
  });
}

// Local, Importer, Raw material, Packaging (step 17a), like the customer groups of step 15a.
// Deleted for real, and only while empty: a group is a label for filtering, with no history of
// its own worth keeping.
@Injectable()
export class SupplierGroupsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<SupplierGroup[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ group: supplierGroups, supplierCount })
        .from(supplierGroups)
        .where(eq(supplierGroups.tenantId, getTenantId()))
        .orderBy(asc(sql`lower(${supplierGroups.name})`));
      return rows.map((row) => toGroup(row.group, row.supplierCount));
    });
  }

  async create(input: SupplierGroupInput): Promise<SupplierGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(supplierGroups)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Supplier group insert returned no row');
        await audit(tx, {
          action: 'supplier_group.created',
          entityType: 'supplier_group',
          entityId: row.id,
          changes: created({ name: row.name }),
        });
        return toGroup(row, 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'supplier_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(
    id: string,
    input: SupplierGroupInput & { version: number },
  ): Promise<SupplierGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await tx
          .update(supplierGroups)
          .set({
            name: input.name,
            version: sql`${supplierGroups.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)));
        await audit(tx, {
          action: 'supplier_group.updated',
          entityType: 'supplier_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: input.name }),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'supplier_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(supplierGroups)
          .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)));
        await audit(tx, {
          action: 'supplier_group.deleted',
          entityType: 'supplier_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: null }),
        });
      });
    } catch (error) {
      // No count first: the FK is the check, and it cannot miss a supplier saved a moment ago
      if (isForeignKeyViolation(error, 'parties_supplier_group_fk')) {
        throw new AppError(
          409,
          'supplier_group_in_use',
          'Suppliers are in this group. Move them to another group first.',
        );
      }
      throw error;
    }
  }

  private async lock(tx: Transaction, id: string): Promise<GroupRow> {
    const [row] = await tx
      .select()
      .from(supplierGroups)
      .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)))
      .for('update');
    if (!row) throw notFound('Supplier group');
    return row;
  }

  private async read(tx: Transaction, id: string): Promise<SupplierGroup> {
    const [row] = await tx
      .select({ group: supplierGroups, supplierCount })
      .from(supplierGroups)
      .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, id)));
    if (!row) throw notFound('Supplier group');
    return toGroup(row.group, row.supplierCount);
  }
}
```

- **Step 15a's customer groups service, for the other table** (decision 23). Read it next to
  `customer-groups.service.ts`: only the names change.
- **`supplierCount` counts archived suppliers too:** they still hold the foreign key that stops a delete, so a count
  without them would show 0 on a group that cannot be deleted.
- **The delete has no count first.** `parties_supplier_group_fk` refuses it while a supplier is in the group, even one
  saved a moment ago, and the API answers `supplier_group_in_use`.

### Suppliers: `purchase/suppliers.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type ErrorCode,
  type Supplier,
  type SupplierInput,
  type SupplierPage,
  type SupplierSort,
  todayIn,
  type UpdateSupplierInput,
} from '@omnivo/contracts';
import {
  journalEntries,
  journalLines,
  ledgerAccounts,
  parties,
  partyAddresses,
  partyBankAccounts,
  supplierGroups,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, eq, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { containsPattern } from '../common/db/search.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { PayableAccess } from './payable-access.js';

type PartyRow = typeof parties.$inferSelect;

// What the company owes a supplier: credit − debit of the posted payable lines that name it (step
// 17a), the customer's balance (step 15a) turned round. A correlated subquery on the parties row,
// run for the rows of one page only. The account filter keeps the receivable lines of a party that
// is also a customer out: what the customer owes is not netted with what is owed to it.
const balance = sql<string>`(
  SELECT round(coalesce(sum(l.credit - l.debit), 0), 4)::text
    FROM ${journalLines} l
    JOIN ${journalEntries} e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
    JOIN ${ledgerAccounts} a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
   WHERE l.tenant_id = parties.tenant_id AND l.party_id = parties.id
     AND e.status = 'posted' AND a.purpose = 'accounts_payable'
)`;

// The list's orders, like the customers'. Each has an index: parties_supplier_name_idx,
// parties_tenant_code_idx, parties_supplier_updated_idx.
const ORDERS = {
  name: { key: sql`lower(${parties.name})`, desc: false },
  '-name': { key: sql`lower(${parties.name})`, desc: true },
  code: { key: sql`lower(${parties.code})`, desc: false },
  '-code': { key: sql`lower(${parties.code})`, desc: true },
  '-updated': { key: sql`${parties.updatedAt}`, desc: true },
} satisfies Record<SupplierSort, { key: SQL; desc: boolean }>;

const cursorSchema = z.tuple([z.string(), z.uuid()]);

// What the audit log shows of a supplier. The bank accounts by their last four digits: enough to
// see which one changed, without copying every account number into the log.
interface Snapshot {
  [field: string]: string | number | null;
  code: string;
  name: string;
  group: string | null;
  phone: string | null;
  bin: string | null;
  paymentTermsDays: number;
  address: string | null;
  bankAccounts: string | null;
}

function codeTaken(): AppError {
  return new AppError(409, 'supplier_code_taken', 'Another customer or supplier uses this code.', {
    fieldErrors: { code: ['supplier_code_taken'] },
  });
}

function supplierInUse(): AppError {
  return new AppError(
    409,
    'supplier_in_use',
    'Entries or purchase documents use this supplier. Archive it instead.',
  );
}

function fieldError(code: ErrorCode, field: string): AppError {
  return new AppError(400, code, 'Check the highlighted fields and try again.', {
    fieldErrors: { [field]: [code] },
  });
}

// Rows that hold on to a supplier-only party, so its delete is refused (supplier_in_use). 17b–17d
// add their documents.
const SUPPLIER_IN_USE = ['journal_lines_party_fk'] as const;

// Suppliers (step 17a): the same parties table as the customers, with is_supplier set. This
// service only reads and writes the supplier's side and the fields both sides share (decision 9);
// the customer's columns are CustomersService's.
@Injectable()
export class SuppliersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly access: PayableAccess,
  ) {}

  async list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    groupId?: string | undefined;
    status: 'active' | 'archived';
    sort: SupplierSort;
  }): Promise<SupplierPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const order = ORDERS[query.sort];
    const canSeeBalance = await this.access.canSee();
    const conditions: (SQL | undefined)[] = [
      eq(parties.tenantId, tenantId),
      eq(parties.isSupplier, true),
      query.status === 'active'
        ? isNull(parties.archivedAt)
        : sql`${parties.archivedAt} IS NOT NULL`,
      query.groupId === undefined ? undefined : eq(parties.supplierGroupId, query.groupId),
    ];
    if (query.search !== undefined && query.search !== '') {
      // The same trigram indexes as the customers' search (migration 0026): they cover the table
      const pattern = containsPattern(query.search);
      conditions.push(sql`(
        lower(${parties.name}) LIKE ${pattern} OR lower(${parties.code}) LIKE ${pattern}
        OR lower(${parties.contactPerson}) LIKE ${pattern} OR ${parties.phone} LIKE ${pattern})`);
    }
    if (after !== undefined) {
      const key = query.sort === '-updated' ? sql`${after[0]}::timestamptz` : sql`${after[0]}`;
      const compare = order.desc ? sql`<` : sql`>`;
      conditions.push(sql`(${order.key}, ${parties.id}) ${compare} (${key}, ${after[1]}::uuid)`);
    }
    const direction = order.desc ? sql`DESC` : sql`ASC`;

    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({
          party: parties,
          balance: canSeeBalance ? balance : sql<null>`NULL`,
          sortKey: sql<string>`${order.key}::text`,
        })
        .from(parties)
        .where(and(...conditions))
        .orderBy(sql`${order.key} ${direction}`, sql`${parties.id} ${direction}`)
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.party.id,
          code: row.party.code,
          name: row.party.name,
          groupId: row.party.supplierGroupId,
          contactPerson: row.party.contactPerson,
          phone: row.party.phone,
          paymentTermsDays: row.party.supplierPaymentTermsDays,
          isCustomer: row.party.isCustomer,
          balance: row.balance,
          archivedAt: row.party.archivedAt?.toISOString() ?? null,
          updatedAt: row.party.updatedAt.toISOString(),
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor([last.sortKey, last.party.id])
            : null,
      };
    });
  }

  async get(id: string): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    return this.withTenant((tx) => this.read(tx, id, canSeeBalance));
  }

  async create(input: SupplierInput): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        await this.checkGroup(tx, input.groupId);
        const code = input.code ?? (await this.newCode(tx));
        if (await this.codeUsed(tx, code, null)) throw codeTaken();
        const [row] = await tx
          .insert(parties)
          .values({
            tenantId: getTenantId(),
            code,
            isSupplier: true,
            ...this.fields(input),
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning({ id: parties.id });
        if (!row) throw new Error('Supplier insert returned no row');
        await this.saveAddress(tx, row.id, input.address);
        await this.saveBankAccounts(tx, row.id, input.bankAccounts);
        const supplier = await this.read(tx, row.id, canSeeBalance);
        await audit(tx, {
          action: 'supplier.created',
          entityType: 'supplier',
          entityId: row.id,
          changes: created(await this.snapshot(tx, supplier)),
        });
        return supplier;
      });
    } catch (error) {
      throw this.mapSaveError(error);
    }
  }

  async update(id: string, input: UpdateSupplierInput): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        // The party row first, FOR UPDATE: two saves of one supplier take turns, so they cannot
        // both add a fifth bank account (decision 24), and a customer save of the same party waits
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await this.checkGroup(tx, input.groupId);
        const old = await this.read(tx, id, canSeeBalance);
        const code = input.code ?? before.code;
        if (await this.codeUsed(tx, code, id)) throw codeTaken();
        await tx
          .update(parties)
          .set({
            code,
            ...this.fields(input),
            version: sql`${parties.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
        await this.saveAddress(tx, id, input.address);
        await this.saveBankAccounts(tx, id, input.bankAccounts);
        const supplier = await this.read(tx, id, canSeeBalance);
        await audit(tx, {
          action: 'supplier.updated',
          entityType: 'supplier',
          entityId: id,
          changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, supplier)),
        });
        return supplier;
      });
    } catch (error) {
      throw this.mapSaveError(error);
    }
  }

  // A customer the company starts buying from (decision 10): the same party, now also a supplier.
  // The supplier's own fields start at their defaults (no group, terms 0, no bank account), which
  // the database kept them at while it was not a supplier (parties_supplier_side_check).
  async fromCustomer(id: string, version: number): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    return this.withTenant(async (tx) => {
      const [before] = await tx
        .select()
        .from(parties)
        .where(
          and(
            eq(parties.tenantId, getTenantId()),
            eq(parties.id, id),
            eq(parties.isCustomer, true),
          ),
        )
        .for('update');
      if (!before) throw notFound('Customer');
      if (before.version !== version) throw versionConflict();
      if (before.isSupplier) {
        throw new AppError(409, 'party_role_exists', 'This customer is already a supplier.');
      }
      await tx
        .update(parties)
        .set({
          isSupplier: true,
          version: sql`${parties.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
      const supplier = await this.read(tx, id, canSeeBalance);
      await audit(tx, {
        action: 'supplier.created',
        entityType: 'supplier',
        entityId: id,
        changes: created(await this.snapshot(tx, supplier)),
      });
      return supplier;
    });
  }

  // Archived = the party (decision 10): one business, hidden from sales and purchase documents
  // alike. Its entries, balance and statement stay.
  async setArchived(id: string, version: number, archived: boolean): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) !== archived) {
        await tx
          .update(parties)
          .set({
            archivedAt: archived ? new Date() : null,
            version: sql`${parties.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
        await audit(tx, {
          action: archived ? 'supplier.archived' : 'supplier.restored',
          entityType: 'supplier',
          entityId: id,
        });
      }
      return this.read(tx, id, canSeeBalance);
    });
  }

  // Only a supplier nothing uses yet. A party that is also a customer stays, as a customer: only
  // its supplier side goes (decision 10), like CustomersService.remove the other way round.
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        if (before.isCustomer) {
          await this.dropSupplierSide(tx, before);
        } else {
          // Its addresses and bank accounts go with it (ON DELETE CASCADE)
          await tx
            .delete(parties)
            .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
        }
        await audit(tx, {
          action: 'supplier.deleted',
          entityType: 'supplier',
          entityId: id,
          changes: diff({ code: before.code, name: before.name }, { code: null, name: null }),
        });
      });
    } catch (error) {
      if (SUPPLIER_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
        throw supplierInUse();
      }
      throw error;
    }
  }

  // The party stays, so no foreign key speaks up: the payable lines that name it are looked for
  // here (17b–17d add their documents). The row is locked FOR UPDATE (lock()), and every posting
  // locks it FOR SHARE first (checkParties), so a line posted at the same moment is either seen
  // here or finds no supplier. The supplier's own columns go back to their defaults in the same
  // UPDATE (parties_supplier_side_check), and its bank accounts go. The billing address is the
  // party's, and the customer keeps it.
  private async dropSupplierSide(tx: Transaction, party: PartyRow): Promise<void> {
    const tenantId = getTenantId();
    const [used] = await tx
      .select({ id: journalLines.id })
      .from(journalLines)
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
          eq(journalLines.partyId, party.id),
          eq(ledgerAccounts.purpose, 'accounts_payable'),
        ),
      )
      .limit(1);
    if (used) throw supplierInUse();
    await tx
      .update(parties)
      .set({
        isSupplier: false,
        supplierGroupId: null,
        supplierPaymentTermsDays: 0,
        version: sql`${parties.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, party.id)));
    await tx
      .delete(partyBankAccounts)
      .where(
        and(eq(partyBankAccounts.tenantId, tenantId), eq(partyBankAccounts.partyId, party.id)),
      );
  }

  // The columns the form sets, the same on create and update. The supplier's own group and terms;
  // the rest is the party's, shared with its customer side.
  private fields(input: SupplierInput) {
    return {
      name: input.name,
      supplierGroupId: input.groupId,
      contactPerson: input.contactPerson,
      phone: input.phone,
      email: input.email,
      documentLanguage: input.documentLanguage,
      bin: input.bin,
      supplierPaymentTermsDays: input.paymentTermsDays,
      notes: input.notes,
    };
  }

  // A code taken while we save, a group deleted while we save: the database's answers, put the
  // way the form shows them
  private mapSaveError(error: unknown): unknown {
    if (isUniqueViolation(error, 'parties_tenant_code_idx')) return codeTaken();
    if (isForeignKeyViolation(error, 'parties_supplier_group_fk')) {
      return fieldError('supplier_group_invalid', 'groupId');
    }
    return error;
  }

  // FOR SHARE: a group being deleted right now waits for us, or we wait for it and find it gone
  private async checkGroup(tx: Transaction, groupId: string | null): Promise<void> {
    if (groupId === null) return;
    const [group] = await tx
      .select({ id: supplierGroups.id })
      .from(supplierGroups)
      .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, groupId)))
      .for('share');
    if (!group) throw fieldError('supplier_group_invalid', 'groupId');
  }

  // Any party's code counts, a customer's too: one code is one party
  private async codeUsed(tx: Transaction, code: string, exceptId: string | null): Promise<boolean> {
    const [row] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, getTenantId()),
          sql`lower(${parties.code}) = ${code.toLowerCase()}`,
          exceptId === null ? undefined : sql`${parties.id} <> ${exceptId}::uuid`,
        ),
      );
    return row !== undefined;
  }

  // The next free code from the 'purchase.supplier' series (S-00042), skipping one typed by hand
  private async newCode(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');
    for (;;) {
      const code = await this.numbering.next(tx, 'purchase.supplier', today);
      if (!(await this.codeUsed(tx, code, null))) return code;
    }
  }

  // The supplier's one address is the party's billing address (decision 9). The text is changed in
  // place, so the label and phone a customer page gave it stay; null removes it, from both sides.
  // The party row is locked, so nobody adds a second billing address meanwhile (and
  // party_addresses_billing_idx would refuse it anyway).
  private async saveAddress(tx: Transaction, partyId: string, address: string | null) {
    const tenantId = getTenantId();
    const billing = and(
      eq(partyAddresses.tenantId, tenantId),
      eq(partyAddresses.partyId, partyId),
      eq(partyAddresses.kind, 'billing'),
    );
    if (address === null) {
      await tx.delete(partyAddresses).where(billing);
      return;
    }
    const [current] = await tx
      .select({ id: partyAddresses.id })
      .from(partyAddresses)
      .where(billing);
    if (current) {
      await tx.update(partyAddresses).set({ address }).where(billing);
    } else {
      await tx
        .insert(partyAddresses)
        .values({ tenantId, partyId, kind: 'billing', position: 0, address });
    }
  }

  // The accounts sent replace the ones the supplier had. One sent back with its id is changed in
  // place, so its id stays (a payment in 17c points at it); an id that is not this supplier's is
  // added as a new account, never moved from another party. position = the form's order.
  private async saveBankAccounts(
    tx: Transaction,
    partyId: string,
    accounts: SupplierInput['bankAccounts'],
  ): Promise<void> {
    const tenantId = getTenantId();
    const ofParty = and(
      eq(partyBankAccounts.tenantId, tenantId),
      eq(partyBankAccounts.partyId, partyId),
    );
    const existing = await tx
      .select({ id: partyBankAccounts.id })
      .from(partyBankAccounts)
      .where(ofParty);
    const own = new Set(existing.map((row) => row.id));
    const rows = accounts.map((account, position) => ({
      id: account.id !== null && own.has(account.id) ? account.id : null,
      fields: {
        position,
        bankName: account.bankName,
        branchName: account.branchName,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        routingNumber: account.routingNumber,
      },
    }));
    const kept = rows.flatMap(({ id, fields }) => (id === null ? [] : [{ id, fields }]));
    await tx.delete(partyBankAccounts).where(
      kept.length === 0
        ? ofParty
        : and(
            ofParty,
            notInArray(
              partyBankAccounts.id,
              kept.map((row) => row.id),
            ),
          ),
    );
    for (const row of kept) {
      await tx
        .update(partyBankAccounts)
        .set(row.fields)
        .where(and(ofParty, eq(partyBankAccounts.id, row.id)));
    }
    const added = rows.flatMap(({ id, fields }) => (id === null ? [fields] : []));
    if (added.length > 0) {
      await tx
        .insert(partyBankAccounts)
        .values(added.map((fields) => ({ tenantId, partyId, ...fields })));
    }
  }

  private async lock(tx: Transaction, id: string): Promise<PartyRow> {
    const [row] = await tx
      .select()
      .from(parties)
      .where(
        and(eq(parties.tenantId, getTenantId()), eq(parties.id, id), eq(parties.isSupplier, true)),
      )
      .for('update');
    if (!row) throw notFound('Supplier');
    return row;
  }

  private async read(tx: Transaction, id: string, canSeeBalance: boolean): Promise<Supplier> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select({ party: parties, balance: canSeeBalance ? balance : sql<null>`NULL` })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, id), eq(parties.isSupplier, true)));
    if (!row) throw notFound('Supplier');
    const { party } = row;
    const [[address], accounts] = await Promise.all([
      tx
        .select({ address: partyAddresses.address })
        .from(partyAddresses)
        .where(
          and(
            eq(partyAddresses.tenantId, tenantId),
            eq(partyAddresses.partyId, id),
            eq(partyAddresses.kind, 'billing'),
          ),
        ),
      tx
        .select()
        .from(partyBankAccounts)
        .where(and(eq(partyBankAccounts.tenantId, tenantId), eq(partyBankAccounts.partyId, id)))
        .orderBy(asc(partyBankAccounts.position), asc(partyBankAccounts.id)),
    ]);
    return {
      id: party.id,
      code: party.code,
      name: party.name,
      groupId: party.supplierGroupId,
      contactPerson: party.contactPerson,
      phone: party.phone,
      email: party.email,
      documentLanguage: party.documentLanguage,
      bin: party.bin,
      paymentTermsDays: party.supplierPaymentTermsDays,
      address: address?.address ?? null,
      bankAccounts: accounts.map((account) => ({
        id: account.id,
        bankName: account.bankName,
        branchName: account.branchName,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        routingNumber: account.routingNumber,
      })),
      notes: party.notes,
      isCustomer: party.isCustomer,
      balance: row.balance,
      archivedAt: party.archivedAt?.toISOString() ?? null,
      version: party.version,
      updatedAt: party.updatedAt.toISOString(),
    };
  }

  private async snapshot(tx: Transaction, supplier: Supplier): Promise<Snapshot> {
    const [group] =
      supplier.groupId === null
        ? []
        : await tx
            .select({ name: supplierGroups.name })
            .from(supplierGroups)
            .where(
              and(
                eq(supplierGroups.tenantId, getTenantId()),
                eq(supplierGroups.id, supplier.groupId),
              ),
            );
    return {
      code: supplier.code,
      name: supplier.name,
      group: group?.name ?? null,
      phone: supplier.phone,
      bin: supplier.bin,
      paymentTermsDays: supplier.paymentTermsDays,
      address: supplier.address,
      bankAccounts:
        supplier.bankAccounts.length === 0
          ? null
          : supplier.bankAccounts
              .map((account) => `${account.bankName} …${account.accountNumber.slice(-4)}`)
              .join(', '),
    };
  }
}
```

This is step 15a's customers service for the supplier's side, with bank accounts instead of a list of addresses. The
parts that differ:

- **`balance` is credit − debit of the payable lines,** the customer's turned round: positive while the company owes
  the supplier, which is what the list shows. It is a subquery on the parties row, worked out only for the rows of
  the page, and not at all without `purchase.supplier.balance` (`sql<null>\`NULL\``): hidden data is not read.
- **The account filter (`a.purpose = 'accounts_payable'`)** keeps a party's receivable lines out. A distributor that
  owes ৳1,15,000 as a customer and is owed ৳40,000 as a supplier shows ৳40,000 here, not a netted number.
- **`SUPPLIER_IN_USE` has only `journal_lines_party_fk` now.** A requisition names no supplier. 17b–17d add their
  documents' foreign keys, as each sales step added its own to `CUSTOMER_IN_USE`.
- **`list()` filters `is_supplier`,** and the name and "last changed" orders use the partial indexes of 17a.2
  (`parties_supplier_name_idx`, `parties_supplier_updated_idx`), which hold supplier rows only: a workspace with
  20,000 customers and 300 suppliers walks 300 rows. The search uses the trigram indexes of step 15a, which cover the
  whole table.
- **`fields()` writes the supplier's own group and terms** (`supplier_group_id`, `supplier_payment_terms_days`) and
  the party's shared fields. It never touches the customer's columns: a supplier save cannot change a customer's
  credit limit.
- **`update()` locks the party row first** (decision 24). Two saves of one supplier take turns, so they cannot both
  add a fifth bank account; a save on the customer page of the same party waits too, so neither overwrites the
  shared name with an old one (the version check then catches the second).
- **`mapSaveError()`** turns the database's answers into the form's: a code taken by a save at the same moment
  (`parties_tenant_code_idx`), and a group deleted between `checkGroup()` and the insert (`parties_supplier_group_fk`).
  `checkGroup()` already locks the group `FOR SHARE`, so the second one is rare; the mapping keeps it a 409 and not a
  500.
- **`codeUsed()` checks every party's code,** a customer's too: one code is one party (decision 9). An `S-` code typed
  by hand that a customer already has is `supplier_code_taken`.
- **`newCode()` takes the next number of `purchase.supplier`** (17a.1), skipping a code someone typed by hand, like the
  customers' `C-` series.
- **`saveAddress()` keeps the party's billing address in step with the one text box** (decision 31). It changes only
  `address`, so a label and phone set on the customer page stay. A new address gets position 0: a party has one
  billing address (`party_addresses_billing_idx`), so its position orders nothing.
- **`saveBankAccounts()`** works like the customers' `saveAddresses()`: an account sent back with its own id is changed
  in place, so its id stays for 17c's payments; an id that belongs to another party is treated as new, never moved.
  The order is simpler than the addresses': no unique index on `position`, so delete, update, insert is enough.
- **`fromCustomer()` is "Make supplier too":** the mirror of the customer's `fromSupplier()`. Its path is under
  `/customers`, but it answers a supplier and needs `purchase.supplier.manage`.
- **`setArchived()` archives the party** (decision 10): one business, hidden from both sides. Its balance and
  statement stay.
- **`remove()` and `dropSupplierSide()`** mirror the customer's: a supplier-only party is deleted (its addresses and
  bank accounts go by `ON DELETE CASCADE`), a party that is both loses its supplier side. The check is one query for a
  payable line that names the party; the `UPDATE` clears the supplier's columns with the flag
  (`parties_supplier_side_check`), and the bank accounts are deleted.
- **`snapshot()` shows the bank accounts as "Bank …last four"** (decision 34), joined in one string, so a changed
  account is one changed field in the audit log.

### The controllers: `purchase/suppliers.controller.ts` (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { LedgerService } from '../journal/ledger.service.js';
import { SupplierGroupsService } from './supplier-groups.service.js';
import { SuppliersService } from './suppliers.service.js';

type Routes = typeof routes.suppliers;
type GroupRoutes = typeof routes.supplierGroups;

@Controller()
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly ledgers: LedgerService,
  ) {}

  @Endpoint(routes.suppliers.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.suppliers.list(query);
  }

  @Endpoint(routes.suppliers.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.suppliers.get(params.id);
  }

  @Endpoint(routes.suppliers.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.suppliers.create(body);
  }

  @Endpoint(routes.suppliers.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.suppliers.update(params.id, body);
  }

  // "Make supplier too" on a customer's page. Its path is under /customers, its answer a supplier.
  @Endpoint(routes.suppliers.fromCustomer)
  fromCustomer({
    params,
    body,
  }: RouteInput<Routes['fromCustomer']>): Promise<RouteResponse<Routes['fromCustomer']>> {
    return this.suppliers.fromCustomer(params.id, body.version);
  }

  @Endpoint(routes.suppliers.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.suppliers.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.suppliers.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.suppliers.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.suppliers.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.suppliers.remove(params.id, query.version);
  }

  // The route itself needs purchase.supplier.balance (the contract's `permission`)
  @Endpoint(routes.suppliers.statement)
  statement({
    params,
    query,
  }: RouteInput<Routes['statement']>): Promise<RouteResponse<Routes['statement']>> {
    return this.ledgers.statement(params.id, query, 'supplier');
  }
}

@Controller()
export class SupplierGroupsController {
  constructor(private readonly groups: SupplierGroupsService) {}

  @Endpoint(routes.supplierGroups.list)
  async list(): Promise<RouteResponse<GroupRoutes['list']>> {
    return { items: await this.groups.list() };
  }

  @Endpoint(routes.supplierGroups.create)
  create({
    body,
  }: RouteInput<GroupRoutes['create']>): Promise<RouteResponse<GroupRoutes['create']>> {
    return this.groups.create(body);
  }

  @Endpoint(routes.supplierGroups.update)
  update({
    params,
    body,
  }: RouteInput<GroupRoutes['update']>): Promise<RouteResponse<GroupRoutes['update']>> {
    return this.groups.update(params.id, body);
  }

  @Endpoint(routes.supplierGroups.remove)
  remove({ params, query }: RouteInput<GroupRoutes['remove']>): Promise<void> {
    return this.groups.remove(params.id, query.version);
  }
}
```

- **The statement calls `LedgerService.statement(…, 'supplier')`.** The route needs `purchase.supplier.balance` in the
  contract, so the guard refuses it before any query runs.
- Each method only moves the route's parts into the service, like every controller in the API: the rules live in
  the services, where the tests reach them.

### What each kind of document gives the engine: `purchase/approval-documents.ts` (new)

```ts
import type { ApprovalDocument, AuditEntityType } from '@omnivo/contracts';
import { requisitions, warehouses } from '@omnivo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What the approvals engine needs from each kind of document, so one engine serves them all
// (decision 16). The engine never writes a document's own columns except its status, and only
// through setStatus(). 17b adds the purchase order here, 17c the bill and the payment; the
// `satisfies` below does not compile until every kind in APPROVAL_DOCUMENTS has its entry.

// The statuses the engine moves a document between. Every kind has these three, whatever it calls
// its others (a requisition's cancelled, an order's received).
export type ApprovalStatus = 'draft' | 'pending' | 'approved';

// A document as the waiting list and the bell show it
export interface ApprovalSubject {
  number: string;
  date: string;
  // The warehouse of a requisition, the supplier of an order
  subject: string;
}

export interface ApprovalTarget {
  entityType: AuditEntityType;
  // FOR UPDATE: the document first, then its round. Every path that changes a round (submit,
  // reopen, approve, reject) locks in this order, so two of them never deadlock.
  lock(tx: Transaction, id: string): Promise<{ status: string } | null>;
  setStatus(tx: Transaction, id: string, status: ApprovalStatus): Promise<void>;
  describe(tx: Transaction, ids: readonly string[]): Promise<Map<string, ApprovalSubject>>;
}

const requisition: ApprovalTarget = {
  entityType: 'requisition',
  async lock(tx, id) {
    const [row] = await tx
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)))
      .for('update');
    return row ?? null;
  },
  // A status change is a change of the document: its version moves, so a page opened before an
  // approval cannot then save or reopen it from what it showed
  async setStatus(tx, id, status) {
    await tx
      .update(requisitions)
      .set({
        status,
        version: sql`${requisitions.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
  },
  async describe(tx, ids) {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: requisitions.id,
        number: requisitions.number,
        date: requisitions.date,
        subject: warehouses.name,
      })
      .from(requisitions)
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, requisitions.tenantId),
          eq(warehouses.id, requisitions.warehouseId),
        ),
      )
      .where(and(eq(requisitions.tenantId, getTenantId()), inArray(requisitions.id, [...ids])));
    return new Map(rows.map(({ id, ...row }) => [id, row]));
  },
};

export const APPROVAL_TARGETS = { requisition } satisfies Record<ApprovalDocument, ApprovalTarget>;
```

- **`ApprovalTarget` is the whole contract between the engine and a document** (decision 30): lock it, set its
  status, and describe it for the waiting list and the bell. The engine never writes any other column of a document.
- **`ApprovalStatus` is `draft | pending | approved`.** Every kind has these three, whatever its other statuses (a
  requisition's `cancelled`). The engine cannot cancel anything.
- **`setStatus()` moves the version.** A page opened before an approval holds the old version, so it cannot save,
  reopen or cancel the document as it was; it reloads and sees the new status.
- **`describe()` takes many ids at once,** for a page of the waiting list. An empty list returns at once, without a
  query that could only find nothing.
- **`satisfies Record<ApprovalDocument, ApprovalTarget>`:** when 17b adds `purchase_order` to `APPROVAL_DOCUMENTS`,
  this file does not compile until the order has its entry.

### The approvals engine: `purchase/approvals.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  APPROVAL_DOCUMENTS,
  type ApprovalDecision,
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalRule,
  type ApprovalRuleInput,
  type ApprovalRuleList,
  type DocumentApproval,
  levelsFor,
  type NotificationType,
  type WaitingApprovalPage,
} from '@omnivo/contracts';
import {
  approvalLevels,
  approvalRounds,
  approvalRules,
  approvalSteps,
  membershipRoles,
  memberships,
  roles,
  users,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import {
  APPROVAL_TARGETS,
  type ApprovalStatus,
  type ApprovalSubject,
} from './approval-documents.js';

type RoundRow = typeof approvalRounds.$inferSelect;
type StepRow = typeof approvalSteps.$inferSelect;

const decider = alias(users, 'decider');

// The waiting list's position: when the round was submitted (as text: a Date would round the
// microseconds away), then its id
const cursorSchema = z.tuple([z.string(), z.uuid()]);

// The step a round waits for: undecided, with no undecided step before it (contracts'
// waitingStep(), in SQL). By the table's name: inside the subquery a bare column would be its own.
const isWaitingStep = sql`${approvalSteps.decision} IS NULL AND NOT EXISTS (
  SELECT 1 FROM approval_steps earlier
   WHERE earlier.tenant_id = approval_steps.tenant_id AND earlier.round_id = approval_steps.round_id
     AND earlier.decision IS NULL AND earlier.position < approval_steps.position)`;

const stepCount = sql<number>`(
  SELECT count(*)::int FROM approval_steps every
   WHERE every.tenant_id = approval_rounds.tenant_id AND every.round_id = approval_rounds.id
)`;

// The roles of the person asking, read in the transaction and not from the permission cache: who
// may decide is checked against what the person holds now, not ten minutes ago
interface MyRoles {
  roleIds: Set<string>;
  owner: boolean;
}

// What a level reads like in the audit log: "Purchase manager from 50000.0000"
function describeLevels(levels: ApprovalRule['levels']): string | null {
  if (levels.length === 0) return null;
  return levels.map((level) => `${level.role.name} from ${level.minAmount}`).join('; ');
}

function notPending(): AppError {
  return new AppError(
    409,
    'approval_not_pending',
    'This document is no longer waiting for this approval. Reload it to see where it is now.',
  );
}

// The approvals engine (step 17a). One service for every kind of document (decision 16): the
// rules in Settings, the rounds and steps of each document, the waiting list and the bell. A
// document's own service calls submit(), reopen() and history() inside its transaction; the
// decisions come straight from the /approvals routes.
@Injectable()
export class ApprovalsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // ---------------------------------------------------------------------------------------------
  // The rules

  listRules(): Promise<ApprovalRuleList> {
    return this.withTenant(async (tx) => {
      const items: ApprovalRule[] = [];
      for (const document of APPROVAL_DOCUMENTS) items.push(await this.readRule(tx, document));
      return { items };
    });
  }

  // The levels sent replace the ones the kind had. Documents already waiting keep the levels they
  // were submitted with (decision 13): their steps are copies.
  async saveRule(document: ApprovalDocument, input: ApprovalRuleInput): Promise<ApprovalRule> {
    try {
      return await this.withTenant(async (tx) => {
        const tenantId = getTenantId();
        const userId = currentPrincipal().userId;
        // FOR UPDATE: two people saving the levels take turns. No row yet = version 0, and two
        // first saves at once both insert: the unique index refuses the second (caught below).
        const [rule] = await tx
          .select()
          .from(approvalRules)
          .where(and(eq(approvalRules.tenantId, tenantId), eq(approvalRules.document, document)))
          .for('update');
        if ((rule?.version ?? 0) !== input.version) throw versionConflict();
        await this.checkRoles(tx, input.levels);
        const before = await this.readRule(tx, document);

        let ruleId: string;
        if (rule) {
          ruleId = rule.id;
          await tx
            .update(approvalRules)
            .set({ version: sql`${approvalRules.version} + 1`, updatedBy: userId })
            .where(and(eq(approvalRules.tenantId, tenantId), eq(approvalRules.id, rule.id)));
          await tx
            .delete(approvalLevels)
            .where(and(eq(approvalLevels.tenantId, tenantId), eq(approvalLevels.ruleId, rule.id)));
        } else {
          const [row] = await tx
            .insert(approvalRules)
            .values({ tenantId, document, createdBy: userId, updatedBy: userId })
            .returning({ id: approvalRules.id });
          if (!row) throw new Error('Approval rule insert returned no row');
          ruleId = row.id;
        }
        if (input.levels.length > 0) {
          await tx.insert(approvalLevels).values(
            input.levels.map((level, index) => ({
              tenantId,
              ruleId,
              position: index + 1,
              minAmount: level.minAmount,
              roleId: level.roleId,
            })),
          );
        }

        const after = await this.readRule(tx, document);
        await audit(tx, {
          action: 'approval_rules.changed',
          entityType: 'workspace',
          entityId: tenantId,
          changes: diff(
            { [document]: describeLevels(before.levels) },
            { [document]: describeLevels(after.levels) },
          ),
        });
        return after;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'approval_rules_tenant_document_idx')) throw versionConflict();
      // A role deleted between the check and the insert
      if (isForeignKeyViolation(error, 'approval_levels_role_fk')) {
        throw new AppError(409, 'approval_role_invalid', 'One of the roles was just deleted.');
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // A document's rounds: called by the document's service, inside its transaction, after it
  // locked the document (APPROVAL_TARGETS' lock order)

  // A new round with the levels the amount reaches (decision 13). It is approved at once when no
  // level applies, or when an Owner submits (decision 14): the Owner's steps are written already
  // approved, by the Owner, so the history says so. The document always passes through pending,
  // even then (decision 26). Returns the status the document ends in.
  async submit(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
    amount: string,
  ): Promise<ApprovalStatus> {
    const tenantId = getTenantId();
    const me = currentPrincipal().userId;
    const target = APPROVAL_TARGETS[document];
    const levels = levelsFor(await this.levelRows(tx, document), amount);
    const { owner } = await this.myRoles(tx);
    const now = new Date();

    const [round] = await tx
      .insert(approvalRounds)
      .values({ tenantId, document, documentId: id, amount, submittedBy: me })
      .returning();
    if (!round) throw new Error('Approval round insert returned no row');
    const steps =
      levels.length === 0
        ? []
        : await tx
            .insert(approvalSteps)
            .values(
              levels.map((level, index) => ({
                tenantId,
                roundId: round.id,
                position: index + 1,
                minAmount: level.minAmount,
                roleId: level.roleId,
                roleName: level.roleName,
                ...(owner ? { decision: 'approved' as const, decidedBy: me, decidedAt: now } : {}),
              })),
            )
            .returning();
    await target.setStatus(tx, id, 'pending');

    const approved = owner || steps.length === 0;
    if (approved) {
      await this.close(tx, round.id, 'approved', now);
      await target.setStatus(tx, id, 'approved');
    } else {
      const [first] = steps;
      if (first) await this.ring(tx, document, id, first, 'approval.requested', round);
    }
    await audit(tx, {
      action: 'approval.submitted',
      entityType: target.entityType,
      entityId: id,
      changes: created({ amount, steps: steps.length, status: approved ? 'approved' : 'pending' }),
    });
    return approved ? 'approved' : 'pending';
  }

  // Back to draft. A pending round ends as reopened; an approved one stays approved (it was), and
  // the next submit starts a new round from the first level (decision 6).
  async reopen(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
    from: 'pending' | 'approved',
  ): Promise<void> {
    const target = APPROVAL_TARGETS[document];
    if (from === 'pending') {
      const round = await this.pendingRound(tx, document, id);
      if (round) await this.close(tx, round.id, 'reopened', new Date());
    }
    await target.setStatus(tx, id, 'draft');
    await audit(tx, {
      action: 'approval.reopened',
      entityType: target.entityType,
      entityId: id,
      changes: diff({ status: from }, { status: 'draft' }),
    });
  }

  // Every round of a document, newest first, and whether the reader may decide the waiting step
  async history(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
  ): Promise<DocumentApproval> {
    const tenantId = getTenantId();
    const roundRows = await tx
      .select({ round: approvalRounds, submittedByName: users.fullName })
      .from(approvalRounds)
      .innerJoin(users, eq(users.id, approvalRounds.submittedBy))
      .where(
        and(
          eq(approvalRounds.tenantId, tenantId),
          eq(approvalRounds.document, document),
          eq(approvalRounds.documentId, id),
        ),
      )
      .orderBy(desc(approvalRounds.submittedAt), desc(approvalRounds.id));
    const roundIds = roundRows.map((row) => row.round.id);
    const stepRows =
      roundIds.length === 0
        ? []
        : await tx
            .select({ step: approvalSteps, decidedByName: decider.fullName })
            .from(approvalSteps)
            .leftJoin(decider, eq(decider.id, approvalSteps.decidedBy))
            .where(
              and(eq(approvalSteps.tenantId, tenantId), inArray(approvalSteps.roundId, roundIds)),
            )
            .orderBy(asc(approvalSteps.position));

    const rounds: ApprovalRound[] = roundRows.map(({ round, submittedByName }) => ({
      id: round.id,
      status: round.status,
      amount: round.amount,
      submittedBy: { id: round.submittedBy, name: submittedByName },
      submittedAt: round.submittedAt.toISOString(),
      closedAt: round.closedAt?.toISOString() ?? null,
      steps: stepRows
        .filter(({ step }) => step.roundId === round.id)
        .map(({ step, decidedByName }) => ({
          position: step.position,
          minAmount: step.minAmount,
          role: { id: step.roleId, name: step.roleName },
          decision: step.decision,
          decidedBy:
            step.decidedBy !== null && decidedByName !== null
              ? { id: step.decidedBy, name: decidedByName }
              : null,
          decidedAt: step.decidedAt?.toISOString() ?? null,
          comment: step.comment,
        })),
    }));

    const [newest] = rounds;
    const waiting =
      newest?.status === 'pending'
        ? newest.steps.find((step) => step.decision === null)
        : undefined;
    const canDecide =
      newest !== undefined &&
      waiting !== undefined &&
      this.mayDecide(await this.myRoles(tx), newest.submittedBy.id, waiting.role.id);
    return { rounds, canDecide };
  }

  // ---------------------------------------------------------------------------------------------
  // Deciding (the /approvals routes)

  // Approve or reject the step a document waits for. roundId is the round the page showed
  // (decision 16): if the document was reopened or decided since, the answer is
  // approval_not_pending and nothing changes.
  decide(
    document: ApprovalDocument,
    id: string,
    decision: ApprovalDecision,
    input: { roundId: string; comment: string | null },
  ): Promise<void> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const me = currentPrincipal().userId;
      const target = APPROVAL_TARGETS[document];
      // The document first, then the round: the same order as submit and reopen
      if (!(await target.lock(tx, id))) throw notFound('Document');
      const [round] = await tx
        .select()
        .from(approvalRounds)
        .where(
          and(
            eq(approvalRounds.tenantId, tenantId),
            eq(approvalRounds.id, input.roundId),
            eq(approvalRounds.document, document),
            eq(approvalRounds.documentId, id),
          ),
        )
        .for('update');
      if (round?.status !== 'pending') throw notPending();
      const steps = await tx
        .select()
        .from(approvalSteps)
        .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.roundId, round.id)))
        .orderBy(asc(approvalSteps.position));
      const step = steps.find((row) => row.decision === null);
      // A pending round always has an undecided step; a round with none was closed at submit
      if (!step) throw notPending();

      const mine = await this.myRoles(tx);
      if (!mine.owner && round.submittedBy === me) {
        throw new AppError(
          403,
          'approval_own_document',
          'You submitted this document, so someone else approves it.',
        );
      }
      if (!this.mayDecide(mine, round.submittedBy, step.roleId)) {
        throw new AppError(
          403,
          'approval_not_allowed',
          `This step needs the ${step.roleName} role, or an Owner.`,
        );
      }

      const now = new Date();
      await tx
        .update(approvalSteps)
        .set({ decision, decidedBy: me, decidedAt: now, comment: input.comment })
        .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.id, step.id)));
      await audit(tx, {
        action: decision === 'approved' ? 'approval.approved' : 'approval.rejected',
        entityType: target.entityType,
        entityId: id,
        changes: created({
          step: `${String(step.position)} of ${String(steps.length)}`,
          role: step.roleName,
          comment: input.comment,
        }),
      });

      const next = steps.find((row) => row.position > step.position && row.decision === null);
      if (decision === 'rejected') {
        // The steps after it stay undecided; the round's status says why (decision 15)
        await this.close(tx, round.id, 'rejected', now);
        await target.setStatus(tx, id, 'draft');
        await this.ring(tx, document, id, step, 'approval.rejected', round);
      } else if (next) {
        // A step in the middle rings only the next level (decision 18)
        await this.ring(tx, document, id, next, 'approval.requested', round);
      } else {
        await this.close(tx, round.id, 'approved', now);
        await target.setStatus(tx, id, 'approved');
        await this.ring(tx, document, id, step, 'approval.approved', round);
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Waiting for me (decision 17)

  // The documents whose waiting step the reader may decide, oldest first: the longest wait on top
  waiting(query: { limit: number; cursor?: string | undefined }): Promise<WaitingApprovalPage> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const mine = await this.myRoles(tx);
      const condition = this.waitingFor(mine);
      if (condition === null) return { items: [], nextCursor: null };
      const rows = await tx
        .select({
          round: approvalRounds,
          position: approvalSteps.position,
          stepCount,
          submittedByName: users.fullName,
          sortKey: sql<string>`${approvalRounds.submittedAt}::text`,
        })
        .from(approvalRounds)
        .innerJoin(
          approvalSteps,
          and(
            eq(approvalSteps.tenantId, approvalRounds.tenantId),
            eq(approvalSteps.roundId, approvalRounds.id),
            isWaitingStep,
          ),
        )
        .innerJoin(users, eq(users.id, approvalRounds.submittedBy))
        .where(
          and(
            eq(approvalRounds.tenantId, getTenantId()),
            eq(approvalRounds.status, 'pending'),
            condition,
            after === undefined
              ? undefined
              : sql`(${approvalRounds.submittedAt}, ${approvalRounds.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(asc(approvalRounds.submittedAt), asc(approvalRounds.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.sortKey, last.round.id]);

      // Each kind's number, date and subject: one query per kind on this page
      const idsOf = new Map<ApprovalDocument, string[]>();
      for (const { round } of page.items) {
        idsOf.set(round.document, [...(idsOf.get(round.document) ?? []), round.documentId]);
      }
      const subjects = new Map<string, ApprovalSubject>();
      for (const [document, ids] of idsOf) {
        const found = await APPROVAL_TARGETS[document].describe(tx, ids);
        for (const [id, subject] of found) subjects.set(`${document}:${id}`, subject);
      }
      return {
        items: page.items.flatMap(({ round, position, stepCount: count, submittedByName }) => {
          const subject = subjects.get(`${round.document}:${round.documentId}`);
          if (!subject) return [];
          return [
            {
              document: round.document,
              id: round.documentId,
              ...subject,
              amount: round.amount,
              submittedBy: { id: round.submittedBy, name: submittedByName },
              submittedAt: round.submittedAt.toISOString(),
              roundId: round.id,
              position,
              stepCount: count,
            },
          ];
        }),
        nextCursor: page.nextCursor,
      };
    });
  }

  waitingCount(): Promise<{ count: number }> {
    return this.withTenant(async (tx) => {
      const condition = this.waitingFor(await this.myRoles(tx));
      if (condition === null) return { count: 0 };
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(approvalRounds)
        .innerJoin(
          approvalSteps,
          and(
            eq(approvalSteps.tenantId, approvalRounds.tenantId),
            eq(approvalSteps.roundId, approvalRounds.id),
            isWaitingStep,
          ),
        )
        .where(
          and(
            eq(approvalRounds.tenantId, getTenantId()),
            eq(approvalRounds.status, 'pending'),
            condition,
          ),
        );
      return { count: row?.count ?? 0 };
    });
  }

  // ---------------------------------------------------------------------------------------------

  // An Owner may decide any step (decision 5), even of a document they submitted as someone else
  // before becoming Owner. Anyone else needs the step's role, and not their own document
  // (decision 14). A step whose role was deleted (null) is left to an Owner.
  private mayDecide(mine: MyRoles, submittedBy: string, roleId: string | null): boolean {
    if (mine.owner) return true;
    return roleId !== null && mine.roleIds.has(roleId) && submittedBy !== currentPrincipal().userId;
  }

  // mayDecide() as a condition on the waiting step; null = nothing can match (no roles at all)
  private waitingFor(mine: MyRoles): SQL | undefined | null {
    if (mine.owner) return undefined;
    if (mine.roleIds.size === 0) return null;
    return and(
      inArray(approvalSteps.roleId, [...mine.roleIds]),
      ne(approvalRounds.submittedBy, currentPrincipal().userId),
    );
  }

  private async myRoles(tx: Transaction): Promise<MyRoles> {
    const rows = await tx
      .select({ id: roles.id, kind: roles.kind })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
      )
      .where(
        and(
          eq(membershipRoles.tenantId, getTenantId()),
          eq(membershipRoles.membershipId, currentPrincipal().membershipId),
        ),
      );
    return {
      roleIds: new Set(rows.map((row) => row.id)),
      owner: rows.some((row) => row.kind === 'owner'),
    };
  }

  // The bell (decision 18). approval.requested goes to the people who hold the step's role; when
  // nobody does (or the role was deleted), to the Owners, who may decide any level, so a document
  // never waits without anyone knowing. approved / rejected go to the person who submitted it.
  // Nobody is told about what they did themselves. The event id makes each one once per person:
  // the step for a request, the round for its end.
  private async ring(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
    step: StepRow,
    type: NotificationType,
    round: RoundRow,
  ): Promise<void> {
    const me = currentPrincipal().userId;
    const recipients =
      type === 'approval.requested' ? await this.approversOf(tx, step.roleId) : [round.submittedBy];
    const subject = (await APPROVAL_TARGETS[document].describe(tx, [id])).get(id);
    if (!subject) return;
    for (const userId of new Set(recipients)) {
      if (userId === me || (type === 'approval.requested' && userId === round.submittedBy)) {
        continue;
      }
      await notify(tx, {
        userId,
        type,
        params: { document, id, number: subject.number },
        eventId: type === 'approval.requested' ? step.id : round.id,
      });
    }
  }

  private async approversOf(tx: Transaction, roleId: string | null): Promise<string[]> {
    const tenantId = getTenantId();
    const holders = (role: SQL) =>
      tx
        .selectDistinct({ userId: memberships.userId })
        .from(membershipRoles)
        .innerJoin(
          memberships,
          and(
            eq(memberships.tenantId, membershipRoles.tenantId),
            eq(memberships.id, membershipRoles.membershipId),
          ),
        )
        .innerJoin(
          roles,
          and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
        )
        .where(and(eq(membershipRoles.tenantId, tenantId), isNull(memberships.deletedAt), role));
    const found = roleId === null ? [] : await holders(eq(roles.id, roleId));
    const people = found.length > 0 ? found : await holders(eq(roles.kind, 'owner'));
    return people.map((row) => row.userId);
  }

  private async close(
    tx: Transaction,
    roundId: string,
    status: 'approved' | 'rejected' | 'reopened',
    at: Date,
  ): Promise<void> {
    await tx
      .update(approvalRounds)
      .set({ status, closedAt: at })
      .where(and(eq(approvalRounds.tenantId, getTenantId()), eq(approvalRounds.id, roundId)));
  }

  private async pendingRound(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
  ): Promise<RoundRow | undefined> {
    const [round] = await tx
      .select()
      .from(approvalRounds)
      .where(
        and(
          eq(approvalRounds.tenantId, getTenantId()),
          eq(approvalRounds.document, document),
          eq(approvalRounds.documentId, id),
          eq(approvalRounds.status, 'pending'),
        ),
      )
      .for('update');
    return round;
  }

  // The levels of a kind with their roles' names now: what a new round copies
  private levelRows(tx: Transaction, document: ApprovalDocument) {
    return tx
      .select({
        minAmount: approvalLevels.minAmount,
        roleId: approvalLevels.roleId,
        roleName: roles.name,
      })
      .from(approvalLevels)
      .innerJoin(
        approvalRules,
        and(
          eq(approvalRules.tenantId, approvalLevels.tenantId),
          eq(approvalRules.id, approvalLevels.ruleId),
        ),
      )
      .innerJoin(
        roles,
        and(eq(roles.tenantId, approvalLevels.tenantId), eq(roles.id, approvalLevels.roleId)),
      )
      .where(and(eq(approvalLevels.tenantId, getTenantId()), eq(approvalRules.document, document)))
      .orderBy(asc(approvalLevels.position));
  }

  private async readRule(tx: Transaction, document: ApprovalDocument): Promise<ApprovalRule> {
    const [rule] = await tx
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.tenantId, getTenantId()), eq(approvalRules.document, document)));
    if (!rule) return { document, levels: [], version: 0, updatedAt: null };
    const levels = await this.levelRows(tx, document);
    return {
      document,
      levels: levels.map((level) => ({
        minAmount: level.minAmount,
        role: { id: level.roleId, name: level.roleName },
      })),
      version: rule.version,
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  // Every role must be one of this workspace's, each error under its own row
  private async checkRoles(tx: Transaction, levels: ApprovalRuleInput['levels']): Promise<void> {
    const ids = [...new Set(levels.map((level) => level.roleId))];
    const found =
      ids.length === 0
        ? []
        : await tx
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.tenantId, getTenantId()), inArray(roles.id, ids)));
    const known = new Set(found.map((row) => row.id));
    const invalid = levels.flatMap((level, index) => (known.has(level.roleId) ? [] : [index]));
    if (invalid.length > 0) {
      throw new AppError(409, 'approval_role_invalid', 'Pick a role of this workspace.', {
        fieldErrors: Object.fromEntries(
          invalid.map((index) => [`levels.${String(index)}.roleId`, ['approval_role_invalid']]),
        ),
      });
    }
  }
}
```

The rules first:

- **`saveRule()` locks the rule row `FOR UPDATE`** and compares versions; no row means version 0. Two first saves at
  once both find no row and both insert: the unique index `approval_rules_tenant_document_idx` refuses the second,
  and the API answers `version_conflict`, as if the row had been there.
- **The levels are replaced, not merged.** Delete all, insert positions 1 to n. The page sends the whole list in its
  order, and a level has no identity of its own worth keeping: documents already waiting have copies (decision 13).
- **`checkRoles()`** answers under each row that names an unknown role (`levels.2.roleId`). The contract has already
  refused a role twice and amounts out of order. A role deleted between this check and the insert is caught by
  `approval_levels_role_fk`.
- **The audit row** shows the levels before and after as one line each ("Purchase manager from 50000.0000; Owner from
  500000.0000"), under the document's kind, so one row says what the rule was and what it became.

A document's rounds, called by its own service inside its transaction:

- **`submit()` copies the levels the amount reaches** (`levelsFor()`, the same function the form uses) with the role's
  name at that moment (`role_name`, decision 25).
- **An Owner's own document is approved at once** (decision 14): its steps are inserted already approved, by the
  Owner, at the same moment. The history then says plainly "approved by the Owner when submitted". The database
  allows this because it checks the order of decisions only on `UPDATE` (17a.2, section 5).
- **The document always goes through pending** (decision 26): `setStatus('pending')`, then, when it is approved at
  once, the round is closed and `setStatus('approved')`. A requisition's guard refuses `draft → approved`.
- **The order of statements matters:** the round is inserted before the document becomes pending, and closed before
  it becomes approved, because the requisition's guard looks at its newest round when its status changes.
- **The bell rings only when someone has to act:** the first step's people (decision 28). A document approved at once
  rings nobody; the person who submitted it sees the result on the page.
- **`reopen()` closes a pending round as `reopened`;** an approved round stays approved, because it was. The next
  `submit()` starts a new round from the first level (decision 6).
- **`history()`** reads every round of the document, newest first, with its steps and the names of who submitted and
  who decided (a second join to `users` under the alias `decider`). `canDecide` uses the same rule as `decide()`
  (`mayDecide()`), so the page shows the Approve button exactly when the server would accept it.

Deciding:

- **`decide()` locks the document, then the round** (decision 30): the same order as `submit()` and `reopen()`, which
  are called after the document's service locked the document. Two different orders could deadlock.
- **The round must be the one the page showed, and still pending** (decision 16). A round of another document (a
  `roundId` copied from another page) is not found, which gives the same `approval_not_pending`.
- **The waiting step is the first undecided one.** A pending round always has one; a round without steps was closed
  at submit.
- **Own document first, then the role.** `approval_own_document` tells the person why exactly; an Owner passes both.
  A step whose role was deleted (`roleId` null) can only be decided by an Owner.
- **One `now` for the step and the round,** so a last approval and the round's end show the same time.
- **Rejected:** the round is closed as rejected, the document goes back to draft, and the person who submitted it is
  told. The steps after it stay undecided (decision 15).
- **Approved with a step after it:** only the next step's people are told (decision 18). The document does not
  change, so its version does not move.
- **Approved, last step:** the round is approved, then the document, and the person who submitted it is told.

The waiting list and the bell:

- **`isWaitingStep`** is the contract's `waitingStep()` in SQL: an undecided step with no undecided step before it.
  It is a join condition, so each pending round joins exactly its one waiting step.
- **`waitingFor()`** is `mayDecide()` as a condition: nothing for an Owner (every waiting step), the person's roles and
  not their own documents for anyone else, and `null` (an empty page without a query) for someone with no roles.
  `inArray()` with an empty list would be a query that can only return nothing.
- **Oldest first,** with a cursor on `submitted_at` as text: a `Date` keeps milliseconds, Postgres keeps
  microseconds, and a cursor a few microseconds off skips or repeats a row.
- **`describe()` runs once per kind on the page,** grouped by kind, so a page of 50 costs one query per kind instead
  of 50.
- **`waitingCount()`** is the same join and conditions without the page: the navigation's number (decision 17).
- **`myRoles()` reads the roles in the transaction** (decision 29), from `membership_roles` of the signed-in
  membership. `Access.roles` holds names, and names can repeat across time; the ids are what a step stores.
- **`ring()` sends one notification per person,** never to the person acting, and never asks the person who
  submitted to approve their own document. The event id is the step for a request and the round for its end, so a
  repeated call cannot ring twice (`notify()`'s `ON CONFLICT DO NOTHING`).
- **`approversOf()`** finds the role's members whose membership is not removed; when there are none, the Owners
  (decision 28).

### The item on a purchase line: `purchase/purchase-lines.ts` (new)

```ts
import {
  defaultLineDescription,
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  toBaseQuantity,
} from '@omnivo/contracts';
import { warehouses } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import {
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';

// What every purchase document checks the same way (step 17a): the warehouse the goods are for and
// the items on its lines. 17b's purchase order and goods receipt use them too.

// An active warehouse of this workspace. A draft that already has this warehouse keeps it (keptId)
// even if it was archived since, like a sales draft keeps its archived customer: the person can
// still finish it. FOR SHARE: an archive waits until we commit.
export async function assertWarehouse(
  tx: Transaction,
  warehouseId: string,
  keptId: string | null = null,
): Promise<void> {
  const [row] = await tx
    .select({ id: warehouses.id, archivedAt: warehouses.archivedAt })
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, warehouseId)))
    .for('share');
  if (!row || (row.archivedAt !== null && row.id !== keptId)) {
    const code: ErrorCode = 'purchase_warehouse_invalid';
    throw new AppError(409, code, 'Pick an active warehouse.', {
      fieldErrors: { warehouseId: [code] },
    });
  }
}

// A purchase line's item as the form sends it
export interface PurchaseItemInput {
  variantId: string;
  unitId: string;
  quantity: string;
  description: string | null;
}

// The item checked against its product, with the quantity in the base unit
export interface ResolvedPurchaseItem {
  variant: VariantInfo;
  unitId: string;
  quantity: string;
  factor: string;
  baseQuantity: string;
  description: string;
}

// Every rule of a purchase line's item the contract cannot check: an active product or service of
// this workspace (a service is bought too: a repair, a transport contract), a unit that is its base
// unit or one of its packs, and a quantity that fits the unit. All problems come back at once,
// each under its own field, like resolveSalesLines().
export async function resolvePurchaseItems(
  tx: Transaction,
  lines: readonly PurchaseItemInput[],
): Promise<ResolvedPurchaseItem[]> {
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
  );
  const issues: LineIssue[] = [];
  const resolved: ResolvedPurchaseItem[] = [];
  lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
    };
    const variant = variants.get(line.variantId);
    if (variant === undefined || variant.archived) {
      at('variantId', 'purchase_item_invalid');
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
    if (!fitsDecimals(line.quantity, unit.decimals)) {
      at('quantity', 'stock_quantity_decimals');
      return;
    }
    const baseQuantity = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
    if (!isQuantity(baseQuantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    resolved.push({
      variant,
      unitId: line.unitId,
      quantity: line.quantity,
      factor: unit.factor,
      baseQuantity,
      description: line.description ?? defaultLineDescription(variant),
    });
  });
  if (issues.length > 0) throw linesError(issues);
  return resolved;
}
```

- **`assertWarehouse()`** answers under the form's own field (`warehouseId`), with the purchase code. A draft keeps
  an archived warehouse it already has (`keptId`), like a sales draft keeps its archived customer, so the person can
  finish it.
- **`resolvePurchaseItems()`** is the item half of `resolveSalesLines()`: an active product or service, a unit that
  is its base unit or one of its packs, and a quantity with no more decimals than the unit allows. Every problem comes
  back at once under its own line. 17b's purchase order and goods receipt call it too, which is why it is not inside
  the requisitions service.
- **A service is accepted:** a repair or a transport contract is bought too. 17b will keep it out of the goods
  receipt, as sales keeps it out of the challan.

### The cost a line starts with: `purchase/cost-lookup.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { CostLookup, CostLookupInput } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { ValueAccess } from '../inventory/value-access.js';

const rowSchema = z.object({
  variant_id: z.uuid(),
  unit_id: z.uuid(),
  cost: z.string().nullable(),
});

// The cost a new purchase line starts with (step 17a, decision 20). The person may change it on
// the line: this is only where it starts.
//   cost  the company-wide average cost of the variant (step 14) × the unit's factor; else none
//         (null): a product never bought, or a service, which has no stock and so no average
// 17b puts the last purchase price before the average.
@Injectable()
export class CostLookupService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly values: ValueAccess,
  ) {}

  async lookup(input: CostLookupInput): Promise<CostLookup> {
    const tenantId = getTenantId();
    // The average comes from the books, so only someone with inventory.stock.value gets it, like
    // the stock page's costs (step 14). Everyone else gets every item, with no cost: the form still
    // learns which items are valid, and the person types the cost.
    const canSee = await this.values.canSee();
    return this.withTenant(async (tx) => {
      // One query for every item, in the order they were asked for (ord), like the sales price
      // lookup. A unit that is neither the base unit nor a pack of the product drops out, like an
      // unknown variant. The multiplication is NUMERIC in Postgres: a factor has 6 decimals, and it
      // is rounded once, to the 4 decimals a cost keeps.
      const wanted = sql.join(
        input.items.map(
          (item, index) => sql`(${index}::int, ${item.variantId}::uuid, ${item.unitId}::uuid)`,
        ),
        sql`, `,
      );
      const rows = z.array(rowSchema).parse(
        await tx.execute(sql`
          WITH wanted(ord, variant_id, unit_id) AS (VALUES ${wanted})
          SELECT w.variant_id::text AS variant_id, w.unit_id::text AS unit_id,
                 ${
                   canSee
                     ? sql`round(sv.unit_cost * CASE WHEN w.unit_id = p.base_unit_id THEN 1
                                                     ELSE pu.factor END, 4)::text`
                     : sql`NULL::text`
                 } AS cost
            FROM wanted w
            JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = w.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN product_units pu
              ON pu.tenant_id = p.tenant_id AND pu.product_id = p.id AND pu.unit_id = w.unit_id
            LEFT JOIN stock_values sv ON sv.tenant_id = v.tenant_id AND sv.variant_id = v.id
           WHERE w.unit_id = p.base_unit_id OR pu.unit_id IS NOT NULL
           ORDER BY w.ord`),
      );
      return {
        items: rows.map((row) => ({
          variantId: row.variant_id,
          unitId: row.unit_id,
          cost: row.cost,
          source: row.cost === null ? null : 'average_cost',
        })),
      };
    });
  }
}
```

- **The average cost × the unit's factor, rounded once in Postgres** (decision 20), like the sales price lookup. A
  factor has 6 decimals; JavaScript numbers would lose some of them.
- **Without `inventory.stock.value` the cost is `NULL` in the query itself,** not hidden afterwards. Every valid item
  still comes back, so the form can tell an item that has no cost (type one) from one that is not valid at all.
- **`source` is `average_cost` only when there is a cost.** A product that was never bought has no row in
  `stock_values`, and a service never has one: the person types the cost.

### Requisitions: `purchase/requisitions.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type Requisition,
  type RequisitionInput,
  requisitionLineAmount,
  type RequisitionStatus,
  type RequisitionSummary,
  sumMoney,
  type UpdateRequisitionInput,
} from '@omnivo/contracts';
import { requisitionLines, requisitions, users, warehouses } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { withVariants } from '../sales/sales-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { ApprovalsService } from './approvals.service.js';
import { assertWarehouse, resolvePurchaseItems } from './purchase-lines.js';

type RequisitionRow = typeof requisitions.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM requisition_lines l
   WHERE l.tenant_id = requisitions.tenant_id AND l.requisition_id = requisitions.id
)`;

function notDraft(): AppError {
  return new AppError(
    409,
    'purchase_not_draft',
    'This requisition was submitted. Reopen it to change it.',
  );
}

function wasSubmitted(): AppError {
  return new AppError(
    409,
    'purchase_was_submitted',
    'This requisition was submitted once, so its approval history stays. Cancel it instead.',
  );
}

function toSummary(
  row: RequisitionRow,
  requestedByName: string,
  lines: number,
): RequisitionSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    neededBy: row.neededBy,
    warehouseId: row.warehouseId,
    status: row.status,
    amount: row.amount,
    lineCount: lines,
    requestedBy: { id: row.requestedBy, name: requestedByName },
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows of a requisition: what a person recognises, not ids or every line
function snapshot(row: RequisitionRow, warehouse: string, lines: number) {
  return {
    number: row.number,
    date: row.date,
    neededBy: row.neededBy,
    warehouse,
    amount: row.amount,
    lines,
  };
}

// A line ready to store: the item checked, its amount worked out with the contract's own function
// (the form shows the same number)
interface ResolvedLine {
  item: Awaited<ReturnType<typeof resolvePurchaseItems>>[number];
  estimatedCost: string;
  amount: string;
}

// Purchase requisitions (step 17a). Numbered when saved (decision 19); a draft is changed freely,
// then submitted for approval through ApprovalsService, which moves its status. It moves no stock
// and posts nothing.
@Injectable()
export class RequisitionsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: RequisitionStatus | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: RequisitionSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(requisitions.status, query.status),
          query.warehouseId === undefined
            ? undefined
            : eq(requisitions.warehouseId, query.warehouseId),
          after === undefined
            ? undefined
            : sql`(${requisitions.date}, ${requisitions.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [
        last.requisition.date,
        last.requisition.id,
      ]);
      return {
        items: page.items.map((row) =>
          toSummary(row.requisition, row.requestedByName, row.lineCount),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Requisition> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: RequisitionInput): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      await assertWarehouse(tx, input.warehouseId);
      const lines = await this.resolveLines(tx, input.lines);
      // Numbered at once, like a quotation: people refer to it while it waits. A deleted draft
      // leaves a gap, which is fine for a request.
      const number = await this.numbering.next(tx, 'purchase.requisition', input.date);
      const userId = currentPrincipal().userId;
      const [row] = await tx
        .insert(requisitions)
        .values({
          tenantId: getTenantId(),
          number,
          date: input.date,
          neededBy: input.neededBy,
          warehouseId: input.warehouseId,
          amount: sumMoney(lines.map((line) => line.amount)),
          note: input.note,
          requestedBy: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      if (!row) throw new Error('Requisition insert returned no row');
      await this.writeLines(tx, row.id, lines);
      await audit(tx, {
        action: 'requisition.created',
        entityType: 'requisition',
        entityId: row.id,
        changes: created(snapshot(row, await this.warehouseName(tx, row), lines.length)),
      });
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateRequisitionInput): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      if (before.status !== 'draft') throw notDraft();
      const linesBefore = await this.linesOf(tx, id);
      await assertWarehouse(tx, input.warehouseId, before.warehouseId);
      const lines = await this.resolveLines(tx, input.lines);
      const [updated] = await tx
        .update(requisitions)
        .set({
          date: input.date,
          neededBy: input.neededBy,
          warehouseId: input.warehouseId,
          amount: sumMoney(lines.map((line) => line.amount)),
          note: input.note,
          version: sql`${requisitions.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)))
        .returning();
      if (!updated) throw notFound('Requisition');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'requisition.updated',
        entityType: 'requisition',
        entityId: id,
        changes: diff(
          snapshot(before, await this.warehouseName(tx, before), linesBefore.length),
          snapshot(updated, await this.warehouseName(tx, updated), lines.length),
        ),
      });
      return this.read(tx, id);
    });
  }

  // Only a draft that was never submitted: a mistake nobody saw. Once submitted, its approval
  // history stays, and it is cancelled instead (decision 19).
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id, version);
        const { rounds } = await this.approvals.history(tx, 'requisition', id);
        if (before.status !== 'draft' || rounds.length > 0) throw wasSubmitted();
        const lines = await this.linesOf(tx, id);
        const warehouse = await this.warehouseName(tx, before);
        // The lines go with it (ON DELETE CASCADE)
        await tx
          .delete(requisitions)
          .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
        await audit(tx, {
          action: 'requisition.deleted',
          entityType: 'requisition',
          entityId: id,
          changes: diff(snapshot(before, warehouse, lines.length), {
            number: null,
            date: null,
            neededBy: null,
            warehouse: null,
            amount: null,
            lines: null,
          }),
        });
      });
    } catch (error) {
      // The database's own rule (0036), should a submit commit between our check and the delete
      if (isCheckViolation(error, 'requisitions_submitted_immutable')) throw wasSubmitted();
      throw error;
    }
  }

  // Sent for approval with the amount it has now: that amount chooses the levels
  submit(id: string, version: number): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft') throw notDraft();
      await this.approvals.submit(tx, 'requisition', id, row.amount);
      return this.read(tx, id);
    });
  }

  // Pending: taken back to change it. Approved: changed after all, then approved again from the
  // first level (decision 6). 17b refuses it once a purchase order was made from it.
  reopen(id: string, version: number): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'pending' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_reopen',
          'Only a pending or approved requisition can be reopened.',
        );
      }
      await this.approvals.reopen(tx, 'requisition', id, row.status);
      return this.read(tx, id);
    });
  }

  // Will not be bought. A pending one is reopened first: someone may be deciding it right now.
  cancel(id: string, version: number): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_cancel',
          'Only a draft or approved requisition can be cancelled. Reopen a pending one first.',
        );
      }
      await tx
        .update(requisitions)
        .set({
          status: 'cancelled',
          version: sql`${requisitions.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
      await audit(tx, {
        action: 'requisition.cancelled',
        entityType: 'requisition',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'cancelled' }),
      });
      return this.read(tx, id);
    });
  }

  private async resolveLines(
    tx: Transaction,
    lines: RequisitionInput['lines'],
  ): Promise<ResolvedLine[]> {
    const items = await resolvePurchaseItems(tx, lines);
    return items.map((item, index) => {
      // resolvePurchaseItems() returns one item per line, in order, or throws
      const estimatedCost = lines[index]?.estimatedCost ?? '0';
      return {
        item,
        estimatedCost,
        amount: requisitionLineAmount(item.quantity, estimatedCost),
      };
    });
  }

  // A save replaces all the lines, like a quotation's. The database lets it only while the
  // requisition is a draft (requisition_lines_locked).
  private async writeLines(
    tx: Transaction,
    requisitionId: string,
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(requisitionLines)
      .where(
        and(
          eq(requisitionLines.tenantId, tenantId),
          eq(requisitionLines.requisitionId, requisitionId),
        ),
      );
    await tx.insert(requisitionLines).values(
      lines.map((line, index) => ({
        tenantId,
        requisitionId,
        lineNo: index + 1,
        productId: line.item.variant.productId,
        variantId: line.item.variant.variantId,
        unitId: line.item.unitId,
        quantity: line.item.quantity,
        factor: line.item.factor,
        baseQuantity: line.item.baseQuantity,
        description: line.item.description,
        estimatedCost: line.estimatedCost,
        amount: line.amount,
      })),
    );
  }

  // FOR UPDATE: two saves, a save and a submit, or a submit and an approval take turns. The
  // approvals engine locks the document first too (APPROVAL_TARGETS).
  private async lock(tx: Transaction, id: string, version: number): Promise<RequisitionRow> {
    const [row] = await tx
      .select()
      .from(requisitions)
      .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)))
      .for('update');
    if (!row) throw notFound('Requisition');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, requisitionId: string) {
    return tx
      .select()
      .from(requisitionLines)
      .where(
        and(
          eq(requisitionLines.tenantId, getTenantId()),
          eq(requisitionLines.requisitionId, requisitionId),
        ),
      )
      .orderBy(asc(requisitionLines.lineNo));
  }

  private async warehouseName(tx: Transaction, row: RequisitionRow): Promise<string> {
    const [warehouse] = await tx
      .select({ name: warehouses.name })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return warehouse?.name ?? row.warehouseId;
  }

  // The requisitions with who asked and their line counts, newest date first
  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({ requisition: requisitions, requestedByName: users.fullName, lineCount })
      .from(requisitions)
      .innerJoin(users, eq(users.id, requisitions.requestedBy))
      .where(and(eq(requisitions.tenantId, getTenantId()), where))
      .orderBy(desc(requisitions.date), desc(requisitions.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Requisition> {
    const [found] = await this.rows(tx, eq(requisitions.id, id), 1);
    if (!found) throw notFound('Requisition');
    const { requisition: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    return {
      ...toSummary(row, found.requestedByName, found.lineCount),
      note: row.note,
      lines: lines.map(({ row: line, variant }) => ({
        id: line.id,
        variantId: variant.variantId,
        productId: variant.productId,
        productCode: variant.productCode,
        productName: variant.productName,
        optionValues: variant.optionValues,
        sku: variant.sku,
        baseUnitId: variant.baseUnitId,
        productType: variant.type,
        units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        unitId: line.unitId,
        quantity: line.quantity,
        baseQuantity: line.baseQuantity,
        description: line.description,
        estimatedCost: line.estimatedCost,
        amount: line.amount,
      })),
      approval: await this.approvals.history(tx, 'requisition', id),
    };
  }
}
```

- **Numbered when created** (decision 19), from `purchase.requisition`, by the requisition's date (the fiscal year's
  numbers: `PR-2026-27-0001`).
- **`requested_by` is the signed-in person,** and the list shows their name from `users`. It is not `created_by`
  (17a.2): it must name a real person.
- **The amount is worked out with the contract's functions** (`requisitionLineAmount()`, `sumMoney()`), so the
  server stores the number the form showed, and the approval levels are chosen by it.
- **`update()` refuses anything but a draft** with `purchase_not_draft`, before the database's
  `requisition_lines_locked` would. The person gets a reason ("reopen it first"), not a database error.
- **`remove()` checks for rounds,** not only the status: a draft that was rejected or reopened was submitted once,
  and its history stays (decision 19). The database refuses the same (`requisitions_submitted_immutable`); the
  catch turns it into the same answer, should a submit commit between our check and the delete.
- **`submit()` only checks the status and hands over.** The engine copies the levels, writes the round and moves the
  status. The amount it uses is the stored one, not one the request sends.
- **`reopen()` passes the status it found** (`pending` or `approved`) to the engine, which knows what each means for
  the round. 17b adds the check that no purchase order uses it.
- **`cancel()` refuses a pending requisition.** Someone may be deciding it right now; reopen it first, and the round
  ends as reopened, so the history says what happened.
- **The detail carries the approval history** (`approvals.history()`) in the same transaction, so the page shows the
  status and the rounds as one moment.

### The controllers and the module

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ApprovalsService } from './approvals.service.js';

type RuleRoutes = typeof routes.approvalRules;
type Routes = typeof routes.approvals;

@Controller()
export class ApprovalRulesController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Endpoint(routes.approvalRules.list)
  list(): Promise<RouteResponse<RuleRoutes['list']>> {
    return this.approvals.listRules();
  }

  // core.settings.manage (the contract's `permission`): the levels are a workspace setting
  @Endpoint(routes.approvalRules.update)
  update({
    params,
    body,
  }: RouteInput<RuleRoutes['update']>): Promise<RouteResponse<RuleRoutes['update']>> {
    return this.approvals.saveRule(params.document, body);
  }
}

// No route permission on any of these (decision 16): holding the waiting step's role, or being an
// Owner, is the right, and ApprovalsService checks it against the document
@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Endpoint(routes.approvals.waiting)
  waiting({ query }: RouteInput<Routes['waiting']>): Promise<RouteResponse<Routes['waiting']>> {
    return this.approvals.waiting(query);
  }

  @Endpoint(routes.approvals.waitingCount)
  waitingCount(): Promise<RouteResponse<Routes['waitingCount']>> {
    return this.approvals.waitingCount();
  }

  @Endpoint(routes.approvals.approve)
  approve({ params, body }: RouteInput<Routes['approve']>): Promise<void> {
    return this.approvals.decide(params.document, params.id, 'approved', body);
  }

  @Endpoint(routes.approvals.reject)
  reject({ params, body }: RouteInput<Routes['reject']>): Promise<void> {
    return this.approvals.decide(params.document, params.id, 'rejected', body);
  }
}
```

- **No permission on the approval routes** (decision 16): the service checks the role against the document. The
  rules' `PUT` needs `core.settings.manage`, from the contract.

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { CostLookupService } from './cost-lookup.service.js';
import { RequisitionsService } from './requisitions.service.js';

type Routes = typeof routes.requisitions;
type CostRoutes = typeof routes.purchaseCosts;

@Controller()
export class RequisitionsController {
  constructor(private readonly requisitions: RequisitionsService) {}

  @Endpoint(routes.requisitions.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.requisitions.list(query);
  }

  @Endpoint(routes.requisitions.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.requisitions.get(params.id);
  }

  @Endpoint(routes.requisitions.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.requisitions.create(body);
  }

  @Endpoint(routes.requisitions.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.requisitions.update(params.id, body);
  }

  @Endpoint(routes.requisitions.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.requisitions.remove(params.id, query.version);
  }

  @Endpoint(routes.requisitions.submit)
  submit({ params, body }: RouteInput<Routes['submit']>): Promise<RouteResponse<Routes['submit']>> {
    return this.requisitions.submit(params.id, body.version);
  }

  @Endpoint(routes.requisitions.reopen)
  reopen({ params, body }: RouteInput<Routes['reopen']>): Promise<RouteResponse<Routes['reopen']>> {
    return this.requisitions.reopen(params.id, body.version);
  }

  @Endpoint(routes.requisitions.cancel)
  cancel({ params, body }: RouteInput<Routes['cancel']>): Promise<RouteResponse<Routes['cancel']>> {
    return this.requisitions.cancel(params.id, body.version);
  }
}

@Controller()
export class PurchaseCostsController {
  constructor(private readonly costs: CostLookupService) {}

  @Endpoint(routes.purchaseCosts.lookup)
  lookup({ body }: RouteInput<CostRoutes['lookup']>): Promise<RouteResponse<CostRoutes['lookup']>> {
    return this.costs.lookup(body);
  }
}
```

```ts
import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ApprovalRulesController, ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';
import { CostLookupService } from './cost-lookup.service.js';
import { PayableAccess } from './payable-access.js';
import { PurchaseCostsController, RequisitionsController } from './requisitions.controller.js';
import { RequisitionsService } from './requisitions.service.js';
import { SupplierGroupsService } from './supplier-groups.service.js';
import { SupplierGroupsController, SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

// Purchase (step 17): suppliers, their groups, the approvals engine, requisitions and the cost
// lookup in 17a. NumberingModule gives the codes and numbers (S-00042, PR-), JournalModule the
// LedgerService behind a supplier's statement, RbacModule the permission check of PayableAccess,
// InventoryModule the ValueAccess that hides the average cost without inventory.stock.value.
// The approvals engine lives here because every document that needs one is a purchase document.
@Module({
  imports: [NumberingModule, JournalModule, RbacModule, InventoryModule],
  controllers: [
    SuppliersController,
    SupplierGroupsController,
    ApprovalRulesController,
    ApprovalsController,
    RequisitionsController,
    PurchaseCostsController,
  ],
  providers: [
    SuppliersService,
    SupplierGroupsService,
    PayableAccess,
    ApprovalsService,
    RequisitionsService,
    CostLookupService,
  ],
})
export class PurchaseModule {}
```

- **`InventoryModule`** gives `ValueAccess` for the cost lookup, **`JournalModule`** the `LedgerService` for the
  statement, **`RbacModule`** the `PermissionService` behind `PayableAccess`. The approvals engine is a provider of
  this module, not a module of its own (decision 30).

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm lint
```

The API type-checks, and its unit tests pass (107, among them the route test from 17a.1, which now finds a
controller for every new route). The contracts' tests still pass (197) after the one change to `approvals.ts` (a
step's role may have lost its id). The app does not type-check yet: it learns the new words in 17a.5 and the screens
in 17a.6.

> **What we checked.** The type checker, the linter and the unit tests above. Nothing in this part has run against a
> real database yet: the suppliers, the approvals and the requisitions are tested against one in 17a.4, with two
> people deciding at once, a role deleted while a step waits, and another workspace trying every route.

---

## 17a.4 — `apps/api`: the tests

This part adds three test files, all in `apps/api/src/purchase/`, and changes three older ones. Like every integration test since step 5, they run
against a real Postgres and the real worker:

- `suppliers.int.spec.ts` follows a knitting factory through its suppliers: groups, codes, bank accounts, a party
  that both sells to the company and buys from it, payable lines in the books, statements, deleting one side of a
  party, and opening balances per supplier.
- `requisitions.int.spec.ts` follows a garments factory's purchase requests: the approval levels in Settings, the
  requisition itself, the approval in order, the bell, two people deciding at once, a role nobody holds, and the cost
  a line starts with.
- `purchase.tenant-leak.int.spec.ts`: workspace A must never see, change, use or decide anything of workspace B's.
- `journal/journal.int.spec.ts`, `numbering/numbering.int.spec.ts` and `setup/setup.int.spec.ts` (older files)
  follow the rules 17a added: a payable line names a supplier, there are two more number series, and three garments
  roles have new permissions.

No code from 17a.3 changed: the new tests passed against it as it is. They are also the first time the raw SQL of 17a.3
ran against a real database: the supplier balance subquery, the "is the customer side used?" check across eight sales
tables, the waiting-step condition and the cost lookup's `VALUES` list. A type checker cannot see inside an `sql`
template, so only these tests prove that SQL is right.

### `purchase/suppliers.int.spec.ts` (new): the setup

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  type Customer,
  customerGroupSchema,
  customerSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  openingBalancesSchema,
  type PermissionKey,
  type Product,
  productSchema,
  problemSchema,
  roleSchema,
  setupSchema,
  type Supplier,
  type SupplierFormValues,
  supplierGroupListSchema,
  supplierGroupSchema,
  supplierPageSchema,
  supplierSchema,
  taxRateListSchema,
  unitListSchema,
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

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Tanvir: keeps the supplier records, but what the company owes them is the accountant's business
let buyer: SignedIn;
let accounts: Account[];

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

function id(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

// The garments chart: 1110 cash, 1140 the receivable, 2110 the payable
const RECEIVABLE = '1140';
const PAYABLE = '2110';

// What the supplier form sends; each test changes a few fields
function supplierForm(name: string, extra: Partial<SupplierFormValues> = {}): SupplierFormValues {
  return {
    code: '',
    name,
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
    ...extra,
  };
}

// A form built from a saved supplier, as the edit page does
function formOf(supplier: Supplier, extra: Partial<SupplierFormValues> = {}) {
  return {
    code: supplier.code,
    name: supplier.name,
    groupId: supplier.groupId ?? '',
    contactPerson: supplier.contactPerson ?? '',
    phone: supplier.phone ?? '',
    email: supplier.email ?? '',
    documentLanguage: supplier.documentLanguage,
    bin: supplier.bin ?? '',
    paymentTermsDays: supplier.paymentTermsDays,
    address: supplier.address ?? '',
    bankAccounts: supplier.bankAccounts.map((account) => ({
      id: account.id,
      bankName: account.bankName,
      branchName: account.branchName ?? '',
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      routingNumber: account.routingNumber ?? '',
    })),
    notes: supplier.notes ?? '',
    ...extra,
    version: supplier.version,
  };
}

// A new bank account as the form sends it
function bankAccount(bankName: string, accountNumber: string, extra: object = {}) {
  return {
    id: null,
    bankName,
    branchName: '',
    accountName: 'Square Yarns Ltd.',
    accountNumber,
    routingNumber: '',
    ...extra,
  };
}

async function addSupplier(name: string, extra: Partial<SupplierFormValues> = {}) {
  const res = await send('POST', '/suppliers', supplierForm(name, extra));
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

async function supplier(supplierId: string, as = owner): Promise<Supplier> {
  const res = await send('GET', `/suppliers/${supplierId}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return supplierSchema.parse(res.json());
}

async function addCustomer(name: string, extra: object = {}): Promise<Customer> {
  const res = await send('POST', '/customers', {
    code: '',
    name,
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
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

async function customer(customerId: string): Promise<Customer> {
  const res = await send('GET', `/customers/${customerId}`);
  expect(res.statusCode, res.body).toBe(200);
  return customerSchema.parse(res.json());
}

// A party that both sells to the company and buys from it: a customer made a supplier too
async function bothSides(name: string, extra: object = {}): Promise<Supplier> {
  const made = await addCustomer(name, extra);
  const res = await send('POST', `/customers/${made.id}/make-supplier`, { version: made.version });
  expect(res.statusCode, res.body).toBe(200);
  return supplierSchema.parse(res.json());
}

// A line as the journal form sends it: '' on the empty side, '' for "no party"
function debit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: amount, credit: '' };
}
function credit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: '', credit: amount };
}

function write(date: string, lines: object[], { post = true } = {}) {
  return send('POST', '/journal-entries', { date, narration: 'Test entry', lines, post });
}

async function posted(date: string, lines: object[]) {
  const res = await write(date, lines);
  expect(res.statusCode, res.body).toBe(201);
  return journalEntrySchema.parse(res.json());
}

// Runs SQL as the database superuser: RLS does not apply, but every trigger does
async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function bankRowsOf(partyId: string): Promise<number> {
  const [row] = await superuserSql(
    (sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM party_bank_accounts WHERE party_id = ${partyId}`,
  );
  return row?.n ?? 0;
}

// A user who signs up for a workspace of their own, then joins this one with one role
async function member(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'meghna-knit' });
  const made = await send('POST', '/roles', { name: 'Purchase desk', description: '' });
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
  return logIn(app, { workspace: 'meghna-knit', email, password, keepSignedIn: false });
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
    companyName: 'Meghna Knit Composite Ltd.',
    workspaceSlug: 'meghna-knit',
    fullName: 'Shahana Karim',
    email: 'shahana@meghnaknit.com',
    password: 'Narayanganj-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  buyer = await member('tanvir@meghnaknit.com', 'Tanvir Hasan', 'Fatullah-yarn-2026', [
    'purchase.supplier.manage',
  ]);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **A garments workspace** (Meghna Knit Composite), because its chart has the payable (2110) next to the receivable
  (1140) and cash (1110). These are the only account codes the file uses.
- **Two users.** The Owner has every permission. Tanvir has only `purchase.supplier.manage`: he keeps the supplier
  records, but may not see what the company owes them (decision 3 of 17a.1). The balance tests need someone like him.
- **`supplierForm()` sends every field, typed with `SupplierFormValues`**, the contract's form type. A field renamed in
  the contract then breaks the type check here, not a test at run time. `formOf()` builds the form from a saved
  supplier, as the edit page will, so an update sends back the bank accounts with their ids.
- **`bothSides()` makes a customer first, then "Make supplier too".** That is the only way a party becomes both in
  17a, so the tests that need such a party use the real route, not SQL.
- **`bankRowsOf()` counts bank account rows as the superuser.** The API never shows the rows of a deleted supplier,
  so only the database can show they are really gone.
- **`member()` gives the new user one fresh role** with the permissions asked for. A test then knows exactly what the
  person may do; a template role would change whenever a later step adds a permission to it.

### Supplier groups and suppliers

```ts
describe('supplier groups', () => {
  it('are added and renamed, each name once in any case', async () => {
    const res = await send('POST', '/supplier-groups', { name: 'Yarn' });
    expect(res.statusCode).toBe(201);
    expect(supplierGroupSchema.parse(res.json())).toMatchObject({ supplierCount: 0, version: 1 });

    const same = await send('POST', '/supplier-groups', { name: 'YARN' });
    expect(same.statusCode).toBe(409);
    expect(problemOf(same).fieldErrors).toEqual({ name: ['supplier_group_name_taken'] });

    const trims = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Trim' })).json(),
    );
    const renamed = await send('PUT', `/supplier-groups/${trims.id}`, {
      name: 'Trims and accessories',
      version: trims.version,
    });
    expect(supplierGroupSchema.parse(renamed.json())).toMatchObject({
      name: 'Trims and accessories',
      version: 2,
    });
    const { items } = supplierGroupListSchema.parse((await send('GET', '/supplier-groups')).json());
    expect(items.map((group) => group.name)).toEqual(['Trims and accessories', 'Yarn']);
  });

  it('keep a group while any supplier is in it, archived ones too', async () => {
    const group = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Packaging' })).json(),
    );
    const cartons = await addSupplier('Bengal Carton Industries', { groupId: group.id });
    const archived = await send('POST', `/suppliers/${cartons.id}/archive`, {
      version: cartons.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const { items } = supplierGroupListSchema.parse((await send('GET', '/supplier-groups')).json());
    const counted = items.find((item) => item.id === group.id);
    expect(counted?.supplierCount).toBe(1);
    const refused = await send('DELETE', `/supplier-groups/${group.id}?version=1`);
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('supplier_group_in_use');

    // A customer group is not a supplier group: the customer side of a party has its own
    const empty = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Chemicals' })).json(),
    );
    expect((await send('DELETE', `/supplier-groups/${empty.id}?version=1`)).statusCode).toBe(204);
  });
});

describe('suppliers', () => {
  it('get the next code from the S- series; a code is one party, customer or supplier', async () => {
    const first = await addSupplier('Square Yarns Ltd.');
    expect(first).toMatchObject({
      balance: '0.0000',
      isCustomer: false,
      address: null,
      bankAccounts: [],
    });
    // S-00001 went to the packaging supplier above; the numbers after it are worked out, not typed
    const next = (step: number) =>
      `S-${String(Number(first.code.slice(2)) + step).padStart(5, '0')}`;
    expect(first.code).toMatch(/^S-\d{5}$/);
    // A customer typed the next number by hand: the series skips it, like the customers' own
    await addCustomer('Fakir Fashion', { code: next(1) });
    expect((await addSupplier('Padma Accessories')).code).toBe(next(2));

    const taken = await send(
      'POST',
      '/suppliers',
      supplierForm('Copy', { code: next(1).toLowerCase() }),
    );
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).fieldErrors).toEqual({ code: ['supplier_code_taken'] });
    // An empty code on an edit keeps the one it has
    const kept = await send('PUT', `/suppliers/${first.id}`, formOf(first, { code: '' }));
    expect(supplierSchema.parse(kept.json()).code).toBe(first.code);
  });

  it('check the group: a customer group or an unknown id is not one', async () => {
    const customerGroup = await send('POST', '/customer-groups', { name: 'Export buyer' });
    expect(customerGroup.statusCode).toBe(201);
    const { id: groupId } = customerGroupSchema.parse(customerGroup.json());
    const res = await send('POST', '/suppliers', supplierForm('Dhaka Trims House', { groupId }));
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({ groupId: ['supplier_group_invalid'] });
  });

  it('keep their bank accounts in order, cleaned, each with its id', async () => {
    const saved = await addSupplier('Square Yarns Mills', {
      bankAccounts: [
        bankAccount('Dutch-Bangla Bank', '0123-4567890-01', {
          branchName: 'Motijheel',
          routingNumber: '090 275 431',
        }),
        bankAccount('BRAC Bank', '1501 2040 5566 7001'),
      ],
    });
    expect(
      saved.bankAccounts.map((account) => [
        account.bankName,
        account.branchName,
        account.accountNumber,
        account.routingNumber,
      ]),
    ).toEqual([
      ['Dutch-Bangla Bank', 'Motijheel', '0123456789001', '090275431'],
      ['BRAC Bank', null, '1501204055667001', null],
    ]);
    const [dbbl, brac] = saved.bankAccounts;
    if (!dbbl || !brac) throw new Error('expected two bank accounts');

    // BRAC moves to the top and keeps its id, DBBL goes, a new City Bank account comes last
    const res = await send(
      'PUT',
      `/suppliers/${saved.id}`,
      formOf(saved, {
        bankAccounts: [
          {
            id: brac.id,
            bankName: 'BRAC Bank',
            branchName: 'Gulshan',
            accountName: 'Square Yarns Mills',
            accountNumber: brac.accountNumber,
            routingNumber: '',
          },
          bankAccount('City Bank', '2102233445001'),
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const changed = supplierSchema.parse(res.json());
    expect(changed.bankAccounts.map((account) => [account.bankName, account.branchName])).toEqual([
      ['BRAC Bank', 'Gulshan'],
      ['City Bank', null],
    ]);
    expect(changed.bankAccounts[0]?.id).toBe(brac.id);
    expect(await bankRowsOf(saved.id)).toBe(2);

    // The audit log shows an account by its last four digits, never the whole number
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=supplier&entityId=${saved.id}`)).json(),
    );
    const updated = log.items.find((entry) => entry.action === 'supplier.updated');
    expect(updated?.changes.bankAccounts).toEqual({
      from: 'Dutch-Bangla Bank …9001, BRAC Bank …7001',
      to: 'BRAC Bank …7001, City Bank …5001',
    });
  });

  it("never moves another supplier's bank account: its id only makes a new one", async () => {
    const yarns = await addSupplier('Zaber Spinning', {
      bankAccounts: [bankAccount('Eastern Bank', '1011060012345')],
    });
    const other = await addSupplier('Akij Spinning');
    const foreign = yarns.bankAccounts[0];
    if (!foreign) throw new Error('expected a bank account');
    const res = await send(
      'PUT',
      `/suppliers/${other.id}`,
      formOf(other, {
        bankAccounts: [{ ...bankAccount('Eastern Bank', '1011060099999'), id: foreign.id }],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const [added] = supplierSchema.parse(res.json()).bankAccounts;
    expect(added?.id).not.toBe(foreign.id);
    expect((await supplier(yarns.id)).bankAccounts).toEqual(yarns.bankAccounts);
  });

  it('refuse a bad account number, a bad routing number and a sixth account', async () => {
    const res = await send(
      'POST',
      '/suppliers',
      supplierForm('Rupali Dyes', {
        bankAccounts: [
          bankAccount('Sonali Bank', '12AB'),
          bankAccount('Janata Bank', '0011223344', { routingNumber: '1234' }),
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      'bankAccounts.0.accountNumber': ['bank_account_number_format'],
      'bankAccounts.1.routingNumber': ['routing_number_format'],
    });

    const six = Array.from({ length: 6 }, (_, index) =>
      bankAccount('Sonali Bank', `00112233${String(index)}0`),
    );
    const many = await send(
      'POST',
      '/suppliers',
      supplierForm('Rupali Dyes', { bankAccounts: six }),
    );
    expect(many.statusCode).toBe(400);
  });

  it('are found by name, code, contact person or phone, by group, a page at a time', async () => {
    const group = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Dyes and chemicals' })).json(),
    );
    await addSupplier('Asian Dyeing Chemicals', {
      groupId: group.id,
      contactPerson: 'Mahbub Alam',
      phone: '01711-556677',
    });
    await addSupplier('Bismillah Chemicals', { groupId: group.id });

    const byPerson = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=mahbub')).json(),
    );
    expect(byPerson.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);
    const byPhone = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=556677')).json(),
    );
    expect(byPhone.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);

    const first = supplierPageSchema.parse(
      (await send('GET', `/suppliers?groupId=${group.id}&limit=1`)).json(),
    );
    expect(first.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = supplierPageSchema.parse(
      (
        await send('GET', `/suppliers?groupId=${group.id}&limit=1&cursor=${first.nextCursor}`)
      ).json(),
    );
    expect(second.items.map((item) => item.name)).toEqual(['Bismillah Chemicals']);
    expect(second.nextCursor).toBeNull();

    // A customer is not in the supplier list, even with a matching name
    await addCustomer('Asian Dyeing Buyer Ltd.');
    const suppliersOnly = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=asian')).json(),
    );
    expect(suppliersOnly.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);
  });
});
```

- **A group name is unique in any case** ("Yarn" and "YARN"), and the error sits under the name box.
- **A group with any supplier in it stays**, archived suppliers too: they still hold the foreign key. The count
  says so (`supplierCount: 1`), and the delete is `supplier_group_in_use`.
- **A code is one party.** The series gives S- codes. A *customer* typed the next S- number by hand, and the
  supplier series skips it, because `codeUsed()` looks at every party. The same code in lower case is
  `supplier_code_taken`. The test works the numbers out from the first code it gets, because the group test above
  already used S-00001: a test that hard-coded "S-00001" would break whenever the order of tests changes.
- **A customer group is not a supplier group.** Its id is `supplier_group_invalid`: the two kinds live in different
  tables, so the lookup simply finds nothing.
- **Bank accounts keep their order and their ids.** Spaces and hyphens are dropped (`0123-4567890-01` is stored as
  `0123456789001`), and an empty routing number is `null`. On the update, BRAC moves to the top and keeps its id
  (17c's payments will point at it), DBBL goes, and City Bank is new. The database has exactly two rows afterwards.
- **The audit log shows an account by its last four digits** ("BRAC Bank …7001"), never the whole number (decision 34).
- **Another supplier's account id makes a new account.** It is never moved: the other supplier still has its own,
  unchanged. Without this rule, anyone who could save a supplier could take over any account by its id.
- **Formats come back per field**: `bank_account_number_format` and `routing_number_format`, each under its own
  account. A sixth account is a 400 from the contract.
- **The list searches the contact person and the phone too**, filters by group, pages with a cursor, and never shows
  a customer, even one whose name matches.

### A party on both sides

```ts
describe('a party on both sides', () => {
  it('becomes a supplier too with the supplier fields at their defaults', async () => {
    const made = await addCustomer('Ha-Meem Washing', {
      paymentTermsDays: 45,
      creditLimit: '500000',
    });
    const res = await send('POST', `/customers/${made.id}/make-supplier`, {
      version: made.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const both = supplierSchema.parse(res.json());
    expect(both).toMatchObject({
      code: made.code,
      groupId: null,
      paymentTermsDays: 0,
      bankAccounts: [],
      isCustomer: true,
    });
    // Its customer side is as it was
    expect(await customer(made.id)).toMatchObject({
      paymentTermsDays: 45,
      creditLimit: '500000.0000',
      isSupplier: true,
    });

    const again = await send('POST', `/customers/${made.id}/make-supplier`, {
      version: both.version,
    });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).code).toBe('party_role_exists');
    const stale = await send('POST', `/customers/${made.id}/make-supplier`, {
      version: made.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
  });

  it('becomes a customer too with the customer fields at their defaults', async () => {
    const made = await addSupplier('Mondol Knitwears', { paymentTermsDays: 60 });
    const res = await send('POST', `/suppliers/${made.id}/make-customer`, {
      version: made.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(customerSchema.parse(res.json())).toMatchObject({
      code: made.code,
      paymentTermsDays: 0,
      creditLimit: null,
      priceListId: null,
      isSupplier: true,
    });
    expect((await supplier(made.id)).paymentTermsDays).toBe(60);
  });

  it('shares one billing address: the supplier changes its text, the label and phone stay', async () => {
    const both = await bothSides('Envoy Textiles', {
      addresses: [
        {
          id: null,
          kind: 'billing',
          label: 'Head office',
          address: 'Envoy Tower, Panthapath, Dhaka',
          phone: '02-9102030',
        },
        { id: null, kind: 'shipping', label: 'Mymensingh mill', address: 'Bhaluka', phone: '' },
      ],
    });
    expect(both.address).toBe('Envoy Tower, Panthapath, Dhaka');

    const res = await send(
      'PUT',
      `/suppliers/${both.id}`,
      formOf(both, { address: 'Envoy Tower, 18/E Lake Circus, Dhaka 1205' }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const billing = (await customer(both.id)).addresses.find((item) => item.kind === 'billing');
    expect(billing).toMatchObject({
      label: 'Head office',
      address: 'Envoy Tower, 18/E Lake Circus, Dhaka 1205',
      phone: '02-9102030',
    });

    // An empty address removes it from both sides; the shipping address is the customer's own
    const cleared = await send(
      'PUT',
      `/suppliers/${both.id}`,
      formOf(supplierSchema.parse(res.json()), { address: '' }),
    );
    expect(supplierSchema.parse(cleared.json()).address).toBeNull();
    expect((await customer(both.id)).addresses.map((item) => item.kind)).toEqual(['shipping']);
  });

  it('is archived as one business, from either side', async () => {
    const both = await bothSides('Pacific Jeans');
    const res = await send('POST', `/suppliers/${both.id}/archive`, { version: both.version });
    expect(res.statusCode, res.body).toBe(200);
    expect((await customer(both.id)).archivedAt).not.toBeNull();
    const archived = supplierPageSchema.parse(
      (await send('GET', '/suppliers?status=archived&search=pacific')).json(),
    );
    expect(archived.items.map((item) => item.name)).toEqual(['Pacific Jeans']);

    const back = await send('POST', `/suppliers/${both.id}/restore`, {
      version: supplierSchema.parse(res.json()).version,
    });
    expect(supplierSchema.parse(back.json()).archivedAt).toBeNull();
    expect((await customer(both.id)).archivedAt).toBeNull();
  });
});
```

- **"Make supplier too" starts the supplier side at its defaults**: no group, terms 0, no bank account. The customer
  side keeps its own 45-day terms and credit limit. A second click is `party_role_exists`; a stale version is
  `version_conflict`.
- **"Make customer too" is the same the other way round**: the new customer side has terms 0, no credit limit and no
  price list, and the supplier keeps its 60 days.
- **One billing address for both sides.** The supplier form changes only its text, so the label ("Head office") and
  the phone that the customer page gave it stay. An empty address removes it from both sides, and the shipping
  address stays, because it belongs to the customer.
- **Archived means the business**: archiving the supplier archives the customer too, and restoring brings both back.

### Suppliers in the books

```ts
describe('suppliers in the books', () => {
  let square: Supplier;

  beforeAll(async () => {
    square = await addSupplier('Square Spinning Unit 2');
  });

  it('need a supplier on every payable line, and the right kind of party', async () => {
    const someone = await addCustomer('Walton Retail');
    const res = await write('2026-10-01', [
      debit('1110', '1000'),
      credit(PAYABLE, '1000'),
      debit(RECEIVABLE, '500', square.id),
      credit(PAYABLE, '500', someone.id),
    ]);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.1.partyId': ['journal_party_required'],
      'lines.2.partyId': ['journal_party_invalid'],
      'lines.3.partyId': ['journal_party_invalid'],
    });
    const notAllowed = await write('2026-10-01', [
      debit('1110', '1000', square.id),
      credit(PAYABLE, '1000', square.id),
    ]);
    expect(problemOf(notAllowed).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_not_allowed'],
    });
  });

  it('show what the company owes only to those who may see it', async () => {
    // Yarn bought on credit: the company owes ৳4,50,000, then pays ৳1,00,000 of it
    await posted('2026-09-10', [debit('1110', '450000'), credit(PAYABLE, '450000', square.id)]);
    await posted('2026-09-25', [debit(PAYABLE, '100000', square.id), credit('1110', '100000')]);
    // Drafts are not in the books
    const draft = await write(
      '2026-09-26',
      [debit('1110', '7000'), credit(PAYABLE, '7000', square.id)],
      { post: false },
    );
    expect(draft.statusCode, draft.body).toBe(201);
    expect((await supplier(square.id)).balance).toBe('350000.0000');
    const list = supplierPageSchema.parse((await send('GET', '/suppliers?search=unit 2')).json());
    expect(list.items[0]?.balance).toBe('350000.0000');

    // The purchase desk reads the supplier without the balance; the statement is refused
    expect((await supplier(square.id, buyer)).balance).toBeNull();
    const theirs = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=unit 2', undefined, buyer)).json(),
    );
    expect(theirs.items[0]?.balance).toBeNull();
    const statement = await send('GET', `/suppliers/${square.id}/statement`, undefined, buyer);
    expect(statement.statusCode).toBe(403);
    expect(problemOf(statement).params).toEqual({ permissions: 'purchase.supplier.balance' });
  });

  it('give a statement of the payable lines only, with a running balance', async () => {
    const page = ledgerPageSchema.parse(
      (await send('GET', `/suppliers/${square.id}/statement?from=2026-09-01`)).json(),
    );
    // debit − credit, like every ledger: negative while the company owes
    expect(page).toMatchObject({ openingBalance: '0.0000', closingBalance: '-350000.0000' });
    expect(page.items.map((line) => [line.date, line.debit, line.credit, line.balance])).toEqual([
      ['2026-09-10', '0.0000', '450000.0000', '-450000.0000'],
      ['2026-09-25', '100000.0000', '0.0000', '-350000.0000'],
    ]);
    // A customer is not a supplier: its id has no supplier statement
    const someone = await addCustomer('Agora Superstores');
    expect((await send('GET', `/suppliers/${someone.id}/statement`)).statusCode).toBe(404);
  });

  it("keep each side's balance apart for a party that is both", async () => {
    const both = await bothSides('Opex Sinha Textiles');
    // It owes the company ৳80,000 for fabric it bought, and the company owes it ৳1,20,000 for yarn
    await posted('2026-10-02', [debit(RECEIVABLE, '80000', both.id), credit('1110', '80000')]);
    await posted('2026-10-02', [debit('1110', '120000'), credit(PAYABLE, '120000', both.id)]);
    expect((await supplier(both.id)).balance).toBe('120000.0000');
    expect((await customer(both.id)).balance).toBe('80000.0000');

    const supplierSide = ledgerPageSchema.parse(
      (await send('GET', `/suppliers/${both.id}/statement`)).json(),
    );
    expect(supplierSide.items.map((line) => line.credit)).toEqual(['120000.0000']);
    const customerSide = ledgerPageSchema.parse(
      (await send('GET', `/customers/${both.id}/statement`)).json(),
    );
    expect(customerSide.items.map((line) => line.debit)).toEqual(['80000.0000']);
  });

  it('reverse an entry onto the same supplier', async () => {
    const entry = await posted('2026-10-03', [
      debit('1110', '5000'),
      credit(PAYABLE, '5000', square.id),
    ]);
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-04',
    });
    expect(res.statusCode, res.body).toBe(201);
    const reversal = journalEntrySchema.parse(res.json());
    expect(reversal.lines.map((line) => line.party?.id ?? null)).toEqual([null, square.id]);
    expect((await supplier(square.id)).balance).toBe('350000.0000');
  });
});
```

- **Every payable line names a supplier, and only a supplier.** In one answer: a payable line without one is
  `journal_party_required`, a supplier on the receivable and a customer on the payable are both
  `journal_party_invalid`. A party on a cash line is `journal_party_not_allowed`.
- **The balance is what the company owes**: ৳4,50,000 bought on credit, ৳1,00,000 paid, so ৳3,50,000. A draft is not
  in the books. Tanvir sees the supplier and the list, with `balance: null`, and his statement is a 403 that names
  `purchase.supplier.balance`.
- **The statement is a ledger of the payable lines.** Its balance is debit − credit like every ledger, so it is
  negative while the company owes (−৳3,50,000). The app turns the sign round on the supplier page (17a.6); the API
  keeps one rule for every ledger. A customer's id has no supplier statement (404).
- **A party on both sides keeps two balances.** It owes the company ৳80,000 and the company owes it ৳1,20,000. The
  supplier page says ৳1,20,000, the customer page ৳80,000, and each statement has only its own line. If the balance
  subquery lost its `purpose = 'accounts_payable'` filter, the supplier would show ৳40,000; we broke it on purpose
  and this test failed.
- **A reversal names the same supplier**, and the balance is back where it was.

### Deleting

```ts
describe('deleting', () => {
  it('deletes a supplier nothing uses, with its bank accounts', async () => {
    const mistake = await addSupplier('Typo Trims', {
      bankAccounts: [bankAccount('Prime Bank', '2126110012345')],
    });
    expect(await bankRowsOf(mistake.id)).toBe(1);
    const res = await send('DELETE', `/suppliers/${mistake.id}?version=${String(mistake.version)}`);
    expect(res.statusCode, res.body).toBe(204);
    expect((await send('GET', `/suppliers/${mistake.id}`)).statusCode).toBe(404);
    expect(await bankRowsOf(mistake.id)).toBe(0);
  });

  it('refuses a supplier with payable lines: archive it instead', async () => {
    const used = await addSupplier('Northern Yarn');
    await posted('2026-10-05', [debit('1110', '1500'), credit(PAYABLE, '1500', used.id)]);
    const res = await send('DELETE', `/suppliers/${used.id}?version=${String(used.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('supplier_in_use');
  });

  it('drops only the supplier side of a party that is both', async () => {
    const both = await bothSides('Beximco Textiles');
    const res = await send(
      'PUT',
      `/suppliers/${both.id}`,
      formOf(both, {
        paymentTermsDays: 15,
        bankAccounts: [bankAccount('Islami Bank', '20501770100123')],
      }),
    );
    const saved = supplierSchema.parse(res.json());
    // Its receivable lines are the customer's: they do not stop the supplier side going
    await posted('2026-10-05', [debit(RECEIVABLE, '9000', both.id), credit('1110', '9000')]);

    const removed = await send('DELETE', `/suppliers/${both.id}?version=${String(saved.version)}`);
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await send('GET', `/suppliers/${both.id}`)).statusCode).toBe(404);
    expect(await bankRowsOf(both.id)).toBe(0);
    expect(await customer(both.id)).toMatchObject({ isSupplier: false, balance: '9000.0000' });
    const [row] = await superuserSql(
      (sql) => sql<{ terms: number }[]>`
        SELECT supplier_payment_terms_days AS terms FROM parties WHERE id = ${both.id}`,
    );
    expect(row?.terms).toBe(0);
  });

  it('refuses to drop the supplier side once a payable line names it', async () => {
    const both = await bothSides('Thermax Yarn');
    await posted('2026-10-05', [debit('1110', '2500'), credit(PAYABLE, '2500', both.id)]);
    const res = await send('DELETE', `/suppliers/${both.id}?version=${String(both.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('supplier_in_use');
  });

  it('drops only the customer side of a party that is both, with its shipping addresses', async () => {
    const both = await bothSides('DBL Ceramics', {
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'Gulshan 2, Dhaka', phone: '' },
        { id: null, kind: 'shipping', label: 'Gazipur', address: 'Kashimpur', phone: '' },
      ],
    });
    // The supplier side's payable lines do not stop the customer side going
    await posted('2026-10-05', [debit('1110', '3000'), credit(PAYABLE, '3000', both.id)]);
    const before = await customer(both.id);
    const res = await send('DELETE', `/customers/${both.id}?version=${String(before.version)}`);
    expect(res.statusCode, res.body).toBe(204);
    expect((await send('GET', `/customers/${both.id}`)).statusCode).toBe(404);
    expect(await supplier(both.id)).toMatchObject({
      isCustomer: false,
      address: 'Gulshan 2, Dhaka',
      balance: '3000.0000',
    });
    const [row] = await superuserSql(
      (sql) => sql<{ shipping: number; terms: number }[]>`
        SELECT (SELECT count(*)::int FROM party_addresses
                 WHERE party_id = ${both.id} AND kind = 'shipping') AS shipping,
               payment_terms_days AS terms
          FROM parties WHERE id = ${both.id}`,
    );
    expect(row).toEqual({ shipping: 0, terms: 0 });
  });

  it('refuses to drop the customer side once a sales document or receivable line names it', async () => {
    const quoted = await bothSides('Snowtex Outerwear');
    const units = unitListSchema.parse((await send('GET', '/units')).json()).items;
    const pcs = units.find((unit) => unit.code === 'pcs');
    const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
    const vat = rates.find((rate) => rate.name === 'VAT 15%');
    if (!pcs || !vat) throw new Error('no pcs or VAT 15%');
    const made = await send('POST', '/products', {
      code: '',
      name: 'Polo shirt, pique',
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
        { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
      ],
      units: [],
      customFields: {},
    });
    expect(made.statusCode, made.body).toBe(201);
    const polo: Product = productSchema.parse(made.json());
    const quotation = await send('POST', '/quotations', {
      customerId: quoted.id,
      date: '2026-10-05',
      validUntil: '2026-10-20',
      note: '',
      lines: [
        {
          variantId: polo.variants[0]?.id ?? '',
          unitId: pcs.id,
          quantity: '100',
          description: '',
          unitPrice: '450',
          discountType: 'percent',
          discount: '',
          taxRateId: vat.id,
        },
      ],
    });
    expect(quotation.statusCode, quotation.body).toBe(201);
    const first = await customer(quoted.id);
    const res = await send('DELETE', `/customers/${quoted.id}?version=${String(first.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('customer_in_use');

    const owing = await bothSides('Sinha Knit');
    await posted('2026-10-05', [debit(RECEIVABLE, '700', owing.id), credit('1110', '700')]);
    const second = await customer(owing.id);
    const refused = await send(
      'DELETE',
      `/customers/${owing.id}?version=${String(second.version)}`,
    );
    expect(problemOf(refused).code).toBe('customer_in_use');
    expect((await supplier(owing.id)).isCustomer).toBe(true);
  });
});
```

- **A supplier nothing uses is deleted with its bank accounts** (`ON DELETE CASCADE`): 404 afterwards, and no rows
  left.
- **A payable line keeps it**: `supplier_in_use`. The foreign key from `journal_lines` does the check.
- **Deleting the supplier side of a party that is both** leaves the customer: its receivable line does not stop the
  delete, because it is the customer's. The bank accounts go, and the supplier's terms are back at 0 in the same
  update, which `parties_supplier_side_check` demands.
- **Once a payable line names it, the supplier side stays**: `supplier_in_use`. Here no foreign key can speak (the
  party row stays), so `dropSupplierSide()` looks for the lines itself.
- **Deleting the customer side** leaves the supplier, with its billing address and its balance. The shipping
  addresses go, and the customer's terms are 0 again (`parties_customer_side_check`).
- **A quotation or a receivable line keeps the customer side**: `customer_in_use`. The quotation is the real test of
  the `UNION ALL` over the eight sales tables in `dropCustomerSide()`. We took `quotations` out of that list on
  purpose and this test failed.

### Opening balances by supplier

```ts
describe('opening balances by supplier', () => {
  let akij: Supplier;
  let rahim: Supplier;

  beforeAll(async () => {
    akij = await addSupplier('Akij Yarn Unit');
    rahim = await addSupplier('Rahim Afrooz Packaging');
  });

  it('split the payable into one line per supplier', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '900000', credit: '' },
        { accountId: id(PAYABLE), partyId: akij.id, debit: '', credit: '650000' },
        { accountId: id(PAYABLE), partyId: rahim.id, debit: '', credit: '48250.75' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.lines.map((line) => [line.party?.name ?? null, line.credit])).toEqual([
      [null, '0.0000'],
      ['Akij Yarn Unit', '650000.0000'],
      ['Rahim Afrooz Packaging', '48250.7500'],
    ]);
    expect((await supplier(akij.id)).balance).toBe('650000.0000');

    // The audit row counts the suppliers apart from the customers
    const log = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace&limit=5')).json(),
    );
    const entry = log.items.find((item) => item.action === 'journal.opening_balances_saved');
    expect(entry?.changes.customers).toEqual({ from: null, to: 0 });
    expect(entry?.changes.suppliers).toEqual({ from: null, to: 2 });
  });

  it('put a customer on the payable under the row it came from', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const someone = await addCustomer('Shwapno Retail');
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '', credit: '' },
        { accountId: id('1110'), partyId: '', debit: '5000', credit: '' },
        { accountId: id(PAYABLE), partyId: someone.id, debit: '', credit: '5000' },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.2.partyId': ['journal_party_invalid'] });
  });
});
```

- **The payable splits into one line per supplier**, like the receivable per customer in 15a, and the supplier's
  balance comes from it at once.
- **The audit row counts suppliers apart from customers** (`customers: 0, suppliers: 2`), the change 17a.3 made in
  `opening-balances.service.ts`.
- **A customer on the payable is refused under its own row**: row 2 of the page, even though an empty row 0 was
  dropped before the check.

### `purchase/requisitions.int.spec.ts` (new): the setup

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type ApprovalRule,
  approvalRuleListSchema,
  approvalRuleSchema,
  auditPageSchema,
  branchListSchema,
  costLookupSchema,
  memberPageSchema,
  notificationPageSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type Requisition,
  type RequisitionFormValues,
  type RequisitionLineFormValues,
  requisitionPageSchema,
  requisitionSchema,
  type Role,
  roleListSchema,
  roleSchema,
  setupSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
  waitingCountSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Sharif, the Owner: may decide any level, and his own requisitions are approved at once
let owner: SignedIn;
// Rupa, a merchandiser: asks for fabric and trims for a buyer's order
let rupa: SignedIn;
// Kamal and Faruk, purchase managers: the first level. Kamal also writes requisitions himself.
let kamal: SignedIn;
let faruk: SignedIn;
// Nabila, the director: the second level, for big amounts. No permission at all: approving needs
// only the role the level names.
let nabila: SignedIn;
let userIds: Map<SignedIn, string>;
let units: Unit[];
let main: Warehouse;
let purchaseManager: Role;
let director: Role;
// Single jersey bought by the kg, and by the roll of 25 kg; an average cost of ৳420 a kg
let jersey: Product;
let buttons: Product;
// A service has no stock, so no average cost
let knitting: Product;

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

function userOf(who: SignedIn): string {
  const found = userIds.get(who);
  if (!found) throw new Error('unknown user');
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

async function addRole(name: string, permissions: PermissionKey[]): Promise<Role> {
  const made = await send('POST', '/roles', { name, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
  const saved = items.find((item) => item.id === role.id);
  if (!saved) throw new Error(`no role ${name}`);
  return saved;
}

// A user who signs up for a workspace of their own, then joins this one with these roles
async function member(
  email: string,
  fullName: string,
  password: string,
  roles: readonly Role[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'ananta-apparels' });
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  if (roles.length > 0) {
    const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: roles.map((role) => role.id),
      version: found.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  }
  return logIn(app, { workspace: 'ananta-apparels', email, password, keepSignedIn: false });
}

// A line as the form sends it: by the piece unless said otherwise
function line(
  product: Product,
  quantity: string,
  estimatedCost: string,
  extra: Partial<RequisitionLineFormValues> = {},
): RequisitionLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    description: '',
    estimatedCost,
    ...extra,
  };
}

function requisitionForm(
  lines: RequisitionLineFormValues[],
  extra: Partial<RequisitionFormValues> = {},
): Omit<RequisitionFormValues, 'version'> {
  return {
    date: '2026-10-10',
    warehouseId: main.id,
    neededBy: '',
    note: '',
    lines,
    ...extra,
  };
}

async function requested(
  lines: RequisitionLineFormValues[],
  as = rupa,
  extra: Partial<RequisitionFormValues> = {},
): Promise<Requisition> {
  const res = await send('POST', '/requisitions', requisitionForm(lines, extra), as);
  expect(res.statusCode, res.body).toBe(201);
  return requisitionSchema.parse(res.json());
}

// A requisition of this amount, one line of buttons at that price
function worth(amount: string, as = rupa): Promise<Requisition> {
  return requested([line(buttons, '1', amount)], as);
}

async function requisition(id: string, as = owner): Promise<Requisition> {
  const res = await send('GET', `/requisitions/${id}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return requisitionSchema.parse(res.json());
}

// A requisition action that takes the version: submit, reopen, cancel
async function act(
  action: 'submit' | 'reopen' | 'cancel',
  doc: Requisition,
  as = rupa,
): Promise<Requisition> {
  const res = await send('POST', `/requisitions/${doc.id}/${action}`, { version: doc.version }, as);
  expect(res.statusCode, res.body).toBe(200);
  return requisitionSchema.parse(res.json());
}

function roundOf(doc: Requisition) {
  const [round] = doc.approval.rounds;
  if (!round) throw new Error(`${doc.number} has no round`);
  return round;
}

function decide(
  decision: 'approve' | 'reject',
  doc: Requisition,
  as: SignedIn,
  comment = '',
  roundId = roundOf(doc).id,
) {
  return send('POST', `/approvals/requisition/${doc.id}/${decision}`, { roundId, comment }, as);
}

async function approved(doc: Requisition, as: SignedIn, comment = ''): Promise<Requisition> {
  const res = await decide('approve', doc, as, comment);
  expect(res.statusCode, res.body).toBe(204);
  return requisition(doc.id);
}

async function saveRule(levels: { minAmount: string; roleId: string }[]): Promise<ApprovalRule> {
  const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
  const current = items.find((item) => item.document === 'requisition');
  const res = await send('PUT', '/approval-rules/requisition', {
    levels,
    version: current?.version ?? 0,
  });
  expect(res.statusCode, res.body).toBe(200);
  return approvalRuleSchema.parse(res.json());
}

// The approval notifications a person has, as [type, number]
async function bell(who: SignedIn): Promise<[string, string | number | undefined][]> {
  const page = notificationPageSchema.parse(
    (await send('GET', '/notifications?limit=50', undefined, who)).json(),
  );
  return page.items
    .filter((item) => item.type.startsWith('approval.'))
    .map((item) => [item.type, item.params.number]);
}

async function waiting(who: SignedIn) {
  return waitingApprovalPageSchema.parse(
    (await send('GET', '/approvals/waiting?limit=50', undefined, who)).json(),
  );
}

async function waitingCount(who: SignedIn): Promise<number> {
  return waitingCountSchema.parse(
    (await send('GET', '/approvals/waiting/count', undefined, who)).json(),
  ).count;
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
    companyName: 'Ananta Apparels Ltd.',
    workspaceSlug: 'ananta-apparels',
    fullName: 'Sharif Zahir',
    email: 'sharif@anantaapparels.com',
    password: 'Kanchpur-apparel-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  const merchandising = await addRole('Merchandising', ['purchase.requisition.manage']);
  purchaseManager = await addRole('Purchase manager', ['purchase.requisition.manage']);
  director = await addRole('Director', []);
  rupa = await member('rupa@anantaapparels.com', 'Rupa Sultana', 'Buyer-order-2026', [
    merchandising,
  ]);
  kamal = await member('kamal@anantaapparels.com', 'Kamal Hossain', 'Purchase-desk-2026', [
    purchaseManager,
  ]);
  faruk = await member('faruk@anantaapparels.com', 'Faruk Ahmed', 'Purchase-desk-2027', [
    purchaseManager,
  ]);
  nabila = await member('nabila@anantaapparels.com', 'Nabila Zahir', 'Board-room-2026', [director]);
  const { items: members } = memberPageSchema.parse(
    (await send('GET', '/members?limit=50')).json(),
  );
  const byEmail = (email: string) => {
    const found = members.find((item) => item.email === email);
    if (!found) throw new Error(`${email} is not a member`);
    return found.userId;
  };
  userIds = new Map([
    [owner, byEmail('sharif@anantaapparels.com')],
    [rupa, byEmail('rupa@anantaapparels.com')],
    [kamal, byEmail('kamal@anantaapparels.com')],
    [faruk, byEmail('faruk@anantaapparels.com')],
    [nabila, byEmail('nabila@anantaapparels.com')],
  ]);

  jersey = await addProduct('Single jersey 160 GSM, white', {
    baseUnitId: unitId('kg'),
    units: [{ unitId: unitId('roll'), factor: '25', barcode: '' }],
  });
  buttons = await addProduct('Polo button, 4-hole, 18L');
  knitting = await addProduct('Knitting charge', { type: 'service' });
  // Opening stock: 500 kg of jersey at ৳420 a kg
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      {
        variantId: variantOf(jersey),
        unitId: unitId('kg'),
        quantity: '500',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        unitCost: '420',
      },
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **One workspace, one story** (Ananta Apparels). The approval levels set in the first test hold for every test after
  it, until the last `describe` changes them. When a test fails, read the first failure first.
- **Five people, each for one rule.** Sharif is the Owner: he may decide any level, and his own requisition is
  approved at once (decision 14). Rupa is a merchandiser with `purchase.requisition.manage` and no approving role.
  Kamal and Faruk are both purchase managers, so a step has two people who may decide it: the bell must reach both,
  and the race test needs two. Kamal can also write requisitions, for the "not your own" test. Nabila is the
  director with *no permission at all*: approving needs only the role a level names (decision 5).
- **`userOf()` maps a signed-in person to a user id**, read once from the member list.
- **Three products.** Single jersey is counted by the kg and bought by the roll of 25 kg, with 500 kg in stock at
  ৳420: the cost lookup must turn that into ৳10,500 a roll. Buttons are by the piece; `worth()` makes a requisition
  of any amount with one line of buttons, so a test shows only the amount it cares about. The knitting charge is a
  service: it can be on a requisition, but it has no average cost.
- **`act()`, `decide()` and `approved()`** are the requisition page's buttons. `decide()` sends the round the page
  showed (`roundOf()`), which is how a late click is caught (decision 16).
- **`bell()` lists a person's approval notifications as `[type, number]`**, so a test reads like "Kamal was asked
  about this requisition".

### Approval rules and requisitions

```ts
describe('approval rules', () => {
  it('start with no levels, and the first save is made from version 0', async () => {
    const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
    expect(items).toEqual([{ document: 'requisition', levels: [], version: 0, updatedAt: null }]);

    const stale = await send('PUT', '/approval-rules/requisition', { levels: [], version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');

    // Up to ৳20,000 nobody needs to approve; from ৳20,000 a purchase manager; from ৳1,00,000 the
    // director as well
    const saved = await saveRule([
      { minAmount: '20000', roleId: purchaseManager.id },
      { minAmount: '100000', roleId: director.id },
    ]);
    expect(saved).toMatchObject({
      version: 1,
      levels: [
        { minAmount: '20000.0000', role: { id: purchaseManager.id, name: 'Purchase manager' } },
        { minAmount: '100000.0000', role: { id: director.id, name: 'Director' } },
      ],
    });
    // A second "first save" from a page opened before it
    const again = await send('PUT', '/approval-rules/requisition', { levels: [], version: 0 });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).code).toBe('version_conflict');

    const log = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace&limit=5')).json(),
    );
    const changed = log.items.find((entry) => entry.action === 'approval_rules.changed');
    expect(changed?.changes).toEqual({
      requisition: {
        from: null,
        to: 'Purchase manager from 20000.0000; Director from 100000.0000',
      },
    });
  });

  it('refuse levels out of order, a role twice, an unknown role, and anyone but settings', async () => {
    const res = await send('PUT', '/approval-rules/requisition', {
      levels: [
        { minAmount: '50000', roleId: purchaseManager.id },
        { minAmount: '10000', roleId: director.id },
        { minAmount: '90000', roleId: purchaseManager.id },
      ],
      version: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      'levels.1.minAmount': ['approval_level_order'],
      'levels.2.roleId': ['approval_role_twice'],
    });

    const unknown = await send('PUT', '/approval-rules/requisition', {
      levels: [
        { minAmount: '0', roleId: purchaseManager.id },
        { minAmount: '0', roleId: '01939d1c-0000-7000-8000-000000000000' },
      ],
      version: 1,
    });
    expect(unknown.statusCode).toBe(409);
    expect(problemOf(unknown).fieldErrors).toEqual({
      'levels.1.roleId': ['approval_role_invalid'],
    });

    const notMine = await send(
      'PUT',
      '/approval-rules/requisition',
      { levels: [], version: 1 },
      kamal,
    );
    expect(notMine.statusCode).toBe(403);
    // Reading them needs nothing: the requisition form says "Needs 2 approvals"
    expect((await send('GET', '/approval-rules', undefined, rupa)).statusCode).toBe(200);
  });

  it('keep a role a level names from being deleted', async () => {
    const res = await send('DELETE', `/roles/${director.id}?version=${String(director.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('role_in_use');
  });
});

describe('requisitions', () => {
  it('are numbered when saved, with the amount of their lines', async () => {
    const doc = await requested(
      [
        line(jersey, '2', '10500', { unitId: unitId('roll') }),
        line(jersey, '40', '410.50', { unitId: unitId('kg') }),
      ],
      rupa,
      { neededBy: '2026-10-20', note: 'Buyer PO 4410, H&M polo' },
    );
    expect(doc).toMatchObject({
      status: 'draft',
      amount: '37420.0000',
      lineCount: 2,
      neededBy: '2026-10-20',
      requestedBy: { id: userOf(rupa), name: 'Rupa Sultana' },
      approval: { rounds: [], canDecide: false },
    });
    expect(doc.number).toMatch(/^PR-/);
    expect(doc.lines.map((item) => [item.quantity, item.baseQuantity, item.amount])).toEqual([
      ['2.0000', '50.0000', '21000.0000'],
      ['40.0000', '40.0000', '16420.0000'],
    ]);
    expect(doc.lines[0]?.description).toBe('Single jersey 160 GSM, white');

    // A draft changes freely; a page opened before the change cannot save over it
    const res = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '5000', '1.20')]), version: doc.version },
      rupa,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(requisitionSchema.parse(res.json())).toMatchObject({
      amount: '6000.0000',
      lineCount: 1,
    });
    const stale = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '1', '1')]), version: doc.version },
      rupa,
    );
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');

    const list = requisitionPageSchema.parse(
      (await send('GET', '/requisitions?status=draft')).json(),
    );
    expect(list.items.map((item) => item.number)).toContain(doc.number);
  });

  it('check the form: dates, costs and lines', async () => {
    const res = await send(
      'POST',
      '/requisitions',
      requisitionForm([line(buttons, '10', '')], { neededBy: '2026-10-01' }),
      rupa,
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      neededBy: ['requisition_needed_by'],
      'lines.0.estimatedCost': ['requisition_cost_required'],
    });
    const empty = await send('POST', '/requisitions', requisitionForm([]), rupa);
    expect(problemOf(empty).fieldErrors).toEqual({ lines: ['purchase_lines_required'] });
  });

  it('check the warehouse and every item, each problem under its line', async () => {
    const old = await addProduct('Zipper, metal, 7 inch');
    const archived = await send('POST', `/products/${old.id}/archive`, { version: old.version });
    expect(archived.statusCode, archived.body).toBe(200);
    const res = await send(
      'POST',
      '/requisitions',
      requisitionForm([
        line(old, '10', '12'),
        line(buttons, '10', '1', { unitId: unitId('roll') }),
        line(buttons, '1.5', '1'),
        line(knitting, '1', '25000'),
      ]),
      rupa,
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.variantId': ['purchase_item_invalid'],
      'lines.1.unitId': ['stock_unit_invalid'],
      'lines.2.quantity': ['stock_quantity_decimals'],
    });

    const nowhere = await send(
      'POST',
      '/requisitions',
      requisitionForm([line(buttons, '10', '1')], {
        warehouseId: '01939d1c-0000-7000-8000-000000000000',
      }),
      rupa,
    );
    expect(nowhere.statusCode).toBe(409);
    expect(problemOf(nowhere).fieldErrors).toEqual({ warehouseId: ['purchase_warehouse_invalid'] });
  });

  it('keep a warehouse archived since on a draft, but not on a new one', async () => {
    const [branch] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
    if (!branch) throw new Error('no branch');
    const made = await send('POST', '/warehouses', {
      branchId: branch.id,
      code: 'TRIM',
      name: 'Trims store',
      address: '',
    });
    expect(made.statusCode, made.body).toBe(201);
    const store = warehouseSchema.parse(made.json());
    const doc = await requested([line(buttons, '100', '1.10')], rupa, { warehouseId: store.id });
    const archived = await send('POST', `/warehouses/${store.id}/archive`, {
      version: store.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const kept = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      {
        ...requisitionForm([line(buttons, '120', '1.10')], { warehouseId: store.id }),
        version: doc.version,
      },
      rupa,
    );
    expect(kept.statusCode, kept.body).toBe(200);
    const fresh = await send(
      'POST',
      '/requisitions',
      requisitionForm([line(buttons, '10', '1')], { warehouseId: store.id }),
      rupa,
    );
    expect(problemOf(fresh).fieldErrors).toEqual({ warehouseId: ['purchase_warehouse_invalid'] });
  });

  it('keep a product its lines name from being deleted', async () => {
    const thread = await addProduct('Sewing thread, 40/2, white');
    await requested([line(thread, '200', '85')]);
    const res = await send('DELETE', `/products/${thread.id}?version=${String(thread.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('product_in_use');
  });

  it('delete a draft that was never submitted', async () => {
    const doc = await worth('500');
    const res = await send(
      'DELETE',
      `/requisitions/${doc.id}?version=${String(doc.version)}`,
      undefined,
      rupa,
    );
    expect(res.statusCode, res.body).toBe(204);
    expect((await send('GET', `/requisitions/${doc.id}`)).statusCode).toBe(404);
  });
});
```

- **No levels at first, version 0.** The first save is made from version 0, and a page that also thinks it is first
  gets `version_conflict`: the row exists now. The levels are: from ৳20,000 a purchase manager, from ৳1,00,000 the
  director as well. The audit row writes them as one line ("Purchase manager from 20000.0000; Director from
  100000.0000").
- **Wrong levels come back per row**: an amount lower than the row above is `approval_level_order`, a role twice is
  `approval_role_twice` (both from the contract), and an unknown role is `approval_role_invalid` from the API, under
  its own row.
- **Only settings may change them**; reading them needs nothing, because the requisition form shows how many
  approvals a document will need.
- **A role a level names is not deleted**: `role_in_use`, from the foreign key `approval_levels_role_fk`.
- **A requisition gets its number when saved** and its amount from its lines: 2 rolls at ৳10,500 and 40 kg at
  ৳410.50 make ৳37,420. The roll line's base quantity is 50 kg. An empty description becomes the product's name.
- **A draft changes freely**; a page opened before the change gets `version_conflict`.
- **Form rules come from the contract** (a needed-by date before the date, an empty cost, no lines). **Item rules come
  from the API, each under its line**: an archived product, a unit that is not the item's, 1.5 pieces. The service
  line on the same request is fine.
- **An archived warehouse stays on a draft that has it**, but a new requisition cannot pick it.
- **A requisition line keeps its product**: deleting the product is `product_in_use`
  (`requisition_lines_variant_fk`, added to `VARIANT_IN_USE` in 17a.3).
- **A draft that was never submitted can be deleted**.

### Approval

```ts
describe('approval', () => {
  it('approves a requisition below every level at once, with no steps', async () => {
    const doc = await act('submit', await worth('5000'));
    expect(doc.status).toBe('approved');
    expect(roundOf(doc)).toMatchObject({ status: 'approved', amount: '5000.0000', steps: [] });
    expect(roundOf(doc).closedAt).not.toBeNull();
  });

  it("approves an Owner's own requisition at once, every step signed by the Owner", async () => {
    const doc = await act('submit', await worth('150000', owner), owner);
    expect(doc.status).toBe('approved');
    expect(
      roundOf(doc).steps.map((step) => [step.role.name, step.decision, step.decidedBy?.name]),
    ).toEqual([
      ['Purchase manager', 'approved', 'Sharif Zahir'],
      ['Director', 'approved', 'Sharif Zahir'],
    ]);
    // Nobody is asked about it
    expect(await bell(kamal)).not.toContainEqual(['approval.requested', doc.number]);
  });

  it('waits for each level in order, and tells each level when it is its turn', async () => {
    const draft = await worth('150000');
    const doc = await act('submit', draft);
    expect(doc.status).toBe('pending');
    expect(roundOf(doc)).toMatchObject({ status: 'pending', closedAt: null });
    expect(
      roundOf(doc).steps.map((step) => [step.position, step.role.name, step.decision]),
    ).toEqual([
      [1, 'Purchase manager', null],
      [2, 'Director', null],
    ]);
    // A pending requisition is not changed: it is reopened first
    const locked = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '1', '1')]), version: doc.version },
      rupa,
    );
    expect(problemOf(locked).code).toBe('purchase_not_draft');

    // Both purchase managers hear of it; the director not yet; Rupa, who sent it, not at all
    expect(await bell(kamal)).toContainEqual(['approval.requested', doc.number]);
    expect(await bell(faruk)).toContainEqual(['approval.requested', doc.number]);
    expect(await bell(nabila)).not.toContainEqual(['approval.requested', doc.number]);
    expect((await waiting(kamal)).items.find((item) => item.id === doc.id)).toMatchObject({
      document: 'requisition',
      number: doc.number,
      subject: main.name,
      amount: '150000.0000',
      submittedBy: { name: 'Rupa Sultana' },
      position: 1,
      stepCount: 2,
    });
    expect((await waiting(nabila)).items.map((item) => item.id)).not.toContain(doc.id);
    expect((await requisition(doc.id, kamal)).approval.canDecide).toBe(true);
    expect((await requisition(doc.id, nabila)).approval.canDecide).toBe(false);

    // Not the director's turn yet, and never Rupa's
    const early = await decide('approve', doc, nabila);
    expect(early.statusCode).toBe(403);
    expect(problemOf(early).code).toBe('approval_not_allowed');
    expect(problemOf(await decide('approve', doc, rupa)).code).toBe('approval_own_document');

    const halfway = await approved(doc, kamal, 'Rate checked against the last two POs');
    expect(halfway.status).toBe('pending');
    expect(await bell(nabila)).toContainEqual(['approval.requested', doc.number]);
    expect((await waiting(nabila)).items.find((item) => item.id === doc.id)?.position).toBe(2);
    expect((await waiting(faruk)).items.map((item) => item.id)).not.toContain(doc.id);

    const done = await approved(halfway, nabila);
    expect(done.status).toBe('approved');
    expect(roundOf(done)).toMatchObject({ status: 'approved' });
    expect(
      roundOf(done).steps.map((step) => [step.decision, step.decidedBy?.name, step.comment]),
    ).toEqual([
      ['approved', 'Kamal Hossain', 'Rate checked against the last two POs'],
      ['approved', 'Nabila Zahir', null],
    ]);
    // Rupa hears it was approved; the version moved, so a page opened before cannot reopen it
    expect(await bell(rupa)).toContainEqual(['approval.approved', doc.number]);
    const stale = await send(
      'POST',
      `/requisitions/${doc.id}/reopen`,
      { version: halfway.version },
      rupa,
    );
    expect(problemOf(stale).code).toBe('version_conflict');

    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=requisition&entityId=${doc.id}`)).json(),
    );
    expect(log.items.map((entry) => entry.action)).toEqual([
      'approval.approved',
      'approval.approved',
      'approval.submitted',
      'requisition.created',
    ]);
  });

  it('never lets the person who submitted it approve it, unless an Owner', async () => {
    const doc = await act('submit', await worth('30000', kamal), kamal);
    expect(roundOf(doc).steps).toHaveLength(1);
    const own = await decide('approve', doc, kamal);
    expect(own.statusCode).toBe(403);
    expect(problemOf(own).code).toBe('approval_own_document');
    expect((await waiting(kamal)).items.map((item) => item.id)).not.toContain(doc.id);
    expect((await requisition(doc.id, kamal)).approval.canDecide).toBe(false);
    // Faruk is told; Kamal, who holds the same role, is not told about his own
    expect(await bell(faruk)).toContainEqual(['approval.requested', doc.number]);
    expect(await bell(kamal)).not.toContainEqual(['approval.requested', doc.number]);
    // The Owner sees every waiting step
    expect((await waiting(owner)).items.map((item) => item.id)).toContain(doc.id);
  });

  it('sends a rejected requisition back to draft with the reason; the next round starts at level 1', async () => {
    const doc = await act('submit', await worth('120000'));
    const noReason = await decide('reject', doc, faruk, ' ');
    expect(noReason.statusCode).toBe(400);
    expect(problemOf(noReason).fieldErrors).toEqual({ comment: ['approval_comment_required'] });

    const res = await decide('reject', doc, faruk, 'Use the 18L buttons left from PO 4302 first');
    expect(res.statusCode, res.body).toBe(204);
    const back = await requisition(doc.id);
    expect(back.status).toBe('draft');
    expect(roundOf(back)).toMatchObject({ status: 'rejected' });
    expect(roundOf(back).steps.map((step) => [step.decision, step.comment])).toEqual([
      ['rejected', 'Use the 18L buttons left from PO 4302 first'],
      [null, null],
    ]);
    expect(await bell(rupa)).toContainEqual(['approval.rejected', doc.number]);
    // The page Kamal had open still shows the old round: nothing happens
    const late = await decide('approve', doc, kamal);
    expect(late.statusCode).toBe(409);
    expect(problemOf(late).code).toBe('approval_not_pending');

    // Changed and sent again: a new round from the first level, the old one kept below it
    const changed = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '1', '80000')]), version: back.version },
      rupa,
    );
    expect(changed.statusCode, changed.body).toBe(200);
    const again = await act('submit', requisitionSchema.parse(changed.json()));
    expect(again.approval.rounds.map((round) => [round.status, round.steps.length])).toEqual([
      ['pending', 1],
      ['rejected', 2],
    ]);
    // Once submitted, it is never deleted: its history stays
    const reopened = await act('reopen', again);
    const removed = await send(
      'DELETE',
      `/requisitions/${doc.id}?version=${String(reopened.version)}`,
      undefined,
      rupa,
    );
    expect(removed.statusCode).toBe(409);
    expect(problemOf(removed).code).toBe('purchase_was_submitted');
  });

  it('reopens a pending requisition (its round ends) and an approved one (its round stays)', async () => {
    const pending = await act('submit', await worth('45000'));
    const back = await act('reopen', pending);
    expect(back.status).toBe('draft');
    expect(roundOf(back)).toMatchObject({ status: 'reopened' });
    expect(await waitingCount(faruk)).toBe((await waiting(faruk)).items.length);
    expect((await waiting(faruk)).items.map((item) => item.id)).not.toContain(pending.id);

    const small = await act('submit', await worth('9000'));
    expect(small.status).toBe('approved');
    const changedMind = await act('reopen', small);
    expect(changedMind.status).toBe('draft');
    expect(roundOf(changedMind)).toMatchObject({ status: 'approved' });
  });

  it('cancels only a draft or an approved requisition', async () => {
    const pending = await act('submit', await worth('25000'));
    const refused = await send(
      'POST',
      `/requisitions/${pending.id}/cancel`,
      { version: pending.version },
      rupa,
    );
    expect(problemOf(refused).code).toBe('purchase_cannot_cancel');

    const cancelled = await act('cancel', await act('reopen', pending));
    expect(cancelled.status).toBe('cancelled');
    const reopen = await send(
      'POST',
      `/requisitions/${cancelled.id}/reopen`,
      { version: cancelled.version },
      rupa,
    );
    expect(problemOf(reopen).code).toBe('purchase_cannot_reopen');
    const submit = await send(
      'POST',
      `/requisitions/${cancelled.id}/submit`,
      { version: cancelled.version },
      rupa,
    );
    expect(problemOf(submit).code).toBe('purchase_not_draft');
  });

  it('lets one of two people deciding the same step at once win', async () => {
    const doc = await act('submit', await worth('60000'));
    const answers = await Promise.all([
      decide('approve', doc, kamal),
      decide('approve', doc, faruk),
    ]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([204, 409]);
    const loser = answers.find((res) => res.statusCode === 409);
    if (loser) expect(problemOf(loser).code).toBe('approval_not_pending');
    const done = await requisition(doc.id);
    expect(done.status).toBe('approved');
    expect(roundOf(done).steps.filter((step) => step.decision !== null)).toHaveLength(1);
  });

  it('counts what waits for each person, and pages the list oldest first', async () => {
    const first = await act('submit', await worth('21000'));
    const second = await act('submit', await worth('22000'));
    const mine = await waiting(faruk);
    expect(await waitingCount(faruk)).toBe(mine.items.length);
    const ids = mine.items.map((item) => item.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));

    const page = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting?limit=1', undefined, faruk)).json(),
    );
    expect(page.items).toHaveLength(1);
    if (page.nextCursor === null) throw new Error('expected a second page');
    const next = waitingApprovalPageSchema.parse(
      (
        await send('GET', `/approvals/waiting?limit=1&cursor=${page.nextCursor}`, undefined, faruk)
      ).json(),
    );
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    // Rupa holds no approving role: nothing waits for her
    expect(await waitingCount(rupa)).toBe(0);
  });
});
```

- **Below every level: approved at once**, with a round that has no steps and is closed. The history still shows
  that it went through approval.
- **The Owner's own**: approved at once, and both steps say "approved by Sharif Zahir". Nobody is asked.
- **In order, one level at a time.** Rupa's ৳1,50,000 needs both levels. Both purchase managers are told, the
  director not yet, and Rupa never about her own. The waiting list shows it to Kamal at step 1 of 2, and
  `canDecide` is true for him and false for Nabila. Nabila is `approval_not_allowed` (not her turn), Rupa
  `approval_own_document`. After Kamal approves, Nabila is told and sees it at step 2; Faruk no longer sees it.
  After Nabila, it is approved, Rupa is told, and the version moved: a page opened before cannot reopen it. The audit
  log has created, submitted and two approvals.
- **Never your own**: Kamal's ৳30,000 needs a purchase manager, and he is one, but it is `approval_own_document`,
  it is not on his waiting list, and only Faruk is told. The Owner sees it.
- **A rejection needs a reason** (`approval_comment_required` for a blank one) and sends the requisition back to
  draft. The round is rejected and the step after it stays undecided. Rupa is told. Kamal's late click on the old
  round is `approval_not_pending`. Changed and sent again, it gets a new round from level 1 above the old one. Once
  submitted, it is never deleted (`purchase_was_submitted`).
- **Reopen**: a pending round ends as "reopened" and leaves every waiting list; an approved round stays "approved",
  because it was.
- **Cancel**: refused while pending (reopen it first), then allowed from draft. A cancelled requisition cannot be
  reopened or submitted.
- **Two people deciding at once.** Kamal and Faruk approve the same step together: one gets 204, the other
  `approval_not_pending`, and exactly one step is decided. The requisition row is locked first, then the round, so
  the second waits and then sees a closed round.
- **The waiting list is oldest first and pages with a cursor**, and the count matches it. Rupa holds no approving
  role, so nothing waits for her.

### A level nobody holds, and the cost lookup

```ts
describe('a level nobody holds', () => {
  it('rings the Owners, keeps its role while a step waits for it, then lets it go', async () => {
    const compliance = await addRole('Compliance', []);
    await saveRule([{ minAmount: '0', roleId: compliance.id }]);
    const doc = await act('submit', await worth('1000'));
    expect(await bell(owner)).toContainEqual(['approval.requested', doc.number]);

    // The level no longer names it, but the waiting step still does
    await saveRule([{ minAmount: '20000', roleId: purchaseManager.id }]);
    const refused = await send(
      'DELETE',
      `/roles/${compliance.id}?version=${String(compliance.version)}`,
    );
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('role_in_use');

    const done = await approved(doc, owner);
    expect(done.status).toBe('approved');
    const deleted = await send(
      'DELETE',
      `/roles/${compliance.id}?version=${String(compliance.version)}`,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
    // The history keeps the role's name after the role is gone
    expect(roundOf(await requisition(doc.id)).steps.map((step) => step.role)).toEqual([
      { id: null, name: 'Compliance' },
    ]);
  });
});

describe('cost lookup', () => {
  it('starts a line at the average cost, per the unit asked for', async () => {
    const res = await send('POST', '/purchase/cost-lookup', {
      items: [
        { variantId: variantOf(jersey), unitId: unitId('roll') },
        { variantId: variantOf(knitting), unitId: unitId('pcs') },
        { variantId: '01939d1c-0000-7000-8000-000000000000', unitId: unitId('pcs') },
        { variantId: variantOf(jersey), unitId: unitId('pcs') },
        { variantId: variantOf(jersey), unitId: unitId('kg') },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    // An unknown item and a unit that is not the product's are left out; the order stays
    expect(costLookupSchema.parse(res.json()).items).toEqual([
      {
        variantId: variantOf(jersey),
        unitId: unitId('roll'),
        cost: '10500.0000',
        source: 'average_cost',
      },
      { variantId: variantOf(knitting), unitId: unitId('pcs'), cost: null, source: null },
      {
        variantId: variantOf(jersey),
        unitId: unitId('kg'),
        cost: '420.0000',
        source: 'average_cost',
      },
    ]);
  });

  it('gives no cost to someone who may not see stock values', async () => {
    const res = await send(
      'POST',
      '/purchase/cost-lookup',
      { items: [{ variantId: variantOf(jersey), unitId: unitId('kg') }] },
      rupa,
    );
    expect(costLookupSchema.parse(res.json()).items).toEqual([
      { variantId: variantOf(jersey), unitId: unitId('kg'), cost: null, source: null },
    ]);
  });
});
```

- **Nobody holds "Compliance", so the Owners are told** (decision 28): a requisition must never wait without anyone
  knowing.
- **The role stays while a step waits for it**, even after the levels no longer name it: `role_in_use` from the
  waiting-step count in `roles.service.ts`. Once the Owner decides it, the role can go, and the history still shows
  "Compliance" with `id: null`. This is why the contracts' step role has a nullable id (17a.3).
- **The cost lookup** gives ৳10,500 for a roll and ৳420 for a kg of jersey, `null` for the service, and leaves out an
  unknown variant and a unit that is not the product's. The answers keep the order of the question. Rupa may not see
  stock values, so she gets the item with no cost, and types it herself.

### `purchase/purchase.tenant-leak.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  costLookupSchema,
  type Customer,
  customerSchema,
  memberPageSchema,
  type Product,
  productSchema,
  problemSchema,
  type Requisition,
  requisitionPageSchema,
  requisitionSchema,
  type Role,
  roleSchema,
  setupSchema,
  type Supplier,
  type SupplierGroup,
  supplierGroupListSchema,
  supplierGroupSchema,
  supplierPageSchema,
  supplierSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
  waitingCountSchema,
  type Warehouse,
  warehouseListSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Two workspaces: A must never see, use or change B's suppliers, supplier groups, bank accounts,
// approval levels or requisitions, decide B's approvals, or learn B's costs. Every answer is 404,
// or the same "pick one from the list" as for an id that does not exist — never a hint that it
// does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let accountsOfA: Account[];
let warehouseOfA: Warehouse;
let productOfA: Product;
let groupOfB: SupplierGroup;
let supplierOfB: Supplier;
let customerOfB: Customer;
let roleOfB: Role;
let warehouseOfB: Warehouse;
let productOfB: Product;
// B's requisition, waiting for B's purchase manager
let requisitionOfB: Requisition;

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

function problemOf(res: Awaited<ReturnType<typeof as>>) {
  return problemSchema.parse(res.json());
}

async function setUp(who: SignedIn): Promise<void> {
  expect((await as(who, 'POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

function accountOfA(code: string): string {
  const found = accountsOfA.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function supplierForm(name: string, extra: object = {}) {
  return {
    code: '',
    name,
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
    ...extra,
  };
}

async function addProduct(who: SignedIn, name: string, units: Unit[]): Promise<Product> {
  const res = await as(who, 'POST', '/products', {
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
    taxRateId: '',
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

function requisitionForm(warehouse: Warehouse, product: Product, units: Unit[], extra = {}) {
  return {
    date: '2026-10-10',
    warehouseId: warehouse.id,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: variantOf(product),
        unitId: pcsOf(units),
        quantity: '10',
        description: '',
        estimatedCost: '2500',
      },
    ],
    ...extra,
  };
}

// A user of B who may write requisitions: signs up for a workspace of their own, then joins B
async function memberOfB(email: string, fullName: string, password: string): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'banani-denim' });
  const made = await as(tenantB, 'POST', '/roles', { name: 'Merchandising', description: '' });
  const role = roleSchema.parse(made.json());
  const matrix = await as(tenantB, 'PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions: ['purchase.requisition.manage'] }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await as(tenantB, 'GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await as(tenantB, 'PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'banani-denim', email, password, keepSignedIn: false });
}

async function firstWarehouse(who: SignedIn): Promise<Warehouse> {
  const [found] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!found) throw new Error('no warehouse');
  return found;
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
  [tenantA, tenantB] = await Promise.all([
    signUp(app, {
      companyName: 'Ashulia Knit Ltd.',
      workspaceSlug: 'ashulia-knit',
      fullName: 'Arif Chowdhury',
      email: 'arif@ashuliaknit.com',
      password: 'Ashulia-knit-2026',
    }),
    signUp(app, {
      companyName: 'Banani Denim Ltd.',
      workspaceSlug: 'banani-denim',
      fullName: 'Bilkis Rahman',
      email: 'bilkis@bananidenim.com',
      password: 'Banani-denim-2026',
    }),
  ]);
  await Promise.all([setUp(tenantA), setUp(tenantB)]);
  unitsOfA = unitListSchema.parse((await as(tenantA, 'GET', '/units')).json()).items;
  const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
  accountsOfA = accountListSchema.parse((await as(tenantA, 'GET', '/accounts')).json()).items;
  warehouseOfA = await firstWarehouse(tenantA);
  warehouseOfB = await firstWarehouse(tenantB);
  productOfA = await addProduct(tenantA, 'Single jersey, black', unitsOfA);
  productOfB = await addProduct(tenantB, 'Denim 12 oz, indigo', unitsOfB);

  groupOfB = supplierGroupSchema.parse(
    (await as(tenantB, 'POST', '/supplier-groups', { name: 'Denim mills' })).json(),
  );
  const supplier = await as(
    tenantB,
    'POST',
    '/suppliers',
    supplierForm('Envoy Denim Mill', {
      groupId: groupOfB.id,
      bankAccounts: [
        {
          id: null,
          bankName: 'Dutch-Bangla Bank',
          branchName: '',
          accountName: 'Envoy Denim Mill',
          accountNumber: '1011100055566',
          routingNumber: '',
        },
      ],
    }),
  );
  expect(supplier.statusCode, supplier.body).toBe(201);
  supplierOfB = supplierSchema.parse(supplier.json());
  const customer = await as(tenantB, 'POST', '/customers', {
    code: '',
    name: 'Levi Strauss Sourcing',
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
  expect(customer.statusCode, customer.body).toBe(201);
  customerOfB = customerSchema.parse(customer.json());

  // B's approval level: a purchase manager from ৳0, so B's requisition waits
  const role = await as(tenantB, 'POST', '/roles', { name: 'Purchase manager', description: '' });
  expect(role.statusCode, role.body).toBe(201);
  roleOfB = roleSchema.parse(role.json());
  const rule = await as(tenantB, 'PUT', '/approval-rules/requisition', {
    levels: [{ minAmount: '0', roleId: roleOfB.id }],
    version: 0,
  });
  expect(rule.statusCode, rule.body).toBe(200);
  // An Owner's own requisition is approved at once, so B's merchandiser writes and submits it
  const merchandiser = await memberOfB('babul@bananidenim.com', 'Babul Mia', 'Denim-desk-2026');
  const made = await as(
    merchandiser,
    'POST',
    '/requisitions',
    requisitionForm(warehouseOfB, productOfB, unitsOfB),
  );
  expect(made.statusCode, made.body).toBe(201);
  const submitted = await as(
    merchandiser,
    'POST',
    `/requisitions/${requisitionSchema.parse(made.json()).id}/submit`,
    { version: 1 },
  );
  expect(submitted.statusCode, submitted.body).toBe(200);
  requisitionOfB = requisitionSchema.parse(submitted.json());
  expect(requisitionOfB.status).toBe('pending');
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('suppliers across workspaces', () => {
  it("never shows B's supplier, its group or its statement to A", async () => {
    const path = `/suppliers/${supplierOfB.id}`;
    expect((await as(tenantA, 'GET', path)).statusCode).toBe(404);
    expect((await as(tenantA, 'GET', `${path}/statement`)).statusCode).toBe(404);
    const list = supplierPageSchema.parse((await as(tenantA, 'GET', '/suppliers')).json());
    expect(list.items.map((item) => item.id)).not.toContain(supplierOfB.id);
    const byGroup = supplierPageSchema.parse(
      (await as(tenantA, 'GET', `/suppliers?groupId=${groupOfB.id}`)).json(),
    );
    expect(byGroup.items).toEqual([]);
    const groups = supplierGroupListSchema.parse(
      (await as(tenantA, 'GET', '/supplier-groups')).json(),
    );
    expect(groups.items.map((item) => item.id)).not.toContain(groupOfB.id);
  });

  it("never changes, archives or deletes B's supplier or group", async () => {
    const path = `/suppliers/${supplierOfB.id}`;
    const version = { version: supplierOfB.version };
    expect(
      (await as(tenantA, 'PUT', path, { ...supplierForm('Mine now'), ...version })).statusCode,
    ).toBe(404);
    expect((await as(tenantA, 'POST', `${path}/archive`, version)).statusCode).toBe(404);
    expect((await as(tenantA, 'POST', `${path}/restore`, version)).statusCode).toBe(404);
    expect((await as(tenantA, 'DELETE', `${path}?version=1`)).statusCode).toBe(404);
    expect(
      (
        await as(tenantA, 'PUT', `/supplier-groups/${groupOfB.id}`, {
          name: 'Mine now',
          version: groupOfB.version,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await as(tenantA, 'DELETE', `/supplier-groups/${groupOfB.id}?version=1`)).statusCode,
    ).toBe(404);
    // B's records are as they were
    const still = supplierSchema.parse((await as(tenantB, 'GET', path)).json());
    expect(still).toMatchObject({ name: 'Envoy Denim Mill', archivedAt: null, version: 1 });
  });

  it("never makes B's customer a supplier, or B's supplier a customer", async () => {
    const toSupplier = await as(tenantA, 'POST', `/customers/${customerOfB.id}/make-supplier`, {
      version: customerOfB.version,
    });
    expect(toSupplier.statusCode).toBe(404);
    const toCustomer = await as(tenantA, 'POST', `/suppliers/${supplierOfB.id}/make-customer`, {
      version: supplierOfB.version,
    });
    expect(toCustomer.statusCode).toBe(404);
  });

  it("never puts A's supplier in B's group, or takes B's bank account", async () => {
    const grouped = await as(
      tenantA,
      'POST',
      '/suppliers',
      supplierForm('Ashulia Yarn', { groupId: groupOfB.id }),
    );
    expect(grouped.statusCode).toBe(400);
    expect(problemOf(grouped).fieldErrors).toEqual({ groupId: ['supplier_group_invalid'] });

    const foreign = supplierOfB.bankAccounts[0];
    if (!foreign) throw new Error('B has no bank account');
    const res = await as(
      tenantA,
      'POST',
      '/suppliers',
      supplierForm('Ashulia Yarn', {
        bankAccounts: [{ ...foreign, branchName: '', routingNumber: '', accountName: 'Ashulia' }],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(supplierSchema.parse(res.json()).bankAccounts[0]?.id).not.toBe(foreign.id);
    const still = supplierSchema.parse(
      (await as(tenantB, 'GET', `/suppliers/${supplierOfB.id}`)).json(),
    );
    expect(still.bankAccounts).toEqual(supplierOfB.bankAccounts);
  });

  it("never puts B's supplier on a payable line of A's books", async () => {
    const res = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-10-01',
      narration: 'Yarn on credit',
      post: true,
      lines: [
        {
          accountId: accountOfA('1110'),
          branchId: '',
          partyId: '',
          description: '',
          debit: '1000',
          credit: '',
        },
        {
          accountId: accountOfA('2110'),
          branchId: '',
          partyId: supplierOfB.id,
          description: '',
          debit: '',
          credit: '1000',
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.1.partyId': ['journal_party_invalid'] });
  });
});

describe('approvals and requisitions across workspaces', () => {
  it("never puts B's role on A's approval levels", async () => {
    const res = await as(tenantA, 'PUT', '/approval-rules/requisition', {
      levels: [{ minAmount: '0', roleId: roleOfB.id }],
      version: 0,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'levels.0.roleId': ['approval_role_invalid'] });
  });

  it("never shows or changes B's requisition", async () => {
    const path = `/requisitions/${requisitionOfB.id}`;
    const version = { version: requisitionOfB.version };
    expect((await as(tenantA, 'GET', path)).statusCode).toBe(404);
    const list = requisitionPageSchema.parse((await as(tenantA, 'GET', '/requisitions')).json());
    expect(list.items).toEqual([]);
    expect(
      (
        await as(tenantA, 'PUT', path, {
          ...requisitionForm(warehouseOfA, productOfA, unitsOfA),
          ...version,
        })
      ).statusCode,
    ).toBe(404);
    for (const action of ['submit', 'reopen', 'cancel']) {
      expect((await as(tenantA, 'POST', `${path}/${action}`, version)).statusCode).toBe(404);
    }
    expect((await as(tenantA, 'DELETE', `${path}?version=1`)).statusCode).toBe(404);
    const still = requisitionSchema.parse((await as(tenantB, 'GET', path)).json());
    expect(still).toMatchObject({ status: 'pending', version: requisitionOfB.version });
  });

  it("never lets A's requisition use B's warehouse or item", async () => {
    const warehouse = await as(
      tenantA,
      'POST',
      '/requisitions',
      requisitionForm(warehouseOfB, productOfA, unitsOfA),
    );
    expect(warehouse.statusCode).toBe(409);
    expect(problemOf(warehouse).fieldErrors).toEqual({
      warehouseId: ['purchase_warehouse_invalid'],
    });
    const item = await as(
      tenantA,
      'POST',
      '/requisitions',
      requisitionForm(warehouseOfA, productOfB, unitsOfA),
    );
    expect(item.statusCode).toBe(409);
    expect(problemOf(item).fieldErrors).toEqual({ 'lines.0.variantId': ['purchase_item_invalid'] });
  });

  it("never lets A decide B's approval, or use B's round on its own", async () => {
    const [roundOfB] = requisitionOfB.approval.rounds;
    if (!roundOfB) throw new Error('B has no round');

    const path = `/approvals/requisition/${requisitionOfB.id}`;
    const approve = await as(tenantA, 'POST', `${path}/approve`, {
      roundId: roundOfB.id,
      comment: '',
    });
    expect(approve.statusCode).toBe(404);
    const reject = await as(tenantA, 'POST', `${path}/reject`, {
      roundId: roundOfB.id,
      comment: 'Not ours',
    });
    expect(reject.statusCode).toBe(404);
    // B's round still waits for B
    const still = requisitionSchema.parse(
      (await as(tenantB, 'GET', `/requisitions/${requisitionOfB.id}`)).json(),
    );
    expect(still.approval.rounds[0]).toMatchObject({ status: 'pending' });
    expect(still.approval.rounds[0]?.steps[0]?.decision).toBeNull();

    // A's own draft, with B's round: no round of A's is pending, so nothing happens
    const mine = await as(
      tenantA,
      'POST',
      '/requisitions',
      requisitionForm(warehouseOfA, productOfA, unitsOfA),
    );
    expect(mine.statusCode, mine.body).toBe(201);
    const own = requisitionSchema.parse(mine.json());
    const crossed = await as(tenantA, 'POST', `/approvals/requisition/${own.id}/approve`, {
      roundId: roundOfB.id,
      comment: '',
    });
    expect(crossed.statusCode).toBe(409);
    expect(problemOf(crossed).code).toBe('approval_not_pending');

    const waiting = waitingApprovalPageSchema.parse(
      (await as(tenantA, 'GET', '/approvals/waiting')).json(),
    );
    expect(waiting.items).toEqual([]);
    // B's Owner, who may decide any level of B's, sees it
    const ofB = waitingApprovalPageSchema.parse(
      (await as(tenantB, 'GET', '/approvals/waiting')).json(),
    );
    expect(ofB.items.map((item) => item.id)).toEqual([requisitionOfB.id]);
    expect(
      waitingCountSchema.parse((await as(tenantA, 'GET', '/approvals/waiting/count')).json()),
    ).toEqual({ count: 0 });
  });

  it("never gives A the cost of B's items", async () => {
    const res = await as(tenantA, 'POST', '/purchase/cost-lookup', {
      items: [
        { variantId: variantOf(productOfB), unitId: pcsOf(unitsOfA) },
        { variantId: variantOf(productOfA), unitId: pcsOf(unitsOfA) },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(costLookupSchema.parse(res.json()).items.map((item) => item.variantId)).toEqual([
      variantOf(productOfA),
    ]);
  });
});
```

- **B has one of everything**: a supplier group, a supplier with a bank account, a customer, an approval level with
  its own role, and a requisition that waits. The Owner's own would be approved at once, so B's merchandiser
  (Babul) writes and submits it.
- **Reading, changing, archiving, deleting** B's supplier or group, or its statement: 404, and B's records are as
  they were.
- **"Make supplier/customer too" on B's party**: 404.
- **B's group on A's supplier** is `supplier_group_invalid`, the same as an id that does not exist. **B's bank account
  id** on A's supplier makes a new account, and B's stays.
- **B's supplier on A's payable line** is `journal_party_invalid`.
- **B's role on A's levels** is `approval_role_invalid`.
- **B's requisition**: 404 for every route, and its status and version are unchanged. **B's warehouse and item** on
  A's requisition: `purchase_warehouse_invalid` and `purchase_item_invalid`.
- **Deciding B's step from A** is 404, and B's round still waits. **B's round id on A's own requisition** is
  `approval_not_pending`: the engine looks the round up with the document's id as well, so a round of another
  document is never decided by mistake. A's waiting list is empty and its count is 0; B's Owner sees B's requisition.
- **The cost lookup leaves B's item out**, as if it did not exist.

### Three older tests follow the new rules

```diff
@@ -15,6 +15,7 @@ import {
   roleSchema,
   settingsSchema,
   setupSchema,
+  supplierSchema,
   shiftIsoDate,
   todayIn,
 } from '@omnivo/contracts';
@@ -469,17 +470,38 @@ describe('opening balances', () => {
       entry: null,
       lines: [],
     });
+    // Step 17a: the payable is kept per supplier, so its line names the yarn mill owed
+    const mill = await send('POST', '/suppliers', {
+      code: '',
+      name: 'Square Yarns Ltd.',
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
+    expect(mill.statusCode, mill.body).toBe(201);
     const res = await send('PUT', '/opening-balances', {
       goLiveDate: '2026-07-01',
       replaces: null,
       lines: [
         { accountId: id('1121'), debit: '1842600.50', credit: '' },
         { accountId: id('1151'), debit: '650000', credit: '' },
-        { accountId: id('2110'), debit: '', credit: '412000' },
+        {
+          accountId: id('2110'),
+          partyId: supplierSchema.parse(mill.json()).id,
+          debit: '',
+          credit: '412000',
+        },
         { accountId: id('1290'), debit: '', credit: '' },
       ],
     });
-    expect(res.statusCode).toBe(200);
+    expect(res.statusCode, res.body).toBe(200);
     const saved = openingBalancesSchema.parse(res.json());
     expect(saved.goLiveDate).toBe('2026-07-01');
     expect(saved.lines).toHaveLength(3);
```

- **The step 10 opening balances put ৳4,12,000 on the payable with no one named.** From 17a that is
  `journal_party_required`: the payable is kept per supplier, as the receivable is per customer since 15a. The test
  now makes the yarn mill first and names it on the line. Nothing else in the test changes: the totals and the
  opening balance equity line are the same. (The second opening balances test failed only because the first save
  never happened; it needed no change.)

```diff
@@ -101,7 +101,17 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(17);
+    expect(items.map((series) => series.documentType)).toHaveLength(19);
+    // Suppliers and requisitions (step 17a): a supplier's code is a plain running number like a
+    // customer's; a requisition is numbered by fiscal year, when it is saved
+    expect(items.find((series) => series.documentType === 'purchase.supplier')).toMatchObject({
+      prefix: 'S',
+      nextNumber: 'S-00001',
+    });
+    expect(items.find((series) => series.documentType === 'purchase.requisition')).toMatchObject({
+      prefix: 'PR',
+      nextNumber: `PR-${today}-0001`,
+    });
     // Returns, credit notes and refunds (step 15d): numbered by fiscal year. A return and a credit
     // note take their number when posted, a refund when saved (it has no draft).
     expect(items.find((series) => series.documentType === 'sales.return')).toMatchObject({
```

- **19 number series, not 17.** The test also checks the two new ones: suppliers get a plain running code
  (`S-00001`) like customers, and requisitions are numbered per fiscal year (`PR-2026-27-0001`).

```diff
@@ -142,6 +142,8 @@ describe('starting the setup', () => {
           'core.user.read',
           'inventory.stock.revalue',
           'inventory.stock.value',
+          'purchase.supplier.balance',
+          'purchase.supplier.manage',
           'sales.credit_note.manage',
           'sales.customer.balance',
           'sales.customer.manage',
@@ -156,6 +158,7 @@ describe('starting the setup', () => {
         [
           'core.user.read',
           'inventory.product.manage',
+          'purchase.requisition.manage',
           'sales.customer.manage',
           'sales.order.manage',
           'sales.quotation.manage',
@@ -167,6 +170,7 @@ describe('starting the setup', () => {
           'inventory.product.manage',
           'inventory.stock.adjust',
           'inventory.stock.transfer',
+          'purchase.requisition.manage',
           'sales.delivery.manage',
           'sales.return.manage',
         ],
```

- **The garments roles get 17a's permissions** from `templates.ts`: the Accountant keeps the suppliers and sees their
  balances, and the Merchandiser and the Store keeper may write requisitions. Nobody gets an approval: the levels are
  set per role in Settings.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm lint
cd apps/api
npx vitest run src/purchase --maxWorkers=3
pnpm test:integration
pnpm test:tenant-leak
```

The three new files pass: 25 tests for suppliers, 21 for requisitions and approvals, 10 for tenant leaks. The whole
integration and tenant-leak suites have 473 tests in 44 files. 17a.3 changed the customers, roles, posting, opening
balances and setup code, and every older test passes, apart from the three changed above. The unit tests still
pass (107).

> **What we checked.** Besides the runs above, we broke four rules of 17a.3 on purpose, one at a time, and the test
> meant for each one failed: the supplier balance counting the receivable too, the waiting list showing people their
> own submissions, the bell not falling back to the Owners, and the customer-side check forgetting quotations. The
> requisitions file (with the race test) ran five times in a row and passed each time. The whole run first showed the
> three older tests above failing; after the change, those three files pass (34 tests), and the other 41 files had
> already passed in the same run.

---

## 17a.5 — `packages/i18n`: the words

The screens of 17a.6 need their words in English and Bangla, and the app cannot type-check without them, so they
come first. This part changes only the two locale files. The ui package needs nothing new: the supplier form is
built like the customer form (step 15a), the requisition lines like the stock line rows (step 13), and the approval
card and its dialogs from the card, the pill and the dialog that exist already.

When this part starts, `packages/i18n` has one error: the `errors` object is missing the 31 new codes of 17a.1.
When it ends, the i18n package compiles, and the app has two type errors left, both in one place: the bell's
`TARGET` map has no page for the three `approval.*` types (one error where the map is written, one where it is
read). 17a.6 fixes it, because the bell opens the document itself, like `document.email_failed`.

### `locales/en.ts`

```diff
@@ -42,6 +42,7 @@ export const en = {
     auditLog: 'Audit log',
     team: 'Team',
     roles: 'Roles',
+    approvalRules: 'Approval levels',
     accounting: 'Accounting',
     chartOfAccounts: 'Chart of accounts',
     journal: 'Journal',
@@ -80,6 +81,11 @@ export const en = {
     salesReturns: 'Sales returns',
     creditNotes: 'Credit notes',
     refunds: 'Refunds',
+    purchase: 'Purchase',
+    suppliers: 'Suppliers',
+    supplierGroups: 'Supplier groups',
+    requisitions: 'Requisitions',
+    approvals: 'Approvals',
   },
   auth: {
     workspace: 'Workspace',
@@ -233,7 +239,12 @@ export const en = {
         credit_note: 'Credit note',
         refund: 'Refund',
       },
-      purchase: { order: 'Purchase order', bill: 'Supplier bill' },
+      purchase: {
+        order: 'Purchase order',
+        bill: 'Supplier bill',
+        supplier: 'Supplier code',
+        requisition: 'Purchase requisition',
+      },
       inventory: {
         receipt: 'Goods receipt (GRN)',
         product: 'Product code',
@@ -419,6 +430,9 @@ export const en = {
     customer: 'Customer',
     customerPlaceholder: 'Pick a customer',
     noCustomer: 'No customer',
+    supplier: 'Supplier',
+    supplierPlaceholder: 'Pick a supplier',
+    noSupplier: 'No supplier',
     branch: 'Branch',
     noBranch: 'No branch',
     debit: 'Debit',
@@ -508,6 +522,9 @@ export const en = {
     noCustomer: 'No customer',
     noCustomerHint:
       'Posted before customers were kept. Reverse the entry and post it again with a customer.',
+    noSupplier: 'No supplier',
+    noSupplierHint:
+      'Posted before suppliers were kept. Reverse the entry and post it again with a supplier.',
     pickTitle: 'Pick an account',
     pickBody: 'Choose an account above to see its entries, like Cash in hand or Office rent.',
     emptyTitle: 'No entries in these dates',
@@ -533,6 +550,12 @@ export const en = {
     receivableHint: 'Enter what each customer owed, one line each. The account holds their total.',
     noCustomerHint:
       'Saved before customers were kept. Pick the customer, or split the amount over several lines.',
+    supplier: 'Supplier',
+    supplierPlaceholder: 'Pick a supplier',
+    addSupplier: 'Add a supplier',
+    payableHint: 'Enter what you owed each supplier, one line each. The account holds their total.',
+    noSupplierHint:
+      'Saved before suppliers were kept. Pick the supplier, or split the amount over several lines.',
     differenceHint: 'What the balances are out by goes here. It reads zero once everything is in.',
     save: 'Post opening balances',
     saved: 'Opening balances posted as {{number}}',
@@ -1480,10 +1503,17 @@ export const en = {
     confirmDelete: 'Delete {{code}}',
     deleteWarning:
       'This cannot be undone. A customer with entries or documents can only be archived.',
+    // A party that is both: the delete removes only the customer side (step 17a, decision 10)
+    deleteSideWarning:
+      '{{name}} is also a supplier. Only the customer side is removed, with its shipping addresses and sales terms. The supplier and its entries stay.',
     deleted: '{{name}} deleted',
+    sideDeleted: '{{name}} is no longer a customer',
     archivedNotice:
       'This customer is archived: it is hidden from new documents. Its history and balance stay.',
     alsoSupplier: 'Also a supplier',
+    makeSupplier: 'Make supplier too',
+    madeSupplier: '{{name}} is a supplier too',
+    supplierPage: 'Open as supplier',
     kpis: {
       balance: 'Balance',
       creditLimit: 'Credit limit',
@@ -2335,6 +2365,368 @@ export const en = {
   // Download PDF, email and share link on a quotation, invoice, money receipt and credit note.
   // Only the app's own words: what the customer reads (the PDF, the email, the WhatsApp text) is
   // written by the server, in the customer's language (apps/api/src/documents/copy.ts)
+  suppliers: {
+    title: 'Suppliers',
+    description: 'Mills, importers and vendors you buy from, and what you owe them',
+    add: 'Add supplier',
+    searchLabel: 'Search suppliers',
+    searchPlaceholder: 'Name, code, contact person or phone',
+    group: 'Group',
+    allGroups: 'All groups',
+    allSuppliers: 'All suppliers',
+    show: 'Show',
+    statuses: { active: 'Active', archived: 'Archived' },
+    columns: {
+      supplier: 'Supplier',
+      phone: 'Phone',
+      group: 'Group',
+      terms: 'Terms',
+      balance: 'Balance',
+    },
+    termsDays_one: '{{count}} day',
+    termsDays_other: '{{count}} days',
+    onReceipt: 'On receipt',
+    emptyTitle: 'No suppliers yet',
+    emptyBody:
+      'Add your first supplier, like a yarn mill in Narayanganj or a carton maker in Gazipur. What you owe them shows here once their entries are posted.',
+    noMatchTitle: 'No supplier matches "{{query}}"',
+    noMatchBody: 'Check the spelling, or search by code or phone number.',
+    archivedEmptyTitle: 'No archived suppliers',
+    archivedEmptyBody:
+      'A supplier you archive shows up here. Their history and what you owe them stay.',
+    loadFailed: "Couldn't load the suppliers. Refresh the page to try again.",
+    readOnly:
+      'You can see the suppliers. To change them, ask for the purchase.supplier.manage permission.',
+    back: 'Suppliers',
+    newTitle: 'New supplier',
+    editTitle: 'Edit {{code}}',
+    notFound: "This supplier doesn't exist, or it was deleted.",
+    sections: {
+      basics: 'Basics',
+      terms: 'Purchase terms',
+      termsHint: 'Used on every bill from this supplier.',
+      bankAccounts: 'Bank accounts',
+      bankAccountsHint:
+        'Where you pay this supplier, up to {{max}}. The payment screen shows them.',
+    },
+    fields: {
+      code: 'Code',
+      codeHint: 'Leave empty for the next number, like S-00042.',
+      name: 'Name',
+      namePlaceholder: 'Meghna Spinning Mills',
+      group: 'Group',
+      noGroup: 'No group',
+      contactPerson: 'Contact person',
+      contactPersonPlaceholder: 'Md. Rafiqul Islam',
+      phone: 'Phone',
+      email: 'Email',
+      bin: 'BIN',
+      binHint: "The supplier's 13-digit VAT registration number, printed on its Mushak 6.3",
+      paymentTerms: 'Payment terms',
+      paymentTermsHint: 'Days from the bill to its due date. 0 = due on receipt.',
+      days: 'days',
+      documentLanguage: 'Document language',
+      documentLanguageHint: 'Purchase orders and emails to this supplier start in this language.',
+      address: 'Address',
+      addressHint:
+        'Printed on purchase orders. If this supplier is also a customer, it is their billing address too.',
+      addressPlaceholder: 'Plot 12, BSCIC Industrial Area, Fatullah, Narayanganj',
+      notes: 'Notes',
+      notesPlaceholder: 'Delivers on Saturdays only. Sends the bill with the challan.',
+    },
+    bankAccounts: {
+      number: 'Bank account {{number}}',
+      bankName: 'Bank',
+      bankNamePlaceholder: 'Dutch-Bangla Bank',
+      branchName: 'Branch',
+      branchNamePlaceholder: 'Narayanganj',
+      accountName: 'Account name',
+      accountNamePlaceholder: 'Meghna Spinning Mills Ltd.',
+      accountNumber: 'Account number',
+      accountNumberHint: 'Spaces and dashes are taken out.',
+      routingNumber: 'Routing number',
+      routingNumberHint: '9 digits, printed on the cheque leaf',
+      add: 'Add a bank account',
+      remove: 'Remove bank account {{number}}',
+      empty: 'No bank account yet. Add the one you pay this supplier into.',
+      // On the supplier page: "Dutch-Bangla Bank, Narayanganj"
+      bankAndBranch: '{{bank}}, {{branch}}',
+      routing: 'Routing {{number}}',
+    },
+    create: 'Add supplier',
+    save: 'Save supplier',
+    created: '{{name}} added',
+    updated: '{{name}} saved',
+    edit: 'Edit',
+    archive: 'Archive',
+    restore: 'Restore',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    delete: 'Delete',
+    confirmDelete: 'Delete {{code}}',
+    deleteWarning:
+      'This cannot be undone. A supplier with entries or documents can only be archived.',
+    // A party that is both: the delete removes only the supplier side (decision 10)
+    deleteSideWarning:
+      '{{name}} is also a customer. Only the supplier side is removed, with its bank accounts and purchase terms. The customer and its entries stay.',
+    deleted: '{{name}} deleted',
+    sideDeleted: '{{name}} is no longer a supplier',
+    archivedNotice:
+      'This supplier is archived: it is hidden from new documents. Its history and balance stay.',
+    alsoCustomer: 'Also a customer',
+    makeCustomer: 'Make customer too',
+    madeCustomer: '{{name}} is a customer too',
+    customerPage: 'Open as customer',
+    kpis: {
+      balance: 'Balance',
+      terms: 'Payment terms',
+      bankAccounts: 'Bank accounts',
+    },
+    // What the company owes the supplier, or what the supplier owes back (an advance paid)
+    owe: 'You owe {{amount}}',
+    inAdvance: '{{amount}} paid in advance',
+    settled: 'Nothing owed',
+    details: 'Details',
+    noAddress: 'No address',
+    noBankAccounts: 'No bank accounts',
+    statementTitle: 'Statement',
+    statementSubtitle: 'Posted entries for this supplier, with what you owe after each one',
+    statementEmptyTitle: 'No entries in these dates',
+    statementEmptyBody:
+      'Pick other dates. Their opening balance, bills and payments show up here once they are posted.',
+    statementLoadFailed: "Couldn't load the statement. Refresh the page to try again.",
+    // The supplier picker on journal lines and opening balances
+    pickerSearch: 'Search suppliers',
+    pickerEmpty: 'No active supplier matches',
+  },
+  supplierGroups: {
+    title: 'Supplier groups',
+    description:
+      'Groups like Yarn and fabric, Accessories and Packaging, to sort and filter your suppliers',
+    add: 'Add group',
+    columns: {
+      name: 'Group',
+      suppliers: 'Suppliers',
+    },
+    supplierCount_one: '{{formatted}} supplier',
+    supplierCount_other: '{{formatted}} suppliers',
+    newTitle: 'Add group',
+    editTitle: 'Edit {{name}}',
+    name: 'Name',
+    namePlaceholder: 'Yarn and fabric',
+    created: '{{name}} added',
+    updated: '{{name}} saved',
+    delete: 'Delete',
+    confirmDelete: 'Delete {{name}}',
+    deleteWarning: 'Only a group with no suppliers can be deleted.',
+    deleted: '{{name}} deleted',
+    emptyTitle: 'No supplier groups yet',
+    emptyBody:
+      'Add groups like Yarn and fabric, Accessories and Packaging, then put each supplier in one.',
+    loadFailed: "Couldn't load the supplier groups. Refresh the page to try again.",
+    readOnly: 'To change the groups, ask for the purchase.supplier.manage permission.',
+  },
+  // The lines of a purchase document. A requisition uses the estimated cost; 17b's purchase order
+  // adds its price, discount and VAT here
+  purchaseLines: {
+    items: 'Items',
+    addItems: 'Add items',
+    pickerTitle: 'Add items',
+    pickerDescription: 'Search products and services. Each click adds a line in its buying unit.',
+    pickerSearch: 'Search products and services',
+    pickerEmpty: 'No active product matches. Check the spelling, or search by code or SKU.',
+    add: 'Add',
+    added: 'Added',
+    service: 'Service',
+    line: 'Line {{number}}',
+    remove: 'Remove line {{number}}',
+    item: 'Item',
+    description: 'Description',
+    quantity: 'Quantity',
+    unit: 'Unit',
+    estimatedCost: 'Estimated cost',
+    costPer: 'Cost per {{unit}}',
+    amount: 'Amount',
+    // Where a new line's cost came from (the cost lookup)
+    fromAverage: 'From the average cost',
+    noCost: 'No cost known: type one',
+    noLines: 'No items yet. Add what needs to be bought.',
+    tooMany: 'A document holds up to {{max}} lines. Write a second one for the rest.',
+    lineCount_one: '{{count}} item',
+    lineCount_other: '{{count}} items',
+    total: 'Estimated total',
+  },
+  requisitions: {
+    title: 'Purchase requisitions',
+    description: 'Requests to buy goods or services, approved before anyone orders',
+    new: 'New requisition',
+    newTitle: 'New purchase requisition',
+    back: 'Requisitions',
+    show: 'Show',
+    all: 'All',
+    allWarehouses: 'All warehouses',
+    statuses: {
+      draft: 'Draft',
+      pending: 'Waiting for approval',
+      approved: 'Approved',
+      cancelled: 'Cancelled',
+    },
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      warehouse: 'Warehouse',
+      neededBy: 'Needed by',
+      requestedBy: 'Requested by',
+      amount: 'Estimated amount',
+      status: 'Status',
+    },
+    date: 'Date',
+    warehouse: 'Warehouse',
+    warehouseHint: 'Where the goods are needed. Its branch is the requisition’s branch.',
+    neededBy: 'Needed by',
+    neededByHint: 'Leave it empty if there is no date.',
+    noDate: 'No date',
+    note: 'Note',
+    notePlaceholder:
+      'For buyer PO-HM-2026-1187: 2,000 polo shirts in navy. Cutting starts on 10 November.',
+    requestedBy: 'Requested by',
+    save: 'Save requisition',
+    saved: '{{number}} saved',
+    edit: 'Edit',
+    submit: 'Submit for approval',
+    submitHint:
+      'Its estimated amount chooses who approves it. Nobody can change it while it waits.',
+    submitted: '{{number}} sent for approval',
+    // No level applies, or an Owner submitted it: approved in the same step
+    submittedApproved: '{{number}} approved',
+    reopen: 'Reopen',
+    reopenTitle: 'Reopen {{number}}',
+    reopenBody:
+      'It goes back to draft so it can be changed. When it is submitted again, it is approved again from the first level. This round stays in its history.',
+    reopened: '{{number}} is a draft again',
+    cancel: 'Cancel requisition',
+    cancelTitle: 'Cancel {{number}}',
+    cancelBody:
+      'Nobody can order from it any more. It stays in the list as cancelled, with its history.',
+    keep: 'Keep it',
+    cancelled: '{{number}} cancelled',
+    delete: 'Delete requisition',
+    confirmDelete: 'Delete {{number}}',
+    deleteWarning:
+      'This cannot be undone. Its number is not used again. A requisition that was ever submitted can only be cancelled.',
+    deleted: '{{number}} deleted',
+    // The document notice above the requisition
+    notices: {
+      pending: 'Waiting for approval. Reopen it to change it.',
+      approved: 'Approved and locked. Reopen it to change it; it is then approved again.',
+      cancelled: 'Cancelled. It stays here for the record.',
+      rejected: '{{name}} sent it back: "{{comment}}" Change it and submit it again.',
+    },
+    cantWrite:
+      'You can view requisitions. Ask a workspace owner for the purchase.requisition.manage permission to write them.',
+    notFound: "This requisition doesn't exist, or it was deleted.",
+    emptyTitle: 'No requisitions yet',
+    emptyBody:
+      'Write one when the store or the floor needs something, like 2,000 cones of 30s yarn or a motor for a sewing machine. It is approved before anyone orders.',
+    loadFailed: "Couldn't load the requisitions. Refresh the page to try again.",
+  },
+  // The approval of any document that needs one: the "Waiting for me" page, the approval card on the
+  // document's page, and its two dialogs
+  approvals: {
+    title: 'Approvals',
+    description: 'Documents waiting for your decision, oldest first',
+    // An ApprovalDocument kind → its name; the bell and the list put it before the number
+    kinds: { requisition: 'Requisition' },
+    columns: {
+      document: 'Document',
+      date: 'Date',
+      subject: 'For',
+      submittedBy: 'Submitted by',
+      amount: 'Amount',
+      step: 'Step',
+    },
+    stepOf: '{{position}} of {{count}}',
+    emptyTitle: 'Nothing waits for you',
+    emptyBody:
+      'When someone submits a requisition that needs your role, it shows up here and the bell tells you.',
+    loadFailed: "Couldn't load the documents waiting for you. Refresh the page to try again.",
+    cardTitle: 'Approval',
+    cardSubtitle: 'Every level it reaches approves it, one after another',
+    rounds: {
+      pending: 'Waiting',
+      approved: 'Approved',
+      rejected: 'Rejected',
+      reopened: 'Reopened',
+    },
+    round: 'Round {{number}}',
+    earlierRounds: 'Earlier rounds',
+    submitted: 'Submitted by {{name}} on {{date}} for {{amount}}',
+    levelLine: '{{role}} · from {{amount}}',
+    deletedRole: '{{name}} (a deleted role)',
+    steps: {
+      approved: 'Approved',
+      rejected: 'Rejected',
+      waiting: 'Waiting',
+      notYet: 'Not yet',
+      // A step after a rejection or a reopen: the round ended before it
+      notDecided: 'Not decided',
+    },
+    decided: '{{name}}, {{date}}',
+    noLevels: 'No level applied, so it was approved when it was submitted.',
+    ownerSubmitted: 'An Owner submitted it, so it was approved at once.',
+    notSubmitted:
+      'Not submitted yet. Every level its amount reaches approves it, one after another.',
+    waitingForYou: 'Step {{position}} waits for you.',
+    waitingFor: 'Waiting for {{role}}',
+    ownDocument: 'You submitted it, so someone else approves it.',
+    approve: 'Approve',
+    reject: 'Reject',
+    approveTitle: 'Approve {{number}}',
+    approveBody: 'You approve step {{position}} of {{count}}, as {{role}}.',
+    approveLast: 'This is the last step: {{number}} is approved when you do.',
+    approveNext: 'The next level is told when you do.',
+    comment: 'Comment',
+    approveCommentPlaceholder: 'Fine for the November production plan',
+    rejectTitle: 'Reject {{number}}',
+    rejectBody:
+      'It goes back to draft. {{name}} sees your comment, can change it and submit it again.',
+    rejectComment: 'What should change',
+    rejectCommentPlaceholder: 'Order 1,500 cones, not 2,000: the October plan changed.',
+    confirmApprove: 'Approve',
+    confirmReject: 'Send back to draft',
+    approvedToast: 'Your approval of {{number}} is saved',
+    rejectedToast: '{{number}} sent back to draft',
+  },
+  // Settings → Approval levels (GET /approval-rules, PUT /approval-rules/:document)
+  approvalRules: {
+    title: 'Approval levels',
+    description:
+      'Who approves which documents, by amount. A document passes every level it reaches, one after another.',
+    // One card per ApprovalDocument kind
+    documents: {
+      requisition: {
+        title: 'Purchase requisitions',
+        subtitle: 'By the estimated amount of the requisition',
+      },
+    },
+    level: 'Level {{number}}',
+    from: 'From amount',
+    fromHint: 'From this amount up. 0 = every document.',
+    role: 'Role',
+    rolePlaceholder: 'Pick a role',
+    add: 'Add a level',
+    remove: 'Remove level {{number}}',
+    none: 'No levels: these documents are approved as soon as they are submitted.',
+    tooMany: 'Up to {{max}} levels.',
+    rules:
+      'Each level starts at the amount of the level above it, or higher, and each role is used once. An Owner may approve any level, and an Owner’s own documents are approved when submitted.',
+    applies: 'Documents already waiting keep the levels they were submitted with.',
+    save: 'Save levels',
+    saved: '{{document}}: levels saved',
+    readOnly:
+      'You can see the levels. To change them, ask for the core.settings.manage permission.',
+    loadFailed: "Couldn't load the approval levels. Refresh the page to try again.",
+  },
   documentOutput: {
     // OutputDocument → name: the bell and the public page get the kind, not its words
     kinds: {
@@ -2610,6 +3002,7 @@ export const en = {
       accounting: 'Accounting',
       inventory: 'Inventory',
       sales: 'Sales',
+      purchase: 'Purchase',
     },
     members_one: '{{count}} person',
     members_other: '{{count}} people',
@@ -2689,6 +3082,15 @@ export const en = {
       credit_note: { manage: 'Write and post credit notes, and apply them to invoices' },
       refund: { manage: 'Pay money back to customers, and void refunds' },
     },
+    purchase: {
+      supplier: {
+        manage: 'Add, edit and archive suppliers and their groups',
+        balance: 'See what the company owes suppliers, and their statements',
+      },
+      requisition: {
+        manage: 'Write requisitions, submit them for approval, reopen and cancel them',
+      },
+    },
   },
   invite: {
     checking: 'Checking your invitation…',
@@ -2747,6 +3149,9 @@ export const en = {
       sales_return: 'Sales returns',
       credit_note: 'Credit notes',
       refund: 'Refunds',
+      supplier: 'Suppliers',
+      supplier_group: 'Supplier groups',
+      requisition: 'Purchase requisitions',
     },
     columns: {
       when: 'When',
@@ -2942,6 +3347,31 @@ export const en = {
         voided: 'Voided a refund',
       },
       sales_accounts: { changed: 'Changed the sales returns account' },
+      supplier: {
+        created: 'Added a supplier',
+        updated: 'Edited a supplier',
+        archived: 'Archived a supplier',
+        restored: 'Restored a supplier',
+        deleted: 'Deleted a supplier',
+      },
+      supplier_group: {
+        created: 'Added a supplier group',
+        updated: 'Renamed a supplier group',
+        deleted: 'Deleted a supplier group',
+      },
+      approval_rules: { changed: 'Changed the approval levels' },
+      requisition: {
+        created: 'Wrote a requisition',
+        updated: 'Edited a draft requisition',
+        deleted: 'Deleted a draft requisition',
+        cancelled: 'Cancelled a requisition',
+      },
+      approval: {
+        submitted: 'Submitted for approval',
+        approved: 'Approved a step',
+        rejected: 'Rejected: sent back to draft',
+        reopened: 'Reopened: back to draft',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -3022,7 +3452,7 @@ export const en = {
       rates: 'VAT rates',
       taxRate: 'VAT rate',
       pricesIncludeVat: 'Prices include VAT',
-      group: 'Customer group',
+      group: 'Group',
       paymentTermsDays: 'Payment terms (days)',
       creditLimit: 'Credit limit',
       priceList: 'Price list',
@@ -3047,6 +3477,14 @@ export const en = {
       applied: 'Applied',
       source: 'Paid back from',
       returns: 'Sales returns account',
+      bankAccounts: 'Bank accounts',
+      neededBy: 'Needed by',
+      status: 'Status',
+      steps: 'Levels',
+      step: 'Step',
+      role: 'Role',
+      comment: 'Comment',
+      requisition: 'Purchase requisitions',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -3104,7 +3542,7 @@ export const en = {
     unread: 'Unread',
     emptyTitle: 'No notifications yet',
     emptyBody:
-      'You hear here when someone joins from your invitation, or when an email could not be sent.',
+      'You hear here when someone joins from your invitation, when a document waits for your approval, or when an email could not be sent.',
     loadFailed: "Couldn't load your notifications. Try again in a moment.",
     // type → text. The type's dot nests in i18next, so t(`notifications.types.${type}`) lands here;
     // a type without text here does not type-check
@@ -3134,6 +3572,12 @@ export const en = {
         email_failed:
           "{{document}} {{number}} couldn't be emailed. Check the address and send it again.",
       },
+      // {{document}} arrives as an approval kind (requisition); the bell puts its name in
+      approval: {
+        requested: '{{document}} {{number}} is waiting for your approval.',
+        approved: '{{document}} {{number}} is approved.',
+        rejected: '{{document}} {{number}} was sent back to draft. Open it to see why.',
+      },
     },
   },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
@@ -3191,7 +3635,7 @@ export const en = {
     last_owner: 'Keep at least one owner. Make someone else an owner first.',
     own_membership: "You can't change your own roles or remove yourself. Ask another admin.",
     role_in_use:
-      'Someone has this role or an open invitation gives it. Change their roles or cancel the invitation first.',
+      'Someone has this role, an open invitation gives it, an approval level uses it, or a document waits for its approval. Change that first: their roles, the invitation, Settings → Approval levels, or the document.',
     setup_started: 'The setup has already started. Reload the page to see how far it is.',
     setup_not_failed: "The setup hasn't failed. Reload the page to see how far it is.",
     account_code_format: 'Use digits, like 1121. Dots or hyphens may split them, like 1-1-21.',
@@ -3396,12 +3840,14 @@ export const en = {
     price_list_item_twice: 'This item and unit are here twice. Keep one.',
     price_list_unit_invalid:
       "This unit is not one of the product's units any more. Remove the row.",
-    journal_party_required: 'Pick the customer this amount belongs to.',
+    journal_party_required:
+      'Pick who this amount belongs to: the customer on the receivable, the supplier on the payable.',
     journal_party_not_allowed:
-      'Only lines on the receivable account take a customer. Remove the customer.',
-    journal_party_invalid: 'Pick an active customer. This one is archived or was deleted.',
+      'Only lines on the receivable or the payable account take a customer or a supplier. Remove it.',
+    journal_party_invalid:
+      'Pick an active customer on the receivable, or an active supplier on the payable.',
     opening_balance_twice:
-      'This account is here twice. Put the amount on one line, or pick another customer.',
+      'This account is here twice. Put the amount on one line, or pick another customer or supplier.',
     sales_customer_required: 'Pick the customer.',
     sales_customer_invalid:
       'Pick an active customer. An order that has a number, or comes from a quotation, keeps its customer.',
@@ -3526,6 +3972,44 @@ export const en = {
     email_too_many: 'Up to 5 addresses in a box. Send a second email to the rest.',
     email_subject_required: 'Type a subject.',
     share_link_not_found: 'This link no longer works. Ask whoever sent it for a new one.',
+    supplier_code_format: 'Use letters and digits without spaces, like S-00042.',
+    supplier_code_taken:
+      'Another customer or supplier has this code. Pick another, or leave it empty for the next number.',
+    supplier_name_required: "Enter the supplier's name, at least 2 characters.",
+    supplier_group_invalid: 'Pick a group from the list. This one was deleted.',
+    supplier_in_use:
+      'Entries or purchase documents use this supplier, so it cannot be deleted. Archive it instead.',
+    supplier_group_name_required: 'Enter a name, at least 2 characters.',
+    supplier_group_name_taken: 'Another group has this name.',
+    supplier_group_in_use: 'Suppliers are in this group. Move them to another group first.',
+    supplier_bank_name_required: 'Enter the bank, at least 2 characters.',
+    supplier_account_name_required: 'Enter the name the account is in, at least 2 characters.',
+    bank_account_number_format: 'Enter the account number: 6 to 20 digits.',
+    routing_number_format: 'Enter the 9-digit routing number, or leave it empty.',
+    party_role_exists: 'It is already a customer and a supplier. Reload the page.',
+    approval_level_order: 'Start this level at the amount of the level above it, or higher.',
+    approval_role_twice: 'This role is on another level. Use each role once.',
+    approval_role_invalid: 'Pick a role from the list. This one was deleted.',
+    approval_not_pending:
+      'This document is no longer waiting for this approval. Reload it to see where it is now.',
+    approval_not_allowed:
+      'This step needs another role. Someone with that role, or an Owner, decides it.',
+    approval_own_document: 'You submitted this document, so someone else approves it.',
+    approval_comment_required: 'Say what should change, at least 2 characters.',
+    purchase_warehouse_required: 'Pick the warehouse.',
+    purchase_warehouse_invalid: 'Pick an active warehouse. This one is archived or was deleted.',
+    purchase_date_required: 'Enter the date.',
+    purchase_lines_required: 'Add at least one item.',
+    purchase_item_invalid: 'Pick an active product. This one is archived or was deleted.',
+    purchase_not_draft: 'This was submitted, so it cannot change. Reopen it first.',
+    purchase_was_submitted:
+      'This was submitted once, so its approval history stays. Cancel it instead.',
+    purchase_cannot_reopen:
+      'Only a document that waits or is approved can be reopened, and only before a later document uses it.',
+    purchase_cannot_cancel:
+      'Only a draft or an approved document can be cancelled. Reopen a waiting one first.',
+    requisition_needed_by: 'Pick a day on or after the requisition date.',
+    requisition_cost_required: 'Enter the estimated cost. 0 is fine for a free item.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
```

What is new, from the top of the file down:

- **`nav`:** the Purchase group (Suppliers, Supplier groups, Requisitions, Approvals) and "Approval levels" in the
  Workspace group, next to Roles. The levels are a workspace setting (decision 21), so they sit with the other
  settings, not in Purchase. "Approvals" is the "Waiting for me" list (decision 17); its count is a number the
  navigation adds, so the word itself has no count in it.
- **`numbering.documents.purchase`:** the names of the two new series. The object was one line before; it has four
  keys now, so Prettier breaks it up. Without these two names the Numbering page would show an empty cell for `S`
  and `PR`.
- **`journal`, `ledger`, `opening`:** the supplier versions of the customer words, for the payable (decision 11).
  `noSupplierHint` explains a payable line posted before this step, which has no supplier, in the same words as the
  receivable's `noCustomerHint`. The keys that do not name a side (`customerLine`, `removeCustomer`) stay as they
  are and serve both sides, so no old key is renamed and no old screen breaks.
- **`customers`:** "Make supplier too", its toast, and a link to the supplier page (decision 10).
  `deleteSideWarning` is the delete dialog's text for a party that is both: the delete then removes only the
  customer side, and the person must know the supplier stays, or they would think the whole business is gone.
  `sideDeleted` is the toast for that case, because "Rahman Traders deleted" would be untrue.
- **`suppliers`:** the list, the form, the page and the picker, built like `customers` so the two pages read the
  same. The differences are on purpose:
  - there is no credit limit and no price list (a supplier gives us credit, we do not give it);
  - `sections.bankAccounts` and `bankAccounts.*` are new (decision 8). The hint takes `{{max}}` from
    `MAX_SUPPLIER_BANK_ACCOUNTS` instead of writing "5", so the text cannot drift from the rule;
  - `fields.addressHint` says that the address is the billing address of a party that is both (decision 31).
    Without that line, someone who changes it on the supplier page would be surprised to see the customer's
    invoices change too;
  - the balance words turn around: `owe` "You owe ৳1,15,000" when the company owes the supplier, `inAdvance` when
    the company paid ahead. The API sends the balance as debit minus credit (17a.4), so the page flips the sign
    before it picks a word.
- **`supplierGroups`:** a copy of `customerGroups` with garments examples (Yarn and fabric, Accessories,
  Packaging).
- **`purchaseLines`:** the line editor's words, in a section of its own and not under `requisitions`, because 17b's
  purchase order uses the same editor and adds its price, discount and VAT here. `fromAverage` and `noCost` are the
  line under the cost box, from the cost lookup (decision 20); a person without `inventory.stock.value` gets no
  cost back and sees "No cost known: type one".
- **`requisitions`:** the list, the form and the page. `statuses.pending` says "Waiting for approval" and not
  "Pending", because the person who submitted it wants to know what it waits for. `submittedApproved` is the toast
  when no level applies or an Owner submits it (decisions 13 and 14): the requisition is approved at once, and
  "sent for approval" would be untrue. `notices` are the document notices above the page; `rejected` quotes the
  comment, because a rejection always has one (decision 15) and it is the first thing the person needs.
- **`approvals`:** the words of the approval engine, for any kind of document. `kinds` names each
  `ApprovalDocument` (only `requisition` now; 17b adds `purchase_order`), so the bell, the list and the card can say
  "Requisition PR-2026-27-0001". The card shows each round with its steps: `steps.notYet` is a step after the one
  that waits, and `steps.notDecided` a step after a rejection or a reopen, where the round ended before anyone
  could decide it. `deletedRole` is for a step whose role was deleted later (decision 25): the step keeps the
  role's name, and the text says the role is gone, so nobody looks for it in Team → Roles. The approve dialog has
  two endings, `approveLast` and `approveNext`, because the person should know whether their click finishes the
  approval or passes it on.
- **`approvalRules`:** the Settings page. One card per kind of document (`documents.requisition`). `rules` puts the
  three rules of decision 13 and the Owner's place (decisions 5 and 14) in one sentence under the levels, so the
  page explains itself. `applies` answers the first question an owner asks after a change: what happens to the
  documents already waiting? Nothing (decision 13).
- **`roles.groups.purchase` and `permissions.purchase`:** the matrix needs a row text for every key and a title for
  every group; a missing one does not type-check (the comment above `permissions` says why).
- **`audit`:** the three entity types, the actions, and the field names that the 17a.3 services write. Two changes
  to older text:
  - `fields.group` was "Customer group". The supplier's audit uses the same field name `group` for its supplier
    group, so the word is now "Group"; the entity type (Customers or Suppliers) above the row already says which
    one.
  - `fields.requisition` is the field name of `approval_rules.changed`: the service writes the levels under the
    document kind (`{ requisition: 'Purchase manager from …; Director from …' }`), so a later kind gets its own key.
- **`notifications`:** the three bell texts, and a longer `emptyBody` that mentions approvals. `{{document}}`
  arrives as a kind (`requisition`); the bell puts `approvals.kinds.*` in, like step 16 does for its kinds.
- **`errors`:** the 31 new codes, after the step 16 ones, and four older texts that now cover both sides:
  - `role_in_use` also names an approval level that uses the role and a document waiting for it (17a.3 refuses the
    delete then; the levels were added to the words in 17a.7, decision 47);
  - `journal_party_required`, `journal_party_not_allowed` and `journal_party_invalid` speak of the customer on the
    receivable and the supplier on the payable, because the same codes now come back for payable lines (decision
    27). The old texts said "customer" only, which would be wrong on a payable line;
  - `opening_balance_twice` says "another customer or supplier" for the same reason.

  A few of the new texts in detail:
  - `party_role_exists` is one code for both buttons ("Make supplier too", "Make customer too"), so its text says
    "already a customer and a supplier", which is true in both cases.
  - `approval_not_allowed` does not name the role: the error code carries no parameters, and the step's role is
    on the card right next to the message anyway.
  - `purchase_not_draft`, `purchase_was_submitted`, `purchase_cannot_reopen` and `purchase_cannot_cancel` say "this
    document" and not "this requisition", because 17b–17d reuse them for orders, bills and payments (decision 21).
    `purchase_cannot_reopen` already mentions "a later document uses it": 17b's purchase order is that later
    document.
  - `requisition_cost_required` says that 0 is allowed, because the contract accepts 0 (a free sample from a
    supplier) and only an empty box is an error.

### `locales/bn.ts`

```diff
@@ -42,6 +42,7 @@ export const bn: Messages = {
     auditLog: 'অডিট লগ',
     team: 'টিম',
     roles: 'রোল',
+    approvalRules: 'অনুমোদনের লেভেল',
     accounting: 'হিসাবরক্ষণ',
     chartOfAccounts: 'চার্ট অফ অ্যাকাউন্টস',
     journal: 'জার্নাল',
@@ -80,6 +81,11 @@ export const bn: Messages = {
     salesReturns: 'সেলস রিটার্ন',
     creditNotes: 'ক্রেডিট নোট',
     refunds: 'রিফান্ড',
+    purchase: 'কেনাকাটা',
+    suppliers: 'সাপ্লায়ার',
+    supplierGroups: 'সাপ্লায়ারের গ্রুপ',
+    requisitions: 'রিকুইজিশন',
+    approvals: 'অনুমোদন',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -232,7 +238,12 @@ export const bn: Messages = {
         credit_note: 'ক্রেডিট নোট',
         refund: 'রিফান্ড',
       },
-      purchase: { order: 'পারচেজ অর্ডার (PO)', bill: 'সাপ্লায়ারের বিল' },
+      purchase: {
+        order: 'পারচেজ অর্ডার (PO)',
+        bill: 'সাপ্লায়ারের বিল',
+        supplier: 'সাপ্লায়ারের কোড',
+        requisition: 'পারচেজ রিকুইজিশন',
+      },
       inventory: {
         receipt: 'মাল গ্রহণ (GRN)',
         product: 'প্রোডাক্ট কোড',
@@ -414,6 +425,9 @@ export const bn: Messages = {
     customer: 'গ্রাহক',
     customerPlaceholder: 'একজন গ্রাহক বাছুন',
     noCustomer: 'কোনো গ্রাহক নেই',
+    supplier: 'সাপ্লায়ার',
+    supplierPlaceholder: 'একজন সাপ্লায়ার বাছুন',
+    noSupplier: 'কোনো সাপ্লায়ার নেই',
     branch: 'ব্রাঞ্চ',
     noBranch: 'কোনো ব্রাঞ্চ না',
     debit: 'ডেবিট',
@@ -503,6 +517,9 @@ export const bn: Messages = {
     noCustomer: 'কোনো গ্রাহক নেই',
     noCustomerHint:
       'গ্রাহক রাখা শুরুর আগে পোস্ট করা। এন্ট্রিটা রিভার্স করে গ্রাহকসহ আবার পোস্ট করুন।',
+    noSupplier: 'কোনো সাপ্লায়ার নেই',
+    noSupplierHint:
+      'সাপ্লায়ার রাখা শুরুর আগে পোস্ট করা। এন্ট্রিটা রিভার্স করে সাপ্লায়ারসহ আবার পোস্ট করুন।',
     pickTitle: 'একটা অ্যাকাউন্ট বাছুন',
     pickBody: 'এন্ট্রি দেখতে উপরে একটা অ্যাকাউন্ট বাছুন, যেমন হাতে নগদ বা অফিস ভাড়া।',
     emptyTitle: 'এই তারিখগুলোতে কোনো এন্ট্রি নেই',
@@ -529,6 +546,13 @@ export const bn: Messages = {
       'প্রতিটা গ্রাহকের কাছে কত পাওনা ছিল, একেকজনের জন্য এক লাইনে লিখুন। অ্যাকাউন্টে থাকে তাদের মোট।',
     noCustomerHint:
       'গ্রাহক রাখা শুরুর আগে সেভ করা। গ্রাহক বাছুন, অথবা টাকাটা কয়েকটা লাইনে ভাগ করুন।',
+    supplier: 'সাপ্লায়ার',
+    supplierPlaceholder: 'একজন সাপ্লায়ার বাছুন',
+    addSupplier: 'সাপ্লায়ার যোগ করুন',
+    payableHint:
+      'প্রতিটা সাপ্লায়ারকে কত দেনা ছিল, একেকজনের জন্য এক লাইনে লিখুন। অ্যাকাউন্টে থাকে তাদের মোট।',
+    noSupplierHint:
+      'সাপ্লায়ার রাখা শুরুর আগে সেভ করা। সাপ্লায়ার বাছুন, অথবা টাকাটা কয়েকটা লাইনে ভাগ করুন।',
     differenceHint: 'ব্যালান্সগুলো যতটা গরমিল, সেটা এখানে যায়। সব দেওয়া হলে এটা শূন্য হয়।',
     save: 'ওপেনিং ব্যালান্স পোস্ট করুন',
     saved: 'ওপেনিং ব্যালান্স {{number}} হিসেবে পোস্ট হয়েছে',
@@ -1468,10 +1492,16 @@ export const bn: Messages = {
     confirmDelete: '{{code}} মুছুন',
     deleteWarning:
       'এটা আর ফেরানো যাবে না। যে গ্রাহকের এন্ট্রি বা ডকুমেন্ট আছে, তাকে শুধু আর্কাইভ করা যায়।',
+    deleteSideWarning:
+      '{{name}} একজন সাপ্লায়ারও। শুধু গ্রাহকের দিকটা সরবে, তার শিপিং ঠিকানা আর বিক্রির শর্তসহ। সাপ্লায়ার আর তার এন্ট্রি থেকে যাবে।',
     deleted: '{{name}} মুছে ফেলা হয়েছে',
+    sideDeleted: '{{name}} আর গ্রাহক নেই',
     archivedNotice:
       'এই গ্রাহক আর্কাইভ করা: নতুন ডকুমেন্টে দেখাবে না। ইতিহাস আর ব্যালান্স থেকে যায়।',
     alsoSupplier: 'সাপ্লায়ারও',
+    makeSupplier: 'সাপ্লায়ারও বানান',
+    madeSupplier: '{{name}} এখন সাপ্লায়ারও',
+    supplierPage: 'সাপ্লায়ার হিসেবে খুলুন',
     kpis: {
       balance: 'ব্যালান্স',
       creditLimit: 'ক্রেডিট লিমিট',
@@ -2287,6 +2317,346 @@ export const bn: Messages = {
     postInvoice: 'তবুও পোস্ট করুন',
     back: 'ফিরে যান',
   },
+  suppliers: {
+    title: 'সাপ্লায়ার',
+    description: 'যে মিল, ইমপোর্টার আর ভেন্ডরের কাছ থেকে কেনেন, আর তাদের কত দেনা',
+    add: 'সাপ্লায়ার যোগ করুন',
+    searchLabel: 'সাপ্লায়ার খুঁজুন',
+    searchPlaceholder: 'নাম, কোড, যোগাযোগের মানুষ বা ফোন',
+    group: 'গ্রুপ',
+    allGroups: 'সব গ্রুপ',
+    allSuppliers: 'সব সাপ্লায়ার',
+    show: 'দেখান',
+    statuses: { active: 'চালু', archived: 'আর্কাইভ' },
+    columns: {
+      supplier: 'সাপ্লায়ার',
+      phone: 'ফোন',
+      group: 'গ্রুপ',
+      terms: 'শর্ত',
+      balance: 'ব্যালান্স',
+    },
+    termsDays_one: '{{count}} দিন',
+    termsDays_other: '{{count}} দিন',
+    onReceipt: 'পাওয়ামাত্র',
+    emptyTitle: 'এখনো কোনো সাপ্লায়ার নেই',
+    emptyBody:
+      'প্রথম সাপ্লায়ার যোগ করুন, যেমন নারায়ণগঞ্জের একটা সুতার মিল বা গাজীপুরের একজন কার্টন বানানেওয়ালা। তাদের এন্ট্রি পোস্ট হলে কত দেনা তা এখানে দেখাবে।',
+    noMatchTitle: '"{{query}}"-এর সাথে কোনো সাপ্লায়ার মেলেনি',
+    noMatchBody: 'বানান দেখুন, অথবা কোড বা ফোন নম্বর দিয়ে খুঁজুন।',
+    archivedEmptyTitle: 'কোনো আর্কাইভ করা সাপ্লায়ার নেই',
+    archivedEmptyBody: 'আর্কাইভ করা সাপ্লায়ার এখানে দেখাবে। তাদের ইতিহাস আর দেনা থেকে যায়।',
+    loadFailed: 'সাপ্লায়ারের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'আপনি সাপ্লায়ার দেখতে পারেন। বদলাতে purchase.supplier.manage অনুমতি চান।',
+    back: 'সাপ্লায়ার',
+    newTitle: 'নতুন সাপ্লায়ার',
+    editTitle: '{{code}} বদলান',
+    notFound: 'এই সাপ্লায়ার নেই, অথবা মুছে ফেলা হয়েছে।',
+    sections: {
+      basics: 'মূল তথ্য',
+      terms: 'কেনার শর্ত',
+      termsHint: 'এই সাপ্লায়ারের প্রতিটা বিলে লাগে।',
+      bankAccounts: 'ব্যাংক অ্যাকাউন্ট',
+      bankAccountsHint:
+        'এই সাপ্লায়ারকে যেখানে টাকা দেন, {{max}}টা পর্যন্ত। পেমেন্টের স্ক্রিনে এগুলো দেখায়।',
+    },
+    fields: {
+      code: 'কোড',
+      codeHint: 'খালি রাখলে পরের নম্বর বসবে, যেমন S-00042।',
+      name: 'নাম',
+      namePlaceholder: 'মেঘনা স্পিনিং মিলস',
+      group: 'গ্রুপ',
+      noGroup: 'কোনো গ্রুপ নেই',
+      contactPerson: 'যোগাযোগের মানুষ',
+      contactPersonPlaceholder: 'মো. রফিকুল ইসলাম',
+      phone: 'ফোন',
+      email: 'ইমেইল',
+      bin: 'BIN',
+      binHint: 'সাপ্লায়ারের ১৩ অঙ্কের VAT নিবন্ধন নম্বর, তার মূসক ৬.৩-এ ছাপা থাকে',
+      paymentTerms: 'পেমেন্টের শর্ত',
+      paymentTermsHint: 'বিল থেকে পরিশোধের শেষ দিন পর্যন্ত কত দিন। ০ = পাওয়ামাত্র।',
+      days: 'দিন',
+      documentLanguage: 'ডকুমেন্টের ভাষা',
+      documentLanguageHint: 'এই সাপ্লায়ারের পারচেজ অর্ডার আর ইমেইল এই ভাষায় শুরু হয়।',
+      address: 'ঠিকানা',
+      addressHint: 'পারচেজ অর্ডারে ছাপা হয়। এই সাপ্লায়ার গ্রাহকও হলে, এটাই তার বিলিং ঠিকানা।',
+      addressPlaceholder: 'প্লট ১২, বিসিক শিল্পনগরী, ফতুল্লা, নারায়ণগঞ্জ',
+      notes: 'নোট',
+      notesPlaceholder: 'শুধু শনিবারে মাল দেয়। চালানের সাথে বিল পাঠায়।',
+    },
+    bankAccounts: {
+      number: 'ব্যাংক অ্যাকাউন্ট {{number}}',
+      bankName: 'ব্যাংক',
+      bankNamePlaceholder: 'ডাচ্-বাংলা ব্যাংক',
+      branchName: 'শাখা',
+      branchNamePlaceholder: 'নারায়ণগঞ্জ',
+      accountName: 'অ্যাকাউন্টের নাম',
+      accountNamePlaceholder: 'মেঘনা স্পিনিং মিলস লিমিটেড',
+      accountNumber: 'অ্যাকাউন্ট নম্বর',
+      accountNumberHint: 'ফাঁকা জায়গা আর ড্যাশ বাদ যায়।',
+      routingNumber: 'রাউটিং নম্বর',
+      routingNumberHint: '৯ অঙ্ক, চেকের পাতায় ছাপা থাকে',
+      add: 'ব্যাংক অ্যাকাউন্ট যোগ করুন',
+      remove: 'ব্যাংক অ্যাকাউন্ট {{number}} সরান',
+      empty:
+        'এখনো কোনো ব্যাংক অ্যাকাউন্ট নেই। যে অ্যাকাউন্টে এই সাপ্লায়ারকে টাকা দেন সেটা যোগ করুন।',
+      bankAndBranch: '{{bank}}, {{branch}}',
+      routing: 'রাউটিং {{number}}',
+    },
+    create: 'সাপ্লায়ার যোগ করুন',
+    save: 'সাপ্লায়ার সেভ করুন',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}} সেভ হয়েছে',
+    edit: 'বদলান',
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
+    delete: 'মুছুন',
+    confirmDelete: '{{code}} মুছুন',
+    deleteWarning:
+      'এটা আর ফেরানো যাবে না। যে সাপ্লায়ারের এন্ট্রি বা ডকুমেন্ট আছে, তাকে শুধু আর্কাইভ করা যায়।',
+    deleteSideWarning:
+      '{{name}} একজন গ্রাহকও। শুধু সাপ্লায়ারের দিকটা সরবে, তার ব্যাংক অ্যাকাউন্ট আর কেনার শর্তসহ। গ্রাহক আর তার এন্ট্রি থেকে যাবে।',
+    deleted: '{{name}} মুছে ফেলা হয়েছে',
+    sideDeleted: '{{name}} আর সাপ্লায়ার নেই',
+    archivedNotice:
+      'এই সাপ্লায়ার আর্কাইভ করা: নতুন ডকুমেন্টে দেখাবে না। ইতিহাস আর ব্যালান্স থেকে যায়।',
+    alsoCustomer: 'গ্রাহকও',
+    makeCustomer: 'গ্রাহকও বানান',
+    madeCustomer: '{{name}} এখন গ্রাহকও',
+    customerPage: 'গ্রাহক হিসেবে খুলুন',
+    kpis: {
+      balance: 'ব্যালান্স',
+      terms: 'পেমেন্টের শর্ত',
+      bankAccounts: 'ব্যাংক অ্যাকাউন্ট',
+    },
+    owe: '{{amount}} দেনা',
+    inAdvance: '{{amount}} অগ্রিম দেওয়া',
+    settled: 'কোনো দেনা নেই',
+    details: 'বিস্তারিত',
+    noAddress: 'কোনো ঠিকানা নেই',
+    noBankAccounts: 'কোনো ব্যাংক অ্যাকাউন্ট নেই',
+    statementTitle: 'স্টেটমেন্ট',
+    statementSubtitle: 'এই সাপ্লায়ারের পোস্ট করা এন্ট্রি, প্রতিটার পরে কত দেনা',
+    statementEmptyTitle: 'এই তারিখগুলোতে কোনো এন্ট্রি নেই',
+    statementEmptyBody:
+      'অন্য তারিখ বাছুন। ওপেনিং ব্যালান্স, বিল আর পেমেন্ট পোস্ট হলে এখানে দেখাবে।',
+    statementLoadFailed: 'স্টেটমেন্ট আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    pickerSearch: 'সাপ্লায়ার খুঁজুন',
+    pickerEmpty: 'কোনো চালু সাপ্লায়ার মেলেনি',
+  },
+  supplierGroups: {
+    title: 'সাপ্লায়ারের গ্রুপ',
+    description: 'সুতা ও কাপড়, এক্সেসরিজ, প্যাকেজিংয়ের মতো গ্রুপ, সাপ্লায়ার সাজাতে আর ছাঁকতে',
+    add: 'গ্রুপ যোগ করুন',
+    columns: {
+      name: 'গ্রুপ',
+      suppliers: 'সাপ্লায়ার',
+    },
+    supplierCount_one: '{{formatted}} জন সাপ্লায়ার',
+    supplierCount_other: '{{formatted}} জন সাপ্লায়ার',
+    newTitle: 'গ্রুপ যোগ করুন',
+    editTitle: '{{name}} বদলান',
+    name: 'নাম',
+    namePlaceholder: 'সুতা ও কাপড়',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}} সেভ হয়েছে',
+    delete: 'মুছুন',
+    confirmDelete: '{{name}} মুছুন',
+    deleteWarning: 'শুধু সাপ্লায়ারহীন গ্রুপ মোছা যায়।',
+    deleted: '{{name}} মুছে ফেলা হয়েছে',
+    emptyTitle: 'এখনো কোনো সাপ্লায়ারের গ্রুপ নেই',
+    emptyBody:
+      'সুতা ও কাপড়, এক্সেসরিজ, প্যাকেজিংয়ের মতো গ্রুপ যোগ করুন, তারপর প্রতিটা সাপ্লায়ারকে একটায় রাখুন।',
+    loadFailed: 'সাপ্লায়ারের গ্রুপ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'গ্রুপ বদলাতে purchase.supplier.manage অনুমতি চান।',
+  },
+  purchaseLines: {
+    items: 'আইটেম',
+    addItems: 'আইটেম যোগ করুন',
+    pickerTitle: 'আইটেম যোগ করুন',
+    pickerDescription: 'প্রোডাক্ট আর সার্ভিস খুঁজুন। প্রতি ক্লিকে কেনার ইউনিটে একটা লাইন যোগ হয়।',
+    pickerSearch: 'প্রোডাক্ট আর সার্ভিস খুঁজুন',
+    pickerEmpty: 'কোনো চালু প্রোডাক্ট মেলেনি। বানান দেখুন, অথবা কোড বা SKU দিয়ে খুঁজুন।',
+    add: 'যোগ করুন',
+    added: 'যোগ হয়েছে',
+    service: 'সার্ভিস',
+    line: 'লাইন {{number}}',
+    remove: 'লাইন {{number}} সরান',
+    item: 'আইটেম',
+    description: 'বিবরণ',
+    quantity: 'পরিমাণ',
+    unit: 'ইউনিট',
+    estimatedCost: 'আনুমানিক খরচ',
+    costPer: 'প্রতি {{unit}}-এর খরচ',
+    amount: 'টাকা',
+    fromAverage: 'গড় খরচ থেকে',
+    noCost: 'খরচ জানা নেই: লিখে দিন',
+    noLines: 'এখনো কোনো আইটেম নেই। যা কিনতে হবে তা যোগ করুন।',
+    tooMany: 'একটা ডকুমেন্টে {{max}}টা পর্যন্ত লাইন থাকে। বাকিগুলোর জন্য আরেকটা লিখুন।',
+    lineCount_one: '{{count}}টা আইটেম',
+    lineCount_other: '{{count}}টা আইটেম',
+    total: 'আনুমানিক মোট',
+  },
+  requisitions: {
+    title: 'পারচেজ রিকুইজিশন',
+    description: 'মাল বা সার্ভিস কেনার অনুরোধ, কেউ অর্ডার দেওয়ার আগে অনুমোদিত',
+    new: 'নতুন রিকুইজিশন',
+    newTitle: 'নতুন পারচেজ রিকুইজিশন',
+    back: 'রিকুইজিশন',
+    show: 'দেখান',
+    all: 'সব',
+    allWarehouses: 'সব গুদাম',
+    statuses: {
+      draft: 'খসড়া',
+      pending: 'অনুমোদনের অপেক্ষায়',
+      approved: 'অনুমোদিত',
+      cancelled: 'বাতিল',
+    },
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      warehouse: 'গুদাম',
+      neededBy: 'যেদিনের মধ্যে লাগবে',
+      requestedBy: 'যিনি চেয়েছেন',
+      amount: 'আনুমানিক টাকা',
+      status: 'অবস্থা',
+    },
+    date: 'তারিখ',
+    warehouse: 'গুদাম',
+    warehouseHint: 'যেখানে মাল লাগবে। এর ব্রাঞ্চই রিকুইজিশনের ব্রাঞ্চ।',
+    neededBy: 'যেদিনের মধ্যে লাগবে',
+    neededByHint: 'কোনো তারিখ না থাকলে খালি রাখুন।',
+    noDate: 'কোনো তারিখ নেই',
+    note: 'নোট',
+    notePlaceholder:
+      'বায়ার PO-HM-2026-1187-এর জন্য: নেভি রঙের ২,০০০ পোলো শার্ট। কাটিং শুরু ১০ নভেম্বর।',
+    requestedBy: 'যিনি চেয়েছেন',
+    save: 'রিকুইজিশন সেভ করুন',
+    saved: '{{number}} সেভ হয়েছে',
+    edit: 'বদলান',
+    submit: 'অনুমোদনে পাঠান',
+    submitHint:
+      'এর আনুমানিক টাকা ঠিক করে কে অনুমোদন করবেন। অপেক্ষার সময় কেউ এটা বদলাতে পারবেন না।',
+    submitted: '{{number}} অনুমোদনে পাঠানো হয়েছে',
+    submittedApproved: '{{number}} অনুমোদিত',
+    reopen: 'আবার খুলুন',
+    reopenTitle: '{{number}} আবার খুলুন',
+    reopenBody:
+      'বদলানোর জন্য এটা খসড়ায় ফিরবে। আবার পাঠালে প্রথম লেভেল থেকে আবার অনুমোদন হবে। এই দফা এর ইতিহাসে থেকে যাবে।',
+    reopened: '{{number}} আবার খসড়া',
+    cancel: 'রিকুইজিশন বাতিল করুন',
+    cancelTitle: '{{number}} বাতিল করুন',
+    cancelBody: 'এখান থেকে আর কেউ অর্ডার দিতে পারবেন না। ইতিহাসসহ তালিকায় বাতিল হিসেবে থেকে যাবে।',
+    keep: 'রেখে দিন',
+    cancelled: '{{number}} বাতিল হয়েছে',
+    delete: 'রিকুইজিশন মুছুন',
+    confirmDelete: '{{number}} মুছুন',
+    deleteWarning:
+      'এটা আর ফেরানো যাবে না। এর নম্বর আর ব্যবহার হবে না। একবারও অনুমোদনে পাঠানো রিকুইজিশন শুধু বাতিল করা যায়।',
+    deleted: '{{number}} মুছে ফেলা হয়েছে',
+    notices: {
+      pending: 'অনুমোদনের অপেক্ষায়। বদলাতে আবার খুলুন।',
+      approved: 'অনুমোদিত, তাই বদলানো যায় না। বদলাতে আবার খুলুন; তখন আবার অনুমোদন লাগবে।',
+      cancelled: 'বাতিল। রেকর্ডের জন্য এখানে থেকে যায়।',
+      rejected: '{{name}} ফেরত পাঠিয়েছেন: "{{comment}}" বদলে আবার অনুমোদনে পাঠান।',
+    },
+    cantWrite:
+      'আপনি রিকুইজিশন দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে purchase.requisition.manage permission চান।',
+    notFound: 'এই রিকুইজিশন নেই, অথবা মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো রিকুইজিশন নেই',
+    emptyBody:
+      'স্টোর বা ফ্লোরের কিছু লাগলে একটা লিখুন, যেমন ৩০s সুতার ২,০০০ কোন বা সেলাই মেশিনের একটা মোটর। কেউ অর্ডার দেওয়ার আগে এটা অনুমোদন হয়।',
+    loadFailed: 'রিকুইজিশনগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  approvals: {
+    title: 'অনুমোদন',
+    description: 'যে ডকুমেন্টগুলো আপনার সিদ্ধান্তের অপেক্ষায়, সবচেয়ে পুরনোটা আগে',
+    kinds: { requisition: 'রিকুইজিশন' },
+    columns: {
+      document: 'ডকুমেন্ট',
+      date: 'তারিখ',
+      subject: 'যার জন্য',
+      submittedBy: 'যিনি পাঠিয়েছেন',
+      amount: 'টাকা',
+      step: 'ধাপ',
+    },
+    stepOf: '{{count}}-এর মধ্যে {{position}}',
+    emptyTitle: 'কিছুই আপনার অপেক্ষায় নেই',
+    emptyBody:
+      'কেউ এমন রিকুইজিশন পাঠালে যাতে আপনার রোল লাগে, সেটা এখানে দেখাবে আর বেল আপনাকে জানাবে।',
+    loadFailed: 'আপনার অপেক্ষার ডকুমেন্টগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    cardTitle: 'অনুমোদন',
+    cardSubtitle: 'যতগুলো লেভেলে পৌঁছায়, একটার পর একটা অনুমোদন করে',
+    rounds: {
+      pending: 'অপেক্ষায়',
+      approved: 'অনুমোদিত',
+      rejected: 'ফেরত পাঠানো',
+      reopened: 'আবার খোলা',
+    },
+    round: 'দফা {{number}}',
+    earlierRounds: 'আগের দফাগুলো',
+    submitted: '{{name}} {{date}}-এ {{amount}}-এর জন্য পাঠিয়েছেন',
+    levelLine: '{{role}} · {{amount}} থেকে',
+    deletedRole: '{{name}} (মুছে ফেলা রোল)',
+    steps: {
+      approved: 'অনুমোদিত',
+      rejected: 'ফেরত পাঠানো',
+      waiting: 'অপেক্ষায়',
+      notYet: 'এখনো না',
+      notDecided: 'সিদ্ধান্ত হয়নি',
+    },
+    decided: '{{name}}, {{date}}',
+    noLevels: 'কোনো লেভেল লাগেনি, তাই পাঠানোর সাথে সাথে অনুমোদিত।',
+    ownerSubmitted: 'একজন Owner পাঠিয়েছেন, তাই সাথে সাথে অনুমোদিত।',
+    notSubmitted: 'এখনো পাঠানো হয়নি। এর টাকা যতগুলো লেভেলে পৌঁছায়, একটার পর একটা অনুমোদন করবে।',
+    waitingForYou: 'ধাপ {{position}} আপনার অপেক্ষায়।',
+    waitingFor: '{{role}}-এর অপেক্ষায়',
+    ownDocument: 'আপনি পাঠিয়েছেন, তাই অন্য কেউ অনুমোদন করবেন।',
+    approve: 'অনুমোদন করুন',
+    reject: 'ফেরত পাঠান',
+    approveTitle: '{{number}} অনুমোদন করুন',
+    approveBody: '{{role}} হিসেবে {{count}}-এর মধ্যে ধাপ {{position}} অনুমোদন করছেন।',
+    approveLast: 'এটাই শেষ ধাপ: আপনি অনুমোদন করলে {{number}} অনুমোদিত হবে।',
+    approveNext: 'আপনি অনুমোদন করলে পরের লেভেলকে জানানো হবে।',
+    comment: 'মন্তব্য',
+    approveCommentPlaceholder: 'নভেম্বরের প্রোডাকশন প্ল্যানের জন্য ঠিক আছে',
+    rejectTitle: '{{number}} ফেরত পাঠান',
+    rejectBody: 'এটা খসড়ায় ফিরবে। {{name}} আপনার মন্তব্য দেখবেন, বদলে আবার পাঠাতে পারবেন।',
+    rejectComment: 'কী বদলাতে হবে',
+    rejectCommentPlaceholder: '২,০০০ না, ১,৫০০ কোন অর্ডার দিন: অক্টোবরের প্ল্যান বদলেছে।',
+    confirmApprove: 'অনুমোদন করুন',
+    confirmReject: 'খসড়ায় ফেরত পাঠান',
+    approvedToast: '{{number}}-এ আপনার অনুমোদন সেভ হয়েছে',
+    rejectedToast: '{{number}} খসড়ায় ফেরত পাঠানো হয়েছে',
+  },
+  approvalRules: {
+    title: 'অনুমোদনের লেভেল',
+    description:
+      'কোন ডকুমেন্ট কে অনুমোদন করবেন, টাকার পরিমাণ অনুযায়ী। একটা ডকুমেন্ট যতগুলো লেভেলে পৌঁছায়, একটার পর একটা পার হয়।',
+    documents: {
+      requisition: {
+        title: 'পারচেজ রিকুইজিশন',
+        subtitle: 'রিকুইজিশনের আনুমানিক টাকা অনুযায়ী',
+      },
+    },
+    level: 'লেভেল {{number}}',
+    from: 'যত টাকা থেকে',
+    fromHint: 'এই টাকা থেকে উপরে। ০ = প্রতিটা ডকুমেন্ট।',
+    role: 'রোল',
+    rolePlaceholder: 'একটা রোল বাছুন',
+    add: 'লেভেল যোগ করুন',
+    remove: 'লেভেল {{number}} সরান',
+    none: 'কোনো লেভেল নেই: এই ডকুমেন্টগুলো পাঠানোর সাথে সাথে অনুমোদিত হয়।',
+    tooMany: '{{max}}টা পর্যন্ত লেভেল।',
+    rules:
+      'প্রতিটা লেভেল তার উপরের লেভেলের টাকা থেকে বা তার বেশি থেকে শুরু হয়, আর একটা রোল একবারই থাকে। একজন Owner যেকোনো লেভেল অনুমোদন করতে পারেন, আর Owner-এর নিজের ডকুমেন্ট পাঠানোর সাথে সাথে অনুমোদিত হয়।',
+    applies: 'যে ডকুমেন্ট আগে থেকেই অপেক্ষায়, সেগুলো পাঠানোর সময়ের লেভেলই রাখে।',
+    save: 'লেভেল সেভ করুন',
+    saved: '{{document}}: লেভেল সেভ হয়েছে',
+    readOnly: 'আপনি লেভেলগুলো দেখতে পারেন। বদলাতে core.settings.manage অনুমতি চান।',
+    loadFailed: 'অনুমোদনের লেভেল আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   documentOutput: {
     kinds: {
       quotation: 'কোটেশন',
@@ -2554,6 +2924,7 @@ export const bn: Messages = {
       accounting: 'হিসাবরক্ষণ',
       inventory: 'ইনভেন্টরি',
       sales: 'বিক্রি',
+      purchase: 'কেনাকাটা',
     },
     members_one: '{{count}} জন',
     members_other: '{{count}} জন',
@@ -2631,6 +3002,15 @@ export const bn: Messages = {
       credit_note: { manage: 'ক্রেডিট নোট লেখা, পোস্ট করা আর ইনভয়েসে ধরা' },
       refund: { manage: 'গ্রাহকদের টাকা ফেরত দেওয়া, আর রিফান্ড বাতিল করা' },
     },
+    purchase: {
+      supplier: {
+        manage: 'সাপ্লায়ার আর তাদের গ্রুপ যোগ, বদল আর আর্কাইভ করা',
+        balance: 'সাপ্লায়ারদের কাছে কোম্পানির কত দেনা, আর তাদের স্টেটমেন্ট দেখা',
+      },
+      requisition: {
+        manage: 'রিকুইজিশন লেখা, অনুমোদনে পাঠানো, আবার খোলা আর বাতিল করা',
+      },
+    },
   },
   invite: {
     checking: 'আপনার আমন্ত্রণ দেখা হচ্ছে…',
@@ -2689,6 +3069,9 @@ export const bn: Messages = {
       sales_return: 'সেলস রিটার্ন',
       credit_note: 'ক্রেডিট নোট',
       refund: 'রিফান্ড',
+      supplier: 'সাপ্লায়ার',
+      supplier_group: 'সাপ্লায়ারের গ্রুপ',
+      requisition: 'পারচেজ রিকুইজিশন',
     },
     columns: {
       when: 'কখন',
@@ -2882,6 +3265,31 @@ export const bn: Messages = {
         voided: 'একটা রিফান্ড বাতিল করেছেন',
       },
       sales_accounts: { changed: 'সেলস রিটার্নের অ্যাকাউন্ট বদলেছেন' },
+      supplier: {
+        created: 'একজন সাপ্লায়ার যোগ করেছেন',
+        updated: 'একজন সাপ্লায়ারের তথ্য বদলেছেন',
+        archived: 'একজন সাপ্লায়ার আর্কাইভ করেছেন',
+        restored: 'একজন সাপ্লায়ার ফিরিয়ে এনেছেন',
+        deleted: 'একজন সাপ্লায়ার মুছেছেন',
+      },
+      supplier_group: {
+        created: 'একটা সাপ্লায়ারের গ্রুপ যোগ করেছেন',
+        updated: 'একটা সাপ্লায়ারের গ্রুপের নাম বদলেছেন',
+        deleted: 'একটা সাপ্লায়ারের গ্রুপ মুছেছেন',
+      },
+      approval_rules: { changed: 'অনুমোদনের লেভেল বদলেছেন' },
+      requisition: {
+        created: 'একটা রিকুইজিশন লিখেছেন',
+        updated: 'একটা খসড়া রিকুইজিশন বদলেছেন',
+        deleted: 'একটা খসড়া রিকুইজিশন মুছেছেন',
+        cancelled: 'একটা রিকুইজিশন বাতিল করেছেন',
+      },
+      approval: {
+        submitted: 'অনুমোদনে পাঠিয়েছেন',
+        approved: 'একটা ধাপ অনুমোদন করেছেন',
+        rejected: 'খসড়ায় ফেরত পাঠিয়েছেন',
+        reopened: 'আবার খুলে খসড়ায় ফিরিয়েছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -2961,7 +3369,7 @@ export const bn: Messages = {
       rates: 'VAT রেট',
       taxRate: 'VAT রেট',
       pricesIncludeVat: 'দামে VAT ধরা',
-      group: 'গ্রাহকের গ্রুপ',
+      group: 'গ্রুপ',
       paymentTermsDays: 'পেমেন্টের শর্ত (দিন)',
       creditLimit: 'ক্রেডিট লিমিট',
       priceList: 'দামের তালিকা',
@@ -2986,6 +3394,14 @@ export const bn: Messages = {
       applied: 'ধরা হয়েছে',
       source: 'যেখান থেকে ফেরত',
       returns: 'সেলস রিটার্নের অ্যাকাউন্ট',
+      bankAccounts: 'ব্যাংক অ্যাকাউন্ট',
+      neededBy: 'যেদিনের মধ্যে লাগবে',
+      status: 'অবস্থা',
+      steps: 'লেভেল',
+      step: 'ধাপ',
+      role: 'রোল',
+      comment: 'মন্তব্য',
+      requisition: 'পারচেজ রিকুইজিশন',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -3042,7 +3458,8 @@ export const bn: Messages = {
     markAllRead: 'সব পড়া হয়েছে',
     unread: 'পড়া হয়নি',
     emptyTitle: 'এখনো কোনো নোটিফিকেশন নেই',
-    emptyBody: 'আপনার আমন্ত্রণে কেউ যোগ দিলে, বা কোনো ইমেইল পাঠানো না গেলে এখানে জানতে পারবেন।',
+    emptyBody:
+      'আপনার আমন্ত্রণে কেউ যোগ দিলে, কোনো ডকুমেন্ট আপনার অনুমোদনের অপেক্ষায় থাকলে, বা কোনো ইমেইল পাঠানো না গেলে এখানে জানতে পারবেন।',
     loadFailed: 'নোটিফিকেশন আনা যায়নি। একটু পরে আবার চেষ্টা করুন।',
     types: {
       workspace: {
@@ -3067,6 +3484,11 @@ export const bn: Messages = {
       document: {
         email_failed: '{{document}} {{number}} ইমেইল করা যায়নি। ঠিকানা দেখে আবার পাঠান।',
       },
+      approval: {
+        requested: '{{document}} {{number}} আপনার অনুমোদনের অপেক্ষায়।',
+        approved: '{{document}} {{number}} অনুমোদিত হয়েছে।',
+        rejected: '{{document}} {{number}} খসড়ায় ফেরত এসেছে। কেন, খুলে দেখুন।',
+      },
     },
   },
   errors: {
@@ -3122,7 +3544,7 @@ export const bn: Messages = {
     last_owner: 'অন্তত একজন owner রাখতে হবে। আগে আরেকজনকে owner বানান।',
     own_membership: 'নিজের রোল বদলানো বা নিজেকে সরানো যায় না। আরেকজন অ্যাডমিনকে বলুন।',
     role_in_use:
-      'এই রোল কারো আছে, বা কোনো খোলা আমন্ত্রণে আছে। আগে তাঁদের রোল বদলান বা আমন্ত্রণ বাতিল করুন।',
+      'এই রোল কারো আছে, কোনো খোলা আমন্ত্রণে আছে, কোনো অনুমোদনের ধাপে আছে, বা কোনো ডকুমেন্ট এর অনুমোদনের অপেক্ষায়। আগে সেটা বদলান: তাঁদের রোল, আমন্ত্রণ, Settings → Approval levels, বা ডকুমেন্ট।',
     setup_started: 'সেটআপ আগেই শুরু হয়েছে। কতদূর হলো দেখতে পেজটা রিলোড করুন।',
     setup_not_failed: 'সেটআপ ব্যর্থ হয়নি। কতদূর হলো দেখতে পেজটা রিলোড করুন।',
     account_code_format: 'সংখ্যা দিন, যেমন 1121। মাঝে ডট বা হাইফেন দেওয়া যায়, যেমন 1-1-21।',
@@ -3323,11 +3745,12 @@ export const bn: Messages = {
     price_list_invalid: 'একটা চালু দামের তালিকা বাছুন। এটা আর্কাইভ করা।',
     price_list_item_twice: 'এই আইটেম আর ইউনিট এখানে দুবার আছে। একটা রাখুন।',
     price_list_unit_invalid: 'এই ইউনিট আর প্রোডাক্টের ইউনিটের মধ্যে নেই। সারিটা সরান।',
-    journal_party_required: 'টাকাটা কোন গ্রাহকের, বাছুন।',
-    journal_party_not_allowed: 'শুধু পাওনার অ্যাকাউন্টের লাইনে গ্রাহক থাকে। গ্রাহকটা সরান।',
-    journal_party_invalid: 'একজন চালু গ্রাহক বাছুন। এই গ্রাহক আর্কাইভ করা বা মুছে ফেলা।',
+    journal_party_required: 'টাকাটা কার, বাছুন: পাওনার লাইনে গ্রাহক, দেনার লাইনে সাপ্লায়ার।',
+    journal_party_not_allowed:
+      'শুধু পাওনা বা দেনার অ্যাকাউন্টের লাইনে গ্রাহক বা সাপ্লায়ার থাকে। এটা সরান।',
+    journal_party_invalid: 'পাওনার লাইনে একজন চালু গ্রাহক, দেনার লাইনে একজন চালু সাপ্লায়ার বাছুন।',
     opening_balance_twice:
-      'এই অ্যাকাউন্ট এখানে দুবার আছে। টাকাটা এক লাইনে দিন, অথবা অন্য গ্রাহক বাছুন।',
+      'এই অ্যাকাউন্ট এখানে দুবার আছে। টাকাটা এক লাইনে দিন, অথবা অন্য গ্রাহক বা সাপ্লায়ার বাছুন।',
     sales_customer_required: 'গ্রাহক বাছুন।',
     sales_customer_invalid:
       'একজন চালু গ্রাহক বাছুন। যে অর্ডারের নম্বর আছে, বা যেটা কোটেশন থেকে এসেছে, তার গ্রাহক বদলায় না।',
@@ -3448,6 +3871,43 @@ export const bn: Messages = {
     email_too_many: 'একটা ঘরে সর্বোচ্চ ৫টা ঠিকানা। বাকিদের আরেকটা ইমেইল পাঠান।',
     email_subject_required: 'একটা বিষয় লিখুন।',
     share_link_not_found: 'এই লিংক আর কাজ করে না। যিনি পাঠিয়েছেন, তাঁর কাছে নতুন লিংক চান।',
+    supplier_code_format: 'ফাঁকা ছাড়া অক্ষর আর সংখ্যা দিন, যেমন S-00042।',
+    supplier_code_taken:
+      'আরেকজন গ্রাহক বা সাপ্লায়ারের এই কোড আছে। অন্য কোড দিন, অথবা পরের নম্বরের জন্য খালি রাখুন।',
+    supplier_name_required: 'সাপ্লায়ারের নাম দিন, অন্তত ২ অক্ষর।',
+    supplier_group_invalid: 'তালিকা থেকে একটা গ্রুপ বাছুন। এটা মুছে ফেলা হয়েছে।',
+    supplier_in_use:
+      'এন্ট্রি বা কেনার ডকুমেন্টে এই সাপ্লায়ার আছে, তাই মোছা যাবে না। আর্কাইভ করুন।',
+    supplier_group_name_required: 'একটা নাম দিন, অন্তত ২ অক্ষর।',
+    supplier_group_name_taken: 'আরেকটা গ্রুপের এই নাম আছে।',
+    supplier_group_in_use: 'এই গ্রুপে সাপ্লায়ার আছে। আগে তাদের অন্য গ্রুপে সরান।',
+    supplier_bank_name_required: 'ব্যাংকের নাম দিন, অন্তত ২ অক্ষর।',
+    supplier_account_name_required: 'অ্যাকাউন্টটা যার নামে, সেই নাম দিন, অন্তত ২ অক্ষর।',
+    bank_account_number_format: 'অ্যাকাউন্ট নম্বর দিন: ৬ থেকে ২০ অঙ্ক।',
+    routing_number_format: '৯ অঙ্কের রাউটিং নম্বর দিন, অথবা খালি রাখুন।',
+    party_role_exists: 'এটা আগে থেকেই গ্রাহক আর সাপ্লায়ার দুটোই। পেজটা রিলোড করুন।',
+    approval_level_order: 'এই লেভেল তার উপরের লেভেলের টাকা থেকে বা তার বেশি থেকে শুরু করুন।',
+    approval_role_twice: 'এই রোল আরেকটা লেভেলে আছে। প্রতিটা রোল একবার দিন।',
+    approval_role_invalid: 'তালিকা থেকে একটা রোল বাছুন। এটা মুছে ফেলা হয়েছে।',
+    approval_not_pending:
+      'এই ডকুমেন্ট আর এই অনুমোদনের অপেক্ষায় নেই। এখন কোথায় আছে দেখতে রিলোড করুন।',
+    approval_not_allowed: 'এই ধাপে অন্য রোল লাগে। সেই রোলের কেউ, অথবা একজন Owner এর সিদ্ধান্ত দেন।',
+    approval_own_document: 'এই ডকুমেন্ট আপনি পাঠিয়েছেন, তাই অন্য কেউ অনুমোদন করবেন।',
+    approval_comment_required: 'কী বদলাতে হবে লিখুন, অন্তত ২ অক্ষর।',
+    purchase_warehouse_required: 'গুদাম বাছুন।',
+    purchase_warehouse_invalid: 'একটা চালু গুদাম বাছুন। এটা আর্কাইভ করা বা মুছে ফেলা হয়েছে।',
+    purchase_date_required: 'তারিখ দিন।',
+    purchase_lines_required: 'অন্তত একটা আইটেম যোগ করুন।',
+    purchase_item_invalid: 'একটা চালু প্রোডাক্ট বাছুন। এটা আর্কাইভ করা বা মুছে ফেলা হয়েছে।',
+    purchase_not_draft: 'এটা পাঠানো হয়ে গেছে, তাই বদলানো যাবে না। আগে আবার খুলুন।',
+    purchase_was_submitted:
+      'এটা একবার অনুমোদনে পাঠানো হয়েছিল, তাই এর অনুমোদনের ইতিহাস থাকবে। মোছার বদলে বাতিল করুন।',
+    purchase_cannot_reopen:
+      'শুধু অপেক্ষায় থাকা বা অনুমোদিত ডকুমেন্ট আবার খোলা যায়, আর তা-ও পরের কোনো ডকুমেন্ট এটা ব্যবহারের আগে।',
+    purchase_cannot_cancel:
+      'শুধু খসড়া বা অনুমোদিত ডকুমেন্ট বাতিল করা যায়। অপেক্ষায় থাকাটা আগে আবার খুলুন।',
+    requisition_needed_by: 'রিকুইজিশনের তারিখ বা তার পরের একটা দিন বাছুন।',
+    requisition_cost_required: 'আনুমানিক খরচ দিন। বিনা মূল্যের আইটেমে ০ দেওয়া যায়।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
```

The Bangla follows the words the app already uses: "সাপ্লায়ার" (as in the customer page's "সাপ্লায়ারও"),
"খসড়া", "বাতিল", "আবার খুলুন". A few choices:

- **"রিকুইজিশন"** is written in Bangla letters. It is the word offices in Bangladesh use for a purchase request,
  like PO and LC, so a translation such as "ক্রয়ের অনুরোধ" would read stranger than the English word.
- **"অনুমোদন"** for approval, **"লেভেল"** for a level and **"দফা"** for a round ("দফা ২"), the usual word for
  "the second time round" in office Bangla.
- **"দেনা"** for what the company owes a supplier, next to "পাওনা" for what a customer owes the company. The two
  words are the pair every accountant uses for payable and receivable.
- `rejected` is "ফেরত পাঠানো" (sent back), not "প্রত্যাখ্যাত": the document goes back to draft to be changed,
  it is not refused for good, and the softer word says that.
- Owner, role (as "রোল") and permission keys stay in English inside the Bangla text, as in the rest of the file
  (CLAUDE.md → Language).

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
```

Build `@omnivo/contracts` first: the i18n package reads its built `ErrorCode` type, so until then the 31 new codes
are unknown and the `satisfies` line fails the other way round. Build `@omnivo/i18n` before you type-check the ui
package and the app, which read its built types.

> **What we checked in this part.** `packages/i18n` type-checks, ESLint and Prettier are clean, its unit tests pass
> (11), and it builds. `packages/ui` type-checks against the new build. The app has two type errors left, both about
> the bell's `TARGET` map and the three `approval.*` types (17a.6). No error is about a missing translation key. To
> be sure `bn.ts` cannot fall behind, we removed one Bangla key on purpose: the type check failed at once, and passed
> again with the key back.

---

## 17a.6 — `apps/app`: the screens

This part adds the screens: the suppliers and their groups, the supplier on the payable lines of the books,
Settings → Approval levels, the requisitions with their approval, and the "waiting for me" list. It also changes a
few older screens: the customer page gets "Make supplier too", the bell opens a requisition, and three pages load a
part later so every page stays inside its bundle budget (decision 46).

When this part starts, the app has the two type errors that 17a.5 left in the bell. When it ends, the app
type-checks, its unit tests pass, and `pnpm test:bundle-size` passes. The mock API and the browser tests come in
17a.7, so nothing here is clicked through yet.

The order below is the order to write the files in: each one only uses files above it.

### The queries: `lib/queries.ts`

```diff
@@ -13,15 +13,19 @@ import {
   MAX_RECEIPT_ALLOCATIONS,
   type MemberSort,
   type OrderStatus,
+  type PartyRole,
   type ProductSort,
   type ProductStatus,
   type ProfitAndLossQuery,
   type QuotationStatus,
   type ReceiptStatus,
   type RefundStatus,
+  type RequisitionStatus,
   routes,
   type StockDocumentStatus,
   type StockFilter,
+  type SupplierSort,
+  type SupplierStatus,
   type TransferStatus,
   type TrialBalanceQuery,
   type WarehouseStatus,
@@ -645,25 +649,73 @@ export function customerCreditQuery(tenantId: string, customerId: string) {
   });
 }
 
-// The statement reads posted journal lines, so it lives under ['journal', tenantId] like the
-// ledger: posting or reversing an entry refreshes it
-export function customerStatementQuery(
+// A customer's or (step 17a) a supplier's statement. It reads posted journal lines, so it lives
+// under ['journal', tenantId] like the ledger: posting or reversing an entry refreshes it. The role
+// is in the key: a party that is both has one id and two statements (its receivable lines, its
+// payable lines).
+export function partyStatementQuery(
   tenantId: string,
-  customerId: string,
+  role: PartyRole,
+  partyId: string,
   from: string,
   to: string,
 ) {
   return infiniteQueryOptions({
-    queryKey: ['journal', tenantId, 'statement', customerId, from, to],
-    queryFn: ({ pageParam }: { pageParam: string | null }) =>
-      call(routes.customers.statement, {
-        params: { id: customerId },
+    queryKey: ['journal', tenantId, 'statement', role, partyId, from, to],
+    queryFn: ({ pageParam }: { pageParam: string | null }) => {
+      const args = {
+        params: { id: partyId },
         query: {
           limit: 100,
           ...(from !== '' && { from }),
           ...(to !== '' && { to }),
           ...(pageParam !== null && { cursor: pageParam }),
         },
+      };
+      // Two calls, not one call of a chosen route: each route is its own type, and both answer
+      // with the same ledger page
+      return role === 'customer'
+        ? call(routes.customers.statement, args)
+        : call(routes.suppliers.statement, args);
+    },
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// ---------------------------------------------------------------------------------------------
+// Suppliers (step 17a): everything under ['suppliers', tenantId], like the customers. A party that
+// is both is one row, so a save on either side refreshes both prefixes (usePartyRefresh in
+// supplier-parts.tsx). The statement is partyStatementQuery, above.
+
+export function supplierGroupsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['suppliers', tenantId, 'groups'],
+    queryFn: async () => (await call(routes.supplierGroups.list)).items,
+  });
+}
+
+export interface SupplierFilter {
+  search: string;
+  groupId: string;
+  status: SupplierStatus;
+  sort: SupplierSort;
+}
+
+export function supplierListQuery(tenantId: string, filter: SupplierFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['suppliers', tenantId, 'list', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.suppliers.list, {
+        query: {
+          limit: 50,
+          status: filter.status,
+          sort: filter.sort,
+          ...(filter.search !== '' && { search: filter.search }),
+          ...(filter.groupId !== '' && { groupId: filter.groupId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
       }),
     initialPageParam: null,
     getNextPageParam: (page) => page.nextCursor,
@@ -671,6 +723,28 @@ export function customerStatementQuery(
   });
 }
 
+// The supplier box on a payable line: the first 20 active suppliers that match
+export function supplierSearchQuery(tenantId: string, search: string) {
+  return queryOptions({
+    queryKey: ['suppliers', tenantId, 'search', search],
+    queryFn: async () =>
+      (
+        await call(routes.suppliers.list, {
+          query: { limit: 20, status: 'active', ...(search !== '' && { search }) },
+        })
+      ).items,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function supplierQuery(tenantId: string, supplierId: string) {
+  return queryOptions({
+    queryKey: ['suppliers', tenantId, 'supplier', supplierId],
+    queryFn: () => call(routes.suppliers.get, { params: { id: supplierId } }),
+    retry: false,
+  });
+}
+
 // Price lists: everything under ['price-lists', tenantId]. Saving prices changes the list's item
 // count and the items, and one invalidate refreshes both.
 export function priceListsQuery(tenantId: string) {
@@ -1095,3 +1169,71 @@ export function salesAccountsQuery(tenantId: string) {
     queryFn: () => call(routes.salesAccounts.get),
   });
 }
+
+// ---------------------------------------------------------------------------------------------
+// Requisitions and approvals (step 17a). Everything starts with ['purchase', tenantId]: approving a
+// requisition changes the requisition, its list, the "waiting for me" list and the navigation's
+// count, and one invalidate refreshes them all. 17b's purchase orders join the prefix.
+
+// The approval levels of every kind of document (Settings → Approval levels, and a draft's card)
+export function approvalRulesQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['approval-rules', tenantId],
+    queryFn: async () => (await call(routes.approvalRules.list)).items,
+  });
+}
+
+export interface RequisitionListFilter {
+  status: RequisitionStatus | '';
+  warehouseId: string;
+}
+
+export function requisitionsQuery(tenantId: string, filter: RequisitionListFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['purchase', tenantId, 'requisitions', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.requisitions.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function requisitionQuery(tenantId: string, requisitionId: string) {
+  return queryOptions({
+    queryKey: ['purchase', tenantId, 'requisition', requisitionId],
+    queryFn: () => call(routes.requisitions.get, { params: { id: requisitionId } }),
+    retry: false,
+  });
+}
+
+// "Waiting for me", oldest first
+export function waitingApprovalsQuery(tenantId: string) {
+  return infiniteQueryOptions({
+    queryKey: ['purchase', tenantId, 'waiting'],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.approvals.waiting, {
+        query: { limit: 50, ...(pageParam !== null && { cursor: pageParam }) },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+  });
+}
+
+// The navigation's count. Polled like the bell's badge (unreadCountQuery): every 30 seconds while
+// the tab is visible, so a requisition submitted in another office shows up without a reload.
+export function waitingCountQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['purchase', tenantId, 'waiting-count'],
+    queryFn: async () => (await call(routes.approvals.waitingCount)).count,
+    refetchInterval: 30_000,
+    staleTime: 0,
+  });
+}
```

- **`partyStatementQuery` replaces `customerStatementQuery`.** The customer's statement and the supplier's are the
  same ledger page from two routes, so one query serves both (decision 36). The role is in the key: a party that is
  both has one id, and without the role its receivable statement and its payable statement would share a cache
  entry and show each other's lines.
- **The `queryFn` makes two `call()`s, one per role,** instead of `call(role === 'customer' ? a : b)`. Each route is
  its own type; a value that is either one does not fit `call()`'s generic, and a cast would be needed. Both routes
  answer with the same `LedgerPage`, so the two branches have one result type.
- **The supplier queries copy the customer ones** under `['suppliers', tenant]` (decision 38). `supplierSearchQuery`
  asks for active suppliers only, like the customer search: the API refuses an archived party on a new journal line.
- **`approvalRulesQuery` is under `['approval-rules', tenant]`,** not under `['purchase', …]`. The rules change only on
  the settings page, and a requisition's approval does not change them, so they need not refetch after every
  decision.
- **`waitingCountQuery` polls like the bell's badge:** every 30 seconds while the tab is visible, with `staleTime: 0`
  so coming back to the tab asks at once. A store keeper in Gazipur submits a requisition; the manager's count in
  Dhaka goes up within half a minute without a reload.
- **`waitingApprovalsQuery` has no `placeholderData`.** It has no filter, so there is never an "old" page to keep on
  screen while a new one loads.

### One party box for both sides: `components/party-picker.tsx` (new)

```tsx
import { UserIcon } from '@hugeicons/core-free-icons';
import type { PartyRef, PartyRole } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Combobox, type ComboboxOption } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type Ref, useMemo, useState } from 'react';

import { partyLabel } from '../lib/customers';
import { customerSearchQuery, supplierSearchQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

export interface PartyPickerProps {
  id: string;
  name?: string;
  // The chosen party's id, or '' for none
  value: string;
  // The party the line was saved with, so the box can name it before any search ran
  saved: PartyRef | null;
  onChange: (value: string) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLButtonElement>;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  // A list's filter (step 15b): the first option, '' = every party, and the empty box's text
  allLabel?: string | undefined;
}

// What the box needs from a search result: a customer and a supplier summary both have it
interface PartyMatch {
  id: string;
  code: string;
  name: string;
  phone: string | null;
}

// The words of each side
const WORDS = {
  customer: {
    placeholder: 'journal.customerPlaceholder',
    search: 'customers.pickerSearch',
    empty: 'customers.pickerEmpty',
  },
  supplier: {
    placeholder: 'journal.supplierPlaceholder',
    search: 'suppliers.pickerSearch',
    empty: 'suppliers.pickerEmpty',
  },
} as const satisfies Record<PartyRole, Record<string, string>>;

// The party box of a journal line and of the opening balances (step 15a's customer box, step 17a
// for both sides): ui's Combobox with the search on the server. Active parties only, like the API
// takes them on a new line. A receivable line picks a customer, a payable line a supplier
// (partyRoleOf in the contracts).
// `...box`: id, name, onBlur, ref and the aria props go to the Combobox as they came. Spread, not
// one by one: with exactOptionalPropertyTypes, `name={name}` would pass an explicit undefined.
export function PartyPicker({
  role,
  value,
  saved,
  onChange,
  allLabel,
  ...box
}: PartyPickerProps & { role: PartyRole }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  // Both hooks, each enabled for its side only: a hook cannot be called conditionally, and the two
  // queries return different types, so one useQuery over a choice of options would not type-check
  const customers = useQuery({
    ...customerSearchQuery(tenantId, settled),
    enabled: role === 'customer',
  });
  const suppliers = useQuery({
    ...supplierSearchQuery(tenantId, settled),
    enabled: role === 'supplier',
  });
  const found = role === 'customer' ? customers : suppliers;
  const matches: PartyMatch[] | undefined = found.data;
  // The label of what was picked here. A row keeps its own picker (React's key), so a removed row
  // never hands its label to the next one.
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);

  const options = useMemo<ComboboxOption[]>(
    () => [
      // A filter can go back to "every customer"; a form's box cannot be emptied this way
      ...(allLabel === undefined ? [] : [{ value: '', label: allLabel }]),
      ...(matches ?? []).map((party) => ({
        value: party.id,
        label: party.name,
        detail: [party.code, party.phone].filter((part) => part !== null).join(' · '),
      })),
    ],
    [matches, allLabel],
  );

  const selectedLabel =
    value === ''
      ? null
      : picked?.value === value
        ? picked.label
        : saved?.id === value
          ? partyLabel(saved)
          : null;

  return (
    <Combobox
      {...box}
      value={value}
      selectedLabel={selectedLabel}
      options={options}
      search={search}
      onSearchChange={setSearch}
      onChange={(next, option) => {
        const party = matches?.find((item) => item.id === next);
        setPicked({ value: next, label: party ? partyLabel(party) : option.label });
        onChange(next);
      }}
      // Searching for the next word: the old matches stay, marked busy
      loading={found.isFetching}
      icon={UserIcon}
      placeholder={allLabel ?? t(WORDS[role].placeholder)}
      searchPlaceholder={t(WORDS[role].search)}
      emptyText={t(WORDS[role].empty)}
    />
  );
}
```

The customer box of step 15a, made to look for either side (decision 35):

- **`WORDS` holds each side's texts** and is `satisfies Record<PartyRole, …>`: when a third kind of party comes, the
  map does not compile until it has its words.
- **Two `useQuery` calls, each `enabled` for one role.** A hook cannot be called inside an `if`. One `useQuery` over
  "the customer query or the supplier query" does not type-check either: the two option objects have different
  result types. A disabled query sends nothing, so the extra hook costs nothing.
- **`matches: PartyMatch[] | undefined = found.data`** takes the union of the two result types down to the four
  fields the box uses. Both summaries have them, so this needs no cast.
- **The rest is step 15a's code,** with "customer" made into "party": the `picked` label that survives a search, the
  `saved` party of a saved line, and the spread of the box's props.

```diff
@@ -1,88 +1,10 @@
-import { UserIcon } from '@hugeicons/core-free-icons';
-import type { PartyRef } from '@omnivo/contracts';
-import { useLocale } from '@omnivo/i18n';
-import { Combobox, type ComboboxOption } from '@omnivo/ui';
-import { useQuery } from '@tanstack/react-query';
-import { type Ref, useMemo, useState } from 'react';
+import { PartyPicker, type PartyPickerProps } from './party-picker';
 
-import { partyLabel } from '../lib/customers';
-import { customerSearchQuery } from '../lib/queries';
-import { useSession } from '../lib/session-store';
-import { useDebounced } from '../lib/use-debounced';
+export type CustomerPickerProps = PartyPickerProps;
 
-export interface CustomerPickerProps {
-  id: string;
-  name?: string;
-  // The chosen customer's id, or '' for none
-  value: string;
-  // The customer the line was saved with, so the box can name it before any search ran
-  saved: PartyRef | null;
-  onChange: (value: string) => void;
-  onBlur?: () => void;
-  ref?: Ref<HTMLButtonElement>;
-  invalid?: boolean | undefined;
-  disabled?: boolean | undefined;
-  'aria-label'?: string | undefined;
-  'aria-describedby'?: string | undefined;
-  // A list's filter (step 15b): the first option, '' = every customer, and the empty box's text
-  allLabel?: string | undefined;
-}
-
-// The customer box of a journal line and of the opening balances (step 15a): ui's Combobox with
-// the search on the server. Active customers only, like the API takes them on a new line.
-// `...box`: id, name, onBlur, ref and the aria props go to the Combobox as they came. Spread, not
-// one by one: with exactOptionalPropertyTypes, `name={name}` would pass an explicit undefined.
-export function CustomerPicker({ value, saved, onChange, allLabel, ...box }: CustomerPickerProps) {
-  const { t } = useLocale();
-  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
-  const [search, setSearch] = useState('');
-  const settled = useDebounced(search.trim(), 250);
-  const { data, isFetching } = useQuery(customerSearchQuery(tenantId, settled));
-  // The label of what was picked here. A row keeps its own picker (React's key), so a removed row
-  // never hands its label to the next one.
-  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
-
-  const options = useMemo<ComboboxOption[]>(
-    () => [
-      // A filter can go back to "every customer"; a form's box cannot be emptied this way
-      ...(allLabel === undefined ? [] : [{ value: '', label: allLabel }]),
-      ...(data ?? []).map((customer) => ({
-        value: customer.id,
-        label: customer.name,
-        detail: [customer.code, customer.phone].filter((part) => part !== null).join(' · '),
-      })),
-    ],
-    [data, allLabel],
-  );
-
-  const selectedLabel =
-    value === ''
-      ? null
-      : picked?.value === value
-        ? picked.label
-        : saved?.id === value
-          ? partyLabel(saved)
-          : null;
-
-  return (
-    <Combobox
-      {...box}
-      value={value}
-      selectedLabel={selectedLabel}
-      options={options}
-      search={search}
-      onSearchChange={setSearch}
-      onChange={(next, option) => {
-        const customer = data?.find((item) => item.id === next);
-        setPicked({ value: next, label: customer ? partyLabel(customer) : option.label });
-        onChange(next);
-      }}
-      // Searching for the next word: the old matches stay, marked busy
-      loading={isFetching}
-      icon={UserIcon}
-      placeholder={allLabel ?? t('journal.customerPlaceholder')}
-      searchPlaceholder={t('customers.pickerSearch')}
-      emptyText={t('customers.pickerEmpty')}
-    />
-  );
+// The customer box of the sales forms and the sales lists' filter (steps 15a–15d). Step 17a moved
+// the box itself to party-picker.tsx, which serves the suppliers too; this name stays, so none of
+// those screens changes.
+export function CustomerPicker(props: CustomerPickerProps) {
+  return <PartyPicker role="customer" {...props} />;
 }
```

`CustomerPicker` is now a one-line wrapper. The sales forms and the eight sales lists import it by this name, so
none of them changes, and their lazy imports of `./customer-picker` still work.

### The books name suppliers

The payable is kept per supplier now (decision 11), so every screen that showed a customer on a receivable line
shows a supplier on a payable line.

```diff
@@ -13,9 +13,10 @@ import {
   type Account,
   type Branch,
   contractErrorMap,
-  isPartyAccountPurpose,
   type JournalEntry,
   type PartyRef,
+  type PartyRole,
+  partyRoleOf,
   routes,
   updateJournalEntryInputSchema,
 } from '@omnivo/contracts';
@@ -47,10 +48,10 @@ import { balanceSide, formAmount, ledgerOptions, linePath, totalsOf } from '../l
 import { useCan } from '../lib/permissions';
 import { BackLink, failureOf, LineField, useJournalRefresh } from './journal-parts';
 
-// The date picker and the customer box as chunks of their own (step 15c): both bring the popover,
+// The date picker and the party box as chunks of their own (step 15c): both bring the popover,
 // and the 15c contracts took this chunk over its 100 KB budget (the delivery form's fix)
-const CustomerPicker = lazy(async () => ({
-  default: (await import('./customer-picker')).CustomerPicker,
+const PartyPicker = lazy(async () => ({
+  default: (await import('./party-picker')).PartyPicker,
 }));
 const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
 
@@ -113,7 +114,6 @@ export function EntryForm({
     handleSubmit,
     setError,
     setValue,
-    getValues,
     formState: { errors, isSubmitting },
   } = useForm({
     resolver: zodResolver(updateJournalEntryInputSchema, { error: contractErrorMap }),
@@ -152,17 +152,19 @@ export function EntryForm({
     [branches, t],
   );
   const showBranch = branches.length > 0;
-  // The receivable (step 15a): a line on it names its customer. The server checks it too.
+  // The receivable (step 15a) and the payable (step 17a): a line on either names its party, a
+  // customer or a supplier. The server checks it too.
   const partyAccounts = useMemo(
     () =>
-      new Set(
-        accounts
-          .filter((account) => isPartyAccountPurpose(account.purpose))
-          .map((account) => account.id),
+      new Map(
+        accounts.flatMap((account): [string, PartyRole][] => {
+          const role = partyRoleOf(account.purpose);
+          return role === null ? [] : [[account.id, role]];
+        }),
       ),
     [accounts],
   );
-  // The customers the draft was saved with, so each box names its customer before any search
+  // The parties the draft was saved with, so each box names its party before any search
   const savedParties = useMemo(
     () =>
       new Map<string, PartyRef>(
@@ -260,6 +262,8 @@ export function EntryForm({
           {fields.map((line, index) => {
             const number = index + 1;
             const lineErrors = errors.lines?.[index];
+            // Which party the line's account takes: undefined = none
+            const partyRole = partyAccounts.get(lines[index]?.accountId ?? '');
             const removeButton = (
               <IconButton
                 icon={Delete02Icon}
@@ -300,31 +304,36 @@ export function EntryForm({
                         lineErrors?.accountId ? `${linePath(index, 'accountId')}-error` : undefined
                       }
                       {...register(linePath(index, 'accountId'), {
-                        // Another account takes no customer: the server would refuse the line
-                        // (journal_party_not_allowed), and the box is gone, so it could not be
-                        // seen to clear it
+                        // A new account starts without a party. Another account takes none (the
+                        // server would refuse the line, journal_party_not_allowed, and the box is
+                        // gone, so it could not be seen to clear it); and a customer picked on the
+                        // receivable is not a supplier on the payable (journal_party_invalid).
                         onChange: () => {
-                          if (!partyAccounts.has(getValues(linePath(index, 'accountId')))) {
-                            setValue(linePath(index, 'partyId'), '');
-                          }
+                          setValue(linePath(index, 'partyId'), '');
                         },
                       })}
                     />
                   </LineField>
-                  {/* Under the account, not in a column of its own: only receivable lines have
-                      it, and a column empty on most lines would squeeze the others */}
-                  {partyAccounts.has(lines[index]?.accountId ?? '') && (
+                  {/* Under the account, not in a column of its own: only receivable and payable
+                      lines have it, and a column empty on most lines would squeeze the others.
+                      key: a line moved from the receivable to the payable gets a fresh box, without
+                      the customer search it had typed. */}
+                  {partyRole !== undefined && (
                     <Controller
+                      key={partyRole}
                       control={control}
                       name={linePath(index, 'partyId')}
                       render={({ field, fieldState }) => (
                         <LineField
                           id={field.name}
-                          label={t('journal.customer')}
+                          label={t(
+                            partyRole === 'customer' ? 'journal.customer' : 'journal.supplier',
+                          )}
                           error={fieldState.error?.message}
                         >
                           <Suspense fallback={<Input id={field.name} icon={UserIcon} disabled />}>
-                            <CustomerPicker
+                            <PartyPicker
+                              role={partyRole}
                               id={field.name}
                               name={field.name}
                               ref={field.ref}
```

- **`partyAccounts` became a `Map` from account to role,** built with `partyRoleOf`. The form needs two answers per
  line: does this account take a party, and which kind. A `Set` only answered the first.
- **A changed account always clears the party.** Before, it was cleared only when the new account took no party.
  Now a line can move from the receivable to the payable, and a customer picked there is not a supplier; the server
  would answer `journal_party_invalid`. Clearing on every change is simpler than remembering the old account, and
  the person picks the account before the party anyway.
- **`key={partyRole}` on the `Controller`.** A line moved from the receivable to the payable gets a new box, without
  the customer search text it had. Without the key, React keeps the same picker and only its props change.
- **The label comes from the role** (`journal.customer` or `journal.supplier`), and `getValues` is gone: it was only
  used by the old account check.

```diff
@@ -6,10 +6,10 @@ import {
   type Branch,
   contractErrorMap,
   isJournalSource,
-  isPartyAccountPurpose,
   isSalesJournalSource,
   isStockJournalSource,
   type JournalEntry,
+  partyRoleOf,
   reverseJournalEntryInputSchema,
   routes,
 } from '@omnivo/contracts';
@@ -44,6 +44,9 @@ import {
   useJournalRefresh,
 } from './journal-parts';
 
+// The look of a line's customer or supplier under its account
+const PARTY_LINK = 'block w-fit text-caption text-brand underline-offset-3 hover:underline';
+
 // A posted entry, read only, with Reverse — or a draft for someone who may post but not edit.
 // A chunk of its own, like the form (routes/journal-entry.tsx).
 
@@ -294,6 +297,8 @@ export function EntryView({
             {entry.lines.map((line) => {
               const account = accountOf.get(line.accountId);
               const branch = line.branchId === null ? undefined : branchOf.get(line.branchId);
+              // A receivable line names a customer, a payable line (step 17a) a supplier
+              const partyRole = partyRoleOf(account?.purpose ?? null);
               return (
                 <tr key={line.id} className="border-t border-line">
                   <td className="px-5 py-3">
@@ -309,21 +314,30 @@ export function EntryView({
                     ) : (
                       '—'
                     )}
-                    {/* The receivable's customer (step 15a), linked to their page. A line posted
-                        before customers were kept says so. */}
-                    {line.party ? (
+                    {/* The receivable's customer (step 15a) or the payable's supplier (step 17a),
+                        linked to their page. A line posted before they were kept says so. */}
+                    {line.party && partyRole === 'supplier' ? (
+                      <Link
+                        to="/suppliers/$supplierId"
+                        params={{ supplierId: line.party.id }}
+                        className={PARTY_LINK}
+                      >
+                        {partyLabel(line.party)}
+                      </Link>
+                    ) : line.party ? (
                       <Link
                         to="/customers/$customerId"
                         params={{ customerId: line.party.id }}
-                        className="block w-fit text-caption text-brand underline-offset-3 hover:underline"
+                        className={PARTY_LINK}
                       >
                         {partyLabel(line.party)}
                       </Link>
                     ) : (
-                      account &&
-                      isPartyAccountPurpose(account.purpose) && (
+                      partyRole !== null && (
                         <span className="block text-caption text-ink-3">
-                          {t('journal.noCustomer')}
+                          {t(
+                            partyRole === 'customer' ? 'journal.noCustomer' : 'journal.noSupplier',
+                          )}
                         </span>
                       )
                     )}
```

A posted line names its party under the account. A supplier links to `/suppliers/…`, a customer to `/customers/…`;
the role comes from the account, because the line itself does not say which side its party is on (a party that is
both has one id). `PARTY_LINK` keeps the two links' classes in one place. A payable line posted before this step has
no supplier and says so (`journal.noSupplier`).

```diff
@@ -1,10 +1,5 @@
 import { Book02Icon, Notebook02Icon } from '@hugeicons/core-free-icons';
-import {
-  DEFAULT_SETTINGS,
-  isPartyAccountPurpose,
-  type LedgerLine,
-  todayIn,
-} from '@omnivo/contracts';
+import { DEFAULT_SETTINGS, type LedgerLine, partyRoleOf, todayIn } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
   Card,
@@ -53,15 +48,17 @@ export function LedgerPage() {
     to: today,
   };
   const account = accounts?.find((item) => item.id === accountId);
-  // The receivable's ledger (step 15a) shows whose each line is
-  const byParty = account !== undefined && isPartyAccountPurpose(account.purpose);
+  // The receivable's ledger (step 15a) and the payable's (step 17a) show whose each line is
+  const partyRole = partyRoleOf(account?.purpose ?? null);
+  const byParty = partyRole !== null;
 
   const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
     ...ledgerQuery(tenantId, accountId, from, to),
     enabled: canRead && account !== undefined,
   });
   const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
-  // A line posted before customers were kept has none: say once, above the table, how to fix it
+  // A line posted before customers (or suppliers) were kept has none: say once, above the table,
+  // how to fix it
   const unassigned = byParty && lines?.some((line) => line.party === null) === true;
   const first = data?.pages[0];
 
@@ -104,7 +101,9 @@ export function LedgerPage() {
               <span className="truncate">{getValue() || '—'}</span>
               {byParty && (
                 <span className="truncate text-caption text-ink-3">
-                  {party ? `${party.code} · ${party.name}` : t('ledger.noCustomer')}
+                  {party
+                    ? `${party.code} · ${party.name}`
+                    : t(partyRole === 'supplier' ? 'ledger.noSupplier' : 'ledger.noCustomer')}
                 </span>
               )}
             </span>
@@ -130,7 +129,7 @@ export function LedgerPage() {
         cell: ({ getValue }) => <span className="font-medium">{balanceText(getValue())}</span>,
       }),
     ]);
-  }, [t, format, showDate, balanceText, byParty]);
+  }, [t, format, showDate, balanceText, byParty, partyRole]);
 
   if (!canRead) {
     return (
@@ -199,7 +198,11 @@ export function LedgerPage() {
             ))}
           </Card>
           {isError && <p className="text-body-sm text-crit">{t('ledger.loadFailed')}</p>}
-          {unassigned && <p className="text-body-sm text-ink-2">{t('ledger.noCustomerHint')}</p>}
+          {unassigned && (
+            <p className="text-body-sm text-ink-2">
+              {t(partyRole === 'supplier' ? 'ledger.noSupplierHint' : 'ledger.noCustomerHint')}
+            </p>
+          )}
           {lines && (
             <DataTable
               label={t('ledger.title')}
```

The ledger of the payable shows each line's supplier, and the hint above the table speaks of suppliers. `partyRole`
joins the column definitions' dependency list, so moving from the receivable's ledger to the payable's redraws the
words.

```diff
@@ -5,10 +5,11 @@ import {
   type Account,
   ACCOUNT_TYPES,
   contractErrorMap,
-  isPartyAccountPurpose,
   type OpeningBalances,
   openingBalancesInputSchema,
   type PartyRef,
+  type PartyRole,
+  partyRoleOf,
   routes,
   shiftIsoDate,
 } from '@omnivo/contracts';
@@ -39,10 +40,10 @@ import { useCan } from '../lib/permissions';
 import { accountsQuery, openingBalancesQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
-// The customer box and the date picker as chunks of their own (step 15d): both bring the popover,
+// The party box and the date picker as chunks of their own (step 15d): both bring the popover,
 // and the 15d contracts took this page over its 100 KB budget (the journal form's fix in 15c)
-const CustomerPicker = lazy(async () => ({
-  default: (await import('../components/customer-picker')).CustomerPicker,
+const PartyPicker = lazy(async () => ({
+  default: (await import('../components/party-picker')).PartyPicker,
 }));
 const DatePicker = lazy(async () => ({
   default: (await import('../components/date-input')).DatePicker,
@@ -70,12 +71,30 @@ function emptyLine(accountId: string): LineValues {
   return { accountId, partyId: '', debit: '', credit: '' };
 }
 
-// The form's lines: one per account, and on the receivable one per customer (step 15a). A
-// receivable with nothing saved starts with one empty customer row, ready to fill.
+// The words of a party account's rows: the receivable's customers (step 15a), the payable's
+// suppliers (step 17a)
+const PARTY_WORDS = {
+  customer: {
+    party: 'opening.customer',
+    hint: 'opening.receivableHint',
+    unassigned: 'opening.noCustomerHint',
+    add: 'opening.addCustomer',
+  },
+  supplier: {
+    party: 'opening.supplier',
+    hint: 'opening.payableHint',
+    unassigned: 'opening.noSupplierHint',
+    add: 'opening.addSupplier',
+  },
+} as const satisfies Record<PartyRole, Record<string, string>>;
+
+// The form's lines: one per account, and on the receivable one per customer (step 15a), on the
+// payable one per supplier (step 17a). A party account with nothing saved starts with one empty
+// row, ready to fill.
 function linesOf(
   saved: OpeningBalances,
   rows: readonly Account[],
-  partyAccounts: ReadonlySet<string>,
+  partyAccounts: ReadonlyMap<string, PartyRole>,
 ): LineValues[] {
   return rows.flatMap((account) => {
     const own = saved.lines.filter((line) => line.accountId === account.id);
@@ -91,8 +110,8 @@ function linesOf(
       ];
     }
     if (own.length === 0) return [emptyLine(account.id)];
-    // A line saved before step 15a has no customer: it stays, with its amount, until the person
-    // picks one or splits it
+    // A line saved before step 15a (step 17a for the payable) has no party: it stays, with its
+    // amount, until the person picks one or splits it
     return own.map((line) => ({
       accountId: account.id,
       partyId: line.party?.id ?? '',
@@ -117,14 +136,18 @@ function OpeningForm({
   const queryClient = useQueryClient();
   const showDate = useIsoDate();
   const canPost = useCan()('accounting.journal.post');
+  // Which party each party account takes, by account id
   const partyAccounts = useMemo(
     () =>
-      new Set(
-        rows.filter((account) => isPartyAccountPurpose(account.purpose)).map((item) => item.id),
+      new Map(
+        rows.flatMap((account): [string, PartyRole][] => {
+          const role = partyRoleOf(account.purpose);
+          return role === null ? [] : [[account.id, role]];
+        }),
       ),
     [rows],
   );
-  // The customers saved before, so each box names its customer before any search ran
+  // The parties saved before, so each box names its party before any search ran
   const savedParties = useMemo(
     () =>
       new Map<string, PartyRef>(
@@ -152,8 +175,8 @@ function OpeningForm({
   const totals = totalsOf(lines);
   // Opening balance equity takes the other side of the difference, so the entry balances
   const gap = balanceSide(totals.difference);
-  // Where each account's lines are in the form. "Add a customer" appends at the end, so a
-  // receivable's rows are not next to each other in the array; the page shows them together.
+  // Where each account's lines are in the form. "Add a customer" appends at the end, so a party
+  // account's rows are not next to each other in the array; the page shows them together.
   const indexesOf = useMemo(() => {
     const map = new Map<string, number[]>();
     lines.forEach((line, index) => {
@@ -167,8 +190,9 @@ function OpeningForm({
       const result = await call(routes.openingBalances.save, { body: values });
       queryClient.setQueryData(openingBalancesQuery(tenantId).queryKey, result);
       await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
-      // The customers' balances come from these lines too
+      // The customers' and the suppliers' balances come from these lines too
       await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
+      await queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] });
       toast(
         result.entry ? t('opening.saved', { number: result.entry.number }) : t('opening.cleared'),
       );
@@ -214,20 +238,22 @@ function OpeningForm({
     </span>
   );
 
-  // The receivable: a row per customer, each with its picker, and "Add a customer"
-  const partyRows = (account: Account) => {
+  // The receivable and the payable: a row per party, each with its picker, and "Add a customer"
+  // (or "Add a supplier")
+  const partyRows = (account: Account, role: PartyRole) => {
     const indexes = indexesOf.get(account.id) ?? [];
+    const words = PARTY_WORDS[role];
     return (
       <div key={account.id} role="group" aria-label={`${account.code} ${account.name}`}>
         <div className="grid gap-0.5 px-5 pt-2">
           {accountName(account)}
-          <span className="text-caption text-ink-3">{t('opening.receivableHint')}</span>
+          <span className="text-caption text-ink-3">{t(words.hint)}</span>
         </div>
         {indexes.map((index, position) => {
           const number = position + 1;
           const label = t('opening.customerLine', { account: account.code, number });
           const start = fields[index];
-          // Saved with an amount and no customer: from before customers were kept
+          // Saved with an amount and no party: from before customers (or suppliers) were kept
           const unassigned =
             start !== undefined &&
             (start.partyId ?? '') === '' &&
@@ -249,11 +275,12 @@ function OpeningForm({
                       render={({ field, fieldState }) => (
                         <LineField
                           id={field.name}
-                          label={t('opening.customer')}
+                          label={t(words.party)}
                           error={fieldState.error?.message}
                         >
                           <Suspense fallback={<Input id={field.name} icon={UserIcon} disabled />}>
-                            <CustomerPicker
+                            <PartyPicker
+                              role={role}
                               id={field.name}
                               name={field.name}
                               ref={field.ref}
@@ -263,7 +290,7 @@ function OpeningForm({
                               onBlur={field.onBlur}
                               disabled={!canPost}
                               invalid={fieldState.error !== undefined}
-                              aria-label={`${t('opening.customer')}, ${label}`}
+                              aria-label={`${t(words.party)}, ${label}`}
                               aria-describedby={
                                 fieldState.error ? `${field.name}-error` : undefined
                               }
@@ -286,7 +313,7 @@ function OpeningForm({
                   )}
                 </div>
                 {unassigned && (
-                  <span className="text-caption text-ink-3">{t('opening.noCustomerHint')}</span>
+                  <span className="text-caption text-ink-3">{t(words.unassigned)}</span>
                 )}
               </div>
               {amounts(index, label)}
@@ -303,7 +330,7 @@ function OpeningForm({
               }}
             >
               <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
-              {t('opening.addCustomer')}
+              {t(words.add)}
             </Button>
           </div>
         )}
@@ -363,7 +390,8 @@ function OpeningForm({
               </h2>
               {rows.map((account) => {
                 if (account.type !== type) return null;
-                if (partyAccounts.has(account.id)) return partyRows(account);
+                const role = partyAccounts.get(account.id);
+                if (role !== undefined) return partyRows(account, role);
                 const index = indexesOf.get(account.id)?.[0];
                 if (index === undefined) return null;
                 return (
@@ -452,7 +480,7 @@ export function OpeningBalancesPage() {
     const extra = new Set<Account>();
     for (const line of saved.lines) {
       const account = accounts.find((item) => item.id === line.accountId);
-      // A Set: the receivable has a line per customer (step 15a), but one row block
+      // A Set: a party account has a line per party (steps 15a, 17a), but one row block
       if (account && !list.includes(account)) extra.add(account);
     }
     return [...list, ...extra];
```

- **`PARTY_WORDS` holds each side's four texts** (the box's label, the hint under the account, the hint on an old
  line without a party, the "Add" button). `partyRows` takes the role and reads its words from there, so the
  receivable's block and the payable's block are drawn by the same code.
- **The save refreshes `['suppliers', tenant]` too:** the suppliers' balances come from these lines.

```diff
@@ -140,8 +140,9 @@ export function useJournalRefresh() {
   return async (saved?: JournalEntry) => {
     if (saved) queryClient.setQueryData(journalEntryQuery(tenantId, saved.id).queryKey, saved);
     await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
-    // A line on the receivable changes what a customer owes (step 15a): the customer list and
-    // pages show the balance
+    // A line on the receivable changes what a customer owes (step 15a), and one on the payable
+    // what the company owes a supplier (step 17a): their lists and pages show the balance
     await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
+    await queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] });
   };
 }
```

`useJournalRefresh` refreshes the suppliers after every journal save, for the same reason: a payable line changes
what the company owes a supplier.

### Suppliers

```ts
import { absMoney, isNegativeMoney, isZeroMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { useMemo } from 'react';

// How a supplier's terms and balance read: the list and the supplier's page say them the same way
// (lib/customers.ts is the customer's twin).
export function useSupplierText() {
  const { t, format } = useLocale();
  return useMemo(
    () => ({
      // 0 days = due on receipt
      terms: (days: number) =>
        days === 0 ? t('suppliers.onReceipt') : t('suppliers.termsDays', { count: days }),
      // The API sends debit minus credit, like every balance. On the payable a credit balance is
      // what the company owes, so a negative number reads "You owe"; a debit balance is money
      // paid ahead (an advance to a mill before it ships the yarn).
      balance: (balance: string) =>
        isZeroMoney(balance)
          ? t('suppliers.settled')
          : isNegativeMoney(balance)
            ? t('suppliers.owe', { amount: format.money(absMoney(balance)) })
            : t('suppliers.inAdvance', { amount: format.money(balance) }),
    }),
    [t, format],
  );
}
```

The supplier's twin of `useCustomerText`. The balance turns around: the API sends debit minus credit, like every
balance, and on the payable a credit balance is what the company owes. So a negative balance reads "You owe
৳1,15,000", and a positive one "paid in advance" (a mill paid before it ships). Without this, a supplier the company
owes money would read as if it owed the company.

```tsx
import { AlertCircleIcon, ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';

import { useSession } from '../lib/session-store';

// Shared by the supplier's page, its form pages and the groups page (customer-parts.tsx is the
// customer's twin). Here, not in a route file: a route file is its own lazy chunk, and importing
// from one would pull that whole page into the others.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// After a supplier is saved: everything about suppliers, and the customers too. A party that is
// both is one row (decision 9): its name and phone changed on the supplier page are the customer's
// name and phone, and its archive hides both sides.
export function usePartyRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['customers', tenantId] }),
    ]);
  }, [queryClient, tenantId]);
}

export function SupplierBackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/suppliers"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('suppliers.back')}
    </Link>
  );
}

export function SupplierNotFound() {
  const { t } = useLocale();
  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <SupplierBackLink />
      <EmptyState
        icon={AlertCircleIcon}
        title={t('suppliers.title')}
        description={t('suppliers.notFound')}
      />
    </div>
  );
}
```

- **`usePartyRefresh` refreshes both prefixes** (decision 38). A supplier saved with a new phone number is a
  customer with that phone number too, and an archived supplier is an archived customer.
- **`SupplierBackLink` and `SupplierNotFound`** are here, not in a route file, for the same reason as the customer's
  parts: a route file is a chunk of its own.

```tsx
import { Factory01Icon, PlusSignIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  SUPPLIER_STATUSES,
  type SupplierSort,
  type SupplierStatus,
  type SupplierSummary,
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
import { useCallback, useMemo, useState } from 'react';

import { useTenantId } from '../components/supplier-parts';
import { initialsOf } from '../lib/customers';
import { useCan } from '../lib/permissions';
import { supplierGroupsQuery, supplierListQuery } from '../lib/queries';
import { useSupplierText } from '../lib/suppliers';
import { useDebounced } from '../lib/use-debounced';

// Step 17a: the supplier's twin of the customer list (routes/customers.tsx). No credit limit
// column: a supplier gives the company credit, the company does not give it any.

const column = dataTableColumns<SupplierSummary>();

// The supplier column sorts by name; the server keeps a stable order (name, then id)
function sortOf(state: SortingState): SupplierSort {
  const [first] = state;
  return first?.id === 'name' && first.desc ? '-name' : 'name';
}

export function SuppliersPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const can = useCan();
  const canManage = can('purchase.supplier.manage');
  // The column is left out without the permission, instead of a column of dashes
  const canSeeBalance = can('purchase.supplier.balance');
  const text = useSupplierText();
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState<SupplierStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const settled = useDebounced(search.trim());
  const filter = { search: settled, groupId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    supplierListQuery(tenantId, filter),
  );
  const groups = useQuery(supplierGroupsQuery(tenantId)).data;
  const suppliers = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const groupName = useMemo(
    () => new Map(groups?.map((group) => [group.id, group.name])),
    [groups],
  );

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('suppliers.columns.supplier'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand"
              >
                {initialsOf(row.original.name)}
              </span>
              <span className="grid min-w-0 max-w-[20rem]">
                <span className="truncate font-medium">{row.original.name}</span>
                <span className="truncate font-mono text-caption text-ink-3 tabular-nums">
                  {row.original.code}
                </span>
              </span>
            </span>
          ),
        }),
        column.accessor('phone', {
          header: t('suppliers.columns.phone'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0">
              <span className="tabular-nums">{row.original.phone ?? '—'}</span>
              {row.original.contactPerson && (
                <span className="truncate text-caption text-ink-3">
                  {row.original.contactPerson}
                </span>
              )}
            </span>
          ),
        }),
        column.accessor('groupId', {
          header: t('suppliers.columns.group'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const id = getValue();
            return id === null ? '—' : (groupName.get(id) ?? '—');
          },
        }),
        column.accessor('paymentTermsDays', {
          header: t('suppliers.columns.terms'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => text.terms(getValue()),
        }),
        ...(canSeeBalance
          ? [
              column.accessor((supplier) => supplier.balance ?? '0', {
                id: 'balance',
                header: t('suppliers.columns.balance'),
                enableSorting: false,
                meta: { align: 'end', card: 'trailing' },
                cell: ({ getValue }) => (
                  <span className="font-medium">{text.balance(getValue())}</span>
                ),
              }),
            ]
          : []),
      ]),
    [t, text, groupName, canSeeBalance],
  );

  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('suppliers.noMatchTitle', { query: settled })}
        description={t('suppliers.noMatchBody')}
      />
    ) : status === 'archived' ? (
      <EmptyState
        icon={Factory01Icon}
        title={t('suppliers.archivedEmptyTitle')}
        description={t('suppliers.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={Factory01Icon}
        title={t('suppliers.emptyTitle')}
        description={t('suppliers.emptyBody')}
        action={
          canManage &&
          groupId === '' && (
            <Button onClick={() => void navigate({ to: '/suppliers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('suppliers.add')}
            </Button>
          )
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('suppliers.title')}
        description={t('suppliers.description')}
        actions={
          canManage && (
            <Button onClick={() => void navigate({ to: '/suppliers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('suppliers.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('suppliers.searchLabel')}
            placeholder={t('suppliers.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('suppliers.group')}
            options={[
              { value: '', label: t('suppliers.allGroups') },
              ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
            ]}
            value={groupId}
            onChange={(event) => {
              setGroupId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('suppliers.show')}
          value={status}
          options={SUPPLIER_STATUSES.map((value) => ({
            value,
            label: t(`suppliers.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('suppliers.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('suppliers.loadFailed')}</p>}
      {suppliers && (
        <DataTable
          label={t('suppliers.title')}
          data={suppliers}
          columns={columns}
          getRowId={(supplier) => supplier.id}
          sorting={{ state: sorting, onChange: setSorting }}
          onRowClick={(supplier) =>
            void navigate({ to: '/suppliers/$supplierId', params: { supplierId: supplier.id } })
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

The customer list with the supplier's words. The differences: no credit limit column (a supplier gives the company
credit, not the other way round), the balance comes from `useSupplierText`, and the balance column exists only with
`purchase.supplier.balance`.

```tsx
import {
  BankIcon,
  Call02Icon,
  Delete02Icon,
  Factory01Icon,
  Mail01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  MAX_PAYMENT_TERMS_DAYS,
  MAX_SUPPLIER_BANK_ACCOUNTS,
  routes,
  type Supplier,
  type SupplierGroup,
  updateSupplierInputSchema,
} from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  FormAlert,
  IconButton,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { type Path, useFieldArray, useForm } from 'react-hook-form';
import type { z } from 'zod';

import { applyApiError } from '../lib/field-errors';
import { call } from '../lib/api';
import { rowPath } from '../lib/products';
import { supplierQuery } from '../lib/queries';
import { usePartyRefresh, useTenantId } from './supplier-parts';

// The supplier form: a chunk of its own (loaded by routes/supplier-edit.tsx), like the customer
// form. The schema is the contract's own, so the form refuses what the API refuses, in the same
// words.

type FormValues = z.input<typeof updateSupplierInputSchema>;
type BankAccountValues = FormValues['bankAccounts'][number];

// A supplier as the form holds it: '' for every empty box. A new supplier is paid on receipt
// until someone sets the terms.
function valuesOf(supplier: Supplier | null): FormValues {
  return {
    code: supplier?.code ?? '',
    name: supplier?.name ?? '',
    groupId: supplier?.groupId ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    documentLanguage: supplier?.documentLanguage ?? 'en',
    bin: supplier?.bin ?? '',
    paymentTermsDays: supplier?.paymentTermsDays ?? 0,
    address: supplier?.address ?? '',
    // The id goes back with each account, so the server changes that row instead of making a new
    // one: 17c's payments will point at the account they were sent to
    bankAccounts:
      supplier?.bankAccounts.map((account) => ({
        id: account.id,
        bankName: account.bankName,
        branchName: account.branchName ?? '',
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        routingNumber: account.routingNumber ?? '',
      })) ?? [],
    notes: supplier?.notes ?? '',
    // A new supplier has no version; 1 passes the schema, and the create route never reads it
    version: supplier?.version ?? 1,
  };
}

// A new account's boxes, all empty. id null: the server makes the row.
const newBankAccount = (): BankAccountValues => ({
  id: null,
  bankName: '',
  branchName: '',
  accountName: '',
  accountNumber: '',
  routingNumber: '',
});

// Every field the server may name in an error, so it lands under the right box
function fieldNames(accountCount: number): Path<FormValues>[] {
  return [
    'code',
    'name',
    'groupId',
    'contactPerson',
    'phone',
    'email',
    'documentLanguage',
    'bin',
    'paymentTermsDays',
    'address',
    'notes',
    'bankAccounts',
    ...Array.from({ length: accountCount }, (_, index) => [
      rowPath('bankAccounts', index, 'bankName'),
      rowPath('bankAccounts', index, 'branchName'),
      rowPath('bankAccounts', index, 'accountName'),
      rowPath('bankAccounts', index, 'accountNumber'),
      rowPath('bankAccounts', index, 'routingNumber'),
    ]).flat(),
  ];
}

function SectionCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className={cn('grid grid-cols-1 gap-5 p-5', className)}>{children}</div>
    </Card>
  );
}
```

- **`FormValues` is `z.input` of the contract's update schema.** The form sends exactly what the API checks, and the
  error codes land under the same boxes.
- **Each bank account keeps its `id`** in the form. The server changes that row instead of making a new one, so
  17c's payments, which will point at the account they were sent to, keep pointing at it after an edit. A new
  account has `id: null`.
- **`fieldNames` lists every box the server may name**, account rows included ("bankAccounts.1.routingNumber"), so a
  `routing_number_format` from the server shows under the right row.

```tsx

export function SupplierForm({
  supplier,
  groups,
  canManage,
}: {
  supplier: Supplier | null;
  groups: SupplierGroup[];
  canManage: boolean;
}) {
  const { t, errorText } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const refresh = usePartyRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSupplierInputSchema, { error: contractErrorMap }),
    defaultValues: valuesOf(supplier),
  });
  const accountArray = useFieldArray({ control, name: 'bankAccounts' });

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = supplier
        ? await call(routes.suppliers.update, {
            params: { id: supplier.id },
            body: { ...values, version },
          })
        : await call(routes.suppliers.create, { body: values });
      queryClient.setQueryData(supplierQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(t(supplier ? 'suppliers.updated' : 'suppliers.created', { name: saved.name }));
      // To the supplier's page; replace: Back from there goes to the list, not to the form
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(getValues('bankAccounts').length), setError);
    }
  });

  const accountsError = errors.bankAccounts?.root?.message ?? errors.bankAccounts?.message;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      {supplier ? (
        <Link
          to="/suppliers/$supplierId"
          params={{ supplierId: supplier.id }}
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {supplier.name}
        </Link>
      ) : (
        <Link
          to="/suppliers"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('suppliers.back')}
        </Link>
      )}
      <PageHeader
        title={
          supplier ? t('suppliers.editTitle', { code: supplier.code }) : t('suppliers.newTitle')
        }
        description={supplier?.name}
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('suppliers.readOnly')}</p>}
      <form noValidate onSubmit={(event) => void onSubmit(event)}>
        {/* Without the permission the same page reads, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}

          <SectionCard title={t('suppliers.sections.basics')}>
            <TextField
              label={t('suppliers.fields.name')}
              icon={Factory01Icon}
              placeholder={t('suppliers.fields.namePlaceholder')}
              {...register('name')}
              error={errors.name?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('suppliers.fields.code')}
                hint={supplier ? undefined : t('suppliers.fields.codeHint')}
                optional={!supplier}
                autoCapitalize="characters"
                spellCheck={false}
                {...register('code')}
                error={errors.code?.message}
              />
              <SelectField
                label={t('suppliers.fields.group')}
                options={[
                  { value: '', label: t('suppliers.fields.noGroup') },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                ]}
                {...register('groupId')}
                error={errors.groupId?.message}
              />
              <TextField
                label={t('suppliers.fields.contactPerson')}
                optional
                placeholder={t('suppliers.fields.contactPersonPlaceholder')}
                {...register('contactPerson')}
                error={errors.contactPerson?.message}
              />
              <TextField
                label={t('suppliers.fields.phone')}
                optional
                type="tel"
                icon={Call02Icon}
                placeholder="01819-456789"
                {...register('phone')}
                error={errors.phone?.message}
              />
              <TextField
                label={t('suppliers.fields.email')}
                optional
                type="email"
                icon={Mail01Icon}
                placeholder="sales@meghnaspinning.com.bd"
                {...register('email')}
                error={errors.email?.message}
              />
              <TextField
                label={t('suppliers.fields.bin')}
                optional
                inputMode="numeric"
                hint={t('suppliers.fields.binHint')}
                placeholder="000456789-0202"
                {...register('bin')}
                error={errors.bin?.message}
              />
              <SelectField
                label={t('suppliers.fields.documentLanguage')}
                hint={t('suppliers.fields.documentLanguageHint')}
                options={LANGUAGES.map((language) => ({
                  value: language.code,
                  label: language.label,
                }))}
                {...register('documentLanguage')}
                error={errors.documentLanguage?.message}
              />
            </div>
            {/* One address, the party's billing address (decision 31): the hint says that a
                customer who is also this supplier shares it */}
            <TextAreaField
              label={t('suppliers.fields.address')}
              optional
              hint={t('suppliers.fields.addressHint')}
              placeholder={t('suppliers.fields.addressPlaceholder')}
              {...register('address')}
              error={errors.address?.message}
            />
            <TextAreaField
              label={t('suppliers.fields.notes')}
              optional
              placeholder={t('suppliers.fields.notesPlaceholder')}
              {...register('notes')}
              error={errors.notes?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('suppliers.sections.terms')}
            subtitle={t('suppliers.sections.termsHint')}
            className="sm:grid-cols-2 sm:gap-x-4"
          >
            <TextField
              label={t('suppliers.fields.paymentTerms')}
              hint={t('suppliers.fields.paymentTermsHint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_PAYMENT_TERMS_DAYS}
              suffix={t('suppliers.fields.days')}
              // valueAsNumber: the contract takes a number of days, not the box's text
              {...register('paymentTermsDays', { valueAsNumber: true })}
              error={errors.paymentTermsDays?.message}
            />
          </SectionCard>
```

- **The address is one text box,** the party's billing address (decision 31), and its hint says so: someone who
  changes it here changes it on the customer page too.
- **The terms card has one box,** the supplier's own payment terms (decision 23). `valueAsNumber`: the contract
  takes a number of days, not the box's text.

```tsx

          <SectionCard
            title={t('suppliers.sections.bankAccounts')}
            subtitle={t('suppliers.sections.bankAccountsHint', {
              max: MAX_SUPPLIER_BANK_ACCOUNTS,
            })}
          >
            {accountArray.fields.length === 0 && (
              <p className="text-body-sm text-ink-3">{t('suppliers.bankAccounts.empty')}</p>
            )}
            {accountArray.fields.length > 0 && (
              <ul aria-label={t('suppliers.sections.bankAccounts')} className="grid gap-3">
                {accountArray.fields.map((row, index) => {
                  const number = index + 1;
                  const rowErrors = errors.bankAccounts?.[index];
                  return (
                    <li
                      key={row.id}
                      role="group"
                      aria-label={t('suppliers.bankAccounts.number', { number })}
                      className="grid grid-cols-1 gap-4 rounded-control border border-line p-4 sm:grid-cols-2 sm:gap-x-4"
                    >
                      <div className="flex items-center justify-between gap-3 sm:col-span-2">
                        <span className="text-label font-medium text-ink-2">
                          {t('suppliers.bankAccounts.number', { number })}
                        </span>
                        <IconButton
                          icon={Delete02Icon}
                          label={t('suppliers.bankAccounts.remove', { number })}
                          onClick={() => {
                            accountArray.remove(index);
                          }}
                        />
                      </div>
                      <TextField
                        id={rowPath('bankAccounts', index, 'bankName')}
                        label={t('suppliers.bankAccounts.bankName')}
                        icon={BankIcon}
                        placeholder={t('suppliers.bankAccounts.bankNamePlaceholder')}
                        {...register(rowPath('bankAccounts', index, 'bankName'))}
                        error={rowErrors?.bankName?.message}
                      />
                      <TextField
                        id={rowPath('bankAccounts', index, 'branchName')}
                        label={t('suppliers.bankAccounts.branchName')}
                        optional
                        placeholder={t('suppliers.bankAccounts.branchNamePlaceholder')}
                        {...register(rowPath('bankAccounts', index, 'branchName'))}
                        error={rowErrors?.branchName?.message}
                      />
                      <div className="sm:col-span-2">
                        <TextField
                          id={rowPath('bankAccounts', index, 'accountName')}
                          label={t('suppliers.bankAccounts.accountName')}
                          placeholder={t('suppliers.bankAccounts.accountNamePlaceholder')}
                          {...register(rowPath('bankAccounts', index, 'accountName'))}
                          error={rowErrors?.accountName?.message}
                        />
                      </div>
                      {/* inputMode: the phone's number pad. Spaces and dashes typed from a cheque
                          leaf are taken out by the contract, so they are allowed here. */}
                      <TextField
                        id={rowPath('bankAccounts', index, 'accountNumber')}
                        label={t('suppliers.bankAccounts.accountNumber')}
                        hint={t('suppliers.bankAccounts.accountNumberHint')}
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="1051100012345"
                        {...register(rowPath('bankAccounts', index, 'accountNumber'))}
                        error={rowErrors?.accountNumber?.message}
                      />
                      <TextField
                        id={rowPath('bankAccounts', index, 'routingNumber')}
                        label={t('suppliers.bankAccounts.routingNumber')}
                        hint={t('suppliers.bankAccounts.routingNumberHint')}
                        optional
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="090264857"
                        {...register(rowPath('bankAccounts', index, 'routingNumber'))}
                        error={rowErrors?.routingNumber?.message}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {accountsError && <p className="text-label text-crit">{errorText(accountsError)}</p>}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={accountArray.fields.length >= MAX_SUPPLIER_BANK_ACCOUNTS}
                onClick={() => {
                  accountArray.append(newBankAccount());
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('suppliers.bankAccounts.add')}
              </Button>
            </div>
          </SectionCard>

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void (supplier
                    ? navigate({
                        to: '/suppliers/$supplierId',
                        params: { supplierId: supplier.id },
                      })
                    : navigate({ to: '/suppliers' }))
                }
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('common.saving')
                  : supplier
                    ? t('suppliers.save')
                    : t('suppliers.create')}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}
```

- **"Add a bank account" is disabled at `MAX_SUPPLIER_BANK_ACCOUNTS`.** The contract and the API refuse a sixth;
  the disabled button says it before the person types it all.
- **The account and routing number boxes use `inputMode="numeric"`:** a phone shows its number pad. Spaces and
  dashes copied from a cheque leaf are allowed, because the contract takes them out.

```tsx
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SupplierNotFound, useTenantId } from '../components/supplier-parts';
import { useCan } from '../lib/permissions';
import { supplierGroupsQuery, supplierQuery } from '../lib/queries';

// The new and edit pages, apart from the supplier's page (routes/supplier.tsx): that page's
// statement brings the data table and the date pickers, which the form never uses (the customer
// pages are split the same way, for the same reason).

// The page loads the data; the form is a lazy chunk of its own
const SupplierForm = lazy(async () => ({
  default: (await import('../components/supplier-form')).SupplierForm,
}));

export function NewSupplierPage() {
  const canManage = useCan()('purchase.supplier.manage');
  const groups = useQuery(supplierGroupsQuery(useTenantId())).data;
  if (!groups) return null;
  return (
    <Suspense fallback={null}>
      <SupplierForm supplier={null} groups={groups} canManage={canManage} />
    </Suspense>
  );
}

export function EditSupplierPage() {
  const { supplierId = '' } = useParams({ strict: false });
  const tenantId = useTenantId();
  const canManage = useCan()('purchase.supplier.manage');
  const groups = useQuery(supplierGroupsQuery(tenantId)).data;
  const { data: supplier, isError } = useQuery({
    ...supplierQuery(tenantId, supplierId),
    enabled: supplierId !== '',
  });
  if (isError) return <SupplierNotFound />;
  if (!supplier || !groups) return null;
  return (
    <Suspense fallback={null}>
      {/* key: a supplier saved elsewhere comes back with a new version; start from it again */}
      <SupplierForm
        key={`${supplier.id}-${String(supplier.version)}`}
        supplier={supplier}
        groups={groups}
        canManage={canManage}
      />
    </Suspense>
  );
}
```

The new and edit pages, apart from the supplier's page, for the same reason as the customer's: the page's
statement brings the data table and the date pickers, which the form never needs. `key` with the version: a supplier
saved elsewhere comes back with a new version, and the form starts again from it.

```tsx
import { Notebook02Icon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, type LedgerLine, type PartyRole, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  SectionHeader,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { fiscalYearStart } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { partyStatementQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useBalanceText, useIsoDate } from './journal-parts';

const column = dataTableColumns<LedgerLine>();

// Where each side's words are: the customer's page says "customers.statementTitle", the supplier's
// "suppliers.statementTitle" (the same keys in each section)
const SECTION = { customer: 'customers', supplier: 'suppliers' } as const satisfies Record<
  PartyRole,
  string
>;

// A party's receivable lines (a customer, step 15a) or payable lines (a supplier, step 17a) with a
// running balance: the ledger of one account, cut down to one party. Moved here from the customer's
// page in step 17a, so both pages show the same table. Dates as on the ledger: this fiscal year to
// today until the person picks.
export function PartyStatement({ role, partyId }: { role: PartyRole; partyId: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canReadJournal = useCan()('accounting.journal.read');
  const showDate = useIsoDate();
  const balanceText = useBalanceText();
  const section = SECTION[role];
  const settings = useQuery(settingsQuery(tenantId)).data;
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const today = todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
  const { from, to } = range ?? {
    from: fiscalYearStart(
      today,
      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
    ),
    to: today,
  };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    partyStatementQuery(tenantId, role, partyId, from, to),
  );
  const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const first = data?.pages[0];

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    const amount = (value: string) =>
      value === '0.0000' ? '' : format.money(value, { decimals: 2 });
    return column.columns([
      column.accessor('number', {
        header: t('ledger.columns.entry'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
            <span className="text-caption text-ink-3 tabular-nums">
              {showDate(row.original.date)}
            </span>
          </span>
        ),
      }),
      column.accessor((line) => line.description ?? line.narration ?? '', {
        id: 'narration',
        header: t('journal.columns.narration'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
      }),
      column.accessor('debit', {
        header: t('ledger.columns.debit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('credit', {
        header: t('ledger.columns.credit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('balance', {
        header: t('ledger.columns.balance'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => <span className="font-medium">{balanceText(getValue())}</span>,
      }),
    ]);
  }, [t, format, showDate, balanceText]);

  return (
    <section className="grid grid-cols-1 gap-4" aria-label={t(`${section}.statementTitle`)}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeader
          title={t(`${section}.statementTitle`)}
          subtitle={t(`${section}.statementSubtitle`)}
        />
        <div className="grid w-full grid-cols-2 gap-4 sm:w-auto sm:grid-cols-[12rem_12rem]">
          <Field id="statement-from" label={t('ledger.from')}>
            <DatePicker
              id="statement-from"
              value={from}
              onChange={(value) => {
                setRange({ from: value, to });
              }}
            />
          </Field>
          <Field id="statement-to" label={t('ledger.to')}>
            <DatePicker
              id="statement-to"
              value={to}
              onChange={(value) => {
                setRange({ from, to: value });
              }}
            />
          </Field>
        </div>
      </div>
      {/* One card split by a rule, like the ledger's */}
      <Card className="grid grid-cols-2 divide-x divide-line">
        {[
          { label: t('ledger.opening'), value: first?.openingBalance },
          { label: t('ledger.closing'), value: first?.closingBalance },
        ].map((cell) => (
          <div key={cell.label} className="grid gap-1 px-5 py-4">
            <span className="text-caption text-ink-3">{cell.label}</span>
            <span className="text-h3 tabular-nums">
              {cell.value === undefined ? '—' : balanceText(cell.value)}
            </span>
          </div>
        ))}
      </Card>
      {isError && <p className="text-body-sm text-crit">{t(`${section}.statementLoadFailed`)}</p>}
      {lines && (
        <DataTable
          label={t(`${section}.statementTitle`)}
          data={lines}
          columns={columns}
          getRowId={(line) => line.lineId}
          // The entry behind a line, for those who may read the journal
          onRowClick={
            canReadJournal
              ? (line) =>
                  void navigate({ to: '/journal/$entryId', params: { entryId: line.entryId } })
              : undefined
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Notebook02Icon}
              title={t(`${section}.statementEmptyTitle`)}
              description={t(`${section}.statementEmptyBody`)}
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
  );
}
```

The customer page's `Statement`, moved here and given a `role` (decision 36). `SECTION` picks the words: the
customer page reads `customers.statementTitle`, the supplier page `suppliers.statementTitle`; the keys are the same
in both sections, so `` t(`${section}.statementTitle`) `` type-checks for both. The table and the dates did not
change.

```tsx
import {
  Archive02Icon,
  BankIcon,
  PencilEdit02Icon,
  UserMultiple02Icon,
  UserSwitchIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { routes, type Supplier } from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, KpiStrip, PageHeader, Pill, toast } from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { failureOf } from '../components/journal-parts';
import {
  SupplierBackLink,
  SupplierNotFound,
  usePartyRefresh,
  useTenantId,
} from '../components/supplier-parts';
import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { customerQuery, supplierGroupsQuery, supplierQuery } from '../lib/queries';
import { useSupplierText } from '../lib/suppliers';

// The statement as a chunk of its own (step 17a): it brings the data table and the two date
// pickers, and sits at the bottom of the page for the people with the balance permission only.
// Inside, this page went over its 100 KB budget.
const PartyStatement = lazy(async () => ({
  default: (await import('../components/party-statement')).PartyStatement,
}));

// One label and its value in the details card; an empty value is a dash, so the rows line up
function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-1 gap-0.5">
      <dt className="text-label text-ink-3">{label}</dt>
      {/* pre-line: an address keeps the lines it was typed in */}
      <dd className="text-body-sm break-words whitespace-pre-line text-ink">{value ?? '—'}</dd>
    </div>
  );
}

// The supplier's page (step 17a), built like the customer's: what the company owes it, its
// details, where it is paid, and its statement.
function SupplierView({ supplier }: { supplier: Supplier }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const refresh = usePartyRefresh();
  const can = useCan();
  const canManage = can('purchase.supplier.manage');
  // The same business may buy from the company too (decision 10); not once it is archived
  const canMakeCustomer =
    can('sales.customer.manage') && !supplier.isCustomer && supplier.archivedAt === null;
  const text = useSupplierText();
  const [confirming, setConfirming] = useState(false);
  const groups = useQuery(supplierGroupsQuery(tenantId)).data;
  const group = groups?.find((item) => item.id === supplier.groupId);

  const toggle = useMutation({
    mutationFn: () =>
      call(supplier.archivedAt === null ? routes.suppliers.archive : routes.suppliers.restore, {
        params: { id: supplier.id },
        body: { version: supplier.version },
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(supplierQuery(tenantId, saved.id).queryKey, saved);
      // Both sides: archiving hides the party from both (decision 10)
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'suppliers.restoredToast' : 'suppliers.archivedToast', {
          name: saved.name,
        }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.suppliers.remove, {
        params: { id: supplier.id },
        query: { version: supplier.version },
      }),
    onSuccess: async () => {
      // To the list first: the deleted supplier's own query would otherwise refetch into a 404
      await navigate({ to: '/suppliers' });
      queryClient.removeQueries({ queryKey: supplierQuery(tenantId, supplier.id).queryKey });
      await refresh();
      // A party that is also a customer stays one: the delete took only the supplier side
      toast(
        t(supplier.isCustomer ? 'suppliers.sideDeleted' : 'suppliers.deleted', {
          name: supplier.name,
        }),
      );
    },
  });
  // "Make customer too": the customer side starts with its defaults, so the person goes to the
  // customer's page to set its terms, credit limit and price list
  const makeCustomer = useMutation({
    mutationFn: () =>
      call(routes.customers.fromSupplier, {
        params: { id: supplier.id },
        body: { version: supplier.version },
      }),
    onSuccess: async (customer) => {
      queryClient.setQueryData(customerQuery(tenantId, customer.id).queryKey, customer);
      await refresh();
      toast(t('suppliers.madeCustomer', { name: customer.name }));
      void navigate({ to: '/customers/$customerId', params: { customerId: customer.id } });
    },
  });
  // supplier_in_use, party_role_exists, version_conflict: they belong to no field
  const failure =
    failureOf(toggle.error) ?? failureOf(remove.error) ?? failureOf(makeCustomer.error);
  const busy = toggle.isPending || remove.isPending || makeCustomer.isPending;

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <SupplierBackLink />
      <PageHeader
        title={supplier.name}
        description={<span className="font-mono tabular-nums">{supplier.code}</span>}
        actions={
          <>
            {canMakeCustomer && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  makeCustomer.mutate();
                }}
              >
                <HugeiconsIcon icon={UserMultiple02Icon} size={17} strokeWidth={1.5} />
                {t('suppliers.makeCustomer')}
              </Button>
            )}
            {canManage && (
              <>
                {/* Delete takes two clicks: it cannot be undone */}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (confirming) remove.mutate();
                    else setConfirming(true);
                  }}
                >
                  {confirming
                    ? t('suppliers.confirmDelete', { code: supplier.code })
                    : t('suppliers.delete')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    toggle.mutate();
                  }}
                >
                  {supplier.archivedAt === null ? t('suppliers.archive') : t('suppliers.restore')}
                </Button>
                <Button
                  onClick={() =>
                    void navigate({
                      to: '/suppliers/$supplierId/edit',
                      params: { supplierId: supplier.id },
                    })
                  }
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
                  {t('suppliers.edit')}
                </Button>
              </>
            )}
          </>
        }
      />
      {confirming && (
        <p className="text-body-sm text-ink-2">
          {supplier.isCustomer
            ? t('suppliers.deleteSideWarning', { name: supplier.name })
            : t('suppliers.deleteWarning')}
        </p>
      )}
      {failure && <FormAlert message={failure} />}
      {(supplier.archivedAt !== null || supplier.isCustomer) && (
        <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
          {supplier.archivedAt !== null && (
            <>
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('suppliers.statuses.archived')}
              </Pill>
              <span>{t('suppliers.archivedNotice')}</span>
            </>
          )}
          {supplier.isCustomer && (
            <>
              <Pill tone="brand" icon={UserSwitchIcon}>
                {t('suppliers.alsoCustomer')}
              </Pill>
              <Link
                to="/customers/$customerId"
                params={{ customerId: supplier.id }}
                className="font-medium text-brand underline-offset-3 hover:underline"
              >
                {t('suppliers.customerPage')}
              </Link>
            </>
          )}
        </div>
      )}
      <KpiStrip
        cells={[
          // Without purchase.supplier.balance the server sends null: the group takes the place
          supplier.balance === null
            ? { label: t('suppliers.fields.group'), value: group?.name ?? '—' }
            : { label: t('suppliers.kpis.balance'), value: text.balance(supplier.balance) },
          { label: t('suppliers.kpis.terms'), value: text.terms(supplier.paymentTermsDays) },
          {
            label: t('suppliers.kpis.bankAccounts'),
            value: format.number(supplier.bankAccounts.length),
          },
        ]}
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('suppliers.details')} />
          <dl className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <Detail label={t('suppliers.fields.contactPerson')} value={supplier.contactPerson} />
            <Detail label={t('suppliers.fields.phone')} value={supplier.phone} />
            <Detail label={t('suppliers.fields.email')} value={supplier.email} />
            <Detail
              label={t('suppliers.fields.documentLanguage')}
              value={
                LANGUAGES.find((language) => language.code === supplier.documentLanguage)?.label ??
                null
              }
            />
            <Detail label={t('suppliers.fields.bin')} value={supplier.bin} />
            <Detail label={t('suppliers.fields.group')} value={group?.name ?? null} />
            <div className="sm:col-span-2">
              <Detail
                label={t('suppliers.fields.address')}
                value={supplier.address ?? t('suppliers.noAddress')}
              />
            </div>
            {supplier.notes && (
              <div className="sm:col-span-2">
                <Detail label={t('suppliers.fields.notes')} value={supplier.notes} />
              </div>
            )}
          </dl>
        </Card>
        <Card>
          <CardHeader title={t('suppliers.sections.bankAccounts')} />
          <ul className="grid grid-cols-1 gap-4 p-5">
            {supplier.bankAccounts.length === 0 ? (
              <li className="text-body-sm text-ink-3">{t('suppliers.noBankAccounts')}</li>
            ) : (
              supplier.bankAccounts.map((account) => (
                <li key={account.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                  <HugeiconsIcon
                    icon={BankIcon}
                    size={18}
                    strokeWidth={1.5}
                    className="mt-0.5 text-ink-3"
                  />
                  <span className="grid gap-0.5">
                    <span className="text-body-sm font-medium">
                      {account.branchName === null
                        ? account.bankName
                        : t('suppliers.bankAccounts.bankAndBranch', {
                            bank: account.bankName,
                            branch: account.branchName,
                          })}
                    </span>
                    <span className="text-body-sm text-ink-2">{account.accountName}</span>
                    {/* The number in Geist Mono: it is read out and typed into a bank's app digit
                        by digit (CLAUDE.md → Typography) */}
                    <span className="font-mono text-body-sm text-ink tabular-nums">
                      {account.accountNumber}
                    </span>
                    {account.routingNumber && (
                      <span className="text-caption text-ink-3 tabular-nums">
                        {t('suppliers.bankAccounts.routing', { number: account.routingNumber })}
                      </span>
                    )}
                  </span>
                </li>
              ))
            )}
          </ul>
        </Card>
      </div>
      {/* The same rule as the balance: what the company owes is not every store keeper's business */}
      {can('purchase.supplier.balance') && (
        <Suspense fallback={null}>
          <PartyStatement role="supplier" partyId={supplier.id} />
        </Suspense>
      )}
    </div>
  );
}

export function SupplierPage() {
  const { supplierId = '' } = useParams({ strict: false });
  const { data: supplier, isError } = useQuery({
    ...supplierQuery(useTenantId(), supplierId),
    enabled: supplierId !== '',
  });
  if (isError) return <SupplierNotFound />;
  if (!supplier) return null;
  return <SupplierView supplier={supplier} />;
}
```

- **`PartyStatement` is a lazy chunk** (decision 36), inside `Suspense` with no fallback: it is the last thing on
  the page, and nothing moves when it arrives. With it inside, the customer page was 101 KB.
- **"Make customer too"** needs `sales.customer.manage`, because it makes a customer. It is hidden on an archived
  supplier: an archived party is hidden from new documents on both sides. On success the page goes to the new
  customer (decision 37).
- **The delete says what it does.** A party that is also a customer loses only its supplier side, so the warning and
  the toast say that (`deleteSideWarning`, `sideDeleted`). "Meghna Spinning Mills deleted" would be untrue.
- **The account number is in `Geist Mono`:** it is read out and typed into a bank's app digit by digit.
- **`Detail` keeps line breaks** (`whitespace-pre-line`), so an address typed on three lines shows on three lines.

```tsx
import { PlusSignIcon, UserGroup02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  type SupplierGroup,
  supplierGroupInputSchema,
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
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { failureOf } from '../components/journal-parts';
import { useTenantId } from '../components/supplier-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { supplierGroupsQuery } from '../lib/queries';

const column = dataTableColumns<SupplierGroup>();
const FIELD_NAMES = supplierGroupInputSchema.keyof().options;

// Step 17a: the supplier's twin of the customer groups page (routes/customer-groups.tsx), for
// groups like Yarn and fabric, Accessories and Packaging. One form for both: a new group (none
// given) and a rename. A rename sends the version the dialog opened with; the name is all a group
// has.
function GroupForm({ group, onDone }: { group: SupplierGroup | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(supplierGroupInputSchema, { error: contractErrorMap }),
    defaultValues: { name: group?.name ?? '' },
  });

  // ['suppliers', tenantId]: the list's group column and filter read the groups too
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] });

  const remove = useMutation({
    mutationFn: (target: SupplierGroup) =>
      call(routes.supplierGroups.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async (_, target) => {
      await refresh();
      toast(t('supplierGroups.deleted', { name: target.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = group
        ? await call(routes.supplierGroups.update, {
            params: { id: group.id },
            body: { ...values, version: group.version },
          })
        : await call(routes.supplierGroups.create, { body: values });
      await refresh();
      toast(t(group ? 'supplierGroups.updated' : 'supplierGroups.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // supplier_group_in_use, version_conflict: they belong to no field
  const failure = errors.root?.server?.message ?? failureOf(remove.error);

  return (
    <DialogContent
      title={
        group ? t('supplierGroups.editTitle', { name: group.name }) : t('supplierGroups.newTitle')
      }
      footer={
        <>
          {group && (
            // Left, away from Save. Two clicks: a deleted group cannot come back.
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={remove.isPending}
              onClick={() => {
                if (confirming) remove.mutate(group);
                else setConfirming(true);
              }}
            >
              {confirming
                ? t('supplierGroups.confirmDelete', { name: group.name })
                : t('supplierGroups.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="supplier-group-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : group ? t('common.save') : t('supplierGroups.add')}
          </Button>
        </>
      }
    >
      <form
        id="supplier-group-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && (
          <p className="text-body-sm text-ink-2">{t('supplierGroups.deleteWarning')}</p>
        )}
        <TextField
          label={t('supplierGroups.name')}
          icon={UserGroup02Icon}
          placeholder={t('supplierGroups.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | SupplierGroup;

export function SupplierGroupsPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const canManage = useCan()('purchase.supplier.manage');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery(supplierGroupsQuery(tenantId));

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('supplierGroups.columns.name'),
          meta: { card: 'title' },
          cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
        }),
        column.accessor('supplierCount', {
          header: t('supplierGroups.columns.suppliers'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) =>
            t('supplierGroups.supplierCount', {
              count: getValue(),
              formatted: format.number(getValue()),
            }),
        }),
      ]),
    [t, format],
  );

  return (
    <div className="grid max-w-3xl gap-5">
      <PageHeader
        title={t('supplierGroups.title')}
        description={t('supplierGroups.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('supplierGroups.add')}
            </Button>
          )
        }
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('supplierGroups.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('supplierGroups.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('supplierGroups.title')}
          data={data}
          columns={columns}
          getRowId={(group) => group.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            <EmptyState
              icon={UserGroup02Icon}
              title={t('supplierGroups.emptyTitle')}
              description={t('supplierGroups.emptyBody')}
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
        {editing !== null && (
          <GroupForm
            key={editing === 'new' ? 'new' : editing.id}
            group={editing === 'new' ? null : editing}
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

The customer groups page with the supplier's words and permission. A group change refreshes only
`['suppliers', tenant]`: the list's group column and filter read the groups, and no customer shows a supplier
group.

### The customer page: one statement, and the supplier side

```diff
@@ -1,57 +1,41 @@
 import {
   Archive02Icon,
+  Factory01Icon,
   Invoice03Icon,
   Location01Icon,
   MoneyReceive02Icon,
-  Notebook02Icon,
   PencilEdit02Icon,
   TruckDeliveryIcon,
   UserSwitchIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
-import {
-  type Customer,
-  DEFAULT_SETTINGS,
-  type LedgerLine,
-  routes,
-  todayIn,
-} from '@omnivo/contracts';
+import { type Customer, routes } from '@omnivo/contracts';
 import { LANGUAGES, useLocale } from '@omnivo/i18n';
-import {
-  Button,
-  Card,
-  CardHeader,
-  DataTable,
-  dataTableColumns,
-  DatePicker,
-  EmptyState,
-  Field,
-  FormAlert,
-  KpiStrip,
-  PageHeader,
-  Pill,
-  SectionHeader,
-  toast,
-} from '@omnivo/ui';
-import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
-import { useNavigate, useParams } from '@tanstack/react-router';
-import { useCallback, useMemo, useState } from 'react';
+import { Button, Card, CardHeader, FormAlert, KpiStrip, PageHeader, Pill, toast } from '@omnivo/ui';
+import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
+import { Link, useNavigate, useParams } from '@tanstack/react-router';
+import { lazy, Suspense, useState } from 'react';
 
 import { BackLink, CustomerNotFound, useTenantId } from '../components/customer-parts';
-import { failureOf, useBalanceText, useIsoDate } from '../components/journal-parts';
+import { failureOf } from '../components/journal-parts';
 import { call } from '../lib/api';
 import { useCustomerText } from '../lib/customers';
-import { fiscalYearStart } from '../lib/journal';
 import { useCan } from '../lib/permissions';
 import {
   customerCreditQuery,
   customerGroupsQuery,
   customerQuery,
-  customerStatementQuery,
   priceListsQuery,
-  settingsQuery,
+  supplierQuery,
 } from '../lib/queries';
 
+// The statement as a chunk of its own (step 17a): it brings the data table and the two date
+// pickers, and sits at the bottom of the page for the people with the balance permission only.
+// Inside, this page went over its 100 KB budget.
+const PartyStatement = lazy(async () => ({
+  default: (await import('../components/party-statement')).PartyStatement,
+}));
+
 // One label and its value in the details card; an empty value is a dash, so the rows line up
 function Detail({ label, value }: { label: string; value: string | null }) {
   return (
@@ -62,157 +46,6 @@ function Detail({ label, value }: { label: string; value: string | null }) {
   );
 }
 
-const column = dataTableColumns<LedgerLine>();
-
-// The customer's receivable lines with a running balance: the ledger of one account, cut down
-// to one customer. Dates as on the ledger: this fiscal year to today until the person picks.
-function Statement({ customerId }: { customerId: string }) {
-  const { t, format } = useLocale();
-  const navigate = useNavigate();
-  const tenantId = useTenantId();
-  const canReadJournal = useCan()('accounting.journal.read');
-  const showDate = useIsoDate();
-  const balanceText = useBalanceText();
-  const settings = useQuery(settingsQuery(tenantId)).data;
-  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
-  const today = todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
-  const { from, to } = range ?? {
-    from: fiscalYearStart(
-      today,
-      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
-    ),
-    to: today,
-  };
-  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
-    customerStatementQuery(tenantId, customerId, from, to),
-  );
-  const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
-  const first = data?.pages[0];
-
-  const loadMore = useCallback(() => {
-    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
-  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
-
-  const columns = useMemo(() => {
-    const amount = (value: string) =>
-      value === '0.0000' ? '' : format.money(value, { decimals: 2 });
-    return column.columns([
-      column.accessor('number', {
-        header: t('ledger.columns.entry'),
-        enableSorting: false,
-        meta: { card: 'title' },
-        cell: ({ row }) => (
-          <span className="grid">
-            <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
-            <span className="text-caption text-ink-3 tabular-nums">
-              {showDate(row.original.date)}
-            </span>
-          </span>
-        ),
-      }),
-      column.accessor((line) => line.description ?? line.narration ?? '', {
-        id: 'narration',
-        header: t('journal.columns.narration'),
-        enableSorting: false,
-        meta: { card: 'subtitle' },
-        cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
-      }),
-      column.accessor('debit', {
-        header: t('ledger.columns.debit'),
-        enableSorting: false,
-        meta: { align: 'end', card: 'detail' },
-        cell: ({ getValue }) => amount(getValue()),
-      }),
-      column.accessor('credit', {
-        header: t('ledger.columns.credit'),
-        enableSorting: false,
-        meta: { align: 'end', card: 'detail' },
-        cell: ({ getValue }) => amount(getValue()),
-      }),
-      column.accessor('balance', {
-        header: t('ledger.columns.balance'),
-        enableSorting: false,
-        meta: { align: 'end', card: 'trailing' },
-        cell: ({ getValue }) => <span className="font-medium">{balanceText(getValue())}</span>,
-      }),
-    ]);
-  }, [t, format, showDate, balanceText]);
-
-  return (
-    <section className="grid grid-cols-1 gap-4" aria-label={t('customers.statementTitle')}>
-      <div className="flex flex-wrap items-end justify-between gap-4">
-        <SectionHeader
-          title={t('customers.statementTitle')}
-          subtitle={t('customers.statementSubtitle')}
-        />
-        <div className="grid w-full grid-cols-2 gap-4 sm:w-auto sm:grid-cols-[12rem_12rem]">
-          <Field id="statement-from" label={t('ledger.from')}>
-            <DatePicker
-              id="statement-from"
-              value={from}
-              onChange={(value) => {
-                setRange({ from: value, to });
-              }}
-            />
-          </Field>
-          <Field id="statement-to" label={t('ledger.to')}>
-            <DatePicker
-              id="statement-to"
-              value={to}
-              onChange={(value) => {
-                setRange({ from, to: value });
-              }}
-            />
-          </Field>
-        </div>
-      </div>
-      {/* One card split by a rule, like the ledger's */}
-      <Card className="grid grid-cols-2 divide-x divide-line">
-        {[
-          { label: t('ledger.opening'), value: first?.openingBalance },
-          { label: t('ledger.closing'), value: first?.closingBalance },
-        ].map((cell) => (
-          <div key={cell.label} className="grid gap-1 px-5 py-4">
-            <span className="text-caption text-ink-3">{cell.label}</span>
-            <span className="text-h3 tabular-nums">
-              {cell.value === undefined ? '—' : balanceText(cell.value)}
-            </span>
-          </div>
-        ))}
-      </Card>
-      {isError && <p className="text-body-sm text-crit">{t('customers.statementLoadFailed')}</p>}
-      {lines && (
-        <DataTable
-          label={t('customers.statementTitle')}
-          data={lines}
-          columns={columns}
-          getRowId={(line) => line.lineId}
-          // The entry behind a line, for those who may read the journal
-          onRowClick={
-            canReadJournal
-              ? (line) =>
-                  void navigate({ to: '/journal/$entryId', params: { entryId: line.entryId } })
-              : undefined
-          }
-          onEndReached={loadMore}
-          empty={
-            <EmptyState
-              icon={Notebook02Icon}
-              title={t('customers.statementEmptyTitle')}
-              description={t('customers.statementEmptyBody')}
-            />
-          }
-          footer={
-            isFetchingNextPage && (
-              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
-            )
-          }
-        />
-      )}
-    </section>
-  );
-}
-
 function CustomerView({ customer }: { customer: Customer }) {
   const { t, format } = useLocale();
   const navigate = useNavigate();
@@ -223,6 +56,10 @@ function CustomerView({ customer }: { customer: Customer }) {
   // Step 15c: bill the customer, take their money. An archived customer is not sold to any more.
   const canBill = can('sales.invoice.manage') && customer.archivedAt === null;
   const canPay = can('sales.receipt.manage');
+  // Step 17a: the same business may sell to the company too (decision 10). Not for an archived
+  // one: it is hidden from new documents on both sides.
+  const canMakeSupplier =
+    can('purchase.supplier.manage') && !customer.isSupplier && customer.archivedAt === null;
   // What counts against the credit limit, with the numbers the order and invoice forms check
   const credit = useQuery({
     ...customerCreditQuery(tenantId, customer.id),
@@ -262,12 +99,37 @@ function CustomerView({ customer }: { customer: Customer }) {
       await navigate({ to: '/customers' });
       queryClient.removeQueries({ queryKey: customerQuery(tenantId, customer.id).queryKey });
       await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
-      toast(t('customers.deleted', { name: customer.name }));
+      // Step 17a: a party that is also a supplier stays one; the delete took only this side
+      if (customer.isSupplier) {
+        await queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] });
+        toast(t('customers.sideDeleted', { name: customer.name }));
+      } else {
+        toast(t('customers.deleted', { name: customer.name }));
+      }
     },
   });
-  // customer_in_use, version_conflict: they belong to no field
-  const failure = failureOf(toggle.error) ?? failureOf(remove.error);
-  const busy = toggle.isPending || remove.isPending;
+  // "Make supplier too": the supplier side starts with its defaults (no group, terms on receipt, no
+  // bank account), so the person goes to the supplier's page to fill them in
+  const makeSupplier = useMutation({
+    mutationFn: () =>
+      call(routes.suppliers.fromCustomer, {
+        params: { id: customer.id },
+        body: { version: customer.version },
+      }),
+    onSuccess: async (supplier) => {
+      queryClient.setQueryData(supplierQuery(tenantId, supplier.id).queryKey, supplier);
+      await Promise.all([
+        queryClient.invalidateQueries({ queryKey: ['customers', tenantId] }),
+        queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] }),
+      ]);
+      toast(t('customers.madeSupplier', { name: supplier.name }));
+      void navigate({ to: '/suppliers/$supplierId', params: { supplierId: supplier.id } });
+    },
+  });
+  // customer_in_use, party_role_exists, version_conflict: they belong to no field
+  const failure =
+    failureOf(toggle.error) ?? failureOf(remove.error) ?? failureOf(makeSupplier.error);
+  const busy = toggle.isPending || remove.isPending || makeSupplier.isPending;
 
   return (
     <div className="grid max-w-5xl grid-cols-1 gap-5">
@@ -299,6 +161,18 @@ function CustomerView({ customer }: { customer: Customer }) {
                 {t('customers.recordPayment')}
               </Button>
             )}
+            {canMakeSupplier && (
+              <Button
+                variant="secondary"
+                disabled={busy}
+                onClick={() => {
+                  makeSupplier.mutate();
+                }}
+              >
+                <HugeiconsIcon icon={Factory01Icon} size={17} strokeWidth={1.5} />
+                {t('customers.makeSupplier')}
+              </Button>
+            )}
             {canManage && (
               <>
                 {/* Delete takes two clicks: it cannot be undone */}
@@ -339,7 +213,14 @@ function CustomerView({ customer }: { customer: Customer }) {
           </>
         }
       />
-      {confirming && <p className="text-body-sm text-ink-2">{t('customers.deleteWarning')}</p>}
+      {confirming && (
+        <p className="text-body-sm text-ink-2">
+          {/* A party that is both loses only its customer side (step 17a, decision 10) */}
+          {customer.isSupplier
+            ? t('customers.deleteSideWarning', { name: customer.name })
+            : t('customers.deleteWarning')}
+        </p>
+      )}
       {failure && <FormAlert message={failure} />}
       {(customer.archivedAt !== null || customer.isSupplier) && (
         <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
@@ -352,9 +233,19 @@ function CustomerView({ customer }: { customer: Customer }) {
             </>
           )}
           {customer.isSupplier && (
-            <Pill tone="brand" icon={UserSwitchIcon}>
-              {t('customers.alsoSupplier')}
-            </Pill>
+            <>
+              <Pill tone="brand" icon={UserSwitchIcon}>
+                {t('customers.alsoSupplier')}
+              </Pill>
+              {/* Step 17a: the same party's supplier page (everyone may read suppliers) */}
+              <Link
+                to="/suppliers/$supplierId"
+                params={{ supplierId: customer.id }}
+                className="font-medium text-brand underline-offset-3 hover:underline"
+              >
+                {t('customers.supplierPage')}
+              </Link>
+            </>
           )}
         </div>
       )}
@@ -458,7 +349,11 @@ function CustomerView({ customer }: { customer: Customer }) {
         </Card>
       </div>
       {/* The same rule as the balance: what a customer owes is not every cashier's business */}
-      {can('sales.customer.balance') && <Statement customerId={customer.id} />}
+      {can('sales.customer.balance') && (
+        <Suspense fallback={null}>
+          <PartyStatement role="customer" partyId={customer.id} />
+        </Suspense>
+      )}
     </div>
   );
 }
```

- **The `Statement` function is gone,** and `PartyStatement` comes in as a lazy chunk. This also took most of the
  page's imports with it (the table, the date pickers, the fiscal year helper).
- **"Make supplier too"** needs `purchase.supplier.manage` and an active customer that is not a supplier yet. It
  puts the new supplier in the cache and opens its page (decision 37).
- **"Also a supplier" now has a link** to the same party's supplier page. Everyone may read suppliers, so the link
  needs no permission.
- **The delete of a party that is both** shows `deleteSideWarning` and, after it, the `sideDeleted` toast, and
  refreshes the suppliers too: the supplier list shows that the party is no longer a customer.

### Settings → Approval levels: `routes/approval-rules.tsx` (new)

```tsx
import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ApprovalDocument,
  type ApprovalRule,
  type ApprovalRuleFormValues,
  approvalRuleInputSchema,
  contractErrorMap,
  isApprovalDocument,
  MAX_APPROVAL_LEVELS,
  type Role,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Path, useFieldArray, useForm } from 'react-hook-form';

import { useTenantId } from '../components/supplier-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { rowPath } from '../lib/products';
import { approvalRulesQuery, rolesQuery } from '../lib/queries';

// Settings → Approval levels (step 17a): one card per kind of document, each its own form. A save
// replaces that kind's levels and nothing else, so two cards never overwrite each other.

// Level 1 | from amount | role | remove: one template for every row of a card
const LEVEL_ROW = 'grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem]';

function fieldNames(count: number): Path<ApprovalRuleFormValues>[] {
  return [
    'levels',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('levels', index, 'minAmount'),
      rowPath('levels', index, 'roleId'),
    ]).flat(),
  ];
}

function RuleCard({
  document,
  rule,
  roles,
  canManage,
}: {
  document: ApprovalDocument;
  rule: ApprovalRule;
  roles: readonly Role[];
  canManage: boolean;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const title = t(`approvalRules.documents.${document}.title`);
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(approvalRuleInputSchema, { error: contractErrorMap }),
    defaultValues: {
      levels: rule.levels.map((level) => ({ minAmount: level.minAmount, roleId: level.role.id })),
      // 0 while the workspace never saved levels for this kind (no row yet)
      version: rule.version,
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'levels' });

  const onSubmit = handleSubmit(async (body) => {
    try {
      const saved = await call(routes.approvalRules.update, { params: { document }, body });
      // The saved rule into the list at once; the card's key (its version) then starts the form
      // again from what the server kept
      queryClient.setQueryData(approvalRulesQuery(tenantId).queryKey, (before) =>
        before?.map((item) => (item.document === saved.document ? saved : item)),
      );
      toast(t('approvalRules.saved', { document: title }));
    } catch (error) {
      applyApiError(error, fieldNames(getValues('levels').length), setError);
    }
  });

  // A new level starts at the amount of the one above it: the order rule (each level from that
  // amount or more) then holds until the person types a bigger one
  const addLevel = () => {
    const last = getValues('levels').at(-1);
    append({ minAmount: last?.minAmount ?? '0', roleId: '' });
  };

  const roleOptions = [
    { value: '', label: t('approvalRules.rolePlaceholder') },
    ...roles.map((role) => ({ value: role.id, label: role.name })),
  ];
  const levelsError = errors.levels?.root?.message ?? errors.levels?.message;

  return (
    <Card>
      <CardHeader title={title} subtitle={t(`approvalRules.documents.${document}.subtitle`)} />
      <form
        noValidate
        aria-label={title}
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-4 p-5"
      >
        {/* Without the permission the levels are read, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-4">
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          {fields.length === 0 ? (
            <p className="text-body-sm text-ink-2">{t('approvalRules.none')}</p>
          ) : (
            <ol className="grid grid-cols-1 gap-3">
              {fields.map((field, index) => {
                const number = index + 1;
                const rowErrors = errors.levels?.[index];
                return (
                  <li
                    key={field.id}
                    role="group"
                    aria-label={t('approvalRules.level', { number })}
                    className="grid grid-cols-1 gap-3 rounded-control border border-line p-4"
                  >
                    <span className="text-label font-medium text-ink-2">
                      {t('approvalRules.level', { number })}
                    </span>
                    <div className={LEVEL_ROW}>
                      <FormField
                        control={control}
                        name={rowPath('levels', index, 'minAmount')}
                        label={t('approvalRules.from')}
                        hint={t('approvalRules.fromHint')}
                      >
                        {/* Whole taka: a level starts at ৳50,000, never at ৳50,000.50 */}
                        {(input) => <MoneyInput {...input} scale={0} />}
                      </FormField>
                      <SelectField
                        id={rowPath('levels', index, 'roleId')}
                        label={t('approvalRules.role')}
                        options={roleOptions}
                        {...register(rowPath('levels', index, 'roleId'))}
                        error={rowErrors?.roleId?.message}
                      />
                      {canManage && (
                        // Level with the boxes, below their labels
                        <IconButton
                          icon={Delete02Icon}
                          label={t('approvalRules.remove', { number })}
                          className="justify-self-end sm:mt-[26px] sm:self-start"
                          onClick={() => {
                            remove(index);
                          }}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {levelsError && <p className="text-label text-crit">{errorText(levelsError)}</p>}
          <div className="grid gap-1 text-label text-ink-3">
            <p>{t('approvalRules.rules')}</p>
            <p>{t('approvalRules.applies')}</p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={fields.length >= MAX_APPROVAL_LEVELS}
                onClick={addLevel}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('approvalRules.add')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t('common.saving') : t('approvalRules.save')}
              </Button>
            </div>
          )}
          {canManage && fields.length >= MAX_APPROVAL_LEVELS && (
            <p className="text-label text-ink-3">
              {t('approvalRules.tooMany', { max: MAX_APPROVAL_LEVELS })}
            </p>
          )}
        </fieldset>
      </form>
    </Card>
  );
}

export function ApprovalRulesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canManage = useCan()('core.settings.manage');
  const { data: rules, isError } = useQuery(approvalRulesQuery(tenantId));
  const roles = useQuery(rolesQuery(tenantId)).data;

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-5">
      <PageHeader title={t('approvalRules.title')} description={t('approvalRules.description')} />
      {!canManage && <p className="text-body-sm text-ink-3">{t('approvalRules.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('approvalRules.loadFailed')}</p>}
      {rules &&
        roles &&
        rules.map((rule) => {
          // A kind a newer server knows and this app does not: no card, instead of a broken one
          const { document } = rule;
          if (!isApprovalDocument(document)) return null;
          return (
            // key with the version: after a save the form starts again from the saved levels
            <RuleCard
              key={`${document}-${String(rule.version)}`}
              document={document}
              rule={rule}
              roles={roles}
              canManage={canManage}
            />
          );
        })}
    </div>
  );
}
```

- **One `RuleCard` per kind of document, each its own form** (decision 40). The save sends only that kind's levels,
  with the version that card was opened with.
- **After a save, the saved rule goes straight into the list's cache,** and the card's `key` (the kind and the
  version) starts the form again from what the server kept. A second save then sends the new version, not the old
  one, and gets no `version_conflict`.
- **A new level starts at the amount of the level above it.** The order rule (each level from that amount or more)
  then holds until the person types a bigger amount, so adding a level never shows an error at once.
- **`MoneyInput` with `scale={0}`:** whole taka. A level starts at ৳50,000, never at ৳50,000.50.
- **The `fieldset` is disabled without `core.settings.manage`,** so the same page reads for everyone else.
- **A kind this app does not know is skipped** (`isApprovalDocument`): a newer server may send 17b's purchase order
  to an older app, and a card without words would be worse than no card.

### The lines of a requisition

```ts
import {
  type ApprovalRound,
  type ApprovalStep,
  defaultLineDescription,
  draftRequisitionLineAmount,
  plainQuantity,
  type Product,
  type ProductVariant,
  type RequisitionLine,
  type RequisitionLineFormValues,
  sumMoney,
  type VariantRef,
  waitingStep,
} from '@omnivo/contracts';

// The pure parts of the purchase pages (step 17a): no React, so they are unit-tested
// (purchase.spec.ts) and shared by the form, the editor and the view. Here, not in
// purchase-lines-editor.tsx: the form needs them at once, and the editor is a lazy chunk of its own.

// What a line needs to know about its product, beside what the form sends: its name for the cell,
// its packs for the unit select, and whether it is a service
export type PurchaseItem = VariantRef & {
  units: readonly { unitId: string; factor: string }[];
  productType: string;
};

// What the editor keeps per line, beside the form value, at the same index
export interface PurchaseLineMeta {
  // React's key: stays with the line when a line above it is removed
  key: string;
  item: PurchaseItem;
  // Where a new line's cost came from (the cost lookup): a PURCHASE_COST_SOURCES value, or null
  // when nothing was known. undefined for a saved line: nothing new to say about it.
  source: string | null | undefined;
}

// A variant of a product the picker added
export function purchaseItemOf(product: Product, variant: ProductVariant): PurchaseItem {
  return {
    variantId: variant.id,
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: product.baseUnitId,
    units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    productType: product.type,
  };
}

// The unit a new line starts in: the product's buying unit (a cone of yarn comes in a bag of 24),
// else its base unit
export function purchaseUnitOf(product: Product): string {
  return product.purchaseUnitId ?? product.baseUnitId;
}

// The fields of a requisition line the server may name in an error ("lines.3.estimatedCost")
export const REQUISITION_LINE_FIELDS = [
  'variantId',
  'unitId',
  'quantity',
  'description',
  'estimatedCost',
] as const;

// A saved line, as the form holds it. A description that is just the product's name is shown as
// an empty box (with the name as its placeholder), so the next save keeps following the product,
// like a sales line.
export function toRequisitionFormLine(line: RequisitionLine): RequisitionLineFormValues {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    description: line.description === defaultLineDescription(line) ? '' : line.description,
    estimatedCost: line.estimatedCost,
  };
}

// The form's starting lines and the editor's meta for a saved requisition
export function savedRequisitionLines(lines: readonly RequisitionLine[]): {
  values: RequisitionLineFormValues[];
  meta: PurchaseLineMeta[];
} {
  return {
    values: lines.map(toRequisitionFormLine),
    meta: lines.map((line) => ({
      key: line.id,
      item: {
        variantId: line.variantId,
        productId: line.productId,
        productCode: line.productCode,
        productName: line.productName,
        optionValues: line.optionValues,
        sku: line.sku,
        baseUnitId: line.baseUnitId,
        units: line.units,
        productType: line.productType,
      },
      source: undefined,
    })),
  };
}

// What the lines are worth while they are typed: each line's amount (null until its quantity and
// cost are complete) and the total of the complete ones. The contracts' own functions, so the form
// shows the amount the server will store, and that chooses the approval levels.
export function requisitionFormTotals(lines: readonly RequisitionLineFormValues[]): {
  amounts: (string | null)[];
  total: string;
} {
  const amounts = lines.map((line) =>
    draftRequisitionLineAmount(line.quantity, line.estimatedCost),
  );
  return {
    amounts,
    total: sumMoney(amounts.filter((amount): amount is string => amount !== null)),
  };
}

// "Round 3" for the newest of three: the API sends the rounds newest first, and a person counts
// them from the first submission
export function roundNumber(rounds: readonly ApprovalRound[], index: number): number {
  return rounds.length - index;
}

// What a step of a round shows. A step without a decision waits only while its round is pending
// and every step above it was approved; one below it is "not yet". Once a round was rejected or
// reopened, its undecided steps were never decided ("not decided"), so they must not read as
// waiting for anyone.
export const STEP_STATES = ['approved', 'rejected', 'waiting', 'notYet', 'notDecided'] as const;
export type StepState = (typeof STEP_STATES)[number];

export function stepState(round: ApprovalRound, step: ApprovalStep): StepState {
  if (step.decision !== null) return step.decision;
  if (round.status !== 'pending') return 'notDecided';
  return waitingStep(round)?.position === step.position ? 'waiting' : 'notYet';
}

// An Owner's own document is approved when it is submitted (decision 14): the API decides each
// step in the Owner's name at once. Nobody else can approve their own document, so every step
// decided by the person who submitted it means that.
export function approvedByOwnSubmit(round: ApprovalRound): boolean {
  return (
    round.steps.length > 0 &&
    round.steps.every(
      (step) => step.decision === 'approved' && step.decidedBy?.id === round.submittedBy.id,
    )
  );
}
```

The pure parts, with no React, so they are unit-tested:

- **`PurchaseItem` and `PurchaseLineMeta`** are what the editor keeps beside each form line: the product's name and
  packs for the cell and the unit select, and where its cost came from. The form itself holds only what the API
  takes.
- **`purchaseUnitOf`:** a new line starts in the product's buying unit (yarn comes in bags of 24 cones), like a sales
  line starts in the selling unit.
- **`toRequisitionFormLine`** shows a description that is just the product's name as an empty box, like a sales
  line. The next save then keeps following the product's name if it is renamed.
- **`requisitionFormTotals`** uses the contracts' own `draftRequisitionLineAmount` and `sumMoney`, so the total under
  the lines is to the paisa what the server will store. That total chooses the approval levels (decision 7).
- **`stepState`:** a step without a decision is "waiting" only while its round is pending and it is the first
  undecided one. In a round that was rejected or reopened, the steps after the rejection were never decided, and
  they must not read as waiting for someone.
- **`approvedByOwnSubmit`:** an Owner's own requisition is approved when it is submitted, with every step decided in
  the Owner's name (decision 14). Nobody else may decide their own document, so "every step approved by the person
  who submitted it" means exactly that case.
- **`roundNumber`:** the API sends the rounds newest first, and people count them from the first submission.

```tsx
import {
  Alert02Icon,
  PackageSearchIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { Product, ProductSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogContent, EmptyState, Input, Pill } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { productQuery, productSearchQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';
import { failureOf } from './journal-parts';
import { useTenantId } from './stock-parts';

// "Add items": search the products and services, then add one. The dialog stays open, so a long
// order is put together without closing it; each click adds the product's lines at once. Moved
// out of sales-line-editor.tsx in step 17a: the requisition's lines (purchase-lines-editor.tsx)
// add items the same way. `words` names the section the texts come from, so each document speaks
// its own language ("Each click adds a line in its selling unit" or "… its buying unit").
export function ProductPicker({
  words,
  onAdd,
  maxLines,
}: {
  words: 'salesLines' | 'purchaseLines';
  onAdd: (product: Product) => Promise<boolean>;
  maxLines: number;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: products } = useQuery(productSearchQuery(tenantId, settled));

  // The list sends a summary; the variants, the packs and the selling unit come with the product
  const add = async (summary: ProductSummary) => {
    setLoading(summary.id);
    setProblem(null);
    try {
      const fits = await onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
      if (fits) setAdded((before) => new Set(before).add(summary.id));
      else setProblem(t(`${words}.tooMany`, { max: maxLines }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent title={t(`${words}.pickerTitle`)} description={t(`${words}.pickerDescription`)}>
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t(`${words}.pickerSearch`)}
          placeholder={t('products.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        {problem !== null && (
          <p role="status" className="flex items-center gap-1.5 text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
            {problem}
          </p>
        )}
        {products?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t(`${words}.pickerEmpty`)}
            description={t(`${words}.pickerDescription`)}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {products?.map((product) => (
              <li
                key={product.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{product.name}</span>
                  <span className="truncate text-caption text-ink-3">
                    <span className="font-mono tabular-nums">{product.code}</span>
                    {product.hasVariants &&
                      ` · ${t('products.variantCount', { count: product.variantCount })}`}
                  </span>
                </span>
                {/* A service (a repair, a delivery charge) is bought or sold, never stocked */}
                {product.type === 'service' && (
                  <Pill tone="neutral" icon={Wrench01Icon}>
                    {t(`${words}.service`)}
                  </Pill>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading === product.id}
                  onClick={() => void add(product)}
                >
                  <HugeiconsIcon
                    icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                  {added.has(product.id) ? t(`${words}.added`) : t(`${words}.add`)}
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

The sales line editor's "Add items" dialog, moved here (decision 45). `words` names the section of the texts; the
template keys (`` `${words}.pickerTitle` ``) type-check because both sections have the same keys. The service check
is written out (`product.type === 'service'`) instead of importing `isServiceLine` from `lib/sales.ts`, which would
bring the sales helpers into the purchase chunks.

```diff
@@ -1,12 +1,4 @@
-import {
-  Alert02Icon,
-  Delete02Icon,
-  PackageSearchIcon,
-  PlusSignIcon,
-  Search01Icon,
-  Tick02Icon,
-  Wrench01Icon,
-} from '@hugeicons/core-free-icons';
+import { Alert02Icon, Delete02Icon, PlusSignIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   defaultLineDescription,
@@ -14,7 +6,6 @@ import {
   plainQuantity,
   type PriceLookupItem,
   type Product,
-  type ProductSummary,
   routes,
   type SalesLineFormValues,
 } from '@omnivo/contracts';
@@ -24,9 +15,7 @@ import {
   Card,
   cn,
   Dialog,
-  DialogContent,
   DiscountInput,
-  EmptyState,
   IconButton,
   Input,
   MoneyInput,
@@ -34,7 +23,7 @@ import {
   Select,
   toast,
 } from '@omnivo/ui';
-import { useQuery, useQueryClient } from '@tanstack/react-query';
+import { useQuery } from '@tanstack/react-query';
 import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
 import type { FieldErrors } from 'react-hook-form';
 
@@ -42,9 +31,9 @@ import { call } from '../lib/api';
 import { formTotals, isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
 import { basePreview, unitChoices } from '../lib/stock';
 import { taxRateOptions, useRateText } from '../lib/tax-rates';
-import { productQuery, productSearchQuery, taxRatesQuery, unitsQuery } from '../lib/queries';
-import { useDebounced } from '../lib/use-debounced';
+import { taxRatesQuery, unitsQuery } from '../lib/queries';
 import { failureOf, LineError } from './journal-parts';
+import { ProductPicker } from './product-picker';
 import { SalesTotals } from './sales-parts';
 import { useQuantity, useTenantId, useUnitCode, VariantCell } from './stock-parts';
 
@@ -577,113 +566,8 @@ export function LinesEditor<L extends SalesLineFormValues>({
       {lines.length > 0 && <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />}
 
       <Dialog open={picking} onOpenChange={setPicking}>
-        {picking && <SalesItemPicker onAdd={addProduct} maxLines={maxLines} />}
+        {picking && <ProductPicker words="salesLines" onAdd={addProduct} maxLines={maxLines} />}
       </Dialog>
     </Card>
   );
 }
-
-// "Add items": search the products and services, then add one. The dialog stays open, so a long
-// order is put together without closing it; each click adds the product's lines at once.
-function SalesItemPicker({
-  onAdd,
-  maxLines,
-}: {
-  onAdd: (product: Product) => Promise<boolean>;
-  maxLines: number;
-}) {
-  const { t, errorText } = useLocale();
-  const tenantId = useTenantId();
-  const queryClient = useQueryClient();
-  const [search, setSearch] = useState('');
-  const settled = useDebounced(search.trim(), 250);
-  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
-  const [loading, setLoading] = useState<string | null>(null);
-  const [problem, setProblem] = useState<string | null>(null);
-  const { data: products } = useQuery(productSearchQuery(tenantId, settled));
-
-  // The list sends a summary; the variants, the packs and the selling unit come with the product
-  const add = async (summary: ProductSummary) => {
-    setLoading(summary.id);
-    setProblem(null);
-    try {
-      const fits = await onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
-      if (fits) setAdded((before) => new Set(before).add(summary.id));
-      else setProblem(t('salesLines.tooMany', { max: maxLines }));
-    } catch (error) {
-      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
-    } finally {
-      setLoading(null);
-    }
-  };
-
-  return (
-    <DialogContent
-      title={t('salesLines.pickerTitle')}
-      description={t('salesLines.pickerDescription')}
-    >
-      <div className="grid grid-cols-1 gap-4">
-        <Input
-          type="search"
-          icon={Search01Icon}
-          aria-label={t('salesLines.pickerSearch')}
-          placeholder={t('products.searchPlaceholder')}
-          autoFocus
-          value={search}
-          onChange={(event) => {
-            setSearch(event.target.value);
-          }}
-        />
-        {problem !== null && (
-          <p role="status" className="flex items-center gap-1.5 text-label text-crit">
-            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
-            {problem}
-          </p>
-        )}
-        {products?.length === 0 ? (
-          <EmptyState
-            icon={PackageSearchIcon}
-            title={t('salesLines.pickerEmpty')}
-            description={t('salesLines.pickerDescription')}
-          />
-        ) : (
-          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
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
-                {isServiceLine({ productType: product.type }) && (
-                  <Pill tone="neutral" icon={Wrench01Icon}>
-                    {t('salesLines.service')}
-                  </Pill>
-                )}
-                <Button
-                  variant="secondary"
-                  size="sm"
-                  disabled={loading === product.id}
-                  onClick={() => void add(product)}
-                >
-                  <HugeiconsIcon
-                    icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
-                    size={16}
-                    strokeWidth={1.5}
-                  />
-                  {added.has(product.id) ? t('salesLines.added') : t('salesLines.add')}
-                </Button>
-              </li>
-            ))}
-          </ul>
-        )}
-      </div>
-    </DialogContent>
-  );
-}
```

The editor uses the moved picker with `words="salesLines"`, and the imports only the picker needed are gone.

```tsx
import { Alert02Icon, Delete02Icon, PlusSignIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type CostLookupItem,
  defaultLineDescription,
  MAX_PURCHASE_LINES,
  type Product,
  type RequisitionLineFormValues,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, cn, Dialog, IconButton, Input, MoneyInput, Pill, Select } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { call } from '../lib/api';
import {
  type PurchaseLineMeta,
  purchaseItemOf,
  purchaseUnitOf,
  requisitionFormTotals,
} from '../lib/purchase';
import { unitsQuery } from '../lib/queries';
import { basePreview, unitChoices } from '../lib/stock';
import { LineField } from './journal-parts';
import { ProductPicker } from './product-picker';
import { useQuantity, useTenantId, useUnitCode, VariantCell } from './stock-parts';

// The lines of a requisition (step 17a): item, unit, quantity, estimated cost. Like the sales line
// editor, the form holds the lines as one controlled value (a Controller on "lines"), and this
// editor changes that array; 17b's purchase order adds its price, discount and VAT here. A lazy
// chunk of its own: it brings decimal.js with the money box, and the product picker.

export type PurchaseLinesErrors = FieldErrors<{ lines: RequisitionLineFormValues[] }>['lines'];

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `new-${String(lastKey)}`;
}

const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

// One template for the header and every line on a wide card (@3xl = 48rem, like the stock lines):
// item, unit, quantity, estimated cost, amount, remove. Below it, each control shows its label.
const LINE_COLUMNS =
  '@3xl:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_9.5rem_8.5rem_2.25rem] @3xl:items-start @3xl:gap-2';

export function PurchaseLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  errors,
}: {
  lines: RequisitionLineFormValues[];
  onChange: (lines: RequisitionLineFormValues[]) => void;
  // The form's lines right now (react-hook-form's getValues): an add that waited for the cost
  // lookup appends to these, not to the lines of the render that started it
  getLines: () => RequisitionLineFormValues[];
  initialMeta: PurchaseLineMeta[];
  errors: PurchaseLinesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const unitCode = useUnitCode();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const [meta, setMeta] = useState<PurchaseLineMeta[]>(initialMeta);
  const [picking, setPicking] = useState(false);
  // The meta of the last render, for the async handlers (a unit change waits for its cost)
  const metaRef = useRef(meta);
  useEffect(() => {
    metaRef.current = meta;
  });
  const { amounts, total } = requisitionFormTotals(lines);
```

- **The lines are one controlled value,** like the sales editor's: the form's `Controller` hands the array in, and
  the editor hands a new array back. 17b's purchase order adds its price, discount and VAT to this editor.
- **`LINE_COLUMNS` is one grid template** for the header and every line on a wide card (`@3xl`, 48rem). A container
  query, not a screen one: the sidebar takes 244px, so the screen width does not say how wide the card is.
- **`metaRef`** holds the meta of the last render. A unit change waits for its cost; when the answer comes, the
  handler must see the lines as they are then, not as they were when it started.

```tsx
  // The starting cost of some variants in some units. Without inventory.stock.value the server
  // sends no cost (decision 20), and the person types one.
  const lookUp = async (items: { variantId: string; unitId: string }[]) => {
    const answer = await call(routes.purchaseCosts.lookup, { body: { items } });
    return new Map<string, CostLookupItem>(
      answer.items.map((item) => [keyOf(item.variantId, item.unitId), item]),
    );
  };

  // "Add": every active variant of the product, in its buying unit, at the looked-up cost.
  // false = the requisition would hold too many lines; nothing is added.
  const addProduct = async (product: Product): Promise<boolean> => {
    const variants = product.variants.filter((variant) => variant.archivedAt === null);
    if (getLines().length + variants.length > MAX_PURCHASE_LINES) return false;
    const unitId = purchaseUnitOf(product);
    const costs = await lookUp(variants.map((variant) => ({ variantId: variant.id, unitId })));
    // Checked again after the wait: another add may have come in meanwhile
    if (getLines().length + variants.length > MAX_PURCHASE_LINES) return false;
    const added = variants.map((variant) => {
      const found = costs.get(keyOf(variant.id, unitId));
      return {
        line: {
          variantId: variant.id,
          unitId,
          quantity: '',
          description: '',
          // Left empty when nothing is known: the box says to type one
          estimatedCost: found?.cost ?? '',
        },
        meta: {
          key: nextKey(),
          item: purchaseItemOf(product, variant),
          source: found?.source ?? null,
        },
      };
    });
    onChange([...getLines(), ...added.map((entry) => entry.line)]);
    setMeta((before) => [...before, ...added.map((entry) => entry.meta)]);
    return true;
  };

  const remove = (index: number) => {
    onChange(lines.filter((_, at) => at !== index));
    setMeta((before) => before.filter((_, at) => at !== index));
  };

  const update = (index: number, patch: Partial<RequisitionLineFormValues>) => {
    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  };

  // A cost is per unit: a bag of 24 cones costs 24 times a cone. A new unit asks for its cost; when
  // none is known, the typed one stays and the person changes it.
  const changeUnit = async (index: number, unitId: string) => {
    update(index, { unitId });
    const key = meta[index]?.key;
    const variantId = lines[index]?.variantId;
    if (key === undefined || variantId === undefined) return;
    try {
      const found = (await lookUp([{ variantId, unitId }])).get(keyOf(variantId, unitId));
      // The line may have moved (a line above it removed) or gone while we waited
      const at = metaRef.current.findIndex((line) => line.key === key);
      const now = getLines()[at];
      const cost = found?.cost ?? null;
      if (at === -1 || now?.unitId !== unitId || cost === null) return;
      onChange(getLines().map((line, i) => (i === at ? { ...line, estimatedCost: cost } : line)));
      setMeta((before) =>
        before.map((line, i) => (i === at ? { ...line, source: found?.source ?? null } : line)),
      );
    } catch {
      // The typed cost stays; the person can type the new one
    }
  };

  const listError = errors?.root?.message ?? errors?.message;
```

- **`addProduct` checks the line limit twice:** before the cost lookup, and again after it. Two quick clicks on two
  products can both pass the first check while their lookups run.
- **The cost of a new line comes from the cost lookup** (decision 20). Without `inventory.stock.value` it is `null`,
  the box stays empty, and the line says "No cost known: type one".
- **A unit change asks for that unit's cost.** A bag of 24 cones costs 24 times a cone. When nothing is known, the
  typed cost stays. The handler finds its line again by its key, because a line above it may have been removed
  while it waited.

```tsx

  return (
    <Card
      className="@container grid grid-cols-1 overflow-hidden"
      aria-label={t('purchaseLines.items')}
    >
      {lines.length === 0 ? (
        <p className="px-5 py-6 text-body-sm text-ink-2">{t('purchaseLines.noLines')}</p>
      ) : (
        <div
          aria-hidden="true"
          className={cn(
            'hidden bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            LINE_COLUMNS,
          )}
        >
          <span>{t('purchaseLines.item')}</span>
          <span>{t('purchaseLines.unit')}</span>
          <span className="text-right">{t('purchaseLines.quantity')}</span>
          <span className="text-right">{t('purchaseLines.estimatedCost')}</span>
          <span className="text-right">{t('purchaseLines.amount')}</span>
        </div>
      )}
      {lines.map((line, index) => {
        const lineMeta = meta[index];
        if (!lineMeta) return null;
        const { item } = lineMeta;
        const number = index + 1;
        const lineErrors = errors?.[index];
        const id = (field: string) => `lines.${String(index)}.${field}`;
        const preview = basePreview(item, line.unitId, line.quantity, units);
        const amount = amounts[index];
        const removeButton = (
          <IconButton
            icon={Delete02Icon}
            label={t('purchaseLines.remove', { number })}
            onClick={() => {
              remove(index);
            }}
          />
        );
        return (
          <div
            key={lineMeta.key}
            role="group"
            aria-label={t('purchaseLines.line', { number })}
            className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', LINE_COLUMNS)}
          >
            <div className="col-span-2 grid min-w-0 gap-2 @3xl:col-span-1">
              <div className="flex items-start justify-between gap-3">
                <span className="grid min-w-0 gap-1">
                  <VariantCell item={item} />
                  {item.productType === 'service' && (
                    <span>
                      <Pill tone="neutral" icon={Wrench01Icon}>
                        {t('purchaseLines.service')}
                      </Pill>
                    </span>
                  )}
                </span>
                <span className="@3xl:hidden">{removeButton}</span>
              </div>
              <LineField
                id={id('description')}
                label={t('purchaseLines.description')}
                error={lineErrors?.description?.message}
              >
                <Input
                  id={id('description')}
                  autoComplete="off"
                  placeholder={defaultLineDescription(item)}
                  value={line.description ?? ''}
                  invalid={lineErrors?.description !== undefined}
                  onChange={(event) => {
                    update(index, { description: event.target.value });
                  }}
                />
              </LineField>
            </div>
            <LineField
              id={id('unitId')}
              label={t('purchaseLines.unit')}
              error={lineErrors?.unitId?.message}
            >
              <Select
                id={id('unitId')}
                options={unitChoices(item, units)}
                value={line.unitId}
                invalid={lineErrors?.unitId !== undefined}
                onChange={(event) => void changeUnit(index, event.target.value)}
              />
            </LineField>
            <LineField
              id={id('quantity')}
              label={t('purchaseLines.quantity')}
              error={lineErrors?.quantity?.message}
            >
              <Input
                id={id('quantity')}
                inputMode="decimal"
                autoComplete="off"
                align="end"
                value={line.quantity}
                invalid={lineErrors?.quantity !== undefined}
                aria-describedby={lineErrors?.quantity ? `${id('quantity')}-error` : undefined}
                onChange={(event) => {
                  update(index, { quantity: event.target.value });
                }}
              />
              {preview !== null && (
                <span className="text-right text-caption text-ink-3 tabular-nums">
                  {t('stockLines.equals', { quantity: quantityText(preview, item.baseUnitId) })}
                </span>
              )}
            </LineField>
            <LineField
              id={id('estimatedCost')}
              label={t('purchaseLines.costPer', { unit: unitCode(line.unitId) })}
              error={lineErrors?.estimatedCost?.message}
            >
              {/* 4 decimals, like every unit cost (CLAUDE.md → Stock values): an average cost per
                  cone is rarely a round number of paisa */}
              <MoneyInput
                id={id('estimatedCost')}
                scale={4}
                value={line.estimatedCost}
                invalid={lineErrors?.estimatedCost !== undefined}
                aria-describedby={
                  lineErrors?.estimatedCost ? `${id('estimatedCost')}-error` : undefined
                }
                onChange={(value) => {
                  update(index, { estimatedCost: value });
                }}
              />
              {lineMeta.source !== undefined && (
                <span className="text-right text-caption text-ink-3">
                  {lineMeta.source === 'average_cost'
                    ? t('purchaseLines.fromAverage')
                    : t('purchaseLines.noCost')}
                </span>
              )}
            </LineField>
            <div className="grid content-start gap-1.5">
              <span className="text-label font-medium text-ink @3xl:sr-only">
                {t('purchaseLines.amount')}
              </span>
              <span className="py-2.5 text-right text-body-sm font-medium tabular-nums">
                {amount ? format.money(amount, { decimals: 2 }) : '—'}
              </span>
            </div>
            <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
          </div>
        );
      })}
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
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
          {t('purchaseLines.addItems')}
        </Button>
      </div>
      {lines.length > 0 && (
        // The amount that chooses the approval levels (decision 7), to the paisa like the server's
        <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-5 py-3 text-body-sm">
          <span className="grid">
            <span className="font-medium">{t('purchaseLines.total')}</span>
            <span className="text-caption text-ink-3">
              {t('purchaseLines.lineCount', { count: lines.length })}
            </span>
          </span>
          <span className="font-medium tabular-nums">{format.money(total, { decimals: 2 })}</span>
        </div>
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ProductPicker words="purchaseLines" onAdd={addProduct} maxLines={MAX_PURCHASE_LINES} />
        )}
      </Dialog>
    </Card>
  );
}
```

- **Each control's label is hidden on a wide card** (`LineField` makes it `sr-only` at `@3xl`), because the header
  row names the columns; on a narrow card every control shows its label.
- **The cost box has 4 decimals** (`scale={4}`), like every unit cost: an average cost per cone is rarely a round
  number of paisa.
- **"= 48 cones" under the quantity** when the line is in a pack, from the same `basePreview` as the stock lines.
- **The total row is on `subtle`** with the line count: the number that chooses the approval levels, to the paisa.

### Requisitions

```tsx
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';

import { useTenantId } from './stock-parts';

// Shared by the purchase documents' pages (step 17a). Here, not in a route file: a route file is
// its own lazy chunk, and importing from one would pull that whole page into the others.

// After a save or a decision: everything under ['purchase', tenant] — the requisitions, their
// list, the "waiting for me" list and the navigation's count. An approval moves all of them at
// once. One hook for every purchase document, so none forgets one.
export function usePurchaseRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['purchase', tenantId] });
  }, [queryClient, tenantId]);
}

export function PurchaseBackLink({
  to,
  label,
}: {
  to: '/requisitions' | '/approvals';
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

`usePurchaseRefresh` refreshes everything under `['purchase', tenant]` (decision 38): the requisition, the lists,
the waiting list and the navigation's count all move when a requisition is approved.

```tsx
import {
  ArrowTurnBackwardIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  FileEditIcon,
  MinusSignCircleIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { ApprovalRoundStatus, RequisitionStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill, type PillTone } from '@omnivo/ui';

import type { StepState } from '../lib/purchase';

// The status pills of the purchase documents (step 17a), a file of their own like sales-pills.tsx:
// a list page needs these, not the approval card. Never colour alone: each pill has its icon and
// its words. Waiting is work in progress, so brand, not warn (CLAUDE.md → Sales document statuses).

const REQUISITION_PILLS = {
  draft: { tone: 'neutral', icon: FileEditIcon },
  pending: { tone: 'brand', icon: Clock01Icon },
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<RequisitionStatus, { tone: PillTone; icon: IconSvgElement }>;

export function RequisitionStatusPill({ status }: { status: RequisitionStatus }) {
  const { t } = useLocale();
  const { tone, icon } = REQUISITION_PILLS[status];
  return (
    <Pill tone={tone} icon={icon}>
      {t(`requisitions.statuses.${status}`)}
    </Pill>
  );
}

// A round of an approval. Rejected is warn: the person who wrote the document must change it and
// submit it again. Reopened is neutral: its writer took it back on purpose.
const ROUND_PILLS = {
  pending: { tone: 'brand', icon: Clock01Icon },
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
  rejected: { tone: 'warn', icon: ArrowTurnBackwardIcon },
  reopened: { tone: 'neutral', icon: Undo02Icon },
} as const satisfies Record<ApprovalRoundStatus, { tone: PillTone; icon: IconSvgElement }>;

export function RoundStatusPill({ status }: { status: ApprovalRoundStatus }) {
  const { t } = useLocale();
  const { tone, icon } = ROUND_PILLS[status];
  return (
    <Pill tone={tone} icon={icon}>
      {t(`approvals.rounds.${status}`)}
    </Pill>
  );
}

// A step of a round: approved, sent back, waiting now, or not reached (neutral, with a minus: no
// decision was made)
const STEP_PILLS = {
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
  rejected: { tone: 'warn', icon: ArrowTurnBackwardIcon },
  waiting: { tone: 'brand', icon: Clock01Icon },
  notYet: { tone: 'neutral', icon: MinusSignCircleIcon },
  notDecided: { tone: 'neutral', icon: MinusSignCircleIcon },
} as const satisfies Record<StepState, { tone: PillTone; icon: IconSvgElement }>;

export function StepStatePill({ state }: { state: StepState }) {
  const { t } = useLocale();
  const { tone, icon } = STEP_PILLS[state];
  return (
    <Pill tone={tone} icon={icon}>
      {t(`approvals.steps.${state}`)}
    </Pill>
  );
}
```

The status pills of decision 42. Each map is `satisfies Record<Status, { tone; icon }>`: a new status (17b's
"ordered") does not compile until it has its pill. A file of its own, like `sales-pills.tsx`: the list page needs
the pills, not the approval card.

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Requisition,
  type RequisitionFormValues,
  routes,
  updateRequisitionInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  DatePicker,
  FormAlert,
  FormField,
  PageHeader,
  SelectField,
  TextAreaField,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import {
  type PurchaseLineMeta,
  REQUISITION_LINE_FIELDS,
  savedRequisitionLines,
} from '../lib/purchase';
import { requisitionQuery } from '../lib/queries';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The requisition form (step 17a): its own chunk (loaded by routes/requisition.tsx), because the
// form library and the date picker are only needed to write.

// The line editor as a chunk of its own, loaded as the form opens: it brings decimal.js with its
// money box, and the product picker
const PurchaseLinesEditor = lazy(async () => ({
  default: (await import('./purchase-lines-editor')).PurchaseLinesEditor,
}));

// The server's field names for the errors it can send: one set per line
function fieldNames(lineCount: number): Path<RequisitionFormValues>[] {
  return [
    'date',
    'warehouseId',
    'neededBy',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      REQUISITION_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}

// Writing a new requisition, or changing a draft. It gets its number on the first save
// (decision 19), and is submitted for approval from its page.
export function RequisitionForm({
  requisition,
  today,
  onClose,
}: {
  requisition: Requisition | null;
  today: string;
  // Back to the requisition's page (an edit); a new requisition goes to its page instead
  onClose?: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const { active, byId } = useWarehouses();
  const [start] = useState(() =>
    requisition
      ? savedRequisitionLines(requisition.lines)
      : { values: [], meta: [] as PurchaseLineMeta[] },
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateRequisitionInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: requisition?.date ?? today,
      warehouseId: requisition?.warehouseId ?? '',
      neededBy: requisition?.neededBy ?? '',
      note: requisition?.note ?? '',
      lines: start.values,
      // A new requisition has no version; 1 passes the schema, and the create route never reads it
      version: requisition?.version ?? 1,
    },
  });

  // The active warehouses, and the requisition's own if it was archived since: the server keeps
  // it on a save (17a.4), so the select must not drop it
  const own = requisition ? byId.get(requisition.warehouseId) : undefined;
  const warehouses = [...(active ?? []), ...(own && own.archivedAt !== null ? [own] : [])];

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = requisition
        ? await call(routes.requisitions.update, {
            params: { id: requisition.id },
            body: { ...values, version },
          })
        : await call(routes.requisitions.create, { body: values });
      queryClient.setQueryData(requisitionQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(t('requisitions.saved', { number: saved.number }));
      if (requisition) onClose?.();
      else {
        void navigate({
          to: '/requisitions/$requisitionId',
          params: { requisitionId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(getValues('lines').length), setError);
    }
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
      <PageHeader
        title={requisition ? requisition.number : t('requisitions.newTitle')}
        description={t('requisitions.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[13rem_minmax(0,1fr)_13rem]">
          <FormField control={control} name="date" label={t('requisitions.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <SelectField
            label={t('requisitions.warehouse')}
            hint={t('requisitions.warehouseHint')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...warehouses.map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <FormField
            control={control}
            name="neededBy"
            label={t('requisitions.neededBy')}
            optional
            hint={t('requisitions.neededByHint')}
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextAreaField
              label={t('requisitions.note')}
              optional
              placeholder={t('requisitions.notePlaceholder')}
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
              <PurchaseLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {onClose && (
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('requisitions.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
```

- **The line editor is a lazy chunk,** loaded as the form opens, like the quotation form's: it brings decimal.js with
  the money box, and the product picker. The form's date and warehouse boxes show while it arrives.
- **The warehouse select keeps the requisition's own warehouse** when it was archived since. The server keeps it on
  a save (17a.4), so the select must not drop it, or saving the draft would change its warehouse.
- **The saved requisition goes into the cache before the refresh,** so the page that opens next shows it at once.
- **A new requisition opens its page with `replace`:** Back from there goes to the list, not to an empty form.

```diff
@@ -6,7 +6,7 @@ import {
   PlusSignIcon,
   Tick02Icon,
 } from '@hugeicons/core-free-icons';
-import { HugeiconsIcon } from '@hugeicons/react';
+import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
 import {
   type CustomerAddress,
   type DocumentTotals,
@@ -126,12 +126,15 @@ export function addressLabel(address: CustomerAddress): string {
 // A notice above a document: what its state means and what to do next. Icon plus words, never
 // colour alone; warn for an offer that has ended (step 15c: or an invoice past its due date),
 // neutral otherwise. Here since 15c, not in quotation-view.tsx: the invoice and receipt pages use it
-// too, and importing it from there would pull the quotation page into their chunks.
+// too, and importing it from there would pull the quotation page into their chunks. Step 17a: a
+// notice may bring its own icon (a requisition sent back is not an hourglass).
 export function DocumentNotice({
   tone,
+  icon,
   children,
 }: {
   tone: 'warn' | 'neutral';
+  icon?: IconSvgElement;
   children: ReactNode;
 }) {
   return (
@@ -143,7 +146,7 @@ export function DocumentNotice({
       }
     >
       <HugeiconsIcon
-        icon={tone === 'warn' ? HourglassIcon : InformationCircleIcon}
+        icon={icon ?? (tone === 'warn' ? HourglassIcon : InformationCircleIcon)}
         size={17}
         strokeWidth={1.5}
         className="mt-px shrink-0"
```

`DocumentNotice` takes an optional `icon`. A requisition sent back is a `warn` notice, but an hourglass would say
"time is running out", which is not what happened. The sales documents pass no icon and look as before.

```tsx
import {
  ArrowTurnBackwardIcon,
  Delete02Icon,
  PencilEdit02Icon,
  SentIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { defaultLineDescription, type Requisition, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { requisitionQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { Fact } from './adjustment-view';
import { ApprovalCard } from './approval-card';
import { failureOf } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { RequisitionStatusPill } from './purchase-pills';
import { DocumentNotice } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// What the view asks before it acts: both change who may do what next, so neither is one click
type Asking = 'reopen' | 'cancel';

// The lines as they were saved: a real <table> in a card, scrolling inside its own box on a phone
function LinesTable({ requisition }: { requisition: Requisition }) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-body-sm">
          <caption className="sr-only">{t('purchaseLines.items')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('purchaseLines.item')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('purchaseLines.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('purchaseLines.estimatedCost')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('purchaseLines.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {requisition.lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <span className="grid max-w-[24rem] min-w-0 gap-1">
                    <span className="font-medium text-ink">{line.description}</span>
                    {/* The product too, when the line says something else ("Grey, for samples") */}
                    <span className="truncate text-caption text-ink-3">
                      {line.description !== defaultLineDescription(line) &&
                        `${variantName(line)} · `}
                      <span className="font-mono">{line.sku}</span>
                    </span>
                    {line.productType === 'service' && (
                      <span>
                        <Pill tone="neutral" icon={Wrench01Icon}>
                          {t('purchaseLines.service')}
                        </Pill>
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
                {/* Stored with 4 decimals, shown with 2 (CLAUDE.md → Stock values) */}
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {money(line.estimatedCost)}
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {money(line.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-5 py-3 text-body-sm">
        <span className="font-medium">{t('purchaseLines.total')}</span>
        <span className="font-medium tabular-nums">{money(requisition.amount)}</span>
      </div>
    </Card>
  );
}
```

The lines as they were saved, in a real `<table>` inside the card, scrolling sideways in its own box on a phone. The
description shows first; the product's name follows only when the description says something else. The cost is
stored with 4 decimals and shown with 2.

```tsx
// A requisition as it was saved (step 17a), with its approval and what can be done next. A draft
// is changed with Edit, then submitted; a pending or approved one is reopened first (decision 6).
export function RequisitionView({
  requisition,
  onEdit,
}: {
  requisition: Requisition;
  onEdit: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const refresh = usePurchaseRefresh();
  const { byId } = useWarehouses();
  const canWrite = useCan()('purchase.requisition.manage');
  const [asking, setAsking] = useState<Asking | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { id, number, status, version, approval } = requisition;
  const [round] = approval.rounds;
  // Never submitted: it may be deleted. Once a round exists, its history stays (decision 19).
  const neverSubmitted = approval.rounds.length === 0;
  // The step that sent it back, when the newest round was rejected: its comment says what to change
  const rejection =
    status === 'draft' && round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;

  // The answer of every action is the requisition itself: straight into its cache, then the
  // lists and the count
  const settle = async (saved: Requisition) => {
    queryClient.setQueryData(requisitionQuery(tenantId, saved.id).queryKey, saved);
    await refresh();
  };

  const submit = useMutation({
    mutationFn: () => call(routes.requisitions.submit, { params: { id }, body: { version } }),
    onSuccess: async (saved) => {
      await settle(saved);
      // No level applied, or an Owner submitted it: approved in the same step (decisions 13, 14)
      toast(
        t(
          saved.status === 'approved' ? 'requisitions.submittedApproved' : 'requisitions.submitted',
          { number },
        ),
      );
    },
  });
  const act = useMutation({
    mutationFn: (action: Asking) =>
      call(routes.requisitions[action], { params: { id }, body: { version } }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      await settle(saved);
      toast(
        t(action === 'reopen' ? 'requisitions.reopened' : 'requisitions.cancelled', { number }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => call(routes.requisitions.remove, { params: { id }, query: { version } }),
    onSuccess: async () => {
      // To the list first: the deleted requisition's own query would otherwise refetch into a 404
      await navigate({ to: '/requisitions' });
      queryClient.removeQueries({ queryKey: requisitionQuery(tenantId, id).queryKey });
      await refresh();
      toast(t('requisitions.deleted', { number }));
    },
  });
  // purchase_not_draft, purchase_was_submitted, purchase_cannot_*, version_conflict
  const failure = failureOf(submit.error) ?? failureOf(remove.error);
  const busy = submit.isPending || remove.isPending || act.isPending;
```

- **`neverSubmitted`:** a requisition without a round may be deleted; once it was submitted, its history stays and
  it is cancelled instead (decision 19). The page shows the button the API will accept.
- **`rejection`** is the step that sent the newest round back, for the notice with its comment (decision 43). Only
  while the requisition is a draft: once it is submitted again, the old comment is history.
- **`settle` puts the answer in the cache, then refreshes.** Submit, reopen and cancel all answer with the whole
  requisition, so the page changes at once.
- **The submit toast reads the answer's status.** With no level, or an Owner submitting, the requisition comes back
  approved (decisions 13 and 14), and "sent for approval" would be untrue.

```tsx

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
      <PageHeader
        title={number}
        description={warehouseLabel(byId.get(requisition.warehouseId))}
        actions={<RequisitionStatusPill status={status} />}
      />
      {failure && <FormAlert message={failure} />}
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('requisitions.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {status !== 'draft' && (
        <DocumentNotice tone="neutral">{t(`requisitions.notices.${status}`)}</DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-4">
        <Fact label={t('requisitions.date')} value={isoDate(requisition.date)} />
        <Fact
          label={t('requisitions.neededBy')}
          value={
            requisition.neededBy === null ? t('requisitions.noDate') : isoDate(requisition.neededBy)
          }
        />
        <Fact
          label={t('requisitions.warehouse')}
          value={warehouseLabel(byId.get(requisition.warehouseId))}
        />
        <Fact label={t('requisitions.requestedBy')} value={requisition.requestedBy.name} />
        {requisition.note !== null && (
          <div className="sm:col-span-4">
            <Fact label={t('requisitions.note')} value={requisition.note} />
          </div>
        )}
      </Card>
      <LinesTable requisition={requisition} />
      <ApprovalCard
        document="requisition"
        id={id}
        number={number}
        amount={requisition.amount}
        draft={status === 'draft'}
        approval={approval}
      />

      {canWrite && status === 'draft' && (
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Left, away from the rest */}
            <div className="mr-auto flex flex-wrap items-center gap-2">
              {neverSubmitted ? (
                // Two clicks: a deleted requisition cannot come back
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (confirmingDelete) remove.mutate();
                    else setConfirmingDelete(true);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                  {confirmingDelete
                    ? t('requisitions.confirmDelete', { number })
                    : t('requisitions.delete')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setAsking('cancel');
                  }}
                >
                  {t('requisitions.cancel')}
                </Button>
              )}
              {confirmingDelete && (
                <span className="text-body-sm text-ink-2">{t('requisitions.deleteWarning')}</span>
              )}
            </div>
            <Button variant="secondary" disabled={busy} onClick={onEdit}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
              {t('requisitions.edit')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                submit.mutate();
              }}
            >
              <HugeiconsIcon icon={SentIcon} size={17} strokeWidth={1.5} />
              {t('requisitions.submit')}
            </Button>
          </div>
          <p className="text-right text-label text-ink-3">{t('requisitions.submitHint')}</p>
        </div>
      )}
      {canWrite && (status === 'pending' || status === 'approved') && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* A pending requisition is reopened first; an approved one may be cancelled at once */}
          {status === 'approved' && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={busy}
              onClick={() => {
                setAsking('cancel');
              }}
            >
              {t('requisitions.cancel')}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setAsking('reopen');
            }}
          >
            {t('requisitions.reopen')}
          </Button>
        </div>
      )}

      <Dialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
      >
        {asking !== null && (
          <DialogContent
            title={t(`requisitions.${asking}Title`, { number })}
            description={t(`requisitions.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'cancel' ? t('requisitions.keep') : t('common.cancel')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`requisitions.${asking}`)}
                </Button>
              </>
            }
          >
            {failureOf(act.error) && <FormAlert message={failureOf(act.error) ?? ''} />}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
```

- **A draft shows Delete (or Cancel), Edit and "Submit for approval"** (decision 41), with the submit hint below:
  nobody can change it while it waits.
- **Pending and approved show Reopen;** an approved one shows Cancel as well. A pending one is reopened first, which
  the API demands (`purchase_cannot_cancel`).
- **Reopen and Cancel ask first** in a dialog: both change what others may do next. For a cancel, the button that
  closes the dialog says "Keep it", so the two buttons are not "Cancel" and "Cancel requisition".

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { requisitionQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// quotation's pattern): reading a requisition needs neither the form library nor the line editor.
const RequisitionForm = lazy(async () => ({
  default: (await import('../components/requisition-form')).RequisitionForm,
}));
const RequisitionView = lazy(async () => ({
  default: (await import('../components/requisition-view')).RequisitionView,
}));

// What every requisition page needs before it draws: the units (a line's quantity) and the
// warehouses (the select, and the name of an archived one)
function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

export function NewRequisitionPage() {
  const { t } = useLocale();
  const canWrite = useCan()('purchase.requisition.manage');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
        <p className="text-body-sm text-ink-3">{t('requisitions.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <RequisitionForm requisition={null} today={today} />
    </Suspense>
  );
}

export function RequisitionPage() {
  const { t } = useLocale();
  const { requisitionId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.requisition.manage');
  const today = useToday();
  const ready = useReady();
  // A draft is shown as it was saved, with Submit; "Edit" turns the page into the form until it is
  // saved
  const [editing, setEditing] = useState(false);
  const { data: requisition, isError } = useQuery({
    ...requisitionQuery(useTenantId(), requisitionId),
    enabled: requisitionId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('requisitions.title')}
          description={t('requisitions.notFound')}
        />
      </div>
    );
  }
  if (!requisition || !ready) return null;
  // Only a draft is changed: one submitted or approved meanwhile (by this person elsewhere) shows
  // as it is now
  if (editing && canWrite && requisition.status === 'draft') {
    return (
      <Suspense fallback={null}>
        <RequisitionForm
          key={`${requisition.id}-${String(requisition.version)}`}
          requisition={requisition}
          today={today}
          onClose={() => {
            setEditing(false);
          }}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <RequisitionView
        requisition={requisition}
        onEdit={() => {
          setEditing(true);
        }}
      />
    </Suspense>
  );
}
```

The page only loads the data and picks the form or the view, each a lazy chunk, like the quotation's page. Edit
shows the form only while the requisition is a draft: if it was submitted meanwhile (from another tab), the page
shows it as it is now.

```tsx
import { PlusSignIcon, TaskAdd01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  REQUISITION_STATUSES,
  type RequisitionStatus,
  type RequisitionSummary,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
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

import { RequisitionStatusPill } from '../components/purchase-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { requisitionsQuery } from '../lib/queries';

const column = dataTableColumns<RequisitionSummary>();

type Show = RequisitionStatus | 'all';

// The purchase requisitions (step 17a), newest date first. Everyone reads them (a store keeper
// checks whether the yarn was asked for already); writing them needs purchase.requisition.manage.
export function RequisitionsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.requisition.manage');
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const [warehouseId, setWarehouseId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    requisitionsQuery(useTenantId(), { status: show === 'all' ? '' : show, warehouseId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('requisitions.columns.number'),
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
        column.accessor('warehouseId', {
          header: t('requisitions.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('neededBy', {
          header: t('requisitions.columns.neededBy'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = getValue();
            return date === null ? '—' : <span className="tabular-nums">{isoDate(date)}</span>;
          },
        }),
        column.accessor((row) => row.requestedBy.name, {
          id: 'requestedBy',
          header: t('requisitions.columns.requestedBy'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        // Whole taka, like every list (CLAUDE.md → Money); the page shows the paisa
        column.accessor('amount', {
          header: t('requisitions.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('requisitions.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <RequisitionStatusPill status={getValue()} />,
        }),
      ]),
    [t, format, isoDate, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('requisitions.title')}
        description={t('requisitions.description')}
        actions={
          canWrite && (
            <Button onClick={() => void navigate({ to: '/requisitions/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('requisitions.new')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('requisitions.warehouse')}
            options={[
              { value: '', label: t('requisitions.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('requisitions.show')}
          value={show}
          options={[
            { value: 'all', label: t('requisitions.all') },
            ...REQUISITION_STATUSES.map((value) => ({
              value,
              label: t(`requisitions.statuses.${value}`),
            })),
          ]}
          onChange={setShow}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('requisitions.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('requisitions.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({
              to: '/requisitions/$requisitionId',
              params: { requisitionId: row.id },
            })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={TaskAdd01Icon}
              title={t('requisitions.emptyTitle')}
              description={t('requisitions.emptyBody')}
              action={
                canWrite && (
                  <Button onClick={() => void navigate({ to: '/requisitions/new' })}>
                    <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                    {t('requisitions.new')}
                  </Button>
                )
              }
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

The list, newest date first, with a warehouse filter and the statuses. Amounts in whole taka, like every list; the
page shows the paisa.

### Approvals

```tsx
import { ArrowTurnBackwardIcon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalStep,
  DEFAULT_SETTINGS,
  type DocumentApproval,
  levelsFor,
  waitingStep,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Dialog } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';

import { approvedByOwnSubmit, roundNumber, stepState } from '../lib/purchase';
import { approvalRulesQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { RoundStatusPill, StepStatePill } from './purchase-pills';

// The approve and reject dialogs as a chunk of their own: they bring the form library, which a
// person who only reads the document never needs
const DecisionDialog = lazy(async () => ({
  default: (await import('./approval-dialogs')).DecisionDialog,
}));

// "Purchase manager", or "Director (a deleted role)" when the role was deleted after the document
// was submitted: the step kept its name (decision 25)
function useRoleName(): (step: ApprovalStep) => string {
  const { t } = useLocale();
  return (step) =>
    step.role.id === null ? t('approvals.deletedRole', { name: step.role.name }) : step.role.name;
}

function Round({
  round,
  number,
  timeZone,
}: {
  round: ApprovalRound;
  number: number;
  timeZone: string;
}) {
  const { t, format } = useLocale();
  const roleName = useRoleName();
  const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm font-medium">{t('approvals.round', { number })}</span>
        <RoundStatusPill status={round.status} />
      </div>
      <p className="text-label text-ink-3">
        {t('approvals.submitted', {
          name: round.submittedBy.name,
          date: when(round.submittedAt),
          amount: format.money(round.amount),
        })}
      </p>
      {round.steps.length === 0 ? (
        // No level applied to its amount: approved at once (decision 13)
        <p className="text-body-sm text-ink-2">{t('approvals.noLevels')}</p>
      ) : (
        <ol className="grid grid-cols-1 rounded-control border border-line">
          {round.steps.map((step) => (
            <li
              key={step.position}
              className="grid grid-cols-1 gap-1 border-t border-line px-4 py-3 first:border-t-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-sm text-ink">
                  {t('approvals.levelLine', {
                    role: roleName(step),
                    amount: format.money(step.minAmount),
                  })}
                </span>
                <StepStatePill state={stepState(round, step)} />
              </div>
              {step.decidedBy !== null && step.decidedAt !== null && (
                <span className="text-caption text-ink-3 tabular-nums">
                  {t('approvals.decided', {
                    name: step.decidedBy.name,
                    date: when(step.decidedAt),
                  })}
                </span>
              )}
              {/* A rejection always says why (decision 15); an approval may add a note */}
              {step.comment !== null && <q className="text-body-sm text-ink-2">{step.comment}</q>}
            </li>
          ))}
        </ol>
      )}
      {approvedByOwnSubmit(round) && (
        <p className="text-body-sm text-ink-2">{t('approvals.ownerSubmitted')}</p>
      )}
    </div>
  );
}

// A document's approval, for any kind (decision 30): every round it went through, newest first,
```

- **The decision dialogs are a lazy chunk.** They bring the form library, which a person who only reads the
  requisition never needs.
- **`useRoleName`:** a step whose role was deleted later keeps the role's name (decision 25), and says the role is
  gone, so nobody looks for it in Team → Roles.
- **A round shows who submitted it, when and for how much,** then its steps: each with its level, its state, who
  decided and when, and the comment. The comment is in a `<q>`: it is the person's own words.
- **A round with no steps was approved at once** (no level applied), and says so.

```tsx
// what waits now, and Approve and Reject for the person who may decide the waiting step. A draft
// also lists the levels its amount reaches today (decision 13 copies them when it is submitted).
export function ApprovalCard({
  document,
  id,
  number,
  amount,
  draft,
  approval,
}: {
  document: ApprovalDocument;
  id: string;
  number: string;
  // The document's amount now (a draft's next round would start from it)
  amount: string;
  draft: boolean;
  approval: DocumentApproval;
}) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const meId = useSession((state) => state.me?.user.id);
  const roleName = useRoleName();
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const rules = useQuery({ ...approvalRulesQuery(tenantId), enabled: draft }).data;
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [current, ...earlier] = approval.rounds;
  const waiting = current ? waitingStep(current) : null;
  // The levels a draft would need if it were submitted now
  const preview = draft
    ? levelsFor(rules?.find((rule) => rule.document === document)?.levels ?? [], amount)
    : [];

  return (
    <Card>
      <CardHeader title={t('approvals.cardTitle')} subtitle={t('approvals.cardSubtitle')} />
      <div className="grid grid-cols-1 gap-5 p-5">
        {draft && (
          <div className="grid grid-cols-1 gap-2">
            <p className="text-body-sm text-ink-2">{t('approvals.notSubmitted')}</p>
            {preview.length > 0 && (
              <ol className="grid list-decimal grid-cols-1 gap-1 pl-5 text-body-sm text-ink">
                {preview.map((level) => (
                  <li key={level.role.id}>
                    {t('approvals.levelLine', {
                      role: level.role.name,
                      amount: format.money(level.minAmount),
                    })}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {current && (
          <Round round={current} number={roundNumber(approval.rounds, 0)} timeZone={timeZone} />
        )}
        {current && waiting && (
          <div className="grid grid-cols-1 gap-3 rounded-control bg-subtle px-4 py-3">
            <p className="text-body-sm text-ink-2">
              {approval.canDecide
                ? t('approvals.waitingForYou', { position: waiting.position })
                : current.submittedBy.id === meId
                  ? t('approvals.ownDocument')
                  : t('approvals.waitingFor', { role: roleName(waiting) })}
            </p>
            {approval.canDecide && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setDeciding('approve');
                  }}
                >
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} strokeWidth={1.5} />
                  {t('approvals.approve')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDeciding('reject');
                  }}
                >
                  <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={16} strokeWidth={1.5} />
                  {t('approvals.reject')}
                </Button>
              </div>
            )}
          </div>
        )}
        {earlier.length > 0 && (
          // Folded: the round now is what a person came for; the history is one click away
          <details className="grid grid-cols-1 gap-4 border-t border-line pt-4">
            <summary className="text-label font-medium text-brand underline-offset-3 hover:underline">
              {t('approvals.earlierRounds')}
            </summary>
            <div className="mt-4 grid grid-cols-1 gap-5">
              {earlier.map((round, index) => (
                <Round
                  key={round.id}
                  round={round}
                  number={roundNumber(approval.rounds, index + 1)}
                  timeZone={timeZone}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      <Dialog
        open={deciding !== null}
        onOpenChange={(open) => {
          if (!open) setDeciding(null);
        }}
      >
        {deciding !== null && current && waiting && (
          <Suspense fallback={null}>
            <DecisionDialog
              decision={deciding}
              document={document}
              id={id}
              number={number}
              round={current}
              step={waiting}
              roleName={roleName(waiting)}
              onDone={() => {
                setDeciding(null);
              }}
            />
          </Suspense>
        )}
      </Dialog>
    </Card>
  );
}
```

- **A draft lists the levels its amount reaches today** (decision 13 copies them when it is submitted), from the same
  `levelsFor` the server uses. The rules are fetched only for a draft.
- **The waiting step's line has three versions:** "Step 2 waits for you" with Approve and Reject when the server
  says `canDecide`; "You submitted it" for the writer; "Waiting for Purchase manager" for everyone else. The page
  never works out who may decide; the server does (decision 29).
- **Earlier rounds are folded in a `<details>`.** The round now is what a person came for; the history is one click
  away, and the browser does the opening and closing.
- **The dialog gets the round and the step the card showed.** If the requisition was reopened and submitted again
  meanwhile, the server refuses with `approval_not_pending` (decision 16).

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalStep,
  approveInputSchema,
  contractErrorMap,
  rejectInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogClose, DialogContent, FormAlert, TextAreaField, toast } from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { usePurchaseRefresh } from './purchase-parts';

// Approve and Reject (step 17a), a lazy chunk of its own (approval-card.tsx says why). One dialog
// for every kind of document: the path names the kind, the body the round the card showed
// (decision 16). If the document was reopened and submitted again meanwhile, the server answers
// approval_not_pending, and the person reads the new round before deciding.

interface DecisionProps {
  document: ApprovalDocument;
  id: string;
  number: string;
  round: ApprovalRound;
  // The step waiting now: the one this person decides
  step: ApprovalStep;
  roleName: string;
  onDone: () => void;
}

// The errors that belong to no box: approval_not_pending, approval_not_allowed,
// approval_own_document, a role taken away since the page loaded
const FIELD_NAMES = ['comment'] as const;

function ApproveForm({ document, id, number, round, step, roleName, onDone }: DecisionProps) {
  const { t } = useLocale();
  const refresh = usePurchaseRefresh();
  const last = step.position === round.steps.length;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(approveInputSchema, { error: contractErrorMap }),
    defaultValues: { roundId: round.id, comment: '' },
  });

  const onSubmit = handleSubmit(async (body) => {
    try {
      await call(routes.approvals.approve, { params: { document, id }, body });
      await refresh();
      toast(t('approvals.approvedToast', { number }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={t('approvals.approveTitle', { number })}
      description={t('approvals.approveBody', {
        position: step.position,
        count: round.steps.length,
        role: roleName,
      })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="approve-form" disabled={isSubmitting}>
            {t('approvals.confirmApprove')}
          </Button>
        </>
      }
    >
      <form
        id="approve-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* Whether this click finishes the approval or passes it to the next level */}
        <p className="text-body-sm text-ink-2">
          {last ? t('approvals.approveLast', { number }) : t('approvals.approveNext')}
        </p>
        <TextAreaField
          label={t('approvals.comment')}
          optional
          placeholder={t('approvals.approveCommentPlaceholder')}
          {...register('comment')}
          error={errors.comment?.message}
        />
      </form>
    </DialogContent>
  );
}

function RejectForm({ document, id, number, round, onDone }: DecisionProps) {
  const { t } = useLocale();
  const refresh = usePurchaseRefresh();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(rejectInputSchema, { error: contractErrorMap }),
    defaultValues: { roundId: round.id, comment: '' },
  });

  const onSubmit = handleSubmit(async (body) => {
    try {
      await call(routes.approvals.reject, { params: { document, id }, body });
      await refresh();
      toast(t('approvals.rejectedToast', { number }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={t('approvals.rejectTitle', { number })}
      description={t('approvals.rejectBody', { name: round.submittedBy.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="reject-form" disabled={isSubmitting}>
            {t('approvals.confirmReject')}
          </Button>
        </>
      }
    >
      <form
        id="reject-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* Required: the writer must know what to change (decision 15) */}
        <TextAreaField
          label={t('approvals.rejectComment')}
          placeholder={t('approvals.rejectCommentPlaceholder')}
          {...register('comment')}
          error={errors.comment?.message}
        />
      </form>
    </DialogContent>
  );
}

export function DecisionDialog({
  decision,
  ...props
}: DecisionProps & { decision: 'approve' | 'reject' }) {
  return decision === 'approve' ? <ApproveForm {...props} /> : <RejectForm {...props} />;
}
```

- **One dialog for every kind of document:** the path names the kind, the body the round.
- **Approve says whether this click finishes the approval** (the last step) or passes it on, and its comment is
  optional. **Reject's comment is required** (decision 15): the writer must know what to change.
- **Errors that belong to no box** (`approval_not_pending`, `approval_not_allowed`, a role taken away since the page
  loaded) show at the top of the dialog; `applyApiError` puts them there because they name no field.

```tsx
import { CheckmarkBadge01Icon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, isApprovalDocument, type WaitingApproval } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useIsoDate, useTenantId } from '../components/stock-parts';
import { settingsQuery, waitingApprovalsQuery } from '../lib/queries';

const column = dataTableColumns<WaitingApproval>();

// "Waiting for me" (step 17a, decision 17): the documents whose waiting step the signed-in person
// may decide, oldest first, so nothing is left at the bottom. A row opens the document: a person
// approves what they have read, on its own page (decision 16), never from a list.
export function ApprovalsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    waitingApprovalsQuery(tenantId),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // One navigate() per kind: each path has its own parameter name, and TanStack checks each pair
  // against the router. 17b adds the purchase order here.
  const open = useCallback(
    (row: WaitingApproval) => {
      if (row.document === 'requisition') {
        void navigate({ to: '/requisitions/$requisitionId', params: { requisitionId: row.id } });
      }
    },
    [navigate],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('approvals.columns.document'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => {
            const { document, number } = row.original;
            return (
              <span className="grid">
                <span className="font-mono font-medium tabular-nums">{number}</span>
                {/* A kind a newer server knows and this app does not keeps its key */}
                <span className="text-caption text-ink-3">
                  {isApprovalDocument(document) ? t(`approvals.kinds.${document}`) : document}
                </span>
              </span>
            );
          },
        }),
        column.accessor('date', {
          header: t('approvals.columns.date'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="tabular-nums">{isoDate(getValue())}</span>,
        }),
        column.accessor('subject', {
          header: t('approvals.columns.subject'),
          enableSorting: false,
          meta: { card: 'subtitle' },
        }),
        column.accessor((row) => row.submittedBy.name, {
          id: 'submittedBy',
          header: t('approvals.columns.submittedBy'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid">
              <span>{row.original.submittedBy.name}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {format.dateTime(new Date(row.original.submittedAt), timeZone)}
              </span>
            </span>
          ),
        }),
        column.accessor('amount', {
          header: t('approvals.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('position', {
          header: t('approvals.columns.step'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) => (
            <span className="tabular-nums">
              {t('approvals.stepOf', {
                position: row.original.position,
                count: row.original.stepCount,
              })}
            </span>
          ),
        }),
      ]),
    [t, format, isoDate, timeZone],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('approvals.title')} description={t('approvals.description')} />
      {isError && <p className="text-body-sm text-crit">{t('approvals.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('approvals.title')}
          data={rows}
          columns={columns}
          // A round waits once per document: the round is the row
          getRowId={(row) => row.roundId}
          onRowClick={open}
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={CheckmarkBadge01Icon}
              title={t('approvals.emptyTitle')}
              description={t('approvals.emptyBody')}
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

"Waiting for me", oldest first. A row opens the document (decision 44). The row's id is the round, not the
document: when a requisition is reopened and submitted again, its new round is a new row, and the table does not
mix it up with the row it had before.

### The bell, the navigation and the router

```diff
@@ -2,6 +2,7 @@ import { Notification03Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   DEFAULT_SETTINGS,
+  isApprovalDocument,
   isExportFormat,
   isNotificationType,
   isOutputDocument,
@@ -21,9 +22,22 @@ import { call } from '../lib/api';
 import { notificationsQuery, settingsQuery, unreadCountQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
-// Where a click on each kind of notification takes you. satisfies: a new type without a page does
-// not compile, and the values are checked against the router's real paths by navigate() below.
-// Step 16: a failed email opens its own document, so that type is not here (useOpen below).
+// The notifications that open their own document (useOpenDocument below): step 16's failed email,
+// and step 17a's approvals (a requisition waiting for you, yours approved or sent back)
+const DOCUMENT_TYPES = [
+  'document.email_failed',
+  'approval.requested',
+  'approval.approved',
+  'approval.rejected',
+] as const satisfies readonly NotificationType[];
+type DocumentNotificationType = (typeof DOCUMENT_TYPES)[number];
+
+function opensDocument(type: NotificationType): type is DocumentNotificationType {
+  return DOCUMENT_TYPES.some((documentType) => documentType === type);
+}
+
+// Where a click on each other kind of notification takes you. satisfies: a new type without a page
+// does not compile, and the values are checked against the router's real paths by navigate() below.
 const TARGET = {
   'workspace.ready': '/roles',
   'member.joined': '/team',
@@ -33,21 +47,30 @@ const TARGET = {
   'import.done': '/products/imports',
   'import.failed': '/products/imports',
   'stock.low': '/stock/reorder',
-} as const satisfies Record<Exclude<NotificationType, 'document.email_failed'>, string>;
+} as const satisfies Record<Exclude<NotificationType, DocumentNotificationType>, string>;
 
 // A document's page from the notification's kind and id. The list of that kind when the id is
 // missing or not a document's (an older notification); the dashboard for a kind this app does
 // not know. One navigate() per kind: each path has its own parameter name, and TanStack checks
-// each pair against the router.
+// each pair against the router. Step 17a: the kinds that need an approval too (17b adds the
+// purchase order).
 function useOpenDocument(): (params: NotificationParams) => Promise<void> {
   const navigate = useNavigate();
   return async (params) => {
     const { document: kind, id } = params;
+    const known = typeof id === 'string' && id !== '';
+    // A requisition is the only kind now; 17b's purchase order makes this a switch like the one
+    // below (a one-case switch fails the lint rule against conditions that are always true)
+    if (typeof kind === 'string' && isApprovalDocument(kind)) {
+      await (known
+        ? navigate({ to: '/requisitions/$requisitionId', params: { requisitionId: id } })
+        : navigate({ to: '/requisitions' }));
+      return;
+    }
     if (typeof kind !== 'string' || !isOutputDocument(kind)) {
       await navigate({ to: '/' });
       return;
     }
-    const known = typeof id === 'string' && id !== '';
     switch (kind) {
       case 'quotation':
         await (known
@@ -87,9 +110,11 @@ function useWords() {
     const { report, format, document: kind } = params;
     return {
       ...params,
-      // Step 16: a document's kind (invoice) becomes its name
+      // Step 16: a document's kind (invoice) becomes its name; step 17a: a requisition's too
       ...(typeof kind === 'string' &&
         isOutputDocument(kind) && { document: t(`documentOutput.kinds.${kind}`) }),
+      ...(typeof kind === 'string' &&
+        isApprovalDocument(kind) && { document: t(`approvals.kinds.${kind}`) }),
       ...(typeof report === 'string' &&
         isReportKind(report) && { report: t(`reports.kinds.${report}`) }),
       ...(typeof format === 'string' &&
@@ -228,7 +253,7 @@ export function NotificationBell() {
                 onOpen={() => {
                   if (notification.readAt === null) markRead.mutate(notification.id);
                   setOpen(false);
-                  if (notification.type === 'document.email_failed') {
+                  if (opensDocument(notification.type)) {
                     void openDocument(notification.params);
                   } else {
                     void navigate({ to: TARGET[notification.type] });
```

- **`DOCUMENT_TYPES` lists the notifications that open their own document:** the failed email of step 16 and the three
  approval types. `TARGET` excludes all of them, so a new approval type without a page does not compile.
- **`useOpenDocument` opens a requisition** by its id, or the list when the id is missing. A one-case `switch` would
  fail the lint rule against conditions that are always true; 17b's purchase order makes it a switch.
- **`useWords` names the kind** ("Requisition PR-2026-27-0001 is waiting for your approval.").

```diff
@@ -5,10 +5,12 @@ import {
   BookOpen02Icon,
   CalendarLock01Icon,
   ChartIncreaseIcon,
+  CheckmarkBadge01Icon,
   Coins01Icon,
   DashboardSquare01Icon,
   DeliveryReturn01Icon,
   DeliveryTruck01Icon,
+  Factory01Icon,
   FileDownloadIcon,
   FileImportIcon,
   FolderTreeIcon,
@@ -34,10 +36,13 @@ import {
   Store01Icon,
   TableIcon,
   Tag01Icon,
+  TaskAdd01Icon,
   TaskEdit01Icon,
   TextIcon,
   UnfoldMoreIcon,
+  UserCheck01Icon,
   UserCircleIcon,
+  UserGroup02Icon,
   UserGroup03Icon,
   UserGroupIcon,
   UserMultiple02Icon,
@@ -64,6 +69,7 @@ import {
   SidebarNav,
   toast,
 } from '@omnivo/ui';
+import { useQuery } from '@tanstack/react-query';
 import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
 import { useEffect, useState } from 'react';
 
@@ -71,6 +77,7 @@ import { NotificationBell } from '../components/notification-bell';
 import { savePreference } from '../lib/preferences';
 import { logout, switchTenant } from '../lib/session';
 import { useCan } from '../lib/permissions';
+import { waitingCountQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { isTheme } from '../lib/theme';
 
@@ -230,6 +237,8 @@ export function AppShell() {
   const me = useSession((state) => state.me);
   // লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard। যেটা খুললেই 403, সেটা মেনুতে না দেখানো
   const can = useCan();
+  // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
+  const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
 
   // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
   useEffect(() => {
@@ -343,6 +352,28 @@ export function AppShell() {
               {t('nav.priceLists')}
             </NavLink>
           </NavGroup>
+          {/* Purchase (step 17a): everyone reads the requisitions and the suppliers, like the sales
+              side. Approvals is "waiting for me": anyone may hold a level's role, so it is there
+              for everyone, with a crit count while something waits (CLAUDE.md → Sidebar nav). */}
+          <NavGroup label={t('nav.purchase')}>
+            <NavLink to="/requisitions" icon={TaskAdd01Icon}>
+              {t('nav.requisitions')}
+            </NavLink>
+            <NavLink
+              to="/approvals"
+              icon={CheckmarkBadge01Icon}
+              count={waiting > 0 ? waiting : undefined}
+              countTone="crit"
+            >
+              {t('nav.approvals')}
+            </NavLink>
+            <NavLink to="/suppliers" icon={Factory01Icon}>
+              {t('nav.suppliers')}
+            </NavLink>
+            <NavLink to="/supplier-groups" icon={UserGroup02Icon}>
+              {t('nav.supplierGroups')}
+            </NavLink>
+          </NavGroup>
           {/* Every member reads products (every sales and stock line picks one); imports change
               them, so only managers see that page */}
           <NavGroup label={t('nav.inventory')}>
@@ -405,6 +436,13 @@ export function AppShell() {
                 {t('nav.roles')}
               </NavLink>
             )}
+            {/* Step 17a: a workspace setting, next to the roles its levels name; shown to the
+                people who may change it, like Numbering */}
+            {can('core.settings.manage') && (
+              <NavLink to="/approval-rules" icon={UserCheck01Icon}>
+                {t('nav.approvalRules')}
+              </NavLink>
+            )}
             <NavLink to="/custom-fields" icon={TextIcon}>
               {t('nav.customFields')}
             </NavLink>
```

- **The Purchase group comes after Sales:** the documents first (Requisitions, Approvals), then the suppliers, like
  the Sales group.
- **Approvals shows its count only above zero,** in `crit`: something waits for this person (decision 39).
- **Approval levels sits next to Roles** in the Workspace group, for `core.settings.manage` only (decision 40).

```diff
@@ -584,6 +584,63 @@ const refundRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/refund'), 'RefundPage'),
 });
 
+// Purchase (step 17a): suppliers and their groups, like the customers ('/suppliers/new' beats
+// '/suppliers/$supplierId'; the form pages have a file of their own, routes/supplier-edit.tsx, for
+// the same reason as the customer's), then the requisitions and the "waiting for me" list.
+const suppliersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/suppliers',
+  component: lazyRouteComponent(() => import('./routes/suppliers'), 'SuppliersPage'),
+});
+
+const newSupplierRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/suppliers/new',
+  component: lazyRouteComponent(() => import('./routes/supplier-edit'), 'NewSupplierPage'),
+});
+
+const supplierRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/suppliers/$supplierId',
+  component: lazyRouteComponent(() => import('./routes/supplier'), 'SupplierPage'),
+});
+
+const editSupplierRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/suppliers/$supplierId/edit',
+  component: lazyRouteComponent(() => import('./routes/supplier-edit'), 'EditSupplierPage'),
+});
+
+const supplierGroupsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/supplier-groups',
+  component: lazyRouteComponent(() => import('./routes/supplier-groups'), 'SupplierGroupsPage'),
+});
+
+const requisitionsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/requisitions',
+  component: lazyRouteComponent(() => import('./routes/requisitions'), 'RequisitionsPage'),
+});
+
+const newRequisitionRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/requisitions/new',
+  component: lazyRouteComponent(() => import('./routes/requisition'), 'NewRequisitionPage'),
+});
+
+const requisitionRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/requisitions/$requisitionId',
+  component: lazyRouteComponent(() => import('./routes/requisition'), 'RequisitionPage'),
+});
+
+const approvalsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/approvals',
+  component: lazyRouteComponent(() => import('./routes/approvals'), 'ApprovalsPage'),
+});
+
 const customFieldsRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/custom-fields',
@@ -602,6 +659,13 @@ const rolesRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/roles'), 'RolesPage'),
 });
 
+// Step 17a: the approval levels, a workspace setting next to the roles they name
+const approvalRulesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/approval-rules',
+  component: lazyRouteComponent(() => import('./routes/approval-rules'), 'ApprovalRulesPage'),
+});
+
 const auditLogRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/audit-log',
@@ -694,9 +758,19 @@ const routeTree = rootRoute.addChildren([
     refundsRoute,
     newRefundRoute,
     refundRoute,
+    suppliersRoute,
+    newSupplierRoute,
+    supplierRoute,
+    editSupplierRoute,
+    supplierGroupsRoute,
+    requisitionsRoute,
+    newRequisitionRoute,
+    requisitionRoute,
+    approvalsRoute,
     customFieldsRoute,
     teamRoute,
     rolesRoute,
+    approvalRulesRoute,
     auditLogRoute,
     ...devRoutes,
   ]),
```

The ten new routes. `/suppliers/new` and `/requisitions/new` beat `/…/$id`, like every document. The supplier form
pages share a file (`supplier-edit.tsx`), like the customer's.

### Back under the budget

Decision 46 explains why. Each change below moves code that the page does not need at first into a chunk of its own.

```diff
@@ -1,25 +1,61 @@
-import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';
+import { lazy, Suspense, useEffect } from 'react';
+// Types only: erased from the build, so this line fetches nothing
+import type * as Sonner from 'sonner';
+
+// Step 17a: sonner is a chunk of its own, fetched right after the first render instead of being
+// part of the first load. A toast always follows something the person did, so the first paint
+// never needs it, and it was about 9 KB gz of the 200 KB first-load budget. One loader, so the
+// toaster and toast() share a single fetch.
+let sonner: Promise<typeof Sonner> | null = null;
+const loadSonner = () => (sonner ??= import('sonner'));
+
+// Resolves once sonner's toaster is on the page. A toast sent before that (a save that answered
+// in the first second) waits for it instead of being lost: sonner only shows toasts sent after
+// its toaster subscribed.
+let markReady: () => void = () => undefined;
+const ready = new Promise<void>((resolve) => {
+  markReady = resolve;
+});
 
 // CLAUDE.md → Toast: ink পটভূমি, bg লেখা, ১০px কোণ, shadow-lg, নিচে মাঝখানে, ~৩ সেকেন্ড।
 // unstyled: sonner-এর নিজের রং/কোণ বাদ, শুধু আমাদের token — dark mode-এ ink নিজেই উল্টে যায়
+const LoadedToaster = lazy(async () => {
+  const { Toaster: SonnerToaster } = await loadSonner();
+  function Loaded() {
+    // Effects run child first: sonner's toaster has subscribed by the time this one runs
+    useEffect(() => {
+      markReady();
+    }, []);
+    return (
+      <SonnerToaster
+        position="bottom-center"
+        duration={3000}
+        toastOptions={{
+          unstyled: true,
+          classNames: {
+            toast:
+              'flex w-full items-center gap-2.5 rounded-control bg-ink px-4 py-3 text-body-sm font-medium text-bg shadow-lg',
+          },
+        }}
+      />
+    );
+  }
+  return { default: Loaded };
+});
+
 export function Toaster() {
+  // Nothing to show while the chunk arrives: no toast has been sent yet
   return (
-    <SonnerToaster
-      position="bottom-center"
-      duration={3000}
-      toastOptions={{
-        unstyled: true,
-        classNames: {
-          toast:
-            'flex w-full items-center gap-2.5 rounded-control bg-ink px-4 py-3 text-body-sm font-medium text-bg shadow-lg',
-        },
-      }}
-    />
+    <Suspense fallback={null}>
+      <LoadedToaster />
+    </Suspense>
   );
 }
 
 // sonner-এর পুরো API বাইরে না দিয়ে একটাই ফাংশন: পরে লাইব্রেরি বদলালে শুধু এই ফাইল বদলাবে।
 // লেখা হবে কী ঘটল তা ("Workspace created") — CLAUDE.md
 export function toast(message: string): void {
-  sonnerToast(message);
+  void ready.then(async () => {
+    (await loadSonner()).toast(message);
+  });
 }
```

- **`loadSonner` is one shared promise:** the toaster and `toast()` fetch the library once.
- **`ready` resolves when the toaster is on the page.** sonner only shows toasts sent after its toaster subscribed,
  so a toast sent in the first second (a save that answered very fast) waits for it instead of being lost. Effects
  run child first, so sonner's own toaster has subscribed when `Loaded`'s effect resolves `ready`.
- **`import type * as Sonner`** gives the promise its type without importing anything at run time; a plain import
  would put sonner back into the first load.

```diff
@@ -1,4 +1,4 @@
-import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
+import { Calendar03Icon, Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
@@ -14,10 +14,10 @@ import { useLocale } from '@omnivo/i18n';
 import {
   Button,
   Card,
-  DatePicker,
   Dialog,
   FormAlert,
   FormField,
+  Input,
   PageHeader,
   SelectField,
   TextField,
@@ -25,7 +25,7 @@ import {
 } from '@omnivo/ui';
 import { useMutation, useQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
-import { useState } from 'react';
+import { lazy, Suspense, useState } from 'react';
 import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
 
 import { call } from '../lib/api';
@@ -45,6 +45,11 @@ import {
   warehouseLabel,
 } from './stock-parts';
 
+// Step 17a: the date picker as a chunk of its own (date-input.tsx says why), like the adjustment
+// form's since step 16. The contracts of 17a (the purchase routes every page's API client
+// carries) took this form 1.9 KB over its 100 KB budget.
+const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
+
 // The transfer form: writing a new transfer or changing a draft. "Send transfer" saves and sends
 // in one request: the stock leaves the first warehouse and is in transit. Its own chunk, like the
 // adjustment form.
@@ -223,7 +228,11 @@ export function TransferForm({
             error={errors.toWarehouseId?.message}
           />
           <FormField control={control} name="date" label={t('transfers.date')}>
-            {(field) => <DatePicker {...field} />}
+            {(field) => (
+              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
+                <DatePicker {...field} />
+              </Suspense>
+            )}
           </FormField>
           <div className="sm:col-span-2 lg:col-span-3">
             <TextField
```

```diff
@@ -1,4 +1,9 @@
-import { AlertCircleIcon, Edit02Icon, TransactionHistoryIcon } from '@hugeicons/core-free-icons';
+import {
+  AlertCircleIcon,
+  Calendar03Icon,
+  Edit02Icon,
+  TransactionHistoryIcon,
+} from '@hugeicons/core-free-icons';
 import {
   compareQuantity,
   isMovementKind,
@@ -12,11 +17,11 @@ import {
   CardHeader,
   DataTable,
   dataTableColumns,
-  DatePicker,
   Dialog,
   EmptyState,
   Field,
   IconButton,
+  Input,
   KpiStrip,
   PageHeader,
   Select,
@@ -46,6 +51,11 @@ const column = dataTableColumns<StockMovement>();
 const ReorderLevelForm = lazy(async () => ({
   default: (await import('../components/reorder-level-form')).ReorderLevelForm,
 }));
+// Step 17a: the history's two date pickers too (date-input.tsx says why). The contracts of 17a
+// took this page 0.3 KB over its budget. Until the chunk arrives, a disabled box holds each place.
+const DatePicker = lazy(async () => ({
+  default: (await import('../components/date-input')).DatePicker,
+}));
 
 export function StockCardPage() {
   const { t, format } = useLocale();
@@ -365,22 +375,26 @@ export function StockCardPage() {
             />
           </Field>
           <Field id="history-from" label={t('stock.from')}>
-            <DatePicker
-              id="history-from"
-              value={range.from}
-              onChange={(value) => {
-                setRange((before) => ({ ...before, from: value }));
-              }}
-            />
+            <Suspense fallback={<Input id="history-from" icon={Calendar03Icon} disabled />}>
+              <DatePicker
+                id="history-from"
+                value={range.from}
+                onChange={(value) => {
+                  setRange((before) => ({ ...before, from: value }));
+                }}
+              />
+            </Suspense>
           </Field>
           <Field id="history-to" label={t('stock.to')}>
-            <DatePicker
-              id="history-to"
-              value={range.to}
-              onChange={(value) => {
-                setRange((before) => ({ ...before, to: value }));
-              }}
-            />
+            <Suspense fallback={<Input id="history-to" icon={Calendar03Icon} disabled />}>
+              <DatePicker
+                id="history-to"
+                value={range.to}
+                onChange={(value) => {
+                  setRange((before) => ({ ...before, to: value }));
+                }}
+              />
+            </Suspense>
           </Field>
         </div>
         {first && range.from !== '' && (
```

The transfer form and the stock card load their date pickers from `date-input.tsx`, like the adjustment form since
step 16. A disabled box of the same size holds each picker's place, so nothing jumps.

```diff
@@ -37,7 +37,6 @@ import { allocationRows } from '../lib/invoices';
 import { rowPath } from '../lib/products';
 import { accountsQuery, branchesQuery, openInvoicesQuery } from '../lib/queries';
 import { AllocationTable } from './allocation-table';
-import { CreditLine } from './credit-parts';
 import { SalesBackLink, useSalesRefresh } from './sales-parts';
 import { useTenantId } from './stock-parts';
 
@@ -49,6 +48,10 @@ const CustomerPicker = lazy(async () => ({
   default: (await import('./customer-picker')).CustomerPicker,
 }));
 const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
+// Step 17a: the credit line too. Its module also holds the credit limit dialog, which brought the
+// whole dialog code into this form, though a receipt never shows it; with the contracts of 17a
+// the form was 1.1 KB over its 100 KB budget.
+const CreditLine = lazy(async () => ({ default: (await import('./credit-parts')).CreditLine }));
 
 type FormValues = ReceiptFormValues;
 
@@ -175,7 +178,9 @@ export function ReceiptForm({
                 </Suspense>
               )}
             </FormField>
-            <CreditLine customerId={customerId} />
+            <Suspense fallback={null}>
+              <CreditLine customerId={customerId} />
+            </Suspense>
           </div>
           <FormField control={control} name="date" label={t('receipts.date')}>
             {(field) => (
```

The money receipt form loads its credit line later. `credit-parts.tsx` also holds the credit limit dialog, so the
form carried the whole dialog code, though a receipt never shows that dialog.

### The unit tests: `lib/purchase.spec.ts` (new)

```ts
import type { ApprovalRound, ApprovalStep, RequisitionLine } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  approvedByOwnSubmit,
  requisitionFormTotals,
  roundNumber,
  stepState,
  toRequisitionFormLine,
} from './purchase';

const RUPA = { id: '00000000-0000-4000-8000-000000000001', name: 'Rupa Akter' };
const KAMAL = { id: '00000000-0000-4000-8000-000000000002', name: 'Kamal Hossain' };

// A step as the API sends it: Purchase manager from ৳20,000, not decided yet
function step(position: number, extra: Partial<ApprovalStep> = {}): ApprovalStep {
  return {
    position,
    minAmount: position === 1 ? '20000.0000' : '100000.0000',
    role: {
      id: `00000000-0000-4000-8000-00000000010${String(position)}`,
      name: 'Purchase manager',
    },
    decision: null,
    decidedBy: null,
    decidedAt: null,
    comment: null,
    ...extra,
  };
}

function round(status: ApprovalRound['status'], steps: ApprovalStep[]): ApprovalRound {
  return {
    id: '00000000-0000-4000-8000-000000000200',
    status,
    amount: '150000.0000',
    submittedBy: RUPA,
    submittedAt: '2026-10-15T04:00:00.000Z',
    closedAt: status === 'pending' ? null : '2026-10-15T06:00:00.000Z',
    steps,
  };
}

const approvedBy = (person: { id: string; name: string }) => ({
  decision: 'approved' as const,
  decidedBy: person,
  decidedAt: '2026-10-15T05:00:00.000Z',
});

describe('requisitionFormTotals', () => {
  it('adds the complete lines and leaves the half-typed ones out', () => {
    const { amounts, total } = requisitionFormTotals([
      // 40 cones at ৳312.4567 = ৳12,498.268 → ৳12,498.27 (rounded once per line)
      {
        variantId: 'yarn',
        unitId: 'cone',
        quantity: '40',
        description: '',
        estimatedCost: '312.4567',
      },
      { variantId: 'motor', unitId: 'pcs', quantity: '1.', description: '', estimatedCost: '8500' },
      { variantId: 'bags', unitId: 'pcs', quantity: '200', description: '', estimatedCost: '' },
    ]);
    expect(amounts).toEqual(['12498.2700', null, null]);
    expect(total).toBe('12498.2700');
  });

  it('is nothing for no lines', () => {
    expect(requisitionFormTotals([]).total).toBe('0.0000');
  });
});

describe('toRequisitionFormLine', () => {
  const line: RequisitionLine = {
    id: 'line-1',
    variantId: 'yarn',
    productId: 'p-yarn',
    productCode: 'P-00031',
    productName: '30s combed cotton yarn',
    optionValues: [],
    sku: 'P-00031',
    baseUnitId: 'cone',
    productType: 'goods',
    units: [{ unitId: 'bag', factor: '24.000000' }],
    unitId: 'bag',
    quantity: '2.0000',
    baseQuantity: '48.0000',
    description: '30s combed cotton yarn',
    estimatedCost: '7499.0000',
    amount: '14998.0000',
  };

  it('shows the quantity as typed and an empty description when it is the product name', () => {
    expect(toRequisitionFormLine(line)).toEqual({
      variantId: 'yarn',
      unitId: 'bag',
      quantity: '2',
      description: '',
      estimatedCost: '7499.0000',
    });
  });

  it('keeps a description the person wrote', () => {
    expect(toRequisitionFormLine({ ...line, description: 'Navy, for PO-HM-2026-1187' })).toEqual(
      expect.objectContaining({ description: 'Navy, for PO-HM-2026-1187' }),
    );
  });
});

describe('stepState', () => {
  it('waits on the first undecided step of a pending round, the next is not yet', () => {
    const pending = round('pending', [step(1, approvedBy(KAMAL)), step(2), step(3)]);
    expect(pending.steps.map((item) => stepState(pending, item))).toEqual([
      'approved',
      'waiting',
      'notYet',
    ]);
  });

  it('never shows a step of a closed round as waiting', () => {
    const rejected = round('rejected', [
      step(1, { decision: 'rejected', decidedBy: KAMAL, comment: 'Order 1,500 cones' }),
      step(2),
    ]);
    expect(rejected.steps.map((item) => stepState(rejected, item))).toEqual([
      'rejected',
      'notDecided',
    ]);
    const reopened = round('reopened', [step(1)]);
    expect(stepState(reopened, step(1))).toBe('notDecided');
  });
});

describe('approvedByOwnSubmit', () => {
  it('is true when every step was approved by the person who submitted it (an Owner)', () => {
    expect(approvedByOwnSubmit(round('approved', [step(1, approvedBy(RUPA))]))).toBe(true);
  });

  it('is false when someone else approved, and when no level applied', () => {
    expect(approvedByOwnSubmit(round('approved', [step(1, approvedBy(KAMAL))]))).toBe(false);
    expect(approvedByOwnSubmit(round('approved', []))).toBe(false);
  });
});

describe('roundNumber', () => {
  it('counts from the first submission, while the list is newest first', () => {
    const rounds = [round('pending', []), round('rejected', []), round('reopened', [])];
    expect([0, 1, 2].map((index) => roundNumber(rounds, index))).toEqual([3, 2, 1]);
  });
});
```

- **The total test uses an average cost with 4 decimals** (৳312.4567 × 40 cones), so it proves the line is rounded
  once, to the paisa, and that half-typed lines ("1.", an empty cost) count as nothing.
- **`stepState` is tested on a pending round and on closed ones:** a step after a rejection must read "not decided",
  never "waiting".
- **`approvedByOwnSubmit` is false when no level applied:** that round has no steps, and it gets the "no level"
  sentence instead.

### Check this part

```bash
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm lint
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
```

Build `@omnivo/ui` first: the app reads its built `dist/`, and the new toast is in the ui package.

> **What we checked in this part.** The app type-checks (with its scripts and e2e projects), ESLint and Prettier are
> clean on the 40 files, and the app's unit tests pass (96, 9 of them new). The ui package type-checks, its tests
> pass (19) and it builds. The bundle check passes: first load 193.5 KB gz (201.5 before this part), the biggest new
> page is the supplier groups page (97.5 KB), and the team page is at its limit (100.0 KB, 15 bytes under), so 17b
> will need to look at it. We broke two things on purpose: `stepState` showing a step after a rejection as "not yet"
> made its unit test fail, and removing `approval.rejected` from the bell's `DOCUMENT_TYPES` failed the type check.
> Nothing in this part was clicked through in a browser yet: the mock API and the Playwright tests are 17a.7.

---

## 17a.7 — `apps/app`: the mock API and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). This part
teaches the mock every route of 17a, with the API's rules, shortened: suppliers and their groups, a party on both
sides, the supplier on the payable lines, approval levels, the approval engine, requisitions and the cost lookup.
Then two new test files click through the screens of 17a.6 on a desktop and on a phone.

**When this part starts, the mock does not start at all.** Since 17a.1 the payable is a per-party account
(`PARTY_ACCOUNT_PURPOSES` has `accounts_payable`), and the mock's seeded journal has a payable line with no party
(last year's "Fabrics and yarn used for the H&M order"). The mock's posting check refuses it with
`journal_party_required` while it builds the workspace, so every page of `pnpm dev:mock` fails to load. The first
thing this part does is give that line a supplier: Meghna Spinning Mills, the company's yarn mill. From then on the
mock owes Meghna ৳21,00,000, which is also the first thing the supplier list shows.

This was also the first time the 17a.6 screens ran in a browser. They all worked as written. One gap showed up, in
the words, not the screens, and it is fixed here as a cross-part fix (decision 47).

Decisions 47–52, at the top of this guide, came up while building this part.

The files, in the order to write them: each one only uses files above it.

### `mocks/supplier-data.ts` (new): the shapes and the seed

```ts
import {
  defaultNumberFormat,
  type ErrorCode,
  formatDocumentNumber,
  type LanguageCode,
  periodOf,
  type Supplier,
  type SupplierBankAccount,
  type SupplierGroup,
  type SupplierInput,
  type SupplierSort,
  type SupplierStatus,
  type SupplierSummary,
  subtractMoney,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import type { MockCustomer } from './sales-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17a suppliers and their groups. The API's rules (suppliers.service.ts,
// supplier-groups.service.ts) on plain arrays, like sales-data.ts does for customers.
//
// The API keeps a party that is both a customer and a supplier as one row. The mock keeps the
// customer in sales.customers and the supplier here, under the same id, and copies the fields they
// share from the side that was saved to the other one (copyToSupplier, copyToCustomer). So the
// version a page sends back is the party's version, whichever side it came from.

// A supplier as stored: the balance is worked out from the books on every read
export type MockSupplier = Omit<Supplier, 'balance'>;
export type MockSupplierGroup = Omit<SupplierGroup, 'supplierCount'>;

export interface MockSuppliers {
  groups: MockSupplierGroup[];
  suppliers: MockSupplier[];
  // The last number given from the 'purchase.supplier' series
  lastCode: number;
}

export function emptySuppliers(): MockSuppliers {
  return { groups: [], suppliers: [], lastCode: 0 };
}

function now(): string {
  return new Date().toISOString();
}

// --- Seed ---------------------------------------------------------------------------------------

function group(name: string): MockSupplierGroup {
  return { id: crypto.randomUUID(), name, version: 1, updatedAt: now() };
}

interface SupplierParts {
  name: string;
  group: MockSupplierGroup | null;
  contactPerson?: string;
  phone?: string;
  email?: string;
  bin?: string;
  paymentTermsDays: number;
  address?: string;
  bankAccounts?: Omit<SupplierBankAccount, 'id'>[];
  documentLanguage?: LanguageCode;
}

function supplier(suppliers: MockSuppliers, parts: SupplierParts): MockSupplier {
  suppliers.lastCode += 1;
  return {
    id: crypto.randomUUID(),
    code: formatDocumentNumber(defaultNumberFormat('purchase.supplier'), '', suppliers.lastCode),
    name: parts.name,
    groupId: parts.group?.id ?? null,
    contactPerson: parts.contactPerson ?? null,
    phone: parts.phone ?? null,
    email: parts.email ?? null,
    documentLanguage: parts.documentLanguage ?? 'en',
    bin: parts.bin ?? null,
    paymentTermsDays: parts.paymentTermsDays,
    address: parts.address ?? null,
    bankAccounts: (parts.bankAccounts ?? []).map((account) => ({
      id: crypto.randomUUID(),
      ...account,
    })),
    notes: null,
    isCustomer: false,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

// Real-looking vendors (CLAUDE.md → Content). The garments maker buys yarn and fabric, trims and
// cartons; seedJournal() names Meghna on last year's payable line, so it owes Meghna from the first
// page load. The pharma distributor buys from manufacturers. Before seedJournal(): its payable
// lines name a supplier.
export function seedSuppliers(data: WorkspaceData, garments: boolean): void {
  const suppliers = data.suppliers;
  if (garments) {
    const yarn = group('Yarn and fabric');
    const accessories = group('Accessories');
    const packaging = group('Packaging');
    suppliers.groups = [yarn, accessories, packaging];
    suppliers.suppliers = [
      supplier(suppliers, {
        name: 'Meghna Spinning Mills Ltd.',
        group: yarn,
        contactPerson: 'Md. Rafiqul Islam',
        phone: '+880 1711-234567',
        email: 'sales@meghnaspinning.com',
        bin: '0005678900101',
        paymentTermsDays: 60,
        address: 'Plot 12, BSCIC Industrial Area, Fatullah, Narayanganj 1421',
        bankAccounts: [
          {
            bankName: 'Dutch-Bangla Bank',
            branchName: 'Narayanganj',
            accountName: 'Meghna Spinning Mills Ltd.',
            accountNumber: '1071100023456',
            routingNumber: '090670725',
          },
        ],
      }),
      supplier(suppliers, {
        name: 'Unitex Trims & Accessories',
        group: accessories,
        contactPerson: 'Shahana Parvin',
        phone: '+880 1819-456789',
        paymentTermsDays: 30,
        address: 'House 18, Road 3, Sector 7, Uttara, Dhaka 1230',
        documentLanguage: 'bn',
      }),
      supplier(suppliers, {
        name: 'Gazipur Carton Industries',
        group: packaging,
        phone: '+880 1552-889900',
        paymentTermsDays: 0,
        address: 'Board Bazar, Gazipur 1704',
      }),
    ];
    return;
  }
  const makers = group('Manufacturers');
  suppliers.groups = [makers, group('Importers')];
  suppliers.suppliers = [
    supplier(suppliers, {
      name: 'Beximco Pharmaceuticals Ltd.',
      group: makers,
      contactPerson: 'Tareq Aziz',
      phone: '+880 2-58611001',
      bin: '0006789010202',
      paymentTermsDays: 45,
      address: '19 Dhanmondi R/A, Road 7, Dhaka 1205',
    }),
    supplier(suppliers, {
      name: 'Incepta Pharmaceuticals Ltd.',
      group: makers,
      phone: '+880 2-8891688',
      paymentTermsDays: 30,
      address: '40 Shahid Tajuddin Ahmed Sarani, Tejgaon I/A, Dhaka 1208',
    }),
  ];
}
```

- **`MockSupplier` is `Supplier` without `balance`.** The balance is worked out from the journal on every read
  (`supplierBalanceOf`), like the API's subquery. A stored balance would go stale the moment an entry is posted, and
  the supplier list would disagree with the statement.
- **`lastCode` is its own counter,** for the `purchase.supplier` series (`S-00001`). The seed counts up through it
  too, so the first supplier added on the page is `S-00004`, and the Numbering page shows that as the next number
  (`usedNumbers` in `workspace-data.ts`).
- **The seed's three garments suppliers** each show something different: Meghna has a group, terms, a BIN and a bank
  account with a routing number (and is owed money by `seedJournal()`); Unitex reads its documents in Bangla; the
  carton maker is paid on receipt. The pharma workspace gets two manufacturers so its supplier pages are not empty.
- **`seedSuppliers()` runs before `seedJournal()`.** The journal's payable line names Meghna by name, so Meghna must
  exist first. Run the other way round, the seed throws "The mock has no supplier Meghna".

### Balances and the list

```ts
// --- Balances -----------------------------------------------------------------------------------

function isPayable(data: WorkspaceData, accountId: string): boolean {
  return data.accounts.some(
    (account) => account.id === accountId && account.purpose === 'accounts_payable',
  );
}

// Debit − credit of the supplier's posted payable lines, like the API's subquery: negative while
// the company owes (a bill is a credit). The app turns the sign round to say "You owe".
export function supplierBalanceOf(data: WorkspaceData, partyId: string): string {
  const lines = data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) => entry.lines)
    .filter((line) => line.party?.id === partyId && isPayable(data, line.accountId));
  return subtractMoney(
    sumMoney(lines.map((line) => line.debit)),
    sumMoney(lines.map((line) => line.credit)),
  );
}

// The owner sees every balance; someone without purchase.supplier.balance would get null
export function toSupplier(data: WorkspaceData, stored: MockSupplier): Supplier {
  return { ...stored, balance: supplierBalanceOf(data, stored.id) };
}

export function supplierSummaryOf(data: WorkspaceData, stored: MockSupplier): SupplierSummary {
  return {
    id: stored.id,
    code: stored.code,
    name: stored.name,
    groupId: stored.groupId,
    contactPerson: stored.contactPerson,
    phone: stored.phone,
    paymentTermsDays: stored.paymentTermsDays,
    isCustomer: stored.isCustomer,
    balance: supplierBalanceOf(data, stored.id),
    archivedAt: stored.archivedAt,
    updatedAt: stored.updatedAt,
  };
}

export function findSupplier(data: WorkspaceData, id: string): MockSupplier {
  const found = data.suppliers.suppliers.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The API's filters and orders, on an array, like listCustomers()
export function listSuppliers(
  data: WorkspaceData,
  query: {
    search?: string | undefined;
    groupId?: string | undefined;
    status: SupplierStatus;
    sort: SupplierSort;
  },
): MockSupplier[] {
  const search = query.search?.toLowerCase() ?? '';
  const lower = (value: string | null) => value?.toLowerCase() ?? '';
  const found = data.suppliers.suppliers.filter(
    (item) =>
      (query.status === 'archived') === (item.archivedAt !== null) &&
      (query.groupId === undefined || item.groupId === query.groupId) &&
      (search === '' ||
        lower(item.name).includes(search) ||
        lower(item.code).includes(search) ||
        lower(item.contactPerson).includes(search) ||
        (item.phone ?? '').includes(query.search ?? '')),
  );
  const by = {
    name: (a: MockSupplier, b: MockSupplier) => lower(a.name).localeCompare(lower(b.name)),
    '-name': (a: MockSupplier, b: MockSupplier) => lower(b.name).localeCompare(lower(a.name)),
    code: (a: MockSupplier, b: MockSupplier) => lower(a.code).localeCompare(lower(b.code)),
    '-code': (a: MockSupplier, b: MockSupplier) => lower(b.code).localeCompare(lower(a.code)),
    '-updated': (a: MockSupplier, b: MockSupplier) => b.updatedAt.localeCompare(a.updatedAt),
  };
  return found.sort(by[query.sort]);
}
```

- **Debit minus credit, negative while owed.** That is what the API sends (17a.4 noted it), so the mock sends the
  same. The page turns the sign round to say "You owe ৳21,00,000"; if the mock sent the positive number, the page
  would say "৳21,00,000 paid in advance" in `dev:mock` and the e2e test would fail.
- **Only posted lines on the payable count.** A draft is not money owed yet. A party that is also a customer has
  receivable lines too, and those belong to its customer balance, not this one.
- **`listSuppliers()` is `listCustomers()` for the other side:** the same search (name, code, contact person, and the
  phone as typed, since digits have no case) and the same five sorts.

### Saving a supplier

```ts
// --- Saving -------------------------------------------------------------------------------------

function fieldProblem(status: number, code: ErrorCode, field: string): MockProblem {
  return new MockProblem(status, status === 409 ? code : 'invalid_input', { [field]: [code] });
}

// One code per party, whichever side it is (the API's parties_tenant_code_idx): a supplier cannot
// take a customer's code, except its own customer side's
export function partyCodeTaken(data: WorkspaceData, code: string, except?: string): boolean {
  const same = (item: { id: string; code: string }) =>
    item.id !== except && item.code.toLowerCase() === code.toLowerCase();
  return data.sales.customers.some(same) || data.suppliers.suppliers.some(same);
}

// The next free code from the 'purchase.supplier' series; a code someone typed is skipped
function newCode(data: WorkspaceData): string {
  const format = data.series.get('purchase.supplier') ?? defaultNumberFormat('purchase.supplier');
  const period = periodOf(
    todayIn(data.settings.timezone),
    format.yearStyle,
    data.settings.fiscalYearStartMonth,
  );
  for (;;) {
    data.suppliers.lastCode += 1;
    const code = formatDocumentNumber(format, period, data.suppliers.lastCode);
    if (!partyCodeTaken(data, code)) return code;
  }
}

// Create (no `existing`) or update. The bank accounts sent replace the old ones: one sent back
// with its id keeps it, one with an id that is not this supplier's becomes a new one (the API's
// diff by id). The contract has already cleaned the numbers.
export function saveSupplier(
  data: WorkspaceData,
  input: SupplierInput,
  existing?: MockSupplier,
): MockSupplier {
  if (input.groupId !== null && !data.suppliers.groups.some((item) => item.id === input.groupId)) {
    throw fieldProblem(400, 'supplier_group_invalid', 'groupId');
  }
  const code = input.code ?? existing?.code ?? newCode(data);
  if (partyCodeTaken(data, code, existing?.id)) {
    throw fieldProblem(409, 'supplier_code_taken', 'code');
  }
  const own = new Set(existing?.bankAccounts.map((account) => account.id));
  return {
    id: existing?.id ?? crypto.randomUUID(),
    code,
    name: input.name,
    groupId: input.groupId,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email,
    documentLanguage: input.documentLanguage,
    bin: input.bin,
    paymentTermsDays: input.paymentTermsDays,
    address: input.address,
    bankAccounts: input.bankAccounts.map((account) => ({
      id: account.id !== null && own.has(account.id) ? account.id : crypto.randomUUID(),
      bankName: account.bankName,
      branchName: account.branchName,
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      routingNumber: account.routingNumber,
    })),
    notes: input.notes,
    isCustomer: existing?.isCustomer ?? false,
    archivedAt: existing?.archivedAt ?? null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
}
```

- **`partyCodeTaken()` looks at both sides.** The API has one unique index on the parties' codes, so a supplier
  cannot take a customer's code. `except` is the party's own id: a party on both sides has the same code on both
  records, and saving it must not find itself.
- **`newCode()` skips a code someone typed by hand,** like the customer's. Without the loop, a supplier typed as
  `S-00004` and the next automatic one would both be `S-00004`.
- **Bank accounts keep their id only when it is this supplier's.** The form sends back the ids it was given; an id
  that is not one of them (a copied form, a stale tab) becomes a new account. That is the API's "diff by id", and it
  keeps the ids that 17c's payments will point at.

### A party on both sides

```ts
// --- A party on both sides ----------------------------------------------------------------------

// The party's own fields: one value for both sides
function sharedOf(side: MockCustomer | MockSupplier) {
  return {
    code: side.code,
    name: side.name,
    contactPerson: side.contactPerson,
    phone: side.phone,
    email: side.email,
    documentLanguage: side.documentLanguage,
    bin: side.bin,
    notes: side.notes,
    archivedAt: side.archivedAt,
    version: side.version,
    updatedAt: side.updatedAt,
  };
}

// The supplier's address is the party's billing address (decision 31)
function billingOf(customer: MockCustomer): string | null {
  return customer.addresses.find((address) => address.kind === 'billing')?.address ?? null;
}

// After a customer save: its supplier side (if any) gets the shared fields and the billing address
export function copyToSupplier(data: WorkspaceData, customer: MockCustomer): void {
  const found = data.suppliers.suppliers.find((item) => item.id === customer.id);
  if (found) Object.assign(found, sharedOf(customer), { address: billingOf(customer) });
}

// After a supplier save: its customer side (if any) gets the shared fields. The address becomes
// the billing address's text: it keeps its label and phone, null removes it, and a new one is put
// first (the API's suppliers.service.ts saveAddress()).
export function copyToCustomer(data: WorkspaceData, saved: MockSupplier): void {
  const found = data.sales.customers.find((item) => item.id === saved.id);
  if (!found) return;
  const billing = found.addresses.find((address) => address.kind === 'billing');
  const shipping = found.addresses.filter((address) => address.kind !== 'billing');
  const address =
    saved.address === null
      ? []
      : [
          billing
            ? { ...billing, address: saved.address }
            : {
                id: crypto.randomUUID(),
                kind: 'billing',
                label: null,
                address: saved.address,
                phone: null,
              },
        ];
  Object.assign(found, sharedOf(saved), { addresses: [...address, ...shipping] });
}

// "Make supplier too" (decision 37): the same party, now also a supplier, with the supplier's own
// fields at their defaults
export function makeSupplier(data: WorkspaceData, customer: MockCustomer): MockSupplier {
  if (customer.isSupplier) throw new MockProblem(409, 'party_role_exists');
  const version = customer.version + 1;
  customer.isSupplier = true;
  customer.version = version;
  customer.updatedAt = now();
  const created: MockSupplier = {
    ...sharedOf(customer),
    id: customer.id,
    groupId: null,
    paymentTermsDays: 0,
    address: billingOf(customer),
    bankAccounts: [],
    isCustomer: true,
  };
  data.suppliers.suppliers.push(created);
  return created;
}

// "Make customer too": the customer's own fields at their defaults (no group, terms 0, no limit,
// no price list), and the supplier's address as its billing address
export function makeCustomer(data: WorkspaceData, saved: MockSupplier): MockCustomer {
  if (saved.isCustomer) throw new MockProblem(409, 'party_role_exists');
  saved.isCustomer = true;
  saved.version += 1;
  saved.updatedAt = now();
  const created: MockCustomer = {
    ...sharedOf(saved),
    id: saved.id,
    groupId: null,
    paymentTermsDays: 0,
    creditLimit: null,
    priceListId: null,
    addresses: [],
    isSupplier: true,
  };
  data.sales.customers.push(created);
  copyToCustomer(data, saved);
  return created;
}

// Deleting a supplier: only one nothing uses. A party that is also a customer stays as a customer:
// only its supplier side goes, if no payable line names it (the API's dropSupplierSide). A
// supplier-only party is used by any line that names it (journal_lines_party_fk).
export function removeSupplier(data: WorkspaceData, target: MockSupplier): void {
  const lines = data.journal.entries.flatMap((entry) => entry.lines);
  const used = target.isCustomer
    ? lines.some((line) => line.party?.id === target.id && isPayable(data, line.accountId))
    : lines.some((line) => line.party?.id === target.id);
  if (used) throw new MockProblem(409, 'supplier_in_use');
  data.suppliers.suppliers = data.suppliers.suppliers.filter((item) => item.id !== target.id);
  const customer = data.sales.customers.find((item) => item.id === target.id);
  if (customer) {
    Object.assign(customer, { isSupplier: false, version: customer.version + 1, updatedAt: now() });
  }
}
```

- **`sharedOf()` lists the party's own fields** (decision 48), and `version` is one of them. That is the reason this
  works: after "Make supplier too" the customer page and the supplier page send the same version, so a save on
  either is checked against the other's, like the one `parties` row in the API.
- **The address goes both ways through the billing address** (decision 31). `copyToCustomer()` changes the text of
  the existing billing address, so its label and phone stay; `null` removes it; a new one is put first, because the
  customer page lists the billing address first.
- **`makeSupplier()` and `makeCustomer()` refuse with `party_role_exists`** when the party is already on that side.
  The page hides the button then, but two tabs can still both press it.
- **`removeSupplier()` checks only payable lines for a party on both sides.** Its receivable lines belong to the
  customer, which stays. A supplier-only party is used by any line that names it, which is what the API's foreign
  key says. The customer side's `isSupplier` flag and version change in the same step, like the API's one UPDATE.

### Supplier groups

```ts
// --- Supplier groups ----------------------------------------------------------------------------

export function toSupplierGroup(data: WorkspaceData, stored: MockSupplierGroup): SupplierGroup {
  return {
    ...stored,
    // Archived suppliers count too: they keep their group
    supplierCount: data.suppliers.suppliers.filter((item) => item.groupId === stored.id).length,
  };
}

export function findSupplierGroup(data: WorkspaceData, id: string): MockSupplierGroup {
  const found = data.suppliers.groups.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertSupplierGroupNameFree(
  data: WorkspaceData,
  name: string,
  except?: string,
): void {
  const taken = data.suppliers.groups.some(
    (item) => item.id !== except && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new MockProblem(409, 'supplier_group_name_taken', {
      name: ['supplier_group_name_taken'],
    });
  }
}
```

A copy of the customer groups' helpers. Archived suppliers count in `supplierCount`, because they keep their group,
and the group delete (in the handler) refuses a group that holds any supplier, archived or not, like the API's
foreign key.

### `mocks/requisition-data.ts` (new): the shapes

```ts
import {
  addMoney,
  addQuantity,
  type ApprovalDecision,
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalRule,
  type ApprovalRuleInput,
  type ApprovalStep,
  type CostLookup,
  type CostLookupInput,
  type CostLookupItem,
  defaultLineDescription,
  type DocumentApproval,
  type ErrorCode,
  fitsDecimals,
  levelsFor,
  type Requisition,
  requisitionAmount,
  type RequisitionInput,
  type RequisitionLine,
  requisitionLineAmount,
  type RequisitionLineInput,
  type RequisitionStatus,
  type RequisitionSummary,
  shiftIsoDate,
  toBaseQuantity,
  todayIn,
  type WaitingApproval,
} from '@omnivo/contracts';

import { OWNER } from './fixtures';
import { MockProblem } from './mock';
import { newestFirst, seriesNumber } from './sales-document-data';
import { averageCostOf, decimalsOf, findVariant, issuesError, refOf } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17a approvals and requisitions: the API's rules (approvals.service.ts,
// requisitions.service.ts, cost-lookup.service.ts) on plain arrays, shortened. The handlers write
// the audit rows, with what these functions return.
//
// The mock always signs in as the Owner (fixtures.ts), and an Owner may decide any step and has
// their own documents approved when they submit them (decision 14). So in the mock a requisition
// written on the page is approved at once, and the waiting ones are the seed's, submitted by
// other members. The API's tests (17a.4) check the rules for everyone else: no self-approval, the
// step's role, and the bell for the next level.

// The levels of one kind of document, with the role by id: its name is read from the roles on
// every read, like the API's join, so a renamed role shows its new name
export interface MockRule {
  levels: { minAmount: string; roleId: string }[];
  // 0 = never saved, like the API's missing row
  version: number;
  updatedAt: string | null;
}

// A round as the API's approval_rounds row, with its steps. A step keeps a copy of its role's name
// (role_name), so it still reads after the role is deleted. The kind is a string, like the
// contract's waiting item: 17b adds purchase orders.
export interface MockRound extends ApprovalRound {
  document: string;
  documentId: string;
}

// A requisition as stored; its line count and approval history are worked out on read
export type MockRequisition = Omit<Requisition, 'approval' | 'lineCount'>;

export interface MockPurchase {
  rules: Record<ApprovalDocument, MockRule>;
  rounds: MockRound[];
  // New ones first, like the API's uuidv7 order
  requisitions: MockRequisition[];
  // The last number given from the 'purchase.requisition' series
  counters: { requisition: number };
}

export function emptyPurchase(): MockPurchase {
  return {
    rules: { requisition: { levels: [], version: 0, updatedAt: null } },
    rounds: [],
    requisitions: [],
    counters: { requisition: 0 },
  };
}

function now(): string {
  return new Date().toISOString();
}

const ME = { id: OWNER.id, name: OWNER.fullName };

function conflict(code: ErrorCode): MockProblem {
  return new MockProblem(409, code);
}
```

- **The comment at the top says what the mock cannot show** (decision 50): the mock is always the Owner, so its own
  requisitions never wait.
- **`MockRule.version` starts at 0,** like the API's missing row: the page sends 0 the first time it saves, and the
  mock refuses anything else with `version_conflict`.
- **A round keeps its steps with their role's name** (`ApprovalStep.role.name`), like the API's `role_name` copy. A
  role deleted later still reads in the history, and `forgetRole()` only clears the id.
- **`MockRequisition` leaves out `lineCount` and `approval`:** both are worked out on read, so they can never disagree
  with the lines and the rounds.

### Approval levels

```ts
// --- Approval levels ----------------------------------------------------------------------------

export function toRule(data: WorkspaceData, document: ApprovalDocument): ApprovalRule {
  const rule = data.purchase.rules[document];
  return {
    document,
    levels: rule.levels.map((level) => {
      const role = data.people.roles.find((item) => item.id === level.roleId);
      return { minAmount: level.minAmount, role: { id: level.roleId, name: role?.name ?? '' } };
    }),
    version: rule.version,
    updatedAt: rule.updatedAt,
  };
}

// "Purchase manager from 20000.0000; Director from 100000.0000", like the API's audit row
export function describeLevels(rule: ApprovalRule): string | null {
  if (rule.levels.length === 0) return null;
  return rule.levels.map((level) => `${level.role.name} from ${level.minAmount}`).join('; ');
}

// The levels sent replace the old ones. Documents already waiting keep the levels they were
// submitted with (decision 13): their steps are copies.
export function saveRule(
  data: WorkspaceData,
  document: ApprovalDocument,
  input: ApprovalRuleInput,
): ApprovalRule {
  const rule = data.purchase.rules[document];
  if (rule.version !== input.version) throw conflict('version_conflict');
  const unknown = input.levels.flatMap((level, index) =>
    data.people.roles.some((role) => role.id === level.roleId) ? [] : [index],
  );
  if (unknown.length > 0) {
    throw new MockProblem(
      409,
      'approval_role_invalid',
      Object.fromEntries(
        unknown.map((index) => [`levels.${String(index)}.roleId`, ['approval_role_invalid']]),
      ),
    );
  }
  data.purchase.rules[document] = {
    // "20000" → "20000.0000": the way Postgres sends NUMERIC(19,4)
    levels: input.levels.map((level) => ({
      minAmount: addMoney(level.minAmount, '0'),
      roleId: level.roleId,
    })),
    version: rule.version + 1,
    updatedAt: now(),
  };
  return toRule(data, document);
}

// A role that a level names, or that a waiting round still needs, cannot be deleted (the API's
// roles.service.ts: approval_levels_role_fk and the waiting-step count)
export function approvalsNeedRole(data: WorkspaceData, roleId: string): boolean {
  return (
    Object.values(data.purchase.rules).some((rule) =>
      rule.levels.some((level) => level.roleId === roleId),
    ) ||
    data.purchase.rounds.some(
      (round) =>
        round.status === 'pending' &&
        round.steps.some((step) => step.decision === null && step.role.id === roleId),
    )
  );
}

// After a role is deleted: the decided steps keep its name and lose its id (ON DELETE SET NULL)
export function forgetRole(data: WorkspaceData, roleId: string): void {
  for (const round of data.purchase.rounds) {
    for (const step of round.steps) {
      if (step.role.id === roleId) step.role = { id: null, name: step.role.name };
    }
  }
}
```

- **`toRule()` reads the role's name on every read,** like the API's join, so a renamed role shows its new name on the
  levels page. (A round's steps keep the old name: they are history.)
- **`saveRule()` checks that every role exists,** with the error under the row's own field
  (`levels.2.roleId`), so the page marks the right row. The contract has already checked the order of the amounts
  and that each role is used once; the mock does not check them twice.
- **`"20000"` is stored as `"20000.0000"`,** the way Postgres sends `NUMERIC(19,4)`, so the mock's answers have the
  shape the page gets from the real API.
- **`approvalsNeedRole()` is the roles service's rule** (17a.3): a level names the role, or a waiting round has an
  undecided step for it. Decided steps do not stop a delete; `forgetRole()` then sets their role id to null, like
  `ON DELETE SET NULL`, and the card shows "(a deleted role)".

### A document's rounds

```ts
// --- A document's rounds ------------------------------------------------------------------------

function roundsOf(data: WorkspaceData, document: ApprovalDocument, id: string): MockRound[] {
  return data.purchase.rounds
    .filter((round) => round.document === document && round.documentId === id)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

function toRound(round: MockRound): ApprovalRound {
  return {
    id: round.id,
    status: round.status,
    amount: round.amount,
    submittedBy: round.submittedBy,
    submittedAt: round.submittedAt,
    closedAt: round.closedAt,
    steps: round.steps.map((step) => ({ ...step })),
  };
}

// Every round, newest first. The Owner may decide any waiting step, so canDecide is "a step waits".
function historyOf(data: WorkspaceData, document: ApprovalDocument, id: string): DocumentApproval {
  const rounds = roundsOf(data, document, id).map(toRound);
  const [newest] = rounds;
  const canDecide =
    newest?.status === 'pending' && newest.steps.some((step) => step.decision === null);
  return { rounds, canDecide };
}

// A new round with the levels the amount reaches (decision 13). The signed-in Owner's steps are
// written already approved, by the Owner, so the history says so; with no level the round has no
// step. Either way it is approved at once, and the requisition passes through pending. Returns
// how many steps it has.
function submitRound(data: WorkspaceData, target: MockRequisition): number {
  const at = now();
  const steps = levelsFor(toRule(data, 'requisition').levels, target.amount).map(
    (level, index): ApprovalStep => ({
      position: index + 1,
      minAmount: level.minAmount,
      role: level.role,
      decision: 'approved',
      decidedBy: ME,
      decidedAt: at,
      comment: null,
    }),
  );
  data.purchase.rounds.push({
    id: crypto.randomUUID(),
    document: 'requisition',
    documentId: target.id,
    status: 'approved',
    amount: target.amount,
    submittedBy: ME,
    submittedAt: at,
    closedAt: at,
    steps,
  });
  return steps.length;
}

// Approve or reject the step a document waits for. roundId is the round the page showed
// (decision 16): reopened or decided since, the answer is approval_not_pending. Returns the step
// decided and how many the round has.
export function decide(
  data: WorkspaceData,
  document: ApprovalDocument,
  id: string,
  decision: ApprovalDecision,
  input: { roundId: string; comment: string | null },
): { step: ApprovalStep; count: number } {
  const target = findRequisition(data, id);
  const round = data.purchase.rounds.find(
    (item) => item.id === input.roundId && item.document === document && item.documentId === id,
  );
  const step = round?.steps.find((item) => item.decision === null);
  if (round?.status !== 'pending' || !step) throw conflict('approval_not_pending');
  const at = now();
  Object.assign(step, { decision, decidedBy: ME, decidedAt: at, comment: input.comment });
  const decided = { step, count: round.steps.length };
  // A step in the middle leaves the round waiting for the next level
  if (decision === 'approved' && round.steps.some((item) => item.decision === null)) {
    return decided;
  }
  Object.assign(round, { status: decision, closedAt: at });
  setStatus(target, decision === 'approved' ? 'approved' : 'draft');
  return decided;
}

// The documents whose waiting step the reader may decide, oldest first. The Owner may decide every
// one, so that is every pending round.
export function waitingList(data: WorkspaceData): WaitingApproval[] {
  return data.purchase.rounds
    .filter((round) => round.status === 'pending')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .flatMap((round): WaitingApproval[] => {
      const step = round.steps.find((item) => item.decision === null);
      const requisition = data.purchase.requisitions.find((item) => item.id === round.documentId);
      if (!step || !requisition) return [];
      return [
        {
          document: round.document,
          id: requisition.id,
          number: requisition.number,
          date: requisition.date,
          subject: warehouseName(data, requisition.warehouseId),
          amount: round.amount,
          submittedBy: round.submittedBy,
          submittedAt: round.submittedAt,
          roundId: round.id,
          position: step.position,
          stepCount: round.steps.length,
        },
      ];
    });
}
```

- **`historyOf()` gives `canDecide: true` whenever a step waits,** because the Owner may decide any step. The API works
  it out per person (`mayDecide`); the mock has only one person.
- **`submitRound()` writes the Owner's steps already approved, by the Owner,** with no step when no level applies
  (decision 14). The card then says "An Owner submitted it" and lists who approved each level, as the API does.
- **`decide()` finds the round by the id the page sent,** and refuses with `approval_not_pending` when it is not the
  pending one (decision 16). A page that was open while someone reopened the document cannot approve a round that
  has ended.
- **A step in the middle returns early:** the round stays pending for the next level. Only a rejection or the last
  approval closes the round and moves the requisition (to draft or to approved).
- **`decide()` returns the step and the number of steps,** which is what the handler's audit row needs
  ("2 of 2", the role, the comment). Decision 51 says why the handler writes it.
- **`waitingList()` is every pending round, oldest first,** with the waiting step's position and the warehouse as
  the subject, like the API's `describe()`.

### Requisitions

```ts
// --- Requisitions -------------------------------------------------------------------------------

function warehouseName(data: WorkspaceData, id: string): string {
  return data.stock.warehouses.find((item) => item.id === id)?.name ?? id;
}

export function findRequisition(data: WorkspaceData, id: string): MockRequisition {
  const found = data.purchase.requisitions.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function requisitionSummaryOf(stored: MockRequisition): RequisitionSummary {
  return {
    id: stored.id,
    number: stored.number,
    date: stored.date,
    neededBy: stored.neededBy,
    warehouseId: stored.warehouseId,
    status: stored.status,
    amount: stored.amount,
    lineCount: stored.lines.length,
    requestedBy: stored.requestedBy,
    version: stored.version,
    updatedAt: stored.updatedAt,
  };
}

export function toRequisition(data: WorkspaceData, stored: MockRequisition): Requisition {
  return {
    ...stored,
    lineCount: stored.lines.length,
    approval: historyOf(data, 'requisition', stored.id),
  };
}

// Newest date first, like the API; the filters are the list's own
export function listRequisitions(
  data: WorkspaceData,
  query: { status?: RequisitionStatus | undefined; warehouseId?: string | undefined },
): MockRequisition[] {
  return newestFirst(
    data.purchase.requisitions.filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId),
    ),
  );
}

// The API's resolvePurchaseItems(): an active product or service, a unit that is its base unit or
// one of its packs, and a quantity that fits the unit. Every problem comes back at once.
function resolveLines(
  data: WorkspaceData,
  lines: readonly RequisitionLineInput[],
): RequisitionLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index): RequisitionLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, input.variantId);
    // Unknown, or its product or variant archived
    if (found?.product.archivedAt !== null || found.variant.archivedAt !== null) {
      at('variantId', 'purchase_item_invalid');
      return [];
    }
    const { product, variant } = found;
    const factor =
      input.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === input.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!fitsDecimals(input.quantity, decimalsOf(data, input.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const ref = refOf(product, variant);
    return [
      {
        ...ref,
        id: crypto.randomUUID(),
        productType: product.type,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        unitId: input.unitId,
        // "2" → "2.0000": the way Postgres sends NUMERIC(19,4)
        quantity: addQuantity(input.quantity, '0'),
        baseQuantity: toBaseQuantity(input.quantity, factor, decimalsOf(data, product.baseUnitId)),
        description: input.description ?? defaultLineDescription(ref),
        estimatedCost: addMoney(input.estimatedCost, '0'),
        amount: requisitionLineAmount(input.quantity, input.estimatedCost),
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// An active warehouse; a draft keeps the one it has even after it is archived (keptId)
function assertWarehouse(data: WorkspaceData, warehouseId: string, keptId: string | null): void {
  const found = data.stock.warehouses.find((item) => item.id === warehouseId);
  if (!found || (found.archivedAt !== null && found.id !== keptId)) {
    throw new MockProblem(409, 'purchase_warehouse_invalid', {
      warehouseId: ['purchase_warehouse_invalid'],
    });
  }
}

// Create (no `existing`, numbered at once: decision 19) or change a draft
export function saveRequisition(
  data: WorkspaceData,
  input: RequisitionInput,
  existing?: MockRequisition,
): MockRequisition {
  if (existing && existing.status !== 'draft') throw conflict('purchase_not_draft');
  assertWarehouse(data, input.warehouseId, existing?.warehouseId ?? null);
  const lines = resolveLines(data, input.lines);
  const fields = {
    date: input.date,
    neededBy: input.neededBy,
    warehouseId: input.warehouseId,
    note: input.note,
    lines,
    amount: requisitionAmount(lines),
    updatedAt: now(),
  };
  if (existing) {
    Object.assign(existing, fields, { version: existing.version + 1 });
    return existing;
  }
  data.purchase.counters.requisition += 1;
  const created: MockRequisition = {
    ...fields,
    id: crypto.randomUUID(),
    number: seriesNumber(
      data,
      'purchase.requisition',
      data.purchase.counters.requisition,
      input.date,
    ),
    status: 'draft',
    requestedBy: ME,
    version: 1,
  };
  data.purchase.requisitions.unshift(created);
  return created;
}

function setStatus(target: MockRequisition, status: RequisitionStatus): void {
  Object.assign(target, { status, version: target.version + 1, updatedAt: now() });
}

// Only a draft that was never submitted: approval history is never deleted (decision 25)
export function removeRequisition(data: WorkspaceData, target: MockRequisition): void {
  if (target.status !== 'draft' || roundsOf(data, 'requisition', target.id).length > 0) {
    throw conflict('purchase_was_submitted');
  }
  data.purchase.requisitions = data.purchase.requisitions.filter((item) => item.id !== target.id);
}

// Returns how many steps its round has
export function submitRequisition(data: WorkspaceData, target: MockRequisition): number {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  const steps = submitRound(data, target);
  setStatus(target, 'approved');
  return steps;
}

// Pending: the round ends as reopened. Approved: the round stays approved (it was), and the next
// submit starts a new round from the first level (decision 6).
export function reopenRequisition(data: WorkspaceData, target: MockRequisition): void {
  if (target.status !== 'pending' && target.status !== 'approved') {
    throw conflict('purchase_cannot_reopen');
  }
  if (target.status === 'pending') {
    const round = roundsOf(data, 'requisition', target.id).find(
      (item) => item.status === 'pending',
    );
    if (round) Object.assign(round, { status: 'reopened', closedAt: now() });
  }
  setStatus(target, 'draft');
}

export function cancelRequisition(target: MockRequisition): void {
  if (target.status !== 'draft' && target.status !== 'approved') {
    throw conflict('purchase_cannot_cancel');
  }
  setStatus(target, 'cancelled');
}
```

- **`resolveLines()` is the API's `resolvePurchaseItems()`:** an active product or service, its base unit or one of
  its packs, a quantity with no more decimals than the unit allows. Every bad line gets its own error under its own
  field, at once, so the form marks all of them.
- **The quantity is sent back as `"250.0000"` and the cost as `"475.4880"`,** the way Postgres sends them. The line's
  amount comes from `requisitionLineAmount()`, the contract's function that the form uses too, so the mock's total
  matches the form's to the paisa.
- **A draft keeps its warehouse after it is archived** (`keptId`), like the API's `assertWarehouse()`: the person can
  still finish the draft they started.
- **A new requisition gets its number at once** (decision 19) and is put first in the array, so a list of one day
  shows the newest first, like the API's order.
- **`removeRequisition()` refuses once any round exists,** whatever the status (decision 25): its approval history is
  never deleted. The page then offers Cancel instead.
- **`reopenRequisition()` closes a pending round as "reopened" but leaves an approved round approved:** it was
  approved, and the history says so. The next submit starts a new round from level 1 (decision 6).

### The cost a line starts with

```ts
// --- The cost a line starts with ----------------------------------------------------------------

// The API's CostLookupService: the variant's company-wide average cost (step 14) × the unit's
// factor, rounded to the 4 decimals a cost keeps; none for an item never bought or a service. A
// unit that is not this product's drops out, like an unknown variant.
export function lookupCosts(data: WorkspaceData, input: CostLookupInput): CostLookup {
  return {
    items: input.items.flatMap((item): CostLookupItem[] => {
      const found = findVariant(data, item.variantId);
      if (!found) return [];
      const { product } = found;
      const factor =
        item.unitId === product.baseUnitId
          ? '1'
          : product.units.find((pack) => pack.unitId === item.unitId)?.factor;
      if (factor === undefined) return [];
      const average = averageCostOf(data.stock, item.variantId);
      const cost = average === null ? null : toBaseQuantity(average, factor, 4);
      return [
        {
          variantId: item.variantId,
          unitId: item.unitId,
          cost,
          source: cost === null ? null : 'average_cost',
        },
      ];
    }),
  };
}
```

The variant's average cost per base unit × the unit's factor, rounded to 4 decimals. `toBaseQuantity()` is exactly
that sum (a 4-decimal number times a 6-decimal factor, rounded half up), the same trick `lookupPrices()` uses in 15b.
A service has no average, so its cost is `null` and the line says "No cost known: type one".

### The seed

```ts
// --- Seed ---------------------------------------------------------------------------------------

// The garments workspace's purchase desk (after the stock: the lines use its products and
// warehouses, and their costs its averages). Requisitions from ৳20,000 go to a purchase manager,
// from ৳1,00,000 to a director as well. Kamal is the purchase manager; nobody holds the Director
// role yet, so the bell for that level rings the Owner (decision 28). Sadia, a merchandiser, wrote
// three requisitions:
//   0001 two sewing machines (৳1,37,000): Kamal sent it back, so it is a draft again
//   0002 mailer bags (৳65,000): approved by Kamal
//   0003 jersey and buttons for an H&M order (৳2,11,240): Kamal approved step 1, and step 2
//        (Director) waits, for the Owner
// and the owner's own 0004 is a draft for buttons (৳1,944), below every level.
export function seedPurchase(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const role = (name: string) => data.people.roles.find((item) => item.name === name);
  const person = (name: string) => {
    const found = data.people.members.find((member) => member.fullName === name);
    if (!found) throw new Error(`The mock has no member ${name}`);
    return { id: found.userId, name: found.fullName };
  };
  const manager = role('Purchase manager');
  const director = role('Director');
  const [main] = data.stock.warehouses;
  if (!manager || !director || !main) return;
  const managerLevel = { minAmount: '20000.0000', roleId: manager.id };
  const directorLevel = { minAmount: '100000.0000', roleId: director.id };
  data.purchase.rules.requisition = {
    levels: [managerLevel, directorLevel],
    version: 1,
    updatedAt: now(),
  };

  const today = todayIn(data.settings.timezone);
  const sadia = person('Sadia Islam');
  const kamal = person('Kamal Uddin');
  // At ten in the morning (or the hour given), some days ago
  const daysAgo = (days: number, hour = 10) => {
    const moment = new Date(Date.now() - days * 86_400_000);
    moment.setHours(hour, 0, 0, 0);
    return moment.toISOString();
  };
  // A line of the product's first variant, in a unit by its code, at a cost per that unit
  const line = (code: string, unitCode: string, quantity: string, estimatedCost: string) => {
    const product = data.catalog.products.find((item) => item.code === code);
    const unit = data.catalog.units.find((item) => item.code === unitCode);
    const variant = product?.variants[0];
    if (!variant || !unit) throw new Error(`The mock catalog has no ${code} in ${unitCode}`);
    return { variantId: variant.id, unitId: unit.id, quantity, description: null, estimatedCost };
  };
  // A requisition Sadia wrote, `days` ago, in the Main store
  const write = (days: number, note: string | null, lines: RequisitionLineInput[]) => {
    const saved = saveRequisition(data, {
      date: shiftIsoDate(today, -days),
      neededBy: shiftIsoDate(today, 14),
      warehouseId: main.id,
      note,
      lines,
    });
    saved.requestedBy = sadia;
    return saved;
  };
  type Decided = Pick<ApprovalStep, 'decision' | 'decidedAt' | 'comment'>;
  const step = (
    position: number,
    level: { minAmount: string; roleId: string },
    name: string,
    decided: Decided = { decision: null, decidedAt: null, comment: null },
  ): ApprovalStep => ({
    position,
    minAmount: level.minAmount,
    role: { id: level.roleId, name },
    ...decided,
    decidedBy: decided.decision === null ? null : kamal,
  });
  // Sadia's round for the requisition, which then has the round's status
  const round = (
    target: MockRequisition,
    status: MockRound['status'],
    submittedAt: string,
    steps: ApprovalStep[],
  ) => {
    const closedAt = status === 'pending' ? null : (steps.at(-1)?.decidedAt ?? submittedAt);
    data.purchase.rounds.push({
      id: crypto.randomUUID(),
      document: 'requisition',
      documentId: target.id,
      status,
      amount: target.amount,
      submittedBy: sadia,
      submittedAt,
      closedAt,
      steps,
    });
    target.status =
      status === 'rejected' ? 'draft' : status === 'approved' ? 'approved' : 'pending';
  };

  // The oldest first: the numbers run by date
  const machines = write(5, 'Two machines for the new sewing line in Gazipur.', [
    line('P-00005', 'pcs', '2', '68500'),
  ]);
  round(machines, 'rejected', daysAgo(4), [
    step(1, managerLevel, manager.name, {
      decision: 'rejected',
      decidedAt: daysAgo(3, 15),
      comment: 'Buy one machine now, not two: the second line starts in January.',
    }),
    // The round ended before it: "Not decided"
    step(2, directorLevel, director.name),
  ]);
  const mailers = write(4, null, [line('P-00004', 'carton', '20', '3250')]);
  round(mailers, 'approved', daysAgo(4, 11), [
    step(1, managerLevel, manager.name, {
      decision: 'approved',
      decidedAt: daysAgo(3, 9),
      comment: null,
    }),
  ]);
  const jersey = write(
    2,
    'For buyer PO-HM-2026-1187: 2,000 polo shirts in navy. Cutting starts in two weeks.',
    [line('P-00002', 'm', '400', '520'), line('P-00003', 'gross', '50', '64.80')],
  );
  // Three hours ago: the bell's newest unread notifications stay the seed's own (workspace-data.ts)
  const kamalApproved = new Date(Date.now() - 3 * 3_600_000).toISOString();
  round(jersey, 'pending', daysAgo(2, 9), [
    step(1, managerLevel, manager.name, {
      decision: 'approved',
      decidedAt: kamalApproved,
      comment: 'Fine for the November production plan',
    }),
    step(2, directorLevel, director.name),
  ]);
  // The owner's own, never submitted
  saveRequisition(data, {
    date: today,
    neededBy: null,
    warehouseId: main.id,
    note: null,
    lines: [line('P-00003', 'gross', '30', '64.80')],
  });

  // Kamal's approval rang the next level: nobody holds Director, so the Owners
  data.notifications.push({
    id: crypto.randomUUID(),
    type: 'approval.requested',
    params: { document: 'requisition', id: jersey.id, number: jersey.number },
    readAt: null,
    createdAt: kamalApproved,
  });
  data.notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
```

- **It runs last in `seed()`:** its lines use the catalog's products, the stock's warehouses and averages, and its
  rounds name the team's members. Run earlier, it finds no Main store or no Kamal.
- **The requisitions are written oldest first,** so their numbers run in date order (0001 is five days old, 0004 is
  today's).
- **`round()` sets the requisition's status from the round's,** which is the rule of decision 26: a requisition's
  status follows its newest round (rejected → draft, approved → approved, pending → pending).
- **Kamal's approval is three hours old,** so the new notification sits between the seed's two unread ones and its
  read one. The list is sorted again by time after the push: the bell shows the newest first, and the mock's list is
  already in that order everywhere else.
- **Decision 49 is why the bell has this notification at all:** step 2 waits for a Director, nobody holds Director,
  so the bell rang the Owners.

### `mocks/stock-data.ts`: the average cost for the lookup

```diff
@@ -144,6 +144,12 @@ function valueOf(stock: MockStock, variantId: string): ValueState {
   return stock.values.get(variantId) ?? { quantity: '0', value: '0.0000', unitCost: null };
 }
 
+// The company-wide average cost per base unit, or null for an item never bought (and a service).
+// Step 17a's cost lookup starts a purchase line with it.
+export function averageCostOf(stock: MockStock, variantId: string): string | null {
+  return valueOf(stock, variantId).unitCost;
+}
+
 // Writes a movement and adds it to its variant's value, like the trigger
 function pushMovement(stock: MockStock, movement: MockMovement): void {
   stock.movements.push(movement);
```

`valueOf()` stays private: the cost lookup needs only the average, and exporting the whole value state would let a
purchase file change it by mistake.

### `mocks/people-data.ts`: the purchase desk

```diff
@@ -109,9 +109,36 @@ export function seedPeople(workspace: Workspace): People {
       };
     }),
   ];
+  if (workspace.slug === 'rahman-garments') addPurchaseDesk(roles, members);
   return { roles, members, invitations: [] };
 }
 
+// Step 17a: the approval levels' roles, and the people requisition-data.ts's seed names. Added
+// after the generated members, so the team page's first rows and the roles they hold stay as they
+// were. Nobody holds Director yet: the bell for that level goes to the Owners (decision 28).
+function addPurchaseDesk(roles: MockRole[], members: Member[]): void {
+  const writer = roles.find((item) => item.name === 'Merchandiser');
+  const manager = role(
+    'Purchase manager',
+    ['purchase.supplier.manage', 'purchase.supplier.balance', 'purchase.requisition.manage'],
+    'Approves requisitions and buys from suppliers',
+  );
+  roles.push(manager, role('Director', [], 'Approves large purchases'));
+  const member = (fullName: string, email: string, held: MockRole | undefined): Member => ({
+    membershipId: crypto.randomUUID(),
+    userId: crypto.randomUUID(),
+    fullName,
+    email,
+    roles: held ? [{ id: held.id, name: held.name }] : [],
+    version: 1,
+    joinedAt: new Date(Date.now() - 200 * DAY_MS).toISOString(),
+  });
+  members.push(
+    member('Sadia Islam', 'sadia.islam@rahman-garments.com', writer),
+    member('Kamal Uddin', 'kamal.uddin@rahman-garments.com', manager),
+  );
+}
+
 export function toRole(people: People, entry: MockRole): Role {
   return {
     ...entry,
```

The two roles and two members are added after the 240 generated members, and only in the garments workspace. The
generated members take their roles from the first three custom roles by position (`custom[index % 3]`), so adding
roles before them would give half the team different roles, and the team test that opens "Abdul Akter" would find
him with another role.

### `mocks/workspace-data.ts`: the two new parts of a workspace

```diff
@@ -40,6 +40,7 @@ import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import type { MockExport } from './report-data';
+import { emptyPurchase, type MockPurchase, seedPurchase } from './requisition-data';
 import { emptyReturns, type MockReturns } from './return-data';
 import { emptySales, type MockSales, seedSales } from './sales-data';
 import {
@@ -48,6 +49,7 @@ import {
   seedSalesDocuments,
 } from './sales-document-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
+import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -83,6 +85,10 @@ export interface WorkspaceData {
   salesAccounts: SalesAccounts;
   // The PDFs, emails and share links of the documents a customer receives (step 16)
   documentOutput: MockDocumentOutput;
+  // Suppliers and their groups (step 17a)
+  suppliers: MockSuppliers;
+  // Approval levels and rounds, and requisitions (step 17a)
+  purchase: MockPurchase;
 }
 
 function now(): string {
@@ -147,17 +153,22 @@ function seed(workspace: Workspace): WorkspaceData {
     returns: emptyReturns(),
     salesAccounts: { returns: null },
     documentOutput: emptyDocumentOutput(),
+    suppliers: emptySuppliers(),
+    purchase: emptyPurchase(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   data.salesAccounts = seedSalesAccounts(data.accounts);
-  // Before the journal: its receivable lines name the customers
+  // Before the journal: its receivable lines name the customers, its payable lines the suppliers
   seedSales(data, garments);
+  seedSuppliers(data, garments);
   if (garments) seedJournal(data);
   seedStock(data, garments);
   // After the stock: an order is sent from a warehouse
   seedSalesDocuments(data, garments);
   // After the quotations: the history belongs to one of them
   seedDocumentOutput(data, garments);
+  // After the stock and the team: the lines' costs are its averages, the rounds name members
+  seedPurchase(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -220,6 +231,8 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.catalog = emptyCatalog();
   // The VAT rates come with the setup job too (settleSetup); customers are the company's own
   data.sales = emptySales();
+  data.suppliers = emptySuppliers();
+  data.purchase = emptyPurchase();
   // Sign-up gives a new workspace its Main store, in its one branch (like auth.service.ts)
   data.stock = emptyStock();
   const [first] = data.branches;
@@ -322,6 +335,8 @@ function usedNumbers(data: WorkspaceData, documentType: DocumentType, period: st
   if (documentType === 'sales.return') return data.returns.counters.salesReturn;
   if (documentType === 'sales.credit_note') return data.returns.counters.creditNote;
   if (documentType === 'sales.refund') return data.returns.counters.refund;
+  if (documentType === 'purchase.supplier') return data.suppliers.lastCode;
+  if (documentType === 'purchase.requisition') return data.purchase.counters.requisition;
   return 0;
 }
 
```

- **The seed order** has a comment at each step that says why it comes there: suppliers before the journal, the
  purchase desk last.
- **`startFresh()` empties both,** so a signed-up workspace has no suppliers and no approval levels, like a new
  workspace on the API.
- **`usedNumbers()` knows the two new series,** so Settings → Numbering shows `S-00004` and `PR-…-0005` as the next
  numbers in the garments workspace.

### `mocks/sales-data.ts`: one code per party, and the party by side

```diff
@@ -10,6 +10,7 @@ import {
   formatDocumentNumber,
   type LanguageCode,
   type PartyRef,
+  type PartyRole,
   periodOf,
   type PriceList,
   type PriceListItem,
@@ -552,10 +553,12 @@ export function saveCustomer(
     }
   }
   const code = input.code ?? existing?.code ?? newCode(data);
-  const taken = sales.customers.some(
-    (item) => item.id !== existing?.id && item.code.toLowerCase() === code.toLowerCase(),
-  );
-  if (taken) throw fieldProblem(409, 'customer_code_taken', 'code');
+  // One code per party (step 17a): a supplier's code is taken too, except this party's own
+  const same = (item: { id: string; code: string }) =>
+    item.id !== existing?.id && item.code.toLowerCase() === code.toLowerCase();
+  if (sales.customers.some(same) || data.suppliers.suppliers.some(same)) {
+    throw fieldProblem(409, 'customer_code_taken', 'code');
+  }
   const own = new Set(existing?.addresses.map((address) => address.id));
   const addresses = input.addresses.map((address) => ({
     id: address.id !== null && own.has(address.id) ? address.id : crypto.randomUUID(),
@@ -590,8 +593,10 @@ export function saveCustomer(
 }
 
 // The journal keeps a party's code and name on each line, and so does each sales document (step
-// 15b); the API joins them on read. After a rename they show the new name, like the API's.
-export function refreshPartyRefs(data: WorkspaceData, saved: MockCustomer): void {
+// 15b); the API joins them on read. After a rename they show the new name, like the API's. A
+// supplier is renamed the same way (step 17a): its payable lines, and its sales documents when it
+// is a customer too.
+export function refreshPartyRefs(data: WorkspaceData, saved: PartyRef): void {
   const ref = { id: saved.id, code: saved.code, name: saved.name };
   for (const entry of data.journal.entries) {
     for (const line of entry.lines) {
@@ -620,24 +625,29 @@ function salesDocumentsOf(data: WorkspaceData): { customer: PartyRef }[] {
   ];
 }
 
-// Only a customer no entry and no sales document names, drafts included (the API's
+// Only a customer no receivable line and no sales document names, drafts included (the API's
 // journal_lines_party_fk, step 15b's quotations/sales_orders/deliveries_customer_fk, step 15c's
-// invoices/receipts_customer_fk, and step 15d's sales_returns/credit_notes/refunds_customer_fk)
+// invoices/receipts_customer_fk, and step 15d's sales_returns/credit_notes/refunds_customer_fk).
+// Receivable lines only: a party that is also a supplier keeps its payable lines (step 17a).
 export function assertCustomerUnused(data: WorkspaceData, id: string): void {
   const used =
-    data.journal.entries.some((entry) => entry.lines.some((line) => line.party?.id === id)) ||
-    salesDocumentsOf(data).some((document) => document.customer.id === id);
+    data.journal.entries.some((entry) =>
+      entry.lines.some((line) => line.party?.id === id && isReceivable(data, line.accountId)),
+    ) || salesDocumentsOf(data).some((document) => document.customer.id === id);
   if (used) throw new MockProblem(409, 'customer_in_use');
 }
 
-// A line's customer as the journal shows it. Unknown, archived (unless allowArchived) or not a
-// customer: undefined, and checkParties() answers journal_party_invalid.
+// A line's party as the journal shows it: a customer on the receivable, a supplier on the payable
+// (step 17a). Unknown, archived (unless allowArchived) or not on that side: undefined, and
+// checkParties() answers journal_party_invalid.
 export function partyRefOf(
-  sales: MockSales,
+  data: WorkspaceData,
+  role: PartyRole,
   partyId: string,
   allowArchived = false,
 ): PartyRef | undefined {
-  const found = sales.customers.find((item) => item.id === partyId);
+  const side = role === 'customer' ? data.sales.customers : data.suppliers.suppliers;
+  const found = side.find((item) => item.id === partyId);
   if (!found || (found.archivedAt !== null && !allowArchived)) return undefined;
   return { id: found.id, code: found.code, name: found.name };
 }
```

- **A customer's code is checked against the suppliers too,** except the party's own supplier side. It is written out
  here, not imported from `supplier-data.ts`: that file already imports this one (for `MockCustomer`), and the import
  the other way would make a circle.
- **`refreshPartyRefs()` takes a `PartyRef`,** so a supplier rename uses it too: the journal keeps a party's code and
  name on each line.
- **`assertCustomerUnused()` counts receivable lines only.** For a customer-only party nothing changes (only
  receivable lines can name it). For a party on both sides, its payable lines must not stop the customer side from
  being deleted: those belong to the supplier, which stays.
- **`partyRefOf()` takes the side.** A line on the payable must name a supplier: an id that is only a customer is
  `journal_party_invalid`, like the API's check by role (decision 27).

### `mocks/journal-data.ts`: the payable is kept by supplier

```diff
@@ -7,7 +7,6 @@ import {
   fiscalYearOf,
   formatDocumentNumber,
   isNegativeMoney,
-  isPartyAccountPurpose,
   isSalesJournalSource,
   isStockJournalSource,
   isZeroMoney,
@@ -20,6 +19,8 @@ import {
   negateMoney,
   type OpeningBalances,
   type OpeningBalancesInput,
+  partyRoleOf,
+  type PartyRole,
   periodOf,
   shiftIsoDate,
   type StockJournalSource,
@@ -82,26 +83,31 @@ export function stockAccountIds(data: WorkspaceData): Set<string> {
 type PartyCode = 'journal_party_required' | 'journal_party_not_allowed' | 'journal_party_invalid';
 
 // The party rule (step 15a, the API's checkParties()): a line on the receivable names a customer,
-// and no other line names anyone. Each wrong line gets its own code under lines.N.partyId, so the
-// form marks every row at once. allowMissing: a draft, or a reversal of an entry from before 15a.
+// a line on the payable a supplier (step 17a), and no other line names anyone. Each wrong line gets
+// its own code under lines.N.partyId, so the form marks every row at once. allowMissing: a draft,
+// or a reversal of an entry from before 15a.
 export function partyIssues(
   data: WorkspaceData,
   lines: readonly { accountId: string; partyId: string | null }[],
   { allowMissing = false, allowArchived = false } = {},
 ): { index: number; code: PartyCode }[] {
   return lines.flatMap((line, index): { index: number; code: PartyCode }[] => {
-    const account = data.accounts.find((item) => item.id === line.accountId);
-    const perParty = isPartyAccountPurpose(account?.purpose ?? null);
+    const role = roleOf(data, line.accountId);
     if (line.partyId === null) {
-      return perParty && !allowMissing ? [{ index, code: 'journal_party_required' }] : [];
+      return role !== null && !allowMissing ? [{ index, code: 'journal_party_required' }] : [];
     }
-    if (!perParty) return [{ index, code: 'journal_party_not_allowed' }];
-    return partyRefOf(data.sales, line.partyId, allowArchived)
+    if (role === null) return [{ index, code: 'journal_party_not_allowed' }];
+    return partyRefOf(data, role, line.partyId, allowArchived)
       ? []
       : [{ index, code: 'journal_party_invalid' }];
   });
 }
 
+// The side of the parties an account is kept by: customer, supplier, or none (null)
+function roleOf(data: WorkspaceData, accountId: string): PartyRole | null {
+  return partyRoleOf(data.accounts.find((item) => item.id === accountId)?.purpose ?? null);
+}
+
 export function partyProblem(issues: readonly { index: number; code: PartyCode }[]): MockProblem {
   return new MockProblem(
     409,
@@ -144,18 +150,24 @@ export function checkLines(
   if (parties.length > 0) throw partyProblem(parties);
 }
 
-// The stored lines: the customer's code and name kept with its id (refreshPartyRefs() keeps them
+// The stored lines: the party's code and name kept with its id (refreshPartyRefs() keeps them
 // current after a rename). Checked before this, so an id that finds nothing is not expected.
 function toLines(data: WorkspaceData, lines: readonly LineIn[]): JournalLine[] {
-  return lines.map((line) => ({
-    id: crypto.randomUUID(),
-    accountId: line.accountId,
-    branchId: line.branchId,
-    party: line.partyId === null ? null : (partyRefOf(data.sales, line.partyId, true) ?? null),
-    description: line.description,
-    debit: fixed(line.debit),
-    credit: fixed(line.credit),
-  }));
+  return lines.map((line) => {
+    const role = roleOf(data, line.accountId);
+    return {
+      id: crypto.randomUUID(),
+      accountId: line.accountId,
+      branchId: line.branchId,
+      party:
+        line.partyId === null || role === null
+          ? null
+          : (partyRefOf(data, role, line.partyId, true) ?? null),
+      description: line.description,
+      debit: fixed(line.debit),
+      credit: fixed(line.credit),
+    };
+  });
 }
 
 // A stored line back as input: what a reversal or a post re-checks
@@ -357,21 +369,22 @@ export function ledgerOf(data: WorkspaceData, accountId: string, query: LedgerQu
   return pageOf(data, (line) => line.accountId === accountId, query);
 }
 
-// A customer's statement (step 15a): the same page over the receivable lines that name it
-export function statementOf(data: WorkspaceData, partyId: string, query: LedgerQuery): LedgerPage {
-  if (!data.sales.customers.some((item) => item.id === partyId)) {
-    throw new MockProblem(404, 'not_found');
-  }
-  const receivable = new Set(
+// A customer's statement (step 15a), or a supplier's (step 17a): the same page over the lines of
+// that side's account that name the party. A party that is both has two statements, one per side.
+export function statementOf(
+  data: WorkspaceData,
+  partyId: string,
+  query: LedgerQuery,
+  role: PartyRole = 'customer',
+): LedgerPage {
+  const side = role === 'customer' ? data.sales.customers : data.suppliers.suppliers;
+  if (!side.some((item) => item.id === partyId)) throw new MockProblem(404, 'not_found');
+  const accounts = new Set(
     data.accounts
-      .filter((account) => account.purpose === 'accounts_receivable')
+      .filter((account) => partyRoleOf(account.purpose) === role)
       .map((account) => account.id),
   );
-  return pageOf(
-    data,
-    (line) => line.party?.id === partyId && receivable.has(line.accountId),
-    query,
-  );
+  return pageOf(data, (line) => line.party?.id === partyId && accounts.has(line.accountId), query);
 }
 
 // The posted lines that match, in date order, with the running balance and the balances around
@@ -629,6 +642,12 @@ export function seedJournal(data: WorkspaceData): void {
     if (!found) throw new Error(`The mock has no customer ${name}`);
     return found.id;
   };
+  // Step 17a: a payable line names its supplier (seedSuppliers() made them)
+  const supplier = (name: string) => {
+    const found = data.suppliers.suppliers.find((item) => item.name.startsWith(name));
+    if (!found) throw new Error(`The mock has no supplier ${name}`);
+    return found.id;
+  };
   const line = (
     code: string,
     debit: string,
@@ -659,7 +678,7 @@ export function seedJournal(data: WorkspaceData): void {
   postNew(data, {
     date: lastYearDay(150),
     narration: 'Fabrics and yarn used for the H&M order',
-    lines: [line('5110', '2100000', '0'), line('2110', '0', '2100000')],
+    lines: [line('5110', '2100000', '0'), line('2110', '0', '2100000', null, supplier('Meghna'))],
   });
   postNew(data, {
     date: lastYearDay(300),
```

- **`roleOf()` is `partyRoleOf()` of the line's account:** customer, supplier or none. The party rule is then the
  same three cases as before, with the side added: no party where one is needed, a party where none is allowed, or a
  party that is not on that side.
- **`toLines()` reads the ref from the right side,** so a payable line keeps the supplier's code and name.
- **`statementOf()` takes the side,** with `'customer'` as the default so the customer's handler does not change.
  The accounts are picked by `partyRoleOf()`, not by naming `accounts_receivable`, so a later per-party account would
  need no change here.
- **Last year's yarn line names Meghna.** This is the line that stopped the mock from starting.

### `mocks/handlers.ts`: the routes

```diff
@@ -175,6 +175,25 @@ import {
   toQuotation,
   updateOrder,
 } from './sales-document-data';
+import {
+  approvalsNeedRole,
+  cancelRequisition,
+  decide,
+  describeLevels,
+  findRequisition,
+  forgetRole,
+  listRequisitions,
+  lookupCosts,
+  removeRequisition,
+  reopenRequisition,
+  requisitionSummaryOf,
+  saveRequisition,
+  saveRule,
+  submitRequisition,
+  toRequisition,
+  toRule,
+  waitingList,
+} from './requisition-data';
 import { settleSetup, startSetup } from './setup-data';
 import {
   batchReport,
@@ -196,6 +215,21 @@ import {
   valuationSummary,
   warehouse as newWarehouse,
 } from './stock-data';
+import {
+  assertSupplierGroupNameFree,
+  copyToCustomer,
+  copyToSupplier,
+  findSupplier,
+  findSupplierGroup,
+  listSuppliers,
+  makeCustomer,
+  makeSupplier,
+  removeSupplier,
+  saveSupplier,
+  supplierSummaryOf,
+  toSupplier,
+  toSupplierGroup,
+} from './supplier-data';
 import {
   assertCodeFree,
   checkVersion,
@@ -523,7 +557,9 @@ export const handlers = [
         data.people.invitations.some(
           (invitation) => isOpen(invitation) && invitation.roles.some((held) => held.id === id),
         );
-      if (inUse) throw new MockProblem(409, 'role_in_use');
+      // Step 17a: an approval level names it, or a waiting round still needs it
+      if (inUse || approvalsNeedRole(data, id)) throw new MockProblem(409, 'role_in_use');
+      forgetRole(data, id);
       data.people.roles = data.people.roles.filter((other) => other.id !== id);
       record(data, 'role.deleted', 'role', id, { name: { from: target.name, to: null } });
       return reply(routes.roles.remove, undefined);
@@ -2272,6 +2308,8 @@ export const handlers = [
       const saved = saveCustomer(data, body, target);
       data.sales.customers = data.sales.customers.map((item) => (item.id === id ? saved : item));
       refreshPartyRefs(data, saved);
+      // A party that is also a supplier is one row: the supplier page shows the same name
+      copyToSupplier(data, saved);
       record(
         data,
         'customer.updated',
@@ -2309,6 +2347,8 @@ export const handlers = [
             'customer',
             id,
           );
+          // Archived is the party's (decision 10): hidden from purchase documents too
+          copyToSupplier(data, target);
         }
         return reply(routes.customers[action], toCustomer(data, target));
       }),
@@ -2325,6 +2365,15 @@ export const handlers = [
       checkVersion(target.version, version);
       assertCustomerUnused(data, id);
       data.sales.customers = data.sales.customers.filter((item) => item.id !== id);
+      // A party that is also a supplier stays, as a supplier: only its customer side goes
+      const supplier = data.suppliers.suppliers.find((item) => item.id === id);
+      if (supplier) {
+        Object.assign(supplier, {
+          isCustomer: false,
+          version: supplier.version + 1,
+          updatedAt: new Date().toISOString(),
+        });
+      }
       record(
         data,
         'customer.deleted',
@@ -2354,6 +2403,27 @@ export const handlers = [
     }),
   ),
 
+  // "Make customer too" on a supplier's page (step 17a)
+  mock(
+    routes.customers.fromSupplier,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.customers.fromSupplier.params.parse(params);
+      const { version } = await readBody(routes.customers.fromSupplier.body, request);
+      const data = current();
+      const target = findSupplier(data, id);
+      checkVersion(target.version, version);
+      const created = makeCustomer(data, target);
+      record(
+        data,
+        'customer.created',
+        'customer',
+        id,
+        diff({}, { code: created.code, name: created.name }),
+      );
+      return reply(routes.customers.fromSupplier, toCustomer(data, created));
+    }),
+  ),
+
   mock(routes.customerGroups.list, () => {
     const { sales } = current();
     return reply(routes.customerGroups.list, {
@@ -3332,4 +3402,431 @@ export const handlers = [
       return reply(routes.publicDocuments.get, shared);
     }),
   ),
+
+  // ---------------------------------------------------------------------------------------------
+  // Suppliers, approvals and requisitions (step 17a)
+
+  mock(routes.suppliers.list, async ({ request }) => {
+    const query = readQuery(routes.suppliers.list.query, request);
+    const data = current();
+    const page = pageOf(listSuppliers(data, query), query);
+    if (query.cursor !== undefined) await delay(300);
+    return reply(routes.suppliers.list, {
+      items: page.items.map((item) => supplierSummaryOf(data, item)),
+      nextCursor: page.nextCursor,
+    });
+  }),
+
+  mock(
+    routes.suppliers.get,
+    guarded(({ params }) => {
+      const { id } = routes.suppliers.get.params.parse(params);
+      const data = current();
+      return reply(routes.suppliers.get, toSupplier(data, findSupplier(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.suppliers.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.suppliers.create.body, request);
+      const data = current();
+      const saved = saveSupplier(data, body);
+      data.suppliers.suppliers.push(saved);
+      record(
+        data,
+        'supplier.created',
+        'supplier',
+        saved.id,
+        diff({}, { code: saved.code, name: saved.name }),
+      );
+      await delay();
+      return reply(routes.suppliers.create, toSupplier(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.suppliers.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.suppliers.update.params.parse(params);
+      const { version, ...body } = await readBody(routes.suppliers.update.body, request);
+      const data = current();
+      const target = findSupplier(data, id);
+      checkVersion(target.version, version);
+      const saved = saveSupplier(data, body, target);
+      data.suppliers.suppliers = data.suppliers.suppliers.map((item) =>
+        item.id === id ? saved : item,
+      );
+      // The journal's lines and the customer side show the new name
+      refreshPartyRefs(data, saved);
+      copyToCustomer(data, saved);
+      record(
+        data,
+        'supplier.updated',
+        'supplier',
+        id,
+        diff(
+          { code: target.code, name: target.name, paymentTermsDays: target.paymentTermsDays },
+          { code: saved.code, name: saved.name, paymentTermsDays: saved.paymentTermsDays },
+        ),
+      );
+      await delay();
+      return reply(routes.suppliers.update, toSupplier(data, saved));
+    }),
+  ),
+
+  // "Make supplier too" on a customer's page
+  mock(
+    routes.suppliers.fromCustomer,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.suppliers.fromCustomer.params.parse(params);
+      const { version } = await readBody(routes.suppliers.fromCustomer.body, request);
+      const data = current();
+      const target = findCustomer(data.sales, id);
+      checkVersion(target.version, version);
+      const created = makeSupplier(data, target);
+      record(
+        data,
+        'supplier.created',
+        'supplier',
+        id,
+        diff({}, { code: created.code, name: created.name }),
+      );
+      return reply(routes.suppliers.fromCustomer, toSupplier(data, created));
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.suppliers[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.suppliers[action].params.parse(params);
+        const { version } = await readBody(routes.suppliers[action].body, request);
+        const data = current();
+        const target = findSupplier(data, id);
+        checkVersion(target.version, version);
+        if ((target.archivedAt !== null) !== (action === 'archive')) {
+          Object.assign(target, {
+            archivedAt: action === 'archive' ? new Date().toISOString() : null,
+            version: version + 1,
+            updatedAt: new Date().toISOString(),
+          });
+          copyToCustomer(data, target);
+          record(
+            data,
+            action === 'archive' ? 'supplier.archived' : 'supplier.restored',
+            'supplier',
+            id,
+          );
+        }
+        return reply(routes.suppliers[action], toSupplier(data, target));
+      }),
+    ),
+  ),
+
+  mock(
+    routes.suppliers.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.suppliers.remove.params.parse(params);
+      const { version } = readQuery(routes.suppliers.remove.query, request);
+      const data = current();
+      const target = findSupplier(data, id);
+      checkVersion(target.version, version);
+      removeSupplier(data, target);
+      record(
+        data,
+        'supplier.deleted',
+        'supplier',
+        id,
+        diff({ code: target.code, name: target.name }, { code: null, name: null }),
+      );
+      return reply(routes.suppliers.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.suppliers.statement,
+    guarded(({ request, params }) => {
+      const { id } = routes.suppliers.statement.params.parse(params);
+      const query = readQuery(routes.suppliers.statement.query, request);
+      return reply(routes.suppliers.statement, statementOf(current(), id, query, 'supplier'));
+    }),
+  ),
+
+  mock(routes.supplierGroups.list, () => {
+    const data = current();
+    return reply(routes.supplierGroups.list, {
+      items: data.suppliers.groups
+        .toSorted((a, b) => a.name.localeCompare(b.name))
+        .map((item) => toSupplierGroup(data, item)),
+    });
+  }),
+
+  mock(
+    routes.supplierGroups.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.supplierGroups.create.body, request);
+      const data = current();
+      assertSupplierGroupNameFree(data, body.name);
+      const created = {
+        id: crypto.randomUUID(),
+        name: body.name,
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.suppliers.groups.push(created);
+      record(data, 'supplier_group.created', 'supplier_group', created.id, {
+        name: { from: null, to: created.name },
+      });
+      return reply(routes.supplierGroups.create, toSupplierGroup(data, created));
+    }),
+  ),
+
+  mock(
+    routes.supplierGroups.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.supplierGroups.update.params.parse(params);
+      const { version, name } = await readBody(routes.supplierGroups.update.body, request);
+      const data = current();
+      const target = findSupplierGroup(data, id);
+      checkVersion(target.version, version);
+      assertSupplierGroupNameFree(data, name, id);
+      const before = target.name;
+      Object.assign(target, { name, version: version + 1, updatedAt: new Date().toISOString() });
+      record(
+        data,
+        'supplier_group.updated',
+        'supplier_group',
+        id,
+        diff({ name: before }, { name }),
+      );
+      return reply(routes.supplierGroups.update, toSupplierGroup(data, target));
+    }),
+  ),
+
+  mock(
+    routes.supplierGroups.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.supplierGroups.remove.params.parse(params);
+      const { version } = readQuery(routes.supplierGroups.remove.query, request);
+      const data = current();
+      const target = findSupplierGroup(data, id);
+      checkVersion(target.version, version);
+      // Archived suppliers count too (the API's parties_supplier_group_fk)
+      if (data.suppliers.suppliers.some((item) => item.groupId === id)) {
+        throw new MockProblem(409, 'supplier_group_in_use');
+      }
+      data.suppliers.groups = data.suppliers.groups.filter((item) => item.id !== id);
+      record(data, 'supplier_group.deleted', 'supplier_group', id, {
+        name: { from: target.name, to: null },
+      });
+      return reply(routes.supplierGroups.remove, undefined);
+    }),
+  ),
+
+  mock(routes.approvalRules.list, () =>
+    reply(routes.approvalRules.list, { items: [toRule(current(), 'requisition')] }),
+  ),
+
+  mock(
+    routes.approvalRules.update,
+    guarded(async ({ request, params }) => {
+      const { document } = routes.approvalRules.update.params.parse(params);
+      const body = await readBody(routes.approvalRules.update.body, request);
+      const data = current();
+      const before = describeLevels(toRule(data, document));
+      const saved = saveRule(data, document, body);
+      record(data, 'approval_rules.changed', 'workspace', workspace.tenantId, {
+        [document]: { from: before, to: describeLevels(saved) },
+      });
+      return reply(routes.approvalRules.update, saved);
+    }),
+  ),
+
+  mock(routes.approvals.waiting, ({ request }) => {
+    const query = readQuery(routes.approvals.waiting.query, request);
+    return reply(routes.approvals.waiting, pageOf(waitingList(current()), query));
+  }),
+
+  mock(routes.approvals.waitingCount, () =>
+    reply(routes.approvals.waitingCount, { count: waitingList(current()).length }),
+  ),
+
+  ...(['approve', 'reject'] as const).map((action) =>
+    mock(
+      routes.approvals[action],
+      guarded(async ({ request, params }) => {
+        const { document, id } = routes.approvals[action].params.parse(params);
+        const body = await readBody(routes.approvals[action].body, request);
+        const data = current();
+        const decision = action === 'approve' ? 'approved' : 'rejected';
+        const { step, count } = decide(data, document, id, decision, body);
+        record(
+          data,
+          action === 'approve' ? 'approval.approved' : 'approval.rejected',
+          'requisition',
+          id,
+          diff(
+            {},
+            {
+              step: `${String(step.position)} of ${String(count)}`,
+              role: step.role.name,
+              comment: body.comment,
+            },
+          ),
+        );
+        await delay();
+        return reply(routes.approvals[action], undefined);
+      }),
+    ),
+  ),
+
+  mock(routes.requisitions.list, ({ request }) => {
+    const query = readQuery(routes.requisitions.list.query, request);
+    const page = pageOf(listRequisitions(current(), query), query);
+    return reply(routes.requisitions.list, {
+      items: page.items.map(requisitionSummaryOf),
+      nextCursor: page.nextCursor,
+    });
+  }),
+
+  mock(
+    routes.requisitions.get,
+    guarded(({ params }) => {
+      const { id } = routes.requisitions.get.params.parse(params);
+      const data = current();
+      return reply(routes.requisitions.get, toRequisition(data, findRequisition(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.requisitions.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.requisitions.create.body, request);
+      const data = current();
+      const created = saveRequisition(data, body);
+      record(
+        data,
+        'requisition.created',
+        'requisition',
+        created.id,
+        diff({}, { number: created.number, amount: created.amount }),
+      );
+      await delay();
+      return reply(routes.requisitions.create, toRequisition(data, created));
+    }),
+  ),
+
+  mock(
+    routes.requisitions.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.requisitions.update.params.parse(params);
+      const { version, ...body } = await readBody(routes.requisitions.update.body, request);
+      const data = current();
+      const target = findRequisition(data, id);
+      checkVersion(target.version, version);
+      const before = target.amount;
+      saveRequisition(data, body, target);
+      record(
+        data,
+        'requisition.updated',
+        'requisition',
+        id,
+        diff({ amount: before }, { amount: target.amount }),
+      );
+      await delay();
+      return reply(routes.requisitions.update, toRequisition(data, target));
+    }),
+  ),
+
+  mock(
+    routes.requisitions.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.requisitions.remove.params.parse(params);
+      const { version } = readQuery(routes.requisitions.remove.query, request);
+      const data = current();
+      const target = findRequisition(data, id);
+      checkVersion(target.version, version);
+      removeRequisition(data, target);
+      record(
+        data,
+        'requisition.deleted',
+        'requisition',
+        id,
+        diff({ number: target.number }, { number: null }),
+      );
+      return reply(routes.requisitions.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.requisitions.submit,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.requisitions.submit.params.parse(params);
+      const { version } = await readBody(routes.requisitions.submit.body, request);
+      const data = current();
+      const target = findRequisition(data, id);
+      checkVersion(target.version, version);
+      const steps = submitRequisition(data, target);
+      record(
+        data,
+        'approval.submitted',
+        'requisition',
+        id,
+        diff({}, { amount: target.amount, steps, status: target.status }),
+      );
+      await delay();
+      return reply(routes.requisitions.submit, toRequisition(data, target));
+    }),
+  ),
+
+  mock(
+    routes.requisitions.reopen,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.requisitions.reopen.params.parse(params);
+      const { version } = await readBody(routes.requisitions.reopen.body, request);
+      const data = current();
+      const target = findRequisition(data, id);
+      checkVersion(target.version, version);
+      const before = target.status;
+      reopenRequisition(data, target);
+      record(
+        data,
+        'approval.reopened',
+        'requisition',
+        id,
+        diff({ status: before }, { status: target.status }),
+      );
+      return reply(routes.requisitions.reopen, toRequisition(data, target));
+    }),
+  ),
+
+  mock(
+    routes.requisitions.cancel,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.requisitions.cancel.params.parse(params);
+      const { version } = await readBody(routes.requisitions.cancel.body, request);
+      const data = current();
+      const target = findRequisition(data, id);
+      checkVersion(target.version, version);
+      const before = target.status;
+      cancelRequisition(target);
+      record(
+        data,
+        'requisition.cancelled',
+        'requisition',
+        id,
+        diff({ status: before }, { status: target.status }),
+      );
+      return reply(routes.requisitions.cancel, toRequisition(data, target));
+    }),
+  ),
+
+  mock(
+    routes.purchaseCosts.lookup,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.purchaseCosts.lookup.body, request);
+      return reply(routes.purchaseCosts.lookup, lookupCosts(current(), body));
+    }),
+  ),
 ];
```

- **Deleting a role** now also asks `approvalsNeedRole()`, and `forgetRole()` runs just before the role goes.
- **The customer's update, archive and restore** copy the shared fields to the supplier side (decision 48). The
  customer's delete takes only the customer side of a party on both sides: the supplier record stays, with
  `isCustomer` off and a new version.
- **"Make customer too"** is in the customers' block, because its route is `routes.customers.fromSupplier`.
- **The new block** follows the order of the contracts: suppliers, supplier groups, approval levels, approvals,
  requisitions, the cost lookup. Every handler that can refuse is wrapped in `guarded()`, so a `MockProblem` becomes
  the API's problem answer and the page shows the right words.
- **`await delay()` on saves and decisions,** as on the other forms: without it the button's "Saving…" state is never
  seen in `dev:mock`.
- **The approve and reject handlers are one function for both,** like the API's single path per kind (decision 16):
  the only difference is the decision and the audit action.
- **The audit rows are written here** (decision 51), with `diff({}, …)` for "created" values, like 15a's handlers.

### A clearer refusal for a role (cross-part fix, decision 47)

The three changed texts are in the diffs of 17a.3 (`roles.service.ts`) and 17a.5 (`en.ts`, `bn.ts`), already
fixed: write them as shown there. Only the text changed; the code stays `role_in_use`, so no test of 17a.4 changes.
The page shows the i18n text, not the API's; the API's message is for the logs and for whoever reads the raw answer.

### Two older tests follow the new rules

```diff
@@ -111,7 +111,11 @@ test('posts the opening balances, with the difference in opening balance equity'
   await page.getByRole('button', { name: 'First day on Omnivo' }).click();
   await page.locator('td[data-today] button').click();
   await page.getByLabel('Debit, 1121').fill('1842600.50');
-  await page.getByLabel('Credit, 2110').fill('412000');
+  // The payable is split by supplier (step 17a), like the receivable by customer
+  await page.getByLabel('Credit, 2110: line 1').fill('412000');
+  await page.getByLabel('Supplier, 2110: line 1').click();
+  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('meghna');
+  await page.getByRole('option', { name: /Meghna Spinning Mills/ }).click();
   // What the books are out by, on the side that closes the gap
   await expect(page.getByText('৳14,30,600.50')).toBeVisible();
   // …and with it both totals are the larger side
@@ -154,7 +158,7 @@ test('asks for the customer on a receivable line, and the customer then owes it'
   await line(page, 2).getByLabel('Account').selectOption({ label: '4110 · Export sales' });
   await line(page, 2).getByLabel('Credit').fill('42000');
   await page.getByRole('button', { name: 'Post entry' }).click();
-  await expect(line(page, 1).getByText('Pick the customer this amount belongs to.')).toBeVisible();
+  await expect(line(page, 1).getByText(/^Pick who this amount belongs to/)).toBeVisible();
 
   await line(page, 1).getByLabel('Customer').click();
   await page.getByRole('combobox', { name: 'Search customers' }).fill('aarong');
@@ -176,9 +180,7 @@ test('splits the opening receivable by customer', async ({ page }) => {
   await page.getByRole('button', { name: 'Post opening balances' }).click();
   // Without a customer the amount belongs to nobody: the row says so
   await expect(
-    page
-      .getByRole('group', { name: '1140: line 1' })
-      .getByText('Pick the customer this amount belongs to.'),
+    page.getByRole('group', { name: '1140: line 1' }).getByText(/^Pick who this amount belongs to/),
   ).toBeVisible();
 
   await page.getByLabel('Customer, 1140: line 1').click();
```

```diff
@@ -2,10 +2,11 @@ import { expect, test } from '@playwright/test';
 
 import { expectNoSideScroll } from './helpers.js';
 
-// The mock's Rahman Garments owner has two unread notifications and one read one
+// The mock's Rahman Garments owner has three unread notifications (step 17a added a requisition
+// waiting for approval) and one read one
 test('reads notifications from the bell', async ({ page }) => {
   await page.goto('/');
-  const bell = page.getByRole('button', { name: 'Notifications, 2 unread' });
+  const bell = page.getByRole('button', { name: 'Notifications, 3 unread' });
   await bell.click();
   const panel = page.getByRole('dialog');
   await expect(panel.getByRole('heading', { name: 'Notifications' })).toBeVisible();
@@ -19,9 +20,9 @@ test('reads notifications from the bell', async ({ page }) => {
   // A click marks it read and opens the page it is about
   await panel.getByRole('button', { name: /Nasrin Akter joined the workspace/ }).click();
   await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
-  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
+  await expect(page.getByRole('button', { name: 'Notifications, 2 unread' })).toBeVisible();
 
-  await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
+  await page.getByRole('button', { name: 'Notifications, 2 unread' }).click();
   await page.getByRole('button', { name: 'Mark all as read' }).click();
   await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
 });
```

- **The opening balances test** typed into "Credit, 2110". The payable is now split by supplier, like the
  receivable, so the box is "Credit, 2110: line 1" and the row needs Meghna as its supplier.
- **Two journal tests** looked for "Pick the customer this amount belongs to." 17a.5 changed the words to name both
  sides ("Pick who this amount belongs to: …"). The tests match the start of the new text.
- **The bell test** counts one more unread notification: the seeded approval (decision 49).

### `e2e/suppliers.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

// Step 17a in the mock garments workspace: three suppliers, S-00001 to S-00003. The company owes
// Meghna Spinning Mills ৳21,00,000 from last year's yarn (a payable line of the seeded journal).
// Gazipur Carton Industries is paid on receipt. Bengal Buying House (C-00004) is a customer with
// no entries.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const bankAccount = (page: Page, number: number) =>
  page.getByRole('group', { name: `Bank account ${String(number)}` });

test("lists the suppliers with what is owed, and opens one's bank account", async ({ page }) => {
  await openFromNav(page, 'Suppliers');
  await expect(listItem(page, /Meghna Spinning Mills/)).toContainText('৳21,00,000');
  await expect(listItem(page, /Gazipur Carton Industries/)).toContainText('On receipt');
  await expectNoSideScroll(page);

  await listItem(page, /Meghna Spinning Mills/).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Meghna Spinning Mills Ltd.' }),
  ).toBeVisible();
  // The API sends debit − credit (negative while owed); the page says it the way people do
  await expect(page.getByText('You owe ৳21,00,000')).toBeVisible();
  await expect(page.getByText('60 days').first()).toBeVisible();
  await expect(page.getByText('Dutch-Bangla Bank, Narayanganj')).toBeVisible();
  await expect(page.getByText('1071100023456')).toBeVisible();
  await expect(page.getByText('Routing 090670725')).toBeVisible();
  await expectNoSideScroll(page);
});

test('adds a supplier with a bank account, and checks the account number', async ({ page }) => {
  await openFromNav(page, 'Suppliers');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New supplier' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Padma Poly Packaging');
  await page.getByLabel('Group').selectOption({ label: 'Packaging' });
  await page.getByLabel('Payment terms').fill('30');
  await page.getByRole('button', { name: 'Add a bank account' }).click();
  await bankAccount(page, 1).getByLabel('Bank', { exact: true }).fill('BRAC Bank');
  await bankAccount(page, 1).getByLabel('Account name').fill('Padma Poly Packaging');
  await bankAccount(page, 1).getByLabel('Account number').fill('15-01');
  await bankAccount(page, 1)
    .getByLabel(/^Routing number/)
    .fill('0605');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  // The form's own check, before anything is sent
  await expect(page.getByText('Enter the account number: 6 to 20 digits.')).toBeVisible();
  await expect(
    page.getByText('Enter the 9-digit routing number, or leave it empty.'),
  ).toBeVisible();

  // Spaces and dashes are taken out: what is kept is the digits a bank's app wants
  await bankAccount(page, 1).getByLabel('Account number').fill('1501 2040 5567 001');
  await bankAccount(page, 1)
    .getByLabel(/^Routing number/)
    .fill('060-261-726');
  await page.getByRole('button', { name: 'Add supplier' }).click();

  await expect(page.getByText('Padma Poly Packaging added')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Padma Poly Packaging' })).toBeVisible();
  // The next number of the supplier series, after the three seeded ones
  await expect(page.getByText('S-00004').first()).toBeVisible();
  await expect(page.getByText('150120405567001')).toBeVisible();
  await expect(page.getByText('Routing 060261726')).toBeVisible();
  await expect(page.getByText('Nothing owed')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: 'Suppliers' }).first().click();
  await page.getByRole('searchbox', { name: 'Search suppliers' }).fill('padma');
  await expect(listItem(page, /Padma Poly Packaging/)).toBeVisible();
  await expect(listItem(page, /Meghna Spinning Mills/)).toHaveCount(0);
});

test('makes a customer a supplier too, and then deletes only the supplier side', async ({
  page,
}) => {
  await openFromNav(page, 'Customers');
  await listItem(page, /Bengal Buying House/).click();
  await page.getByRole('button', { name: 'Make supplier too' }).click();
  // The supplier's page, with its own fields at their defaults (decision 37)
  await expect(page.getByText('Bengal Buying House Ltd. is a supplier too')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Bengal Buying House Ltd.' }),
  ).toBeVisible();
  await expect(page.getByText('Also a customer')).toBeVisible();
  // One party, one code: the customer's
  await expect(page.getByText('C-00004').first()).toBeVisible();
  await expect(page.getByText('House 9, Road 4, Gulshan 1, Dhaka 1212')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/^Bengal Buying House Ltd\. is also a customer/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete C-00004' }).click();
  await expect(page.getByText('Bengal Buying House Ltd. is no longer a supplier')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible();
  await expect(listItem(page, /Bengal Buying House/)).toHaveCount(0);

  // The customer stays, and could be made a supplier again
  await openFromNav(page, 'Customers');
  await listItem(page, /Bengal Buying House/).click();
  await expect(page.getByRole('button', { name: 'Make supplier too' })).toBeVisible();
});

test('refuses to delete a supplier the books name, and archives it instead', async ({ page }) => {
  await openFromNav(page, 'Suppliers');
  await listItem(page, /Meghna Spinning Mills/).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete S-00001' }).click();
  await expect(
    page.getByText(
      'Entries or purchase documents use this supplier, so it cannot be deleted. Archive it instead.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('Meghna Spinning Mills Ltd. archived')).toBeVisible();
  await expect(page.getByText(/^This supplier is archived/)).toBeVisible();
  // What is owed stays: the money is still owed
  await expect(page.getByText('You owe ৳21,00,000')).toBeVisible();
});

test('names the supplier on a payable line, and the supplier is then owed it', async ({ page }) => {
  await openFromNav(page, 'Journal');
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Narration').fill('Trims for the Primark samples, billed later');
  const line = (number: number) => page.getByRole('group', { name: `Line ${String(number)}` });
  await line(1).getByLabel('Account').selectOption({ label: '5110 · Cost of goods sold' });
  await line(1).getByLabel('Debit').fill('12500');
  await line(2).getByLabel('Account').selectOption({ label: '2110 · Accounts payable' });
  await line(2).getByLabel('Credit').fill('12500');
  await page.getByRole('button', { name: 'Post entry' }).click();
  // The payable is kept per supplier (decision 11), like the receivable per customer
  await expect(line(2).getByText(/^Pick who this amount belongs to/)).toBeVisible();

  await line(2).getByLabel('Supplier').click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('unitex');
  await page.getByRole('option', { name: /Unitex Trims/ }).click();
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();

  await openFromNav(page, 'Suppliers');
  await expect(listItem(page, /Unitex Trims/)).toContainText('৳12,500');
  await listItem(page, /Unitex Trims/).click();
  await expect(page.getByText('You owe ৳12,500')).toBeVisible();
  // The statement: this year's entry, with what is owed after it
  await expect(page.getByText('Trims for the Primark samples, billed later')).toBeVisible();
  await expectNoSideScroll(page);
});

test('keeps a supplier group that holds suppliers, and deletes an empty one', async ({ page }) => {
  await openFromNav(page, 'Supplier groups');
  await expect(listItem(page, /Yarn and fabric/)).toContainText('1 supplier');

  await page.getByRole('button', { name: 'Add group' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add group' });
  await dialog.getByLabel('Name').fill('Dyes and chemicals');
  await dialog.getByRole('button', { name: 'Add group' }).click();
  await expect(page.getByText('Dyes and chemicals added')).toBeVisible();
  await expect(listItem(page, /Dyes and chemicals/)).toContainText('0 suppliers');

  await listItem(page, /Yarn and fabric/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Yarn and fabric' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Yarn and fabric' }).click();
  await expect(dialog.getByText(/^Suppliers are in this group/)).toBeVisible();
  await page.keyboard.press('Escape');

  await listItem(page, /Dyes and chemicals/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Dyes and chemicals' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Dyes and chemicals' }).click();
  await expect(page.getByText('Dyes and chemicals deleted')).toBeVisible();
  await expect(listItem(page, /Dyes and chemicals/)).toHaveCount(0);
  await expectNoSideScroll(page);
});
```

- **The bank account test types a bad number and routing number first.** The contract's checks run in the form, so
  the error shows before anything is sent. Then it types the numbers with spaces and dashes and checks that the
  page shows only the digits: that is the contract's `transform`, and the page shows what the mock stored.
- **"Make supplier too" is followed to the end:** the supplier page, the shared code (`C-00004`, one party, one
  code), the billing address as the supplier's address, the side delete with its own warning and toast, and the
  customer that stays and can be made a supplier again.
- **The payable test posts a real entry and reads it back three ways:** the error on the line without a supplier,
  the supplier list's balance, and the supplier's statement.

### `e2e/requisitions.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 17a in the mock garments workspace, where the signed-in person is the Owner. Requisitions
// from ৳20,000 need the Purchase manager (Kamal Uddin), from ৳1,00,000 a Director as well, a role
// nobody holds. Sadia Islam wrote three:
//   PR-…-0001 two sewing machines: Kamal sent it back, so it is a draft with a comment
//   PR-…-0002 mailer bags: approved by Kamal
//   PR-…-0003 jersey and buttons, ৳2,11,240: Kamal approved step 1; step 2 (Director) waits, and
//             the bell told the Owner
// and the Owner's own PR-…-0004 (buttons, ৳1,944) was never submitted. An Owner may decide any
// step, and the Owner's own requisitions are approved when submitted (decision 14).

const PR = (number: number) => new RegExp(`PR-\\d{4}-\\d{2}-${String(number).padStart(4, '0')}`);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// The nav item says "Requisitions"; the page's title is the longer "Purchase requisitions"
async function openRequisitions(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Requisitions' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Purchase requisitions' }),
  ).toBeVisible();
}

async function openRequisition(page: Page, number: number) {
  await openRequisitions(page);
  await listItem(page, PR(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: PR(number) })).toBeVisible();
}

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

test('lists the requisitions with their status', async ({ page }) => {
  await openRequisitions(page);
  await expect(listItem(page, PR(3))).toContainText('Waiting for approval');
  await expect(listItem(page, PR(3))).toContainText('৳2,11,240');
  await expect(listItem(page, PR(2))).toContainText('Approved');
  await expect(listItem(page, PR(1))).toContainText('Draft');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'Approved' }).check({ force: true });
  await expect(listItem(page, PR(2))).toBeVisible();
  await expect(listItem(page, PR(3))).toHaveCount(0);
});

test('approves the requisition waiting for the Owner, from the Approvals list', async ({
  page,
}) => {
  await openFromNav(page, 'Approvals');
  await expect(listItem(page, PR(3))).toContainText('Main store');
  await expect(listItem(page, PR(3))).toContainText('2 of 2');
  await expectNoSideScroll(page);
  // Approve is on the requisition's page only (decision 44): the list takes the person there
  await listItem(page, PR(3)).click();
  await expect(page.getByRole('heading', { level: 1, name: PR(3) })).toBeVisible();
  await expect(page.getByText('Kamal Uddin', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Step 2 waits for you.')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: PR(3) });
  await expect(dialog.getByText('You approve step 2 of 2, as Director.')).toBeVisible();
  await expect(dialog.getByText(/^This is the last step/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await toastShown(page, /^Your approval of PR-\d{4}-\d{2}-0003 is saved$/);
  await expect(page.getByText(/^Approved and locked/)).toBeVisible();
  await expect(page.getByText('Step 2 waits for you.')).toBeHidden();

  // Nothing waits any more
  await openFromNav(page, 'Approvals');
  await expect(page.getByText('Nothing waits for you')).toBeVisible();
});

test('sends a requisition back with a comment, then changes it and submits it again', async ({
  page,
}) => {
  await openRequisition(page, 3);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: PR(3) });
  // A rejection says why (decision 15): the form's own check
  await dialog.getByRole('button', { name: 'Send back to draft' }).click();
  await expect(dialog.getByText('Say what should change, at least 2 characters.')).toBeVisible();
  await dialog.getByLabel('What should change').fill('Order 300 metres: the October plan changed.');
  await dialog.getByRole('button', { name: 'Send back to draft' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 sent back to draft$/);

  // A warn notice with the comment: the writer has to act
  await expect(
    page.getByText(
      'Farhana Rahman sent it back: "Order 300 metres: the October plan changed." Change it and submit it again.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await line(page, 1).getByLabel('Quantity').fill('300');
  await page.getByRole('button', { name: 'Save requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 saved$/);
  // 300 m × ৳520 + the buttons' ৳3,240
  await expect(page.getByText('৳1,59,240.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 approved$/);
  await expect(page.getByText('An Owner submitted it, so it was approved at once.')).toBeVisible();
  // The two rounds before it stay in its history (decision 25)
  await page.getByText('Earlier rounds').click();
  await expect(page.getByText('Round 1')).toBeVisible();
  await expectNoSideScroll(page);
});

test('writes a requisition at the average cost, and the Owner submits it', async ({ page }) => {
  await openRequisitions(page);
  await page.getByRole('button', { name: 'New requisition' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New purchase requisition' }),
  ).toBeVisible();
  await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await page.getByLabel(/^Note/).fill('Fabric for the Primark basic tee, 3,000 pieces');

  await page.getByRole('button', { name: 'Add items' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('searchbox', { name: 'Search products and services' }).fill('jersey');
  const row = picker.getByRole('listitem').filter({ hasText: 'Single jersey 180 GSM' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The line comes in the jersey's buying unit, the yard, at the company-wide average cost
  // (decision 20): ৳520 a metre × 0.9144 = ৳475.488 a yard, with the 4 decimals a cost keeps
  await expect(line(page, 1).getByLabel('Cost per yard')).toHaveValue('475.4880');
  await expect(line(page, 1).getByText('From the average cost')).toBeVisible();
  await line(page, 1).getByLabel('Quantity').fill('250');
  await expect(page.getByText('৳1,18,872.00').first()).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0005 saved$/);

  // A draft lists the levels its amount reaches now (decision 44)
  await expect(page.getByRole('heading', { level: 1, name: PR(5) })).toBeVisible();
  await expect(page.getByText('Purchase manager · from ৳20,000')).toBeVisible();
  await expect(page.getByText('Director · from ৳1,00,000')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0005 approved$/);
  await expect(page.getByText('An Owner submitted it, so it was approved at once.')).toBeVisible();
});

test('cancels an approved requisition, reopens a waiting one, and deletes a draft', async ({
  page,
}) => {
  await openRequisition(page, 2);
  await page.getByRole('button', { name: 'Cancel requisition' }).click();
  let dialog = page.getByRole('dialog', { name: PR(2) });
  await dialog.getByRole('button', { name: 'Cancel requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0002 cancelled$/);
  await expect(page.getByText('Cancelled. It stays here for the record.')).toBeVisible();

  await openRequisition(page, 3);
  await page.getByRole('button', { name: 'Reopen' }).click();
  dialog = page.getByRole('dialog', { name: PR(3) });
  await dialog.getByRole('button', { name: 'Reopen' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0003 is a draft again$/);
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();

  // Sent back once, so its history stays: it can only be cancelled
  await openRequisition(page, 1);
  await expect(page.getByRole('button', { name: 'Cancel requisition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete requisition' })).toBeHidden();

  // Never submitted: two clicks delete it
  await openRequisition(page, 4);
  await page.getByRole('button', { name: 'Delete requisition' }).click();
  await page.getByRole('button', { name: /^Delete PR-/ }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0004 deleted$/);
  await expect(listItem(page, PR(4))).toHaveCount(0);
});

test('opens the waiting requisition from the bell', async ({ page }) => {
  await page.getByRole('button', { name: 'Notifications, 3 unread' }).click();
  const panel = page.getByRole('dialog');
  await panel
    .getByRole('button', { name: /Requisition PR-\d{4}-\d{2}-0003 is waiting for your approval/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: PR(3) })).toBeVisible();
  await expect(page.getByText('Step 2 waits for you.')).toBeVisible();
});

test('changes the approval levels, in order of amount', async ({ page }) => {
  await openFromNav(page, 'Approval levels');
  const card = page.getByRole('form', { name: 'Purchase requisitions' });
  const level = (number: number) => card.getByRole('group', { name: `Level ${String(number)}` });
  await expect(level(1).getByLabel('Role')).toHaveValue(/.+/);

  // A new level starts at the amount of the one above it (৳1,00,000)
  await card.getByRole('button', { name: 'Add a level' }).click();
  await level(3).getByLabel('Role').selectOption({ label: 'Accountant' });
  // fill() selects what the box holds and types over it. On focus the grouped "1,00,000" becomes the
  // plain digits, and the box selects them again; without that the new digits would join the old ones
  const from = level(3).getByLabel('From amount');
  await from.fill('50000');
  await card.getByRole('button', { name: 'Save levels' }).click();
  // Each level starts at the amount of the one above it, or higher (decision 13)
  await expect(
    level(3).getByText('Start this level at the amount of the level above it, or higher.'),
  ).toBeVisible();
  // A person tabs into the box (the browser selects all of it) and types the new amount
  await level(3).getByLabel('Role').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(from).toBeFocused();
  await page.keyboard.type('500000');
  await expect(from).toHaveValue('500000');
  await card.getByRole('button', { name: 'Save levels' }).click();
  await toastShown(page, 'Purchase requisitions: levels saved');
  await expectNoSideScroll(page);

  // A role a level uses cannot be deleted, even though nobody holds it (17a.3)
  await openFromNav(page, 'Roles');
  await page.getByRole('button', { name: 'Edit Director' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Director' });
  await dialog.getByRole('button', { name: 'Delete role' }).click();
  await dialog.getByRole('button', { name: 'Delete Director' }).click();
  await expect(dialog.getByText(/an approval level uses it/)).toBeVisible();
});
```

- **`PR(3)` matches the number with any year,** because the fiscal year in the number depends on today's date.
- **The approve test starts from the Approvals list** and checks that Approve is not on it (decision 44): the list
  only takes the person to the page.
- **The reject test also checks the comment rule in the form,** then reads the warn notice with the comment and the
  name of the person who sent it back (the Owner, in the mock). After the change it submits again: approved at once
  (decision 14), with the two earlier rounds folded under "Earlier rounds".
- **The new requisition's line is in yards,** the jersey's buying unit, so its cost is ৳520 × 0.9144 = ৳475.488 a
  yard. The test checks the exact `"475.4880"`: a cost keeps 4 decimals.
- **The levels test types over an amount two ways.** First with `fill()`, which selects what the box holds and
  types over it; then as a person does it: the focus on the role select, Shift+Tab back into the amount, and
  typing. Both replace "1,00,000" only because the money box selects its plain digits on focus (decision 53, the
  section below). Without the fix, both fail on both screen sizes.
- **It ends on the roles page:** Director, which nobody holds, cannot be deleted because a level uses it, and the
  message now says so (decision 47).

### The money box keeps the selection: `packages/ui` (decision 53)

```diff
@@ -45,7 +45,18 @@ export function DecimalInput({
       onFocus={(event) => {
         // সার্ভারের "1842600.5000" (৪ ঘর) এলেও সম্পাদনা শুরু হয় scale-এর রূপে, নইলে
         // isMoneyDraft প্রতিটা কী চাপ আটকে দিত
-        setDraft(value === '' ? '' : toCanonicalMoney(value, scale));
+        const plain = value === '' ? '' : toCanonicalMoney(value, scale);
+        const input = event.currentTarget;
+        // Swap the text now, in the focus event, and select all of it. Left to React's next render,
+        // the new text would replace the old one after the browser selected it (Tab selects the whole
+        // box), the caret would jump to the end, and typing would add to the old amount instead of
+        // replacing it. React then finds the text it wants already there and leaves it. A click selects
+        // it all too; a second click puts the caret where it lands, as the box already has the focus.
+        if (input.value !== plain) {
+          input.value = plain;
+          input.select();
+        }
+        setDraft(plain);
         onFocus?.(event);
       }}
       onChange={(event) => {
```

- **The swap happens in the focus event, not on React's next render.** React applies a state change from an event a
  moment later (after the event's own code has run). By then the browser has already selected the old text, on
  Tab, or Playwright's `fill()` has; putting new text into the box then drops that selection and leaves the caret
  at the end. Typing then adds to the old amount: "1,00,000" and "50000" became "10000050000".
- **`input.value = plain`, then `select()`.** The box gets the plain digits at once and selects all of them. When
  React renders a moment later, it compares the box's text with `display` (now also `plain`), finds them equal and
  does not touch the box, so the selection stays.
- **Why select everything, and not keep the old selection?** We tried keeping it (moving the old caret past the same
  digits, without the commas). It does not work in Chrome: during the focus event the box has no selection yet;
  the browser selects the text after the event. So there is nothing to keep, only something to set. Selecting the
  whole amount is what a person who tabs into a money box expects.
- **`if (input.value !== plain)`.** An empty box, or one whose text does not change (a whole number with no
  grouping, like "500"), is left alone, with whatever selection the browser gives it.
- **A click selects the whole amount too.** A second click puts the caret where it lands, because the box already
  has the focus and nothing is swapped.
- **`setDraft(plain)` stays.** The draft is what the box shows while it has the focus; the line above only makes
  the box show it a moment earlier.

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/app typecheck
pnpm lint
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts suppliers requisitions journal notifications
```

Build `@omnivo/i18n` and `@omnivo/ui` first: the app reads their built `dist/`, and the `role_in_use` words and the
money box changed.

> **What we checked in this part.** Before it, the mock did not start (the seeded payable line had no supplier).
> After it, the app type-checks (with its scripts and e2e projects), ESLint and Prettier are clean on the mocks, the
> e2e tests, the locales and the roles service, the app's unit tests pass (96), i18n type-checks and its tests pass
> (11), the API type-checks, the app builds, the bundle check passes (first load 193.5 KB, unchanged: the mock is not
> in the build; the team page is still at its 100.0 KB limit) and `pnpm boundaries` finds no violation (767
> modules). The two new files pass 26 of 26 on both screen sizes, after two fixes to the tests themselves (the
> jersey's line is in yards; the levels test now types over an amount, after the money box fix of decision 53). The whole
> end-to-end suite ran once: 213 of 218 passed; the other five were all on the phone, all in the same minutes, and
> all the machine (`ERR_NETWORK_IO_SUSPENDED` and page loads timing out while the load was above 30). Run again with
> two workers, the five passed. Before that, the older suite alone had passed 191 of 192 (one revaluation page that
> was still loading its chunk; it passed alone). Four checks by breaking things on purpose: the last approval not
> approving the requisition failed the approve test; the waiting list keeping decided rounds failed three tests (the
> count stayed, a toast never left); the supplier statement read from the customer side failed the payable test;
> and payable lines looked up among the customers stopped the seed itself (Meghna's line was refused), so every
> page failed to load, which is what this part started from. The money box fix (decision 53) came after, on
> 2026-10-18: without it, the levels test failed on both screen sizes; with it, it passed, and the whole
> end-to-end suite ran again (218 of 218 passed in 6.1 minutes).

---

## 17a.8 — The OpenAPI document, and every check once

### The OpenAPI document

No root file changes: no new script, no new package and no new `.env` line. Generate the API document again and
commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 172 paths (151 before)
```

The 21 new paths:

- **Suppliers:** `/suppliers` (list and create), `/suppliers/{id}` (read, change, delete), `/suppliers/{id}/archive`,
  `/suppliers/{id}/restore`, `/suppliers/{id}/statement`, `/suppliers/{id}/make-customer` and
  `/customers/{id}/make-supplier`; `/supplier-groups` (list and create) and `/supplier-groups/{id}` (change, delete).
- **Approvals:** `/approval-rules`, `/approval-rules/{document}`, `/approvals/waiting`, `/approvals/waiting/count`,
  `/approvals/{document}/{id}/approve` and `/approvals/{document}/{id}/reject`.
- **Requisitions:** `/requisitions` (list and create), `/requisitions/{id}` (read, change, delete),
  `/requisitions/{id}/submit`, `/requisitions/{id}/reopen`, `/requisitions/{id}/cancel`, and `/purchase/cost-lookup`.

A list and its POST share one path, so 29 routes make these 21 paths. The journal's and the opening balances'
paths did not change their shape: a payable line's `partyId` was already in the contract since 15a. `pnpm
test:openapi` fails if the committed file and the routes disagree.

The Drizzle snapshots (`migrations/meta/0035_snapshot.json`, `0036_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

In the copy of the repo every check passed on its first run, the end-to-end suite too (218 in 7.1 minutes).
The integration and tenant-leak suites ran with `--maxWorkers=3` (`cd apps/api && npx vitest run .int.spec
--maxWorkers=3`), because at full speed this Mac's Docker missed the test containers' start-up time in earlier
steps.

If a test times out on your machine, run
`pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts --last-failed --workers=2` before
looking for a bug.

---

## 17a.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", after "Return, credit note and refund statuses". The design system lists every
pattern, and a pattern that is not listed there does not exist for the next screen; 17b's purchase order reuses
all three:

> - **Purchase statuses:** requisition Draft (neutral, `FileEdit`), Waiting for approval (`brand`, `Clock01`),
>   Approved (`good`, `CheckmarkCircle02`), Cancelled (neutral, `CancelCircle`). An approval round and its steps:
>   Waiting (`brand`, `Clock01`), Approved (`good`, `CheckmarkCircle02`), Rejected (`warn`, `ArrowTurnBackward`:
>   the writer must act), Reopened (neutral, `Undo02`), and a step never reached "Not yet" / "Not decided"
>   (neutral, `MinusSignCircle`).
> - **Approval card:** a card ("Approval", with a subtitle) on every document that needs an approval. A draft lists
>   the levels its amount reaches now ("Purchase manager · from ৳20,000"). A round: "Round 2" (13.5px/500) with its
>   pill, a 13px `ink-3` line (who submitted it, when, for how much), then its steps in a 1px `line` box (radius
>   10px, one row each, 1px `line` rules): the level, its pill, a 12px `ink-3` "who and when", and the comment in a
>   `<q>`. The waiting step gets a `subtle` box below: "Step 2 waits for you." with Approve (primary `sm`) and
>   Reject (secondary `sm`, `ArrowTurnBackward`), "You submitted it, so someone else approves it." for the writer,
>   or "Waiting for Purchase manager". Earlier rounds fold into a `<details>` with a `brand` text-link summary. Approve and Reject are on
>   the document's page only, never on a list.
> - **Approval dialogs:** the dialog. Approve says whether this click finishes the approval or passes it on, with
>   an optional comment; Reject needs a comment (it says what to change). Errors that name no box show at the top.
> - **Approval levels (Settings):** one card per kind of document, each its own form. A level is a box (1px `line`,
>   radius 10px, 16px padding) with "Level 2" (13px/500 `ink-2`), a whole-taka money input "From amount" and a role
>   select side by side, and a remove icon button. "Add a level" (secondary) and Save (primary) at the bottom, the
>   rules in 13px `ink-3` above them; at most five levels. Without `core.settings.manage` the same page is read-only.

In "Money input", after "when not focused.", add the behaviour of decision 53, so a new money box does not
undo it:

> Focusing it (Tab or a click) shows the plain digits and selects all of them, so typing replaces the amount.

In "Document notice", add the requisition sent back to the `warn` cases. Without it, the next document that is sent
back would use the hourglass:

> `warn-bg` with `warn` text and an `Hourglass` icon for an offer that has ended or a credit note more than 6 months
> after its invoice, or an `ArrowTurnBackward` icon and the approver's comment for a document sent back by an
> approval,

In "Sidebar nav", nothing changes: the Approvals count is the existing "`crit` when they need action" count. The
supplier form's bank accounts are the existing line-row look (a box per account, like an address), so they need no
new pattern.

**build-plan.bn.md** — after the "ধাপ ১৬: ডকুমেন্ট আউটপুট" block, add:

> #### ধাপ ১৭: Purchase — চারটা গাইডে
>
> **১৭a (suppliers, payable, requisition, approval):** supplier একই `parties` টেবিলে (`is_supplier`), নিজের কোড
> সিরিজ (`S-00001`), supplier group, নিজের payment terms, সর্বোচ্চ ৫টা bank account (bank, branch, account name,
> number, routing number)। একই party দুই দিকেই হতে পারে ("Make supplier too" / "Make customer too"); এক দিক
> delete করলে শুধু সেই দিক যায়। AP-ও per party: প্রতিটা payable লাইনে supplier, balance ও statement সেখান থেকে
> (`purchase.supplier.balance` থাকলে); opening balances-এ AP supplier ধরে ভাগ। Requisition (PR, save করলেই নম্বর;
> warehouse, needed-by, লাইনে estimated cost — average cost থেকে, বদলানো যায়; draft → pending → approved,
> cancelled)। **Approval:** প্রতি ডকুমেন্ট ধরনের জন্য সর্বোচ্চ ৫টা level (amount থেকে, একটা role); submit করলে
> যে level-গুলো লাগে সেগুলো ডকুমেন্টে কপি হয়, একটার পর একটা; নিজের ডকুমেন্ট নিজে approve নয় (Owner-এর নিজেরটা
> সাথে সাথে approved, Owner যেকোনো level approve করতে পারে); reject-এ comment লাগে, draft-এ ফেরে; approved
> ডকুমেন্ট lock, Reopen করলে নতুন round; ইতিহাস কখনো মোছে না। Bell, audit log, "Approvals" পেজে আমার জন্য
> অপেক্ষমাণ তালিকা ও count।
> **১৭b–১৭d:** PO ও goods receipt (GRNI), bill ও supplier payment, purchase return ও debit note — নিজ নিজ গাইডে।

**COMMANDS.md** — in "Look at the data", after the last document output query, add:

```bash
# what the company owes each supplier (posted payable lines; a negative amount is an advance paid)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.code, p.name, sum(l.credit - l.debit) AS owed FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id JOIN tenants t ON t.id = l.tenant_id WHERE a.purpose = 'accounts_payable' AND e.status = 'posted' GROUP BY t.slug, p.code, p.name HAVING sum(l.credit - l.debit) <> 0 ORDER BY t.slug, owed DESC"
# payable amounts posted before step 17a, with no supplier named
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(*) AS lines, sum(l.credit - l.debit) AS amount FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id JOIN tenants t ON t.id = l.tenant_id WHERE a.purpose = 'accounts_payable' AND e.status = 'posted' AND l.party_id IS NULL GROUP BY t.slug"
# approval levels per workspace and kind of document
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, r.document, v.position, v.min_amount, ro.name AS role FROM approval_levels v JOIN approval_rules r ON r.tenant_id = v.tenant_id AND r.id = v.rule_id JOIN roles ro ON ro.tenant_id = v.tenant_id AND ro.id = v.role_id JOIN tenants t ON t.id = v.tenant_id ORDER BY t.slug, r.document, v.position"
# documents waiting for approval, oldest first, with the step and the role they wait for
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, r.document, q.number, r.amount, s.position AS step, s.role_name AS waits_for, u.full_name AS submitted_by, r.submitted_at FROM approval_rounds r JOIN tenants t ON t.id = r.tenant_id JOIN users u ON u.id = r.submitted_by JOIN LATERAL (SELECT position, role_name FROM approval_steps x WHERE x.tenant_id = r.tenant_id AND x.round_id = r.id AND x.decision IS NULL ORDER BY position LIMIT 1) s ON true LEFT JOIN requisitions q ON r.document = 'requisition' AND q.tenant_id = r.tenant_id AND q.id = r.document_id WHERE r.status = 'pending' ORDER BY r.submitted_at"
```

The four queries were run against a database migrated to 0036, holding 17a.2's check data; the last one inside a
transaction that added a waiting round, then rolled back. A party on both sides shows one code in the first query,
the one it was made with (`C-…` for a customer made a supplier too): a party has one code, whichever page shows
it. A negative amount in the first two queries is money the company paid before it was owed.

---

## 17a.10 — Run it

```bash
pnpm install                                  # nothing new, but run it after pulling
pnpm db:migrate                               # 0035 + 0036: eight tables, two parties columns, their rules
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: a new module and 29 routes
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('supplier_groups', 'party_bank_accounts', 'approval_rules', 'approval_levels',
                   'approval_rounds', 'approval_steps', 'requisitions', 'requisition_lines');  -- t, eight rows
SELECT count(*) FILTER (WHERE is_customer) AS customers, count(*) FILTER (WHERE is_supplier) AS suppliers
  FROM parties;                                                   -- your customers, 0 suppliers
```

### What you will see

Sign in as the Owner first. (In an existing workspace the other roles do not have the new permissions yet; see
"What changes".)

1. **The navigation** has a Purchase group after Sales: Requisitions, Approvals, Suppliers, Supplier groups. The
   Workspace group has Approval levels next to Roles.
2. **Supplier groups:** add "Yarn and fabric" and "Accessories".
3. **Suppliers → New supplier:** Meghna Spinning Mills, the yarn group, 30 days, and a bank account. Type the
   account number with dashes (`1051-1100-12345`): it is saved as digits. An 8-digit routing number shows an error
   under its box. Save: the code is `S-00001`, and the page shows "Nothing owed", the bank account in `Geist Mono`
   and an empty statement.
4. **A customer's page → Make supplier too:** the supplier page of the same party opens, with no group and terms on
   receipt. Change the phone there; the customer page shows the new phone. Delete on the supplier page: the warning
   says only the supplier side goes, and the customer stays.
5. **Journal → New entry** with a line on the payable account: its box now says Supplier. Post without one: the
   line says to pick a supplier. Pick Meghna and post. Meghna's page: "You owe ৳…", and the statement has the line.
6. **Opening balances:** the payable block asks for a supplier per line ("Add a supplier").
7. **Settings → Roles:** make a "Purchase manager" role and give it to a member. **Settings → Approval levels →
   Requisitions:** a level from ৳20,000 for the Purchase manager. Save. Back in Roles, deleting Purchase manager
   is refused, and the message names the approval levels.
8. **Requisitions → New requisition:** a warehouse, two items. The cost is filled in from the average cost (an
   Owner sees it) and says so under the box. The total is at the bottom. Save: `PR-2026-27-0001` opens as a page,
   and the approval card lists "Purchase manager · from ৳20,000" if the total reaches it.
9. **Submit for approval** as the Owner: it is approved at once, and the card says "An Owner submitted it, so it was
   approved at once." (decision 14). Reopen it: it is a draft again, and the old round stays under "Earlier rounds".
10. **The real wait:** sign in as a member with `purchase.requisition.manage` and submit one of ৳20,000 or more.
    The Purchase manager's bell rings and the Approvals count says 1. As the Purchase manager, open it from the
    bell, **Reject** with a comment: it is a draft again, and the writer sees a `warn` notice with the comment and a
    bell. Submit again, **Approve**: it is approved and locked, and the writer's bell says so.
11. **The member who wrote it** sees "You submitted it, so someone else approves it.", never Approve: nobody approves their own document.
12. **Bangla** and **390px**: the supplier form, the requisition lines and the approval card fit, and no page
    scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 437: contracts 197 + api 107 + app 96 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 396 — 46 new
pnpm test:tenant-leak        # 77 — 10 new
pnpm test:e2e                # 218: 109 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 193.5 KB gz; team page 100.0 (the limit), supplier groups 97.5
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **A deleted role would have broken the approval history** (17a.3): a step keeps the role's name when the role
  is deleted (decision 25), but the first contract reused `roleRefSchema`, whose `id` is never null, so such a
  history would have failed the response check. The step's `role.id` is nullable now (17a.1), and the card says
  "(a deleted role)".
- **The first load was over its budget before any 17a screen existed** (17a.6): the new contracts and words alone
  took it to 201.5 KB, and three older pages over 100 KB, because every page carries the whole routes registry.
  Toasts load lazily now, and three pages load one part later (decision 46).
- **The mock did not start** (17a.7): its seeded journal had a payable line with no party, which the payable rule
  refuses. The line now names Meghna Spinning Mills.
- **The roles page could not say why "Director" would not delete** (17a.7): nobody held it, so "someone has this
  role" was no help. The `role_in_use` text names approval levels now (decision 47).
- **A new requisition line starts in the product's buying unit** (17a.7): the jersey is bought by the yard, so its
  starting cost is the average cost per metre × 0.9144 (৳520 → ৳475.4880 a yard). The first version of the test
  did not expect that. Only the test changed.
- **Typing into a money box that had a value added to it** (17a.7), with Playwright's `fill()` and with Tab, for
  a person too. The cause was older than this step: the box swapped "1,00,000" for "100000" on React's next render,
  after the browser had selected the old text. The box now swaps the text in the focus event and selects it all
  (decision 53).

---

## Notes left for later steps

**17b (purchase orders and goods receipts):**

- **A purchase order joins the approvals engine:** add `'purchase_order'` to `APPROVAL_DOCUMENTS` (contracts) and
  its `lock`, `setStatus` and `describe` to `APPROVAL_TARGETS` (`apps/api/src/purchase/approval-documents.ts`). The
  routes, the rounds, the bell, the waiting list and Settings → Approval levels take it as they are. Give it words
  under `approvals.kinds` and `approvalRules.documents`, and a case in the bell's `useOpenDocument`.
- **A requisition cannot be reopened once an order uses it** (decision 6). The reopen in `requisitions.service.ts`
  has no such check yet, because nothing can use a requisition in 17a. Add it with the order, and an "ordered"
  status (its pill in `purchase-pills.tsx`, whose `satisfies` will ask for it).
- **The last purchase price comes before the average cost** (decision 20): add `'last_purchase'` to
  `PURCHASE_COST_SOURCES` and look it up first in `cost-lookup.service.ts`.
- **The purchase lines editor** (`purchase-lines-editor.tsx`) gets the order's price, discount and VAT, like the
  sales line editor.
- **Removing a supplier side** checks only the payable lines today (decision 32). Add each purchase document table
  to that check in `suppliers.service.ts`, as 15a–15d's tables are in the customer side's check.
- **The PO PDF and email** (decision 4): step 16's "Notes left for later steps" says how. The supplier already has
  `documentLanguage`.
- **The bundle:** the team page is at its 100.0 KB limit, and every new route makes every page bigger (decision 46).
  Ask before choosing one of the fixes listed there.

**17c (bills and supplier payments):**

- **A payment can point at the bank account it went to:** `party_bank_accounts` has a unique `(tenant_id, id)` for
  that foreign key, and the supplier form keeps each account's id on an edit for the same reason.
- **A supplier's balance from the API is debit minus credit** (negative while the company owes it); the app turns
  it around (`useSupplierText`). A bill and a payment change it like any payable line.

**Notes for any step:**

- **A party is one row on both sides.** Any new party column belongs to one side or to both (decision 22). A
  side's column must be cleared when that side is removed, or the database's side check refuses the change.
