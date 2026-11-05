# Step 20b: The POS, part 2 — shifts and the cash in the drawer

> The implementation guide for "Phase 6 → Step 20", the second of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 20 (the POS screen) is split into three guides: 20a
> (registers, receipt numbers, the sale screen, payment, posting and the thermal receipt), this one (shifts, the cash
> count, pay in and pay out, held bills, the idle lock) and 20c (returns, refunds and the shift reports).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `d815f88`, your commit named
> "pos sales added": 20a's code and its doc updates) and checked from 2026-10-28 to 2026-10-29: `pnpm dedupe --check`,
> `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (789 — 28 new), `pnpm test:integration` (617 — 27 new),
> `pnpm test:tenant-leak` (122 — 4 new), `pnpm build`, `pnpm test:bundle-size` (first load 222.4 KB gz, budget 225;
> the POS screen 116.3 KB and its payment 122.2 KB, budget 125; the worker's list 424 files, 1413.8 KB gz, budget
> 2 MB), `pnpm test:openapi`, `pnpm boundaries`, `pnpm test:e2e` (Playwright on the mocks, 338 — 10 new) and
> `pnpm test:e2e:pwa` (the worker on a production build, 4) — with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database's rules on Postgres** (20b.2): 86 SQL checks (row-level security, one open shift per register, the
>   opening that never changes, a closed shift that never changes, a revoke that closes the open shift, the cash a
>   shift should hold) and 5 races in two sessions (an open and a release, and an open and a revoke, in both orders
>   and without the device's lock).
> - **The commands through the API** (20b.3, 20b.4): a smoke run of the three commands before the tests were written,
>   then the tests: the float and the differences in the books, a late close after a manager's, a late sale, the bell,
>   the revoke, and the races. Broken on purpose: the opening compared with the stored expected cash fails the late-sale
>   test.
> - **The shift in the mock app** (20b.7): a whole shift, the sign-out gate, a manager's close, the reasons page and
>   the idle lock, on both screen sizes. The tests failed before the two fixes they led to (decisions 98 and 99).
> - **The shift against the real API in a browser** (20b.8): a first shift with its float, sales online and offline, a
>   pay out offline, the blind close with its entry and bell, the managers' page, and the register let go at sign-out.

## Goal

💵 **Knowing where the cash went.** After step 20a, a counter sells, offline too, and the books get every sale. But
nobody counts the drawer. If ৳500 goes missing between the morning and the evening, the books still say the money is
there. This step adds shifts: a cashier opens a shift by counting the drawer, puts money in or takes it out only with a
reason, and closes the shift by counting again. The difference goes to the books by itself, and a big one rings a bell.

After this step:

- **A register sells only inside a shift.** One cashier, one device, one register, from one count to the next.
- **The count is blind.** The cashier types what is in the drawer (by notes, or as a total) before the screen says what
  should be there. Then the close is final.
- **Pay in and pay out have reasons.** "Bank deposit", "Tea and snacks", "Float from safe": each reason has its account,
  set up in Settings → POS. The cashier picks a reason, never an account.
- **The difference posts by itself** to the register's over/short account, at the open (against what the last shift
  left) and at the close (against what the shift should have). Over the register's limit, the managers get a bell.
- **A shift must be closed before sign-out,** and a shift nobody can close (a lost device) is closed without a count.
- **Held bills and the idle lock** (20b.6): a cart can wait while the next customer pays, and /pos locks itself after a
  few idle minutes.

## The whole picture

```
packages/contracts   pos-shifts.ts: reasons · the count (notes or total) · expectedCashOf() · the three inputs ·
      │               the shift for managers · formatShiftNumber() (POS1-S0042)
      │               pos.ts: a register's over/short account, bell limit, idle lock, latest shift · a sale's shift
      │               sync.ts: protocol 3, pos_cash_reason rows, pos_shift.open / pos_cash_movement.create /
      │               pos_shift.close · pos.shift.manage · 17 errors · pos_shift journal source · a bell
      ▼
packages/db          pos_shifts, pos_cash_movements, pos_cash_reasons, a sale's shift (20b.2)
      ▼
apps/api             reasons · the three commands posted · close without a count · the shifts list (20b.3)
      ▼
packages/sync        the shift on the device, its cash, held carts (20b.6)
      ▼
apps/app             open / pay in-out / close on /pos · the idle lock · Settings → POS reasons · POS shifts (20b.6)

the front counter of a super shop in Agrabad, Chattogram, on a Thursday:
  09:02 Sumi signs in, POS1 is hers; the last shift (POS1-S0041) left ৳5,000 in the drawer
        she counts: 4 × ৳1,000 + 2 × ৳500 = ৳5,000 ──► outbox: pos_shift.open (S0042, ৳5,000)
  all day: 212 sales, POS1-000164 … POS1-000375, each with shiftId = S0042
  13:10 pay in "Change from bank" ৳2,000 · 16:45 pay out "Bank deposit" ৳10,000 (slip 0042)
  21:30 she counts, blind: ৳7,640 ──► the screen: expected ৳8,160, short ৳520
        outbox: pos_shift.close (counted ৳7,640, the device expected ৳8,160)
  the server, command by command, in that order:
     open      ৳5,000 = what S0041 left ──► no entry
     sales     posted as in 20a
     pay in    Dr Cash at counter 2,000 / Cr Cash in safe
     pay out   Dr Bank (DBBL) 10,000 / Cr Cash at counter
     close     expected again from its own rows: ৳8,160 ──► Dr Cash over/short 520 / Cr Cash at counter
               ৳520 > the register's limit ৳500 ──► the store manager's bell: "POS1-S0042 was ৳520 short"
  Sumi signs out ──► the shift is closed, the outbox is empty, POS1 is free
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| X and Z reports (the shift's printed summary) | 20c, with returns and refunds (step 20 decision 1) |
| Cash refunds in the expected cash | 20c: a refund takes cash out of the drawer, and `expectedCashOf()` gets one more part |
| Two cashiers in one shift, or one cashier on two counters | One shift is one person on one device (step 20 decision 4) |
| A safe or a bank as a register's own "end of day" step | A deposit is a pay out with a reason (decision 2) |
| Changing a count after the close | The close is final (decision 9); the next opening count catches a mistake |

## What changes in the code you already have

- **The contract (20b.1):** a new `pos-shifts.ts` (reasons, the count, the cash of a shift, the three inputs, the shift
  for managers, its routes). `pos.ts`: a register gets its over/short account, its bell limit, its idle lock and its
  latest shift; a sale gets its shift. `sync.ts` moves to protocol 3, with the `pos_cash_reason` rows and the three
  commands. One permission, 17 error codes, the audit actions, a bell, the `pos_shift` journal source and the routes.
  `openapi.json` is generated again.
- **The database (20b.2):** three new tables (`pos_cash_reasons`, `pos_shifts`, `pos_cash_movements`), three new
  columns on `pos_registers` and `shift_id` on `pos_sales`, in `schema/pos.ts`. The journal's document check takes
  `pos_shift`. Migration 0053 is generated; 0054 adds row-level security, the shift's rules, a function that adds up a
  shift's cash, a new version of 20a's register guard and device release, and the change log. One new permission
  description and two changed ones.
- **The API (20b.3):** a reasons service, a shifts service (the three commands posted, the shifts list and page, a
  close without a count) and their controller; the push runs the three commands and the pull sends the reasons and each
  register's latest shift. A register gets its three fields and is not let go during a shift, a sale gets its shift, a
  device does not move branch during a shift, and a revoke logs the shift it closes. A new bell, the journal's Reverse
  refuses a shift's entries, and new retail workspaces get a "Cash over and short" account.
- **The API tests (20b.4):** a new `pos-shifts.int.spec.ts`; the two POS suites of 20a fill the register's new fields,
  and the tenant-leak suite also covers the reasons and the shifts. The tests found two things in the 20b.3 code, fixed
  there (decisions 63 and 64).
- **The words (20b.5):** `en.ts` and `bn.ts` get the screens' words (the open, the count, pay in and pay out, held
  bills, the close, the idle lock, the managers' shifts and the reasons page, a register's three fields) and the words
  the app looks up for every new code of 20b.1: 17 errors and `journal_is_pos`, the permission, the audit actions and
  entities, the bell, the journal source and the three sync commands.
- **The device and the POS screen (20b.6a):** `packages/sync` keeps the reasons, the shift (its cash added up as each
  sale and movement is saved), held bills and the cart on the screen, and the push sends a shift's commands in the
  server's order. A bug found while writing: the pull dropped the reasons until `apply.ts` got their case. On `/pos`:
  the open card, the shift menu (pay in, pay out, held bills, close), the close and its result, Hold (F8) and Held
  (F9), the idle lock and a shift left open on an earlier day. The sign-out asks to close an open shift first, in the
  shell and on the lock screen. The cart's type moved from the app to `@omnivo/sync`. One new word,
  `pos.shift.openedBy`.
- **The managers' pages (20b.6b):** a register's form gets its three shift fields; two new settings and Sales pages,
  POS cash reasons and POS shifts (the list and a shift's page, with "Close without a count"). The bell's variance
  notice opens its shift, the Sync page names the three commands, a POS sale's page shows its shift, and a shift's
  journal entry links back to it and cannot be reversed. One new word, `posShifts.allStatuses`.
- **The mock app and the tests (20b.7):** the MSW mock gets the reasons, the shifts and their pay ins and outs (a new
  `mocks/pos-shift-data.ts`), the three commands in its push, the reasons and each register's latest shift in its
  pull, a "Cash over and short" account (5340) in the two seeded workspaces, and the routes of the two new pages. A new
  `e2e/pos-shifts.e2e.ts`; the POS tests of 20a open a shift first. The tests found two things in the 20b.6a code,
  fixed there (decisions 98 and 99).
- **The finish (20b.8):** no code. The shift runs once against the real API in a browser, and every check runs once.
  The full e2e run found one mistake in 20b.7's mock seed, fixed there (decision 101).
- **Not touched:** `packages/ui`, `packages/auth`, the service worker (`apps/app/sw/`), the sign-in and the device
  set-up, and the documents of steps 15 to 17.

## The decisions behind this step

You made the first twelve: 1–8 on 2026-10-28 for this guide, on top of step 20's decisions 4, 9 and 10, and 9–12 on
2026-10-28 while the contract was written. The others came up while building it; please read them with care: they are
mine.

1. **A shift must be open to sell.** (You chose this.) /pos first shows "Open shift" (count the drawer), then sells.
   One open shift per register at a time: one register, one person, one device. Every POS sale gets its shift; 20a's
   sales have none.
2. **Counted cash stays in the register's cash account.** (You chose this.) The close only counts and posts the
   difference. Money taken to the bank or the safe is a pay out with a reason whose account is the bank or the safe.
3. **A blind count.** (You chose this.) The cashier types the count first; the expected cash and the difference show
   only after.
4. **Pay in and pay out reasons are a list in Settings → POS** (you chose this): a name, in or out, and an account.
   They are copied to the device, so they work offline. The cashier picks a reason, types the amount and a note, and
   never picks an account.
5. **The difference posts by itself** when the close reaches the server. (You chose this.) It never waits and is never
   refused. Over the register's limit (৳500, say), the managers get a bell.
6. **Sign-out needs the shift closed first.** (You chose this.) Signing out says "Close the shift first" and leads to
   the close. A register with an open shift is not let go. A shift left open (yesterday's) is closed before the next
   sale on that device.
7. **The idle lock is a register setting, on /pos only.** (You chose this.) "Lock after": off, 2, 5, 10 or 15 minutes
   (5 by default). It uses the lock screen of step 19b, so it needs the device's PIN: while the register's lock is on,
   a shift does not open on a device without a PIN.
8. **The opening is counted too.** (You chose this.) The cashier counts the drawer at the open, by notes or as a total.
   A difference from what the last shift left posts to over/short too, so money lost between two shifts is caught.
9. **The close is final once the count is sent.** (You chose this.) A count that was wrong shows up in the next shift's
   opening count as a difference the other way, and the two cancel out in the books. A recount after seeing the
   expected cash would make the count no longer blind.
10. **The cashier's permission covers the shift.** (You chose this.) Opening and closing one's own shift, and paying in
    and out, need `pos.sale.create`. A new `pos.shift.manage` reads every register's shifts and closes a stuck one
    online. The reasons are set up with `pos.register.manage`.
11. **A stuck shift is closed without a count.** (You chose this.) Revoking a device closes its open shift, and so can
    someone with `pos.shift.manage`, online. Nobody counted, so no difference posts; the list shows it with a pill of
    its own, and the next shift's opening count finds what is missing.
12. **A register's first shift brings its float in as a pay in.** (You chose this.) There is no last shift to compare
    with, so the count is the float: the cashier picks an "in" reason ("Float from safe"), and the count moves from
    that reason's account to the register's cash account. The books show the float, and no new field is needed.

**The contract (20b.1):**

13. **The over/short account is a field of the register,** next to its cash account, not a workspace setting. The
    device has the register's row, so it knows offline whether a shift can open, and two branches can keep their
    differences apart. A register made in 20a has none (`null`) and opens no shift until someone picks one; the form
    asks for it (`pos_over_short_required`).
14. **The bell's limit is whole taka per register,** `"500"` by default in the form. An empty box is 0: a bell for any
    difference. "Over the limit" means more than it: ৳500 short at a limit of ৳500 rings no bell
    (`isOverVarianceAlert()`).
15. **"Lock after" is text** (`'off'`, `'2'` … `'15'`), like the paper width, so the form's select sends it as it is;
    `lockAfterMs()` turns it into the screen's timer.
16. **A shift is numbered on the device,** like a sale: `POS1-S0042` (the code, an S, 4 digits). Only the device that
    holds the register works on it, so two devices never give one number. The S and the 4 digits keep a shift's number
    apart from a receipt's (`POS1-000123`).
17. **A register's row carries its latest shift** (`lastShift`: id, sequence, status, `cashLeft`). Signing out deletes
    the device's copy (step 18), so the next cashier's device knows nothing of the last shift; the claim and the pull
    tell it where the numbers go on and what the drawer should hold. For a shift closed without a count, `cashLeft` is
    what the server expects now, with what arrived after that close (decision 63).
18. **A count has the notes and their total,** and the total must be the notes' (`pos_count_total_mismatch`). A count
    typed as a total has `notes: null`. The API sends it back the same way, so a shift's page shows the notes counted.
    A note count is a number (it is counted, never added like money), up to 99,999 of each note; a total has at most 2
    decimals, and 0 is a count.
19. **`expectedCashOf()` is in the contract,** so the device's result screen and the server's books use one formula:
    the opening, plus cash taken and paid in, less change given and paid out. A first shift's float is its opening,
    not a pay in, so it is counted once.
20. **A reason's direction never changes;** its account may. A pay in turned into a pay out would change what every
    old movement meant. A movement keeps the account it was posted to. Reasons belong to no branch, so every device gets
    all the active ones.
21. **Every command carries the device's day** (`date`), and the server books it like a sale (step 20a, decision 26):
    on that day, or the first open day after it.
22. **The close sends what the device expected,** and the server works it out again from its own rows; the server's
    number is the one in the books. When the two differ, the audit log says so (`pos_shift.expected_differs`): a sale
    or a movement is missing on one side.
23. **The close says how many held carts it dropped,** at most 20 (the device's limit for held carts).
24. **A sale's `shiftId` may be missing,** and is then `null`. A sale made before this update can still be in a
    device's outbox when the app reloads; refused, it would be lost from the books. Every sale made after the update
    has a shift.
25. **The shift commands are never refused for money or for permission** (like a sale, step 20a, decision 28). The only
    refusals are bugs: a shift opened while the server still has the register's last one open
    (`pos_shift_already_open`), and a command for a shift the server does not know (`pos_shift_unknown`).
26. **Reading the shifts needs `pos.shift.manage`.** Unlike the sales lists, a shift shows how much a cashier's drawer
    was short; that is for the managers.
27. **Closing without a count takes a note** ("Sumi went home sick, the drawer went to the safe") for the audit log.
28. **One journal source, `pos_shift`,** for every entry of a shift: the opening difference or the float, each pay in
    and pay out, and the closing difference. Each points at the shift. The journal's Reverse refuses them
    (`journal_is_pos`): a mistake is put right by the next count or by a movement the other way.
29. **The variance bell (`pos.shift_variance`) goes to the owners and the people with `pos.shift.manage`,** and opens
    the shift.
30. **Protocol 3.** A new entity (`pos_cash_reason`, after `pos_register`) and new register fields mean every device
    does one full pull after the update. The shift commands send no rows back; the register's new `lastShift` comes with
    the next pull.
31. **The cashier's own mistakes have error codes too** (`pos_pay_out_too_large`, `pos_float_reason_required`), though
    only the device checks them: the forms show every message through `errors.*`.
32. **An open shift keeps its register:** letting go, moving the device to another branch and signing out are refused
    with `pos_shift_still_open` until it is closed.

**The database (20b.2):**

33. **The shift tables live in the same schema file as the sales** (`schema/pos.ts`). A sale points at its shift, and a
    shift at its register; two files would import each other.
34. **A shift keeps the ids of its entries** (`opening_entry_id`, `closing_entry_id`, and `entry_id` on each movement).
    Other documents find their entry through `journal_entries.document_id`, but a shift has many entries that all point
    at it; the columns say which one is the opening, which the close and which a movement.
35. **The server adds up a shift's cash in one SQL function,** `pos_shift_cash()`: the revoke's trigger, the close
    (20b.3) and the shift's page all call it. It is the same sum as the contract's `expectedCashOf()`, which the device
    uses.
36. **A register's latest shift is read, not stored.** The API reads it by the highest sequence (20b.3). A shift that
    opens or closes writes its register into the change log, so the devices get the register (with `lastShift`) again.
37. **The database has the last word on the shift rules:** one open shift per register, a shift opens only on a
    register its own device holds, and a register with an open shift keeps its device (letting go and moving the device
    are refused with `pos_registers_shift_open`; the API answers `pos_shift_still_open`). A revoke closes the open
    shift without a count first, in the database, whoever revokes.
38. **A shift row changes once,** from open to closed: the opening columns never change, a closed shift never changes,
    and no shift is deleted. So a close that arrives after a manager closed the shift without a count cannot be written
    to the shift; 20b.3 accepts that command (it is never refused) and keeps its count in the audit log.
39. **A sale's shift must be of the same register and device** (the foreign key carries both). A sale without a shift
    skips the check. A sale for a closed shift is still written: a sale is never refused.
40. **A movement keeps its reason's direction,** and the foreign key carries it, so the two can never disagree. An
    archived reason still posts: the device chose it before the archive reached it.
41. **A reason's name is unique in any case, archived ones included,** like a register's code: restoring one never fails
    on its name.
42. **Registers made in 20a get a limit of ৳500, "Lock after" 5 minutes and no over/short account.** They open no shift
    until someone picks the account (decision 13).
43. **The database checks only that a count's notes are a JSON object.** The keys, the limits and the total are the
    contract's (`cashCountSchema`); the API parses every count before it writes one.
**The API (20b.3):**

44. **A shift's entry may post to an archived account.** The journal lets only a reversal and a year-end close do that;
    `pos_shift` joins them. A reason (decision 40) or a register can keep an account that someone archived since, and the
    money was counted or moved already: refusing would leave it out of the books. A POS sale keeps 20a's rule.
45. **The over/short account is an active income or expense account that is not a group**
    (`pos_over_short_invalid`). A difference in the drawer is a gain or a loss of the shop, never money kept somewhere.
46. **A reason's account may be of any type,** but active, not a group, not the receivable or the payable (a pay out
    names no customer or supplier) and not a stock account. A bank or a safe is an asset, tea for the staff an expense,
    money the owner brings a liability or equity.
47. **The opening's entry is posted before the shift's row is written.** 0054 never lets the opening columns change,
    so the entry's id must go in with the row. The savepoint takes both back when the insert fails.
48. **A command for a shift the server does not have, or that belongs to another device or register, is
    `pos_shift_unknown`,** also for a sale. The device always opens the shift first, so this is a bug; the database's
    foreign key would say the same as a 500 that blocks the push.
49. **A float reason that is not an "in" reason, or that the server does not know, is refused**
    (`pos_float_reason_required`). The device offers only "in" reasons. A first shift with money and no reason (a bug)
    posts the money to over/short: it is in the drawer either way.
50. **A second open is refused before anything posts** (`pos_shift_already_open`). A shift number used twice (a bug)
    answers 20a's `pos_number_taken`.
51. **A pay in or pay out for a shift closed since is still written,** like a late sale (decision 39): the money moved.
    Its audit row says the shift's status then. An unknown reason is refused with `pos_reason_required`.
52. **A close that finds its shift closed already is accepted** (decision 38) and writes only an audit row
    (`pos_shift.closed` with `kept: false` and the count). No notice goes back: the next pull shows the register's last
    shift, and the device opens a new one.
53. **Sign-out needs no server change.** The app lets go of its register before it signs out, and the release is
    refused with `pos_shift_still_open`. A device that holds no register has no open shift. Moving a device to another
    branch checks the open shift itself, after locking the device.
54. **A manager's close takes the shift `FOR UPDATE`; a sale and a movement take it `FOR SHARE`.** So the expected cash
    the manager's close stores counts every sale and movement that was being written. Its `closed_at` is the server's
    time: there is no device time.
55. **The revoke writes `pos_shift.closed_without_count` too.** The database closes the shift (0054), so the revoke reads
    the open shift before its update and the expected cash after it. Removing a member revokes their devices the same
    way.
56. **The variance bell names the shift, the register and the signed difference.** The event carries only the shift's
    id; the handler reads the rest, like the sold-short bell.
57. **New retail workspaces get account 5350 "Cash over and short",** and the shop manager role gets
    `pos.shift.manage`. Older workspaces pick an account in the register's form (or add one), and an owner gives the
    permission in Settings → Roles.
58. **One `bookingDay()` for every POS command:** the sale's 20a code moved into it, and the shift's three commands use
    it.
59. **A count goes back with 2 decimals** ("5000.00"), the way it was typed and the way `cashCountSchema` reads it. Every
    other amount keeps 4, like the rest of the API.
60. **The list works out the expected cash of an open shift, and of one closed without a count, when it is read,** with
    `pos_shift_cash()`; a counted shift's is the stored one (decision 63).
61. **The shift's page lists a payment row for every method the register takes now,** with ৳0 when nothing came in, and
    for any other method a sale of the shift was paid with.
62. **The reasons list shows "in" reasons first, then by name.**
63. **A shift closed without a count keeps counting what arrives late.** (Found by the 20b.4 tests.) A manager closes a
    shift while the counter PC is offline; the PC sells once more on it and sends the sale later. The sale is written
    and posted (decision 39), and its cash is in the drawer. The next opening count was compared with the expected cash
    stored at the manager's close, so the sale's cash came out "over" and posted to over/short a second time. Now the
    next opening, the register's `cashLeft` and the list's expected cash use `pos_shift_cash()` at the time they are
    read. The stored `expected_cash` stays what was expected at the moment of the close, for the audit log. A counted
    shift is not changed: the device sends its close after every sale of the shift, so nothing normal arrives late.
64. **Every amount of a shift goes back with 4 decimals,** also a sum of no rows: `pos_shift_cash()` and the list's
    sales total cast to `numeric(19, 4)`, so a shift with no sales says `0.0000`, not `0`. (Also found by the tests.)

**The words (20b.5):**

65. **The opening count is blind too.** The open card does not show what the last shift left; the toast after the open
    says it, with the difference ("The last shift left ৳5,000. Your count is ৳100 short"). With the number on the
    screen, a cashier in a hurry types it instead of counting, and decision 8 would catch nothing.
66. **The bell's difference is words, not a sign.** The event carries the signed difference; the bell writes it with
    `posShifts.over` or `posShifts.short` ("৳520 short") before it fills the sentence, so one sentence reads right both
    ways, in both languages. The shifts list and the POS screen use the same two words.
67. **The reasons are a page of their own, "POS cash reasons",** next to POS registers in the Workspace group, with
    its own data table and dialog, like the registers. A tab inside the registers page would hide them from the person
    looking for "Bank deposit".
68. **A held bill is held with F8,** and the held list is the "Held (2)" button. F8 is free on the POS screen (F2, F4,
    F7 and F12 are taken) and sits next to F7. At most 20 held bills per device (decision 23).

**The device and the POS screen (20b.6a):**

69. **The push sends a shift's commands in the server's order.** The open goes alone; the shift's sales and pay ins
    and outs go once the open has its answer; the close goes once every one of them has its answer; the next shift's
    open goes after that close. Each step costs one more push round (a second or so online), and the server never sees
    a sale for a shift it does not know, or a close before its last sale. A walk-in sale still holds back no other
    sale, so a shift's 200 sales go 50 at a time, as in 20a.
70. **A shift's command leaves the device only once the server refused it,** like a POS sale (20a): the drawer was
    counted and the money moved, so the books must get it. A refusal is a bug (decision 25).
71. **The device adds up the shift's cash as it saves,** in the shift's own row, in the same transaction as each sale
    and movement. The outbox cannot tell it: an accepted sale leaves the outbox, and the close needs every sale of the
    shift. The cash a sale brings is its cash payments and its change, the same parts as the server's
    `pos_shift_cash()`.
72. **The shift's row keeps its id, register, number and state clear;** the amounts are sealed. The lock screen and the
    sign-out must know whether a shift is open without the key (decision 6), and "POS1-S0042" says nothing about the
    money. A `rev` number counts every write, so a save checks inside its transaction that nobody wrote the row since
    (another tab sold meanwhile), as the claim does for a sale's number.
73. **The next shift goes on from this device's own last shift when it is newer than the server's `lastShift`:** the
    close may still be in the outbox when the cashier opens the next shift, and the pull has not brought it yet.
    Otherwise the server's `lastShift` decides (a device that just took the register).
74. **The cart's shape moved into `@omnivo/sync` (`PosCart`),** and the app's `Cart` is now that type under its old
    name. The device stores carts now (held bills, the cart on the screen), and the box and the screen must agree on
    their shape. No cast, no schema to check what comes back out of the box.
75. **The cart on the screen is kept on the device** (a sealed row, `current`), saved on every change. The idle lock
    unmounts the screen (the AppFrame draws the lock screen in its place), and a reload or a crash would lose a sale
    half scanned. A sale deletes that row in its own transaction, so a reload never brings back a cart that was sold.
76. **"Close shift" holds the cart on the screen first,** so the close's notice ("2 held bills are dropped") counts it
    and nothing is thrown away without a word. The close then drops every cart of the shift in its transaction, and
    sends how many held bills it dropped.
77. **Resuming a held bill swaps it with the cart on the screen** in one transaction ("The cart on the screen is held
    first, so nothing is lost"), so a full list of 20 can still swap.
78. **F9 opens the held bills.** Decision 68 gave the list only its button; the words for a key were there
    (`pos.keys.held`), and F9 sits next to F8.
79. **A pay out bigger than what the drawer should hold is refused on the device** (`pos_pay_out_too_large`), the only
    place that knows the expected cash during the shift. The message says the limit without saying the amount: the
    count stays blind.
80. **The idle lock is "Lock now" with its minutes kept in the lock flag** (`idle:5` in place of `1`), so the lock
    screen says why it locked, after a reload too. Idle means no key, click, touch, scroll or mouse move in the /pos
    tab; a check runs every 5 seconds. An open dialog does not stop it: a counter left with the payment open locks too.
    It runs only with an open shift and a PIN.
81. **Sign-out asks to close an open shift before anything else.** In the shell, "Close shift" goes to `/pos?close=true`,
    which opens the close; on the lock screen the dialog only says why (the POS opens after the PIN). The sidebar's
    sync summary carries the open shift's number for this, read from the row's clear fields.
82. **The shift menu is a chunk of its own.** The dropdown's code is in no other part of /pos (the shell's menus are not
    drawn there); a look-alike button shows while it loads. One new word: `pos.shift.openedBy` ("Opened 23 Sep 2026,
    09:02 · Sumi Akter"), the menu's first line, as the mockup has it.
83. **A shift still open on a later day sells nothing more** (decision 6): the screen shows a `warn` notice, Pay stays
    off, and the menu's Close is the way on. The held bills and pay ins and outs still work.
84. **A register that cannot open a shift says why in the open card's place:** no over/short account
    (`pos.shift.needsOverShort`), or a lock without a PIN (`pos.shift.needsPin`, with "Set a PIN").
85. **The open's toast is one sentence:** the shift's number for a first shift, else what the last shift left and the
    difference in words. Two sentences joined in code would read wrong in Bangla.
86. **"Change register" is refused on the device while a shift is open,** with the words of 20b.5; the server would
    refuse it anyway (decision 32). The count of what waits (`waitingAtCounter`, was `waitingSales`) now counts the
    shift's commands too: the server lets the register go only once the close has arrived.
87. **The bundle budgets are 225 KB for the first load and 125 KB for a lazy chunk.** (You chose this, 2026-10-29.)
    20b's words took the first load to 222.0 KB, and selling inside a shift took /pos to 115.9 KB, its dialogs with it
    to 120–124 KB, after the shift menu moved to a chunk of its own.

**The managers' pages (20b.6b):**

88. **A shift's page shows every amount with its paisa,** like a document; the three numbers at its top, the shifts
    list and the bell read like the counter (whole taka unless there is paisa, `counterMoney()`). So a count of
    ৳2,502.50 is never shown as ৳2,503, and the top of the page matches what the cashier saw on the result screen.
89. **A shift's pills:** Open (`brand`, `Clock01`: work in progress), Closed (`good`, `CheckmarkCircle02`), Not counted
    (neutral, `MinusSignCircle`). Not counted is not `warn`: nothing is wrong yet, and the next opening count finds any
    money that is missing (decision 11). The CLAUDE.md design system gets them in 20b.9.
90. **The shifts list filters by register and by status with two selects,** and the status select starts with "All
    shifts" (one new word, `posShifts.allStatuses`, in `en.ts` and `bn.ts`). A segmented control has no "all" choice,
    and a manager most often looks for the open ones (a stuck shift).
91. **The reasons form offers only the accounts the API takes** (active, not a group, not the receivable or the
    payable, not the inventory, goods in transit or goods received not billed), by code, and keeps the reason's own
    account in the list when it no longer fits, like the bill's expense accounts. A reason's kind is a neutral pill with
    the shift menu's icons: it is not a status.
92. **A register's over/short select lists only active income and expense accounts that are not groups,** the API's
    rule. A register made in 20a starts with the select empty (decision 42), so its first save asks for one
    (`pos_over_short_required`).
93. **"The device expected … the server …" is a neutral notice,** not `warn`: the books are right (they use the
    server's number), and the notice explains a difference a manager may see between the counter and the page.
94. **The Sync page shows no amounts for the shift's commands:** the open and the close are named by the shift's
    number, a pay in or out by the toast's sentence. A count on the Sync page would end the blind count.
95. **A shift's journal entry links to its shift only with `pos.shift.manage`;** without it, "From POS1-S0042" is plain
    text (the shift's page would refuse the reader). Reverse is hidden, like a sales document's (`journal_is_pos`).
96. **A POS sale's page shows its shift,** a link with `pos.shift.manage`, a dash for a sale made before this update.
97. **`counterMoney()` and `differenceWords()` moved to a small `pos-shift-parts.tsx`,** shared by the POS screen, the
    managers' pages and the bell. The bell is in the first load, so the file stays small: the first load grew by
    0.3 KB.

**The mock app and the tests (20b.7):**

98. **"Sign out" after the close goes on by itself once nothing waits** (found by the tests, fixed in 20b.6a's
    `pos.tsx`). The button sits right after the close, whose command may still be in the outbox at that moment, so the
    page asked "Sign out and lose the changes?" and, a moment later, said "0 changes". The question is drawn only while
    something waits, and when the count reaches 0 the sign-out goes on. The shell's sign-out has the same race since
    18b, but there a person rarely signs out the moment after a save; it is left as it is.
99. **On a phone the POS bar shows the shift's number alone and hides the "POS" pill** (found by the phone tests, fixed
    in 20b.6a's `pos-parts.tsx` and `pos.tsx`). "Shift POS1-S0001 ▾" made the bar wider than a 390px screen: the page
    scrolled sideways, and the cart's bar at the bottom and the dialogs' buttons could not be pressed. The button's
    label still says "Shift POS1-S0001 menu" for a screen reader.
100. **The mock keeps the shifts, their movements and the reasons in `data.pos`,** beside the registers and the sales:
    a register's latest shift and a sale's shift are read from them. What the devices and the managers do with a shift
    is a new `pos-shift-data.ts`, which writes no audit rows, like `pos-data.ts` (its callers do; `record()` lives in
    `workspace-data.ts`, which imports both files for the seed).
101. **The seed:** a "Cash over and short" account (5340, under selling expenses) in both seeded workspaces, set on
    every seeded register, with a bell over ৳500 and no idle lock (the tests' device has no PIN until a test sets one).
    It is added by the POS seed, not the chart template: the mock's sign-up builds a new workspace's chart from the
    template, and the setup wizard says how many accounts it made, which must stay the API's number (20b.8 found it). Five reasons
    in the garments workspace (Float from the owner, Change from the bank, Cash to the bank, Tea for the staff, and
    Staff lunch archived), two in the pharma one. POS2, held by the Store office PC, has a shift open since this
    morning with ৳5,000, so the shifts list has an open shift for a manager to close. The seed posts no entries for it,
    like CTG1's 1,260 receipts that have no sales: the books other tests count on stay the same.
102. **The mock's pull sends a register again whenever its latest shift changes,** also for a late sale after a close
    without a count (its cash left changes). The API sends it only with a change of the shift's row (decision 63). The
    device writes the same register either way.
103. **The idle lock is tested with Playwright's clock** (`page.clock.install()` before the app starts, then
    `fastForward('02:10')`): the clock runs on its own until the test jumps it, so the rest of the app works as usual.
    F8 and F9 are pressed on the phone too: Playwright's keyboard reaches the page on both.

## 20b.1 — `packages/contracts`: the contract

The contract first. A new file, `pos-shifts.ts`, holds the reasons, the count, the arithmetic, the device's three
inputs and what the managers read. `pos.ts` gets the register's new fields and the sale's shift; `sync.ts` the reasons
and the three commands. The rest are short lists: a permission, error codes, audit actions, a bell, a journal source.

### `pos-shifts.ts` (new): reasons, the count and the cash of a shift

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema } from './journal.js';
import {
  absMoney,
  addMoney,
  compareMoney,
  multiplyMoney,
  subtractMoney,
  sumMoney,
} from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { POS_PAYMENT_METHODS, POS_SHIFT_STATUSES } from './pos.js';
import { positiveAmountSchema } from './receipts.js';
import { optionalIdSchema } from './stock.js';

// Step 20b: shifts at a POS counter. A shift is one cashier on one device at one register, from
// the count of the drawer at the start to the count at the end. A register sells only inside a
// shift, and has one open shift at a time (you chose this).
//
//   open    the cashier counts the drawer (by notes or as a total). The count is compared with
//           what the last shift left in it (posLastShiftSchema.cashLeft); a difference posts to
//           the register's over/short account. A register's first shift has nothing to compare
//           with: its count is the float, and comes in from the account of an "in" reason the
//           cashier picks ("Float from safe", you chose this).
//   during  sales (pos.ts), and money put in or taken out with a reason (pay in, pay out). The
//           reason says which account the money comes from or goes to; the cashier never picks an
//           account. Cash sent to the bank is a pay out too: counted cash stays in the register's
//           cash account until a pay out moves it (you chose this).
//   close   the cashier counts the drawer again without seeing what it should hold (a blind
//           count). Only then does the screen show the expected cash and the difference, and the
//           close is final (you chose this). The difference posts to over/short by itself; one
//           bigger than the register's varianceAlert rings a bell to the managers.
//
// It all happens on the device, offline too, as three sync commands (sync.ts): pos_shift.open,
// pos_cash_movement.create and pos_shift.close. The device numbers its shifts itself, like its
// sales, because only the device that holds a register works on it. The server posts each command
// when it arrives and never refuses one for money or for permission: the money was counted or
// moved already. A shift that nobody can close (a lost device, a cashier gone home) is closed
// without a count: by a revoke of its device, or online by someone with pos.shift.manage.

// POS1-S0042: the register's code, an S and the shift's number in that register, 4 digits (a
// receipt has 6 and no S, so the two never look alike). Like a receipt number (formatPosNumber),
// it never restarts and simply grows a digit after 9999.
export const POS_SHIFT_PADDING = 4;

export function formatShiftNumber(registerCode: string, sequence: number): string {
  return `${registerCode}-S${String(sequence).padStart(POS_SHIFT_PADDING, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Pay in and pay out reasons (Settings → POS, pos.register.manage)

// in = money put into the drawer (a float from the safe, change from the bank); out = money taken
// out (a bank deposit, tea for the staff, a delivery boy's fare)
export const POS_CASH_DIRECTIONS = ['in', 'out'] as const;
export type PosCashDirection = (typeof POS_CASH_DIRECTIONS)[number];

export const posCashReasonSchema = z.object({
  id: z.uuid(),
  // "Bank deposit", "Tea and snacks", "Float from safe"
  name: z.string(),
  // Never changes: a pay in turned into a pay out would change the meaning of every movement made
  // with it. A reason the other way is a new reason.
  direction: z.enum(POS_CASH_DIRECTIONS),
  // The other side of the cash: a bank or safe account, or an expense. It may change; a movement
  // keeps the account it was posted to.
  accountId: z.uuid(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PosCashReason = z.infer<typeof posCashReasonSchema>;

// A shop has a handful; the whole list at once
export const posCashReasonListSchema = z.object({ items: z.array(posCashReasonSchema) });

const reasonFieldsSchema = z.object({
  name: z.string().trim().min(2, errorCode('pos_reason_name_required')).max(60),
  // The form's empty select sends '' — "not chosen", with its own message. The server checks it is
  // an active account that is not a group, and not one a document keeps per party or the inventory
  // account (pos_reason_account_invalid): a pay out names no customer and moves no stock.
  accountId: z.uuid(errorCode('pos_reason_account_invalid')),
});

export const posCashReasonInputSchema = reasonFieldsSchema.extend({
  direction: z.enum(POS_CASH_DIRECTIONS),
});
export type PosCashReasonInput = z.infer<typeof posCashReasonInputSchema>;
export type PosCashReasonFormValues = z.input<typeof posCashReasonInputSchema>;

// No direction: it never changes
export const updatePosCashReasonInputSchema = reasonFieldsSchema.extend({
  version: versionSchema,
});
export type UpdatePosCashReasonInput = z.infer<typeof updatePosCashReasonInputSchema>;
export type UpdatePosCashReasonFormValues = z.input<typeof updatePosCashReasonInputSchema>;

export const posCashReasonVersionInputSchema = z.object({ version: versionSchema });

export const POS_CASH_REASON_STATUSES = ['active', 'archived'] as const;

export const posCashReasonListQuerySchema = z.object({
  status: z.enum(POS_CASH_REASON_STATUSES).default('active'),
});
export type PosCashReasonListQuery = z.input<typeof posCashReasonListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Counting the drawer

// The notes and coins of the taka, biggest first, as the count's boxes show them
export const CASH_DENOMINATIONS = [
  '1000',
  '500',
  '200',
  '100',
  '50',
  '20',
  '10',
  '5',
  '2',
  '1',
] as const;
export type CashDenomination = (typeof CASH_DENOMINATIONS)[number];

// A supermarket's drawer at the end of Eid shopping holds a few thousand notes of one kind at most
export const MAX_NOTES = 99_999;

// How many of each note. A count is counted, never added up like money, so it is a number.
const noteCount = z.number().int().min(0).max(MAX_NOTES);

export const cashNotesSchema = z.object({
  '1000': noteCount,
  '500': noteCount,
  '200': noteCount,
  '100': noteCount,
  '50': noteCount,
  '20': noteCount,
  '10': noteCount,
  '5': noteCount,
  '2': noteCount,
  '1': noteCount,
} satisfies Record<CashDenomination, z.ZodType>);
export type CashNotes = z.infer<typeof cashNotesSchema>;

// What the notes add up to, with 4 decimals like every amount
export function cashNotesTotal(notes: CashNotes): string {
  return sumMoney(
    CASH_DENOMINATIONS.map((denomination) =>
      multiplyMoney(String(notes[denomination]), denomination),
    ),
  );
}

// Taka with up to 2 decimals: a drawer holds no tenth of a paisa. 0 is a count (an empty drawer).
const CASH_TOTAL = /^\d{1,12}(?:\.\d{1,2})?$/;

// A count, by notes or as a total (you chose both). By notes, the device sends the notes and their
// total, and the total must be theirs; as a total, notes is null. The API sends it back the same
// way, so the shift's page shows the notes that were counted.
export const cashCountSchema = z
  .object({
    notes: cashNotesSchema.nullable(),
    total: z
      .string()
      .trim()
      .refine((value) => value !== '', errorCode('pos_count_required'))
      .refine((value) => value === '' || CASH_TOTAL.test(value), errorCode('money_format')),
  })
  .superRefine((count, ctx) => {
    if (count.notes === null || !CASH_TOTAL.test(count.total)) return;
    if (compareMoney(count.total, cashNotesTotal(count.notes)) !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['total'],
        message: errorCode('pos_count_total_mismatch'),
      });
    }
  });
export type CashCount = z.infer<typeof cashCountSchema>;
export type CashCountFormValues = z.input<typeof cashCountSchema>;

// ---------------------------------------------------------------------------------------------
// The arithmetic of a shift. The device works it out from its own sales and movements (one device
// per shift, so it has them all) for the close's result screen; the server works it out again when
// the close arrives, and its number is the one in the books.

export interface ShiftCash {
  // The opening count
  opening: string;
  // Cash the sales took in, and the change they gave back
  cashTaken: string;
  changeGiven: string;
  // Pay ins and pay outs
  paidIn: string;
  paidOut: string;
}

// What the drawer should hold. The float of a register's first shift is its opening count, not a
// pay in, so it is counted once.
export function expectedCashOf(cash: ShiftCash): string {
  return subtractMoney(
    addMoney(addMoney(cash.opening, cash.cashTaken), cash.paidIn),
    addMoney(cash.changeGiven, cash.paidOut),
  );
}

// Counted less expected: above zero = over (more cash than there should be), below = short
export function cashDifferenceOf(counted: string, expected: string): string {
  return subtractMoney(counted, expected);
}

// A difference rings the bell when it is bigger than the register's limit, either way. ৳500 short
// at a limit of ৳500 is the limit, and not over it.
export function isOverVarianceAlert(difference: string, varianceAlert: string): boolean {
  return compareMoney(absMoney(difference), varianceAlert) > 0;
}

// ---------------------------------------------------------------------------------------------
// What the device sends (inside the three commands, sync.ts)

// The held carts of a shift (decision 10: on the device only). The close drops them and says how
// many, for the audit log.
export const MAX_HELD_CARTS = 20;

// An amount the device worked out, which may be below zero only through a bug; 4 decimals
const SIGNED_MONEY = /^-?\d{1,15}(?:\.\d{1,4})?$/;

export const posShiftOpenInputSchema = z.object({
  registerId: z.uuid(),
  // Its number in the register's series (formatShiftNumber)
  sequence: z.number().int().min(1),
  // The device's today in the workspace's time zone and the moment, like a sale's: the opening
  // difference (or the float) is booked on `date`, or on the first open day after it
  date: z.iso.date(),
  openedAt: z.iso.datetime(),
  opening: cashCountSchema,
  // A register's first shift only: the "in" reason its float came by. '' or null on any later
  // shift, and on a first shift that starts with an empty drawer.
  floatReasonId: optionalIdSchema,
});
export type PosShiftOpenInput = z.infer<typeof posShiftOpenInputSchema>;
export type PosShiftOpenFormValues = z.input<typeof posShiftOpenInputSchema>;

export const posCashMovementInputSchema = z.object({
  shiftId: z.uuid(),
  // The form's empty select sends '' — "pick a reason"
  reasonId: z.uuid(errorCode('pos_reason_required')),
  amount: positiveAmountSchema('pos_cash_amount_required'),
  // "Deposit slip 0042, DBBL Dhanmondi", "Fare for the Uttara delivery"
  note: optionalText(200),
  date: z.iso.date(),
  movedAt: z.iso.datetime(),
});
export type PosCashMovementInput = z.infer<typeof posCashMovementInputSchema>;
export type PosCashMovementFormValues = z.input<typeof posCashMovementInputSchema>;

export const posShiftCloseInputSchema = z.object({
  date: z.iso.date(),
  closedAt: z.iso.datetime(),
  counted: cashCountSchema,
  // What the device expected (expectedCashOf), as its result screen showed it. The server works it
  // out again; when the two differ, the audit log says so (a sale missing from one of them).
  deviceExpected: z.string().regex(SIGNED_MONEY),
  // How many held carts the close dropped
  heldDropped: z.number().int().min(0).max(MAX_HELD_CARTS),
});
export type PosShiftCloseInput = z.infer<typeof posShiftCloseInputSchema>;
export type PosShiftCloseFormValues = z.input<typeof posShiftCloseInputSchema>;

// ---------------------------------------------------------------------------------------------
// What the API sends: the shifts, for the managers (pos.shift.manage)

const personRefSchema = z.object({ id: z.uuid(), fullName: z.string() });

export const posShiftSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  register: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  branchId: z.uuid(),
  sequence: z.number().int(),
  status: z.enum(POS_SHIFT_STATUSES),
  cashier: personRefSchema,
  // The device it ran on (its name now)
  device: z.object({ id: z.uuid(), name: z.string() }),
  // By the device's clock
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  // The opening count's total
  openingCash: z.string(),
  // What the drawer should hold: so far while the shift is open, at the close once closed
  expectedCash: z.string(),
  // The closing count's total; null while open, and for a shift closed without a count
  countedCash: z.string().nullable(),
  // Counted less expected at the close (cashDifferenceOf); null when there was no closing count
  difference: z.string().nullable(),
  // The sales the server has received in it
  saleCount: z.number().int(),
  salesTotal: z.string(),
});
export type PosShiftSummary = z.infer<typeof posShiftSummarySchema>;

export const posCashMovementSchema = z.object({
  id: z.uuid(),
  reason: z.object({ id: z.uuid(), name: z.string() }),
  direction: z.enum(POS_CASH_DIRECTIONS),
  amount: z.string(),
  note: z.string().nullable(),
  // The day in the books, and when it happened by the device's clock
  date: z.iso.date(),
  movedAt: z.iso.datetime(),
  // The reason's account when it was posted
  accountId: z.uuid(),
  entry: entryRefSchema,
});
export type PosCashMovement = z.infer<typeof posCashMovementSchema>;

export const posShiftSchema = posShiftSummarySchema.extend({
  opening: z.object({
    count: cashCountSchema,
    date: z.iso.date(),
    // What the last shift left in the drawer; null for a register's first shift
    comparedWith: z.string().nullable(),
    // The opening count less comparedWith; null for a first shift
    difference: z.string().nullable(),
    // A first shift's float: the reason it came by
    floatReason: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    // The difference (or the float) in the books; null when there was none
    entry: entryRefSchema.nullable(),
  }),
  // null while open, and for a shift closed without a count
  closing: z
    .object({
      count: cashCountSchema,
      date: z.iso.date(),
      deviceExpected: z.string(),
      heldDropped: z.number().int(),
      // The difference in the books; null when the count matched
      entry: entryRefSchema.nullable(),
    })
    .nullable(),
  // Who closed it without a count: a manager online, or the person who revoked its device
  closedBy: personRefSchema.nullable(),
  // The parts of expectedCash (ShiftCash)
  cash: z.object({
    opening: z.string(),
    cashTaken: z.string(),
    changeGiven: z.string(),
    paidIn: z.string(),
    paidOut: z.string(),
  }),
  // What the sales took by each method, every method of the register, cash before the change
  payments: z.array(z.object({ method: z.enum(POS_PAYMENT_METHODS), amount: z.string() })),
  movements: z.array(posCashMovementSchema),
});
export type PosShift = z.infer<typeof posShiftSchema>;

export const posShiftListQuerySchema = pageQuerySchema.extend({
  registerId: z.uuid().optional(),
  status: z.enum(POS_SHIFT_STATUSES).optional(),
});
export type PosShiftListQuery = z.input<typeof posShiftListQuerySchema>;

export const posShiftPageSchema = pageOf(posShiftSummarySchema);
export type PosShiftPage = z.infer<typeof posShiftPageSchema>;

// Why a manager closes a shift nobody can close: "Sumi went home sick, the drawer was taken to the
// safe". For the audit log.
export const posShiftCloseWithoutCountInputSchema = z.object({ note: optionalText(200) });
export type PosShiftCloseWithoutCountInput = z.infer<typeof posShiftCloseWithoutCountInputSchema>;

const idParamsSchema = z.object({ id: z.uuid() });

// The reasons are read by everyone (the settings page shows them, read-only without the
// permission) and set up with pos.register.manage, like the registers. The shifts hold what each
// cashier's drawer was short by, so even reading them needs pos.shift.manage. Shifts are opened,
// changed and closed only through sync commands.
export const posShiftRoutes = {
  listCashReasons: defineRoute({
    method: 'GET',
    path: '/pos/cash-reasons',
    summary: 'The reasons a cashier may put money into or take money out of the drawer',
    auth: 'bearer',
    status: 200,
    query: posCashReasonListQuerySchema,
    response: posCashReasonListSchema,
  }),
  createCashReason: defineRoute({
    method: 'POST',
    path: '/pos/cash-reasons',
    summary: 'Add a pay in or pay out reason with its account',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 201,
    body: posCashReasonInputSchema,
    response: posCashReasonSchema,
  }),
  updateCashReason: defineRoute({
    method: 'PUT',
    path: '/pos/cash-reasons/:id',
    summary: "Change a reason's name or account",
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: idParamsSchema,
    body: updatePosCashReasonInputSchema,
    response: posCashReasonSchema,
  }),
  archiveCashReason: defineRoute({
    method: 'POST',
    path: '/pos/cash-reasons/:id/archive',
    summary: 'Stop offering a reason at the counter',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: idParamsSchema,
    body: posCashReasonVersionInputSchema,
    response: posCashReasonSchema,
  }),
  restoreCashReason: defineRoute({
    method: 'POST',
    path: '/pos/cash-reasons/:id/restore',
    summary: 'Offer an archived reason again',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: idParamsSchema,
    body: posCashReasonVersionInputSchema,
    response: posCashReasonSchema,
  }),
  listShifts: defineRoute({
    method: 'GET',
    path: '/pos/shifts',
    summary: 'POS shifts, newest first, with their counts and differences',
    auth: 'bearer',
    permission: 'pos.shift.manage',
    status: 200,
    query: posShiftListQuerySchema,
    response: posShiftPageSchema,
  }),
  getShift: defineRoute({
    method: 'GET',
    path: '/pos/shifts/:id',
    summary: 'One POS shift with its counts, cash, payments and pay ins and outs',
    auth: 'bearer',
    permission: 'pos.shift.manage',
    status: 200,
    params: idParamsSchema,
    response: posShiftSchema,
  }),
  closeWithoutCount: defineRoute({
    method: 'POST',
    path: '/pos/shifts/:id/close-without-count',
    summary: 'Close a shift nobody can close at its counter; no difference is posted',
    auth: 'bearer',
    permission: 'pos.shift.manage',
    status: 200,
    params: idParamsSchema,
    body: posShiftCloseWithoutCountInputSchema,
    response: posShiftSchema,
  }),
};
```

**The header and the number:**

- **The header comment is the design in one place:** the open, the movements and the close, why the device numbers its
  shifts, and why the server never refuses a shift's command. 20b.3's posting and 20b.6's screens both follow it.
- **`formatShiftNumber()` pads with `padStart`,** like `formatPosNumber()`: it never cuts a longer number (decision 16).

**The reasons:**

- **`direction` is in the create input only** (decision 20). An update that sends it anyway has it dropped by the
  object's parse, the way a register's code is.
- **`accountId` gets its own message for the empty select.** The server checks the rest (active, not a group, not a
  party account, not inventory) in 20b.3, because only the server has the chart.

**The count:**

- **`CASH_DENOMINATIONS` is the boxes' order,** biggest first, as a cashier counts.
- **`cashNotesSchema` is checked with `satisfies Record<CashDenomination, z.ZodType>`:** a new note added to the list
  fails the type check until the count has a box for it.
- **`cashNotesTotal()` uses `multiplyMoney()`,** not `count * Number(denomination)`: money is never a JavaScript number,
  even when it would fit.
- **`cashCountSchema` checks the total against the notes only when the total is complete** (`CASH_TOTAL.test`). An
  empty or wrong box already has its own error; a second one would only repeat it.

**The arithmetic:**

- **`expectedCashOf()` reads like the sentence in decision 19:** what came in added to the opening, then what went out
  taken off, in one expression the device and the server share.
- **`cashDifferenceOf()` is counted less expected:** positive is over, negative is short, the sign the books need
  (short debits over/short).
- **`isOverVarianceAlert()` compares the size of the difference** (`absMoney`) with the limit, so short and over ring
  alike.

**What the device sends:**

- **Every input has `date` and a moment** (decision 21): the books need the day, the shift's page shows the time.
- **`floatReasonId` uses `optionalIdSchema`:** the form's empty select and `null` are both "no float reason".
- **`deviceExpected` is a signed amount with 4 decimals,** the way the device's arithmetic gives it. It is only
  compared, never posted (decision 22).

**What the API sends:**

- **`posShiftSummarySchema.expectedCash` is never null:** so far while the shift is open, at the close after it. A
  manager looking at an open shift sees what the drawer should hold now.
- **`posShiftSchema.closing` is null for a shift closed without a count,** and `closedBy` says who closed it. The two
  together tell the three endings apart with `status`.
- **`posCashMovementSchema.entry` is never null:** a movement always has an amount above zero, so it always posts.
- **`posShiftRoutes` has no route that opens or closes a shift at the counter;** only sync commands do (decision 25).
  `closeWithoutCount` is a `POST` that answers `200`: it changes a shift, it makes nothing.

```ts
import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  cashCountSchema,
  cashDifferenceOf,
  cashNotesTotal,
  expectedCashOf,
  formatShiftNumber,
  isOverVarianceAlert,
  posCashMovementInputSchema,
  posCashReasonInputSchema,
  posShiftCloseInputSchema,
  updatePosCashReasonInputSchema,
} from './pos-shifts.js';

const SHIFT = '0192f1e0-0000-7000-8000-000000000001';
const BANK = '0192f1e0-0000-7000-8000-000000000002';
const REASON = '0192f1e0-0000-7000-8000-000000000003';
const AT = '2026-10-28T15:30:00.000Z';

// The error codes where the form will show them: field path → code
function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

// The drawer of the front counter at a super shop in Chattogram, at the end of a Thursday
const notes = {
  '1000': 4,
  '500': 5,
  '200': 0,
  '100': 12,
  '50': 3,
  '20': 6,
  '10': 9,
  '5': 2,
  '2': 0,
  '1': 0,
};

describe('shift numbers', () => {
  it("puts the register's code and an S before 4 digits, and grows past them", () => {
    expect(formatShiftNumber('POS1', 42)).toBe('POS1-S0042');
    expect(formatShiftNumber('CTG2', 12345)).toBe('CTG2-S12345');
  });
});

describe('the count', () => {
  it('adds the notes up', () => {
    // 4,000 + 2,500 + 1,200 + 150 + 120 + 90 + 10
    expect(cashNotesTotal(notes)).toBe('8070.0000');
  });

  it('takes notes with their total, or a total alone', () => {
    expect(cashCountSchema.parse({ notes, total: '8070' }).notes).toEqual(notes);
    expect(cashCountSchema.parse({ notes: null, total: ' 2350.50 ' }).total).toBe('2350.50');
    expect(cashCountSchema.parse({ notes: null, total: '0' }).total).toBe('0');
  });

  it('refuses a total that is not what the notes add up to, an empty box and a tenth of a paisa', () => {
    const parse = (count: object) => cashCountSchema.safeParse(count, { error: contractErrorMap });
    expect(errorsOf(parse({ notes, total: '8000' }))).toEqual({
      total: 'pos_count_total_mismatch',
    });
    expect(errorsOf(parse({ notes: null, total: '' }))).toEqual({ total: 'pos_count_required' });
    expect(errorsOf(parse({ notes: null, total: '12.345' }))).toEqual({ total: 'money_format' });
  });

  it('refuses a note count that is not a whole number', () => {
    const result = cashCountSchema.safeParse({ notes: { ...notes, '500': 2.5 }, total: '6820' });
    expect(Object.keys(errorsOf(result))).toEqual(['notes.500']);
  });
});

describe('the cash of a shift', () => {
  // A ৳5,000 float; ৳12,480 in cash from the sales and ৳1,320 given back; ৳2,000 of change from the
  // bank put in; ৳10,000 sent to the bank
  const cash = {
    opening: '5000',
    cashTaken: '12480',
    changeGiven: '1320',
    paidIn: '2000',
    paidOut: '10000',
  };

  it('expects the opening, plus what came in, less what went out', () => {
    expect(expectedCashOf(cash)).toBe('8160.0000');
  });

  it('is short when less was counted, and rings the bell only above the limit', () => {
    const short = cashDifferenceOf('7640', expectedCashOf(cash));
    expect(short).toBe('-520.0000');
    expect(isOverVarianceAlert(short, '500')).toBe(true);
    expect(isOverVarianceAlert('-500.0000', '500')).toBe(false);
    expect(isOverVarianceAlert('0.5000', '0')).toBe(true);
    expect(isOverVarianceAlert('0.0000', '0')).toBe(false);
  });
});

describe('reasons', () => {
  it('keeps the direction on a new reason, and drops it from a change', () => {
    const input = posCashReasonInputSchema.parse({
      name: ' Bank deposit ',
      direction: 'out',
      accountId: BANK,
    });
    expect(input).toEqual({ name: 'Bank deposit', direction: 'out', accountId: BANK });
    const update = updatePosCashReasonInputSchema.parse({ ...input, direction: 'in', version: 2 });
    expect(update).not.toHaveProperty('direction');
  });

  it('refuses a short name and no account, each with its code', () => {
    const result = posCashReasonInputSchema.safeParse(
      { name: 'B', direction: 'in', accountId: '' },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      name: 'pos_reason_name_required',
      accountId: 'pos_reason_account_invalid',
    });
  });
});

describe("the cashier's forms", () => {
  it('asks for a reason and an amount above zero', () => {
    const result = posCashMovementInputSchema.safeParse(
      { shiftId: SHIFT, reasonId: '', amount: '0', note: '', date: '2026-10-28', movedAt: AT },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      reasonId: 'pos_reason_required',
      amount: 'pos_cash_amount_required',
    });
  });

  it('keeps the note of a pay out', () => {
    const input = posCashMovementInputSchema.parse({
      shiftId: SHIFT,
      reasonId: REASON,
      amount: '10000',
      note: 'Deposit slip 0042, DBBL Agrabad',
      date: '2026-10-28',
      movedAt: AT,
    });
    expect(input.note).toBe('Deposit slip 0042, DBBL Agrabad');
  });

  it('drops at most 20 held carts at the close', () => {
    const close = {
      date: '2026-10-28',
      closedAt: AT,
      counted: { notes, total: '8070' },
      deviceExpected: '8160.0000',
      heldDropped: 21,
    };
    expect(Object.keys(errorsOf(posShiftCloseInputSchema.safeParse(close)))).toEqual([
      'heldDropped',
    ]);
    expect(posShiftCloseInputSchema.parse({ ...close, heldDropped: 2 }).counted.total).toBe('8070');
  });
});
```

- **The fixtures are the front counter of a super shop in Chattogram** at the end of a Thursday: a drawer of notes that
  anyone can add up on paper (৳8,070), and the day of "The whole picture" above (৳8,160 expected, ৳520 short).
- **"Rings the bell only above the limit"** has the edge cases: ৳500 at a limit of ৳500 (no bell), half a taka at a
  limit of 0 (a bell), and nothing at 0 (no bell).
- **"Refuses a note count that is not a whole number"** checks that the error points at the one box (`notes.500`).

### `pos.ts`: the register's shift settings and the sale's shift

```diff
@@ -60,6 +60,11 @@ import { TAX_RATE_FORMAT } from './tax-rates.js';
 // and its stock movements. It never refuses a sale for stock (you chose this): the money was taken
 // and the receipt printed, so stock that is not there goes below zero, and the sale is listed as
 // "sold short" for someone to put right.
+//
+// Step 20b: shifts. A register sells only inside a shift: one cashier on one device, from the
+// count of the drawer at the start to the count at the end (pos-shifts.ts). The register holds
+// what its shifts need: the account a difference in the cash goes to, how big a difference rings
+// a bell, and how long /pos waits before it locks the screen.
 
 // ---------------------------------------------------------------------------------------------
 // Registers
@@ -75,6 +80,35 @@ export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];
 export const POS_PAPER_WIDTHS = ['58', '80'] as const;
 export type PosPaperWidth = (typeof POS_PAPER_WIDTHS)[number];
 
+// Step 20b: how long /pos waits with no key, click or touch before it locks the screen (step 19b's
+// lock screen and the device's PIN). Minutes as text, like the paper width, so the form's select
+// sends them as they are. 'off' = it never locks by itself.
+export const POS_LOCK_AFTER = ['off', '2', '5', '10', '15'] as const;
+export type PosLockAfter = (typeof POS_LOCK_AFTER)[number];
+
+// For the screen's timer, in milliseconds; null = off
+export function lockAfterMs(value: PosLockAfter): number | null {
+  return value === 'off' ? null : Number(value) * 60_000;
+}
+
+// A shift (pos-shifts.ts) is open until its cashier counts the drawer and closes it. A shift whose
+// device was revoked, or that a manager closed online, is closed without a count: nobody counted
+// the drawer, so no difference was posted, and the next shift's opening count finds it.
+export const POS_SHIFT_STATUSES = ['open', 'closed', 'closed_without_count'] as const;
+export type PosShiftStatus = (typeof POS_SHIFT_STATUSES)[number];
+
+// The register's latest shift, as the server knows it. A device that takes the register numbers
+// its next shift after this one, and compares its first count with cashLeft.
+export const posLastShiftSchema = z.object({
+  id: z.uuid(),
+  sequence: z.number().int().min(1),
+  status: z.enum(POS_SHIFT_STATUSES),
+  // What should be in the drawer now: the count at the close, or, for a shift closed without a
+  // count, what the server expected. null while the shift is open.
+  cashLeft: z.string().nullable(),
+});
+export type PosLastShift = z.infer<typeof posLastShiftSchema>;
+
 // POS1-000123: the register's code and the sale's number in it, 6 digits. The series never
 // restarts (no year, you chose this), and a register that passes 999999 simply gets 7 digits.
 // The device and the server both call this, so the receipt and the books hold the same number.
@@ -115,11 +149,19 @@ export const posRegisterSchema = z.object({
   paperWidth: z.enum(POS_PAPER_WIDTHS),
   // A line or two at the end of the receipt: "Goods once sold are exchanged within 7 days"
   receiptFooter: z.string().nullable(),
+  // Step 20b. Where a difference in the cash count goes: an income or expense account, "Cash
+  // over/short". null on a register made before 20b: it opens no shift until someone sets one.
+  overShortAccountId: z.uuid().nullable(),
+  // A difference bigger than this, either way, rings a bell to the managers. Whole taka: "500".
+  varianceAlert: z.string(),
+  lockAfter: z.enum(POS_LOCK_AFTER),
   // The device that holds it now; null = free
   deviceId: z.uuid().nullable(),
   // The highest number the server has received from it; 0 = none yet. A device that takes the
   // register goes on from here.
   lastNumber: z.number().int().min(0),
+  // Step 20b: its latest shift; null = it never had one
+  lastShift: posLastShiftSchema.nullable(),
   archivedAt: z.iso.datetime().nullable(),
   version: z.number().int(),
   updatedAt: z.iso.datetime(),
@@ -155,6 +197,13 @@ const discountLimitSchema = z
   )
   .transform((value) => (value === '' ? '0' : value));
 
+// Whole taka, up to 9 digits. '' (an empty box) = 0: a bell for any difference at all.
+const varianceAlertSchema = z
+  .string()
+  .trim()
+  .regex(/^\d{0,9}$/, errorCode('pos_variance_alert_format'))
+  .transform((value) => (value === '' ? '0' : value));
+
 const registerFieldsSchema = z.object({
   name: z.string().trim().min(2, errorCode('pos_register_name_required')).max(60),
   // The form's empty select sends '' — "not chosen", with its own message
@@ -168,6 +217,10 @@ const registerFieldsSchema = z.object({
   maxDiscountPercent: discountLimitSchema,
   paperWidth: z.enum(POS_PAPER_WIDTHS),
   receiptFooter: optionalText(200),
+  // Required in the form, also for a register made before 20b: a shift needs it
+  overShortAccountId: z.uuid(errorCode('pos_over_short_required')),
+  varianceAlert: varianceAlertSchema,
+  lockAfter: z.enum(POS_LOCK_AFTER),
 });
 
 export const posRegisterInputSchema = registerFieldsSchema.extend({ code: registerCodeSchema });
@@ -378,6 +431,9 @@ const posSaleFieldsSchema = z.object({
   // The register it was sold on, and its number in that register's series (formatPosNumber)
   registerId: z.uuid(),
   sequence: z.number().int().min(1),
+  // Step 20b: the shift it was sold in. null only for a sale made before 20b and still in a
+  // device's outbox when the app was updated; since then the device sends a shift with every sale.
+  shiftId: z.uuid().nullable().default(null),
   // The device's today in the workspace's time zone, and the moment, by the device's clock. The
   // receipt prints them. The server books the sale on `date`, unless the date is after the server's
   // own today (a clock set ahead) or in a closed period (step 11): then on the first day it can.
@@ -465,6 +521,8 @@ export const posSaleSummarySchema = z.object({
   id: z.uuid(),
   number: z.string(),
   register: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
+  // Step 20b: the shift it was sold in, "POS1-S0042"; null for a sale from before 20b
+  shift: z.object({ id: z.uuid(), number: z.string() }).nullable(),
   branchId: z.uuid(),
   warehouseId: z.uuid(),
   // The day it is in the books (see posSaleInputSchema), and when it was sold by the device's clock
@@ -606,7 +664,7 @@ export const posRoutes = {
   updateRegister: defineRoute({
     method: 'PUT',
     path: '/pos/registers/:id',
-    summary: "Change a POS register's name, warehouse, accounts, discount limit or receipt",
+    summary: "Change a POS register's name, warehouse, accounts, limits, receipt or lock",
     auth: 'bearer',
     permission: 'pos.register.manage',
     status: 200,
@@ -650,7 +708,8 @@ export const posRoutes = {
   releaseRegister: defineRoute({
     method: 'POST',
     path: '/pos/registers/:id/release',
-    summary: 'This device lets go of its register, so another device can take it',
+    summary:
+      'This device lets go of its register so another can take it; not while a shift is open',
     auth: 'bearer',
     status: 200,
     params: posParamsSchema,
```

- **`POS_SHIFT_STATUSES` and `posLastShiftSchema` live here, not in `pos-shifts.ts`.** The register's schema needs them,
  and `pos-shifts.ts` already imports this file: a cycle between the two would read a schema before it is made.
- **`overShortAccountId` is nullable in what the API sends and required in the form** (decision 13). The same shape is
  used for the claim's answer, so a device sees at once that a 20a register is not ready for a shift.
- **`varianceAlertSchema` allows no decimals:** the limit is a round sum a manager sets, and paisa in it would only be a
  typing mistake.
- **`shiftId` is `.nullable().default(null)`** (decision 24): a command from an old outbox without the field parses as
  a sale without a shift.
- **The sale's summary gets `shift`,** so the POS sales list can link each sale to its shift.

```diff
@@ -3,6 +3,7 @@ import { describe, expect, it } from 'vitest';
 import { contractErrorMap } from './errors.js';
 import {
   formatPosNumber,
+  lockAfterMs,
   posChangeOf,
   posOverridesOf,
   posRegisterInputSchema,
@@ -20,6 +21,7 @@ const REGISTER = '0192f1d0-0000-7000-8000-000000000004';
 const VARIANT = '0192f1d0-0000-7000-8000-000000000005';
 const UNIT = '0192f1d0-0000-7000-8000-000000000006';
 const RATE = '0192f1d0-0000-7000-8000-000000000007';
+const OVER_SHORT = '0192f1d0-0000-7000-8000-000000000008';
 
 // The error codes where the form will show them: field path → code
 function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
@@ -45,6 +47,9 @@ describe('register input', () => {
     maxDiscountPercent: '',
     paperWidth: '80',
     receiptFooter: '',
+    overShortAccountId: OVER_SHORT,
+    varianceAlert: '',
+    lockAfter: '5',
   };
 
   it('upper-cases the code, and reads the empty boxes as nothing', () => {
@@ -53,16 +58,19 @@ describe('register input', () => {
     expect(input.accounts).toEqual({ cash: CASH, card: null, bkash: BKASH, nagad: null });
     expect(input.maxDiscountPercent).toBe('0');
     expect(input.receiptFooter).toBeNull();
+    expect(input.varianceAlert).toBe('0');
     expect(registerMethods({ ...input.accounts, cash: CASH })).toEqual(['cash', 'bkash']);
   });
 
-  it('refuses a hyphen in the code, no cash account and a limit over 100%, each with its code', () => {
+  it('refuses a hyphen in the code, no cash or over/short account, a limit over 100% and a bell in paisa', () => {
     const result = posRegisterInputSchema.safeParse(
       {
         ...counter,
         code: 'POS-1',
         accounts: { ...counter.accounts, cash: '' },
         maxDiscountPercent: '100.5',
+        overShortAccountId: '',
+        varianceAlert: '500.50',
       },
       { error: contractErrorMap },
     );
@@ -70,9 +78,16 @@ describe('register input', () => {
       code: 'pos_register_code_format',
       'accounts.cash': 'pos_register_cash_required',
       maxDiscountPercent: 'pos_discount_limit_format',
+      overShortAccountId: 'pos_over_short_required',
+      varianceAlert: 'pos_variance_alert_format',
     });
   });
 
+  it('locks the screen after the minutes chosen, or never', () => {
+    expect(lockAfterMs('5')).toBe(300_000);
+    expect(lockAfterMs('off')).toBeNull();
+  });
+
   it('never changes the code once the register exists', () => {
     const update = updatePosRegisterInputSchema.parse({ ...counter, code: 'POS9', version: 2 });
     expect(update).not.toHaveProperty('code');
```

- **The register fixture gets the three new fields,** and the refusal test two more boxes: no over/short account and a
  limit in paisa.

### `sync.ts`: the reasons and the three commands

```diff
@@ -11,6 +11,12 @@ import { errorCode, problemSchema } from './errors.js';
 import { versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
 import { posRegisterSchema, posSaleInputSchema } from './pos.js';
+import {
+  posCashMovementInputSchema,
+  posCashReasonSchema,
+  posShiftCloseInputSchema,
+  posShiftOpenInputSchema,
+} from './pos-shifts.js';
 import { priceListSchema } from './price-lists.js';
 import { productCategorySchema } from './product-categories.js';
 import { productSchema } from './products.js';
@@ -35,7 +41,7 @@ import { warehouseSchema } from './warehouses.js';
 // active customers with their groups, the warehouses of the device's branch and the stock in them,
 // and the part of the settings a sale needs. No customer balances and no stock values: they
 // change with every invoice and every movement, and they need their own permissions. Step 20a adds
-// the POS registers of the branch.
+// the POS registers of the branch, step 20b the pay in and pay out reasons.
 
 // The version of this protocol: what the entities below are and what their rows hold. A client
 // sends the version it was built with; the server answers sync_protocol_mismatch to any other,
@@ -43,7 +49,9 @@ import { warehouseSchema } from './warehouses.js';
 // client never receives a row it cannot read, and a client that moved to a new version starts
 // again with a full pull, so it does not miss the rows of an entity it did not know before.
 // 2 (step 20a): the POS registers (pos_register) and the pos_sale.create command.
-export const SYNC_PROTOCOL = 2;
+// 3 (step 20b): the pay in / pay out reasons (pos_cash_reason), a register's shift settings and
+// latest shift, a sale's shift, and the three shift commands.
+export const SYNC_PROTOCOL = 3;
 
 // Every kind of row a device keeps. The order is the order of a full pull: the small lists that
 // the others point at come first, so a page never shows a product before its units.
@@ -54,6 +62,7 @@ export const SYNC_ENTITIES = [
   'tax_rate',
   'warehouse',
   'pos_register',
+  'pos_cash_reason',
   'price_list',
   'customer_group',
   'product',
@@ -106,6 +115,12 @@ export type SyncCustomerGroup = z.infer<typeof syncCustomerGroupSchema>;
 export const syncPosRegisterSchema = posRegisterSchema.omit({ lastNumber: true });
 export type SyncPosRegister = z.infer<typeof syncPosRegisterSchema>;
 
+// A pay in or pay out reason (step 20b), active ones only: every device of the workspace gets all
+// of them, since a reason belongs to no branch. With its account, which the cashier never picks:
+// the device only shows the name.
+export const syncPosCashReasonSchema = posCashReasonSchema;
+export type SyncPosCashReason = z.infer<typeof syncPosCashReasonSchema>;
+
 // A customer with its addresses, without the balance (decision 10: the list asks the server for
 // the balances of the rows it shows, online only)
 export const syncCustomerSchema = customerSchema.omit({ balance: true });
@@ -158,7 +173,7 @@ export function stockKey(row: Pick<SyncStock, 'warehouseId' | 'variantId' | 'bat
 // A change: a row to put in (insert or replace), or a key to take out. A row is taken out when it
 // is deleted, and also when it leaves what the device keeps: an archived product, a customer that
 // is now only a supplier, a warehouse moved to another branch, a stock row at zero, a register
-// archived or moved to another branch with its warehouse.
+// archived or moved to another branch with its warehouse, an archived reason.
 
 function upsertOf<const E extends SyncEntity, S extends z.ZodType>(entity: E, data: S) {
   return z.object({
@@ -178,6 +193,7 @@ export const syncUpsertSchema = z.discriminatedUnion('entity', [
   upsertOf('tax_rate', taxRateSchema),
   upsertOf('warehouse', warehouseSchema),
   upsertOf('pos_register', syncPosRegisterSchema),
+  upsertOf('pos_cash_reason', syncPosCashReasonSchema),
   upsertOf('price_list', syncPriceListSchema),
   upsertOf('customer_group', syncCustomerGroupSchema),
   upsertOf('product', productSchema),
@@ -330,6 +346,9 @@ export const SYNC_COMMAND_TYPES = [
   'customer.update',
   'sales_order.create_draft',
   'pos_sale.create',
+  'pos_shift.open',
+  'pos_cash_movement.create',
+  'pos_shift.close',
 ] as const;
 export type SyncCommandType = (typeof SYNC_COMMAND_TYPES)[number];
 
@@ -372,11 +391,42 @@ export const posSaleCommandSchema = z.object({
   input: posSaleInputSchema,
 });
 
+// Step 20b: a shift's three commands (pos-shifts.ts). Like a sale, each is done already when it
+// arrives (the drawer was counted, the money moved), so the server posts it and never refuses it
+// for money or for permission. The device sends them in the order they happened: a sale and a
+// movement wait for their shift's open, and the close waits for every sale and movement of the
+// shift, so the server works out the expected cash from all of them.
+export const posShiftOpenCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('pos_shift.open'),
+  // The shift's id, made on the device: its sales and movements point at it before the server
+  // has seen it
+  shiftId: z.uuidv7(),
+  input: posShiftOpenInputSchema,
+});
+
+export const posCashMovementCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('pos_cash_movement.create'),
+  movementId: z.uuidv7(),
+  input: posCashMovementInputSchema,
+});
+
+export const posShiftCloseCommandSchema = z.object({
+  id: z.uuidv7(),
+  type: z.literal('pos_shift.close'),
+  shiftId: z.uuid(),
+  input: posShiftCloseInputSchema,
+});
+
 export const syncCommandSchema = z.discriminatedUnion('type', [
   customerCreateCommandSchema,
   customerUpdateCommandSchema,
   salesOrderDraftCommandSchema,
   posSaleCommandSchema,
+  posShiftOpenCommandSchema,
+  posCashMovementCommandSchema,
+  posShiftCloseCommandSchema,
 ]);
 export type SyncCommand = z.infer<typeof syncCommandSchema>;
 export type SyncCommandInput = z.input<typeof syncCommandSchema>;
@@ -425,9 +475,10 @@ export const syncResultSchema = z.discriminatedUnion('status', [
     status: z.literal('accepted'),
     notices: z.array(syncNoticeSchema),
     // The rows the command changed, as they are now, for the device to write at once instead of
-    // waiting for its next pull: the customer for a customer command, nothing for an order or a POS
-    // sale (neither is on the device; the stock a sale took comes with the next pull). Read when the answer is made, also for a command sent again, so an
-    // old answer never puts an older row back on the device.
+    // waiting for its next pull: the customer for a customer command; nothing for an order, a POS
+    // sale or a shift's command (none of them is on the device as a row; the stock a sale took and
+    // the register's latest shift come with the next pull). Read when the answer is made, also for
+    // a command sent again, so an old answer never puts an older row back on the device.
     changes: z.array(syncChangeSchema),
   }),
   z.object({
@@ -527,9 +578,10 @@ export const syncRoutes = {
     response: syncPullSchema,
   }),
   // No permission for the route: each command needs the permission its API route needs
-  // (sales.customer.manage, sales.order.manage; pos.sale.create for a POS sale), checked per
-  // command with the roles of now. A person whose role lost it since gets that command refused
-  // with permission_missing.
+  // (sales.customer.manage, sales.order.manage), checked per command with the roles of now. A
+  // person whose role lost it since gets that command refused with permission_missing. The POS
+  // commands (a sale, a shift's open, movement and close) need pos.sale.create too, but are never
+  // refused for it: the money is in the drawer already, so the audit log says so instead.
   push: defineRoute({
     method: 'POST',
     path: '/sync/push',
```

- **`SYNC_PROTOCOL` is 3** (decision 30), with its line in the comment's list.
- **`pos_cash_reason` sits after `pos_register` in `SYNC_ENTITIES`.** It points at nothing the device keeps (its account
  is not on the device), so its place only keeps the POS entities together.
- **The open and the movement get ids made on the device** (`z.uuidv7()`), like a sale: the sales point at the shift,
  and the shift's page lists the movements, before the server has seen either.
- **The close names its shift with a plain `z.uuid()`:** the shift already exists, and its id was checked when it opened.

```diff
@@ -5,6 +5,7 @@ import {
   customerUpdateCommandSchema,
   deviceKeySchema,
   posSaleCommandSchema,
+  posShiftOpenCommandSchema,
   priceListItemKey,
   registerDeviceInputSchema,
   salesOrderDraftCommandSchema,
@@ -432,8 +433,12 @@ describe('POS on the device', () => {
     maxDiscountPercent: '10.00',
     paperWidth: '58',
     receiptFooter: null,
+    overShortAccountId: RATE,
+    varianceAlert: '500',
+    lockAfter: '5',
     deviceId: COMMAND,
     lastNumber: 122,
+    lastShift: { id: CUSTOMER, sequence: 41, status: 'closed', cashLeft: '5000.0000' },
     archivedAt: null,
     version: 4,
     updatedAt: AT,
@@ -448,6 +453,77 @@ describe('POS on the device', () => {
     });
     expect(change.entity === 'pos_register' && change.data.code).toBe('POS1');
     expect(change.data).not.toHaveProperty('lastNumber');
+    expect(change.entity === 'pos_register' && change.data.lastShift?.sequence).toBe(41);
+  });
+
+  it('keeps the pay in and pay out reasons', () => {
+    const reason = {
+      id: ADDRESS,
+      name: 'Bank deposit',
+      direction: 'out',
+      accountId: RATE,
+      archivedAt: null,
+      version: 1,
+      updatedAt: AT,
+    };
+    const change = syncUpsertSchema.parse({
+      op: 'upsert',
+      entity: 'pos_cash_reason',
+      key: ADDRESS,
+      data: reason,
+    });
+    expect(change.entity === 'pos_cash_reason' && change.data.direction).toBe('out');
+  });
+
+  it('opens a shift under an id the device made, so its sales can point at it', () => {
+    const command = {
+      id: COMMAND,
+      type: 'pos_shift.open',
+      shiftId: CUSTOMER,
+      input: {
+        registerId: ORDER,
+        sequence: 42,
+        date: '2026-10-28',
+        openedAt: AT,
+        opening: { notes: null, total: '5000' },
+        floatReasonId: '',
+      },
+    };
+    const parsed = syncCommandSchema.parse(command);
+    expect(parsed.type === 'pos_shift.open' && parsed.input.floatReasonId).toBeNull();
+    expect(errorsOf(posShiftOpenCommandSchema.safeParse({ ...command, shiftId: V4 }))).toEqual({
+      shiftId: 'Invalid UUID',
+    });
+  });
+
+  it('takes a movement and a close in the same union', () => {
+    const movement = {
+      id: COMMAND,
+      type: 'pos_cash_movement.create',
+      movementId: ADDRESS,
+      input: {
+        shiftId: CUSTOMER,
+        reasonId: RATE,
+        amount: '10000',
+        note: 'Deposit slip 0042',
+        date: '2026-10-28',
+        movedAt: AT,
+      },
+    };
+    const close = {
+      id: COMMAND,
+      type: 'pos_shift.close',
+      shiftId: CUSTOMER,
+      input: {
+        date: '2026-10-28',
+        closedAt: AT,
+        counted: { notes: null, total: '7640' },
+        deviceExpected: '8160.0000',
+        heldDropped: 1,
+      },
+    };
+    expect(syncCommandSchema.parse(movement).type).toBe('pos_cash_movement.create');
+    expect(syncCommandSchema.parse(close).type).toBe('pos_shift.close');
   });
 
   it('sends a sale under an id the device made, and refuses one of another kind', () => {
@@ -479,7 +555,10 @@ describe('POS on the device', () => {
       payments: [{ method: 'cash', amount: '120', reference: '' }],
     };
     const command = { id: COMMAND, type: 'pos_sale.create', saleId: CUSTOMER, input };
-    expect(syncCommandSchema.parse(command).type).toBe('pos_sale.create');
+    const parsed = syncCommandSchema.parse(command);
+    expect(parsed.type).toBe('pos_sale.create');
+    // A sale made before 20b, still in an outbox when the app was updated, has no shift
+    expect(parsed.type === 'pos_sale.create' && parsed.input.shiftId).toBeNull();
     expect(errorsOf(posSaleCommandSchema.safeParse({ ...command, saleId: V4 }))).toEqual({
       saleId: 'Invalid UUID',
     });
```

- **"Opens a shift under an id the device made"** also checks that a v4 id is refused, and that the empty float select
  becomes `null`.
- **The sale test now checks a sale without a shift** (decision 24).

### `permissions.ts`, `errors.ts`, `audit.ts`, `notifications.ts`

```diff
@@ -47,6 +47,7 @@ export const PERMISSION_KEYS = [
   'pos.sale.create',
   'pos.price.override',
   'pos.register.manage',
+  'pos.shift.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -116,4 +117,5 @@ export const PERMISSION_GROUP_OF = {
   'pos.sale.create': 'pos',
   'pos.price.override': 'pos',
   'pos.register.manage': 'pos',
+  'pos.shift.manage': 'pos',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

```diff
@@ -471,6 +471,9 @@ export const ERROR_CODES = [
   // Void refused while a supplier refund paid back some of the payment's advance
   'payment_has_refunds',
   'journal_is_purchase',
+  // Step 20b: a POS shift's entry (an opening or closing difference, a pay in or out) is put right
+  // by the next count or by a movement the other way, never by a reversal
+  'journal_is_pos',
   // Step 18a: devices and the sync. device_not_found also answers another person's device: the
   // app then registers this browser again.
   'device_id_invalid',
@@ -517,6 +520,33 @@ export const ERROR_CODES = [
   'pos_method_not_set',
   // Another sale of the register already has this number: a bug, never a cashier's mistake
   'pos_number_taken',
+  // Step 20b: shifts. The register's over/short account is not chosen, or is not an active income
+  // or expense account; the bell's limit is not whole taka
+  'pos_over_short_required',
+  'pos_over_short_invalid',
+  'pos_variance_alert_format',
+  // A pay in / pay out reason: no name, a name another reason has, an account it cannot use
+  'pos_reason_name_required',
+  'pos_reason_name_taken',
+  'pos_reason_account_invalid',
+  // The cashier's forms on the device: no reason picked, no amount, an empty count box, a total
+  // that is not what the notes add up to, a pay out of more than the drawer should hold, and a
+  // first shift's float with no reason
+  'pos_reason_required',
+  'pos_cash_amount_required',
+  'pos_count_required',
+  'pos_count_total_mismatch',
+  'pos_pay_out_too_large',
+  'pos_float_reason_required',
+  // The register's shift is still open: its device does not let go of it, does not move to
+  // another branch, and its person does not sign out, until it is closed
+  'pos_shift_still_open',
+  // A manager closes a shift that is closed already
+  'pos_shift_closed',
+  // Bugs, never a cashier's mistake: a shift opened while the server still has the register's
+  // last one open, and a sale, movement or close for a shift the server does not know
+  'pos_shift_already_open',
+  'pos_shift_unknown',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **The register's and the reason's codes** follow the shape of 20a's (`…_required`, `…_invalid`, `…_format`,
  `…_taken`).
- **`journal_is_pos`** sits with the other `journal_is_*` codes' family, after `journal_is_purchase`.

```diff
@@ -221,6 +221,21 @@ export const AUDIT_ACTIONS = [
   'pos_sale.created',
   'pos_sale.overridden',
   'pos_sale.without_permission',
+  // step 20b. A shift's rows name its device like a sale's. cash_moved: a pay in or pay out (the
+  // changes name the reason and the amount). closed_without_count: by a manager online, or by the
+  // revoke of its device. expected_differs: the device's expected cash at the close was not the
+  // server's (a sale or a movement missing on one side). without_permission: like a sale's, for
+  // any of the three commands.
+  'pos_cash_reason.created',
+  'pos_cash_reason.updated',
+  'pos_cash_reason.archived',
+  'pos_cash_reason.restored',
+  'pos_shift.opened',
+  'pos_shift.cash_moved',
+  'pos_shift.closed',
+  'pos_shift.closed_without_count',
+  'pos_shift.expected_differs',
+  'pos_shift.without_permission',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -275,6 +290,8 @@ export const AUDIT_ENTITY_TYPES = [
   'device',
   'pos_register',
   'pos_sale',
+  'pos_cash_reason',
+  'pos_shift',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- **A movement is an action on the shift** (`pos_shift.cash_moved`), not an entity of its own: the shift's history then
  reads in one place, from the open to the close.

```diff
@@ -18,6 +18,9 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // pos.sold_short: params { id, number, warehouse, count } — a POS sale (step 20a) took count
 // variants below zero in that warehouse; sent to the people who adjust stock, and the bell opens
 // the sale
+// pos.shift_variance: params { id, number, register, difference } — a shift's closing count was
+// more than its register's limit over or short (difference: counted less expected, signed); sent
+// to the owners and the people with pos.shift.manage, and the bell opens the shift
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -32,6 +35,7 @@ export const NOTIFICATION_TYPES = [
   'approval.approved',
   'approval.rejected',
   'pos.sold_short',
+  'pos.shift_variance',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

### `journal.ts`: the shift's entries

```diff
@@ -39,6 +39,9 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // pos_sale (step 20a): a POS sale books everything in one entry: Dr each payment's account, Cr Sales
 // and VAT payable, and Dr Cost of goods sold / Cr Inventory for its goods. It moves stock, so it is
 // a stock document's entry too: only a POS return (step 20c) undoes it.
+// pos_shift (step 20b): the cash of a shift. Its opening difference (or a first shift's float),
+// each pay in and pay out, and its closing difference, each an entry of its own, all pointing at
+// the shift.
 export const JOURNAL_SOURCES = [
   'manual',
   'opening_balance',
@@ -60,6 +63,7 @@ export const JOURNAL_SOURCES = [
   'purchase_debit_note',
   'purchase_refund',
   'pos_sale',
+  'pos_shift',
 ] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
@@ -114,12 +118,23 @@ export function isPurchaseJournalSource(value: string): value is PurchaseJournal
   return PURCHASE_JOURNAL_SOURCES.some((source) => source === value);
 }
 
+// The sources of a POS shift (step 20b). The journal's Reverse refuses them (journal_is_pos): the
+// cash was counted or moved, so a mistake is put right by the next count, or by a pay in or pay
+// out the other way.
+export const POS_JOURNAL_SOURCES = ['pos_shift'] as const satisfies readonly JournalSource[];
+export type PosJournalSource = (typeof POS_JOURNAL_SOURCES)[number];
+
+export function isPosJournalSource(value: string): value is PosJournalSource {
+  return POS_JOURNAL_SOURCES.some((source) => source === value);
+}
+
 // Every source whose entry points at the document that made it (journal_entries_document_check in
 // the database holds the same list)
 export const DOCUMENT_JOURNAL_SOURCES = [
   ...STOCK_JOURNAL_SOURCES,
   ...SALES_JOURNAL_SOURCES,
   ...PURCHASE_JOURNAL_SOURCES,
+  ...POS_JOURNAL_SOURCES,
 ] as const satisfies readonly JournalSource[];
 
 // '2026-07-01' and -1 → '2026-06-30'. The arithmetic runs in UTC, so no time zone can move the
```

- **`POS_JOURNAL_SOURCES` is a list of one,** like the other lists, so `DOCUMENT_JOURNAL_SOURCES` (and the database's
  `journal_entries_document_check`, 20b.2) take it the same way, and 20c can add to it.
- **`pos_shift` is not a stock source:** its entries touch only money accounts.

### `routes.ts`, `index.ts`

```diff
@@ -25,6 +25,7 @@ import { deviceRoutes } from './devices.js';
 import { documentOutputRoutes, publicDocumentRoutes } from './document-output.js';
 import { goodsReceiptRoutes } from './goods-receipts.js';
 import { posRoutes } from './pos.js';
+import { posShiftRoutes } from './pos-shifts.js';
 import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
@@ -137,4 +138,5 @@ export const routes = {
   sync: syncRoutes,
   devices: deviceRoutes,
   pos: posRoutes,
+  posShifts: posShiftRoutes,
 };
```

```diff
@@ -26,6 +26,7 @@ export * from './notifications.js';
 export * from './numbering.js';
 export * from './pagination.js';
 export * from './pos.js';
+export * from './pos-shifts.js';
 export * from './permissions.js';
 export * from './preferences.js';
 export * from './price-lists.js';
```

The OpenAPI document is generated from the built package (`@omnivo/contracts` points at `dist/`), so build it first:

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts gen:openapi
```

It adds the eight shift and reason routes, the register's new fields and the sync commands' new shapes to
`packages/contracts/openapi.json`. Commit it as it is. Without the build, the generator reads the old `dist/` and writes
the old document, and says it is valid.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
```

All pass (contracts 326 tests, 16 new). Do not run the whole `pnpm typecheck` yet. Until their parts, these fail, as
expected: `packages/db` (the permission catalog has no text for `pos.shift.manage`, 20b.2), `packages/i18n` (`en.ts`
misses the new error codes, 20b.5), `apps/api` (the register's new fields, the push's three commands and the pull's
`pos_cash_reason`, 20b.3), `packages/sync` (no table for `pos_cash_reason`, 20b.6) and `apps/app` (the new permission,
audit actions, bell, journal source and commands have no text yet, 20b.5 and 20b.6).

## 20b.2 — `packages/db`: shifts, reasons, pay ins and outs, and their rules

Three new tables and four new columns, all in `schema/pos.ts`. Migration 0053 is generated from the schema, with its
indexes moved up as in every step. Migration 0054 is written by hand: row-level security, the rules of a reason and of
a shift, the function that adds up a shift's cash, new versions of two 20a functions (the register's guard and the
release on a revoke), and the change log for the devices.

### `schema/pos.ts`: the register's settings, three new tables, the sale's shift

```diff
@@ -1,4 +1,12 @@
-import { DISCOUNT_TYPES, POS_PAPER_WIDTHS, POS_PAYMENT_METHODS } from '@omnivo/contracts';
+import {
+  type CashNotes,
+  DISCOUNT_TYPES,
+  POS_CASH_DIRECTIONS,
+  POS_LOCK_AFTER,
+  POS_PAPER_WIDTHS,
+  POS_PAYMENT_METHODS,
+  POS_SHIFT_STATUSES,
+} from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
 import {
   boolean,
@@ -7,6 +15,7 @@ import {
   foreignKey,
   index,
   integer,
+  jsonb,
   numeric,
   pgTable,
   primaryKey,
@@ -18,6 +27,7 @@ import {
 } from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
 import { batches } from './batches.js';
+import { journalEntries } from './journal.js';
 import { ledgerAccounts } from './ledger-accounts.js';
 import { parties } from './parties.js';
 import { productVariants } from './products.js';
@@ -26,12 +36,18 @@ import { devices } from './sync.js';
 import { taxRates } from './tax-rates.js';
 import { tenants } from './tenants.js';
 import { units } from './units.js';
+import { users } from './users.js';
 import { warehouses } from './warehouses.js';
 
 // Step 20a: the point of sale. A register is a counter; a POS sale is made on a device, already
 // paid, and arrives as a sync command (pos_sale.create). The server writes the sale, its lines,
 // the batches they left from and its payments in one go, and never changes them afterwards. The
 // rules live in migration 0052.
+//
+// Step 20b: shifts. A register sells inside a shift: one cashier on one device, from the count of
+// the drawer at the start to the count at the end, with money put in or taken out for a reason in
+// between. The shift's tables sit between the registers and the sales, because a sale points at
+// its shift. The rules live in migration 0054.
 
 // ---------------------------------------------------------------------------------------------
 // Registers
```

- **The imports bring the contract's lists** (`POS_LOCK_AFTER`, `POS_SHIFT_STATUSES`, `POS_CASH_DIRECTIONS`) for the
  columns' TypeScript types, and `CashNotes` for the two JSON columns. `users` is for `closed_by`, `journalEntries` for
  the entry columns.

```diff
@@ -63,6 +79,13 @@ export const posRegisters = pgTable(
       .default('0'),
     paperWidth: text('paper_width', { enum: POS_PAPER_WIDTHS }).notNull(),
     receiptFooter: text('receipt_footer'),
+    // Step 20b. Where a difference in a cash count goes ("Cash over/short"). NULL on a register made
+    // before 20b: the device opens no shift on it until someone picks one.
+    overShortAccountId: uuid('over_short_account_id'),
+    // A difference bigger than this, either way, rings a bell to the managers. Whole taka.
+    varianceAlert: numeric('variance_alert', { precision: 12, scale: 0 }).notNull().default('500'),
+    // Minutes of no key, click or touch before /pos locks the screen; 'off' = never
+    lockAfter: text('lock_after', { enum: POS_LOCK_AFTER }).notNull().default('5'),
     // The device that holds it (decision 14); NULL = free. Set by a claim, cleared by a release,
     // and by the database itself when that device is revoked or moved to another branch (0052).
     deviceId: uuid('device_id'),
@@ -117,11 +140,21 @@ export const posRegisters = pgTable(
       columns: [table.tenantId, table.nagadAccountId],
       foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
     }),
+    foreignKey({
+      name: 'pos_registers_over_short_account_fk',
+      columns: [table.tenantId, table.overShortAccountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
     // The contract's format: the code is split from the number at the hyphen
     check('pos_registers_code_check', sql`${table.code} ~ '^[A-Z][A-Z0-9]{1,7}$'`),
     check('pos_registers_discount_check', sql`${table.maxDiscountPercent} BETWEEN 0 AND 100`),
     check('pos_registers_paper_check', sql`${table.paperWidth} IN ('58', '80')`),
     check('pos_registers_last_number_check', sql`${table.lastNumber} >= 0`),
+    check('pos_registers_variance_alert_check', sql`${table.varianceAlert} >= 0`),
+    check(
+      'pos_registers_lock_after_check',
+      sql`${table.lockAfter} IN ('off', '2', '5', '10', '15')`,
+    ),
     // An archived register is held by no device: the last word on archiving a held one
     check(
       'pos_registers_archived_check',
```

**`pos_registers`:**

- **`over_short_account_id` is nullable** (decisions 13 and 42). A `NOT NULL` column would need a value for every 20a
  register, and the migration cannot know which account a workspace wants. The device reads `null` as "no shift yet".
- **`variance_alert` is `numeric(12, 0)`,** whole taka like the contract (decision 14). `numeric` comes back from the
  driver as a string, so the API sends `"500"` without turning it into a JavaScript number. The default fills the 20a
  registers.
- **`lock_after` is text with a check,** `'off'` or a number of minutes, like `paper_width`. The `{ enum }` only types
  the column in TypeScript; the check is what stops `'3'` in the database. The default `'5'` is decision 7's.
- **The over/short account has a real foreign key,** like the four payment accounts: an account a register uses cannot
  be deleted, and another workspace's account cannot be named.

```diff
@@ -130,6 +163,248 @@ export const posRegisters = pgTable(
   ],
 );
 
+// ---------------------------------------------------------------------------------------------
+// Pay in and pay out reasons (step 20b)
+
+// Why a cashier puts money into the drawer or takes it out, and the account on the other side of
+// the cash: "Bank deposit" (out, the bank account), "Float from safe" (in, the safe). Archived,
+// never deleted: movements point at them. Every device keeps the active ones (sync entity
+// pos_cash_reason, migration 0054).
+export const posCashReasons = pgTable(
+  'pos_cash_reasons',
+  {
+    ...baseColumns(),
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    name: text('name').notNull(),
+    // Never changes (0054): a pay in turned into a pay out would change every movement made with it
+    direction: text('direction', { enum: POS_CASH_DIRECTIONS }).notNull(),
+    // May change; a movement keeps the account it was posted to
+    accountId: uuid('account_id').notNull(),
+    archivedAt: timestamp('archived_at', { withTimezone: true }),
+  },
+  (table) => [
+    // The last word on pos_reason_name_taken, in any case. The archived ones count too, so
+    // restoring one never fails on its name.
+    uniqueIndex('pos_cash_reasons_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
+    // The target of the first shifts' FK
+    uniqueIndex('pos_cash_reasons_tenant_id_idx').on(table.tenantId, table.id),
+    // The target of the movements' FK, which carries the direction: a movement's direction is
+    // always its reason's
+    uniqueIndex('pos_cash_reasons_direction_idx').on(table.tenantId, table.id, table.direction),
+    // No index for the account FK: a workspace has a handful of reasons
+    foreignKey({
+      name: 'pos_cash_reasons_account_fk',
+      columns: [table.tenantId, table.accountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
+    check('pos_cash_reasons_direction_check', sql`${table.direction} IN ('in', 'out')`),
+  ],
+);
+
+// ---------------------------------------------------------------------------------------------
+// Shifts (step 20b)
+
+// One cashier on one device at one register. The id is made by the device (the command's
+// shiftId), so its sales and movements point at it before the server has seen it. created_by is
+// the cashier, like a sale's.
+// The row is written by pos_shift.open with the opening columns, and changed once: by the close
+// (pos_shift.close), or by a close without a count (a revoke of its device, or a manager online).
+// After that it never changes (0054).
+export const posShifts = pgTable(
+  'pos_shifts',
+  {
+    ...baseColumns(),
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    registerId: uuid('register_id').notNull(),
+    deviceId: uuid('device_id').notNull(),
+    // Its place in the register's series of shifts, and the number it makes (formatShiftNumber):
+    // the journal entries show the number
+    sequence: integer('sequence').notNull(),
+    number: text('number').notNull(),
+    status: text('status', { enum: POS_SHIFT_STATUSES }).notNull().default('open'),
+
+    // The open. opened_at is by the device's clock; opening_date is the day its entry is in the
+    // books (the device's day, or the first open day after it).
+    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
+    openingDate: date('opening_date', { mode: 'string' }).notNull(),
+    // The count: the notes counted, or NULL when it was typed as a total; and its total
+    openingNotes: jsonb('opening_notes').$type<CashNotes>(),
+    openingCash: numeric('opening_cash', { precision: 19, scale: 4 }).notNull(),
+    // What the last shift left in the drawer (its count, or what the server expected when it was
+    // closed without a count). NULL = the register's first shift, with nothing to compare with.
+    openingComparedWith: numeric('opening_compared_with', { precision: 19, scale: 4 }),
+    // A first shift's float: the "in" reason it came by (decision 12)
+    floatReasonId: uuid('float_reason_id'),
+    // The opening difference (or the float) in the books; NULL when there was none
+    openingEntryId: uuid('opening_entry_id'),
+
+    // The close. All NULL while the shift is open.
+    closedAt: timestamp('closed_at', { withTimezone: true }),
+    // A close with a count: the day of its entry, the count, what the device expected and how
+    // many held carts it dropped
+    closingDate: date('closing_date', { mode: 'string' }),
+    closingNotes: jsonb('closing_notes').$type<CashNotes>(),
+    countedCash: numeric('counted_cash', { precision: 19, scale: 4 }),
+    deviceExpected: numeric('device_expected', { precision: 19, scale: 4 }),
+    heldDropped: smallint('held_dropped'),
+    // What the drawer should have held, worked out by the server when the shift closed, with or
+    // without a count (pos_shift_cash() in 0054). The books use this number, not the device's.
+    expectedCash: numeric('expected_cash', { precision: 19, scale: 4 }),
+    // The closing difference in the books; NULL when the count matched
+    closingEntryId: uuid('closing_entry_id'),
+    // Who closed it without a count: a manager, or the person who revoked its device
+    closedBy: uuid('closed_by').references(() => users.id),
+  },
+  (table) => [
+    // The target of the movements' FK
+    uniqueIndex('pos_shifts_tenant_id_idx').on(table.tenantId, table.id),
+    // The target of the sales' FK, which carries the register and the device: a shift's sale is
+    // from its own register and device
+    uniqueIndex('pos_shifts_sale_key_idx').on(
+      table.tenantId,
+      table.id,
+      table.registerId,
+      table.deviceId,
+    ),
+    // A register gives a shift number once; also the register's latest shift (its lastShift)
+    uniqueIndex('pos_shifts_register_sequence_idx').on(
+      table.tenantId,
+      table.registerId,
+      table.sequence,
+    ),
+    uniqueIndex('pos_shifts_tenant_number_idx').on(table.tenantId, table.number),
+    // One open shift per register (decision 1): the last word on pos_shift_already_open
+    uniqueIndex('pos_shifts_register_open_idx')
+      .on(table.tenantId, table.registerId)
+      .where(sql`${table.status} = 'open'`),
+    // A device has one open shift at most: what a revoke closes, and what sign-out looks for
+    uniqueIndex('pos_shifts_device_open_idx')
+      .on(table.tenantId, table.deviceId)
+      .where(sql`${table.status} = 'open'`),
+    // The list: newest first, keyset on (opened_at, id); and the same for one register
+    index('pos_shifts_tenant_opened_idx').on(table.tenantId, table.openedAt, table.id),
+    index('pos_shifts_register_opened_idx').on(
+      table.tenantId,
+      table.registerId,
+      table.openedAt,
+      table.id,
+    ),
+    foreignKey({
+      name: 'pos_shifts_register_fk',
+      columns: [table.tenantId, table.registerId],
+      foreignColumns: [posRegisters.tenantId, posRegisters.id],
+    }),
+    // Devices are revoked, never deleted
+    foreignKey({
+      name: 'pos_shifts_device_fk',
+      columns: [table.tenantId, table.deviceId],
+      foreignColumns: [devices.tenantId, devices.id],
+    }),
+    // Reasons are archived, never deleted
+    foreignKey({
+      name: 'pos_shifts_float_reason_fk',
+      columns: [table.tenantId, table.floatReasonId],
+      foreignColumns: [posCashReasons.tenantId, posCashReasons.id],
+    }),
+    // A posted entry is never deleted, so these two need no index: deleting a draft entry reads
+    // the few shifts of a workspace
+    foreignKey({
+      name: 'pos_shifts_opening_entry_fk',
+      columns: [table.tenantId, table.openingEntryId],
+      foreignColumns: [journalEntries.tenantId, journalEntries.id],
+    }),
+    foreignKey({
+      name: 'pos_shifts_closing_entry_fk',
+      columns: [table.tenantId, table.closingEntryId],
+      foreignColumns: [journalEntries.tenantId, journalEntries.id],
+    }),
+    check('pos_shifts_sequence_check', sql`${table.sequence} >= 1`),
+    // Each status has its own columns: open has no close; a close with a count has the count and
+    // the device's numbers; a close without a count has only when, who and the expected cash
+    check(
+      'pos_shifts_status_check',
+      sql`(${table.status} = 'open' AND ${table.closedAt} IS NULL AND ${table.closingDate} IS NULL AND ${table.closingNotes} IS NULL AND ${table.countedCash} IS NULL AND ${table.deviceExpected} IS NULL AND ${table.heldDropped} IS NULL AND ${table.expectedCash} IS NULL AND ${table.closingEntryId} IS NULL AND ${table.closedBy} IS NULL)
+      OR (${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL AND ${table.closingDate} IS NOT NULL AND ${table.countedCash} IS NOT NULL AND ${table.deviceExpected} IS NOT NULL AND ${table.heldDropped} IS NOT NULL AND ${table.expectedCash} IS NOT NULL AND ${table.closedBy} IS NULL)
+      OR (${table.status} = 'closed_without_count' AND ${table.closedAt} IS NOT NULL AND ${table.closingDate} IS NULL AND ${table.closingNotes} IS NULL AND ${table.countedCash} IS NULL AND ${table.deviceExpected} IS NULL AND ${table.heldDropped} IS NULL AND ${table.expectedCash} IS NOT NULL AND ${table.closingEntryId} IS NULL AND ${table.closedBy} IS NOT NULL)`,
+    ),
+    // A drawer holds 0 or more; the expected cash may be below zero through a bug or a sale that
+    // came after a close without a count, so it has no check
+    check(
+      'pos_shifts_cash_check',
+      sql`${table.openingCash} >= 0 AND ${table.countedCash} >= 0 AND ${table.heldDropped} BETWEEN 0 AND 20`,
+    ),
+    // Notes are an object of counts; the API checks the keys and that they add up (cashCountSchema)
+    check(
+      'pos_shifts_notes_check',
+      sql`jsonb_typeof(${table.openingNotes}) = 'object' AND jsonb_typeof(${table.closingNotes}) = 'object'`,
+    ),
+    // Only a first shift brings a float in
+    check(
+      'pos_shifts_float_check',
+      sql`${table.floatReasonId} IS NULL OR ${table.openingComparedWith} IS NULL`,
+    ),
+  ],
+);
+
+// Money put into the drawer or taken out during a shift. The id is made by the device (the
+// command's movementId). Posted when it arrives, with an entry of its own, and never changed
+// (0054); a mistake is put right by a movement the other way. created_by is the cashier.
+export const posCashMovements = pgTable(
+  'pos_cash_movements',
+  {
+    ...baseColumns(),
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    shiftId: uuid('shift_id').notNull(),
+    reasonId: uuid('reason_id').notNull(),
+    // The reason's direction, kept here so the shift's cash is added up without the reasons; the
+    // FK makes sure it is the reason's
+    direction: text('direction', { enum: POS_CASH_DIRECTIONS }).notNull(),
+    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
+    note: text('note'),
+    // The day in the books, and when it happened by the device's clock
+    date: date('date', { mode: 'string' }).notNull(),
+    movedAt: timestamp('moved_at', { withTimezone: true }).notNull(),
+    // The reason's account when it was posted: a later change of the reason moves no old money
+    accountId: uuid('account_id').notNull(),
+    entryId: uuid('entry_id').notNull(),
+  },
+  (table) => [
+    // The shift's movements: its page, and its expected cash
+    index('pos_cash_movements_shift_idx').on(table.tenantId, table.shiftId),
+    // One entry per movement; also the entry FK's check when a draft entry is deleted
+    uniqueIndex('pos_cash_movements_entry_idx').on(table.tenantId, table.entryId),
+    // The account FK's check when an account is deleted: a few rows a day per register add up
+    index('pos_cash_movements_account_idx').on(table.tenantId, table.accountId),
+    foreignKey({
+      name: 'pos_cash_movements_shift_fk',
+      columns: [table.tenantId, table.shiftId],
+      foreignColumns: [posShifts.tenantId, posShifts.id],
+    }),
+    foreignKey({
+      name: 'pos_cash_movements_reason_fk',
+      columns: [table.tenantId, table.reasonId, table.direction],
+      foreignColumns: [posCashReasons.tenantId, posCashReasons.id, posCashReasons.direction],
+    }),
+    foreignKey({
+      name: 'pos_cash_movements_account_fk',
+      columns: [table.tenantId, table.accountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
+    foreignKey({
+      name: 'pos_cash_movements_entry_fk',
+      columns: [table.tenantId, table.entryId],
+      foreignColumns: [journalEntries.tenantId, journalEntries.id],
+    }),
+    check('pos_cash_movements_amount_check', sql`${table.amount} > 0`),
+  ],
+);
+
 // ---------------------------------------------------------------------------------------------
 // Sales
 
```

**`pos_cash_reasons`:**

- **`pos_cash_reasons_tenant_name_idx` is on `lower(name)`** (decision 41): "Bank deposit" and "BANK deposit" are one
  reason to a cashier picking from a list. It includes the archived ones, so restoring a reason never fails on its name.
- **Two unique indexes on the id.** `(tenant_id, id)` is what a first shift's float reason points at;
  `(tenant_id, id, direction)` is what a movement points at, so the movement's copy of the direction must be the
  reason's (decision 40). Postgres needs a unique index that matches a foreign key's columns exactly.
- **`direction` has a check** like every text list here; 0054 keeps it from changing.
- **No index for the account's foreign key:** a workspace has a handful of reasons, so the check when an account is
  deleted reads a handful of rows.

**`pos_shifts`:**

- **The id comes from the device** (the command's `shiftId`, 20b.1). `baseColumns()` makes a UUIDv7 only when none is
  passed. The device's sales and movements point at this id before the server has seen the shift.
- **`created_by` is the cashier,** as on a sale: the person whose device pushed the open. One shift is one person
  (decision 1), so there is no `cashier_id`.
- **`sequence` and `number` are both stored,** like a sale's: `sequence` is what the uniqueness is about, `number`
  (`POS1-S0042`) is what the journal shows as the entries' `document_number`.
- **The opening columns are written once, by the open.** `opening_compared_with` is what the last shift left (decision
  17); `NULL` marks a register's first shift, the only one that may have a `float_reason_id` (decision 12,
  `pos_shifts_float_check`).
- **The closing columns are `NULL` until the close.** `expected_cash` is the server's number (decision 22), stored at the
  close, with or without a count, so the shift list and the next shift's opening read it without adding up the sales
  again. `device_expected` is the device's, kept only to compare.
- **`pos_shifts_status_check` says which columns each status has.** Open has no close at all. A close with a count has
  the count, the day, the device's numbers and the expected cash, and no `closed_by`. A close without a count has only
  when, who and the expected cash. So no code path can write half a close, or a count on a shift nobody counted.
- **The entry columns** (decision 34) are nullable: an opening that matched the last close posts nothing, and neither
  does a close that matched. No index on them: a posted entry is never deleted, and deleting a draft entry (the only
  delete there is) reads the few shifts of a workspace.
- **Two notes columns are `jsonb`,** typed with the contract's `CashNotes`. `pos_shifts_notes_check` only asks for an
  object (decision 43): the keys and the limits are the contract's. `jsonb_typeof(NULL)` is `NULL`, and a check that is
  `NULL` passes, so a count typed as a total (`NULL` notes) passes too.
- **`pos_shifts_cash_check` keeps the counts at 0 or more** and the dropped carts between 0 and 20. There is no check on
  `expected_cash`: a sale that arrives after a manager closed the shift can leave the next numbers odd, and the server
  must never refuse a sale.
- **The indexes:** `pos_shifts_sale_key_idx` is what a sale's foreign key points at (decision 39).
  `pos_shifts_register_sequence_idx` gives a number once and finds a register's latest shift.
  `pos_shifts_register_open_idx` is partial (`WHERE status = 'open'`): one open shift per register, the last word on
  `pos_shift_already_open`, while closed shifts may be many. `pos_shifts_device_open_idx` is the same per device: what a
  revoke closes and what sign-out (20b.3) looks for. The two `opened` indexes are the managers' list, newest first,
  keyset on (opened_at, id), for all registers or one.

**`pos_cash_movements`:**

- **The id comes from the device** (`movementId`), and `created_by` is the cashier.
- **`direction` is a copy of the reason's** (decision 40). With it on the row, the shift's cash adds up pay ins and pay
  outs without reading the reasons; the foreign key on `(tenant_id, reason_id, direction)` makes sure the copy is right.
- **`account_id` is a copy of the reason's account when it was posted,** like a sale payment's: changing a reason's
  account later moves no old money.
- **`entry_id` is `NOT NULL`:** a movement is always above zero (`pos_cash_movements_amount_check`), so it always posts.
  `pos_cash_movements_entry_idx` is unique: one entry per movement. It is also the index the entry's foreign key needs.
- **`pos_cash_movements_account_idx`:** a few movements a day per register add up over the years; without it, deleting
  any unused account would read them all.

```diff
@@ -147,6 +422,9 @@ export const posSales = pgTable(
       .notNull()
       .references(() => tenants.id),
     registerId: uuid('register_id').notNull(),
+    // Step 20b: the shift it was sold in. NULL for a sale from before 20b (and one still in an
+    // outbox when the app was updated).
+    shiftId: uuid('shift_id'),
     // Its place in the register's series, and the number it makes (formatPosNumber): stored, so
     // the list, the journal and the stock card show it without the register's code
     sequence: integer('sequence').notNull(),
@@ -194,6 +472,16 @@ export const posSales = pgTable(
       columns: [table.tenantId, table.registerId],
       foreignColumns: [posRegisters.tenantId, posRegisters.id],
     }),
+    // A shift's sales: its page, its totals and its expected cash. Partial: 20a's sales have none.
+    index('pos_sales_shift_idx')
+      .on(table.tenantId, table.shiftId)
+      .where(sql`${table.shiftId} IS NOT NULL`),
+    // The shift is of this sale's register and device. A NULL shift skips the check (MATCH SIMPLE).
+    foreignKey({
+      name: 'pos_sales_shift_fk',
+      columns: [table.tenantId, table.shiftId, table.registerId, table.deviceId],
+      foreignColumns: [posShifts.tenantId, posShifts.id, posShifts.registerId, posShifts.deviceId],
+    }),
     // No ON DELETE: a customer with a sale cannot be deleted (customer_in_use)
     foreignKey({
       name: 'pos_sales_customer_fk',
```

**`pos_sales`:**

- **`shift_id` is nullable** (decision 24): 20a's sales have none, and nor does a sale that was still in an outbox when
  the app was updated.
- **`pos_sales_shift_fk` carries the register and the device** (decision 39). A sale of shift 42 must be from the
  shift's own register and device; a bug that mixed them up fails here. With a `NULL` shift, Postgres skips the whole
  check (`MATCH SIMPLE`, the default), so old sales still go in.
- **`pos_sales_shift_idx` is partial:** the shift's page, its sales total and its expected cash read the sales by shift,
  and the older sales without one never need the index.

### `schema/journal.ts`: the entry may point at a shift

```diff
@@ -79,12 +79,12 @@ export const journalEntries = pgTable(
     // A document's entry (a stock document's, a delivery's since step 15b, an invoice's and a
     // receipt's since 15c, a sales return's, a credit note's and a refund's since 15d, a goods
     // receipt's since 17b, a bill's and a supplier payment's since 17c, a purchase return's, a
-    // debit note's and a supplier refund's since 17d, a POS sale's since 20a) always points at its
-    // document, and no other entry does. The list is
+    // debit note's and a supplier refund's since 17d, a POS sale's since 20a, a POS shift's since
+    // 20b) always points at its document, and no other entry does. The list is
     // contracts' DOCUMENT_JOURNAL_SOURCES.
     check(
       'journal_entries_document_check',
-      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
     ),
     // A document's entries (a transfer has up to two; an invoice or a receipt has one, which the
     // invoice page and the receipt page find here)
```

- **`pos_shift` joins the sources whose entry points at a document** (decision 28). The check is the contract's
  `DOCUMENT_JOURNAL_SOURCES` written out, because a check cannot import TypeScript. Without it, a shift's entry would be
  refused for having a `document_id`.

### `permission-catalog.ts`

```diff
@@ -53,11 +53,13 @@ const DESCRIPTIONS = {
   'purchase.return.manage': 'Write and post purchase returns, which send stock back to suppliers',
   'purchase.debit_note.manage': 'Write and post debit notes, and apply their money to bills',
   'purchase.refund.manage': 'Record money suppliers paid back, and void supplier refunds',
-  'pos.sale.create': 'Sell at a POS register, and take a free register for this device',
+  'pos.sale.create':
+    'Sell at a POS register, take a free register for this device, and run its shifts',
   'pos.price.override':
     "Change a price at the POS, or give more discount than the register's limit",
-  'pos.register.manage':
-    'Add, edit and archive POS registers, with their warehouse, accounts and receipt',
+  'pos.register.manage': 'Add, edit and archive POS registers and the pay in and pay out reasons',
+  'pos.shift.manage':
+    "See every register's shifts and cash differences, and close a stuck shift without a count",
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- **`pos.shift.manage` gets its description.** The `satisfies Record<PermissionKey, string>` has failed the db type check
  since 20b.1 until it was there.
- **Two descriptions change** to say what the permissions now cover (decision 10): the cashier's runs the shift, and the
  register manager's sets up the reasons. `pnpm db:migrate` writes them (`syncPermissions()` updates the description of
  a key that exists), so no migration is needed.

### Migration 0053 (generated, then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name pos-shifts`. As in every step, `drizzle-kit` writes the foreign keys
before the unique indexes they point at (`pos_cash_reasons_tenant_id_idx`, `pos_cash_reasons_direction_idx`,
`pos_shifts_tenant_id_idx`, `pos_shifts_sale_key_idx`), and the migration fails with "there is no unique constraint
matching given keys". Move every `CREATE INDEX` and `CREATE UNIQUE INDEX` up, before the first
`ADD CONSTRAINT … FOREIGN KEY`. The result:

```sql
CREATE TABLE "pos_cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"reason_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"note" text,
	"date" date NOT NULL,
	"moved_at" timestamp with time zone NOT NULL,
	"account_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	CONSTRAINT "pos_cash_movements_amount_check" CHECK ("pos_cash_movements"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_cash_reasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"direction" text NOT NULL,
	"account_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pos_cash_reasons_direction_check" CHECK ("pos_cash_reasons"."direction" IN ('in', 'out'))
);
--> statement-breakpoint
CREATE TABLE "pos_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_date" date NOT NULL,
	"opening_notes" jsonb,
	"opening_cash" numeric(19, 4) NOT NULL,
	"opening_compared_with" numeric(19, 4),
	"float_reason_id" uuid,
	"opening_entry_id" uuid,
	"closed_at" timestamp with time zone,
	"closing_date" date,
	"closing_notes" jsonb,
	"counted_cash" numeric(19, 4),
	"device_expected" numeric(19, 4),
	"held_dropped" smallint,
	"expected_cash" numeric(19, 4),
	"closing_entry_id" uuid,
	"closed_by" uuid,
	CONSTRAINT "pos_shifts_sequence_check" CHECK ("pos_shifts"."sequence" >= 1),
	CONSTRAINT "pos_shifts_status_check" CHECK (("pos_shifts"."status" = 'open' AND "pos_shifts"."closed_at" IS NULL AND "pos_shifts"."closing_date" IS NULL AND "pos_shifts"."closing_notes" IS NULL AND "pos_shifts"."counted_cash" IS NULL AND "pos_shifts"."device_expected" IS NULL AND "pos_shifts"."held_dropped" IS NULL AND "pos_shifts"."expected_cash" IS NULL AND "pos_shifts"."closing_entry_id" IS NULL AND "pos_shifts"."closed_by" IS NULL)
      OR ("pos_shifts"."status" = 'closed' AND "pos_shifts"."closed_at" IS NOT NULL AND "pos_shifts"."closing_date" IS NOT NULL AND "pos_shifts"."counted_cash" IS NOT NULL AND "pos_shifts"."device_expected" IS NOT NULL AND "pos_shifts"."held_dropped" IS NOT NULL AND "pos_shifts"."expected_cash" IS NOT NULL AND "pos_shifts"."closed_by" IS NULL)
      OR ("pos_shifts"."status" = 'closed_without_count' AND "pos_shifts"."closed_at" IS NOT NULL AND "pos_shifts"."closing_date" IS NULL AND "pos_shifts"."closing_notes" IS NULL AND "pos_shifts"."counted_cash" IS NULL AND "pos_shifts"."device_expected" IS NULL AND "pos_shifts"."held_dropped" IS NULL AND "pos_shifts"."expected_cash" IS NOT NULL AND "pos_shifts"."closing_entry_id" IS NULL AND "pos_shifts"."closed_by" IS NOT NULL)),
	CONSTRAINT "pos_shifts_cash_check" CHECK ("pos_shifts"."opening_cash" >= 0 AND "pos_shifts"."counted_cash" >= 0 AND "pos_shifts"."held_dropped" BETWEEN 0 AND 20),
	CONSTRAINT "pos_shifts_notes_check" CHECK (jsonb_typeof("pos_shifts"."opening_notes") = 'object' AND jsonb_typeof("pos_shifts"."closing_notes") = 'object'),
	CONSTRAINT "pos_shifts_float_check" CHECK ("pos_shifts"."float_reason_id" IS NULL OR "pos_shifts"."opening_compared_with" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "over_short_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "variance_alert" numeric(12, 0) DEFAULT '500' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "lock_after" text DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
CREATE INDEX "pos_cash_movements_shift_idx" ON "pos_cash_movements" USING btree ("tenant_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_movements_entry_idx" ON "pos_cash_movements" USING btree ("tenant_id","entry_id");--> statement-breakpoint
CREATE INDEX "pos_cash_movements_account_idx" ON "pos_cash_movements" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_reasons_tenant_name_idx" ON "pos_cash_reasons" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_reasons_tenant_id_idx" ON "pos_cash_reasons" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_reasons_direction_idx" ON "pos_cash_reasons" USING btree ("tenant_id","id","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_tenant_id_idx" ON "pos_shifts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_sale_key_idx" ON "pos_shifts" USING btree ("tenant_id","id","register_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_register_sequence_idx" ON "pos_shifts" USING btree ("tenant_id","register_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_tenant_number_idx" ON "pos_shifts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_register_open_idx" ON "pos_shifts" USING btree ("tenant_id","register_id") WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_device_open_idx" ON "pos_shifts" USING btree ("tenant_id","device_id") WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "pos_shifts_tenant_opened_idx" ON "pos_shifts" USING btree ("tenant_id","opened_at","id");--> statement-breakpoint
CREATE INDEX "pos_shifts_register_opened_idx" ON "pos_shifts" USING btree ("tenant_id","register_id","opened_at","id");--> statement-breakpoint
CREATE INDEX "pos_sales_shift_idx" ON "pos_sales" USING btree ("tenant_id","shift_id") WHERE "pos_sales"."shift_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_reason_fk" FOREIGN KEY ("tenant_id","reason_id","direction") REFERENCES "public"."pos_cash_reasons"("tenant_id","id","direction") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_reasons" ADD CONSTRAINT "pos_cash_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_reasons" ADD CONSTRAINT "pos_cash_reasons_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."pos_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_float_reason_fk" FOREIGN KEY ("tenant_id","float_reason_id") REFERENCES "public"."pos_cash_reasons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_opening_entry_fk" FOREIGN KEY ("tenant_id","opening_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closing_entry_fk" FOREIGN KEY ("tenant_id","closing_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_over_short_account_fk" FOREIGN KEY ("tenant_id","over_short_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_shift_fk" FOREIGN KEY ("tenant_id","shift_id","register_id","device_id") REFERENCES "public"."pos_shifts"("tenant_id","id","register_id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_variance_alert_check" CHECK ("pos_registers"."variance_alert" >= 0);--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_lock_after_check" CHECK ("pos_registers"."lock_after" IN ('off', '2', '5', '10', '15'));
```

- **Three new tables:** creating them takes no time and locks nothing that exists.
- **The three register columns have defaults,** so adding them to a table with rows is quick: Postgres 11 and later
  store a constant default once instead of writing every row.
- **`pos_sales_shift_idx` is built on a table that has rows.** `CREATE INDEX` stops writes to `pos_sales` while it runs.
  A shop's POS sales from step 20a are few, so it takes moments; run the migration outside shop hours anyway.
- **The journal check is dropped and added again,** like in 20a: adding it reads every journal entry once, while it
  stops writes to `journal_entries`.
- `meta/_journal.json`, `meta/0053_snapshot.json` and `meta/0054_snapshot.json` change too. They are generated; commit
  them as they are.

### Migration 0054 (custom): the rules

Run `pnpm --filter @omnivo/db generate --custom --name pos-shifts-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The three new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['pos_cash_reasons', 'pos_shifts', 'pos_cash_movements'])
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

-- 2) A reason is archived, never deleted: movements and first shifts point at it. Its direction
--    never changes (decision 20): every movement made with it was posted that way.
REVOKE DELETE ON pos_cash_reasons FROM omnivo_app;

CREATE FUNCTION pos_cash_reasons_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction <> OLD.direction THEN
    RAISE EXCEPTION 'the direction of pay in / pay out reason % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_cash_reasons_direction_locked';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pos_cash_reasons_guard
  BEFORE UPDATE ON pos_cash_reasons
  FOR EACH ROW EXECUTE FUNCTION pos_cash_reasons_guard();

-- 3) The cash of a shift: the opening count, the cash its sales took and the change they gave,
--    its pay ins and pay outs, and what the drawer should hold (the contract's expectedCashOf()).
--    The server's one place for this sum: a close (with or without a count) stores its expected
--    cash, and the shift's page shows the parts. Change is always given in cash (0052 lets no
--    other method pay more than the total), so it is what was paid less the total. No row = no
--    such shift.
CREATE FUNCTION pos_shift_cash(p_tenant uuid, p_shift uuid)
RETURNS TABLE (
  opening numeric,
  cash_taken numeric,
  change_given numeric,
  paid_in numeric,
  paid_out numeric,
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
  )
  SELECT s.opening_cash, sales.cash_taken, sales.change_given, moves.paid_in, moves.paid_out,
         s.opening_cash + sales.cash_taken + moves.paid_in - sales.change_given - moves.paid_out
    FROM pos_shifts s, sales, moves
   WHERE s.tenant_id = p_tenant AND s.id = p_shift
$$;

-- 4) The rules of a shift:
--    - it opens on a register its own device holds. The device and then the register are read FOR
--      SHARE: a release or a revoke running at the same moment finishes first and this check sees
--      it, or waits for this shift and then sees it open (sections 5 and 6). Without the locks a
--      shift could open on a register nobody holds, or a revoke could fail: it would not see the
--      new shift to close, and then its release would find it open;
--    - while it is open only the close may be written: the opening columns stay as the device sent
--      them. to_jsonb(row) minus the closing columns compares every other column, also the ones a
--      later step adds;
--    - once closed, with or without a count, it never changes, and it is never deleted: its
--      entries and its sales point at it.
CREATE FUNCTION pos_shifts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_holder uuid;
  v_closing text[] := ARRAY[
    'status', 'closed_at', 'closing_date', 'closing_notes', 'counted_cash', 'device_expected',
    'held_dropped', 'expected_cash', 'closing_entry_id', 'closed_by',
    'version', 'updated_at', 'updated_by'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS shift % cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The device first, the order a revoke takes (device, then its shift, then the register)
    PERFORM 1 FROM devices d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.device_id FOR SHARE;
    SELECT r.device_id INTO v_holder
      FROM pos_registers r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.register_id
       FOR SHARE;
    -- Nothing found: no such register, which the foreign key reports
    IF FOUND AND v_holder IS DISTINCT FROM NEW.device_id THEN
      RAISE EXCEPTION 'device % does not hold POS register %, so it cannot open a shift on it',
          NEW.device_id, NEW.register_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_register_not_held';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'POS shift % is closed and cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_immutable';
  END IF;
  IF to_jsonb(NEW) - v_closing IS DISTINCT FROM to_jsonb(OLD) - v_closing THEN
    RAISE EXCEPTION 'the opening of POS shift % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_opening_locked';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pos_shifts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pos_shifts
  FOR EACH ROW EXECUTE FUNCTION pos_shifts_guard();

-- 5) A register with an open shift keeps its device (decision 32): letting go of it, moving the
--    device to another branch (whose release fires this) and giving it to another device are all
--    refused until the shift is closed. A revoke closes the shift first (section 6), so it passes.
--    The rest is 0052's guard as it was.
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

-- 6) A revoked device's open shift is closed without a count (decision 11), whoever revoked it and
--    however: a lost PC is revoked so the counter can work again. Nobody counted, so nothing is
--    posted; the server's expected cash is stored, and it is what the next shift's opening count
--    is compared with. closed_by is the person who revoked it (0048 makes every revoke name one).
--    The shift is closed before the register is let go, or section 5 would refuse the release.
--    A device moved to another branch closes nothing: its open shift makes the release, and so
--    the move, fail. The rest is 0052's release as it was.
CREATE OR REPLACE FUNCTION devices_pos_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE pos_shifts s
       SET status = 'closed_without_count',
           closed_at = NEW.revoked_at,
           closed_by = NEW.revoked_by,
           expected_cash = (SELECT c.expected FROM pos_shift_cash(s.tenant_id, s.id) c),
           version = s.version + 1,
           updated_at = now(),
           updated_by = NEW.revoked_by
     WHERE s.tenant_id = NEW.tenant_id AND s.device_id = NEW.id AND s.status = 'open';
  END IF;
  UPDATE pos_registers
     SET device_id = NULL
   WHERE tenant_id = NEW.tenant_id AND device_id = NEW.id;
  RETURN NULL;
END $$;

-- 7) The devices keep every active reason (pos_cash_reason, step 18a's change log), and each
--    register's latest shift is part of the register's row (lastShift). So a shift that opens or
--    closes logs its register: the next pull sends the register again, and the next cashier on
--    any device of the branch numbers on from it and compares their count with what it left. A
--    shift is never deleted (section 4), so it has no delete trigger.
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT *
      FROM (VALUES
        ('pos_cash_reasons', 'pos_cash_reason', 'r.id::text', 'INSERT'),
        ('pos_cash_reasons', 'pos_cash_reason', 'r.id::text', 'UPDATE'),
        ('pos_cash_reasons', 'pos_cash_reason', 'r.id::text', 'DELETE'),
        ('pos_shifts', 'pos_register', 'r.register_id::text', 'INSERT'),
        ('pos_shifts', 'pos_register', 'r.register_id::text', 'UPDATE')
      ) AS v(tbl, entity, key_sql, op)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON %I REFERENCING %s
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_' || lower(s.op), s.op, s.tbl,
      CASE s.op
        WHEN 'INSERT' THEN 'NEW TABLE AS new_rows'
        WHEN 'DELETE' THEN 'OLD TABLE AS old_rows'
        ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows'
      END,
      s.entity, s.key_sql, 'true', 'NULL'
    );
  END LOOP;
END $$;

-- 8) A pay in or pay out is posted the moment it is written, and never changes: a mistake is put
--    right by a movement the other way (decision 28)
CREATE FUNCTION pos_cash_movements_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a pay in or pay out cannot be changed or deleted; move the money back instead'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_cash_movements_immutable';
END $$;

CREATE TRIGGER pos_cash_movements_immutable
  BEFORE UPDATE OR DELETE ON pos_cash_movements
  FOR EACH ROW EXECUTE FUNCTION pos_cash_movements_immutable();
```

- **Section 1** is the loop of every step: row-level security on, forced, and the `tenant_isolation` policy on the three
  tables. The RLS coverage test fails for any tenant table without it.
- **Section 2, the reason.** The API's role loses `DELETE`, like registers (there is no delete route; this makes sure a
  bug cannot add one). The guard refuses a new direction (decision 20). The name and the account may change.
- **Section 3, `pos_shift_cash()`** (decision 35). One query adds up the shift's cash: the cash payments of its sales,
  the change (`paid − total`, always given in cash, since 0052 lets no other method pay more than the total), and the pay
  ins and pay outs. The payments are summed per sale in a sub-select: a join of sales and payments would count a sale's
  change once for each of its payments. `STABLE` tells Postgres it only reads. It returns no row for a shift it cannot
  see, so it also obeys row-level security: another workspace gets nothing. 20b.3 calls it at the close and for the
  shift's page.
- **Section 4, the shift's guard.** On insert it reads the device and then the register `FOR SHARE`, and refuses a shift
  on a register its device does not hold (`pos_shifts_register_not_held`). The order matters: a revoke locks the device,
  then the shift, then the register. Without the device lock here, a shift opened at the moment of a revoke could slip
  in after the revoke looked for open shifts, and the revoke's release would then find it open and fail. A revoke must
  never fail: it is how a lost PC is stopped. On update, a closed shift refuses everything (`pos_shifts_immutable`), and
  an open one refuses a change to anything but the closing columns (`pos_shifts_opening_locked`, decision 38).
  `to_jsonb(row) - v_closing` compares every other column, also one a later step adds, without anyone remembering to
  list it. A delete is refused like a change.
- **Section 5, the register's guard,** 0052's function with one more rule (decision 37): while the register has an
  open shift, its `device_id` cannot change (`pos_registers_shift_open`). That covers letting go, giving it to another
  device, and moving the device to another branch, because 0052's release on a move is an `UPDATE` of `device_id` that
  goes through this guard: the move fails with it. `CREATE OR REPLACE` keeps 0052's trigger, which calls the function by
  name.
- **Section 6, the release on a revoke,** 0052's function with the close first (decision 11). It runs only for a revoke,
  not for a move. `closed_at` is the revoke's own time, `closed_by` the person who revoked (0048 makes every revoke name
  one), and `expected_cash` comes from section 3. It writes `version`, `updated_at` and `updated_by` itself: Drizzle's
  `$onUpdate` does not run inside the database. The shift is closed before the register is let go, or section 5 would
  refuse the release.
- **Section 7, the change log.** The reasons use step 18a's `sync_log()` as they are, with the entity
  `pos_cash_reason`; the loader in 20b.3 sends only the active ones, so an archived reason is logged and leaves the
  devices. A shift logs its register (decision 36): `r.register_id` is the key, so the register's row goes out again
  with its new `lastShift`. A shift is never deleted, so it has no delete trigger.
- **Section 8:** a movement refuses every change and delete (decision 28). It has its own function, because 0052's says
  "a POS sale".

> **What we checked.** On a throwaway Postgres with every migration up to 0054, as `omnivo_app`, in one transaction
> that rolls back (86 checks). The four POS permissions had their new descriptions. A register from 20a got a limit of
> 500, "Lock after" 5 and no over/short account; a lock of `'3'`, a limit below zero and another workspace's account
> were refused, and new settings were logged for the devices. Two reasons went in and were logged; a name in another
> case, a third direction, another workspace's account, a new direction and a delete were each refused, while a rename,
> a new account and an archive were logged. The journal took a `pos_shift` entry with its document and refused one
> without.
>
> A first shift opened on POS1 with ৳5,000 in notes and a float reason, and logged its register. A second open shift on
> the same register, a shift on a register another device holds or nobody holds, a float on a shift that is not the
> first, a count below zero, sequence 0, a taken number, an unknown reason or entry, notes that are not an object, an
> unknown status and a "closed" shift without its close were each refused by their own rule. While open, the opening
> could not change, a half-written close failed, and the shift could not be deleted. Three movements went in (one with
> an archived reason); a direction that is not the reason's, an amount of 0, an entry used twice, an unknown shift and
> another workspace's account were refused, and a movement could not be changed or deleted. Three sales went into the
> shift and one without a shift; a sale of the shift from another register, or from another device, was refused.
> `pos_shift_cash()` gave 5,000 + 1,900 taken + 1,000 in − 350 change − 2,150 out = 5,400. The register could not be let
> go, nor its device moved to another branch, while the shift was open; it could still be renamed. The close stored
> 5,400 and logged the register; after it the shift could not change, open again or be deleted, while a late sale for
> it still went in. The register could then be let go and taken by another device, whose shift could not reuse
> sequence 1. A close without a count without `closed_by`, or with a count, and a close with 21 dropped carts or with a
> `closed_by` were refused; a manager's close stored the expected cash. Revoking Counter PC 2 closed its open shift
> without a count (closed by the revoker, at the revoke's time, expected ৳2,800, version 2), let go of its register and
> logged it; a revoke without a shift let go as before. The other workspace saw none of the rows, could not read a
> shift's cash, changed nothing and could not add a reason.
>
> Five races, each with two sessions, the second starting while the first held its transaction: an open, then a release
> of the same register (the release waited, then was refused); a release, then an open (the open waited, then was
> refused); an open, then a revoke of its device (the revoke waited, then closed the shift and let go); a revoke, then
> an open with that device (the open waited, then was refused); and an open with no device lock of its own, then a
> revoke (the guard's own lock made the revoke wait; without it, the revoke failed, which is why section 4 takes it).
>
> The API's RLS coverage, stock and valuation suites pass with 0053 and 0054. The device suite fails only where a test
> pulls (the pull has no `pos_cash_reason` loader until 20b.3), and the POS suites fail where they make a register
> without the new required fields (20b.3 and 20b.4).

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
pnpm --filter @omnivo/db build
```

`pnpm db:migrate` applies 0053 and 0054 to your dev database and writes the new permission and the two new
descriptions. The build lets the API see the new tables in 20b.3. Do not run the whole `pnpm typecheck` yet: the API,
i18n, sync and app packages still fail as listed at the end of 20b.1, until their parts.

## 20b.3 — `apps/api`: reasons, the three commands, the managers' shifts

The API has two new services in `src/pos/`: the reasons (Settings → POS) and the shifts. The shifts service writes the
three sync commands and reads the shifts for the managers. Around them, smaller changes: the register's new fields,
the sale's shift, the push and the pull, the device's branch move and revoke, a bell, and the journal.

### `pos/booking-day.ts` (new): the day a POS command is booked on

```ts
import { todayIn } from '@omnivo/contracts';
import { tenantSettings } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { firstOpenDay } from '../journal/period-lock.service.js';

// Step 20a, decision 26, for every POS command (a sale; since 20b a shift's open, its pay ins and
// outs and its close): the books take it on the device's day, unless the device's clock is ahead
// of the server's today, or the books are closed for that day: then on the first day they take.
export async function bookingDay(tx: Transaction, deviceDate: string): Promise<string> {
  const tenantId = getTenantId();
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  const today = todayIn(settings.timezone);
  return firstOpenDay(tx, deviceDate > today ? today : deviceDate);
}
```

- **This is 20a's code from the sale, moved into a function** (decision 58). The shift's three commands need the same
  rule, and four copies of it could drift apart.
- **The server's today is in the workspace's time zone** (`todayIn()`), not the server's own: a sale at 23:30 in Dhaka
  is that day's, while the server's clock in UTC is still on the day before.

### `pos/pos-cash-reasons.service.ts` (new): pay in and pay out reasons

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  isPartyAccountPurpose,
  type PosCashReason,
  type PosCashReasonInput,
  type UpdatePosCashReasonInput,
} from '@omnivo/contracts';
import { ledgerAccounts, posCashReasons } from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { stockAccountIds } from '../journal/posting.service.js';

export type PosCashReasonRow = typeof posCashReasons.$inferSelect;

// As the API and the devices (the pull's pos_cash_reason rows) show it
export function toPosCashReason(row: PosCashReasonRow): PosCashReason {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    accountId: row.accountId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'pos_reason_name_taken', 'Another reason has this name.', {
    fieldErrors: { name: ['pos_reason_name_taken'] },
  });
}

function accountInvalid(): AppError {
  return new AppError(
    409,
    'pos_reason_account_invalid',
    'Pick an active account that is not a group, a customer or supplier account, or the stock.',
    { fieldErrors: { accountId: ['pos_reason_account_invalid'] } },
  );
}

// Pay in and pay out reasons (step 20b, decision 4): Settings → POS, with pos.register.manage.
// Every device of the workspace keeps the active ones (decision 20), so a cashier picks one
// offline. A reason is never deleted (0054 takes DELETE away): old movements point at it.
@Injectable()
export class PosCashReasonsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // In and out apart, then by name, as the settings page and the cashier's select show them
  list(query: { status: 'active' | 'archived' }): Promise<PosCashReason[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(posCashReasons)
        .where(
          and(
            eq(posCashReasons.tenantId, getTenantId()),
            query.status === 'active'
              ? isNull(posCashReasons.archivedAt)
              : isNotNull(posCashReasons.archivedAt),
          ),
        )
        .orderBy(asc(posCashReasons.direction), sql`lower(${posCashReasons.name})`);
      return rows.map(toPosCashReason);
    });
  }

  async create(input: PosCashReasonInput): Promise<PosCashReason> {
    try {
      return await this.withTenant(async (tx) => {
        await this.checkAccount(tx, input.accountId);
        const [row] = await tx
          .insert(posCashReasons)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            direction: input.direction,
            accountId: input.accountId,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('POS cash reason insert returned no row');
        await audit(tx, {
          action: 'pos_cash_reason.created',
          entityType: 'pos_cash_reason',
          entityId: row.id,
          changes: created(await this.snapshot(tx, row)),
        });
        return toPosCashReason(row);
      });
    } catch (error) {
      // The one rule the check before cannot see: two creates with one name at the same moment
      if (isUniqueViolation(error, 'pos_cash_reasons_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // The name and the account; the direction never changes (decision 20). A movement keeps the
  // account it was posted to, so a new account moves no old money.
  async update(id: string, input: UpdatePosCashReasonInput): Promise<PosCashReason> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        // An archived reason keeps an account archived since; only a new choice must be usable
        if (input.accountId !== before.accountId) await this.checkAccount(tx, input.accountId);
        const [after] = await tx
          .update(posCashReasons)
          .set({
            name: input.name,
            accountId: input.accountId,
            version: sql`${posCashReasons.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)))
          .returning();
        if (!after) throw notFound('POS cash reason');
        await audit(tx, {
          action: 'pos_cash_reason.updated',
          entityType: 'pos_cash_reason',
          entityId: id,
          changes: diff(await this.snapshot(tx, before), await this.snapshot(tx, after)),
        });
        return toPosCashReason(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'pos_cash_reasons_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // An archived reason leaves the devices with their next pull. One a device chose before that
  // still posts when its movement arrives (decision 40).
  setArchived(id: string, version: number, archived: boolean): Promise<PosCashReason> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toPosCashReason(before);
      // Its account may have been archived meanwhile: a reason comes back with a usable one
      if (!archived) await this.checkAccount(tx, before.accountId);
      const [after] = await tx
        .update(posCashReasons)
        .set({
          archivedAt: archived ? new Date() : null,
          version: sql`${posCashReasons.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)))
        .returning();
      if (!after) throw notFound('POS cash reason');
      await audit(tx, {
        action: archived ? 'pos_cash_reason.archived' : 'pos_cash_reason.restored',
        entityType: 'pos_cash_reason',
        entityId: id,
      });
      return toPosCashReason(after);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<PosCashReasonRow> {
    const [row] = await tx
      .select()
      .from(posCashReasons)
      .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)))
      .for('update');
    if (!row) throw notFound('POS cash reason');
    return row;
  }

  // The account a reason's money comes from or goes to: an active account of this workspace that
  // is not a group, not one kept per party (a pay out names no customer or supplier, so its line
  // would break the party rule) and not a stock account (a pay out moves no stock). Any type: a
  // bank or a safe (an asset), tea for the staff (an expense), a loan from the owner (a liability).
  // FOR SHARE: nobody archives it before we commit. One answer for every reason it is not usable,
  // like the journal's accounts.
  private async checkAccount(tx: Transaction, id: string): Promise<void> {
    const [account] = await tx
      .select({
        isGroup: ledgerAccounts.isGroup,
        purpose: ledgerAccounts.purpose,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)))
      .for('share');
    if (
      !account ||
      account.isGroup ||
      account.archivedAt !== null ||
      isPartyAccountPurpose(account.purpose) ||
      (await stockAccountIds(tx)).has(id)
    ) {
      throw accountInvalid();
    }
  }

  // What the audit log shows: the account by its code, so a reader sees "1121" and not an id
  private async snapshot(tx: Transaction, row: PosCashReasonRow) {
    const [account] = await tx
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, row.accountId)));
    return { name: row.name, direction: row.direction, account: account?.code ?? null };
  }
}
```

- **`toPosCashReason()` is exported** for the pull's loader (`sync-rows.ts` below): the API and the devices get the same
  shape, as the contract says (`syncPosCashReasonSchema = posCashReasonSchema`).
- **The list is ordered by direction, then by `lower(name)`** (decision 62). `'in'` sorts before `'out'`, so the settings
  page shows the pay ins first. `lower()` matches the unique index, so "bank deposit" and "Bank deposit" never sit apart.
- **The name's uniqueness is left to the database** (`pos_cash_reasons_tenant_name_idx`). A check before the insert would
  still miss two creates at the same moment, so the error is caught after the transaction (its rollback) and answered
  with `pos_reason_name_taken` under `name`, as every service here does.
- **`update()` takes no direction.** The contract's update input has none (decision 20), and 0054 refuses a change
  anyway. An account kept from before is not checked again: a reason whose account was archived can still be renamed.
  Only a new account must be usable.
- **`setArchived()` checks the account only on a restore.** An archived reason never posts again from a new movement,
  but one that comes back must post somewhere usable.
- **`checkAccount()` gives one answer for every reason** (decision 46), like the journal's accounts: the form shows one
  sentence, and nothing tells another workspace which ids exist. `stockAccountIds()` is the journal's own list (the
  inventory, goods in transit and goods received not billed), so a stock account chosen later in Settings → Inventory is
  refused here too. `FOR SHARE` keeps the account from being archived until we commit.
- **The audit snapshot names the account by its code,** like the register's: a reader of the log sees "5240".

### `pos/pos-shifts.service.ts` (new): the shift's three commands and the managers' reads

The longest file of the part, in seven pieces.

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  absMoney,
  cashDifferenceOf,
  compareMoney,
  type EntryRef,
  formatShiftNumber,
  isOverVarianceAlert,
  isZeroMoney,
  POS_PAYMENT_METHODS,
  type PosCashMovementInput,
  type PosShift,
  type PosShiftCloseInput,
  type PosShiftCloseWithoutCountInput,
  type PosShiftOpenInput,
  type PosShiftStatus,
  type PosShiftSummary,
  subtractMoney,
} from '@omnivo/contracts';
import {
  devices,
  journalEntries,
  posCashMovements,
  posCashReasons,
  posRegisters,
  posSalePayments,
  posSales,
  posShifts,
  users,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isCheckViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentDeviceId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PostingService } from '../journal/posting.service.js';
import type { Access } from '../rbac/permission.service.js';
import { bookingDay } from './booking-day.js';
import { accountOf, type PosRegisterRow } from './pos-registers.service.js';

type ShiftRow = typeof posShifts.$inferSelect;

const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

const closer = alias(users, 'closer');

// pos_shift_cash() (0054) as text: numeric comes back from a raw query as Postgres's own text
const cashRowSchema = z.object({
  opening: z.string(),
  cash_taken: z.string(),
  change_given: z.string(),
  paid_in: z.string(),
  paid_out: z.string(),
  expected: z.string(),
});
type ShiftCashRow = z.infer<typeof cashRowSchema>;

// Decision 25: the commands refused at all are bugs, never the cashier's slip. A command for a
// shift the server does not have, or one of another device or another workspace: one answer.
export function shiftUnknown(): AppError {
  return new AppError(409, 'pos_shift_unknown', 'The server does not know this shift.', {
    fieldErrors: { shiftId: ['pos_shift_unknown'] },
  });
}

function alreadyOpen(): AppError {
  return new AppError(
    409,
    'pos_shift_already_open',
    'Another shift is still open on this register. Close it first.',
  );
}

function notHeld(): AppError {
  return new AppError(
    409,
    'pos_register_not_held',
    'This device does not hold the register the shift was opened on.',
    { fieldErrors: { registerId: ['pos_register_not_held'] } },
  );
}

// A count's total is stored with 4 decimals, and came with at most 2 (cashCountSchema): the last
// two are zeros, and the count goes back as it was typed ("5000.00", not "5000.0000")
function countTotal(value: string): string {
  return value.replace(/(\.\d{2})00$/, '$1');
}

// The device's own shift, FOR SHARE: a manager's close without a count (FOR UPDATE) waits for
// the sale or the movement that is being written, so the expected cash it stores counts it.
// Not this device's, or not this register's: the same answer as unknown (a bug either way).
export async function deviceShift(
  tx: Transaction,
  shiftId: string,
  deviceId: string,
  registerId?: string,
): Promise<ShiftRow> {
  const [row] = await tx
    .select()
    .from(posShifts)
    .where(and(eq(posShifts.tenantId, getTenantId()), eq(posShifts.id, shiftId)))
    .for('share');
  if (row?.deviceId !== deviceId || (registerId !== undefined && row.registerId !== registerId)) {
    throw shiftUnknown();
  }
  return row;
}

// POS shifts (step 20b). The device runs a shift and sends what happened as three sync commands:
// pos_shift.open, pos_cash_movement.create and pos_shift.close. Each is posted when it arrives,
// in the push's savepoint for that command, and is never refused for money or for permission
// (decision 25): the drawer was counted, the money moved. Every entry is the journal source
// pos_shift and points at the shift (decision 28), with the branch of the register's warehouse.
// The managers read the shifts here, and close a stuck one without a count (decision 11).
@Injectable()
export class PosShiftsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // From the device
```

**The top of the file:**

- **`cashRowSchema` reads `pos_shift_cash()`** (0054) from a raw query. Drizzle cannot select from a function as a table,
  and a raw result is `unknown` rows: Zod checks them, so no cast is needed. Every column is cast to `text` in the query,
  because money is never a JavaScript number.
- **`shiftUnknown()` is exported** for the sale (decision 48). Its field error is under `shiftId`, the same path in the
  sale's input and in a movement's.
- **`countTotal()` cuts only two trailing zeros after two decimals** (decision 59). A count is stored as `numeric(19,4)`,
  but `cashCountSchema` allows at most 2 decimals, so the last two are always zeros: "5000.0000" becomes "5000.00". The
  regular expression changes nothing else.
- **`deviceShift()` locks the shift `FOR SHARE`** (decision 54). A manager closing it without a count takes it
  `FOR UPDATE`, so the two wait for each other, and the manager's expected cash includes the sale or the movement. Two
  sales of the same shift share the lock, so they never wait for each other. A shift of another device or another
  register gets the same answer as an unknown one.
- **The class comment is the rule of the whole part:** three commands, posted when they arrive, never refused for money
  or permission, all with the `pos_shift` source and the branch of the register's warehouse.

```ts
  // The opening count. The difference from what the last shift left posts to over/short
  // (decision 8); a register's first shift brings its count in from the float reason's account
  // (decision 12). The entry is posted first, because the opening columns never change once the
  // shift is written (0054): its id goes in with the row.
  async openFromDevice(
    tx: Transaction,
    access: Access,
    shiftId: string,
    input: PosShiftOpenInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = this.deviceId();
    // The device, then the register (0052's lock order, like a sale). FOR UPDATE on the register:
    // the shifts of one register open one after the other, so the last one read here is the last.
    await this.lockDevice(tx, deviceId);
    const [register] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, input.registerId)))
      .for('update');
    if (register?.deviceId !== deviceId) throw notHeld();
    const number = formatShiftNumber(register.code, input.sequence);

    // The latest shift of the register. Open: the device did not know it (a bug), and the
    // database would refuse the second open anyway (pos_shifts_register_open_idx).
    const [last] = await tx
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.registerId, register.id)))
      .orderBy(desc(posShifts.sequence))
      .limit(1);
    if (last?.status === 'open') throw alreadyOpen();
    // What should be in the drawer: the last count, or, when nobody counted, what the server
    // expects now. Now and not at that close: a device that was offline sends the last sales of
    // its shift after a manager's close (decision 63), and their cash is in the drawer and in the
    // books already. undefined = the register's first shift.
    const comparedWith =
      last === undefined
        ? null
        : last.status === 'closed_without_count'
          ? (await this.cashOf(tx, last.id)).expected
          : last.countedCash;
    if (last !== undefined && comparedWith === null) {
      throw new Error(`Closed POS shift ${last.id} has no cash left`);
    }

    const date = await bookingDay(tx, input.date);
    const opening = input.opening.total;
    const branchId = await this.branchOf(tx, register);
    const document = { id: shiftId, number, date, branchId };
    let floatReason: { id: string; name: string } | null = null;
    let entry: EntryRef | null = null;
    if (comparedWith !== null) {
      // Over: more in the drawer than was left, which comes in from over/short. Short: the other way.
      entry = await this.postDifference(
        tx,
        document,
        register,
        cashDifferenceOf(opening, comparedWith),
        `POS shift ${number}: opening count`,
      );
    } else if (input.floatReasonId !== null) {
      // Decision 12: the float comes from the "in" reason's account. A reason of the other way,
      // or one the server does not know, is a bug on the device (it shows only "in" reasons).
      const reason = await this.reason(tx, input.floatReasonId);
      if (reason?.direction !== 'in') {
        throw new AppError(409, 'pos_float_reason_required', 'Pick where the float came from.', {
          fieldErrors: { floatReasonId: ['pos_float_reason_required'] },
        });
      }
      floatReason = { id: reason.id, name: reason.name };
      if (!isZeroMoney(opening)) {
        entry = await this.postMove(
          tx,
          document,
          { debit: register.cashAccountId, credit: reason.accountId, amount: opening },
          `POS shift ${number}: float, ${reason.name}`,
        );
      }
    } else {
      // A first shift without a reason: the device always asks for one when the drawer holds
      // money, so only a bug gets here. The money is still in the drawer: over/short takes it.
      entry = await this.postDifference(
        tx,
        document,
        register,
        opening,
        `POS shift ${number}: opening count`,
      );
    }

    try {
      await tx.insert(posShifts).values({
        id: shiftId,
        tenantId,
        registerId: register.id,
        deviceId,
        sequence: input.sequence,
        number,
        openedAt: new Date(input.openedAt),
        openingDate: date,
        openingNotes: input.opening.notes,
        openingCash: opening,
        openingComparedWith: comparedWith,
        floatReasonId: floatReason?.id ?? null,
        openingEntryId: entry?.id ?? null,
        createdBy: currentPrincipal().userId,
        updatedBy: currentPrincipal().userId,
      });
    } catch (error) {
      // The register is locked, so only a bug gets here; the savepoint takes the entry back too
      if (isUniqueViolation(error, 'pos_shifts_register_open_idx')) throw alreadyOpen();
      if (isCheckViolation(error, 'pos_shifts_register_not_held')) throw notHeld();
      if (
        isUniqueViolation(error, 'pos_shifts_register_sequence_idx') ||
        isUniqueViolation(error, 'pos_shifts_tenant_number_idx')
      ) {
        throw new AppError(409, 'pos_number_taken', `Another shift already has number ${number}.`, {
          fieldErrors: { sequence: ['pos_number_taken'] },
        });
      }
      throw error;
    }

    await audit(tx, {
      action: 'pos_shift.opened',
      entityType: 'pos_shift',
      entityId: shiftId,
      changes: created({
        number,
        date,
        openedOn: input.date,
        opening,
        comparedWith,
        floatReason: floatReason?.name ?? null,
        entry: entry?.number ?? null,
      }),
    });
    await this.auditPermission(tx, access, shiftId, number, input.date);
  }
```

**The open (`openFromDevice()`):**

- **The device first, then the register `FOR UPDATE`.** This is 0052's lock order, the same as a sale's and a revoke's;
  any other order could wait in a circle. `FOR UPDATE` on the register makes two opens of one register run one after the
  other, so the "last shift" read next really is the last.
- **`notHeld()` before anything else:** the device holds its register while it runs a shift (decision 32), so another
  holder is a bug, or a register of another workspace. 0054's guard would refuse the insert anyway
  (`pos_shifts_register_not_held`); this answers it first.
- **The last shift is read by the highest sequence,** with `pos_shifts_register_sequence_idx`. One still open means the
  device did not know about it (a bug): `pos_shift_already_open` before anything posts (decision 50).
- **`comparedWith` is the counted cash, or, when nobody counted, the expected cash now** (decisions 17 and 63):
  `cashOf()` runs `pos_shift_cash()` on the last shift, so a sale that arrived after a manager's close is in it. Using
  the stored `expectedCash` would leave that sale out, and its cash would post to over/short a second time. A counted
  shift always has its count (`pos_shifts_status_check`), so a `null` here is a broken row, not a case to handle: it
  throws.
- **Three ways to post the opening.** A later shift posts the difference from what was left (decision 8): above zero,
  over/short gives the cash; below zero, the cash goes to over/short. A first shift with a float reason posts the whole
  count from the reason's account (decision 12). A first shift with money and no reason posts it to over/short
  (decision 49): the device never sends that, and the money is in the drawer either way.
- **The float reason must be an "in" reason** (decision 49). The database cannot check that (the shift's foreign key
  points at the reason, not at its direction).
- **The entry is posted before the insert** (decision 47). The insert then carries `openingEntryId`. If the insert fails,
  the push's savepoint takes the entry back with it, so no entry is left without its shift.
- **The unique and check errors are mapped to their codes.** The register is locked, so only a bug gets there; a
  refusal still beats a 500, which would stop the device's whole push.
- **The audit row has the device's day and the booked day** (`openedOn`, `date`), so a manager sees when a closed period
  moved it.

```ts
  // A pay in or a pay out (decision 4): Dr the register's cash / Cr the reason's account, or the
  // other way. Written also for a shift closed since: the money moved, like a late sale (0054
  // lets it in, decision 39).
  async moveCashFromDevice(
    tx: Transaction,
    access: Access,
    movementId: string,
    input: PosCashMovementInput,
  ): Promise<void> {
    const deviceId = this.deviceId();
    await this.lockDevice(tx, deviceId);
    const shift = await deviceShift(tx, input.shiftId, deviceId);
    // An archived reason still posts (decision 40); an unknown one is a bug on the device
    const reason = await this.reason(tx, input.reasonId);
    if (!reason) {
      throw new AppError(409, 'pos_reason_required', 'The server does not know this reason.', {
        fieldErrors: { reasonId: ['pos_reason_required'] },
      });
    }
    const register = await this.register(tx, shift.registerId);
    const date = await bookingDay(tx, input.date);
    const document = {
      id: shift.id,
      number: shift.number,
      date,
      branchId: await this.branchOf(tx, register),
    };
    const cash = register.cashAccountId;
    const entry = await this.postMove(
      tx,
      document,
      reason.direction === 'in'
        ? { debit: cash, credit: reason.accountId, amount: input.amount }
        : { debit: reason.accountId, credit: cash, amount: input.amount },
      `POS shift ${shift.number}: pay ${reason.direction}, ${reason.name}`,
    );
    if (entry === null) throw new Error('A pay in or pay out above zero posted nothing');
    await tx.insert(posCashMovements).values({
      id: movementId,
      tenantId: getTenantId(),
      shiftId: shift.id,
      reasonId: reason.id,
      direction: reason.direction,
      amount: input.amount,
      note: input.note,
      date,
      movedAt: new Date(input.movedAt),
      // The reason's account now: a later change of the reason moves no money (decision 20)
      accountId: reason.accountId,
      entryId: entry.id,
      createdBy: currentPrincipal().userId,
      updatedBy: currentPrincipal().userId,
    });
    await audit(tx, {
      action: 'pos_shift.cash_moved',
      entityType: 'pos_shift',
      entityId: shift.id,
      changes: created({
        reason: reason.name,
        direction: reason.direction,
        amount: input.amount,
        note: input.note,
        date,
        entry: entry.number,
        shiftStatus: shift.status,
      }),
    });
    await this.auditPermission(tx, access, shift.id, shift.number, input.date);
  }
```

**A pay in or pay out (`moveCashFromDevice()`):**

- **The device, then the shift (`deviceShift()`),** the revoke's order.
- **An archived reason posts** (decision 40), so `reason()` reads it with no `archived_at` filter.
- **The direction comes from the reason,** never from the device. The movement's row copies it, and the foreign key on
  `(reason, direction)` makes sure the two match (0053).
- **The cash account is the register's now,** like a sale's payment account. The reason's account is copied onto the row:
  a later change of the reason moves no old money (decision 20).
- **`entry === null` throws:** the contract refuses an amount of 0, so a movement always posts. `entry_id` is `NOT NULL`.
- **The audit row keeps the shift's status** (decision 51): a movement for a closed shift shows up in the log as late.

```ts
  // The closing count (decisions 5, 9, 22). The server works the expected cash out again from its
  // own rows (pos_shift_cash), posts the difference to over/short, and rings the bell over the
  // register's limit. The close arrives after every sale and movement of the shift: the device's
  // outbox sends them in order.
  async closeFromDevice(
    tx: Transaction,
    access: Access,
    shiftId: string,
    input: PosShiftCloseInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = this.deviceId();
    // The device, the shift, then the register: a revoke's order (0054), so the two never wait
    // for each other in a circle
    await this.lockDevice(tx, deviceId);
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, shiftId)))
      .for('update');
    if (shift?.deviceId !== deviceId) throw shiftUnknown();
    const counted = input.counted.total;

    // Decision 38: a manager (or a revoke) closed it without a count before this arrived. The
    // shift never changes again, so the count goes to the audit log only. Never a refusal: the
    // cashier did count. A second close of a counted shift (a bug) is kept the same way.
    if (shift.status !== 'open') {
      await audit(tx, {
        action: 'pos_shift.closed',
        entityType: 'pos_shift',
        entityId: shift.id,
        changes: created({
          number: shift.number,
          counted,
          deviceExpected: input.deviceExpected,
          closedOn: input.date,
          kept: false,
          statusBefore: shift.status,
        }),
      });
      await this.auditPermission(tx, access, shift.id, shift.number, input.date);
      return;
    }

    // FOR SHARE: the over/short account and the limit stay as read until we commit
    const register = await this.register(tx, shift.registerId, true);
    const cash = await this.cashOf(tx, shift.id);
    const difference = cashDifferenceOf(counted, cash.expected);
    const date = await bookingDay(tx, input.date);
    const entry = await this.postDifference(
      tx,
      { id: shift.id, number: shift.number, date, branchId: await this.branchOf(tx, register) },
      register,
      difference,
      `POS shift ${shift.number}: closing count`,
    );

    await tx
      .update(posShifts)
      .set({
        status: 'closed',
        closedAt: new Date(input.closedAt),
        closingDate: date,
        closingNotes: input.counted.notes,
        countedCash: counted,
        deviceExpected: input.deviceExpected,
        heldDropped: input.heldDropped,
        expectedCash: cash.expected,
        closingEntryId: entry?.id ?? null,
        version: sql`${posShifts.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, shift.id)));

    await audit(tx, {
      action: 'pos_shift.closed',
      entityType: 'pos_shift',
      entityId: shift.id,
      changes: created({
        number: shift.number,
        date,
        closedOn: input.date,
        counted,
        expected: cash.expected,
        difference,
        heldDropped: input.heldDropped,
        entry: entry?.number ?? null,
      }),
    });
    // Decision 22: the books keep the server's number; a different one on the device means a sale
    // or a movement is missing on one side
    if (compareMoney(input.deviceExpected, cash.expected) !== 0) {
      await audit(tx, {
        action: 'pos_shift.expected_differs',
        entityType: 'pos_shift',
        entityId: shift.id,
        changes: created({ device: input.deviceExpected, server: cash.expected }),
      });
    }
    await this.auditPermission(tx, access, shift.id, shift.number, input.date);
    // Decision 5: the managers hear about a big difference after the commit
    if (isOverVarianceAlert(difference, register.varianceAlert)) {
      await emit(tx, 'pos.shift_variance', { shiftId: shift.id });
    }
  }
```

**The close (`closeFromDevice()`):**

- **The device, the shift `FOR UPDATE`, then the register `FOR SHARE`:** the revoke's order again (0054 locks the device,
  updates the shift, then the register). The register lock keeps its over/short account and its limit as they were read.
- **A shift that is not open** (decision 52) gets the count in the audit log, and the command is accepted. A refusal
  would sit in the cashier's sync page with nothing to fix.
- **The expected cash comes from the server's rows** (`cashOf()`, decision 22). The device's number is stored only to
  compare; `expected_differs` is written when the two are not the same.
- **`closingNotes` is the notes or `null`** (a count typed as a total). `pos_shifts_status_check` asks for the counted
  total, the device's number and `heldDropped` on every counted close; it does not ask for notes.
- **`version` and `updatedBy` are written by hand.** Drizzle's `$onUpdate` sets `updated_at` only.
- **The bell is an outbox event** (decision 5), written in the same transaction: it goes out only if the close commits,
  and the worker sends it after.

```ts
  // ---------------------------------------------------------------------------------------------
  // For the managers (pos.shift.manage)

  list(query: {
    limit: number;
    cursor?: string | undefined;
    registerId?: string | undefined;
    status?: PosShiftStatus | undefined;
  }): Promise<{ items: PosShiftSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.registerId === undefined ? undefined : eq(posShifts.registerId, query.registerId),
          query.status === undefined ? undefined : eq(posShifts.status, query.status),
          after === undefined
            ? undefined
            : sql`(${posShifts.openedAt}, ${posShifts.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.openedAt, last.id]);
    });
  }

  get(id: string): Promise<PosShift> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  // Decision 11: a shift nobody can close at its counter (the cashier went home, the PC is in
  // repair). Nobody counted, so nothing posts; the server's expected cash is what the next
  // shift's opening count is compared with, and finds what is missing.
  closeWithoutCount(id: string, input: PosShiftCloseWithoutCountInput): Promise<PosShift> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      // FOR UPDATE: a sale or a movement being written (FOR SHARE, deviceShift) finishes first,
      // so the expected cash counts it. A close from the device waits for this one, then finds the
      // shift closed (decision 38).
      const [shift] = await tx
        .select()
        .from(posShifts)
        .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, id)))
        .for('update');
      if (!shift) throw notFound('POS shift');
      if (shift.status !== 'open') {
        throw new AppError(409, 'pos_shift_closed', 'This shift is closed already.');
      }
      const cash = await this.cashOf(tx, id);
      await tx
        .update(posShifts)
        .set({
          status: 'closed_without_count',
          closedAt: new Date(),
          closedBy: currentPrincipal().userId,
          expectedCash: cash.expected,
          version: sql`${posShifts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, id)));
      await audit(tx, {
        action: 'pos_shift.closed_without_count',
        entityType: 'pos_shift',
        entityId: id,
        changes: created({
          number: shift.number,
          expected: cash.expected,
          note: input.note,
          by: 'manager',
        }),
      });
      return this.read(tx, id);
    });
  }
```

**For the managers:**

- **The list's cursor is `(opened_at, id)`, newest first,** the order of `pos_shifts_tenant_opened_idx` (and of
  `pos_shifts_register_opened_idx` when it is for one register). The id breaks a tie between two shifts opened in the same
  millisecond.
- **`closeWithoutCount()` locks the shift `FOR UPDATE`** (decision 54). A sale or a movement being written finishes
  first; a close from the device that arrives after waits, then finds the shift closed (decision 52). A shift that is not
  open is `pos_shift_closed`: a second manager pressed the button too.
- **Nothing posts** (decision 11). The expected cash is stored, so the next shift's opening is compared with it.
- **The answer is read in the same transaction,** so the page shows the shift exactly as this close left it.

```ts
  // ---------------------------------------------------------------------------------------------

  private deviceId(): string {
    const deviceId = currentDeviceId();
    if (deviceId === null) throw new Error('A POS shift command comes only from a device');
    return deviceId;
  }

  // A revoke of this device that is running finishes first: it closes the device's open shift
  // and frees the register, and this command then sees it
  private async lockDevice(tx: Transaction, deviceId: string): Promise<void> {
    await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, deviceId)))
      .for('share');
  }

  private async register(tx: Transaction, id: string, lock = false): Promise<PosRegisterRow> {
    const query = tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)));
    const [row] = lock ? await query.for('share') : await query;
    if (!row) throw new Error(`POS register ${id} of a shift is missing`);
    return row;
  }

  private async reason(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(posCashReasons)
      .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)));
    return row;
  }

  // The branch of the register's warehouse now, like a sale's lines
  private async branchOf(tx: Transaction, register: PosRegisterRow): Promise<string> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, register.warehouseId)));
    if (!row) throw new Error(`Warehouse ${register.warehouseId} of a POS register is missing`);
    return row.branchId;
  }

  // With 4 decimals, like every amount of the API: a sum of no rows is coalesce's plain 0
  private async cashOf(tx: Transaction, shiftId: string): Promise<ShiftCashRow> {
    const [row] = z.array(cashRowSchema).parse(
      await tx.execute(sql`
        SELECT opening::numeric(19, 4)::text AS opening,
               cash_taken::numeric(19, 4)::text AS cash_taken,
               change_given::numeric(19, 4)::text AS change_given,
               paid_in::numeric(19, 4)::text AS paid_in,
               paid_out::numeric(19, 4)::text AS paid_out,
               expected::numeric(19, 4)::text AS expected
          FROM pos_shift_cash(${getTenantId()}::uuid, ${shiftId}::uuid)`),
    );
    if (!row) throw new Error(`POS shift ${shiftId} has no cash`);
    return row;
  }

  // A counted difference: over (above zero) comes in from over/short to the register's cash,
  // short goes the other way. null when the count matched.
  private postDifference(
    tx: Transaction,
    document: { id: string; number: string; date: string; branchId: string },
    register: PosRegisterRow,
    difference: string,
    narration: string,
  ): Promise<EntryRef | null> {
    if (isZeroMoney(difference)) return Promise.resolve(null);
    // Required in the register's form since 20b; a register from 20a opens no shift without it
    // (decision 13), so only a device that skipped that check gets here
    const overShort = register.overShortAccountId;
    if (overShort === null) {
      throw new AppError(
        409,
        'pos_over_short_required',
        'Pick the over/short account of this register in Settings → POS.',
      );
    }
    const amount = absMoney(difference);
    return this.postMove(
      tx,
      document,
      compareMoney(difference, '0') > 0
        ? { debit: register.cashAccountId, credit: overShort, amount }
        : { debit: overShort, credit: register.cashAccountId, amount },
      narration,
    );
  }

  // One entry of two lines, both with the branch of the register's warehouse. null for nothing.
  private async postMove(
    tx: Transaction,
    document: { id: string; number: string; date: string; branchId: string },
    move: { debit: string; credit: string; amount: string },
    narration: string,
  ): Promise<EntryRef | null> {
    if (isZeroMoney(move.amount)) return null;
    const line = { branchId: document.branchId, partyId: null, description: null };
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration,
      source: 'pos_shift',
      document: { id: document.id, number: document.number },
      lines: [
        { ...line, accountId: move.debit, debit: move.amount, credit: '0' },
        { ...line, accountId: move.credit, debit: '0', credit: move.amount },
      ],
    });
    if (entry.number === null) throw new Error('A posted entry has no number');
    return { id: entry.id, number: entry.number };
  }

  // Decision 25, like a sale's (step 20a, decision 28): the command went through without the
  // permission, which was taken away while the device was offline
  private async auditPermission(
    tx: Transaction,
    access: Access,
    shiftId: string,
    number: string,
    deviceDate: string,
  ): Promise<void> {
    if (access.permissions.includes('pos.sale.create')) return;
    await audit(tx, {
      action: 'pos_shift.without_permission',
      entityType: 'pos_shift',
      entityId: shiftId,
      changes: created({ number, on: deviceDate, missing: 'pos.sale.create' }),
    });
  }
```

**The helpers:**

- **`deviceId()` throws a plain `Error`.** The push always runs a command inside `runFromDevice()`, so a missing device
  is a bug in the server, never a refusal.
- **`lockDevice()` takes the device `FOR SHARE`,** like the sale: a revoke running now finishes first, and the command
  then sees the shift it closed and the register it freed.
- **`register()` locks only when asked:** the close needs the lock, the movement and the page do not.
- **`branchOf()` is the warehouse's branch now,** like a sale's lines: a register is in a branch through its warehouse.
- **`postDifference()` turns a signed difference into a move:** over debits the cash, short debits over/short. A register
  without an over/short account (one from 20a, decision 42) refuses only when there is a difference to post: the device
  opens no shift on such a register, so only a device that skipped that check gets here.
- **`postMove()` writes two lines and lets `postNew()` check them.** The period lock, the accounts, the balance and the
  numbering are the journal's rules, in one place (decision 44 adds `pos_shift` to its archived exception). No party is
  named: no reason and no over/short account is kept per party.
- **`auditPermission()` is decision 25:** the command went through without `pos.sale.create`, and the log says so with
  the device's day.

```ts
  // The list's rows. A counted shift shows what the drawer should have held at its close; an open
  // one, and one closed without a count, what it should hold now (late sales count, decision 63).
  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<PosShiftSummary[]> {
    const rows = await tx
      .select({
        shift: posShifts,
        register: { id: posRegisters.id, code: posRegisters.code, name: posRegisters.name },
        branchId: warehouses.branchId,
        cashierName: users.fullName,
        deviceName: devices.name,
        expectedNow: sql<string>`CASE WHEN ${posShifts.status} = 'closed'
          THEN ${posShifts.expectedCash}::text
          ELSE (SELECT c.expected::text FROM pos_shift_cash(${posShifts.tenantId}, ${posShifts.id}) c)
          END`,
        saleCount: sql<number>`(SELECT count(*)::int FROM pos_sales x
          WHERE x.tenant_id = ${posShifts.tenantId} AND x.shift_id = ${posShifts.id})`,
        salesTotal: sql<string>`(SELECT coalesce(sum(x.total), 0)::numeric(19, 4)::text FROM pos_sales x
          WHERE x.tenant_id = ${posShifts.tenantId} AND x.shift_id = ${posShifts.id})`,
      })
      .from(posShifts)
      .innerJoin(
        posRegisters,
        and(
          eq(posRegisters.tenantId, posShifts.tenantId),
          eq(posRegisters.id, posShifts.registerId),
        ),
      )
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, posRegisters.tenantId),
          eq(warehouses.id, posRegisters.warehouseId),
        ),
      )
      .innerJoin(
        devices,
        and(eq(devices.tenantId, posShifts.tenantId), eq(devices.id, posShifts.deviceId)),
      )
      .leftJoin(users, eq(users.id, posShifts.createdBy))
      .where(and(eq(posShifts.tenantId, getTenantId()), where))
      .orderBy(desc(posShifts.openedAt), desc(posShifts.id))
      .limit(limit);
    return rows.map((row) => {
      const { shift } = row;
      // created_by is the device's person: never empty for a shift (openFromDevice sets it)
      if (shift.createdBy === null) throw new Error(`POS shift ${shift.id} has no cashier`);
      return {
        id: shift.id,
        number: shift.number,
        register: row.register,
        branchId: row.branchId,
        sequence: shift.sequence,
        status: shift.status,
        cashier: { id: shift.createdBy, fullName: row.cashierName ?? '' },
        device: { id: shift.deviceId, name: row.deviceName },
        openedAt: shift.openedAt.toISOString(),
        closedAt: shift.closedAt?.toISOString() ?? null,
        openingCash: countTotal(shift.openingCash),
        expectedCash: row.expectedNow,
        countedCash: shift.countedCash === null ? null : countTotal(shift.countedCash),
        difference:
          shift.countedCash === null || shift.expectedCash === null
            ? null
            : cashDifferenceOf(shift.countedCash, shift.expectedCash),
        saleCount: row.saleCount,
        salesTotal: row.salesTotal,
      };
    });
  }

  // One shift with everything its page shows
  private async read(tx: Transaction, id: string): Promise<PosShift> {
    const tenantId = getTenantId();
    const [summary] = await this.summaries(tx, eq(posShifts.id, id), 1);
    if (!summary) throw notFound('POS shift');
    const [header] = await tx
      .select({ shift: posShifts, closerName: closer.fullName })
      .from(posShifts)
      .leftJoin(closer, eq(closer.id, posShifts.closedBy))
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, id)));
    if (!header) throw notFound('POS shift');
    const { shift } = header;
    const register = await this.register(tx, shift.registerId);
    const cash = await this.cashOf(tx, id);

    const movementRows = await tx
      .select({
        movement: posCashMovements,
        reasonName: posCashReasons.name,
        entryNumber: journalEntries.number,
      })
      .from(posCashMovements)
      .innerJoin(
        posCashReasons,
        and(
          eq(posCashReasons.tenantId, posCashMovements.tenantId),
          eq(posCashReasons.id, posCashMovements.reasonId),
        ),
      )
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntries.tenantId, posCashMovements.tenantId),
          eq(journalEntries.id, posCashMovements.entryId),
        ),
      )
      .where(and(eq(posCashMovements.tenantId, tenantId), eq(posCashMovements.shiftId, id)))
      .orderBy(asc(posCashMovements.movedAt), asc(posCashMovements.id));

    // What the sales took by each method: every method the register takes now, and any other one
    // a sale of the shift was paid with, in the contract's order (cash first)
    const paid = await tx
      .select({
        method: posSalePayments.method,
        amount: sql<string>`sum(${posSalePayments.amount})::text`,
      })
      .from(posSalePayments)
      .innerJoin(
        posSales,
        and(
          eq(posSales.tenantId, posSalePayments.tenantId),
          eq(posSales.id, posSalePayments.saleId),
        ),
      )
      .where(and(eq(posSalePayments.tenantId, tenantId), eq(posSales.shiftId, id)))
      .groupBy(posSalePayments.method);
    const paidBy = new Map(paid.map((row) => [row.method, row.amount]));
    const payments = POS_PAYMENT_METHODS.flatMap((method) => {
      const amount = paidBy.get(method);
      if (amount === undefined && accountOf(register, method) === null) return [];
      return [{ method, amount: amount ?? '0.0000' }];
    });

    const reasonIds = shift.floatReasonId === null ? [] : [shift.floatReasonId];
    const [floatReason] =
      reasonIds.length === 0
        ? []
        : await tx
            .select({ id: posCashReasons.id, name: posCashReasons.name })
            .from(posCashReasons)
            .where(
              and(eq(posCashReasons.tenantId, tenantId), inArray(posCashReasons.id, reasonIds)),
            );
    const entries = await this.entryRefs(
      tx,
      [shift.openingEntryId, shift.closingEntryId].flatMap((entryId) =>
        entryId === null ? [] : [entryId],
      ),
    );
    const entryOf = (entryId: string | null) =>
      entryId === null ? null : (entries.get(entryId) ?? null);

    return {
      ...summary,
      opening: {
        count: { notes: shift.openingNotes, total: countTotal(shift.openingCash) },
        date: shift.openingDate,
        comparedWith: shift.openingComparedWith,
        difference:
          shift.openingComparedWith === null
            ? null
            : subtractMoney(shift.openingCash, shift.openingComparedWith),
        floatReason: floatReason ?? null,
        entry: entryOf(shift.openingEntryId),
      },
      closing:
        shift.status === 'closed' &&
        shift.countedCash !== null &&
        shift.closingDate !== null &&
        shift.deviceExpected !== null &&
        shift.heldDropped !== null
          ? {
              count: { notes: shift.closingNotes, total: countTotal(shift.countedCash) },
              date: shift.closingDate,
              deviceExpected: shift.deviceExpected,
              heldDropped: shift.heldDropped,
              entry: entryOf(shift.closingEntryId),
            }
          : null,
      closedBy:
        shift.closedBy === null ? null : { id: shift.closedBy, fullName: header.closerName ?? '' },
      cash: {
        opening: cash.opening,
        cashTaken: cash.cash_taken,
        changeGiven: cash.change_given,
        paidIn: cash.paid_in,
        paidOut: cash.paid_out,
      },
      payments,
      movements: movementRows.map(({ movement, reasonName, entryNumber }) => {
        // A movement's entry is posted the moment it is written (openFromDevice): it has a number
        if (entryNumber === null) throw new Error(`Entry of movement ${movement.id} is a draft`);
        return {
          id: movement.id,
          reason: { id: movement.reasonId, name: reasonName },
          direction: movement.direction,
          amount: movement.amount,
          note: movement.note,
          date: movement.date,
          movedAt: movement.movedAt.toISOString(),
          accountId: movement.accountId,
          entry: { id: movement.entryId, number: entryNumber },
        };
      }),
    };
  }

  private async entryRefs(tx: Transaction, ids: readonly string[]): Promise<Map<string, EntryRef>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, getTenantId()), inArray(journalEntries.id, ids)));
    const refs = new Map<string, EntryRef>();
    for (const row of rows) {
      if (row.number !== null) refs.set(row.id, { id: row.id, number: row.number });
    }
    return refs;
  }
}
```

**The reads:**

- **`summaries()` works out the expected cash when it is read,** except for a counted shift (decisions 60 and 63). The
  `CASE` calls `pos_shift_cash()` for open shifts and for shifts closed without a count; a counted one has its number
  stored. The sales count and total are sub-selects on `pos_sales_shift_idx`; the total is cast to `numeric(19, 4)`, so
  no sales is `0.0000` (decision 64).
- **`cashOf()` casts every column to `numeric(19, 4)`** (decision 64): a sum over no rows is `coalesce(…, 0)`, a plain
  `0`.
- **`branchId` is the branch of the register's warehouse now,** like the sales list.
- **`difference` is worked out, never stored:** counted less expected, with the contract's `cashDifferenceOf()`.
- **`read()` builds the page from the summary,** so the list and the page can never disagree on a number.
- **The payments** (decision 61) are summed per method over the shift's sales, then listed in the contract's order:
  every method the register takes now, and any other one a sale was paid with (a register that dropped bKash still shows
  the bKash taken before).
- **`closing` is only for a counted close.** The checks on each column are for the type checker: the database's status
  check already makes them all present when the status is `closed`.
- **A movement's entry always has a number;** a draft there would be a bug, so it throws.
- **`entryRefs()` reads the opening and closing entries in one query.**

### `pos/pos-shifts.controller.ts` (new) and `pos.module.ts`

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PosCashReasonsService } from './pos-cash-reasons.service.js';
import { PosShiftsService } from './pos-shifts.service.js';

type Routes = typeof routes.posShifts;

// Step 20b. No route opens, moves cash in or closes a shift at the counter: those arrive as sync
// commands (decision 25). The managers read the shifts and close a stuck one here.
@Controller()
export class PosShiftsController {
  constructor(
    private readonly reasons: PosCashReasonsService,
    private readonly shifts: PosShiftsService,
  ) {}

  @Endpoint(routes.posShifts.listCashReasons)
  async listCashReasons({
    query,
  }: RouteInput<Routes['listCashReasons']>): Promise<RouteResponse<Routes['listCashReasons']>> {
    return { items: await this.reasons.list(query) };
  }

  @Endpoint(routes.posShifts.createCashReason)
  createCashReason({
    body,
  }: RouteInput<Routes['createCashReason']>): Promise<RouteResponse<Routes['createCashReason']>> {
    return this.reasons.create(body);
  }

  @Endpoint(routes.posShifts.updateCashReason)
  updateCashReason({
    params,
    body,
  }: RouteInput<Routes['updateCashReason']>): Promise<RouteResponse<Routes['updateCashReason']>> {
    return this.reasons.update(params.id, body);
  }

  @Endpoint(routes.posShifts.archiveCashReason)
  archiveCashReason({
    params,
    body,
  }: RouteInput<Routes['archiveCashReason']>): Promise<RouteResponse<Routes['archiveCashReason']>> {
    return this.reasons.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.posShifts.restoreCashReason)
  restoreCashReason({
    params,
    body,
  }: RouteInput<Routes['restoreCashReason']>): Promise<RouteResponse<Routes['restoreCashReason']>> {
    return this.reasons.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.posShifts.listShifts)
  listShifts({
    query,
  }: RouteInput<Routes['listShifts']>): Promise<RouteResponse<Routes['listShifts']>> {
    return this.shifts.list(query);
  }

  @Endpoint(routes.posShifts.getShift)
  getShift({ params }: RouteInput<Routes['getShift']>): Promise<RouteResponse<Routes['getShift']>> {
    return this.shifts.get(params.id);
  }

  @Endpoint(routes.posShifts.closeWithoutCount)
  closeWithoutCount({
    params,
    body,
  }: RouteInput<Routes['closeWithoutCount']>): Promise<RouteResponse<Routes['closeWithoutCount']>> {
    return this.shifts.closeWithoutCount(params.id, body);
  }
}
```

- **One method per route of `posShiftRoutes`,** typed from the contract like every controller. `@Endpoint` checks the
  permission each route names (`pos.register.manage` for the reasons' changes, `pos.shift.manage` for the shifts).
- **No route opens or closes a shift at the counter** (decision 25). Those are sync commands only.

```diff
@@ -1,19 +1,27 @@
 import { Module } from '@nestjs/common';
 
 import { InventoryModule } from '../inventory/inventory.module.js';
+import { JournalModule } from '../journal/journal.module.js';
 import { PosController } from './pos.controller.js';
+import { PosCashReasonsService } from './pos-cash-reasons.service.js';
 import { PosRegistersService } from './pos-registers.service.js';
 import { PosSalesService } from './pos-sales.service.js';
+import { PosShiftsController } from './pos-shifts.controller.js';
+import { PosShiftsService } from './pos-shifts.service.js';
 
 // Step 20a: the point of sale. InventoryModule gives a sale what every stock document uses:
 // StockPostingService moves the stock (planSale() first, decision 15), StockBooksService books
 // the sale and its cost in one entry. PosSalesService is exported for the sync's push, which is
 // the only place a sale is written (SyncModule imports this module). The "Sold short" bell's
 // worker half (sold-short.handler.ts) is wired in worker/worker.module.ts, like every handler.
+// Step 20b: the shifts and the pay in / pay out reasons. A shift's entries touch only money, so
+// PosShiftsService posts them with the journal's PostingService (JournalModule). It is exported
+// for the push too, which writes a shift's three commands; the variance bell's handler is wired
+// in the worker like the sold-short one.
 @Module({
-  imports: [InventoryModule],
-  controllers: [PosController],
-  providers: [PosRegistersService, PosSalesService],
-  exports: [PosSalesService],
+  imports: [InventoryModule, JournalModule],
+  controllers: [PosController, PosShiftsController],
+  providers: [PosRegistersService, PosSalesService, PosCashReasonsService, PosShiftsService],
+  exports: [PosSalesService, PosShiftsService],
 })
 export class PosModule {}
```

- **`JournalModule` gives `PostingService`.** A shift's entries touch only money, so they do not go through
  `StockBooksService`.
- **`PosShiftsService` is exported** for the push, which lives in `SyncModule` and imports this module already.

### `pos/pos-registers.service.ts`: the three fields, the latest shift, the release

```diff
@@ -3,6 +3,7 @@ import {
   type ErrorCode,
   moneyAccountIds,
   POS_PAYMENT_METHODS,
+  type PosLastShift,
   type PosPaymentMethod,
   type PosRegister,
   type PosRegisterInput,
@@ -11,8 +12,8 @@ import {
   type SyncPosRegister,
   type UpdatePosRegisterInput,
 } from '@omnivo/contracts';
-import { devices, ledgerAccounts, posRegisters, users, warehouses } from '@omnivo/db';
-import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
+import { devices, ledgerAccounts, posRegisters, posShifts, users, warehouses } from '@omnivo/db';
+import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../common/audit/audit.js';
 import { isCheckViolation, isUniqueViolation } from '../common/db/pg-errors.js';
@@ -20,7 +21,7 @@ import { AppError, notFound, versionConflict } from '../common/http/app-error.js
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
-import { deviceNotFound, deviceRevoked } from '../sync/devices.service.js';
+import { deviceNotFound, deviceRevoked, shiftStillOpen } from '../sync/devices.service.js';
 
 export type PosRegisterRow = typeof posRegisters.$inferSelect;
 
@@ -38,8 +39,13 @@ export function accountOf(row: PosRegisterRow, method: PosPaymentMethod): string
 }
 
 // A register as the devices keep it (decision 20): without the last number, which changes with
-// every sale. branchId is the warehouse's (decision 17): the caller reads it with the row.
-export function toSyncPosRegister(row: PosRegisterRow, branchId: string): SyncPosRegister {
+// every sale. branchId is the warehouse's (decision 17): the caller reads it with the row, and
+// since step 20b its latest shift too (lastShiftsOf).
+export function toSyncPosRegister(
+  row: PosRegisterRow,
+  branchId: string,
+  lastShift: PosLastShift | null,
+): SyncPosRegister {
   return {
     id: row.id,
     code: row.code,
@@ -55,15 +61,69 @@ export function toSyncPosRegister(row: PosRegisterRow, branchId: string): SyncPo
     maxDiscountPercent: row.maxDiscountPercent,
     paperWidth: row.paperWidth,
     receiptFooter: row.receiptFooter,
+    overShortAccountId: row.overShortAccountId,
+    varianceAlert: row.varianceAlert,
+    lockAfter: row.lockAfter,
     deviceId: row.deviceId,
+    lastShift,
     archivedAt: row.archivedAt?.toISOString() ?? null,
     version: row.version,
     updatedAt: row.updatedAt.toISOString(),
   };
 }
 
-export function toPosRegister(row: PosRegisterRow, branchId: string): PosRegister {
-  return { ...toSyncPosRegister(row, branchId), lastNumber: row.lastNumber };
+export function toPosRegister(
+  row: PosRegisterRow,
+  branchId: string,
+  lastShift: PosLastShift | null,
+): PosRegister {
+  return { ...toSyncPosRegister(row, branchId, lastShift), lastNumber: row.lastNumber };
+}
+
+// Step 20b (decision 36): each register's latest shift, by the highest sequence, read and not
+// stored. DISTINCT ON keeps the first row of each register in the ORDER BY, which
+// pos_shifts_register_sequence_idx reads backwards. cashLeft is what should be in the drawer now:
+// what the cashier counted at the close, or, when nobody counted, what the server expects now with
+// the sales that came after that close (decision 63).
+export async function lastShiftsOf(
+  tx: Transaction,
+  registerIds: readonly string[],
+): Promise<Map<string, PosLastShift>> {
+  if (registerIds.length === 0) return new Map();
+  const rows = await tx
+    .selectDistinctOn([posShifts.registerId], {
+      registerId: posShifts.registerId,
+      id: posShifts.id,
+      sequence: posShifts.sequence,
+      status: posShifts.status,
+      countedCash: posShifts.countedCash,
+      expectedNow: sql<string | null>`CASE WHEN ${posShifts.status} = 'closed_without_count'
+        THEN (SELECT c.expected::text FROM pos_shift_cash(${posShifts.tenantId}, ${posShifts.id}) c)
+        END`,
+    })
+    .from(posShifts)
+    .where(and(eq(posShifts.tenantId, getTenantId()), inArray(posShifts.registerId, registerIds)))
+    .orderBy(posShifts.registerId, desc(posShifts.sequence));
+  return new Map(
+    rows.map((row) => [
+      row.registerId,
+      {
+        id: row.id,
+        sequence: row.sequence,
+        status: row.status,
+        cashLeft:
+          row.status === 'closed'
+            ? row.countedCash
+            : row.status === 'closed_without_count'
+              ? row.expectedNow
+              : null,
+      },
+    ]),
+  );
+}
+
+async function lastShiftOf(tx: Transaction, registerId: string): Promise<PosLastShift | null> {
+  return (await lastShiftsOf(tx, [registerId])).get(registerId) ?? null;
 }
 
 // What the audit log shows of a register's form: the warehouse by its code, the accounts by
@@ -156,8 +216,12 @@ export class PosRegistersService {
           ),
         )
         .orderBy(asc(posRegisters.code));
+      const lastShifts = await lastShiftsOf(
+        tx,
+        rows.map((row) => row.register.id),
+      );
       return rows.map((row) => ({
-        ...toPosRegister(row.register, row.branchId),
+        ...toPosRegister(row.register, row.branchId, lastShifts.get(row.register.id) ?? null),
         holder:
           row.deviceName === null || row.userName === null
             ? null
@@ -169,7 +233,7 @@ export class PosRegistersService {
   get(id: string): Promise<PosRegister> {
     return this.withTenant(async (tx) => {
       const row = await this.find(tx, id);
-      return toPosRegister(row, await this.branchOf(tx, row.warehouseId));
+      return this.answer(tx, row, await this.branchOf(tx, row.warehouseId));
     });
   }
 
@@ -178,6 +242,7 @@ export class PosRegistersService {
       return await this.withTenant(async (tx) => {
         const warehouse = await this.activeWarehouse(tx, input.warehouseId);
         await this.checkAccounts(tx, input.accounts);
+        await this.checkOverShort(tx, input.overShortAccountId);
         const [row] = await tx
           .insert(posRegisters)
           .values({
@@ -189,6 +254,7 @@ export class PosRegistersService {
             maxDiscountPercent: input.maxDiscountPercent,
             paperWidth: input.paperWidth,
             receiptFooter: input.receiptFooter,
+            ...this.shiftColumns(input),
             createdBy: currentPrincipal().userId,
             updatedBy: currentPrincipal().userId,
           })
@@ -200,7 +266,8 @@ export class PosRegistersService {
           entityId: row.id,
           changes: created({ code: row.code, ...(await this.snapshot(tx, row)) }),
         });
-        return toPosRegister(row, warehouse.branchId);
+        // A new register has had no shift
+        return toPosRegister(row, warehouse.branchId, null);
       });
     } catch (error) {
       throw databaseError(error);
@@ -226,6 +293,7 @@ export class PosRegistersService {
           throw wrongBranch();
         }
         await this.checkAccounts(tx, input.accounts);
+        await this.checkOverShort(tx, input.overShortAccountId);
         const [after] = await tx
           .update(posRegisters)
           .set({
@@ -235,6 +303,7 @@ export class PosRegistersService {
             maxDiscountPercent: input.maxDiscountPercent,
             paperWidth: input.paperWidth,
             receiptFooter: input.receiptFooter,
+            ...this.shiftColumns(input),
             version: sql`${posRegisters.version} + 1`,
             updatedBy: currentPrincipal().userId,
           })
@@ -247,7 +316,7 @@ export class PosRegistersService {
           entityId: id,
           changes: diff(await this.snapshot(tx, before), await this.snapshot(tx, after)),
         });
-        return toPosRegister(after, warehouse.branchId);
+        return this.answer(tx, after, warehouse.branchId);
       });
     } catch (error) {
       throw databaseError(error);
@@ -260,7 +329,7 @@ export class PosRegistersService {
         const before = await this.lock(tx, id);
         if (before.version !== version) throw versionConflict();
         if ((before.archivedAt !== null) === archived) {
-          return toPosRegister(before, await this.branchOf(tx, before.warehouseId));
+          return this.answer(tx, before, await this.branchOf(tx, before.warehouseId));
         }
         // Decision 33: only the device knows whether a sale of it still waits in its outbox
         if (archived && before.deviceId !== null) throw inUse();
@@ -283,7 +352,7 @@ export class PosRegistersService {
           entityType: 'pos_register',
           entityId: id,
         });
-        return toPosRegister(after, branchId);
+        return this.answer(tx, after, branchId);
       });
     } catch (error) {
       throw databaseError(error);
@@ -301,7 +370,7 @@ export class PosRegistersService {
         const device = await this.ownDevice(tx, deviceId);
         const before = await this.lock(tx, id);
         const branchId = await this.branchOf(tx, before.warehouseId);
-        if (before.deviceId === device.id) return toPosRegister(before, branchId);
+        if (before.deviceId === device.id) return this.answer(tx, before, branchId);
         if (before.archivedAt !== null) {
           throw new AppError(409, 'pos_register_archived', 'This register is archived.');
         }
@@ -327,7 +396,9 @@ export class PosRegistersService {
           entityId: id,
           changes: { device: { from: null, to: device.name } },
         });
-        return toPosRegister(after, branchId);
+        // Step 20b (decision 17): with its latest shift, so the device numbers its first shift on
+        // from it and compares the opening count with what it left
+        return this.answer(tx, after, branchId);
       });
     } catch (error) {
       throw databaseError(error);
@@ -337,15 +408,20 @@ export class PosRegistersService {
   // The device lets go of its register: the app calls it at sign-out, after it checked that no
   // sale of the register waits in its outbox (decision 32). A register that is free already
   // answers as it is (a release sent again); one another device holds is not this device's to free.
+  // Step 20b (decision 32): not while a shift is open on it. The sign-out itself does not reach the
+  // server for this: the app lets go of the register first, so this refusal stops the sign-out.
   release(id: string, deviceId: string): Promise<PosRegister> {
     return this.withTenant(async (tx) => {
       const device = await this.ownDevice(tx, deviceId);
       const before = await this.lock(tx, id);
       const branchId = await this.branchOf(tx, before.warehouseId);
-      if (before.deviceId === null) return toPosRegister(before, branchId);
+      if (before.deviceId === null) return this.answer(tx, before, branchId);
       if (before.deviceId !== device.id) {
         throw new AppError(409, 'pos_register_not_held', 'This device does not hold the register.');
       }
+      // The register is locked FOR UPDATE: a shift that opens now waits (0054's guard), then finds
+      // the register free and is refused
+      if ((await lastShiftOf(tx, id))?.status === 'open') throw shiftStillOpen();
       const after = await this.setHolder(tx, id, null);
       await audit(tx, {
         action: 'pos_register.released',
@@ -353,10 +429,19 @@ export class PosRegistersService {
         entityId: id,
         changes: { device: { from: device.name, to: null } },
       });
-      return toPosRegister(after, branchId);
+      return this.answer(tx, after, branchId);
     });
   }
 
+  // The register as the API answers it, with its latest shift
+  private async answer(
+    tx: Transaction,
+    row: PosRegisterRow,
+    branchId: string,
+  ): Promise<PosRegister> {
+    return toPosRegister(row, branchId, await lastShiftOf(tx, row.id));
+  }
+
   // No version: see the class's comment
   private async setHolder(
     tx: Transaction,
@@ -496,6 +581,41 @@ export class PosRegistersService {
       .for('share');
   }
 
+  // Step 20b (decision 13): where a difference in the cash count goes. An active income or expense
+  // account that is not a group: a difference is a gain or a loss of the shop, never money kept
+  // somewhere. FOR SHARE like the payment accounts. One answer for every reason it is not usable.
+  private async checkOverShort(tx: Transaction, id: string): Promise<void> {
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
+      (account.type !== 'income' && account.type !== 'expense')
+    ) {
+      throw fieldError(
+        'pos_over_short_invalid',
+        'overShortAccountId',
+        'Pick an active income or expense account.',
+      );
+    }
+  }
+
+  private shiftColumns(input: PosRegisterInput | UpdatePosRegisterInput) {
+    return {
+      overShortAccountId: input.overShortAccountId,
+      varianceAlert: input.varianceAlert,
+      lockAfter: input.lockAfter,
+    };
+  }
+
   private accountColumns(accounts: PosRegisterInput['accounts']) {
     return {
       cashAccountId: accounts.cash,
@@ -506,10 +626,13 @@ export class PosRegistersService {
   }
 
   private async snapshot(tx: Transaction, row: PosRegisterRow): Promise<Snapshot> {
-    const ids = POS_PAYMENT_METHODS.flatMap((method) => {
-      const id = accountOf(row, method);
-      return id === null ? [] : [id];
-    });
+    const ids = [
+      ...POS_PAYMENT_METHODS.flatMap((method) => {
+        const id = accountOf(row, method);
+        return id === null ? [] : [id];
+      }),
+      ...(row.overShortAccountId === null ? [] : [row.overShortAccountId]),
+    ];
     const codes = new Map(
       (
         await tx
@@ -536,6 +659,10 @@ export class PosRegistersService {
       maxDiscountPercent: row.maxDiscountPercent,
       paperWidth: row.paperWidth,
       receiptFooter: row.receiptFooter,
+      overShortAccount:
+        row.overShortAccountId === null ? null : (codes.get(row.overShortAccountId) ?? null),
+      varianceAlert: row.varianceAlert,
+      lockAfter: row.lockAfter,
     };
   }
 }
```

- **`toSyncPosRegister()` and `toPosRegister()` take the latest shift as an argument.** The row does not have it
  (decision 36), and the pull reads it for a whole page in one query; a read per register would be a query per row.
- **`lastShiftsOf()` uses `DISTINCT ON (register_id)` with `ORDER BY register_id, sequence DESC`:** Postgres keeps the
  first row of each register, which is its highest sequence. `cashLeft` follows decisions 17 and 63: for a shift closed
  without a count, the `CASE` runs `pos_shift_cash()` on that one row, so a late sale counts. The device's copy of the
  register is not sent again for a late sale (nothing logs the register), but the claim reads it fresh, and the server
  compares the opening with its own number anyway.
- **`answer()` is the one way the service answers a register,** so every route (get, update, archive, claim, release)
  carries `lastShift`. The claim needs it most: the device numbers its first shift on from it and compares its opening
  count with `cashLeft`.
- **`checkOverShort()`** is decision 45, with one answer under `overShortAccountId`. Like the payment accounts, it is
  checked on every save, so a register from 20a gets its account the first time someone saves it.
- **The release is refused while a shift is open** (decision 32). The register is locked `FOR UPDATE` first: a shift that
  opens at that moment waits for 0054's guard, then finds the register free and is refused. So the check before the
  update is enough; the database's `pos_registers_shift_open` is the last word for any path that forgets it.
- **The audit snapshot gets the three fields,** the account by its code.
- **`shiftStillOpen()` comes from `sync/devices.service.ts`:** this file imports that one already, and the device's
  move needs the same error.

### `pos/pos-sales.service.ts`: the sale's shift

```diff
@@ -16,7 +16,6 @@ import {
   posChangeOf,
   type SoldShortItem,
   sumMoney,
-  todayIn,
   wholeCount,
 } from '@omnivo/contracts';
 import {
@@ -27,7 +26,7 @@ import {
   posSaleLines,
   posSalePayments,
   posSales,
-  tenantSettings,
+  posShifts,
   users,
   warehouses,
 } from '@omnivo/db';
@@ -49,7 +48,6 @@ import {
   type SalePlan,
   StockPostingService,
 } from '../inventory/stock-posting.service.js';
-import { firstOpenDay } from '../journal/period-lock.service.js';
 import type { Access } from '../rbac/permission.service.js';
 import {
   assertCustomer,
@@ -60,7 +58,9 @@ import {
   toSalesLine,
   withVariants,
 } from '../sales/sales-lines.js';
+import { bookingDay } from './booking-day.js';
 import { accountOf } from './pos-registers.service.js';
+import { deviceShift } from './pos-shifts.service.js';
 
 type SaleRow = typeof posSales.$inferSelect;
 
@@ -147,6 +147,12 @@ export class PosSalesService {
     // bug or a register of another workspace
     if (register?.deviceId !== deviceId) throw notHeld();
     const number = formatPosNumber(register.code, input.sequence);
+    // Step 20b: the shift it was sold in, of this register and this device (pos_sales_shift_fk
+    // says the same; this answers it as a refusal instead of a database error). A shift closed
+    // since still takes it: a sale is never refused (decision 39). null: a sale from before 20b.
+    if (input.shiftId !== null) {
+      await deviceShift(tx, input.shiftId, deviceId, register.id);
+    }
 
     // The register's account for each method now: the money goes where the register says today
     const issues: LineIssue[] = [];
@@ -189,21 +195,15 @@ export class PosSalesService {
     const paid = sumMoney(input.payments.map((payment) => payment.amount));
     const change = posChangeOf(input.payments, amounts.totals.total);
 
-    // Decision 26: on the device's day, unless the device's clock is ahead of the server's today,
-    // or the books are closed for that day: then on the first day they take
-    const [settings] = await tx
-      .select({ timezone: tenantSettings.timezone })
-      .from(tenantSettings)
-      .where(eq(tenantSettings.tenantId, tenantId));
-    if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
-    const today = todayIn(settings.timezone);
-    const date = await firstOpenDay(tx, input.date > today ? today : input.date);
+    // Decision 26: on the device's day, or the first day the books take
+    const date = await bookingDay(tx, input.date);
 
     try {
       await tx.insert(posSales).values({
         id: saleId,
         tenantId,
         registerId: register.id,
+        shiftId: input.shiftId,
         sequence: input.sequence,
         number,
         date,
@@ -670,6 +670,7 @@ export class PosSalesService {
       .select({
         sale: posSales,
         register: { id: posRegisters.id, code: posRegisters.code, name: posRegisters.name },
+        shiftNumber: posShifts.number,
         branchId: warehouses.branchId,
         cashierName: users.fullName,
         lineCount: sql<number>`(SELECT count(*)::int FROM pos_sale_lines l
@@ -687,6 +688,10 @@ export class PosSalesService {
         warehouses,
         and(eq(warehouses.tenantId, posSales.tenantId), eq(warehouses.id, posSales.warehouseId)),
       )
+      .leftJoin(
+        posShifts,
+        and(eq(posShifts.tenantId, posSales.tenantId), eq(posShifts.id, posSales.shiftId)),
+      )
       .leftJoin(users, eq(users.id, posSales.createdBy))
       .where(and(eq(posSales.tenantId, getTenantId()), where))
       .orderBy(desc(posSales.date), desc(posSales.id))
@@ -703,6 +708,7 @@ function toSummary(
   row: {
     sale: SaleRow;
     register: { id: string; code: string; name: string };
+    shiftNumber: string | null;
     branchId: string;
     cashierName: string | null;
     lineCount: number;
@@ -717,6 +723,10 @@ function toSummary(
     id: sale.id,
     number: sale.number,
     register: row.register,
+    shift:
+      sale.shiftId === null || row.shiftNumber === null
+        ? null
+        : { id: sale.shiftId, number: row.shiftNumber },
     branchId: row.branchId,
     warehouseId: sale.warehouseId,
     date: sale.date,
```

- **The shift is checked after the register** (decision 48), with `deviceShift()`: of this device and this register,
  locked `FOR SHARE`. A closed shift still takes the sale (decision 39). A sale with `shiftId: null` (one made before
  20b, still in an outbox) skips the check.
- **`bookingDay()` replaces the inline code** (decision 58); the behaviour is the same.
- **The summary joins the shift for its number.** A left join: a sale from 20a has none.

### `sync/sync-push.service.ts`: the three commands

```diff
@@ -27,6 +27,7 @@ import { getTenantId, runFromDevice } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { PosSalesService } from '../pos/pos-sales.service.js';
+import { PosShiftsService } from '../pos/pos-shifts.service.js';
 import { type Access, PermissionService } from '../rbac/permission.service.js';
 import { CustomersService } from '../sales/customers.service.js';
 import { SalesOrdersService } from '../sales/sales-orders.service.js';
@@ -45,8 +46,22 @@ const PERMISSION_OF = {
   // Step 20a: no route writes a sale (decision 21), so the cashier's permission comes from the
   // route that takes a register, which is the same one (decision 31)
   'pos_sale.create': routes.pos.claimRegister.permission,
+  // Step 20b (decision 10): the cashier's own shift, with the same permission
+  'pos_shift.open': routes.pos.claimRegister.permission,
+  'pos_cash_movement.create': routes.pos.claimRegister.permission,
+  'pos_shift.close': routes.pos.claimRegister.permission,
 } satisfies Record<SyncCommandType, PermissionKey>;
 
+// Step 20a (decision 28), step 20b (decision 25): never refused for the permission. The money is
+// in the drawer (and the goods have left), so a refusal would only leave it out of the books; each
+// writes its own audit row instead.
+const DONE_AT_THE_COUNTER: ReadonlySet<SyncCommandType> = new Set([
+  'pos_sale.create',
+  'pos_shift.open',
+  'pos_cash_movement.create',
+  'pos_shift.close',
+]);
+
 // The ids a device makes (decision 12). One already used — in this workspace or another, the
 // primary keys are global — fails the insert on its primary key, and the command is refused.
 const DEVICE_ID_KEYS = [
@@ -54,20 +69,29 @@ const DEVICE_ID_KEYS = [
   'party_addresses_pkey',
   'sales_orders_pkey',
   'pos_sales_pkey',
+  'pos_shifts_pkey',
+  'pos_cash_movements_pkey',
 ] as const;
 
 function isSyncCommandType(type: string): type is SyncCommandType {
   return SYNC_COMMAND_TYPES.some((known) => known === type);
 }
 
-// The customer, the order or the POS sale a command is about: the answer's entity_id
+// The customer, the order, the POS sale, the shift or the pay in / pay out a command is about:
+// the answer's entity_id
 function entityOf(command: SyncCommand): string {
   switch (command.type) {
     case 'sales_order.create_draft':
       return command.orderId;
     case 'pos_sale.create':
       return command.saleId;
-    default:
+    case 'pos_shift.open':
+    case 'pos_shift.close':
+      return command.shiftId;
+    case 'pos_cash_movement.create':
+      return command.movementId;
+    case 'customer.create':
+    case 'customer.update':
       return command.customerId;
   }
 }
@@ -89,6 +113,7 @@ export class SyncPushService {
     private readonly customers: CustomersService,
     private readonly orders: SalesOrdersService,
     private readonly posSales: PosSalesService,
+    private readonly posShifts: PosShiftsService,
   ) {}
 
   async push(input: z.output<typeof syncPushInputSchema>): Promise<SyncPush> {
@@ -175,10 +200,7 @@ export class SyncPushService {
     command: SyncCommand,
   ): Promise<SyncNotice[]> {
     const permission = PERMISSION_OF[command.type];
-    // Step 20a (decision 28): a POS sale is never refused for it. The money is in the drawer and
-    // the goods have left, so refusing would only leave them out of the books; the sale writes
-    // its own audit row instead.
-    if (!access.permissions.includes(permission) && command.type !== 'pos_sale.create') {
+    if (!access.permissions.includes(permission) && !DONE_AT_THE_COUNTER.has(command.type)) {
       throw new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
         params: { permissions: permission },
       });
@@ -195,6 +217,15 @@ export class SyncPushService {
       case 'pos_sale.create':
         await this.posSales.createFromDevice(tx, access, command.saleId, command.input);
         return [];
+      case 'pos_shift.open':
+        await this.posShifts.openFromDevice(tx, access, command.shiftId, command.input);
+        return [];
+      case 'pos_cash_movement.create':
+        await this.posShifts.moveCashFromDevice(tx, access, command.movementId, command.input);
+        return [];
+      case 'pos_shift.close':
+        await this.posShifts.closeFromDevice(tx, access, command.shiftId, command.input);
+        return [];
     }
   }
 
@@ -229,14 +260,15 @@ export class SyncPushService {
 
   // The customer a command made or changed, in the pull's shape: the device writes it at once. A
   // customer the device may not keep (archived since) goes as a delete, like in a delta pull. An
-  // order and a POS sale send nothing: neither is on the device (decision 35).
+  // order, a POS sale and a shift's commands send nothing: none is on the device as a row
+  // (decision 35; step 20b, decision 30: the register's new lastShift comes with the next pull).
   private async changesOf(
     tx: Transaction,
     device: DeviceRow,
     type: SyncCommandType,
     entityId: string,
   ): Promise<SyncChange[]> {
-    if (type === 'sales_order.create_draft' || type === 'pos_sale.create') return [];
+    if (type !== 'customer.create' && type !== 'customer.update') return [];
     // The customer loader reads only the tenant; the branch's warehouses do not matter to it
     const scope = { tenantId: getTenantId(), branchId: device.branchId, warehouseIds: [] };
     const rows = await LOADERS.customer(tx, scope, { by: 'keys', keys: [entityId] });
```

- **The three commands need `pos.sale.create`** (decision 10), read from the same route as the sale's, so the two can
  never part.
- **`DONE_AT_THE_COUNTER` replaces the single `pos_sale.create` test:** four commands are now never refused for the
  permission. A set keeps the `if` readable.
- **`entityOf()` names every command type** instead of a `default`. A new command type then fails the type check here
  (the function must return), instead of quietly answering with a customer id it does not have.
- **The shift's and the movement's primary keys join `DEVICE_ID_KEYS`:** an id the device made that is used already is
  `sync_id_taken`, like a sale's.
- **`changesOf()` sends rows only for the two customer commands** (decision 30): the shift's commands change no row the
  device keeps as it is; the register's `lastShift` comes with the next pull, logged by 0054.

### `sync/sync-rows.ts`: the reasons and the latest shift in the pull

```diff
@@ -10,6 +10,7 @@ import {
 import {
   customerGroups,
   parties,
+  posCashReasons,
   posRegisters,
   priceLists,
   productCategories,
@@ -26,7 +27,8 @@ import { z } from 'zod';
 
 import type { Transaction } from '../common/tenant/with-tenant.js';
 import { toWarehouse } from '../inventory/warehouses.service.js';
-import { toSyncPosRegister } from '../pos/pos-registers.service.js';
+import { toPosCashReason } from '../pos/pos-cash-reasons.service.js';
+import { lastShiftsOf, toSyncPosRegister } from '../pos/pos-registers.service.js';
 import { productsOf } from '../products/product-read.js';
 import { toUnit } from '../products/units.service.js';
 import { customersOf } from '../sales/customer-read.js';
@@ -113,7 +115,9 @@ const stockRowSchema = z.object({
 //   price_list_item     its product active and its list active (decision 27)
 //   customer            a customer (not only a supplier), active
 //   stock               in an active warehouse of the branch, not zero, its product active
-//   pos_register        active, its warehouse in the device's branch (step 20a)
+//   pos_register        active, its warehouse in the device's branch (step 20a), with its latest
+//                       shift (step 20b)
+//   pos_cash_reason     active, all of them (step 20b): a reason belongs to no branch
 export const LOADERS: Record<SyncEntity, Loader> = {
   // One row, keyed by the workspace's id (the contract's settings key)
   settings: async (tx, scope, pick) => {
@@ -227,7 +231,8 @@ export const LOADERS: Record<SyncEntity, Loader> = {
   // Step 20a (decision 20): the registers of the branch, active ones, without the last number. The
   // branch is the warehouse's, so the join decides it: a register whose warehouse moved to another
   // branch drops out here (0052 logs it). Its warehouse may be archived: the register still is the
-  // branch's, and the device keeps it.
+  // branch's, and the device keeps it. Step 20b (decision 36): with its latest shift, read for the
+  // page's registers in one query; a shift that opens or closes logs its register (0054).
   pos_register: async (tx, scope, pick) => {
     const { where, limit } = byId(posRegisters.id, pick);
     const rows = await tx
@@ -250,17 +255,42 @@ export const LOADERS: Record<SyncEntity, Loader> = {
       )
       .orderBy(asc(posRegisters.id))
       .limit(limit);
+    const lastShifts = await lastShiftsOf(
+      tx,
+      rows.map((row) => row.register.id),
+    );
     return rows.map((row) => ({
       sort: [row.register.id],
       change: {
         op: 'upsert',
         entity: 'pos_register',
         key: row.register.id,
-        data: toSyncPosRegister(row.register, row.branchId),
+        data: toSyncPosRegister(
+          row.register,
+          row.branchId,
+          lastShifts.get(row.register.id) ?? null,
+        ),
       },
     }));
   },
 
+  // Step 20b (decision 20): every active reason; an archived one is a delete (0054 logs it)
+  pos_cash_reason: async (tx, scope, pick) => {
+    const { where, limit } = byId(posCashReasons.id, pick);
+    const rows = await tx
+      .select()
+      .from(posCashReasons)
+      .where(
+        and(eq(posCashReasons.tenantId, scope.tenantId), isNull(posCashReasons.archivedAt), where),
+      )
+      .orderBy(asc(posCashReasons.id))
+      .limit(limit);
+    return rows.map((row) => ({
+      sort: [row.id],
+      change: { op: 'upsert', entity: 'pos_cash_reason', key: row.id, data: toPosCashReason(row) },
+    }));
+  },
+
   // Without itemCount and customerCount (decision 15)
   price_list: async (tx, scope, pick) => {
     const { where, limit } = byId(priceLists.id, pick);
```

- **The register loader reads the latest shifts of its page in one query** (`lastShiftsOf()`).
- **The reason loader sends the active reasons of the workspace,** with no branch filter (decision 20). An archived one is
  missing from the answer, so a delta pull sends it as a delete: 0054 logs every change of a reason.

### `sync/devices.service.ts` and `sync/device-revoke.ts`: the move and the revoke

```diff
@@ -11,7 +11,7 @@ import type {
   RegisterDeviceInput,
   RenameDeviceInput,
 } from '@omnivo/contracts';
-import { branches, devices, users } from '@omnivo/db';
+import { branches, devices, posShifts, users } from '@omnivo/db';
 import { and, asc, desc, eq, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
 import { alias } from 'drizzle-orm/pg-core';
 import { z } from 'zod';
@@ -58,6 +58,16 @@ export function deviceRevoked(): AppError {
   return new AppError(403, 'device_revoked', 'This device was revoked. Its data is wiped.');
 }
 
+// Step 20b (decision 32): the device that runs a shift keeps its register, and its branch, until
+// the shift closes. Here and not in pos/: the POS services import this file already.
+export function shiftStillOpen(): AppError {
+  return new AppError(
+    409,
+    'pos_shift_still_open',
+    'A shift is open on this register. Close the shift first.',
+  );
+}
+
 // Step 18c: the person who revoked a device, next to the person it belongs to (both in users)
 const revoker = alias(users, 'revoker');
 
@@ -333,6 +343,19 @@ export class DevicesService {
       if (before.version !== input.version) throw versionConflict();
       // The branch it is in already: nothing changes, no audit row (decision 10)
       if (before.branchId === input.branchId) return this.item(tx, id);
+      // Step 20b (decision 32): a device that runs a shift stays where its register is. The
+      // device is locked, so no shift opens on it before we commit (0054's guard waits for it).
+      const [open] = await tx
+        .select({ id: posShifts.id })
+        .from(posShifts)
+        .where(
+          and(
+            eq(posShifts.tenantId, getTenantId()),
+            eq(posShifts.deviceId, id),
+            eq(posShifts.status, 'open'),
+          ),
+        );
+      if (open) throw shiftStillOpen();
 
       // FOR SHARE on the new branch, like registering: an archive of it waits for this commit,
       // and then sees the device in it (branch_has_devices)
```

- **The move checks for an open shift after locking the device** (decision 53). 0054's shift guard locks the device too,
  so a shift cannot open between the check and the update. Without the check, the move would fail on 0052's release of
  the register, with a database error instead of `pos_shift_still_open`.
- **`shiftStillOpen()` lives here,** not in `pos/`: the POS services import this file, and an import back would be a
  cycle.

```diff
@@ -1,7 +1,7 @@
-import { devices, sessions } from '@omnivo/db';
+import { devices, posShifts, sessions } from '@omnivo/db';
 import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
 
-import { audit } from '../common/audit/audit.js';
+import { audit, created } from '../common/audit/audit.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction } from '../common/tenant/with-tenant.js';
 
@@ -18,6 +18,18 @@ export async function revokeDevices(tx: Transaction, rows: readonly DeviceRow[])
   const revokedBy = currentPrincipal().userId;
   const ended: string[] = [];
   for (const row of rows) {
+    // Step 20b (decision 11): the database closes the device's open shift without a count in the
+    // same update (0054). Read it before, so the audit log can say so after.
+    const [open] = await tx
+      .select({ id: posShifts.id, number: posShifts.number })
+      .from(posShifts)
+      .where(
+        and(
+          eq(posShifts.tenantId, getTenantId()),
+          eq(posShifts.deviceId, row.id),
+          eq(posShifts.status, 'open'),
+        ),
+      );
     // revoked_at IS NULL: a device revoked already keeps who and when (migration 0048 refuses a
     // change anyway). A plain update, so version and updated_at move like any other change.
     // Step 19b: the device's key goes in the same update, for good. The server can then never
@@ -43,6 +55,23 @@ export async function revokeDevices(tx: Transaction, rows: readonly DeviceRow[])
       entityId: row.id,
       changes: { revokedAt: { from: null, to: after.revokedAt.toISOString() } },
     });
+    if (open) {
+      const [closed] = await tx
+        .select({ expectedCash: posShifts.expectedCash })
+        .from(posShifts)
+        .where(and(eq(posShifts.tenantId, getTenantId()), eq(posShifts.id, open.id)));
+      await audit(tx, {
+        action: 'pos_shift.closed_without_count',
+        entityType: 'pos_shift',
+        entityId: open.id,
+        changes: created({
+          number: open.number,
+          expected: closed?.expectedCash ?? null,
+          by: 'revoke',
+          device: row.name,
+        }),
+      });
+    }
   }
   // The sign-in of that browser ends with the revoke, in the same transaction: its refresh tokens
   // go with it (ON DELETE CASCADE), so the browser cannot get a new access token. The one it has
```

- **The open shift is read before the revoke's update,** because the update's trigger closes it (decision 55). The
  expected cash is read after it, when the trigger has written it.
- **`MembersService.remove()` gets this for free:** it revokes through the same function.

### The bell: `pos/shift-variance.handler.ts` (new) and its wiring

```ts
import { Inject, Injectable } from '@nestjs/common';
import { cashDifferenceOf } from '@omnivo/contracts';
import {
  membershipRoles,
  memberships,
  permissions,
  posRegisters,
  posShifts,
  rolePermissions,
  roles,
} from '@omnivo/db';
import { and, eq, isNull, or } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "POS1-S0042 at Front counter was ৳520 short" in the bell of the owners and of everyone with
// pos.shift.manage (step 20b, decision 29). The bell opens the shift. Like SoldShortHandler: it
// reads the shift when it runs, and the event id is each notification's key, so a second run of
// the job adds nothing. The close decided that the difference is over the limit; a closed shift
// never changes, so the numbers here are the ones it decided on.
@Injectable()
export class ShiftVarianceHandler implements EventHandler<'pos.shift_variance'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'pos.shift_variance'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [shift] = await tx
        .select({
          id: posShifts.id,
          number: posShifts.number,
          register: posRegisters.name,
          countedCash: posShifts.countedCash,
          expectedCash: posShifts.expectedCash,
        })
        .from(posShifts)
        .innerJoin(
          posRegisters,
          and(
            eq(posRegisters.tenantId, posShifts.tenantId),
            eq(posRegisters.id, posShifts.registerId),
          ),
        )
        .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, event.payload.shiftId)));
      if (shift?.countedCash == null || shift.expectedCash === null) return;

      // Owners, and members with a role that has pos.shift.manage
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
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'pos.shift.manage')),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'pos.shift_variance',
          params: {
            id: shift.id,
            number: shift.number,
            register: shift.register,
            // Counted less expected: below zero = short (the text says which)
            difference: cashDifferenceOf(shift.countedCash, shift.expectedCash),
          },
          eventId: event.id,
        });
      }
    });
  }
}
```

- **The handler reads the shift when it runs,** like the sold-short bell. A closed shift never changes, so the numbers
  are the ones the close decided on. A shift without a count (a bug) sends nothing.
- **The recipients are the owners and everyone with `pos.shift.manage`** (decision 29), with the same query as the
  sold-short bell's. `selectDistinct` sends one bell to a person with two such roles.
- **The event id is the notification's key,** so a job run twice adds nothing.

```diff
@@ -21,6 +21,7 @@ export const OUTBOX_EVENT_TYPES = [
   'document.file_requested',
   'document.email_requested',
   'pos.sold_short',
+  'pos.shift_variance',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

```diff
@@ -42,6 +42,9 @@ export const outboxPayloadSchemas = {
   // Step 20a: a POS sale took stock below zero when it was posted. The sale's lines say what and
   // where (short_quantity, short_serials); the worker tells the people who put stock right.
   'pos.sold_short': z.object({ saleId: z.uuid() }),
+  // Step 20b: a shift's closing count was further from the expected cash than its register's
+  // limit. The shift's row has the numbers; the worker tells the managers.
+  'pos.shift_variance': z.object({ shiftId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

```diff
@@ -27,6 +27,7 @@ const QUEUE_OF = {
   'workspace.tax_rates_requested': 'jobs',
   'document.file_requested': 'jobs',
   'pos.sold_short': 'jobs',
+  'pos.shift_variance': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

```diff
@@ -7,6 +7,7 @@ import { DocumentFileHandler } from '../documents/file.handler.js';
 import { LowStockHandler } from '../inventory/low-stock.handler.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
+import { ShiftVarianceHandler } from '../pos/shift-variance.handler.js';
 import { SoldShortHandler } from '../pos/sold-short.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
@@ -42,6 +43,7 @@ export class EventHandlers {
     documentFile: DocumentFileHandler,
     documentEmail: DocumentEmailHandler,
     soldShort: SoldShortHandler,
+    shiftVariance: ShiftVarianceHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -58,6 +60,7 @@ export class EventHandlers {
       'document.file_requested': documentFile,
       'document.email_requested': documentEmail,
       'pos.sold_short': soldShort,
+      'pos.shift_variance': shiftVariance,
     };
   }
 
```

```diff
@@ -12,6 +12,7 @@ import { InvitationEmailHandler } from '../invitations/invitation-email.handler.
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { MailService } from '../mail/mail.service.js';
 import { NumberingService } from '../numbering/numbering.service.js';
+import { ShiftVarianceHandler } from '../pos/shift-variance.handler.js';
 import { SoldShortHandler } from '../pos/sold-short.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
@@ -75,6 +76,8 @@ export class WorkerModule implements OnApplicationShutdown {
         DocumentEmailHandler,
         // Step 20a: the bell for a POS sale that took stock below zero
         SoldShortHandler,
+        // Step 20b: the bell for a shift whose count was far from the expected cash
+        ShiftVarianceHandler,
         // Step 18a: the hourly job also prunes the sync change log, on the relay's pool
         SyncLogCleanup,
       ],
```

- **The event type is listed in `packages/db`** (`OUTBOX_EVENT_TYPES`), and every list that `satisfies` it fails the type
  check until it has the new type: the payload's schema, the queue and the handler. No migration: the column is plain text.
- **The payload is the shift's id only,** like every event: the worker reads the rest when it runs.

### The journal and the accounts

```diff
@@ -1,5 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  isPosJournalSource,
   isPurchaseJournalSource,
   isSalesJournalSource,
   isStockJournalSource,
@@ -221,6 +222,15 @@ export class JournalService {
             'This entry belongs to a purchase document. Correct it from that document.',
           );
         }
+        if (isPosJournalSource(entry.source)) {
+          // A POS shift's cash (step 20b, decision 28): it was counted or moved at the counter. The
+          // next count puts a wrong one right, and a pay in or pay out the other way a movement.
+          throw new AppError(
+            409,
+            'journal_is_pos',
+            'This entry belongs to a POS shift. Correct it with the next count or a pay in or out.',
+          );
+        }
         if (entry.version !== input.version) throw versionConflict();
         const [already] = await tx
           .select({ id: reversal.id })
```

- **Reverse refuses a shift's entries with `journal_is_pos`** (decision 28), after the purchase check, in the same shape.

```diff
@@ -311,11 +311,17 @@ export class PostingService {
       );
     }
     // A reversal undoes old work, and a year-end close empties every income and expense account
-    // that holds a balance: both must reach an account that was archived since. A supplier's bill
+    // that holds a balance: both must reach an account that was archived since. So does a POS
+    // shift's entry (step 20b): the money was counted or moved at the counter already, and a
+    // reason or a register may keep an account archived since; refusing it would leave the cash
+    // out of the books (decision 25). A supplier's bill
     // (step 17c) clears "goods received not billed", the stock account its goods receipts credited,
     // and a debit note (step 17d) clears what a purchase return put back on it.
     await this.checkLines(tx, lines, {
-      allowArchived: entry.source === 'reversal' || entry.source === 'year_close',
+      allowArchived:
+        entry.source === 'reversal' ||
+        entry.source === 'year_close' ||
+        entry.source === 'pos_shift',
       allowStock:
         entry.source === 'reversal' ||
         entry.source === 'year_close' ||
```

- **`pos_shift` may post to an archived account** (decision 44). It is not allowed the stock accounts: a reason and an
  over/short account are never one.

```diff
@@ -379,7 +379,10 @@ export class AccountsService {
         isForeignKeyViolation(error, 'pos_registers_card_account_fk') ||
         isForeignKeyViolation(error, 'pos_registers_bkash_account_fk') ||
         isForeignKeyViolation(error, 'pos_registers_nagad_account_fk') ||
-        isForeignKeyViolation(error, 'pos_sale_payments_account_fk')
+        isForeignKeyViolation(error, 'pos_sale_payments_account_fk') ||
+        isForeignKeyViolation(error, 'pos_registers_over_short_account_fk') ||
+        isForeignKeyViolation(error, 'pos_cash_reasons_account_fk') ||
+        isForeignKeyViolation(error, 'pos_cash_movements_account_fk')
       ) {
         throw new AppError(409, 'account_in_use', 'Archive this account instead: entries use it.');
       }
```

- **Three more foreign keys mean "this account is in use":** a register's over/short account, a reason's account, and a
  movement's copy of it. Deleting such an account answers `account_in_use`, like the payment accounts.

### `setup/templates.ts`: a new retail workspace's account and role

```diff
@@ -168,7 +168,8 @@ const TAKING_REFUNDS = ['purchase.refund.manage'] as const;
 // any discount). Nobody else sells at a counter: an owner gives pos.sale.create to a role in
 // Settings → Roles where a depot also has a counter.
 const SELLING_AT_COUNTER = ['pos.sale.create'] as const;
-const RUNNING_COUNTERS = ['pos.register.manage', 'pos.price.override'] as const;
+// Step 20b: they also read every counter's shifts and close one nobody can close
+const RUNNING_COUNTERS = ['pos.register.manage', 'pos.price.override', 'pos.shift.manage'] as const;
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
@@ -735,6 +736,9 @@ export const INDUSTRY_TEMPLATES = {
       selling: [
         account('5330', 'Card and wallet charges'),
         account('5340', 'Shrinkage and damaged goods'),
+        // Step 20b: what the counters' drawers were over or short at the counts (a register's
+        // over/short account, Settings → POS)
+        account('5350', 'Cash over and short'),
       ],
     }),
     catalog: {
```

- **Retail gets 5350 "Cash over and short"** under selling and distribution expenses (decision 57). Only retail has POS
  roles in its template; another business type picks or adds an account.
- **The shop manager gets `pos.shift.manage`** with the other counter permissions. An old workspace's roles are not
  changed by a template.

> **What we checked.** On throwaway containers (Postgres and Valkey) with every migration, a retail workspace: two reasons
> were made, a name in another case and a receivable or inventory account were refused, and a rename kept the direction.
> A register without an over/short account, or with the cash account in its place, was refused. A device opened shift 1
> with a ৳5,000 float from the owner, sold ৳57.50 for ৳1,000 in cash, took ৳100 in and ৳200 out; a sale with an unknown
> shift was refused with `pos_shift_unknown`. The register could not be let go, nor the device moved to another branch,
> while the shift was open. The close counted ৳4,937.50 against ৳4,957.50 expected (the device said ৳4,950): the shift's
> page showed every part of the cash, the payments and the movements, the books had four balanced entries (float, pay
> in, pay out, ৳20 short), the audit log said `expected_differs`, the bell went to the owner, and Reverse was refused
> with `journal_is_pos`. Shift 2 opened ৳2.50 over what was left; a second open was refused; a manager closed it without a
> count, a second manager close was refused, and the device's late close was kept in the audit log only. Shift 3 was
> closed by the revoke of its device, with its audit row. The list paged newest first, and another device's pull had
> both reasons and the register with its latest shift.
>
> The API's type check, lint and unit tests pass. The sync, device, accounts, journal and template suites pass. The POS
> suites fail where they make a register without the three new fields; 20b.4 updates them and adds the shift tests.

### Check this part

```bash
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api lint
pnpm --filter @omnivo/api test
```

The db build is needed again: `OUTBOX_EVENT_TYPES` changed, and the API reads `@omnivo/db` from `dist/`. All pass. Do not
run the integration suites yet: `pos.int.spec.ts` and `pos.tenant-leak.int.spec.ts` make registers without the new
fields until 20b.4. The i18n, sync and app packages still fail as listed at the end of 20b.1.

## 20b.4 — `apps/api`: the tests

One new integration test file, and the two POS suites of 20a:

- `pos/pos-shifts.int.spec.ts` (new): the reasons, the register's shift settings, the shifts of one front counter one
  after the other, a manager's close and a revoke, a cashier without the permission, the managers' list, the pull,
  what a shift posts, and what happens at the same moment.
- `pos/pos.int.spec.ts`: the register form gets the three new fields.
- `pos/pos.tenant-leak.int.spec.ts`: the same, and one shop never sees or uses another shop's reasons and shifts.

The tests found two problems in the 20b.3 code. Both are fixed there, and 20b.3's code above is already the fixed one:

- **A late sale after a manager's close was counted twice** (decision 63). The next opening was compared with the
  expected cash stored at the manager's close, without the sale that came later, so the sale's cash posted to
  over/short again. The fix is in `openFromDevice()`, `summaries()` and `lastShiftsOf()`.
- **A shift with no sales said `0`, not `0.0000`** (decision 64), in `cashOf()`, the list's sales total, and a payment
  method nothing was paid with.

### The two suites of 20a: the register's new fields

```diff
@@ -271,6 +271,10 @@ function registerForm(code: string, warehouse: Warehouse, extra: object = {}) {
     maxDiscountPercent: '',
     paperWidth: '80',
     receiptFooter: '',
+    // Step 20b: a register needs its over/short account; the limit and the lock as the form starts
+    overShortAccountId: accountId('5350'),
+    varianceAlert: '500',
+    lockAfter: '5',
     ...extra,
   };
 }
@@ -293,6 +297,9 @@ function editForm(register: PosRegister, extra: object = {}) {
     maxDiscountPercent: register.maxDiscountPercent,
     paperWidth: register.paperWidth,
     receiptFooter: register.receiptFooter ?? '',
+    overShortAccountId: register.overShortAccountId ?? '',
+    varianceAlert: register.varianceAlert,
+    lockAfter: register.lockAfter,
     version: register.version,
     ...extra,
   };
```

- **`registerForm()` picks 5350 "Cash over and short",** which every new retail workspace has (20b.3), with the form's
  own starting values: a bell over ৳500 and a lock after 5 minutes. Without them every register of 20a's tests is
  refused with `pos_over_short_required`, and every later test fails with it.
- **`editForm()` sends the register's own values back,** as the settings page fills the form. `?? ''` is the empty
  select of a register from 20a that has no over/short account yet: the form refuses it, so a test that edits such a
  register would see that refusal and not the one it is about.

### `pos/pos-shifts.int.spec.ts` (new)

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
  CASH_DENOMINATIONS,
  type CashCountFormValues,
  type CashDenomination,
  cashNotesSchema,
  type Device,
  deviceSchema,
  journalEntrySchema,
  memberPageSchema,
  type PosCashReason,
  posCashReasonListSchema,
  posCashReasonSchema,
  type PosRegister,
  posRegisterSchema,
  posSalePageSchema,
  type PosShift,
  posShiftPageSchema,
  posShiftSchema,
  problemSchema,
  type Product,
  productSchema,
  roleListSchema,
  settingsSchema,
  setupSchema,
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

// Step 20b. Agora Mini Mart again: Nusrat (the owner) runs the front counter, Sumi is a cashier,
// Kamal the shop manager (pos.shift.manage) and Rafiq a member with no role. The tests run in
// order: the reasons and the registers first, then the shifts of the front counter one after the
// other, then the managers' list, the pull, and what happens at the same moment.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the journal entries of every shift and the bell, which no route lists together
let sql: postgres.Sql;
let owner: SignedIn;
let sumi: SignedIn;
let kamal: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let uttara: Branch;
let accounts: Account[];
let vat: TaxRate;
let pcs: string;
let juice: Product;
let counterPc: Device;
let sumiTablet: Device;
let officeLaptop: Device;
let pos1: PosRegister;
let pos2: PosRegister;
let pos3: PosRegister;
// The reasons of Settings → POS
let floatIn: PosCashReason;
let changeIn: PosCashReason;
let bankOut: PosCashReason;
let teaOut: PosCashReason;
let lunchOut: PosCashReason;
// The front counter's shifts, one after the other
let s1: string;
let s2: string;
let s3: string;
let s4: string;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;
type MoveCommand = Extract<SyncCommandInput, { type: 'pos_cash_movement.create' }>;
type CloseCommand = Extract<SyncCommandInput, { type: 'pos_shift.close' }>;
type Payment = SaleCommand['input']['payments'][number];

function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

// The device's clock: one second later at every command, so the list's "newest first" is the
// order the tests ran in, also when two commands are built in the same millisecond
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

async function addAccount(parent: string, code: string, name: string): Promise<Account> {
  const account = await created(accountSchema, '/accounts', {
    parentId: accountId(parent),
    code,
    name,
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  return account;
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

async function registerDevice(name: string, as = owner): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId: main.branchId }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
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
    ...extra,
  };
}

async function registerNow(register: PosRegister): Promise<PosRegister> {
  const res = await send('GET', `/pos/registers/${register.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

async function claimed(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await send(
    'POST',
    `/pos/registers/${register.id}/claim`,
    { deviceId: device.id },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

function release(register: PosRegister, device: Device) {
  return send('POST', `/pos/registers/${register.id}/release`, { deviceId: device.id });
}

function reasonForm(name: string, direction: 'in' | 'out', account: string) {
  return { name, direction, accountId: accountId(account) };
}

// A count by notes, or by its total alone. The notes not named are 0.
function count(total: string, notes?: Partial<Record<CashDenomination, number>>) {
  return {
    total,
    notes:
      notes === undefined
        ? null
        : cashNotesSchema.parse(
            Object.fromEntries(CASH_DENOMINATIONS.map((note) => [note, notes[note] ?? 0])),
          ),
  } satisfies CashCountFormValues;
}

// The register's next shift, as the device opens it: today, with a new UUIDv7
function open(
  register: PosRegister,
  sequence: number,
  opening: CashCountFormValues,
  floatReasonId = '',
): OpenCommand {
  return {
    id: v7(),
    type: 'pos_shift.open',
    shiftId: v7(),
    input: {
      registerId: register.id,
      sequence,
      date: today,
      openedAt: moment(),
      opening,
      floatReasonId,
    },
  };
}

function move(shiftId: string, reason: PosCashReason, amount: string, note = ''): MoveCommand {
  return {
    id: v7(),
    type: 'pos_cash_movement.create',
    movementId: v7(),
    input: { shiftId, reasonId: reason.id, amount, note, date: today, movedAt: moment() },
  };
}

function close(
  shiftId: string,
  counted: CashCountFormValues,
  deviceExpected: string,
  heldDropped = 0,
): CloseCommand {
  return {
    id: v7(),
    type: 'pos_shift.close',
    shiftId,
    input: { date: today, closedAt: moment(), counted, deviceExpected, heldDropped },
  };
}

// The last sale number each register gave, as its device keeps it
const sequences = new Map<string, number>();

// Two mango juices at ৳25 with 15% VAT: ৳57.50
function sale(register: PosRegister, shiftId: string | null, payments: Payment[]): SaleCommand {
  const sequence = (sequences.get(register.id) ?? 0) + 1;
  sequences.set(register.id, sequence);
  const [variant] = juice.variants;
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
      lines: [
        {
          variantId: variant?.id ?? '',
          unitId: pcs,
          quantity: '2',
          description: '',
          unitPrice: '25',
          discountType: 'percent',
          discount: '0',
          taxRateId: vat.id,
          rate: vat.rate,
          startingPrice: '25',
          batchId: '',
          serialNumbers: [],
        },
      ],
      billDiscountType: 'amount',
      billDiscount: '0',
      payments,
    },
  };
}

function numberOf(command: SaleCommand): string {
  return `POS1-${String(command.input.sequence).padStart(6, '0')}`;
}

function cash(amount: string): Payment {
  return { method: 'cash', amount, reference: '' };
}

type Command = SaleCommand | OpenCommand | MoveCommand | CloseCommand;

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
  expect(outcomes(await push(commands, device, as))).toEqual(commands.map(() => 'accepted'));
}

async function shiftNow(id: string, as = owner): Promise<PosShift> {
  const res = await send('GET', `/pos/shifts/${id}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return posShiftSchema.parse(res.json());
}

// An entry as [account code, debit, credit], in its own line order (debit first)
async function linesOf(entry: { id: string } | null | undefined) {
  if (!entry) throw new Error('no entry');
  const res = await send('GET', `/journal-entries/${entry.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return journalEntrySchema
    .parse(res.json())
    .lines.map((line) => [codeOf(line.accountId), line.debit, line.credit]);
}

// How many entries every shift posted together: a refused command posts none
async function shiftEntryCount(): Promise<number> {
  const [row] = z
    .array(z.object({ n: z.number() }))
    .parse(await sql`SELECT count(*)::int AS n FROM journal_entries WHERE source = 'pos_shift'`);
  return row?.n ?? 0;
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  // Oldest first, as the tests tell the story
  return auditPageSchema.parse(res.json()).items.reverse();
}

const bellSchema = z.array(
  z.object({ email: z.string(), params: z.record(z.string(), z.unknown()) }),
);

async function varianceBells() {
  return bellSchema.parse(
    await sql`SELECT u.email, n.params FROM notifications n JOIN users u ON u.id = n.user_id
                WHERE n.type = 'pos.shift_variance' ORDER BY n.created_at, u.email`,
  );
}

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
  kamal = await member('Kamal Hossain', 'kamal@agoramart.com', 'Shop-manager-2026');
  rafiq = await member('Rafiq Islam', 'rafiq@agoramart.com', 'No-role-yet-2026');
  await giveRoles('sumi@agoramart.com', ['Cashier']);
  await giveRoles('kamal@agoramart.com', ['Shop manager']);

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

  // The shop's bank, where the card machine settles and the cash goes in the evening, and an
  // expense account of its own for the staff's tea
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await addAccount('1120', '1121', 'Dutch-Bangla Bank CD A/C 1071');
  await addAccount('5200', '5295', 'Staff tea and snacks');

  const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const fifteen = rates.find((rate) => rate.name === 'VAT 15%');
  if (!fifteen) throw new Error('no VAT 15%');
  vat = fifteen;
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

  counterPc = await registerDevice('Front counter PC');
  sumiTablet = await registerDevice('Sumi tablet', sumi);
  officeLaptop = await registerDevice('Back office laptop');
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('Pay in and pay out reasons', () => {
  it('are made with pos.register.manage, and listed "in" first, then by name', async () => {
    floatIn = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Float from the owner', 'in', '3100'),
    );
    changeIn = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Change from the bank', 'in', '1121'),
    );
    bankOut = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Cash to the bank', 'out', '1121'),
    );
    teaOut = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Tea for the staff', 'out', '5295'),
    );
    lunchOut = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Staff lunch', 'out', '5295'),
    );
    expect(floatIn).toMatchObject({
      name: 'Float from the owner',
      direction: 'in',
      accountId: accountId('3100'),
      archivedAt: null,
      version: 1,
    });
    // Read by anyone (the devices of every cashier keep them), like the registers
    const res = await send('GET', '/pos/cash-reasons', undefined, rafiq);
    expect(res.statusCode, res.body).toBe(200);
    expect(posCashReasonListSchema.parse(res.json()).items.map((item) => item.name)).toEqual([
      'Change from the bank',
      'Float from the owner',
      'Cash to the bank',
      'Staff lunch',
      'Tea for the staff',
    ]);
    const [entry] = await auditOf('pos_cash_reason', floatIn.id);
    expect(entry).toMatchObject({
      action: 'pos_cash_reason.created',
      changes: {
        name: { from: null, to: 'Float from the owner' },
        direction: { from: null, to: 'in' },
        account: { from: null, to: '3100' },
      },
    });
    const cashier = await send(
      'POST',
      '/pos/cash-reasons',
      reasonForm('Snacks', 'out', '5295'),
      sumi,
    );
    expect(cashier.statusCode).toBe(403);
    expect(problemOf(cashier).code).toBe('permission_missing');
  });

  it('refuse a name that is taken, and an account that cannot take the money', async () => {
    const taken = await send(
      'POST',
      '/pos/cash-reasons',
      reasonForm('TEA FOR THE STAFF', 'in', '3100'),
    );
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken)).toMatchObject({
      code: 'pos_reason_name_taken',
      fieldErrors: { name: ['pos_reason_name_taken'] },
    });
    // A group, the customers' and the suppliers' accounts (kept per party), the stock, and an id
    // that is no account: one answer for all of them
    for (const accountIdOf of [
      accountId('1120'),
      accountId('1140'),
      accountId('2110'),
      accountId('1150'),
      v7(),
    ]) {
      const res = await send('POST', '/pos/cash-reasons', {
        name: 'Somewhere',
        direction: 'out',
        accountId: accountIdOf,
      });
      expect(problemOf(res), codeOf(accountIdOf)).toMatchObject({
        code: 'pos_reason_account_invalid',
        fieldErrors: { accountId: ['pos_reason_account_invalid'] },
      });
    }
    const form = await send('POST', '/pos/cash-reasons', {
      name: 'T',
      direction: 'out',
      accountId: '',
    });
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      name: ['pos_reason_name_required'],
      accountId: ['pos_reason_account_invalid'],
    });
    const list = posCashReasonListSchema.parse((await send('GET', '/pos/cash-reasons')).json());
    expect(list.items).toHaveLength(5);
  });

  it('change the name and the account, never the direction', async () => {
    const res = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea and snacks for the staff',
      accountId: accountId('5290'),
      // Not part of the edit form: dropped
      direction: 'in',
      version: teaOut.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = posCashReasonSchema.parse(res.json());
    expect(after).toMatchObject({
      name: 'Tea and snacks for the staff',
      direction: 'out',
      accountId: accountId('5290'),
      version: teaOut.version + 1,
    });
    const [, updated] = await auditOf('pos_cash_reason', teaOut.id);
    expect(updated).toMatchObject({
      action: 'pos_cash_reason.updated',
      changes: {
        name: { from: 'Tea for the staff', to: 'Tea and snacks for the staff' },
        account: { from: '5295', to: '5290' },
      },
    });
    expect(updated?.changes).not.toHaveProperty('direction');
    const stale = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea',
      accountId: accountId('5295'),
      version: teaOut.version,
    });
    expect(problemOf(stale).code).toBe('version_conflict');
    const clash = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'staff lunch',
      accountId: accountId('5295'),
      version: after.version,
    });
    expect(problemOf(clash).code).toBe('pos_reason_name_taken');
    // Back to the staff's own account, for the shifts below
    const back = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea for the staff',
      accountId: accountId('5295'),
      version: after.version,
    });
    expect(back.statusCode, back.body).toBe(200);
    teaOut = posCashReasonSchema.parse(back.json());
  });

  it('are archived and restored; an archived name is still taken', async () => {
    const res = await send('POST', `/pos/cash-reasons/${lunchOut.id}/archive`, {
      version: lunchOut.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const archived = posCashReasonSchema.parse(res.json());
    expect(archived.archivedAt).not.toBeNull();
    const active = posCashReasonListSchema.parse((await send('GET', '/pos/cash-reasons')).json());
    expect(active.items.map((item) => item.name)).not.toContain('Staff lunch');
    const old = posCashReasonListSchema.parse(
      (await send('GET', '/pos/cash-reasons?status=archived')).json(),
    );
    expect(old.items.map((item) => item.name)).toEqual(['Staff lunch']);
    const again = await send('POST', '/pos/cash-reasons', reasonForm('Staff Lunch', 'out', '5295'));
    expect(problemOf(again).code).toBe('pos_reason_name_taken');

    // Its account archived meanwhile: it comes back only with an account that takes money
    const staffTea = accounts.find((account) => account.code === '5295');
    if (!staffTea) throw new Error('no 5295');
    const shut = await send('POST', `/accounts/${staffTea.id}/archive`, {
      version: staffTea.version,
    });
    expect(shut.statusCode, shut.body).toBe(200);
    const refused = await send('POST', `/pos/cash-reasons/${lunchOut.id}/restore`, {
      version: archived.version,
    });
    expect(problemOf(refused).code).toBe('pos_reason_account_invalid');
    const reopened = await send('POST', `/accounts/${staffTea.id}/restore`, {
      version: accountSchema.parse(shut.json()).version,
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
    const restored = await send('POST', `/pos/cash-reasons/${lunchOut.id}/restore`, {
      version: archived.version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    lunchOut = posCashReasonSchema.parse(restored.json());
    expect(lunchOut.archivedAt).toBeNull();
    expect((await auditOf('pos_cash_reason', lunchOut.id)).map((row) => row.action)).toEqual([
      'pos_cash_reason.created',
      'pos_cash_reason.archived',
      'pos_cash_reason.restored',
    ]);
  });
});

describe("A register's shift settings", () => {
  it('need an over/short account, a limit in whole taka and a lock time', async () => {
    const form = await send(
      'POST',
      '/pos/registers',
      registerForm('POS1', { overShortAccountId: '', varianceAlert: '12.50' }),
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      overShortAccountId: ['pos_over_short_required'],
      varianceAlert: ['pos_variance_alert_format'],
    });
    // The cash drawer itself, and a group: over/short is an income or an expense account
    for (const code of ['1110', '5300']) {
      const res = await send(
        'POST',
        '/pos/registers',
        registerForm('POS1', { overShortAccountId: accountId(code) }),
      );
      expect(problemOf(res), code).toMatchObject({
        code: 'pos_over_short_invalid',
        fieldErrors: { overShortAccountId: ['pos_over_short_invalid'] },
      });
    }

    // The front counter, with a card machine: a bell for any difference over ৳10
    pos1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS1', {
        name: 'Front counter',
        accounts: { cash: accountId('1110'), card: accountId('1121'), bkash: '', nagad: '' },
        varianceAlert: '10',
        lockAfter: '2',
      }),
    );
    expect(pos1).toMatchObject({
      overShortAccountId: accountId('5350'),
      varianceAlert: '10',
      lockAfter: '2',
      lastShift: null,
    });
    // An empty limit is 0: a bell for any difference at all. Over/short as income is fine too.
    pos2 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS2', {
        name: 'Pharmacy counter',
        overShortAccountId: accountId('4220'),
        varianceAlert: '',
        lockAfter: 'off',
      }),
    );
    expect(pos2).toMatchObject({ varianceAlert: '0', lockAfter: 'off' });
    pos3 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS3', { name: 'Back counter' }),
    );
    const [entry] = await auditOf('pos_register', pos1.id);
    expect(entry?.changes).toMatchObject({
      overShortAccount: { from: null, to: '5350' },
      varianceAlert: { from: null, to: '10' },
      lockAfter: { from: null, to: '2' },
    });
  });
});

describe('A shift at the front counter', () => {
  it("opens with the float from the owner: the register's first shift", async () => {
    pos1 = await claimed(pos1, counterPc);
    expect(pos1.lastShift).toBeNull();
    sequences.set(pos1.id, pos1.lastNumber);

    // The float must come by an "in" reason the server knows. Nothing is written for a refusal.
    const wrongWay = open(pos1, 1, count('5000', { '1000': 5 }), bankOut.id);
    const unknown = open(pos1, 1, count('5000', { '1000': 5 }), v7());
    const refused = await push([wrongWay, unknown]);
    expect(refused.map(refusal)).toEqual([
      {
        code: 'pos_float_reason_required',
        fieldErrors: { floatReasonId: ['pos_float_reason_required'] },
      },
      {
        code: 'pos_float_reason_required',
        fieldErrors: { floatReasonId: ['pos_float_reason_required'] },
      },
    ]);
    expect(await shiftEntryCount()).toBe(0);

    const first = open(pos1, 1, count('5000', { '1000': 4, '500': 2 }), floatIn.id);
    s1 = first.shiftId;
    await accepted([first]);
    const shift = await shiftNow(s1);
    expect(shift).toMatchObject({
      number: 'POS1-S0001',
      register: { id: pos1.id, code: 'POS1', name: 'Front counter' },
      branchId: main.branchId,
      sequence: 1,
      status: 'open',
      cashier: { fullName: 'Nusrat Jahan' },
      device: { id: counterPc.id, name: 'Front counter PC' },
      openingCash: '5000.00',
      expectedCash: '5000.0000',
      countedCash: null,
      difference: null,
      saleCount: 0,
      opening: {
        count: { total: '5000.00', notes: { '1000': 4, '500': 2, '100': 0 } },
        date: today,
        comparedWith: null,
        difference: null,
        floatReason: { id: floatIn.id, name: 'Float from the owner' },
      },
      closing: null,
      closedBy: null,
      movements: [],
    });
    // The float came from the owner: Dr cash, Cr capital
    expect(await linesOf(shift.opening.entry)).toEqual([
      ['1110', '5000.0000', '0.0000'],
      ['3100', '0.0000', '5000.0000'],
    ]);
    expect((await registerNow(pos1)).lastShift).toEqual({
      id: s1,
      sequence: 1,
      status: 'open',
      cashLeft: null,
    });
    const [opened] = await auditOf('pos_shift', s1);
    expect(opened).toMatchObject({
      action: 'pos_shift.opened',
      changes: {
        number: { to: 'POS1-S0001' },
        floatReason: { to: 'Float from the owner' },
        entry: { to: shift.opening.entry?.number },
      },
    });
  });

  it('is the only open shift of its register, opened by the device that holds it', async () => {
    const before = await shiftEntryCount();
    const results = await push([open(pos1, 2, count('5000'))]);
    expect(outcomes(results)).toEqual(['pos_shift_already_open']);
    const elsewhere = await push([open(pos1, 2, count('100'))], officeLaptop);
    expect(refusal(elsewhere[0])).toEqual({
      code: 'pos_register_not_held',
      fieldErrors: { registerId: ['pos_register_not_held'] },
    });
    expect(await shiftEntryCount()).toBe(before);
  });

  it('takes pay ins and pay outs by their reasons', async () => {
    // Staff lunch is archived after the cashier picked it: the money still moved
    const pickedLunch = move(s1, lunchOut, '80', 'Lunch for two, Star Kabab');
    const res = await send('POST', `/pos/cash-reasons/${lunchOut.id}/archive`, {
      version: lunchOut.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const coins = move(s1, changeIn, '500', 'Coins of ৳1, ৳2 and ৳5');
    const deposit = move(s1, bankOut, '3000', 'Deposit slip 0042, DBBL Dhanmondi');
    const tea = move(s1, teaOut, '120');
    const results = await push([
      coins,
      deposit,
      tea,
      pickedLunch,
      move(s1, { ...teaOut, id: v7() }, '50'),
      move(v7(), teaOut, '50'),
      move(s1, teaOut, '0'),
    ]);
    expect(outcomes(results)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'pos_reason_required',
      'pos_shift_unknown',
      'invalid_input',
    ]);
    expect(refusal(results[4]).fieldErrors).toEqual({ reasonId: ['pos_reason_required'] });
    expect(refusal(results[5]).fieldErrors).toEqual({ shiftId: ['pos_shift_unknown'] });

    const shift = await shiftNow(s1);
    expect(
      shift.movements.map((item) => [
        item.reason.name,
        item.direction,
        item.amount,
        codeOf(item.accountId),
      ]),
    ).toEqual([
      // By the device's clock: the lunch was paid before the reason was archived
      ['Staff lunch', 'out', '80.0000', '5295'],
      ['Change from the bank', 'in', '500.0000', '1121'],
      ['Cash to the bank', 'out', '3000.0000', '1121'],
      ['Tea for the staff', 'out', '120.0000', '5295'],
    ]);
    expect(shift.movements[2]?.note).toBe('Deposit slip 0042, DBBL Dhanmondi');
    expect(shift.cash).toEqual({
      opening: '5000.0000',
      cashTaken: '0.0000',
      changeGiven: '0.0000',
      paidIn: '500.0000',
      paidOut: '3200.0000',
    });
    expect(shift.expectedCash).toBe('2300.0000');
    // A pay in brings cash in from the reason's account; a pay out the other way
    expect(await linesOf(shift.movements[1]?.entry)).toEqual([
      ['1110', '500.0000', '0.0000'],
      ['1121', '0.0000', '500.0000'],
    ]);
    expect(await linesOf(shift.movements[2]?.entry)).toEqual([
      ['1121', '3000.0000', '0.0000'],
      ['1110', '0.0000', '3000.0000'],
    ]);
    const moved = (await auditOf('pos_shift', s1)).filter(
      (row) => row.action === 'pos_shift.cash_moved',
    );
    expect(moved).toHaveLength(4);
    const fromTheBank = moved.find((row) =>
      JSON.stringify(row.changes).includes('Change from the bank'),
    );
    expect(fromTheBank?.changes).toMatchObject({
      reason: { to: 'Change from the bank' },
      direction: { to: 'in' },
      shiftStatus: { to: 'open' },
    });
  });

  it('counts the sales of the shift, by how they were paid', async () => {
    // ৳57.50 each: one paid with a ৳100 note (৳42.50 back), one by card
    const first = sale(pos1, s1, [cash('100')]);
    const second = sale(pos1, s1, [{ method: 'card', amount: '57.50', reference: '4471' }]);
    // A sale from an outbox of before 20b has no shift; a shift the server does not know, or one
    // of another register, is a bug on the device
    const old = sale(pos1, null, [cash('57.50')]);
    const unknown = sale(pos1, v7(), [cash('57.50')]);
    const results = await push([first, second, old, unknown]);
    expect(outcomes(results)).toEqual(['accepted', 'accepted', 'accepted', 'pos_shift_unknown']);
    expect(refusal(results[3]).fieldErrors).toEqual({ shiftId: ['pos_shift_unknown'] });

    const shift = await shiftNow(s1);
    expect(shift).toMatchObject({
      saleCount: 2,
      salesTotal: '115.0000',
      cash: {
        opening: '5000.0000',
        cashTaken: '100.0000',
        changeGiven: '42.5000',
        paidIn: '500.0000',
        paidOut: '3200.0000',
      },
      // Cash and card: the methods POS1 takes, and nothing came by bKash or Nagad
      payments: [
        { method: 'cash', amount: '100.0000' },
        { method: 'card', amount: '57.5000' },
      ],
      expectedCash: '2357.5000',
    });
    const sales = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos1.id}`)).json(),
    );
    // One push writes its sales at the same moment: found by their numbers, not by their order
    const shiftOf = new Map(sales.items.map((item) => [item.number, item.shift?.number ?? null]));
    expect([first, second, old].map((command) => shiftOf.get(numberOf(command)))).toEqual([
      'POS1-S0001',
      'POS1-S0001',
      null,
    ]);
  });

  it('keeps its register held, and its device in Dhanmondi, while it is open', async () => {
    const res = await release(pos1, counterPc);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('pos_shift_still_open');
    const moved = await send('PUT', `/devices/${counterPc.id}/branch`, {
      branchId: uttara.id,
      version: counterPc.version,
    });
    expect(moved.statusCode).toBe(409);
    expect(problemOf(moved).code).toBe('pos_shift_still_open');
    expect((await registerNow(pos1)).deviceId).toBe(counterPc.id);
  });

  it('closes with a count: the difference posts to over/short, and a big one rings the bell', async () => {
    // ৳2,325 in the drawer where ৳2,357.50 should be: ৳32.50 short, over POS1's limit of ৳10
    await accepted([
      close(s1, count('2325', { '1000': 2, '100': 3, '10': 2, '5': 1 }), '2357.50', 2),
    ]);
    const shift = await shiftNow(s1);
    expect(shift).toMatchObject({
      status: 'closed',
      openingCash: '5000.00',
      expectedCash: '2357.5000',
      countedCash: '2325.00',
      difference: '-32.5000',
      closing: {
        count: { total: '2325.00', notes: { '1000': 2, '100': 3, '10': 2, '5': 1 } },
        date: today,
        deviceExpected: '2357.5000',
        heldDropped: 2,
      },
      closedBy: null,
    });
    expect(shift.closedAt).not.toBeNull();
    // Short: the money that is missing is an expense
    expect(await linesOf(shift.closing?.entry)).toEqual([
      ['5350', '32.5000', '0.0000'],
      ['1110', '0.0000', '32.5000'],
    ]);
    const actions = (await auditOf('pos_shift', s1)).map((row) => row.action);
    // The device expected the same: no expected_differs row
    expect(actions).toEqual([
      'pos_shift.opened',
      'pos_shift.cash_moved',
      'pos_shift.cash_moved',
      'pos_shift.cash_moved',
      'pos_shift.cash_moved',
      'pos_shift.closed',
    ]);
    // The owner and the shop manager hear about it, not the cashier or Rafiq
    await eventually(async () => {
      const bells = await varianceBells();
      expect(bells.map((bell) => bell.email)).toEqual([
        'kamal@agoramart.com',
        'nusrat@agoramart.com',
      ]);
      expect(bells[0]?.params).toEqual({
        id: s1,
        number: 'POS1-S0001',
        register: 'Front counter',
        difference: '-32.5000',
      });
    });
    expect((await registerNow(pos1)).lastShift).toEqual({
      id: s1,
      sequence: 1,
      status: 'closed',
      cashLeft: '2325.0000',
    });
  });

  it('lets go of its register once closed, and the claim answers the last shift', async () => {
    const res = await release(pos1, counterPc);
    expect(res.statusCode, res.body).toBe(200);
    const held = await claimed(pos1, counterPc);
    expect(held.lastShift).toMatchObject({ id: s1, status: 'closed', cashLeft: '2325.0000' });
  });

  it('opens the next shift against what the last one left', async () => {
    // ৳5 more than the count of the last close: over, from over/short. A float reason sent with a
    // later shift is not used.
    const next = open(pos1, 2, count('2330'), floatIn.id);
    s2 = next.shiftId;
    await accepted([next]);
    const shift = await shiftNow(s2);
    expect(shift).toMatchObject({
      number: 'POS1-S0002',
      openingCash: '2330.00',
      opening: {
        count: { notes: null, total: '2330.00' },
        comparedWith: '2325.0000',
        difference: '5.0000',
        floatReason: null,
      },
    });
    expect(await linesOf(shift.opening.entry)).toEqual([
      ['1110', '5.0000', '0.0000'],
      ['5350', '0.0000', '5.0000'],
    ]);
  });

  it('writes down when the device expected another amount, and posts nothing for a count that matches', async () => {
    await accepted([sale(pos1, s2, [cash('57.50')])]);
    // The device missed a sale it had: it thought ৳2,400
    await accepted([close(s2, count('2387.50'), '2400')]);
    const shift = await shiftNow(s2);
    expect(shift).toMatchObject({
      status: 'closed',
      expectedCash: '2387.5000',
      countedCash: '2387.50',
      difference: '0.0000',
      closing: { deviceExpected: '2400.0000', entry: null },
    });
    const differs = (await auditOf('pos_shift', s2)).find(
      (row) => row.action === 'pos_shift.expected_differs',
    );
    expect(differs?.changes).toEqual({
      // As the device sent it
      device: { from: null, to: '2400' },
      server: { from: null, to: '2387.5000' },
    });
    // No new bell: the one of the first shift is all
    expect(await varianceBells()).toHaveLength(2);
    // A shift number given twice (a bug on the device) is refused, and posts nothing
    const before = await shiftEntryCount();
    const twice = await push([open(pos1, 2, count('2000'))]);
    expect(refusal(twice[0])).toEqual({
      code: 'pos_number_taken',
      fieldErrors: { sequence: ['pos_number_taken'] },
    });
    expect(await shiftEntryCount()).toBe(before);
  });

  it('keeps a pay out that arrives after its close', async () => {
    const before = await shiftNow(s2);
    await accepted([move(s2, teaOut, '40')]);
    const after = await shiftNow(s2);
    expect(after.movements.map((item) => item.amount)).toEqual(['40.0000']);
    // The close stays as it was: what was counted, against what was expected then
    expect(after).toMatchObject({
      status: 'closed',
      expectedCash: before.expectedCash,
      countedCash: before.countedCash,
      closing: before.closing,
    });
    const late = (await auditOf('pos_shift', s2)).find(
      (row) => row.action === 'pos_shift.cash_moved',
    );
    expect(late?.changes).toMatchObject({ shiftStatus: { to: 'closed' } });
  });
});

describe('A shift nobody can count', () => {
  it('is closed by a manager online, without a count', async () => {
    // The next shift starts with the ৳2,387.50 of the last count: no difference, no entry
    const next = open(pos1, 3, count('2387.50'));
    s3 = next.shiftId;
    await accepted([next, sale(pos1, s3, [cash('57.50')])]);
    expect((await shiftNow(s3)).opening).toMatchObject({ difference: '0.0000', entry: null });

    const cashier = await send('POST', `/pos/shifts/${s3}/close-without-count`, { note: '' }, sumi);
    expect(cashier.statusCode).toBe(403);
    const res = await send(
      'POST',
      `/pos/shifts/${s3}/close-without-count`,
      { note: 'Counter PC would not start' },
      kamal,
    );
    expect(res.statusCode, res.body).toBe(200);
    const shift = posShiftSchema.parse(res.json());
    expect(shift).toMatchObject({
      status: 'closed_without_count',
      expectedCash: '2445.0000',
      countedCash: null,
      difference: null,
      closing: null,
      closedBy: { fullName: 'Kamal Hossain' },
    });
    const done = (await auditOf('pos_shift', s3)).find(
      (row) => row.action === 'pos_shift.closed_without_count',
    );
    expect(done?.changes).toMatchObject({
      expected: { to: '2445.0000' },
      note: { to: 'Counter PC would not start' },
      by: { to: 'manager' },
    });
    const again = await send('POST', `/pos/shifts/${s3}/close-without-count`, { note: '' }, kamal);
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).code).toBe('pos_shift_closed');
    const missing = await send('POST', `/pos/shifts/${v7()}/close-without-count`, { note: '' });
    expect(missing.statusCode).toBe(404);
    expect((await registerNow(pos1)).lastShift).toEqual({
      id: s3,
      sequence: 3,
      status: 'closed_without_count',
      cashLeft: '2445.0000',
    });
  });

  it("keeps what the device sends after the manager's close, and the next opening finds the cash", async () => {
    // The counter PC was offline: it sold once more on the shift, then counted ৳2,502.50 (all
    // there) and closed. All of it arrives after the manager's close.
    const late = sale(pos1, s3, [cash('57.50')]);
    const counted = close(s3, count('2502.50'), '2502.50');
    await accepted([late, counted]);
    const shift = await shiftNow(s3);
    expect(shift).toMatchObject({
      status: 'closed_without_count',
      closedBy: { fullName: 'Kamal Hossain' },
      closing: null,
      saleCount: 2,
    });
    // The count is in the audit log only (decision 38)
    const kept = (await auditOf('pos_shift', s3)).find((row) => row.action === 'pos_shift.closed');
    expect(kept?.changes).toMatchObject({
      counted: { to: '2502.50' },
      kept: { to: false },
      statusBefore: { to: 'closed_without_count' },
    });
    // The late sale's cash is in the drawer and already in the books (the sale's entry). The next
    // shift opens with the same ৳2,502.50, so nothing is over and nothing posts.
    const next = open(pos1, 4, count('2502.50'));
    s4 = next.shiftId;
    await accepted([next]);
    expect((await shiftNow(s4)).opening).toMatchObject({
      comparedWith: '2502.5000',
      difference: '0.0000',
      entry: null,
    });
  });

  it('is closed by itself when its device is revoked', async () => {
    pos3 = await claimed(pos3, officeLaptop);
    const first = open(pos3, 1, count('1000', { '500': 2 }), floatIn.id);
    await accepted([first, sale(pos3, first.shiftId, [cash('100')])], officeLaptop);
    const res = await send('POST', `/devices/${officeLaptop.id}/revoke`);
    expect(res.statusCode, res.body).toBe(200);
    const shift = await shiftNow(first.shiftId);
    expect(shift).toMatchObject({
      number: 'POS3-S0001',
      status: 'closed_without_count',
      expectedCash: '1057.5000',
      closedBy: { fullName: 'Nusrat Jahan' },
      closing: null,
    });
    const done = (await auditOf('pos_shift', first.shiftId)).find(
      (row) => row.action === 'pos_shift.closed_without_count',
    );
    expect(done?.changes).toMatchObject({
      by: { to: 'revoke' },
      device: { to: 'Back office laptop' },
    });
    const register = await registerNow(pos3);
    expect(register).toMatchObject({
      deviceId: null,
      lastShift: { id: first.shiftId, status: 'closed_without_count', cashLeft: '1057.5000' },
    });
    // The lost laptop can send nothing more
    const after = await send('POST', '/sync/push', {
      deviceId: officeLaptop.id,
      protocol: SYNC_PROTOCOL,
      commands: [close(first.shiftId, count('1057.50'), '1057.50')],
    });
    expect(after.statusCode).toBe(403);
    expect(problemOf(after).code).toBe('device_revoked');
  });
});

describe("A cashier's shift", () => {
  it('goes through without the permission that was taken away while the device was offline', async () => {
    pos2 = await claimed(pos2, sumiTablet, sumi);
    // A first shift with ৳300 and no reason: only a device with a bug sends it (the app asks
    // where the float came from). The money is in the drawer, so over/short takes it: POS2's
    // over/short is an income account.
    const first = open(pos2, 1, count('300'));
    await accepted([first], sumiTablet, sumi);
    expect(await linesOf((await shiftNow(first.shiftId)).opening.entry)).toEqual([
      ['1110', '300.0000', '0.0000'],
      ['4220', '0.0000', '300.0000'],
    ]);

    await giveRoles('sumi@agoramart.com', []);
    // ৳1 short: POS2's limit is 0, so any difference rings the bell
    await accepted(
      [move(first.shiftId, changeIn, '200'), close(first.shiftId, count('499'), '500')],
      sumiTablet,
      sumi,
    );
    await giveRoles('sumi@agoramart.com', ['Cashier']);
    const actions = (await auditOf('pos_shift', first.shiftId)).map((row) => row.action);
    expect(actions).toEqual([
      'pos_shift.opened',
      'pos_shift.cash_moved',
      'pos_shift.without_permission',
      'pos_shift.closed',
      'pos_shift.without_permission',
    ]);
    expect(await shiftNow(first.shiftId)).toMatchObject({
      status: 'closed',
      cashier: { fullName: 'Sumi Akter' },
      difference: '-1.0000',
    });
    await eventually(async () => {
      const bells = await varianceBells();
      expect(bells.filter((bell) => bell.params.number === 'POS2-S0001')).toHaveLength(2);
    });
  });
});

describe("The managers' list of shifts", () => {
  it('is newest first, by register and by status, one page at a time', async () => {
    const res = await send('GET', `/pos/shifts?registerId=${pos1.id}`, undefined, kamal);
    expect(res.statusCode, res.body).toBe(200);
    const byRegister = posShiftPageSchema.parse(res.json());
    expect(byRegister.items.map((item) => [item.number, item.status])).toEqual([
      ['POS1-S0004', 'open'],
      ['POS1-S0003', 'closed_without_count'],
      ['POS1-S0002', 'closed'],
      ['POS1-S0001', 'closed'],
    ]);
    // What an open shift should hold now, worked out as the list is read
    expect(byRegister.items[0]).toMatchObject({ expectedCash: '2502.5000', countedCash: null });
    expect(byRegister.items[3]).toMatchObject({
      countedCash: '2325.00',
      difference: '-32.5000',
      saleCount: 2,
      salesTotal: '115.0000',
    });
    const uncounted = posShiftPageSchema.parse(
      (await send('GET', '/pos/shifts?status=closed_without_count')).json(),
    );
    expect(uncounted.items.map((item) => item.number)).toEqual(['POS3-S0001', 'POS1-S0003']);

    const numbers: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = posShiftPageSchema.parse(
        (await send('GET', `/pos/shifts?limit=2${after}`)).json(),
      );
      numbers.push(...page.items.map((item) => item.number));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = posShiftPageSchema.parse((await send('GET', '/pos/shifts?limit=100')).json());
    expect(numbers).toEqual(all.items.map((item) => item.number));
    expect(numbers).toHaveLength(6);
  });

  it('is read with pos.shift.manage only', async () => {
    for (const who of [sumi, rafiq]) {
      const list = await send('GET', '/pos/shifts', undefined, who);
      expect(list.statusCode).toBe(403);
      expect((await send('GET', `/pos/shifts/${s1}`, undefined, who)).statusCode).toBe(403);
    }
    expect((await send('GET', `/pos/shifts/${v7()}`)).statusCode).toBe(404);
  });
});

describe('The pull', () => {
  it('brings every active reason and the latest shift of each register', async () => {
    const full = await pulled(counterPc);
    const reasons = full.changes.filter((change) => change.entity === 'pos_cash_reason');
    // Staff lunch is archived
    expect(reasons.map((change) => change.key).sort()).toEqual(
      [floatIn.id, changeIn.id, bankOut.id, teaOut.id].sort(),
    );
    const front = full.changes.find(
      (change) => change.entity === 'pos_register' && change.key === pos1.id,
    );
    expect(front).toMatchObject({
      op: 'upsert',
      data: { lastShift: { id: s4, sequence: 4, status: 'open', cashLeft: null } },
    });

    // A reason renamed, one archived, and a shift closed: each in the next pull
    const renamed = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea for the staff and guests',
      accountId: teaOut.accountId,
      version: teaOut.version,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const archived = await send('POST', `/pos/cash-reasons/${changeIn.id}/archive`, {
      version: changeIn.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    await accepted([close(s4, count('2502.50'), '2502.50')]);
    const delta = await pulled(counterPc, full.cursor);
    expect(
      delta.changes
        .filter((change) => change.entity === 'pos_cash_reason')
        .map((change) => [change.op, change.key]),
    ).toEqual([
      ['upsert', teaOut.id],
      ['delete', changeIn.id],
    ]);
    expect(delta.changes.filter((change) => change.entity === 'pos_register')).toMatchObject([
      { key: pos1.id, data: { lastShift: { id: s4, status: 'closed' } } },
    ]);
  });
});

describe('What a shift posts', () => {
  it('is not reversed in the journal, and its accounts are not deleted', async () => {
    const shift = await shiftNow(s1);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${shift.closing?.entry?.id ?? ''}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: today,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('journal_is_pos');

    // 5295 has entries and reasons; an account only a reason or a register points at is in use too
    const tips = await addAccount('4200', '4230', 'Tips left at the counter');
    const reason = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Tips', 'in', '4230'),
    );
    expect(reason.accountId).toBe(tips.id);
    const gone = await send('DELETE', `/accounts/${tips.id}?version=${String(tips.version)}`);
    expect(gone.statusCode).toBe(409);
    expect(problemOf(gone).code).toBe('account_in_use');
    const spare = await addAccount('5300', '5390', 'Counter differences');
    const now = await registerNow(pos3);
    const edited = await send('PUT', `/pos/registers/${pos3.id}`, {
      name: now.name,
      warehouseId: now.warehouseId,
      accounts: { cash: now.accounts.cash, card: '', bkash: '', nagad: '' },
      maxDiscountPercent: now.maxDiscountPercent,
      paperWidth: now.paperWidth,
      receiptFooter: '',
      overShortAccountId: spare.id,
      varianceAlert: now.varianceAlert,
      lockAfter: now.lockAfter,
      version: now.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const spareGone = await send(
      'DELETE',
      `/accounts/${spare.id}?version=${String(spare.version)}`,
    );
    expect(problemOf(spareGone).code).toBe('account_in_use');
  });
});

describe('At the same moment', () => {
  it('two opens of one register: one shift', async () => {
    const [a, b] = await Promise.all([
      push([open(pos1, 5, count('2502.50'))]),
      push([open(pos1, 6, count('2502.50'))]),
    ]);
    const answers = [...outcomes(a), ...outcomes(b)].sort();
    expect(answers).toEqual(['accepted', 'pos_shift_already_open']);
    const open5 = posShiftPageSchema.parse(
      (await send('GET', `/pos/shifts?registerId=${pos1.id}&status=open`)).json(),
    );
    expect(open5.items).toHaveLength(1);
  });

  it("a manager's close and a sale: the sale is kept, and counted in the close or after it", async () => {
    const [shift] = posShiftPageSchema.parse(
      (await send('GET', `/pos/shifts?registerId=${pos1.id}&status=open`)).json(),
    ).items;
    if (!shift) throw new Error('no open shift');
    const [closed, sold] = await Promise.all([
      send('POST', `/pos/shifts/${shift.id}/close-without-count`, { note: '' }, kamal),
      push([sale(pos1, shift.id, [cash('57.50')])]),
    ]);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(outcomes(sold)).toEqual(['accepted']);
    // FOR UPDATE against FOR SHARE: the stored expected cash has the sale in it, or the sale came
    // after the close (a late sale) and the next opening compares with the live amount
    const after = await shiftNow(shift.id);
    expect(['2502.5000', '2560.0000']).toContain(posShiftSchema.parse(closed.json()).expectedCash);
    expect(after).toMatchObject({ status: 'closed_without_count', saleCount: 1 });
    expect((await registerNow(pos1)).lastShift?.cashLeft).toBe('2560.0000');
  });

  it("a device's close and a manager's close: one of them closes it", async () => {
    const next = open(pos1, 7, count('2560'));
    await accepted([next]);
    const [counted, manager] = await Promise.all([
      push([close(next.shiftId, count('2560'), '2560')]),
      send('POST', `/pos/shifts/${next.shiftId}/close-without-count`, { note: '' }, kamal),
    ]);
    expect(outcomes(counted)).toEqual(['accepted']);
    const shift = await shiftNow(next.shiftId);
    if (manager.statusCode === 200) {
      // The manager was first: the count is in the audit log only
      expect(shift.status).toBe('closed_without_count');
    } else {
      expect(problemOf(manager).code).toBe('pos_shift_closed');
      expect(shift.status).toBe('closed');
    }
  });

  it('an open and a revoke: no shift is left open on a free register', async () => {
    const tablet = await registerDevice('Spare tablet');
    const held = await claimed(pos3, tablet);
    const opening = open(held, 2, count('1057.50'));
    const [pushed, revoked] = await Promise.all([
      send('POST', '/sync/push', {
        deviceId: tablet.id,
        protocol: SYNC_PROTOCOL,
        commands: [opening],
      }),
      send('POST', `/devices/${tablet.id}/revoke`),
    ]);
    expect(revoked.statusCode, revoked.body).toBe(200);
    if (pushed.statusCode === 200) {
      const [result] = syncPushSchema.parse(pushed.json()).results;
      if (result?.status === 'accepted') {
        // The open was first; the revoke closed it
        expect((await shiftNow(opening.shiftId)).status).toBe('closed_without_count');
      } else {
        expect(refusal(result).code).toBe('pos_register_not_held');
      }
    } else {
      expect(problemOf(pushed).code).toBe('device_revoked');
    }
    const register = await registerNow(pos3);
    expect(register.deviceId).toBeNull();
    expect(register.lastShift?.status).not.toBe('open');
  });
});
```

The file is long, so here it is part by part, in its own order.

**The world.** Agora Mini Mart again, a retail shop, so 5350 "Cash over and short", the Cashier role and the Shop
manager role (with `pos.shift.manage`, 20b.3) come from the template. Nusrat is the owner, Sumi a cashier, Kamal the
shop manager and Rafiq a member with no role. The shop adds its bank (1121, under the money group 1120) and an expense
account for the staff's tea (5295). Uttara is a second branch, only so the counter PC has somewhere to be moved to.

**The helpers.**

- **`moment()` is the device's clock, one second later at every command.** The shifts list is newest first by
  `openedAt`, and the movements of a shift are in `movedAt` order. Two commands built in the same millisecond would
  have the same time, and the order of the test's lists would then depend on the ids, which are random.
- **`count()` builds a count the way the app sends it:** the notes (every note not named is 0) and their total, or the
  total alone with `notes: null`. `cashNotesSchema.parse()` turns the object into `CashNotes` without a cast.
  `satisfies CashCountFormValues` checks the shape against the contract while keeping the literal type.
- **`open()`, `move()` and `close()` build the three commands** with new UUIDv7 ids, for today. `open()` takes the
  sequence by hand: the tests that refuse a number used twice need to choose it.
- **`sale()` is always two mango juices at ৳25 with 15% VAT, ৳57.50,** so every expected amount in the file can be
  worked out by hand: a ৳100 note gives ৳42.50 back.
- **`accepted()` checks that every command of a push was accepted;** `outcomes()` gives "accepted" or the refusal's
  code for each, so a test sees all the answers of one push in one line.
- **`linesOf()` reads an entry as `[code, debit, credit]` in its own order,** debit first: a shift's entries always have
  two lines, so the order says which way the money went.
- **`shiftEntryCount()` counts every entry with the source `pos_shift`.** A refused command must post nothing; the
  count before and after shows it, because the savepoint of a refused command takes its entry back.
- **`auditOf()` reverses the audit page,** which is newest first, so the tests read the actions in the order they
  happened.
- **`varianceBells()` reads the bell as the superuser,** with the person's email: no route lists other people's bells.

**Pay in and pay out reasons.**

- **Five reasons, two in and three out,** on four accounts: capital (the owner's float), the bank both ways, and the
  staff's tea account. The list is "in" first, then by name (decision 62). Rafiq, with no role, can read it: every
  cashier's device keeps the reasons.
- **The audit row names the account by its code** (`3100`), like the register's.
- **Refusals:** a name in another case is taken; a group, the receivable and payable accounts (kept per party), the
  stock account and an id that is no account all answer `pos_reason_account_invalid`, one answer for every reason
  (like the journal's accounts). The form's own checks are a 400 with one code per field. After them there are still
  five reasons.
- **The edit drops a `direction` in the body:** the edit schema has none, and Zod drops keys it does not know. The audit
  row has the name and the account, and no direction. An old version is `version_conflict`; another reason's name is
  `pos_reason_name_taken`.
- **An archived reason keeps its name taken** (the unique index covers archived rows), and comes back only with an
  account that can still take money: with its account archived, the restore is refused.

**A register's shift settings.** No over/short account and a limit with paisa are refused by the form. The cash account
and a group are refused by the server under `overShortAccountId`. POS1 (the front counter, with a card machine) rings
the bell over ৳10. POS2 (the pharmacy counter) uses an income account, which is also fine, and an empty limit, which is
0: any difference rings the bell. The audit row of POS1 has the three fields.

**A shift at the front counter.** The tests follow one counter through the day.

- **The first shift needs an "in" reason for its float.** An "out" reason and an id nobody has both answer
  `pos_float_reason_required`, and nothing posts. With the owner's reason, ৳5,000 by notes is Dr cash / Cr capital. The
  shift's page shows the count as it was typed (`5000.00`, decision 59) and the notes; the register's `lastShift` says
  open, with no `cashLeft` yet.
- **A second open is refused** (`pos_shift_already_open`), and so is an open from a device that does not hold the
  register (`pos_register_not_held`). Neither posts.
- **Pay ins and pay outs:** ৳500 of coins in from the bank, ৳3,000 to the bank, ৳120 of tea and ৳80 of lunch out. The
  lunch reason is archived after the cashier picked it, and the movement still posts (decision 40). The movements are
  in the device's time order, so the lunch, picked first, comes first. An id that is no reason, a shift nobody has and
  an amount of 0 are refused, each with its own answer.
- **The sales:** one paid with a ৳100 note, one by card. The shift counts ৳100 of cash in and ৳42.50 of change out, and
  the card amount only on the payments list, which also has every method POS1 takes (cash and card). A sale with no
  shift (from an outbox of before 20b) is accepted and counts in no shift; one with a shift nobody has is
  `pos_shift_unknown`. One push writes its sales at the same moment, so the test finds them on the list by their
  numbers, not by their order.
- **While the shift is open, the register is not let go and the device does not move branch** (`pos_shift_still_open`).
- **The close:** ৳2,325 by notes where ৳2,357.50 should be, ৳32.50 short: Dr over/short / Cr cash. The device expected
  the same, so there is no `expected_differs` row. ৳32.50 is over POS1's limit of ৳10: the bell reaches the owner and
  the shop manager, not the cashier or Rafiq, and names the register by its name. `eventually()` waits for the worker.
- **After the close** the register can be let go, and the claim answers with the last shift and the ৳2,325 left.
- **The next shift** opens with ৳2,330: ৳5 over what was left, Dr cash / Cr over/short. The float reason it sends is
  not used: only a first shift has a float.
- **A count that matches posts nothing,** and a device that expected another amount (it missed a sale) gets an
  `expected_differs` row with both numbers. The device's number is kept as it was sent (`2400`). No new bell. A shift
  number used again is `pos_number_taken`, and posts nothing.
- **A pay out after the close is kept** (decision 51), with the shift's status in its audit row. The close does not
  change: what was counted, against what was expected then.

**A shift nobody can count.**

- **Kamal closes shift 3 online with a note:** no count and no entry, `closedBy` is Kamal, and the expected cash then
  is the opening plus one sale. Sumi cannot (403); a second close is `pos_shift_closed`; an id nobody has is 404.
- **The counter PC was offline:** it sold once more on shift 3, counted ৳2,502.50 (all there) and closed. Both arrive
  after Kamal's close. The sale is kept, the count is in the audit log only (decision 38), and the next shift opens with
  the same ৳2,502.50 and posts nothing. This is the test that found decision 63: before the fix, the opening was
  compared with ৳2,445 and the late sale's ৳57.50 posted to over/short as well.
- **A revoke closes the open shift of the device by itself,** with the expected cash and an audit row that says
  `revoke` and names the device. The register is free, and the lost laptop can push nothing more (`device_revoked`).

**A cashier's shift.** Sumi opens POS2's first shift with ৳300 and no reason: only a device with a bug does that, and
over/short (POS2's income account) takes the money. Then her role is taken away while the tablet waits: the pay in and
the close go through, each with a `pos_shift.without_permission` row (decision 25), and ৳1 short rings the bell at
POS2's limit of 0. The role comes back at once, so the later tests are not about it.

**The managers' list.** Newest first by register, with the open shift's expected cash worked out as it is read; by
status; and the pages of two give the same shifts as one page of 100. Sumi and Rafiq get 403 on the list and the page.

**The pull.** A device gets the active reasons only (the lunch reason is archived) and each register with its latest
shift. The next pull has a renamed reason as an upsert, an archived one as a delete, and the register again after its
shift closed: that is 0054's change log line for a shift.

**What a shift posts.** Reverse refuses a shift's entry (`journal_is_pos`). An account only a reason points at, and one
only a register's over/short points at, cannot be deleted (`account_in_use`).

**At the same moment.** Each test sends two requests with `Promise.all`, so the order is not fixed, and each accepts
either order but checks the end state.

- **Two opens of one register:** one accepted and one `pos_shift_already_open`; one open shift. The register is locked
  `FOR UPDATE`, so the second waits and then sees the first.
- **A manager's close and a sale:** both go through. The stored expected cash has the sale in it or not, and the
  register's `cashLeft` has it either way (decision 63).
- **A device's close and a manager's close:** one closes it. If the manager was first, the count is in the audit log;
  if the device was first, the manager gets `pos_shift_closed`.
- **An open and a revoke:** whichever is first, no shift is left open and the register is free. The open is accepted
  and then closed by the revoke, or refused (`pos_register_not_held`, or `device_revoked` for the whole push).

### `pos/pos.tenant-leak.int.spec.ts`: the reasons and the shifts

```diff
@@ -8,12 +8,17 @@ import {
   customerSchema,
   type Device,
   deviceSchema,
+  type PosCashReason,
+  posCashReasonListSchema,
+  posCashReasonSchema,
   type PosRegister,
   posRegisterListSchema,
   posRegisterSchema,
   type PosSale,
   posSalePageSchema,
   posSaleSchema,
+  posShiftPageSchema,
+  posShiftSchema,
   problemSchema,
   type Product,
   productSchema,
@@ -51,7 +56,7 @@ import { bearer, type SignedIn, signUp } from '../testing/http.js';
 // Step 20a. Two shops: A must never see, change, take or let go of B's registers, nor read B's
 // sales or what B sold short; and a sale A's counter pushes takes none of B's registers,
 // customers, items, VAT rates or batches. Every answer is 404, or the same refusal as for an id
-// that does not exist.
+// that does not exist. Step 20b: the same for B's pay in and pay out reasons and B's shifts.
 let pg: TestPostgres;
 let redis: TestRedis;
 let app: NestFastifyApplication;
@@ -78,6 +83,9 @@ let a: Shop;
 let b: Shop;
 // B's sale: Napa it did not have enough of, for its customer
 let saleOfB: PosSale;
+// B's float reason, and the shift B's counter has open
+let reasonOfB: PosCashReason;
+let shiftOfB: string;
 
 type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
 type SaleLine = SaleCommand['input']['lines'][number];
@@ -112,7 +120,51 @@ function variantOf(product: Product): string {
   return variant.id;
 }
 
-function registerForm(code: string, warehouseId: string, cash: string) {
+function accountOf(shop: Pick<Shop, 'accounts'>, code: string): string {
+  const account = shop.accounts.find((item) => item.code === code);
+  if (!account) throw new Error(`no account ${code}`);
+  return account.id;
+}
+
+function shiftOpen(shop: Shop, sequence: number, total: string, floatReasonId = '') {
+  return {
+    id: v7(),
+    type: 'pos_shift.open',
+    shiftId: v7(),
+    input: {
+      registerId: shop.register.id,
+      sequence,
+      date: '2026-10-27',
+      openedAt: '2026-10-27T03:00:00.000Z',
+      opening: { notes: null, total },
+      floatReasonId,
+    },
+  } satisfies SyncCommandInput;
+}
+
+function shiftMove(shiftId: string, reasonId: string) {
+  return {
+    id: v7(),
+    type: 'pos_cash_movement.create',
+    movementId: v7(),
+    input: {
+      shiftId,
+      reasonId,
+      amount: '100',
+      note: '',
+      date: '2026-10-27',
+      movedAt: '2026-10-27T05:00:00.000Z',
+    },
+  } satisfies SyncCommandInput;
+}
+
+function overShortOf(shop: Pick<Shop, 'accounts'>): string {
+  const account = shop.accounts.find((item) => item.code === '5350');
+  if (!account) throw new Error('no over/short account');
+  return account.id;
+}
+
+function registerForm(code: string, warehouseId: string, cash: string, overShort: string) {
   return {
     code,
     name: `Counter ${code}`,
@@ -121,6 +173,9 @@ function registerForm(code: string, warehouseId: string, cash: string) {
     maxDiscountPercent: '',
     paperWidth: '80',
     receiptFooter: '',
+    overShortAccountId: overShort,
+    varianceAlert: '500',
+    lockAfter: '5',
   };
 }
 
@@ -224,7 +279,7 @@ async function open(company: string, slug: string, fullName: string, email: stri
     who,
     'POST',
     '/pos/registers',
-    registerForm('POS1', store.id, cashOf({ accounts })),
+    registerForm('POS1', store.id, cashOf({ accounts }), overShortOf({ accounts })),
   );
   expect(made1.statusCode, made1.body).toBe(201);
   const shop: Shop = {
@@ -289,7 +344,7 @@ function sale(
   };
 }
 
-async function pushed(shop: Shop, commands: SaleCommand[]) {
+async function pushed(shop: Shop, commands: SyncCommandInput[]) {
   const res = await as(shop.who, 'POST', '/sync/push', {
     deviceId: shop.device.id,
     protocol: SYNC_PROTOCOL,
@@ -327,6 +382,19 @@ beforeAll(async () => {
   if (!first) throw new Error('B has no sale');
   saleOfB = posSaleSchema.parse((await as(b.who, 'GET', `/pos/sales/${first.id}`)).json());
   expect(saleOfB.soldShort).toBe(true);
+
+  // B's counter opens its first shift with ৳2,000 from the owner
+  const reason = await as(b.who, 'POST', '/pos/cash-reasons', {
+    name: 'Float from the owner',
+    direction: 'in',
+    accountId: accountOf(b, '3100'),
+  });
+  expect(reason.statusCode, reason.body).toBe(201);
+  reasonOfB = posCashReasonSchema.parse(reason.json());
+  const opening = shiftOpen(b, 1, '2000', reasonOfB.id);
+  shiftOfB = opening.shiftId;
+  const [opened] = await pushed(b, [opening]);
+  expect(opened?.status, JSON.stringify(opened)).toBe('accepted');
 }, 180_000);
 
 afterAll(async () => {
@@ -344,7 +412,7 @@ describe("another workspace's registers", () => {
       as(a.who, 'GET', `/pos/registers/${id}`),
       // A valid form of A's own, so the answer is about whose register it is
       as(a.who, 'PUT', `/pos/registers/${id}`, {
-        ...registerForm('POS1', a.store.id, cashOf(a)),
+        ...registerForm('POS1', a.store.id, cashOf(a), overShortOf(a)),
         ...version,
       }),
       as(a.who, 'POST', `/pos/registers/${id}/archive`, version),
@@ -353,8 +421,12 @@ describe("another workspace's registers", () => {
       as(a.who, 'POST', `/pos/registers/${id}/release`, { deviceId: a.device.id }),
     ]);
     expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
-    // Still B's, held by B's counter, with B's one sale
-    expect(await registerOfBNow()).toEqual({ ...b.register, lastNumber: 1 });
+    // Still B's, held by B's counter, with B's one sale and B's open shift
+    expect(await registerOfBNow()).toEqual({
+      ...b.register,
+      lastNumber: 1,
+      lastShift: { id: shiftOfB, sequence: 1, status: 'open', cashLeft: null },
+    });
     const list = posRegisterListSchema.parse((await as(a.who, 'GET', '/pos/registers')).json());
     expect(list.items.map((item) => item.id)).toEqual([a.register.id]);
     const branch = posRegisterListSchema.parse(
@@ -383,7 +455,7 @@ describe("another workspace's registers", () => {
       a.who,
       'POST',
       '/pos/registers',
-      registerForm('POS2', b.store.id, cashOf(a)),
+      registerForm('POS2', b.store.id, cashOf(a), overShortOf(a)),
     );
     expect(problemOf(store).fieldErrors).toEqual({
       warehouseId: ['pos_register_warehouse_invalid'],
@@ -392,7 +464,7 @@ describe("another workspace's registers", () => {
       a.who,
       'POST',
       '/pos/registers',
-      registerForm('POS2', a.store.id, cashOf(b)),
+      registerForm('POS2', a.store.id, cashOf(b), overShortOf(a)),
     );
     expect(problemOf(cash).fieldErrors).toEqual({
       'accounts.cash': ['pos_register_account_invalid'],
@@ -463,3 +535,126 @@ describe("another workspace's sales", () => {
     expect(own.lastNumber).toBe(5);
   });
 });
+
+describe("another workspace's reasons and shifts", () => {
+  it('are not read, changed, archived, restored or closed', async () => {
+    const own = await as(a.who, 'POST', '/pos/cash-reasons', {
+      name: 'Float from the owner',
+      direction: 'in',
+      accountId: accountOf(a, '3100'),
+    });
+    expect(own.statusCode, own.body).toBe(201);
+    const ownReason = posCashReasonSchema.parse(own.json());
+    const version = { version: reasonOfB.version };
+    const answers = await Promise.all([
+      as(a.who, 'PUT', `/pos/cash-reasons/${reasonOfB.id}`, {
+        name: 'Taken over',
+        accountId: accountOf(a, '3100'),
+        ...version,
+      }),
+      as(a.who, 'POST', `/pos/cash-reasons/${reasonOfB.id}/archive`, version),
+      as(a.who, 'POST', `/pos/cash-reasons/${reasonOfB.id}/restore`, version),
+      as(a.who, 'GET', `/pos/shifts/${shiftOfB}`),
+      as(a.who, 'POST', `/pos/shifts/${shiftOfB}/close-without-count`, { note: '' }),
+    ]);
+    expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404]);
+    for (const status of ['', '?status=archived']) {
+      const list = posCashReasonListSchema.parse(
+        (await as(a.who, 'GET', `/pos/cash-reasons${status}`)).json(),
+      );
+      expect(list.items.map((item) => item.id)).toEqual(status === '' ? [ownReason.id] : []);
+    }
+    for (const query of ['', `?registerId=${b.register.id}`, '?status=open']) {
+      const page = posShiftPageSchema.parse((await as(a.who, 'GET', `/pos/shifts${query}`)).json());
+      expect(page.items).toEqual([]);
+    }
+    // Still B's, as it was, and still open
+    const reasonNow = posCashReasonListSchema.parse(
+      (await as(b.who, 'GET', '/pos/cash-reasons')).json(),
+    );
+    expect(reasonNow.items).toEqual([reasonOfB]);
+    const shift = posShiftSchema.parse((await as(b.who, 'GET', `/pos/shifts/${shiftOfB}`)).json());
+    expect(shift).toMatchObject({ status: 'open', movements: [], closedBy: null });
+  });
+
+  it("are not made with B's accounts", async () => {
+    const reason = await as(a.who, 'POST', '/pos/cash-reasons', {
+      name: 'Cash to the bank',
+      direction: 'out',
+      accountId: accountOf(b, '3100'),
+    });
+    expect(problemOf(reason).fieldErrors).toEqual({ accountId: ['pos_reason_account_invalid'] });
+    const register = await as(
+      a.who,
+      'POST',
+      '/pos/registers',
+      registerForm('POS2', a.store.id, cashOf(a), overShortOf(b)),
+    );
+    expect(problemOf(register).fieldErrors).toEqual({
+      overShortAccountId: ['pos_over_short_invalid'],
+    });
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
+    const reasons = changes.filter((change) => change.entity === 'pos_cash_reason');
+    expect(reasons.map((change) => change.key)).not.toContain(reasonOfB.id);
+    expect(JSON.stringify(changes)).not.toContain(shiftOfB);
+  });
+
+  it("are not used by A's counter", async () => {
+    // A's first shift with B's float reason: the same refusal as a reason nobody has
+    const [float] = await pushed(a, [shiftOpen(a, 1, '1500', reasonOfB.id)]);
+    expect(float?.status === 'rejected' ? float.error.code : float?.status).toBe(
+      'pos_float_reason_required',
+    );
+    const opening = shiftOpen(a, 1, '0');
+    const [opened] = await pushed(a, [opening]);
+    expect(opened?.status, JSON.stringify(opened)).toBe('accepted');
+    const [ownReason] = posCashReasonListSchema.parse(
+      (await as(a.who, 'GET', '/pos/cash-reasons')).json(),
+    ).items;
+    if (!ownReason) throw new Error('A has no reason');
+    const onB = sale(a, 6, [line(a)]);
+    const results = await pushed(a, [
+      shiftMove(shiftOfB, ownReason.id),
+      shiftMove(opening.shiftId, reasonOfB.id),
+      { ...onB, input: { ...onB.input, shiftId: shiftOfB } },
+      {
+        id: v7(),
+        type: 'pos_shift.close',
+        shiftId: shiftOfB,
+        input: {
+          date: '2026-10-27',
+          closedAt: '2026-10-27T15:00:00.000Z',
+          counted: { notes: null, total: '0' },
+          deviceExpected: '0',
+          heldDropped: 0,
+        },
+      },
+    ]);
+    expect(
+      results.map((result) => (result.status === 'rejected' ? result.error.code : null)),
+    ).toEqual([
+      'pos_shift_unknown',
+      'pos_reason_required',
+      'pos_shift_unknown',
+      'pos_shift_unknown',
+    ]);
+    // B's shift took nothing of it
+    const shift = posShiftSchema.parse((await as(b.who, 'GET', `/pos/shifts/${shiftOfB}`)).json());
+    expect(shift).toMatchObject({
+      status: 'open',
+      saleCount: 0,
+      movements: [],
+      expectedCash: '2000.0000',
+    });
+  });
+});
```

- **`registerForm()` takes the over/short account as its own argument,** so a test can mix a shop's warehouse or cash
  with the other shop's over/short account.
- **B opens a shift before the tests,** with its own float reason. The first test's check of B's register now expects
  that shift as `lastShift`.
- **Every route of B's reasons and shifts answers A with 404,** and A's lists have only A's own (or nothing). B's
  reason and shift are the same afterwards.
- **A reason with B's account and a register with B's over/short account** are refused with the same codes as an id
  that does not exist.
- **A's pull has no reason of B, and no word of B's shift.**
- **A's counter cannot use B's float reason, B's shift or B's reason:** a pay in on B's shift, a pay in on A's shift
  with B's reason, a sale on B's shift and a close of B's shift are each refused like an id nobody has. B's shift took
  nothing of it.

> **What we checked.** The API's type check, lint and unit tests (123). `pos-shifts.int.spec.ts` (27 tests, three runs,
> so the races ran in more than one order), `pos.int.spec.ts` (31) and `pos.tenant-leak.int.spec.ts` (10) against a
> real Postgres and Redis. The sync, device, setup, journal and accounts suites (194). Broken on purpose: with the
> opening compared with the stored expected cash again, "keeps what the device sends after the manager's close" fails.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api lint
cd apps/api
npx vitest run src/pos src/sync --maxWorkers=3
```

The i18n, sync and app packages still fail as listed at the end of 20b.1, until their parts.

## 20b.5 — `packages/i18n`: the words

The screens of 20b.6 need their words in English and Bangla, so they come first. This part changes only the two locale
files. The ui package needs nothing new: the count is a grid of number inputs, pay in and pay out are a dialog with a
select, the money input and a text box, the managers' pages are a data table and a document page, and the reasons page
is a data table with a form dialog, like the registers page.

When this part starts, `packages/i18n` does not type-check: the `errors` object misses the 17 shift codes and
`journal_is_pos` of 20b.1. The app looks up the words of every permission, audit action and entity type, journal
source, sync command and bell type, and 20b.1 added one or more of each. When this part ends, the i18n package and the
ui package type-check, and the app fails only in its own code that 20b.6 and 20b.7 change: `notification-bell.tsx`
(where the new bell's row opens), `sync-parts.tsx` (how the Sync page names the three commands),
`routes/pos-registers.tsx` (the form's three new fields) and the mocks (`mocks/pos-data.ts`, `mocks/push-data.ts`).

### `locales/en.ts`

```diff
@@ -131,6 +131,10 @@ export const en = {
     registers: 'POS registers',
     posSales: 'POS sales',
     soldShort: 'Sold short',
+    // Step 20b: the managers' shifts (under Sales) and the pay in / pay out reasons (a workspace
+    // setting, next to POS registers)
+    posShifts: 'POS shifts',
+    cashReasons: 'POS cash reasons',
   },
   auth: {
     workspace: 'Workspace',
@@ -535,6 +539,10 @@ export const en = {
       },
       // Step 20a: {{name}} is the sale's number (POS1-000123)
       pos_sale: { create: 'Sale {{name}}' },
+      // Step 20b: {{name}} is the shift's number (POS1-S0042), or for a movement the words of
+      // pos.cash.done ("৳10,000 paid out for Bank deposit")
+      pos_shift: { open: 'Shift {{name}} opened', close: 'Shift {{name}} closed' },
+      pos_cash_movement: { create: 'Drawer: {{name}}' },
     },
     savedAt: 'Saved {{time}}',
     // fields = the form's own labels, joined in the page's language ("Phone and Credit limit")
@@ -672,6 +680,9 @@ export const en = {
       // The server's key no longer opens the copy (key-changed): the PIN opens it once, and the
       // copy then follows the server's new key
       keyChangedDescription: 'Omnivo needs the PIN once to open the work saved on this device.',
+      // Step 20b (decision 7): the register's idle lock on /pos. {{minutes}} in the page's digits
+      idleDescription:
+        'Nobody used the POS for {{minutes}} minutes, so it locked itself. Type the PIN of this device to go on.',
       unlock: 'Unlock',
       unlocking: 'Unlocking…',
       forgot: 'Forgot PIN? Sign in with your password',
@@ -872,6 +883,7 @@ export const en = {
       purchase_debit_note: 'Debit note',
       purchase_refund: 'Supplier refund',
       pos_sale: 'POS sale',
+      pos_shift: 'POS shift',
     },
     fromDocument: 'From {{document}}',
     stockEntryHint:
@@ -891,6 +903,9 @@ export const en = {
       'A debit note made this entry. A posted debit note stays as it is, so the entry is not reversed here.',
     supplierRefundEntryHint:
       'A supplier refund made this entry. To undo it, void the refund on its own page.',
+    // Step 20b (decision 28): the journal's Reverse refuses a shift's entries
+    posShiftEntryHint:
+      'A POS shift made this entry. It is not reversed: a wrong count is put right by the next shift’s opening count, and a wrong pay in or pay out by one the other way.',
     draftSaved: 'Draft saved',
     posted: '{{number}} posted',
     deleted: 'Draft deleted',
```

- **Two new pages, two nav items** (decision 67). `posShifts` is under Sales, next to POS sales: the managers read a
  shift as they read the sales. `cashReasons` is a workspace setting, next to POS registers, because the same person
  sets both up.
- **`sync.commands.pos_shift` and `pos_cash_movement`** name the waiting commands on the Sync page. A shift is named by
  its number (`POS1-S0042`). A movement's `name` is the toast's own sentence (`pos.cash.done`, "৳10,000 paid out for
  Bank deposit"), so the cashier sees the same words twice.
- **`pin.lock.idleDescription`** is the third reason the lock screen gives (decision 7), next to the offline reload
  and the changed key. `minutes` is the register's "Lock after", in the page's digits, so the cashier knows why the
  screen locked while they were away.
- **`journal.sources.pos_shift`** names the entries of a shift, and **`posShiftEntryHint`** is the line the journal
  shows under such an entry, like the invoice's (decision 28). It says how a mistake is put right, so nobody looks
  for a Reverse button.

```diff
@@ -3969,6 +3984,25 @@ export const en = {
     paperWidthHint: 'The width of the roll in this counter’s receipt printer.',
     receiptFooter: 'Receipt footer',
     receiptFooterPlaceholder: 'Goods once sold are exchanged within 7 days with this receipt.',
+    // Step 20b: the shift settings (decisions 5, 7, 13–15)
+    shiftTitle: 'Shifts',
+    shiftHint: 'A cashier counts the drawer when a shift opens and again when it closes.',
+    overShortAccount: 'Cash over and short account',
+    overShortHint:
+      'A difference in a count posts here. An income or expense account, like 5350 Cash over and short.',
+    varianceAlert: 'Bell for a difference over (৳)',
+    varianceAlertHint:
+      'Whole taka. The managers get a bell when a close is off by more than this. Empty or 0 means any difference.',
+    lockAfter: 'Lock the POS after',
+    lockAfterHint:
+      'Time with no touch, click or key on the POS. The cashier unlocks it with this device’s PIN.',
+    lockAfters: {
+      off: 'Never',
+      '2': '2 minutes',
+      '5': '5 minutes',
+      '10': '10 minutes',
+      '15': '15 minutes',
+    },
     show: 'Show',
     statuses: { active: 'Active', archived: 'Archived' },
     columns: {
```

The register's form gets a "Shifts" group of three fields (decisions 5, 7, 13–15):

- **`overShortHint` names the kind of account and gives an example,** the 5350 that 20b.3 adds to new retail
  workspaces. An older workspace has no such account, and the hint tells the person what to add.
- **`varianceAlertHint` says what an empty box means** (decision 14): the schema turns it into `0`, a bell for any
  difference. "More than this" is decision 14's rule: a difference of exactly the limit rings no bell.
- **`lockAfters` keys are `off`, `'2'` … `'15'`,** the values of `POS_LOCK_AFTER`, so the select writes
  `` t(`registers.lockAfters.${value}`) `` with no map of its own, like the paper widths.

```diff
@@ -4089,6 +4123,114 @@ export const en = {
     savedOnDevice: 'Saved on this device. It syncs when the connection is back.',
     printAgain: 'Print again',
     newSale: 'New sale',
+    // Step 20b: the shift on the counter (decisions 1, 3, 6, 8, 12). The opening and the close
+    // are both counts, and both are blind: what the drawer should hold shows after the count
+    shift: {
+      number: 'Shift {{number}}',
+      openTitle: 'Open a shift',
+      openDescription:
+        'Count the cash in the drawer before the first sale. You sell on this shift until you close it.',
+      // The count, by notes or as one total (decision 8). {{note}} is a note's value (৳500)
+      countBy: 'Count',
+      countModes: { notes: 'By notes', total: 'As a total' },
+      notesLegend: 'Notes and coins in the drawer',
+      noteCount: 'How many {{note}}',
+      noteAmount: '= {{amount}}',
+      countTotal: 'Cash in the drawer',
+      notesTotal: 'Total {{amount}}',
+      // A register's first shift (decision 12): the count comes in as a pay in
+      firstShift: 'This is the first shift of {{code}}. Where does this cash come from?',
+      floatReason: 'Brought in as',
+      floatReasonPlaceholder: 'Pick a reason',
+      noInReasons:
+        'No pay in reason yet. Someone with pos.register.manage adds one in Settings → POS cash reasons, like Float from the safe.',
+      open: 'Open shift',
+      opened: 'Shift {{number}} is open',
+      // After the open: what the last shift left, and the difference ("৳100 short", posShifts.*)
+      openedEven: 'The drawer has what the last shift left: {{amount}}.',
+      openedDifference:
+        'The last shift left {{expected}}. Your count is {{difference}}, and that goes to the books.',
+      // Why a shift cannot open (decisions 7 and 13)
+      needsOverShort:
+        '{{code}} has no cash over and short account, so no shift can open. Someone with pos.register.manage picks one in Settings → POS registers.',
+      needsPin:
+        '{{code}} locks itself when nobody uses it, so this device needs a PIN before a shift opens.',
+      // Decision 6: a shift left open (yesterday's) is closed before the next sale
+      leftOpen: 'Shift {{number}} has been open since {{time}}. Close it before the next sale.',
+      // The top bar's shift menu; openedBy is its first line, when and by whom
+      menu: 'Shift {{number}} menu',
+      openedBy: 'Opened {{time}} · {{name}}',
+      payIn: 'Pay in',
+      payOut: 'Pay out',
+      close: 'Close shift',
+      changeRegisterOpen: 'Shift {{number}} is open. Close it, then change the register.',
+    },
+    // Pay in and pay out (decision 4), keyed by the reason's direction. The cashier never sees
+    // what the drawer holds: that would end the blind count
+    cash: {
+      titles: { in: 'Pay in', out: 'Pay out' },
+      descriptions: {
+        in: 'Money put into the drawer. Pick why it comes in.',
+        out: 'Money taken out of the drawer. Pick why it goes, and keep the slip.',
+      },
+      reason: 'Reason',
+      reasonPlaceholder: 'Pick a reason',
+      amount: 'Amount',
+      note: 'Note',
+      notePlaceholder: 'Deposit slip 0042',
+      noReasons: {
+        in: 'No pay in reason yet. Someone with pos.register.manage adds one in Settings → POS cash reasons.',
+        out: 'No pay out reason yet. Someone with pos.register.manage adds one in Settings → POS cash reasons.',
+      },
+      save: { in: 'Pay in {{amount}}', out: 'Pay out {{amount}}' },
+      // The toast, and the Sync page's name of the waiting movement
+      done: { in: '{{amount}} paid in for {{reason}}', out: '{{amount}} paid out for {{reason}}' },
+    },
+    // Held bills (step 20 decision 10): on this device only, never sent, dropped at the close
+    hold: {
+      hold: 'Hold',
+      title: 'Hold this bill',
+      description:
+        'The cart waits on this device while you serve the next customer. Its prices stay; the stock is checked again when the customer pays.',
+      name: 'Name',
+      namePlaceholder: 'Customer in the blue shirt',
+      save: 'Hold bill',
+      held: 'Bill held',
+      list: 'Held ({{formatted}})',
+      listTitle: 'Held bills',
+      listDescription: 'They stay on this device only, and are dropped when the shift closes.',
+      unnamed: 'Held at {{time}}',
+      row: '{{items}} · {{total}}',
+      resume: 'Resume',
+      drop: 'Drop {{name}}',
+      dropped: 'Held bill dropped',
+      resumeHolds: 'The cart on the screen is held first, so nothing is lost.',
+      full: 'This device holds {{max}} bills already. Resume or drop one first.',
+      emptyTitle: 'No held bills',
+      emptyBody: 'Press F8 to hold a cart while you serve the next customer.',
+    },
+    // Closing the shift (decisions 3, 6, 9): the count, then the result
+    close: {
+      title: 'Close shift {{number}}',
+      description: 'Count the cash in the drawer. What Omnivo expects shows after you close.',
+      heldDropped_one: '{{formatted}} held bill is dropped when the shift closes.',
+      heldDropped_other: '{{formatted}} held bills are dropped when the shift closes.',
+      final: 'The count can’t change after the shift is closed.',
+      confirm: 'Close the shift',
+      doneTitle: '{{number}} is closed',
+      counted: 'Counted',
+      expected: 'Expected',
+      difference: 'Difference',
+      even: 'The drawer has exactly what was expected.',
+      over: 'The drawer has {{amount}} more than expected. It goes to the books as cash over.',
+      short: 'The drawer has {{amount}} less than expected. It goes to the books as cash short.',
+      next: 'Open the next shift',
+      // Decision 6: sign-out waits for the close
+      signOutTitle: 'Close the shift first',
+      signOutBody:
+        'Shift {{number}} is open on this device. Count the drawer and close the shift, then sign out.',
+      signOutClose: 'Close shift',
+    },
     // Keyboard shortcuts (decision 12)
     shortcuts: 'Keyboard shortcuts',
     keys: {
@@ -4099,6 +4241,8 @@ export const en = {
       complete: 'Complete the sale',
       newSale: 'New sale',
       help: 'Show these shortcuts',
+      hold: 'Hold the bill',
+      held: 'Held bills',
     },
     // The thermal receipt (decision 6), 58 or 80 mm. The company lines reuse print.*
     receipt: {
@@ -4144,6 +4288,8 @@ export const en = {
     device: 'Device',
     cashier: 'Cashier',
     customer: 'Customer',
+    // Step 20b: a sale's shift; 20a's sales have none
+    shift: 'Shift',
     lines: 'Items',
     batches: 'Batch {{lot}} · {{quantity}}',
     serials: 'Serial numbers: {{serials}}',
```

**`pos.shift`, opening the shift:**

- **The count has two modes,** by notes and as a total (decision 8). `noteCount` is the label of each note's box ("How
  many ৳500"), so a screen reader says which note the number is for; `noteAmount` is the "= ৳2,000" next to it.
- **`firstShift` asks a question the cashier can answer** (decision 12): "Where does this cash come from?", not
  "Pick a float reason". `noInReasons` says who adds one, and where.
- **The open is blind** (decision 65): the card has no "the last shift left" line. `openedEven` and
  `openedDifference` are the toast after it. `difference` arrives as words (`posShifts.over` / `short`).
- **`needsOverShort` and `needsPin`** are the two reasons a shift cannot open (decisions 13 and 7). Both name the
  register and say what to do; `needsPin` sits next to the PIN dialog's button (`pin.card.set`).
- **`leftOpen`** is decision 6: the device finds its own shift still open from yesterday, and the screen asks for the
  close before the next sale.

**`pos.cash`, pay in and pay out:**

- **Every text that differs by direction is keyed by `in` / `out`,** the reason's `direction`, so the dialog writes
  `` t(`pos.cash.titles.${direction}`) ``. One dialog serves both.
- **The dialog never says what the drawer holds.** That number would end the blind count (decision 3). A pay out that
  is too big gets `pos_pay_out_too_large` under the box instead.
- **`notePlaceholder` is a deposit slip number,** because a pay out to the bank is the one the manager checks
  against paper.

**`pos.hold`, held bills** (step 20 decision 10, decision 68):

- **`description` says the two things a cashier asks:** the prices stay, and the stock is checked again when the
  customer pays. `listDescription` says the held bills live on this device only and go when the shift closes.
- **`unnamed` names a bill held without a name** by its time, so two unnamed bills read apart.
- **`resumeHolds`** says that resuming a bill while another cart is on the screen holds that cart first.

**`pos.close`, closing the shift:**

- **`description` says the expected cash shows after the close** (decision 3), so the cashier does not look for it.
  `final` says the count can't change afterwards (decision 9), next to the button.
- **`heldDropped_one` / `_other`** warn about held bills before the close drops them (decision 23).
- **The result reads like the POS's "done" dialog:** a headline, then `over`, `short` or `even`, which say where the
  money goes in the books. The numbers under it reuse `posShifts.cash`, the labels of the shift page.
- **`signOutTitle` and `signOutBody`** are decision 6: signing out with a shift open opens this dialog, and its only
  primary button leads to the close.

**`pos.keys.hold` and `held`** are the two new lines of the shortcuts dialog. **`posSales.shift`** is the sale page's
new field; 20a's sales show a dash.

```diff
@@ -4187,6 +4333,138 @@ export const en = {
     emptyBody: 'When a counter sells more than its warehouse has, the item shows here.',
     loadFailed: "Couldn't load the list. Refresh the page to try again.",
   },
+  // Step 20b: the managers' list of shifts and a shift's page (pos.shift.manage, decision 26)
+  posShifts: {
+    title: 'POS shifts',
+    description: 'Each cashier’s count of the drawer, and the cash the books expected',
+    back: 'POS shifts',
+    register: 'Register',
+    allRegisters: 'All registers',
+    show: 'Show',
+    // 20b.6b: the status filter's first choice
+    allStatuses: 'All shifts',
+    // Decision 11: a shift closed without a count has its own pill
+    statuses: { open: 'Open', closed: 'Closed', closed_without_count: 'Not counted' },
+    columns: {
+      shift: 'Shift',
+      register: 'Register',
+      cashier: 'Cashier',
+      opened: 'Opened',
+      closed: 'Closed',
+      expected: 'Expected',
+      counted: 'Counted',
+      difference: 'Difference',
+      status: 'Status',
+    },
+    // A difference in words (counted less expected), also for the bell and the POS screen
+    over: '{{amount}} over',
+    short: '{{amount}} short',
+    even: 'No difference',
+    // The page
+    device: 'Device',
+    cashier: 'Cashier',
+    openedAt: 'Opened',
+    closedAt: 'Closed',
+    opening: 'Opening',
+    openingCounted: 'Counted at the open',
+    lastLeft: 'The last shift left',
+    firstShift: 'The register’s first shift',
+    floatReason: 'Brought in as',
+    closing: 'Closing',
+    deviceExpected: 'The device expected',
+    heldDropped: 'Held bills dropped',
+    countColumns: { note: 'Note', count: 'Count', amount: 'Amount' },
+    asTotal: 'Counted as a total',
+    cash: {
+      title: 'Cash in the drawer',
+      opening: 'Opening count',
+      cashTaken: 'Cash taken',
+      changeGiven: 'Change given',
+      paidIn: 'Paid in',
+      paidOut: 'Paid out',
+      expected: 'Expected',
+    },
+    payments: 'Taken by method',
+    sales_one: '{{formatted}} sale · {{total}}',
+    sales_other: '{{formatted}} sales · {{total}}',
+    movements: 'Pay ins and pay outs',
+    movementColumns: {
+      time: 'Time',
+      reason: 'Reason',
+      direction: 'Kind',
+      amount: 'Amount',
+      note: 'Note',
+      entry: 'Journal entry',
+    },
+    directions: { in: 'Pay in', out: 'Pay out' },
+    noMovements: 'No money was put in or taken out.',
+    entriesTitle: 'Journal entries',
+    entries: { opening: 'Opening difference', float: 'Float', closing: 'Closing difference' },
+    // Decision 22: the books keep the server's number
+    expectedDiffers:
+      'The device expected {{device}} and the server {{server}}: a sale or a pay in or out is missing on one side. The books use the server’s number.',
+    withoutCount:
+      'Nobody counted this drawer, so no difference was posted. The next shift’s opening count finds any money that is missing.',
+    closedBy: 'Closed by {{name}} · {{time}}',
+    stillOpen: 'Open since {{time}}. The expected cash counts what has synced so far.',
+    // Decisions 11 and 27: a manager closes a stuck shift online, with a note for the audit log
+    closeWithoutCount: 'Close without a count',
+    closeTitle: 'Close {{number}} without a count?',
+    closeBody:
+      'For a shift its cashier can’t close: a lost device, or someone who went home. Nothing posts now; the next shift’s opening count finds any money that is missing.',
+    closeNote: 'Why',
+    closeNotePlaceholder: 'Sumi went home sick; the drawer went to the safe.',
+    closeConfirm: 'Close without a count',
+    closedToast: '{{number}} closed without a count',
+    notFound: "This POS shift doesn't exist.",
+    needsConnection: 'POS shifts are read from the server. Connect to the internet to see them.',
+    emptyTitle: 'No shifts yet',
+    emptyBody: 'A shift starts when a cashier counts the drawer on the POS screen.',
+    loadFailed: "Couldn't load the POS shifts. Refresh the page to try again.",
+  },
+  // Step 20b: why money goes into or out of a drawer (decisions 4, 20, 46)
+  posCashReasons: {
+    title: 'POS cash reasons',
+    description:
+      'Why a cashier puts money into the drawer or takes it out, and the account it moves to',
+    add: 'Add reason',
+    newTitle: 'Add a reason',
+    editTitle: 'Edit {{name}}',
+    name: 'Name',
+    namePlaceholder: 'Bank deposit',
+    direction: 'Kind',
+    directions: {
+      in: 'Pay in: money comes into the drawer',
+      out: 'Pay out: money goes out of the drawer',
+    },
+    // Decision 20: the edit form shows the kind, but not as a choice
+    directionLocked:
+      'A reason stays a pay in or a pay out, so the money it moved keeps its meaning. Add another reason for the other way.',
+    account: 'Account',
+    accountHints: {
+      in: 'Where the money comes from: the safe, a bank, the owner.',
+      out: 'Where the money goes: a bank, the safe, or an expense like tea for the staff.',
+    },
+    accountPlaceholder: 'Pick an account',
+    show: 'Show',
+    statuses: { active: 'Active', archived: 'Archived' },
+    columns: { reason: 'Reason', direction: 'Kind', account: 'Account', status: 'Status' },
+    pills: { in: 'Pay in', out: 'Pay out' },
+    archive: 'Archive',
+    restore: 'Restore',
+    created: '{{name}} added',
+    updated: 'Changes to {{name}} saved',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    readOnly: 'Ask a workspace owner for the pos.register.manage permission to change the reasons.',
+    emptyTitle: 'No reasons yet',
+    emptyBody:
+      'Add why your cashiers move money: a float from the safe, a bank deposit, tea for the staff.',
+    emptyArchivedTitle: 'No archived reasons',
+    emptyArchivedBody:
+      'A reason you no longer use can be archived. The money it moved stays in the books.',
+    loadFailed: "Couldn't load the reasons. Refresh the page to try again.",
+  },
   approvals: {
     title: 'Approvals',
     description: 'Documents waiting for your decision, oldest first',
```

Two new sections, before `approvals`, one per page, like the rest of the file.

**`posShifts`, the managers' list and the shift's page:**

- **`statuses` are the three pills** (decision 11). "Not counted" says what happened in two words, where "Closed
  without a count" would not fit a pill in the table.
- **`over`, `short` and `even` turn a signed difference into words** (decision 66), for the list, the page, the POS
  screen and the bell. "৳520 short" needs no minus sign and no colour to be read right.
- **The page has an opening block and a closing block,** each with its count: the notes table (`countColumns`) or
  `asTotal`. The opening says what it was compared with (`lastLeft`) or that it was the register's first shift, and
  the float's reason.
- **`cash` labels the parts of the expected cash,** in the order of `expectedCashOf()` (decision 19), so a manager can
  add them up by hand.
- **`expectedDiffers`** shows when the device's number is not the server's (decision 22). It says what that means and
  which number the books use.
- **`withoutCount`, `closedBy` and the close dialog** are decisions 11 and 27. `closeBody` says when to use it and that
  nothing posts now. The note is optional (`optionalText`), but its placeholder shows the kind of note the audit log
  needs.
- **`stillOpen`** says that an open shift's expected cash is what has synced so far (decision 60): a counter that is
  offline has sold more.

**`posCashReasons`, the settings page:**

- **`directions` say what the kind means for the drawer,** "Pay in: money comes into the drawer", because "in" alone
  could mean into the bank. `pills` are the short form for the table.
- **`directionLocked`** is decision 20: the edit form shows the kind as text, and says why it can't change and what to
  do instead.
- **`accountHints` are keyed by direction** and give examples of both sides (decision 46): where the money comes from
  for a pay in, where it goes for a pay out.

```diff
@@ -4727,6 +5005,10 @@ export const en = {
         override: 'At the POS, change a price or give more discount than the register allows',
       },
       register: { manage: 'Add, edit and archive POS registers' },
+      // Step 20b (decision 10)
+      shift: {
+        manage: 'See every register’s shifts and counts, and close a stuck shift without a count',
+      },
     },
   },
   invite: {
@@ -4799,6 +5081,8 @@ export const en = {
       device: 'Devices',
       pos_register: 'POS registers',
       pos_sale: 'POS sales',
+      pos_cash_reason: 'POS cash reasons',
+      pos_shift: 'POS shifts',
     },
     columns: {
       when: 'When',
@@ -5090,6 +5374,22 @@ export const en = {
         overridden: 'Changed a price or gave more discount at the POS',
         without_permission: 'Sold at a POS counter after losing the permission',
       },
+      // Step 20b. cash_moved: a pay in or pay out. closed_without_count: by a manager online or by
+      // a device's revoke (decision 11). expected_differs: decision 22
+      pos_cash_reason: {
+        created: 'Added a POS cash reason',
+        updated: 'Edited a POS cash reason',
+        archived: 'Archived a POS cash reason',
+        restored: 'Restored a POS cash reason',
+      },
+      pos_shift: {
+        opened: 'Opened a POS shift',
+        cash_moved: 'Put money into a drawer or took it out',
+        closed: 'Closed a POS shift',
+        closed_without_count: 'Closed a POS shift without a count',
+        expected_differs: 'The device and the server expected different cash at a close',
+        without_permission: 'Worked a POS shift after losing the permission',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -5236,6 +5536,27 @@ export const en = {
       overrides: 'Needs pos.price.override',
       allowed: 'Permission',
       missing: 'Missing permission',
+      // Step 20b: a register's shift settings, a reason, and a shift's rows
+      overShortAccount: 'Over and short account',
+      varianceAlert: 'Bell over (৳)',
+      lockAfter: 'Lock after (minutes)',
+      account: 'Account',
+      openedOn: 'Date on the device',
+      closedOn: 'Date on the device',
+      on: 'Date on the device',
+      opening: 'Opening count',
+      comparedWith: 'The last shift left',
+      floatReason: 'Brought in as',
+      note: 'Note',
+      shiftStatus: 'Shift status then',
+      statusBefore: 'Shift status then',
+      counted: 'Counted',
+      deviceExpected: 'The device expected',
+      expected: 'Expected',
+      server: 'The server expected',
+      heldDropped: 'Held bills dropped',
+      kept: 'Saved on the shift',
+      by: 'Closed by',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -5334,6 +5655,10 @@ export const en = {
       pos: {
         sold_short:
           '{{number}} sold more than {{warehouse}} had. Items below zero: {{count}}. Count them and put the stock right.',
+        // Step 20b (decision 29). {{difference}} arrives signed; the bell turns it into
+        // posShifts.over / posShifts.short ("৳520 short"), so one sentence reads right both ways
+        shift_variance:
+          '{{number}} on {{register}} closed {{difference}}. Open the shift to see the count.',
       },
     },
   },
```

- **`permissions.pos.shift.manage`** says what the permission allows in the managers' words (decision 10): see every
  register's counts, close a stuck shift.
- **`audit.entityTypes`** are the audit log's two new filters. **`audit.actions`** say what happened: `cash_moved` is
  "Put money into a drawer or took it out", and `expected_differs` names the two sides.
- **`audit.fields`** label every key 20b.3 writes: a register's three settings, a reason's account, and a shift's
  rows. `openedOn`, `closedOn` and `on` all read "Date on the device", like 20a's `soldOn`: the day the device said,
  next to the booked `date`. `kept` is a late close's "Saved on the shift: false" (decision 52); `by` reads "Closed by:
  manager" or "revoke".
- **The bell** (`pos.shift_variance`) names the shift and the register, and gets the difference as words (decision 66):
  "POS1-S0042 on Front counter closed ৳520 short."

```diff
@@ -5419,6 +5744,9 @@ export const en = {
     journal_not_draft: "This entry is posted and can't change. Reverse it instead.",
     journal_not_posted: 'Only a posted entry can be reversed. Delete the draft instead.',
     journal_is_reversal: "A reversal can't be reversed. Post a new entry instead.",
+    // Step 20b (decision 28)
+    journal_is_pos:
+      'A POS shift’s entry can’t be reversed. A wrong count is put right by the next shift’s count, and a wrong pay in or pay out by one the other way.',
     journal_already_reversed: 'This entry has been reversed already. Reload to see the reversal.',
     journal_reversal_date: "Pick a date on or after the entry's own date.",
     opening_date_required: 'Pick your first day on Omnivo.',
@@ -5951,6 +6279,34 @@ export const en = {
       'The register has no account for this payment method now. Someone with pos.register.manage sets one in Settings → POS registers, then retry the sale.',
     pos_number_taken:
       'Another sale of this register has this number. This should not happen: keep the paper receipt and tell your Omnivo administrator.',
+    // Step 20b: shifts
+    pos_over_short_required:
+      'Pick the account a difference in the drawer goes to, like 5350 Cash over and short.',
+    pos_over_short_invalid: 'Pick an active income or expense account that is not a group.',
+    pos_variance_alert_format:
+      'Type whole taka, like 500. Leave it empty for a bell at any difference.',
+    pos_reason_name_required: 'Give the reason a name, like Bank deposit.',
+    pos_reason_name_taken:
+      'Another reason has this name, maybe an archived one. Pick another name, or restore that reason.',
+    pos_reason_account_invalid:
+      'Pick an active account that is not a group, a stock account, or the account of what customers owe or what you owe suppliers.',
+    pos_reason_required: 'Pick why the money moves.',
+    pos_cash_amount_required: 'Type an amount above zero.',
+    pos_count_required: 'Type what you counted. Type 0 if the drawer is empty.',
+    pos_count_total_mismatch: 'The total is not what the notes add up to. Count the notes again.',
+    pos_pay_out_too_large:
+      'The drawer should not hold this much. Count what is there, and pay out no more than that.',
+    pos_float_reason_required:
+      'This is the register’s first shift. Pick where the cash comes from, like Float from the safe.',
+    // Decision 32: letting go of the register, moving the device, signing out
+    pos_shift_still_open:
+      'A shift is open on this register. Close it on the POS screen first. If its device is lost, someone with pos.shift.manage closes it without a count.',
+    pos_shift_closed: 'This shift is closed already. Reload the page to see how it closed.',
+    // Bugs (decision 25): never a cashier's mistake
+    pos_shift_already_open:
+      'The server still has the last shift of this register open. This should not happen: keep the drawer as it is and tell your Omnivo administrator.',
+    pos_shift_unknown:
+      'The server doesn’t know this shift. This should not happen: keep the paper receipts and tell your Omnivo administrator.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **The errors say how to fix the problem** (CLAUDE.md → Copy), each with an example where one helps (5350, 500,
  Bank deposit). Four of them are worth a word:
  - **`pos_count_required`** says that 0 is a count (decision 18): an empty drawer is typed as 0, never left empty.
  - **`pos_reason_account_invalid`** lists what the account may not be (decision 46) in plain words: "what customers
    owe or what you owe suppliers" for the receivable and the payable.
  - **`pos_shift_still_open`** answers three actions (decision 32): letting go of the register, moving the device,
    signing out. It says the normal fix, and the manager's fix for a lost device.
  - **`pos_shift_already_open` and `pos_shift_unknown`** should never happen (decision 25). Like `pos_number_taken`,
    they say what to keep while someone looks for the bug: the drawer as it is, the paper receipts.

### `locales/bn.ts`

```diff
@@ -120,6 +120,8 @@ export const bn: Messages = {
     registers: 'POS রেজিস্টার',
     posSales: 'POS বিক্রি',
     soldShort: 'স্টকের বেশি বিক্রি',
+    posShifts: 'POS শিফট',
+    cashReasons: 'POS ক্যাশের কারণ',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -495,6 +497,8 @@ export const bn: Messages = {
         create_draft: '{{name}}-এর খসড়া অর্ডার',
       },
       pos_sale: { create: 'বিক্রি {{name}}' },
+      pos_shift: { open: 'শিফট {{name}} খোলা', close: 'শিফট {{name}} বন্ধ' },
+      pos_cash_movement: { create: 'ড্রয়ার: {{name}}' },
     },
     savedAt: 'সেভ হয়েছে {{time}}',
     changedFields: 'বদলেছে: {{fields}}',
@@ -599,6 +603,8 @@ export const bn: Messages = {
       description: 'আপনার কাজ খুলতে এই ডিভাইসের PIN লিখুন।',
       offlineDescription: 'আপনি অফলাইনে, তাই আপনার কাজ খুলতে এই ডিভাইসের PIN লাগবে।',
       keyChangedDescription: 'এই ডিভাইসে সেভ করা কাজ খুলতে একবার PIN লাগবে।',
+      idleDescription:
+        '{{minutes}} মিনিট কেউ POS ব্যবহার করেননি, তাই এটা নিজে থেকে লক হয়েছে। চালিয়ে যেতে এই ডিভাইসের PIN দিন।',
       unlock: 'আনলক করুন',
       unlocking: 'আনলক হচ্ছে…',
       forgot: 'PIN ভুলে গেছেন? পাসওয়ার্ড দিয়ে সাইন ইন করুন',
@@ -794,6 +800,7 @@ export const bn: Messages = {
       purchase_debit_note: 'ডেবিট নোট',
       purchase_refund: 'সাপ্লায়ার রিফান্ড',
       pos_sale: 'POS বিক্রি',
+      pos_shift: 'POS শিফট',
     },
     fromDocument: '{{document}} থেকে',
     stockEntryHint:
@@ -814,6 +821,8 @@ export const bn: Messages = {
       'একটা ডেবিট নোট এই এন্ট্রি বানিয়েছে। পোস্ট করা ডেবিট নোট যেমন আছে তেমনই থাকে, তাই এখানে এন্ট্রিটা রিভার্স হয় না।',
     supplierRefundEntryHint:
       'একটা সাপ্লায়ার রিফান্ড এই এন্ট্রি বানিয়েছে। ফেরাতে চাইলে রিফান্ডের নিজের পেজে সেটা ভয়েড করুন।',
+    posShiftEntryHint:
+      'একটা POS শিফট এই এন্ট্রি বানিয়েছে। এটা রিভার্স হয় না: ভুল গোনা ঠিক হয় পরের শিফটের শুরুর গোনায়, আর ভুল ক্যাশ ইন বা ক্যাশ আউট উল্টো দিকের আরেকটা দিয়ে।',
     draftSaved: 'ড্রাফট সেভ হয়েছে',
     posted: '{{number}} পোস্ট হয়েছে',
     deleted: 'ড্রাফট মোছা হয়েছে',
@@ -3772,6 +3781,24 @@ export const bn: Messages = {
     paperWidthHint: 'এই কাউন্টারের রিসিট প্রিন্টারের রোল কত চওড়া।',
     receiptFooter: 'রিসিটের নিচের লেখা',
     receiptFooterPlaceholder: 'বিক্রি করা মাল এই রিসিট দেখিয়ে ৭ দিনের মধ্যে বদলানো যায়।',
+    shiftTitle: 'শিফট',
+    shiftHint: 'শিফট খোলার সময় আর বন্ধের সময়, দুবারই ক্যাশিয়ার ড্রয়ারের টাকা গোনেন।',
+    overShortAccount: 'ক্যাশ বেশি-কমের অ্যাকাউন্ট',
+    overShortHint:
+      'গোনায় পার্থক্য হলে এখানে পোস্ট হয়। একটা আয় বা খরচের অ্যাকাউন্ট, যেমন 5350 Cash over and short।',
+    varianceAlert: 'এর বেশি পার্থক্যে বেল (৳)',
+    varianceAlertHint:
+      'পুরো টাকায়। বন্ধের গোনায় এর চেয়ে বেশি পার্থক্য হলে ম্যানেজাররা বেল পান। খালি বা ০ মানে যেকোনো পার্থক্যে।',
+    lockAfter: 'POS লক হবে',
+    lockAfterHint:
+      'POS-এ এতক্ষণ কোনো টাচ, ক্লিক বা কী না চাপলে। ক্যাশিয়ার এই ডিভাইসের PIN দিয়ে খোলেন।',
+    lockAfters: {
+      off: 'কখনো না',
+      '2': '২ মিনিট পর',
+      '5': '৫ মিনিট পর',
+      '10': '১০ মিনিট পর',
+      '15': '১৫ মিনিট পর',
+    },
     show: 'দেখান',
     statuses: { active: 'চালু', archived: 'আর্কাইভ' },
     columns: {
@@ -3881,6 +3908,103 @@ export const bn: Messages = {
     savedOnDevice: 'এই ডিভাইসে সেভ হয়েছে। কানেকশন ফিরলে সিঙ্ক হবে।',
     printAgain: 'আবার প্রিন্ট করুন',
     newSale: 'নতুন বিক্রি',
+    shift: {
+      number: 'শিফট {{number}}',
+      openTitle: 'শিফট খুলুন',
+      openDescription:
+        'প্রথম বিক্রির আগে ড্রয়ারের টাকা গুনে নিন। শিফট বন্ধ না করা পর্যন্ত আপনি এই শিফটে বিক্রি করবেন।',
+      countBy: 'গোনা',
+      countModes: { notes: 'নোট ধরে', total: 'মোট টাকা' },
+      notesLegend: 'ড্রয়ারের নোট আর কয়েন',
+      noteCount: '{{note}} কয়টা',
+      noteAmount: '= {{amount}}',
+      countTotal: 'ড্রয়ারে নগদ',
+      notesTotal: 'মোট {{amount}}',
+      firstShift: 'এটা {{code}}-এর প্রথম শিফট। এই টাকা কোথা থেকে এল?',
+      floatReason: 'যেভাবে এল',
+      floatReasonPlaceholder: 'একটা কারণ বাছুন',
+      noInReasons:
+        'এখনো ক্যাশ ইনের কোনো কারণ নেই। pos.register.manage আছে এমন কেউ সেটিংস → POS ক্যাশের কারণে একটা যোগ করবেন, যেমন Float from the safe।',
+      open: 'শিফট খুলুন',
+      opened: 'শিফট {{number}} খোলা হয়েছে',
+      openedEven: 'আগের শিফট যা রেখে গেছে, ড্রয়ারে তা-ই আছে: {{amount}}।',
+      openedDifference:
+        'আগের শিফট রেখে গেছে {{expected}}। আপনার গোনায় {{difference}}, আর সেটা হিসাবের খাতায় যায়।',
+      needsOverShort:
+        '{{code}}-এর কোনো ক্যাশ বেশি-কমের অ্যাকাউন্ট নেই, তাই শিফট খোলা যায় না। pos.register.manage আছে এমন কেউ সেটিংস → POS রেজিস্টারে একটা বেছে দেবেন।',
+      needsPin:
+        'কেউ ব্যবহার না করলে {{code}} নিজে থেকে লক হয়, তাই শিফট খোলার আগে এই ডিভাইসে একটা PIN লাগবে।',
+      leftOpen: 'শিফট {{number}} {{time}} থেকে খোলা। পরের বিক্রির আগে এটা বন্ধ করুন।',
+      menu: 'শিফট {{number}}-এর মেনু',
+      openedBy: '{{time}}-এ খোলা · {{name}}',
+      payIn: 'ক্যাশ ইন',
+      payOut: 'ক্যাশ আউট',
+      close: 'শিফট বন্ধ করুন',
+      changeRegisterOpen: 'শিফট {{number}} খোলা আছে। এটা বন্ধ করে তারপর রেজিস্টার বদলান।',
+    },
+    cash: {
+      titles: { in: 'ক্যাশ ইন', out: 'ক্যাশ আউট' },
+      descriptions: {
+        in: 'ড্রয়ারে রাখা টাকা। কেন আসছে, সেটা বাছুন।',
+        out: 'ড্রয়ার থেকে নেওয়া টাকা। কেন যাচ্ছে, সেটা বাছুন, আর স্লিপটা রেখে দিন।',
+      },
+      reason: 'কারণ',
+      reasonPlaceholder: 'একটা কারণ বাছুন',
+      amount: 'টাকা',
+      note: 'নোট',
+      notePlaceholder: 'জমার স্লিপ 0042',
+      noReasons: {
+        in: 'এখনো ক্যাশ ইনের কোনো কারণ নেই। pos.register.manage আছে এমন কেউ সেটিংস → POS ক্যাশের কারণে একটা যোগ করবেন।',
+        out: 'এখনো ক্যাশ আউটের কোনো কারণ নেই। pos.register.manage আছে এমন কেউ সেটিংস → POS ক্যাশের কারণে একটা যোগ করবেন।',
+      },
+      save: { in: '{{amount}} ক্যাশ ইন', out: '{{amount}} ক্যাশ আউট' },
+      done: {
+        in: '{{reason}} বাবদ {{amount}} ক্যাশ ইন হয়েছে',
+        out: '{{reason}} বাবদ {{amount}} ক্যাশ আউট হয়েছে',
+      },
+    },
+    hold: {
+      hold: 'হোল্ড',
+      title: 'এই বিল হোল্ড করুন',
+      description:
+        'পরের গ্রাহককে দেখার সময় কার্টটা এই ডিভাইসে অপেক্ষা করে। দাম একই থাকে; গ্রাহক টাকা দেওয়ার সময় স্টক আবার দেখা হয়।',
+      name: 'নাম',
+      namePlaceholder: 'নীল শার্টের গ্রাহক',
+      save: 'বিল হোল্ড করুন',
+      held: 'বিল হোল্ড হয়েছে',
+      list: 'হোল্ড ({{formatted}})',
+      listTitle: 'হোল্ড করা বিল',
+      listDescription: 'এগুলো শুধু এই ডিভাইসে থাকে, আর শিফট বন্ধ হলে বাদ যায়।',
+      unnamed: '{{time}}-এ হোল্ড',
+      row: '{{items}} · {{total}}',
+      resume: 'আবার খুলুন',
+      drop: '{{name}} বাদ দিন',
+      dropped: 'হোল্ড করা বিল বাদ দেওয়া হয়েছে',
+      resumeHolds: 'স্ক্রিনের কার্টটা আগে হোল্ড হয়, তাই কিছু হারায় না।',
+      full: 'এই ডিভাইসে আগেই {{max}}টা বিল হোল্ড আছে। আগে একটা খুলুন বা বাদ দিন।',
+      emptyTitle: 'কোনো হোল্ড করা বিল নেই',
+      emptyBody: 'পরের গ্রাহককে দেখার সময় কার্ট হোল্ড করতে F8 চাপুন।',
+    },
+    close: {
+      title: 'শিফট {{number}} বন্ধ করুন',
+      description: 'ড্রয়ারের টাকা গুনুন। Omnivo কত আশা করে, সেটা বন্ধ করার পরে দেখায়।',
+      heldDropped_one: 'হোল্ড করা {{formatted}}টা বিল শিফট বন্ধ হলে বাদ যায়।',
+      heldDropped_other: 'হোল্ড করা {{formatted}}টা বিল শিফট বন্ধ হলে বাদ যায়।',
+      final: 'শিফট বন্ধ হওয়ার পরে গোনা আর বদলায় না।',
+      confirm: 'শিফট বন্ধ করুন',
+      doneTitle: '{{number}} বন্ধ হয়েছে',
+      counted: 'গোনা হয়েছে',
+      expected: 'থাকার কথা',
+      difference: 'পার্থক্য',
+      even: 'ড্রয়ারে ঠিক যা থাকার কথা, তা-ই আছে।',
+      over: 'ড্রয়ারে যা থাকার কথা, তার চেয়ে {{amount}} বেশি আছে। এটা ক্যাশ বেশি হিসেবে খাতায় যায়।',
+      short: 'ড্রয়ারে যা থাকার কথা, তার চেয়ে {{amount}} কম আছে। এটা ক্যাশ কম হিসেবে খাতায় যায়।',
+      next: 'পরের শিফট খুলুন',
+      signOutTitle: 'আগে শিফট বন্ধ করুন',
+      signOutBody:
+        'এই ডিভাইসে শিফট {{number}} খোলা আছে। ড্রয়ার গুনে শিফট বন্ধ করুন, তারপর সাইন আউট করুন।',
+      signOutClose: 'শিফট বন্ধ করুন',
+    },
     shortcuts: 'কিবোর্ড শর্টকাট',
     keys: {
       search: 'খুঁজুন বা স্ক্যান করুন',
@@ -3890,6 +4014,8 @@ export const bn: Messages = {
       complete: 'বিক্রি শেষ করুন',
       newSale: 'নতুন বিক্রি',
       help: 'এই শর্টকাটগুলো দেখান',
+      hold: 'বিল হোল্ড',
+      held: 'হোল্ড করা বিল',
     },
     receipt: {
       title: 'রিসিট',
@@ -3933,6 +4059,7 @@ export const bn: Messages = {
     device: 'ডিভাইস',
     cashier: 'ক্যাশিয়ার',
     customer: 'গ্রাহক',
+    shift: 'শিফট',
     lines: 'আইটেম',
     batches: 'ব্যাচ {{lot}} · {{quantity}}',
     serials: 'সিরিয়াল নম্বর: {{serials}}',
@@ -3974,6 +4101,128 @@ export const bn: Messages = {
     emptyBody: 'কোনো কাউন্টার তার গুদামের স্টকের বেশি বিক্রি করলে আইটেমটা এখানে দেখা যায়।',
     loadFailed: 'তালিকাটা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  posShifts: {
+    title: 'POS শিফট',
+    description: 'প্রতিটা ক্যাশিয়ারের ড্রয়ার গোনা, আর খাতা অনুযায়ী যত নগদ থাকার কথা',
+    back: 'POS শিফট',
+    register: 'রেজিস্টার',
+    allRegisters: 'সব রেজিস্টার',
+    show: 'দেখান',
+    allStatuses: 'সব শিফট',
+    statuses: { open: 'খোলা', closed: 'বন্ধ', closed_without_count: 'গোনা হয়নি' },
+    columns: {
+      shift: 'শিফট',
+      register: 'রেজিস্টার',
+      cashier: 'ক্যাশিয়ার',
+      opened: 'খোলা হয়',
+      closed: 'বন্ধ হয়',
+      expected: 'থাকার কথা',
+      counted: 'গোনা',
+      difference: 'পার্থক্য',
+      status: 'অবস্থা',
+    },
+    over: '{{amount}} বেশি',
+    short: '{{amount}} কম',
+    even: 'পার্থক্য নেই',
+    device: 'ডিভাইস',
+    cashier: 'ক্যাশিয়ার',
+    openedAt: 'খোলা হয়েছে',
+    closedAt: 'বন্ধ হয়েছে',
+    opening: 'শুরুতে',
+    openingCounted: 'খোলার সময় গোনা',
+    lastLeft: 'আগের শিফট রেখে গেছে',
+    firstShift: 'রেজিস্টারের প্রথম শিফট',
+    floatReason: 'যেভাবে এল',
+    closing: 'শেষে',
+    deviceExpected: 'ডিভাইস যা আশা করেছিল',
+    heldDropped: 'বাদ দেওয়া হোল্ড বিল',
+    countColumns: { note: 'নোট', count: 'কয়টা', amount: 'টাকা' },
+    asTotal: 'মোট টাকা হিসেবে গোনা',
+    cash: {
+      title: 'ড্রয়ারের নগদ',
+      opening: 'শুরুর গোনা',
+      cashTaken: 'নগদ নেওয়া',
+      changeGiven: 'ভাংতি দেওয়া',
+      paidIn: 'ক্যাশ ইন',
+      paidOut: 'ক্যাশ আউট',
+      expected: 'থাকার কথা',
+    },
+    payments: 'যেভাবে টাকা নেওয়া হয়েছে',
+    sales_one: '{{formatted}}টা বিক্রি · {{total}}',
+    sales_other: '{{formatted}}টা বিক্রি · {{total}}',
+    movements: 'ক্যাশ ইন আর ক্যাশ আউট',
+    movementColumns: {
+      time: 'সময়',
+      reason: 'কারণ',
+      direction: 'ধরন',
+      amount: 'টাকা',
+      note: 'নোট',
+      entry: 'জার্নাল এন্ট্রি',
+    },
+    directions: { in: 'ক্যাশ ইন', out: 'ক্যাশ আউট' },
+    noMovements: 'ড্রয়ারে কোনো টাকা রাখা বা নেওয়া হয়নি।',
+    entriesTitle: 'জার্নাল এন্ট্রি',
+    entries: { opening: 'শুরুর পার্থক্য', float: 'শুরুর টাকা', closing: 'শেষের পার্থক্য' },
+    expectedDiffers:
+      'ডিভাইস আশা করেছিল {{device}}, সার্ভার {{server}}: একটা বিক্রি বা ক্যাশ ইন/আউট এক দিকে নেই। খাতায় সার্ভারের সংখ্যাটা যায়।',
+    withoutCount:
+      'এই ড্রয়ার কেউ গোনেননি, তাই কোনো পার্থক্য পোস্ট হয়নি। পরের শিফটের শুরুর গোনায় হারানো টাকা ধরা পড়ে।',
+    closedBy: '{{name}} বন্ধ করেছেন · {{time}}',
+    stillOpen: '{{time}} থেকে খোলা। থাকার কথা যত টাকা, তাতে এ পর্যন্ত সিঙ্ক হওয়া সব ধরা আছে।',
+    closeWithoutCount: 'না গুনে বন্ধ করুন',
+    closeTitle: '{{number}} না গুনে বন্ধ করবেন?',
+    closeBody:
+      'যে শিফট তার ক্যাশিয়ার বন্ধ করতে পারছেন না, তার জন্য: ডিভাইস হারিয়েছে, বা কেউ বাড়ি চলে গেছেন। এখন কিছু পোস্ট হয় না; পরের শিফটের শুরুর গোনায় হারানো টাকা ধরা পড়ে।',
+    closeNote: 'কেন',
+    closeNotePlaceholder: 'সুমি অসুস্থ হয়ে বাড়ি গেছেন; ড্রয়ারের টাকা সেফে রাখা হয়েছে।',
+    closeConfirm: 'না গুনে বন্ধ করুন',
+    closedToast: '{{number}} না গুনে বন্ধ হয়েছে',
+    notFound: 'এই POS শিফট নেই।',
+    needsConnection: 'POS শিফট সার্ভার থেকে পড়া হয়। দেখতে ইন্টারনেটে যুক্ত হন।',
+    emptyTitle: 'এখনো কোনো শিফট নেই',
+    emptyBody: 'ক্যাশিয়ার POS স্ক্রিনে ড্রয়ার গুনলে শিফট শুরু হয়।',
+    loadFailed: 'POS শিফটের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  posCashReasons: {
+    title: 'POS ক্যাশের কারণ',
+    description: 'ক্যাশিয়ার কেন ড্রয়ারে টাকা রাখেন বা তোলেন, আর টাকাটা কোন অ্যাকাউন্টে যায়',
+    add: 'কারণ যোগ করুন',
+    newTitle: 'নতুন কারণ',
+    editTitle: '{{name}} বদলান',
+    name: 'নাম',
+    namePlaceholder: 'Bank deposit',
+    direction: 'ধরন',
+    directions: {
+      in: 'ক্যাশ ইন: ড্রয়ারে টাকা আসে',
+      out: 'ক্যাশ আউট: ড্রয়ার থেকে টাকা যায়',
+    },
+    directionLocked:
+      'একটা কারণ সবসময় ক্যাশ ইন বা ক্যাশ আউটই থাকে, যাতে আগে সরানো টাকার মানে না বদলায়। উল্টো দিকের জন্য আরেকটা কারণ যোগ করুন।',
+    account: 'অ্যাকাউন্ট',
+    accountHints: {
+      in: 'টাকা কোথা থেকে আসে: সেফ, ব্যাংক, মালিক।',
+      out: 'টাকা কোথায় যায়: ব্যাংক, সেফ, বা কোনো খরচ, যেমন স্টাফের চা।',
+    },
+    accountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+    show: 'দেখান',
+    statuses: { active: 'চালু', archived: 'আর্কাইভ' },
+    columns: { reason: 'কারণ', direction: 'ধরন', account: 'অ্যাকাউন্ট', status: 'অবস্থা' },
+    pills: { in: 'ক্যাশ ইন', out: 'ক্যাশ আউট' },
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}}-এর পরিবর্তন সেভ হয়েছে',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
+    readOnly: 'কারণগুলো বদলাতে একজন workspace owner-এর কাছে pos.register.manage permission চান।',
+    emptyTitle: 'এখনো কোনো কারণ নেই',
+    emptyBody:
+      'ক্যাশিয়াররা কেন টাকা সরান, তা যোগ করুন: সেফ থেকে শুরুর টাকা, ব্যাংকে জমা, স্টাফের চা।',
+    emptyArchivedTitle: 'কোনো আর্কাইভ করা কারণ নেই',
+    emptyArchivedBody:
+      'যে কারণ আর লাগে না, সেটা আর্কাইভ করা যায়। তার সরানো টাকা খাতায় থেকে যায়।',
+    loadFailed: 'কারণের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   approvals: {
     title: 'অনুমোদন',
     description: 'যে ডকুমেন্টগুলো আপনার সিদ্ধান্তের অপেক্ষায়, সবচেয়ে পুরনোটা আগে',
@@ -4486,6 +4735,7 @@ export const bn: Messages = {
       sale: { create: 'POS কাউন্টারে বিক্রি: রেজিস্টার নেওয়া, বিক্রি লেখা আর টাকা নেওয়া' },
       price: { override: 'POS-এ দাম বদলানো, বা রেজিস্টারের সীমার বেশি ছাড় দেওয়া' },
       register: { manage: 'POS রেজিস্টার যোগ, বদল আর আর্কাইভ' },
+      shift: { manage: 'সব রেজিস্টারের শিফট আর গোনা দেখা, আর আটকে থাকা শিফট না গুনে বন্ধ করা' },
     },
   },
   invite: {
@@ -4558,6 +4808,8 @@ export const bn: Messages = {
       device: 'ডিভাইস',
       pos_register: 'POS রেজিস্টার',
       pos_sale: 'POS বিক্রি',
+      pos_cash_reason: 'POS ক্যাশের কারণ',
+      pos_shift: 'POS শিফট',
     },
     columns: {
       when: 'কখন',
@@ -4844,6 +5096,20 @@ export const bn: Messages = {
         overridden: 'POS-এ দাম বদলেছেন বা বেশি ছাড় দিয়েছেন',
         without_permission: 'অনুমতি চলে যাওয়ার পরে POS কাউন্টারে বিক্রি করেছেন',
       },
+      pos_cash_reason: {
+        created: 'POS ক্যাশের একটা কারণ যোগ করেছেন',
+        updated: 'POS ক্যাশের একটা কারণ বদলেছেন',
+        archived: 'POS ক্যাশের একটা কারণ আর্কাইভ করেছেন',
+        restored: 'POS ক্যাশের একটা কারণ ফিরিয়ে এনেছেন',
+      },
+      pos_shift: {
+        opened: 'একটা POS শিফট খুলেছেন',
+        cash_moved: 'ড্রয়ারে টাকা রেখেছেন বা তুলেছেন',
+        closed: 'একটা POS শিফট বন্ধ করেছেন',
+        closed_without_count: 'একটা POS শিফট না গুনে বন্ধ করেছেন',
+        expected_differs: 'বন্ধের সময় ডিভাইস আর সার্ভার আলাদা নগদ আশা করেছিল',
+        without_permission: 'অনুমতি চলে যাওয়ার পরে POS শিফটে কাজ করেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -4988,6 +5254,26 @@ export const bn: Messages = {
       overrides: 'pos.price.override লাগে',
       allowed: 'অনুমতি',
       missing: 'যে অনুমতি ছিল না',
+      overShortAccount: 'বেশি-কমের অ্যাকাউন্ট',
+      varianceAlert: 'এর বেশিতে বেল (৳)',
+      lockAfter: 'লক হবে (মিনিট)',
+      account: 'অ্যাকাউন্ট',
+      openedOn: 'ডিভাইসের তারিখ',
+      closedOn: 'ডিভাইসের তারিখ',
+      on: 'ডিভাইসের তারিখ',
+      opening: 'শুরুর গোনা',
+      comparedWith: 'আগের শিফট রেখে গেছে',
+      floatReason: 'যেভাবে এল',
+      note: 'নোট',
+      shiftStatus: 'তখন শিফটের অবস্থা',
+      statusBefore: 'তখন শিফটের অবস্থা',
+      counted: 'গোনা',
+      deviceExpected: 'ডিভাইস যা আশা করেছিল',
+      expected: 'থাকার কথা',
+      server: 'সার্ভার যা আশা করেছিল',
+      heldDropped: 'বাদ দেওয়া হোল্ড বিল',
+      kept: 'শিফটে সেভ হয়েছে',
+      by: 'যে বন্ধ করেছে',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -5078,6 +5364,8 @@ export const bn: Messages = {
       pos: {
         sold_short:
           '{{number}}-এ {{warehouse}}-এর স্টকের চেয়ে বেশি বিক্রি হয়েছে। শূন্যের নিচে নামা আইটেম: {{count}}। গুনে স্টক ঠিক করুন।',
+        shift_variance:
+          '{{register}}-এর {{number}} বন্ধ হয়েছে {{difference}} নিয়ে। গোনাটা দেখতে শিফটটা খুলুন।',
       },
     },
   },
@@ -5162,6 +5450,8 @@ export const bn: Messages = {
     journal_not_draft: 'এই এন্ট্রি পোস্ট করা, তাই বদলানো যায় না। এর বদলে রিভার্স করুন।',
     journal_not_posted: 'শুধু পোস্ট করা এন্ট্রি রিভার্স করা যায়। ড্রাফট হলে মুছে ফেলুন।',
     journal_is_reversal: 'রিভার্সালকে রিভার্স করা যায় না। এর বদলে নতুন একটা এন্ট্রি পোস্ট করুন।',
+    journal_is_pos:
+      'POS শিফটের এন্ট্রি রিভার্স করা যায় না। ভুল গোনা ঠিক হয় পরের শিফটের গোনায়, আর ভুল ক্যাশ ইন বা ক্যাশ আউট উল্টো দিকের আরেকটা দিয়ে।',
     journal_already_reversed: 'এই এন্ট্রি আগেই রিভার্স করা হয়েছে। রিভার্সালটা দেখতে রিলোড করুন।',
     journal_reversal_date: 'এন্ট্রির নিজের তারিখ বা তার পরের একটা তারিখ বাছুন।',
     opening_date_required: 'Omnivo-তে আপনার প্রথম দিন বাছুন।',
@@ -5675,6 +5965,31 @@ export const bn: Messages = {
       'রেজিস্টারে এখন এই পেমেন্টের ধরনের কোনো অ্যাকাউন্ট নেই। pos.register.manage আছে এমন কেউ সেটিংস → POS রেজিস্টারে সেটা দিলে বিক্রিটা আবার চেষ্টা করুন।',
     pos_number_taken:
       'এই রেজিস্টারের আরেকটা বিক্রিতে এই নম্বর আছে। এমন হওয়ার কথা নয়: কাগজের রিসিটটা রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_over_short_required:
+      'ড্রয়ারের পার্থক্য কোন অ্যাকাউন্টে যাবে, সেটা বাছুন, যেমন 5350 Cash over and short।',
+    pos_over_short_invalid: 'একটা চালু আয় বা খরচের অ্যাকাউন্ট বাছুন, যেটা গ্রুপ নয়।',
+    pos_variance_alert_format:
+      'পুরো টাকায় লিখুন, যেমন ৫০০। যেকোনো পার্থক্যে বেলের জন্য খালি রাখুন।',
+    pos_reason_name_required: 'কারণটার একটা নাম দিন, যেমন Bank deposit।',
+    pos_reason_name_taken:
+      'আরেকটা কারণের এই নাম আছে, হয়তো আর্কাইভ করা কোনোটার। আরেকটা নাম দিন, বা সেই কারণটা ফিরিয়ে আনুন।',
+    pos_reason_account_invalid:
+      'একটা চালু অ্যাকাউন্ট বাছুন, যেটা গ্রুপ নয়, স্টকের অ্যাকাউন্ট নয়, আর গ্রাহকদের পাওনা বা সাপ্লায়ারদের দেনার অ্যাকাউন্টও নয়।',
+    pos_reason_required: 'টাকা কেন সরছে, সেটা বাছুন।',
+    pos_cash_amount_required: 'শূন্যের বেশি একটা টাকার অঙ্ক লিখুন।',
+    pos_count_required: 'যা গুনলেন, তা লিখুন। ড্রয়ার খালি হলে ০ লিখুন।',
+    pos_count_total_mismatch: 'মোটটা নোটগুলোর যোগফলের সাথে মেলে না। নোটগুলো আবার গুনুন।',
+    pos_pay_out_too_large:
+      'ড্রয়ারে এত টাকা থাকার কথা নয়। যা আছে গুনে দেখুন, আর তার বেশি ক্যাশ আউট করবেন না।',
+    pos_float_reason_required:
+      'এটা রেজিস্টারের প্রথম শিফট। টাকাটা কোথা থেকে এল, সেটা বাছুন, যেমন Float from the safe।',
+    pos_shift_still_open:
+      'এই রেজিস্টারে একটা শিফট খোলা আছে। আগে POS স্ক্রিনে সেটা বন্ধ করুন। ডিভাইস হারিয়ে গেলে pos.shift.manage আছে এমন কেউ না গুনে বন্ধ করবেন।',
+    pos_shift_closed: 'এই শিফট আগেই বন্ধ হয়েছে। কীভাবে বন্ধ হলো দেখতে পেজটা রিলোড করুন।',
+    pos_shift_already_open:
+      'সার্ভারে এই রেজিস্টারের আগের শিফট এখনো খোলা। এমন হওয়ার কথা নয়: ড্রয়ার যেমন আছে রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
+    pos_shift_unknown:
+      'সার্ভার এই শিফট চেনে না। এমন হওয়ার কথা নয়: কাগজের রিসিটগুলো রেখে দিন আর আপনার Omnivo administrator-কে জানান।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. Office words stay in English as
  the app already writes them: POS, PIN, permission, workspace, and the permission keys themselves (CLAUDE.md →
  Language).
- **Pay in and pay out are ক্যাশ ইন and ক্যাশ আউট,** the words every bKash agent and shop counter in Bangladesh
  already uses for money in and out. Over and short is বেশি and কম ("৳৫২০ কম"), and the account is "ক্যাশ বেশি-কমের
  অ্যাকাউন্ট". A held bill is হোল্ড করা বিল, as shops say it.
- **The examples that are typed values stay as typed:** 5350 Cash over and short, Bank deposit, Float from the safe,
  deposit slip 0042, F8. A number in a sentence is in Bangla digits (৫ মিনিট পর, ০ লিখুন).
- **`sales_one` / `_other` and `heldDropped_one` / `_other` are the same text.** Bangla has one form here, but i18next
  asks for both keys, because the English type has both.

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
their test). `pnpm --filter @omnivo/app typecheck` fails only in `notification-bell.tsx`, `sync-parts.tsx`,
`routes/pos-registers.tsx`, `mocks/pos-data.ts` and `mocks/push-data.ts`, which 20b.6 and 20b.7 change.

## 20b.6a — `packages/sync` and the POS screen: the shift on the counter

This part makes the shift work at the counter. The device keeps the reasons and its shift, adds up the shift's cash as
it sells, and keeps held bills and the cart on the screen. On `/pos`, the open card counts the drawer before the first
sale, the shift menu in the bar does pay in, pay out, held bills and the close, and the close shows its result. The
idle lock and the sign-out's "Close the shift first" come with it. The server pages (the register's three fields, the
POS cash reasons page, the POS shifts list and page, the bell's link, the Sync page's names) are the next part, 20b.6b.

The order of the files:

1. `packages/sync`: the tables, the push's order for a shift, the carts, the shift, the sale's cash.
2. `apps/app/src/lib`: the cart's type, the count's arithmetic, the lock's minutes, the session's open shift.
3. The screen: the shift's dialogs, the held bills, the menu, the selling screen and the page.
4. The sign-out: "Close the shift first", in the shell and on the lock screen.

### `packages/sync/src/database.ts`: the reasons, the shift, the carts

```diff
@@ -1,11 +1,14 @@
 import type {
+  CashCount,
   Product,
+  ShiftCash,
   SyncCategory,
   SyncCommand,
   SyncCommandError,
   SyncCustomer,
   SyncCustomerGroup,
   SyncEntity,
+  SyncPosCashReason,
   SyncPosRegister,
   SyncPriceList,
   SyncPriceListItem,
@@ -17,6 +20,7 @@ import type {
 } from '@omnivo/contracts';
 import { Dexie, type Table } from 'dexie';
 
+import type { PosCart } from './carts.js';
 import type { Box } from './crypto.js';
 import type { KeyRecord } from './keys.js';
 
@@ -116,6 +120,10 @@ export interface OutboxEntry {
   total: string | null;
   // When it was saved, by this device's clock: shown, never sent (decision 6)
   savedAt: string;
+  // Step 20b: the shift a POS command belongs to (its open, its sales, its movements, its close),
+  // for the order the push sends them in (push.ts). Missing on every other command, and on a sale
+  // saved before 20b.
+  shiftId?: string;
 }
 
 // The part of an entry that is sealed: everything a person typed or read
@@ -129,7 +137,7 @@ export type OutboxBody = Pick<
 // outbox from these alone, inside one transaction (a transaction cannot wait for Web Crypto).
 export interface OutboxRow extends Pick<
   OutboxEntry,
-  'seq' | 'status' | 'sent' | 'customerId' | 'key'
+  'seq' | 'status' | 'sent' | 'customerId' | 'key' | 'shiftId'
 > {
   // The command's id: the box is sealed under it, and an answer finds its row by it
   commandId: string;
@@ -166,6 +174,62 @@ export interface RegisterClaim {
   last: number;
 }
 
+// Step 20b: this device's latest shift, opened: the open one it sells on, or the last one it closed
+// (the next open numbers on from it and compares with what it counted). Its cash is added up here
+// as the sales and the movements are saved, so the close's result needs no sale the outbox has
+// sent already.
+export interface DeviceShift {
+  id: string;
+  registerId: string;
+  sequence: number;
+  // POS1-S0042 (formatShiftNumber)
+  number: string;
+  status: 'open' | 'closed';
+  // The device's clock, and the day it opened on (a shift still open on a later day was left open)
+  openedAt: string;
+  openingDate: string;
+  opening: CashCount;
+  cash: ShiftCash;
+  // Set by the close: the count and what the device expected
+  closedAt: string | null;
+  counted: string | null;
+  expected: string | null;
+}
+
+// One row, under the key 'shift'. The shift's ids, its number and whether it is open stay clear:
+// the lock screen's Sign out and the sidebar's sign-out ask about an open shift without the key,
+// and a number like POS1-S0042 says nothing about the money. `rev` counts every write: a save
+// that read the shift writes only if nobody wrote it since (another tab sold meanwhile).
+export interface ShiftRow {
+  key: 'shift';
+  shiftId: string;
+  registerId: string;
+  number: string;
+  status: DeviceShift['status'];
+  rev: number;
+  box: Box<DeviceShift>;
+}
+
+// Step 20b: a held cart (decision 10), or the cart on the screen (key 'current'), so a reload or
+// the idle lock does not lose it. Never sent. The shift's id and the time are clear, for the
+// close's count and the list's order.
+export interface HeldCart {
+  // What the cashier typed ("Customer in the blue shirt"); null = none
+  name: string | null;
+  heldAt: string;
+  // For the list's row: "4 items · ৳1,501"
+  items: number;
+  total: string;
+  cart: PosCart;
+}
+
+export interface CartRow {
+  key: string;
+  shiftId: string;
+  heldAt: string;
+  box: Box<HeldCart>;
+}
+
 // The tables, by entity. The names are the ones the app reads (db.products, db.customers).
 export const TABLE_OF = {
   settings: 'settings',
@@ -174,6 +238,7 @@ export const TABLE_OF = {
   tax_rate: 'taxRates',
   warehouse: 'warehouses',
   pos_register: 'posRegisters',
+  pos_cash_reason: 'posCashReasons',
   price_list: 'priceLists',
   customer_group: 'customerGroups',
   product: 'products',
@@ -221,6 +286,7 @@ export class SyncDatabase extends Dexie {
   taxRates!: Table<SealedRow<TaxRate>, string>;
   warehouses!: Table<SealedRow<Warehouse>, string>;
   posRegisters!: Table<SealedRow<SyncPosRegister>, string>;
+  posCashReasons!: Table<SealedRow<SyncPosCashReason>, string>;
   priceLists!: Table<SealedRow<SyncPriceList>, string>;
   customerGroups!: Table<SealedRow<SyncCustomerGroup>, string>;
   products!: Table<ProductRow, string>;
@@ -239,6 +305,9 @@ export class SyncDatabase extends Dexie {
   legacyNotices!: Table<SyncNoticeRecord, string>;
   // Step 20a: one row (RegisterClaim)
   registerClaim!: Table<RegisterClaim, string>;
+  // Step 20b: one row (ShiftRow), and the carts
+  posShift!: Table<ShiftRow, string>;
+  posCarts!: Table<CartRow, string>;
 
   constructor(name: string) {
     super(name);
@@ -314,6 +383,13 @@ export class SyncDatabase extends Dexie {
       posRegisters: 'key, gen',
       registerClaim: 'key',
     });
+    // Step 20b: the reasons, the shift and the carts. No upgrade, like version 4: SYNC_PROTOCOL is 3
+    // now, so the next pull is a full one and brings every reason. `shiftId` finds a shift's carts.
+    this.version(5).stores({
+      posCashReasons: 'key, gen',
+      posShift: 'key',
+      posCarts: 'key, shiftId',
+    });
   }
 
   // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
```

- **`pos_cash_reason: 'posCashReasons'` in `TABLE_OF`:** the contract's new entity (20b.1) made this file fail to
  compile until the table was named (`satisfies Record<SyncEntity, string>`). The pull, the sweep and the sign-out's
  delete walk `TABLE_OF`, so the reasons get all three. Writing them is `apply.ts`'s job (below).
- **`version(5)` with no upgrade:** three new tables, nothing old changes. `SYNC_PROTOCOL` is 3 now, so the server
  answers the old cursor with a full pull (decision 30), which brings every reason.
- **`DeviceShift` and `ShiftRow`:** one row, key `shift`, the device's latest shift: the open one, or the last one it
  closed (the next open needs its number and its count, decision 73). The id, the register, the number and the state
  are clear (decision 72); the count and the cash are in the box. `rev` is how a save finds out that another tab
  wrote the row since it read it.
- **`HeldCart` and `CartRow`:** a held bill or the screen's cart (key `current`). `shiftId` is an index: the close
  drops a shift's carts and counts its held ones from the clear rows alone, inside its transaction.
- **`shiftId?` on `OutboxEntry` and `OutboxRow`:** the push orders a shift's commands by it (decision 69), from the
  clear fields, inside its own transaction. It is optional, not `string | null`, so every command of 18b and 20a is
  unchanged: with `exactOptionalPropertyTypes` a missing key is left out, never `undefined`.

### `packages/sync/src/apply.ts`: reasons in a page

```diff
@@ -3,6 +3,7 @@ import type {
   SyncChange,
   SyncCustomer,
   SyncCustomerGroup,
+  SyncPosCashReason,
   SyncPosRegister,
   SyncPriceList,
   SyncPull,
@@ -40,6 +41,7 @@ export interface SealedChanges {
     taxRates: Unstamped<SealedRow<TaxRate>>[];
     warehouses: Unstamped<SealedRow<Warehouse>>[];
     posRegisters: Unstamped<SealedRow<SyncPosRegister>>[];
+    posCashReasons: Unstamped<SealedRow<SyncPosCashReason>>[];
     priceLists: Unstamped<SealedRow<SyncPriceList>>[];
     customerGroups: Unstamped<SealedRow<SyncCustomerGroup>>[];
     products: Unstamped<ProductRow>[];
@@ -74,6 +76,7 @@ export async function sealChanges(
       taxRates: [],
       warehouses: [],
       posRegisters: [],
+      posCashReasons: [],
       priceLists: [],
       customerGroups: [],
       products: [],
@@ -112,6 +115,9 @@ export async function sealChanges(
         case 'pos_register':
           puts.posRegisters.push(await boxed(copy, 'posRegisters', key, change.data));
           break;
+        case 'pos_cash_reason':
+          puts.posCashReasons.push(await boxed(copy, 'posCashReasons', key, change.data));
+          break;
         case 'price_list':
           puts.priceLists.push(await boxed(copy, 'priceLists', key, change.data));
           break;
@@ -194,6 +200,7 @@ export async function writeSealed(
   await db.taxRates.bulkPut(stamp(puts.taxRates, gen));
   await db.warehouses.bulkPut(stamp(puts.warehouses, gen));
   await db.posRegisters.bulkPut(stamp(puts.posRegisters, gen));
+  await db.posCashReasons.bulkPut(stamp(puts.posCashReasons, gen));
   await db.priceLists.bulkPut(stamp(puts.priceLists, gen));
   await db.customerGroups.bulkPut(stamp(puts.customerGroups, gen));
   await db.products.bulkPut(stamp(puts.products, gen));
```

- **A case in the switch, a list in `SealedChanges`, a `bulkPut` in `writeSealed`:** the same three lines as the
  registers' (20a.6a). The switch has no `default`, so the type check does not miss an entity: without the case, the
  reasons the pull sends were dropped without an error, and the pay in dialog said "No pay in reason yet". The first
  draft of this part had exactly that bug; the new test in `shift.spec.ts` ("keeps the reasons the pull sends")
  fails without the case.

### `packages/sync/src/sealed.ts`: the shift's id through the box

```diff
@@ -32,6 +32,8 @@ export async function sealEntry(copy: LocalCopy, entry: OutboxEntry): Promise<Ou
   return {
     // exactOptionalPropertyTypes: a missing seq must be left out, not set to undefined
     ...(seq !== undefined && { seq }),
+    // Step 20b: clear, like the customer's id: the push orders a shift's commands by it
+    ...(entry.shiftId !== undefined && { shiftId: entry.shiftId }),
     commandId: command.id,
     type: command.type,
     status,
@@ -55,6 +57,7 @@ export async function openEntry(copy: LocalCopy, row: OutboxRow): Promise<Outbox
   const body = await copy.open('outbox', row.commandId, row.box);
   return {
     ...(row.seq !== undefined && { seq: row.seq }),
+    ...(row.shiftId !== undefined && { shiftId: row.shiftId }),
     status: row.status,
     sent: row.sent,
     customerId: row.customerId,
```

- **Both ways:** `retryEntry()` opens a refused command and seals it again under a new id. Without the field in
  `openEntry()` a retried sale would lose its shift, and the push would send it before its shift's open.

### `packages/sync/src/push.ts`: a shift's order

```diff
@@ -31,14 +31,32 @@ export const NO_PUSH: PushOutcome = { accepted: 0, rejected: 0, kept: 0 };
 // other customers go on. The batch stops at 50 commands or 512 KB of JSON; the first command
 // always goes, so a big order is never stuck. Step 19b: from the rows' clear fields only (the
 // command's size is counted when it is saved), so it runs inside takeBatch's transaction.
+//
+// Step 20b: a shift's commands go in their own order, the one the server needs (sync.ts). A sale
+// or a movement waits while its shift's open is still on the device (the server would not know the
+// shift), and the close waits while any command of its shift is (the server works out the expected
+// cash from all of them). An open waits while any command of an earlier shift is: the server opens
+// no shift while the register's last one is open. "Still on the device" counts the batch being
+// made too, as for a customer: the answer comes first. A walk-in sale holds back no other sale, so
+// a shift's hundred sales still go fifty at a time.
 export function pickBatch(rows: readonly OutboxRow[]): OutboxRow[] {
   const held = new Set<string>();
+  // The shifts with a command on the device before this row, and those of them whose open is
+  const shifts = new Set<string>();
+  const opening = new Set<string>();
   const batch: OutboxRow[] = [];
   let bytes = 0;
   for (const row of rows) {
     if (batch.length === MAX_PUSH_COMMANDS) break;
-    const free = row.status === 'waiting' && !held.has(row.customerId);
+    const free =
+      row.status === 'waiting' &&
+      !held.has(row.customerId) &&
+      (row.shiftId === undefined || shiftMayGo(row, row.shiftId, shifts, opening));
     held.add(row.customerId);
+    if (row.shiftId !== undefined) {
+      shifts.add(row.shiftId);
+      if (row.type === 'pos_shift.open') opening.add(row.shiftId);
+    }
     if (!free) continue;
     if (batch.length > 0 && bytes + row.bytes > MAX_PUSH_BYTES) break;
     bytes += row.bytes;
@@ -47,6 +65,22 @@ export function pickBatch(rows: readonly OutboxRow[]): OutboxRow[] {
   return batch;
 }
 
+function shiftMayGo(
+  row: Pick<OutboxRow, 'type'>,
+  shiftId: string,
+  shifts: ReadonlySet<string>,
+  opening: ReadonlySet<string>,
+): boolean {
+  switch (row.type) {
+    case 'pos_shift.open':
+      return shifts.size === 0;
+    case 'pos_shift.close':
+      return !shifts.has(shiftId);
+    default:
+      return !opening.has(shiftId);
+  }
+}
+
 // Takes the next batch and marks it as being sent, in one transaction: a form that opens one of
 // these commands now sees that it cannot rewrite it (outbox.ts → isOpen). `sent` stays true from
 // here on: the server may run it even if its answer never comes. The batch is opened after the
```

- **Two sets as the loop goes:** `shifts`, the shifts with a command earlier in the outbox, and `opening`, those whose
  open is still there. A sale or a movement waits while its open is in `opening`; a close waits while its shift is in
  `shifts`; an open waits while any shift is. "Earlier in the outbox" includes the batch being made, the same rule as a
  customer's (decision 13 of 18b): the server must answer one before the next is sent.
- **Added to the sets before `continue`:** a row that waits still holds back the rows after it. A sale refused by the
  server stays in the outbox and keeps its shift in `shifts`, so the close waits for the person to retry or discard it
  (the server's expected cash would miss it).
- **`shiftMayGo()` switches on the type:** only the open and the close have their own rule; a sale and a movement share
  the default.

### `packages/sync/src/outbox.ts`: discarding a shift's command

```diff
@@ -306,8 +306,21 @@ function later<E extends Pick<OutboxEntry, 'seq' | 'customerId'>>(
 // number of a refused sale (the register's last number counts it), so the next device on the
 // register never prints it again. A sale never sent has a number the server does not know yet, and
 // a paper receipt already has it.
+// Step 20b: so does a shift's command. The drawer was counted, the money moved: the books must get
+// it, and only a refusal (a bug, decision 25) lets the person throw it away.
+const DONE_AT_THE_COUNTER: ReadonlySet<OutboxRow['type']> = new Set([
+  'pos_sale.create',
+  'pos_shift.open',
+  'pos_cash_movement.create',
+  'pos_shift.close',
+]);
+
+export function isCounterCommand(type: OutboxRow['type']): boolean {
+  return DONE_AT_THE_COUNTER.has(type);
+}
+
 function mayGo(item: Pick<OutboxRow, 'type' | 'status'>): boolean {
-  return item.status !== 'sending' && (item.type !== 'pos_sale.create' || item.status === 'failed');
+  return item.status !== 'sending' && (!isCounterCommand(item.type) || item.status === 'failed');
 }
 
 // What goes with an entry when it is discarded: a new customer takes every later command on that
```

- **`DONE_AT_THE_COUNTER`:** the four counter commands, discarded only once refused (decision 70). The same set as the
  API's (`sync-push.service.ts`, 20b.3).
- **`isCounterCommand()` is exported:** `pos.ts` counts what waits with it.

### `packages/sync/src/carts.ts` (new): held bills and the screen's cart

```ts
import { type DiscountType, MAX_HELD_CARTS } from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { LocalCopy } from './copy.js';
import type { CartRow, HeldCart } from './database.js';

// Step 20b: the carts of the POS screen that wait on the device (decision 10): held bills, and the
// cart on the screen itself, so a reload or the idle lock does not lose a sale half scanned. They
// are never sent: a held cart holds no stock and has no number. Each belongs to a shift, and the
// close drops them all. No Dexie import, like pos.ts.

// One line of the cart, as the screen keeps it (apps/app/src/lib/pos.ts works it out). Here, not
// in the app, because the device stores it: the box and the screen must agree on its shape.
// Everything the receipt and the sale need is copied in when the line is added (the product may
// change in the copy while the cart waits; the line keeps what the cashier saw).
export interface PosCartLine {
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

export interface PosCartCustomer {
  id: string;
  name: string;
  priceListId: string | null;
}

export interface PosCart {
  // null = walk-in
  customer: PosCartCustomer | null;
  lines: PosCartLine[];
  billDiscountType: DiscountType;
  billDiscount: string;
}

// The key of the cart on the screen. Held carts have a UUIDv7 each. A sale deletes it in its own
// transaction (pos.ts), and a close with the shift's other carts (shift.ts).
export const SCREEN_CART = 'current';

// A held cart as the list shows it
export interface HeldCartItem extends HeldCart {
  id: string;
}

function rowsOf(copy: LocalCopy, shiftId: string): Promise<CartRow[]> {
  return copy.db.posCarts.where('shiftId').equals(shiftId).toArray();
}

function held(rows: readonly CartRow[]): CartRow[] {
  return rows.filter((row) => row.key !== SCREEN_CART);
}

async function sealCart(
  copy: LocalCopy,
  key: string,
  shiftId: string,
  cart: HeldCart,
): Promise<CartRow> {
  return { key, shiftId, heldAt: cart.heldAt, box: await copy.seal('posCarts', key, cart) };
}

// The held carts of a shift, the oldest first: the one waiting longest is at the top. Two held in
// the same millisecond keep the order they were held in (a UUIDv7 key sorts by time too).
export async function heldCarts(copy: LocalCopy, shiftId: string): Promise<HeldCartItem[]> {
  const rows = held(await rowsOf(copy, shiftId)).sort(
    (a, b) => a.heldAt.localeCompare(b.heldAt) || a.key.localeCompare(b.key),
  );
  return Promise.all(
    rows.map(async (row) => ({ id: row.key, ...(await copy.open('posCarts', row.key, row.box)) })),
  );
}

// How many, from the clear fields alone: the "Held (2)" button and the close's notice
export async function heldCount(copy: LocalCopy, shiftId: string): Promise<number> {
  return held(await rowsOf(copy, shiftId)).length;
}

// Hold the cart on the screen. It leaves the screen's row in the same moment, so a reload brings
// back an empty cart and the held one, never both. full = MAX_HELD_CARTS wait already (decision
// 23: the close's count has a limit too); counted inside the transaction, so two tabs that hold at
// once cannot pass it.
export async function holdCart(
  copy: LocalCopy,
  shiftId: string,
  cart: HeldCart,
): Promise<'held' | 'full'> {
  const { db } = copy;
  const row = await sealCart(copy, uuidv7(), shiftId, cart);
  return db.transaction('rw', db.posCarts, async () => {
    if (held(await rowsOf(copy, shiftId)).length >= MAX_HELD_CARTS) return 'full';
    await db.posCarts.add(row);
    await db.posCarts.delete(SCREEN_CART);
    return 'held';
  });
}

// Resume a held cart. The cart on the screen, if it has lines, is held in its place ("The cart on
// the screen is held first, so nothing is lost"), in the same transaction: the count stays the
// same, so a full list can still swap. null = the held cart is gone (another tab resumed or dropped
// it); nothing changes then.
export async function resumeCart(
  copy: LocalCopy,
  shiftId: string,
  id: string,
  screen: HeldCart | null,
): Promise<HeldCart | null> {
  const { db } = copy;
  const chosen = await db.posCarts.get(id);
  if (chosen?.shiftId !== shiftId) return null;
  const cart = await copy.open('posCarts', chosen.key, chosen.box);
  const swapped = screen && (await sealCart(copy, uuidv7(), shiftId, screen));
  const resumed = await sealCart(copy, SCREEN_CART, shiftId, cart);
  return db.transaction('rw', db.posCarts, async () => {
    if (!(await db.posCarts.get(id))) return null;
    await db.posCarts.delete(id);
    if (swapped) await db.posCarts.add(swapped);
    // The resumed cart is the screen's now: a reload right after brings it back
    await db.posCarts.put(resumed);
    return cart;
  });
}

export async function dropCart(copy: LocalCopy, id: string): Promise<void> {
  await copy.db.posCarts.delete(id);
}

// The cart on the screen, saved as it changes; null or no lines = nothing to keep. Last write wins:
// only the screen writes it, and a second tab on /pos shows the same shift's cart from its reload.
export async function saveScreenCart(
  copy: LocalCopy,
  shiftId: string,
  cart: HeldCart | null,
): Promise<void> {
  if (!cart || cart.cart.lines.length === 0) {
    await copy.db.posCarts.delete(SCREEN_CART);
    return;
  }
  await copy.db.posCarts.put(await sealCart(copy, SCREEN_CART, shiftId, cart));
}

// The cart the screen left, if it is this shift's. One of a closed shift is dropped with it.
export async function screenCart(copy: LocalCopy, shiftId: string): Promise<PosCart | null> {
  const row = await copy.db.posCarts.get(SCREEN_CART);
  if (row?.shiftId !== shiftId) return null;
  return (await copy.open('posCarts', row.key, row.box)).cart;
}
```

- **The cart's types live here** (decision 74), with the comments they had in the app. `HeldCart` (the box) holds the
  cart and what the list shows of it: the name, the time, the count of lines and the total.
- **`holdCart()` counts inside its transaction:** two tabs holding at the same moment cannot both pass `MAX_HELD_CARTS`.
  It deletes the screen's row in the same transaction: a reload after a hold brings back an empty cart and the held
  one, never the same cart twice.
- **`resumeCart()` checks the chosen cart again inside the transaction:** another tab may have resumed or dropped it
  after it was opened. `null` means nothing changed; the list's live read drops the row by itself.
- **`saveScreenCart()` has no transaction:** only the screen writes the row, one write after the other (pos-screen.tsx),
  so the last write is the cart on the screen. An empty cart deletes the row instead of keeping an empty box.
- **`screenCart()` returns only this shift's cart:** a cart left by a shift that was closed meanwhile (another tab) is
  not this shift's to sell.

### `packages/sync/src/shift.ts` (new): open, pay in and out, close

```ts
import {
  addMoney,
  cashDifferenceOf,
  compareMoney,
  expectedCashOf,
  formatShiftNumber,
  MAX_HELD_CARTS,
  type PosCashMovementInput,
  type PosShiftCloseInput,
  type PosShiftOpenInput,
  type ShiftCash,
  type SyncCommand,
  type SyncPosCashReason,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import { SCREEN_CART } from './carts.js';
import type { LocalCopy } from './copy.js';
import type { DeviceShift, OutboxEntry, ShiftRow, SyncDatabase } from './database.js';
import { openRows, sealEntry } from './sealed.js';

// Step 20b: the shift on the device. The device opens it, adds up its cash as it sells and moves
// money, and closes it; each step is a command in the outbox (sync.ts), in the same transaction as
// the shift's row, so the row and the outbox never disagree. No Dexie import, like pos.ts.

// What the lock screen and the sign-out ask about, from the row's clear fields: no key needed
export type ShiftState = Pick<ShiftRow, 'shiftId' | 'registerId' | 'number' | 'status'>;

export async function shiftState(db: SyncDatabase): Promise<ShiftState | null> {
  const row = await db.posShift.get('shift');
  return row
    ? { shiftId: row.shiftId, registerId: row.registerId, number: row.number, status: row.status }
    : null;
}

export async function readShift(copy: LocalCopy): Promise<DeviceShift | null> {
  const row = await copy.db.posShift.get('shift');
  return row ? copy.open('posShift', 'shift', row.box) : null;
}

// The reasons the cashier picks from, "in" first, then by name, like the settings page (decision
// 62). The copy has the active ones only.
export async function localCashReasons(copy: LocalCopy): Promise<SyncPosCashReason[]> {
  const reasons = await openRows(copy, 'posCashReasons', await copy.db.posCashReasons.toArray());
  return reasons.sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
}

async function sealShift(copy: LocalCopy, shift: DeviceShift, rev: number): Promise<ShiftRow> {
  return {
    key: 'shift',
    shiftId: shift.id,
    registerId: shift.registerId,
    number: shift.number,
    status: shift.status,
    rev,
    box: await copy.seal('posShift', 'shift', shift),
  };
}

// The open shift with this id, and its row as it was read (for the write's check). null = it closed
// meanwhile (another tab), or another shift is the device's now.
async function openShiftOf(
  copy: LocalCopy,
  shiftId: string,
): Promise<{ row: ShiftRow; shift: DeviceShift } | null> {
  const row = await copy.db.posShift.get('shift');
  if (row?.shiftId !== shiftId || row.status !== 'open') return null;
  return { row, shift: await copy.open('posShift', 'shift', row.box) };
}

// A command of the shift, as the outbox keeps it. `chain` is its customerId: the push holds a
// command back while an earlier one with the same value waits. A shift's commands have their own
// value each, and their order comes from the shift's own rule (push.ts → pickBatch).
function shiftEntry(
  command: SyncCommand,
  fields: { shiftId: string; chain: string; key: string; name: string; total: string | null },
  savedAt: string,
): OutboxEntry {
  return {
    command,
    status: 'waiting',
    sent: false,
    error: null,
    customerId: fields.chain,
    key: fields.key,
    base: null,
    name: fields.name,
    lines: null,
    total: fields.total,
    savedAt,
    shiftId: fields.shiftId,
  };
}

const SAVE_ATTEMPTS = 3;

function tooManyTries(): never {
  throw new Error('The shift kept changing during the save');
}

// ---------------------------------------------------------------------------------------------
// Opening

// Where the next shift of a register goes on from: its number, and what the drawer should hold.
// This device's own last shift of the register when it is the latest (its close may not have
// reached the server yet), else the register's lastShift from the pull (decision 17). first = the
// register never had a shift: there is nothing to compare with, and the count is the float
// (decision 12). cashLeft is null for a first shift, and when the server's last shift is still
// open there (a device lost with it): the server compares, the device has nothing to say.
export interface ShiftStart {
  sequence: number;
  number: string;
  first: boolean;
  cashLeft: string | null;
}

export function shiftStart(
  register: Pick<SyncPosRegister, 'id' | 'code' | 'lastShift'>,
  own: DeviceShift | null,
): ShiftStart {
  const server = register.lastShift;
  const mine = own?.registerId === register.id && own.status === 'closed' ? own : null;
  const next = (sequence: number) => ({
    sequence: sequence + 1,
    number: formatShiftNumber(register.code, sequence + 1),
  });
  if (mine && (!server || mine.sequence >= server.sequence)) {
    return { ...next(mine.sequence), first: false, cashLeft: mine.counted };
  }
  if (server) return { ...next(server.sequence), first: false, cashLeft: server.cashLeft };
  return { ...next(0), first: true, cashLeft: null };
}

export interface ShiftOpenSave {
  register: Pick<SyncPosRegister, 'id' | 'code' | 'lastShift'>;
  // posShiftOpenInputSchema's output, less what the save decides
  input: Omit<PosShiftOpenInput, 'registerId' | 'sequence'>;
  savedAt: string;
}

// opened: the shift and where it started from (the toast says the difference). not-held: the
// claim is gone or is another register's. open-already: another tab opened a shift meanwhile.
export type ShiftOpenResult =
  | { kind: 'opened'; shift: DeviceShift; start: ShiftStart }
  | { kind: 'not-held' }
  | { kind: 'open-already' };

// The claim, the shift's row and the outbox in one transaction, like a sale's number: the shift is
// open on the device only when its open is in the outbox. Sealed first, written only if the claim
// and the row are still the ones read (another tab), else again from what is there now.
export async function openShift(copy: LocalCopy, save: ShiftOpenSave): Promise<ShiftOpenResult> {
  const { db } = copy;
  const { register, input } = save;
  const shiftId = uuidv7();
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const claim = await db.registerClaim.get('claim');
    if (claim?.registerId !== register.id) return { kind: 'not-held' };
    const before = await db.posShift.get('shift');
    const own = before ? await copy.open('posShift', 'shift', before.box) : null;
    if (own?.status === 'open') return { kind: 'open-already' };
    const start = shiftStart(register, own);
    const shift: DeviceShift = {
      id: shiftId,
      registerId: register.id,
      sequence: start.sequence,
      number: start.number,
      status: 'open',
      openedAt: input.openedAt,
      openingDate: input.date,
      opening: input.opening,
      // A first shift's float is its opening, not a pay in (expectedCashOf counts it once)
      cash: {
        opening: input.opening.total,
        cashTaken: '0',
        changeGiven: '0',
        paidIn: '0',
        paidOut: '0',
      },
      closedAt: null,
      counted: null,
      expected: null,
    };
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_shift.open',
      shiftId,
      input: {
        ...input,
        registerId: register.id,
        sequence: start.sequence,
        // Only a first shift names where its float came from (the server ignores it otherwise)
        floatReasonId: start.first ? input.floatReasonId : null,
      },
    };
    const entry = await sealEntry(
      copy,
      shiftEntry(
        command,
        { shiftId, chain: shiftId, key: shiftId, name: start.number, total: input.opening.total },
        save.savedAt,
      ),
    );
    const row = await sealShift(copy, shift, (before?.rev ?? 0) + 1);
    const written = await db.transaction(
      'rw',
      [db.registerClaim, db.posShift, db.outbox],
      async () => {
        const now = await db.registerClaim.get('claim');
        if (now?.registerId !== register.id) return 'not-held';
        if ((await db.posShift.get('shift'))?.rev !== before?.rev) return 'changed';
        await db.posShift.put(row);
        await db.outbox.add(entry);
        return 'written';
      },
    );
    if (written === 'not-held') return { kind: 'not-held' };
    if (written === 'written') return { kind: 'opened', shift, start };
  }
  return tooManyTries();
}

// ---------------------------------------------------------------------------------------------
// A sale's cash (pos.ts calls this inside its own save)

// The cash a sale brings into the shift: what it took in cash, and the change it gave back
export function cashAfterSale(
  cash: ShiftCash,
  sale: { cashTaken: string; changeGiven: string },
): ShiftCash {
  return {
    ...cash,
    cashTaken: addMoney(cash.cashTaken, sale.cashTaken),
    changeGiven: addMoney(cash.changeGiven, sale.changeGiven),
  };
}

// The sale's save reads the shift and writes it back with the sale; null = no open shift with
// this id. pos.ts checks the rev inside its transaction.
export async function shiftForSale(
  copy: LocalCopy,
  shiftId: string,
  sale: { cashTaken: string; changeGiven: string },
): Promise<{ before: ShiftRow; row: ShiftRow } | null> {
  const open = await openShiftOf(copy, shiftId);
  if (!open) return null;
  const shift = { ...open.shift, cash: cashAfterSale(open.shift.cash, sale) };
  return { before: open.row, row: await sealShift(copy, shift, open.row.rev + 1) };
}

// ---------------------------------------------------------------------------------------------
// Pay in and pay out

export interface CashMoveSave {
  // posCashMovementInputSchema's output
  input: PosCashMovementInput;
  direction: SyncPosCashReason['direction'];
  // The Sync page's name for it, in the cashier's language: "৳10,000 paid out for Cash to the bank"
  name: string;
  savedAt: string;
}

// too-large: a pay out of more than the drawer should hold (pos_pay_out_too_large). The device
// knows the expected cash, and the cashier does not see it (decision 3): only this answer says it.
export type CashMoveResult = { kind: 'saved' } | { kind: 'no-shift' } | { kind: 'too-large' };

export async function moveCash(copy: LocalCopy, save: CashMoveSave): Promise<CashMoveResult> {
  const { db } = copy;
  const { input } = save;
  const movementId = uuidv7();
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const open = await openShiftOf(copy, input.shiftId);
    if (!open) return { kind: 'no-shift' };
    const { cash } = open.shift;
    if (save.direction === 'out' && compareMoney(input.amount, expectedCashOf(cash)) > 0) {
      return { kind: 'too-large' };
    }
    const shift: DeviceShift = {
      ...open.shift,
      cash:
        save.direction === 'in'
          ? { ...cash, paidIn: addMoney(cash.paidIn, input.amount) }
          : { ...cash, paidOut: addMoney(cash.paidOut, input.amount) },
    };
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_cash_movement.create',
      movementId,
      input,
    };
    const entry = await sealEntry(
      copy,
      shiftEntry(
        command,
        {
          shiftId: input.shiftId,
          chain: movementId,
          key: movementId,
          name: save.name,
          total: input.amount,
        },
        save.savedAt,
      ),
    );
    const row = await sealShift(copy, shift, open.row.rev + 1);
    const written = await db.transaction('rw', [db.posShift, db.outbox], async () => {
      if ((await db.posShift.get('shift'))?.rev !== open.row.rev) return false;
      await db.posShift.put(row);
      await db.outbox.add(entry);
      return true;
    });
    if (written) return { kind: 'saved' };
  }
  return tooManyTries();
}

// ---------------------------------------------------------------------------------------------
// Closing

export interface ShiftCloseSave {
  shiftId: string;
  // posShiftCloseInputSchema's output, less what the device works out
  input: Omit<PosShiftCloseInput, 'deviceExpected' | 'heldDropped'>;
  savedAt: string;
}

// closed: the shift as the result screen shows it (counted, expected), and the difference
// (counted less expected: above zero = over). no-shift: closed already (another tab).
export type ShiftCloseResult =
  { kind: 'closed'; shift: DeviceShift; difference: string } | { kind: 'no-shift' };

// The close is final (decision 9). It drops the shift's carts, held or on the screen, in the same
// transaction, and says how many held ones it dropped; they are counted again inside it, so a hold
// in another tab meanwhile makes the save start again rather than send a wrong number.
export async function closeShift(copy: LocalCopy, save: ShiftCloseSave): Promise<ShiftCloseResult> {
  const { db } = copy;
  const { shiftId, input } = save;
  const heldOf = async () =>
    (await db.posCarts.where('shiftId').equals(shiftId).primaryKeys()).filter(
      (key) => key !== SCREEN_CART,
    ).length;
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const open = await openShiftOf(copy, shiftId);
    if (!open) return { kind: 'no-shift' };
    const held = await heldOf();
    const expected = expectedCashOf(open.shift.cash);
    const shift: DeviceShift = {
      ...open.shift,
      status: 'closed',
      closedAt: input.closedAt,
      counted: input.counted.total,
      expected,
    };
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_shift.close',
      shiftId,
      input: { ...input, deviceExpected: expected, heldDropped: Math.min(held, MAX_HELD_CARTS) },
    };
    const entry = await sealEntry(
      copy,
      shiftEntry(
        command,
        { shiftId, chain: command.id, key: shiftId, name: open.shift.number, total: null },
        save.savedAt,
      ),
    );
    const row = await sealShift(copy, shift, open.row.rev + 1);
    const written = await db.transaction('rw', [db.posShift, db.posCarts, db.outbox], async () => {
      if ((await db.posShift.get('shift'))?.rev !== open.row.rev) return false;
      if ((await heldOf()) !== held) return false;
      await db.posShift.put(row);
      await db.posCarts.where('shiftId').equals(shiftId).delete();
      await db.outbox.add(entry);
      return true;
    });
    if (written) {
      return { kind: 'closed', shift, difference: cashDifferenceOf(input.counted.total, expected) };
    }
  }
  return tooManyTries();
}
```

- **`shiftState()` takes the database, not the copy:** the lock screen has no key, and the row's clear fields are all
  it needs (decision 72). Everything else takes the open `LocalCopy`, with no Dexie import, like `pos.ts`.
- **`localCashReasons()` sorts like the settings page** (decision 62): "in" first, then by name.
- **`shiftStart()` is pure:** the open card shows its first-shift question from it before anything is saved, and the
  save uses it again inside its loop, from the row as it is then (decision 73). `cashLeft` is `null` when there is
  nothing to compare with: a first shift, or a server shift still open (a lost device). The device then says only that
  the shift is open; the server compares and books.
- **`openShift()` reads, seals, then writes in one transaction:** the claim, the shift's row and the outbox, like a
  sale's number. The shift is open on the device only when its open command is in the outbox. The shift's id is made
  once, before the loop: a second try sends the same shift.
- **The float reason only on a first shift:** the server ignores it otherwise (20b.3), and a reason picked on the card
  of a first shift that became a later one meanwhile (another device's close arrived) is dropped here, not sent.
- **`shiftForSale()` and `cashAfterSale()`:** `pos.ts` calls them inside a sale's save (decision 71), so the shift's
  cash changes in the same transaction as the sale goes into the outbox.
- **`moveCash()` refuses a pay out above the expected cash** (decision 79), with the cash read in the same try that
  writes it.
- **`closeShift()` counts the held carts twice:** before sealing (the number goes into the command) and inside the
  transaction. If a hold came in between, the save starts again: the audit log's number is never wrong.
- **The close's command has its own chain value** (its id): it must not wait behind the open by the customer rule, only
  by the shift rule of `pickBatch()`.

### `packages/sync/src/pos.ts`: the sale's shift and cash

```diff
@@ -2,9 +2,11 @@ import {
   addQuantity,
   formatPosNumber,
   type PosRegister,
+  posChangeOf,
   type PosSaleInput,
   type Product,
   subtractQuantity,
+  sumMoney,
   type SyncCommand,
   type SyncPosRegister,
   type SyncStock,
@@ -12,9 +14,12 @@ import {
 } from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
 
+import { SCREEN_CART } from './carts.js';
 import type { LocalCopy } from './copy.js';
 import type { RegisterClaim } from './database.js';
+import { isCounterCommand } from './outbox.js';
 import { openEntries, openRows, sealEntry } from './sealed.js';
+import { shiftForSale } from './shift.js';
 
 // Step 20a: the POS on the device. The registers of the branch come with the pull; the claim says
 // which one this device holds and the last number it gave; a sale goes into the outbox with the
@@ -61,11 +66,12 @@ export async function dropClaim(copy: LocalCopy): Promise<void> {
   await copy.db.registerClaim.delete('claim');
 }
 
-// The POS sales still on the device. A device holds one register at a time and lets it go only
-// when this is 0 (decision 14), so they are all sales of the register it holds. The command's type
-// is a clear field of the row: nothing is opened.
-export async function waitingSales(copy: LocalCopy): Promise<number> {
-  return copy.db.outbox.filter((row) => row.type === 'pos_sale.create').count();
+// The POS commands still on the device. A device holds one register at a time and lets it go only
+// when this is 0 (decision 14), so they are all of the register it holds. The command's type is a
+// clear field of the row: nothing is opened. Step 20b: a shift's commands count too: the server
+// lets the register go only once the shift's close has arrived.
+export async function waitingAtCounter(copy: LocalCopy): Promise<number> {
+  return copy.db.outbox.filter((row) => isCounterCommand(row.type)).count();
 }
 
 // What the POS screen saves. The sale is complete and checked (posSaleInputSchema's output),
@@ -82,8 +88,11 @@ export interface PosSaleSave {
 // saved: in the outbox, with this number and the sale's id (a UUIDv7 made here, like every id the
 // device makes; step 20c's return points at it). not-held: the claim is gone or is another
 // register's (another tab changed the register meanwhile); the screen asks for a register again.
+// no-shift (step 20b): the sale's shift is not open on the device any more (closed in another tab).
 export type PosSaveResult =
-  { kind: 'saved'; saleId: string; sequence: number; number: string } | { kind: 'not-held' };
+  | { kind: 'saved'; saleId: string; sequence: number; number: string }
+  | { kind: 'not-held' }
+  | { kind: 'no-shift' };
 
 const SAVE_ATTEMPTS = 3;
 
@@ -92,12 +101,26 @@ const SAVE_ATTEMPTS = 3;
 // number the claim gives now (a transaction cannot wait for Web Crypto), and written only if the
 // claim still says the same; else another tab sold meanwhile, and the save starts again with the
 // next number. Three times in a row would take three tabs selling at the same moment.
+// Step 20b: the shift's cash goes in the same transaction (the cash the sale took, the change it
+// gave), checked the same way, so the close's expected cash counts every sale exactly once.
 export async function savePosSale(copy: LocalCopy, save: PosSaleSave): Promise<PosSaveResult> {
   const { db } = copy;
   const saleId = uuidv7();
+  const { payments } = save.input;
+  const sale = {
+    cashTaken: sumMoney(
+      payments.filter((payment) => payment.method === 'cash').map((payment) => payment.amount),
+    ),
+    // Change is given in cash, whatever the methods
+    changeGiven: posChangeOf(payments, save.total),
+  };
   for (let attempt = 1; ; attempt += 1) {
     const claim = await db.registerClaim.get('claim');
     if (claim?.registerId !== save.input.registerId) return { kind: 'not-held' };
+    // A sale saved before 20b's screen has no shift; every new one has
+    const shift =
+      save.input.shiftId === null ? null : await shiftForSale(copy, save.input.shiftId, sale);
+    if (save.input.shiftId !== null && !shift) return { kind: 'no-shift' };
     const sequence = claim.last + 1;
     const number = formatPosNumber(save.registerCode, sequence);
     const command: SyncCommand = {
@@ -123,12 +146,18 @@ export async function savePosSale(copy: LocalCopy, save: PosSaleSave): Promise<P
       lines: save.input.lines.length,
       total: save.total,
       savedAt: save.savedAt,
+      ...(save.input.shiftId !== null && { shiftId: save.input.shiftId }),
     });
-    const saved = await db.transaction('rw', [db.registerClaim, db.outbox], async () => {
+    const tables = [db.registerClaim, db.outbox, db.posShift, db.posCarts];
+    const saved = await db.transaction('rw', tables, async () => {
       const now = await db.registerClaim.get('claim');
       if (now?.registerId !== claim.registerId || now.last !== claim.last) return false;
+      if (shift && (await db.posShift.get('shift'))?.rev !== shift.before.rev) return false;
       await db.registerClaim.put({ ...claim, last: sequence });
       await db.outbox.add(row);
+      if (shift) await db.posShift.put(shift.row);
+      // The cart on the screen is this sale now: a reload must not bring it back to be sold twice
+      await db.posCarts.delete(SCREEN_CART);
       return true;
     });
     if (saved) return { kind: 'saved', saleId, sequence, number };
```

- **`waitingAtCounter()`:** renamed from `waitingSales()`, because it counts all four counter commands now (decision 86).
  Its two callers change with it (the page's Change register, the session's release).
- **The sale's cash is worked out once, before the loop:** the cash payments and the change (`posChangeOf()`, the same
  function as the receipt's). Change is always given in cash, whatever the methods.
- **`no-shift`:** the sale's shift is not open on the device any more. A sale with `shiftId: null` (an old outbox row
  being retried) still saves, as in 20a (decision 24).
- **The transaction checks the claim and the shift's `rev`:** either changed means another tab sold, and the save starts
  again with the next number and the shift's new cash.
- **It deletes the screen's cart** (decision 75). The screen also empties its cart after the sale, but only this
  transaction makes it impossible for a reload to bring the sold cart back.

### `packages/sync/src/index.ts` and `test-fixtures.ts`

```diff
@@ -1,16 +1,34 @@
 // Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
 // the outbox's saves (outbox, overlay, prices; step 18b), the key's code (crypto, keys; step 19b),
-// the POS's register and sale (pos; step 20a) and the types: none of them loads Dexie at run time, so a page that searches customers or a
+// the POS's register and sale (pos; step 20a), its shift and carts (shift, carts; step 20b) and the
+// types: none of them loads Dexie at run time, so a page that searches customers or a
 // form that saves offline stays small. The code that opens the database and syncs (database,
 // copy, apply, push, engine, live, device) brings Dexie, and the app loads it once, lazily, after
 // sign-in. `sideEffects: false` in package.json lets the bundler leave out the modules a chunk
 // does not use.
 export { applyPage, type SealedChanges, sealChanges, writeSealed } from './apply.js';
+export {
+  dropCart,
+  type HeldCartItem,
+  heldCarts,
+  heldCount,
+  holdCart,
+  type PosCart,
+  type PosCartCustomer,
+  type PosCartLine,
+  resumeCart,
+  saveScreenCart,
+  SCREEN_CART,
+  screenCart,
+} from './carts.js';
 export { LocalCopy, Mirror } from './copy.js';
 export { type Box, isPin, PIN_ITERATIONS, PIN_LENGTH } from './crypto.js';
 export {
+  type CartRow,
   databaseName,
   deleteLocalDatabase,
+  type DeviceShift,
+  type HeldCart,
   type MirroredTable,
   type NoticeRow,
   type OutboxBody,
@@ -22,6 +40,7 @@ export {
   type PullState,
   type RegisterClaim,
   type SealedRow,
+  type ShiftRow,
   type StockRow,
   SyncDatabase,
   type SyncNoticeRecord,
@@ -63,6 +82,7 @@ export {
   dependentsOf,
   discardEntry,
   dismissNotice,
+  isCounterCommand,
   isOpen,
   type OrderSave,
   retryEntry,
@@ -81,7 +101,7 @@ export {
   readClaim,
   savePosSale,
   stockOf,
-  waitingSales,
+  waitingAtCounter,
 } from './pos.js';
 export { lookUpPrices, productsOfVariants } from './prices.js';
 export { STORAGE_FAILED } from './problems.js';
@@ -124,4 +144,22 @@ export {
   productRecord,
   searchText,
 } from './records.js';
+export {
+  cashAfterSale,
+  type CashMoveResult,
+  type CashMoveSave,
+  closeShift,
+  localCashReasons,
+  moveCash,
+  openShift,
+  readShift,
+  type ShiftCloseResult,
+  type ShiftCloseSave,
+  type ShiftOpenResult,
+  type ShiftOpenSave,
+  type ShiftStart,
+  shiftStart,
+  type ShiftState,
+  shiftState,
+} from './shift.js';
 export { NO_PULL, readPullState, syncedAtOf } from './state.js';
```

```diff
@@ -4,6 +4,8 @@ import type {
   SalesOrderDraftInput,
   SyncChange,
   SyncCustomer,
+  SyncPosCashReason,
+  SyncPosRegister,
   SyncPull,
 } from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
@@ -183,3 +185,43 @@ export function orderDraft(customerId: string, variantId: string): SalesOrderDra
     ],
   };
 }
+
+// Step 20a: a register of the branch, as the pull sends it. Step 20b: with its shift settings, an
+// over/short account and no shift yet.
+export function posRegister(
+  fields: Partial<SyncPosRegister> & Pick<SyncPosRegister, 'code'>,
+): SyncPosRegister {
+  return {
+    id: uuidv7(),
+    name: 'Front counter',
+    branchId: '01928c4e-6666-7000-8000-000000000001',
+    warehouseId: WAREHOUSE,
+    accounts: { cash: uuidv7(), card: null, bkash: null, nagad: null },
+    maxDiscountPercent: '10.00',
+    paperWidth: '80',
+    receiptFooter: null,
+    overShortAccountId: uuidv7(),
+    varianceAlert: '500',
+    lockAfter: '5',
+    deviceId: null,
+    lastShift: null,
+    archivedAt: null,
+    version: 1,
+    updatedAt: '2026-10-27T04:00:00.000Z',
+    ...fields,
+  };
+}
+
+// Step 20b: a pay in or pay out reason
+export function cashReason(
+  fields: Partial<SyncPosCashReason> & Pick<SyncPosCashReason, 'name' | 'direction'>,
+): SyncPosCashReason {
+  return {
+    id: uuidv7(),
+    accountId: uuidv7(),
+    archivedAt: null,
+    version: 1,
+    updatedAt: UPDATED,
+    ...fields,
+  };
+}
```

- **`posRegister()` moved to the fixtures** from `pos.spec.ts`, with the register's three new fields and `lastShift`:
  the shift's spec needs it too. `cashReason()` is new.

### The sync tests

```ts
import 'fake-indexeddb/auto';

import {
  MAX_HELD_CARTS,
  type PosSaleInput,
  syncCommandSchema,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import {
  heldCarts,
  heldCount,
  holdCart,
  type PosCart,
  resumeCart,
  saveScreenCart,
  screenCart,
} from './carts.js';
import { applyPage } from './apply.js';
import type { LocalCopy } from './copy.js';
import type { HeldCart } from './database.js';
import { keepClaim, savePosSale } from './pos.js';
import { outboxEntries } from './queries.js';
import {
  closeShift,
  localCashReasons,
  moveCash,
  openShift,
  readShift,
  shiftStart,
  shiftState,
} from './shift.js';
import { cashReason, newCopy, page, posRegister, VAT_15 } from './test-fixtures.js';

const OPENED = '2026-10-29T03:02:00.000Z';
const DAY = '2026-10-29';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';
const BASE_UNIT = '01928c4e-0000-7000-8000-000000000001';

// A copy that holds POS1, ready to open a shift
async function counter(fields: Partial<SyncPosRegister> = {}) {
  const copy = await newCopy();
  const register = posRegister({ code: 'POS1', ...fields });
  await keepClaim(copy, { id: register.id, lastNumber: 0 });
  return { copy, register };
}

function count(total: string) {
  return { notes: null, total };
}

async function open(copy: LocalCopy, register: SyncPosRegister, total = '5000.00') {
  const result = await openShift(copy, {
    register,
    input: {
      date: DAY,
      openedAt: OPENED,
      opening: count(total),
      floatReasonId: null,
    },
    savedAt: OPENED,
  });
  if (result.kind !== 'opened') throw new Error(`The shift did not open: ${result.kind}`);
  return result;
}

// A walk-in sale of ৳840, paid ৳1,000 in cash: ৳160 change
function sale(registerId: string, shiftId: string): Omit<PosSaleInput, 'sequence'> {
  return {
    registerId,
    shiftId,
    date: DAY,
    soldAt: OPENED,
    customerId: null,
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

const EMPTY: PosCart = { customer: null, lines: [], billDiscountType: 'amount', billDiscount: '' };

function held(name: string | null, lines = 1): HeldCart {
  const line = sale('', '').lines[0];
  if (!line) throw new Error('line');
  return {
    name,
    heldAt: OPENED,
    items: lines,
    total: '840.0000',
    cart: {
      ...EMPTY,
      lines: Array.from({ length: lines }, (_, index) => ({
        ...line,
        key: `line-${String(index)}`,
        productId: uuidv7(),
        factor: '1',
        name: 'Miniket rice 5 kg',
        sku: 'RICE-5',
        unitCode: 'bag',
        decimals: 0,
        tracking: 'none',
        goods: true,
        unitPrice: '420',
      })),
    },
  };
}

describe('the reasons on the device', () => {
  it('keeps the reasons the pull sends, sealed, "in" first and then by name', async () => {
    const copy = await newCopy();
    const reasons = [
      cashReason({ name: 'Tea for the staff', direction: 'out' }),
      cashReason({ name: 'Float from the owner', direction: 'in' }),
      cashReason({ name: 'Cash to the bank', direction: 'out' }),
    ];
    await applyPage(
      copy,
      page({
        changes: reasons.map((row) => ({
          op: 'upsert' as const,
          entity: 'pos_cash_reason' as const,
          key: row.id,
          data: row,
        })),
      }),
      null,
    );
    expect((await localCashReasons(copy)).map((row) => row.name)).toEqual([
      'Float from the owner',
      'Cash to the bank',
      'Tea for the staff',
    ]);
  });
});

describe('shiftStart', () => {
  const register = posRegister({ code: 'POS1' });

  it('starts a register’s first shift at 1, with nothing to compare with', () => {
    expect(shiftStart(register, null)).toEqual({
      sequence: 1,
      number: 'POS1-S0001',
      first: true,
      cashLeft: null,
    });
  });

  it('goes on from the server’s last shift, or from this device’s own when it is later', () => {
    const lastShift = {
      id: uuidv7(),
      sequence: 41,
      status: 'closed' as const,
      cashLeft: '5000.00',
    };
    expect(shiftStart({ ...register, lastShift }, null)).toMatchObject({
      sequence: 42,
      number: 'POS1-S0042',
      first: false,
      cashLeft: '5000.00',
    });
    // Its own close has not reached the server yet: the device's count is the newer one
    const own = {
      id: uuidv7(),
      registerId: register.id,
      sequence: 42,
      number: 'POS1-S0042',
      status: 'closed' as const,
      openedAt: OPENED,
      openingDate: DAY,
      opening: count('5000.00'),
      cash: { opening: '5000', cashTaken: '0', changeGiven: '0', paidIn: '0', paidOut: '0' },
      closedAt: OPENED,
      counted: '7640.00',
      expected: '8160.0000',
    };
    expect(shiftStart({ ...register, lastShift }, own)).toMatchObject({
      sequence: 43,
      cashLeft: '7640.00',
    });
    // Another register's shift says nothing about this one
    expect(shiftStart({ ...register, lastShift }, { ...own, registerId: uuidv7() })).toMatchObject({
      sequence: 42,
    });
  });
});

describe('a shift on the device', () => {
  it('opens with a command the server reads, and only on the register the device holds', async () => {
    const { copy, register } = await counter();
    const { shift } = await open(copy, register);
    expect(shift).toMatchObject({ number: 'POS1-S0001', status: 'open' });
    const [entry] = await outboxEntries(copy);
    expect(entry?.shiftId).toBe(shift.id);
    expect(syncCommandSchema.parse(entry?.command)).toMatchObject({
      type: 'pos_shift.open',
      shiftId: shift.id,
      input: { registerId: register.id, sequence: 1, floatReasonId: null },
    });
    // The lock screen reads this without the key; the amounts are in the box only
    expect(await shiftState(copy.db)).toEqual({
      shiftId: shift.id,
      registerId: register.id,
      number: 'POS1-S0001',
      status: 'open',
    });
    // A second open (another tab) and an open on a register the device does not hold
    const again = await openShift(copy, {
      register,
      input: { date: DAY, openedAt: OPENED, opening: count('0'), floatReasonId: null },
      savedAt: OPENED,
    });
    expect(again.kind).toBe('open-already');
    const other = await counter();
    const notHeld = await openShift(other.copy, {
      register,
      input: { date: DAY, openedAt: OPENED, opening: count('0'), floatReasonId: null },
      savedAt: OPENED,
    });
    expect(notHeld.kind).toBe('not-held');
  });

  it('adds up the cash of its sales and movements, and closes with what it expected', async () => {
    const { copy, register } = await counter();
    const { shift } = await open(copy, register);
    for (let index = 0; index < 2; index += 1) {
      const saved = await savePosSale(copy, {
        input: sale(register.id, shift.id),
        registerCode: 'POS1',
        total: '840.0000',
        savedAt: OPENED,
      });
      expect(saved.kind).toBe('saved');
    }
    const move = (direction: 'in' | 'out', amount: string) =>
      moveCash(copy, {
        input: {
          shiftId: shift.id,
          reasonId: uuidv7(),
          amount,
          note: null,
          date: DAY,
          movedAt: OPENED,
        },
        direction,
        name: `${amount} ${direction}`,
        savedAt: OPENED,
      });
    expect(await move('in', '2000')).toEqual({ kind: 'saved' });
    // 5,000 + 2,000 in cash − 320 change + 2,000 = ৳8,680 in the drawer: no more goes out
    expect(await move('out', '8680.01')).toEqual({ kind: 'too-large' });
    expect(await move('out', '1000')).toEqual({ kind: 'saved' });
    expect((await readShift(copy))?.cash).toEqual({
      opening: '5000.00',
      cashTaken: '2000.0000',
      changeGiven: '320.0000',
      paidIn: '2000.0000',
      paidOut: '1000.0000',
    });

    await holdCart(copy, shift.id, held('Customer in the blue shirt'));
    await saveScreenCart(copy, shift.id, held(null));
    const closed = await closeShift(copy, {
      shiftId: shift.id,
      input: { date: DAY, closedAt: OPENED, counted: count('7640.00') },
      savedAt: OPENED,
    });
    expect(closed).toMatchObject({
      kind: 'closed',
      shift: { status: 'closed', counted: '7640.00', expected: '7680.0000' },
      difference: '-40.0000',
    });
    const entries = await outboxEntries(copy);
    const close = entries.at(-1);
    expect(syncCommandSchema.parse(close?.command)).toMatchObject({
      type: 'pos_shift.close',
      input: { deviceExpected: '7680.0000', heldDropped: 1 },
    });
    // The open, two sales, three movements (the refused pay out never went in) and the close
    expect(entries.map((entry) => entry.command.type)).toEqual([
      'pos_shift.open',
      'pos_sale.create',
      'pos_sale.create',
      'pos_cash_movement.create',
      'pos_cash_movement.create',
      'pos_shift.close',
    ]);
    expect(entries.every((entry) => entry.shiftId === shift.id)).toBe(true);
    // The carts went with the shift, and nothing sells on it now
    expect(await copy.db.posCarts.count()).toBe(0);
    const late = await savePosSale(copy, {
      input: sale(register.id, shift.id),
      registerCode: 'POS1',
      total: '840.0000',
      savedAt: OPENED,
    });
    expect(late.kind).toBe('no-shift');
    // The next shift goes on from this one, and compares with its count
    const next = await open(copy, register, '7640.00');
    expect(next.start).toMatchObject({ number: 'POS1-S0002', first: false, cashLeft: '7640.00' });
  });
});

describe('held carts', () => {
  it('holds up to the limit, resumes one in the screen cart’s place, and a sale clears the screen', async () => {
    const { copy, register } = await counter();
    const { shift } = await open(copy, register);
    await saveScreenCart(copy, shift.id, held(null, 2));
    expect(await holdCart(copy, shift.id, held('Blue shirt'))).toBe('held');
    // Holding takes the cart off the screen: a reload brings back an empty one
    expect(await screenCart(copy, shift.id)).toBeNull();
    for (let index = 1; index < MAX_HELD_CARTS; index += 1) {
      await holdCart(copy, shift.id, { ...held(`Bill ${String(index)}`), heldAt: OPENED });
    }
    expect(await holdCart(copy, shift.id, held('One too many'))).toBe('full');
    expect(await heldCount(copy, shift.id)).toBe(MAX_HELD_CARTS);

    // Resuming with a cart on the screen swaps the two: the count stays, nothing is lost
    const [first] = await heldCarts(copy, shift.id);
    if (!first) throw new Error('no held cart');
    const screen = held('On the screen', 3);
    const resumed = await resumeCart(copy, shift.id, first.id, screen);
    expect(resumed?.name).toBe('Blue shirt');
    expect(await heldCount(copy, shift.id)).toBe(MAX_HELD_CARTS);
    expect((await screenCart(copy, shift.id))?.lines).toHaveLength(1);
    // Gone already (another tab): nothing changes
    expect(await resumeCart(copy, shift.id, first.id, null)).toBeNull();

    // The sale of the screen's cart takes it off the device in its own transaction
    await savePosSale(copy, {
      input: sale(register.id, shift.id),
      registerCode: 'POS1',
      total: '840.0000',
      savedAt: OPENED,
    });
    expect(await screenCart(copy, shift.id)).toBeNull();
    // Another shift's screen cart is not this one's
    await saveScreenCart(copy, shift.id, held(null));
    expect(await screenCart(copy, uuidv7())).toBeNull();
  });
});
```

```diff
@@ -1,12 +1,6 @@
 import 'fake-indexeddb/auto';
 
-import {
-  type PosSaleInput,
-  stockKey,
-  type SyncPosRegister,
-  type SyncStock,
-  syncCommandSchema,
-} from '@omnivo/contracts';
+import { type PosSaleInput, stockKey, type SyncStock, syncCommandSchema } from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
 import { describe, expect, it } from 'vitest';
 
@@ -21,11 +15,19 @@ import {
   readClaim,
   savePosSale,
   stockOf,
-  waitingSales,
+  waitingAtCounter,
 } from './pos.js';
 import { outboxEntries } from './queries.js';
 import { sealEntry } from './sealed.js';
-import { newCopy, page, product, upsertProduct, VAT_15, WAREHOUSE } from './test-fixtures.js';
+import {
+  newCopy,
+  page,
+  posRegister as register,
+  product,
+  upsertProduct,
+  VAT_15,
+  WAREHOUSE,
+} from './test-fixtures.js';
 
 const SAVED = '2026-10-27T10:15:00.000Z';
 const OTHER_WAREHOUSE = '01928c4e-7777-7000-8000-000000000009';
@@ -33,24 +35,6 @@ const VARIANT = '01928c4e-8888-7000-8000-000000000001';
 const BASE_UNIT = '01928c4e-0000-7000-8000-000000000001';
 const BOX = '01928c4e-0000-7000-8000-000000000002';
 
-function register(fields: Partial<SyncPosRegister> & Pick<SyncPosRegister, 'code'>) {
-  return {
-    id: uuidv7(),
-    name: 'Front counter',
-    branchId: '01928c4e-6666-7000-8000-000000000001',
-    warehouseId: WAREHOUSE,
-    accounts: { cash: uuidv7(), card: null, bkash: null, nagad: null },
-    maxDiscountPercent: '10.00',
-    paperWidth: '80',
-    receiptFooter: null,
-    deviceId: null,
-    archivedAt: null,
-    version: 1,
-    updatedAt: '2026-10-27T04:00:00.000Z',
-    ...fields,
-  } satisfies SyncPosRegister;
-}
-
 function stock(fields: Partial<SyncStock>): SyncStock {
   return {
     warehouseId: WAREHOUSE,
@@ -73,6 +57,8 @@ function sale(
 ): Omit<PosSaleInput, 'sequence'> {
   return {
     registerId,
+    // A sale of 20a's screen: no shift (shift.spec.ts has the shift's own)
+    shiftId: null,
     date: '2026-10-27',
     soldAt: SAVED,
     customerId,
@@ -194,7 +180,7 @@ describe('savePosSale', () => {
     expect(results.map((result) => result.kind === 'saved' && result.sequence).sort()).toEqual([
       42, 43,
     ]);
-    expect(await waitingSales(copy)).toBe(2);
+    expect(await waitingAtCounter(copy)).toBe(2);
   });
 
   it('saves nothing without the claim of that register', async () => {
@@ -202,7 +188,7 @@ describe('savePosSale', () => {
     expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
     await keepClaim(copy, { id: uuidv7(), lastNumber: 3 });
     expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
-    expect(await waitingSales(copy)).toBe(0);
+    expect(await waitingAtCounter(copy)).toBe(0);
   });
 });
 
@@ -225,7 +211,7 @@ describe('discarding a POS sale', () => {
       }),
     );
     expect(await discardEntry(copy, entry.seq)).toBe('saved');
-    expect(await waitingSales(copy)).toBe(0);
+    expect(await waitingAtCounter(copy)).toBe(0);
   });
 });
 
```

```diff
@@ -69,6 +69,38 @@ describe('pickBatch', () => {
     // The first always goes, even alone
     expect(pickBatch([one, two])).toEqual([one]);
   });
+
+  // Step 20b: open → sales and movements → close, and the next open after the close
+  it('sends a shift’s commands in the order the server needs them', () => {
+    const shift = '01928c4e-5555-7000-8000-000000000001';
+    const next = '01928c4e-5555-7000-8000-000000000002';
+    const counter = (type: OutboxRow['type'], shiftId: string, chain: string) =>
+      row(`01928c4e-6666-7000-8000-${chain.padStart(12, '0')}`, { type, shiftId });
+    const open = counter('pos_shift.open', shift, '1');
+    const sale = counter('pos_sale.create', shift, '2');
+    const otherSale = counter('pos_sale.create', shift, '3');
+    const payOut = counter('pos_cash_movement.create', shift, '4');
+    const close = counter('pos_shift.close', shift, '5');
+    const nextOpen = counter('pos_shift.open', next, '6');
+    const rows = [open, sale, otherSale, payOut, close, nextOpen];
+    // The open alone: the server must know the shift before its sales
+    expect(pickBatch(rows)).toEqual([open]);
+    // Then every sale and movement together (a walk-in sale holds back no other), not the close
+    expect(pickBatch(rows.slice(1))).toEqual([sale, otherSale, payOut]);
+    // Then the close, and only after it the next shift's open
+    expect(pickBatch(rows.slice(4))).toEqual([close]);
+    expect(pickBatch(rows.slice(5))).toEqual([nextOpen]);
+    // A refused sale keeps the close on the device: the server's expected cash would miss it
+    expect(pickBatch([{ ...sale, status: 'failed' }, close])).toEqual([]);
+    // A customer's command and a 20a sale without a shift go as before
+    const customerCommand = row('01928c4e-7777-7000-8000-000000000001');
+    const oldSale = row('01928c4e-7777-7000-8000-000000000002', { type: 'pos_sale.create' });
+    expect(pickBatch([open, sale, customerCommand, oldSale])).toEqual([
+      open,
+      customerCommand,
+      oldSale,
+    ]);
+  });
 });
 
 async function engineWith(push: (input: SyncPushInput) => Promise<SyncPush>) {
```

- **`shift.spec.ts`:** the reasons from a pull page, in order; where the next shift starts (first, after the server's, after this device's own newer close);
  an open the server reads, refused on a register the device does not hold and when one is open; the cash of two sales
  and three movements added up, a pay out too large refused, the close's expected cash, difference and dropped carts,
  no sale after the close; held carts up to the limit, the swap, a sale that clears the screen's cart.
- **`push.spec.ts`:** one test walks a shift through five pushes: the open alone, then the sales and the movement
  together, then the close, then the next open; a refused sale keeps the close back; a customer's command and a 20a
  sale go as before.
- **`pos.spec.ts`:** the fixture moved, and the sale says `shiftId: null`.

### `apps/app/src/lib/pos.ts`: the cart's type, the held cart, new keys

```diff
@@ -1,7 +1,6 @@
 import {
   compareMoney,
   compareQuantity,
-  type DiscountType,
   isMoneyAmount,
   isQuantity,
   type PosLineAmounts,
@@ -21,59 +20,18 @@ import {
   type SyncStock,
   toBaseQuantity,
 } from '@omnivo/contracts';
+import type { HeldCart, PosCart as Cart, PosCartLine as CartLine } from '@omnivo/sync';
 
 // Step 20a: the POS screen's cart, worked out without React, so the rules are tested on their own
 // (pos.spec.ts). The screen keeps one Cart in state and changes it only through these functions.
 
-// One line of the cart. Everything the receipt and the sale need is copied in when the line is
-// added (the product may change in the copy while the cart is open; the line keeps what the
-// cashier saw).
-export interface CartLine {
-  // For React and for picking a line; never sent
-  key: string;
-  productId: string;
-  variantId: string;
-  // The base unit, the product's sales unit or the pack a barcode named, and its size in the base
-  // unit ("1", "10"): stock is counted in base units
-  unitId: string;
-  factor: string;
-  name: string;
-  sku: string;
-  unitCode: string;
-  // The unit's decimals (0 for pcs, 3 for kg): quantities show with them
-  decimals: number;
-  // 'none' | 'batch' | 'serial' (a string in the contract, so a newer server's mode does not break)
-  tracking: string;
-  // A service has no stock: no check, no batch
-  goods: boolean;
-  // As the cashier types them: they may be half typed ("1.") until the sale is paid
-  quantity: string;
-  // '' while there is no price (a product without one); the cashier types it
-  unitPrice: string;
-  // The price the line started with (posOverridesOf); null = there was none
-  startingPrice: string | null;
-  discountType: DiscountType;
-  discount: string;
-  taxRateId: string;
-  // The rate in percent ("15.00"), kept with the line: the receipt is printed with it
-  rate: string;
-  batchId: string | null;
-  serialNumbers: string[];
-}
-
-export interface CartCustomer {
-  id: string;
-  name: string;
-  priceListId: string | null;
-}
-
-export interface Cart {
-  // null = walk-in
-  customer: CartCustomer | null;
-  lines: CartLine[];
-  billDiscountType: DiscountType;
-  billDiscount: string;
-}
+// Step 20b: the cart's shape moved to @omnivo/sync (carts.ts), because the device stores it now (a
+// held bill, the cart on the screen). The names stay the ones the screen uses.
+export type {
+  PosCart as Cart,
+  PosCartCustomer as CartCustomer,
+  PosCartLine as CartLine,
+} from '@omnivo/sync';
 
 export const EMPTY_CART: Cart = {
   customer: null,
@@ -82,6 +40,13 @@ export const EMPTY_CART: Cart = {
   billDiscount: '',
 };
 
+// Step 20b: the cart as the device keeps it, held or on the screen (@omnivo/sync carts.ts), with
+// what the held list shows of it. Here, not in pos-held.tsx: the screen saves its cart on every
+// change, and must not load the held bills' chunk for that.
+export function heldCartOf(cart: Cart, total: string, name: string | null): HeldCart {
+  return { name, heldAt: new Date().toISOString(), items: cart.lines.length, total, cart };
+}
+
 let lineKeys = 0;
 
 // A counter, not crypto.randomUUID(): a key only has to be unique on this screen
@@ -90,6 +55,13 @@ export function newLineKey(): string {
   return `line-${String(lineKeys)}`;
 }
 
+// Step 20b: a cart that comes back from the device (a held bill, the screen's cart after a reload)
+// has keys from an earlier page load's counter, which starts again at 1: new keys, so a line added
+// now never shares one with it
+export function rekeyed(cart: Cart): Cart {
+  return { ...cart, lines: cart.lines.map((line) => ({ ...line, key: newLineKey() })) };
+}
+
 // "Polo shirt — M, Navy blue", like the sales documents' line (description null)
 export function itemName(product: Pick<Product, 'name'>, variant: ProductVariant): string {
   return variant.optionValues.length === 0
@@ -280,6 +252,8 @@ export function quickCash(total: string): string[] {
 export function saleValues(input: {
   cart: Cart;
   registerId: string;
+  // Step 20b: the open shift the sale is made in
+  shiftId: string;
   date: string;
   soldAt: string;
   pricesIncludeVat: boolean;
@@ -288,6 +262,7 @@ export function saleValues(input: {
   const { cart } = input;
   return {
     registerId: input.registerId,
+    shiftId: input.shiftId,
     date: input.date,
     soldAt: input.soldAt,
     customerId: cart.customer?.id ?? null,
```

```diff
@@ -25,6 +25,7 @@ const PHONE = '01928c4e-8888-7000-8000-000000000002';
 const BAG = '01928c4e-0000-7000-8000-000000000001';
 const VAT_15 = '01928c4e-7777-7000-8000-000000000002';
 const REGISTER = '01928c4e-5555-7000-8000-000000000001';
+const SHIFT = '01928c4e-5555-7000-8000-000000000002';
 const WAREHOUSE = '01928c4e-7777-7000-8000-000000000001';
 
 function line(fields: Partial<CartLine> = {}): CartLine {
@@ -192,13 +193,14 @@ describe('the payment', () => {
     const values = saleValues({
       cart: { ...cartOf(line({ quantity: '2' })), billDiscount: '' },
       registerId: REGISTER,
+      shiftId: SHIFT,
       date: '2026-10-27',
       soldAt: '2026-10-27T10:15:00.000Z',
       pricesIncludeVat: true,
       payments: [{ key: 'a', method: 'cash', amount: '1000', reference: '' }],
     });
     const parsed = posSaleInputSchema.parse({ ...values, sequence: 1 });
-    expect(parsed).toMatchObject({ customerId: null, billDiscount: '0' });
+    expect(parsed).toMatchObject({ customerId: null, billDiscount: '0', shiftId: SHIFT });
     expect(parsed.payments[0]?.reference).toBeNull();
   });
 });
```

- **`export type { PosCart as Cart, … }`:** the screen keeps its names, so no other file changes for decision 74.
- **`heldCartOf()` lives here,** not in `pos-held.tsx`: the screen saves its cart on every change, and must not load the
  held bills' chunk for that.
- **`rekeyed()`:** a line's key comes from a counter that starts again at 1 on every page load. A cart that comes back
  from the device has keys of an earlier load, and a line added now could get the same key: React would mix up the two
  rows, and a quantity typed in one would land in the other.
- **`saleValues()` takes the shift:** the schema's `shiftId` is required on the screen's sales (only an old outbox row
  has `null`).

### `apps/app/src/lib/pos-shift.ts` (new): the count, without React

```ts
import {
  type CashCountFormValues,
  type CashDenomination,
  type CashNotes,
  cashNotesTotal,
  compareMoney,
  MAX_NOTES,
  multiplyMoney,
} from '@omnivo/contracts';

// Step 20b: the count of the drawer and the shift's result, worked out without React, so the
// rules are tested on their own (pos-shift.spec.ts). The screens are pos-shift.tsx.

// By notes (how many of each) or as one total (decision 8)
export type CountMode = 'notes' | 'total';

// The note boxes as typed: '' = none of that note
export type NoteBoxes = Record<CashDenomination, string>;

export const EMPTY_NOTES: NoteBoxes = {
  '1000': '',
  '500': '',
  '200': '',
  '100': '',
  '50': '',
  '20': '',
  '10': '',
  '5': '',
  '2': '',
  '1': '',
};

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

// What a note box keeps of what was typed: ASCII digits only, as the PIN box does (a Bangla
// keyboard types Bangla ones), and no more than MAX_NOTES has digits. A count of notes is a whole
// number: a dot or a minus is dropped as it is typed.
export function noteDigits(raw: string): string {
  return raw
    .replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
    .replace(/[^0-9]/g, '')
    .slice(0, String(MAX_NOTES).length);
}

// The boxes as numbers; '' is 0. A box over MAX_NOTES (99999 is the longest a box takes, so
// never) is left as it is for the schema to refuse.
export function notesOf(boxes: NoteBoxes): CashNotes {
  const count = (denomination: CashDenomination) => Number(boxes[denomination] || '0');
  return {
    '1000': count('1000'),
    '500': count('500'),
    '200': count('200'),
    '100': count('100'),
    '50': count('50'),
    '20': count('20'),
    '10': count('10'),
    '5': count('5'),
    '2': count('2'),
    '1': count('1'),
  };
}

// A count's total with 2 decimals, as cashCountSchema reads it. The notes are whole taka, so their
// total (4 decimals, cashNotesTotal) is "5000.0000": its whole part and ".00".
function notesTotal(notes: CashNotes): string {
  const [whole = '0'] = cashNotesTotal(notes).split('.');
  return `${whole}.00`;
}

// The count as cashCountSchema reads it: the notes and their total, or a total alone. The total of
// the notes is worked out here, so it always matches them (pos_count_total_mismatch is for a
// device that sends something else).
export function countValues(mode: CountMode, boxes: NoteBoxes, total: string): CashCountFormValues {
  if (mode === 'total') return { notes: null, total };
  const notes = notesOf(boxes);
  return { notes, total: notesTotal(notes) };
}

// For the "= ৳4,000" next to each box and the notes' total under them. Money stays a decimal
// string (CLAUDE.md), even for whole notes.
export function noteAmount(denomination: CashDenomination, box: string): string {
  return multiplyMoney(box || '0', denomination);
}

export function boxesTotal(boxes: NoteBoxes): string {
  return notesTotal(notesOf(boxes));
}

// The way a count reads in the result: even, over (more cash than expected) or short
export type DifferenceKind = 'even' | 'over' | 'short';

export function differenceKind(difference: string): DifferenceKind {
  const sign = compareMoney(difference, '0');
  return sign === 0 ? 'even' : sign > 0 ? 'over' : 'short';
}

// Decision 6: a shift still open on a later day (yesterday's, left open) is closed before the next
// sale. ISO dates compare as text.
export function leftOpen(openingDate: string, today: string): boolean {
  return openingDate < today;
}
```

```ts
import { cashCountSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  boxesTotal,
  countValues,
  differenceKind,
  EMPTY_NOTES,
  leftOpen,
  noteAmount,
  noteDigits,
} from './pos-shift';

describe('the count', () => {
  it('keeps whole ASCII digits in a note box, from a Bangla keyboard too', () => {
    expect(noteDigits('১২')).toBe('12');
    expect(noteDigits('4.5')).toBe('45');
    expect(noteDigits('-3')).toBe('3');
    expect(noteDigits('1234567')).toBe('12345');
  });

  it('sends the notes with their own total, which the schema accepts', () => {
    const boxes = { ...EMPTY_NOTES, '1000': '4', '500': '2', '10': '' };
    const values = countValues('notes', boxes, '999');
    expect(values.total).toBe('5000.00');
    expect(values.notes?.['1000']).toBe(4);
    expect(values.notes?.['10']).toBe(0);
    expect(cashCountSchema.safeParse(values).success).toBe(true);
    expect(boxesTotal(boxes)).toBe('5000.00');
    expect(noteAmount('500', '2')).toBe('1000.0000');
  });

  it('sends a total alone as it is typed; an empty one is refused', () => {
    expect(countValues('total', { ...EMPTY_NOTES, '1000': '4' }, '7640.50')).toEqual({
      notes: null,
      total: '7640.50',
    });
    const empty = cashCountSchema.safeParse(countValues('total', EMPTY_NOTES, ''));
    expect(empty.error?.issues[0]?.message).toBe('pos_count_required');
    // An empty drawer is a count
    expect(cashCountSchema.safeParse(countValues('notes', EMPTY_NOTES, '')).success).toBe(true);
  });
});

describe('the result', () => {
  it('reads a difference as even, over or short', () => {
    expect(differenceKind('0.0000')).toBe('even');
    expect(differenceKind('120.0000')).toBe('over');
    expect(differenceKind('-50.0000')).toBe('short');
  });

  it('finds a shift left open since an earlier day', () => {
    expect(leftOpen('2026-10-28', '2026-10-29')).toBe(true);
    expect(leftOpen('2026-10-29', '2026-10-29')).toBe(false);
  });
});
```

- **`noteDigits()` keeps whole ASCII digits:** a note count is never "4.5", and a Bangla keyboard types Bangla digits,
  which become ASCII ones (the PIN box's rule). At most 5 digits: `MAX_NOTES` is 99,999.
- **`countValues()` works out the notes' total itself:** the schema refuses a total that is not the notes'
  (`pos_count_total_mismatch`), so the device always sends the two together. The total has 2 decimals, the schema's
  format; whole notes make `5000.00`.
- **`noteAmount()` with `multiplyMoney()`:** even for whole notes, money stays a decimal string (CLAUDE.md).
- **`leftOpen()` compares ISO dates as text:** `2026-10-28` < `2026-10-29`, with no time zone to get wrong. The page
  passes the workspace's today (`todayIn()`), the same day every command carries.

### The session: the lock's minutes and the open shift

```diff
@@ -83,14 +83,27 @@ export function clearSignOutPending(): void {
 // the password (session.ts). A sign-out keeps it: another tab that sees it go would open its copy.
 export const LOCKED_KEY = 'omnivo.locked';
 
-export function markLocked(): void {
+// Step 20b: the POS's idle lock is the same lock, and keeps its minutes, so the lock screen says
+// why it locked (pin.lock.idleDescription), after a reload too. '1' = Lock now.
+export function markLocked(idleMinutes?: number): void {
   try {
-    storage()?.setItem(LOCKED_KEY, '1');
+    storage()?.setItem(LOCKED_KEY, idleMinutes === undefined ? '1' : `idle:${String(idleMinutes)}`);
   } catch {
     // The storage refused: the lock still holds in this page, but not after a reload
   }
 }
 
+// The minutes of an idle lock; null = not locked, or locked with Lock now
+export function lockedIdleMinutes(): number | null {
+  try {
+    const saved = storage()?.getItem(LOCKED_KEY);
+    const minutes = saved?.startsWith('idle:') ? Number(saved.slice('idle:'.length)) : NaN;
+    return Number.isInteger(minutes) && minutes > 0 ? minutes : null;
+  } catch {
+    return null;
+  }
+}
+
 export function clearLocked(): void {
   try {
     storage()?.removeItem(LOCKED_KEY);
```

```diff
@@ -59,6 +59,8 @@ export type DeviceState =
       reason: LockReason;
       status: KeyStatus;
       waiting: number;
+      // Step 20b: the number of the shift open on this device (decision 6); null = none
+      openShift: string | null;
       unlock: (pin: string) => Promise<UnlockAnswer>;
       forgetPin: () => Promise<void>;
     }
@@ -93,6 +95,8 @@ interface LocalDataState {
   // Closing the dialog. After set-up, any way of closing it is "Not now", like the branch dialog.
   closePin: () => void;
   lockNow: () => void;
+  // Step 20b (decision 7): the POS's idle lock, Lock now with the minutes it waited
+  lockIdle: (minutes: number) => void;
 }
 
 const noSession = () => Promise.reject(new Error('No device session'));
@@ -109,6 +113,7 @@ export const localDataStore = createStore<LocalDataState>()(() => ({
   savePin: noSession,
   closePin: () => undefined,
   lockNow: () => undefined,
+  lockIdle: () => undefined,
 }));
 
 export function useThisDeviceId(): string | null {
@@ -132,6 +137,10 @@ export function lockNow(): void {
   localDataStore.getState().lockNow();
 }
 
+export function lockIdle(minutes: number): void {
+  localDataStore.getState().lockIdle(minutes);
+}
+
 export function useDeviceState(): DeviceState {
   return useStore(localDataStore, (state) => state.device);
 }
```

```diff
@@ -27,11 +27,12 @@ import {
   renewServerKey,
   saveDevice,
   setPin,
+  shiftState,
   SyncDatabase,
   SyncEngine,
   syncedAtOf,
   type Unlock,
-  waitingSales,
+  waitingAtCounter,
   watch,
 } from '@omnivo/sync';
 import { toast } from '@omnivo/ui';
@@ -153,6 +154,9 @@ export function startLocalData(input: { tenantId: string; userId: string }): ()
     lockNow: () => {
       lockNow(session);
     },
+    lockIdle: (minutes) => {
+      lockNow(session, minutes);
+    },
   });
   void setUp(session);
   return () => {
@@ -177,6 +181,7 @@ export function stopLocalData(): void {
     savePin: ended,
     closePin: () => undefined,
     lockNow: () => undefined,
+    lockIdle: () => undefined,
   });
   syncSummaryStore.setState(NO_SUMMARY);
 }
@@ -457,10 +462,12 @@ async function showLock(
   serverKey: Uint8Array<ArrayBuffer> | null,
 ): Promise<void> {
   const { db } = opening;
-  const [status, waiting, legacy] = await Promise.all([
+  const [status, waiting, legacy, shift] = await Promise.all([
     keyStatus(db),
     db.outbox.count(),
     db.legacyOutbox.count(),
+    // Step 20b: from the row's clear fields, so the lock screen's Sign out can say it first
+    shiftState(db),
   ]);
   if (closed(opening)) return;
   set({
@@ -469,6 +476,7 @@ async function showLock(
       reason,
       status,
       waiting: waiting + legacy,
+      openShift: shift?.status === 'open' ? shift.number : null,
       unlock: (pin) => unlock(session, opening, reason, serverKey, pin),
       // Decision 35: the PIN goes (a PIN nobody remembers only helps someone guessing it). The
       // lock screen then ends the sign-in: session.ts imports this module (logout), so this one
@@ -591,6 +599,14 @@ async function start(
     engine.subscribe(() => {
       syncSummaryStore.setState({ syncing: engine.getStatus().syncing });
     }),
+    // Step 20b (decision 6): the open shift, for the sign-out (sync-summary.ts)
+    watch(
+      () => shiftState(db),
+      (shift) => {
+        syncSummaryStore.setState({ openShift: shift?.status === 'open' ? shift.number : null });
+      },
+      () => undefined,
+    ),
     // Step 18c: the time of the last sync, for the limits (sync-summary.ts: useSyncAge)
     watch(
       () => readPullState(db),
@@ -670,10 +686,11 @@ function reopen(session: Session): void {
 
 // Step 19b (decision 4): "Lock now". The flag first, so a reload from here on shows the lock screen
 // too, and the other tabs lock (followLock). Closing the copy drops its key and its in-memory
-// tables; it then opens again only as far as the lock screen.
-function lockNow(session: Session): void {
+// tables; it then opens again only as far as the lock screen. Step 20b: the POS's idle lock is
+// this too, with its minutes in the flag.
+function lockNow(session: Session, idleMinutes?: number): void {
   session.locked = true;
-  markLocked();
+  markLocked(idleMinutes);
   reopen(session);
 }
 
@@ -736,7 +753,9 @@ async function revoke(session: Session): Promise<void> {
 
 // Step 20a (decision 14): signing out lets go of the register this device holds, so the next
 // cashier's device can take it. Only with no sale of it waiting in the outbox: the server must
-// receive every number before another device goes on from its last one. logout() calls this
+// receive every number before another device goes on from its last one. Step 20b: nor a shift's
+// command, nor an open shift (the server refuses that, pos_shift_still_open; the sign-out asks
+// to close it first anyway, decision 6). logout() calls this
 // before the server's session ends (the release needs it). No copy open (locked, not set up), no
 // connection, or a refusal: the register stays with this device, and the sign-out goes on. The
 // next sign-in on this browser is the same device and takes it back; a lost PC is revoked, which
@@ -746,7 +765,8 @@ export async function releaseRegister(): Promise<void> {
   const { device } = localDataStore.getState();
   if (!session || device.kind !== 'ready') return;
   const claim = await readClaim(device.copy);
-  if (!claim || (await waitingSales(device.copy)) > 0) return;
+  if (!claim || (await waitingAtCounter(device.copy)) > 0) return;
+  if ((await shiftState(device.copy.db))?.status === 'open') return;
   await call(routes.pos.releaseRegister, {
     params: { id: claim.registerId },
     body: { deviceId: session.identity.id },
```

```diff
@@ -16,9 +16,18 @@ export interface SyncSummary {
   // Step 18c: when the last pull ended, on this device's clock (syncedAtOf in @omnivo/sync). null =
   // no pull has ended, or no copy is open.
   syncedAt: number | null;
+  // Step 20b (decision 6): the number of the POS shift open on this device (POS1-S0042), for the
+  // sign-out, which asks to close it first. null = none.
+  openShift: string | null;
 }
 
-export const NO_SUMMARY: SyncSummary = { syncing: false, waiting: 0, failed: 0, syncedAt: null };
+export const NO_SUMMARY: SyncSummary = {
+  syncing: false,
+  waiting: 0,
+  failed: 0,
+  syncedAt: null,
+  openShift: null,
+};
 
 export const syncSummaryStore = createStore<SyncSummary>()(() => NO_SUMMARY);
 
```

- **`markLocked(idleMinutes)` writes `idle:5`:** one flag for both locks (decision 80), so a reload, the other tabs and
  the password's sign-in treat the idle lock exactly like Lock now. `lockedIdleMinutes()` reads it back for the lock
  screen; anything else in the flag is a plain lock.
- **`lockIdle()` beside `lockNow()`, not a parameter of it:** the account menu passes `lockNow` straight to a menu
  item's `onSelect`, which calls it with an event. A parameter would take the event for minutes.
- **The open shift in the summary and in the `locked` state:** a live read of `shiftState()` while the copy is open, and
  one read in `showLock()` while it is not (the summary is empty then: the copy's watches stop with it).
- **`releaseRegister()` stays quiet while a shift is open:** the server would refuse (`pos_shift_still_open`), and the
  sign-out asks first anyway (decision 81).

### `apps/app/src/components/pos-shift.tsx` (new): open, pay in and out, close, result

```tsx
import { CheckmarkCircle02Icon, Coins01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CASH_DENOMINATIONS,
  cashCountSchema,
  cashDifferenceOf,
  contractErrorMap,
  isMoneyAmount,
  isZeroMoney,
  posCashMovementInputSchema,
  type PosCashDirection,
  type SyncPosCashReason,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  closeShift,
  type DeviceShift,
  type LocalCopy,
  moveCash,
  openShift,
  type ShiftCloseResult,
  type ShiftStart,
} from '@omnivo/sync';
import {
  Button,
  Card,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  Input,
  KpiStrip,
  MoneyInput,
  SegmentedControl,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useId, useState } from 'react';

import { requestSync } from '../lib/local-data';
import {
  boxesTotal,
  type CountMode,
  countValues,
  differenceKind,
  EMPTY_NOTES,
  type NoteBoxes,
  noteAmount,
  noteDigits,
} from '../lib/pos-shift';
import { DocumentNotice } from './document-notice';
import { counterMoney, differenceWords } from './pos-shift-parts';

// Step 20b: the shift's screens on /pos, a chunk of their own (loaded the first time one shows,
// offline too: the service worker keeps it). The open card takes the selling screen's place until a
// shift is open; pay in, pay out and the close are dialogs over it; the result follows the close.

type Format = ReturnType<typeof useLocale>['format'];

// The first error the schema found, as a code (the Field and FormAlert say it in words)
function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? 'unknown_error';
}

// ---------------------------------------------------------------------------------------------
// The count (decision 8): by notes, or as one total. The same boxes at the open and at the close.

function useCashCount() {
  const [mode, setMode] = useState<CountMode>('notes');
  const [boxes, setBoxes] = useState<NoteBoxes>(EMPTY_NOTES);
  const [total, setTotal] = useState('');
  return {
    mode,
    setMode,
    boxes,
    setBox: (denomination: keyof NoteBoxes, value: string) => {
      setBoxes((current) => ({ ...current, [denomination]: noteDigits(value) }));
    },
    total,
    setTotal,
    values: () => countValues(mode, boxes, total),
  };
}

type CashCountState = ReturnType<typeof useCashCount>;

function CashCount({ count, error }: { count: CashCountState; error: string | undefined }) {
  const { t, format } = useLocale();
  const id = useId();
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        {/* Seen, not read: the control's own legend names it for a screen reader */}
        <span aria-hidden="true" className="text-label font-medium">
          {t('pos.shift.countBy')}
        </span>
        <SegmentedControl
          label={t('pos.shift.countBy')}
          value={count.mode}
          options={(['notes', 'total'] as const).map((mode) => ({
            value: mode,
            label: t(`pos.shift.countModes.${mode}`),
          }))}
          onChange={count.setMode}
        />
      </div>
      {count.mode === 'notes' ? (
        <fieldset className="grid gap-3">
          <legend className="mb-2 text-label font-medium">{t('pos.shift.notesLegend')}</legend>
          {/* Two columns from a tablet's width: ten boxes fit without a scroll */}
          <div className="grid gap-x-5 gap-y-2.5 sm:grid-cols-2">
            {CASH_DENOMINATIONS.map((denomination) => {
              const note = format.money(denomination);
              const box = count.boxes[denomination];
              return (
                <label
                  key={denomination}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)_6rem] items-center gap-3"
                >
                  <span className="text-body-sm font-medium tabular-nums">{note}</span>
                  <Input
                    aria-label={t('pos.shift.noteCount', { note })}
                    inputMode="numeric"
                    autoComplete="off"
                    align="end"
                    placeholder="0"
                    value={box}
                    onChange={(event) => {
                      count.setBox(denomination, event.target.value);
                    }}
                  />
                  <span className="text-right text-label text-ink-3 tabular-nums">
                    {box === ''
                      ? ''
                      : t('pos.shift.noteAmount', {
                          amount: format.money(noteAmount(denomination, box)),
                        })}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="flex items-baseline justify-between rounded-control bg-subtle px-4 py-3">
            <span className="text-body-sm text-ink-2">{t('pos.shift.countTotal')}</span>
            <span className="text-h3 font-semibold tabular-nums">
              {format.money(boxesTotal(count.boxes))}
            </span>
          </p>
          {error && <FormAlert message={error} />}
        </fieldset>
      ) : (
        <Field id={`${id}-total`} label={t('pos.shift.countTotal')} error={error}>
          <MoneyInput
            id={`${id}-total`}
            autoFocus
            value={count.total}
            onChange={count.setTotal}
            invalid={error !== undefined}
          />
        </Field>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Opening

// The card in the selling screen's place (decision 1). The count is blind like the close's
// (decision 65): what the last shift left shows only in the toast after the open.
export function OpenShiftCard({
  copy,
  register,
  start,
  reasons,
  today,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  start: ShiftStart;
  // The "in" reasons, for a first shift's float
  reasons: readonly SyncPosCashReason[];
  today: string;
}) {
  const { t, format } = useLocale();
  const count = useCashCount();
  const [floatReasonId, setFloatReasonId] = useState('');
  const [errors, setErrors] = useState<{ count?: string; floatReasonId?: string; form?: string }>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const inReasons = reasons.filter((reason) => reason.direction === 'in');

  const submit = async () => {
    if (saving) return;
    const parsed = cashCountSchema.safeParse(count.values(), { error: contractErrorMap });
    if (!parsed.success) {
      setErrors({ count: firstIssue(parsed.error) });
      return;
    }
    const opening = parsed.data;
    // Decision 12: a first shift's float comes in from somewhere. The server never refuses it
    // (decision 25), so the device asks; an empty drawer needs no reason.
    if (start.first && !isZeroMoney(opening.total) && floatReasonId === '') {
      setErrors({ floatReasonId: 'pos_float_reason_required' });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const result = await openShift(copy, {
        register,
        input: {
          date: today,
          openedAt: new Date().toISOString(),
          opening,
          floatReasonId: floatReasonId === '' ? null : floatReasonId,
        },
        savedAt: new Date().toISOString(),
      });
      if (result.kind === 'not-held') {
        setErrors({ form: 'pos_register_not_held' });
        return;
      }
      // open-already: another tab opened one, and this screen shows it at once (a live read). If
      // it does not, the open shift is another register's (a bug): it is closed first.
      if (result.kind === 'open-already') {
        setErrors({ form: 'pos_shift_still_open' });
        return;
      }
      requestSync();
      toast(openedText(t, format, result.shift, result.start));
    } catch {
      setErrors({ form: t('sync.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mx-auto w-full max-w-[560px] p-[22px] sm:p-8">
      <form
        className="grid gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-1.5">
          <h1 className="text-h2 font-semibold tracking-[-0.02em] text-balance">
            {t('pos.shift.openTitle')}
          </h1>
          <p className="text-body-sm text-ink-2">{t('pos.shift.openDescription')}</p>
        </div>
        {errors.form && <FormAlert message={errors.form} />}
        <CashCount count={count} error={errors.count} />
        {start.first && (
          <div className="grid gap-4">
            <DocumentNotice tone="neutral">
              {t('pos.shift.firstShift', { code: register.code })}
            </DocumentNotice>
            {inReasons.length === 0 ? (
              <p className="text-label text-ink-3">{t('pos.shift.noInReasons')}</p>
            ) : (
              <SelectField
                label={t('pos.shift.floatReason')}
                options={[
                  { value: '', label: t('pos.shift.floatReasonPlaceholder') },
                  ...inReasons.map((reason) => ({ value: reason.id, label: reason.name })),
                ]}
                value={floatReasonId}
                onChange={(event) => {
                  setFloatReasonId(event.target.value);
                }}
                error={errors.floatReasonId}
              />
            )}
          </div>
        )}
        <Button type="submit" disabled={saving} className="w-full">
          {t('pos.shift.open')}
        </Button>
      </form>
    </Card>
  );
}

// The toast after the open: the shift's number, or what the last shift left and the difference.
// The device's own view (decision 63: the server compares with what it has, and books that).
function openedText(
  t: ReturnType<typeof useLocale>['t'],
  format: Format,
  shift: DeviceShift,
  start: ShiftStart,
): string {
  if (start.cashLeft === null) return t('pos.shift.opened', { number: shift.number });
  const difference = cashDifferenceOf(shift.opening.total, start.cashLeft);
  return differenceKind(difference) === 'even'
    ? t('pos.shift.openedEven', { amount: counterMoney(format, start.cashLeft) })
    : t('pos.shift.openedDifference', {
        expected: counterMoney(format, start.cashLeft),
        difference: differenceWords(t, format, difference),
      });
}

// ---------------------------------------------------------------------------------------------
// Pay in and pay out (decision 4)

export function CashMoveDialog({
  copy,
  shift,
  direction,
  reasons,
  today,
  onClose,
}: {
  copy: LocalCopy;
  shift: Pick<DeviceShift, 'id'>;
  direction: PosCashDirection;
  reasons: readonly SyncPosCashReason[];
  today: string;
  onClose: () => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const choices = reasons.filter((reason) => reason.direction === direction);
  const [reasonId, setReasonId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ reasonId?: string; amount?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    const movedAt = new Date().toISOString();
    const parsed = posCashMovementInputSchema.safeParse(
      { shiftId: shift.id, reasonId, amount, note, date: today, movedAt },
      { error: contractErrorMap },
    );
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const [field] = issue.path;
        if (field === 'reasonId' || field === 'amount') next[field] ??= issue.message;
        else next.form ??= issue.message;
      }
      setErrors(next);
      return;
    }
    const reason = choices.find((one) => one.id === parsed.data.reasonId);
    if (!reason) {
      setErrors({ reasonId: 'pos_reason_required' });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const done = t(`pos.cash.done.${direction}`, {
        amount: counterMoney(format, parsed.data.amount),
        reason: reason.name,
      });
      const result = await moveCash(copy, {
        input: parsed.data,
        direction,
        name: done,
        savedAt: movedAt,
      });
      switch (result.kind) {
        case 'too-large':
          setErrors({ amount: 'pos_pay_out_too_large' });
          return;
        case 'no-shift':
          setErrors({ form: 'pos_shift_closed' });
          return;
        case 'saved':
          requestSync();
          toast(done);
          onClose();
      }
    } catch {
      setErrors({ form: t('sync.saveFailed') });
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
        title={t(`pos.cash.titles.${direction}`)}
        description={t(`pos.cash.descriptions.${direction}`)}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form={`${id}-form`} disabled={saving || choices.length === 0}>
              {isMoneyAmount(amount) && !isZeroMoney(amount)
                ? t(`pos.cash.save.${direction}`, { amount: counterMoney(format, amount) })
                : t(`pos.cash.titles.${direction}`)}
            </Button>
          </>
        }
      >
        <form
          id={`${id}-form`}
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {errors.form && <FormAlert message={errors.form} />}
          {choices.length === 0 ? (
            <p className="text-body-sm text-ink-2">{t(`pos.cash.noReasons.${direction}`)}</p>
          ) : (
            <>
              <SelectField
                label={t('pos.cash.reason')}
                autoFocus
                options={[
                  { value: '', label: t('pos.cash.reasonPlaceholder') },
                  ...choices.map((reason) => ({ value: reason.id, label: reason.name })),
                ]}
                value={reasonId}
                onChange={(event) => {
                  setReasonId(event.target.value);
                }}
                error={errors.reasonId}
              />
              <Field id={`${id}-amount`} label={t('pos.cash.amount')} error={errors.amount}>
                <MoneyInput
                  id={`${id}-amount`}
                  value={amount}
                  onChange={setAmount}
                  invalid={errors.amount !== undefined}
                />
              </Field>
              <TextField
                label={t('pos.cash.note')}
                optional
                maxLength={200}
                placeholder={t('pos.cash.notePlaceholder')}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Closing (decisions 3 and 9): the count, then the result

export function CloseShiftDialog({
  copy,
  shift,
  held,
  today,
  onClose,
  onClosed,
}: {
  copy: LocalCopy;
  shift: Pick<DeviceShift, 'id' | 'number'>;
  // The held bills the close drops (the cart on the screen was held first, pos-screen.tsx)
  held: number;
  today: string;
  onClose: () => void;
  onClosed: (result: Extract<ShiftCloseResult, { kind: 'closed' }>) => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const count = useCashCount();
  const [errors, setErrors] = useState<{ count?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    const parsed = cashCountSchema.safeParse(count.values(), { error: contractErrorMap });
    if (!parsed.success) {
      setErrors({ count: firstIssue(parsed.error) });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const closedAt = new Date().toISOString();
      const result = await closeShift(copy, {
        shiftId: shift.id,
        input: { date: today, closedAt, counted: parsed.data },
        savedAt: closedAt,
      });
      if (result.kind === 'no-shift') {
        setErrors({ form: 'pos_shift_closed' });
        return;
      }
      requestSync();
      onClosed(result);
    } catch {
      setErrors({ form: t('sync.saveFailed') });
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
        title={t('pos.close.title', { number: shift.number })}
        description={t('pos.close.description')}
        footer={
          <>
            {/* The close is final: said where the button is, not only in a dialog nobody reads */}
            <p className="mr-auto self-center text-label text-ink-3">{t('pos.close.final')}</p>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form={`${id}-form`} disabled={saving}>
              {t('pos.close.confirm')}
            </Button>
          </>
        }
      >
        <form
          id={`${id}-form`}
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {errors.form && <FormAlert message={errors.form} />}
          <CashCount count={count} error={errors.count} />
          {held > 0 && (
            <DocumentNotice tone="neutral">
              {t('pos.close.heldDropped', { count: held, formatted: format.number(held) })}
            </DocumentNotice>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

// After the close: the count, what was expected and the difference, now that the count is in. The
// books get the difference when the close syncs (decision 5); a big one rings the managers' bell.
export function ShiftClosedDialog({
  result,
  onSignOut,
  onNext,
}: {
  result: Extract<ShiftCloseResult, { kind: 'closed' }>;
  onSignOut: () => void;
  onNext: () => void;
}) {
  const { t, format } = useLocale();
  const { shift, difference } = result;
  const kind = differenceKind(difference);
  const amount = counterMoney(format, difference.replace(/^-/, ''));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onNext();
      }}
    >
      <DialogContent
        title={t('pos.close.doneTitle', { number: shift.number })}
        footer={
          <>
            <Button variant="secondary" className="mr-auto" onClick={onSignOut}>
              {t('common.signOut')}
            </Button>
            <Button autoFocus onClick={onNext}>
              {t('pos.close.next')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <span className="grid size-10 place-items-center rounded-lg bg-good-bg text-good">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={20} strokeWidth={1.5} />
          </span>
          <KpiStrip
            cells={[
              { label: t('pos.close.counted'), value: counterMoney(format, shift.counted ?? '0') },
              {
                label: t('pos.close.expected'),
                value: counterMoney(format, shift.expected ?? '0'),
              },
              { label: t('pos.close.difference'), value: differenceWords(t, format, difference) },
            ]}
          />
          {kind !== 'even' && (
            <DocumentNotice tone="warn" icon={Coins01Icon}>
              {t(`pos.close.${kind}`, { amount })}
            </DocumentNotice>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- **One `useCashCount()` for the open and the close:** the same boxes, the same mode, the same values, so the two counts
  can never differ in how they are typed. The state stays in the dialog: it is thrown away when the dialog closes, and
  the next count starts empty (a count is never prefilled: decision 3).
- **No react-hook-form here:** the count is ten boxes or one, read by `cashCountSchema.safeParse()` with
  `contractErrorMap`, the same codes the server's schema gives. Each error is a code, and `Field` and `FormAlert` say it
  in the person's language.
- **The note boxes are `Input`s, not `MoneyInput`s:** a count is a whole number of notes, not money. Their label for a
  screen reader is "How many ৳500"; the "= ৳1,000" beside them is for the eyes.
- **The open's float reason is checked here** (`pos_float_reason_required`): the server never refuses an open (decision
  25), so the device asks. An empty drawer on a first shift needs no reason.
- **The toast's text is worked out from the save's answer** (decision 85), not from what the card showed: the save may
  have started from a newer last shift than the card did.
- **`CashMoveDialog`'s button says the amount** ("Pay out ৳10,000") once the box holds one: the cashier reads it before
  the money leaves the drawer.
- **The close's footer says the count is final** next to the button (decision 9), not only in the description.
- **`ShiftClosedDialog` uses `KpiStrip`:** Counted, Expected and the difference in words ("৳50 short", decision 66),
  with a `warn` notice when it is not even. Closing it any way is "Open the next shift": the open card is already
  behind it.
- **`counterMoney()` and `differenceWords()` come from `pos-shift-parts.tsx`,** a small file that 20b.6b adds for the
  managers' pages and the bell (decision 97). Until you write 20b.6b, keep them in this file.

### `apps/app/src/components/pos-held.tsx` (new): held bills

```tsx
import { Cancel01Icon, Note01Icon } from '@hugeicons/core-free-icons';
import { MAX_HELD_CARTS } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  dropCart,
  type HeldCartItem,
  heldCarts,
  holdCart,
  type LocalCopy,
  resumeCart,
} from '@omnivo/sync';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  IconButton,
  TextField,
  toast,
} from '@omnivo/ui';
import { useCallback, useId, useState } from 'react';

import { useLocalQuery } from '../lib/local-data';
import { type Cart, heldCartOf } from '../lib/pos';
import { hasPaisa } from './pos-parts';

// Step 20b (decision 10): held bills. The cashier holds a cart while the next customer pays, and
// resumes it later. On this device only, under the shift: the close drops them. A chunk of its own,
// like the shift's dialogs.

// What the screen hands over to hold: the cart and its total now (the list's row says it)
export interface ScreenCart {
  cart: Cart;
  total: string;
}

// F8: an optional name ("Customer in the blue shirt"), then the cart leaves the screen
export function HoldDialog({
  copy,
  shiftId,
  screen,
  onClose,
  onHeld,
}: {
  copy: LocalCopy;
  shiftId: string;
  screen: ScreenCart;
  onClose: () => void;
  onHeld: () => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const typed = name.trim();
      const answer = await holdCart(
        copy,
        shiftId,
        heldCartOf(screen.cart, screen.total, typed === '' ? null : typed),
      );
      if (answer === 'full') {
        setError(t('pos.hold.full', { max: format.number(MAX_HELD_CARTS) }));
        return;
      }
      toast(t('pos.hold.held'));
      onHeld();
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
        title={t('pos.hold.title')}
        description={t('pos.hold.description')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form={`${id}-form`} disabled={saving}>
              {t('pos.hold.save')}
            </Button>
          </>
        }
      >
        <form
          id={`${id}-form`}
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && <FormAlert message={error} />}
          {/* Enter holds at once: the cashier often types no name */}
          <TextField
            label={t('pos.hold.name')}
            optional
            autoFocus
            maxLength={60}
            placeholder={t('pos.hold.namePlaceholder')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The held bills of the shift, the oldest first. Resume puts one on the screen (the screen's own
// cart, if it has lines, is held in its place: nothing is lost); Drop throws one away.
export function HeldDialog({
  copy,
  shiftId,
  screen,
  timeZone,
  onClose,
  onResume,
}: {
  copy: LocalCopy;
  shiftId: string;
  screen: ScreenCart;
  // The workspace's, like every time on the counter (the receipt's)
  timeZone: string;
  onClose: () => void;
  onResume: (cart: Cart) => void;
}) {
  const { t, format } = useLocale();
  const readHeld = useCallback((open: LocalCopy) => heldCarts(open, shiftId), [shiftId]);
  const held = useLocalQuery(readHeld);
  const [busy, setBusy] = useState(false);
  const swaps = screen.cart.lines.length > 0;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch {
      toast(t('sync.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const resume = (item: HeldCartItem) =>
    run(async () => {
      const cart = await resumeCart(
        copy,
        shiftId,
        item.id,
        swaps ? heldCartOf(screen.cart, screen.total, null) : null,
      );
      // null: another tab took it meanwhile; the list's live read drops the row
      if (cart) onResume(cart.cart);
    });

  const drop = (item: HeldCartItem) =>
    run(async () => {
      await dropCart(copy, item.id);
      toast(t('pos.hold.dropped'));
    });

  const nameOf = (item: HeldCartItem) =>
    item.name ?? t('pos.hold.unnamed', { time: format.dateTime(new Date(item.heldAt), timeZone) });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title={t('pos.hold.listTitle')} description={t('pos.hold.listDescription')}>
        {held?.length === 0 ? (
          <EmptyState
            icon={Note01Icon}
            title={t('pos.hold.emptyTitle')}
            description={t('pos.hold.emptyBody')}
          />
        ) : (
          <div className="grid gap-3">
            <ul className="divide-y divide-line rounded-control border border-line">
              {(held ?? []).map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-body-sm font-medium">{nameOf(item)}</span>
                    <span className="text-caption text-ink-3 tabular-nums">
                      {t('pos.hold.row', {
                        items: t('pos.itemCount', {
                          count: item.items,
                          formatted: format.number(item.items),
                        }),
                        total: format.money(item.total, { decimals: hasPaisa(item.total) ? 2 : 0 }),
                      })}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void resume(item)}
                  >
                    {t('pos.hold.resume')}
                  </Button>
                  <IconButton
                    icon={Cancel01Icon}
                    label={t('pos.hold.drop', { name: nameOf(item) })}
                    disabled={busy}
                    onClick={() => void drop(item)}
                  />
                </li>
              ))}
            </ul>
            {swaps && <p className="text-label text-ink-3">{t('pos.hold.resumeHolds')}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- **The name is optional and Enter holds:** a cashier with a queue rarely types one. A bill without a name shows as
  "Held at 29 Oct 2026, 13:10", in the workspace's time zone, like the receipt.
- **Resume gives the list's cart to the screen; the screen re-keys it** (`rekeyed()`).
- **The list is a live read:** a bill held, resumed or dropped in another tab shows here at once.

### `apps/app/src/components/pos-shift-menu.tsx` (new) and `pos-parts.tsx`: the shift menu

```tsx
import {
  LockIcon,
  MoneyAdd01Icon,
  MoneyRemove01Icon,
  Note01Icon,
} from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import type { DeviceShift } from '@omnivo/sync';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@omnivo/ui';
import { ShiftButton } from './pos-parts';
import type { ShiftRequest } from './pos-screen';

// Step 20b: "Shift POS1-S0042 ▾": who opened it and when, pay in, pay out, the held bills and the
// close. The screen opens the dialogs (they need its cart). A chunk of its own (routes/pos.tsx).
export function ShiftMenu({
  shift,
  held,
  cashier,
  timeZone,
  onRequest,
}: {
  shift: DeviceShift;
  held: number;
  cashier: string;
  timeZone: string;
  onRequest: (request: ShiftRequest) => void;
}) {
  const { t, format } = useLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ShiftButton number={shift.number} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>
          {t('pos.shift.openedBy', {
            time: format.dateTime(new Date(shift.openedAt), timeZone),
            name: cashier,
          })}
        </DropdownMenuLabel>
        <DropdownMenuItem
          icon={MoneyAdd01Icon}
          onSelect={() => {
            onRequest('pay-in');
          }}
        >
          {t('pos.shift.payIn')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={MoneyRemove01Icon}
          onSelect={() => {
            onRequest('pay-out');
          }}
        >
          {t('pos.shift.payOut')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={Note01Icon}
          onSelect={() => {
            onRequest('held');
          }}
        >
          <span className="flex-1">{t('pos.hold.listTitle')}</span>
          <span className="text-caption text-ink-3 tabular-nums">{format.number(held)}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={LockIcon}
          onSelect={() => {
            onRequest('close');
          }}
        >
          {t('pos.shift.close')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

```diff
@@ -1,5 +1,8 @@
+import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
+import { HugeiconsIcon } from '@hugeicons/react';
 import type { SyncSettings } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
+import type { ComponentProps } from 'react';
 
 import type { ReceiptCompany } from '../lib/pos';
 
@@ -23,6 +26,26 @@ export function Kbd({ children }: { children: string }) {
   );
 }
 
+// Step 20b: "Shift POS1-S0042 ▾", the shift menu's button (pos-shift-menu.tsx). Here too: the top
+// bar draws it while the menu's chunk loads, so the bar does not jump. The menu passes its props
+// (and its ref: a prop in React 19) through. On a phone only the number: the bar has no room for
+// the word (its label still says it).
+export function ShiftButton({ number, ...button }: ComponentProps<'button'> & { number: string }) {
+  const { t } = useLocale();
+  return (
+    <button
+      type="button"
+      aria-label={t('pos.shift.menu', { number })}
+      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-body-sm font-medium shadow-sm transition-colors duration-150 hover:bg-subtle"
+      {...button}
+    >
+      <span className="tabular-nums max-sm:hidden">{t('pos.shift.number', { number })}</span>
+      <span className="tabular-nums sm:hidden">{number}</span>
+      <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} className="text-ink-3" />
+    </button>
+  );
+}
+
 type CompanySettings = Pick<
   SyncSettings,
   'companyName' | 'legalName' | 'address' | 'bin' | 'phone' | 'timezone'
```

- **Its own chunk** (decision 82), and its button in `pos-parts.tsx`: the bar draws the button at once, and the menu's
  chunk wraps the same button as the dropdown's trigger. React 19 passes a ref as a prop, so `ShiftButton` needs no
  `forwardRef` for Radix's `asChild`.
- **The first line, `pos.shift.openedBy`:** the one word added to 20b.5's `en.ts` and `bn.ts` (the diffs of 20b.5 show
  it).
- **On a phone the button shows the number alone** (decision 99, found by 20b.7's phone tests): two spans, one for each
  screen size, so the word order of the whole sentence stays the translation's. The `aria-label` names the menu either
  way.

### `apps/app/src/components/pos-screen.tsx`, `pos-cart.tsx`, `pos-pay.tsx`: selling inside the shift

```diff
@@ -1,9 +1,11 @@
 import { Search01Icon } from '@hugeicons/core-free-icons';
 import {
   compareQuantity,
+  MAX_HELD_CARTS,
   type Product,
   type ProductVariant,
   SYNC_BLOCK_AFTER_DAYS,
+  type SyncPosCashReason,
   type SyncPosRegister,
   type SyncSettings,
   type TaxRate,
@@ -13,13 +15,19 @@ import {
 import { useLocale } from '@omnivo/i18n';
 import {
   allRows,
+  type DeviceShift,
+  heldCount,
+  holdCart,
   type LocalCopy,
   lookUpPrices,
   productByBarcode,
   productPage,
+  saveScreenCart,
+  screenCart,
+  type ShiftCloseResult,
   stockOf,
 } from '@omnivo/sync';
-import { cn, Input } from '@omnivo/ui';
+import { cn, Input, toast } from '@omnivo/ui';
 import {
   lazy,
   Suspense,
@@ -41,14 +49,17 @@ import {
   changeLine,
   EMPTY_CART,
   fefoBatch,
+  heldCartOf,
   itemName,
   lineReady,
   newLineKey,
   onHandOf,
   overridesOf,
+  rekeyed,
   removeLine,
   shortLines,
 } from '../lib/pos';
+import { leftOpen } from '../lib/pos-shift';
 import { useSession } from '../lib/session-store';
 import { useSyncAge } from '../lib/sync-summary';
 import { useOnline } from '../lib/use-online';
@@ -66,6 +77,19 @@ const ShortcutsDialog = lazy(async () => ({
   default: (await import('./pos-pay')).ShortcutsDialog,
 }));
 const PosReceipt = lazy(async () => ({ default: (await import('./pos-receipt')).PosReceipt }));
+// Step 20b: the shift's dialogs and the held bills, each its own chunk too
+const CashMoveDialog = lazy(async () => ({
+  default: (await import('./pos-shift')).CashMoveDialog,
+}));
+const CloseShiftDialog = lazy(async () => ({
+  default: (await import('./pos-shift')).CloseShiftDialog,
+}));
+const HoldDialog = lazy(async () => ({ default: (await import('./pos-held')).HoldDialog }));
+const HeldDialog = lazy(async () => ({ default: (await import('./pos-held')).HeldDialog }));
+
+// Step 20b: what the top bar's shift menu asks the screen for. The screen opens the dialogs, because
+// they need its cart: Hold takes it, Resume replaces it, Close holds it first.
+export type ShiftRequest = 'pay-in' | 'pay-out' | 'held' | 'close';
 
 // Step 20a (decision 12): the products on the left, the cart on the right; on a phone the products
 // alone, with the cart as a bar at the bottom that opens over them. A whole sale works from the
@@ -112,12 +136,23 @@ export function PosScreen({
   copy,
   register,
   settings,
+  shift,
+  reasons,
+  request,
+  onRequest,
+  onClosed,
   shortcuts,
   onShortcuts,
 }: {
   copy: LocalCopy;
   register: SyncPosRegister;
   settings: SyncSettings;
+  // Step 20b: the open shift the screen sells on, and the reasons for pay in and pay out
+  shift: DeviceShift;
+  reasons: readonly SyncPosCashReason[];
+  request: ShiftRequest | null;
+  onRequest: (request: ShiftRequest | null) => void;
+  onClosed: (result: Extract<ShiftCloseResult, { kind: 'closed' }>) => void;
   shortcuts: boolean;
   onShortcuts: (open: boolean) => void;
 }) {
@@ -136,6 +171,10 @@ export function PosScreen({
   const [done, setDone] = useState<DoneSale | null>(null);
   // A phone: the cart over the products
   const [cartOpen, setCartOpen] = useState(false);
+  // Step 20b: F8's dialog. The cart on the screen comes back from the device once (restored):
+  // until then nothing is saved over it.
+  const [holding, setHolding] = useState(false);
+  const [restored, setRestored] = useState(false);
   const searchRef = useRef<HTMLInputElement>(null);
   const customerRef = useRef<HTMLButtonElement>(null);
   const billDiscountRef = useRef<HTMLInputElement>(null);
@@ -148,6 +187,8 @@ export function PosScreen({
   const canOverride = can('pos.price.override');
   // Step 18c's limit: offline more than 7 days after the last sync, no new work on this device
   const blocked = !online && age?.age === 'blocked';
+  // Decision 6: a shift left open on an earlier day sells nothing more; the menu's Close is the way
+  const stale = leftOpen(shift.openingDate, today);
 
   const findTiles = useCallback(
     async (open: LocalCopy) =>
@@ -203,7 +244,70 @@ export function PosScreen({
     cart.lines.every(lineReady) &&
     short.size === 0 &&
     overrides.length === 0 &&
-    !blocked;
+    !blocked &&
+    !stale;
+
+  // Step 20b: the cart a reload or the idle lock left, once per shift. The idle lock unmounts this
+  // screen (the AppFrame draws the lock screen in its place), so the cart lives on the device.
+  useEffect(() => {
+    let stopped = false;
+    void screenCart(copy, shift.id)
+      .then((saved) => {
+        if (!stopped && saved) setCart(rekeyed(saved));
+      })
+      .catch(() => undefined)
+      .finally(() => {
+        if (!stopped) setRestored(true);
+      });
+    return () => {
+      stopped = true;
+    };
+  }, [copy, shift.id]);
+
+  // Every change is saved, one write after the other, so the last one wins. A save that fails
+  // (the copy closed for a lock) changes nothing: the next change saves again.
+  const writes = useRef(Promise.resolve());
+  const total = amounts.totals.total;
+  useEffect(() => {
+    if (!restored) return;
+    const saved = cart.lines.length === 0 ? null : heldCartOf(cart, total, null);
+    writes.current = writes.current
+      .then(() => saveScreenCart(copy, shift.id, saved))
+      .catch(() => undefined);
+  }, [copy, shift.id, cart, total, restored]);
+
+  const readHeld = useCallback((open: LocalCopy) => heldCount(open, shift.id), [shift.id]);
+  const held = useLocalQuery(readHeld) ?? 0;
+
+  // The shift menu's Close: the cart on the screen is held first, so the close's notice counts it
+  // with the other held bills and nothing is dropped without being said. Once per request: the
+  // cart is read from a ref, so a change to it does not hold it again. The close dialog shows once
+  // the cart is empty (below).
+  const latest = useRef({ cart, total });
+  useEffect(() => {
+    latest.current = { cart, total };
+  });
+  useEffect(() => {
+    if (request !== 'close') return;
+    const now = latest.current;
+    if (now.cart.lines.length === 0) return;
+    void holdCart(copy, shift.id, heldCartOf(now.cart, now.total, null)).then(
+      (answer) => {
+        if (answer === 'held') {
+          setCart(EMPTY_CART);
+          setSelected(null);
+          setCartOpen(false);
+          return;
+        }
+        toast(t('pos.hold.full', { max: format.number(MAX_HELD_CARTS) }));
+        onRequest(null);
+      },
+      () => {
+        toast(t('sync.saveFailed'));
+        onRequest(null);
+      },
+    );
+  }, [request, copy, shift.id, t, format, onRequest]);
 
   // A tile's click, a scan or Enter: the line with its price, VAT rate and batch, from the copy.
   // The price as the customer's price list has it now (lookUpPrices, step 18b).
@@ -298,9 +402,11 @@ export function PosScreen({
 
   // The shortcuts (decision 12). Not while a dialog is open: it has its own keys (Enter completes
   // the sale, or starts the next one). F12 opens the browser's tools in some browsers; the page
-  // asks first, and Chrome lets it.
+  // asks first, and Chrome lets it. Step 20b: F8 holds the cart, F9 lists the held bills
+  // (decision 68).
+  const dialogOpen = paying || done !== null || shortcuts || holding || request !== null;
   useEffect(() => {
-    if (paying || done || shortcuts) return;
+    if (dialogOpen) return;
     const onKey = (event: KeyboardEvent) => {
       switch (event.key) {
         case 'F2':
@@ -319,6 +425,14 @@ export function PosScreen({
           event.preventDefault();
           if (payable) setPaying(true);
           break;
+        case 'F8':
+          event.preventDefault();
+          if (cart.lines.length > 0) setHolding(true);
+          break;
+        case 'F9':
+          event.preventDefault();
+          onRequest('held');
+          break;
         case '?':
           if (isTyping(event.target)) return;
           event.preventDefault();
@@ -330,7 +444,7 @@ export function PosScreen({
     return () => {
       window.removeEventListener('keydown', onKey);
     };
-  }, [paying, done, shortcuts, payable, onShortcuts]);
+  }, [dialogOpen, payable, onShortcuts, cart.lines.length, onRequest]);
 
   const newSale = () => {
     setDone(null);
@@ -346,6 +460,14 @@ export function PosScreen({
             {t('sync.blockedFormNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })}
           </DocumentNotice>
         )}
+        {stale && (
+          <DocumentNotice tone="warn">
+            {t('pos.shift.leftOpen', {
+              number: shift.number,
+              time: format.dateTime(new Date(shift.openedAt), settings.timezone),
+            })}
+          </DocumentNotice>
+        )}
         <label className="grid gap-1.5">
           <span className="text-label font-medium">{t('pos.search')}</span>
           <Input
@@ -447,12 +569,20 @@ export function PosScreen({
         onOpen={setCartOpen}
         customerRef={customerRef}
         billDiscountRef={billDiscountRef}
+        onHold={() => {
+          setHolding(true);
+        }}
+        held={held}
+        onHeld={() => {
+          onRequest('held');
+        }}
       />
       <Suspense fallback={null}>
         {paying && (
           <PayDialog
             copy={copy}
             register={register}
+            shiftId={shift.id}
             cart={cart}
             total={amounts.totals.total}
             date={today}
@@ -489,6 +619,66 @@ export function PosScreen({
             }}
           />
         )}
+        {holding && (
+          <HoldDialog
+            copy={copy}
+            shiftId={shift.id}
+            screen={{ cart, total }}
+            onClose={() => {
+              setHolding(false);
+            }}
+            onHeld={() => {
+              setHolding(false);
+              setCart(EMPTY_CART);
+              setSelected(null);
+              setCartOpen(false);
+              searchRef.current?.focus();
+            }}
+          />
+        )}
+        {request === 'held' && (
+          <HeldDialog
+            copy={copy}
+            shiftId={shift.id}
+            screen={{ cart, total }}
+            timeZone={settings.timezone}
+            onClose={() => {
+              onRequest(null);
+            }}
+            onResume={(resumed) => {
+              onRequest(null);
+              setCart(rekeyed(resumed));
+              setSelected(null);
+            }}
+          />
+        )}
+        {(request === 'pay-in' || request === 'pay-out') && (
+          <CashMoveDialog
+            copy={copy}
+            shift={shift}
+            direction={request === 'pay-in' ? 'in' : 'out'}
+            reasons={reasons}
+            today={today}
+            onClose={() => {
+              onRequest(null);
+            }}
+          />
+        )}
+        {request === 'close' && cart.lines.length === 0 && (
+          <CloseShiftDialog
+            copy={copy}
+            shift={shift}
+            held={held}
+            today={today}
+            onClose={() => {
+              onRequest(null);
+            }}
+            onClosed={(result) => {
+              onRequest(null);
+              onClosed(result);
+            }}
+          />
+        )}
       </Suspense>
     </div>
   );
```

```diff
@@ -3,6 +3,8 @@ import {
   ArrowLeft01Icon,
   Delete02Icon,
   MinusSignIcon,
+  Note01Icon,
+  PauseIcon,
   PlusSignIcon,
   UserIcon,
 } from '@hugeicons/core-free-icons';
@@ -67,6 +69,10 @@ interface PosCartProps {
   onOpen: (open: boolean) => void;
   customerRef: Ref<HTMLButtonElement>;
   billDiscountRef: Ref<HTMLInputElement>;
+  // Step 20b: hold this cart (F8) and the held bills of the shift (F9)
+  onHold: () => void;
+  held: number;
+  onHeld: () => void;
 }
 
 // Money on the screen: whole taka unless it has paisa (hasPaisa)
@@ -97,6 +103,9 @@ export function PosCart({
   onOpen,
   customerRef,
   billDiscountRef,
+  onHold,
+  held,
+  onHeld,
 }: PosCartProps) {
   const { t, format } = useLocale();
   const money = useScreenMoney();
@@ -131,6 +140,21 @@ export function PosCart({
           <h2 className="text-h3 font-semibold">{t('pos.cart')}</h2>
           <span className="text-caption text-ink-3 tabular-nums">{count}</span>
           <span className="flex-1" />
+          <Button
+            variant="secondary"
+            size="sm"
+            className="gap-1.5"
+            disabled={cart.lines.length === 0}
+            onClick={onHold}
+          >
+            <HugeiconsIcon icon={PauseIcon} size={16} strokeWidth={1.5} />
+            {t('pos.hold.hold')}
+            <Kbd>F8</Kbd>
+          </Button>
+          <Button variant="secondary" size="sm" className="gap-1.5" onClick={onHeld}>
+            <HugeiconsIcon icon={Note01Icon} size={16} strokeWidth={1.5} />
+            {t('pos.hold.list', { formatted: format.number(held) })}
+          </Button>
           <IconButton
             icon={Delete02Icon}
             label={t('pos.clear')}
```

```diff
@@ -66,6 +66,7 @@ function firstRow(): PaymentRow {
 export function PayDialog({
   copy,
   register,
+  shiftId,
   cart,
   total,
   date,
@@ -76,6 +77,8 @@ export function PayDialog({
 }: {
   copy: LocalCopy;
   register: SyncPosRegister;
+  // Step 20b: the open shift the sale is made in
+  shiftId: string;
   cart: Cart;
   total: string;
   date: string;
@@ -121,6 +124,7 @@ export function PayDialog({
       ...saleValues({
         cart,
         registerId: register.id,
+        shiftId,
         date,
         soldAt,
         pricesIncludeVat,
@@ -144,6 +148,11 @@ export function PayDialog({
         setError('pos_register_not_held');
         return;
       }
+      // Step 20b: the shift was closed in another tab meanwhile; this screen shows the open card
+      if (result.kind === 'no-shift') {
+        setError('pos_shift_closed');
+        return;
+      }
       // Online it goes at once; offline it waits in the outbox (the done dialog says so)
       requestSync();
       const change = posChangeOf(parsed.data.payments, total);
@@ -408,6 +417,8 @@ export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
     ['F2', t('pos.keys.search')],
     ['F4', t('pos.keys.customer')],
     ['F7', t('pos.keys.billDiscount')],
+    ['F8', t('pos.keys.hold')],
+    ['F9', t('pos.keys.held')],
     ['F12', t('pos.keys.pay')],
     ['Enter', t('pos.keys.complete')],
     ['Enter', t('pos.keys.newSale')],
```

- **`ShiftRequest` comes from the page and the screen opens the dialog:** the menu is in the page's bar, but Hold takes
  the cart, Resume replaces it and the close holds it first, and the cart lives in the screen.
- **`restored` before the first save:** the screen starts with an empty cart and reads the saved one; saving before that
  read would write the empty cart over it.
- **One write after the other (`writes`):** each change waits for the last write, so the device's row is always the
  latest cart, never an older one that finished late. A write that fails (the copy closed for a lock) is dropped: the
  next change writes again.
- **The close's hold runs once per request:** the cart is read from a ref (`latest`), so the effect runs when the
  request changes, not on every key press. The close dialog shows only once the cart is empty, which is how the screen
  knows the hold is done.
- **F8 and F9 stop while any dialog is open** (`dialogOpen`), like the other keys.
- **`stale` turns Pay off** (decision 83) and the notice says since when, in the workspace's time zone.
- **`PayDialog` passes the shift and handles `no-shift`:** the shift was closed in another tab; the error says so, and
  the page shows the open card as soon as the live read sees the close.
- **The cart's header gets Hold (F8) and Held (n),** as in the mockup; Hold is off with an empty cart.

### `apps/app/src/routes/pos.tsx`: the page

```diff
@@ -3,35 +3,53 @@ import {
   ArrowLeftRightIcon,
   CashierIcon,
   KeyboardIcon,
+  LockKeyIcon,
   Wifi01Icon,
   WifiDisconnected02Icon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   formatPosNumber,
+  lockAfterMs,
   routes,
   type SyncPosRegister,
   type SyncSettings,
+  todayIn,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
   allRows,
+  type DeviceShift,
   dropClaim,
+  heldCount,
   type LocalCopy,
+  localCashReasons,
   localRegisters,
   readClaim,
+  readShift,
   type RegisterClaim,
-  waitingSales,
+  type ShiftCloseResult,
+  shiftStart,
+  waitingAtCounter,
 } from '@omnivo/sync';
-import { cn, EmptyState, IconButton, Logo, Pill, toast } from '@omnivo/ui';
-import { Link } from '@tanstack/react-router';
-import { lazy, Suspense, useState } from 'react';
+import { Button, cn, EmptyState, IconButton, Logo, Pill, toast } from '@omnivo/ui';
+import { Link, useNavigate, useSearch } from '@tanstack/react-router';
+import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
 
 import { LocalState, SyncNotice } from '../components/local-state';
-import { PosScreen } from '../components/pos-screen';
+import { ShiftButton } from '../components/pos-parts';
+import { PosScreen, type ShiftRequest } from '../components/pos-screen';
 import { ApiRequestError, call } from '../lib/api';
-import { useLocalData, useLocalQuery, useThisDeviceId } from '../lib/local-data';
+import {
+  askForPin,
+  lockIdle,
+  useKeyStatus,
+  useLocalData,
+  useLocalQuery,
+  useThisDeviceId,
+} from '../lib/local-data';
 import { useCan } from '../lib/permissions';
+import { logout } from '../lib/session';
 import { useSession } from '../lib/session-store';
 import { useSyncSummary } from '../lib/sync-summary';
 import { useOnline } from '../lib/use-online';
@@ -40,12 +58,31 @@ import { useOnline } from '../lib/use-online';
 // top, then the register this device sells on, then the products and the cart (pos-screen.tsx).
 // Everything it sells from is the device's copy, so it works the same with or without a
 // connection; only taking or changing a register needs one.
+// Step 20b: and between the register and the selling screen, the shift (decision 1): the open
+// card until one is open, the shift menu in the bar while it is, the result after its close.
 
 // "Which counter is this?": once per device, online, so in a chunk of its own (with the server
 // query it needs), and the selling screen's chunk stays in its budget
 const RegisterChooser = lazy(async () => ({
   default: (await import('../components/pos-register')).RegisterChooser,
 }));
+// Step 20b: the open card and the close's result, in the shift's chunk (pos-shift.tsx)
+const OpenShiftCard = lazy(async () => ({
+  default: (await import('../components/pos-shift')).OpenShiftCard,
+}));
+const ShiftClosedDialog = lazy(async () => ({
+  default: (await import('../components/pos-shift')).ShiftClosedDialog,
+}));
+// Step 20b: the shift menu brings the dropdown's code, which no other part of /pos has (the
+// shell's menus are not drawn here): its own chunk, with a look-alike button for the moment it loads
+const ShiftMenu = lazy(async () => ({
+  default: (await import('../components/pos-shift-menu')).ShiftMenu,
+}));
+const SignOutDialog = lazy(async () => ({
+  default: (await import('../components/sign-out-dialog')).SignOutDialog,
+}));
+
+type ClosedShift = Extract<ShiftCloseResult, { kind: 'closed' }>;
 
 // Module level, so they are stable for useLocalQuery (a new function is a new read)
 async function readSettings(copy: LocalCopy): Promise<SyncSettings | null> {
@@ -69,19 +106,95 @@ function heldRegister(
     : null;
 }
 
+// Step 20b (decision 7): the register's idle lock. No key, click, touch or scroll in this tab for
+// the register's minutes, and the device locks, the way Lock now does (the other tabs too). The
+// lock screen takes the AppFrame's place, so this screen goes; its cart is on the device
+// (pos-screen.tsx). A dialog open (the payment) does not stop it: a counter left alone locks.
+// null = off, or nothing to lock with (no PIN, no open shift).
+function useIdleLock(lockAfter: SyncPosRegister['lockAfter'] | null) {
+  useEffect(() => {
+    if (lockAfter === null) return;
+    const ms = lockAfterMs(lockAfter);
+    if (ms === null) return;
+    let last = Date.now();
+    const seen = () => {
+      last = Date.now();
+    };
+    const events = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'] as const;
+    for (const name of events) window.addEventListener(name, seen, { passive: true });
+    // A check every few seconds, not a timer reset on every move of the mouse
+    const timer = setInterval(() => {
+      if (Date.now() - last >= ms) lockIdle(Number(lockAfter));
+    }, 5_000);
+    return () => {
+      for (const name of events) window.removeEventListener(name, seen);
+      clearInterval(timer);
+    };
+  }, [lockAfter]);
+}
+
 export function PosPage() {
   const { t } = useLocale();
   const can = useCan();
   const deviceId = useThisDeviceId();
+  const navigate = useNavigate();
+  const search = useSearch({ strict: false });
   const { view, notice } = useLocalData();
   const ready = view.kind === 'ready';
   const registers = useLocalQuery(ready ? localRegisters : null);
   const claim = useLocalQuery(ready ? readClaim : null);
   const settings = useLocalQuery(ready ? readSettings : null);
+  const shift = useLocalQuery(ready ? readShift : null);
+  const reasons = useLocalQuery(ready ? localCashReasons : null);
+  const keys = useKeyStatus();
   const [shortcuts, setShortcuts] = useState(false);
+  const [request, setRequest] = useState<ShiftRequest | null>(null);
+  const [closed, setClosed] = useState<ClosedShift | null>(null);
+  const [asking, setAsking] = useState(false);
+  const { waiting: unsynced } = useSyncSummary();
 
   const register =
     registers && claim !== undefined ? heldRegister(registers, claim, deviceId) : undefined;
+  // The shift this screen sells on: open, and of the register the device holds
+  const openShift = shift?.status === 'open' && shift.registerId === register?.id ? shift : null;
+
+  // By the id: the shift's row is a new object after every write (each sale), the same read
+  const openShiftId = openShift?.id ?? null;
+  const readHeld = useCallback(
+    (copy: LocalCopy) => (openShiftId ? heldCount(copy, openShiftId) : Promise.resolve(0)),
+    [openShiftId],
+  );
+  const held = useLocalQuery(ready ? readHeld : null) ?? 0;
+
+  // The sign-out's "Close shift" (decision 6) comes here with ?close=true: the close opens once,
+  // and the address loses the flag, so a reload does not open it again
+  const wantsClose = search.close === true;
+  const closeHere = openShift !== null;
+  useEffect(() => {
+    if (!wantsClose || shift === undefined) return;
+    void navigate({ to: '/pos', search: {}, replace: true }).then(() => {
+      if (closeHere) setRequest('close');
+    });
+  }, [wantsClose, shift, closeHere, navigate]);
+
+  useIdleLock(
+    openShift && register && keys?.hasPin && register.lockAfter !== 'off'
+      ? register.lockAfter
+      : null,
+  );
+
+  const signOut = () => {
+    setClosed(null);
+    if (unsynced > 0) setAsking(true);
+    else void logout();
+  };
+
+  // "Sign out" sits right after the close, whose command may still wait a moment when it is
+  // pressed. Once nothing waits, there is nothing to lose: the question goes (it is drawn only
+  // while something waits) and the sign-out goes on by itself, instead of asking about "0 changes".
+  useEffect(() => {
+    if (asking && unsynced === 0) void logout();
+  }, [asking, unsynced]);
 
   const content = () => {
     if (view.kind !== 'ready') return <LocalState view={view} />;
@@ -108,14 +221,64 @@ export function PosPage() {
         </Suspense>
       );
     }
+    if (shift === undefined || reasons === undefined) return null;
+    if (openShift) {
+      return (
+        <PosScreen
+          copy={view.copy}
+          register={register}
+          settings={settings}
+          shift={openShift}
+          reasons={reasons}
+          request={request}
+          onRequest={setRequest}
+          onClosed={setClosed}
+          shortcuts={shortcuts}
+          onShortcuts={setShortcuts}
+        />
+      );
+    }
+    // Decision 13: no account for a difference, no shift (a register made before 20b)
+    if (register.overShortAccountId === null) {
+      return (
+        <EmptyState
+          icon={CashierIcon}
+          title={t('pos.shift.openTitle')}
+          description={t('pos.shift.needsOverShort', { code: register.code })}
+        />
+      );
+    }
+    // Decision 7: a register that locks itself needs the device's PIN to lock with
+    if (register.lockAfter !== 'off' && !keys?.hasPin) {
+      return (
+        <EmptyState
+          icon={LockKeyIcon}
+          title={t('pos.shift.openTitle')}
+          description={t('pos.shift.needsPin', { code: register.code })}
+          action={
+            keys && (
+              <Button
+                onClick={() => {
+                  askForPin(keys.pinBlocked ? 'new' : 'set-up');
+                }}
+              >
+                {t('pin.card.set')}
+              </Button>
+            )
+          }
+        />
+      );
+    }
     return (
-      <PosScreen
-        copy={view.copy}
-        register={register}
-        settings={settings}
-        shortcuts={shortcuts}
-        onShortcuts={setShortcuts}
-      />
+      <Suspense fallback={null}>
+        <OpenShiftCard
+          copy={view.copy}
+          register={register}
+          start={shiftStart(register, shift)}
+          reasons={reasons}
+          today={todayIn(settings.timezone)}
+        />
+      </Suspense>
     );
   };
 
@@ -127,8 +290,12 @@ export function PosPage() {
         copy={view.kind === 'ready' ? view.copy : null}
         register={register ?? null}
         claim={claim ?? null}
+        shift={openShift}
+        held={held}
+        timeZone={settings?.timezone ?? 'Asia/Dhaka'}
+        onRequest={setRequest}
         onShortcuts={
-          register
+          openShift
             ? () => {
                 setShortcuts(true);
               }
@@ -141,27 +308,57 @@ export function PosPage() {
         </div>
       )}
       <main className="flex min-h-0 flex-1 flex-col">
-        {view.kind === 'ready' && register && claim && settings ? (
+        {view.kind === 'ready' && openShift ? (
           content()
         ) : (
           <div className="grid flex-1 place-items-center overflow-y-auto p-4">{content()}</div>
         )}
       </main>
+      {closed && (
+        <Suspense fallback={null}>
+          <ShiftClosedDialog
+            result={closed}
+            onSignOut={signOut}
+            onNext={() => {
+              setClosed(null);
+            }}
+          />
+        </Suspense>
+      )}
+      {asking && unsynced > 0 && (
+        <Suspense fallback={null}>
+          <SignOutDialog
+            count={unsynced}
+            onClose={() => {
+              setAsking(false);
+            }}
+          />
+        </Suspense>
+      )}
     </div>
   );
 }
 
-// The bar: the logo, the register and who sells, the next number, the sync line and the way out.
-// On a phone only what fits: the register's code, the sync icon and the exit icon.
+// The bar: the logo, the register and who sells, the shift, the next number, the sync line and
+// the way out. On a phone only what fits: the register's code, the shift, the sync icon and the
+// exit icon.
 function PosTopBar({
   copy,
   register,
   claim,
+  shift,
+  held,
+  timeZone,
+  onRequest,
   onShortcuts,
 }: {
   copy: LocalCopy | null;
   register: SyncPosRegister | null;
   claim: RegisterClaim | null;
+  shift: DeviceShift | null;
+  held: number;
+  timeZone: string;
+  onRequest: (request: ShiftRequest) => void;
   onShortcuts: (() => void) | undefined;
 }) {
   const { t } = useLocale();
@@ -169,13 +366,27 @@ function PosTopBar({
   return (
     <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 print:hidden">
       <Logo />
-      <Pill tone="brand" icon={CashierIcon}>
-        {t('pos.title')}
-      </Pill>
+      {/* Step 20b: not on a phone, where the shift's button (POS1-S0042) says it is the POS */}
+      <span className={cn('inline-flex', shift && 'max-sm:hidden')}>
+        <Pill tone="brand" icon={CashierIcon}>
+          {t('pos.title')}
+        </Pill>
+      </span>
       {register && claim && copy && (
         <>
           <span aria-hidden="true" className="h-6 w-px bg-line max-sm:hidden" />
-          <ChangeRegister copy={copy} register={register} />
+          <ChangeRegister copy={copy} register={register} shift={shift} />
+          {shift && (
+            <Suspense fallback={<ShiftButton number={shift.number} />}>
+              <ShiftMenu
+                shift={shift}
+                held={held}
+                cashier={cashier}
+                timeZone={timeZone}
+                onRequest={onRequest}
+              />
+            </Suspense>
+          )}
           <span className="text-body-sm text-ink-2 max-lg:hidden">
             {t('pos.cashier', { name: cashier })}
           </span>
@@ -209,14 +420,28 @@ function PosTopBar({
 // The register's name, and the way to let it go (decision 14). Only online, and only with no sale
 // of it waiting on the device: the server must have every number before another device goes on
 // from its last one. The claim goes after the server let go, so the chooser comes back.
-function ChangeRegister({ copy, register }: { copy: LocalCopy; register: SyncPosRegister }) {
+// Step 20b: and only with no shift open (decision 32): the server refuses it, so the screen says
+// what to do first.
+function ChangeRegister({
+  copy,
+  register,
+  shift,
+}: {
+  copy: LocalCopy;
+  register: SyncPosRegister;
+  shift: DeviceShift | null;
+}) {
   const { t, errorText } = useLocale();
   const online = useOnline();
   const deviceId = useThisDeviceId();
   const [busy, setBusy] = useState(false);
   const change = async () => {
     if (!deviceId) return;
-    if ((await waitingSales(copy)) > 0) {
+    if (shift) {
+      toast(t('pos.shift.changeRegisterOpen', { number: shift.number }));
+      return;
+    }
+    if ((await waitingAtCounter(copy)) > 0) {
       toast(t('pos.changeRegisterWaiting', { code: register.code }));
       return;
     }
```

- **The order on the page:** the register, then the shift. With an open shift of the held register, the selling screen;
  without one, the reason no shift can open (decision 84) or the open card.
- **`openShift` is only the held register's:** a shift open for another register cannot be sold on here (the open
  card's save then says `pos_shift_still_open`, a bug path: the server keeps a register with an open shift).
- **`?close=true`** (decision 81): the address loses the flag first, and the close opens in the navigation's callback.
  Setting the state straight in the effect would draw the page twice (React's lint refuses it), and a reload with the
  flag still there would open the close again.
- **`useIdleLock()`** (decision 80): one `setInterval` and a timestamp, not a timer started again on every mouse move.
  `lockIdle()` closes the copy; the AppFrame then draws the lock screen in the page's place, so the effect's cleanup
  stops the timer.
- **The result dialog and the sign-out are the page's:** after the close, the selling screen is gone (no open shift),
  so the dialog that follows it cannot live in it.
- **Change register** says why it cannot while a shift is open (decision 86).
- **The "POS" pill hides on a phone while a shift is open** (decision 99): the shift's button names the register, and
  the bar must fit 390px. `Pill` takes no `className`, so a span around it does the hiding.
- **The sign-out goes on by itself once nothing waits** (decision 98, found by 20b.7's tests). The dialog is drawn only
  while something waits, and the effect calls `logout()` when the count is 0. It sets no state in the effect (React's
  lint refuses that): `asking` stays true until the page goes.

### The sign-out: "Close the shift first"

```diff
@@ -42,3 +42,50 @@ export function SignOutDialog({ count, onClose }: { count: number; onClose: () =
     </Dialog>
   );
 }
+
+// Step 20b (decision 6): a POS shift is open on this device. Signing out would delete its count
+// and its sales not synced yet, and keep the register held, so it waits for the close. From the
+// shell, "Close shift" goes to the POS screen with the close open; on the lock screen there is no
+// way to the POS until the PIN is typed, so it only says why.
+export function ShiftOpenDialog({
+  number,
+  onClose,
+  onCloseShift,
+}: {
+  number: string;
+  onClose: () => void;
+  onCloseShift?: () => void;
+}) {
+  const { t } = useLocale();
+  return (
+    <Dialog
+      open
+      onOpenChange={(open) => {
+        if (!open) onClose();
+      }}
+    >
+      <DialogContent
+        title={t('pos.close.signOutTitle')}
+        footer={
+          <>
+            <DialogClose asChild>
+              <Button variant={onCloseShift ? 'secondary' : 'primary'}>{t('common.cancel')}</Button>
+            </DialogClose>
+            {onCloseShift && (
+              <Button
+                onClick={() => {
+                  onClose();
+                  onCloseShift();
+                }}
+              >
+                {t('pos.close.signOutClose')}
+              </Button>
+            )}
+          </>
+        }
+      >
+        <p className="text-body-sm text-ink-2">{t('pos.close.signOutBody', { number })}</p>
+      </DialogContent>
+    </Dialog>
+  );
+}
```

```diff
@@ -9,13 +9,14 @@ import { Controller, useForm } from 'react-hook-form';
 
 import { type LockReason, useDeviceState } from '../lib/local-data';
 import { unlockFormSchema } from '../lib/pin';
+import { lockedIdleMinutes } from '../lib/remembered-session';
 import { logout, signInAgain } from '../lib/session';
 import { useSession } from '../lib/session-store';
 import { useOnline } from '../lib/use-online';
 import { AuthLayout } from './auth-layout';
 import { DocumentNotice } from './document-notice';
 import { PinField } from './pin-field';
-import { SignOutDialog } from './sign-out-dialog';
+import { ShiftOpenDialog, SignOutDialog } from './sign-out-dialog';
 
 const DESCRIPTIONS = {
   locked: 'pin.lock.description',
@@ -35,6 +36,7 @@ export function LockScreen() {
   const openedOffline = useSession((state) => state.openedOffline);
   const online = useOnline();
   const [asking, setAsking] = useState(false);
+  const [shiftOpen, setShiftOpen] = useState(false);
   const [leaving, setLeaving] = useState(false);
   const {
     control,
@@ -52,6 +54,12 @@ export function LockScreen() {
   const lock = device.kind === 'locked' ? device : null;
   const reason = lock?.reason ?? (openedOffline ? 'offline' : 'locked');
   const max = format.number(MAX_WRONG_PINS);
+  // Step 20b (decision 7): the POS locked itself; read once, the flag does not change while locked
+  const [idleMinutes] = useState(lockedIdleMinutes);
+  const description =
+    reason === 'locked' && idleMinutes !== null
+      ? t('pin.lock.idleDescription', { minutes: format.number(idleMinutes) })
+      : t(DESCRIPTIONS[reason]);
 
   const onSubmit = handleSubmit(async ({ pin }) => {
     if (!lock) return;
@@ -74,15 +82,17 @@ export function LockScreen() {
     await signInAgain();
   };
 
+  // Step 20b (decision 6): an open POS shift first, then the changes waiting
   const signOut = () => {
-    if (lock && lock.waiting > 0) setAsking(true);
+    if (lock?.openShift) setShiftOpen(true);
+    else if (lock && lock.waiting > 0) setAsking(true);
     else void logout();
   };
 
   return (
     <AuthLayout>
       <h1 className="text-[28px] leading-[1.2]">{t('pin.lock.title')}</h1>
-      <p className="mt-2 text-ink-2">{t(DESCRIPTIONS[reason])}</p>
+      <p className="mt-2 text-ink-2">{description}</p>
 
       {me && (
         <p className="mt-6 grid rounded-control border border-line px-3 py-2.5">
@@ -172,6 +182,15 @@ export function LockScreen() {
         </p>
       )}
 
+      {shiftOpen && lock?.openShift && (
+        <ShiftOpenDialog
+          number={lock.openShift}
+          onClose={() => {
+            setShiftOpen(false);
+          }}
+        />
+      )}
+
       {asking && lock && (
         <SignOutDialog
           count={lock.waiting}
```

- **`ShiftOpenDialog` beside `SignOutDialog`:** the same lazy chunk in the shell. With `onCloseShift` it offers "Close
  shift"; without it (the lock screen) Cancel is the only button and the primary one.
- **The lock screen asks before the changes waiting:** a shift open matters more than the count of changes, and its
  close is one of them.
- **The idle description is read once** (`useState` with a function): the flag does not change while the screen is
  locked.
- **The shell's sign-out and the route's `?close` are in `app-shell.tsx` and `router.tsx`,** which 20b.6b changes again
  for the new pages; their diffs are shown once, there.

### `apps/app/scripts/check-bundle-size.ts`: the budgets

```diff
@@ -11,8 +11,9 @@ import { z } from 'zod';
 // from growing the first load unnoticed. Step 19a: 215 KB (you chose this). 19a's words and the
 // offline sign-in took it to 211.6 KB; from now on the service worker keeps these files, so only
 // the very first visit downloads them. Step 20a: 220 KB (you chose this). 20a's words (the
-// registers, the POS screen, its sales and the sold-short list) took it to 217.9 KB.
-const INITIAL_BUDGET = 220 * 1024;
+// registers, the POS screen, its sales and the sold-short list) took it to 217.9 KB. Step 20b: 225 KB
+// (you chose this). 20b's words (the shift, the count, held bills, the shifts pages) took it to 222.0 KB.
+const INITIAL_BUDGET = 225 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
@@ -20,8 +21,10 @@ const INITIAL_BUDGET = 220 * 1024;
 // The customer box and the pickers now read the device's customers with the outbox on top, and the
 // line editors and the shell were already at 104–105 KB. Step 20a: 115 KB (you chose this). The
 // script counts a lazy chunk together with the chunk it loads from, so the POS screen with its
-// payment dialog is one number: 112.3 KB.
-const CHUNK_BUDGET = 115 * 1024;
+// payment dialog is one number: 112.3 KB. Step 20b: 125 KB (you chose this). The screen sells inside a
+// shift now (the shift's cash, the cart kept on the device), so /pos is 115.9 KB and its dialogs with
+// it 120–124 KB, after the shift menu moved to a chunk of its own.
+const CHUNK_BUDGET = 125 * 1024;
 // Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
 // 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
 // changed.
```

- **225 KB and 125 KB** (decision 87), with the reason next to each number, like every earlier raise.

### Check this part

```bash
pnpm --filter @omnivo/sync typecheck
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app test
pnpm exec eslint packages/sync/src apps/app/src/components/pos-*.tsx apps/app/src/routes/pos.tsx apps/app/src/lib
pnpm exec prettier --check packages/sync/src apps/app/src
pnpm --filter @omnivo/app exec vite build && pnpm --filter @omnivo/app test:bundle-size
```

All pass: 103 sync tests (8 new) and 195 app unit tests (6 new), and the bundle check with the new budgets (first load
222.0 KB, /pos 115.9 KB, its biggest dialog 123.5 KB). `pnpm --filter @omnivo/app typecheck` fails only in
`notification-bell.tsx`, `sync-parts.tsx`, `routes/pos-registers.tsx` (20b.6b) and the two mock files (20b.7). Not
checked in a browser yet: mock mode has no shift until 20b.7 (the MSW pull's reasons and registers, the push's three
commands).

## 20b.6b — the managers' pages: registers, cash reasons, shifts

The pages around the shift, all in the shell and all read from the server. A register's form gets its three shift
fields. Two new pages: Settings → POS cash reasons, and Sales → POS shifts with each shift's page, where a manager
closes a stuck shift without a count. The bell's new kind opens its shift, the Sync page names the shift's commands, a
POS sale's page shows its shift, and a shift's journal entry links back to it.

### `apps/app/src/components/pos-shift-parts.tsx` (new): a shift's words and pill

```tsx
import {
  CheckmarkCircle02Icon,
  Clock01Icon,
  MinusSignCircleIcon,
} from '@hugeicons/core-free-icons';
import type { PosShiftStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';

import { differenceKind } from '../lib/pos-shift';
import { hasPaisa } from './pos-parts';

// Step 20b: a shift's words and pill, for the POS screen, the managers' pages and the bell. Small
// on purpose: the bell is in the first load.

type Locale = ReturnType<typeof useLocale>;

// Whole taka unless the amount has paisa, like the counter (CLAUDE.md → Money at the counter): a
// count of ৳2,502.50 is shown as it was counted, and ৳5,000 without ".00"
export function counterMoney(format: Locale['format'], value: string): string {
  return format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// "৳50 short", "৳120 over", "No difference" (decision 66). The sign becomes the word, so one
// sentence reads right both ways.
export function differenceWords(t: Locale['t'], format: Locale['format'], difference: string) {
  const kind = differenceKind(difference);
  if (kind === 'even') return t('posShifts.even');
  const amount = counterMoney(format, difference.replace(/^-/, ''));
  return kind === 'over' ? t('posShifts.over', { amount }) : t('posShifts.short', { amount });
}

// Open is work in progress (brand). Closed is done (good). Not counted is neutral: nothing is
// wrong yet, and the next shift's opening count finds any money that is missing (decision 11).
const PILLS = {
  open: { tone: 'brand', icon: Clock01Icon },
  closed: { tone: 'good', icon: CheckmarkCircle02Icon },
  closed_without_count: { tone: 'neutral', icon: MinusSignCircleIcon },
} as const satisfies Record<PosShiftStatus, { tone: string; icon: unknown }>;

export function PosShiftPill({ status }: { status: PosShiftStatus }) {
  const { t } = useLocale();
  const pill = PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`posShifts.statuses.${status}`)}
    </Pill>
  );
}
```

- **`counterMoney()`:** whole taka unless the amount has paisa, the counter's rule (decision 88). A drawer is counted
  to the paisa (`cashCountSchema` takes 2 decimals), so ৳2,502.50 must not round to ৳2,503 on any page.
- **`differenceWords()` takes `t` and `format`,** not a hook: the bell calls it inside a plain function that turns a
  notification's params into words, and the POS screen inside its own helpers. The minus is dropped before the amount
  is written, and the word ("short") carries the sign (decision 66).
- **`PILLS` is `satisfies Record<PosShiftStatus, …>`:** a fourth status in the contract would not compile until it
  has its pill (decision 89).
- **Small on purpose:** the bell imports it, and the bell is in the first load. It imports only `Pill`, three icons,
  `differenceKind()` and `hasPaisa()`, which are tiny.

### `apps/app/src/lib/pos-queries.ts`: the reasons and the shifts

```diff
@@ -1,12 +1,18 @@
-import { type PosRegisterStatus, routes } from '@omnivo/contracts';
+import {
+  type PosCashReasonListQuery,
+  type PosRegisterStatus,
+  type PosShiftListQuery,
+  routes,
+} from '@omnivo/contracts';
 import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
 
 import { call } from './api';
 
 // Step 20a: the server's reads of the POS, for the managers' pages: the registers, the posted
-// sales and what sold short. Its own file, not queries.ts: queries.ts is in the chunk of almost
-// every page, and only these three pages need these. All of them start with ['pos', tenantId], so
-// one refresh after a register's save or a sync refreshes every POS list.
+// sales and what sold short; step 20b adds the cash reasons and the shifts. Its own file, not
+// queries.ts: queries.ts is in the chunk of almost every page, and only the POS pages need these.
+// All of them start with ['pos', tenantId], so one refresh after a register's save or a sync
+// refreshes every POS list.
 
 // The registers settings page: every register of the workspace, with who holds it
 export function posRegistersQuery(tenantId: string, status: PosRegisterStatus) {
@@ -67,3 +73,45 @@ export function soldShortQuery(tenantId: string, warehouseId: string) {
     placeholderData: keepPreviousData,
   });
 }
+
+// Step 20b: the pay in and pay out reasons, for their settings page
+export function posCashReasonsQuery(
+  tenantId: string,
+  status: NonNullable<PosCashReasonListQuery['status']>,
+) {
+  return queryOptions({
+    queryKey: ['pos', tenantId, 'cash-reasons', status],
+    queryFn: async () =>
+      (await call(routes.posShifts.listCashReasons, { query: { status } })).items,
+  });
+}
+
+// The shifts, newest first. '' = every register; undefined = every status.
+export function posShiftsQuery(
+  tenantId: string,
+  registerId: string,
+  status: PosShiftListQuery['status'],
+) {
+  return infiniteQueryOptions({
+    queryKey: ['pos', tenantId, 'shifts', registerId, status ?? 'all'],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.posShifts.listShifts, {
+        query: {
+          limit: 50,
+          ...(registerId !== '' && { registerId }),
+          ...(status !== undefined && { status }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function posShiftQuery(tenantId: string, shiftId: string) {
+  return queryOptions({
+    queryKey: ['pos', tenantId, 'shift', shiftId],
+    queryFn: () => call(routes.posShifts.getShift, { params: { id: shiftId } }),
+  });
+}
```

- **Keys under `['pos', tenantId]`** like 20a's: a reason's save, a close without a count and a register's save each
  refresh every POS list with one `invalidateQueries`.
- **`status ?? 'all'` in the shifts key:** `undefined` in a query key would work, but "all" reads clearly in the
  devtools, and it can never clash with a real status.
- **No `status` in the request for "all":** the contract's `status` is optional, and the server then sends every
  status. Sending `''` would fail the server's enum check.

### `apps/app/src/routes/pos-registers.tsx`: the shift fields

```diff
@@ -10,6 +10,7 @@ import {
   contractErrorMap,
   formatPosNumber,
   moneyAccountIds,
+  POS_LOCK_AFTER,
   POS_PAPER_WIDTHS,
   POS_PAYMENT_METHODS,
   POS_REGISTER_STATUSES,
@@ -79,6 +80,9 @@ const FIELD_NAMES = [
   'maxDiscountPercent',
   'paperWidth',
   'receiptFooter',
+  'overShortAccountId',
+  'varianceAlert',
+  'lockAfter',
 ] as const satisfies readonly Path<FormValues>[];
 
 function RegisterForm({
@@ -103,6 +107,20 @@ function RegisterForm({
       .filter((account) => ids.has(account.id))
       .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
   }, [accounts]);
+  // Step 20b: where a count's difference goes. The API takes an active income or expense account
+  // that is not a group (pos_over_short_invalid), so the select offers only those.
+  const overShortAccounts = useMemo(
+    () =>
+      (accounts ?? [])
+        .filter(
+          (account) =>
+            !account.isGroup &&
+            account.archivedAt === null &&
+            (account.type === 'income' || account.type === 'expense'),
+        )
+        .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
+    [accounts],
+  );
   const {
     register,
     handleSubmit,
@@ -124,6 +142,11 @@ function RegisterForm({
       maxDiscountPercent: current?.maxDiscountPercent ?? '',
       paperWidth: current?.paperWidth ?? '80',
       receiptFooter: current?.receiptFooter ?? '',
+      // Step 20b: a register made in 20a has no over/short account yet (decision 42), so the select
+      // starts empty and the save asks for one. A new register starts with ৳500 and 5 minutes.
+      overShortAccountId: current?.overShortAccountId ?? '',
+      varianceAlert: current?.varianceAlert ?? '500',
+      lockAfter: current?.lockAfter ?? '5',
       version: current?.version ?? 1,
     } satisfies FormValues,
   });
@@ -297,6 +320,45 @@ function RegisterForm({
             error={errors.paperWidth?.message}
           />
         </div>
+        {/* Step 20b: what a shift needs from its register (decisions 5, 7, 13–15) */}
+        <fieldset className="grid gap-4">
+          <legend className="text-label font-medium">{t('registers.shiftTitle')}</legend>
+          <p className="-mt-2 text-label text-ink-3">{t('registers.shiftHint')}</p>
+          <SelectField
+            label={t('registers.overShortAccount')}
+            hint={t('registers.overShortHint')}
+            options={[
+              { value: '', label: t('registers.accountPlaceholder') },
+              ...overShortAccounts.map((account) => ({
+                value: account.id,
+                label: `${account.code} · ${account.name}`,
+              })),
+            ]}
+            {...register('overShortAccountId')}
+            error={errors.overShortAccountId?.message}
+          />
+          <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
+            <TextField
+              label={t('registers.varianceAlert')}
+              hint={t('registers.varianceAlertHint')}
+              inputMode="numeric"
+              align="end"
+              placeholder="500"
+              {...register('varianceAlert')}
+              error={errors.varianceAlert?.message}
+            />
+            <SelectField
+              label={t('registers.lockAfter')}
+              hint={t('registers.lockAfterHint')}
+              options={POS_LOCK_AFTER.map((value) => ({
+                value,
+                label: t(`registers.lockAfters.${value}`),
+              }))}
+              {...register('lockAfter')}
+              error={errors.lockAfter?.message}
+            />
+          </div>
+        </fieldset>
         <TextAreaField
           label={t('registers.receiptFooter')}
           optional
```

- **The over/short select lists the API's accounts only** (decision 92): active income or expense, not a group. The
  server checks it again (`pos_over_short_invalid` under `overShortAccountId`, which `FIELD_NAMES` lists so the error
  lands under the box).
- **Empty for a register made in 20a:** it has no account (decision 42), and picking one for the owner would book every
  difference to an account nobody chose. The save then says `pos_over_short_required`.
- **The bell limit is a plain text box, not a `MoneyInput`:** it is whole taka (`pos_variance_alert_format`), and the
  label already says ৳. An empty box is 0, a bell for any difference (decision 14).
- **"Lock the POS after" is a native select** of `POS_LOCK_AFTER`, the contract's list, so the form sends exactly what
  the schema takes (decision 15).

### `apps/app/src/routes/pos-cash-reasons.tsx` (new): Settings → POS cash reasons

```tsx
import {
  Archive02Icon,
  CheckmarkCircle02Icon,
  MoneyAdd01Icon,
  MoneyExchange03Icon,
  MoneyRemove01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  contractErrorMap,
  isPartyAccountPurpose,
  POS_CASH_DIRECTIONS,
  POS_CASH_REASON_STATUSES,
  type PosCashDirection,
  type PosCashReason,
  posCashReasonInputSchema,
  routes,
  type StockAccounts,
  updatePosCashReasonInputSchema,
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
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type Path, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { failureOf } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { posCashReasonsQuery } from '../lib/pos-queries';
import { accountsQuery, stockAccountsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Step 20b: Settings → POS cash reasons (decisions 4 and 67). Why a cashier puts money into the
// drawer or takes it out, and the account on the other side. The device copies the active ones
// (the pull's pos_cash_reason rows), so the cashier picks a reason offline and never an account.
// Like the registers page: a data table and one form dialog. Everyone may read it;
// pos.register.manage changes it.

type ReasonStatus = (typeof POS_CASH_REASON_STATUSES)[number];

const column = dataTableColumns<PosCashReason>();

// One form for both: the create schema plus the version. A change sends the name and the account
// (a reason's direction never changes, decision 20); a new reason sends everything but the version.
const formSchema = posCashReasonInputSchema.extend({
  version: updatePosCashReasonInputSchema.shape.version,
});
type FormValues = z.input<typeof formSchema>;

const FIELD_NAMES = [
  'name',
  'direction',
  'accountId',
] as const satisfies readonly Path<FormValues>[];

// A pay in and a pay out look alike at a glance in a list of names; the pill tells them apart. Not
// a status, so neutral, with the shift menu's icons.
const DIRECTION_ICONS = {
  in: MoneyAdd01Icon,
  out: MoneyRemove01Icon,
} as const satisfies Record<PosCashDirection, unknown>;

function DirectionPill({ direction }: { direction: PosCashDirection }) {
  const { t } = useLocale();
  return (
    <Pill tone="neutral" icon={DIRECTION_ICONS[direction]}>
      {t(`posCashReasons.pills.${direction}`)}
    </Pill>
  );
}

// The accounts a reason may name, the API's own rule (pos-cash-reasons.service.ts → checkAccount):
// active, not a group, not the receivable or the payable (a pay out names no customer), and not a
// stock account (the inventory, goods in transit, goods received not billed: cash buys no stock
// here). `keep` stays in the list even when it no longer fits (its account archived since), so the
// select shows it instead of moving to another. By code, like every account select.
function reasonAccounts(
  accounts: readonly Account[],
  stock: StockAccounts | undefined,
  keep: string,
): Account[] {
  const stockIds = new Set([stock?.in_transit, stock?.received_not_billed]);
  return accounts
    .filter(
      (account) =>
        account.id === keep ||
        (!account.isGroup &&
          account.archivedAt === null &&
          !isPartyAccountPurpose(account.purpose) &&
          account.purpose !== 'inventory' &&
          !stockIds.has(account.id)),
    )
    .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

function ReasonForm({
  reason: current,
  accounts,
  onDone,
}: {
  reason: PosCashReason | null;
  accounts: readonly Account[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const stock = useQuery(stockAccountsQuery(tenantId)).data;
  const options = useMemo(
    () => reasonAccounts(accounts, stock, current?.accountId ?? ''),
    [accounts, stock, current],
  );
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(formSchema, { error: contractErrorMap }),
    defaultValues: {
      name: current?.name ?? '',
      // A new workspace's first reason is the float (decision 12): "in" first
      direction: current?.direction ?? 'in',
      // Picked on purpose: a pay out to the wrong account is a wrong expense
      accountId: current?.accountId ?? '',
      version: current?.version ?? 1,
    } satisfies FormValues,
  });
  // The account's hint says where the money comes from or goes to, by the direction picked
  const direction = useWatch({ control, name: 'direction' });

  // The page's list and the reason's own row read ['pos', tenant]
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pos', tenantId] });

  const toggle = useMutation({
    mutationFn: (item: PosCashReason) =>
      call(
        item.archivedAt === null
          ? routes.posShifts.archiveCashReason
          : routes.posShifts.restoreCashReason,
        { params: { id: item.id }, body: { version: item.version } },
      ),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(
          saved.archivedAt === null
            ? 'posCashReasons.restoredToast'
            : 'posCashReasons.archivedToast',
          {
            name: saved.name,
          },
        ),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, direction: picked, ...fields }) => {
    try {
      const saved = current
        ? await call(routes.posShifts.updateCashReason, {
            params: { id: current.id },
            body: { ...fields, version },
          })
        : await call(routes.posShifts.createCashReason, {
            body: { ...fields, direction: picked },
          });
      await refresh();
      toast(t(current ? 'posCashReasons.updated' : 'posCashReasons.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // archive/restore's errors (version_conflict; a restore whose account no longer fits,
  // pos_reason_account_invalid) belong to no box of the form
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={
        current
          ? t('posCashReasons.editTitle', { name: current.name })
          : t('posCashReasons.newTitle')
      }
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
              {current.archivedAt === null
                ? t('posCashReasons.archive')
                : t('posCashReasons.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="cash-reason-form" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : current
                ? t('common.save')
                : t('posCashReasons.add')}
          </Button>
        </>
      }
    >
      <form
        id="cash-reason-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('posCashReasons.name')}
          placeholder={t('posCashReasons.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        {current ? (
          // Decision 20: shown, not offered. The money it moved keeps its meaning.
          <Field
            id="cash-reason-direction"
            label={t('posCashReasons.direction')}
            hint={t('posCashReasons.directionLocked')}
          >
            <p id="cash-reason-direction" className="py-2.5 text-body">
              {t(`posCashReasons.directions.${current.direction}`)}
            </p>
          </Field>
        ) : (
          <SelectField
            label={t('posCashReasons.direction')}
            options={POS_CASH_DIRECTIONS.map((value) => ({
              value,
              label: t(`posCashReasons.directions.${value}`),
            }))}
            {...register('direction')}
            error={errors.direction?.message}
          />
        )}
        <SelectField
          label={t('posCashReasons.account')}
          hint={t(`posCashReasons.accountHints.${direction}`)}
          options={[
            { value: '', label: t('posCashReasons.accountPlaceholder') },
            ...options.map((account) => ({
              value: account.id,
              label: `${account.code} · ${account.name}`,
            })),
          ]}
          {...register('accountId')}
          error={errors.accountId?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | PosCashReason;

export function PosCashReasonsPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('pos.register.manage');
  const [status, setStatus] = useState<ReasonStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({
    ...posCashReasonsQuery(tenantId, status),
    enabled: me !== null,
  });
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const accountName = useMemo(
    () =>
      new Map((accounts ?? []).map((account) => [account.id, `${account.code} · ${account.name}`])),
    [accounts],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('posCashReasons.columns.reason'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
        }),
        column.accessor('direction', {
          header: t('posCashReasons.columns.direction'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <DirectionPill direction={getValue()} />,
        }),
        column.accessor('accountId', {
          header: t('posCashReasons.columns.account'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => accountName.get(getValue()) ?? '—',
        }),
        column.accessor('archivedAt', {
          header: t('posCashReasons.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('posCashReasons.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('posCashReasons.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t, accountName],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('posCashReasons.title')}
        description={t('posCashReasons.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('posCashReasons.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('posCashReasons.show')}
          value={status}
          options={POS_CASH_REASON_STATUSES.map((value) => ({
            value,
            label: t(`posCashReasons.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('posCashReasons.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('posCashReasons.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('posCashReasons.title')}
          data={data}
          columns={columns}
          getRowId={(item) => item.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('posCashReasons.emptyArchivedTitle')}
                description={t('posCashReasons.emptyArchivedBody')}
              />
            ) : (
              <EmptyState
                icon={MoneyExchange03Icon}
                title={t('posCashReasons.emptyTitle')}
                description={t('posCashReasons.emptyBody')}
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
        {/* The form opens with the chart loaded: its select lists the accounts */}
        {editing !== null && accounts && (
          <ReasonForm
            key={editing === 'new' ? 'new' : editing.id}
            reason={editing === 'new' ? null : editing}
            accounts={accounts}
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

- **One form for a new reason and a change,** like the registers form: the create schema plus the version. A change
  sends the name and the account only; the update route has no direction (decision 20).
- **The direction is shown, not offered, on an existing reason,** with the hint that says why and what to do instead
  (add a reason the other way).
- **`reasonAccounts()` follows the API's rule** (decision 91). The stock accounts (goods in transit, goods received not
  billed) come from `stockAccountsQuery`, which everyone may read; the inventory account has the purpose `inventory`.
  While that query loads, the list may show those two accounts for a moment; the server would refuse them
  (`pos_reason_account_invalid`), so nothing wrong is ever saved.
- **The account's hint follows the direction picked** (`useWatch`): "where the money comes from" for a pay in, "where
  it goes" for a pay out.
- **A new reason starts as "in":** a new workspace's first need is the float of a register's first shift (decision 12).
- **Archive and restore are in the dialog,** like a register's. A restore checks the account again, so its error
  (`pos_reason_account_invalid`) shows at the top: it names no box the person typed in.

### `apps/app/src/routes/pos-shifts.tsx` (new): the shifts list

```tsx
import { UserTime01Icon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { POS_SHIFT_STATUSES, type PosShiftStatus, type PosShiftSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { counterMoney, differenceWords, PosShiftPill } from '../components/pos-shift-parts';
import { useTenantId, useTimeZone } from '../components/stock-parts';
import { posRegistersQuery, posShiftsQuery } from '../lib/pos-queries';
import { useOnline } from '../lib/use-online';

// Step 20b: every register's shifts, newest first, for the people with pos.shift.manage (decision
// 26: a shift shows how short a cashier's drawer was). Read from the server, like the POS sales:
// offline it says it needs a connection. A row opens the shift's page.

const column = dataTableColumns<PosShiftSummary>();

function isShiftStatus(value: string): value is PosShiftStatus {
  return POS_SHIFT_STATUSES.some((status) => status === value);
}

export function PosShiftsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  // '' = every register; undefined = every status
  const [registerId, setRegisterId] = useState('');
  const [status, setStatus] = useState<PosShiftStatus | undefined>(undefined);
  const registers = useQuery(posRegistersQuery(tenantId, 'active')).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...posShiftsQuery(tenantId, registerId, status),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        // The number, and when it opened by the device's clock in the workspace's time zone
        column.accessor('number', {
          header: t('posShifts.columns.shift'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {format.dateTime(new Date(row.original.openedAt), timeZone)}
              </span>
            </span>
          ),
        }),
        column.accessor((shift) => shift.register.code, {
          id: 'register',
          header: t('posShifts.columns.register'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="font-mono">{row.original.register.code}</span>
              <span className="truncate text-caption text-ink-3">{row.original.register.name}</span>
            </span>
          ),
        }),
        // One person on one device (step 20 decision 4): the device under the name
        column.accessor((shift) => shift.cashier.fullName, {
          id: 'cashier',
          header: t('posShifts.columns.cashier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="truncate">{row.original.cashier.fullName}</span>
              <span className="truncate text-caption text-ink-3">{row.original.device.name}</span>
            </span>
          ),
        }),
        // So far while open, at the close once closed (the API's number, decision 60)
        column.accessor('expectedCash', {
          header: t('posShifts.columns.expected'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => counterMoney(format, getValue()),
        }),
        column.accessor('countedCash', {
          header: t('posShifts.columns.counted'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => {
            const counted = getValue();
            return counted === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-medium">{counterMoney(format, counted)}</span>
            );
          },
        }),
        // In words, not a sign (decision 66): "৳50 short" reads the same in both languages
        column.accessor('difference', {
          header: t('posShifts.columns.difference'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => {
            const difference = getValue();
            return difference === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              differenceWords(t, format, difference)
            );
          },
        }),
        column.accessor('status', {
          header: t('posShifts.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <PosShiftPill status={getValue()} />,
        }),
      ]),
    [t, format, timeZone],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('posShifts.title')} description={t('posShifts.description')} />
      <div className="flex flex-wrap gap-3">
        <div className="w-full sm:w-72">
          <Select
            aria-label={t('posShifts.register')}
            value={registerId}
            onChange={(event) => {
              setRegisterId(event.target.value);
            }}
            options={[
              { value: '', label: t('posShifts.allRegisters') },
              ...(registers ?? []).map((register) => ({
                value: register.id,
                label: `${register.code} · ${register.name}`,
              })),
            ]}
          />
        </div>
        {/* A select, not a segmented control: "All shifts" is a choice too, and the manager most
            often looks for the open ones (a stuck shift) */}
        <div className="w-full sm:w-56">
          <Select
            aria-label={t('posShifts.show')}
            value={status ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              setStatus(isShiftStatus(value) ? value : undefined);
            }}
            options={[
              { value: '', label: t('posShifts.allStatuses') },
              ...POS_SHIFT_STATUSES.map((value) => ({
                value,
                label: t(`posShifts.statuses.${value}`),
              })),
            ]}
          />
        </div>
      </div>
      {isError && <p className="text-body-sm text-crit">{t('posShifts.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('posShifts.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('posShifts.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/pos/shifts/$shiftId', params: { shiftId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={UserTime01Icon}
              title={t('posShifts.emptyTitle')}
              description={t('posShifts.emptyBody')}
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

- **Offline, "Needs a connection":** like the POS sales, the shifts are not on the devices, and the query does not run
  (`enabled: online`).
- **Two selects** (decision 90): the active registers, and the statuses with "All shifts" first. `isShiftStatus()`
  narrows the select's string to the contract's type, with no cast.
- **The cashier column has the device under the name:** one shift is one person on one device (step 20 decision 4),
  and a manager looking for a stuck shift asks "which PC?".
- **Counted and Difference are a dash while there is no closing count** (an open shift, or one closed without a
  count), not ৳0: ৳0 would read as an empty drawer.
- **The difference is words** ("৳50 short", decision 66), in `ink`: a status colour needs an icon and a label
  (CLAUDE.md), and the word already says which way.
- **Opened is the device's clock** in the workspace's time zone, like a POS sale's time.

### `apps/app/src/routes/pos-shift.tsx` (new): one shift

```tsx
import { AlertCircleIcon, MinusSignCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CashCount,
  CASH_DENOMINATIONS,
  compareMoney,
  contractErrorMap,
  type EntryRef,
  multiplyMoney,
  type PosShift,
  posShiftCloseWithoutCountInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  KpiStrip,
  PageHeader,
  TextAreaField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Fact } from '../components/adjustment-view';
import { DocumentNotice } from '../components/document-notice';
import { EntryLinks } from '../components/entry-links';
import { failureOf } from '../components/journal-parts';
import { counterMoney, differenceWords, PosShiftPill } from '../components/pos-shift-parts';
import { SalesBackLink } from '../components/sales-parts';
import { useIsoDate, useTenantId, useTimeZone } from '../components/stock-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { posShiftQuery } from '../lib/pos-queries';
import { useOnline } from '../lib/use-online';

// Step 20b: one shift, as the server has it (pos.shift.manage): the two counts, what the drawer
// should hold and why, what the sales took by each method, the pay ins and outs, and the journal
// entries. An open shift that nobody can close is closed here without a count (decisions 11, 27).
// Every amount has its paisa, like a document; the three numbers at the top read like the
// counter's result (whole taka unless there is paisa), so a manager compares them at a glance.

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/shifts" label={t('posShifts.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('posShifts.title')} description={message} />
    </div>
  );
}

export function PosShiftPage() {
  const { t } = useLocale();
  const online = useOnline();
  const { shiftId = '' } = useParams({ strict: false });
  const { data: shift, isError } = useQuery({
    ...posShiftQuery(useTenantId(), shiftId),
    enabled: shiftId !== '',
  });
  if (isError) return <CantFind message={t('posShifts.notFound')} />;
  // Offline before it ever loaded: the shifts are read from the server only
  if (!shift) return online ? null : <CantFind message={t('posShifts.needsConnection')} />;
  return <PosShiftView shift={shift} />;
}

function PosShiftView({ shift }: { shift: PosShift }) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  const isoDate = useIsoDate();
  const [closing, setClosing] = useState(false);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const time = (iso: string) => format.dateTime(new Date(iso), timeZone);
  // Decision 22: the books use the server's number; the page says when the device's differed
  const differs =
    shift.closing !== null && compareMoney(shift.closing.deviceExpected, shift.expectedCash) !== 0;
  // The opening's entry is the float on a register's first shift, else the opening difference
  const openingEntryLabel =
    shift.opening.floatReason === null
      ? t('posShifts.entries.opening')
      : t('posShifts.entries.float');

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/shifts" label={t('posShifts.back')} />
      <PageHeader
        title={shift.number}
        description={`${shift.register.code} · ${shift.register.name}`}
        actions={
          <>
            <PosShiftPill status={shift.status} />
            {shift.status === 'open' && (
              <Button
                variant="secondary"
                onClick={() => {
                  setClosing(true);
                }}
              >
                <HugeiconsIcon icon={MinusSignCircleIcon} size={17} strokeWidth={1.5} />
                {t('posShifts.closeWithoutCount')}
              </Button>
            )}
          </>
        }
      />
      {shift.status === 'open' && (
        <DocumentNotice tone="neutral">
          {t('posShifts.stillOpen', { time: time(shift.openedAt) })}
        </DocumentNotice>
      )}
      {shift.status === 'closed_without_count' && (
        <DocumentNotice tone="neutral">
          {t('posShifts.withoutCount')}
          {shift.closedBy && shift.closedAt !== null && (
            <span className="block text-ink-3">
              {t('posShifts.closedBy', {
                name: shift.closedBy.fullName,
                time: time(shift.closedAt),
              })}
            </span>
          )}
        </DocumentNotice>
      )}
      {differs && shift.closing && (
        <DocumentNotice tone="neutral">
          {t('posShifts.expectedDiffers', {
            device: money(shift.closing.deviceExpected),
            server: money(shift.expectedCash),
          })}
        </DocumentNotice>
      )}
      <KpiStrip
        cells={[
          {
            label: t('posShifts.columns.expected'),
            value: counterMoney(format, shift.expectedCash),
          },
          {
            label: t('posShifts.columns.counted'),
            value: shift.countedCash === null ? '—' : counterMoney(format, shift.countedCash),
          },
          {
            label: t('posShifts.columns.difference'),
            value: shift.difference === null ? '—' : differenceWords(t, format, shift.difference),
          },
        ]}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact
          label={t('posShifts.register')}
          value={`${shift.register.code} · ${shift.register.name}`}
        />
        <Fact label={t('posShifts.cashier')} value={shift.cashier.fullName} />
        <Fact label={t('posShifts.device')} value={shift.device.name} />
        <Fact label={t('posShifts.openedAt')} value={time(shift.openedAt)} />
        <Fact
          label={t('posShifts.closedAt')}
          value={shift.closedAt === null ? '—' : time(shift.closedAt)}
        />
      </Card>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <CashCard shift={shift} money={money} />
        <Card>
          {/* The sales the server has received in the shift, and what they took by method */}
          <CardHeader
            title={t('posShifts.payments')}
            subtitle={t('posShifts.sales', {
              count: shift.saleCount,
              formatted: format.number(shift.saleCount),
              total: money(shift.salesTotal),
            })}
          />
          <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
            {shift.payments.map((payment) => (
              <div key={payment.method} className="flex justify-between gap-3">
                <dt className="text-ink-2">{t(`pos.methods.${payment.method}`)}</dt>
                <dd className="tabular-nums">{money(payment.amount)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('posShifts.opening')} />
          <div className="grid gap-4 px-5 pt-3 pb-5">
            <dl className="grid gap-2 text-body-sm">
              <Row label={t('posShifts.openingCounted')} value={money(shift.opening.count.total)} />
              {shift.opening.comparedWith === null ? (
                <p className="text-ink-3">{t('posShifts.firstShift')}</p>
              ) : (
                <Row label={t('posShifts.lastLeft')} value={money(shift.opening.comparedWith)} />
              )}
              {shift.opening.difference !== null && (
                <Row
                  label={t('posShifts.columns.difference')}
                  value={differenceWords(t, format, shift.opening.difference)}
                />
              )}
              {shift.opening.floatReason && (
                <Row label={t('posShifts.floatReason')} value={shift.opening.floatReason.name} />
              )}
            </dl>
            <CountTable count={shift.opening.count} money={money} />
          </div>
        </Card>
        {shift.closing && (
          <Card>
            <CardHeader title={t('posShifts.closing')} />
            <div className="grid gap-4 px-5 pt-3 pb-5">
              <dl className="grid gap-2 text-body-sm">
                <Row
                  label={t('posShifts.columns.counted')}
                  value={money(shift.closing.count.total)}
                />
                <Row
                  label={t('posShifts.deviceExpected')}
                  value={money(shift.closing.deviceExpected)}
                />
                <Row
                  label={t('posShifts.heldDropped')}
                  value={format.number(shift.closing.heldDropped)}
                />
              </dl>
              <CountTable count={shift.closing.count} money={money} />
            </div>
          </Card>
        )}
      </div>
      <MovementsCard shift={shift} money={money} time={time} isoDate={isoDate} />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-2">
        <EntryLinks
          label={openingEntryLabel}
          entries={shift.opening.entry ? [shift.opening.entry] : []}
          none="—"
        />
        <EntryLinks
          label={t('posShifts.entries.closing')}
          entries={shift.closing?.entry ? [shift.closing.entry] : []}
          none="—"
        />
      </Card>
      {closing && (
        <CloseWithoutCountDialog
          shift={shift}
          onClose={() => {
            setClosing(false);
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

// Why the drawer should hold what it does: expectedCashOf()'s five parts, then the sum. Change and
// pay outs take money away, so they have a minus.
function CashCard({ shift, money }: { shift: PosShift; money: (value: string) => string }) {
  const { t } = useLocale();
  const { cash } = shift;
  return (
    <Card>
      <CardHeader title={t('posShifts.cash.title')} />
      <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
        <Row label={t('posShifts.cash.opening')} value={money(cash.opening)} />
        <Row label={t('posShifts.cash.cashTaken')} value={money(cash.cashTaken)} />
        <Row label={t('posShifts.cash.changeGiven')} value={`−${money(cash.changeGiven)}`} />
        <Row label={t('posShifts.cash.paidIn')} value={money(cash.paidIn)} />
        <Row label={t('posShifts.cash.paidOut')} value={`−${money(cash.paidOut)}`} />
        <div className="flex justify-between gap-3 border-t border-line pt-2 font-medium">
          <dt>{t('posShifts.cash.expected')}</dt>
          <dd className="tabular-nums">{money(shift.expectedCash)}</dd>
        </div>
      </dl>
    </Card>
  );
}

// A count by notes as the cashier typed it (only the notes there were), or one line for a count
// typed as a total
function CountTable({ count, money }: { count: CashCount; money: (value: string) => string }) {
  const { t, format } = useLocale();
  const { notes } = count;
  if (notes === null) return <p className="text-body-sm text-ink-3">{t('posShifts.asTotal')}</p>;
  const rows = CASH_DENOMINATIONS.filter((note) => notes[note] > 0);
  return (
    <div className="overflow-x-auto rounded-control border border-line">
      <table className="w-full border-collapse text-body-sm">
        <thead className="bg-subtle text-caption font-medium text-ink-3">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('posShifts.countColumns.note')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('posShifts.countColumns.count')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('posShifts.countColumns.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((note) => (
            <tr key={note} className="border-t border-line">
              <td className="px-3 py-2 tabular-nums">{format.money(note, { decimals: 0 })}</td>
              <td className="px-3 py-2 text-right tabular-nums">{format.number(notes[note])}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {money(multiplyMoney(String(notes[note]), note))}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-subtle font-medium">
            <td className="px-3 py-2" colSpan={2}>
              {t('posShifts.columns.counted')}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{money(count.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// The pay ins and pay outs, in the order they happened on the device (decision 63's note: by
// movedAt). Each has its own entry.
function MovementsCard({
  shift,
  money,
  time,
  isoDate,
}: {
  shift: PosShift;
  money: (value: string) => string;
  time: (iso: string) => string;
  isoDate: (iso: string) => string;
}) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader title={t('posShifts.movements')} />
      {shift.movements.length === 0 ? (
        <p className="px-5 pt-3 pb-5 text-body-sm text-ink-3">{t('posShifts.noMovements')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-body-sm">
            <thead className="bg-subtle text-left text-caption font-medium text-ink-3">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.time')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.reason')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.direction')}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">
                  {t('posShifts.movementColumns.amount')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.note')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.entry')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shift.movements.map((movement) => (
                <tr key={movement.id} className="border-t border-line">
                  <td className="px-5 py-3 tabular-nums">
                    {time(movement.movedAt)}
                    {/* The day in the books, when a closed day moved it (like a sale's) */}
                    <span className="block text-caption text-ink-3">{isoDate(movement.date)}</span>
                  </td>
                  <td className="px-5 py-3">{movement.reason.name}</td>
                  <td className="px-5 py-3 text-ink-2">
                    {t(`posShifts.directions.${movement.direction}`)}
                  </td>
                  <td className="px-5 py-3 text-right font-medium tabular-nums">
                    {movement.direction === 'out' ? '−' : ''}
                    {money(movement.amount)}
                  </td>
                  <td className="max-w-[16rem] px-5 py-3 text-ink-2">{movement.note ?? '—'}</td>
                  <td className="px-5 py-3">
                    <EntryLink entry={movement.entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// A movement's entry in its table cell: a link for someone who reads the journal, the plain
// number for everyone else, like EntryLinks (which is a fact cell, with its own label)
function EntryLink({ entry }: { entry: EntryRef }) {
  const canRead = useCan()('accounting.journal.read');
  return canRead ? (
    <Link
      to="/journal/$entryId"
      params={{ entryId: entry.id }}
      className="font-mono font-medium text-brand tabular-nums underline-offset-3 hover:underline"
    >
      {entry.number}
    </Link>
  ) : (
    <span className="font-mono tabular-nums">{entry.number}</span>
  );
}

// The one box the server may name in fieldErrors (a note over 200 characters)
const FIELD_NAMES = ['note'] as const;

// Decisions 11 and 27: for a shift its cashier can't close. The note is for the audit log. The
// server answers with the closed shift, which takes the page's place at once.
function CloseWithoutCountDialog({ shift, onClose }: { shift: PosShift; onClose: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(posShiftCloseWithoutCountInputSchema, { error: contractErrorMap }),
    defaultValues: { note: '' },
  });
  const close = useMutation({
    mutationFn: (note: string | null) =>
      call(routes.posShifts.closeWithoutCount, { params: { id: shift.id }, body: { note } }),
  });

  const failure = errors.root?.server?.message ?? failureOf(close.error);

  const onSubmit = handleSubmit(async ({ note }) => {
    try {
      const saved = await close.mutateAsync(note);
      queryClient.setQueryData(posShiftQuery(tenantId, shift.id).queryKey, saved);
      // The list, and the register's row (its holder and last shift)
      await queryClient.invalidateQueries({ queryKey: ['pos', tenantId] });
      toast(t('posShifts.closedToast', { number: saved.number }));
      onClose();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('posShifts.closeTitle', { number: shift.number })}
        description={t('posShifts.closeBody')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </DialogClose>
            <Button type="submit" form="close-without-count" disabled={isSubmitting}>
              {t('posShifts.closeConfirm')}
            </Button>
          </>
        }
      >
        <form
          id="close-without-count"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {/* pos_shift_closed (its cashier closed it meanwhile), version and network errors */}
          {failure && <FormAlert message={failure} />}
          <TextAreaField
            label={t('posShifts.closeNote')}
            optional
            placeholder={t('posShifts.closeNotePlaceholder')}
            {...register('note')}
            error={errors.note?.message}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- **The three numbers on top** (Expected, Counted, Difference) are a `KpiStrip`, the same three the cashier saw on the
  result screen, in the counter's money (decision 88). Below them, every amount has its paisa.
- **The notices say what the state means:** an open shift counts only what has synced so far; a shift closed without a
  count says no difference was posted and who closed it; and when the device's expected cash was not the server's, both
  numbers (decision 22, a neutral notice: decision 93).
- **"Cash in the drawer" lists `expectedCashOf()`'s five parts** and the sum, with a minus on the change and the pay
  outs, so a manager can follow how the expected number came about.
- **"Taken by method" has the sale count and total as its subtitle,** and a row for every method the register takes
  (decision 61), ৳0 included: a card machine that took nothing is worth seeing.
- **The opening card** says what the last shift left, or that this is the register's first shift, and the float's
  reason. **The closing card** shows only when there was a closing count. `CountTable` lists the notes that were there
  (not ten rows of zeros), or "Counted as a total".
- **The pay ins and outs keep the device's order** (`movedAt`), with the day in the books under the time: a closed day
  moves a movement's booking like a sale's. Each row links its own entry; `EntryLink` is `EntryLinks`'s link without
  the fact cell's label, with the same permission rule (`accounting.journal.read`).
- **The opening entry is called "Float"** on a register's first shift, else "Opening difference".
- **Close without a count** (decisions 11, 27) is a secondary button, only on an open shift. Its dialog takes an
  optional note for the audit log. The server answers with the closed shift, which goes straight into the page's
  query (`setQueryData`), so the page changes at once; then every POS list refreshes. If the cashier closed it
  meanwhile, `pos_shift_closed` shows at the top of the dialog.

### `apps/app/src/routes/pos-sale.tsx` and `components/journal-entry-view.tsx`: links to the shift

```diff
@@ -14,7 +14,7 @@ import {
 import { useLocale } from '@omnivo/i18n';
 import { Button, Card, CardHeader, EmptyState, PageHeader } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
-import { useParams } from '@tanstack/react-router';
+import { Link, useParams } from '@tanstack/react-router';
 import { lazy, Suspense } from 'react';
 
 import { Fact } from '../components/adjustment-view';
@@ -33,6 +33,7 @@ import {
   warehouseLabel,
 } from '../components/stock-parts';
 import type { ReceiptData } from '../lib/pos';
+import { useCan } from '../lib/permissions';
 import { posRegisterQuery, posSaleQuery } from '../lib/pos-queries';
 import { settingsQuery, unitsQuery } from '../lib/queries';
 import { useOnline } from '../lib/use-online';
@@ -174,6 +175,7 @@ function PosSaleView({ sale }: { sale: PosSale }) {
         />
         <Fact label={t('posSales.cashier')} value={sale.cashier.fullName} />
         <Fact label={t('posSales.device')} value={sale.device.name} />
+        <ShiftFact shift={sale.shift} />
         <EntryLinks label={t('posSales.entry')} entries={sale.entry ? [sale.entry] : []} none="—" />
       </Card>
       <SalesLinesTable
@@ -245,6 +247,31 @@ function PosSaleView({ sale }: { sale: PosSale }) {
   );
 }
 
+// Step 20b: the shift the sale was made in, a link for the people who read the shifts
+// (pos.shift.manage, decision 26). A sale made before step 20b has none.
+function ShiftFact({ shift }: { shift: PosSale['shift'] }) {
+  const { t } = useLocale();
+  const canRead = useCan()('pos.shift.manage');
+  return (
+    <div className="grid min-w-0 gap-0.5">
+      <span className="text-caption font-medium text-ink-3">{t('posSales.shift')}</span>
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
+
 // The receipt, hidden on the screen, for Print. Its own component: useReceiptCompany is a hook,
 // and the settings are only known to be there inside this branch.
 function ReprintSheet({
```

```diff
@@ -6,6 +6,7 @@ import {
   type Branch,
   contractErrorMap,
   isJournalSource,
+  isPosJournalSource,
   isPurchaseJournalSource,
   isSalesJournalSource,
   isStockJournalSource,
@@ -167,6 +168,10 @@ function documentLinkOf(entry: JournalEntry) {
   if (entry.source === 'purchase_refund') {
     return { to: '/supplier-refunds/$refundId', params: { refundId: id } } as const;
   }
+  // Step 20b: an opening or closing difference, a float, a pay in or out: its shift
+  if (entry.source === 'pos_shift') {
+    return { to: '/pos/shifts/$shiftId', params: { shiftId: id } } as const;
+  }
   return null;
 }
 
@@ -185,7 +190,8 @@ export function EntryView({
   const navigate = useNavigate();
   const refresh = useJournalRefresh();
   const showDate = useIsoDate();
-  const canPost = useCan()('accounting.journal.post');
+  const can = useCan();
+  const canPost = can('accounting.journal.post');
   const [reversing, setReversing] = useState(false);
   const accountOf = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
   const branchOf = useMemo(() => new Map(branches.map((item) => [item.id, item])), [branches]);
@@ -205,7 +211,11 @@ export function EntryView({
   // credit note for an invoice, Void for a receipt) — not from here. Step 17c: a purchase
   // document's the same way (Void for a supplier payment; a posted bill stays, journal_is_purchase).
   const fromStock = isStockJournalSource(entry.source);
-  const fromDocument = isSalesJournalSource(entry.source) || isPurchaseJournalSource(entry.source);
+  // Step 20b: a shift's too (journal_is_pos): a wrong count is put right by the next count
+  const fromDocument =
+    isSalesJournalSource(entry.source) ||
+    isPurchaseJournalSource(entry.source) ||
+    isPosJournalSource(entry.source);
   const canReverse =
     canPost &&
     entry.status === 'posted' &&
@@ -214,7 +224,9 @@ export function EntryView({
     entry.source !== 'year_close' &&
     !fromStock &&
     !fromDocument;
-  const documentLink = documentLinkOf(entry);
+  // A shift's page needs pos.shift.manage (decision 26): without it the number stays plain text
+  const documentLink =
+    entry.source === 'pos_shift' && !can('pos.shift.manage') ? null : documentLinkOf(entry);
   const failure = failureOf(post.error);
   const amount = (value: string) =>
     value === '0.0000' ? '' : format.money(value, { decimals: 2 });
@@ -275,13 +287,18 @@ export function EntryView({
             {t('journal.reversedBy', { number: entry.reversedBy.number })}
           </Link>
         )}
-        {documentLink && (
+        {documentLink ? (
           <Link
             {...documentLink}
             className="font-medium text-brand underline-offset-3 hover:underline"
           >
             {t('journal.fromDocument', { document: entry.document?.number ?? '' })}
           </Link>
+        ) : (
+          entry.source === 'pos_shift' &&
+          entry.document && (
+            <span>{t('journal.fromDocument', { document: entry.document.number })}</span>
+          )
         )}
       </div>
       {fromStock && <p className="text-label text-ink-3">{t('journal.stockEntryHint')}</p>}
@@ -311,6 +328,9 @@ export function EntryView({
       {entry.source === 'purchase_refund' && (
         <p className="text-label text-ink-3">{t('journal.supplierRefundEntryHint')}</p>
       )}
+      {entry.source === 'pos_shift' && (
+        <p className="text-label text-ink-3">{t('journal.posShiftEntryHint')}</p>
+      )}
       {entry.narration && <p className="text-body text-ink">{entry.narration}</p>}
       {/* A plain table in its own scroll box: four columns, a handful of rows, a totals row */}
       <Card className="overflow-x-auto">
```

- **`ShiftFact`:** a sale's shift, a link only with `pos.shift.manage` (decision 96). A sale made before this update
  has none: a dash.
- **The journal's Reverse is hidden for `pos_shift`** (`isPosJournalSource`), like a sales document's: the server
  refuses it (`journal_is_pos`), and the hint under the header says how a mistake is put right.
- **"From POS1-S0042" is a link only for the people who can open the shift** (decision 95); for everyone else it is
  the same words as plain text, so the reader still knows where the entry came from.

### `components/sync-parts.tsx`, `components/notification-bell.tsx`, `components/sales-parts.tsx`

```diff
@@ -72,7 +72,8 @@ export function useFieldList(): (fields: readonly string[]) => string {
 }
 
 // The two lines of an entry: what it is ("Changes to Rahman Traders") and how big ("Changed:
-// Phone and Credit limit", "3 lines · ৳4,140"). A POS sale's name is its number (pos.ts in sync).
+// Phone and Credit limit", "3 lines · ৳4,140"). A POS sale's name is its number (pos.ts in sync),
+// a shift's too (shift.ts).
 export function useCommandText(): (entry: OutboxEntry) => { title: string; detail: string } {
   const { t, format } = useLocale();
   const fieldList = useFieldList();
@@ -102,6 +103,14 @@ export function useCommandText(): (entry: OutboxEntry) => { title: string; detai
               total: format.money(entry.total ?? '0'),
             }),
           };
+        // Step 20b: the title says it all. A shift's name is its number ("Shift POS1-S0042
+        // opened"); a movement's is the toast's sentence ("৳10,000 paid out for Bank deposit"). The
+        // counts stay off this page: the close is blind, and the drawer's money is not the device
+        // user's to read here.
+        case 'pos_shift.open':
+        case 'pos_shift.close':
+        case 'pos_cash_movement.create':
+          return { title, detail: '' };
       }
     },
     [t, format, fieldList],
```

```diff
@@ -4,6 +4,7 @@ import {
   DEFAULT_SETTINGS,
   isApprovalDocument,
   isExportFormat,
+  isMoneyAmount,
   isNotificationType,
   isOutputDocument,
   isReportKind,
@@ -21,6 +22,7 @@ import { useState } from 'react';
 import { call } from '../lib/api';
 import { notificationsQuery, settingsQuery, unreadCountQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
+import { differenceWords } from './pos-shift-parts';
 
 // The notifications that open their own document (useOpenDocument below): step 16's failed email,
 // and step 17a's approvals (a requisition waiting for you, yours approved or sent back)
@@ -49,6 +51,9 @@ const TARGET = {
   'stock.low': '/stock/reorder',
   // Step 20a: the list that has every line a counter sold short, the one to act on (decision 30)
   'pos.sold_short': '/stock/sold-short',
+  // Step 20b: the list, for an old notification without the shift's id; one with it opens the
+  // shift (shiftOf below)
+  'pos.shift_variance': '/pos/shifts',
 } as const satisfies Record<Exclude<NotificationType, DocumentNotificationType>, string>;
 
 // A document's page from the notification's kind and id. The list of that kind when the id is
@@ -111,6 +116,14 @@ function useOpenDocument(): (params: NotificationParams) => Promise<void> {
   };
 }
 
+// Step 20b (decision 29): the variance bell opens its shift. Its id is the shift's.
+function shiftOf(notification: Notification): string | null {
+  const { id } = notification.params;
+  return notification.type === 'pos.shift_variance' && typeof id === 'string' && id !== ''
+    ? id
+    : null;
+}
+
 // The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
 // number no longer changes what you do
 function badgeText(count: number): string {
@@ -120,11 +133,16 @@ function badgeText(count: number): string {
 // An export's report and format arrive as keys (trial_balance, xlsx): their words go into the text.
 // A key this app does not know (a newer server) stays as it is.
 function useWords() {
-  const { t } = useLocale();
+  const { t, format: locale } = useLocale();
   return (params: NotificationParams): NotificationParams => {
-    const { report, format, document: kind } = params;
+    const { report, format, document: kind, difference } = params;
     return {
       ...params,
+      // Step 20b (decision 66): the variance bell's signed difference becomes "৳520 short"
+      ...(typeof difference === 'string' &&
+        isMoneyAmount(difference.replace(/^-/, '')) && {
+          difference: differenceWords(t, locale, difference),
+        }),
       // Step 16: a document's kind (invoice) becomes its name; step 17a: a requisition's too
       ...(typeof kind === 'string' &&
         isOutputDocument(kind) && { document: t(`documentOutput.kinds.${kind}`) }),
@@ -268,8 +286,11 @@ export function NotificationBell() {
                 onOpen={() => {
                   if (notification.readAt === null) markRead.mutate(notification.id);
                   setOpen(false);
+                  const shiftId = shiftOf(notification);
                   if (opensDocument(notification.type)) {
                     void openDocument(notification.params);
+                  } else if (shiftId !== null) {
+                    void navigate({ to: '/pos/shifts/$shiftId', params: { shiftId } });
                   } else {
                     void navigate({ to: TARGET[notification.type] });
                   }
```

```diff
@@ -51,7 +51,8 @@ export function SalesBackLink({
     | '/sales-returns'
     | '/credit-notes'
     | '/refunds'
-    | '/pos/sales';
+    | '/pos/sales'
+    | '/pos/shifts';
   label: string;
 }) {
   return (
```

- **The Sync page's switch** has a case for each new command, so it is exhaustive again (a missing case returned
  `undefined`, which the type check caught). No detail line for them (decision 94).
- **The variance bell opens its shift** (decision 29). `TARGET` still needs the kind (it is
  `satisfies Record<…>`), and the list is the place for an old notification without an id. `shiftOf()` reads the id
  only for this kind.
- **The difference becomes words before the sentence is filled** (`useWords`): "POS1-S0042 on Front counter closed
  ৳520 short". `isMoneyAmount()` checks the number first, so a strange value from a newer server stays as it is.
- **`SalesBackLink`** takes `/pos/shifts`.

### `apps/app/src/router.tsx` and `routes/app-shell.tsx`

These two files changed in 20b.6a too (the sign-out and `/pos?close=true`); their diffs are shown once, here.

```diff
@@ -655,6 +655,10 @@ const syncRoute = createRoute({
 const posRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/pos',
+  // Step 20b: ?close=true opens the shift's close at once (the sign-out's "Close shift")
+  validateSearch: (search: Record<string, unknown>): { close?: true } => ({
+    ...(search.close === true && { close: true }),
+  }),
   component: lazyRouteComponent(() => import('./routes/pos'), 'PosPage'),
 });
 
@@ -679,6 +683,26 @@ const posSaleRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/pos-sale'), 'PosSalePage'),
 });
 
+// Step 20b: the managers' shifts (pos.shift.manage) and the pay in / pay out reasons (a workspace
+// setting, next to the registers). In the shell too: only '/pos' itself is bare.
+const posShiftsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/shifts',
+  component: lazyRouteComponent(() => import('./routes/pos-shifts'), 'PosShiftsPage'),
+});
+
+const posShiftRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/shifts/$shiftId',
+  component: lazyRouteComponent(() => import('./routes/pos-shift'), 'PosShiftPage'),
+});
+
+const posCashReasonsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/pos/cash-reasons',
+  component: lazyRouteComponent(() => import('./routes/pos-cash-reasons'), 'PosCashReasonsPage'),
+});
+
 const soldShortRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/stock/sold-short',
@@ -1004,6 +1028,9 @@ const routeTree = rootRoute.addChildren([
     posRegistersRoute,
     posSalesRoute,
     posSaleRoute,
+    posShiftsRoute,
+    posShiftRoute,
+    posCashReasonsRoute,
     soldShortRoute,
     myDevicesRoute,
     devicesRoute,
```

```diff
@@ -28,6 +28,7 @@ import {
   LockKeyIcon,
   Logout01Icon,
   MoneyExchange01Icon,
+  MoneyExchange03Icon,
   MoneyReceive02Icon,
   MoneyReceiveCircleIcon,
   MoneySend02Icon,
@@ -61,6 +62,7 @@ import {
   UserGroup03Icon,
   UserGroupIcon,
   UserMultiple02Icon,
+  UserTime01Icon,
   WarehouseIcon,
   Wifi01Icon,
   WifiDisconnected02Icon,
@@ -107,6 +109,10 @@ import { useOnline } from '../lib/use-online';
 const SignOutDialog = lazy(async () => ({
   default: (await import('../components/sign-out-dialog')).SignOutDialog,
 }));
+// Step 20b: "Close the shift first", from the same chunk
+const ShiftOpenDialog = lazy(async () => ({
+  default: (await import('../components/sign-out-dialog')).ShiftOpenDialog,
+}));
 // Step 19a: Safari's how-to, the same way: opened once per device at most
 const InstallDialog = lazy(async () => ({
   default: (await import('../components/install-dialog')).InstallDialog,
@@ -340,11 +346,15 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
   const can = useCan();
   // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
   const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
-  // Step 18b: sign out at once with nothing on the device, else ask
-  const { waiting: unsynced } = useSyncSummary();
+  // Step 18b: sign out at once with nothing on the device, else ask. Step 20b (decision 6): an
+  // open POS shift comes first: it is closed before anything else.
+  const { waiting: unsynced, openShift } = useSyncSummary();
   const [asking, setAsking] = useState(false);
+  const [shiftOpen, setShiftOpen] = useState(false);
+  const navigate = useNavigate();
   const signOut = () => {
-    if (unsynced > 0) setAsking(true);
+    if (openShift !== null) setShiftOpen(true);
+    else if (unsynced > 0) setAsking(true);
     else void logout();
   };
   // Step 19a (decision 20): Chrome's own prompt, or the dialog with Safari's steps
@@ -443,6 +453,13 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
             <NavLink to="/pos/sales" icon={ReceiptDollarIcon}>
               {t('nav.posSales')}
             </NavLink>
+            {/* Step 20b (decision 26): the shifts show how short a drawer was, so only for the
+                people who look after the counters */}
+            {can('pos.shift.manage') && (
+              <NavLink to="/pos/shifts" icon={UserTime01Icon}>
+                {t('nav.posShifts')}
+              </NavLink>
+            )}
             <NavLink to="/quotations" icon={Note01Icon}>
               {t('nav.quotations')}
             </NavLink>
@@ -605,6 +622,10 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
             <NavLink to="/pos/registers" icon={Cashier02Icon}>
               {t('nav.registers')}
             </NavLink>
+            {/* Step 20b (decision 67): next to the registers, read by everyone like them */}
+            <NavLink to="/pos/cash-reasons" icon={MoneyExchange03Icon}>
+              {t('nav.cashReasons')}
+            </NavLink>
             <NavLink to="/branches" icon={Store01Icon}>
               {t('nav.branches')}
             </NavLink>
@@ -671,6 +692,19 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
           />
         </Suspense>
       )}
+      {shiftOpen && openShift !== null && (
+        <Suspense fallback={null}>
+          <ShiftOpenDialog
+            number={openShift}
+            onClose={() => {
+              setShiftOpen(false);
+            }}
+            onCloseShift={() => {
+              void navigate({ to: '/pos', search: { close: true } });
+            }}
+          />
+        </Suspense>
+      )}
       {installHelp && (
         <Suspense fallback={null}>
           <InstallDialog
```

- **`/pos` reads `?close=true`** (20b.6a, decision 81): `validateSearch` keeps only `true`, so any other value is
  dropped, and `navigate({ to: '/pos', search: { close: true } })` type checks.
- **Three new routes under the app route:** only `/pos` itself is bare, so the shifts and the reasons keep the sidebar.
- **The shell's sign-out** (20b.6a, decision 81): an open shift comes before the count of changes waiting, and "Close
  shift" goes to `/pos?close=true`. `ShiftOpenDialog` loads from the same lazy chunk as the sign-out dialog.
- **POS shifts in the Sales group, after POS sales, only with `pos.shift.manage`** (decision 26). Hiding it is a
  convenience; the server refuses the list without the permission anyway.
- **POS cash reasons in the Workspace group, after POS registers, for everyone** (decision 67), read-only without
  `pos.register.manage`, like the registers.

### The new word

`posShifts.allStatuses` ("All shifts" / "সব শিফট") is in the `en.ts` and `bn.ts` diffs of 20b.5 (decision 90).

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm exec eslint apps/app/src/routes/pos-*.tsx apps/app/src/routes/app-shell.tsx apps/app/src/router.tsx \
  apps/app/src/components/pos-shift*.tsx apps/app/src/components/notification-bell.tsx \
  apps/app/src/components/sync-parts.tsx apps/app/src/components/journal-entry-view.tsx apps/app/src/lib/pos-queries.ts
pnpm exec prettier --check apps/app/src packages/i18n/src
pnpm --filter @omnivo/app exec vite build && pnpm --filter @omnivo/app test:bundle-size
```

All pass: 15 i18n tests, 195 app unit tests, and the bundle check (first load 222.3 KB of 225, the shifts list
80.4 KB, a shift's page 100.9 KB, the reasons page 107.8 KB). `pnpm --filter @omnivo/app typecheck` fails only in the
two mock files, `mocks/pos-data.ts` and `mocks/push-data.ts`, which 20b.7 changes. Not checked in a browser yet: mock
mode has no shifts and no reasons until 20b.7's MSW handlers.

## 20b.7 — `apps/app`: the mock API's shifts and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). After 20b.6 the
app type checked everywhere but in two mock files, and the mock had nothing a shift needs: no reasons, no shift
commands in its push, registers without their new fields, and no routes for the two new pages. A POS sale could not
even be tested, since a register now sells only inside a shift. This part gives the mock the API's rules for all of it
on its own arrays, makes the POS tests of 20a open a shift first, and adds one test file for the shifts.

Writing these tests found two mistakes in 20b.6a's code, fixed there (so its code above is already the fixed one):
**"Sign out" right after a close asked about "0 changes"** (decision 98), and **on a phone the POS bar was wider than
the screen** once a shift was open, so the cart's bar and the dialogs' buttons could not be pressed (decision 99).

The files, in the order to write them: each one only uses files above it.

### `mocks/journal-data.ts`: a shift's entries

```diff
@@ -7,6 +7,7 @@ import {
   fiscalYearOf,
   formatDocumentNumber,
   isNegativeMoney,
+  isPosJournalSource,
   isPurchaseJournalSource,
   isSalesJournalSource,
   isStockJournalSource,
@@ -276,7 +277,9 @@ export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
   if (debits !== credits) throw new MockProblem(409, 'journal_unbalanced');
   const oldWork = entry.source === 'reversal' || entry.source === 'year_close';
   checkLines(data, entry.lines.map(asInput), {
-    allowArchived: oldWork,
+    // Step 20b (decision 44): a shift's cash was counted or moved already, so it posts to an
+    // account archived since, like the API's posting for pos_shift
+    allowArchived: oldWork || entry.source === 'pos_shift',
     // Step 17c: a bill clears "goods received not billed", like the API's allowStock. Step 17d: so
     // does a debit note, for goods that went back.
     allowStock:
@@ -330,6 +333,8 @@ export function reverseEntry(
   if (isPurchaseJournalSource(entry.source) && !allowPurchase) {
     throw new MockProblem(409, 'journal_is_purchase');
   }
+  // Step 20b: a shift's cash is put right by the next count, or a pay in or out the other way
+  if (isPosJournalSource(entry.source)) throw new MockProblem(409, 'journal_is_pos');
   if (entry.reversedBy !== null) throw new MockProblem(409, 'journal_already_reversed');
   if (date < entry.date) {
     throw new MockProblem(409, 'journal_reversal_date', { date: ['journal_reversal_date'] });
```

- **`allowArchived` for `pos_shift`:** the API's posting lets a shift's entry use an account archived since (decision
  44): the cash was counted or moved already, and refusing it would lose it.
- **Reverse refuses a shift's entry with `journal_is_pos`,** the API's rule. The journal page hides the button already
  (decision 95); this is the answer if someone calls the route anyway.

### `mocks/pos-data.ts`: the register's shift fields, a shift's cash, the sale's shift

```diff
@@ -1,16 +1,22 @@
 import {
   addMoney,
   addQuantity,
+  type CashCount,
   compareMoney,
   compareQuantity,
   type Device,
+  type EntryRef,
   type ErrorCode,
+  expectedCashOf,
   formatPosNumber,
   isZeroMoney,
   isWholeQuantity,
   moneyAccountIds,
   negateMoney,
   POS_PAYMENT_METHODS,
+  type PosCashDirection,
+  type PosCashReason,
+  type PosLastShift,
   type PosOverride,
   posChangeOf,
   posOverridesOf,
@@ -26,6 +32,8 @@ import {
   type posSaleListQuerySchema,
   type PosSalePage,
   posSaleSummarySchema,
+  type PosShiftStatus,
+  type ShiftCash,
   shiftIsoDate,
   type SoldShortItem,
   soldShortItemSchema,
@@ -61,10 +69,14 @@ import type { WorkspaceData } from './workspace-data';
 // written only by the push (push-data.ts calls createSale), like the API (decision 21). The audit
 // rows are written by the callers (handlers.ts, push-data.ts), which import workspace-data.ts:
 // this file is imported by it, for the seed.
+// Step 20b: the shifts, their pay ins and outs, and the reasons, kept here beside the registers
+// and the sales, because a register's latest shift and a sale's shift are read with them. What
+// the devices and the managers do with a shift is pos-shift-data.ts.
 
 // A register without its branch: the branch is its warehouse's, worked out when it is read, so a
-// warehouse moved to another branch takes its free registers along (the API joins warehouses)
-export type MockRegister = Omit<PosRegister, 'branchId'>;
+// warehouse moved to another branch takes its free registers along (the API joins warehouses).
+// Step 20b: and without its latest shift, which is read from the shifts (the API's lastShiftsOf).
+export type MockRegister = Omit<PosRegister, 'branchId' | 'lastShift'>;
 
 // A sale's line as the mock keeps it: the contract's line, plus what the Sold short list reads
 // (the API's short_serials column, and the lot of the batch that went below zero)
@@ -79,14 +91,66 @@ export type MockPosSale = Omit<PosSale, 'lines' | 'device'> & {
   lines: MockPosLine[];
 };
 
+// A shift as the API's pos_shifts row keeps it (step 20b). The cashier is the device's person
+// (created_by); the counts keep the device's notes and a 4-decimal total.
+export interface MockShift {
+  id: string;
+  registerId: string;
+  deviceId: string;
+  cashierId: string;
+  sequence: number;
+  number: string;
+  status: PosShiftStatus;
+  openedAt: string;
+  closedAt: string | null;
+  opening: {
+    count: CashCount;
+    date: string;
+    // null = the register's first shift
+    comparedWith: string | null;
+    floatReasonId: string | null;
+    entry: EntryRef | null;
+  };
+  // A counted close; null while open and for a close without a count
+  closing: {
+    count: CashCount;
+    date: string;
+    deviceExpected: string;
+    heldDropped: number;
+    entry: EntryRef | null;
+  } | null;
+  // What the drawer should have held at the close, either close; null while open
+  expectedCash: string | null;
+  // Who closed it without a count
+  closedBy: string | null;
+}
+
+export interface MockMovement {
+  id: string;
+  shiftId: string;
+  reasonId: string;
+  direction: PosCashDirection;
+  amount: string;
+  note: string | null;
+  date: string;
+  movedAt: string;
+  // The reason's account when it was posted
+  accountId: string;
+  entry: EntryRef;
+}
+
 export interface MockPos {
   registers: MockRegister[];
   // Newest first: a new sale is put first
   sales: MockPosSale[];
+  // Step 20b: in the order they were added; the lists sort them
+  reasons: PosCashReason[];
+  shifts: MockShift[];
+  movements: MockMovement[];
 }
 
 export function emptyPos(): MockPos {
-  return { registers: [], sales: [] };
+  return { registers: [], sales: [], reasons: [], shifts: [], movements: [] };
 }
 
 function now(): string {
@@ -102,8 +166,30 @@ function percentText(value: string): string {
 
 // --- The seed -----------------------------------------------------------------------------------
 
-function register(fields: Omit<MockRegister, 'id' | 'archivedAt' | 'version' | 'updatedAt'>) {
-  return { id: crypto.randomUUID(), ...fields, archivedAt: null, version: 1, updatedAt: now() };
+type SeedRegister = Omit<
+  MockRegister,
+  | 'id'
+  | 'archivedAt'
+  | 'version'
+  | 'updatedAt'
+  | 'overShortAccountId'
+  | 'varianceAlert'
+  | 'lockAfter'
+>;
+
+// Step 20b: every seeded counter has the over/short account, so a shift opens on it, a bell for a
+// difference over ৳500, and no idle lock: the device in the tests has no PIN until a test sets one
+function register(fields: SeedRegister, overShortAccountId: string | null): MockRegister {
+  return {
+    id: crypto.randomUUID(),
+    ...fields,
+    overShortAccountId,
+    varianceAlert: '500',
+    lockAfter: 'off',
+    archivedAt: null,
+    version: 1,
+    updatedAt: now(),
+  };
 }
 
 // The garments maker sells its export surplus at a factory outlet in the head office: the
@@ -119,65 +205,103 @@ export function seedPos(data: WorkspaceData, garments: boolean): void {
   const cash = account('1110');
   if (!main || cash === null) return;
   const card = account('1121');
+  const overShort = addOverShortAccount(data);
   if (!garments) {
     data.pos.registers.push(
-      register({
-        code: 'POS1',
-        name: 'Pharmacy counter',
-        warehouseId: main.id,
-        accounts: { cash, card, bkash: null, nagad: null },
-        maxDiscountPercent: '5.00',
-        paperWidth: '80',
-        receiptFooter: 'Medicines once sold are not taken back. Keep this receipt for your doctor.',
-        deviceId: null,
-        lastNumber: 0,
-      }),
+      register(
+        {
+          code: 'POS1',
+          name: 'Pharmacy counter',
+          warehouseId: main.id,
+          accounts: { cash, card, bkash: null, nagad: null },
+          maxDiscountPercent: '5.00',
+          paperWidth: '80',
+          receiptFooter:
+            'Medicines once sold are not taken back. Keep this receipt for your doctor.',
+          deviceId: null,
+          lastNumber: 0,
+        },
+        overShort,
+      ),
     );
     return;
   }
   const storePc = data.sync.devices.find((device) => device.name === 'Store office PC');
   const depot = byCode('CTG');
   data.pos.registers.push(
-    register({
-      code: 'POS1',
-      name: 'Showroom counter',
-      warehouseId: main.id,
-      accounts: { cash, card, bkash: null, nagad: null },
-      maxDiscountPercent: '10.00',
-      paperWidth: '80',
-      receiptFooter: 'Goods once sold are exchanged within 7 days with this receipt.',
-      deviceId: null,
-      lastNumber: 0,
-    }),
-    register({
-      code: 'POS2',
-      name: 'Factory outlet counter',
-      warehouseId: main.id,
-      accounts: { cash, card: null, bkash: null, nagad: null },
-      maxDiscountPercent: '5.00',
-      paperWidth: '58',
-      receiptFooter: null,
-      deviceId: storePc?.id ?? null,
-      lastNumber: 214,
-    }),
+    register(
+      {
+        code: 'POS1',
+        name: 'Showroom counter',
+        warehouseId: main.id,
+        accounts: { cash, card, bkash: null, nagad: null },
+        maxDiscountPercent: '10.00',
+        paperWidth: '80',
+        receiptFooter: 'Goods once sold are exchanged within 7 days with this receipt.',
+        deviceId: null,
+        lastNumber: 0,
+      },
+      overShort,
+    ),
+    register(
+      {
+        code: 'POS2',
+        name: 'Factory outlet counter',
+        warehouseId: main.id,
+        accounts: { cash, card: null, bkash: null, nagad: null },
+        maxDiscountPercent: '5.00',
+        paperWidth: '58',
+        receiptFooter: null,
+        deviceId: storePc?.id ?? null,
+        lastNumber: 214,
+      },
+      overShort,
+    ),
   );
   if (depot) {
     data.pos.registers.push(
-      register({
-        code: 'CTG1',
-        name: 'Depot counter',
-        warehouseId: depot.id,
-        accounts: { cash, card: null, bkash: null, nagad: null },
-        maxDiscountPercent: '0.00',
-        paperWidth: '80',
-        receiptFooter: null,
-        deviceId: null,
-        lastNumber: 1260,
-      }),
+      register(
+        {
+          code: 'CTG1',
+          name: 'Depot counter',
+          warehouseId: depot.id,
+          accounts: { cash, card: null, bkash: null, nagad: null },
+          maxDiscountPercent: '0.00',
+          paperWidth: '80',
+          receiptFooter: null,
+          deviceId: null,
+          lastNumber: 1260,
+        },
+        overShort,
+      ),
     );
   }
 }
 
+// Step 20b: the account a counter's cash difference goes to. Not in the chart template (the API's
+// garments and pharma templates have none, and the sign-up's setup counts the template's
+// accounts): the company added it under its selling expenses when it set up its counters.
+function addOverShortAccount(data: WorkspaceData): string | null {
+  const parent = data.accounts.find((row) => row.code === '5300');
+  if (!parent) return null;
+  const id = crypto.randomUUID();
+  data.accounts.push({
+    id,
+    parentId: parent.id,
+    code: '5340',
+    name: 'Cash over and short',
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
@@ -188,7 +312,63 @@ function branchOfRegister(data: WorkspaceData, stored: MockRegister): string {
 }
 
 export function toRegister(data: WorkspaceData, stored: MockRegister): PosRegister {
-  return { ...stored, branchId: branchOfRegister(data, stored) };
+  return {
+    ...stored,
+    branchId: branchOfRegister(data, stored),
+    lastShift: lastShiftOf(data, stored.id),
+  };
+}
+
+// --- A shift's cash (step 20b) ------------------------------------------------------------------
+
+// The API's pos_shift_cash(): the opening count, the cash the shift's sales took and the change
+// they gave, its pay ins and pay outs, read from the rows now. A sale that arrives after a close
+// without a count is counted too (decision 63).
+export function shiftCash(data: WorkspaceData, shift: MockShift): ShiftCash & { expected: string } {
+  const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
+  const moved = (direction: PosCashDirection) =>
+    sumMoney(
+      data.pos.movements
+        .filter((movement) => movement.shiftId === shift.id && movement.direction === direction)
+        .map((movement) => movement.amount),
+    );
+  const cash: ShiftCash = {
+    opening: addMoney(shift.opening.count.total, '0'),
+    cashTaken: sumMoney(
+      sales.flatMap((sale) =>
+        sale.payments
+          .filter((payment) => payment.method === 'cash')
+          .map((payment) => payment.amount),
+      ),
+    ),
+    changeGiven: sumMoney(sales.map((sale) => sale.change)),
+    paidIn: moved('in'),
+    paidOut: moved('out'),
+  };
+  return { ...cash, expected: expectedCashOf(cash) };
+}
+
+// The register's latest shift, by the highest number (the API's lastShiftsOf). cashLeft: the
+// count at the close, or, when nobody counted, what the server expects now.
+export function lastShiftOf(data: WorkspaceData, registerId: string): PosLastShift | null {
+  const last = data.pos.shifts
+    .filter((shift) => shift.registerId === registerId)
+    .reduce<MockShift | null>(
+      (latest, shift) => (latest === null || shift.sequence > latest.sequence ? shift : latest),
+      null,
+    );
+  if (last === null) return null;
+  return {
+    id: last.id,
+    sequence: last.sequence,
+    status: last.status,
+    cashLeft:
+      last.status === 'open'
+        ? null
+        : last.status === 'closed'
+          ? (last.closing?.count.total ?? null)
+          : shiftCash(data, last).expected,
+  };
 }
 
 export function findRegister(data: WorkspaceData, id: string): MockRegister {
@@ -233,13 +413,17 @@ export function registerSnapshot(
     maxDiscountPercent: stored.maxDiscountPercent,
     paperWidth: stored.paperWidth,
     receiptFooter: stored.receiptFooter,
+    overShortAccount: codeOf(data.accounts, stored.overShortAccountId),
+    varianceAlert: stored.varianceAlert,
+    lockAfter: stored.lockAfter,
   };
 }
 
 type RegisterFields = Omit<PosRegisterInput, 'code'>;
 
 // The API's create() and update() checks, all but the code: an active warehouse when it is new or
-// changed, a held register kept in its device's branch, and every account a money account
+// changed, a held register kept in its device's branch, every account a money account, and (step
+// 20b) an over/short account that is an active income or expense account, not a group
 function checkFields(data: WorkspaceData, fields: RegisterFields, before?: MockRegister): void {
   if (before?.warehouseId !== fields.warehouseId) {
     const place = data.stock.warehouses.find(
@@ -264,6 +448,15 @@ function checkFields(data: WorkspaceData, fields: RegisterFields, before?: MockR
       ),
     );
   }
+  const overShort = data.accounts.find((account) => account.id === fields.overShortAccountId);
+  if (
+    !overShort ||
+    overShort.isGroup ||
+    overShort.archivedAt !== null ||
+    (overShort.type !== 'income' && overShort.type !== 'expense')
+  ) {
+    throw fieldProblem('pos_over_short_invalid', 'overShortAccountId');
+  }
 }
 
 function formOf(fields: RegisterFields) {
@@ -274,6 +467,9 @@ function formOf(fields: RegisterFields) {
     maxDiscountPercent: percentText(fields.maxDiscountPercent),
     paperWidth: fields.paperWidth,
     receiptFooter: fields.receiptFooter,
+    overShortAccountId: fields.overShortAccountId,
+    varianceAlert: fields.varianceAlert,
+    lockAfter: fields.lockAfter,
   };
 }
 
@@ -347,16 +543,25 @@ export function claimRegister(data: WorkspaceData, target: MockRegister, device:
 }
 
 // A free register answers as it is (a release sent again); one another device holds is not this
-// device's to free. Returns whether it was let go now.
-export function releaseRegister(target: MockRegister, device: Device): boolean {
+// device's to free. Step 20b: not while a shift is open on it (the sign-out stops here). Returns
+// whether it was let go now.
+export function releaseRegister(
+  data: WorkspaceData,
+  target: MockRegister,
+  device: Device,
+): boolean {
   if (target.deviceId === null) return false;
   if (target.deviceId !== device.id) throw new MockProblem(409, 'pos_register_not_held');
+  if (lastShiftOf(data, target.id)?.status === 'open') {
+    throw new MockProblem(409, 'pos_shift_still_open');
+  }
   Object.assign(target, { deviceId: null, updatedAt: now() });
   return true;
 }
 
 // Migration 0052's triggers: revoking a device, or moving it to another branch, frees the register
-// it holds. No audit row (decision 51).
+// it holds. No audit row (decision 51). Step 20b: a revoke closes the device's open shift first
+// (pos-shift-data.ts), and a move is refused while one is open.
 export function releaseHeldBy(data: WorkspaceData, deviceId: string): void {
   for (const item of data.pos.registers) {
     if (item.deviceId === deviceId) Object.assign(item, { deviceId: null, updatedAt: now() });
@@ -373,13 +578,20 @@ export function assertNoHeldRegister(data: WorkspaceData, warehouseId: string):
   }
 }
 
-// An account a register or a POS payment names stays (the API's foreign keys, account_in_use)
+// An account a register or a POS payment names stays (the API's foreign keys, account_in_use).
+// Step 20b: also a register's over/short account, a reason's, and a pay in or out's.
 export function usedByPos(data: WorkspaceData, accountId: string): boolean {
   return (
-    data.pos.registers.some((item) =>
-      POS_PAYMENT_METHODS.some((method) => item.accounts[method] === accountId),
+    data.pos.registers.some(
+      (item) =>
+        item.overShortAccountId === accountId ||
+        POS_PAYMENT_METHODS.some((method) => item.accounts[method] === accountId),
     ) ||
-    data.pos.sales.some((sale) => sale.payments.some((payment) => payment.accountId === accountId))
+    data.pos.sales.some((sale) =>
+      sale.payments.some((payment) => payment.accountId === accountId),
+    ) ||
+    data.pos.reasons.some((reason) => reason.accountId === accountId) ||
+    data.pos.movements.some((movement) => movement.accountId === accountId)
   );
 }
 
@@ -523,6 +735,10 @@ export function createSale(
   if (target?.deviceId !== deviceId) throw fieldProblem('pos_register_not_held', 'registerId');
   const register = toRegister(data, target);
   const number = formatPosNumber(register.code, input.sequence);
+  // Step 20b: the shift it was sold in, this device's on this register (the API's deviceShift()).
+  // A closed one too: a late sale still counts in its cash (decision 63).
+  const shift =
+    input.shiftId === null ? null : deviceShift(data, input.shiftId, deviceId, register.id);
 
   // Decision 34: the register's account for each method now
   const missing = input.payments.flatMap((payment, index) =>
@@ -586,11 +802,7 @@ export function createSale(
   );
   const paid = sumMoney(input.payments.map((payment) => payment.amount));
   const change = posChangeOf(input.payments, amounts.totals.total);
-  // Decision 26: the device's day, unless its clock is ahead of today or the day is locked
-  const today = todayIn(data.settings.timezone);
-  const soldOn = input.date > today ? today : input.date;
-  const { lockDate } = data.journal;
-  const date = lockDate !== null && soldOn <= lockDate ? shiftIsoDate(lockDate, 1) : soldOn;
+  const date = bookingDay(data, input.date);
 
   const lines = resolved.map(({ line }, index) => {
     const sent = input.lines[index];
@@ -696,6 +908,7 @@ export function createSale(
     id: saleId,
     number,
     register: { id: register.id, code: register.code, name: register.name },
+    shift: shift && { id: shift.id, number: shift.number },
     branchId,
     warehouseId: register.warehouseId,
     date,
@@ -754,6 +967,33 @@ export function createSale(
   };
 }
 
+// Decision 26, for every POS command (step 20b: a shift's open, pay ins and outs, close too): the
+// device's day, unless its clock is ahead of today or the day is locked (the API's bookingDay())
+export function bookingDay(data: WorkspaceData, deviceDate: string): string {
+  const today = todayIn(data.settings.timezone);
+  const day = deviceDate > today ? today : deviceDate;
+  const { lockDate } = data.journal;
+  return lockDate !== null && day <= lockDate ? shiftIsoDate(lockDate, 1) : day;
+}
+
+// The device's own shift (the API's deviceShift()): one of another device or another register is
+// the same answer as one the server does not have, a bug on the device either way
+export function deviceShift(
+  data: WorkspaceData,
+  shiftId: string,
+  deviceId: string,
+  registerId?: string,
+): MockShift {
+  const found = data.pos.shifts.find((shift) => shift.id === shiftId);
+  if (
+    found?.deviceId !== deviceId ||
+    (registerId !== undefined && found.registerId !== registerId)
+  ) {
+    throw fieldProblem('pos_shift_unknown', 'shiftId');
+  }
+  return found;
+}
+
 // Decision 37: a refused sale's receipt was printed, so its number is used too. Only up, without a
 // version, like the API's keepNumber().
 export function keepNumber(data: WorkspaceData, input: { registerId: string; sequence: number }) {
```

- **`MockRegister` leaves out `lastShift`:** like the branch, it is read when the register is read (`toRegister()` calls
  `lastShiftOf()`), the way the API's `lastShiftsOf()` reads it and never stores it. Stored, it would go stale with
  every open and close.
- **`MockShift` and `MockMovement` are the API's rows**, shortened: the opening and the closing as two objects, the
  cashier as the device's person, `expectedCash` set by either close.
- **`shiftCash()` is the database's `pos_shift_cash()`:** the opening count, the cash the shift's sales took, their
  change (`paid − total`, kept on the sale as `change`), and the pay ins and outs, from the rows now. A sale that
  arrives after a close without a count is counted too (decision 63).
- **`lastShiftOf()`: the highest number, not the newest time:** two devices' clocks may disagree, the numbers never do.
  Its `cashLeft` is the count for a counted close, the expected cash now for a close without a count, `null` while
  open.
- **`addOverShortAccount()` adds 5340 "Cash over and short" under selling expenses** before the counters are seeded,
  as the company would have when it set them up (decision 101). Not in the chart template: the mock's sign-up builds
  a new workspace's chart from it, and the setup wizard's "50 accounts" is the API's template count.
- **The seed's `register()` takes the over/short account** and sets the bell at ৳500 and the lock off for every counter
  (decision 101).
- **`checkFields()` checks the over/short account** like the API's `checkOverShort()`: active, not a group, income or
  expense. The form sends '' for "not picked", which the contract refuses first (`pos_over_short_required`).
- **`releaseRegister()` refuses `pos_shift_still_open`** while the register's latest shift is open (decision 32). It
  takes `data` now, to read the shifts.
- **`usedByPos()`** also keeps a register's over/short account, a reason's account and a movement's account from being
  deleted: the API's three new foreign keys.
- **`bookingDay()` is taken out of `createSale()`:** a shift's open, its movements and its close book on the same day
  rule (decision 26), like the API's `booking-day.ts`.
- **`deviceShift()`** is the API's: a shift of another device, or of another register for a sale, is the same answer
  as one the server does not have (`pos_shift_unknown`, a bug either way). A closed shift is still the device's: a late
  sale counts in its cash.

### `mocks/pos-shift-data.ts` (new): the reasons, the three commands, the managers' shifts

```ts
import {
  absMoney,
  addMoney,
  type CashCount,
  cashDifferenceOf,
  compareMoney,
  type EntryRef,
  formatShiftNumber,
  isOverVarianceAlert,
  isPartyAccountPurpose,
  isZeroMoney,
  POS_PAYMENT_METHODS,
  type PosCashMovementInput,
  type PosCashReason,
  type PosCashReasonInput,
  type posCashReasonListQuerySchema,
  type PosShift,
  type PosShiftCloseInput,
  type posShiftListQuerySchema,
  type PosShiftOpenInput,
  type PosShiftPage,
  type PosShiftSummary,
  subtractMoney,
  sumMoney,
  todayIn,
  type UpdatePosCashReasonInput,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { codeOf } from './accounting-data';
import { OWNER } from './fixtures';
import { postNew, stockAccountIds } from './journal-data';
import { MockProblem } from './mock';
import {
  bookingDay,
  deviceShift,
  type MockMovement,
  type MockRegister,
  type MockShift,
  shiftCash,
  toRegister,
} from './pos-data';
import { fieldProblem, pageOf } from './sales-document-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 20b: the pay in and pay out reasons, and the shifts the devices push. The API's
// pos-cash-reasons.service.ts and pos-shifts.service.ts on plain arrays, shortened. The rows live
// in data.pos beside the registers and the sales (pos-data.ts), which read a register's latest
// shift and a sale's shift from them. Like pos-data.ts, this file writes no audit rows: its
// callers (handlers.ts, push-data.ts, device-data.ts) do, since workspace-data.ts imports this
// file for the seed and record() lives there.

function now(): string {
  return new Date().toISOString();
}

// A count as the API stores and answers it: the device's notes, and the total with 2 decimals
// (numeric with 4, the last two zeros cut: the API's countTotal())
function storedCount(count: CashCount): CashCount {
  return { notes: count.notes, total: addMoney(count.total, '0').replace(/(\.\d{2})00$/, '$1') };
}

function personName(data: WorkspaceData, userId: string): string {
  if (userId === OWNER.id) return OWNER.fullName;
  return data.people.members.find((member) => member.userId === userId)?.fullName ?? '';
}

// --- The seed -----------------------------------------------------------------------------------

function reason(
  data: WorkspaceData,
  name: string,
  direction: PosCashReason['direction'],
  code: string,
  archived = false,
): PosCashReason | null {
  const account = data.accounts.find((item) => item.code === code);
  if (!account) return null;
  const created: PosCashReason = {
    id: crypto.randomUUID(),
    name,
    direction,
    accountId: account.id,
    archivedAt: archived ? now() : null,
    version: archived ? 2 : 1,
    updatedAt: now(),
  };
  data.pos.reasons.push(created);
  return created;
}

// The reasons a shop's counter uses: the owner's float and change from the bank in; the day's
// cash to the bank and tea for the staff out (an expense). Staff lunch was given up, so it is
// archived. The pharma distributor keeps two. Then the outlet's counter (POS2), held by the store
// office PC, has a shift open since this morning: Abdul Karim's, with ৳5,000 from the owner. It
// lets the shifts list show an open shift, and a manager close it without a count. The seed posts
// no entries, like CTG1's 1,260 receipts that have no sales: the books stay what other tests count
// on. After seedPos().
export function seedPosShifts(data: WorkspaceData, garments: boolean): void {
  const float = reason(data, 'Float from the owner', 'in', '3100');
  if (garments) reason(data, 'Change from the bank', 'in', '1121');
  reason(data, 'Cash to the bank', 'out', '1121');
  if (!garments) return;
  reason(data, 'Tea for the staff', 'out', '5290');
  reason(data, 'Staff lunch', 'out', '5290', true);

  const outlet = data.pos.registers.find((item) => item.code === 'POS2');
  const holder = data.sync.devices.find((device) => device.id === outlet?.deviceId);
  if (!outlet || !holder) return;
  const openedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  data.pos.shifts.push({
    id: crypto.randomUUID(),
    registerId: outlet.id,
    deviceId: holder.id,
    cashierId: holder.userId,
    sequence: 1,
    number: formatShiftNumber(outlet.code, 1),
    status: 'open',
    openedAt,
    closedAt: null,
    opening: {
      count: storedCount({
        notes: {
          '1000': 3,
          '500': 2,
          '200': 5,
          '100': 0,
          '50': 0,
          '20': 0,
          '10': 0,
          '5': 0,
          '2': 0,
          '1': 0,
        },
        total: '5000',
      }),
      date: todayIn(data.settings.timezone),
      comparedWith: null,
      floatReasonId: float?.id ?? null,
      entry: null,
    },
    closing: null,
    expectedCash: null,
    closedBy: null,
  });
}

// --- Reasons (Settings → POS cash reasons) ------------------------------------------------------

export function findCashReason(data: WorkspaceData, id: string): PosCashReason {
  const found = data.pos.reasons.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// In and out apart, then by name, as the page and the cashier's select show them
export function listCashReasons(
  data: WorkspaceData,
  query: z.output<typeof posCashReasonListQuerySchema>,
): PosCashReason[] {
  return data.pos.reasons
    .filter((item) => (item.archivedAt === null) === (query.status === 'active'))
    .toSorted(
      (a, b) =>
        a.direction.localeCompare(b.direction) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
}

// What the audit log shows: the account by its code
export function reasonSnapshot(
  data: WorkspaceData,
  item: PosCashReason,
): Record<string, string | null> {
  return {
    name: item.name,
    direction: item.direction,
    account: codeOf(data.accounts, item.accountId),
  };
}

// The API's checkAccount(): active, not a group, not one kept per party, not a stock account
function checkReasonAccount(data: WorkspaceData, accountId: string): void {
  const account = data.accounts.find((item) => item.id === accountId);
  if (
    !account ||
    account.isGroup ||
    account.archivedAt !== null ||
    isPartyAccountPurpose(account.purpose) ||
    stockAccountIds(data).has(accountId)
  ) {
    throw fieldProblem('pos_reason_account_invalid', 'accountId');
  }
}

// One name per workspace, archived ones too (pos_cash_reasons_tenant_name_idx)
function checkName(data: WorkspaceData, name: string, id?: string): void {
  if (
    data.pos.reasons.some(
      (item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw fieldProblem('pos_reason_name_taken', 'name');
  }
}

export function createCashReason(data: WorkspaceData, input: PosCashReasonInput): PosCashReason {
  checkReasonAccount(data, input.accountId);
  checkName(data, input.name);
  const created: PosCashReason = {
    id: crypto.randomUUID(),
    name: input.name,
    direction: input.direction,
    accountId: input.accountId,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
  data.pos.reasons.push(created);
  return created;
}

// The name and the account; the direction never changes. Only a new account must be usable: an
// archived reason keeps an account archived since.
export function updateCashReason(
  data: WorkspaceData,
  target: PosCashReason,
  input: Omit<UpdatePosCashReasonInput, 'version'>,
): void {
  if (input.accountId !== target.accountId) checkReasonAccount(data, input.accountId);
  checkName(data, input.name, target.id);
  Object.assign(target, {
    name: input.name,
    accountId: input.accountId,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// A reason comes back only with a usable account
export function setReasonArchived(
  data: WorkspaceData,
  target: PosCashReason,
  archived: boolean,
): void {
  if ((target.archivedAt !== null) === archived) return;
  if (!archived) checkReasonAccount(data, target.accountId);
  Object.assign(target, {
    archivedAt: archived ? now() : null,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// --- The books ----------------------------------------------------------------------------------

interface ShiftDocument {
  id: string;
  number: string;
  date: string;
  branchId: string;
}

// One entry of two lines with the branch of the register's warehouse, the journal source
// pos_shift pointing at the shift. null for nothing.
function postMove(
  data: WorkspaceData,
  document: ShiftDocument,
  move: { debit: string; credit: string; amount: string },
  narration: string,
): EntryRef | null {
  if (isZeroMoney(move.amount)) return null;
  const line = { branchId: document.branchId, partyId: null, description: null };
  const entry = postNew(
    data,
    {
      date: document.date,
      narration,
      lines: [
        { ...line, accountId: move.debit, debit: move.amount, credit: '0' },
        { ...line, accountId: move.credit, debit: '0', credit: move.amount },
      ],
    },
    'pos_shift',
    { id: document.id, number: document.number },
  );
  return { id: entry.id, number: entry.number ?? '' };
}

// Over (above zero) comes in from over/short to the register's cash, short the other way
function postDifference(
  data: WorkspaceData,
  document: ShiftDocument,
  register: MockRegister,
  difference: string,
  narration: string,
): EntryRef | null {
  if (isZeroMoney(difference)) return null;
  const overShort = register.overShortAccountId;
  // A register from 20a opens no shift without it (decision 13): only a bug gets here
  if (overShort === null) throw new MockProblem(409, 'pos_over_short_required');
  const amount = absMoney(difference);
  return postMove(
    data,
    document,
    compareMoney(difference, '0') > 0
      ? { debit: register.accounts.cash, credit: overShort, amount }
      : { debit: overShort, credit: register.accounts.cash, amount },
    narration,
  );
}

function registerOf(data: WorkspaceData, shift: MockShift): MockRegister {
  const found = data.pos.registers.find((item) => item.id === shift.registerId);
  if (!found) throw new Error(`POS register ${shift.registerId} of a shift is missing`);
  return found;
}

function latestShift(data: WorkspaceData, registerId: string): MockShift | undefined {
  return data.pos.shifts
    .filter((shift) => shift.registerId === registerId)
    .toSorted((a, b) => b.sequence - a.sequence)[0];
}

// --- From the device (push-data.ts, inside its transaction) -------------------------------------

// The API's openFromDevice(): the opening count compared with what the last shift left (the
// difference to over/short), or a first shift's float from its "in" reason's account
export function openShift(
  data: WorkspaceData,
  device: { id: string; userId: string },
  shiftId: string,
  input: PosShiftOpenInput,
): { shift: MockShift; floatReason: string | null } {
  const register = data.pos.registers.find((item) => item.id === input.registerId);
  if (register?.deviceId !== device.id) throw fieldProblem('pos_register_not_held', 'registerId');
  const number = formatShiftNumber(register.code, input.sequence);
  const last = latestShift(data, register.id);
  if (last?.status === 'open') throw new MockProblem(409, 'pos_shift_already_open');
  // What should be in the drawer: the last count, or what the server expects now (decision 63)
  const comparedWith =
    last === undefined
      ? null
      : last.status === 'closed_without_count'
        ? shiftCash(data, last).expected
        : addMoney(last.closing?.count.total ?? '0', '0');
  if (data.pos.shifts.some((shift) => shift.id === shiftId)) {
    throw new MockProblem(409, 'sync_id_taken');
  }
  if (data.pos.shifts.some((shift) => shift.number === number)) {
    throw fieldProblem('pos_number_taken', 'sequence');
  }

  const date = bookingDay(data, input.date);
  const opening = input.opening.total;
  const document = { id: shiftId, number, date, branchId: toRegister(data, register).branchId };
  let floatReason: PosCashReason | null = null;
  let entry: EntryRef | null;
  if (comparedWith !== null) {
    entry = postDifference(
      data,
      document,
      register,
      cashDifferenceOf(opening, comparedWith),
      `POS shift ${number}: opening count`,
    );
  } else if (input.floatReasonId !== null) {
    floatReason = data.pos.reasons.find((item) => item.id === input.floatReasonId) ?? null;
    if (floatReason?.direction !== 'in') {
      throw fieldProblem('pos_float_reason_required', 'floatReasonId');
    }
    entry = postMove(
      data,
      document,
      { debit: register.accounts.cash, credit: floatReason.accountId, amount: opening },
      `POS shift ${number}: float, ${floatReason.name}`,
    );
  } else {
    // A first shift without a reason: only a bug gets here, and over/short takes the money
    entry = postDifference(data, document, register, opening, `POS shift ${number}: opening count`);
  }

  const shift: MockShift = {
    id: shiftId,
    registerId: register.id,
    deviceId: device.id,
    cashierId: device.userId,
    sequence: input.sequence,
    number,
    status: 'open',
    openedAt: input.openedAt,
    closedAt: null,
    opening: {
      count: storedCount(input.opening),
      date,
      comparedWith,
      floatReasonId: floatReason?.id ?? null,
      entry,
    },
    closing: null,
    expectedCash: null,
    closedBy: null,
  };
  data.pos.shifts.push(shift);
  return { shift, floatReason: floatReason?.name ?? null };
}

// The API's moveCashFromDevice(): Dr cash / Cr the reason's account, or the other way. Also for a
// shift closed since (the money moved), and with a reason archived since.
export function moveCash(
  data: WorkspaceData,
  deviceId: string,
  movementId: string,
  input: PosCashMovementInput,
): { shift: MockShift; movement: MockMovement; reason: PosCashReason } {
  const shift = deviceShift(data, input.shiftId, deviceId);
  const found = data.pos.reasons.find((item) => item.id === input.reasonId);
  if (!found) throw fieldProblem('pos_reason_required', 'reasonId');
  if (data.pos.movements.some((movement) => movement.id === movementId)) {
    throw new MockProblem(409, 'sync_id_taken');
  }
  const register = registerOf(data, shift);
  const date = bookingDay(data, input.date);
  const cash = register.accounts.cash;
  const entry = postMove(
    data,
    { id: shift.id, number: shift.number, date, branchId: toRegister(data, register).branchId },
    found.direction === 'in'
      ? { debit: cash, credit: found.accountId, amount: input.amount }
      : { debit: found.accountId, credit: cash, amount: input.amount },
    `POS shift ${shift.number}: pay ${found.direction}, ${found.name}`,
  );
  if (entry === null) throw new Error('A pay in or pay out above zero posted nothing');
  const movement: MockMovement = {
    id: movementId,
    shiftId: shift.id,
    reasonId: found.id,
    direction: found.direction,
    amount: addMoney(input.amount, '0'),
    note: input.note,
    date,
    movedAt: input.movedAt,
    accountId: found.accountId,
    entry,
  };
  data.pos.movements.push(movement);
  return { shift, movement, reason: found };
}

export type CloseResult =
  // Decision 38: closed without a count before this arrived; the count goes to the audit log only
  | { kept: false; shift: MockShift; statusBefore: MockShift['status'] }
  | {
      kept: true;
      shift: MockShift;
      expected: string;
      difference: string;
      date: string;
      entry: EntryRef | null;
    };

// The API's closeFromDevice(): the expected cash worked out again from the mock's rows, the
// difference to over/short, and the bell over the register's limit (last: nothing after it throws)
export function closeShift(
  data: WorkspaceData,
  deviceId: string,
  shiftId: string,
  input: PosShiftCloseInput,
): CloseResult {
  const shift = data.pos.shifts.find((item) => item.id === shiftId);
  if (shift?.deviceId !== deviceId) throw fieldProblem('pos_shift_unknown', 'shiftId');
  if (shift.status !== 'open') return { kept: false, shift, statusBefore: shift.status };

  const register = registerOf(data, shift);
  const { expected } = shiftCash(data, shift);
  const counted = input.counted.total;
  const difference = cashDifferenceOf(counted, expected);
  const date = bookingDay(data, input.date);
  const entry = postDifference(
    data,
    { id: shift.id, number: shift.number, date, branchId: toRegister(data, register).branchId },
    register,
    difference,
    `POS shift ${shift.number}: closing count`,
  );
  Object.assign(shift, {
    status: 'closed',
    closedAt: input.closedAt,
    closing: {
      count: storedCount(input.counted),
      date,
      deviceExpected: input.deviceExpected,
      heldDropped: input.heldDropped,
      entry,
    },
    expectedCash: expected,
  } satisfies Partial<MockShift>);

  // Decision 5: the managers hear about a big difference. The mock's person is the owner, who is
  // always one of them.
  if (isOverVarianceAlert(difference, register.varianceAlert)) {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'pos.shift_variance',
      params: { id: shift.id, number: shift.number, register: register.name, difference },
      readAt: null,
      createdAt: now(),
    });
  }
  return { kept: true, shift, expected, difference, date, entry };
}

// --- For the managers (pos.shift.manage) --------------------------------------------------------

export function findShift(data: WorkspaceData, id: string): MockShift {
  const found = data.pos.shifts.find((shift) => shift.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// A list row. A counted shift shows what the drawer should have held at its close; an open one,
// and one closed without a count, what it should hold now (late sales count, decision 63).
function toSummary(data: WorkspaceData, shift: MockShift): PosShiftSummary {
  const register = toRegister(data, registerOf(data, shift));
  const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
  const counted = shift.closing === null ? null : addMoney(shift.closing.count.total, '0');
  return {
    id: shift.id,
    number: shift.number,
    register: { id: register.id, code: register.code, name: register.name },
    branchId: register.branchId,
    sequence: shift.sequence,
    status: shift.status,
    cashier: { id: shift.cashierId, fullName: personName(data, shift.cashierId) },
    device: {
      id: shift.deviceId,
      name: data.sync.devices.find((device) => device.id === shift.deviceId)?.name ?? '',
    },
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    openingCash: shift.opening.count.total,
    expectedCash:
      shift.status === 'closed' && shift.expectedCash !== null
        ? shift.expectedCash
        : shiftCash(data, shift).expected,
    countedCash: shift.closing?.count.total ?? null,
    difference:
      counted === null || shift.expectedCash === null
        ? null
        : cashDifferenceOf(counted, shift.expectedCash),
    saleCount: sales.length,
    salesTotal: sumMoney(sales.map((sale) => sale.total)),
  };
}

// Newest first by the device's clock, then by id, like the API's cursor
export function listShifts(
  data: WorkspaceData,
  query: z.output<typeof posShiftListQuerySchema>,
): PosShiftPage {
  const matching = data.pos.shifts
    .filter(
      (shift) =>
        (query.registerId === undefined || shift.registerId === query.registerId) &&
        (query.status === undefined || shift.status === query.status),
    )
    .toSorted((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id));
  const page = pageOf(matching, query);
  return { ...page, items: page.items.map((shift) => toSummary(data, shift)) };
}

// One shift with everything its page shows
export function toShift(data: WorkspaceData, shift: MockShift): PosShift {
  const register = registerOf(data, shift);
  const cash = shiftCash(data, shift);
  const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
  // What the sales took by each method: every method the register takes now, and any other one
  // a sale of the shift was paid with, cash first
  const payments = POS_PAYMENT_METHODS.flatMap((method) => {
    const amounts = sales.flatMap((sale) =>
      sale.payments.filter((payment) => payment.method === method).map((payment) => payment.amount),
    );
    if (amounts.length === 0 && register.accounts[method] === null) return [];
    return [{ method, amount: sumMoney(amounts) }];
  });
  const floatReason = data.pos.reasons.find((item) => item.id === shift.opening.floatReasonId);
  const { opening } = shift;
  return {
    ...toSummary(data, shift),
    opening: {
      count: opening.count,
      date: opening.date,
      comparedWith: opening.comparedWith,
      difference:
        opening.comparedWith === null
          ? null
          : subtractMoney(addMoney(opening.count.total, '0'), opening.comparedWith),
      floatReason: floatReason ? { id: floatReason.id, name: floatReason.name } : null,
      entry: opening.entry,
    },
    closing: shift.status === 'closed' ? shift.closing : null,
    closedBy:
      shift.closedBy === null
        ? null
        : { id: shift.closedBy, fullName: personName(data, shift.closedBy) },
    cash: {
      opening: cash.opening,
      cashTaken: cash.cashTaken,
      changeGiven: cash.changeGiven,
      paidIn: cash.paidIn,
      paidOut: cash.paidOut,
    },
    payments,
    movements: data.pos.movements
      .filter((movement) => movement.shiftId === shift.id)
      .toSorted((a, b) => a.movedAt.localeCompare(b.movedAt) || a.id.localeCompare(b.id))
      .map((movement) => ({
        id: movement.id,
        reason: {
          id: movement.reasonId,
          name: data.pos.reasons.find((item) => item.id === movement.reasonId)?.name ?? '',
        },
        direction: movement.direction,
        amount: movement.amount,
        note: movement.note,
        date: movement.date,
        movedAt: movement.movedAt,
        accountId: movement.accountId,
        entry: movement.entry,
      })),
  };
}

// Decision 11: nobody counted, so nothing posts. The expected cash now is kept; the next shift's
// opening count is compared with it and finds what is missing. Returns it, for the audit row.
export function closeWithoutCount(
  data: WorkspaceData,
  shift: MockShift,
  closedBy: string,
  closedAt = now(),
): string {
  if (shift.status !== 'open') throw new MockProblem(409, 'pos_shift_closed');
  const { expected } = shiftCash(data, shift);
  Object.assign(shift, {
    status: 'closed_without_count',
    closedAt,
    closedBy,
    expectedCash: expected,
  } satisfies Partial<MockShift>);
  return expected;
}

// --- Devices (device-data.ts) -------------------------------------------------------------------

// The device's open shift, if any: it keeps its register and its branch until the shift closes
export function openShiftOf(data: WorkspaceData, deviceId: string): MockShift | undefined {
  return data.pos.shifts.find((shift) => shift.deviceId === deviceId && shift.status === 'open');
}
```

**Why a new file:** `pos-data.ts` is over 1,000 lines with this part's changes, and the shift's commands, its list and its page are their own
subject. It imports `pos-data.ts`; `pos-data.ts` imports nothing from it, so there is no import circle (decision 100).

- **`storedCount()`:** the API stores a count with 4 decimals and answers it with 2 (`countTotal()`), so a count of
  "5000" comes back as "5000.00" in the mock too.
- **The seed (decision 101):** the reasons by the accounts' codes, and POS2's open shift, a first shift with its float
  from the owner. Its notes add up to its total (3 × ৳1,000, 2 × ৳500, 5 × ৳200): the reply's schema checks it, and a
  wrong seed would answer the shift's page with a 500.
- **The reasons' rules are the API's:** the account is active, not a group, not a party's account, not a stock account
  (`checkReasonAccount()`); a name is taken by an archived reason too; only a new account is checked on a change; a
  reason comes back only with a usable account.
- **`postMove()` and `postDifference()`** post the API's two-line entries with the source `pos_shift` and the shift as
  the document, through `postNew()`, so the lock date and the account rules are the journal's own.
- **`openShift()` follows `openFromDevice()` in order:** the holder, an open shift on the register
  (`pos_shift_already_open`), what to compare with (the last count, or the expected cash now for a close without a
  count), a device id or a number taken, then the entry: the difference, or a first shift's float from an "in" reason
  (`pos_float_reason_required` otherwise), or, with no reason, the whole count to over/short (a bug path).
- **`moveCash()`** posts to a shift closed since and with a reason archived since (decision 40): the money moved. The
  direction is the reason's, never the device's.
- **`closeShift()` never refuses a counted close of a closed shift** (decision 38): it answers `kept: false`, and the
  caller writes the count to the audit log only. The bell is the last thing it does, like a sale's: nothing after it
  can throw, so a refused close rings nothing.
- **`toSummary()`'s expected cash:** at the close for a counted shift, now for the others (decision 63), like the API's
  list.
- **`toShift()`'s payments:** every method the register takes now, plus any other one a sale of the shift was paid with,
  in the contract's order. A method with no payment shows ৳0, not nothing.
- **`closeWithoutCount()` returns the expected cash** for the audit row, and takes the moment: a revoke passes its own.

### `mocks/workspace-data.ts`: the seed

```diff
@@ -42,6 +42,7 @@ import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
 import { emptyPos, type MockPos, seedPos } from './pos-data';
+import { seedPosShifts } from './pos-shift-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import { seedPurchaseOrders } from './purchase-order-data';
 import type { MockExport } from './report-data';
@@ -217,6 +218,8 @@ function seed(workspace: Workspace): WorkspaceData {
   if (garments) seedDevices(data);
   // Step 20a: after the devices and the stock: a counter is held by one of them, in a warehouse
   seedPos(data, garments);
+  // Step 20b: after the counters and the accounts: a shift is open on one of them
+  seedPosShifts(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -309,7 +312,8 @@ export function transaction<T>(data: WorkspaceData, fn: () => T): T {
     // Step 17b: a goods receipt moves its order's received quantities and takes a number. Step
     // 17c: a bill makes a goods receipt and marks receipt lines billed; a payment pays bills.
     purchase: data.purchase,
-    // Step 20a: a POS sale moves stock, posts an entry and writes the sale; a refused one none
+    // Step 20a: a POS sale moves stock, posts an entry and writes the sale; a refused one none.
+    // Step 20b: the shifts and their pay ins and outs are in it too.
     pos: data.pos,
     audit: data.audit,
   });
```

- **`seedPosShifts()` after `seedPos()`:** a shift needs its register, and its device from `seedDevices()`.
- **`transaction()` copies `data.pos` already** (step 20a), and the shifts, movements and reasons are in it now, so a
  refused command leaves no shift, movement or moved reason behind.

### `mocks/sync-data.ts`: the pull

```diff
@@ -13,6 +13,7 @@ import {
   type SyncCommandType,
   type SyncEntity,
   type SyncNotice,
+  syncPosCashReasonSchema,
   syncPosRegisterSchema,
   type SyncPull,
   syncSettingsSchema,
@@ -22,6 +23,7 @@ import {
 
 import { OWNER } from './fixtures';
 import { MockProblem } from './mock';
+import { lastShiftOf } from './pos-data';
 // Type-only: workspace-data.ts imports this file for emptySync(), and a type import is erased
 // when the code is built, so it makes no circle
 import type { WorkspaceData } from './workspace-data';
@@ -299,7 +301,8 @@ function rowsOf(data: WorkspaceData, tenantId: string, branchId: string): SyncUp
     })),
     // Step 20a: the active registers of the branch, by their warehouse's branch (an archived
     // warehouse keeps its register, like the API's loader). The parse leaves out the last number:
-    // it moves with every sale, and the device counts its own.
+    // it moves with every sale, and the device counts its own. Step 20b: with the latest shift,
+    // so a shift's open or close (anyone's) sends the register again.
     ...data.pos.registers.flatMap((register) => {
       const place = stock.warehouses.find((warehouse) => warehouse.id === register.warehouseId);
       if (register.archivedAt !== null || place?.branchId !== branchId) return [];
@@ -308,10 +311,28 @@ function rowsOf(data: WorkspaceData, tenantId: string, branchId: string): SyncUp
           op: 'upsert' as const,
           entity: 'pos_register' as const,
           key: register.id,
-          data: syncPosRegisterSchema.parse({ ...register, branchId }),
+          data: syncPosRegisterSchema.parse({
+            ...register,
+            branchId,
+            lastShift: lastShiftOf(data, register.id),
+          }),
         },
       ];
     }),
+    // Step 20b: the active pay in and pay out reasons, every one (a reason has no branch). An
+    // archived one is a delete, as for every row that leaves what the device keeps.
+    ...data.pos.reasons.flatMap((reason) =>
+      reason.archivedAt === null
+        ? [
+            {
+              op: 'upsert' as const,
+              entity: 'pos_cash_reason' as const,
+              key: reason.id,
+              data: syncPosCashReasonSchema.parse(reason),
+            },
+          ]
+        : [],
+    ),
     ...sales.priceLists.map((list) => ({
       op: 'upsert' as const,
       entity: 'price_list' as const,
```

- **Each register with its latest shift** (decision 102): the device numbers its next shift after it, and compares its
  first count with its `cashLeft` (decision 17).
- **The active reasons, every one:** a reason has no branch. An archived one is not sent, so the mock's pull sends a
  delete for it, as for every row that leaves what the device keeps.

### `mocks/push-data.ts`: the three commands

```diff
@@ -2,6 +2,7 @@ import {
   ADDRESS_KINDS,
   type AddressKind,
   type AuditEntry,
+  compareMoney,
   contractErrorMap,
   type CustomerAddressChanges,
   type CustomerChanges,
@@ -27,6 +28,7 @@ import type { z } from 'zod';
 
 import { MockProblem } from './mock';
 import { createSale, keepNumber, overrideText } from './pos-data';
+import { closeShift, moveCash, openShift } from './pos-shift-data';
 import { type MockCustomer, refreshPartyRefs, saveCustomer } from './sales-data';
 import { createOrder } from './sales-document-data';
 import { copyToSupplier } from './supplier-data';
@@ -38,7 +40,8 @@ import { diff, record, transaction, type WorkspaceData } from './workspace-data'
 // does not stop the ones after it. Each answer is kept by the command's id (MockSync.answers), so
 // a batch sent again after a lost answer changes nothing twice. The mock's person is the owner,
 // who has every permission, so the per-command permission check (decision 17) is left out.
-// Step 20a: a POS sale (pos-data.ts's createSale) is posted when it arrives.
+// Step 20a: a POS sale (pos-data.ts's createSale) is posted when it arrives. Step 20b: so are a
+// shift's open, its pay ins and outs, and its close (pos-shift-data.ts).
 
 type PushInput = z.output<typeof syncPushInputSchema>;
 type PushedCommand = PushInput['commands'][number];
@@ -51,18 +54,17 @@ export function push(data: WorkspaceData, userId: string, input: PushInput): Syn
   // The protocol first, like the pull: an old app is told to reload before anything else
   if (input.protocol !== SYNC_PROTOCOL) throw new MockProblem(409, 'sync_protocol_mismatch');
   const device = deviceFor(data, userId, input.deviceId);
-  const from = { id: device.id, name: device.name };
+  const from = { id: device.id, name: device.name, userId };
   return {
     results: input.commands.map((pushed) => run(data, from, pushed)),
     serverTime: new Date().toISOString(),
   };
 }
 
-function run(
-  data: WorkspaceData,
-  device: NonNullable<AuditEntry['device']>,
-  pushed: PushedCommand,
-): SyncResult {
+// The device the commands came from, as the audit rows name it, and its person (a shift's cashier)
+type From = NonNullable<AuditEntry['device']> & { userId: string };
+
+function run(data: WorkspaceData, device: From, pushed: PushedCommand): SyncResult {
   // A command the mock cannot read is refused alone and keeps no answer (decision 24). The app's
   // forms check the same schemas, so only a bug gets here: the paths are the command's own, not
   // the form's (the API's decision 22 is not repeated here).
@@ -108,12 +110,18 @@ function run(
 
 function entityOf(command: SyncCommand): string {
   switch (command.type) {
+    case 'customer.create':
+    case 'customer.update':
+      return command.customerId;
     case 'sales_order.create_draft':
       return command.orderId;
     case 'pos_sale.create':
       return command.saleId;
-    default:
-      return command.customerId;
+    case 'pos_shift.open':
+    case 'pos_shift.close':
+      return command.shiftId;
+    case 'pos_cash_movement.create':
+      return command.movementId;
   }
 }
 
@@ -123,14 +131,15 @@ function refused(id: string, error: SyncCommandError): SyncResult {
 
 // An accepted answer brings the customer as it is now, also when it is sent again (decision 18):
 // an old answer never puts an older row back on the device. Archived since: a delete, like in a
-// delta pull. An order and a POS sale bring nothing: they are not on the device.
+// delta pull. An order, a POS sale and a shift's command bring nothing: they are not on the device
+// as rows (the register's latest shift comes with the next pull).
 function answerOf(data: WorkspaceData, id: string, answer: MockAnswer): SyncResult {
   if (answer.status === 'rejected') return refused(id, answer.error);
   return { id, status: 'accepted', notices: answer.notices, changes: changesOf(data, answer) };
 }
 
 function changesOf(data: WorkspaceData, answer: MockAnswer): SyncChange[] {
-  if (answer.type === 'sales_order.create_draft' || answer.type === 'pos_sale.create') return [];
+  if (answer.type !== 'customer.create' && answer.type !== 'customer.update') return [];
   const found = data.sales.customers.find((item) => item.id === answer.entityId);
   // Not found (undefined), or archived
   if (found?.archivedAt !== null) {
@@ -141,11 +150,8 @@ function changesOf(data: WorkspaceData, answer: MockAnswer): SyncChange[] {
 
 // --- The commands -------------------------------------------------------------------------------
 
-function apply(
-  data: WorkspaceData,
-  device: NonNullable<AuditEntry['device']>,
-  command: SyncCommand,
-): SyncNotice[] {
+function apply(data: WorkspaceData, from: From, command: SyncCommand): SyncNotice[] {
+  const device = { id: from.id, name: from.name };
   switch (command.type) {
     case 'customer.create': {
       assertIdsFree(data, [command.customerId], command.input.addresses);
@@ -248,6 +254,118 @@ function apply(
       }
       return [];
     }
+    // Step 20b: the audit rows are the API's. The mock's person is the owner, who has
+    // pos.sale.create, so pos_shift.without_permission is never written.
+    case 'pos_shift.open': {
+      const { shift, floatReason } = openShift(data, from, command.shiftId, command.input);
+      record(
+        data,
+        'pos_shift.opened',
+        'pos_shift',
+        shift.id,
+        diff(
+          {},
+          {
+            number: shift.number,
+            date: shift.opening.date,
+            openedOn: command.input.date,
+            opening: command.input.opening.total,
+            comparedWith: shift.opening.comparedWith,
+            floatReason,
+            entry: shift.opening.entry?.number ?? null,
+          },
+        ),
+        device,
+      );
+      return [];
+    }
+    case 'pos_cash_movement.create': {
+      const { shift, movement, reason } = moveCash(
+        data,
+        device.id,
+        command.movementId,
+        command.input,
+      );
+      record(
+        data,
+        'pos_shift.cash_moved',
+        'pos_shift',
+        shift.id,
+        diff(
+          {},
+          {
+            reason: reason.name,
+            direction: movement.direction,
+            amount: command.input.amount,
+            note: movement.note,
+            date: movement.date,
+            entry: movement.entry.number,
+            shiftStatus: shift.status,
+          },
+        ),
+        device,
+      );
+      return [];
+    }
+    case 'pos_shift.close': {
+      const { input } = command;
+      const closed = closeShift(data, device.id, command.shiftId, input);
+      const { shift } = closed;
+      if (!closed.kept) {
+        // Decision 38: never a refusal, the cashier did count
+        record(
+          data,
+          'pos_shift.closed',
+          'pos_shift',
+          shift.id,
+          diff(
+            {},
+            {
+              number: shift.number,
+              counted: input.counted.total,
+              deviceExpected: input.deviceExpected,
+              closedOn: input.date,
+              kept: false,
+              statusBefore: closed.statusBefore,
+            },
+          ),
+          device,
+        );
+        return [];
+      }
+      record(
+        data,
+        'pos_shift.closed',
+        'pos_shift',
+        shift.id,
+        diff(
+          {},
+          {
+            number: shift.number,
+            date: closed.date,
+            closedOn: input.date,
+            counted: input.counted.total,
+            expected: closed.expected,
+            difference: closed.difference,
+            heldDropped: input.heldDropped,
+            entry: closed.entry?.number ?? null,
+          },
+        ),
+        device,
+      );
+      // Decision 22: the books keep the server's number
+      if (compareMoney(input.deviceExpected, closed.expected) !== 0) {
+        record(
+          data,
+          'pos_shift.expected_differs',
+          'pos_shift',
+          shift.id,
+          diff({}, { device: input.deviceExpected, server: closed.expected }),
+          device,
+        );
+      }
+      return [];
+    }
   }
 }
 
```

- **`From` carries the person:** a shift's cashier is the device's person (the API's `created_by`).
- **`entityOf()` names every command:** with a `case` for each type and no `default`, a fourth POS command added later
  is a type error here, not a customer by mistake (the type error 20b.1 left in this file).
- **`changesOf()` answers rows only for a customer's command:** an order, a sale and a shift's command are not on the
  device as rows.
- **The audit rows are the API's** (`pos_shift.opened`, `pos_shift.cash_moved`, `pos_shift.closed`, and
  `pos_shift.expected_differs` when the device's expected cash is not the server's). The mock's person is the owner,
  who has `pos.sale.create`, so `pos_shift.without_permission` is never written.

### `mocks/device-data.ts`: a revoke closes the shift, a move waits for it

```diff
@@ -12,6 +12,7 @@ import type { z } from 'zod';
 import { OWNER } from './fixtures';
 import { MockProblem } from './mock';
 import { releaseHeldBy } from './pos-data';
+import { closeWithoutCount, openShiftOf } from './pos-shift-data';
 import { checkVersion, diff, record, type WorkspaceData } from './workspace-data';
 
 // The mock's step 18c (decisions 1–4): the two device lists, rename, move and revoke. The devices
@@ -145,6 +146,8 @@ export function moveDevice(
     throw new MockProblem(409, 'device_branch_invalid', { branchId: ['device_branch_invalid'] });
   }
   if (device.branchId !== branch.id) {
+    // Step 20b (decision 32): a device that runs a shift stays where its register is
+    if (openShiftOf(data, id)) throw new MockProblem(409, 'pos_shift_still_open');
     const before = data.branches.find((candidate) => candidate.id === device.branchId);
     record(
       data,
@@ -174,6 +177,19 @@ export function revokeDevice(
   const revokedAt = now();
   Object.assign(device, { revokedAt, version: device.version + 1 });
   data.sync.revokedBy.set(id, OWNER.id);
+  // Step 20b (decision 11): its open shift closes without a count first, by the person who
+  // revoked it, at the revoke's moment (the API's database does it in the revoke's update)
+  const open = openShiftOf(data, id);
+  if (open) {
+    const expected = closeWithoutCount(data, open, OWNER.id, revokedAt);
+    record(
+      data,
+      'pos_shift.closed_without_count',
+      'pos_shift',
+      open.id,
+      diff({}, { number: open.number, expected, by: 'revoke', device: device.name }),
+    );
+  }
   // Step 20a: a lost or broken PC is revoked, and its counter is free for the next one
   releaseHeldBy(data, id);
   record(data, 'device.revoked', 'device', id, { revokedAt: { from: null, to: revokedAt } });
```

- **A move is refused while a shift is open** (`pos_shift_still_open`, decision 32): the device's register stays in its
  branch.
- **A revoke closes the device's open shift without a count first,** by the person who revoked it and at the revoke's
  moment, then frees the register: the API's database does both in the revoke's update (decision 11). Revoking the
  Store office PC on the Devices page now closes POS2-S0001.

### `mocks/handlers.ts`: the routes

```diff
@@ -329,6 +329,18 @@ import {
   updateRegister,
   usedByPos,
 } from './pos-data';
+import {
+  closeWithoutCount,
+  createCashReason,
+  findCashReason,
+  findShift,
+  listCashReasons,
+  listShifts,
+  reasonSnapshot,
+  setReasonArchived,
+  toShift,
+  updateCashReason,
+} from './pos-shift-data';
 import { push } from './push-data';
 import { deviceFor, deviceKey, pull, registerDevice } from './sync-data';
 import {
@@ -5208,7 +5220,7 @@ export const handlers = [
       const data = current();
       const device = deviceFor(data, OWNER.id, deviceId);
       const target = findRegister(data, id);
-      if (releaseRegister(target, device)) {
+      if (releaseRegister(data, target, device)) {
         record(data, 'pos_register.released', 'pos_register', id, {
           device: { from: device.name, to: null },
         });
@@ -5238,4 +5250,118 @@ export const handlers = [
     await delay();
     return reply(routes.pos.soldShort, soldShortList(current(), query));
   }),
+
+  // Step 20b: the pay in and pay out reasons (pos-shift-data.ts). Reading needs no permission,
+  // like the API; the mock's owner has pos.register.manage.
+  mock(routes.posShifts.listCashReasons, async ({ request }) => {
+    const query = readQuery(routes.posShifts.listCashReasons.query, request);
+    await delay();
+    return reply(routes.posShifts.listCashReasons, {
+      items: listCashReasons(current(), query),
+    });
+  }),
+
+  mock(
+    routes.posShifts.createCashReason,
+    guarded(async ({ request }) => {
+      const input = await readBody(routes.posShifts.createCashReason.body, request);
+      const data = current();
+      const created = createCashReason(data, input);
+      record(
+        data,
+        'pos_cash_reason.created',
+        'pos_cash_reason',
+        created.id,
+        diff({}, reasonSnapshot(data, created)),
+      );
+      await delay();
+      return reply(routes.posShifts.createCashReason, created);
+    }),
+  ),
+
+  mock(
+    routes.posShifts.updateCashReason,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.posShifts.updateCashReason.params.parse(params);
+      const { version, ...input } = await readBody(routes.posShifts.updateCashReason.body, request);
+      const data = current();
+      const target = findCashReason(data, id);
+      checkVersion(target.version, version);
+      const before = reasonSnapshot(data, target);
+      updateCashReason(data, target, input);
+      record(
+        data,
+        'pos_cash_reason.updated',
+        'pos_cash_reason',
+        id,
+        diff(before, reasonSnapshot(data, target)),
+      );
+      await delay();
+      return reply(routes.posShifts.updateCashReason, target);
+    }),
+  ),
+
+  ...(['archiveCashReason', 'restoreCashReason'] as const).map((action) =>
+    mock(
+      routes.posShifts[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.posShifts[action].params.parse(params);
+        const { version } = await readBody(routes.posShifts[action].body, request);
+        const data = current();
+        const target = findCashReason(data, id);
+        checkVersion(target.version, version);
+        const archived = action === 'archiveCashReason';
+        const changes = (target.archivedAt !== null) !== archived;
+        setReasonArchived(data, target, archived);
+        if (changes) {
+          record(
+            data,
+            archived ? 'pos_cash_reason.archived' : 'pos_cash_reason.restored',
+            'pos_cash_reason',
+            id,
+          );
+        }
+        return reply(routes.posShifts[action], target);
+      }),
+    ),
+  ),
+
+  // The shifts the devices pushed (push-data.ts writes them). The mock's owner has
+  // pos.shift.manage.
+  mock(routes.posShifts.listShifts, async ({ request }) => {
+    const query = readQuery(routes.posShifts.listShifts.query, request);
+    await delay();
+    return reply(routes.posShifts.listShifts, listShifts(current(), query));
+  }),
+
+  mock(
+    routes.posShifts.getShift,
+    guarded(({ params }) => {
+      const { id } = routes.posShifts.getShift.params.parse(params);
+      const data = current();
+      return reply(routes.posShifts.getShift, toShift(data, findShift(data, id)));
+    }),
+  ),
+
+  // Decision 11: a stuck shift, closed online. A close from its device that arrives later finds it
+  // closed, and its count goes to the audit log only (push-data.ts).
+  mock(
+    routes.posShifts.closeWithoutCount,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.posShifts.closeWithoutCount.params.parse(params);
+      const { note } = await readBody(routes.posShifts.closeWithoutCount.body, request);
+      const data = current();
+      const target = findShift(data, id);
+      const expected = closeWithoutCount(data, target, OWNER.id);
+      record(
+        data,
+        'pos_shift.closed_without_count',
+        'pos_shift',
+        id,
+        diff({}, { number: target.number, expected, note, by: 'manager' }),
+      );
+      await delay();
+      return reply(routes.posShifts.closeWithoutCount, toShift(data, target));
+    }),
+  ),
 ];
```

- **Eight handlers, in the contract's order,** at the end of the list. Reading the reasons needs no permission; the
  mock's person is the owner, who has `pos.register.manage` and `pos.shift.manage`.
- **The archive and restore handler is one, for both routes,** like the registers'; it writes the audit row only when the
  state changed.
- **"Close without a count" writes the API's audit row** (`by: 'manager'`, with the note). A close that arrives from the
  device after it finds the shift closed (push-data.ts).
- **The release passes `data`:** `releaseRegister()` reads the shifts now.

### `mocks/offline-screens.ts`: the shift offline

```diff
@@ -31,6 +31,11 @@ const SCREENS = [
   () => import('../routes/pos'),
   () => import('../components/pos-pay'),
   () => import('../components/pos-receipt'),
+  // Step 20b: the shift works offline too: the open card, pay in and out, the close and its
+  // result (one chunk), the held bills, and the top bar's shift menu
+  () => import('../components/pos-shift'),
+  () => import('../components/pos-held'),
+  () => import('../components/pos-shift-menu'),
 ];
 
 // Once, by main.tsx's enableMocking. The dev server is on this computer, so it does not fail.
```

- **The open card, the dialogs, the held bills and the shift menu:** each is a chunk that loads the first time it is
  needed, and the tests go offline after the screen is open. Without them in this list, mock mode could not load them
  offline (step 19a's decision 11).

### `e2e/pos.e2e.ts`: a shift before the first sale

```diff
@@ -18,6 +18,9 @@ import {
 //
 // The receipt prints with window.print(), which would open the browser's print dialog: each test
 // replaces it with a counter on <body> before the app starts, and reads the counter.
+//
+// Step 20b: a register sells only inside a shift. POS1 never had one, so its first shift asks
+// where the cash in the drawer came from; the shift's own tests are in pos-shifts.e2e.ts.
 
 test.beforeEach(async ({ page }) => {
   await page.addInitScript(() => {
@@ -42,12 +45,22 @@ async function openPos(page: Page): Promise<void> {
   await page.getByRole('navigation').getByRole('link', { name: 'POS', exact: true }).click();
 }
 
-// The register chooser, once per device (decision 14)
+// The register chooser, once per device (decision 14). Step 20b: then the shift's open card.
 async function takeRegister(page: Page, label: string, toast: string): Promise<void> {
   await expect(page.getByRole('heading', { name: 'Which counter is this?' })).toBeVisible();
   await page.getByLabel('Register').selectOption({ label });
   await page.getByRole('button', { name: 'Use this register' }).click();
   await toastShown(page, toast);
+  await expect(page.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
+}
+
+// POS1's first shift: ৳2,000 in the drawer, from the owner
+async function openFirstShift(page: Page): Promise<void> {
+  await page.getByText('As a total').click();
+  await page.getByLabel('Cash in the drawer').fill('2000');
+  await page.getByLabel('Brought in as').selectOption({ label: 'Float from the owner' });
+  await page.getByRole('button', { name: 'Open shift' }).click();
+  await toastShown(page, 'Shift POS1-S0001 is open');
   await expect(page.getByRole('searchbox', { name: 'Scan or search' })).toBeFocused();
 }
 
@@ -81,6 +94,7 @@ test('takes a register, sells for cash and prints the receipt', async ({ page },
     'POS1 · Showroom counter',
     'This device is POS1 now. The next receipt is POS1-000001.',
   );
+  await openFirstShift(page);
 
   // A scanner types the barcode and Enter; the box empties for the next scan
   const search = page.getByRole('searchbox', { name: 'Scan or search' });
@@ -137,7 +151,9 @@ test('sells offline, and lists the serial number that was not in the store', asy
     'POS1 · Showroom counter',
     'This device is POS1 now. The next receipt is POS1-000001.',
   );
+  // The shift's open waits in the outbox too: it goes before the sale (step 20b)
   await page.context().setOffline(true);
+  await openFirstShift(page);
 
   // The sewing machine has no price: the cashier types one (not an override). Its line opens at
   // once for the serial numbers; 0199 is not in the main store, so the server lets it leave
@@ -168,7 +184,7 @@ test('sells offline, and lists the serial number that was not in the store', asy
   await expectPrinted(page, 1);
   await done.getByRole('button', { name: 'New sale' }).click();
   await expect(
-    page.getByRole('link', { name: 'Sync: Offline, 1 change waiting', exact: true }),
+    page.getByRole('link', { name: 'Sync: Offline, 2 changes waiting', exact: true }),
   ).toBeVisible();
   // The sale is not in the copy's stock yet, but the screen counts it: 1 machine is left, so the
   // last one cannot be sold twice
@@ -234,6 +250,14 @@ test('adds a register, and keeps a held one from being archived', async ({ page
   await dialog.getByLabel('Name').fill('Export surplus counter');
   await dialog.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
   await dialog.getByLabel('Cash', { exact: true }).selectOption({ label: '1110 · Cash in hand' });
+  // Step 20b: required, also when the form is otherwise done
+  await dialog.getByRole('button', { name: 'Add register' }).click();
+  await expect(
+    dialog.getByText(/^Pick the account a difference in the drawer goes to/),
+  ).toBeVisible();
+  await dialog
+    .getByLabel('Cash over and short account')
+    .selectOption({ label: '5340 · Cash over and short' });
   await dialog.getByRole('button', { name: 'Add register' }).click();
   await toastShown(page, 'Export surplus counter added');
   // The code is upper case, as on every receipt
@@ -245,6 +269,9 @@ test('adds a register, and keeps a held one from being archived', async ({ page
   await dialog.getByLabel('Name').fill('Second outlet counter');
   await dialog.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
   await dialog.getByLabel('Cash', { exact: true }).selectOption({ label: '1110 · Cash in hand' });
+  await dialog
+    .getByLabel('Cash over and short account')
+    .selectOption({ label: '5340 · Cash over and short' });
   await dialog.getByRole('button', { name: 'Add register' }).click();
   await expect(dialog.getByText('Another register uses this code.')).toBeVisible();
   await dialog.getByRole('button', { name: 'Cancel' }).click();
```

- **`takeRegister()` ends on the open card** now, and `openFirstShift()` opens POS1's first shift: ৳2,000 as a total,
  from the owner.
- **Offline, the open waits in the outbox too:** the sale comes after it, so "2 changes waiting".
- **The register form needs the over/short account:** the test presses "Add register" without it first and sees the
  error, then picks 5340.

### `e2e/pos-shifts.e2e.ts` (new)

```ts
import type { Page } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 20b: shifts at the counter. The garments workspace's POS1 Showroom counter never had a
// shift, so its first one asks where the cash came from (decision 12). POS2, held by Abdul Karim's
// Store office PC, has a shift open since this morning with ৳5,000 (src/mocks/pos-shift-data.ts →
// seedPosShifts). The reasons: Float from the owner and Change from the bank in; Cash to the bank
// and Tea for the staff out; Staff lunch archived. Every counter's difference goes to 5340 Cash
// over and short, and rings the bell over ৳500. A crew-neck T-shirt is ৳368 with VAT.

const PIN = '480915';

// A whole shift with a sale, a pay out, two held bills and two counts, while the mock copies
// 10,000 styles: 30 seconds is too tight on a busy machine
test.describe.configure({ timeout: 90_000 });

async function start(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The receipt prints by itself after a sale: a counter instead of the print dialog
    window.print = () => undefined;
  });
  await page.goto('/');
  await waitForCopy(page);
}

async function openPos(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'POS', exact: true }).click();
}

async function takePos1(page: Page): Promise<void> {
  await page.getByLabel('Register').selectOption({ label: 'POS1 · Showroom counter' });
  await page.getByRole('button', { name: 'Use this register' }).click();
  await toastShown(page, 'This device is POS1 now. The next receipt is POS1-000001.');
  await expect(page.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
}

async function countAsTotal(scope: Page | ReturnType<Page['getByRole']>, total: string) {
  await scope.getByText('As a total').click();
  await scope.getByLabel('Cash in the drawer').fill(total);
}

function shiftMenu(page: Page, number: string) {
  return page.getByRole('button', { name: `Shift ${number} menu` });
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

test('opens a shift, sells, pays out, holds a bill and closes short', async ({ page }) => {
  await start(page);
  await openPos(page);
  await takePos1(page);

  // The first shift: counted by notes (2 × ৳1,000), and the float came from the owner
  await expect(page.getByText('This is the first shift of POS1.')).toBeVisible();
  await page.getByLabel('How many ৳1,000').fill('2');
  await expect(page.getByText('= ৳2,000')).toBeVisible();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(
    page.getByText('This is the register’s first shift. Pick where the cash comes from'),
  ).toBeVisible();
  await page.getByLabel('Brought in as').selectOption({ label: 'Float from the owner' });
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'Shift POS1-S0001 is open');

  // A bill held with F8, then resumed with F9: its prices stay
  await scanTshirt(page);
  await page.keyboard.press('F8');
  const hold = page.getByRole('dialog', { name: 'Hold this bill' });
  await hold.getByLabel('Name').fill('Customer in the blue shirt');
  await hold.getByRole('button', { name: 'Hold bill' }).click();
  await toastShown(page, 'Bill held');
  await expect(payButton(page, '৳368')).toBeHidden();
  await page.keyboard.press('F9');
  const held = page.getByRole('dialog', { name: 'Held bills' });
  await expect(held).toContainText('Customer in the blue shirt');
  await held.getByRole('button', { name: 'Resume' }).click();
  await expect(held).toBeHidden();

  // Sold for the exact amount in cash
  await payButton(page, '৳368').click();
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await pay.getByRole('button', { name: 'Exact amount' }).click();
  await pay.getByRole('button', { name: 'Complete sale' }).click();
  const done = page.getByRole('dialog', { name: 'POS1-000001 is done' });
  await expect(done).toContainText('No change to give');
  await done.getByRole('button', { name: 'New sale' }).click();

  // Tea for the staff, out of the drawer: the cashier picks the reason, never an account
  await shiftMenu(page, 'POS1-S0001').click();
  await page.getByRole('menuitem', { name: 'Pay out' }).click();
  const payOut = page.getByRole('dialog', { name: 'Pay out' });
  await expect(payOut.getByLabel('Reason').getByRole('option')).toContainText([
    'Pick a reason',
    'Cash to the bank',
    'Tea for the staff',
  ]);
  await payOut.getByLabel('Reason').selectOption({ label: 'Tea for the staff' });
  await payOut.getByLabel('Amount').fill('120');
  await payOut.getByLabel('Note').fill('Tea and biscuits for the cutting floor');
  await payOut.getByRole('button', { name: 'Pay out ৳120' }).click();
  await toastShown(page, '৳120 paid out for Tea for the staff');

  // One more bill held, and left: the close drops it
  await scanTshirt(page);
  await page.keyboard.press('F8');
  await page
    .getByRole('dialog', { name: 'Hold this bill' })
    .getByRole('button', { name: 'Hold bill' })
    .click();
  await toastShown(page, 'Bill held');

  // The blind count: what the drawer should hold shows only after the close
  await shiftMenu(page, 'POS1-S0001').click();
  await page.getByRole('menuitem', { name: 'Close shift' }).click();
  const close = page.getByRole('dialog', { name: 'Close shift POS1-S0001' });
  await expect(close).toContainText('1 held bill is dropped when the shift closes.');
  await expect(close).not.toContainText('2,248');
  await countAsTotal(close, '1500');
  await close.getByRole('button', { name: 'Close the shift' }).click();

  // ৳2,000 + ৳368 − ৳120 = ৳2,248 expected, ৳1,500 counted
  const result = page.getByRole('dialog', { name: 'POS1-S0001 is closed' });
  await expect(result).toContainText('Counted৳1,500');
  await expect(result).toContainText('Expected৳2,248');
  await expect(result).toContainText('৳748 short');
  await expect(result).toContainText('The drawer has ৳748 less than expected.');
  await result.getByRole('button', { name: 'Open the next shift' }).click();

  // The next shift goes on from this device's own count, before the server answers
  await expect(page.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
  await expect(page.getByLabel('Brought in as')).toBeHidden();
  await countAsTotal(page, '1500');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'The drawer has what the last shift left: ৳1,500.');
  await expect(shiftMenu(page, 'POS1-S0002')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sync: Online, All changes synced', exact: true }),
  ).toBeVisible();

  // The managers' side: the shift, the books, and the bell over the register's ৳500
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await openFromNav(page, 'POS shifts');
  const row = listItem(page, /POS1-S0001/);
  await expect(row).toContainText('Closed');
  await expect(row).toContainText(/৳748(\.00)? short/);
  await expect(listItem(page, /POS1-S0002/)).toContainText('Open');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-S0001' })).toBeVisible();
  await expect(page.getByText('Float from the owner')).toBeVisible();
  await expect(page.getByText('Tea and biscuits for the cutting floor')).toBeVisible();
  // The float, the pay out and the closing difference each posted an entry
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-\d{4}$/ })).toHaveCount(3);
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  await page.getByText(/^POS1-S0001 on Showroom counter closed ৳748(\.00)? short\./).click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS1-S0001' })).toBeVisible();
});

test('sign-out waits for the close, and the register stays held', async ({ page }) => {
  await start(page);
  await openPos(page);
  await takePos1(page);
  await countAsTotal(page, '0');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await toastShown(page, 'Shift POS1-S0001 is open');

  // The register cannot change while the shift is open
  await page.getByRole('button', { name: 'Change register' }).click();
  await expect(
    page.getByText('Shift POS1-S0001 is open. Close it, then change the register.'),
  ).toBeVisible();

  // Sign-out from the shell leads back to the close (decision 6)
  await page.getByRole('link', { name: 'Leave the POS' }).click();
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  const gate = page.getByRole('dialog', { name: 'Close the shift first' });
  await expect(gate).toContainText('Shift POS1-S0001 is open on this device.');
  await gate.getByRole('button', { name: 'Close shift' }).click();
  const close = page.getByRole('dialog', { name: 'Close shift POS1-S0001' });
  await countAsTotal(close, '0');
  await close.getByRole('button', { name: 'Close the shift' }).click();
  const result = page.getByRole('dialog', { name: 'POS1-S0001 is closed' });
  // Even: the strip says so, and no notice (only a difference needs one)
  await expect(result).toContainText('DifferenceNo difference');
  // Closed, sign-out goes on: the register is let go, then the sign-in page
  await result.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a manager closes a stuck shift without a count', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'POS shifts');
  const row = listItem(page, /POS2-S0001/);
  await expect(row).toContainText('Abdul Karim');
  await expect(row).toContainText('Open');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: 'POS2-S0001' })).toBeVisible();
  await expect(page.getByText(/^Open since /)).toBeVisible();

  await page.getByRole('button', { name: 'Close without a count' }).click();
  const dialog = page.getByRole('dialog', { name: 'Close POS2-S0001 without a count?' });
  await dialog.getByLabel('Why').fill('Abdul went home sick; the drawer went to the safe.');
  await dialog.getByRole('button', { name: 'Close without a count' }).click();
  await toastShown(page, 'POS2-S0001 closed without a count');
  await expect(page.getByText('Not counted')).toBeVisible();
  await expect(
    page.getByText(/^Nobody counted this drawer, so no difference was posted\./),
  ).toBeVisible();
  await expect(page.getByText(/^Closed by Farhana Rahman · /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close without a count' })).toBeHidden();
  await expectNoSideScroll(page);
});

test('adds a pay out reason, and keeps names apart', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'POS cash reasons');
  await expect(listItem(page, /Float from the owner/)).toContainText('3100 · Capital');
  await expect(listItem(page, /Tea for the staff/)).toContainText('Pay out');

  await page.getByRole('button', { name: 'Add reason' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a reason' });
  await dialog.getByLabel('Name').fill('Delivery van fuel');
  await dialog.getByLabel('Kind').selectOption({ label: 'Pay out: money goes out of the drawer' });
  await dialog.getByLabel('Account').selectOption({ label: '5290 · Consumables and internal use' });
  await dialog.getByRole('button', { name: 'Add reason' }).click();
  await toastShown(page, 'Delivery van fuel added');
  await expect(listItem(page, /Delivery van fuel/)).toContainText('Pay out');

  // An archived reason keeps its name: restore it instead
  await page.getByRole('button', { name: 'Add reason' }).click();
  await dialog.getByLabel('Name').fill('staff lunch');
  await dialog.getByLabel('Account').selectOption({ label: '5290 · Consumables and internal use' });
  await dialog.getByRole('button', { name: 'Add reason' }).click();
  await expect(
    dialog.getByText(/^Another reason has this name, maybe an archived one\./),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The kind never changes once saved
  await listItem(page, /Tea for the staff/).click();
  const edit = page.getByRole('dialog', { name: 'Edit Tea for the staff' });
  await expect(edit.getByText(/^A reason stays a pay in or a pay out/)).toBeVisible();
  await expect(edit.getByRole('combobox', { name: 'Kind' })).toBeHidden();
  await expectNoSideScroll(page);
});

test.describe('the idle lock', () => {
  // This test sets the device's PIN itself
  test.use({ answerPinDialog: false });

  test('needs a PIN before the shift, then locks the POS when nobody uses it', async ({ page }) => {
    // Fake timers that still run on their own, so the test can jump past the 2 minutes
    await page.clock.install();
    await start(page);
    await page
      .getByRole('dialog', { name: 'Set a PIN for this device' })
      .getByRole('button', { name: 'Not now' })
      .click();

    // POS1 locks after 2 minutes; the device picks the change up with its next sync
    await openFromNav(page, 'POS registers');
    await listItem(page, /POS1/).click();
    const edit = page.getByRole('dialog', { name: 'Edit POS1' });
    await edit.getByLabel('Lock the POS after').selectOption({ label: '2 minutes' });
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await toastShown(page, /saved/);
    await openFromNav(page, /^Sync/);
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(
      page.getByRole('link', { name: 'Sync: Online, All changes synced', exact: true }),
    ).toBeVisible();

    // No PIN, no shift (decision 7): the device sets one here
    await openPos(page);
    await page.getByLabel('Register').selectOption({ label: 'POS1 · Showroom counter' });
    await page.getByRole('button', { name: 'Use this register' }).click();
    await expect(
      page.getByText(
        'POS1 locks itself when nobody uses it, so this device needs a PIN before a shift opens.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Set a PIN' }).click();
    const pin = page.getByRole('dialog', { name: 'Set a PIN for this device' });
    await pin.getByLabel('PIN', { exact: true }).fill(PIN);
    await pin.getByLabel('Type the PIN again').fill(PIN);
    await pin.getByRole('button', { name: 'Set PIN' }).click();
    await toastShown(page, 'Device PIN set');

    await countAsTotal(page, '0');
    await page.getByRole('button', { name: 'Open shift' }).click();
    await toastShown(page, 'Shift POS1-S0001 is open');
    await scanTshirt(page);

    // Two minutes and a check later, with nobody at the counter
    await page.clock.fastForward('02:10');
    await expect(page.getByRole('heading', { level: 1, name: 'Omnivo is locked' })).toBeVisible();
    await expect(
      page.getByText('Nobody used the POS for 2 minutes, so it locked itself.', { exact: false }),
    ).toBeVisible();
    await page.getByLabel('PIN', { exact: true }).fill(PIN);
    await page.getByRole('button', { name: 'Unlock' }).click();

    // The same shift, and the cart is where it was
    await expect(shiftMenu(page, 'POS1-S0001')).toBeVisible();
    await expect(payButton(page, '৳368')).toBeEnabled();
  });
});
```

- **The first test is a whole shift:** a first shift counted by notes (the float reason is asked for), a bill held with
  F8 and resumed with F9, a sale for the exact amount, a pay out for tea, a second bill held and left, then the blind
  close. The close dialog must not show the expected ৳2,248 before the count; the result shows ৳748 short. The next
  shift opens from this device's own count before the server answers. Then the managers' side: the list, the page with
  its three entries (the float, the pay out, the difference), and the bell, over the register's ৳500.
- **The sign-out test** checks decision 6 end to end: Change register refuses, the shell's sign-out asks to close the
  shift, its "Close shift" opens the close on `/pos`, and the result's Sign out ends on the sign-in page (decision 98).
- **The manager's close without a count** uses the seeded POS2 shift: the pill, the notice, who closed it, and the button
  gone.
- **The reasons page:** a new pay out reason, a name taken by an archived reason (in another case), and the kind shown
  but not offered when editing.
- **The idle lock** (decision 103) turns off the fixture's PIN answer: the test answers "Not now" itself, sets POS1 to
  lock after 2 minutes, syncs, sees that the shift needs a PIN, sets one from that screen, opens the shift, scans a
  T-shirt, jumps the clock, unlocks, and finds the same shift and the same cart.
- **90 seconds per test:** a whole shift while the mock copies 10,000 styles does not fit in 30 on a busy machine, like
  the PIN tests.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm exec eslint apps/app/src/mocks apps/app/e2e apps/app/src/routes/pos.tsx apps/app/src/components/pos-parts.tsx
pnpm exec prettier --check apps/app/src apps/app/e2e
pnpm boundaries
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts pos.e2e.ts pos-shifts.e2e.ts --workers=2
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts accounts.e2e.ts devices.e2e.ts \
  sync.e2e.ts journal.e2e.ts reports.e2e.ts notifications.e2e.ts outbox.e2e.ts --workers=2
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
```

All pass: the app type checks everywhere again, 195 app unit tests, no dependency rule broken, the two POS files
(18 tests, desktop and phone), the 7 files the mock's changes touch (69 tests), and the bundle check (first load
222.4 KB of 225). Before the two fixes in 20b.6a, the sign-out test failed on desktop ("0 changes on this device have
not synced") and four phone tests failed on buttons covered by the wider bar. The whole e2e suite runs once in 20b.8.

## 20b.8 — The real API, and every check once

This part changes no code. No API route, table, permission or role template changes here.

### The shift against the real API

The e2e tests run a shift against the mock API, and the integration tests send the shift's commands without a
browser. So once, the whole path ran in a real browser (Chromium, driven by a Playwright script that is not part of the
guide) against the real API, as in 20a.8: a production build of this guide's code with `VITE_API_URL` set to the API,
served by `vite preview`, the API and the worker built from this guide's code, and a throwaway Postgres and Valkey on
other ports. "No connection" meant three things at once: the API stopped, the preview server stopped, and the browser
set offline. The script:

1. **Set-up through the API:** a retail workspace, "Mango juice 250 ml" (৳25 before VAT, a barcode, 50 in stock), a
   register typed as `pos1` with a cash account, the template's 5350 "Cash over and short", the bell at any difference
   (an empty box) and no idle lock, and two reasons: "Float from the safe" (in, 3100 Capital) and "Tea for the staff"
   (out, 5290).
2. **The first shift:** `/pos` ("Not now" to the PIN), POS1, then the open card: ৳2,000 as a total, brought in as Float
   from the safe. The shift reached the server as `POS1-S0001`, open, with its float entry: cash 1110 Dr 2,000, Capital
   3100 Cr 2,000.
3. **Sales and a pay out:** two juices online, for the exact amount. Then offline: one more juice, and a pay out of ৳20
   for tea. The sync line said 2 changes waiting.
4. **Back online,** both went, in the order they were made: `pos_shift_cash()` said 2,000 + 86.25 taken − 0 change + 0
   paid in − 20 paid out = 2,066.25.
5. **The blind close:** ৳2,000 counted. The result said short; the server stored 2,000 counted, 2,066.25 expected,
   and the device had expected the same 2,066.25 (no `pos_shift.expected_differs` row). The difference entry: Cash
   over and short 5350 Dr 66.25, cash 1110 Cr 66.25. The `pos.shift_variance` bell was there.
6. **The managers' pages:** "Leave the POS", POS shifts; the bell's row opened the shift's page, with the pay out.
7. **Sign-out:** no question (the shift was closed and nothing waited), the sign-in page, and POS1 was free.

No page error. The only failed requests were three 401s at the sign-out itself, from the page's open queries, the
same as in 20a.8 (see its notes); they are not new in this step.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

All passed, some only after a fix or a second run:

- `pnpm test:e2e`: the first try was stopped by the disk guard: the machine was down to 1.3 GB free. The integration
  suites leave an anonymous Docker volume for each Postgres container; 161 of them (9.6 GB) went with `docker volume
  prune` (anonymous volumes no container uses; named ones stay). Then, with two workers, 329 passed, 1 skipped and 8
  failed:
  - **Onboarding, on both screens, was a real failure** of 20b.7's seed: the setup wizard said "51 accounts" where the
    API's template has 50. 5340 had gone into the mock's chart template, which the mock's sign-up uses too; it now
    comes from the POS seed (decision 101). Passed after the fix.
  - The other six (receipts 2, returns 2, sales orders on both screens) were timeouts and toasts still open under load,
    none in a file this step changed. All passed when run again, with the onboarding fix, the POS files and accounts
    (38 tests); two phone tests timed out once more there and passed alone (load 4).
- `pnpm test:e2e:pwa`: 4 passed in 12 seconds.

Everything else passed at the first run: `pnpm dedupe --check`, `pnpm format`, `pnpm lint`, `pnpm typecheck`,
`pnpm test` (789), `pnpm build`, `pnpm test:bundle-size` (first load 222.4 KB of 225; the POS screen 116.3, its
payment 122.2 and its held bills 120.2 of 125; the worker's list 424 files, 1413.8 KB gz), `pnpm test:openapi`,
`pnpm boundaries`, `pnpm test:integration` (617) and `pnpm test:tenant-leak` (122).

---

## 20b.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components":

In **POS screen (`/pos`)**, after "a shortcuts icon button (`Keyboard`).", add:

> With a shift open, the bar also has the shift's button ("Shift POS1-S0042" and an `ArrowDown01` icon, the input's
> look at 36px; on a phone the number alone, and the `brand` register pill hides so the bar fits 390px).

and in the same entry change "Keys: F2 search, F4 customer, F7 bill discount, F12 pay, Enter complete and new sale,
`?` the shortcuts dialog." to:

> Keys: F2 search, F4 customer, F7 bill discount, F8 hold, F9 held bills, F12 pay, Enter complete and new sale, `?`
> the shortcuts dialog.

After **POS registers (Settings)**, add these entries. A pattern that is not listed there does not exist for the next
screen, and 20c's shift reports will reuse them:

> - **POS shift (`/pos`):** a register sells only inside a shift. Without one, the screen's place is the "Open a shift"
>   card (max 560px, the wizard panel's padding): a "By notes" / "As a total" segmented control, ten note boxes in two
>   columns (`৳1,000` … `৳1`, each "= ৳3,000" in `ink-3` `tabular-nums`) with the total on `subtle`, or one money input;
>   on a register's first shift a neutral document notice and a "Brought in as" select of the "in" reasons; "Open shift"
>   (primary, full width). The count is blind: what the last shift left shows only in the toast after the open. A
>   register with no over/short account, or one that locks without the device's PIN, shows an empty state that says
>   why (with "Set a PIN" for the second).
> - **Shift menu:** the bar's shift button opens a dropdown: "Opened 23 Sep 2026, 09:02 · Sumi Akter" (group label),
>   Pay in (`MoneyAdd01`), Pay out (`MoneyRemove01`), Held bills with the count (`Note01`), Close shift (`Lock`).
> - **Pay in and pay out dialog:** a reason select (that direction's reasons only, never an account), a money input
>   and a note; the primary button says the amount ("Pay out ৳500"). The toast is the Sync page's name for it ("৳500
>   paid out for Bank deposit"). The drawer's amount is never shown (the count stays blind).
> - **Held bills:** the cart's header has Hold (secondary `sm`, `Pause`, F8) and "Held (2)" (`Note01`, F9). Hold asks
>   for an optional name ("Customer in the blue shirt"); the list dialog has rows in a 1px `line` box (the name or "Held
>   at 10:42", "2 items · ৳736" in 12px `ink-3`), Resume (secondary `sm`) and a drop icon button (`Cancel01`). At most
>   20 on a device; resuming holds the cart on the screen first.
> - **Close shift dialog and its result:** the same count as the open, a neutral notice when held bills will be dropped,
>   and "The count can’t change after the shift is closed." in 13px `ink-3` on the left of the footer, "Close the
>   shift" (primary). Then "POS1-S0042 is closed": a 40px `good-bg` tile with `CheckmarkCircle02`, a KPI strip
>   (Counted, Expected, Difference in words: "৳520 short", "৳20 over", "No difference"), a `warn` document notice
>   (`Coins01`) only when there is a difference, then Sign out (secondary, pushed left) and "Open the next shift"
>   (primary, with the focus).
> - **Shift before sign-out:** with a shift open, sign-out shows "Close the shift first" (Cancel, "Close shift"
>   primary, which opens the close on `/pos`); on the lock screen the dialog only says why. "Change register" says the
>   same.
> - **Idle lock:** a register's "Lock the POS after" (Never, 2, 5, 10, 15 minutes) locks `/pos` with the device's PIN
>   after that long with no key, click, touch or scroll; the lock screen's line says why.
> - **POS shift statuses:** Open (`brand`, `Clock01`), Closed (`good`, `CheckmarkCircle02`), Not counted (neutral,
>   `MinusSignCircle`). Not counted is not `warn`: the next shift's opening count finds any missing money.
> - **POS shifts (Sales, `pos.shift.manage`):** a data table (shift number in `Geist Mono`, register, cashier,
>   opened, closed, expected, counted, difference in words, status), filtered by a register select and a status
>   select that starts with "All shifts". A shift's page: the page header with "Close without a count" (secondary,
>   open shifts only, a dialog with an optional "Why"), the KPI strip, the opening and closing counts (notes in a
>   table, or "Counted as a total"), the cash in the drawer (opening, cash taken, change given, paid in, paid out,
>   expected), what each method took, the pay ins and outs, and its journal entries. Every amount with paisa. A
>   neutral document notice when the device and the server expected different cash (the books use the server's), and
>   for a shift closed without a count.
> - **POS cash reasons (Settings, after POS registers):** a data table (reason, kind as a neutral pill with the menu's
>   icons, account by code, status), an Active / Archived segmented control, and a dialog form: name, kind (a select
>   when new, shown but not offered once saved), account (active, not a group, not receivable, payable or stock).
>   Read-only without `pos.register.manage`.

In **POS registers (Settings)**, change "paper width (58 / 80 mm) and the receipt's footer." to:

> paper width (58 / 80 mm), the receipt's footer, and a "Shifts" group: the cash over and short account (an income or
> expense account, required), the bell for a difference over (whole taka) and "Lock the POS after".

At the end of **Sync page (`/sync`)**, add:

> A shift's open and close are named by the shift's number, a pay in or out by its sentence; none shows an amount.

**docs/system-design.bn.md** — in ৩ (মডিউল), under **৬. POS**, change "শিফট ওপেন/ক্লোজ, ক্যাশ কাউন্ট" to:

> - শিফট ওপেন/ক্লোজ, ক্যাশ কাউন্ট (blind, নোট গুনে বা মোট), কারণসহ pay in/out, over/short নিজে থেকেই হিসাবে
>   (ধাপ ২০b)

and in ৭.৪, after the row "স্টক নেগেটিভ", add:

> | **ক্যাশ ড্রয়ারের হিসাব** (অফলাইনে শিফট চলল, বিক্রি পরে পৌঁছাল) | ধাপ ২০b: একটা শিফট মানে এক ডিভাইস, এক register, এক জন; ডিভাইসই open → বিক্রি/pay in-out → close এই ক্রমে পাঠায়। close পৌঁছালে সার্ভার নিজের সারিগুলো থেকে expected cash আবার গোনে আর তার সংখ্যাই হিসাবে বসে (ডিভাইসের সাথে না মিললে audit log)। close-এর পরে পৌঁছানো বিক্রিও শিফটের ক্যাশে গোনা হয়; হারানো ডিভাইসের শিফট revoke বা manager "close without a count" দিয়ে বন্ধ হয়, আর পরের শিফটের opening count ঘাটতিটা ধরে |

**docs/build-plan.bn.md** — under "ধাপ ২০: POS স্ক্রিন", after the "বিক্রি (২০a)" bullet, add:

> - **শিফট (২০b):** শিফট খোলা থাকলেই বিক্রি; open আর close দুটোতেই drawer গোনা (নোট বা মোট, blind), পার্থক্য
>   register-এর over/short account-এ নিজে থেকে post, সীমার বেশি হলে managers-কে bell। কারণসহ pay in/out (Settings
>   → POS cash reasons, কারণের account-এ), hold/resume বিল (F8/F9, শুধু ডিভাইসে), register-এর idle lock (PIN), sign-out
>   আগে শিফট close। Sales → POS shifts (তালিকা, শিফটের পাতা, close without a count)।

Do not tick step 20 in section ৯ yet: 20c is still to come.

**COMMANDS.md** — no change: this step adds no command.

---

## 20b.10 — Run it

```bash
pnpm db:migrate       # 0053 + 0054: the reasons, the shifts, their pay ins and outs and their rules
pnpm dev
```

No new package, no new environment variable. New retail workspaces get "5350 Cash over and short" and the new
permission in their Shop manager role; in an existing workspace, add an income or expense account for it, and give
`pos.shift.manage` in Settings → Roles.

### What you will see

1. **The register's shift settings:** Settings → POS registers → your register. The "Shifts" group asks for the cash
   over and short account (a register from 20a has none, so it opens no shift until you pick one), the bell's limit
   and "Lock the POS after". Pick Never for now.
2. **Reasons:** Settings → POS cash reasons → "Float from the safe" (Pay in, your capital or safe account), "Bank
   deposit" (Pay out, a bank account), "Tea for the staff" (Pay out, an expense).
3. **The first shift:** POS. The open card: count by notes (2 × ৳1,000, 4 × ৳500), "Brought in as" Float from the safe,
   Open shift. The toast names the shift; the bar has "Shift POS1-S0001".
4. **Sell, pay out, hold:** sell something for cash; Shift menu → Pay out ৳200 for Bank deposit; add an item and press
   F8, then F9 and Resume.
5. **Offline:** DevTools → Network → Offline, sell once more and pay out ৳20 for tea. The sync line counts them; online
   again, they go in that order.
6. **The blind close:** Shift menu → Close shift, count ৳100 less than you think is there. Only now the result says
   what was expected and "৳100 short", with the `warn` notice; the bell rings if that is over the register's limit.
   Sales → POS shifts → the shift: the counts, the cash in the drawer, the pay outs and three or four journal entries.
7. **The next shift:** "Open the next shift" and count again: the toast says what the last shift left and your
   difference.
8. **Sign-out:** with a shift open, sign out from the shell: "Close the shift first" leads to the close. After the
   close, sign out goes on and the register is free.
9. **A stuck shift:** open a shift in a second browser profile on another register and close that window. In POS
   shifts, open it and "Close without a count": it shows "Not counted".
10. **The idle lock:** set the register's "Lock the POS after" to 2 minutes, give this device a PIN (it asks), open a
    shift and wait: the lock screen says why; the PIN brings back the same shift and cart.
11. **Bangla** and **390px:** the open card, the menu, the dialogs and the result in Bangla, and the POS bar fits a
    phone.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint                    # 6 GB heap for ESLint (19b decision 53)
pnpm format
pnpm typecheck
pnpm test                    # 789: contracts 326 + app 195 + api 123 + sync 103 + ui 19 + i18n 15 + auth 8
pnpm test:integration        # 617
pnpm test:tenant-leak        # 122
pnpm test:e2e                # 338: 169 flows × desktop and 390px (the sort test is skipped on the phone)
pnpm test:e2e:pwa            # 4: unchanged from 19b
pnpm build
pnpm test:bundle-size        # first load 222.4 KB gz (budget 225); the POS screen 116.3, its payment 122.2 (125); the worker's list 424 files, 1413.8 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **`gen:openapi` reads the built contract** (20b.1): it generates from `packages/contracts/dist`, so the contract is
  built first, or the new routes are missing from `openapi.json`. 20b.1's check block builds it.
- **A late sale was counted twice after a manager's close** (20b.4): the opening compared with the expected cash stored
  at that close, while the late sale was already in the drawer's books. Now a close without a count is compared with
  the expected cash now (decision 63).
- **"0" was not "0.0000"** (20b.4): a method with no payment came back as Postgres's plain `0`; the shift's amounts are
  cast to 4 decimals (decision 64).
- **The pull dropped the reasons** (20b.6a): `apply.ts` had no case for `pos_cash_reason`, and no exhaustive switch to
  say so. It has both now, and a test that the reasons arrive.
- **"Sign out" after a close asked about "0 changes"** (20b.7): the close's command was still in the outbox for a
  moment (decision 98).
- **The POS bar was wider than a phone** with a shift open (20b.7): the page scrolled sideways and the cart's bar could
  not be pressed (decision 99).
- **The mock's setup counted the counters' account** (20b.8): 20b.7 put 5340 in the mock's chart template, which the
  sign-up's setup also uses, so the onboarding test read "51 accounts" where the API makes 50. The POS seed adds it now
  (decision 101).

---

## Notes left for later steps

**Step 20c (returns and shift reports):**

- **A cash refund at the counter takes cash out of the drawer:** `pos_shift_cash()` and `expectedCashOf()` will need it
  ("− cash refunds", 20b's decision list), on the device and on the server, or every shift with a refund closes short.
- **The X and Z reports read what a shift's page already has:** `posShiftSchema`'s cash, payments by method and
  movements. A Z report is the closed shift; an X report the open one so far.
- **The device keeps only its last shift** (one row, `shift`): a report of earlier shifts is read from the server.

**Later:**

- **The shell's sign-out has the race of decision 98** (since 18b): a person who signs out the moment after a save is
  asked about "0 changes". The POS fix (draw the question only while something waits, and go on at 0) fits there too.
- **The mock's pull sends a register again on a late sale** after a close without a count (decision 102); the API does
  not. Harmless, but a mock test that counts pulled registers would see it.
- **A POS device still works without a PIN** when its register's lock is off. 19b's note stands: a till works offline
  all day, and without a PIN an offline reload does not open the copy.
