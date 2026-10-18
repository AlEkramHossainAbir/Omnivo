# Step 17b: Purchase orders and goods receipts

> The implementation guide for "Phase 5 → Step 17", part b of four, of [build-plan.bn.md](build-plan.bn.md): which
> file gets what code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `1be49fd`, your commit named
> "docs updated": 17a's code and its doc updates) and checked on 2026-10-18: `pnpm dedupe --check`, `pnpm lint`,
> `pnpm format`, `pnpm typecheck`, `pnpm test` (469 — 32 new), `pnpm test:integration` (433 — 31 new),
> `pnpm test:tenant-leak` (84 — 7 new), `pnpm build`, `pnpm test:bundle-size` (first load 196.2 KB gz, budget 200;
> the biggest lazy chunk is the team page, 97.5 KB, which was at its 100 KB limit before decision 50),
> `pnpm gen:openapi` (183 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 236 — 18
> new, desktop and 390px; every test passed on the first run) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres: 116 checks of migrations 0037 and 0038 run as
>   `omnivo_app` with SQL the API would never send (an order pending without a number, a total that is not net plus
>   VAT, an order line for another item than its requisition line or for another warehouse's requisition, an
>   approved order's line changed, a receipt line that accepts and rejects nothing, a rejection without a reason, a
>   line received more than twice over, a posted receipt changed, another workspace's rows), three races in two
>   sessions (a requisition cancelled while an order line is written for it, and the other way round; an order
>   cancelled while a receipt is written), and 0038's stock accounts job on a database migrated to 0036 (17b.2).
> - **The whole flow against a real database** (17b.4): an order written from a requisition's open lines, priced
>   from the last price, approved by level, sent as a PDF, by email and as a share link; receipts in two lots, with a
>   rejection, over the order within the percent and refused above it; the stock, its value, the moving average and
>   the entry on "goods received not billed"; reopen, close and cancel refused at the right moments; two receipts
>   of one order posted at the same moment (the second waits, then is refused over the percent); a reopen and a
>   receipt at the same moment (they take turns); and another workspace trying every route.
> - **Guards broken on purpose**: five in the API (17b.4: the over-receipt limit forgetting earlier receipts,
>   "incoming" going below zero, a closed order counting as ordered in full, the last price taken from an order
>   nobody approved, the supplier-side check forgetting orders), two Bangla keys removed (17b.5), two in the app (17b.6) and
>   three against the mock (17b.7). Each was caught by the test or the type check meant for it, and the code was
>   restored after it.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` (0037 and
> 0038) first, then restart `pnpm dev`, so the worker runs the stock accounts job that 0038 queues (see "What
> changes"). (2) **The screens against the real API:** they were clicked through by the Playwright tests against the
> mock API (17b.7), which signs in as the Owner only. The store keeper who may receive but not order was tested
> against the real API (17b.4), not in a browser. Please try 17b.10's steps 6 and 9 with a second member. (3) The
> Bangla texts, and the Bangla PDF of a purchase order, were written by me and not reviewed by a native speaker.
> (4) The new tests on GitHub Actions.

## Goal

📦 **From "please buy" to "it is in the store".** 17a gave Omnivo suppliers, requisitions and an approval. But an
approved requisition is still only a request: nobody has told the mill what to send, at what price, by when. Today a
merchandiser in a garments factory writes the purchase order in Excel, sends it on WhatsApp, and the store keeper
signs a paper challan at the gate. Nobody can say how much of the jersey has come, whether the 12 m of torn rolls
went back, or why the stock value moved. This step brings the purchase order and the goods receipt, so what the
company ordered, what came in and what it is worth are in one place, in the books on the day the truck arrives.

After this step:

- **Purchase orders** (`PO-2026-27-0001`): a supplier, the warehouse that gets the goods, the date they are due,
  the supplier's own reference and payment terms. The lines are priced like sales lines: a price, a discount (% or
  ৳) and a VAT rate, and the order says whether its prices include VAT. A new line starts at the last price paid
  ("Last price from this supplier", else "Last price paid"). Lines come from the approved requisitions of the
  warehouse ("Add lines still to order"), or are added by hand.
- **The approval** of 17a, now for orders too: levels by the order's total with VAT. The number is given at the
  first submit. An approved order is locked; Reopen takes it back to draft until goods come in, then only Close is
  left.
- **The order goes out** with the Send menu of step 16: a PDF in English or Bangla, an email to the supplier and a
  WhatsApp link to a public page. A late order (approved, past its date) has a `warn` "Late" pill.
- **Goods receipts** (`GRN-2026-27-0001`), always from an approved order: for each line, what was accepted and what
  was rejected, with the reason, the lot, expiry and serial numbers, the supplier's challan number and the vehicle.
  It may bring in up to "Receive over the order" percent more than ordered (Settings, 0 by default).
- **Posting a goods receipt** brings the accepted goods into stock at the order's price before VAT, updates the
  moving average cost, and posts Dr Inventory / Cr "Goods received not billed" (a new account, 2115), on the branch
  of the warehouse. The order shows "Partly received", then "Received"; Close drops what will not come.
- **Requisitions** show "Partly ordered" or "Ordered" and can be closed. **The stock page and the reorder report**
  show what approved orders still have to bring ("Incoming"), so nobody orders the same yarn twice.

## The whole picture

```
packages/contracts   purchase-orders.ts (new): statuses, lines = sales lines + requisition line + received/rejected
      │               goods-receipts.ts (new): lines = stock lines + order line + rejected + reason
      │               requisitions.ts: orderState, orderedQuantity, closed, open lines · purchase.ts: last price
      │               stock accounts: received_not_billed · settings: overReceiptPercent · withTolerance()
      │               approvals + document output: purchase_order · public page: recipient · 2 permissions
      │               16 errors · 17 new routes
      ▼
packages/db          purchase_orders, purchase_order_lines, goods_receipts, goods_receipt_lines
      │               0037 (drizzle) · 0038 (RLS, the requisition link, the guards, the stock accounts job queued)
      ▼
apps/api             purchase/: PurchaseOrdersService, GoodsReceiptsService, requisitions count what was ordered,
      │               the cost lookup's last price · stock books: purchaseReceipt() · templates: 2115, buyer and
      │               store keeper roles · stock: incoming · settings: the percent · documents: the PO PDF and email
      ▼
apps/app             Purchase orders and Goods receipts in the navigation · the order form (the sales line editor
                     with a LinePricing), page, approval card and Send menu · the receipt form and page · Make
                     purchase order on a requisition · Incoming on stock · Settings: the percent, the Buying account
                     packages/i18n: the words · packages/ui: the segmented control fix · MSW · Playwright

one line: 1,000 m of jersey from Meghna Spinning Mills at ৳312.50 (net ৳3,12,500); levels: Purchase manager from ৳1,00,000
  Mitu (merchandiser) on PR-2026-27-0003 → Make purchase order ──GET /requisition-lines?requisitionId=…──► its open lines
  Save draft ──POST /purchase-orders──► a draft, no number; the price came from POST /purchase/cost-lookup
  Submit for approval ──POST /purchase-orders/{id}/submit {version}──► one transaction:
     the supplier and warehouse still active? · PO-2026-27-0001 · levelsFor(levels, total with VAT) · a round
     order → pending · bell to the Purchase managers (17a's engine: APPROVAL_TARGETS.purchase_order)
  Kamal approves ──► order approved, locked · Send → PDF, email or WhatsApp link to Meghna
     PR-…-0003's line counts 1,000 m ordered ("Ordered") · the stock page shows 1,000 m incoming
  Jamal (store keeper) at the gate ──POST /goods-receipts {orderId, lines}──► a draft: accepted 600, rejected 0
  Post goods receipt ──POST /goods-receipts/{id}/post {version}──► one transaction:
     lock the order: still approved? · 600 ≤ 1,000 + 3% − received before? · number GRN-2026-27-0001
     stock in 600 m worth 600/1,000 of the line's net = ৳1,87,500 · the moving average · the lot
     entry Dr Inventory / Cr Goods received not billed ৳1,87,500 (the warehouse's branch), source purchase_receipt
     order line received 600 → "Partly received" · incoming 400
  the second truck: 440 m, 12 m rejected ("Shade does not match") ──► accepted 428: 1,028 ≤ 1,030 · ৳1,33,750
     every goods line in full → order "Received" · incoming 0
  or the rest will not come: Close order ──► closed; the requisition now counts only what came, the rest is to order
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| The supplier's bill, input VAT and supplier payments | 17c. The bill posts Dr Goods received not billed / Dr VAT input / Cr Accounts payable, and a price that differs from the order's goes to "Purchase price difference" (decision 2) |
| Buying without an order | 17c's direct bill, which makes its own receipt (decision 8) |
| Purchase returns and debit notes | 17d. What the gate rejected never came into stock, so it needs no return; goods sent back after a posted receipt do |
| Orders in dollars, the LC, landed cost (freight, customs duty) | A later step (decision 10) |
| VDS and AIT (Mushak 6.6), supplier price lists | Later steps (17's decision 4). A line starts at the last price paid (decision 19) |
| Revisions and amendments of an order | An approved order is reopened until goods come in, then closed and a new one written (decision 11) |
| A quality check as its own step (goods on hold until a QC person passes them) | The gate records accepted and rejected on the receipt (decision 9) |
| Delivery schedules per line, blanket orders | One expected date per order |
| Cancelling part of one order line | Close the order: what did not come is dropped, and the requisition counts it as still to order (decision 16) |
| A goods receipt in another warehouse's branch moving the payable | The entry carries the branch of the warehouse that took the goods in (17b.3); the bill clears it there |

## What changes in the code you already have

- **`pnpm db:migrate`** adds 0037 (four tables, the requisition's `closed` status and `tenant_settings.
  over_receipt_percent`, 0 by default) and 0038 (their rules). 0038 also queues step 14's stock accounts job once for
  every workspace with a chart, and the worker then adds **2115 "Goods received not billed"** under current
  liabilities and chooses it in Settings → Inventory → Stock accounts → Buying (decision 12). If your chart already
  has an account at 2115, it is not taken over: choose the account yourself, or posting a goods receipt is refused
  with `stock_account_missing`. No new package and no new `.env` line.
- **"Goods received not billed" is closed to people**, like the inventory and goods in transit accounts: a manual
  journal line or an opening balance on it is refused with `journal_account_stock`, and the journal's Reverse refuses
  a goods receipt's entry with `journal_is_stock` (decision 37).
- **A requisition that an order buys for** cannot be reopened or cancelled any more (`purchase_close_instead`); it
  is closed. A requisition line's estimated cost now starts from the last price paid, and from the average cost only
  when nothing was bought before (decision 19).
- **A product or a supplier used on an order or a receipt** cannot be deleted (`product_variant_in_use`,
  `supplier_in_use`), like on every other document.
- **The role templates** give `purchase.order.manage` and `purchase.receipt.manage` to new workspaces only
  (decision 36). In a workspace you already have, give them in Settings → Roles; the Owner has both already.
  Settings → Approval levels gets a "Purchase orders" card with no level: until you add one, an order is approved
  when it is submitted.
- **Contracts:** the public page's `customer` is `recipient` now (decision 24), in the API, the app and the words
  (`publicDocument.to` takes `{{recipient}}`). The cost lookup takes a `supplierId` and gives each item a `taxRateId`.
  The company settings have `overReceiptPercent`, so every form that saves them sends it. The stock list and the
  reorder report have `incoming`.
- **app:** the sales line editor takes a `LinePricing` (decision 43); the sales screens pass the customer's and
  look the same. The Send menu's `OutputTarget.customerId` is `partyId` (decision 48). The app's build drops the
  routes' summaries with a small Vite plugin (decision 50). In `packages/ui`, the segmented control's `fieldset` is
  `relative` (decision 54), which every list with one gets.
- **Existing tests that change:** in the API, `settings.int.spec.ts` (the percent, two new tests), the settings form
  in `journal`, `stock`, `invoices`, `returns`, `sales-documents` and `document-output` (it sends the percent;
  document output also reads `recipient`), `requisitions.int.spec.ts` (the rule list has `purchase_order`; the cost
  lookup's VAT rate) and `setup.int.spec.ts` (the buyer and store keeper permissions); in the app,
  `onboarding.e2e.ts` (48 accounts, not 47). The mock API's garments workspace gets 2115, order approval levels,
  one approved order (the buttons from Unitex, late) and one draft.

## The decisions behind this step

You made the first eleven: decisions 1–4 on 2026-10-15 for all of step 17, decisions 5–11 on 2026-10-18 for this
guide. The others came up while building it; please read them with care: they are mine.

1. **Purchase is four guides,** like sales: 17a suppliers, requisitions and approvals; 17b purchase orders and goods
   receipts (this guide); 17c bills and supplier payments; 17d purchase returns and debit notes. (You chose this.)
2. **A goods receipt is booked at the order's price.** (You chose this.) Posting it brings the accepted goods into
   stock and posts Dr Inventory / Cr "Goods received not billed", and the moving average cost (step 14) takes them in
   at that price at once. The supplier's bill (17c) later posts Dr Goods received not billed / Dr VAT input / Cr
   Accounts payable, and a price that differs from the order's goes to a "Purchase price difference" account, not
   into the stock's value.
3. **A purchase order needs an approval like a requisition:** levels by amount, each a role, decided one after
   another, a rejection sends it back to draft. (You chose this.) 17a's engine does it; the order is its second kind
   of document.
4. **A purchase order goes out with the whole Send menu** of step 16: a PDF in either language, an email and a
   WhatsApp share link with its public page. (You chose this on 2026-10-18; on 2026-10-15 it was PDF and email.)
5. **Requisitions become orders line by line.** (You chose this.) An order line may buy for any line of an approved
   requisition. One requisition is split over the suppliers that sell its items, and one order may buy for several
   requisitions. Each requisition line shows how much was ordered, and the requisition shows "Partly ordered" or
   "Ordered".
6. **An order line is priced like a sales line:** a price, a discount (% or ৳) and a VAT rate, and the order says
   whether its prices include VAT. (You chose this.) The arithmetic is the sales line's own (`lineAmounts`), so the
   order shows to the paisa what the supplier's bill will show. The goods go into stock at the line's net: after the
   discount, before the VAT, which the bill (17c) books as input VAT.
7. **A goods receipt may bring in a little more than ordered,** up to a percent the workspace sets ("Receive up to 3%
   over the order"; 0 by default). (You chose this.) Above it the receipt is refused. What came over the order is
   booked at the order's price too.
8. **A goods receipt is always made from an approved order.** (You chose this.) The person at the gate never types a
   price. A purchase without an order is 17c's direct bill, which makes its own receipt.
9. **The gate records what it turned back.** (You chose this.) A receipt line has what was accepted and what was
   rejected, with the reason. Only the accepted part goes into stock and counts against the order; the rejected part
   is on the record for the supplier.
10. **Orders are in taka.** (You chose this.) An import order in dollars comes with landed cost and the LC, in a
    later step.
11. **An approved order is changed by reopening it,** which takes it back to draft and through the approval again,
    until goods were received against it. (You chose this.) After that, it is closed and a new order is written for
    the rest. There are no revisions.

**The contract (17b.1):**

12. **"Goods received not billed" is a stock account, not an account purpose.** It is a new use,
    `received_not_billed`, next to step 14's in-transit account, so it is chosen in Settings → Inventory. The
    templates get a liability account for it (2115). A workspace made before this step gets it from step 14's own
    job, which a migration queues again: it adds the template's account where it is missing and never takes over an
    account the owner made. Until an account is chosen, posting a goods receipt is refused with step 14's
    `stock_account_missing`. A purpose would need the account to exist in every workspace on the day of the
    migration, with no way out when the owner already used the code.
13. **An order gets its number when it is first submitted** (PO-2026-27-0001). The approvers, the bell and the
    "waiting for me" list need a number to talk about; a draft nobody submitted is only a page someone is writing.
    Such a draft may be deleted, so deleting leaves no gap. Once numbered it is cancelled, never deleted, like a
    requisition.
14. **The approval levels are chosen by the order's total, VAT included:** what the company will pay.
15. **An order keeps its own payment terms and VAT setting.** The terms start as the supplier's and print on the
    PDF; the bill (17c) starts from them. "Prices include VAT" starts off: suppliers quote before VAT, and the
    workspace's own setting is about the prices it sells at.
16. **What counts as ordered.** A requisition line counts as ordered by the order lines that point at it: all of
    their quantity while the order is open, only what was received once the order is closed (the rest is still
    wanted), nothing once it is cancelled. An order line may order more than the requisition asked for (a mill's
    minimum order): the order has its own approval. It must be for the same item and from a requisition for the
    order's warehouse, and in any of the item's units. One order line per requisition line.
17. **A requisition can be closed.** Once an order buys for it, it can no longer be reopened or cancelled; "Close"
    says the rest will not be ordered. `purchase_close_instead` and `purchase_cancel_instead` tell a person which
    one they need, for a requisition and for an order alike.
18. **The order form picks from "lines still to order"** of one warehouse (`GET /requisition-lines`), oldest
    requisition first. "Make purchase order" on a requisition's page opens the same list narrowed to that
    requisition.
19. **A line's starting price is the last price paid:** this supplier's latest approved order for the item, else
    anyone's, else the average cost (as in 17a, only for someone with `inventory.stock.value`). A price on an order
    is a price people agreed, so everyone who writes purchases may see it. It is the net per unit, moved to the
    line's unit. The lookup also gives the item's VAT rate, like the sales price lookup. A requisition's estimated
    cost uses the same lookup, so it now starts from the last price too.
20. **A goods receipt line's `quantity` is what was accepted,** the part that moves stock, so every stock rule (lots,
    serial numbers, the base unit) reads it as on any other stock line. `rejectedQuantity` and a required
    `rejectionReason` sit beside it. A line may accept nothing when everything that came was turned back. The
    receipt gets its number when it is posted, may unload at another warehouse than the order's, keeps the
    supplier's challan number and the vehicle, and keeps its order when edited.
21. **An order with a goods receipt is not reopened, even a draft one.** Reopening lets its lines change, and a draft
    receipt points at them. The person deletes the draft receipt first. (The sales order of step 15b has the same
    rule.)
22. **The over-receipt percent is a company setting,** next to "allow negative stock": 0 to 100, at most 2 decimals.
    The limit is rounded down, so it never lets in more than the percent says. What was rejected does not count.
23. **The stock page and the reorder report show what is coming** (`incoming`): what approved orders still have to
    bring, next to what is on hand, so a buyer does not order the same yarn twice.
24. **The public page's `customer` is now `recipient`.** A purchase order's link is opened by its supplier, and a
    field called `customer` holding a supplier's name would mislead the next person who reads the code.
25. **Two permissions:** `purchase.order.manage` (the buyer) and `purchase.receipt.manage` (the store keeper at the
    gate). Sending an order needs the first, like every other document. There is still no approve permission
    (17a's decision 5).

**The database (17b.2):**

26. **What was ordered is counted, never stored.** A requisition line has no "ordered" column: the API adds up the
    order lines that point at it, by their order's status (decision 16). A stored number would have to change when an
    order is approved, received, closed or cancelled, each time under a lock on a requisition that is no longer a
    draft, and the requisition's guard would need an exception for it. Counting needs only an index.
27. **Any order that is not cancelled holds its requisition,** even a draft nobody submitted: while one points at it,
    the requisition is not reopened or cancelled, only closed. Reopening writes the requisition's lines again, and the
    draft order's lines would lose their link without anyone noticing. A cancelled order lets go; if the requisition
    is then changed, the cancelled order's line keeps everything but the link.
28. **The database checks the requisition an order line buys for:** the same item (the foreign key holds the
    variant), a requisition for the order's warehouse, approved or closed. It locks the requisition's row while it
    checks, so a cancel at the same moment waits and then fails, instead of both getting through.
29. **A goods receipt, even a draft, also stops a cancel,** not only a reopen (decision 21). Closing needs a posted
    receipt (an order nothing came for is cancelled), and "received" needs every goods line in full. A service line
    on the order (a dyeing charge) is never received, so it does not hold the order open.
30. **A draft receipt of an order that was closed or received in the meantime cannot be posted;** it is deleted.
    Posting checks the order is still approved, under the same lock as the cancel.
31. **A receipt line keeps a copy of its order's id,** so two foreign keys can say what the API also checks: the
    order line is a line of the receipt's order, and for the same item.
32. **An order line never takes in more than double what was ordered.** 100% is the highest over-receipt percent
    (decision 22); the workspace's own percent is the API's check, and this is the last word whatever a bug does.

**The API (17b.3):**

33. **A numbered order keeps its supplier.** The number went to that supplier (on the PDF, in an email), so a
    reopened order cannot move to another one; the buyer writes a new order. A sales order keeps its customer the
    same way (step 15b).
34. **Submitting checks the supplier and the warehouse again.** A draft may keep a supplier or a warehouse archived
    after it was written, so the person can finish it; an order is not sent to a supplier the company stopped buying
    from.
35. **An order goes out once it is approved.** The Send menu refuses a draft, a pending order (it may still be
    rejected) and a cancelled one with step 16's `document_not_issued`. A received or closed order may be sent again:
    the supplier asks for a copy.
36. **The buyer and the store keeper are different roles in the templates.** Purchase orders go to the
    merchandiser (garments) and the production manager (manufacturing); goods receipts to the store keeper and the
    depot managers. A shop's manager and a general manager get both. A pharma or distribution company buys at head
    office, so its orders stay the owner's until the owner gives the permission to a role.
37. **"Goods received not billed" is closed to manual entries,** like the inventory and goods in transit accounts
    (`journal_account_stock`), and to opening balances. What it holds must be what posted receipts brought in and no
    bill has billed yet; a manual line would leave the bill (17c) clearing a number nobody can explain.
38. **A receipt line that accepted nothing needs no lot and no serial numbers.** Nothing comes in, so there is no
    batch to find and no IMEI to record. A rejection reason is kept only when something was turned back.
39. **What came in is worth the order line's net, shared by quantity** (to the paisa): 600 m of a line of 1,000 m
    worth ৳3,12,500 is ৳1,87,500, and 1,028 m is ৳3,21,250. Two receipt lines of one order line (two lots) are worth
    their own shares.
40. **The over-receipt limit is checked when a draft is saved and again when it is posted,** for each order line,
    with every receipt line that points at it together and what posted receipts accepted before. A draft holds
    nothing, so the second of two drafts to post is the one refused.
41. **"Incoming" is counted where the order says the goods go,** line by line and never below zero: a line that came
    over the order does not cancel another line still waiting. A receipt may unload elsewhere (decision 20); until it
    is posted, the stock page cannot know that.
42. **Three new error codes** in the contract: `purchase_not_approved` (a close, a receipt or a post against a
    document that is no longer approved), `purchase_delete_instead` (a cancel of a draft nobody submitted) and
    `purchase_receipt_draft` (a reopen or a cancel while a draft goods receipt points at the order).

**The screens (17b.6):**

43. **A purchase order's lines are the sales line editor's,** not a copy of it. The editor now takes a `LinePricing`:
    where a new line's price comes from (the sales price lookup for a customer, the purchase cost lookup for a
    supplier), the unit a product starts in, and the few words that differ. The math, the boxes and the totals are
    the same code for both, so an order shows to the paisa what the API stores (decision 6). The cost lookup sends
    the net; when the order's prices include VAT, the starting price gets its VAT added, so the "Price with VAT" box
    does not start a VAT short.
44. **An order is written as a draft and submitted from its page,** like a requisition, not confirmed from the form
    like a sales order. The page shows the approval card, which lists the levels the total reaches before anyone
    presses Submit, and a draft sent back shows the approver's comment above it.
45. **"Make purchase order" opens the form with the "lines still to order" dialog,** narrowed to that requisition
    and to its warehouse, instead of filling every line at once. One requisition is often split over two suppliers
    (decision 5); the buyer picks the lines this supplier sells and leaves the rest for the next order.
46. **A goods receipt picks its supplier, then the order in a select,** like a delivery picks its customer, then
    its order. The supplier only narrows the list (the API takes the supplier from the order), and the list is the
    supplier's approved orders with goods still to come. So the order is not a form value: a draft keeps its order
    (decision 20), and the update route has no `orderId`. The order search of 17b.5's words was not needed and is
    gone (`goodsReceipts.orderSearch`); the order page has its own "Edit" (`purchaseOrders.edit`).
47. **The new pills:** a closed requisition is neutral with a stop icon, like a closed sales order. How much of an
    approved requisition is ordered is a second pill: "Partly ordered" brand (work in progress), "Ordered" good; no
    pill while nothing is. An order is Draft, Waiting (brand), Approved (good, like an approved requisition), Partly
    received (brand, in Approved's place, like a sales order's Partly delivered), Received (good), Closed and
    Cancelled (neutral), with a warn "Late" pill when it is approved and past its delivery date. A goods receipt is
    Draft or Posted, like a delivery. "To order" and "To receive" sit in the lists' status controls, because each
    is a kind of approved document. 17b.9 writes these into CLAUDE.md.
48. **The Send menu finds its recipient by the kind of document.** `OutputTarget.customerId` is `partyId` now, and
    `recipientRole()` says a purchase order goes to its supplier and every sales document to its customer. A
    `Record` over the document kinds, so a new kind does not compile until it says who gets it. The menu reads the
    supplier's language and phone the way it read the customer's.
49. **Received and rejected are shown in the base unit on the order's page,** like a sales order's Delivered: one
    order line in bags may be received in kilograms on a second truck. On a goods receipt the rejected quantity is
    in the line's own unit, beside the accepted one, because that is how the store keeper counted it.
50. **The app's bundle leaves out the routes' summaries.** Each route in the contracts has an English summary for
    the OpenAPI document. The browser never reads them, but every page carried all of them: 4 KB of each page's
    100 KB budget, and 17b's contracts took seven pages over it. A small Vite plugin drops those lines from the built
    contracts in the app's build only; the API and the OpenAPI script still have them. This makes room for every
    page at once, where the earlier steps moved one page's parts into chunks of their own each time.

**The mock and the tests (17b.7):**

51. **The mock keeps orders and receipts in its purchase part, in a file of their own.** `purchase-order-data.ts`
    holds the orders and the goods receipts and imports the approval engine from `requisition-data.ts`. The
    requisition file needs the orders too (how much of a line was ordered, the last price), but it reads them through
    the `WorkspaceData` type only, never by importing a function. An import both ways would be a circular import,
    and `pnpm boundaries` refuses those.
52. **The mock's seed has one approved order and one draft, and no goods receipt.** PO-…-0001 is 1,000 gross of
    buttons from Unitex, approved by Kamal and two days late; the draft is the Owner's, for jersey from Meghna.
    PR-…-0002 (the mailer bags) stays unordered, so a test can make its order. No receipt is posted in the seed, so
    the seeded books, stock values and reports stay what the older tests expect. Orders are approved from ৳50,000 by
    the purchase manager and from ৳5,00,000 by a director as well. The buttons are the seeded order, not the
    jersey: an approved jersey order would give the jersey a "last price", and 17a's test that starts a requisition
    line at the average cost would break.
53. **A goods receipt posts in the mock's `transaction()`.** Posting moves stock, makes batches, takes a number,
    books an entry and counts on the order. The mock's `transaction()` (step 15c) puts all of that back when a step
    fails; it now copies the purchase part too, so a refused post leaves the order and the number as they were.
54. **A fix in `@omnivo/ui`: the segmented control keeps its radios inside its box.** The purchase order list was the
    first with eight options, and on a phone the page scrolled sideways by 211 px. The radios are `sr-only`, which
    places them absolutely; the scrolling `fieldset` around them was not a placed box, so nothing clipped them, and
    the ones past the edge made the page wider. The `fieldset` is `relative` now. This is a cross-part fix to a
    shared component; every list with a segmented control gets it.

## 17b.1 — `packages/contracts`: the contract

As in every step, the contract comes first. Two new files: `purchase-orders.ts` and `goods-receipts.ts`. The
requisition learns how much of it was ordered, the cost lookup learns the last price, and the rest are small: the
new stock account, the over-receipt setting, the order as a document that needs an approval and goes out, two
permissions, the error codes, the audit actions and the routes.

### `purchase-orders.ts` (new)

```ts
import { z } from 'zod';

import { documentApprovalSchema } from './approvals.js';
import { MAX_PAYMENT_TERMS_DAYS } from './customers.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { MAX_PURCHASE_LINES } from './purchase.js';
import {
  documentRefSchema,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
} from './sales.js';
import { optionalDateSchema, optionalIdSchema } from './stock.js';

// A purchase order (step 17b): what the company asks a supplier to deliver, at what price. It is
// written by a buyer, approved like a requisition (approvals.ts, levels by its total), sent to the
// supplier (a PDF, an email or a share link, step 16), and received by goods receipts
// (goods-receipts.ts) in as many deliveries as the supplier makes.
//   draft      being written, or sent back by a rejection or a reopen
//   pending    submitted, waiting for an approval
//   approved   may be sent and received; partlyReceived says whether some of it came already
//   received   every goods line came in full (set by the goods receipt that finished it)
//   closed     partly received, and the rest will not come: the mill delivered 900 of 1,000 m
//   cancelled  will not be bought: a draft that was submitted once, or an approved order before
//              anything was received
// It gets its number (PO-2026-27-0001) when it is first submitted: the approvers and the bell need
// a number to talk about, while a draft nobody submitted is only a page someone is writing, and
// deleting it leaves no gap. Once numbered it is never deleted, only cancelled, so its approval
// history stays (the rule of 17a's requisition).
// Approved is locked. "Reopen" takes it back to draft, and it is approved again from the first
// level (you chose this), until the first goods receipt is written against it: after that, close
// it and write a new order for the rest. Prices are in taka only (you chose this): an import in
// dollars comes with landed cost and the LC, in a later step.
export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'pending',
  'approved',
  'received',
  'closed',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const purchaseOrderSummarySchema = z.object({
  id: z.uuid(),
  // null until it is first submitted
  number: z.string().nullable(),
  date: z.iso.date(),
  // When the supplier should deliver; null = not agreed. The page shows a "Late" pill for an
  // approved order past it.
  expectedDate: z.iso.date().nullable(),
  supplier: partyRefSchema,
  // The supplier's own number for this deal: its quotation or proforma invoice (PI-0412)
  supplierReference: z.string().nullable(),
  // Where the goods are to be delivered. Its branch is the order's branch.
  warehouseId: z.uuid(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  // Approved, and some (not all) of it received
  partlyReceived: z.boolean(),
  net: z.string(),
  vat: z.string(),
  // What the approval levels are chosen by: what the company will pay, VAT included
  total: z.string(),
  lineCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PurchaseOrderSummary = z.infer<typeof purchaseOrderSummarySchema>;

// The requisition line an order line buys for: its id (the form sends it back), and the
// requisition's number for the page's link
export const requisitionLineRefSchema = z.object({
  id: z.uuid(),
  requisitionId: z.uuid(),
  number: z.string(),
});
export type RequisitionLineRef = z.infer<typeof requisitionLineRefSchema>;

// A line is a sales line's shape (sales.ts): the same price, discount and VAT arithmetic (you chose
// this), so the order shows the totals the supplier's bill will show
export const purchaseOrderLineSchema = salesLineSchema.extend({
  requisitionLine: requisitionLineRefSchema.nullable(),
  // In the base unit, by posted goods receipts: what came in and was accepted. It may pass the
  // ordered quantity by the workspace's tolerance (settings.ts). A service line stays at zero: it
  // is never received, the bill (17c) takes it straight from the order.
  receivedQuantity: z.string(),
  // In the base unit, by posted goods receipts: what came and was turned back at the gate. It
  // does not count as received; the supplier still owes it.
  rejectedQuantity: z.string(),
});
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;

// A goods receipt made against the order, as its page lists them
export const orderReceiptSchema = z.object({
  id: z.uuid(),
  number: z.string().nullable(),
  date: z.iso.date(),
  // z.string(): a goods receipt's status (goods-receipts.ts)
  status: z.string(),
});
export type OrderReceipt = z.infer<typeof orderReceiptSchema>;

export const purchaseOrderSchema = purchaseOrderSummarySchema.extend({
  // The supplier's payment terms when the order was written, or what the buyer agreed for this
  // order: the PDF prints it, and the bill (17c) starts from it
  paymentTermsDays: z.number().int(),
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  // Printed on the order: delivery instructions, packing, the buyer's style number
  note: z.string().nullable(),
  lines: z.array(purchaseOrderLineSchema),
  // The requisitions its lines buy for, by number
  requisitions: z.array(documentRefSchema),
  receipts: z.array(orderReceiptSchema),
  // Every time it was submitted, newest first
  approval: documentApprovalSchema,
});
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// A line from a requisition names its line: the requisition must be approved, for the order's
// warehouse, and the line for the same variant. The unit may differ: the store asked for 480
// pieces, the buyer orders 20 cartons of 24. The quantity may be more than the requisition asked
// for (a mill's minimum order); the order has its own approval.
export const purchaseOrderLineInputSchema = salesLineFieldsSchema
  .extend({ requisitionLineId: optionalIdSchema })
  .superRefine(salesLineRules);
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;
export type PurchaseOrderLineFormValues = z.input<typeof purchaseOrderLineInputSchema>;

const purchaseOrderFieldsSchema = z.object({
  supplierId: z.uuid(errorCode('purchase_supplier_required')),
  date: z.iso.date(errorCode('purchase_date_required')),
  expectedDate: optionalDateSchema,
  warehouseId: z.uuid(errorCode('purchase_warehouse_required')),
  supplierReference: optionalText(60),
  paymentTermsDays: z.number().int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
  // The form starts it off: a supplier quotes before VAT, so a buyer seldom ticks it
  pricesIncludeVat: z.boolean(),
  note: optionalText(500),
  lines: z
    .array(purchaseOrderLineInputSchema)
    .min(1, errorCode('purchase_lines_required'))
    .max(MAX_PURCHASE_LINES),
});

type PurchaseOrderRuleInput = z.output<typeof purchaseOrderFieldsSchema>;

function purchaseOrderRules(
  input: PurchaseOrderRuleInput,
  ctx: z.RefinementCtx<PurchaseOrderRuleInput>,
) {
  if (input.expectedDate !== null && input.expectedDate < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['expectedDate'],
      message: errorCode('purchase_expected_date'),
    });
  }
  // One order line per requisition line: two would count the same request twice
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    if (line.requisitionLineId === null) return;
    if (seen.has(line.requisitionLineId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'requisitionLineId'],
        message: errorCode('purchase_requisition_line_twice'),
      });
    }
    seen.add(line.requisitionLineId);
  });
}

export const purchaseOrderInputSchema = purchaseOrderFieldsSchema.superRefine(purchaseOrderRules);
export type PurchaseOrderInput = z.infer<typeof purchaseOrderInputSchema>;

export const updatePurchaseOrderInputSchema = purchaseOrderFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(purchaseOrderRules);
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderInputSchema>;
export type PurchaseOrderFormValues = z.input<typeof updatePurchaseOrderInputSchema>;

export const purchaseOrderVersionInputSchema = z.object({ version: versionSchema });

export const deletePurchaseOrderQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// to_receive: approved, with a goods line that has not all come in — what the goods receipt form
// offers
export const PURCHASE_ORDER_RECEIPT_FILTERS = ['to_receive'] as const;
export type PurchaseOrderReceiptFilter = (typeof PURCHASE_ORDER_RECEIPT_FILTERS)[number];

export const purchaseOrderListQuerySchema = pageQuerySchema.extend({
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  receipt: z.enum(PURCHASE_ORDER_RECEIPT_FILTERS).optional(),
});
export type PurchaseOrderListQuery = z.input<typeof purchaseOrderListQuerySchema>;

export const purchaseOrderPageSchema = pageOf(purchaseOrderSummarySchema);
export type PurchaseOrderPage = z.infer<typeof purchaseOrderPageSchema>;

const purchaseOrderParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every other document. Writing, submitting, reopening, closing
// and cancelling need purchase.order.manage; approving needs the level's role (approvals.ts).
export const purchaseOrderRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/purchase-orders',
    summary: 'Purchase orders, newest date first',
    auth: 'bearer',
    status: 200,
    query: purchaseOrderListQuerySchema,
    response: purchaseOrderPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/purchase-orders/:id',
    summary: 'One purchase order with its lines, receipts and approval history',
    auth: 'bearer',
    status: 200,
    params: purchaseOrderParamsSchema,
    response: purchaseOrderSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/purchase-orders',
    summary: 'Write a purchase order as a draft',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 201,
    body: purchaseOrderInputSchema,
    response: purchaseOrderSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/purchase-orders/:id',
    summary: 'Change a draft purchase order',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: updatePurchaseOrderInputSchema,
    response: purchaseOrderSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/purchase-orders/:id',
    summary: 'Delete a draft purchase order that was never submitted',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 204,
    params: purchaseOrderParamsSchema,
    query: deletePurchaseOrderQuerySchema,
    response: z.void(),
  }),
  // The first submit gives the number. With no level for its total it is approved at once.
  submit: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/submit',
    summary: 'Send a draft purchase order for approval',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/reopen',
    summary: 'Take a pending or approved order with no goods receipt back to draft',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
  close: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/close',
    summary: 'Stop receiving a partly received order',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/cancel',
    summary: 'Cancel a draft order, or an approved one that received nothing',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
};
```

- **The statuses mirror the sales order's, with the approval in the middle.** `pending` and `approved` are 17a's
  states; `received`, `closed` and `cancelled` are the sales order's `delivered`, `closed` and `cancelled`.
  `partlyReceived` is a flag beside `approved`, like `partlyDelivered`: the order is still open either way.
- **`number` is nullable** (decision 13): null until the first submit.
- **A line is `salesLineSchema` extended,** not a copy. The price, discount and VAT boxes, their checks
  (`salesLineRules`) and the amounts the API sends are the ones sales documents use (decision 6), so the form can
  reuse the sales line editor and the totals block. A copy would drift the first time one of them changed.
- **`receivedQuantity` and `rejectedQuantity` are in the base unit,** like a sales order's `deliveredQuantity`,
  because one order line can be received in another unit (ordered by the carton, counted by the piece).
- **`requisitionLine` carries the requisition's id and number,** so the order page links each line to the
  requisition it buys for without a second request.
- **`paymentTermsDays` and `pricesIncludeVat` are the order's own** (decision 15).
- **The rules:** an expected date on or after the order date, and one order line per requisition line (decision 16).
  The error sits on the second line's box, so the form marks the line to change.
- **`receipt: 'to_receive'`** is the list the goods receipt form picks an order from: approved, with goods still to
  come. Like the delivery list's `invoice: 'to_invoice'`, it is worked out by the server, because "still to come"
  needs the receipts.
- **Five actions besides the form:** submit, reopen, close, cancel and delete. Approve and reject are 17a's generic
  `/approvals/purchase_order/:id/…` routes.

```ts
import { describe, expect, it } from 'vitest';

import { costLookupInputSchema } from './purchase.js';
import {
  purchaseOrderInputSchema,
  type PurchaseOrderLineFormValues,
  updatePurchaseOrderInputSchema,
} from './purchase-orders.js';
import { documentTotals, lineAmounts } from './sales.js';

const SUPPLIER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RATE = '01920000-0000-7000-8000-000000000005';
const REQUISITION_LINE = '01920000-0000-7000-8000-000000000006';

function line(extra: Partial<PurchaseOrderLineFormValues> = {}): PurchaseOrderLineFormValues {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '40',
    description: '',
    unitPrice: '4250.50',
    discountType: 'percent',
    discount: '',
    taxRateId: RATE,
    requisitionLineId: '',
    ...extra,
  };
}

function order(extra: Record<string, unknown> = {}) {
  return {
    supplierId: SUPPLIER,
    date: '2026-10-18',
    expectedDate: '',
    warehouseId: WAREHOUSE,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines: [line()],
    ...extra,
  };
}

describe('purchase order input', () => {
  it('reads empty boxes as "not set": no expected date, no requisition, no discount', () => {
    expect(purchaseOrderInputSchema.parse(order())).toMatchObject({
      expectedDate: null,
      supplierReference: null,
      note: null,
      lines: [expect.objectContaining({ requisitionLineId: null, discount: '0' })],
    });
  });

  it('needs a supplier, on that box', () => {
    expect(purchaseOrderInputSchema.safeParse(order({ supplierId: '' })).error?.issues).toEqual([
      expect.objectContaining({ path: ['supplierId'], message: 'purchase_supplier_required' }),
    ]);
  });

  it('refuses an expected date before the order', () => {
    expect(
      purchaseOrderInputSchema.safeParse(order({ expectedDate: '2026-10-17' })).error?.issues,
    ).toEqual([
      expect.objectContaining({ path: ['expectedDate'], message: 'purchase_expected_date' }),
    ]);
  });

  it('takes a requisition line once, and marks the second line', () => {
    const lines = [
      line({ requisitionLineId: REQUISITION_LINE }),
      line({ requisitionLineId: REQUISITION_LINE }),
    ];
    expect(purchaseOrderInputSchema.safeParse(order({ lines })).error?.issues).toEqual([
      expect.objectContaining({
        path: ['lines', 1, 'requisitionLineId'],
        message: 'purchase_requisition_line_twice',
      }),
    ]);
  });

  it('keeps the sales line rules: no discount bigger than the line', () => {
    const lines = [line({ discountType: 'amount', discount: '170020.01' })];
    expect(purchaseOrderInputSchema.safeParse(order({ lines })).error?.issues).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'discount'],
        message: 'sales_discount_too_large',
      }),
    ]);
  });

  it('keeps payment terms within a year, and the edit form sends its version', () => {
    expect(purchaseOrderInputSchema.safeParse(order({ paymentTermsDays: 366 })).success).toBe(
      false,
    );
    expect(updatePurchaseOrderInputSchema.safeParse(order()).success).toBe(false);
    expect(updatePurchaseOrderInputSchema.safeParse(order({ version: 3 })).success).toBe(true);
  });

  it('works the totals out like a sales document: discount, then VAT, per line', () => {
    // 40 rolls at ৳4,250.50 less 2.5% = ৳165,769.50 before VAT, ৳24,865.43 VAT at 15%
    const amounts = lineAmounts(
      {
        quantity: '40',
        unitPrice: '4250.50',
        discountType: 'percent',
        discount: '2.5',
        rate: '15',
      },
      false,
    );
    expect(documentTotals([amounts])).toEqual({
      discount: '4250.5000',
      net: '165769.5000',
      vat: '24865.4300',
      total: '190634.9300',
    });
  });
});

describe('purchase cost lookup input', () => {
  it('needs no supplier: a requisition has none', () => {
    expect(
      costLookupInputSchema.parse({ items: [{ variantId: VARIANT, unitId: UNIT }] }).supplierId,
    ).toBeNull();
  });
});
```

- The totals test uses a garments case (40 rolls at ৳4,250.50, 2.5% off, 15% VAT) where the VAT ends in a half
  paisa (24,865.425), so it proves the order rounds each line exactly as a sales document does.

### `goods-receipts.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  addQuantity,
  isQuantityOrZero,
  isZeroQuantity,
  receivedQuantitySchema,
} from './quantities.js';
import { documentRefSchema } from './sales.js';
import { STOCK_DOCUMENT_STATUSES } from './stock-adjustments.js';
import {
  documentSerialRules,
  MAX_STOCK_LINES,
  stockInLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// A goods receipt (GRN, step 17b): what a supplier's truck brought in against a purchase order.
// The store keeper counts it at the gate: what came, and what was turned back (torn rolls, a
// carton of broken bottles, the wrong shade). Like a delivery: a draft can be changed, "Post"
// gives it its number (GRN-2026-27-0001), brings the accepted goods into stock and books them at
// the order's price (you chose this): Dr Inventory / Cr Goods received not billed, and the moving
// average cost (step 14) takes them in at that price. The supplier's bill (17c) later moves the
// amount to the payable. A posted receipt is not changed: what goes back to the supplier after
// that is a purchase return (17d).
//
// It is always made from an approved order (you chose this): its lines point at the order's goods
// lines, and an order is received in as many receipts as the supplier needs. A purchase without
// an order is the bill's job in 17c (a direct bill makes its own receipt). The receipt carries no
// prices: the order line has them, so the person at the gate never types one.

// What came off the truck for a line: what was accepted (and goes into stock) plus what was turned
// back. The form shows it under the two boxes; a person counting at the gate thinks in it.
export function receivedOf(line: { quantity: string; rejectedQuantity: string }): string {
  return addQuantity(line.quantity, line.rejectedQuantity);
}

// ---------------------------------------------------------------------------------------------
// What the API sends

export const goodsReceiptSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  supplier: partyRefSchema,
  order: documentRefSchema,
  warehouseId: z.uuid(),
  status: z.enum(STOCK_DOCUMENT_STATUSES),
  // The number on the supplier's delivery challan, as it was handed over at the gate: the bill
  // (17c) and any claim quote it
  supplierChallan: z.string().nullable(),
  // The truck and its driver: "Dhaka Metro-Ta 11-2233, Rahim"
  vehicle: z.string().nullable(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type GoodsReceiptSummary = z.infer<typeof goodsReceiptSummarySchema>;

// quantity and baseQuantity (from stockLineSchema) are what was accepted: what came into stock
export const goodsReceiptLineSchema = stockLineSchema.extend({
  // The order line it receives. Two lines may point at the same order line: two lots of the same
  // fabric on one truck.
  orderLineId: z.uuid(),
  // What was turned back, in the line's unit and in the base unit; '0.0000' for none
  rejectedQuantity: z.string(),
  rejectedBaseQuantity: z.string(),
  // Why it was turned back; null when nothing was
  rejectionReason: z.string().nullable(),
  // What the accepted goods were booked at (the order's net price), once posted. null for a
  // draft, and without inventory.stock.value.
  value: z.string().nullable(),
});
export type GoodsReceiptLine = z.infer<typeof goodsReceiptLineSchema>;

export const goodsReceiptSchema = goodsReceiptSummarySchema.extend({
  lines: z.array(goodsReceiptLineSchema),
  // The stock entry; null for a draft, or when the accepted goods cost nothing (a free sample, or
  // a receipt that turned everything back)
  entry: entryRefSchema.nullable(),
});
export type GoodsReceipt = z.infer<typeof goodsReceiptSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// '' (an empty box) is nothing turned back
const rejectedQuantitySchema = z
  .string()
  .trim()
  .transform((value) => (value === '' ? '0' : value))
  .pipe(receivedQuantitySchema);

// A line brings stock in, so it says which lot the goods are, like an adjustment "in" (step 13).
// quantity is what was accepted, and it may be 0 when everything was turned back.
const goodsReceiptLineFieldsSchema = stockInLineFieldsSchema.extend({
  quantity: receivedQuantitySchema,
  orderLineId: z.uuid(errorCode('grn_order_line_invalid')),
  rejectedQuantity: rejectedQuantitySchema,
  rejectionReason: optionalText(200),
});

type GoodsReceiptLineRuleInput = z.output<typeof goodsReceiptLineFieldsSchema>;

function goodsReceiptLineRules(
  line: GoodsReceiptLineRuleInput,
  ctx: z.RefinementCtx<GoodsReceiptLineRuleInput>,
) {
  stockLineRules(line, ctx);
  // The boxes are checked by their own schemas; with a bad one there is nothing to compare yet
  if (!isQuantityOrZero(line.quantity) || !isQuantityOrZero(line.rejectedQuantity)) return;
  const nothingAccepted = isZeroQuantity(line.quantity);
  const nothingRejected = isZeroQuantity(line.rejectedQuantity);
  // A line where nothing came is a line nobody needed. A line may accept nothing when everything
  // that came was turned back: it stays, because the rejection is on the record.
  if (nothingAccepted && nothingRejected) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: errorCode('grn_line_empty') });
  }
  // A rejection says why: the supplier will ask, and a claim needs it
  if (!nothingRejected && line.rejectionReason === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['rejectionReason'],
      message: errorCode('grn_rejection_reason'),
    });
  }
}

export const goodsReceiptLineInputSchema =
  goodsReceiptLineFieldsSchema.superRefine(goodsReceiptLineRules);
export type GoodsReceiptLineInput = z.infer<typeof goodsReceiptLineInputSchema>;
export type GoodsReceiptLineFormValues = z.input<typeof goodsReceiptLineInputSchema>;

const goodsReceiptFieldsSchema = z.object({
  orderId: z.uuid(errorCode('grn_order_invalid')),
  date: z.iso.date(errorCode('stock_date_required')),
  // The order's warehouse at first; the truck may unload at another one
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  supplierChallan: optionalText(40),
  vehicle: optionalText(80),
  note: optionalText(300),
  lines: z
    .array(goodsReceiptLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

export const goodsReceiptInputSchema = goodsReceiptFieldsSchema.superRefine(documentSerialRules);
export type GoodsReceiptInput = z.infer<typeof goodsReceiptInputSchema>;

// A receipt keeps its order: the edit form does not send it
export const updateGoodsReceiptInputSchema = goodsReceiptFieldsSchema
  .omit({ orderId: true })
  .extend({ version: versionSchema })
  .superRefine(documentSerialRules);
export type UpdateGoodsReceiptInput = z.infer<typeof updateGoodsReceiptInputSchema>;
export type GoodsReceiptFormValues = z.input<typeof goodsReceiptInputSchema>;

export const goodsReceiptVersionInputSchema = z.object({ version: versionSchema });

export const deleteGoodsReceiptQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const goodsReceiptListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  orderId: z.uuid().optional(),
});
export type GoodsReceiptListQuery = z.input<typeof goodsReceiptListQuerySchema>;

export const goodsReceiptPageSchema = pageOf(goodsReceiptSummarySchema);
export type GoodsReceiptPage = z.infer<typeof goodsReceiptPageSchema>;

const goodsReceiptParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every stock document. Writing and posting need
// purchase.receipt.manage: the store keeper at the gate.
export const goodsReceiptRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/goods-receipts',
    summary: 'Goods receipts, newest date first',
    auth: 'bearer',
    status: 200,
    query: goodsReceiptListQuerySchema,
    response: goodsReceiptPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/goods-receipts/:id',
    summary: 'One goods receipt with its lines',
    auth: 'bearer',
    status: 200,
    params: goodsReceiptParamsSchema,
    response: goodsReceiptSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/goods-receipts',
    summary: 'Write a goods receipt against an approved order, as a draft or posted',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 201,
    body: goodsReceiptInputSchema,
    response: goodsReceiptSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/goods-receipts/:id',
    summary: 'Change a draft goods receipt, and optionally post it',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 200,
    params: goodsReceiptParamsSchema,
    body: updateGoodsReceiptInputSchema,
    response: goodsReceiptSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/goods-receipts/:id',
    summary: 'Delete a draft goods receipt',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 204,
    params: goodsReceiptParamsSchema,
    query: deleteGoodsReceiptQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/goods-receipts/:id/post',
    summary: 'Post a draft goods receipt: it gets its number and brings the stock in',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 200,
    params: goodsReceiptParamsSchema,
    body: goodsReceiptVersionInputSchema,
    response: goodsReceiptSchema,
  }),
};
```

- **It mirrors `deliveries.ts`:** draft and posted, numbered at posting, lines that point at the order's lines,
  "Post" in the same request as the save (`post: true`), no prices on the lines.
- **A line extends `stockInLineFieldsSchema`,** the adjustment "in" line of step 13, because a receipt brings stock
  in: the lot number and its dates, or the serial numbers. Only `quantity` is replaced, by
  `receivedQuantitySchema`, which takes 0 (decision 20).
- **`rejectedQuantitySchema` reads an empty box as 0.** Most lines turn nothing back, and the box should not have to
  be filled with a zero every time.
- **The line rules return early on a bad number.** `isZeroQuantity` throws on "2.12345"; that box already has its
  own `quantity_format` error, and a second error on the same line would only confuse.
- **`grn_line_empty` sits on the accepted box,** the box a person fills first.
- **`receivedOf`** is accepted plus rejected: the number a person counting at the gate has in mind. The form shows it
  under the two boxes.
- **`updateGoodsReceiptInputSchema` drops `orderId`** with `.omit()`. An edited receipt keeps its order (decision
  20); a form that sent another order would otherwise point the old lines at the wrong order's lines.
- **`entry` is null when nothing of value came in:** a free sample at ৳0, or a receipt that turned everything back.
  An entry of zero would be a line in the journal that says nothing.

```ts
import { describe, expect, it } from 'vitest';

import {
  goodsReceiptInputSchema,
  type GoodsReceiptLineFormValues,
  receivedOf,
  updateGoodsReceiptInputSchema,
} from './goods-receipts.js';

const ORDER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const ORDER_LINE = '01920000-0000-7000-8000-000000000005';

function line(extra: Partial<GoodsReceiptLineFormValues> = {}): GoodsReceiptLineFormValues {
  return {
    orderLineId: ORDER_LINE,
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '48',
    rejectedQuantity: '',
    rejectionReason: '',
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function receipt(lines: GoodsReceiptLineFormValues[] = [line()]) {
  return {
    orderId: ORDER,
    date: '2026-10-20',
    warehouseId: WAREHOUSE,
    supplierChallan: 'MSM-DC-7781',
    vehicle: '',
    note: '',
    lines,
    post: false,
  };
}

function issuesOf(lines: GoodsReceiptLineFormValues[]) {
  return goodsReceiptInputSchema.safeParse(receipt(lines)).error?.issues;
}

describe('goods receipt input', () => {
  it('reads an empty rejected box as nothing turned back', () => {
    expect(goodsReceiptInputSchema.parse(receipt())).toMatchObject({
      supplierChallan: 'MSM-DC-7781',
      vehicle: null,
      lines: [expect.objectContaining({ rejectedQuantity: '0', rejectionReason: null })],
    });
  });

  it('takes what was accepted and what was turned back, with the reason', () => {
    const parsed = goodsReceiptInputSchema.parse(
      receipt([line({ rejectedQuantity: '2', rejectionReason: 'Torn at the edge' })]),
    );
    const [first] = parsed.lines;
    if (first === undefined) throw new Error('no line');
    expect(receivedOf(first)).toBe('50.0000');
  });

  it('keeps a line that turned everything back', () => {
    expect(
      issuesOf([line({ quantity: '0', rejectedQuantity: '2', rejectionReason: 'Wrong shade' })]),
    ).toBeUndefined();
  });

  it('refuses a line where nothing came, on the accepted box', () => {
    expect(issuesOf([line({ quantity: '0' })])).toEqual([
      expect.objectContaining({ path: ['lines', 0, 'quantity'], message: 'grn_line_empty' }),
    ]);
  });

  it('needs a reason for what was turned back', () => {
    expect(issuesOf([line({ rejectedQuantity: '2' })])).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'rejectionReason'],
        message: 'grn_rejection_reason',
      }),
    ]);
  });

  it('leaves a bad number to its own box, with no second error', () => {
    expect(issuesOf([line({ rejectedQuantity: '2.12345' })])).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'rejectedQuantity'],
        message: 'quantity_format',
      }),
    ]);
  });

  it('takes a serial number once on the whole receipt', () => {
    expect(
      issuesOf([
        line({ quantity: '1', serialNumbers: ['IMEI-1'] }),
        line({ quantity: '1', serialNumbers: ['IMEI-1'] }),
      ]),
    ).toEqual([
      expect.objectContaining({
        path: ['lines', 1, 'serialNumbers', 0],
        message: 'stock_serial_twice',
      }),
    ]);
  });

  it('keeps its order: the edit form sends no order', () => {
    const parsed = updateGoodsReceiptInputSchema.parse({ ...receipt(), version: 2 });
    expect('orderId' in parsed).toBe(false);
  });
});
```

### `requisitions.ts`: how much was ordered

```diff
@@ -8,6 +8,7 @@ import { isMoneyAmount, multiplyMoney, sumMoney } from './money.js';
 import { pageOf, pageQuerySchema } from './pagination.js';
 import { MAX_PURCHASE_LINES } from './purchase.js';
 import { isQuantity, quantitySchema } from './quantities.js';
+import { documentRefSchema } from './sales.js';
 import { optionalDateSchema, stockUnitSchema, variantRefSchema } from './stock.js';
 
 // A purchase requisition (step 17a): a request from inside the company to buy, before any supplier
@@ -17,11 +18,25 @@ import { optionalDateSchema, stockUnitSchema, variantRefSchema } from './stock.j
 //
 // It is numbered as soon as it is saved (PR-2026-27-0001), like a quotation: people refer to it
 // while it waits. draft: being written, or sent back by a rejection · pending: submitted, waiting
-// for approval · approved: may be ordered (17b turns it into purchase orders) · cancelled: will not
-// be bought. 17b adds the ordered states.
-export const REQUISITION_STATUSES = ['draft', 'pending', 'approved', 'cancelled'] as const;
+// for approval · approved: may be ordered · closed: approved and partly ordered, and the rest will
+// not be (step 17b) · cancelled: will not be bought.
+export const REQUISITION_STATUSES = [
+  'draft',
+  'pending',
+  'approved',
+  'closed',
+  'cancelled',
+] as const;
 export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];
 
+// How much of an approved requisition purchase orders took (step 17b, you chose this): a buyer
+// orders its lines from different suppliers, and one order may buy for several requisitions, line
+// by line. A line counts as ordered by the purchase orders that point at it: in full while the
+// order is open, only what came in once the order is closed (the rest is still wanted), nothing
+// once it is cancelled. ordered = every line ordered in full or more.
+export const REQUISITION_ORDER_STATES = ['not_ordered', 'partly_ordered', 'ordered'] as const;
+export type RequisitionOrderState = (typeof REQUISITION_ORDER_STATES)[number];
+
 // ---------------------------------------------------------------------------------------------
 // The arithmetic
 
@@ -60,6 +75,8 @@ export const requisitionSummarySchema = z.object({
   // Where the goods are for. Its branch is the requisition's branch.
   warehouseId: z.uuid(),
   status: z.enum(REQUISITION_STATUSES),
+  // not_ordered for every status but approved and closed
+  orderState: z.enum(REQUISITION_ORDER_STATES),
   // The sum of the lines' estimated amounts
   amount: z.string(),
   lineCount: z.number().int(),
@@ -84,6 +101,8 @@ export const requisitionLineSchema = variantRefSchema.extend({
   estimatedCost: z.string(),
   // requisitionLineAmount() when it was saved
   amount: z.string(),
+  // In the base unit, by purchase orders (see REQUISITION_ORDER_STATES); may pass baseQuantity
+  orderedQuantity: z.string(),
 });
 export type RequisitionLine = z.infer<typeof requisitionLineSchema>;
 
@@ -92,9 +111,25 @@ export const requisitionSchema = requisitionSummarySchema.extend({
   lines: z.array(requisitionLineSchema),
   // Every time it was submitted, newest first; no rounds while it was never submitted
   approval: documentApprovalSchema,
+  // The purchase orders that buy for it, cancelled ones left out (step 17b)
+  orders: z.array(documentRefSchema),
 });
 export type Requisition = z.infer<typeof requisitionSchema>;
 
+// A requisition line still to order, as the purchase order form offers it (step 17b): what a buyer
+// picks from, across the approved requisitions of one warehouse
+export const openRequisitionLineSchema = requisitionLineSchema.extend({
+  requisition: z.object({
+    id: z.uuid(),
+    number: z.string(),
+    date: z.iso.date(),
+    neededBy: z.iso.date().nullable(),
+  }),
+  // baseQuantity − orderedQuantity, in the base unit: always more than zero here
+  remainingQuantity: z.string(),
+});
+export type OpenRequisitionLine = z.infer<typeof openRequisitionLineSchema>;
+
 // ---------------------------------------------------------------------------------------------
 // What the form sends
 
@@ -157,15 +192,33 @@ export const deleteRequisitionQuerySchema = z.object({
   version: z.coerce.number<number>().int().min(1),
 });
 
+// to_order: approved, with a line not ordered in full yet (step 17b)
+export const REQUISITION_ORDER_FILTERS = ['to_order'] as const;
+export type RequisitionOrderFilter = (typeof REQUISITION_ORDER_FILTERS)[number];
+
 export const requisitionListQuerySchema = pageQuerySchema.extend({
   status: z.enum(REQUISITION_STATUSES).optional(),
   warehouseId: z.uuid().optional(),
+  order: z.enum(REQUISITION_ORDER_FILTERS).optional(),
 });
 export type RequisitionListQuery = z.input<typeof requisitionListQuerySchema>;
 
 export const requisitionPageSchema = pageOf(requisitionSummarySchema);
 export type RequisitionPage = z.infer<typeof requisitionPageSchema>;
 
+// The lines a purchase order for this warehouse may buy for, oldest requisition first (the most
+// overdue request at the top). search matches the requisition's number, the product's name, code
+// and SKU. requisitionId narrows it to one: "Make purchase order" on a requisition's page.
+export const openRequisitionLineQuerySchema = pageQuerySchema.extend({
+  warehouseId: z.uuid(),
+  requisitionId: z.uuid().optional(),
+  search: z.string().trim().max(100).optional(),
+});
+export type OpenRequisitionLineQuery = z.input<typeof openRequisitionLineQuerySchema>;
+
+export const openRequisitionLinePageSchema = pageOf(openRequisitionLineSchema);
+export type OpenRequisitionLinePage = z.infer<typeof openRequisitionLinePageSchema>;
+
 const requisitionParamsSchema = z.object({ id: z.uuid() });
 
 // Reading needs no permission, like every other document. Writing, submitting, reopening and
@@ -234,7 +287,8 @@ export const requisitionRoutes = {
     body: requisitionVersionInputSchema,
     response: requisitionSchema,
   }),
-  // Pending: taken back to change it. Approved: changed after all, and approved again from step 1.
+  // Pending: taken back to change it. Approved: changed after all, and approved again from step 1;
+  // refused once a purchase order buys for it (step 17b).
   reopen: defineRoute({
     method: 'POST',
     path: '/requisitions/:id/reopen',
@@ -246,6 +300,7 @@ export const requisitionRoutes = {
     body: requisitionVersionInputSchema,
     response: requisitionSchema,
   }),
+  // Refused once a purchase order buys for it: close it instead
   cancel: defineRoute({
     method: 'POST',
     path: '/requisitions/:id/cancel',
@@ -257,4 +312,29 @@ export const requisitionRoutes = {
     body: requisitionVersionInputSchema,
     response: requisitionSchema,
   }),
+  // Step 17b: the rest of a partly ordered requisition will not be bought
+  close: defineRoute({
+    method: 'POST',
+    path: '/requisitions/:id/close',
+    summary: 'Stop ordering a partly ordered requisition',
+    auth: 'bearer',
+    permission: 'purchase.requisition.manage',
+    status: 200,
+    params: requisitionParamsSchema,
+    body: requisitionVersionInputSchema,
+    response: requisitionSchema,
+  }),
+};
+
+// Reading needs no permission, like the requisitions themselves
+export const requisitionLineRoutes = {
+  open: defineRoute({
+    method: 'GET',
+    path: '/requisition-lines',
+    summary: 'Lines of approved requisitions still to order, for one warehouse',
+    auth: 'bearer',
+    status: 200,
+    query: openRequisitionLineQuerySchema,
+    response: openRequisitionLinePageSchema,
+  }),
 };
```

- **`closed` joins the statuses** (decision 17), and **`orderState` is a field of its own,** not more statuses. A
  requisition is approved and partly ordered at the same time; two statuses for that would double every check that
  asks "is it approved?".
- **`REQUISITION_ORDER_STATES` says how ordering is counted** (decision 16) in its comment, because the API, the
  database and the page all have to count the same way.
- **`orderedQuantity` may pass `baseQuantity`:** an order may buy more than was asked for.
- **`openRequisitionLineSchema` extends the requisition line** with its requisition (number, dates) and what is left.
  The order form lists them across requisitions, so each row has to say which requisition it is from.
- **`warehouseId` is required in the open lines query.** An order delivers to one warehouse, and its lines may only
  come from requisitions for it (decision 16); a list across warehouses would offer lines the server then refuses.
- **The path is `/requisition-lines`, not `/requisitions/lines`:** the second would be read as a requisition with the
  id "lines" by the `/requisitions/:id` route, and refused as a bad id.

### `purchase.ts`: the last price

```diff
@@ -2,8 +2,8 @@ import { z } from 'zod';
 
 import { defineRoute } from './http.js';
 
-// What the purchase documents share (step 17): requisitions now, purchase orders, goods receipts
-// and bills in 17b and 17c.
+// What the purchase documents share (step 17): requisitions (17a), purchase orders and goods
+// receipts (17b), and bills (17c).
 
 // The most lines one purchase document holds: a pharmacy's monthly requisition runs to a few
 // hundred items, like a distributor's sales order (MAX_SALES_LINES)
@@ -12,13 +12,23 @@ export const MAX_PURCHASE_LINES = 300;
 // ---------------------------------------------------------------------------------------------
 // The cost a line starts with
 
-// Where a line's starting cost came from. average_cost: the company-wide average per base unit
-// (step 14) × the unit's factor, shown only to someone with inventory.stock.value. 17b adds the
-// last purchase price, which comes first (you chose this).
-export const PURCHASE_COST_SOURCES = ['average_cost'] as const;
+// Where a line's starting cost came from, in the order they are tried (step 17b):
+//   supplier_price  the price on this supplier's latest purchase order for the variant
+//   last_price      the price on anyone's latest purchase order for it
+//   average_cost    the company-wide average per base unit (step 14) × the unit's factor, shown
+//                   only to someone with inventory.stock.value
+// A purchase price is a price people typed and agreed, so everyone who writes purchases may see
+// it; the average is worked out from the books, so it keeps step 14's rule. "Latest" counts orders
+// that were approved (received and closed ones too): a draft is not a price anybody agreed to.
+// The price is what one unit cost after the line's discount and before VAT (the net), moved to the
+// line's unit, 4 decimals: what the goods were worth, whatever that order's VAT setting was.
+export const PURCHASE_COST_SOURCES = ['supplier_price', 'last_price', 'average_cost'] as const;
 export type PurchaseCostSource = (typeof PURCHASE_COST_SOURCES)[number];
 
 export const costLookupInputSchema = z.object({
+  // The order's supplier, so its own last price comes first. null = no supplier yet, or a
+  // requisition (it has none).
+  supplierId: z.uuid().nullable().default(null),
   items: z
     .array(z.object({ variantId: z.uuid(), unitId: z.uuid() }))
     .min(1)
@@ -32,8 +42,11 @@ export const costLookupItemSchema = z.object({
   // Per one of the unit, 4 decimals. null = nothing to start from (a new product, a person
   // without inventory.stock.value): the person types it.
   cost: z.string().nullable(),
-  // z.string(), not the enum: 17b adds a source, and an older client must still parse the answer
+  // z.string(), not the enum: a newer server's new source must not break an older client
   source: z.string().nullable(),
+  // The product's own active VAT rate, or the workspace's default (as the sales price lookup gives
+  // it): what a purchase order line starts with. A requisition has no VAT and ignores it.
+  taxRateId: z.uuid(),
 });
 export type CostLookupItem = z.infer<typeof costLookupItemSchema>;
 
```

- **Three sources, tried in order** (decision 19). The comment says who may see which, because the API has to leave
  the average out for some people and not the prices.
- **`supplierId` defaults to null,** so the requisition form (which has no supplier) keeps sending what it sent in
  17a.
- **`taxRateId` is always there:** every item has a rate (its own, or the workspace's default), like in the sales
  price lookup.

### `stock-accounts.ts`, `stock.ts`, `journal.ts`: goods received not billed

```diff
@@ -11,6 +11,9 @@ import { defineRoute } from './http.js';
 //   found … correction  The other side of an adjustment, one per reason (except opening stock)
 //   transfer_shortage   What a transfer lost on the way (received short)
 //   revaluation         The other side of a stock revaluation
+//   received_not_billed Goods received not billed (step 17b): a goods receipt brings stock in at the
+//                       order's price and owes it here, a liability, until the supplier's bill
+//                       (17c) moves it to the payable
 export const STOCK_ACCOUNT_USES = [
   'in_transit',
   'found',
@@ -22,6 +25,7 @@ export const STOCK_ACCOUNT_USES = [
   'correction',
   'transfer_shortage',
   'revaluation',
+  'received_not_billed',
 ] as const;
 export type StockAccountUse = (typeof STOCK_ACCOUNT_USES)[number];
 
@@ -29,10 +33,13 @@ export function isStockAccountUse(value: string): value is StockAccountUse {
   return STOCK_ACCOUNT_USES.some((use) => use === value);
 }
 
-// Goods in transit are still the company's goods: an asset. Every other use is a gain or a loss,
-// so it belongs in the profit and loss — an income or an expense account.
+// Goods in transit are still the company's goods: an asset. Goods received and not billed are
+// money the company owes: a liability. Every other use is a gain or a loss, so it belongs in the
+// profit and loss — an income or an expense account.
 export function accountTypeFits(use: StockAccountUse, type: string): boolean {
-  return use === 'in_transit' ? type === 'asset' : type === 'income' || type === 'expense';
+  if (use === 'in_transit') return type === 'asset';
+  if (use === 'received_not_billed') return type === 'liability';
+  return type === 'income' || type === 'expense';
 }
 
 // One value per use. The keys are written out (not built from the list) so the type is exact
@@ -49,6 +56,7 @@ function perUse<T>(make: () => T): Record<StockAccountUse, T> {
     correction: make(),
     transfer_shortage: make(),
     revaluation: make(),
+    received_not_billed: make(),
   };
 }
 
```

- **`received_not_billed` is a liability** (decision 12). `accountTypeFits` became three plain `if`s: a second
  special case in the old one-line conditional would have been hard to read. `perUse` lists the new key, so
  `Record<StockAccountUse, T>` makes a missing one a type error.

```diff
@@ -12,6 +12,7 @@ import { levelSchema, quantitySchema } from './quantities.js';
 // revaluation (step 14): a change of value without a change of quantity — its quantity is zero.
 // delivery (step 15b): goods leaving for a customer on a delivery challan.
 // sales_return (step 15d): goods a customer sent back.
+// purchase_receipt (step 17b): goods a supplier delivered against a purchase order.
 export const MOVEMENT_KINDS = [
   'adjustment',
   'transfer_out',
@@ -19,6 +20,7 @@ export const MOVEMENT_KINDS = [
   'revaluation',
   'delivery',
   'sales_return',
+  'purchase_receipt',
 ] as const;
 export type MovementKind = (typeof MOVEMENT_KINDS)[number];
 
@@ -155,6 +157,10 @@ export const stockItemSchema = variantRefSchema.extend({
   // from the chosen warehouse (or from any). Nothing is held for them; it is shown next to onHand,
   // so a salesperson sees what is already promised.
   onOrder: z.string(),
+  // Ordered from suppliers and not received yet (step 17b): what approved purchase orders still
+  // have to bring to the chosen warehouse (or to any), never below zero. Shown next to onHand, so a
+  // buyer does not order the same yarn twice.
+  incoming: z.string(),
   // At or below its reorder level in the chosen warehouse (or in any warehouse)
   low: z.boolean(),
   // Step 14, only for someone with inventory.stock.value (null for everyone else, and for a
@@ -284,6 +290,8 @@ export const reorderItemSchema = variantRefSchema.extend({
   warehouseId: z.uuid(),
   onHand: z.string(),
   inTransit: z.string(),
+  // What approved purchase orders still have to bring to this warehouse (step 17b)
+  incoming: z.string(),
   minQuantity: z.string(),
   reorderQuantity: z.string().nullable(),
 });
```

- **`purchase_receipt`** is the stock movement of a goods receipt. **`incoming`** is decision 23.

```diff
@@ -27,6 +27,8 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // Inventory / Cr Cost of goods sold). A stock document like a delivery.
 // sales_credit_note, sales_refund (step 15d): a credit note takes a sale back (sales returns, VAT,
 // receivable) and a refund pays a customer's advance back out of a cash or bank account.
+// purchase_receipt (step 17b): a goods receipt brings stock in at the purchase order's price (Dr
+// Inventory / Cr Goods received not billed). A stock document like a delivery.
 export const JOURNAL_SOURCES = [
   'manual',
   'opening_balance',
@@ -41,6 +43,7 @@ export const JOURNAL_SOURCES = [
   'sales_return',
   'sales_credit_note',
   'sales_refund',
+  'purchase_receipt',
 ] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
@@ -55,6 +58,7 @@ export const STOCK_JOURNAL_SOURCES = [
   'stock_revaluation',
   'sales_delivery',
   'sales_return',
+  'purchase_receipt',
 ] as const satisfies readonly JournalSource[];
 export type StockJournalSource = (typeof STOCK_JOURNAL_SOURCES)[number];
 
```

- **`purchase_receipt` is a stock journal source:** like a delivery's, its entry is made and undone by stock
  documents only (a purchase return, 17d), and the journal's Reverse refuses it.

### `quantities.ts` and `settings.ts`: the over-receipt percent

```diff
@@ -40,11 +40,16 @@ export const quantitySchema = z
   .trim()
   .refine((value) => isQuantity(value), errorCode('quantity_format'));
 
+// A quantity that may be zero: what arrived of a transfer line, what a goods receipt accepted
+export function isQuantityOrZero(value: string): boolean {
+  return QUANTITY.test(value);
+}
+
 // What arrived of a transfer line: zero is a real answer (the carton never came)
 export const receivedQuantitySchema = z
   .string()
   .trim()
-  .refine((value) => QUANTITY.test(value), errorCode('quantity_format'));
+  .refine((value) => isQuantityOrZero(value), errorCode('quantity_format'));
 
 // A level (a reorder point): zero is allowed ("tell me when it runs out"), '' = no level
 export const levelSchema = z
@@ -80,6 +85,15 @@ export function isZeroQuantity(value: string): boolean {
   return toUnits(value) === 0n;
 }
 
+// The most that may come in against an ordered quantity when the workspace allows a little more
+// (step 17b, "Receive up to 3% over the order"): quantity × (100 + percent) ÷ 100, rounded down to
+// 4 decimals, so the limit never lets in more than the percent says. An order of 1,000 m of fabric
+// at 3% takes up to 1,030 m. The percent has at most 2 decimals and is never negative.
+export function withTolerance(quantity: string, percent: string): string {
+  const hundred = 100n * SCALE;
+  return fromUnits((toUnits(quantity) * (hundred + toUnits(percent))) / hundred);
+}
+
 // "1.50" fits a unit with 1 decimal (the trailing zero means nothing); "1.25" does not. A box or
 // a piece allows 0 decimals: 1.5 boxes is a typing mistake, not half a box.
 export function fitsDecimals(value: string, decimals: number): boolean {
```

- **`withTolerance` works in ten-thousandths, as BigInt,** like the rest of the file, and BigInt division rounds
  toward zero, which is down for a positive quantity (decision 22).
- **`isQuantityOrZero`** is the test `receivedQuantitySchema` always used, now named, so the goods receipt's line
  rules can ask it too.

```diff
@@ -4,6 +4,7 @@ import { companyNameSchema } from './auth.js';
 import { errorCode } from './errors.js';
 import { optionalText, versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
+import { compareQuantity } from './quantities.js';
 
 // base currency — হিসাবের বই কোন মুদ্রায়। বাংলাদেশের কোম্পানির জন্য আইনত BDT; বাকিগুলো পরে বিদেশি
 // টেন্যান্টের জন্য খোলা। ধাপ ১০-এ প্রথম journal পোস্ট হলে এটা আর বদলানো যাবে না
@@ -72,10 +73,28 @@ export const settingsSchema = z.object({
   // VAT. On for a shop that sells at the printed MRP; off (the default) for a distributor that
   // quotes before VAT. Sales lines (step 15b) work the VAT out from here.
   pricesIncludeVat: z.boolean(),
+  // Step 17b: "3.00" lets a goods receipt bring in up to 3% more than the order line. "0.00" (the
+  // default) = never more than ordered.
+  overReceiptPercent: z.string(),
   version: z.number().int(),
 });
 export type Settings = z.infer<typeof settingsSchema>;
 
+// Step 17b: how much more than ordered a goods receipt may bring in, in percent of the order line.
+// Fabric and yarn seldom arrive to the exact metre: a mill sends 1,028 m against an order of 1,000.
+// '' or 0 (the default) = never more than ordered. At most 100, double the order: more than that
+// is a second order, not a tolerance.
+const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
+
+export const overReceiptPercentSchema = z
+  .string()
+  .trim()
+  .transform((value) => (value === '' ? '0' : value))
+  .refine(
+    (value) => PERCENT.test(value) && compareQuantity(value, '100') <= 0,
+    errorCode('over_receipt_percent_format'),
+  );
+
 // PUT: পুরো ফর্ম একসাথে। version = ফর্ম খোলার সময়ের version (optimistic locking)
 export const updateSettingsInputSchema = z.object({
   version: versionSchema,
@@ -90,6 +109,7 @@ export const updateSettingsInputSchema = z.object({
   timezone: z.string().refine(isTimeZone, errorCode('timezone_invalid')),
   allowNegativeStock: z.boolean(),
   pricesIncludeVat: z.boolean(),
+  overReceiptPercent: overReceiptPercentSchema,
 });
 export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;
 
```

- **The percent is a string,** like every number the workspace stores with decimals (`NUMERIC(5,2)` in 17b.2).
- **`compareQuantity` checks the 100% limit** without turning the text into a JavaScript number. It runs only after
  the format test, because it throws on "five".

### `approvals.ts`, `document-output.ts`, `permissions.ts`

```diff
@@ -14,9 +14,9 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // their own document, except an Owner: the Owner answers to nobody, so the Owner's own document is
 // approved when it is submitted.
 
-// The documents that can need an approval. Each guide adds its own: 17b the purchase order, 17c the
-// bill and the supplier payment.
-export const APPROVAL_DOCUMENTS = ['requisition'] as const;
+// The documents that can need an approval. Each guide adds its own: 17a the requisition, 17b the
+// purchase order, 17c the bill and the supplier payment.
+export const APPROVAL_DOCUMENTS = ['requisition', 'purchase_order'] as const;
 export type ApprovalDocument = (typeof APPROVAL_DOCUMENTS)[number];
 
 export function isApprovalDocument(value: string): value is ApprovalDocument {
```

- **`purchase_order` is the second kind of document.** Settings → Approvals shows its card, and the approve and
  reject routes take it.

```diff
@@ -10,11 +10,18 @@ import { CURRENCIES } from './settings.js';
 // Step 16: a document goes out to the customer as a PDF — downloaded, attached to an email, or
 // behind a share link that opens without a login (sent on WhatsApp). The worker draws the PDF
 // once and keeps it; a new one is drawn only when the document (or the company on its header)
-// has changed since.
-
-// The four documents a customer receives. An order, a challan, a return and a refund stay with
-// the browser's Print (step 15c).
-export const OUTPUT_DOCUMENTS = ['quotation', 'invoice', 'receipt', 'credit_note'] as const;
+// has changed since. Step 17b sends a purchase order to its supplier the same way.
+
+// The four documents a customer receives, and the one a supplier receives (step 17b, you chose
+// the whole Send menu for it). A sales order, a challan, a return and a refund stay with the
+// browser's Print (step 15c).
+export const OUTPUT_DOCUMENTS = [
+  'quotation',
+  'invoice',
+  'receipt',
+  'credit_note',
+  'purchase_order',
+] as const;
 export type OutputDocument = (typeof OUTPUT_DOCUMENTS)[number];
 
 export function isOutputDocument(value: string): value is OutputDocument {
@@ -30,6 +37,7 @@ export const SEND_PERMISSIONS = {
   invoice: 'sales.invoice.manage',
   receipt: 'sales.receipt.manage',
   credit_note: 'sales.credit_note.manage',
+  purchase_order: 'purchase.order.manage',
 } as const satisfies Record<OutputDocument, PermissionKey>;
 
 const languageSchema = z.enum(LANGUAGE_CODES);
@@ -55,8 +63,8 @@ export const documentFileSchema = z.object({
 });
 export type DocumentFile = z.infer<typeof documentFileSchema>;
 
-// The language of the PDF. The page sends the customer's document language unless the person
-// picked another one.
+// The language of the PDF. The page sends the party's document language (the customer's, or the
+// supplier's for a purchase order) unless the person picked another one.
 export const documentFileInputSchema = z.object({ language: languageSchema });
 export type DocumentFileInput = z.infer<typeof documentFileInputSchema>;
 
@@ -96,7 +104,7 @@ export const documentEmailInputSchema = z.object({
 export type DocumentEmailInput = z.infer<typeof documentEmailInputSchema>;
 export type DocumentEmailFormValues = z.input<typeof documentEmailInputSchema>;
 
-// What the dialog starts with: the customer's email address, and a subject and message in the
+// What the dialog starts with: the customer's (or supplier's) email address, and a subject and message in the
 // chosen language. The server writes them (with the rest of the email and the PDF) so that every
 // word the customer reads comes from one place, in the customer's language, whatever language
 // the person's own screen is in.
@@ -199,8 +207,8 @@ export function whatsAppUrl(phone: string | null, text: string): string {
 // ---------------------------------------------------------------------------------------------
 // The public page behind a link
 
-// What the customer sees before downloading: enough to know what the file is and from whom. Only
-// an invoice has a due date and an amount still due.
+// What the customer (or the supplier) sees before downloading: enough to know what the file is
+// and from whom. Only an invoice has a due date and an amount still due.
 export const publicDocumentSchema = z.object({
   company: z.string(),
   logoUrl: z.url().nullable(),
@@ -209,7 +217,9 @@ export const publicDocumentSchema = z.object({
   kind: z.string(),
   number: z.string(),
   date: z.iso.date(),
-  customer: z.string(),
+  // Who it was sent to: the customer, or the supplier of a purchase order (named "customer" until
+  // step 17b)
+  recipient: z.string(),
   total: z.string(),
   currency: z.enum(CURRENCIES),
   dueDate: z.iso.date().nullable(),
@@ -232,7 +242,7 @@ export const documentOutputRoutes = {
   file: defineRoute({
     method: 'POST',
     path: '/documents/:kind/:id/files',
-    summary: 'Get the PDF of a quotation, invoice, receipt or credit note, made now if needed',
+    summary: 'Get the PDF of a document that goes out, made now if needed',
     auth: 'bearer',
     status: 200,
     params: documentParamsSchema,
```

- **`purchase_order` is the fifth output document** (decision 4), sent with `purchase.order.manage`.
- **`customer` became `recipient`** (decision 24). The route's summary names no kinds any more: the list would have
  to grow with every step, and the summaries are part of the app's bundle (17a's decision 46).

```diff
@@ -36,6 +36,8 @@ export const PERMISSION_KEYS = [
   'purchase.supplier.manage',
   'purchase.supplier.balance',
   'purchase.requisition.manage',
+  'purchase.order.manage',
+  'purchase.receipt.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -93,4 +95,6 @@ export const PERMISSION_GROUP_OF = {
   'purchase.supplier.manage': 'purchase',
   'purchase.supplier.balance': 'purchase',
   'purchase.requisition.manage': 'purchase',
+  'purchase.order.manage': 'purchase',
+  'purchase.receipt.manage': 'purchase',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

### `errors.ts`, `audit.ts`, `routes.ts`, `index.ts`

```diff
@@ -368,6 +368,30 @@ export const ERROR_CODES = [
   'purchase_cannot_cancel',
   'requisition_needed_by',
   'requisition_cost_required',
+  // Step 17b: purchase orders and goods receipts. The purchase_* codes of 17a (purchase_not_draft,
+  // purchase_was_submitted, purchase_cannot_reopen, purchase_cannot_cancel) serve the order too.
+  'purchase_supplier_required',
+  'purchase_supplier_invalid',
+  'purchase_expected_date',
+  'purchase_requisition_line_invalid',
+  'purchase_requisition_line_twice',
+  // Cancel refused because a later document uses it (an order buys for the requisition, a goods
+  // receipt brought some of the order in), and close refused because nothing does yet
+  'purchase_close_instead',
+  'purchase_cancel_instead',
+  // Cancel refused on a draft order nobody submitted: it has no number, so it is deleted
+  'purchase_delete_instead',
+  // Reopen or cancel refused while a draft goods receipt points at the order: delete it first
+  'purchase_receipt_draft',
+  // Close, receive or post against a document that is no longer approved: a requisition or an
+  // order someone reopened, closed or cancelled while the page was open
+  'purchase_not_approved',
+  'grn_order_invalid',
+  'grn_order_line_invalid',
+  'grn_over_order',
+  'grn_line_empty',
+  'grn_rejection_reason',
+  'over_receipt_percent_format',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **The goods receipt codes start with `grn_`.** `receipt_*` already means a money receipt (step 15c).
- **17a's `purchase_*` codes serve the order unchanged.** Their texts were written for any purchase document
  ("Reopen it first", "only before a later document uses it").
- **`purchase_delete_instead`** answers a cancel of a draft order nobody submitted: it has no number, so nothing
  was told to anyone, and it is deleted instead (decision 13). **`purchase_receipt_draft`** answers a reopen or a
  cancel while a draft goods receipt points at the order (decision 21): the person deletes the draft first. Once a
  receipt is posted, the answer is `purchase_close_instead`.
- **`purchase_not_approved`** answers a close, a goods receipt or a post against a requisition or an order that is
  no longer approved: someone reopened, closed or cancelled it while the page was open. The person reloads and sees
  why.

```diff
@@ -156,8 +156,19 @@ export const AUDIT_ACTIONS = [
   'requisition.updated',
   'requisition.deleted',
   'requisition.cancelled',
-  // The approval steps of any document that needs one. The entity is that document (a requisition
-  // now; an order, a bill and a payment from 17b and 17c), so its history reads in one place.
+  // step 17b
+  'requisition.closed',
+  'purchase_order.created',
+  'purchase_order.updated',
+  'purchase_order.deleted',
+  'purchase_order.closed',
+  'purchase_order.cancelled',
+  'goods_receipt.created',
+  'goods_receipt.updated',
+  'goods_receipt.deleted',
+  'goods_receipt.posted',
+  // The approval steps of any document that needs one. The entity is that document (a requisition,
+  // a purchase order; a bill and a payment from 17c), so its history reads in one place.
   'approval.submitted',
   'approval.approved',
   'approval.rejected',
@@ -206,6 +217,8 @@ export const AUDIT_ENTITY_TYPES = [
   'supplier',
   'supplier_group',
   'requisition',
+  'purchase_order',
+  'goods_receipt',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

```diff
@@ -20,15 +20,17 @@ import { customFieldRoutes } from './custom-fields.js';
 import { customerGroupRoutes, customerRoutes } from './customers.js';
 import { deliveryRoutes } from './deliveries.js';
 import { documentOutputRoutes, publicDocumentRoutes } from './document-output.js';
+import { goodsReceiptRoutes } from './goods-receipts.js';
 import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
 import { productRoutes } from './products.js';
 import { purchaseCostRoutes } from './purchase.js';
+import { purchaseOrderRoutes } from './purchase-orders.js';
 import { quotationRoutes } from './quotations.js';
 import { receiptRoutes } from './receipts.js';
 import { refundRoutes } from './refunds.js';
-import { requisitionRoutes } from './requisitions.js';
+import { requisitionLineRoutes, requisitionRoutes } from './requisitions.js';
 import { roleRoutes } from './roles.js';
 import { salesAccountRoutes } from './sales-accounts.js';
 import { salesOrderRoutes } from './sales-orders.js';
@@ -114,4 +116,7 @@ export const routes = {
   approvals: approvalRoutes,
   purchaseCosts: purchaseCostRoutes,
   requisitions: requisitionRoutes,
+  requisitionLines: requisitionLineRoutes,
+  purchaseOrders: purchaseOrderRoutes,
+  goodsReceipts: goodsReceiptRoutes,
 };
```

```diff
@@ -12,6 +12,7 @@ export * from './deliveries.js';
 export * from './document-output.js';
 export * from './errors.js';
 export * from './fields.js';
+export * from './goods-receipts.js';
 export * from './http.js';
 export * from './invitations.js';
 export * from './invoices.js';
@@ -28,6 +29,7 @@ export * from './product-categories.js';
 export * from './product-imports.js';
 export * from './products.js';
 export * from './purchase.js';
+export * from './purchase-orders.js';
 export * from './quantities.js';
 export * from './quotations.js';
 export * from './receipts.js';
```

### The tests that changed

```diff
@@ -5,6 +5,7 @@ import {
   compareQuantity,
   fitsDecimals,
   isQuantity,
+  isQuantityOrZero,
   levelSchema,
   negateQuantity,
   plainQuantity,
@@ -13,6 +14,7 @@ import {
   sumQuantity,
   toBaseQuantity,
   wholeCount,
+  withTolerance,
 } from './quantities.js';
 
 describe('quantities', () => {
@@ -64,3 +66,21 @@ describe('quantities', () => {
     expect(receivedQuantitySchema.safeParse('').success).toBe(false);
   });
 });
+
+describe('receiving over the order (step 17b)', () => {
+  it('adds the percent to the ordered quantity', () => {
+    expect(withTolerance('1000', '3')).toBe('1030.0000');
+    expect(withTolerance('7', '2.5')).toBe('7.1750');
+    expect(withTolerance('48', '0')).toBe('48.0000');
+  });
+
+  it('rounds the limit down, so it never lets in more than the percent says', () => {
+    // 0.0003 × 1.5 = 0.00045: 0.0004 is allowed, 0.0005 would be more than 50%
+    expect(withTolerance('0.0003', '50')).toBe('0.0004');
+  });
+
+  it('takes zero as a quantity where zero is a real answer', () => {
+    expect(['0', '0.0000', '12.5'].every(isQuantityOrZero)).toBe(true);
+    expect(['', '-1', '1.23456'].some(isQuantityOrZero)).toBe(false);
+  });
+});
```

```diff
@@ -17,6 +17,7 @@ const valid = {
   timezone: 'Asia/Dhaka',
   allowNegativeStock: false,
   pricesIncludeVat: false,
+  overReceiptPercent: '',
 } as const;
 
 describe('settings input', () => {
@@ -35,6 +36,26 @@ describe('settings input', () => {
     expect(result.error?.issues[0]).toMatchObject({ path: ['bin'], message: 'bin_format' });
   });
 
+  it('reads an empty over-receipt box as 0 and takes up to 100% with 2 decimals', () => {
+    expect(updateSettingsInputSchema.parse(valid).overReceiptPercent).toBe('0');
+    for (const percent of ['3', '2.5', '100', '100.00']) {
+      expect(
+        updateSettingsInputSchema.safeParse({ ...valid, overReceiptPercent: percent }).success,
+      ).toBe(true);
+    }
+    for (const percent of ['100.01', '-1', '2.555', 'five']) {
+      expect(
+        updateSettingsInputSchema.safeParse({ ...valid, overReceiptPercent: percent }).error
+          ?.issues,
+      ).toEqual([
+        expect.objectContaining({
+          path: ['overReceiptPercent'],
+          message: 'over_receipt_percent_format',
+        }),
+      ]);
+    }
+  });
+
   it('checks the time zone against Intl', () => {
     expect(isTimeZone('Asia/Dhaka')).toBe(true);
     expect(isTimeZone('Asia/Gazipur')).toBe(false);
```

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
```

Both pass (contracts 217 tests, 20 new). Do not run the whole `pnpm typecheck` yet: the translations do not know the
new error codes, permissions and audit actions until 17b.5, the API's route test fails until 17b.3, and the API, the
app and the mock still read the public page's `customer`.

---

## 17b.2 — `packages/db`: purchase orders and goods receipts

Four new tables: `purchase_orders` and `purchase_order_lines`, `goods_receipts` and `goods_receipt_lines`. The
requisition line gets a unique index for the order line's foreign key, the settings get the over-receipt percent, and
the journal lets a goods receipt's entry point at its receipt. Migration 0037 is generated from the schema; 0038 is
written by hand: row-level security, the foreign key Drizzle cannot write, the guards, and a job for the workspaces
that already exist.

### `schema/purchase-orders.ts` (new)

```ts
import { PURCHASE_ORDER_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { salesLineColumns, totalColumns } from './sales-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 17b: purchase orders. The rules on what may change when (an approved order's lines, the
// status that follows the approval) live in migration 0038, like the requisition's in 0036.
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    // deleted_at is not used: a draft that was never submitted is deleted for real, any other
    // order never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is first submitted ('purchase.order'). Kept when it goes back to draft, so the
    // number the supplier was told never changes.
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    expectedDate: date('expected_date', { mode: 'string' }),
    supplierId: uuid('supplier_id').notNull(),
    // The supplier's quotation or proforma invoice number
    supplierReference: text('supplier_reference'),
    // Where the goods are to be delivered; its branch is the order's branch
    warehouseId: uuid('warehouse_id').notNull(),
    // The order's own (decision 15): the supplier's terms when it was written, or what was agreed
    paymentTermsDays: smallint('payment_terms_days').notNull().default(0),
    pricesIncludeVat: boolean('prices_include_vat').notNull().default(false),
    status: text('status', { enum: PURCHASE_ORDER_STATUSES }).notNull().default('draft'),
    note: text('note'),
    // contracts' documentTotals when it was saved; total is what the approval levels are chosen by
    ...totalColumns(),
  },
  (table) => [
    uniqueIndex('purchase_orders_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the goods receipt's FK: an order of THIS supplier
    uniqueIndex('purchase_orders_supplier_id_idx').on(table.tenantId, table.supplierId, table.id),
    // Drafts that were never submitted have no number; NULLs never collide
    uniqueIndex('purchase_orders_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('purchase_orders_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One supplier's orders (the list's filter), and the supplier FK's check on delete
    index('purchase_orders_supplier_idx').on(
      table.tenantId,
      table.supplierId,
      table.date,
      table.id,
    ),
    index('purchase_orders_warehouse_idx').on(table.tenantId, table.warehouseId),
    // What approved orders still have to bring, per warehouse: the stock list's "incoming" and the
    // goods receipt form's orders. Partial: received, closed and cancelled orders are not in it.
    index('purchase_orders_open_idx')
      .on(table.tenantId, table.warehouseId)
      .where(sql`${table.status} = 'approved'`),
    // No ON DELETE: a supplier with an order cannot be deleted (supplier_in_use)
    foreignKey({
      name: 'purchase_orders_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'purchase_orders_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Out of draft ⇔ numbered (decision 13). A draft may still have a number: it was submitted
    // once, then rejected or reopened.
    check(
      'purchase_orders_number_check',
      sql`${table.status} = 'draft' OR ${table.number} IS NOT NULL`,
    ),
    check(
      'purchase_orders_expected_date_check',
      sql`${table.expectedDate} IS NULL OR ${table.expectedDate} >= ${table.date}`,
    ),
    // 365 = the contract's MAX_PAYMENT_TERMS_DAYS
    check('purchase_orders_terms_check', sql`${table.paymentTermsDays} BETWEEN 0 AND 365`),
    check(
      'purchase_orders_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
  ],
);

// A line is a sales line (decision 6), plus the requisition line it buys for and what goods
// receipts brought in against it
export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    ...salesLineColumns(),
    orderId: uuid('order_id').notNull(),
    // NULL = not from a requisition. The FK is in migration 0038: it also says the requisition
    // line is for the same variant, and it needs ON DELETE SET NULL on one column, which Drizzle
    // cannot write.
    requisitionLineId: uuid('requisition_line_id'),
    // In the base unit: what posted goods receipts accepted. Written by the receipt's posting,
    // under a lock on the order (17b.3). May pass base_quantity by the over-receipt percent.
    receivedQuantity: numeric('received_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    // In the base unit: what posted goods receipts turned back. Recorded only: it is not stock and
    // does not count as received.
    rejectedQuantity: numeric('rejected_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
  },
  (table) => [
    uniqueIndex('purchase_order_lines_line_idx').on(table.tenantId, table.orderId, table.lineNo),
    // The target of the goods receipt line's FK: a line of THIS order, for THIS variant
    uniqueIndex('purchase_order_lines_receipt_target_idx').on(
      table.tenantId,
      table.orderId,
      table.id,
      table.variantId,
    ),
    index('purchase_order_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // How much of a requisition line was ordered, and the requisition line FK's check on delete
    index('purchase_order_lines_requisition_line_idx')
      .on(table.tenantId, table.requisitionLineId)
      .where(sql`${table.requisitionLineId} IS NOT NULL`),
    foreignKey({
      name: 'purchase_order_lines_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'purchase_order_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'purchase_order_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Rates are archived, never deleted, so this never blocks anything; it keeps the id honest
    foreignKey({
      name: 'purchase_order_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'purchase_order_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // The sales line's rules again: a discount never takes more than the line, and total is net
    // plus VAT, to the paisa
    check(
      'purchase_order_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'purchase_order_lines_tax_rate_check',
      sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`,
    ),
    // Never more than double the order: 100% is the highest over-receipt percent (decision 22).
    // The workspace's own percent is the API's check; this is the last word whatever it says.
    check(
      'purchase_order_lines_received_check',
      sql`${table.receivedQuantity} BETWEEN 0 AND 2 * ${table.baseQuantity} AND ${table.rejectedQuantity} >= 0`,
    ),
  ],
);
```

- **It is the sales order's table with the approval's rules.** `number` is nullable and given at the first submit
  (decision 13), `status` is the contract's list, and the totals are `totalColumns()`, the same four columns every
  sales document keeps.
- **`payment_terms_days` and `prices_include_vat` are columns of the order** (decision 15), not read from the supplier
  or the settings when the PDF is drawn. A supplier's terms change; an order says what was agreed on the day.
  `prices_include_vat` defaults to false, which is how suppliers quote.
- **`purchase_orders_supplier_id_idx` on `(tenant_id, supplier_id, id)`** is not for a query. It is the target of the
  goods receipt's foreign key, which carries the supplier too, so a receipt can never name an order of another
  supplier. 15b's delivery does the same with the customer.
- **`purchase_orders_open_idx` is partial (`status = 'approved'`):** "what is still coming" (decision 23) and the
  goods receipt form's order list read only approved orders. After a year almost every order is received or closed,
  and the index stays the size of the open ones.
- **`purchase_orders_number_check`:** any status but draft needs a number. A draft may have one too: it was submitted
  once and then rejected or reopened, and it keeps the number the supplier may already have.
- **`purchase_orders_terms_check` (0–365)** repeats the contract's `MAX_PAYMENT_TERMS_DAYS`, like the parties table.
- **A line is `salesLineColumns()`** (decision 6): the price, the discount, the copy of the VAT rate, and `net`, `vat`
  and `total` stored as `lineAmounts()` gave them. Its checks are the sales lines' own.
- **`requisition_line_id` has no foreign key here.** It is in 0038, because it needs `ON DELETE SET NULL` on one
  column (decision 27), which Drizzle cannot write.
- **`received_quantity` and `rejected_quantity` are in the base unit,** like a sales order line's
  `delivered_quantity`: one order line may be received in another unit. They are written only by a goods receipt's
  posting.
- **`purchase_order_lines_receipt_target_idx` on `(tenant_id, order_id, id, variant_id)`** is the target of the receipt
  line's foreign key (decision 31). `id` alone is already unique; the other columns are there so the foreign key can
  say "a line of this order, for this item".
- **`purchase_order_lines_requisition_line_idx`** is partial (`IS NOT NULL`): most order lines are not from a
  requisition. It serves the count of what was ordered (decision 26) and the foreign key's check when a requisition
  line is deleted.
- **`purchase_order_lines_received_check`** (decision 32): at most double the order line, never below zero.

### `schema/goods-receipts.ts` (new)

```ts
import { STOCK_DOCUMENT_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
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
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { purchaseOrderLines, purchaseOrders } from './purchase-orders.js';
import { stockLineColumns } from './stock-documents.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 17b: goods receipts (GRN). Like a delivery: a draft is changed freely, a posted one never
// (migration 0038). Always made from an approved purchase order (decision 8).
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    // deleted_at is not used: a draft is deleted for real, a posted receipt never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('inventory.receipt'), so numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    // The order's supplier: in the FK below, so it cannot be another one
    supplierId: uuid('supplier_id').notNull(),
    // Never changes once the receipt is written (decision 20, migration 0038)
    orderId: uuid('order_id').notNull(),
    // Where it was unloaded; may be another warehouse than the order's (decision 20)
    warehouseId: uuid('warehouse_id').notNull(),
    // The number on the supplier's own delivery challan
    supplierChallan: text('supplier_challan'),
    vehicle: text('vehicle'),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('goods_receipts_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the line's FK: the line's order is its receipt's order
    uniqueIndex('goods_receipts_order_id_idx').on(table.tenantId, table.id, table.orderId),
    uniqueIndex('goods_receipts_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('goods_receipts_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('goods_receipts_supplier_idx').on(table.tenantId, table.supplierId, table.date, table.id),
    // An order's receipts (its page; "has it any receipt?" before a reopen or a cancel)
    index('goods_receipts_order_idx').on(table.tenantId, table.orderId),
    index('goods_receipts_warehouse_idx').on(table.tenantId, table.warehouseId),
    foreignKey({
      name: 'goods_receipts_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // supplier_id is in both keys: a receipt's order is always an order of the same supplier
    foreignKey({
      name: 'goods_receipts_order_fk',
      columns: [table.tenantId, table.supplierId, table.orderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.supplierId, purchaseOrders.id],
    }),
    foreignKey({
      name: 'goods_receipts_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Posted ⇔ it has a number and a posting time, like a delivery
    check(
      'goods_receipts_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

// A line: a stock line (decision 20: quantity and base_quantity are what was accepted), the lot
// as typed like an adjustment's "in" line, what was turned back and why, and the order line it
// receives
export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    ...stockLineColumns(),
    receiptId: uuid('receipt_id').notNull(),
    // A copy of the receipt's order, so the FKs below can say the order line is a line of it
    orderId: uuid('order_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    // A batch product: the lot as typed. Posting finds or makes the batch (batch_id).
    lotNumber: text('lot_number'),
    expiresOn: date('expires_on', { mode: 'string' }),
    manufacturedOn: date('manufactured_on', { mode: 'string' }),
    // What was turned back, as typed and in the base unit (same factor as the line), and why
    rejectedQuantity: numeric('rejected_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    rejectedBaseQuantity: numeric('rejected_base_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    rejectionReason: text('rejection_reason'),
    // What the accepted goods were booked at (the order line's net per base unit), set when posted
    value: numeric('value', { precision: 19, scale: 4 }),
  },
  (table) => [
    uniqueIndex('goods_receipt_lines_line_idx').on(table.tenantId, table.receiptId, table.lineNo),
    index('goods_receipt_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // An order line's receipts, and the order line FK's check
    index('goods_receipt_lines_order_line_idx').on(
      table.tenantId,
      table.orderId,
      table.orderLineId,
    ),
    // order_id is in the key: a line belongs to a receipt of that order. When a draft receipt is
    // deleted, its lines go with it.
    foreignKey({
      name: 'goods_receipt_lines_receipt_fk',
      columns: [table.tenantId, table.receiptId, table.orderId],
      foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id, goodsReceipts.orderId],
    }).onDelete('cascade'),
    // order_id and variant_id are in the key: the order line is a line of the receipt's order, for
    // the item the line brings in. No ON DELETE: an order with a receipt is never reopened
    // (decision 21), so its lines are not replaced.
    foreignKey({
      name: 'goods_receipt_lines_order_line_fk',
      columns: [table.tenantId, table.orderId, table.orderLineId, table.variantId],
      foreignColumns: [
        purchaseOrderLines.tenantId,
        purchaseOrderLines.orderId,
        purchaseOrderLines.id,
        purchaseOrderLines.variantId,
      ],
    }),
    foreignKey({
      name: 'goods_receipt_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'goods_receipt_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'goods_receipt_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    // Either part may be zero, never both (the contract's grn_line_empty), and each is zero in the
    // line's unit exactly when it is zero in the base unit
    check(
      'goods_receipt_lines_quantity_check',
      sql`${table.factor} > 0 AND ${table.quantity} >= 0 AND ${table.rejectedQuantity} >= 0 AND ${table.quantity} + ${table.rejectedQuantity} > 0 AND (${table.quantity} = 0) = (${table.baseQuantity} = 0) AND (${table.rejectedQuantity} = 0) = (${table.rejectedBaseQuantity} = 0)`,
    ),
    // A rejection says why (the contract's grn_rejection_reason); 200 = the contract's limit
    check(
      'goods_receipt_lines_rejection_check',
      sql`(${table.rejectedQuantity} = 0 OR ${table.rejectionReason} IS NOT NULL) AND (${table.rejectionReason} IS NULL OR char_length(${table.rejectionReason}) BETWEEN 1 AND 200)`,
    ),
    check('goods_receipt_lines_value_check', sql`${table.value} IS NULL OR ${table.value} >= 0`),
  ],
);
```

- **The header copies the delivery's:** draft and posted, numbered at posting, `posted_check` saying "posted ⇔ a number
  and a time". The supplier's challan number and the vehicle are the two things the gate writes down.
- **`goods_receipts_order_fk` carries `supplier_id`:** the receipt's supplier is always its order's. The list shows
  and filters by supplier without a join to the orders.
- **`warehouse_id` is the receipt's own** (decision 20): the truck may unload at another store than the order named.
- **`goods_receipts_order_id_idx` on `(tenant_id, id, order_id)`** is again only a target: the line's foreign key to
  its receipt carries the order.
- **A line is `stockLineColumns()`** plus the lot columns of an adjustment's "in" line, so the posting code of step 13
  (find or make the batch, write the serial numbers) reads it like any other line that brings stock in.
- **`order_id` on the line is a copy of the receipt's** (decision 31). With it, `goods_receipt_lines_receipt_fk`
  says the line belongs to a receipt of that order, and `goods_receipt_lines_order_line_fk` says the order line is a
  line of the same order, for the same variant. Without the copy, the second foreign key could only say "some order
  line", and a mistake in the API could receive yarn against a fabric line, at the fabric's price.
- **The order line foreign key has no `ON DELETE`.** An order with any receipt is never reopened (decision 21), so its
  lines are never replaced, and a receipt line never points at nothing.
- **`goods_receipt_lines_quantity_check`:** the accepted part and the rejected part may each be zero, never both (the
  contract's `grn_line_empty`, decision 20). Each part is zero in its unit exactly when it is zero in the base unit,
  so a line cannot say "1 carton" and "0 pieces".
- **`goods_receipt_lines_rejection_check`:** a rejection has a reason, of at most 200 characters like the contract. A
  reason without a rejection is allowed but never written: the API drops it.
- **There is no unique index on the line's id alone yet.** 17c's bill will point at receipt lines and adds it then.

### `schema/requisitions.ts`, `tenant-settings.ts`, `journal.ts`

```diff
@@ -20,7 +20,9 @@ import { users } from './users.js';
 import { warehouses } from './warehouses.js';
 
 // Step 17a: purchase requisitions. The rules on what may change when (and when one may be
-// deleted) live in migration 0036.
+// deleted) live in migration 0036. Step 17b: purchase orders buy for its lines
+// (purchase_order_lines.requisition_line_id); what was ordered is counted from them, never stored
+// here, and the new rules (closed, no reopen once ordered) are in migration 0038.
 export const requisitions = pgTable(
   'requisitions',
   {
@@ -92,6 +94,8 @@ export const requisitionLines = pgTable(
   },
   (table) => [
     uniqueIndex('requisition_lines_line_idx').on(table.tenantId, table.requisitionId, table.lineNo),
+    // The target of the purchase order line's FK (step 17b): a requisition line for THIS variant
+    uniqueIndex('requisition_lines_order_target_idx').on(table.tenantId, table.id, table.variantId),
     // A line blocks deleting its variant (product_variant_in_use), and finds where it is used
     index('requisition_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
     foreignKey({
```

- **`requisition_lines_order_target_idx` on `(tenant_id, id, variant_id)`** is the target of the order line's foreign
  key (0038), which holds the variant (decision 28). `closed` needs no change here: the status is a text column with
  the contract's list, and the moves are 0038's.

```diff
@@ -1,6 +1,15 @@
 import { CURRENCIES, DEFAULT_SETTINGS } from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
-import { boolean, check, foreignKey, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
+import {
+  boolean,
+  check,
+  foreignKey,
+  numeric,
+  pgTable,
+  smallint,
+  text,
+  uuid,
+} from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
 import { attachments } from './attachments.js';
 import { ledgerAccounts } from './ledger-accounts.js';
@@ -36,6 +45,11 @@ export const tenantSettings = pgTable(
     // Step 15d: the income account a credit note takes the sale back from ("Sales returns"). NULL =
     // the Sales account itself. Its own route (/sales-accounts) writes it, never PUT /settings.
     salesReturnsAccountId: uuid('sales_returns_account_id'),
+    // Step 17b: how much more than ordered a goods receipt may bring in, in percent of the order
+    // line (3.00 = 3%). 0 = never more than ordered.
+    overReceiptPercent: numeric('over_receipt_percent', { precision: 5, scale: 2 })
+      .notNull()
+      .default('0'),
     createdAt: baseColumns().createdAt,
     updatedAt: baseColumns().updatedAt,
     updatedBy: baseColumns().updatedBy,
@@ -46,6 +60,8 @@ export const tenantSettings = pgTable(
       'tenant_settings_fiscal_month_check',
       sql`${table.fiscalYearStartMonth} BETWEEN 1 AND 12`,
     ),
+    // The contract's limit: 100% = double the order line
+    check('tenant_settings_over_receipt_check', sql`${table.overReceiptPercent} BETWEEN 0 AND 100`),
     // composite FK: লোগো হিসেবে অন্য টেন্যান্টের ফাইল বসানো DB-লেভেলেই অসম্ভব। NULL হলে চেক হয় না
     foreignKey({
       name: 'tenant_settings_logo_fk',
```

- **`NUMERIC(5,2)`** holds 0.00 to 100.00 exactly, the contract's format. A `real` would store 3.1 as 3.0999999.

```diff
@@ -77,12 +77,12 @@ export const journalEntries = pgTable(
       sql`(${table.source} = 'reversal') = (${table.reversalOfId} IS NOT NULL)`,
     ),
     // A document's entry (a stock document's, a delivery's since step 15b, an invoice's and a
-    // receipt's since 15c, a sales return's, a credit note's and a refund's since 15d) always
-    // points at its document, and no other entry does. The list is contracts'
-    // DOCUMENT_JOURNAL_SOURCES.
+    // receipt's since 15c, a sales return's, a credit note's and a refund's since 15d, a goods
+    // receipt's since 17b) always points at its document, and no other entry does. The list is
+    // contracts' DOCUMENT_JOURNAL_SOURCES.
     check(
       'journal_entries_document_check',
-      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
     ),
     // A document's entries (a transfer has up to two; an invoice or a receipt has one, which the
     // invoice page and the receipt page find here)
```

- **`purchase_receipt` joins the document check:** a goods receipt's entry always names its receipt, and no other
  entry may. Drizzle drops and adds the check again in 0037; every existing entry passes, because no entry has the
  new source yet.

### `schema/index.ts` and `permission-catalog.ts`

```diff
@@ -42,3 +42,5 @@ export * from './refunds.js';
 export * from './document-output.js';
 export * from './approvals.js';
 export * from './requisitions.js';
+export * from './purchase-orders.js';
+export * from './goods-receipts.js';
```

```diff
@@ -43,7 +43,10 @@ const DESCRIPTIONS = {
   'sales.refund.manage': 'Pay money back to customers and void refunds',
   'purchase.supplier.manage': 'Add, edit, archive and delete suppliers and supplier groups',
   'purchase.supplier.balance': 'See what the company owes suppliers, and their statements',
-  'purchase.requisition.manage': 'Write, submit, reopen, cancel and delete purchase requisitions',
+  'purchase.requisition.manage':
+    'Write, submit, reopen, close, cancel and delete purchase requisitions',
+  'purchase.order.manage': 'Write, submit, reopen, close, cancel and send purchase orders',
+  'purchase.receipt.manage': 'Write and post goods receipts, which bring stock in',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- The catalog's `satisfies Record<PermissionKey, string>` failed the type check after 17b.1 added the two keys; these
  lines fix it. The requisition's text now says "close" too (decision 17).

### Migration 0037 (generated — then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name purchase-orders-receipts`. As in every step, `drizzle-kit` writes the
foreign keys before the unique indexes they point at (`purchase_orders_supplier_id_idx`, `goods_receipts_order_id_idx`,
`purchase_order_lines_receipt_target_idx`), and the migration fails with "there is no unique constraint matching given
keys". Move every `CREATE INDEX` and `CREATE UNIQUE INDEX` up, before the first `ADD CONSTRAINT … FOREIGN KEY`. The
result:

```sql
CREATE TABLE "purchase_order_lines" (
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
	"order_id" uuid NOT NULL,
	"requisition_line_id" uuid,
	"received_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rejected_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_order_lines_quantity_check" CHECK ("purchase_order_lines"."quantity" > 0 AND "purchase_order_lines"."factor" > 0 AND "purchase_order_lines"."base_quantity" > 0),
	CONSTRAINT "purchase_order_lines_amounts_check" CHECK ("purchase_order_lines"."unit_price" >= 0 AND "purchase_order_lines"."discount" >= 0 AND ("purchase_order_lines"."discount_type" = 'amount' OR "purchase_order_lines"."discount" <= 100) AND "purchase_order_lines"."net" >= 0 AND "purchase_order_lines"."vat" >= 0 AND "purchase_order_lines"."total" = "purchase_order_lines"."net" + "purchase_order_lines"."vat"),
	CONSTRAINT "purchase_order_lines_tax_rate_check" CHECK ("purchase_order_lines"."tax_rate" >= 0 AND "purchase_order_lines"."tax_rate" < 100),
	CONSTRAINT "purchase_order_lines_received_check" CHECK ("purchase_order_lines"."received_quantity" BETWEEN 0 AND 2 * "purchase_order_lines"."base_quantity" AND "purchase_order_lines"."rejected_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
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
	"expected_date" date,
	"supplier_id" uuid NOT NULL,
	"supplier_reference" text,
	"warehouse_id" uuid NOT NULL,
	"payment_terms_days" smallint DEFAULT 0 NOT NULL,
	"prices_include_vat" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_orders_number_check" CHECK ("purchase_orders"."status" = 'draft' OR "purchase_orders"."number" IS NOT NULL),
	CONSTRAINT "purchase_orders_expected_date_check" CHECK ("purchase_orders"."expected_date" IS NULL OR "purchase_orders"."expected_date" >= "purchase_orders"."date"),
	CONSTRAINT "purchase_orders_terms_check" CHECK ("purchase_orders"."payment_terms_days" BETWEEN 0 AND 365),
	CONSTRAINT "purchase_orders_totals_check" CHECK ("purchase_orders"."discount" >= 0 AND "purchase_orders"."net" >= 0 AND "purchase_orders"."vat" >= 0 AND "purchase_orders"."total" = "purchase_orders"."net" + "purchase_orders"."vat")
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"receipt_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"lot_number" text,
	"expires_on" date,
	"manufactured_on" date,
	"rejected_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rejected_base_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rejection_reason" text,
	"value" numeric(19, 4),
	CONSTRAINT "goods_receipt_lines_quantity_check" CHECK ("goods_receipt_lines"."factor" > 0 AND "goods_receipt_lines"."quantity" >= 0 AND "goods_receipt_lines"."rejected_quantity" >= 0 AND "goods_receipt_lines"."quantity" + "goods_receipt_lines"."rejected_quantity" > 0 AND ("goods_receipt_lines"."quantity" = 0) = ("goods_receipt_lines"."base_quantity" = 0) AND ("goods_receipt_lines"."rejected_quantity" = 0) = ("goods_receipt_lines"."rejected_base_quantity" = 0)),
	CONSTRAINT "goods_receipt_lines_rejection_check" CHECK (("goods_receipt_lines"."rejected_quantity" = 0 OR "goods_receipt_lines"."rejection_reason" IS NOT NULL) AND ("goods_receipt_lines"."rejection_reason" IS NULL OR char_length("goods_receipt_lines"."rejection_reason") BETWEEN 1 AND 200)),
	CONSTRAINT "goods_receipt_lines_value_check" CHECK ("goods_receipt_lines"."value" IS NULL OR "goods_receipt_lines"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
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
	"supplier_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"supplier_challan" text,
	"vehicle" text,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "goods_receipts_posted_check" CHECK (("goods_receipts"."status" = 'posted') = ("goods_receipts"."number" IS NOT NULL AND "goods_receipts"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "over_receipt_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_line_idx" ON "purchase_order_lines" USING btree ("tenant_id","order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_receipt_target_idx" ON "purchase_order_lines" USING btree ("tenant_id","order_id","id","variant_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_variant_idx" ON "purchase_order_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_requisition_line_idx" ON "purchase_order_lines" USING btree ("tenant_id","requisition_line_id") WHERE "purchase_order_lines"."requisition_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_id_idx" ON "purchase_orders" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders" USING btree ("tenant_id","supplier_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_number_idx" ON "purchase_orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_date_idx" ON "purchase_orders" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_warehouse_idx" ON "purchase_orders" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_open_idx" ON "purchase_orders" USING btree ("tenant_id","warehouse_id") WHERE "purchase_orders"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_line_idx" ON "goods_receipt_lines" USING btree ("tenant_id","receipt_id","line_no");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_variant_idx" ON "goods_receipt_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_order_line_idx" ON "goods_receipt_lines" USING btree ("tenant_id","order_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_tenant_id_idx" ON "goods_receipts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_order_id_idx" ON "goods_receipts" USING btree ("tenant_id","id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_tenant_number_idx" ON "goods_receipts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "goods_receipts_tenant_date_idx" ON "goods_receipts" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "goods_receipts_supplier_idx" ON "goods_receipts" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "goods_receipts_order_idx" ON "goods_receipts" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_warehouse_idx" ON "goods_receipts" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisition_lines_order_target_idx" ON "requisition_lines" USING btree ("tenant_id","id","variant_id");--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id","order_id") REFERENCES "public"."goods_receipts"("tenant_id","id","order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_id","order_line_id","variant_id") REFERENCES "public"."purchase_order_lines"("tenant_id","order_id","id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_order_fk" FOREIGN KEY ("tenant_id","supplier_id","order_id") REFERENCES "public"."purchase_orders"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_over_receipt_check" CHECK ("tenant_settings"."over_receipt_percent" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));
```

- **The new settings column is instant:** it has a constant default, so Postgres does not rewrite the table.
- **`requisition_lines_order_target_idx` is built on a table that may already have rows.** It is small (requisitions
  started in 17a) and the build takes a moment.
- `meta/_journal.json` and `meta/0037_snapshot.json` change too. They are generated; commit them as they are.

### Migration 0038 (custom): RLS, the requisition link, the guards

Run `pnpm --filter @omnivo/db generate --custom --name purchase-orders-receipts-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines'
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

-- 2) An order line buys for a requisition line of the same variant: variant_id is in the key, so
--    a line for cotton yarn cannot point at a request for polyester. When the requisition line is
--    deleted later (a reopened requisition writes its lines again, which section 5 allows only
--    once every order that bought for it was cancelled), only requisition_line_id becomes NULL:
--    the cancelled order keeps its line. A plain ON DELETE SET NULL would also clear tenant_id and
--    variant_id (NOT NULL, so the requisition's save would fail). As in 0036, the column list
--    needs Postgres 15 or later, and Drizzle cannot write it.
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT purchase_order_lines_requisition_line_fk
  FOREIGN KEY (tenant_id, requisition_line_id, variant_id)
  REFERENCES requisition_lines (tenant_id, id, variant_id)
  ON DELETE SET NULL (requisition_line_id);

-- 3) 0036's round guard, with the purchase order as the second kind of document: a round names an
--    order that exists. The rest is unchanged.
CREATE OR REPLACE FUNCTION approval_rounds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval round % is history and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_history_immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The foreign key a polymorphic column cannot have, one branch per kind of document
    IF (NEW.document = 'requisition' AND NOT EXISTS (
          SELECT 1 FROM requisitions WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id))
       OR (NEW.document = 'purchase_order' AND NOT EXISTS (
          SELECT 1 FROM purchase_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id)) THEN
      RAISE EXCEPTION 'approval round names % %, which does not exist', NEW.document, NEW.document_id
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

-- 4) "An order buys for this requisition" (decision 17): a line of an order that is not cancelled
--    points at one of its lines. A draft order counts too: its lines point there, and they would
--    lose their link if the requisition's lines were written again. Used by section 5.
CREATE FUNCTION requisition_is_ordered(p_tenant uuid, p_requisition uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM requisition_lines rl
      JOIN purchase_order_lines pl
        ON pl.tenant_id = rl.tenant_id AND pl.requisition_line_id = rl.id
      JOIN purchase_orders po
        ON po.tenant_id = pl.tenant_id AND po.id = pl.order_id
     WHERE rl.tenant_id = p_tenant AND rl.requisition_id = p_requisition
       AND po.status <> 'cancelled')
$$;

-- 5) 0036's requisition guard, with step 17b's rules (decision 17):
--    - a new move, approved → closed: the rest will not be ordered. Closed is final;
--    - once an order buys for it, it is no longer reopened or cancelled (its lines would change
--      under the order), and only then may it be closed (a requisition nothing was ordered for is
--      cancelled, not closed). The API says which one with purchase_close_instead and
--      purchase_cancel_instead; this is the last word.
--    The rest is unchanged.
CREATE OR REPLACE FUNCTION requisitions_guard() RETURNS trigger
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
       ('approved', 'draft'), ('approved', 'cancelled'), ('approved', 'closed')) THEN
    RAISE EXCEPTION 'requisition % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_status_check';
  END IF;

  IF OLD.status = 'approved'
     AND (NEW.status = 'closed') <> requisition_is_ordered(NEW.tenant_id, NEW.id) THEN
    RAISE EXCEPTION 'requisition % cannot be % %', OLD.id, NEW.status,
        CASE WHEN NEW.status = 'closed' THEN 'before an order buys for it'
             ELSE 'once an order buys for it' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_ordered_check';
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

-- 6) A purchase order (decisions 11, 13 and 21). The requisition's rules, plus the receipts:
--    - its number never changes once given, even when it goes back to draft;
--    - a draft is changed freely; anything else keeps what was ordered, and only its status moves
--      (reopen first, to change it);
--    - the moves are draft → pending or cancelled (cancelled needs a number: a draft never
--      submitted is deleted instead); pending → approved or draft; approved → draft (reopen),
--      received, closed or cancelled. Received, closed and cancelled are final;
--    - the status follows its newest approval round, exactly like the requisition's;
--    - while a goods receipt points at it, even a draft one, it is not reopened or cancelled
--      (decision 21: the receipt's lines point at its lines). Closed needs a posted receipt (an
--      order nothing came for is cancelled), and received needs every goods line in full;
--    - only a draft that was never submitted is deleted.
CREATE FUNCTION purchase_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_round text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL OR EXISTS (
         SELECT 1 FROM approval_rounds
          WHERE tenant_id = OLD.tenant_id AND document = 'purchase_order'
            AND document_id = OLD.id) THEN
      RAISE EXCEPTION 'purchase order % was submitted and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_submitted_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
     OR (OLD.status <> 'draft'
         AND to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']
             <> to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'purchase order % is % and cannot be changed; reopen it first', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_locked';
  END IF;
  -- A draft that moves to another warehouse keeps no line of a requisition for the old one
  -- (decision 16; section 7 checks each line as it is written)
  IF NEW.warehouse_id <> OLD.warehouse_id AND EXISTS (
       SELECT 1
         FROM purchase_order_lines pl
         JOIN requisition_lines rl ON rl.tenant_id = pl.tenant_id AND rl.id = pl.requisition_line_id
         JOIN requisitions r ON r.tenant_id = rl.tenant_id AND r.id = rl.requisition_id
        WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id
          AND r.warehouse_id <> NEW.warehouse_id) THEN
    RAISE EXCEPTION 'purchase order % buys for a requisition of another warehouse', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_requisition_check';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'pending'), ('draft', 'cancelled'),
       ('pending', 'approved'), ('pending', 'draft'),
       ('approved', 'draft'), ('approved', 'received'), ('approved', 'closed'),
       ('approved', 'cancelled')) THEN
    RAISE EXCEPTION 'purchase order % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_status_check';
  END IF;

  IF (OLD.status = 'approved' AND NEW.status IN ('draft', 'cancelled') AND EXISTS (
        SELECT 1 FROM goods_receipts WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id))
     OR (NEW.status = 'closed' AND NOT EXISTS (
        SELECT 1 FROM goods_receipts
         WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id AND status = 'posted'))
     OR (NEW.status = 'received' AND EXISTS (
        SELECT 1
          FROM purchase_order_lines pl
          JOIN products p ON p.tenant_id = pl.tenant_id AND p.id = pl.product_id
         WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id
           AND p.type = 'goods' AND pl.received_quantity < pl.base_quantity)) THEN
    RAISE EXCEPTION 'purchase order % cannot be % with the goods receipts it has', OLD.id, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_receipts_check';
  END IF;

  SELECT status INTO v_round
    FROM approval_rounds
   WHERE tenant_id = NEW.tenant_id AND document = 'purchase_order' AND document_id = NEW.id
   ORDER BY submitted_at DESC, id DESC
   LIMIT 1;
  IF (NEW.status = 'pending' AND v_round IS DISTINCT FROM 'pending')
     OR (NEW.status = 'approved' AND v_round IS DISTINCT FROM 'approved')
     OR (OLD.status = 'pending' AND NEW.status = 'draft'
         AND coalesce(v_round, 'missing') NOT IN ('rejected', 'reopened')) THEN
    RAISE EXCEPTION 'purchase order % cannot be % while its approval round is %',
        OLD.id, NEW.status, coalesce(v_round, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_approval_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER purchase_orders_guard
  BEFORE UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();

-- 7) The lines of an order:
--    - free while the order is a draft. A line that buys for a requisition line needs an approved
--      requisition (or a closed one: a draft's lines are written again on every save, and the
--      requisition may have been closed since) for the order's warehouse. The requisition row is
--      locked (FOR SHARE) for that, so a reopen or a cancel of the same requisition at the same
--      moment waits, and then sees this line (section 5);
--    - while the order is approved, only what goods receipts brought in changes, and only up;
--    - otherwise frozen. The one change at any time is section 2's: requisition_line_id becomes
--      NULL when its requisition line is deleted.
--    When a draft is deleted, its lines go by ON DELETE CASCADE; the header is gone by then, so
--    the lookup finds nothing and lets them go.
CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_warehouse uuid;
  v_req_status text;
  v_req_warehouse uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.requisition_line_id IS NULL AND OLD.requisition_line_id IS NOT NULL
     AND to_jsonb(NEW) - 'requisition_line_id' = to_jsonb(OLD) - 'requisition_line_id' THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT status, warehouse_id INTO v_status, v_warehouse
      FROM purchase_orders WHERE tenant_id = OLD.tenant_id AND id = OLD.order_id;
    IF TG_OP = 'UPDATE' AND v_status = 'approved'
       AND NEW.received_quantity >= OLD.received_quantity
       AND NEW.rejected_quantity >= OLD.rejected_quantity
       AND to_jsonb(NEW) - ARRAY['received_quantity', 'rejected_quantity']
           = to_jsonb(OLD) - ARRAY['received_quantity', 'rejected_quantity'] THEN
      RETURN NEW;
    END IF;
    -- NULL: a deleted draft's cascade
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'the lines of a % purchase order cannot be changed, except what was received', v_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_locked';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  -- The order the line is (or moves) in must be a draft too
  SELECT status, warehouse_id INTO v_status, v_warehouse
    FROM purchase_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  -- NULL: no such order — the foreign key gives that error
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'lines cannot be added to a % purchase order', v_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_locked';
  END IF;

  IF NEW.requisition_line_id IS NOT NULL THEN
    SELECT r.status, r.warehouse_id INTO v_req_status, v_req_warehouse
      FROM requisition_lines rl
      JOIN requisitions r ON r.tenant_id = rl.tenant_id AND r.id = rl.requisition_id
     WHERE rl.tenant_id = NEW.tenant_id AND rl.id = NEW.requisition_line_id
       FOR SHARE OF r;
    -- NULL: no such requisition line — the foreign key gives that error
    IF v_req_status IS NOT NULL
       AND (v_req_status NOT IN ('approved', 'closed') OR v_req_warehouse <> v_warehouse) THEN
      RAISE EXCEPTION 'an order line buys only for an approved requisition of the order''s warehouse'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_requisition_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER purchase_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();

-- 8) A goods receipt (decisions 8 and 20):
--    - it is written, and posted, only against an approved order. The order row is locked (FOR
--      SHARE) for that, so a reopen or a cancel of the same order at the same moment waits, and
--      then sees this receipt (section 6);
--    - it keeps its order and its supplier;
--    - a posted receipt never changes and is never deleted, like a posted delivery: what came in
--      came in, and a purchase return (17d) sends goods back.
CREATE FUNCTION goods_receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'goods receipt % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.order_id <> OLD.order_id OR NEW.supplier_id <> OLD.supplier_id) THEN
    RAISE EXCEPTION 'goods receipt % keeps its purchase order', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_order_immutable';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.status = 'posted' THEN
    SELECT status INTO v_status
      FROM purchase_orders
     WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
       FOR SHARE;
    -- NULL: no such order — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'approved' THEN
      RAISE EXCEPTION 'goods are received only against an approved purchase order, not a % one', v_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_order_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER goods_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard();

-- The lines: only while the receipt is a draft, checked before (OLD) and after (NEW), like 0028's
-- delivery lines. When a draft is deleted its lines cascade; the header is gone by then.
CREATE FUNCTION goods_receipt_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM goods_receipts
         WHERE tenant_id = OLD.tenant_id AND id = OLD.receipt_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM goods_receipts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted goods receipt cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER goods_receipt_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard();

-- 9) "Goods received not billed" for the workspaces that already exist (decision 12): step 14's
--    job again (StockAccountsHandler). It adds the template's accounts that are missing and
--    chooses them for the uses that have none, so the new use gets 2115 (17b.3 teaches it). A
--    workspace without a chart gets it with its chart. Per workspace, with app.tenant_id set, as
--    in 0024: FORCE RLS applies to this migration's role too.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    IF EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.tenant_id = t) THEN
      INSERT INTO outbox_events (id, tenant_id, type, payload)
      VALUES (gen_random_uuid(), t, 'workspace.stock_accounts_requested', '{}'::jsonb);
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

- **Section 1** is the same loop as every step: row-level security on, forced, and the `tenant_isolation` policy on
  the four tables.
- **Section 2, the requisition link** (decisions 27 and 28). The key has `variant_id`, so the order line and the
  requisition line are for the same item. `SET NULL (requisition_line_id)` clears only the link: a plain `SET NULL`
  would clear `tenant_id` and `variant_id` too, and both are NOT NULL, so the requisition's save would fail. The
  clearing happens only to a cancelled order's line, because section 5 stops a requisition from being reopened while
  any other order points at it.
- **Section 3** is 0036's round guard with a `purchase_order` branch. The whole function is written again because
  `CREATE OR REPLACE` needs the whole body; only the `INSERT` block changed.
- **Section 4, `requisition_is_ordered()`.** It is a function because the requisition guard asks it in one place and
  the reader should see the rule (decision 27) in one place. It is `STABLE`: it reads, and it runs inside the
  trigger's statement, which sees the rows committed when that statement started.
- **Section 5, the requisition's guard again.**
  - `('approved', 'closed')` is the new move. Nothing leaves `closed`.
  - The one new `IF` covers three rules at once: from approved, "closed" needs an order, and "draft" or "cancelled"
    need none. `(NEW.status = 'closed') <> requisition_is_ordered(…)` is true exactly when the move breaks the rule.
- **Section 6, the order's guard.** It is the requisition's guard (0036) with the order's own moves:
  - The number is checked with `OLD.number IS NOT NULL`: a draft may get its first number (at the submit), but never
    a second one, even in draft. A reopened order keeps the number the supplier knows.
  - The warehouse block catches a draft moved to another warehouse while its lines still buy for a requisition of the
    first one. The lines check themselves as they are written (section 7); this catches the header changing under
    them.
  - Cancelled from draft needs a number, and that is the table's `purchase_orders_number_check`: a draft nobody
    submitted is deleted instead.
  - The receipts block (decisions 21 and 29) reads `goods_receipts` in any status for reopen and cancel, only posted
    ones for close, and the lines for received. The `products` join leaves service lines out of "received in full".
  - The approval block is the requisition's, word for word, with `'purchase_order'`. There is no `draft → approved`
    move, for the same reason as 0036: a reopened order's newest round is still the old, approved one.
- **Section 7, the order's lines.**
  - The first `IF` lets through section 2's change on any order, the way 0036 lets a deleted role clear `role_id`.
  - On an approved order only the two quantities change, and only up. In this step nothing lowers them; 17d's
    purchase return will say how a return changes them.
  - On every write to a draft order's line, the requisition is read `FOR SHARE OF r`. That lock is the point
    (decision 28): a cancel or a reopen of that requisition updates the row, so it waits for this transaction, and
    its guard then sees the new line and refuses. The other way round, this lock waits for the cancel, then reads the
    cancelled status and refuses. Without the lock, both transactions would check before the other committed, and
    both would pass.
  - Closed is accepted besides approved: a draft order's lines are written again on every save, and its requisition
    may have been closed since. Whether a line may be newly picked from a closed requisition is the API's question
    (the open lines list offers only approved ones).
  - When a draft is deleted, its lines cascade after the header is gone; the order lookup finds nothing, and the
    lines go.
- **Section 8, the goods receipt.**
  - The order is read `FOR SHARE` when a receipt is written and when it is posted: the same lock trick as section 7,
    against a cancel or a reopen of the order at the same moment.
  - Posting checks the order is still approved (decision 30). The API posts the receipt before it marks the order
    received, so the last receipt of an order still sees it approved.
  - `goods_receipts_order_immutable` keeps the order and the supplier (decision 20). The line's foreign key would
    refuse a changed order too, but only when the receipt has lines; the guard says it plainly in every case.
  - The lines' guard is 0028's delivery line guard.
- **Section 9** queues step 14's `workspace.stock_accounts_requested` once for every workspace with a chart, like
  0024 did. The handler adds the template's accounts that are missing and chooses each for the use that has none, so
  after 17b.3 teaches the templates 2115 "Goods received not billed", an existing workspace gets it chosen
  (decision 12), and an account the owner already chose stays chosen. A deleted workspace gets no job.

> **What we checked.** On a throwaway database with every migration up to 0038, as `omnivo_app` (116 checks, plus
> three races in two sessions). Settings: the percent started at 0, took 3 and 100 (stored as `100.00`), and refused
> 100.01 and -1. Orders: pending without a number, an expected date before the date, terms of 366, a total that is not
> net plus VAT, another workspace's supplier or warehouse, and a second order with the same number failed. A draft
> took a line for its requisition, a yarn line and a service line; a line for another item than its requisition
> line, for a requisition of another warehouse, for a draft requisition, for a cancelled requisition, of quantity 0,
> with a repeated line number, a 101% discount, a total off by ৳1, a 100% VAT rate, more than double received, a
> negative rejection or a missing order failed; deleting a product an order line uses, deleting the supplier and
> moving the draft to the other warehouse failed; the draft and its lines changed. While the draft bought for it, the
> requisition could not be reopened or cancelled, and its lines could not change; a requisition nothing was ordered
> for could not be closed and was cancelled. A never-submitted draft was deleted with its lines; an unnumbered draft
> could not be cancelled, and no receipt could be written for it. A round for a missing order failed; pending without
> a round failed, with one passed and gave the number; the pending order then refused changes to its header, its
> number, its lines (change, delete, add), deletion, approval while the round waited, draft and cancel. A rejection
> took it back to draft with its number, which then could not change or go, and it could not be deleted or approved
> directly. Approved through a second round, it refused changes to its header and its lines, received and closed with
> nothing received. Receipts: another supplier than the order's and another workspace's warehouse failed; one at
> another warehouse than the order's passed, and once it existed (as a draft) the order could not be reopened,
> cancelled or closed. Lines for another item than the order line, for another order's line, with another order than
> the receipt's, with nothing accepted or rejected, a rejection without a reason or with 201 characters, a negative
> quantity, a zero base quantity, a zero rejected base quantity, a negative value and another item's batch failed; two
> lines for one order line, a line that accepted nothing, a lot and the vehicle passed; moving the receipt to another
> order failed. Posted, the receipt and its lines refused every change, deletion and new line, and the order's line
> could not be deleted. The order's lines took what was received and rejected, but not less; received was refused
> while the yarn was short, and passed once it came 3% over, with the service line never received. Then the order
> refused approved, line changes and new receipts, and its requisition could not be reopened and was closed, after
> which it could not be approved or cancelled. An order with a draft receipt and no posted one could not be closed;
> with a posted one it closed, and refused receipts and approved. A draft receipt was deleted with its lines, the
> order cancelled, its requisition reopened and its line deleted: the cancelled order's line kept everything but the
> link. An order without receipts was reopened with its number and then could not be approved directly. A
> `purchase_receipt` entry needed its document. Another workspace saw none of the four tables, could not write into
> them, and changed and deleted nothing; with no workspace nothing was visible. The two permissions were in the
> catalog. Races: an order line written while the requisition was cancelled (the cancel waited, then failed); the
> requisition cancelled while an order line was written (the line waited, then failed); a receipt written while the
> order was cancelled (the cancel waited, then failed). On a second database migrated to 0036 with three workspaces
> (one with a chart, one without, one deleted with a chart), 0037 and 0038 queued exactly one job, for the first.
> `drizzle-kit generate` then reports no schema changes.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db typecheck
pnpm lint
```

`packages/db` reads the contract from its build, so build it first after 17b.1. The whole repo still does not
type-check: on top of what 17b.1 left, the API reads the settings without `overReceiptPercent` and nothing uses the
new tables yet. 17b.3 changes both.

Then run `pnpm db:migrate` against your dev database. It applies 0037 and 0038 and queues the stock accounts job for
your workspaces; the worker of 17b.3 runs it.

---

## 17b.3 — `apps/api`: purchase orders and goods receipts

The API in four groups:

1. **Changes to code you already have:** "goods received not billed" in the books, the account templates and the
   role templates, the over-receipt percent in the settings, what is coming on the stock page, and the products and
   suppliers that new documents now hold on to.
2. **What the purchase documents share:** the supplier check and the priced line, the cost lookup's last price, and
   the purchase order as the approvals engine's second kind of document.
3. **Requisitions learn what was ordered;** then the **purchase orders**, the **goods receipts**, their controllers
   and the module.
4. **The purchase order goes out** through step 16's documents module: its PDF, its email and its public page.

### Goods received not billed is a stock account: `journal/posting.service.ts`

```diff
@@ -131,10 +131,12 @@ export async function checkParties(
 // The accounts only stock documents post to (step 14): the inventory account and the goods in
 // transit account. A manual entry or an opening balance on them would make the books say one value
 // and the stock another, with nothing to bring them back together. Stock comes in through an
-// adjustment (opening stock too), and a wrong value is put right by a revaluation.
+// adjustment (opening stock too), and a wrong value is put right by a revaluation. Step 17b adds
+// "goods received not billed": what it holds must be what the posted goods receipts brought in
+// and the bills (17c) have not billed yet, or the bill would clear a number nobody can explain.
 export async function stockAccountIds(tx: Transaction): Promise<Set<string>> {
   const tenantId = getTenantId();
-  const [inventory, inTransit] = await Promise.all([
+  const [inventory, chosen] = await Promise.all([
     tx
       .select({ id: ledgerAccounts.id })
       .from(ledgerAccounts)
@@ -142,9 +144,14 @@ export async function stockAccountIds(tx: Transaction): Promise<Set<string>> {
     tx
       .select({ id: stockAccounts.accountId })
       .from(stockAccounts)
-      .where(and(eq(stockAccounts.tenantId, tenantId), eq(stockAccounts.use, 'in_transit'))),
+      .where(
+        and(
+          eq(stockAccounts.tenantId, tenantId),
+          inArray(stockAccounts.use, ['in_transit', 'received_not_billed']),
+        ),
+      ),
   ]);
-  return new Set([...inventory, ...inTransit].map((row) => row.id));
+  return new Set([...inventory, ...chosen].map((row) => row.id));
 }
 
 // Who did it: the person behind the request, or nobody (a background job) — like audit()
@@ -165,7 +172,7 @@ export class PostingService {
   // locks FOR UPDATE), while other postings to the same account go on in parallel.
   // allowArchived: a reversal undoes an entry exactly, even if one of its accounts was archived
   // since — archiving hides an account from new work, it must not block fixing old work.
-  // allowStock: the entry may post to the inventory and goods in transit accounts — a stock
+  // allowStock: the entry may post to the stock accounts (stockAccountIds()) — a stock
   // document's entry, or a reversal or closing entry of old work. Every other entry may not.
   // allowMissingParty: see checkParties() — a draft, or a reversal.
   async checkLines(
```

- **`stockAccountIds()` now reads two uses,** `in_transit` and `received_not_billed`, with one `inArray()` (decision
  37). Every caller gets the new account at once: a manual entry and an opening balance on it are refused with
  `journal_account_stock`, like the inventory account.
- **A stock document's own entry is still allowed:** `postNew()` passes `allowStock` for every source in
  `STOCK_JOURNAL_SOURCES`, and 17b.1 put `purchase_receipt` there. The same list makes the journal's Reverse refuse
  the receipt's entry with step 14's `journal_is_stock`: an entry that moves with its stock is put right by another
  stock document (17d's purchase return), never alone.

### The receipt's entry: `inventory/stock-books.service.ts`

```diff
@@ -223,6 +223,30 @@ export class StockBooksService {
     ]);
   }
 
+  // A goods receipt (step 17b): the goods come into the inventory account at the purchase order's
+  // price, and the company owes that amount on "goods received not billed" until the supplier's
+  // bill (17c) moves it to the payable (Dr Inventory / Cr Goods received not billed). Both with the
+  // branch of the warehouse that received them, so each branch's balance sheet carries what it
+  // owes for its own goods. A receipt that turned everything back, or a free sample, is worth
+  // nothing and writes no entry.
+  async purchaseReceipt(
+    tx: Transaction,
+    document: { id: string; number: string; date: string },
+    moved: WarehouseValue,
+  ): Promise<EntryRef | null> {
+    const accounts = await this.accounts(tx);
+    const branchOf = await this.branches(tx, [moved]);
+    const branchId = branchOf(moved.warehouseId);
+    return this.write(tx, document, 'purchase_receipt', `Goods receipt ${document.number}`, [
+      { accountId: accounts.inventory, branchId, amount: moved.value },
+      {
+        accountId: accounts.use('received_not_billed'),
+        branchId,
+        amount: negateMoney(moved.value),
+      },
+    ]);
+  }
+
   // The posted entries of a document, oldest first: an adjustment has at most one, a transfer two
   async entriesOf(tx: Transaction, documentId: string): Promise<EntryRef[]> {
     const rows = await tx
```

- **`purchaseReceipt()` is `delivery()` turned round:** Dr Inventory / Cr Goods received not billed, both with the
  branch of the warehouse that took the goods in. The liability carries the branch too, so a branch's balance sheet
  shows what it owes for its own goods, and 17c's bill clears it for the same branch.
- **`accounts.use('received_not_billed')`** throws step 14's `stock_account_missing` while Settings → Inventory has
  no account for it (decision 12). It asks even for a receipt worth nothing, which then writes no entry: the setting
  is missing either way, and the person learns it on the first receipt, not on the first one with a price.
- **`write()` drops an entry of zero** (a free sample, or a receipt that turned everything back), as it does for
  every stock document.

```diff
@@ -135,6 +135,7 @@ export class StockAccountsService {
       correction: byUse.get('correction') ?? null,
       transfer_shortage: byUse.get('transfer_shortage') ?? null,
       revaluation: byUse.get('revaluation') ?? null,
+      received_not_billed: byUse.get('received_not_billed') ?? null,
     };
   }
 }
```

- Settings → Inventory reads the new use like the others. Saving it needs nothing new: the contract's
  `accountTypeFits()` (17b.1) asks for a liability account.

### The templates: `setup/templates.ts`

```diff
@@ -138,6 +138,15 @@ const REFUNDING = ['sales.refund.manage'] as const;
 // Settings → Approvals, by role, and a workspace starts with none.
 const SUPPLYING = ['purchase.supplier.manage', 'purchase.supplier.balance'] as const;
 const REQUESTING = ['purchase.requisition.manage'] as const;
+// Step 17b (decision 25). The buyer writes purchase orders: a garments merchandiser buying fabric
+// and trims for a buyer's order, a production manager buying raw materials, a shop's manager.
+// The store keeper (and a depot manager) receives what comes in at the gate. Where a company has
+// both, they are kept apart on purpose: the person who orders the goods does not also sign that
+// they came. A shop's manager and a general manager run everything, so they do both. A pharma or
+// distribution company buys at head office, so its orders are the owner's until the owner gives
+// the permission to a role in Settings → Roles.
+const BUYING = ['purchase.order.manage'] as const;
+const RECEIVING = ['purchase.receipt.manage'] as const;
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
@@ -181,6 +190,7 @@ const STORE_KEEPER: RoleTemplate = {
     ...DELIVERING,
     ...RETURNING,
     ...REQUESTING,
+    ...RECEIVING,
   ],
 };
 
@@ -259,6 +269,10 @@ function standardChart(industry: IndustryAccounts): ChartTemplate {
     liability: group('2000', 'Liabilities', [
       group('2100', 'Current liabilities', [
         account('2110', 'Accounts payable', 'accounts_payable'),
+        // Step 17b: what goods receipts brought in and no bill has billed yet. A stock account
+        // (Settings → Inventory), not a purpose: an old workspace gets it from the stock accounts
+        // job, which never takes over an account the owner made at this code.
+        account('2115', 'Goods received not billed'),
         account('2120', 'Output VAT', 'vat_output'),
         account('2130', 'VAT and tax deducted at source (VDS, TDS)'),
         account('2140', 'Salaries and wages payable'),
@@ -366,6 +380,7 @@ function stockAccounts(codes: { loss: string; samples?: string }): Record<StockA
     correction: '5190',
     transfer_shortage: codes.loss,
     revaluation: '5190',
+    received_not_billed: '2115',
   };
 }
 
@@ -395,6 +410,7 @@ export const INDUSTRY_TEMPLATES = {
           'sales.customer.manage',
           ...ORDERING,
           ...REQUESTING,
+          ...BUYING,
         ],
       },
       STORE_KEEPER,
@@ -459,6 +475,7 @@ export const INDUSTRY_TEMPLATES = {
           ...DELIVERING,
           ...RETURNING,
           ...REQUESTING,
+          ...RECEIVING,
         ],
       },
       {
@@ -532,6 +549,7 @@ export const INDUSTRY_TEMPLATES = {
           ...DELIVERING,
           ...RETURNING,
           ...REQUESTING,
+          ...RECEIVING,
         ],
       },
       {
@@ -580,7 +598,13 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Production manager',
         description: 'Production orders and material use',
-        permissions: ['core.user.read', 'inventory.product.manage', ...STOCK_WORK, ...REQUESTING],
+        permissions: [
+          'core.user.read',
+          'inventory.product.manage',
+          ...STOCK_WORK,
+          ...REQUESTING,
+          ...BUYING,
+        ],
       },
       STORE_KEEPER,
     ],
@@ -642,6 +666,8 @@ export const INDUSTRY_TEMPLATES = {
           ...REFUNDING,
           ...SUPPLYING,
           ...REQUESTING,
+          ...BUYING,
+          ...RECEIVING,
         ],
       },
       { name: 'Cashier', description: 'Sells at the counter', permissions: [...COLLECTING] },
@@ -699,6 +725,8 @@ export const INDUSTRY_TEMPLATES = {
           ...REFUNDING,
           ...SUPPLYING,
           ...REQUESTING,
+          ...BUYING,
+          ...RECEIVING,
         ],
       },
     ],
```

- **2115 "Goods received not billed"** sits under current liabilities, next to the payable it turns into. A new
  workspace gets it with its chart. An old one gets it from step 14's stock accounts job, which migration 0038
  queued: `seedStockAccounts()` adds a template account that is missing under its group and chooses it for the use
  that has none. An account the owner already made at 2115 with another name is never taken over; the use then stays
  empty for the owner to choose.
- **`received_not_billed: '2115'`** in `stockAccounts()`: the `Record<StockAccountUse, string>` return type makes
  this line required, so a template cannot forget a use.
- **`BUYING` and `RECEIVING`** (decision 36). The merchandiser of a garments factory buys fabric and trims for a
  buyer's order, and the production manager buys raw materials, so they write orders. The store keeper and the depot
  managers count what comes in at the gate. Keeping the two apart is an old control: the person who ordered the yarn
  does not also sign that it came. A shop's manager and a general manager run everything, so they get both.
- Like every template change, this reaches new workspaces only. An existing workspace's owner gives the permissions
  in Settings → Roles.

### The over-receipt percent: `settings/settings.service.ts`

```diff
@@ -1,5 +1,5 @@
 import { Inject, Injectable } from '@nestjs/common';
-import type { Settings, UpdateSettingsInput } from '@omnivo/contracts';
+import { compareQuantity, type Settings, type UpdateSettingsInput } from '@omnivo/contracts';
 import { attachments, journalEntries, tenantSettings, tenants } from '@omnivo/db';
 import { and, eq, sql } from 'drizzle-orm';
 
@@ -72,7 +72,15 @@ export class SettingsService {
         entityId: tenantId,
         changes: diff(
           { companyName: current.companyName, ...pickEditable(before) },
-          { companyName, ...fields },
+          {
+            companyName,
+            ...fields,
+            // Step 17b: the form's "3" is the stored "3.00", so an unchanged percent is not logged
+            overReceiptPercent:
+              compareQuantity(fields.overReceiptPercent, before.overReceiptPercent) === 0
+                ? before.overReceiptPercent
+                : fields.overReceiptPercent,
+          },
         ),
       });
       return this.read(tx);
@@ -187,5 +195,7 @@ function pickEditable(settings: typeof tenantSettings.$inferSelect) {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat: settings.pricesIncludeVat,
+    // Step 17b: NUMERIC(5,2), so "3" is saved and read back as "3.00"
+    overReceiptPercent: settings.overReceiptPercent,
   };
 }
```

- **The save needs no new line:** the contract's `overReceiptPercentSchema` turns an empty box into `'0'` and refuses
  anything else, and `...fields` writes it. `pickEditable()` reads it back for the form and the audit row.
- **The audit compares numbers, not strings.** The column is `NUMERIC(5,2)`, so a "3" the person typed is stored and
  read back as "3.00"; compared as strings, every save of the form would log "3.00 → 3" without a change.
  `compareQuantity()` compares the values, and an unchanged percent keeps the stored text, which `diff()` then leaves
  out.

### What is coming: `inventory/stock.service.ts`

```diff
@@ -70,6 +70,7 @@ const itemRowSchema = z.object({
   on_hand: z.string(),
   in_transit: z.string(),
   on_order: z.string(),
+  incoming: z.string(),
   low: z.boolean(),
   unit_cost: z.string().nullable(),
   value: z.string().nullable(),
@@ -94,6 +95,7 @@ function toItem(row: z.output<typeof itemRowSchema>, canSee: boolean): StockItem
     onHand: row.on_hand,
     inTransit: row.in_transit,
     onOrder: row.on_order,
+    incoming: row.incoming,
     low: row.low,
     unitCost: canSee ? row.unit_cost : null,
     value: canSee ? row.value : null,
@@ -149,6 +151,7 @@ const reorderRowSchema = z.object({
   warehouse_id: z.uuid(),
   on_hand: z.string(),
   in_transit: z.string(),
+  incoming: z.string(),
   min_quantity: z.string(),
   reorder_quantity: z.string().nullable(),
   sort_key: z.string(),
@@ -669,6 +672,7 @@ export class StockService {
                     JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                    WHERE l.tenant_id = r.tenant_id AND l.variant_id = r.variant_id
                      AND t.status = 'in_transit' AND t.to_warehouse_id = r.warehouse_id)`)} AS in_transit,
+                 ${incomingTo(sql`r.warehouse_id`)} AS incoming,
                  round(r.min_quantity, 4)::text AS min_quantity,
                  round(r.reorder_quantity, 4)::text AS reorder_quantity,
                  lower(p.name) AS sort_key
@@ -702,6 +706,7 @@ export class StockService {
           warehouseId: row.warehouse_id,
           onHand: row.on_hand,
           inTransit: row.in_transit,
+          incoming: row.incoming,
           minQuantity: row.min_quantity,
           reorderQuantity: row.reorder_quantity,
         })),
@@ -845,6 +850,7 @@ export class StockService {
                  WHERE l.tenant_id = v.tenant_id AND l.product_id = p.id AND l.variant_id = v.id
                    AND o.status = 'confirmed' AND ${inWarehouse(sql`o.warehouse_id`)})`)
                } AS on_order,
+               ${incomingTo(warehouseId === undefined ? null : sql`${warehouseId}::uuid`)} AS incoming,
                ${lowCondition(warehouseId)} AS low,
                round(sv.unit_cost, 4)::text AS unit_cost,
                ${
@@ -878,6 +884,19 @@ export class StockService {
   }
 }
 
+// Step 17b (decision 23): what approved purchase orders still have to bring of the variant `v`
+// (p is its product) to a warehouse (or to any, for null), in the base unit. Each line counts
+// what is left of it, never below zero: a line that came over the order owes nothing, and it does
+// not cancel another line still waiting. l.product_id lets purchase_order_lines_variant_idx find
+// the lines; the order's status and warehouse are purchase_orders_open_idx's.
+function incomingTo(warehouse: SQL | null): SQL<string> {
+  return quantityText(sql`(SELECT sum(greatest(l.base_quantity - l.received_quantity, 0))
+    FROM purchase_order_lines l
+    JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
+   WHERE l.tenant_id = v.tenant_id AND l.product_id = p.id AND l.variant_id = v.id
+     AND o.status = 'approved' AND ${warehouse === null ? sql`true` : sql`o.warehouse_id = ${warehouse}`})`);
+}
+
 // At or below the reorder level in the chosen warehouse, or in any active warehouse
 function lowCondition(warehouseId: string | undefined): SQL {
   return sql`EXISTS (
```

- **`incomingTo()` is step 15b's `on_order` for the other direction:** what approved orders still have to bring,
  in the base unit, for one warehouse (the stock list's filter, the reorder row's own warehouse) or for all.
- **`greatest(…, 0)` per line** (decision 41): 1,028 m received against a line of 1,000 m owes nothing, and it must
  not hide another line of the same yarn that still waits for 500 m. A sum over the order would net them.
- **Only `approved` orders count:** a received order has nothing left, a closed one will not bring the rest, and a
  draft or pending one is not ordered yet. The condition is the partial index `purchase_orders_open_idx` of 17b.2,
  and `l.product_id = p.id` lets `purchase_order_lines_variant_idx` find the lines.
- **By the order's warehouse,** not where a receipt may unload: until it is posted, nobody knows.

### Products and suppliers in use

```diff
@@ -69,6 +69,9 @@ const VARIANT_IN_USE = [
   'credit_note_lines_variant_fk',
   // step 17a
   'requisition_lines_variant_fk',
+  // step 17b
+  'purchase_order_lines_variant_fk',
+  'goods_receipt_lines_variant_fk',
 ] as const;
 
 // The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
```

- An order line and a receipt line hold on to their product, like every other document line: deleting it is refused
  with `product_variant_in_use`.

```diff
@@ -9,12 +9,14 @@ import {
   type UpdateSupplierInput,
 } from '@omnivo/contracts';
 import {
+  goodsReceipts,
   journalEntries,
   journalLines,
   ledgerAccounts,
   parties,
   partyAddresses,
   partyBankAccounts,
+  purchaseOrders,
   supplierGroups,
   tenantSettings,
 } from '@omnivo/db';
@@ -95,7 +97,12 @@ function fieldError(code: ErrorCode, field: string): AppError {
 
 // Rows that hold on to a supplier-only party, so its delete is refused (supplier_in_use). 17b–17d
 // add their documents.
-const SUPPLIER_IN_USE = ['journal_lines_party_fk'] as const;
+const SUPPLIER_IN_USE = [
+  'journal_lines_party_fk',
+  // step 17b
+  'purchase_orders_supplier_fk',
+  'goods_receipts_supplier_fk',
+] as const;
 
 // Suppliers (step 17a): the same parties table as the customers, with is_supplier set. This
 // service only reads and writes the supplier's side and the fields both sides share (decision 9);
@@ -351,33 +358,29 @@ export class SuppliersService {
     }
   }
 
-  // The party stays, so no foreign key speaks up: the payable lines that name it are looked for
-  // here (17b–17d add their documents). The row is locked FOR UPDATE (lock()), and every posting
-  // locks it FOR SHARE first (checkParties), so a line posted at the same moment is either seen
-  // here or finds no supplier. The supplier's own columns go back to their defaults in the same
-  // UPDATE (parties_supplier_side_check), and its bank accounts go. The billing address is the
-  // party's, and the customer keeps it.
+  // The party stays, so no foreign key speaks up: what uses the supplier side is looked for here,
+  // in one UNION ALL query like the customers' (the tables of SUPPLIER_IN_USE, and the payable
+  // lines that name it; 17c and 17d add their documents). The row is locked FOR UPDATE (lock()),
+  // and every posting and every purchase order locks it FOR SHARE first (checkParties,
+  // assertSupplier), so a line or an order written at the same moment is either seen here or
+  // finds no supplier. A goods receipt needs an order of the supplier, which is found already. The supplier's own columns go back to their defaults in the same UPDATE
+  // (parties_supplier_side_check), and its bank accounts go. The billing address is the party's,
+  // and the customer keeps it.
   private async dropSupplierSide(tx: Transaction, party: PartyRow): Promise<void> {
     const tenantId = getTenantId();
-    const [used] = await tx
-      .select({ id: journalLines.id })
-      .from(journalLines)
-      .innerJoin(
-        ledgerAccounts,
-        and(
-          eq(ledgerAccounts.tenantId, journalLines.tenantId),
-          eq(ledgerAccounts.id, journalLines.accountId),
-        ),
-      )
-      .where(
-        and(
-          eq(journalLines.tenantId, tenantId),
-          eq(journalLines.partyId, party.id),
-          eq(ledgerAccounts.purpose, 'accounts_payable'),
-        ),
-      )
-      .limit(1);
-    if (used) throw supplierInUse();
+    const documents = [purchaseOrders, goodsReceipts].map(
+      (table) =>
+        sql`SELECT 1 FROM ${table} WHERE tenant_id = ${tenantId}::uuid AND supplier_id = ${party.id}::uuid`,
+    );
+    const used = await tx.execute(sql`
+      ${sql.join(documents, sql` UNION ALL `)}
+      UNION ALL
+      SELECT 1 FROM ${journalLines} l
+        JOIN ${ledgerAccounts} a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
+       WHERE l.tenant_id = ${tenantId}::uuid AND l.party_id = ${party.id}::uuid
+         AND a.purpose = 'accounts_payable'
+      LIMIT 1`);
+    if (used.length > 0) throw supplierInUse();
     await tx
       .update(parties)
       .set({
```

- **`SUPPLIER_IN_USE` gets the two documents' foreign keys,** so deleting a supplier-only party with an order is
  `supplier_in_use`.
- **`dropSupplierSide()` asks the same tables,** because an `UPDATE` of a flag fires no foreign key. It is now the
  customers' `UNION ALL … LIMIT 1` query (17a.3): the first row found is enough, and the tables are Drizzle objects,
  so a renamed table breaks the type check instead of the query.
- **The race is closed by the lock order,** as for the customers: `lock()` holds the party `FOR UPDATE`, and
  `assertSupplier()` (below) takes it `FOR SHARE` before an order is written. A goods receipt needs an order of the
  supplier, which the query finds already.

### The supplier and the priced line: `purchase/purchase-lines.ts`

```diff
@@ -3,10 +3,13 @@ import {
   type ErrorCode,
   fitsDecimals,
   isQuantity,
+  lineAmounts,
+  type PartyRef,
+  type SalesLineInput,
   toBaseQuantity,
 } from '@omnivo/contracts';
-import { warehouses } from '@omnivo/db';
-import { and, eq } from 'drizzle-orm';
+import { parties, taxRates, warehouses } from '@omnivo/db';
+import { and, eq, inArray } from 'drizzle-orm';
 
 import { AppError } from '../common/http/app-error.js';
 import { getTenantId } from '../common/tenant/tenant-context.js';
@@ -18,9 +21,10 @@ import {
   loadVariants,
   type VariantInfo,
 } from '../inventory/stock-lines.js';
+import type { ResolvedSalesLine } from '../sales/sales-lines.js';
 
 // What every purchase document checks the same way (step 17a): the warehouse the goods are for and
-// the items on its lines. 17b's purchase order and goods receipt use them too.
+// the items on its lines. Step 17b adds the supplier and the priced line of a purchase order.
 
 // An active warehouse of this workspace. A draft that already has this warehouse keeps it (keptId)
 // even if it was archived since, like a sales draft keeps its archived customer: the person can
@@ -43,6 +47,40 @@ export async function assertWarehouse(
   }
 }
 
+// Step 17b: the supplier a document is written for: a supplier of this workspace, and not
+// archived. A draft that already has this supplier keeps it (keptId), like assertCustomer() of the
+// sales documents. FOR SHARE: an archive, a delete or "drop the supplier side" (SuppliersService
+// locks the party FOR UPDATE) waits until we commit, and then sees this document.
+export async function assertSupplier(
+  tx: Transaction,
+  supplierId: string,
+  keptId: string | null = null,
+): Promise<PartyRef> {
+  const [row] = await tx
+    .select({
+      id: parties.id,
+      code: parties.code,
+      name: parties.name,
+      archivedAt: parties.archivedAt,
+    })
+    .from(parties)
+    .where(
+      and(
+        eq(parties.tenantId, getTenantId()),
+        eq(parties.id, supplierId),
+        eq(parties.isSupplier, true),
+      ),
+    )
+    .for('share');
+  if (!row || (row.archivedAt !== null && row.id !== keptId)) {
+    const code: ErrorCode = 'purchase_supplier_invalid';
+    throw new AppError(409, code, 'Pick an active supplier.', {
+      fieldErrors: { supplierId: [code] },
+    });
+  }
+  return { id: row.id, code: row.code, name: row.name };
+}
+
 // A purchase line's item as the form sends it
 export interface PurchaseItemInput {
   variantId: string;
@@ -69,47 +107,101 @@ export async function resolvePurchaseItems(
   tx: Transaction,
   lines: readonly PurchaseItemInput[],
 ): Promise<ResolvedPurchaseItem[]> {
+  const { resolved, issues } = await checkPurchaseItems(tx, lines);
+  if (issues.length > 0) throw linesError(issues);
+  return resolved.flatMap((item) => (item === null ? [] : [item]));
+}
+
+// resolvePurchaseItems() without the throw: one entry per line (null where the line has a
+// problem) and the problems, so a caller with more to check can report everything at once
+async function checkPurchaseItems(
+  tx: Transaction,
+  lines: readonly PurchaseItemInput[],
+): Promise<{ resolved: (ResolvedPurchaseItem | null)[]; issues: LineIssue[] }> {
   const variants = await loadVariants(
     tx,
     lines.map((line) => line.variantId),
   );
   const issues: LineIssue[] = [];
-  const resolved: ResolvedPurchaseItem[] = [];
-  lines.forEach((line, index) => {
+  const resolved = lines.map((line, index): ResolvedPurchaseItem | null => {
     const at = (field: string, code: ErrorCode) => {
       issues.push({ path: linePath(index, field), code });
+      return null;
     };
     const variant = variants.get(line.variantId);
-    if (variant === undefined || variant.archived) {
-      at('variantId', 'purchase_item_invalid');
-      return;
-    }
+    if (variant === undefined || variant.archived) return at('variantId', 'purchase_item_invalid');
     const unit =
       line.unitId === variant.baseUnitId
         ? { factor: '1', decimals: variant.baseDecimals }
         : variant.units.find((pack) => pack.unitId === line.unitId);
-    if (unit === undefined) {
-      at('unitId', 'stock_unit_invalid');
-      return;
-    }
-    if (!fitsDecimals(line.quantity, unit.decimals)) {
-      at('quantity', 'stock_quantity_decimals');
-      return;
-    }
+    if (unit === undefined) return at('unitId', 'stock_unit_invalid');
+    if (!fitsDecimals(line.quantity, unit.decimals))
+      return at('quantity', 'stock_quantity_decimals');
     const baseQuantity = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
-    if (!isQuantity(baseQuantity)) {
-      at('quantity', 'quantity_format');
-      return;
-    }
-    resolved.push({
+    if (!isQuantity(baseQuantity)) return at('quantity', 'quantity_format');
+    return {
       variant,
       unitId: line.unitId,
       quantity: line.quantity,
       factor: unit.factor,
       baseQuantity,
       description: line.description ?? defaultLineDescription(variant),
-    });
+    };
+  });
+  return { resolved, issues };
+}
+
+// Step 17b: a purchase order line, priced like a sales line (decision 6): the item checked as on
+// every purchase line, the VAT rate an active one of this workspace (keptRateIds: the rates the
+// order's lines already use stay usable after they are archived, like resolveSalesLines()), and
+// the amounts worked out with the contract's lineAmounts(), the function the form totals with.
+// The result has a sales line's shape, so salesLineValues() and toSalesLine() store and read it.
+export async function resolvePurchaseLines(
+  tx: Transaction,
+  lines: readonly SalesLineInput[],
+  pricesIncludeVat: boolean,
+  keptRateIds: ReadonlySet<string> = new Set(),
+): Promise<ResolvedSalesLine[]> {
+  const { resolved, issues } = await checkPurchaseItems(tx, lines);
+  const rateIds = [...new Set(lines.map((line) => line.taxRateId))];
+  const rateRows = await tx
+    .select({
+      id: taxRates.id,
+      name: taxRates.name,
+      kind: taxRates.kind,
+      rate: taxRates.rate,
+      archivedAt: taxRates.archivedAt,
+    })
+    .from(taxRates)
+    .where(and(eq(taxRates.tenantId, getTenantId()), inArray(taxRates.id, rateIds)));
+  const rates = new Map(rateRows.map((row) => [row.id, row]));
+  const priced = lines.map((line, index): ResolvedSalesLine | null => {
+    const rate = rates.get(line.taxRateId);
+    if (rate === undefined || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
+      issues.push({ path: linePath(index, 'taxRateId'), code: 'tax_rate_invalid' });
+      return null;
+    }
+    const item = resolved[index];
+    if (item === undefined || item === null) return null;
+    return {
+      ...item,
+      unitPrice: line.unitPrice,
+      discountType: line.discountType,
+      discount: line.discount,
+      taxRate: { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate },
+      amounts: lineAmounts(
+        {
+          quantity: line.quantity,
+          unitPrice: line.unitPrice,
+          discountType: line.discountType,
+          discount: line.discount,
+          rate: rate.rate,
+        },
+        pricesIncludeVat,
+      ),
+    };
   });
+  // Every problem of every line at once, items and rates together
   if (issues.length > 0) throw linesError(issues);
-  return resolved;
+  return priced.flatMap((line) => (line === null ? [] : [line]));
 }
```

- **`assertSupplier()` is `assertCustomer()` for the other side:** a supplier of this workspace (`is_supplier`), not
  archived unless the draft already has it (`keptId`), and `FOR SHARE`. Its error sits under the form's own
  `supplierId`.
- **`checkPurchaseItems()` is 17a's `resolvePurchaseItems()` without the throw.** It returns one entry per line
  (`null` where the line has a problem) and the problems. `resolvePurchaseItems()` is now a short wrapper, so the
  requisition's code does not change.
- **`resolvePurchaseLines()`** adds what a priced line needs (decision 6): an active VAT rate (or one the order's
  lines already use, `keptRateIds`, like the sales lines) and the amounts from the contract's `lineAmounts()`, the
  function the form totals with. It collects the item problems and the rate problems together, so the person sees
  every highlighted box at once, not the rates only after fixing the items.
- **Why not `resolveSalesLines()`?** It answers `sales_item_invalid` ("Pick an active product or service to sell")
  under a purchase line. The result has the sales line's shape (`ResolvedSalesLine`), so `salesLineValues()`,
  `toSalesLine()` and `documentTotals()` store, read and add up an order line as they do a sales line.

### The last price: `purchase/cost-lookup.service.ts`

```diff
@@ -1,6 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
-import type { CostLookup, CostLookupInput } from '@omnivo/contracts';
-import { sql } from 'drizzle-orm';
+import type { CostLookup, CostLookupInput, CostLookupItem } from '@omnivo/contracts';
+import { type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { getTenantId } from '../common/tenant/tenant-context.js';
@@ -11,14 +11,35 @@ import { ValueAccess } from '../inventory/value-access.js';
 const rowSchema = z.object({
   variant_id: z.uuid(),
   unit_id: z.uuid(),
-  cost: z.string().nullable(),
+  supplier_price: z.string().nullable(),
+  last_price: z.string().nullable(),
+  average_cost: z.string().nullable(),
+  tax_rate_id: z.uuid().nullable(),
 });
 
-// The cost a new purchase line starts with (step 17a, decision 20). The person may change it on
-// the line: this is only where it starts.
-//   cost  the company-wide average cost of the variant (step 14) × the unit's factor; else none
-//         (null): a product never bought, or a service, which has no stock and so no average
-// 17b puts the last purchase price before the average.
+// The price of the latest approved purchase order line for the variant (step 17b, decision 19),
+// per base unit: the line's net (after its discount, before VAT) ÷ its base quantity. Approved,
+// received and closed orders count; a draft or a pending order is not a price anybody agreed to,
+// and a cancelled one was never bought. `supplier`: only this supplier's orders.
+function lastPrice(supplier: SQL | null): SQL {
+  return sql`(
+    SELECT pl.net / pl.base_quantity
+      FROM purchase_order_lines pl
+      JOIN purchase_orders po ON po.tenant_id = pl.tenant_id AND po.id = pl.order_id
+     WHERE pl.tenant_id = v.tenant_id AND pl.product_id = p.id AND pl.variant_id = v.id
+       AND po.status IN ('approved', 'received', 'closed')
+       ${supplier === null ? sql`` : sql`AND po.supplier_id = ${supplier}`}
+     ORDER BY po.date DESC, po.created_at DESC, pl.line_no
+     LIMIT 1)`;
+}
+
+// The cost and VAT rate a new purchase line starts with (step 17a, decision 20; step 17b, decision
+// 19). The person may change both on the line: this is only where they start.
+//   cost      this supplier's last price, else anyone's last price, else the company-wide average
+//             cost (step 14), each × the unit's factor; else none (null): a product never bought,
+//             or a service never ordered
+//   VAT rate  the product's own rate if it is active, else the workspace default, like the sales
+//             price lookup. A requisition has no VAT and ignores it.
 @Injectable()
 export class CostLookupService {
   constructor(
@@ -29,8 +50,9 @@ export class CostLookupService {
   async lookup(input: CostLookupInput): Promise<CostLookup> {
     const tenantId = getTenantId();
     // The average comes from the books, so only someone with inventory.stock.value gets it, like
-    // the stock page's costs (step 14). Everyone else gets every item, with no cost: the form still
-    // learns which items are valid, and the person types the cost.
+    // the stock page's costs (step 14). A purchase price is a price people agreed, so everyone who
+    // writes purchases gets it (decision 19). An item with neither still comes back, with no cost:
+    // the form learns which items are valid, and the person types the cost.
     const canSee = await this.values.canSee();
     return this.withTenant(async (tx) => {
       // One query for every item, in the order they were asked for (ord), like the sales price
@@ -43,32 +65,56 @@ export class CostLookupService {
         ),
         sql`, `,
       );
+      // The unit's factor once, for every source: each is per base unit
+      const factor = sql`CASE WHEN w.unit_id = p.base_unit_id THEN 1 ELSE pu.factor END`;
       const rows = z.array(rowSchema).parse(
         await tx.execute(sql`
           WITH wanted(ord, variant_id, unit_id) AS (VALUES ${wanted})
           SELECT w.variant_id::text AS variant_id, w.unit_id::text AS unit_id,
                  ${
-                   canSee
-                     ? sql`round(sv.unit_cost * CASE WHEN w.unit_id = p.base_unit_id THEN 1
-                                                     ELSE pu.factor END, 4)::text`
-                     : sql`NULL::text`
-                 } AS cost
+                   input.supplierId === null
+                     ? sql`NULL::text`
+                     : sql`round(${lastPrice(sql`${input.supplierId}::uuid`)} * ${factor}, 4)::text`
+                 } AS supplier_price,
+                 round(${lastPrice(null)} * ${factor}, 4)::text AS last_price,
+                 ${
+                   canSee ? sql`round(sv.unit_cost * ${factor}, 4)::text` : sql`NULL::text`
+                 } AS average_cost,
+                 coalesce(own.id, d.id)::text AS tax_rate_id
             FROM wanted w
             JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = w.variant_id
             JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
             LEFT JOIN product_units pu
               ON pu.tenant_id = p.tenant_id AND pu.product_id = p.id AND pu.unit_id = w.unit_id
             LEFT JOIN stock_values sv ON sv.tenant_id = v.tenant_id AND sv.variant_id = v.id
+            LEFT JOIN tax_rates own
+              ON own.tenant_id = p.tenant_id AND own.id = p.tax_rate_id AND own.archived_at IS NULL
+            LEFT JOIN tax_rates d ON d.tenant_id = v.tenant_id AND d.is_default
            WHERE w.unit_id = p.base_unit_id OR pu.unit_id IS NOT NULL
            ORDER BY w.ord`),
       );
       return {
-        items: rows.map((row) => ({
-          variantId: row.variant_id,
-          unitId: row.unit_id,
-          cost: row.cost,
-          source: row.cost === null ? null : 'average_cost',
-        })),
+        items: rows.flatMap((row): CostLookupItem[] => {
+          // No rate at all: a workspace whose setup job has not made its rates yet
+          if (row.tax_rate_id === null) return [];
+          const [cost, source] =
+            row.supplier_price !== null
+              ? [row.supplier_price, 'supplier_price']
+              : row.last_price !== null
+                ? [row.last_price, 'last_price']
+                : row.average_cost !== null
+                  ? [row.average_cost, 'average_cost']
+                  : [null, null];
+          return [
+            {
+              variantId: row.variant_id,
+              unitId: row.unit_id,
+              cost,
+              source,
+              taxRateId: row.tax_rate_id,
+            },
+          ];
+        }),
       };
     });
   }
```

- **`lastPrice()` is the latest approved order line's net per base unit** (decision 19): `net / base_quantity`, so
  the line's discount is in it, its VAT is not, and the order's own VAT setting does not matter. Approved, received
  and closed orders count; a draft or a pending order is no agreed price, and a cancelled one was never bought. The
  newest order date wins, then the newest order written that day.
- **Three sources in one query,** each × the unit's factor and rounded once to 4 decimals in Postgres, as before:
  this supplier's price, anyone's price, and the average cost. TypeScript picks the first one that is there, so
  `source` always names where the number came from.
- **Without `inventory.stock.value` only the average is `NULL`.** A purchase price is a price people typed and
  agreed, so every buyer may see it; the average is worked out from the books and keeps step 14's rule.
- **`taxRateId`** is the sales price lookup's: the product's own active rate, else the workspace default. An item
  with no rate at all (a workspace whose setup job has not made its rates yet) is left out, like there.
- **A requisition calls the same lookup** with `supplierId: null` (the contract's default), so its estimated cost now
  starts from anyone's last price too, and ignores the rate.

### The order in the approvals engine: `purchase/approval-documents.ts`

```diff
@@ -1,5 +1,5 @@
 import type { ApprovalDocument, AuditEntityType } from '@omnivo/contracts';
-import { requisitions, warehouses } from '@omnivo/db';
+import { parties, purchaseOrders, requisitions, warehouses } from '@omnivo/db';
 import { and, eq, inArray, sql } from 'drizzle-orm';
 
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
@@ -7,8 +7,9 @@ import type { Transaction } from '../common/tenant/with-tenant.js';
 
 // What the approvals engine needs from each kind of document, so one engine serves them all
 // (decision 16). The engine never writes a document's own columns except its status, and only
-// through setStatus(). 17b adds the purchase order here, 17c the bill and the payment; the
-// `satisfies` below does not compile until every kind in APPROVAL_DOCUMENTS has its entry.
+// through setStatus(). The purchase order is the second kind (17b); 17c adds the bill and the
+// payment. The `satisfies` below does not compile until every kind in APPROVAL_DOCUMENTS has its
+// entry.
 
 // The statuses the engine moves a document between. Every kind has these three, whatever it calls
 // its others (a requisition's cancelled, an order's received).
@@ -75,4 +76,55 @@ const requisition: ApprovalTarget = {
   },
 };
 
-export const APPROVAL_TARGETS = { requisition } satisfies Record<ApprovalDocument, ApprovalTarget>;
+// Step 17b: a purchase order is the requisition's twin, with its supplier as the subject: the
+// approver asks "from whom?" before "for which warehouse?"
+const purchaseOrder: ApprovalTarget = {
+  entityType: 'purchase_order',
+  async lock(tx, id) {
+    const [row] = await tx
+      .select({ status: purchaseOrders.status })
+      .from(purchaseOrders)
+      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)))
+      .for('update');
+    return row ?? null;
+  },
+  async setStatus(tx, id, status) {
+    await tx
+      .update(purchaseOrders)
+      .set({
+        status,
+        version: sql`${purchaseOrders.version} + 1`,
+        updatedBy: currentPrincipal().userId,
+      })
+      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
+  },
+  async describe(tx, ids) {
+    if (ids.length === 0) return new Map();
+    const rows = await tx
+      .select({
+        id: purchaseOrders.id,
+        number: purchaseOrders.number,
+        date: purchaseOrders.date,
+        subject: parties.name,
+      })
+      .from(purchaseOrders)
+      .innerJoin(
+        parties,
+        and(
+          eq(parties.tenantId, purchaseOrders.tenantId),
+          eq(parties.id, purchaseOrders.supplierId),
+        ),
+      )
+      .where(and(eq(purchaseOrders.tenantId, getTenantId()), inArray(purchaseOrders.id, [...ids])));
+    // An order is numbered before its first round (PurchaseOrdersService.submit), so every order
+    // the engine asks about has one; flatMap only satisfies the nullable column
+    return new Map(
+      rows.flatMap(({ id, number, ...row }) => (number === null ? [] : [[id, { number, ...row }]])),
+    );
+  },
+};
+
+export const APPROVAL_TARGETS = {
+  requisition,
+  purchase_order: purchaseOrder,
+} satisfies Record<ApprovalDocument, ApprovalTarget>;
```

- **`purchaseOrder` is `requisition` for the other table.** The `satisfies Record<ApprovalDocument, ApprovalTarget>`
  of 17a refused to compile from the moment 17b.1 added `purchase_order` to the contract; this entry ends that.
- **The subject is the supplier's name** (17a's plan): an approver asks "from whom?" before "for which warehouse?".
- **`describe()` drops an order without a number,** only to satisfy the nullable column: the engine only describes
  submitted orders, and `submit()` (below) numbers an order before its first round.

### Requisitions learn what was ordered: `purchase/requisitions.service.ts`

```diff
@@ -1,32 +1,92 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  type OpenRequisitionLinePage,
   type Requisition,
   type RequisitionInput,
+  type RequisitionLine,
   requisitionLineAmount,
+  type RequisitionOrderFilter,
+  type RequisitionOrderState,
   type RequisitionStatus,
   type RequisitionSummary,
+  subtractQuantity,
   sumMoney,
   type UpdateRequisitionInput,
 } from '@omnivo/contracts';
-import { requisitionLines, requisitions, users, warehouses } from '@omnivo/db';
-import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
+import {
+  products,
+  productVariants,
+  purchaseOrderLines,
+  purchaseOrders,
+  requisitionLines,
+  requisitions,
+  users,
+  warehouses,
+} from '@omnivo/db';
+import { and, asc, desc, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
 import { isCheckViolation } from '../common/db/pg-errors.js';
+import { containsPattern } from '../common/db/search.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
+import type { VariantInfo } from '../inventory/stock-lines.js';
 import { withVariants } from '../sales/sales-lines.js';
 import { NumberingService } from '../numbering/numbering.service.js';
 import { ApprovalsService } from './approvals.service.js';
 import { assertWarehouse, resolvePurchaseItems } from './purchase-lines.js';
 
 type RequisitionRow = typeof requisitions.$inferSelect;
+type LineRow = typeof requisitionLines.$inferSelect;
 
 const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);
+// The open lines: oldest requisition first, then its lines in order
+const openCursorSchema = z.tuple([z.iso.date(), z.uuid(), z.number().int()]);
+
+// How much of a requisition line purchase orders took, in the base unit (step 17b, decision 16):
+// all of an order line while its order is open or received, only what came in once it is closed
+// (the rest is still wanted), nothing once it is cancelled. A service is never received, so a
+// closed order counts it in full: it was bought. Counted here, never stored (decision 26).
+// `line` is the requisition line's name in the outer query.
+function orderedOf(line: string): SQL<string> {
+  const l = sql.raw(line);
+  return sql<string>`coalesce((
+    SELECT sum(CASE WHEN po.status = 'closed' AND p.type = 'goods' THEN pl.received_quantity
+                    ELSE pl.base_quantity END)
+      FROM purchase_order_lines pl
+      JOIN purchase_orders po ON po.tenant_id = pl.tenant_id AND po.id = pl.order_id
+      JOIN products p ON p.tenant_id = pl.tenant_id AND p.id = pl.product_id
+     WHERE pl.tenant_id = ${l}.tenant_id AND pl.requisition_line_id = ${l}.id
+       AND po.status <> 'cancelled'), 0)`;
+}
+
+// Some line of it was ordered, and some line still waits for more
+const lineOrdered = sql`EXISTS (
+  SELECT 1 FROM requisition_lines rl
+   WHERE rl.tenant_id = requisitions.tenant_id AND rl.requisition_id = requisitions.id
+     AND ${orderedOf('rl')} > 0
+)`;
+const lineToOrder = sql`EXISTS (
+  SELECT 1 FROM requisition_lines rl
+   WHERE rl.tenant_id = requisitions.tenant_id AND rl.requisition_id = requisitions.id
+     AND ${orderedOf('rl')} < rl.base_quantity
+)`;
+
+// Only an approved or closed requisition is ordered from: a draft's lines are not settled yet
+const orderState = sql<RequisitionOrderState>`CASE
+  WHEN requisitions.status NOT IN ('approved', 'closed') OR NOT ${lineOrdered} THEN 'not_ordered'
+  WHEN ${lineToOrder} THEN 'partly_ordered'
+  ELSE 'ordered' END`;
+
+// The list's order filter: approved, with a line still to order (what a buyer works through)
+function orderFilter(filter: RequisitionOrderFilter | undefined): SQL | undefined {
+  if (filter === undefined) return undefined;
+  return and(eq(requisitions.status, 'approved'), lineToOrder);
+}
 
 // By the table's name: inside this subquery a bare "id" would be the line's own
 const lineCount = sql<number>`(
@@ -50,10 +110,20 @@ function wasSubmitted(): AppError {
   );
 }
 
+// Step 17b: a purchase order buys for it, so its lines must stay as they are
+function closeInstead(): AppError {
+  return new AppError(
+    409,
+    'purchase_close_instead',
+    'A purchase order buys for this requisition. Close it instead.',
+  );
+}
+
 function toSummary(
   row: RequisitionRow,
   requestedByName: string,
   lines: number,
+  ordered: RequisitionOrderState,
 ): RequisitionSummary {
   return {
     id: row.id,
@@ -62,6 +132,7 @@ function toSummary(
     neededBy: row.neededBy,
     warehouseId: row.warehouseId,
     status: row.status,
+    orderState: ordered,
     amount: row.amount,
     lineCount: lines,
     requestedBy: { id: row.requestedBy, name: requestedByName },
@@ -106,6 +177,7 @@ export class RequisitionsService {
     cursor?: string | undefined;
     status?: RequisitionStatus | undefined;
     warehouseId?: string | undefined;
+    order?: RequisitionOrderFilter | undefined;
   }): Promise<{ items: RequisitionSummary[]; nextCursor: string | null }> {
     const after = decodeCursor(query.cursor, cursorSchema);
     return this.withTenant(async (tx) => {
@@ -116,6 +188,7 @@ export class RequisitionsService {
           query.warehouseId === undefined
             ? undefined
             : eq(requisitions.warehouseId, query.warehouseId),
+          orderFilter(query.order),
           after === undefined
             ? undefined
             : sql`(${requisitions.date}, ${requisitions.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
@@ -128,7 +201,7 @@ export class RequisitionsService {
       ]);
       return {
         items: page.items.map((row) =>
-          toSummary(row.requisition, row.requestedByName, row.lineCount),
+          toSummary(row.requisition, row.requestedByName, row.lineCount, row.orderState),
         ),
         nextCursor: page.nextCursor,
       };
@@ -139,6 +212,96 @@ export class RequisitionsService {
     return this.withTenant((tx) => this.read(tx, id));
   }
 
+  // Step 17b: the lines a purchase order for this warehouse may buy for (decision 18): lines of
+  // approved requisitions with something still to order, oldest requisition first. A closed
+  // requisition is left out: its rest will not be bought.
+  openLines(query: {
+    limit: number;
+    cursor?: string | undefined;
+    warehouseId: string;
+    requisitionId?: string | undefined;
+    search?: string | undefined;
+  }): Promise<OpenRequisitionLinePage> {
+    const after = decodeCursor(query.cursor, openCursorSchema);
+    const ordered = sql<string>`round(${orderedOf('requisition_lines')}, 4)::text`;
+    return this.withTenant(async (tx) => {
+      const search =
+        query.search === undefined || query.search === ''
+          ? undefined
+          : containsPattern(query.search);
+      const rows = await tx
+        .select({
+          line: requisitionLines,
+          requisition: {
+            id: requisitions.id,
+            number: requisitions.number,
+            date: requisitions.date,
+            neededBy: requisitions.neededBy,
+          },
+          orderedQuantity: ordered,
+        })
+        .from(requisitionLines)
+        .innerJoin(
+          requisitions,
+          and(
+            eq(requisitions.tenantId, requisitionLines.tenantId),
+            eq(requisitions.id, requisitionLines.requisitionId),
+          ),
+        )
+        .innerJoin(
+          productVariants,
+          and(
+            eq(productVariants.tenantId, requisitionLines.tenantId),
+            eq(productVariants.id, requisitionLines.variantId),
+          ),
+        )
+        .innerJoin(
+          products,
+          and(
+            eq(products.tenantId, productVariants.tenantId),
+            eq(products.id, productVariants.productId),
+          ),
+        )
+        .where(
+          and(
+            eq(requisitionLines.tenantId, getTenantId()),
+            eq(requisitions.status, 'approved'),
+            eq(requisitions.warehouseId, query.warehouseId),
+            query.requisitionId === undefined
+              ? undefined
+              : eq(requisitions.id, query.requisitionId),
+            sql`${orderedOf('requisition_lines')} < ${requisitionLines.baseQuantity}`,
+            search === undefined
+              ? undefined
+              : sql`(lower(${requisitions.number}) LIKE ${search} OR lower(${products.name}) LIKE ${search}
+                     OR lower(${products.code}) LIKE ${search} OR lower(${productVariants.sku}) LIKE ${search})`,
+            after === undefined
+              ? undefined
+              : sql`(${requisitions.date}, ${requisitions.id}, ${requisitionLines.lineNo}) > (${after[0]}::date, ${after[1]}::uuid, ${after[2]}::int)`,
+          ),
+        )
+        .orderBy(asc(requisitions.date), asc(requisitions.id), asc(requisitionLines.lineNo))
+        .limit(query.limit + 1);
+      const page = toPage(rows, query.limit, (last) => [
+        last.requisition.date,
+        last.requisition.id,
+        last.line.lineNo,
+      ]);
+      const lines = await withVariants(
+        tx,
+        page.items.map((row) => ({ ...row, variantId: row.line.variantId })),
+      );
+      return {
+        items: lines.map(({ row, variant }) => ({
+          ...toLine(row.line, variant, row.orderedQuantity),
+          requisition: row.requisition,
+          remainingQuantity: subtractQuantity(row.line.baseQuantity, row.orderedQuantity),
+        })),
+        nextCursor: page.nextCursor,
+      };
+    });
+  }
+
   create(input: RequisitionInput): Promise<Requisition> {
     return this.withTenant(async (tx) => {
       await assertWarehouse(tx, input.warehouseId);
@@ -255,7 +418,8 @@ export class RequisitionsService {
   }
 
   // Pending: taken back to change it. Approved: changed after all, then approved again from the
-  // first level (decision 6). 17b refuses it once a purchase order was made from it.
+  // first level (decision 6). Step 17b: refused once a purchase order buys for it, even a draft one
+  // (decision 27): reopening writes its lines again, and the order's lines would lose their link.
   reopen(id: string, version: number): Promise<Requisition> {
     return this.withTenant(async (tx) => {
       const row = await this.lock(tx, id, version);
@@ -266,12 +430,14 @@ export class RequisitionsService {
           'Only a pending or approved requisition can be reopened.',
         );
       }
+      if (row.status === 'approved' && (await this.isOrdered(tx, id))) throw closeInstead();
       await this.approvals.reopen(tx, 'requisition', id, row.status);
       return this.read(tx, id);
     });
   }
 
   // Will not be bought. A pending one is reopened first: someone may be deciding it right now.
+  // Step 17b: once an order buys for it, some of it is being bought, so it is closed instead.
   cancel(id: string, version: number): Promise<Requisition> {
     return this.withTenant(async (tx) => {
       const row = await this.lock(tx, id, version);
@@ -282,6 +448,7 @@ export class RequisitionsService {
           'Only a draft or approved requisition can be cancelled. Reopen a pending one first.',
         );
       }
+      if (row.status === 'approved' && (await this.isOrdered(tx, id))) throw closeInstead();
       await tx
         .update(requisitions)
         .set({
@@ -300,6 +467,112 @@ export class RequisitionsService {
     });
   }
 
+  // Step 17b (decision 17): partly ordered, and the rest will not be. It leaves the lines still to
+  // order; the orders already written go on. Closed is final.
+  close(id: string, version: number): Promise<Requisition> {
+    return this.withTenant(async (tx) => {
+      const row = await this.lock(tx, id, version);
+      if (row.status !== 'approved') {
+        throw new AppError(
+          409,
+          'purchase_not_approved',
+          'Only an approved requisition can be closed.',
+        );
+      }
+      if (!(await this.isOrdered(tx, id))) {
+        throw new AppError(
+          409,
+          'purchase_cancel_instead',
+          'No purchase order buys for this requisition. Cancel it instead.',
+        );
+      }
+      await tx
+        .update(requisitions)
+        .set({
+          status: 'closed',
+          version: sql`${requisitions.version} + 1`,
+          updatedBy: currentPrincipal().userId,
+        })
+        .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
+      await audit(tx, {
+        action: 'requisition.closed',
+        entityType: 'requisition',
+        entityId: id,
+        changes: diff({ status: row.status }, { status: 'closed' }),
+      });
+      return this.read(tx, id);
+    });
+  }
+
+  // An order that is not cancelled buys for one of its lines (migration 0038's function, the same
+  // question its guard asks). Asked after lock(): a purchase order line written at the same moment
+  // locks the requisition FOR SHARE, so it either committed before our FOR UPDATE (and is counted
+  // here) or waits for us and then finds the requisition changed.
+  private async isOrdered(tx: Transaction, id: string): Promise<boolean> {
+    const [row] = z
+      .array(z.object({ ordered: z.boolean() }))
+      .parse(
+        await tx.execute(
+          sql`SELECT requisition_is_ordered(${getTenantId()}::uuid, ${id}::uuid) AS ordered`,
+        ),
+      );
+    return row?.ordered === true;
+  }
+
+  // What each line of it was ordered, in the base unit (orderedOf)
+  private async orderedQuantities(
+    tx: Transaction,
+    requisitionId: string,
+  ): Promise<Map<string, string>> {
+    const rows = await tx
+      .select({
+        id: requisitionLines.id,
+        ordered: sql<string>`round(${orderedOf('requisition_lines')}, 4)::text`,
+      })
+      .from(requisitionLines)
+      .where(
+        and(
+          eq(requisitionLines.tenantId, getTenantId()),
+          eq(requisitionLines.requisitionId, requisitionId),
+        ),
+      );
+    return new Map(rows.map((row) => [row.id, row.ordered]));
+  }
+
+  // The orders that buy for it, by number; a cancelled one bought nothing. A draft that was never
+  // submitted has no number yet (null).
+  private ordersOf(tx: Transaction, requisitionId: string) {
+    return tx
+      .selectDistinct({ id: purchaseOrders.id, number: purchaseOrders.number })
+      .from(purchaseOrderLines)
+      .innerJoin(
+        purchaseOrders,
+        and(
+          eq(purchaseOrders.tenantId, purchaseOrderLines.tenantId),
+          eq(purchaseOrders.id, purchaseOrderLines.orderId),
+        ),
+      )
+      .where(
+        and(
+          eq(purchaseOrderLines.tenantId, getTenantId()),
+          inArray(
+            purchaseOrderLines.requisitionLineId,
+            tx
+              .select({ id: requisitionLines.id })
+              .from(requisitionLines)
+              .where(
+                and(
+                  eq(requisitionLines.tenantId, getTenantId()),
+                  eq(requisitionLines.requisitionId, requisitionId),
+                ),
+              ),
+          ),
+          ne(purchaseOrders.status, 'cancelled'),
+        ),
+      )
+      .orderBy(asc(purchaseOrders.number), asc(purchaseOrders.id));
+  }
+
   private async resolveLines(
     tx: Transaction,
     lines: RequisitionInput['lines'],
@@ -387,7 +660,7 @@ export class RequisitionsService {
   // The requisitions with who asked and their line counts, newest date first
   private rows(tx: Transaction, where: SQL | undefined, limit: number) {
     return tx
-      .select({ requisition: requisitions, requestedByName: users.fullName, lineCount })
+      .select({ requisition: requisitions, requestedByName: users.fullName, lineCount, orderState })
       .from(requisitions)
       .innerJoin(users, eq(users.id, requisitions.requestedBy))
       .where(and(eq(requisitions.tenantId, getTenantId()), where))
@@ -400,28 +673,38 @@ export class RequisitionsService {
     if (!found) throw notFound('Requisition');
     const { requisition: row } = found;
     const lines = await withVariants(tx, await this.linesOf(tx, id));
+    const ordered = await this.orderedQuantities(tx, id);
     return {
-      ...toSummary(row, found.requestedByName, found.lineCount),
+      ...toSummary(row, found.requestedByName, found.lineCount, found.orderState),
       note: row.note,
-      lines: lines.map(({ row: line, variant }) => ({
-        id: line.id,
-        variantId: variant.variantId,
-        productId: variant.productId,
-        productCode: variant.productCode,
-        productName: variant.productName,
-        optionValues: variant.optionValues,
-        sku: variant.sku,
-        baseUnitId: variant.baseUnitId,
-        productType: variant.type,
-        units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
-        unitId: line.unitId,
-        quantity: line.quantity,
-        baseQuantity: line.baseQuantity,
-        description: line.description,
-        estimatedCost: line.estimatedCost,
-        amount: line.amount,
-      })),
+      lines: lines.map(({ row: line, variant }) =>
+        toLine(line, variant, ordered.get(line.id) ?? '0.0000'),
+      ),
       approval: await this.approvals.history(tx, 'requisition', id),
+      orders: await this.ordersOf(tx, id),
     };
   }
 }
+
+// A stored line with its variant, as the API sends it
+function toLine(line: LineRow, variant: VariantInfo, orderedQuantity: string): RequisitionLine {
+  return {
+    id: line.id,
+    variantId: variant.variantId,
+    productId: variant.productId,
+    productCode: variant.productCode,
+    productName: variant.productName,
+    optionValues: variant.optionValues,
+    sku: variant.sku,
+    baseUnitId: variant.baseUnitId,
+    productType: variant.type,
+    units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
+    unitId: line.unitId,
+    quantity: line.quantity,
+    baseQuantity: line.baseQuantity,
+    description: line.description,
+    estimatedCost: line.estimatedCost,
+    amount: line.amount,
+    orderedQuantity,
+  };
+}
```

- **`orderedOf()` counts, it never stores** (decisions 16 and 26): all of an order line while its order is open or
  received, what came in once it is closed, nothing once it is cancelled. A service line on a closed order counts in
  full: it is never received, and it was bought. The function takes the outer query's name for the requisition
  line, because the same subquery serves a line (`requisition_lines`) and a requisition's lines (`rl`).
- **`orderState`** is worked out in the same query as the list: `not_ordered` for anything but approved and closed,
  else from two `EXISTS` (some line ordered, some line still short). A closed requisition shows "Partly ordered" with
  its closed status: both are true.
- **`openLines()` is the order form's list** (decision 18): lines of approved requisitions of one warehouse with
  something still to order, oldest requisition first, searchable by the requisition's number and the product's name,
  code and SKU (`containsPattern()` of step 12, which takes `%` and `_` as typed). The cursor is (date, requisition, line), so two
  requisitions of one day never mix their lines. A closed requisition is left out: the rest will not be bought.
- **`remainingQuantity`** is the line less what was ordered, in the base unit. The form turns it into the unit the
  buyer picks.
- **`reopen()` and `cancel()` refuse an ordered requisition** with `purchase_close_instead` (decision 17).
  `isOrdered()` asks migration 0038's own function, so the API and the guard ask one question. It runs after
  `lock()`: an order line written at the same moment locks the requisition `FOR SHARE`, so either it committed before
  our `FOR UPDATE` and is counted, or it waits for us and then finds the requisition changed.
- **`close()`** needs an approved requisition (`purchase_not_approved`) that an order buys for
  (`purchase_cancel_instead` otherwise): nothing ordered is a cancel, not a close. The audit row is
  `requisition.closed`.
- **`orders`** on the page: the orders that buy for it, cancelled ones left out. A draft nobody submitted has no
  number yet; the page shows it as a draft.
- **`toLine()`** moved out of `read()` because `openLines()` sends the same line shape.

### Purchase orders: `purchase/purchase-orders.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  documentTotals,
  type PartyRef,
  type PurchaseOrder,
  type PurchaseOrderInput,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
  type UpdatePurchaseOrderInput,
} from '@omnivo/contracts';
import {
  goodsReceipts,
  parties,
  purchaseOrderLines,
  purchaseOrders,
  requisitionLines,
  requisitions,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type LineIssue, linePath, linesError } from '../inventory/stock-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  customerRefs,
  type ResolvedSalesLine,
  salesLineValues,
  toSalesLine,
  withVariants,
} from '../sales/sales-lines.js';
import { ApprovalsService } from './approvals.service.js';
import { assertSupplier, assertWarehouse, resolvePurchaseLines } from './purchase-lines.js';

type OrderRow = typeof purchaseOrders.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside these subqueries a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM purchase_order_lines l
   WHERE l.tenant_id = purchase_orders.tenant_id AND l.order_id = purchase_orders.id
)`;

// Approved, and a posted goods receipt brought something in. All of it would be "received".
const partlyReceived = sql<boolean>`(purchase_orders.status = 'approved' AND EXISTS (
  SELECT 1 FROM purchase_order_lines l
   WHERE l.tenant_id = purchase_orders.tenant_id AND l.order_id = purchase_orders.id
     AND l.received_quantity > 0
))`;

// The goods receipt form's orders: approved, with a goods line that has not all come in. An order
// of services only is never received (the bill takes it, 17c), so it is not offered.
const goodsToReceive = sql`EXISTS (
  SELECT 1 FROM purchase_order_lines l
    JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
   WHERE l.tenant_id = purchase_orders.tenant_id AND l.order_id = purchase_orders.id
     AND p.type = 'goods' AND l.received_quantity < l.base_quantity
)`;

function receiptFilter(filter: PurchaseOrderReceiptFilter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  return and(eq(purchaseOrders.status, 'approved'), goodsToReceive);
}

function notDraft(): AppError {
  return new AppError(
    409,
    'purchase_not_draft',
    'This order was submitted. Reopen it to change it, if nothing was received.',
  );
}

function wasSubmitted(): AppError {
  return new AppError(
    409,
    'purchase_was_submitted',
    'This order was submitted once, so its number and approval history stay. Cancel it instead.',
  );
}

function notApproved(): AppError {
  return new AppError(409, 'purchase_not_approved', 'This order is not approved.');
}

function toSummary(
  row: OrderRow,
  supplier: PartyRef,
  lines: number,
  partly: boolean,
): PurchaseOrderSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    expectedDate: row.expectedDate,
    supplier,
    supplierReference: row.supplierReference,
    warehouseId: row.warehouseId,
    status: row.status,
    partlyReceived: partly,
    net: row.net,
    vat: row.vat,
    total: row.total,
    lineCount: lines,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Purchase orders (step 17b): what the company asks a supplier to deliver, at what price. A draft
// is changed freely; submitting numbers it and hands it to the approvals engine (17a), which moves
// its status like a requisition's. Goods receipts (GoodsReceiptsService) bring it in, and the last
// one that completes it sets it received. It moves no stock and posts nothing itself.
@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: PurchaseOrderStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    receipt?: PurchaseOrderReceiptFilter | undefined;
  }): Promise<{ items: PurchaseOrderSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(purchaseOrders.status, query.status),
          query.supplierId === undefined
            ? undefined
            : eq(purchaseOrders.supplierId, query.supplierId),
          query.warehouseId === undefined
            ? undefined
            : eq(purchaseOrders.warehouseId, query.warehouseId),
          receiptFilter(query.receipt),
          after === undefined
            ? undefined
            : sql`(${purchaseOrders.date}, ${purchaseOrders.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.order.date, last.order.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.order, row.supplier, row.lineCount, row.partlyReceived),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<PurchaseOrder> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: PurchaseOrderInput): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const supplier = await assertSupplier(tx, input.supplierId);
      await assertWarehouse(tx, input.warehouseId);
      // The order's own setting (decision 15), not the workspace's: that one is about selling
      const lines = await resolvePurchaseLines(tx, input.lines, input.pricesIncludeVat);
      const links = await this.checkRequisitionLines(tx, input, lines, new Set());
      const userId = currentPrincipal().userId;
      const [row] = await tx
        .insert(purchaseOrders)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          expectedDate: input.expectedDate,
          supplierId: supplier.id,
          supplierReference: input.supplierReference,
          warehouseId: input.warehouseId,
          paymentTermsDays: input.paymentTermsDays,
          pricesIncludeVat: input.pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      if (!row) throw new Error('Purchase order insert returned no row');
      await this.insertLines(tx, row.id, lines, links);
      await audit(tx, {
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, supplier, lines.length)),
      });
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdatePurchaseOrderInput): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const supplierBefore = await this.supplierOf(tx, before.supplierId);
      const supplier = await assertSupplier(tx, input.supplierId, before.supplierId);
      // Once numbered, the number was given to this supplier (on the PDF, in an email): a reopened
      // order keeps its supplier, like a reopened sales order keeps its customer
      if (before.number !== null && supplier.id !== before.supplierId) {
        throw new AppError(
          409,
          'purchase_supplier_invalid',
          'This order was sent to its supplier. Write a new order for another one.',
          { fieldErrors: { supplierId: ['purchase_supplier_invalid'] } },
        );
      }
      await assertWarehouse(tx, input.warehouseId, before.warehouseId);
      const lines = await resolvePurchaseLines(
        tx,
        input.lines,
        input.pricesIncludeVat,
        new Set(linesBefore.map((line) => line.taxRateId)),
      );
      const links = await this.checkRequisitionLines(
        tx,
        input,
        lines,
        new Set(linesBefore.flatMap((line) => line.requisitionLineId ?? [])),
      );
      // The old lines first: migration 0038 refuses a new warehouse while a line buys for a
      // requisition of the old one, and the new lines are checked against the new warehouse
      await this.deleteLines(tx, id);
      const [updated] = await tx
        .update(purchaseOrders)
        .set({
          date: input.date,
          expectedDate: input.expectedDate,
          supplierId: supplier.id,
          supplierReference: input.supplierReference,
          warehouseId: input.warehouseId,
          paymentTermsDays: input.paymentTermsDays,
          pricesIncludeVat: input.pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          version: sql`${purchaseOrders.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)))
        .returning();
      if (!updated) throw notFound('Purchase order');
      await this.insertLines(tx, id, lines, links);
      await audit(tx, {
        action: 'purchase_order.updated',
        entityType: 'purchase_order',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, supplierBefore, linesBefore.length),
          await this.snapshot(tx, updated, supplier, lines.length),
        ),
      });
      return this.read(tx, id);
    });
  }

  // Only a draft that was never submitted (decision 13): it has no number and no approval history,
  // so deleting it leaves no gap. Once numbered it is cancelled instead.
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, version);
        if (before.number !== null) throw wasSubmitted();
        const lines = await this.linesOf(tx, id);
        const supplier = await this.supplierOf(tx, before.supplierId);
        // The lines go with it (ON DELETE CASCADE)
        await tx
          .delete(purchaseOrders)
          .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
        const snapshot = await this.snapshot(tx, before, supplier, lines.length);
        await audit(tx, {
          action: 'purchase_order.deleted',
          entityType: 'purchase_order',
          entityId: id,
          changes: diff(
            snapshot,
            Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
          ),
        });
      });
    } catch (error) {
      // The database's own rule (0038), should a submit commit between our check and the delete
      if (isCheckViolation(error, 'purchase_orders_submitted_immutable')) throw wasSubmitted();
      throw error;
    }
  }

  // Numbered the first time (decision 13), then sent for approval with its total, VAT included
  // (decision 14). A supplier or warehouse archived while it was a draft stops it here: a draft may
  // keep one, but an order is not sent to a supplier the company stopped buying from.
  submit(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lockDraft(tx, id, version);
      await assertSupplier(tx, row.supplierId);
      await assertWarehouse(tx, row.warehouseId);
      // Still a draft here, so migration 0038 lets the number be set. The engine then moves the
      // status; purchase_orders_number_check needs the number by then.
      if (row.number === null) {
        await tx
          .update(purchaseOrders)
          .set({ number: await this.numbering.next(tx, 'purchase.order', row.date) })
          .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
      }
      await this.approvals.submit(tx, 'purchase_order', id, row.total);
      return this.read(tx, id);
    });
  }

  // Pending: taken back to change it. Approved: changed after all, and approved again from the
  // first level (decision 11). Not once a goods receipt points at it, even a draft one (decision
  // 21): its lines would be written again under the receipt's lines.
  reopen(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'pending' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_reopen',
          'Only a pending or approved order can be reopened.',
        );
      }
      await this.assertNoReceipt(tx, id);
      await this.approvals.reopen(tx, 'purchase_order', id, row.status);
      return this.read(tx, id);
    });
  }

  // Partly received, and the rest will not come: the mill delivered 900 of 1,000 m. A draft
  // receipt still waiting cannot be posted after this (decision 30); it is deleted.
  close(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'approved') throw notApproved();
      if ((await this.receiptOf(tx, id, 'posted')) === undefined) {
        throw new AppError(
          409,
          'purchase_cancel_instead',
          'Nothing was received against this order. Cancel it instead.',
        );
      }
      await this.setStatus(tx, id, 'closed');
      await audit(tx, {
        action: 'purchase_order.closed',
        entityType: 'purchase_order',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'closed' }),
      });
      return this.read(tx, id);
    });
  }

  // Will not be bought: a draft that was submitted once, or an approved order before any goods
  // receipt (decision 29). A pending one is reopened first: someone may be deciding it right now.
  cancel(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_cancel',
          'Only a draft or approved order can be cancelled. Reopen a pending one first.',
        );
      }
      if (row.number === null) {
        throw new AppError(
          409,
          'purchase_delete_instead',
          'This order was never submitted. Delete it instead.',
        );
      }
      // Only an approved order can have one: a receipt needs an approved order, and an order with
      // one is never reopened. Asked for a draft too: two indexed queries, and the database asks
      // the same of every cancel.
      await this.assertNoReceipt(tx, id);
      await this.setStatus(tx, id, 'cancelled');
      await audit(tx, {
        action: 'purchase_order.cancelled',
        entityType: 'purchase_order',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'cancelled' }),
      });
      return this.read(tx, id);
    });
  }

  // A posted receipt: some came in, so it is closed, not reopened or cancelled. A draft one: the
  // store keeper deletes it first (decision 21). Asked after lock(): a receipt written at the same
  // moment locks the order FOR SHARE (migration 0038), so it either committed before our FOR
  // UPDATE and is seen here, or waits for us and then finds the order changed.
  private async assertNoReceipt(tx: Transaction, orderId: string): Promise<void> {
    if ((await this.receiptOf(tx, orderId, 'posted')) !== undefined) {
      throw new AppError(
        409,
        'purchase_close_instead',
        'Goods were received against this order. Close it instead.',
      );
    }
    if ((await this.receiptOf(tx, orderId, 'draft')) !== undefined) {
      throw new AppError(
        409,
        'purchase_receipt_draft',
        'A draft goods receipt points at this order. Delete it first.',
      );
    }
  }

  private async receiptOf(tx: Transaction, orderId: string, status: 'draft' | 'posted') {
    const [row] = await tx
      .select({ id: goodsReceipts.id })
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.tenantId, getTenantId()),
          eq(goodsReceipts.orderId, orderId),
          eq(goodsReceipts.status, status),
        ),
      )
      .limit(1);
    return row;
  }

  // The requisition lines the order's lines buy for (decision 16): a line of an approved
  // requisition for this order's warehouse, for the same item, once per order (the contract checks
  // that). A link the draft already had may stay after its requisition was closed: the draft is
  // written again on every save. FOR SHARE on the requisitions: a reopen or a cancel at the same
  // moment waits until we commit, and then sees this order (the database locks them too).
  // Returns each line's link, in line order.
  private async checkRequisitionLines(
    tx: Transaction,
    input: PurchaseOrderInput,
    lines: readonly ResolvedSalesLine[],
    keptIds: ReadonlySet<string>,
  ): Promise<(string | null)[]> {
    const links = input.lines.map((line) => line.requisitionLineId);
    const ids = links.filter((id): id is string => id !== null);
    if (ids.length === 0) return links;
    const rows = await tx
      .select({
        id: requisitionLines.id,
        variantId: requisitionLines.variantId,
        status: requisitions.status,
        warehouseId: requisitions.warehouseId,
      })
      .from(requisitionLines)
      .innerJoin(
        requisitions,
        and(
          eq(requisitions.tenantId, requisitionLines.tenantId),
          eq(requisitions.id, requisitionLines.requisitionId),
        ),
      )
      .where(and(eq(requisitionLines.tenantId, getTenantId()), inArray(requisitionLines.id, ids)))
      .for('share', { of: requisitions });
    const found = new Map(rows.map((row) => [row.id, row]));
    const issues: LineIssue[] = [];
    links.forEach((id, index) => {
      if (id === null) return;
      const row = found.get(id);
      const open = row?.status === 'approved' || (row?.status === 'closed' && keptIds.has(row.id));
      if (
        row === undefined ||
        !open ||
        row.warehouseId !== input.warehouseId ||
        row.variantId !== lines[index]?.variant.variantId
      ) {
        issues.push({
          path: linePath(index, 'requisitionLineId'),
          code: 'purchase_requisition_line_invalid',
        });
      }
    });
    if (issues.length > 0) throw linesError(issues);
    return links;
  }

  private async setStatus(
    tx: Transaction,
    id: string,
    status: 'closed' | 'cancelled',
  ): Promise<void> {
    await tx
      .update(purchaseOrders)
      .set({
        status,
        version: sql`${purchaseOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
  }

  private async deleteLines(tx: Transaction, orderId: string): Promise<void> {
    await tx
      .delete(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.tenantId, getTenantId()),
          eq(purchaseOrderLines.orderId, orderId),
        ),
      );
  }

  // The database lets them in only while the order is a draft (purchase_order_lines_guard)
  private async insertLines(
    tx: Transaction,
    orderId: string,
    lines: readonly ResolvedSalesLine[],
    links: readonly (string | null)[],
  ): Promise<void> {
    await tx.insert(purchaseOrderLines).values(
      lines.map((line, index) => ({
        ...salesLineValues(line, index),
        orderId,
        requisitionLineId: links[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: every change to an order takes turns with the others, with an approval (the engine
  // locks it the same way) and with a goods receipt being written or posted against it
  private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const [row] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)))
      .for('update');
    if (!row) throw notFound('Purchase order');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const row = await this.lock(tx, id, version);
    if (row.status !== 'draft') throw notDraft();
    return row;
  }

  private linesOf(tx: Transaction, orderId: string) {
    return tx
      .select()
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.tenantId, getTenantId()),
          eq(purchaseOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(purchaseOrderLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        order: purchaseOrders,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
        partlyReceived,
      })
      .from(purchaseOrders)
      .innerJoin(
        parties,
        and(
          eq(parties.tenantId, purchaseOrders.tenantId),
          eq(parties.id, purchaseOrders.supplierId),
        ),
      )
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), where))
      .orderBy(desc(purchaseOrders.date), desc(purchaseOrders.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<PurchaseOrder> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(purchaseOrders.id, id), 1);
    if (!found) throw notFound('Purchase order');
    const { order: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    // The requisition each line buys for, with the requisition's number for the page's link
    const linked = await tx
      .select({
        id: requisitionLines.id,
        requisitionId: requisitions.id,
        number: requisitions.number,
      })
      .from(requisitionLines)
      .innerJoin(
        requisitions,
        and(
          eq(requisitions.tenantId, requisitionLines.tenantId),
          eq(requisitions.id, requisitionLines.requisitionId),
        ),
      )
      .where(
        and(
          eq(requisitionLines.tenantId, tenantId),
          inArray(
            requisitionLines.id,
            tx
              .select({ id: purchaseOrderLines.requisitionLineId })
              .from(purchaseOrderLines)
              .where(
                and(
                  eq(purchaseOrderLines.tenantId, tenantId),
                  eq(purchaseOrderLines.orderId, id),
                  isNotNull(purchaseOrderLines.requisitionLineId),
                ),
              ),
          ),
        ),
      );
    const links = new Map(linked.map((link) => [link.id, link]));
    const requisitionRefs = [
      ...new Map(
        linked.map((link) => [link.requisitionId, { id: link.requisitionId, number: link.number }]),
      ).values(),
    ].sort((a, b) => a.number.localeCompare(b.number));
    const receipts = await tx
      .select({
        id: goodsReceipts.id,
        number: goodsReceipts.number,
        date: goodsReceipts.date,
        status: goodsReceipts.status,
      })
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.tenantId, tenantId), eq(goodsReceipts.orderId, id)))
      .orderBy(asc(goodsReceipts.date), asc(goodsReceipts.id));
    return {
      ...toSummary(row, found.supplier, found.lineCount, found.partlyReceived),
      paymentTermsDays: row.paymentTermsDays,
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => ({
        ...toSalesLine(line, variant),
        requisitionLine:
          line.requisitionLineId === null ? null : (links.get(line.requisitionLineId) ?? null),
        receivedQuantity: line.receivedQuantity,
        rejectedQuantity: line.rejectedQuantity,
      })),
      requisitions: requisitionRefs,
      receipts,
      approval: await this.approvals.history(tx, 'purchase_order', id),
    };
  }

  // customerRefs() reads any party by id: here, the order's supplier
  private async supplierOf(tx: Transaction, supplierId: string): Promise<PartyRef> {
    const supplier = (await customerRefs(tx, [supplierId])).get(supplierId);
    if (!supplier) throw new Error(`Supplier ${supplierId} is missing`);
    return supplier;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: OrderRow, supplier: PartyRef, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      number: row.number,
      date: row.date,
      expectedDate: row.expectedDate,
      supplier: supplier.code,
      supplierReference: row.supplierReference,
      warehouse: warehouse?.code ?? null,
      paymentTermsDays: row.paymentTermsDays,
      pricesIncludeVat: row.pricesIncludeVat,
      total: row.total,
      lines,
    };
  }
}
```

The service reads like step 15b's sales orders with 17a's approval in place of "Confirm". The parts that differ:

- **`partlyReceived`** is the sales order's `partlyDelivered`: approved, and a posted receipt brought something.
  An order that got everything is `received`, so "some" here always means "not all".
- **`receipt: 'to_receive'`** is what the goods receipt form offers: approved, with a goods line still short. An
  order of services only is never received (17c's bill takes it), so it is not offered.
- **The order's own `pricesIncludeVat`** goes to `resolvePurchaseLines()` (decision 15), never the workspace's
  setting: that one is about the prices the company sells at.
- **`update()` deletes the old lines before it writes the header.** Migration 0038 refuses a new warehouse while a
  line buys for a requisition of the old one, and checks each new line against the order's warehouse. So: old lines
  out, header in, new lines in. The other order would fail every time a buyer changed the warehouse of a draft made
  from a requisition, even when the new lines no longer point there.
- **A numbered order keeps its supplier** (decision 33), with `purchase_supplier_invalid` under the supplier box.
- **`checkRequisitionLines()`** gives the form's answer (`purchase_requisition_line_invalid` under the line) for what
  the database would refuse with a constraint name: the requisition approved, for this warehouse, for the same item.
  A link the draft already had may stay after its requisition was closed, because a draft is written again on every
  save. The requisitions are locked `FOR SHARE`, the same lock the database's guard takes, so a reopen or a cancel at
  the same moment waits and then sees this order.
- **`remove()`** deletes only an order without a number (decision 13). A draft with a number was submitted once, so
  its approval history stays. The catch is for a submit that commits between our check and the delete.
- **`submit()` numbers the order while it is still a draft,** in its own `UPDATE`: migration 0038 lets a draft
  change freely, and `purchase_orders_number_check` needs the number before the engine moves the status to pending.
  A reopened order keeps the number it has. The total, VAT included, chooses the levels (decision 14). The supplier
  and the warehouse are checked again without `keptId` (decision 34).
- **`reopen()` and `cancel()`** refuse an order with a posted receipt (`purchase_close_instead`) or a draft one
  (`purchase_receipt_draft`: delete it first), decision 21 and 29. A cancel of a draft nobody submitted is
  `purchase_delete_instead`. A pending order is reopened first, like a requisition: someone may be deciding it.
- **`close()`** needs a posted receipt; without one the order is cancelled instead. A draft receipt still waiting
  cannot be posted afterwards (decision 30): the store keeper deletes it.
- **`read()`** sends each line's requisition with its number (for the link), the requisitions by number, the receipts
  in date order and the approval history, all in one transaction, so the page shows one moment.

### Goods receipts: `purchase/goods-receipts.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type ErrorCode,
  fitsDecimals,
  type GoodsReceipt,
  type GoodsReceiptInput,
  type GoodsReceiptLineInput,
  type GoodsReceiptSummary,
  isQuantity,
  isWholeQuantity,
  isZeroQuantity,
  type PartyRef,
  prorateMoney,
  type StockDocumentStatus,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  type UpdateGoodsReceiptInput,
  wholeCount,
  withTolerance,
} from '@omnivo/contracts';
import {
  goodsReceiptLines,
  goodsReceipts,
  parties,
  products,
  purchaseOrderLines,
  purchaseOrders,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
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
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type ResolvedLine,
  toStockLine,
} from '../inventory/stock-lines.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { StockPostingService } from '../inventory/stock-posting.service.js';
import { ValueAccess } from '../inventory/value-access.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { customerRefs } from '../sales/sales-lines.js';

type ReceiptRow = typeof goodsReceipts.$inferSelect;
type LineRow = typeof goodsReceiptLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM goods_receipt_lines l
   WHERE l.tenant_id = goods_receipts.tenant_id AND l.receipt_id = goods_receipts.id
)`;

// A receipt line as resolveReceiptLines() takes it: the form's line, or a stored one again
type ReceiptLineInput = Pick<
  GoodsReceiptLineInput,
  | 'variantId'
  | 'unitId'
  | 'quantity'
  | 'serialNumbers'
  | 'lotNumber'
  | 'expiresOn'
  | 'manufacturedOn'
  | 'orderLineId'
  | 'rejectedQuantity'
  | 'rejectionReason'
>;

// A line checked against its product. `accepted` is a stock line like any other (decision 20),
// with a base quantity of zero when everything was turned back; `rejected` is in the same unit.
interface ReceiptLine {
  accepted: ResolvedLine;
  orderLineId: string;
  rejectedQuantity: string;
  rejectedBaseQuantity: string;
  rejectionReason: string | null;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. Goods that go back after a posted receipt are a purchase return.',
  );
}

function toSummary(
  row: ReceiptRow,
  supplier: PartyRef,
  order: { id: string; number: string | null },
  lines: number,
): GoodsReceiptSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    supplier,
    order,
    warehouseId: row.warehouseId,
    status: row.status,
    supplierChallan: row.supplierChallan,
    vehicle: row.vehicle,
    note: row.note,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A stored line as resolveReceiptLines() takes it, to check it again when the draft is posted
function storedInput(line: LineRow): ReceiptLineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    serialNumbers: line.serialNumbers,
    lotNumber: line.lotNumber,
    expiresOn: line.expiresOn,
    manufacturedOn: line.manufacturedOn,
    orderLineId: line.orderLineId,
    rejectedQuantity: line.rejectedQuantity,
    rejectionReason: line.rejectionReason,
  };
}

// Every rule of a receipt line that does not depend on the order: like resolveLines() of the stock
// documents for an "in" line, with two differences. The accepted quantity may be zero (everything
// that came was turned back), and then nothing comes in: no lot, no serial numbers. The rejected
// quantity is checked against the same unit. lock: FOR SHARE on the products while posting, as
// resolveLines() does.
async function resolveReceiptLines(
  tx: Transaction,
  lines: readonly ReceiptLineInput[],
  { lock = false }: { lock?: boolean } = {},
): Promise<ReceiptLine[]> {
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
    { lock },
  );
  const issues: LineIssue[] = [];
  const resolved = lines.map((line, index): ReceiptLine | null => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
      return null;
    };
    const variant = variants.get(line.variantId);
    // Goods only: a service on the order is never received. Archived: nothing new comes in.
    if (variant?.type !== 'goods' || variant.archived)
      return at('variantId', 'stock_variant_invalid');
    const unit =
      line.unitId === variant.baseUnitId
        ? { factor: '1', decimals: variant.baseDecimals }
        : variant.units.find((pack) => pack.unitId === line.unitId);
    if (unit === undefined) return at('unitId', 'stock_unit_invalid');
    // In the base unit, rounded to its decimals; zero stays zero. A quantity that rounds to
    // nothing (0.001 of a yard in whole metres) is a typing mistake.
    const inBase = (quantity: string, field: string): string | null => {
      if (isZeroQuantity(quantity)) return '0';
      if (!fitsDecimals(quantity, unit.decimals)) return at(field, 'stock_quantity_decimals');
      const base = toBaseQuantity(quantity, unit.factor, variant.baseDecimals);
      return isQuantity(base) ? base : at(field, 'quantity_format');
    };
    const baseQuantity = inBase(line.quantity, 'quantity');
    const rejectedBaseQuantity = inBase(line.rejectedQuantity, 'rejectedQuantity');
    if (baseQuantity === null || rejectedBaseQuantity === null) return null;
    const accepting = !isZeroQuantity(baseQuantity);

    // The lot of what came in. More of a known lot takes its expiry; a new lot of a product with
    // expiry dates needs one (StockPostingService.resolveBatches, when posted).
    const lotNumber = variant.tracking === 'batch' && accepting ? line.lotNumber : null;
    if (variant.tracking === 'batch' && accepting && lotNumber === null) {
      return at('lotNumber', 'stock_lot_required');
    }
    // One serial number per base unit accepted: 3 phones came in, 3 IMEIs. A rejected phone does
    // not come in, so its IMEI is not recorded.
    const serialNumbers = variant.tracking === 'serial' ? line.serialNumbers : [];
    if (
      variant.tracking === 'serial' &&
      (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== serialNumbers.length)
    ) {
      return at('serialNumbers', 'stock_serial_count');
    }
    return {
      accepted: {
        variant,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: unit.factor,
        baseQuantity,
        batchId: null,
        lotNumber,
        expiresOn: lotNumber === null ? null : line.expiresOn,
        manufacturedOn: lotNumber === null ? null : line.manufacturedOn,
        serialNumbers,
      },
      orderLineId: line.orderLineId,
      rejectedQuantity: line.rejectedQuantity,
      rejectedBaseQuantity,
      // The database keeps a reason only for what was turned back (decision 20)
      rejectionReason: isZeroQuantity(rejectedBaseQuantity) ? null : line.rejectionReason,
    };
  });
  if (issues.length > 0) throw linesError(issues);
  return resolved.flatMap((line) => (line === null ? [] : [line]));
}

// The order a receipt takes goods against, as far as the receipt needs it
interface OrderInfo {
  id: string;
  number: string | null;
  supplierId: string;
}

// An order line, as the receipt checks and values it
interface OrderLineInfo {
  id: string;
  variantId: string;
  baseQuantity: string;
  receivedQuantity: string;
  net: string;
}

// Goods receipts (GRN, step 17b): what a supplier's truck brought in against an approved purchase
// order. Like a delivery the other way round: a draft is changed freely; posting numbers it, brings
// the accepted goods into stock at the order's price, books them (Dr Inventory / Cr Goods received
// not billed) and counts them on the order's lines. All in one transaction.
@Injectable()
export class GoodsReceiptsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
    private readonly books: StockBooksService,
    private readonly access: ValueAccess,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: StockDocumentStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    orderId?: string | undefined;
  }): Promise<{ items: GoodsReceiptSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(goodsReceipts.status, query.status),
          query.supplierId === undefined
            ? undefined
            : eq(goodsReceipts.supplierId, query.supplierId),
          query.warehouseId === undefined
            ? undefined
            : eq(goodsReceipts.warehouseId, query.warehouseId),
          query.orderId === undefined ? undefined : eq(goodsReceipts.orderId, query.orderId),
          after === undefined
            ? undefined
            : sql`(${goodsReceipts.date}, ${goodsReceipts.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.receipt.date, last.receipt.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.receipt, row.supplier, row.order, row.lineCount),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<GoodsReceipt> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: GoodsReceiptInput): Promise<GoodsReceipt> {
    return this.withTenant(async (tx) => {
      const order = await this.lockOrder(tx, input.orderId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveReceiptLines(tx, input.lines);
      await this.checkOrderLines(tx, order.id, lines);
      const [row] = await tx
        .insert(goodsReceipts)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          // The order's supplier, never one the form sends (goods_receipts_order_fk holds both)
          supplierId: order.supplierId,
          orderId: order.id,
          warehouseId: input.warehouseId,
          supplierChallan: input.supplierChallan,
          vehicle: input.vehicle,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Goods receipt insert returned no row');
      await this.writeLines(tx, row, lines);
      await audit(tx, {
        action: 'goods_receipt.created',
        entityType: 'goods_receipt',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, order, lines.length)),
      });
      if (input.post) await this.postAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  // A receipt keeps its order (decision 20): the edit form does not send it
  update(id: string, input: UpdateGoodsReceiptInput): Promise<GoodsReceipt> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const order = await this.lockOrder(tx, before.orderId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveReceiptLines(tx, input.lines);
      await this.checkOrderLines(tx, order.id, lines);
      const [updated] = await tx
        .update(goodsReceipts)
        .set({
          date: input.date,
          warehouseId: input.warehouseId,
          supplierChallan: input.supplierChallan,
          vehicle: input.vehicle,
          note: input.note,
          version: sql`${goodsReceipts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, id)))
        .returning();
      if (!updated) throw notFound('Goods receipt');
      await this.writeLines(tx, updated, lines);
      await audit(tx, {
        action: 'goods_receipt.updated',
        entityType: 'goods_receipt',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, order, linesBefore.length),
          await this.snapshot(tx, updated, order, lines.length),
        ),
      });
      if (input.post) await this.postAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  // A draft, even one of an order that was closed since (decision 30): it brought nothing in
  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const order = await this.orderRef(tx, before.orderId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(goodsReceipts)
        .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, id)));
      const snapshot = await this.snapshot(tx, before, order, lines.length);
      await audit(tx, {
        action: 'goods_receipt.deleted',
        entityType: 'goods_receipt',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  post(id: string, version: number): Promise<GoodsReceipt> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // A draft into stock: the date and the warehouse checked, the order locked and still approved,
  // the lines checked again against their products and against what the order still takes, the
  // number taken, the accepted goods moved in at the order's price, the order's lines counted and
  // the entry booked. In the caller's transaction: a refused line leaves nothing posted and no
  // number used.
  private async postAndLog(tx: Transaction, draft: ReceiptRow): Promise<void> {
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    // Locked before anything moves: two receipts of one order post one after the other, and the
    // second sees what the first brought in. A reopen, close or cancel waits for us too.
    const order = await this.lockOrder(tx, draft.orderId);
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveReceiptLines(tx, stored.map(storedInput), { lock: true });
    const orderLines = await this.checkOrderLines(tx, order.id, lines);

    const number = await this.numbering.next(tx, 'inventory.receipt', draft.date);
    // Every line, so the errors name the person's own lines: a line that accepted nothing has no
    // lot, and gets no batch
    const batchIds = await this.posting.resolveBatches(
      tx,
      lines.map((line) => line.accepted),
    );
    // At the order's price (decision 2): the line's net, after its discount and before VAT
    // (decision 6), shared by what came in. 600 m of an order line of 1,000 m worth ৳3,12,500 is
    // worth ৳1,87,500; what came over the order is worth the same per metre (decision 7).
    const values = lines.map((line) => {
      const orderLine = orderLines.get(line.orderLineId);
      if (!orderLine) throw new Error(`Order line ${line.orderLineId} is missing`);
      return prorateMoney(orderLine.net, line.accepted.baseQuantity, orderLine.baseQuantity);
    });
    // Only what was accepted comes in. A line that turned everything back moves nothing.
    await this.posting.post(tx, {
      date: draft.date,
      kind: 'purchase_receipt',
      direction: 'in',
      documentId: draft.id,
      documentNumber: number,
      moves: lines.flatMap((line, index) =>
        isZeroQuantity(line.accepted.baseQuantity)
          ? []
          : [
              {
                line: index,
                warehouseId: draft.warehouseId,
                variant: line.accepted.variant,
                batchId: batchIds[index] ?? null,
                quantity: line.accepted.baseQuantity,
                serialNumbers: line.accepted.serialNumbers,
                value: values[index] ?? '0',
              },
            ],
      ),
    });
    // Still a draft here: the lines may change, and take their batches and values
    await this.writeLines(
      tx,
      draft,
      lines.map((line, index) => ({
        ...line,
        accepted: { ...line.accepted, batchId: batchIds[index] ?? null },
      })),
      values,
    );
    await tx
      .update(goodsReceipts)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${goodsReceipts.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, draft.id)));
    await this.receiveOnOrder(tx, order.id, lines);
    const entry = await this.books.purchaseReceipt(
      tx,
      { id: draft.id, number, date: draft.date },
      { warehouseId: draft.warehouseId, value: sumMoney(values) },
    );
    await audit(tx, {
      action: 'goods_receipt.posted',
      entityType: 'goods_receipt',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // The order of a receipt: approved (decision 8). FOR UPDATE, in every write of a receipt: a
  // reopen or a cancel of the order waits and then sees the receipt, and two receipts posting
  // against one order take turns. Always taken after the receipt's own lock (lockDraft), never
  // before, so two of these never wait for each other in a circle.
  private async lockOrder(tx: Transaction, orderId: string): Promise<OrderInfo> {
    const [row] = await tx
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        supplierId: purchaseOrders.supplierId,
        status: purchaseOrders.status,
      })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, orderId)))
      .for('update');
    if (!row) {
      throw new AppError(409, 'grn_order_invalid', 'Pick an approved purchase order.', {
        fieldErrors: { orderId: ['grn_order_invalid'] },
      });
    }
    // Reopened, received, closed or cancelled since the page was opened
    if (row.status !== 'approved') {
      throw new AppError(
        409,
        'purchase_not_approved',
        'This order is not waiting for goods any more.',
        { fieldErrors: { orderId: ['purchase_not_approved'] } },
      );
    }
    return { id: row.id, number: row.number, supplierId: row.supplierId };
  }

  // Each line receives a line of this order, for the same variant (in any of its units), and all
  // the lines together never bring in more than the order line still takes: ordered × (100 + the
  // workspace's percent) ÷ 100, less what posted receipts accepted (decisions 7 and 22). Two lines
  // may share an order line (two lots of one fabric). What was rejected does not count: it did not
  // come in. Drafts hold nothing, so two drafts may each take the whole rest; the second one to
  // post is refused here. Returns the order's lines, for the values.
  private async checkOrderLines(
    tx: Transaction,
    orderId: string,
    lines: readonly ReceiptLine[],
  ): Promise<Map<string, OrderLineInfo>> {
    const tenantId = getTenantId();
    const rows = await tx
      .select({
        id: purchaseOrderLines.id,
        variantId: purchaseOrderLines.variantId,
        baseQuantity: purchaseOrderLines.baseQuantity,
        receivedQuantity: purchaseOrderLines.receivedQuantity,
        net: purchaseOrderLines.net,
      })
      .from(purchaseOrderLines)
      .where(
        and(eq(purchaseOrderLines.tenantId, tenantId), eq(purchaseOrderLines.orderId, orderId)),
      );
    const orderLines = new Map(rows.map((row) => [row.id, row]));
    const [settings] = await tx
      .select({ overReceiptPercent: tenantSettings.overReceiptPercent })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);

    const issues: LineIssue[] = [];
    const taken = new Map<string, string[]>();
    lines.forEach((line, index) => {
      const orderLine = orderLines.get(line.orderLineId);
      if (orderLine?.variantId !== line.accepted.variant.variantId) {
        issues.push({ path: linePath(index, 'orderLineId'), code: 'grn_order_line_invalid' });
        return;
      }
      taken.set(line.orderLineId, [
        ...(taken.get(line.orderLineId) ?? []),
        line.accepted.baseQuantity,
      ]);
    });
    for (const [orderLineId, quantities] of taken) {
      const orderLine = orderLines.get(orderLineId);
      if (!orderLine) continue;
      const most = withTolerance(orderLine.baseQuantity, settings.overReceiptPercent);
      const after = sumQuantity([orderLine.receivedQuantity, ...quantities]);
      if (compareQuantity(after, most) <= 0) continue;
      // Under every line that takes from it: the person decides which one to cut
      lines.forEach((line, index) => {
        if (line.orderLineId === orderLineId) {
          issues.push({ path: linePath(index, 'quantity'), code: 'grn_over_order' });
        }
      });
    }
    if (issues.length > 0) throw linesError(issues);
    return orderLines;
  }

  // What the posted lines accepted and turned back, onto their order lines; and when every goods
  // line has all it ordered, the order is received (decision 29). The lines first: migration 0038
  // lets received_quantity change only while the order is approved, and only up. A service line
  // is never received and does not hold the order open.
  private async receiveOnOrder(
    tx: Transaction,
    orderId: string,
    lines: readonly ReceiptLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, { accepted: string[]; rejected: string[] }>();
    for (const line of lines) {
      const sums = byOrderLine.get(line.orderLineId) ?? { accepted: [], rejected: [] };
      sums.accepted.push(line.accepted.baseQuantity);
      sums.rejected.push(line.rejectedBaseQuantity);
      byOrderLine.set(line.orderLineId, sums);
    }
    for (const [orderLineId, sums] of byOrderLine) {
      await tx
        .update(purchaseOrderLines)
        .set({
          receivedQuantity: sql`${purchaseOrderLines.receivedQuantity} + ${sumQuantity(sums.accepted)}::numeric`,
          rejectedQuantity: sql`${purchaseOrderLines.rejectedQuantity} + ${sumQuantity(sums.rejected)}::numeric`,
        })
        .where(
          and(eq(purchaseOrderLines.tenantId, tenantId), eq(purchaseOrderLines.id, orderLineId)),
        );
    }
    const [open] = await tx
      .select({ id: purchaseOrderLines.id })
      .from(purchaseOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, purchaseOrderLines.tenantId),
          eq(products.id, purchaseOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(purchaseOrderLines.tenantId, tenantId),
          eq(purchaseOrderLines.orderId, orderId),
          eq(products.type, 'goods'),
          sql`${purchaseOrderLines.receivedQuantity} < ${purchaseOrderLines.baseQuantity}`,
        ),
      )
      .limit(1);
    // A new version either way: an order page open somewhere shows old received quantities, and
    // its next action (close) must reload first
    await tx
      .update(purchaseOrders)
      .set({
        ...(open === undefined ? { status: 'received' as const } : {}),
        version: sql`${purchaseOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, orderId)));
  }

  // The lines in the order they were written. values: set when posting has priced them. order_id
  // is the receipt's own (decision 31), so the foreign keys can check the order line belongs to it.
  private async writeLines(
    tx: Transaction,
    receipt: ReceiptRow,
    lines: readonly ReceiptLine[],
    values?: readonly string[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(goodsReceiptLines)
      .where(
        and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.receiptId, receipt.id)),
      );
    await tx.insert(goodsReceiptLines).values(
      lines.map((line, index) => ({
        tenantId,
        receiptId: receipt.id,
        orderId: receipt.orderId,
        orderLineId: line.orderLineId,
        lineNo: index + 1,
        productId: line.accepted.variant.productId,
        variantId: line.accepted.variant.variantId,
        unitId: line.accepted.unitId,
        quantity: line.accepted.quantity,
        factor: line.accepted.factor,
        baseQuantity: line.accepted.baseQuantity,
        batchId: line.accepted.batchId,
        serialNumbers: line.accepted.serialNumbers,
        lotNumber: line.accepted.lotNumber,
        expiresOn: line.accepted.expiresOn,
        manufacturedOn: line.accepted.manufacturedOn,
        rejectedQuantity: line.rejectedQuantity,
        rejectedBaseQuantity: line.rejectedBaseQuantity,
        rejectionReason: line.rejectionReason,
        value: values?.[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<ReceiptRow> {
    const [row] = await tx
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, id)))
      .for('update');
    if (!row) throw notFound('Goods receipt');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, receiptId: string) {
    return tx
      .select()
      .from(goodsReceiptLines)
      .where(
        and(
          eq(goodsReceiptLines.tenantId, getTenantId()),
          eq(goodsReceiptLines.receiptId, receiptId),
        ),
      )
      .orderBy(asc(goodsReceiptLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        receipt: goodsReceipts,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        order: { id: purchaseOrders.id, number: purchaseOrders.number },
        lineCount,
      })
      .from(goodsReceipts)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, goodsReceipts.tenantId), eq(parties.id, goodsReceipts.supplierId)),
      )
      .innerJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.tenantId, goodsReceipts.tenantId),
          eq(purchaseOrders.id, goodsReceipts.orderId),
        ),
      )
      .where(and(eq(goodsReceipts.tenantId, getTenantId()), where))
      .orderBy(desc(goodsReceipts.date), desc(goodsReceipts.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<GoodsReceipt> {
    const [found] = await this.rows(tx, eq(goodsReceipts.id, id), 1);
    if (!found) throw notFound('Goods receipt');
    const { receipt: row } = found;
    const lines = await this.linesOf(tx, id);
    const [canSee, entries, variants, batches] = await Promise.all([
      this.access.canSee(),
      this.books.entriesOf(tx, id),
      loadVariants(
        tx,
        lines.map((line) => line.variantId),
      ),
      batchesOf(
        tx,
        lines.map((line) => line.batchId),
      ),
    ]);
    return {
      ...toSummary(row, found.supplier, found.order, found.lineCount),
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        // The FK keeps the variant while a line points at it
        if (!variant) return [];
        return [
          {
            ...toStockLine(
              line,
              variant,
              line.batchId === null ? undefined : batches.get(line.batchId),
            ),
            orderLineId: line.orderLineId,
            rejectedQuantity: line.rejectedQuantity,
            rejectedBaseQuantity: line.rejectedBaseQuantity,
            rejectionReason: line.rejectionReason,
            // The order's price is on the order for everyone; what the stock was booked at is
            // worked out from the books and needs inventory.stock.value (step 14)
            value: canSee ? line.value : null,
          },
        ];
      }),
      entry: entries[0] ?? null,
    };
  }

  private async orderRef(tx: Transaction, orderId: string): Promise<OrderInfo> {
    const [row] = await tx
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        supplierId: purchaseOrders.supplierId,
      })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, orderId)));
    // goods_receipts_order_fk keeps the order while a receipt points at it
    if (!row) throw new Error(`Purchase order ${orderId} of a goods receipt is missing`);
    return row;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: ReceiptRow, order: OrderInfo, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    const supplier = (await customerRefs(tx, [row.supplierId])).get(row.supplierId);
    return {
      date: row.date,
      supplier: supplier?.code ?? null,
      order: order.number,
      warehouse: warehouse?.code ?? null,
      supplierChallan: row.supplierChallan,
      vehicle: row.vehicle,
      lines,
    };
  }
}
```

The service reads like step 15b's deliveries the other way round. The parts that differ:

- **`resolveReceiptLines()` is `resolveLines()` for a receipt line** (decision 38). The accepted quantity may be zero
  when everything was turned back; then nothing comes in, so a batch product needs no lot and a serial product no
  IMEI. The rejected quantity is checked against the same unit and turned into the base unit with the same factor.
  `resolveLines()` could not be reused: it refuses a zero quantity, and it counts serial numbers against the line's
  whole quantity.
- **The reason is dropped when nothing was rejected,** because migration 0038 keeps a reason only beside a rejected
  quantity, and a stale reason would print on the supplier's claim.
- **The supplier comes from the order,** never from the form: `goods_receipts_order_fk` holds the order and its
  supplier together, and the receipt keeps both (decision 20).
- **`lockOrder()` takes the order `FOR UPDATE`, always after the receipt's own lock.** Two receipts of one order post
  one after the other, and the second sees the first's quantities; a reopen or a cancel of the order waits for us
  and then finds the receipt. An order that is no longer approved is `purchase_not_approved` under `orderId`.
- **`checkOrderLines()`** (decision 40): each line receives a line of this order for the same item, and all the lines
  that point at one order line, with what posted receipts accepted, stay within `withTolerance()` of what was
  ordered (17b.1, rounded down). Rejected goods do not count: they did not come in. The error sits under every line
  that takes from the order line, so the person picks which one to cut. It runs on save and again on post: drafts
  hold nothing.
- **`postAndLog()`** keeps the delivery's order: date and warehouse, the order locked, the stored lines checked again
  (with the products locked `FOR SHARE`), the number, the batches, the stock, the lines with their values, the
  receipt posted, the order's lines counted, the entry, the audit row. A refused line leaves nothing posted and no
  number used.
- **`resolveBatches()` gets every line,** not only the ones that accepted something: its errors name lines by their
  place in the list it is given, so a shorter list would put "Enter the expiry date" under the wrong row. A line that
  accepted nothing has no lot and gets no batch.
- **The value is the order line's net, shared by quantity** (decision 39), with `prorateMoney()` to the paisa. A
  quantity over the order gets the same price per unit, so the over-receipt is valued at the order's price
  (decision 7). Each move hands its value to `StockPostingService.post()`, so the moving average (step 14) takes the
  goods in at that price at once (decision 2).
- **`receiveOnOrder()`** adds what was accepted and what was rejected to the order lines, then sets the order
  `received` when no goods line is short; the version moves either way, so an open order page reloads before its
  next action. The lines first: migration 0038 lets `received_quantity` change only while the order is approved.
- **`value` on a line needs `inventory.stock.value`,** like a delivery's: it is what the books say the stock is worth.
  The order's prices are on the order for everyone.

### The controllers and the module

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { GoodsReceiptsService } from './goods-receipts.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

type Routes = typeof routes.purchaseOrders;
type ReceiptRoutes = typeof routes.goodsReceipts;

@Controller()
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Endpoint(routes.purchaseOrders.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.orders.list(query);
  }

  @Endpoint(routes.purchaseOrders.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.orders.get(params.id);
  }

  @Endpoint(routes.purchaseOrders.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.orders.create(body);
  }

  @Endpoint(routes.purchaseOrders.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.orders.update(params.id, body);
  }

  @Endpoint(routes.purchaseOrders.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.orders.remove(params.id, query.version);
  }

  @Endpoint(routes.purchaseOrders.submit)
  submit({ params, body }: RouteInput<Routes['submit']>): Promise<RouteResponse<Routes['submit']>> {
    return this.orders.submit(params.id, body.version);
  }

  @Endpoint(routes.purchaseOrders.reopen)
  reopen({ params, body }: RouteInput<Routes['reopen']>): Promise<RouteResponse<Routes['reopen']>> {
    return this.orders.reopen(params.id, body.version);
  }

  @Endpoint(routes.purchaseOrders.close)
  close({ params, body }: RouteInput<Routes['close']>): Promise<RouteResponse<Routes['close']>> {
    return this.orders.close(params.id, body.version);
  }

  @Endpoint(routes.purchaseOrders.cancel)
  cancel({ params, body }: RouteInput<Routes['cancel']>): Promise<RouteResponse<Routes['cancel']>> {
    return this.orders.cancel(params.id, body.version);
  }
}

@Controller()
export class GoodsReceiptsController {
  constructor(private readonly receipts: GoodsReceiptsService) {}

  @Endpoint(routes.goodsReceipts.list)
  list({
    query,
  }: RouteInput<ReceiptRoutes['list']>): Promise<RouteResponse<ReceiptRoutes['list']>> {
    return this.receipts.list(query);
  }

  @Endpoint(routes.goodsReceipts.get)
  get({ params }: RouteInput<ReceiptRoutes['get']>): Promise<RouteResponse<ReceiptRoutes['get']>> {
    return this.receipts.get(params.id);
  }

  @Endpoint(routes.goodsReceipts.create)
  create({
    body,
  }: RouteInput<ReceiptRoutes['create']>): Promise<RouteResponse<ReceiptRoutes['create']>> {
    return this.receipts.create(body);
  }

  @Endpoint(routes.goodsReceipts.update)
  update({
    params,
    body,
  }: RouteInput<ReceiptRoutes['update']>): Promise<RouteResponse<ReceiptRoutes['update']>> {
    return this.receipts.update(params.id, body);
  }

  @Endpoint(routes.goodsReceipts.remove)
  remove({ params, query }: RouteInput<ReceiptRoutes['remove']>): Promise<void> {
    return this.receipts.remove(params.id, query.version);
  }

  @Endpoint(routes.goodsReceipts.post)
  post({
    params,
    body,
  }: RouteInput<ReceiptRoutes['post']>): Promise<RouteResponse<ReceiptRoutes['post']>> {
    return this.receipts.post(params.id, body.version);
  }
}
```

- Each method only moves the route's parts into the service. The permissions are in the contract's routes:
  `purchase.order.manage` for the order, `purchase.receipt.manage` for the receipt, none for reading.

```diff
@@ -6,6 +6,7 @@ import { CostLookupService } from './cost-lookup.service.js';
 import { RequisitionsService } from './requisitions.service.js';
 
 type Routes = typeof routes.requisitions;
+type LineRoutes = typeof routes.requisitionLines;
 type CostRoutes = typeof routes.purchaseCosts;
 
 @Controller()
@@ -51,6 +52,17 @@ export class RequisitionsController {
   cancel({ params, body }: RouteInput<Routes['cancel']>): Promise<RouteResponse<Routes['cancel']>> {
     return this.requisitions.cancel(params.id, body.version);
   }
+
+  @Endpoint(routes.requisitions.close)
+  close({ params, body }: RouteInput<Routes['close']>): Promise<RouteResponse<Routes['close']>> {
+    return this.requisitions.close(params.id, body.version);
+  }
+
+  // Step 17b: what the purchase order form picks from
+  @Endpoint(routes.requisitionLines.open)
+  openLines({ query }: RouteInput<LineRoutes['open']>): Promise<RouteResponse<LineRoutes['open']>> {
+    return this.requisitions.openLines(query);
+  }
 }
 
 @Controller()
```

```diff
@@ -7,7 +7,10 @@ import { RbacModule } from '../rbac/rbac.module.js';
 import { ApprovalRulesController, ApprovalsController } from './approvals.controller.js';
 import { ApprovalsService } from './approvals.service.js';
 import { CostLookupService } from './cost-lookup.service.js';
+import { GoodsReceiptsService } from './goods-receipts.service.js';
 import { PayableAccess } from './payable-access.js';
+import { GoodsReceiptsController, PurchaseOrdersController } from './purchase-orders.controller.js';
+import { PurchaseOrdersService } from './purchase-orders.service.js';
 import { PurchaseCostsController, RequisitionsController } from './requisitions.controller.js';
 import { RequisitionsService } from './requisitions.service.js';
 import { SupplierGroupsService } from './supplier-groups.service.js';
@@ -15,10 +18,12 @@ import { SupplierGroupsController, SuppliersController } from './suppliers.contr
 import { SuppliersService } from './suppliers.service.js';
 
 // Purchase (step 17): suppliers, their groups, the approvals engine, requisitions and the cost
-// lookup in 17a. NumberingModule gives the codes and numbers (S-00042, PR-), JournalModule the
-// LedgerService behind a supplier's statement, RbacModule the permission check of PayableAccess,
-// InventoryModule the ValueAccess that hides the average cost without inventory.stock.value.
-// The approvals engine lives here because every document that needs one is a purchase document.
+// lookup in 17a; purchase orders and goods receipts in 17b. NumberingModule gives the codes and
+// numbers (S-00042, PR-, PO-, GRN-), JournalModule the LedgerService behind a supplier's
+// statement, RbacModule the permission check of PayableAccess, InventoryModule the ValueAccess
+// that hides the average cost without inventory.stock.value and, for the goods receipt, the stock
+// posting and its books. The approvals engine lives here because every document that needs one is
+// a purchase document. PurchaseOrdersService is exported for the documents module (its PDF).
 @Module({
   imports: [NumberingModule, JournalModule, RbacModule, InventoryModule],
   controllers: [
@@ -28,6 +33,8 @@ import { SuppliersService } from './suppliers.service.js';
     ApprovalsController,
     RequisitionsController,
     PurchaseCostsController,
+    PurchaseOrdersController,
+    GoodsReceiptsController,
   ],
   providers: [
     SuppliersService,
@@ -36,6 +43,9 @@ import { SuppliersService } from './suppliers.service.js';
     ApprovalsService,
     RequisitionsService,
     CostLookupService,
+    PurchaseOrdersService,
+    GoodsReceiptsService,
   ],
+  exports: [PurchaseOrdersService],
 })
 export class PurchaseModule {}
```

- **`InventoryModule`** already gave `ValueAccess`; the receipt also uses its `StockPostingService` and
  `StockBooksService`, which it already exports for the sales documents.
- **`exports: [PurchaseOrdersService]`:** the documents module builds the order's PDF from the same read as the
  order's page.

### The purchase order goes out: `documents/`

```diff
@@ -6,8 +6,9 @@ import {
   SHARE_LINK_DAYS,
 } from '@omnivo/contracts';
 
-// Every word a customer reads in step 16, in both languages side by side: the PDF, the email's
-// first subject and message, the lines the server adds under the message, and the WhatsApp text.
+// Every word a customer reads in step 16 (and a supplier, since step 17b), in both languages side
+// by side: the PDF, the email's first subject and message, the lines the server adds under the
+// message, and the WhatsApp text.
 // The server writes them (decision 12), so a person whose screen is in English can send a Bangla
 // invoice. The PDF's words are the browser print's (print.* in en.ts/bn.ts), so paper and PDF say
 // the same thing. satisfies: a text missing in one language does not compile.
@@ -19,7 +20,8 @@ export interface DocumentFacts {
   number: string;
   // "৳1,15,000.00", in the language's digits
   amount: string;
-  // The quotation's "valid until" or the invoice's due date, already formatted; else null
+  // The quotation's "valid until", the invoice's due date or the purchase order's delivery date,
+  // already formatted; else null
   date: string | null;
   // A credit note's invoice number; else null
   invoice: string | null;
@@ -41,6 +43,13 @@ export interface DocumentCopy {
   customer: string;
   billTo: string;
   receivedFrom: string;
+  // Step 17b: a purchase order's own words
+  supplier: string;
+  deliverBy: string;
+  deliverTo: string;
+  paymentTerms: string;
+  // 0 = paid when the goods come; written in the language's digits
+  termsDays: (days: number) => string;
   columns: {
     number: string;
     item: string;
@@ -77,7 +86,13 @@ export interface DocumentCopy {
   page: (page: string, pages: string) => string;
   // The email dialog's first values; the person can change both
   emailSubject: (facts: DocumentFacts, company: string) => string;
-  emailMessage: (facts: DocumentFacts, customer: string, sender: string, company: string) => string;
+  // recipient: the customer, or the supplier of a purchase order
+  emailMessage: (
+    facts: DocumentFacts,
+    recipient: string,
+    sender: string,
+    company: string,
+  ) => string;
   // The lines the server puts under the person's message. They are not editable: they say what is
   // attached and who really sent it, which the customer must be able to trust.
   emailAttached: (fileName: string) => string;
@@ -96,6 +111,7 @@ export const DOCUMENT_COPY = {
       invoice: 'Invoice',
       receipt: 'Money receipt',
       credit_note: 'Credit note',
+      purchase_order: 'Purchase order',
     },
     bin: (bin) => `BIN ${bin}`,
     phone: (phone) => `Phone ${phone}`,
@@ -111,6 +127,11 @@ export const DOCUMENT_COPY = {
     customer: 'Customer',
     billTo: 'Bill to',
     receivedFrom: 'Received from',
+    supplier: 'Supplier',
+    deliverBy: 'Deliver by',
+    deliverTo: 'Deliver to',
+    paymentTerms: 'Payment terms',
+    termsDays: (days) => (days === 0 ? 'On delivery' : `${String(days)} days`),
     columns: {
       number: '#',
       item: 'Item',
@@ -162,7 +183,7 @@ export const DOCUMENT_COPY = {
     },
     page: (page, pages) => `Page ${page} of ${pages}`,
     emailSubject: (facts, company) => `${facts.title} ${facts.number} from ${company}`,
-    emailMessage: (facts, customer, sender, company) => {
+    emailMessage: (facts, recipient, sender, company) => {
       const lead = {
         quotation:
           facts.date === null
@@ -171,8 +192,12 @@ export const DOCUMENT_COPY = {
         invoice: `Please find attached invoice ${facts.number} for ${facts.amount}, due on ${facts.date ?? ''}.`,
         receipt: `Thank you for your payment. Please find attached money receipt ${facts.number} for ${facts.amount}.`,
         credit_note: `Please find attached credit note ${facts.number} for ${facts.amount}, against invoice ${facts.invoice ?? ''}.`,
+        purchase_order:
+          facts.date === null
+            ? `Please find attached our purchase order ${facts.number} for ${facts.amount}.`
+            : `Please find attached our purchase order ${facts.number} for ${facts.amount}. Please deliver by ${facts.date}.`,
       } satisfies Record<OutputDocument, string>;
-      return `Dear ${customer},\n\n${lead[facts.kind]}\n\nRegards,\n${sender}\n${company}`;
+      return `Dear ${recipient},\n\n${lead[facts.kind]}\n\nRegards,\n${sender}\n${company}`;
     },
     emailAttached: (fileName) => `Attached: ${fileName}`,
     emailSentBy: (sender, company) => `${sender} sent this from ${company} using Omnivo.`,
@@ -189,6 +214,7 @@ export const DOCUMENT_COPY = {
       invoice: 'ইনভয়েস',
       receipt: 'মানি রিসিট',
       credit_note: 'ক্রেডিট নোট',
+      purchase_order: 'পারচেজ অর্ডার',
     },
     bin: (bin) => `BIN ${bin}`,
     phone: (phone) => `ফোন ${phone}`,
@@ -204,6 +230,11 @@ export const DOCUMENT_COPY = {
     customer: 'গ্রাহক',
     billTo: 'বিলের ঠিকানা',
     receivedFrom: 'যার কাছ থেকে পাওয়া গেছে',
+    supplier: 'সরবরাহকারী',
+    deliverBy: 'সরবরাহের তারিখ',
+    deliverTo: 'যেখানে পৌঁছাবে',
+    paymentTerms: 'পেমেন্টের মেয়াদ',
+    termsDays: (days) => (days === 0 ? 'মাল পাওয়ার সময়' : `${bnDigits.format(days)} দিন`),
     columns: {
       number: '#',
       item: 'আইটেম',
@@ -255,7 +286,7 @@ export const DOCUMENT_COPY = {
     },
     page: (page, pages) => `পৃষ্ঠা ${page} / ${pages}`,
     emailSubject: (facts, company) => `${company} থেকে ${facts.title} ${facts.number}`,
-    emailMessage: (facts, customer, sender, company) => {
+    emailMessage: (facts, recipient, sender, company) => {
       const lead = {
         quotation:
           facts.date === null
@@ -264,8 +295,12 @@ export const DOCUMENT_COPY = {
         invoice: `ইনভয়েস ${facts.number} (${facts.amount}) সংযুক্ত করা হলো। পরিশোধের তারিখ ${facts.date ?? ''}।`,
         receipt: `আপনার পেমেন্টের জন্য ধন্যবাদ। মানি রিসিট ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`,
         credit_note: `ইনভয়েস ${facts.invoice ?? ''}-এর বিপরীতে ক্রেডিট নোট ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`,
+        purchase_order:
+          facts.date === null
+            ? `আমাদের পারচেজ অর্ডার ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`
+            : `আমাদের পারচেজ অর্ডার ${facts.number} (${facts.amount}) সংযুক্ত করা হলো। অনুগ্রহ করে ${facts.date}-এর মধ্যে মাল পৌঁছে দিন।`,
       } satisfies Record<OutputDocument, string>;
-      return `প্রিয় ${customer},\n\n${lead[facts.kind]}\n\nধন্যবাদান্তে,\n${sender}\n${company}`;
+      return `প্রিয় ${recipient},\n\n${lead[facts.kind]}\n\nধন্যবাদান্তে,\n${sender}\n${company}`;
     },
     emailAttached: (fileName) => `সংযুক্ত: ${fileName}`,
     emailSentBy: (sender, company) => `${sender} এটা ${company} থেকে Omnivo দিয়ে পাঠিয়েছেন।`,
```

- **The order's own words, in both languages:** "Supplier", "Deliver by", "Deliver to", "Payment terms", and the
  title "Purchase order" / "পারচেজ অর্ডার" (PO stays an English office word in Bangla, as the app's copy rule says).
- **`termsDays()` takes a number** and writes it in the language's digits, so the English and the Bangla PDF say
  "30 days" and "৩০ দিন" from one value. 0 days is "On delivery".
- **The email's first message** asks for delivery by the order's date when it has one.
- **`emailMessage()`'s parameter is `recipient` now:** the person greeted is a supplier too.

```diff
@@ -10,23 +10,27 @@ import {
   isZeroMoney,
   type LanguageCode,
   type OutputDocument,
+  type PartyRef,
+  type PurchaseOrder,
   type Quotation,
   type Receipt,
   type SalesLine,
   unappliedOf,
 } from '@omnivo/contracts';
-import { attachments, parties, tenants, tenantSettings, units } from '@omnivo/db';
+import { attachments, parties, tenants, tenantSettings, units, warehouses } from '@omnivo/db';
 import { and, eq, inArray } from 'drizzle-orm';
 
 import { AppError } from '../common/http/app-error.js';
 import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
+import { PurchaseOrdersService } from '../purchase/purchase-orders.service.js';
 import { formatAmount, formatIsoDate, formatNumber } from '../reports/export/format.js';
 import { CreditNotesService } from '../sales/credit-notes.service.js';
 import { InvoicesService } from '../sales/invoices.service.js';
 import { QuotationsService } from '../sales/quotations.service.js';
 import { ReceiptsService } from '../sales/receipts.service.js';
+import { billingAddressOf } from '../sales/sales-lines.js';
 import { DOCUMENT_COPY, type DocumentCopy, type DocumentFacts } from './copy.js';
 import { type DocumentModel, fingerprintOf } from './model.js';
 
@@ -38,7 +42,19 @@ type Loaded =
   | { kind: 'quotation'; doc: Quotation }
   | { kind: 'invoice'; doc: Invoice }
   | { kind: 'receipt'; doc: Receipt }
-  | { kind: 'credit_note'; doc: CreditNote };
+  | { kind: 'credit_note'; doc: CreditNote }
+  | { kind: 'purchase_order'; doc: PurchaseOrder };
+
+// Who receives it: the customer, or the supplier of a purchase order (step 17b)
+function recipientRef(loaded: Loaded): PartyRef {
+  return loaded.kind === 'purchase_order' ? loaded.doc.supplier : loaded.doc.customer;
+}
+
+// Where a purchase order's goods go: the warehouse's name and address, on one line
+interface DeliveryPlace {
+  name: string;
+  address: string | null;
+}
 
 interface Company {
   name: string;
@@ -62,7 +78,8 @@ export interface BuiltDocument {
   fingerprint: string;
   // What the email and WhatsApp sentences say about it
   facts: DocumentFacts;
-  customer: { id: string; name: string; email: string | null; phone: string | null };
+  // The customer, or the supplier of a purchase order: where the email and the WhatsApp go
+  recipient: { id: string; name: string; email: string | null; phone: string | null };
   company: { name: string; logo: { key: string; contentType: string } | null };
   // The public page's numbers: plain decimal strings and ISO dates, the page formats them
   summary: {
@@ -85,7 +102,10 @@ function documentNotIssued(): AppError {
 
 // The number of a document that may go out (decision 11), or the error. A quotation is numbered
 // when it is saved. An invoice and a credit note get theirs when they are posted. A voided receipt
-// still has its number, but it is not money received any more.
+// still has its number, but it is not money received any more. A purchase order is numbered when
+// it is submitted (step 17b), but it goes to the supplier only once approved: a pending one may
+// still be rejected, and a cancelled one will not be bought. A received or closed order may still
+// be sent again (the supplier asks for a copy).
 function issuedNumber(loaded: Loaded): string {
   switch (loaded.kind) {
     case 'quotation':
@@ -97,11 +117,17 @@ function issuedNumber(loaded: Loaded): string {
     case 'credit_note':
       if (loaded.doc.status === 'draft' || loaded.doc.number === null) throw documentNotIssued();
       return loaded.doc.number;
+    case 'purchase_order': {
+      const { status, number } = loaded.doc;
+      const sent = status === 'approved' || status === 'received' || status === 'closed';
+      if (!sent || number === null) throw documentNotIssued();
+      return number;
+    }
   }
 }
 
 // The PDF's model and everything around it, from the same reads the document's own page uses
-// (the four services' get). Runs in the API only: the worker draws the stored model.
+// (the services' get). Runs in the API only: the worker draws the stored model.
 @Injectable()
 export class DocumentModels {
   constructor(
@@ -110,29 +136,39 @@ export class DocumentModels {
     private readonly invoices: InvoicesService,
     private readonly receipts: ReceiptsService,
     private readonly creditNotes: CreditNotesService,
+    private readonly purchaseOrders: PurchaseOrdersService,
   ) {}
 
   async build(kind: OutputDocument, id: string, language: LanguageCode): Promise<BuiltDocument> {
     const loaded = await this.load(kind, id);
     const number = issuedNumber(loaded);
     const lines = loaded.kind === 'receipt' ? [] : loaded.doc.lines;
+    const recipientId = recipientRef(loaded).id;
     const context = await this.withTenant(async (tx) => ({
       company: await companyOf(tx),
       units: await unitsOf(
         tx,
         lines.map((line) => line.unitId),
       ),
-      customer: await customerOf(tx, loaded.doc.customer.id),
+      recipient: await recipientOf(tx, recipientId),
+      // A purchase order prints the supplier's address and where to deliver; the sales documents
+      // keep their own copies of the customer's addresses
+      supplierAddress:
+        loaded.kind === 'purchase_order' ? await billingAddressOf(tx, recipientId) : null,
+      place: loaded.kind === 'purchase_order' ? await placeOf(tx, loaded.doc.warehouseId) : null,
     }));
     const writer = new ModelWriter(language, context.company, context.units);
-    const model = writer.model(loaded, number);
+    const model = writer.model(loaded, number, {
+      supplierAddress: context.supplierAddress,
+      place: context.place,
+    });
     return {
       kind,
       id,
       model,
       fingerprint: fingerprintOf(model),
       facts: writer.facts(loaded, number),
-      customer: context.customer,
+      recipient: context.recipient,
       company: { name: context.company.name, logo: context.company.logo },
       summary: {
         number,
@@ -156,6 +192,8 @@ export class DocumentModels {
         return { kind, doc: await this.receipts.get(id) };
       case 'credit_note':
         return { kind, doc: await this.creditNotes.get(id) };
+      case 'purchase_order':
+        return { kind, doc: await this.purchaseOrders.get(id) };
     }
   }
 }
@@ -209,14 +247,24 @@ async function unitsOf(tx: Transaction, unitIds: readonly string[]): Promise<Map
   return new Map(rows.map((row) => [row.id, { code: row.code, decimals: row.decimals }]));
 }
 
-// Where an email and a WhatsApp message go: the customer's own email and phone
-async function customerOf(tx: Transaction, id: string): Promise<BuiltDocument['customer']> {
+// Where an email and a WhatsApp message go: the customer's (or the supplier's) own email and phone
+async function recipientOf(tx: Transaction, id: string): Promise<BuiltDocument['recipient']> {
   const [row] = await tx
     .select({ id: parties.id, name: parties.name, email: parties.email, phone: parties.phone })
     .from(parties)
     .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
-  // The document's customer FK makes this a broken database, not a 404
-  if (!row) throw new Error(`Customer ${id} of a document is missing`);
+  // The document's party FK makes this a broken database, not a 404
+  if (!row) throw new Error(`Party ${id} of a document is missing`);
+  return row;
+}
+
+// The warehouse a purchase order's goods are delivered to (step 17b)
+async function placeOf(tx: Transaction, warehouseId: string): Promise<DeliveryPlace> {
+  const [row] = await tx
+    .select({ name: warehouses.name, address: warehouses.address })
+    .from(warehouses)
+    .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, warehouseId)));
+  if (!row) throw new Error(`Warehouse ${warehouseId} of a purchase order is missing`);
   return row;
 }
 
@@ -273,10 +321,24 @@ class ModelWriter {
           date: null,
           invoice: loaded.doc.invoice.number,
         };
+      case 'purchase_order': {
+        const { expectedDate } = loaded.doc;
+        return {
+          ...base,
+          amount: this.money(loaded.doc.total),
+          date: expectedDate === null ? null : this.day(expectedDate),
+          invoice: null,
+        };
+      }
     }
   }
 
-  model(loaded: Loaded, number: string): DocumentModel {
+  // extra: what only a purchase order prints, read by build() (null for the sales documents)
+  model(
+    loaded: Loaded,
+    number: string,
+    extra: { supplierAddress: string | null; place: DeliveryPlace | null },
+  ): DocumentModel {
     const { copy } = this;
     const common = {
       language: this.language,
@@ -297,10 +359,11 @@ class ModelWriter {
       { label: copy.number, value: number },
       { label: copy.date, value: this.day(loaded.doc.date) },
     ];
+    const recipient = recipientRef(loaded);
     const party = (label: string, lines: string[] = []) => ({
       label,
-      name: loaded.doc.customer.name,
-      code: loaded.doc.customer.code,
+      name: recipient.name,
+      code: recipient.code,
       lines,
     });
     const note = (text: string | null) =>
@@ -442,6 +505,40 @@ class ModelWriter {
           signatures: [copy.signatures.preparedBy, copy.signatures.authorised],
         };
       }
+      case 'purchase_order': {
+        const order = loaded.doc;
+        const { place } = extra;
+        return {
+          ...common,
+          meta: [
+            ...numberAndDate,
+            ...(order.expectedDate === null
+              ? []
+              : [{ label: copy.deliverBy, value: this.day(order.expectedDate) }]),
+            ...(order.supplierReference === null
+              ? []
+              : [{ label: copy.customerReference, value: order.supplierReference }]),
+            { label: copy.paymentTerms, value: copy.termsDays(order.paymentTermsDays) },
+          ],
+          party: party(copy.supplier, extra.supplierAddress?.split('\n') ?? []),
+          // Where the truck goes: the warehouse and its address, on one line
+          facts:
+            place === null
+              ? []
+              : [
+                  {
+                    label: copy.deliverTo,
+                    value: [place.name, ...(place.address?.split('\n') ?? [])].join(', '),
+                  },
+                ],
+          table: this.linesTable(order.lines, order.pricesIncludeVat),
+          totals: this.totals(order, order.pricesIncludeVat, []),
+          // What the company commits to pay, so it is written in words like a bill
+          words: this.words(order.total),
+          note: note(order.note),
+          signatures: [copy.signatures.preparedBy, copy.signatures.authorised],
+        };
+      }
     }
   }
 
```

- **`recipientRef()`** names the party of any document: the supplier of an order, the customer of the others. The
  model's party block, the email's address and the WhatsApp number all come from it.
- **`BuiltDocument.recipient`** was `customer`, like the public page's field (decision 24).
- **`issuedNumber()`** lets an order out once it is approved (decision 35); a received or closed one may go again.
- **The order's PDF** has the delivery date, the supplier's reference ("Your reference": the supplier's own
  quotation number), the payment terms, the supplier's billing address, "Deliver to" with the warehouse's name and
  address on one line, the priced lines and totals of a sales document, and the amount in words: an order is what
  the company commits to pay. Step 16 left the words off the quotation because it is only an offer to sell; an
  order is the company's own promise to pay, like a bill.
- **`placeOf()` and `billingAddressOf()`** are read only for an order, in the same transaction as the company.

```diff
@@ -112,9 +112,9 @@ export class DocumentOutputService {
     const sender = await this.withTenant((tx) => this.senderName(tx));
     const copy = DOCUMENT_COPY[language];
     return {
-      to: built.customer.email ?? '',
+      to: built.recipient.email ?? '',
       subject: copy.emailSubject(built.facts, built.company.name),
-      message: copy.emailMessage(built.facts, built.customer.name, sender, built.company.name),
+      message: copy.emailMessage(built.facts, built.recipient.name, sender, built.company.name),
     };
   }
 
@@ -218,7 +218,7 @@ export class DocumentOutputService {
     // The app's route, not the API's: the page at /d/:token asks the public API route
     const url = `${this.config.appOrigin}/d/${token}`;
     const message = DOCUMENT_COPY[language].shareMessage(built.facts, built.company.name, url);
-    return { share, url, message, whatsAppUrl: whatsAppUrl(built.customer.phone, message) };
+    return { share, url, message, whatsAppUrl: whatsAppUrl(built.recipient.phone, message) };
   }
 
   // Turned off once; pressing it again on an off link changes nothing and is not an error
```

```diff
@@ -57,7 +57,7 @@ export class PublicDocumentsService {
         kind: share.kind,
         number: built.summary.number,
         date: built.summary.date,
-        customer: built.customer.name,
+        recipient: built.recipient.name,
         total: built.summary.total,
         currency: built.summary.currency,
         dueDate: built.summary.dueDate,
```

- The email draft, the share message and the public page read `recipient` instead of `customer`.

```diff
@@ -1,5 +1,6 @@
 import { Module } from '@nestjs/common';
 
+import { PurchaseModule } from '../purchase/purchase.module.js';
 import { RbacModule } from '../rbac/rbac.module.js';
 import { SalesModule } from '../sales/sales.module.js';
 import {
@@ -13,10 +14,11 @@ import { PublicDocumentsService } from './public-documents.service.js';
 
 // Step 16: a document goes out — its PDF, an email, a share link and the public page behind it.
 // SalesModule gives the four services whose get() the PDF's model is built from (the same reads
-// as the document's page), RbacModule the PermissionService behind the send permission. The
-// worker's half (drawing, sending) is in file.handler.ts and email.handler.ts.
+// as the document's page), PurchaseModule the purchase order's (step 17b), RbacModule the
+// PermissionService behind the send permission. The worker's half (drawing, sending) is in
+// file.handler.ts and email.handler.ts.
 @Module({
-  imports: [SalesModule, RbacModule],
+  imports: [SalesModule, PurchaseModule, RbacModule],
   controllers: [DocumentOutputController, PublicDocumentsController],
   providers: [DocumentModels, DocumentFiles, DocumentOutputService, PublicDocumentsService],
 })
```

```diff
@@ -243,7 +243,7 @@ describe("tenant A can't reach tenant B's documents", () => {
     const page = publicDocumentSchema.parse(
       (await as(tenantA, 'GET', `/public/documents/${tokenOfB}`)).json(),
     );
-    expect([page.company, page.customer]).toEqual(['Karim Pharma', 'Lazz Pharma, Kalabagan']);
+    expect([page.company, page.recipient]).toEqual(['Karim Pharma', 'Lazz Pharma, Kalabagan']);
   });
 });
 
```

- The step 16 leak test reads the renamed field. 17b.4 adds the order's own tests.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm lint
```

The API type-checks, and its unit tests pass (107, among them the route test of 17b.1, which now finds a controller
for every new route). The contracts' tests still pass (217) after the three new error codes. The app and the mock do
not type-check yet: they learn the new words in 17b.5 and the screens in 17b.6.

> **What we checked.** The type checker, the linter and the unit tests above. Nothing in this part has run against a
> real database yet: the orders, the receipts, the stock and the books are tested against one in 17b.4, with two
> receipts posting against one order at once, a receipt over the tolerance, a reopen while a receipt is written, and
> another workspace trying every route.

---

## 17b.4 — `apps/api`: the tests

This part adds three test files, all in `apps/api/src/purchase/`, and changes nine older ones. Like every
integration test since step 5, they run against a real Postgres and the real worker:

- `purchase-orders.int.spec.ts` follows a knit composite factory through its purchase orders: writing and pricing
  them, their own approval levels, reopening and cancelling, the requisitions they buy for, the price a new line
  starts with, and the order going out as a PDF, by email and by a WhatsApp link (with a real MinIO and a real
  Mailpit, like step 16's tests).
- `goods-receipts.int.spec.ts` follows a garments factory's gate: fabric, dye by the lot, sewing machines by serial
  number and buttons by the box come in against approved orders. Stock, value, the books, the order's counts, the
  over-receipt percent, a whole line turned back, the last receipt, closing, and two people acting at once.
- `purchase-orders.tenant-leak.int.spec.ts`: workspace A must never see, change, approve, send or receive against
  anything of workspace B's, nor count B's orders in its stock or its prices.
- Nine older files follow the rules 17b added: the settings form has a new field, there is a second approval rule,
  the cost lookup sends a VAT rate, two garments roles have new permissions, and the public page says `recipient`.

No code from 17b.3 changed: the new tests passed against it as it is. They are also the first time 17b's SQL ran
against a real database: the ordered quantities of a requisition, the "incoming" column, the last price, the
supplier-side check across three tables, and every guard of migration 0038 that the API meets on the way.

### `purchase/purchase-orders.int.spec.ts` (new): the setup

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  approvalRuleListSchema,
  auditPageSchema,
  costLookupSchema,
  createdShareSchema,
  type Customer,
  customerSchema,
  type DocumentFile,
  documentEmailDraftSchema,
  documentEmailSchema,
  documentFileSchema,
  type LanguageCode,
  memberPageSchema,
  notificationPageSchema,
  openRequisitionLinePageSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  publicDocumentSchema,
  type PurchaseOrder,
  type PurchaseOrderFormValues,
  type PurchaseOrderLineFormValues,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  type Requisition,
  requisitionPageSchema,
  requisitionSchema,
  type Role,
  roleSchema,
  setupSchema,
  type Supplier,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DocumentModel, documentModelSchema } from '../documents/model.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  startStorage,
  type TestMail,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { attachmentOf, lastMailTo } from '../testing/mailpit.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 17b: a knit composite factory orders yarn-dyed fabric, buttons and dyeing from its
// suppliers. The orders' own approval levels, the requisitions they buy for, the price a new line
// starts with, and the order going out as a PDF, by email and by a WhatsApp link. A real MinIO
// for the files and a real Mailpit for the emails. One workspace, one story: each test builds on
// the ones before it, so read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Habib, the Owner
let owner: SignedIn;
// Mitu, a merchandiser: writes requisitions and purchase orders
let mitu: SignedIn;
// Kamal, the purchase manager: approves orders from ৳1,00,000
let kamal: SignedIn;
// Jamal, the store keeper: asks for goods and receives them, never orders or sends them
let jamal: SignedIn;
let purchaseManager: Role;
let units: Unit[];
let rates: TaxRate[];
let main: Warehouse;
// A second store of the same branch
let konabari: Warehouse;
let meghna: Supplier;
let karim: Supplier;
// A customer, which is not a supplier
let buyer: Customer;
// Single jersey by the kg, bought by the roll of 25 kg; 500 kg in stock at ৳420 a kg
let jersey: Product;
let buttons: Product;
// A service: dyeing is bought, never received
let dyeing: Product;
// In stock, never bought, with its own VAT rate
let rib: Product;
// The first order: jersey and buttons from Meghna
let order: PurchaseOrder;
// Buttons from Karim, small enough to need no approval
let small: PurchaseOrder;
// Cancelled after a round of approval
let dropped: PurchaseOrder;
let requisition: Requisition;
// A draft that buys 20 rolls for the requisition
let firstPart: PurchaseOrder;
// The Konabari store's requisition, which nothing is ordered for
let konabariAsk: Requisition;
let firstFile: DocumentFile;

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn | null = owner,
) {
  return app.inject({
    method,
    url,
    ...(as && { headers: bearer(as.accessToken) }),
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

function defaultRateId(): string {
  const found = rates.find((rate) => rate.isDefault);
  if (!found) throw new Error('no default VAT rate');
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function requisitionLineOf(doc: Requisition, product: Product): string {
  const found = doc.lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${doc.number}`);
  return found.id;
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

async function addSupplier(name: string, extra: object = {}): Promise<Supplier> {
  const res = await send('POST', '/suppliers', {
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
  });
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

async function supplierNow(id: string): Promise<Supplier> {
  return supplierSchema.parse((await send('GET', `/suppliers/${id}`)).json());
}

async function addRole(name: string, permissions: PermissionKey[]): Promise<Role> {
  const made = await send('POST', '/roles', { name, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  return role;
}

// A user who signs up for a workspace of their own, then joins this one with this role
async function member(
  email: string,
  fullName: string,
  password: string,
  role: Role,
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'padma-knit' });
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'padma-knit', email, password, keepSignedIn: false });
}

// A line as the form sends it: in the product's base unit, 15% VAT, no discount, its own name
function line(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<PurchaseOrderLineFormValues> = {},
): PurchaseOrderLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: product.baseUnitId,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    requisitionLineId: '',
    ...extra,
  };
}

function orderForm(
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
): Omit<PurchaseOrderFormValues, 'version'> {
  return {
    supplierId: meghna.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: main.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines,
    ...extra,
  };
}

// The edit form: what the order has, with these changes
function formOf(
  doc: PurchaseOrder,
  extra: Partial<PurchaseOrderFormValues> = {},
): PurchaseOrderFormValues {
  return {
    supplierId: doc.supplier.id,
    date: doc.date,
    expectedDate: doc.expectedDate ?? '',
    warehouseId: doc.warehouseId,
    supplierReference: doc.supplierReference ?? '',
    paymentTermsDays: doc.paymentTermsDays,
    pricesIncludeVat: doc.pricesIncludeVat,
    note: doc.note ?? '',
    lines: doc.lines.map((item) => ({
      variantId: item.variantId,
      unitId: item.unitId,
      quantity: item.quantity,
      description: item.description,
      unitPrice: item.unitPrice,
      discountType: item.discountType,
      // The API's "2.0000"; the box takes 2 decimals, as the app's edit page fills it
      discount: item.discount.replace(/(\.\d{2})\d*$/, '$1'),
      taxRateId: item.taxRate.id,
      requisitionLineId: item.requisitionLine?.id ?? '',
    })),
    version: doc.version,
    ...extra,
  };
}

async function ordered(
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
  as = mitu,
): Promise<PurchaseOrder> {
  const res = await send('POST', '/purchase-orders', orderForm(lines, extra), as);
  expect(res.statusCode, res.body).toBe(201);
  return purchaseOrderSchema.parse(res.json());
}

async function orderNow(id: string): Promise<PurchaseOrder> {
  const res = await send('GET', `/purchase-orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

async function updated(
  doc: PurchaseOrder,
  extra: Partial<PurchaseOrderFormValues>,
): Promise<PurchaseOrder> {
  const res = await send('PUT', `/purchase-orders/${doc.id}`, formOf(doc, extra), mitu);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

// An order's button that takes the version
function act(
  action: 'submit' | 'reopen' | 'close' | 'cancel',
  doc: PurchaseOrder,
  as: SignedIn = mitu,
) {
  return send('POST', `/purchase-orders/${doc.id}/${action}`, { version: doc.version }, as);
}

async function acted(
  action: 'submit' | 'reopen' | 'close' | 'cancel',
  doc: PurchaseOrder,
  as: SignedIn = mitu,
): Promise<PurchaseOrder> {
  const res = await act(action, doc, as);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

// Kamal approves the step that waits, on the round the page showed
async function approvedBy(doc: PurchaseOrder, as: SignedIn): Promise<PurchaseOrder> {
  const [round] = doc.approval.rounds;
  if (!round) throw new Error(`${doc.number ?? 'the order'} has no round`);
  const res = await send(
    'POST',
    `/approvals/purchase_order/${doc.id}/approve`,
    { roundId: round.id, comment: '' },
    as,
  );
  expect(res.statusCode, res.body).toBe(204);
  return orderNow(doc.id);
}

async function requisitionNow(id: string): Promise<Requisition> {
  return requisitionSchema.parse((await send('GET', `/requisitions/${id}`)).json());
}

// What a purchase order form may still buy for, as [requisition number, product, remaining]
async function openLines(warehouse: Warehouse) {
  const page = openRequisitionLinePageSchema.parse(
    (await send('GET', `/requisition-lines?warehouseId=${warehouse.id}`, undefined, mitu)).json(),
  );
  return page.items.map((item) => [
    item.requisition.number,
    item.productName,
    item.remainingQuantity,
  ]);
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

function lookup(supplierId: string | null, items: { product: Product; unit: string }[], as = mitu) {
  return send(
    'POST',
    '/purchase/cost-lookup',
    {
      supplierId,
      items: items.map((item) => ({
        variantId: variantOf(item.product),
        unitId: unitId(item.unit),
      })),
    },
    as,
  );
}

async function costs(
  supplierId: string | null,
  items: { product: Product; unit: string }[],
  as = mitu,
) {
  const res = await lookup(supplierId, items, as);
  expect(res.statusCode, res.body).toBe(200);
  return costLookupSchema.parse(res.json()).items.map((item) => [item.cost, item.source]);
}

function documentPath(id: string): string {
  return `/documents/purchase_order/${id}`;
}

async function fileOf(id: string, language: LanguageCode): Promise<DocumentFile> {
  const res = await send('POST', `${documentPath(id)}/files`, { language }, mitu);
  expect(res.statusCode, res.body).toBe(200);
  return documentFileSchema.parse(res.json());
}

async function finished(id: string, fileId: string): Promise<DocumentFile> {
  return eventually(async () => {
    const res = await send('GET', `${documentPath(id)}/files/${fileId}`);
    const file = documentFileSchema.parse(res.json());
    expect(file.status).not.toBe('pending');
    return file;
  }, 8_000);
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// The page as the API wrote it on the row: what the worker draws
async function modelOf(fileId: string): Promise<DocumentModel> {
  const [row] = await superuserSql(
    (sql) => sql<{ model: unknown }[]>`SELECT model FROM document_files WHERE id = ${fileId}`,
  );
  return documentModelSchema.parse(row?.model);
}

beforeAll(async () => {
  [pg, redis, storage, mail] = await Promise.all([
    startPostgres(),
    startRedis(),
    startStorage(),
    startMail(),
  ]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
      storageUrl: storage.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Padma Knit Composite Ltd.',
    workspaceSlug: 'padma-knit',
    fullName: 'Habibur Rahman',
    email: 'habib@padmaknit.com',
    password: 'Konabari-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const [firstWarehouse] = warehouseListSchema.parse(
    (await send('GET', '/warehouses')).json(),
  ).items;
  if (!firstWarehouse) throw new Error('sign-up made no warehouse');
  // Where the trucks go: the PDF says it
  const moved = await send('PUT', `/warehouses/${firstWarehouse.id}`, {
    branchId: firstWarehouse.branchId,
    code: firstWarehouse.code,
    name: firstWarehouse.name,
    address: 'Plot 22, BSCIC Industrial Area\nKonabari, Gazipur',
    version: firstWarehouse.version,
  });
  expect(moved.statusCode, moved.body).toBe(200);
  main = warehouseSchema.parse(moved.json());
  const store = await send('POST', '/warehouses', {
    branchId: main.branchId,
    code: 'KNB',
    name: 'Konabari yarn store',
    address: '',
  });
  expect(store.statusCode, store.body).toBe(201);
  konabari = warehouseSchema.parse(store.json());

  const merchandising = await addRole('Merchandising', [
    'purchase.requisition.manage',
    'purchase.order.manage',
  ]);
  purchaseManager = await addRole('Purchase manager', ['purchase.order.manage']);
  const storeRole = await addRole('Store', [
    'purchase.requisition.manage',
    'purchase.receipt.manage',
  ]);
  mitu = await member('mitu@padmaknit.com', 'Mitu Akter', 'Buyer-order-2026', merchandising);
  kamal = await member(
    'kamal@padmaknit.com',
    'Kamal Hossain',
    'Purchase-desk-2026',
    purchaseManager,
  );
  jamal = await member('jamal@padmaknit.com', 'Jamal Uddin', 'Gate-register-2026', storeRole);

  meghna = await addSupplier('Meghna Spinning Mills Ltd.', {
    phone: '01711-223344',
    email: 'sales@meghnaspinning.com',
    address: 'Plot 14, Nayapara\nNarsingdi',
  });
  karim = await addSupplier('Karim Trims & Accessories');
  const customer = await send('POST', '/customers', {
    code: '',
    name: 'Nordic Fashion AB',
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
  buyer = customerSchema.parse(customer.json());

  jersey = await addProduct('Single jersey 160 GSM, white', {
    baseUnitId: unitId('kg'),
    units: [{ unitId: unitId('roll'), factor: '25', barcode: '' }],
  });
  buttons = await addProduct('Polo button 18L');
  dyeing = await addProduct('Dyeing charge', { type: 'service', baseUnitId: unitId('kg') });
  rib = await addProduct('Rib 1x1, white', {
    baseUnitId: unitId('kg'),
    taxRateId: rateId('Exempt'),
  });
  // Opening stock: 500 kg of jersey at ৳420 a kg, 80 kg of rib at ৳380
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      [jersey, '500', '420'],
      [rib, '80', '380'],
    ].map(([product, quantity, unitCost]) => ({
      variantId: variantOf(product as Product),
      unitId: unitId('kg'),
      quantity,
      batchId: '',
      lotNumber: '',
      expiresOn: '',
      manufacturedOn: '',
      serialNumbers: [],
      unitCost,
    })),
  });
  expect(opening.statusCode, opening.body).toBe(201);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([
    pg.container.stop(),
    redis.container.stop(),
    storage.container.stop(),
    mail.container.stop(),
  ]);
});
```

- **One workspace, one story** (Padma Knit Composite). The approval level set in the second `describe` holds for
  every test after it. When a test fails, read the first failure first.
- **Four people, each for one rule.** Habib is the Owner. Mitu, a merchandiser, writes requisitions and purchase
  orders. Kamal is the purchase manager: the one level of the orders' approval. Jamal, the store keeper, writes
  requisitions and receives goods, but never orders or sends anything: he is the person the 403 tests need.
- **Two warehouses of one branch.** The main store gets an address in `beforeAll`, because the PDF prints where to
  deliver. Konabari is the "other store" a requisition can be for.
- **Meghna has an email, a phone and an address**, for the email, the WhatsApp link and the PDF. Karim has
  nothing, and is the supplier that gets archived and restored. "Nordic Fashion AB" is a customer: a customer's id
  is the classic wrong supplier.
- **Four products, each for one source of the cost lookup.** Jersey has 500 kg in stock at ৳420 and a roll of 25
  kg, so a price per kg must come back per roll. Buttons are bought from both suppliers. Dyeing is a service that is
  never ordered in the end. Rib is in stock, never bought, and has its own VAT rate.
- **`line()` and `orderForm()` send every field**, typed with the contract's form types, so a renamed field breaks
  the type check here and not a test at run time.
- **`formOf()` builds the edit form from a saved order**, as the edit page does. The API sends a discount with 4
  decimals (`'2.0000'`), and the form's box takes 2 (the contract's `money_format`), so `formOf()` cuts it to 2
  like the app's `formDiscount()`. Sending the API's value back as it came is a 400.
- **`act()` / `acted()` are the order page's buttons**, and `approvedBy()` sends the round the page showed, like
  17a's `decide()`.
- **`openLines()` reads `/requisition-lines` as `[number, product, remaining]`**, so a test reads like the order
  form's "Add from requisitions" list.
- **`modelOf()` reads the PDF's model from the row as the superuser**, like step 16's tests: the words on the page
  are checked without parsing a PDF.

### Writing an order

```ts
describe('purchase orders', () => {
  it('are written for a supplier and priced like a sales line; a draft has no number', async () => {
    order = await ordered(
      [
        // 20 rolls of 25 kg at ৳10,500 a roll, less 2%: ৳2,05,800 before VAT
        line(jersey, '20', '10500', { unitId: unitId('roll'), discount: '2' }),
        // 5,000 buttons at ৳1.20, less ৳200: ৳5,800
        line(buttons, '5000', '1.20', {
          discountType: 'amount',
          discount: '200',
          description: 'Polo button 18L, white, 4-hole',
        }),
        // Dyeing 500 kg at ৳80: ৳40,000
        line(dyeing, '500', '80'),
      ],
      {
        expectedDate: '2026-10-25',
        supplierReference: 'PI-2210',
        paymentTermsDays: 45,
      },
    );
    expect(order).toMatchObject({
      number: null,
      status: 'draft',
      supplier: { id: meghna.id, name: 'Meghna Spinning Mills Ltd.' },
      warehouseId: main.id,
      supplierReference: 'PI-2210',
      paymentTermsDays: 45,
      pricesIncludeVat: false,
      partlyReceived: false,
      net: '251600.0000',
      vat: '37740.0000',
      total: '289340.0000',
      lineCount: 3,
      requisitions: [],
      receipts: [],
      approval: { rounds: [], canDecide: false },
    });
    expect(
      order.lines.map((item) => [
        item.description,
        item.baseQuantity,
        item.net,
        item.vat,
        item.total,
        item.receivedQuantity,
      ]),
    ).toEqual([
      [
        'Single jersey 160 GSM, white',
        '500.0000',
        '205800.0000',
        '30870.0000',
        '236670.0000',
        '0.0000',
      ],
      [
        'Polo button 18L, white, 4-hole',
        '5000.0000',
        '5800.0000',
        '870.0000',
        '6670.0000',
        '0.0000',
      ],
      ['Dyeing charge', '500.0000', '40000.0000', '6000.0000', '46000.0000', '0.0000'],
    ]);
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=purchase_order&entityId=${order.id}`)).json(),
    );
    expect(log.items[0]).toMatchObject({
      action: 'purchase_order.created',
      changes: {
        supplier: { from: null, to: meghna.code },
        total: { from: null, to: '289340.0000' },
        lines: { from: null, to: 3 },
      },
    });

    // The order's own "prices include VAT": ৳1.38 a button with VAT is ৳1.20 before it
    const withVat = await ordered([line(buttons, '1000', '1.38')], { pricesIncludeVat: true });
    expect([withVat.net, withVat.vat, withVat.total]).toEqual([
      '1200.0000',
      '180.0000',
      '1380.0000',
    ]);
    // Never submitted: deleted, and gone
    const removed = await send(
      'DELETE',
      `/purchase-orders/${withVat.id}?version=${String(withVat.version)}`,
      undefined,
      mitu,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/purchase-orders/${withVat.id}`)).statusCode).toBe(404);
  });

  it('refuse a supplier, warehouse, item or rate they cannot use, each under its own field', async () => {
    // A customer is not a supplier, and an archived supplier takes no new orders
    const oldDyes = await addSupplier('Old Dhaka Dye House');
    const archived = await send('POST', `/suppliers/${oldDyes.id}/archive`, {
      version: oldDyes.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    for (const supplierId of [buyer.id, oldDyes.id]) {
      const res = await send(
        'POST',
        '/purchase-orders',
        orderForm([line(buttons, '1', '1')], { supplierId }),
        mitu,
      );
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    }
    const nowhere = await send(
      'POST',
      '/purchase-orders',
      orderForm([line(buttons, '1', '1')], { warehouseId: buyer.id }),
      mitu,
    );
    expect(problemOf(nowhere).fieldErrors).toEqual({ warehouseId: ['purchase_warehouse_invalid'] });

    // Every line's problem at once: the items and the rates together
    const oldTrim = await addProduct('Satin label, old logo');
    const gone = await send('POST', `/products/${oldTrim.id}/archive`, {
      version: oldTrim.version,
    });
    expect(gone.statusCode, gone.body).toBe(200);
    const lines = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        line(oldTrim, '100', '2'),
        line(jersey, '10', '420', { unitId: unitId('pcs') }),
        line(buttons, '1.5', '1'),
        line(buttons, '10', '1', { taxRateId: buyer.id }),
      ]),
      mitu,
    );
    expect(lines.statusCode).toBe(409);
    expect(problemOf(lines).fieldErrors).toEqual({
      'lines.0.variantId': ['purchase_item_invalid'],
      'lines.1.unitId': ['stock_unit_invalid'],
      'lines.2.quantity': ['stock_quantity_decimals'],
      'lines.3.taxRateId': ['tax_rate_invalid'],
    });
    // The form's own rules come back before the API looks at anything
    const form = await send(
      'POST',
      '/purchase-orders',
      orderForm([line(buttons, '10', '1', { discount: '120' })], { expectedDate: '2026-10-01' }),
      mitu,
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      expectedDate: ['purchase_expected_date'],
      'lines.0.discount': ['sales_discount_too_large'],
    });
    const empty = await send('POST', '/purchase-orders', orderForm([]), mitu);
    expect(problemOf(empty).fieldErrors).toEqual({ lines: ['purchase_lines_required'] });
  });

  it('change freely as drafts, and only for the people who buy', async () => {
    // The dyeing goes on its own order to the dye house; Meghna gets 60 days
    const changed = await updated(order, {
      paymentTermsDays: 60,
      lines: formOf(order).lines.slice(0, 2),
    });
    expect(changed).toMatchObject({
      paymentTermsDays: 60,
      lineCount: 2,
      total: '243340.0000',
      version: order.version + 1,
    });
    const stale = await send('PUT', `/purchase-orders/${order.id}`, formOf(order), mitu);
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
    order = changed;

    // Jamal reads every order, and writes none
    const list = purchaseOrderPageSchema.parse(
      (await send('GET', '/purchase-orders?status=draft', undefined, jamal)).json(),
    );
    expect(list.items.map((item) => [item.id, item.lineCount])).toEqual([[order.id, 2]]);
    const refused = [
      await send('POST', '/purchase-orders', orderForm([line(buttons, '1', '1')]), jamal),
      await send('PUT', `/purchase-orders/${order.id}`, formOf(order), jamal),
      await act('submit', order, jamal),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).params).toEqual({ permissions: 'purchase.order.manage' });
    }
  });
});
```

- **A line is priced like a sales line**, to the paisa: 20 rolls at ৳10,500 less 2% is ৳2,05,800 before VAT;
  5,000 buttons at ৳1.20 less ৳200 is ৳5,800; dyeing ৳40,000. The order is ৳2,51,600 + ৳37,740 VAT = ৳2,89,340.
  The roll line's base quantity is 500 kg: what a receipt counts against. A typed description stays; an empty one
  becomes the product's name.
- **A draft has no number** (decision 13), no round and no receipts. The audit row has the supplier's code, the
  total and the number of lines.
- **"Prices include VAT" is the order's own** (decision 15): ৳1.38 a button with VAT is ৳1.20 before it. That draft
  was never submitted, so it is deleted, and it is gone.
- **What the API refuses comes back under its own box.** A customer and an archived supplier are both
  `purchase_supplier_invalid`, an unknown warehouse `purchase_warehouse_invalid`. The lines' problems come in one
  answer, items and rates together: an archived product, a unit that is not the product's, 1.5 buttons, a VAT rate
  that does not exist. That is what `checkPurchaseItems()` was split out for in 17b.3.
- **The contract's rules come first**, as a 400: a delivery date before the order date, a 120% discount, no lines.
- **A draft changes freely**; a page opened before the change gets `version_conflict`. Jamal reads every order, but
  writing, changing and submitting one are 403s that name `purchase.order.manage`.

### Approval

```ts
describe('approval', () => {
  it("has its own levels, apart from the requisition's, and numbers the order when submitted", async () => {
    // From ৳1,00,000 (VAT included) the purchase manager approves; requisitions need nobody
    const res = await send('PUT', '/approval-rules/purchase_order', {
      levels: [{ minAmount: '100000', roleId: purchaseManager.id }],
      version: 0,
    });
    expect(res.statusCode, res.body).toBe(200);
    const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
    expect(items.map((item) => [item.document, item.levels.length])).toEqual([
      ['requisition', 0],
      ['purchase_order', 1],
    ]);

    order = await acted('submit', order);
    expect(order).toMatchObject({ number: 'PO-2026-27-0001', status: 'pending' });
    expect(order.approval.rounds[0]).toMatchObject({
      status: 'pending',
      amount: '243340.0000',
      submittedBy: { name: 'Mitu Akter' },
      steps: [{ position: 1, role: { name: 'Purchase manager' }, decision: null }],
    });
    // A submitted order is not changed, and not deleted
    const late = await send('PUT', `/purchase-orders/${order.id}`, formOf(order), mitu);
    expect(problemOf(late).code).toBe('purchase_not_draft');

    // Kamal is told, and sees who it is from
    expect(await bell(kamal)).toContainEqual(['approval.requested', 'PO-2026-27-0001']);
    const waiting = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting', undefined, kamal)).json(),
    );
    expect(waiting.items).toMatchObject([
      {
        document: 'purchase_order',
        id: order.id,
        number: 'PO-2026-27-0001',
        subject: 'Meghna Spinning Mills Ltd.',
        amount: '243340.0000',
        position: 1,
        stepCount: 1,
      },
    ]);
    order = await approvedBy(order, kamal);
    expect(order.status).toBe('approved');
    expect(await bell(mitu)).toContainEqual(['approval.approved', 'PO-2026-27-0001']);

    // Below the level: approved at once, numbered all the same
    small = await ordered([line(buttons, '5000', '1.20')], {
      supplierId: karim.id,
      date: '2026-10-13',
    });
    small = await acted('submit', small);
    expect(small).toMatchObject({
      number: 'PO-2026-27-0002',
      status: 'approved',
      total: '6900.0000',
    });
  });

  it('go back to draft to change, keeping the number and the supplier, then start from level 1', async () => {
    order = await acted('reopen', order);
    expect(order).toMatchObject({ number: 'PO-2026-27-0001', status: 'draft' });
    // The approved round stays approved: it was
    expect(order.approval.rounds.map((round) => round.status)).toEqual(['approved']);

    // The number went to Meghna: the order cannot move to another supplier
    const other = await send(
      'PUT',
      `/purchase-orders/${order.id}`,
      formOf(order, { supplierId: karim.id }),
      mitu,
    );
    expect(other.statusCode).toBe(409);
    expect(problemOf(other).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    const removed = await send(
      'DELETE',
      `/purchase-orders/${order.id}?version=${String(order.version)}`,
      undefined,
      mitu,
    );
    expect(problemOf(removed).code).toBe('purchase_was_submitted');

    // 1,000 more buttons: ৳7,000 before VAT, so ৳2,44,720 in all
    const [jerseyLine, buttonLine] = formOf(order).lines;
    if (!jerseyLine || !buttonLine) throw new Error('the order lost a line');
    order = await updated(order, { lines: [jerseyLine, { ...buttonLine, quantity: '6000' }] });
    expect(order.total).toBe('244720.0000');
    order = await acted('submit', order);
    expect(order.approval.rounds.map((round) => [round.status, round.amount])).toEqual([
      ['pending', '244720.0000'],
      ['approved', '243340.0000'],
    ]);
    order = await approvedBy(order, kamal);
    expect(order.status).toBe('approved');
  });

  it('are cancelled, never deleted, once numbered; a pending one is reopened first', async () => {
    dropped = await ordered([line(buttons, '100000', '1.05')], { date: '2026-10-14' });
    // Never submitted: it is deleted, not cancelled
    expect(problemOf(await act('cancel', dropped)).code).toBe('purchase_delete_instead');
    dropped = await acted('submit', dropped);
    expect(dropped.status).toBe('pending');
    expect(problemOf(await act('cancel', dropped)).code).toBe('purchase_cannot_cancel');
    dropped = await acted('reopen', dropped);
    // The pending round ends as reopened: nobody is asked any more
    expect(dropped.approval.rounds[0]?.status).toBe('reopened');
    const waiting = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting', undefined, kamal)).json(),
    );
    expect(waiting.items).toEqual([]);
    dropped = await acted('cancel', dropped);
    expect(dropped).toMatchObject({ number: 'PO-2026-27-0003', status: 'cancelled' });
    expect(problemOf(await act('reopen', dropped)).code).toBe('purchase_cannot_reopen');
    expect(problemOf(await act('submit', dropped)).code).toBe('purchase_not_draft');

    // Closing is for an order that was partly received: one with nothing in is cancelled
    expect(problemOf(await act('close', small)).code).toBe('purchase_cancel_instead');
    const draft = await ordered([line(buttons, '1', '1')]);
    expect(problemOf(await act('close', draft)).code).toBe('purchase_not_approved');
    await send('DELETE', `/purchase-orders/${draft.id}?version=${String(draft.version)}`);
  });

  it('check the supplier again when submitted', async () => {
    // A draft keeps a supplier archived after it was written, so it can be finished; it is not
    // sent to a supplier the company stopped buying from
    let draft = await ordered([line(buttons, '100', '1.10')], { supplierId: karim.id });
    karim = await supplierNow(karim.id);
    const archived = await send('POST', `/suppliers/${karim.id}/archive`, {
      version: karim.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    draft = await updated(draft, { note: 'Pack in 100s' });
    const res = await act('submit', draft);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    karim = await supplierNow(karim.id);
    const restored = await send('POST', `/suppliers/${karim.id}/restore`, {
      version: karim.version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    await send('DELETE', `/purchase-orders/${draft.id}?version=${String(draft.version)}`);
  });
});
```

- **Orders have their own levels.** From ৳1,00,000 the purchase manager approves; requisitions still need nobody.
  The rule list shows both kinds, each with its own version, so the first save of the orders' rule is from version
  0 although the requisitions' rule exists.
- **Submitting numbers the order** (`PO-2026-27-0001`) and starts a round with the total VAT included (decision
  14): ৳2,43,340. Kamal is told and sees it with the supplier's name as its subject; after his approval Mitu is told.
- **Below the level, approved at once**, and numbered all the same.
- **Reopen keeps the number and the supplier** (decision 33). The approved round stays "approved", because it was.
  Moving the order to Karim is `purchase_supplier_invalid`, deleting it is `purchase_was_submitted`. Changed and
  submitted again, it gets round 2 from level 1, for the new total (৳2,44,720).
- **Cancel**: an unnumbered draft is `purchase_delete_instead` (nobody saw it, so it is deleted); a pending one is
  `purchase_cannot_cancel` (someone may be deciding it); reopened first, its round ends as "reopened" and leaves
  Kamal's list, and then it is cancelled with its number. A cancelled order is not reopened or submitted.
- **Close is for a partly received order**: an approved one with nothing in is `purchase_cancel_instead`, a draft
  `purchase_not_approved`.
- **The supplier is checked again at submit** (decision 34). A draft keeps Karim after he is archived, and saves;
  submitting it is `purchase_supplier_invalid` under the supplier box.

### Requisitions to orders

```ts
describe('requisitions to orders', () => {
  it('offer the lines still to order, and count each order line against its requisition line', async () => {
    // The store asks for 30 rolls of jersey and 3,000 buttons; with no levels, approved at once
    const asked = await send(
      'POST',
      '/requisitions',
      {
        date: '2026-10-11',
        warehouseId: main.id,
        neededBy: '2026-10-28',
        note: '',
        lines: [
          {
            variantId: variantOf(jersey),
            unitId: unitId('roll'),
            quantity: '30',
            description: '',
            estimatedCost: '10500',
          },
          {
            variantId: variantOf(buttons),
            unitId: unitId('pcs'),
            quantity: '3000',
            description: '',
            estimatedCost: '1.20',
          },
        ],
      },
      jamal,
    );
    expect(asked.statusCode, asked.body).toBe(201);
    const draft = requisitionSchema.parse(asked.json());
    const submitted = await send(
      'POST',
      `/requisitions/${draft.id}/submit`,
      { version: draft.version },
      jamal,
    );
    requisition = requisitionSchema.parse(submitted.json());
    expect(requisition).toMatchObject({ status: 'approved', orderState: 'not_ordered' });
    expect(await openLines(main)).toEqual([
      [requisition.number, 'Single jersey 160 GSM, white', '750.0000'],
      [requisition.number, 'Polo button 18L', '3000.0000'],
    ]);

    // 20 rolls now, from Meghna: even a draft order holds them, so nobody orders them twice
    firstPart = await ordered([
      line(jersey, '20', '10290', {
        unitId: unitId('roll'),
        requisitionLineId: requisitionLineOf(requisition, jersey),
      }),
    ]);
    expect(firstPart.requisitions).toEqual([{ id: requisition.id, number: requisition.number }]);
    expect(firstPart.lines[0]?.requisitionLine).toEqual({
      id: requisitionLineOf(requisition, jersey),
      requisitionId: requisition.id,
      number: requisition.number,
    });
    requisition = await requisitionNow(requisition.id);
    expect(requisition).toMatchObject({
      orderState: 'partly_ordered',
      orders: [{ id: firstPart.id, number: null }],
    });
    expect(requisition.lines.map((item) => item.orderedQuantity)).toEqual(['500.0000', '0.0000']);
    expect(await openLines(main)).toEqual([
      [requisition.number, 'Single jersey 160 GSM, white', '250.0000'],
      [requisition.number, 'Polo button 18L', '3000.0000'],
    ]);

    // The rest on a second order to Meghna, the buttons with it. Ordered in full: the
    // requisition leaves the buyer's list.
    const rest = await ordered([
      line(jersey, '10', '10290', {
        unitId: unitId('roll'),
        requisitionLineId: requisitionLineOf(requisition, jersey),
      }),
      line(buttons, '3000', '1.15', { requisitionLineId: requisitionLineOf(requisition, buttons) }),
    ]);
    expect((await requisitionNow(requisition.id)).orderState).toBe('ordered');
    expect(await openLines(main)).toEqual([]);
    const toOrder = requisitionPageSchema.parse(
      (await send('GET', '/requisitions?order=to_order', undefined, mitu)).json(),
    );
    expect(toOrder.items).toEqual([]);

    // Deleted, the second order gives its quantities back
    const removed = await send(
      'DELETE',
      `/purchase-orders/${rest.id}?version=${String(rest.version)}`,
      undefined,
      mitu,
    );
    expect(removed.statusCode).toBe(204);
    requisition = await requisitionNow(requisition.id);
    expect(requisition.orderState).toBe('partly_ordered');
  });

  it('refuse a line of another store, another item, an unapproved requisition, or one line twice', async () => {
    const forKonabari = await send(
      'POST',
      '/requisitions',
      {
        date: '2026-10-11',
        warehouseId: konabari.id,
        neededBy: '',
        note: '',
        lines: [
          {
            variantId: variantOf(buttons),
            unitId: unitId('pcs'),
            quantity: '500',
            description: '',
            estimatedCost: '1.20',
          },
        ],
      },
      jamal,
    );
    const asked = requisitionSchema.parse(forKonabari.json());
    const submitted = await send(
      'POST',
      `/requisitions/${asked.id}/submit`,
      { version: asked.version },
      jamal,
    );
    konabariAsk = requisitionSchema.parse(submitted.json());
    // Each store's form offers its own requisitions
    expect(await openLines(konabari)).toEqual([
      [konabariAsk.number, 'Polo button 18L', '500.0000'],
    ]);
    const draftAsk = await send(
      'POST',
      '/requisitions',
      {
        date: '2026-10-11',
        warehouseId: main.id,
        neededBy: '',
        note: '',
        lines: [
          {
            variantId: variantOf(buttons),
            unitId: unitId('pcs'),
            quantity: '200',
            description: '',
            estimatedCost: '1.20',
          },
        ],
      },
      jamal,
    );
    const notYet = requisitionSchema.parse(draftAsk.json());
    const res = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        // A requisition for Konabari on an order for the main store
        line(buttons, '500', '1.20', {
          requisitionLineId: requisitionLineOf(konabariAsk, buttons),
        }),
        // Buttons on the jersey line
        line(buttons, '10', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, jersey),
        }),
        // A draft requisition: its lines may still change
        line(buttons, '200', '1.20', { requisitionLineId: requisitionLineOf(notYet, buttons) }),
      ]),
      mitu,
    );
    expect(res.statusCode).toBe(409);
    // One code for every reason: the form only offers lines that fit
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.requisitionLineId': ['purchase_requisition_line_invalid'],
      'lines.1.requisitionLineId': ['purchase_requisition_line_invalid'],
      'lines.2.requisitionLineId': ['purchase_requisition_line_invalid'],
    });
    const twice = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        line(buttons, '100', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, buttons),
        }),
        line(buttons, '100', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, buttons),
        }),
      ]),
      mitu,
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.1.requisitionLineId': ['purchase_requisition_line_twice'],
    });
  });

  it('keep a requisition an order buys for from being reopened or cancelled; it is closed instead', async () => {
    for (const action of ['reopen', 'cancel'] as const) {
      const res = await send(
        'POST',
        `/requisitions/${requisition.id}/${action}`,
        { version: requisition.version },
        jamal,
      );
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('purchase_close_instead');
    }
    // The other 10 rolls will not be bought: closed, it leaves the list
    const closed = await send(
      'POST',
      `/requisitions/${requisition.id}/close`,
      { version: requisition.version },
      jamal,
    );
    expect(closed.statusCode, closed.body).toBe(200);
    requisition = requisitionSchema.parse(closed.json());
    expect(requisition).toMatchObject({ status: 'closed', orderState: 'partly_ordered' });
    expect(await openLines(main)).toEqual([]);
    // A new order cannot buy for it; the draft that already does still saves
    const late = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        line(buttons, '100', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, buttons),
        }),
      ]),
      mitu,
    );
    expect(problemOf(late).fieldErrors).toEqual({
      'lines.0.requisitionLineId': ['purchase_requisition_line_invalid'],
    });
    const kept = await updated(await orderNow(firstPart.id), { note: 'Roll width 72 inches' });
    expect(kept.lines[0]?.requisitionLine?.id).toBe(requisitionLineOf(requisition, jersey));
    // Deleted, the draft lets the closed requisition count nothing ordered
    await send('DELETE', `/purchase-orders/${kept.id}?version=${String(kept.version)}`);
    expect((await requisitionNow(requisition.id)).orderState).toBe('not_ordered');

    // A requisition nothing was ordered for is cancelled, not closed
    const nothing = await send(
      'POST',
      `/requisitions/${konabariAsk.id}/close`,
      { version: konabariAsk.version },
      jamal,
    );
    expect(problemOf(nothing).code).toBe('purchase_cancel_instead');
  });
});
```

- **The order form offers what is still to order**: Jamal's requisition asks for 30 rolls (750 kg) and 3,000
  buttons, and both lines are offered in full.
- **Even a draft order holds what it buys** (decision 27): after a draft of 20 rolls, the requisition is "partly
  ordered", its jersey line has 500 kg ordered, and the form offers the other 250 kg. The order lists the
  requisition, and its line names the requisition line with the requisition's number, for the page's link.
- **Many requisition lines on one order**: 10 more rolls and the buttons on a second order make the requisition
  "ordered". It leaves the form's list and the buyer's "to order" filter. Deleting that order gives the quantities
  back.
- **A line that does not fit is one error code**, `purchase_requisition_line_invalid`, under its line: a
  requisition for another store, the jersey line on a buttons line, a requisition still in draft. The form only
  offers lines that fit, so the API does not say which rule failed. Each store's form offers its own requisitions.
  The same requisition line twice is the contract's `purchase_requisition_line_twice`.
- **An ordered requisition is closed, not reopened or cancelled** (`purchase_close_instead`): reopening would write
  its lines again under the order's links. Closed, it leaves the list; a new order cannot buy for it, but the draft
  that already does still saves (the "kept" link of `checkRequisitionLines()`). A requisition nothing was ordered
  for is cancelled instead (`purchase_cancel_instead`).

### The price a line starts with

```ts
describe('the price a line starts with', () => {
  it("is this supplier's last price, else anyone's, else the average cost", async () => {
    // PO-0001 bought jersey from Meghna at ৳10,500 a roll less 2% (৳411.60 a kg) and buttons at
    // ৳1.20 less ৳200 on 6,000 (৳1.1667); PO-0002 bought buttons from Karim at ৳1.20, a day later.
    // The cancelled PO-0003 and every draft are no price anybody agreed.
    expect(
      await costs(meghna.id, [
        { product: jersey, unit: 'roll' },
        { product: jersey, unit: 'kg' },
        { product: buttons, unit: 'pcs' },
      ]),
    ).toEqual([
      ['10290.0000', 'supplier_price'],
      ['411.6000', 'supplier_price'],
      ['1.1667', 'supplier_price'],
    ]);
    // Karim never sold jersey: Meghna's price is the last one anybody paid
    expect(
      await costs(karim.id, [
        { product: jersey, unit: 'roll' },
        { product: buttons, unit: 'pcs' },
      ]),
    ).toEqual([
      ['10290.0000', 'last_price'],
      ['1.2000', 'supplier_price'],
    ]);
    // No supplier chosen yet: the newest order's price
    expect(await costs(null, [{ product: buttons, unit: 'pcs' }])).toEqual([
      ['1.2000', 'last_price'],
    ]);
    // Never bought: the average cost, for someone who may see it; dyeing was never ordered
    expect(
      await costs(
        null,
        [
          { product: rib, unit: 'kg' },
          { product: dyeing, unit: 'kg' },
        ],
        owner,
      ),
    ).toEqual([
      ['380.0000', 'average_cost'],
      [null, null],
    ]);
    expect(await costs(null, [{ product: rib, unit: 'kg' }])).toEqual([[null, null]]);
  });

  it("starts the VAT rate at the product's own, else the workspace default", async () => {
    const res = await lookup(meghna.id, [
      { product: rib, unit: 'kg' },
      { product: jersey, unit: 'kg' },
    ]);
    expect(costLookupSchema.parse(res.json()).items.map((item) => item.taxRateId)).toEqual([
      rateId('Exempt'),
      defaultRateId(),
    ]);
  });
});
```

- **This supplier's last price first** (decision 19): Meghna sold the jersey at ৳411.60 a kg (৳10,500 a roll less
  2%), so a roll starts at ৳10,290. The buttons start at ৳1.1667: ৳7,000 ÷ 6,000, after the line's ৳200 discount.
- **Then anyone's last price**: Karim never sold jersey, so Meghna's price is the one to start from. With no
  supplier chosen yet, the newest order wins: Karim's ৳1.20, a day after Meghna's.
- **Only prices somebody agreed**: the cancelled order at ৳1.05 is newer than both, and counts for nothing. We
  broke this on purpose (any order but a draft) and this test failed.
- **Then the average cost**, for someone who may see it: rib at ৳380 for the Owner, nothing for Mitu. A service
  that was never ordered has no cost at all.
- **The VAT rate starts at the product's own** (rib is exempt), else the workspace's default.

### The order goes out

```ts
describe('the purchase order goes out', () => {
  it('only once approved: not a draft, a pending order or a cancelled one', async () => {
    const draft = await ordered([line(buttons, '1', '1')]);
    const pending = await acted('submit', await ordered([line(jersey, '400', '420')]));
    expect(pending.status).toBe('pending');
    for (const id of [draft.id, pending.id, dropped.id]) {
      const res = await send('POST', `${documentPath(id)}/files`, { language: 'en' }, mitu);
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('document_not_issued');
    }
    await send('DELETE', `/purchase-orders/${draft.id}?version=${String(draft.version)}`);
    await acted('cancel', await acted('reopen', pending));
  });

  it('as a PDF with the supplier, where to deliver, the terms and the amount in words', async () => {
    firstFile = await fileOf(order.id, 'en');
    const ready = await finished(order.id, firstFile.id);
    expect(ready).toMatchObject({ status: 'ready', fileName: 'PO-2026-27-0001.pdf' });
    const model = await modelOf(firstFile.id);
    expect(model).toMatchObject({
      language: 'en',
      title: 'Purchase order',
      number: 'PO-2026-27-0001',
      party: {
        label: 'Supplier',
        name: 'Meghna Spinning Mills Ltd.',
        code: meghna.code,
        lines: ['Plot 14, Nayapara', 'Narsingdi'],
      },
      facts: [
        {
          label: 'Deliver to',
          value: 'Main store, Plot 22, BSCIC Industrial Area, Konabari, Gazipur',
        },
      ],
      words: 'In words: Two lakh forty-four thousand seven hundred twenty taka only',
      signatures: ['Prepared by', 'Authorised signature'],
    });
    expect(model.meta).toEqual([
      { label: 'No.', value: 'PO-2026-27-0001' },
      { label: 'Date', value: '12 Oct 2026' },
      { label: 'Deliver by', value: '25 Oct 2026' },
      { label: 'Your reference', value: 'PI-2210' },
      { label: 'Payment terms', value: '60 days' },
    ]);
    expect(model.table?.rows.map((row) => row.cells)).toEqual([
      [
        '1',
        'Single jersey 160 GSM, white',
        '20 roll',
        '৳10,500.00',
        // A percent discount as the sales documents print it (step 16)
        '2.00%',
        'VAT 15%',
        '৳2,05,800.00',
      ],
      [
        '2',
        'Polo button 18L, white, 4-hole',
        '6,000 pcs',
        '৳1.20',
        '৳200.00',
        'VAT 15%',
        '৳7,000.00',
      ],
    ]);
    // 2% of ৳2,10,000 and ৳200 off the buttons
    expect(model.totals?.rows).toEqual([
      { label: 'Line discounts', value: '−৳4,400.00', strong: false },
      { label: 'Before VAT', value: '৳2,12,800.00', strong: false },
      { label: 'VAT', value: '৳31,920.00', strong: false },
      { label: 'Total', value: '৳2,44,720.00', strong: true },
    ]);
    const bangla = await modelOf((await fileOf(order.id, 'bn')).id);
    expect(bangla).toMatchObject({ title: 'পারচেজ অর্ডার', party: { label: 'সরবরাহকারী' } });
    expect(bangla.meta.at(-1)).toEqual({ label: 'পেমেন্টের মেয়াদ', value: '৬০ দিন' });
  });

  it('by email to the supplier, with the PDF attached', async () => {
    const draft = documentEmailDraftSchema.parse(
      (
        await send('GET', `${documentPath(order.id)}/email-draft?language=en`, undefined, mitu)
      ).json(),
    );
    expect(draft).toEqual({
      to: 'sales@meghnaspinning.com',
      subject: 'Purchase order PO-2026-27-0001 from Padma Knit Composite Ltd.',
      message:
        'Dear Meghna Spinning Mills Ltd.,\n\n' +
        'Please find attached our purchase order PO-2026-27-0001 for ৳2,44,720.00. ' +
        'Please deliver by 25 Oct 2026.\n\n' +
        'Regards,\nMitu Akter\nPadma Knit Composite Ltd.',
    });
    const res = await send(
      'POST',
      `${documentPath(order.id)}/emails`,
      { ...draft, cc: '', language: 'en' },
      mitu,
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(documentEmailSchema.parse(res.json()).to).toEqual(['sales@meghnaspinning.com']);
    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'sales@meghnaspinning.com'), 8_000);
    expect(sent.subject).toBe('Purchase order PO-2026-27-0001 from Padma Knit Composite Ltd.');
    const [attachment] = sent.attachments;
    expect(attachment).toMatchObject({
      fileName: 'PO-2026-27-0001.pdf',
      contentType: 'application/pdf',
    });
    const bytes = await attachmentOf(mail.apiUrl, sent, attachment?.partId ?? '');
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  }, 20_000);

  it("by a WhatsApp link to the supplier's number, whose page names the supplier", async () => {
    const res = await send('POST', `${documentPath(order.id)}/shares`, { language: 'en' }, mitu);
    expect(res.statusCode, res.body).toBe(201);
    const made = createdShareSchema.parse(res.json());
    expect(made.whatsAppUrl).toMatch(/^https:\/\/wa\.me\/8801711223344\?text=/);
    const token = /\/d\/([\w-]{22})$/.exec(made.url)?.[1] ?? '';
    const opened = await send('GET', `/public/documents/${token}`, undefined, null);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(publicDocumentSchema.parse(opened.json())).toMatchObject({
      kind: 'purchase_order',
      number: 'PO-2026-27-0001',
      recipient: 'Meghna Spinning Mills Ltd.',
      company: 'Padma Knit Composite Ltd.',
      total: '244720.0000',
      dueDate: null,
    });
  });

  it('only by someone who buys; anyone signed in downloads it', async () => {
    for (const res of [
      await send('POST', `${documentPath(order.id)}/shares`, { language: 'en' }, jamal),
      await send('GET', `${documentPath(order.id)}/email-draft?language=en`, undefined, jamal),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).params).toEqual({ permissions: 'purchase.order.manage' });
    }
    const asked = await send('POST', `${documentPath(order.id)}/files`, { language: 'en' }, jamal);
    expect(documentFileSchema.parse(asked.json()).id).toBe(firstFile.id);
  });
});
```

- **Only once approved** (decision 35): a draft, a pending order and a cancelled one are `document_not_issued`.
- **The PDF says what a supplier needs**: "Supplier" with Meghna's address, the delivery date, "Your reference" for
  the supplier's PI number, 60 days' terms, and where to deliver, written out from the warehouse's name and
  address. The lines are step 16's table (the percent discount is printed "2.00%", as on an invoice). The totals
  show the line discounts (৳4,400) because there are some. An order is a promise to pay, so it has the amount in
  words, in lakhs: "Two lakh forty-four thousand seven hundred twenty taka only". The Bangla file says পারচেজ অর্ডার
  and "৬০ দিন".
- **The email goes to the supplier**, from Mitu, with "Please deliver by 25 Oct 2026" in the message and the PDF
  attached (read back from Mailpit).
- **The WhatsApp link goes to the supplier's number** (`8801711223344`), and the public page names the supplier as
  `recipient`, with no due date.
- **Sending needs `purchase.order.manage`**; downloading is reading, so Jamal gets the same ready file.

### In use

```ts
describe('in use', () => {
  it('keeps a supplier and a product an order names', async () => {
    karim = await supplierNow(karim.id);
    const supplier = await send(
      'DELETE',
      `/suppliers/${karim.id}?version=${String(karim.version)}`,
    );
    expect(supplier.statusCode).toBe(409);
    expect(problemOf(supplier).code).toBe('supplier_in_use');
    // A party that also buys from the company: the order still holds its supplier side, which
    // no foreign key can say (the party row stays)
    const both = await send('POST', `/suppliers/${meghna.id}/make-customer`, {
      version: (await supplierNow(meghna.id)).version,
    });
    expect(both.statusCode, both.body).toBe(200);
    meghna = await supplierNow(meghna.id);
    const side = await send('DELETE', `/suppliers/${meghna.id}?version=${String(meghna.version)}`);
    expect(problemOf(side).code).toBe('supplier_in_use');
    // An order line keeps its product, on a cancelled order too
    const product = await send(
      'DELETE',
      `/products/${buttons.id}?version=${String(buttons.version)}`,
    );
    expect(problemOf(product).code).toBe('product_in_use');
  });
});
```

- **A supplier an order names stays**: `supplier_in_use`, from `purchase_orders_supplier_fk`.
- **The supplier side of a party that is both** stays too. Here no foreign key can speak (the party row stays), so
  `dropSupplierSide()` looks for the orders itself. We took `purchase_orders` out of that `UNION ALL` on purpose and
  this test failed.
- **A product on an order line stays**: `product_in_use` (`purchase_order_lines_variant_fk`, added to
  `VARIANT_IN_USE` in 17b.3).

### `purchase/goods-receipts.int.spec.ts` (new): the setup

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  branchSchema,
  type GoodsReceipt,
  type GoodsReceiptFormValues,
  type GoodsReceiptLineFormValues,
  goodsReceiptPageSchema,
  goodsReceiptSchema,
  journalEntrySchema,
  memberPageSchema,
  openRequisitionLinePageSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type PurchaseOrder,
  type PurchaseOrderFormValues,
  type PurchaseOrderLineFormValues,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  type Requisition,
  requisitionSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  stockAccountsSchema,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  type Supplier,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
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

// Step 17b: a knit and woven garments factory takes in fabric, dye, sewing machines and buttons
// against its purchase orders. There are no approval levels, so an order the Owner submits is
// approved at once and every test starts from approved orders. Each test builds on the ones
// before it: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Rafiq, the Owner: writes the orders and sees every value
let owner: SignedIn;
// Jamal, the store keeper: receives at the gate. purchase.receipt.manage only, so no stock values.
let jamal: SignedIn;
let units: Unit[];
let rates: TaxRate[];
let accounts: Account[];
let main: Warehouse;
// A second branch's store: a truck may unload there instead
let ashulia: Warehouse;
let mill: Supplier;
let trims: Supplier;
// Cotton twill by the metre (2 decimals)
let twill: Product;
// Reactive dye by the kg, kept by lot with an expiry date
let dye: Product;
// Sewing machines, one serial number each
let machine: Product;
// Buttons by the piece, bought by the box of 144
let buttons: Product;
// A service on the order: carriage is billed, never received
let carriage: Product;
// Twill, dye, machines and carriage from the mill, before VAT
let orderA: PurchaseOrder;
// Buttons from the trims supplier, priced with VAT, for a store requisition
let orderB: PurchaseOrder;
let requisition: Requisition;
// The first receipt against order A
let first: GoodsReceipt;

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

function accountId(code: string): string {
  const found = accounts.find((item) => item.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  const found = accounts.find((item) => item.id === id);
  if (!found) throw new Error(`no account ${id}`);
  return found.code;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

// The id of an order's line for this product
function lineOf(order: PurchaseOrder, product: Product): string {
  const found = order.lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${order.number ?? 'the order'}`);
  return found.id;
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

async function addSupplier(name: string): Promise<Supplier> {
  const res = await send('POST', '/suppliers', {
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
  });
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

// A user who signs up for a workspace of their own, then joins this one with a role of their own
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
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'tarabo-knit' });
  const made = await send('POST', '/roles', { name: `${fullName}'s role`, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'tarabo-knit', email, password, keepSignedIn: false });
}

// An order line as the form sends it: in the product's base unit, 15% VAT, no discount
function orderLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<PurchaseOrderLineFormValues> = {},
): PurchaseOrderLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: product.baseUnitId,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    requisitionLineId: '',
    ...extra,
  };
}

// Written and submitted by the Owner: with no approval levels, approved at once
async function approvedOrder(
  supplier: Supplier,
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
): Promise<PurchaseOrder> {
  const draft = await draftOrder(supplier, lines, extra);
  const res = await send('POST', `/purchase-orders/${draft.id}/submit`, {
    version: draft.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  const order = purchaseOrderSchema.parse(res.json());
  expect(order.status).toBe('approved');
  return order;
}

async function draftOrder(
  supplier: Supplier,
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
): Promise<PurchaseOrder> {
  const res = await send('POST', '/purchase-orders', {
    supplierId: supplier.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: main.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return purchaseOrderSchema.parse(res.json());
}

async function orderNow(id: string): Promise<PurchaseOrder> {
  const res = await send('GET', `/purchase-orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

// An order action that takes the version: reopen, close, cancel
function act(action: 'reopen' | 'close' | 'cancel', order: PurchaseOrder, as = owner) {
  return send('POST', `/purchase-orders/${order.id}/${action}`, { version: order.version }, as);
}

// A receipt line as the store keeper types it: in the base unit, nothing turned back
function receiptLine(
  order: PurchaseOrder,
  product: Product,
  quantity: string,
  extra: Partial<GoodsReceiptLineFormValues> = {},
): GoodsReceiptLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: product.baseUnitId,
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    orderLineId: lineOf(order, product),
    rejectedQuantity: '',
    rejectionReason: '',
    ...extra,
  };
}

function receiptForm(
  order: PurchaseOrder,
  lines: GoodsReceiptLineFormValues[],
  extra: Partial<GoodsReceiptFormValues> = {},
): GoodsReceiptFormValues {
  return {
    orderId: order.id,
    date: '2026-10-14',
    warehouseId: main.id,
    supplierChallan: '',
    vehicle: '',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function received(body: GoodsReceiptFormValues, as = jamal): Promise<GoodsReceipt> {
  const res = await send('POST', '/goods-receipts', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return goodsReceiptSchema.parse(res.json());
}

async function receiptNow(id: string, as = owner): Promise<GoodsReceipt> {
  const res = await send('GET', `/goods-receipts/${id}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return goodsReceiptSchema.parse(res.json());
}

function postDraft(draft: GoodsReceipt, as = jamal) {
  return send('POST', `/goods-receipts/${draft.id}/post`, { version: draft.version }, as);
}

// A journal entry as [account code, debit, credit, branch] rows
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [
    codeOf(item.accountId),
    item.debit,
    item.credit,
    item.branchId,
  ]);
}

// What /stock shows for a warehouse: on hand and still coming, per product name. Only goods.
async function stockIn(warehouse: Warehouse) {
  const page = stockPageSchema.parse(
    (await send('GET', `/stock?warehouseId=${warehouse.id}&limit=50`)).json(),
  );
  return Object.fromEntries(
    page.items.map((item) => [item.productName, [item.onHand, item.incoming]]),
  );
}

async function cardOf(product: Product) {
  return stockCardSchema.parse((await send('GET', `/stock/variants/${variantOf(product)}`)).json());
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
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Tarabo Knit & Woven Ltd.',
    workspaceSlug: 'tarabo-knit',
    fullName: 'Rafiq Islam',
    email: 'rafiq@taraboknit.com',
    password: 'Tarabo-factory-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const [firstWarehouse] = warehouseListSchema.parse(
    (await send('GET', '/warehouses')).json(),
  ).items;
  if (!firstWarehouse) throw new Error('sign-up made no warehouse');
  main = firstWarehouse;
  const branch = branchSchema.parse(
    (
      await send('POST', '/branches', { code: 'ASH', name: 'Ashulia', phone: '', address: '' })
    ).json(),
  );
  const store = await send('POST', '/warehouses', {
    branchId: branch.id,
    code: 'ASH',
    name: 'Ashulia store',
    address: '',
  });
  expect(store.statusCode, store.body).toBe(201);
  ashulia = warehouseSchema.parse(store.json());

  jamal = await member('jamal@taraboknit.com', 'Jamal Uddin', 'Gate-register-2026', [
    'purchase.receipt.manage',
  ]);
  mill = await addSupplier('Nayapara Weaving Mills');
  trims = await addSupplier('Karim Trims & Accessories');
  twill = await addProduct('Cotton twill 3/1, khaki', { baseUnitId: unitId('m') });
  dye = await addProduct('Reactive dye, black', {
    baseUnitId: unitId('kg'),
    tracking: 'batch',
    hasExpiry: true,
  });
  machine = await addProduct('Juki DDL-8700 sewing machine', { tracking: 'serial' });
  buttons = await addProduct('Polo button 18L', {
    units: [{ unitId: unitId('box'), factor: '144', barcode: '' }],
  });
  carriage = await addProduct('Carriage inward', { type: 'service' });

  // 1,000 m at ৳312.50 is ৳3,12,500; 50 kg at ৳900 less 10% is ৳40,500; 3 machines at ৳85,000
  // are ৳2,55,000; and ৳5,000 for the truck. All before VAT.
  orderA = await approvedOrder(mill, [
    orderLine(twill, '1000', '312.50'),
    orderLine(dye, '50', '900', { discount: '10' }),
    orderLine(machine, '3', '85000'),
    orderLine(carriage, '1', '5000'),
  ]);

  // The store asks for 10 boxes of buttons; the order buys them at ৳172.50 a box with VAT, which
  // is ৳150 a box before it
  const asked = await send('POST', '/requisitions', {
    date: '2026-10-10',
    warehouseId: main.id,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: variantOf(buttons),
        unitId: unitId('box'),
        quantity: '10',
        description: '',
        estimatedCost: '150',
      },
    ],
  });
  expect(asked.statusCode, asked.body).toBe(201);
  const draft = requisitionSchema.parse(asked.json());
  const submitted = await send('POST', `/requisitions/${draft.id}/submit`, {
    version: draft.version,
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  requisition = requisitionSchema.parse(submitted.json());
  const [askedLine] = requisition.lines;
  if (!askedLine) throw new Error('the requisition has no line');
  orderB = await approvedOrder(
    trims,
    [
      orderLine(buttons, '10', '172.50', {
        unitId: unitId('box'),
        requisitionLineId: askedLine.id,
      }),
    ],
    { pricesIncludeVat: true },
  );
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **No approval levels**, so an order the Owner submits is approved at once, and every test starts from approved
  orders. This file is about the gate, not the approval.
- **Jamal has `purchase.receipt.manage` only.** He receives everything in this file, and never sees what the books
  say it is worth: the value tests read the same receipt as the Owner.
- **A second branch's store** (Ashulia), because the entry is booked with the branch of the warehouse that received
  the goods.
- **Five products, one for each kind of line**: twill by the metre, dye by the lot with an expiry date, sewing
  machines by serial number, buttons by the box of 144, and carriage, a service the order pays for but nobody
  receives.
- **Order A has all of them, before VAT**: 1,000 m of twill at ৳312.50 (৳3,12,500), 50 kg of dye at ৳900 less 10%
  (৳40,500), 3 machines at ৳85,000 (৳2,55,000) and ৳5,000 of carriage. **Order B** buys 10 boxes of buttons at
  ৳172.50 with VAT (৳150 a box before it) for a store requisition, so a closed order can give the rest back.
- **`receiptLine()` names the order line of its product**, and `receiptForm()` posts by default, like the form's
  "Post" button. `stockIn()` reads the stock page as `[on hand, incoming]` per product.

### Receiving

```ts
describe('goods receipts', () => {
  it('are written only against an approved order, which the form offers', async () => {
    expect([orderA.number, orderB.number]).toEqual(['PO-2026-27-0001', 'PO-2026-27-0002']);
    const draft = await draftOrder(mill, [orderLine(twill, '100', '300')]);
    const early = await send(
      'POST',
      '/goods-receipts',
      receiptForm(draft, [receiptLine(draft, twill, '100')]),
      jamal,
    );
    expect(early.statusCode).toBe(409);
    expect(problemOf(early).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
    const unknown = await send(
      'POST',
      '/goods-receipts',
      { ...receiptForm(orderA, [receiptLine(orderA, twill, '1')]), orderId: requisition.id },
      jamal,
    );
    expect(unknown.statusCode).toBe(409);
    expect(problemOf(unknown).fieldErrors).toEqual({ orderId: ['grn_order_invalid'] });
    const removed = await send(
      'DELETE',
      `/purchase-orders/${draft.id}?version=${String(draft.version)}`,
    );
    expect(removed.statusCode).toBe(204);

    // The store keeper reads the orders that still have goods to come, oldest last
    const offered = purchaseOrderPageSchema.parse(
      (await send('GET', '/purchase-orders?receipt=to_receive', undefined, jamal)).json(),
    );
    expect(offered.items.map((item) => [item.number, item.partlyReceived])).toEqual([
      ['PO-2026-27-0002', false],
      ['PO-2026-27-0001', false],
    ]);
    // ...but writes none
    const notHis = await send(
      'POST',
      '/purchase-orders',
      { supplierId: mill.id, lines: [] },
      jamal,
    );
    expect(notHis.statusCode).toBe(403);
  });

  it("brings in what was accepted at the order's price, and books it as received but not billed", async () => {
    first = await received(
      receiptForm(
        orderA,
        [
          receiptLine(orderA, twill, '600'),
          receiptLine(orderA, dye, '30', {
            lotNumber: 'RD-2610',
            expiresOn: '2028-03-31',
            rejectedQuantity: '2',
            rejectionReason: 'Two bags damp and lumpy',
          }),
          receiptLine(orderA, machine, '2', { serialNumbers: ['JK87-10021', 'JK87-10022'] }),
        ],
        { supplierChallan: 'NWM-5521', vehicle: 'Dhaka Metro-Ta 14-2231' },
      ),
    );
    expect(first).toMatchObject({
      number: 'GRN-2026-27-0001',
      status: 'posted',
      supplier: { id: mill.id, name: 'Nayapara Weaving Mills' },
      order: { id: orderA.id, number: 'PO-2026-27-0001' },
      supplierChallan: 'NWM-5521',
      lineCount: 3,
    });
    // Jamal may not see what the books say the goods are worth
    expect(first.lines.map((line) => line.value)).toEqual([null, null, null]);

    // At the order's price, before VAT and after the discount: 600 of 1,000 m of ৳3,12,500 is
    // ৳1,87,500; 30 of 50 kg of ৳40,500 is ৳24,300; 2 of 3 machines of ৳2,55,000 is ৳1,70,000
    const asOwner = await receiptNow(first.id);
    expect(
      asOwner.lines.map((line) => [
        line.baseQuantity,
        line.rejectedBaseQuantity,
        line.rejectionReason,
        line.value,
      ]),
    ).toEqual([
      ['600.0000', '0.0000', null, '187500.0000'],
      ['30.0000', '2.0000', 'Two bags damp and lumpy', '24300.0000'],
      ['2.0000', '0.0000', null, '170000.0000'],
    ]);
    if (!asOwner.entry) throw new Error('expected an entry');
    expect(await entryLines(asOwner.entry.id)).toEqual([
      ['1154', '381800.0000', '0.0000', main.branchId],
      ['2115', '0.0000', '381800.0000', main.branchId],
    ]);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${asOwner.entry.id}`)).json(),
    );
    expect(entry).toMatchObject({
      source: 'purchase_receipt',
      document: { id: first.id, number: 'GRN-2026-27-0001' },
      narration: 'Goods receipt GRN-2026-27-0001',
    });

    // The order counts what was accepted, and what was turned back apart from it
    const order = await orderNow(orderA.id);
    expect(order).toMatchObject({ status: 'approved', partlyReceived: true });
    expect(order.lines.map((line) => [line.receivedQuantity, line.rejectedQuantity])).toEqual([
      ['600.0000', '0.0000'],
      ['30.0000', '2.0000'],
      ['2.0000', '0.0000'],
      ['0.0000', '0.0000'],
    ]);
    expect(order.receipts).toEqual([
      { id: first.id, number: 'GRN-2026-27-0001', date: '2026-10-14', status: 'posted' },
    ]);

    // On hand, and still to come from approved orders. The 2 kg turned back are still owed.
    expect(await stockIn(main)).toMatchObject({
      'Cotton twill 3/1, khaki': ['600.0000', '400.0000'],
      'Reactive dye, black': ['30.0000', '20.0000'],
      'Juki DDL-8700 sewing machine': ['2.0000', '1.0000'],
      'Polo button 18L': ['0.0000', '1440.0000'],
    });
    const dyeCard = await cardOf(dye);
    expect(dyeCard.item.unitCost).toBe('810.0000');
    expect(dyeCard.batches).toMatchObject([
      { lotNumber: 'RD-2610', expiresOn: '2028-03-31', warehouseId: main.id, quantity: '30.0000' },
    ]);
    expect((await cardOf(machine)).serials).toEqual([
      { serialNumber: 'JK87-10021', warehouseId: main.id },
      { serialNumber: 'JK87-10022', warehouseId: main.id },
    ]);
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(twill)}/movements`)).json(),
    );
    expect(history.items.at(-1)).toMatchObject({
      kind: 'purchase_receipt',
      documentNumber: 'GRN-2026-27-0001',
      quantity: '600.0000',
    });
  });

  it('check every line against its product and its order line, each under its own field', async () => {
    const items = await send(
      'POST',
      '/goods-receipts',
      receiptForm(
        orderA,
        [
          // A lot is needed for what comes in, and one serial number per machine
          receiptLine(orderA, dye, '5'),
          receiptLine(orderA, machine, '1'),
          // Carriage is a service: it never comes through the gate
          receiptLine(orderA, carriage, '1'),
          receiptLine(orderA, twill, '10', { unitId: unitId('pcs') }),
        ],
        { post: false },
      ),
      jamal,
    );
    expect(items.statusCode).toBe(409);
    expect(problemOf(items).fieldErrors).toEqual({
      'lines.0.lotNumber': ['stock_lot_required'],
      'lines.1.serialNumbers': ['stock_serial_count'],
      'lines.2.variantId': ['stock_variant_invalid'],
      'lines.3.unitId': ['stock_unit_invalid'],
    });
    // Twill against the dye line, and buttons against order B's line
    const lines = await send(
      'POST',
      '/goods-receipts',
      receiptForm(
        orderA,
        [
          receiptLine(orderA, twill, '10', { orderLineId: lineOf(orderA, dye) }),
          receiptLine(orderB, buttons, '10'),
        ],
        { post: false },
      ),
      jamal,
    );
    expect(problemOf(lines).fieldErrors).toEqual({
      'lines.0.orderLineId': ['grn_order_line_invalid'],
      'lines.1.orderLineId': ['grn_order_line_invalid'],
    });
    // The form's own rules: a rejection says why, and a line with nothing on it is a mistake
    const rules = await send(
      'POST',
      '/goods-receipts',
      receiptForm(
        orderA,
        [
          receiptLine(orderA, twill, '10', { rejectedQuantity: '2' }),
          receiptLine(orderA, twill, '0'),
        ],
        { post: false },
      ),
      jamal,
    );
    expect(rules.statusCode).toBe(400);
    expect(problemOf(rules).fieldErrors).toEqual({
      'lines.0.rejectionReason': ['grn_rejection_reason'],
      'lines.1.quantity': ['grn_line_empty'],
    });
  });

  it('never bring in more than the order line still takes, unless the workspace allows a little more', async () => {
    const twillLine = lineOf(orderA, twill);
    // 400 m are left of the 1,000
    const over = await send(
      'POST',
      '/goods-receipts',
      receiptForm(orderA, [receiptLine(orderA, twill, '428')]),
      jamal,
    );
    expect(over.statusCode).toBe(409);
    expect(problemOf(over).fieldErrors).toEqual({ 'lines.0.quantity': ['grn_over_order'] });
    // Two lots of one order line count together, and both are marked
    const split = await send(
      'POST',
      '/goods-receipts',
      receiptForm(orderA, [
        receiptLine(orderA, twill, '200', { orderLineId: twillLine }),
        receiptLine(orderA, twill, '228', { orderLineId: twillLine }),
      ]),
      jamal,
    );
    expect(problemOf(split).fieldErrors).toEqual({
      'lines.0.quantity': ['grn_over_order'],
      'lines.1.quantity': ['grn_over_order'],
    });

    // The mills seldom cut to the metre: the factory allows 3% over the order
    const settings = settingsSchema.parse((await send('GET', '/settings')).json());
    const saved = await send('PUT', '/settings', {
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
      pricesIncludeVat: settings.pricesIncludeVat,
      overReceiptPercent: '3',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // 3% of 3 machines is not a fourth one
    const fourth = await send(
      'POST',
      '/goods-receipts',
      receiptForm(orderA, [
        receiptLine(orderA, machine, '2', { serialNumbers: ['JK87-10023', 'JK87-10024'] }),
      ]),
      jamal,
    );
    expect(problemOf(fourth).fieldErrors).toEqual({ 'lines.0.quantity': ['grn_over_order'] });

    // Drafts hold nothing: two of them may each take the 428 m still allowed (1,030 − 600). Posted
    // at the same moment, the order is locked by the first, and the second then sees it full.
    const draft = () =>
      received(receiptForm(orderA, [receiptLine(orderA, twill, '428')], { post: false }));
    const one = await draft();
    const two = await draft();
    const results = await Promise.all([postDraft(one), postDraft(two)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((res) => res.statusCode === 409);
    expect(loser && problemOf(loser).fieldErrors).toEqual({
      'lines.0.quantity': ['grn_over_order'],
    });
    const winner = goodsReceiptSchema.parse(results.find((res) => res.statusCode === 200)?.json());
    expect(winner.number).toBe('GRN-2026-27-0002');
    // What came over the order is worth the order's price per metre: 428 m of ৳312.50
    expect((await receiptNow(winner.id)).lines[0]?.value).toBe('133750.0000');
    // The loser moved nothing and used no number; the store keeper deletes it
    const still = await receiptNow(winner.id === one.id ? two.id : one.id);
    expect(still).toMatchObject({ status: 'draft', number: null });
    const removed = await send(
      'DELETE',
      `/goods-receipts/${still.id}?version=${String(still.version)}`,
      undefined,
      jamal,
    );
    expect(removed.statusCode).toBe(204);

    // 1,028 m came in against 1,000: nothing more is coming, and never less than nothing
    const order = await orderNow(orderA.id);
    expect(order.lines[0]?.receivedQuantity).toBe('1028.0000');
    expect((await stockIn(main))['Cotton twill 3/1, khaki']).toEqual(['1028.0000', '0.0000']);
  });

  it('turn a whole line back, and bring nothing in for it', async () => {
    // Nothing accepted: no lot to give, no stock, no value, no entry
    const back = await received(
      receiptForm(orderA, [
        receiptLine(orderA, dye, '0', {
          rejectedQuantity: '5',
          rejectionReason: 'Wrong shade: navy, not black',
        }),
      ]),
    );
    expect(back).toMatchObject({ number: 'GRN-2026-27-0003', status: 'posted', entry: null });
    const asOwner = await receiptNow(back.id);
    expect(asOwner.lines.map((line) => [line.baseQuantity, line.lotNumber, line.value])).toEqual([
      ['0.0000', null, '0.0000'],
    ]);
    const order = await orderNow(orderA.id);
    expect([order.lines[1]?.receivedQuantity, order.lines[1]?.rejectedQuantity]).toEqual([
      '30.0000',
      '7.0000',
    ]);
    expect((await stockIn(main))['Reactive dye, black']).toEqual(['30.0000', '20.0000']);
  });
```

- **Only an approved order** (decision 8): a draft's is `purchase_not_approved` and an id that is no order is
  `grn_order_invalid`, both under the order box. The form's list (`receipt=to_receive`) is the approved orders with
  goods to come. Jamal reads them and writes no order.
- **What was accepted comes in at the order's price** (decisions 2, 6, 39): 600 of 1,000 m is ৳1,87,500, 30 of 50
  kg is ৳24,300 (after the 10% discount, before VAT), 2 of 3 machines ৳1,70,000. The entry is Dr Finished garments
  (1154, the garments chart's inventory account) and Cr Goods received not billed (2115), ৳3,81,800, with the
  main branch, `source: 'purchase_receipt'`, and the receipt as its document.
- **The 2 kg turned back are on the record and still owed**: the order counts 30 kg received and 2 kg rejected, and
  20 kg are still coming. The dye's average is ৳810 a kg, its lot has the expiry date, and both machines are in
  stock by serial number. The stock card's history shows a `purchase_receipt` movement.
- **Every line is checked against its product and its order line.** A lot for what comes in, one serial number per
  machine, no service, the product's own units: four errors in one answer. Twill against the dye line and buttons
  against order B's line are both `grn_order_line_invalid`. The contract's rules come first: a rejection needs a
  reason, and a line with nothing on it is `grn_line_empty`.
- **Never more than the order line still takes** (decision 7). 428 m against the 400 left is `grn_over_order`, and
  two lots of one order line count together, both marked. At 3% (Settings), 1,030 m may come in, so 428 m fits;
  but 3% of 3 machines is not a fourth one.
- **Two drafts, posted at the same moment** (decision 40): each took all 428 m when it was saved. The first post
  locks the order; the second waits, then sees the order full and is `grn_over_order`. It moved nothing and used no
  number (the winner is GRN-0002, and the next receipt is GRN-0003). What came over the order is worth the order's
  price per metre: 428 m is ৳1,33,750.
- **"Incoming" never goes below zero** (decision 41): 1,028 m came against 1,000, so nothing more is coming. We
  took out the `greatest(…, 0)` on purpose and this test failed. We also let the limit forget what earlier receipts
  brought in, and it failed too.
- **A whole line turned back** needs no lot: nothing came in, so there is no stock, the value is ৳0, and there is
  no entry at all (decision 38).

### Finishing an order

```ts
  it('complete the order with the last receipt, wherever the truck unloads; the service does not hold it open', async () => {
    const last = await received(
      receiptForm(
        orderA,
        [
          receiptLine(orderA, dye, '20', { lotNumber: 'RD-2611', expiresOn: '2028-06-30' }),
          receiptLine(orderA, machine, '1', { serialNumbers: ['JK87-10023'] }),
        ],
        { warehouseId: ashulia.id, date: '2026-10-16' },
      ),
    );
    expect(last.number).toBe('GRN-2026-27-0004');
    // The goods are in Ashulia, so the entry is the Ashulia branch's: 20 of 50 kg of ৳40,500 is
    // ৳16,200, and the third machine ৳85,000
    const entry = (await receiptNow(last.id)).entry;
    if (!entry) throw new Error('expected an entry');
    expect(await entryLines(entry.id)).toEqual([
      ['1154', '101200.0000', '0.0000', ashulia.branchId],
      ['2115', '0.0000', '101200.0000', ashulia.branchId],
    ]);
    const order = await orderNow(orderA.id);
    expect(order).toMatchObject({ status: 'received', partlyReceived: false });
    expect(order.lines[3]?.receivedQuantity).toBe('0.0000');
    expect(await stockIn(ashulia)).toMatchObject({
      'Reactive dye, black': ['20.0000', '0.0000'],
      'Juki DDL-8700 sewing machine': ['1.0000', '0.0000'],
    });
    // A received order is no longer coming anywhere
    expect(await stockIn(main)).toMatchObject({
      'Reactive dye, black': ['30.0000', '0.0000'],
      'Juki DDL-8700 sewing machine': ['2.0000', '0.0000'],
    });

    // It is done: no receipt, no reopen, no close, no cancel
    const more = await send(
      'POST',
      '/goods-receipts',
      receiptForm(order, [receiptLine(order, twill, '1')]),
      jamal,
    );
    expect(problemOf(more).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
    for (const [action, code] of [
      ['reopen', 'purchase_cannot_reopen'],
      ['close', 'purchase_not_approved'],
      ['cancel', 'purchase_cannot_cancel'],
    ] as const) {
      const res = await act(action, order);
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe(code);
    }
    const offered = purchaseOrderPageSchema.parse(
      (await send('GET', '/purchase-orders?receipt=to_receive')).json(),
    );
    expect(offered.items.map((item) => item.number)).toEqual(['PO-2026-27-0002']);
    const list = goodsReceiptPageSchema.parse(
      (await send('GET', `/goods-receipts?orderId=${orderA.id}`, undefined, jamal)).json(),
    );
    expect(list.items.map((item) => item.number)).toEqual([
      'GRN-2026-27-0004',
      'GRN-2026-27-0003',
      'GRN-2026-27-0002',
      'GRN-2026-27-0001',
    ]);
  });

  it('close a partly received order; the rest goes back to the requisition', async () => {
    const part = await received(
      receiptForm(orderB, [receiptLine(orderB, buttons, '6', { unitId: unitId('box') })]),
    );
    // 864 of 1,440 pieces of a line worth ৳1,500 before VAT
    expect((await receiptNow(part.id)).lines[0]).toMatchObject({
      baseQuantity: '864.0000',
      value: '900.0000',
    });
    const draft = await received(
      receiptForm(orderB, [receiptLine(orderB, buttons, '2', { unitId: unitId('box') })], {
        post: false,
      }),
    );
    let order = await orderNow(orderB.id);
    // Goods came in: closed, not reopened or cancelled
    for (const action of ['reopen', 'cancel'] as const) {
      const res = await act(action, order);
      expect(problemOf(res).code).toBe('purchase_close_instead');
    }
    // Only the buyer closes it
    expect((await act('close', order, jamal)).statusCode).toBe(403);
    const closed = await act('close', order);
    expect(closed.statusCode, closed.body).toBe(200);
    order = purchaseOrderSchema.parse(closed.json());
    expect(order.status).toBe('closed');

    // The draft written before can no longer post, nor be saved; it can be deleted
    const late = await postDraft(draft);
    expect(late.statusCode).toBe(409);
    expect(problemOf(late).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
    const removed = await send(
      'DELETE',
      `/goods-receipts/${draft.id}?version=${String(draft.version)}`,
      undefined,
      jamal,
    );
    expect(removed.statusCode).toBe(204);
    expect((await stockIn(main))['Polo button 18L']).toEqual(['864.0000', '0.0000']);

    // A closed order bought only what came: the other 4 boxes are wanted again
    const asked = requisitionSchema.parse(
      (await send('GET', `/requisitions/${requisition.id}`)).json(),
    );
    expect(asked).toMatchObject({ status: 'approved', orderState: 'partly_ordered' });
    expect(asked.lines[0]?.orderedQuantity).toBe('864.0000');
    const open = openRequisitionLinePageSchema.parse(
      (await send('GET', `/requisition-lines?warehouseId=${main.id}`)).json(),
    );
    expect(open.items.map((line) => [line.requisition.id, line.remainingQuantity])).toEqual([
      [requisition.id, '576.0000'],
    ]);
  });

  it('keep an order with a draft receipt from being reopened or cancelled', async () => {
    let order = await approvedOrder(mill, [orderLine(twill, '500', '300')]);
    const draft = await received(
      receiptForm(order, [receiptLine(order, twill, '100')], { post: false }),
    );
    for (const [action, code] of [
      ['reopen', 'purchase_receipt_draft'],
      ['cancel', 'purchase_receipt_draft'],
      // Nothing came in yet: it is cancelled, not closed
      ['close', 'purchase_cancel_instead'],
    ] as const) {
      const res = await act(action, order);
      expect(problemOf(res).code).toBe(code);
    }
    const removed = await send(
      'DELETE',
      `/goods-receipts/${draft.id}?version=${String(draft.version)}`,
      undefined,
      jamal,
    );
    expect(removed.statusCode).toBe(204);
    const cancelled = await act('cancel', order);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    order = purchaseOrderSchema.parse(cancelled.json());
    expect(order.status).toBe('cancelled');
    // A cancelled order brings nothing
    expect((await stockIn(main))['Cotton twill 3/1, khaki']).toEqual(['1028.0000', '0.0000']);
  });

  it('let a reopen and a receipt at the same moment take turns: the second one sees the first', async () => {
    const order = await approvedOrder(mill, [orderLine(twill, '100', '300')]);
    const [reopened, receipt] = await Promise.all([
      act('reopen', order),
      send('POST', '/goods-receipts', receiptForm(order, [receiptLine(order, twill, '60')]), jamal),
    ]);
    const after = await orderNow(order.id);
    if (reopened.statusCode === 200) {
      // The reopen locked the order first: the receipt then found a draft
      expect(receipt.statusCode).toBe(409);
      expect(problemOf(receipt).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
      expect([after.status, after.receipts]).toEqual(['draft', []]);
    } else {
      // The receipt came first: posting it gave the order a new version, so the reopen is a
      // page that is out of date. Read again, it is refused: goods came in.
      expect(problemOf(reopened).code).toBe('version_conflict');
      expect(receipt.statusCode, receipt.body).toBe(201);
      expect(after).toMatchObject({ status: 'approved', partlyReceived: true });
      const again = await act('reopen', after);
      expect(problemOf(again).code).toBe('purchase_close_instead');
    }
  });
```

- **The last receipt makes the order "received"**, wherever the truck unloads: the rest of the dye and the third
  machine go to Ashulia, and the entry (৳1,01,200) is the Ashulia branch's. The carriage line received nothing and
  does not hold the order open. Nothing is coming anywhere any more, and a received order takes no receipt and is
  not reopened, closed or cancelled. The order's receipts list newest first.
- **A partly received order is closed** (decision 29). Goods came in, so a reopen or a cancel is
  `purchase_close_instead`; closing needs `purchase.order.manage`, so Jamal cannot. The draft receipt written before
  can no longer post (`purchase_not_approved`), and is deleted.
- **A closed order bought only what came**: 6 of 10 boxes (864 pieces, ৳900 of ৳1,500). The requisition is "partly
  ordered" again and the form offers the other 576 pieces. We made a closed order count in full on purpose, and
  this test failed.
- **A draft receipt keeps its order from being reopened or cancelled** (`purchase_receipt_draft`, decision 21):
  the store keeper deletes it first. With nothing received, close is `purchase_cancel_instead`.
- **A reopen and a receipt at the same moment take turns.** Both lock the order `FOR UPDATE`, so one waits. If
  the reopen goes first, the receipt finds a draft: `purchase_not_approved`. If the receipt goes first, posting it
  gave the order a new version, so the reopen is a page that is out of date (`version_conflict`), and read again it
  is `purchase_close_instead`. The test accepts either order and checks that each one ends consistently.

### Posted is final

```ts
  it("stay as posted, outside the journal's Reverse and its manual entries", async () => {
    // The edit form sends everything but the order
    const changed = await send(
      'PUT',
      `/goods-receipts/${first.id}`,
      {
        date: first.date,
        warehouseId: main.id,
        supplierChallan: '',
        vehicle: '',
        note: '',
        lines: [receiptLine(orderA, twill, '1')],
        post: false,
        version: first.version,
      },
      jamal,
    );
    expect(problemOf(changed).code).toBe('stock_not_draft');
    const removed = await send(
      'DELETE',
      `/goods-receipts/${first.id}?version=${String(first.version)}`,
      undefined,
      jamal,
    );
    expect(problemOf(removed).code).toBe('stock_not_draft');
    expect(problemOf(await postDraft(first)).code).toBe('stock_not_draft');

    // The entry is the receipt's: a purchase return (17d) takes goods back, not Reverse
    const entryId = first.entry?.id ?? '';
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${entryId}`)).json(),
    );
    const reversed = await send('POST', `/journal-entries/${entryId}/reverse`, {
      version: entry.version,
      date: '2026-10-16',
    });
    expect(problemOf(reversed).code).toBe('journal_is_stock');
    // Goods received not billed holds only what receipts brought in: no manual line, no opening
    // balance
    const manual = await send('POST', '/journal-entries', {
      date: '2026-10-16',
      narration: '',
      lines: [
        { accountId: accountId('2115'), branchId: '', description: '', debit: '100', credit: '' },
        { accountId: accountId('1110'), branchId: '', description: '', debit: '', credit: '100' },
      ],
      post: false,
    });
    expect(manual.statusCode).toBe(409);
    expect(problemOf(manual).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_stock'],
    });
    const opening = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: accountId('2115'), debit: '', credit: '5000' }],
    });
    expect(problemOf(opening).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_stock'],
    });
    // Settings → Inventory shows the account the receipts use
    const chosen = stockAccountsSchema.parse((await send('GET', '/stock-accounts')).json());
    expect(chosen.received_not_billed).toBe(accountId('2115'));
  });

  it('keep the books equal to the stock, and the account equal to what receipts brought in', async () => {
    const summary = valuationSummarySchema.parse(
      (await send('GET', '/stock/valuation/summary')).json(),
    );
    expect(summary.difference).toBe('0.0000');
    const [row] = await superuserSql(
      (sql) => sql<{ owed: string; received: string }[]>`
        SELECT
          (SELECT sum(l.credit - l.debit)::text FROM journal_lines l
             JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            WHERE a.code = '2115' AND a.tenant_id = (SELECT tenant_id FROM warehouses WHERE id = ${main.id})) AS owed,
          (SELECT sum(gl.value)::text FROM goods_receipt_lines gl
             JOIN goods_receipts g ON g.tenant_id = gl.tenant_id AND g.id = gl.receipt_id
            WHERE g.status = 'posted' AND g.warehouse_id IN (${main.id}, ${ashulia.id})) AS received`,
    );
    // ৳3,81,800 + ৳1,33,750 + ৳0 + ৳1,01,200 + ৳900, and the race test's ৳18,000 if it posted
    expect(row?.owed).toBe(row?.received);
  });
});
```

- **A posted receipt is not changed, deleted or posted again**: `stock_not_draft`. Goods that go back are a purchase
  return (17d).
- **Its entry is out of the journal's Reverse** (`journal_is_stock`), and goods received not billed takes no
  manual line and no opening balance (`journal_account_stock`, decision 37). Settings → Inventory shows 2115 as the
  account receipts use.
- **The books agree with the stock**: the valuation summary's difference is `0.0000`, and the balance of 2115 is
  the sum of every posted receipt line's value, read straight from the tables.

### `purchase/purchase-orders.tenant-leak.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  costLookupSchema,
  type GoodsReceipt,
  goodsReceiptPageSchema,
  goodsReceiptSchema,
  memberPageSchema,
  openRequisitionLinePageSchema,
  type PermissionKey,
  type Product,
  productSchema,
  problemSchema,
  type PurchaseOrder,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  type Requisition,
  requisitionSchema,
  roleSchema,
  setupSchema,
  stockPageSchema,
  type Supplier,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
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

// Step 17b. Two workspaces: A must never see, change, approve, send or receive against B's
// purchase orders and goods receipts, use B's suppliers, items, rates, requisition lines or order
// lines on its own documents, or count B's orders in its stock and prices. Every answer is 404, or
// the same "pick one from the list" as for an id that does not exist.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
// B's merchandiser: B's orders above B's level wait for B's purchase manager
let buyerOfB: SignedIn;
let unitsOfA: Unit[];
let unitsOfB: Unit[];
let ratesOfA: TaxRate[];
let ratesOfB: TaxRate[];
let warehouseOfA: Warehouse;
let warehouseOfB: Warehouse;
let productOfA: Product;
let productOfB: Product;
let supplierOfA: Supplier;
let supplierOfB: Supplier;
let requisitionOfB: Requisition;
// Approved and partly received
let orderOfB: PurchaseOrder;
// Waiting for B's purchase manager
let pendingOfB: PurchaseOrder;
// A draft receipt against orderOfB
let draftReceiptOfB: GoodsReceipt;
let orderOfA: PurchaseOrder;

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

function vatOf(rates: TaxRate[]): string {
  const found = rates.find((rate) => rate.name === 'VAT 15%');
  if (!found) throw new Error('no VAT 15%');
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function firstWarehouse(who: SignedIn): Promise<Warehouse> {
  const [found] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!found) throw new Error('no warehouse');
  return found;
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

async function addSupplier(who: SignedIn, name: string): Promise<Supplier> {
  const res = await as(who, 'POST', '/suppliers', {
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
  });
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

// A user of B with these permissions: signs up for a workspace of their own, then joins B
async function memberOfB(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[],
): Promise<{ who: SignedIn; roleId: string }> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'banani-denim' });
  const made = await as(tenantB, 'POST', '/roles', { name: `${fullName}'s role`, description: '' });
  const role = roleSchema.parse(made.json());
  const matrix = await as(tenantB, 'PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
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
  const who = await logIn(app, { workspace: 'banani-denim', email, password, keepSignedIn: false });
  return { who, roleId: role.id };
}

// An order of one line by the piece at 15% VAT
function orderForm(
  supplier: Supplier,
  warehouse: Warehouse,
  product: Product,
  units: Unit[],
  rates: TaxRate[],
  extra: { quantity?: string; unitPrice?: string; requisitionLineId?: string } = {},
) {
  return {
    supplierId: supplier.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: warehouse.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines: [
      {
        variantId: variantOf(product),
        unitId: pcsOf(units),
        quantity: extra.quantity ?? '100',
        description: '',
        unitPrice: extra.unitPrice ?? '250',
        discountType: 'percent',
        discount: '',
        taxRateId: vatOf(rates),
        requisitionLineId: extra.requisitionLineId ?? '',
      },
    ],
  };
}

async function created(who: SignedIn, body: object): Promise<PurchaseOrder> {
  const res = await as(who, 'POST', '/purchase-orders', body);
  expect(res.statusCode, res.body).toBe(201);
  return purchaseOrderSchema.parse(res.json());
}

async function submitted(who: SignedIn, order: PurchaseOrder): Promise<PurchaseOrder> {
  const res = await as(who, 'POST', `/purchase-orders/${order.id}/submit`, {
    version: order.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

function receiptForm(order: PurchaseOrder, warehouse: Warehouse, units: Unit[], post: boolean) {
  const [line] = order.lines;
  if (!line) throw new Error('the order has no line');
  return {
    orderId: order.id,
    date: '2026-10-14',
    warehouseId: warehouse.id,
    supplierChallan: '',
    vehicle: '',
    note: '',
    lines: [
      {
        variantId: line.variantId,
        unitId: pcsOf(units),
        quantity: '40',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        orderLineId: line.id,
        rejectedQuantity: '',
        rejectionReason: '',
      },
    ],
    post,
  };
}

async function orderOfBNow(): Promise<PurchaseOrder> {
  return purchaseOrderSchema.parse(
    (await as(tenantB, 'GET', `/purchase-orders/${orderOfB.id}`)).json(),
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
  unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
  ratesOfA = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
  ratesOfB = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  warehouseOfA = await firstWarehouse(tenantA);
  warehouseOfB = await firstWarehouse(tenantB);
  productOfA = await addProduct(tenantA, 'Single jersey, black', unitsOfA);
  productOfB = await addProduct(tenantB, 'Denim 12 oz, indigo', unitsOfB);
  supplierOfA = await addSupplier(tenantA, 'Ashulia Yarn House');
  supplierOfB = await addSupplier(tenantB, 'Banani Denim Mills');

  // B's requisition, approved at once (B has no requisition levels), bought for by B's order
  const asked = await as(tenantB, 'POST', '/requisitions', {
    date: '2026-10-10',
    warehouseId: warehouseOfB.id,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: variantOf(productOfB),
        unitId: pcsOf(unitsOfB),
        quantity: '100',
        description: '',
        estimatedCost: '250',
      },
    ],
  });
  const draft = requisitionSchema.parse(asked.json());
  const approved = await as(tenantB, 'POST', `/requisitions/${draft.id}/submit`, {
    version: draft.version,
  });
  requisitionOfB = requisitionSchema.parse(approved.json());
  const [askedLine] = requisitionOfB.lines;
  if (!askedLine) throw new Error('the requisition has no line');
  orderOfB = await submitted(
    tenantB,
    await created(
      tenantB,
      orderForm(supplierOfB, warehouseOfB, productOfB, unitsOfB, ratesOfB, {
        requisitionLineId: askedLine.id,
      }),
    ),
  );
  expect(orderOfB.status).toBe('approved');
  const posted = await as(tenantB, 'POST', '/goods-receipts', {
    ...receiptForm(orderOfB, warehouseOfB, unitsOfB, true),
  });
  expect(posted.statusCode, posted.body).toBe(201);
  const draftReceipt = await as(
    tenantB,
    'POST',
    '/goods-receipts',
    receiptForm(orderOfB, warehouseOfB, unitsOfB, false),
  );
  expect(draftReceipt.statusCode, draftReceipt.body).toBe(201);
  draftReceiptOfB = goodsReceiptSchema.parse(draftReceipt.json());
  orderOfB = await orderOfBNow();

  // From ৳1,00,000 B's purchase manager approves; B's merchandiser writes one of ৳2,87,500
  const manager = await memberOfB('rakib@bananidenim.com', 'Rakib Hasan', 'Banani-buy-2026', [
    'purchase.order.manage',
  ]);
  const levels = await as(tenantB, 'PUT', '/approval-rules/purchase_order', {
    levels: [{ minAmount: '100000', roleId: manager.roleId }],
    version: 0,
  });
  expect(levels.statusCode, levels.body).toBe(200);
  buyerOfB = (
    await memberOfB('babul@bananidenim.com', 'Babul Mia', 'Banani-merch-2026', [
      'purchase.order.manage',
    ])
  ).who;
  pendingOfB = await submitted(
    buyerOfB,
    await created(
      buyerOfB,
      orderForm(supplierOfB, warehouseOfB, productOfB, unitsOfB, ratesOfB, { quantity: '1000' }),
    ),
  );
  expect(pendingOfB.status).toBe('pending');

  orderOfA = await created(
    tenantA,
    orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfA),
  );
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("another workspace's purchase orders", () => {
  it('are never shown, changed or moved', async () => {
    const before = await orderOfBNow();
    const version = { version: before.version };
    const tries = [
      as(tenantA, 'GET', `/purchase-orders/${orderOfB.id}`),
      as(tenantA, 'PUT', `/purchase-orders/${orderOfB.id}`, {
        ...orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfA),
        ...version,
      }),
      as(tenantA, 'DELETE', `/purchase-orders/${orderOfB.id}?version=${String(before.version)}`),
      ...(['submit', 'reopen', 'close', 'cancel'] as const).map((action) =>
        as(tenantA, 'POST', `/purchase-orders/${orderOfB.id}/${action}`, version),
      ),
    ];
    for (const res of await Promise.all(tries)) expect(res.statusCode).toBe(404);
    const after = await orderOfBNow();
    expect([after.status, after.version]).toEqual([before.status, before.version]);

    // A's lists have only A's, whatever the filter names
    for (const query of ['', `?supplierId=${supplierOfB.id}`, '?receipt=to_receive']) {
      const page = purchaseOrderPageSchema.parse(
        (await as(tenantA, 'GET', `/purchase-orders${query}`)).json(),
      );
      expect(page.items.every((item) => item.id === orderOfA.id)).toBe(true);
    }
  });

  it("are never approved from A, and never in A's waiting list", async () => {
    const [round] = pendingOfB.approval.rounds;
    const res = await as(tenantA, 'POST', `/approvals/purchase_order/${pendingOfB.id}/approve`, {
      roundId: round?.id ?? '',
      comment: '',
    });
    expect(res.statusCode).toBe(404);
    const waiting = waitingApprovalPageSchema.parse(
      (await as(tenantA, 'GET', '/approvals/waiting')).json(),
    );
    expect(waiting.items).toEqual([]);
    // B's Owner sees it, still waiting
    const ofB = waitingApprovalPageSchema.parse(
      (await as(tenantB, 'GET', '/approvals/waiting')).json(),
    );
    expect(ofB.items.map((item) => item.id)).toEqual([pendingOfB.id]);
  });

  it('never go out from A: no PDF, email or share link', async () => {
    const path = `/documents/purchase_order/${orderOfB.id}`;
    const tries = [
      as(tenantA, 'POST', `${path}/files`, { language: 'en' }),
      as(tenantA, 'GET', `${path}/email-draft?language=en`),
      as(tenantA, 'POST', `${path}/shares`, { language: 'en' }),
    ];
    for (const res of await Promise.all(tries)) expect(res.statusCode).toBe(404);
  });

  it("lend A nothing: B's supplier, store, item, VAT rate or requisition line", async () => {
    const [lineOfB] = requisitionOfB.lines;
    const tries: [object, Record<string, string[]>][] = [
      [
        orderForm(supplierOfB, warehouseOfA, productOfA, unitsOfA, ratesOfA),
        { supplierId: ['purchase_supplier_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfB, productOfA, unitsOfA, ratesOfA),
        { warehouseId: ['purchase_warehouse_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfA, productOfB, unitsOfA, ratesOfA),
        { 'lines.0.variantId': ['purchase_item_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfB),
        { 'lines.0.taxRateId': ['tax_rate_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfA, {
          requisitionLineId: lineOfB?.id ?? '',
        }),
        { 'lines.0.requisitionLineId': ['purchase_requisition_line_invalid'] },
      ],
    ];
    for (const [body, fieldErrors] of tries) {
      const res = await as(tenantA, 'POST', '/purchase-orders', body);
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).fieldErrors).toEqual(fieldErrors);
    }
    // B's requisition still counts only B's order
    const asked = requisitionSchema.parse(
      (await as(tenantB, 'GET', `/requisitions/${requisitionOfB.id}`)).json(),
    );
    expect(asked.orders.map((item) => item.id)).toEqual([orderOfB.id]);
    // ...and A's order form never offers its lines, even when asked for B's store
    for (const warehouse of [warehouseOfA, warehouseOfB]) {
      const open = openRequisitionLinePageSchema.parse(
        (await as(tenantA, 'GET', `/requisition-lines?warehouseId=${warehouse.id}`)).json(),
      );
      expect(open.items).toEqual([]);
    }
  });
});

describe("another workspace's goods receipts", () => {
  it('are never shown, changed, posted or deleted', async () => {
    const tries = [
      as(tenantA, 'GET', `/goods-receipts/${draftReceiptOfB.id}`),
      as(tenantA, 'PUT', `/goods-receipts/${draftReceiptOfB.id}`, {
        date: '2026-10-15',
        warehouseId: warehouseOfA.id,
        supplierChallan: '',
        vehicle: '',
        note: '',
        lines: receiptForm(orderOfB, warehouseOfA, unitsOfA, false).lines,
        post: false,
        version: draftReceiptOfB.version,
      }),
      as(tenantA, 'POST', `/goods-receipts/${draftReceiptOfB.id}/post`, {
        version: draftReceiptOfB.version,
      }),
      as(
        tenantA,
        'DELETE',
        `/goods-receipts/${draftReceiptOfB.id}?version=${String(draftReceiptOfB.version)}`,
      ),
    ];
    for (const res of await Promise.all(tries)) expect(res.statusCode).toBe(404);
    const still = goodsReceiptSchema.parse(
      (await as(tenantB, 'GET', `/goods-receipts/${draftReceiptOfB.id}`)).json(),
    );
    expect([still.status, still.version]).toEqual(['draft', draftReceiptOfB.version]);
    const page = goodsReceiptPageSchema.parse(
      (await as(tenantA, 'GET', `/goods-receipts?orderId=${orderOfB.id}`)).json(),
    );
    expect(page.items).toEqual([]);
  });

  it("never take goods against B's order or B's order lines", async () => {
    const res = await as(
      tenantA,
      'POST',
      '/goods-receipts',
      receiptForm(orderOfB, warehouseOfA, unitsOfA, true),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ orderId: ['grn_order_invalid'] });

    // A's own approved order, with B's order line and then B's store
    const approved = await submitted(tenantA, orderOfA);
    const [lineOfB] = orderOfB.lines;
    const form = receiptForm(approved, warehouseOfA, unitsOfA, true);
    const stolenLine = await as(tenantA, 'POST', '/goods-receipts', {
      ...form,
      lines: form.lines.map((line) => ({ ...line, orderLineId: lineOfB?.id ?? '' })),
    });
    expect(problemOf(stolenLine).fieldErrors).toEqual({
      'lines.0.orderLineId': ['grn_order_line_invalid'],
    });
    const elsewhere = await as(tenantA, 'POST', '/goods-receipts', {
      ...form,
      warehouseId: warehouseOfB.id,
    });
    expect(problemOf(elsewhere).fieldErrors).toEqual({ warehouseId: ['stock_warehouse_invalid'] });
    // B's order took in only what B's own receipt brought
    expect((await orderOfBNow()).lines[0]?.receivedQuantity).toBe('40.0000');
  });
});

describe("another workspace's stock and prices", () => {
  it("never count in A's incoming goods or A's last price", async () => {
    const stock = stockPageSchema.parse((await as(tenantA, 'GET', '/stock')).json());
    expect(stock.items.map((item) => [item.productName, item.incoming])).toEqual([
      ['Single jersey, black', '100.0000'],
    ]);
    const res = await as(tenantA, 'POST', '/purchase/cost-lookup', {
      supplierId: supplierOfB.id,
      items: [
        { variantId: variantOf(productOfB), unitId: pcsOf(unitsOfA) },
        { variantId: variantOf(productOfA), unitId: pcsOf(unitsOfA) },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    // B's item is left out; A's comes from A's own order, never from B's supplier
    expect(
      costLookupSchema
        .parse(res.json())
        .items.map((item) => [item.variantId, item.cost, item.source]),
    ).toEqual([[variantOf(productOfA), '250.0000', 'last_price']]);
  });
});
```

- **B has one of everything**: a supplier, an item, an approved requisition, an approved order that buys for it and
  was partly received, a draft receipt, and an order waiting for B's purchase manager. The Owner's own order would
  be approved at once, so B's merchandiser (Babul) writes the waiting one.
- **B's orders**: every route is 404, and B's order has the same status and version afterwards. A's list has only
  A's order, whatever the filter names.
- **B's approval**: deciding it from A is 404, A's waiting list is empty, and B's Owner still sees it waiting.
- **B's order never goes out from A**: no file, no email draft, no share link.
- **Nothing of B's on A's order**: B's supplier, store, item, VAT rate and requisition line each come back as the
  same error as an id that does not exist. B's requisition still lists only B's order, and A's form offers none of
  its lines, even when asked for B's store.
- **B's receipts**: every route is 404, the draft is untouched, and A's list by B's order is empty.
- **Nothing of B's on A's receipt**: B's order is `grn_order_invalid`, B's order line on A's own order is
  `grn_order_line_invalid`, and B's store is `stock_warehouse_invalid`. B's order counted only B's own receipt.
- **A's stock and prices**: A's incoming counts only A's order, and the cost lookup leaves B's item out and never
  takes a price from B's supplier's orders.

### Nine older tests follow the new rules

```diff
@@ -92,6 +92,8 @@ function form(settings: Settings) {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat: settings.pricesIncludeVat,
+    // Step 17b: the whole form, the over-receipt percent too
+    overReceiptPercent: settings.overReceiptPercent,
   };
 }
 
@@ -105,6 +107,8 @@ describe('settings', () => {
       logo: null,
       // Step 15a: prices are typed before VAT, the way a distributor quotes
       pricesIncludeVat: false,
+      // Step 17b: a goods receipt never brings in more than ordered
+      overReceiptPercent: '0.00',
       version: 1,
     });
   });
@@ -262,3 +266,46 @@ describe('prices and VAT', () => {
     expect(without.statusCode).toBe(400);
   });
 });
+
+// Last too, for the same reason
+describe('receiving over the order', () => {
+  it('saves the percent with two decimals, and logs it only when it changed (step 17b)', async () => {
+    const res = await send('PUT', '/settings', {
+      ...form(await current()),
+      overReceiptPercent: '3',
+    });
+    expect(res.statusCode, res.body).toBe(200);
+    expect(settingsSchema.parse(res.json()).overReceiptPercent).toBe('3.00');
+    const logged = async () =>
+      auditPageSchema
+        .parse((await send('GET', '/audit-logs?entityType=workspace')).json())
+        .items.filter((item) => item.action === 'settings.updated');
+    const [entry] = await logged();
+    expect(entry?.changes).toEqual({ overReceiptPercent: { from: '0.00', to: '3' } });
+
+    // "3.0" is the 3.00 already saved: a new version, but nothing to log
+    const same = await send('PUT', '/settings', {
+      ...form(await current()),
+      overReceiptPercent: '3.0',
+    });
+    expect(same.statusCode, same.body).toBe(200);
+    const [latest] = await logged();
+    expect(latest?.changes).toEqual({});
+    // An empty box is 0
+    const empty = await send('PUT', '/settings', {
+      ...form(await current()),
+      overReceiptPercent: '',
+    });
+    expect(settingsSchema.parse(empty.json()).overReceiptPercent).toBe('0.00');
+  });
+
+  it('refuses more than 100 percent, more than two decimals and anything but a number', async () => {
+    for (const overReceiptPercent of ['101', '2.555', '-1', 'three']) {
+      const res = await send('PUT', '/settings', { ...form(await current()), overReceiptPercent });
+      expect(res.statusCode).toBe(400);
+      expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
+        overReceiptPercent: ['over_receipt_percent_format'],
+      });
+    }
+  });
+});
```

- **The settings form sends the whole form**, so from 17b it sends `overReceiptPercent` too. A body without it is
  a 400, the same rule 15a's test checks for "prices include VAT": an old form must not reset the percent to 0.
- **Two new tests**: the percent is saved with two decimals ("3" comes back "3.00"). The audit log writes it as
  typed ("3"), and "3.0" a second time is not logged as a change, because 17b.3 compares the numbers, not the text.
  An empty box is 0. More than 100, three decimals, a minus sign or a word are `over_receipt_percent_format`.

```diff
@@ -403,6 +403,8 @@ describe('a posted entry', () => {
       timezone: settings.timezone,
       allowNegativeStock: settings.allowNegativeStock,
       pricesIncludeVat: settings.pricesIncludeVat,
+      // Step 17b: the whole form, the over-receipt percent too
+      overReceiptPercent: settings.overReceiptPercent,
     });
     expect(res.statusCode).toBe(409);
     expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
```

```diff
@@ -172,6 +172,8 @@ function settingsForm(settings: Settings) {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat: settings.pricesIncludeVat,
+    // Step 17b: the whole form, the over-receipt percent too
+    overReceiptPercent: settings.overReceiptPercent,
   };
 }
 
```

```diff
@@ -233,6 +233,8 @@ function settingsForm(settings: Settings, pricesIncludeVat: boolean) {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat,
+    // Step 17b: the whole form, the over-receipt percent too
+    overReceiptPercent: settings.overReceiptPercent,
   };
 }
 
```

```diff
@@ -249,6 +249,8 @@ async function setPricesIncludeVat(on: boolean): Promise<void> {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat: on,
+    // Step 17b: the whole form, the over-receipt percent too
+    overReceiptPercent: settings.overReceiptPercent,
   });
   expect(res.statusCode, res.body).toBe(200);
 }
```

```diff
@@ -202,6 +202,8 @@ function settingsForm(settings: Settings, pricesIncludeVat: boolean) {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat,
+    // Step 17b: the whole form, the over-receipt percent too
+    overReceiptPercent: settings.overReceiptPercent,
   };
 }
 
```

```diff
@@ -465,6 +465,8 @@ beforeAll(async () => {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat: false,
+    // Step 17b: the whole form, the over-receipt percent too
+    overReceiptPercent: settings.overReceiptPercent,
   });
   expect(saved.statusCode, saved.body).toBe(200);
 
@@ -924,7 +926,8 @@ describe('share links', () => {
       kind: 'invoice',
       number: invoice.number,
       date: '2026-10-06',
-      customer: 'Bhairab Bazar Traders',
+      // Step 17b: the customer, or a purchase order's supplier
+      recipient: 'Bhairab Bazar Traders',
       total: invoice.total,
       currency: 'BDT',
       dueDate: '2026-11-05',
```

- **Six files save the settings** (to switch "prices include VAT", allow negative stock, or set the company's
  details for the PDF) and now send the percent they read. Without it, the save was a 400, and the tests after it
  failed further on (an invoice number one too low, a total that never changed), far from the real cause.
- **The public page says `recipient`**, not `customer` (17b.1): it names the supplier of a purchase order.

```diff
@@ -23,6 +23,7 @@ import {
   roleListSchema,
   roleSchema,
   setupSchema,
+  taxRateListSchema,
   type Unit,
   unitListSchema,
   waitingApprovalPageSchema,
@@ -65,6 +66,8 @@ let faruk: SignedIn;
 let nabila: SignedIn;
 let userIds: Map<SignedIn, string>;
 let units: Unit[];
+// Step 17b: the VAT rate a purchase order line starts with, when the product has none of its own
+let defaultRate: string;
 let main: Warehouse;
 let purchaseManager: Role;
 let director: Role;
@@ -317,6 +320,11 @@ beforeAll(async () => {
     expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
   });
   units = unitListSchema.parse((await send('GET', '/units')).json()).items;
+  const rate = taxRateListSchema
+    .parse((await send('GET', '/tax-rates')).json())
+    .items.find((item) => item.isDefault);
+  if (!rate) throw new Error('setup made no default VAT rate');
+  defaultRate = rate.id;
   const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
   if (!first) throw new Error('sign-up made no warehouse');
   main = first;
@@ -390,7 +398,11 @@ afterAll(async () => {
 describe('approval rules', () => {
   it('start with no levels, and the first save is made from version 0', async () => {
     const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
-    expect(items).toEqual([{ document: 'requisition', levels: [], version: 0, updatedAt: null }]);
+    // One rule per kind of document (step 17b added the purchase order's), each its own form
+    expect(items).toEqual([
+      { document: 'requisition', levels: [], version: 0, updatedAt: null },
+      { document: 'purchase_order', levels: [], version: 0, updatedAt: null },
+    ]);
 
     const stale = await send('PUT', '/approval-rules/requisition', { levels: [], version: 1 });
     expect(stale.statusCode).toBe(409);
@@ -921,13 +933,21 @@ describe('cost lookup', () => {
         unitId: unitId('roll'),
         cost: '10500.0000',
         source: 'average_cost',
+        taxRateId: defaultRate,
+      },
+      {
+        variantId: variantOf(knitting),
+        unitId: unitId('pcs'),
+        cost: null,
+        source: null,
+        taxRateId: defaultRate,
       },
-      { variantId: variantOf(knitting), unitId: unitId('pcs'), cost: null, source: null },
       {
         variantId: variantOf(jersey),
         unitId: unitId('kg'),
         cost: '420.0000',
         source: 'average_cost',
+        taxRateId: defaultRate,
       },
     ]);
   });
@@ -940,7 +960,13 @@ describe('cost lookup', () => {
       rupa,
     );
     expect(costLookupSchema.parse(res.json()).items).toEqual([
-      { variantId: variantOf(jersey), unitId: unitId('kg'), cost: null, source: null },
+      {
+        variantId: variantOf(jersey),
+        unitId: unitId('kg'),
+        cost: null,
+        source: null,
+        taxRateId: defaultRate,
+      },
     ]);
   });
 });
```

- **The rule list has two kinds of document now**, and the cost lookup sends a VAT rate with every item. The
  requisition's products have no rate of their own, so it is the workspace's default.

```diff
@@ -158,6 +158,7 @@ describe('starting the setup', () => {
         [
           'core.user.read',
           'inventory.product.manage',
+          'purchase.order.manage',
           'purchase.requisition.manage',
           'sales.customer.manage',
           'sales.order.manage',
@@ -170,6 +171,7 @@ describe('starting the setup', () => {
           'inventory.product.manage',
           'inventory.stock.adjust',
           'inventory.stock.transfer',
+          'purchase.receipt.manage',
           'purchase.requisition.manage',
           'sales.delivery.manage',
           'sales.return.manage',
```

- **The garments roles get 17b's permissions** from `templates.ts` (decision 36): the Merchandiser writes purchase
  orders, the Store keeper receives goods. They are kept apart on purpose.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm lint
cd apps/api
npx vitest run src/purchase --maxWorkers=3
pnpm test:integration
pnpm test:tenant-leak
```

The three new files pass: 18 tests for purchase orders, 11 for goods receipts and 7 for tenant leaks. The whole
integration and tenant-leak suites have 517 tests in 48 files, every one passing: 38 of them are new (the 36 in the
three new files and the two new settings tests). The unit tests still pass (107), and so do the contracts' (217).

> **What we checked.** Besides the runs above, we broke five rules of 17b.3 on purpose, one at a time, and the
> test meant for each one failed: the over-receipt limit forgetting what earlier receipts brought in, "incoming"
> going below zero, a closed order counting as ordered in full, the last price taken from any order that is not a
> draft, and the supplier-side check forgetting purchase orders. The goods receipts file (with its two race tests)
> ran five times in a row and passed each time. The first full run, before the older tests were changed, showed 43
> failures in 9 files; all of them came from the settings field, the second approval rule, the cost lookup's VAT
> rate, the role templates and the renamed `recipient`.

---

## 17b.5 — `packages/i18n`: the words

The screens of 17b.6 need their words in English and Bangla, and the app cannot type-check without them, so they
come first. This part changes only the two locale files. The ui package needs nothing new: the order form is built
from the sales line editor and the totals block (decision 6), the goods receipt from the stock line rows, and the
approval card, the Send menu and the dialogs exist already.

When this part starts, `packages/i18n` has one error: the `errors` object is missing the 16 new codes of 17b.1 and
17b.3. When it ends, the i18n package compiles. The app still has 28 type errors, and none of them is about a
missing word: they are the new contract fields the screens and the mock server do not know yet (`incoming`,
`overReceiptPercent`, `orderState`, `recipient`, the `received_not_billed` stock account, the requisition's
`closed` status in the pill map). 17b.6 fixes the screens, 17b.7 the mocks.

### `locales/en.ts`

```diff
@@ -85,6 +85,8 @@ export const en = {
     suppliers: 'Suppliers',
     supplierGroups: 'Supplier groups',
     requisitions: 'Requisitions',
+    purchaseOrders: 'Purchase orders',
+    goodsReceipts: 'Goods receipts',
     approvals: 'Approvals',
   },
   auth: {
@@ -168,6 +170,9 @@ export const en = {
     allowNegativeStock: 'Allow negative stock',
     allowNegativeStockHint:
       'Sales and adjustments may then take more than the stock shows, for products without batches or serial numbers. Leave it off unless your counters sell before the stock is entered.',
+    overReceiptPercent: 'Receive over the order',
+    overReceiptPercentHint:
+      'A goods receipt may bring in up to this percent more than was ordered, like 3% for yarn sold by weight. 0 = never more than ordered.',
     stockAccountsTitle: 'Stock accounts',
     stockAccountsSubtitle:
       'Where stock documents post in the books. Stock itself always goes to {{inventory}}, and opening stock against {{equity}}.',
@@ -175,6 +180,7 @@ export const en = {
       adjustments: 'Adjustments',
       transfers: 'Transfers',
       revaluation: 'Revaluation',
+      purchase: 'Buying',
     },
     stockAccountUses: {
       in_transit: 'Goods in transit',
@@ -187,11 +193,14 @@ export const en = {
       correction: 'Correction',
       transfer_shortage: 'Received short',
       revaluation: 'Revaluation',
+      received_not_billed: 'Goods received, not billed',
     },
     stockAccountHints: {
       in_transit: 'An asset: stock sent between two branches, until it arrives',
       transfer_shortage: 'What a transfer lost on the way',
       revaluation: 'The difference when an item gets a new average cost',
+      received_not_billed:
+        'A liability: what goods receipts brought in, until the supplier’s bill is entered',
     },
     stockAccountPlaceholder: 'Pick an account',
     stockAccountsSave: 'Save stock accounts',
@@ -472,6 +481,7 @@ export const en = {
       sales_return: 'Sales return',
       sales_credit_note: 'Credit note',
       sales_refund: 'Refund',
+      purchase_receipt: 'Goods receipt',
     },
     fromDocument: 'From {{document}}',
     stockEntryHint:
@@ -1015,6 +1025,7 @@ export const en = {
       onHand: 'On hand',
       inTransit: 'In transit',
       onOrder: 'On order',
+      incoming: 'Incoming',
       unitCost: 'Average cost',
       value: 'Value',
       status: 'Status',
@@ -1024,6 +1035,9 @@ export const en = {
     newTransfer: 'New transfer',
     // Under the "On order" column header: why it is not taken off "On hand"
     onOrderHint: 'Ordered by customers, not delivered yet. Nothing is held for it.',
+    // Under the "Incoming" column header: why it is not in "On hand" yet
+    incomingHint:
+      'Still to come on approved purchase orders. Not on hand until a goods receipt is posted.',
     emptyTitle: 'No stock yet',
     emptyBody:
       'Post your opening stock with an adjustment: every product counted on your first day, warehouse by warehouse.',
@@ -1088,6 +1102,7 @@ export const en = {
       revaluation: 'Revaluation',
       delivery: 'Delivered',
       sales_return: 'Came back',
+      purchase_receipt: 'Goods receipt',
     },
     historyEmpty: 'No movement in these dates.',
   },
@@ -1277,6 +1292,7 @@ export const en = {
       warehouse: 'Warehouse',
       onHand: 'On hand',
       inTransit: 'In transit',
+      incoming: 'Incoming',
       level: 'Reorder level',
       order: 'Order',
     },
@@ -2548,8 +2564,17 @@ export const en = {
     costPer: 'Cost per {{unit}}',
     amount: 'Amount',
     // Where a new line's cost came from (the cost lookup)
+    fromSupplierPrice: 'Last price from this supplier',
+    fromLastPrice: 'Last price paid',
     fromAverage: 'From the average cost',
     noCost: 'No cost known: type one',
+    // A purchase order's line: a price, not an estimate
+    noPrice: 'No earlier price: type one',
+    orderPickerDescription:
+      'Search products and services. Each click adds a line in its buying unit, at the last price paid.',
+    reprice: 'Use this supplier’s last prices on every line',
+    repriced: 'Prices updated',
+    noOrderLines: 'No items yet. Add lines still to order, or add items.',
     noLines: 'No items yet. Add what needs to be bought.',
     tooMany: 'A document holds up to {{max}} lines. Write a second one for the rest.',
     lineCount_one: '{{count}} item',
@@ -2569,8 +2594,16 @@ export const en = {
       draft: 'Draft',
       pending: 'Waiting for approval',
       approved: 'Approved',
+      closed: 'Closed',
       cancelled: 'Cancelled',
     },
+    // How much purchase orders cover (requisitions.ts → orderState)
+    orderStates: {
+      not_ordered: 'Not ordered',
+      partly_ordered: 'Partly ordered',
+      ordered: 'Ordered',
+    },
+    orderFilters: { to_order: 'To order' },
     columns: {
       number: 'Number',
       date: 'Date',
@@ -2590,6 +2623,9 @@ export const en = {
     notePlaceholder:
       'For buyer PO-HM-2026-1187: 2,000 polo shirts in navy. Cutting starts on 10 November.',
     requestedBy: 'Requested by',
+    // A line on the requisition's page, in the line's unit
+    ordered: 'Ordered',
+    leftToOrder: 'Left to order',
     save: 'Save requisition',
     saved: '{{number}} saved',
     edit: 'Edit',
@@ -2610,6 +2646,12 @@ export const en = {
       'Nobody can order from it any more. It stays in the list as cancelled, with its history.',
     keep: 'Keep it',
     cancelled: '{{number}} cancelled',
+    makeOrder: 'Make purchase order',
+    close: 'Close requisition',
+    closeTitle: 'Close {{number}}',
+    closeBody:
+      'What is not ordered yet will not be ordered. The orders that buy for it go on as they are.',
+    closed: '{{number}} closed',
     delete: 'Delete requisition',
     confirmDelete: 'Delete {{number}}',
     deleteWarning:
@@ -2621,7 +2663,14 @@ export const en = {
       approved: 'Approved and locked. Reopen it to change it; it is then approved again.',
       cancelled: 'Cancelled. It stays here for the record.',
       rejected: '{{name}} sent it back: "{{comment}}" Change it and submit it again.',
-    },
+      // Approved, and a purchase order buys for it
+      ordered:
+        'Purchase orders buy for it, so it can no longer be reopened or cancelled. Close it when the rest will not be ordered.',
+      closed: 'Closed. What was not ordered will not be.',
+    },
+    ordersTitle: 'Purchase orders',
+    ordersSubtitle: 'Orders that buy for this requisition',
+    noOrders: 'Nothing ordered yet.',
     cantWrite:
       'You can view requisitions. Ask a workspace owner for the purchase.requisition.manage permission to write them.',
     notFound: "This requisition doesn't exist, or it was deleted.",
@@ -2630,13 +2679,209 @@ export const en = {
       'Write one when the store or the floor needs something, like 2,000 cones of 30s yarn or a motor for a sewing machine. It is approved before anyone orders.',
     loadFailed: "Couldn't load the requisitions. Refresh the page to try again.",
   },
+  purchaseOrders: {
+    title: 'Purchase orders',
+    description: 'What the company ordered from suppliers, and how much of it has come in',
+    new: 'New purchase order',
+    newTitle: 'New purchase order',
+    draftTitle: 'Draft purchase order',
+    back: 'Purchase orders',
+    show: 'Show',
+    all: 'All',
+    allWarehouses: 'All warehouses',
+    statuses: {
+      draft: 'Draft',
+      pending: 'Waiting for approval',
+      approved: 'Approved',
+      received: 'Received',
+      closed: 'Closed',
+      cancelled: 'Cancelled',
+    },
+    partlyReceived: 'Partly received',
+    // Approved, and its delivery date has passed
+    late: 'Late',
+    receiptFilters: { to_receive: 'To receive' },
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      supplier: 'Supplier',
+      expectedDate: 'Deliver by',
+      warehouse: 'Warehouse',
+      total: 'Total',
+      status: 'Status',
+    },
+    supplier: 'Supplier',
+    supplierLocked:
+      'The supplier stays: this order has a number. Write a new order for another one.',
+    date: 'Order date',
+    expectedDate: 'Deliver by',
+    expectedDateHint:
+      'When the supplier should bring the goods. Leave it empty if there is no date.',
+    noDate: 'No date',
+    supplierReference: 'Supplier’s reference',
+    supplierReferenceHint: 'Their quotation or proforma invoice number, printed on the order',
+    supplierReferencePlaceholder: 'PI-2026-0412',
+    warehouse: 'Deliver to',
+    warehouseHint:
+      'The warehouse the goods come to. Lines still to order come from its requisitions.',
+    paymentTerms: 'Payment terms',
+    paymentTermsHint:
+      'Days to pay after the goods come. They start as the supplier’s; 0 = on delivery.',
+    pricesIncludeVat: 'Prices include VAT',
+    pricesIncludeVatHint:
+      'Off: the supplier’s prices are before VAT, as most quotes are. The supplier’s bill takes the VAT as input VAT.',
+    note: 'Note',
+    notePlaceholder: 'Yarn in 50 kg bags, the lot number on each. Gate 2, 9 am to 5 pm.',
+    // The order line's link to the requisition line it buys for
+    forRequisition: 'For {{number}}',
+    // The "lines still to order" dialog (GET /requisition-lines)
+    addFromRequisitions: 'Add lines still to order',
+    openLinesTitle: 'Lines still to order',
+    openLinesDescription:
+      'Approved requisitions for {{warehouse}}, oldest first. Each click adds a line for what is left.',
+    openLinesSearch: 'Search by item or requisition number',
+    openLinesEmpty: 'Nothing is left to order for this warehouse.',
+    openLineNeededBy: '{{number}} · needed by {{date}}',
+    openLineLeft: '{{quantity}} left to order',
+    pickWarehouseFirst: 'Pick the warehouse first: lines still to order are per warehouse.',
+    saveDraft: 'Save draft',
+    draftSaved: 'Draft saved',
+    saved: '{{number}} saved',
+    edit: 'Edit',
+    submit: 'Submit for approval',
+    submitHint:
+      'It gets its number now. Its total with VAT chooses who approves it, and nobody can change it while it waits.',
+    submitted: '{{number}} sent for approval',
+    // No level applies, or an Owner submitted it: approved in the same step
+    submittedApproved: '{{number}} approved',
+    numberedDraft:
+      'This draft keeps its number {{number}}. Submit it again when the changes are done.',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning: 'A deleted draft cannot be brought back. It never had a number.',
+    deleted: 'Draft deleted',
+    receive: 'Receive goods',
+    reopen: 'Reopen',
+    reopenTitle: 'Reopen {{number}}',
+    reopenBody:
+      'It goes back to draft so it can be changed, and it is approved again from the first level. It keeps its number. If the supplier has it already, send them the new one.',
+    reopened: '{{number}} is a draft again',
+    close: 'Close order',
+    closeTitle: 'Close {{number}}',
+    closeBody:
+      'What has not come in is dropped, and its requisitions can order the rest again. Draft goods receipts of this order can no longer be posted.',
+    closed: '{{number}} closed',
+    cancel: 'Cancel order',
+    cancelTitle: 'Cancel {{number}}',
+    cancelBody:
+      'The order is called off, and its requisitions can be ordered again. It stays in the list as cancelled. Tell the supplier if they have it.',
+    cancelled: '{{number}} cancelled',
+    keepOrder: 'Keep the order',
+    // The lines on the order's page, in the line's unit
+    received: 'Received',
+    rejected: 'Rejected',
+    left: 'Left to receive',
+    serviceLine: 'A service: not received',
+    // The document notice above the order
+    notices: {
+      pending: 'Waiting for approval. Reopen it to change it.',
+      approved:
+        'Approved. Send it to the supplier, and receive the goods when they come. Reopen it to change it; it is then approved again.',
+      receiving:
+        'Goods came in against it, so it can no longer be reopened or cancelled. Close it when the rest will not come.',
+      received: 'Everything on the order came in.',
+      closed: 'Closed. What did not come in was dropped.',
+      cancelled: 'Cancelled. It stays here for the record.',
+      rejected: '{{name}} sent it back: "{{comment}}" Change it and submit it again.',
+    },
+    requisitions: 'Requisitions',
+    receiptsTitle: 'Goods receipts',
+    receiptsSubtitle: 'What came in against this order',
+    noReceipts: 'Nothing received yet.',
+    approvedOn: 'Approved {{date}}',
+    cantWrite:
+      'You can view purchase orders. Ask a workspace owner for the purchase.order.manage permission to write them.',
+    notFound: "This order doesn't exist, or it was a draft that was deleted.",
+    emptyTitle: 'No purchase orders yet',
+    emptyBody:
+      'Order what an approved requisition needs, like 2,000 cones of 30s yarn from a Narayanganj spinning mill. It is approved, sent to the supplier, and received at the gate.',
+    loadFailed: "Couldn't load the purchase orders. Refresh the page to try again.",
+  },
+  goodsReceipts: {
+    title: 'Goods receipts',
+    description: 'GRNs: goods that came in from suppliers against approved purchase orders',
+    new: 'New goods receipt',
+    newTitle: 'New goods receipt',
+    draftTitle: 'Draft goods receipt',
+    back: 'Goods receipts',
+    show: 'Show',
+    all: 'All',
+    statuses: { draft: 'Draft', posted: 'Posted' },
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      supplier: 'Supplier',
+      order: 'Purchase order',
+      warehouse: 'Warehouse',
+      lines: 'Items',
+      status: 'Status',
+    },
+    supplier: 'Supplier',
+    order: 'Purchase order',
+    orderPlaceholder: 'Pick an approved order',
+    orderEmpty: 'No approved order is waiting for goods.',
+    orderHint: 'The goods are booked at this order’s prices.',
+    orderLocked: 'The order stays. For goods of another order, write another receipt.',
+    date: 'Date',
+    warehouse: 'Received at',
+    warehouseHint: 'Where the goods are unloaded. The order says {{warehouse}}.',
+    supplierChallan: 'Supplier’s challan',
+    supplierChallanPlaceholder: 'CH-2026-1187',
+    vehicle: 'Vehicle and driver',
+    vehiclePlaceholder: 'Dhaka Metro-Ta 11-2233, Rahim',
+    note: 'Note',
+    notePlaceholder: 'Checked by QC. 3 bags wet from the rain, turned back.',
+    fillFromOrder: 'Add what is left on the order',
+    nothingLeft: 'Nothing is left to receive on this order.',
+    ordered: 'Ordered {{quantity}}',
+    leftOnOrder: '{{quantity}} left on the order',
+    // Up to how much may still come on this order line, with the over-receipt percent
+    allowed: 'Up to {{quantity}} may come',
+    accepted: 'Accepted',
+    rejected: 'Rejected',
+    rejectionReason: 'Why it was rejected',
+    rejectionReasonPlaceholder: 'Wet, wrong shade',
+    // What the truck brought: accepted + rejected
+    came: '{{quantity}} came',
+    saveDraft: 'Save draft',
+    post: 'Post goods receipt',
+    posting: 'Posting…',
+    posted: '{{number}} posted',
+    draftSaved: 'Draft saved',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning: 'A deleted draft cannot be brought back.',
+    deleted: 'Draft deleted',
+    postHint:
+      'Posting brings what was accepted into stock at the order’s price, owed as goods received not billed until the supplier’s bill. A posted receipt never changes.',
+    cantWrite:
+      'You can view goods receipts. Ask a workspace owner for the purchase.receipt.manage permission to write and post them.',
+    postedOn: 'Posted {{date}}',
+    entry: 'Journal entry',
+    noEntry: 'No journal entry: what came in had no value',
+    notFound: 'This goods receipt no longer exists. A draft may have been deleted.',
+    emptyTitle: 'No goods receipts yet',
+    emptyBody:
+      'When a truck is at the gate, pick its purchase order here, or receive the goods from the order’s page.',
+    loadFailed: "Couldn't load the goods receipts. Refresh the page to try again.",
+  },
   // The approval of any document that needs one: the "Waiting for me" page, the approval card on the
   // document's page, and its two dialogs
   approvals: {
     title: 'Approvals',
     description: 'Documents waiting for your decision, oldest first',
     // An ApprovalDocument kind → its name; the bell and the list put it before the number
-    kinds: { requisition: 'Requisition' },
+    kinds: { requisition: 'Requisition', purchase_order: 'Purchase order' },
     columns: {
       document: 'Document',
       date: 'Date',
@@ -2648,7 +2893,7 @@ export const en = {
     stepOf: '{{position}} of {{count}}',
     emptyTitle: 'Nothing waits for you',
     emptyBody:
-      'When someone submits a requisition that needs your role, it shows up here and the bell tells you.',
+      'When someone submits a requisition or a purchase order that needs your role, it shows up here and the bell tells you.',
     loadFailed: "Couldn't load the documents waiting for you. Refresh the page to try again.",
     cardTitle: 'Approval',
     cardSubtitle: 'Every level it reaches approves it, one after another',
@@ -2708,6 +2953,10 @@ export const en = {
         title: 'Purchase requisitions',
         subtitle: 'By the estimated amount of the requisition',
       },
+      purchase_order: {
+        title: 'Purchase orders',
+        subtitle: 'By the order’s total, VAT included',
+      },
     },
     level: 'Level {{number}}',
     from: 'From amount',
@@ -2734,6 +2983,7 @@ export const en = {
       invoice: 'Invoice',
       receipt: 'Money receipt',
       credit_note: 'Credit note',
+      purchase_order: 'Purchase order',
     },
     send: 'Send',
     downloadPdf: 'Download PDF',
@@ -2758,6 +3008,8 @@ export const en = {
       toPlaceholder: 'accounts@rahmantraders.com.bd',
       noCustomerEmail:
         'This customer has no email address. Type one here, or add it to the customer.',
+      noSupplierEmail:
+        'This supplier has no email address. Type one here, or add it to the supplier.',
       subject: 'Subject',
       message: 'Message',
       messageHint: 'Under your message, the email says what is attached and how to reply.',
@@ -2794,6 +3046,8 @@ export const en = {
       openWhatsApp: 'Open WhatsApp',
       noNumber:
         'The customer’s phone is not a mobile number, so WhatsApp will ask you to pick the contact.',
+      noSupplierNumber:
+        'The supplier’s phone is not a mobile number, so WhatsApp will ask you to pick the contact.',
       shownOnce: 'The link is shown only now. To send it again later, make a new one.',
     },
     shares: {
@@ -2825,7 +3079,7 @@ export const en = {
     document: 'Document',
     pageTitle: '{{document}} {{number}} from {{company}}',
     from: 'From {{company}}',
-    to: 'For {{customer}}',
+    to: 'For {{recipient}}',
     number: 'Number',
     date: 'Date',
     total: 'Total',
@@ -2853,6 +3107,7 @@ export const en = {
       salesReturn: 'Sales return',
       creditNote: 'Credit note',
       refund: 'Refund',
+      purchaseOrder: 'Purchase order',
     },
     bin: 'BIN {{bin}}',
     phone: 'Phone {{phone}}',
@@ -2867,6 +3122,14 @@ export const en = {
     billTo: 'Bill to',
     shipTo: 'Ship to',
     customer: 'Customer',
+    // A purchase order's words: the same as its PDF (apps/api/src/documents/copy.ts)
+    supplier: 'Supplier',
+    deliverBy: 'Deliver by',
+    deliverTo: 'Deliver to',
+    paymentTerms: 'Payment terms',
+    termsDays_one: '{{count}} day',
+    termsDays_other: '{{count}} days',
+    onDelivery: 'On delivery',
     columns: {
       number: '#',
       item: 'Item',
@@ -3088,7 +3351,14 @@ export const en = {
         balance: 'See what the company owes suppliers, and their statements',
       },
       requisition: {
-        manage: 'Write requisitions, submit them for approval, reopen and cancel them',
+        manage: 'Write requisitions, submit them for approval, reopen, close and cancel them',
+      },
+      order: {
+        manage:
+          'Write purchase orders, submit them for approval, send them to suppliers, reopen, close and cancel them',
+      },
+      receipt: {
+        manage: 'Receive goods against approved purchase orders, and post goods receipts',
       },
     },
   },
@@ -3152,6 +3422,8 @@ export const en = {
       supplier: 'Suppliers',
       supplier_group: 'Supplier groups',
       requisition: 'Purchase requisitions',
+      purchase_order: 'Purchase orders',
+      goods_receipt: 'Goods receipts',
     },
     columns: {
       when: 'When',
@@ -3365,6 +3637,20 @@ export const en = {
         updated: 'Edited a draft requisition',
         deleted: 'Deleted a draft requisition',
         cancelled: 'Cancelled a requisition',
+        closed: 'Closed a requisition',
+      },
+      purchase_order: {
+        created: 'Wrote a purchase order',
+        updated: 'Edited a draft purchase order',
+        deleted: 'Deleted a draft purchase order',
+        closed: 'Closed a purchase order',
+        cancelled: 'Cancelled a purchase order',
+      },
+      goods_receipt: {
+        created: 'Wrote a goods receipt',
+        updated: 'Edited a draft goods receipt',
+        deleted: 'Deleted a draft goods receipt',
+        posted: 'Posted a goods receipt',
       },
       approval: {
         submitted: 'Submitted for approval',
@@ -3465,7 +3751,7 @@ export const en = {
       quotation: 'Quotation',
       deliveryDate: 'Delivery date',
       customerReference: 'Customer’s reference',
-      order: 'Sales order',
+      order: 'Order',
       vehicle: 'Vehicle',
       dueDate: 'Due date',
       amount: 'Amount',
@@ -3485,6 +3771,13 @@ export const en = {
       role: 'Role',
       comment: 'Comment',
       requisition: 'Purchase requisitions',
+      overReceiptPercent: 'Receive over the order (%)',
+      received_not_billed: 'Goods received, not billed',
+      supplier: 'Supplier',
+      expectedDate: 'Deliver by',
+      supplierReference: 'Supplier’s reference',
+      supplierChallan: 'Supplier’s challan',
+      purchase_order: 'Purchase orders',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -3806,7 +4099,7 @@ export const en = {
     stock_account_invalid: 'Pick an active account of the right type.',
     stock_account_inventory: 'Pick another account: this one is the inventory account itself.',
     journal_account_stock:
-      'Only stock documents post to this account. Use a stock adjustment, or a revaluation, instead.',
+      'Only stock documents post to this account, like inventory, goods in transit or goods received not billed. Use a stock adjustment, a revaluation or a goods receipt instead.',
     journal_is_stock:
       'A stock document made this entry. Post another stock document to correct it.',
     revaluation_no_stock: 'There is no stock of this item to revalue.',
@@ -3966,7 +4259,7 @@ export const en = {
     account_used_by_sales:
       'Credit notes post to this account. Choose another sales returns account in Settings → Sales first.',
     document_not_issued:
-      "This document has no number yet, or it was voided, so it can't be downloaded or sent. Post it first.",
+      "This document can't be downloaded or sent yet. Post it, or wait for its approval. A voided or cancelled one is not sent.",
     email_to_required: 'Type at least one address to send it to.',
     // 5 = MAX_EMAIL_RECIPIENTS; the schema's issue carries no number to put in
     email_too_many: 'Up to 5 addresses in a box. Send a second email to the rest.',
@@ -4010,6 +4303,31 @@ export const en = {
       'Only a draft or an approved document can be cancelled. Reopen a waiting one first.',
     requisition_needed_by: 'Pick a day on or after the requisition date.',
     requisition_cost_required: 'Enter the estimated cost. 0 is fine for a free item.',
+    purchase_supplier_required: 'Pick the supplier.',
+    purchase_supplier_invalid:
+      'Pick an active supplier. A numbered order keeps its supplier: write a new order for another one.',
+    purchase_expected_date: 'Pick a day on or after the order date.',
+    purchase_requisition_line_invalid:
+      'This line can no longer buy for that requisition: it must be approved, for this warehouse and for the same item. Pick it again from the lines still to order.',
+    purchase_requisition_line_twice:
+      'Another line of this order buys for the same requisition line. Change that line’s quantity instead.',
+    purchase_close_instead:
+      'A later document uses this one, so it cannot be reopened or cancelled. Close it instead.',
+    purchase_cancel_instead:
+      'Nothing was ordered or received against this yet, so there is nothing to close. Cancel it instead.',
+    purchase_delete_instead: 'This draft was never submitted and has no number. Delete it instead.',
+    purchase_receipt_draft:
+      'A draft goods receipt is waiting on this order. Delete that draft first, or post it and close the order.',
+    purchase_not_approved:
+      'This document is no longer approved: someone reopened, closed or cancelled it. Reload it to see where it is now.',
+    grn_order_invalid: 'Pick an approved purchase order.',
+    grn_order_line_invalid:
+      'This line is not on the purchase order, or is for another item. Add it again from the order.',
+    grn_over_order:
+      'This is more than the order allows, even with the over-receipt percent in Settings. Accept less, and enter the rest as rejected.',
+    grn_line_empty: 'Enter what was accepted, what was rejected, or both.',
+    grn_rejection_reason: 'Say why the goods were rejected, like "wet" or "wrong shade".',
+    over_receipt_percent_format: 'Enter a percent from 0 to 100, with up to 2 decimals.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
```

What is new, from the top of the file down:

- **`nav`:** "Purchase orders" and "Goods receipts" in the Purchase group, between Requisitions and Approvals, in
  the order the work happens.
- **`settings`:** the over-receipt box (decision 22) sits under "Allow negative stock", because both are rules for
  how stock may move. The hint gives an example (3% for yarn sold by weight) and says what 0 means, because a person
  who sees an empty percent box does not know whether empty means "no limit" or "nothing over".
- **`settings.stockAccount*`:** the new use `received_not_billed` (decision 12) gets a name, a hint and a group,
  "Buying". The card lists its uses group by group, and this account belongs to neither adjustments nor transfers.
  The hint says it is a liability, because the select only offers liability accounts and the person should know
  why their expense accounts are not in the list.
- **`journal.sources.purchase_receipt` and `stock.kinds.purchase_receipt`:** the entry and the stock movement a
  posted goods receipt makes. Without them the journal page would show the raw word `purchase_receipt`.
- **`stock` and `reorder`:** the "Incoming" column (decision 23). `incomingHint` says why it is not part of "On
  hand", like the "On order" column's hint does for sales: a buyer who sees 2,000 cones incoming must not think they
  are in the store.
- **`purchaseLines`:** the cost lookup can now answer with this supplier's last price or anyone's last price
  (decision 19), so the line under the box has two new texts. 17b.6 shows them in the requisition editor too, whose
  estimated cost now starts from the last price (until then it says "No cost known" for those two sources). `noPrice`, `orderPickerDescription`, `reprice` and `noOrderLines` are the
  order's own versions of the sales editor's words. The sales editor says "this customer's price"; on an order the
  same words would be wrong, so 17b.6 passes these to the editor from the order's own line editor.
- **`requisitions`:** the `closed` status and the order state (decision 5) as a pill: "Not ordered", "Partly
  ordered", "Ordered". `orderFilters.to_order` is the list filter of the same name in the contract. "Make purchase
  order", "Close requisition" and its dialog follow the `reopen`/`cancel` pattern the page already reads
  (`${asking}Title`, `${asking}Body`), so 17b.6 only adds `close` to the dialog's list of actions. `notices.ordered` tells a person
  why Reopen and Cancel are gone once an order buys for it (decision 17); otherwise the missing buttons look like a
  bug.
- **`purchaseOrders`:** the list, the form and the page, built like `salesOrders` with the approval of
  `requisitions` in the middle, and its own `edit` for the draft page's Edit button (decision 46). The differences
  are on purpose:
  - the statuses are the contract's six, and `partlyReceived` is a second pill like `partlyDelivered`, because the
    order is still open either way. `late` is the same idea as a late sales order: approved, and its delivery date
    has passed, so the buyer calls the supplier;
  - `supplierLocked` explains why the supplier box is disabled on a numbered order (decision 33) and what to do
    instead;
  - `paymentTermsHint` and `pricesIncludeVatHint` explain where the two values come from (decision 15). The VAT hint
    says why the box starts off: most supplier quotes are before VAT;
  - the "lines still to order" dialog (decision 18) names the warehouse in its description, because the list is per
    warehouse and changing the warehouse changes it. `pickWarehouseFirst` covers the empty form;
  - `submitHint` says the order gets its number at this moment (decision 13), and that the total with VAT picks the
    approvers (decision 14);
  - `reopenBody` and `cancelBody` remind the person to tell the supplier: once an approved order went out, the
    supplier has a copy that is now wrong;
  - `notices.receiving` is the order's version of the requisition's `notices.ordered`: goods came, so it can only be
    closed (decision 11).
- **`goodsReceipts`:** built like `deliveries`, with the gate's own words. `accepted`, `rejected` and
  `rejectionReason` are the line's three boxes (decision 9); `came` is what the truck brought, accepted plus
  rejected. `allowed` shows how much more may come on an order line, with the over-receipt percent already in it,
  so the store keeper sees the limit before the API refuses it. `warehouseHint` names the order's warehouse, because
  a receipt may unload at another one (decision 20) and the person should notice when they do. `postHint` says, in
  plain words, what posting books: stock at the order's price, owed as "goods received not billed" until the bill.
- **`approvals` and `approvalRules`:** the second kind of document, `purchase_order`, in `kinds` (the bell, the list
  and the card read it) and in `documents` (the second card on Settings → Approval levels). The card's subtitle says
  "VAT included", because an owner setting a level of ৳1,00,000 must know whether ৳95,000 plus VAT reaches it.
- **`documentOutput`:** `kinds.purchase_order`, and supplier versions of the two texts that named the customer: the
  email dialog's "no email address" hint and the share dialog's "not a mobile number" line. The old keys stay for
  the sales documents, so no old screen changes.
- **`publicDocument.to`:** the placeholder is `{{recipient}}` now, after the contract's field (decision 24). The
  English "For {{recipient}}" reads right for a supplier and for a customer alike.
- **`print`:** the order's title and its own words, the same as its PDF in `apps/api/src/documents/copy.ts`
  (Supplier, Deliver by, Deliver to, Payment terms, "On delivery" for 0 days). The printed paper and the PDF are the
  same document, so they must say the same words. `termsDays_one` and `termsDays_other` are a plural pair, so the
  paper says "1 day", not "1 days".
- **`permissions.purchase`:** the two new keys (decision 25). The requisition's text now says "close" too.
- **`audit`:** the two entity types, the actions of 17b.3, and the field names its services write
  (`supplier`, `expectedDate`, `supplierReference`, `supplierChallan`, `overReceiptPercent`, the stock account use
  `received_not_billed`, and `purchase_order` for the approval levels, like `requisition` in 17a). One older text
  changes: `fields.order` was "Sales order", but a goods receipt writes `order` for its purchase order. It is
  "Order" now; the entity type above the row already says which kind.
- **`errors`:** the 16 new codes after the requisition ones, and two older texts:
  - `journal_account_stock` names the three accounts that only stock documents post to, and the goods receipt as a
    way to post there. Someone who tried a manual line on 2115 learns why it was refused (decision 37);
  - `document_not_issued` no longer says only "post it first": a purchase order is sent once it is approved
    (decision 35), so the text also says to wait for the approval.

  A few of the new texts in detail:
  - `purchase_close_instead` and `purchase_cancel_instead` serve the requisition and the order (decision 17), so
    they say "this document" and "ordered or received", true for both.
  - `purchase_receipt_draft` gives both ways out: delete the draft receipt, or post it and close the order.
  - `grn_over_order` says to accept less and enter the rest as rejected. That works because rejected goods do not
    count against the limit (decision 22), and it is what happens at a real gate: the extra bags go back on the
    truck.
  - `purchase_not_approved` asks for a reload, because the cause is always someone else's change while the page
    was open.

### `locales/bn.ts`

```diff
@@ -85,6 +85,8 @@ export const bn: Messages = {
     suppliers: 'সাপ্লায়ার',
     supplierGroups: 'সাপ্লায়ারের গ্রুপ',
     requisitions: 'রিকুইজিশন',
+    purchaseOrders: 'পারচেজ অর্ডার',
+    goodsReceipts: 'মাল গ্রহণ (GRN)',
     approvals: 'অনুমোদন',
   },
   auth: {
@@ -168,6 +170,9 @@ export const bn: Messages = {
     allowNegativeStock: 'স্টক শূন্যের নিচে যেতে দিন',
     allowNegativeStockHint:
       'তাহলে ব্যাচ বা সিরিয়াল নম্বর ছাড়া প্রোডাক্টে বিক্রি আর অ্যাডজাস্টমেন্ট খাতায় থাকা স্টকের চেয়ে বেশি নিতে পারবে। কাউন্টারে স্টক এন্ট্রির আগেই বিক্রি না হলে এটা বন্ধ রাখুন।',
+    overReceiptPercent: 'অর্ডারের বেশি গ্রহণ',
+    overReceiptPercentHint:
+      'মাল গ্রহণে অর্ডারের চেয়ে এত শতাংশ পর্যন্ত বেশি নেওয়া যাবে, যেমন ওজনে বিক্রি হওয়া সুতার জন্য ৩%। ০ = অর্ডারের বেশি কখনো না।',
     stockAccountsTitle: 'স্টকের অ্যাকাউন্ট',
     stockAccountsSubtitle:
       'স্টকের ডকুমেন্ট হিসাবের খাতায় কোথায় পোস্ট হবে। স্টক নিজে সবসময় {{inventory}}-এ যায়, আর ওপেনিং স্টক {{equity}}-এর বিপরীতে।',
@@ -175,6 +180,7 @@ export const bn: Messages = {
       adjustments: 'অ্যাডজাস্টমেন্ট',
       transfers: 'ট্রান্সফার',
       revaluation: 'পুনর্মূল্যায়ন',
+      purchase: 'কেনা',
     },
     stockAccountUses: {
       in_transit: 'পথে থাকা মাল',
@@ -187,11 +193,13 @@ export const bn: Messages = {
       correction: 'সংশোধন',
       transfer_shortage: 'কম পৌঁছেছে',
       revaluation: 'পুনর্মূল্যায়ন',
+      received_not_billed: 'মাল এসেছে, বিল আসেনি',
     },
     stockAccountHints: {
       in_transit: 'একটা সম্পদ: দুই ব্রাঞ্চের মধ্যে পাঠানো স্টক, পৌঁছানো পর্যন্ত',
       transfer_shortage: 'ট্রান্সফারে পথে যা হারিয়েছে',
       revaluation: 'কোনো আইটেমের নতুন গড় খরচ ঠিক হলে যে পার্থক্য হয়',
+      received_not_billed: 'একটা দায়: মাল গ্রহণে যা এসেছে, সাপ্লায়ারের বিল এন্ট্রি হওয়া পর্যন্ত',
     },
     stockAccountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
     stockAccountsSave: 'স্টকের অ্যাকাউন্ট সেভ করুন',
@@ -467,6 +475,7 @@ export const bn: Messages = {
       sales_return: 'সেলস রিটার্ন',
       sales_credit_note: 'ক্রেডিট নোট',
       sales_refund: 'রিফান্ড',
+      purchase_receipt: 'মাল গ্রহণ',
     },
     fromDocument: '{{document}} থেকে',
     stockEntryHint:
@@ -1011,6 +1020,7 @@ export const bn: Messages = {
       onHand: 'হাতে আছে',
       inTransit: 'পথে আছে',
       onOrder: 'অর্ডারে আছে',
+      incoming: 'আসছে',
       unitCost: 'গড় খরচ',
       value: 'মূল্য',
       status: 'অবস্থা',
@@ -1018,6 +1028,7 @@ export const bn: Messages = {
     statuses: { low: 'কম', out: 'স্টক শেষ', negative: 'শূন্যের নিচে', archived: 'আর্কাইভ' },
     newAdjustment: 'নতুন অ্যাডজাস্টমেন্ট',
     newTransfer: 'নতুন ট্রান্সফার',
+    incomingHint: 'অনুমোদিত পারচেজ অর্ডারে যা আসা বাকি। মাল গ্রহণ পোস্ট না হওয়া পর্যন্ত হাতে নেই।',
     onOrderHint: 'গ্রাহক অর্ডার দিয়েছেন, এখনো ডেলিভারি হয়নি। এর জন্য কিছু আটকে রাখা হয় না।',
     emptyTitle: 'এখনো কোনো স্টক নেই',
     emptyBody:
@@ -1083,6 +1094,7 @@ export const bn: Messages = {
       revaluation: 'পুনর্মূল্যায়ন',
       delivery: 'ডেলিভারি',
       sales_return: 'ফেরত এসেছে',
+      purchase_receipt: 'মাল গ্রহণ',
     },
     historyEmpty: 'এই তারিখগুলোর মধ্যে কোনো মুভমেন্ট নেই।',
   },
@@ -1270,6 +1282,7 @@ export const bn: Messages = {
       warehouse: 'গুদাম',
       onHand: 'হাতে আছে',
       inTransit: 'পথে আছে',
+      incoming: 'আসছে',
       level: 'রিঅর্ডার লেভেল',
       order: 'অর্ডার',
     },
@@ -2490,8 +2503,16 @@ export const bn: Messages = {
     estimatedCost: 'আনুমানিক খরচ',
     costPer: 'প্রতি {{unit}}-এর খরচ',
     amount: 'টাকা',
+    fromSupplierPrice: 'এই সাপ্লায়ারের শেষ দাম',
+    fromLastPrice: 'শেষবার দেওয়া দাম',
     fromAverage: 'গড় খরচ থেকে',
     noCost: 'খরচ জানা নেই: লিখে দিন',
+    noPrice: 'আগের কোনো দাম নেই: লিখে দিন',
+    orderPickerDescription:
+      'প্রোডাক্ট আর সার্ভিস খুঁজুন। প্রতি ক্লিকে কেনার ইউনিটে, শেষবার দেওয়া দামে একটা লাইন যোগ হয়।',
+    reprice: 'প্রতিটা লাইনে এই সাপ্লায়ারের শেষ দাম বসান',
+    repriced: 'দাম বদলানো হয়েছে',
+    noOrderLines: 'এখনো কোনো আইটেম নেই। অর্ডার বাকি লাইন বা আইটেম যোগ করুন।',
     noLines: 'এখনো কোনো আইটেম নেই। যা কিনতে হবে তা যোগ করুন।',
     tooMany: 'একটা ডকুমেন্টে {{max}}টা পর্যন্ত লাইন থাকে। বাকিগুলোর জন্য আরেকটা লিখুন।',
     lineCount_one: '{{count}}টা আইটেম',
@@ -2511,8 +2532,15 @@ export const bn: Messages = {
       draft: 'খসড়া',
       pending: 'অনুমোদনের অপেক্ষায়',
       approved: 'অনুমোদিত',
+      closed: 'বন্ধ',
       cancelled: 'বাতিল',
     },
+    orderStates: {
+      not_ordered: 'অর্ডার হয়নি',
+      partly_ordered: 'কিছুটা অর্ডার হয়েছে',
+      ordered: 'অর্ডার হয়েছে',
+    },
+    orderFilters: { to_order: 'অর্ডার বাকি' },
     columns: {
       number: 'নম্বর',
       date: 'তারিখ',
@@ -2532,6 +2560,8 @@ export const bn: Messages = {
     notePlaceholder:
       'বায়ার PO-HM-2026-1187-এর জন্য: নেভি রঙের ২,০০০ পোলো শার্ট। কাটিং শুরু ১০ নভেম্বর।',
     requestedBy: 'যিনি চেয়েছেন',
+    ordered: 'অর্ডার হয়েছে',
+    leftToOrder: 'অর্ডার বাকি',
     save: 'রিকুইজিশন সেভ করুন',
     saved: '{{number}} সেভ হয়েছে',
     edit: 'বদলান',
@@ -2550,6 +2580,12 @@ export const bn: Messages = {
     cancelBody: 'এখান থেকে আর কেউ অর্ডার দিতে পারবেন না। ইতিহাসসহ তালিকায় বাতিল হিসেবে থেকে যাবে।',
     keep: 'রেখে দিন',
     cancelled: '{{number}} বাতিল হয়েছে',
+    makeOrder: 'পারচেজ অর্ডার বানান',
+    close: 'রিকুইজিশন বন্ধ করুন',
+    closeTitle: '{{number}} বন্ধ করুন',
+    closeBody:
+      'যা এখনো অর্ডার হয়নি তা আর অর্ডার হবে না। যে অর্ডারগুলো এর জন্য কিনছে সেগুলো যেমন আছে চলবে।',
+    closed: '{{number}} বন্ধ হয়েছে',
     delete: 'রিকুইজিশন মুছুন',
     confirmDelete: '{{number}} মুছুন',
     deleteWarning:
@@ -2560,7 +2596,13 @@ export const bn: Messages = {
       approved: 'অনুমোদিত, তাই বদলানো যায় না। বদলাতে আবার খুলুন; তখন আবার অনুমোদন লাগবে।',
       cancelled: 'বাতিল। রেকর্ডের জন্য এখানে থেকে যায়।',
       rejected: '{{name}} ফেরত পাঠিয়েছেন: "{{comment}}" বদলে আবার অনুমোদনে পাঠান।',
+      ordered:
+        'পারচেজ অর্ডার এর জন্য কিনছে, তাই আর আবার খোলা বা বাতিল করা যাবে না। বাকিটা অর্ডার না হলে বন্ধ করুন।',
+      closed: 'বন্ধ। যা অর্ডার হয়নি তা আর হবে না।',
     },
+    ordersTitle: 'পারচেজ অর্ডার',
+    ordersSubtitle: 'যে অর্ডারগুলো এই রিকুইজিশনের জন্য কিনছে',
+    noOrders: 'এখনো কিছু অর্ডার হয়নি।',
     cantWrite:
       'আপনি রিকুইজিশন দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে purchase.requisition.manage permission চান।',
     notFound: 'এই রিকুইজিশন নেই, অথবা মুছে ফেলা হয়েছে।',
@@ -2569,10 +2611,195 @@ export const bn: Messages = {
       'স্টোর বা ফ্লোরের কিছু লাগলে একটা লিখুন, যেমন ৩০s সুতার ২,০০০ কোন বা সেলাই মেশিনের একটা মোটর। কেউ অর্ডার দেওয়ার আগে এটা অনুমোদন হয়।',
     loadFailed: 'রিকুইজিশনগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  purchaseOrders: {
+    title: 'পারচেজ অর্ডার',
+    description: 'কোম্পানি সাপ্লায়ারদের কাছে কী অর্ডার দিয়েছে, আর তার কতটা এসেছে',
+    new: 'নতুন পারচেজ অর্ডার',
+    newTitle: 'নতুন পারচেজ অর্ডার',
+    draftTitle: 'খসড়া পারচেজ অর্ডার',
+    back: 'পারচেজ অর্ডার',
+    show: 'দেখান',
+    all: 'সব',
+    allWarehouses: 'সব গুদাম',
+    statuses: {
+      draft: 'খসড়া',
+      pending: 'অনুমোদনের অপেক্ষায়',
+      approved: 'অনুমোদিত',
+      received: 'মাল এসেছে',
+      closed: 'বন্ধ',
+      cancelled: 'বাতিল',
+    },
+    partlyReceived: 'কিছুটা এসেছে',
+    late: 'দেরি',
+    receiptFilters: { to_receive: 'আসা বাকি' },
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      supplier: 'সাপ্লায়ার',
+      expectedDate: 'যেদিনের মধ্যে আসবে',
+      warehouse: 'গুদাম',
+      total: 'মোট',
+      status: 'অবস্থা',
+    },
+    supplier: 'সাপ্লায়ার',
+    supplierLocked:
+      'সাপ্লায়ার বদলাবে না: এই অর্ডারের নম্বর আছে। অন্য সাপ্লায়ারের জন্য নতুন অর্ডার লিখুন।',
+    date: 'অর্ডারের তারিখ',
+    expectedDate: 'যেদিনের মধ্যে আসবে',
+    expectedDateHint: 'সাপ্লায়ার কবে মাল দেবেন। কোনো তারিখ না থাকলে খালি রাখুন।',
+    noDate: 'কোনো তারিখ নেই',
+    supplierReference: 'সাপ্লায়ারের রেফারেন্স',
+    supplierReferenceHint: 'তাদের কোটেশন বা প্রোফর্মা ইনভয়েসের নম্বর, অর্ডারে ছাপা হয়',
+    supplierReferencePlaceholder: 'PI-2026-0412',
+    warehouse: 'যেখানে পৌঁছাবে',
+    warehouseHint: 'যে গুদামে মাল আসবে। অর্ডার বাকি লাইনগুলো এর রিকুইজিশন থেকে আসে।',
+    paymentTerms: 'পেমেন্টের মেয়াদ',
+    paymentTermsHint:
+      'মাল আসার কত দিন পর টাকা দিতে হবে। শুরুতে সাপ্লায়ারের মেয়াদ; ০ = মাল পাওয়ার সময়।',
+    pricesIncludeVat: 'দামে VAT ধরা আছে',
+    pricesIncludeVatHint:
+      'বন্ধ: সাপ্লায়ারের দাম VAT-এর আগের, বেশিরভাগ কোটেশনের মতো। সাপ্লায়ারের বিল VAT-টা ইনপুট VAT হিসেবে নেয়।',
+    note: 'নোট',
+    notePlaceholder: '৫০ কেজির বস্তায় সুতা, প্রতিটায় লট নম্বর। গেট ২, সকাল ৯টা থেকে বিকেল ৫টা।',
+    forRequisition: '{{number}}-এর জন্য',
+    addFromRequisitions: 'অর্ডার বাকি লাইন যোগ করুন',
+    openLinesTitle: 'অর্ডার বাকি লাইন',
+    openLinesDescription:
+      '{{warehouse}}-এর অনুমোদিত রিকুইজিশন, সবচেয়ে পুরনোটা আগে। প্রতি ক্লিকে যা বাকি তার একটা লাইন যোগ হয়।',
+    openLinesSearch: 'আইটেম বা রিকুইজিশন নম্বর দিয়ে খুঁজুন',
+    openLinesEmpty: 'এই গুদামের জন্য অর্ডারের আর কিছু বাকি নেই।',
+    openLineNeededBy: '{{number}} · {{date}}-এর মধ্যে লাগবে',
+    openLineLeft: '{{quantity}} অর্ডার বাকি',
+    pickWarehouseFirst: 'আগে গুদাম বাছুন: অর্ডার বাকি লাইন গুদাম ধরে আসে।',
+    saveDraft: 'খসড়া সেভ করুন',
+    draftSaved: 'খসড়া সেভ হয়েছে',
+    saved: '{{number}} সেভ হয়েছে',
+    edit: 'বদলান',
+    submit: 'অনুমোদনে পাঠান',
+    submitHint:
+      'এখনই এর নম্বর হবে। VAT-সহ মোট টাকা ঠিক করে কে অনুমোদন করবেন, আর অপেক্ষার সময় কেউ এটা বদলাতে পারবেন না।',
+    submitted: '{{number}} অনুমোদনে পাঠানো হয়েছে',
+    submittedApproved: '{{number}} অনুমোদিত',
+    numberedDraft: 'এই খসড়া তার নম্বর {{number}} রাখবে। বদল শেষ হলে আবার অনুমোদনে পাঠান।',
+    deleteDraft: 'খসড়া মুছুন',
+    confirmDelete: 'এই খসড়া মুছুন',
+    deleteWarning: 'মুছে ফেলা খসড়া আর ফেরানো যায় না। এর কখনো নম্বর ছিল না।',
+    deleted: 'খসড়া মুছে ফেলা হয়েছে',
+    receive: 'মাল গ্রহণ করুন',
+    reopen: 'আবার খুলুন',
+    reopenTitle: '{{number}} আবার খুলুন',
+    reopenBody:
+      'বদলানোর জন্য এটা খসড়ায় ফিরবে, আর প্রথম লেভেল থেকে আবার অনুমোদন হবে। নম্বর একই থাকবে। সাপ্লায়ারের কাছে আগেরটা থাকলে নতুনটা পাঠান।',
+    reopened: '{{number}} আবার খসড়া',
+    close: 'অর্ডার বন্ধ করুন',
+    closeTitle: '{{number}} বন্ধ করুন',
+    closeBody:
+      'যা আসেনি তা বাদ যাবে, আর এর রিকুইজিশন বাকিটা আবার অর্ডার করতে পারবে। এই অর্ডারের খসড়া মাল গ্রহণ আর পোস্ট করা যাবে না।',
+    closed: '{{number}} বন্ধ হয়েছে',
+    cancel: 'অর্ডার বাতিল করুন',
+    cancelTitle: '{{number}} বাতিল করুন',
+    cancelBody:
+      'অর্ডারটা বাতিল হবে, আর এর রিকুইজিশন আবার অর্ডার করা যাবে। তালিকায় বাতিল হিসেবে থেকে যাবে। সাপ্লায়ারের কাছে থাকলে তাকে জানান।',
+    cancelled: '{{number}} বাতিল হয়েছে',
+    keepOrder: 'অর্ডার রাখুন',
+    received: 'এসেছে',
+    rejected: 'রিজেক্ট',
+    left: 'আসা বাকি',
+    serviceLine: 'সার্ভিস: মাল আসে না',
+    notices: {
+      pending: 'অনুমোদনের অপেক্ষায়। বদলাতে আবার খুলুন।',
+      approved:
+        'অনুমোদিত। সাপ্লায়ারকে পাঠান, আর মাল এলে গ্রহণ করুন। বদলাতে আবার খুলুন; তখন আবার অনুমোদন লাগবে।',
+      receiving:
+        'এর বিপরীতে মাল এসেছে, তাই আর আবার খোলা বা বাতিল করা যাবে না। বাকিটা না এলে বন্ধ করুন।',
+      received: 'অর্ডারের সব মাল এসেছে।',
+      closed: 'বন্ধ। যা আসেনি তা বাদ গেছে।',
+      cancelled: 'বাতিল। রেকর্ডের জন্য এখানে থেকে যায়।',
+      rejected: '{{name}} ফেরত পাঠিয়েছেন: "{{comment}}" বদলে আবার অনুমোদনে পাঠান।',
+    },
+    requisitions: 'রিকুইজিশন',
+    receiptsTitle: 'মাল গ্রহণ',
+    receiptsSubtitle: 'এই অর্ডারের বিপরীতে যা এসেছে',
+    noReceipts: 'এখনো কিছু আসেনি।',
+    approvedOn: '{{date}}-এ অনুমোদিত',
+    cantWrite:
+      'আপনি পারচেজ অর্ডার দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে purchase.order.manage permission চান।',
+    notFound: 'এই অর্ডার নেই, অথবা এটা একটা খসড়া ছিল যা মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো পারচেজ অর্ডার নেই',
+    emptyBody:
+      'অনুমোদিত রিকুইজিশনে যা লাগে তার অর্ডার দিন, যেমন নারায়ণগঞ্জের একটা স্পিনিং মিল থেকে ৩০s সুতার ২,০০০ কোন। এটা অনুমোদন হয়, সাপ্লায়ারের কাছে যায়, আর গেটে মাল গ্রহণ হয়।',
+    loadFailed: 'পারচেজ অর্ডারগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  goodsReceipts: {
+    title: 'মাল গ্রহণ (GRN)',
+    description: 'GRN: অনুমোদিত পারচেজ অর্ডারের বিপরীতে সাপ্লায়ারের কাছ থেকে আসা মাল',
+    new: 'নতুন মাল গ্রহণ',
+    newTitle: 'নতুন মাল গ্রহণ',
+    draftTitle: 'খসড়া মাল গ্রহণ',
+    back: 'মাল গ্রহণ',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: { draft: 'খসড়া', posted: 'পোস্ট করা' },
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      supplier: 'সাপ্লায়ার',
+      order: 'পারচেজ অর্ডার',
+      warehouse: 'গুদাম',
+      lines: 'আইটেম',
+      status: 'অবস্থা',
+    },
+    supplier: 'সাপ্লায়ার',
+    order: 'পারচেজ অর্ডার',
+    orderPlaceholder: 'একটা অনুমোদিত অর্ডার বাছুন',
+    orderEmpty: 'কোনো অনুমোদিত অর্ডার মালের অপেক্ষায় নেই।',
+    orderHint: 'মাল এই অর্ডারের দামে হিসাবে ওঠে।',
+    orderLocked: 'অর্ডার বদলাবে না। অন্য অর্ডারের মালের জন্য আরেকটা মাল গ্রহণ লিখুন।',
+    date: 'তারিখ',
+    warehouse: 'যেখানে নামানো হলো',
+    warehouseHint: 'যে গুদামে মাল নামানো হয়। অর্ডারে লেখা আছে {{warehouse}}।',
+    supplierChallan: 'সাপ্লায়ারের চালান',
+    supplierChallanPlaceholder: 'CH-2026-1187',
+    vehicle: 'গাড়ি আর চালক',
+    vehiclePlaceholder: 'ঢাকা মেট্রো-ট ১১-২২৩৩, রহিম',
+    note: 'নোট',
+    notePlaceholder: 'QC দেখেছে। বৃষ্টিতে ভেজা ৩টা বস্তা ফেরত দেওয়া হলো।',
+    fillFromOrder: 'অর্ডারে যা বাকি আছে যোগ করুন',
+    nothingLeft: 'এই অর্ডারে আসার আর কিছু বাকি নেই।',
+    ordered: 'অর্ডার {{quantity}}',
+    leftOnOrder: 'অর্ডারে {{quantity}} বাকি',
+    allowed: '{{quantity}} পর্যন্ত আসতে পারে',
+    accepted: 'গ্রহণ করা',
+    rejected: 'রিজেক্ট',
+    rejectionReason: 'রিজেক্টের কারণ',
+    rejectionReasonPlaceholder: 'ভেজা, শেড মেলেনি',
+    came: '{{quantity}} এসেছে',
+    saveDraft: 'খসড়া সেভ করুন',
+    post: 'মাল গ্রহণ পোস্ট করুন',
+    posting: 'পোস্ট হচ্ছে…',
+    posted: '{{number}} পোস্ট হয়েছে',
+    draftSaved: 'খসড়া সেভ হয়েছে',
+    deleteDraft: 'খসড়া মুছুন',
+    confirmDelete: 'এই খসড়া মুছুন',
+    deleteWarning: 'মুছে ফেলা খসড়া আর ফেরানো যায় না।',
+    deleted: 'খসড়া মুছে ফেলা হয়েছে',
+    postHint:
+      'পোস্ট করলে যা গ্রহণ করা হয়েছে তা অর্ডারের দামে স্টকে ঢোকে, আর সাপ্লায়ারের বিল না আসা পর্যন্ত "মাল এসেছে, বিল আসেনি" হিসেবে দেনা থাকে। পোস্ট করা মাল গ্রহণ আর বদলায় না।',
+    cantWrite:
+      'আপনি মাল গ্রহণ দেখতে পারেন। লিখতে আর পোস্ট করতে একজন workspace owner-এর কাছে purchase.receipt.manage permission চান।',
+    postedOn: '{{date}}-এ পোস্ট হয়েছে',
+    entry: 'জার্নাল এন্ট্রি',
+    noEntry: 'জার্নাল এন্ট্রি নেই: যা এসেছে তার কোনো মূল্য ছিল না',
+    notFound: 'এই মাল গ্রহণ আর নেই। খসড়াটা হয়তো মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো মাল গ্রহণ নেই',
+    emptyBody:
+      'গেটে ট্রাক এলে এখানে তার পারচেজ অর্ডার বাছুন, অথবা অর্ডারের পেজ থেকে মাল গ্রহণ করুন।',
+    loadFailed: 'মাল গ্রহণগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   approvals: {
     title: 'অনুমোদন',
     description: 'যে ডকুমেন্টগুলো আপনার সিদ্ধান্তের অপেক্ষায়, সবচেয়ে পুরনোটা আগে',
-    kinds: { requisition: 'রিকুইজিশন' },
+    kinds: { requisition: 'রিকুইজিশন', purchase_order: 'পারচেজ অর্ডার' },
     columns: {
       document: 'ডকুমেন্ট',
       date: 'তারিখ',
@@ -2584,7 +2811,7 @@ export const bn: Messages = {
     stepOf: '{{count}}-এর মধ্যে {{position}}',
     emptyTitle: 'কিছুই আপনার অপেক্ষায় নেই',
     emptyBody:
-      'কেউ এমন রিকুইজিশন পাঠালে যাতে আপনার রোল লাগে, সেটা এখানে দেখাবে আর বেল আপনাকে জানাবে।',
+      'কেউ এমন রিকুইজিশন বা পারচেজ অর্ডার পাঠালে যাতে আপনার রোল লাগে, সেটা এখানে দেখাবে আর বেল আপনাকে জানাবে।',
     loadFailed: 'আপনার অপেক্ষার ডকুমেন্টগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     cardTitle: 'অনুমোদন',
     cardSubtitle: 'যতগুলো লেভেলে পৌঁছায়, একটার পর একটা অনুমোদন করে',
@@ -2639,6 +2866,10 @@ export const bn: Messages = {
         title: 'পারচেজ রিকুইজিশন',
         subtitle: 'রিকুইজিশনের আনুমানিক টাকা অনুযায়ী',
       },
+      purchase_order: {
+        title: 'পারচেজ অর্ডার',
+        subtitle: 'অর্ডারের VAT-সহ মোট টাকা অনুযায়ী',
+      },
     },
     level: 'লেভেল {{number}}',
     from: 'যত টাকা থেকে',
@@ -2663,6 +2894,7 @@ export const bn: Messages = {
       invoice: 'ইনভয়েস',
       receipt: 'মানি রিসিট',
       credit_note: 'ক্রেডিট নোট',
+      purchase_order: 'পারচেজ অর্ডার',
     },
     send: 'পাঠান',
     downloadPdf: 'PDF ডাউনলোড',
@@ -2686,6 +2918,8 @@ export const bn: Messages = {
       toPlaceholder: 'accounts@rahmantraders.com.bd',
       noCustomerEmail:
         'এই গ্রাহকের কোনো ইমেইল ঠিকানা নেই। এখানে লিখুন, বা গ্রাহকের তথ্যে যোগ করুন।',
+      noSupplierEmail:
+        'এই সাপ্লায়ারের কোনো ইমেইল ঠিকানা নেই। এখানে লিখুন, বা সাপ্লায়ারের তথ্যে যোগ করুন।',
       subject: 'বিষয়',
       message: 'মেসেজ',
       messageHint: 'আপনার মেসেজের নিচে ইমেইলে লেখা থাকবে কী সংযুক্ত আছে আর কীভাবে উত্তর দিতে হবে।',
@@ -2721,6 +2955,8 @@ export const bn: Messages = {
       messageCopied: 'মেসেজ কপি হয়েছে',
       openWhatsApp: 'WhatsApp খুলুন',
       noNumber: 'গ্রাহকের ফোন নম্বরটা মোবাইল নম্বর না, তাই WhatsApp আপনাকে কন্টাক্ট বাছতে বলবে।',
+      noSupplierNumber:
+        'সাপ্লায়ারের ফোন নম্বরটা মোবাইল নম্বর না, তাই WhatsApp আপনাকে কন্টাক্ট বাছতে বলবে।',
       shownOnce: 'লিংকটা শুধু এখনই দেখা যাবে। পরে আবার পাঠাতে হলে নতুন একটা তৈরি করুন।',
     },
     shares: {
@@ -2749,7 +2985,7 @@ export const bn: Messages = {
     document: 'ডকুমেন্ট',
     pageTitle: '{{company}}-এর {{document}} {{number}}',
     from: 'প্রেরক: {{company}}',
-    to: 'প্রাপক: {{customer}}',
+    to: 'প্রাপক: {{recipient}}',
     number: 'নং',
     date: 'তারিখ',
     total: 'মোট',
@@ -2776,6 +3012,7 @@ export const bn: Messages = {
       salesReturn: 'সেলস রিটার্ন',
       creditNote: 'ক্রেডিট নোট',
       refund: 'রিফান্ড',
+      purchaseOrder: 'পারচেজ অর্ডার',
     },
     bin: 'BIN {{bin}}',
     phone: 'ফোন {{phone}}',
@@ -2790,6 +3027,13 @@ export const bn: Messages = {
     billTo: 'বিলের ঠিকানা',
     shipTo: 'পাঠানোর ঠিকানা',
     customer: 'গ্রাহক',
+    supplier: 'সরবরাহকারী',
+    deliverBy: 'সরবরাহের তারিখ',
+    deliverTo: 'যেখানে পৌঁছাবে',
+    paymentTerms: 'পেমেন্টের মেয়াদ',
+    termsDays_one: '{{count}} দিন',
+    termsDays_other: '{{count}} দিন',
+    onDelivery: 'মাল পাওয়ার সময়',
     columns: {
       number: '#',
       item: 'আইটেম',
@@ -3008,8 +3252,13 @@ export const bn: Messages = {
         balance: 'সাপ্লায়ারদের কাছে কোম্পানির কত দেনা, আর তাদের স্টেটমেন্ট দেখা',
       },
       requisition: {
-        manage: 'রিকুইজিশন লেখা, অনুমোদনে পাঠানো, আবার খোলা আর বাতিল করা',
+        manage: 'রিকুইজিশন লেখা, অনুমোদনে পাঠানো, আবার খোলা, বন্ধ আর বাতিল করা',
+      },
+      order: {
+        manage:
+          'পারচেজ অর্ডার লেখা, অনুমোদনে পাঠানো, সাপ্লায়ারকে পাঠানো, আবার খোলা, বন্ধ আর বাতিল করা',
       },
+      receipt: { manage: 'অনুমোদিত পারচেজ অর্ডারের মাল গ্রহণ করা, আর মাল গ্রহণ পোস্ট করা' },
     },
   },
   invite: {
@@ -3072,6 +3321,8 @@ export const bn: Messages = {
       supplier: 'সাপ্লায়ার',
       supplier_group: 'সাপ্লায়ারের গ্রুপ',
       requisition: 'পারচেজ রিকুইজিশন',
+      purchase_order: 'পারচেজ অর্ডার',
+      goods_receipt: 'মাল গ্রহণ',
     },
     columns: {
       when: 'কখন',
@@ -3283,6 +3534,20 @@ export const bn: Messages = {
         updated: 'একটা খসড়া রিকুইজিশন বদলেছেন',
         deleted: 'একটা খসড়া রিকুইজিশন মুছেছেন',
         cancelled: 'একটা রিকুইজিশন বাতিল করেছেন',
+        closed: 'একটা রিকুইজিশন বন্ধ করেছেন',
+      },
+      purchase_order: {
+        created: 'একটা পারচেজ অর্ডার লিখেছেন',
+        updated: 'একটা খসড়া পারচেজ অর্ডার বদলেছেন',
+        deleted: 'একটা খসড়া পারচেজ অর্ডার মুছেছেন',
+        closed: 'একটা পারচেজ অর্ডার বন্ধ করেছেন',
+        cancelled: 'একটা পারচেজ অর্ডার বাতিল করেছেন',
+      },
+      goods_receipt: {
+        created: 'একটা মাল গ্রহণ লিখেছেন',
+        updated: 'একটা খসড়া মাল গ্রহণ বদলেছেন',
+        deleted: 'একটা খসড়া মাল গ্রহণ মুছেছেন',
+        posted: 'একটা মাল গ্রহণ পোস্ট করেছেন',
       },
       approval: {
         submitted: 'অনুমোদনে পাঠিয়েছেন',
@@ -3382,7 +3647,7 @@ export const bn: Messages = {
       quotation: 'কোটেশন',
       deliveryDate: 'ডেলিভারির তারিখ',
       customerReference: 'গ্রাহকের রেফারেন্স',
-      order: 'সেলস অর্ডার',
+      order: 'অর্ডার',
       vehicle: 'গাড়ি',
       dueDate: 'পরিশোধের তারিখ',
       amount: 'টাকা',
@@ -3402,6 +3667,13 @@ export const bn: Messages = {
       role: 'রোল',
       comment: 'মন্তব্য',
       requisition: 'পারচেজ রিকুইজিশন',
+      overReceiptPercent: 'অর্ডারের বেশি গ্রহণ (%)',
+      received_not_billed: 'মাল এসেছে, বিল আসেনি',
+      supplier: 'সাপ্লায়ার',
+      expectedDate: 'যেদিনের মধ্যে আসবে',
+      supplierReference: 'সাপ্লায়ারের রেফারেন্স',
+      supplierChallan: 'সাপ্লায়ারের চালান',
+      purchase_order: 'পারচেজ অর্ডার',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -3714,7 +3986,7 @@ export const bn: Messages = {
     stock_account_invalid: 'ঠিক ধরনের একটা সক্রিয় অ্যাকাউন্ট বাছুন।',
     stock_account_inventory: 'অন্য অ্যাকাউন্ট বাছুন: এটা নিজেই ইনভেন্টরির অ্যাকাউন্ট।',
     journal_account_stock:
-      'এই অ্যাকাউন্টে শুধু স্টকের ডকুমেন্ট পোস্ট করে। এর বদলে স্টক অ্যাডজাস্টমেন্ট বা পুনর্মূল্যায়ন করুন।',
+      'এই অ্যাকাউন্টে শুধু স্টকের ডকুমেন্ট পোস্ট করে, যেমন ইনভেন্টরি, পথে থাকা মাল বা "মাল এসেছে, বিল আসেনি"। এর বদলে স্টক অ্যাডজাস্টমেন্ট, পুনর্মূল্যায়ন বা মাল গ্রহণ করুন।',
     journal_is_stock:
       'এই এন্ট্রিটা একটা স্টকের ডকুমেন্ট বানিয়েছে। সংশোধন করতে আরেকটা স্টকের ডকুমেন্ট পোস্ট করুন।',
     revaluation_no_stock: 'এই আইটেমের পুনর্মূল্যায়নের মতো স্টক নেই।',
@@ -3866,7 +4138,7 @@ export const bn: Messages = {
     account_used_by_sales:
       'ক্রেডিট নোট এই অ্যাকাউন্টে পোস্ট হয়। আগে সেটিংস → বিক্রি থেকে সেলস রিটার্নের অন্য একটা অ্যাকাউন্ট বাছুন।',
     document_not_issued:
-      'এই ডকুমেন্টের এখনো নম্বর হয়নি, বা এটা বাতিল হয়েছে, তাই ডাউনলোড বা পাঠানো যাবে না। আগে পোস্ট করুন।',
+      'এই ডকুমেন্ট এখনো ডাউনলোড বা পাঠানো যাবে না। আগে পোস্ট করুন, বা অনুমোদনের অপেক্ষা করুন। বাতিল হওয়া ডকুমেন্ট পাঠানো যায় না।',
     email_to_required: 'অন্তত একটা ঠিকানা লিখুন।',
     email_too_many: 'একটা ঘরে সর্বোচ্চ ৫টা ঠিকানা। বাকিদের আরেকটা ইমেইল পাঠান।',
     email_subject_required: 'একটা বিষয় লিখুন।',
@@ -3908,6 +4180,31 @@ export const bn: Messages = {
       'শুধু খসড়া বা অনুমোদিত ডকুমেন্ট বাতিল করা যায়। অপেক্ষায় থাকাটা আগে আবার খুলুন।',
     requisition_needed_by: 'রিকুইজিশনের তারিখ বা তার পরের একটা দিন বাছুন।',
     requisition_cost_required: 'আনুমানিক খরচ দিন। বিনা মূল্যের আইটেমে ০ দেওয়া যায়।',
+    purchase_supplier_required: 'সাপ্লায়ার বাছুন।',
+    purchase_supplier_invalid:
+      'একজন চালু সাপ্লায়ার বাছুন। নম্বর পাওয়া অর্ডারের সাপ্লায়ার বদলায় না: অন্য সাপ্লায়ারের জন্য নতুন অর্ডার লিখুন।',
+    purchase_expected_date: 'অর্ডারের তারিখ বা তার পরের একটা দিন বাছুন।',
+    purchase_requisition_line_invalid:
+      'এই লাইন আর ওই রিকুইজিশনের জন্য কিনতে পারে না: রিকুইজিশনটা অনুমোদিত, এই গুদামের আর একই আইটেমের হতে হবে। অর্ডার বাকি লাইন থেকে আবার বাছুন।',
+    purchase_requisition_line_twice:
+      'এই অর্ডারের আরেকটা লাইন একই রিকুইজিশন লাইনের জন্য কিনছে। এর বদলে ওই লাইনের পরিমাণ বদলান।',
+    purchase_close_instead:
+      'পরের একটা ডকুমেন্ট এটা ব্যবহার করছে, তাই আবার খোলা বা বাতিল করা যাবে না। এর বদলে বন্ধ করুন।',
+    purchase_cancel_instead:
+      'এর বিপরীতে এখনো কিছু অর্ডার হয়নি বা আসেনি, তাই বন্ধ করার কিছু নেই। এর বদলে বাতিল করুন।',
+    purchase_delete_instead: 'এই খসড়া কখনো পাঠানো হয়নি, এর নম্বরও নেই। এর বদলে মুছে ফেলুন।',
+    purchase_receipt_draft:
+      'এই অর্ডারের একটা খসড়া মাল গ্রহণ অপেক্ষায় আছে। আগে খসড়াটা মুছুন, অথবা পোস্ট করে অর্ডারটা বন্ধ করুন।',
+    purchase_not_approved:
+      'এই ডকুমেন্ট আর অনুমোদিত নেই: কেউ এটা আবার খুলেছেন, বন্ধ বা বাতিল করেছেন। এখন কোথায় আছে দেখতে রিলোড করুন।',
+    grn_order_invalid: 'একটা অনুমোদিত পারচেজ অর্ডার বাছুন।',
+    grn_order_line_invalid:
+      'এই লাইন পারচেজ অর্ডারে নেই, অথবা অন্য আইটেমের। অর্ডার থেকে আবার যোগ করুন।',
+    grn_over_order:
+      'সেটিংসের অর্ডারের বেশি গ্রহণের শতাংশ ধরেও এটা অর্ডারের চেয়ে বেশি। কম গ্রহণ করুন, আর বাকিটা রিজেক্ট হিসেবে লিখুন।',
+    grn_line_empty: 'কতটা গ্রহণ করা হলো, কতটা রিজেক্ট, বা দুটোই লিখুন।',
+    grn_rejection_reason: 'মাল কেন রিজেক্ট হলো লিখুন, যেমন "ভেজা" বা "শেড মেলেনি"।',
+    over_receipt_percent_format: '০ থেকে ১০০-এর মধ্যে একটা শতাংশ দিন, সর্বোচ্চ ২ দশমিক ঘর।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
```

The Bangla follows the words of 17a: "সাপ্লায়ার", "অনুমোদন", "খসড়া", "আবার খুলুন", "বাতিল". A few choices:

- **"পারচেজ অর্ডার"** is written in Bangla letters, like "রিকুইজিশন" and "সেলস অর্ডার". It is the PDF's word
  too (17b.3), and PO is an office word in Bangladesh, so a translation such as "ক্রয়াদেশ" would read stranger.
- **"মাল গ্রহণ (GRN)"** for a goods receipt: the Numbering page already calls the series that, and GRN is the
  word store keepers use on the paper.
- **"রিজেক্ট"** for the goods turned back at the gate. It is the word of the QC desk in garments factories. The
  approval's "ফেরত পাঠানো" (sent back) stays for a rejected approval, so the two never mix on one page.
- **"মাল এসেছে, বিল আসেনি"** for goods received not billed: the plain sentence an accountant says, not a
  coined term.
- **The print words match the PDF,** not the app: "সরবরাহকারী", "সরবরাহের তারিখ", "যেখানে পৌঁছাবে", "পেমেন্টের
  মেয়াদ", "মাল পাওয়ার সময়". The browser's print and the PDF are the same document for the supplier.
- Owner, role, permission keys, VAT, QC and PO stay in English inside the Bangla text, as in the rest of the file
  (CLAUDE.md → Language).

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
```

Build `@omnivo/contracts` first: the i18n package reads its built `ErrorCode` type, so until then the 16 new codes
are unknown and the `satisfies` line fails the other way round. Build `@omnivo/i18n` before you type-check the ui
package and the app, which read its built types.

> **What we checked in this part.** `packages/i18n` type-checks, ESLint and Prettier are clean, its unit tests pass
> (11), and it builds. `packages/ui` type-checks against the new build. The app has 28 type errors left, all about
> new contract fields in the screens and the mocks (17b.6 and 17b.7); none is about a missing translation key. To be
> sure `bn.ts` cannot fall behind, we removed two Bangla keys on purpose, one at a time (an error text and a word in
> the new `purchaseOrders` section): the type check failed each time, and passed again with the key back.

---

## 17b.6 — `apps/app`: the screens

This part adds the purchase orders and the goods receipts: their lists, forms and pages, the order's approval, its
Send menu and its printed copy. It also changes the screens 17b's contract touches: the requisition page learns
what was ordered and gets "Make purchase order" and "Close", the stock page and the reorder report show what is
coming, Settings gets the over-receipt percent and the new stock account, and the public page says `recipient`.

When this part starts, the app has 28 type errors (17b.5 lists them). When it ends, the app's own code
type-checks; the 22 errors left are all in `src/mocks/`, which 17b.7 brings up to the new contract. Because of
them, `pnpm --filter @omnivo/app build` (which runs `tsc` first) still fails, so the bundle is checked with
`vite build` directly below. The mock API and the browser tests come in 17b.7, so nothing here is clicked through
yet.

The order below is the order to write the files in: each one only uses files above it.

### What the contract changed: Settings, the stock accounts, the public page

```diff
@@ -1,4 +1,4 @@
-import type { Settings, updateSettingsInputSchema } from '@omnivo/contracts';
+import { plainQuantity, type Settings, type updateSettingsInputSchema } from '@omnivo/contracts';
 import type { z } from 'zod';
 
 // Shared by the settings page and the onboarding wizard's company step (moved from
@@ -23,5 +23,7 @@ export function settingsToForm(settings: Settings): SettingsFormValues {
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
     pricesIncludeVat: settings.pricesIncludeVat,
+    // Step 17b: "3.00" from the server is "3" in the box, and "0.00" is "0"
+    overReceiptPercent: plainQuantity(settings.overReceiptPercent),
   };
 }
```

```diff
@@ -241,6 +241,20 @@ function SettingsForm({ settings, canManage }: { settings: Settings; canManage:
               {t('settings.allowNegativeStockHint')}
             </p>
           </div>
+          {/* Step 17b: how much more than ordered a goods receipt may bring in */}
+          <div className="grid max-w-xs grid-cols-1 border-t border-line p-5">
+            <TextField
+              label={t('settings.overReceiptPercent')}
+              hint={t('settings.overReceiptPercentHint')}
+              inputMode="decimal"
+              autoComplete="off"
+              align="end"
+              suffix="%"
+              disabled={!canManage}
+              {...register('overReceiptPercent')}
+              error={errors.overReceiptPercent?.message}
+            />
+          </div>
         </Card>
 
         {/* Step 15a. Saved with the company settings, like the stock rule above. */}
```

- **`plainQuantity` turns the server's "3.00" into "3"** for the box, and "0.00" into "0". The contract takes
  either; the person sees what they typed.
- **The box sits under "Allow negative stock",** in the same card, saved with the same form (decision 22). It has
  its own row with a top rule, so the checkbox's hint is not read as the box's.
- **`max-w-xs` and `align="end"`:** a percent is a short number, read from the right like every number, and the
  `%` sits inside the box as a suffix.
- **`disabled={!canManage}`** like the checkbox above it: everyone may read the settings, only a manager changes
  them.

```diff
@@ -22,7 +22,7 @@ import { accountsQuery, stockAccountsQuery } from '../lib/queries';
 // Settings → Inventory, step 14: where stock documents post in the books. Its own form and save
 // button: the choices are saved by their own endpoint, apart from the company settings above.
 const GROUPS: readonly {
-  key: 'adjustments' | 'transfers' | 'revaluation';
+  key: 'adjustments' | 'transfers' | 'revaluation' | 'purchase';
   uses: StockAccountUse[];
 }[] = [
   {
@@ -31,6 +31,8 @@ const GROUPS: readonly {
   },
   { key: 'transfers', uses: ['in_transit', 'transfer_shortage'] },
   { key: 'revaluation', uses: ['revaluation'] },
+  // Step 17b: what goods receipts owe until the supplier's bill (a liability)
+  { key: 'purchase', uses: ['received_not_billed'] },
 ];
 
 function toForm(choices: StockAccounts): StockAccountsFormValues {
@@ -45,6 +47,7 @@ function toForm(choices: StockAccounts): StockAccountsFormValues {
     correction: choices.correction ?? '',
     transfer_shortage: choices.transfer_shortage ?? '',
     revaluation: choices.revaluation ?? '',
+    received_not_billed: choices.received_not_billed ?? '',
   };
 }
 
@@ -151,7 +154,10 @@ function StockAccountsForm({
                   key={use}
                   label={t(`settings.stockAccountUses.${use}`)}
                   hint={
-                    use === 'in_transit' || use === 'transfer_shortage' || use === 'revaluation'
+                    use === 'in_transit' ||
+                    use === 'transfer_shortage' ||
+                    use === 'revaluation' ||
+                    use === 'received_not_billed'
                       ? t(`settings.stockAccountHints.${use}`)
                       : undefined
                   }
```

The new use `received_not_billed` (decision 12) gets its own group, "Buying", and its hint (it is a liability, so
the select lists only liability accounts). `toForm` must name every use: the form type is a `Record` over the uses,
so the type check failed until the new key was there.

```diff
@@ -16,8 +16,8 @@ import { type ReactNode, useEffect } from 'react';
 import { ApiRequestError, call } from '../lib/api';
 import { saveFile } from '../lib/document-output';
 
-// Step 16: the page behind a share link (/d/<token>). No login and no app shell: the customer is
-// not an Omnivo user. It says what the document is and from whom, and downloads its PDF.
+// Step 16: the page behind a share link (/d/<token>). No login and no app shell: the customer (step
+// 17b: or the supplier of a purchase order) is not an Omnivo user. It says what the document is and from whom, and downloads its PDF.
 
 // While the PDF is being drawn the page asks again every 2 s, at most 15 times (30 s). After that
 // it says the PDF could not be made: a worker that is down does not get better by being asked.
@@ -93,7 +93,7 @@ function DocumentCard({
           <span className="font-mono whitespace-nowrap tabular-nums">{shared.number}</span>
         </h1>
         <p className="text-body-sm text-ink-2">
-          {t('publicDocument.to', { customer: shared.customer })}
+          {t('publicDocument.to', { recipient: shared.recipient })}
         </p>
       </div>
       <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
```

The public page reads `recipient` now (decision 24), the supplier of a purchase order or the customer of a sales
document.

### The queries: `lib/queries.ts`

```diff
@@ -17,9 +17,12 @@ import {
   type ProductSort,
   type ProductStatus,
   type ProfitAndLossQuery,
+  type PurchaseOrderReceiptFilter,
+  type PurchaseOrderStatus,
   type QuotationStatus,
   type ReceiptStatus,
   type RefundStatus,
+  type RequisitionOrderFilter,
   type RequisitionStatus,
   routes,
   type StockDocumentStatus,
@@ -1173,7 +1176,9 @@ export function salesAccountsQuery(tenantId: string) {
 // ---------------------------------------------------------------------------------------------
 // Requisitions and approvals (step 17a). Everything starts with ['purchase', tenantId]: approving a
 // requisition changes the requisition, its list, the "waiting for me" list and the navigation's
-// count, and one invalidate refreshes them all. 17b's purchase orders join the prefix.
+// count, and one invalidate refreshes them all. Step 17b: the purchase orders and the goods
+// receipts join the prefix: approving an order changes what its requisitions have ordered, and
+// posting a receipt changes what its order has received.
 
 // The approval levels of every kind of document (Settings → Approval levels, and a draft's card)
 export function approvalRulesQuery(tenantId: string) {
@@ -1186,6 +1191,8 @@ export function approvalRulesQuery(tenantId: string) {
 export interface RequisitionListFilter {
   status: RequisitionStatus | '';
   warehouseId: string;
+  // Step 17b: "To order" is the buyer's queue: approved, with a line not ordered in full
+  order: RequisitionOrderFilter | '';
 }
 
 export function requisitionsQuery(tenantId: string, filter: RequisitionListFilter) {
@@ -1197,6 +1204,7 @@ export function requisitionsQuery(tenantId: string, filter: RequisitionListFilte
           limit: 50,
           ...(filter.status !== '' && { status: filter.status }),
           ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
+          ...(filter.order !== '' && { order: filter.order }),
           ...(pageParam !== null && { cursor: pageParam }),
         },
       }),
@@ -1214,6 +1222,113 @@ export function requisitionQuery(tenantId: string, requisitionId: string) {
   });
 }
 
+// Step 17b: the lines still to order for one warehouse, oldest requisition first (decision 18).
+// The first 50 that match: the dialog searches instead of scrolling through hundreds.
+export function openRequisitionLinesQuery(
+  tenantId: string,
+  filter: { warehouseId: string; requisitionId: string; search: string },
+) {
+  return queryOptions({
+    queryKey: ['purchase', tenantId, 'requisition-lines', filter],
+    queryFn: async () =>
+      (
+        await call(routes.requisitionLines.open, {
+          query: {
+            limit: 50,
+            warehouseId: filter.warehouseId,
+            ...(filter.requisitionId !== '' && { requisitionId: filter.requisitionId }),
+            ...(filter.search !== '' && { search: filter.search }),
+          },
+        })
+      ).items,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export interface PurchaseOrderListFilter {
+  status: PurchaseOrderStatus | '';
+  warehouseId: string;
+  supplierId: string;
+  // "To receive": approved, with goods still to come (the store keeper's queue)
+  receipt: PurchaseOrderReceiptFilter | '';
+}
+
+export function purchaseOrdersQuery(tenantId: string, filter: PurchaseOrderListFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['purchase', tenantId, 'orders', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.purchaseOrders.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
+          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
+          ...(filter.receipt !== '' && { receipt: filter.receipt }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// The goods receipt form's order box: the supplier's approved orders with goods still to come.
+// 100 at most, like the delivery's open orders: a supplier with more open orders than that is a
+// problem of its own.
+export function ordersToReceiveQuery(tenantId: string, supplierId: string) {
+  return queryOptions({
+    queryKey: ['purchase', tenantId, 'orders', 'to-receive', supplierId],
+    queryFn: async () =>
+      (
+        await call(routes.purchaseOrders.list, {
+          query: { limit: 100, receipt: 'to_receive', supplierId },
+        })
+      ).items,
+  });
+}
+
+export function purchaseOrderQuery(tenantId: string, orderId: string) {
+  return queryOptions({
+    queryKey: ['purchase', tenantId, 'order', orderId],
+    queryFn: () => call(routes.purchaseOrders.get, { params: { id: orderId } }),
+    retry: false,
+  });
+}
+
+export interface GoodsReceiptListFilter {
+  status: StockDocumentStatus | '';
+  warehouseId: string;
+  supplierId: string;
+}
+
+export function goodsReceiptsQuery(tenantId: string, filter: GoodsReceiptListFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['purchase', tenantId, 'receipts', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.goodsReceipts.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
+          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function goodsReceiptQuery(tenantId: string, receiptId: string) {
+  return queryOptions({
+    queryKey: ['purchase', tenantId, 'receipt', receiptId],
+    queryFn: () => call(routes.goodsReceipts.get, { params: { id: receiptId } }),
+    retry: false,
+  });
+}
+
 // "Waiting for me", oldest first
 export function waitingApprovalsQuery(tenantId: string) {
   return infiniteQueryOptions({
```

- **Everything new is under `['purchase', tenantId]`.** Approving an order changes what its requisitions have
  ordered; posting a receipt changes what its order has received. One invalidate of the prefix refreshes all of
  them, as in 17a.
- **`RequisitionListFilter.order`:** the contract's `to_order` filter, the buyer's queue.
- **`openRequisitionLinesQuery` asks for the first 50 that match,** not a paged list. The dialog searches on the
  server (by item or requisition number), so a buyer types instead of scrolling through hundreds of lines.
  `placeholderData: keepPreviousData` keeps the old list on screen while a new search runs.
- **`ordersToReceiveQuery` is the goods receipt form's order box:** one supplier's approved orders with goods still
  to come, 100 at most, like the delivery form's open orders. It sits under the same `['purchase', tenant, 'orders']`
  prefix as the list, so a posted receipt refreshes it too.
- **`purchaseOrderQuery` and `goodsReceiptQuery` have `retry: false`:** a deleted draft answers 404 at once, and the
  page shows "not found" instead of retrying three times.

### The pure parts: `lib/purchase.ts`

```diff
@@ -1,18 +1,29 @@
 import {
+  addMoney,
   type ApprovalRound,
   type ApprovalStep,
+  compareQuantity,
   defaultLineDescription,
   draftRequisitionLineAmount,
+  isZeroQuantity,
+  percentOfMoney,
   plainQuantity,
   type Product,
   type ProductVariant,
+  type PurchaseOrder,
+  type PurchaseOrderLine,
+  type PurchaseOrderLineFormValues,
   type RequisitionLine,
   type RequisitionLineFormValues,
+  subtractQuantity,
   sumMoney,
   type VariantRef,
   waitingStep,
+  withTolerance,
 } from '@omnivo/contracts';
 
+import { type LineMeta, SALES_LINE_FIELDS, salesItemOf, toFormLine } from './sales';
+
 // The pure parts of the purchase pages (step 17a): no React, so they are unit-tested
 // (purchase.spec.ts) and shared by the form, the editor and the view. Here, not in
 // purchase-lines-editor.tsx: the form needs them at once, and the editor is a lazy chunk of its own.
@@ -148,3 +159,135 @@ export function approvedByOwnSubmit(round: ApprovalRound): boolean {
     )
   );
 }
+
+// ---------------------------------------------------------------------------------------------
+// Step 17b: what is left to order and to receive
+
+// What is more than nothing, or nothing: a line ordered or received over its quantity has nothing
+// left, never less than nothing
+function atLeastZero(value: string): string {
+  return compareQuantity(value, '0') > 0 ? value : '0.0000';
+}
+
+// What a requisition line still needs ordering, in the base unit (decision 16 counts what is
+// ordered)
+export function leftToOrder(line: RequisitionLine): string {
+  return atLeastZero(subtractQuantity(line.baseQuantity, line.orderedQuantity));
+}
+
+// An approved order whose delivery date has passed: attention, not a status. Nothing changes in
+// the database when the date passes; the page works it out, like a sales order's "Late". ISO dates
+// compare as strings.
+export function isOrderLate(
+  order: { status: string; expectedDate: string | null },
+  today: string,
+): boolean {
+  return order.status === 'approved' && order.expectedDate !== null && order.expectedDate < today;
+}
+
+// What an order line still has to bring, in the base unit. A service line (a dyeing charge) is
+// never received (decision 29); what was rejected does not count as received, the supplier still
+// owes it.
+export function leftToReceive(line: PurchaseOrderLine): string {
+  if (line.productType === 'service') return '0.0000';
+  return atLeastZero(subtractQuantity(line.baseQuantity, line.receivedQuantity));
+}
+
+// The most that may still come on an order line, in the base unit, with the workspace's
+// over-receipt percent (decision 22): the same withTolerance() the API checks with, less what
+// posted receipts accepted
+export function allowedToReceive(line: PurchaseOrderLine, percent: string): string {
+  if (line.productType === 'service') return '0.0000';
+  return atLeastZero(
+    subtractQuantity(withTolerance(line.baseQuantity, percent), line.receivedQuantity),
+  );
+}
+
+// A goods receipt line made from an order line: what it sends to the API, before the gate fills
+// in the lot and what it turned back
+export interface ReceiptFill {
+  orderLineId: string;
+  variantId: string;
+  unitId: string;
+  quantity: string;
+}
+
+// "Add what is left on the order": one line per goods line with something still to come, minus
+// what the form already holds for it (`onForm`: accepted base quantities by order line). A line
+// nothing came for yet keeps the order's unit and quantity (40 bags); a partly received one asks
+// for the rest in the base unit (120 kg), because the rest is rarely whole bags. Like the sales
+// order's fillFromOrder (15b).
+export function receiptFill(
+  lines: readonly PurchaseOrderLine[],
+  onForm: ReadonlyMap<string, string>,
+): ReceiptFill[] {
+  return lines.flatMap((line) => {
+    const already = onForm.get(line.id) ?? '0';
+    const left = subtractQuantity(leftToReceive(line), already);
+    if (compareQuantity(left, '0') <= 0) return [];
+    const untouched = isZeroQuantity(line.receivedQuantity) && isZeroQuantity(already);
+    return [
+      {
+        orderLineId: line.id,
+        variantId: line.variantId,
+        unitId: untouched ? line.unitId : line.baseUnitId,
+        quantity: untouched ? plainQuantity(line.quantity) : plainQuantity(left),
+      },
+    ];
+  });
+}
+
+// A purchase order line's starting price (decision 19). The cost lookup sends the net per unit:
+// what the goods were worth before VAT, whatever the earlier order's VAT setting was. An order
+// whose prices include VAT starts from the net plus its VAT at the line's rate, to the paisa, so
+// the "Price with VAT" box does not quietly start a VAT short. null stays null: nothing is known,
+// and the person types a price.
+export function startingPrice(
+  net: string | null,
+  rate: string | null,
+  pricesIncludeVat: boolean,
+): string | null {
+  if (net === null || !pricesIncludeVat || rate === null) return net;
+  return addMoney(net, percentOfMoney(net, rate));
+}
+
+// The fields of a purchase order line the server may name in an error: a sales line's, and the
+// requisition line it buys for ("lines.2.requisitionLineId": closed meanwhile, or twice)
+export const PURCHASE_ORDER_LINE_FIELDS = [...SALES_LINE_FIELDS, 'requisitionLineId'] as const;
+
+// A saved order's lines as the form holds them, the editor's meta, and the requisition each line
+// buys for (its number, for the link under the line). The sales line's own helpers: an order line
+// is a sales line (decision 6).
+export function savedOrderLines(order: PurchaseOrder): {
+  values: PurchaseOrderLineFormValues[];
+  meta: LineMeta[];
+  links: Map<string, { requisitionId: string; number: string }>;
+} {
+  return {
+    values: order.lines.map((line) => ({
+      ...toFormLine(line),
+      requisitionLineId: line.requisitionLine?.id ?? '',
+    })),
+    meta: order.lines.map((line) => ({
+      key: line.id,
+      item: salesItemOf(line),
+      source: undefined,
+      pricedFor: order.supplier.id,
+    })),
+    links: new Map(
+      order.lines.flatMap((line) =>
+        line.requisitionLine === null
+          ? []
+          : [
+              [
+                line.requisitionLine.id,
+                {
+                  requisitionId: line.requisitionLine.requisitionId,
+                  number: line.requisitionLine.number,
+                },
+              ],
+            ],
+      ),
+    ),
+  };
+}
```

These have no React, so they are unit-tested at the end of this part.

- **`atLeastZero`:** an order may order more than a requisition asked for (decision 16) and a receipt may bring
  in more than ordered (decision 22). "What is left" is then nothing, never a negative number on the screen.
- **`leftToOrder`** is the requisition line's base quantity less what orders cover, both in the base unit: one
  requisition line in bags may be ordered in cones.
- **`isOrderLate`** is worked out on the page, like a sales order's "Late": nothing changes in the database when
  the date passes. Only an approved order is late; a received or closed one is done.
- **`leftToReceive` leaves the rejected quantity out:** it does not count as received (decision 9), the supplier
  still owes it. A service line returns zero (decision 29): a dyeing charge is never received.
- **`allowedToReceive` uses the contract's own `withTolerance`,** the function the API checks with. The form's
  "Up to 430 m may come" is then exactly the limit the API refuses above, rounded down the same way.
- **`receiptFill` is the sales order's `fillFromOrder` for a goods receipt.** A line nothing came for keeps the
  order's unit and quantity (40 bags); a partly received line asks for the rest in the base unit, because the rest
  is rarely whole bags. `onForm` is what the form already accepts, so "Add what is left" never adds a line twice.
- **`startingPrice`** adds the VAT to a net price when the order's prices include VAT (decision 43). The cost lookup
  always sends the net (decision 19); without this, a buyer who ticks "Prices include VAT" would get a starting
  price 15% short in a box labelled "Price with VAT". It rounds to the paisa with `percentOfMoney`, the way the line
  math rounds VAT. A rate that is not loaded yet leaves the net, which the person can see and change.
- **`savedOrderLines`** turns a saved order back into form lines with the sales line's own `toFormLine` and
  `salesItemOf` (an order line is a sales line), plus the requisition each line buys for, so the link under the
  line can show the requisition's number. The form line only holds the requisition line's id.
- **`PURCHASE_ORDER_LINE_FIELDS`** is the sales line's fields plus `requisitionLineId`, so a server error on
  "lines.2.requisitionLineId" lands on that line.

### One line editor, two kinds of price

The order's lines are priced like a sales line (decision 6), so they use the sales editor (decision 43).

```diff
@@ -8,7 +8,8 @@ import {
   isZeroQuantity,
   type LineAmounts,
   plainQuantity,
-  type PriceSource,
+  type Product,
+  type ProductVariant,
   type SalesLine,
   type SalesLineFormValues,
   type SalesOrderLine,
@@ -145,11 +146,13 @@ export interface LineMeta {
   // React's key: stays with the line when a line above it is removed
   key: string;
   item: SalesItem;
-  // Where a new line's price came from (the price lookup). undefined for a saved line: nothing new
-  // to say about it.
-  source: PriceSource | null | undefined;
-  // The customer the price was looked up for ('' = none chosen yet). When the form's customer is
-  // another one, the editor offers to reprice.
+  // Where a new line's price came from: a PRICE_SOURCES value of the sales price lookup, or (step
+  // 17b, a purchase order) a PURCHASE_COST_SOURCES value of the cost lookup. A plain string: the
+  // editor serves both, and the pricing that asked says what it means (LinePricing.sourceText).
+  // undefined for a saved line: nothing new to say about it.
+  source: string | null | undefined;
+  // The party the price was looked up for: the customer, or (17b) the supplier ('' = none chosen
+  // yet). When the form's party is another one, the editor offers to reprice.
   pricedFor: string;
 }
 
@@ -165,6 +168,24 @@ export const SALES_LINE_FIELDS = [
   'taxRateId',
 ] as const;
 
+// The item of a variant of a product added with "Add items". Step 17b: also a requisition's line on
+// a purchase order, which brings its product from the product's own page.
+export function productItemOf(product: Product, variant: ProductVariant): SalesItem {
+  return {
+    variantId: variant.id,
+    productId: product.id,
+    productCode: product.code,
+    productName: product.name,
+    optionValues: variant.optionValues,
+    sku: variant.sku,
+    baseUnitId: product.baseUnitId,
+    units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
+    productType: product.type,
+    tracking: product.tracking,
+    hasExpiry: product.hasExpiry,
+  };
+}
+
 // The item of a saved line (step 15c: also an order's service line on an invoice)
 export function salesItemOf(line: SalesLine): SalesItem {
   return {
```

- **`LineMeta.source` is a plain string now,** not the sales `PriceSource`. The editor shows a sales source and a
  purchase source, and the pricing that asked knows what its own values mean.
- **`productItemOf`** builds a line's item from a product and a variant. The editor did this inline; the order's
  "lines still to order" needs the same item, so it moved here.

```diff
@@ -4,7 +4,6 @@ import {
   defaultLineDescription,
   MAX_SALES_LINES,
   plainQuantity,
-  type PriceLookupItem,
   type Product,
   routes,
   type SalesLineFormValues,
@@ -28,7 +27,13 @@ import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
 import type { FieldErrors } from 'react-hook-form';
 
 import { call } from '../lib/api';
-import { formTotals, isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
+import {
+  formTotals,
+  isServiceLine,
+  type LineMeta,
+  productItemOf,
+  type SalesItem,
+} from '../lib/sales';
 import { basePreview, unitChoices } from '../lib/stock';
 import { taxRateOptions, useRateText } from '../lib/tax-rates';
 import { taxRatesQuery, unitsQuery } from '../lib/queries';
@@ -42,7 +47,9 @@ import { useQuantity, useTenantId, useUnitCode, VariantCell } from './stock-part
 // array. A field array would need the form's own type here, and the forms have different types;
 // one array value has the same type in the quotation and the order (SalesLineFormValues[]), so
 // neither form needs a cast. An invoice line has more fields, so the editor is generic over the
-// line (LinesEditor<L>), and SalesLinesEditor is its plain sales-line form.
+// line (LinesEditor<L>), and SalesLinesEditor is its plain sales-line form. Step 17b: a purchase
+// order's line is a sales line too (decision 6), so its editor (purchase-order-lines.tsx) is this
+// one with another LinePricing: the supplier's last prices instead of the customer's price list.
 
 export type SalesLinesErrors = FieldErrors<{ lines: SalesLineFormValues[] }>['lines'];
 
@@ -54,6 +61,69 @@ function nextKey(): string {
 
 const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;
 
+// A new line's starting price, from either lookup: per one of the unit, null when nothing is
+// known (the person types it), where it came from, and the VAT rate the line starts with
+export interface LinePrice {
+  price: string | null;
+  source: string | null;
+  taxRateId: string;
+}
+
+// How a document prices the lines it adds (step 17b): the sales price lookup for a customer, or
+// the purchase cost lookup for a supplier. Everything else the editor does is the same for both.
+export interface LinePricing {
+  // The party the prices are for; '' = none chosen yet
+  partyId: string;
+  // The unit a product added with "Add items" starts in: its selling unit, or its buying unit
+  unitOf: (product: Product) => string;
+  // The prices of some variants in some units, by `${variantId}:${unitId}` (linePriceKey)
+  lookUp: (
+    items: readonly { variantId: string; unitId: string }[],
+  ) => Promise<ReadonlyMap<string, LinePrice>>;
+  // Where a new line's price came from, under its box ("From their price list")
+  sourceText: (source: string | null) => string;
+  // The empty card, the reprice link and its toast
+  words: { noLines: string; reprice: string; repriced: string };
+  // The "Add items" dialog's section of texts, and its description when the section's own is not
+  // the one
+  picker: { words: 'salesLines' | 'purchaseLines'; description?: string };
+}
+
+export const linePriceKey = keyOf;
+
+// The quotation's, the order's and the invoice's pricing: the customer's price list, else the
+// product's price, in the selling unit
+export function useSalesPricing(customerId: string): LinePricing {
+  const { t } = useLocale();
+  return {
+    partyId: customerId,
+    unitOf: (product) => product.salesUnitId ?? product.baseUnitId,
+    lookUp: async (items) => {
+      const answer = await call(routes.salesPrices.lookup, {
+        body: { customerId: customerId === '' ? null : customerId, items: [...items] },
+      });
+      return new Map(
+        answer.items.map((item) => [
+          keyOf(item.variantId, item.unitId),
+          { price: item.price, source: item.source, taxRateId: item.taxRateId },
+        ]),
+      );
+    },
+    sourceText: (source) =>
+      source === 'price_list'
+        ? t('salesLines.fromPriceList')
+        : source === 'product'
+          ? t('salesLines.fromProduct')
+          : t('salesLines.noPrice'),
+    words: {
+      noLines: t('salesLines.noLines'),
+      reprice: t('salesLines.reprice'),
+      repriced: t('salesLines.repriced'),
+    },
+    picker: { words: 'salesLines' },
+  };
+}
+
 // One template for the header and every line on a wide card. @5xl (64rem), not the @3xl of the
 // stock lines: seven columns of controls do not fit in 48rem. Below it, each control shows its
 // label. Exported for the credit note's lines (15d), which line up the same way.
@@ -112,7 +182,8 @@ export interface LinesEditorProps<L extends SalesLineFormValues> {
   // lookup appends to these, not to the lines of the render that started it
   getLines: () => L[];
   initialMeta: LineMeta[];
-  customerId: string;
+  // Step 17b: where new lines get their prices (useSalesPricing for the sales documents)
+  pricing: LinePricing;
   pricesIncludeVat: boolean;
   errors: SalesLinesErrors;
   // The form's own line for a product added with "Add items" (an invoice line has more fields)
@@ -137,9 +208,14 @@ export interface LinesEditorProps<L extends SalesLineFormValues> {
 
 const sameLine = (line: SalesLineFormValues): SalesLineFormValues => line;
 
-// The quotation's and the order's editor: a product added is a plain sales line
-export function SalesLinesEditor(props: Omit<LinesEditorProps<SalesLineFormValues>, 'newLine'>) {
-  return <LinesEditor {...props} newLine={sameLine} />;
+// The quotation's and the order's editor: a product added is a plain sales line, priced for the
+// customer
+export function SalesLinesEditor({
+  customerId,
+  ...props
+}: Omit<LinesEditorProps<SalesLineFormValues>, 'newLine' | 'pricing'> & { customerId: string }) {
+  const pricing = useSalesPricing(customerId);
+  return <LinesEditor {...props} pricing={pricing} newLine={sameLine} />;
 }
 
 export function LinesEditor<L extends SalesLineFormValues>({
@@ -147,7 +223,7 @@ export function LinesEditor<L extends SalesLineFormValues>({
   onChange,
   getLines,
   initialMeta,
-  customerId,
+  pricing,
   pricesIncludeVat,
   errors,
   newLine,
@@ -182,18 +258,9 @@ export function LinesEditor<L extends SalesLineFormValues>({
     ],
     [rates, rateText, t],
   );
+  const { partyId, lookUp } = pricing;
   const repriceable =
-    customerId !== '' && meta.some((line) => line.pricedFor !== customerId) && lines.length > 0;
-
-  // Prices and rates for some variants in some units, for this customer
-  const lookUp = async (items: { variantId: string; unitId: string }[]) => {
-    const answer = await call(routes.salesPrices.lookup, {
-      body: { customerId: customerId === '' ? null : customerId, items },
-    });
-    return new Map<string, PriceLookupItem>(
-      answer.items.map((item) => [keyOf(item.variantId, item.unitId), item]),
-    );
-  };
+    partyId !== '' && meta.some((line) => line.pricedFor !== partyId) && lines.length > 0;
 
   // Lines made elsewhere (an invoice's challan picker), with their meta. false = too many.
   const add = (entries: readonly { line: L; meta: LineMeta }[]): boolean => {
@@ -203,12 +270,12 @@ export function LinesEditor<L extends SalesLineFormValues>({
     return true;
   };
 
-  // "Add": every active variant of the product, in its selling unit, at the looked-up price.
-  // false = the document would hold too many lines; nothing is added.
+  // "Add": every active variant of the product, in its selling (17b: buying) unit, at the
+  // looked-up price. false = the document would hold too many lines; nothing is added.
   const addProduct = async (product: Product): Promise<boolean> => {
     const variants = product.variants.filter((variant) => variant.archivedAt === null);
     if (getLines().length + variants.length > maxLines) return false;
-    const unitId = product.salesUnitId ?? product.baseUnitId;
+    const unitId = pricing.unitOf(product);
     const prices = await lookUp(variants.map((variant) => ({ variantId: variant.id, unitId })));
     const added = variants.map((variant) => {
       const found = prices.get(keyOf(variant.id, unitId));
@@ -223,22 +290,14 @@ export function LinesEditor<L extends SalesLineFormValues>({
         // Left empty when the lookup had no rate (no default rate): the box says to pick one
         taxRateId: found?.taxRateId ?? '',
       };
-      const item: SalesItem = {
-        variantId: variant.id,
-        productId: product.id,
-        productCode: product.code,
-        productName: product.name,
-        optionValues: variant.optionValues,
-        sku: variant.sku,
-        baseUnitId: product.baseUnitId,
-        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
-        productType: product.type,
-        tracking: product.tracking,
-        hasExpiry: product.hasExpiry,
-      };
       return {
         line: newLine(line),
-        meta: { key: nextKey(), item, source: found?.source ?? null, pricedFor: customerId },
+        meta: {
+          key: nextKey(),
+          item: productItemOf(product, variant),
+          source: found?.source ?? null,
+          pricedFor: partyId,
+        },
       };
     });
     // Checked above, before the wait; another add may have come in meanwhile
@@ -275,7 +334,7 @@ export function LinesEditor<L extends SalesLineFormValues>({
       onChange(getLines().map((line, i) => (i === at ? { ...line, unitPrice: price } : line)));
       setMeta((before) =>
         before.map((line, i) =>
-          i === at ? { ...line, source: found?.source ?? null, pricedFor: customerId } : line,
+          i === at ? { ...line, source: found?.source ?? null, pricedFor: partyId } : line,
         ),
       );
     } catch {
@@ -283,7 +342,8 @@ export function LinesEditor<L extends SalesLineFormValues>({
     }
   };
 
-  // "Use this customer's prices on every line": only lines with a price somewhere change
+  // "Use this customer's prices on every line" (17b: "this supplier's last prices"): only lines
+  // with a price somewhere change
   const reprice = async () => {
     setRepricing(true);
     try {
@@ -300,10 +360,10 @@ export function LinesEditor<L extends SalesLineFormValues>({
         before.map((line, at) => {
           const now = lines[at];
           const found = now ? prices.get(keyOf(now.variantId, now.unitId)) : undefined;
-          return { ...line, source: found?.source ?? null, pricedFor: customerId };
+          return { ...line, source: found?.source ?? null, pricedFor: partyId };
         }),
       );
-      toast(t('salesLines.repriced'));
+      toast(pricing.words.repriced);
     } catch (error) {
       toast(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
     } finally {
@@ -326,12 +386,12 @@ export function LinesEditor<L extends SalesLineFormValues>({
             onClick={() => void reprice()}
             className="text-label font-medium text-brand underline-offset-3 hover:underline"
           >
-            {t('salesLines.reprice')}
+            {pricing.words.reprice}
           </button>
         </div>
       )}
       {lines.length === 0 ? (
-        <p className="px-5 py-6 text-body-sm text-ink-2">{t('salesLines.noLines')}</p>
+        <p className="px-5 py-6 text-body-sm text-ink-2">{pricing.words.noLines}</p>
       ) : (
         <div
           aria-hidden="true"
@@ -486,11 +546,7 @@ export function LinesEditor<L extends SalesLineFormValues>({
               />
               {lineMeta.source !== undefined && (
                 <span className="text-right text-caption text-ink-3">
-                  {lineMeta.source === 'price_list'
-                    ? t('salesLines.fromPriceList')
-                    : lineMeta.source === 'product'
-                      ? t('salesLines.fromProduct')
-                      : t('salesLines.noPrice')}
+                  {pricing.sourceText(lineMeta.source)}
                 </span>
               )}
             </SalesField>
@@ -566,7 +622,14 @@ export function LinesEditor<L extends SalesLineFormValues>({
       {lines.length > 0 && <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />}
 
       <Dialog open={picking} onOpenChange={setPicking}>
-        {picking && <ProductPicker words="salesLines" onAdd={addProduct} maxLines={maxLines} />}
+        {picking && (
+          <ProductPicker
+            words={pricing.picker.words}
+            description={pricing.picker.description}
+            onAdd={addProduct}
+            maxLines={maxLines}
+          />
+        )}
       </Dialog>
     </Card>
   );
```

- **`LinePricing` is what differs between a customer's document and a supplier's:** the party, the unit a product
  starts in (selling or buying), the lookup, the words under the price box, the empty card, the reprice link and
  the "Add items" dialog's texts. Everything else (the boxes, the math, the totals) is the same code.
- **`lookUp` returns a `ReadonlyMap` of `LinePrice`,** a shape both lookups fit: the sales lookup's `price` and the
  cost lookup's `cost` both become `price`.
- **`useSalesPricing` keeps the sales documents exactly as they were:** the same lookup, the same words. It is a
  hook because the words come from `useLocale()`.
- **`SalesLinesEditor` still takes `customerId`,** so the quotation and sales order forms do not change. The hook is
  called in the wrapper's body, not inside the JSX, so the rules of hooks are easy to see.
- **`pricedFor` holds any party's id.** The reprice link compares it with `pricing.partyId`: a customer for a sales
  document, a supplier for an order.

```diff
@@ -25,10 +25,14 @@ import { useTenantId } from './stock-parts';
 // its own language ("Each click adds a line in its selling unit" or "… its buying unit").
 export function ProductPicker({
   words,
+  description,
   onAdd,
   maxLines,
 }: {
   words: 'salesLines' | 'purchaseLines';
+  // Step 17b: a purchase order says its lines start at the last price paid, where the
+  // requisition's picker says nothing of prices; both speak from purchaseLines
+  description?: string | undefined;
   onAdd: (product: Product) => Promise<boolean>;
   maxLines: number;
 }) {
@@ -58,7 +62,10 @@ export function ProductPicker({
   };
 
   return (
-    <DialogContent title={t(`${words}.pickerTitle`)} description={t(`${words}.pickerDescription`)}>
+    <DialogContent
+      title={t(`${words}.pickerTitle`)}
+      description={description ?? t(`${words}.pickerDescription`)}
+    >
       <div className="grid grid-cols-1 gap-4">
         <Input
           type="search"
```

The picker takes an optional `description`. The order's dialog says its lines start at the last price paid; the
requisition's, from the same `purchaseLines` words, says nothing about prices.

```diff
@@ -24,7 +24,7 @@ import {
 import { isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
 import { firstMessage } from '../lib/stock';
 import { failureOf } from './journal-parts';
-import { LinesEditor, SalesField } from './sales-line-editor';
+import { LinesEditor, SalesField, useSalesPricing } from './sales-line-editor';
 import { PickButton, PickProblem } from './sales-parts';
 import { SerialNumbersInput } from './serial-numbers-input';
 import { useIsoDate, useQuantity, useTenantId } from './stock-parts';
@@ -79,6 +79,7 @@ export function InvoiceLinesEditor({
 }) {
   const { t } = useLocale();
   const quantityText = useQuantity();
+  const pricing = useSalesPricing(customerId);
   const [picking, setPicking] = useState<'challans' | 'charges' | null>(null);
   const onForm = new Set(lines.flatMap((line) => sourceIdOf(line) ?? []));
 
@@ -150,7 +151,7 @@ export function InvoiceLinesEditor({
       onChange={onChange}
       getLines={getLines}
       initialMeta={initialMeta}
-      customerId={customerId}
+      pricing={pricing}
       pricesIncludeVat={pricesIncludeVat}
       errors={errors}
       newLine={ownLine}
```

The invoice's editor gets the sales pricing for its customer, called once at the top of the component.

### Pills and shared parts

```diff
@@ -3,16 +3,28 @@ import {
   CancelCircleIcon,
   CheckmarkCircle02Icon,
   Clock01Icon,
+  DeliveryTruck01Icon,
   FileEditIcon,
   MinusSignCircleIcon,
+  PackageReceiveIcon,
+  ShoppingCart01Icon,
+  ShoppingCartCheck01Icon,
+  StopCircleIcon,
+  Time04Icon,
   Undo02Icon,
 } from '@hugeicons/core-free-icons';
 import type { IconSvgElement } from '@hugeicons/react';
-import type { ApprovalRoundStatus, RequisitionStatus } from '@omnivo/contracts';
+import type {
+  ApprovalRoundStatus,
+  PurchaseOrderStatus,
+  RequisitionOrderState,
+  RequisitionStatus,
+  StockDocumentStatus,
+} from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { Pill, type PillTone } from '@omnivo/ui';
 
-import type { StepState } from '../lib/purchase';
+import { isOrderLate, type StepState } from '../lib/purchase';
 
 // The status pills of the purchase documents (step 17a), a file of their own like sales-pills.tsx:
 // a list page needs these, not the approval card. Never colour alone: each pill has its icon and
@@ -22,6 +34,8 @@ const REQUISITION_PILLS = {
   draft: { tone: 'neutral', icon: FileEditIcon },
   pending: { tone: 'brand', icon: Clock01Icon },
   approved: { tone: 'good', icon: CheckmarkCircle02Icon },
+  // Step 17b: the rest will not be ordered (a sales order's Closed)
+  closed: { tone: 'neutral', icon: StopCircleIcon },
   cancelled: { tone: 'neutral', icon: CancelCircleIcon },
 } as const satisfies Record<RequisitionStatus, { tone: PillTone; icon: IconSvgElement }>;
 
@@ -35,6 +49,84 @@ export function RequisitionStatusPill({ status }: { status: RequisitionStatus })
   );
 }
 
+// Step 17b: how much of an approved requisition purchase orders cover, a second pill beside its
+// status. Partly ordered is work in progress (brand); nothing ordered shows no pill, like a challan
+// nothing came back from.
+const ORDER_STATE_PILLS = {
+  partly_ordered: { tone: 'brand', icon: ShoppingCart01Icon },
+  ordered: { tone: 'good', icon: ShoppingCartCheck01Icon },
+} as const satisfies Record<
+  Exclude<RequisitionOrderState, 'not_ordered'>,
+  { tone: PillTone; icon: IconSvgElement }
+>;
+
+export function RequisitionOrderPill({ state }: { state: RequisitionOrderState }) {
+  const { t } = useLocale();
+  if (state === 'not_ordered') return null;
+  const { tone, icon } = ORDER_STATE_PILLS[state];
+  return (
+    <Pill tone={tone} icon={icon}>
+      {t(`requisitions.orderStates.${state}`)}
+    </Pill>
+  );
+}
+
+// A purchase order (step 17b). Approved is good, like an approved requisition: the approval is
+// done. Partly received takes its place once goods came (brand: the rest is still coming), like a
+// sales order's Partly delivered.
+const ORDER_PILLS = {
+  draft: { tone: 'neutral', icon: FileEditIcon },
+  pending: { tone: 'brand', icon: Clock01Icon },
+  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
+  received: { tone: 'good', icon: PackageReceiveIcon },
+  closed: { tone: 'neutral', icon: StopCircleIcon },
+  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
+} as const satisfies Record<PurchaseOrderStatus, { tone: PillTone; icon: IconSvgElement }>;
+
+// Its status, and a second warn pill when it is late: the buyer should call the supplier
+export function PurchaseOrderStatusPills({
+  order,
+  today,
+}: {
+  order: { status: PurchaseOrderStatus; partlyReceived: boolean; expectedDate: string | null };
+  today: string;
+}) {
+  const { t } = useLocale();
+  const pill = ORDER_PILLS[order.status];
+  return (
+    <span className="inline-flex flex-wrap gap-1.5">
+      {order.partlyReceived ? (
+        <Pill tone="brand" icon={DeliveryTruck01Icon}>
+          {t('purchaseOrders.partlyReceived')}
+        </Pill>
+      ) : (
+        <Pill tone={pill.tone} icon={pill.icon}>
+          {t(`purchaseOrders.statuses.${order.status}`)}
+        </Pill>
+      )}
+      {isOrderLate(order, today) && (
+        <Pill tone="warn" icon={Time04Icon}>
+          {t('purchaseOrders.late')}
+        </Pill>
+      )}
+    </span>
+  );
+}
+
+// A goods receipt: a draft, or posted (a delivery's pills)
+export function GoodsReceiptStatusPill({ status }: { status: StockDocumentStatus }) {
+  const { t } = useLocale();
+  return status === 'draft' ? (
+    <Pill tone="neutral" icon={FileEditIcon}>
+      {t('goodsReceipts.statuses.draft')}
+    </Pill>
+  ) : (
+    <Pill tone="good" icon={CheckmarkCircle02Icon}>
+      {t('goodsReceipts.statuses.posted')}
+    </Pill>
+  );
+}
+
 // A round of an approval. Rejected is warn: the person who wrote the document must change it and
 // submit it again. Reopened is neutral: its writer took it back on purpose.
 const ROUND_PILLS = {
```

The pills of decision 47. Each map is `satisfies Record<…>` over the contract's own list, so a new status does not
compile until it has its pill; the requisition's map failed the type check until `closed` was added.

- **`RequisitionOrderPill` returns nothing for `not_ordered`.** A pill that says "Not ordered" on every approved
  requisition would be noise; the map is typed over the other two states only (`Exclude`).
- **`PurchaseOrderStatusPills` shows "Partly received" in Approved's place,** like the sales order: the order is
  still approved, but the useful fact is that goods started to come. The "Late" pill is a second pill, because an
  order can be partly received and late at once.

```diff
@@ -1,9 +1,13 @@
-import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
+import { ArrowLeft01Icon, UserIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
+import type { PartyRef } from '@omnivo/contracts';
+import { Input } from '@omnivo/ui';
 import { useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
-import { useCallback } from 'react';
+import { lazy, Suspense, useCallback } from 'react';
 
+import { partyLabel } from '../lib/customers';
+import type { PartyPickerProps } from './party-picker';
 import { useTenantId } from './stock-parts';
 
 // Shared by the purchase documents' pages (step 17a). Here, not in a route file: a route file is
@@ -11,12 +15,18 @@ import { useTenantId } from './stock-parts';
 
 // After a save or a decision: everything under ['purchase', tenant] — the requisitions, their
 // list, the "waiting for me" list and the navigation's count. An approval moves all of them at
-// once. One hook for every purchase document, so none forgets one.
+// once. One hook for every purchase document, so none forgets one. Step 17b: the stock and the
+// books too, like useSalesRefresh: an approved order changes what is coming on the stock page
+// (decision 23), and a posted goods receipt brings stock in and writes a journal entry.
 export function usePurchaseRefresh(): () => Promise<void> {
   const tenantId = useTenantId();
   const queryClient = useQueryClient();
   return useCallback(async () => {
-    await queryClient.invalidateQueries({ queryKey: ['purchase', tenantId] });
+    await Promise.all([
+      queryClient.invalidateQueries({ queryKey: ['purchase', tenantId] }),
+      queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
+      queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
+    ]);
   }, [queryClient, tenantId]);
 }
 
@@ -24,7 +34,7 @@ export function PurchaseBackLink({
   to,
   label,
 }: {
-  to: '/requisitions' | '/approvals';
+  to: '/requisitions' | '/approvals' | '/purchase-orders' | '/goods-receipts';
   label: string;
 }) {
   return (
@@ -37,3 +47,42 @@ export function PurchaseBackLink({
     </Link>
   );
 }
+
+// "S-00012 · Meghna Spinning Mills", linking to the supplier's page (everyone may read suppliers),
+// like the sales pages' CustomerLink
+export function SupplierLink({ supplier }: { supplier: PartyRef }) {
+  return (
+    <Link
+      to="/suppliers/$supplierId"
+      params={{ supplierId: supplier.id }}
+      className="font-medium text-brand underline-offset-3 hover:underline"
+    >
+      {partyLabel(supplier)}
+    </Link>
+  );
+}
+
+// Step 17b: the supplier filter of the purchase order and goods receipt lists, loaded after the
+// page like the sales lists' customer filter (customer-filter.tsx says why: the box brings the
+// popover). A disabled box of the same size holds its place.
+const PartyPicker = lazy(async () => ({
+  default: (await import('./party-picker')).PartyPicker,
+}));
+
+export function SupplierFilter(props: PartyPickerProps) {
+  return (
+    <Suspense
+      fallback={
+        <Input
+          id={props.id}
+          icon={UserIcon}
+          disabled
+          aria-label={props['aria-label']}
+          placeholder={props.allLabel}
+        />
+      }
+    >
+      <PartyPicker {...props} role="supplier" />
+    </Suspense>
+  );
+}
```

- **`usePurchaseRefresh` refreshes the stock and the books too.** An approved order changes "Incoming" on the stock
  page (decision 23), and a posted receipt brings stock in and writes a journal entry. One hook for every purchase
  document, like `useSalesRefresh`.
- **`SupplierLink`** is the purchase pages' `CustomerLink`.
- **`SupplierFilter`** is the lists' supplier box, loaded after the page like the sales lists' customer filter (the
  box brings the popover). Its fallback uses the picker's own icon, so nothing changes when the chunk arrives.

```diff
@@ -27,6 +27,7 @@ export function SalesLinesTable<L extends SalesLine | SalesOrderLine>({
   pricesIncludeVat,
   delivered = false,
   note,
+  more,
 }: {
   lines: readonly L[];
   totals: DocumentTotals;
@@ -34,6 +35,9 @@ export function SalesLinesTable<L extends SalesLine | SalesOrderLine>({
   // An order past its draft: the Delivered and Invoiced columns
   delivered?: boolean;
   note?: (line: L) => ReactNode;
+  // Step 17b: more columns after the amount (a purchase order's Received and Rejected): their
+  // headers, and a line's cells (one <td> per header)
+  more?: { headers: readonly string[]; cells: (line: L) => ReactNode } | undefined;
 }) {
   const { t, format } = useLocale();
   const quantity = useQuantity();
@@ -74,6 +78,11 @@ export function SalesLinesTable<L extends SalesLine | SalesOrderLine>({
                   {t('salesOrders.invoiced')}
                 </th>
               )}
+              {more?.headers.map((header) => (
+                <th key={header} scope="col" className="px-5 py-2.5 text-right">
+                  {header}
+                </th>
+              ))}
             </tr>
           </thead>
           <tbody>
@@ -142,6 +151,7 @@ export function SalesLinesTable<L extends SalesLine | SalesOrderLine>({
                     {quantity(line.invoicedQuantity, line.baseUnitId)}
                   </td>
                 )}
+                {more?.cells(line)}
               </tr>
             ))}
           </tbody>
```

The table of a saved order's lines takes `more`: extra columns after the amount. The order page uses it for
Received and Rejected. `| undefined` on the prop because the project has `exactOptionalPropertyTypes` on, and the
order page passes `undefined` for a draft.

### The Send menu learns about suppliers

```diff
@@ -4,6 +4,7 @@ import {
   LANGUAGE_CODES,
   type LanguageCode,
   type OutputDocument,
+  type PartyRole,
 } from '@omnivo/contracts';
 import { LANGUAGES } from '@omnivo/i18n';
 
@@ -16,7 +17,23 @@ export interface OutputTarget {
   kind: OutputDocument;
   id: string;
   number: string;
-  customerId: string;
+  // Who the document goes to: the customer, or (step 17b) the supplier of a purchase order. The
+  // kind says which (recipientRole).
+  partyId: string;
+}
+
+// Step 17b: a purchase order goes to its supplier, every sales document to its customer. A Record,
+// so a new kind of document does not compile until it says who gets it.
+const RECIPIENT_ROLES = {
+  quotation: 'customer',
+  invoice: 'customer',
+  receipt: 'customer',
+  credit_note: 'customer',
+  purchase_order: 'supplier',
+} as const satisfies Record<OutputDocument, PartyRole>;
+
+export function recipientRole(kind: OutputDocument): PartyRole {
+  return RECIPIENT_ROLES[kind];
 }
 
 // The language that is not this one: the second item of the Send menu ("Download PDF in বাংলা").
```

`customerId` is `partyId` now, and `recipientRole()` answers who a kind of document goes to (decision 48). The map
is `satisfies Record<OutputDocument, PartyRole>`, so a new kind does not compile until it says.

```diff
@@ -25,16 +25,17 @@ import {
   languageName,
   otherLanguage,
   type OutputTarget,
+  recipientRole,
   saveFile,
   waitForPdf,
 } from '../lib/document-output';
 import { useCan } from '../lib/permissions';
-import { customerQuery } from '../lib/queries';
+import { customerQuery, supplierQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { failureOf } from './journal-parts';
 
 // Step 16: the Send menu in the header of a quotation, an invoice, a money receipt and a credit
-// note. A lazy chunk of its own, loaded by those four pages: it brings Radix's dropdown (with its
+// note (step 17b: and a purchase order). A lazy chunk of its own, loaded by those four pages: it brings Radix's dropdown (with its
 // positioning code), and inside the pages' chunks the menu and the history cards took the invoice
 // page from 68 KB to 108 KB, over its 100 KB budget.
 // The two dialogs are one more chunk (document-dialogs.tsx), loaded when one opens: they bring the
@@ -52,17 +53,27 @@ function useTenant(): string {
   return useSession((state) => state.me?.tenant.id) ?? '';
 }
 
-// The customer's document language and phone (the document carries only the customer's name and
-// code). null while the customer loads; English if it cannot be read, so Download still works.
-function useCustomerOf(customerId: string): {
+// The recipient's document language and phone (the document carries only its name and code): the
+// customer's, or (step 17b) the supplier's. null while it loads; English if it cannot be read, so
+// Download still works. Two queries, each enabled for one side, like the party box: a hook cannot be
+// called conditionally, and the two answers have different types.
+function useRecipientOf(target: OutputTarget): {
   language: LanguageCode;
   phone: string | null;
 } | null {
-  const customer = useQuery(customerQuery(useTenant(), customerId));
-  if (customer.data) {
-    return { language: customer.data.documentLanguage, phone: customer.data.phone };
-  }
-  return customer.isError ? { language: 'en', phone: null } : null;
+  const tenantId = useTenant();
+  const role = recipientRole(target.kind);
+  const customer = useQuery({
+    ...customerQuery(tenantId, target.partyId),
+    enabled: role === 'customer',
+  });
+  const supplier = useQuery({
+    ...supplierQuery(tenantId, target.partyId),
+    enabled: role === 'supplier',
+  });
+  const party = role === 'customer' ? customer : supplier;
+  if (party.data) return { language: party.data.documentLanguage, phone: party.data.phone };
+  return party.isError ? { language: 'en', phone: null } : null;
 }
 
 // Download PDF: ask for the file, wait while the worker draws it, then save it. A second click
@@ -94,18 +105,18 @@ function useDownload(target: OutputTarget) {
 export function SendMenu({ target }: { target: OutputTarget }) {
   const { t } = useLocale();
   const canSend = useCan()(SEND_PERMISSIONS[target.kind]);
-  const customer = useCustomerOf(target.customerId);
+  const recipient = useRecipientOf(target);
   const download = useDownload(target);
   const [dialog, setDialog] = useState<'email' | 'share' | null>(null);
-  const busy = download.isPending || customer === null;
+  const busy = download.isPending || recipient === null;
 
-  if (!canSend || customer === null) {
+  if (!canSend || recipient === null) {
     return (
       <Button
         variant="secondary"
         disabled={busy}
         onClick={() => {
-          if (customer) download.mutate(customer.language);
+          if (recipient) download.mutate(recipient.language);
         }}
       >
         <HugeiconsIcon icon={Pdf01Icon} size={17} strokeWidth={1.5} />
@@ -114,7 +125,7 @@ export function SendMenu({ target }: { target: OutputTarget }) {
     );
   }
 
-  const other = otherLanguage(customer.language);
+  const other = otherLanguage(recipient.language);
   return (
     <>
       {/* modal={false}: the menu opens a dialog; a modal menu would leave the page's
@@ -136,7 +147,7 @@ export function SendMenu({ target }: { target: OutputTarget }) {
           <DropdownMenuItem
             icon={Pdf01Icon}
             onSelect={() => {
-              download.mutate(customer.language);
+              download.mutate(recipient.language);
             }}
           >
             {t('documentOutput.downloadPdf')}
@@ -177,14 +188,20 @@ export function SendMenu({ target }: { target: OutputTarget }) {
           {dialog === 'email' && (
             <EmailForm
               target={target}
-              language={customer.language}
+              role={recipientRole(target.kind)}
+              language={recipient.language}
               onDone={() => {
                 setDialog(null);
               }}
             />
           )}
           {dialog === 'share' && (
-            <ShareForm target={target} language={customer.language} phone={customer.phone} />
+            <ShareForm
+              target={target}
+              role={recipientRole(target.kind)}
+              language={recipient.language}
+              phone={recipient.phone}
+            />
           )}
         </Suspense>
       </Dialog>
```

- **`useRecipientOf` asks for the customer or the supplier,** each query enabled for its own side only. A hook
  cannot be called inside an `if`, and one `useQuery` over "the customer query or the supplier query" does not
  type-check: the two have different result types. Both results have `documentLanguage` and `phone`, so the rest of
  the menu reads either without a cast.
- **The dialogs get the role from the menu.** They could work it out from the kind themselves, but `send-menu.tsx`
  explains why the dialogs' chunk must not share a module with the menu's chunk. Passing a prop keeps it that way.

```diff
@@ -9,6 +9,7 @@ import {
   documentEmailInputSchema,
   type LanguageCode,
   MAX_EMAIL_RECIPIENTS,
+  type PartyRole,
   routes,
   SHARE_LINK_DAYS,
   whatsAppNumber,
@@ -56,10 +57,13 @@ function useTenant(): string {
 // into it would lose what they typed.
 export function EmailForm({
   target,
+  role,
   language,
   onDone,
 }: {
   target: OutputTarget;
+  // Step 17b: who it goes to, for the words when they have no email (the Send menu knows)
+  role: PartyRole;
   language: LanguageCode;
   onDone: () => void;
 }) {
@@ -73,16 +77,26 @@ export function EmailForm({
     );
   }
   if (!draft.data) return null;
-  return <EmailFields target={target} language={language} draft={draft.data} onDone={onDone} />;
+  return (
+    <EmailFields
+      target={target}
+      role={role}
+      language={language}
+      draft={draft.data}
+      onDone={onDone}
+    />
+  );
 }
 
 function EmailFields({
   target,
+  role,
   language,
   draft,
   onDone,
 }: {
   target: OutputTarget;
+  role: PartyRole;
   language: LanguageCode;
   draft: DocumentEmailDraft;
   onDone: () => void;
@@ -195,8 +209,17 @@ function EmailFields({
           autoComplete="off"
           spellCheck={false}
           placeholder={t('documentOutput.emailDialog.toPlaceholder')}
-          // The customer has no email: say so under the box until someone types one
-          hint={draft.to === '' ? t('documentOutput.emailDialog.noCustomerEmail') : hint}
+          // The customer (17b: the supplier) has no email: say so under the box until someone
+          // types one
+          hint={
+            draft.to === ''
+              ? t(
+                  role === 'supplier'
+                    ? 'documentOutput.emailDialog.noSupplierEmail'
+                    : 'documentOutput.emailDialog.noCustomerEmail',
+                )
+              : hint
+          }
           {...register('to')}
           error={errors.to?.message}
         />
@@ -258,10 +281,12 @@ const LINK_BUTTON =
 // message ready. The link is shown only here (decision 13): closing the dialog forgets it.
 export function ShareForm({
   target,
+  role,
   language,
   phone,
 }: {
   target: OutputTarget;
+  role: PartyRole;
   language: LanguageCode;
   phone: string | null;
 }) {
@@ -400,7 +425,13 @@ export function ShareForm({
         </div>
         {/* The same reading of the phone the server used for the link (decision 17) */}
         {whatsAppNumber(phone) === null && (
-          <p className="text-label text-ink-3">{t('documentOutput.shareDialog.noNumber')}</p>
+          <p className="text-label text-ink-3">
+            {t(
+              role === 'supplier'
+                ? 'documentOutput.shareDialog.noSupplierNumber'
+                : 'documentOutput.shareDialog.noNumber',
+            )}
+          </p>
         )}
       </div>
     </DialogContent>
```

The two texts that named the customer have a supplier version (17b.5); the dialogs pick one by `role`.

```diff
@@ -51,7 +51,7 @@ export function QuotationView({
     kind: 'quotation',
     id: quotation.id,
     number: quotation.number,
-    customerId: quotation.customer.id,
+    partyId: quotation.customer.id,
   };
 
   const decline = useMutation({
```

```diff
@@ -66,7 +66,7 @@ export function InvoiceView({ invoice, today }: { invoice: Invoice; today: strin
   // Step 16: only a numbered invoice goes out (decision 11); a draft has no number yet
   const target: OutputTarget | null =
     posted && invoice.number !== null
-      ? { kind: 'invoice', id: invoice.id, number: invoice.number, customerId: invoice.customer.id }
+      ? { kind: 'invoice', id: invoice.id, number: invoice.number, partyId: invoice.customer.id }
       : null;
 
   // "Credit whole invoice" (decision 5): a draft with every line as it was billed, saved in one
```

```diff
@@ -66,7 +66,7 @@ export function ReceiptView({ receipt, today }: { receipt: Receipt; today: strin
   const account = accounts?.find((item) => item.id === receipt.accountId);
   // Step 16: a voided receipt does not go out (decision 11), the same rule as Print
   const target: OutputTarget | null = posted
-    ? { kind: 'receipt', id: receipt.id, number: receipt.number, customerId: receipt.customer.id }
+    ? { kind: 'receipt', id: receipt.id, number: receipt.number, partyId: receipt.customer.id }
     : null;
 
   return (
```

```diff
@@ -70,7 +70,7 @@ export function CreditNoteView({ creditNote }: { creditNote: CreditNote }) {
           kind: 'credit_note',
           id: creditNote.id,
           number: creditNote.number,
-          customerId: creditNote.customer.id,
+          partyId: creditNote.customer.id,
         }
       : null;
   const unapplied = unappliedOf({
```

The four sales documents build their target with `partyId`. Nothing else in them changes.

### The printed order: `components/print-documents.tsx`

```diff
@@ -10,6 +10,7 @@ import {
   type Invoice,
   isZeroMoney,
   plainQuantity,
+  type PurchaseOrder,
   type Quotation,
   type Receipt,
   type Refund,
@@ -27,12 +28,12 @@ import type { ReactNode } from 'react';
 import { settingsQuery } from '../lib/queries';
 import { creditReasonKey, returnReasonKey } from '../lib/returns';
 import { variantName } from '../lib/stock';
-import { useIsoDate, useQuantity, useTenantId } from './stock-parts';
+import { useIsoDate, useQuantity, useTenantId, useWarehouses } from './stock-parts';
 
-// The printed quotation, order, challan, invoice and money receipt (step 15c), and the sales
-// return, credit note and refund (15d): one A4 layout, the browser's own Print (or Save as PDF), so
-// it works offline and needs no PDF service. Each page renders its sheet next to itself; PrintSheet
-// keeps it hidden on the screen and alone on paper.
+// The printed quotation, order, challan, invoice and money receipt (step 15c), the sales return,
+// credit note and refund (15d), and the purchase order (17b): one A4 layout, the browser's own
+// Print (or Save as PDF), so it works offline and needs no PDF service. Each page renders its sheet
+// next to itself; PrintSheet keeps it hidden on the screen and alone on paper.
 
 // "Print" in a document's header: the browser prints the sheet of the page
 export function PrintButton() {
@@ -373,6 +374,56 @@ export function SalesOrderPrint({ order }: { order: SalesOrder }) {
   );
 }
 
+// Step 17b: the purchase order, as its PDF draws it (apps/api/src/documents/models.service.ts): the
+// supplier, where the goods go and by when, the terms, the priced lines and the total in words: the
+// company commits to pay it, like a bill
+export function PurchaseOrderPrint({ order }: { order: PurchaseOrder }) {
+  const { t } = useLocale();
+  const isoDate = useIsoDate();
+  const place = useWarehouses().byId.get(order.warehouseId);
+  return (
+    <Sheet
+      title={t('print.titles.purchaseOrder')}
+      meta={[
+        { label: t('print.number'), value: order.number ?? '' },
+        { label: t('print.date'), value: isoDate(order.date) },
+        order.expectedDate === null
+          ? null
+          : { label: t('print.deliverBy'), value: isoDate(order.expectedDate) },
+        order.supplierReference === null
+          ? null
+          : { label: t('print.customerReference'), value: order.supplierReference },
+        {
+          label: t('print.paymentTerms'),
+          value:
+            order.paymentTermsDays === 0
+              ? t('print.onDelivery')
+              : t('print.termsDays', { count: order.paymentTermsDays }),
+        },
+      ]}
+      signatures={[t('print.signatures.preparedBy'), t('print.signatures.authorised')]}
+    >
+      <div className="grid grid-cols-2 gap-6">
+        <PartyBlock
+          label={t('print.supplier')}
+          name={order.supplier.name}
+          code={order.supplier.code}
+        />
+        {place && (
+          <PartyBlock label={t('print.deliverTo')} name={place.name} address={place.address} />
+        )}
+      </div>
+      <PricedLines
+        lines={order.lines}
+        totals={order}
+        pricesIncludeVat={order.pricesIncludeVat}
+        words
+      />
+      <Note note={order.note} />
+    </Sheet>
+  );
+}
+
 // The lines of a challan or (15d) a return on paper: the goods, how much, the batch and serial
 // numbers, no prices. `note` adds a line under an item (the challan a returned line left on).
 function StockPrintLines<L extends StockLine>({
```

`PurchaseOrderPrint` is the order's PDF of 17b.3 drawn by the browser: the same meta (number, date, deliver by, the
supplier's reference, payment terms), the supplier, where the goods go, the priced lines and the total in words.
The words go on an order because the company commits to pay that amount, like a bill. The warehouse's address comes
from `useWarehouses()`, the list every page has already loaded. The order page renders it only once the order is
approved: a draft or a pending order on paper looks like an order the supplier may act on.

### The order's lines: `components/purchase-order-lines.tsx` (new)

```tsx
import { Alert02Icon, Search01Icon, TaskAdd01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  defaultLineDescription,
  isZeroQuantity,
  MAX_PURCHASE_LINES,
  type OpenRequisitionLine,
  plainQuantity,
  type PurchaseOrderLineFormValues,
  routes,
  type SalesLineFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogContent, Input } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { call } from '../lib/api';
import { purchaseUnitOf, startingPrice } from '../lib/purchase';
import { openRequisitionLinesQuery, productQuery, taxRatesQuery } from '../lib/queries';
import { type LineMeta, productItemOf } from '../lib/sales';
import { useDebounced } from '../lib/use-debounced';
import { failureOf } from './journal-parts';
import { type LinePricing, LinesEditor, linePriceKey } from './sales-line-editor';
import { PickButton, PickProblem } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The lines of a purchase order (step 17b): the sales line editor (decision 6: the same price,
// discount and VAT), priced from the supplier's last prices, with a link under each line that buys
// for a requisition, and "Add lines still to order" beside "Add items" (decision 18). A lazy chunk
// of its own, loaded as the order form opens, like the sales editor.

export type PurchaseOrderLinesErrors = FieldErrors<{
  lines: PurchaseOrderLineFormValues[];
}>['lines'];

// The requisition each line buys for, by the requisition line's id: the line holds only the id,
// and the link under it needs the requisition's number
export type RequisitionLinks = ReadonlyMap<string, { requisitionId: string; number: string }>;

// The supplier's prices (decision 19): its own last price, else anyone's, else the average cost.
// The lookup sends the net; startingPrice() adds the VAT when the order's prices include it.
function usePurchasePricing(supplierId: string, pricesIncludeVat: boolean): LinePricing {
  const { t } = useLocale();
  const rates = useQuery(taxRatesQuery(useTenantId())).data;
  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  return {
    partyId: supplierId,
    unitOf: purchaseUnitOf,
    lookUp: async (items) => {
      const answer = await call(routes.purchaseCosts.lookup, {
        body: { supplierId: supplierId === '' ? null : supplierId, items: [...items] },
      });
      return new Map(
        answer.items.map((item) => [
          linePriceKey(item.variantId, item.unitId),
          {
            price: startingPrice(item.cost, rateOf(item.taxRateId), pricesIncludeVat),
            source: item.source,
            taxRateId: item.taxRateId,
          },
        ]),
      );
    },
    sourceText: (source) =>
      source === 'supplier_price'
        ? t('purchaseLines.fromSupplierPrice')
        : source === 'last_price'
          ? t('purchaseLines.fromLastPrice')
          : source === 'average_cost'
            ? t('purchaseLines.fromAverage')
            : t('purchaseLines.noPrice'),
    words: {
      noLines: t('purchaseLines.noOrderLines'),
      reprice: t('purchaseLines.reprice'),
      repriced: t('purchaseLines.repriced'),
    },
    picker: { words: 'purchaseLines', description: t('purchaseLines.orderPickerDescription') },
  };
}

// A line from "Add items" buys for no requisition; one from "lines still to order" names its line
const ownLine = (line: SalesLineFormValues): PurchaseOrderLineFormValues => ({
  ...line,
  requisitionLineId: '',
});

type Add = (entries: readonly { line: PurchaseOrderLineFormValues; meta: LineMeta }[]) => boolean;

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `open-${String(lastKey)}`;
}
```

- **`usePurchasePricing` is the order's `LinePricing`** (decision 43). It asks the cost lookup with the order's
  supplier, so the supplier's own last price comes first (decision 19). `supplierId === '' ? null : supplierId`:
  the contract's "no supplier yet" is `null`, not an empty id.
- **The VAT rates are read here,** because `startingPrice` needs the rate of the line's `taxRateId` to add the VAT
  when the order's prices include it.
- **`sourceText` covers the three sources and "nothing known".** An unknown source from a newer server reads as
  "No earlier price", which is still true for this app.
- **`ownLine` gives a line from "Add items" an empty `requisitionLineId`:** it buys for no requisition. The editor
  is generic over the line (`LinesEditor<L>`), and this is how it builds the order's own kind of line.

```tsx
export function PurchaseOrderLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  initialLinks,
  supplierId,
  warehouseId,
  pricesIncludeVat,
  errors,
  startPicking,
}: {
  lines: PurchaseOrderLineFormValues[];
  onChange: (lines: PurchaseOrderLineFormValues[]) => void;
  getLines: () => PurchaseOrderLineFormValues[];
  initialMeta: LineMeta[];
  initialLinks: RequisitionLinks;
  supplierId: string;
  // The lines still to order are per warehouse: '' = none picked yet
  warehouseId: string;
  pricesIncludeVat: boolean;
  errors: PurchaseOrderLinesErrors;
  // "Make purchase order" on a requisition: the dialog opens at once, narrowed to it
  startPicking: string | null;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const pricing = usePurchasePricing(supplierId, pricesIncludeVat);
  const [links, setLinks] = useState<RequisitionLinks>(initialLinks);
  // The requisition the dialog is narrowed to ('' = every requisition of the warehouse)
  const [picking, setPicking] = useState<{ requisitionId: string } | null>(
    startPicking === null ? null : { requisitionId: startPicking },
  );

  // A requisition line as an order line: in the requisition's unit and quantity when nothing of it
  // was ordered yet (40 bags), else what is left in the base unit (120 kg), like a goods receipt's
  // "what is left". The description stays only when the store wrote one ("Navy, for
  // PO-HM-2026-1187"); the product's name follows the product. false = too many lines.
  const addOpen = async (open: OpenRequisitionLine, add: Add): Promise<boolean> => {
    const product = await queryClient.query(productQuery(tenantId, open.productId));
    const variant = product.variants.find((each) => each.id === open.variantId);
    // The requisition line's variant is the product's (a foreign key); a missing one is a bug
    if (!variant) throw new Error('variant not found');
    const untouched = isZeroQuantity(open.orderedQuantity);
    const unitId = untouched ? open.unitId : open.baseUnitId;
    const found = (await pricing.lookUp([{ variantId: open.variantId, unitId }])).get(
      linePriceKey(open.variantId, unitId),
    );
    const added = add([
      {
        line: {
          variantId: open.variantId,
          unitId,
          quantity: plainQuantity(untouched ? open.quantity : open.remainingQuantity),
          description: open.description === defaultLineDescription(open) ? '' : open.description,
          unitPrice: found?.price ?? '',
          discountType: 'percent',
          discount: '',
          taxRateId: found?.taxRateId ?? '',
          requisitionLineId: open.id,
        },
        meta: {
          key: nextKey(),
          item: productItemOf(product, variant),
          source: found?.source ?? null,
          pricedFor: supplierId,
        },
      },
    ]);
    if (added) {
      setLinks((before) =>
        new Map(before).set(open.id, {
          requisitionId: open.requisition.id,
          number: open.requisition.number,
        }),
      );
    }
    return added;
  };

  return (
    <LinesEditor<PurchaseOrderLineFormValues>
      lines={lines}
      onChange={onChange}
      getLines={getLines}
      initialMeta={initialMeta}
      pricing={pricing}
      pricesIncludeVat={pricesIncludeVat}
      errors={errors}
      newLine={ownLine}
      maxLines={MAX_PURCHASE_LINES}
      lineNote={({ value, index }) => {
        const link = value.requisitionLineId ? links.get(value.requisitionLineId) : undefined;
        // purchase_requisition_line_invalid (closed meanwhile, another warehouse) or _twice
        const error = errors?.[index]?.requisitionLineId?.message;
        if (link === undefined && error === undefined) return null;
        return (
          <span className="grid gap-0.5">
            {link && (
              <Link
                to="/requisitions/$requisitionId"
                params={{ requisitionId: link.requisitionId }}
                className="w-fit text-caption font-medium text-brand underline-offset-3 hover:underline"
              >
                {t('purchaseOrders.forRequisition', { number: link.number })}
              </Link>
            )}
            {error !== undefined && (
              <span className="flex items-start gap-1.5 text-label text-crit">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  size={15}
                  strokeWidth={1.5}
                  className="mt-px shrink-0"
                />
                {errorText(error)}
              </span>
            )}
          </span>
        );
      }}
      moreAdds={(add) => (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={warehouseId === ''}
            onClick={() => {
              setPicking({ requisitionId: '' });
            }}
          >
            <HugeiconsIcon icon={TaskAdd01Icon} size={16} strokeWidth={1.5} />
            {t('purchaseOrders.addFromRequisitions')}
          </Button>
          {warehouseId === '' && (
            <p className="basis-full text-label text-ink-3">
              {t('purchaseOrders.pickWarehouseFirst')}
            </p>
          )}
          <Dialog
            open={picking !== null && warehouseId !== ''}
            onOpenChange={(open) => {
              if (!open) setPicking(null);
            }}
          >
            {picking !== null && warehouseId !== '' && (
              <OpenLinesPicker
                warehouseId={warehouseId}
                requisitionId={picking.requisitionId}
                onForm={new Set(getLines().flatMap((line) => line.requisitionLineId ?? []))}
                onAdd={(open) => addOpen(open, add)}
              />
            )}
          </Dialog>
        </>
      )}
    />
  );
}
```

- **`links` keeps the requisition number of each linked line.** The form value has only the requisition line's id;
  the link under the line needs the number. It starts from the saved order and grows as lines are added.
- **`addOpen` turns a requisition line into an order line.** It loads the product, because the line's item needs
  the product's tracking (the editor's item type is the sales line's). The query is cached, so the second line of
  the same yarn asks nothing. The quantity follows the same rule as `receiptFill`: the requisition's unit and
  quantity when nothing of it is ordered yet, else what is left in the base unit.
- **The description is copied only when the store wrote one** ("Navy, for PO-HM-2026-1187"). The product's own
  name stays an empty box, so a renamed product is followed, like every sales line.
- **The link is added only when `add` said yes.** `add` refuses when the order would pass 300 lines, and a link for
  a line that is not there would be wrong.
- **`lineNote` shows the link and the line's requisition error.** The editor has no box for `requisitionLineId`, so
  `purchase_requisition_line_invalid` (closed meanwhile, another warehouse) and `_twice` would otherwise appear
  nowhere.
- **"Add lines still to order" is disabled until a warehouse is chosen,** and a line says why: the lines are per
  warehouse (decision 18). The dialog's `open` also checks the warehouse, so clearing the warehouse closes it.
- **`onForm` is read with `getLines()` each time the dialog draws,** so a line removed from the form can be added
  again without closing the dialog.

```tsx
// "Lines still to order": the approved requisitions' lines of the order's warehouse, oldest first,
// searched on the server. The dialog stays open, so an order for ten lines is put together without
// closing it; a line already on the order says "Added" (one order line per requisition line).
function OpenLinesPicker({
  warehouseId,
  requisitionId,
  onForm,
  onAdd,
}: {
  warehouseId: string;
  requisitionId: string;
  onForm: ReadonlySet<string>;
  onAdd: (line: OpenRequisitionLine) => Promise<boolean>;
}) {
  const { t, errorText } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const { byId } = useWarehouses();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: open } = useQuery(
    openRequisitionLinesQuery(useTenantId(), { warehouseId, requisitionId, search: settled }),
  );

  const add = async (line: OpenRequisitionLine) => {
    setLoading(line.id);
    setProblem(null);
    try {
      if (await onAdd(line)) setAdded((before) => new Set(before).add(line.id));
      else setProblem(t('purchaseLines.tooMany', { max: MAX_PURCHASE_LINES }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('purchaseOrders.openLinesTitle')}
      description={t('purchaseOrders.openLinesDescription', {
        warehouse: warehouseLabel(byId.get(warehouseId)),
      })}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('purchaseOrders.openLinesSearch')}
          placeholder={t('purchaseOrders.openLinesSearch')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <PickProblem message={problem} />
        {open?.length === 0 ? (
          <p className="py-6 text-center text-body-sm text-ink-2">
            {t('purchaseOrders.openLinesEmpty')}
          </p>
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {open?.map((line) => (
              <li
                key={line.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{line.description}</span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {line.requisition.neededBy === null
                      ? line.requisition.number
                      : t('purchaseOrders.openLineNeededBy', {
                          number: line.requisition.number,
                          date: isoDate(line.requisition.neededBy),
                        })}
                  </span>
                  <span className="text-caption text-ink-2 tabular-nums">
                    {t('purchaseOrders.openLineLeft', {
                      quantity: quantity(line.remainingQuantity, line.baseUnitId),
                    })}
                  </span>
                </span>
                <PickButton
                  added={added.has(line.id) || onForm.has(line.id)}
                  loading={loading === line.id}
                  onClick={() => void add(line)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
```

The dialog is built like the product picker: a search box, a list that stays while new results load, an "Add"
button per row that turns into "Added", and problems shown inside the dialog (a toast would hide behind it). Each
row says which requisition it is from, when it is needed, and how much is left to order, in the base unit like the
contract sends it.

### The order form: `components/purchase-order-form.tsx` (new)

```tsx
import { Calendar03Icon, UserIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type PurchaseOrder,
  type PurchaseOrderFormValues,
  routes,
  updatePurchaseOrderInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Checkbox,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { PURCHASE_ORDER_LINE_FIELDS, savedOrderLines } from '../lib/purchase';
import { purchaseOrderQuery, supplierQuery } from '../lib/queries';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The purchase order form (step 17b): its own chunk (loaded by routes/purchase-order.tsx), like
// the requisition's. It writes a draft; the order's page submits it for approval (decision 13), so
// the person sees the levels its total reaches before sending it.

// The line editor, the supplier box and the date picker as chunks of their own, loaded as the form
// opens, like the sales order form's: the editor brings decimal.js with the money and discount
// boxes, and the two boxes bring the popover
const PurchaseOrderLinesEditor = lazy(async () => ({
  default: (await import('./purchase-order-lines')).PurchaseOrderLinesEditor,
}));
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = PurchaseOrderFormValues;

function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'supplierId',
    'date',
    'expectedDate',
    'warehouseId',
    'supplierReference',
    'paymentTermsDays',
    'pricesIncludeVat',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      PURCHASE_ORDER_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}
```

- **The editor, the supplier box and the date picker are chunks of their own,** like the sales order form's: the
  editor brings decimal.js with the money and discount boxes, and both boxes bring the popover.
- **`fieldNames` lists every field the server may name,** each line's included, so `applyApiError` can put an error
  under its box.

```tsx
// Writing a new order, or changing a draft (a new one, or one sent back by a rejection or a
// reopen). "Make purchase order" on a requisition comes with that requisition: its warehouse, and
// the lines still to order open at once.
export function PurchaseOrderForm({
  order,
  requisition,
  today,
  onClose,
}: {
  order: PurchaseOrder | null;
  requisition: { id: string; warehouseId: string } | null;
  today: string;
  // Back to the order's page (an edit); a new order goes to its page instead
  onClose?: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const { active, byId } = useWarehouses();
  const [start] = useState(() =>
    order ? savedOrderLines(order) : { values: [], meta: [], links: new Map() },
  );
  // A reopened draft keeps its number, and with it its supplier (decision 33): the number went to
  // that supplier
  const keptNumber = order?.number ?? null;
  const onlyWarehouse = active?.length === 1 ? active[0]?.id : undefined;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updatePurchaseOrderInputSchema, { error: contractErrorMap }),
    defaultValues: {
      supplierId: order?.supplier.id ?? '',
      date: order?.date ?? today,
      expectedDate: order?.expectedDate ?? '',
      warehouseId: order?.warehouseId ?? requisition?.warehouseId ?? onlyWarehouse ?? '',
      supplierReference: order?.supplierReference ?? '',
      paymentTermsDays: order?.paymentTermsDays ?? 0,
      // Off for a new order (decision 15): a supplier quotes before VAT
      pricesIncludeVat: order?.pricesIncludeVat ?? false,
      note: order?.note ?? '',
      lines: start.values,
      // A new order has no version; 1 passes the schema, and the create route never reads it
      version: order?.version ?? 1,
    },
  });
  const supplierId = useWatch({ control, name: 'supplierId' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const pricesIncludeVat = useWatch({ control, name: 'pricesIncludeVat' });

  // The active warehouses, and the draft's own if it was archived since (decision 34: a draft may
  // keep it, and the submit says so)
  const own = order ? byId.get(order.warehouseId) : undefined;
  const warehouses = [...(active ?? []), ...(own && own.archivedAt !== null ? [own] : [])];

  // Another supplier: its payment terms (decision 15). The lines keep their prices; the editor
  // offers this supplier's last prices with one click.
  const changeSupplier = async (next: string) => {
    setValue('supplierId', next, { shouldValidate: errors.supplierId !== undefined });
    if (next === '') return;
    const picked = await queryClient.query(supplierQuery(tenantId, next));
    if (getValues('supplierId') === next) setValue('paymentTermsDays', picked.paymentTermsDays);
  };

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = order
        ? await call(routes.purchaseOrders.update, {
            params: { id: order.id },
            body: { ...values, version },
          })
        : await call(routes.purchaseOrders.create, { body: values });
      queryClient.setQueryData(purchaseOrderQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(
        saved.number === null
          ? t('purchaseOrders.draftSaved')
          : t('purchaseOrders.saved', { number: saved.number }),
      );
      if (order) onClose?.();
      else {
        void navigate({
          to: '/purchase-orders/$orderId',
          params: { orderId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(getValues('lines').length), setError);
    }
  });
```

- **`keptNumber`:** a reopened draft keeps its number, and with it its supplier (decision 33). The supplier box is
  disabled and its hint says why; the form also says the draft keeps its number, so nobody expects a new one.
- **`pricesIncludeVat` starts off for a new order** (decision 15): suppliers quote before VAT.
- **The warehouse select keeps the draft's own warehouse when it was archived since.** The API lets a draft keep
  it (decision 34) and refuses it only at submit, with a message; a select that dropped it would silently move the
  draft to another warehouse on the next save.
- **`changeSupplier` copies the supplier's payment terms** (decision 15) and leaves the lines alone. The editor then
  offers "Use this supplier's last prices on every line"; repricing by itself would throw away prices the buyer
  agreed on the phone.
- **`getValues('supplierId') === next` after the wait:** a second supplier picked while the first one loaded wins.
- **The saved order goes into the cache before the refresh,** so its page shows at once, and a new order opens its
  page with `replace`: Back from there goes to the list, not to an empty form.
- **The toast names the number only when there is one.** A new draft has none (decision 13); a reopened draft has.

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
      <PageHeader
        title={
          order ? (order.number ?? t('purchaseOrders.draftTitle')) : t('purchaseOrders.newTitle')
        }
        description={t('purchaseOrders.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {keptNumber !== null && (
          <p className="text-body-sm text-ink-2">
            {t('purchaseOrders.numberedDraft', { number: keptNumber })}
          </p>
        )}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField
            control={control}
            name="supplierId"
            label={t('purchaseOrders.supplier')}
            hint={keptNumber !== null ? t('purchaseOrders.supplierLocked') : undefined}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <PartyPicker
                  {...field}
                  role="supplier"
                  saved={order?.supplier ?? null}
                  disabled={keptNumber !== null}
                  onChange={(next) => void changeSupplier(next)}
                />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="date" label={t('purchaseOrders.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField
            control={control}
            name="expectedDate"
            label={t('purchaseOrders.expectedDate')}
            optional
            hint={t('purchaseOrders.expectedDateHint')}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('purchaseOrders.warehouse')}
            hint={t('purchaseOrders.warehouseHint')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...warehouses.map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <TextField
            label={t('purchaseOrders.supplierReference')}
            optional
            hint={t('purchaseOrders.supplierReferenceHint')}
            placeholder={t('purchaseOrders.supplierReferencePlaceholder')}
            {...register('supplierReference')}
            error={errors.supplierReference?.message}
          />
          <TextField
            label={t('purchaseOrders.paymentTerms')}
            hint={t('purchaseOrders.paymentTermsHint')}
            inputMode="numeric"
            autoComplete="off"
            align="end"
            suffix={t('suppliers.fields.days')}
            // The contract takes a number of days, not the box's text
            {...register('paymentTermsDays', { valueAsNumber: true })}
            error={errors.paymentTermsDays?.message}
          />
          <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
            <Controller
              control={control}
              name="pricesIncludeVat"
              render={({ field }) => (
                <Checkbox
                  id="pricesIncludeVat"
                  label={t('purchaseOrders.pricesIncludeVat')}
                  checked={field.value}
                  onCheckedChange={(checked) => {
                    field.onChange(checked === true);
                  }}
                />
              )}
            />
            <p className="pl-[27px] text-label text-ink-3">
              {t('purchaseOrders.pricesIncludeVatHint')}
            </p>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextAreaField
              label={t('purchaseOrders.note')}
              optional
              placeholder={t('purchaseOrders.notePlaceholder')}
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
              <PurchaseOrderLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
                initialLinks={start.links}
                supplierId={supplierId}
                warehouseId={warehouseId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
                startPicking={requisition?.id ?? null}
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
            {isSubmitting ? t('common.saving') : t('purchaseOrders.saveDraft')}
          </Button>
        </div>
      </form>
    </div>
  );
}
```

- **The payment terms box uses `valueAsNumber`:** the contract takes a number of days, not the box's text. The
  suffix says "days", like the supplier form's box.
- **There is only "Save draft".** The order is submitted from its page (decision 44), where the approval card shows
  who will approve it.

### The order's page: `components/purchase-order-view.tsx` (new)

```tsx
import {
  ArrowTurnBackwardIcon,
  Delete02Icon,
  PackageReceiveIcon,
  PencilEdit02Icon,
  SentIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type PurchaseOrder, routes, type StockDocumentStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import type { OutputTarget } from '../lib/document-output';
import { useCan } from '../lib/permissions';
import { leftToReceive } from '../lib/purchase';
import { purchaseOrderQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { ApprovalCard } from './approval-card';
import { failureOf } from './journal-parts';
import { PrintButton, PurchaseOrderPrint } from './print-documents';
import { PurchaseBackLink, SupplierLink, usePurchaseRefresh } from './purchase-parts';
import { GoodsReceiptStatusPill, PurchaseOrderStatusPills } from './purchase-pills';
import { SalesLinesTable } from './sales-lines-table';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
const DocumentHistory = lazy(async () => ({
  default: (await import('./document-history')).DocumentHistory,
}));

// What the view asks before it acts: each changes what others may do next
type Asking = 'reopen' | 'close' | 'cancel';

// The receipts list on the order sends a status as a plain string (purchase-orders.ts); only the
// two a goods receipt has are shown as a pill
function receiptStatus(status: string): StockDocumentStatus | null {
  return status === 'draft' || status === 'posted' ? status : null;
}

// A purchase order as it was saved (step 17b), with its approval, what came in, and what can be
// done next. A draft is changed with Edit and submitted from here (decision 13), like a
// requisition; a pending or approved one is reopened first (decision 11).
export function PurchaseOrderView({
  order,
  today,
  onEdit,
}: {
  order: PurchaseOrder;
  today: string;
  onEdit: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const refresh = usePurchaseRefresh();
  const { byId } = useWarehouses();
  const can = useCan();
  const canWrite = can('purchase.order.manage');
  const canReceive = can('purchase.receipt.manage');
  const [asking, setAsking] = useState<Asking | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { id, status, version, approval } = order;
  const number = order.number ?? '';
  const [round] = approval.rounds;
  // The step that sent it back, while it is a draft again: its comment says what to change
  const rejection =
    status === 'draft' && round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;
  // A posted receipt: goods came, so the rest is closed, never cancelled (decision 29). Any receipt,
  // even a draft, stops a reopen (decision 21).
  const received = order.receipts.some((receipt) => receipt.status === 'posted');
  const endAction: Asking = received ? 'close' : 'cancel';
  // Decision 35: an order goes out once approved. A received or closed one may be sent again.
  const issued = status === 'approved' || status === 'received' || status === 'closed';
  const target: OutputTarget | null =
    issued && order.number !== null
      ? { kind: 'purchase_order', id, number: order.number, partyId: order.supplier.id }
      : null;

  // Every action answers with the order itself: straight into its cache, then the lists, the
  // requisitions it buys for and the stock page's "incoming"
  const settle = async (saved: PurchaseOrder) => {
    queryClient.setQueryData(purchaseOrderQuery(tenantId, saved.id).queryKey, saved);
    await refresh();
  };

  const submit = useMutation({
    mutationFn: () => call(routes.purchaseOrders.submit, { params: { id }, body: { version } }),
    onSuccess: async (saved) => {
      await settle(saved);
      // The first submit gives the number; with no level, or an Owner submitting, it comes back
      // approved in the same step
      toast(
        t(
          saved.status === 'approved'
            ? 'purchaseOrders.submittedApproved'
            : 'purchaseOrders.submitted',
          { number: saved.number ?? '' },
        ),
      );
    },
  });
  const act = useMutation({
    mutationFn: (action: Asking) =>
      call(routes.purchaseOrders[action], { params: { id }, body: { version } }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      await settle(saved);
      const done = { reopen: 'reopened', close: 'closed', cancel: 'cancelled' } as const;
      toast(t(`purchaseOrders.${done[action]}`, { number }));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(routes.purchaseOrders.remove, { params: { id }, query: { version } }),
    onSuccess: async () => {
      // To the list first: the deleted order's own query would otherwise refetch into a 404
      await navigate({ to: '/purchase-orders' });
      queryClient.removeQueries({ queryKey: purchaseOrderQuery(tenantId, id).queryKey });
      await refresh();
      toast(t('purchaseOrders.deleted'));
    },
  });
  // purchase_supplier_invalid (archived since), purchase_warehouse_*, version_conflict, …
  const failure = failureOf(submit.error) ?? failureOf(remove.error);
  const busy = submit.isPending || remove.isPending || act.isPending;
```

- **The Send menu and the history cards are lazy chunks,** like the sales documents' (step 16).
- **`receiptStatus` narrows the receipt's status:** the contract sends it as a plain string, and only the two a
  receipt has get a pill.
- **`received` is "a posted receipt exists".** Then the rest of the order is closed, never cancelled (decision 29).
  Any receipt, even a draft, stops a reopen (decision 21); the page checks `order.receipts.length` for that.
- **`issued`** is approved, received or closed: the order may go out (decision 35). Only then is there a `target`
  for the Send menu, the Print button, the history cards and the printed sheet.
- **`settle` puts the answer in the cache, then refreshes:** every action answers with the whole order.
- **The submit toast reads the answer's status.** With no level, or an Owner submitting, the order comes back
  approved at once, and "sent for approval" would be untrue. The number comes from the answer, because the first
  submit is what gives it.
- **Delete goes to the list before it removes the order's query.** Otherwise the page, still open for a moment,
  would refetch the deleted order and show "not found".

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
      <PageHeader
        title={order.number ?? t('purchaseOrders.draftTitle')}
        description={order.supplier.name}
        actions={
          <>
            <PurchaseOrderStatusPills order={order} today={today} />
            {target && (
              <>
                <PrintButton />
                <Suspense fallback={null}>
                  <SendMenu target={target} />
                </Suspense>
              </>
            )}
          </>
        }
      />
      {failure && <FormAlert message={failure} />}
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('purchaseOrders.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {status === 'draft' && !rejection && order.number !== null && (
        <DocumentNotice tone="neutral">
          {t('purchaseOrders.numberedDraft', { number: order.number })}
        </DocumentNotice>
      )}
      {status !== 'draft' && (
        <DocumentNotice tone="neutral">
          {t(`purchaseOrders.notices.${status === 'approved' && received ? 'receiving' : status}`)}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">
            {t('purchaseOrders.supplier')}
          </span>
          <span className="text-body-sm">
            <SupplierLink supplier={order.supplier} />
          </span>
        </div>
        <Fact label={t('purchaseOrders.date')} value={isoDate(order.date)} />
        <Fact
          label={t('purchaseOrders.expectedDate')}
          value={
            order.expectedDate === null ? t('purchaseOrders.noDate') : isoDate(order.expectedDate)
          }
        />
        <Fact
          label={t('purchaseOrders.warehouse')}
          value={warehouseLabel(byId.get(order.warehouseId))}
        />
        <Fact
          label={t('purchaseOrders.paymentTerms')}
          value={
            order.paymentTermsDays === 0
              ? t('print.onDelivery')
              : t('print.termsDays', { count: order.paymentTermsDays })
          }
        />
        {order.supplierReference !== null && (
          <Fact label={t('purchaseOrders.supplierReference')} value={order.supplierReference} />
        )}
        {order.requisitions.length > 0 && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('purchaseOrders.requisitions')}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {order.requisitions.map((requisition) => (
                <Link
                  key={requisition.id}
                  to="/requisitions/$requisitionId"
                  params={{ requisitionId: requisition.id }}
                  className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
                >
                  {requisition.number}
                </Link>
              ))}
            </span>
          </div>
        )}
        {order.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('purchaseOrders.note')} value={order.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={order.lines}
        totals={order}
        pricesIncludeVat={order.pricesIncludeVat}
        note={(line) =>
          line.requisitionLine && (
            <span className="text-caption text-ink-3">
              {t('purchaseOrders.forRequisition', { number: line.requisitionLine.number })}
            </span>
          )
        }
        // Once approved: what came in and what was turned back, in the base unit, the unit goods
        // receipts count in
        more={
          issued
            ? {
                headers: [t('purchaseOrders.received'), t('purchaseOrders.rejected')],
                cells: (line) =>
                  line.productType === 'service' ? (
                    <td colSpan={2} className="px-5 py-3 text-right text-caption text-ink-3">
                      {t('purchaseOrders.serviceLine')}
                    </td>
                  ) : (
                    <>
                      <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                        {quantity(line.receivedQuantity, line.baseUnitId)}
                        <span className="block text-caption text-ink-3">
                          {t('purchaseOrders.left')}:{' '}
                          {quantity(leftToReceive(line), line.baseUnitId)}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                        {quantity(line.rejectedQuantity, line.baseUnitId)}
                      </td>
                    </>
                  ),
              }
            : undefined
        }
      />
      <ApprovalCard
        document="purchase_order"
        id={id}
        number={number}
        amount={order.total}
        draft={status === 'draft'}
        approval={approval}
      />
      {issued && (
        <LinkList
          title={t('purchaseOrders.receiptsTitle')}
          subtitle={t('purchaseOrders.receiptsSubtitle')}
          empty={order.receipts.length === 0 ? t('purchaseOrders.noReceipts') : undefined}
        >
          {order.receipts.map((receipt) => {
            const pill = receiptStatus(receipt.status);
            return (
              <li key={receipt.id}>
                <Link
                  to="/goods-receipts/$receiptId"
                  params={{ receiptId: receipt.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>
                    {receipt.number ?? t('goodsReceipts.statuses.draft')}
                  </span>
                  <span className="text-ink-3 tabular-nums">{isoDate(receipt.date)}</span>
                  <span className="ml-auto">
                    {pill !== null && <GoodsReceiptStatusPill status={pill} />}
                  </span>
                </Link>
              </li>
            );
          })}
        </LinkList>
      )}
```

- **The notices:** a draft sent back shows the approver's name and comment (warn, with the "sent back" icon, like a
  requisition). A numbered draft without a rejection says it keeps its number. An approved order with a posted
  receipt shows `receiving` instead of `approved`: it can no longer be reopened or cancelled, and the missing
  buttons would otherwise look like a bug.
- **Payment terms read "On delivery" for 0 days,** the words of the PDF.
- **The requisitions are links** to the requisition pages, in `Geist Mono` like every document number.
- **The lines' note says which requisition a line buys for;** once the order is issued, two more columns say what
  came in and what was turned back, in the base unit (decision 49). A service line spans both columns with "A
  service: not received".
- **The approval card gets the total with VAT** (decision 14) and `draft`, so a draft lists the levels it would
  need now.
- **The receipts card shows only once the order is issued:** a draft cannot be received.

```tsx
      {canWrite && status === 'draft' && (
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Left, away from the rest */}
            <div className="mr-auto flex flex-wrap items-center gap-2">
              {order.number === null ? (
                // Two clicks: a deleted draft cannot come back
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
                    ? t('purchaseOrders.confirmDelete')
                    : t('purchaseOrders.deleteDraft')}
                </Button>
              ) : (
                // Numbered: its history stays, so it is cancelled (decision 13)
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setAsking('cancel');
                  }}
                >
                  {t('purchaseOrders.cancel')}
                </Button>
              )}
              {confirmingDelete && (
                <span className="text-body-sm text-ink-2">{t('purchaseOrders.deleteWarning')}</span>
              )}
            </div>
            <Button variant="secondary" disabled={busy} onClick={onEdit}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
              {t('purchaseOrders.edit')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                submit.mutate();
              }}
            >
              <HugeiconsIcon icon={SentIcon} size={17} strokeWidth={1.5} />
              {t('purchaseOrders.submit')}
            </Button>
          </div>
          <p className="text-right text-label text-ink-3">{t('purchaseOrders.submitHint')}</p>
        </div>
      )}
      {canWrite && status === 'pending' && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setAsking('reopen');
            }}
          >
            {t('purchaseOrders.reopen')}
          </Button>
        </div>
      )}
      {status === 'approved' && (canWrite || canReceive) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canWrite && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={busy}
              onClick={() => {
                setAsking(endAction);
              }}
            >
              {t(`purchaseOrders.${endAction}`)}
            </Button>
          )}
          {/* Back to draft only with no goods receipt at all, drafts included (decision 21) */}
          {canWrite && order.receipts.length === 0 && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setAsking('reopen');
              }}
            >
              {t('purchaseOrders.reopen')}
            </Button>
          )}
          {canReceive && (
            <Button
              disabled={busy}
              onClick={() => void navigate({ to: '/goods-receipts/new', search: { orderId: id } })}
            >
              <HugeiconsIcon icon={PackageReceiveIcon} size={17} strokeWidth={1.5} />
              {t('purchaseOrders.receive')}
            </Button>
          )}
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
            title={t(`purchaseOrders.${asking}Title`, { number })}
            description={t(`purchaseOrders.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'reopen' ? t('common.cancel') : t('purchaseOrders.keepOrder')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`purchaseOrders.${asking}`)}
                </Button>
              </>
            }
          >
            {failureOf(act.error) && <FormAlert message={failureOf(act.error) ?? ''} />}
          </DialogContent>
        )}
      </Dialog>
      {target && (
        <Suspense fallback={null}>
          <DocumentHistory target={target} />
        </Suspense>
      )}
      {target && <PurchaseOrderPrint order={order} />}
    </div>
  );
}
```

- **A draft shows Delete (never submitted) or Cancel (numbered),** Edit and "Submit for approval", with the submit
  hint under them. A numbered draft is cancelled, not deleted (decision 13).
- **Pending shows Reopen only.** The API cancels a pending order only after a reopen.
- **Approved shows "Close order" or "Cancel order",** by whether goods came (decision 29), Reopen while no receipt
  exists at all, and "Receive goods" for the store keeper (`purchase.receipt.manage`). The buttons are split by
  permission, so a store keeper sees only "Receive goods".
- **Reopen, Close and Cancel ask first** in a dialog. For Close and Cancel the button that closes the dialog says
  "Keep the order", so the two buttons are never "Cancel" and "Cancel order".

### The order pages: `routes/purchase-order.tsx` and `routes/purchase-orders.tsx` (new)

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { purchaseOrderQuery, requisitionQuery, taxRatesQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// requisition's pattern): reading an order needs neither the form library nor the line editor.
const PurchaseOrderForm = lazy(async () => ({
  default: (await import('../components/purchase-order-form')).PurchaseOrderForm,
}));
const PurchaseOrderView = lazy(async () => ({
  default: (await import('../components/purchase-order-view')).PurchaseOrderView,
}));

// What every order page needs before it draws: the units (a line's quantity), the VAT rates (a
// line's rate) and the warehouses (the select, and the name of an archived one)
function useReady(): boolean {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const { active } = useWarehouses();
  return units !== undefined && rates !== undefined && active !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('purchaseOrders.title')} description={message} />
    </div>
  );
}

// A new order; "Make purchase order" on a requisition comes here with ?requisitionId=
export function NewPurchaseOrderPage() {
  const { t } = useLocale();
  const canWrite = useCan()('purchase.order.manage');
  const today = useToday();
  const ready = useReady();
  const { requisitionId = '' } = useSearch({ strict: false });
  const { data: requisition, isError } = useQuery({
    ...requisitionQuery(useTenantId(), requisitionId),
    enabled: requisitionId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
        <p className="text-body-sm text-ink-3">{t('purchaseOrders.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('requisitions.notFound')} />;
  if (!ready || (requisitionId !== '' && !requisition)) return null;
  return (
    <Suspense fallback={null}>
      <PurchaseOrderForm
        order={null}
        requisition={
          requisition ? { id: requisition.id, warehouseId: requisition.warehouseId } : null
        }
        today={today}
      />
    </Suspense>
  );
}

export function PurchaseOrderPage() {
  const { t } = useLocale();
  const { orderId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.order.manage');
  const today = useToday();
  const ready = useReady();
  // A draft is shown as it was saved, with Submit; "Edit" turns the page into the form until it
  // is saved
  const [editing, setEditing] = useState(false);
  const { data: order, isError } = useQuery({
    ...purchaseOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });

  if (isError) return <CantFind message={t('purchaseOrders.notFound')} />;
  if (!order || !ready) return null;
  // Only a draft is changed: one submitted meanwhile (from another tab) shows as it is now
  if (editing && canWrite && order.status === 'draft') {
    return (
      <Suspense fallback={null}>
        <PurchaseOrderForm
          key={`${order.id}-${String(order.version)}`}
          order={order}
          requisition={null}
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
      <PurchaseOrderView
        order={order}
        today={today}
        onEdit={() => {
          setEditing(true);
        }}
      />
    </Suspense>
  );
}
```

The page loads the data and picks the form or the view, like the requisition's. It waits for the VAT rates too:
the form's editor and the view's table both name a line's rate. A new order from "Make purchase order" loads the
requisition first, for its warehouse (decision 45). Edit shows the form only while the order is a draft: if it was
submitted meanwhile from another tab, the page shows it as it is now.

```tsx
import { PlusSignIcon, ShoppingBasket01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  PURCHASE_ORDER_RECEIPT_FILTERS,
  PURCHASE_ORDER_STATUSES,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
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

import { SupplierFilter } from '../components/purchase-parts';
import { PurchaseOrderStatusPills } from '../components/purchase-pills';
import {
  useIsoDate,
  useTenantId,
  useToday,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { purchaseOrdersQuery } from '../lib/queries';

const column = dataTableColumns<PurchaseOrderSummary>();

// "To receive" sits with the statuses, like the requisitions' "To order": it is the store keeper's
// queue (approved, with goods still to come)
type Show = PurchaseOrderStatus | PurchaseOrderReceiptFilter | 'all';

function isReceiptFilter(show: Show): show is PurchaseOrderReceiptFilter {
  return PURCHASE_ORDER_RECEIPT_FILTERS.some((filter) => filter === show);
}

// The purchase orders (step 17b), newest date first. Everyone reads them (a store keeper checks
// what is coming to the gate); writing them needs purchase.order.manage.
export function PurchaseOrdersPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.order.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const { active, byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    purchaseOrdersQuery(useTenantId(), {
      status: show === 'all' || isReceiptFilter(show) ? '' : show,
      warehouseId,
      supplierId,
      receipt: isReceiptFilter(show) ? show : '',
    }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('purchaseOrders.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A draft nobody submitted has no number yet (decision 13) */}
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('purchaseOrders.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((row) => row.supplier.name, {
          id: 'supplier',
          header: t('purchaseOrders.columns.supplier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
        }),
        column.accessor('expectedDate', {
          header: t('purchaseOrders.columns.expectedDate'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = getValue();
            return date === null ? '—' : <span className="tabular-nums">{isoDate(date)}</span>;
          },
        }),
        column.accessor('warehouseId', {
          header: t('purchaseOrders.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        // Whole taka, like every list (CLAUDE.md → Money); the page shows the paisa
        column.accessor('total', {
          header: t('purchaseOrders.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('purchaseOrders.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <PurchaseOrderStatusPills order={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, byId, today],
  );

  const newButton = canWrite && (
    <Button onClick={() => void navigate({ to: '/purchase-orders/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('purchaseOrders.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('purchaseOrders.title')}
        description={t('purchaseOrders.description')}
        actions={newButton}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="purchase-orders-supplier"
            aria-label={t('purchaseOrders.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('purchaseOrders.warehouse')}
            options={[
              { value: '', label: t('purchaseOrders.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('purchaseOrders.show')}
          value={show}
          options={[
            { value: 'all', label: t('purchaseOrders.all') },
            ...PURCHASE_ORDER_STATUSES.map((value) => ({
              value,
              label: t(`purchaseOrders.statuses.${value}`),
            })),
            ...PURCHASE_ORDER_RECEIPT_FILTERS.map((value) => ({
              value,
              label: t(`purchaseOrders.receiptFilters.${value}`),
            })),
          ]}
          onChange={setShow}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('purchaseOrders.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('purchaseOrders.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/purchase-orders/$orderId', params: { orderId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ShoppingBasket01Icon}
              title={t('purchaseOrders.emptyTitle')}
              description={t('purchaseOrders.emptyBody')}
              action={newButton}
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

The list, newest first, with the supplier, the warehouse and the status, and "To receive" with the statuses
(decision 47). An unsubmitted draft has no number, so the number column says "Draft". The total is whole taka, like
every list; the page shows the paisa.

### The goods receipt's lines: `components/stock-line-row.tsx` and `stock-lines-table.tsx`

```diff
@@ -56,7 +56,14 @@ const COSTED_COLUMNS =
 
 // The column headers of a wide card. Hidden from screen readers: each control has its own
 // (sr-only) label there, which reads better than a header far away.
-export function StockLinesHeader({ costed = false }: { costed?: boolean }) {
+export function StockLinesHeader({
+  costed = false,
+  quantityLabel,
+}: {
+  costed?: boolean;
+  // Step 17b: a goods receipt's quantity is what was accepted
+  quantityLabel?: string;
+}) {
   const { t } = useLocale();
   return (
     <div
@@ -68,7 +75,7 @@ export function StockLinesHeader({ costed = false }: { costed?: boolean }) {
     >
       <span>{t('stockLines.items')}</span>
       <span>{t('stockLines.unit')}</span>
-      <span className="text-right">{t('stockLines.quantity')}</span>
+      <span className="text-right">{quantityLabel ?? t('stockLines.quantity')}</span>
       {costed && <span className="text-right">{t('stockLines.unitCost')}</span>}
       <span>{t('stock.history.detail')}</span>
     </div>
@@ -100,6 +107,8 @@ export function StockLineRow({
   serials,
   cost,
   note,
+  quantityLabel,
+  rejection,
   errors,
   onRemove,
   onSplit,
@@ -131,6 +140,10 @@ export function StockLineRow({
   cost?: ReactNode;
   // Step 15b: a line under the item, such as what the order asked for and what it has left
   note?: ReactNode;
+  // Step 17b: a goods receipt's line. Its quantity is what was accepted (the box's label says so),
+  // and what was turned back, with the reason, sits first in the detail column.
+  quantityLabel?: string;
+  rejection?: ReactNode;
   errors: LineErrors;
   onRemove: () => void;
   // FEFO for a line that takes stock out; a return's lines have none (15d)
@@ -199,7 +212,11 @@ export function StockLineRow({
           {...fields.unitId}
         />
       </LineField>
-      <LineField id={id('quantity')} label={t('stockLines.quantity')} error={errors.quantity}>
+      <LineField
+        id={id('quantity')}
+        label={quantityLabel ?? t('stockLines.quantity')}
+        error={errors.quantity}
+      >
         <Input
           id={id('quantity')}
           inputMode="decimal"
@@ -217,6 +234,7 @@ export function StockLineRow({
       </LineField>
       {cost !== undefined && <div className="col-span-2 @3xl:col-span-1">{cost}</div>}
       <div className="col-span-2 grid grid-cols-1 gap-3 @3xl:col-span-1">
+        {rejection}
         {item.tracking === 'batch' && mode === 'in' && fields.lotNumber && (
           <>
             <LineField id={id('lotNumber')} label={t('stockLines.lot')} error={errors.lotNumber}>
```

The stock line row takes two more props: `quantityLabel` (a receipt's quantity is "Accepted", decision 20) and
`rejection`, the rejected quantity and its reason. They go first in the detail column, before the lot and the
serial numbers, so the gate's count reads left to right: accepted, rejected, then which lot.

```diff
@@ -3,6 +3,7 @@ import {
   type AdjustmentLine,
   compareQuantity,
   type DeliveryLine,
+  type GoodsReceiptLine,
   type SalesReturnLine,
   subtractMoney,
   subtractQuantity,
@@ -15,9 +16,10 @@ import type { ReactNode } from 'react';
 
 import { useIsoDate, useQuantity, useUnitCode, useValue, VariantCell } from './stock-parts';
 
-// A line of any stock document this table shows; a delivery's (step 15b) and a sales return's
-// (15d) have a value and no cost
-type DocumentLine = AdjustmentLine | TransferLine | DeliveryLine | SalesReturnLine;
+// A line of any stock document this table shows; a delivery's (step 15b), a sales return's (15d)
+// and a goods receipt's (17b) have a value and no cost
+type DocumentLine =
+  AdjustmentLine | TransferLine | DeliveryLine | SalesReturnLine | GoodsReceiptLine;
 
 // Step 14: what a line was worth (null without inventory.stock.value), and on an adjustment the
 // cost a person typed. Read from any kind of line.
```

The table of a posted document's lines shows a goods receipt's lines too: they have a value and no typed cost,
like a delivery's.

### The goods receipt form: `components/goods-receipt-form.tsx` (new)

```tsx
import { Calendar03Icon, Delete02Icon, TaskDone01Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type GoodsReceipt,
  isQuantityOrZero,
  isZeroQuantity,
  plainQuantity,
  type PurchaseOrder,
  receivedOf,
  routes,
  updateGoodsReceiptInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Field,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  Select,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useRef, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { allowedToReceive, leftToReceive, receiptFill } from '../lib/purchase';
import {
  goodsReceiptQuery,
  ordersToReceiveQuery,
  purchaseOrderQuery,
  settingsQuery,
  unitsQuery,
} from '../lib/queries';
import { baseByOrderLine } from '../lib/sales';
import { basePreview, firstMessage, serialPath } from '../lib/stock';
import { failureOf, LineField } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The goods receipt form (step 17b): its own chunk (loaded by routes/goods-receipt.tsx), like the
// delivery form. A receipt is a stock document made from an approved order (decision 8): its lines
// are the stock lines of step 13 that bring stock in (a lot and its dates, serial numbers), each
// naming its order line, with what the gate turned back beside what it accepted (decision 9).

// The supplier box and the date picker as chunks of their own, like the delivery form's: both
// bring the popover
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// The edit form's values, which the create form shares: the order is not one of them. A receipt
// keeps its order (the update route has no orderId), so the form keeps it beside its values, and
// a new receipt adds it to the body.
type FormValues = z.input<typeof updateGoodsReceiptInputSchema>;
type LineValues = FormValues['lines'][number];

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'date',
    'warehouseId',
    'supplierChallan',
    'vehicle',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'lotNumber'),
      rowPath('lines', index, 'expiresOn'),
      rowPath('lines', index, 'manufacturedOn'),
      rowPath('lines', index, 'serialNumbers'),
      rowPath('lines', index, 'orderLineId'),
      rowPath('lines', index, 'rejectedQuantity'),
      rowPath('lines', index, 'rejectionReason'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// What is left on an order, as receipt lines, and the items they need. `onForm`: what the form
// already accepts for each order line, in the base unit.
function linesFrom(
  order: PurchaseOrder,
  onForm: ReadonlyMap<string, string>,
): { lines: LineValues[]; items: LineItem[] } {
  return {
    lines: receiptFill(order.lines, onForm).map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      batchId: '',
      lotNumber: '',
      expiresOn: '',
      manufacturedOn: '',
      serialNumbers: [],
      orderLineId: line.orderLineId,
      rejectedQuantity: '',
      rejectionReason: '',
    })),
    items: order.lines.map(toLineItem),
  };
}
```

- **`FormValues` is the update schema's input,** which has no `orderId` (decision 46). The create route adds the
  order to the body. One resolver for both, so the form never checks an `orderId` it does not show.
- **`fieldNames` has every line field,** the order line, the rejected quantity and the reason included, and one
  entry per serial number, like the delivery form.
- **`linesFrom`** makes receipt lines from `receiptFill`: no lot yet, nothing rejected. The rejected box starts
  empty, not "0", like every optional number in the app.

```tsx
// Writing a new goods receipt (from an order's "Receive goods", or by picking the supplier and its
// order), or changing a draft. "Save draft" keeps it a draft; "Post goods receipt" saves and posts
// in one request: the accepted goods come into stock at the order's price, all or nothing.
export function GoodsReceiptForm({
  receipt,
  order,
  today,
}: {
  receipt: GoodsReceipt | null;
  // The order a new receipt starts from ("Receive goods" on the order's page); null otherwise
  order: PurchaseOrder | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const [confirming, setConfirming] = useState(false);
  const [start] = useState(() => (order ? linesFrom(order, new Map()) : null));
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () =>
      new Map(
        [...(receipt?.lines ?? []), ...(start?.items ?? [])].map((line) => [
          line.variantId,
          toLineItem(line),
        ]),
      ),
  );
  // The supplier only narrows the order box; the receipt takes its supplier from the order
  const [supplierId, setSupplierId] = useState(receipt?.supplier.id ?? order?.supplier.id ?? '');
  const [orderId, setOrderId] = useState(receipt?.order.id ?? order?.id ?? '');
  // The order picked last, for the change that waits for its order: a quicker second pick wins
  const pickedRef = useRef(orderId);
  // A draft keeps its order (decision 20); "Receive goods" came with one
  const locked = receipt !== null || order !== null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateGoodsReceiptInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: receipt?.date ?? today,
      warehouseId: receipt?.warehouseId ?? order?.warehouseId ?? '',
      supplierChallan: receipt?.supplierChallan ?? '',
      vehicle: receipt?.vehicle ?? '',
      note: receipt?.note ?? '',
      lines:
        receipt?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          lotNumber: line.lotNumber ?? '',
          expiresOn: line.expiresOn ?? '',
          manufacturedOn: line.manufacturedOn ?? '',
          serialNumbers: line.serialNumbers,
          orderLineId: line.orderLineId,
          // Nothing turned back is an empty box, not "0"
          rejectedQuantity: isZeroQuantity(line.rejectedQuantity)
            ? ''
            : plainQuantity(line.rejectedQuantity),
          rejectionReason: line.rejectionReason ?? '',
        })) ??
        start?.lines ??
        [],
      post: false,
      version: receipt?.version ?? 1,
    },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  // The over-receipt percent (decision 22), for "Up to … may come"
  const percent = useQuery(settingsQuery(tenantId)).data?.overReceiptPercent ?? '0';
  const openOrders = useQuery({
    ...ordersToReceiveQuery(tenantId, supplierId),
    enabled: supplierId !== '' && !locked,
  }).data;
  // The chosen order with its lines: what each line ordered, received and has left
  const chosenOrder = useQuery({
    ...purchaseOrderQuery(tenantId, orderId),
    enabled: orderId !== '',
  }).data;
  const orderLines = new Map(chosenOrder?.lines.map((line) => [line.id, line]));

  // The order box: the supplier's approved orders with goods to come, or (locked) the one order
  const orderOptions = locked
    ? [{ value: orderId, label: receipt?.order.number ?? order?.number ?? '' }]
    : [
        { value: '', label: t('goodsReceipts.orderPlaceholder') },
        ...(openOrders ?? []).map((open) => ({
          value: open.id,
          label: [open.number ?? '', isoDate(open.date), open.supplierReference]
            .filter((part) => part !== null && part !== '')
            .join(' · '),
        })),
      ];

  // The base quantity a line accepts, for "what is left" (null while a quantity is being typed)
  const baseOf = (line: LineValues): string | null => {
    const item = items.get(line.variantId);
    if (!item) return null;
    return line.unitId === item.baseUnitId
      ? line.quantity.trim() === ''
        ? null
        : line.quantity.trim()
      : basePreview(item, line.unitId, line.quantity, units);
  };

  const addItems = (next: readonly LineItem[]) => {
    setItems((before) => {
      const map = new Map(before);
      for (const item of next) map.set(item.variantId, toLineItem(item));
      return map;
    });
  };

  // Another supplier: its orders, so the order and its lines go
  const changeSupplier = (next: string) => {
    setSupplierId(next);
    setOrderId('');
    pickedRef.current = '';
    replace([]);
  };

  // Another order: its warehouse and what it has left replace what was there
  const changeOrder = async (next: string) => {
    setOrderId(next);
    pickedRef.current = next;
    replace([]);
    if (next === '') return;
    const picked = await queryClient.query(purchaseOrderQuery(tenantId, next));
    if (pickedRef.current !== next) return;
    setValue('warehouseId', picked.warehouseId);
    const filled = linesFrom(picked, new Map());
    addItems(filled.items);
    replace(filled.lines);
  };

  // "Add what is left on the order": only what the form does not accept yet
  const fillRest = () => {
    if (!chosenOrder) return;
    const onForm = baseByOrderLine(
      getValues('lines').map((line) => ({ orderLineId: line.orderLineId, base: baseOf(line) })),
    );
    const filled = linesFrom(chosenOrder, onForm);
    if (filled.lines.length === 0) {
      toast(t('goodsReceipts.nothingLeft'));
      return;
    }
    addItems(filled.items);
    append(filled.lines);
  };

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const saved = receipt
          ? await call(routes.goodsReceipts.update, {
              params: { id: receipt.id },
              body: { ...values, post, version },
            })
          : await call(routes.goodsReceipts.create, { body: { ...values, orderId, post } });
        queryClient.setQueryData(goodsReceiptQuery(tenantId, saved.id).queryKey, saved);
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('goodsReceipts.posted', { number: saved.number ?? '' })
            : t('goodsReceipts.draftSaved'),
        );
        if (!receipt) {
          void navigate({
            to: '/goods-receipts/$receiptId',
            params: { receiptId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: GoodsReceipt) =>
      call(routes.goodsReceipts.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await navigate({ to: '/goods-receipts' });
      await refresh();
      toast(t('goodsReceipts.deleted'));
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;
```

- **`supplierId` and `orderId` are state, not form values.** The supplier only narrows the order box; the API takes
  the receipt's supplier from the order.
- **`locked`:** a draft keeps its order (decision 20), and "Receive goods" on the order page came with one. Both
  boxes are disabled then, and the hint says why.
- **`percent` reads the workspace's over-receipt percent** for the "Up to … may come" note. `?? '0'` until the
  settings arrive: the note is then left out, as it is for a workspace that allows nothing over.
- **A draft's rejected quantity comes back as "0.0000"** and is shown as an empty box, so a draft saved again does
  not suddenly show zeros the person never typed.
- **`pickedRef` holds the order picked last.** `changeOrder` waits for the order's lines; if the person picked
  another order meanwhile, the first answer is dropped instead of filling the form with the wrong order's lines.
  A ref, not the `orderId` state: the waiting function sees the state of the render that started it.
- **Another order sets the warehouse to the order's,** and the person may change it: a truck may unload at another
  warehouse (decision 20).
- **`fillRest` counts what the form already accepts per order line** (`baseByOrderLine`, the delivery's helper), so
  a second press adds only what is still missing.
- **The saved receipt goes into the cache,** and a new one opens its page with `replace`. A draft's page then shows
  the form again, now with its new version (the route's `key`).

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
      <PageHeader
        title={receipt ? t('goodsReceipts.draftTitle') : t('goodsReceipts.newTitle')}
        description={t('goodsReceipts.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          {/* Not form values: the update route keeps the order, and the supplier only narrows
              the order box */}
          <Field id="grn-supplier" label={t('goodsReceipts.supplier')}>
            <Suspense fallback={<Input id="grn-supplier" icon={UserIcon} disabled />}>
              <PartyPicker
                id="grn-supplier"
                role="supplier"
                value={supplierId}
                saved={receipt?.supplier ?? order?.supplier ?? null}
                disabled={locked}
                onChange={changeSupplier}
              />
            </Suspense>
          </Field>
          <Field
            id="grn-order"
            label={t('goodsReceipts.order')}
            hint={
              locked
                ? t('goodsReceipts.orderLocked')
                : openOrders?.length === 0
                  ? t('goodsReceipts.orderEmpty')
                  : t('goodsReceipts.orderHint')
            }
          >
            <Select
              id="grn-order"
              options={orderOptions}
              value={orderId}
              disabled={locked || supplierId === ''}
              aria-describedby="grn-order-hint"
              onChange={(event) => void changeOrder(event.target.value)}
            />
          </Field>
          <FormField control={control} name="date" label={t('goodsReceipts.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('goodsReceipts.warehouse')}
            // The truck may unload elsewhere (decision 20): say where the order wanted it
            hint={
              chosenOrder
                ? t('goodsReceipts.warehouseHint', {
                    warehouse: warehouseLabel(byId.get(chosenOrder.warehouseId)),
                  })
                : undefined
            }
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <TextField
            label={t('goodsReceipts.supplierChallan')}
            optional
            placeholder={t('goodsReceipts.supplierChallanPlaceholder')}
            {...register('supplierChallan')}
            error={errors.supplierChallan?.message}
          />
          <TextField
            label={t('goodsReceipts.vehicle')}
            optional
            placeholder={t('goodsReceipts.vehiclePlaceholder')}
            {...register('vehicle')}
            error={errors.vehicle?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('goodsReceipts.note')}
              optional
              placeholder={t('goodsReceipts.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>
```

- **The supplier and the order are wrapped in `Field`,** the same label and hint layout as the form's own fields,
  because they are not form fields. The order hint says "No approved order is waiting for goods" when the supplier
  has none, so the empty select explains itself.
- **The warehouse hint names the order's warehouse,** so a store keeper who unloads elsewhere notices it.

```tsx
        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('stockLines.items')}
        >
          {fields.length === 0 ? (
            <p className="px-5 py-6 text-body-sm text-ink-2">{t('stockLines.noLines')}</p>
          ) : (
            <StockLinesHeader quantityLabel={t('goodsReceipts.accepted')} />
          )}
          {fields.map((field, index) => {
            const item = items.get(field.variantId);
            if (!item) return null;
            const line = lines[index];
            const lineErrors = errors.lines?.[index];
            const serials = rowPath('lines', index, 'serialNumbers');
            const rejected = rowPath('lines', index, 'rejectedQuantity');
            const reason = rowPath('lines', index, 'rejectionReason');
            const orderLine = orderLines.get(line?.orderLineId ?? '');
            const unitId = line?.unitId ?? item.baseUnitId;
            const typed = line?.quantity.trim() ?? '';
            // An empty accepted box counts as nothing: everything that came was turned back
            const accepted = typed === '' ? '0' : typed;
            const turnedBack = line?.rejectedQuantity.trim() ?? '';
            // Something typed in the rejected box that is not nothing: the reason box shows
            const rejecting =
              turnedBack !== '' && !(isQuantityOrZero(turnedBack) && isZeroQuantity(turnedBack));
            // What came off the truck, once both boxes hold quantities (decision 9)
            const came =
              rejecting && isQuantityOrZero(turnedBack) && isQuantityOrZero(accepted)
                ? receivedOf({ quantity: accepted, rejectedQuantity: turnedBack })
                : null;
            return (
              <StockLineRow
                key={field.id}
                index={index}
                item={item}
                mode="in"
                warehouseId={warehouseId}
                unitId={unitId}
                quantity={line?.quantity ?? ''}
                quantityLabel={t('goodsReceipts.accepted')}
                fields={{
                  unitId: register(rowPath('lines', index, 'unitId')),
                  quantity: register(rowPath('lines', index, 'quantity')),
                  batchId: register(rowPath('lines', index, 'batchId')),
                  lotNumber: register(rowPath('lines', index, 'lotNumber')),
                }}
                note={
                  orderLine && (
                    <span className="text-caption text-ink-3 tabular-nums">
                      {t('goodsReceipts.ordered', {
                        quantity: quantityText(orderLine.quantity, orderLine.unitId),
                      })}{' '}
                      ·{' '}
                      {t('goodsReceipts.leftOnOrder', {
                        quantity: quantityText(leftToReceive(orderLine), orderLine.baseUnitId),
                      })}
                      {/* Only when the workspace lets more in (decision 22) */}
                      {!isZeroQuantity(percent) &&
                        ` · ${t('goodsReceipts.allowed', {
                          quantity: quantityText(
                            allowedToReceive(orderLine, percent),
                            orderLine.baseUnitId,
                          ),
                        })}`}
                    </span>
                  )
                }
                rejection={
                  <div className="grid grid-cols-1 gap-3">
                    <LineField
                      id={rejected}
                      label={t('goodsReceipts.rejected')}
                      error={lineErrors?.rejectedQuantity?.message}
                    >
                      <Input
                        id={rejected}
                        inputMode="decimal"
                        autoComplete="off"
                        align="end"
                        invalid={lineErrors?.rejectedQuantity !== undefined}
                        {...register(rejected)}
                      />
                      {came !== null && (
                        <span className="text-right text-caption text-ink-3 tabular-nums">
                          {t('goodsReceipts.came', { quantity: quantityText(came, unitId) })}
                        </span>
                      )}
                    </LineField>
                    {/* The reason only when something was turned back: it is kept only then
                        (decision 38) */}
                    {rejecting || lineErrors?.rejectionReason !== undefined ? (
                      <LineField
                        id={reason}
                        label={t('goodsReceipts.rejectionReason')}
                        error={lineErrors?.rejectionReason?.message}
                      >
                        <Input
                          id={reason}
                          autoComplete="off"
                          placeholder={t('goodsReceipts.rejectionReasonPlaceholder')}
                          invalid={lineErrors?.rejectionReason !== undefined}
                          {...register(reason)}
                        />
                      </LineField>
                    ) : null}
                  </div>
                }
                dates={(['expiresOn', 'manufacturedOn'] as const).map((date) => (
                  <Controller
                    key={date}
                    control={control}
                    name={rowPath('lines', index, date)}
                    render={({ field: dateField, fieldState }) => (
                      <LineField
                        id={dateField.name}
                        label={t(`stockLines.${date}`)}
                        error={fieldState.error?.message}
                      >
                        <Suspense
                          fallback={<Input id={dateField.name} icon={Calendar03Icon} disabled />}
                        >
                          <DatePicker
                            id={dateField.name}
                            name={dateField.name}
                            ref={dateField.ref}
                            value={dateField.value ?? ''}
                            onChange={dateField.onChange}
                            onBlur={dateField.onBlur}
                            invalid={fieldState.error !== undefined}
                          />
                        </Suspense>
                      </LineField>
                    )}
                  />
                ))}
                serials={
                  <Controller
                    control={control}
                    name={serials}
                    render={({ field: serialField }) => {
                      const error = firstMessage(lineErrors?.serialNumbers);
                      return (
                        <LineField id={serials} label={t('stockLines.serials')} error={error}>
                          <SerialNumbersInput
                            id={serials}
                            name={serialField.name}
                            ref={serialField.ref}
                            value={serialField.value}
                            onChange={serialField.onChange}
                            onBlur={serialField.onBlur}
                            invalid={error !== undefined}
                          />
                          <span className="text-caption text-ink-3">
                            {t('stockLines.serialsHint')}
                          </span>
                        </LineField>
                      );
                    }}
                  />
                }
                errors={{
                  unitId: lineErrors?.unitId?.message,
                  // The order line's own problems (over the order, not this order's) show under
                  // the quantity, the box the person changes to fix them
                  quantity: lineErrors?.quantity?.message ?? lineErrors?.orderLineId?.message,
                  batchId: lineErrors?.batchId?.message,
                  lotNumber: lineErrors?.lotNumber?.message,
                }}
                onRemove={() => {
                  remove(index);
                }}
              />
            );
          })}
          {linesError && (
            <div className="border-t border-line px-5 py-3">
              <FormAlert message={linesError} />
            </div>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button variant="secondary" size="sm" disabled={!chosenOrder} onClick={fillRest}>
              <HugeiconsIcon icon={TaskDone01Icon} size={16} strokeWidth={1.5} />
              {t('goodsReceipts.fillFromOrder')}
            </Button>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {receipt && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(receipt);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('goodsReceipts.confirmDelete') : t('goodsReceipts.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('goodsReceipts.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting || orderId === ''}>
            {t('goodsReceipts.saveDraft')}
          </Button>
          <Button
            disabled={isSubmitting || orderId === '' || fields.length === 0}
            onClick={() => void save(true)()}
          >
            {isSubmitting ? t('goodsReceipts.posting') : t('goodsReceipts.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('goodsReceipts.postHint')}</p>
      </form>
    </div>
  );
}
```

- **Each line notes what was ordered, what is left, and (with a percent set) how much may still come.** The limit
  is visible before the API refuses with `grn_over_order`.
- **`accepted` counts an empty box as zero:** a line where everything was turned back has nothing accepted
  (decision 20).
- **`rejecting`** is true when something other than a zero is typed in the rejected box. Only then does the reason
  box show (decision 38). It also shows when the server named it, so an error never sits under a hidden box.
- **`came` adds accepted and rejected with the contract's `receivedOf`,** only when both are quantities. "42 bags
  came" is the number the driver's challan says, so the store keeper can check the two boxes against it.
- **The batch and serial number boxes are the stock lines' own,** with `mode="in"`: a lot number typed here becomes
  a batch when posted. The API asks for a lot only when something was accepted (decision 38).
- **An order line's errors show under the accepted quantity,** the box the person changes to fix them.
- **There is no "Add items":** every line comes from the order (decision 8). "Add what is left on the order" adds
  lines back after one was removed.
- **Save and Post are disabled until an order is picked,** and Post also needs a line.

### The goods receipt pages (new)

```tsx
import { type GoodsReceipt, isZeroQuantity } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PurchaseBackLink, SupplierLink } from './purchase-parts';
import { GoodsReceiptStatusPill } from './purchase-pills';
import { StockLinesTable } from './stock-lines-table';
import { useIsoDate, useQuantity, useWarehouses, warehouseLabel } from './stock-parts';

// A posted goods receipt (or a draft for someone who may not write receipts), read only, like a
// posted delivery. A posted receipt never changes: goods that go back to the supplier after it are
// a purchase return (17d).
export function GoodsReceiptView({ receipt }: { receipt: GoodsReceipt }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const { byId } = useWarehouses();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
      <PageHeader
        title={receipt.number ?? t('goodsReceipts.draftTitle')}
        description={receipt.supplier.name}
        actions={<GoodsReceiptStatusPill status={receipt.status} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('goodsReceipts.supplier')}</span>
          <span className="text-body-sm">
            <SupplierLink supplier={receipt.supplier} />
          </span>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('goodsReceipts.order')}</span>
          <Link
            to="/purchase-orders/$orderId"
            params={{ orderId: receipt.order.id }}
            className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
          >
            {receipt.order.number ?? t('purchaseOrders.statuses.draft')}
          </Link>
        </div>
        <Fact label={t('goodsReceipts.date')} value={isoDate(receipt.date)} />
        <Fact
          label={t('goodsReceipts.warehouse')}
          value={warehouseLabel(byId.get(receipt.warehouseId))}
        />
        {receipt.supplierChallan !== null && (
          <Fact label={t('goodsReceipts.supplierChallan')} value={receipt.supplierChallan} />
        )}
        {receipt.vehicle !== null && (
          <Fact label={t('goodsReceipts.vehicle')} value={receipt.vehicle} />
        )}
        {receipt.postedAt !== null && (
          <Fact
            label={t('goodsReceipts.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('goodsReceipts.postedOn', { date: format.date(new Date(receipt.postedAt)) })}
          />
        )}
        {receipt.status === 'posted' && (
          <EntryLinks
            label={t('goodsReceipts.entry')}
            entries={receipt.entry ? [receipt.entry] : []}
            none={t('goodsReceipts.noEntry')}
          />
        )}
        {receipt.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('goodsReceipts.note')} value={receipt.note} />
          </div>
        )}
      </Card>
      {/* The quantity is what was accepted (decision 20); what the gate turned back, and why,
          is under the line, in the line's unit */}
      <StockLinesTable
        lines={receipt.lines}
        detail={(line) =>
          isZeroQuantity(line.rejectedQuantity) ? null : (
            <span className="mt-1 block text-caption text-ink-3 tabular-nums">
              {t('goodsReceipts.rejected')}: {quantity(line.rejectedQuantity, line.unitId)}
              {line.rejectionReason !== null && ` · ${line.rejectionReason}`}
            </span>
          )
        }
      />
    </div>
  );
}
```

A posted receipt, or a draft for someone who may not write receipts, read only like a posted delivery. The journal
entry is a link for people who read the journal (`EntryLinks`), and a receipt that accepted nothing of value says it
has no entry. Under each line, what was rejected and why, in the line's own unit (decision 49).

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { goodsReceiptQuery, purchaseOrderQuery, unitsQuery } from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own (the
// delivery's pattern)
const GoodsReceiptForm = lazy(async () => ({
  default: (await import('../components/goods-receipt-form')).GoodsReceiptForm,
}));
const GoodsReceiptView = lazy(async () => ({
  default: (await import('../components/goods-receipt-view')).GoodsReceiptView,
}));

function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('goodsReceipts.title')} description={message} />
    </div>
  );
}

// A new goods receipt; "Receive goods" on an order comes here with ?orderId=
export function NewGoodsReceiptPage() {
  const { t } = useLocale();
  const canWrite = useCan()('purchase.receipt.manage');
  const today = useToday();
  const ready = useReady();
  const { orderId = '' } = useSearch({ strict: false });
  const { data: order, isError } = useQuery({
    ...purchaseOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
        <p className="text-body-sm text-ink-3">{t('goodsReceipts.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('purchaseOrders.notFound')} />;
  if (!ready || (orderId !== '' && !order)) return null;
  return (
    <Suspense fallback={null}>
      <GoodsReceiptForm receipt={null} order={order ?? null} today={today} />
    </Suspense>
  );
}

export function GoodsReceiptPage() {
  const { t } = useLocale();
  const { receiptId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.receipt.manage');
  const today = useToday();
  const ready = useReady();
  const { data: receipt, isError } = useQuery({
    ...goodsReceiptQuery(useTenantId(), receiptId),
    enabled: receiptId !== '',
  });

  if (isError) return <CantFind message={t('goodsReceipts.notFound')} />;
  if (!receipt || !ready) return null;
  if (receipt.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <GoodsReceiptForm
          key={`${receipt.id}-${String(receipt.version)}`}
          receipt={receipt}
          order={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <GoodsReceiptView receipt={receipt} />
    </Suspense>
  );
}
```

The page loads the data and picks the form or the view, like the delivery's. "Receive goods" comes with
`?orderId=`; the page waits for that order before it draws the form, so the form starts with its lines.

```tsx
import { PackageReceiveIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type GoodsReceiptSummary,
  STOCK_DOCUMENT_STATUSES,
  type StockDocumentStatus,
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

import { SupplierFilter } from '../components/purchase-parts';
import { GoodsReceiptStatusPill } from '../components/purchase-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { goodsReceiptsQuery } from '../lib/queries';

const column = dataTableColumns<GoodsReceiptSummary>();

// The goods receipts (step 17b), newest date first. Everyone reads them, like every stock
// document; writing and posting them needs purchase.receipt.manage (the store keeper at the gate).
export function GoodsReceiptsPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.receipt.manage');
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const [status, setStatus] = useState<StockDocumentStatus | ''>('');
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    goodsReceiptsQuery(useTenantId(), { status, warehouseId, supplierId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('goodsReceipts.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A draft has its number when it is posted */}
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('goodsReceipts.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((receipt) => receipt.supplier.name, {
          id: 'supplier',
          header: t('goodsReceipts.columns.supplier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.supplier.name}</span>
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.supplier.code}
              </span>
            </span>
          ),
        }),
        column.accessor('order', {
          header: t('goodsReceipts.columns.order'),
          enableSorting: false,
          meta: { card: 'detail' },
          // An order a receipt is made from was approved, so it has its number
          cell: ({ getValue }) => (
            <span className="font-mono tabular-nums">{getValue().number}</span>
          ),
        }),
        column.accessor('warehouseId', {
          header: t('goodsReceipts.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('lineCount', {
          header: t('goodsReceipts.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('purchaseLines.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('goodsReceipts.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <GoodsReceiptStatusPill status={getValue()} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  const newButton = canWrite && (
    <Button onClick={() => void navigate({ to: '/goods-receipts/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('goodsReceipts.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('goodsReceipts.title')}
        description={t('goodsReceipts.description')}
        actions={newButton}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="goods-receipts-supplier"
            aria-label={t('goodsReceipts.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('goodsReceipts.warehouse')}
            options={[
              { value: '', label: t('purchaseOrders.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('goodsReceipts.show')}
          value={status}
          options={[
            { value: '', label: t('goodsReceipts.all') },
            ...STOCK_DOCUMENT_STATUSES.map((value) => ({
              value,
              label: t(`goodsReceipts.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('goodsReceipts.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('goodsReceipts.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/goods-receipts/$receiptId', params: { receiptId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={PackageReceiveIcon}
              title={t('goodsReceipts.emptyTitle')}
              description={t('goodsReceipts.emptyBody')}
              action={newButton}
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

The list, newest first, with the supplier filter, the warehouse and the two statuses. An order a receipt is made
from was approved, so it always has a number; the column shows it without a fallback.

### Requisitions learn what was ordered

```diff
@@ -29,8 +29,9 @@ import { useQuantity, useTenantId, useUnitCode, VariantCell } from './stock-part
 
 // The lines of a requisition (step 17a): item, unit, quantity, estimated cost. Like the sales line
 // editor, the form holds the lines as one controlled value (a Controller on "lines"), and this
-// editor changes that array; 17b's purchase order adds its price, discount and VAT here. A lazy
-// chunk of its own: it brings decimal.js with the money box, and the product picker.
+// editor changes that array. 17b's purchase order is priced like a sales line, so it uses the sales
+// editor instead (purchase-order-lines.tsx). A lazy chunk of its own: it brings decimal.js with the
+// money box, and the product picker.
 
 export type PurchaseLinesErrors = FieldErrors<{ lines: RequisitionLineFormValues[] }>['lines'];
 
@@ -284,11 +285,15 @@ export function PurchaseLinesEditor({
                   update(index, { estimatedCost: value });
                 }}
               />
+              {/* Step 17b: the lookup starts from the last price paid (a requisition has no
+                  supplier, so never "this supplier's"), else the average cost */}
               {lineMeta.source !== undefined && (
                 <span className="text-right text-caption text-ink-3">
-                  {lineMeta.source === 'average_cost'
-                    ? t('purchaseLines.fromAverage')
-                    : t('purchaseLines.noCost')}
+                  {lineMeta.source === 'last_price'
+                    ? t('purchaseLines.fromLastPrice')
+                    : lineMeta.source === 'average_cost'
+                      ? t('purchaseLines.fromAverage')
+                      : t('purchaseLines.noCost')}
                 </span>
               )}
             </LineField>
```

The requisition's cost now starts from the last price paid (decision 19), so the note under the box can say so.
A requisition has no supplier, so it is never "this supplier's last price".

```diff
@@ -3,6 +3,7 @@ import {
   Delete02Icon,
   PencilEdit02Icon,
   SentIcon,
+  ShoppingCart01Icon,
   Wrench01Icon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
@@ -20,29 +21,34 @@ import {
   toast,
 } from '@omnivo/ui';
 import { useMutation, useQueryClient } from '@tanstack/react-query';
-import { useNavigate } from '@tanstack/react-router';
+import { Link, useNavigate } from '@tanstack/react-router';
 import { useState } from 'react';
 
 import { call } from '../lib/api';
 import { useCan } from '../lib/permissions';
+import { leftToOrder } from '../lib/purchase';
 import { requisitionQuery } from '../lib/queries';
 import { variantName } from '../lib/stock';
 import { Fact } from './adjustment-view';
 import { ApprovalCard } from './approval-card';
 import { failureOf } from './journal-parts';
 import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
-import { RequisitionStatusPill } from './purchase-pills';
-import { DocumentNotice } from './sales-parts';
+import { RequisitionOrderPill, RequisitionStatusPill } from './purchase-pills';
+import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
 import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';
 
-// What the view asks before it acts: both change who may do what next, so neither is one click
-type Asking = 'reopen' | 'cancel';
+// What the view asks before it acts: each changes who may do what next, so none is one click.
+// Step 17b: close, once orders buy for it.
+type Asking = 'reopen' | 'cancel' | 'close';
 
-// The lines as they were saved: a real <table> in a card, scrolling inside its own box on a phone
+// The lines as they were saved: a real <table> in a card, scrolling inside its own box on a phone.
+// Step 17b: once approved, how much purchase orders cover and what is left, in the base unit (the
+// unit orders count in: one may buy cones for a line asked in bags).
 function LinesTable({ requisition }: { requisition: Requisition }) {
   const { t, format } = useLocale();
   const quantity = useQuantity();
   const money = (value: string) => format.money(value, { decimals: 2 });
+  const ordering = requisition.status === 'approved' || requisition.status === 'closed';
   return (
     <Card className="overflow-hidden">
       <div className="overflow-x-auto">
@@ -62,6 +68,11 @@ function LinesTable({ requisition }: { requisition: Requisition }) {
               <th scope="col" className="px-5 py-2.5 text-right">
                 {t('purchaseLines.amount')}
               </th>
+              {ordering && (
+                <th scope="col" className="px-5 py-2.5 text-right">
+                  {t('requisitions.ordered')}
+                </th>
+              )}
             </tr>
           </thead>
           <tbody>
@@ -102,6 +113,15 @@ function LinesTable({ requisition }: { requisition: Requisition }) {
                 <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                   {money(line.amount)}
                 </td>
+                {ordering && (
+                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
+                    {quantity(line.orderedQuantity, line.baseUnitId)}
+                    <span className="block text-caption text-ink-3">
+                      {t('requisitions.leftToOrder')}:{' '}
+                      {quantity(leftToOrder(line), line.baseUnitId)}
+                    </span>
+                  </td>
+                )}
               </tr>
             ))}
           </tbody>
@@ -131,13 +151,19 @@ export function RequisitionView({
   const isoDate = useIsoDate();
   const refresh = usePurchaseRefresh();
   const { byId } = useWarehouses();
-  const canWrite = useCan()('purchase.requisition.manage');
+  const can = useCan();
+  const canWrite = can('purchase.requisition.manage');
+  // Step 17b: "Make purchase order" is the buyer's
+  const canOrder = can('purchase.order.manage');
   const [asking, setAsking] = useState<Asking | null>(null);
   const [confirmingDelete, setConfirmingDelete] = useState(false);
   const { id, number, status, version, approval } = requisition;
   const [round] = approval.rounds;
   // Never submitted: it may be deleted. Once a round exists, its history stays (decision 19).
   const neverSubmitted = approval.rounds.length === 0;
+  // Step 17b: an order that is not cancelled buys for it, even a draft (decision 27). It is then
+  // closed, never reopened or cancelled (decision 17).
+  const held = requisition.orders.length > 0;
   // The step that sent it back, when the newest round was rejected: its comment says what to change
   const rejection =
     status === 'draft' && round?.status === 'rejected'
@@ -170,9 +196,8 @@ export function RequisitionView({
     onSuccess: async (saved, action) => {
       setAsking(null);
       await settle(saved);
-      toast(
-        t(action === 'reopen' ? 'requisitions.reopened' : 'requisitions.cancelled', { number }),
-      );
+      const done = { reopen: 'reopened', cancel: 'cancelled', close: 'closed' } as const;
+      toast(t(`requisitions.${done[action]}`, { number }));
     },
   });
   const remove = useMutation({
@@ -195,7 +220,12 @@ export function RequisitionView({
       <PageHeader
         title={number}
         description={warehouseLabel(byId.get(requisition.warehouseId))}
-        actions={<RequisitionStatusPill status={status} />}
+        actions={
+          <span className="inline-flex flex-wrap gap-1.5">
+            <RequisitionStatusPill status={status} />
+            <RequisitionOrderPill state={requisition.orderState} />
+          </span>
+        }
       />
       {failure && <FormAlert message={failure} />}
       {rejection && (
@@ -207,7 +237,9 @@ export function RequisitionView({
         </DocumentNotice>
       )}
       {status !== 'draft' && (
-        <DocumentNotice tone="neutral">{t(`requisitions.notices.${status}`)}</DocumentNotice>
+        <DocumentNotice tone="neutral">
+          {t(`requisitions.notices.${status === 'approved' && held ? 'ordered' : status}`)}
+        </DocumentNotice>
       )}
       <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-4">
         <Fact label={t('requisitions.date')} value={isoDate(requisition.date)} />
@@ -237,6 +269,28 @@ export function RequisitionView({
         draft={status === 'draft'}
         approval={approval}
       />
+      {(status === 'approved' || status === 'closed') && (
+        <LinkList
+          title={t('requisitions.ordersTitle')}
+          subtitle={t('requisitions.ordersSubtitle')}
+          empty={held ? undefined : t('requisitions.noOrders')}
+        >
+          {requisition.orders.map((order) => (
+            <li key={order.id}>
+              <Link
+                to="/purchase-orders/$orderId"
+                params={{ orderId: order.id }}
+                className={LINK_ROW}
+              >
+                {/* A draft nobody submitted has no number yet */}
+                <span className={LINK_NUMBER}>
+                  {order.number ?? t('purchaseOrders.statuses.draft')}
+                </span>
+              </Link>
+            </li>
+          ))}
+        </LinkList>
+      )}
 
       {canWrite && status === 'draft' && (
         <div className="grid grid-cols-1 gap-2">
@@ -290,30 +344,59 @@ export function RequisitionView({
           <p className="text-right text-label text-ink-3">{t('requisitions.submitHint')}</p>
         </div>
       )}
-      {canWrite && (status === 'pending' || status === 'approved') && (
+      {canWrite && status === 'pending' && (
+        <div className="flex justify-end">
+          <Button
+            variant="secondary"
+            disabled={busy}
+            onClick={() => {
+              setAsking('reopen');
+            }}
+          >
+            {t('requisitions.reopen')}
+          </Button>
+        </div>
+      )}
+      {status === 'approved' && (canWrite || canOrder) && (
         <div className="flex flex-wrap items-center justify-end gap-2">
-          {/* A pending requisition is reopened first; an approved one may be cancelled at once */}
-          {status === 'approved' && (
+          {/* An approved requisition may be cancelled at once, until an order buys for it; then
+              the rest is closed (decision 17) */}
+          {canWrite && (
             <Button
               variant="secondary"
               className="mr-auto"
               disabled={busy}
               onClick={() => {
-                setAsking('cancel');
+                setAsking(held ? 'close' : 'cancel');
               }}
             >
-              {t('requisitions.cancel')}
+              {held ? t('requisitions.close') : t('requisitions.cancel')}
+            </Button>
+          )}
+          {canWrite && !held && (
+            <Button
+              variant="secondary"
+              disabled={busy}
+              onClick={() => {
+                setAsking('reopen');
+              }}
+            >
+              {t('requisitions.reopen')}
+            </Button>
+          )}
+          {/* Decision 18: the order form opens with the lines still to order, narrowed to this
+              requisition */}
+          {canOrder && requisition.orderState !== 'ordered' && (
+            <Button
+              disabled={busy}
+              onClick={() =>
+                void navigate({ to: '/purchase-orders/new', search: { requisitionId: id } })
+              }
+            >
+              <HugeiconsIcon icon={ShoppingCart01Icon} size={17} strokeWidth={1.5} />
+              {t('requisitions.makeOrder')}
             </Button>
           )}
-          <Button
-            variant="secondary"
-            disabled={busy}
-            onClick={() => {
-              setAsking('reopen');
-            }}
-          >
-            {t('requisitions.reopen')}
-          </Button>
         </div>
       )}
 
@@ -331,7 +414,7 @@ export function RequisitionView({
               <>
                 <DialogClose asChild>
                   <Button variant="secondary">
-                    {asking === 'cancel' ? t('requisitions.keep') : t('common.cancel')}
+                    {asking === 'reopen' ? t('common.cancel') : t('requisitions.keep')}
                   </Button>
                 </DialogClose>
                 <Button
```

- **`held` is "an order that is not cancelled buys for it"** (decision 27), from the requisition's `orders`. Then it
  is closed, never reopened or cancelled (decision 17): the Cancel button becomes "Close requisition", Reopen is
  gone, and the notice says why.
- **The lines table gets an Ordered column once approved,** with what is left to order under it, in the base unit
  (orders may buy in another unit).
- **The order pill sits next to the status,** like the list.
- **"Make purchase order" is the buyer's button** (`purchase.order.manage`), shown until everything is ordered. It
  opens the order form with this requisition's lines still to order (decision 45).
- **The orders card lists the orders that buy for it,** a draft as "Draft" because it has no number yet.
- **Pending and approved are now two button rows:** pending can only be reopened, approved has the rest. The
  dialog's keep button says "Keep it" for Close and Cancel.

```diff
@@ -1,7 +1,9 @@
 import { PlusSignIcon, TaskAdd01Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
+  REQUISITION_ORDER_FILTERS,
   REQUISITION_STATUSES,
+  type RequisitionOrderFilter,
   type RequisitionStatus,
   type RequisitionSummary,
 } from '@omnivo/contracts';
@@ -19,14 +21,20 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { RequisitionStatusPill } from '../components/purchase-pills';
+import { RequisitionOrderPill, RequisitionStatusPill } from '../components/purchase-pills';
 import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
 import { requisitionsQuery } from '../lib/queries';
 
 const column = dataTableColumns<RequisitionSummary>();
 
-type Show = RequisitionStatus | 'all';
+// Step 17b: "To order" sits with the statuses: it is a kind of approved requisition, the buyer's
+// queue (approved, with a line not ordered in full)
+type Show = RequisitionStatus | RequisitionOrderFilter | 'all';
+
+function isOrderFilter(show: Show): show is RequisitionOrderFilter {
+  return REQUISITION_ORDER_FILTERS.some((filter) => filter === show);
+}
 
 // The purchase requisitions (step 17a), newest date first. Everyone reads them (a store keeper
 // checks whether the yarn was asked for already); writing them needs purchase.requisition.manage.
@@ -39,7 +47,11 @@ export function RequisitionsPage() {
   const [show, setShow] = useState<Show>('all');
   const [warehouseId, setWarehouseId] = useState('');
   const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
-    requisitionsQuery(useTenantId(), { status: show === 'all' ? '' : show, warehouseId }),
+    requisitionsQuery(useTenantId(), {
+      status: show === 'all' || isOrderFilter(show) ? '' : show,
+      warehouseId,
+      order: isOrderFilter(show) ? show : '',
+    }),
   );
   const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
   const loadMore = useCallback(() => {
@@ -94,7 +106,13 @@ export function RequisitionsPage() {
           header: t('requisitions.columns.status'),
           enableSorting: false,
           meta: { card: 'trailing' },
-          cell: ({ getValue }) => <RequisitionStatusPill status={getValue()} />,
+          // Step 17b: how much is ordered, beside the status
+          cell: ({ row }) => (
+            <span className="inline-flex flex-wrap gap-1.5">
+              <RequisitionStatusPill status={row.original.status} />
+              <RequisitionOrderPill state={row.original.orderState} />
+            </span>
+          ),
         }),
       ]),
     [t, format, isoDate, byId],
@@ -137,6 +155,10 @@ export function RequisitionsPage() {
               value,
               label: t(`requisitions.statuses.${value}`),
             })),
+            ...REQUISITION_ORDER_FILTERS.map((value) => ({
+              value,
+              label: t(`requisitions.orderFilters.${value}`),
+            })),
           ]}
           onChange={setShow}
         />
```

"To order" sits with the statuses (decision 47). `isOrderFilter` is a type guard, so the one `show` value is split
into the contract's two query fields without a cast.

### What is coming, and where it came from

```diff
@@ -133,6 +133,21 @@ export function StockPage() {
               </span>
             ),
         }),
+        // Step 17b: what approved purchase orders still have to bring here (decision 23), so a
+        // buyer does not order the same yarn twice. Not on hand until a goods receipt is posted.
+        column.accessor('incoming', {
+          header: t('stock.columns.incoming'),
+          enableSorting: false,
+          meta: { align: 'end', card: 'detail' },
+          cell: ({ row }) =>
+            isZeroQuantity(row.original.incoming) ? (
+              <span className="text-ink-3">—</span>
+            ) : (
+              <span className="tabular-nums">
+                {quantity(row.original.incoming, row.original.baseUnitId)}
+              </span>
+            ),
+        }),
         // Step 15b: what confirmed orders still have to deliver from here. Next to "On hand",
         // not taken off it: nothing is held for an order (the hint above the table says so).
         column.accessor('onOrder', {
@@ -267,8 +282,13 @@ export function StockPage() {
         />
       </div>
       {isError && <p className="text-body-sm text-crit">{t('stock.loadFailed')}</p>}
-      <p className="text-caption text-ink-3">
-        {t('stock.columns.onOrder')}: {t('stock.onOrderHint')}
+      <p className="grid gap-0.5 text-caption text-ink-3">
+        <span>
+          {t('stock.columns.incoming')}: {t('stock.incomingHint')}
+        </span>
+        <span>
+          {t('stock.columns.onOrder')}: {t('stock.onOrderHint')}
+        </span>
       </p>
       {items && (
         <DataTable
```

```diff
@@ -67,6 +67,17 @@ export function StockReorderPage() {
               ? '—'
               : quantity(row.original.inTransit, row.original.baseUnitId),
         }),
+        // Step 17b: what approved purchase orders still have to bring (decision 23): an item
+        // under its level with an order on the way needs no second order
+        column.accessor('incoming', {
+          header: t('reorder.columns.incoming'),
+          enableSorting: false,
+          meta: { align: 'end', card: 'detail' },
+          cell: ({ row }) =>
+            isZeroQuantity(row.original.incoming)
+              ? '—'
+              : quantity(row.original.incoming, row.original.baseUnitId),
+        }),
         column.accessor('minQuantity', {
           header: t('reorder.columns.level'),
           enableSorting: false,
```

"Incoming" (decision 23) sits between In transit and On order on the stock page, and after In transit on the reorder
report: an item under its level with an order on the way needs no second order. The hint above the stock table says
it is not on hand yet.

```diff
@@ -106,6 +106,7 @@ export function documentRoute(
   | '/stock/revaluations/$revaluationId'
   | '/deliveries/$deliveryId'
   | '/sales-returns/$returnId'
+  | '/goods-receipts/$receiptId'
   | null {
   if (kind === 'adjustment') return '/stock/adjustments/$adjustmentId';
   if (kind === 'transfer_out' || kind === 'transfer_in') return '/stock/transfers/$transferId';
@@ -115,6 +116,8 @@ export function documentRoute(
   if (kind === 'delivery') return '/deliveries/$deliveryId';
   // Step 15d: goods a customer sent back, on a sales return
   if (kind === 'sales_return') return '/sales-returns/$returnId';
+  // Step 17b: goods a supplier's truck brought in, on a goods receipt
+  if (kind === 'purchase_receipt') return '/goods-receipts/$receiptId';
   return null;
 }
 
```

```diff
@@ -421,6 +421,8 @@ export function StockCardPage() {
                 void navigate({ to: route, params: { deliveryId: movement.documentId } });
               } else if (route === '/sales-returns/$returnId') {
                 void navigate({ to: route, params: { returnId: movement.documentId } });
+              } else if (route === '/goods-receipts/$receiptId') {
+                void navigate({ to: route, params: { receiptId: movement.documentId } });
               }
             }}
             onEndReached={loadMore}
```

```diff
@@ -108,7 +108,8 @@ function ReverseForm({
 }
 
 // The document a stock entry came from (step 14), a delivery's (15b), an invoice's or a money
-// receipt's (15c), or a return's, a credit note's or a refund's (15d): its page, by the source
+// receipt's (15c), a return's, a credit note's or a refund's (15d), or a goods receipt's (17b): its
+// page, by the source
 function documentLinkOf(entry: JournalEntry) {
   const id = entry.document?.id;
   if (id === undefined) return null;
@@ -143,6 +144,10 @@ function documentLinkOf(entry: JournalEntry) {
   if (entry.source === 'sales_refund') {
     return { to: '/refunds/$refundId', params: { refundId: id } } as const;
   }
+  // Step 17b: the goods a receipt brought in, owed until the supplier's bill
+  if (entry.source === 'purchase_receipt') {
+    return { to: '/goods-receipts/$receiptId', params: { receiptId: id } } as const;
+  }
   return null;
 }
 
```

A goods receipt's stock movement opens the receipt from the stock card, and its journal entry links back to it
("From GRN-2026-27-0001"). The entry is a stock entry, so the page already says it is corrected by another stock
document, not reversed.

### Approvals, the bell, the navigation and the router

```diff
@@ -29,11 +29,13 @@ export function ApprovalsPage() {
   }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
 
   // One navigate() per kind: each path has its own parameter name, and TanStack checks each pair
-  // against the router. 17b adds the purchase order here.
+  // against the router. Step 17b: the purchase order.
   const open = useCallback(
     (row: WaitingApproval) => {
       if (row.document === 'requisition') {
         void navigate({ to: '/requisitions/$requisitionId', params: { requisitionId: row.id } });
+      } else if (row.document === 'purchase_order') {
+        void navigate({ to: '/purchase-orders/$orderId', params: { orderId: row.id } });
       }
     },
     [navigate],
```

"Waiting for me" opens a purchase order's page.

```diff
@@ -52,26 +52,28 @@ const TARGET = {
 // A document's page from the notification's kind and id. The list of that kind when the id is
 // missing or not a document's (an older notification); the dashboard for a kind this app does
 // not know. One navigate() per kind: each path has its own parameter name, and TanStack checks
-// each pair against the router. Step 17a: the kinds that need an approval too (17b adds the
-// purchase order).
+// each pair against the router. Step 17a: the kinds that need an approval too. Step 17b: a purchase
+// order is both (its approval, and its failed email), so the two lists are one switch.
 function useOpenDocument(): (params: NotificationParams) => Promise<void> {
   const navigate = useNavigate();
   return async (params) => {
     const { document: kind, id } = params;
     const known = typeof id === 'string' && id !== '';
-    // A requisition is the only kind now; 17b's purchase order makes this a switch like the one
-    // below (a one-case switch fails the lint rule against conditions that are always true)
-    if (typeof kind === 'string' && isApprovalDocument(kind)) {
-      await (known
-        ? navigate({ to: '/requisitions/$requisitionId', params: { requisitionId: id } })
-        : navigate({ to: '/requisitions' }));
-      return;
-    }
-    if (typeof kind !== 'string' || !isOutputDocument(kind)) {
+    if (typeof kind !== 'string' || !(isOutputDocument(kind) || isApprovalDocument(kind))) {
       await navigate({ to: '/' });
       return;
     }
     switch (kind) {
+      case 'requisition':
+        await (known
+          ? navigate({ to: '/requisitions/$requisitionId', params: { requisitionId: id } })
+          : navigate({ to: '/requisitions' }));
+        return;
+      case 'purchase_order':
+        await (known
+          ? navigate({ to: '/purchase-orders/$orderId', params: { orderId: id } })
+          : navigate({ to: '/purchase-orders' }));
+        return;
       case 'quotation':
         await (known
           ? navigate({ to: '/quotations/$quotationId', params: { quotationId: id } })
```

A purchase order is both an approval document (waiting, approved, sent back) and an output document (an email that
failed), so the two lists are one `switch` now. The type guards narrow `kind` to the union of both lists, and every
case navigates with its own route and parameter name.

```diff
@@ -28,10 +28,12 @@ import {
   Notebook02Icon,
   PackageIcon,
   PackageOutOfStockIcon,
+  PackageReceiveIcon,
   PieChartIcon,
   RulerIcon,
   SecurityCheckIcon,
   Settings02Icon,
+  ShoppingBasket01Icon,
   ShoppingCart01Icon,
   Store01Icon,
   TableIcon,
@@ -359,6 +361,13 @@ export function AppShell() {
             <NavLink to="/requisitions" icon={TaskAdd01Icon}>
               {t('nav.requisitions')}
             </NavLink>
+            {/* Step 17b: the documents in the order they happen, like the Sales group */}
+            <NavLink to="/purchase-orders" icon={ShoppingBasket01Icon}>
+              {t('nav.purchaseOrders')}
+            </NavLink>
+            <NavLink to="/goods-receipts" icon={PackageReceiveIcon}>
+              {t('nav.goodsReceipts')}
+            </NavLink>
             <NavLink
               to="/approvals"
               icon={CheckmarkBadge01Icon}
```

Purchase orders and goods receipts sit after Requisitions, in the order the work happens. Everyone reads them, so
they need no permission. The order uses a basket icon: the cart is already the sales order's.

```diff
@@ -641,6 +641,52 @@ const approvalsRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/approvals'), 'ApprovalsPage'),
 });
 
+// Step 17b: purchase orders ("Make purchase order" on a requisition comes with ?requisitionId=) and
+// goods receipts ("Receive goods" on an order comes with ?orderId=). '/…/new' beats '/…/$id'.
+const purchaseOrdersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/purchase-orders',
+  component: lazyRouteComponent(() => import('./routes/purchase-orders'), 'PurchaseOrdersPage'),
+});
+
+const newPurchaseOrderRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/purchase-orders/new',
+  validateSearch: (search: Record<string, unknown>): { requisitionId?: string } => ({
+    ...(typeof search.requisitionId === 'string' &&
+      UUID.test(search.requisitionId) && { requisitionId: search.requisitionId }),
+  }),
+  component: lazyRouteComponent(() => import('./routes/purchase-order'), 'NewPurchaseOrderPage'),
+});
+
+const purchaseOrderRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/purchase-orders/$orderId',
+  component: lazyRouteComponent(() => import('./routes/purchase-order'), 'PurchaseOrderPage'),
+});
+
+const goodsReceiptsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/goods-receipts',
+  component: lazyRouteComponent(() => import('./routes/goods-receipts'), 'GoodsReceiptsPage'),
+});
+
+const newGoodsReceiptRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/goods-receipts/new',
+  validateSearch: (search: Record<string, unknown>): { orderId?: string } => ({
+    ...(typeof search.orderId === 'string' &&
+      UUID.test(search.orderId) && { orderId: search.orderId }),
+  }),
+  component: lazyRouteComponent(() => import('./routes/goods-receipt'), 'NewGoodsReceiptPage'),
+});
+
+const goodsReceiptRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/goods-receipts/$receiptId',
+  component: lazyRouteComponent(() => import('./routes/goods-receipt'), 'GoodsReceiptPage'),
+});
+
 const customFieldsRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/custom-fields',
@@ -767,6 +813,12 @@ const routeTree = rootRoute.addChildren([
     newRequisitionRoute,
     requisitionRoute,
     approvalsRoute,
+    purchaseOrdersRoute,
+    newPurchaseOrderRoute,
+    purchaseOrderRoute,
+    goodsReceiptsRoute,
+    newGoodsReceiptRoute,
+    goodsReceiptRoute,
     customFieldsRoute,
     teamRoute,
     rolesRoute,
```

The six new routes. `/…/new` beats `/…/$id`, like every document. The two `validateSearch` functions keep only a
real id, so a hand-typed `?orderId=x` opens an empty form instead of a failed request.

### Back under the budget: `vite.config.ts`

```diff
@@ -1,9 +1,27 @@
 import tailwindcss from '@tailwindcss/vite';
 import react from '@vitejs/plugin-react';
-import { defineConfig } from 'vite';
+import { defineConfig, type Plugin } from 'vite';
+
+// One route's summary in the built contracts, a whole line: `summary: 'Sales orders, newest date
+// first',` (a summary with an apostrophe is in double quotes). Never `summary: route.summary,`.
+const ROUTE_SUMMARY = /^[ \t]*summary: (?:'[^'\n]*'|"[^"\n]*"),\n/gm;
+
+// Step 17b: a route's summary is English for the OpenAPI document (contracts' gen-openapi and the
+// API's docs). The browser never reads it, and every page's chunk carried all 244 of them: 4 KB gz
+// of each page's 100 KB budget, growing with every step's routes. The built contracts lose them
+// here, in the app's bundle only. The type still says `summary: string`; no app code may read it.
+function dropRouteSummaries(): Plugin {
+  return {
+    name: 'omnivo:drop-route-summaries',
+    transform(code, id) {
+      if (!id.includes('/packages/contracts/dist/')) return null;
+      return { code: code.replace(ROUTE_SUMMARY, ''), map: null };
+    },
+  };
+}
 
 export default defineConfig({
-  plugins: [react(), tailwindcss()],
+  plugins: [react(), tailwindcss(), dropRouteSummaries()],
   server: { port: 5173, strictPort: true },
   // dist/.vite/manifest.json: কোন chunk কোন chunk-কে import করে — bundle-size চেক এটা পড়ে
   build: { manifest: true },
```

17b's contracts took seven pages over their 100 KB budget (the team page to 101.6 KB), because every page loads the
contracts' routes, and the routes grew by 1.6 KB. Decision 50 explains the fix:

- **The regex matches one whole line,** `summary: '…',` or `summary: "…",` (Prettier writes a summary with an
  apostrophe in double quotes), and never `summary: route.summary,` in the OpenAPI script.
- **Only files under `packages/contracts/dist/`:** Vite resolves the workspace link to the real path, so this is
  the built contracts and nothing else.
- **`map: null`:** the plugin gives no source map. The build makes none, so nothing is lost.
- **What it gives back:** every page is 4 KB smaller. The biggest page is now the team page at 97.5 KB, and the
  first load is 196.2 KB.

### The unit tests

```diff
@@ -1,10 +1,21 @@
-import type { ApprovalRound, ApprovalStep, RequisitionLine } from '@omnivo/contracts';
+import type {
+  ApprovalRound,
+  ApprovalStep,
+  PurchaseOrderLine,
+  RequisitionLine,
+} from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import {
+  allowedToReceive,
   approvedByOwnSubmit,
+  isOrderLate,
+  leftToOrder,
+  leftToReceive,
+  receiptFill,
   requisitionFormTotals,
   roundNumber,
+  startingPrice,
   stepState,
   toRequisitionFormLine,
 } from './purchase';
@@ -88,6 +99,7 @@ describe('toRequisitionFormLine', () => {
     description: '30s combed cotton yarn',
     estimatedCost: '7499.0000',
     amount: '14998.0000',
+    orderedQuantity: '0.0000',
   };
 
   it('shows the quantity as typed and an empty description when it is the product name', () => {
@@ -148,3 +160,150 @@ describe('roundNumber', () => {
     expect([0, 1, 2].map((index) => roundNumber(rounds, index))).toEqual([3, 2, 1]);
   });
 });
+
+// ---------------------------------------------------------------------------------------------
+// Step 17b
+
+describe('leftToOrder', () => {
+  const line = { baseQuantity: '480.0000', orderedQuantity: '0.0000' } as const;
+
+  it('is what the requisition asked for, less what orders cover, in the base unit', () => {
+    expect(leftToOrder({ ...requisitionLine(), ...line, orderedQuantity: '360.0000' })).toBe(
+      '120.0000',
+    );
+  });
+
+  it('is never less than nothing: a mill’s minimum order may order more (decision 16)', () => {
+    expect(leftToOrder({ ...requisitionLine(), ...line, orderedQuantity: '500.0000' })).toBe(
+      '0.0000',
+    );
+  });
+});
+
+describe('isOrderLate', () => {
+  it('is late only when approved and past its delivery date', () => {
+    const order = { status: 'approved', expectedDate: '2026-10-15' };
+    expect(isOrderLate(order, '2026-10-16')).toBe(true);
+    expect(isOrderLate(order, '2026-10-15')).toBe(false);
+    expect(isOrderLate({ ...order, status: 'received' }, '2026-10-16')).toBe(false);
+    expect(isOrderLate({ ...order, expectedDate: null }, '2026-10-16')).toBe(false);
+  });
+});
+
+describe('leftToReceive and allowedToReceive', () => {
+  it('leaves what was rejected to come: the supplier still owes it', () => {
+    const line = orderLine({ receivedQuantity: '600.0000', rejectedQuantity: '50.0000' });
+    expect(leftToReceive(line)).toBe('400.0000');
+  });
+
+  it('lets in the workspace’s percent more, rounded down like the API (decision 22)', () => {
+    const line = orderLine({ receivedQuantity: '600.0000' });
+    // 1,000 m at 3% = 1,030 m in all, 600 m came already
+    expect(allowedToReceive(line, '3.00')).toBe('430.0000');
+    expect(allowedToReceive(line, '0.00')).toBe('400.0000');
+    expect(allowedToReceive(orderLine({ receivedQuantity: '1040.0000' }), '3.00')).toBe('0.0000');
+  });
+
+  it('never asks a service line for goods (decision 29)', () => {
+    const service = orderLine({ productType: 'service' });
+    expect(leftToReceive(service)).toBe('0.0000');
+    expect(allowedToReceive(service, '10')).toBe('0.0000');
+  });
+});
+
+describe('receiptFill', () => {
+  it('keeps the order’s unit for an untouched line, and asks for the rest in the base unit', () => {
+    const bags = orderLine({
+      id: 'bags',
+      unitId: 'bag',
+      quantity: '40.0000',
+      baseQuantity: '1000.0000',
+    });
+    const started = orderLine({ id: 'started', receivedQuantity: '600.0000' });
+    const service = orderLine({ id: 'dyeing', productType: 'service' });
+    expect(receiptFill([bags, started, service], new Map())).toEqual([
+      { orderLineId: 'bags', variantId: 'fabric', unitId: 'bag', quantity: '40' },
+      { orderLineId: 'started', variantId: 'fabric', unitId: 'm', quantity: '400' },
+    ]);
+  });
+
+  it('adds only what the form does not hold yet', () => {
+    const line = orderLine({ id: 'fabric-line' });
+    expect(receiptFill([line], new Map([['fabric-line', '250']]))).toEqual([
+      { orderLineId: 'fabric-line', variantId: 'fabric', unitId: 'm', quantity: '750' },
+    ]);
+    expect(receiptFill([line], new Map([['fabric-line', '1000']]))).toEqual([]);
+  });
+});
+
+describe('startingPrice', () => {
+  it('is the net when the order’s prices are before VAT', () => {
+    expect(startingPrice('312.5000', '15.00', false)).toBe('312.5000');
+  });
+
+  it('adds the VAT, to the paisa, when the order’s prices include it', () => {
+    // 312.50 + 15% (46.875 → 46.88)
+    expect(startingPrice('312.5000', '15.00', true)).toBe('359.3800');
+  });
+
+  it('stays empty when nothing is known, or the rate is not loaded', () => {
+    expect(startingPrice(null, '15.00', true)).toBeNull();
+    expect(startingPrice('312.5000', null, true)).toBe('312.5000');
+  });
+});
+
+// A requisition line with the fields the helpers do not read filled in
+function requisitionLine(): RequisitionLine {
+  return {
+    id: 'req-line',
+    variantId: 'yarn',
+    productId: 'p-yarn',
+    productCode: 'P-00031',
+    productName: '30s combed cotton yarn',
+    optionValues: [],
+    sku: 'P-00031',
+    baseUnitId: 'cone',
+    productType: 'goods',
+    units: [],
+    unitId: 'cone',
+    quantity: '480.0000',
+    baseQuantity: '480.0000',
+    description: '30s combed cotton yarn',
+    estimatedCost: '312.0000',
+    amount: '149760.0000',
+    orderedQuantity: '0.0000',
+  };
+}
+
+// An order line of 1,000 m of fabric, nothing received yet
+function orderLine(extra: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
+  return {
+    id: 'line-1',
+    variantId: 'fabric',
+    productId: 'p-fabric',
+    productCode: 'P-00102',
+    productName: 'Single jersey 180 GSM',
+    optionValues: [],
+    sku: 'P-00102',
+    baseUnitId: 'm',
+    productType: 'goods',
+    tracking: 'batch',
+    hasExpiry: false,
+    units: [{ unitId: 'bag', factor: '25.000000' }],
+    unitId: 'm',
+    quantity: '1000.0000',
+    baseQuantity: '1000.0000',
+    description: 'Single jersey 180 GSM',
+    unitPrice: '312.5000',
+    discountType: 'percent',
+    discount: '0.0000',
+    taxRate: { id: 'vat-15', name: 'VAT 15%', kind: 'standard', rate: '15.00' },
+    net: '312500.0000',
+    vat: '46875.0000',
+    total: '359375.0000',
+    requisitionLine: null,
+    receivedQuantity: '0.0000',
+    rejectedQuantity: '0.0000',
+    ...extra,
+  };
+}
```

- **`allowedToReceive` is tested at 3% and at 0%,** and past the limit: 1,040 m received of 1,000 m at 3% leaves
  nothing, never a negative number.
- **`receiptFill` is tested with a line in bags, a partly received line and a service line,** and with what the form
  already holds.
- **`startingPrice` is tested where the rounding matters:** 15% of ৳312.50 is ৳46.875, which rounds to ৳46.88.
- **The requisition line fixture gets `orderedQuantity`,** the contract's new field.

```diff
@@ -1,7 +1,13 @@
 import type { DocumentFile, DocumentShare } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
-import { languageName, otherLanguage, shareState, waitForPdf } from './document-output';
+import {
+  languageName,
+  otherLanguage,
+  recipientRole,
+  shareState,
+  waitForPdf,
+} from './document-output';
 
 function file(status: DocumentFile['status']): DocumentFile {
   return {
@@ -100,3 +106,11 @@ describe('languages', () => {
     expect(languageName('bn')).toBe('বাংলা');
   });
 });
+
+// Step 17b: the Send menu reads the recipient's language and phone from the right side
+describe('recipientRole', () => {
+  it('sends a purchase order to its supplier and every sales document to its customer', () => {
+    expect(recipientRole('purchase_order')).toBe('supplier');
+    expect(recipientRole('invoice')).toBe('customer');
+  });
+});
```

```diff
@@ -100,6 +100,7 @@ describe('stock helpers', () => {
     expect(documentRoute('revaluation')).toBe('/stock/revaluations/$revaluationId');
     expect(documentRoute('delivery')).toBe('/deliveries/$deliveryId');
     expect(documentRoute('sales_return')).toBe('/sales-returns/$returnId');
+    expect(documentRoute('purchase_receipt')).toBe('/goods-receipts/$receiptId');
     expect(documentRoute('sales_invoice')).toBeNull();
   });
 });
```

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app exec tsc --noEmit
pnpm --filter @omnivo/app test
pnpm lint
pnpm --filter @omnivo/app exec vite build
pnpm --filter @omnivo/app test:bundle-size
```

Build `@omnivo/i18n` first: the app reads its built `dist/`, and two words changed in this part (decision 46). The
type check prints the 22 errors in `src/mocks/` and none elsewhere; `pnpm --filter @omnivo/app typecheck` and
`build` pass after 17b.7. `vite build` builds without the type check, so the bundle can be measured now.

> **What we checked in this part.** The app type-checks outside `src/mocks/` (22 errors left there, for 17b.7),
> including its scripts and e2e projects. ESLint and Prettier are clean on the 50 changed files. The app's unit tests
> pass (108, 12 of them new), and the i18n package type-checks and passes its 11 tests. The bundle check passes:
> first load 196.2 KB gz, the biggest page is the team page at 97.5 KB (it was 101.6 KB before decision 50). We broke
> two things on purpose: removing `purchase_order` from `recipientRole`'s map failed the type check, and leaving the
> over-receipt percent out of `allowedToReceive` failed its unit test. Nothing in this part was clicked through in a
> browser yet: the mock API and the Playwright tests are 17b.7.

---

## 17b.7 — `apps/app`: the mock API and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). This part
teaches the mock every route of 17b, with the API's rules, shortened: purchase orders and their approval, goods
receipts and their posting, what a requisition knows about its orders, the last price, the over-receipt setting,
the goods on the way, the new stock account and the order's PDF, email and share link. Then one new test file
clicks through the screens of 17b.6 on a desktop and on a phone.

When this part starts, the app's type check has 22 errors, all in `src/mocks/`: the mock still sends the shapes of
17a. After this part it has none, and `pnpm --filter @omnivo/app build` passes again.

This was also the first time the 17b.6 screens ran in a browser. They worked as written, with one exception: on a
phone the purchase order list scrolled sideways. The cause was in a shared component, not in 17b's screens
(decision 54). Decisions 51–54, at the top of this guide, came up while building this part.

The files, in the order to write them: each one only uses files above it.

### The new account: `mocks/accounting-data.ts`

```diff
@@ -94,6 +94,8 @@ function template(industry: Industry): Record<AccountType, MockNode> {
           name: 'Current liabilities',
           children: [
             { code: '2110', name: 'Accounts payable', purpose: 'accounts_payable' },
+            // Step 17b: what goods receipts brought in and no bill has billed yet
+            { code: '2115', name: 'Goods received not billed' },
             { code: '2120', name: 'Output VAT', purpose: 'vat_output' },
             { code: '2130', name: 'VAT and tax deducted at source (VDS, TDS)' },
             { code: '2140', name: 'Salaries and wages payable' },
@@ -273,6 +275,7 @@ export function seedStockAccounts(accounts: readonly Account[], industry: Indust
     correction: id('5190'),
     transfer_shortage: loss,
     revaluation: id('5190'),
+    received_not_billed: id('2115'),
   };
 }
 
@@ -298,5 +301,6 @@ export function noStockAccounts(): StockAccounts {
     correction: null,
     transfer_shortage: null,
     revaluation: null,
+    received_not_billed: null,
   };
 }
```

- **The mock's chart gets 2115, "Goods received not billed",** next to the payable, like the API's templates
  (17b.3). Every fixture workspace starts with it, so a goods receipt can post from the first page load.
- **`seedStockAccounts()` points the new use at it** and `noStockAccounts()` leaves it empty. The contract's
  `StockAccounts` type has the new key since 17b.1, so both functions stop compiling until they name it: that is
  two of the 22 errors.
- **One older test changes because of it:** the onboarding wizard says how many accounts the chart has, and that
  is now 48 (see the end of this part).

### Only stock documents post to it: `mocks/journal-data.ts`

```diff
@@ -71,12 +71,14 @@ function linesProblem(
   );
 }
 
-// The inventory account and the goods in transit account: only stock documents post to them
-// (step 14, the API's stockAccountIds())
+// The inventory account, the goods in transit account and (step 17b) goods received not billed:
+// only stock documents post to them (step 14, the API's stockAccountIds())
 export function stockAccountIds(data: WorkspaceData): Set<string> {
   const inventory = data.accounts.find((account) => account.purpose === 'inventory')?.id;
   return new Set(
-    [inventory, data.stockAccounts.in_transit].filter((id): id is string => typeof id === 'string'),
+    [inventory, data.stockAccounts.in_transit, data.stockAccounts.received_not_billed].filter(
+      (id): id is string => typeof id === 'string',
+    ),
   );
 }
 
```

- **`stockAccountIds()` adds the new account,** like the API's (17b.3, decision 39). A manual journal line on 2115
  is then refused with `journal_account_stock`, in the mock too. Without it, a person could book "goods received
  not billed" by hand in `dev:mock`, and the account would no longer match the goods receipts behind it.

### The stock: `mocks/stock-data.ts`

```diff
@@ -273,6 +273,28 @@ function onOrder(data: WorkspaceData, variantId: string, warehouseId: string | u
   );
 }
 
+// What approved purchase orders still have to bring to the warehouse (or to any): ordered −
+// received, goods lines only, never below zero (step 17b, the API's incomingTo()). A pending order
+// is not counted: nobody agreed to it yet.
+function incoming(data: WorkspaceData, variantId: string, warehouseId: string | undefined): string {
+  return sumQuantity(
+    data.purchase.orders
+      .filter(
+        (order) =>
+          order.status === 'approved' &&
+          (warehouseId === undefined || order.warehouseId === warehouseId),
+      )
+      .flatMap((order) =>
+        order.lines
+          .filter((line) => line.variantId === variantId && line.productType === 'goods')
+          .map((line) => {
+            const left = subtractQuantity(line.baseQuantity, line.receivedQuantity);
+            return compareQuantity(left, '0') > 0 ? left : '0';
+          }),
+      ),
+  );
+}
+
 function isLow(
   stock: MockStock,
   balances: ReturnType<typeof balancesOf>,
@@ -319,6 +341,7 @@ function itemOf(
     onHand: onHand(stock, balances, variant.id, warehouseId),
     inTransit: inTransit(stock, variant.id, warehouseId),
     onOrder: onOrder(data, variant.id, warehouseId),
+    incoming: incoming(data, variant.id, warehouseId),
     low: isLow(stock, balances, variant.id, warehouseId),
     ...valueFields(stock, balances, variant.id, warehouseId),
   };
@@ -548,6 +571,7 @@ export function reorderReport(data: WorkspaceData, warehouseId: string | undefin
           warehouseId: level.warehouseId,
           onHand: here,
           inTransit: inTransit(data.stock, level.variantId, level.warehouseId),
+          incoming: incoming(data, level.variantId, level.warehouseId),
           minQuantity: level.minQuantity,
           reorderQuantity: level.reorderQuantity,
         },
@@ -862,7 +886,8 @@ export function branchOf(data: WorkspaceData, warehouseId: string): string | nul
   return data.stock.warehouses.find((place) => place.id === warehouseId)?.branchId ?? null;
 }
 
-function bookAccounts(data: WorkspaceData) {
+// Step 17b: a goods receipt books to the inventory account and use('received_not_billed') too
+export function bookAccounts(data: WorkspaceData) {
   const inventory = data.accounts.find((account) => account.purpose === 'inventory')?.id;
   const equity = data.accounts.find((account) => account.purpose === 'opening_balance_equity')?.id;
   if (inventory === undefined || equity === undefined) {
@@ -919,14 +944,13 @@ export function saveAdjustment(
   return saved;
 }
 
-export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): StockAdjustment {
-  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
-  assertDate(data, draft.date);
-  const direction = draft.direction === 'out' ? 'out' : 'in';
-  // An "in" line's lot becomes a batch: an existing one of the variant, or a new one
+// An "in" line's lot becomes a batch: an existing one of the variant, or a new one (the API's
+// StockPostingService.resolveBatches()). A line without a lot stays as it is. Step 17b's goods
+// receipts post their lines through it too.
+export function batchesForLots<T extends StockLine>(data: WorkspaceData, lines: readonly T[]): T[] {
   const issues: { path: string; code: ErrorCode }[] = [];
-  const lines = draft.lines.map((line, index) => {
-    if (direction !== 'in' || line.lotNumber === null) return line;
+  const resolved = lines.map((line, index) => {
+    if (line.lotNumber === null) return line;
     const lot = line.lotNumber;
     let batch = data.stock.batches.find(
       (candidate) =>
@@ -955,6 +979,14 @@ export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): Sto
     return { ...line, batchId: batch.id, expiresOn: batch.expiresOn };
   });
   if (issues.length > 0) throw issuesError(issues);
+  return resolved;
+}
+
+export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): StockAdjustment {
+  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
+  assertDate(data, draft.date);
+  const direction = draft.direction === 'out' ? 'out' : 'in';
+  const lines = direction === 'in' ? batchesForLots(data, draft.lines) : draft.lines;
   // The accounts first: a missing one refuses the posting before anything moves
   const accounts = bookAccounts(data);
   const reason = draft.reason;
```

- **`incoming()` is the API's `incomingTo()` on the mock's arrays:** for each approved order, ordered minus
  received, goods lines only, never below zero. A line received over the order (decision 7) would otherwise take
  away from another order's incoming. A pending order is left out: nobody agreed to it yet.
- **The stock list and the reorder report send `incoming`,** the field the contract added in 17b.1. These were two
  more of the 22 errors.
- **`batchesForLots()` is the lot-to-batch step taken out of `postAdjustment()`,** unchanged: a lot of the variant
  that exists gets more, a new lot becomes a batch, and a new batch of a product with expiry dates needs one. A
  goods receipt brings goods in with lots too, so it calls the same function instead of a copy. It is generic
  (`T extends StockLine`): a receipt line keeps its own fields (order line, rejected quantity) through it.
  `postAdjustment()` calls it only for an "in" adjustment, as before: an "out" line's lot comes from its batch and
  must not make a new one.
- **`bookAccounts()` is exported:** the receipt needs the inventory account and `use('received_not_billed')`,
  which refuses with `stock_account_missing` when the account is not chosen or is archived.

### A purchase line is a sales line: `mocks/sales-document-data.ts`

```diff
@@ -192,13 +192,15 @@ export interface ResolvedLine {
 // The API's resolveSalesLines(): an active product or service, its unit, the decimals, and an
 // active VAT rate (or one the document's lines already use: keptRateIds). Every problem at once,
 // each under its own field. keptVariantIds (step 15c): an archived product still billed on an
-// invoice line, because the challan or the order behind that line already sold it.
+// invoice line, because the challan or the order behind that line already sold it. itemCode
+// (step 17b): a purchase order's line is priced the same way, and says purchase_item_invalid.
 export function resolveSalesLines(
   data: WorkspaceData,
   lines: readonly SalesLineInput[],
   pricesIncludeVat: boolean,
   keptRateIds: ReadonlySet<string>,
   keptVariantIds: ReadonlySet<string> = new Set(),
+  itemCode: ErrorCode = 'sales_item_invalid',
 ): ResolvedLine[] {
   const issues: { path: string; code: ErrorCode }[] = [];
   const resolved = lines.flatMap((input, index): ResolvedLine[] => {
@@ -208,7 +210,7 @@ export function resolveSalesLines(
     const found = findVariant(data, input.variantId);
     const archived = found?.product.archivedAt !== null || found.variant.archivedAt !== null;
     if (!found || (archived && !keptVariantIds.has(input.variantId))) {
-      at('variantId', 'sales_item_invalid');
+      at('variantId', itemCode);
       return [];
     }
     const { product, variant } = found;
```

- **`resolveSalesLines()` takes the error code for a bad item.** An order line is priced like a sales line
  (decision 6), so the mock checks it with the same function, but the API answers `purchase_item_invalid` for a
  purchase line. A default keeps every sales caller as it was.

### Renaming or deleting a supplier: `mocks/sales-data.ts` and `mocks/supplier-data.ts`

```diff
@@ -594,8 +594,8 @@ export function saveCustomer(
 
 // The journal keeps a party's code and name on each line, and so does each sales document (step
 // 15b); the API joins them on read. After a rename they show the new name, like the API's. A
-// supplier is renamed the same way (step 17a): its payable lines, and its sales documents when it
-// is a customer too.
+// supplier is renamed the same way (step 17a): its payable lines, its purchase orders and goods
+// receipts (step 17b), and its sales documents when it is a customer too.
 export function refreshPartyRefs(data: WorkspaceData, saved: PartyRef): void {
   const ref = { id: saved.id, code: saved.code, name: saved.name };
   for (const entry of data.journal.entries) {
@@ -606,6 +606,9 @@ export function refreshPartyRefs(data: WorkspaceData, saved: PartyRef): void {
   for (const document of salesDocumentsOf(data)) {
     if (document.customer.id === saved.id) document.customer = ref;
   }
+  for (const document of [...data.purchase.orders, ...data.purchase.receipts]) {
+    if (document.supplier.id === saved.id) document.supplier = ref;
+  }
 }
 
 // Every document that names a customer: step 15b's, 15c's and 15d's
```

```diff
@@ -417,13 +417,18 @@ export function makeCustomer(data: WorkspaceData, saved: MockSupplier): MockCust
 
 // Deleting a supplier: only one nothing uses. A party that is also a customer stays as a customer:
 // only its supplier side goes, if no payable line names it (the API's dropSupplierSide). A
-// supplier-only party is used by any line that names it (journal_lines_party_fk).
+// supplier-only party is used by any line that names it (journal_lines_party_fk). Step 17b: a
+// purchase order or a goods receipt, drafts too, uses it either way (purchase_orders_supplier_fk,
+// goods_receipts_supplier_fk).
 export function removeSupplier(data: WorkspaceData, target: MockSupplier): void {
   const lines = data.journal.entries.flatMap((entry) => entry.lines);
   const used = target.isCustomer
     ? lines.some((line) => line.party?.id === target.id && isPayable(data, line.accountId))
     : lines.some((line) => line.party?.id === target.id);
-  if (used) throw new MockProblem(409, 'supplier_in_use');
+  const ordered = [...data.purchase.orders, ...data.purchase.receipts].some(
+    (document) => document.supplier.id === target.id,
+  );
+  if (used || ordered) throw new MockProblem(409, 'supplier_in_use');
   data.suppliers.suppliers = data.suppliers.suppliers.filter((item) => item.id !== target.id);
   const customer = data.sales.customers.find((item) => item.id === target.id);
   if (customer) {
```

- **A rename reaches the orders and the receipts.** The mock keeps a copy of the supplier's code and name on each
  document (the API joins them on read), so `refreshPartyRefs()` updates them, like it does the sales documents.
  Without it, a renamed supplier would keep its old name on its orders in `dev:mock`.
- **An order or a receipt keeps its supplier from being deleted,** drafts too, like the API's
  `purchase_orders_supplier_fk` and `goods_receipts_supplier_fk` (17b.3). It counts for a party that is also a
  customer as well: the API refuses to drop the supplier side of such a party while a purchase document names it.

### Requisitions and approvals learn about orders: `mocks/requisition-data.ts`

The shapes first. The requisition's new fields are worked out on read, and the purchase part gets the orders, the
receipts and two new counters.

```diff
@@ -10,28 +10,38 @@ import {
   type CostLookup,
   type CostLookupInput,
   type CostLookupItem,
+  compareQuantity,
   defaultLineDescription,
+  type DocumentRef,
   type DocumentApproval,
   type ErrorCode,
   fitsDecimals,
   levelsFor,
+  type OpenRequisitionLine,
+  type OpenRequisitionLineQuery,
   type Requisition,
   requisitionAmount,
   type RequisitionInput,
   type RequisitionLine,
   requisitionLineAmount,
   type RequisitionLineInput,
+  type RequisitionOrderFilter,
+  type RequisitionOrderState,
   type RequisitionStatus,
   type RequisitionSummary,
   shiftIsoDate,
+  subtractQuantity,
+  sumQuantity,
   toBaseQuantity,
   todayIn,
+  unitCostOf,
   type WaitingApproval,
 } from '@omnivo/contracts';
 
 import { OWNER } from './fixtures';
 import { MockProblem } from './mock';
 import { newestFirst, seriesNumber } from './sales-document-data';
+import type { MockGoodsReceipt, MockPurchaseOrder } from './purchase-order-data';
 import { averageCostOf, decimalsOf, findVariant, issuesError, refOf } from './stock-data';
 import type { WorkspaceData } from './workspace-data';
 
@@ -44,6 +54,10 @@ import type { WorkspaceData } from './workspace-data';
 // written on the page is approved at once, and the waiting ones are the seed's, submitted by
 // other members. The API's tests (17a.4) check the rules for everyone else: no self-approval, the
 // step's role, and the bell for the next level.
+//
+// Step 17b: purchase orders are approved the same way, and order requisition lines. The orders and
+// goods receipts live in purchase-order-data.ts, which imports this file; this one reads them
+// through the WorkspaceData type only, like sales-document-data.ts reads the invoices.
 
 // The levels of one kind of document, with the role by id: its name is read from the roles on
 // every read, like the API's join, so a renamed role shows its new name
@@ -62,24 +76,37 @@ export interface MockRound extends ApprovalRound {
   documentId: string;
 }
 
-// A requisition as stored; its line count and approval history are worked out on read
-export type MockRequisition = Omit<Requisition, 'approval' | 'lineCount'>;
+// A requisition as stored. Its line count and approval history are worked out on read, and so are
+// what purchase orders took of each line, its order state and its orders (step 17b, decision 26:
+// counted, never stored), so an order saved a second ago shows on the requisition at once.
+export type MockRequisitionLine = Omit<RequisitionLine, 'orderedQuantity'>;
+export type MockRequisition = Omit<
+  Requisition,
+  'approval' | 'lineCount' | 'orderState' | 'orders' | 'lines'
+> & { lines: MockRequisitionLine[] };
 
 export interface MockPurchase {
   rules: Record<ApprovalDocument, MockRule>;
   rounds: MockRound[];
   // New ones first, like the API's uuidv7 order
   requisitions: MockRequisition[];
-  // The last number given from the 'purchase.requisition' series
-  counters: { requisition: number };
+  // Step 17b, new ones first (purchase-order-data.ts)
+  orders: MockPurchaseOrder[];
+  receipts: MockGoodsReceipt[];
+  // The last number given from the 'purchase.requisition', 'purchase.order' and
+  // 'inventory.receipt' series
+  counters: { requisition: number; order: number; receipt: number };
 }
 
 export function emptyPurchase(): MockPurchase {
+  const none = { levels: [], version: 0, updatedAt: null };
   return {
-    rules: { requisition: { levels: [], version: 0, updatedAt: null } },
+    rules: { requisition: { ...none }, purchase_order: { ...none } },
     rounds: [],
     requisitions: [],
-    counters: { requisition: 0 },
+    orders: [],
+    receipts: [],
+    counters: { requisition: 0, order: 0, receipt: 0 },
   };
 }
 
```

- **`MockRequisition` leaves out `orderState`, `orders` and each line's `orderedQuantity`.** They depend on the
  orders, which change without the requisition changing (an order is cancelled, a receipt closes an order). Stored,
  they would go stale; worked out on every read, an order saved a second ago shows on its requisition at once. That
  is the API's decision 26 (counted, never stored).
- **`import type` from `purchase-order-data.ts`.** A type-only import is erased when the code is built, so it is
  not a dependency; the check of circular imports (`pnpm boundaries`) ignores it (decision 51).
- **Each kind of document gets its own empty rule** (`{ ...none }`), so saving the levels of one never changes the
  other's object.

The approval engine takes any kind of document:

```diff
@@ -192,7 +219,11 @@ function toRound(round: MockRound): ApprovalRound {
 }
 
 // Every round, newest first. The Owner may decide any waiting step, so canDecide is "a step waits".
-function historyOf(data: WorkspaceData, document: ApprovalDocument, id: string): DocumentApproval {
+export function historyOf(
+  data: WorkspaceData,
+  document: ApprovalDocument,
+  id: string,
+): DocumentApproval {
   const rounds = roundsOf(data, document, id).map(toRound);
   const [newest] = rounds;
   const canDecide =
@@ -202,11 +233,16 @@ function historyOf(data: WorkspaceData, document: ApprovalDocument, id: string):
 
 // A new round with the levels the amount reaches (decision 13). The signed-in Owner's steps are
 // written already approved, by the Owner, so the history says so; with no level the round has no
-// step. Either way it is approved at once, and the requisition passes through pending. Returns
-// how many steps it has.
-function submitRound(data: WorkspaceData, target: MockRequisition): number {
+// step. Either way it is approved at once, and the document passes through pending. Returns how
+// many steps it has. `amount` chooses the levels: a requisition's estimate, an order's total with
+// VAT (step 17b, decision 14).
+export function submitRound(
+  data: WorkspaceData,
+  document: ApprovalDocument,
+  target: { id: string; amount: string },
+): number {
   const at = now();
-  const steps = levelsFor(toRule(data, 'requisition').levels, target.amount).map(
+  const steps = levelsFor(toRule(data, document).levels, target.amount).map(
     (level, index): ApprovalStep => ({
       position: index + 1,
       minAmount: level.minAmount,
@@ -219,7 +255,7 @@ function submitRound(data: WorkspaceData, target: MockRequisition): number {
   );
   data.purchase.rounds.push({
     id: crypto.randomUUID(),
-    document: 'requisition',
+    document,
     documentId: target.id,
     status: 'approved',
     amount: target.amount,
@@ -241,7 +277,7 @@ export function decide(
   decision: ApprovalDecision,
   input: { roundId: string; comment: string | null },
 ): { step: ApprovalStep; count: number } {
-  const target = findRequisition(data, id);
+  const target = approvalTarget(data, document, id);
   const round = data.purchase.rounds.find(
     (item) => item.id === input.roundId && item.document === document && item.documentId === id,
   );
@@ -259,6 +295,44 @@ export function decide(
   return decided;
 }
 
+// The document an approval decides: a requisition, or a purchase order (step 17b). Both move the
+// same way (draft → pending → approved, or back to draft), and both are written with setStatus().
+function approvalTarget(
+  data: WorkspaceData,
+  document: ApprovalDocument,
+  id: string,
+): MockRequisition | MockPurchaseOrder {
+  if (document === 'requisition') return findRequisition(data, id);
+  const found = data.purchase.orders.find((item) => item.id === id);
+  if (!found) throw new MockProblem(404, 'not_found');
+  return found;
+}
+
+// What a waiting item says about its document: a requisition by its warehouse, an order by its
+// supplier (17b.3, decision 34). null: the document is gone.
+function waitingSubject(
+  data: WorkspaceData,
+  round: MockRound,
+): { number: string; date: string; subject: string } | null {
+  if (round.document === 'requisition') {
+    const found = data.purchase.requisitions.find((item) => item.id === round.documentId);
+    return found
+      ? { number: found.number, date: found.date, subject: warehouseName(data, found.warehouseId) }
+      : null;
+  }
+  const order = data.purchase.orders.find((item) => item.id === round.documentId);
+  return order?.number
+    ? { number: order.number, date: order.date, subject: order.supplier.name }
+    : null;
+}
+
+// Ends the round a pending document waits on, as reopened: the step nobody decided stays "Not
+// decided". An approved document keeps its approved round (decision 6).
+export function endPendingRound(data: WorkspaceData, document: ApprovalDocument, id: string): void {
+  const round = roundsOf(data, document, id).find((item) => item.status === 'pending');
+  if (round) Object.assign(round, { status: 'reopened', closedAt: now() });
+}
+
 // The documents whose waiting step the reader may decide, oldest first. The Owner may decide every
 // one, so that is every pending round.
 export function waitingList(data: WorkspaceData): WaitingApproval[] {
@@ -267,15 +341,13 @@ export function waitingList(data: WorkspaceData): WaitingApproval[] {
     .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
     .flatMap((round): WaitingApproval[] => {
       const step = round.steps.find((item) => item.decision === null);
-      const requisition = data.purchase.requisitions.find((item) => item.id === round.documentId);
-      if (!step || !requisition) return [];
+      const about = waitingSubject(data, round);
+      if (!step || !about) return [];
       return [
         {
           document: round.document,
-          id: requisition.id,
-          number: requisition.number,
-          date: requisition.date,
-          subject: warehouseName(data, requisition.warehouseId),
+          id: round.documentId,
+          ...about,
           amount: round.amount,
           submittedBy: round.submittedBy,
           submittedAt: round.submittedAt,
```

- **`submitRound()` takes the kind and `{ id, amount }`,** not a requisition. An order is submitted with its total,
  VAT included (decision 14), a requisition with its estimate; the engine does not care which.
- **`approvalTarget()` finds the document an approval decides.** Both kinds move the same way (draft → pending →
  approved, or back to draft), so `decide()` and `setStatus()` do not need to know which one it is.
- **`waitingSubject()` is what a waiting item says about its document:** a requisition by its warehouse, an order by
  its supplier (17b.3, decision 34). It returns `null` for a document that is gone, and an order without a number:
  an order waits only after it was submitted, and submitting numbers it.
- **`endPendingRound()` is the reopen step of 17a, shared.** Reopening a pending requisition or order ends its
  round as "reopened"; an approved one keeps its approved round (decision 6).

What orders took of a requisition, its order state and its open lines:

```diff
@@ -299,7 +371,70 @@ export function findRequisition(data: WorkspaceData, id: string): MockRequisitio
   return found;
 }
 
-export function requisitionSummaryOf(stored: MockRequisition): RequisitionSummary {
+// --- What purchase orders took of a requisition (step 17b) --------------------------------------
+
+// The orders that are not cancelled, with each line that buys for a requisition line
+function linkedOrderLines(data: WorkspaceData) {
+  return data.purchase.orders
+    .filter((order) => order.status !== 'cancelled')
+    .flatMap((order) =>
+      order.lines.flatMap((line) =>
+        line.requisitionLine === null ? [] : [{ order, line, link: line.requisitionLine }],
+      ),
+    );
+}
+
+// How much of a requisition line orders took, in the base unit (the API's orderedOf()): all of an
+// order line while the order is open or received, only what came in once it is closed (the rest
+// is still wanted). A service is never received, so a closed order counts it in full.
+function orderedOf(data: WorkspaceData, lineId: string): string {
+  return sumQuantity(
+    linkedOrderLines(data)
+      .filter((item) => item.link.id === lineId)
+      .map(({ order, line }) =>
+        order.status === 'closed' && line.productType === 'goods'
+          ? line.receivedQuantity
+          : line.baseQuantity,
+      ),
+  );
+}
+
+function withOrdered(data: WorkspaceData, line: MockRequisitionLine): RequisitionLine {
+  return { ...line, orderedQuantity: orderedOf(data, line.id) };
+}
+
+// Only an approved or closed requisition is ordered from: a draft's lines are not settled yet
+function orderStateOf(data: WorkspaceData, stored: MockRequisition): RequisitionOrderState {
+  if (stored.status !== 'approved' && stored.status !== 'closed') return 'not_ordered';
+  const lines = stored.lines.map((line) => withOrdered(data, line));
+  if (!lines.some((line) => compareQuantity(line.orderedQuantity, '0') > 0)) return 'not_ordered';
+  return lines.some((line) => compareQuantity(line.orderedQuantity, line.baseQuantity) < 0)
+    ? 'partly_ordered'
+    : 'ordered';
+}
+
+// An order that is not cancelled buys for one of its lines, a draft order too (decision 27): the
+// API's requisition_is_ordered()
+function isOrdered(data: WorkspaceData, requisitionId: string): boolean {
+  return linkedOrderLines(data).some((item) => item.link.requisitionId === requisitionId);
+}
+
+// The orders that buy for it, by number (null for a draft never submitted), oldest first
+function ordersOf(data: WorkspaceData, requisitionId: string): DocumentRef[] {
+  const seen = new Map<string, DocumentRef>();
+  for (const { order, link } of linkedOrderLines(data).toReversed()) {
+    if (link.requisitionId === requisitionId)
+      seen.set(order.id, { id: order.id, number: order.number });
+  }
+  return [...seen.values()];
+}
+
+// --- Requisitions, read -------------------------------------------------------------------------
+
+export function requisitionSummaryOf(
+  data: WorkspaceData,
+  stored: MockRequisition,
+): RequisitionSummary {
   return {
     id: stored.id,
     number: stored.number,
@@ -307,6 +442,7 @@ export function requisitionSummaryOf(stored: MockRequisition): RequisitionSummar
     neededBy: stored.neededBy,
     warehouseId: stored.warehouseId,
     status: stored.status,
+    orderState: orderStateOf(data, stored),
     amount: stored.amount,
     lineCount: stored.lines.length,
     requestedBy: stored.requestedBy,
@@ -318,33 +454,80 @@ export function requisitionSummaryOf(stored: MockRequisition): RequisitionSummar
 export function toRequisition(data: WorkspaceData, stored: MockRequisition): Requisition {
   return {
     ...stored,
+    lines: stored.lines.map((line) => withOrdered(data, line)),
     lineCount: stored.lines.length,
+    orderState: orderStateOf(data, stored),
     approval: historyOf(data, 'requisition', stored.id),
+    orders: ordersOf(data, stored.id),
   };
 }
 
-// Newest date first, like the API; the filters are the list's own
+// Newest date first, like the API; the filters are the list's own. to_order (step 17b): approved,
+// with a line still to order.
 export function listRequisitions(
   data: WorkspaceData,
-  query: { status?: RequisitionStatus | undefined; warehouseId?: string | undefined },
+  query: {
+    status?: RequisitionStatus | undefined;
+    warehouseId?: string | undefined;
+    order?: RequisitionOrderFilter | undefined;
+  },
 ): MockRequisition[] {
   return newestFirst(
     data.purchase.requisitions.filter(
       (item) =>
         (query.status === undefined || item.status === query.status) &&
-        (query.warehouseId === undefined || item.warehouseId === query.warehouseId),
+        (query.warehouseId === undefined || item.warehouseId === query.warehouseId) &&
+        (query.order === undefined ||
+          (item.status === 'approved' &&
+            item.lines.some(
+              (line) => compareQuantity(orderedOf(data, line.id), line.baseQuantity) < 0,
+            ))),
     ),
   );
 }
 
+// The lines a purchase order for this warehouse may buy for (step 17b, decision 18): lines of
+// approved requisitions with something still to order, oldest requisition first. A closed
+// requisition is left out: its rest will not be bought. The search looks at the requisition's
+// number and the item's name, code and SKU, like the API's.
+export function openLines(
+  data: WorkspaceData,
+  query: Omit<OpenRequisitionLineQuery, 'limit' | 'cursor'>,
+): OpenRequisitionLine[] {
+  const search = query.search?.trim().toLowerCase() ?? '';
+  return data.purchase.requisitions
+    .filter(
+      (item) =>
+        item.status === 'approved' &&
+        item.warehouseId === query.warehouseId &&
+        (query.requisitionId === undefined || item.id === query.requisitionId),
+    )
+    .toSorted((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
+    .flatMap((requisition) =>
+      requisition.lines.flatMap((stored): OpenRequisitionLine[] => {
+        const line = withOrdered(data, stored);
+        const remainingQuantity = subtractQuantity(line.baseQuantity, line.orderedQuantity);
+        if (compareQuantity(remainingQuantity, '0') <= 0) return [];
+        const matches =
+          search === '' ||
+          [requisition.number, line.productName, line.productCode, line.sku].some((text) =>
+            text.toLowerCase().includes(search),
+          );
+        if (!matches) return [];
+        const { id, number, date, neededBy } = requisition;
+        return [{ ...line, requisition: { id, number, date, neededBy }, remainingQuantity }];
+      }),
+    );
+}
+
 // The API's resolvePurchaseItems(): an active product or service, a unit that is its base unit or
 // one of its packs, and a quantity that fits the unit. Every problem comes back at once.
 function resolveLines(
   data: WorkspaceData,
   lines: readonly RequisitionLineInput[],
-): RequisitionLine[] {
+): MockRequisitionLine[] {
   const issues: { path: string; code: ErrorCode }[] = [];
-  const resolved = lines.flatMap((input, index): RequisitionLine[] => {
+  const resolved = lines.flatMap((input, index): MockRequisitionLine[] => {
     const at = (field: string, code: ErrorCode) => {
       issues.push({ path: `lines.${String(index)}.${field}`, code });
     };
```

- **`orderedOf()` is the API's `orderedOf()` SQL, on arrays:** all of an order line while its order is open or
  received, only what came in once it is closed (the rest is still wanted), nothing when it is cancelled. A
  service is never received, so a closed order counts it in full. Change any of these and the requisition shows a
  different "left to order" from the API.
- **`orderStateOf()` says `not_ordered` for every status but approved and closed,** like the API's `CASE`: a draft's
  lines are not settled yet, so an order cannot "partly" buy them.
- **`isOrdered()` counts a draft order too** (decision 27). It is the API's `requisition_is_ordered()`: a draft
  order already points at the line, and reopening the requisition would cut that link.
- **`ordersOf()` walks the lines oldest first** (`toReversed()`: orders are stored newest first) and keeps each
  order once, so the requisition lists its orders in the order they were written.
- **`listRequisitions()` gets the `to_order` filter:** approved, with a line still to order. A closed requisition
  is never "to order", even with lines left: that is what closing it means.
- **`openLines()` is `GET /requisition-lines`:** the lines of approved requisitions for one warehouse with something
  left, oldest requisition first, searched by the requisition's number and the item's name, code or SKU. The handler
  pages the result like every other mock list.

The rules that change for a requisition:

```diff
@@ -388,8 +571,13 @@ function resolveLines(
   return resolved;
 }
 
-// An active warehouse; a draft keeps the one it has even after it is archived (keptId)
-function assertWarehouse(data: WorkspaceData, warehouseId: string, keptId: string | null): void {
+// An active warehouse; a draft keeps the one it has even after it is archived (keptId). Step 17b's
+// purchase orders check theirs the same way.
+export function assertWarehouse(
+  data: WorkspaceData,
+  warehouseId: string,
+  keptId: string | null,
+): void {
   const found = data.stock.warehouses.find((item) => item.id === warehouseId);
   if (!found || (found.archivedAt !== null && found.id !== keptId)) {
     throw new MockProblem(409, 'purchase_warehouse_invalid', {
@@ -438,7 +626,11 @@ export function saveRequisition(
   return created;
 }
 
-function setStatus(target: MockRequisition, status: RequisitionStatus): void {
+// A requisition's or an order's status, with a new version: a page open somewhere must reload
+function setStatus(
+  target: MockRequisition | MockPurchaseOrder,
+  status: RequisitionStatus & MockPurchaseOrder['status'],
+): void {
   Object.assign(target, { status, version: target.version + 1, updatedAt: now() });
 }
 
@@ -453,39 +645,76 @@ export function removeRequisition(data: WorkspaceData, target: MockRequisition):
 // Returns how many steps its round has
 export function submitRequisition(data: WorkspaceData, target: MockRequisition): number {
   if (target.status !== 'draft') throw conflict('purchase_not_draft');
-  const steps = submitRound(data, target);
+  const steps = submitRound(data, 'requisition', target);
   setStatus(target, 'approved');
   return steps;
 }
 
 // Pending: the round ends as reopened. Approved: the round stays approved (it was), and the next
-// submit starts a new round from the first level (decision 6).
+// submit starts a new round from the first level (decision 6). Step 17b: not once an order buys for
+// it, even a draft one (decision 27): the order's lines would lose their link.
 export function reopenRequisition(data: WorkspaceData, target: MockRequisition): void {
   if (target.status !== 'pending' && target.status !== 'approved') {
     throw conflict('purchase_cannot_reopen');
   }
-  if (target.status === 'pending') {
-    const round = roundsOf(data, 'requisition', target.id).find(
-      (item) => item.status === 'pending',
-    );
-    if (round) Object.assign(round, { status: 'reopened', closedAt: now() });
+  if (target.status === 'approved' && isOrdered(data, target.id)) {
+    throw conflict('purchase_close_instead');
   }
+  if (target.status === 'pending') endPendingRound(data, 'requisition', target.id);
   setStatus(target, 'draft');
 }
 
-export function cancelRequisition(target: MockRequisition): void {
+// Step 17b: once an order buys for it, some of it is being bought, so it is closed instead
+export function cancelRequisition(data: WorkspaceData, target: MockRequisition): void {
   if (target.status !== 'draft' && target.status !== 'approved') {
     throw conflict('purchase_cannot_cancel');
   }
+  if (target.status === 'approved' && isOrdered(data, target.id)) {
+    throw conflict('purchase_close_instead');
+  }
   setStatus(target, 'cancelled');
 }
 
+// Step 17b (decision 17): partly ordered, and the rest will not be. The orders already written go
+// on. Closed is final.
+export function closeRequisition(data: WorkspaceData, target: MockRequisition): void {
+  if (target.status !== 'approved') throw conflict('purchase_not_approved');
+  if (!isOrdered(data, target.id)) throw conflict('purchase_cancel_instead');
+  setStatus(target, 'closed');
+}
+
 // --- The cost a line starts with ----------------------------------------------------------------
 
-// The API's CostLookupService: the variant's company-wide average cost (step 14) × the unit's
-// factor, rounded to the 4 decimals a cost keeps; none for an item never bought or a service. A
-// unit that is not this product's drops out, like an unknown variant.
+// The price of the latest approved order line for the variant, per one of the unit (step 17b,
+// decision 19): the line's net (after its discount, before VAT) × the unit's factor ÷ its base
+// quantity, to the 4 decimals a cost keeps. Approved, received and closed orders count: a draft or
+// a pending order is not a price anybody agreed to. supplierId: only that supplier's orders.
+// The newest date first; a new order is put first in the array, so on one date it wins.
+function lastPrice(
+  data: WorkspaceData,
+  variantId: string,
+  factor: string,
+  supplierId: string | null,
+): string | null {
+  const agreed = data.purchase.orders.filter(
+    (order) =>
+      ['approved', 'received', 'closed'].includes(order.status) &&
+      (supplierId === null || order.supplier.id === supplierId),
+  );
+  const [latest] = newestFirst(agreed).flatMap((order) =>
+    order.lines.filter((line) => line.variantId === variantId),
+  );
+  // × the factor first, then ÷ the base quantity: one rounding at the end, like the API's NUMERIC
+  return latest ? unitCostOf(toBaseQuantity(latest.net, factor, 4), latest.baseQuantity) : null;
+}
+
+// The API's CostLookupService: this supplier's last price, else anyone's last price (step 17b),
+// else the variant's company-wide average cost (step 14) × the unit's factor; none for an item
+// never bought. And the VAT rate an order line starts with: the product's own active rate, else the
+// workspace default (step 17b). A unit that is not this product's drops out, like an unknown
+// variant.
 export function lookupCosts(data: WorkspaceData, input: CostLookupInput): CostLookup {
+  const fallbackRate = data.sales.taxRates.find((rate) => rate.isDefault);
   return {
     items: input.items.flatMap((item): CostLookupItem[] => {
       const found = findVariant(data, item.variantId);
```

- **`assertWarehouse()` is exported** for the order, which checks its warehouse the same way: active, or the one a
  draft already has.
- **`setStatus()` takes a requisition or an order.** Its status type is the statuses both have
  (`RequisitionStatus & MockPurchaseOrder['status']`), so neither can be given a status only the other knows
  (`received` is an order's, never a requisition's).
- **Reopen and cancel are refused once an order buys for it** (`purchase_close_instead`); the person closes it
  instead. `closeRequisition()` needs it approved and ordered, else `purchase_not_approved` or
  `purchase_cancel_instead`, the API's two answers.

The cost a new line starts with:

```diff
@@ -496,16 +725,24 @@ export function lookupCosts(data: WorkspaceData, input: CostLookupInput): CostLo
           ? '1'
           : product.units.find((pack) => pack.unitId === item.unitId)?.factor;
       if (factor === undefined) return [];
+      const rate =
+        data.sales.taxRates.find(
+          (row) => row.id === product.taxRateId && row.archivedAt === null,
+        ) ?? fallbackRate;
+      if (!rate) return [];
       const average = averageCostOf(data.stock, item.variantId);
-      const cost = average === null ? null : toBaseQuantity(average, factor, 4);
-      return [
-        {
-          variantId: item.variantId,
-          unitId: item.unitId,
-          cost,
-          source: cost === null ? null : 'average_cost',
-        },
+      const sources: [string, string | null][] = [
+        [
+          'supplier_price',
+          input.supplierId === null
+            ? null
+            : lastPrice(data, item.variantId, factor, input.supplierId),
+        ],
+        ['last_price', lastPrice(data, item.variantId, factor, null)],
+        ['average_cost', average === null ? null : toBaseQuantity(average, factor, 4)],
       ];
+      const [source, cost] = sources.find(([, value]) => value !== null) ?? [null, null];
+      return [{ variantId: item.variantId, unitId: item.unitId, cost, source, taxRateId: rate.id }];
     }),
   };
 }
```

- **`lastPrice()` is the latest approved, received or closed order line of the variant,** of one supplier or of
  anyone. A draft or a pending order is not a price anybody agreed to, and a cancelled one was never bought.
- **× the factor first, then ÷ the base quantity.** The API rounds once, in NUMERIC. Dividing first would round the
  price per piece to 4 decimals (৳0.4306 a button) and then multiply that error by 144: ৳62.0064 a gross instead
  of ৳62.0000. Multiplying the line's net first (`toBaseQuantity(net, factor, 4)`) is exact, and `unitCostOf()`
  rounds once at the end.
- **The sources in the API's order:** this supplier's last price, anyone's last price, the average cost. The first
  that is not `null` wins, and its name goes with it, so the line says "Last price from this supplier" or "From the
  average cost".
- **`taxRateId` is the product's own active rate, else the workspace default,** like the sales price lookup. The
  contract requires it since 17b.1; the requisition form ignores it.

The seed's approval levels for orders:

```diff
@@ -541,6 +778,16 @@ export function seedPurchase(data: WorkspaceData, garments: boolean): void {
     version: 1,
     updatedAt: now(),
   };
+  // Step 17b: orders are approved by their total with VAT, from ৳50,000 by the purchase manager,
+  // from ৳5,00,000 by a director as well (purchase-order-data.ts seeds the orders)
+  data.purchase.rules.purchase_order = {
+    levels: [
+      { minAmount: '50000.0000', roleId: manager.id },
+      { minAmount: '500000.0000', roleId: director.id },
+    ],
+    version: 1,
+    updatedAt: now(),
+  };
 
   const today = todayIn(data.settings.timezone);
   const sadia = person('Sadia Islam');
```

- **৳50,000 and ৳5,00,000, by the same two roles as requisitions** (decision 52). The seeded button order (৳71,300)
  reaches the first level, so its history shows Kamal's approval.

### Orders and receipts: `mocks/purchase-order-data.ts` (new)

```ts
import {
  addQuantity,
  compareQuantity,
  type DocumentRef,
  type ErrorCode,
  fitsDecimals,
  type GoodsReceipt,
  type GoodsReceiptInput,
  type GoodsReceiptLine,
  type GoodsReceiptLineInput,
  isQuantity,
  isWholeQuantity,
  isZeroQuantity,
  negateMoney,
  type PartyRef,
  prorateMoney,
  type PurchaseOrder,
  type PurchaseOrderInput,
  type PurchaseOrderLineInput,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
  type RequisitionLineRef,
  shiftIsoDate,
  type StockDocumentStatus,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  todayIn,
  wholeCount,
  withTolerance,
} from '@omnivo/contracts';

import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import { assertWarehouse, endPendingRound, historyOf, submitRound } from './requisition-data';
import {
  fieldProblem,
  newestFirst,
  now,
  ratesOf,
  type ResolvedLine,
  resolveSalesLines,
  seriesNumber,
  totalsOf,
} from './sales-document-data';
import {
  assertDate,
  assertWarehouses,
  batchesForLots,
  bookAccounts,
  branchOf,
  decimalsOf,
  findVariant,
  issuesError,
  postMoves,
  refOf,
} from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17b: purchase orders and goods receipts. The API's rules
// (purchase-orders.service.ts, goods-receipts.service.ts) on plain arrays, shortened, so
// `pnpm dev:mock` and the e2e tests walk the same paths as the real API. An order is priced with
// the sales line arithmetic (resolveSalesLines(), decision 6) and approved by the 17a engine
// (requisition-data.ts): the mock signs in as the Owner, so a submitted order is approved at once.
// A posted receipt moves stock in at the order's price and books Dr Inventory / Cr Goods received
// not billed, like a stock adjustment (stock-data.ts).

// An order as stored. "Partly received", its line count, its requisitions, its receipts and its
// approval history are worked out on read, like the API's subqueries.
export type MockPurchaseOrder = Omit<
  PurchaseOrder,
  'partlyReceived' | 'lineCount' | 'requisitions' | 'receipts' | 'approval'
>;

// A receipt as stored, with its order's id: the order's number is looked up on read, like a
// delivery's order
export type MockGoodsReceipt = Omit<GoodsReceipt, 'order' | 'lineCount'> & { orderId: string };

function conflict(code: ErrorCode): MockProblem {
  return new MockProblem(409, code);
}

// 'purchase.order' at an order's first submit, 'inventory.receipt' when a receipt is posted
function nextNumber(data: WorkspaceData, series: 'order' | 'receipt', date: string): string {
  data.purchase.counters[series] += 1;
  return seriesNumber(
    data,
    series === 'order' ? 'purchase.order' : 'inventory.receipt',
    data.purchase.counters[series],
    date,
  );
}

// A document's status, with a new version: a page open somewhere must reload before its next action
function moveTo(target: MockPurchaseOrder, status: PurchaseOrderStatus): void {
  Object.assign(target, { status, version: target.version + 1, updatedAt: now() });
}
```

- **`MockPurchaseOrder` leaves out what is worked out on read:** "partly received", the line count, its
  requisitions, its receipts and its approval history, like `MockOrder` of the sales orders.
- **`MockGoodsReceipt` keeps the order's id,** and the order's number is looked up on read: an order's number never
  changes once given, but looking it up keeps one source of truth, like the delivery's order.
- **One counter per series** (`purchase.order`, `inventory.receipt`), formatted with the Numbering page's format
  through `seriesNumber()`, like every mock document.
- **`moveTo()` gives a new version with every status change.** An order page open in another tab must reload before
  its next action, or it acts on an old state; the version check refuses it otherwise.

```ts
// --- Purchase orders, read ----------------------------------------------------------------------

export function findPurchaseOrder(data: WorkspaceData, id: string): MockPurchaseOrder {
  const found = data.purchase.orders.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function anythingReceived(order: MockPurchaseOrder): boolean {
  return order.lines.some((line) => !isZeroQuantity(line.receivedQuantity));
}

// Approved, with a goods line that has not all come in: what the goods receipt form offers. An
// order of services only is never received (the bill takes it, 17c).
function goodsToReceive(order: MockPurchaseOrder): boolean {
  return (
    order.status === 'approved' &&
    order.lines.some(
      (line) =>
        line.productType === 'goods' &&
        compareQuantity(line.receivedQuantity, line.baseQuantity) < 0,
    )
  );
}

export function purchaseOrderSummaryOf(stored: MockPurchaseOrder): PurchaseOrderSummary {
  return {
    id: stored.id,
    number: stored.number,
    date: stored.date,
    expectedDate: stored.expectedDate,
    supplier: stored.supplier,
    supplierReference: stored.supplierReference,
    warehouseId: stored.warehouseId,
    status: stored.status,
    partlyReceived: stored.status === 'approved' && anythingReceived(stored),
    net: stored.net,
    vat: stored.vat,
    total: stored.total,
    lineCount: stored.lines.length,
    version: stored.version,
    updatedAt: stored.updatedAt,
  };
}

export function toPurchaseOrder(data: WorkspaceData, stored: MockPurchaseOrder): PurchaseOrder {
  // The requisitions its lines buy for, once each, in line order
  const requisitions = new Map<string, DocumentRef>();
  for (const line of stored.lines) {
    const link = line.requisitionLine;
    if (link) requisitions.set(link.requisitionId, { id: link.requisitionId, number: link.number });
  }
  return {
    ...stored,
    ...purchaseOrderSummaryOf(stored),
    requisitions: [...requisitions.values()],
    // Drafts too, oldest first: the order page lists every receipt made against it
    receipts: data.purchase.receipts
      .filter((item) => item.orderId === stored.id)
      .toSorted((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({ id: item.id, number: item.number, date: item.date, status: item.status })),
    approval: historyOf(data, 'purchase_order', stored.id),
  };
}

// Newest date first, like the API; the filters are the list's own
export function listPurchaseOrders(
  data: WorkspaceData,
  query: {
    status?: PurchaseOrderStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    receipt?: PurchaseOrderReceiptFilter | undefined;
  },
): MockPurchaseOrder[] {
  return newestFirst(
    data.purchase.orders.filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId) &&
        (query.receipt === undefined || goodsToReceive(item)),
    ),
  );
}
```

- **`goodsToReceive()` is the API's `goodsToReceive` subquery:** approved, with a goods line not all in. An order of
  services only is never received (the bill takes it in 17c), so the goods receipt form must not offer it.
- **`purchaseOrderSummaryOf()` names every field** instead of spreading the stored order: a spread would send the
  lines with every row of the list.
- **`toPurchaseOrder()` lists each requisition once, in line order,** and every receipt of the order, drafts too,
  oldest first: the order's page shows a draft receipt, because a draft also stops a reopen (decision 21).

```ts
// --- Purchase orders, written -------------------------------------------------------------------

// An active supplier. A draft keeps its supplier (keptId) even after the supplier is archived, like
// the API's assertSupplier(), so the person can still finish it.
function supplierOf(data: WorkspaceData, supplierId: string, keptId: string | null): PartyRef {
  const found = data.suppliers.suppliers.find((item) => item.id === supplierId);
  if (!found || (found.archivedAt !== null && found.id !== keptId)) {
    throw fieldProblem('purchase_supplier_invalid', 'supplierId');
  }
  return { id: found.id, code: found.code, name: found.name };
}

// The requisition lines the order's lines buy for (decision 16): a line of an approved requisition
// for this order's warehouse, for the same item. A link the draft already had (keptIds) may stay
// after its requisition was closed. Returns each line's link, in line order.
function requisitionLinks(
  data: WorkspaceData,
  input: { warehouseId: string; lines: readonly PurchaseOrderLineInput[] },
  resolved: readonly ResolvedLine[],
  keptIds: ReadonlySet<string>,
): (RequisitionLineRef | null)[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const links = input.lines.map((line, index): RequisitionLineRef | null => {
    const id = line.requisitionLineId;
    if (id === null) return null;
    const requisition = data.purchase.requisitions.find((item) =>
      item.lines.some((candidate) => candidate.id === id),
    );
    const found = requisition?.lines.find((candidate) => candidate.id === id);
    const open =
      requisition?.status === 'approved' || (requisition?.status === 'closed' && keptIds.has(id));
    if (
      !requisition ||
      !open ||
      requisition.warehouseId !== input.warehouseId ||
      found?.variantId !== resolved[index]?.line.variantId
    ) {
      issues.push({
        path: `lines.${String(index)}.requisitionLineId`,
        code: 'purchase_requisition_line_invalid',
      });
      return null;
    }
    return { id, requisitionId: requisition.id, number: requisition.number };
  });
  if (issues.length > 0) throw issuesError(issues);
  return links;
}

// Create (no `existing`: a draft without a number, decision 13) or change a draft. A numbered
// draft (reopened) keeps its supplier: its number was given to that supplier.
export function savePurchaseOrder(
  data: WorkspaceData,
  input: PurchaseOrderInput,
  existing?: MockPurchaseOrder,
): MockPurchaseOrder {
  if (existing && existing.status !== 'draft') throw conflict('purchase_not_draft');
  const supplier = supplierOf(data, input.supplierId, existing?.supplier.id ?? null);
  if (existing && existing.number !== null && supplier.id !== existing.supplier.id) {
    throw fieldProblem('purchase_supplier_invalid', 'supplierId');
  }
  assertWarehouse(data, input.warehouseId, existing?.warehouseId ?? null);
  // The order's own "prices include VAT" (decision 15), and purchase_item_invalid for an item
  const resolved = resolveSalesLines(
    data,
    input.lines,
    input.pricesIncludeVat,
    existing ? ratesOf(existing.lines) : new Set(),
    new Set(),
    'purchase_item_invalid',
  );
  const kept = new Set(existing?.lines.flatMap((line) => line.requisitionLine?.id ?? []));
  const links = requisitionLinks(data, input, resolved, kept);
  const fields = {
    date: input.date,
    expectedDate: input.expectedDate,
    supplier,
    supplierReference: input.supplierReference,
    warehouseId: input.warehouseId,
    paymentTermsDays: input.paymentTermsDays,
    pricesIncludeVat: input.pricesIncludeVat,
    note: input.note,
    ...totalsOf(resolved),
    lines: resolved.map((item, index) => ({
      ...item.line,
      requisitionLine: links[index] ?? null,
      receivedQuantity: '0.0000',
      rejectedQuantity: '0.0000',
    })),
    updatedAt: now(),
  };
  if (existing) {
    Object.assign(existing, fields, { version: existing.version + 1 });
    return existing;
  }
  const created: MockPurchaseOrder = {
    ...fields,
    id: crypto.randomUUID(),
    number: null,
    status: 'draft',
    version: 1,
  };
  data.purchase.orders.unshift(created);
  return created;
}

// Only a draft that was never submitted: once numbered it is cancelled instead (decision 13)
export function removePurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  if (target.number !== null) throw conflict('purchase_was_submitted');
  data.purchase.orders = data.purchase.orders.filter((item) => item.id !== target.id);
}

// Numbered the first time, then sent for approval with its total, VAT included (decision 14). A
// supplier or warehouse archived while it was a draft stops it here. Returns how many steps its
// round has.
export function submitPurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): number {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  supplierOf(data, target.supplier.id, null);
  assertWarehouse(data, target.warehouseId, null);
  target.number ??= nextNumber(data, 'order', target.date);
  const steps = submitRound(data, 'purchase_order', { id: target.id, amount: target.total });
  moveTo(target, 'approved');
  return steps;
}

// A posted receipt: some came in, so the order is closed, not reopened or cancelled. A draft one:
// the store keeper deletes it first (decision 21).
function assertNoReceipt(data: WorkspaceData, orderId: string): void {
  const receipts = data.purchase.receipts.filter((item) => item.orderId === orderId);
  if (receipts.some((item) => item.status === 'posted')) throw conflict('purchase_close_instead');
  if (receipts.length > 0) throw conflict('purchase_receipt_draft');
}

// Pending: taken back to change it. Approved: changed after all, and approved again from the first
// level (decision 11).
export function reopenPurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'pending' && target.status !== 'approved') {
    throw conflict('purchase_cannot_reopen');
  }
  assertNoReceipt(data, target.id);
  if (target.status === 'pending') endPendingRound(data, 'purchase_order', target.id);
  moveTo(target, 'draft');
}

// Partly received, and the rest will not come
export function closePurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'approved') throw conflict('purchase_not_approved');
  const posted = data.purchase.receipts.some(
    (item) => item.orderId === target.id && item.status === 'posted',
  );
  if (!posted) throw conflict('purchase_cancel_instead');
  moveTo(target, 'closed');
}

// Will not be bought: a draft that was submitted once, or an approved order before any receipt
export function cancelPurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'draft' && target.status !== 'approved') {
    throw conflict('purchase_cannot_cancel');
  }
  if (target.number === null) throw conflict('purchase_delete_instead');
  assertNoReceipt(data, target.id);
  moveTo(target, 'cancelled');
}
```

- **`supplierOf()` lets a draft keep an archived supplier** (`keptId`), like the API's `assertSupplier()`, so the
  person can still finish it; submitting checks again without it.
- **`requisitionLinks()` checks each link:** a line of an approved requisition (or a closed one the draft already
  had), for the order's warehouse and the same variant. `resolved[index]` is the same line because
  `resolveSalesLines()` throws before this when any line is wrong, so the two arrays always line up.
- **`savePurchaseOrder()` refuses a new supplier on a numbered draft,** with the API's
  `purchase_supplier_invalid` at `supplierId`: the number was given to that supplier, on a PDF or in an email. The
  lines are written again on every save with new ids, like the API's delete-and-insert.
- **`submitPurchaseOrder()` numbers it the first time only** (`??=`): a reopened order keeps its number (decision
  13). Then it goes through the 17a engine, which approves an Owner's order at once.
- **`assertNoReceipt()` answers a posted receipt first:** `purchase_close_instead` says what to do (close it); only
  with nothing but drafts is the answer `purchase_receipt_draft` (delete the draft first).
- **Close needs a posted receipt and cancel needs a number,** the API's `purchase_cancel_instead` and
  `purchase_delete_instead`: each error names the other action, so the page can say what to do instead.

```ts
// --- Goods receipts, read -----------------------------------------------------------------------

export function findGoodsReceipt(data: WorkspaceData, id: string): MockGoodsReceipt {
  const found = data.purchase.receipts.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toGoodsReceipt(data: WorkspaceData, stored: MockGoodsReceipt): GoodsReceipt {
  const { orderId, ...receipt } = stored;
  const order = data.purchase.orders.find((item) => item.id === orderId);
  return {
    ...receipt,
    order: { id: orderId, number: order?.number ?? null },
    lineCount: stored.lines.length,
  };
}

export function listGoodsReceipts(
  data: WorkspaceData,
  query: {
    status?: StockDocumentStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    orderId?: string | undefined;
  },
): GoodsReceipt[] {
  return newestFirst(data.purchase.receipts)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId) &&
        (query.orderId === undefined || item.orderId === query.orderId),
    )
    .map((item) => toGoodsReceipt(data, item));
}
```

- **A receipt's list is filtered like the API's:** status, supplier, warehouse and order. The order page's receipts
  card uses `toPurchaseOrder()` instead, so this filter is for the list's own controls.

```ts
// --- Goods receipts, written --------------------------------------------------------------------

// The order a receipt takes goods against: approved (decision 8). Reopened, received, closed or
// cancelled since the page was opened, it is not waiting for goods any more.
function receivingOrder(data: WorkspaceData, orderId: string): MockPurchaseOrder {
  const order = data.purchase.orders.find((item) => item.id === orderId);
  if (!order) throw fieldProblem('grn_order_invalid', 'orderId');
  if (order.status !== 'approved') throw fieldProblem('purchase_not_approved', 'orderId');
  return order;
}

type ReceiptLineInput = Omit<GoodsReceiptLineInput, 'batchId'>;

// The API's resolveReceiptLines(): like an "in" stock line, with two differences. The accepted
// quantity may be zero (everything that came was turned back), and then nothing comes in: no lot,
// no serial numbers. The rejected quantity is checked against the same unit, and keeps its reason
// only when something was turned back. Every problem at once, each under its own field.
function resolveReceiptLines(
  data: WorkspaceData,
  lines: readonly ReceiptLineInput[],
): GoodsReceiptLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index): GoodsReceiptLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, input.variantId);
    // Goods only: a service is never received. Archived: nothing new comes in.
    if (
      found?.product.type !== 'goods' ||
      found.product.archivedAt !== null ||
      found.variant.archivedAt !== null
    ) {
      at('variantId', 'stock_variant_invalid');
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
    // In the base unit; zero stays zero, and a quantity that rounds to nothing is a typing mistake
    const inBase = (quantity: string, field: string): string | null => {
      if (isZeroQuantity(quantity)) return '0.0000';
      if (!fitsDecimals(quantity, decimalsOf(data, input.unitId))) {
        at(field, 'stock_quantity_decimals');
        return null;
      }
      const base = toBaseQuantity(quantity, factor, decimalsOf(data, product.baseUnitId));
      if (!isQuantity(base)) {
        at(field, 'quantity_format');
        return null;
      }
      return base;
    };
    const baseQuantity = inBase(input.quantity, 'quantity');
    const rejectedBaseQuantity = inBase(input.rejectedQuantity, 'rejectedQuantity');
    if (baseQuantity === null || rejectedBaseQuantity === null) return [];
    const accepting = !isZeroQuantity(baseQuantity);
    const lot = product.tracking === 'batch' && accepting ? input.lotNumber : null;
    if (product.tracking === 'batch' && accepting && lot === null) {
      at('lotNumber', 'stock_lot_required');
      return [];
    }
    // One serial number per base unit accepted: a rejected machine does not come in
    const serialNumbers = product.tracking === 'serial' ? input.serialNumbers : [];
    if (
      product.tracking === 'serial' &&
      (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== serialNumbers.length)
    ) {
      at('serialNumbers', 'stock_serial_count');
      return [];
    }
    return [
      {
        ...refOf(product, variant),
        id: crypto.randomUUID(),
        tracking: product.tracking,
        hasExpiry: product.hasExpiry,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        unitId: input.unitId,
        // "600" → "600.0000": the way Postgres sends NUMERIC(19,4)
        quantity: addQuantity(input.quantity, '0'),
        baseQuantity,
        batchId: null,
        lotNumber: lot,
        expiresOn: lot === null ? null : input.expiresOn,
        manufacturedOn: lot === null ? null : input.manufacturedOn,
        serialNumbers,
        orderLineId: input.orderLineId,
        rejectedQuantity: addQuantity(input.rejectedQuantity, '0'),
        rejectedBaseQuantity,
        rejectionReason: isZeroQuantity(rejectedBaseQuantity) ? null : input.rejectionReason,
        value: null,
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// Each line receives a line of this order, for the same variant, and the lines together never
// bring in more than the order line still takes: ordered × (100 + the workspace's percent) ÷ 100,
// less what posted receipts accepted (decisions 7 and 22). What was rejected does not count: it
// did not come in. Drafts hold nothing, so the second of two drafts to post is refused here.
function checkOrderLines(
  data: WorkspaceData,
  order: MockPurchaseOrder,
  lines: readonly GoodsReceiptLine[],
): void {
  const issues: { path: string; code: ErrorCode }[] = [];
  const taken = new Map<string, string[]>();
  lines.forEach((line, index) => {
    const orderLine = order.lines.find((item) => item.id === line.orderLineId);
    if (orderLine?.variantId !== line.variantId) {
      issues.push({ path: `lines.${String(index)}.orderLineId`, code: 'grn_order_line_invalid' });
      return;
    }
    taken.set(line.orderLineId, [...(taken.get(line.orderLineId) ?? []), line.baseQuantity]);
  });
  for (const [orderLineId, quantities] of taken) {
    const orderLine = order.lines.find((item) => item.id === orderLineId);
    if (!orderLine) continue;
    const most = withTolerance(orderLine.baseQuantity, data.settings.overReceiptPercent);
    const after = sumQuantity([orderLine.receivedQuantity, ...quantities]);
    if (compareQuantity(after, most) <= 0) continue;
    // Under every line that takes from it: the person decides which one to cut
    lines.forEach((line, index) => {
      if (line.orderLineId === orderLineId) {
        issues.push({ path: `lines.${String(index)}.quantity`, code: 'grn_over_order' });
      }
    });
  }
  if (issues.length > 0) throw issuesError(issues);
}
```

- **`receivingOrder()` answers at `orderId`:** a missing order is `grn_order_invalid`, an order that is no longer
  approved is `purchase_not_approved`. The form shows both under its order box.
- **`resolveReceiptLines()` is not the stock lines' `resolveLines()`.** That one refuses a zero quantity, and a
  receipt line may accept nothing when everything that came was turned back (decision 20). So the receipt has its
  own: zero stays zero (`'0.0000'`), a lot is needed only when something is accepted, the serial numbers count
  only what is accepted (a rejected machine does not come in), and the reason stays only when something was
  rejected, because the database keeps no reason for nothing.
- **`inBase()` refuses a quantity that rounds to nothing** (0.001 of a yard in whole metres) with
  `quantity_format`, like the API: a positive number that becomes zero is a typing mistake, not "nothing came".
- **`checkOrderLines()` adds up every line of one order line** before it compares: two lots of one fabric on one
  truck are two lines of the same order line. The limit is `withTolerance(ordered, percent)`, the contract's
  function that the form's "Up to … may come" also uses, so the form and the mock never disagree by a rounding.
  The error goes under every line that takes from it: the person decides which one to cut.

```ts
type ReceiptFields = Omit<GoodsReceiptInput, 'post' | 'orderId'>;

// Create (no `existing`) or change a draft. A receipt keeps its order (decision 20) and the order's
// supplier, never one the form sends.
export function saveGoodsReceipt(
  data: WorkspaceData,
  orderId: string,
  input: ReceiptFields,
  existing?: MockGoodsReceipt,
): MockGoodsReceipt {
  if (existing && existing.status !== 'draft') throw conflict('stock_not_draft');
  const order = receivingOrder(data, orderId);
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const lines = resolveReceiptLines(data, input.lines);
  checkOrderLines(data, order, lines);
  const saved: MockGoodsReceipt = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    supplier: order.supplier,
    orderId: order.id,
    warehouseId: input.warehouseId,
    status: 'draft',
    supplierChallan: input.supplierChallan,
    vehicle: input.vehicle,
    note: input.note,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines,
    entry: null,
  };
  const { receipts } = data.purchase;
  data.purchase.receipts = existing
    ? receipts.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...receipts];
  return saved;
}

// A draft, even one of an order that was closed since: it brought nothing in
export function removeGoodsReceipt(data: WorkspaceData, target: MockGoodsReceipt): void {
  if (target.status !== 'draft') throw conflict('stock_not_draft');
  data.purchase.receipts = data.purchase.receipts.filter((item) => item.id !== target.id);
}

// What the posted lines accepted and turned back, onto their order lines; when every goods line
// has all it ordered, the order is received. A service line never holds the order open.
function receiveOnOrder(order: MockPurchaseOrder, lines: readonly GoodsReceiptLine[]): void {
  for (const line of lines) {
    const orderLine = order.lines.find((item) => item.id === line.orderLineId);
    if (!orderLine) continue;
    orderLine.receivedQuantity = addQuantity(orderLine.receivedQuantity, line.baseQuantity);
    orderLine.rejectedQuantity = addQuantity(orderLine.rejectedQuantity, line.rejectedBaseQuantity);
  }
  const done = order.lines.every(
    (line) =>
      line.productType !== 'goods' ||
      compareQuantity(line.receivedQuantity, line.baseQuantity) >= 0,
  );
  // A new version either way: an order page open somewhere shows old received quantities
  Object.assign(order, {
    ...(done && { status: 'received' }),
    version: order.version + 1,
    updatedAt: now(),
  });
}

// The API's postAndLog(): the date, the warehouse and the order checked again, the lines checked
// against what the order still takes, the number taken, the accepted goods moved in at the order's
// price, the entry booked and the order's lines counted.
export function postGoodsReceipt(data: WorkspaceData, draft: MockGoodsReceipt): MockGoodsReceipt {
  if (draft.status !== 'draft') throw conflict('stock_not_draft');
  assertDate(data, draft.date);
  if (data.journal.lockDate !== null && draft.date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
  assertWarehouses(data, [{ field: 'warehouseId', id: draft.warehouseId }]);
  const order = receivingOrder(data, draft.orderId);
  // Again: another receipt of this order may have been posted since this one was saved
  checkOrderLines(data, order, draft.lines);
  // The accounts first: a missing one refuses the posting before anything moves
  const accounts = bookAccounts(data);
  const notBilled = accounts.use('received_not_billed');
  const lines = batchesForLots(data, draft.lines);
  // At the order's price (decision 2): the line's net, after its discount and before VAT, shared
  // by what came in. 600 of 1,000 gross worth ৳62,000 are worth ৳37,200.
  const values = lines.map((line) => {
    const orderLine = order.lines.find((item) => item.id === line.orderLineId);
    return orderLine ? prorateMoney(orderLine.net, line.baseQuantity, orderLine.baseQuantity) : '0';
  });
  // The handler runs this in transaction() (workspace-data.ts): a refused posting gives everything
  // back, the number and any new batch too, like the API's transaction
  const number = nextNumber(data, 'receipt', draft.date);
  postMoves(
    data,
    { date: draft.date, kind: 'purchase_receipt', direction: 'in', documentId: draft.id, number },
    // Only what was accepted comes in. A line that turned everything back moves nothing.
    lines.flatMap((line, index) =>
      isZeroQuantity(line.baseQuantity)
        ? []
        : [
            {
              line: index,
              warehouseId: draft.warehouseId,
              stockLine: line,
              batchId: line.batchId,
              quantity: line.baseQuantity,
              serialNumbers: line.serialNumbers,
              value: values[index] ?? '0',
            },
          ],
    ),
  );
  const total = sumMoney(values);
  const branchId = branchOf(data, draft.warehouseId);
  // Nothing when the accepted goods cost nothing (postStockEntry writes no entry for zero)
  const entry = postStockEntry(data, {
    date: draft.date,
    source: 'purchase_receipt',
    document: { id: draft.id, number },
    narration: `Goods receipt ${number}`,
    amounts: [
      { accountId: accounts.inventory, branchId, amount: total },
      { accountId: notBilled, branchId, amount: negateMoney(total) },
    ],
  });
  Object.assign(draft, {
    lines: lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
    entry,
    number,
    status: 'posted',
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  receiveOnOrder(order, draft.lines);
  return draft;
}
```

- **`saveGoodsReceipt()` takes the order apart from the fields.** A new receipt names it; a draft keeps its own
  (decision 20), so the handler passes the stored `orderId` and the edit form never sends one. The supplier is
  always the order's.
- **`receiveOnOrder()` gives the order a new version either way,** like the API: an order page open somewhere shows
  old received quantities, and its next action (close) must reload first. 17b.4 found the same on the API.
- **`postGoodsReceipt()` checks the order lines again before anything moves:** another receipt of the same order may
  have been posted since this draft was saved, and drafts hold nothing.
- **The accounts come before the number.** A missing "goods received not billed" account refuses the post before a
  number is taken or a batch made.
- **The value is `prorateMoney(net, accepted, ordered)`:** the order line's net, shared by what came in (decision
  2). 600 of 1,000 gross worth ৳62,000 are worth ৳37,200, the number the e2e test checks.
- **Only accepted goods move** (`isZeroQuantity` skips the rest), but every line keeps its index, so an error from
  `postMoves()` names the person's own line.
- **No try/catch to give the number back.** The handler runs the post in `transaction()` (decision 53), which puts
  back the whole purchase part, the stock and the journal when anything throws.
- **`postStockEntry()` writes no entry when the value is zero** (everything turned back, or a free sample), like the
  API's `entry: null`.

```ts
// --- Seed ---------------------------------------------------------------------------------------

// The garments workspace's orders (after the requisitions: the rounds name the same people). The
// requisitions stay as 17a seeded them, so PR-…-0002 still waits for its order.
//   PO-…-0001 1,000 gross of buttons from Unitex (৳71,300 with VAT): Sadia wrote it, Kamal approved
//             it as purchase manager, and the goods are two days late. Nothing came in yet.
//   a draft   the Owner's, for 500 m of jersey from Meghna Spinning Mills, never submitted
// No receipt is posted: the seeded books (reports, journal, stock values) stay as they were.
export function seedPurchaseOrders(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const [main] = data.stock.warehouses;
  const unitex = data.suppliers.suppliers.find((item) => item.name.startsWith('Unitex'));
  const meghna = data.suppliers.suppliers.find((item) => item.name.startsWith('Meghna'));
  const rate = data.sales.taxRates.find((item) => item.isDefault);
  const manager = data.people.roles.find((item) => item.name === 'Purchase manager');
  const person = (name: string) => {
    const found = data.people.members.find((member) => member.fullName === name);
    if (!found) throw new Error(`The mock has no member ${name}`);
    return { id: found.userId, name: found.fullName };
  };
  if (!main || !unitex || !meghna || !rate || !manager) return;
  const today = todayIn(data.settings.timezone);
  const daysAgo = (days: number, hour: number) => {
    const moment = new Date(Date.now() - days * 86_400_000);
    moment.setHours(hour, 0, 0, 0);
    return moment.toISOString();
  };
  // A line of the product's first variant, in a unit by its code, at a price per that unit
  const line = (code: string, unitCode: string, quantity: string, unitPrice: string) => {
    const product = data.catalog.products.find((item) => item.code === code);
    const unit = data.catalog.units.find((item) => item.code === unitCode);
    const variant = product?.variants[0];
    if (!variant || !unit) throw new Error(`The mock catalog has no ${code} in ${unitCode}`);
    return {
      variantId: variant.id,
      unitId: unit.id,
      quantity,
      description: null,
      unitPrice,
      discountType: 'percent' as const,
      discount: '0',
      taxRateId: rate.id,
      requisitionLineId: null,
    };
  };

  const buttons = savePurchaseOrder(data, {
    supplierId: unitex.id,
    date: shiftIsoDate(today, -12),
    expectedDate: shiftIsoDate(today, -2),
    warehouseId: main.id,
    supplierReference: 'PI-UT-2026-0412',
    paymentTermsDays: unitex.paymentTermsDays,
    pricesIncludeVat: false,
    note: 'Black, 18L, packed 10 gross to a carton. Gate 2, 9 am to 5 pm.',
    lines: [line('P-00003', 'gross', '1000', '62')],
  });
  const sadia = person('Sadia Islam');
  const decidedAt = daysAgo(11, 10);
  data.purchase.rounds.push({
    id: crypto.randomUUID(),
    document: 'purchase_order',
    documentId: buttons.id,
    status: 'approved',
    amount: buttons.total,
    submittedBy: sadia,
    submittedAt: daysAgo(12, 11),
    closedAt: decidedAt,
    steps: [
      {
        position: 1,
        minAmount: '50000.0000',
        role: { id: manager.id, name: manager.name },
        decision: 'approved',
        decidedBy: person('Kamal Uddin'),
        decidedAt,
        comment: 'Same price as the last order',
      },
    ],
  });
  Object.assign(buttons, {
    number: nextNumber(data, 'order', buttons.date),
    status: 'approved',
  });

  savePurchaseOrder(data, {
    supplierId: meghna.id,
    date: today,
    expectedDate: shiftIsoDate(today, 14),
    warehouseId: main.id,
    supplierReference: null,
    paymentTermsDays: meghna.paymentTermsDays,
    pricesIncludeVat: false,
    note: null,
    lines: [line('P-00002', 'm', '500', '510')],
  });
}
```

- **The seed writes the order with `savePurchaseOrder()`,** the same function the handler uses, so its totals are
  the real arithmetic (৳62,000 + 15% = ৳71,300), not typed numbers that could drift from it.
- **Kamal's round is pushed by hand** because the mock signs in as the Owner, and the engine would record the
  Owner as the approver. The comment "Same price as the last order" is what the reopen test finds in "Earlier
  rounds".
- **The order date is 12 days ago and "deliver by" 2 days ago:** that makes the "Late" pill, from the first page
  load.
- **Unitex reads Bangla** (17a's seed), so the order's email starts in Bangla, which the e2e test checks.

### The order goes to its supplier: `mocks/document-output-data.ts`

```diff
@@ -18,14 +18,17 @@ import { formatDate, formatMoney, formatNumber } from '@omnivo/i18n';
 import { OWNER } from './fixtures';
 import { findInvoice, findReceipt, toInvoice, toReceipt } from './invoice-data';
 import { MockProblem } from './mock';
+import { findPurchaseOrder } from './purchase-order-data';
 import { findCreditNote, toCreditNote } from './return-data';
 import { findCustomer } from './sales-data';
 import { findQuotation, toQuotation } from './sales-document-data';
+import { findSupplier } from './supplier-data';
 import type { WorkspaceData } from './workspace-data';
 
 // Step 16 on the mock's arrays: the PDFs, the emails and the share links of a quotation, an
 // invoice, a money receipt and a credit note, with the API's rules, shortened. There is no worker:
 // like an export (report-data.ts), a file or an email "finishes" on the first read after its delay.
+// Step 17b adds the purchase order, which goes to its supplier.
 
 // Shorter than the Send menu's 1.5 s wait, so its first poll finds the file ready
 const FILE_DELAY_MS = 1_200;
@@ -74,9 +77,11 @@ export function emptyDocumentOutput(): MockDocumentOutput {
 interface Issued {
   number: string;
   date: string;
-  customerId: string;
+  // Who receives it: the customer, or a purchase order's supplier (step 17b)
+  partyId: string;
   total: string;
-  // The quotation's "valid until" or the invoice's due date, named in the email's first message
+  // The quotation's "valid until", the invoice's due date or the order's "deliver by", named in
+  // the email's first message
   until: string | null;
   dueDate: string | null;
   amountDue: string | null;
@@ -97,7 +102,7 @@ function issuedOf(data: WorkspaceData, kind: OutputDocument, id: string): Issued
       return {
         number: doc.number,
         date: doc.date,
-        customerId: doc.customer.id,
+        partyId: doc.customer.id,
         total: doc.total,
         until: doc.validUntil,
         dueDate: null,
@@ -111,7 +116,7 @@ function issuedOf(data: WorkspaceData, kind: OutputDocument, id: string): Issued
       return {
         number: doc.number,
         date: doc.date,
-        customerId: doc.customer.id,
+        partyId: doc.customer.id,
         total: doc.total,
         until: doc.dueDate,
         dueDate: doc.dueDate,
@@ -125,7 +130,7 @@ function issuedOf(data: WorkspaceData, kind: OutputDocument, id: string): Issued
       return {
         number: doc.number,
         date: doc.date,
-        customerId: doc.customer.id,
+        partyId: doc.customer.id,
         total: doc.amount,
         until: null,
         dueDate: null,
@@ -139,7 +144,7 @@ function issuedOf(data: WorkspaceData, kind: OutputDocument, id: string): Issued
       return {
         number: doc.number,
         date: doc.date,
-        customerId: doc.customer.id,
+        partyId: doc.customer.id,
         total: doc.total,
         until: null,
         dueDate: null,
@@ -147,9 +152,33 @@ function issuedOf(data: WorkspaceData, kind: OutputDocument, id: string): Issued
         invoice: doc.invoice.number,
       };
     }
+    // Step 17b: only an approved order goes out; a draft or a pending one may still change, and a
+    // cancelled one was called off (the API's document_not_issued)
+    case 'purchase_order': {
+      const doc = findPurchaseOrder(data, id);
+      const issued = ['approved', 'received', 'closed'].includes(doc.status);
+      if (doc.number === null || !issued) return notIssued();
+      return {
+        number: doc.number,
+        date: doc.date,
+        partyId: doc.supplier.id,
+        total: doc.total,
+        until: doc.expectedDate,
+        dueDate: null,
+        amountDue: null,
+        invoice: null,
+      };
+    }
   }
 }
 
+// The person or company it goes to, as the email and the WhatsApp link need them
+function recipientOf(data: WorkspaceData, kind: OutputDocument, doc: Issued) {
+  return kind === 'purchase_order'
+    ? findSupplier(data, doc.partyId)
+    : findCustomer(data.sales, doc.partyId);
+}
+
 // ---------------------------------------------------------------------------------------------
 // The customer's words: the API's copy.ts, only the sentences the screens show
 
@@ -159,12 +188,14 @@ const TITLES = {
     invoice: 'Invoice',
     receipt: 'Money receipt',
     credit_note: 'Credit note',
+    purchase_order: 'Purchase order',
   },
   bn: {
     quotation: 'কোটেশন',
     invoice: 'ইনভয়েস',
     receipt: 'মানি রিসিট',
     credit_note: 'ক্রেডিট নোট',
+    purchase_order: 'পারচেজ অর্ডার',
   },
 } satisfies Record<LanguageCode, Record<OutputDocument, string>>;
 
@@ -187,7 +218,7 @@ function emailSubject(kind: OutputDocument, doc: Issued, company: string, langua
 function emailMessage(
   kind: OutputDocument,
   doc: Issued,
-  customer: string,
+  recipient: string,
   company: string,
   language: LanguageCode,
 ): string {
@@ -199,16 +230,24 @@ function emailMessage(
       invoice: `ইনভয়েস ${doc.number} (${amount}) সংযুক্ত করা হলো। পরিশোধের তারিখ ${until}।`,
       receipt: `আপনার পেমেন্টের জন্য ধন্যবাদ। মানি রিসিট ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
       credit_note: `ইনভয়েস ${doc.invoice ?? ''}-এর বিপরীতে ক্রেডিট নোট ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
+      purchase_order:
+        until === ''
+          ? `আমাদের পারচেজ অর্ডার ${doc.number} (${amount}) সংযুক্ত করা হলো।`
+          : `আমাদের পারচেজ অর্ডার ${doc.number} (${amount}) সংযুক্ত করা হলো। অনুগ্রহ করে ${until}-এর মধ্যে মাল পৌঁছে দিন।`,
     } satisfies Record<OutputDocument, string>;
-    return `প্রিয় ${customer},\n\n${lead[kind]}\n\nধন্যবাদান্তে,\n${OWNER.fullName}\n${company}`;
+    return `প্রিয় ${recipient},\n\n${lead[kind]}\n\nধন্যবাদান্তে,\n${OWNER.fullName}\n${company}`;
   }
   const lead = {
     quotation: `Please find attached our quotation ${doc.number} for ${amount}.`,
     invoice: `Please find attached invoice ${doc.number} for ${amount}, due on ${until}.`,
     receipt: `Thank you for your payment. Please find attached money receipt ${doc.number} for ${amount}.`,
     credit_note: `Please find attached credit note ${doc.number} for ${amount}, against invoice ${doc.invoice ?? ''}.`,
+    purchase_order:
+      until === ''
+        ? `Please find attached our purchase order ${doc.number} for ${amount}.`
+        : `Please find attached our purchase order ${doc.number} for ${amount}. Please deliver by ${until}.`,
   } satisfies Record<OutputDocument, string>;
-  return `Dear ${customer},\n\n${lead[kind]}\n\nRegards,\n${OWNER.fullName}\n${company}`;
+  return `Dear ${recipient},\n\n${lead[kind]}\n\nRegards,\n${OWNER.fullName}\n${company}`;
 }
 
 function shareMessage(
@@ -310,12 +349,12 @@ export function emailDraft(
   language: LanguageCode,
 ): DocumentEmailDraft {
   const doc = issuedOf(data, kind, id);
-  const customer = findCustomer(data.sales, doc.customerId);
+  const recipient = recipientOf(data, kind, doc);
   const company = data.settings.companyName;
   return {
-    to: customer.email ?? '',
+    to: recipient.email ?? '',
     subject: emailSubject(kind, doc, company, language),
-    message: emailMessage(kind, doc, customer.name, company, language),
+    message: emailMessage(kind, doc, recipient.name, company, language),
   };
 }
 
@@ -394,7 +433,7 @@ export function createShare(
   language: LanguageCode,
 ): CreatedShare {
   const doc = issuedOf(data, kind, id);
-  const customer = findCustomer(data.sales, doc.customerId);
+  const recipient = recipientOf(data, kind, doc);
   const now = Date.now();
   const share: MockDocumentShare = {
     id: crypto.randomUUID(),
@@ -418,7 +457,7 @@ export function createShare(
     share: toDocumentShare(share),
     url,
     message,
-    whatsAppUrl: whatsAppUrl(customer.phone, message),
+    whatsAppUrl: whatsAppUrl(recipient.phone, message),
   };
 }
 
@@ -600,7 +639,7 @@ export function publicDocument(data: WorkspaceData, token: string): PublicDocume
         kind: 'invoice',
         number: 'INV-2026-27-0042',
         date: today,
-        customer: 'Aarong',
+        recipient: 'Aarong',
         total: '115000.0000',
         currency: data.settings.baseCurrency,
         dueDate: daysAfter(today, 30),
@@ -615,7 +654,7 @@ export function publicDocument(data: WorkspaceData, token: string): PublicDocume
         kind: 'quotation',
         number: 'QT-2026-27-0003',
         date: today,
-        customer: 'Aarong',
+        recipient: 'Aarong',
         total: '72427.5000',
         currency: data.settings.baseCurrency,
         dueDate: null,
@@ -630,7 +669,7 @@ export function publicDocument(data: WorkspaceData, token: string): PublicDocume
         kind: 'receipt',
         number: 'MR-2026-27-0007',
         date: today,
-        customer: 'Bengal Buying House Ltd.',
+        recipient: 'Bengal Buying House Ltd.',
         total: '25000.0000',
         currency: data.settings.baseCurrency,
         dueDate: null,
```

- **`Issued.customerId` is `partyId`:** it is a supplier for an order. `recipientOf()` finds the supplier or the
  customer by the kind, the same rule as the app's `recipientRole()` (decision 48).
- **Only an approved, received or closed order goes out,** else `document_not_issued`, like the API (17b.3): a draft
  or a pending order may still change, and a cancelled one was called off.
- **The email's first sentence asks for delivery by the order's date,** in both languages, as the API's copy does;
  without a date it only says what is attached.
- **The public page's demo links say `recipient`,** the contract's new name (17b.1). These three were the last of
  the 22 errors.

### The workspace: `mocks/workspace-data.ts`

```diff
@@ -39,6 +39,7 @@ import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
+import { seedPurchaseOrders } from './purchase-order-data';
 import type { MockExport } from './report-data';
 import { emptyPurchase, type MockPurchase, seedPurchase } from './requisition-data';
 import { emptyReturns, type MockReturns } from './return-data';
@@ -87,7 +88,8 @@ export interface WorkspaceData {
   documentOutput: MockDocumentOutput;
   // Suppliers and their groups (step 17a)
   suppliers: MockSuppliers;
-  // Approval levels and rounds, and requisitions (step 17a)
+  // Approval levels and rounds, and requisitions (step 17a); purchase orders and goods receipts
+  // (step 17b)
   purchase: MockPurchase;
 }
 
@@ -122,6 +124,8 @@ function seed(workspace: Workspace): WorkspaceData {
       ...DEFAULT_SETTINGS,
       logo: null,
       allowNegativeStock: false,
+      // Step 17b: a receipt takes no more than the order, until the owner allows a little more
+      overReceiptPercent: '0.00',
       // The pharmacy sells at the printed MRP, VAT included; the garments maker quotes before VAT
       pricesIncludeVat: !garments,
       version: 1,
@@ -169,6 +173,8 @@ function seed(workspace: Workspace): WorkspaceData {
   seedDocumentOutput(data, garments);
   // After the stock and the team: the lines' costs are its averages, the rounds name members
   seedPurchase(data, garments);
+  // After the requisitions: the approval levels and the people are theirs
+  seedPurchaseOrders(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -253,6 +259,8 @@ export function transaction<T>(data: WorkspaceData, fn: () => T): T {
     salesDocuments: data.salesDocuments,
     billing: data.billing,
     returns: data.returns,
+    // Step 17b: a goods receipt moves its order's received quantities and takes a number
+    purchase: data.purchase,
     audit: data.audit,
   });
   try {
```

- **`overReceiptPercent: '0.00'`:** the way the API sends a `NUMERIC(5,2)` default. A receipt takes no more than the
  order until the owner changes it.
- **`seedPurchaseOrders()` runs after `seedPurchase()`:** the order's round names Kamal's role and level, which the
  requisition seed made.
- **`transaction()` copies the purchase part too** (decision 53).

### The routes: `mocks/handlers.ts`

```diff
@@ -1,7 +1,10 @@
 import {
   type Account,
   accountTypeFits,
+  addQuantity,
+  APPROVAL_DOCUMENTS,
   type AuthSession,
+  compareQuantity,
   type ErrorCode,
   type Preferences,
   type ProductCategory,
@@ -127,6 +130,24 @@ import {
   productSummaryOf,
   toImport,
 } from './product-data';
+import {
+  cancelPurchaseOrder,
+  closePurchaseOrder,
+  findGoodsReceipt,
+  findPurchaseOrder,
+  listGoodsReceipts,
+  listPurchaseOrders,
+  postGoodsReceipt,
+  purchaseOrderSummaryOf,
+  removeGoodsReceipt,
+  removePurchaseOrder,
+  reopenPurchaseOrder,
+  saveGoodsReceipt,
+  savePurchaseOrder,
+  submitPurchaseOrder,
+  toGoodsReceipt,
+  toPurchaseOrder,
+} from './purchase-order-data';
 import {
   assertCustomerUnused,
   assertGroupNameFree,
@@ -178,12 +199,14 @@ import {
 import {
   approvalsNeedRole,
   cancelRequisition,
+  closeRequisition,
   decide,
   describeLevels,
   findRequisition,
   forgetRole,
   listRequisitions,
   lookupCosts,
+  openLines,
   removeRequisition,
   reopenRequisition,
   requisitionSummaryOf,
```

```diff
@@ -295,6 +318,7 @@ function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
 function editable(settings: Settings) {
   return {
     allowNegativeStock: settings.allowNegativeStock,
+    overReceiptPercent: settings.overReceiptPercent,
     pricesIncludeVat: settings.pricesIncludeVat,
     companyName: settings.companyName,
     legalName: settings.legalName,
@@ -735,8 +759,21 @@ export const handlers = [
         });
       }
       const before = editable(data.settings);
-      data.settings = { ...data.settings, ...fields, version: version + 1 };
-      record(data, 'settings.updated', 'workspace', workspace.tenantId, diff(before, fields));
+      // Step 17b: the form's "3" is stored as NUMERIC(5,2), "3.00" (it has at most 2 decimals, so
+      // cutting the 4 that addQuantity() gives is exact); an unchanged percent is not logged
+      const overReceiptPercent = addQuantity(fields.overReceiptPercent, '0').slice(0, -2);
+      const unchanged = compareQuantity(overReceiptPercent, before.overReceiptPercent) === 0;
+      data.settings = { ...data.settings, ...fields, overReceiptPercent, version: version + 1 };
+      record(
+        data,
+        'settings.updated',
+        'workspace',
+        workspace.tenantId,
+        diff(before, {
+          ...fields,
+          overReceiptPercent: unchanged ? before.overReceiptPercent : fields.overReceiptPercent,
+        }),
+      );
       await delay();
       return reply(routes.settings.update, data.settings);
     }),
```

- **The settings save stores the percent the API's way:** the form sends "3", the API stores and sends "3.00".
  `addQuantity(value, '0')` gives 4 decimals, and the percent has at most 2 (the contract checks), so cutting the
  last two digits is exact. Without it the mock would send "3" where the API sends "3.00", and the settings form
  would show a different value in `dev:mock` than against the API.
- **An unchanged percent is not logged,** like the API: "3" and "3.00" are the same number, and the audit log must
  not show a change nobody made.

```diff
@@ -3624,8 +3661,11 @@ export const handlers = [
     }),
   ),
 
+  // One card per kind of document, in the contract's order (step 17b adds purchase orders)
   mock(routes.approvalRules.list, () =>
-    reply(routes.approvalRules.list, { items: [toRule(current(), 'requisition')] }),
+    reply(routes.approvalRules.list, {
+      items: APPROVAL_DOCUMENTS.map((document) => toRule(current(), document)),
+    }),
   ),
 
   mock(
@@ -3664,7 +3704,7 @@ export const handlers = [
         record(
           data,
           action === 'approve' ? 'approval.approved' : 'approval.rejected',
-          'requisition',
+          document,
           id,
           diff(
             {},
@@ -3683,9 +3723,10 @@ export const handlers = [
 
   mock(routes.requisitions.list, ({ request }) => {
     const query = readQuery(routes.requisitions.list.query, request);
-    const page = pageOf(listRequisitions(current(), query), query);
+    const data = current();
+    const page = pageOf(listRequisitions(data, query), query);
     return reply(routes.requisitions.list, {
-      items: page.items.map(requisitionSummaryOf),
+      items: page.items.map((item) => requisitionSummaryOf(data, item)),
       nextCursor: page.nextCursor,
     });
   }),
@@ -3810,7 +3851,7 @@ export const handlers = [
       const target = findRequisition(data, id);
       checkVersion(target.version, version);
       const before = target.status;
-      cancelRequisition(target);
+      cancelRequisition(data, target);
       record(
         data,
         'requisition.cancelled',
```

- **The approval levels page gets one card per kind of document,** in the contract's order (`APPROVAL_DOCUMENTS`), so
  the purchase order card shows without a change here when a new kind is added.
- **A decision's audit row names its own kind of document,** not always "requisition".
- **`requisitionSummaryOf()` takes the data now,** to work out the order state, and `cancelRequisition()` too, to
  know whether an order buys for it.

```diff
@@ -3829,4 +3870,276 @@ export const handlers = [
       return reply(routes.purchaseCosts.lookup, lookupCosts(current(), body));
     }),
   ),
+
+  // ---------------------------------------------------------------------------------------------
+  // Purchase orders and goods receipts (step 17b)
+
+  mock(
+    routes.requisitions.close,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.requisitions.close.params.parse(params);
+      const { version } = await readBody(routes.requisitions.close.body, request);
+      const data = current();
+      const target = findRequisition(data, id);
+      checkVersion(target.version, version);
+      closeRequisition(data, target);
+      record(
+        data,
+        'requisition.closed',
+        'requisition',
+        id,
+        diff({ status: 'approved' }, { status: target.status }),
+      );
+      return reply(routes.requisitions.close, toRequisition(data, target));
+    }),
+  ),
+
+  mock(routes.requisitionLines.open, ({ request }) => {
+    const { limit, cursor, ...query } = readQuery(routes.requisitionLines.open.query, request);
+    return reply(
+      routes.requisitionLines.open,
+      pageOf(openLines(current(), query), { limit, cursor }),
+    );
+  }),
+
+  mock(routes.purchaseOrders.list, ({ request }) => {
+    const query = readQuery(routes.purchaseOrders.list.query, request);
+    const page = pageOf(listPurchaseOrders(current(), query), query);
+    return reply(routes.purchaseOrders.list, {
+      items: page.items.map(purchaseOrderSummaryOf),
+      nextCursor: page.nextCursor,
+    });
+  }),
+
+  mock(
+    routes.purchaseOrders.get,
+    guarded(({ params }) => {
+      const { id } = routes.purchaseOrders.get.params.parse(params);
+      const data = current();
+      return reply(routes.purchaseOrders.get, toPurchaseOrder(data, findPurchaseOrder(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.purchaseOrders.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.purchaseOrders.create.body, request);
+      const data = current();
+      const created = savePurchaseOrder(data, body);
+      record(
+        data,
+        'purchase_order.created',
+        'purchase_order',
+        created.id,
+        diff({}, { supplier: created.supplier.name, total: created.total }),
+      );
+      await delay();
+      return reply(routes.purchaseOrders.create, toPurchaseOrder(data, created));
+    }),
+  ),
+
+  mock(
+    routes.purchaseOrders.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.purchaseOrders.update.params.parse(params);
+      const { version, ...body } = await readBody(routes.purchaseOrders.update.body, request);
+      const data = current();
+      const target = findPurchaseOrder(data, id);
+      checkVersion(target.version, version);
+      const before = { supplier: target.supplier.name, total: target.total };
+      savePurchaseOrder(data, body, target);
+      record(
+        data,
+        'purchase_order.updated',
+        'purchase_order',
+        id,
+        diff(before, { supplier: target.supplier.name, total: target.total }),
+      );
+      await delay();
+      return reply(routes.purchaseOrders.update, toPurchaseOrder(data, target));
+    }),
+  ),
+
+  mock(
+    routes.purchaseOrders.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.purchaseOrders.remove.params.parse(params);
+      const { version } = readQuery(routes.purchaseOrders.remove.query, request);
+      const data = current();
+      const target = findPurchaseOrder(data, id);
+      checkVersion(target.version, version);
+      removePurchaseOrder(data, target);
+      record(
+        data,
+        'purchase_order.deleted',
+        'purchase_order',
+        id,
+        diff({ supplier: target.supplier.name }, { supplier: null }),
+      );
+      return reply(routes.purchaseOrders.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.purchaseOrders.submit,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.purchaseOrders.submit.params.parse(params);
+      const { version } = await readBody(routes.purchaseOrders.submit.body, request);
+      const data = current();
+      const target = findPurchaseOrder(data, id);
+      checkVersion(target.version, version);
+      const steps = submitPurchaseOrder(data, target);
+      record(
+        data,
+        'approval.submitted',
+        'purchase_order',
+        id,
+        diff({}, { amount: target.total, steps, status: target.status }),
+      );
+      await delay();
+      return reply(routes.purchaseOrders.submit, toPurchaseOrder(data, target));
+    }),
+  ),
+
+  // Reopen, close and cancel: the same request, each with its own rule and audit row
+  ...(['reopen', 'close', 'cancel'] as const).map((action) =>
+    mock(
+      routes.purchaseOrders[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.purchaseOrders[action].params.parse(params);
+        const { version } = await readBody(routes.purchaseOrders[action].body, request);
+        const data = current();
+        const target = findPurchaseOrder(data, id);
+        checkVersion(target.version, version);
+        const before = target.status;
+        const change = {
+          reopen: () => {
+            reopenPurchaseOrder(data, target);
+            return 'approval.reopened' as const;
+          },
+          close: () => {
+            closePurchaseOrder(data, target);
+            return 'purchase_order.closed' as const;
+          },
+          cancel: () => {
+            cancelPurchaseOrder(data, target);
+            return 'purchase_order.cancelled' as const;
+          },
+        }[action];
+        const auditAction = change();
+        record(
+          data,
+          auditAction,
+          'purchase_order',
+          id,
+          diff({ status: before }, { status: target.status }),
+        );
+        return reply(routes.purchaseOrders[action], toPurchaseOrder(data, target));
+      }),
+    ),
+  ),
+
+  mock(routes.goodsReceipts.list, ({ request }) => {
+    const query = readQuery(routes.goodsReceipts.list.query, request);
+    return reply(routes.goodsReceipts.list, pageOf(listGoodsReceipts(current(), query), query));
+  }),
+
+  mock(
+    routes.goodsReceipts.get,
+    guarded(({ params }) => {
+      const { id } = routes.goodsReceipts.get.params.parse(params);
+      const data = current();
+      return reply(routes.goodsReceipts.get, toGoodsReceipt(data, findGoodsReceipt(data, id)));
+    }),
+  ),
+
+  // "Post goods receipt" on a new form: saved and posted in one step, or nothing at all
+  mock(
+    routes.goodsReceipts.create,
+    guarded(async ({ request }) => {
+      const { post, orderId, ...input } = await readBody(routes.goodsReceipts.create.body, request);
+      const data = current();
+      const saved = transaction(data, () => {
+        const draft = saveGoodsReceipt(data, orderId, input);
+        record(data, 'goods_receipt.created', 'goods_receipt', draft.id);
+        if (!post) return draft;
+        postGoodsReceipt(data, draft);
+        record(
+          data,
+          'goods_receipt.posted',
+          'goods_receipt',
+          draft.id,
+          diff({}, { number: draft.number, entry: draft.entry?.number ?? null }),
+        );
+        return draft;
+      });
+      await delay();
+      return reply(routes.goodsReceipts.create, toGoodsReceipt(data, saved));
+    }),
+  ),
+
+  // The edit form sends no order: a receipt keeps its own (decision 20)
+  mock(
+    routes.goodsReceipts.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.goodsReceipts.update.params.parse(params);
+      const { post, version, ...input } = await readBody(routes.goodsReceipts.update.body, request);
+      const data = current();
+      const target = findGoodsReceipt(data, id);
+      checkVersion(target.version, version);
+      const saved = transaction(data, () => {
+        const draft = saveGoodsReceipt(data, target.orderId, input, target);
+        record(data, 'goods_receipt.updated', 'goods_receipt', id);
+        if (!post) return draft;
+        postGoodsReceipt(data, draft);
+        record(
+          data,
+          'goods_receipt.posted',
+          'goods_receipt',
+          id,
+          diff({}, { number: draft.number, entry: draft.entry?.number ?? null }),
+        );
+        return draft;
+      });
+      await delay();
+      return reply(routes.goodsReceipts.update, toGoodsReceipt(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.goodsReceipts.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.goodsReceipts.remove.params.parse(params);
+      const { version } = readQuery(routes.goodsReceipts.remove.query, request);
+      const data = current();
+      const target = findGoodsReceipt(data, id);
+      checkVersion(target.version, version);
+      removeGoodsReceipt(data, target);
+      record(data, 'goods_receipt.deleted', 'goods_receipt', id);
+      return reply(routes.goodsReceipts.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.goodsReceipts.post,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.goodsReceipts.post.params.parse(params);
+      const { version } = await readBody(routes.goodsReceipts.post.body, request);
+      const data = current();
+      const target = findGoodsReceipt(data, id);
+      checkVersion(target.version, version);
+      transaction(data, () => {
+        postGoodsReceipt(data, target);
+        record(
+          data,
+          'goods_receipt.posted',
+          'goods_receipt',
+          id,
+          diff({}, { number: target.number, entry: target.entry?.number ?? null }),
+        );
+      });
+      await delay();
+      return reply(routes.goodsReceipts.post, toGoodsReceipt(data, target));
+    }),
+  ),
 ];
```

- **Every route of `routes.purchaseOrders`, `routes.goodsReceipts`, `routes.requisitionLines` and the requisition's
  close,** each reading its body with the contract's schema (`readBody`) and answering with the contract's response
  (`reply`), like every mock route. A body the contract would refuse is refused here too.
- **Reopen, close and cancel are one handler with a table of three actions,** each with its own rule and audit
  action: the request, the version check and the answer are the same.
- **"Post goods receipt" on a new or changed form is save and post in one `transaction()`:** the API saves and posts
  in one database transaction, so a refused post leaves no draft behind on a new form, and the old draft as it was
  on a changed one.
- **The posted audit row names the receipt's number and its entry,** like the API's `goods_receipt.posted`.

### A cross-part fix: `packages/ui/src/components/segmented-control.tsx`

```diff
@@ -21,8 +21,10 @@ export function SegmentedControl<TValue extends string>({
   return (
     // A fieldset is never narrower than its content unless told (min-w-0). With many options
     // (a sales order has six statuses) the control scrolls inside its own box on a phone, like
-    // the nav row, instead of pushing the page sideways.
-    <fieldset className="inline-flex max-w-full min-w-0 overflow-x-auto rounded-lg border border-line-strong bg-surface p-0.5">
+    // the nav row, instead of pushing the page sideways. `relative` (step 17b): the radios are
+    // sr-only, so absolutely placed; without a placed box around them they are clipped by nothing
+    // and the ones past the edge widen the page (a purchase order list has eight options).
+    <fieldset className="relative inline-flex max-w-full min-w-0 overflow-x-auto rounded-lg border border-line-strong bg-surface p-0.5">
       <legend className="sr-only">{label}</legend>
       {options.map((option) => (
         <label
```

- **`relative` on the `fieldset`** (decision 54). An absolutely placed element is clipped by an `overflow` box only
  when that box, or a box inside it, is its containing block: the nearest ancestor that is not `position: static`.
  Without `relative`, the radios' containing block was far up the page, the `overflow-x-auto` did not clip them, and
  the last radios of an eight-option control sat 211 px past the edge of a phone screen. The visible labels were
  fine all along, which is why only `expectNoSideScroll()` noticed.
- **Rebuild `@omnivo/ui` before the e2e tests** (`pnpm --filter @omnivo/ui build`): the app reads its built
  `dist/`.

### The end-to-end tests: `e2e/purchase-orders.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 17b in the mock garments workspace, where the signed-in person is the Owner. Orders from
// ৳50,000 with VAT need the Purchase manager (Kamal Uddin), and an Owner's own orders are approved
// when submitted (17a, decision 14). The seed:
//   PO-…-0001 1,000 gross of shirt buttons from Unitex Trims & Accessories (৳71,300 with VAT),
//             approved by Kamal, two days late, nothing received yet. Unitex reads Bangla.
//   a draft   the Owner's, 500 m of jersey from Meghna Spinning Mills, never submitted
// and 17a's PR-…-0002: 20 cartons of mailer bags, approved, not ordered yet.

const PO = (number: number) => new RegExp(`PO-\\d{4}-\\d{2}-${String(number).padStart(4, '0')}`);
const PR_2 = /PR-\d{4}-\d{2}-0002/;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function openOrder(page: Page, name: RegExp) {
  await openFromNav(page, 'Purchase orders');
  await listItem(page, name).click();
}

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

test('lists the orders: late, waiting for goods, and a draft', async ({ page }) => {
  await openFromNav(page, 'Purchase orders');
  await expect(listItem(page, PO(1))).toContainText('Approved');
  await expect(listItem(page, PO(1))).toContainText('Late');
  await expect(listItem(page, PO(1))).toContainText('৳71,300');
  await expect(listItem(page, /Meghna Spinning Mills/)).toContainText('Draft');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'To receive' }).check({ force: true });
  await expect(listItem(page, PO(1))).toBeVisible();
  await expect(listItem(page, /Meghna Spinning Mills/)).toHaveCount(0);
});

// "Make purchase order" on PR-…-0002, for Gazipur Carton Industries, with its one line
async function orderMailers(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Requisitions' }).click();
  await listItem(page, PR_2).click();
  await expect(page.getByRole('heading', { level: 1, name: PR_2 })).toBeVisible();
  await page.getByRole('button', { name: 'Make purchase order' }).click();

  // The lines still to order open at once, narrowed to this requisition (decision 45); what is
  // left is counted in the base unit, 20 cartons of 500
  let picker = page.getByRole('dialog', { name: 'Lines still to order' });
  await expect(picker.getByText('10,000 pcs left to order')).toBeVisible();
  // The supplier first, so the line starts at that supplier's price
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1, name: 'New purchase order' })).toBeVisible();
  await page.getByRole('button', { name: 'Supplier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('carton');
  await page.getByRole('option', { name: /Gazipur Carton Industries/ }).click();

  await page.getByRole('button', { name: 'Add lines still to order' }).click();
  picker = page.getByRole('dialog', { name: 'Lines still to order' });
  const row = picker.getByRole('listitem').filter({ hasText: 'Poly mailer bag 10x14' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
}
```

- **`orderMailers()` is the start two tests share:** "Make purchase order" on PR-…-0002, the dialog that opens at
  once (decision 45), the supplier first and then the line. The supplier comes first so that the line is priced
  for that supplier; picked after the line, the form would offer "Use this supplier's last prices".
- **"10,000 pcs left to order":** the dialog counts what is left in the base unit (20 cartons of 500), like every
  "left" in 17b.
- **The heading is checked after the dialog closes.** A modal dialog hides the rest of the page from the
  accessibility tree, so the page's heading cannot be found while it is open.

```ts
test('makes a purchase order from an approved requisition, and the requisition shows it ordered', async ({
  page,
}) => {
  await orderMailers(page);
  // Nobody bought mailers yet, so the price starts at the average cost: ৳6.50 × 500 a carton
  await expect(line(page, 1).getByLabel('Quantity')).toHaveValue('20');
  await expect(line(page, 1).getByText('From the average cost')).toBeVisible();
  await expect(line(page, 1).getByText(/^For PR-\d{4}-\d{2}-0002$/)).toBeVisible();
  // ৳65,000 + 15% VAT
  await expect(page.getByText('৳74,750.00').first()).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, 'Draft saved');

  await expect(page.getByRole('heading', { level: 1, name: 'Draft purchase order' })).toBeVisible();
  await expect(page.getByText('Purchase manager · from ৳50,000')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0002 approved$/);
  await expect(page.getByRole('heading', { level: 1, name: PO(2) })).toBeVisible();
  await expect(page.getByText('An Owner submitted it, so it was approved at once.')).toBeVisible();

  // The order names its requisition, and the requisition its order
  await page.getByRole('link', { name: PR_2 }).click();
  await expect(page.getByRole('heading', { level: 1, name: PR_2 })).toBeVisible();
  await expect(page.getByText('Ordered', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: PO(2) })).toBeVisible();
  // An order buys for it, so it is closed, no longer cancelled or reopened (decision 27)
  await expect(page.getByRole('button', { name: 'Close requisition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel requisition' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeHidden();
  await expectNoSideScroll(page);
});

test('orders part of a requisition, then closes the rest', async ({ page }) => {
  await orderMailers(page);
  // 12 of the 20 cartons: ৳39,000 + 15% VAT, below every level
  await line(page, 1).getByLabel('Quantity').fill('12');
  await expect(page.getByText('৳44,850.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, 'Draft saved');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0002 approved$/);

  await page.getByRole('link', { name: PR_2 }).click();
  await expect(page.getByText('Partly ordered', { exact: true }).first()).toBeVisible();
  // The other 8 cartons will not be bought
  await page.getByRole('button', { name: 'Close requisition' }).click();
  const dialog = page.getByRole('dialog', { name: PR_2 });
  await dialog.getByRole('button', { name: 'Close requisition' }).click();
  await toastShown(page, /^PR-\d{4}-\d{2}-0002 closed$/);
  await expect(page.getByText('Closed. What was not ordered will not be.')).toBeVisible();

  // Its rest is no longer offered to an order, and no other requisition for the Main store is
  // approved
  await openFromNav(page, 'Purchase orders');
  await page.getByRole('button', { name: 'New purchase order' }).click();
  await page.getByLabel('Deliver to').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Add lines still to order' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Lines still to order' })
      .getByText('Nothing is left to order for this warehouse.'),
  ).toBeVisible();
});
```

- **The first test makes and submits an order,** then follows the order's link to its requisition, which now shows
  "Ordered", links back, and offers "Close requisition" instead of Cancel and Reopen (decision 27).
- **The second orders 12 of the 20 cartons,** below every level (৳44,850), so the requisition is "Partly ordered";
  closing it takes the rest out of "Lines still to order", which then says nothing is left for the Main store.

```ts
test('receives part of an order with a rejection, posts it, and closes the rest', async ({
  page,
}) => {
  await openOrder(page, PO(1));
  await expect(page.getByRole('heading', { level: 1, name: PO(1) })).toBeVisible();
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New goods receipt' })).toBeVisible();

  // The order's rest comes in by itself; more than the order allows is refused (0% in Settings)
  await expect(line(page, 1).getByLabel('Accepted')).toHaveValue('1000');
  await line(page, 1).getByLabel('Accepted').fill('1100');
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await expect(line(page, 1).getByText(/^This is more than the order allows/)).toBeVisible();

  // 600 gross were good, 20 gross were cracked: a rejection says why
  await line(page, 1).getByLabel('Accepted').fill('600');
  await line(page, 1).getByLabel('Rejected').fill('20');
  await expect(line(page, 1).getByText('620 gross came', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await expect(
    line(page, 1).getByText('Say why the goods were rejected, like "wet" or "wrong shade".'),
  ).toBeVisible();
  await line(page, 1).getByLabel('Why it was rejected').fill('Cracked in transit');
  await page.getByLabel(/^Supplier’s challan/).fill('CH-UT-0788');
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);

  // At the order's price: 600 of 1,000 gross worth ৳62,000 = ৳37,200, booked in the journal
  await expect(page.getByRole('heading', { level: 1, name: /GRN-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('৳37,200.00').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toBeVisible();
  await expectNoSideScroll(page);

  // The order counts it, in pieces: 600 × 144 accepted, 20 × 144 turned back
  await page.getByRole('link', { name: PO(1) }).click();
  await expect(page.getByRole('heading', { level: 1, name: PO(1) })).toBeVisible();
  await expect(page.getByText('Partly received').first()).toBeVisible();
  await expect(page.getByText('86,400 pcs').first()).toBeVisible();
  await expect(page.getByText('2,880 pcs').first()).toBeVisible();
  // Goods came in, so it is closed, not reopened
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeHidden();
  await page.getByRole('button', { name: 'Close order' }).click();
  const dialog = page.getByRole('dialog', { name: PO(1) });
  await dialog.getByRole('button', { name: 'Close order' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 closed$/);
  await expect(page.getByText('Closed. What did not come in was dropped.')).toBeVisible();
});

test('writes a goods receipt from its own page, keeps it a draft, and posts it later', async ({
  page,
}) => {
  await openFromNav(page, 'Goods receipts');
  // No receipt yet: the empty state offers the same button as the page header
  await expect(page.getByText('No goods receipts yet')).toBeVisible();
  await page.getByRole('button', { name: 'New goods receipt' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New goods receipt' })).toBeVisible();
  // The supplier narrows the order box to its approved orders with goods to come
  await expect(page.getByLabel('Purchase order')).toBeDisabled();
  await page.getByRole('button', { name: 'Supplier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search suppliers' }).fill('unitex');
  await page.getByRole('option', { name: /Unitex Trims/ }).click();
  await page.getByLabel('Purchase order').selectOption({ index: 1 });
  await expect(line(page, 1).getByLabel('Accepted')).toHaveValue('1000');
  await line(page, 1).getByLabel('Accepted').fill('400');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, 'Draft saved');
  await expect(page.getByRole('heading', { level: 1, name: 'Draft goods receipt' })).toBeVisible();

  // A draft receipt holds the order: it can no longer go back to draft
  await openOrder(page, PO(1));
  // Its receipts card lists the draft (no number yet), with its date and pill
  await expect(page.getByRole('link', { name: /^Draft/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeHidden();

  await openFromNav(page, 'Goods receipts');
  await expect(listItem(page, /Unitex Trims/)).toContainText('Draft');
  await listItem(page, /Unitex Trims/).click();
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);
  await expect(page.getByText('৳24,800.00').first()).toBeVisible();
  await expectNoSideScroll(page);
});

test('the over-receipt percent in Settings lets a little more in', async ({ page }) => {
  await openFromNav(page, 'Settings');
  await page.getByLabel('Receive over the order').fill('5');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Settings saved');

  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Receive goods' }).click();
  // 1,000 gross + 5%, in pieces: 1,050 × 144
  await expect(line(page, 1).getByText(/Up to 1,51,200 pcs may come/)).toBeVisible();
  await line(page, 1).getByLabel('Accepted').fill('1040');
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await toastShown(page, /^GRN-\d{4}-\d{2}-0001 posted$/);

  await page.getByRole('link', { name: PO(1) }).click();
  await expect(page.getByText('Everything on the order came in.')).toBeVisible();
  await expect(page.getByText('Received', { exact: true }).first()).toBeVisible();
});
```

- **The receive test walks the gate's three mistakes in order:** more than the order (`grn_over_order`), a
  rejection without a reason (the contract's own check, before anything is sent), then the right receipt. It checks
  the value (৳37,200), the journal link, the counts on the order in pieces (86,400 accepted, 2,880 rejected), and
  that "Reopen" is gone once goods came in.
- **The goods receipt page test picks the supplier and then the order,** the path a store keeper takes when a truck
  arrives without anyone opening the order. A draft receipt shows on the order's page and hides "Reopen" (decision
  21); posting it later from the list values 400 gross at ৳24,800.
- **The settings test changes the percent to 5 and receives 1,040 gross of 1,000:** the form says "Up to 1,51,200
  pcs may come" (1,050 gross in pieces), the post goes through, and the order is Received.

```ts
test('reopens an approved order, changes it and submits it again, then cancels it', async ({
  page,
}) => {
  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Reopen' }).click();
  let dialog = page.getByRole('dialog', { name: PO(1) });
  await dialog.getByRole('button', { name: 'Reopen' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 is a draft again$/);
  await expect(
    page.getByText(/^This draft keeps its number PO-\d{4}-\d{2}-0001\./).first(),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  // The supplier stays: the number was given to Unitex
  await expect(page.getByRole('button', { name: 'Supplier', exact: true })).toBeDisabled();
  await line(page, 1).getByLabel('Quantity').fill('800');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 saved$/);
  // 800 × ৳62 + 15% VAT
  await expect(page.getByText('৳57,040.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 approved$/);
  // Kamal's round stays in its history
  await page.getByText('Earlier rounds').click();
  await expect(page.getByText('Round 1')).toBeVisible();
  await expect(page.getByText('Same price as the last order', { exact: false })).toBeVisible();

  // Nothing came in yet, so it can still be called off
  await page.getByRole('button', { name: 'Cancel order' }).click();
  dialog = page.getByRole('dialog', { name: PO(1) });
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, /^PO-\d{4}-\d{2}-0001 cancelled$/);
  await expect(page.getByText('Cancelled. It stays here for the record.')).toBeVisible();
  await expectNoSideScroll(page);
});

test('deletes a draft that was never submitted', async ({ page }) => {
  await openOrder(page, /Meghna Spinning Mills/);
  await expect(page.getByRole('heading', { level: 1, name: 'Draft purchase order' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete draft' }).click();
  await page.getByRole('button', { name: 'Delete this draft' }).click();
  await toastShown(page, 'Draft deleted');
  await expect(listItem(page, /Meghna Spinning Mills/)).toHaveCount(0);
});

test("emails an order to its supplier in the supplier's language", async ({ page }) => {
  await openOrder(page, PO(1));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Email', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Email PO-\d{4}-\d{2}-0001/ });
  // Unitex reads Bangla, and has no email address yet
  await expect(dialog.getByLabel('Language')).toHaveValue('bn');
  await expect(dialog.getByLabel('Subject')).toHaveValue(
    /^Rahman Garments Ltd\. থেকে পারচেজ অর্ডার PO-\d{4}-\d{2}-0001$/,
  );
  await expect(
    dialog.getByText('This supplier has no email address.', { exact: false }),
  ).toBeVisible();
  await dialog.getByLabel('To', { exact: true }).fill('orders@unitextrims.com');
  await dialog.getByRole('button', { name: 'Send email' }).click();
  await toastShown(page, 'Sending to orders@unitextrims.com');
  await expectNoSideScroll(page);
});
```

- **Reopening keeps the number and the supplier:** the supplier button is disabled on the edit form, and Kamal's
  round stays under "Earlier rounds" after the Owner submits it again.
- **The email test checks the language, the subject and the missing address** of a supplier who reads Bangla, then
  sends to a typed address and waits for "Sending to …".

### One older test: `e2e/onboarding.e2e.ts`

```diff
@@ -59,9 +59,10 @@ test('a new workspace goes through the setup wizard', async ({ page }) => {
   // short "Preparing the roles…" state: on a slow machine the 2-second job is done before we look
   await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();
   // The second pick is the one that was sent: garments roles, not pharma ones — and the chart
-  // came with them (the mock's garments chart has 47 accounts: 41, and step 14's six for stock)
+  // came with them (the mock's garments chart has 48 accounts: 41, step 14's six for stock, and
+  // step 17b's goods received not billed)
   await expect(page.getByRole('status')).toHaveText(
-    /Roles ready: Accountant, Merchandiser, Store keeper\. Chart of accounts: 47 accounts\./,
+    /Roles ready: Accountant, Merchandiser, Store keeper\. Chart of accounts: 48 accounts\./,
   );
 
   // Back from here reaches the company details, but no further: the business type is sent
```

- **The garments chart has 48 accounts now,** with 2115. The test counts them because the count proves the chart
  arrived with the roles; the number follows the template.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm lint
pnpm boundaries
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts purchase-orders
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts
```

Build the three packages first: the app reads their `dist/`, and the e2e tests need the segmented control's fix.
The last command runs every e2e test, on a desktop and on a phone; on a busy machine run it with `--workers=4`.

> **What we checked in this part.** The app type-checks with no errors (the 22 in `src/mocks/` are gone), with its
> e2e project. ESLint and Prettier are clean on the changed files, including `@omnivo/ui`, which also type-checks.
> The app's unit tests pass (108). `pnpm boundaries` finds no circular import (790 modules). The app builds and
> the bundle check passes (first load 196.2 KB gz, as before). The new e2e file passes on both projects (18
> tests); the full e2e run passed 232 of 234, and the two that failed were the onboarding count (47 → 48), fixed
> above and passing. We broke three things on purpose: without `relative` on the segmented control the phone's
> list test failed (that is how decision 54 was found); with the over-receipt percent left out of the mock's
> `checkOrderLines()` the settings test failed; with `isOrdered()` always false the close-requisition test failed.
> Nothing here ran against the real API: its tests are 17b.4's.

---

## 17b.8 — The OpenAPI document, and every check once

### The OpenAPI document

No root file changes: no new script, no new package and no new `.env` line. Generate the API document again and
commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 183 paths (172 before)
```

The 11 new paths:

- **Purchase orders:** `/purchase-orders` (list and create), `/purchase-orders/{id}` (read, change, delete),
  `/purchase-orders/{id}/submit`, `/purchase-orders/{id}/reopen`, `/purchase-orders/{id}/close` and
  `/purchase-orders/{id}/cancel`.
- **Goods receipts:** `/goods-receipts` (list and create), `/goods-receipts/{id}` (read, change, delete) and
  `/goods-receipts/{id}/post`.
- **Requisitions:** `/requisitions/{id}/close` and `/requisition-lines` (the lines still to order).

A list and its POST share one path, and so do a read, a change and a delete, so 17 routes make these 11 paths.
Several older paths changed their shape without a new path: the settings (`overReceiptPercent`), the stock list and
the reorder report (`incoming`), the requisitions (`orderState`, `orderedQuantity`, `orders`, the `order` filter),
the cost lookup (`supplierId`, `taxRateId`, the two new sources), the stock accounts (`received_not_billed`), the
approval routes (`purchase_order` in their `document` parameter), the document output routes (`purchase_order`) and
the public page (`recipient`). `pnpm test:openapi` fails if the committed file and the routes disagree.

The Drizzle snapshots (`migrations/meta/0037_snapshot.json`, `0038_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

In the copy of the repo every check passed on its first run, the end-to-end suite too (236 in 7.7 minutes, 4
workers). The integration and tenant-leak suites ran with `--maxWorkers=3` (`cd apps/api && npx vitest run .int.spec
--maxWorkers=3`), because at full speed this Mac's Docker missed the test containers' start-up time in earlier
steps.

If a test times out on your machine, run
`pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts --last-failed --workers=2` before
looking for a bug.

---

## 17b.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", at the end of "Purchase statuses", after "(neutral, `MinusSignCircle`).". The
design system lists every pattern, and a pattern that is not listed there does not exist for the next screen; 17c's
bill will reuse the order's pills:

> A requisition is also Closed (neutral, `StopCircle`), and an approved one has a second pill for how much is
> ordered: Partly ordered (`brand`, `ShoppingCart01`), Ordered (`good`, `ShoppingCartCheck01`), none while nothing
> is. Purchase order Draft (neutral, `FileEdit`), Waiting for approval (`brand`, `Clock01`), Approved (`good`,
> `CheckmarkCircle02`), Partly received (`brand`, `DeliveryTruck01`, in Approved's place), Received (`good`,
> `PackageReceive`), Closed (neutral, `StopCircle`), Cancelled (neutral, `CancelCircle`), plus a second `warn`
> "Late" pill (`Time04`) for an approved order past its expected date. Goods receipt Draft (neutral, `FileEdit`),
> Posted (`good`, `CheckmarkCircle02`).

In "Sales line editor", change the title to "(quotations, orders, purchase orders)" and add after "changing the
customer never reprices by itself.". Without it, the next document with prices would copy the editor instead of
giving it a `LinePricing` (decision 43):

> A purchase order uses the same editor with a supplier's `LinePricing`: the hints are "Last price from this
> supplier", "Last price paid", "From the average cost" and "No earlier price: type one", and the link says "Use this
> supplier's last prices on every line".

In "Stock line rows", change the title to "(adjustments, transfers, goods receipts)" and add at the end:

> On a goods receipt the quantity is "Accepted", with "Ordered 1,000 m · 400 m left on the order · Up to 430 m may
> come" under it (the last part only when the workspace lets more in), then "Rejected" in the line's unit and, once
> something is rejected, "Why it was rejected".

In "Send menu", add the purchase order: "next to Print on a quotation, purchase order, invoice, money receipt and
credit note". In "Public document page", change "the customer" to "the customer or the supplier (`recipient`)".

In "Filter chips / segmented control", add at the end, so the next control with many options does not bring the
phone bug of decision 54 back:

> Its `fieldset` is `relative`, so the `sr-only` radios stay inside the box that scrolls.

"Document notice" needs nothing: an order sent back uses the existing `ArrowTurnBackward` case, and the others are
the `subtle` notice. The approval card is 17a's, as it is.

**build-plan.bn.md** — in the "ধাপ ১৭: Purchase — চারটা গাইডে" block, replace the last line
("**১৭b–১৭d:** PO ও goods receipt (GRNI), …") with:

> **১৭b (purchase order, goods receipt):** approved requisition-এর লাইন থেকে PO, লাইন ধরে (এক requisition কয়েক
> supplier-এর PO-তে ভাগ হয়, কয়েকটা requisition এক PO-তে; requisition-এ Partly ordered / Ordered, আর Close)। PO-র
> লাইন sales লাইনের মতো (price, discount % বা ৳, VAT rate, "prices include VAT"); শুরুর দাম শেষ কেনা দাম (এই
> supplier-এর, না হলে যেকারো, না হলে average cost); শুধু BDT। প্রথম submit-এ নম্বর (PO), approval ১৭a-র engine-এ,
> VAT-সহ total ধরে; approved হলে lock, goods আসার আগে Reopen, পরে শুধু Close। PDF (দুই ভাষা), email, WhatsApp link।
> **Goods receipt (GRN)** শুধু approved PO থেকে: লাইনে accepted ও rejected (কারণসহ), lot/expiry/serial, supplier
> challan, vehicle; "Receive over the order" % (company setting, default 0) পর্যন্ত বেশি নেওয়া যায়। Post করলে
> accepted মাল PO-র VAT ছাড়া net দামে stock-এ (moving average), entry Dr Inventory / Cr Goods received not billed
> (2115, stock account `received_not_billed`, warehouse-এর branch-এ)। PO: Partly received → Received, বা Close; Late
> pill; stock ও reorder-এ Incoming।
> **১৭c–১৭d:** bill ও supplier payment, purchase return ও debit note — নিজ নিজ গাইডে।

**COMMANDS.md** — in "Look at the data", after the last approval query, add:

```bash
# what approved purchase orders still have to bring, by line, the earliest due first (base unit)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, o.number, s.name AS supplier, o.expected_date, v.sku, l.base_quantity - l.received_quantity AS still_to_come FROM purchase_order_lines l JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id JOIN parties s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id JOIN tenants t ON t.id = l.tenant_id WHERE o.status = 'approved' AND p.type = 'goods' AND l.received_quantity < l.base_quantity ORDER BY t.slug, o.expected_date NULLS LAST, o.number, l.line_no"
# goods received, not billed, by workspace and branch (posted entries; until 17c it is every posted receipt's value)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, b.name AS branch, sum(l.credit - l.debit) AS not_billed FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN stock_accounts sa ON sa.tenant_id = l.tenant_id AND sa.account_id = l.account_id AND sa.use = 'received_not_billed' LEFT JOIN branches b ON b.tenant_id = l.tenant_id AND b.id = l.branch_id JOIN tenants t ON t.id = l.tenant_id WHERE e.status = 'posted' GROUP BY t.slug, b.name ORDER BY t.slug, b.name"
# what the gate turned back on posted goods receipts, newest first (in the base unit)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, g.number, s.name AS supplier, v.sku, x.rejected_base_quantity, x.rejection_reason FROM goods_receipt_lines x JOIN goods_receipts g ON g.tenant_id = x.tenant_id AND g.id = x.receipt_id JOIN parties s ON s.tenant_id = g.tenant_id AND s.id = g.supplier_id JOIN product_variants v ON v.tenant_id = x.tenant_id AND v.id = x.variant_id JOIN tenants t ON t.id = x.tenant_id WHERE g.status = 'posted' AND x.rejected_quantity > 0 ORDER BY g.posted_at DESC"
# per workspace: the over-receipt percent and the "goods received not billed" account (empty = the stock accounts job has not run, or 2115 was taken)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, ts.over_receipt_percent, a.code AS not_billed_account, a.name FROM tenants t JOIN tenant_settings ts ON ts.tenant_id = t.id LEFT JOIN stock_accounts sa ON sa.tenant_id = t.id AND sa.use = 'received_not_billed' LEFT JOIN ledger_accounts a ON a.tenant_id = sa.tenant_id AND a.id = sa.account_id ORDER BY t.slug"
```

The four queries were run against a database migrated to 0038, holding 17b.2's check data; the second one inside a
transaction that added the account, chose it and posted an entry of ৳1,87,500 on the Gazipur branch, then rolled
back. The first query leaves out services: a dyeing charge is never received (decision 29). A negative amount in the
second one would mean a bill cleared more than receipts brought in, which can only happen from 17c on.

---

## 17b.10 — Run it

```bash
pnpm install                                  # nothing new, but run it after pulling
pnpm db:migrate                               # 0037 + 0038: four tables, closed requisitions, the percent, their rules
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: 17 new routes, and the worker runs the stock accounts job
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines');  -- t, four rows
SELECT a.code, a.name FROM stock_accounts s JOIN ledger_accounts a ON a.tenant_id = s.tenant_id AND a.id = s.account_id
 WHERE s.use = 'received_not_billed';                -- 2115 Goods received not billed, one row per workspace
```

If the second query has no row a few seconds after the worker started, your chart had another account at 2115:
choose one in step 2.

### What you will see

Sign in as the Owner first. (In an existing workspace the other roles do not have the new permissions yet; see
"What changes".)

1. **The navigation** has Purchase orders and Goods receipts in the Purchase group, after Requisitions.
2. **Settings:** the Inventory card has "Receive over the order"; type 3. In the stock accounts, Buying has "Goods
   received, not billed" set to 2115. Settings → Approval levels has a Purchase orders card: add a level from
   ৳1,00,000 for the Purchase manager role.
3. **An approved requisition → Make purchase order:** the form opens with the "Lines still to order" dialog for that
   requisition and its warehouse. Pick the supplier first, then add the lines this supplier sells. Each price starts
   at the last price paid, or the average cost, and says so under the box. Change a discount to 2% and the VAT rate:
   the totals under the lines follow, to the paisa.
4. **Save draft:** the page opens with no number and "Draft". The approval card lists the levels the total reaches.
   Delete draft is offered; submitting is what gives it a number.
5. **Submit for approval** as the Owner: it is approved at once (17a's decision 14) and gets `PO-2026-27-0001`. The
   requisition's page now shows "Ordered" (or "Partly ordered") and the order under "Orders"; its Reopen is gone and
   "Close requisition" is there. The stock page shows the quantity under Incoming.
6. **The real wait:** as a member with `purchase.order.manage`, write an order of ৳1,00,000 or more and submit it.
   The Purchase manager's bell rings; as the Purchase manager, approve it from its page.
7. **Send → Download PDF**, then in the other language ("বাংলা"): the supplier, "Deliver to", the terms and the
   amount in words. **Email** goes to the supplier's address; **Share on WhatsApp** makes a link whose page says who
   it is for.
8. **Receive goods** on the order: the receipt form has the supplier and the order picked. "Add what is left on the
   order" fills the lines. Accept 60% of a line, reject a few with a reason, give the lot, and **Post goods
   receipt**: it gets `GRN-2026-27-0001`, the order shows "Partly received", the item's stock card has the receipt, and its
   journal entry (Dr Inventory / Cr Goods received not billed) links back to it.
9. **A second receipt** of more than the rest plus 3%: the line says how much may still come, and saving or
   posting is refused under that line. Bring in the rest: the order is "Received". Or, on another order, **Close order** after one receipt: the
   requisition counts only what came.
10. **The store keeper** (a member with `purchase.receipt.manage` only) sees Goods receipts and can post one, but has
    no New purchase order.
11. **Bangla** and **390px**: the order lines, the receipt lines (Accepted, Rejected, Why it was rejected) and the
    order list's eight status options fit, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 469: contracts 217 + api 107 + app 108 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 433 — 31 new
pnpm test:tenant-leak        # 84 — 7 new
pnpm test:e2e                # 236: 118 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 196.2 KB gz; team page 97.5, units 96.9
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **The contract needed three more error codes** (17b.3): a close, a receipt or a post against an order that is no
  longer approved, a cancel of a draft nobody submitted, and a reopen or a cancel while a draft receipt points at the
  order had no code that said what to do. `purchase_not_approved`, `purchase_delete_instead` and
  `purchase_receipt_draft` are in 17b.1's `errors.ts` now (decision 42).
- **43 older API tests failed in 9 files** on the first full run (17b.4), all from the settings' new field, the
  second approval rule, the cost lookup's VAT rate, the role templates and the renamed `recipient`. Only the tests
  changed.
- **The API sends a discount with 4 decimals** (`'2.0000'`), and the form refuses more than 2 (17b.4). Sending an
  order back as it came is a 400, so the edit form cuts it, like the app's `formDiscount()`.
- **A posted receipt gives its order a new version** (17b.4): an order page open somewhere else must reload before
  its Close. The mock does the same (17b.7).
- **Seven pages went over their 100 KB budget** from 17b's contracts alone (17b.6), because every page carries the
  routes' English summaries. The app's build drops them now (decision 50).
- **Two words changed after 17b.5** (17b.6): the order page needed its own "Edit" (`purchaseOrders.edit`), and the
  receipt's order search was not needed (`goodsReceipts.orderSearch`, decision 46).
- **The order list scrolled sideways on a phone** by 211 px (17b.7): its eight status options were the first that
  did not fit, and the hidden radios were not clipped. The fix is in `@omnivo/ui` (decision 54).
- **The onboarding test counted 47 accounts** (17b.7): the templates have 48 now, with 2115.

---

## Notes left for later steps

**17c (bills and supplier payments):**

- **The bill posts Dr Goods received not billed.** Only the sources in `STOCK_JOURNAL_SOURCES` get `allowStock` in
  `posting.service.ts`, so a bill's entry would be refused with `journal_account_stock` (decision 37). Give the
  bill's source its own exception for the `received_not_billed` account only, not the inventory account.
- **A bill line points at a receipt line:** `goods_receipt_lines` has no unique index on `(tenant_id, id)` alone yet
  (17b.2); add it with the bill's foreign key.
- **Clear it on the same branch:** the receipt's credit carries the warehouse's branch (17b.3), so the bill's debit
  must carry the same one, or a branch's balance sheet keeps a balance nobody owes.
- **The bill starts from the order:** its payment terms, its prices and its "prices include VAT" (decision 15). A
  price that differs goes to "Purchase price difference" (decision 2), and the input VAT is booked here (decision 6).
- **An order of services only is never received** (decision 29): the bill takes it, and its lines are what the bill
  matches.
- **A direct bill** (decision 8) makes its own receipt, so it needs the receipt's posting without an order.

**17d (purchase returns and debit notes):**

- **What an order line received only goes up** (0038's guard, section 7). Decide whether a return lowers it (the
  order shows less received, and may be received again) or is counted on its own.
- **A receipt's entry is undone by a stock document only:** the journal's Reverse refuses `purchase_receipt`
  (`journal_is_stock`). The return is that document, at the receipt's value.
- **Rejected goods were never in stock.** A return takes only from accepted quantities, by lot and serial number.

**Notes for any step:**

- **A new kind of document that goes out** needs a recipient in `recipientRole()` (`apps/app/src/lib/document-output.ts`),
  and a new kind that is approved needs its `APPROVAL_TARGETS` entry: both are `Record`s, so the type check asks.
- **The bundle:** decision 50 gave every page about 4 KB back. The team page is at 97.5 KB and the units page at
  96.9 KB, so new shared code lands there first.
- **The mock's purchase part** imports one way only: `purchase-order-data.ts` → `requisition-data.ts` (decision 51).
  A later purchase file reads the orders through `WorkspaceData`, or `pnpm boundaries` finds a circle.
