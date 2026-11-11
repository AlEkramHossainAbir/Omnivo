# Step 21c: Reports, part 3 — VAT, stock movement and reports by email

> The implementation guide for "Phase 7 → Step 21", the last of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 21 (reports) is split into three guides: 21a (the
> dashboard), 21b (the sales and purchase reports and the receivables and payables aging) and this one (the VAT report,
> the stock movement report and the scheduled report emails).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `a22baf1`, "reports added": 21b's
> code and its doc updates, plus the storefront) and checked from 2026-11-09 to 2026-11-11: `pnpm dedupe --check`,
> `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (948 — 39 new), `pnpm test:integration` (720),
> `pnpm test:tenant-leak` (133), `pnpm build`, `pnpm test:bundle-size` (first load 231.7 KB gz, budget 235; the largest
> new page 126.6 KB, budget 140; the worker's list 454 files, 1494.8 KB gz, budget 2 MB), `pnpm test:openapi`,
> `pnpm boundaries`, `pnpm test:e2e` (Playwright on the mocks, 424 — 28 new, 3 of them skipped) and `pnpm test:e2e:pwa`
> (the worker on a production build, 4) — with the turbo cache bypassed (`--force`). A few tests stopped on their time
> limit while the computer was overloaded; each passed when run again (21c.8 lists them).
>
> Your `dev` has moved on since `a22baf1` (to `afd3827`: CLAUDE.md and four e2e files). Only `apps/app/e2e/helpers.ts`
> is changed on both sides, and it merges by itself. See 21c.8 for what was checked on top of it.
>
> Also checked:
>
> - **The tables on Postgres** (21c.2): the rules of `report_schedules` and its recipients, row-level security as
>   `omnivo_app`, and that `omnivo_worker` reads only the three columns the sweep needs: 22 checks by hand.
> - **The reports and the schedules through the API and the worker** (21c.3, 21c.4): the VAT report against the books,
>   the stock rows against the stock ledger with and without a warehouse, and the sweep sending real emails with real
>   files. Broken on purpose, 4 times (the lock, the VAT grouping, a run sent twice, the catch-up): each time a test
>   failed.
> - **The screens** (21c.6, 21c.7): in a browser against the mockup you approved; it found two things (decisions 64
>   and 65). Broken on purpose, 3 times: each time a test failed.
> - **All of it against the real API in a browser** (21c.8): real documents, the VAT against the journal, the stock
>   opening worked backward, and a scheduled email sent by the worker with its file.

## Goal

🧾 **The VAT of the month, where the stock went, and the reports that arrive by themselves.** Every sale and purchase
since step 15 carries its VAT rate, and every stock movement since step 13 is in the stock ledger. But the accountant
still adds up the VAT for the monthly return by hand, the store keeper cannot see in one table what came in and went
out of a warehouse in October, and the owner opens the app every Monday morning to look at the same report.

After this step:

- `/reports/vat` shows the VAT of a period by rate (output, input, net), the documents behind it, and whether the books
  agree.
- `/reports/stock-movement` shows, for every product variant, its opening stock, what was purchased, sold, transferred
  and adjusted, and its closing stock.
- Any report with an Export menu can also be sent by email, daily, weekly or monthly, to members of the workspace.

## The whole picture

**The two reports** are read-only SQL over what is already stored. Each one has a query file that both the API (a page)
and the worker (an export) call, like the 21b reports:

```
GET /reports/vat            → vat-queries.ts  → every VAT line of the period (8 kinds of document, signed)
GET /reports/vat/documents  →                   the same lines, one row per document, one side
GET /reports/stock-movement → stock-movement-queries.ts → what each variant holds now
                                                            − the movements from the first day on
```

**A scheduled report** goes through five steps, each one small and each one safe to run twice:

```
1. POST /report-schedules         API: the schedule, its recipients, next_run_at (in the workspace's zone)
2. every 5 minutes: the sweep     worker as omnivo_worker: which schedules are due, in every workspace
                                  then as omnivo_app, per schedule: outbox 'report.schedule_due', next_run_at moves on
3. 'report.schedule_due'          run handler: who may still read it; one report_exports row per person;
                                  'report.export_requested' for each (with the schedule's id); bells to the creator
4. 'report.export_requested'      the export handler you already have: the file, in that person's language;
                                  then 'report.schedule_email' instead of the "ready" bell
5. 'report.schedule_email'        email queue: the file attached (up to 5 MB) or a button to the Exports page
```

Steps 3 and 4 are the same jobs whether a person clicked Export or a schedule ran, so a scheduled file is the same file,
made by the same code, as the one on the Exports page.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| The VAT return itself (Mushak 9.1) and its filing | Phase 2. This report helps prepare it; it is not the return |
| VAT deducted at source (VDS) | Not in the data model yet (step 17 decisions) |
| Stock movement grouped by category | Quantities in different units cannot be added (decision 4) |
| Scheduled emails to people outside the workspace | A file goes only to a member, with their own permissions (decision 7) |
| A schedule at a minute other than the whole hour | The sweep runs every 5 minutes (decision 13) |
| Changing a saved schedule's filters | Make a new one from the report page (decision 10) |
| Reports offline | Only the dashboard works offline (21a decision 7) |

## What changes in the code you already have

- **The contract (21c.1):** three new files, `vat-report.ts`, `stock-movement-report.ts` and `report-schedules.ts`;
  `reports.ts` gets two report kinds and their export queries; one new permission (`core.report.schedule`), three new
  bell types and five error codes; `routes.ts` and `index.ts`; `openapi.json` generated again.
- **The database (21c.2):** two new tables, `report_schedules` and `report_schedule_recipients` (migrations 0061 and
  0062), a date index on `stock_movements`, the new permission's description, and the permission in three role
  templates.
- **The API and the worker (21c.3):** the two reports' queries, a service and their routes; the schedules' service and
  controller; three worker jobs (the 5-minute sweep, the run and the email) and their wiring; the export handler learns the
  two kinds and emails a scheduled file; two new outbox events; five audit actions for the schedules (a contract change);
  `holdsPermission()` gets a sibling that lists everyone with a permission.
- **The API tests (21c.4):** the VAT and stock movement reports are tested on the 21b shop in
  `trade-reports.int.spec.ts`; a new `report-schedules.int.spec.ts` runs the routes and the worker's three jobs against a
  real Postgres, Redis, MinIO and Mailpit; the reports' tenant-leak suite gets a 21c part; four new unit test files.
- **The words (21c.5):** `en.ts` and `bn.ts` get the two reports, the schedules page and dialog, the new permission, the
  audit words, three bells and five errors. The worker's own Bangla words (`export/copy.ts`) say "VAT", like the app.
- **The screens (21c.6):** three new pages (`vat-report.tsx`, `stock-movement-report.tsx`, `report-schedules.tsx`), the
  schedule dialog and its queries; the Export menu of every report page (sales, purchases, P&L, aging) offers "Email on a
  schedule"; the sidebar, the router, the bell's links and the first-load budget (235 KB).
- **The mock and the Playwright tests (21c.7):** mock answers for the new routes, last month's VAT documents, the
  mockup's four schedules and a Finance desk role; two new e2e files.
- **The finish (21c.8):** no code change. The three pages run once against the real API, and every check runs once.
- **Not touched:** `packages/auth`, `packages/sync` and the sync protocol, `packages/ui`, the service worker, the POS
  screens, the sign-in and the device set-up, and the 21b reports' own queries. A new package or environment variable:
  none.

## The decisions behind this step

You made the first thirteen: 1–9 on 2026-11-09 for the whole of 21c, 10–13 on 2026-11-10 while the contract was
written. The others came up while building it; please read them with care: they are mine.

1. **The VAT numbers come from the documents' lines.** (You chose this.) Output VAT: posted invoices and POS sales,
   less posted credit notes and POS returns. Input VAT: posted bills (product lines, account lines and expenses), less
   posted debit notes (lines and expenses). A line beside it compares with the books: the `vat_output` and `vat_input`
   accounts ("Books agree" or "Out by ৳x").
2. **Input VAT without a Mushak 6.3 stays in.** (You chose this.) The net is as in the books. A line under Input says
   how much of it is on bills with no supplier's VAT invoice number (`bills.mushak_number`), so the accountant knows
   which bills to check.
3. **The VAT page.** (You chose this.) `/reports/vat`, last month by default, month presets and dates, an optional
   branch. A KPI strip, a table by rate (zero-rated and exempt are separate rows), and a paged list of the documents with
   an Output / Input segmented control.
4. **The stock movement page.** (You chose this.) `/reports/stock-movement`, one row per variant, in the base unit:
   Opening, Purchased, Sold, Transfers, Adjusted, Closing; a return is taken off in the column of what it undoes.
   Filters: period, warehouse, category, "only what moved". A row opens the stock card. The value columns need
   `inventory.stock.value`. No "group by": units cannot be added.
5. **The opening stock needs no new table.** (You chose this.) The opening quantity is the balance now
   (`stock_balances`) less the movements from the start date on, with an index on `(tenant_id, date)`. The value is
   worked out the same way from `stock_values`. With a warehouse filter, only that warehouse's movements count.
6. **A new permission, `core.report.schedule`.** (You chose this.) Needed together with the report's own read
   permission. Schedules belong to the workspace, not to the person who made them. At most 10 recipients per schedule
   and 20 schedules per workspace.
7. **One export per recipient.** (You chose this.) Each run writes one `report_exports` row for each person
   (`requested_by` = that person), so the file is in their language, shows what their own permissions allow, is made by
   the export handler you already have, and is on their Exports page too. Up to 5 MB the file is attached; a larger one
   is a link that needs a sign-in.
8. **The period comes from the frequency.** (You chose this.) Daily is yesterday. Weekly is the seven days that end
   yesterday (you pick the day, Sunday by default). Monthly is the whole calendar month before (you pick a day from 1 to
   28). The agings and the balance sheet show the last day of the period. You pick the hour (08:00 by default). Every
   other filter comes from the report page.
9. **A `report_schedules` table with `next_run_at`.** (You chose this.) A sweep job every 5 minutes writes an outbox
   event for each schedule that is due; `omnivo_worker` may read only this table. A run that was missed (the worker was
   down) goes once, not once per missed day. A recipient who lost the permission is skipped and the person who made the
   schedule gets a bell; with nobody left, the schedule is "Paused". Each email links to the schedules page.
10. **A saved schedule's filters are fixed.** (You chose this.) Editing changes the format, the time and the
    recipients. Other filters are a new schedule, made from the report page, where the filters are. So the schedules
    page needs no filter controls of its own for nine kinds of report.
11. **The VAT report needs `accounting.report.read`.** (You chose this.) The same permission as the trial balance and
    the statements: VAT is part of the accounts. No new permission and no change to the role templates.
12. **The bells go to the person who made the schedule only.** (You chose this.) If they have left the workspace,
    nobody gets the bell; the schedules page still shows who cannot receive the report.
13. **Whole hours only.** (You chose this.) 00:00 to 23:00 in the workspace's time zone. The sweep runs every 5
    minutes, so a minute picker would promise more than it keeps.
14. **A VAT row is a rate, its kind and its percent.** Every line keeps a copy of the rate it was charged at (name,
    kind and percent, since step 15). The rows use that copy, so a rate renamed or changed later never moves an old sale
    to another row. A rate whose percent (or kind: Settings lets you turn "Exempt" into "Zero-rated") was changed in the
    period has one row for each: they are different lines of the return. The row's `key` is the rate's id, the kind and
    the percent. (Written as "id plus percent" in 21c.1; the kind was added in 21c.3, when the query showed that a kind
    can change too.)
15. **The rows' order:** standard rates first, the highest first, then reduced, zero-rated and exempt, as a return
    lists them.
16. **What was taken off is shown, not hidden.** The totals carry `outputVatReturned` (credit notes and POS returns)
    and `inputVatReturned` (debit notes). They are already left out of `outputVat` and `inputVat`; they are there so
    the page can say "of which ৳x was returned".
17. **"Without a Mushak 6.3" is counted before the debit notes.** A debit note does not say which part of a bill it
    took money off, so the amount cannot be split. The line is a hint for the accountant, not a number in the return.
18. **The VAT documents list is a register.** Oldest first and not sortable, like a VAT register on paper. A credit
    note, a POS return and a debit note have negative amounts, so a column adds up to the KPI. The document kind is a
    plain string in the answer (narrowed by `isVatDocumentKind()` in the app), so a newer server's new document kind
    never breaks an older app.
19. **Which branch a document belongs to:** an invoice, a credit note, a bill and a debit note their own; a POS sale and
    a POS return the branch of their register's warehouse.
20. **The stock movement report reads the permission it already has.** `inventory.report.read`, like stock valuation.
21. **A return sits in the column of what it undoes.** A sales return and a POS return are taken off "Sold", a
    purchase return off "Purchased", so "Sold" is what really left. A revaluation moves the value, never the
    quantity, so it is in no column. The map is written with `satisfies`, so a new kind of movement does not compile
    until it has a column.
22. **"Only what moved" is the default.** `show: 'moved'` lists the variants with a movement in the period; `'all'`
    adds the ones that had stock and did not move. A variant with no stock and no movement never has a row, or the
    report would list every product ever made.
23. **No total quantity.** 40 pcs and 2.74 m are not one number. The totals are the number of rows and, with
    `inventory.stock.value`, the opening and closing value. `withValue` tells the page which columns to draw, so they
    are right even with no rows.
24. **Sorting by a value is refused without `inventory.stock.value`**, like 21b's cost sorts: the order of the rows
    would tell what the hidden column says.
25. **"Transfers" is in less out.** With every warehouse in the report a finished transfer adds up to zero, so a
    negative number is stock still on a truck (in transit, step 14).
26. **A schedule's time is a discriminated union.** `{ frequency: 'weekly', hour, weekday }` cannot exist without its
    day, and the form's type says so. `weekday` counts 0 as Sunday, as `Date.getUTCDay()` does.
27. **The next run is worked out in the contract.** `nextReportScheduleRun()` is shared by the API (when a schedule is
    saved) and the worker (after each run), so they can never disagree. It is always strictly after the given moment,
    so a run that ends on its own minute moves on. It reads the time zone's offset twice, because the first guess can
    land on the other side of a clock change. Bangladesh has no summer time, but a workspace's time zone is a setting.
28. **A run's period never includes the day of the run.** A report sent at 08:00 about today would cover a third of a
    day. A report that shows one day (an aging, the balance sheet) gets the period's last day. The comparison dates of
    the P&L and the balance sheet are dropped: "compare with" is a choice about one fixed period, and a schedule has
    none.
29. **A new schedule is sent as an export plus when and to whom.** The page sends the query it already has, dates
    included, so the report's own schema checks the filters (a sort the group has no column for, say). The API keeps
    only the filters (`reportScheduleFiltersOf()`).
30. **Recipients are member ids, 1 to 10, each once.** Whether each one may read the report is checked by the API, and
    again at every run. The form asks a route that lists only the members who may read that report, so it never offers
    someone who would be skipped.
31. **A schedule is Active or Paused, with a reason.** `manual` (someone pressed Pause) or `no_recipients` (nobody on it
    may read the report any more). Resume is refused (`report_schedule_no_recipients`) while nobody can receive it.
    Each recipient in the answer has `canReceive`, so the list shows who gets nothing until that changes.
32. **Three bells.** `report.schedule_skipped` (some people were left out), `report.schedule_paused` (nobody was left)
    and `report.schedule_failed` (one person's file or email could not be made or sent).
33. **The schedules list is not paged and carries the time zone.** A workspace has at most 20 schedules. `hour` means
    nothing without the zone, so the answer says which. The list leaves out the schedules of reports the person may
    not read, and gives the names of the filters' ids (branch, warehouse, group, category), so it can say "Sylhet depot"
    and not an id.
34. **Update, Pause and Resume carry the version**, like every other form since step 10, so two people editing the same
    schedule do not overwrite each other. Delete removes the schedule; the files already sent stay on the Exports pages.
35. **A schedule's time is four columns, not a jsonb.** `frequency`, `hour`, `weekday` and `day_of_month`, with checks
    that keep each day field with its frequency. A jsonb copy of the contract's union could hold a weekly schedule
    with no day, and the database would never say so.
36. **Recipients are their own table, of users.** One row per person, in the order they were picked (`position` 1 to
    10, unique, so the database also stops an eleventh), keyed by schedule and user, so nobody is on a schedule twice.
    It points at `users`, not at `memberships`: someone who left the workspace stays on the list as "cannot receive
    it" until someone takes them off, and members are only ever soft-deleted.
37. **The worker reads three columns.** `omnivo_worker` may read `id`, `tenant_id` and `next_run_at` of
    `report_schedules`, in every workspace, and nothing else: not the filters, not the recipients, and it changes
    nothing. The rest of a run happens as `omnivo_app` inside the schedule's own workspace.
38. **Who gets `core.report.schedule` in a new workspace:** the roles that already read every module's reports
    (Accountant, the pharmacy's Shop manager, distribution's Manager). Roles in existing workspaces do not change, as
    with every new permission: the owner adds it in Settings → Roles.
39. **The limit of 20 schedules is the API's**, under a lock per workspace (21c.3). The database keeps the limit of 10
    recipients, which a unique position makes easy; counting rows would need a trigger for one error message.
40. **A run is its own job.** The sweep only hands a due schedule over: an outbox event `report.schedule_due` and
    `next_run_at` moved on, in one transaction. Who gets it and the files are the run's job. So the sweep stays one cheap
    transaction per schedule across every workspace, and a broken schedule fails in its own job, with its own retries
    and a bell, without holding up anyone else's.
41. **A missed run goes once, for the latest period.** After the worker was down for three days, a daily schedule sends
    one email, about yesterday, and its next run is the first one after now. The event carries `runAt`, the run it
    stands for, so the period never depends on how late the job ran (`catchUp()`).
42. **The run's files have ids made from the event.** One person's file of one run has the same id every time the job
    runs (a hash of the event's id and the person's), so a retry after a crash finds the rows it made and makes nothing
    twice. The id is still a UUIDv7 with the event's time in it, because the Exports page lists the newest id first.
43. **A scheduled file goes by email, not by bell.** The export handler you already have makes it; when the file is
    ready it writes a `report.schedule_email` event instead of the "ready" bell. The email is a job on the email queue,
    like the document emails, so a slow mail server never holds up the files.
44. **The email is Omnivo's own.** From our address, with the company's name at the top, like the invitation (a
    document email is "Company via Omnivo" because it goes to a customer; this one goes to a member). The file is
    attached up to 5 MB; a larger one is a "Download the file" button to the Exports page (`/reports/exports`), which
    needs a sign-in. The other link is to the schedules page, `/reports/schedules`, which 21c.6 makes.
45. **What changed between the steps wins.** A schedule paused between the sweep and the run sends nothing; one deleted
    between the file and the email sends no email (the file stays on the Exports page). Sending is the email job's last
    step, so a crash after the mail server took it sends it again: twice is better than never (step 16's rule).
46. **The schedules are in the audit log.** Five actions (`report_schedule.created`, `.updated`, `.paused`, `.resumed`,
    `.deleted`) and the entity type `report_schedule`, added to the contract in this part. Who gets the company's
    numbers by email is worth a record. When the worker pauses a schedule because nobody can receive it, the row has no
    actor, which the audit log shows as the system.
47. **The sweep has one clock.** It finds the due rows and works out the next run with the same JavaScript time. With
    the database's `now()` in one place and the server's clock in the other, a clock that is one second off could move
    a schedule to a time that has already passed, and it would run twice.
48. **One warehouse's stock value is the sum of its movements' values.** `stock_values` is for the whole company (one
    average cost, step 14), and has no warehouse. Every movement carries the value it moved, in its warehouse, so their
    sum is the warehouse's value. This is the one place the report reads old movements, and only with a warehouse filter
    and the value permission.
49. **The VAT export is the summary.** The rows by rate, the totals, and lines under the title for the books, what was
    taken off and the VAT with no Mushak 6.3. The documents list is the page's (a register of a busy month is
    thousands of lines, and the accountant filters it on the screen).
50. **A file follows its reader's permissions, not the schedule maker's.** A recipient without `inventory.stock.value`
    gets the stock movement file without the value columns, and a value sort falls back to the name, like 21b's cost
    columns in the sales file.
51. **Bangla says "VAT", not "ভ্যাট".** The app's Bangla writes VAT in English in 75 places (CLAUDE.md keeps common
    office terms in English), so the exported file, its email subject and the new pages do too. A POS return is "POS
    ফেরত", as on the POS pages. 21c.3 wrote "ভ্যাট" and "POS রিটার্ন" in `export/copy.ts`; 21c.5 changed them (the
    diffs above show the final words).
52. **Weekdays are words with names, not numbers.** The contract counts 0 = Sunday. A key like `weekdays.0` would make
    the page call `t()` with `` `weekdays.${number}` ``, which the typed `t()` refuses. So the words are
    `weekdays.sunday` … `weekdays.saturday`, and the page keeps one list of those keys in the contract's order.
53. **A net VAT below zero is never a bare minus.** The KPI strip shows the amount without its sign and says under it
    "To pay", "To carry forward" or "Nothing to pay"; the table says "৳4,200 to carry forward". An accountant reads a
    minus in a VAT column as a mistake.
54. **The VAT page shows paisa everywhere** (you chose this, from the mockup). The accountant copies these numbers
    into the return. In whole taka the rows would stop adding up to the total, which looks like a mistake on a page
    about tax. The 21b reports keep whole taka; they are for reading, not for copying.
55. **Someone on a schedule who may not read the report now stays in the edit dialog's list**, unticked and disabled,
    with "Gets nothing: may not read this report now" (you chose this). The editor sees who stops getting it. Saving
    drops them, which the API would demand anyway (`report_schedule_recipient_invalid`).
56. **The VAT rates are a plain table in a card**, like the statements: one to eight rows, a total in `<tfoot>`, the
    rate column sticky on a phone. A data table would add sorting and paging that a few rows do not need, and it has
    no total row.
57. **The scheduled emails page has no "New" button** (you chose this). A schedule keeps the filters of the page it was
    made on (decision 10), so it is always made from a report's Export menu, where those filters are.
58. **The dialog lists the same filter lines as the schedules list.** A new schedule's lines are built from the page's
    filters by the same function as a saved one's (`useScheduleWords().filterLines`), so the dialog never promises
    something the list then says differently. A sales or purchase report also gets a "Group by: Customer" line: it
    changes the whole file. Two small keys were added to 21c.5's words for this page:
    `reportSchedules.filterLines.groupBy` and `reportSchedules.columns.actions` (the menu column's header for screen
    readers). The 21c.5 diffs above show them.
59. **`ExportMenu` takes the names of the page's filters** (`names`). The query has only ids, and the dialog must show
    "Branch: DHK · Dhaka HQ". The page already has the lists its selects show, so it passes the names; the dialog asks
    the server for nothing but the people. The dialog renders outside the menu, like the device lists' dialogs: the menu
    closes and gives the focus back first, then the dialog takes it.
60. **The VAT page opens on last month, the stock movement page on this month.** A return is filed for the month that
    just ended. The stock page is for "what is happening", like the sales report.
61. **`BooksLine` gets an optional `inBooks(books)`** for the words beside its pill. The VAT page has two lines with
    their own words and paisa; the 21b reports keep "In the books: ৳39,19,000" without passing anything.
62. **The mock gets "a VAT month": last month's documents with VAT, a seed of its own.** The year of trade (21b) is all
    Exempt, so the VAT page would show only zeros. Adding VAT documents to that year would change the numbers the 21b
    tests read, and putting them "last month" inside it would too in July, when last month is the last fiscal year. So
    `vat-month-data.ts` has its own switch (`MOCK_NO_VAT_MONTH_KEY`, `test.use({ vatMonth: true })`), on in
    `pnpm dev:mock`, off in every other test.
63. **The garments workspace gets a "Finance desk" role with two people, and the four schedules of the mockup.** The
    generated Accountants have no report permission, and giving them one would offer 60 people in "Send to". Nusrat Jahan
    and Rafiq Ahmed read every report. Kamal Uddin (the Purchase manager, 17a) is on two schedules but may read neither,
    so the "gets nothing" line and the paused-by-the-worker row have real data.
64. **The VAT documents and the scheduled emails are not sortable, really.** Seen in a browser: 21c.6 left the data
    table's own sorting on, so their headers had sort buttons that would order only the rows already loaded. Every
    column now says `enableSorting: false`, as the bills list does. The 21c.6 files above already have it.
65. **A branch and a warehouse in `filterNames` are "HO · Head office".** Seen in a browser: the list and the change
    dialog said "Branch: Head office" while the new dialog (decision 59) and the approved mockup say the code too. The
    API now builds the name in SQL (`codeAndName` in `report-schedules.service.ts`, 21c.3), the integration test expects
    it (21c.4), and the contract's comment says so (21c.1). Groups and categories show no code anywhere and stay names.
66. **The stock movement tests read "This fiscal year" with "Also what did not move".** The mock's opening stock is
    dated a week ago and its transfer yesterday, so near the start of a month or a year any preset can move them in or
    out of the period. With the whole year and every product shown, the count and the closing numbers are the same on
    every day; the test works out from today's date whether the week-old stock is a movement or the opening, so it has
    no date that breaks it.

## 21c.1 — `packages/contracts`: the contract

The contract first: what each report asks and answers, and what a schedule is. Three new files; `reports.ts` learns the
two new kinds of export.

### `vat-report.ts` (new): the VAT report

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { TAX_RATE_KINDS } from './tax-rates.js';

// The VAT report (step 21c): the VAT of a period, by rate. It helps the accountant prepare the
// monthly return. It is not the return itself: Mushak 9.1 comes in Phase 2.
//
// - The numbers come from the documents' lines, by the document's date. Output VAT: posted invoices
//   and POS sales, less posted credit notes and POS returns. Input VAT: posted bills (product
//   lines, account lines and expenses), less posted debit notes.
// - Each line keeps the rate it was charged at, so a rate that was renamed or changed later does
//   not move an old sale to another row.
// - Beside the report, what the books say: the 'vat_output' and 'vat_input' accounts. A journal
//   entry written by hand on one of them makes the two differ, and the page shows by how much.

// ---------------------------------------------------------------------------------------------
// The query

// Both days included, like the other reports. An invoice or a credit note counts in its own branch,
// a POS sale or return in its warehouse's, a bill or a debit note in its own.
export const vatReportFilterSchema = z
  .object({ from: z.iso.date(), to: z.iso.date(), branchId: z.uuid().optional() })
  .refine((query) => query.from <= query.to, {
    error: errorCode('report_range_invalid'),
    path: ['to'],
  });
export type VatReportFilter = z.infer<typeof vatReportFilterSchema>;

// Output is what the company charged, input is what it paid
export const VAT_REPORT_SIDES = ['output', 'input'] as const;
export type VatReportSide = (typeof VAT_REPORT_SIDES)[number];

// The filters again, because a schema with .refine() cannot be extended
export const vatDocumentQuerySchema = pageQuerySchema
  .extend({
    from: z.iso.date(),
    to: z.iso.date(),
    branchId: z.uuid().optional(),
    side: z.enum(VAT_REPORT_SIDES),
  })
  .refine((query) => query.from <= query.to, {
    error: errorCode('report_range_invalid'),
    path: ['to'],
  });
export type VatDocumentQuery = z.input<typeof vatDocumentQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The answer. Every amount is a decimal string with 4 places. Credit notes, POS returns and debit
// notes are already taken off.

export const vatReportRowSchema = z.object({
  // Unique in the answer: the rate's id, its kind and its percent. A rate whose percent (or kind)
  // was changed has one row for each, because each one is a different line of the return.
  key: z.string(),
  taxRateId: z.uuid(),
  // "VAT 15%", as the page shows it next to the percent
  name: z.string(),
  // Zero-rated and exempt are both 0%, but different things in a return: never one row
  kind: z.enum(TAX_RATE_KINDS),
  // A percentage: "15.00"
  rate: z.string(),
  outputNet: z.string(),
  outputVat: z.string(),
  inputNet: z.string(),
  inputVat: z.string(),
  // outputVat − inputVat. Negative when more was paid than charged.
  netVat: z.string(),
});
export type VatReportRow = z.infer<typeof vatReportRowSchema>;

export const vatReportTotalsSchema = z.object({
  outputNet: z.string(),
  outputVat: z.string(),
  // How much of the VAT charged was taken off again: credit notes and POS returns. Positive, and
  // already left out of outputVat.
  outputVatReturned: z.string(),
  inputNet: z.string(),
  inputVat: z.string(),
  // The same for debit notes
  inputVatReturned: z.string(),
  // The VAT on posted bills with no supplier's VAT invoice (Mushak 6.3) number. It stays in
  // inputVat, as it does in the books: this only tells the accountant which bills to check.
  // Before debit notes, because a debit note does not say which part of the bill it took off.
  inputVatWithoutMushak: z.string(),
  netVat: z.string(),
});
export type VatReportTotals = z.infer<typeof vatReportTotalsSchema>;

export const vatReportSchema = z.object({
  // Standard rates first, the highest first; then reduced, zero-rated and exempt
  rows: z.array(vatReportRowSchema),
  totals: vatReportTotalsSchema,
  // What the accounts moved in the same period and branch. output: credit less debit on
  // 'vat_output'. input: debit less credit on 'vat_input'.
  books: z.object({ output: z.string(), input: z.string() }),
});
export type VatReport = z.infer<typeof vatReportSchema>;

export const VAT_DOCUMENT_KINDS = [
  'invoice',
  'pos_sale',
  'credit_note',
  'pos_return',
  'bill',
  'debit_note',
] as const;
export type VatDocumentKind = (typeof VAT_DOCUMENT_KINDS)[number];

export const vatDocumentSchema = z.object({
  // z.string(), not an enum: a newer server's new document must not break an older client. The
  // app narrows it with isVatDocumentKind().
  kind: z.string(),
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // null for a POS sale or return with no customer (walk-in)
  partyName: z.string().nullable(),
  partyBin: z.string().nullable(),
  // A bill's and a debit note's own VAT document (Mushak 6.3, Mushak 6.7); null elsewhere
  mushakNumber: z.string().nullable(),
  // Negative for what takes VAT off: a credit note, a POS return, a debit note
  net: z.string(),
  vat: z.string(),
});
export type VatDocument = z.infer<typeof vatDocumentSchema>;

export function isVatDocumentKind(value: string): value is VatDocumentKind {
  return VAT_DOCUMENT_KINDS.some((kind) => kind === value);
}

// In date order, oldest first, like a VAT register. Not sortable.
export const vatDocumentPageSchema = pageOf(vatDocumentSchema);
export type VatDocumentPage = z.infer<typeof vatDocumentPageSchema>;

// ---------------------------------------------------------------------------------------------
// The routes. VAT belongs to the accounts, so it needs accounting.report.read.

export const vatReportRoutes = {
  summary: defineRoute({
    method: 'GET',
    path: '/reports/vat',
    summary: 'The VAT of a period by rate, with what the books say',
    auth: 'bearer',
    permission: 'accounting.report.read',
    status: 200,
    query: vatReportFilterSchema,
    response: vatReportSchema,
  }),
  documents: defineRoute({
    method: 'GET',
    path: '/reports/vat/documents',
    summary: 'The documents behind the VAT of a period, one side at a time',
    auth: 'bearer',
    permission: 'accounting.report.read',
    status: 200,
    query: vatDocumentQuerySchema,
    response: vatDocumentPageSchema,
  }),
};
```

Why it is written this way:

- **`vatReportFilterSchema` has no `sort` and no page.** The summary is a handful of rows (one per rate), so it is
  never paged. The export carries the summary.
- **`vatDocumentQuerySchema` repeats the filters instead of extending the filter schema.** A Zod schema with
  `.refine()` cannot be `.extend()`ed, so the three fields are written again. Both keep the `report_range_invalid` check
  on `to`, so the error shows under the end date.
- **`side` is required on the documents' query.** The list is either output or input, never both mixed: one is what
  the company charged, the other what it paid, and the page's segmented control always has one selected.
- **`kind: z.enum(TAX_RATE_KINDS)` on a row.** Zero-rated and exempt are both 0%, but a return reports them on
  different lines. With only `rate` the page could not tell them apart.
- **`netVat` can be negative.** A month with a big purchase pays more input VAT than it charges. The page shows it as
  "to carry forward", not as a minus sign alone.
- **`books` is two numbers, not a pill.** The page works out "Books agree" or "Out by ৳x" itself, as the 21b reports
  do, so the API stays free of words.
- **`partyName` and `partyBin` are nullable.** A POS sale to a walk-in customer has no party. A party without a BIN is
  normal for a small shop.
- **`kind: z.string()` on a document, with `isVatDocumentKind()`.** See decision 18. The type guard uses `.some()`
  instead of `.includes()`, because `includes` on a `readonly` tuple of literals does not accept a plain `string`
  without a cast.

```ts
import { describe, expect, it } from 'vitest';

import { isVatDocumentKind, vatDocumentQuerySchema, vatReportFilterSchema } from './vat-report.js';

describe('the VAT report', () => {
  it('refuses a period that ends before it starts', () => {
    expect(
      vatReportFilterSchema.safeParse({ from: '2026-10-31', to: '2026-10-01' }).error?.issues[0]
        ?.message,
    ).toBe('report_range_invalid');
  });

  it('needs a side for its documents', () => {
    expect(vatDocumentQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(
      false,
    );
    expect(
      vatDocumentQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31', side: 'input' }).limit,
    ).toBe(50);
  });

  it('narrows a document kind it knows', () => {
    expect(isVatDocumentKind('debit_note')).toBe(true);
    expect(isVatDocumentKind('something_new')).toBe(false);
  });
});
```

Three tests: the period check, the required side (and the page's default size of 50), and the kind guard with a kind
the app does not know.

### `stock-movement-report.ts` (new): the stock movement report

```ts
import { z } from 'zod';

import { dashboardUnitSchema } from './dashboard.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { type MovementKind, variantRefSchema } from './stock.js';

// The stock movement report (step 21c): for each variant, what it opened with, what came in and went
// out in a period, and what it closed with.
//
//   closing = opening + purchased − sold + transfers + adjusted
//
// - Quantities are in the product's base unit, so the rows never add up to a total: 40 pcs and
//   2.74 m are not one number. That is also why there is no "group by category".
// - The value columns need inventory.stock.value. Without them they are null, and sorting by them
//   is refused: the order of the rows would tell what the hidden column says.
// - A row opens the variant's stock card, where the single movements are.

// ---------------------------------------------------------------------------------------------
// Which column each kind of movement belongs to

export const STOCK_MOVEMENT_COLUMNS = ['purchased', 'sold', 'transfers', 'adjusted'] as const;
export type StockMovementColumn = (typeof STOCK_MOVEMENT_COLUMNS)[number];

// A return is in the column of what it undoes, so "Sold" is what really left. null: a revaluation
// moves the value, never the quantity. satisfies: a new kind of movement does not compile until it
// has a column here.
export const STOCK_MOVEMENT_COLUMN_OF = {
  purchase_receipt: 'purchased',
  purchase_return: 'purchased',
  delivery: 'sold',
  sales_return: 'sold',
  pos_sale: 'sold',
  pos_return: 'sold',
  transfer_in: 'transfers',
  transfer_out: 'transfers',
  adjustment: 'adjusted',
  revaluation: null,
} as const satisfies Record<MovementKind, StockMovementColumn | null>;

// ---------------------------------------------------------------------------------------------
// The query

// 'moved' keeps the variants with a movement in the period. 'all' adds the ones that had stock
// and did not move. A variant with no stock and no movement never has a row.
export const STOCK_MOVEMENT_SHOWS = ['moved', 'all'] as const;
export type StockMovementShow = (typeof STOCK_MOVEMENT_SHOWS)[number];

export const STOCK_MOVEMENT_SORTS = [
  'name',
  '-name',
  'sku',
  '-sku',
  'opening',
  '-opening',
  'purchased',
  '-purchased',
  'sold',
  '-sold',
  'transfers',
  '-transfers',
  'adjusted',
  '-adjusted',
  'closing',
  '-closing',
  'openingValue',
  '-openingValue',
  'closingValue',
  '-closingValue',
] as const;
export type StockMovementSort = (typeof STOCK_MOVEMENT_SORTS)[number];

export const STOCK_MOVEMENT_VALUE_SORTS = [
  'openingValue',
  '-openingValue',
  'closingValue',
  '-closingValue',
] as const satisfies readonly StockMovementSort[];

export function isStockValueSort(sort: StockMovementSort): boolean {
  return STOCK_MOVEMENT_VALUE_SORTS.some((item) => item === sort);
}

const stockMovementFilterShape = {
  from: z.iso.date(),
  to: z.iso.date(),
  warehouseId: z.uuid().optional(),
  // This category and every category under it
  categoryId: z.uuid().optional(),
  show: z.enum(STOCK_MOVEMENT_SHOWS).default('moved'),
  sort: z.enum(STOCK_MOVEMENT_SORTS).default('name'),
};

function checkPeriod(query: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (query.from > query.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: errorCode('report_range_invalid') });
  }
}

// The filters without the page: what an export carries (every row, in the same order)
export const stockMovementFilterSchema = z
  .object(stockMovementFilterShape)
  .superRefine(checkPeriod);
export type StockMovementFilter = z.infer<typeof stockMovementFilterSchema>;

export const stockMovementReportQuerySchema = pageQuerySchema
  .extend(stockMovementFilterShape)
  .superRefine(checkPeriod);
export type StockMovementReportQuery = z.input<typeof stockMovementReportQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The answer. Quantities and values are decimal strings with 4 places.

export const stockMovementRowSchema = variantRefSchema.extend({
  baseUnit: dashboardUnitSchema,
  opening: z.string(),
  // Received less what went back to the supplier
  purchased: z.string(),
  // Delivered and sold at the counter, less what came back. Positive means stock went out.
  sold: z.string(),
  // In less out. With every warehouse in the report a finished transfer nets to zero, so a
  // negative number here is stock still on a truck.
  transfers: z.string(),
  // Signed: found stock is positive, damaged stock negative
  adjusted: z.string(),
  closing: z.string(),
  // null without inventory.stock.value
  openingValue: z.string().nullable(),
  closingValue: z.string().nullable(),
});
export type StockMovementRow = z.infer<typeof stockMovementRowSchema>;

export const stockMovementReportSchema = pageOf(stockMovementRowSchema).extend({
  // false without inventory.stock.value. The page draws its columns from this, so they are right
  // even when there are no rows.
  withValue: z.boolean(),
  // The same on every page: the page reads them from the first one
  totals: z.object({
    // How many rows the report has, over every page
    variants: z.number().int().min(0),
    // null without inventory.stock.value. There is no total quantity (see the top of this file).
    openingValue: z.string().nullable(),
    closingValue: z.string().nullable(),
  }),
});
export type StockMovementReport = z.infer<typeof stockMovementReportSchema>;

// ---------------------------------------------------------------------------------------------
// The route

export const stockMovementReportRoutes = {
  report: defineRoute({
    method: 'GET',
    path: '/reports/stock-movement',
    summary: 'Opening, purchased, sold, transferred, adjusted and closing stock of a period',
    auth: 'bearer',
    permission: 'inventory.report.read',
    status: 200,
    query: stockMovementReportQuerySchema,
    response: stockMovementReportSchema,
  }),
};
```

Why it is written this way:

- **`STOCK_MOVEMENT_COLUMN_OF` with `satisfies Record<MovementKind, …>`.** `MovementKind` is the list of kinds in the
  stock ledger (`stock.ts`). If a later step adds a kind (production, say), this file stops compiling until someone
  decides its column. Without `satisfies`, the new kind would quietly fall into no column and the report would not add
  up: closing would no longer be opening plus the columns.
- **`as const` before `satisfies`.** It keeps each value as its literal (`'sold'`, not `string`), so the API can use
  the map to build its SQL `CASE` and TypeScript still knows each column's name.
- **`stockMovementFilterShape` is a plain object.** Two schemas are made from it: the filter (what an export carries)
  and the query (the filter plus the page). `.superRefine(checkPeriod)` goes on each one at the end, because a refined
  schema cannot be extended (the same reason as in `vat-report.ts`).
- **`show` and `sort` have defaults.** A link with only the dates opens the report the usual way. The export stores
  the parsed query, so it keeps the defaults too.
- **`isStockValueSort()`.** The API refuses these sorts without `inventory.stock.value` (decision 24). It is in the
  contract, so the page can also leave them out of the sortable columns.
- **`stockMovementRowSchema` extends `variantRefSchema`.** The variant's id, product name, variant name and SKU have
  the same shape as on every other stock screen, so the page uses the same cell to show them.
- **`baseUnit` is `dashboardUnitSchema`.** The unit's code and its decimals, the shape 21a made for "40 of 200
  strips": the page needs both to show `2.74 m`.
- **`openingValue` and `closingValue` are nullable, `withValue` is not.** A null tells "hidden" from "zero" in one
  row; `withValue` tells the page which columns to draw even when there are no rows.
- **`totals` is the same on every page.** The page reads it from the first page, as the 21b reports do, so the KPI
  strip does not jump while more rows load.

```ts
import { describe, expect, it } from 'vitest';

import {
  isStockValueSort,
  STOCK_MOVEMENT_COLUMN_OF,
  stockMovementFilterSchema,
} from './stock-movement-report.js';
import { MOVEMENT_KINDS } from './stock.js';

describe('the stock movement report', () => {
  it('puts a return in the column of what it undoes', () => {
    expect(STOCK_MOVEMENT_COLUMN_OF.sales_return).toBe('sold');
    expect(STOCK_MOVEMENT_COLUMN_OF.pos_return).toBe('sold');
    expect(STOCK_MOVEMENT_COLUMN_OF.purchase_return).toBe('purchased');
  });

  it('leaves only the revaluation out of the quantity columns', () => {
    expect(MOVEMENT_KINDS.filter((kind) => STOCK_MOVEMENT_COLUMN_OF[kind] === null)).toEqual([
      'revaluation',
    ]);
  });

  it('starts with what moved, sorted by name', () => {
    expect(stockMovementFilterSchema.parse({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      show: 'moved',
      sort: 'name',
    });
  });

  it('refuses a period that ends before it starts', () => {
    expect(
      stockMovementFilterSchema.safeParse({ from: '2026-10-31', to: '2026-10-01' }).error?.issues[0]
        ?.message,
    ).toBe('report_range_invalid');
  });

  it('knows which sorts read the value', () => {
    expect(isStockValueSort('-closingValue')).toBe(true);
    expect(isStockValueSort('closing')).toBe(false);
  });
});
```

The second test is the important one: it walks the real list of movement kinds, so it fails if a new kind is put in no
column by mistake (`null`) instead of on purpose.

### `report-schedules.ts` (new): reports by email

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { shiftIsoDate } from './journal.js';
import { todayIn } from './numbering.js';
import {
  EXPORT_FORMATS,
  type ReportKind,
  reportExportInputSchema,
  REPORT_KINDS,
} from './reports.js';

// Scheduled report emails (step 21c): a report that goes by email by itself, daily, weekly or
// monthly, to members of the workspace.
//
// - A schedule keeps the report's filters and never its dates: each run works out its own period
//   (reportSchedulePeriod below), so "last month" is always last month.
// - Each person gets their own file, in their own language and with what their own permissions
//   show: one report_exports row per person. So the margin column reaches only the people who may
//   see it, and the file is on their Exports page too.
// - Who may read the report is checked again at every run. A person who lost the permission is left
//   out, and the person who made the schedule is told.
// - A schedule belongs to the workspace, not to the person who made it: the monthly report to the
//   director must not stop because an accountant left.

export const MAX_REPORT_SCHEDULES = 20;
export const MAX_REPORT_SCHEDULE_RECIPIENTS = 10;

// ---------------------------------------------------------------------------------------------
// When it runs. Times are in the workspace's time zone.

export const REPORT_SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ReportScheduleFrequency = (typeof REPORT_SCHEDULE_FREQUENCIES)[number];

// A whole hour: the worker looks for due schedules every 5 minutes, so a minute would promise more
// than it can keep
const hourSchema = z.number().int().min(0).max(23);

// A discriminated union, so a weekly schedule cannot exist without its day, and the form's type
// says so. dayOfMonth stops at 28: every month has it, so "the 31st" never has to mean something
// else in February.
export const reportScheduleWhenSchema = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('daily'), hour: hourSchema }),
  // 0 = Sunday, as Date.getUTCDay() counts
  z.object({
    frequency: z.literal('weekly'),
    hour: hourSchema,
    weekday: z.number().int().min(0).max(6),
  }),
  z.object({
    frequency: z.literal('monthly'),
    hour: hourSchema,
    dayOfMonth: z.number().int().min(1).max(28),
  }),
]);
export type ReportScheduleWhen = z.infer<typeof reportScheduleWhenSchema>;

function isRunDay(when: ReportScheduleWhen, isoDate: string): boolean {
  switch (when.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return new Date(`${isoDate}T00:00:00Z`).getUTCDay() === when.weekday;
    case 'monthly':
      return Number(isoDate.slice(8, 10)) === when.dayOfMonth;
  }
}

// How far a time zone is ahead of UTC at one moment, in milliseconds. Intl is the only thing in
// the runtime that knows the zones, and it speaks in wall-clock parts, so the parts are read back
// as if they were UTC and the difference is the offset.
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value);
  const wallClock = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  // Intl's parts have no milliseconds, so the instant must lose them too
  return wallClock - Math.floor(instant / 1000) * 1000;
}

// The moment a wall clock in a time zone shows this date and whole hour. The offset is read twice:
// the first guess can land on the other side of a clock change. An hour that a clock change skips
// or repeats resolves to one of its neighbours, which is good enough for a report email.
function atHourIn(isoDate: string, hour: number, timeZone: string): Date {
  const wall = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
    hour,
  );
  const first = wall - zoneOffset(wall, timeZone);
  return new Date(wall - zoneOffset(first, timeZone));
}

// The first run strictly after `after`. The API calls it when a schedule is saved, the worker after
// each run. Strictly after: a run that finishes at its own time must move on to the next one.
export function nextReportScheduleRun(
  when: ReportScheduleWhen,
  timeZone: string,
  after: Date,
): Date {
  const today = todayIn(timeZone, after);
  // Ends: every frequency has a run day within 31 days of any date
  for (let offset = 0; ; offset += 1) {
    const day = shiftIsoDate(today, offset);
    if (!isRunDay(when, day)) continue;
    const run = atHourIn(day, when.hour, timeZone);
    if (run > after) return run;
  }
}

// ---------------------------------------------------------------------------------------------
// What each run covers

export interface ReportSchedulePeriod {
  from: string;
  to: string;
}

// Worked out from the day of the run, in the workspace's time zone. It never includes that day: a
// report sent at 08:00 about today would be a third of a day. Daily is yesterday, weekly is the
// seven days up to yesterday, monthly is the whole of the month before.
export function reportSchedulePeriod(
  frequency: ReportScheduleFrequency,
  runDate: string,
): ReportSchedulePeriod {
  const yesterday = shiftIsoDate(runDate, -1);
  switch (frequency) {
    case 'daily':
      return { from: yesterday, to: yesterday };
    case 'weekly':
      return { from: shiftIsoDate(yesterday, -6), to: yesterday };
    case 'monthly': {
      const to = shiftIsoDate(`${runDate.slice(0, 7)}-01`, -1);
      return { from: `${to.slice(0, 7)}-01`, to };
    }
  }
}

// Whether a report covers a range of days or shows one day. The aging and the balance sheet show
// the last day of the period.
const REPORT_PERIOD_SHAPE = {
  trial_balance: 'range',
  profit_and_loss: 'range',
  balance_sheet: 'as_of',
  sales_report: 'range',
  purchase_report: 'range',
  ar_aging: 'as_of',
  ap_aging: 'as_of',
  vat_report: 'range',
  stock_movement: 'range',
} as const satisfies Record<ReportKind, 'range' | 'as_of'>;

// The fields a schedule does not keep. The comparison dates go too: "compare with" is a choice about
// one fixed period, and a schedule has none.
const PERIOD_FIELDS = new Set(['from', 'to', 'asOf', 'compareFrom', 'compareTo', 'compareAsOf']);

// The filters a schedule keeps out of the query the report page sent
export function reportScheduleFiltersOf(
  query: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [field, value] of Object.entries(query)) {
    if (value !== undefined && !PERIOD_FIELDS.has(field)) filters[field] = value;
  }
  return filters;
}

// One run's query: the kept filters and the run's dates. The export handler parses it with the
// report's own schema, as it does every export.
export function reportScheduleQuery(
  report: ReportKind,
  filters: Readonly<Record<string, string>>,
  period: ReportSchedulePeriod,
): Record<string, string> {
  return REPORT_PERIOD_SHAPE[report] === 'as_of'
    ? { ...filters, asOf: period.to }
    : { ...filters, from: period.from, to: period.to };
}

// ---------------------------------------------------------------------------------------------
// What is sent and answered

// Member user ids. Whether each one may read the report is the API's check.
const recipientIdsSchema = z
  .array(z.uuid())
  .min(1, { error: errorCode('report_schedule_recipients_needed') })
  .max(MAX_REPORT_SCHEDULE_RECIPIENTS, { error: errorCode('report_schedule_recipients_too_many') })
  .refine((ids) => new Set(ids).size === ids.length, {
    error: errorCode('report_schedule_recipient_invalid'),
  });

// The same report, format and query as an export, plus when and to whom. The page sends the query
// it already has, dates included, so the report's own schema checks the filters (a sort the group
// has no column for, say). The API keeps only reportScheduleFiltersOf() of it.
export const reportScheduleInputSchema = reportExportInputSchema.and(
  z.object({ when: reportScheduleWhenSchema, recipientIds: recipientIdsSchema }),
);
export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>;

// The report and its filters stay as they were made. Other filters are a new schedule, made from
// the report page, where the filters are.
export const reportScheduleUpdateSchema = z.object({
  format: z.enum(EXPORT_FORMATS),
  when: reportScheduleWhenSchema,
  recipientIds: recipientIdsSchema,
  version: versionSchema,
});
export type ReportScheduleUpdate = z.infer<typeof reportScheduleUpdateSchema>;

export const reportScheduleVersionSchema = z.object({ version: versionSchema });

export const REPORT_SCHEDULE_STATUSES = ['active', 'paused'] as const;
export type ReportScheduleStatus = (typeof REPORT_SCHEDULE_STATUSES)[number];

// manual: someone pressed Pause. no_recipients: nobody on it may read the report any more.
export const REPORT_SCHEDULE_PAUSE_REASONS = ['manual', 'no_recipients'] as const;
export type ReportSchedulePauseReason = (typeof REPORT_SCHEDULE_PAUSE_REASONS)[number];

export const reportScheduleRecipientSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  // false: they stopped being a member or lost the report's permission. The list says so, because
  // this person gets no email until that changes.
  canReceive: z.boolean(),
});
export type ReportScheduleRecipient = z.infer<typeof reportScheduleRecipientSchema>;

export const reportScheduleSchema = z.object({
  id: z.uuid(),
  version: versionSchema,
  // z.string(), like an export: the app narrows them with isReportKind() and isExportFormat()
  report: z.string(),
  format: z.string(),
  when: reportScheduleWhenSchema,
  filters: z.record(z.string(), z.string()),
  // The names of the filters' ids, for the list. null when that filter is not set. A branch and a
  // warehouse are "HO · Head office", as the report pages' selects name them.
  filterNames: z.object({
    branch: z.string().nullable(),
    warehouse: z.string().nullable(),
    group: z.string().nullable(),
    category: z.string().nullable(),
  }),
  recipients: z.array(reportScheduleRecipientSchema),
  status: z.enum(REPORT_SCHEDULE_STATUSES),
  pausedReason: z.enum(REPORT_SCHEDULE_PAUSE_REASONS).nullable(),
  // null while paused
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  createdByName: z.string(),
  createdAt: z.iso.datetime(),
});
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;

// Not paged: a workspace has at most MAX_REPORT_SCHEDULES. The time zone is what `hour` means.
export const reportScheduleListSchema = z.object({
  items: z.array(reportScheduleSchema),
  timeZone: z.string(),
});
export type ReportScheduleList = z.infer<typeof reportScheduleListSchema>;

export const reportScheduleRecipientQuerySchema = z.object({ report: z.enum(REPORT_KINDS) });

export const reportScheduleCandidateListSchema = z.object({
  items: z.array(reportScheduleRecipientSchema.omit({ canReceive: true })),
});
export type ReportScheduleCandidateList = z.infer<typeof reportScheduleCandidateListSchema>;

const reportScheduleParamsSchema = z.object({ id: z.uuid() });

// The permission here says who may manage schedules at all. The API also checks the report's own
// permission (REPORT_KIND_PERMISSIONS), and the list leaves out the schedules of reports this
// person may not read.
const scheduleRouteBase = { auth: 'bearer', permission: 'core.report.schedule' } as const;

export const reportScheduleRoutes = {
  list: defineRoute({
    ...scheduleRouteBase,
    method: 'GET',
    path: '/report-schedules',
    summary: "The workspace's scheduled report emails",
    status: 200,
    response: reportScheduleListSchema,
  }),
  // Only the people who could get this report, so the form can offer nobody else
  candidates: defineRoute({
    ...scheduleRouteBase,
    method: 'GET',
    path: '/report-schedules/recipients',
    summary: 'The members who may read a report and so may get it by email',
    status: 200,
    query: reportScheduleRecipientQuerySchema,
    response: reportScheduleCandidateListSchema,
  }),
  create: defineRoute({
    ...scheduleRouteBase,
    method: 'POST',
    path: '/report-schedules',
    summary: 'Send a report by email on a schedule',
    status: 201,
    body: reportScheduleInputSchema,
    response: reportScheduleSchema,
  }),
  update: defineRoute({
    ...scheduleRouteBase,
    method: 'PUT',
    path: '/report-schedules/:id',
    summary: 'Change when a scheduled report goes, in which format and to whom',
    status: 200,
    params: reportScheduleParamsSchema,
    body: reportScheduleUpdateSchema,
    response: reportScheduleSchema,
  }),
  pause: defineRoute({
    ...scheduleRouteBase,
    method: 'POST',
    path: '/report-schedules/:id/pause',
    summary: 'Stop sending a scheduled report for now',
    status: 200,
    params: reportScheduleParamsSchema,
    body: reportScheduleVersionSchema,
    response: reportScheduleSchema,
  }),
  // Refused (report_schedule_no_recipients) when nobody on it may read the report now
  resume: defineRoute({
    ...scheduleRouteBase,
    method: 'POST',
    path: '/report-schedules/:id/resume',
    summary: 'Start sending a paused report again',
    status: 200,
    params: reportScheduleParamsSchema,
    body: reportScheduleVersionSchema,
    response: reportScheduleSchema,
  }),
  remove: defineRoute({
    ...scheduleRouteBase,
    method: 'DELETE',
    path: '/report-schedules/:id',
    summary: 'Delete a scheduled report',
    status: 204,
    params: reportScheduleParamsSchema,
    response: z.void(),
  }),
};
```

Why it is written this way:

- **`MAX_REPORT_SCHEDULES` and `MAX_REPORT_SCHEDULE_RECIPIENTS` are exported.** The API checks them (20 per workspace,
  `report_schedule_limit`), the Zod schema checks the 10, and the form uses them to say how many are left.
- **`hourSchema` is a whole hour** (decision 13).
- **`dayOfMonth` stops at 28.** Every month has a 28th, so the schedule never has to decide what "the 31st" means in
  February. The period is the whole month before anyway (decision 8), so the day only says when it is sent.
- **`isRunDay()` reads the weekday with `getUTCDay()` on a date at midnight UTC.** The date is already the
  workspace's local date (from `todayIn()`), so reading it in UTC gives that date's weekday on any server. `getDay()`
  would use the server's own time zone and could give the day before.
- **`zoneOffset()`.** JavaScript has no "this wall clock in that zone" function. `Intl.DateTimeFormat` turns an instant
  into the zone's wall-clock parts; reading those parts back as if they were UTC and taking the difference gives the
  zone's offset at that instant. `hourCycle: 'h23'` matters: with the default, some engines write midnight as hour 24,
  and the date would move a day. The instant loses its milliseconds before the difference, because the parts have
  none.
- **`atHourIn()` reads the offset twice.** The first guess uses the offset at the wall-clock time read as UTC, which
  can be on the other side of a clock change. Reading it again at the first guess fixes that. The tests check both a
  change back (New York, 1 November) and a change forward (8 March). An hour that a change skips or repeats lands on
  one of its neighbours, which is good enough for an email.
- **`nextReportScheduleRun()` is strictly after `after`.** The worker calls it with the moment the run started; with
  "at or after" a run at 08:00:00 would find itself again. The loop has no end condition because every frequency has a
  run day within 31 days of any date.
- **`reportSchedulePeriod()` takes the run's date, not a moment.** The worker passes the run day in the workspace's
  zone, so the period is the same whatever the server's zone. Monthly works from the 1st of the run's month back one
  day, so February's 28 or 29 days and the year end need no special code.
- **`REPORT_PERIOD_SHAPE` with `satisfies Record<ReportKind, …>`.** A new kind of report does not compile until
  someone says whether it covers a range or one day.
- **`reportScheduleFiltersOf()` drops every date field, compare dates included** (decision 28). It also drops
  `undefined`, so the stored filters are plain strings, and the query of a run is
  `{ ...filters, from, to }` or `{ ...filters, asOf }`: the export handler parses it with the report's own schema, as
  it does any export.
- **`recipientIdsSchema`'s three error codes.** The form shows each one under the people picker, and each says what to
  fix: pick someone, pick fewer, pick each person once.
- **`reportScheduleInputSchema = reportExportInputSchema.and(…)`.** An intersection with the export's discriminated
  union: the `report` field still picks the right query schema, and the type is "an export input plus `when` and
  `recipientIds`". The OpenAPI document shows it as `allOf`.
- **`reportScheduleUpdateSchema` has no `report` and no query** (decision 10).
- **`report` and `format` are `z.string()` in the answer**, as on an export (21b): the app narrows them with
  `isReportKind()` and `isExportFormat()`, so an older app does not break on a newer kind.
- **`nextRunAt` is null while paused**, so the list can say "Paused" without a second field to keep in step.
- **`candidates` is its own route.** The members list the app already has does not know who may read which report;
  only the API can say, from the roles. It answers without `canReceive`, because everyone on it can.
- **`scheduleRouteBase` and the second check.** The route's permission is `core.report.schedule`; the API also checks
  the report's own permission (`REPORT_KIND_PERMISSIONS`), so a person cannot schedule a report they could not open.
- **`remove` answers 204 with `z.void()`**, like the other deletes.

```ts
import { describe, expect, it } from 'vitest';

import {
  nextReportScheduleRun,
  reportScheduleFiltersOf,
  reportScheduleInputSchema,
  reportSchedulePeriod,
  reportScheduleQuery,
} from './report-schedules.js';

const DHAKA = 'Asia/Dhaka';
const NEW_YORK = 'America/New_York';

describe('nextReportScheduleRun', () => {
  const daily = { frequency: 'daily', hour: 8 } as const;

  it('takes today when the hour is still ahead in the workspace', () => {
    // 01:30 UTC is 07:30 in Dhaka
    expect(nextReportScheduleRun(daily, DHAKA, new Date('2026-11-09T01:30:00Z'))).toEqual(
      new Date('2026-11-09T02:00:00Z'),
    );
  });

  it('moves on from a run that has just happened', () => {
    expect(nextReportScheduleRun(daily, DHAKA, new Date('2026-11-09T02:00:00Z'))).toEqual(
      new Date('2026-11-10T02:00:00Z'),
    );
  });

  it('uses the workspace day, not the UTC day', () => {
    // 02:00 UTC on the 9th is still 21:00 on the 8th in New York, so 22:00 is one hour away. The
    // UTC day would skip it and wait until 22:00 on the 9th.
    expect(
      nextReportScheduleRun(
        { frequency: 'daily', hour: 22 },
        NEW_YORK,
        new Date('2026-11-09T02:00:00Z'),
      ),
    ).toEqual(new Date('2026-11-09T03:00:00Z'));
  });

  it('finds the weekday, counting 0 as Sunday', () => {
    // 2026-11-09 is a Monday; the next Sunday is the 15th
    expect(
      nextReportScheduleRun(
        { frequency: 'weekly', hour: 8, weekday: 0 },
        DHAKA,
        new Date('2026-11-09T06:00:00Z'),
      ),
    ).toEqual(new Date('2026-11-15T02:00:00Z'));
  });

  it('goes to next month once the day has passed, across a year end', () => {
    expect(
      nextReportScheduleRun(
        { frequency: 'monthly', hour: 8, dayOfMonth: 1 },
        DHAKA,
        new Date('2026-12-01T03:00:00Z'),
      ),
    ).toEqual(new Date('2027-01-01T02:00:00Z'));
  });

  it('keeps the wall clock across a change of the clocks', () => {
    // New York left summer time on 2026-11-01: 08:00 is 12:00 UTC before it and 13:00 UTC after
    expect(nextReportScheduleRun(daily, NEW_YORK, new Date('2026-10-31T13:00:00Z'))).toEqual(
      new Date('2026-11-01T13:00:00Z'),
    );
    expect(nextReportScheduleRun(daily, NEW_YORK, new Date('2026-10-30T13:00:00Z'))).toEqual(
      new Date('2026-10-31T12:00:00Z'),
    );
  });

  it('finds an hour just after the clocks go forward', () => {
    // New York jumped from 02:00 to 03:00 on 2026-03-08, so 03:00 that day is 07:00 UTC. Reading the
    // offset only once, from the night before, would give 08:00 UTC, which is 04:00 on the clock.
    expect(
      nextReportScheduleRun(
        { frequency: 'daily', hour: 3 },
        NEW_YORK,
        new Date('2026-03-07T12:00:00Z'),
      ),
    ).toEqual(new Date('2026-03-08T07:00:00Z'));
  });
});

describe('reportSchedulePeriod', () => {
  it('daily is yesterday', () => {
    expect(reportSchedulePeriod('daily', '2026-11-09')).toEqual({
      from: '2026-11-08',
      to: '2026-11-08',
    });
  });

  it('weekly is the seven days up to yesterday', () => {
    expect(reportSchedulePeriod('weekly', '2026-11-09')).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
  });

  it('monthly is the whole month before, also over a leap February and a year end', () => {
    expect(reportSchedulePeriod('monthly', '2028-03-15')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(reportSchedulePeriod('monthly', '2027-01-01')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('the filters of a schedule', () => {
  it('keeps the filters and drops every date', () => {
    expect(
      reportScheduleFiltersOf({
        from: '2026-07-01',
        to: '2026-07-31',
        compareFrom: '2025-07-01',
        compareTo: '2025-07-31',
        branchId: 'b',
        categoryId: undefined,
      }),
    ).toEqual({ branchId: 'b' });
  });

  it('gives a range report its dates and an as-of report the last day', () => {
    const period = { from: '2026-10-01', to: '2026-10-31' };
    expect(reportScheduleQuery('vat_report', { branchId: 'b' }, period)).toEqual({
      branchId: 'b',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(reportScheduleQuery('ar_aging', { show: 'all' }, period)).toEqual({
      show: 'all',
      asOf: '2026-10-31',
    });
  });
});

describe('reportScheduleInputSchema', () => {
  const recipient = '0198b0a0-0000-7000-8000-000000000001';
  const valid = {
    report: 'vat_report',
    format: 'pdf',
    query: { from: '2026-10-01', to: '2026-10-31' },
    when: { frequency: 'monthly', hour: 8, dayOfMonth: 1 },
    recipientIds: [recipient],
  };

  it('takes an export query plus when and to whom', () => {
    expect(reportScheduleInputSchema.safeParse(valid).success).toBe(true);
  });

  it('needs the day of a weekly schedule', () => {
    expect(
      reportScheduleInputSchema.safeParse({ ...valid, when: { frequency: 'weekly', hour: 8 } })
        .success,
    ).toBe(false);
  });

  it('stops at the 28th, which every month has', () => {
    expect(
      reportScheduleInputSchema.safeParse({
        ...valid,
        when: { frequency: 'monthly', hour: 8, dayOfMonth: 29 },
      }).success,
    ).toBe(false);
  });

  it('refuses nobody, too many people and the same person twice', () => {
    const message = (recipientIds: string[]): string | undefined =>
      reportScheduleInputSchema.safeParse({ ...valid, recipientIds }).error?.issues[0]?.message;
    expect(message([])).toBe('report_schedule_recipients_needed');
    expect(message(Array.from({ length: 11 }, () => recipient))).toBe(
      'report_schedule_recipients_too_many',
    );
    expect(message([recipient, recipient])).toBe('report_schedule_recipient_invalid');
  });
});
```

The tests use two zones on purpose: Dhaka (UTC+6, no clock changes) for the usual case, New York for the day that
differs from the UTC day and for both clock changes. The test "uses the workspace day, not the UTC day" catches the
easy mistake of starting the search from the UTC date.

### `reports.ts`: two new kinds of export

```diff
@@ -10,7 +10,9 @@ import { periodOf } from './numbering.js';
 import { pageOf, pageQuerySchema } from './pagination.js';
 import { shiftIsoDate } from './journal.js';
 import type { PermissionKey } from './permissions.js';
+import { stockMovementFilterSchema } from './stock-movement-report.js';
 import { purchaseReportFilterSchema, salesReportFilterSchema } from './trade-reports.js';
+import { vatReportFilterSchema } from './vat-report.js';
 
 // ---------------------------------------------------------------------------------------------
 // Fiscal years. The workspace's settings say in which month a year starts (July in Bangladesh).
@@ -38,8 +40,9 @@ export function fiscalYearLabel(start: string, startMonth: number): string {
 
 // ---------------------------------------------------------------------------------------------
 // The reports a file can be made of: the three statements here, and since step 21b the sales and
-// purchase reports (trade-reports.ts) and the two agings (aging.ts). Every amount is a decimal
-// string with 4 places, like the ledger.
+// purchase reports (trade-reports.ts) and the two agings (aging.ts), since step 21c the VAT report
+// (vat-report.ts) and the stock movement report (stock-movement-report.ts). Every amount is a
+// decimal string with 4 places, like the ledger.
 
 export const REPORT_KINDS = [
   'trial_balance',
@@ -49,6 +52,8 @@ export const REPORT_KINDS = [
   'purchase_report',
   'ar_aging',
   'ap_aging',
+  'vat_report',
+  'stock_movement',
 ] as const;
 export type ReportKind = (typeof REPORT_KINDS)[number];
 
@@ -67,6 +72,8 @@ export const REPORT_KIND_PERMISSIONS = {
   purchase_report: 'purchase.report.read',
   ar_aging: 'sales.report.read',
   ap_aging: 'purchase.report.read',
+  vat_report: 'accounting.report.read',
+  stock_movement: 'inventory.report.read',
 } as const satisfies Record<ReportKind, PermissionKey>;
 
 // The kinds a person may export, in REPORT_KINDS' order. Plain strings, like dashboardCardsFor():
@@ -455,6 +462,16 @@ export const reportExportInputSchema = z.discriminatedUnion('report', [
     format: z.enum(EXPORT_FORMATS),
     query: apAgingFilterSchema,
   }),
+  z.object({
+    report: z.literal('vat_report'),
+    format: z.enum(EXPORT_FORMATS),
+    query: vatReportFilterSchema,
+  }),
+  z.object({
+    report: z.literal('stock_movement'),
+    format: z.enum(EXPORT_FORMATS),
+    query: stockMovementFilterSchema,
+  }),
 ]);
 export type ReportExportInput = z.infer<typeof reportExportInputSchema>;
 
```

- **The two kinds go at the end of `REPORT_KINDS`.** `reportKindsFor()` answers in this order, so the earlier kinds
  keep their places and its existing test changes by one line only.
- **`REPORT_KIND_PERMISSIONS`** gives each one the same permission as its page (decisions 11 and 20), so the export
  routes check them with no new code.
- **The export union gets two members**, with the filter schemas (no page), as the 21b kinds have.

```diff
@@ -93,6 +93,7 @@ describe('reportKindsFor', () => {
       'trial_balance',
       'profit_and_loss',
       'balance_sheet',
+      'vat_report',
     ]);
   });
 });
```

A person with only `accounting.report.read` may now export the VAT report too.

### `permissions.ts`, `notifications.ts`, `errors.ts`

```diff
@@ -10,6 +10,7 @@ export const PERMISSION_KEYS = [
   'core.settings.manage',
   'core.branch.manage',
   'core.audit.read',
+  'core.report.schedule',
   'accounting.account.manage',
   'accounting.journal.read',
   'accounting.journal.create',
@@ -84,6 +85,7 @@ export const PERMISSION_GROUP_OF = {
   'core.settings.manage': 'workspace',
   'core.branch.manage': 'workspace',
   'core.audit.read': 'workspace',
+  'core.report.schedule': 'workspace',
   'accounting.account.manage': 'accounting',
   'accounting.journal.read': 'accounting',
   'accounting.journal.create': 'accounting',
```

`core.report.schedule` is in the Workspace group, beside `core.audit.read`: it is about the workspace's emails, not about
one module. Which role templates get it is in the database part (21c.2).

```diff
@@ -21,12 +21,21 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // pos.shift_variance: params { id, number, register, difference } — a shift's closing count was
 // more than its register's limit over or short (difference: counted less expected, signed); sent
 // to the owners and the people with pos.shift.manage, and the bell opens the shift
+// report.schedule_skipped: params { report, count } — a scheduled report was not sent to count
+// people, because they can no longer read it; sent to the person who made the schedule
+// report.schedule_paused: params { report } — nobody on the schedule can read the report any more,
+// so it stopped; sent to the person who made the schedule
+// report.schedule_failed: params { report, format } — one person's file or email could not be made
+// or sent; sent to the person who made the schedule
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
   'invitation.failed',
   'report.ready',
   'report.failed',
+  'report.schedule_skipped',
+  'report.schedule_paused',
+  'report.schedule_failed',
   'import.done',
   'import.failed',
   'stock.low',
```

The comment above the list says what each bell's `params` hold, as for the earlier types: the words in `en.ts` and
`bn.ts` read them, and the worker writes them.

```diff
@@ -95,6 +95,12 @@ export const ERROR_CODES = [
   'report_compare_incomplete',
   // Step 21b: a sort the report's group has no column for (quantity outside the product group)
   'report_sort_invalid',
+  // Step 21c: scheduled report emails
+  'report_schedule_limit',
+  'report_schedule_recipients_needed',
+  'report_schedule_recipients_too_many',
+  'report_schedule_recipient_invalid',
+  'report_schedule_no_recipients',
   'year_end_invalid',
   'year_not_ended',
   'year_already_closed',
```

- `report_schedule_limit`: the workspace already has 20.
- `report_schedule_recipients_needed`, `report_schedule_recipients_too_many`, `report_schedule_recipient_invalid`: the
  people picker (nobody, more than 10, the same person twice, or someone who may not read the report).
- `report_schedule_no_recipients`: Resume while nobody on the schedule may read the report.

### `routes.ts`, `index.ts`

```diff
@@ -16,7 +16,9 @@ import { memberRoutes } from './members.js';
 import { notificationRoutes } from './notifications.js';
 import { numberSeriesRoutes } from './numbering.js';
 import { meRoutes } from './preferences.js';
+import { reportScheduleRoutes } from './report-schedules.js';
 import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
+import { stockMovementReportRoutes } from './stock-movement-report.js';
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
 import { customerGroupRoutes, customerRoutes } from './customers.js';
@@ -59,6 +61,7 @@ import { supplierGroupRoutes, supplierRoutes } from './suppliers.js';
 import { syncRoutes } from './sync.js';
 import { taxRateRoutes } from './tax-rates.js';
 import { tradeReportRoutes } from './trade-reports.js';
+import { vatReportRoutes } from './vat-report.js';
 import { unitRoutes } from './units.js';
 import { warehouseRoutes } from './warehouses.js';
 
@@ -100,6 +103,9 @@ export const routes = {
   dashboard: dashboardRoutes,
   tradeReports: tradeReportRoutes,
   aging: agingRoutes,
+  vatReport: vatReportRoutes,
+  stockMovementReport: stockMovementReportRoutes,
+  reportSchedules: reportScheduleRoutes,
   units: unitRoutes,
   productCategories: productCategoryRoutes,
   customFields: customFieldRoutes,
```

```diff
@@ -44,6 +44,7 @@ export * from './quantities.js';
 export * from './quotations.js';
 export * from './receipts.js';
 export * from './refunds.js';
+export * from './report-schedules.js';
 export * from './reports.js';
 export * from './requisitions.js';
 export * from './roles.js';
@@ -54,6 +55,7 @@ export * from './sales-orders.js';
 export * from './sales-returns.js';
 export * from './settings.js';
 export * from './setup.js';
+export * from './stock-movement-report.js';
 export * from './stock.js';
 export * from './stock-accounts.js';
 export * from './stock-adjustments.js';
@@ -67,4 +69,5 @@ export * from './sync.js';
 export * from './tax-rates.js';
 export * from './trade-reports.js';
 export * from './units.js';
+export * from './vat-report.js';
 export * from './warehouses.js';
```

The OpenAPI document is generated from the built package (`@omnivo/contracts` points at `dist/`), so build it first:

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts gen:openapi
```

It adds the eight new routes (two VAT, one stock movement, five schedules) to `packages/contracts/openapi.json` and the
five new codes to every list of error codes in it. Commit it as it is.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
pnpm exec eslint packages/contracts/src
```

All pass (contracts 406 tests, 24 new). Do not run the whole `pnpm typecheck` yet. Until their parts, these fail, as
expected:

- `packages/i18n`: no English words for the five new error codes (21c.5).
- `packages/db`: `permission-catalog.ts` has no label for `core.report.schedule` (21c.2).
- `apps/api`: the export's words and titles and the export handler's `switch` have no case for the two kinds (21c.3).
  Build `packages/db` first, as in 21b.
- `apps/app`: no words for the two kinds, the three bells and the new permission (21c.5).

## 21c.2 — `packages/db`: the tables

Two tables for the schedules, one index for the stock movement report, and the new permission's words. No change to
`report_exports`: a scheduled run writes ordinary export rows (decision 7).

### `schema/report-schedules.ts` (new)

```ts
import {
  EXPORT_FORMATS,
  REPORT_KINDS,
  REPORT_SCHEDULE_FREQUENCIES,
  REPORT_SCHEDULE_PAUSE_REASONS,
  REPORT_SCHEDULE_STATUSES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// Step 21c: a report that goes by email by itself (the contract's report-schedules.ts). The worker
// finds the due rows by next_run_at; each run writes one report_exports row per recipient. The
// rules on who may read what live in migration 0062.

export const reportSchedules = pgTable(
  'report_schedules',
  {
    // baseColumns without deleted_at: Delete removes a schedule for real (decision 34). The files
    // it already sent are report_exports rows of their own, which do not point back here, so they
    // stay. version: Update, Pause and Resume carry it.
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Fixed once saved (decision 10): the API's update has no field for them
    report: text('report', { enum: REPORT_KINDS }).notNull(),
    format: text('format', { enum: EXPORT_FORMATS }).notNull(),
    // The contract's reportScheduleWhenSchema, as columns: the checks below then keep a weekly row
    // with its day and a daily row without one, which a jsonb column could not promise
    frequency: text('frequency', { enum: REPORT_SCHEDULE_FREQUENCIES }).notNull(),
    hour: smallint('hour').notNull(),
    // 0 = Sunday. Only on a weekly schedule.
    weekday: smallint('weekday'),
    // 1–28. Only on a monthly schedule.
    dayOfMonth: smallint('day_of_month'),
    // The report's filters without the dates (reportScheduleFiltersOf()). The worker parses them
    // again with the report's own schema at every run, as it does every export's query.
    filters: jsonb('filters').$type<Record<string, string>>().notNull().default({}),
    status: text('status', { enum: REPORT_SCHEDULE_STATUSES }).notNull().default('active'),
    pausedReason: text('paused_reason', { enum: REPORT_SCHEDULE_PAUSE_REASONS }),
    // When the sweep should hand it to the worker. NULL while paused, so the sweep's index holds
    // only the schedules that can run.
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    // Who made it gets the bells (decision 12). Required here, unlike baseColumns' createdBy: a
    // schedule is only ever made by a person.
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    // The recipients' foreign key
    uniqueIndex('report_schedules_tenant_id_idx').on(table.tenantId, table.id),
    // The sweep, every 5 minutes, across every workspace: so not tenant first. Partial, so the
    // paused schedules are not in it.
    index('report_schedules_due_idx')
      .on(table.nextRunAt)
      .where(sql`${table.nextRunAt} IS NOT NULL`),
    check('report_schedules_hour_check', sql`${table.hour} BETWEEN 0 AND 23`),
    // Each day field belongs to its frequency, and only to it
    check(
      'report_schedules_weekday_check',
      sql`(${table.frequency} = 'weekly') = (${table.weekday} IS NOT NULL) AND (${table.weekday} IS NULL OR ${table.weekday} BETWEEN 0 AND 6)`,
    ),
    check(
      'report_schedules_day_of_month_check',
      sql`(${table.frequency} = 'monthly') = (${table.dayOfMonth} IS NOT NULL) AND (${table.dayOfMonth} IS NULL OR ${table.dayOfMonth} BETWEEN 1 AND 28)`,
    ),
    // A paused schedule says why and never runs; an active one always has its next run
    check(
      'report_schedules_status_check',
      sql`(${table.status} = 'paused') = (${table.pausedReason} IS NOT NULL) AND (${table.status} = 'active') = (${table.nextRunAt} IS NOT NULL)`,
    ),
  ],
);

// Who gets it, in the order they were picked. A save replaces all of a schedule's rows.
export const reportScheduleRecipients = pgTable(
  'report_schedule_recipients',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scheduleId: uuid('schedule_id').notNull(),
    // 1 = picked first
    position: smallint('position').notNull(),
    // A user, not a membership: someone who left the workspace stays on the list, shown as
    // "cannot receive it" (canReceive), until someone takes them off. Members are only ever
    // soft-deleted, so a user row never goes away.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    uniqueIndex('report_schedule_recipients_position_idx').on(
      table.tenantId,
      table.scheduleId,
      table.position,
    ),
    // The contract's report_schedule_recipient_invalid again: each person once
    primaryKey({
      name: 'report_schedule_recipients_pkey',
      columns: [table.tenantId, table.scheduleId, table.userId],
    }),
    foreignKey({
      name: 'report_schedule_recipients_schedule_fk',
      columns: [table.tenantId, table.scheduleId],
      foreignColumns: [reportSchedules.tenantId, reportSchedules.id],
    }).onDelete('cascade'),
    // 10 = the contract's MAX_REPORT_SCHEDULE_RECIPIENTS; with the unique position, a schedule
    // never has more
    check('report_schedule_recipients_position_check', sql`${table.position} BETWEEN 1 AND 10`),
  ],
);
```

Why it is written this way:

- **The base columns one by one, without `deleted_at`.** Delete removes a schedule for real (decision 34), so a
  `deleted_at` would be a column nothing ever sets. `version` stays: Update, Pause and Resume send it.
- **`created_by` is `NOT NULL` with a foreign key**, unlike `baseColumns().createdBy`. A schedule is always made by a
  person, and the bells go to that person (decision 12); a NULL would mean bells to nobody without anyone noticing.
- **`frequency`, `hour`, `weekday`, `day_of_month` as columns** (decision 35). Each day check is written as
  `(frequency = 'weekly') = (weekday IS NOT NULL)`: true on both sides or false on both sides. So a weekly row must
  have a day, and a daily or monthly one must not. The ranges (0–6, 1–28, 0–23) repeat the contract's, so a row
  written by hand cannot be a schedule the API would refuse.
- **`report_schedules_status_check` ties three columns together.** Paused always has a reason and never a next run;
  active always has a next run. The sweep then only has to ask for `next_run_at <= now()`: a paused schedule cannot
  slip in, whatever the code that paused it forgot.
- **`report_schedules_due_idx` is on `next_run_at` alone, and partial.** The sweep looks across every workspace, so an
  index that starts with `tenant_id` would not help it. `WHERE next_run_at IS NOT NULL` leaves the paused ones out.
- **`report_schedules_tenant_id_idx` on `(tenant_id, id)`** exists for the recipients' foreign key, which includes the
  tenant, so a recipient row can never point at another workspace's schedule.
- **The recipients' primary key is `(tenant_id, schedule_id, user_id)`** (decision 36). It is the database's copy of
  the contract's `report_schedule_recipient_invalid`: each person once. The unique `position` with its check
  (1–10) is the copy of `MAX_REPORT_SCHEDULE_RECIPIENTS`, the same way the approval levels keep their limit of five.
- **`ON DELETE CASCADE` on the schedule's foreign key**: deleting a schedule takes its recipients with it, in the same
  statement.

### `schema/index.ts`, `schema/stock.ts`, `permission-catalog.ts`

```diff
@@ -51,3 +51,4 @@ export * from './debit-notes.js';
 export * from './supplier-refunds.js';
 export * from './sync.js';
 export * from './pos.js';
+export * from './report-schedules.js';
```

```diff
@@ -65,6 +65,11 @@ export const stockMovements = pgTable(
     index('stock_movements_product_idx').on(table.tenantId, table.productId, table.variantId),
     index('stock_movements_warehouse_idx').on(table.tenantId, table.warehouseId),
     index('stock_movements_document_idx').on(table.tenantId, table.documentId),
+    // Step 21c: the stock movement report. The opening stock is the balance now less the
+    // movements dated from the report's first day on (decision 5), and the columns add up the
+    // movements of the period: both read a range of dates across every variant, which the
+    // stock card's index (variant first) cannot serve.
+    index('stock_movements_date_idx').on(table.tenantId, table.date),
     // No ON DELETE: a variant with movements cannot be deleted, so neither can its product (the
     // API turns this FK's error into product_in_use / product_variant_in_use)
     foreignKey({
```

The stock movement report reads a range of dates for every variant at once: the opening stock is the balance now less
everything dated from the first day on (decision 5), and each column adds up the period. The stock card's index starts
with the variant, so it cannot serve that; without this one, every run of the report reads the whole ledger. With a
warehouse filter Postgres combines it with the warehouse index that is already there.

`CREATE INDEX` holds back new movements on this table while it builds. On a workspace with a few million movements that
is seconds, once, when you migrate. If it ever becomes minutes, build it by hand first with
`CREATE INDEX CONCURRENTLY` (which cannot run inside the migration's transaction) and the migration's `CREATE INDEX` then
needs `IF NOT EXISTS`.

```diff
@@ -14,6 +14,8 @@ const DESCRIPTIONS = {
   'core.settings.manage': 'Edit the company profile, regional settings and numbering',
   'core.branch.manage': 'Add, edit and archive branches',
   'core.audit.read': 'View the audit log',
+  'core.report.schedule':
+    'Send reports by email on a schedule, to members who may read them, and change or stop those emails',
   'accounting.account.manage':
     'Add, edit, move, archive and delete accounts in the chart of accounts',
   'accounting.journal.read': 'View journal entries, ledgers and opening balances',
```

The `satisfies Record<PermissionKey, string>` below the list has failed the db type check since 21c.1; this line ends
that. `pnpm db:migrate` writes the new permission into the `permissions` table (`syncPermissions()`).

### Migration 0061 (generated, then move the indexes up)

Run:

```bash
pnpm --filter @omnivo/db generate --name report-schedules
```

As in every step, `drizzle-kit` writes the foreign keys before the unique indexes they point at
(`report_schedules_tenant_id_idx`), and the migration fails with "there is no unique constraint matching given keys".
Move every `CREATE INDEX` and `CREATE UNIQUE INDEX` up, before the first `ADD CONSTRAINT … FOREIGN KEY`, and keep
`--> statement-breakpoint` at the end of every line except the last. The result:

```sql
CREATE TABLE "report_schedule_recipients" (
	"tenant_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "report_schedule_recipients_pkey" PRIMARY KEY("tenant_id","schedule_id","user_id"),
	CONSTRAINT "report_schedule_recipients_position_check" CHECK ("report_schedule_recipients"."position" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"report" text NOT NULL,
	"format" text NOT NULL,
	"frequency" text NOT NULL,
	"hour" smallint NOT NULL,
	"weekday" smallint,
	"day_of_month" smallint,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	CONSTRAINT "report_schedules_hour_check" CHECK ("report_schedules"."hour" BETWEEN 0 AND 23),
	CONSTRAINT "report_schedules_weekday_check" CHECK (("report_schedules"."frequency" = 'weekly') = ("report_schedules"."weekday" IS NOT NULL) AND ("report_schedules"."weekday" IS NULL OR "report_schedules"."weekday" BETWEEN 0 AND 6)),
	CONSTRAINT "report_schedules_day_of_month_check" CHECK (("report_schedules"."frequency" = 'monthly') = ("report_schedules"."day_of_month" IS NOT NULL) AND ("report_schedules"."day_of_month" IS NULL OR "report_schedules"."day_of_month" BETWEEN 1 AND 28)),
	CONSTRAINT "report_schedules_status_check" CHECK (("report_schedules"."status" = 'paused') = ("report_schedules"."paused_reason" IS NOT NULL) AND ("report_schedules"."status" = 'active') = ("report_schedules"."next_run_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedule_recipients_position_idx" ON "report_schedule_recipients" USING btree ("tenant_id","schedule_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedules_tenant_id_idx" ON "report_schedules" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "report_schedules" USING btree ("next_run_at") WHERE "report_schedules"."next_run_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_date_idx" ON "stock_movements" USING btree ("tenant_id","date");--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."report_schedules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
```

Do not edit the snapshot (`meta/0061_snapshot.json`): it describes the tables, not the order of the statements.

### Migration 0062 (written by hand): the rules

```bash
pnpm --filter @omnivo/db generate --custom --name report-schedules-rules
```

Then put this in the empty file:

```sql
-- Custom SQL migration file, put your code below! --
-- Step 21c: scheduled report emails. 0061 made the two tables; this file gives them their tenant
-- rules and lets the worker's sweep see when each schedule is due, and nothing more.

-- 1) The two new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['report_schedules', 'report_schedule_recipients'])
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

-- 2) The sweep (every 5 minutes) looks for the due schedules of EVERY workspace in one query, so
--    tenant_isolation alone would show it nothing. It reads as the worker's own role, like the
--    outbox relay (0012) and the sync log's cleanup (0044), with a policy for that role only.
--    Three columns, not the table: the sweep needs to know which schedule of which workspace is
--    due, never what it sends or to whom. The rest of the run (moving next_run_at on, writing the
--    outbox event, making the files) happens as omnivo_app inside that one workspace, so a bug in
--    the sweep can neither read another workspace's filters and recipients nor change a schedule.
--    omnivo_worker gets nothing on report_schedule_recipients.
GRANT SELECT (id, tenant_id, next_run_at) ON report_schedules TO omnivo_worker;
CREATE POLICY report_schedule_sweep ON report_schedules
  FOR SELECT
  TO omnivo_worker
  USING (true);
```

- **Section 1** is the same loop as every tenant table since 0002: `ENABLE` plus `FORCE`, so the table owner (the
  migrator) is held by the policy too, and `NULLIF`, so an empty `app.tenant_id` matches nothing instead of failing on
  `''::uuid`.
- **Section 2, `GRANT SELECT (id, tenant_id, next_run_at)`** (decision 37). A column grant: `SELECT *` or
  `SELECT filters` by `omnivo_worker` fails with "permission denied". The policy is `FOR SELECT` and `TO omnivo_worker`
  only, and policies are OR-ed, so `omnivo_app` still sees only its own workspace's rows. There is no `UPDATE` grant:
  the sweep moves `next_run_at` on as `omnivo_app`, inside the schedule's workspace, in the same transaction that
  writes the outbox event (21c.3). So a run is either handed over and moved on, or neither.
- **Nothing on `report_schedule_recipients`** for the worker. Who gets a report is read by the run, as `omnivo_app`.

### `setup/templates.ts`: who may schedule, in a new workspace

```diff
@@ -183,6 +183,12 @@ const TAKING_BACK_AT_COUNTER = ['pos.return.create'] as const;
 const SALES_REPORTS = ['sales.report.read'] as const;
 const PURCHASE_REPORTS = ['purchase.report.read'] as const;
 const STOCK_REPORTS = ['inventory.report.read'] as const;
+// Step 21c: sending reports by email on a schedule goes to the people who read every module's
+// reports, the same people who would forward them by hand today. A depot manager reads only the
+// stock reports, so a schedule they made would be about one module; an owner adds it to their role
+// in Settings → Roles if they want that. Each person on a schedule still gets only the reports
+// their own role may read.
+const SCHEDULING_REPORTS = ['core.report.schedule'] as const;
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
@@ -221,6 +227,8 @@ const ACCOUNTANT: RoleTemplate = {
     ...SALES_REPORTS,
     ...PURCHASE_REPORTS,
     ...STOCK_REPORTS,
+    // Step 21c: and sending them by email on a schedule
+    ...SCHEDULING_REPORTS,
   ],
 };
 
@@ -747,6 +755,7 @@ export const INDUSTRY_TEMPLATES = {
           ...SALES_REPORTS,
           ...PURCHASE_REPORTS,
           ...STOCK_REPORTS,
+          ...SCHEDULING_REPORTS,
         ],
       },
       {
@@ -824,6 +833,7 @@ export const INDUSTRY_TEMPLATES = {
           ...SALES_REPORTS,
           ...PURCHASE_REPORTS,
           ...STOCK_REPORTS,
+          ...SCHEDULING_REPORTS,
         ],
       },
     ],
```

Decision 38. The comment says why the depot manager does not get it, so the next person does not add it "for
completeness". A schedule does not widen anyone's view: each recipient still gets only what their own role may read.

```diff
@@ -139,6 +139,7 @@ describe('starting the setup', () => {
           'accounting.period.close',
           'accounting.report.read',
           'core.audit.read',
+          'core.report.schedule',
           'core.user.read',
           'inventory.report.read',
           'inventory.stock.revalue',
```

The setup test lists the Accountant's permissions in sorted order, so the new key goes after `core.audit.read`.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm --filter @omnivo/db build
pnpm exec eslint packages/db/src apps/api/src/setup
pnpm db:migrate
```

`pnpm db:migrate` should end with "migrations done". Then, in `psql` as the migrator, you can see the worker's limits
for yourself:

```sql
SET ROLE omnivo_worker;
SELECT id, tenant_id, next_run_at FROM report_schedules;  -- works, every workspace
SELECT filters FROM report_schedules;                     -- ERROR: permission denied
RESET ROLE;
```

What was checked on a throwaway database (all 63 migrations from empty): a weekly row without a day, a daily row with
one, the 29th, hour 24, an active row without a next run and a paused row without a reason or with a next run are all
refused; the same person twice and an 11th recipient are refused; a recipient row with another workspace's id is
refused by RLS; workspace B sees none of A's rows and no tenant context sees nothing; `omnivo_worker` sees the due ids of
both workspaces but cannot read the filters, read `*`, update, delete or read the recipients; a delete takes the
recipients with it. The setup tests pass (69).

The `apps/api` type check still fails in the export's words, titles and handler (the two new kinds from 21c.1). That is
21c.3.

## 21c.3 — `apps/api`: the queries, the routes and the worker's jobs

The two reports are SQL over what is already stored; the schedules are a service, a controller and three jobs in the
worker. First two small changes outside `apps/api`.

### The contract and the database: audit actions and two outbox events

```diff
@@ -246,6 +246,13 @@ export const AUDIT_ACTIONS = [
   'pos_return.over_returned',
   'pos_return.amounts_differ',
   'pos_return.without_permission',
+  // Step 21c: a report sent by email on a schedule. paused with no actor: the worker found that
+  // nobody on it may read the report any more (the changes say why).
+  'report_schedule.created',
+  'report_schedule.updated',
+  'report_schedule.paused',
+  'report_schedule.resumed',
+  'report_schedule.deleted',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -303,6 +310,7 @@ export const AUDIT_ENTITY_TYPES = [
   'pos_cash_reason',
   'pos_shift',
   'pos_return',
+  'report_schedule',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

Decision 46. The audit log's filter by entity type is an enum in the contract, so `openapi.json` changes by one line:
run `pnpm --filter @omnivo/contracts build` and `pnpm --filter @omnivo/contracts gen:openapi` again. The app shows a new
action by its raw name until 21c.5 gives it words.

```diff
@@ -0,0 +1,162 @@
+import { z } from 'zod';
+
+import { errorCode } from './errors.js';
+import { defineRoute } from './http.js';
+import { pageOf, pageQuerySchema } from './pagination.js';
+import { TAX_RATE_KINDS } from './tax-rates.js';
+
+// The VAT report (step 21c): the VAT of a period, by rate. It helps the accountant prepare the
+// monthly return. It is not the return itself: Mushak 9.1 comes in Phase 2.
+//
+// - The numbers come from the documents' lines, by the document's date. Output VAT: posted invoices
+//   and POS sales, less posted credit notes and POS returns. Input VAT: posted bills (product
+//   lines, account lines and expenses), less posted debit notes.
+// - Each line keeps the rate it was charged at, so a rate that was renamed or changed later does
+//   not move an old sale to another row.
+// - Beside the report, what the books say: the 'vat_output' and 'vat_input' accounts. A journal
+//   entry written by hand on one of them makes the two differ, and the page shows by how much.
+
+// ---------------------------------------------------------------------------------------------
+// The query
+
+// Both days included, like the other reports. An invoice or a credit note counts in its own branch,
+// a POS sale or return in its warehouse's, a bill or a debit note in its own.
+export const vatReportFilterSchema = z
+  .object({ from: z.iso.date(), to: z.iso.date(), branchId: z.uuid().optional() })
+  .refine((query) => query.from <= query.to, {
+    error: errorCode('report_range_invalid'),
+    path: ['to'],
+  });
+export type VatReportFilter = z.infer<typeof vatReportFilterSchema>;
+
+// Output is what the company charged, input is what it paid
+export const VAT_REPORT_SIDES = ['output', 'input'] as const;
+export type VatReportSide = (typeof VAT_REPORT_SIDES)[number];
+
+// The filters again, because a schema with .refine() cannot be extended
+export const vatDocumentQuerySchema = pageQuerySchema
+  .extend({
+    from: z.iso.date(),
+    to: z.iso.date(),
+    branchId: z.uuid().optional(),
+    side: z.enum(VAT_REPORT_SIDES),
+  })
+  .refine((query) => query.from <= query.to, {
+    error: errorCode('report_range_invalid'),
+    path: ['to'],
+  });
+export type VatDocumentQuery = z.input<typeof vatDocumentQuerySchema>;
+
+// ---------------------------------------------------------------------------------------------
+// The answer. Every amount is a decimal string with 4 places. Credit notes, POS returns and debit
+// notes are already taken off.
+
+export const vatReportRowSchema = z.object({
+  // Unique in the answer: the rate's id, its kind and its percent. A rate whose percent (or kind)
+  // was changed has one row for each, because each one is a different line of the return.
+  key: z.string(),
+  taxRateId: z.uuid(),
+  // "VAT 15%", as the page shows it next to the percent
+  name: z.string(),
+  // Zero-rated and exempt are both 0%, but different things in a return: never one row
+  kind: z.enum(TAX_RATE_KINDS),
+  // A percentage: "15.00"
+  rate: z.string(),
+  outputNet: z.string(),
+  outputVat: z.string(),
+  inputNet: z.string(),
+  inputVat: z.string(),
+  // outputVat − inputVat. Negative when more was paid than charged.
+  netVat: z.string(),
+});
+export type VatReportRow = z.infer<typeof vatReportRowSchema>;
+
+export const vatReportTotalsSchema = z.object({
+  outputNet: z.string(),
+  outputVat: z.string(),
+  // How much of the VAT charged was taken off again: credit notes and POS returns. Positive, and
+  // already left out of outputVat.
+  outputVatReturned: z.string(),
+  inputNet: z.string(),
+  inputVat: z.string(),
+  // The same for debit notes
+  inputVatReturned: z.string(),
+  // The VAT on posted bills with no supplier's VAT invoice (Mushak 6.3) number. It stays in
+  // inputVat, as it does in the books: this only tells the accountant which bills to check.
+  // Before debit notes, because a debit note does not say which part of the bill it took off.
+  inputVatWithoutMushak: z.string(),
+  netVat: z.string(),
+});
+export type VatReportTotals = z.infer<typeof vatReportTotalsSchema>;
+
+export const vatReportSchema = z.object({
+  // Standard rates first, the highest first; then reduced, zero-rated and exempt
+  rows: z.array(vatReportRowSchema),
+  totals: vatReportTotalsSchema,
+  // What the accounts moved in the same period and branch. output: credit less debit on
+  // 'vat_output'. input: debit less credit on 'vat_input'.
+  books: z.object({ output: z.string(), input: z.string() }),
+});
+export type VatReport = z.infer<typeof vatReportSchema>;
+
+export const VAT_DOCUMENT_KINDS = [
+  'invoice',
+  'pos_sale',
+  'credit_note',
+  'pos_return',
+  'bill',
+  'debit_note',
+] as const;
+export type VatDocumentKind = (typeof VAT_DOCUMENT_KINDS)[number];
+
+export const vatDocumentSchema = z.object({
+  // z.string(), not an enum: a newer server's new document must not break an older client. The
+  // app narrows it with isVatDocumentKind().
+  kind: z.string(),
+  id: z.uuid(),
+  number: z.string(),
+  date: z.iso.date(),
+  // null for a POS sale or return with no customer (walk-in)
+  partyName: z.string().nullable(),
+  partyBin: z.string().nullable(),
+  // A bill's and a debit note's own VAT document (Mushak 6.3, Mushak 6.7); null elsewhere
+  mushakNumber: z.string().nullable(),
+  // Negative for what takes VAT off: a credit note, a POS return, a debit note
+  net: z.string(),
+  vat: z.string(),
+});
+export type VatDocument = z.infer<typeof vatDocumentSchema>;
+
+export function isVatDocumentKind(value: string): value is VatDocumentKind {
+  return VAT_DOCUMENT_KINDS.some((kind) => kind === value);
+}
+
+// In date order, oldest first, like a VAT register. Not sortable.
+export const vatDocumentPageSchema = pageOf(vatDocumentSchema);
+export type VatDocumentPage = z.infer<typeof vatDocumentPageSchema>;
+
+// ---------------------------------------------------------------------------------------------
+// The routes. VAT belongs to the accounts, so it needs accounting.report.read.
+
+export const vatReportRoutes = {
+  summary: defineRoute({
+    method: 'GET',
+    path: '/reports/vat',
+    summary: 'The VAT of a period by rate, with what the books say',
+    auth: 'bearer',
+    permission: 'accounting.report.read',
+    status: 200,
+    query: vatReportFilterSchema,
+    response: vatReportSchema,
+  }),
+  documents: defineRoute({
+    method: 'GET',
+    path: '/reports/vat/documents',
+    summary: 'The documents behind the VAT of a period, one side at a time',
+    auth: 'bearer',
+    permission: 'accounting.report.read',
+    status: 200,
+    query: vatDocumentQuerySchema,
+    response: vatDocumentPageSchema,
+  }),
+};
```

Decision 14: the kind is part of a row's key.

```diff
@@ -22,6 +22,8 @@ export const OUTBOX_EVENT_TYPES = [
   'document.email_requested',
   'pos.sold_short',
   'pos.shift_variance',
+  'report.schedule_due',
+  'report.schedule_email',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

The list is plain text in the database (`$type`, no check), so no migration. Build `packages/db` after it: the API reads
it from `dist/`.

```diff
@@ -18,8 +18,9 @@ export const outboxPayloadSchemas = {
   'member.joined': z.object({ membershipId: z.uuid(), inviterId: z.uuid().nullable() }),
   // Nothing to carry: the workspace is the event's tenant, and its business type is on its row
   'workspace.chart_requested': z.object({}),
-  // The report_exports row says which report, which dates and for whom
-  'report.export_requested': z.object({ exportId: z.uuid() }),
+  // The report_exports row says which report, which dates and for whom. scheduleId (step 21c): the
+  // file is for a scheduled report email, so it goes by email instead of the bell.
+  'report.export_requested': z.object({ exportId: z.uuid(), scheduleId: z.uuid().optional() }),
   // Like the chart's: the workspace and its business type say everything
   'workspace.catalog_requested': z.object({}),
   // The product_imports row says which file, and who uploaded it
@@ -45,6 +46,11 @@ export const outboxPayloadSchemas = {
   // Step 20b: a shift's closing count was further from the expected cash than its register's
   // limit. The shift's row has the numbers; the worker tells the managers.
   'pos.shift_variance': z.object({ shiftId: z.uuid() }),
+  // Step 21c: a scheduled report is due. runAt is the run it stands for: the period is worked out
+  // from its day, not from the moment the job happens to run.
+  'report.schedule_due': z.object({ scheduleId: z.uuid(), runAt: z.iso.datetime() }),
+  // Step 21c: a scheduled report's file is ready; email it to the person it was made for
+  'report.schedule_email': z.object({ exportId: z.uuid(), scheduleId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

- **`scheduleId` is optional on `report.export_requested`.** An export a person asked for has none, and the events
  already in the outbox when you deploy still parse. Its presence is the only thing that tells the export handler to
  email the file instead of ringing the bell (decision 43).
- **`runAt` on `report.schedule_due`** is the run the event stands for (decision 41), as an ISO time. Not the moment the
  job runs: a run due at 23:00 whose job runs at 00:02 would otherwise report on the wrong day.
- **Ids only, as always.** The run reads the schedule, its filters and its people when it runs, so a schedule edited a
  second after the sweep sends what it says now.

```diff
@@ -16,6 +16,7 @@ const QUEUE_OF = {
   'workspace.created': 'email',
   'invitation.issued': 'email',
   'document.email_requested': 'email',
+  'report.schedule_email': 'email',
   'workspace.setup_requested': 'jobs',
   'member.joined': 'jobs',
   'workspace.chart_requested': 'jobs',
@@ -28,11 +29,16 @@ const QUEUE_OF = {
   'document.file_requested': 'jobs',
   'pos.sold_short': 'jobs',
   'pos.shift_variance': 'jobs',
+  'report.schedule_due': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
 export const OUTBOX_CLEANUP = 'outbox.cleanup';
 
+// Step 21c: every 5 minutes, look for the scheduled reports that are due (decision 9). Like the
+// cleanup, a scheduler adds it, not a request.
+export const REPORT_SCHEDULE_SWEEP = 'report-schedules.sweep';
+
 // What a job carries: the outbox row minus its bookkeeping. The job name is the event type.
 // Redis is data from outside this process, so the worker checks this shape before using it.
 export const eventJobDataSchema = z.object({
@@ -50,6 +56,7 @@ export function isOutboxEventType(value: string): value is OutboxEventType {
 type OutboxRow = typeof outboxEvents.$inferSelect;
 
 const HOUR_MS = 60 * 60 * 1000;
+const SWEEP_MS = 5 * 60 * 1000;
 const DAY_S = 24 * 60 * 60;
 
 @Injectable()
@@ -115,6 +122,16 @@ export class Queues implements OnApplicationShutdown {
     );
   }
 
+  // The same, for the report schedules' sweep. Every 5 minutes, so a schedule at 08:00 goes out by
+  // 08:05 (decision 13: whole hours only, so nothing promises a minute).
+  async scheduleReportSweep(): Promise<void> {
+    await this.queues.jobs.upsertJobScheduler(
+      'report-schedules-sweep',
+      { every: SWEEP_MS },
+      { name: REPORT_SCHEDULE_SWEEP },
+    );
+  }
+
   async onApplicationShutdown(): Promise<void> {
     await Promise.all(QUEUE_NAMES.map((name) => this.queues[name].close()));
   }
```

- **The run on `jobs`, the email on `email`**, like the step 16 document emails: drawing files and talking to a mail
  server never wait for each other.
- **`scheduleReportSweep()` uses `upsertJobScheduler`**, like the hourly cleanup: every worker process calls it when it
  starts, and the same id means one schedule however many workers run. Every 5 minutes (decision 13).

### Who holds a permission: `rbac/holds-permission.ts`

```diff
@@ -1,37 +1,57 @@
 import type { PermissionKey } from '@omnivo/contracts';
-import { sql } from 'drizzle-orm';
+import { type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction } from '../common/tenant/with-tenant.js';
 
-// Whether a member holds a permission now, read from the database in the caller's transaction. For
-// the worker (step 21b): a job runs for someone, without their request, and the worker has no
-// permission cache (it does not import InfraModule, worker.module.ts). The same rules as
+// Who holds a permission now, read from the database in the caller's transaction. For the worker
+// (step 21b): a job runs for someone, without their request, and the worker has no permission
+// cache (it does not import InfraModule, worker.module.ts). The same rules as
 // PermissionService.loadFromDb(): a removed member holds nothing, the owner role holds every key,
 // another role holds its own keys.
+
+// The user ids of the members who hold it: the one query both functions below run, so the two can
+// never disagree on the rules. userId narrows it to one person.
+function holderIds(tenantId: string, permission: PermissionKey, userId: string | null): SQL {
+  return sql`
+    SELECT DISTINCT m.user_id
+      FROM memberships m
+      JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
+                              AND mr.deleted_at IS NULL
+      JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.deleted_at IS NULL
+     WHERE m.tenant_id = ${tenantId}::uuid
+       ${userId === null ? sql`` : sql`AND m.user_id = ${userId}::uuid`}
+       AND m.deleted_at IS NULL
+       AND (r.kind = 'owner' OR EXISTS (
+             SELECT 1 FROM role_permissions rp
+               JOIN permissions p ON p.id = rp.permission_id
+              WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
+                AND rp.deleted_at IS NULL AND p.key = ${permission}))`;
+}
+
 export async function holdsPermission(
   tx: Transaction,
   userId: string,
   permission: PermissionKey,
 ): Promise<boolean> {
-  const tenantId = getTenantId();
-  const [row] = z.array(z.object({ held: z.boolean() })).parse(
-    await tx.execute(sql`
-        SELECT EXISTS (
-          SELECT 1
-            FROM memberships m
-            JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
-                                    AND mr.deleted_at IS NULL
-            JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.deleted_at IS NULL
-           WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid
-             AND m.deleted_at IS NULL
-             AND (r.kind = 'owner' OR EXISTS (
-                   SELECT 1 FROM role_permissions rp
-                     JOIN permissions p ON p.id = rp.permission_id
-                    WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
-                      AND rp.deleted_at IS NULL AND p.key = ${permission}))
-        ) AS held`),
-  );
+  const [row] = z
+    .array(z.object({ held: z.boolean() }))
+    .parse(
+      await tx.execute(
+        sql`SELECT EXISTS (${holderIds(getTenantId(), permission, userId)}) AS held`,
+      ),
+    );
   return row?.held ?? false;
 }
+
+// Step 21c: everyone who holds it, for the scheduled reports (who may get one, who is skipped)
+export async function permissionHolders(
+  tx: Transaction,
+  permission: PermissionKey,
+): Promise<Set<string>> {
+  const rows = z
+    .array(z.object({ user_id: z.uuid() }))
+    .parse(await tx.execute(holderIds(getTenantId(), permission, null)));
+  return new Set(rows.map((row) => row.user_id));
+}
```

The schedules need everyone who may read a report (the candidates, who is skipped at a run, `canReceive`), not one
person. `holderIds()` is the one query both functions run, so "who holds it" can never mean two things: the step 21b
`holdsPermission()` now asks `EXISTS (…)` of it with the person's id. `DISTINCT`, because a member with two roles that
both have the key is one person.

### The VAT report: `reports/vat-queries.ts` (new)

```ts
import {
  subtractMoney,
  TAX_RATE_KINDS,
  type VatDocumentPage,
  type VatReport,
  type VatReportFilter,
  type VatReportSide,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { pageClause, pageRows, type ReportPage, select } from './report-paging.js';

// The VAT report (step 21c), in plain SQL like the 21b reports, so the page and the export run
// the same queries. Every line keeps a copy of the rate it was charged at (name, kind, percent),
// so the rows come from that copy (decision 14), never from the tax_rates table as it is today.

// Every line with VAT in the period, one row each (decision 1), signed so that adding them up gives
// the period: a sale or a bill adds, a credit note, a POS return or a debit note takes off.
// `returned` marks the lines that take off. `mushak` is the supplier's VAT document: a bill's 6.3,
// a debit note's 6.7. A branch as decision 19 says: an invoice's and a bill's own, a credit note's
// invoice's, a POS document's warehouse's.
function vatLines(tenantId: string, from: string, to: string): SQL {
  return sql`
    SELECT 'output' AS side, 'invoice' AS kind, i.id AS doc_id, i.number, i.date,
           i.customer_id AS party_id, i.branch_id, NULL::text AS mushak, false AS returned,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, l.net, l.vat
      FROM invoice_lines l
      JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
     WHERE l.tenant_id = ${tenantId}::uuid AND i.status = 'posted'
       AND i.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'output', 'pos_sale', s.id, s.number, s.date, s.customer_id, w.branch_id, NULL, false,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, l.net, l.vat
      FROM pos_sale_lines l
      JOIN pos_sales s ON s.tenant_id = l.tenant_id AND s.id = l.sale_id
      JOIN warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND s.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'output', 'credit_note', c.id, c.number, c.date, c.customer_id, i.branch_id, NULL, true,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, -l.net, -l.vat
      FROM credit_note_lines l
      JOIN credit_notes c ON c.tenant_id = l.tenant_id AND c.id = l.credit_note_id
      JOIN invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
     WHERE l.tenant_id = ${tenantId}::uuid AND c.status = 'posted'
       AND c.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    -- A POS return line has no rate of its own: it is the sale line's
    SELECT 'output', 'pos_return', r.id, r.number, r.date, s.customer_id, w.branch_id, NULL, true,
           sl.tax_rate_id, sl.tax_rate_name, sl.tax_rate_kind, sl.tax_rate, -l.net, -l.vat
      FROM pos_return_lines l
      JOIN pos_returns r ON r.tenant_id = l.tenant_id AND r.id = l.return_id
      JOIN pos_sales s ON s.tenant_id = r.tenant_id AND s.id = r.sale_id
      JOIN pos_sale_lines sl ON sl.tenant_id = l.tenant_id AND sl.id = l.sale_line_id
      JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND r.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'bill', b.id, b.number, b.date, b.supplier_id, b.branch_id, b.mushak_number,
           false, l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, l.net, l.vat
      FROM bill_lines l
      JOIN bills b ON b.tenant_id = l.tenant_id AND b.id = l.bill_id
     WHERE l.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'bill', b.id, b.number, b.date, b.supplier_id, b.branch_id, b.mushak_number,
           false, e.tax_rate_id, e.tax_rate_name, e.tax_rate_kind, e.tax_rate, e.net, e.vat
      FROM bill_expenses e
      JOIN bills b ON b.tenant_id = e.tenant_id AND b.id = e.bill_id
     WHERE e.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'debit_note', d.id, d.number, d.date, d.supplier_id, d.branch_id,
           d.supplier_credit_number, true,
           l.tax_rate_id, l.tax_rate_name, l.tax_rate_kind, l.tax_rate, -l.net, -l.vat
      FROM debit_note_lines l
      JOIN debit_notes d ON d.tenant_id = l.tenant_id AND d.id = l.debit_note_id
     WHERE l.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'input', 'debit_note', d.id, d.number, d.date, d.supplier_id, d.branch_id,
           d.supplier_credit_number, true,
           e.tax_rate_id, e.tax_rate_name, e.tax_rate_kind, e.tax_rate, -e.net, -e.vat
      FROM debit_note_expenses e
      JOIN debit_notes d ON d.tenant_id = e.tenant_id AND d.id = e.debit_note_id
     WHERE e.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date`;
}

function branchWhere(branchId: string | undefined): SQL {
  return branchId === undefined ? sql`` : sql`WHERE l.branch_id = ${branchId}::uuid`;
}

const ZERO = '0.0000';

const rateRowSchema = z.object({
  tax_rate_id: z.uuid(),
  kind: z.enum(TAX_RATE_KINDS),
  rate: z.string(),
  name: z.string(),
  output_net: z.string(),
  output_vat: z.string(),
  input_net: z.string(),
  input_vat: z.string(),
});

const totalsSchema = z.object({
  output_net: z.string(),
  output_vat: z.string(),
  output_vat_returned: z.string(),
  input_net: z.string(),
  input_vat: z.string(),
  input_vat_returned: z.string(),
  input_vat_without_mushak: z.string(),
  net_vat: z.string(),
});

// The order of a return (decision 15): standard rates first, then reduced, zero-rated, exempt
const KIND_ORDER = sql`CASE g.kind WHEN 'standard' THEN 0 WHEN 'reduced' THEN 1
                                   WHEN 'zero_rated' THEN 2 ELSE 3 END`;

// One query for the rows, one for the totals: both read the same lines, and the totals need the
// returned and the "no Mushak 6.3" parts, which belong to no row
export async function vatReport(tx: Transaction, filter: VatReportFilter): Promise<VatReport> {
  const tenantId = getTenantId();
  const lines = vatLines(tenantId, filter.from, filter.to);
  const where = branchWhere(filter.branchId);
  const [rows, [totals], books] = await Promise.all([
    select(
      tx,
      sql`WITH lines AS (${lines}),
          grouped AS (
            SELECT l.tax_rate_id, l.tax_rate_kind AS kind, l.tax_rate AS rate,
                   -- The name the latest line used: a rate renamed in the period shows its new name
                   (array_agg(l.tax_rate_name ORDER BY l.date DESC, l.doc_id DESC))[1] AS name,
                   coalesce(sum(l.net) FILTER (WHERE l.side = 'output'), 0) AS output_net,
                   coalesce(sum(l.vat) FILTER (WHERE l.side = 'output'), 0) AS output_vat,
                   coalesce(sum(l.net) FILTER (WHERE l.side = 'input'), 0) AS input_net,
                   coalesce(sum(l.vat) FILTER (WHERE l.side = 'input'), 0) AS input_vat
              FROM lines l
              ${where}
             GROUP BY l.tax_rate_id, l.tax_rate_kind, l.tax_rate
          )
          SELECT g.tax_rate_id, g.kind, g.rate::text AS rate, g.name,
                 round(g.output_net, 4)::text AS output_net, round(g.output_vat, 4)::text AS output_vat,
                 round(g.input_net, 4)::text AS input_net, round(g.input_vat, 4)::text AS input_vat
            FROM grouped g
           ORDER BY ${KIND_ORDER}, g.rate DESC, lower(g.name), g.tax_rate_id`,
      rateRowSchema,
    ),
    // sum() of no rows is NULL, so every total has its coalesce: an empty month is zeros
    select(
      tx,
      sql`WITH lines AS (${lines})
          SELECT round(coalesce(sum(l.net) FILTER (WHERE l.side = 'output'), 0), 4)::text AS output_net,
                 round(coalesce(sum(l.vat) FILTER (WHERE l.side = 'output'), 0), 4)::text AS output_vat,
                 round(coalesce(-sum(l.vat) FILTER (WHERE l.side = 'output' AND l.returned), 0), 4)::text
                   AS output_vat_returned,
                 round(coalesce(sum(l.net) FILTER (WHERE l.side = 'input'), 0), 4)::text AS input_net,
                 round(coalesce(sum(l.vat) FILTER (WHERE l.side = 'input'), 0), 4)::text AS input_vat,
                 round(coalesce(-sum(l.vat) FILTER (WHERE l.side = 'input' AND l.returned), 0), 4)::text
                   AS input_vat_returned,
                 -- Bills only, before the debit notes (decision 17)
                 round(coalesce(sum(l.vat) FILTER (WHERE l.kind = 'bill' AND l.mushak IS NULL), 0), 4)::text
                   AS input_vat_without_mushak,
                 round(coalesce(sum(CASE WHEN l.side = 'output' THEN l.vat ELSE -l.vat END), 0), 4)::text
                   AS net_vat
            FROM lines l
            ${where}`,
      totalsSchema,
    ),
    booksVat(tx, filter),
  ]);
  return {
    rows: rows.map((row) => ({
      // The kind is in the key too: an exempt rate changed to zero-rated is two rows (decision 14)
      key: `${row.tax_rate_id}:${row.kind}:${row.rate}`,
      taxRateId: row.tax_rate_id,
      name: row.name,
      kind: row.kind,
      rate: row.rate,
      outputNet: row.output_net,
      outputVat: row.output_vat,
      inputNet: row.input_net,
      inputVat: row.input_vat,
      netVat: subtractMoney(row.output_vat, row.input_vat),
    })),
    totals: {
      outputNet: totals?.output_net ?? ZERO,
      outputVat: totals?.output_vat ?? ZERO,
      outputVatReturned: totals?.output_vat_returned ?? ZERO,
      inputNet: totals?.input_net ?? ZERO,
      inputVat: totals?.input_vat ?? ZERO,
      inputVatReturned: totals?.input_vat_returned ?? ZERO,
      inputVatWithoutMushak: totals?.input_vat_without_mushak ?? ZERO,
      netVat: totals?.net_vat ?? ZERO,
    },
    books,
  };
}

// What the books moved on the VAT accounts in the same period and branch: output is credit less
// debit on 'vat_output', input debit less credit on 'vat_input', from account_day_totals (step 21a)
async function booksVat(
  tx: Transaction,
  filter: VatReportFilter,
): Promise<{ output: string; input: string }> {
  const [row] = await select(
    tx,
    sql`SELECT round(coalesce(sum(t.credit - t.debit) FILTER (WHERE a.purpose = 'vat_output'), 0), 4)::text
                 AS output,
               round(coalesce(sum(t.debit - t.credit) FILTER (WHERE a.purpose = 'vat_input'), 0), 4)::text
                 AS input
          FROM account_day_totals t
          JOIN ledger_accounts a ON a.tenant_id = t.tenant_id AND a.id = t.account_id
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND a.purpose IN ('vat_output', 'vat_input')
           AND t.day BETWEEN ${filter.from}::date AND ${filter.to}::date
           ${filter.branchId === undefined ? sql`` : sql`AND t.branch_id = ${filter.branchId}::uuid`}`,
    z.object({ output: z.string(), input: z.string() }),
  );
  return { output: row?.output ?? ZERO, input: row?.input ?? ZERO };
}

const documentRowSchema = z.object({
  kind: z.string(),
  id: z.uuid(),
  number: z.string(),
  date: z.string(),
  party_name: z.string().nullable(),
  party_bin: z.string().nullable(),
  mushak: z.string().nullable(),
  net: z.string(),
  vat: z.string(),
});

// The documents behind one side, oldest first, like a VAT register on paper (decision 18). One row
// per document: its lines added up, with the same sign as in the report.
export async function vatDocuments(
  tx: Transaction,
  filter: VatReportFilter & { side: VatReportSide },
  page: ReportPage | null,
): Promise<VatDocumentPage> {
  const tenantId = getTenantId();
  const conditions = [sql`l.side = ${filter.side}`];
  if (filter.branchId !== undefined) conditions.push(sql`l.branch_id = ${filter.branchId}::uuid`);
  const found = await select(
    tx,
    sql`WITH lines AS (${vatLines(tenantId, filter.from, filter.to)})
        SELECT l.kind, l.doc_id AS id, coalesce(l.number, '') AS number, l.date::text AS date,
               p.name AS party_name, p.bin AS party_bin, l.mushak AS mushak,
               round(sum(l.net), 4)::text AS net, round(sum(l.vat), 4)::text AS vat
          FROM lines l
          LEFT JOIN parties p ON p.tenant_id = ${tenantId}::uuid AND p.id = l.party_id
         WHERE ${sql.join(conditions, sql` AND `)}
         GROUP BY l.kind, l.doc_id, l.number, l.date, p.id, l.mushak
         -- The id last: two documents of one day keep their order from page to page
         ORDER BY l.date, l.number, l.doc_id
         ${pageClause(page)}`,
    documentRowSchema,
  );
  const rows = pageRows(found, page);
  return {
    items: rows.items.map((row) => ({
      kind: row.kind,
      id: row.id,
      number: row.number,
      date: row.date,
      partyName: row.party_name,
      partyBin: row.party_bin,
      mushakNumber: row.mushak,
      net: row.net,
      vat: row.vat,
    })),
    nextCursor: rows.nextCursor,
  };
}
```

Why it is written this way:

- **`vatLines()` is eight `SELECT`s in one `UNION ALL`**, one per kind of line (decision 1), each with the same columns.
  Every later step reads only these columns, so a ninth kind of document later is one more `SELECT` here and nothing
  else.
- **The sign is set once, in the lines.** A credit note, a POS return and a debit note come out negative, so every sum
  after that is a plain `sum()`: the rows, the totals and the documents list all add up the same way, and the documents
  of one side add up to its KPI (decision 18).
- **`returned` marks the lines that take VAT off**, for `outputVatReturned` and `inputVatReturned` (decision 16), which
  are shown as positive numbers (`-sum(…)`).
- **A POS return line joins its sale line for the rate.** A return line has no rate of its own (step 20c): it gives back
  what the sale charged, at the sale's rate.
- **Branches as decision 19 says.** A credit note joins its invoice for the branch (a credit note has none of its own),
  a POS sale and a POS return their warehouse. A debit note has its own (step 17d stores it, because one without a bill
  has nowhere else to keep it).
- **`mushak`** is the supplier's VAT document: a bill's `mushak_number` (Mushak 6.3), a debit note's
  `supplier_credit_number` (Mushak 6.7). The page shows it in the register; "without a Mushak 6.3" reads bills only
  (decision 17).
- **Only posted documents.** A draft invoice is not a sale yet. A POS sale and a POS return have no draft: they are
  posted when they arrive.
- **`GROUP BY l.tax_rate_id, l.tax_rate_kind, l.tax_rate`** is decision 14: the copy on the line, never the rate as it is
  in Settings today.
- **`(array_agg(name ORDER BY date DESC …))[1]`**: a rate renamed inside the month has one row, under its newest name.
  `max(name)` would pick a name by the alphabet.
- **`KIND_ORDER` then `rate DESC`** is decision 15. The name and the id after it only keep two rows with the same kind and
  percent (two "15%" rates) in the same order every time.
- **Two queries for the rows and the totals.** The totals need parts that belong to no row (what was returned, the bills
  without a Mushak 6.3); a window function over the rows could not see them. Both read the same lines, in one
  transaction, so they agree.
- **`coalesce(sum(…), 0)` on every total**: `sum()` of no rows is `NULL`, and a month with no sales must show zeros, not
  fail the schema.
- **`subtractMoney()` for a row's net**, from the contract. Postgres already rounded both sides to 4 places, so the
  difference is exact; a JavaScript number would not be (`0.1 + 0.2`).
- **`booksVat()`** reads `account_day_totals` (step 21a) by the accounts' purpose, so it finds the accounts whatever
  their code. Output is credit less debit (a liability grows with credits), input debit less credit (an asset). A
  workspace before its chart has none: zeros. It is the books' line; the page says "Books agree" or "Out by ৳x".
- **`vatDocuments()` is one row per document**, its lines added up, oldest first and then by number (a register,
  decision 18). The id comes last in the `ORDER BY` so two documents of the same day and number (one invoice, one POS
  sale) keep their order between pages. Paged by `pageClause()` like the 21b reports.
- **`LEFT JOIN parties`**: a walk-in POS sale has no customer, and the row still counts.

### The stock movement report: `reports/stock-movement-queries.ts` (new)

```ts
import {
  MOVEMENT_KINDS,
  STOCK_MOVEMENT_COLUMN_OF,
  type StockMovementColumn,
  type StockMovementFilter,
  type StockMovementReport,
  type StockMovementSort,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import {
  inCategory,
  pageClause,
  pageRows,
  type ReportPage,
  select,
  sortColumn,
  type SortColumn,
} from './report-paging.js';

// The stock movement report (step 21c): per variant, in the base unit,
//   closing = opening + purchased − sold + transfers + adjusted
// Nothing new is stored for it (decision 5). What a variant holds now is kept by the database
// (stock_values for the whole company, stock_balances per warehouse), so:
//   opening = now − every movement dated from the first day on
//   closing = now − every movement dated after the last day
// That reads the movements from the first day to today, never the whole ledger
// (stock_movements_date_idx). The value works the same way, from stock_values' value, or, for
// one warehouse, from the sum of that warehouse's movement values (stock_values has no warehouse).

// The kinds of one column, from the contract's map. MOVEMENT_KINDS, not Object.keys: it keeps
// the type, and the map's satisfies already says every kind is in it.
function kindsOf(column: StockMovementColumn): SQL {
  const kinds = MOVEMENT_KINDS.filter((kind) => STOCK_MOVEMENT_COLUMN_OF[kind] === column);
  return sql`(${sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

// The quantity of one column inside the period. "sold" is turned round: stock that left is a
// positive number there (a return comes back with the opposite sign, decision 21).
function columnSum(column: StockMovementColumn, to: string): SQL {
  const inPeriod = sql`m.date <= ${to}::date AND m.kind IN ${kindsOf(column)}`;
  const sum = sql`coalesce(sum(m.quantity) FILTER (WHERE ${inPeriod}), 0)`;
  return column === 'sold' ? sql`-${sum}` : sum;
}

// What each variant holds now, in the report's scope. With a warehouse filter the value is that
// warehouse's movements added up since the beginning: the one place this report reads old
// movements, and only for one warehouse and only when the value is shown.
function nowOf(tenantId: string, warehouseId: string | undefined, withValue: boolean): SQL {
  if (warehouseId === undefined) {
    return sql`SELECT sv.variant_id, sv.quantity, sv.value
                 FROM stock_values sv WHERE sv.tenant_id = ${tenantId}::uuid`;
  }
  const value = withValue
    ? sql`(SELECT coalesce(sum(x.value), 0) FROM stock_movements x
            WHERE x.tenant_id = b.tenant_id AND x.warehouse_id = b.warehouse_id
              AND x.variant_id = b.variant_id)`
    : sql`0::numeric`;
  // One balance row per batch: added up per variant first
  return sql`SELECT b.variant_id, sum(b.quantity) AS quantity, ${value} AS value
               FROM stock_balances b
              WHERE b.tenant_id = ${tenantId}::uuid AND b.warehouse_id = ${warehouseId}::uuid
              GROUP BY b.tenant_id, b.warehouse_id, b.variant_id`;
}

// After the sort's own column: the name in any case, then the product and the variant's place, so
// two products called "Napa" (or two rows with the same number) keep their order from page to page
const BY_NAME = sql`lower(p.name), p.id, v.position`;

const SORT_COLUMNS = {
  name: sql`lower(p.name)`,
  sku: sql`lower(v.sku)`,
  opening: sql`r.opening`,
  purchased: sql`r.purchased`,
  sold: sql`r.sold`,
  transfers: sql`r.transfers`,
  adjusted: sql`r.adjusted`,
  closing: sql`r.closing`,
  openingValue: sql`r.opening_value`,
  closingValue: sql`r.closing_value`,
} satisfies Record<SortColumn<StockMovementSort>, SQL>;

const rowSchema = z.object({
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  unit_code: z.string(),
  unit_decimals: z.number().int(),
  opening: z.string(),
  purchased: z.string(),
  sold: z.string(),
  transfers: z.string(),
  adjusted: z.string(),
  closing: z.string(),
  opening_value: z.string(),
  closing_value: z.string(),
  total_variants: z.number().int(),
  total_opening_value: z.string(),
  total_closing_value: z.string(),
});

// The report, a page of rows (page) or every row (null, an export). Without withValue the value
// columns are null; the service refuses a value sort before it gets here (decision 24).
export async function stockMovementReport(
  tx: Transaction,
  filter: StockMovementFilter,
  options: { withValue: boolean; page: ReportPage | null },
): Promise<StockMovementReport> {
  const tenantId = getTenantId();
  const { from, to } = filter;
  const sort = sortColumn(filter.sort, SORT_COLUMNS);
  const where: SQL[] = [
    // decision 22: 'moved' = a movement in the period; 'all' adds what had stock at the start
    filter.show === 'moved' ? sql`r.moved` : sql`(r.moved OR r.opening <> 0)`,
  ];
  if (filter.categoryId !== undefined) {
    where.push(inCategory(sql`p.category_id`, tenantId, filter.categoryId));
  }
  const found = await select(
    tx,
    sql`WITH moves AS (
          SELECT m.variant_id,
                 sum(m.quantity) AS quantity_since, sum(m.value) AS value_since,
                 coalesce(sum(m.quantity) FILTER (WHERE m.date > ${to}::date), 0) AS quantity_after,
                 coalesce(sum(m.value) FILTER (WHERE m.date > ${to}::date), 0) AS value_after,
                 ${columnSum('purchased', to)} AS purchased,
                 ${columnSum('sold', to)} AS sold,
                 ${columnSum('transfers', to)} AS transfers,
                 ${columnSum('adjusted', to)} AS adjusted,
                 -- A revaluation counts: it moved the value
                 bool_or(m.date <= ${to}::date) AS moved
            FROM stock_movements m
           WHERE m.tenant_id = ${tenantId}::uuid AND m.date >= ${from}::date
             ${filter.warehouseId === undefined ? sql`` : sql`AND m.warehouse_id = ${filter.warehouseId}::uuid`}
           GROUP BY m.variant_id
        ),
        now AS (${nowOf(tenantId, filter.warehouseId, options.withValue)}),
        -- Every variant that moved has a row in now: the database adds each movement there
        rows AS (
          SELECT n.variant_id,
                 n.quantity - coalesce(mv.quantity_since, 0) AS opening,
                 coalesce(mv.purchased, 0) AS purchased, coalesce(mv.sold, 0) AS sold,
                 coalesce(mv.transfers, 0) AS transfers, coalesce(mv.adjusted, 0) AS adjusted,
                 n.quantity - coalesce(mv.quantity_after, 0) AS closing,
                 n.value - coalesce(mv.value_since, 0) AS opening_value,
                 n.value - coalesce(mv.value_after, 0) AS closing_value,
                 coalesce(mv.moved, false) AS moved
            FROM now n
            LEFT JOIN moves mv ON mv.variant_id = n.variant_id
        )
        SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               u.code AS unit_code, u.decimals AS unit_decimals,
               round(r.opening, 4)::text AS opening, round(r.purchased, 4)::text AS purchased,
               round(r.sold, 4)::text AS sold, round(r.transfers, 4)::text AS transfers,
               round(r.adjusted, 4)::text AS adjusted, round(r.closing, 4)::text AS closing,
               round(r.opening_value, 4)::text AS opening_value,
               round(r.closing_value, 4)::text AS closing_value,
               -- Over every row, before the LIMIT: the same on every page
               (count(*) OVER ())::int AS total_variants,
               round(coalesce(sum(r.opening_value) OVER (), 0), 4)::text AS total_opening_value,
               round(coalesce(sum(r.closing_value) OVER (), 0), 4)::text AS total_closing_value
          FROM rows r
          JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = r.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
         WHERE ${sql.join(where, sql` AND `)}
         ORDER BY ${sort.column} ${sort.direction}, ${BY_NAME}
         ${pageClause(options.page)}`,
    rowSchema,
  );
  const first = found[0];
  const page = pageRows(found, options.page);
  const value = (amount: string): string | null => (options.withValue ? amount : null);
  return {
    items: page.items.map((row) => ({
      variantId: row.variant_id,
      productId: row.product_id,
      productCode: row.product_code,
      productName: row.product_name,
      optionValues: row.option_values,
      sku: row.sku,
      baseUnitId: row.base_unit_id,
      baseUnit: { code: row.unit_code, decimals: row.unit_decimals },
      opening: row.opening,
      purchased: row.purchased,
      sold: row.sold,
      transfers: row.transfers,
      adjusted: row.adjusted,
      closing: row.closing,
      openingValue: value(row.opening_value),
      closingValue: value(row.closing_value),
    })),
    nextCursor: page.nextCursor,
    withValue: options.withValue,
    totals: {
      variants: first?.total_variants ?? 0,
      openingValue: value(first?.total_opening_value ?? '0.0000'),
      closingValue: value(first?.total_closing_value ?? '0.0000'),
    },
  };
}
```

Why it is written this way:

- **The idea (decision 5).** The database already keeps what each variant holds now. The opening is that less everything
  dated from the first day on; the closing that less everything dated after the last day. So the query reads the
  movements from the first day to today, once, with the new date index, and never the years before.
- **`kindsOf()` reads the contract's map** (`STOCK_MOVEMENT_COLUMN_OF`), so the SQL and the contract cannot disagree on
  which column a kind belongs to. It walks `MOVEMENT_KINDS` instead of `Object.keys()`, which would give plain strings.
- **`columnSum()` counts only the period** (`m.date <= to`; the `WHERE` already starts at `from`). "Sold" is turned round
  (`-sum`): stock that left is positive, and a return in the same column makes it smaller (decision 21).
- **`moves` adds up everything from `from` on in one pass**, with `FILTER` for the parts: since the first day (for the
  opening), after the last day (for the closing) and each column. One scan of the index instead of six.
- **`bool_or(m.date <= to) AS moved`**: a variant that moved only after the period did not move in it. A revaluation
  counts as a movement, because it changed the value.
- **`nowOf()` without a warehouse is `stock_values`**: one row per variant, quantity and value, kept by the database
  (step 14). It counts what is in every warehouse and not what is on a truck, exactly like the sum of the movements.
- **`nowOf()` for one warehouse is `stock_balances`**, added up per variant (one row per batch). Its value is the sum of
  that warehouse's movement values (decision 48), only when the value is shown: otherwise `0`, and the page never sees it.
- **`rows` starts from `now`, not from `moves`.** Every variant that ever moved has a row in `now` (the database adds each
  movement there), so a `LEFT JOIN` finds the ones that did not move too, which `show: 'all'` needs.
- **`r.moved OR r.opening <> 0`** is decision 22: a variant with no stock and no movement never has a row.
- **The sort's column, then `lower(p.name), p.id, v.position`.** Many rows share a number (every variant that sold 0), and
  an `OFFSET` page needs a full order, or a row could show on two pages. The variant's `position` keeps "Rose" before
  "Lime" as the product page lists them.
- **The totals are window functions over every row before the `LIMIT`**, so they are the same on every page (as in 21b).
  There is no total quantity (decision 23).
- **`value()` turns the values into `null` without the permission**, in one place; the SQL still works them out (they
  cost nothing without a warehouse filter) but they never leave the server.

### The two reports' service and routes

```diff
@@ -1,8 +1,14 @@
-import { isCostSort, type PermissionKey, type SalesReportSort } from '@omnivo/contracts';
+import {
+  isCostSort,
+  isStockValueSort,
+  type PermissionKey,
+  type SalesReportSort,
+  type StockMovementSort,
+} from '@omnivo/contracts';
 
 import { AppError } from '../common/http/app-error.js';
 
-// Who may read what in the step 21b reports, past the route's own permission
+// Who may read what in the step 21b and 21c reports, past the route's own permission
 
 // The same answer the PermissionGuard gives (403 permission_missing, with the key), for a check the
 // route cannot make: the guard knows one permission per route
@@ -18,3 +24,8 @@ export function missingPermission(permission: PermissionKey): AppError {
 export function checkCostSort(sort: SalesReportSort, withCost: boolean): void {
   if (!withCost && isCostSort(sort)) throw missingPermission('inventory.stock.value');
 }
+
+// Step 21c: the same rule for the stock movement report's value columns (decision 24)
+export function checkValueSort(sort: StockMovementSort, withValue: boolean): void {
+  if (!withValue && isStockValueSort(sort)) throw missingPermission('inventory.stock.value');
+}
```

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  StockMovementFilter,
  StockMovementReport,
  VatDocumentPage,
  VatReport,
  VatReportFilter,
  VatReportSide,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { checkValueSort } from './report-access.js';
import { reportPage } from './report-paging.js';
import { stockMovementReport } from './stock-movement-queries.js';
import { vatDocuments, vatReport } from './vat-queries.js';

type Paged<F> = F & { limit: number; cursor?: string | undefined };

// The step 21c report pages: VAT (accounting.report.read, decision 11) and stock movement
// (inventory.report.read, decision 20). The route checks those; the stock values check
// inventory.stock.value here. The queries live in vat-queries.ts and stock-movement-queries.ts,
// where the worker's export finds them too.
@Injectable()
export class VatStockReportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  vat(query: VatReportFilter): Promise<VatReport> {
    return this.withTenant((tx) => vatReport(tx, query));
  }

  vatDocuments(query: Paged<VatReportFilter & { side: VatReportSide }>): Promise<VatDocumentPage> {
    return this.withTenant((tx) => vatDocuments(tx, query, reportPage(query)));
  }

  async stockMovement(query: Paged<StockMovementFilter>): Promise<StockMovementReport> {
    const access = await this.permissions.ofCurrentUser();
    const withValue = access.permissions.includes('inventory.stock.value');
    checkValueSort(query.sort, withValue);
    return this.withTenant((tx) =>
      stockMovementReport(tx, query, { withValue, page: reportPage(query) }),
    );
  }
}
```

The VAT routes need `accounting.report.read` and the stock movement route `inventory.report.read`: the route's guard
checks those (decisions 11 and 20). The value permission is checked here, before the query, because a refused sort is
an answer (403 with the key), not an empty page.

```diff
@@ -6,12 +6,15 @@ import { FiscalYearsService } from './fiscal-years.service.js';
 import { ReportExportsService } from './report-exports.service.js';
 import { ReportsService } from './reports.service.js';
 import { TradeReportsService } from './trade-reports.service.js';
+import { VatStockReportsService } from './vat-stock-reports.service.js';
 
 type Reports = typeof routes.reports;
 type Trade = typeof routes.tradeReports;
 type Aging = typeof routes.aging;
 type Years = typeof routes.fiscalYears;
 type Exports = typeof routes.reportExports;
+type Vat = typeof routes.vatReport;
+type StockMovement = typeof routes.stockMovementReport;
 
 @Controller()
 export class ReportsController {
@@ -20,6 +23,7 @@ export class ReportsController {
     private readonly years: FiscalYearsService,
     private readonly exports: ReportExportsService,
     private readonly trade: TradeReportsService,
+    private readonly vatStock: VatStockReportsService,
   ) {}
 
   @Endpoint(routes.reports.trialBalance)
@@ -81,6 +85,23 @@ export class ReportsController {
     return this.trade.payablesOf(params.supplierId, query.asOf);
   }
 
+  @Endpoint(routes.vatReport.summary)
+  vat({ query }: RouteInput<Vat['summary']>): Promise<RouteResponse<Vat['summary']>> {
+    return this.vatStock.vat(query);
+  }
+
+  @Endpoint(routes.vatReport.documents)
+  vatDocuments({ query }: RouteInput<Vat['documents']>): Promise<RouteResponse<Vat['documents']>> {
+    return this.vatStock.vatDocuments(query);
+  }
+
+  @Endpoint(routes.stockMovementReport.report)
+  stockMovement({
+    query,
+  }: RouteInput<StockMovement['report']>): Promise<RouteResponse<StockMovement['report']>> {
+    return this.vatStock.stockMovement(query);
+  }
+
   @Endpoint(routes.fiscalYears.list)
   listYears(): Promise<RouteResponse<Years['list']>> {
     return this.years.list();
```

### Schedules: `reports/report-schedule-row.ts` (new)

```ts
import { nextReportScheduleRun, type ReportScheduleWhen } from '@omnivo/contracts';
import type { reportSchedules } from '@omnivo/db';

// A schedule's time is four columns in the database (21c decision 35) and a discriminated union in
// the contract (decision 26). These two functions are the only places that turn one into the
// other, for the API and the worker alike.

export type ScheduleRow = typeof reportSchedules.$inferSelect;

type WhenColumns = Pick<ScheduleRow, 'frequency' | 'hour' | 'weekday' | 'dayOfMonth'>;

export function whenColumnsOf(when: ReportScheduleWhen): WhenColumns {
  return {
    frequency: when.frequency,
    hour: when.hour,
    weekday: when.frequency === 'weekly' ? when.weekday : null,
    dayOfMonth: when.frequency === 'monthly' ? when.dayOfMonth : null,
  };
}

// The database's checks keep each day with its frequency, so a missing day here is a row changed
// by hand: an error, not a guess
export function whenOf(row: WhenColumns): ReportScheduleWhen {
  switch (row.frequency) {
    case 'daily':
      return { frequency: 'daily', hour: row.hour };
    case 'weekly':
      if (row.weekday === null) throw new Error('A weekly report schedule has no weekday');
      return { frequency: 'weekly', hour: row.hour, weekday: row.weekday };
    case 'monthly':
      if (row.dayOfMonth === null) throw new Error('A monthly report schedule has no day');
      return { frequency: 'monthly', hour: row.hour, dayOfMonth: row.dayOfMonth };
  }
}

// What the sweep does with a schedule that is due: the run it sends and the next one (decision 9).
// A worker that was down for three days finds a daily schedule three runs behind; it sends one, for
// the latest run that is due (so the email is about yesterday, not about four days ago), and moves
// on to the first run after now.
export function catchUp(
  when: ReportScheduleWhen,
  timeZone: string,
  due: Date,
  now: Date,
): { runAt: Date; nextRunAt: Date } {
  let runAt = due;
  // Ends: each step is a later run, and now is a fixed moment
  for (;;) {
    const next = nextReportScheduleRun(when, timeZone, runAt);
    if (next > now) return { runAt, nextRunAt: next };
    runAt = next;
  }
}
```

- **`whenColumnsOf()` and `whenOf()`** are the only places where the contract's union becomes the four columns and back
  (decision 35). The API saves with one and answers with the other; the worker reads with `whenOf()`. A weekly row with no
  day can only be a row changed by hand, so it throws instead of guessing a day.
- **`catchUp()`** is decision 41. It walks from the due run to the latest one that is not after now, with the contract's
  `nextReportScheduleRun()`, so it agrees with the API about when runs are. The loop ends: each step is strictly later
  (the contract promises that), and `now` does not move.

### Schedules: `reports/report-schedules.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditValue,
  isStockValueSort,
  MAX_REPORT_SCHEDULES,
  nextReportScheduleRun,
  type ReportKind,
  REPORT_KIND_PERMISSIONS,
  reportKindsFor,
  type ReportSchedule,
  type ReportScheduleCandidateList,
  reportScheduleFiltersOf,
  type ReportScheduleInput,
  type ReportScheduleList,
  type ReportScheduleUpdate,
} from '@omnivo/contracts';
import {
  branches,
  customerGroups,
  productCategories,
  reportScheduleRecipients,
  reportSchedules,
  supplierGroups,
  tenantSettings,
  users,
  warehouses,
} from '@omnivo/db';
import { type AnyColumn, and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { permissionHolders } from '../rbac/holds-permission.js';
import { PermissionService } from '../rbac/permission.service.js';
import { checkCostSort, missingPermission } from './report-access.js';
import { type ScheduleRow, whenColumnsOf, whenOf } from './report-schedule-row.js';

// The names a list shows for the filters' ids (decision 33). Read from the stored filters by
// their field names, which are the same in every report that has them.
interface FilterIds {
  branch: Set<string>;
  warehouse: Set<string>;
  group: Set<string>;
  category: Set<string>;
}

function groupIdOf(filters: Record<string, string>): string | undefined {
  return filters.customerGroupId ?? filters.supplierGroupId;
}

// What the audit log keeps of a schedule: plain values only (auditValueSchema)
function snapshot(row: ScheduleRow, recipientIds: readonly string[]): Record<string, AuditValue> {
  return {
    report: row.report,
    format: row.format,
    frequency: row.frequency,
    hour: row.hour,
    weekday: row.weekday,
    dayOfMonth: row.dayOfMonth,
    recipients: recipientIds.join(', '),
    status: row.status,
  };
}

function recipientsInvalid(): AppError {
  return new AppError(
    409,
    'report_schedule_recipient_invalid',
    'Pick only members who may read this report.',
    { fieldErrors: { recipientIds: ['report_schedule_recipient_invalid'] } },
  );
}

// The workspace's scheduled report emails (step 21c). The route needs core.report.schedule; every
// method here also needs the report's own permission (scheduleRouteBase in the contract), so a
// person cannot send by email what they could not open.
@Injectable()
export class ReportSchedulesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  // Every schedule of the reports this person may read, oldest first. Not paged (decision 33).
  async list(): Promise<ReportScheduleList> {
    const kinds = reportKindsFor((await this.permissions.ofCurrentUser()).permissions);
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(reportSchedules)
        .where(
          and(eq(reportSchedules.tenantId, getTenantId()), inArray(reportSchedules.report, kinds)),
        )
        .orderBy(asc(reportSchedules.createdAt), asc(reportSchedules.id));
      return { items: await this.present(tx, rows), timeZone: await timeZoneOf(tx) };
    });
  }

  // The members who could get this report: only they are offered in the form (decision 30)
  async candidates(report: ReportKind): Promise<ReportScheduleCandidateList> {
    await this.checkReport(report);
    return this.withTenant(async (tx) => {
      const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[report]);
      if (holders.size === 0) return { items: [] };
      const people = await tx
        .select({ userId: users.id, name: users.fullName, email: users.email })
        .from(users)
        .where(inArray(users.id, [...holders]))
        .orderBy(sql`lower(${users.fullName})`, asc(users.id));
      return { items: people };
    });
  }

  async create(input: ReportScheduleInput): Promise<ReportSchedule> {
    const access = await this.checkReport(input.report);
    // The same rules as an export of the same query (report-exports.service.ts)
    if (input.report === 'sales_report') {
      checkCostSort(input.query.sort, access.includes('inventory.stock.value'));
    }
    if (
      input.report === 'stock_movement' &&
      isStockValueSort(input.query.sort) &&
      !access.includes('inventory.stock.value')
    ) {
      throw missingPermission('inventory.stock.value');
    }
    const userId = currentPrincipal().userId;
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      // decision 39: two saves at the same moment must not both be the 20th. The lock lasts
      // until the transaction ends, so the count and the insert happen one save at a time.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`report_schedules:${tenantId}`}, 0))`,
      );
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(reportSchedules)
        .where(eq(reportSchedules.tenantId, tenantId));
      if ((counted?.count ?? 0) >= MAX_REPORT_SCHEDULES) {
        throw new AppError(
          409,
          'report_schedule_limit',
          `A workspace can have at most ${String(MAX_REPORT_SCHEDULES)} report emails.`,
        );
      }
      await checkRecipients(tx, input.report, input.recipientIds);
      const [row] = await tx
        .insert(reportSchedules)
        .values({
          tenantId,
          report: input.report,
          format: input.format,
          ...whenColumnsOf(input.when),
          // decision 29: the page sent its query with the dates; only the filters are kept
          filters: reportScheduleFiltersOf(input.query),
          nextRunAt: nextReportScheduleRun(input.when, await timeZoneOf(tx), new Date()),
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      if (!row) throw new Error('Report schedule insert returned no row');
      await saveRecipients(tx, row.id, input.recipientIds);
      await audit(tx, {
        action: 'report_schedule.created',
        entityType: 'report_schedule',
        entityId: row.id,
        changes: created(snapshot(row, input.recipientIds)),
      });
      return this.one(tx, row);
    });
  }

  // The format, the time and the people; the report and its filters stay (decision 10)
  async update(id: string, input: ReportScheduleUpdate): Promise<ReportSchedule> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.row.version !== input.version) throw versionConflict();
      await checkRecipients(tx, before.row.report, input.recipientIds);
      const [after] = await tx
        .update(reportSchedules)
        .set({
          format: input.format,
          ...whenColumnsOf(input.when),
          // A new time moves the next run; a paused schedule stays without one
          ...(before.row.status === 'active' && {
            nextRunAt: nextReportScheduleRun(input.when, await timeZoneOf(tx), new Date()),
          }),
          version: sql`${reportSchedules.version} + 1`,
          updatedBy: currentPrincipal().userId,
          updatedAt: new Date(),
        })
        .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)))
        .returning();
      if (!after) throw notFound('Report schedule');
      await saveRecipients(tx, id, input.recipientIds);
      await audit(tx, {
        action: 'report_schedule.updated',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff(
          snapshot(before.row, before.recipientIds),
          snapshot(after, input.recipientIds),
        ),
      });
      return this.one(tx, after);
    });
  }

  async pause(id: string, version: number): Promise<ReportSchedule> {
    return this.withTenant(async (tx) => {
      const { row } = await this.lock(tx, id);
      if (row.version !== version) throw versionConflict();
      // Already paused (by someone else, or by the worker): nothing to change
      if (row.status === 'paused') return this.one(tx, row);
      const after = await this.setStatus(tx, id, { status: 'paused', pausedReason: 'manual' });
      await audit(tx, {
        action: 'report_schedule.paused',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'paused', pausedReason: 'manual' }),
      });
      return this.one(tx, after);
    });
  }

  // decision 31: refused while nobody on it may read the report, or it would pause itself again
  // at its next run
  async resume(id: string, version: number): Promise<ReportSchedule> {
    return this.withTenant(async (tx) => {
      const { row, recipientIds } = await this.lock(tx, id);
      if (row.version !== version) throw versionConflict();
      if (row.status === 'active') return this.one(tx, row);
      const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[row.report]);
      if (!recipientIds.some((userId) => holders.has(userId))) {
        throw new AppError(
          409,
          'report_schedule_no_recipients',
          'Nobody on this report email may read the report. Add someone who may, then resume it.',
        );
      }
      // From now: the runs it missed while paused are not sent
      const nextRunAt = nextReportScheduleRun(whenOf(row), await timeZoneOf(tx), new Date());
      const after = await this.setStatus(tx, id, {
        status: 'active',
        pausedReason: null,
        nextRunAt,
      });
      await audit(tx, {
        action: 'report_schedule.resumed',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff(
          { status: row.status, pausedReason: row.pausedReason },
          { status: 'active', pausedReason: null },
        ),
      });
      return this.one(tx, after);
    });
  }

  // For real (decision 34): the recipients go with it (ON DELETE CASCADE); the files it sent are
  // report_exports rows of their own and stay on each person's Exports page
  async remove(id: string): Promise<void> {
    await this.withTenant(async (tx) => {
      const { row, recipientIds } = await this.lock(tx, id);
      await tx
        .delete(reportSchedules)
        .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)));
      // Every field to null, as the other deletes write it: the log keeps what it was
      const before = snapshot(row, recipientIds);
      await audit(tx, {
        action: 'report_schedule.deleted',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff(
          before,
          Object.fromEntries(Object.keys(before).map((field) => [field, null])),
        ),
      });
    });
  }

  // The person's permissions, after checking the report's own one
  private async checkReport(report: ReportKind): Promise<readonly string[]> {
    const access = await this.permissions.ofCurrentUser();
    const permission = REPORT_KIND_PERMISSIONS[report];
    if (!access.permissions.includes(permission)) throw missingPermission(permission);
    return access.permissions;
  }

  // The row, locked until the transaction ends, with its recipients. A schedule of a report this
  // person may not read is refused like the list leaves it out.
  private async lock(
    tx: Transaction,
    id: string,
  ): Promise<{ row: ScheduleRow; recipientIds: string[] }> {
    const [row] = await tx
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)))
      .for('update');
    if (!row) throw notFound('Report schedule');
    await this.checkReport(row.report);
    const recipients = await tx
      .select({ userId: reportScheduleRecipients.userId })
      .from(reportScheduleRecipients)
      .where(
        and(
          eq(reportScheduleRecipients.tenantId, getTenantId()),
          eq(reportScheduleRecipients.scheduleId, id),
        ),
      )
      .orderBy(asc(reportScheduleRecipients.position));
    return { row, recipientIds: recipients.map((recipient) => recipient.userId) };
  }

  private async setStatus(
    tx: Transaction,
    id: string,
    change:
      | { status: 'paused'; pausedReason: 'manual' }
      | { status: 'active'; pausedReason: null; nextRunAt: Date },
  ): Promise<ScheduleRow> {
    const [after] = await tx
      .update(reportSchedules)
      .set({
        status: change.status,
        pausedReason: change.pausedReason,
        // The check constraint: paused has no next run, active always has one
        nextRunAt: change.status === 'active' ? change.nextRunAt : null,
        version: sql`${reportSchedules.version} + 1`,
        updatedBy: currentPrincipal().userId,
        updatedAt: new Date(),
      })
      .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)))
      .returning();
    if (!after) throw notFound('Report schedule');
    return after;
  }

  private async one(tx: Transaction, row: ScheduleRow): Promise<ReportSchedule> {
    const [schedule] = await this.present(tx, [row]);
    if (!schedule) throw new Error('A report schedule presented no answer');
    return schedule;
  }

  // The answer for some rows: their recipients (and whether each can receive it now), who made
  // them, and the names of their filters. One query per kind of thing, not per row.
  private async present(tx: Transaction, rows: readonly ScheduleRow[]): Promise<ReportSchedule[]> {
    if (rows.length === 0) return [];
    const tenantId = getTenantId();
    const ids = rows.map((row) => row.id);
    const [recipients, creators] = await Promise.all([
      tx
        .select({
          scheduleId: reportScheduleRecipients.scheduleId,
          userId: users.id,
          name: users.fullName,
          email: users.email,
        })
        .from(reportScheduleRecipients)
        .innerJoin(users, eq(users.id, reportScheduleRecipients.userId))
        .where(
          and(
            eq(reportScheduleRecipients.tenantId, tenantId),
            inArray(reportScheduleRecipients.scheduleId, ids),
          ),
        )
        .orderBy(asc(reportScheduleRecipients.position)),
      tx
        .select({ id: users.id, name: users.fullName })
        .from(users)
        .where(inArray(users.id, [...new Set(rows.map((row) => row.createdBy))])),
    ]);
    // Who may read each kind of report now, once per kind
    const holders = new Map<ReportKind, Set<string>>();
    for (const report of new Set(rows.map((row) => row.report))) {
      holders.set(report, await permissionHolders(tx, REPORT_KIND_PERMISSIONS[report]));
    }
    const names = await filterNames(tx, rows);
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      report: row.report,
      format: row.format,
      when: whenOf(row),
      filters: row.filters,
      filterNames: {
        branch: names.get(row.filters.branchId),
        warehouse: names.get(row.filters.warehouseId),
        group: names.get(groupIdOf(row.filters)),
        category: names.get(row.filters.categoryId),
      },
      recipients: recipients
        .filter((recipient) => recipient.scheduleId === row.id)
        .map((recipient) => ({
          userId: recipient.userId,
          name: recipient.name,
          email: recipient.email,
          canReceive: holders.get(row.report)?.has(recipient.userId) ?? false,
        })),
      status: row.status,
      pausedReason: row.pausedReason,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      createdByName: creators.find((creator) => creator.id === row.createdBy)?.name ?? '',
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

async function timeZoneOf(tx: Transaction): Promise<string> {
  const [settings] = await tx
    .select({ timeZone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
  return settings.timeZone;
}

// Every person must be a member who may read the report (decision 30). The contract already
// refused nobody, more than 10 and the same person twice.
async function checkRecipients(
  tx: Transaction,
  report: ReportKind,
  recipientIds: readonly string[],
): Promise<void> {
  const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[report]);
  if (!recipientIds.every((userId) => holders.has(userId))) throw recipientsInvalid();
}

// All of a schedule's rows again, in the order they were picked: simpler than working out which
// moved, and a schedule has at most 10
async function saveRecipients(
  tx: Transaction,
  scheduleId: string,
  recipientIds: readonly string[],
): Promise<void> {
  const tenantId = getTenantId();
  await tx
    .delete(reportScheduleRecipients)
    .where(
      and(
        eq(reportScheduleRecipients.tenantId, tenantId),
        eq(reportScheduleRecipients.scheduleId, scheduleId),
      ),
    );
  await tx.insert(reportScheduleRecipients).values(
    recipientIds.map((userId, index) => ({
      tenantId,
      scheduleId,
      userId,
      position: index + 1,
    })),
  );
}

// A branch or a warehouse as the report pages' selects name it ("HO · Head office"), so the list
// and the change dialog say what the dialog that made the schedule said. Groups and categories
// show no code anywhere: their names alone.
function codeAndName(code: AnyColumn, name: AnyColumn): SQL<string> {
  return sql<string>`${code} || ' · ' || ${name}`;
}

// The names of every id the rows' filters hold, in one map: an id is unique across the tables, so
// one map serves them all. undefined (no such filter) and an id that is gone give null.
async function filterNames(
  tx: Transaction,
  rows: readonly ScheduleRow[],
): Promise<{ get: (id: string | undefined) => string | null }> {
  const tenantId = getTenantId();
  const ids: FilterIds = {
    branch: new Set(),
    warehouse: new Set(),
    group: new Set(),
    category: new Set(),
  };
  for (const { filters } of rows) {
    if (filters.branchId !== undefined) ids.branch.add(filters.branchId);
    if (filters.warehouseId !== undefined) ids.warehouse.add(filters.warehouseId);
    const group = groupIdOf(filters);
    if (group !== undefined) ids.group.add(group);
    if (filters.categoryId !== undefined) ids.category.add(filters.categoryId);
  }
  const found = await Promise.all([
    ids.branch.size === 0
      ? []
      : tx
          .select({ id: branches.id, name: codeAndName(branches.code, branches.name) })
          .from(branches)
          .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, [...ids.branch]))),
    ids.warehouse.size === 0
      ? []
      : tx
          .select({ id: warehouses.id, name: codeAndName(warehouses.code, warehouses.name) })
          .from(warehouses)
          .where(
            and(eq(warehouses.tenantId, tenantId), inArray(warehouses.id, [...ids.warehouse])),
          ),
    ids.group.size === 0
      ? []
      : tx
          .select({ id: customerGroups.id, name: customerGroups.name })
          .from(customerGroups)
          .where(
            and(eq(customerGroups.tenantId, tenantId), inArray(customerGroups.id, [...ids.group])),
          ),
    ids.group.size === 0
      ? []
      : tx
          .select({ id: supplierGroups.id, name: supplierGroups.name })
          .from(supplierGroups)
          .where(
            and(eq(supplierGroups.tenantId, tenantId), inArray(supplierGroups.id, [...ids.group])),
          ),
    ids.category.size === 0
      ? []
      : tx
          .select({ id: productCategories.id, name: productCategories.name })
          .from(productCategories)
          .where(
            and(
              eq(productCategories.tenantId, tenantId),
              inArray(productCategories.id, [...ids.category]),
            ),
          ),
  ]);
  const byId = new Map(found.flat().map((item) => [item.id, item.name]));
  return { get: (id) => (id === undefined ? null : (byId.get(id) ?? null)) };
}
```

Why it is written this way:

- **Two permissions everywhere.** The route needs `core.report.schedule`; `checkReport()` adds the report's own one
  (decision 6). The list leaves out the kinds this person may not read (`reportKindsFor()`, as the Exports page does),
  and `lock()` refuses them, so a schedule of a hidden report cannot be paused, edited or deleted by id either.
- **The same sort checks as an export** (`checkCostSort()`, `isStockValueSort()`): a schedule must not send a file whose
  order tells a hidden column. The recipients' files follow their own permissions anyway (decision 50).
- **The limit under an advisory lock** (decision 39). Two people saving the 20th schedule at once would both count 19
  without it. `hashtextextended(…, 0)` turns the workspace's key into the lock's number, as the opening balances do.
- **`checkRecipients()` after the lock**, inside the transaction: someone may lose their role between the form and the
  save. One error for every case (a non-member, a member without the report), under the people picker
  (`fieldErrors.recipientIds`).
- **`reportScheduleFiltersOf(input.query)`** keeps the filters and drops the dates (decision 29). The query was parsed by
  the report's own schema in the contract, so the filters are known to be right for that report.
- **`nextRunAt` from the workspace's time zone, and from now.** An update moves it only while the schedule is active: a
  paused one has none (the check constraint), and Resume works it out again.
- **`saveRecipients()` deletes and inserts.** At most 10 rows, in the order they were picked; working out which moved
  would be more code than the whole save. The unique `position` makes the delete-then-insert order matter: the other
  way round would collide.
- **Version checks on update, pause and resume** (decision 34), after the row is locked (`FOR UPDATE`), so the check and
  the change are one step. Pause on a paused schedule (or Resume on an active one) answers the row as it is: two people
  pressing Pause is not an error.
- **Resume checks that someone can receive it** (decision 31), or the next run would only pause it again.
- **Delete is for real** and takes the recipients with it (`ON DELETE CASCADE`); the audit row keeps every field, set
  to `null`, as the other deletes write it.
- **`present()` builds the answers of many rows with a fixed number of queries**: the recipients and the creators in one
  query each, the holders once per kind of report, the filter names once per table. The list of 20 schedules is a
  handful of queries, not a hundred.
- **`filterNames()` reads the filters by field name** (`branchId`, `warehouseId`, `customerGroupId` or
  `supplierGroupId`, `categoryId`): every report that has one of them calls it the same. An id that is gone (a deleted
  category) gives `null`, and the list shows the filter as "not set" rather than failing.
- **`codeAndName()` names a branch or a warehouse "HO · Head office"** (decision 65, found in 21c.7), the way the
  report pages' selects name them, so the list says what the dialog that made the schedule said.

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ReportSchedulesService } from './report-schedules.service.js';

type Schedules = typeof routes.reportSchedules;

// Step 21c: the scheduled report emails. Every route needs core.report.schedule; the service checks
// the report's own permission too.
@Controller()
export class ReportSchedulesController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @Endpoint(routes.reportSchedules.list)
  list(): Promise<RouteResponse<Schedules['list']>> {
    return this.schedules.list();
  }

  @Endpoint(routes.reportSchedules.candidates)
  candidates({
    query,
  }: RouteInput<Schedules['candidates']>): Promise<RouteResponse<Schedules['candidates']>> {
    return this.schedules.candidates(query.report);
  }

  @Endpoint(routes.reportSchedules.create)
  create({ body }: RouteInput<Schedules['create']>): Promise<RouteResponse<Schedules['create']>> {
    return this.schedules.create(body);
  }

  @Endpoint(routes.reportSchedules.update)
  update({
    params,
    body,
  }: RouteInput<Schedules['update']>): Promise<RouteResponse<Schedules['update']>> {
    return this.schedules.update(params.id, body);
  }

  @Endpoint(routes.reportSchedules.pause)
  pause({
    params,
    body,
  }: RouteInput<Schedules['pause']>): Promise<RouteResponse<Schedules['pause']>> {
    return this.schedules.pause(params.id, body.version);
  }

  @Endpoint(routes.reportSchedules.resume)
  resume({
    params,
    body,
  }: RouteInput<Schedules['resume']>): Promise<RouteResponse<Schedules['resume']>> {
    return this.schedules.resume(params.id, body.version);
  }

  @Endpoint(routes.reportSchedules.remove)
  remove({ params }: RouteInput<Schedules['remove']>): Promise<void> {
    return this.schedules.remove(params.id);
  }
}
```

```diff
@@ -4,17 +4,28 @@ import { JournalModule } from '../journal/journal.module.js';
 import { RbacModule } from '../rbac/rbac.module.js';
 import { FiscalYearsService } from './fiscal-years.service.js';
 import { ReportExportsService } from './report-exports.service.js';
+import { ReportSchedulesController } from './report-schedules.controller.js';
+import { ReportSchedulesService } from './report-schedules.service.js';
 import { ReportsController } from './reports.controller.js';
 import { ReportsService } from './reports.service.js';
 import { TradeReportsService } from './trade-reports.service.js';
+import { VatStockReportsService } from './vat-stock-reports.service.js';
 
 // The financial statements, the year-end close and the exports; since step 21b the sales and
-// purchase reports and the agings. JournalModule gives PostingService: the closing entry goes into
+// purchase reports and the agings; since step 21c the VAT and stock movement reports and the
+// scheduled report emails. JournalModule gives PostingService: the closing entry goes into
 // the books the same way as every other entry. RbacModule gives PermissionService: the cost columns
 // and each kind of export check their own permission.
 @Module({
   imports: [JournalModule, RbacModule],
-  controllers: [ReportsController],
-  providers: [ReportsService, FiscalYearsService, ReportExportsService, TradeReportsService],
+  controllers: [ReportsController, ReportSchedulesController],
+  providers: [
+    ReportsService,
+    FiscalYearsService,
+    ReportExportsService,
+    TradeReportsService,
+    VatStockReportsService,
+    ReportSchedulesService,
+  ],
 })
 export class ReportsModule {}
```

### The sweep: `reports/report-schedule-sweep.ts` (new)

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, reportSchedules, tenantSettings } from '@omnivo/db';
import { and, asc, eq, lte } from 'drizzle-orm';

import { emit } from '../common/outbox/outbox.js';
import { getTenantId, runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { RELAY_DB, WITH_TENANT } from '../infra/tokens.js';
import { catchUp, whenOf } from './report-schedule-row.js';

// How many due schedules one sweep takes. A workspace has at most 20; the next sweep, 5 minutes
// later, takes the rest.
const BATCH = 200;

// The 5-minute job (decision 9). Two halves, on two roles:
// 1. as omnivo_worker (RELAY_DB): which schedules are due, in every workspace. Migration 0062 lets
//    this role read only id, tenant_id and next_run_at (decision 37).
// 2. as omnivo_app, inside each schedule's own workspace: lock it, write the outbox event and move
//    next_run_at on, in one transaction. So a run is either handed over and moved on, or neither.
// The run itself (who gets it, the files) is the report.schedule_due job: a broken schedule fails
// there, with its own retries, and never holds up another workspace's.
// Provided by WorkerModule only; the HTTP process never has it.
@Injectable()
export class ReportScheduleSweep {
  private readonly logger = new Logger(ReportScheduleSweep.name);

  constructor(
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
  ) {}

  // The number of runs handed over. One clock for the whole sweep: the JavaScript one, used both
  // to find the due rows and to work out the next run, so a server whose clock differs from the
  // database's by a second cannot find a schedule due and then move it to a time already past.
  async run(now: Date = new Date()): Promise<number> {
    const due = await this.relayDb
      .select({ id: reportSchedules.id, tenantId: reportSchedules.tenantId })
      .from(reportSchedules)
      .where(lte(reportSchedules.nextRunAt, now))
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(BATCH);
    let handed = 0;
    for (const schedule of due) {
      try {
        if (await runWithTenant(schedule.tenantId, () => this.handOver(schedule.id, now))) {
          handed += 1;
        }
      } catch (error) {
        // One broken row must not stop the others; it is still due, so the next sweep tries again
        this.logger.warn(
          `report schedule ${schedule.id} (tenant ${schedule.tenantId}): ${String(error)}`,
        );
      }
    }
    return handed;
  }

  private handOver(scheduleId: string, now: Date): Promise<boolean> {
    return this.withTenant(async (tx) => {
      // SKIP LOCKED: a second worker's sweep, or a person saving this schedule right now, has it;
      // leave it to them. next_run_at again: it may have moved since the first read.
      const [row] = await tx
        .select()
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, getTenantId()),
            eq(reportSchedules.id, scheduleId),
            lte(reportSchedules.nextRunAt, now),
          ),
        )
        .for('update', { skipLocked: true });
      if (row?.nextRunAt == null) return false;
      const [settings] = await tx
        .select({ timeZone: tenantSettings.timezone })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, getTenantId()));
      if (!settings) throw new Error(`tenant_settings row missing for tenant ${row.tenantId}`);
      const { runAt, nextRunAt } = catchUp(whenOf(row), settings.timeZone, row.nextRunAt, now);
      await emit(tx, 'report.schedule_due', {
        scheduleId: row.id,
        runAt: runAt.toISOString(),
      });
      // Not the version: that is for people editing the schedule, and a sweep between opening
      // the form and saving it must not make their save fail
      await tx
        .update(reportSchedules)
        .set({ lastRunAt: now, nextRunAt })
        .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, row.id)));
      return true;
    });
  }
}
```

- **Two roles** (decision 37). The first query runs as `omnivo_worker` on `RELAY_DB` and selects only the three columns
  migration 0062 grants; asking for any other column would fail with "permission denied". Everything after it runs as
  `omnivo_app` inside the schedule's own workspace (`runWithTenant` + `withTenant`), under the normal tenant rules.
- **`FOR UPDATE SKIP LOCKED` and `next_run_at <= now` again.** A second worker's sweep, or a person saving the schedule
  at that moment, holds the row: this sweep leaves it to them instead of waiting. The second check skips a row whose run
  moved since the first read.
- **The event and the move in one transaction** (decision 9): either the run is handed over and `next_run_at` moved on,
  or neither, so a crash can never send a run twice or lose it.
- **`version` stays as it is.** It is for people editing the schedule: a sweep between opening the form and saving it
  must not make their save fail.
- **One broken row is logged and skipped.** It stays due, so the next sweep tries it again, and the other workspaces'
  runs still go.
- **`now` is a parameter** so the tests can sweep "three days later" without waiting (decision 47 for why it is one
  clock).

### One run: `reports/report-schedule-run.handler.ts` (new)

```ts
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  REPORT_KIND_PERMISSIONS,
  reportExportInputSchema,
  reportSchedulePeriod,
  reportScheduleQuery,
  todayIn,
} from '@omnivo/contracts';
import {
  reportExports,
  reportScheduleRecipients,
  reportSchedules,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit } from '../common/audit/audit.js';
import {
  emit,
  type EventHandler,
  type OutboxEvent,
  PermanentJobError,
} from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { permissionHolders } from '../rbac/holds-permission.js';
import { storedQuery } from './report-exports.service.js';
import { notifyScheduleCreator } from './report-schedule-bells.js';

type Event = OutboxEvent<'report.schedule_due'>;

// The id of one person's file of one run. The same every time the job runs, so a second run (a
// retry after a crash) finds the rows of the first and makes nothing twice. Still a UUIDv7 that
// sorts by time like every other export, because the Exports page lists the newest id first: the
// time is the event's own (the first 48 bits of its UUIDv7 id, written by the sweep), the rest
// comes from a hash of the two ids.
export function exportIdFor(eventId: string, userId: string): string {
  const hash = createHash('sha256').update(`${eventId}/${userId}`).digest('hex');
  const time = eventId.replaceAll('-', '').slice(0, 12);
  // The version (7) is the 13th digit; the variant (8, 9, a or b) the 17th
  const variant = ((Number.parseInt(hash.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  const hex = `${time}7${hash.slice(0, 3)}${variant}${hash.slice(4, 19)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// One run of a scheduled report (decisions 7–9): who still may read it, then one report_exports
// row per person, made by the export handler you already have, in each person's own language and
// with what each person's own permissions show. Everything in one transaction, so a run either
// hands every file over or none.
@Injectable()
export class ReportScheduleRunHandler implements EventHandler<'report.schedule_due'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // Locked: a person who saves or pauses it now waits until this run is handed over
      const [row] = await tx
        .select()
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, tenantId),
            eq(reportSchedules.id, event.payload.scheduleId),
          ),
        )
        .for('update');
      // Deleted or paused since the sweep: nothing to send
      if (row?.status !== 'active') return;
      const [settings] = await tx
        .select({ timeZone: tenantSettings.timezone })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);

      // The period from the run's day in the workspace's zone (decisions 8 and 28), parsed with
      // the report's own schema, as every export's query is. Broken filters (a row changed by
      // hand) cannot be fixed by running again.
      const period = reportSchedulePeriod(
        row.frequency,
        todayIn(settings.timeZone, new Date(event.payload.runAt)),
      );
      const input = reportExportInputSchema.safeParse({
        report: row.report,
        format: row.format,
        query: reportScheduleQuery(row.report, row.filters, period),
      });
      if (!input.success)
        throw new PermanentJobError(`Report schedule ${row.id} has broken filters`);

      // Who may read it now (decision 9): a member with the report's permission
      const recipients = await tx
        .select({ userId: reportScheduleRecipients.userId })
        .from(reportScheduleRecipients)
        .where(
          and(
            eq(reportScheduleRecipients.tenantId, tenantId),
            eq(reportScheduleRecipients.scheduleId, row.id),
          ),
        )
        .orderBy(asc(reportScheduleRecipients.position));
      const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[row.report]);
      const receiving = recipients.filter((recipient) => holders.has(recipient.userId));

      if (receiving.length === 0) {
        // Nobody left: Paused (decision 31). The check constraint wants no next run.
        await tx
          .update(reportSchedules)
          .set({
            status: 'paused',
            pausedReason: 'no_recipients',
            nextRunAt: null,
            version: sql`${reportSchedules.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(reportSchedules.tenantId, tenantId), eq(reportSchedules.id, row.id)));
        // No actor: the worker did it, and the audit log says so
        await audit(tx, {
          action: 'report_schedule.paused',
          entityType: 'report_schedule',
          entityId: row.id,
          changes: {
            status: { from: 'active', to: 'paused' },
            pausedReason: { from: null, to: 'no_recipients' },
          },
        });
        await notifyScheduleCreator(tx, {
          scheduleId: row.id,
          type: 'report.schedule_paused',
          params: { report: row.report },
          eventId: event.id,
        });
        return;
      }
      const skipped = recipients.length - receiving.length;
      if (skipped > 0) {
        await notifyScheduleCreator(tx, {
          scheduleId: row.id,
          type: 'report.schedule_skipped',
          params: { report: row.report, count: skipped },
          eventId: event.id,
        });
      }

      // One file per person. RETURNING gives only the rows this run inserted: on a second run of
      // the job it gives none, and no file is asked for twice.
      const query = storedQuery(input.data.query);
      const made = await tx
        .insert(reportExports)
        .values(
          receiving.map((recipient) => ({
            id: exportIdFor(event.id, recipient.userId),
            tenantId,
            requestedBy: recipient.userId,
            report: row.report,
            format: row.format,
            query,
          })),
        )
        .onConflictDoNothing({ target: reportExports.id })
        .returning({ id: reportExports.id });
      for (const file of made) {
        await emit(tx, 'report.export_requested', { exportId: file.id, scheduleId: row.id });
      }
    });
  }

  // After the last attempt (broken filters, or the database kept failing): the person who made it
  // hears that this run went to nobody
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ report: reportSchedules.report, format: reportSchedules.format })
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, tenantId),
            eq(reportSchedules.id, event.payload.scheduleId),
          ),
        );
      if (!row) return;
      await notifyScheduleCreator(tx, {
        scheduleId: event.payload.scheduleId,
        type: 'report.schedule_failed',
        params: { report: row.report, format: row.format },
        eventId: event.id,
      });
    });
  }
}
```

Why it is written this way:

- **`exportIdFor()`** is decision 42. The first 12 hex digits of a UUIDv7 are its time in milliseconds; the sweep's event
  id was made when it was written, so the files sort among the person's other exports at the time of the run. Then the
  version digit `7`, and the variant digit (`8`–`b`, the two high bits `10`) in the 17th place, so it is a valid UUID
  that `z.uuid()` accepts. The rest is a SHA-256 of the two ids: the same inputs always give the same id.
- **The schedule is locked first.** A person who saves or pauses it waits until this run is handed over, so a run never
  goes half to the old recipients and half to the new ones.
- **A schedule paused or deleted since the sweep sends nothing** (decision 45).
- **The period from `runAt` in the workspace's zone**, then `reportScheduleQuery()` and the export's own schema: the same
  checks as an export a person asks for. A query that does not parse is a row changed by hand; running again cannot fix
  it, so it is a `PermanentJobError`, and `onGiveUp` rings the creator's bell.
- **Who may read it now** (decision 9): `permissionHolders()` of the report's permission, which also leaves out people
  who are no longer members.
- **Nobody left: Paused** (decision 31), with the reason, no next run (the check constraint), a version step (a person's
  stale Pause must conflict), an audit row without an actor, and the bell. Then nothing else.
- **Some left out: the "skipped" bell** with how many (decision 32). The names are on the schedules page
  (`canReceive`), not in the bell.
- **`onConflictDoNothing` with `RETURNING`.** RETURNING gives only the rows this insert made, so on a second run of the
  job it gives none, and no `report.export_requested` is written twice.
- **One `report.export_requested` per file, with `scheduleId`**: the export handler makes each person's file in their
  own language, with their own permissions (decision 7), and knows to email it.

### The export handler: two new kinds, and the email

```diff
@@ -96,3 +96,12 @@ const MONTH = {
 export function formatMonth(month: string, language: LanguageCode): string {
   return MONTH[language].format(new Date(`${month}-01T00:00:00Z`));
 }
+
+// Step 21c: a VAT rate as the app shows it, "15" or "7.5", without the zeros a numeric(5,2) keeps
+export function formatPercent(value: string, language: LanguageCode): string {
+  if (!isDecimal(value)) return value;
+  return new Intl.NumberFormat(language === 'bn' ? 'bn-BD' : 'en-IN', {
+    minimumFractionDigits: 0,
+    maximumFractionDigits: 2,
+  }).format(value);
+}
```

`formatPercent()`: a rate is stored as `numeric(5,2)`, so `15.00`; the file says "15%" and "7.5%", as the app does.

```diff
@@ -60,6 +60,33 @@ export interface Copy {
   overdueOnly: string;
   // The books' figure under the heading, for the reader to compare with the total
   inBooks: (amount: string) => string;
+  // Step 21c. The VAT report's columns and the lines under its title
+  vat: {
+    rate: string;
+    outputNet: string;
+    outputVat: string;
+    inputNet: string;
+    inputVat: string;
+    netVat: string;
+  };
+  vatInBooks: (output: string, input: string) => string;
+  vatReturned: (output: string, input: string) => string;
+  withoutMushak: (amount: string) => string;
+  // The stock movement report's columns and lines
+  stock: {
+    product: string;
+    sku: string;
+    opening: string;
+    purchased: string;
+    sold: string;
+    transfers: string;
+    adjusted: string;
+    closing: string;
+    openingValue: string;
+    closingValue: string;
+  };
+  warehouse: (name: string) => string;
+  withStockOnly: string;
 }
 
 export const COPY = {
@@ -72,6 +99,8 @@ export const COPY = {
       purchase_report: 'Purchase report',
       ar_aging: 'Receivables aging',
       ap_aging: 'Payables aging',
+      vat_report: 'VAT report',
+      stock_movement: 'Stock movement',
     },
     sections: {
       asset: 'Assets',
@@ -147,6 +176,32 @@ export const COPY = {
     category: (name) => `Category: ${name}`,
     overdueOnly: 'Overdue only',
     inBooks: (amount) => `In the books: ${amount}`,
+    vat: {
+      rate: 'VAT rate',
+      outputNet: 'Sales before VAT',
+      outputVat: 'Output VAT',
+      inputNet: 'Purchases before VAT',
+      inputVat: 'Input VAT',
+      netVat: 'Net VAT',
+    },
+    vatInBooks: (output, input) => `In the books: output VAT ${output}, input VAT ${input}`,
+    vatReturned: (output, input) =>
+      `Taken off: ${output} output VAT (credit notes and POS returns), ${input} input VAT (debit notes)`,
+    withoutMushak: (amount) => `Input VAT on bills with no Mushak 6.3: ${amount}`,
+    stock: {
+      product: 'Product',
+      sku: 'SKU',
+      opening: 'Opening',
+      purchased: 'Purchased',
+      sold: 'Sold',
+      transfers: 'Transfers',
+      adjusted: 'Adjusted',
+      closing: 'Closing',
+      openingValue: 'Opening value',
+      closingValue: 'Closing value',
+    },
+    warehouse: (name) => `Warehouse: ${name}`,
+    withStockOnly: 'Also the products that did not move',
   },
   bn: {
     titles: {
@@ -157,6 +212,8 @@ export const COPY = {
       purchase_report: 'কেনাকাটার রিপোর্ট',
       ar_aging: 'পাওনার এজিং',
       ap_aging: 'দেনার এজিং',
+      vat_report: 'VAT রিপোর্ট',
+      stock_movement: 'স্টকের আসা-যাওয়া',
     },
     sections: {
       asset: 'সম্পদ',
@@ -232,5 +289,31 @@ export const COPY = {
     category: (name) => `ক্যাটাগরি: ${name}`,
     overdueOnly: 'শুধু সময় পার',
     inBooks: (amount) => `হিসাবের খাতায়: ${amount}`,
+    vat: {
+      rate: 'VAT-এর হার',
+      outputNet: 'VAT-এর আগে বিক্রি',
+      outputVat: 'আউটপুট VAT',
+      inputNet: 'VAT-এর আগে কেনাকাটা',
+      inputVat: 'ইনপুট VAT',
+      netVat: 'নিট VAT',
+    },
+    vatInBooks: (output, input) => `হিসাবের খাতায়: আউটপুট VAT ${output}, ইনপুট VAT ${input}`,
+    vatReturned: (output, input) =>
+      `বাদ গেছে: আউটপুট VAT ${output} (ক্রেডিট নোট আর POS ফেরত), ইনপুট VAT ${input} (ডেবিট নোট)`,
+    withoutMushak: (amount) => `মূসক ৬.৩ ছাড়া বিলের ইনপুট VAT: ${amount}`,
+    stock: {
+      product: 'প্রোডাক্ট',
+      sku: 'SKU',
+      opening: 'শুরুতে',
+      purchased: 'কেনা',
+      sold: 'বিক্রি',
+      transfers: 'ট্রান্সফার',
+      adjusted: 'অ্যাডজাস্টমেন্ট',
+      closing: 'শেষে',
+      openingValue: 'শুরুর মূল্য',
+      closingValue: 'শেষের মূল্য',
+    },
+    warehouse: (name) => `গুদাম: ${name}`,
+    withStockOnly: 'যে প্রোডাক্ট নড়েনি সেগুলোও',
   },
 } satisfies Record<LanguageCode, Copy>;
```

The words of the two new files, in both languages. `satisfies Record<LanguageCode, Copy>` stops a missing one at compile
time.

```diff
@@ -21,12 +21,24 @@ import {
   type SalesReport,
   type SalesReportFilter,
   type SalesReportRow,
+  type StockMovementFilter,
+  type StockMovementReport,
+  type StockMovementRow,
   type TrialBalance,
   type TrialBalanceQuery,
+  type VatReport,
+  type VatReportFilter,
 } from '@omnivo/contracts';
 
 import { COPY, type Copy } from './copy.js';
-import { formatAmount, formatIsoDate, formatMoment, formatMonth, formatNumber } from './format.js';
+import {
+  formatAmount,
+  formatIsoDate,
+  formatMoment,
+  formatMonth,
+  formatNumber,
+  formatPercent,
+} from './format.js';
 
 // One report as a plain table: the Excel and the PDF writer both draw this, so the two files
 // always hold the same rows in the same order. Amounts stay decimal strings here; each writer
@@ -78,7 +90,9 @@ export type ReportData =
   | { report: 'sales_report'; query: SalesReportFilter; data: SalesReport }
   | { report: 'purchase_report'; query: PurchaseReportFilter; data: PurchaseReport }
   | { report: 'ar_aging'; query: ArAgingFilter; data: AgingReport }
-  | { report: 'ap_aging'; query: ApAgingFilter; data: AgingReport };
+  | { report: 'ap_aging'; query: ApAgingFilter; data: AgingReport }
+  | { report: 'vat_report'; query: VatReportFilter; data: VatReport }
+  | { report: 'stock_movement'; query: StockMovementFilter; data: StockMovementReport };
 
 // The names of what the query filters by, read by the handler: a file says "Branch: Sylhet depot",
 // never an id
@@ -91,6 +105,8 @@ export interface DocumentContext {
   // Step 21b: the customer or supplier group, and the product category
   groupName: string | null;
   categoryName: string | null;
+  // Step 21c: the stock movement report's warehouse
+  warehouseName: string | null;
   madeAt: Date;
 }
 
@@ -504,6 +520,146 @@ function agingDocument(
   };
 }
 
+// ---------------------------------------------------------------------------------------------
+// Step 21c: the VAT report (its summary by rate: the documents are on the page) and the stock
+// movement report
+
+function vatDocument(
+  query: VatReportFilter,
+  data: VatReport,
+  copy: Copy,
+  context: DocumentContext,
+): Body {
+  const { language } = context;
+  const date = (iso: string) => formatIsoDate(iso, language);
+  const amount = (value: string) => formatAmount(value, language);
+  const amounts = (row: VatReport['totals'] | VatReport['rows'][number]): DocCell[] => [
+    money(row.outputNet),
+    money(row.outputVat),
+    money(row.inputNet),
+    money(row.inputVat),
+    money(row.netVat),
+  ];
+  return {
+    landscape: true,
+    lines: [
+      copy.range(date(query.from), date(query.to)),
+      ...(context.branchName === null ? [] : [copy.branch(context.branchName)]),
+      copy.vatInBooks(amount(data.books.output), amount(data.books.input)),
+      // Only when something was taken off: a month without returns needs no line of zeros
+      ...(isZeroMoney(data.totals.outputVatReturned) && isZeroMoney(data.totals.inputVatReturned)
+        ? []
+        : [
+            copy.vatReturned(
+              amount(data.totals.outputVatReturned),
+              amount(data.totals.inputVatReturned),
+            ),
+          ]),
+      ...(isZeroMoney(data.totals.inputVatWithoutMushak)
+        ? []
+        : [copy.withoutMushak(amount(data.totals.inputVatWithoutMushak))]),
+    ],
+    columns: [
+      { header: copy.vat.rate, kind: 'text', width: 30 },
+      { header: copy.vat.outputNet, kind: 'money', width: 18 },
+      { header: copy.vat.outputVat, kind: 'money', width: 16 },
+      { header: copy.vat.inputNet, kind: 'money', width: 18 },
+      { header: copy.vat.inputVat, kind: 'money', width: 16 },
+      { header: copy.vat.netVat, kind: 'money', width: 16 },
+    ],
+    rows: [
+      ...data.rows.map((row): DocRow => ({
+        style: 'normal',
+        indent: 0,
+        // "VAT 15% · 15%": the name and the percent, as the app shows a rate
+        cells: [text(`${row.name} · ${formatPercent(row.rate, language)}%`), ...amounts(row)],
+      })),
+      { style: 'grand', indent: 0, cells: [text(copy.total), ...amounts(data.totals)] },
+    ],
+  };
+}
+
+// "Napa 500mg (Strip)": the variant's options after the product's name
+function variantName(row: StockMovementRow): string {
+  return row.optionValues.length === 0
+    ? row.productName
+    : `${row.productName} (${row.optionValues.join(', ')})`;
+}
+
+function stockMovementDocument(
+  query: StockMovementFilter,
+  data: StockMovementReport,
+  copy: Copy,
+  context: DocumentContext,
+): Body {
+  const { language } = context;
+  // "72 pcs" with the unit's decimals; a quantity of another product's unit is never added to it
+  const quantity = (row: StockMovementRow, value: string): DocCell => ({
+    kind: 'number',
+    text: `${formatNumber(value, row.baseUnit.decimals, language)} ${row.baseUnit.code}`,
+  });
+  const valueColumns: DocColumn[] = data.withValue
+    ? [
+        { header: copy.stock.openingValue, kind: 'money', width: 16 },
+        { header: copy.stock.closingValue, kind: 'money', width: 16 },
+      ]
+    : [];
+  return {
+    landscape: true,
+    lines: [
+      copy.range(formatIsoDate(query.from, language), formatIsoDate(query.to, language)),
+      ...(context.warehouseName === null ? [] : [copy.warehouse(context.warehouseName)]),
+      ...(context.categoryName === null ? [] : [copy.category(context.categoryName)]),
+      ...(query.show === 'all' ? [copy.withStockOnly] : []),
+    ],
+    columns: [
+      { header: copy.stock.product, kind: 'text', width: 34 },
+      { header: copy.stock.sku, kind: 'text', width: 14 },
+      { header: copy.stock.opening, kind: 'number', width: 13 },
+      { header: copy.stock.purchased, kind: 'number', width: 13 },
+      { header: copy.stock.sold, kind: 'number', width: 13 },
+      { header: copy.stock.transfers, kind: 'number', width: 13 },
+      { header: copy.stock.adjusted, kind: 'number', width: 13 },
+      { header: copy.stock.closing, kind: 'number', width: 13 },
+      ...valueColumns,
+    ],
+    rows: [
+      ...data.items.map((row): DocRow => ({
+        style: 'normal',
+        indent: 0,
+        cells: [
+          text(variantName(row)),
+          text(row.sku),
+          quantity(row, row.opening),
+          quantity(row, row.purchased),
+          quantity(row, row.sold),
+          quantity(row, row.transfers),
+          quantity(row, row.adjusted),
+          quantity(row, row.closing),
+          ...(data.withValue
+            ? [money(row.openingValue ?? '0'), money(row.closingValue ?? '0')]
+            : []),
+        ],
+      })),
+      // Quantities never add up (decision 23): a total row only for the values
+      ...(data.withValue
+        ? [
+            {
+              style: 'grand' as const,
+              indent: 0,
+              cells: [
+                text(copy.total),
+                ...Array.from({ length: 7 }, () => empty),
+                money(data.totals.openingValue ?? '0'),
+                money(data.totals.closingValue ?? '0'),
+              ],
+            },
+          ]
+        : []),
+    ],
+  };
+}
+
 function bodyOf(report: ReportData, copy: Copy, context: DocumentContext): Body {
   switch (report.report) {
     case 'trial_balance':
@@ -526,6 +682,10 @@ function bodyOf(report: ReportData, copy: Copy, context: DocumentContext): Body
       return agingDocument(report.query, report.data, 'customer', copy, context);
     case 'ap_aging':
       return agingDocument(report.query, report.data, 'supplier', copy, context);
+    case 'vat_report':
+      return vatDocument(report.query, report.data, copy, context);
+    case 'stock_movement':
+      return stockMovementDocument(report.query, report.data, copy, context);
   }
 }
 
@@ -558,6 +718,8 @@ export function fileStem(report: ReportData): string {
     purchase_report: 'purchases',
     ar_aging: 'receivables-aging',
     ap_aging: 'payables-aging',
+    vat_report: 'vat',
+    stock_movement: 'stock-movement',
   };
   // A picture of one day has its date, a period its two
   const dates =
```

- **The VAT file is the summary** (decision 49): one row per rate, the totals as the grand row. The lines under the title
  are only the ones with something to say: what was taken off and the VAT without a Mushak 6.3 are left out when they
  are zero, so a quiet month's file is not a list of zeros.
- **The stock movement file has no total of quantities** (decision 23). Its grand row exists only with the values, with
  seven empty cells so the two amounts stay under their columns.
- **Quantities are `number` cells with their unit** ("72 pcs"), right-aligned but never summed by Excel, as in 21b.
- **`warehouseName` in the context**: the stock movement file says "Warehouse: Main store", never an id.

```diff
@@ -7,7 +7,10 @@ import {
   type ReportSection,
   type SalesReport,
   type SalesReportRow,
+  type StockMovementReport,
+  type StockMovementRow,
   type TrialBalance,
+  type VatReport,
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
@@ -21,6 +24,7 @@ const context: DocumentContext = {
   branchName: null,
   groupName: null,
   categoryName: null,
+  warehouseName: null,
   madeAt: new Date('2026-10-01T08:05:00Z'),
 };
 
@@ -421,3 +425,227 @@ describe('the document of an aging', () => {
     expect(fileStem(report)).toBe('payables-aging-2026-11-05');
   });
 });
+
+describe('the document of a VAT report', () => {
+  const rate = (name: string, kind: 'standard' | 'exempt', percent: string) => ({
+    key: `${id(1)}:${kind}:${percent}`,
+    taxRateId: id(1),
+    name,
+    kind,
+    rate: percent,
+  });
+  const data: VatReport = {
+    rows: [
+      {
+        ...rate('VAT 15%', 'standard', '15.00'),
+        outputNet: '4704.0000',
+        outputVat: '705.6000',
+        inputNet: '2430.0000',
+        inputVat: '364.5000',
+        netVat: '341.1000',
+      },
+      {
+        ...rate('Exempt', 'exempt', '0.00'),
+        outputNet: '0.0000',
+        outputVat: '0.0000',
+        inputNet: '11000.0000',
+        inputVat: '0.0000',
+        netVat: '0.0000',
+      },
+    ],
+    totals: {
+      outputNet: '4704.0000',
+      outputVat: '705.6000',
+      outputVatReturned: '49.6500',
+      inputNet: '13430.0000',
+      inputVat: '364.5000',
+      inputVatReturned: '55.5000',
+      inputVatWithoutMushak: '420.0000',
+      netVat: '341.1000',
+    },
+    books: { output: '705.6000', input: '364.5000' },
+  };
+  const query = { from: '2026-10-01', to: '2026-10-31' };
+
+  it("has a row per rate with the rate's name and percent, the total, and the books", () => {
+    const doc = buildDocument(
+      { report: 'vat_report', query, data },
+      { ...context, branchName: 'Agrabad depot' },
+    );
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'VAT rate',
+      'Sales before VAT',
+      'Output VAT',
+      'Purchases before VAT',
+      'Input VAT',
+      'Net VAT',
+    ]);
+    expect(doc.rows.map((row) => row.cells.map(read))).toEqual([
+      ['VAT 15% · 15%', '4704.0000', '705.6000', '2430.0000', '364.5000', '341.1000'],
+      ['Exempt · 0%', '0.0000', '0.0000', '11000.0000', '0.0000', '0.0000'],
+      ['Total', '4704.0000', '705.6000', '13430.0000', '364.5000', '341.1000'],
+    ]);
+    expect(doc.rows.at(-1)?.style).toBe('grand');
+    expect(doc.lines).toEqual([
+      '1 Oct 2026 – 31 Oct 2026',
+      'Branch: Agrabad depot',
+      'In the books: output VAT 705.60, input VAT 364.50',
+      'Taken off: 49.65 output VAT (credit notes and POS returns), 55.50 input VAT (debit notes)',
+      'Input VAT on bills with no Mushak 6.3: 420.00',
+      'Amounts in BDT',
+      'Made on 1 Oct 2026, 14:05',
+    ]);
+    expect(fileStem({ report: 'vat_report', query, data })).toBe('vat-2026-10-01-to-2026-10-31');
+  });
+
+  it('leaves out the lines of zeros, and writes Bangla digits in Bangla', () => {
+    const quiet: VatReport = {
+      ...data,
+      totals: {
+        ...data.totals,
+        outputVatReturned: '0.0000',
+        inputVatReturned: '0.0000',
+        inputVatWithoutMushak: '0.0000',
+      },
+    };
+    const doc = buildDocument(
+      { report: 'vat_report', query, data: quiet },
+      { ...context, language: 'bn' },
+    );
+    // The dates, the books, then the currency and the time: no "taken off", no "no 6.3"
+    expect(doc.lines).toHaveLength(4);
+    expect(doc.lines[1]).toBe('হিসাবের খাতায়: আউটপুট VAT ৭০৫.৬০, ইনপুট VAT ৩৬৪.৫০');
+    // The rate's own name stays as the workspace wrote it; the percent is in Bangla digits
+    expect(doc.rows[0]?.cells.map(read)[0]).toBe('VAT 15% · ১৫%');
+  });
+});
+
+describe('the document of a stock movement report', () => {
+  const row = (
+    n: number,
+    name: string,
+    unit: { code: string; decimals: number },
+    numbers: [string, string, string, string, string, string],
+    options: string[] = [],
+  ): StockMovementRow => ({
+    variantId: id(n),
+    productId: id(100 + n),
+    productCode: `P-${String(n)}`,
+    productName: name,
+    optionValues: options,
+    sku: `SKU-${String(n)}`,
+    baseUnitId: id(200 + n),
+    baseUnit: unit,
+    opening: numbers[0],
+    purchased: numbers[1],
+    sold: numbers[2],
+    transfers: numbers[3],
+    adjusted: numbers[4],
+    closing: numbers[5],
+    openingValue: '1500.0000',
+    closingValue: '1250.0000',
+  });
+  const data: StockMovementReport = {
+    items: [
+      row(
+        1,
+        'Napa 500mg',
+        { code: 'pcs', decimals: 0 },
+        ['1200.0000', '500.0000', '440.0000', '-10.0000', '0.0000', '1250.0000'],
+        ['Strip'],
+      ),
+      row(2, 'Gauze roll', { code: 'm', decimals: 2 }, [
+        '12.5000',
+        '0.0000',
+        '2.7400',
+        '0.0000',
+        '-0.5000',
+        '9.2600',
+      ]),
+    ],
+    nextCursor: null,
+    withValue: true,
+    totals: { variants: 2, openingValue: '3000.0000', closingValue: '2500.0000' },
+  };
+  const query = {
+    from: '2026-10-01',
+    to: '2026-10-31',
+    show: 'all',
+    sort: 'name',
+  } as const;
+
+  it('writes each quantity with its own unit, and adds up only the values', () => {
+    const doc = buildDocument(
+      { report: 'stock_movement', query, data },
+      { ...context, warehouseName: 'Agrabad depot', categoryName: 'Medicines' },
+    );
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns).toHaveLength(10);
+    expect(doc.rows.map((item) => item.cells.map(read))).toEqual([
+      [
+        'Napa 500mg (Strip)',
+        'SKU-1',
+        '1,200 pcs',
+        '500 pcs',
+        '440 pcs',
+        '-10 pcs',
+        '0 pcs',
+        '1,250 pcs',
+        '1500.0000',
+        '1250.0000',
+      ],
+      [
+        'Gauze roll',
+        'SKU-2',
+        '12.50 m',
+        '0.00 m',
+        '2.74 m',
+        '0.00 m',
+        '-0.50 m',
+        '9.26 m',
+        '1500.0000',
+        '1250.0000',
+      ],
+      // Pieces and metres never add up: the total row has the values only
+      ['Total', '', '', '', '', '', '', '', '3000.0000', '2500.0000'],
+    ]);
+    expect(doc.lines.slice(0, 4)).toEqual([
+      '1 Oct 2026 – 31 Oct 2026',
+      'Warehouse: Agrabad depot',
+      'Category: Medicines',
+      'Also the products that did not move',
+    ]);
+    expect(fileStem({ report: 'stock_movement', query, data })).toBe(
+      'stock-movement-2026-10-01-to-2026-10-31',
+    );
+  });
+
+  it('has no value columns and no total row for someone who may not see the value', () => {
+    const doc = buildDocument(
+      {
+        report: 'stock_movement',
+        query: { ...query, show: 'moved' },
+        data: {
+          ...data,
+          withValue: false,
+          items: data.items.map((item) => ({ ...item, openingValue: null, closingValue: null })),
+          totals: { variants: 2, openingValue: null, closingValue: null },
+        },
+      },
+      context,
+    );
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Product',
+      'SKU',
+      'Opening',
+      'Purchased',
+      'Sold',
+      'Transfers',
+      'Adjusted',
+      'Closing',
+    ]);
+    expect(doc.rows).toHaveLength(2);
+    expect(doc.lines[1]).toBe('Amounts in BDT');
+  });
+});
```

The test's context needs the new field; the tests of the two new files are in 21c.4.

```diff
@@ -35,8 +35,9 @@ function toReportExport(row: ExportRow): ReportExport {
   };
 }
 
-// The query's set values only: an optional field the page left out is not stored as null
-function storedQuery(query: Record<string, string | undefined>): Record<string, string> {
+// The query's set values only: an optional field the page left out is not stored as null. Since
+// step 21c a scheduled run stores its query the same way (report-schedule-run.handler.ts).
+export function storedQuery(query: Record<string, string | undefined>): Record<string, string> {
   return Object.fromEntries(
     Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
   );
```

The run stores its query the way an export does, so `storedQuery()` is exported instead of written twice.

```ts
import type { NotificationParams, NotificationType } from '@omnivo/contracts';
import { memberships, reportSchedules } from '@omnivo/db';
import { and, eq, isNull } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { notify } from '../notifications/notify.js';

// A scheduled report's bells go to the person who made the schedule, and only while they are still
// a member (decision 12): someone who left cannot open the bell, and nobody else is told instead.
// A schedule deleted meanwhile has nobody to tell either.
export async function notifyScheduleCreator(
  tx: Transaction,
  input: {
    scheduleId: string;
    type: Extract<NotificationType, `report.schedule_${string}`>;
    params: NotificationParams;
    eventId: string;
  },
): Promise<void> {
  const tenantId = getTenantId();
  const [creator] = await tx
    .select({ userId: memberships.userId })
    .from(reportSchedules)
    .innerJoin(
      memberships,
      and(
        eq(memberships.tenantId, reportSchedules.tenantId),
        eq(memberships.userId, reportSchedules.createdBy),
        isNull(memberships.deletedAt),
      ),
    )
    .where(and(eq(reportSchedules.tenantId, tenantId), eq(reportSchedules.id, input.scheduleId)));
  if (!creator) return;
  await notify(tx, {
    userId: creator.userId,
    type: input.type,
    params: input.params,
    eventId: input.eventId,
  });
}
```

Decision 12, in one place for the three jobs that ring these bells: the creator, and only while they are a member. The
`Extract<…, 'report.schedule_${string}'>` type lets it ring only the three schedule bells.

```diff
@@ -4,10 +4,13 @@ import {
   arAgingFilterSchema,
   balanceSheetQuerySchema,
   type ExportFormat,
+  isStockValueSort,
   profitAndLossQuerySchema,
   purchaseReportFilterSchema,
   salesReportFilterSchema,
+  stockMovementFilterSchema,
   trialBalanceQuerySchema,
+  vatReportFilterSchema,
 } from '@omnivo/contracts';
 import {
   branches,
@@ -18,11 +21,17 @@ import {
   tenants,
   tenantSettings,
   users,
+  warehouses,
 } from '@omnivo/db';
 import { and, eq } from 'drizzle-orm';
 import type { z } from 'zod';
 
-import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
+import {
+  emit,
+  type EventHandler,
+  type OutboxEvent,
+  PermanentJobError,
+} from '../common/outbox/outbox.js';
 import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
@@ -39,7 +48,10 @@ import {
 import { writePdf } from './export/pdf.js';
 import { writeXlsx } from './export/xlsx.js';
 import { balanceSheet, profitAndLoss, trialBalance } from './report-queries.js';
+import { notifyScheduleCreator } from './report-schedule-bells.js';
+import { stockMovementReport } from './stock-movement-queries.js';
 import { purchaseReport, salesReport } from './trade-report-queries.js';
+import { vatReport } from './vat-queries.js';
 
 const CONTENT_TYPES = {
   xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
@@ -96,6 +108,21 @@ async function reportData(tx: Transaction, row: ExportRow): Promise<ReportData>
       const query = queryOf(apAgingFilterSchema, row);
       return { report: row.report, query, data: await payablesAging(tx, query, null) };
     }
+    // Step 21c: the VAT summary by rate, and every row of the stock movement report
+    case 'vat_report': {
+      const query = queryOf(vatReportFilterSchema, row);
+      return { report: row.report, query, data: await vatReport(tx, query) };
+    }
+    case 'stock_movement': {
+      const query = queryOf(stockMovementFilterSchema, row);
+      // As for the sales report's cost: the values as the person may see them now, and a value
+      // sort they lost falls back to the name (decision 24)
+      const withValue = await holdsPermission(tx, row.requestedBy, 'inventory.stock.value');
+      const sorted =
+        withValue || !isStockValueSort(query.sort) ? query : { ...query, sort: 'name' as const };
+      const data = await stockMovementReport(tx, sorted, { withValue, page: null });
+      return { report: row.report, query, data };
+    }
   }
 }
 
@@ -107,9 +134,11 @@ async function filterNames(tx: Transaction, report: ReportData) {
     branchId:
       report.report === 'profit_and_loss' ||
       report.report === 'sales_report' ||
-      report.report === 'purchase_report'
+      report.report === 'purchase_report' ||
+      report.report === 'vat_report'
         ? report.query.branchId
         : undefined,
+    warehouseId: report.report === 'stock_movement' ? report.query.warehouseId : undefined,
     customerGroupId:
       report.report === 'sales_report' || report.report === 'ar_aging'
         ? report.query.customerGroupId
@@ -119,11 +148,13 @@ async function filterNames(tx: Transaction, report: ReportData) {
         ? report.query.supplierGroupId
         : undefined,
     categoryId:
-      report.report === 'sales_report' || report.report === 'purchase_report'
+      report.report === 'sales_report' ||
+      report.report === 'purchase_report' ||
+      report.report === 'stock_movement'
         ? report.query.categoryId
         : undefined,
   };
-  const [[branch], [customerGroup], [supplierGroup], [category]] = await Promise.all([
+  const [[branch], [customerGroup], [supplierGroup], [category], [warehouse]] = await Promise.all([
     ids.branchId === undefined
       ? []
       : tx
@@ -154,11 +185,18 @@ async function filterNames(tx: Transaction, report: ReportData) {
           .where(
             and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, ids.categoryId)),
           ),
+    ids.warehouseId === undefined
+      ? []
+      : tx
+          .select({ name: warehouses.name })
+          .from(warehouses)
+          .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, ids.warehouseId))),
   ]);
   return {
     branchName: branch?.name ?? null,
     groupName: customerGroup?.name ?? supplierGroup?.name ?? null,
     categoryName: category?.name ?? null,
+    warehouseName: warehouse?.name ?? null,
   };
 }
 
@@ -225,7 +263,9 @@ export class ReportExportHandler implements EventHandler<'report.export_requeste
     await this.storage.put(key, bytes, contentType);
 
     // 3) Mark it ready and tell the person. `status = 'pending'` in the WHERE: if two runs raced
-    //    this far, only one row update (and one notification) happens.
+    //    this far, only one row update (and one notification) happens. A scheduled report's file
+    //    goes by email instead (step 21c): the email job, in the same transaction as the mark, so
+    //    a file that is ready is always emailed, and only once.
     await this.withTenant(async (tx) => {
       const [done] = await tx
         .update(reportExports)
@@ -246,6 +286,11 @@ export class ReportExportHandler implements EventHandler<'report.export_requeste
         )
         .returning({ id: reportExports.id });
       if (!done) return;
+      const { scheduleId } = event.payload;
+      if (scheduleId !== undefined) {
+        await emit(tx, 'report.schedule_email', { exportId: row.id, scheduleId });
+        return;
+      }
       await notify(tx, {
         userId: row.requestedBy,
         type: 'report.ready',
@@ -275,10 +320,22 @@ export class ReportExportHandler implements EventHandler<'report.export_requeste
           format: reportExports.format,
         });
       if (!failed) return;
+      const params = { report: failed.report, format: failed.format };
+      // Nobody asked for a scheduled file: the person who made the schedule hears it (decision 32)
+      const { scheduleId } = event.payload;
+      if (scheduleId !== undefined) {
+        await notifyScheduleCreator(tx, {
+          scheduleId,
+          type: 'report.schedule_failed',
+          params,
+          eventId: event.id,
+        });
+        return;
+      }
       await notify(tx, {
         userId: failed.requestedBy,
         type: 'report.failed',
-        params: { report: failed.report, format: failed.format },
+        params,
         eventId: event.id,
       });
     });
```

- **The two new cases in `reportData()`.** The stock movement file checks `inventory.stock.value` for the person the
  file is for, when it is made, like the sales file's cost (decision 50).
- **`filterNames()`** reads the VAT report's branch, the stock movement report's warehouse and category.
- **The email instead of the bell**, in the same transaction as the "ready" mark: a file marked ready is always emailed,
  and since the mark happens once (`status = 'pending'` in the `WHERE`), it is emailed once.
- **`onGiveUp` with a schedule** rings the creator's "failed" bell, not the recipient's "report failed" one: the
  recipient never asked for it (decision 32). The row is still marked failed on their Exports page.

### The email: `mail/scheduled-report-email.ts` and its job

```ts
import type { LanguageCode, ReportScheduleFrequency } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

// A scheduled report (step 21c), to one member of the workspace. Omnivo's own email, like the
// invitation: our address and name, the company's name at the top. The file is attached up to
// 5 MB (decision 7); a larger one is a button to the person's Exports page, which needs a sign-in,
// so a forwarded email never hands a big file to someone else either.

interface ScheduledReportEmailInput {
  to: string;
  // The person's own language, like the file
  language: LanguageCode;
  company: string;
  // The report's title and its period, already in the person's language
  title: string;
  period: string;
  frequency: ReportScheduleFrequency;
  fileName: string;
  // null: too large to attach, so the button opens the Exports page instead
  file: { bytes: Uint8Array; contentType: string } | null;
  schedulesUrl: string;
  exportsUrl: string;
}

interface Copy {
  every: Record<ReportScheduleFrequency, string>;
  subject: (title: string, period: string, company: string) => string;
  intro: (title: string, period: string) => string;
  attached: (file: string) => string;
  tooLarge: string;
  download: string;
  manage: string;
  why: (company: string, every: string) => string;
  stop: (link: string) => string;
}

// The words here, not in @omnivo/i18n, for the reason invitation-email.ts gives: that package is for
// the browser. satisfies: a text missing in one language does not compile.
const COPY = {
  en: {
    every: { daily: 'every day', weekly: 'every week', monthly: 'every month' },
    subject: (title, period, company) => `${title}, ${period} · ${company}`,
    intro: (title, period) => `${title} for ${period}.`,
    attached: (file) => `The file is attached: ${file}`,
    tooLarge: 'The file is too large to attach. Sign in to download it from your exports.',
    download: 'Download the file',
    manage: 'Change this email',
    why: (company, every) =>
      `You get this email because ${company} sends this report to you ${every}.`,
    stop: (link) => `To change or stop it: ${link}`,
  },
  bn: {
    every: { daily: 'প্রতিদিন', weekly: 'প্রতি সপ্তাহে', monthly: 'প্রতি মাসে' },
    subject: (title, period, company) => `${title}, ${period} · ${company}`,
    intro: (title, period) => `${title}, ${period}।`,
    attached: (file) => `ফাইলটা সাথে দেওয়া আছে: ${file}`,
    tooLarge: 'ফাইলটা ইমেইলে দেওয়ার জন্য অনেক বড়। সাইন ইন করে আপনার এক্সপোর্ট থেকে ডাউনলোড করুন।',
    download: 'ফাইল ডাউনলোড করুন',
    manage: 'এই ইমেইল বদলান',
    why: (company, every) =>
      `এই ইমেইল আপনি পাচ্ছেন কারণ ${company} এই রিপোর্টটা ${every} আপনাকে পাঠায়।`,
    stop: (link) => `বদলাতে বা বন্ধ করতে: ${link}`,
  },
} satisfies Record<LanguageCode, Copy>;

export function scheduledReportEmail(input: ScheduledReportEmailInput): MailMessage {
  const copy: Copy = COPY[input.language];
  const intro = copy.intro(input.title, input.period);
  const body = {
    language: input.language,
    heading: input.company,
    // The line breaks stay (the frame turns them into <br>)
    intro: input.file === null ? `${intro}\n\n${copy.tooLarge}` : intro,
    button:
      input.file === null
        ? { label: copy.download, href: input.exportsUrl }
        : { label: copy.manage, href: input.schedulesUrl },
    footer: [
      ...(input.file === null ? [] : [copy.attached(input.fileName)]),
      copy.why(input.company, copy.every[input.frequency]),
      // With the file attached, the button already opens the schedules page (decision 9)
      ...(input.file === null ? [copy.stop(input.schedulesUrl)] : []),
    ],
  };
  return {
    to: input.to,
    subject: copy.subject(input.title, input.period, input.company),
    text: emailText(body),
    html: emailHtml(body),
    ...(input.file !== null && {
      attachments: [
        {
          filename: input.fileName,
          content: Buffer.from(input.file.bytes),
          contentType: input.file.contentType,
        },
      ],
    }),
  };
}
```

- **Decision 44.** No `fromName` and no `replyTo`: this is Omnivo writing to a member, like the invitation. The company's
  name is the heading and is in the subject, because a person in two workspaces must know which one sent it.
- **The words live here**, in both languages, for the reason the invitation's do: `@omnivo/i18n` is for the browser.
- **Too large: the same title and period, then why there is no file**, and the button to the Exports page. A forwarded
  email then hands nobody a big file without a sign-in.
- **One button only** (the frame has one): "Change this email" when the file is attached, "Download the file" when it is
  not, with the schedules link as a footer line then.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { reportExports, reportSchedules, tenants, users } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { scheduledReportEmail } from '../mail/scheduled-report-email.js';
import { StorageService } from '../storage/storage.service.js';
import { COPY } from './export/copy.js';
import { formatIsoDate } from './export/format.js';
import { notifyScheduleCreator } from './report-schedule-bells.js';

type Event = OutboxEvent<'report.schedule_email'>;

// Decision 7: a file up to 5 MB goes with the email. Most mail servers take 10 to 25 MB, and a
// file grows by a third when it is encoded for email, so 5 MB stays well inside every limit.
export const MAX_REPORT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// The app's pages the email links to (step 21c.6 makes the schedules page)
const SCHEDULES_PATH = '/reports/schedules';
const EXPORTS_PATH = '/reports/exports';

// Sends one person's scheduled report (step 21c), on the email queue: a slow mail server never
// holds up the files of other people. Like the document email (step 16), sending is the last
// step: a crash after the mail server took it sends it again on the retry, which is better than
// never.
@Injectable()
export class ReportScheduleEmailHandler implements EventHandler<'report.schedule_email'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly mail: MailService,
    private readonly storage: StorageService,
  ) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    // 1) What to send and to whom, in one short transaction
    const job = await this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ file: reportExports, email: users.email, language: users.language })
        .from(reportExports)
        .innerJoin(users, eq(users.id, reportExports.requestedBy))
        .where(
          and(eq(reportExports.tenantId, tenantId), eq(reportExports.id, event.payload.exportId)),
        );
      if (!row) throw new PermanentJobError('The export no longer exists');
      const { file } = row;
      // The export handler asks for this email only once the row is ready
      if (
        file.status !== 'ready' ||
        file.storageKey === null ||
        file.contentType === null ||
        file.fileName === null ||
        file.sizeBytes === null
      ) {
        throw new PermanentJobError(`Export ${file.id} is not ready`);
      }
      const [schedule] = await tx
        .select({ frequency: reportSchedules.frequency })
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, tenantId),
            eq(reportSchedules.id, event.payload.scheduleId),
          ),
        );
      // Deleted since the run: whoever deleted it wanted the emails to stop. The file stays on
      // the person's Exports page.
      if (!schedule) return null;
      const [company] = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      // The narrowed fields one by one: TypeScript keeps the null checks above only this way
      return {
        id: file.id,
        report: file.report,
        query: file.query,
        storageKey: file.storageKey,
        contentType: file.contentType,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        to: row.email,
        language: row.language ?? 'en',
        frequency: schedule.frequency,
        company: company?.name ?? '',
      };
    });
    if (!job) return;

    // 2) The file from storage when it is small enough, then the email, outside any transaction
    let attachment: { bytes: Uint8Array; contentType: string } | null = null;
    if (job.sizeBytes <= MAX_REPORT_ATTACHMENT_BYTES) {
      const bytes = await this.storage.get(job.storageKey);
      // The export handler wrote it a moment ago: gone means someone deleted it, and running
      // again cannot bring it back
      if (bytes === null) throw new PermanentJobError(`Export ${job.id} has no file`);
      attachment = { bytes, contentType: job.contentType };
    }
    const copy = COPY[job.language];
    const date = (iso: string) => formatIsoDate(iso, job.language);
    // An aging and the balance sheet show one day; the others a period (reportScheduleQuery)
    const { from, to, asOf } = job.query;
    let period: string;
    if (asOf !== undefined) period = copy.asOf(date(asOf));
    else if (from !== undefined && to !== undefined) period = copy.range(date(from), date(to));
    else throw new PermanentJobError(`Export ${job.id} has no dates`);
    await this.mail.send(
      scheduledReportEmail({
        to: job.to,
        language: job.language,
        company: job.company,
        title: copy.titles[job.report],
        period,
        frequency: job.frequency,
        fileName: job.fileName,
        file: attachment,
        schedulesUrl: `${this.config.appOrigin}${SCHEDULES_PATH}`,
        exportsUrl: `${this.config.appOrigin}${EXPORTS_PATH}`,
      }),
    );
  }

  // The mail server kept refusing it: the person who made the schedule hears (decision 32). The
  // file is still on the recipient's Exports page.
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [file] = await tx
        .select({ report: reportExports.report, format: reportExports.format })
        .from(reportExports)
        .where(
          and(eq(reportExports.tenantId, tenantId), eq(reportExports.id, event.payload.exportId)),
        );
      if (!file) return;
      await notifyScheduleCreator(tx, {
        scheduleId: event.payload.scheduleId,
        type: 'report.schedule_failed',
        params: { report: file.report, format: file.format },
        eventId: event.id,
      });
    });
  }
}
```

- **`MAX_REPORT_ATTACHMENT_BYTES` is 5 MB** (decision 7): a file grows by about a third when it is encoded for email, so
  it stays inside even a 10 MB mail server limit.
- **Read in one short transaction, sent outside it**, like the document email: a slow mail server holds no database
  connection.
- **A row that is not ready, or a file gone from storage, is a `PermanentJobError`**: the export handler asks for this
  email only after the mark, so either case means something was deleted, and trying again cannot bring it back.
- **The period from the export's own query**: one day (`asOf`) for an aging and the balance sheet, a range for the
  others, in the person's language with the export's own words (`COPY`), so the email and the file's heading say the
  same thing.
- **A schedule deleted since the run sends nothing** (decision 45).
- **`onGiveUp`** rings the creator's "failed" bell.

### The worker's wiring

```diff
@@ -11,6 +11,8 @@ import { ShiftVarianceHandler } from '../pos/shift-variance.handler.js';
 import { SoldShortHandler } from '../pos/sold-short.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
+import { ReportScheduleEmailHandler } from '../reports/report-schedule-email.handler.js';
+import { ReportScheduleRunHandler } from '../reports/report-schedule-run.handler.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
@@ -44,6 +46,8 @@ export class EventHandlers {
     documentEmail: DocumentEmailHandler,
     soldShort: SoldShortHandler,
     shiftVariance: ShiftVarianceHandler,
+    scheduleRun: ReportScheduleRunHandler,
+    scheduleEmail: ReportScheduleEmailHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -61,6 +65,8 @@ export class EventHandlers {
       'document.email_requested': documentEmail,
       'pos.sold_short': soldShort,
       'pos.shift_variance': shiftVariance,
+      'report.schedule_due': scheduleRun,
+      'report.schedule_email': scheduleEmail,
     };
   }
 
```

```diff
@@ -16,6 +16,9 @@ import { ShiftVarianceHandler } from '../pos/shift-variance.handler.js';
 import { SoldShortHandler } from '../pos/sold-short.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
+import { ReportScheduleEmailHandler } from '../reports/report-schedule-email.handler.js';
+import { ReportScheduleRunHandler } from '../reports/report-schedule-run.handler.js';
+import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
@@ -80,6 +83,11 @@ export class WorkerModule implements OnApplicationShutdown {
         ShiftVarianceHandler,
         // Step 18a: the hourly job also prunes the sync change log, on the relay's pool
         SyncLogCleanup,
+        // Step 21c: the 5-minute sweep for due report emails (both pools), one run of a schedule,
+        // and the email that carries each person's file
+        ReportScheduleSweep,
+        ReportScheduleRunHandler,
+        ReportScheduleEmailHandler,
       ],
     };
   }
```

```diff
@@ -17,6 +17,7 @@ import { runWithRequest } from '../common/request/request-context.js';
 import { runWithTenant } from '../common/tenant/tenant-context.js';
 import type { WorkerConfig } from '../config.js';
 import { CONFIG } from '../infra/tokens.js';
+import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { OutboxRelay } from './outbox-relay.js';
@@ -27,6 +28,7 @@ import {
   OUTBOX_CLEANUP,
   QUEUE_NAMES,
   Queues,
+  REPORT_SCHEDULE_SWEEP,
 } from './queues.js';
 
 // How many jobs of one queue run at the same time in one worker process. Jobs spend most of their
@@ -45,6 +47,7 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
     private readonly queues: Queues,
     private readonly relay: OutboxRelay,
     private readonly syncLog: SyncLogCleanup,
+    private readonly reportSweep: ReportScheduleSweep,
   ) {}
 
   async onApplicationBootstrap(): Promise<void> {
@@ -61,6 +64,7 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
       return worker;
     });
     await this.queues.scheduleCleanup();
+    await this.queues.scheduleReportSweep();
   }
 
   // close() stops taking new jobs and waits for the running ones, before the database closes
@@ -80,6 +84,12 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
       this.logger.log(`sync answers cleanup: ${String(answers)} old answers deleted`);
       return;
     }
+    // Step 21c: no retries of its own; a sweep that failed is the next one, 5 minutes later
+    if (job.name === REPORT_SCHEDULE_SWEEP) {
+      const handed = await this.reportSweep.run();
+      if (handed > 0) this.logger.log(`report schedules: ${String(handed)} runs handed over`);
+      return;
+    }
     // A job we cannot read will never become readable: no retries
     if (!isOutboxEventType(job.name)) throw new UnrecoverableError(`Unknown job ${job.name}`);
     const data = eventJobDataSchema.safeParse(job.data);
```

The sweep is a job of the `jobs` queue, like the cleanup, but not an outbox event, so it is handled before the event
code. It has no retries of its own: if it fails, the next one comes in 5 minutes and finds the same due rows.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts gen:openapi
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src packages/contracts/src/audit.ts packages/db/src/schema/outbox-events.ts
pnpm --filter @omnivo/api test
pnpm boundaries
```

All pass (api unit tests 141, contracts 406, no dependency violations). The schedules' and the reports' tests are the
next part (21c.4).

What was checked by hand on the 21b test's shop (every kind of document, run once against a real database, worker,
storage and Mailpit, then removed): the VAT summary agrees with the books to the paisa (output ৳705.60, input ৳364.50),
the documents of each side add up to its total, and the branch filter keeps only the Mirpur invoice and its credit note;
every stock movement row has opening + purchased − sold + transfers + adjusted = closing, with and without a warehouse,
and a value sort is refused without the permission; a schedule with a member who may not read the report is refused;
pause, resume and update move the version and the next run; a sweep "40 days later" sent one VAT email for November and
one weekly stock movement email for the last full week (not one per missed week), each with its PDF attached and the
file on the Exports page. The existing suites the changes touch (exports, outbox relay, trade reports, statements, two
tenant-leak suites) pass: 65 tests.

Still failing, as expected until their parts: `packages/i18n` and `apps/app` (21c.5).

## 21c.4 — `apps/api`: the tests

Two changed integration suites, one new one, and four unit test files:

- `reports/trade-reports.int.spec.ts`: the VAT report and the stock movement report, on the shop of the 21b tests.
- `reports/report-schedules.int.spec.ts` (new): saving and changing schedules over HTTP, then the worker's three jobs
  with a real database, Redis, MinIO and Mailpit.
- `reports/reports.tenant-leak.int.spec.ts`: one workspace's VAT, stock and schedules never in another's.
- `reports/export/document.spec.ts`: the files of the two new kinds, without a database.
- `reports/report-schedule-row.spec.ts`, `reports/report-schedule-run.handler.spec.ts` and
  `mail/scheduled-report-email.spec.ts` (new): the small pure parts, without a database.

The tests found no bug in the 21c.3 code. To be sure they can fail, four lines of 21c.3 were broken on purpose, one at
a time, and put back: without the advisory lock, 25 schedules saved at once were all kept (the test wants 20); without
the kind in the VAT query's `GROUP BY`, the export rate's two rows became one; without `onConflictDoNothing`, the second
run of the same job failed on the export's primary key; and a `catchUp()` that sends the first missed run instead of the
latest failed two unit tests.

### `reports/trade-reports.int.spec.ts`: the VAT report

```diff
@@ -51,6 +51,11 @@ import {
   settingsSchema,
   setupSchema,
   shiftIsoDate,
+  type StockMovementReport,
+  stockMovementReportSchema,
+  type StockMovementRow,
+  stockRevaluationSchema,
+  stockTransferSchema,
   type Supplier,
   supplierGroupSchema,
   supplierSchema,
@@ -58,9 +63,15 @@ import {
   type SyncCommandInput,
   syncPushSchema,
   type TaxRate,
+  taxRateSchema,
   taxRateListSchema,
   todayIn,
   unitListSchema,
+  type VatDocument,
+  type VatDocumentPage,
+  vatDocumentPageSchema,
+  type VatReport,
+  vatReportSchema,
   type Warehouse,
   warehouseListSchema,
   warehouseSchema,
```

The new schemas and types the tests read. Nothing else in the file's top changes: the shop and its documents are the
21b ones.

```ts
// ---------------------------------------------------------------------------------------------
// Step 21c. The VAT report and the stock movement report read the same shop. These tests run
// after the 21b ones, so the documents they add in their own beforeAll change no number above.

async function vatOf(query: string, as = owner): Promise<VatReport> {
  const res = await send('GET', `/reports/vat?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return vatReportSchema.parse(res.json());
}

// Every document of one side, page by page
async function vatDocumentsOf(query: string, limit = 50): Promise<VatDocument[]> {
  const items: VatDocument[] = [];
  let cursor: string | null = null;
  do {
    const res = await send(
      'GET',
      `/reports/vat/documents?${query}&limit=${String(limit)}${cursor === null ? '' : `&cursor=${cursor}`}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const page: VatDocumentPage = vatDocumentPageSchema.parse(res.json());
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

// A rate's row: its name, kind and percent, then output, input and the difference
function vatRowOf(row: VatReport['rows'][number]) {
  return [
    row.name,
    row.kind,
    row.rate,
    row.outputNet,
    row.outputVat,
    row.inputNet,
    row.inputVat,
    row.netVat,
  ];
}

function vatDocumentOf(document: VatDocument) {
  return [document.kind, document.partyName, document.net, document.vat];
}

describe('The VAT report', () => {
  it('adds up every kind of document by rate, and agrees with the books', async () => {
    const report = await vatOf(period());
    expect(report.rows.map(vatRowOf)).toEqual([
      // Out: invoices ৳4,455 less ৳271 of credit notes, the counter ৳580 less ৳60.
      // In: the sugar ৳2,500 and the van ৳300, less ৳250 and ৳120 on debit notes.
      [
        'VAT 15%',
        'standard',
        '15.00',
        '4704.0000',
        '705.6000',
        '2430.0000',
        '364.5000',
        '341.1000',
      ],
      // The rent ৳12,000, ৳1,000 of it taken off: a purchase with no VAT, still in the return
      ['Exempt', 'exempt', '0.00', '0.0000', '0.0000', '11000.0000', '0.0000', '0.0000'],
    ]);
    expect(report.rows.map((row) => row.key)).toEqual([
      `${vat.id}:standard:15.00`,
      `${exempt.id}:exempt:0.00`,
    ]);
    expect(report.totals).toEqual({
      outputNet: '4704.0000',
      outputVat: '705.6000',
      // Karim's bottle ৳25.65, Rahim's price cut ৳15 and the soap at the counter ৳9
      outputVatReturned: '49.6500',
      inputNet: '13430.0000',
      inputVat: '364.5000',
      // ৳37.50 for the sugar back with the bill, ৳18 for the kilo without one
      inputVatReturned: '55.5000',
      // The sugar bill has no Mushak 6.3 number, so all of its VAT
      inputVatWithoutMushak: '420.0000',
      netVat: '341.1000',
    });
    // The cash sale written by hand has no VAT, so the books agree to the paisa. The invoice 70
    // days ago and the draft are in neither.
    expect(report.books).toEqual({ output: '705.6000', input: '364.5000' });
  });

  it('lists the documents behind each side, oldest first, with the same signs', async () => {
    const output = await vatDocumentsOf(`${period()}&side=output`);
    expect(output.map(vatDocumentOf)).toEqual([
      ['invoice', 'Rahim Traders', '3600.0000', '540.0000'],
      ['invoice', 'Karim Store', '855.0000', '128.2500'],
      ['credit_note', 'Karim Store', '-171.0000', '-25.6500'],
      ['credit_note', 'Rahim Traders', '-100.0000', '-15.0000'],
      // The walk-in has no name; the sale before its return, on the same day
      ['pos_sale', null, '580.0000', '87.0000'],
      ['pos_return', null, '-60.0000', '-9.0000'],
    ]);
    const input = await vatDocumentsOf(`${period()}&side=input`);
    expect(input.map(vatDocumentOf)).toEqual([
      // The sugar and the van hire are one bill: one row
      ['bill', 'Meghna Agro Mills', '2800.0000', '420.0000'],
      ['debit_note', 'Meghna Agro Mills', '-250.0000', '-37.5000'],
      ['bill', 'Dhanmondi Properties Ltd.', '12000.0000', '0.0000'],
      ['debit_note', 'Dhanmondi Properties Ltd.', '-1000.0000', '0.0000'],
      ['debit_note', 'Meghna Agro Mills', '-120.0000', '-18.0000'],
    ]);
    expect(input.map((document) => document.mushakNumber)).toEqual([null, null, null, null, null]);
    // In pages of four: the same documents in the same order
    expect(await vatDocumentsOf(`${period()}&side=output`, 4)).toEqual(output);
    expect(await vatDocumentsOf(`${period()}&side=input`, 2)).toEqual(input);
  });

  it("keeps one branch's documents, and the books of that branch", async () => {
    const atMirpur = await vatOf(`${period()}&branchId=${mirpur.id}`);
    // Karim's invoice ৳855 and its credit note ৳171; the shop buys nothing there
    expect(atMirpur.rows.map(vatRowOf)).toEqual([
      ['VAT 15%', 'standard', '15.00', '684.0000', '102.6000', '0.0000', '0.0000', '102.6000'],
    ]);
    expect(atMirpur.books).toEqual({ output: '102.6000', input: '0.0000' });
    const documents = await vatDocumentsOf(`${period()}&branchId=${mirpur.id}&side=output`);
    expect(documents.map(vatDocumentOf)).toEqual([
      ['invoice', 'Karim Store', '855.0000', '128.2500'],
      ['credit_note', 'Karim Store', '-171.0000', '-25.6500'],
    ]);
  });

  it('needs the accounting reports permission, and a period the right way round', async () => {
    // Shirin reads the sales and purchase reports, not the VAT
    expect((await send('GET', `/reports/vat?${period()}`, undefined, shirin)).statusCode).toBe(403);
    expect(
      (await send('GET', `/reports/vat/documents?${period()}&side=output`, undefined, rafiq))
        .statusCode,
    ).toBe(403);
    const backwards = await send('GET', `/reports/vat?from=${today}&to=${day(-1)}`);
    expect(problemOf(backwards).fieldErrors).toEqual({ to: ['report_range_invalid'] });
    const noSide = await send('GET', `/reports/vat/documents?${period()}`);
    expect(noSide.statusCode).toBe(400);
  });
```

- **Why the same shop.** The 21b world already has every kind of document that carries VAT: two invoices, two credit
  notes (one with goods back, one a price cut), a POS sale and its return, a bill with a goods line and an account line,
  an exempt rent bill, and debit notes with and without a bill. Building a second world would repeat 600 lines for the
  same documents. The new `describe` blocks run after the 21b ones (Vitest runs a file's blocks in order), so what they
  add later changes no 21b number.
- **The numbers are the 21b numbers again.** Output net ৳4,704 is the sales report's net, input net ৳13,430 the
  purchase report's. That is the point: the three reports read the same documents, so a VAT report that disagreed with
  the sales report would show a bug in one of them. Each VAT amount is 15% of its net, written out in the comments.
- **`vatRowOf()`** turns a row into a short list, so one `toEqual` shows every column of every row, and a failure shows
  which number moved.
- **The key** is checked as a string (`id:kind:percent`): the page uses it to tell rows apart (decision 14), so its
  shape is part of the contract.
- **The returned and "no 6.3" totals** belong to no row: they are only in the totals, so they are checked there. The
  sugar bill has no Mushak 6.3 number, so all of its ৳420 VAT is in `inputVatWithoutMushak`, and the rent bill adds
  nothing (it is exempt).
- **The books agree to the paisa** because the journal entry written by hand is a cash sale without VAT. The next block
  adds one that touches the VAT account.
- **`vatDocumentsOf()` reads every page** and checks that none is longer than asked. Reading with pages of 4 and of 2
  must give the same list as one page of 50: this is what proves the cursor neither skips nor repeats a document.
- **The order on one day:** the POS sale and its return are both today. They sort by number, and `POS1-000001` comes
  before `POS1-R000001`, so the sale is first. The id is the last sort key in the query, so two documents with the same
  number on the same day would still keep their order.
- **The branch:** Karim's invoice is the Mirpur shop's, and its credit note takes the invoice's branch (decision 19).
  The books are read for the same branch, so they agree too.
- **The permission:** Shirin reads the sales and purchase reports but not the accounting ones, so the VAT report is
  403 for her (decision 11). A missing `side` is a 400 from the contract.

```ts
  describe('when the rates change', () => {
    let fivePercent: TaxRate;
    let zeroRated: TaxRate;
    let exportServices: TaxRate;

    // A service line at a rate: no stock moves, so the stock report below does not see these
    const serviceLine = (amount: string, rate: TaxRate) => ({
      ...invoiceLine(homeDelivery, '1', amount),
      taxRateId: rate.id,
    });

    async function changeRate(rate: TaxRate, change: Partial<TaxRate>): Promise<void> {
      const res = await send('PUT', `/tax-rates/${rate.id}`, {
        name: rate.name,
        kind: rate.kind,
        rate: rate.rate,
        isDefault: rate.isDefault,
        version: rate.version,
        ...change,
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    // Two days with only these documents: day -2 and day -1
    beforeAll(async () => {
      const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
      const named = (name: string) => {
        const found = rates.find((rate) => rate.name === name);
        if (!found) throw new Error(`no ${name}`);
        return found;
      };
      fivePercent = named('VAT 5%');
      zeroRated = named('Zero-rated');
      exportServices = await created(taxRateSchema, '/tax-rates', {
        name: 'Export services',
        kind: 'zero_rated',
        rate: '0',
        isDefault: false,
      });
      await created(
        invoiceSchema,
        '/invoices',
        invoiceForm(rahim, day(-2), [
          serviceLine('1000', fivePercent),
          serviceLine('300', exportServices),
        ]),
      );
      // The rate renamed, and the export rate found to be exempt after all
      await changeRate(fivePercent, { name: 'VAT 5% (reduced)' });
      await changeRate(exportServices, { kind: 'exempt' });
      await created(
        invoiceSchema,
        '/invoices',
        invoiceForm(karim, day(-1), [
          serviceLine('400', fivePercent),
          serviceLine('500', exportServices),
          serviceLine('200', zeroRated),
        ]),
      );
      // A van hire with the supplier's Mushak 6.3
      await created(billSchema, '/bills', {
        ...billForm(meghna, day(-1), 'MAM/2026/140', {
          lines: [billLine(vanHire, '1', '1000', { accountId: accountId('5240') })],
        }),
        mushakNumber: 'M63-2026-0042',
        mushakDate: day(-1),
      });
      // VAT on scrap sold for cash, written by hand: the books have it, no document does
      const vatOutput = accounts.find((account) => account.purpose === 'vat_output');
      if (!vatOutput) throw new Error('no VAT output account');
      const byHand = await send('POST', '/journal-entries', {
        date: day(-1),
        narration: 'VAT on scrap sold',
        lines: [
          {
            accountId: accountId('1110'),
            branchId: dhanmondi.id,
            description: '',
            debit: '50',
            credit: '',
          },
          {
            accountId: vatOutput.id,
            branchId: dhanmondi.id,
            description: '',
            debit: '',
            credit: '50',
          },
        ],
        post: true,
      });
      expect(byHand.statusCode, byHand.body).toBe(201);
    }, 60_000);

    it('shows a renamed rate under its new name, and a changed kind as a second row', async () => {
      const report = await vatOf(`from=${day(-2)}&to=${day(-1)}`);
      expect(report.rows.map(vatRowOf)).toEqual([
        // Standard, reduced, zero-rated, exempt (decision 15)
        ['VAT 15%', 'standard', '15.00', '0.0000', '0.0000', '1000.0000', '150.0000', '-150.0000'],
        // ৳1,000 before the new name and ৳400 after: one rate, one row, the name it has now
        [
          'VAT 5% (reduced)',
          'reduced',
          '5.00',
          '1400.0000',
          '70.0000',
          '0.0000',
          '0.0000',
          '70.0000',
        ],
        // Both 0%, both zero-rated, two rates: by name
        [
          'Export services',
          'zero_rated',
          '0.00',
          '300.0000',
          '0.0000',
          '0.0000',
          '0.0000',
          '0.0000',
        ],
        ['Zero-rated', 'zero_rated', '0.00', '200.0000', '0.0000', '0.0000', '0.0000', '0.0000'],
        // The same rate as exempt: a different line of the return
        ['Export services', 'exempt', '0.00', '500.0000', '0.0000', '0.0000', '0.0000', '0.0000'],
      ]);
      expect(new Set(report.rows.map((row) => row.key)).size).toBe(5);
      expect(
        report.rows.filter((row) => row.taxRateId === exportServices.id).map((r) => r.key),
      ).toEqual([`${exportServices.id}:zero_rated:0.00`, `${exportServices.id}:exempt:0.00`]);
      expect(report.totals).toMatchObject({
        outputNet: '2400.0000',
        outputVat: '70.0000',
        inputVat: '150.0000',
        // The van hire has its 6.3
        inputVatWithoutMushak: '0.0000',
        // More paid than charged: a negative net, carried forward
        netVat: '-80.0000',
      });
      const input = await vatDocumentsOf(`from=${day(-2)}&to=${day(-1)}&side=input`);
      expect(input.map((document) => document.mushakNumber)).toEqual(['M63-2026-0042']);
    });

    it('says how far the books are from the documents', async () => {
      const report = await vatOf(`from=${day(-2)}&to=${day(-1)}`);
      // ৳70 on the invoices and ৳50 by hand
      expect(report.books).toEqual({ output: '120.0000', input: '150.0000' });
      expect(report.totals.outputVat).toBe('70.0000');
    });
  });
});
```

- **Only day -2 and day -1.** Nothing of the 21b world is dated there except the cash sale written by hand, which has
  no VAT. So the period `day(-2)` to `day(-1)` holds only what this block adds, and its numbers are small and exact.
- **Service lines (`serviceLine()`).** A home delivery charge moves no stock, so the stock movement tests below never
  see these invoices.
- **A rate renamed between two invoices.** "VAT 5%" is used, renamed to "VAT 5% (reduced)", and used again. The report
  shows one row with the new name (the latest line's name), because it is the same rate at the same percent: one line
  of the return.
- **A rate whose kind changed.** "Export services" is made zero-rated, used, then changed to exempt and used again.
  The lines keep the kind they were charged at, so there are two rows with the same name and two keys. This is the
  test that failed when the kind was taken out of the `GROUP BY`.
- **The order (decision 15):** standard, reduced, zero-rated, exempt. The two zero-rated rows are both 0%, so their
  names decide: "Export services" before "Zero-rated".
- **A bill with its Mushak 6.3 number** adds ৳150 input VAT and nothing to `inputVatWithoutMushak`. The documents list
  shows the number, so the accountant can check it against the paper.
- **A negative net** (৳70 charged, ৳150 paid) is a plain negative string: the page writes it as "to carry forward"
  (21c.6), the API does not.
- **The books differ by ৳50:** the hand-written entry credits the VAT output account (found by its `purpose`, not its
  code, which a workspace may change). The report does not hide the difference; it shows both numbers.

### `reports/trade-reports.int.spec.ts`: the stock movement report

```ts
async function stockMovement(query: string, as = owner): Promise<StockMovementReport> {
  const res = await send('GET', `/reports/stock-movement?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return stockMovementReportSchema.parse(res.json());
}

// A row: the product, its options, then opening, purchased, sold, transfers, adjusted, closing
function movementOf(row: StockMovementRow) {
  return [
    row.productName,
    row.optionValues.join(', '),
    row.opening,
    row.purchased,
    row.sold,
    row.transfers,
    row.adjusted,
    row.closing,
  ];
}

function valueOf(row: StockMovementRow) {
  return [row.productName, row.optionValues.join(', '), row.openingValue, row.closingValue];
}

// The rule every row keeps: opening + purchased − sold + transfers + adjusted = closing. In
// paisa-free whole units here, so plain numbers are exact.
function expectBalanced(report: StockMovementReport): void {
  for (const row of report.items) {
    const worked =
      Number(row.opening) +
      Number(row.purchased) -
      Number(row.sold) +
      Number(row.transfers) +
      Number(row.adjusted);
    expect(worked, row.productName).toBe(Number(row.closing));
  }
}

describe('The stock movement report', () => {
  // Reads the stock reports, but not what the stock cost
  let kamal: SignedIn;
  const lastDays = () => `from=${day(-3)}&to=${day(-1)}`;

  // Three days before yesterday: matchboxes to Mirpur (there the next day), two rose soaps still
  // on the way, a lime soap damaged, and the sugar revalued. The counter sold more today, after
  // the period.
  beforeAll(async () => {
    kamal = await memberWith(
      { fullName: 'Kamal Hossain', email: 'kamal@shaplastore.com', password: 'Store-room-2026' },
      ['inventory.report.read'],
    );
    const transferLine = (product: Product, quantity: string, at = 0) => ({
      variantId: variantOf(product, at),
      unitId: pcs,
      quantity,
      batchId: '',
      serialNumbers: [],
    });
    const matchesOut = await created(stockTransferSchema, '/stock-transfers', {
      fromWarehouseId: main.id,
      toWarehouseId: mirpurStore.id,
      date: day(-3),
      note: '',
      lines: [transferLine(matches, '10')],
      send: true,
    });
    const arrived = await send('POST', `/stock-transfers/${matchesOut.id}/receive`, {
      version: matchesOut.version,
      date: day(-2),
      lines: [
        {
          lineId: only(matchesOut.lines, 'transfer line').id,
          receivedQuantity: '10',
          serialNumbers: [],
        },
      ],
    });
    expect(arrived.statusCode, arrived.body).toBe(200);
    await created(stockTransferSchema, '/stock-transfers', {
      fromWarehouseId: main.id,
      toWarehouseId: mirpurStore.id,
      date: day(-2),
      note: '',
      lines: [transferLine(soap, '2', 0)],
      send: true,
    });
    const damaged = await send('POST', '/stock-adjustments', {
      date: day(-2),
      warehouseId: main.id,
      direction: 'out',
      reason: 'damaged',
      note: '',
      lines: [stockLine(soap, '1', '', 1)],
      post: true,
    });
    expect(damaged.statusCode, damaged.body).toBe(201);
    // ৳120 a kilo to ৳130: the value moves, not a gram
    await created(stockRevaluationSchema, '/stock-revaluations', {
      date: day(-1),
      note: '',
      lines: [{ variantId: variantOf(sugar), unitCost: '130' }],
    });
  }, 60_000);
```

- **`expectBalanced()`** checks the rule of the report on every row: opening + purchased − sold + transfers + adjusted
  = closing. The query works out the opening and the closing in two different ways (from what is held now, minus two
  different sums), so a mistake in either one breaks this rule. The quantities here are whole numbers, so plain
  `Number` sums are exact; money is never added this way.
- **Kamal** reads the stock reports but not the stock value, the same split as Shirin and the sales report's cost.
- **Four things in three days**, each for one column: matchboxes sent to Mirpur and received the next day (out and in:
  zero for the company), rose soaps sent and never received (on the truck), a lime soap damaged (an adjustment), and
  the sugar revalued (only the value moves).
- **The dates are in the past.** A transfer, an adjustment and a revaluation can be dated back, so the period ends
  yesterday, and today's POS sale (rice, soaps and matches) is after it. That is what tests "closing = now − what moved
  after the period".

```ts
  it('works out the opening from what is held now, and puts each kind of movement in its column', async () => {
    const report = await stockMovement(`from=${day(-22)}&to=${day(-4)}`);
    expect(report.items.map(movementOf)).toEqual([
      // 10 on the challan, 2 back before the bill
      ['Miniket rice 5 kg', '', '40.0000', '0.0000', '8.0000', '0.0000', '0.0000', '32.0000'],
      // 5 on Karim's invoice, 1 back
      ['Soybean oil 1 L', '', '10.0000', '0.0000', '4.0000', '0.0000', '0.0000', '6.0000'],
      // Received and 2 sent back before the period; 1 back on its own inside it: purchased less
      ['Sugar 1 kg', '', '18.0000', '-1.0000', '0.0000', '0.0000', '0.0000', '17.0000'],
    ]);
    expectBalanced(report);
    expect(report.items.map(valueOf)).toEqual([
      ['Miniket rice 5 kg', '', '15200.0000', '12160.0000'],
      ['Soybean oil 1 L', '', '1600.0000', '960.0000'],
      ['Sugar 1 kg', '', '2160.0000', '2040.0000'],
    ]);
    expect(report.totals).toEqual({
      variants: 3,
      openingValue: '18960.0000',
      closingValue: '15160.0000',
    });
    expect(report.withValue).toBe(true);
    expect(report.items.map((row) => row.baseUnit.code)).toEqual(['pcs', 'pcs', 'pcs']);
  });

  it('counts stock on the way, an adjustment and a revaluation, but nothing after the period', async () => {
    const report = await stockMovement(lastDays());
    expect(report.items.map(movementOf)).toEqual([
      // Out of the main store and into Mirpur: nothing for the company. Today's 2 at the counter
      // are after the period.
      ['Matchbox', '', '50.0000', '0.0000', '0.0000', '0.0000', '0.0000', '50.0000'],
      // A revaluation moved only the value, and still counts as moved
      ['Sugar 1 kg', '', '17.0000', '0.0000', '0.0000', '0.0000', '0.0000', '17.0000'],
      // On the truck: out of the main store, in nowhere yet
      ['Toilet soap 100 g', 'Rose', '10.0000', '0.0000', '0.0000', '-2.0000', '0.0000', '8.0000'],
      ['Toilet soap 100 g', 'Lime', '10.0000', '0.0000', '0.0000', '0.0000', '-1.0000', '9.0000'],
    ]);
    expectBalanced(report);
    expect(report.items.map(valueOf)).toEqual([
      ['Matchbox', '', '150.0000', '150.0000'],
      ['Sugar 1 kg', '', '2040.0000', '2210.0000'],
      ['Toilet soap 100 g', 'Rose', '450.0000', '360.0000'],
      ['Toilet soap 100 g', 'Lime', '450.0000', '405.0000'],
    ]);
    // "All" adds what had stock and did not move
    const all = await stockMovement(`${lastDays()}&show=all`);
    expect(all.items.map((row) => row.productName)).toEqual([
      'Matchbox',
      'Miniket rice 5 kg',
      'Soybean oil 1 L',
      'Sugar 1 kg',
      'Toilet soap 100 g',
      'Toilet soap 100 g',
    ]);
    expectBalanced(all);
    // The services never held stock: no row even with "all"
    expect(all.items.map((row) => row.productId)).not.toContain(homeDelivery.id);
  });

  it("shows one warehouse's own stock and value", async () => {
    const atMirpur = await stockMovement(`${lastDays()}&warehouseId=${mirpurStore.id}&show=all`);
    expect(atMirpur.items.map(movementOf)).toEqual([
      ['Matchbox', '', '0.0000', '0.0000', '0.0000', '10.0000', '0.0000', '10.0000'],
      ['Soybean oil 1 L', '', '6.0000', '0.0000', '0.0000', '0.0000', '0.0000', '6.0000'],
    ]);
    // The value of one store is its own movements: 10 boxes at ৳3
    expect(atMirpur.items.map(valueOf)).toEqual([
      ['Matchbox', '', '0.0000', '30.0000'],
      ['Soybean oil 1 L', '', '960.0000', '960.0000'],
    ]);
    const atMain = await stockMovement(`${lastDays()}&warehouseId=${main.id}`);
    expect(atMain.items.map(movementOf)).toEqual([
      ['Matchbox', '', '50.0000', '0.0000', '0.0000', '-10.0000', '0.0000', '40.0000'],
      ['Sugar 1 kg', '', '17.0000', '0.0000', '0.0000', '0.0000', '0.0000', '17.0000'],
      ['Toilet soap 100 g', 'Rose', '10.0000', '0.0000', '0.0000', '-2.0000', '0.0000', '8.0000'],
      ['Toilet soap 100 g', 'Lime', '10.0000', '0.0000', '0.0000', '0.0000', '-1.0000', '9.0000'],
    ]);
    expectBalanced(atMain);
    expect(atMain.items.map(valueOf)).toEqual([
      ['Matchbox', '', '150.0000', '120.0000'],
      ['Sugar 1 kg', '', '2040.0000', '2210.0000'],
      ['Toilet soap 100 g', 'Rose', '450.0000', '360.0000'],
      ['Toilet soap 100 g', 'Lime', '450.0000', '405.0000'],
    ]);
  });

  it('filters by category, with the categories under it', async () => {
    const inGroceries = await stockMovement(
      `from=${day(-22)}&to=${day(-4)}&categoryId=${groceries}`,
    );
    // Rice is in "Rice", under Groceries
    expect(inGroceries.items.map((row) => row.productName)).toEqual([
      'Miniket rice 5 kg',
      'Soybean oil 1 L',
      'Sugar 1 kg',
    ]);
    const inRice = await stockMovement(`from=${day(-22)}&to=${day(-4)}&categoryId=${riceCategory}`);
    expect(inRice.items.map((row) => row.productName)).toEqual(['Miniket rice 5 kg']);
    expect(inRice.totals.variants).toBe(1);
    const inPersonalCare = await stockMovement(`${lastDays()}&categoryId=${personalCare}`);
    expect(inPersonalCare.items.map((row) => row.optionValues)).toEqual([['Rose'], ['Lime']]);
  });

  it('sorts by any column with the name after it, and pages with the same totals', async () => {
    const byClosing = await stockMovement(`${lastDays()}&show=all&sort=-closing`);
    expect(byClosing.items.map((row) => row.closing)).toEqual([
      '50.0000',
      '32.0000',
      '17.0000',
      '9.0000',
      '8.0000',
      '6.0000',
    ]);
    // One row with a transfer, then the zeros by name
    const byTransfers = await stockMovement(`${lastDays()}&show=all&sort=transfers`);
    expect(byTransfers.items.map((row) => [row.productName, row.transfers])).toEqual([
      ['Toilet soap 100 g', '-2.0000'],
      ['Matchbox', '0.0000'],
      ['Miniket rice 5 kg', '0.0000'],
      ['Soybean oil 1 L', '0.0000'],
      ['Sugar 1 kg', '0.0000'],
      ['Toilet soap 100 g', '0.0000'],
    ]);
    const byValue = await stockMovement(`${lastDays()}&show=all&sort=-closingValue`);
    expect(byValue.items.map((row) => row.closingValue)).toEqual([
      '12160.0000',
      '2210.0000',
      '960.0000',
      '405.0000',
      '360.0000',
      '150.0000',
    ]);

    const all = await stockMovement(`${lastDays()}&show=all&sort=-closing`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: StockMovementReport = await stockMovement(
        `${lastDays()}&show=all&sort=-closing&limit=4${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.totals).toEqual(all.totals);
      seen.push(...page.items.map((row) => row.variantId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((row) => row.variantId));
    expect(all.totals).toEqual({
      variants: 6,
      openingValue: '16210.0000',
      closingValue: '16245.0000',
    });
  });

  it('leaves the value out without the stock value permission, and never sorts by it', async () => {
    const report = await stockMovement(lastDays(), kamal);
    expect(report.withValue).toBe(false);
    expect(report.items.map(movementOf)).toEqual(
      (await stockMovement(lastDays())).items.map(movementOf),
    );
    expect(
      report.items.every((row) => row.openingValue === null && row.closingValue === null),
    ).toBe(true);
    expect(report.totals).toEqual({ variants: 4, openingValue: null, closingValue: null });
    for (const sort of ['openingValue', '-closingValue']) {
      const refused = await send(
        'GET',
        `/reports/stock-movement?${lastDays()}&sort=${sort}`,
        undefined,
        kamal,
      );
      expect(refused.statusCode).toBe(403);
      expect(problemOf(refused)).toMatchObject({
        code: 'permission_missing',
        params: { permissions: 'inventory.stock.value' },
      });
    }
    // The sales and purchase reports are not the stock reports
    expect(
      (await send('GET', `/reports/stock-movement?${lastDays()}`, undefined, shirin)).statusCode,
    ).toBe(403);
  });
});
```

- **The opening from before the period** (`day(-22)` to `day(-4)`): the stock came in 40 days ago, the sugar 30 days
  ago with 2 kg sent back 25 days ago. So rice opens at 40 and the sugar at 18, and each column has only what happened
  inside the period: the challan less the return before the bill (sold 8), Karim's bottles (sold 4), the kilo sent back
  without a receipt (purchased −1). A return is in the column of what it undoes (decision 21).
- **The values** are the moving averages of step 14: rice ৳380, oil ৳160, sugar ৳120. The sugar bill at ৳125 changed
  no stock value: the difference went to the price difference account (step 17c).
- **The last three days:** the matchboxes are in no column for the whole company (−10 and +10); the two rose soaps are
  −2 under Transfers, the stock on the truck (decision 25). The sugar row has only zeros in its quantity columns, but it
  is there, because a revaluation counts as a movement: its value goes from ৳2,040 to ৳2,210.
- **"All"** adds rice and oil, which had stock and did not move. The services never held stock, so they have no row
  even then.
- **One warehouse:** Mirpur opens with no matchboxes and gets 10; its value is the sum of its own movements (10 boxes at
  ৳3). The main store loses those 10 and the 2 on the truck. The revaluation's movement is in the main store, where the
  sugar is.
- **Sorts:** `-closing` puts the numbers in order as numbers (50 before 32 before 17 before 9: a text sort would put 9
  first). By transfers, every row but one is 0, so the name decides, then the variant's position (rose before lime).
- **Pages of 4:** the same totals on both pages, and the pages together are the whole list in the same order.
- **Without the value:** the same quantities, `null` values and totals, and a sort by a value is 403 with the
  permission it needs, as in the sales report: the order of the rows would tell the hidden value.

### `reports/report-schedules.int.spec.ts` (new): the world and its helpers

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  branchListSchema,
  memberPageSchema,
  nextReportScheduleRun,
  notificationPageSchema,
  type PermissionKey,
  problemSchema,
  reportExportPageSchema,
  type ReportSchedule,
  reportScheduleCandidateListSchema,
  reportScheduleListSchema,
  reportScheduleSchema,
  type ReportScheduleWhen,
  roleListSchema,
  roleSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
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
import { lastMailTo } from '../testing/mailpit.js';
import { joinWithoutRoles } from '../testing/workspace.js';
import { formatIsoDate } from './export/format.js';
import {
  MAX_REPORT_ATTACHMENT_BYTES,
  ReportScheduleEmailHandler,
} from './report-schedule-email.handler.js';
import { exportIdFor, ReportScheduleRunHandler } from './report-schedule-run.handler.js';
import { ReportScheduleSweep } from './report-schedule-sweep.js';

// Step 21c. Karnaphuli Pharma Distributors in Chattogram sends its reports by email. The API part
// saves, checks and changes schedules; the worker part runs them against a real database, Redis,
// MinIO and Mailpit, with the clock moved by hand: the sweep takes the moment it runs as an
// argument, so a test can say "it is now 08:01 on the day of the run" without waiting for it.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantId: string;
let branchName: string;
let branchId: string;

const TIME_ZONE = 'Asia/Dhaka';
const COMPANY = 'Karnaphuli Pharma Distributors';

interface Person {
  session: SignedIn;
  userId: string;
  email: string;
  // The role made for this person, so a test can take its permissions away
  roleId: string | null;
}

let owner: Person;
// The accountant: reads the accounting reports, manages the schedules, reads Bangla
let mitu: Person;
// The sales manager: the sales report only, and the schedules of it
let sohel: Person;
// Reads the accounting reports, may not manage schedules
let rina: Person;
// A member with no role at all
let babul: Person;
// Someone with a workspace of their own, not a member here
let strangerId: string;

const today = todayIn(TIME_ZONE);

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn = owner.session,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

// An outbox event's id as the database writes it: a UUIDv7 with this moment in its first 48 bits,
// which exportIdFor() keeps, so the files of a test's run sort with the others
function v7(): string {
  const time = Date.now().toString(16).padStart(12, '0');
  const random = randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(15, 18)}-${random.slice(19)}`;
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// A schedule of the trial balance, the report every accountant has: no documents needed
function trialBalance(
  when: ReportScheduleWhen,
  recipientIds: string[],
  extra: { format?: 'pdf' | 'xlsx'; query?: Record<string, string> } = {},
) {
  return {
    report: 'trial_balance',
    format: extra.format ?? 'pdf',
    query: { from: shiftIsoDate(today, -30), to: today, ...extra.query },
    when,
    recipientIds,
  };
}

async function schedule(body: object, as: SignedIn = owner.session): Promise<ReportSchedule> {
  const res = await send('POST', '/report-schedules', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return reportScheduleSchema.parse(res.json());
}

async function schedulesOf(as: SignedIn = owner.session): Promise<ReportSchedule[]> {
  const res = await send('GET', '/report-schedules', undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return reportScheduleListSchema.parse(res.json()).items;
}

async function current(id: string): Promise<ReportSchedule> {
  const found = (await schedulesOf()).find((item) => item.id === id);
  if (!found) throw new Error(`schedule ${id} is not listed`);
  return found;
}

async function auditOf(id: string) {
  const res = await send('GET', `/audit-logs?entityType=report_schedule&entityId=${id}`);
  expect(res.statusCode, res.body).toBe(200);
  // Newest first; the test reads them oldest first
  return auditPageSchema.parse(res.json()).items.toReversed();
}

async function bellsOf(person: Person) {
  const res = await send('GET', '/notifications', undefined, person.session);
  return notificationPageSchema
    .parse(res.json())
    .items.filter((item) => item.type.startsWith('report.schedule_'));
}

// A member with one new role of exactly these permissions; [] = no role at all
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<Person> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'karnaphuli-pharma' });
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === person.email);
  if (!found) throw new Error(`${person.email} is not a member`);
  let roleId: string | null = null;
  if (permissions.length > 0) {
    const role = roleSchema.parse(
      (await send('POST', '/roles', { name: `${person.fullName}'s role`, description: '' })).json(),
    );
    roleId = role.id;
    await setPermissions(role.id, permissions);
    const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(roles.statusCode, roles.body).toBe(200);
  }
  const session = await logIn(app, {
    workspace: 'karnaphuli-pharma',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
  return { session, userId: found.userId, email: person.email, roleId };
}

async function setPermissions(roleId: string, permissions: PermissionKey[]): Promise<void> {
  const role = roleListSchema
    .parse((await send('GET', '/roles')).json())
    .items.find((item) => item.id === roleId);
  if (!role) throw new Error(`no role ${roleId}`);
  const res = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(res.statusCode, res.body).toBe(200);
}
```

- **Four containers.** The worker writes the files to MinIO and sends the emails through Mailpit, so this suite is
  the whole way of a scheduled report: the API, the sweep, the run, the export handler, the email.
- **The people stand for the rules.** Mitu may read the accounting reports and manage schedules, and reads Bangla. Sohel
  manages schedules but reads only the sales report. Rina reads the accounting reports but may not manage schedules.
  Babul has no role. Nasrin has a workspace of her own and is not a member here.
- **`v7()`** makes an id with this moment in its first 48 bits, like the outbox event ids the sweep writes. The run
  handler's export ids keep those bits (`exportIdFor()`), so the files of a test's own run sort with the others on the
  Exports page, newest first.
- **`trialBalance()`.** The trial balance needs no documents, so the schedules can be tested on a workspace with empty
  books: the files are made, they are just short.
- **`setPermissions()`** reads the role's version first: the permission matrix refuses a stale version, like every
  other save.
- **`memberWith()`** signs each person up for a workspace of their own first, as a real person would, then joins them
  here without a role. Sohel's own workspace is used later for the limit test.

```ts
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
      storageUrl: storage.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  const ownerSession = await signUp(app, {
    companyName: COMPANY,
    workspaceSlug: 'karnaphuli-pharma',
    fullName: 'Jahid Hasan',
    email: 'jahid@karnaphulipharma.com',
    password: 'Agrabad-depot-2026',
  });
  owner = { session: ownerSession, userId: '', email: 'jahid@karnaphulipharma.com', roleId: null };
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  const members = memberPageSchema.parse((await send('GET', '/members')).json()).items;
  owner.userId = members.find((item) => item.email === owner.email)?.userId ?? '';
  const [branch] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
  if (!branch) throw new Error('sign-up made no branch');
  branchId = branch.id;
  branchName = `${branch.code} · ${branch.name}`;
  tenantId = await superuserSql(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM tenants WHERE slug = 'karnaphuli-pharma'`;
    if (!row) throw new Error('no tenant');
    return row.id;
  });

  mitu = await memberWith(
    { fullName: 'Mitu Barua', email: 'mitu@karnaphulipharma.com', password: 'Ledger-desk-2026' },
    ['accounting.report.read', 'core.report.schedule'],
  );
  const bangla = await send('PATCH', '/me/preferences', { language: 'bn' }, mitu.session);
  expect(bangla.statusCode, bangla.body).toBe(200);
  sohel = await memberWith(
    { fullName: 'Sohel Rana', email: 'sohel@karnaphulipharma.com', password: 'Sales-floor-2026' },
    ['sales.report.read', 'core.report.schedule'],
  );
  rina = await memberWith(
    { fullName: 'Rina Das', email: 'rina@karnaphulipharma.com', password: 'Books-only-2026' },
    ['accounting.report.read'],
  );
  babul = await memberWith(
    { fullName: 'Babul Mia', email: 'babul@karnaphulipharma.com', password: 'Store-keeper-2026' },
    [],
  );
  // Nasrin signs up for her own workspace and never joins this one
  const nasrin = await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@nasrintraders.com',
    password: 'Tongi-store-2026',
  });
  strangerId =
    memberPageSchema
      .parse((await send('GET', '/members', undefined, nasrin)).json())
      .items.find((item) => item.email === 'nasrin@nasrintraders.com')?.userId ?? '';
  expect(strangerId).not.toBe('');
}, 240_000);

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

- **The tenant's id** is read with the superuser connection: the tests that call the worker's handlers directly need it
  for `runWithTenant()`, as the job runner does.
- **Mitu's language** is saved with the normal route, so the email handler reads it from `users.language` as in
  production.
- **Nasrin's user id** comes from her own workspace's member list. It is a real user, just not one of this workspace's
  members: the strongest "stranger" there is.

### `reports/report-schedules.int.spec.ts`: saving and changing a schedule

```ts
describe('Scheduling a report', () => {
  const monthly: ReportScheduleWhen = { frequency: 'monthly', hour: 8, dayOfMonth: 1 };
  let vatSchedule: ReportSchedule;

  it('keeps the filters without the dates, and works out the first run', async () => {
    const before = new Date();
    vatSchedule = await schedule({
      report: 'vat_report',
      format: 'pdf',
      query: { from: shiftIsoDate(today, -30), to: today, branchId },
      when: monthly,
      recipientIds: [owner.userId, mitu.userId],
    });
    expect(vatSchedule).toMatchObject({
      version: 1,
      report: 'vat_report',
      format: 'pdf',
      when: monthly,
      // decision 29: each run works out its own dates
      filters: { branchId },
      filterNames: { branch: branchName, warehouse: null, group: null, category: null },
      recipients: [
        { userId: owner.userId, name: 'Jahid Hasan', canReceive: true },
        { userId: mitu.userId, name: 'Mitu Barua', canReceive: true },
      ],
      status: 'active',
      pausedReason: null,
      lastRunAt: null,
      createdByName: 'Jahid Hasan',
    });
    // 08:00 on the next 1st, in Dhaka: worked out from the moment it was saved
    expect(vatSchedule.nextRunAt).toBe(
      nextReportScheduleRun(monthly, TIME_ZONE, before).toISOString(),
    );
    const [created] = await auditOf(vatSchedule.id);
    expect(created).toMatchObject({
      action: 'report_schedule.created',
      actor: { fullName: 'Jahid Hasan' },
      changes: {
        report: { from: null, to: 'vat_report' },
        recipients: { from: null, to: `${owner.userId}, ${mitu.userId}` },
      },
    });
    const { timeZone } = reportScheduleListSchema.parse(
      (await send('GET', '/report-schedules')).json(),
    );
    expect(timeZone).toBe(TIME_ZONE);
  });

  it('offers only the members who may read the report', async () => {
    const namesFor = async (report: string) => {
      const res = await send('GET', `/report-schedules/recipients?report=${report}`);
      expect(res.statusCode, res.body).toBe(200);
      return reportScheduleCandidateListSchema.parse(res.json()).items.map((item) => item.name);
    };
    // By name; Babul has no role, Nasrin is not a member
    expect(await namesFor('vat_report')).toEqual(['Jahid Hasan', 'Mitu Barua', 'Rina Das']);
    expect(await namesFor('sales_report')).toEqual(['Jahid Hasan', 'Sohel Rana']);
  });

  it('refuses a member who may not read it, a stranger, the same person twice and too many', async () => {
    for (const recipientIds of [[owner.userId, babul.userId], [strangerId], [randomUUID()]]) {
      const res = await send('POST', '/report-schedules', trialBalance(monthly, recipientIds));
      expect(res.statusCode).toBe(409);
      expect(problemOf(res)).toMatchObject({
        code: 'report_schedule_recipient_invalid',
        fieldErrors: { recipientIds: ['report_schedule_recipient_invalid'] },
      });
    }
    // These the contract refuses before the database is asked
    for (const [recipientIds, code] of [
      [[mitu.userId, mitu.userId], 'report_schedule_recipient_invalid'],
      [[], 'report_schedule_recipients_needed'],
      [Array.from({ length: 11 }, () => randomUUID()), 'report_schedule_recipients_too_many'],
    ] as const) {
      const res = await send('POST', '/report-schedules', trialBalance(monthly, [...recipientIds]));
      expect(res.statusCode).toBe(400);
      expect(problemOf(res).fieldErrors).toEqual({ recipientIds: [code] });
    }
    // A whole hour only (decision 13)
    const halfPast = await send(
      'POST',
      '/report-schedules',
      trialBalance({ frequency: 'daily', hour: 8.5 }, [owner.userId]),
    );
    expect(halfPast.statusCode).toBe(400);
    // Nothing was saved
    expect((await schedulesOf()).map((item) => item.id)).toEqual([vatSchedule.id]);
  });

  it("needs the schedules permission and the report's own", async () => {
    // Rina reads the report but may not manage schedules
    expect((await send('GET', '/report-schedules', undefined, rina.session)).statusCode).toBe(403);
    // Sohel manages schedules, but may not read the VAT report
    const vat = await send(
      'POST',
      '/report-schedules',
      { ...trialBalance(monthly, [sohel.userId]), report: 'vat_report' },
      sohel.session,
    );
    expect(vat.statusCode).toBe(403);
    expect(problemOf(vat)).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'accounting.report.read' },
    });
    // His own sales report, weekly on Sunday at 09:00
    const sales = await schedule(
      {
        report: 'sales_report',
        format: 'xlsx',
        query: { from: shiftIsoDate(today, -6), to: today, groupBy: 'product', sort: 'name' },
        when: { frequency: 'weekly', hour: 9, weekday: 0 },
        recipientIds: [sohel.userId, owner.userId],
      },
      sohel.session,
    );
    expect(sales.filters).toEqual({ groupBy: 'product', sort: 'name' });
    // The list leaves out the reports he may not read; the owner sees both
    expect((await schedulesOf(sohel.session)).map((item) => item.report)).toEqual(['sales_report']);
    expect((await schedulesOf()).map((item) => item.report)).toEqual([
      'vat_report',
      'sales_report',
    ]);
    // A schedule he cannot see, he cannot change either
    const change = await send(
      'POST',
      `/report-schedules/${vatSchedule.id}/pause`,
      { version: vatSchedule.version },
      sohel.session,
    );
    expect(change.statusCode).toBe(403);
    // The order of the rows would tell the cost he may not see (as for an export)
    const byMargin = await send(
      'POST',
      '/report-schedules',
      {
        report: 'sales_report',
        format: 'pdf',
        query: { from: today, to: today, sort: '-margin' },
        when: monthly,
        recipientIds: [sohel.userId],
      },
      sohel.session,
    );
    expect(byMargin.statusCode).toBe(403);
    expect(problemOf(byMargin).params).toEqual({ permissions: 'inventory.stock.value' });
  });

  it('changes the format, the time and the people, never the filters', async () => {
    const before = new Date();
    const res = await send('PUT', `/report-schedules/${vatSchedule.id}`, {
      format: 'xlsx',
      when: { frequency: 'monthly', hour: 10, dayOfMonth: 5 },
      recipientIds: [mitu.userId, rina.userId],
      version: vatSchedule.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const changed = reportScheduleSchema.parse(res.json());
    expect(changed).toMatchObject({
      version: 2,
      format: 'xlsx',
      filters: { branchId },
      recipients: [{ name: 'Mitu Barua' }, { name: 'Rina Das' }],
    });
    expect(changed.nextRunAt).toBe(
      nextReportScheduleRun(
        { frequency: 'monthly', hour: 10, dayOfMonth: 5 },
        TIME_ZONE,
        before,
      ).toISOString(),
    );
    // Saved over by someone else meanwhile: the old version is refused
    const stale = await send('PUT', `/report-schedules/${vatSchedule.id}`, {
      format: 'pdf',
      when: monthly,
      recipientIds: [mitu.userId],
      version: vatSchedule.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
    expect((await auditOf(vatSchedule.id)).map((entry) => entry.action)).toEqual([
      'report_schedule.created',
      'report_schedule.updated',
    ]);
    vatSchedule = changed;
  });

  it('pauses with no next run, and resumes from now', async () => {
    const paused = reportScheduleSchema.parse(
      (
        await send('POST', `/report-schedules/${vatSchedule.id}/pause`, {
          version: vatSchedule.version,
        })
      ).json(),
    );
    expect(paused).toMatchObject({
      version: 3,
      status: 'paused',
      pausedReason: 'manual',
      nextRunAt: null,
    });
    // Already paused: nothing changes, not even the version
    const again = await send('POST', `/report-schedules/${vatSchedule.id}/pause`, {
      version: paused.version,
    });
    expect(reportScheduleSchema.parse(again.json()).version).toBe(3);
    const before = new Date();
    const resumed = reportScheduleSchema.parse(
      (
        await send('POST', `/report-schedules/${vatSchedule.id}/resume`, {
          version: paused.version,
        })
      ).json(),
    );
    expect(resumed).toMatchObject({ version: 4, status: 'active', pausedReason: null });
    expect(resumed.nextRunAt).toBe(
      nextReportScheduleRun(vatSchedule.when, TIME_ZONE, before).toISOString(),
    );
    vatSchedule = resumed;
  });

  it('refuses to resume while nobody on it may read the report', async () => {
    const onlyRina = await schedule(trialBalance(monthly, [rina.userId]));
    const pause = await send('POST', `/report-schedules/${onlyRina.id}/pause`, {
      version: onlyRina.version,
    });
    expect(pause.statusCode, pause.body).toBe(200);
    if (rina.roleId === null) throw new Error('Rina has no role');
    await setPermissions(rina.roleId, []);
    // The list says she would get nothing
    expect((await current(onlyRina.id)).recipients).toEqual([
      expect.objectContaining({ name: 'Rina Das', canReceive: false }),
    ]);
    const refused = await send('POST', `/report-schedules/${onlyRina.id}/resume`, {
      version: onlyRina.version + 1,
    });
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('report_schedule_no_recipients');
    await setPermissions(rina.roleId, ['accounting.report.read']);
    const resumed = await send('POST', `/report-schedules/${onlyRina.id}/resume`, {
      version: onlyRina.version + 1,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
  });

  it('keeps at most 20 in a workspace, even when they are saved at the same moment', async () => {
    // In Sohel's own workspace, where he is the owner and has none yet
    const own = await logIn(app, {
      workspace: 'sohel-store',
      email: 'sohel@karnaphulipharma.com',
      password: 'Sales-floor-2026',
      keepSignedIn: false,
    });
    const [me] = memberPageSchema.parse(
      (await send('GET', '/members', undefined, own)).json(),
    ).items;
    if (!me) throw new Error('Sohel is not in his own workspace');
    const answers = await Promise.all(
      Array.from({ length: 25 }, () =>
        send(
          'POST',
          '/report-schedules',
          trialBalance({ frequency: 'daily', hour: 7 }, [me.userId]),
          own,
        ),
      ),
    );
    const codes = answers.map((res) => res.statusCode);
    expect(codes.filter((code) => code === 201)).toHaveLength(20);
    expect(codes.filter((code) => code === 409)).toHaveLength(5);
    expect(
      answers.filter((res) => res.statusCode === 409).map((res) => problemOf(res).code),
    ).toEqual(Array.from({ length: 5 }, () => 'report_schedule_limit'));
    // Cleared again, so the worker's tests below find only this workspace's schedules
    for (const item of await schedulesOf(own)) {
      expect(
        (await send('DELETE', `/report-schedules/${item.id}`, undefined, own)).statusCode,
      ).toBe(204);
    }
    expect(await schedulesOf(own)).toEqual([]);
  });

  it('deletes a schedule for good, and the audit log keeps what it was', async () => {
    for (const item of await schedulesOf()) {
      const res = await send('DELETE', `/report-schedules/${item.id}`);
      expect(res.statusCode, res.body).toBe(204);
    }
    expect(await schedulesOf()).toEqual([]);
    const deleted = (await auditOf(vatSchedule.id)).at(-1);
    expect(deleted).toMatchObject({
      action: 'report_schedule.deleted',
      changes: { report: { from: 'vat_report', to: null }, status: { from: 'active', to: null } },
    });
    // Gone: a change to it is 404, like an id that never was
    const gone = await send('POST', `/report-schedules/${vatSchedule.id}/pause`, {
      version: vatSchedule.version,
    });
    expect(gone.statusCode).toBe(404);
  });
});
```

- **The first run** is compared with `nextReportScheduleRun()` from the contract, worked out from a moment taken just
  before the request. The function is the contract's own (tested there), so this checks that the API uses it with the
  workspace's time zone and the moment of saving.
- **The filters without the dates** (decision 29): the page sends the query with its dates; only `branchId` is kept,
  and its name, with the branch's code, is in `filterNames`.
- **The audit row** has the recipients as a plain string, because the audit log keeps plain values only.
- **The candidates** are sorted by name and leave out Babul (no role) and Nasrin (not a member). The sales report has
  a different list: the candidates depend on the report.
- **Three ways to be a wrong recipient** are all 409 `report_schedule_recipient_invalid` from the API (a member without
  the permission, a stranger, an id that is nobody), and three more are 400 from the contract before the database is
  asked (the same person twice, nobody, eleven people). Half an hour is refused too (decision 13). At the end the list
  still has only the first schedule: nothing refused was half saved.
- **Two permissions:** Rina is refused by the route (`core.report.schedule`). Sohel passes the route but not the
  report's own permission for the VAT report, and the list leaves out the VAT schedule for him. A sort by margin is
  refused for him like an export of the same query, because the file's order would tell the cost.
- **Changing a schedule** keeps the filters (decision 10): the body has none. The old version is refused with
  `version_conflict`, the same rule as every other form.
- **Pause twice:** the second pause changes nothing, not even the version. Two people pressing Pause at the same moment
  must not make one of them see an error.
- **Resume with nobody left:** Rina's role loses its permission, so the list says she cannot receive it, and Resume is
  refused with `report_schedule_no_recipients` (decision 31). With the permission back, Resume works.
- **The limit under load.** 25 saves at once in Sohel's own workspace: exactly 20 are kept. This is the test that failed
  without the advisory lock (every save counted 0 to 19 at the same moment). The schedules are deleted again, so the
  worker tests below find only this workspace's.
- **Delete** is for good (decision 34): the audit log keeps the last values, and a change to a deleted schedule is
  404, like an id that never was.

### `reports/report-schedules.int.spec.ts`: running the schedules

```ts
describe('Running the schedules', () => {
  // The daily trial balance at 08:00, to the owner and to Mitu (in Bangla)
  let daily: ReportSchedule;
  let sweep: ReportScheduleSweep;
  let runs: ReportScheduleRunHandler;
  let emails: ReportScheduleEmailHandler;

  const minute = 60_000;
  const later = (iso: string | null, ms: number) => {
    if (iso === null) throw new Error('no next run');
    return new Date(new Date(iso).getTime() + ms);
  };
  // A monthly day at least a week away: never due in the sweeps below, which look at most 4 days
  // ahead. The 28th at most, as the contract allows.
  const farDay = () => Math.min(Number(shiftIsoDate(today, 10).slice(8, 10)), 28);

  // The period of a daily run: the day before the day it runs, in Dhaka
  const dayBefore = (runAt: Date) => shiftIsoDate(todayIn(TIME_ZONE, runAt), -1);

  function dueEvent(scheduleId: string, runAt: Date): OutboxEvent<'report.schedule_due'> {
    return {
      id: v7(),
      tenantId,
      type: 'report.schedule_due',
      payload: { scheduleId, runAt: runAt.toISOString() },
      requestId: null,
    };
  }

  const run = (event: OutboxEvent<'report.schedule_due'>) =>
    runWithTenant(tenantId, () => runs.handle(event));

  async function exportsOf(person: Person) {
    const res = await send('GET', '/report-exports', undefined, person.session);
    return reportExportPageSchema.parse(res.json()).items;
  }

  // How many emails this person has had (the welcome email of their sign-up too)
  const mailboxSchema = z.object({
    messages: z.array(z.object({ To: z.array(z.object({ Address: z.string() })) })),
  });
  async function mailsTo(person: Person): Promise<number> {
    const res = await fetch(`${mail.apiUrl}/api/v1/messages`);
    const { messages } = mailboxSchema.parse(await res.json());
    return messages.filter((message) => message.To.some((to) => to.Address === person.email))
      .length;
  }

  // Waits for the newest email to this person to be the one the test expects
  function newestMail(person: Person, subject: string) {
    return eventually(async () => {
      const found = await lastMailTo(mail.apiUrl, person.email);
      expect(found.subject).toBe(subject);
      return found;
    }, 15_000);
  }

  beforeAll(async () => {
    sweep = worker.get(ReportScheduleSweep);
    runs = worker.get(ReportScheduleRunHandler);
    emails = worker.get(ReportScheduleEmailHandler);
    daily = await schedule(
      trialBalance({ frequency: 'daily', hour: 8 }, [owner.userId, mitu.userId]),
    );
  });

  it('hands nothing over before the time', async () => {
    expect(await sweep.run(later(daily.nextRunAt, -minute))).toBe(0);
    expect((await current(daily.id)).nextRunAt).toBe(daily.nextRunAt);
  });

  it('leaves a schedule to whoever holds it', async () => {
    const now = later(daily.nextRunAt, minute);
    // Someone saving the schedule right now: their transaction holds the row
    const holder = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    try {
      await holder.begin(async (sql) => {
        await sql`SELECT id FROM report_schedules WHERE id = ${daily.id} FOR UPDATE`;
        expect(await sweep.run(now)).toBe(0);
      });
    } finally {
      await holder.end();
    }
    expect((await current(daily.id)).lastRunAt).toBeNull();
  });

  it('sends each person their own file, in their own language', async () => {
    const runAt = later(daily.nextRunAt, 0);
    const now = later(daily.nextRunAt, minute);
    expect(await sweep.run(now)).toBe(1);
    const moved = await current(daily.id);
    expect(moved.lastRunAt).toBe(now.toISOString());
    // The next day at 08:00
    expect(moved.nextRunAt).toBe(nextReportScheduleRun(daily.when, TIME_ZONE, now).toISOString());

    const day = dayBefore(runAt);
    const fileName = `trial-balance-${day}-to-${day}.pdf`;
    const english = await newestMail(
      owner,
      `Trial balance, ${formatIsoDate(day, 'en')} – ${formatIsoDate(day, 'en')} · ${COMPANY}`,
    );
    expect(english.attachments).toEqual([
      expect.objectContaining({ fileName, contentType: 'application/pdf' }),
    ]);
    expect(english.text).toContain('http://localhost:5173/reports/schedules');
    expect(english.text).toContain(`${COMPANY} sends this report to you every day`);
    const bangla = await newestMail(
      mitu,
      `ট্রায়াল ব্যালান্স, ${formatIsoDate(day, 'bn')} – ${formatIsoDate(day, 'bn')} · ${COMPANY}`,
    );
    expect(bangla.text).toContain('প্রতিদিন');
    // The file is on each person's own Exports page too
    for (const person of [owner, mitu]) {
      expect((await exportsOf(person)).map((item) => [item.fileName, item.status])).toEqual([
        [fileName, 'ready'],
      ]);
    }
    daily = moved;
  });

  it('sends one email after a long stop, about the latest day it missed', async () => {
    const before = await exportsOf(owner);
    // The worker was down for three days: three runs are due, one is sent
    const latest = later(daily.nextRunAt, 3 * 24 * 60 * minute);
    const now = new Date(latest.getTime() + minute);
    expect(await sweep.run(now)).toBe(1);
    expect((await current(daily.id)).nextRunAt).toBe(
      nextReportScheduleRun(daily.when, TIME_ZONE, now).toISOString(),
    );
    const day = dayBefore(latest);
    await newestMail(
      owner,
      `Trial balance, ${formatIsoDate(day, 'en')} – ${formatIsoDate(day, 'en')} · ${COMPANY}`,
    );
    const after = await exportsOf(owner);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.fileName).toBe(`trial-balance-${day}-to-${day}.pdf`);
    daily = await current(daily.id);
  });

  it('makes each file once, however often the run job runs', async () => {
    const mailed = { owner: await mailsTo(owner), mitu: await mailsTo(mitu) };
    const event = dueEvent(daily.id, later(daily.nextRunAt, 0));
    await run(event);
    // A retry after a crash, or a second worker that got the same job
    await run(event);
    const ids = [owner.userId, mitu.userId].map((userId) => exportIdFor(event.id, userId));
    const counted = await superuserSql(
      (sql) => sql<{ files: number; events: number }[]>`
        SELECT (SELECT count(*)::int FROM report_exports WHERE id = ANY(${ids}::uuid[])) AS files,
               (SELECT count(*)::int FROM outbox_events
                 WHERE type = 'report.export_requested'
                   AND payload->>'exportId' = ANY(${ids}::text[])) AS events`,
    );
    expect(counted).toEqual([{ files: 2, events: 2 }]);
    // Each file is the person's own, and both get their email
    const owned = await superuserSql(
      (sql) => sql<{ requested_by: string }[]>`
        SELECT requested_by FROM report_exports WHERE id = ANY(${ids}::uuid[]) ORDER BY requested_by`,
    );
    expect(owned.map((row) => row.requested_by)).toEqual([owner.userId, mitu.userId].toSorted());
    // One email each, not two
    await eventually(async () => {
      expect({ owner: await mailsTo(owner), mitu: await mailsTo(mitu) }).toEqual({
        owner: mailed.owner + 1,
        mitu: mailed.mitu + 1,
      });
    }, 15_000);
  });

  it('leaves out a person who lost the permission, and tells whoever made it', async () => {
    // Mitu moves to another job: her role loses the accounting reports
    if (mitu.roleId === null) throw new Error('Mitu has no role');
    await setPermissions(mitu.roleId, ['core.report.schedule']);
    const mituBefore = (await exportsOf(mitu)).length;
    const ownerBefore = (await exportsOf(owner)).length;
    const mailed = { owner: await mailsTo(owner), mitu: await mailsTo(mitu) };
    await run(dueEvent(daily.id, later(daily.nextRunAt, 0)));
    expect(await exportsOf(owner)).toHaveLength(ownerBefore + 1);
    expect(await exportsOf(mitu)).toHaveLength(mituBefore);
    await eventually(async () => {
      expect(await mailsTo(owner)).toBe(mailed.owner + 1);
    }, 15_000);
    expect(await mailsTo(mitu)).toBe(mailed.mitu);
    expect((await bellsOf(owner)).map((bell) => [bell.type, bell.params])).toEqual([
      ['report.schedule_skipped', { report: 'trial_balance', count: 1 }],
    ]);
    expect((await current(daily.id)).recipients.map((item) => item.canReceive)).toEqual([
      true,
      false,
    ]);
  });

  it('pauses when nobody on it may read the report any more', async () => {
    // Made while Mitu could read it; the time is far away, so only this test runs it
    if (mitu.roleId === null) throw new Error('Mitu has no role');
    await setPermissions(mitu.roleId, ['accounting.report.read', 'core.report.schedule']);
    const onlyMitu = await schedule(
      trialBalance({ frequency: 'monthly', hour: 8, dayOfMonth: farDay() }, [mitu.userId]),
    );
    await setPermissions(mitu.roleId, ['core.report.schedule']);
    await run(dueEvent(onlyMitu.id, new Date()));
    expect(await current(onlyMitu.id)).toMatchObject({
      status: 'paused',
      pausedReason: 'no_recipients',
      nextRunAt: null,
      version: 2,
    });
    // The worker did it: no person in the audit log
    expect((await auditOf(onlyMitu.id)).at(-1)).toMatchObject({
      action: 'report_schedule.paused',
      actor: null,
      changes: { pausedReason: { from: null, to: 'no_recipients' } },
    });
    expect((await bellsOf(owner)).map((bell) => bell.type)).toContain('report.schedule_paused');
    // A run that comes after the pause sends nothing and changes nothing
    await run(dueEvent(onlyMitu.id, new Date()));
    expect((await current(onlyMitu.id)).version).toBe(2);
  });

  it('gives up on filters it cannot read, and tells whoever made it', async () => {
    // The profit and loss, which has a branch filter (the trial balance has none to break)
    const broken = await schedule({
      ...trialBalance({ frequency: 'monthly', hour: 9, dayOfMonth: farDay() }, [owner.userId]),
      report: 'profit_and_loss',
      query: { from: shiftIsoDate(today, -30), to: today, branchId },
    });
    // A row changed by hand: a branch id that is not an id
    await superuserSql(
      (sql) => sql`
        UPDATE report_schedules SET filters = '{"branchId": "Agrabad"}'::jsonb WHERE id = ${broken.id}`,
    );
    const event = dueEvent(broken.id, new Date());
    await expect(run(event)).rejects.toBeInstanceOf(PermanentJobError);
    // What the job runner does after the last try
    await runWithTenant(tenantId, () => runs.onGiveUp(event));
    expect((await bellsOf(owner)).map((bell) => [bell.type, bell.params])).toContainEqual([
      'report.schedule_failed',
      { report: 'profit_and_loss', format: 'pdf' },
    ]);
  });

  it('attaches a file up to 5 MB, and links to the exports page above that', async () => {
    const [newest] = await exportsOf(owner);
    if (!newest) throw new Error('the owner has no export');
    // As if the file were 1 byte over the limit: the size is all the handler looks at
    await superuserSql(
      (sql) => sql`
        UPDATE report_exports SET size_bytes = ${MAX_REPORT_ATTACHMENT_BYTES + 1}
         WHERE id = ${newest.id}`,
    );
    const before = await mailsTo(owner);
    await runWithTenant(tenantId, () =>
      emails.handle({
        id: v7(),
        tenantId,
        type: 'report.schedule_email',
        payload: { exportId: newest.id, scheduleId: daily.id },
        requestId: null,
      }),
    );
    // The handler returns once the mail server took it
    expect(await mailsTo(owner)).toBe(before + 1);
    const large = await lastMailTo(mail.apiUrl, owner.email);
    expect(large.attachments).toEqual([]);
    expect(large.text).toContain('The file is too large to attach');
    expect(large.text).toContain('http://localhost:5173/reports/exports');
    // The way to stop it is still in the email
    expect(large.text).toContain('To change or stop it: http://localhost:5173/reports/schedules');
  });

  it('sends nothing for a schedule deleted since the run, and keeps the files', async () => {
    const [newest] = await exportsOf(owner);
    if (!newest) throw new Error('the owner has no export');
    const files = (await exportsOf(owner)).length;
    expect((await send('DELETE', `/report-schedules/${daily.id}`)).statusCode).toBe(204);
    const before = await mailsTo(owner);
    await runWithTenant(tenantId, () =>
      emails.handle({
        id: v7(),
        tenantId,
        type: 'report.schedule_email',
        payload: { exportId: newest.id, scheduleId: daily.id },
        requestId: null,
      }),
    );
    expect(await mailsTo(owner)).toBe(before);
    expect(await exportsOf(owner)).toHaveLength(files);
  });
});
```

- **The clock is an argument.** `sweep.run(now)` takes the moment as an argument (21c.3), so the test says "it is a
  minute after the run" without waiting for it. `worker.get()` gives the worker's own instances of the sweep and the two
  handlers: the same objects the job runner calls.
- **`mailsTo()`** counts a person's emails in Mailpit. The newest email alone is not enough: the sign-up's welcome email
  is in the box too, and a test must know that exactly one more came, not two.
- **`farDay()`** gives the schedules made in the later tests a monthly day at least a week away, so the sweeps of the
  earlier tests (at most four days ahead) never hand them over by accident.
- **Not due:** a minute before the time, nothing is handed over and the next run stays.
- **Held by someone else:** a second connection locks the row, as a person saving it would. The sweep skips it (`SKIP
  LOCKED`) and hands nothing over; it is still due for the next sweep.
- **The run:** one email each, the English one to the owner and the Bangla one to Mitu, each with the PDF attached, the
  subject with the report's title, the day before the run and the company, and a link to the schedules page. The file
  is on each person's own Exports page.
- **After a long stop:** three days of runs are due; the sweep sends one, about the day before the latest due run, and
  moves the next run to after now (decision 9).
- **The same job twice** (a retry after a crash): two files and two events, one per person, and one email each. This
  failed on the primary key without `onConflictDoNothing`.
- **Someone lost the permission:** the owner gets the file, Mitu does not, and the creator's bell says one person was
  left out (decision 12). The list shows her `canReceive: false`.
- **Nobody left:** the schedule pauses itself with `no_recipients`, the audit row has no actor (the worker did it), and
  the bell rings. A run that comes after the pause changes nothing.
- **Broken filters:** a row changed by hand to a branch id that is not an id. The run throws `PermanentJobError` (so the
  job runner skips the retries), and `onGiveUp()` rings the creator's "failed" bell. The profit and loss is used here
  because the trial balance has no branch filter: an unknown field is simply dropped by the schema, which is not
  broken.
- **Over 5 MB:** the file's size is set one byte over the limit in the database. The handler looks only at the size,
  so the email has no attachment, says the file is too large, links to the Exports page, and still says how to stop
  it.
- **Deleted since the run:** the email handler sends nothing, and the files stay on the person's Exports page (decision
  45).

### `reports/reports.tenant-leak.int.spec.ts`: VAT, stock and schedules

```diff
@@ -11,20 +11,29 @@ import {
   fiscalYearListSchema,
   fiscalYearOf,
   invoiceSchema,
+  memberPageSchema,
   productCategoryListSchema,
   productSchema,
   profitAndLossSchema,
   purchaseReportSchema,
   reportExportPageSchema,
+  type ReportSchedule,
+  reportScheduleCandidateListSchema,
+  reportScheduleListSchema,
+  reportScheduleSchema,
   salesReportSchema,
   setupSchema,
   shiftIsoDate,
+  stockMovementReportSchema,
   supplierGroupSchema,
   supplierSchema,
   taxRateListSchema,
   todayIn,
   trialBalanceSchema,
   unitListSchema,
+  vatDocumentPageSchema,
+  vatReportSchema,
+  warehouseListSchema,
 } from '@omnivo/contracts';
 import postgres from 'postgres';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
@@ -431,3 +440,196 @@ describe('trade reports and agings over HTTP', () => {
     expect(ownPayables.ledger).toBe('42000.0000');
   });
 });
+
+// Step 21c: the VAT report reads B's documents' lines, the stock movement report B's movements and
+// balances, and the schedules are rows the worker reads across every workspace.
+describe('VAT, stock movement and report schedules over HTTP', () => {
+  let warehouseOfB: string;
+  let categoryOfB: string;
+  let ownerOfB: string;
+  let scheduleOfB: ReportSchedule;
+  const period = `from=${shiftIsoDate(today, -30)}&to=${today}`;
+
+  async function read<T>(who: SignedIn, schema: z.ZodType<T>, url: string): Promise<T> {
+    const res = await as(who, 'GET', url);
+    expect(res.statusCode, res.body).toBe(200);
+    return schema.parse(res.json());
+  }
+
+  async function created<T>(who: SignedIn, schema: z.ZodType<T>, url: string, body: object) {
+    const res = await as(who, 'POST', url, body);
+    expect(res.statusCode, res.body).toBe(201);
+    return schema.parse(res.json());
+  }
+
+  // B's stock: 5 insulin cool boxes in its main store, and a daily trial balance by email
+  beforeAll(async () => {
+    const pcs = unitListSchema
+      .parse((await as(tenantB, 'GET', '/units')).json())
+      .items.find((unit) => unit.code === 'pcs');
+    const [category] = productCategoryListSchema.parse(
+      (await as(tenantB, 'GET', '/product-categories')).json(),
+    ).items;
+    const [warehouse] = warehouseListSchema.parse(
+      (await as(tenantB, 'GET', '/warehouses')).json(),
+    ).items;
+    const [owner] = memberPageSchema.parse((await as(tenantB, 'GET', '/members')).json()).items;
+    if (!pcs || !category || !warehouse || !owner) throw new Error("B's setup is incomplete");
+    categoryOfB = category.id;
+    warehouseOfB = warehouse.id;
+    ownerOfB = owner.userId;
+    const coolBox = await created(tenantB, productSchema, '/products', {
+      code: '',
+      name: 'Insulin cool box',
+      type: 'goods',
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
+      customFields: { generic_name: 'Cool box' },
+    });
+    const stocked = await as(tenantB, 'POST', '/stock-adjustments', {
+      date: today,
+      warehouseId: warehouseOfB,
+      direction: 'in',
+      reason: 'opening',
+      note: '',
+      lines: [
+        {
+          variantId: coolBox.variants[0]?.id ?? '',
+          unitId: pcs.id,
+          quantity: '5',
+          batchId: '',
+          lotNumber: '',
+          expiresOn: '',
+          manufacturedOn: '',
+          serialNumbers: [],
+          unitCost: '1200',
+        },
+      ],
+      post: true,
+    });
+    expect(stocked.statusCode, stocked.body).toBe(201);
+    scheduleOfB = await created(tenantB, reportScheduleSchema, '/report-schedules', {
+      report: 'trial_balance',
+      format: 'pdf',
+      query: { from: today, to: today },
+      when: { frequency: 'daily', hour: 8 },
+      recipientIds: [ownerOfB],
+    });
+  }, 60_000);
+
+  it("adds none of B's VAT or stock into A's reports, whatever ids A's query names", async () => {
+    for (const filter of ['', `&branchId=${branchOfB}`]) {
+      const vat = await read(tenantA, vatReportSchema, `/reports/vat?${period}${filter}`);
+      expect(vat.rows, filter).toEqual([]);
+      expect(vat.totals.outputNet).toBe('0.0000');
+      expect(vat.totals.inputNet).toBe('0.0000');
+      // A's journal has sales, but no VAT
+      expect(vat.books).toEqual({ output: '0.0000', input: '0.0000' });
+      for (const side of ['output', 'input']) {
+        const documents = await read(
+          tenantA,
+          vatDocumentPageSchema,
+          `/reports/vat/documents?${period}${filter}&side=${side}`,
+        );
+        expect(documents.items, `${side}${filter}`).toEqual([]);
+      }
+    }
+    for (const filter of ['', `&warehouseId=${warehouseOfB}`, `&categoryId=${categoryOfB}`]) {
+      const stock = await read(
+        tenantA,
+        stockMovementReportSchema,
+        `/reports/stock-movement?${period}&show=all${filter}`,
+      );
+      expect(stock.items, filter).toEqual([]);
+      expect(stock.totals).toEqual({ variants: 0, openingValue: '0.0000', closingValue: '0.0000' });
+    }
+    // B sees its own, so the documents and the stock were really there
+    const ownVat = await read(tenantB, vatReportSchema, `/reports/vat?${period}`);
+    expect(ownVat.totals).toMatchObject({ outputNet: '75000.0000', inputNet: '42000.0000' });
+    const ownStock = await read(
+      tenantB,
+      stockMovementReportSchema,
+      `/reports/stock-movement?${period}`,
+    );
+    expect(ownStock.items.map((row) => [row.productName, row.closing, row.closingValue])).toEqual([
+      ['Insulin cool box', '5.0000', '6000.0000'],
+    ]);
+  });
+
+  it("never lists, changes or sends B's schedules, nor to B's people", async () => {
+    expect((await read(tenantA, reportScheduleListSchema, '/report-schedules')).items).toEqual([]);
+    for (const [method, url, body] of [
+      [
+        'PUT',
+        `/report-schedules/${scheduleOfB.id}`,
+        {
+          format: 'xlsx',
+          when: { frequency: 'daily', hour: 9 },
+          recipientIds: [ownerOfB],
+          version: scheduleOfB.version,
+        },
+      ],
+      ['POST', `/report-schedules/${scheduleOfB.id}/pause`, { version: scheduleOfB.version }],
+      ['POST', `/report-schedules/${scheduleOfB.id}/resume`, { version: scheduleOfB.version }],
+      ['DELETE', `/report-schedules/${scheduleOfB.id}`, undefined],
+    ] as const) {
+      const res = await app.inject({
+        method,
+        url,
+        headers: bearer(tenantA.accessToken),
+        ...(body && { payload: body }),
+      });
+      expect(res.statusCode, `${method} ${url}`).toBe(404);
+    }
+    // B's owner is not someone A may send to, and is not offered
+    const candidates = await read(
+      tenantA,
+      reportScheduleCandidateListSchema,
+      '/report-schedules/recipients?report=trial_balance',
+    );
+    expect(candidates.items.map((item) => item.userId)).not.toContain(ownerOfB);
+    const toB = await as(tenantA, 'POST', '/report-schedules', {
+      report: 'trial_balance',
+      format: 'pdf',
+      query: { from: today, to: today },
+      when: { frequency: 'daily', hour: 8 },
+      recipientIds: [ownerOfB],
+    });
+    expect(toB.statusCode).toBe(409);
+    // Still there, unchanged, for B
+    const own = await read(tenantB, reportScheduleListSchema, '/report-schedules');
+    expect(own.items.map((item) => [item.id, item.version, item.status])).toEqual([
+      [scheduleOfB.id, 1, 'active'],
+    ]);
+  });
+
+  it('lets the worker role read only which schedules are due, in every workspace', async () => {
+    // The sweep's connection (decision 37): no tenant is set, and it needs none for these columns
+    const sql = postgres(pg.workerUrl, { max: 1, onnotice: () => undefined });
+    try {
+      const due = await sql<{ id: string }[]>`
+        SELECT id, tenant_id, next_run_at FROM report_schedules WHERE id = ${scheduleOfB.id}`;
+      expect(due.map((row) => row.id)).toEqual([scheduleOfB.id]);
+      // Never what a schedule sends, or to whom
+      await expect(sql`SELECT filters FROM report_schedules`).rejects.toMatchObject({
+        code: '42501',
+      });
+      await expect(sql`SELECT user_id FROM report_schedule_recipients`).rejects.toMatchObject({
+        code: '42501',
+      });
+    } finally {
+      await sql.end();
+    }
+  });
+});
```

- **B's stock** is 5 insulin cool boxes in its main store. The pharma template asks for the generic name, so the
  product has it.
- **A's reports are empty whatever B's ids its query names:** B's branch in the VAT report, B's warehouse and category in
  the stock report. A missing tenant filter in the documents' lines or in `stock_balances` would show here. A's own
  journal has sales but no VAT, so A's books line is zero too.
- **B's schedule is 404 to A** for every route that names it, the same answer as an unknown id. B's owner is not
  offered to A and cannot be picked by A. B's schedule is still there, unchanged.
- **The worker's role** (`omnivo_worker`, the sweep's connection) can read `id`, `tenant_id` and `next_run_at` of every
  workspace's schedules, with no tenant set, and gets `42501` (permission denied) for the filters and for the
  recipients (decision 37). This is the grant of migration 0062, checked with the real role.

### `reports/export/document.spec.ts`: the files of the two new kinds

```diff
@@ -7,7 +7,10 @@ import {
   type ReportSection,
   type SalesReport,
   type SalesReportRow,
+  type StockMovementReport,
+  type StockMovementRow,
   type TrialBalance,
+  type VatReport,
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
@@ -21,6 +24,7 @@ const context: DocumentContext = {
   branchName: null,
   groupName: null,
   categoryName: null,
+  warehouseName: null,
   madeAt: new Date('2026-10-01T08:05:00Z'),
 };
 
@@ -421,3 +425,227 @@ describe('the document of an aging', () => {
     expect(fileStem(report)).toBe('payables-aging-2026-11-05');
   });
 });
+
+describe('the document of a VAT report', () => {
+  const rate = (name: string, kind: 'standard' | 'exempt', percent: string) => ({
+    key: `${id(1)}:${kind}:${percent}`,
+    taxRateId: id(1),
+    name,
+    kind,
+    rate: percent,
+  });
+  const data: VatReport = {
+    rows: [
+      {
+        ...rate('VAT 15%', 'standard', '15.00'),
+        outputNet: '4704.0000',
+        outputVat: '705.6000',
+        inputNet: '2430.0000',
+        inputVat: '364.5000',
+        netVat: '341.1000',
+      },
+      {
+        ...rate('Exempt', 'exempt', '0.00'),
+        outputNet: '0.0000',
+        outputVat: '0.0000',
+        inputNet: '11000.0000',
+        inputVat: '0.0000',
+        netVat: '0.0000',
+      },
+    ],
+    totals: {
+      outputNet: '4704.0000',
+      outputVat: '705.6000',
+      outputVatReturned: '49.6500',
+      inputNet: '13430.0000',
+      inputVat: '364.5000',
+      inputVatReturned: '55.5000',
+      inputVatWithoutMushak: '420.0000',
+      netVat: '341.1000',
+    },
+    books: { output: '705.6000', input: '364.5000' },
+  };
+  const query = { from: '2026-10-01', to: '2026-10-31' };
+
+  it("has a row per rate with the rate's name and percent, the total, and the books", () => {
+    const doc = buildDocument(
+      { report: 'vat_report', query, data },
+      { ...context, branchName: 'Agrabad depot' },
+    );
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'VAT rate',
+      'Sales before VAT',
+      'Output VAT',
+      'Purchases before VAT',
+      'Input VAT',
+      'Net VAT',
+    ]);
+    expect(doc.rows.map((row) => row.cells.map(read))).toEqual([
+      ['VAT 15% · 15%', '4704.0000', '705.6000', '2430.0000', '364.5000', '341.1000'],
+      ['Exempt · 0%', '0.0000', '0.0000', '11000.0000', '0.0000', '0.0000'],
+      ['Total', '4704.0000', '705.6000', '13430.0000', '364.5000', '341.1000'],
+    ]);
+    expect(doc.rows.at(-1)?.style).toBe('grand');
+    expect(doc.lines).toEqual([
+      '1 Oct 2026 – 31 Oct 2026',
+      'Branch: Agrabad depot',
+      'In the books: output VAT 705.60, input VAT 364.50',
+      'Taken off: 49.65 output VAT (credit notes and POS returns), 55.50 input VAT (debit notes)',
+      'Input VAT on bills with no Mushak 6.3: 420.00',
+      'Amounts in BDT',
+      'Made on 1 Oct 2026, 14:05',
+    ]);
+    expect(fileStem({ report: 'vat_report', query, data })).toBe('vat-2026-10-01-to-2026-10-31');
+  });
+
+  it('leaves out the lines of zeros, and writes Bangla digits in Bangla', () => {
+    const quiet: VatReport = {
+      ...data,
+      totals: {
+        ...data.totals,
+        outputVatReturned: '0.0000',
+        inputVatReturned: '0.0000',
+        inputVatWithoutMushak: '0.0000',
+      },
+    };
+    const doc = buildDocument(
+      { report: 'vat_report', query, data: quiet },
+      { ...context, language: 'bn' },
+    );
+    // The dates, the books, then the currency and the time: no "taken off", no "no 6.3"
+    expect(doc.lines).toHaveLength(4);
+    expect(doc.lines[1]).toBe('হিসাবের খাতায়: আউটপুট VAT ৭০৫.৬০, ইনপুট VAT ৩৬৪.৫০');
+    // The rate's own name stays as the workspace wrote it; the percent is in Bangla digits
+    expect(doc.rows[0]?.cells.map(read)[0]).toBe('VAT 15% · ১৫%');
+  });
+});
+
+describe('the document of a stock movement report', () => {
+  const row = (
+    n: number,
+    name: string,
+    unit: { code: string; decimals: number },
+    numbers: [string, string, string, string, string, string],
+    options: string[] = [],
+  ): StockMovementRow => ({
+    variantId: id(n),
+    productId: id(100 + n),
+    productCode: `P-${String(n)}`,
+    productName: name,
+    optionValues: options,
+    sku: `SKU-${String(n)}`,
+    baseUnitId: id(200 + n),
+    baseUnit: unit,
+    opening: numbers[0],
+    purchased: numbers[1],
+    sold: numbers[2],
+    transfers: numbers[3],
+    adjusted: numbers[4],
+    closing: numbers[5],
+    openingValue: '1500.0000',
+    closingValue: '1250.0000',
+  });
+  const data: StockMovementReport = {
+    items: [
+      row(
+        1,
+        'Napa 500mg',
+        { code: 'pcs', decimals: 0 },
+        ['1200.0000', '500.0000', '440.0000', '-10.0000', '0.0000', '1250.0000'],
+        ['Strip'],
+      ),
+      row(2, 'Gauze roll', { code: 'm', decimals: 2 }, [
+        '12.5000',
+        '0.0000',
+        '2.7400',
+        '0.0000',
+        '-0.5000',
+        '9.2600',
+      ]),
+    ],
+    nextCursor: null,
+    withValue: true,
+    totals: { variants: 2, openingValue: '3000.0000', closingValue: '2500.0000' },
+  };
+  const query = {
+    from: '2026-10-01',
+    to: '2026-10-31',
+    show: 'all',
+    sort: 'name',
+  } as const;
+
+  it('writes each quantity with its own unit, and adds up only the values', () => {
+    const doc = buildDocument(
+      { report: 'stock_movement', query, data },
+      { ...context, warehouseName: 'Agrabad depot', categoryName: 'Medicines' },
+    );
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns).toHaveLength(10);
+    expect(doc.rows.map((item) => item.cells.map(read))).toEqual([
+      [
+        'Napa 500mg (Strip)',
+        'SKU-1',
+        '1,200 pcs',
+        '500 pcs',
+        '440 pcs',
+        '-10 pcs',
+        '0 pcs',
+        '1,250 pcs',
+        '1500.0000',
+        '1250.0000',
+      ],
+      [
+        'Gauze roll',
+        'SKU-2',
+        '12.50 m',
+        '0.00 m',
+        '2.74 m',
+        '0.00 m',
+        '-0.50 m',
+        '9.26 m',
+        '1500.0000',
+        '1250.0000',
+      ],
+      // Pieces and metres never add up: the total row has the values only
+      ['Total', '', '', '', '', '', '', '', '3000.0000', '2500.0000'],
+    ]);
+    expect(doc.lines.slice(0, 4)).toEqual([
+      '1 Oct 2026 – 31 Oct 2026',
+      'Warehouse: Agrabad depot',
+      'Category: Medicines',
+      'Also the products that did not move',
+    ]);
+    expect(fileStem({ report: 'stock_movement', query, data })).toBe(
+      'stock-movement-2026-10-01-to-2026-10-31',
+    );
+  });
+
+  it('has no value columns and no total row for someone who may not see the value', () => {
+    const doc = buildDocument(
+      {
+        report: 'stock_movement',
+        query: { ...query, show: 'moved' },
+        data: {
+          ...data,
+          withValue: false,
+          items: data.items.map((item) => ({ ...item, openingValue: null, closingValue: null })),
+          totals: { variants: 2, openingValue: null, closingValue: null },
+        },
+      },
+      context,
+    );
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Product',
+      'SKU',
+      'Opening',
+      'Purchased',
+      'Sold',
+      'Transfers',
+      'Adjusted',
+      'Closing',
+    ]);
+    expect(doc.rows).toHaveLength(2);
+    expect(doc.lines[1]).toBe('Amounts in BDT');
+  });
+});
```

- **No database, no worker:** `buildDocument()` takes the report's data, so each case is a few rows typed in.
- **A VAT report** has a row per rate written as the app shows a rate ("VAT 15% · 15%"), a grand total row, and the
  lines above the table: the period, the branch, the books, what was taken off and the VAT without a 6.3.
- **A month with no returns and every 6.3** has no lines of zeros. In Bangla the percent and the amounts are in Bangla
  digits; the rate's own name stays as the workspace wrote it.
- **A stock movement report** writes each quantity with its own unit's decimals ("1,250 pcs", "9.26 m"), and its total
  row has the values only: pieces and metres never add up (decision 23).
- **Without the value** there are eight columns and no total row.

### The small parts: `report-schedule-row.spec.ts`, `report-schedule-run.handler.spec.ts`, `scheduled-report-email.spec.ts`

```ts
import type { ReportScheduleWhen } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { catchUp, whenColumnsOf, whenOf } from './report-schedule-row.js';

// Dhaka is UTC+6 all year: 08:00 there is 02:00 UTC
const TIME_ZONE = 'Asia/Dhaka';

describe('a schedule time in the database', () => {
  it('keeps the day of its own frequency only, and reads back the same', () => {
    const times: ReportScheduleWhen[] = [
      { frequency: 'daily', hour: 8 },
      { frequency: 'weekly', hour: 9, weekday: 0 },
      { frequency: 'monthly', hour: 7, dayOfMonth: 28 },
    ];
    expect(times.map(whenColumnsOf)).toEqual([
      { frequency: 'daily', hour: 8, weekday: null, dayOfMonth: null },
      { frequency: 'weekly', hour: 9, weekday: 0, dayOfMonth: null },
      { frequency: 'monthly', hour: 7, weekday: null, dayOfMonth: 28 },
    ]);
    // Sunday is 0: a falsy day must not be lost on the way back
    expect(times.map((when) => whenOf(whenColumnsOf(when)))).toEqual(times);
  });

  it('refuses a row whose day is missing, rather than guess one', () => {
    expect(() => whenOf({ frequency: 'weekly', hour: 9, weekday: null, dayOfMonth: 5 })).toThrow(
      'no weekday',
    );
    expect(() => whenOf({ frequency: 'monthly', hour: 9, weekday: 1, dayOfMonth: null })).toThrow(
      'no day',
    );
  });
});

describe('catching up with the runs that are due', () => {
  const daily: ReportScheduleWhen = { frequency: 'daily', hour: 8 };

  it('sends the run that is due and moves on to the next one', () => {
    const due = new Date('2026-11-10T02:00:00Z');
    expect(catchUp(daily, TIME_ZONE, due, new Date('2026-11-10T02:04:00Z'))).toEqual({
      runAt: due,
      nextRunAt: new Date('2026-11-11T02:00:00Z'),
    });
  });

  it('sends only the latest of the runs a stopped worker missed', () => {
    // Down from Tuesday morning to Friday 08:01: four runs due, one sent, about Thursday
    expect(
      catchUp(daily, TIME_ZONE, new Date('2026-11-10T02:00:00Z'), new Date('2026-11-13T02:01:00Z')),
    ).toEqual({
      runAt: new Date('2026-11-13T02:00:00Z'),
      nextRunAt: new Date('2026-11-14T02:00:00Z'),
    });
    // Just before Friday's run: Thursday's is the latest, Friday's is next
    expect(
      catchUp(daily, TIME_ZONE, new Date('2026-11-10T02:00:00Z'), new Date('2026-11-13T01:59:00Z')),
    ).toEqual({
      runAt: new Date('2026-11-12T02:00:00Z'),
      nextRunAt: new Date('2026-11-13T02:00:00Z'),
    });
  });

  it('counts weeks for a weekly schedule', () => {
    const sunday: ReportScheduleWhen = { frequency: 'weekly', hour: 9, weekday: 0 };
    // Three Sundays missed: 8, 15 and 22 November; the 29th is the latest
    expect(
      catchUp(
        sunday,
        TIME_ZONE,
        new Date('2026-11-08T03:00:00Z'),
        new Date('2026-11-29T03:30:00Z'),
      ),
    ).toEqual({
      runAt: new Date('2026-11-29T03:00:00Z'),
      nextRunAt: new Date('2026-12-06T03:00:00Z'),
    });
  });
});
```

- **Sunday is 0.** `whenOf(whenColumnsOf(when))` must give back the same time; a check like `if (row.weekday)` would
  lose Sunday, which is why the round trip includes it.
- **`catchUp()`** in Dhaka, which is UTC+6 all year, so 08:00 there is 02:00 UTC and the expected moments are easy to
  read. One minute before Friday's run, Thursday's is the latest due and Friday's is next: the edge between "due" and
  "next".

```ts
import { describe, expect, it } from 'vitest';

import { exportIdFor } from './report-schedule-run.handler.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// An outbox event's id, as the sweep's emit() writes it: a UUIDv7 of 10 Nov 2026
const eventId = '019a6ccf-3a80-7c2e-9b41-5d2f0e8a7c13';
const mitu = '019a1b2c-0000-7000-8000-000000000001';
const jahid = '019a1b2c-0000-7000-8000-000000000002';

describe("the id of one person's file of one run", () => {
  it('is the same every time, so a second run of the job inserts nothing', () => {
    expect(exportIdFor(eventId, mitu)).toBe(exportIdFor(eventId, mitu));
  });

  it('differs per person and per run', () => {
    const ids = new Set([
      exportIdFor(eventId, mitu),
      exportIdFor(eventId, jahid),
      exportIdFor('019a6ccf-3a80-7c2e-9b41-5d2f0e8a7c14', mitu),
    ]);
    expect(ids.size).toBe(3);
  });

  it("is a UUIDv7 with the event's time, so the Exports page sorts it with the others", () => {
    for (const userId of [mitu, jahid]) {
      const id = exportIdFor(eventId, userId);
      expect(id).toMatch(UUID_V7);
      // The first 48 bits are the time
      expect(id.slice(0, 13)).toBe(eventId.slice(0, 13));
    }
    // A later event's files sort after an earlier one's
    const later = '019a6cd0-0000-7000-8000-000000000000';
    expect(exportIdFor(later, mitu) > exportIdFor(eventId, jahid)).toBe(true);
  });
});
```

- **The same input gives the same id**, which is the whole point: a second run of the job finds the first run's rows.
- **The first 48 bits are the event's time**, so the id is a real UUIDv7 that sorts by time, and a later event's file
  sorts after an earlier one's.

```ts
import { describe, expect, it } from 'vitest';

import { scheduledReportEmail } from './scheduled-report-email.js';

const input = {
  to: 'mitu@karnaphulipharma.com',
  language: 'en',
  company: 'Karnaphuli Pharma Distributors',
  title: 'VAT report',
  period: '1 Oct 2026 – 31 Oct 2026',
  frequency: 'monthly',
  fileName: 'vat-2026-10-01-to-2026-10-31.pdf',
  file: { bytes: new TextEncoder().encode('%PDF-1.3'), contentType: 'application/pdf' },
  schedulesUrl: 'https://app.omnivo.app/reports/schedules',
  exportsUrl: 'https://app.omnivo.app/reports/exports',
} as const;

describe('scheduledReportEmail', () => {
  it('attaches the file, and its button opens the schedules page', () => {
    const mail = scheduledReportEmail(input);
    expect(mail).toMatchObject({
      to: 'mitu@karnaphulipharma.com',
      subject: 'VAT report, 1 Oct 2026 – 31 Oct 2026 · Karnaphuli Pharma Distributors',
    });
    expect(mail.attachments).toEqual([
      {
        filename: 'vat-2026-10-01-to-2026-10-31.pdf',
        content: Buffer.from('%PDF-1.3'),
        contentType: 'application/pdf',
      },
    ]);
    // Our own email (no "via"): the person is a member, not a customer
    expect(mail).not.toHaveProperty('fromName');
    expect(mail.text).toBe(
      'VAT report for 1 Oct 2026 – 31 Oct 2026.\n\n' +
        'Change this email: https://app.omnivo.app/reports/schedules\n\n' +
        'The file is attached: vat-2026-10-01-to-2026-10-31.pdf\n' +
        'You get this email because Karnaphuli Pharma Distributors sends this report to you every month.\n',
    );
    expect(mail.html).toContain('href="https://app.omnivo.app/reports/schedules"');
  });

  it('links to the exports page when the file is too large, and still says how to stop it', () => {
    const mail = scheduledReportEmail({ ...input, file: null });
    expect(mail).not.toHaveProperty('attachments');
    expect(mail.text).toBe(
      'VAT report for 1 Oct 2026 – 31 Oct 2026.\n\n' +
        'The file is too large to attach. Sign in to download it from your exports.\n\n' +
        'Download the file: https://app.omnivo.app/reports/exports\n\n' +
        'You get this email because Karnaphuli Pharma Distributors sends this report to you every month.\n' +
        'To change or stop it: https://app.omnivo.app/reports/schedules\n',
    );
  });

  it("speaks the person's language, with the frequency in words", () => {
    const mail = scheduledReportEmail({
      ...input,
      language: 'bn',
      title: 'VAT রিপোর্ট',
      period: '১ অক্টো, ২০২৬ – ৩১ অক্টো, ২০২৬',
      frequency: 'weekly',
    });
    expect(mail.subject).toBe(
      'VAT রিপোর্ট, ১ অক্টো, ২০২৬ – ৩১ অক্টো, ২০২৬ · Karnaphuli Pharma Distributors',
    );
    expect(mail.text).toContain('এই ইমেইল বদলান: https://app.omnivo.app/reports/schedules');
    expect(mail.text).toContain('প্রতি সপ্তাহে আপনাকে পাঠায়');
    expect(mail.html).toContain('lang="bn"');
  });
});
```

- **The whole text is written out** for the two English cases, so a change of a word or of the order is a visible
  change in a test, as for the document email of step 16.
- **No `fromName`:** it is Omnivo's own email to a member, not the company's email to a customer.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src/reports apps/api/src/mail
pnpm exec prettier --check apps/api/src/reports apps/api/src/mail
pnpm --filter @omnivo/api test
cd apps/api && npx vitest run src/reports/ src/worker/ --maxWorkers=3
```

All pass: api unit tests 156 (15 new), and the reports and worker integration suites 135 (trade reports 29, schedules
19, reports tenant leak 8, with the existing exports, statements, aging and outbox suites). The full integration and
tenant-leak runs are in 21c.8.

## 21c.5 — `packages/i18n`: the words

The pages of 21c.6 need their words in English and Bangla, so they come first. This part changes the two locale files,
and three files of the API: the Bangla words of the exported files and their two tests (decision 51). The ui package
needs nothing new.

When this part starts, the i18n package does not type-check: 21c.1 added five error codes, and `errors` must have a
word for every code. When this part ends, the i18n package, the ui package and the API type-check. The app still fails
in two files:

- `components/notification-bell.tsx`: its map from a bell's type to a page has no page for the three new bells. They
  open the scheduled emails page, which 21c.6 adds, and the map's `satisfies` refuses a route that does not exist yet.
- `mocks/report-data.ts`: its list of file names knows only the seven old kinds. 21c.7 gives the mock the new kinds.

These words come before the pages' mockup. If the mockup in 21c.6 changes a page, the words change with it, and the
diffs below show them as they are at the end of the step.

### `locales/en.ts`

The navigation (three new items) and the two new kinds of report. The kinds are the names on the Exports page and in
the bells (`reports.kinds.<kind>`), so a kind without a name does not type-check:

```diff
@@ -89,7 +89,12 @@ export const en = {
     purchaseReport: 'Purchase report',
     arAging: 'Receivables aging',
     apAging: 'Payables aging',
+    // Step 21c: the VAT report by the accounts' report permission, the stock movement by the
+    // stock reports' one; the scheduled emails by core.report.schedule
+    vatReport: 'VAT report',
+    stockMovement: 'Stock movement',
     exports: 'Exports',
+    reportSchedules: 'Scheduled emails',
     inventory: 'Inventory',
     products: 'Products',
     categories: 'Categories',
@@ -1110,6 +1115,8 @@ export const en = {
       purchase_report: 'Purchase report',
       ar_aging: 'Receivables aging',
       ap_aging: 'Payables aging',
+      vat_report: 'VAT report',
+      stock_movement: 'Stock movement',
     },
     formats: { xlsx: 'Excel', pdf: 'PDF' },
     sections: {
@@ -1166,6 +1173,8 @@ export const en = {
       xlsx: 'Excel (.xlsx)',
       pdf: 'PDF',
       started: "Preparing the {{format}} file. The bell tells you when it's ready.",
+      // Step 21c: the menu's last item. It opens the schedule dialog with the page's filters.
+      schedule: 'Email on a schedule',
     },
     trialBalance: {
       title: 'Trial balance',
```

- **`export.schedule`** is the last item of the Export menu. It opens the schedule dialog with the page's filters, so a
  schedule is always made from a report page (decision 10: its filters never change after that).

The VAT report and the stock movement report:

```diff
@@ -1401,6 +1410,119 @@ export const en = {
       overdueEmptyTitle: 'Nothing overdue on this day',
       overdueEmptyBody: 'Every open bill is still within its terms. Show everyone to see them.',
     },
+    // Step 21c. The VAT report also uses presets, branch, allBranches, range, booksAgree,
+    // booksOutBy, needsConnection, loadFailedTitle, loadFailedBody and export above.
+    vat: {
+      title: 'VAT report',
+      description: 'The VAT charged and paid in a period, by rate, to prepare the monthly return',
+      // It helps with Mushak 9.1, which comes in Phase 2; it is not the return
+      notReturn: 'Use it to fill in Mushak 9.1. It is not the return itself.',
+      kpis: {
+        output: 'Output VAT',
+        input: 'Input VAT',
+        net: 'Net VAT',
+      },
+      kpiHints: {
+        // amount = what came off, already left out of the VAT above it
+        outputReturned: '{{amount}} taken off by credit notes and POS returns',
+        inputReturned: '{{amount}} taken off by debit notes',
+        // Decision 2: this VAT stays in the input VAT, as in the books; the line says which
+        // bills to check
+        withoutMushak: '{{amount}} on bills with no Mushak 6.3 number',
+        // Under the net VAT, which the strip shows without its sign
+        payable: 'To pay',
+        carryForward: 'To carry forward',
+        nothing: 'Nothing to pay',
+      },
+      // A net VAT below zero in the table: never a bare minus
+      carry: '{{amount}} to carry forward',
+      // As the VAT rates show everywhere: "VAT 15% · 15%"
+      rate: '{{name}} · {{percent}}%',
+      columns: {
+        rate: 'VAT rate',
+        outputNet: 'Sales before VAT',
+        outputVat: 'Output VAT',
+        inputNet: 'Purchases before VAT',
+        inputVat: 'Input VAT',
+        netVat: 'Net VAT',
+      },
+      // The books' line has one figure for each side, each with its own pill
+      inBooksOutput: 'Output VAT in the books: {{amount}}',
+      inBooksInput: 'Input VAT in the books: {{amount}}',
+      booksHint:
+        'The books count the output VAT and input VAT accounts. A journal entry written by hand on them makes the two differ.',
+      documents: {
+        title: 'Documents',
+        subtitle: 'Every posted document with VAT in these dates, oldest first',
+        sides: { output: 'Output', input: 'Input' },
+        // VAT_DOCUMENT_KINDS in the contract
+        kinds: {
+          invoice: 'Invoice',
+          pos_sale: 'POS sale',
+          credit_note: 'Credit note',
+          pos_return: 'POS return',
+          bill: 'Supplier bill',
+          debit_note: 'Debit note',
+        },
+        columns: {
+          number: 'Number',
+          date: 'Date',
+          customer: 'Customer',
+          supplier: 'Supplier',
+          bin: 'BIN',
+          mushak: 'Mushak number',
+          net: 'Before VAT',
+          vat: 'VAT',
+        },
+        walkIn: 'Walk-in customer',
+        // A bill without its Mushak 6.3 number: the input VAT to check
+        noMushak: 'No Mushak 6.3',
+        emptyOutput: 'No sales with VAT in these dates.',
+        emptyInput: 'No purchases with VAT in these dates.',
+      },
+      emptyTitle: 'No VAT in these dates',
+      emptyBody: 'Pick other dates, or post an invoice or a supplier bill with VAT.',
+    },
+    // Step 21c. Also uses presets, category, allCategories, categoryHint and the rest above.
+    // The words match the exported file's (apps/api/src/reports/export/copy.ts).
+    stockMovement: {
+      title: 'Stock movement',
+      description:
+        'What each product opened with, what came in and went out, and what it closed with',
+      warehouse: 'Warehouse',
+      allWarehouses: 'All warehouses',
+      show: 'Show',
+      shows: { moved: 'Only what moved', all: 'Also what did not move' },
+      kpis: {
+        variants: 'Products',
+        openingValue: 'Opening value',
+        closingValue: 'Closing value',
+      },
+      // Why the strip has no total quantity
+      kpiHints: {
+        variants: 'In each product’s base unit, so the quantities have no total',
+      },
+      columns: {
+        product: 'Product',
+        opening: 'Opening',
+        purchased: 'Purchased',
+        sold: 'Sold',
+        transfers: 'Transfers',
+        adjusted: 'Adjusted',
+        closing: 'Closing',
+        openingValue: 'Opening value',
+        closingValue: 'Closing value',
+      },
+      // Under the table: where a return goes, and what a minus in Transfers means (decision 25)
+      returnsHint:
+        'A return comes off its own column: a sales return off Sold, a purchase return off Purchased.',
+      transfersHint:
+        'With every warehouse, a received transfer adds up to zero. A minus in Transfers is stock still on the way.',
+      openCard: 'Open the stock card of {{name}}',
+      emptyTitle: 'Nothing moved in these dates',
+      emptyBody: 'Pick other dates or filters, or show what did not move too.',
+      emptyAllBody: 'No product had stock or moved. Pick other dates or filters.',
+    },
   },
   exports: {
     title: 'Exports',
```

- **The VAT report reuses the shared words** above it (presets, branch, the books' pills, needs a connection, the
  export menu). Only what is its own is new.
- **`kpiHints`** are the lines under the KPI strip's values. `withoutMushak` is decision 2: the VAT on bills with no
  Mushak 6.3 number stays in the input VAT, as it does in the books, and the line says how much there is to check.
  `payable` / `carryForward` / `nothing` are decision 53.
- **`rate`** writes a row's rate the way every VAT rate is shown in the app: "VAT 15% · 15%". The kind (zero-rated or
  exempt) comes from the existing `taxRates.kinds`, so it is not repeated here.
- **Two books' lines** (`inBooksOutput`, `inBooksInput`), not one: output and input are two accounts, and each can be
  out on its own. Each has its own "Books agree" / "Out by" pill, from the shared words.
- **`documents.kinds`** are the six kinds of `VAT_DOCUMENT_KINDS`. They are new words and not
  `documentOutput.kinds`, because that list has no POS sale, POS return, bill or debit note.
- **`documents.columns`** has both `customer` and `supplier`: the party column's header follows the Output / Input
  control.
- **`notReturn`** keeps the accountant from filing the page itself: Mushak 9.1 is Phase 2.
- **The stock movement words match the exported file's** (`copy.ts`): Product, Opening, Purchased, Sold, Transfers,
  Adjusted, Closing. A person who exports the page sees the same columns.
- **`kpiHints.variants`** says why the strip has a count and no total quantity (decision 23): 40 pcs and 2.74 m are not
  one number.
- **`returnsHint` and `transfersHint`** answer the two questions the numbers raise: why a column can be smaller than
  what was received, and why Transfers can be below zero with every warehouse (stock on a truck, decision 25).
- **`emptyBody` and `emptyAllBody`**: with "Only what moved", the way out is to show what did not move too; with
  "Also what did not move", nothing had stock at all, so only other dates or filters help.

The scheduled emails, a section of their own after `exports`:

```diff
@@ -1422,6 +1544,112 @@ export const en = {
     emptyBody: 'Open a report, like the trial balance, and choose Export. The file shows up here.',
     loadFailed: "Couldn't load your exports. Refresh the page to try again.",
   },
+  // Step 21c: reports that go by email on a schedule. The dialog opens from a report's Export
+  // menu; the page lists the workspace's schedules.
+  reportSchedules: {
+    title: 'Scheduled emails',
+    description: 'Reports that go by email by themselves, with their own dates each time',
+    newTitle: 'Email the {{report}} on a schedule',
+    newDescription: 'Each person gets their own file, with what their role may see.',
+    editTitle: 'Change the {{report}} email',
+    format: 'File',
+    frequency: 'How often',
+    frequencies: { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' },
+    // What each email covers (decision 8). The day it goes is never in it.
+    periods: {
+      daily: 'Each email has yesterday.',
+      weekly: 'Each email has the 7 days up to yesterday.',
+      monthly: 'Each email has the whole month before.',
+    },
+    // An aging or a balance sheet shows one day
+    asOfHint: 'The report shows the last day of that period.',
+    weekday: 'Day',
+    // 0 = Sunday in the contract; the page keeps the order in a list of these keys
+    weekdays: {
+      sunday: 'Sunday',
+      monday: 'Monday',
+      tuesday: 'Tuesday',
+      wednesday: 'Wednesday',
+      thursday: 'Thursday',
+      friday: 'Friday',
+      saturday: 'Saturday',
+    },
+    dayOfMonth: 'Day of the month',
+    dayOfMonthHint: 'Up to the 28th, so every month has it.',
+    hour: 'Time',
+    hourHint: 'In the workspace’s time zone, {{timeZone}}.',
+    recipients: 'Send to',
+    recipientsHint: 'Members who may read this report. Up to {{count}}.',
+    noCandidates: 'Nobody may read this report yet. Give a role its permission on the Roles page.',
+    filters: 'Filters',
+    // Decision 10: the filters are kept and never change
+    filtersHint:
+      'The filters on the page now go with every email. For other filters, make a new email from the report.',
+    noFilters: 'None',
+    fixedHint:
+      'The report and its filters stay as they were made. For others, make a new email from the report.',
+    create: 'Schedule email',
+    save: 'Save changes',
+    // date = the first run, as a date and time in the workspace's time zone
+    created: 'The {{report}} is scheduled. The first email goes on {{date}}.',
+    updated: 'The {{report}} email is changed',
+    // In the list. time = "08:00"; weekday = one of the weekdays above
+    when: {
+      daily: 'Every day at {{time}}',
+      weekly: 'Every {{weekday}} at {{time}}',
+      monthly: 'Day {{day}} of every month at {{time}}',
+    },
+    columns: {
+      report: 'Report',
+      when: 'When',
+      recipients: 'Sent to',
+      nextRun: 'Next email',
+      status: 'Status',
+      // Screen readers only: the column of each row's menu
+      actions: 'Actions',
+    },
+    statuses: { active: 'Active', paused: 'Paused' },
+    // Under the Paused pill
+    pausedReasons: {
+      manual: 'Someone paused it. Resume it to send it again.',
+      no_recipients:
+        'Nobody on it may read the report any more. Add someone who may, then resume it.',
+    },
+    recipientCount_one: '{{count}} person',
+    recipientCount_other: '{{count}} people',
+    // Someone on the schedule who left, or lost the report's permission
+    cannotReceive: 'Gets nothing: may not read this report now',
+    cannotReceiveCount_one: '{{count}} person gets nothing',
+    cannotReceiveCount_other: '{{count}} people get nothing',
+    lastRun: 'Last sent {{date}}',
+    notSentYet: 'Not sent yet',
+    createdBy: 'Made by {{name}}',
+    // Decision 6: up to 20 in a workspace
+    count: '{{count}} of {{max}} scheduled emails',
+    actionsFor: 'Actions for {{report}}',
+    edit: 'Change',
+    pause: 'Pause',
+    resume: 'Resume',
+    delete: 'Delete',
+    paused: 'The {{report}} email is paused',
+    resumed: 'The {{report}} email is on again',
+    deleteTitle: 'Delete this scheduled email?',
+    deleteBody: 'Nobody gets it any more. Files already sent stay on each person’s Exports page.',
+    deleteConfirm: 'Delete schedule',
+    deleted: 'The {{report}} email is deleted',
+    // Under the report's name in the list (filterNames in the contract)
+    filterLines: {
+      branch: 'Branch: {{name}}',
+      warehouse: 'Warehouse: {{name}}',
+      group: 'Group: {{name}}',
+      category: 'Category: {{name}}',
+      // The sales and purchase reports' Group by; name = the group's word ("Customer")
+      groupBy: 'Group by: {{name}}',
+    },
+    emptyTitle: 'No scheduled emails yet',
+    emptyBody: 'Open a report, like the sales report, choose Export, then Email on a schedule.',
+    loadFailed: "Couldn't load the scheduled emails. Refresh the page to try again.",
+  },
   products: {
     title: 'Products',
     description: 'Everything you buy, make, keep in stock or sell',
```

- **`periods`** tell the person what each email will hold before they save it (decision 8). The day the email goes is
  never in it, so the words say "yesterday", not "today".
- **`asOfHint`** shows only for the aging and the balance sheet: they show one day, the period's last.
- **`weekdays`** are decision 52.
- **`hourHint`** names the time zone: "08:00" means nothing without it, and the list says it once for every row.
- **`noCandidates`** is the dialog's empty state: the recipients are only the members who may read the report, so a
  report nobody else may read has nobody to offer. It says where to fix that.
- **`filtersHint` / `fixedHint`** say decision 10 in words, in the new dialog and in the edit dialog.
- **`recipientCount` and `cannotReceiveCount`** have plural keys (`_one`, `_other`), as `roles.members` does.
- **`cannotReceive`** marks a person still on the schedule who left the workspace or lost the permission. They stay on
  it (the permission may come back), but the list must not let anyone think they still get it.
- **`pausedReasons`** sit under the Paused pill: a pause by hand needs only a Resume, a pause by the worker needs a
  recipient first, or Resume fails with `report_schedule_no_recipients`.
- **`deleteBody`** says what stays: the files already sent are each person's exports, and deleting the schedule does
  not take them away.

The permission, the audit log, the bells and the errors:

```diff
@@ -5512,6 +5740,7 @@ export const en = {
       settings: { manage: 'Edit company settings and numbering' },
       branch: { manage: 'Add, edit and archive branches' },
       audit: { read: 'See the audit log' },
+      report: { schedule: 'Email reports on a schedule' },
     },
     accounting: {
       account: { manage: 'Add, change, archive and delete accounts' },
@@ -5670,6 +5899,7 @@ export const en = {
       pos_cash_reason: 'POS cash reasons',
       pos_shift: 'POS shifts',
       pos_return: 'POS returns',
+      report_schedule: 'Scheduled emails',
     },
     columns: {
       when: 'When',
@@ -5986,6 +6216,14 @@ export const en = {
         amounts_differ: 'The device and the server worked out different money back',
         without_permission: 'Took goods back at a POS counter after losing the permission',
       },
+      // Step 21c. paused with no actor: the worker found that nobody on it may read the report
+      report_schedule: {
+        created: 'Scheduled a report email',
+        updated: 'Changed a scheduled report email',
+        paused: 'Paused a scheduled report email',
+        resumed: 'Resumed a scheduled report email',
+        deleted: 'Deleted a scheduled report email',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -6159,6 +6397,15 @@ export const en = {
       returnedOn: 'Date on the device',
       sale: 'Sale',
       refunds: 'Paid back',
+      // Step 21c: a scheduled report email
+      report: 'Report',
+      format: 'File',
+      frequency: 'How often',
+      hour: 'Hour',
+      weekday: 'Day of the week',
+      dayOfMonth: 'Day of the month',
+      recipients: 'Sent to',
+      pausedReason: 'Why it stopped',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -6233,6 +6480,14 @@ export const en = {
       report: {
         ready: '{{report}} ({{format}}) is ready to download.',
         failed: "{{report}} ({{format}}) couldn't be made. Try the export again.",
+        // Step 21c: to the person who made the schedule (decision 12). {{count}} is a number of
+        // people, so no plural keys: the sentence reads right for 1 and for many
+        schedule_skipped:
+          '{{report}} went out, but not to everyone: some may no longer read it. People left out: {{count}}.',
+        schedule_paused:
+          '{{report}} stopped going out: nobody on it may read it any more. Add someone who may, then resume it.',
+        schedule_failed:
+          "The scheduled {{report}} ({{format}}) couldn't be made or sent to one person. The next email tries again.",
       },
       import: {
         done: '{{file}}: {{count}} products imported.',
@@ -6362,6 +6617,14 @@ export const en = {
     report_range_invalid: 'Pick an end date on or after the start date.',
     report_compare_incomplete: 'Pick both dates of the comparison, or neither.',
     report_sort_invalid: 'Only the report by product sorts by quantity. Pick another column.',
+    // Step 21c: scheduled report emails
+    report_schedule_limit:
+      'A workspace has up to 20 scheduled emails. Delete one you no longer need, then try again.',
+    report_schedule_recipients_needed: 'Pick at least one person to send it to.',
+    report_schedule_recipients_too_many: 'Pick up to 10 people. Make a second email for the rest.',
+    report_schedule_recipient_invalid: 'Pick only members who may read this report.',
+    report_schedule_no_recipients:
+      'Nobody on this email may read the report now. Add someone who may, then resume it.',
     year_end_invalid: 'Pick the last day of a fiscal year.',
     year_not_ended: "This year hasn't ended yet. Close it after its last day.",
     year_already_closed: 'This year is closed already. Reload to see it.',
```

- **`permissions.core.report.schedule`** is the label in the role matrix. The matrix finds it by the key, so a
  permission without a label does not type-check.
- **`audit.fields`** name the values the API writes into a schedule's audit entry (`snapshot()` in
  `report-schedules.service.ts`, and the worker's pause). A field without a word shows its raw name, so this is not
  checked by the compiler; the list here is every field the API writes.
- **The three bells** go to the person who made the schedule (decision 12). `{{report}}` and `{{format}}` arrive as
  keys; the bell turns them into words, as it does for an export. `{{count}}` is a number of people, so there are no
  plural keys: "People left out: 2." reads right for one person and for many, as `pos.sold_short` does.
- **The five errors** say what to do. `report_schedule_limit` and `report_schedule_recipients_too_many` give the limit
  (20 schedules, 10 people), so the person knows how far to go back. `report_schedule_recipient_invalid` covers both a
  non-member and a member who may not read the report: the dialog offers neither, so a person sees it only when someone
  lost the permission while the dialog was open.

### `locales/bn.ts`

The same words in Bangla, in the same places. `bn` is typed as `Messages` (the English object's type), so a key
missing here does not type-check.

```diff
@@ -79,7 +79,10 @@ export const bn: Messages = {
     purchaseReport: 'কেনাকাটার রিপোর্ট',
     arAging: 'পাওনার এজিং',
     apAging: 'দেনার এজিং',
+    vatReport: 'VAT রিপোর্ট',
+    stockMovement: 'স্টকের আসা-যাওয়া',
     exports: 'এক্সপোর্ট',
+    reportSchedules: 'নিয়মিত ইমেইল',
     inventory: 'ইনভেন্টরি',
     products: 'প্রোডাক্ট',
     categories: 'ক্যাটাগরি',
@@ -1007,6 +1010,8 @@ export const bn: Messages = {
       purchase_report: 'কেনাকাটার রিপোর্ট',
       ar_aging: 'পাওনার এজিং',
       ap_aging: 'দেনার এজিং',
+      vat_report: 'VAT রিপোর্ট',
+      stock_movement: 'স্টকের আসা-যাওয়া',
     },
     formats: { xlsx: 'Excel', pdf: 'PDF' },
     sections: {
@@ -1063,6 +1068,7 @@ export const bn: Messages = {
       xlsx: 'Excel (.xlsx)',
       pdf: 'PDF',
       started: '{{format}} ফাইল তৈরি হচ্ছে। তৈরি হলে বেল-এ জানানো হবে।',
+      schedule: 'নিয়মিত ইমেইলে পাঠান',
     },
     trialBalance: {
       title: 'ট্রায়াল ব্যালান্স',
@@ -1273,6 +1279,103 @@ export const bn: Messages = {
       overdueEmptyTitle: 'এই দিনে কিছু সময় পার হয়নি',
       overdueEmptyBody: 'প্রতিটা বাকি বিল এখনো তার শর্তের মধ্যে আছে। দেখতে “সবাই” বাছুন।',
     },
+    vat: {
+      title: 'VAT রিপোর্ট',
+      description:
+        'একটা সময়কালে হার অনুযায়ী কত VAT নেওয়া আর দেওয়া হলো, মাসিক রিটার্ন তৈরির জন্য',
+      notReturn: 'এটা দিয়ে মূসক ৯.১ পূরণ করুন। এটা নিজে রিটার্ন নয়।',
+      kpis: {
+        output: 'আউটপুট VAT',
+        input: 'ইনপুট VAT',
+        net: 'নিট VAT',
+      },
+      kpiHints: {
+        outputReturned: 'ক্রেডিট নোট আর POS ফেরতে {{amount}} বাদ গেছে',
+        inputReturned: 'ডেবিট নোটে {{amount}} বাদ গেছে',
+        withoutMushak: 'মূসক ৬.৩ নম্বর ছাড়া বিলে {{amount}}',
+        payable: 'দিতে হবে',
+        carryForward: 'পরের মাসে যাবে',
+        nothing: 'কিছু দিতে হবে না',
+      },
+      carry: '{{amount}} পরের মাসে যাবে',
+      rate: '{{name}} · {{percent}}%',
+      columns: {
+        rate: 'VAT-এর হার',
+        outputNet: 'VAT-এর আগে বিক্রি',
+        outputVat: 'আউটপুট VAT',
+        inputNet: 'VAT-এর আগে কেনাকাটা',
+        inputVat: 'ইনপুট VAT',
+        netVat: 'নিট VAT',
+      },
+      inBooksOutput: 'খাতায় আউটপুট VAT: {{amount}}',
+      inBooksInput: 'খাতায় ইনপুট VAT: {{amount}}',
+      booksHint:
+        'খাতা ধরে আউটপুট VAT আর ইনপুট VAT-এর অ্যাকাউন্ট। এগুলোতে হাতে লেখা জার্নাল এন্ট্রি থাকলে দুটো আলাদা হয়।',
+      documents: {
+        title: 'ডকুমেন্ট',
+        subtitle: 'এই তারিখগুলোতে VAT-সহ প্রতিটা পোস্ট করা ডকুমেন্ট, পুরোনোটা আগে',
+        sides: { output: 'আউটপুট', input: 'ইনপুট' },
+        kinds: {
+          invoice: 'ইনভয়েস',
+          pos_sale: 'POS বিক্রি',
+          credit_note: 'ক্রেডিট নোট',
+          pos_return: 'POS ফেরত',
+          bill: 'সাপ্লায়ারের বিল',
+          debit_note: 'ডেবিট নোট',
+        },
+        columns: {
+          number: 'নম্বর',
+          date: 'তারিখ',
+          customer: 'গ্রাহক',
+          supplier: 'সাপ্লায়ার',
+          bin: 'BIN',
+          mushak: 'মূসক নম্বর',
+          net: 'VAT-এর আগে',
+          vat: 'VAT',
+        },
+        walkIn: 'ওয়াক-ইন গ্রাহক',
+        noMushak: 'মূসক ৬.৩ নেই',
+        emptyOutput: 'এই তারিখগুলোতে VAT-সহ কোনো বিক্রি নেই।',
+        emptyInput: 'এই তারিখগুলোতে VAT-সহ কোনো কেনাকাটা নেই।',
+      },
+      emptyTitle: 'এই তারিখগুলোতে কোনো VAT নেই',
+      emptyBody: 'অন্য তারিখ বাছুন, অথবা VAT-সহ একটা ইনভয়েস বা সাপ্লায়ারের বিল পোস্ট করুন।',
+    },
+    stockMovement: {
+      title: 'স্টকের আসা-যাওয়া',
+      description: 'প্রতিটা প্রোডাক্ট কত নিয়ে শুরু করল, কী এল আর গেল, আর কত নিয়ে শেষ হলো',
+      warehouse: 'গুদাম',
+      allWarehouses: 'সব গুদাম',
+      show: 'দেখান',
+      shows: { moved: 'শুধু যা নড়েছে', all: 'যা নড়েনি সেগুলোও' },
+      kpis: {
+        variants: 'প্রোডাক্ট',
+        openingValue: 'শুরুর মূল্য',
+        closingValue: 'শেষের মূল্য',
+      },
+      kpiHints: {
+        variants: 'প্রতিটা প্রোডাক্টের বেস ইউনিটে, তাই পরিমাণের কোনো মোট নেই',
+      },
+      columns: {
+        product: 'প্রোডাক্ট',
+        opening: 'শুরুতে',
+        purchased: 'কেনা',
+        sold: 'বিক্রি',
+        transfers: 'ট্রান্সফার',
+        adjusted: 'অ্যাডজাস্টমেন্ট',
+        closing: 'শেষে',
+        openingValue: 'শুরুর মূল্য',
+        closingValue: 'শেষের মূল্য',
+      },
+      returnsHint:
+        'ফেরত বাদ যায় নিজের কলাম থেকে: বিক্রি ফেরত “বিক্রি” থেকে, কেনাকাটা ফেরত “কেনা” থেকে।',
+      transfersHint:
+        'সব গুদাম ধরলে পৌঁছে যাওয়া ট্রান্সফারের যোগফল শূন্য। ট্রান্সফারে মাইনাস মানে মাল এখনো পথে।',
+      openCard: '{{name}}-এর স্টক কার্ড খুলুন',
+      emptyTitle: 'এই তারিখগুলোতে কিছু নড়েনি',
+      emptyBody: 'অন্য তারিখ বা ফিল্টার বাছুন, অথবা যা নড়েনি সেগুলোও দেখান।',
+      emptyAllBody: 'কোনো প্রোডাক্টের স্টক ছিল না, কিছু নড়েওনি। অন্য তারিখ বা ফিল্টার বাছুন।',
+    },
   },
   exports: {
     title: 'এক্সপোর্ট',
@@ -1295,6 +1398,101 @@ export const bn: Messages = {
       'একটা রিপোর্ট খুলুন, যেমন ট্রায়াল ব্যালান্স, আর এক্সপোর্ট বাছুন। ফাইলটা এখানে আসবে।',
     loadFailed: 'এক্সপোর্টগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  reportSchedules: {
+    title: 'নিয়মিত ইমেইল',
+    description: 'যে রিপোর্টগুলো নিজে থেকে ইমেইলে যায়, প্রতিবার নিজের তারিখ নিয়ে',
+    newTitle: '{{report}} নিয়মিত ইমেইলে পাঠান',
+    newDescription: 'প্রত্যেকে নিজের ফাইল পান, তাঁর রোল যা দেখতে পারে তা নিয়ে।',
+    editTitle: '{{report}}-এর ইমেইল বদলান',
+    format: 'ফাইল',
+    frequency: 'কত দিন পরপর',
+    frequencies: { daily: 'প্রতিদিন', weekly: 'প্রতি সপ্তাহে', monthly: 'প্রতি মাসে' },
+    periods: {
+      daily: 'প্রতিটা ইমেইলে থাকে গতকাল।',
+      weekly: 'প্রতিটা ইমেইলে থাকে গতকাল পর্যন্ত ৭ দিন।',
+      monthly: 'প্রতিটা ইমেইলে থাকে আগের পুরো মাস।',
+    },
+    asOfHint: 'রিপোর্টটা সেই সময়কালের শেষ দিনের হিসাব দেখায়।',
+    weekday: 'দিন',
+    weekdays: {
+      sunday: 'রবিবার',
+      monday: 'সোমবার',
+      tuesday: 'মঙ্গলবার',
+      wednesday: 'বুধবার',
+      thursday: 'বৃহস্পতিবার',
+      friday: 'শুক্রবার',
+      saturday: 'শনিবার',
+    },
+    dayOfMonth: 'মাসের তারিখ',
+    dayOfMonthHint: '২৮ তারিখ পর্যন্ত, যাতে প্রতিটা মাসে দিনটা থাকে।',
+    hour: 'সময়',
+    hourHint: 'ওয়ার্কস্পেসের টাইমজোনে, {{timeZone}}।',
+    recipients: 'যাঁদের পাঠাবেন',
+    recipientsHint: 'যে সদস্যরা এই রিপোর্ট দেখতে পারেন। সর্বোচ্চ {{count}} জন।',
+    noCandidates:
+      'এখনো কেউ এই রিপোর্ট দেখতে পারেন না। আগে Roles পেজে কোনো রোলকে এর permission দিন।',
+    filters: 'ফিল্টার',
+    filtersHint:
+      'পেজের এখনকার ফিল্টারগুলো প্রতিটা ইমেইলে যাবে। অন্য ফিল্টারের জন্য রিপোর্ট থেকে নতুন ইমেইল তৈরি করুন।',
+    noFilters: 'কিছু না',
+    fixedHint:
+      'রিপোর্ট আর তার ফিল্টার তৈরির সময় যেমন ছিল তেমনই থাকে। অন্যগুলোর জন্য রিপোর্ট থেকে নতুন ইমেইল তৈরি করুন।',
+    create: 'নিয়মিত পাঠান',
+    save: 'পরিবর্তন সেভ করুন',
+    created: '{{report}} নিয়মিত যাবে। প্রথম ইমেইল যাবে {{date}}।',
+    updated: '{{report}}-এর ইমেইল বদলানো হয়েছে',
+    when: {
+      daily: 'প্রতিদিন {{time}}-এ',
+      weekly: 'প্রতি {{weekday}} {{time}}-এ',
+      monthly: 'প্রতি মাসের {{day}} তারিখ {{time}}-এ',
+    },
+    columns: {
+      report: 'রিপোর্ট',
+      when: 'কখন',
+      recipients: 'যাঁদের যায়',
+      nextRun: 'পরের ইমেইল',
+      status: 'অবস্থা',
+      actions: 'কাজ',
+    },
+    statuses: { active: 'চালু', paused: 'থামানো' },
+    pausedReasons: {
+      manual: 'কেউ এটা থামিয়েছেন। আবার পাঠাতে চালু করুন।',
+      no_recipients:
+        'এতে থাকা কেউ আর রিপোর্টটা দেখতে পারেন না। দেখতে পারেন এমন কাউকে যোগ করে আবার চালু করুন।',
+    },
+    recipientCount_one: '{{count}} জন',
+    recipientCount_other: '{{count}} জন',
+    cannotReceive: 'কিছু পাবেন না: এখন এই রিপোর্ট দেখতে পারেন না',
+    cannotReceiveCount_one: '{{count}} জন কিছু পাবেন না',
+    cannotReceiveCount_other: '{{count}} জন কিছু পাবেন না',
+    lastRun: 'শেষ পাঠানো {{date}}',
+    notSentYet: 'এখনো পাঠানো হয়নি',
+    createdBy: '{{name}} তৈরি করেছেন',
+    count: '{{max}}টার মধ্যে {{count}}টা নিয়মিত ইমেইল',
+    actionsFor: '{{report}}-এর কাজ',
+    edit: 'বদলান',
+    pause: 'থামান',
+    resume: 'চালু করুন',
+    delete: 'মুছুন',
+    paused: '{{report}}-এর ইমেইল থামানো হয়েছে',
+    resumed: '{{report}}-এর ইমেইল আবার চালু',
+    deleteTitle: 'এই নিয়মিত ইমেইল মুছবেন?',
+    deleteBody:
+      'এরপর আর কেউ এটা পাবেন না। আগে পাঠানো ফাইলগুলো প্রত্যেকের এক্সপোর্ট পেজে থেকে যাবে।',
+    deleteConfirm: 'ইমেইল মুছুন',
+    deleted: '{{report}}-এর ইমেইল মুছে ফেলা হয়েছে',
+    filterLines: {
+      branch: 'ব্রাঞ্চ: {{name}}',
+      warehouse: 'গুদাম: {{name}}',
+      group: 'গ্রুপ: {{name}}',
+      category: 'ক্যাটাগরি: {{name}}',
+      groupBy: 'ভাগ করে দেখুন: {{name}}',
+    },
+    emptyTitle: 'এখনো কোনো নিয়মিত ইমেইল নেই',
+    emptyBody:
+      'একটা রিপোর্ট খুলুন, যেমন বিক্রির রিপোর্ট, এক্সপোর্ট বাছুন, তারপর “নিয়মিত ইমেইলে পাঠান”।',
+    loadFailed: 'নিয়মিত ইমেইলগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   products: {
     title: 'প্রোডাক্ট',
     description: 'যা কিছু কেনেন, বানান, স্টকে রাখেন বা বিক্রি করেন',
@@ -5173,6 +5371,7 @@ export const bn: Messages = {
       settings: { manage: 'কোম্পানির সেটিংস আর নম্বরিং বদলানো' },
       branch: { manage: 'ব্রাঞ্চ যোগ, বদল আর আর্কাইভ' },
       audit: { read: 'অডিট লগ দেখা' },
+      report: { schedule: 'রিপোর্ট নিয়মিত ইমেইলে পাঠানো' },
     },
     accounting: {
       account: { manage: 'অ্যাকাউন্ট যোগ, বদল, আর্কাইভ আর মোছা' },
@@ -5319,6 +5518,7 @@ export const bn: Messages = {
       pos_cash_reason: 'POS ক্যাশের কারণ',
       pos_shift: 'POS শিফট',
       pos_return: 'POS ফেরত',
+      report_schedule: 'নিয়মিত ইমেইল',
     },
     columns: {
       when: 'কখন',
@@ -5626,6 +5826,13 @@ export const bn: Messages = {
         amounts_differ: 'ডিভাইস আর সার্ভার ফেরতের টাকা আলাদা হিসাব করেছে',
         without_permission: 'অনুমতি চলে যাওয়ার পরে POS কাউন্টারে মাল ফেরত নিয়েছেন',
       },
+      report_schedule: {
+        created: 'রিপোর্টের নিয়মিত ইমেইল তৈরি করেছেন',
+        updated: 'রিপোর্টের নিয়মিত ইমেইল বদলেছেন',
+        paused: 'রিপোর্টের নিয়মিত ইমেইল থামিয়েছেন',
+        resumed: 'রিপোর্টের নিয়মিত ইমেইল আবার চালু করেছেন',
+        deleted: 'রিপোর্টের নিয়মিত ইমেইল মুছেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -5795,6 +6002,14 @@ export const bn: Messages = {
       returnedOn: 'ডিভাইসের তারিখ',
       sale: 'বিক্রি',
       refunds: 'ফেরত দেওয়া',
+      report: 'রিপোর্ট',
+      format: 'ফাইল',
+      frequency: 'কত দিন পরপর',
+      hour: 'ঘণ্টা',
+      weekday: 'সপ্তাহের দিন',
+      dayOfMonth: 'মাসের তারিখ',
+      recipients: 'যাঁদের যায়',
+      pausedReason: 'কেন থামল',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -5866,6 +6081,12 @@ export const bn: Messages = {
       report: {
         ready: '{{report}} ({{format}}) ডাউনলোডের জন্য তৈরি।',
         failed: '{{report}} ({{format}}) তৈরি করা যায়নি। আবার এক্সপোর্ট করুন।',
+        schedule_skipped:
+          '{{report}} গেছে, তবে সবার কাছে নয়: কেউ কেউ আর এটা দেখতে পারেন না। বাদ পড়েছেন: {{count}} জন।',
+        schedule_paused:
+          '{{report}} যাওয়া থেমে গেছে: এতে থাকা কেউ আর এটা দেখতে পারেন না। দেখতে পারেন এমন কাউকে যোগ করে আবার চালু করুন।',
+        schedule_failed:
+          'নিয়মিত {{report}} ({{format}}) একজনের জন্য তৈরি বা পাঠানো যায়নি। পরের ইমেইলে আবার চেষ্টা হবে।',
       },
       import: {
         done: '{{file}}: {{count}}টা প্রোডাক্ট ইমপোর্ট হয়েছে।',
@@ -5986,6 +6207,14 @@ export const bn: Messages = {
     report_compare_incomplete: 'তুলনার দুটো তারিখই বাছুন, অথবা কোনোটাই না।',
     report_sort_invalid:
       'শুধু প্রোডাক্ট অনুযায়ী রিপোর্ট পরিমাণ দিয়ে সাজানো যায়। অন্য একটা কলাম বাছুন।',
+    report_schedule_limit:
+      'একটা ওয়ার্কস্পেসে সর্বোচ্চ ২০টা নিয়মিত ইমেইল থাকতে পারে। দরকার নেই এমন একটা মুছে আবার চেষ্টা করুন।',
+    report_schedule_recipients_needed: 'অন্তত একজনকে বাছুন।',
+    report_schedule_recipients_too_many:
+      'সর্বোচ্চ ১০ জন বাছুন। বাকিদের জন্য আরেকটা ইমেইল তৈরি করুন।',
+    report_schedule_recipient_invalid: 'শুধু সেই সদস্যদের বাছুন যাঁরা এই রিপোর্ট দেখতে পারেন।',
+    report_schedule_no_recipients:
+      'এই ইমেইলে থাকা কেউ এখন রিপোর্টটা দেখতে পারেন না। দেখতে পারেন এমন কাউকে যোগ করে আবার চালু করুন।',
     year_end_invalid: 'একটা অর্থবছরের শেষ দিন বাছুন।',
     year_not_ended: 'এই বছর এখনো শেষ হয়নি। শেষ দিনের পরে ক্লোজ করুন।',
     year_already_closed: 'এই বছর আগেই ক্লোজ হয়েছে। দেখতে পেজটা রিলোড করুন।',
```

- **Decision 51:** "VAT", "আউটপুট VAT", "ইনপুট VAT", "VAT-এর আগে বিক্রি". Mushak is "মূসক ৬.৩", as on the bill form.
- **The stock words are the exported file's Bangla**: শুরুতে, কেনা, বিক্রি, ট্রান্সফার, অ্যাডজাস্টমেন্ট, শেষে.
- **A member is "সদস্য"**, as on the Team page, and the base unit is "বেস ইউনিট", as on the product form.
- **`recipientCount_one` and `_other` are the same** ("{{count}} জন"): Bangla does not change the noun for one, but
  i18next still looks for both keys.

### `apps/api`: the files' Bangla words

The diff of `reports/export/copy.ts` in 21c.3 above already shows the file as it is now. Twelve words changed from "ভ্যাট" to "VAT" (decision 51), and "POS রিটার্ন" became
"POS ফেরত". The English words did not change. Two tests read these words, and change with them:

- `reports/export/document.spec.ts`: the Bangla line under the VAT file's title ("হিসাবের খাতায়: আউটপুট VAT ৭০৫.৬০, …").
- `mail/scheduled-report-email.spec.ts`: the Bangla email's subject ("VAT রিপোর্ট, ১ অক্টো, ২০২৬ – …").

Both show in 21c.3 and 21c.4 with these words.

### What I checked

- Every key in `en.ts` has a key in `bn.ts`, and each pair has the same `{{…}}` names (a small script over the built
  objects: 5,634 keys, none different). A Bangla word with `{{amount}}` where the English has `{{value}}` would print
  the raw `{{amount}}` on the screen, and the compiler does not see it.
- The bell's and the exports page's lookups (`reports.kinds.<kind>`) type-check for the two new kinds.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/app typecheck
pnpm exec eslint packages/i18n/src apps/api/src/reports/export apps/api/src/mail
pnpm exec prettier --check packages/i18n/src apps/api/src/reports/export apps/api/src/mail
cd apps/api && npx vitest run src/reports/export src/mail
```

All pass (i18n 17 tests, the export and mail tests 25), except the app's type check in the two files above. The new
words are used in 21c.6.

## 21c.6 — `apps/app`: the screens

Three new pages and one dialog, from the mockup you approved (decisions 54–57):

- `/reports/vat` (`accounting.report.read`): the VAT of a period by rate, the books beside it, and the documents.
- `/reports/stock-movement` (`inventory.report.read`): opening, in, out and closing stock per product.
- `/reports/schedules` (`core.report.schedule`): the workspace's scheduled emails.
- The schedule dialog, from the Export menu of every report (for a new schedule) and from the schedules page (to
  change one).

Each page is its own lazy chunk, and so is the dialog: a report page loads the dialog's code only when someone picks
"Email on a schedule".

When this part ends, the app type-checks except `mocks/report-data.ts`, whose list of file names still knows only the
seven old kinds. 21c.7 adds the mock answers for the new pages and fixes that list.

### What the pages share: `lib/report-schedules.ts` (new)

The schedules page and the dialog both need the schedule queries and the words of a schedule. They live in their own
small module. If the page imported them from the dialog's file, the page's chunk would carry the whole dialog.

```ts
import {
  isReportKind,
  PURCHASE_REPORT_GROUPS,
  type ReportKind,
  type ReportSchedule,
  type ReportScheduleWhen,
  routes,
  SALES_REPORT_GROUPS,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { queryOptions } from '@tanstack/react-query';
import { useCallback } from 'react';

import { call } from './api';

// Step 21c: what the scheduled emails page and the schedule dialog share. Its own module: the
// dialog is a lazy chunk, and the page must not pull it in to get the words of a row.

// The workspace's schedules. Not paged: a workspace has at most 20 (MAX_REPORT_SCHEDULES).
export function reportSchedulesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['report-schedules', tenantId],
    queryFn: () => call(routes.reportSchedules.list),
  });
}

// The members who may read the report, so the form offers nobody else. Under the list's key, so
// saving a schedule (which invalidates the list) asks again too.
export function reportScheduleCandidatesQuery(tenantId: string, report: ReportKind) {
  return queryOptions({
    queryKey: ['report-schedules', tenantId, 'candidates', report],
    queryFn: () => call(routes.reportSchedules.candidates, { query: { report } }),
  });
}

// 0 = Sunday, as the contract counts (Date.getUTCDay()). The keys of reportSchedules.weekdays in
// this order (decision 52), so the number never has to be a key.
export const WEEKDAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export const SCHEDULE_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
```

- **`reportSchedulesQuery`** is not paged: a workspace has at most 20 schedules (decision 6).
- **`reportScheduleCandidatesQuery`** asks the server who may read a report, so the form offers nobody else. Its key
  starts with the list's key (`['report-schedules', tenantId]`). Saving a schedule invalidates that prefix, so a role
  change made meanwhile shows the next time the dialog opens.
- **`WEEKDAY_KEYS`** is decision 52. The contract counts 0 = Sunday; the index into this list is that number, and the
  item is the key of the word. A typed `t()` cannot take `` `weekdays.${number}` ``, so the number is never a key.
- **`SCHEDULE_HOURS`**: whole hours only (decision 13).

```ts
// The words of a schedule: "Every Sunday at 08:00", the report's name and its filter lines
export function useScheduleWords() {
  const { t, format } = useLocale();

  // A whole hour as the clock shows it ("08:00", "০৮:০০"). Read in UTC from a UTC date, so no time
  // zone moves it: the hour means the workspace's time, and the page only names it.
  const hour = useCallback(
    (value: number) => format.time(new Date(Date.UTC(2026, 0, 1, value)), 'UTC'),
    [format],
  );

  const when = useCallback(
    (value: ReportScheduleWhen) => {
      const time = hour(value.hour);
      switch (value.frequency) {
        case 'daily':
          return t('reportSchedules.when.daily', { time });
        case 'weekly':
          return t('reportSchedules.when.weekly', {
            time,
            // weekday is 0–6 (the contract checks it), so the key is always there
            weekday: t(`reportSchedules.weekdays.${WEEKDAY_KEYS[value.weekday] ?? 'sunday'}`),
          });
        case 'monthly':
          return t('reportSchedules.when.monthly', { time, day: format.number(value.dayOfMonth) });
      }
    },
    [t, format, hour],
  );

  // The report's name, or the raw kind from a newer server this app does not know yet
  const report = useCallback(
    (kind: string) => (isReportKind(kind) ? t(`reports.kinds.${kind}`) : kind),
    [t],
  );

  // The lines under a schedule's name: the filters it keeps, by name (the API resolved the ids).
  // Group by is a word of the report, not an id, so the page names it from the kept filters.
  const filterLines = useCallback(
    (schedule: Pick<ReportSchedule, 'report' | 'filters' | 'filterNames'>): string[] => {
      const lines: string[] = [];
      const group = groupByWord(schedule.report, schedule.filters.groupBy);
      if (group !== null) lines.push(t('reportSchedules.filterLines.groupBy', { name: t(group) }));
      const names = schedule.filterNames;
      if (names.branch !== null) {
        lines.push(t('reportSchedules.filterLines.branch', { name: names.branch }));
      }
      if (names.warehouse !== null) {
        lines.push(t('reportSchedules.filterLines.warehouse', { name: names.warehouse }));
      }
      if (names.group !== null) {
        lines.push(t('reportSchedules.filterLines.group', { name: names.group }));
      }
      if (names.category !== null) {
        lines.push(t('reportSchedules.filterLines.category', { name: names.category }));
      }
      return lines;
    },
    [t],
  );

  return { hour, when, report, filterLines };
}

// The i18n key of a sales or purchase report's Group by, or null for every other report (and for
// a value this app does not know). find() narrows the string to the report's own groups.
function groupByWord(report: string, value: string | undefined) {
  if (value === undefined) return null;
  if (report === 'sales_report') {
    const group = SALES_REPORT_GROUPS.find((item) => item === value);
    return group === undefined ? null : (`reports.sales.groups.${group}` as const);
  }
  if (report === 'purchase_report') {
    const group = PURCHASE_REPORT_GROUPS.find((item) => item === value);
    return group === undefined ? null : (`reports.purchases.groups.${group}` as const);
  }
  return null;
}
```

- **`hour()`** writes a whole hour as a clock shows it ("08:00", "০৮:০০") with the app's own `format.time`. The date is
  made in UTC and read in UTC, so no time zone can move the hour. The hour means the workspace's time (decision 8);
  this function only names it.
- **`when()`** turns the contract's union into a sentence. The `switch` covers the three frequencies, and TypeScript
  knows each case's fields: `value.weekday` exists only in the weekly case. `?? 'sunday'` is there because indexing an
  array can give `undefined` in TypeScript's eyes, even though the contract checks 0–6.
- **`report()`** names a kind, or shows the raw string for a kind this app does not know. The API sends `report` as a
  plain string (a newer server's new report must not break an older app), so `isReportKind()` narrows it first.
- **`filterLines()`** gives the lines under a schedule's name: the names the API resolved (`filterNames`), plus "Group
  by" for the sales and purchase reports (decision 58). It takes only `report`, `filters` and `filterNames`, so the
  dialog can call it for a schedule that does not exist yet.
- **`groupByWord()`** checks the kept value against the report's own groups with `find()`. That narrows the string
  without a cast, and a value this app does not know gives no line instead of a broken key.

### The schedule dialog: `components/report-schedule-dialog.tsx` (new)

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  contractErrorMap,
  EXPORT_FORMATS,
  isExportFormat,
  MAX_REPORT_SCHEDULE_RECIPIENTS,
  type ReportExportInput,
  type ReportKind,
  type ReportSchedule,
  reportScheduleFiltersOf,
  REPORT_SCHEDULE_FREQUENCIES,
  reportScheduleUpdateSchema,
  type ReportScheduleWhen,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  CheckboxGroup,
  type CheckboxOption,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  reportScheduleCandidatesQuery,
  SCHEDULE_HOURS,
  useScheduleWords,
  WEEKDAY_KEYS,
} from '../lib/report-schedules';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 21c: the dialog that makes a scheduled report email (from a report's Export menu) or changes
// one (from the scheduled emails page). A lazy chunk: the report pages load it only when someone
// picks "Email on a schedule".

// The names of the page's filters, for the lines the dialog shows. The page knows them from its own
// selects; a saved schedule has them from the API (filterNames). Absent = not set.
export interface ScheduleFilterNames {
  branch?: string | undefined;
  warehouse?: string | undefined;
  group?: string | undefined;
  category?: string | undefined;
}

export type ReportScheduleTarget =
  // A new schedule: the export the page would ask for, with the page's filters and dates. The API
  // keeps only the filters (reportScheduleFiltersOf); the report's own schema checks them.
  | { kind: 'new'; request: ReportExportInput; names: ScheduleFilterNames }
  // A saved one: its report and filters stay (decision 10), so only these fields change
  | { kind: 'edit'; schedule: ReportSchedule; report: ReportKind };

// The aging and the balance sheet show one day: the last of the period (decision 8). satisfies: a
// new report does not compile until someone says which it is.
const SHOWS_ONE_DAY = {
  trial_balance: false,
  profit_and_loss: false,
  balance_sheet: true,
  sales_report: false,
  purchase_report: false,
  ar_aging: true,
  ap_aging: true,
  vat_report: false,
  stock_movement: false,
} as const satisfies Record<ReportKind, boolean>;

const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, index) => index + 1);

// The form is flat: one box per field, whatever the frequency. The contract's `when` is a union
// (a weekly schedule cannot lack its day), so whenOf() builds it from the boxes that frequency
// uses. The numbers come from the selects with valueAsNumber, so they are numbers here.
const scheduleFormSchema = z.object({
  format: z.enum(EXPORT_FORMATS),
  frequency: z.enum(REPORT_SCHEDULE_FREQUENCIES),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  // The contract's own rule: 1 to 10 people, no one twice
  recipientIds: reportScheduleUpdateSchema.shape.recipientIds,
});
type ScheduleForm = z.infer<typeof scheduleFormSchema>;

const FORM_FIELDS = scheduleFormSchema.keyof().options;

function whenOf(values: ScheduleForm): ReportScheduleWhen {
  switch (values.frequency) {
    case 'daily':
      return { frequency: 'daily', hour: values.hour };
    case 'weekly':
      return { frequency: 'weekly', hour: values.hour, weekday: values.weekday };
    case 'monthly':
      return { frequency: 'monthly', hour: values.hour, dayOfMonth: values.dayOfMonth };
  }
}

// What the form opens with. A new schedule: weekly on Sunday at 08:00 (decision 8's defaults),
// Excel, nobody yet. A saved one: its own values; the boxes its frequency does not use keep the
// defaults, so switching to them shows a sensible day. Someone who may not read the report any
// more starts unticked: the API would refuse them (decision 55).
function defaultsOf(target: ReportScheduleTarget): ScheduleForm {
  const blank = {
    format: 'xlsx',
    frequency: 'weekly',
    hour: 8,
    weekday: 0,
    dayOfMonth: 1,
    recipientIds: [],
  } as const satisfies ScheduleForm;
  if (target.kind === 'new') return { ...blank, recipientIds: [] };
  const { schedule } = target;
  const { when } = schedule;
  return {
    format: isExportFormat(schedule.format) ? schedule.format : blank.format,
    frequency: when.frequency,
    hour: when.hour,
    weekday: when.frequency === 'weekly' ? when.weekday : blank.weekday,
    dayOfMonth: when.frequency === 'monthly' ? when.dayOfMonth : blank.dayOfMonth,
    recipientIds: schedule.recipients.filter((item) => item.canReceive).map((item) => item.userId),
  };
}
```

- **`ScheduleFilterNames`** are the names of the page's chosen filters. The query the page sends has only ids
  (decision 59).
- **`ReportScheduleTarget`** is a union. A new schedule carries the export the page would ask for: the report, the
  query with its dates, and a format. The API keeps only the filters of that query (`reportScheduleFiltersOf`), and the
  report's own schema checks them, so the dialog does not need to know each report's filters. A saved schedule
  carries itself and its report, already narrowed to a `ReportKind`.
- **`SHOWS_ONE_DAY`** decides whether the dialog adds "The report shows the last day of that period." It is a
  `Record<ReportKind, boolean>` with `satisfies`: a tenth report does not compile until someone says which it is. The
  contract keeps the same fact (`REPORT_PERIOD_SHAPE`) private, and exporting it only for one hint would make a
  contract change in a screens part.
- **The form is flat.** `when` is a union in the contract: a weekly schedule cannot exist without its day. A form
  with a union is hard to type with React Hook Form, because the fields change with the frequency. So the form has one
  box per field, always, and `whenOf()` builds the union on submit from the boxes that frequency uses. The `switch`
  makes TypeScript check each case: a weekly `when` without `weekday` does not compile.
- **The numbers are numbers.** The selects use `register(…, { valueAsNumber: true })`, so `hour`, `weekday` and
  `dayOfMonth` reach the schema as numbers, and the schema checks their ranges as the contract does.
- **`recipientIds` reuses the contract's rule** (`reportScheduleUpdateSchema.shape.recipientIds`): one to ten people,
  no one twice, with the same error codes. A second copy of the rule here could drift from the API's.
- **`FORM_FIELDS`** tells `applyApiError` which of the server's field paths have a box. A path the form has no box for
  (`when.hour`) becomes the error at the top of the form.
- **`defaultsOf()`**: a new schedule starts weekly on Sunday at 08:00 (decision 8), as Excel, with nobody ticked. A
  saved one starts with its own values. The boxes its frequency does not use keep the defaults, so switching a monthly
  schedule to weekly shows Sunday, not an empty select. Someone who may not read the report now starts unticked
  (decision 55).
- **`as const satisfies ScheduleForm`** on `blank` keeps `'xlsx'` and `'weekly'` as literal types. Without it they
  would widen to `string`, and the object would not be a `ScheduleForm`. The new schedule returns
  `recipientIds: []` again because the `as const` array is `readonly never[]`, and the form wants a mutable
  `string[]`.

```tsx
function ScheduleForm({ target, onDone }: { target: ReportScheduleTarget; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const queryClient = useQueryClient();
  const words = useScheduleWords();
  const report = target.kind === 'new' ? target.request.report : target.report;
  const candidates = useQuery(reportScheduleCandidatesQuery(tenantId, report));

  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(scheduleFormSchema, { error: contractErrorMap }),
    defaultValues: defaultsOf(target),
  });
  const frequency = watch('frequency');

  // The filter lines: a new schedule's from the page (its query and its selects' names), a saved
  // one's from the API. The same function as the list, so the two always say the same thing.
  const filterLines =
    target.kind === 'new'
      ? words.filterLines({
          report,
          filters: reportScheduleFiltersOf(target.request.query),
          filterNames: {
            branch: target.names.branch ?? null,
            warehouse: target.names.warehouse ?? null,
            group: target.names.group ?? null,
            category: target.names.category ?? null,
          },
        })
      : words.filterLines(target.schedule);

  // The people to pick from. On a saved schedule, someone on it who may not read the report now
  // is still listed, disabled and unticked, with why: so the editor sees who stops getting it.
  const recipientOptions: CheckboxOption[] = [
    ...(candidates.data?.items ?? []).map((person) => ({
      value: person.userId,
      label: (
        <span className="grid">
          <span className="font-medium text-ink">{person.name}</span>
          <span className="text-caption text-ink-3">{person.email}</span>
        </span>
      ),
    })),
    ...(target.kind === 'edit'
      ? target.schedule.recipients
          .filter((person) => !person.canReceive)
          .map((person) => ({
            value: person.userId,
            disabled: true,
            label: (
              <span className="grid">
                <span className="font-medium text-ink-2">{person.name}</span>
                <span className="text-caption text-ink-3">{person.email}</span>
                <span className="mt-0.5 flex items-center gap-1 text-caption font-medium text-warn">
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    size={13}
                    strokeWidth={1.5}
                    className="shrink-0"
                  />
                  {t('reportSchedules.cannotReceive')}
                </span>
              </span>
            ),
          }))
      : []),
  ];
  // Nobody may read the report: the form says where to fix that, and has nothing to save
  const nobody = candidates.isSuccess && candidates.data.items.length === 0;

  const onSubmit = handleSubmit(async (values) => {
    const when = whenOf(values);
    try {
      const saved =
        target.kind === 'new'
          ? await call(routes.reportSchedules.create, {
              body: {
                ...target.request,
                format: values.format,
                when,
                recipientIds: values.recipientIds,
              },
            })
          : await call(routes.reportSchedules.update, {
              params: { id: target.schedule.id },
              body: {
                format: values.format,
                when,
                recipientIds: values.recipientIds,
                version: target.schedule.version,
              },
            });
      await queryClient.invalidateQueries({ queryKey: ['report-schedules', tenantId] });
      const name = words.report(report);
      toast(
        target.kind === 'new'
          ? t('reportSchedules.created', {
              report: name,
              // A new schedule is active, so it has its first run
              date:
                saved.nextRunAt === null
                  ? ''
                  : format.dateTime(new Date(saved.nextRunAt), timeZone),
            })
          : t('reportSchedules.updated', { report: name }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, FORM_FIELDS, setError);
    }
  });

  const name = words.report(report);
  const periodHint = [
    t(`reportSchedules.periods.${frequency}`),
    SHOWS_ONE_DAY[report] && t('reportSchedules.asOfHint'),
    t('reportSchedules.hourHint', { timeZone }),
  ]
    .filter((line) => line !== false)
    .join(' ');
```

- **The candidates are asked for at once.** The query runs as the dialog opens, so the list is usually there by the
  time the person reaches it.
- **`watch('frequency')`** re-renders the form when the frequency changes, so the right day box shows.
- **`filterLines`**: the same function as the list (decision 58). For a new schedule, the filters come from the page's
  query through `reportScheduleFiltersOf()`, the API's own function, so the dialog leaves out the dates and compare
  dates exactly as the API will.
- **`recipientOptions`**: the candidates, then (only when editing) the people on the schedule who may not read the
  report now, disabled, with the `warn` line. They are never ticked: the form's default left them out.
- **`nobody`** is true when the server answered and nobody may read the report. The form then shows `noCandidates`
  (where to fix it) and no save button: there is nothing it could save.
- **The body of a new schedule** spreads the page's export (`report`, `query`) and replaces `format` with the form's.
  TypeScript checks the result against the contract's intersection type: a report with the wrong query does not
  compile.
- **The update** sends `version`. If someone changed the schedule after the list was loaded, the API refuses with
  `version_conflict`, which shows at the top of the form, instead of overwriting their change.
- **After saving**, the list's prefix is invalidated, then the toast. The new schedule's toast names its first email
  in the workspace's time zone; `nextRunAt` is `null` only for a paused schedule, which a new one never is.
- **`periodHint`** joins the sentences that apply: what each email holds, the "last day" line for an aging or a
  balance sheet, and the time zone. `filter((line) => line !== false)` drops the `false` that `&&` gives when the line
  does not apply, and narrows the array to strings.

```tsx
  return (
    <DialogContent
      title={
        target.kind === 'new'
          ? t('reportSchedules.newTitle', { report: name })
          : t('reportSchedules.editTitle', { report: name })
      }
      description={t('reportSchedules.newDescription')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          {!nobody && (
            <Button type="submit" form="report-schedule-form" disabled={isSubmitting}>
              {isSubmitting
                ? t('common.saving')
                : target.kind === 'new'
                  ? t('reportSchedules.create')
                  : t('reportSchedules.save')}
            </Button>
          )}
        </>
      }
    >
      <form
        id="report-schedule-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* The filters are shown, never edited (decision 10) */}
        <div className="grid gap-1.5">
          <span className="text-label font-medium text-ink">{t('reportSchedules.filters')}</span>
          <ul className="grid gap-0.5 rounded-control bg-subtle px-3.5 py-3 text-body-sm text-ink-2">
            {filterLines.length === 0 ? (
              <li>{t('reportSchedules.noFilters')}</li>
            ) : (
              filterLines.map((line) => <li key={line}>{line}</li>)
            )}
          </ul>
          <p className="text-label text-ink-3">
            {target.kind === 'new'
              ? t('reportSchedules.filtersHint')
              : t('reportSchedules.fixedHint')}
          </p>
        </div>
        <SelectField
          label={t('reportSchedules.format')}
          options={EXPORT_FORMATS.map((value) => ({
            value,
            label: t(`reports.export.${value}`),
          }))}
          {...register('format')}
          error={errors.format?.message}
        />
        <div className="grid gap-1.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.2fr_1fr_0.8fr]">
            <SelectField
              label={t('reportSchedules.frequency')}
              options={REPORT_SCHEDULE_FREQUENCIES.map((value) => ({
                value,
                label: t(`reportSchedules.frequencies.${value}`),
              }))}
              {...register('frequency')}
            />
            {/* Only the box the frequency uses: daily needs no day */}
            {frequency === 'weekly' && (
              <SelectField
                label={t('reportSchedules.weekday')}
                options={WEEKDAY_KEYS.map((key, index) => ({
                  value: String(index),
                  label: t(`reportSchedules.weekdays.${key}`),
                }))}
                {...register('weekday', { valueAsNumber: true })}
              />
            )}
            {frequency === 'monthly' && (
              <SelectField
                label={t('reportSchedules.dayOfMonth')}
                options={DAYS_OF_MONTH.map((day) => ({
                  value: String(day),
                  label: format.number(day),
                }))}
                {...register('dayOfMonth', { valueAsNumber: true })}
              />
            )}
            <SelectField
              label={t('reportSchedules.hour')}
              options={SCHEDULE_HOURS.map((hour) => ({
                value: String(hour),
                label: words.hour(hour),
              }))}
              {...register('hour', { valueAsNumber: true })}
            />
          </div>
          <p className="text-label text-ink-3">
            {periodHint}
            {frequency === 'monthly' && ` ${t('reportSchedules.dayOfMonthHint')}`}
          </p>
        </div>
        {nobody ? (
          <p className="text-body-sm text-ink-2">{t('reportSchedules.noCandidates')}</p>
        ) : (
          candidates.isSuccess && (
            <Controller
              control={control}
              name="recipientIds"
              render={({ field }) => (
                <CheckboxGroup
                  legend={t('reportSchedules.recipients')}
                  options={recipientOptions}
                  value={field.value}
                  onChange={field.onChange}
                  hint={t('reportSchedules.recipientsHint', {
                    count: MAX_REPORT_SCHEDULE_RECIPIENTS,
                  })}
                  error={errors.recipientIds?.message}
                />
              )}
            />
          )
        )}
        {candidates.isError && <FormAlert message="unknown_error" />}
      </form>
    </DialogContent>
  );
}
```

- **The filters are a list on `subtle`, never boxes** (decision 10). "None" when the page has no filter.
- **The submit button is outside the form**, in the dialog's footer, so it points at the form with `form=`. This is
  the pattern of the device dialogs.
- **The frequency row** is three columns from `sm` and one column on a phone. Only the box the frequency uses shows:
  daily has no day.
- **The checkbox group** is wrapped in a `Controller`: `CheckboxGroup` takes `value` and `onChange`, not a `ref`.
- **The group shows only when the candidates have loaded.** Before that, an empty group would look like "nobody may
  read this report".

```tsx
// The dialog itself. Closing it any way drops what was typed: the next open starts again.
export function ReportScheduleDialog({
  target,
  onClose,
}: {
  target: ReportScheduleTarget;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ScheduleForm target={target} onDone={onClose} />
    </Dialog>
  );
}
```

The dialog is always open while it is rendered. The parent renders it when needed and removes it on close, so every
open starts with a fresh form.

### The Export menu: `components/report-parts.tsx`

```diff
@@ -3,6 +3,7 @@ import {
   ArrowDown01Icon,
   CheckmarkCircle02Icon,
   FileDownloadIcon,
+  MailSend01Icon,
   Pdf01Icon,
   Xls01Icon,
 } from '@hugeicons/core-free-icons';
@@ -22,6 +23,7 @@ import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
+  DropdownMenuSeparator,
   DropdownMenuTrigger,
   Field,
   Pill,
@@ -30,13 +32,15 @@ import {
 } from '@omnivo/ui';
 import { useMutation, useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
-import { type ReactNode, useState } from 'react';
+import { lazy, type ReactNode, Suspense, useState } from 'react';
 
 import { call } from '../lib/api';
 import { balanceSide } from '../lib/journal';
+import { useCan } from '../lib/permissions';
 import { type DateRange, PERIOD_PRESETS, type PeriodPreset, presetRange } from '../lib/reports';
 import { useSession } from '../lib/session-store';
 import { failureOf } from './journal-parts';
+import type { ScheduleFilterNames } from './report-schedule-dialog';
 import { useAmount, useReportCalendar } from './report-hooks';
 
 // Step 15c: the two hooks live in report-hooks.ts; the report pages still import them from here
@@ -122,12 +126,37 @@ export function PeriodFields({
   );
 }
 
+// Step 21c: a branch as the report pages' selects name it ("DHK · Dhaka HQ"), for the schedule
+// dialog's lines. undefined when no branch is chosen ('' = every branch).
+export function branchName(
+  branches: readonly { id: string; code: string; name: string }[] | undefined,
+  id: string,
+): string | undefined {
+  const branch = branches?.find((item) => item.id === id);
+  return branch && `${branch.code} · ${branch.name}`;
+}
+
+// Step 21c: the schedule dialog is its own chunk, loaded the first time someone opens it
+const ReportScheduleDialog = lazy(async () => ({
+  default: (await import('./report-schedule-dialog')).ReportScheduleDialog,
+}));
+
 // Export → Excel or PDF. The click only asks; the worker writes the file and the bell says when
-// it is ready, so a large report never holds the page.
-export function ExportMenu({ request }: { request: (format: ExportFormat) => ReportExportInput }) {
+// it is ready, so a large report never holds the page. Step 21c: then "Email on a schedule", for
+// people with core.report.schedule. `names` are the names of the page's chosen filters, for the
+// dialog's lines (the query has only their ids).
+export function ExportMenu({
+  request,
+  names = {},
+}: {
+  request: (format: ExportFormat) => ReportExportInput;
+  names?: ScheduleFilterNames;
+}) {
   const { t, errorText } = useLocale();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const queryClient = useQueryClient();
+  const can = useCan();
+  const [scheduling, setScheduling] = useState(false);
   const create = useMutation({
     mutationFn: (format: ExportFormat) =>
       call(routes.reportExports.create, { body: request(format) }),
@@ -140,38 +169,66 @@ export function ExportMenu({ request }: { request: (format: ExportFormat) => Rep
     },
   });
   return (
-    <DropdownMenu>
-      <DropdownMenuTrigger asChild>
-        <Button variant="secondary" disabled={create.isPending}>
-          <HugeiconsIcon icon={FileDownloadIcon} size={17} strokeWidth={1.5} />
-          {t('reports.export.button')}
-          <HugeiconsIcon
-            icon={ArrowDown01Icon}
-            size={16}
-            strokeWidth={1.5}
-            className="text-ink-3"
+    <>
+      <DropdownMenu>
+        <DropdownMenuTrigger asChild>
+          <Button variant="secondary" disabled={create.isPending}>
+            <HugeiconsIcon icon={FileDownloadIcon} size={17} strokeWidth={1.5} />
+            {t('reports.export.button')}
+            <HugeiconsIcon
+              icon={ArrowDown01Icon}
+              size={16}
+              strokeWidth={1.5}
+              className="text-ink-3"
+            />
+          </Button>
+        </DropdownMenuTrigger>
+        <DropdownMenuContent align="end">
+          <DropdownMenuItem
+            icon={Xls01Icon}
+            onSelect={() => {
+              create.mutate('xlsx');
+            }}
+          >
+            {t('reports.export.xlsx')}
+          </DropdownMenuItem>
+          <DropdownMenuItem
+            icon={Pdf01Icon}
+            onSelect={() => {
+              create.mutate('pdf');
+            }}
+          >
+            {t('reports.export.pdf')}
+          </DropdownMenuItem>
+          {can('core.report.schedule') && (
+            <>
+              <DropdownMenuSeparator />
+              <DropdownMenuItem
+                icon={MailSend01Icon}
+                onSelect={() => {
+                  setScheduling(true);
+                }}
+              >
+                {t('reports.export.schedule')}
+              </DropdownMenuItem>
+            </>
+          )}
+        </DropdownMenuContent>
+      </DropdownMenu>
+      {/* Outside the menu, like the device lists' dialogs: the menu closes first and gives the
+          focus back, then the dialog takes it */}
+      {scheduling && (
+        <Suspense fallback={null}>
+          <ReportScheduleDialog
+            // The export the page asks for now; the dialog sends its own format instead
+            target={{ kind: 'new', request: request('xlsx'), names }}
+            onClose={() => {
+              setScheduling(false);
+            }}
           />
-        </Button>
-      </DropdownMenuTrigger>
-      <DropdownMenuContent align="end">
-        <DropdownMenuItem
-          icon={Xls01Icon}
-          onSelect={() => {
-            create.mutate('xlsx');
-          }}
-        >
-          {t('reports.export.xlsx')}
-        </DropdownMenuItem>
-        <DropdownMenuItem
-          icon={Pdf01Icon}
-          onSelect={() => {
-            create.mutate('pdf');
-          }}
-        >
-          {t('reports.export.pdf')}
-        </DropdownMenuItem>
-      </DropdownMenuContent>
-    </DropdownMenu>
+        </Suspense>
+      )}
+    </>
   );
 }
 
```

- **`branchName()`** writes a branch as the report pages' selects do ("DHK · Dhaka HQ"), or `undefined` when none is
  chosen. Four pages pass a branch, so the format is in one place.
- **The dialog is `lazy()`.** Every report page has this menu; the dialog and its form library load only when someone
  picks the item.
- **The item shows only with `core.report.schedule`.** The API checks it too; hiding it saves a dialog that could only
  fail.
- **`request('xlsx')`** gives the dialog the page's report and query. The format is a placeholder; the dialog sends the
  one the person picks.
- **The dialog is outside `<DropdownMenu>`** (decision 59). Radix's menu gives the focus back to its button as it
  closes; a dialog opened inside the menu's tree would fight it for the focus.

### The books' line: `components/trade-report-parts.tsx`

```diff
@@ -22,11 +22,15 @@ export function BooksLine({
   report,
   books,
   noBooks,
+  inBooks,
 }: {
   // What the report adds up to, in the same sense as the books (net sales, or the balance)
   report: string;
   books: string | null;
   noBooks: string;
+  // Step 21c: the words beside the pill. The VAT page has a line per side, each with its own words
+  // and with paisa; the 21b reports keep "In the books: ৳39,19,000".
+  inBooks?: ((books: string) => string) | undefined;
 }) {
   const { t, format } = useLocale();
   if (books === null) {
@@ -56,7 +60,7 @@ export function BooksLine({
         </Pill>
       )}
       <span className="text-label font-normal text-ink-3 tabular-nums">
-        {t('reports.inBooks', { amount: format.money(books) })}
+        {inBooks ? inBooks(books) : t('reports.inBooks', { amount: format.money(books) })}
       </span>
     </div>
   );
```

`inBooks` is optional (decision 61). The four 21b reports do not pass it and keep their line as it was.

### The queries: `lib/trade-report-queries.ts`

```diff
@@ -5,6 +5,9 @@ import {
   type PurchaseReportFilter,
   routes,
   type SalesReportFilter,
+  type StockMovementFilter,
+  type VatReportFilter,
+  type VatReportSide,
 } from '@omnivo/contracts';
 import type { SortingState } from '@omnivo/ui';
 import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
@@ -75,6 +78,44 @@ export function apAgingQuery(tenantId: string, filter: ApAgingFilter) {
   });
 }
 
+// Step 21c: the VAT report's summary (one answer: a few rates) and its documents, one side at a
+// time, paged. Under 'journal' like the rest: posting an invoice or a bill moves the VAT.
+export function vatReportQuery(tenantId: string, filter: VatReportFilter) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'vat-report', filter],
+    queryFn: () => call(routes.vatReport.summary, { query: filter }),
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function vatDocumentsQuery(tenantId: string, filter: VatReportFilter, side: VatReportSide) {
+  return infiniteQueryOptions({
+    queryKey: ['journal', tenantId, 'vat-report', 'documents', side, filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.vatReport.documents, {
+        query: { ...filter, side, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// Step 21c: the stock movement report. Every stock document writes a journal entry (step 14), so
+// the 'journal' prefix refreshes it after a delivery, a receipt or an adjustment too.
+export function stockMovementQuery(tenantId: string, filter: StockMovementFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['journal', tenantId, 'stock-movement', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stockMovementReport.report, {
+        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
 // One party's page is not paged (the contract's agingPartyShape): a party's open documents fit
 export function arAgingPartyQuery(tenantId: string, customerId: string, query: AgingPartyQuery) {
   return queryOptions({
```

- **Every key starts with `['journal', tenantId]`**, like the 21b reports. Posting an invoice, a bill or a stock
  document invalidates that prefix (`useStockRefresh` in `stock-parts.tsx` does it for stock), so an open report asks
  again.
- **The summary is one answer** (`queryOptions`): a few rates. The documents and the stock rows are paged
  (`infiniteQueryOptions`), 50 rows at a time.
- **The side is in the documents' key**, so Output and Input are cached apart, and switching back is instant.
- **`placeholderData: keepPreviousData`** keeps the old numbers on screen until the new filter's answer arrives,
  instead of an empty page that jumps.

### The VAT report: `routes/vat-report.tsx` (new)

```tsx
import { Alert02Icon, TaxesIcon } from '@hugeicons/core-free-icons';
import {
  absMoney,
  isNegativeMoney,
  isVatDocumentKind,
  isZeroMoney,
  type VatDocument,
  type VatReportFilter,
  type VatReportRow,
  type VatReportTotals,
  type VatReportSide,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  cn,
  DataTable,
  dataTableColumns,
  EmptyState,
  KpiStrip,
  PageHeader,
  parseIsoDate,
  Pill,
  SectionHeader,
  SegmentedControl,
  SelectField,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { branchName, ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { branchesQuery } from '../lib/queries';
import { plainRate } from '../lib/tax-rates';
import { vatDocumentsQuery, vatReportQuery } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 21c: the VAT report. The VAT charged and paid in a period by rate, what the books say beside
// it, and the documents behind it. It helps fill in Mushak 9.1; it is not the return.
//
// Every amount has paisa (decision 54): the accountant copies these numbers into the return, and
// whole taka would make the rows stop adding up to the total.

const column = dataTableColumns<VatDocument>();

// The VAT report's money: always 2 decimals
function useVatMoney() {
  const { format } = useLocale();
  return useCallback((value: string) => format.money(value, { decimals: 2 }), [format]);
}

// The number of a document, as a link to its page. One Link per kind: each path has its own
// parameter name, and TanStack checks each pair against the router. A kind this app does not
// know (a newer server) is the number alone.
function DocumentLink({ document }: { document: VatDocument }) {
  const className = 'font-mono font-medium text-brand underline-offset-3 hover:underline';
  const { kind, id, number } = document;
  if (!isVatDocumentKind(kind)) return <span className="font-mono">{number}</span>;
  switch (kind) {
    case 'invoice':
      return (
        <Link to="/invoices/$invoiceId" params={{ invoiceId: id }} className={className}>
          {number}
        </Link>
      );
    case 'pos_sale':
      return (
        <Link to="/pos/sales/$saleId" params={{ saleId: id }} className={className}>
          {number}
        </Link>
      );
    case 'credit_note':
      return (
        <Link to="/credit-notes/$creditNoteId" params={{ creditNoteId: id }} className={className}>
          {number}
        </Link>
      );
    case 'pos_return':
      return (
        <Link to="/pos/returns/$returnId" params={{ returnId: id }} className={className}>
          {number}
        </Link>
      );
    case 'bill':
      return (
        <Link to="/bills/$billId" params={{ billId: id }} className={className}>
          {number}
        </Link>
      );
    case 'debit_note':
      return (
        <Link to="/debit-notes/$debitNoteId" params={{ debitNoteId: id }} className={className}>
          {number}
        </Link>
      );
  }
}

// Net VAT in the table: below zero it is VAT to carry forward, said in words, never a bare minus
// (decision 53)
function useNetVat() {
  const { t } = useLocale();
  const money = useVatMoney();
  return useCallback(
    (value: string) =>
      isNegativeMoney(value)
        ? t('reports.vat.carry', { amount: money(absMoney(value)) })
        : money(value),
    [t, money],
  );
}
```

- **`useVatMoney()`**: every amount on this page with paisa (decision 54), in one place.
- **`DocumentLink`** has one `<Link>` per kind. Each document's path has its own parameter name (`invoiceId`,
  `saleId`, …), and TanStack Router checks each `to`/`params` pair against the router, so one generic link would need a
  cast. The `switch` on the narrowed kind is exhaustive: a seventh kind does not compile until it has a link. A kind
  this app does not know shows its number without a link.
- **`useNetVat()`** is decision 53 for the table: below zero it says "৳3,530.00 to carry forward".

```tsx
// The rates: a real table in a card, like the statements (decision 56). One to eight rows, so no
// sorting and no paging; the total is the table's own <tfoot>. On a phone it scrolls sideways
// inside its card, with the rate column sticky.
// The five amounts a rate's row and the total row share
type VatAmounts = Pick<
  VatReportTotals,
  'outputNet' | 'outputVat' | 'inputNet' | 'inputVat' | 'netVat'
>;

function RatesTable({ rows, totals }: { rows: VatReportRow[]; totals: VatAmounts }) {
  const { t, format } = useLocale();
  const money = useVatMoney();
  const netVat = useNetVat();
  const sticky = 'sticky left-0 z-[1]';
  // "15.00" → "15", "7.50" → "7.5", with Bangla digits in Bangla (the tax rates' own rule)
  const percentOf = (rate: string) => {
    const plain = plainRate(rate);
    return format.number(plain, plain.split('.')[1]?.length ?? 0);
  };
  const headers = [
    t('reports.vat.columns.outputNet'),
    t('reports.vat.columns.outputVat'),
    t('reports.vat.columns.inputNet'),
    t('reports.vat.columns.inputVat'),
    t('reports.vat.columns.netVat'),
  ];
  const cells = (row: VatAmounts, strong: boolean) =>
    [row.outputNet, row.outputVat, row.inputNet, row.inputVat].map((value, index) => (
      <td
        key={index}
        className={cn(
          'min-w-[8.5rem] px-4 py-2.5 text-right text-body-sm whitespace-nowrap tabular-nums sm:px-5',
          strong ? 'font-medium text-ink' : 'text-ink-2',
        )}
      >
        {money(value)}
      </td>
    ));
  const net = (value: string) => (
    <td className="min-w-[8.5rem] px-4 py-2.5 text-right text-body-sm font-medium whitespace-nowrap text-ink tabular-nums sm:px-5">
      {netVat(value)}
    </td>
  );
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
      <table className="w-full border-collapse">
        <caption className="sr-only">{t('reports.vat.title')}</caption>
        <thead>
          <tr className="bg-subtle">
            <th
              scope="col"
              className={cn(
                sticky,
                'bg-subtle py-2.5 pr-4 pl-5 text-left text-caption font-medium text-ink-3',
              )}
            >
              {t('reports.vat.columns.rate')}
            </th>
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                className="px-5 py-2.5 text-right text-caption font-medium whitespace-nowrap text-ink-3"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line bg-surface">
              <th
                scope="row"
                className={cn(
                  sticky,
                  'min-w-[10rem] bg-surface py-2.5 pr-4 pl-5 text-left text-body-sm font-medium whitespace-nowrap text-ink sm:min-w-[12rem]',
                )}
              >
                {/* "VAT 15% · 15%", and the kind under it: zero-rated and exempt are both 0% */}
                {t('reports.vat.rate', { name: row.name, percent: percentOf(row.rate) })}
                <span className="block text-caption font-normal text-ink-3">
                  {t(`taxRates.kinds.${row.kind}`)}
                </span>
              </th>
              {cells(row, false)}
              {net(row.netVat)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-subtle">
            <th
              scope="row"
              className={cn(
                sticky,
                'bg-subtle py-2.5 pr-4 pl-5 text-left text-body-sm font-medium text-ink',
              )}
            >
              {t('reports.total')}
            </th>
            {cells(totals, true)}
            {net(totals.netVat)}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
```

- **A plain table** (decision 56), with the statements' classes: a sticky first column, `min-w` on the amounts so a
  phone scrolls the table inside its card instead of squeezing it, `tabular-nums` and `whitespace-nowrap` on amounts.
- **`VatAmounts`** is the five amounts a rate's row and the total share, picked from the contract's types. The total
  row then takes `totals` as it comes, without inventing a fake rate.
- **`percentOf()`** uses `plainRate()` from `lib/tax-rates.ts`: "15.00" becomes "15", "7.50" becomes "7.5", in Bangla
  digits in Bangla. That is how the tax rates page writes a rate, so the two pages agree.
- **The kind is under the name** ("Standard", "Zero-rated"), because zero-rated and exempt are both 0%, and they are
  different lines of the return.

```tsx
export function VatReportPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const can = useCan();
  const canRead = can('accounting.report.read');
  const online = useOnline();
  const money = useVatMoney();
  // Decision 3: last month by default, the month a return is filed for
  const period = usePeriod('last_month');
  const [branchId, setBranchId] = useState('');
  const [side, setSide] = useState<VatReportSide>('output');

  const filter: VatReportFilter = {
    from: period.range.from,
    to: period.range.to,
    ...(branchId !== '' && { branchId }),
  };
  const enabled = canRead && online && period.valid;
  const report = useQuery({ ...vatReportQuery(tenantId, filter), enabled });
  const documents = useInfiniteQuery({ ...vatDocumentsQuery(tenantId, filter, side), enabled });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;

  const rows = useMemo(() => documents.data?.pages.flatMap((page) => page.items), [documents.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = documents;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          // Not sortable (decision 18): the server sends them oldest first, and without this the
          // DataTable would sort in the browser, only the pages loaded so far
          enableSorting: false,
          header: t('reports.vat.documents.columns.number'),
          meta: { card: 'title' },
          cell: ({ row }) => {
            const { kind } = row.original;
            return (
              <span className="grid whitespace-nowrap">
                <DocumentLink document={row.original} />
                <span className="text-caption text-ink-3">
                  {isVatDocumentKind(kind) ? t(`reports.vat.documents.kinds.${kind}`) : kind}
                </span>
              </span>
            );
          },
        }),
        column.accessor('date', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.date'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = parseIsoDate(getValue());
            return (
              <span className="whitespace-nowrap tabular-nums">
                {date ? format.date(date) : getValue()}
              </span>
            );
          },
        }),
        column.accessor('partyName', {
          enableSorting: false,
          header:
            side === 'output'
              ? t('reports.vat.documents.columns.customer')
              : t('reports.vat.documents.columns.supplier'),
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => {
            const name = getValue();
            // A POS sale or return with no customer
            return name === null ? (
              t('reports.vat.documents.walkIn')
            ) : (
              <span className="font-medium text-ink">{name}</span>
            );
          },
        }),
        column.accessor('partyBin', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.bin'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const bin = getValue();
            return bin === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-mono whitespace-nowrap tabular-nums">{bin}</span>
            );
          },
        }),
        // The input side only: a bill's and a debit note's own VAT document. A bill without its
        // Mushak 6.3 gets a warn pill: its input VAT is the one to check (decision 2).
        ...(side === 'input'
          ? [
              column.accessor('mushakNumber', {
                enableSorting: false,
                header: t('reports.vat.documents.columns.mushak'),
                meta: { card: 'detail' },
                cell: ({ row }) => {
                  const { mushakNumber, kind } = row.original;
                  if (mushakNumber !== null) {
                    return (
                      <span className="font-mono whitespace-nowrap tabular-nums">
                        {mushakNumber}
                      </span>
                    );
                  }
                  return kind === 'bill' ? (
                    <Pill tone="warn" icon={Alert02Icon}>
                      {t('reports.vat.documents.noMushak')}
                    </Pill>
                  ) : (
                    <span className="text-ink-3">—</span>
                  );
                },
              }),
            ]
          : []),
        column.accessor('net', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.net'),
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => money(getValue()),
        }),
        column.accessor('vat', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.vat'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium text-ink">{money(getValue())}</span>,
        }),
      ]),
    [t, format, money, side],
  );
```

- **`usePeriod('last_month')`** (decision 60).
- **One `enabled`** for both queries: a person without the permission, offline, or with "To" before "From" asks for
  nothing.
- **The columns depend on the side.** The party column's header says Customer or Supplier, and the input side adds
  the Mushak number. On a bill without its Mushak 6.3, a `warn` pill says so (decision 2). A debit note without a
  Mushak 6.7 gets a dash: decision 2 is about the bills.
- **`getRowId`** is `kind:id`. A credit note and an invoice are in different tables and could share an id in theory;
  the kind makes the row's key unique.

```tsx
  const header = (
    <PageHeader
      title={t('reports.vat.title')}
      description={t('reports.vat.description')}
      actions={
        canRead &&
        online &&
        period.valid && (
          <ExportMenu
            request={(exportFormat) => ({
              report: 'vat_report',
              format: exportFormat,
              query: filter,
            })}
            names={{ branch: branchName(branches, branchId) }}
          />
        )
      }
    />
  );

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      </div>
    );
  }

  const answer = report.data;
  const totals = answer?.totals;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
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
              label={t('reports.branch')}
              value={branchId}
              options={[
                { value: '', label: t('reports.allBranches') },
                ...(branches ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.code} · ${item.name}`,
                })),
              ]}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={TaxesIcon} onRetry={() => void report.refetch()} />
          ) : (
            answer &&
            totals &&
            (answer.rows.length === 0 ? (
              <EmptyState
                icon={TaxesIcon}
                title={t('reports.vat.emptyTitle')}
                description={t('reports.vat.emptyBody')}
              />
            ) : (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.vat.kpis.output'),
                      value: money(totals.outputVat),
                      sub: t('reports.vat.kpiHints.outputReturned', {
                        amount: money(totals.outputVatReturned),
                      }),
                    },
                    {
                      label: t('reports.vat.kpis.input'),
                      value: money(totals.inputVat),
                      sub: t('reports.vat.kpiHints.inputReturned', {
                        amount: money(totals.inputVatReturned),
                      }),
                      // Decision 2: only when some bill lacks its Mushak 6.3. A flat change line:
                      // it says something to look at, not a rise or a fall.
                      change: isZeroMoney(totals.inputVatWithoutMushak)
                        ? undefined
                        : {
                            trend: 'flat',
                            text: t('reports.vat.kpiHints.withoutMushak', {
                              amount: money(totals.inputVatWithoutMushak),
                            }),
                          },
                    },
                    {
                      label: t('reports.vat.kpis.net'),
                      // Without its sign: the words under it say which way (decision 53)
                      value: money(absMoney(totals.netVat)),
                      sub: isZeroMoney(totals.netVat)
                        ? t('reports.vat.kpiHints.nothing')
                        : isNegativeMoney(totals.netVat)
                          ? t('reports.vat.kpiHints.carryForward')
                          : t('reports.vat.kpiHints.payable'),
                    },
                  ]}
                />
                {/* One line per side, each with its own pill: the two accounts can differ apart */}
                <div className="grid gap-1.5">
                  <BooksLine
                    report={totals.outputVat}
                    books={answer.books.output}
                    noBooks=""
                    inBooks={(books) => t('reports.vat.inBooksOutput', { amount: money(books) })}
                  />
                  <BooksLine
                    report={totals.inputVat}
                    books={answer.books.input}
                    noBooks=""
                    inBooks={(books) => t('reports.vat.inBooksInput', { amount: money(books) })}
                  />
                </div>
                <RatesTable rows={answer.rows} totals={totals} />
                <Footnotes notes={[t('reports.vat.notReturn'), t('reports.vat.booksHint')]} />
              </>
            ))
          )}
          {answer && answer.rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <SectionHeader
                  title={t('reports.vat.documents.title')}
                  subtitle={t('reports.vat.documents.subtitle')}
                />
                <SegmentedControl<VatReportSide>
                  label={t('reports.vat.documents.title')}
                  value={side}
                  options={[
                    { value: 'output', label: t('reports.vat.documents.sides.output') },
                    { value: 'input', label: t('reports.vat.documents.sides.input') },
                  ]}
                  onChange={setSide}
                />
              </div>
              {documents.isError ? (
                <LoadFailed icon={TaxesIcon} onRetry={() => void documents.refetch()} />
              ) : (
                rows && (
                  <DataTable
                    label={t('reports.vat.documents.title')}
                    data={rows}
                    columns={columns}
                    getRowId={(item) => `${item.kind}:${item.id}`}
                    onEndReached={loadMore}
                    empty={
                      <EmptyState
                        icon={TaxesIcon}
                        title={t('reports.vat.documents.title')}
                        description={
                          side === 'output'
                            ? t('reports.vat.documents.emptyOutput')
                            : t('reports.vat.documents.emptyInput')
                        }
                      />
                    }
                    footer={
                      isFetchingNextPage && (
                        <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                      )
                    }
                  />
                )
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
```

- **The Export menu** shows only when the page could export: with the permission, online and with a valid period.
- **No VAT in the dates** is the empty state. The documents section then hides too: it could only be empty.
- **The KPI strip**: the input cell's line about bills with no Mushak 6.3 uses the strip's `change` slot with a `flat`
  trend (12px, `ink-3`, no arrow). It shows only when that amount is not zero.
- **Net VAT** is shown without its sign, with "To pay", "To carry forward" or "Nothing to pay" under it (decision 53).
- **Two books' lines**, one per side, each with its own pill. `noBooks` is empty: the VAT report always has books to
  compare with.
- **The documents' control** is a `SegmentedControl` on the right of the section header; it wraps under the title on a
  phone.

### The stock movement report: `routes/stock-movement-report.tsx` (new)

```tsx
import { PackageMovingIcon } from '@hugeicons/core-free-icons';
import {
  isZeroMoney,
  STOCK_MOVEMENT_SHOWS,
  STOCK_MOVEMENT_SORTS,
  type StockMovementFilter,
  type StockMovementRow,
  type StockMovementShow,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  EmptyState,
  KpiStrip,
  PageHeader,
  SelectField,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import { Footnotes, LoadFailed, NameTile, NeedsConnection } from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { productCategoriesQuery, warehousesQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { sortingOf, sortOf, stockMovementQuery } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 21c: the stock movement report. One row per variant, in its base unit: what it opened with,
// what came in and went out, and what it closed with. The quantities never add up to a total (40
// pcs and 2.74 m are not one number), so the strip counts the products instead, and the values
// (with inventory.stock.value) are the only totals.

const column = dataTableColumns<StockMovementRow>();

// The four columns between opening and closing, in the contract's order
const MOVEMENT_COLUMNS = ['purchased', 'sold', 'transfers', 'adjusted'] as const;

export function StockMovementReportPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const can = useCan();
  const canRead = can('inventory.report.read');
  const online = useOnline();
  const period = usePeriod('this_month');
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [show, setShow] = useState<StockMovementShow>('moved');
  const [sorting, setSorting] = useState<SortingState>(sortingOf('name'));

  // Without the value permission the API refuses a value sort (its order would tell the hidden
  // number), so the page never asks for one
  const canSeeValue = can('inventory.stock.value');
  const sort = sortOf(
    sorting.filter((item) => canSeeValue || !['openingValue', 'closingValue'].includes(item.id)),
    STOCK_MOVEMENT_SORTS,
    'name',
  );
  const filter: StockMovementFilter = {
    from: period.range.from,
    to: period.range.to,
    show,
    sort,
    ...(warehouseId !== '' && { warehouseId }),
    ...(categoryId !== '' && { categoryId }),
  };

  const report = useInfiniteQuery({
    ...stockMovementQuery(tenantId, filter),
    enabled: canRead && online && period.valid,
  });
  const warehouses = useQuery({ ...warehousesQuery(tenantId, 'active'), enabled: canRead }).data;
  const categories = useQuery({ ...productCategoriesQuery(tenantId), enabled: canRead }).data;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // From the answer, not the permission: the columns are right even before the first rows
  const withValue = first?.withValue ?? false;
```

- **`usePeriod('this_month')`** (decision 60).
- **The value sort is dropped without the value permission.** The API refuses it (the order of the rows would tell
  the hidden values), so the page never asks: a click on a column the page does not show cannot happen, but the
  sorting state could still hold one from before.
- **`withValue` comes from the answer**, not from the permission, like the sales report's `withCost`. The columns are
  right even when the permission changed since the page loaded.

```tsx
  const columns = useMemo(() => {
    // A quantity with its unit ("1,338 strip", "167.75 m"). Zero is a dash, like the aging: the
    // eye finds what moved.
    const quantity = (
      id: 'opening' | (typeof MOVEMENT_COLUMNS)[number] | 'closing',
      strong = false,
    ) =>
      column.accessor(id, {
        header: t(`reports.stockMovement.columns.${id}`),
        meta: { align: 'end', card: id === 'closing' ? 'trailing' : 'detail' },
        cell: ({ row, getValue }) => {
          const value = getValue();
          if (isZeroMoney(value)) return <span className="text-ink-3">—</span>;
          const { baseUnit } = row.original;
          return (
            <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
              {format.number(value, baseUnit.decimals)} {baseUnit.code}
            </span>
          );
        },
      });
    const value = (id: 'openingValue' | 'closingValue') =>
      column.accessor(id, {
        header: t(`reports.stockMovement.columns.${id}`),
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => {
          const amount = getValue();
          return amount === null || isZeroMoney(amount) ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span className="text-ink-2">{format.money(amount)}</span>
          );
        },
      });
    return column.columns([
      column.accessor((row) => variantName(row), {
        id: 'name',
        header: t('reports.stockMovement.columns.product'),
        meta: { card: 'title' },
        cell: ({ row, getValue }) => {
          const name = getValue();
          // The stock card has every single movement behind the row's numbers
          return (
            <Link
              to="/stock/$variantId"
              params={{ variantId: row.original.variantId }}
              aria-label={t('reports.stockMovement.openCard', { name })}
              className="flex items-center gap-3 underline-offset-3 hover:underline"
            >
              <NameTile name={row.original.productName} />
              <span className="grid min-w-0 min-[860px]:min-w-48 max-w-[18rem]">
                <span className="truncate font-medium text-ink">{name}</span>
                <span className="font-mono text-caption text-ink-3 tabular-nums">
                  {row.original.sku}
                </span>
              </span>
            </Link>
          );
        },
      }),
      quantity('opening'),
      ...MOVEMENT_COLUMNS.map((id) => quantity(id)),
      quantity('closing', true),
      ...(withValue ? [value('openingValue'), value('closingValue')] : []),
    ]);
  }, [t, format, withValue]);

  const warehouse = warehouses?.find((item) => item.id === warehouseId);
  const category = categories?.find((item) => item.id === categoryId);
```

- **`quantity()`** writes "1,338 strip" with the unit's own decimals. Zero is a dash, as in the aging, so the eye
  finds what moved. `isZeroMoney` compares decimal strings, which quantities are too.
- **The closing column is the card's trailing value** on a phone: it is the number people look for.
- **The product column's id is `name`**, the contract's sort name, so a click on its header sorts by name on the
  server.
- **The name links to the stock card**, where every movement behind the row is. The link's label says so for a screen
  reader ("Open the stock card of …").

```tsx
  const header = (
    <PageHeader
      title={t('reports.stockMovement.title')}
      description={t('reports.stockMovement.description')}
      actions={
        canRead &&
        online &&
        period.valid && (
          <ExportMenu
            request={(exportFormat) => ({
              report: 'stock_movement',
              format: exportFormat,
              query: filter,
            })}
            names={{
              warehouse: warehouse && `${warehouse.code} · ${warehouse.name}`,
              category: category?.name,
            }}
          />
        )
      }
    />
  );

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'inventory.report.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
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
              label={t('reports.stockMovement.warehouse')}
              value={warehouseId}
              options={[
                { value: '', label: t('reports.stockMovement.allWarehouses') },
                ...(warehouses ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.code} · ${item.name}`,
                })),
              ]}
              onChange={(event) => {
                setWarehouseId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.category')}
              value={categoryId}
              hint={categoryId === '' ? undefined : t('reports.categoryHint')}
              options={[
                { value: '', label: t('reports.allCategories') },
                ...categoryOptions(categories ?? []),
              ]}
              onChange={(event) => {
                setCategoryId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.stockMovement.show')}
              value={show}
              options={STOCK_MOVEMENT_SHOWS.map((value) => ({
                value,
                label: t(`reports.stockMovement.shows.${value}`),
              }))}
              onChange={(event) => {
                const next = STOCK_MOVEMENT_SHOWS.find((value) => value === event.target.value);
                if (next) setShow(next);
              }}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={PackageMovingIcon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.stockMovement.kpis.variants'),
                      value: format.number(first.totals.variants),
                      sub: t('reports.stockMovement.kpiHints.variants'),
                    },
                    ...(withValue &&
                    first.totals.openingValue !== null &&
                    first.totals.closingValue !== null
                      ? [
                          {
                            label: t('reports.stockMovement.kpis.openingValue'),
                            value: format.money(first.totals.openingValue),
                          },
                          {
                            label: t('reports.stockMovement.kpis.closingValue'),
                            value: format.money(first.totals.closingValue),
                          },
                        ]
                      : []),
                  ]}
                />
                <DataTable
                  label={t('reports.stockMovement.title')}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.variantId}
                  sorting={{ state: sorting, onChange: setSorting }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={PackageMovingIcon}
                      title={t('reports.stockMovement.emptyTitle')}
                      description={
                        show === 'moved'
                          ? t('reports.stockMovement.emptyBody')
                          : t('reports.stockMovement.emptyAllBody')
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
                    t('reports.stockMovement.returnsHint'),
                    t('reports.stockMovement.transfersHint'),
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

- **The strip** has the Products cell, and the two value cells only with the values. There is no total quantity
  (decision 23).
- **The empty state** says the way out: "show what did not move too", or only other dates when that is already on.
- **Two footnotes** answer the questions the numbers raise: where a return goes, and why Transfers can be below zero
  (decision 25).

### The scheduled emails: `routes/report-schedules.tsx` (new)

```tsx
import {
  Alert02Icon,
  CalendarClockIcon,
  ChartIncreaseIcon,
  ChartLineData01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PackageMovingIcon,
  PauseCircleIcon,
  PauseIcon,
  PencilEdit02Icon,
  PieChartIcon,
  PlayIcon,
  ShoppingBag01Icon,
  TableIcon,
  TaxesIcon,
  Time04Icon,
  TimeQuarterPassIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  isExportFormat,
  isReportKind,
  MAX_REPORT_SCHEDULES,
  type ReportKind,
  type ReportSchedule,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState } from 'react';

import { NameTile } from '../components/trade-report-parts';
import { call } from '../lib/api';
import { failureOf } from '../components/journal-parts';
import { useCan } from '../lib/permissions';
import { reportSchedulesQuery, useScheduleWords } from '../lib/report-schedules';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 21c: the workspace's scheduled report emails. No "New" button (decision 57): a schedule is
// made from a report's Export menu, where its filters are. Not sortable: at most 20, newest first
// as the API sends them. No row click either; a row's actions are its menu.

const ReportScheduleDialog = lazy(async () => ({
  default: (await import('../components/report-schedule-dialog')).ReportScheduleDialog,
}));

// The report's tile: the same icon as its link in the sidebar
const REPORT_ICONS = {
  trial_balance: TableIcon,
  profit_and_loss: ChartIncreaseIcon,
  balance_sheet: PieChartIcon,
  sales_report: ChartLineData01Icon,
  purchase_report: ShoppingBag01Icon,
  ar_aging: TimeQuarterPassIcon,
  ap_aging: Time04Icon,
  vat_report: TaxesIcon,
  stock_movement: PackageMovingIcon,
} as const satisfies Record<ReportKind, IconSvgElement>;

const column = dataTableColumns<ReportSchedule>();

// What a row's menu asked for; the page keeps it and opens that dialog
interface Acting {
  kind: 'edit' | 'delete';
  schedule: ReportSchedule;
}

function StatusCell({ schedule }: { schedule: ReportSchedule }) {
  const { t } = useLocale();
  if (schedule.status === 'active') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('reportSchedules.statuses.active')}
      </Pill>
    );
  }
  // Paused is neutral: someone chose it, or nobody may read the report (the line under Sent to
  // already says that in warn). The reason says what to do.
  return (
    <span className="grid justify-items-start gap-1">
      <Pill tone="neutral" icon={PauseCircleIcon}>
        {t('reportSchedules.statuses.paused')}
      </Pill>
      {schedule.pausedReason && (
        <span className="max-w-[14rem] text-caption font-normal whitespace-normal text-ink-3">
          {t(`reportSchedules.pausedReasons.${schedule.pausedReason}`)}
        </span>
      )}
    </span>
  );
}

// The confirm before a delete. Hard: the schedule goes; files already sent stay on each person's
// Exports page.
function DeleteContent({ schedule, onDone }: { schedule: ReportSchedule; onDone: () => void }) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const words = useScheduleWords();
  const remove = useMutation({
    mutationFn: () => call(routes.reportSchedules.remove, { params: { id: schedule.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['report-schedules', tenantId] });
      toast(t('reportSchedules.deleted', { report: words.report(schedule.report) }));
      onDone();
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
  return (
    <DialogContent
      title={t('reportSchedules.deleteTitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            {t('reportSchedules.deleteConfirm')}
          </Button>
        </>
      }
    >
      <p className="text-body-sm text-ink-2">{t('reportSchedules.deleteBody')}</p>
    </DialogContent>
  );
}
```

- **`REPORT_ICONS`** gives each report's tile the icon of its link in the sidebar. `satisfies Record<ReportKind, …>`:
  a new report does not compile without one.
- **`Acting`** is what a row's menu asked for. The page keeps it and renders the matching dialog, as the device lists
  do.
- **`StatusCell`**: Active is `good`. Paused is neutral, with the reason under it: someone paused it by hand, or the
  worker found nobody who may read the report. The second needs a recipient before Resume, and the reason says so.
- **`DeleteContent`** asks first. The delete is hard; the files already sent stay on each person's Exports page, and
  the dialog says so.

```tsx
export function ReportSchedulesPage() {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const can = useCan();
  const canManage = can('core.report.schedule');
  const online = useOnline();
  const queryClient = useQueryClient();
  const words = useScheduleWords();
  const list = useQuery({ ...reportSchedulesQuery(tenantId), enabled: canManage && online });
  const [acting, setActing] = useState<Acting | null>(null);

  // Pause and Resume go at once, with the version the row was read at: someone else's change in
  // between is refused (version_conflict) instead of overwritten
  const toggle = useMutation({
    mutationFn: (schedule: ReportSchedule) =>
      schedule.status === 'active'
        ? call(routes.reportSchedules.pause, {
            params: { id: schedule.id },
            body: { version: schedule.version },
          })
        : call(routes.reportSchedules.resume, {
            params: { id: schedule.id },
            body: { version: schedule.version },
          }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['report-schedules', tenantId] });
      const report = words.report(saved.report);
      toast(
        saved.status === 'active'
          ? t('reportSchedules.resumed', { report })
          : t('reportSchedules.paused', { report }),
      );
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });

  // mutate is stable; the mutation object is new on every render and would rebuild the columns
  const { mutate: toggleSchedule, isPending: toggling } = toggle;
  const timeZone = list.data?.timeZone ?? 'UTC';
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('report', {
          // Not sortable: at most 20, in the order they were made. Without this on every column
          // the DataTable would sort in the browser and show sort buttons.
          enableSorting: false,
          header: t('reportSchedules.columns.report'),
          meta: { card: 'title' },
          cell: ({ row }) => {
            const schedule = row.original;
            const fileWord = isExportFormat(schedule.format)
              ? t(`reports.formats.${schedule.format}`)
              : schedule.format;
            return (
              <span className="flex items-start gap-3">
                <NameTile
                  icon={
                    isReportKind(schedule.report)
                      ? REPORT_ICONS[schedule.report]
                      : CalendarClockIcon
                  }
                  brand
                />
                <span className="grid min-w-0">
                  <span className="font-medium text-ink">{words.report(schedule.report)}</span>
                  {words.filterLines(schedule).map((line) => (
                    <span key={line} className="text-caption font-normal text-ink-3">
                      {line}
                    </span>
                  ))}
                  <span className="text-caption font-normal text-ink-3">
                    {`${fileWord} · ${t('reportSchedules.createdBy', { name: schedule.createdByName })}`}
                  </span>
                </span>
              </span>
            );
          },
        }),
        column.accessor('when', {
          enableSorting: false,
          header: t('reportSchedules.columns.when'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => words.when(getValue()),
        }),
        column.accessor('recipients', {
          enableSorting: false,
          header: t('reportSchedules.columns.recipients'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const recipients = getValue();
            const left = recipients.filter((person) => !person.canReceive).length;
            return (
              <span className="grid justify-items-start">
                {t('reportSchedules.recipientCount', { count: recipients.length })}
                {/* Someone on it who left or lost the report's permission gets nothing */}
                {left > 0 && (
                  <span className="flex items-center gap-1 text-caption font-medium text-warn">
                    <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.5} />
                    {t('reportSchedules.cannotReceiveCount', { count: left })}
                  </span>
                )}
              </span>
            );
          },
        }),
        column.accessor('nextRunAt', {
          enableSorting: false,
          header: t('reportSchedules.columns.nextRun'),
          meta: { card: 'detail' },
          cell: ({ row }) => {
            const { nextRunAt, lastRunAt } = row.original;
            return (
              <span className="grid tabular-nums">
                {nextRunAt === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="whitespace-nowrap">
                    {format.dateTime(new Date(nextRunAt), timeZone)}
                  </span>
                )}
                <span className="text-caption text-ink-3">
                  {lastRunAt === null
                    ? t('reportSchedules.notSentYet')
                    : t('reportSchedules.lastRun', {
                        date: format.dateTime(new Date(lastRunAt), timeZone),
                      })}
                </span>
              </span>
            );
          },
        }),
        column.accessor('status', {
          enableSorting: false,
          header: t('reportSchedules.columns.status'),
          meta: { card: 'subtitle' },
          cell: ({ row }) => <StatusCell schedule={row.original} />,
        }),
        column.display({
          id: 'actions',
          header: () => <span className="sr-only">{t('reportSchedules.columns.actions')}</span>,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => {
            const schedule = row.original;
            const paused = schedule.status === 'paused';
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('reportSchedules.actionsFor', {
                      report: words.report(schedule.report),
                    })}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={PencilEdit02Icon}
                    onSelect={() => {
                      setActing({ kind: 'edit', schedule });
                    }}
                  >
                    {t('reportSchedules.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={paused ? PlayIcon : PauseIcon}
                    disabled={toggling}
                    onSelect={() => {
                      toggleSchedule(schedule);
                    }}
                  >
                    {paused ? t('reportSchedules.resume') : t('reportSchedules.pause')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={Delete02Icon}
                    onSelect={() => {
                      setActing({ kind: 'delete', schedule });
                    }}
                  >
                    {t('reportSchedules.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          },
        }),
      ]),
    [t, format, timeZone, words, toggleSchedule, toggling],
  );
```

- **Pause and Resume go at once**, with the version the row was read at. A change by someone else in between is
  refused (`version_conflict`) instead of overwritten, and the toast says the error's words. Resume on a schedule
  nobody may receive is refused with `report_schedule_no_recipients`.
- **`toggleSchedule` and `toggling` are in the columns' dependencies, not `toggle`.** The object `useMutation` returns
  is new on every render; its `mutate` is stable. With `toggle` there, the columns would be rebuilt on every render.
- **`timeZone` comes from the list's answer.** The API sends the workspace's time zone with the list, so the dates are
  read in the time the hours mean.
- **The report cell** has the filter lines and "Excel · Made by Nusrat Jahan" under the name. The format is narrowed
  with `isExportFormat()` before it becomes a key.
- **Sent to** shows a `warn` line when someone on it gets nothing.
- **Next email** is a dash while paused (`nextRunAt` is `null` then), with the last email or "Not sent yet" under it.
- **The menu column** has a header for screen readers only: a column of buttons with no name reads as an empty cell.
  On a phone the menu is the card's trailing part, and the status is its subtitle.

```tsx
  const header = (
    <PageHeader title={t('reportSchedules.title')} description={t('reportSchedules.description')} />
  );
  if (!canManage) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'core.report.schedule' })}
        </p>
      </div>
    );
  }

  const items = list.data?.items;
  const editing = acting?.kind === 'edit' ? acting.schedule : null;
  const editingReport = editing && isReportKind(editing.report) ? editing.report : null;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
      {!online ? (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('reports.needsConnection')}
        />
      ) : list.isError ? (
        <p className="text-body-sm text-crit">{t('reportSchedules.loadFailed')}</p>
      ) : (
        items && (
          <>
            {items.length > 0 && (
              <p className="-mt-2 text-label font-normal text-ink-3 tabular-nums">
                {t('reportSchedules.count', {
                  count: format.number(items.length),
                  max: format.number(MAX_REPORT_SCHEDULES),
                })}
              </p>
            )}
            <DataTable
              label={t('reportSchedules.title')}
              data={items}
              columns={columns}
              getRowId={(item) => item.id}
              empty={
                <EmptyState
                  icon={CalendarClockIcon}
                  title={t('reportSchedules.emptyTitle')}
                  description={t('reportSchedules.emptyBody')}
                />
              }
            />
          </>
        )
      )}
      {editing && editingReport && (
        <Suspense fallback={null}>
          <ReportScheduleDialog
            target={{ kind: 'edit', schedule: editing, report: editingReport }}
            onClose={() => {
              setActing(null);
            }}
          />
        </Suspense>
      )}
      {acting?.kind === 'delete' && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActing(null);
          }}
        >
          <DeleteContent
            schedule={acting.schedule}
            onDone={() => {
              setActing(null);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
```

- **Without the permission** the page says which one is missing, like the other report pages.
- **Offline** it is the "Needs a connection" empty state: schedules are on the server.
- **"4 of 20 scheduled emails"** shows only when there is one; the empty state says what to do instead (open a report,
  Export, Email on a schedule).
- **The edit dialog renders only for a known kind** (`editingReport`). The dialog needs a `ReportKind`; a schedule of a
  kind this app does not know can still be paused or deleted from the menu.

### The routes, the sidebar and the bell

```diff
@@ -254,6 +254,29 @@ const reportExportsRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/report-exports'), 'ReportExportsPage'),
 });
 
+// Step 21c: the VAT report, the stock movement report and the scheduled emails, each its own lazy
+// chunk
+const vatReportRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/vat',
+  component: lazyRouteComponent(() => import('./routes/vat-report'), 'VatReportPage'),
+});
+
+const stockMovementReportRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/stock-movement',
+  component: lazyRouteComponent(
+    () => import('./routes/stock-movement-report'),
+    'StockMovementReportPage',
+  ),
+});
+
+const reportSchedulesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/schedules',
+  component: lazyRouteComponent(() => import('./routes/report-schedules'), 'ReportSchedulesPage'),
+});
+
 // Products (step 12). '/products/new', '/products/categories', '/products/units' and
 // '/products/imports' beat '/products/$productId': a fixed segment ranks above a parameter.
 const productsRoute = createRoute({
@@ -1044,6 +1067,9 @@ const routeTree = rootRoute.addChildren([
     apAgingRoute,
     apAgingPartyRoute,
     reportExportsRoute,
+    vatReportRoute,
+    stockMovementReportRoute,
+    reportSchedulesRoute,
     productsRoute,
     newProductRoute,
     productRoute,
```

Three lazy routes, each its own chunk.

```diff
@@ -3,6 +3,7 @@ import {
   BalanceScaleIcon,
   Book02Icon,
   BookOpen02Icon,
+  CalendarClockIcon,
   CalendarLock01Icon,
   Cashier02Icon,
   CashierIcon,
@@ -36,6 +37,7 @@ import {
   Notebook02Icon,
   NoteRemoveIcon,
   PackageIcon,
+  PackageMovingIcon,
   PackageOutOfStockIcon,
   PackageReceiveIcon,
   PackageRemoveIcon,
@@ -52,6 +54,7 @@ import {
   Store01Icon,
   TableIcon,
   Tag01Icon,
+  TaxesIcon,
   TaskAdd01Icon,
   TaskEdit01Icon,
   TextIcon,
@@ -352,6 +355,8 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
   const canAccountingReports = can('accounting.report.read');
   const canSalesReports = can('sales.report.read');
   const canPurchaseReports = can('purchase.report.read');
+  // Step 21c: the stock movement report has the stock reports' permission
+  const canInventoryReports = can('inventory.report.read');
   // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
   const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
   // Step 18b: sign out at once with nothing on the device, else ask. Step 20b (decision 6): an
@@ -430,7 +435,10 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
               Step 21b: each link by its own permission, and the group shows when any link does.
               A person with only the sales reports sees "Sales report", "Receivables aging" and
               Exports (the list shows the kinds they can read). */}
-          {(canAccountingReports || canSalesReports || canPurchaseReports) && (
+          {(canAccountingReports ||
+            canSalesReports ||
+            canPurchaseReports ||
+            canInventoryReports) && (
             <NavGroup label={t('nav.reports')}>
               {canAccountingReports && (
                 <>
@@ -443,6 +451,10 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
                   <NavLink to="/reports/balance-sheet" icon={PieChartIcon}>
                     {t('nav.balanceSheet')}
                   </NavLink>
+                  {/* Step 21c: VAT belongs to the accounts (decision 11) */}
+                  <NavLink to="/reports/vat" icon={TaxesIcon}>
+                    {t('nav.vatReport')}
+                  </NavLink>
                 </>
               )}
               {canSalesReports && (
@@ -465,9 +477,20 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
                   </NavLink>
                 </>
               )}
+              {canInventoryReports && (
+                <NavLink to="/reports/stock-movement" icon={PackageMovingIcon}>
+                  {t('nav.stockMovement')}
+                </NavLink>
+              )}
               <NavLink to="/reports/exports" icon={FileDownloadIcon}>
                 {t('nav.exports')}
               </NavLink>
+              {/* Step 21c: the scheduled emails, for the people who may make them */}
+              {can('core.report.schedule') && (
+                <NavLink to="/reports/schedules" icon={CalendarClockIcon}>
+                  {t('nav.reportSchedules')}
+                </NavLink>
+              )}
             </NavGroup>
           )}
           {/* Sales (step 15a): everyone reads the customers and the price lists — every sales
```

- **The Reports group** now also shows for a person with only `inventory.report.read` (a store keeper who reads the
  stock movement).
- **VAT report** sits with the accounting statements (decision 11), **Stock movement** after the purchase reports, and
  **Scheduled emails** after Exports, only with `core.report.schedule`.

```diff
@@ -46,6 +46,10 @@ const TARGET = {
   'invitation.failed': '/team',
   'report.ready': '/reports/exports',
   'report.failed': '/reports/exports',
+  // Step 21c: the schedule's bells go to the creator (decision 12), who fixes it on that page
+  'report.schedule_skipped': '/reports/schedules',
+  'report.schedule_paused': '/reports/schedules',
+  'report.schedule_failed': '/reports/schedules',
   'import.done': '/products/imports',
   'import.failed': '/products/imports',
   'stock.low': '/stock/reorder',
```

The three schedule bells open the schedules page, where the person who made the schedule fixes it (decision 12). The
map's `satisfies` refused to compile until they had a page.

### The other reports pass their filters' names

```diff
@@ -20,7 +20,7 @@ import {
 import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
 import { useCallback, useMemo, useState } from 'react';
 
-import { ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
+import { branchName, ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
 import {
   BooksLine,
   Footnotes,
@@ -243,7 +243,14 @@ export function SalesReportPage() {
         actions={
           online &&
           period.valid && (
-            <ExportMenu request={(format) => ({ report: 'sales_report', format, query: filter })} />
+            <ExportMenu
+              request={(format) => ({ report: 'sales_report', format, query: filter })}
+              names={{
+                branch: branchName(branches, branchId),
+                group: groups?.find((group) => group.id === customerGroupId)?.name,
+                category: categories?.find((category) => category.id === categoryId)?.name,
+              }}
+            />
           )
         }
       />
```

```diff
@@ -26,7 +26,7 @@ import {
 import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
 import { useCallback, useMemo, useState } from 'react';
 
-import { ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
+import { branchName, ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
 import { LoadFailed, NameTile, NeedsConnection } from '../components/trade-report-parts';
 import { useCan } from '../lib/permissions';
 import { categoryOptions } from '../lib/products';
@@ -201,6 +201,11 @@ export function PurchaseReportPage() {
           period.valid && (
             <ExportMenu
               request={(format) => ({ report: 'purchase_report', format, query: filter })}
+              names={{
+                branch: branchName(branches, branchId),
+                group: groups?.find((group) => group.id === supplierGroupId)?.name,
+                category: categories?.find((category) => category.id === categoryId)?.name,
+              }}
             />
           )
         }
```

```diff
@@ -7,6 +7,7 @@ import { useState } from 'react';
 
 import { useIsoDate } from '../components/journal-parts';
 import {
+  branchName,
   ExportMenu,
   PeriodFields,
   sectionRows,
@@ -56,7 +57,10 @@ export function ProfitAndLossPage() {
         description={t('reports.profitAndLoss.description')}
         actions={
           canRead && (
-            <ExportMenu request={(format) => ({ report: 'profit_and_loss', format, query })} />
+            <ExportMenu
+              request={(format) => ({ report: 'profit_and_loss', format, query })}
+              names={{ branch: branchName(branches, branchId) }}
+            />
           )
         }
       />
```

```diff
@@ -280,7 +280,16 @@ function AgingView({
     <PageHeader
       title={t(`reports.${namespace}.title`)}
       description={t(`reports.${namespace}.description`)}
-      actions={canRead && online && asOf !== '' && <ExportMenu request={exportRequest} />}
+      actions={
+        canRead &&
+        online &&
+        asOf !== '' && (
+          <ExportMenu
+            request={exportRequest}
+            names={{ group: groups.find((group) => group.id === groupId)?.name }}
+          />
+        )
+      }
     />
   );
   if (!canRead) {
```

Each page passes the names of what its selects chose, from the lists it already loaded (decision 59). A page with no
such filter (the trial balance, the balance sheet) passes nothing, and the dialog says "None". The compare dates of
the profit and loss and the balance sheet are not filters: a schedule drops them (`reportScheduleFiltersOf`).

### The first load's budget: `scripts/check-bundle-size.ts`

```diff
@@ -14,8 +14,10 @@ import { z } from 'zod';
 // registers, the POS screen, its sales and the sold-short list) took it to 217.9 KB. Step 20b: 225 KB
 // (you chose this). 20b's words (the shift, the count, held bills, the shifts pages) took it to 222.0 KB.
 // Step 21a: 230 KB (you chose this). The Overview's words and its contract took it to 225.7 KB; the
-// chart and the page are in the Overview's own lazy chunk.
-const INITIAL_BUDGET = 230 * 1024;
+// chart and the page are in the Overview's own lazy chunk. Step 21c: 235 KB (you chose this). 21c's
+// words (the VAT and stock movement reports, the scheduled emails) took it to 231.7 KB; the pages
+// and the schedule dialog are their own lazy chunks.
+const INITIAL_BUDGET = 235 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
```

The first load was 231.3 KB before this part: 21c.5's English words load with it, like every step's. This part adds
0.4 KB (three icons, three routes, the bell's targets). You chose 235 KB. The pages and the dialog are lazy chunks
(VAT 126.3 KB, stock movement 126.6 KB, schedules 121.0 KB, the dialog 89.0 KB, all under 140 KB).

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app typecheck
pnpm exec eslint apps/app/src
pnpm exec prettier --check apps/app/src apps/app/scripts
pnpm --filter @omnivo/app test
cd apps/app && pnpm exec vite build && node scripts/check-bundle-size.ts && cd ../..
pnpm boundaries
```

All pass, except the app's type check in `mocks/report-data.ts` (21c.7). `pnpm --filter @omnivo/app build` runs the
type check first, so until 21c.7 the bundle check runs on `vite build` directly. The app's unit tests: 210. The pages
are seen working in 21c.7, with the mock answers and the Playwright tests.

---

## 21c.7 — The mock and the Playwright tests

The eight new routes get an answer in mock mode, so `pnpm dev:mock` and the Playwright tests can show the pages. The
mock works the two reports out from its own documents, like 21b's reports, and keeps the schedules with the API's rules.
It also gets the data to show: last month's documents with VAT (decision 62), and a Finance desk with the mockup's four
schedules (decision 63). Then the tests, on a computer and on a phone. Looking at the pages in a browser found two
things to fix: sort buttons on two lists that do not sort (decision 64), and a branch named without its code
(decision 65).

### `apps/app/src/mocks/vat-stock-report-data.ts` (new): the two reports on the mock's arrays

```ts
import {
  addMoney,
  compareMoney,
  isZeroMoney,
  negateMoney,
  STOCK_MOVEMENT_COLUMN_OF,
  type StockMovementColumn,
  type StockMovementFilter,
  type StockMovementReport,
  type StockMovementRow,
  subtractMoney,
  sumMoney,
  TAX_RATE_KINDS,
  type TaxRateKind,
  type TaxRateRef,
  type VatDocument,
  type VatDocumentPage,
  type VatReport,
  type VatReportFilter,
  type VatReportRow,
  type VatReportSide,
} from '@omnivo/contracts';

import { pageOf } from './sales-document-data';
import { branchOf } from './stock-data';
import { categoryAndBelow } from './trade-report-data';
import type { WorkspaceData } from './workspace-data';

// Step 21c: the VAT report and the stock movement report on the mock's arrays. The API's rules
// (vat-queries.ts, stock-movement-queries.ts) written again, like the 21b reports
// (trade-report-data.ts), so a sale posted in `pnpm dev:mock` or in a Playwright test shows in
// the reports at once.

// ---------------------------------------------------------------------------------------------
// VAT

interface VatLine {
  side: VatReportSide;
  kind: VatDocument['kind'];
  docId: string;
  number: string;
  date: string;
  partyName: string | null;
  partyBin: string | null;
  branchId: string | null;
  // A bill's Mushak 6.3, a debit note's 6.7
  mushak: string | null;
  // A credit note, a POS return or a debit note: it takes VAT off
  returned: boolean;
  rate: TaxRateRef;
  net: string;
  vat: string;
}

// A line as the API's vatLines() gives it: what takes off is negative
interface LineSource {
  taxRate: TaxRateRef;
  net: string;
  vat: string;
}

type Document = Omit<VatLine, 'rate' | 'net' | 'vat'>;

function linesOf(document: Document, lines: readonly LineSource[]): VatLine[] {
  return lines.map((line) => ({
    ...document,
    rate: line.taxRate,
    net: document.returned ? negateMoney(line.net) : line.net,
    vat: document.returned ? negateMoney(line.vat) : line.vat,
  }));
}

// Every line with VAT in the period (decision 1), signed, with its document's branch (decision 19)
function vatLines(data: WorkspaceData, from: string, to: string): VatLine[] {
  const inPeriod = (date: string) => date >= from && date <= to;
  const customers = new Map(data.sales.customers.map((item) => [item.id, item]));
  const suppliers = new Map(data.suppliers.suppliers.map((item) => [item.id, item]));
  const customer = (id: string | null | undefined) =>
    id === null || id === undefined ? undefined : customers.get(id);
  const supplier = (id: string) => suppliers.get(id);
  const sales = new Map(data.pos.sales.map((sale) => [sale.id, sale]));

  const invoices = data.billing.invoices
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'output',
          kind: 'invoice',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: customer(item.customer.id)?.name ?? null,
          partyBin: customer(item.customer.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: null,
          returned: false,
        },
        item.lines,
      ),
    );
  const posSales = data.pos.sales
    .filter((item) => inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'output',
          kind: 'pos_sale',
          docId: item.id,
          number: item.number,
          date: item.date,
          partyName: customer(item.customer?.id)?.name ?? null,
          partyBin: customer(item.customer?.id)?.bin ?? null,
          branchId: branchOf(data, item.warehouseId),
          mushak: null,
          returned: false,
        },
        item.lines,
      ),
    );
  // A credit note counts in its invoice's branch, which is its own branchId
  const creditNotes = data.returns.creditNotes
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'output',
          kind: 'credit_note',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: customer(item.customer.id)?.name ?? null,
          partyBin: customer(item.customer.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: null,
          returned: true,
        },
        item.lines,
      ),
    );
  // A POS return line has no rate of its own: it is the sale line's
  const posReturns = data.pos.returns
    .filter((item) => inPeriod(item.date))
    .flatMap((item) => {
      const sale = sales.get(item.saleId);
      if (!sale) return [];
      const document: Document = {
        side: 'output',
        kind: 'pos_return',
        docId: item.id,
        number: item.number,
        date: item.date,
        partyName: customer(sale.customer?.id)?.name ?? null,
        partyBin: customer(sale.customer?.id)?.bin ?? null,
        branchId: branchOf(data, item.warehouseId),
        mushak: null,
        returned: true,
      };
      return item.lines.flatMap((line) => {
        const sold = sale.lines.find((candidate) => candidate.id === line.saleLineId);
        return sold
          ? linesOf(document, [{ taxRate: sold.taxRate, net: line.net, vat: line.vat }])
          : [];
      });
    });
  const bills = data.purchase.bills
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'input',
          kind: 'bill',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: supplier(item.supplier.id)?.name ?? null,
          partyBin: supplier(item.supplier.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: item.mushakNumber,
          returned: false,
        },
        [...item.lines, ...item.expenses],
      ),
    );
  const debitNotes = data.purchase.debitNotes
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'input',
          kind: 'debit_note',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: supplier(item.supplier.id)?.name ?? null,
          partyBin: supplier(item.supplier.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: item.supplierCreditNumber,
          returned: true,
        },
        [...item.lines, ...item.expenses],
      ),
    );
  return [...invoices, ...posSales, ...creditNotes, ...posReturns, ...bills, ...debitNotes];
}

function inBranch(lines: readonly VatLine[], branchId: string | undefined): VatLine[] {
  return branchId === undefined ? [...lines] : lines.filter((line) => line.branchId === branchId);
}

// A line's rate kind as the contract's enum; a kind this mock does not know sorts last
function kindOf(kind: string): TaxRateKind {
  return TAX_RATE_KINDS.find((item) => item === kind) ?? 'exempt';
}

// The order of a return (decision 15): standard first, then reduced, zero-rated, exempt; the
// highest rate first; then the name and the id
function byReturnOrder(a: VatReportRow, b: VatReportRow): number {
  return (
    TAX_RATE_KINDS.indexOf(a.kind) - TAX_RATE_KINDS.indexOf(b.kind) ||
    compareMoney(b.rate, a.rate) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    a.taxRateId.localeCompare(b.taxRateId)
  );
}

function sideSum(lines: readonly VatLine[], side: VatReportSide, field: 'net' | 'vat'): string {
  return sumMoney(lines.filter((line) => line.side === side).map((line) => line[field]));
}

// What the books moved on the VAT accounts in the period and branch (the API's booksVat)
function booksVat(data: WorkspaceData, filter: VatReportFilter): VatReport['books'] {
  const purposeOf = new Map(data.accounts.map((account) => [account.id, account.purpose]));
  const lines = data.journal.entries
    .filter(
      (entry) => entry.status === 'posted' && entry.date >= filter.from && entry.date <= filter.to,
    )
    .flatMap((entry) => entry.lines)
    .filter((line) => filter.branchId === undefined || line.branchId === filter.branchId);
  const on = (purpose: string) => lines.filter((line) => purposeOf.get(line.accountId) === purpose);
  return {
    output: sumMoney(on('vat_output').map((line) => subtractMoney(line.credit, line.debit))),
    input: sumMoney(on('vat_input').map((line) => subtractMoney(line.debit, line.credit))),
  };
}

export function vatReportOf(data: WorkspaceData, filter: VatReportFilter): VatReport {
  const lines = inBranch(vatLines(data, filter.from, filter.to), filter.branchId);

  // One row per rate, kind and percent (decision 14), named by its latest line
  const groups = new Map<string, VatLine[]>();
  for (const line of lines) {
    const key = `${line.rate.id}:${kindOf(line.rate.kind)}:${line.rate.rate}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const rows = [...groups].map(([key, group]): VatReportRow => {
    const latest = group.toSorted(
      (a, b) => b.date.localeCompare(a.date) || b.docId.localeCompare(a.docId),
    )[0];
    const outputVat = sideSum(group, 'output', 'vat');
    const inputVat = sideSum(group, 'input', 'vat');
    return {
      key,
      taxRateId: latest?.rate.id ?? '',
      name: latest?.rate.name ?? '',
      kind: kindOf(latest?.rate.kind ?? ''),
      rate: latest?.rate.rate ?? '0',
      outputNet: sideSum(group, 'output', 'net'),
      outputVat,
      inputNet: sideSum(group, 'input', 'net'),
      inputVat,
      netVat: subtractMoney(outputVat, inputVat),
    };
  });

  const returned = (side: VatReportSide) =>
    negateMoney(
      sumMoney(lines.filter((line) => line.side === side && line.returned).map((line) => line.vat)),
    );
  const outputVat = sideSum(lines, 'output', 'vat');
  const inputVat = sideSum(lines, 'input', 'vat');
  return {
    rows: rows.toSorted(byReturnOrder),
    totals: {
      outputNet: sideSum(lines, 'output', 'net'),
      outputVat,
      outputVatReturned: returned('output'),
      inputNet: sideSum(lines, 'input', 'net'),
      inputVat,
      inputVatReturned: returned('input'),
      // Bills only, before the debit notes (decision 17)
      inputVatWithoutMushak: sumMoney(
        lines
          .filter((line) => line.kind === 'bill' && line.mushak === null)
          .map((line) => line.vat),
      ),
      netVat: subtractMoney(outputVat, inputVat),
    },
    books: booksVat(data, filter),
  };
}

// The documents behind one side, oldest first (decision 18): one row per document
export function vatDocumentsOf(
  data: WorkspaceData,
  query: VatReportFilter & { side: VatReportSide; limit: number; cursor?: string | undefined },
): VatDocumentPage {
  const lines = inBranch(vatLines(data, query.from, query.to), query.branchId).filter(
    (line) => line.side === query.side,
  );
  const documents = new Map<string, VatDocument>();
  for (const line of lines) {
    const found = documents.get(line.docId);
    documents.set(
      line.docId,
      found
        ? { ...found, net: addMoney(found.net, line.net), vat: addMoney(found.vat, line.vat) }
        : {
            kind: line.kind,
            id: line.docId,
            number: line.number,
            date: line.date,
            partyName: line.partyName,
            partyBin: line.partyBin,
            mushakNumber: line.mushak,
            net: line.net,
            vat: line.vat,
          },
    );
  }
  const sorted = [...documents.values()].toSorted(
    (a, b) =>
      a.date.localeCompare(b.date) || a.number.localeCompare(b.number) || a.id.localeCompare(b.id),
  );
  return pageOf(sorted, query);
}

// ---------------------------------------------------------------------------------------------
// Stock movement

type Columns = Record<StockMovementColumn, string>;

interface Moves {
  opening: string;
  openingValue: string;
  closing: string;
  closingValue: string;
  columns: Columns;
  moved: boolean;
}

function noColumns(): Columns {
  return { purchased: '0', sold: '0', transfers: '0', adjusted: '0' };
}

// The number columns' values to sort by. A value sort is refused before this without
// inventory.stock.value (the handler), like the API's service (decision 24).
const SORT_VALUE = {
  opening: (row) => row.opening,
  purchased: (row) => row.purchased,
  sold: (row) => row.sold,
  transfers: (row) => row.transfers,
  adjusted: (row) => row.adjusted,
  closing: (row) => row.closing,
  openingValue: (row) => row.openingValue,
  closingValue: (row) => row.closingValue,
} satisfies Record<string, (row: StockMovementRow) => string | null>;

function isSortColumn(column: string): column is keyof typeof SORT_VALUE {
  return column in SORT_VALUE;
}

// The mock's ledger starts at the beginning, so it adds the movements up from there, where the
// API works back from what each variant holds now (decision 5). Both give the same numbers.
export function stockMovementOf(
  data: WorkspaceData,
  query: StockMovementFilter & { limit: number; cursor?: string | undefined },
  withValue: boolean,
): StockMovementReport {
  const { from, to } = query;
  const byVariant = new Map<string, Moves>();
  for (const movement of data.stock.movements) {
    if (movement.date > to) continue;
    if (query.warehouseId !== undefined && movement.warehouseId !== query.warehouseId) continue;
    const moves = byVariant.get(movement.variantId) ?? {
      opening: '0',
      openingValue: '0',
      closing: '0',
      closingValue: '0',
      columns: noColumns(),
      moved: false,
    };
    moves.closing = addMoney(moves.closing, movement.quantity);
    moves.closingValue = addMoney(moves.closingValue, movement.value);
    if (movement.date < from) {
      moves.opening = addMoney(moves.opening, movement.quantity);
      moves.openingValue = addMoney(moves.openingValue, movement.value);
    } else {
      // A revaluation counts as a movement: it moved the value
      moves.moved = true;
      const column = STOCK_MOVEMENT_COLUMN_OF[movement.kind];
      if (column !== null) {
        // "sold" turned round: stock that left is positive there (decision 21)
        const quantity = column === 'sold' ? negateMoney(movement.quantity) : movement.quantity;
        moves.columns[column] = addMoney(moves.columns[column], quantity);
      }
    }
    byVariant.set(movement.variantId, moves);
  }

  const wanted = query.categoryId === undefined ? null : categoryAndBelow(data, query.categoryId);
  const units = new Map(data.catalog.units.map((unit) => [unit.id, unit]));
  const rows: { row: StockMovementRow; position: number }[] = [];
  for (const product of data.catalog.products) {
    if (wanted !== null && (product.categoryId === null || !wanted.has(product.categoryId))) {
      continue;
    }
    const unit = units.get(product.baseUnitId);
    for (const [position, variant] of product.variants.entries()) {
      const moves = byVariant.get(variant.id);
      // decision 22: 'moved' = a movement in the period; 'all' adds what had stock at the start
      if (!moves || !(moves.moved || (query.show === 'all' && !isZeroMoney(moves.opening)))) {
        continue;
      }
      rows.push({
        position,
        row: {
          variantId: variant.id,
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          optionValues: variant.optionValues,
          sku: variant.sku,
          baseUnitId: product.baseUnitId,
          baseUnit: { code: unit?.code ?? '', decimals: unit?.decimals ?? 0 },
          opening: moves.opening,
          ...moves.columns,
          closing: moves.closing,
          openingValue: withValue ? moves.openingValue : null,
          closingValue: withValue ? moves.closingValue : null,
        },
      });
    }
  }

  // The sort's column, then the name in any case, the product and the variant's place
  const direction = query.sort.startsWith('-') ? -1 : 1;
  const column = query.sort.replace(/^-/, '');
  const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    a.row.productName.toLowerCase().localeCompare(b.row.productName.toLowerCase()) ||
    a.row.productId.localeCompare(b.row.productId) ||
    a.position - b.position;
  const textOf = (item: (typeof rows)[number]) =>
    (column === 'sku' ? item.row.sku : item.row.productName).toLowerCase();
  const ordered = rows.toSorted((a, b) => {
    if (column === 'name' || column === 'sku') {
      return direction * textOf(a).localeCompare(textOf(b)) || byName(a, b);
    }
    const valueOf = isSortColumn(column) ? SORT_VALUE[column] : () => null;
    const [left, right] = [valueOf(a.row), valueOf(b.row)];
    const compared = left === null || right === null ? 0 : direction * compareMoney(left, right);
    return compared || byName(a, b);
  });

  const page = pageOf(ordered, query);
  const total = (field: 'openingValue' | 'closingValue') =>
    withValue ? sumMoney(rows.map((item) => item.row[field] ?? '0')) : null;
  return {
    items: page.items.map((item) => item.row),
    nextCursor: page.nextCursor,
    withValue,
    totals: {
      variants: rows.length,
      openingValue: total('openingValue'),
      closingValue: total('closingValue'),
    },
  };
}
```

- **`vatLines()` is the API's `vatLines` SQL, one array per kind of document.** Each line keeps its document's
  number, party, branch and Mushak number, and its own rate copy (`taxRate`), never today's `taxRates` row: a rate
  renamed later must not move an old sale (decision 14).
- **`linesOf()` turns a credit note, a POS return and a debit note negative** (`returned`). Adding the lines up then
  gives the period, as in the SQL, and `returned` is what the strip's "taken off" lines add up.
- **A POS return line takes its rate from the sale's line.** It has no rate of its own (21c.3 does the same join).
  A return whose sale is not there is skipped, not counted at a guessed rate.
- **The branch of each document** is decision 19's: an invoice's and a bill's own, a credit note's invoice's (its
  `branchId` already is), a POS document's warehouse's (`branchOf`).
- **The key is `id:kind:percent`** (decision 14), and the row's name is its latest line's. A rate that changed in the
  month is two rows, each with the name it had.
- **`byReturnOrder` sorts like the SQL's `KIND_ORDER`:** `TAX_RATE_KINDS` is already standard, reduced, zero-rated,
  exempt, so its index is the order.
- **`booksVat` reads the journal's posted lines**, credit less debit on `vat_output`, debit less credit on
  `vat_input`, in the period and the branch: what the API reads from `account_day_totals`. The mock's documents post
  to those accounts, so a mock that agrees with itself shows "Books agree".
- **`vatDocumentsOf` adds a document's lines into one row** and sorts by date, number and id, the API's order. It is
  paged by `pageOf` like every mock list.
- **`stockMovementOf` adds the ledger up from its first movement.** The API works back from the stock it holds now
  (decision 5), because its ledger is long. The mock's ledger is short and complete, so adding forward is simpler and
  gives the same numbers. A movement before `from` is opening, one up to `to` is closing, and one in between also
  goes into its column (`STOCK_MOVEMENT_COLUMN_OF`, "sold" turned round, decision 21). A revaluation has no column but
  counts as moved, like the API's `bool_or`.
- **`show: 'all'` adds what had stock at the start** (decision 22). A variant with no movement up to `to` never has a
  row, here as there.
- **The sort is the column, then the name, the product and the variant's place,** the API's `BY_NAME`, so two pages
  never repeat a row. `SORT_VALUE` has only the number columns: the name and the SKU compare as text. The value
  columns are `null` without the permission, and the handler refuses a value sort before this runs.
- **The totals are over every row, before the page,** like the SQL's window functions: the strip says the same on
  every page.

### `apps/app/src/mocks/trade-report-data.ts`: one function shared

```diff
@@ -95,8 +95,9 @@ function sorted<R extends RowIdentity>(
   });
 }
 
-// This category and every one under it (the API's inCategory)
-function categoryAndBelow(data: WorkspaceData, categoryId: string): Set<string> {
+// This category and every one under it (the API's inCategory). Step 21c: the stock movement
+// report's mock reads it too (vat-stock-report-data.ts).
+export function categoryAndBelow(data: WorkspaceData, categoryId: string): Set<string> {
   const found = new Set([categoryId]);
   for (let grew = true; grew;) {
     grew = false;
```

The category filter of the stock movement report is the sales report's: this category and every one under it. One
function, exported, so the two mocks cannot disagree.

### `apps/app/src/mocks/vat-month-data.ts` (new): last month's documents with VAT

```ts
import { shiftIsoDate, todayIn } from '@omnivo/contracts';

import { saveBill, submitBill } from './bill-data';
import { postInvoice, saveInvoice } from './invoice-data';
import { createSale } from './pos-data';
import { postDebitNote, saveDebitNote } from './purchase-return-data';
import { postCreditNote, saveCreditNote } from './return-data';
import type { WorkspaceData } from './workspace-data';

// Step 21c: last month's documents with VAT, in the garments workspace, for the VAT report. The
// year of trade (trade-history-data.ts) is all Exempt, so it shows no VAT. Real documents, made by
// the mock's own functions, so the books' VAT accounts agree with the report. Last month, because
// the VAT page opens there (decision 60). In that month:
//
//   Output  invoice Primark (Head office)   20 T-shirts × 250 = 5,000 at 15%    VAT 750
//           credit note on it (price cut)    2 × 250 =  −500 at 15%              VAT −75
//           POS sale, walk-in               4 T-shirts × 300 = 1,200 at 15%     VAT 180
//           invoice H&M (Gazipur factory)   10 polos × 500 = 5,000 zero-rated   VAT 0
//           = net 10,700, VAT 855, of which 75 taken back
//   Input   bill Meghna, Mushak 6.3          1,000 buttons × 5 = 5,000 at 15%   VAT 750
//                                            truck rent 1,000 at 15%             VAT 150
//           bill Gazipur Carton, no 6.3      500 mailers × 6 = 3,000 at 15%      VAT 450
//           debit note on Meghna (price cut) 100 × 5 = −500 at 15%               VAT −75
//           = net 8,500, VAT 1,275, of which 75 taken back, 450 with no Mushak 6.3
//   Net VAT 855 − 1,275 = −420: ৳420 to carry forward
export function seedVatMonth(data: WorkspaceData): void {
  const product = (code: string) => data.catalog.products.find((item) => item.code === code);
  const customer = (name: string) =>
    data.sales.customers.find((item) => item.name.startsWith(name));
  const supplier = (name: string) =>
    data.suppliers.suppliers.find((item) => item.name.startsWith(name));
  const rate = (name: string) => data.sales.taxRates.find((item) => item.name === name);
  const branch = (code: string) => data.branches.find((item) => item.code === code);
  const [main] = data.stock.warehouses;
  const standard = rate('VAT 15%');
  const zero = rate('Zero-rated');
  const hm = customer('H&M');
  const primark = customer('Primark');
  const meghna = supplier('Meghna');
  const carton = supplier('Gazipur Carton');
  const polo = product('ST-118');
  const tee = product('P-00001');
  const buttons = product('P-00003');
  const mailers = product('P-00004');
  const transport = data.accounts.find((item) => item.code === '5170');
  const head = branch('HO');
  const factory = branch('GZP');
  const counter = data.pos.registers.find((item) => item.code === 'POS2');
  if (
    !main ||
    !standard ||
    !zero ||
    !hm ||
    !primark ||
    !meghna ||
    !carton ||
    !polo ||
    !tee ||
    !buttons ||
    !mailers ||
    !transport ||
    !head ||
    !factory ||
    !counter?.deviceId
  ) {
    return;
  }

  // Day `day` of last month: the day before this month's first day is in last month
  const lastMonth = shiftIsoDate(`${todayIn(data.settings.timezone).slice(0, 7)}-01`, -1).slice(
    0,
    7,
  );
  const day = (number: number) => `${lastMonth}-${String(number).padStart(2, '0')}`;

  const priceless = { description: null, discountType: 'percent', discount: '0' } as const;
  const variantOf = (goods: { variants: { id: string }[] }) => goods.variants[0]?.id ?? '';

  const invoice = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    taxRateId: string,
    date: string,
    branchId: string,
  ) => {
    const draft = saveInvoice(data, {
      customerId: who.id,
      date,
      note: null,
      dueDate: shiftIsoDate(date, 30),
      customerReference: null,
      branchId,
      warehouseId: main.id,
      lines: [
        {
          ...priceless,
          variantId: variantOf(goods),
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId,
          deliveryLineId: null,
          orderLineId: null,
          batchId: null,
          serialNumbers: [],
        },
      ],
    });
    postInvoice(data, draft, true);
    return draft;
  };

  const bill = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    date: string,
    expenses: { accountId: string; description: string; amount: string; taxRateId: string }[],
    numbers: { supplierBillNumber: string; mushakNumber: string | null },
  ) => {
    const saved = saveBill(data, {
      supplierId: who.id,
      date,
      dueDate: shiftIsoDate(date, 30),
      supplierBillNumber: numbers.supplierBillNumber,
      mushakNumber: numbers.mushakNumber,
      mushakDate: numbers.mushakNumber === null ? null : date,
      branchId: head.id,
      warehouseId: main.id,
      pricesIncludeVat: false,
      note: null,
      lines: [
        {
          ...priceless,
          variantId: variantOf(goods),
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId: standard.id,
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

  // ---- Output ----
  const primarkInvoice = invoice(primark, tee, '20', '250', standard.id, day(5), head.id);
  invoice(hm, polo, '10', '500', zero.id, day(15), factory.id);

  const [primarkLine] = primarkInvoice.lines;
  if (primarkLine) {
    postCreditNote(
      data,
      saveCreditNote(data, {
        invoiceId: primarkInvoice.id,
        date: day(12),
        reason: 'price_adjustment',
        note: null,
        lines: [
          {
            ...priceless,
            invoiceLineId: primarkLine.id,
            returnLineId: null,
            unitId: primarkLine.unitId,
            quantity: '2',
            unitPrice: '250',
          },
        ],
      }),
    );
  }

  createSale(data, counter.deviceId, crypto.randomUUID(), {
    registerId: counter.id,
    sequence: 180,
    shiftId: null,
    date: day(8),
    soldAt: `${day(8)}T06:00:00.000Z`,
    customerId: null,
    pricesIncludeVat: false,
    billDiscountType: 'percent',
    billDiscount: '0',
    payments: [{ method: 'cash', amount: '1380', reference: null, returnId: null }],
    lines: [
      {
        ...priceless,
        id: null,
        variantId: variantOf(tee),
        unitId: tee.baseUnitId,
        quantity: '4',
        unitPrice: '300',
        taxRateId: standard.id,
        rate: '15.00',
        startingPrice: null,
        batchId: null,
        serialNumbers: [],
      },
    ],
  });

  // ---- Input ----
  const meghnaBill = bill(
    meghna,
    buttons,
    '1000',
    '5',
    day(10),
    [
      {
        accountId: transport.id,
        description: 'Truck rent, Narsingdi to the Main store',
        amount: '1000',
        taxRateId: standard.id,
      },
    ],
    { supplierBillNumber: 'MSM-2026-1180', mushakNumber: 'MSM-6.3-0918' },
  );
  bill(carton, mailers, '500', '6', day(18), [], {
    supplierBillNumber: 'GCI-2026-0290',
    mushakNumber: null,
  });

  const [meghnaLine] = meghnaBill.lines;
  if (meghnaLine) {
    postDebitNote(
      data,
      saveDebitNote(data, {
        supplierId: meghna.id,
        billId: meghnaBill.id,
        date: day(20),
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
}
```

- **The numbers in the comment at the top are the tests' numbers.** The e2e tests check them, so a change here is a
  change there.
- **Real documents, made by the mock's own functions** (`saveInvoice` and `postInvoice`, `createSale`,
  `saveBill` and `submitBill`, the credit and debit notes), like 21b's year of trade. So the books get their VAT lines
  from the same posting code, and a document number in the VAT list opens a real document.
- **Every case of the report is in it:** two rates (15% and zero-rated), a credit note and a debit note that take VAT
  off, a POS sale, a bill with an expense line, a bill with a Mushak 6.3 number and one without, and documents in two
  branches. The net comes out negative, so the "to carry forward" words are tested too.
- **Day 5 to day 20 of last month.** Every month has those days, and the VAT page opens on last month (decision 60).
- **It stops quietly when something is missing** (a product renamed in the seed): a mock must not break
  `pnpm dev:mock` over its demo data.

### `apps/app/src/mocks/report-schedule-data.ts` (new): the schedules

```ts
import {
  type AuditChanges,
  type AuditValue,
  type ExportFormat,
  MAX_REPORT_SCHEDULES,
  nextReportScheduleRun,
  type PermissionKey,
  type ReportKind,
  REPORT_KIND_PERMISSIONS,
  reportKindsFor,
  type ReportSchedule,
  type ReportScheduleCandidateList,
  reportScheduleFiltersOf,
  type ReportScheduleInput,
  type ReportScheduleList,
  type ReportSchedulePauseReason,
  type ReportScheduleStatus,
  type ReportScheduleUpdate,
  type ReportScheduleWhen,
} from '@omnivo/contracts';

import { OWNER } from './fixtures';
import { MockProblem } from './mock';
import { record, type WorkspaceData } from './workspace-data';

// Step 21c: the workspace's scheduled report emails, with the API's rules
// (report-schedules.service.ts): at most 20, recipients who are members and may read the report,
// the report and its filters fixed once saved (decision 10), version checks, a resume refused while
// nobody on it may read the report. The mock has no worker: nothing is ever sent, so lastRunAt
// stays what the seed gave.

// A schedule as stored: the recipients and the creator by id, like the API's rows. Their names,
// whether each may still get it and the filters' names are worked out on read.
export interface MockReportSchedule {
  id: string;
  version: number;
  report: ReportKind;
  format: ExportFormat;
  when: ReportScheduleWhen;
  filters: Record<string, string>;
  recipientIds: string[];
  status: ReportScheduleStatus;
  pausedReason: ReportSchedulePauseReason | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdBy: string;
  createdAt: string;
}

// The members whose roles hold a permission (the API's permissionHolders)
function holdersOf(data: WorkspaceData, permission: PermissionKey): Set<string> {
  const roles = new Set(
    data.people.roles
      .filter((role) => role.permissions.includes(permission))
      .map((role) => role.id),
  );
  return new Set(
    data.people.members
      .filter((member) => member.roles.some((role) => roles.has(role.id)))
      .map((member) => member.userId),
  );
}

// A filter's name as the API's filterNames gives it: a branch or a warehouse with its code
function nameOf(data: WorkspaceData, id: string | undefined): string | null {
  if (id === undefined) return null;
  const place = [...data.branches, ...data.stock.warehouses].find((item) => item.id === id);
  if (place) return `${place.code} · ${place.name}`;
  const named = [...data.sales.groups, ...data.suppliers.groups, ...data.catalog.categories].find(
    (item) => item.id === id,
  );
  return named?.name ?? null;
}

function present(data: WorkspaceData, item: MockReportSchedule): ReportSchedule {
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[item.report]);
  const members = new Map(data.people.members.map((member) => [member.userId, member]));
  return {
    id: item.id,
    version: item.version,
    report: item.report,
    format: item.format,
    when: item.when,
    filters: item.filters,
    filterNames: {
      branch: nameOf(data, item.filters.branchId),
      warehouse: nameOf(data, item.filters.warehouseId),
      group: nameOf(data, item.filters.customerGroupId ?? item.filters.supplierGroupId),
      category: nameOf(data, item.filters.categoryId),
    },
    // A person who left is no member any more: no name to show, so the API's join leaves them out
    recipients: item.recipientIds.flatMap((userId) => {
      const member = members.get(userId);
      return member
        ? [
            {
              userId,
              name: member.fullName,
              email: member.email,
              canReceive: holders.has(userId),
            },
          ]
        : [];
    }),
    status: item.status,
    pausedReason: item.pausedReason,
    nextRunAt: item.nextRunAt,
    lastRunAt: item.lastRunAt,
    createdByName: members.get(item.createdBy)?.fullName ?? '',
    createdAt: item.createdAt,
  };
}

function nextRun(data: WorkspaceData, when: ReportScheduleWhen): string {
  return nextReportScheduleRun(when, data.settings.timezone, new Date()).toISOString();
}

// The person signed in must read the report too (scheduleRouteBase)
function checkReport(report: ReportKind, permissions: readonly string[]): void {
  if (!permissions.includes(REPORT_KIND_PERMISSIONS[report])) {
    throw new MockProblem(403, 'permission_missing');
  }
}

function checkRecipients(data: WorkspaceData, report: ReportKind, ids: readonly string[]): void {
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[report]);
  if (!ids.every((id) => holders.has(id))) {
    throw new MockProblem(409, 'report_schedule_recipient_invalid', {
      recipientIds: ['report_schedule_recipient_invalid'],
    });
  }
}

// A schedule of a report this person may not read is not found, like the list leaves it out
function find(data: WorkspaceData, id: string, permissions: readonly string[]) {
  const found = data.reportSchedules.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  checkReport(found.report, permissions);
  return found;
}

// What the audit log keeps of a schedule (the API's snapshot)
function snapshot(item: MockReportSchedule): Record<string, AuditValue> {
  return {
    report: item.report,
    format: item.format,
    frequency: item.when.frequency,
    hour: item.when.hour,
    weekday: item.when.frequency === 'weekly' ? item.when.weekday : null,
    dayOfMonth: item.when.frequency === 'monthly' ? item.when.dayOfMonth : null,
    recipients: item.recipientIds.join(', '),
    status: item.status,
  };
}

// Only the fields that changed, as { from, to }: the API's diff(). Both sides' fields, so a
// creation (nothing before) lists every field.
function changesOf(
  before: Record<string, AuditValue>,
  after: Record<string, AuditValue>,
): AuditChanges {
  const changes: AuditChanges = {};
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export function scheduleListOf(
  data: WorkspaceData,
  permissions: readonly string[],
): ReportScheduleList {
  const kinds = new Set<string>(reportKindsFor(permissions));
  return {
    items: data.reportSchedules
      .filter((item) => kinds.has(item.report))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((item) => present(data, item)),
    timeZone: data.settings.timezone,
  };
}

export function scheduleCandidatesOf(
  data: WorkspaceData,
  report: ReportKind,
  permissions: readonly string[],
): ReportScheduleCandidateList {
  checkReport(report, permissions);
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[report]);
  return {
    items: data.people.members
      .filter((member) => holders.has(member.userId))
      .map((member) => ({ userId: member.userId, name: member.fullName, email: member.email }))
      .toSorted(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
          a.userId.localeCompare(b.userId),
      ),
  };
}

export function createSchedule(
  data: WorkspaceData,
  input: ReportScheduleInput,
  permissions: readonly string[],
): ReportSchedule {
  checkReport(input.report, permissions);
  if (data.reportSchedules.length >= MAX_REPORT_SCHEDULES) {
    throw new MockProblem(409, 'report_schedule_limit');
  }
  checkRecipients(data, input.report, input.recipientIds);
  const item: MockReportSchedule = {
    id: crypto.randomUUID(),
    version: 1,
    report: input.report,
    format: input.format,
    when: input.when,
    // decision 29: only the filters are kept, never the dates
    filters: reportScheduleFiltersOf(input.query),
    recipientIds: [...input.recipientIds],
    status: 'active',
    pausedReason: null,
    nextRunAt: nextRun(data, input.when),
    lastRunAt: null,
    createdBy: OWNER.id,
    createdAt: new Date().toISOString(),
  };
  data.reportSchedules.push(item);
  record(
    data,
    'report_schedule.created',
    'report_schedule',
    item.id,
    changesOf({}, snapshot(item)),
  );
  return present(data, item);
}

export function updateSchedule(
  data: WorkspaceData,
  id: string,
  input: ReportScheduleUpdate,
  permissions: readonly string[],
): ReportSchedule {
  const item = find(data, id, permissions);
  if (item.version !== input.version) throw new MockProblem(409, 'version_conflict');
  checkRecipients(data, item.report, input.recipientIds);
  const before = snapshot(item);
  Object.assign(item, {
    format: input.format,
    when: input.when,
    recipientIds: [...input.recipientIds],
    // A new time moves the next run; a paused schedule stays without one
    nextRunAt: item.status === 'active' ? nextRun(data, input.when) : null,
    version: item.version + 1,
  });
  record(data, 'report_schedule.updated', 'report_schedule', id, changesOf(before, snapshot(item)));
  return present(data, item);
}

export function pauseSchedule(
  data: WorkspaceData,
  id: string,
  version: number,
  permissions: readonly string[],
): ReportSchedule {
  const item = find(data, id, permissions);
  if (item.version !== version) throw new MockProblem(409, 'version_conflict');
  if (item.status === 'paused') return present(data, item);
  Object.assign(item, {
    status: 'paused',
    pausedReason: 'manual',
    nextRunAt: null,
    version: item.version + 1,
  });
  record(data, 'report_schedule.paused', 'report_schedule', id, {
    status: { from: 'active', to: 'paused' },
    pausedReason: { from: null, to: 'manual' },
  });
  return present(data, item);
}

// decision 31: refused while nobody on it may read the report
export function resumeSchedule(
  data: WorkspaceData,
  id: string,
  version: number,
  permissions: readonly string[],
): ReportSchedule {
  const item = find(data, id, permissions);
  if (item.version !== version) throw new MockProblem(409, 'version_conflict');
  if (item.status === 'active') return present(data, item);
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[item.report]);
  if (!item.recipientIds.some((userId) => holders.has(userId))) {
    throw new MockProblem(409, 'report_schedule_no_recipients');
  }
  const reason = item.pausedReason;
  Object.assign(item, {
    status: 'active',
    pausedReason: null,
    // From now: the runs it missed while paused are not sent
    nextRunAt: nextRun(data, item.when),
    version: item.version + 1,
  });
  record(data, 'report_schedule.resumed', 'report_schedule', id, {
    status: { from: 'paused', to: 'active' },
    pausedReason: { from: reason, to: null },
  });
  return present(data, item);
}

// For real (decision 34); the files it sent stay on the Exports page
export function removeSchedule(
  data: WorkspaceData,
  id: string,
  permissions: readonly string[],
): void {
  const item = find(data, id, permissions);
  data.reportSchedules = data.reportSchedules.filter((candidate) => candidate.id !== id);
  const before = snapshot(item);
  record(
    data,
    'report_schedule.deleted',
    'report_schedule',
    id,
    changesOf(before, Object.fromEntries(Object.keys(before).map((field) => [field, null]))),
  );
}
```

- **A schedule is stored with ids** (recipients, creator), like the API's rows. `present()` reads the names, whether
  each person may still get it (`canReceive`) and the filters' names when it answers. So a role changed on the Roles
  page shows on the list at once, as it would with the real API.
- **`holdersOf()` is the API's `permissionHolders`:** the members whose roles hold the permission. The owner's role
  holds every permission, so the owner is always a candidate.
- **`nameOf()` names a branch or a warehouse "HO · Head office"**, the API's `filterNames` after decision 65.
- **Every rule the API has is here:** the report's own permission on every call (`checkReport`, and `find` refuses a
  schedule of a report the person may not read, as the list leaves it out), at most 20, recipients who may read the
  report, the version, no resume while nobody on it may read it (decision 31). A rule the mock skipped would be a path
  the e2e tests could never see fail.
- **`createSchedule` keeps only the filters** (`reportScheduleFiltersOf`, decision 29) and works out the first run
  with the contract's `nextReportScheduleRun`, the same function the API calls.
- **Pause and resume answer the schedule unchanged when it is already in that state,** like the API: two people
  pressing Pause at once is not an error.
- **The audit entries** use the API's actions and fields (`snapshot`), so the audit log page shows a schedule's history
  in mock mode too. `changesOf` takes the fields of both sides, so a creation (nothing before) lists every field.

### `apps/app/src/mocks/report-schedule-seed.ts` (new): the mockup's four schedules

```ts
import {
  nextReportScheduleRun,
  type ReportSchedulePauseReason,
  type ReportScheduleWhen,
} from '@omnivo/contracts';

import type { MockReportSchedule } from './report-schedule-data';
import type { WorkspaceData } from './workspace-data';

// Step 21c: the seed of the scheduled report emails. A file of its own, with type imports only:
// report-schedule-data.ts writes audit entries with workspace-data.ts's record(), and
// workspace-data.ts calls this seed, so one file would be an import cycle.
//
// The garments workspace's four schedules, as the approved mockup draws them: a monthly VAT report,
// a weekly sales report with one person on it who may not read it now (Kamal Uddin, the Purchase
// manager), a daily payables aging paused because nobody on it may read it, and a stock movement
// someone paused.

const DAY_MS = 24 * 60 * 60 * 1000;

function nextRun(data: WorkspaceData, when: ReportScheduleWhen): string {
  return nextReportScheduleRun(when, data.settings.timezone, new Date()).toISOString();
}

// The run before now: the last run of a schedule that has been going for a while
function lastRun(data: WorkspaceData, when: ReportScheduleWhen): string {
  const zone = data.settings.timezone;
  const now = new Date();
  let run = nextReportScheduleRun(when, zone, new Date(now.getTime() - 32 * DAY_MS));
  for (;;) {
    const next = nextReportScheduleRun(when, zone, run);
    if (next > now) return run.toISOString();
    run = next;
  }
}

export function seedReportSchedules(data: WorkspaceData): void {
  const person = (name: string) =>
    data.people.members.find((member) => member.fullName === name)?.userId;
  const nusrat = person('Nusrat Jahan');
  const rafiq = person('Rafiq Ahmed');
  const kamal = person('Kamal Uddin');
  const head = data.branches.find((item) => item.code === 'HO');
  const depot = data.stock.warehouses.find((item) => item.code === 'CTG');
  const yarn = data.suppliers.groups.find((item) => item.name === 'Yarn and fabric');
  if (!nusrat || !rafiq || !kamal || !head || !depot || !yarn) return;

  const made = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
  const schedule = (
    fields: Pick<MockReportSchedule, 'report' | 'format' | 'when' | 'filters' | 'recipientIds'> & {
      createdBy: string;
      createdAt: string;
      paused: ReportSchedulePauseReason | null;
      sent: boolean;
    },
  ): MockReportSchedule => ({
    id: crypto.randomUUID(),
    version: 1,
    report: fields.report,
    format: fields.format,
    when: fields.when,
    filters: fields.filters,
    recipientIds: fields.recipientIds,
    status: fields.paused === null ? 'active' : 'paused',
    pausedReason: fields.paused,
    nextRunAt: fields.paused === null ? nextRun(data, fields.when) : null,
    lastRunAt: fields.sent ? lastRun(data, fields.when) : null,
    createdBy: fields.createdBy,
    createdAt: fields.createdAt,
  });

  data.reportSchedules = [
    schedule({
      report: 'vat_report',
      format: 'pdf',
      when: { frequency: 'monthly', hour: 8, dayOfMonth: 1 },
      filters: {},
      recipientIds: [nusrat, rafiq],
      createdBy: nusrat,
      createdAt: made(90),
      paused: null,
      sent: true,
    }),
    schedule({
      report: 'sales_report',
      format: 'xlsx',
      when: { frequency: 'weekly', hour: 8, weekday: 0 },
      filters: { groupBy: 'customer', branchId: head.id, sort: '-net' },
      recipientIds: [nusrat, rafiq, kamal],
      createdBy: rafiq,
      createdAt: made(60),
      paused: null,
      sent: true,
    }),
    schedule({
      report: 'ap_aging',
      format: 'pdf',
      when: { frequency: 'daily', hour: 9 },
      filters: { supplierGroupId: yarn.id, show: 'all', sort: '-balance' },
      recipientIds: [kamal],
      createdBy: nusrat,
      createdAt: made(40),
      paused: 'no_recipients',
      sent: true,
    }),
    schedule({
      report: 'stock_movement',
      format: 'xlsx',
      when: { frequency: 'weekly', hour: 18, weekday: 6 },
      filters: { warehouseId: depot.id, show: 'moved', sort: 'name' },
      recipientIds: [nusrat, rafiq],
      createdBy: nusrat,
      createdAt: made(10),
      paused: 'manual',
      sent: false,
    }),
  ];
}
```

- **A file of its own, with type imports only.** `report-schedule-data.ts` writes audit entries with
  `workspace-data.ts`'s `record()`, and `workspace-data.ts` calls this seed. In one file that is an import cycle, which
  `pnpm boundaries` refuses. A type import is gone after the build, so it makes no cycle.
- **It draws the mockup's four rows** (decision 63). `lastRun()` finds the run before now by stepping
  `nextReportScheduleRun` forward from a month ago, so "Last sent" is a real past run on any day.

### `apps/app/src/mocks/people-data.ts`: the Finance desk

```diff
@@ -109,7 +109,10 @@ export function seedPeople(workspace: Workspace): People {
       };
     }),
   ];
-  if (workspace.slug === 'rahman-garments') addPurchaseDesk(roles, members);
+  if (workspace.slug === 'rahman-garments') {
+    addPurchaseDesk(roles, members);
+    addFinanceDesk(roles, members);
+  }
   return { roles, members, invitations: [] };
 }
 
@@ -247,3 +250,37 @@ export function demoPreview(token: string, workspace: Workspace): InvitationPrev
     expiresAt: expiry(),
   };
 }
+
+// Step 21c: the people the scheduled report emails go to (report-schedule-data.ts). Two, so the
+// dialog's "Send to" list is short and real; the Accountant role of the generated members has no
+// report permission, and giving it one would offer 60 people. After the purchase desk, so every
+// earlier member and role keeps its place.
+function addFinanceDesk(roles: MockRole[], members: Member[]): void {
+  const finance = role(
+    'Finance desk',
+    [
+      'accounting.report.read',
+      'sales.report.read',
+      'purchase.report.read',
+      'inventory.report.read',
+      'inventory.stock.value',
+      'core.report.schedule',
+    ],
+    'Monthly VAT, sales and stock reports for the directors',
+  );
+  roles.push(finance);
+  for (const [fullName, email] of [
+    ['Nusrat Jahan', 'nusrat.jahan@rahman-garments.com'],
+    ['Rafiq Ahmed', 'rafiq.ahmed@rahman-garments.com'],
+  ] as const) {
+    members.push({
+      membershipId: crypto.randomUUID(),
+      userId: crypto.randomUUID(),
+      fullName,
+      email,
+      roles: [{ id: finance.id, name: finance.name }],
+      version: 1,
+      joinedAt: new Date(Date.now() - 300 * DAY_MS).toISOString(),
+    });
+  }
+}
```

Two people with every report permission and `core.report.schedule` (decision 63). They are added after the purchase
desk, so every member and role the earlier tests name keeps its place.

### `apps/app/src/mocks/fixtures.ts` and `workspace-data.ts`: the new seeds

```diff
@@ -78,6 +78,20 @@ export function seedsTradeHistory(): boolean {
   }
 }
 
+// Step 21c: a month of documents with VAT, dated last month, for the VAT report
+// (vat-month-data.ts). Its own key, not the year of trade's: in July "last month" is the last
+// fiscal year, whose numbers the 21b tests read. A test asks for it with
+// test.use({ vatMonth: true }); `pnpm dev:mock` has no key and gets it.
+export const MOCK_NO_VAT_MONTH_KEY = 'omnivo.mock.noVatMonth';
+
+export function seedsVatMonth(): boolean {
+  try {
+    return localStorage.getItem(MOCK_NO_VAT_MONTH_KEY) === null;
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
-import { HEAD_OFFICES, OWNER, seedsTradeHistory, type Workspace } from './fixtures';
+import { HEAD_OFFICES, OWNER, seedsTradeHistory, seedsVatMonth, type Workspace } from './fixtures';
 import { emptyBilling, type MockBilling } from './invoice-data';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
@@ -46,6 +46,8 @@ import { seedPosShifts } from './pos-shift-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import { seedPurchaseOrders } from './purchase-order-data';
 import type { MockExport } from './report-data';
+import type { MockReportSchedule } from './report-schedule-data';
+import { seedReportSchedules } from './report-schedule-seed';
 import { emptyPurchase, type MockPurchase, seedPurchase } from './requisition-data';
 import { emptyReturns, type MockReturns } from './return-data';
 import { emptySales, type MockSales, seedSales } from './sales-data';
@@ -58,6 +60,7 @@ import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
 import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
 import { emptySync, type MockSync, seedDevices } from './sync-data';
 import { seedTradeHistory } from './trade-history-data';
+import { seedVatMonth } from './vat-month-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -105,6 +108,8 @@ export interface WorkspaceData {
   sync: MockSync;
   // POS registers and the sales their devices pushed (step 20a)
   pos: MockPos;
+  // Step 21c: the scheduled report emails, in the order they were made (report-schedule-data.ts)
+  reportSchedules: MockReportSchedule[];
 }
 
 function now(): string {
@@ -196,6 +201,7 @@ function seed(workspace: Workspace): WorkspaceData {
     purchase: emptyPurchase(),
     sync: emptySync(),
     pos: emptyPos(),
+    reportSchedules: [],
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   data.salesAccounts = seedSalesAccounts(data.accounts);
@@ -223,6 +229,10 @@ function seed(workspace: Workspace): WorkspaceData {
   seedPosShifts(data, garments);
   // Step 21b: last, because it uses the stock, the accounts and a counter
   if (garments && seedsTradeHistory()) seedTradeHistory(data);
+  // Step 21c: a month of documents with VAT, last month (vat-month-data.ts), and the four
+  // scheduled emails of the mockup, after the team and the warehouses they name
+  if (garments && seedsVatMonth()) seedVatMonth(data);
+  if (garments) seedReportSchedules(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
```

- **The VAT month has its own key** (decision 62), on in `pnpm dev:mock`, off in a test unless it asks.
- **It runs after the year of trade,** because it uses the same stock, accounts and POS counter.
- **The schedules are seeded in every garments workspace,** test or not. They change nothing another page reads, and
  the schedules tests need them.

### `apps/app/src/mocks/report-data.ts`: the file names

```diff
@@ -380,6 +380,9 @@ const STEMS = {
   purchase_report: 'purchases',
   ar_aging: 'receivables-aging',
   ap_aging: 'payables-aging',
+  // Step 21c
+  vat_report: 'vat',
+  stock_movement: 'stock-movement',
 } satisfies Record<ReportKind, string>;
 
 export function createExport(data: WorkspaceData, input: ReportExportInput): ReportExport {
```

The names the API's `fileStem()` gives. This was the type error left from 21c.1: `STEMS` must have every `ReportKind`.

### `apps/app/src/mocks/handlers.ts`

```diff
@@ -8,6 +8,7 @@ import {
   dashboardCardsFor,
   type ErrorCode,
   isCostSort,
+  isStockValueSort,
   type Preferences,
   type ProductCategory,
   routes,
@@ -148,6 +149,15 @@ import {
   toExport,
   trialBalanceOf,
 } from './report-data';
+import {
+  createSchedule,
+  pauseSchedule,
+  removeSchedule,
+  resumeSchedule,
+  scheduleCandidatesOf,
+  scheduleListOf,
+  updateSchedule,
+} from './report-schedule-data';
 import {
   apAgingOf,
   apAgingPartyOf,
@@ -156,6 +166,7 @@ import {
   purchaseReportOf,
   salesReportOf,
 } from './trade-report-data';
+import { stockMovementOf, vatDocumentsOf, vatReportOf } from './vat-stock-report-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -1539,6 +1550,107 @@ export const handlers = [
     }),
   ),
 
+  // Step 21c: VAT belongs to the accounts (decision 11), so the route's permission is enough
+  mock(routes.vatReport.summary, ({ request }) =>
+    reply(
+      routes.vatReport.summary,
+      vatReportOf(current(), readQuery(routes.vatReport.summary.query, request)),
+    ),
+  ),
+
+  mock(routes.vatReport.documents, ({ request }) =>
+    reply(
+      routes.vatReport.documents,
+      vatDocumentsOf(current(), readQuery(routes.vatReport.documents.query, request)),
+    ),
+  ),
+
+  // Without inventory.stock.value the values are null and a value sort is refused (decision 24),
+  // like the sales report's cost
+  mock(
+    routes.stockMovementReport.report,
+    guarded(({ request }) => {
+      const query = readQuery(routes.stockMovementReport.report.query, request);
+      const withValue = me().permissions.includes('inventory.stock.value');
+      if (!withValue && isStockValueSort(query.sort)) {
+        throw new MockProblem(403, 'permission_missing');
+      }
+      return reply(routes.stockMovementReport.report, stockMovementOf(current(), query, withValue));
+    }),
+  ),
+
+  // The schedules: each one also needs the report's own permission (report-schedule-data.ts)
+  mock(routes.reportSchedules.list, () =>
+    reply(routes.reportSchedules.list, scheduleListOf(current(), me().permissions)),
+  ),
+
+  mock(
+    routes.reportSchedules.candidates,
+    guarded(({ request }) => {
+      const { report } = readQuery(routes.reportSchedules.candidates.query, request);
+      return reply(
+        routes.reportSchedules.candidates,
+        scheduleCandidatesOf(current(), report, me().permissions),
+      );
+    }),
+  ),
+
+  mock(
+    routes.reportSchedules.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.reportSchedules.create.body, request);
+      return reply(
+        routes.reportSchedules.create,
+        createSchedule(current(), body, me().permissions),
+      );
+    }),
+  ),
+
+  mock(
+    routes.reportSchedules.update,
+    guarded(async ({ params, request }) => {
+      const { id } = routes.reportSchedules.update.params.parse(params);
+      const body = await readBody(routes.reportSchedules.update.body, request);
+      return reply(
+        routes.reportSchedules.update,
+        updateSchedule(current(), id, body, me().permissions),
+      );
+    }),
+  ),
+
+  mock(
+    routes.reportSchedules.pause,
+    guarded(async ({ params, request }) => {
+      const { id } = routes.reportSchedules.pause.params.parse(params);
+      const { version } = await readBody(routes.reportSchedules.pause.body, request);
+      return reply(
+        routes.reportSchedules.pause,
+        pauseSchedule(current(), id, version, me().permissions),
+      );
+    }),
+  ),
+
+  mock(
+    routes.reportSchedules.resume,
+    guarded(async ({ params, request }) => {
+      const { id } = routes.reportSchedules.resume.params.parse(params);
+      const { version } = await readBody(routes.reportSchedules.resume.body, request);
+      return reply(
+        routes.reportSchedules.resume,
+        resumeSchedule(current(), id, version, me().permissions),
+      );
+    }),
+  ),
+
+  mock(
+    routes.reportSchedules.remove,
+    guarded(({ params }) => {
+      const { id } = routes.reportSchedules.remove.params.parse(params);
+      removeSchedule(current(), id, me().permissions);
+      return reply(routes.reportSchedules.remove, undefined);
+    }),
+  ),
+
   // Step 21a: the cards of the person signed in (me(): the owner, or the role a test left), the
   // others null, like the API's DashboardService
   mock(routes.dashboard.get, ({ request }) =>
```

- **The stock movement handler is the sales report's pattern:** the value comes from the person signed in (`me()`,
  the owner or the role a test left), and a value sort without it is a 403 (decision 24).
- **Each schedule handler passes `me().permissions`,** so the report's own permission is checked as the API checks it.
- **`remove` answers `undefined`:** the route's status is 204, and `reply()` sends no body for it.

### `apps/app/e2e/helpers.ts`

```diff
@@ -5,6 +5,7 @@ import { test as base, expect, type Locator, type Page, type Response } from '@p
 import {
   HEAD_OFFICES,
   MOCK_NO_HISTORY_KEY,
+  MOCK_NO_VAT_MONTH_KEY,
   MOCK_ROLE_KEY,
   type MockRole,
   OWNER,
@@ -56,19 +57,27 @@ export const test = base.extend<{
   seedDevice: boolean;
   answerPinDialog: boolean;
   tradeHistory: boolean;
+  vatMonth: boolean;
 }>({
   seedDevice: [true, { option: true }],
   answerPinDialog: [true, { option: true }],
   // Step 21b: the year of invoices and bills the reports read (fixtures.ts → MOCK_NO_HISTORY_KEY)
   tradeHistory: [false, { option: true }],
+  // Step 21c: last month's documents with VAT (fixtures.ts → MOCK_NO_VAT_MONTH_KEY)
+  vatMonth: [false, { option: true }],
   // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
-  page: async ({ page, seedDevice, answerPinDialog, tradeHistory }, provide) => {
+  page: async ({ page, seedDevice, answerPinDialog, tradeHistory, vatMonth }, provide) => {
     copies.set(page, copyOf(page));
     if (!tradeHistory) {
       await page.addInitScript((key) => {
         localStorage.setItem(key, '1');
       }, MOCK_NO_HISTORY_KEY);
     }
+    if (!vatMonth) {
+      await page.addInitScript((key) => {
+        localStorage.setItem(key, '1');
+      }, MOCK_NO_VAT_MONTH_KEY);
+    }
     if (answerPinDialog) {
       // A new seeded device always asks once; without the seed the branch dialog comes first
       if (seedDevice) pinWaiting.add(page);
```

The `vatMonth` option works like `tradeHistory`: off by default, so every older test sees the workspace it always saw.

### `apps/app/e2e/vat-stock-reports.e2e.ts` (new)

```ts
import { fiscalYearOf, shiftIsoDate, todayIn } from '@omnivo/contracts';
import type { Locator, Page } from '@playwright/test';

import { actAs, expect, expectNoSideScroll, readOnlyItem, test, waitForCopy } from './helpers.js';

// Step 21c: the VAT report and the stock movement report on the mock.

// A cell of the KPI strip, by its label. The tables' headers have the same words, so only the
// strip's caption is looked for (like trade-reports.e2e.ts).
function kpi(page: Page, label: string): Locator {
  return page.locator('span.text-caption', { hasText: new RegExp(`^${label}$`) }).locator('..');
}

// A row of the VAT rates table. It stays a table on a phone, scrolling inside its card.
function rateRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ hasText: name });
}

test.describe('VAT report', () => {
  // Last month's documents with VAT (mocks/vat-month-data.ts), the month the page opens at
  // (decision 60). In that month: output net ৳10,700, VAT ৳855 (৳75 of it taken back by a credit
  // note); input net ৳8,500, VAT ৳1,275 (৳75 taken back by a debit note, ৳450 on a bill with no
  // Mushak 6.3). Net VAT ৳855 − ৳1,275: ৳420 to carry forward.
  test.use({ vatMonth: true });

  async function openVat(page: Page): Promise<void> {
    await page.goto('/reports/vat');
    await waitForCopy(page);
    await expect(page.getByRole('heading', { level: 1, name: 'VAT report' })).toBeVisible();
    await expect(page.getByLabel('Period')).toHaveValue('last_month');
  }

  test('adds up last month by rate, to the paisa, and agrees with the books', async ({ page }) => {
    await openVat(page);
    await expect(kpi(page, 'Output VAT')).toContainText('৳855.00');
    await expect(kpi(page, 'Output VAT')).toContainText(
      '৳75.00 taken off by credit notes and POS returns',
    );
    await expect(kpi(page, 'Input VAT')).toContainText('৳1,275.00');
    await expect(kpi(page, 'Input VAT')).toContainText('৳75.00 taken off by debit notes');
    await expect(kpi(page, 'Input VAT')).toContainText(
      '৳450.00 on bills with no Mushak 6.3 number',
    );
    // More paid than charged: the strip shows the amount without its sign, and says what it is
    await expect(kpi(page, 'Net VAT')).toContainText('৳420.00');
    await expect(kpi(page, 'Net VAT')).toContainText('To carry forward');

    // One books line per side, each with its own pill
    await expect(page.getByText('Books agree')).toHaveCount(2);
    await expect(page.getByText('Output VAT in the books: ৳855.00')).toBeVisible();
    await expect(page.getByText('Input VAT in the books: ৳1,275.00')).toBeVisible();

    // Standard first; zero-rated is its own row, never folded into another 0%
    const standard = rateRow(page, 'VAT 15% · 15%');
    await expect(standard).toContainText('৳5,700.00');
    await expect(standard).toContainText('৳855.00');
    await expect(standard).toContainText('৳8,500.00');
    await expect(standard).toContainText('৳1,275.00');
    await expect(standard).toContainText('৳420.00 to carry forward');
    const zero = rateRow(page, 'Zero-rated · 0%');
    await expect(zero).toContainText('৳5,000.00');
    await expect(rateRow(page, 'Total')).toContainText('৳10,700.00');
    await expect(page.getByRole('row').filter({ hasText: 'Exempt' })).toHaveCount(0);
    await expectNoSideScroll(page);
  });

  test('lists the documents behind each side, oldest first', async ({ page }, testInfo) => {
    await openVat(page);
    // Output: the two invoices, the POS sale and the credit note, which takes VAT off
    await expect(readOnlyItem(page, 'Walk-in customer')).toContainText('৳180.00');
    const credit = readOnlyItem(page, 'Credit note');
    await expect(credit).toContainText('-৳500.00');
    await expect(credit).toContainText('-৳75.00');
    if (testInfo.project.name === 'desktop') {
      const rows = page.getByRole('table', { name: 'Documents' }).getByRole('row');
      // The header row, then the 5th, the 8th, the 12th and the 15th of the month
      await expect(rows).toHaveCount(5);
      await expect(rows.nth(1)).toContainText('Primark');
      await expect(rows.nth(2)).toContainText('POS sale');
      await expect(rows.nth(3)).toContainText('Credit note');
      await expect(rows.nth(4)).toContainText('H&M');
      // Not sortable: the server's order is the register's order (decision 18)
      await expect(page.getByRole('button', { name: /^Sort by/ })).toHaveCount(0);
    }

    // Input: the two bills and the debit note. One row per document: Meghna's bill is its
    // buttons and its truck rent together. A bill without its Mushak 6.3 says so.
    await page.getByText('Input', { exact: true }).click();
    const meghna = readOnlyItem(page, 'MSM-6.3-0918');
    await expect(meghna).toContainText('৳6,000.00');
    await expect(meghna).toContainText('৳900.00');
    await expect(readOnlyItem(page, 'Gazipur Carton')).toContainText('No Mushak 6.3');
    await expect(readOnlyItem(page, 'Debit note')).toContainText('-৳75.00');
    await expect(readOnlyItem(page, 'Primark')).toHaveCount(0);
  });

  test('a branch keeps only that branch’s documents', async ({ page }) => {
    await openVat(page);
    await expect(kpi(page, 'Output VAT')).toContainText('৳855.00');
    await page
      .getByLabel('Branch', { exact: true })
      .selectOption({ label: 'GZP · Gazipur factory' });
    // Only H&M's zero-rated invoice was made there
    await expect(kpi(page, 'Output VAT')).toContainText('৳0.00');
    await expect(kpi(page, 'Net VAT')).toContainText('Nothing to pay');
    await expect(rateRow(page, 'Zero-rated · 0%')).toContainText('৳5,000.00');
    await expect(rateRow(page, 'VAT 15% · 15%')).toHaveCount(0);
    await expect(page.getByText('Books agree')).toHaveCount(2);
  });

  test('a period with no VAT says so', async ({ page }) => {
    await openVat(page);
    await expect(kpi(page, 'Output VAT')).toContainText('৳855.00');
    // Nothing was posted in the last fiscal year without the year of trade
    await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
    await expect(page.getByRole('heading', { name: 'No VAT in these dates' })).toBeVisible();
  });
});

test.describe('stock movement report', () => {
  // The workspace's own stock (mocks/stock-data.ts): opening stock a week ago at the Main store
  // (480 T-shirts at ৳185), and 48 of them sent to the Chattogram depot yesterday, still on the
  // truck. "This fiscal year" with "Also what did not move", so every product has its row on any
  // day. In the first week of July the week-old stock is from the year before: its opening, not its
  // movement. The test works out which, so it passes on every day.
  const today = todayIn('Asia/Dhaka');
  const yearStart = fiscalYearOf(today, 7).start;
  const openedBefore = shiftIsoDate(today, -7) < yearStart;
  const sentBefore = shiftIsoDate(today, -1) < yearStart;
  const pcs = (quantity: number) =>
    quantity === 0 ? '—' : `${quantity < 0 ? '-' : ''}${String(Math.abs(quantity))} pcs`;

  async function openStock(page: Page): Promise<void> {
    await page.goto('/reports/stock-movement');
    await waitForCopy(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Stock movement' })).toBeVisible();
    await page.getByLabel('Period').selectOption({ label: 'This fiscal year' });
    await page.getByLabel('Show').selectOption({ label: 'Also what did not move' });
  }

  test('opens, moves and closes each product in its base unit', async ({ page }, testInfo) => {
    await openStock(page);
    // 6 polo variants, the T-shirt, the fabric, the buttons, the mailers and the machine
    await expect(kpi(page, 'Products')).toContainText('11');
    await expect(kpi(page, 'Closing value')).toContainText('৳12,53,620');

    const tee = readOnlyItem(page, 'Basic crew-neck T-shirt');
    // closing = opening + purchased − sold + transfers + adjusted
    await expect(tee).toContainText('432 pcs');
    await expect(tee).toContainText('৳79,920');
    if (!openedBefore) await expect(tee).toContainText(pcs(480));
    // A minus in Transfers: the 48 are on the truck, in no warehouse
    if (!sentBefore) await expect(tee).toContainText(pcs(-48));
    await expect(page.getByText(/A minus in Transfers is stock still on the way/)).toBeVisible();
    // Metres keep the unit's decimals. The fabric is the last row: a phone's card list draws only
    // the cards on the screen.
    if (testInfo.project.name === 'desktop') {
      await expect(readOnlyItem(page, 'Single jersey 180 GSM')).toContainText('1,250.50 m');
    }
    await expectNoSideScroll(page);
  });

  test('a warehouse counts only its own movements', async ({ page }) => {
    await openStock(page);
    await expect(kpi(page, 'Products')).toContainText('11');
    await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
    // The truck has left the Main store: 480 less 48
    await expect(readOnlyItem(page, 'Basic crew-neck T-shirt')).toContainText('432 pcs');

    // Nothing reached the depot yet
    await page.getByLabel('Warehouse').selectOption({ label: 'CTG · Chattogram depot' });
    await expect(page.getByRole('heading', { name: 'Nothing moved in these dates' })).toBeVisible();
  });

  test('sorts on the server, by a click on the header', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'A phone shows cards, with no headers');
    await openStock(page);
    const rows = page.getByRole('table', { name: 'Stock movement' }).getByRole('row');
    // A to Z at first
    await expect(rows.nth(1)).toContainText('Basic crew-neck T-shirt');
    // The header's name is its sort button's; exact, or "Closing value" matches too
    const closing = { name: 'Sort by Closing', exact: true };
    await page.getByRole('button', closing).click();
    await expect(page.getByRole('columnheader', closing)).toHaveAttribute('aria-sort', 'ascending');
    // The 3 sewing machines are the least
    await expect(rows.nth(1)).toContainText('Juki DDL-8000A');
  });

  test('a row opens the stock card', async ({ page }) => {
    await openStock(page);
    await page
      .getByRole('link', { name: 'Open the stock card of Basic crew-neck T-shirt' })
      .click();
    await expect(page).toHaveURL(/\/stock\/[0-9a-f-]+$/);
  });

  test('without the stock value, the values are not there at all', async ({ page }) => {
    await actAs(page, { name: 'Store keeper', permissions: ['inventory.report.read'] });
    await openStock(page);
    await expect(kpi(page, 'Products')).toContainText('11');
    await expect(readOnlyItem(page, 'Basic crew-neck T-shirt')).toContainText('432 pcs');
    await expect(page.getByText('Closing value')).toHaveCount(0);
    await expect(page.getByText('৳79,920')).toHaveCount(0);
    // The store keeper reads this report, and no other in the Reports group
    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Stock movement' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'VAT report' })).toHaveCount(0);
  });
});
```

- **The VAT tests check every figure to the paisa:** the strip, both books lines, the rate rows and the total. A
  wrong sign or a document counted twice shows up in more than one place.
- **The documents' order is checked on a computer only,** where the rows are a table. A phone shows cards, and the
  amounts are checked there through `readOnlyItem`, which finds a row or a card.
- **"Not sortable" is checked by its result:** no sort button in the documents table (decision 64).
- **The stock tests use the whole fiscal year and every product** (decision 66). `openedBefore` and `sentBefore` say
  whether the week-old stock and yesterday's truck are before this year; the test checks a movement only where it is
  one.
- **The last product is checked on a computer only.** A phone's card list draws only the cards on the screen.
- **Without `inventory.stock.value` no value is on the page at all,** not even the words "Closing value": a hidden
  column must not leave its header or its total behind.

### `apps/app/e2e/report-schedules.e2e.ts` (new)

```ts
import type { Locator, Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  openFromNav,
  readOnlyItem,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 21c: scheduled report emails on the mock (mocks/report-schedule-data.ts). The garments
// workspace has the four of the approved mockup: a monthly VAT report, a weekly sales report with
// Kamal Uddin on it (a Purchase manager, who may not read it), a daily payables aging paused because
// nobody on it may read it, and a stock movement someone paused. Nusrat Jahan and Rafiq Ahmed are the
// Finance desk, who read every report.

async function openSchedules(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
  await openFromNav(page, 'Scheduled emails');
}

// A schedule's row (a card on a phone), by its report's name
function scheduleRow(page: Page, report: string): Locator {
  return readOnlyItem(page, report);
}

async function rowAction(page: Page, report: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${report}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

test('emails a report on a schedule from its Export menu', async ({ page }) => {
  await page.goto('/reports/vat');
  await waitForCopy(page);
  await page.getByLabel('Branch', { exact: true }).selectOption({ label: 'GZP · Gazipur factory' });
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'Email on a schedule' }).click();

  const dialog = page.getByRole('dialog', { name: 'Email the VAT report on a schedule' });
  // The page's filters go with every email; its dates never do
  await expect(dialog.getByText('Branch: GZP · Gazipur factory')).toBeVisible();
  // Only the members who may read the report are offered
  await expect(dialog.getByRole('checkbox', { name: /Kamal Uddin/ })).toHaveCount(0);

  // Nobody ticked: the contract's own check, under the box
  await dialog.getByRole('button', { name: 'Schedule email' }).click();
  await expect(dialog.getByText('Pick at least one person to send it to.')).toBeVisible();

  await dialog.getByLabel('How often').selectOption({ label: 'Every month' });
  await expect(dialog.getByText('Each email has the whole month before.')).toBeVisible();
  await dialog.getByLabel('Day of the month').selectOption('5');
  await dialog.getByLabel('Time').selectOption({ label: '07:00' });
  await dialog.getByRole('checkbox', { name: /Nusrat Jahan/ }).check();
  await dialog.getByRole('button', { name: 'Schedule email' }).click();
  await toastShown(page, /^The VAT report is scheduled\. The first email goes on /);

  await openFromNav(page, 'Scheduled emails');
  await expect(page.getByText('5 of 20 scheduled emails')).toBeVisible();
  const made = scheduleRow(page, 'Branch: GZP · Gazipur factory');
  await expect(made).toContainText('Day 5 of every month at 07:00');
  await expect(made).toContainText('1 person');
  await expect(made).toContainText('Not sent yet');
  await expect(made).toContainText('Made by Farhana Rahman');
  await expectNoSideScroll(page);
});

test('a change keeps the filters and drops who may not read the report', async ({ page }) => {
  await openSchedules(page);
  const sales = scheduleRow(page, 'Sales report');
  await expect(sales).toContainText('Branch: HO · Head office');
  await expect(sales).toContainText('3 people');
  await expect(sales).toContainText('1 person gets nothing');

  await rowAction(page, 'Sales report', 'Change');
  const dialog = page.getByRole('dialog', { name: 'Change the Sales report email' });
  await expect(dialog.getByText('Group by: Customer')).toBeVisible();
  // Kamal is still listed, unticked and not to be ticked, with the reason
  const kamal = dialog.getByRole('checkbox', { name: /Kamal Uddin/ });
  await expect(kamal).not.toBeChecked();
  await expect(kamal).toBeDisabled();
  await expect(dialog.getByText('Gets nothing: may not read this report now')).toBeVisible();

  await dialog.getByLabel('How often').selectOption({ label: 'Every day' });
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'The Sales report email is changed');
  await expect(sales).toContainText('Every day at 08:00');
  await expect(sales).toContainText('2 people');
  await expect(sales).not.toContainText('gets nothing');
});

test('pauses, resumes and deletes a schedule', async ({ page }) => {
  await openSchedules(page);
  const stock = scheduleRow(page, 'Stock movement');
  await expect(stock).toContainText('Someone paused it. Resume it to send it again.');
  await rowAction(page, 'Stock movement', 'Resume');
  await toastShown(page, 'The Stock movement email is on again');
  await expect(stock).toContainText('Active');
  await expect(stock).toContainText('Every Saturday at 18:00');

  await rowAction(page, 'Stock movement', 'Pause');
  await toastShown(page, 'The Stock movement email is paused');
  await expect(stock).toContainText('Paused');

  // Nobody on it may read the payables aging: it would only pause itself again (decision 31)
  await rowAction(page, 'Payables aging', 'Resume');
  await expect(
    page.getByText('Nobody on this email may read the report now.', { exact: false }),
  ).toBeVisible();
  await expect(scheduleRow(page, 'Payables aging')).toContainText('Paused');

  await rowAction(page, 'VAT report', 'Delete');
  const confirm = page.getByRole('dialog', { name: 'Delete this scheduled email?' });
  await confirm.getByRole('button', { name: 'Delete schedule' }).click();
  await toastShown(page, 'The VAT report email is deleted');
  await expect(scheduleRow(page, 'VAT report')).toHaveCount(0);
  await expect(page.getByText('3 of 20 scheduled emails')).toBeVisible();
});

test('a person sees only the schedules of the reports they read', async ({ page }) => {
  await actAs(page, {
    name: 'Store keeper',
    permissions: ['inventory.report.read', 'core.report.schedule'],
  });
  await openSchedules(page);
  await expect(scheduleRow(page, 'Stock movement')).toContainText(
    'Warehouse: CTG · Chattogram depot',
  );
  await expect(scheduleRow(page, 'VAT report')).toHaveCount(0);
  await expect(scheduleRow(page, 'Sales report')).toHaveCount(0);
});

test('without core.report.schedule there is no schedule to make or see', async ({ page }) => {
  await actAs(page, { name: 'Accountant', permissions: ['accounting.report.read'] });
  await page.goto('/reports/vat');
  await waitForCopy(page);
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('menuitem', { name: 'Excel (.xlsx)' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Email on a schedule' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Scheduled emails' }),
  ).toHaveCount(0);
});
```

- **The first test goes the way a person does:** a report, its filters, Export, the dialog, then the list. It also
  checks that nobody is ticked at first and the form says so, and that Kamal, who may not read the VAT report, is not
  offered.
- **The change test is decision 55:** Kamal is listed, unticked, disabled and explained, and saving drops him, so the
  "gets nothing" line goes away.
- **Resuming the payables aging is refused** (decision 31), with the error's words from `errors.*`, not the API's
  English message.
- **A person with `core.report.schedule` sees only the schedules of the reports they read,** and a person without it
  has no "Email on a schedule" and no page.

### What I checked

- **Type checks:** `@omnivo/app` with its `scripts`, `e2e` and `sw` projects (the `mocks/report-data.ts` error left
  from 21c.1 is gone), `@omnivo/api`.
- **Tests:** app 210, all pass. API: `report-schedules.int.spec.ts` 19, all pass, with the code in the branch's name.
- **Playwright:** `vat-stock-reports.e2e.ts` and `report-schedules.e2e.ts`, 28 tests (14 × desktop and phone, the sort
  one skipped on a phone), twice in a row with `--repeat-each=2`: 54 passed, 2 skipped. With the suites the new seed
  could touch (team, roles, devices, requisitions, purchase orders, notifications, audit, dashboard, the reports): 31
  failed at first on timeouts, with the machine's load at 15 to 41; run again one worker at a time, all 31 passed.
- **In a browser, against the mockup you approved:** the VAT page with last month's numbers (the ones I worked out by
  hand, and the books agree), the stock movement page, the scheduled emails page, the new dialog and the change dialog
  with Kamal unticked. They match it, except for decisions 64 and 65, now fixed.
- **Break on purpose** (`.guide/work/21c7/break.py`), each caught: credit and debit notes added instead of taken off,
  the documents' sorting turned back on, the list showing schedules of reports the person may not read.
- **ESLint** (with a 6 GB heap), **Prettier**, `pnpm boundaries` (it found the import cycle of the seed, now fixed).
- **Not run here:** the whole e2e suite. That is 21c.8.

### Check this part

```bash
pnpm --filter "./packages/*" build
pnpm --filter @omnivo/app typecheck && pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app exec playwright test --config e2e/playwright.config.ts vat-stock-reports report-schedules --workers=2
cd apps/api && npx vitest run src/reports/report-schedules.int.spec.ts --maxWorkers=1 && cd ../..
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec eslint apps/app/src apps/app/e2e apps/api/src/reports
pnpm exec prettier --check apps/app/src apps/app/e2e apps/api/src/reports packages/contracts/src
pnpm boundaries
```

---

## 21c.8 — The real API, and every check once

No new behaviour here and no code change. No API route, table, permission or role template changes.

### The three pages and a scheduled email against the real API

The e2e tests read these pages from the mock API, and the integration tests run the routes and the worker's jobs
without a browser. So once, the whole path ran in a real browser (Chromium, driven by a Playwright script that is not
part of the guide) against the real API, as in 21b.8: a production build of this guide's code with `VITE_API_URL` set to
the API, served by `vite preview` with its service worker; the API and the worker built from this guide's code; and a
throwaway Postgres, Valkey, MinIO and Mailpit on other ports. The database was built from empty by the migrations, 0061
and 0062 among them. The run was on 10 November. The script:

1. **Set-up through the API:** a retail workspace; "Mango juice 250 ml" (৳25 before VAT 15%); 100 of them brought in on
   1 October at ৳15 (an opening adjustment, last month); an invoice of 4 to Rahim General Store on 5 November (৳100 and
   ৳15 VAT); 2 written off as damaged on 8 November; two bills from the landlord, each an expense with VAT 15%: shop rent
   ৳1,000 on 7 November with its Mushak 6.3 number, and a shutter repair ৳2,000 on 9 November without one. Then, in the
   browser, a POS sale of 4 juices today (POS1-000001, ৳100 and ৳15 VAT).
2. **The VAT report** opens at last month, which had no VAT: "No VAT in these dates". On "This month": output VAT
   ৳30.00 on ৳200.00, input VAT ৳450.00 with "৳300.00 on bills with no Mushak 6.3 number", net VAT ৳420.00 "To carry
   forward". Both books' lines say "Books agree", and the script checked the books itself, from the journal's own lines
   on the `vat_output` and `vat_input` accounts (30 and 450). The rate row "VAT 15% · 15%" has ৳200.00, ৳3,000.00 and
   "৳420.00 to carry forward".
3. **The documents:** Output lists the invoice and the POS sale, oldest first. Input lists the two bills: the rent with
   its Mushak number and ৳150.00, the repair with a "No Mushak 6.3" pill and ৳300.00.
4. **The stock movement report,** this month: opening 100 pcs, sold 8, adjusted -2, closing 90, the same as
   `stock_balances`; opening value ৳1,500, closing value ৳1,350. Last month: it closes at 100, which is today's 90 with
   this month's movements put back (decision 5). The row's link opens the product's stock card.
5. **A scheduled email:** on the VAT page, Export → "Email on a schedule", "Every week", the owner ticked, "Schedule
   email". The toast names the first email. The list says "Every Sunday at 08:00" and "Not sent yet", and
   `next_run_at` is Sunday 08:00 in Dhaka.
6. **The worker sends it:** the script set `next_run_at` a minute in the past, as if Sunday had come. The worker's
   5-minute sweep found it after 291 seconds. It made one export for the owner, of 3 to 9 November (the 7 days up to
   yesterday, decision 8), and Mailpit got the email "VAT report, 3 Nov 2026 – 9 Nov 2026 · Nabil Super Shop" with
   `vat-2026-11-03-to-2026-11-09.xlsx` attached. `next_run_at` moved on to the next Sunday.
7. **After it:** the list no longer says "Not sent yet". Pause empties `next_run_at` and the row says "Paused"; Resume
   sets it again ("Active"). The file is also on the owner's Exports page, "Ready".
8. **No connection:** "Needs a connection". Back online: the numbers again.

Every step passed, with no page error and no answer of 400 or more from the API. The script itself needed two fixes
on the way, and the code did not change: the documents list names a bill by our number and its Mushak 6.3 number, not
the supplier's own number, and the owner's first email in Mailpit is the sign-up's, so the script waits for the email
whose subject is the report's.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is the
first time everything runs together.

`pnpm dedupe --check`, `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (948: contracts 406, app 210, api 156,
sync 118, ui 22, i18n 17, shop 11, auth 8), `pnpm build`, `pnpm test:bundle-size` (first load 231.7 KB of 235; the
largest new page, the stock movement report, 126.6 KB of 140, the VAT report 126.3 and the schedules page 121.0; the
schedule dialog 89.0; the worker's list 454 files, 1494.8 KB gz), `pnpm test:openapi`, `pnpm boundaries` and
`pnpm test:tenant-leak` (133) passed at the first run.

`pnpm test:integration`: 718 of 720 passed at the first run. The other two stopped at the 5-second limit while the
computer's load was about 16: one in `goods-receipts.int.spec.ts`, one in `sales-documents.int.spec.ts`, two suites
this step does not touch. Those two files ran again alone: 33 passed. No code changed for this.

`pnpm test:e2e` and `pnpm test:e2e:pwa` needed three tries, all for the computer and none for the code. The first was
stopped at test 57 of 424: the memory was full and the load was 41, so a third of the tests ran out of time. The second
ended at test 284, when the computer restarted. The third, once the load had settled: 419 passed, 3 skipped (the sort
tests on the phone, where a table is a list of cards with no headers to click) and 2 failed, both in
`credit-notes.e2e.ts` on the phone, both a click that ran out of time in the first minutes, while the load from the
restart was still about 19. Those two ran again on one worker, on both screen sizes: 4 passed. `pnpm test:e2e:pwa`: 4
passed.

### On top of your current `dev`

A throwaway copy of this guide's branch with your `dev` (`afd3827`) merged in: the merge is clean (only
`apps/app/e2e/helpers.ts` is changed on both sides: your longer toast wait and this step's `vatMonth` option, in
different places). Then `pnpm install --frozen-lockfile`, the packages built (as CI's lint step does first),
`pnpm typecheck`, the contracts' and i18n's tests and `pnpm test:openapi`: all passed.

One thing seen on the way, not from this step: in a fresh checkout with nothing built yet, `pnpm typecheck` fails in
`packages/contracts/scripts/gen-openapi.ts`, because that script imports the package's own `dist/`, and turbo's
`typecheck` waits only for the other packages' builds (`^build`). CI never sees it, because `pnpm lint` builds the
packages before `pnpm typecheck` runs. Run `pnpm build` (or `pnpm lint`) first in a new clone.

---

## 21c.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after the **A party's aging page** entry, add:

> - **VAT report (`/reports/vat`):** the page header with the Export menu; period (last month at first, the month
>   presets and dates) and branch; the KPI strip: Output VAT ("৳75 taken off by credit notes and POS returns" under it),
>   Input VAT ("taken off by debit notes", and "৳450 on bills with no Mushak 6.3 number"), Net VAT without its sign and
>   in words ("To pay", "To carry forward", "Nothing to pay"); the books' line for each side; the rates as a statement
>   table in a card (a sticky first column, "VAT 15% · 15%" with its kind under it, zero-rated and exempt each their
>   own row, the total in `<tfoot>`); then a section header "Documents" with an Output / Input segmented control and a
>   data table in the register's order, not sortable (number as a link with its kind, date, customer or supplier, BIN,
>   and on Input the Mushak 6.3 number or a `warn` "No Mushak 6.3" pill, before VAT, VAT; a credit or debit note is a
>   minus). Every amount on the page with paisa, because it fills in a return. Online only.
> - **Stock movement (`/reports/stock-movement`):** the page header with the Export menu; period (this month at first),
>   warehouse, category, "Only what moved / Also what did not move"; the KPI strip (Products, with "In each product's
>   base unit, so the quantities have no total", Opening value, Closing value); a data table sorted on the server and
>   paged, one row per variant in its base unit: product (a link to its stock card), Opening, Purchased, Sold,
>   Transfers, Adjusted, Closing, then Opening value and Closing value. A zero is a dash; a minus in Transfers is stock
>   still on the way, and a line under the table says so. Without `inventory.stock.value` the value cells and KPIs are
>   left out. Online only.
> - **Scheduled emails (`/reports/schedules`, `core.report.schedule`):** the page header with no New button (a schedule
>   is made from a report's Export menu, "Email on a schedule"), "5 of 20 scheduled emails", and a data table (cards on a
>   phone), not sortable: the report (a `brand-soft` icon tile, its name and its filter lines in 12px `ink-3`), when
>   ("Every Sunday at 08:00"), sent to ("3 people", and "1 person gets nothing" in `warn`), the next email and "Last sent
>   …" or "Not sent yet", the status (Active `good` `CheckmarkCircle02`, or Paused neutral `PauseCircle` with its
>   reason under it) and a row menu: Change, Pause or Resume, Delete (asks first). Only the schedules of reports the
>   person may read. Empty state: "Open a report, like the sales report, choose Export, then Email on a schedule."
> - **Schedule dialog:** the dialog, "Email the VAT report on a schedule" or "Change the VAT report email". File (Excel
>   or PDF); How often, then Day (weekly) or Day of the month (1–28, monthly), and Time (whole hours, in the workspace's
>   time zone), with a hint of what each email holds ("Each email has the 7 days up to yesterday."); the filters as
>   lines on `subtle`, never boxes (they never change once saved); "Send to", a checkbox group of the members who may
>   read the report (up to 10). On a change, someone who may not read it any more is listed unticked and disabled with
>   "Gets nothing: may not read this report now", and saving drops them. "Schedule email" / "Save changes".

**docs/system-design.bn.md** — in ৩ (মডিউল), under **৭. Reports & Dashboard**, replace the last two bullets
("স্ট্যান্ডার্ড রিপোর্ট (Stock, Tax, P&L) + ফিল্টার + Excel/PDF এক্সপোর্ট" and "শিডিউল করা রিপোর্ট ইমেইল") with:

> - VAT রিপোর্ট: যেকোনো সময়ের (প্রথমে আগের মাস), রেট ধরে output, input আর net VAT, ডকুমেন্টের লাইন থেকে (ক্রেডিট নোট,
>   POS রিটার্ন আর ডেবিট নোট বাদে), পাশে `vat_output` / `vat_input` অ্যাকাউন্টের বইয়ের সংখ্যা; Mushak 6.3 ছাড়া বিলের VAT
>   আলাদা লাইনে। Mushak 9.1 পূরণে সাহায্য করে, রিটার্ন নিজে নয় (ধাপ ২১c)
> - স্টক মুভমেন্ট: প্রতিটা variant-এর base unit-এ opening, কেনা, বিক্রি, ট্রান্সফার, অ্যাডজাস্টমেন্ট আর closing, ওয়্যারহাউস আর
>   ক্যাটাগরি ধরে; opening নতুন টেবিল ছাড়াই, আজকের ব্যালান্স থেকে পরের মুভমেন্ট বাদ দিয়ে (ধাপ ২১c)
> - ট্রায়াল ব্যালান্স, P&L, ব্যালান্স শিট + ফিল্টার + Excel/PDF এক্সপোর্ট
> - শিডিউল করা রিপোর্ট ইমেইল: Export মেনু থেকে, প্রতিদিন, প্রতি সপ্তাহে বা প্রতি মাসে, ঠিক এক ঘণ্টায়; প্রতিজন প্রাপক নিজের ভাষায়
>   আর নিজের permission-এ নিজের ফাইল পায় (৫ MB পর্যন্ত সংযুক্ত, বড় হলে Exports পেজের লিংক)। worker প্রতি ৫ মিনিটে দেখে
>   (`report_schedules.next_run_at`); কেউ পড়তে না পারলে নিজে থেকে থামে (ধাপ ২১c)

**docs/build-plan.bn.md** — in পর্ব ৭ (ধাপ ২১), after the "বিক্রি, কেনাকাটা আর aging (২১b)" bullet, add:

> - **VAT, স্টক মুভমেন্ট আর ইমেইলে রিপোর্ট (২১c):** Reports-এ তিনটা নতুন পেজ। VAT রিপোর্ট রেট ধরে (output, input, net; পয়সা
>   পর্যন্ত; পাশে বইয়ের সংখ্যা; Mushak 6.3 ছাড়া বিলের VAT আলাদা; পেছনের ডকুমেন্টের তালিকা)। স্টক মুভমেন্ট প্রতিটা variant-এর
>   opening থেকে closing (`stock_movements`-এ নতুন তারিখের index; মূল্য শুধু `inventory.stock.value` থাকলে)। যেকোনো রিপোর্টের
>   Export মেনু থেকে "Email on a schedule": নতুন টেবিল `report_schedules` ও `report_schedule_recipients` (migration 0061,
>   0062), worker-এর ৫ মিনিটের sweep, প্রতি প্রাপকের নিজের `report_exports` সারি। নতুন permission `core.report.schedule`।
>   অনলাইনে ছাড়া চলে না।

And in section ৯, tick step 21: change "- [ ] **ধাপ ২১** — Reports 🏁 MVP" to "- [x] **ধাপ ২১** — Reports 🏁 MVP".
Step 21 is done with this guide.

---

## 21c.10 — Run it

```bash
pnpm db:migrate       # 0061 + 0062: the two schedule tables, their rules, the worker's grant, the stock_movements date index
pnpm dev              # the API, the app and the worker: the worker sends the scheduled emails
```

No new package, no new environment variable, and no change to the sync protocol. The emails go through the SMTP you
already have (Mailpit in development: http://localhost:8025). A new workspace's Accountant, Shop manager and Manager
roles get `core.report.schedule`; the owner has every permission. In an existing workspace, give `core.report.schedule`
in Settings → Roles to the roles that should make schedules.

### What you will see

1. **Reports in the sidebar:** VAT report (with `accounting.report.read`), Stock movement (with
   `inventory.report.read`) and Scheduled emails (with `core.report.schedule`).
2. **The VAT report** opens at last month. Pick "This month" if last month had no VAT. The strip says whether you pay
   or carry forward, and both books' lines should say "Books agree". A journal entry written by hand on a VAT account
   makes them differ.
3. **The rates and the documents:** each rate is its own row; switch Output / Input below. A bill with no Mushak 6.3
   number has a `warn` pill.
4. **The stock movement report:** every product that moved this month. Pick a warehouse: a transfer still on the truck
   is a minus in Transfers. A row opens the stock card.
5. **Email on a schedule:** on any report, Export → "Email on a schedule". The page's filters go with every email.
   Tick yourself and save: the toast names the first email.
6. **Scheduled emails:** your schedule, its next email, Pause, Resume, Change and Delete.
7. **The email itself:** wait for the hour you picked, or in development set the time by hand (`UPDATE
   report_schedules SET next_run_at = now()`) and wait up to 5 minutes. Mailpit shows the email with the file, and the
   file is on your Exports page.
8. **Bangla** and **390px:** each table is a list of cards, except the VAT rates, which scroll inside their card; the
   page never scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint                    # 6 GB heap for ESLint (19b decision 53)
pnpm format
pnpm typecheck
pnpm test                    # 948: contracts 406 + app 210 + api 156 + sync 118 + ui 22 + i18n 17 + shop 11 + auth 8
pnpm test:integration        # 720
pnpm test:tenant-leak        # 133
pnpm test:e2e                # 424: 212 flows × desktop and 390px (3 sort tests are skipped on the phone)
pnpm test:e2e:pwa            # 4: unchanged from 19b
pnpm build
pnpm test:bundle-size        # first load 231.7 KB gz (budget 235); the largest new page 126.6 (140); the worker's list 454 files, 1494.8 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **The VAT documents could be sorted** (21c.7, found in the browser): a click on a header sorted one page of the
  register. The VAT documents and the schedules have `enableSorting: false` (decision 64).
- **A schedule's branch read "Head office" while the page said "HO · Head office"** (21c.7): `filterNames` now gives
  the code and the name, the same words as the report's select (decision 65).
- **An import cycle in the mock's seed** (21c.7, found by `pnpm boundaries`): the four schedules have their own file.
- **The worker's Bangla said ভ্যাট while the app says VAT** (21c.5): one word in both (decision 51).
- **The first load went past 230 KB** (21c.5, 21c.6): the words of this step alone took it to 231.3. The budget is 235 KB
  (your choice).
- **Two integration tests stopped at 5 seconds** (21c.8) under a heavy load, in suites this step does not touch. Alone,
  they pass.

---

## Notes left for later steps

**Step 22 onward (website, admin, billing):**

- `REPORT_KINDS` (`packages/contracts/src/reports.ts`) now has nine kinds. A new report names its permission there and
  in `REPORT_KIND_PERMISSIONS`; the Export menu, the exports and the schedules follow by themselves.
- `report_schedules` is the pattern for any job a workspace sets to a clock: a `next_run_at` with a partial index, a
  sweep that the worker role may read only three columns of, and the real work as the app role inside the tenant.
- A workspace plan may later limit schedules: the 20 per workspace is one constant (`MAX_REPORT_SCHEDULES` in `packages/contracts/src/report-schedules.ts`).

**Later:**

- **The VAT return itself** (Mushak 9.1) and VAT deducted at source (VDS): this report helps fill in the return; it is
  not the return.
- **Scheduled emails only go to members.** An accountant outside the company needs a member account (decision 7).
- **Budgets near their limit:** the first load is 231.7 KB of 235, and the POS return dialog 136.9 KB of 140 without
  changing in this step (the contracts' route table is one chunk, 21b decision 50).
