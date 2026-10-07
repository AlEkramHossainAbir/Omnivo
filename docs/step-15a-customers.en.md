# Step 15a: Customers, price lists and VAT rates — who we sell to, at what price, with which VAT

> The implementation guide for the first part of "Phase 5 → Step 15" of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 15 (Sales) is split into four guides: this one
> (15a), then 15b (quotation → order → delivery), 15c (invoice, payment, credit limit) and 15d (returns and credit
> notes).
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `082fc49`, the end of
> step 14) and checked on 2026-10-06 and 07: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (265 — 14 new), `pnpm test:integration` (256 — 37 new), `pnpm test:tenant-leak` (50 — 5 new), `pnpm build`, `pnpm test:bundle-size` (first load 185.5 KB gz, budget 200; the customer form 66.8 KB, the product form 81.0 KB), `pnpm gen:openapi` (111 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 114 — 22 new, desktop and 390px) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked by hand:
>
> - **The screens**, with the mock API, at 1280px and 390px, light and dark: the customers list, a customer's page
>   with its statement, the customer form with two addresses, the customer groups, the price lists and the prices
>   of one list, Settings with its Sales and VAT rates cards, the product form's VAT rate, a journal entry with a
>   customer on its receivable line, and the opening balances split by customer. No page scrolls sideways.
> - **The party rule in the database itself**, in a throwaway Postgres migrated from step 14 with a receivable
>   entry posted the old way: every rule of migrations 0025 and 0026 was tried as `omnivo_app` (15a.2's "What we
>   checked").
> - **Two people making two different rates the default at the same moment**, in the integration test: a third
>   connection holds the default row until both saves wait for it. Exactly one rate stays the default.
> - **Guards broken on purpose**: take out the advisory lock around the default rate → the race test gets
>   `[201, 500]`. Take out the reversal exception in `post()` → both "before step 15a" tests fail. Turn off the
>   mock's party check → the e2e test "asks for the customer on a receivable line" fails. Each check ran its whole
>   test file, and the code was restored after it.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` first
> (migrations 0025 and 0026) and restart the worker, or every customer page fails and your workspace never gets
> its VAT rates. (2) The new tests on GitHub Actions. (3) The Bangla texts were written by me, not reviewed by a
> native speaker. (4) The VAT rates (15%, 10%, 7.5%, 5%) and which products are exempt follow the VAT and SD Act
> 2012 as I know it; please have your VAT consultant check the starting list before you rely on it. (5) The
> integration suites at full parallelism on a busy laptop: with other Docker stacks running (a load of 20–40), seven API test files missed the 120-second container start-up limit, and twelve `[phone]` Playwright tests their 30-second limit. Each of them passed when run again (`--maxWorkers=2`, `--workers=2`); none failed an assertion. Once the laptop was idle, the whole Playwright suite passed in one run (114 tests, 3 minutes). On GitHub Actions the defaults should be fine.

## Goal

🤝 **Customers in the books.** Until now the receivable was one number in the balance sheet. After this step every
taka of it belongs to a customer, every customer has a page with its balance and statement, and a product knows
its VAT rate and its price for each kind of buyer. Nothing is sold yet — that is 15b and 15c — but everything a
sales document needs to start from is here.

After this step:

- **Customers.** Code (`C-00001`), name, contact person, phone, email, BIN, a customer group, payment terms in days,
  a credit limit, a price list, notes, and as many billing and shipping addresses as needed (one billing). Search
  by name, code, contact person or part of a phone number. Archive, restore, or delete one that was never used.
- **Customer groups** ("Export buyers", "Local wholesale"): a label for lists and, later, reports.
- **A customer's balance and statement.** The journal's receivable lines now name a customer. The customer's
  balance is the sum of its lines, and the statement is the receivable's ledger for that one customer, with its
  opening and closing balance. Seeing balances needs its own permission.
- **Opening balances per customer.** The opening balances page splits the receivable into rows, one per customer.
- **VAT rates.** Each workspace gets VAT 15% (the default), 10%, 7.5%, 5%, Zero-rated and Exempt, managed in a
  "VAT rates" card on the Settings page. A product follows the default rate or has its own.
- **Prices with or without VAT.** One workspace switch says whether the prices you type include VAT.
- **Price lists** ("Export FOB", "Local wholesale", "Pharmacy"): a price per variant and per unit (a piece, a box
  of 10, a carton). A customer gets one list; a product missing from it falls back to its own sale price (15b).
- **A search box for picking one customer out of thousands**: a new `Combobox` in `@omnivo/ui`.

## The whole picture

```
packages/contracts   tax-rates.ts (new) · customers.ts (new: customers, groups, addresses, statement)
      │               price-lists.ts (new) · accounts: PARTY_ACCOUNT_PURPOSES
      │               journal: party on a line (partyId in, party out), opening balances split by party
      │               products: taxRateId · settings: pricesIncludeVat · 3 permissions · 26 errors · series C
      ▼
packages/db          tax_rates · customer_groups · parties (is_customer, is_supplier) · party_addresses
                     price_lists · price_list_items
                     journal_lines.party_id · products.tax_rate_id · tenant_settings.prices_include_vat
                     0025 (drizzle, indexes moved up) · 0026 (RLS, trigram search, the party rule, the VAT job)
      │
      ▼
apps/api             tax/: TaxRatesService · TaxRatesHandler (starting rates for older workspaces)
                     sales/: CustomersService · CustomerGroupsService · PriceListsService · BalanceAccess
                     journal: PostingService.checkParties() · party on entry, ledger and opening balance lines
                     LedgerService.statement() · products: tax rate, stale prices removed · setup: rates + roles
      │
      ▼
apps/app             /customers (list, new, page with statement, edit) · /customer-groups · /price-lists (+ /$id)
                     Settings: Sales card + VAT rates card · product form: VAT rate
                     journal form, view and ledger: the customer on receivable lines · opening balances by customer
                     packages/ui: Combobox · packages/i18n: the words, in English and Bangla
                     MSW: the same rules · Playwright: customers, price lists, and new journal/settings/product tests

one receivable line, from the click to the customer's balance:
  Save and post ──POST /journal-entries {post: true}──► API, one transaction:
     PostingService.checkLines(): accounts open, debits = credits (step 10)
        checkParties(): a line on 1140 Accounts receivable names an active customer (journal_party_required)
                        a line on any other account names nobody (journal_party_not_allowed)
     INSERT journal_lines (+ party_id) · status posted
        ──► trigger journal_entries_balanced(): the same party rule again, as the safety net
     audit · COMMIT
  Customer page: balance = Σ (debit − credit) of its posted lines ── "Owes ৳1,15,000"
  Statement: those lines between two dates, with the opening and closing balance
```

## The decisions behind this step

You made the first ten on 2026-10-06. The others came up while building it; please read 11–20 with care: they are
mine.

1. **Four guides, not one.** (You chose this.) 15a customers, price lists and VAT; 15b quotation → order →
   delivery; 15c invoice, payment and the credit limit; 15d returns and credit notes. Each guide ends with
   everything passing.
2. **One `parties` table for customers and suppliers.** (You chose this.) `is_customer` and `is_supplier` flags.
   A garments factory often buys from the company it sells to; it is one business with one BIN, not two records
   that drift apart. Step 17 adds the supplier side. The app says "customer" everywhere; only the table says party.
3. **The receivable is one control account, and each line on it names its customer.** (You chose this.) No account
   per customer in the chart: a distributor with 3,000 shops would drown the trial balance. `journal_lines.party_id`
   carries the customer; the customer's balance and statement are read from those lines. The accounts kept per
   party are the contract's `PARTY_ACCOUNT_PURPOSES` (`accounts_receivable` now; step 17 adds `accounts_payable`).
4. **Opening balance per customer, on the opening balances page.** (You chose this.) The receivable's opening
   amount is split into rows, one per customer, in the same entry as every other opening balance (step 10). No
   second place to type opening dues.
5. **A VAT rates table, with four kinds.** (You chose this.) Standard, reduced, zero-rated and exempt. Zero-rated
   and exempt are both 0%, but they go into different boxes of the VAT return. A product has a rate or follows the
   workspace default; from 15b each sales line keeps a copy of its rate (a snapshot), so changing a rate never
   changes an old invoice. Supplementary duty (SD) and Mushak 6.3 come later.
6. **Prices with or without VAT is one workspace setting.** (You chose this.) A shop types prices with VAT in them;
   a factory selling to other companies types them before VAT. It is set once, not per product or per list.
7. **Named price lists, a price per variant and per unit.** (You chose this.) A carton is not always 12 × the price
   of a piece. A customer has one list; anything not on it uses the product's own sale price. Line discounts (a %
   or an amount) come with the sales lines in 15b; quantity breaks later.
8. **A flexible chain.** (You chose this; it is built in 15b.) A quotation and an order are optional; an invoice
   can be made straight away, and it can deliver the stock itself.
9. **The credit limit blocks, unless you may override it.** (You chose this; it is built in 15c.) The limit is
   stored on the customer from this step on, so the form has it now.
10. **The customer's details.** (You chose this.) Payment terms in days (an invoice's due date, 15c), several
    addresses (billing and shipping), and customer groups.
11. **Changing VAT rates is a settings right.** `core.settings.manage`, not a new permission: the person who changes
    the company's BIN changes its VAT rates. Reading the rates needs no permission, because every product form
    picks one.
12. **Three new permissions.** `sales.customer.manage` (add and change customers and groups),
    `sales.customer.balance` (see what a customer owes: without it, the balance is `null` and the statement is
    refused) and `sales.price_list.manage`. A sales officer may need to add a shop without seeing every shop's dues.
13. **Customer codes are a number series**, `sales.customer` (`C-00001`, no year, five digits), on the Numbering
    page like the others. A code can still be typed by hand.
14. **The party rule is in the API and in the database.** The API answers with a clear error under the line; the
    trigger (0026) catches any code path that forgets. A **draft** may have a receivable line without a customer
    yet; posting checks fully.
15. **No "Unassigned" customer for the receivable lines posted before this step.** They show without a customer on
    the receivable's ledger, so for old data the customers' balances add up to less than the account. A fake
    customer would sit in every customer picker and could never be deleted. To put old data right: reverse the old
    entry and enter it again with a customer, or save the opening balances again, split by customer. A reversal
    may copy a line without a customer, so this always works.
16. **One default VAT rate, kept by the server.** Making a rate the default takes the flag from the old one, under
    an advisory lock; the default cannot be switched off or archived. A product's `taxRateId` of `null` means
    "follow the default", so changing the default moves every such product at once.
17. **Customer groups are deleted, not archived**, and only while nobody (archived customers too) is in them. A
    group is only a label.
18. **Price list prices are saved in batches.** Up to 500 changes in one request, all or nothing; an empty price
    removes the row. A unit that is no longer one of the product's units loses its prices when the product is saved.
19. **The price lookup moves to 15b.** Which price a sales line starts with is written next to the forms that use
    it, so it is tested with its real callers.
20. **VAT rates live on the Settings page**, as a card, not as their own page: a workspace sets them up once.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Quotations, orders, deliveries | 15b |
| Invoices, payments, the credit limit check (`sales.credit.override`) | 15c — the limit is already on the customer |
| Returns and credit notes | 15d |
| Which price a sales line starts with (the price lookup) | 15b, with the forms that call it (decision 19) |
| Supplementary duty (SD), Mushak 6.3 | Later, with the VAT reports; the rates table has room for them |
| Quantity breaks in a price list | Later; named lists cover most companies |
| Suppliers | Step 17 adds `is_supplier` parties and `accounts_payable` to the party rule |
| Custom fields on customers, a CSV import of customers or prices | Later; products already show how (step 12) |
| Aging (dues by 0–30, 31–60 … days), sorting customers by balance | With the reports in step 21 |
| A customer on the receivable lines posted before this step | Decision 15 |

## What changes in the code you already have

- **No new package**, no new `.env` line, no new database role.
- **`pnpm db:migrate`** adds six tables and three columns, replaces the posting check
  (`journal_entries_balanced()`) with one that also checks the party rule, and queues a VAT rates job for every
  workspace that is set up. **Restart the worker** after migrating, so it picks the job up.
- **The journal:** a line on the receivable must name a customer when it is posted, and no other line may name
  one. `LineInput.partyId` is required in the API, so every place that builds journal lines (stock documents, the
  year-end close) says `null` on purpose. A reversal copies each line's customer.
- **The opening balances page** splits the receivable by customer; the same (account, customer) twice is refused.
- **Products:** a VAT rate on the form (`taxRateId`, `''` = the default), and saving a product removes the prices of
  units it no longer has.
- **Settings:** the form sends `pricesIncludeVat`. Both new form fields are required, so an old client gets a 400
  instead of silently resetting them.
- **Templates:** the starting VAT rates, and the sales permissions for the Accountant, Manager, Shop manager and
  Sales officer roles (and customer management for the pharma Sales representative and the garments
  Merchandiser) — for **new** workspaces. Existing roles do not get them; an owner ticks them on the Roles page.
- **A new number series**, `sales.customer` (C), on the Numbering page.
- **API:** `containsPattern()` moved to `common/db/search.ts` (products, stock and customers use it).
- **app:** `useBalanceText()` moved from `ledger.tsx` to `journal-parts.tsx`; a journal refresh also refreshes the
  customers.
- **Existing tests that change:** every test that builds a product or settings form by hand sends the new field;
  the setup test expects the rates and the new role permissions; the numbering test counts the new series; the
  journal test expects `opening_balance_twice` from the contract.

---

## 15a.1 — `packages/contracts`: the contract

Everything starts here, as in every step: the shapes the API sends and accepts, the permission keys and the
error codes. The API and the app both read these files, so once this part type-checks, the next parts cannot
disagree about a field name.

Three new files hold the new things (VAT rates, customers, price lists). The other changes are small: a customer
on a journal line, a VAT rate on a product, one new setting, three permissions, a number series and the error codes.

### `tax-rates.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// The four kinds of sale the VAT return (Mushak 9.1) counts apart. standard: 15%. reduced: a lower
// rate set by the NBR (10%, 7.5%, 5%). zero_rated: taxable at 0% (exports), so input VAT can still
// be claimed. exempt: outside VAT (rice, medicine in some cases), no input VAT. The last two are both
// 0%, but the return needs to know which one a sale was, so they are kinds, not just a rate.
export const TAX_RATE_KINDS = ['standard', 'reduced', 'zero_rated', 'exempt'] as const;
export type TaxRateKind = (typeof TAX_RATE_KINDS)[number];

// A rate the workspace charges. A sales line copies the rate it used (step 15b), so changing a rate
// when the NBR changes it touches only new documents, never an invoice already written.
export const taxRateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  // z.string(), not the enum: a newer server's new kind must not break an older offline client
  kind: z.string(),
  // A percentage as a decimal string with 2 places, as Postgres sends NUMERIC(5,2): "7.50"
  rate: z.string(),
  // The rate a product without its own rate uses. Exactly one rate is the default.
  isDefault: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type TaxRate = z.infer<typeof taxRateSchema>;

// 0 to 99.99, at most 2 decimals: "15", "7.5". VAT is never 100% or more.
const RATE = /^\d{1,2}(?:\.\d{1,2})?$/;

export const taxRateInputSchema = z
  .object({
    name: z.string().trim().min(2, errorCode('tax_rate_name_required')).max(60),
    kind: z.enum(TAX_RATE_KINDS),
    rate: z.string().trim().regex(RATE, errorCode('tax_rate_format')),
    isDefault: z.boolean(),
  })
  // standard and reduced charge something; zero_rated and exempt charge nothing. A "standard 0%"
  // would put a sale in the wrong box of the VAT return.
  .refine(
    (input) => (input.kind === 'standard' || input.kind === 'reduced') === Number(input.rate) > 0,
    {
      error: errorCode('tax_rate_kind_rate'),
      path: ['rate'],
    },
  );
export type TaxRateInput = z.infer<typeof taxRateInputSchema>;
export type TaxRateFormValues = z.input<typeof taxRateInputSchema>;

export const updateTaxRateInputSchema = taxRateInputSchema.safeExtend({ version: versionSchema });
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateInputSchema>;

export const taxRateVersionInputSchema = z.object({ version: versionSchema });

// A workspace has a handful of rates: the whole list at once, archived ones too (the settings page
// shows them greyed out; the pickers leave them out)
export const taxRateListSchema = z.object({ items: z.array(taxRateSchema) });

const taxRateParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: every product form and sales line picks a rate. Changing them is a
// workspace setting.
export const taxRateRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/tax-rates',
    summary: 'The VAT rates of the workspace',
    auth: 'bearer',
    status: 200,
    response: taxRateListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/tax-rates',
    summary: 'Add a VAT rate',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 201,
    body: taxRateInputSchema,
    response: taxRateSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/tax-rates/:id',
    summary: "Change a VAT rate's name, kind, rate, or make it the default",
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: taxRateParamsSchema,
    body: updateTaxRateInputSchema,
    response: taxRateSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/tax-rates/:id/archive',
    summary: 'Hide a VAT rate from new products and documents',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: taxRateParamsSchema,
    body: taxRateVersionInputSchema,
    response: taxRateSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/tax-rates/:id/restore',
    summary: 'Bring an archived VAT rate back',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: taxRateParamsSchema,
    body: taxRateVersionInputSchema,
    response: taxRateSchema,
  }),
};
```

- **`TAX_RATE_KINDS`, four kinds and not just a number.** A zero-rated sale (an export) and an exempt sale are both
  0%, but they go into different boxes of the VAT return (Mushak 9.1), and a zero-rated seller can still claim back
  the VAT it paid on purchases while an exempt seller cannot. If we stored only the rate, a later step could not
  tell them apart. `standard` and `reduced` are split for the same reason: the return lists them apart too.
- **`kind: z.string()` in the response, `z.enum` in the input.** This is the rule from step 9 (account purposes)
  and step 12 (product types): a newer server may send a kind an older offline app does not know, and the older app
  must still be able to read the list. The input is strict, because the server only accepts what it knows.
- **`rate` as a string with 2 places.** A rate is a decimal like money: `7.5` must stay exactly `7.5`. Postgres
  sends `NUMERIC(5,2)` as `"7.50"`, so the response says so. Step 15b works VAT out with `decimal.js`, never with
  a JavaScript number.
- **`isDefault`.** A product without its own rate uses the default rate. Exactly one rate is the default; the
  server keeps that rule (part 15a.3), because the form cannot see the other rows.
- **The `RATE` pattern, `^\d{1,2}(?:\.\d{1,2})?$`.** 0 to 99.99, at most two decimals. A rate of 100% or more is
  always a typing mistake, and three decimals would not fit the column.
- **The `.refine` on kind and rate.** It ties the two together: a charged kind must have a rate above zero, and a
  0% kind must have zero. Without it, a "standard 0%" rate could be saved, and every sale with it would land in
  the wrong box of the return. The error sits on `rate` (`path: ['rate']`), because that is the box the person
  usually has to fix.
- **`safeExtend` for the update schema.** `taxRateInputSchema` has a refinement. In Zod 4, `.extend()` on a
  refined object throws at runtime, so the update schema uses `.safeExtend()`, which keeps the refinement and adds
  `version`. (The product schema solves the same problem differently, by keeping the rules in a separate function.
  Here the rule is one line, so `safeExtend` is simpler.)
- **No permission on `list`.** Every product form and, from 15b, every sales line picks a rate. Changing the rates
  is a workspace setting, so it uses the existing `core.settings.manage` instead of a new key: the person who
  changes the company's BIN is the person who changes its VAT rates.
- **Archive, not delete.** A rate that was used stays on old invoices (as a copied number, but also by name in the
  reports of 15c). Archiving hides it from new documents.

### `customers.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { ledgerPageSchema, ledgerQuerySchema } from './journal.js';
import { priceSchema } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { optionalCode } from './products.js';
import { binSchema, optionalEmailSchema } from './settings.js';

// A customer is a party: one row in the parties table, which step 17 also uses for suppliers. A
// distributor that both buys from a company and sells to it is one party with one statement, not
// two records that have to be netted by hand.

export const ADDRESS_KINDS = ['billing', 'shipping'] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

// The longest payment term a form accepts: a year. Garments buyers pay at 90–120 days.
export const MAX_PAYMENT_TERMS_DAYS = 365;

// A dealer with depots in a few districts, a pharmacy chain with its outlets
export const MAX_CUSTOMER_ADDRESSES = 20;

// ---------------------------------------------------------------------------------------------
// What the API sends

export const customerAddressSchema = z.object({
  id: z.uuid(),
  // z.string(), not the enum: the rule of account purposes and error codes
  kind: z.string(),
  // "Mirpur depot", "Head office"; null for a customer with one address
  label: z.string().nullable(),
  address: z.string(),
  // The phone at that address (the depot's store keeper), when it is not the customer's own
  phone: z.string().nullable(),
});
export type CustomerAddress = z.infer<typeof customerAddressSchema>;

export const customerSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  groupId: z.uuid().nullable(),
  contactPerson: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  // The customer's VAT registration number: printed on the VAT invoice (Mushak 6.3)
  bin: z.string().nullable(),
  // Days from the invoice date to its due date. 0 = due on receipt.
  paymentTermsDays: z.number().int(),
  // The most the customer may owe, a decimal string. null = no limit; "0.0000" = cash only.
  creditLimit: z.string().nullable(),
  // null = the products' own sale prices
  priceListId: z.uuid().nullable(),
  notes: z.string().nullable(),
  // The billing address first (if there is one), then the shipping addresses in the order the
  // person put them. The first shipping address is the default on a delivery.
  addresses: z.array(customerAddressSchema),
  // The same party is also a supplier (step 17)
  isSupplier: z.boolean(),
  // What the customer owes now: debit minus credit of the receivable lines that carry this party.
  // null when the person may not see balances (sales.customer.balance).
  balance: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

// One row of the list: no addresses or notes — a page of 50 stays small
export const customerSummarySchema = customerSchema.pick({
  id: true,
  code: true,
  name: true,
  groupId: true,
  contactPerson: true,
  phone: true,
  paymentTermsDays: true,
  creditLimit: true,
  balance: true,
  archivedAt: true,
  updatedAt: true,
});
export type CustomerSummary = z.infer<typeof customerSummarySchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// The form's "None" options send '' for "not chosen"
const optionalIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

const customerAddressInputSchema = z.object({
  // An existing address keeps its id: a delivery (step 15b) points at the address it went to
  id: z.uuid().nullable(),
  kind: z.enum(ADDRESS_KINDS),
  label: optionalText(60),
  address: z.string().trim().min(5, errorCode('customer_address_required')).max(300),
  phone: optionalText(30),
});
export type CustomerAddressInput = z.input<typeof customerAddressInputSchema>;

export const customerInputSchema = z
  .object({
    // null = the next number from the 'sales.customer' series (C-00042)
    code: optionalCode('customer_code_format'),
    name: z.string().trim().min(2, errorCode('customer_name_required')).max(120),
    groupId: optionalIdSchema,
    contactPerson: optionalText(80),
    phone: optionalText(30),
    email: optionalEmailSchema,
    bin: binSchema,
    paymentTermsDays: z.number().int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
    // '' = no limit, like a product's empty sale price: "0" is a real limit (cash only)
    creditLimit: priceSchema,
    priceListId: optionalIdSchema,
    notes: optionalText(500),
    addresses: z.array(customerAddressInputSchema).max(MAX_CUSTOMER_ADDRESSES),
  })
  // One billing address: the invoice prints exactly one. The error sits on the second one, the
  // one to change.
  .superRefine((input, ctx) => {
    let billing = 0;
    input.addresses.forEach((address, index) => {
      if (address.kind !== 'billing') return;
      billing += 1;
      if (billing > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['addresses', index, 'kind'],
          message: errorCode('customer_billing_twice'),
        });
      }
    });
  });
export type CustomerInput = z.infer<typeof customerInputSchema>;
export type CustomerFormValues = z.input<typeof customerInputSchema>;

export const updateCustomerInputSchema = customerInputSchema.safeExtend({
  version: versionSchema,
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerInputSchema>;

export const customerVersionInputSchema = z.object({ version: versionSchema });

export const deleteCustomerQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// ---------------------------------------------------------------------------------------------
// The list

export const CUSTOMER_SORTS = ['name', '-name', 'code', '-code', '-updated'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const CUSTOMER_STATUSES = ['active', 'archived'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const customerListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code, the contact person or the phone number
  search: z.string().trim().max(100).optional(),
  groupId: z.uuid().optional(),
  status: z.enum(CUSTOMER_STATUSES).default('active'),
  sort: z.enum(CUSTOMER_SORTS).default('name'),
});
export type CustomerListQuery = z.input<typeof customerListQuerySchema>;

export const customerPageSchema = pageOf(customerSummarySchema);
export type CustomerPage = z.infer<typeof customerPageSchema>;

const customerParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like products: every sales document picks a customer. The balance
// inside a customer is shown only with sales.customer.balance (null otherwise), and the statement
// needs it too: what a customer owes is not every cashier's business.
export const customerRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/customers',
    summary: 'Customers, a page at a time, searched, filtered and sorted on the server',
    auth: 'bearer',
    status: 200,
    query: customerListQuerySchema,
    response: customerPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/customers/:id',
    summary: 'One customer with its addresses',
    auth: 'bearer',
    status: 200,
    params: customerParamsSchema,
    response: customerSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/customers',
    summary: 'Add a customer',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 201,
    body: customerInputSchema,
    response: customerSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/customers/:id',
    summary: 'Change a customer: the addresses sent replace the ones it had',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerParamsSchema,
    body: updateCustomerInputSchema,
    response: customerSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/customers/:id/archive',
    summary: 'Hide a customer from new documents; its history and balance stay',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerParamsSchema,
    body: customerVersionInputSchema,
    response: customerSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/customers/:id/restore',
    summary: 'Bring an archived customer back',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerParamsSchema,
    body: customerVersionInputSchema,
    response: customerSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/customers/:id',
    summary: 'Delete a customer that no entry or document uses yet',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 204,
    params: customerParamsSchema,
    query: deleteCustomerQuerySchema,
    response: z.void(),
  }),
  // The receivable lines of this customer, like an account's ledger: opening balance, the lines in
  // date order with a running balance, closing balance. Debit = the customer owes more.
  statement: defineRoute({
    method: 'GET',
    path: '/customers/:id/statement',
    summary: "A customer's posted receivable lines in date order, with the running balance",
    auth: 'bearer',
    permission: 'sales.customer.balance',
    status: 200,
    params: customerParamsSchema,
    query: ledgerQuerySchema,
    response: ledgerPageSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Customer groups: Dealer, Retailer, Corporate — for filtering the list and, later, the reports

export const customerGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  // Archived customers count too: a group that holds any customer cannot be deleted
  customerCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type CustomerGroup = z.infer<typeof customerGroupSchema>;

export const customerGroupInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('customer_group_name_required')).max(60),
});
export type CustomerGroupInput = z.infer<typeof customerGroupInputSchema>;

export const updateCustomerGroupInputSchema = customerGroupInputSchema.extend({
  version: versionSchema,
});

export const deleteCustomerGroupQuerySchema = deleteCustomerQuerySchema;

// A handful of groups: the whole list at once
export const customerGroupListSchema = z.object({ items: z.array(customerGroupSchema) });

const customerGroupParamsSchema = z.object({ id: z.uuid() });

export const customerGroupRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/customer-groups',
    summary: 'The customer groups of the workspace',
    auth: 'bearer',
    status: 200,
    response: customerGroupListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/customer-groups',
    summary: 'Add a customer group',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 201,
    body: customerGroupInputSchema,
    response: customerGroupSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/customer-groups/:id',
    summary: 'Rename a customer group',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerGroupParamsSchema,
    body: updateCustomerGroupInputSchema,
    response: customerGroupSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/customer-groups/:id',
    summary: 'Delete a customer group that holds no customer',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 204,
    params: customerGroupParamsSchema,
    query: deleteCustomerGroupQuerySchema,
    response: z.void(),
  }),
};
```

- **A customer is a party.** The database table (part 15a.2) is `parties`, with an `is_customer` and an
  `is_supplier` flag. The contract still says "customer" everywhere, because that is what this page is about and
  what the person sees. Step 17 adds `suppliers` routes over the same table. `isSupplier` is already in the response
  so the customer page can later say "also a supplier".
- **`ADDRESS_KINDS`, billing and shipping.** The invoice prints one billing address. A delivery goes to one of the
  shipping addresses (a depot, an outlet). Two kinds are enough; "head office" is just a label.
- **`MAX_PAYMENT_TERMS_DAYS = 365`.** Garments buyers pay at 90 or 120 days, so a short limit would be wrong; a
  year is the longest anyone sells on. The limit also keeps a typo like `3000` out.
- **`label` is nullable, `address` is not.** A customer with one address needs no name for it. An address without
  text is useless on a delivery note, so the input refuses it (`customer_address_required`, at least 5 characters).
- **`creditLimit: string | null`.** `null` means "no limit" and `"0.0000"` means "cash only". These are different
  promises, so they are different values, the same reason a product's empty sale price is `null` and not `0`
  (step 12). Step 15c reads this limit when an order or invoice is saved.
- **`balance: string | null`.** What the customer owes now. It comes from the journal (the receivable lines that
  carry this customer, see `journal.ts` below), not from a column on the customer, so it can never drift from the
  books. It is `null` for a person without `sales.customer.balance`. We send `null` instead of leaving the field out,
  so the type is the same for everyone and the app just shows a dash.
- **`customerSummarySchema = customerSchema.pick(…)`.** The list row is a subset of the full customer, so it is
  built from it. If a field is renamed in `customerSchema`, the summary follows, and nothing is typed twice.
  Addresses and notes are left out to keep a page of 50 small.
- **`optionalIdSchema` (the `''` union).** A form's "None" option in a select sends `''`. We turn it into `null`
  here, so the server never stores two kinds of "nothing". The same helper exists in `products.ts`; each file keeps
  its own small copy, as `journal.ts` does, because exporting such a tiny helper would make every file depend on
  `products.ts`.
- **`id: z.uuid().nullable()` on an address.** An existing address keeps its id when the form is saved. From 15b
  a delivery points at the address it went to; if every save made new ids, old deliveries would lose their address.
- **`optionalCode('customer_code_format')`.** The same code rule as a product (letters, digits, `.`, `/`, `_`,
  `-`, no spaces), so we reuse the function from `products.ts` with our own error code. An empty code means "give
  me the next number" (`C-00042`).
- **`binSchema` and `optionalEmailSchema` from `settings.ts`.** A customer's BIN follows exactly the rule of the
  company's own BIN (13 digits, hyphens and spaces dropped). Reusing the schema means the two can never disagree.
- **The `superRefine` for billing addresses.** The invoice prints exactly one billing address, so a second one is
  refused. The error is put on the **second** billing address (`path: ['addresses', index, 'kind']`), because that
  is the one the person just added and has to change. Putting it on the whole list would show the message far from
  the cause.
- **`CustomerFormValues = z.input<…>`.** The form works with what the person types (strings, `''`), the API with
  what comes out of the parse (`null`). Two types make that difference visible to TypeScript.
- **`deleteCustomerQuerySchema`.** A delete has no body, so the version travels in the query string, like a
  product's delete. `z.coerce.number<number>()` turns `"3"` into `3`, and the `<number>` keeps the input type a
  number for the app.
- **`CUSTOMER_SORTS` without balance.** Sorting by what customers owe means computing every customer's balance
  first. That belongs to the receivables aging report of 15c, which is built for it.
- **`search` covers name, code, contact person and phone.** At the counter people know a customer by phone
  number more often than by code.
- **Reading needs no permission; the balance does.** Every sales document picks a customer, so the list must be
  open to every member. What a customer owes is more private: the statement route needs `sales.customer.balance`,
  and the server sends `balance: null` in the list and the detail without it.
- **`statement` reuses `ledgerQuerySchema` and `ledgerPageSchema`.** A customer's statement is the receivable
  account's ledger, filtered to one party. Same query (dates, page), same answer (opening balance, lines with a
  running balance, closing balance). The app can reuse the ledger's table.
- **Customer groups are deleted, not archived.** A group is only a label for filtering. A group that still holds a
  customer cannot be deleted (`customer_group_in_use`), so `customerCount` counts archived customers too: an
  archived customer still points at its group.

### `price-lists.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { priceSchema } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A named set of prices: "Dealer", "Wholesale", "Corporate". A customer has at most one list; a
// sales line (step 15b) takes the price from it, and falls back to the product's own sale price for
// an item the list leaves out. A price is per variant and per unit, because a carton is often
// cheaper than 24 single pieces.
//
// The prices follow the workspace's "prices include VAT" setting, like the products' own prices.

export const priceListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  // How many prices it holds, and how many customers use it (archived customers too)
  itemCount: z.number().int(),
  customerCount: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PriceList = z.infer<typeof priceListSchema>;

export const priceListInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('price_list_name_required')).max(60),
  description: optionalText(200),
});
export type PriceListInput = z.infer<typeof priceListInputSchema>;

export const updatePriceListInputSchema = priceListInputSchema.extend({ version: versionSchema });
export type UpdatePriceListInput = z.infer<typeof updatePriceListInputSchema>;

export const priceListVersionInputSchema = z.object({ version: versionSchema });

// A few lists per workspace: the whole list at once, archived ones too
export const priceListListSchema = z.object({ items: z.array(priceListSchema) });

// ---------------------------------------------------------------------------------------------
// The prices inside a list. A distributor's list can hold thousands, so they come a page at a
// time, and are saved a batch at a time.

export const priceListItemSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // What the row shows, so the page does not load every product: "Napa 500 mg", "NAPA-500", the
  // option values of a variant (["M", "Navy blue"]), and the product's code
  productId: z.uuid(),
  productCode: z.string(),
  productName: z.string(),
  sku: z.string(),
  optionValues: z.array(z.string()),
  // Per one of this unit: the price of a carton, not of a piece. 4 decimals, like every amount.
  price: z.string(),
  updatedAt: z.iso.datetime(),
});
export type PriceListItem = z.infer<typeof priceListItemSchema>;

export const priceListItemQuerySchema = pageQuerySchema.extend({
  // Part of the product's name or code, or a SKU
  search: z.string().trim().max(100).optional(),
});
export type PriceListItemQuery = z.input<typeof priceListItemQuerySchema>;

export const priceListItemPageSchema = pageOf(priceListItemSchema);
export type PriceListItemPage = z.infer<typeof priceListItemPageSchema>;

// The most rows one save sends: a page of edits, or one product's variants in every unit
export const MAX_PRICE_LIST_CHANGES = 500;

const priceListChangeSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // '' = take this price out of the list (the item falls back to the product's price)
  price: priceSchema,
});

// No version: two people can price different items of one list at the same time, and each row is
// saved on its own. The same item and unit twice in one save is a mistake in the form.
export const setPriceListItemsInputSchema = z.object({
  changes: z
    .array(priceListChangeSchema)
    .min(1)
    .max(MAX_PRICE_LIST_CHANGES)
    .superRefine((changes, ctx) => {
      const seen = new Set<string>();
      changes.forEach((change, index) => {
        const key = `${change.variantId}:${change.unitId}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'price'],
            message: errorCode('price_list_item_twice'),
          });
        }
        seen.add(key);
      });
    }),
});
export type SetPriceListItemsInput = z.infer<typeof setPriceListItemsInputSchema>;

const priceListParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: a salesperson looks up the dealer price before quoting it
export const priceListRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/price-lists',
    summary: 'The price lists of the workspace',
    auth: 'bearer',
    status: 200,
    response: priceListListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/price-lists/:id',
    summary: 'One price list, without its prices',
    auth: 'bearer',
    status: 200,
    params: priceListParamsSchema,
    response: priceListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/price-lists',
    summary: 'Add a price list',
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 201,
    body: priceListInputSchema,
    response: priceListSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/price-lists/:id',
    summary: "Change a price list's name or description",
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: updatePriceListInputSchema,
    response: priceListSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/price-lists/:id/archive',
    summary: "Stop using a price list; its customers fall back to the products' prices",
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: priceListVersionInputSchema,
    response: priceListSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/price-lists/:id/restore',
    summary: 'Bring an archived price list back',
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: priceListVersionInputSchema,
    response: priceListSchema,
  }),
  items: defineRoute({
    method: 'GET',
    path: '/price-lists/:id/items',
    summary: 'The prices in a list, a page at a time, by product name',
    auth: 'bearer',
    status: 200,
    params: priceListParamsSchema,
    query: priceListItemQuerySchema,
    response: priceListItemPageSchema,
  }),
  setItems: defineRoute({
    method: 'PUT',
    path: '/price-lists/:id/items',
    summary: 'Set or remove prices in a list, a batch at a time',
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: setPriceListItemsInputSchema,
    response: priceListSchema,
  }),
};
```

- **A price per variant and per unit.** A distributor sells Napa by the strip and by the box of 10 strips, and the
  box is not exactly 10 times the strip price. So the key of a price is `(variantId, unitId)`. Step 15b's lookup
  takes the line's own unit first.
- **The prices follow `pricesIncludeVat`.** A list holds prices the way the workspace types all its prices. Mixing
  "with VAT" and "without VAT" prices inside one workspace would be a source of wrong invoices, so there is no
  per-list switch.
- **`itemCount` and `customerCount`.** The list page shows how big a list is and who uses it, so the owner knows
  what archiving it would change.
- **The item row carries the product's name, code, SKU and option values.** A list can hold thousands of prices,
  and the app cannot load every product to show names. The server joins them once.
- **Items come a page at a time, and are saved a batch at a time.** `priceListItemQuerySchema` is a normal keyset
  page with a search. `setPriceListItemsInputSchema` takes up to `MAX_PRICE_LIST_CHANGES` (500) rows: enough for a
  page of edits, or for one product's variants in every unit.
- **`price: priceSchema`, so `''` means "remove".** An empty box in the price column takes the item out of the list,
  and the item falls back to the product's own price. That is what the person expects when they clear a box.
- **No `version` on the batch.** Two people may price different products of the same list at the same time. Each
  row is saved on its own (an upsert in 15a.3), so there is nothing to lose. A version on the whole list would make
  the second person's save fail for no reason.
- **The duplicate check.** The same item and unit twice in one save would leave the result to the order of the
  rows. The `superRefine` refuses it and points at the second row's price.
- **Archiving a list.** Its customers keep their `priceListId`, but step 15b's lookup ignores an archived list and
  uses the products' prices. Restoring the list brings the prices back for all of them at once.

### `accounts.ts`: the accounts kept per party

```diff
@@ -38,6 +38,17 @@ export const ACCOUNT_PURPOSES = [
 ] as const;
 export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number];
 
+// The accounts kept per party (step 15a): the receivable is one account in the chart, and every line
+// on it names the customer, so the customers' balances add up to the account's balance. Step 17
+// adds 'accounts_payable' for suppliers.
+export const PARTY_ACCOUNT_PURPOSES = [
+  'accounts_receivable',
+] as const satisfies readonly AccountPurpose[];
+
+export function isPartyAccountPurpose(value: string | null): boolean {
+  return PARTY_ACCOUNT_PURPOSES.some((purpose) => purpose === value);
+}
+
 export function isAccountPurpose(value: string): value is AccountPurpose {
   return ACCOUNT_PURPOSES.some((purpose) => purpose === value);
 }
```

The receivable is **one** account in the chart (decision 3). Each line on it names the customer, and the
customers' balances add up to the account. `PARTY_ACCOUNT_PURPOSES` lists the purposes that work this way. Step 17
adds `accounts_payable`. We use the purpose and not a fixed account id: the purpose marks "the receivable account"
in every workspace, even after the owner renames or moves it (step 9).

`isPartyAccountPurpose` takes `string | null`, because an account's `purpose` is nullable and a string (not the
enum) in the response. With this, both the API and the journal form can ask "does this line need a customer?"
without a cast.

### `journal.ts`: a customer on a line

```diff
@@ -55,17 +55,28 @@ export function shiftIsoDate(isoDate: string, days: number): string {
   return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
 }
 
-// A real entry has a handful of lines; a payroll or an opening balance a few hundred at most
+// A real entry has a handful of lines; a payroll a few hundred at most
 export const MAX_JOURNAL_LINES = 200;
 
+// The opening balances are one entry, but with a line per customer who owed money (step 15a)
+export const MAX_OPENING_BALANCE_LINES = 5000;
+
 // A posted entry as another page links to it: "JV-2026-27-0042"
 export const entryRefSchema = z.object({ id: z.uuid(), number: z.string() });
 export type EntryRef = z.infer<typeof entryRefSchema>;
 
+// The customer (later also the supplier) a line belongs to, as a page shows it. Sent with its code
+// and name because a workspace has too many customers for the app to load them all, the way it
+// loads the chart of accounts.
+export const partyRefSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });
+export type PartyRef = z.infer<typeof partyRefSchema>;
+
 export const journalLineSchema = z.object({
   id: z.uuid(),
   accountId: z.uuid(),
   branchId: z.uuid().nullable(),
+  // Set on every line of the receivable account (step 15a), and on no other line
+  party: partyRefSchema.nullable(),
   description: z.string().nullable(),
   // Decimal strings with 4 places, as Postgres sends NUMERIC(19,4): "18500.0000". One side is
   // always "0.0000".
@@ -103,8 +114,8 @@ export const journalEntrySchema = journalEntrySummarySchema.extend({
 });
 export type JournalEntry = z.infer<typeof journalEntrySchema>;
 
-// The form's "No branch" option sends ''
-const branchIdSchema = z
+// The form's "No branch" and empty "Customer" options send ''
+const optionalIdSchema = z
   .union([z.uuid(), z.literal('')])
   .transform((value) => (value === '' ? null : value))
   .nullable();
@@ -115,7 +126,11 @@ export const journalLineInputSchema = z
   .object({
     // The form's empty "Account" select sends '' — "not chosen", not a broken id
     accountId: z.uuid(errorCode('journal_account_required')),
-    branchId: branchIdSchema,
+    branchId: optionalIdSchema,
+    // Required on the receivable account, refused on every other account. Only the server knows
+    // which account is which, so that rule is checked there (journal_party_required / _not_allowed).
+    // May be left out (= null): an app from before step 15a still sends its lines without it.
+    partyId: optionalIdSchema.default(null),
     description: optionalText(200),
     debit: amountSchema,
     credit: amountSchema,
```

- **`MAX_OPENING_BALANCE_LINES = 5000`.** The opening balances were capped at 1,000 lines. With one line per
  customer on the receivable, a distributor moving to Omnivo with 3,000 shops that owe money would not fit. 5,000
  lines is still a small request (a few hundred KB).
- **`partyRefSchema`.** A line shows "Rahman Traders (C-00012)", not an id. The app loads the whole chart of
  accounts and can find an account by id, but it cannot load every customer, so the server sends the code and name
  with the line.
- **`party` on `journalLineSchema`.** Set on every line of the receivable account, and on no other line. That one
  rule is what makes "the customers' balances add up to the receivable" true.
- **`partyId` on the line input, with `.default(null)`.** Optional on purpose: an app built before step 15a sends
  journal lines without it, and those lines must still parse. The rule "required on the receivable, refused
  elsewhere" needs to know which account is the receivable, and only the server knows that, so the check runs
  there (part 15a.3) and the schema only cleans the value. `optionalIdSchema` replaces the old `branchIdSchema`:
  the same helper now cleans both the branch and the customer.

```diff
@@ -260,6 +275,8 @@ export const ledgerLineSchema = z.object({
   date: z.iso.date(),
   narration: z.string().nullable(),
   description: z.string().nullable(),
+  // The receivable account's ledger shows whose line it is (step 15a); null on other accounts
+  party: partyRefSchema.nullable(),
   debit: z.string(),
   credit: z.string(),
   balance: z.string(),
@@ -292,8 +309,11 @@ export const ledgerRoutes = {
 // books to Omnivo. Saved as one posted journal entry; the difference goes to the account whose
 // purpose is 'opening_balance_equity'.
 
+// The receivable account's opening balance is split by customer (step 15a): one line per customer
+// who owed money on the go-live date. Every other account has one line, without a party.
 export const openingBalanceLineSchema = z.object({
   accountId: z.uuid(),
+  party: partyRefSchema.nullable(),
   debit: z.string(),
   credit: z.string(),
 });
@@ -313,17 +333,42 @@ export const openingBalancesInputSchema = z.object({
   // The entry the page was opened with. If someone saved other opening balances since, the
   // server answers version_conflict instead of reversing an entry this person never saw.
   replaces: z.uuid().nullable(),
-  // Zero on both sides = no opening balance for that account; such lines are dropped
+  // Zero on both sides = no opening balance for that account; such lines are dropped. A
+  // distributor moving to Omnivo may bring a few thousand customers with dues, hence the limit.
   lines: z
     .array(
       z
-        .object({ accountId: z.uuid(), debit: amountSchema, credit: amountSchema })
+        .object({
+          accountId: z.uuid(),
+          partyId: optionalIdSchema.default(null),
+          debit: amountSchema,
+          credit: amountSchema,
+        })
         .refine((line) => isZeroMoney(line.debit) || isZeroMoney(line.credit), {
           error: errorCode('journal_line_amount'),
           path: ['debit'],
         }),
     )
-    .max(1000),
+    .max(MAX_OPENING_BALANCE_LINES)
+    // One line per account, and per customer on the receivable: two lines for the same customer
+    // would be added up silently, and the person would not see the number they typed. Empty lines
+    // do not count: the server drops them, and the page may hold a few customer rows not filled in
+    // yet (step 15a.6).
+    .superRefine((lines, ctx) => {
+      const seen = new Set<string>();
+      lines.forEach((line, index) => {
+        if (isZeroMoney(line.debit) && isZeroMoney(line.credit)) return;
+        const key = `${line.accountId}:${line.partyId ?? ''}`;
+        if (seen.has(key)) {
+          ctx.addIssue({
+            code: 'custom',
+            path: [index, 'debit'],
+            message: errorCode('opening_balance_twice'),
+          });
+        }
+        seen.add(key);
+      });
+    }),
 });
 export type OpeningBalancesInput = z.infer<typeof openingBalancesInputSchema>;
 
```

- **`party` on a ledger line.** The receivable account's ledger now shows whose line each one is. Without it, the
  ledger of a busy receivable would be a list of amounts with no names.
- **`party` on an opening balance line.** The receivable's opening balance is split by customer: one line per
  customer who owed money on the go-live date. Every other account still has one line without a party. This is
  decision 4 ("opening balance per customer"): the dues are entered on the opening balances page, in the same entry
  as every other opening balance, so the receivable's total and the customers' dues are the same numbers by
  construction.
- **The `superRefine` on the opening lines.** Two lines for the same account and customer would be added up by the
  server, and the person would never see the number they typed. The key `${accountId}:${partyId ?? ''}` also covers
  accounts without a party: the same cash account twice is refused too.
- **Empty lines are skipped by that check** (`isZeroMoney` on both sides, then `return`). The server drops zero
  lines anyway, and the opening balances page (15a.6) can hold customer rows that are not filled in yet: a new
  receivable starts with one empty row, and "Add a customer" adds another. Without the skip, two empty rows
  would share the key `accountId:` and the form would say "This account is here twice" about rows that send
  nothing. This line was added while building 15a.6; the contract test "lets empty lines repeat" covers it.

### `products.ts`: a VAT rate per product

```diff
@@ -1,7 +1,7 @@
 import { z } from 'zod';
 
 import { customFieldValuesSchema } from './custom-fields.js';
-import { errorCode } from './errors.js';
+import { type ErrorCode, errorCode } from './errors.js';
 import { optionalText, versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
 import { priceSchema } from './money.js';
@@ -49,7 +49,8 @@ export const MAX_PRODUCT_UNITS = 10;
 // ST-2026/118, NAPA-500. No spaces: a code is typed into a scanner field and searched for whole.
 const CODE = /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u;
 
-function optionalCode(code: 'product_code_format' | 'product_sku_format') {
+// Customer codes (step 15a) follow the same rule, with their own error code
+export function optionalCode(code: ErrorCode) {
   return z
     .string()
     .trim()
@@ -151,6 +152,8 @@ export const productSchema = z.object({
   tracking: z.string(),
   // Batches carry an expiry date (medicine, food)
   hasExpiry: z.boolean(),
+  // The VAT rate its sales lines start with (step 15a); null = the workspace's default rate
+  taxRateId: z.uuid().nullable(),
   // Empty = a simple product
   options: z.array(productOptionSchema),
   variants: z.array(productVariantSchema),
@@ -236,6 +239,8 @@ export const productFieldsSchema = z.object({
   purchaseUnitId: optionalIdSchema,
   tracking: z.enum(TRACKING_MODES),
   hasExpiry: z.boolean(),
+  // null or '' = the workspace's default rate, which follows the default when it changes
+  taxRateId: optionalIdSchema,
   options: z.array(productOptionInputSchema).max(MAX_PRODUCT_OPTIONS),
   variants: z.array(productVariantInputSchema).min(1).max(MAX_VARIANTS),
   units: z.array(productUnitInputSchema).max(MAX_PRODUCT_UNITS),
```

- **`optionalCode` is exported and takes any `ErrorCode`.** Customers use it with `customer_code_format`. The old
  signature allowed only the two product codes; widening it to `ErrorCode` keeps the type check (only real codes
  are allowed) without listing every user.
- **`taxRateId: null` = "the workspace's default rate".** Most products use the standard 15%. If every product
  copied the default's id, changing the default (for example to a new standard rate) would leave every product on
  the old one. With `null`, a product follows the default; only products with a different rate (medicine at 0%, a
  reduced-rate item) store their own.
- **`optionalIdSchema` on the input.** The product form's "Default rate" option sends `''`.

### `settings.ts`: prices with or without VAT

```diff
@@ -34,7 +34,7 @@ export function isTimeZone(value: string): boolean {
 
 // BIN (NBR-এর VAT নিবন্ধন নম্বর) ১৩ অঙ্কের, প্রায়ই "000123456-0101" লেখা হয়। হাইফেন আর স্পেস
 // ফেলে শুধু অঙ্ক রাখা — তাহলে একই BIN দুই রকম লেখায় দুবার ঢোকে না, আর Mushak 6.3-এ একই ছাঁদে ছাপা হয়
-const binSchema = z
+export const binSchema = z
   .string()
   .trim()
   .transform((value) => value.replace(/[\s-]/g, ''))
@@ -43,7 +43,7 @@ const binSchema = z
   .nullable();
 
 // ফাঁকা চলে; লিখলে ঠিক ইমেইল হতে হবে
-const optionalEmailSchema = z
+export const optionalEmailSchema = z
   .string()
   .trim()
   .toLowerCase()
@@ -68,6 +68,10 @@ export const settingsSchema = z.object({
   // did not yet). Batches and serial numbers never go negative: a batch or an IMEI either is in
   // the warehouse or is not.
   allowNegativeStock: z.boolean(),
+  // Whether the prices the workspace types (a product's sale price, a price list) already hold the
+  // VAT. On for a shop that sells at the printed MRP; off (the default) for a distributor that
+  // quotes before VAT. Sales lines (step 15b) work the VAT out from here.
+  pricesIncludeVat: z.boolean(),
   version: z.number().int(),
 });
 export type Settings = z.infer<typeof settingsSchema>;
@@ -85,6 +89,7 @@ export const updateSettingsInputSchema = z.object({
   fiscalYearStartMonth: z.number().int().min(1).max(12),
   timezone: z.string().refine(isTimeZone, errorCode('timezone_invalid')),
   allowNegativeStock: z.boolean(),
+  pricesIncludeVat: z.boolean(),
 });
 export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;
 
```

- **`binSchema` and `optionalEmailSchema` are exported** so the customer form uses exactly the same rules.
- **`pricesIncludeVat`.** A shop sells at the printed MRP, which already holds the VAT; a distributor quotes before
  VAT and adds it on the invoice. The setting tells step 15b how to read every price the workspace typed (the
  product's sale price and the price lists). It is one switch for the whole workspace, because mixing the two in
  one workspace is how wrong invoices happen. It is required in the input like `allowNegativeStock`: the settings
  form always sends the whole form.

### `numbering.ts`: customer codes

```diff
@@ -16,6 +16,7 @@ export const DOCUMENT_TYPES = [
   'inventory.adjustment',
   'inventory.transfer',
   'inventory.revaluation',
+  'sales.customer',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -40,13 +41,15 @@ const DEFAULT_PREFIXES = {
   'inventory.adjustment': 'ADJ',
   'inventory.transfer': 'TRF',
   'inventory.revaluation': 'REV',
+  'sales.customer': 'C',
 } satisfies Record<DocumentType, string>;
 
 // টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
 // A product code is not a yearly document: P-00042 stays P-00042 for the product's whole life, so
 // its series never restarts (no year) and has room for 99,999 products before it grows a digit.
+// A customer code (step 15a) is the same kind of code: C-00042 for good.
 export function defaultNumberFormat(documentType: DocumentType): NumberFormat {
-  if (documentType === 'inventory.product') {
+  if (documentType === 'inventory.product' || documentType === 'sales.customer') {
     return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'none', padding: 5 };
   }
   return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'fiscal', padding: 4 };
```

A customer code is like a product code: `C-00042` stays `C-00042` for the customer's whole life. So it gets the
product's format (no year, 5 digits) instead of the yearly document format. The prefix `C` can be changed in
Settings → Numbering like any other series.

### `permissions.ts`: three sales permissions

```diff
@@ -21,6 +21,9 @@ export const PERMISSION_KEYS = [
   'inventory.stock.transfer',
   'inventory.stock.value',
   'inventory.stock.revalue',
+  'sales.customer.manage',
+  'sales.customer.balance',
+  'sales.price_list.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -33,7 +36,7 @@ export function isPermissionKey(value: string): value is PermissionKey {
 
 // matrix-এর সারি কোন দলে: key-র মাঝের অংশ (resource) দিয়ে না, হাতে বাছা — "Team" দলে user আর role
 // দুটোই থাকে, কারণ মানুষ দুটোকে একই কাজ ভাবে। Record<PermissionKey, …>: নতুন key দল ছাড়া থাকতে পারে না
-export const PERMISSION_GROUPS = ['team', 'workspace', 'accounting', 'inventory'] as const;
+export const PERMISSION_GROUPS = ['team', 'workspace', 'accounting', 'inventory', 'sales'] as const;
 export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];
 
 export const PERMISSION_GROUP_OF = {
@@ -56,4 +59,7 @@ export const PERMISSION_GROUP_OF = {
   'inventory.stock.transfer': 'inventory',
   'inventory.stock.value': 'inventory',
   'inventory.stock.revalue': 'inventory',
+  'sales.customer.manage': 'sales',
+  'sales.customer.balance': 'sales',
+  'sales.price_list.manage': 'sales',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

- **`sales.customer.manage`**: add, change, archive and delete customers and their groups.
- **`sales.customer.balance`**: see what customers owe, and their statements. Kept apart from `manage`: a sales
  officer who collects dues needs to see balances but should not edit credit limits; a data-entry clerk who adds
  customers does not need to see what they owe.
- **`sales.price_list.manage`**: change the price lists. Prices are a commercial decision, so not everyone who adds
  customers may change them.
- **A new `'sales'` group.** The roles matrix shows these three under their own heading. `PERMISSION_GROUP_OF` is a
  `Record<PermissionKey, PermissionGroup>`, so a key without a group does not compile.

Step 15c adds `sales.credit.override` with the credit limit check that uses it.

### `errors.ts`, `routes.ts` and `index.ts`

```diff
@@ -220,6 +220,33 @@ export const ERROR_CODES = [
   'revaluation_no_stock',
   'revaluation_variant_twice',
   'account_used_by_stock',
+  // customers, VAT rates and price lists (step 15a)
+  'customer_code_format',
+  'customer_code_taken',
+  'customer_name_required',
+  'customer_address_required',
+  'customer_billing_twice',
+  'customer_group_invalid',
+  'customer_in_use',
+  'customer_group_name_required',
+  'customer_group_name_taken',
+  'customer_group_in_use',
+  'tax_rate_name_required',
+  'tax_rate_name_taken',
+  'tax_rate_format',
+  'tax_rate_kind_rate',
+  'tax_rate_default_archived',
+  'tax_rate_default_needed',
+  'tax_rate_invalid',
+  'price_list_name_required',
+  'price_list_name_taken',
+  'price_list_invalid',
+  'price_list_item_twice',
+  'price_list_unit_invalid',
+  'journal_party_required',
+  'journal_party_not_allowed',
+  'journal_party_invalid',
+  'opening_balance_twice',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

Each new code is used by exactly one rule. The ones the contract does not raise itself come from the server in
15a.3: `customer_code_taken` and the `_name_taken` codes (unique indexes), `customer_in_use` (deleting a customer
with entries), `customer_group_invalid` / `price_list_invalid` / `tax_rate_invalid` (an archived or unknown id in a
form), `tax_rate_default_archived` (the default rate cannot be archived), `tax_rate_default_needed` (un-ticking
"default" on the only default), `price_list_unit_invalid` (a unit the product does not come in), and the three
`journal_party_*` codes. Every code needs its text in `en.ts` and `bn.ts` (part 15a.5), or the type check fails.

```diff
@@ -14,6 +14,8 @@ import { numberSeriesRoutes } from './numbering.js';
 import { meRoutes } from './preferences.js';
 import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
 import { customFieldRoutes } from './custom-fields.js';
+import { customerGroupRoutes, customerRoutes } from './customers.js';
+import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
 import { productRoutes } from './products.js';
@@ -25,6 +27,7 @@ import { stockAdjustmentRoutes } from './stock-adjustments.js';
 import { stockRevaluationRoutes } from './stock-revaluations.js';
 import { stockTransferRoutes } from './stock-transfers.js';
 import { stockRoutes } from './stock.js';
+import { taxRateRoutes } from './tax-rates.js';
 import { unitRoutes } from './units.js';
 import { warehouseRoutes } from './warehouses.js';
 
@@ -74,4 +77,8 @@ export const routes = {
   stockTransfers: stockTransferRoutes,
   stockRevaluations: stockRevaluationRoutes,
   stockAccounts: stockAccountRoutes,
+  taxRates: taxRateRoutes,
+  customers: customerRoutes,
+  customerGroups: customerGroupRoutes,
+  priceLists: priceListRoutes,
 };
```

```diff
@@ -4,6 +4,7 @@ export * from './audit.js';
 export * from './auth.js';
 export * from './branches.js';
 export * from './custom-fields.js';
+export * from './customers.js';
 export * from './errors.js';
 export * from './fields.js';
 export * from './http.js';
@@ -16,6 +17,7 @@ export * from './numbering.js';
 export * from './pagination.js';
 export * from './permissions.js';
 export * from './preferences.js';
+export * from './price-lists.js';
 export * from './product-categories.js';
 export * from './product-imports.js';
 export * from './products.js';
@@ -30,5 +32,6 @@ export * from './stock-accounts.js';
 export * from './stock-adjustments.js';
 export * from './stock-revaluations.js';
 export * from './stock-transfers.js';
+export * from './tax-rates.js';
 export * from './units.js';
 export * from './warehouses.js';
```

The four new route groups join the list that the API's route test and the OpenAPI document both read. If a route
is missing in Nest after 15a.3, `contract.spec.ts` fails.

### Tests

```ts
import { describe, expect, it } from 'vitest';

import { taxRateInputSchema } from './tax-rates.js';

describe('VAT rate input', () => {
  it('takes a standard rate with up to 2 decimals', () => {
    expect(
      taxRateInputSchema.parse({
        name: 'VAT 7.5%',
        kind: 'reduced',
        rate: '7.5',
        isDefault: false,
      }),
    ).toMatchObject({ rate: '7.5' });
  });

  it('refuses a charged kind at 0%, and a zero-rated or exempt kind with a rate', () => {
    for (const [kind, rate] of [
      ['standard', '0'],
      ['reduced', '0.00'],
      ['zero_rated', '15'],
      ['exempt', '5'],
    ]) {
      const result = taxRateInputSchema.safeParse({ name: 'VAT', kind, rate, isDefault: false });
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ path: ['rate'], message: 'tax_rate_kind_rate' }),
      ]);
    }
  });

  it('refuses 100% and more than 2 decimals', () => {
    for (const rate of ['100', '15.005', '-5', '']) {
      const result = taxRateInputSchema.safeParse({
        name: 'VAT',
        kind: 'standard',
        rate,
        isDefault: false,
      });
      expect(result.error?.issues[0]?.message).toBe('tax_rate_format');
    }
  });
});
```

The second test walks all four wrong combinations of kind and rate, because each one would put a sale in a wrong
box of the VAT return. The third one includes `'15.005'` (three decimals) and `''` (an empty box): both must be
refused with the format error, not saved as 0.

```ts
import { describe, expect, it } from 'vitest';

import { type CustomerFormValues, customerInputSchema } from './customers.js';
import { setPriceListItemsInputSchema } from './price-lists.js';

function customer(extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    code: '',
    name: 'Rahman Traders',
    groupId: '',
    contactPerson: '',
    phone: '01711-000000',
    email: '',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  };
}

describe('customer input', () => {
  it('reads empty boxes as "not set": no code, no group, no limit', () => {
    expect(customerInputSchema.parse(customer())).toMatchObject({
      code: null,
      groupId: null,
      email: null,
      bin: null,
      creditLimit: null,
      priceListId: null,
    });
  });

  it('keeps a credit limit of zero: cash only is a real limit', () => {
    expect(customerInputSchema.parse(customer({ creditLimit: '0' })).creditLimit).toBe('0');
  });

  it('refuses a second billing address, on the second one', () => {
    const address = {
      id: null,
      kind: 'billing',
      label: '',
      address: 'House 12, Road 3, Mirpur',
      phone: '',
    } as const;
    const result = customerInputSchema.safeParse(
      customer({ addresses: [address, { ...address, kind: 'shipping' }, address] }),
    );
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['addresses', 2, 'kind'],
        message: 'customer_billing_twice',
      }),
    ]);
  });

  it('cleans a BIN typed with hyphens, and refuses a short one', () => {
    expect(customerInputSchema.parse(customer({ bin: '000123456-0101' })).bin).toBe(
      '0001234560101',
    );
    expect(
      customerInputSchema.safeParse(customer({ bin: '12345' })).error?.issues[0]?.message,
    ).toBe('bin_format');
  });
});

describe('price list changes', () => {
  const variant = '01939d1c-0000-7000-8000-000000000001';
  const carton = '01939d1c-0000-7000-8000-000000000002';
  const piece = '01939d1c-0000-7000-8000-000000000003';

  it('reads an empty price as "take it out of the list"', () => {
    const parsed = setPriceListItemsInputSchema.parse({
      changes: [
        { variantId: variant, unitId: piece, price: '' },
        { variantId: variant, unitId: carton, price: '2150' },
      ],
    });
    expect(parsed.changes.map((change) => change.price)).toEqual([null, '2150']);
  });

  it('refuses the same item and unit twice in one save', () => {
    const change = { variantId: variant, unitId: carton, price: '2150' };
    const result = setPriceListItemsInputSchema.safeParse({ changes: [change, change] });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['changes', 1, 'price'], message: 'price_list_item_twice' }),
    ]);
  });
});
```

- **"keeps a credit limit of zero"** guards the difference between `null` (no limit) and `"0"` (cash only). A
  careless `|| null` somewhere would turn cash-only customers into customers without a limit.
- **"refuses a second billing address"** checks the path too: the error must sit on the second billing address
  (index 2), not on the shipping one in between.
- **The price list tests** check that an empty price means "remove", and that the duplicate error points at the
  second row.

```diff
@@ -1,6 +1,11 @@
 import { describe, expect, it } from 'vitest';
 
-import { journalEntryInputSchema, periodLockInputSchema, shiftIsoDate } from './journal.js';
+import {
+  journalEntryInputSchema,
+  openingBalancesInputSchema,
+  periodLockInputSchema,
+  shiftIsoDate,
+} from './journal.js';
 
 const cash = '01939d1c-0000-7000-8000-000000000001';
 const capital = '01939d1c-0000-7000-8000-000000000002';
@@ -80,3 +85,48 @@ describe('shiftIsoDate', () => {
     expect(shiftIsoDate('2028-02-28', 1)).toBe('2028-02-29');
   });
 });
+
+describe('journal lines with a party (step 15a)', () => {
+  const receivable = '01939d1c-0000-7000-8000-000000000003';
+  const dealer = '01939d1c-0000-7000-8000-000000000004';
+
+  it('reads a missing or empty customer as "no party"', () => {
+    const parsed = journalEntryInputSchema.parse(
+      entry([
+        {
+          accountId: receivable,
+          branchId: '',
+          description: '',
+          debit: '1200',
+          credit: '',
+          partyId: dealer,
+        },
+        { accountId: cash, branchId: '', description: '', debit: '', credit: '1200', partyId: '' },
+        { accountId: capital, branchId: '', description: '', debit: '', credit: '1' },
+      ]),
+    );
+    expect(parsed.lines.map((line) => line.partyId)).toEqual([dealer, null, null]);
+  });
+
+  it('refuses the same account and customer twice in the opening balances', () => {
+    const line = { accountId: receivable, partyId: dealer, debit: '5000', credit: '' };
+    const result = openingBalancesInputSchema.safeParse({
+      goLiveDate: '2026-07-01',
+      replaces: null,
+      lines: [line, { ...line, partyId: '01939d1c-0000-7000-8000-000000000005' }, line],
+    });
+    expect(result.error?.issues).toEqual([
+      expect.objectContaining({ path: ['lines', 2, 'debit'], message: 'opening_balance_twice' }),
+    ]);
+  });
+
+  it('lets empty lines repeat: the server drops them', () => {
+    const empty = { accountId: receivable, partyId: '', debit: '', credit: '' };
+    const result = openingBalancesInputSchema.safeParse({
+      goLiveDate: '2026-07-01',
+      replaces: null,
+      lines: [empty, empty, { ...empty, partyId: dealer, debit: '5000' }],
+    });
+    expect(result.success).toBe(true);
+  });
+});
```

The first new test sends one line with a customer, one with `''` and one without the field at all. All three
shapes must parse, the last one because older apps send it. The second test checks the opening balance duplicate
rule, and that a different customer on the same account is fine.

```diff
@@ -30,6 +30,7 @@ function product(extra: Partial<ProductFormValues> = {}): ProductFormValues {
     purchaseUnitId: '',
     tracking: 'none',
     hasExpiry: false,
+    taxRateId: '',
     options: [],
     variants: [variant()],
     units: [],
```

```diff
@@ -16,6 +16,7 @@ const valid = {
   fiscalYearStartMonth: 7,
   timezone: 'Asia/Dhaka',
   allowNegativeStock: false,
+  pricesIncludeVat: false,
 } as const;
 
 describe('settings input', () => {
```

The existing fixtures get the two new required fields. Nothing else in those tests changes.

> After this part, `pnpm --filter @omnivo/contracts typecheck` and its tests pass (106). `pnpm typecheck` for the
> whole repo does **not** pass yet: the API and the app do not send `party`, `taxRateId` and `pricesIncludeVat`.
> The next parts fix that.

## 15a.2 — `packages/db`: six tables, three columns, two migrations

The contract says "customer", "VAT rate" and "price list"; this part gives them tables. Three new schema files
hold the six new tables. Three existing tables get one column each: a VAT rate on a product, the "prices include
VAT" switch on the settings, and a party on a journal line. Migration 0025 is generated from the schema; 0026 is
written by hand (RLS, search indexes, the posting rule and the VAT rates of existing workspaces).

### `schema/tax-rates.ts` (new)

```ts
import { TAX_RATE_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// The VAT rates a workspace charges (step 15a): 15%, 10%, 7.5%, 5%, zero-rated, exempt. Made from
// the list in TypeScript when the workspace is set up (and by migration 0026's event for older
// ones). deleted_at is not used: a rate is archived, never deleted, because old documents name it.
export const taxRates = pgTable(
  'tax_rates',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: TAX_RATE_KINDS }).notNull(),
    // A percentage: 15.00, 7.50. NUMERIC(5,2), read and written as a string.
    rate: numeric('rate', { precision: 5, scale: 2 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // "VAT 15%" once per workspace, in any case
    uniqueIndex('tax_rates_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    // The target of the composite FK from products (and from 15b's sales lines)
    uniqueIndex('tax_rates_tenant_id_idx').on(table.tenantId, table.id),
    // At most one default per workspace. "At least one" is the API's rule (tax_rate_default_needed):
    // switching the default clears the old one first, in the same transaction.
    uniqueIndex('tax_rates_tenant_default_idx')
      .on(table.tenantId)
      .where(sql`${table.isDefault}`),
    // The contract's rules, here too: below 100, and a charged kind charges something
    check('tax_rates_rate_check', sql`${table.rate} >= 0 AND ${table.rate} < 100`),
    check(
      'tax_rates_kind_rate_check',
      sql`(${table.kind} IN ('standard', 'reduced')) = (${table.rate} > 0)`,
    ),
    // The default is what every product without its own rate uses, so it cannot be hidden
    check('tax_rates_default_active', sql`NOT ${table.isDefault} OR ${table.archivedAt} IS NULL`),
  ],
);
```

- **`rate` is `NUMERIC(5,2)`.** It holds 0.00 to 999.99, and a check keeps it below 100. Two decimals are what
  the contract allows (`7.5` is stored as `7.50`), and Drizzle reads it as a string, so no rounding can happen on
  the way.
- **`tax_rates_tenant_default_idx` is a partial unique index** on `tenant_id`, only over rows where `is_default` is
  true. So at most one row per workspace can be the default, even if two people press "Make default" at the same
  moment: the second insert or update fails here. The other half of the rule ("at least one default") cannot be
  an index. The API keeps it (part 15a.3): when the default moves, it clears the old one and sets the new one in
  one transaction, in that order, or the index would see two defaults for a moment.
- **`tax_rates_kind_rate_check`** is the contract's `.refine` again: standard and reduced charge something, zero-
  rated and exempt charge nothing. A rate written by any other path (a script, a later import) still cannot be a
  "standard 0%".
- **`tax_rates_default_active`.** The default rate cannot be archived: every product without its own rate would
  suddenly point at a hidden rate. The API answers with `tax_rate_default_archived` before the database has to.
- **`tax_rates_tenant_id_idx` (unique on tenant and id).** Like every table since step 9, this is the target of a
  composite foreign key: a product can only point at a rate of its own workspace.

### `schema/price-lists.ts` (new)

```ts
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { units } from './units.js';

// A named set of prices: "Dealer", "Wholesale" (step 15a). A customer points at one; step 15b's
// lookup reads it. deleted_at is not used: a list is archived, never deleted.
export const priceLists = pgTable(
  'price_lists',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('price_lists_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    // The target of the composite FKs from items and parties
    uniqueIndex('price_lists_tenant_id_idx').on(table.tenantId, table.id),
  ],
);

// One price: a variant, in one unit, in one list. No id and no version: the key is the row
// (the PUT batch upserts on it), and each row is saved on its own (no lost update to guard).
export const priceListItems = pgTable(
  'price_list_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    priceListId: uuid('price_list_id').notNull(),
    // product_id is here for the FK below (a variant of THIS product) and for the page's join
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The base unit or one of the product's units (the API checks it: price_list_unit_invalid).
    // The price is per one of this unit.
    unitId: uuid('unit_id').notNull(),
    price: numeric('price', { precision: 19, scale: 4 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    primaryKey({
      name: 'price_list_items_pkey',
      columns: [table.tenantId, table.priceListId, table.variantId, table.unitId],
    }),
    // A list's page groups the rows by product, and itemCount counts them
    index('price_list_items_list_product_idx').on(
      table.tenantId,
      table.priceListId,
      table.productId,
    ),
    // Step 15b's lookup ("this variant, in any list"), and the variant FK's own delete check
    index('price_list_items_variant_idx').on(table.tenantId, table.productId, table.variantId),
    index('price_list_items_unit_idx').on(table.tenantId, table.unitId),
    foreignKey({
      name: 'price_list_items_list_fk',
      columns: [table.tenantId, table.priceListId],
      foreignColumns: [priceLists.tenantId, priceLists.id],
    }),
    // Deleting a product (only while nothing else uses it) takes its prices with it: a price is
    // not a use of the product
    foreignKey({
      name: 'price_list_items_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'price_list_items_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Zero is a price (a free sample); an empty box in the form removes the row instead
    check('price_list_items_price_check', sql`${table.price} >= 0`),
  ],
);
```

- **`price_list_items` has no `id` and no `version`.** Its primary key is (tenant, list, variant, unit): the
  contract's "one price per item and unit". It is also the conflict target of the PUT batch's upsert in 15a.3, so
  "set the price" is one `INSERT … ON CONFLICT DO UPDATE` per row.
- **`product_id` is stored next to `variant_id`.** It makes the foreign key say "a variant of *this* product"
  (the same three-column key that stock lines use since step 13), and the items page can join and sort by the
  product without going through the variants.
- **The variant FK has `ON DELETE CASCADE`.** A product is deleted only while nothing uses it (step 12). A price
  in a list is not a use: if the product goes, its prices go with it. Without the cascade, a product that was
  ever priced in a list could never be deleted.
- **The unit FK points at `units`, not at `product_units`.** A price may be in the product's base unit, which is not
  a row of `product_units` (step 12), so no foreign key can say "one of this product's units". The API checks it
  (`price_list_unit_invalid`), and when a product loses a unit, the products service removes that unit's prices
  (part 15a.3).
- **`price >= 0`.** Zero is a real price (a free sample on a promotion list). "No price" is a missing row, and the
  item falls back to the product's own price.
- **The list FK has no `ON DELETE`.** Lists are archived, never deleted, so nothing should ever delete one; if
  something tried, the prices would stop it.

### `schema/parties.ts` (new)

```ts
import { ADDRESS_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { priceLists } from './price-lists.js';
import { tenants } from './tenants.js';

// Dealer, Retailer, Corporate: a label for filtering customers. Customer groups and not party
// groups: a party that is both has one group as a customer and (step 17) another as a supplier.
// deleted_at is not used: a group is deleted for real, only while no customer is in it.
export const customerGroups = pgTable(
  'customer_groups',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
  },
  (table) => [
    uniqueIndex('customer_groups_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    uniqueIndex('customer_groups_tenant_id_idx').on(table.tenantId, table.id),
  ],
);

// Everyone the company trades with on credit (step 15a): customers now, suppliers from step 17.
// One row per business, so a distributor that is both has one code and one statement. The
// customer's columns (group, terms, limit, price list) mean nothing for a supplier-only party.
// deleted_at is not used: a party is deleted for real (only while nothing uses it) or archived.
export const parties = pgTable(
  'parties',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // C-00042 from the 'sales.customer' series, or the company's own
    code: text('code').notNull(),
    name: text('name').notNull(),
    isCustomer: boolean('is_customer').notNull().default(false),
    isSupplier: boolean('is_supplier').notNull().default(false),
    customerGroupId: uuid('customer_group_id'),
    contactPerson: text('contact_person'),
    phone: text('phone'),
    email: text('email'),
    // 13 digits, cleaned by the contract's binSchema
    bin: text('bin'),
    // Days from an invoice to its due date (step 15c)
    paymentTermsDays: smallint('payment_terms_days').notNull().default(0),
    // NULL = no limit; 0 = cash only. NUMERIC(19,4) like every amount.
    creditLimit: numeric('credit_limit', { precision: 19, scale: 4 }),
    // NULL = the products' own sale prices
    priceListId: uuid('price_list_id'),
    notes: text('notes'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // One code means one party, in any case, whether customer or supplier
    uniqueIndex('parties_tenant_code_idx').on(table.tenantId, sql`lower(${table.code})`),
    // The target of the composite FKs from addresses and journal lines
    uniqueIndex('parties_tenant_id_idx').on(table.tenantId, table.id),
    // The customer list's keyset orders: by name, and by last change. By code uses the index
    // above. Partial: suppliers (step 17) never appear in the customer list.
    index('parties_customer_name_idx')
      .on(table.tenantId, sql`lower(${table.name})`, table.id)
      .where(sql`${table.isCustomer}`),
    index('parties_customer_updated_idx')
      .on(table.tenantId, table.updatedAt, table.id)
      .where(sql`${table.isCustomer}`),
    // A group's customers (the filter, customerCount), and the FK's check when a group is deleted
    index('parties_tenant_group_idx').on(table.tenantId, table.customerGroupId),
    index('parties_tenant_price_list_idx').on(table.tenantId, table.priceListId),
    // No ON DELETE: a group that still holds a customer cannot be deleted (customer_group_in_use)
    foreignKey({
      name: 'parties_customer_group_fk',
      columns: [table.tenantId, table.customerGroupId],
      foreignColumns: [customerGroups.tenantId, customerGroups.id],
    }),
    foreignKey({
      name: 'parties_price_list_fk',
      columns: [table.tenantId, table.priceListId],
      foreignColumns: [priceLists.tenantId, priceLists.id],
    }),
    check('parties_role_check', sql`${table.isCustomer} OR ${table.isSupplier}`),
    // 365 = the contract's MAX_PAYMENT_TERMS_DAYS
    check('parties_terms_check', sql`${table.paymentTermsDays} BETWEEN 0 AND 365`),
    check(
      'parties_credit_limit_check',
      sql`${table.creditLimit} IS NULL OR ${table.creditLimit} >= 0`,
    ),
  ],
);

// A party's addresses: at most one billing address (the one the invoice prints) and any number
// of shipping addresses (depots, outlets). Rows of their own and not a JSON list, because from
// step 15b a delivery points at the address it went to.
export const partyAddresses = pgTable(
  'party_addresses',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    partyId: uuid('party_id').notNull(),
    kind: text('kind', { enum: ADDRESS_KINDS }).notNull(),
    // The order the form shows them in; the first shipping address is the default on a delivery
    position: smallint('position').notNull(),
    label: text('label'),
    address: text('address').notNull(),
    phone: text('phone'),
  },
  (table) => [
    // A party's addresses, and the target of 15b's FK: an address of THIS customer
    uniqueIndex('party_addresses_party_id_idx').on(table.tenantId, table.partyId, table.id),
    // One billing address per party, whatever the code does
    uniqueIndex('party_addresses_billing_idx')
      .on(table.tenantId, table.partyId)
      .where(sql`${table.kind} = 'billing'`),
    // Deleting a party (only while nothing uses it) deletes its addresses
    foreignKey({
      name: 'party_addresses_party_fk',
      columns: [table.tenantId, table.partyId],
      foreignColumns: [parties.tenantId, parties.id],
    }).onDelete('cascade'),
  ],
);
```

- **`customer_groups`, not party groups.** A business that is both a customer and a supplier (decision 2) may be
  a "Dealer" as a customer and a "Fabric supplier" as a supplier. So the group is a customer column
  (`customer_group_id`), and step 17 can add its own supplier group without changing this table.
- **`parties_role_check`.** A party is a customer, a supplier, or both, never neither. A row with both flags off
  would be invisible on every page and impossible to clean up.
- **One code index for all parties.** `C-00042` is unique in the workspace whether the party is a customer or a
  supplier, in any case (`lower(code)`, like products). A journal line or a statement can then show a code
  without saying which kind of party it is.
- **The two list indexes are partial (`WHERE is_customer`).** The customer list never shows a supplier-only party,
  so those rows (from step 17) are not in its indexes. The keyset orders are the products' ones: by name, by last
  change, and by code through the unique index.
- **`credit_limit` is nullable and the check allows 0.** `NULL` is "no limit" and `0` is "cash only", the two
  different promises from the contract.
- **`parties_terms_check` writes 365 as a number.** It is the contract's `MAX_PAYMENT_TERMS_DAYS`. A check
  constraint is plain SQL in the migration, so a value from TypeScript would be copied there anyway; the comment
  says where it comes from.
- **The group FK and the price list FK have no `ON DELETE`.** A group that still holds a customer cannot be
  deleted: the FK error becomes `customer_group_in_use` in 15a.3. That is also why `customerCount` counts archived
  customers: they still hold the FK. Price lists are never deleted.
- **`party_addresses` are rows, not a JSON column.** From 15b, a delivery points at the address it went to. A row
  with an id can be pointed at; a position in a JSON list cannot.
- **`party_addresses_billing_idx`.** One billing address per party, the contract's rule, in the database too. It
  is a partial unique index, checked on every row: when the person swaps which address is the billing one, the API
  must save the address that stops being billing before the one that starts (15a.3).
- **`party_addresses_party_id_idx` is unique on (tenant, party, id).** It finds a party's addresses, and it is the
  target 15b needs for "an address of *this* customer". One index does both jobs.
- **Deleting a party deletes its addresses** (`ON DELETE CASCADE`). A party is deleted only while no entry or
  document uses it, so its addresses are not used either.

### `schema/journal.ts`: a party on a line

```diff
@@ -16,6 +16,7 @@ import {
 import { baseColumns } from '../base-columns.js';
 import { branches } from './branches.js';
 import { ledgerAccounts } from './ledger-accounts.js';
+import { parties } from './parties.js';
 import { tenants } from './tenants.js';
 
 // One journal entry: the header. Its debits and credits are the rows of journal_lines. Three
@@ -102,6 +103,10 @@ export const journalLines = pgTable(
     accountId: uuid('account_id').notNull(),
     // Optional: which branch the amount belongs to (branch-wise P&L later)
     branchId: uuid('branch_id'),
+    // Step 15a: whose line this is. Set on every line of the receivable account and on no other
+    // line (migration 0026 checks it when the entry is posted), so the customers' balances add up
+    // to the account's balance. Lines posted before step 15a have none.
+    partyId: uuid('party_id'),
     description: text('description'),
     // NUMERIC(19,4), read and written as strings: never a JavaScript number
     debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
@@ -130,6 +135,17 @@ export const journalLines = pgTable(
       columns: [table.tenantId, table.branchId],
       foreignColumns: [branches.tenantId, branches.id],
     }),
+    // A customer's balance and statement. Partial: most lines (cash, sales, expenses) have no
+    // party and are left out. Also the FK's check when a customer is deleted.
+    index('journal_lines_tenant_party_idx')
+      .on(table.tenantId, table.partyId)
+      .where(sql`${table.partyId} IS NOT NULL`),
+    // A customer with lines cannot be deleted: the API turns this FK's error into customer_in_use
+    foreignKey({
+      name: 'journal_lines_party_fk',
+      columns: [table.tenantId, table.partyId],
+      foreignColumns: [parties.tenantId, parties.id],
+    }),
     // Exactly one side has an amount, and neither is negative
     check(
       'journal_lines_one_side',
```

- **`party_id` is nullable.** Most lines (cash, sales, expenses) have no party. And the lines posted before this
  step have none, even on the receivable: we do not guess whose they were.
- **The rule "a party exactly on the receivable" is not a check constraint.** A check sees one row, and the line
  does not know its account's purpose. Migration 0026 adds it to the posting trigger, which can join the accounts.
- **`journal_lines_tenant_party_idx` is partial (`WHERE party_id IS NOT NULL`).** A customer's balance and
  statement read only that customer's lines, and the index holds only lines that have a party: a small slice of
  the table. Postgres also uses it to check the FK when a customer is deleted.
- **The party FK has no `ON DELETE`.** A customer with entries cannot be deleted; the API turns the FK error into
  `customer_in_use`, the same way step 10 does it for accounts.

### `schema/products.ts` and `schema/tenant-settings.ts`

```diff
@@ -21,6 +21,7 @@ import {
 } from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
 import { productCategories } from './product-categories.js';
+import { taxRates } from './tax-rates.js';
 import { tenants } from './tenants.js';
 import { units } from './units.js';
 
@@ -44,6 +45,9 @@ export const products = pgTable(
     baseUnitId: uuid('base_unit_id').notNull(),
     tracking: text('tracking', { enum: TRACKING_MODES }).notNull().default('none'),
     hasExpiry: boolean('has_expiry').notNull().default(false),
+    // The VAT rate its sales lines start with (step 15a). NULL = the workspace's default rate, so
+    // changing the default moves every product that never chose its own.
+    taxRateId: uuid('tax_rate_id'),
     // [{ name: 'Size', values: ['S', 'M'] }], checked with Zod on the way in. JSONB, not a table:
     // it is only ever read and written whole, with its product.
     options: jsonb('options')
@@ -68,6 +72,9 @@ export const products = pgTable(
     // A category's products — and Postgres's own check of the FK when a category is deleted
     index('products_tenant_category_idx').on(table.tenantId, table.categoryId),
     index('products_tenant_base_unit_idx').on(table.tenantId, table.baseUnitId),
+    // "Which products use this rate?" Rates are archived, never deleted, so the FK below never
+    // has to check a delete; the index is for the settings page's count and the reports.
+    index('products_tenant_tax_rate_idx').on(table.tenantId, table.taxRateId),
     foreignKey({
       name: 'products_category_fk',
       columns: [table.tenantId, table.categoryId],
@@ -78,6 +85,12 @@ export const products = pgTable(
       columns: [table.tenantId, table.baseUnitId],
       foreignColumns: [units.tenantId, units.id],
     }),
+    // NULL tax_rate_id skips the check (MATCH SIMPLE)
+    foreignKey({
+      name: 'products_tax_rate_fk',
+      columns: [table.tenantId, table.taxRateId],
+      foreignColumns: [taxRates.tenantId, taxRates.id],
+    }),
     // The same two rules as the contract's productRules, here too: a row written by any other path
     // (a script, a later import) still cannot be a tracked service or an expiry without batches
     check('products_service_untracked', sql`${table.type} = 'goods' OR ${table.tracking} = 'none'`),
```

`tax_rate_id` is nullable on purpose (the contract's "follow the default"). Adding a nullable column without a
default does not rewrite the table, so the migration is instant even with many products.

```diff
@@ -29,6 +29,9 @@ export const tenantSettings = pgTable(
     logoAttachmentId: uuid('logo_attachment_id'),
     // Step 13: may an untracked product's stock go below zero? Read by migration 0022's trigger.
     allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
+    // Step 15a: do the prices the workspace types already hold the VAT? Off = before VAT, the way
+    // a distributor quotes. Read by step 15b's sales lines.
+    pricesIncludeVat: boolean('prices_include_vat').notNull().default(false),
     createdAt: baseColumns().createdAt,
     updatedAt: baseColumns().updatedAt,
     updatedBy: baseColumns().updatedBy,
```

The default is `false` (prices before VAT): every existing workspace keeps reading its prices the way it did
before this step, because before this step no price had VAT in it.

### The other files

```diff
@@ -30,3 +30,6 @@ export * from './warehouses.js';
 export * from './stock.js';
 export * from './stock-documents.js';
 export * from './stock-valuation.js';
+export * from './tax-rates.js';
+export * from './price-lists.js';
+export * from './parties.js';
```

```diff
@@ -17,6 +17,7 @@ export const OUTBOX_EVENT_TYPES = [
   'product.import_requested',
   'stock.below_reorder',
   'workspace.stock_accounts_requested',
+  'workspace.tax_rates_requested',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

`workspace.tax_rates_requested` asks the worker to make the starting VAT rates of a workspace that was set up
before this step (migration 0026). New workspaces get them from the setup job.

```diff
@@ -29,6 +29,9 @@ const DESCRIPTIONS = {
   'inventory.stock.transfer': 'Send stock to another warehouse and receive it there',
   'inventory.stock.value': 'See what stock costs and what it is worth',
   'inventory.stock.revalue': 'Revalue stock: give items a new average cost',
+  'sales.customer.manage': 'Add, edit, archive and delete customers and customer groups',
+  'sales.customer.balance': 'See what customers owe, and their statements',
+  'sales.price_list.manage': 'Add, edit and archive price lists, and set their prices',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

The `satisfies Record<PermissionKey, string>` is why this file must change now: the three new keys
from 15a.1 have no description yet, and the db package does not compile until they do. As in earlier steps, the
owner has every permission; other existing roles do not get the new ones until someone ticks them.

### Migration 0025 (generated — then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name customers`. As in steps 9–14, `drizzle-kit` writes the foreign keys
before the unique indexes they point at (`price_lists_tenant_id_idx`, `parties_tenant_id_idx`, …), and the
migration fails with "there is no unique constraint matching given keys". Move every `CREATE INDEX` and
`CREATE UNIQUE INDEX` up, before the first `ADD CONSTRAINT … FOREIGN KEY`. The result:

```sql
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tax_rates_rate_check" CHECK ("tax_rates"."rate" >= 0 AND "tax_rates"."rate" < 100),
	CONSTRAINT "tax_rates_kind_rate_check" CHECK (("tax_rates"."kind" IN ('standard', 'reduced')) = ("tax_rates"."rate" > 0)),
	CONSTRAINT "tax_rates_default_active" CHECK (NOT "tax_rates"."is_default" OR "tax_rates"."archived_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"tenant_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "price_list_items_pkey" PRIMARY KEY("tenant_id","price_list_id","variant_id","unit_id"),
	CONSTRAINT "price_list_items_price_check" CHECK ("price_list_items"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_groups" (
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
CREATE TABLE "parties" (
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
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"customer_group_id" uuid,
	"contact_person" text,
	"phone" text,
	"email" text,
	"bin" text,
	"payment_terms_days" smallint DEFAULT 0 NOT NULL,
	"credit_limit" numeric(19, 4),
	"price_list_id" uuid,
	"notes" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "parties_role_check" CHECK ("parties"."is_customer" OR "parties"."is_supplier"),
	CONSTRAINT "parties_terms_check" CHECK ("parties"."payment_terms_days" BETWEEN 0 AND 365),
	CONSTRAINT "parties_credit_limit_check" CHECK ("parties"."credit_limit" IS NULL OR "parties"."credit_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "party_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" smallint NOT NULL,
	"label" text,
	"address" text NOT NULL,
	"phone" text
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "prices_include_vat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_tenant_name_idx" ON "tax_rates" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_tenant_id_idx" ON "tax_rates" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_tenant_default_idx" ON "tax_rates" USING btree ("tenant_id") WHERE "tax_rates"."is_default";--> statement-breakpoint
CREATE INDEX "price_list_items_list_product_idx" ON "price_list_items" USING btree ("tenant_id","price_list_id","product_id");--> statement-breakpoint
CREATE INDEX "price_list_items_variant_idx" ON "price_list_items" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "price_list_items_unit_idx" ON "price_list_items" USING btree ("tenant_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_tenant_name_idx" ON "price_lists" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_tenant_id_idx" ON "price_lists" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_groups_tenant_name_idx" ON "customer_groups" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "customer_groups_tenant_id_idx" ON "customer_groups" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_tenant_code_idx" ON "parties" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "parties_tenant_id_idx" ON "parties" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "parties_customer_name_idx" ON "parties" USING btree ("tenant_id",lower("name"),"id") WHERE "parties"."is_customer";--> statement-breakpoint
CREATE INDEX "parties_customer_updated_idx" ON "parties" USING btree ("tenant_id","updated_at","id") WHERE "parties"."is_customer";--> statement-breakpoint
CREATE INDEX "parties_tenant_group_idx" ON "parties" USING btree ("tenant_id","customer_group_id");--> statement-breakpoint
CREATE INDEX "parties_tenant_price_list_idx" ON "parties" USING btree ("tenant_id","price_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_addresses_party_id_idx" ON "party_addresses" USING btree ("tenant_id","party_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_addresses_billing_idx" ON "party_addresses" USING btree ("tenant_id","party_id") WHERE "party_addresses"."kind" = 'billing';--> statement-breakpoint
CREATE INDEX "journal_lines_tenant_party_idx" ON "journal_lines" USING btree ("tenant_id","party_id") WHERE "journal_lines"."party_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "products_tenant_tax_rate_idx" ON "products" USING btree ("tenant_id","tax_rate_id");--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_customer_group_fk" FOREIGN KEY ("tenant_id","customer_group_id") REFERENCES "public"."customer_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_price_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;
```

- **The three `ADD COLUMN`s change no row.** `party_id` and `tax_rate_id` are nullable without a default, and
  `prices_include_vat` has a constant default, which Postgres stores once in the catalog instead of writing it
  into every row. So step 10's guard on posted lines never fires: no `UPDATE` runs on `journal_lines`.
- **The two new FKs on old tables** (`journal_lines_party_fk`, `products_tax_rate_fk`) are checked against every
  existing row, which is instant: every value is `NULL`.
- The snapshot (`meta/0025_snapshot.json`) and `_journal.json` are written by `drizzle-kit`; commit them as they
  are.

### Migration 0026 (custom): RLS, search, the party rule, the VAT rates

Run `pnpm --filter @omnivo/db generate --custom --name customers-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --

-- 1) The six new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'tax_rates', 'customer_groups', 'parties', 'party_addresses', 'price_lists',
      'price_list_items'
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

-- 2) "Contains" search for the customer list, like 0020's for products: part of a name, a code,
--    a contact person or a phone number ("1711" finds "01711-234567"). pg_trgm is there since
--    0020. Not in the Drizzle schema, for the same reason as 0020's.
CREATE INDEX parties_name_trgm_idx ON parties USING gin (lower(name) gin_trgm_ops);
CREATE INDEX parties_code_trgm_idx ON parties USING gin (lower(code) gin_trgm_ops);
CREATE INDEX parties_contact_trgm_idx ON parties USING gin (lower(contact_person) gin_trgm_ops);
CREATE INDEX parties_phone_trgm_idx ON parties USING gin (phone gin_trgm_ops);

-- 3) The posting check from 0016, with one more rule: a line has a party exactly when its account
--    is kept per party (contracts' PARTY_ACCOUNT_PURPOSES: the receivable). This is what makes the
--    customers' balances add up to the receivable account, so it lives here, under every path that
--    posts. It runs when an entry is posted, so lines posted before step 15a are never checked.
--    One exception: a reversal copies its original's lines as they were, so the reversal of an
--    entry from before step 15a may have a receivable line without a party. Without it, such an
--    entry (or the old opening balances, which a save reverses) could never be undone.
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
       AND (l.party_id IS NOT NULL) <> coalesce(a.purpose IN ('accounts_receivable'), false)
       AND NOT (NEW.source = 'reversal' AND l.party_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'journal entry % has a party on the wrong line', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_party_check';
  END IF;
  RETURN NULL;
END $$;

-- 4) The VAT rates of the workspaces that already exist. The list lives in TypeScript (the setup
--    templates, 15a.3), so, like 0020's catalog and 0024's stock accounts, one outbox event per
--    workspace asks the worker to make them with the same code the setup job uses. 'pending'
--    workspaces are skipped: their setup job makes them after the owner picks a business type.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE setup_status <> 'pending' AND deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO outbox_events (id, tenant_id, type, payload)
    VALUES (gen_random_uuid(), t, 'workspace.tax_rates_requested', '{}'::jsonb);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

Part by part:

1. **RLS on the six new tables**, exactly like 0016, 0020 and 0024. The tenant-leak suite's RLS coverage test
   fails if any table with a `tenant_id` lacks `FORCE ROW LEVEL SECURITY`.
2. **Four trigram indexes for the customer search** (name, code, contact person, phone), like 0020's for
   products. The phone index is on `phone` itself, not `lower(phone)`: a phone number has no case. The search
   looks for part of a number, so "1711" finds `01711-234567`.
3. **`CREATE OR REPLACE FUNCTION journal_entries_balanced()`.** The function from 0016, word for word, plus a third
   check at the end. The trigger itself is not created again: it calls the function by name.
   - **`(l.party_id IS NOT NULL) <> coalesce(a.purpose IN ('accounts_receivable'), false)`** finds a line that has
     a party where its account is not kept per party, or has none where it is. `purpose` is `NULL` for most
     accounts, and `NULL IN (…)` is `NULL`, not `false`: without the `coalesce`, those lines would never be
     compared. The list of purposes is the contract's `PARTY_ACCOUNT_PURPOSES`; step 17 replaces this function
     again and adds `'accounts_payable'`.
   - **`AND NOT (NEW.source = 'reversal' AND l.party_id IS NULL)`.** A reversal copies its original's lines
     as they were. The original may be from before this step and have a receivable line without a party; its
     reversal must still be allowed. This matters for the opening balances most of all: saving them again
     reverses the old entry (step 10) before it posts the new one, split by customer (decision 4). The exception
     only lets a party be *missing*; a reversal can never put a party on a wrong account, because its original
     could not.
   - **It runs at posting only** (the trigger's `WHEN (NEW.status = 'posted')`, from 0016). The entries posted
     before this step are never checked again, so the migration does not fail on old data. Drafts are not checked
     either: a half-written draft may not have its customer yet.
   - **A `CONSTRAINT` name on the error** (`journal_lines_party_check`), like the other two. The API checks the
     same rule first and answers `journal_party_required` or `journal_party_not_allowed` per line (15a.3). The
     database's error is the safety net for any code path that forgets.
4. **One `workspace.tax_rates_requested` event per workspace that is set up.** The starting rates (15%, 10%, 7.5%,
   5%, zero-rated, exempt) live in TypeScript with the other setup templates, so the worker makes them with the
   same code the setup job uses for a new workspace (15a.3). Writing them here in SQL would be a second copy of the
   list that could drift. `'pending'` workspaces are skipped: their setup job makes the rates when the owner picks
   a business type. Until the worker runs, a workspace has no rates, which is safe: a product's `tax_rate_id` is
   `NULL` anyway, and no sales line exists before 15b.

> **What we checked.** After 0024, a throwaway database got a workspace with a receivable entry posted the step 14
> way (no party), and a workspace still in setup. Then 0025 and 0026 ran, and as `omnivo_app`: a new receivable
> line without a customer was refused (`journal_lines_party_check`); the reversal of the old entry was accepted; a
> receivable line with a customer was accepted; a customer on the cash line was refused; deleting a customer with
> lines failed on `journal_lines_party_fk`; a second default rate, a "standard 0%", an archived default, a 100%
> rate, a duplicate rate name, a second billing address, a party that is neither customer nor supplier, 400 days
> of terms and a duplicate code (in another case) all failed on their own constraints; another workspace saw no
> parties. Only the set-up workspace got a `workspace.tax_rates_requested` event. `drizzle-kit generate` then
> reports no schema changes.

## 15a.3 — `apps/api`: VAT rates, customers, price lists, and customers in the books

This part makes the API serve everything the contract of 15a.1 promised, on the tables of 15a.2. It has four
pieces:

1. **The VAT rates**: a small new module (`tax/`), and the worker job that gives every workspace its starting
   rates.
2. **The journal learns about customers**: one rule in `PostingService` ("a receivable line names a customer, no
   other line does"), the customer on each line of an entry and of a ledger, a customer's statement, and the
   opening balances split by customer.
3. **Customers, customer groups and price lists**: a new `sales/` module.
4. **Small changes** where the contract grew: a product's VAT rate, the "prices include VAT" setting, and the
   new audit actions.

The price *lookup* (which price a sales line starts with) is not here. It is written in 15b, next to the forms
that call it, so that it is tested with its real callers.

One decision was left open by 15a.2: what to show for receivable lines posted before this step, which name no
customer. **This step shows them as they are**: the receivable's ledger shows those lines with an empty customer,
and the customers' balances do not include them. So for old data, the customers' balances add up to *less* than
the receivable account's balance. There is no "Unassigned" customer: it would be a fake party that can never be
deleted, and it would show up in every customer picker. To fix old data, reverse the old entry and enter it again
with a customer; for the opening receivable, save the opening balances page again, split by customer (decision 4).

### `packages/contracts/src/audit.ts`: the new audit actions

```diff
@@ -79,6 +79,25 @@ export const AUDIT_ACTIONS = [
   'stock_accounts.changed',
   'stock_accounts.created',
   'stock_revaluation.posted',
+  // step 15a
+  'tax_rate.created',
+  'tax_rate.updated',
+  'tax_rate.archived',
+  'tax_rate.restored',
+  'tax_rates.created',
+  'customer.created',
+  'customer.updated',
+  'customer.archived',
+  'customer.restored',
+  'customer.deleted',
+  'customer_group.created',
+  'customer_group.updated',
+  'customer_group.deleted',
+  'price_list.created',
+  'price_list.updated',
+  'price_list.archived',
+  'price_list.restored',
+  'price_list.prices_changed',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -108,6 +127,10 @@ export const AUDIT_ENTITY_TYPES = [
   'stock_transfer',
   'reorder_level',
   'stock_revaluation',
+  'tax_rate',
+  'customer',
+  'customer_group',
+  'price_list',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

Every change below writes an audit row, and `audit()` only accepts actions and entity types from these lists
(the `audit_logs` columns are typed from them too). `tax_rates.created` (plural) is the worker making the starting
rates of a whole workspace; `tax_rate.created` is one rate a person added. `price_list.prices_changed` is one
row for a whole batch of prices: see `setItems()` below. The app's translations of these names come in 15a.5.

### The starting VAT rates

```diff
@@ -5,6 +5,7 @@ import type {
   Industry,
   PermissionKey,
   StockAccountUse,
+  TaxRateKind,
   UnitDimension,
 } from '@omnivo/contracts';
 
@@ -58,6 +59,27 @@ export interface CatalogTemplate {
   customFields: readonly CustomFieldTemplate[];
 }
 
+// A VAT rate a new workspace starts with (step 15a). rate: a percentage as the form writes it.
+export interface TaxRateTemplate {
+  name: string;
+  kind: TaxRateKind;
+  rate: string;
+  isDefault: boolean;
+}
+
+// The same for every business type: VAT in Bangladesh is one law (the VAT and SD Act 2012), not an
+// industry's choice. 15% is the standard rate and the default; the reduced rates are the ones the
+// NBR sets for some goods and services; zero-rated for exports, exempt for what the law leaves out.
+// A workspace archives the ones it never uses, and changes a rate when the NBR does.
+export const TAX_RATES: readonly TaxRateTemplate[] = [
+  { name: 'VAT 15%', kind: 'standard', rate: '15', isDefault: true },
+  { name: 'VAT 10%', kind: 'reduced', rate: '10', isDefault: false },
+  { name: 'VAT 7.5%', kind: 'reduced', rate: '7.5', isDefault: false },
+  { name: 'VAT 5%', kind: 'reduced', rate: '5', isDefault: false },
+  { name: 'Zero-rated', kind: 'zero_rated', rate: '0', isDefault: false },
+  { name: 'Exempt', kind: 'exempt', rate: '0', isDefault: false },
+];
+
 // Starting data for each business type: the roles such a company is staffed with, its chart of
 // accounts, and its units, product categories and custom fields (step 12; a pharma company's
 // products start with batch tracking — contracts' trackingDefault()). Everything here is ordinary
@@ -72,6 +94,12 @@ export interface IndustryTemplate {
   stockAccounts: Record<StockAccountUse, string>;
 }
 
+// Step 15a. The people who sell add and change customers; those who also collect the money see what
+// each customer owes. Price lists are the owner's and the accountant's (and a shop manager's): a
+// salesperson who could change the dealer price could give any discount.
+const SELLING = ['sales.customer.manage', 'sales.customer.balance'] as const;
+const SALES_ADMIN = [...SELLING, 'sales.price_list.manage'] as const;
+
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
 const ACCOUNTANT: RoleTemplate = {
@@ -89,6 +117,8 @@ const ACCOUNTANT: RoleTemplate = {
     // Step 14: what the stock is worth, and putting a wrong cost right
     'inventory.stock.value',
     'inventory.stock.revalue',
+    // Step 15a: the customers' accounts, their balances and statements, and the price lists
+    ...SALES_ADMIN,
   ],
 };
 
@@ -299,7 +329,8 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Merchandiser',
         description: 'Buyer POs, LCs and shipment dates',
-        permissions: ['core.user.read', 'inventory.product.manage'],
+        // The buyers are the merchandiser's customers
+        permissions: ['core.user.read', 'inventory.product.manage', 'sales.customer.manage'],
       },
       STORE_KEEPER,
     ],
@@ -361,7 +392,11 @@ export const INDUSTRY_TEMPLATES = {
           ...STOCK_WORK,
         ],
       },
-      { name: 'Sales representative', description: 'Orders from pharmacies', permissions: [] },
+      {
+        name: 'Sales representative',
+        description: 'Orders from pharmacies',
+        permissions: ['sales.customer.manage'],
+      },
     ],
     chart: standardChart({
       stock: group('1150', 'Inventories', [
@@ -429,7 +464,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Sales officer',
         description: 'Orders and collections from retailers',
-        permissions: [],
+        permissions: [...SELLING],
       },
     ],
     chart: standardChart({
@@ -521,6 +556,7 @@ export const INDUSTRY_TEMPLATES = {
           'inventory.product.manage',
           'inventory.warehouse.manage',
           ...STOCK_WORK,
+          ...SALES_ADMIN,
         ],
       },
       { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
@@ -566,6 +602,7 @@ export const INDUSTRY_TEMPLATES = {
           'inventory.product.manage',
           'inventory.warehouse.manage',
           ...STOCK_WORK,
+          ...SALES_ADMIN,
         ],
       },
     ],
```

- **`TAX_RATES` is one list, not one per industry.** Every other template differs by business type; VAT does
  not. It is one law for every company in Bangladesh. A per-industry copy would be six copies to keep the same.
- **`isDefault: true` on exactly one rate (15%).** The database allows at most one default; the API keeps at
  least one. The seed must start in that state, or the first product saved would have no rate to fall back on.
- **`rate: '7.5'`, not `'7.50'`.** It is written the way a person types it into the form. Postgres stores
  `7.50`; the string never becomes a JavaScript number on the way.
- **`SELLING` and `SALES_ADMIN`.** The roles a new workspace gets now include the step 15a permissions. A
  salesperson can add customers and see what they owe (they collect the money), but cannot change price lists: a
  person who can change the dealer price can give any discount. The cashier gets nothing new: reading customers
  needs no permission. As in every step, roles in existing workspaces are not changed; the owner ticks the new
  permissions in the matrix.

```ts
import { taxRates } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import { TAX_RATES } from './templates.js';

// Gives the transaction's tenant its starting VAT rates (step 15a) and returns how many it made —
// null when the workspace already has a rate. All or nothing on purpose: a workspace that has any
// rate has made its own choices (or a first run already made them), and adding the template's rates
// next to them would bring back a rate the owner archived on purpose, or a second default.
// The callers lock the tenant row first (like seedChart), so two runs never race.
export async function seedTaxRates(tx: Transaction, tenantId: string): Promise<number | null> {
  const [any] = await tx
    .select({ id: taxRates.id })
    .from(taxRates)
    .where(eq(taxRates.tenantId, tenantId))
    .limit(1);
  if (any) return null;
  await tx.insert(taxRates).values(TAX_RATES.map((rate) => ({ tenantId, ...rate })));
  return TAX_RATES.length;
}
```

- **"Any rate at all" means "done".** If the workspace has even one rate, nothing is added. A partial check
  ("add the ones that are missing") would bring back a rate the owner archived on purpose, or add a second
  default next to the owner's own.
- **The caller locks the tenant row first.** Both callers (the setup job and the handler below) take
  `FOR UPDATE` on `tenants`, as in steps 9–14. So if both run at the same time for one workspace, the second waits,
  then finds the rates and stops.
- **It returns `null` or a count**, so the caller can tell "made 6" from "nothing to do" and write the audit
  row only when something happened.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { seedTaxRates } from './seed-tax-rates.js';

// Gives the starting VAT rates (step 15a) to a workspace set up before step 15a. Migration 0026
// queues one 'workspace.tax_rates_requested' per such workspace; a new workspace gets them from the
// setup job. Both call seedTaxRates(), so the result is the same.
@Injectable()
export class TaxRatesHandler implements EventHandler<'workspace.tax_rates_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // The setup job's lock: if both run for one workspace, they take turns and the second stops
      const [tenant] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');
      const made = await seedTaxRates(tx, tenantId);
      // The workspace has rates already: a second run of this job, or the setup job was first
      if (made === null) return;
      await audit(tx, {
        action: 'tax_rates.created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ rates: made }),
      });
    });
  }
}
```

The handler for the event that migration 0026 queued for every workspace set up before this step. It follows
`StockAccountsHandler` from step 14 line by line. It does not need the business type (the rates are the same for
every industry), so it only selects the tenant's `id`, and only to lock the row. `PermanentJobError`: a workspace
that was deleted will not come back, so retrying is pointless.

```diff
@@ -12,6 +12,7 @@ import { notify } from '../notifications/notify.js';
 import { seedCatalog } from './seed-catalog.js';
 import { seedChart } from './seed-chart.js';
 import { seedStockAccounts } from './seed-stock-accounts.js';
+import { seedTaxRates } from './seed-tax-rates.js';
 import { INDUSTRY_TEMPLATES, type RoleTemplate } from './templates.js';
 
 type Event = OutboxEvent<'workspace.setup_requested'>;
@@ -96,6 +97,9 @@ export class ProvisioningHandler implements EventHandler<'workspace.setup_reques
       // null when step 12's migration already gave this workspace its catalog (a failed setup
       // retried after the catalog job ran)
       const catalog = await seedCatalog(tx, tenantId, template.catalog);
+      // Step 15a: null when step 15a's migration already gave this workspace its VAT rates (a failed
+      // setup retried after that job ran)
+      const rates = await seedTaxRates(tx, tenantId);
       await tx.update(tenants).set({ setupStatus: 'ready' }).where(eq(tenants.id, tenantId));
       // No actorUserId: the audit log shows "System" — the job did it, not a person
       await audit(tx, {
@@ -109,6 +113,7 @@ export class ProvisioningHandler implements EventHandler<'workspace.setup_reques
           units: catalog?.units ?? null,
           categories: catalog?.categories ?? null,
           customFields: catalog?.customFields ?? null,
+          taxRates: rates,
         }),
       });
       await notify(tx, {
```

A new workspace gets its rates from the setup job, in the same transaction as its chart and catalog. `null` means
the event above already ran (a failed setup that is retried later).

```diff
@@ -32,6 +32,8 @@ export const outboxPayloadSchemas = {
   }),
   // Like the chart's: the workspace and its business type say everything (step 14)
   'workspace.stock_accounts_requested': z.object({}),
+  // Like the chart's: the rates are the same for every workspace (step 15a)
+  'workspace.tax_rates_requested': z.object({}),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

```diff
@@ -23,6 +23,7 @@ const QUEUE_OF = {
   'product.import_requested': 'jobs',
   'stock.below_reorder': 'jobs',
   'workspace.stock_accounts_requested': 'jobs',
+  'workspace.tax_rates_requested': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

```diff
@@ -11,6 +11,7 @@ import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
+import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 
 // Which handler runs for which event — the one place to look. The mapped type ties each key to a
@@ -34,6 +35,7 @@ export class EventHandlers {
     productImport: ProductImportHandler,
     lowStock: LowStockHandler,
     stockAccounts: StockAccountsHandler,
+    taxRates: TaxRatesHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -46,6 +48,7 @@ export class EventHandlers {
       'product.import_requested': productImport,
       'stock.below_reorder': lowStock,
       'workspace.stock_accounts_requested': stockAccounts,
+      'workspace.tax_rates_requested': taxRates,
     };
   }
 
```

```diff
@@ -15,6 +15,7 @@ import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
+import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorageService } from '../storage/storage.service.js';
 import { EventHandlers } from './handlers.js';
@@ -62,6 +63,7 @@ export class WorkerModule implements OnApplicationShutdown {
         ProductImportHandler,
         LowStockHandler,
         StockAccountsHandler,
+        TaxRatesHandler,
       ],
     };
   }
```

These four files wire the new event, exactly like step 14's `workspace.stock_accounts_requested`. Each map is
checked with `satisfies Record<OutboxEventType, …>`, so the event type added in 15a.2 did not compile until all
four knew about it: a payload schema (empty: the event carries nothing), a queue, a handler, and the handler as a
provider.

### `tax/`: the VAT rates module

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { TaxRate, TaxRateInput, UpdateTaxRateInput } from '@omnivo/contracts';
import { taxRates } from '@omnivo/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type TaxRateRow = typeof taxRates.$inferSelect;

function toTaxRate(row: TaxRateRow): TaxRate {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    rate: row.rate,
    isDefault: row.isDefault,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: Pick<TaxRateRow, 'name' | 'kind' | 'rate' | 'isDefault'>) {
  return { name: row.name, kind: row.kind, rate: row.rate, isDefault: row.isDefault };
}

function nameTaken(): AppError {
  return new AppError(409, 'tax_rate_name_taken', 'Another VAT rate already has this name.', {
    fieldErrors: { name: ['tax_rate_name_taken'] },
  });
}

function defaultArchived(): AppError {
  return new AppError(
    409,
    'tax_rate_default_archived',
    'The default VAT rate cannot be archived. Make another rate the default first.',
    { fieldErrors: { isDefault: ['tax_rate_default_archived'] } },
  );
}

// The workspace's VAT rates (step 15a). Exactly one active rate is the default: the database
// allows at most one (tax_rates_tenant_default_idx), and this service makes sure there is always
// one — the default moves to another rate, it is never just switched off.
@Injectable()
export class TaxRatesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<TaxRate[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(taxRates)
        .where(eq(taxRates.tenantId, getTenantId()))
        // The default first, then the highest rate: the order of the pickers
        .orderBy(desc(taxRates.isDefault), desc(taxRates.rate), asc(taxRates.name));
      return rows.map(toTaxRate);
    });
  }

  async create(input: TaxRateInput): Promise<TaxRate> {
    try {
      return await this.withTenant(async (tx) => {
        await this.lockDefault(tx);
        const [current] = await tx
          .select({ id: taxRates.id })
          .from(taxRates)
          .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.isDefault, true)));
        // A workspace whose rates the worker has not made yet: its first rate is the default
        const isDefault = input.isDefault || !current;
        if (isDefault && current) await this.clearDefault(tx);
        const [row] = await tx
          .insert(taxRates)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            kind: input.kind,
            rate: input.rate,
            isDefault,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Tax rate insert returned no row');
        await audit(tx, {
          action: 'tax_rate.created',
          entityType: 'tax_rate',
          entityId: row.id,
          changes: created(snapshot(row)),
        });
        return toTaxRate(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tax_rates_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateTaxRateInput): Promise<TaxRate> {
    try {
      return await this.withTenant(async (tx) => {
        await this.lockDefault(tx);
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        if (before.isDefault && !input.isDefault) {
          // Which rate would products without their own rate use? The person picks it by making
          // that rate the default, which takes the flag off this one.
          throw new AppError(
            409,
            'tax_rate_default_needed',
            'Make another rate the default instead.',
            { fieldErrors: { isDefault: ['tax_rate_default_needed'] } },
          );
        }
        if (input.isDefault && before.archivedAt !== null) throw defaultArchived();
        if (input.isDefault && !before.isDefault) await this.clearDefault(tx);
        const after = await this.write(tx, id, {
          name: input.name,
          kind: input.kind,
          rate: input.rate,
          isDefault: input.isDefault,
        });
        await audit(tx, {
          action: 'tax_rate.updated',
          entityType: 'tax_rate',
          entityId: id,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return toTaxRate(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tax_rates_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // Archived: hidden from the pickers. Products that chose it keep it, and documents already
  // written keep their own copy of the rate (step 15b).
  setArchived(id: string, version: number, archived: boolean): Promise<TaxRate> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toTaxRate(before);
      if (archived && before.isDefault) throw defaultArchived();
      const after = await this.write(tx, id, { archivedAt: archived ? new Date() : null });
      await audit(tx, {
        action: archived ? 'tax_rate.archived' : 'tax_rate.restored',
        entityType: 'tax_rate',
        entityId: id,
      });
      return toTaxRate(after);
    });
  }

  // Two saves that both move the default would each clear the old one and set their own; the
  // unique index would then refuse the second with a database error. With this lock they take
  // turns, and the second one sees the first one's default. Per workspace, for this transaction.
  private async lockDefault(tx: Transaction): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tax_rates_default:${getTenantId()}`}, 0))`,
    );
  }

  // Before the new default is written: the partial unique index is checked on every row, so for
  // a moment two defaults would be refused, even inside one transaction
  private async clearDefault(tx: Transaction): Promise<void> {
    await tx
      .update(taxRates)
      .set({
        isDefault: false,
        version: sql`${taxRates.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.isDefault, true)));
  }

  private async lock(tx: Transaction, id: string): Promise<TaxRateRow> {
    const [row] = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.id, id)))
      .for('update');
    if (!row) throw notFound('VAT rate');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<TaxRateRow, 'name' | 'kind' | 'rate' | 'isDefault' | 'archivedAt'>>,
  ): Promise<TaxRateRow> {
    const [row] = await tx
      .update(taxRates)
      .set({
        ...fields,
        version: sql`${taxRates.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(taxRates.tenantId, getTenantId()), eq(taxRates.id, id)))
      .returning();
    if (!row) throw notFound('VAT rate');
    return row;
  }
}
```

- **One default, always.** The database's partial unique index stops two defaults. This service stops zero:
  - `update()` refuses to switch the default *off* (`tax_rate_default_needed`). To change the default, the person
    makes another rate the default; that clears this one.
  - `setArchived()` refuses to archive the default (`tax_rate_default_archived`). The check constraint
    `tax_rates_default_active` would refuse it too, but with a database error instead of a field error.
  - `create()` makes the first rate the default even if the form said no: a workspace whose worker job has not
    run yet would otherwise have rates and no default.
- **`clearDefault()` runs before the new default is written.** A unique index in Postgres is checked on every
  row as it is written, not at the end of the transaction. If the new default were set first, there would be
  two defaults for a moment, and the index would refuse it.
- **`lockDefault()` is an advisory lock per workspace.** Two people who make two different rates the default at
  the same moment would both clear the old default and set their own; the second one would then fail on the
  index with a raw database error. With the lock they take turns: the second one waits, then clears the first
  one's default and sets its own. The same lock pattern as the opening balances (step 10). The key includes the
  tenant id, so workspaces never wait for each other.
- **The name check is the unique index** (`tax_rates_tenant_name_idx`), caught outside `withTenant()`, after the
  rollback, and turned into `tax_rate_name_taken` on the `name` field. That is the pattern of every service
  since step 6.
- **Changing a rate is allowed, even when products use it.** When the NBR changes 7.5% to 10%, the workspace
  changes the rate once. Sales documents copy the rate onto each line (15b), so documents already written keep
  the old number.
- **The list puts the default first, then the highest rate.** That is the order every picker shows. Archived
  rates are in the list too (the settings page greys them out); the pickers filter them.

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { TaxRatesService } from './tax-rates.service.js';

type Routes = typeof routes.taxRates;

@Controller()
export class TaxRatesController {
  constructor(private readonly taxRates: TaxRatesService) {}

  @Endpoint(routes.taxRates.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.taxRates.list() };
  }

  @Endpoint(routes.taxRates.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.taxRates.create(body);
  }

  @Endpoint(routes.taxRates.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.taxRates.update(params.id, body);
  }

  @Endpoint(routes.taxRates.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.taxRates.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.taxRates.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.taxRates.setArchived(params.id, body.version, false);
  }
}
```

```ts
import { Module } from '@nestjs/common';

import { TaxRatesController } from './tax-rates.controller.js';
import { TaxRatesService } from './tax-rates.service.js';

// The workspace's VAT rates (step 15a). Their own module, not part of sales: purchases (step 17)
// charge the same rates, and the VAT return reads them. The starting rates are made by the setup
// job and TaxRatesHandler (setup/), like the chart of accounts.
@Module({
  controllers: [TaxRatesController],
  providers: [TaxRatesService],
})
export class TaxModule {}
```

Its own module and not part of sales: purchases (step 17) charge the same rates, and the VAT return reads them.

### `journal/posting.service.ts`: the party rule

```diff
@@ -1,11 +1,19 @@
 import { Injectable } from '@nestjs/common';
 import {
   type ErrorCode,
+  isPartyAccountPurpose,
   isStockJournalSource,
   type JournalSource,
   sumMoney,
 } from '@omnivo/contracts';
-import { branches, journalEntries, journalLines, ledgerAccounts, stockAccounts } from '@omnivo/db';
+import {
+  branches,
+  journalEntries,
+  journalLines,
+  ledgerAccounts,
+  parties,
+  stockAccounts,
+} from '@omnivo/db';
 import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
 
 import { AppError } from '../common/http/app-error.js';
@@ -21,6 +29,8 @@ export type EntryRow = typeof journalEntries.$inferSelect;
 export interface LineInput {
   accountId: string;
   branchId: string | null;
+  // Step 15a: the customer on a receivable line; null on every other line
+  partyId: string | null;
   description: string | null;
   debit: string;
   credit: string;
@@ -46,6 +56,70 @@ function lineErrors(code: ErrorCode, field: string, indexes: readonly number[]):
   });
 }
 
+type PartyCode = 'journal_party_required' | 'journal_party_not_allowed' | 'journal_party_invalid';
+
+// One line that breaks the party rule, by its index in the caller's list
+export interface PartyIssue {
+  index: number;
+  code: PartyCode;
+}
+
+// The party problems as the API's answer: each line's own code under lines.N.partyId, so the form
+// marks every wrong row at once
+export function partyError(issues: readonly PartyIssue[]): AppError {
+  const first = issues[0]?.code ?? 'journal_party_invalid';
+  return new AppError(409, first, 'Some lines have a wrong customer, or need one.', {
+    fieldErrors: Object.fromEntries(
+      issues.map((issue) => [`lines.${String(issue.index)}.partyId`, [issue.code]]),
+    ),
+  });
+}
+
+// The party rule (step 15a): a line on an account kept per party (the receivable) names a
+// customer, and no other line names anyone. Migration 0026 checks the same at posting, as a safety
+// net; here a person gets an answer per line instead of one database error.
+// purposeOf: each line's account → its purpose, from a query the caller already made.
+// allowMissing: the receivable line may have no customer yet — a draft (the person picks the
+// customer before posting), or a reversal of an entry posted before step 15a, which had none.
+// allowArchived: a reversal undoes old work, even for a customer archived since.
+// FOR SHARE on the parties, like the accounts: nobody archives one until we commit.
+export async function checkParties(
+  tx: Transaction,
+  lines: readonly { accountId: string; partyId: string | null }[],
+  purposeOf: ReadonlyMap<string, string | null>,
+  { allowMissing = false, allowArchived = false } = {},
+): Promise<PartyIssue[]> {
+  const partyIds = [
+    ...new Set(lines.flatMap((line) => (line.partyId === null ? [] : [line.partyId]))),
+  ];
+  const found =
+    partyIds.length === 0
+      ? []
+      : await tx
+          .select({ id: parties.id })
+          .from(parties)
+          .where(
+            and(
+              eq(parties.tenantId, getTenantId()),
+              inArray(parties.id, partyIds),
+              // Step 17 adds suppliers: a payable line will need is_supplier instead
+              eq(parties.isCustomer, true),
+              allowArchived ? undefined : isNull(parties.archivedAt),
+            ),
+          )
+          .for('share');
+  const usable = new Set(found.map((party) => party.id));
+  return lines.flatMap((line, index): PartyIssue[] => {
+    const perParty = isPartyAccountPurpose(purposeOf.get(line.accountId) ?? null);
+    if (line.partyId === null) {
+      return perParty && !allowMissing ? [{ index, code: 'journal_party_required' }] : [];
+    }
+    if (!perParty) return [{ index, code: 'journal_party_not_allowed' }];
+    // Unknown, archived, not a customer, another tenant's: one answer, like the accounts
+    return usable.has(line.partyId) ? [] : [{ index, code: 'journal_party_invalid' }];
+  });
+}
+
 // The accounts only stock documents post to (step 14): the inventory account and the goods in
 // transit account. A manual entry or an opening balance on them would make the books say one value
 // and the stock another, with nothing to bring them back together. Stock comes in through an
@@ -85,13 +159,15 @@ export class PostingService {
   // since — archiving hides an account from new work, it must not block fixing old work.
   // allowStock: the entry may post to the inventory and goods in transit accounts — a stock
   // document's entry, or a reversal or closing entry of old work. Every other entry may not.
+  // allowMissingParty: see checkParties() — a draft, or a reversal.
   async checkLines(
     tx: Transaction,
     lines: readonly LineInput[],
     {
       allowArchived = false,
       allowStock = false,
-    }: { allowArchived?: boolean; allowStock?: boolean } = {},
+      allowMissingParty = false,
+    }: { allowArchived?: boolean; allowStock?: boolean; allowMissingParty?: boolean } = {},
   ): Promise<void> {
     const tenantId = getTenantId();
     const accountIds = [...new Set(lines.map((line) => line.accountId))];
@@ -99,6 +175,7 @@ export class PostingService {
       .select({
         id: ledgerAccounts.id,
         isGroup: ledgerAccounts.isGroup,
+        purpose: ledgerAccounts.purpose,
         archivedAt: ledgerAccounts.archivedAt,
       })
       .from(ledgerAccounts)
@@ -119,6 +196,14 @@ export class PostingService {
       const onStock = lines.flatMap((line, index) => (stock.has(line.accountId) ? [index] : []));
       if (onStock.length > 0) throw lineErrors('journal_account_stock', 'accountId', onStock);
     }
+    // After the accounts: the rule depends on each line's account, which is valid by now
+    const partyIssues = await checkParties(
+      tx,
+      lines,
+      new Map(accounts.map((account) => [account.id, account.purpose])),
+      { allowMissing: allowMissingParty, allowArchived },
+    );
+    if (partyIssues.length > 0) throw partyError(partyIssues);
 
     const branchIds = [
       ...new Set(lines.flatMap((line) => (line.branchId === null ? [] : [line.branchId]))),
@@ -155,6 +240,7 @@ export class PostingService {
         lineNo: index + 1,
         accountId: line.accountId,
         branchId: line.branchId,
+        partyId: line.partyId,
         description: line.description,
         debit: line.debit,
         credit: line.credit,
@@ -217,6 +303,8 @@ export class PostingService {
         entry.source === 'reversal' ||
         entry.source === 'year_close' ||
         isStockJournalSource(entry.source),
+      // The same exception as migration 0026's: only a reversal, which copies its original's lines
+      allowMissingParty: entry.source === 'reversal',
     });
 
     // In the same transaction: if anything after this fails, the number goes back (step 6)
```

- **`partyId` is a required field of `LineInput`**, not an optional one. Every module that builds lines must
  now say "no party" (`null`) on purpose. An optional field would let step 15c's invoice forget the customer on
  its receivable line, and the mistake would only show up as a database error at posting.
- **`checkParties()` returns problems; it does not throw.** Two callers need it with different line numbers:
  `checkLines()` reports them for the entry's own lines, and the opening balances page (below) reports them
  for its own rows, which are not the posted lines. So the check gives back indexes, and each caller turns them
  into errors.
- **It needs each line's account purpose, from the caller.** `checkLines()` already reads the accounts (it now
  selects `purpose` too), and the opening balances read the whole chart. Passing the map in saves a second query.
- **The three answers**, each under `lines.N.partyId`:
  - `journal_party_required`: a receivable line without a customer.
  - `journal_party_not_allowed`: a customer on any other account (cash, sales).
  - `journal_party_invalid`: an id that is unknown, of another workspace, archived, or not a customer. One code
    for all four, like `journal_account_invalid`: the form shows one sentence, and nothing about another workspace
    leaks.
- **`eq(parties.isCustomer, true)`.** Step 17 adds suppliers: a payable line will need `is_supplier` instead.
- **`FOR SHARE` on the parties**, like the accounts above it: until this transaction commits, nobody can archive
  the customer (archiving takes `FOR UPDATE`), but other entries for the same customer go on in parallel.
- **`allowMissing`** is how the two exceptions get in:
  - **A draft** may have a receivable line without a customer yet (`JournalService` passes it on save). The
    person may save a half-written entry and pick the customer later. Posting it is when the rule applies.
  - **A reversal** (`post()` passes `allowMissingParty: entry.source === 'reversal'`). A reversal copies the lines
    of its original, and an entry posted before this step has a receivable line without a customer. This is the
    same exception as the database trigger in migration 0026, so the API and the database agree on every case.
- **The party check runs after the account checks.** It depends on each line's account being valid; with an
  unknown account it would report a wrong "not allowed" next to the real "invalid account".
- **`writeLines()` writes `partyId`**, so a reversal (which spreads its original's rows into new lines) copies the
  customer too. The reversal then comes off the same customer's balance.

### `journal/journal.service.ts`: the customer on each line

```diff
@@ -8,7 +8,7 @@ import {
   sumMoney,
   type UpdateJournalEntryInput,
 } from '@omnivo/contracts';
-import { journalEntries, journalLines } from '@omnivo/db';
+import { journalEntries, journalLines, parties } from '@omnivo/db';
 import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
 import { alias } from 'drizzle-orm/pg-core';
 import { z } from 'zod';
@@ -90,7 +90,9 @@ export class JournalService {
   async create(input: JournalEntryInput): Promise<JournalEntry> {
     if (input.post) await this.assertCanPost();
     return this.withTenant(async (tx) => {
-      await this.posting.checkLines(tx, input.lines);
+      // A draft may wait for its customer; posting it may not (PostingService.post). Saved and
+      // posted in one click, a missing customer is reported here, with every other wrong line.
+      await this.posting.checkLines(tx, input.lines, { allowMissingParty: !input.post });
       let row = await this.posting.insertDraft(
         tx,
         { date: input.date, narration: input.narration, source: 'manual' },
@@ -112,7 +114,7 @@ export class JournalService {
     return this.withTenant(async (tx) => {
       const before = await this.lockDraft(tx, id, input.version);
       const linesBefore = await this.linesOf(tx, id);
-      await this.posting.checkLines(tx, input.lines);
+      await this.posting.checkLines(tx, input.lines, { allowMissingParty: !input.post });
       const [updated] = await tx
         .update(journalEntries)
         .set({
@@ -211,7 +213,8 @@ export class JournalService {
           );
         }
 
-        // The same lines with debit and credit swapped: together the two entries add up to zero
+        // The same lines with debit and credit swapped: together the two entries add up to zero.
+        // Each line keeps its customer (step 15a), so the reversal comes off the same customer.
         const lines = await this.linesOf(tx, id);
         const reversed = await this.posting.postNew(tx, {
           date: input.date,
@@ -348,15 +351,31 @@ export class JournalService {
   }
 
   private async read(tx: Transaction, id: string): Promise<JournalEntry> {
+    const tenantId = getTenantId();
     const [summary] = await this.summaries(tx, eq(journalEntries.id, id), 1);
     if (!summary) throw notFound('Journal entry');
-    const lines = await this.linesOf(tx, id);
+    // The customer's code and name come with each line: the app cannot load every customer the
+    // way it loads the chart of accounts
+    const lines = await tx
+      .select({ line: journalLines, partyCode: parties.code, partyName: parties.name })
+      .from(journalLines)
+      .leftJoin(
+        parties,
+        and(eq(parties.tenantId, journalLines.tenantId), eq(parties.id, journalLines.partyId)),
+      )
+      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.entryId, id)))
+      .orderBy(asc(journalLines.lineNo));
     return {
       ...summary,
-      lines: lines.map((line) => ({
+      lines: lines.map(({ line, partyCode, partyName }) => ({
         id: line.id,
         accountId: line.accountId,
         branchId: line.branchId,
+        // The FK makes the join find the party whenever the line has one
+        party:
+          line.partyId !== null && partyCode !== null && partyName !== null
+            ? { id: line.partyId, code: partyCode, name: partyName }
+            : null,
         description: line.description,
         debit: line.debit,
         credit: line.credit,
```

- **`allowMissingParty: !input.post` on create and update**: the draft rule above. A draft may wait for its
  customer. But when the person saves and posts in one click, the first check already runs without the exception.
  Otherwise a line with a wrong customer and a line with no customer would come back in two rounds: first only the
  wrong one, and after the person fixed it, the missing one. The form must mark every wrong row at once. (`post()`
  still checks again, for the "Post" button on a saved draft.) The tests in 15a.4 found this.
- **`read()` joins `parties`.** The contract sends each line's customer as `{ id, code, name }`: the app cannot
  load every customer the way it loads the chart of accounts (a distributor has thousands), so the entry page
  needs the name from the server. `leftJoin`, because most lines have no party. The three-way `!== null` check
  narrows the joined columns: the foreign key guarantees the join finds the party whenever `partyId` is set, but
  TypeScript cannot know that.
- **The reversal needs no change.** It already spreads each original line (`{ ...line, debit: line.credit, … }`),
  and `line` is the full row, which now includes `partyId`.

### `journal/ledger.service.ts`: the ledger with customers, and a customer's statement

```ts
import { Inject, Injectable } from '@nestjs/common';
import { addMoney, type LedgerPage, subtractMoney } from '@omnivo/contracts';
import { journalEntries, journalLines, ledgerAccounts, parties } from '@omnivo/db';
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// A ledger row's position: its entry's date, then the line's id (UUIDv7, so the order lines were
// written in). Together they are unique and never change once posted — a stable page order.
const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// debit − credit of the matching posted lines. round(…, 4): "0.0000" when nothing matches.
function balanceWhere(condition: SQL | undefined): SQL<string> {
  const filter = condition ?? sql`true`;
  return sql<string>`round(coalesce(sum(${journalLines.debit} - ${journalLines.credit}) FILTER (WHERE ${filter}), 0), 4)`;
}

interface LedgerQuery {
  limit: number;
  cursor?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

@Injectable()
export class LedgerService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  ledger(accountId: string, query: LedgerQuery): Promise<LedgerPage> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [account] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.id, accountId)));
      if (!account) throw notFound('Account');
      return this.page(tx, eq(journalLines.accountId, accountId), query);
    });
  }

  // A customer's statement (step 15a): the same page as a ledger, over the lines of the receivable
  // that carry this customer. The account filter matters from step 17 on: a party that is also a
  // supplier has payable lines too, and those are not what the customer owes.
  statement(partyId: string, query: LedgerQuery): Promise<LedgerPage> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [party] = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(
          and(
            eq(parties.tenantId, tenantId),
            eq(parties.id, partyId),
            eq(parties.isCustomer, true),
          ),
        );
      if (!party) throw notFound('Customer');
      const receivable = tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.tenantId, tenantId),
            eq(ledgerAccounts.purpose, 'accounts_receivable'),
          ),
        );
      return this.page(
        tx,
        and(eq(journalLines.partyId, partyId), inArray(journalLines.accountId, receivable)),
        query,
      );
    });
  }

  // One page of posted lines that match `lines`, with the running balance and the opening and
  // closing balances around the dates asked for
  private async page(
    tx: Transaction,
    lines: SQL | undefined,
    query: LedgerQuery,
  ): Promise<LedgerPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    // Only posted lines. A draft is not in the books yet.
    const matching = and(
      eq(journalLines.tenantId, tenantId),
      lines,
      eq(journalEntries.status, 'posted'),
    );
    const joined = and(
      eq(journalEntries.tenantId, journalLines.tenantId),
      eq(journalEntries.id, journalLines.entryId),
    );
    const position = sql`(${journalEntries.date}, ${journalLines.id})`;
    const beforeFrom =
      query.from === undefined ? undefined : sql`${journalEntries.date} < ${query.from}::date`;

    const rows = await tx
      .select({
        lineId: journalLines.id,
        entryId: journalEntries.id,
        number: journalEntries.number,
        date: journalEntries.date,
        narration: journalEntries.narration,
        description: journalLines.description,
        partyId: journalLines.partyId,
        partyCode: parties.code,
        partyName: parties.name,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, joined)
      // Step 15a: whose line it is, on the receivable's ledger
      .leftJoin(
        parties,
        and(eq(parties.tenantId, journalLines.tenantId), eq(parties.id, journalLines.partyId)),
      )
      .where(
        and(
          matching,
          query.from === undefined ? undefined : sql`${journalEntries.date} >= ${query.from}::date`,
          query.to === undefined ? undefined : sql`${journalEntries.date} <= ${query.to}::date`,
          after === undefined
            ? undefined
            : sql`${position} > (${after[0]}::date, ${after[1]}::uuid)`,
        ),
      )
      .orderBy(asc(journalEntries.date), asc(journalLines.id))
      .limit(query.limit + 1);

    // Three balances in one pass over the matching lines:
    // - before this page: everything up to the cursor (or before `from` on the first page),
    //   so page 3's running balance continues exactly where page 2 stopped;
    // - opening: before `from`; closing: up to `to`.
    const [sums] = await tx
      .select({
        beforePage: balanceWhere(
          after === undefined
            ? (beforeFrom ?? sql`false`)
            : sql`${position} <= (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        opening: balanceWhere(beforeFrom ?? sql`false`),
        closing: balanceWhere(
          query.to === undefined ? undefined : sql`${journalEntries.date} <= ${query.to}::date`,
        ),
      })
      .from(journalLines)
      .innerJoin(journalEntries, joined)
      .where(matching);
    if (!sums) throw new Error('Ledger sums returned no row');

    const page = toPage(rows, query.limit, (last) => [last.date, last.lineId]);
    let balance = sums.beforePage;
    return {
      items: page.items.map(({ partyId, partyCode, partyName, ...row }) => {
        balance = addMoney(balance, subtractMoney(row.debit, row.credit));
        return {
          ...row,
          // Every line here is posted, so it has a number
          number: row.number ?? '',
          party:
            partyId !== null && partyCode !== null && partyName !== null
              ? { id: partyId, code: partyCode, name: partyName }
              : null,
          balance,
        };
      }),
      nextCursor: page.nextCursor,
      openingBalance: sums.opening,
      closingBalance: sums.closing,
    };
  }
}
```

Most of the old `ledger()` moved, unchanged, into a private `page()`. That is why the whole file is shown and not a
diff. `page()` takes the condition that picks the lines; everything else (posted only, the cursor, the three
balances) is the same for an account's ledger and for a customer's statement.

- **`ledger()`** passes "this account". Its rows now carry the customer: on the receivable's ledger, every line
  says whose it is (old lines show none).
- **`statement()`** passes "this customer, on the receivable". A customer's statement is exactly a ledger: an
  opening balance, the lines in date order with a running balance, a closing balance. One code path means the
  statement's running balance can never disagree with the ledger's.
- **The account filter (`inArray(journalLines.accountId, receivable)`)** looks unnecessary today: only receivable
  lines carry a party. From step 17 on, a party that is also a supplier has payable lines too, and those are not
  what the customer owes. The filter is a subquery inside the same SQL statement, not a separate round trip.
- **`eq(parties.isCustomer, true)` in the 404 check.** A supplier-only party (step 17) has no customer statement.
- **The route needs `sales.customer.balance`** (in the contract), so this method does not check permissions
  itself.
- **The index.** `journal_lines_tenant_party_idx` (15a.2) finds one customer's lines without reading the whole
  table, for the statement and for the balance in the customer list.

```diff
@@ -12,6 +12,7 @@ import { PostingService } from './posting.service.js';
 
 // The double-entry journal. PostingService is exported: every later module that posts (sales,
 // purchase, inventory) imports this module and calls postNew() in its own transaction.
+// LedgerService too (step 15a): a customer's statement is a ledger of the customer's lines.
 @Module({
   imports: [NumberingModule, RbacModule],
   controllers: [JournalController, BooksController],
@@ -22,6 +23,6 @@ import { PostingService } from './posting.service.js';
     PeriodLockService,
     PostingService,
   ],
-  exports: [PostingService],
+  exports: [PostingService, LedgerService],
 })
 export class JournalModule {}
```

`LedgerService` is exported, so the sales module can serve the statement with it.

### `journal/opening-balances.service.ts`: the receivable split by customer

```diff
@@ -9,7 +9,7 @@ import {
   subtractMoney,
   sumMoney,
 } from '@omnivo/contracts';
-import { journalEntries, journalLines, ledgerAccounts } from '@omnivo/db';
+import { journalEntries, journalLines, ledgerAccounts, parties } from '@omnivo/db';
 import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
 import { alias } from 'drizzle-orm/pg-core';
 
@@ -18,7 +18,13 @@ import { AppError, versionConflict } from '../common/http/app-error.js';
 import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
-import { type LineInput, PostingService, stockAccountIds } from './posting.service.js';
+import {
+  checkParties,
+  type LineInput,
+  partyError,
+  PostingService,
+  stockAccountIds,
+} from './posting.service.js';
 
 const reversal = alias(journalEntries, 'reversal');
 
@@ -27,7 +33,7 @@ const reversal = alias(journalEntries, 'reversal');
 const OPENING_TYPES = ['asset', 'liability', 'equity'] as const;
 
 function invalidLines(
-  code: 'opening_account_invalid' | 'opening_account_twice' | 'journal_account_stock',
+  code: 'opening_account_invalid' | 'journal_account_stock',
   indexes: number[],
 ) {
   return new AppError(409, code, 'Some lines cannot take an opening balance.', {
@@ -62,18 +68,10 @@ export class OpeningBalancesService {
       if ((current?.id ?? null) !== input.replaces) throw versionConflict();
 
       // Keep each line's index in the request, so an error lands under the right row of the page
+      // The same account (and customer) twice is refused by the contract (opening_balance_twice)
       const filled = input.lines.flatMap((line, index) =>
         isZeroMoney(line.debit) && isZeroMoney(line.credit) ? [] : [{ ...line, index }],
       );
-      const seen = new Set<string>();
-      const twice = filled.flatMap((line) => {
-        if (!seen.has(line.accountId)) {
-          seen.add(line.accountId);
-          return [];
-        }
-        return [line.index];
-      });
-      if (twice.length > 0) throw invalidLines('opening_account_twice', twice);
 
       const accounts = await tx
         .select({
@@ -106,6 +104,23 @@ export class OpeningBalancesService {
       const stock = await stockAccountIds(tx);
       const onStock = filled.flatMap((line) => (stock.has(line.accountId) ? [line.index] : []));
       if (onStock.length > 0) throw invalidLines('journal_account_stock', onStock);
+      // Step 15a: the receivable is split by customer, and only the receivable names one. Checked
+      // here and not only when the entry is posted below: the posted entry has no zero lines and an
+      // extra equity line, so its line numbers are not the page's rows.
+      const partyIssues = await checkParties(
+        tx,
+        filled,
+        new Map(accounts.map((account) => [account.id, account.purpose])),
+      );
+      if (partyIssues.length > 0) {
+        // An issue's index is its place in `filled`; the page needs the row it came from
+        throw partyError(
+          partyIssues.flatMap((issue) => {
+            const line = filled[issue.index];
+            return line ? [{ ...issue, index: line.index }] : [];
+          }),
+        );
+      }
 
       if (current) {
         const lines = await this.linesOf(tx, current.id);
@@ -123,6 +138,7 @@ export class OpeningBalancesService {
         const lines: LineInput[] = filled.map((line) => ({
           accountId: line.accountId,
           branchId: null,
+          partyId: line.partyId,
           description: null,
           debit: line.debit,
           credit: line.credit,
@@ -138,6 +154,7 @@ export class OpeningBalancesService {
           lines.push({
             accountId: equity.id,
             branchId: null,
+            partyId: null,
             description: null,
             debit: isNegativeMoney(difference) ? amount : '0',
             credit: isNegativeMoney(difference) ? '0' : amount,
@@ -159,7 +176,9 @@ export class OpeningBalancesService {
         entityId: tenantId,
         changes: created({
           goLiveDate: filled.length > 0 ? input.goLiveDate : null,
-          accounts: filled.length,
+          accounts: new Set(filled.map((line) => line.accountId)).size,
+          // How many customers' dues came in with it (step 15a)
+          customers: filled.filter((line) => line.partyId !== null).length,
           entry: number,
         }),
       });
@@ -213,14 +232,30 @@ export class OpeningBalancesService {
         ),
       );
     const equityIds = new Set(equity.map((account) => account.id));
-    const lines = await this.linesOf(tx, current.id);
+    const lines = await tx
+      .select({ line: journalLines, partyCode: parties.code, partyName: parties.name })
+      .from(journalLines)
+      .leftJoin(
+        parties,
+        and(eq(parties.tenantId, journalLines.tenantId), eq(parties.id, journalLines.partyId)),
+      )
+      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, current.id)))
+      .orderBy(asc(journalLines.lineNo));
     return {
       goLiveDate: shiftIsoDate(current.date, 1),
       entry: { id: current.id, number: current.number },
       // The equity line is the server's own; the page shows it as "the difference"
       lines: lines
-        .filter((line) => !equityIds.has(line.accountId))
-        .map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })),
+        .filter(({ line }) => !equityIds.has(line.accountId))
+        .map(({ line, partyCode, partyName }) => ({
+          accountId: line.accountId,
+          party:
+            line.partyId !== null && partyCode !== null && partyName !== null
+              ? { id: line.partyId, code: partyCode, name: partyName }
+              : null,
+          debit: line.debit,
+          credit: line.credit,
+        })),
     };
   }
 }
```

- **The duplicate check is gone from here.** The contract (15a.1) now refuses the same account and customer
  twice (`opening_balance_twice`), before the request reaches this service. The old check (by account only) would
  now be wrong: the receivable appears once per customer.
- **`checkParties()` with this page's own rows.** The posted entry is not the request: zero lines are dropped and
  the equity line is added. So the check runs on `filled` (the non-zero rows), and each problem is mapped back to
  `line.index`, the row number on the page. Without that mapping, the error would land under the wrong row.
  The `flatMap` (and not a `!` or a `?? -1`) is how TypeScript accepts that `filled[issue.index]` exists: it
  always does, but the type of an array read says it might not.
- **No `allowMissing`.** A receivable opening balance must name its customer; that is decision 4. An opening
  entry saved before this step had one receivable line without a customer: the page shows it like that, and saving
  it again unchanged answers `journal_party_required` under that row. The person splits it by customer, and the
  reversal of the old entry goes through (it is a reversal, so the missing customer is allowed).
- **`partyId: null` on the equity line.** Opening balance equity is never kept per party.
- **The audit row counts accounts and customers apart.** "12 accounts, 340 customers" says more than "352 lines".
- **5,000 lines in one insert is safe.** Postgres allows at most 65,535 parameters in one statement. A line
  sends 9 values, so 5,001 lines (with the equity line) are about 45,000 parameters. The contract's
  `MAX_OPENING_BALANCE_LINES` keeps it there.
- **`read()` joins `parties`**, for the same reason as the journal: the page shows the customer's code and name.

### The other places that build journal lines

```diff
@@ -209,6 +209,8 @@ export class StockBooksService {
         {
           accountId: first.accountId,
           branchId: first.branchId,
+          // No stock account is kept per party
+          partyId: null,
           description: null,
           debit: debit ? total : '0',
           credit: debit ? '0' : negateMoney(total),
```

```diff
@@ -83,6 +83,8 @@ function closingLines(
   const lines: LineInput[] = balances.map((item) => ({
     accountId: item.accountId,
     branchId: null,
+    // Only income and expense accounts are closed: none of them is kept per party
+    partyId: null,
     description: null,
     debit: isNegativeMoney(item.balance) ? absMoney(item.balance) : '0',
     credit: isNegativeMoney(item.balance) ? '0' : item.balance,
@@ -93,6 +95,7 @@ function closingLines(
     lines.push({
       accountId: retainedEarningsId,
       branchId: null,
+      partyId: null,
       description: null,
       debit: isNegativeMoney(profit) ? absMoney(profit) : '0',
       credit: isNegativeMoney(profit) ? '0' : profit,
@@ -227,6 +230,8 @@ export class FiscalYearsService {
           .map((line) => ({
             accountId: line.account_id,
             branchId: line.branch_id,
+            // A closing entry has no customer: it closes income and expense accounts only
+            partyId: null,
             description: line.description,
             debit: line.credit,
             credit: line.debit,
```

Because `partyId` is required in `LineInput`, the compiler listed every place that builds lines. A stock document
posts only to stock, cost and expense accounts, and a closing entry (and its reversal when a year is reopened)
only to income, expense and retained earnings accounts. None of them is the receivable, so each says `null`, with a
comment saying why.

### `sales/`: customers, customer groups, price lists

```ts
// A LIKE pattern for "contains", lower case. LIKE's own wildcards in what the person typed are
// meant literally: "10%" finds "10% off", and "_" is an underscore, not "any one character".
// Used by every searched list (products and stock in steps 12–13, customers and price lists in
// step 15a); the column it is compared with must be lower() too, which is what the trigram
// indexes are built on.
export function containsPattern(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
```

The product list (step 12) and the stock list (step 13) each had their own copy of this function, and the
customer list and the price list's items need it too. Four copies of a rule about escaping is three too many, so
it moves here, and the two old copies are removed:

```diff
@@ -23,6 +25,7 @@ import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
 import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
+import { containsPattern } from '../common/db/search.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
@@ -95,11 +98,6 @@ function isoText(column: SQL): SQL {
   return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
 }
 
-// LIKE's own wildcards in what the person typed are meant literally: "10%" finds "10% off"
-function containsPattern(search: string): string {
-  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
-}
-
 // What the audit log shows of a product: what a person would recognise, not ids
 interface Snapshot {
   [field: string]: string | number | null;
```

```diff
@@ -33,6 +33,7 @@ import { and, asc, eq, gt, isNotNull, isNull, type SQL, sql } from 'drizzle-orm'
 import { z } from 'zod';
 
 import { audit, diff } from '../common/audit/audit.js';
+import { containsPattern } from '../common/db/search.js';
 import { AppError, notFound } from '../common/http/app-error.js';
 import { decodeCursor, encodeCursor, toPage } from '../common/pagination/cursor.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
@@ -45,11 +46,6 @@ function quantityText(value: SQL): SQL<string> {
   return sql<string>`round(coalesce(${value}, 0), 4)::text`;
 }
 
-// LIKE's own wildcards in what the person typed are meant literally (as in the product list)
-function containsPattern(search: string): string {
-  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
-}
-
 const unitsSchema = z.array(z.object({ unitId: z.uuid(), factor: z.string() }));
 
 const itemRowSchema = z.object({
```

```ts
import { Injectable } from '@nestjs/common';

import { PermissionService } from '../rbac/permission.service.js';

// Who may see what customers owe (step 15a): sales.customer.balance. Reading customers needs no
// permission — every sales document picks one — so the list and the detail go to everyone, with
// the balance set to null for someone without it. Like ValueAccess for stock values (step 14).
@Injectable()
export class BalanceAccess {
  constructor(private readonly permissions: PermissionService) {}

  async canSee(): Promise<boolean> {
    const access = await this.permissions.ofCurrentUser();
    return access.permissions.includes('sales.customer.balance');
  }
}
```

Like step 14's `ValueAccess`. Reading customers needs no permission (every sales document picks one), so the
permission only decides whether the `balance` field is filled in.

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { CustomerGroup, CustomerGroupInput } from '@omnivo/contracts';
import { customerGroups, parties } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type GroupRow = typeof customerGroups.$inferSelect;

// Every customer in the group, archived ones too: they still hold the FK that stops a delete.
// The outer table by its name: Drizzle would print ${customerGroups.id} as a bare "id", which
// inside this subquery means the party's own id.
const customerCount = sql<number>`(
  SELECT count(*)::int FROM ${parties} p
   WHERE p.tenant_id = customer_groups.tenant_id AND p.customer_group_id = customer_groups.id
)`;

function toGroup(row: GroupRow, count: number): CustomerGroup {
  return {
    id: row.id,
    name: row.name,
    customerCount: count,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'customer_group_name_taken', 'Another group already has this name.', {
    fieldErrors: { name: ['customer_group_name_taken'] },
  });
}

// Dealer, Retailer, Corporate (step 15a). Deleted for real, and only while empty: a group is a
// label for filtering, with no history of its own worth keeping.
@Injectable()
export class CustomerGroupsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<CustomerGroup[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ group: customerGroups, customerCount })
        .from(customerGroups)
        .where(eq(customerGroups.tenantId, getTenantId()))
        .orderBy(asc(sql`lower(${customerGroups.name})`));
      return rows.map((row) => toGroup(row.group, row.customerCount));
    });
  }

  async create(input: CustomerGroupInput): Promise<CustomerGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(customerGroups)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Customer group insert returned no row');
        await audit(tx, {
          action: 'customer_group.created',
          entityType: 'customer_group',
          entityId: row.id,
          changes: created({ name: row.name }),
        });
        return toGroup(row, 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'customer_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(
    id: string,
    input: CustomerGroupInput & { version: number },
  ): Promise<CustomerGroup> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await tx
          .update(customerGroups)
          .set({
            name: input.name,
            version: sql`${customerGroups.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)));
        await audit(tx, {
          action: 'customer_group.updated',
          entityType: 'customer_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: input.name }),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'customer_groups_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(customerGroups)
          .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)));
        await audit(tx, {
          action: 'customer_group.deleted',
          entityType: 'customer_group',
          entityId: id,
          changes: diff({ name: before.name }, { name: null }),
        });
      });
    } catch (error) {
      // No count first: the FK is the check, and it cannot miss a customer saved a moment ago
      if (isForeignKeyViolation(error, 'parties_customer_group_fk')) {
        throw new AppError(
          409,
          'customer_group_in_use',
          'Customers are in this group. Move them to another group first.',
        );
      }
      throw error;
    }
  }

  private async lock(tx: Transaction, id: string): Promise<GroupRow> {
    const [row] = await tx
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)))
      .for('update');
    if (!row) throw notFound('Customer group');
    return row;
  }

  private async read(tx: Transaction, id: string): Promise<CustomerGroup> {
    const [row] = await tx
      .select({ group: customerGroups, customerCount })
      .from(customerGroups)
      .where(and(eq(customerGroups.tenantId, getTenantId()), eq(customerGroups.id, id)));
    if (!row) throw notFound('Customer group');
    return toGroup(row.group, row.customerCount);
  }
}
```

- **`customerCount` counts archived customers too.** They still hold the foreign key, so the delete would fail
  for them as well. The page uses the count to grey out the Delete button; it is not the check.
- **`customer_groups.id`, not `${customerGroups.id}`, inside the subquery.** This is the same trap as the stock
  documents' line count in step 14. When a select reads from one table, Drizzle prints the columns inside a `sql`
  snippet in the select list without the table name: `"id"`. Inside a subquery over `parties p`, a bare `"id"`
  means the party's own id, so the count would quietly be 0 for every group. No error, just a wrong number. Writing
  the outer table's name makes Postgres look at the outer row. The tests in 15a.4 found this.
- **The check is the foreign key** (`parties_customer_group_fk`). There is no "is it empty?" query first: a
  query and then a delete leave a gap in which another person can add a customer to the group. The foreign key
  cannot miss that customer.
- **Deleted, not archived.** A group is a label for filtering. It has no history of its own worth keeping.

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type Customer,
  type CustomerInput,
  type CustomerPage,
  type CustomerSort,
  type ErrorCode,
  todayIn,
  type UpdateCustomerInput,
} from '@omnivo/contracts';
import {
  customerGroups,
  journalEntries,
  journalLines,
  ledgerAccounts,
  parties,
  partyAddresses,
  priceLists,
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
import { BalanceAccess } from './balance-access.js';

type PartyRow = typeof parties.$inferSelect;

// What a customer owes: debit − credit of the posted receivable lines that name it. A correlated
// subquery on the parties row it is selected with, run for the rows of one page only;
// journal_lines_tenant_party_idx finds the lines. Drafts are left out: they are not in the books.
// The account filter keeps a supplier's payable lines out from step 17 on.
// The outer table by its name, like the stock documents' line count (step 14): in a select from
// one table, Drizzle prints ${parties.id} as a bare "id", which here is ambiguous.
const balance = sql<string>`(
  SELECT round(coalesce(sum(l.debit - l.credit), 0), 4)::text
    FROM ${journalLines} l
    JOIN ${journalEntries} e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
    JOIN ${ledgerAccounts} a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
   WHERE l.tenant_id = parties.tenant_id AND l.party_id = parties.id
     AND e.status = 'posted' AND a.purpose = 'accounts_receivable'
)`;

// The list's orders: one key and then the id, so a cursor says exactly where the next page starts.
// Each has an index: parties_customer_name_idx, parties_tenant_code_idx, parties_customer_updated_idx.
const ORDERS = {
  name: { key: sql`lower(${parties.name})`, desc: false },
  '-name': { key: sql`lower(${parties.name})`, desc: true },
  code: { key: sql`lower(${parties.code})`, desc: false },
  '-code': { key: sql`lower(${parties.code})`, desc: true },
  '-updated': { key: sql`${parties.updatedAt}`, desc: true },
} satisfies Record<CustomerSort, { key: SQL; desc: boolean }>;

// The sort key as text: updated_at::text keeps the microseconds, which a JavaScript Date would
// round away (a cursor a few microseconds off skips or repeats a row)
const cursorSchema = z.tuple([z.string(), z.uuid()]);

// What the audit log shows of a customer: what a person would recognise, not ids
interface Snapshot {
  [field: string]: string | number | null;
  code: string;
  name: string;
  group: string | null;
  phone: string | null;
  bin: string | null;
  paymentTermsDays: number;
  creditLimit: string | null;
  priceList: string | null;
  addresses: number;
}

function codeTaken(): AppError {
  return new AppError(409, 'customer_code_taken', 'Another customer uses this code.', {
    fieldErrors: { code: ['customer_code_taken'] },
  });
}

function fieldError(code: ErrorCode, field: string): AppError {
  return new AppError(400, code, 'Check the highlighted fields and try again.', {
    fieldErrors: { [field]: [code] },
  });
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly access: BalanceAccess,
  ) {}

  async list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    groupId?: string | undefined;
    status: 'active' | 'archived';
    sort: CustomerSort;
  }): Promise<CustomerPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const order = ORDERS[query.sort];
    const canSeeBalance = await this.access.canSee();
    const conditions: (SQL | undefined)[] = [
      eq(parties.tenantId, tenantId),
      eq(parties.isCustomer, true),
      query.status === 'active'
        ? isNull(parties.archivedAt)
        : sql`${parties.archivedAt} IS NOT NULL`,
      query.groupId === undefined ? undefined : eq(parties.customerGroupId, query.groupId),
    ];
    if (query.search !== undefined && query.search !== '') {
      const pattern = containsPattern(query.search);
      // The four trigram indexes of migration 0026. The phone is matched as typed: digits have no
      // case, and "1711" finds 01711-234567.
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
          // Not even worked out without the permission: it is not just hidden, it is not read
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
          groupId: row.party.customerGroupId,
          contactPerson: row.party.contactPerson,
          phone: row.party.phone,
          paymentTermsDays: row.party.paymentTermsDays,
          creditLimit: row.party.creditLimit,
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

  async get(id: string): Promise<Customer> {
    const canSeeBalance = await this.access.canSee();
    return this.withTenant((tx) => this.read(tx, id, canSeeBalance));
  }

  async create(input: CustomerInput): Promise<Customer> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        await this.checkLinks(tx, input, null);
        const code = input.code ?? (await this.newCode(tx));
        if (await this.codeUsed(tx, code, null)) throw codeTaken();
        const [row] = await tx
          .insert(parties)
          .values({
            tenantId: getTenantId(),
            code,
            isCustomer: true,
            ...this.fields(input),
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning({ id: parties.id });
        if (!row) throw new Error('Customer insert returned no row');
        await this.saveAddresses(tx, row.id, input.addresses);
        const customer = await this.read(tx, row.id, canSeeBalance);
        await audit(tx, {
          action: 'customer.created',
          entityType: 'customer',
          entityId: row.id,
          changes: created(await this.snapshot(tx, customer)),
        });
        return customer;
      });
    } catch (error) {
      // Two saves with the same code at the same moment: both passed codeUsed()
      if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateCustomerInput): Promise<Customer> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await this.checkLinks(tx, input, before);
        const old = await this.read(tx, id, canSeeBalance);
        // An empty code keeps the one it has, like a product's
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
        await this.saveAddresses(tx, id, input.addresses);
        const customer = await this.read(tx, id, canSeeBalance);
        await audit(tx, {
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, customer)),
        });
        return customer;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  // Archived: hidden from new documents. Its entries, its balance and its statement stay; a
  // customer who still owes money can be archived, and the money is still owed.
  async setArchived(id: string, version: number, archived: boolean): Promise<Customer> {
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
          action: archived ? 'customer.archived' : 'customer.restored',
          entityType: 'customer',
          entityId: id,
        });
      }
      return this.read(tx, id, canSeeBalance);
    });
  }

  // Only a customer nothing uses yet: one added by mistake. Step 17 will keep a party that is also
  // a supplier, as a supplier.
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        // Its addresses go with it (ON DELETE CASCADE)
        await tx
          .delete(parties)
          .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
        await audit(tx, {
          action: 'customer.deleted',
          entityType: 'customer',
          entityId: id,
          changes: diff({ code: before.code, name: before.name }, { code: null, name: null }),
        });
      });
    } catch (error) {
      // No "is it used?" query first: the FK is the check. Step 15b adds the sales documents' FKs.
      if (isForeignKeyViolation(error, 'journal_lines_party_fk')) {
        throw new AppError(
          409,
          'customer_in_use',
          'This customer has entries. Archive it instead.',
        );
      }
      throw error;
    }
  }

  // The columns the form sets, the same on create and update
  private fields(input: CustomerInput) {
    return {
      name: input.name,
      customerGroupId: input.groupId,
      contactPerson: input.contactPerson,
      phone: input.phone,
      email: input.email,
      bin: input.bin,
      paymentTermsDays: input.paymentTermsDays,
      creditLimit: input.creditLimit,
      priceListId: input.priceListId,
      notes: input.notes,
    };
  }

  // The group must exist; the price list must exist and be in use. A customer whose list was
  // archived since keeps it on a save (like a product's archived unit): its prices fall back to
  // the products' own until the list is restored (step 15b).
  private async checkLinks(tx: Transaction, input: CustomerInput, before: PartyRow | null) {
    const tenantId = getTenantId();
    if (input.groupId !== null) {
      const [group] = await tx
        .select({ id: customerGroups.id })
        .from(customerGroups)
        .where(and(eq(customerGroups.tenantId, tenantId), eq(customerGroups.id, input.groupId)))
        // A group being deleted right now waits for us, or we wait for it and find it gone
        .for('share');
      if (!group) throw fieldError('customer_group_invalid', 'groupId');
    }
    if (input.priceListId !== null) {
      const [list] = await tx
        .select({ archivedAt: priceLists.archivedAt })
        .from(priceLists)
        .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, input.priceListId)));
      const kept = before?.priceListId === input.priceListId;
      if (!list || (list.archivedAt !== null && !kept)) {
        throw fieldError('price_list_invalid', 'priceListId');
      }
    }
  }

  // Any party's code counts (a supplier's too, from step 17): one code is one party
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

  // The next free code from the 'sales.customer' series (C-00042). A number someone already typed
  // by hand is skipped, not refused — like product codes.
  private async newCode(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');
    for (;;) {
      const code = await this.numbering.next(tx, 'sales.customer', today);
      if (!(await this.codeUsed(tx, code, null))) return code;
    }
  }

  // The addresses sent replace the ones the customer had. An address sent back with its id is
  // changed in place, so its id stays (a delivery in step 15b points at it); one whose id is not
  // this customer's — another customer's, or made up — is added as a new address, never moved.
  // The order matters because of party_addresses_billing_idx, checked on every row: first the
  // removed ones go, then the kept ones that are no longer billing are changed, then the one that
  // is billing now, and last the new ones. At no moment are there two billing addresses.
  private async saveAddresses(
    tx: Transaction,
    partyId: string,
    addresses: CustomerInput['addresses'],
  ): Promise<void> {
    const tenantId = getTenantId();
    const ofParty = and(eq(partyAddresses.tenantId, tenantId), eq(partyAddresses.partyId, partyId));
    const existing = await tx.select({ id: partyAddresses.id }).from(partyAddresses).where(ofParty);
    const own = new Set(existing.map((row) => row.id));
    const rows = addresses.map((address, position) => ({
      id: address.id !== null && own.has(address.id) ? address.id : null,
      fields: {
        kind: address.kind,
        position,
        label: address.label,
        address: address.address,
        phone: address.phone,
      },
    }));
    const kept = rows.flatMap(({ id, fields }) => (id === null ? [] : [{ id, fields }]));
    await tx.delete(partyAddresses).where(
      kept.length === 0
        ? ofParty
        : and(
            ofParty,
            notInArray(
              partyAddresses.id,
              kept.map((row) => row.id),
            ),
          ),
    );
    const billingLast = [
      ...kept.filter((row) => row.fields.kind !== 'billing'),
      ...kept.filter((row) => row.fields.kind === 'billing'),
    ];
    for (const row of billingLast) {
      await tx
        .update(partyAddresses)
        .set(row.fields)
        .where(and(ofParty, eq(partyAddresses.id, row.id)));
    }
    const added = rows.flatMap(({ id, fields }) => (id === null ? [fields] : []));
    if (added.length > 0) {
      await tx
        .insert(partyAddresses)
        .values(added.map((fields) => ({ tenantId, partyId, ...fields })));
    }
  }

  private async lock(tx: Transaction, id: string): Promise<PartyRow> {
    const [row] = await tx
      .select()
      .from(parties)
      .where(
        and(eq(parties.tenantId, getTenantId()), eq(parties.id, id), eq(parties.isCustomer, true)),
      )
      .for('update');
    if (!row) throw notFound('Customer');
    return row;
  }

  private async read(tx: Transaction, id: string, canSeeBalance: boolean): Promise<Customer> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select({ party: parties, balance: canSeeBalance ? balance : sql<null>`NULL` })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, id), eq(parties.isCustomer, true)));
    if (!row) throw notFound('Customer');
    const { party } = row;
    const addresses = await tx
      .select()
      .from(partyAddresses)
      .where(and(eq(partyAddresses.tenantId, tenantId), eq(partyAddresses.partyId, id)))
      // The billing address first, then the shipping ones in the order the person put them
      .orderBy(sql`${partyAddresses.kind} = 'billing' DESC`, asc(partyAddresses.position));
    return {
      id: party.id,
      code: party.code,
      name: party.name,
      groupId: party.customerGroupId,
      contactPerson: party.contactPerson,
      phone: party.phone,
      email: party.email,
      bin: party.bin,
      paymentTermsDays: party.paymentTermsDays,
      creditLimit: party.creditLimit,
      priceListId: party.priceListId,
      notes: party.notes,
      addresses: addresses.map((address) => ({
        id: address.id,
        kind: address.kind,
        label: address.label,
        address: address.address,
        phone: address.phone,
      })),
      isSupplier: party.isSupplier,
      balance: row.balance,
      archivedAt: party.archivedAt?.toISOString() ?? null,
      version: party.version,
      updatedAt: party.updatedAt.toISOString(),
    };
  }

  private async snapshot(tx: Transaction, customer: Customer): Promise<Snapshot> {
    const tenantId = getTenantId();
    const [[group], [list]] = await Promise.all([
      customer.groupId === null
        ? [undefined]
        : tx
            .select({ name: customerGroups.name })
            .from(customerGroups)
            .where(
              and(eq(customerGroups.tenantId, tenantId), eq(customerGroups.id, customer.groupId)),
            ),
      customer.priceListId === null
        ? [undefined]
        : tx
            .select({ name: priceLists.name })
            .from(priceLists)
            .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, customer.priceListId))),
    ]);
    return {
      code: customer.code,
      name: customer.name,
      group: group?.name ?? null,
      phone: customer.phone,
      bin: customer.bin,
      paymentTermsDays: customer.paymentTermsDays,
      creditLimit: customer.creditLimit,
      priceList: list?.name ?? null,
      addresses: customer.addresses.length,
    };
  }
}
```

- **`balance` is a correlated subquery.** It runs once per row of the page (50 at most), on the receivable lines
  of that one customer, found by the partial index. It joins `journal_entries` to leave drafts out, and
  `ledger_accounts` to keep only the receivable (from step 17, a party's payable lines must not count). It sums
  in SQL and sends text, so the amount never passes through a JavaScript number. It names the outer row as
  `parties.tenant_id` and `parties.id`, for the reason given under `customer-groups.service.ts` above. Here the
  bare names would not even be wrong quietly: `"id"` and `"tenant_id"` exist in all three tables of the subquery,
  so Postgres refuses the query as ambiguous (error 42702), and every customer read would answer 500.
- **`canSeeBalance ? balance : sql\`NULL\``.** Without the permission, the balance is not even computed: no work
  is done for a number nobody may see, and nothing can leak it by mistake.
- **The list is keyset-paged, like products.** Each sort is one key plus the id, so the order is total, and each
  key has an index from 15a.2 (`parties_customer_name_idx`, `parties_tenant_code_idx`,
  `parties_customer_updated_idx`). The cursor holds the key as text: `updated_at::text` keeps the microseconds
  that a JavaScript `Date` would cut off. A cursor a few microseconds off would skip or repeat a row.
- **The search uses the trigram indexes of migration 0026.** `lower(name) LIKE '%…%'` can use a trigram GIN
  index; a plain B-tree index cannot help a "contains" search. The phone is compared as typed: digits have no case.
- **`eq(parties.isCustomer, true)` on every query.** The `parties` table will hold suppliers too (step 17). A
  supplier's id sent to `/customers/:id` gets 404, not the supplier.
- **The code.** An empty code takes the next number of the `sales.customer` series (`C-00042`, 15a.1). A number
  someone already typed by hand is skipped, the same way as product codes. `codeUsed()` checks any party, not
  only customers: one code means one business. Two saves of the same code at the same moment both pass the check;
  the unique index refuses the second, and the `catch` gives the same `customer_code_taken`.
- **`checkLinks()`.** The group must exist, and the price list must exist and not be archived. One exception: a
  customer whose list was archived since keeps it when saved, like a product keeps an archived unit. Otherwise
  editing a phone number would force the person to change the price list too. The group is read `FOR SHARE`, so
  a group being deleted at the same moment either waits for this save or is gone before it.
- **`saveAddresses()`**, the one tricky part:
  - An address sent back with its id is updated in place. Its id stays, because a delivery (15b) will point at it.
  - An id that is not one of this customer's addresses is treated as a new address. It is never "moved" from
    another customer, which would change that customer's delivery history.
  - **The order of the writes.** `party_addresses_billing_idx` allows one billing address per customer, and like
    every unique index it is checked row by row. When the person swaps which address is the billing one, the
    old billing address must stop being billing before the new one starts. So: delete the removed addresses,
    update the kept ones that are not billing, then update the one that is billing, then insert the new ones. At
    no moment are there two billing addresses.
  - `position` is the address's place in the form. The billing address is read first anyway (`kind = 'billing'
    DESC`), then the shipping addresses in the person's order; the first shipping address is the default on a
    delivery (15b).
- **`remove()`** deletes only a customer that nothing uses. The foreign key from `journal_lines` is the check,
  turned into `customer_in_use`; step 15b adds the foreign keys of its documents to the same `catch`. The
  addresses go with the customer (`ON DELETE CASCADE`).
- **Archiving keeps the balance.** A customer who still owes money can be archived: they stop appearing in the
  pickers, and the money is still owed and still on their statement.
- **The audit snapshot** shows names (the group's, the price list's) and a count of addresses, not ids: what a
  person reading the log recognises.

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  ErrorCode,
  PriceList,
  PriceListInput,
  PriceListItemPage,
  SetPriceListItemsInput,
  UpdatePriceListInput,
} from '@omnivo/contracts';
import {
  parties,
  priceListItems,
  priceLists,
  products,
  productUnits,
  productVariants,
} from '@omnivo/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { containsPattern } from '../common/db/search.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type PriceListRow = typeof priceLists.$inferSelect;

// The two counts the page shows next to a list. Correlated subqueries: a workspace has a few lists.
// The outer table by its name: Drizzle would print ${priceLists.id} as a bare "id", which inside
// the subquery means the inner row's own column.
const itemCount = sql<number>`(
  SELECT count(*)::int FROM ${priceListItems} i
   WHERE i.tenant_id = price_lists.tenant_id AND i.price_list_id = price_lists.id
)`;
// Archived customers too: they still point at the list
const customerCount = sql<number>`(
  SELECT count(*)::int FROM ${parties} p
   WHERE p.tenant_id = price_lists.tenant_id AND p.price_list_id = price_lists.id
)`;

// A row's place in the items page: the product's name, then the variant and the unit. The last
// two make it unique (they are the row's key inside one list).
const cursorSchema = z.tuple([z.string(), z.uuid(), z.uuid()]);

function toPriceList(row: PriceListRow, counts: { itemCount: number; customerCount: number }) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    itemCount: counts.itemCount,
    customerCount: counts.customerCount,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  } satisfies PriceList;
}

function nameTaken(): AppError {
  return new AppError(409, 'price_list_name_taken', 'Another price list already has this name.', {
    fieldErrors: { name: ['price_list_name_taken'] },
  });
}

// Named price lists (step 15a): "Dealer", "Wholesale". Archived, never deleted — a sales line
// (step 15b) remembers the list its price came from.
@Injectable()
export class PriceListsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<PriceList[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ list: priceLists, itemCount, customerCount })
        .from(priceLists)
        .where(eq(priceLists.tenantId, getTenantId()))
        .orderBy(asc(sql`lower(${priceLists.name})`));
      return rows.map((row) => toPriceList(row.list, row));
    });
  }

  get(id: string): Promise<PriceList> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: PriceListInput): Promise<PriceList> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(priceLists)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            description: input.description,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Price list insert returned no row');
        await audit(tx, {
          action: 'price_list.created',
          entityType: 'price_list',
          entityId: row.id,
          changes: created({ name: row.name, description: row.description }),
        });
        return toPriceList(row, { itemCount: 0, customerCount: 0 });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'price_lists_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdatePriceListInput): Promise<PriceList> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await this.write(tx, id, { name: input.name, description: input.description });
        await audit(tx, {
          action: 'price_list.updated',
          entityType: 'price_list',
          entityId: id,
          changes: diff(
            { name: before.name, description: before.description },
            { name: input.name, description: input.description },
          ),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'price_lists_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // Archived: no new customer picks it, and its customers' sales lines (step 15b) fall back to the
  // products' own prices. Its prices stay, so restoring it brings everything back.
  setArchived(id: string, version: number, archived: boolean): Promise<PriceList> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) !== archived) {
        await this.write(tx, id, { archivedAt: archived ? new Date() : null });
        await audit(tx, {
          action: archived ? 'price_list.archived' : 'price_list.restored',
          entityType: 'price_list',
          entityId: id,
        });
      }
      return this.read(tx, id);
    });
  }

  items(
    id: string,
    query: { limit: number; cursor?: string | undefined; search?: string | undefined },
  ): Promise<PriceListItemPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const nameKey = sql<string>`lower(${products.name})`;
    return this.withTenant(async (tx) => {
      const [list] = await tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, id)));
      if (!list) throw notFound('Price list');
      const search =
        query.search === undefined || query.search === ''
          ? undefined
          : containsPattern(query.search);
      const rows = await tx
        .select({
          variantId: priceListItems.variantId,
          unitId: priceListItems.unitId,
          productId: priceListItems.productId,
          productCode: products.code,
          productName: products.name,
          nameKey,
          sku: productVariants.sku,
          optionValues: productVariants.optionValues,
          price: priceListItems.price,
          updatedAt: priceListItems.updatedAt,
        })
        .from(priceListItems)
        .innerJoin(
          products,
          and(
            eq(products.tenantId, priceListItems.tenantId),
            eq(products.id, priceListItems.productId),
          ),
        )
        .innerJoin(
          productVariants,
          and(
            eq(productVariants.tenantId, priceListItems.tenantId),
            eq(productVariants.id, priceListItems.variantId),
          ),
        )
        .where(
          and(
            eq(priceListItems.tenantId, tenantId),
            eq(priceListItems.priceListId, id),
            search === undefined
              ? undefined
              : sql`(lower(${products.name}) LIKE ${search} OR lower(${products.code}) LIKE ${search}
                     OR lower(${productVariants.sku}) LIKE ${search})`,
            after === undefined
              ? undefined
              : sql`(${nameKey}, ${priceListItems.variantId}, ${priceListItems.unitId})
                      > (${after[0]}, ${after[1]}::uuid, ${after[2]}::uuid)`,
          ),
        )
        .orderBy(nameKey, asc(priceListItems.variantId), asc(priceListItems.unitId))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.nameKey, last.variantId, last.unitId]);
      return {
        items: page.items.map((row) => ({
          variantId: row.variantId,
          unitId: row.unitId,
          productId: row.productId,
          productCode: row.productCode,
          productName: row.productName,
          sku: row.sku,
          optionValues: row.optionValues,
          price: row.price,
          updatedAt: row.updatedAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // A batch of prices: each change sets one price, or ('' → null) takes it out of the list. Every
  // row is saved on its own — no version — so two people can price different items of one list at
  // the same time. The batch is all or nothing: one wrong unit and nothing is saved.
  setItems(id: string, input: SetPriceListItemsInput): Promise<PriceList> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // FOR SHARE: the list is not archived while we write into it
      const [list] = await tx
        .select({ archivedAt: priceLists.archivedAt })
        .from(priceLists)
        .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, id)))
        .for('share');
      if (!list) throw notFound('Price list');
      if (list.archivedAt !== null) {
        throw new AppError(
          409,
          'price_list_invalid',
          'Restore the price list to change its prices.',
        );
      }

      // Each variant with its product and the units it is sold in: the base unit and its packs.
      // FOR SHARE on the products: a product save that drops a pack (and deletes its prices, in
      // ProductsService.update) waits for us, or we wait for it and see the pack gone.
      const variantIds = [...new Set(input.changes.map((change) => change.variantId))];
      const variants = await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          baseUnitId: products.baseUnitId,
        })
        .from(productVariants)
        .innerJoin(
          products,
          and(
            eq(products.tenantId, productVariants.tenantId),
            eq(products.id, productVariants.productId),
          ),
        )
        .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.id, variantIds)))
        .for('share', { of: products });
      const productIds = [...new Set(variants.map((variant) => variant.productId))];
      const packs =
        productIds.length === 0
          ? []
          : await tx
              .select({ productId: productUnits.productId, unitId: productUnits.unitId })
              .from(productUnits)
              .where(
                and(
                  eq(productUnits.tenantId, tenantId),
                  inArray(productUnits.productId, productIds),
                ),
              );
      const variantOf = new Map(variants.map((variant) => [variant.id, variant]));
      const sold = new Set([
        ...variants.map((variant) => `${variant.productId}:${variant.baseUnitId}`),
        ...packs.map((pack) => `${pack.productId}:${pack.unitId}`),
      ]);

      const fieldErrors: Record<string, ErrorCode[]> = {};
      const rows = input.changes.flatMap((change, index) => {
        const variant = variantOf.get(change.variantId);
        if (!variant) {
          fieldErrors[`changes.${String(index)}.variantId`] = ['product_variant_unknown'];
          return [];
        }
        // A price per carton of a product that is never sold by the carton could never be used
        if (!sold.has(`${variant.productId}:${change.unitId}`)) {
          fieldErrors[`changes.${String(index)}.unitId`] = ['price_list_unit_invalid'];
          return [];
        }
        return [{ ...change, productId: variant.productId }];
      });
      const [first] = Object.values(fieldErrors).flat();
      if (first !== undefined) {
        throw new AppError(
          409,
          first,
          'Some prices are for an item or unit this list cannot hold.',
          {
            fieldErrors,
          },
        );
      }

      const removed = rows.filter((row) => row.price === null);
      if (removed.length > 0) {
        await tx.delete(priceListItems).where(
          and(
            eq(priceListItems.tenantId, tenantId),
            eq(priceListItems.priceListId, id),
            sql`(${priceListItems.variantId}, ${priceListItems.unitId}) IN (${sql.join(
              removed.map((row) => sql`(${row.variantId}::uuid, ${row.unitId}::uuid)`),
              sql`, `,
            )})`,
          ),
        );
      }
      const set = rows.flatMap((row) => (row.price === null ? [] : [{ ...row, price: row.price }]));
      if (set.length > 0) {
        await tx
          .insert(priceListItems)
          .values(
            set.map((row) => ({
              tenantId,
              priceListId: id,
              productId: row.productId,
              variantId: row.variantId,
              unitId: row.unitId,
              price: row.price,
              updatedBy: currentPrincipal().userId,
            })),
          )
          // The key is the row: setting a price that is already there changes it
          .onConflictDoUpdate({
            target: [
              priceListItems.tenantId,
              priceListItems.priceListId,
              priceListItems.variantId,
              priceListItems.unitId,
            ],
            set: {
              price: sql`excluded.price`,
              updatedAt: sql`now()`,
              updatedBy: sql`excluded.updated_by`,
            },
          });
      }
      // How many, not which: a batch can hold 500 prices, and the audit row is for people
      await audit(tx, {
        action: 'price_list.prices_changed',
        entityType: 'price_list',
        entityId: id,
        changes: created({ set: set.length, removed: removed.length }),
      });
      return this.read(tx, id);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<PriceListRow> {
    const [row] = await tx
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, getTenantId()), eq(priceLists.id, id)))
      .for('update');
    if (!row) throw notFound('Price list');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<PriceListRow, 'name' | 'description' | 'archivedAt'>>,
  ): Promise<void> {
    await tx
      .update(priceLists)
      .set({
        ...fields,
        version: sql`${priceLists.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(priceLists.tenantId, getTenantId()), eq(priceLists.id, id)));
  }

  private async read(tx: Transaction, id: string): Promise<PriceList> {
    const [row] = await tx
      .select({ list: priceLists, itemCount, customerCount })
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, getTenantId()), eq(priceLists.id, id)));
    if (!row) throw notFound('Price list');
    return toPriceList(row.list, row);
  }
}
```

- **`itemCount` and `customerCount`** are correlated subqueries: a workspace has a handful of lists, and each count
  uses an index (`price_list_items_list_product_idx`, `parties_tenant_price_list_idx`). They name the outer row as
  `price_lists.id`, like the customer groups' count above; with `${priceLists.id}`, `customerCount` would be the
  number of parties whose own id equals their price list id: always 0.
- **The items page is ordered by the product's name**, then the variant and the unit. Only the name is
  meaningful to a person; the variant and the unit make the order total (they are the row's key inside a list),
  so the cursor always says exactly where the next page starts. The cursor holds `lower(name)` as Postgres
  computed it: JavaScript's `toLowerCase()` can differ for some letters, and the cursor must compare the same way
  as the `ORDER BY`.
- **`setItems()` is all or nothing.** It first checks every change: the variant must exist in this workspace
  (`product_variant_unknown`), and the unit must be one the product is sold in, its base unit or one of its packs
  (`price_list_unit_invalid`). A price "per carton" for a product never sold by the carton could never be used.
  Every bad row gets its own field error, and nothing is saved.
- **`FOR SHARE` on the list and on the products.** The list cannot be archived halfway through the save. And a
  product save that drops a pack (which deletes that pack's prices, see below) waits for this save, or this save
  waits for it and then sees the pack gone. Without the lock, a price could be written for a unit the product
  stopped using a moment ago. `{ of: products }` locks the product rows only, not the variants.
- **An archived list refuses changes** (`price_list_invalid`). "Archived" means nobody uses it; restore it first.
- **A price of `null` deletes the row**, and the item falls back to the product's own price (15b). Rows that
  are not in the list are simply not deleted: no error.
- **The upsert targets the primary key**, `(tenant, list, variant, unit)`. `excluded.price` is the value this
  statement tried to insert. So a new price is inserted, and an existing one is changed in one statement, for the
  whole batch.
- **No version and no lock on the rows.** Two people can price different items of the same list at the same
  time. The last save of the *same* price wins, which is what a person expects of a price grid.
- **One audit row per batch**, with counts. A batch can hold 500 prices; 500 audit rows would bury everything else
  in the log.

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { LedgerService } from '../journal/ledger.service.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomersService } from './customers.service.js';

type Routes = typeof routes.customers;
type GroupRoutes = typeof routes.customerGroups;

@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly ledgers: LedgerService,
  ) {}

  @Endpoint(routes.customers.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.customers.list(query);
  }

  @Endpoint(routes.customers.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.customers.get(params.id);
  }

  @Endpoint(routes.customers.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.customers.create(body);
  }

  @Endpoint(routes.customers.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.customers.update(params.id, body);
  }

  @Endpoint(routes.customers.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.customers.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.customers.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.customers.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.customers.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.customers.remove(params.id, query.version);
  }

  // The route itself needs sales.customer.balance (the contract's `permission`)
  @Endpoint(routes.customers.statement)
  statement({
    params,
    query,
  }: RouteInput<Routes['statement']>): Promise<RouteResponse<Routes['statement']>> {
    return this.ledgers.statement(params.id, query);
  }
}

@Controller()
export class CustomerGroupsController {
  constructor(private readonly groups: CustomerGroupsService) {}

  @Endpoint(routes.customerGroups.list)
  async list(): Promise<RouteResponse<GroupRoutes['list']>> {
    return { items: await this.groups.list() };
  }

  @Endpoint(routes.customerGroups.create)
  create({
    body,
  }: RouteInput<GroupRoutes['create']>): Promise<RouteResponse<GroupRoutes['create']>> {
    return this.groups.create(body);
  }

  @Endpoint(routes.customerGroups.update)
  update({
    params,
    body,
  }: RouteInput<GroupRoutes['update']>): Promise<RouteResponse<GroupRoutes['update']>> {
    return this.groups.update(params.id, body);
  }

  @Endpoint(routes.customerGroups.remove)
  remove({ params, query }: RouteInput<GroupRoutes['remove']>): Promise<void> {
    return this.groups.remove(params.id, query.version);
  }
}
```

The statement route uses the journal's `LedgerService`; the permission on it (`sales.customer.balance`) comes
from the contract, like every route's.

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PriceListsService } from './price-lists.service.js';

type Routes = typeof routes.priceLists;

@Controller()
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @Endpoint(routes.priceLists.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.priceLists.list() };
  }

  @Endpoint(routes.priceLists.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.priceLists.get(params.id);
  }

  @Endpoint(routes.priceLists.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.priceLists.create(body);
  }

  @Endpoint(routes.priceLists.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.priceLists.update(params.id, body);
  }

  @Endpoint(routes.priceLists.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.priceLists.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.priceLists.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.priceLists.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.priceLists.items)
  items({ params, query }: RouteInput<Routes['items']>): Promise<RouteResponse<Routes['items']>> {
    return this.priceLists.items(params.id, query);
  }

  @Endpoint(routes.priceLists.setItems)
  setItems({
    params,
    body,
  }: RouteInput<Routes['setItems']>): Promise<RouteResponse<Routes['setItems']>> {
    return this.priceLists.setItems(params.id, body);
  }
}
```

```ts
import { Module } from '@nestjs/common';

import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BalanceAccess } from './balance-access.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomerGroupsController, CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { PriceListsController } from './price-lists.controller.js';
import { PriceListsService } from './price-lists.service.js';

// Sales (step 15): customers, their groups and the price lists in 15a; quotations, orders,
// deliveries, invoices and returns join in 15b–15d. NumberingModule gives the customer codes
// (C-00042), JournalModule the LedgerService behind a customer's statement, RbacModule the
// permission check of BalanceAccess.
@Module({
  imports: [NumberingModule, JournalModule, RbacModule],
  controllers: [CustomersController, CustomerGroupsController, PriceListsController],
  providers: [CustomersService, CustomerGroupsService, PriceListsService, BalanceAccess],
})
export class SalesModule {}
```

```diff
@@ -32,8 +32,10 @@ import { ProductsModule } from './products/products.module.js';
 import { RbacModule } from './rbac/rbac.module.js';
 import { ReportsModule } from './reports/reports.module.js';
 import { RolesModule } from './roles/roles.module.js';
+import { SalesModule } from './sales/sales.module.js';
 import { SettingsModule } from './settings/settings.module.js';
 import { SetupModule } from './setup/setup.module.js';
+import { TaxModule } from './tax/tax.module.js';
 
 @Module({})
 export class AppModule implements NestModule {
@@ -61,6 +63,8 @@ export class AppModule implements NestModule {
         CustomFieldsModule,
         ProductsModule,
         InventoryModule,
+        TaxModule,
+        SalesModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

### Products: a VAT rate per product

```diff
@@ -15,6 +15,7 @@ import {
   products,
   productUnits,
   productVariants,
+  taxRates,
   units,
 } from '@omnivo/db';
 import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
@@ -35,22 +36,28 @@ export interface ProductIssue {
   code: ErrorCode;
 }
 
-// The workspace's units, categories and active product fields: read once per request or per
-// import, not once per product
+// The workspace's units, categories, VAT rates and active product fields: read once per request
+// or per import, not once per product
 export interface ProductContext {
   units: Map<string, UnitRow>;
   categoryIds: Set<string>;
+  // Step 15a: each rate's id → whether it is archived
+  taxRates: Map<string, boolean>;
   fields: (typeof customFieldDefinitions.$inferSelect)[];
 }
 
 export async function loadProductContext(tx: Transaction): Promise<ProductContext> {
   const tenantId = getTenantId();
-  const [unitRows, categoryRows, fieldRows] = await Promise.all([
+  const [unitRows, categoryRows, rateRows, fieldRows] = await Promise.all([
     tx.select().from(units).where(eq(units.tenantId, tenantId)),
     tx
       .select({ id: productCategories.id })
       .from(productCategories)
       .where(eq(productCategories.tenantId, tenantId)),
+    tx
+      .select({ id: taxRates.id, archivedAt: taxRates.archivedAt })
+      .from(taxRates)
+      .where(eq(taxRates.tenantId, tenantId)),
     tx
       .select()
       .from(customFieldDefinitions)
@@ -66,6 +73,7 @@ export async function loadProductContext(tx: Transaction): Promise<ProductContex
   return {
     units: new Map(unitRows.map((row) => [row.id, row])),
     categoryIds: new Set(categoryRows.map((row) => row.id)),
+    taxRates: new Map(rateRows.map((row) => [row.id, row.archivedAt !== null])),
     fields: fieldRows,
   };
 }
@@ -74,12 +82,14 @@ export async function loadProductContext(tx: Transaction): Promise<ProductContex
 // are active, a standard conversion is exactly right, the category exists, the custom fields fit
 // the workspace's fields. `keepUnits`: units the product already uses stay allowed after being
 // archived ("products that use it keep it"). `saved`: the product's stored custom fields — the
-// values of archived fields are kept, the form never sends them.
+// values of archived fields are kept, the form never sends them. `keepTaxRate`: the product's own
+// VAT rate stays allowed after being archived, like its units (step 15a).
 export function checkProduct(
   input: ProductInput,
   context: ProductContext,
   keepUnits: ReadonlySet<string> = new Set(),
   saved: CustomFieldValues = {},
+  keepTaxRate: string | null = null,
 ): { issues: ProductIssue[]; customFields: CustomFieldValues } {
   const issues: ProductIssue[] = [];
   const usable = (id: string): UnitRow | undefined => {
@@ -90,6 +100,12 @@ export function checkProduct(
   if (input.categoryId !== null && !context.categoryIds.has(input.categoryId)) {
     issues.push({ path: 'categoryId', code: 'product_category_invalid' });
   }
+  if (input.taxRateId !== null) {
+    const archived = context.taxRates.get(input.taxRateId);
+    if (archived === undefined || (archived && input.taxRateId !== keepTaxRate)) {
+      issues.push({ path: 'taxRateId', code: 'tax_rate_invalid' });
+    }
+  }
   const base = usable(input.baseUnitId);
   if (!base) issues.push({ path: 'baseUnitId', code: 'product_unit_invalid' });
   input.units.forEach((pack, index) => {
@@ -298,6 +314,7 @@ export async function insertProducts(
           baseUnitId: input.baseUnitId,
           tracking: input.tracking,
           hasExpiry: input.hasExpiry,
+          taxRateId: input.taxRateId,
           options: input.options,
           customFields,
           createdBy: userId,
```

- **The rates go into `ProductContext`**, read once per request (or once per CSV import), like the units and
  categories.
- **`keepTaxRate`.** A product whose rate was archived since keeps it when it is saved again, the same rule as
  its archived units. A different archived rate is refused (`tax_rate_invalid`), like an unknown id.
- **`null` is always fine**: it means "the workspace default", and follows the default when it changes.

```diff
@@ -9,12 +9,14 @@ import {
   type UpdateProductInput,
 } from '@omnivo/contracts';
 import {
+  priceListItems,
   productBarcodes,
   productCategories,
   products,
   productUnits,
   productVariants,
   stockMovements,
+  taxRates,
   tenantSettings,
   units,
 } from '@omnivo/db';
@@ -109,6 +107,7 @@ interface Snapshot {
   category: string | null;
   baseUnit: string | null;
   tracking: string;
+  taxRate: string | null;
   variants: number;
   packs: string | null;
 }
@@ -253,7 +252,7 @@ export class ProductsService {
         const old = await this.read(tx, id);
         const context = await loadProductContext(tx);
         const keep = new Set([old.baseUnitId, ...old.units.map((pack) => pack.unitId)]);
-        const checked = checkProduct(input, context, keep, before.customFields);
+        const checked = checkProduct(input, context, keep, before.customFields, before.taxRateId);
         // An id sent back must be one of this product's own variants, and only once
         const known = new Set(old.variants.map((variant) => variant.id));
         const seen = new Set<string>();
@@ -287,6 +286,7 @@ export class ProductsService {
             baseUnitId: input.baseUnitId,
             tracking: input.tracking,
             hasExpiry: input.hasExpiry,
+            taxRateId: input.taxRateId,
             options: input.options,
             customFields: checked.customFields,
             version: sql`${products.version} + 1`,
@@ -294,6 +294,20 @@ export class ProductsService {
           })
           .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));
         await replaceUnits(tx, id, input);
+        // Step 15a: a price list's price per carton means nothing once the product is no longer
+        // sold by the carton. The prices of deleted variants went with them (ON DELETE CASCADE).
+        await tx
+          .delete(priceListItems)
+          .where(
+            and(
+              eq(priceListItems.tenantId, tenantId),
+              eq(priceListItems.productId, id),
+              notInArray(priceListItems.unitId, [
+                input.baseUnitId,
+                ...input.units.map((pack) => pack.unitId),
+              ]),
+            ),
+          );
         const variantIds = await this.replaceVariants(tx, id, input, skus, old);
         await tx
           .delete(productBarcodes)
@@ -551,6 +565,7 @@ export class ProductsService {
       purchaseUnitId: packs.find((pack) => pack.isPurchaseDefault)?.unitId ?? null,
       tracking: row.tracking,
       hasExpiry: row.hasExpiry,
+      taxRateId: row.taxRateId,
       options: row.options,
       variants: variants.map((variant) => ({
         id: variant.id,
@@ -575,7 +590,7 @@ export class ProductsService {
   private async snapshot(tx: Transaction, product: Product): Promise<Snapshot> {
     const tenantId = getTenantId();
     const unitIds = [product.baseUnitId, ...product.units.map((pack) => pack.unitId)];
-    const [unitRows, [category]] = await Promise.all([
+    const [unitRows, [category], [rate]] = await Promise.all([
       tx
         .select({ id: units.id, code: units.code })
         .from(units)
@@ -591,6 +606,12 @@ export class ProductsService {
                 eq(productCategories.id, product.categoryId),
               ),
             ),
+      product.taxRateId === null
+        ? [undefined]
+        : tx
+            .select({ name: taxRates.name })
+            .from(taxRates)
+            .where(and(eq(taxRates.tenantId, tenantId), eq(taxRates.id, product.taxRateId))),
     ]);
     const codeOf = new Map(unitRows.map((unit) => [unit.id, unit.code]));
     const packs = product.units
@@ -603,6 +624,8 @@ export class ProductsService {
       category: category?.name ?? null,
       baseUnit: codeOf.get(product.baseUnitId) ?? null,
       tracking: product.tracking,
+      // null = the workspace's default rate
+      taxRate: rate?.name ?? null,
       variants: product.variants.filter((variant) => variant.archivedAt === null).length,
       packs: packs === '' ? null : packs,
     };
```

- **The product's old rate is passed as `keepTaxRate`.**
- **The stale prices are deleted.** A price list can hold a price per carton. If the product stops being sold by
  the carton (the pack is removed from the form), that price can never be used again, and the price list page
  would show a unit the product no longer has. So the update deletes the product's prices whose unit is no longer
  the base unit or one of its packs. The prices of deleted variants need no code: they go with the variant
  (`ON DELETE CASCADE`, 15a.2).
- **The audit snapshot shows the rate's name**, or `null` for "the default".

```diff
@@ -346,6 +346,8 @@ function buildProduct(
     purchaseUnitId: unitId('purchase_unit'),
     tracking,
     hasExpiry,
+    // No column for it yet (step 15a): an imported product follows the workspace's default rate
+    taxRateId: '',
     options: options.map(({ name, values }) => ({ name, values })),
     variants: group.map((row) => ({
       id: null,
```

This line is easy to miss, and without it every import fails. The CSV import builds a plain object and parses
it with the same `productInputSchema` as the form. The schema now has a `taxRateId` field that is not optional, so
an object without it fails on every row. `''` is what the form's "Default" option sends. A VAT rate column in the
CSV comes later.

### Settings

```diff
@@ -186,5 +186,6 @@ function pickEditable(settings: typeof tenantSettings.$inferSelect) {
     fiscalYearStartMonth: settings.fiscalYearStartMonth,
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
+    pricesIncludeVat: settings.pricesIncludeVat,
   };
 }
```

One line: the update already writes every field of the form (`...fields`), and `pickEditable()` is the list the
answer and the audit row are read from.

> **What we checked in this part.** The API type-checks, except three old integration test fixtures that still
> build products without `taxRateId` (fixed in 15a.4). ESLint is clean. The unit tests pass, including
> `contract.spec.ts`, which starts the app and checks that every route in the contract is served: the 25 new
> routes are all there. The existing journal integration suite passes, apart from two tests whose expected answers
> changed in 15a.1 (the settings body has a new field; a duplicate opening line now answers
> `opening_balance_twice` from the contract). Those, and the tests of everything new, are part 15a.4.

## 15a.4 — `apps/api`: the tests

This part adds four test files and changes eleven old ones. The new files test what 15a.3 built, against a real
Postgres and the real worker, like every integration test since step 5: `tax/tax-rates.int.spec.ts`,
`sales/customers.int.spec.ts`, `sales/price-lists.int.spec.ts` and `sales/sales.tenant-leak.int.spec.ts`. The
old files change for three reasons: two forms have a new field, the role templates and the setup job do more, and
two answers moved from the service to the contract.

Writing these tests found two bugs in the 15a.3 code. Both are fixed there, and the 15a.3 sections above already
show the fixed code:

- **Every customer read answered 500**, and two counts were always 0. The correlated subqueries named the outer
  table through Drizzle (`${parties.id}`), and Drizzle prints that as a bare `"id"` in a one-table select. See
  `customer-groups.service.ts` and `customers.service.ts` in 15a.3.
- **"Save and post" reported a missing customer only in a second round.** See `journal.service.ts` in 15a.3.

### The old tests: two new fields in the forms

The product form now sends `taxRateId`, and the settings form sends `pricesIncludeVat`. Both are required in the
contract, because both forms always send the whole form (an old form that leaves the field out gets a 400, and
does not quietly reset the value). So every test that builds one of these forms by hand needs the new field. Only
three of them failed the type check: the others build the body as a plain object, which TypeScript does not
compare with the contract. Those would have failed at run time instead, with a 400. Searching the specs for
`hasExpiry:` and `allowNegativeStock:` finds them all.

```diff
@@ -83,6 +83,7 @@ function product(name: string, units: Unit[], extra: Partial<ProductFormValues>
     purchaseUnitId: '',
     tracking: 'none',
     hasExpiry: false,
+    taxRateId: '',
     options: [],
     variants: [
       { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
```

```diff
@@ -101,6 +101,7 @@ async function productIn(who: SignedIn, units: Unit[], name: string): Promise<Pr
     purchaseUnitId: '',
     tracking: 'batch',
     hasExpiry: false,
+    taxRateId: '',
     options: [],
     variants: [
       { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
```

```diff
@@ -124,6 +124,7 @@ async function product(name: string, extra: Partial<ProductFormValues> = {}): Pr
     purchaseUnitId: '',
     tracking: 'none',
     hasExpiry: false,
+    taxRateId: '',
     options: [],
     variants: [
       { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
```

```diff
@@ -110,6 +110,7 @@ async function product(name: string, extra: Partial<ProductFormValues>): Promise
     purchaseUnitId: '',
     tracking: 'none',
     hasExpiry: false,
+    taxRateId: '',
     options: [],
     variants: [
       { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
@@ -170,6 +171,7 @@ function settingsForm(settings: Settings) {
     fiscalYearStartMonth: settings.fiscalYearStartMonth,
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
+    pricesIncludeVat: settings.pricesIncludeVat,
   };
 }
 
@@ -871,6 +873,7 @@ describe('a product with stock', () => {
       purchaseUnitId: '',
       tracking: 'none',
       hasExpiry: false,
+      taxRateId: current.taxRateId ?? '',
       options: [],
       variants: current.variants.map((variant) => ({
         id: variant.id,
```

The edit near the end of the stock test sends the product's own rate back (`current.taxRateId ?? ''`), like the
edit page does. Sending `''` there would also pass today, but it would silently move the product to the default
rate, which is not what the test means.

### `products/products.int.spec.ts`: a VAT rate per product

```diff
@@ -12,6 +12,8 @@ import {
   productSchema,
   problemSchema,
   setupSchema,
+  taxRateListSchema,
+  taxRateSchema,
   type Unit,
   unitListSchema,
   unitSchema,
@@ -91,6 +93,7 @@ function simple(name: string, extra: Partial<ProductFormValues> = {}): ProductFo
     purchaseUnitId: '',
     tracking: 'none',
     hasExpiry: false,
+    taxRateId: '',
     options: [],
     variants: [variant()],
     units: [],
@@ -112,6 +115,7 @@ function formOf(product: Product): ProductFormValues & { version: number } {
     purchaseUnitId: product.purchaseUnitId ?? '',
     tracking: 'none',
     hasExpiry: product.hasExpiry,
+    taxRateId: product.taxRateId ?? '',
     options: product.options,
     variants: product.variants.map((saved) => ({
       id: saved.id,
@@ -633,3 +637,60 @@ describe('permissions', () => {
     expect(field.statusCode).toBe(403);
   });
 });
+
+describe('a VAT rate per product (step 15a)', () => {
+  async function rate(name: string) {
+    const { items } = taxRateListSchema.parse((await send('GET', '/tax-rates')).json());
+    const found = items.find((candidate) => candidate.name === name);
+    if (!found) throw new Error(`no rate ${name}`);
+    return found;
+  }
+
+  async function setArchived(name: string, action: 'archive' | 'restore') {
+    const found = await rate(name);
+    const res = await send('POST', `/tax-rates/${found.id}/${action}`, { version: found.version });
+    return taxRateSchema.parse(res.json());
+  }
+
+  it('follows the workspace default, or keeps a rate of its own', async () => {
+    expect((await created(simple('Gift box'))).taxRateId).toBeNull();
+    const zero = await rate('Zero-rated');
+    const polo = await created(simple('Knit polo shirt, export', { taxRateId: zero.id }));
+    expect(polo.taxRateId).toBe(zero.id);
+    // The audit log names the rate, not its id
+    const { items } = auditPageSchema.parse(
+      (await send('GET', `/audit-logs?entityType=product&entityId=${polo.id}`)).json(),
+    );
+    expect(items[0]?.changes).toMatchObject({ taxRate: { from: null, to: 'Zero-rated' } });
+  });
+
+  it('keeps a rate archived since, and refuses another archived or unknown rate', async () => {
+    const { items } = productPageSchema.parse((await send('GET', '/products?search=polo')).json());
+    const polo = productSchema.parse((await send('GET', `/products/${items[0]?.id ?? ''}`)).json());
+    const zero = await setArchived('Zero-rated', 'archive');
+    const exempt = await setArchived('Exempt', 'archive');
+
+    const kept = await send('PUT', `/products/${polo.id}`, formOf(polo));
+    expect(kept.statusCode, kept.body).toBe(200);
+    expect(productSchema.parse(kept.json()).taxRateId).toBe(zero.id);
+
+    const fresh = await send('POST', '/products', simple('Woven shirt', { taxRateId: zero.id }));
+    expect(fresh.statusCode).toBe(400);
+    expect(problemOf(fresh).fieldErrors).toEqual({ taxRateId: ['tax_rate_invalid'] });
+    const saved = productSchema.parse(kept.json());
+    const other = await send('PUT', `/products/${polo.id}`, {
+      ...formOf(saved),
+      taxRateId: exempt.id,
+    });
+    expect(problemOf(other).fieldErrors).toEqual({ taxRateId: ['tax_rate_invalid'] });
+    const unknown = await send(
+      'POST',
+      '/products',
+      simple('Woven shirt', { taxRateId: '01939d1c-0000-7000-8000-000000000000' }),
+    );
+    expect(problemOf(unknown).fieldErrors).toEqual({ taxRateId: ['tax_rate_invalid'] });
+
+    await setArchived('Zero-rated', 'restore');
+    await setArchived('Exempt', 'restore');
+  });
+});
```

- **`formOf()` sends the saved rate back**, with `?? ''` for "the default", like the edit page.
- **The new tests are the last `describe`.** The product list tests above count every product in the workspace;
  products made earlier in the file would change their numbers.
- **"follows the workspace default"**: a product saved with `''` stores `null`. The audit row names the rate
  (`'Zero-rated'`), not its id: the snapshot change of 15a.3.
- **"keeps a rate archived since"**: the rule of `keepTaxRate`. The polo shirt was saved with Zero-rated. That rate
  is archived, and saving the product unchanged still works. A new product with the same archived rate is refused,
  and so is moving the polo shirt to another archived rate (Exempt). A made-up id gets the same answer. The test
  restores both rates at the end, so later tests start from the template's rates.

### `settings/settings.int.spec.ts`

```diff
@@ -91,6 +91,7 @@ function form(settings: Settings) {
     fiscalYearStartMonth: settings.fiscalYearStartMonth,
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
+    pricesIncludeVat: settings.pricesIncludeVat,
   };
 }
 
@@ -102,6 +103,8 @@ describe('settings', () => {
       fiscalYearStartMonth: 7,
       timezone: 'Asia/Dhaka',
       logo: null,
+      // Step 15a: prices are typed before VAT, the way a distributor quotes
+      pricesIncludeVat: false,
       version: 1,
     });
   });
@@ -235,3 +238,27 @@ describe('company logo', () => {
     });
   });
 });
+
+// Last: it changes the settings' version, which the tests above count
+describe('prices and VAT', () => {
+  it('remembers whether the prices typed include VAT (step 15a)', async () => {
+    const res = await send('PUT', '/settings', {
+      ...form(await current()),
+      pricesIncludeVat: true,
+    });
+    expect(settingsSchema.parse(res.json()).pricesIncludeVat).toBe(true);
+    const audit = auditPageSchema.parse(
+      (await send('GET', '/audit-logs?entityType=workspace')).json(),
+    );
+    expect(audit.items.find((item) => item.action === 'settings.updated')?.changes).toEqual({
+      pricesIncludeVat: { from: false, to: true },
+    });
+    // The settings form always sends the whole form: a body without the switch is refused, not
+    // read as "off"
+    const partial = Object.fromEntries(
+      Object.entries(form(await current())).filter(([key]) => key !== 'pricesIncludeVat'),
+    );
+    const without = await send('PUT', '/settings', partial);
+    expect(without.statusCode).toBe(400);
+  });
+});
```

- **The default is `false`**: a distributor quotes before VAT, and that is what 15a.2's column default says.
- **The switch is saved and logged** like any other setting.
- **A body without the switch is a 400.** This is the reason the field is required: an older form that does not
  know the switch must not turn it off by leaving it out.
- **The new test is the last `describe`.** It changes the settings' version, and the logo test above checks that
  version.

### `journal/journal.int.spec.ts` and `numbering/numbering.int.spec.ts`

```diff
@@ -400,6 +400,7 @@ describe('a posted entry', () => {
       fiscalYearStartMonth: settings.fiscalYearStartMonth,
       timezone: settings.timezone,
       allowNegativeStock: settings.allowNegativeStock,
+      pricesIncludeVat: settings.pricesIncludeVat,
     });
     expect(res.statusCode).toBe(409);
     expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
@@ -549,8 +550,10 @@ describe('opening balances', () => {
         { accountId: id('1110'), debit: '', credit: '100' },
       ],
     });
+    // Step 15a: the contract refuses it, before the server reads a single account
+    expect(twice.statusCode).toBe(400);
     expect(problemSchema.parse(twice.json()).fieldErrors).toEqual({
-      'lines.1.accountId': ['opening_account_twice'],
+      'lines.1.debit': ['opening_balance_twice'],
     });
   });
 });
```

The settings form gets the new field, like above. The duplicate opening-balance line is now refused by the
contract (15a.1), so the answer is a 400 with the error under `lines.1.debit`, before the server reads a single
account. Before, the service answered 409 under `lines.1.accountId`.

```diff
@@ -101,7 +101,13 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(10);
+    expect(items.map((series) => series.documentType)).toHaveLength(11);
+    // Customer codes (step 15a): like product codes, no year and five digits
+    expect(items.find((series) => series.documentType === 'sales.customer')).toMatchObject({
+      prefix: 'C',
+      yearStyle: 'none',
+      nextNumber: 'C-00001',
+    });
     // Stock revaluations (step 14)
     expect(items.find((series) => series.documentType === 'inventory.revaluation')).toMatchObject({
       prefix: 'REV',
```

There are eleven document types now. The customer series is checked like the product series: prefix `C`, no
year, five digits.

### `setup/setup.int.spec.ts`: sales roles and VAT rates

```diff
@@ -9,6 +9,7 @@ import {
   roleListSchema,
   setupSchema,
   stockAccountsSchema,
+  taxRateListSchema,
   unitListSchema,
 } from '@omnivo/contracts';
 import postgres from 'postgres';
@@ -32,7 +33,7 @@ import {
 import { bearer, type SignedIn, signUp } from '../testing/http.js';
 import { accountCount, catalogCount } from '../testing/chart.js';
 import { lastMailTo } from '../testing/mailpit.js';
-import { INDUSTRY_TEMPLATES } from './templates.js';
+import { INDUSTRY_TEMPLATES, TAX_RATES } from './templates.js';
 
 const GARMENTS_ACCOUNTS = accountCount(INDUSTRY_TEMPLATES.garments.chart);
 const GARMENTS_CATALOG = catalogCount(INDUSTRY_TEMPLATES.garments.catalog);
@@ -140,9 +141,12 @@ describe('starting the setup', () => {
           'core.user.read',
           'inventory.stock.revalue',
           'inventory.stock.value',
+          'sales.customer.balance',
+          'sales.customer.manage',
+          'sales.price_list.manage',
         ],
       ],
-      ['Merchandiser', ['core.user.read', 'inventory.product.manage']],
+      ['Merchandiser', ['core.user.read', 'inventory.product.manage', 'sales.customer.manage']],
       [
         'Store keeper',
         ['inventory.product.manage', 'inventory.stock.adjust', 'inventory.stock.transfer'],
@@ -161,6 +165,16 @@ describe('starting the setup', () => {
     expect(codeOf(choices.damaged)).toBe('5150');
     expect(codeOf(choices.revaluation)).toBe('5190');
     expect(codeOf(choices.internal_use)).toBe('5290');
+    // Step 15a: the VAT rates, the same for every business type, with 15% as the default
+    const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json());
+    expect(rates.items.map((rate) => [rate.name, rate.kind, rate.rate, rate.isDefault])).toEqual([
+      ['VAT 15%', 'standard', '15.00', true],
+      ['VAT 10%', 'reduced', '10.00', false],
+      ['VAT 7.5%', 'reduced', '7.50', false],
+      ['VAT 5%', 'reduced', '5.00', false],
+      ['Exempt', 'exempt', '0.00', false],
+      ['Zero-rated', 'zero_rated', '0.00', false],
+    ]);
   });
 
   it('writes the audit log as the system, with the request that started it', async () => {
@@ -182,6 +196,7 @@ describe('starting the setup', () => {
         units: { from: null, to: GARMENTS_CATALOG.units },
         categories: { from: null, to: GARMENTS_CATALOG.categories },
         customFields: { from: null, to: GARMENTS_CATALOG.customFields },
+        taxRates: { from: null, to: TAX_RATES.length },
       },
     });
     // The worker ran in the context of the POST /setup request: one click, traced end to end
@@ -274,15 +289,22 @@ describe('when the setup job fails', () => {
     await superuserSql(
       (sql) => sql`UPDATE tenants SET industry = 'pharma' WHERE slug = 'karim-pharma'`,
     );
-    // Step 9's migration queues a chart, and step 12's a catalog, for every workspace that is not
-    // 'pending' — this failed one too. Both arrive before the retry, so the retried setup job must
-    // leave them alone.
+    // Step 9's migration queues a chart, step 12's a catalog and step 15a's the VAT rates, for
+    // every workspace that is not 'pending' — this failed one too. All three arrive before the
+    // retry, so the retried setup job must leave them alone.
     await superuserSql(
       (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                    SELECT gen_random_uuid(), id, event, '{}'::jsonb
-                   FROM tenants, unnest(ARRAY['workspace.chart_requested', 'workspace.catalog_requested']) AS event
+                   FROM tenants, unnest(ARRAY['workspace.chart_requested', 'workspace.catalog_requested',
+                                              'workspace.tax_rates_requested']) AS event
                    WHERE slug = 'karim-pharma'`,
     );
+    await eventually(async () => {
+      const rates = taxRateListSchema.parse(
+        (await send('GET', '/tax-rates', undefined, pharmaOwner)).json(),
+      );
+      expect(rates.items).toHaveLength(TAX_RATES.length);
+    });
     await eventually(async () => {
       const units = unitListSchema.parse(
         (await send('GET', '/units', undefined, pharmaOwner)).json(),
@@ -321,11 +343,17 @@ describe('when the setup job fails', () => {
       description: 'Our own',
       permissions: [],
     });
-    // Still one chart, and the setup's audit row says it added none
+    // Still one chart, and the setup's audit row says it added none (no taxRates in it either)
     const chart = accountListSchema.parse(
       (await send('GET', '/accounts', undefined, pharmaOwner)).json(),
     );
     expect(chart.items).toHaveLength(pharmaAccounts);
+    // …one set of VAT rates, with one default…
+    const rates = taxRateListSchema.parse(
+      (await send('GET', '/tax-rates', undefined, pharmaOwner)).json(),
+    );
+    expect(rates.items).toHaveLength(TAX_RATES.length);
+    expect(rates.items.filter((rate) => rate.isDefault)).toHaveLength(1);
     const log = auditPageSchema.parse(
       (await send('GET', '/audit-logs?entityType=workspace', undefined, pharmaOwner)).json(),
     );
@@ -403,4 +431,59 @@ describe('a workspace set up before the chart of accounts', () => {
     );
     expect(items.filter((entry) => entry.action === 'workspace.chart_created')).toHaveLength(1);
   });
+
+  // Step 15a: migration 0026 queues one 'workspace.tax_rates_requested' per workspace that is not
+  // 'pending'. This one has none yet.
+  async function requestTaxRates(): Promise<void> {
+    await superuserSql(
+      (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
+                   SELECT gen_random_uuid(), id, 'workspace.tax_rates_requested', '{}'::jsonb
+                   FROM tenants WHERE slug = 'hossain-traders'`,
+    );
+  }
+
+  async function taxRates() {
+    return taxRateListSchema.parse((await send('GET', '/tax-rates', undefined, oldOwner)).json())
+      .items;
+  }
+
+  it('gets the VAT rates from the worker, logged as the system', async () => {
+    expect(await taxRates()).toEqual([]);
+    await requestTaxRates();
+    await eventually(async () => {
+      expect(await taxRates()).toHaveLength(TAX_RATES.length);
+    });
+    const { items } = auditPageSchema.parse(
+      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
+    );
+    expect(items[0]).toMatchObject({
+      action: 'tax_rates.created',
+      actor: null,
+      changes: { rates: { from: null, to: TAX_RATES.length } },
+    });
+  });
+
+  it('adds no second set when the event comes again, even after the owner changed them', async () => {
+    // The owner archives a rate the business never uses. A second set would bring it back.
+    const fivePercent = (await taxRates()).find((rate) => rate.name === 'VAT 5%');
+    if (!fivePercent) throw new Error('no 5% rate');
+    const archived = await send(
+      'POST',
+      `/tax-rates/${fivePercent.id}/archive`,
+      { version: fivePercent.version },
+      oldOwner,
+    );
+    expect(archived.statusCode).toBe(200);
+
+    await requestTaxRates();
+    await eventually(() => unpublished(0));
+    await new Promise((resolve) => setTimeout(resolve, 500));
+    const after = await taxRates();
+    expect(after).toHaveLength(TAX_RATES.length);
+    expect(after.find((rate) => rate.id === fivePercent.id)?.archivedAt).not.toBeNull();
+    const { items } = auditPageSchema.parse(
+      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
+    );
+    expect(items.filter((entry) => entry.action === 'tax_rates.created')).toHaveLength(1);
+  });
 });
```

- **The role templates.** The Accountant gets the three sales permissions, and the garments Merchandiser gets
  `sales.customer.manage`, as 15a.3 set them. The list is sorted, like the API sends it.
- **A new workspace gets the six VAT rates** from the setup job, with 15% as the only default, and the
  provisioning audit row says how many (`taxRates`). The rates come back in the order the pickers show them: the
  default first, then the highest rate, then by name. The rates come back as `'15.00'`: Postgres sends
  `NUMERIC(5,2)` with two decimals.
- **The failed-setup test queues the VAT rates job too.** Migration 0026 queues it for every workspace that is not
  `pending`, and a failed workspace is not pending. Like the chart and the catalog jobs before it, the job runs
  before the retry, and the test then checks that the retried setup job left the rates alone. That is what
  "`changes` has no `taxRates`" means in the last check (`created()` leaves `null` values out).
- **A workspace from before step 15a** gets its rates from the worker job, logged as the system
  (`actor: null`). The second test is the "do it twice" check every job here has. Before the event comes again,
  the owner archives the 5% rate. A job that added the template's rates again would bring that rate back, or add a
  second default, so the test checks that the 5% rate is still archived and that there is still one audit row.

### `setup/templates.spec.ts`: the VAT rate template

```diff
@@ -7,10 +7,16 @@ import {
   accountTypeFits,
   INDUSTRIES,
   STOCK_ACCOUNT_USES,
+  taxRateInputSchema,
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
-import { type AccountTemplate, type CategoryTemplate, INDUSTRY_TEMPLATES } from './templates.js';
+import {
+  type AccountTemplate,
+  type CategoryTemplate,
+  INDUSTRY_TEMPLATES,
+  TAX_RATES,
+} from './templates.js';
 
 function flatten(node: AccountTemplate): AccountTemplate[] {
   return [node, ...(node.children ?? []).flatMap(flatten)];
@@ -110,3 +116,20 @@ describe.each(INDUSTRIES)('the %s catalog', (industry) => {
     expect(new Set(keys).size).toBe(keys.length);
   });
 });
+
+// Step 15a. The database would take a "standard 0%" or a second default only until a person saves
+// it in the form; the setup job writes the rows directly, so the form's rules are checked here.
+describe('the VAT rates', () => {
+  it('are what the form accepts, each name once', () => {
+    for (const rate of TAX_RATES) {
+      expect(taxRateInputSchema.safeParse(rate).success, rate.name).toBe(true);
+    }
+    const names = TAX_RATES.map((rate) => rate.name.toLowerCase());
+    expect(new Set(names).size).toBe(names.length);
+  });
+
+  it('have exactly one default, and it is the standard rate', () => {
+    const defaults = TAX_RATES.filter((rate) => rate.isDefault);
+    expect(defaults.map((rate) => [rate.kind, rate.rate])).toEqual([['standard', '15']]);
+  });
+});
```

The setup job writes the template's rates straight into the table. The form's rules (`taxRateInputSchema`: a
standard rate above 0, at most two decimals) are checked only when a person saves a rate, so the template could
break them without anyone noticing until a real workspace is set up. These unit tests run the template through the
same schema. The second test pins the one default to the standard 15%.

### `tax/tax-rates.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  problemSchema,
  setupSchema,
  type TaxRate,
  taxRateListSchema,
  taxRateSchema,
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
// Nasrin: a member of Farhana's workspace with no role at all
let viewer: SignedIn;

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function rates(): Promise<TaxRate[]> {
  return taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
}

async function rate(name: string): Promise<TaxRate> {
  const found = (await rates()).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no rate ${name}`);
  return found;
}

// What the settings page's form sends for a saved rate; each test changes a few fields
function formOf(saved: TaxRate, extra: object = {}) {
  return {
    name: saved.name,
    kind: saved.kind,
    rate: saved.rate,
    isDefault: saved.isDefault,
    version: saved.version,
    ...extra,
  };
}

async function defaults(): Promise<string[]> {
  return (await rates()).filter((candidate) => candidate.isDefault).map((found) => found.name);
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
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });

  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  viewer = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('VAT rates', () => {
  it('are read by anyone, and changed only with the settings permission', async () => {
    const res = await send('GET', '/tax-rates', undefined, viewer);
    expect(res.statusCode).toBe(200);
    expect(taxRateListSchema.parse(res.json()).items).toHaveLength(6);

    const add = await send(
      'POST',
      '/tax-rates',
      { name: 'VAT 2.4%', kind: 'reduced', rate: '2.4', isDefault: false },
      viewer,
    );
    expect(add.statusCode).toBe(403);
    expect(problemSchema.parse(add.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'core.settings.manage' },
    });
  });

  it('adds a rate, and refuses a name in use in any case, or a kind that does not fit', async () => {
    const res = await send('POST', '/tax-rates', {
      name: 'VAT 2.4%',
      kind: 'reduced',
      rate: '2.4',
      isDefault: false,
    });
    expect(res.statusCode).toBe(201);
    expect(taxRateSchema.parse(res.json())).toMatchObject({
      rate: '2.40',
      isDefault: false,
      version: 1,
    });

    const same = await send('POST', '/tax-rates', {
      name: 'vat 2.4%',
      kind: 'reduced',
      rate: '2.4',
      isDefault: false,
    });
    expect(same.statusCode).toBe(409);
    expect(problemSchema.parse(same.json()).fieldErrors).toEqual({
      name: ['tax_rate_name_taken'],
    });
    // A "standard 0%" would put a sale in the wrong box of the VAT return
    const zero = await send('POST', '/tax-rates', {
      name: 'VAT nil',
      kind: 'standard',
      rate: '0',
      isDefault: false,
    });
    expect(zero.statusCode).toBe(400);
    expect(problemSchema.parse(zero.json()).fieldErrors).toEqual({ rate: ['tax_rate_kind_rate'] });
  });

  it('keeps exactly one default: it moves to another rate, it is never switched off', async () => {
    const reduced = await rate('VAT 7.5%');
    const moved = await send(
      'PUT',
      `/tax-rates/${reduced.id}`,
      formOf(reduced, { isDefault: true }),
    );
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await defaults()).toEqual(['VAT 7.5%']);
    // The old default changed too, so a page that still holds it must reload it
    expect((await rate('VAT 15%')).version).toBe(2);

    const now = await rate('VAT 7.5%');
    const off = await send('PUT', `/tax-rates/${now.id}`, formOf(now, { isDefault: false }));
    expect(off.statusCode).toBe(409);
    expect(problemSchema.parse(off.json()).fieldErrors).toEqual({
      isDefault: ['tax_rate_default_needed'],
    });

    const standard = await rate('VAT 15%');
    const back = await send(
      'PUT',
      `/tax-rates/${standard.id}`,
      formOf(standard, { isDefault: true }),
    );
    expect(back.statusCode).toBe(200);
    expect(await defaults()).toEqual(['VAT 15%']);
  });

  it('lets two saves that both move the default take turns', async () => {
    // A third session holds the default row, so both saves are inside their transactions, waiting,
    // at the same moment. Without the advisory lock both would then clear the same old default,
    // neither would see the other's new one, and the unique index would refuse the second insert
    // with a database error (500).
    const sql = postgres(pg.superuserUrl, { max: 2, onnotice: () => undefined });
    const holder = await sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT id FROM tax_rates WHERE is_default FOR UPDATE`;
    const saves = Promise.all([
      send('POST', '/tax-rates', {
        name: 'VAT 4.5%',
        kind: 'reduced',
        rate: '4.5',
        isDefault: true,
      }),
      send('POST', '/tax-rates', {
        name: 'VAT 1.5%',
        kind: 'reduced',
        rate: '1.5',
        isDefault: true,
      }),
    ]);
    await eventually(async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
      expect(row?.n).toBe(2);
    });
    await holder`COMMIT`;
    holder.release();
    await sql.end();
    const [first, second] = await saves;
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(await defaults()).toHaveLength(1);

    const standard = await rate('VAT 15%');
    await send('PUT', `/tax-rates/${standard.id}`, formOf(standard, { isDefault: true }));
    expect(await defaults()).toEqual(['VAT 15%']);
  });

  it('archives any rate but the default, and brings it back', async () => {
    const standard = await rate('VAT 15%');
    const refused = await send('POST', `/tax-rates/${standard.id}/archive`, {
      version: standard.version,
    });
    expect(refused.statusCode).toBe(409);
    expect(problemSchema.parse(refused.json()).code).toBe('tax_rate_default_archived');

    const small = await rate('VAT 1.5%');
    const archived = taxRateSchema.parse(
      (await send('POST', `/tax-rates/${small.id}/archive`, { version: small.version })).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    // Archived twice is still archived, and nothing changed: the version stays
    const again = taxRateSchema.parse(
      (await send('POST', `/tax-rates/${small.id}/archive`, { version: archived.version })).json(),
    );
    expect(again.version).toBe(archived.version);
    // An archived rate cannot become the default
    const asDefault = await send(
      'PUT',
      `/tax-rates/${small.id}`,
      formOf(archived, { isDefault: true }),
    );
    expect(problemSchema.parse(asDefault.json()).code).toBe('tax_rate_default_archived');

    const restored = taxRateSchema.parse(
      (await send('POST', `/tax-rates/${small.id}/restore`, { version: archived.version })).json(),
    );
    expect(restored.archivedAt).toBeNull();
  });

  it('refuses a stale version, and logs each change for the audit', async () => {
    const reduced = await rate('VAT 10%');
    const stale = await send(
      'PUT',
      `/tax-rates/${reduced.id}`,
      formOf(reduced, { rate: '12', version: reduced.version + 1 }),
    );
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');

    // The NBR changes a rate: only the rate, so only the rate is in the log
    const changed = await send('PUT', `/tax-rates/${reduced.id}`, formOf(reduced, { rate: '12' }));
    expect(changed.statusCode).toBe(200);
    const { items } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=tax_rate&entityId=${reduced.id}`)).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'tax_rate.updated',
      changes: { rate: { from: '10.00', to: '12.00' } },
    });
  });
});
```

- **The viewer reads the rates.** Every product form and sales line picks a rate, so reading needs no
  permission; changing one needs `core.settings.manage`. The 403 names the missing permission in `params`.
- **The name is unique in any case** (`'vat 2.4%'` against `'VAT 2.4%'`), because the index is on `lower(name)`.
  A "standard 0%" is refused by the contract (400), not the service.
- **The default moves; it is never switched off.** Making 7.5% the default takes the flag off 15%, and 15%'s
  version goes up: an open settings page that still holds 15% must reload, or it would save it back as the
  default. Switching the default off is refused with `tax_rate_default_needed` on the `isDefault` field.
- **The race test is built to really race.** Two saves sent at the same time usually do not overlap: one is
  finished before the other starts, and the test passes even without the lock (we tried). So a third session, as
  the superuser, first locks the default row (`FOR UPDATE`) inside an open transaction (`sql.reserve()` keeps one
  connection for it). Then the two saves start. The test waits until Postgres shows two sessions waiting for a
  lock, and only then commits. With the advisory lock, one save waits for the row and the other waits for the
  advisory lock, and they finish one after the other. Without it, both wait for the row, both clear the same old
  default, and the second insert breaks the unique index: the test then gets `[201, 500]`. We removed the lock on
  purpose to see that answer.
- **Archived twice is still archived**, and the version does not change: no write happened. An archived rate
  cannot become the default.
- **A stale version** uses `version + 1`. `version - 1` would be 0, which the contract refuses as a 400 before the
  service ever compares versions.
- **The audit row has only what changed**: the NBR changed one rate, so the row has only `rate`.

### `sales/customers.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Customer,
  type CustomerFormValues,
  customerGroupListSchema,
  customerGroupSchema,
  customerPageSchema,
  customerSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  openingBalancesSchema,
  priceListSchema,
  problemSchema,
  roleSchema,
  setupSchema,
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
// Nasrin: adds and changes customers, but may not see what they owe
let seller: SignedIn;
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

// The garments chart: 1110 cash, 1140 the receivable, 4110 export sales
const RECEIVABLE = '1140';

// What the customer form sends; each test changes a few fields
function customerForm(name: string, extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
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
  };
}

// A form built from a saved customer, as the edit page does
function formOf(customer: Customer, extra: Partial<CustomerFormValues> = {}) {
  return {
    code: customer.code,
    name: customer.name,
    groupId: customer.groupId ?? '',
    contactPerson: customer.contactPerson ?? '',
    phone: customer.phone ?? '',
    email: customer.email ?? '',
    bin: customer.bin ?? '',
    paymentTermsDays: customer.paymentTermsDays,
    creditLimit: customer.creditLimit ?? '',
    priceListId: customer.priceListId ?? '',
    notes: customer.notes ?? '',
    addresses: customer.addresses.map((address) => ({
      id: address.id,
      kind: address.kind === 'billing' ? ('billing' as const) : ('shipping' as const),
      label: address.label ?? '',
      address: address.address,
      phone: address.phone ?? '',
    })),
    ...extra,
    version: customer.version,
  };
}

async function addCustomer(name: string, extra: Partial<CustomerFormValues> = {}) {
  const res = await send('POST', '/customers', customerForm(name, extra));
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

async function customer(customerId: string, as = owner): Promise<Customer> {
  return customerSchema.parse(
    (await send('GET', `/customers/${customerId}`, undefined, as)).json(),
  );
}

// A line as the journal form sends it: '' on the empty side, '' for "no customer"
function debit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: amount, credit: '' };
}
function credit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: '', credit: amount };
}

function write(date: string, lines: object[], { post = true, narration = 'Test entry' } = {}) {
  return send('POST', '/journal-entries', { date, narration, lines, post });
}

async function posted(date: string, lines: object[], narration = 'Test entry') {
  const res = await write(date, lines, { narration });
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

// The constraint name a failed statement reports, or null if it did not fail
async function constraintOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof postgres.PostgresError) return error.constraint_name ?? error.message;
    throw error;
  }
}

// Makes a posted entry look like one written before step 15a: no customer on any line. Only with
// the triggers off (session_replication_role = replica), because the entry is posted: the
// immutability trigger would refuse the change, and the party rule would refuse the commit.
async function asBeforeStep15a(entryId: string): Promise<void> {
  await superuserSql((sql) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE journal_lines SET party_id = NULL WHERE entry_id = ${entryId}`;
    }),
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
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;

  // A salesperson: keeps the customer records, but what they owe is the accountant's business
  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  const role = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Field sales', description: '' })).json(),
  );
  expect(
    (
      await send('PUT', '/permission-matrix', {
        roles: [{ id: role.id, version: role.version, permissions: ['sales.customer.manage'] }],
      })
    ).statusCode,
  ).toBe(200);
  const { items: members } = memberPageSchema.parse((await send('GET', '/members')).json());
  const nasrin = members.find((member) => member.email === 'nasrin@rahmangarments.com');
  if (!nasrin) throw new Error('Nasrin is not a member');
  expect(
    (
      await send('PUT', `/members/${nasrin.membershipId}/roles`, {
        roleIds: [role.id],
        version: nasrin.version,
      })
    ).statusCode,
  ).toBe(200);
  seller = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('customer groups', () => {
  it('are added and renamed, each name once in any case', async () => {
    const res = await send('POST', '/customer-groups', { name: 'Export buyer' });
    expect(res.statusCode).toBe(201);
    expect(customerGroupSchema.parse(res.json())).toMatchObject({ customerCount: 0, version: 1 });

    const same = await send('POST', '/customer-groups', { name: 'export BUYER' });
    expect(same.statusCode).toBe(409);
    expect(problemOf(same).fieldErrors).toEqual({ name: ['customer_group_name_taken'] });

    const local = customerGroupSchema.parse(
      (await send('POST', '/customer-groups', { name: 'Local wholesale' })).json(),
    );
    const renamed = await send('PUT', `/customer-groups/${local.id}`, {
      name: 'Local wholesaler',
      version: local.version,
    });
    expect(customerGroupSchema.parse(renamed.json())).toMatchObject({
      name: 'Local wholesaler',
      version: 2,
    });
    const { items } = customerGroupListSchema.parse((await send('GET', '/customer-groups')).json());
    expect(items.map((group) => group.name)).toEqual(['Export buyer', 'Local wholesaler']);
  });
});

describe('customers', () => {
  it('get the next code from the series, and keep a code typed by hand', async () => {
    const first = await addCustomer('Nordic Apparel AB');
    expect(first).toMatchObject({ code: 'C-00001', balance: '0.0000', isSupplier: false });
    const typed = await addCustomer('Baltic Fashion GmbH', { code: 'C-00002' });
    expect(typed.code).toBe('C-00002');
    // The series does not refuse a number someone typed: it skips it
    expect((await addCustomer('Tongi Wholesale')).code).toBe('C-00003');

    const taken = await send('POST', '/customers', customerForm('Copy', { code: 'c-00001' }));
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).fieldErrors).toEqual({ code: ['customer_code_taken'] });
    // An empty code on an edit keeps the one it has
    const kept = await send('PUT', `/customers/${first.id}`, formOf(first, { code: '' }));
    expect(customerSchema.parse(kept.json()).code).toBe('C-00001');
  });

  it('keep one billing address first, the others in order, each with its id', async () => {
    const saved = await addCustomer('Mirpur Fabrics Traders', {
      addresses: [
        {
          id: null,
          kind: 'shipping',
          label: 'Mirpur depot',
          address: 'Section 7, Mirpur, Dhaka',
          phone: '',
        },
        {
          id: null,
          kind: 'billing',
          label: 'Head office',
          address: 'Motijheel C/A, Dhaka 1000',
          phone: '',
        },
        {
          id: null,
          kind: 'shipping',
          label: 'Gazipur depot',
          address: 'Board Bazar, Gazipur',
          phone: '',
        },
      ],
    });
    expect(saved.addresses.map((address) => [address.kind, address.label])).toEqual([
      ['billing', 'Head office'],
      ['shipping', 'Mirpur depot'],
      ['shipping', 'Gazipur depot'],
    ]);
    const [office, mirpur] = saved.addresses;
    if (!office || !mirpur) throw new Error('addresses missing');

    // The depot becomes the billing address and the head office a shipping one, in one save:
    // for a moment the database must never hold two billing addresses
    const res = await send(
      'PUT',
      `/customers/${saved.id}`,
      formOf(saved, {
        addresses: [
          {
            id: office.id,
            kind: 'shipping',
            label: 'Head office',
            address: office.address,
            phone: '',
          },
          {
            id: mirpur.id,
            kind: 'billing',
            label: 'Mirpur depot',
            address: mirpur.address,
            phone: '',
          },
          {
            id: null,
            kind: 'shipping',
            label: 'Savar depot',
            address: 'Hemayetpur, Savar',
            phone: '',
          },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = customerSchema.parse(res.json());
    expect(after.addresses.map((address) => [address.id, address.kind, address.label])).toEqual([
      [mirpur.id, 'billing', 'Mirpur depot'],
      [office.id, 'shipping', 'Head office'],
      [expect.any(String), 'shipping', 'Savar depot'],
    ]);

    const twice = await send(
      'POST',
      '/customers',
      customerForm('Two invoices', {
        addresses: [
          { id: null, kind: 'billing', label: '', address: 'Agrabad, Chattogram', phone: '' },
          { id: null, kind: 'billing', label: '', address: 'Khatunganj, Chattogram', phone: '' },
        ],
      }),
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'addresses.1.kind': ['customer_billing_twice'],
    });
  });

  it("never moves another customer's address: its id only makes a new one", async () => {
    const other = await addCustomer('Narayanganj Knit Hub', {
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'BSCIC, Narayanganj', phone: '' },
      ],
    });
    const theirs = other.addresses[0];
    if (!theirs) throw new Error('no address');
    const mine = await addCustomer('Fatullah Traders', {
      addresses: [
        { id: theirs.id, kind: 'billing', label: '', address: 'Fatullah, Narayanganj', phone: '' },
      ],
    });
    expect(mine.addresses[0]?.id).not.toBe(theirs.id);
    expect((await customer(other.id)).addresses).toEqual(other.addresses);
  });

  it('check the group and the price list; a customer keeps a list archived since', async () => {
    const missing = await send(
      'POST',
      '/customers',
      customerForm('Lost group', { groupId: '01939d1c-0000-7000-8000-000000000000' }),
    );
    expect(problemOf(missing).fieldErrors).toEqual({ groupId: ['customer_group_invalid'] });

    const list = priceListSchema.parse(
      (await send('POST', '/price-lists', { name: 'Wholesale', description: '' })).json(),
    );
    const onList = await addCustomer('Gulistan Garments Wholesale', { priceListId: list.id });
    const archived = await send('POST', `/price-lists/${list.id}/archive`, {
      version: list.version,
    });
    expect(archived.statusCode).toBe(200);

    const kept = await send(
      'PUT',
      `/customers/${onList.id}`,
      formOf(onList, { phone: '01819-445566' }),
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(customerSchema.parse(kept.json()).priceListId).toBe(list.id);
    const fresh = await send(
      'POST',
      '/customers',
      customerForm('New on old list', { priceListId: list.id }),
    );
    expect(problemOf(fresh).fieldErrors).toEqual({ priceListId: ['price_list_invalid'] });
  });

  it('are found by name, code, contact person or phone, a page at a time', async () => {
    const { items: groups } = customerGroupListSchema.parse(
      (await send('GET', '/customer-groups')).json(),
    );
    const local = groups.find((group) => group.name === 'Local wholesaler');
    if (!local) throw new Error('no group');
    await addCustomer('Kawran Bazar Cloth Store', {
      groupId: local.id,
      contactPerson: 'Anwar Hossain',
      phone: '01711-234567',
    });
    await addCustomer('Islampur Fabrics', { groupId: local.id, phone: '01911-987654' });

    async function search(query: string) {
      const page = customerPageSchema.parse((await send('GET', `/customers?${query}`)).json());
      return page.items.map((item) => item.name);
    }
    expect(await search('search=1711')).toEqual(['Kawran Bazar Cloth Store']);
    expect(await search('search=anwar')).toEqual(['Kawran Bazar Cloth Store']);
    expect(await search('search=C-00002')).toEqual(['Baltic Fashion GmbH']);
    // LIKE's wildcards are meant literally: "%" finds nothing here
    expect(await search('search=%25')).toEqual([]);
    expect(await search(`groupId=${local.id}`)).toEqual([
      'Islampur Fabrics',
      'Kawran Bazar Cloth Store',
    ]);

    // Name order, two at a time: every customer once, none skipped
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = customerPageSchema.parse(
        (await send('GET', `/customers?sort=-name&limit=2${query}`)).json(),
      );
      names.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = customerPageSchema.parse((await send('GET', '/customers?limit=100')).json());
    expect(names).toEqual(all.items.map((item) => item.name).reverse());
  });

  it('are archived out of the list, and stay readable', async () => {
    const shop = await addCustomer('Bongshal Tailors');
    const archived = await send('POST', `/customers/${shop.id}/archive`, { version: shop.version });
    expect(customerSchema.parse(archived.json()).archivedAt).not.toBeNull();
    const active = customerPageSchema.parse(
      (await send('GET', '/customers?search=bongshal')).json(),
    );
    expect(active.items).toEqual([]);
    const old = customerPageSchema.parse(
      (await send('GET', '/customers?search=bongshal&status=archived')).json(),
    );
    expect(old.items.map((item) => item.id)).toEqual([shop.id]);
    expect((await customer(shop.id)).name).toBe('Bongshal Tailors');
  });
});

describe('customers in the books', () => {
  let buyer: Customer;
  let gone: Customer;

  beforeAll(async () => {
    buyer = await addCustomer('Aarhus Knitwear ApS', { paymentTermsDays: 90 });
    gone = await addCustomer('Closed Shop');
    gone = customerSchema.parse(
      (await send('POST', `/customers/${gone.id}/archive`, { version: gone.version })).json(),
    );
  });

  it('need a customer on every receivable line, and none on any other line', async () => {
    const res = await write('2026-09-01', [
      debit(RECEIVABLE, '100'),
      credit('4110', '100', buyer.id),
    ]);
    expect(res.statusCode).toBe(409);
    // Every wrong row at once, each with its own code
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_required'],
      'lines.1.partyId': ['journal_party_not_allowed'],
    });

    // Archived, made up: the same answer, like an account that cannot be used
    const invalid = await write('2026-09-01', [
      debit(RECEIVABLE, '100', gone.id),
      debit(RECEIVABLE, '100', '01939d1c-0000-7000-8000-000000000000'),
      credit('4110', '200'),
    ]);
    expect(problemOf(invalid).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_invalid'],
      'lines.1.partyId': ['journal_party_invalid'],
    });
  });

  it('let a draft wait for its customer; posting it needs one', async () => {
    const res = await write('2026-09-02', [debit(RECEIVABLE, '480000'), credit('4110', '480000')], {
      post: false,
      narration: 'Invoice EXP-118, 12,000 pcs polo shirts',
    });
    expect(res.statusCode, res.body).toBe(201);
    const draft = journalEntrySchema.parse(res.json());
    const post = await send('POST', `/journal-entries/${draft.id}/post`, {
      version: draft.version,
    });
    expect(problemOf(post).fieldErrors).toEqual({ 'lines.0.partyId': ['journal_party_required'] });

    const fixed = await send('PUT', `/journal-entries/${draft.id}`, {
      date: '2026-09-02',
      narration: 'Invoice EXP-118, 12,000 pcs polo shirts',
      lines: [debit(RECEIVABLE, '480000', buyer.id), credit('4110', '480000')],
      post: true,
      version: draft.version,
    });
    const entry = journalEntrySchema.parse(fixed.json());
    expect(entry.status).toBe('posted');
    expect(entry.lines.map((line) => line.party)).toEqual([
      { id: buyer.id, code: buyer.code, name: 'Aarhus Knitwear ApS' },
      null,
    ]);
  });

  it('show what a customer owes only to those who may see it', async () => {
    expect((await customer(buyer.id)).balance).toBe('480000.0000');
    const list = customerPageSchema.parse((await send('GET', '/customers?search=aarhus')).json());
    expect(list.items[0]?.balance).toBe('480000.0000');

    // The salesperson reads the customer, without the balance; the statement is refused
    expect((await customer(buyer.id, seller)).balance).toBeNull();
    const theirs = customerPageSchema.parse(
      (await send('GET', '/customers?search=aarhus', undefined, seller)).json(),
    );
    expect(theirs.items[0]?.balance).toBeNull();
    const statement = await send('GET', `/customers/${buyer.id}/statement`, undefined, seller);
    expect(statement.statusCode).toBe(403);
    expect(problemOf(statement).params).toEqual({ permissions: 'sales.customer.balance' });
  });

  it('give a statement like a ledger: opening balance, running balance, pages', async () => {
    // The buyer pays part by TT, and is invoiced again; another customer's invoice is not theirs
    await posted('2026-09-20', [debit('1110', '300000'), credit(RECEIVABLE, '300000', buyer.id)]);
    await posted('2026-10-01', [
      debit(RECEIVABLE, '125000.50', buyer.id),
      credit('4110', '125000.50'),
    ]);
    const other = await addCustomer('Odense Sportswear');
    await posted('2026-09-21', [debit(RECEIVABLE, '99000', other.id), credit('4110', '99000')]);
    // Drafts are not in the books
    await write('2026-09-25', [debit(RECEIVABLE, '7000', buyer.id), credit('4110', '7000')], {
      post: false,
    });

    const first = ledgerPageSchema.parse(
      (await send('GET', `/customers/${buyer.id}/statement?from=2026-09-10&limit=1`)).json(),
    );
    expect(first).toMatchObject({ openingBalance: '480000.0000', closingBalance: '305000.5000' });
    expect(first.items.map((line) => [line.date, line.credit, line.balance])).toEqual([
      ['2026-09-20', '300000.0000', '180000.0000'],
    ]);
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = ledgerPageSchema.parse(
      (
        await send(
          'GET',
          `/customers/${buyer.id}/statement?from=2026-09-10&limit=1&cursor=${first.nextCursor}`,
        )
      ).json(),
    );
    expect(second.items.map((line) => [line.date, line.debit, line.balance])).toEqual([
      ['2026-10-01', '125000.5000', '305000.5000'],
    ]);
    expect(second.nextCursor).toBeNull();

    // The receivable's own ledger shows whose line each one is
    const ledger = ledgerPageSchema.parse(
      (
        await send('GET', `/accounts/${id(RECEIVABLE)}/ledger?from=2026-09-21&to=2026-09-21`)
      ).json(),
    );
    expect(ledger.items.map((line) => line.party?.name)).toEqual(['Odense Sportswear']);
  });

  it('reverse an entry onto the same customer', async () => {
    const entry = await posted('2026-10-02', [
      debit(RECEIVABLE, '5000', buyer.id),
      credit('4110', '5000'),
    ]);
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-03',
    });
    expect(res.statusCode, res.body).toBe(201);
    const reversal = journalEntrySchema.parse(res.json());
    expect(reversal.lines.map((line) => line.party?.id ?? null)).toEqual([buyer.id, null]);
    expect((await customer(buyer.id)).balance).toBe('305000.5000');
  });

  it('reverse an entry from before step 15a, whose receivable line names no customer', async () => {
    const entry = await posted('2026-08-15', [
      debit(RECEIVABLE, '64000', buyer.id),
      credit('4110', '64000'),
    ]);
    await asBeforeStep15a(entry.id);
    // Out of the customer's balance: it names no customer now
    expect((await customer(buyer.id)).balance).toBe('305000.5000');

    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-04',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(journalEntrySchema.parse(res.json()).lines.map((line) => line.party)).toEqual([
      null,
      null,
    ]);
  });

  it('keep a receivable line without a customer out of the books, even written by hand', async () => {
    const failed = await constraintOf(() =>
      superuserSql((sql) =>
        sql.begin(async (tx) => {
          const [entry] = await tx<{ id: string }[]>`
            INSERT INTO journal_entries (id, tenant_id, date, status)
            SELECT gen_random_uuid(), id, '2026-10-05', 'draft' FROM tenants
             WHERE slug = 'rahman-garments'
            RETURNING id`;
          if (!entry) throw new Error('no entry');
          await tx`
            INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_id, debit, credit)
            SELECT gen_random_uuid(), e.tenant_id, e.id, v.line_no, v.account_id::uuid, v.debit, v.credit
              FROM journal_entries e,
                   (VALUES (1, ${id(RECEIVABLE)}, 100, 0), (2, ${id('4110')}, 0, 100))
                     AS v(line_no, account_id, debit, credit)
             WHERE e.id = ${entry.id}`;
          await tx`
            UPDATE journal_entries SET status = 'posted', number = 'JV-HAND-2', posted_at = now()
             WHERE id = ${entry.id}`;
        }),
      ),
    );
    expect(failed).toBe('journal_lines_party_check');
  });

  it('delete a customer nothing uses, and refuse one with entries', async () => {
    const mistake = await addCustomer('Typed by mistake');
    const removed = await send(
      'DELETE',
      `/customers/${mistake.id}?version=${String(mistake.version)}`,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/customers/${mistake.id}`)).statusCode).toBe(404);

    const current = await customer(buyer.id);
    const inUse = await send('DELETE', `/customers/${buyer.id}?version=${String(current.version)}`);
    expect(inUse.statusCode).toBe(409);
    expect(problemOf(inUse).code).toBe('customer_in_use');
  });

  it('keep a group while any customer is in it, archived ones too', async () => {
    const group = customerGroupSchema.parse(
      (await send('POST', '/customer-groups', { name: 'Closed accounts' })).json(),
    );
    const shop = await send('PUT', `/customers/${gone.id}`, formOf(gone, { groupId: group.id }));
    expect(shop.statusCode, shop.body).toBe(200);
    const { items } = customerGroupListSchema.parse((await send('GET', '/customer-groups')).json());
    expect(items.find((item) => item.id === group.id)?.customerCount).toBe(1);

    const inUse = await send('DELETE', `/customer-groups/${group.id}?version=1`);
    expect(inUse.statusCode).toBe(409);
    expect(problemOf(inUse).code).toBe('customer_group_in_use');

    const moved = customerSchema.parse(shop.json());
    const out = await send('PUT', `/customers/${gone.id}`, formOf(moved, { groupId: '' }));
    expect(out.statusCode).toBe(200);
    expect((await send('DELETE', `/customer-groups/${group.id}?version=1`)).statusCode).toBe(204);
  });
});

describe('opening balances by customer', () => {
  let dhaka: Customer;
  let chattogram: Customer;

  beforeAll(async () => {
    dhaka = await addCustomer('Dhaka Denim Wholesale');
    chattogram = await addCustomer('Chattogram Export House');
  });

  async function current() {
    return openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
  }

  it('split the receivable into one line per customer', async () => {
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '85000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '1200000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: chattogram.id, debit: '640000.50', credit: '' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.lines.map((line) => [line.party?.name ?? null, line.debit])).toEqual([
      [null, '85000.0000'],
      ['Dhaka Denim Wholesale', '1200000.0000'],
      ['Chattogram Export House', '640000.5000'],
    ]);
    expect((await customer(dhaka.id)).balance).toBe('1200000.0000');
    expect((await customer(chattogram.id)).balance).toBe('640000.5000');
  });

  it('put each customer error under the row it came from', async () => {
    const before = await current();
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: before.entry?.id ?? null,
      lines: [
        // An empty row is dropped before the check: the errors must still name rows 1 and 2
        { accountId: id('1110'), partyId: '', debit: '', credit: '' },
        { accountId: id(RECEIVABLE), partyId: '', debit: '5000', credit: '' },
        { accountId: id('1110'), partyId: dhaka.id, debit: '', credit: '5000' },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.1.partyId': ['journal_party_required'],
      'lines.2.partyId': ['journal_party_not_allowed'],
    });

    const twice = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: before.entry?.id ?? null,
      lines: [
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '100', credit: '' },
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '200', credit: '' },
      ],
    });
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({ 'lines.1.debit': ['opening_balance_twice'] });
  });

  it('replace opening balances saved before step 15a, which named no customer', async () => {
    const before = await current();
    if (before.entry === null) throw new Error('no opening balances');
    await asBeforeStep15a(before.entry.id);
    // The page shows the old receivable lines without a customer, for the person to split
    const old = await current();
    expect(old.lines.map((line) => line.party)).toEqual([null, null, null]);

    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: old.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '85000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '1100000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: chattogram.id, debit: '740000.50', credit: '' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    // The old entry was reversed without a customer, the new one names them
    const reversed = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${before.entry.id}`)).json(),
    );
    expect(reversed.reversedBy).not.toBeNull();
    expect((await customer(dhaka.id)).balance).toBe('1100000.0000');
    expect((await customer(chattogram.id)).balance).toBe('740000.5000');
  });
});
```

The setup at the top is the journal test's, with one change: Nasrin's role has `sales.customer.manage` only. She
keeps the customer records but may not see what customers owe, which is exactly the line `BalanceAccess` draws.

- **`asBeforeStep15a()`** makes a posted entry look like one from before this step: its lines name no customer.
  There is no API for that, on purpose, and even the superuser is stopped by two triggers: the posted entry is
  immutable (step 10), and the party rule refuses the commit (0026). `SET LOCAL session_replication_role =
  replica` turns triggers off for that one transaction. It is what a replication tool uses to copy rows
  that were already checked on the other server. Here it rebuilds old data that was correct when it was written.
- **The codes.** The first customer gets `C-00001`. A code typed by hand (`C-00002`) is skipped by the series, not
  refused. A code taken in another case (`c-00001`) is refused, because the index is on `lower(code)`. An empty
  code on an edit keeps the old one.
- **The billing swap** is the case the order in `saveAddresses()` is for: the depot becomes the billing address
  and the head office a shipping one, in one save. If the new billing address were written first, there would be
  two billing addresses for a moment, and the partial unique index checks every row. Both ids stay; the removed
  address goes and the new one gets an id.
- **Another customer's address id** makes a new address. Moving it would take the address away from the other
  customer, and a delivery (15b) that points at it would suddenly belong to someone else.
- **The archived price list is kept** when the customer is saved unchanged. A new customer cannot pick it.
- **The search** finds by phone digits (`1711`), by contact person and by code. `%25` is a `%` in the URL: the
  person's `%` is matched literally (`containsPattern`), so it finds nothing here. The paging loop walks the
  whole list two at a time in `-name` order and compares it with the list in `name` order, reversed: every
  customer appears once, none is skipped.
- **The party rule answers every wrong row at once**: a receivable line with no customer and a sales line with
  one, in the same entry, give two errors. An archived customer and a made-up id give the same answer
  (`journal_party_invalid`), like an account that cannot be used. This test found the second bug.
- **A draft may wait for its customer**; posting it may not. The entry then shows each line's customer as
  `{ id, code, name }`, so the entry page needs no customer list.
- **The balance and the statement.** The owner sees the balance in the detail and in the list. Nasrin sees
  `null` in both, and the statement answers 403 with the permission's name.
- **The statement** is checked like the ledger in the journal test: an opening balance before `from`, a running
  balance that goes on across pages, drafts left out, and another customer's line left out. The receivable's own
  ledger shows whose line it is.
- **The reversal copies the customer**, so the customer's balance goes back to what it was.
- **An entry from before step 15a can be reversed.** Its receivable line has no customer, and the reversal copies
  that. Without the reversal exception in `post()` (and in 0026), the old wrong entry could never be undone. We
  removed that exception on purpose: this test and the opening-balances one below then fail.
- **The database refuses a receivable line without a customer, even written by hand**: the same hand-written entry
  as in the journal test, but balanced, so only the party rule can refuse it.
- **A customer with entries is not deleted** (`customer_in_use`); the foreign key is the check.
- **A group keeps its customers, archived ones too.** The count is 1 for a group that holds only an archived
  customer, and the delete is refused until the customer is moved out. This test found the first bug: the count
  was 0.
- **Opening balances: the errors land under the page's rows.** The first row is empty and is dropped before the
  check, so the receivable line without a customer is the first line the service checks. The error must still say
  `lines.1`, the row the person sees. That is the index mapping in `OpeningBalancesService`.
- **Opening balances from before step 15a** show their receivable line without a customer, and can be saved again
  split by customer. The old entry is reversed (without a customer, like it was), and the new one names them.

### `sales/price-lists.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type PriceList,
  priceListItemPageSchema,
  priceListListSchema,
  priceListSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  setupSchema,
  type Unit,
  unitListSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let units: Unit[];
// Sold by the piece, the 6-pack and the 24-bottle case
let juice: Product;
// Two scents, by the piece and the 72-piece case
let soap: Product;
let dealer: PriceList;

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

function variantOf(product: Product, index = 0): string {
  const found = product.variants[index];
  if (!found) throw new Error(`no variant ${String(index)} of ${product.name}`);
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

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  const res = await send('POST', '/products', productForm(name, extra));
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

async function list(): Promise<PriceList> {
  return priceListSchema.parse((await send('GET', `/price-lists/${dealer.id}`)).json());
}

async function items(query = '') {
  const res = await send('GET', `/price-lists/${dealer.id}/items?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return priceListItemPageSchema.parse(res.json());
}

function setPrices(changes: { variantId: string; unitId: string; price: string }[]) {
  return send('PUT', `/price-lists/${dealer.id}/items`, { changes });
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
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  juice = await addProduct('Mango juice 250 ml', {
    variants: [variant([], '25')],
    units: [
      { unitId: unitId('pack'), factor: '6', barcode: '' },
      { unitId: unitId('case'), factor: '24', barcode: '' },
    ],
  });
  soap = await addProduct('Beauty soap 100 g', {
    options: [{ name: 'Scent', values: ['Lemon', 'Rose'] }],
    variants: [variant(['Lemon'], '45'), variant(['Rose'], '45')],
    units: [{ unitId: unitId('case'), factor: '72', barcode: '' }],
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('price lists', () => {
  it('are added and renamed, each name once in any case', async () => {
    const res = await send('POST', '/price-lists', { name: 'Dealer', description: '' });
    expect(res.statusCode).toBe(201);
    dealer = priceListSchema.parse(res.json());
    expect(dealer).toMatchObject({ itemCount: 0, customerCount: 0, description: null });

    const same = await send('POST', '/price-lists', { name: 'DEALER', description: '' });
    expect(same.statusCode).toBe(409);
    expect(problemOf(same).fieldErrors).toEqual({ name: ['price_list_name_taken'] });

    const stale = await send('PUT', `/price-lists/${dealer.id}`, {
      name: 'Dealer',
      description: 'Upazila dealers',
      version: dealer.version + 1,
    });
    expect(problemOf(stale).code).toBe('version_conflict');
    const renamed = await send('PUT', `/price-lists/${dealer.id}`, {
      name: 'Dealer',
      description: 'Upazila dealers',
      version: dealer.version,
    });
    dealer = priceListSchema.parse(renamed.json());
    expect(dealer).toMatchObject({ description: 'Upazila dealers', version: 2 });
  });

  it('take prices per item and unit, a batch at a time', async () => {
    const res = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '22' },
      { variantId: variantOf(juice), unitId: unitId('case'), price: '504' },
      { variantId: variantOf(soap, 0), unitId: unitId('pcs'), price: '38' },
      { variantId: variantOf(soap, 1), unitId: unitId('pcs'), price: '38' },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(priceListSchema.parse(res.json()).itemCount).toBe(4);

    // By product name, three at a time: every price once, the soap first
    const first = await items('limit=3');
    expect(first.items.map((item) => item.productName)).toEqual([
      'Beauty soap 100 g',
      'Beauty soap 100 g',
      'Mango juice 250 ml',
    ]);
    expect(first.items[0]).toMatchObject({ optionValues: ['Lemon'], price: '38.0000' });
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = await items(`limit=3&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const keys = [...first.items, ...second.items].map(
      (item) => `${item.variantId}:${item.unitId}`,
    );
    expect(new Set(keys).size).toBe(4);

    expect((await items('search=mango')).items).toHaveLength(2);
    const lemon = soap.variants[0];
    expect((await items(`search=${lemon?.sku ?? ''}`)).items.map((item) => item.variantId)).toEqual(
      [variantOf(soap, 0)],
    );
  });

  it('change a price that is there, and take one out with an empty price', async () => {
    const res = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('case'), price: '500' },
      { variantId: variantOf(soap, 1), unitId: unitId('pcs'), price: '' },
    ]);
    expect(priceListSchema.parse(res.json()).itemCount).toBe(3);
    const juicePrices = (await items('search=mango')).items;
    expect(juicePrices.find((item) => item.unitId === unitId('case'))?.price).toBe('500.0000');

    // One audit row for the batch, with counts, not one per price
    const { items: log } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=price_list&entityId=${dealer.id}`)).json(),
    );
    expect(log[0]).toMatchObject({
      action: 'price_list.prices_changed',
      changes: { set: { from: null, to: 1 }, removed: { from: null, to: 1 } },
    });
  });

  it('refuse the whole batch for a unit an item is not sold in, or an unknown item', async () => {
    const res = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '21' },
      // The soap is never sold by the 6-pack
      { variantId: variantOf(soap, 0), unitId: unitId('pack'), price: '220' },
      { variantId: '01939d1c-0000-7000-8000-000000000000', unitId: unitId('pcs'), price: '10' },
    ]);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'changes.1.unitId': ['price_list_unit_invalid'],
      'changes.2.variantId': ['product_variant_unknown'],
    });
    // All or nothing: the juice's good price was not saved either
    const juicePrices = (await items('search=mango')).items;
    expect(juicePrices.find((item) => item.unitId === unitId('pcs'))?.price).toBe('22.0000');

    const twice = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '21' },
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '20' },
    ]);
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({ 'changes.1.price': ['price_list_item_twice'] });
  });

  it('take no prices while archived, and keep them for the restore', async () => {
    const current = await list();
    const archived = priceListSchema.parse(
      (
        await send('POST', `/price-lists/${dealer.id}/archive`, { version: current.version })
      ).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    const refused = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '21' },
    ]);
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('price_list_invalid');
    expect((await items()).items).toHaveLength(3);

    const restored = await send('POST', `/price-lists/${dealer.id}/restore`, {
      version: archived.version,
    });
    expect(priceListSchema.parse(restored.json())).toMatchObject({
      archivedAt: null,
      itemCount: 3,
    });
  });

  it('lose the price of a pack the product is no longer sold in', async () => {
    const current = productSchema.parse((await send('GET', `/products/${juice.id}`)).json());
    // The case is dropped from the product: its dealer price could never be used again
    const res = await send('PUT', `/products/${juice.id}`, {
      ...productForm(current.name, {
        code: current.code,
        variants: current.variants.map((saved) => ({
          id: saved.id,
          sku: saved.sku,
          optionValues: saved.optionValues,
          barcode: saved.barcode ?? '',
          salePrice: saved.salePrice ?? '',
          archived: false,
        })),
        units: [{ unitId: unitId('pack'), factor: '6', barcode: '' }],
      }),
      version: current.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const juicePrices = (await items('search=mango')).items;
    expect(juicePrices.map((item) => item.unitId)).toEqual([unitId('pcs')]);
    expect((await list()).itemCount).toBe(2);
  });

  it('count the customers that use them, archived ones too', async () => {
    const res = await send('POST', '/customers', {
      code: '',
      name: 'Bhairab Bazar Traders',
      groupId: '',
      contactPerson: '',
      phone: '',
      email: '',
      bin: '',
      paymentTermsDays: 15,
      creditLimit: '200000',
      priceListId: dealer.id,
      notes: '',
      addresses: [],
    });
    expect(res.statusCode, res.body).toBe(201);
    const { items: all } = priceListListSchema.parse((await send('GET', '/price-lists')).json());
    expect(all.find((found) => found.id === dealer.id)?.customerCount).toBe(1);
  });
});
```

A distribution workspace: the juice is sold by the bottle, the 6-pack and the 24-bottle case, and the soap has two
scents and a 72-piece case. A pharma workspace would need the generic name on every product (a required custom
field), which has nothing to do with prices.

- **Prices per variant and unit, in one batch.** The items page is ordered by the product's name, so the soap
  comes first, and its first variant is the Lemon one (variant ids are UUIDv7, so they sort in the order they were
  made). The second page has the last row and no cursor. The four keys are all different: no row is shown twice.
- **The search by SKU** finds the one variant.
- **An existing price changes; an empty price takes the row out.** The audit row has the counts of the batch, not
  one row per price.
- **The whole batch is refused** when one row is wrong: the soap is never sold by the 6-pack, and a made-up variant
  is unknown. Each error is under its own row. The juice's good price in the same batch was not saved either: the
  check runs before the first write.
- **The same item and unit twice** is the contract's error (400), under the second row.
- **An archived list takes no prices**, but its prices stay readable and come back with the restore.
- **A pack the product no longer has loses its price.** The product form drops the case. The case price is gone,
  and the bottle price stays. This is the delete in `ProductsService.update()`.
- **`customerCount`** is 1 once a customer uses the list. This is the second count the subquery bug made 0.

### `sales/sales.tenant-leak.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Customer,
  type CustomerGroup,
  customerGroupListSchema,
  customerGroupSchema,
  customerPageSchema,
  customerSchema,
  type PriceList,
  priceListListSchema,
  priceListSchema,
  type Product,
  productSchema,
  problemSchema,
  setupSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two workspaces: A must never see, use or change B's customers, customer groups, price lists or
// VAT rates, nor put B's customer on a line of its own books. Every answer is 404, or the same
// "pick one from the list" as for an id that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let accountsOfA: Account[];
let groupOfB: CustomerGroup;
let customerOfB: Customer;
let listOfB: PriceList;
let productOfB: Product;
let rateOfB: TaxRate;

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

async function setUp(who: SignedIn, industry: 'garments' | 'distribution'): Promise<void> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
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

function customerForm(name: string, extra: object = {}) {
  return {
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
  };
}

function productForm(name: string, units: Unit[], extra: object = {}) {
  return {
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
    ...extra,
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
  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'distribution')]);
  unitsOfA = unitListSchema.parse((await as(tenantA, 'GET', '/units')).json()).items;
  accountsOfA = accountListSchema.parse((await as(tenantA, 'GET', '/accounts')).json()).items;
  const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;

  // B's data: a group, a price list with a price, a customer on both, and an invoice in the books
  groupOfB = customerGroupSchema.parse(
    (await as(tenantB, 'POST', '/customer-groups', { name: 'Upazila dealer' })).json(),
  );
  listOfB = priceListSchema.parse(
    (await as(tenantB, 'POST', '/price-lists', { name: 'Dealer', description: '' })).json(),
  );
  const product = await as(
    tenantB,
    'POST',
    '/products',
    productForm('Mango juice 250 ml', unitsOfB),
  );
  expect(product.statusCode, product.body).toBe(201);
  productOfB = productSchema.parse(product.json());
  const priced = await as(tenantB, 'PUT', `/price-lists/${listOfB.id}/items`, {
    changes: [{ variantId: productOfB.variants[0]?.id, unitId: pcsOf(unitsOfB), price: '22' }],
  });
  expect(priced.statusCode, priced.body).toBe(200);
  const customer = await as(
    tenantB,
    'POST',
    '/customers',
    customerForm('Bhairab Bazar Traders', {
      groupId: groupOfB.id,
      priceListId: listOfB.id,
      contactPerson: 'Rafiqul Islam',
      phone: '01712-334455',
    }),
  );
  expect(customer.statusCode, customer.body).toBe(201);
  customerOfB = customerSchema.parse(customer.json());
  const accountsOfB = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json()).items;
  const receivableOfB = accountsOfB.find((account) => account.purpose === 'accounts_receivable');
  const salesOfB = accountsOfB.find((account) => account.purpose === 'sales');
  const invoice = await as(tenantB, 'POST', '/journal-entries', {
    date: '2026-09-10',
    narration: 'Invoice to Bhairab Bazar Traders',
    post: true,
    lines: [
      {
        accountId: receivableOfB?.id,
        branchId: '',
        partyId: customerOfB.id,
        description: '',
        debit: '13200',
        credit: '',
      },
      {
        accountId: salesOfB?.id,
        branchId: '',
        partyId: '',
        description: '',
        debit: '',
        credit: '13200',
      },
    ],
  });
  expect(invoice.statusCode, invoice.body).toBe(201);
  const rates = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  const zero = rates.find((rate) => rate.name === 'Zero-rated');
  if (!zero) throw new Error('B has no rates');
  rateOfB = zero;
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('customer isolation over HTTP', () => {
  it("never lists, finds or reads tenant B's customers, groups, price lists or VAT rates", async () => {
    for (const search of ['bhairab', customerOfB.code, '1712', 'rafiqul']) {
      const page = customerPageSchema.parse(
        (await as(tenantA, 'GET', `/customers?search=${search}`)).json(),
      );
      expect(page.items, search).toEqual([]);
    }
    expect((await as(tenantA, 'GET', `/customers/${customerOfB.id}`)).statusCode).toBe(404);
    expect((await as(tenantA, 'GET', `/customers/${customerOfB.id}/statement`)).statusCode).toBe(
      404,
    );
    const groups = customerGroupListSchema.parse(
      (await as(tenantA, 'GET', '/customer-groups')).json(),
    );
    expect(groups.items).toEqual([]);
    const lists = priceListListSchema.parse((await as(tenantA, 'GET', '/price-lists')).json());
    expect(lists.items).toEqual([]);
    expect((await as(tenantA, 'GET', `/price-lists/${listOfB.id}`)).statusCode).toBe(404);
    expect((await as(tenantA, 'GET', `/price-lists/${listOfB.id}/items`)).statusCode).toBe(404);
    // A has its own six rates; none of them is B's
    const rates = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json());
    expect(rates.items).toHaveLength(6);
    expect(rates.items.map((rate) => rate.id)).not.toContain(rateOfB.id);
  });

  it('cannot change, archive or delete any of them', async () => {
    const attempts = [
      as(tenantA, 'PUT', `/customers/${customerOfB.id}`, {
        ...customerForm('Taken over'),
        version: customerOfB.version,
      }),
      as(tenantA, 'POST', `/customers/${customerOfB.id}/archive`, { version: 1 }),
      as(tenantA, 'POST', `/customers/${customerOfB.id}/restore`, { version: 1 }),
      as(tenantA, 'DELETE', `/customers/${customerOfB.id}?version=1`),
      as(tenantA, 'PUT', `/customer-groups/${groupOfB.id}`, { name: 'Taken over', version: 1 }),
      as(tenantA, 'DELETE', `/customer-groups/${groupOfB.id}?version=1`),
      as(tenantA, 'PUT', `/price-lists/${listOfB.id}`, {
        name: 'Taken over',
        description: '',
        version: listOfB.version,
      }),
      as(tenantA, 'POST', `/price-lists/${listOfB.id}/archive`, { version: listOfB.version }),
      as(tenantA, 'PUT', `/price-lists/${listOfB.id}/items`, {
        changes: [
          { variantId: productOfB.variants[0]?.id, unitId: productOfB.baseUnitId, price: '1' },
        ],
      }),
      as(tenantA, 'PUT', `/tax-rates/${rateOfB.id}`, {
        name: 'Taken over',
        kind: 'standard',
        rate: '15',
        isDefault: true,
        version: rateOfB.version,
      }),
      as(tenantA, 'POST', `/tax-rates/${rateOfB.id}/archive`, { version: rateOfB.version }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);

    const still = customerSchema.parse(
      (await as(tenantB, 'GET', `/customers/${customerOfB.id}`)).json(),
    );
    expect(still).toMatchObject({ name: 'Bhairab Bazar Traders', version: 1, archivedAt: null });
    expect(still.balance).toBe('13200.0000');
    const list = priceListSchema.parse(
      (await as(tenantB, 'GET', `/price-lists/${listOfB.id}`)).json(),
    );
    expect(list).toMatchObject({ name: 'Dealer', itemCount: 1, archivedAt: null });
  });

  it("cannot point its own records at B's group, price list, item or VAT rate", async () => {
    const withGroup = await as(
      tenantA,
      'POST',
      '/customers',
      customerForm('Ashulia Knit Buyers', { groupId: groupOfB.id }),
    );
    expect(problemOf(withGroup).fieldErrors).toEqual({ groupId: ['customer_group_invalid'] });
    const withList = await as(
      tenantA,
      'POST',
      '/customers',
      customerForm('Ashulia Knit Buyers', { priceListId: listOfB.id }),
    );
    expect(problemOf(withList).fieldErrors).toEqual({ priceListId: ['price_list_invalid'] });

    const own = priceListSchema.parse(
      (await as(tenantA, 'POST', '/price-lists', { name: 'Buying house', description: '' })).json(),
    );
    const borrowed = await as(tenantA, 'PUT', `/price-lists/${own.id}/items`, {
      changes: [{ variantId: productOfB.variants[0]?.id, unitId: pcsOf(unitsOfA), price: '1' }],
    });
    expect(problemOf(borrowed).fieldErrors).toEqual({
      'changes.0.variantId': ['product_variant_unknown'],
    });

    const product = await as(
      tenantA,
      'POST',
      '/products',
      productForm('Knit polo shirt', unitsOfA, { taxRateId: rateOfB.id }),
    );
    expect(product.statusCode).toBe(400);
    expect(problemOf(product).fieldErrors).toEqual({ taxRateId: ['tax_rate_invalid'] });
  });

  it("cannot put B's customer on a line of its own books", async () => {
    const entry = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-09-11',
      narration: 'Borrowed customer',
      post: true,
      lines: [
        {
          accountId: accountOfA('1140'),
          branchId: '',
          partyId: customerOfB.id,
          description: '',
          debit: '100',
          credit: '',
        },
        {
          accountId: accountOfA('4110'),
          branchId: '',
          partyId: '',
          description: '',
          debit: '',
          credit: '100',
        },
      ],
    });
    expect(problemOf(entry).fieldErrors).toEqual({ 'lines.0.partyId': ['journal_party_invalid'] });

    const opening = await as(tenantA, 'PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: accountOfA('1140'), partyId: customerOfB.id, debit: '100', credit: '' }],
    });
    expect(problemOf(opening).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_invalid'],
    });
  });

  it("numbers its customers on its own: B's codes take nothing from A", async () => {
    const res = await as(tenantA, 'POST', '/customers', customerForm('Nordic Apparel AB'));
    expect(res.statusCode, res.body).toBe(201);
    expect(customerSchema.parse(res.json()).code).toBe(customerOfB.code);
  });
});
```

The same shape as the products' tenant-leak test. B has one of everything: a group, a price list with a price, a
customer on both, an invoice in its books, and its own VAT rates. A tries everything it can.

- **Nothing of B's is listed, found or read.** The search tries B's name, code, phone digits and contact person.
  The statement of B's customer is a 404, not a 403, and not an empty statement.
- **A has its own six rates**, none of them B's: the rates are per workspace, not one shared list.
- **Every change to B's records is a 404**, and B's customer and list are unchanged afterwards. B's customer's
  balance is still the invoice's amount.
- **A cannot point at B's records.** B's group and price list get the same answer as a made-up id. B's variant in
  A's price list is `product_variant_unknown`. B's rate on A's product is `tax_rate_invalid`.
- **B's customer cannot go on a line of A's books**, neither in an entry nor in the opening balances. Without the
  `tenant_id` in `checkParties()`, RLS would still hide the row, but the composite foreign key
  (`journal_lines_party_fk`, on `tenant_id` and `party_id`) is what makes this impossible even for a bug.
- **The codes are per workspace.** A's first customer gets the same code as B's.

The RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`) needs no change: it finds the six new tables by
their `tenant_id` column and checks that each has row-level security turned on and forced, with a policy.

> **What we checked in this part.** The API type-checks and ESLint and Prettier are clean. All API tests pass:
> 7 unit test files (76 tests) and all 36 integration and tenant-leak files, run with three workers. Two tests
> were also checked by breaking the code on purpose. Without the advisory lock, the race test gets `[201, 500]`.
> Without the reversal exception, the two "before step 15a" tests fail. The two bugs these tests found are fixed
> in the 15a.3 code above.

## 15a.5 — `packages/i18n` and `packages/ui`: the words, and a search box for customers

The pages of 15a.6 need their words in English and Bangla, and one new control: a select box that searches the
customers on the server. Both come before the app, because the app cannot type-check without them.

### `locales/en.ts`

```diff
@@ -68,6 +68,10 @@ export const en = {
     warehouses: 'Warehouses',
     valuation: 'Valuation',
     revaluations: 'Revaluations',
+    sales: 'Sales',
+    customers: 'Customers',
+    customerGroups: 'Customer groups',
+    priceLists: 'Price lists',
   },
   auth: {
     workspace: 'Workspace',
@@ -180,6 +184,11 @@ export const en = {
     stockAccountsSaved: 'Stock accounts saved',
     stockAccountsMissing:
       'Some stock accounts are not chosen yet. Stock documents that need them cannot be posted.',
+    salesTitle: 'Sales',
+    salesSubtitle: 'How prices and VAT work when you sell',
+    pricesIncludeVat: 'Prices include VAT',
+    pricesIncludeVatHint:
+      'On: the sale prices and price lists you type already hold the VAT, like a printed MRP. Off: VAT is added on top of them.',
     logoSaved: 'Logo updated',
     logoRemoved: 'Logo removed',
     saved: 'Settings saved',
@@ -196,7 +205,7 @@ export const en = {
       next: 'Next number',
     },
     documents: {
-      sales: { invoice: 'Sales invoice', order: 'Sales order' },
+      sales: { invoice: 'Sales invoice', order: 'Sales order', customer: 'Customer code' },
       purchase: { order: 'Purchase order', bill: 'Supplier bill' },
       inventory: {
         receipt: 'Goods receipt (GRN)',
@@ -376,6 +385,9 @@ export const en = {
     account: 'Account',
     accountPlaceholder: 'Pick an account',
     lineDescription: 'Description',
+    customer: 'Customer',
+    customerPlaceholder: 'Pick a customer',
+    noCustomer: 'No customer',
     branch: 'Branch',
     noBranch: 'No branch',
     debit: 'Debit',
@@ -449,6 +461,9 @@ export const en = {
     // A balance with its side: "৳1,200 Dr"
     debitBalance: '{{amount}} Dr',
     creditBalance: '{{amount}} Cr',
+    noCustomer: 'No customer',
+    noCustomerHint:
+      'Posted before customers were kept. Reverse the entry and post it again with a customer.',
     pickTitle: 'Pick an account',
     pickBody: 'Choose an account above to see its entries, like Cash in hand or Office rent.',
     emptyTitle: 'No entries in these dates',
@@ -466,6 +481,14 @@ export const en = {
     credit: 'Credit',
     total: 'Total',
     difference: 'Opening balance equity',
+    customer: 'Customer',
+    customerPlaceholder: 'Pick a customer',
+    customerLine: '{{account}}: line {{number}}',
+    addCustomer: 'Add a customer',
+    removeCustomer: 'Remove line {{number}} of {{account}}',
+    receivableHint: 'Enter what each customer owed, one line each. The account holds their total.',
+    noCustomerHint:
+      'Saved before customers were kept. Pick the customer, or split the amount over several lines.',
     differenceHint: 'What the balances are out by goes here. It reads zero once everything is in.',
     save: 'Post opening balances',
     saved: 'Opening balances posted as {{number}}',
@@ -648,6 +671,11 @@ export const en = {
       skuHint: 'Leave empty to make one from the code.',
       barcode: 'Barcode',
       price: 'Sale price per {{unit}}',
+      priceWithVat: 'Includes VAT',
+      priceWithoutVat: 'Before VAT',
+      taxRate: 'VAT rate',
+      defaultTaxRate: 'Workspace default: {{name}}',
+      taxRateHint: 'Keep the default unless this product is taxed at another rate, or is exempt.',
       tracking: 'Tracking',
       hasExpiry: 'Batches have an expiry date',
     },
@@ -1260,6 +1288,267 @@ export const en = {
       'Give the stock that came in before costs were kept its real value, or put a wrong cost right.',
     loadFailed: "Couldn't load the revaluations. Refresh the page to try again.",
   },
+  taxRates: {
+    title: 'VAT rates',
+    subtitle:
+      'What your products and sales lines charge. A product without its own rate uses the default.',
+    add: 'Add rate',
+    columns: {
+      name: 'Name',
+      kind: 'Kind',
+      rate: 'Rate',
+    },
+    kinds: {
+      standard: 'Standard',
+      reduced: 'Reduced',
+      zero_rated: 'Zero-rated',
+      exempt: 'Exempt',
+    },
+    kindHints: {
+      standard: 'The usual 15%.',
+      reduced: 'A lower rate the NBR sets for some goods, like 10%, 7.5% or 5%.',
+      zero_rated: 'Taxed at 0%, like exports. You can still claim the VAT you paid on purchases.',
+      exempt: 'Outside VAT. You cannot claim the VAT you paid on purchases.',
+    },
+    percent: '{{rate}}%',
+    default: 'Default',
+    archived: 'Archived',
+    newTitle: 'Add VAT rate',
+    editTitle: 'Edit {{name}}',
+    name: 'Name',
+    namePlaceholder: 'VAT 7.5%',
+    kind: 'Kind',
+    rate: 'Rate',
+    rateHint: 'A percentage, like 15 or 7.5',
+    makeDefault: 'Use it for products without their own rate',
+    defaultLocked: 'This is the default. To change it, make another rate the default.',
+    archive: 'Archive',
+    restore: 'Restore',
+    created: '{{name}} added',
+    updated: '{{name}} saved',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    emptyTitle: 'No VAT rates yet',
+    emptyBody: 'Add the standard 15% first. Every product uses it until you give one another rate.',
+    loadFailed: "Couldn't load the VAT rates. Refresh the page to try again.",
+  },
+  customers: {
+    title: 'Customers',
+    description: 'Dealers, shops and buyers you sell to, and what they owe',
+    add: 'Add customer',
+    searchLabel: 'Search customers',
+    searchPlaceholder: 'Name, code, contact person or phone',
+    group: 'Group',
+    allGroups: 'All groups',
+    show: 'Show',
+    statuses: { active: 'Active', archived: 'Archived' },
+    columns: {
+      customer: 'Customer',
+      phone: 'Phone',
+      group: 'Group',
+      terms: 'Terms',
+      creditLimit: 'Credit limit',
+      balance: 'Balance',
+    },
+    termsDays_one: '{{count}} day',
+    termsDays_other: '{{count}} days',
+    onReceipt: 'On receipt',
+    noLimit: 'No limit',
+    cashOnly: 'Cash only',
+    emptyTitle: 'No customers yet',
+    emptyBody:
+      'Add your first customer, like a dealer in Chattogram or a pharmacy chain. What they owe shows here once their entries are posted.',
+    noMatchTitle: 'No customer matches "{{query}}"',
+    noMatchBody: 'Check the spelling, or search by code or phone number.',
+    archivedEmptyTitle: 'No archived customers',
+    archivedEmptyBody:
+      'A customer you archive shows up here. Their history and what they owe stay.',
+    loadFailed: "Couldn't load the customers. Refresh the page to try again.",
+    readOnly:
+      'You can see the customers. To change them, ask for the sales.customer.manage permission.',
+    back: 'Customers',
+    newTitle: 'New customer',
+    editTitle: 'Edit {{code}}',
+    notFound: "This customer doesn't exist, or it was deleted.",
+    sections: {
+      basics: 'Basics',
+      terms: 'Sales terms',
+      termsHint: 'Used on every sale to this customer.',
+      addresses: 'Addresses',
+      addressesHint:
+        'One billing address for the invoice, and any shipping addresses for deliveries. The first shipping address is the default.',
+    },
+    fields: {
+      code: 'Code',
+      codeHint: 'Leave empty for the next number, like C-00042.',
+      name: 'Name',
+      namePlaceholder: 'Rahman Traders',
+      group: 'Group',
+      noGroup: 'No group',
+      contactPerson: 'Contact person',
+      contactPersonPlaceholder: 'Md. Kamal Hossain',
+      phone: 'Phone',
+      email: 'Email',
+      bin: 'BIN',
+      binHint: "The customer's 13-digit VAT registration number, printed on Mushak 6.3",
+      paymentTerms: 'Payment terms',
+      paymentTermsHint: 'Days from the invoice to its due date. 0 = due on receipt.',
+      days: 'days',
+      creditLimit: 'Credit limit',
+      creditLimitHint: 'The most they may owe. Leave it empty for no limit; 0 means cash only.',
+      priceList: 'Price list',
+      noPriceList: "The products' own prices",
+      notes: 'Notes',
+      notesPlaceholder: 'Takes deliveries before 11 am only. Pays by cheque on the 10th.',
+    },
+    addresses: {
+      number: 'Address {{number}}',
+      kind: 'Kind',
+      kinds: { billing: 'Billing', shipping: 'Shipping' },
+      label: 'Label',
+      labelPlaceholder: 'Mirpur depot',
+      address: 'Address',
+      phone: 'Phone at this address',
+      add: 'Add an address',
+      remove: 'Remove address {{number}}',
+      empty: 'No address yet. Add the billing address that goes on the invoice.',
+      defaultShipping: 'Default for deliveries',
+    },
+    create: 'Add customer',
+    save: 'Save customer',
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
+      'This cannot be undone. A customer with entries or documents can only be archived.',
+    deleted: '{{name}} deleted',
+    archivedNotice:
+      'This customer is archived: it is hidden from new documents. Its history and balance stay.',
+    alsoSupplier: 'Also a supplier',
+    kpis: {
+      balance: 'Balance',
+      creditLimit: 'Credit limit',
+      terms: 'Payment terms',
+    },
+    // What the customer owes, or what the company owes back (an advance, an overpayment)
+    owes: 'Owes {{amount}}',
+    inAdvance: '{{amount}} in advance',
+    settled: 'Nothing owed',
+    details: 'Details',
+    noAddresses: 'No addresses',
+    statementTitle: 'Statement',
+    statementSubtitle: 'Posted entries for this customer, with the running balance',
+    statementEmptyTitle: 'No entries in these dates',
+    statementEmptyBody:
+      'Pick other dates. Their opening balance, invoices and payments show up here once they are posted.',
+    statementLoadFailed: "Couldn't load the statement. Refresh the page to try again.",
+    // The customer picker on journal lines and opening balances
+    pickerSearch: 'Search customers',
+    pickerEmpty: 'No active customer matches',
+  },
+  customerGroups: {
+    title: 'Customer groups',
+    description: 'Groups like Dealer, Retailer and Corporate, to sort and filter your customers',
+    add: 'Add group',
+    columns: {
+      name: 'Group',
+      customers: 'Customers',
+    },
+    customerCount_one: '{{formatted}} customer',
+    customerCount_other: '{{formatted}} customers',
+    newTitle: 'Add group',
+    editTitle: 'Edit {{name}}',
+    name: 'Name',
+    namePlaceholder: 'Dealer',
+    created: '{{name}} added',
+    updated: '{{name}} saved',
+    delete: 'Delete',
+    confirmDelete: 'Delete {{name}}',
+    deleteWarning: 'Only a group with no customers can be deleted.',
+    deleted: '{{name}} deleted',
+    emptyTitle: 'No customer groups yet',
+    emptyBody: 'Add groups like Dealer, Retailer and Corporate, then put each customer in one.',
+    loadFailed: "Couldn't load the customer groups. Refresh the page to try again.",
+    readOnly: 'To change the groups, ask for the sales.customer.manage permission.',
+  },
+  priceLists: {
+    title: 'Price lists',
+    description: 'Prices for some customers, like dealers or wholesale buyers',
+    add: 'Add price list',
+    show: 'Show',
+    statuses: { active: 'Active', archived: 'Archived' },
+    columns: {
+      name: 'Price list',
+      prices: 'Prices',
+      customers: 'Customers',
+    },
+    emptyTitle: 'No price lists yet',
+    emptyBody:
+      "Add one, like Dealer, with the prices your dealers pay. A customer without a list pays the products' own sale prices.",
+    archivedEmptyTitle: 'No archived price lists',
+    archivedEmptyBody:
+      "Archive a list you no longer use. Its customers then pay the products' own prices.",
+    loadFailed: "Couldn't load the price lists. Refresh the page to try again.",
+    readOnly:
+      'You can see the price lists. To change them, ask for the sales.price_list.manage permission.',
+    back: 'Price lists',
+    notFound: "This price list doesn't exist.",
+    newTitle: 'Add price list',
+    editTitle: 'Edit {{name}}',
+    name: 'Name',
+    namePlaceholder: 'Dealer',
+    about: 'Description',
+    aboutPlaceholder: 'District dealers with a signed agreement',
+    created: '{{name}} added',
+    updated: '{{name}} saved',
+    edit: 'Edit',
+    archive: 'Archive',
+    restore: 'Restore',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    archivedNotice:
+      "This price list is archived. Its customers pay the products' own prices until you restore it.",
+    // The workspace setting the prices follow, shown next to the list's name
+    withVat: 'Prices include VAT',
+    withoutVat: 'Prices before VAT',
+    searchLabel: 'Search the prices',
+    searchPlaceholder: 'Product name, code or SKU',
+    itemColumns: {
+      item: 'Item',
+      unit: 'Unit',
+      price: 'Price',
+    },
+    priceOf: 'Price of {{name}} per {{unit}}',
+    pricePlaceholder: 'Product price',
+    remove: 'Remove the price of {{name}} per {{unit}}',
+    new: 'New',
+    addItems: 'Add items',
+    pickerTitle: 'Add items',
+    pickerDescription:
+      'Search, then add a product: each version gets a row for its base unit and every pack.',
+    pickerSearch: 'Search products',
+    pickerAdd: 'Add',
+    pickerAdded: 'Added',
+    pickerEmpty: 'No active product matches. Check the spelling, or search by code or SKU.',
+    unsaved_one: '{{count}} price changed',
+    unsaved_other: '{{count}} prices changed',
+    tooMany: 'Save these {{max}} changes first, then go on.',
+    discard: 'Discard',
+    savePrices: 'Save prices',
+    pricesSaved: 'Prices saved',
+    itemsEmptyTitle: 'No prices in this list yet',
+    itemsEmptyBody:
+      'Add items and type the price for each unit. An item the list leaves out sells at its own sale price.',
+    itemsNoMatchTitle: 'No price matches "{{query}}"',
+    itemsNoMatchBody: 'Check the spelling, or add the item.',
+    itemsLoadFailed: "Couldn't load the prices. Refresh the page to try again.",
+  },
   yearEnd: {
     title: 'Year-end close',
     description: "Move each year's profit into retained earnings and close its dates",
@@ -1359,6 +1648,7 @@ export const en = {
       workspace: 'Workspace',
       accounting: 'Accounting',
       inventory: 'Inventory',
+      sales: 'Sales',
     },
     members_one: '{{count}} person',
     members_other: '{{count}} people',
@@ -1422,6 +1712,13 @@ export const en = {
         revalue: 'Revalue stock: give items a new average cost',
       },
     },
+    sales: {
+      customer: {
+        manage: 'Add, edit and archive customers and their groups',
+        balance: 'See what customers owe, and their statements',
+      },
+      price_list: { manage: 'Add price lists and change their prices' },
+    },
   },
   invite: {
     checking: 'Checking your invitation…',
@@ -1468,6 +1765,10 @@ export const en = {
       stock_transfer: 'Stock transfers',
       reorder_level: 'Reorder levels',
       stock_revaluation: 'Stock revaluations',
+      tax_rate: 'VAT rates',
+      customer: 'Customers',
+      customer_group: 'Customer groups',
+      price_list: 'Price lists',
     },
     columns: {
       when: 'When',
@@ -1585,6 +1886,32 @@ export const en = {
         created: 'Added the stock accounts',
       },
       stock_revaluation: { posted: 'Posted a stock revaluation' },
+      tax_rate: {
+        created: 'Added a VAT rate',
+        updated: 'Edited a VAT rate',
+        archived: 'Archived a VAT rate',
+        restored: 'Restored a VAT rate',
+      },
+      tax_rates: { created: 'Added the starting VAT rates' },
+      customer: {
+        created: 'Added a customer',
+        updated: 'Edited a customer',
+        archived: 'Archived a customer',
+        restored: 'Restored a customer',
+        deleted: 'Deleted a customer',
+      },
+      customer_group: {
+        created: 'Added a customer group',
+        updated: 'Renamed a customer group',
+        deleted: 'Deleted a customer group',
+      },
+      price_list: {
+        created: 'Added a price list',
+        updated: 'Edited a price list',
+        archived: 'Archived a price list',
+        restored: 'Restored a price list',
+        prices_changed: 'Changed prices in a price list',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -1659,6 +1986,20 @@ export const en = {
       correction: 'Correction',
       transfer_shortage: 'Received short',
       revaluation: 'Revaluation',
+      kind: 'Kind',
+      rate: 'Rate',
+      isDefault: 'Default rate',
+      rates: 'VAT rates',
+      taxRate: 'VAT rate',
+      pricesIncludeVat: 'Prices include VAT',
+      group: 'Customer group',
+      paymentTermsDays: 'Payment terms (days)',
+      creditLimit: 'Credit limit',
+      priceList: 'Price list',
+      addresses: 'Addresses',
+      customers: 'Customers',
+      set: 'Prices set',
+      removed: 'Prices removed',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -1976,6 +2317,39 @@ export const en = {
     revaluation_variant_twice: 'This item is on another line already.',
     account_used_by_stock:
       'Stock documents post to this account. Choose another one in Settings → Inventory first.',
+    customer_code_format: 'Use letters and digits without spaces, like C-00042.',
+    customer_code_taken:
+      'Another customer has this code. Pick another, or leave it empty for the next number.',
+    customer_name_required: "Enter the customer's name, at least 2 characters.",
+    customer_address_required: 'Enter the address, at least 5 characters.',
+    customer_billing_twice: 'A customer has one billing address. Make this one a shipping address.',
+    customer_group_invalid: 'Pick a group from the list. This one was deleted.',
+    customer_in_use: 'Entries use this customer, so it cannot be deleted. Archive it instead.',
+    customer_group_name_required: 'Enter a name, at least 2 characters.',
+    customer_group_name_taken: 'Another group has this name.',
+    customer_group_in_use: 'Customers are in this group. Move them to another group first.',
+    tax_rate_name_required: 'Enter a name, at least 2 characters.',
+    tax_rate_name_taken: 'Another VAT rate has this name.',
+    tax_rate_format: 'Enter a percentage below 100 with at most 2 decimals, like 7.5.',
+    tax_rate_kind_rate:
+      'Standard and reduced rates are above 0%. Zero-rated and exempt rates are 0%.',
+    tax_rate_default_archived:
+      'The default rate cannot be archived. Make another rate the default first.',
+    tax_rate_default_needed:
+      'One rate is always the default. Make another rate the default instead.',
+    tax_rate_invalid: 'Pick an active VAT rate, or the workspace default.',
+    price_list_name_required: 'Enter a name, at least 2 characters.',
+    price_list_name_taken: 'Another price list has this name.',
+    price_list_invalid: 'Pick an active price list. This one is archived.',
+    price_list_item_twice: 'This item and unit are here twice. Keep one.',
+    price_list_unit_invalid:
+      "This unit is not one of the product's units any more. Remove the row.",
+    journal_party_required: 'Pick the customer this amount belongs to.',
+    journal_party_not_allowed:
+      'Only lines on the receivable account take a customer. Remove the customer.',
+    journal_party_invalid: 'Pick an active customer. This one is archived or was deleted.',
+    opening_balance_twice:
+      'This account is here twice. Put the amount on one line, or pick another customer.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
@@ -2002,5 +2376,11 @@ export const en = {
     datePicker: {
       placeholder: 'Pick a date',
     },
+    combobox: {
+      placeholder: 'Choose',
+      search: 'Search',
+      loading: 'Searching…',
+      empty: 'Nothing matches',
+    },
   },
 };
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, which is taken from
  `en`, so a key that is missing in Bangla fails the type check. The `errors` object ends with
  `satisfies Record<ErrorCode, string>`: the 26 error codes that 15a.1 added must all be here, or the i18n package
  itself does not compile. That is why this part comes right after the API.
- **Keys built from contract values are checked too.** The numbering page calls
  `` t(`numbering.documents.${series.documentType}`) ``, the roles matrix `` t(`roles.groups.${group}`) `` and
  `` t(`permissions.${key}`) ``, and the audit filter `` t(`audit.entityTypes.${type}`) ``. These template strings
  are typed from the contract's unions, so the new document type `sales.customer`, the new permission group
  `sales`, the three new permissions and the four new entity types each need their key here. Without one, the app
  fails to type-check, which is better than a raw key on the screen.
- **`nav`: one new group, Sales**, with three pages: customers, customer groups and price lists. The VAT rates are
  not a page of their own. They are a card on the Settings page (15a.6), next to the "Prices include VAT" switch,
  because both are workspace settings that need `core.settings.manage`.
- **`settings.pricesIncludeVatHint` says what both positions mean**, with an example (a printed MRP). "Inclusive"
  and "exclusive" are accountants' words; a shop owner knows whether the price on the shelf already has the VAT
  in it.
- **`journal.noCustomer`, `ledger.noCustomer` and `opening.noCustomerHint`** are for receivable lines posted before
  this step. They have no customer (15a.3 decided against a made-up "Unassigned" customer). The ledger shows
  "No customer" on such a line, and its hint says how to fix it: reverse the entry and post it again with a
  customer. On the opening balances page the hint says to pick the customer or split the amount.
- **`opening.customerLine` and `opening.removeCustomer` name the account and the line**: "Trade receivables:
  line 2". A line editor row is a `role="group"` with a label (CLAUDE.md → Line editor). Once the receivable is
  split by customer, several rows belong to one account, and a screen reader user must still be able to tell
  them apart.
- **`products.fields.defaultTaxRate` names the current default**: "Workspace default: VAT 15%". This is the first
  option of the product form's VAT rate box, and it sends `''` (`taxRateId: null`). Without the name, "Default"
  says nothing about what the product will be charged.
- **`products.fields.priceWithVat` / `priceWithoutVat`** go under the sale price, chosen by the workspace setting.
  The same number means two different prices, so the form says which one it is.
- **`taxRates.kinds` and `kindHints`** label the four values of `TAX_RATE_KINDS`. The hints matter most for
  zero-rated and exempt: both charge 0%, and the only difference a business sees is whether it can claim back the
  VAT it paid on its purchases.
- **`customers.termsDays_one` / `termsDays_other`**: i18next picks the plural form from `count` ("1 day",
  "30 days"). The page shows `onReceipt` instead for 0 days, which the contract defines as "due on receipt".
- **`noLimit` and `cashOnly` are two different things.** A credit limit of `null` means no limit; `"0.0000"` means
  the customer may owe nothing at all (contract, 15a.1). Showing both as "৳0" or "—" would hide the difference.
- **`owes`, `inAdvance` and `settled` turn the balance's sign into words.** The balance is debit minus credit.
  A negative balance means the customer paid in advance, or paid too much. "-৳5,000" on a customer's page is easy
  to misread, and a minus sign means nothing to most people at a sales counter.
- **`customers.pickerEmpty` says "active"**, because the customer picker offers active customers only. An archived
  customer on a line is refused (`journal_party_invalid`), so it is not offered.
- **`priceLists.pricePlaceholder` is "Product price".** An empty price cell means "no price in this list", and the
  item then sells at the product's own price. The placeholder says that where the person types.
- **`priceLists.pickerAdd` and `pickerEmpty`** belong to the price list's own "Add items" dialog (added while
  building 15a.6). It lists products, not stock, so the stock dialog's words ("No stocked product matches") would
  be wrong here.
- **`priceLists.tooMany`** is for `MAX_PRICE_LIST_CHANGES` (500): the page stops collecting changes at that
  number and asks to save first, instead of sending a batch the API refuses.
- **`priceLists.about`, not `description`**: in every section `description` is the page's own subtitle, so the
  price list's description field needs another name. The roles section did the same.
- **`audit.actions.tax_rates.created`** is written by the setup job and the worker, not by a person. The "Who"
  column then shows "System".
- **`audit.fields`** are the field names of the snapshots 15a.3 writes (`paymentTermsDays`, `priceList`, `set`,
  `removed`…). A field without a label does not break the page: `isAuditField()` in `audit-log.tsx` falls back to
  the raw name. But the person would read `paymentTermsDays`, so every new one gets a label.
- **Each error message says how to fix the problem** (CLAUDE.md → Copy). `customer_in_use` points to Archive, and
  `customer_group_in_use` says to move the customers first. `opening_balance_twice` now mentions the customer: two
  lines on one account are fine when their customers differ. The old `opening_account_twice` stays. It is still in
  `ERROR_CODES`, so `satisfies` needs its message, and an app that is newer than the server may still receive it.
- **`ui.combobox`** holds the new control's default words. A page can pass its own (the customer picker passes
  `customers.pickerSearch` and `pickerEmpty`).

### `locales/bn.ts`

```diff
@@ -68,6 +68,10 @@ export const bn: Messages = {
     warehouses: 'গুদাম',
     valuation: 'স্টকের মূল্য',
     revaluations: 'পুনর্মূল্যায়ন',
+    sales: 'বিক্রি',
+    customers: 'গ্রাহক',
+    customerGroups: 'গ্রাহকের গ্রুপ',
+    priceLists: 'দামের তালিকা',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -180,6 +184,11 @@ export const bn: Messages = {
     stockAccountsSaved: 'স্টকের অ্যাকাউন্ট সেভ হয়েছে',
     stockAccountsMissing:
       'কিছু স্টকের অ্যাকাউন্ট এখনো বাছা হয়নি। যে ডকুমেন্টের সেগুলো লাগে, সেগুলো পোস্ট করা যাবে না।',
+    salesTitle: 'বিক্রি',
+    salesSubtitle: 'বিক্রির সময় দাম আর VAT কীভাবে চলবে',
+    pricesIncludeVat: 'দামে VAT ধরা আছে',
+    pricesIncludeVatHint:
+      'চালু থাকলে: আপনার লেখা বিক্রয়মূল্য আর দামের তালিকায় VAT আগেই ধরা, যেমন ছাপা MRP। বন্ধ থাকলে: VAT তার ওপরে যোগ হয়।',
     logoSaved: 'লোগো বদলানো হয়েছে',
     logoRemoved: 'লোগো সরানো হয়েছে',
     saved: 'সেটিংস সেভ হয়েছে',
@@ -196,7 +205,7 @@ export const bn: Messages = {
       next: 'পরের নম্বর',
     },
     documents: {
-      sales: { invoice: 'বিক্রয় ইনভয়েস', order: 'সেলস অর্ডার' },
+      sales: { invoice: 'বিক্রয় ইনভয়েস', order: 'সেলস অর্ডার', customer: 'গ্রাহক কোড' },
       purchase: { order: 'পারচেজ অর্ডার (PO)', bill: 'সাপ্লায়ারের বিল' },
       inventory: {
         receipt: 'মাল গ্রহণ (GRN)',
@@ -372,6 +381,9 @@ export const bn: Messages = {
     account: 'অ্যাকাউন্ট',
     accountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
     lineDescription: 'বিবরণ',
+    customer: 'গ্রাহক',
+    customerPlaceholder: 'একজন গ্রাহক বাছুন',
+    noCustomer: 'কোনো গ্রাহক নেই',
     branch: 'ব্রাঞ্চ',
     noBranch: 'কোনো ব্রাঞ্চ না',
     debit: 'ডেবিট',
@@ -444,6 +456,9 @@ export const bn: Messages = {
     },
     debitBalance: '{{amount}} ডে.',
     creditBalance: '{{amount}} ক্রে.',
+    noCustomer: 'কোনো গ্রাহক নেই',
+    noCustomerHint:
+      'গ্রাহক রাখা শুরুর আগে পোস্ট করা। এন্ট্রিটা রিভার্স করে গ্রাহকসহ আবার পোস্ট করুন।',
     pickTitle: 'একটা অ্যাকাউন্ট বাছুন',
     pickBody: 'এন্ট্রি দেখতে উপরে একটা অ্যাকাউন্ট বাছুন, যেমন হাতে নগদ বা অফিস ভাড়া।',
     emptyTitle: 'এই তারিখগুলোতে কোনো এন্ট্রি নেই',
@@ -461,6 +476,15 @@ export const bn: Messages = {
     credit: 'ক্রেডিট',
     total: 'মোট',
     difference: 'ওপেনিং ব্যালান্স ইকুইটি',
+    customer: 'গ্রাহক',
+    customerPlaceholder: 'একজন গ্রাহক বাছুন',
+    customerLine: '{{account}}: লাইন {{number}}',
+    addCustomer: 'গ্রাহক যোগ করুন',
+    removeCustomer: '{{account}}-এর লাইন {{number}} সরান',
+    receivableHint:
+      'প্রতিটা গ্রাহকের কাছে কত পাওনা ছিল, একেকজনের জন্য এক লাইনে লিখুন। অ্যাকাউন্টে থাকে তাদের মোট।',
+    noCustomerHint:
+      'গ্রাহক রাখা শুরুর আগে সেভ করা। গ্রাহক বাছুন, অথবা টাকাটা কয়েকটা লাইনে ভাগ করুন।',
     differenceHint: 'ব্যালান্সগুলো যতটা গরমিল, সেটা এখানে যায়। সব দেওয়া হলে এটা শূন্য হয়।',
     save: 'ওপেনিং ব্যালান্স পোস্ট করুন',
     saved: 'ওপেনিং ব্যালান্স {{number}} হিসেবে পোস্ট হয়েছে',
@@ -643,6 +667,11 @@ export const bn: Messages = {
       skuHint: 'ফাঁকা রাখলে কোড থেকে বানানো হবে।',
       barcode: 'বারকোড',
       price: 'প্রতি {{unit}} বিক্রয়মূল্য',
+      priceWithVat: 'VAT সহ',
+      priceWithoutVat: 'VAT ছাড়া',
+      taxRate: 'VAT রেট',
+      defaultTaxRate: 'workspace-এর ডিফল্ট: {{name}}',
+      taxRateHint: 'এই প্রোডাক্টে অন্য রেট বা VAT মওকুফ না হলে ডিফল্টই রাখুন।',
       tracking: 'ট্র্যাকিং',
       hasExpiry: 'ব্যাচের মেয়াদের তারিখ আছে',
     },
@@ -1249,6 +1278,263 @@ export const bn: Messages = {
     emptyBody: 'খরচ রাখা শুরুর আগে যে স্টক ঢুকেছিল তাকে আসল মূল্য দিন, বা ভুল খরচ ঠিক করুন।',
     loadFailed: 'পুনর্মূল্যায়নগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  taxRates: {
+    title: 'VAT রেট',
+    subtitle:
+      'আপনার প্রোডাক্ট আর বিক্রির লাইনে কত VAT লাগে। নিজের রেট না থাকলে প্রোডাক্ট ডিফল্টটা নেয়।',
+    add: 'রেট যোগ করুন',
+    columns: {
+      name: 'নাম',
+      kind: 'ধরন',
+      rate: 'রেট',
+    },
+    kinds: {
+      standard: 'স্ট্যান্ডার্ড',
+      reduced: 'হ্রাসকৃত',
+      zero_rated: 'শূন্য হার',
+      exempt: 'অব্যাহতিপ্রাপ্ত',
+    },
+    kindHints: {
+      standard: 'সাধারণ ১৫%।',
+      reduced: 'কিছু পণ্যের জন্য NBR-এর ঠিক করা কম রেট, যেমন ১০%, ৭.৫% বা ৫%।',
+      zero_rated: '০% হারে করযোগ্য, যেমন রপ্তানি। কেনাকাটায় দেওয়া VAT তবুও ফেরত দাবি করা যায়।',
+      exempt: 'VAT-এর বাইরে। কেনাকাটায় দেওয়া VAT ফেরত দাবি করা যায় না।',
+    },
+    percent: '{{rate}}%',
+    default: 'ডিফল্ট',
+    archived: 'আর্কাইভ',
+    newTitle: 'VAT রেট যোগ করুন',
+    editTitle: '{{name}} বদলান',
+    name: 'নাম',
+    namePlaceholder: 'VAT ৭.৫%',
+    kind: 'ধরন',
+    rate: 'রেট',
+    rateHint: 'শতাংশ, যেমন 15 বা 7.5',
+    makeDefault: 'নিজের রেট নেই এমন প্রোডাক্টে এটা লাগবে',
+    defaultLocked: 'এটাই ডিফল্ট। বদলাতে অন্য একটা রেটকে ডিফল্ট করুন।',
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}} সেভ হয়েছে',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
+    emptyTitle: 'এখনো কোনো VAT রেট নেই',
+    emptyBody:
+      'আগে স্ট্যান্ডার্ড ১৫% যোগ করুন। কোনো প্রোডাক্টকে অন্য রেট না দেওয়া পর্যন্ত সবাই এটা নেয়।',
+    loadFailed: 'VAT রেট আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  customers: {
+    title: 'গ্রাহক',
+    description: 'যে ডিলার, দোকান আর বায়ারের কাছে বিক্রি করেন, আর তাদের কাছে কত পাওনা',
+    add: 'গ্রাহক যোগ করুন',
+    searchLabel: 'গ্রাহক খুঁজুন',
+    searchPlaceholder: 'নাম, কোড, যোগাযোগের মানুষ বা ফোন',
+    group: 'গ্রুপ',
+    allGroups: 'সব গ্রুপ',
+    show: 'দেখান',
+    statuses: { active: 'চালু', archived: 'আর্কাইভ' },
+    columns: {
+      customer: 'গ্রাহক',
+      phone: 'ফোন',
+      group: 'গ্রুপ',
+      terms: 'শর্ত',
+      creditLimit: 'ক্রেডিট লিমিট',
+      balance: 'ব্যালান্স',
+    },
+    termsDays_one: '{{count}} দিন',
+    termsDays_other: '{{count}} দিন',
+    onReceipt: 'পাওয়ামাত্র',
+    noLimit: 'লিমিট নেই',
+    cashOnly: 'শুধু নগদ',
+    emptyTitle: 'এখনো কোনো গ্রাহক নেই',
+    emptyBody:
+      'প্রথম গ্রাহক যোগ করুন, যেমন চট্টগ্রামের একজন ডিলার বা একটা ফার্মেসি চেইন। তাদের এন্ট্রি পোস্ট হলে কত পাওনা তা এখানে দেখাবে।',
+    noMatchTitle: '"{{query}}"-এর সাথে কোনো গ্রাহক মেলেনি',
+    noMatchBody: 'বানান দেখুন, অথবা কোড বা ফোন নম্বর দিয়ে খুঁজুন।',
+    archivedEmptyTitle: 'কোনো আর্কাইভ করা গ্রাহক নেই',
+    archivedEmptyBody: 'আর্কাইভ করা গ্রাহক এখানে দেখাবে। তাদের ইতিহাস আর পাওনা থেকে যায়।',
+    loadFailed: 'গ্রাহকের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'আপনি গ্রাহক দেখতে পারেন। বদলাতে sales.customer.manage অনুমতি চান।',
+    back: 'গ্রাহক',
+    newTitle: 'নতুন গ্রাহক',
+    editTitle: '{{code}} বদলান',
+    notFound: 'এই গ্রাহক নেই, অথবা মুছে ফেলা হয়েছে।',
+    sections: {
+      basics: 'মূল তথ্য',
+      terms: 'বিক্রির শর্ত',
+      termsHint: 'এই গ্রাহকের কাছে প্রতিটা বিক্রিতে লাগে।',
+      addresses: 'ঠিকানা',
+      addressesHint:
+        'ইনভয়েসের জন্য একটা বিলিং ঠিকানা, আর ডেলিভারির জন্য যতগুলো দরকার শিপিং ঠিকানা। প্রথম শিপিং ঠিকানাটা ডিফল্ট।',
+    },
+    fields: {
+      code: 'কোড',
+      codeHint: 'খালি রাখলে পরের নম্বর বসবে, যেমন C-00042।',
+      name: 'নাম',
+      namePlaceholder: 'রহমান ট্রেডার্স',
+      group: 'গ্রুপ',
+      noGroup: 'কোনো গ্রুপ নেই',
+      contactPerson: 'যোগাযোগের মানুষ',
+      contactPersonPlaceholder: 'মো. কামাল হোসেন',
+      phone: 'ফোন',
+      email: 'ইমেইল',
+      bin: 'BIN',
+      binHint: 'গ্রাহকের ১৩ অঙ্কের VAT নিবন্ধন নম্বর, মূসক ৬.৩-এ ছাপা হয়',
+      paymentTerms: 'পেমেন্টের শর্ত',
+      paymentTermsHint: 'ইনভয়েস থেকে পরিশোধের শেষ দিন পর্যন্ত কত দিন। ০ = পাওয়ামাত্র।',
+      days: 'দিন',
+      creditLimit: 'ক্রেডিট লিমিট',
+      creditLimitHint: 'সবচেয়ে বেশি কত বাকি রাখতে পারবে। খালি = লিমিট নেই; ০ = শুধু নগদ।',
+      priceList: 'দামের তালিকা',
+      noPriceList: 'প্রোডাক্টের নিজের দাম',
+      notes: 'নোট',
+      notesPlaceholder: 'শুধু সকাল ১১টার আগে মাল নেয়। প্রতি মাসের ১০ তারিখে চেকে টাকা দেয়।',
+    },
+    addresses: {
+      number: 'ঠিকানা {{number}}',
+      kind: 'ধরন',
+      kinds: { billing: 'বিলিং', shipping: 'শিপিং' },
+      label: 'নাম',
+      labelPlaceholder: 'মিরপুর ডিপো',
+      address: 'ঠিকানা',
+      phone: 'এই ঠিকানার ফোন',
+      add: 'ঠিকানা যোগ করুন',
+      remove: 'ঠিকানা {{number}} সরান',
+      empty: 'এখনো কোনো ঠিকানা নেই। ইনভয়েসে যে বিলিং ঠিকানা যাবে সেটা যোগ করুন।',
+      defaultShipping: 'ডেলিভারির ডিফল্ট',
+    },
+    create: 'গ্রাহক যোগ করুন',
+    save: 'গ্রাহক সেভ করুন',
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
+      'এটা আর ফেরানো যাবে না। যে গ্রাহকের এন্ট্রি বা ডকুমেন্ট আছে, তাকে শুধু আর্কাইভ করা যায়।',
+    deleted: '{{name}} মুছে ফেলা হয়েছে',
+    archivedNotice:
+      'এই গ্রাহক আর্কাইভ করা: নতুন ডকুমেন্টে দেখাবে না। ইতিহাস আর ব্যালান্স থেকে যায়।',
+    alsoSupplier: 'সাপ্লায়ারও',
+    kpis: {
+      balance: 'ব্যালান্স',
+      creditLimit: 'ক্রেডিট লিমিট',
+      terms: 'পেমেন্টের শর্ত',
+    },
+    owes: '{{amount}} পাওনা',
+    inAdvance: '{{amount}} অগ্রিম',
+    settled: 'কোনো পাওনা নেই',
+    details: 'বিস্তারিত',
+    noAddresses: 'কোনো ঠিকানা নেই',
+    statementTitle: 'স্টেটমেন্ট',
+    statementSubtitle: 'এই গ্রাহকের পোস্ট করা এন্ট্রি, চলতি ব্যালান্সসহ',
+    statementEmptyTitle: 'এই তারিখগুলোতে কোনো এন্ট্রি নেই',
+    statementEmptyBody:
+      'অন্য তারিখ বাছুন। ওপেনিং ব্যালান্স, ইনভয়েস আর পেমেন্ট পোস্ট হলে এখানে দেখাবে।',
+    statementLoadFailed: 'স্টেটমেন্ট আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    pickerSearch: 'গ্রাহক খুঁজুন',
+    pickerEmpty: 'কোনো চালু গ্রাহক মেলেনি',
+  },
+  customerGroups: {
+    title: 'গ্রাহকের গ্রুপ',
+    description: 'ডিলার, রিটেইলার, কর্পোরেটের মতো গ্রুপ, গ্রাহক সাজাতে আর ছাঁকতে',
+    add: 'গ্রুপ যোগ করুন',
+    columns: {
+      name: 'গ্রুপ',
+      customers: 'গ্রাহক',
+    },
+    customerCount_one: '{{formatted}} জন গ্রাহক',
+    customerCount_other: '{{formatted}} জন গ্রাহক',
+    newTitle: 'গ্রুপ যোগ করুন',
+    editTitle: '{{name}} বদলান',
+    name: 'নাম',
+    namePlaceholder: 'ডিলার',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}} সেভ হয়েছে',
+    delete: 'মুছুন',
+    confirmDelete: '{{name}} মুছুন',
+    deleteWarning: 'শুধু গ্রাহকহীন গ্রুপ মোছা যায়।',
+    deleted: '{{name}} মুছে ফেলা হয়েছে',
+    emptyTitle: 'এখনো কোনো গ্রাহকের গ্রুপ নেই',
+    emptyBody:
+      'ডিলার, রিটেইলার, কর্পোরেটের মতো গ্রুপ যোগ করুন, তারপর প্রতিটা গ্রাহককে একটায় রাখুন।',
+    loadFailed: 'গ্রাহকের গ্রুপ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'গ্রুপ বদলাতে sales.customer.manage অনুমতি চান।',
+  },
+  priceLists: {
+    title: 'দামের তালিকা',
+    description: 'কিছু গ্রাহকের আলাদা দাম, যেমন ডিলার বা পাইকারি ক্রেতা',
+    add: 'দামের তালিকা যোগ করুন',
+    show: 'দেখান',
+    statuses: { active: 'চালু', archived: 'আর্কাইভ' },
+    columns: {
+      name: 'দামের তালিকা',
+      prices: 'দাম',
+      customers: 'গ্রাহক',
+    },
+    emptyTitle: 'এখনো কোনো দামের তালিকা নেই',
+    emptyBody:
+      'একটা যোগ করুন, যেমন ডিলার, আপনার ডিলাররা যে দাম দেয় তা দিয়ে। তালিকা ছাড়া গ্রাহক প্রোডাক্টের নিজের বিক্রয়মূল্য দেয়।',
+    archivedEmptyTitle: 'কোনো আর্কাইভ করা দামের তালিকা নেই',
+    archivedEmptyBody:
+      'যে তালিকা আর লাগে না সেটা আর্কাইভ করুন। তখন তার গ্রাহকেরা প্রোডাক্টের নিজের দাম দেয়।',
+    loadFailed: 'দামের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'আপনি দামের তালিকা দেখতে পারেন। বদলাতে sales.price_list.manage অনুমতি চান।',
+    back: 'দামের তালিকা',
+    notFound: 'এই দামের তালিকা নেই।',
+    newTitle: 'দামের তালিকা যোগ করুন',
+    editTitle: '{{name}} বদলান',
+    name: 'নাম',
+    namePlaceholder: 'ডিলার',
+    about: 'বিবরণ',
+    aboutPlaceholder: 'চুক্তি সই করা জেলা ডিলার',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}} সেভ হয়েছে',
+    edit: 'বদলান',
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
+    archivedNotice:
+      'এই দামের তালিকা আর্কাইভ করা। ফিরিয়ে না আনা পর্যন্ত এর গ্রাহকেরা প্রোডাক্টের নিজের দাম দেয়।',
+    withVat: 'দামে VAT ধরা',
+    withoutVat: 'দাম VAT ছাড়া',
+    searchLabel: 'দাম খুঁজুন',
+    searchPlaceholder: 'প্রোডাক্টের নাম, কোড বা SKU',
+    itemColumns: {
+      item: 'আইটেম',
+      unit: 'ইউনিট',
+      price: 'দাম',
+    },
+    priceOf: 'প্রতি {{unit}} {{name}}-এর দাম',
+    pricePlaceholder: 'প্রোডাক্টের দাম',
+    remove: 'প্রতি {{unit}} {{name}}-এর দাম সরান',
+    new: 'নতুন',
+    addItems: 'আইটেম যোগ করুন',
+    pickerTitle: 'আইটেম যোগ করুন',
+    pickerDescription:
+      'খুঁজে একটা প্রোডাক্ট যোগ করুন: প্রতিটা ভার্সনের বেস ইউনিট আর প্রতিটা প্যাকের জন্য একটা করে সারি আসে।',
+    pickerSearch: 'প্রোডাক্ট খুঁজুন',
+    pickerAdd: 'যোগ করুন',
+    pickerAdded: 'যোগ হয়েছে',
+    pickerEmpty: 'কোনো চালু প্রোডাক্ট মেলেনি। বানান দেখুন, বা কোড কিংবা SKU দিয়ে খুঁজুন।',
+    unsaved_one: '{{count}}টা দাম বদলেছে',
+    unsaved_other: '{{count}}টা দাম বদলেছে',
+    tooMany: 'আগে এই {{max}}টা পরিবর্তন সেভ করুন, তারপর এগোন।',
+    discard: 'বাতিল',
+    savePrices: 'দাম সেভ করুন',
+    pricesSaved: 'দাম সেভ হয়েছে',
+    itemsEmptyTitle: 'এই তালিকায় এখনো কোনো দাম নেই',
+    itemsEmptyBody:
+      'আইটেম যোগ করে প্রতিটা ইউনিটের দাম লিখুন। তালিকায় না থাকা আইটেম নিজের বিক্রয়মূল্যে বিক্রি হয়।',
+    itemsNoMatchTitle: '"{{query}}"-এর সাথে কোনো দাম মেলেনি',
+    itemsNoMatchBody: 'বানান দেখুন, অথবা আইটেমটা যোগ করুন।',
+    itemsLoadFailed: 'দাম আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   yearEnd: {
     title: 'বছর শেষের ক্লোজিং',
     description: 'প্রতিটা বছরের লাভ রিটেইনড আর্নিংসে নিন আর সেই বছরের তারিখগুলো বন্ধ করুন',
@@ -1348,6 +1634,7 @@ export const bn: Messages = {
       workspace: 'ওয়ার্কস্পেস',
       accounting: 'হিসাবরক্ষণ',
       inventory: 'ইনভেন্টরি',
+      sales: 'বিক্রি',
     },
     members_one: '{{count}} জন',
     members_other: '{{count}} জন',
@@ -1409,6 +1696,13 @@ export const bn: Messages = {
         revalue: 'স্টকের পুনর্মূল্যায়ন: আইটেমের নতুন গড় খরচ ঠিক করা',
       },
     },
+    sales: {
+      customer: {
+        manage: 'গ্রাহক আর তাদের গ্রুপ যোগ, বদল আর আর্কাইভ করা',
+        balance: 'গ্রাহকদের কাছে কত পাওনা আর তাদের স্টেটমেন্ট দেখা',
+      },
+      price_list: { manage: 'দামের তালিকা যোগ করা আর তার দাম বদলানো' },
+    },
   },
   invite: {
     checking: 'আপনার আমন্ত্রণ দেখা হচ্ছে…',
@@ -1455,6 +1749,10 @@ export const bn: Messages = {
       stock_transfer: 'স্টক ট্রান্সফার',
       reorder_level: 'রিঅর্ডার লেভেল',
       stock_revaluation: 'স্টকের পুনর্মূল্যায়ন',
+      tax_rate: 'VAT রেট',
+      customer: 'গ্রাহক',
+      customer_group: 'গ্রাহকের গ্রুপ',
+      price_list: 'দামের তালিকা',
     },
     columns: {
       when: 'কখন',
@@ -1570,6 +1868,32 @@ export const bn: Messages = {
         created: 'স্টকের অ্যাকাউন্ট যোগ করেছেন',
       },
       stock_revaluation: { posted: 'স্টকের একটা পুনর্মূল্যায়ন পোস্ট করেছেন' },
+      tax_rate: {
+        created: 'একটা VAT রেট যোগ করেছেন',
+        updated: 'একটা VAT রেট বদলেছেন',
+        archived: 'একটা VAT রেট আর্কাইভ করেছেন',
+        restored: 'একটা VAT রেট ফিরিয়ে এনেছেন',
+      },
+      tax_rates: { created: 'শুরুর VAT রেটগুলো যোগ করেছে' },
+      customer: {
+        created: 'একজন গ্রাহক যোগ করেছেন',
+        updated: 'একজন গ্রাহকের তথ্য বদলেছেন',
+        archived: 'একজন গ্রাহক আর্কাইভ করেছেন',
+        restored: 'একজন গ্রাহক ফিরিয়ে এনেছেন',
+        deleted: 'একজন গ্রাহক মুছেছেন',
+      },
+      customer_group: {
+        created: 'একটা গ্রাহকের গ্রুপ যোগ করেছেন',
+        updated: 'একটা গ্রাহকের গ্রুপের নাম বদলেছেন',
+        deleted: 'একটা গ্রাহকের গ্রুপ মুছেছেন',
+      },
+      price_list: {
+        created: 'একটা দামের তালিকা যোগ করেছেন',
+        updated: 'একটা দামের তালিকা বদলেছেন',
+        archived: 'একটা দামের তালিকা আর্কাইভ করেছেন',
+        restored: 'একটা দামের তালিকা ফিরিয়ে এনেছেন',
+        prices_changed: 'একটা দামের তালিকার দাম বদলেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -1643,6 +1967,20 @@ export const bn: Messages = {
       correction: 'সংশোধন',
       transfer_shortage: 'কম পৌঁছেছে',
       revaluation: 'পুনর্মূল্যায়ন',
+      kind: 'ধরন',
+      rate: 'রেট',
+      isDefault: 'ডিফল্ট রেট',
+      rates: 'VAT রেট',
+      taxRate: 'VAT রেট',
+      pricesIncludeVat: 'দামে VAT ধরা',
+      group: 'গ্রাহকের গ্রুপ',
+      paymentTermsDays: 'পেমেন্টের শর্ত (দিন)',
+      creditLimit: 'ক্রেডিট লিমিট',
+      priceList: 'দামের তালিকা',
+      addresses: 'ঠিকানা',
+      customers: 'গ্রাহক',
+      set: 'দাম বসানো',
+      removed: 'দাম সরানো',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -1953,6 +2291,35 @@ export const bn: Messages = {
     revaluation_variant_twice: 'এই আইটেমটা আরেকটা লাইনে আছে।',
     account_used_by_stock:
       'স্টকের ডকুমেন্ট এই অ্যাকাউন্টে পোস্ট করে। আগে Settings → Inventory-তে অন্য একটা বাছুন।',
+    customer_code_format: 'ফাঁকা ছাড়া অক্ষর আর অঙ্ক দিন, যেমন C-00042।',
+    customer_code_taken:
+      'আরেকজন গ্রাহকের এই কোড আছে। অন্য কোড দিন, অথবা পরের নম্বরের জন্য খালি রাখুন।',
+    customer_name_required: 'গ্রাহকের নাম দিন, অন্তত ২ অক্ষর।',
+    customer_address_required: 'ঠিকানা দিন, অন্তত ৫ অক্ষর।',
+    customer_billing_twice: 'একজন গ্রাহকের একটাই বিলিং ঠিকানা থাকে। এটাকে শিপিং ঠিকানা করুন।',
+    customer_group_invalid: 'তালিকা থেকে একটা গ্রুপ বাছুন। এটা মুছে ফেলা হয়েছে।',
+    customer_in_use: 'এন্ট্রিতে এই গ্রাহক আছে, তাই মোছা যাবে না। বদলে আর্কাইভ করুন।',
+    customer_group_name_required: 'নাম দিন, অন্তত ২ অক্ষর।',
+    customer_group_name_taken: 'আরেকটা গ্রুপের এই নাম আছে।',
+    customer_group_in_use: 'এই গ্রুপে গ্রাহক আছে। আগে তাদের অন্য গ্রুপে সরান।',
+    tax_rate_name_required: 'নাম দিন, অন্তত ২ অক্ষর।',
+    tax_rate_name_taken: 'আরেকটা VAT রেটের এই নাম আছে।',
+    tax_rate_format: '১০০-এর কম একটা শতাংশ দিন, বড়জোর ২ দশমিক ঘর, যেমন 7.5।',
+    tax_rate_kind_rate:
+      'স্ট্যান্ডার্ড আর হ্রাসকৃত রেট ০%-এর বেশি। শূন্য হার আর অব্যাহতিপ্রাপ্ত রেট ০%।',
+    tax_rate_default_archived: 'ডিফল্ট রেট আর্কাইভ করা যায় না। আগে অন্য একটা রেটকে ডিফল্ট করুন।',
+    tax_rate_default_needed: 'একটা রেট সবসময় ডিফল্ট থাকে। বদলে অন্য একটা রেটকে ডিফল্ট করুন।',
+    tax_rate_invalid: 'একটা চালু VAT রেট বাছুন, অথবা workspace-এর ডিফল্ট।',
+    price_list_name_required: 'নাম দিন, অন্তত ২ অক্ষর।',
+    price_list_name_taken: 'আরেকটা দামের তালিকার এই নাম আছে।',
+    price_list_invalid: 'একটা চালু দামের তালিকা বাছুন। এটা আর্কাইভ করা।',
+    price_list_item_twice: 'এই আইটেম আর ইউনিট এখানে দুবার আছে। একটা রাখুন।',
+    price_list_unit_invalid: 'এই ইউনিট আর প্রোডাক্টের ইউনিটের মধ্যে নেই। সারিটা সরান।',
+    journal_party_required: 'টাকাটা কোন গ্রাহকের, বাছুন।',
+    journal_party_not_allowed: 'শুধু পাওনার অ্যাকাউন্টের লাইনে গ্রাহক থাকে। গ্রাহকটা সরান।',
+    journal_party_invalid: 'একজন চালু গ্রাহক বাছুন। এই গ্রাহক আর্কাইভ করা বা মুছে ফেলা।',
+    opening_balance_twice:
+      'এই অ্যাকাউন্ট এখানে দুবার আছে। টাকাটা এক লাইনে দিন, অথবা অন্য গ্রাহক বাছুন।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
@@ -1977,5 +2344,11 @@ export const bn: Messages = {
     datePicker: {
       placeholder: 'তারিখ বাছুন',
     },
+    combobox: {
+      placeholder: 'বাছুন',
+      search: 'খুঁজুন',
+      loading: 'খোঁজা হচ্ছে…',
+      empty: 'কিছু মেলেনি',
+    },
   },
 };
```

- **The words follow the existing Bangla text.** "গ্রাহক" for customer is already in the chart of accounts
  ("গ্রাহকদের কাছে পাওনা"), and "দাম" for price is already on the product form. VAT, BIN, workspace and the
  permission keys stay in English inside the Bangla sentences (CLAUDE.md → Language). Mushak 6.3 is written
  "মূসক ৬.৩", the form's own Bangla name.
- **The VAT kinds use the words of the VAT law**: "হ্রাসকৃত" (reduced), "শূন্য হার" (zero-rated) and
  "অব্যাহতিপ্রাপ্ত" (exempt). They are the words an accountant sees on the NBR forms.
- **`_one` and `_other` have the same text.** Bangla does not change the noun for a plural. Both keys still have
  to exist, because `Messages` has both.
- **Examples of typed values use ASCII digits** ("15 বা 7.5" in `rateHint` and `tax_rate_format`). The inputs always
  show ASCII digits (CLAUDE.md → Money input), so the example looks like what the person will type. A name, like
  the placeholder "VAT ৭.৫%", is ordinary text and uses Bangla digits.

### `components/combobox.tsx` (new)

A customer is picked on a journal line and on the opening balances page now, and on every sales document from
15b on. A native `<select>` needs every option in the page, and a distributor has thousands of customers. The
`ItemPicker` dialog of step 13 is made for adding many lines; here one field takes one value. So `@omnivo/ui` gets
a combobox: a button that looks like an input, and a popover with a search box and the matches.

```tsx
import { ArrowDown01Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type KeyboardEvent, type Ref, useId, useRef, useState } from 'react';

import { cn } from '../lib/cn.js';
import { controlBoxClass, Input } from './field.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

export interface ComboboxOption {
  value: string;
  label: string;
  // A quieter second line: a customer's code and phone number
  detail?: string | undefined;
}

interface ComboboxProps {
  id?: string;
  name?: string;
  // The chosen option's value, or '' for none
  value: string;
  // What the button shows for the chosen value. The parent passes it because the options are only
  // what the last search found: a saved journal line's customer is rarely among them.
  selectedLabel: string | null;
  options: readonly ComboboxOption[];
  // The text in the search box. The parent searches with it (on the server, debounced) and passes
  // the matches back as `options`.
  search: string;
  onSearchChange: (search: string) => void;
  onChange: (value: string, option: ComboboxOption) => void;
  onBlur?: () => void;
  // FormField's field.ref: on an error, react-hook-form focuses this button
  ref?: Ref<HTMLButtonElement>;
  loading?: boolean | undefined;
  icon?: IconSvgElement | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  searchPlaceholder?: string | undefined;
  emptyText?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
}

// A select box for a long list that lives on the server (customers, later suppliers): the button
// looks like an input, and opens a popover with a search box and the matches. A native <select>
// would need every customer in the page; a distributor has thousands.
export function Combobox({
  id,
  name,
  value,
  selectedLabel,
  options,
  search,
  onSearchChange,
  onChange,
  onBlur,
  ref,
  loading = false,
  icon,
  invalid = false,
  disabled,
  placeholder,
  searchPlaceholder,
  emptyText,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: ComboboxProps) {
  const { t } = useLocale();
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const choose = (option: ComboboxOption) => {
    onChange(option.value, option);
    setOpen(false);
  };

  // Show the highlighted option without scrolling the page
  const highlight = (index: number) => {
    setActive(index);
    listRef.current?.children.item(index)?.scrollIntoView({ block: 'nearest' });
  };

  // The search box keeps the focus; the arrows move the highlight, Enter picks it
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      // Inside a form, Enter would also submit it
      event.preventDefault();
      const option = options[active];
      if (option) choose(option);
    }
  };

  const activeOption = options[active];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // Start on the chosen option when the matches hold it, otherwise on the first
          setActive(
            Math.max(
              0,
              options.findIndex((option) => option.value === value),
            ),
          );
        } else {
          // The next opening starts with an empty search, and closing = leaving the field
          onSearchChange('');
          onBlur?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={ref}
          id={id}
          name={name}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={ariaDescribedBy}
          className={cn(controlBoxClass(invalid), 'w-full py-2.5 text-left text-body')}
        >
          {icon && (
            <HugeiconsIcon
              icon={icon}
              size={17}
              strokeWidth={1.5}
              className="shrink-0 text-ink-3"
            />
          )}
          <span className={cn('min-w-0 flex-1 truncate', selectedLabel === null && 'text-ink-3')}>
            {selectedLabel ?? placeholder ?? t('ui.combobox.placeholder')}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={1.5}
            className="shrink-0 text-ink-3"
          />
        </button>
      </PopoverTrigger>
      {/* As wide as the button, but never narrower than a name and a phone number. The popover
          moves the focus to its first focusable element: the search box. */}
      <PopoverContent className="grid w-(--radix-popover-trigger-width) min-w-72 gap-1 p-1">
        <Input
          type="search"
          icon={Search01Icon}
          role="combobox"
          aria-label={searchPlaceholder ?? t('ui.combobox.search')}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption ? `${listId}-${String(active)}` : undefined}
          placeholder={searchPlaceholder ?? t('ui.combobox.search')}
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {options.length === 0 ? (
          <p className="px-2.5 py-2 text-body-sm text-ink-3" role="status">
            {loading ? t('ui.combobox.loading') : (emptyText ?? t('ui.combobox.empty'))}
          </p>
        ) : (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            // The old matches stay while the new ones load (the parent keeps them)
            aria-busy={loading || undefined}
            className="max-h-72 overflow-y-auto"
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={option.value === value}
                // A div-like element: the global cursor rule only covers buttons and links
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-body-sm text-ink-2 select-none',
                  index === active && 'bg-subtle text-ink',
                )}
                onMouseMove={() => {
                  if (index !== active) setActive(index);
                }}
                // Keep the focus in the search box, so the arrows still work after a click
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  choose(option);
                }}
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate">{option.label}</span>
                  {option.detail && (
                    <span className="truncate text-caption font-normal text-ink-3 tabular-nums">
                      {option.detail}
                    </span>
                  )}
                </span>
                {option.value === value && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={16}
                    strokeWidth={1.5}
                    className="shrink-0 text-brand"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- **Built on the `Popover` that is already here.** `radix-ui` has no combobox. A library like `cmdk` would be a new
  dependency for about 150 lines. Radix's popover already does the hard parts: the portal, moving away from the
  screen's edges, closing on Escape or a click outside, and giving the focus back to the button.
- **`selectedLabel` comes from the parent.** The options are only what the last search found. A saved journal line
  carries its customer as `{ id, code, name }`, and that customer is almost never in the current matches. Without
  this prop, the button could only show the chosen value's id, or nothing.
- **`search` and `onSearchChange` belong to the parent.** The parent runs the query (debounced, on the server,
  keeping the old matches while new ones load) and passes the results as `options`. The component knows nothing
  about the API, so step 17 can use it for suppliers unchanged.
- **The focus stays in the search box.** This is the ARIA combobox pattern: the input has `role="combobox"`, and
  `aria-activedescendant` points at the highlighted option, which a screen reader then reads. The options are never
  focused. `onMouseDown` with `preventDefault()` keeps a click from taking the focus out of the box, so the arrow
  keys still work after a click.
- **`onKeyDown`.** The arrows wrap around from the last option to the first. `scrollIntoView({ block: 'nearest' })`
  scrolls only the list, never the page. Enter calls `preventDefault()`, because inside a form it would also
  submit the form; that would save a journal entry while the person was only picking a customer.
- **Opening and closing.** On opening, the highlight starts on the chosen option if the matches hold it. On closing,
  the search is cleared, so the next opening starts fresh, and `onBlur` runs. This is how react-hook-form learns
  the field was "touched", the same as in `DatePicker`.
- **The button.** It has the same box as an input (`controlBoxClass`), like the date picker's button.
  `aria-haspopup="listbox"` replaces the `"dialog"` that `PopoverTrigger` sets: with `asChild`, Radix merges the
  child's own props last, so ours wins. `aria-label` is there for line editors, where the visible label is the
  column header.
- **The popover is as wide as the button** (`--radix-popover-trigger-width`, a CSS variable Radix sets), but at
  least 288px (`min-w-72`). The customer column of a journal line is narrow, and a name with a phone number under
  it needs the room.
- **No matches, or still loading, is a `role="status"` line**, so a screen reader announces "Nothing matches"
  instead of silence. While new matches load, the old ones stay and the list has `aria-busy`.
- **The chosen option has a `brand` `Tick02` icon**, as a dropdown menu's chosen item does: color is never the
  only sign (CLAUDE.md). The rows are `<li>` elements, so they add `cursor-pointer` themselves: the global
  cursor rule only covers buttons and links.

CLAUDE.md's design system lists every control, so the combobox gets its own entry there (15a.8): "If something is
missing, extend this section first, then use it."

```diff
@@ -7,6 +7,7 @@ export { AppShell, NavGroup, NavItem, SidebarNav } from './components/app-shell.
 export { Button, IconButton } from './components/button.js';
 export { Card, CardHeader } from './components/card.js';
 export { Checkbox, CheckboxGroup, type CheckboxOption } from './components/checkbox.js';
+export { Combobox, type ComboboxOption } from './components/combobox.js';
 export {
   DataTable,
   dataTableColumns,
```

> **What we checked in this part.** `packages/i18n` and `packages/ui` type-check, and ESLint and Prettier are clean.
> The i18n unit tests pass (11), and both packages build. The app does not type-check yet. Its remaining errors are
> all the work of 15a.6 and 15a.7: the product and settings forms do not send `taxRateId` and `pricesIncludeVat`,
> the opening balances form has no `partyId`, and the MSW mocks lack the new fields. No error is about a missing
> translation key.

## 15a.6 — `apps/app`: the screens

This part builds every screen the earlier parts made room for: the customers (list, form, page with its
statement), the customer groups, the price lists and their prices, the VAT rates on the Settings page, the "Prices
include VAT" switch, a VAT rate on each product, and a customer on the receivable lines of the journal, the ledger
and the opening balances. Every page follows a page that is already here, so most of the code reads like step 12
and step 13. The notes below cover what is new or different.

The app does not run against MSW yet: the mocks still lack the new routes and fields. That is part 15a.7. Here
the check is the type checker, ESLint and the unit tests.

### `packages/contracts/src/journal.ts`: empty opening lines do not count as twice

While building the opening balances page, one rule of 15a.1 turned out to be too strict. The page shows an empty
customer row under the receivable, and "Add a customer" adds more. Two empty rows have the same key
(`accountId:` with no party), and the contract called that "here twice". The server drops empty lines before it
does anything else, so the check now skips them too. The 15a.1 section above shows the final code and the new test.

### `lib/queries.ts`: the new queries

```diff
@@ -1,6 +1,8 @@
 import {
   type BalanceSheetQuery,
   type BranchStatus,
+  type CustomerSort,
+  type CustomerStatus,
   type JournalStatus,
   type MemberSort,
   type ProductSort,
@@ -549,3 +551,150 @@ export function stockAccountsQuery(tenantId: string) {
     queryFn: () => call(routes.stockAccounts.get),
   });
 }
+
+// ---------------------------------------------------------------------------------------------
+// VAT rates and sales (step 15a)
+
+// A handful of rates, archived ones too: the settings card shows them all, a picker leaves the
+// archived ones out
+export function taxRatesQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['tax-rates', tenantId],
+    queryFn: async () => (await call(routes.taxRates.list)).items,
+  });
+}
+
+// Everything about customers starts with ['customers', tenantId]: saving a customer or a group
+// refreshes the list, the customer's page and the group counts with one invalidate. Posting in the
+// journal changes the balances, so useJournalRefresh invalidates this prefix too.
+export function customerGroupsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['customers', tenantId, 'groups'],
+    queryFn: async () => (await call(routes.customerGroups.list)).items,
+  });
+}
+
+export interface CustomerFilter {
+  search: string;
+  groupId: string;
+  status: CustomerStatus;
+  sort: CustomerSort;
+}
+
+export function customerListQuery(tenantId: string, filter: CustomerFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['customers', tenantId, 'list', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.customers.list, {
+        query: {
+          limit: 50,
+          status: filter.status,
+          sort: filter.sort,
+          ...(filter.search !== '' && { search: filter.search }),
+          ...(filter.groupId !== '' && { groupId: filter.groupId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// The customer picker: the first 20 active customers that match. keepPreviousData: the old
+// matches stay in the list while the next word is searched, so the list does not flash empty.
+export function customerSearchQuery(tenantId: string, search: string) {
+  return queryOptions({
+    queryKey: ['customers', tenantId, 'search', search],
+    queryFn: async () =>
+      (
+        await call(routes.customers.list, {
+          query: { limit: 20, status: 'active', ...(search !== '' && { search }) },
+        })
+      ).items,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function customerQuery(tenantId: string, customerId: string) {
+  return queryOptions({
+    queryKey: ['customers', tenantId, 'customer', customerId],
+    queryFn: () => call(routes.customers.get, { params: { id: customerId } }),
+    retry: false,
+  });
+}
+
+// The statement reads posted journal lines, so it lives under ['journal', tenantId] like the
+// ledger: posting or reversing an entry refreshes it
+export function customerStatementQuery(
+  tenantId: string,
+  customerId: string,
+  from: string,
+  to: string,
+) {
+  return infiniteQueryOptions({
+    queryKey: ['journal', tenantId, 'statement', customerId, from, to],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.customers.statement, {
+        params: { id: customerId },
+        query: {
+          limit: 100,
+          ...(from !== '' && { from }),
+          ...(to !== '' && { to }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// Price lists: everything under ['price-lists', tenantId]. Saving prices changes the list's item
+// count and the items, and one invalidate refreshes both.
+export function priceListsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['price-lists', tenantId, 'all'],
+    queryFn: async () => (await call(routes.priceLists.list)).items,
+  });
+}
+
+export function priceListQuery(tenantId: string, priceListId: string) {
+  return queryOptions({
+    queryKey: ['price-lists', tenantId, 'one', priceListId],
+    queryFn: () => call(routes.priceLists.get, { params: { id: priceListId } }),
+    retry: false,
+  });
+}
+
+export function priceListItemsQuery(tenantId: string, priceListId: string, search: string) {
+  return infiniteQueryOptions({
+    queryKey: ['price-lists', tenantId, 'items', priceListId, search],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.priceLists.items, {
+        params: { id: priceListId },
+        query: {
+          limit: 100,
+          ...(search !== '' && { search }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// The price list's "Add items" search: the first 20 active products that match
+export function productSearchQuery(tenantId: string, search: string) {
+  return queryOptions({
+    queryKey: ['products', tenantId, 'search', search],
+    queryFn: async () =>
+      (
+        await call(routes.products.list, {
+          query: { limit: 20, status: 'active', sort: 'name', ...(search !== '' && { search }) },
+        })
+      ).items,
+    placeholderData: keepPreviousData,
+  });
+}
```

- **Three key prefixes, chosen by what a save must refresh.** `['tax-rates', tenantId]` is read by the Settings
  card and the product form. `['customers', tenantId]` holds the groups, the list, the picker's search and each
  customer: saving a group changes the list's group column, so one invalidate on the prefix refreshes all of them.
  `['price-lists', tenantId]` holds the lists, one list and its items: saving prices changes the list's
  `itemCount` too.
- **The statement lives under `['journal', tenantId]`, not under `customers`.** It reads posted journal lines,
  like the ledger. Posting, reversing or saving the opening balances already invalidates `['journal', tenantId]`,
  so an open statement refreshes without any new code.
- **`customerSearchQuery` is the picker's query**: 20 active customers, searched on the server. It has its own key
  part (`'search'`), apart from the list's filter object, so the picker never reuses a page of the list with
  archived customers in it. `keepPreviousData` keeps the old matches on screen while the next word is searched;
  without it the list would flash empty on every key.
- **`productSearchQuery`** is the same idea for the price list's "Add items" dialog: active products only. An
  archived product is no longer sold, so pricing it would only add rows nobody uses. It sits under
  `['products', tenantId]`, so saving a product refreshes the dialog's matches too.
- **`priceListItemsQuery` loads 100 rows a page.** The rows are editable inputs, not a virtualized table (see the
  price list page below), so a page is kept smaller than a whole list of thousands. The search is part of the key:
  each search has its own pages.

### `components/journal-parts.tsx`: one hook moved here, one refresh more

```diff
@@ -14,6 +14,7 @@ import { Link } from '@tanstack/react-router';
 import { type ReactNode, useCallback } from 'react';
 
 import { ApiRequestError } from '../lib/api';
+import { balanceSide } from '../lib/journal';
 import { journalEntryQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
@@ -32,6 +33,23 @@ export function useIsoDate(): (iso: string) => string {
   );
 }
 
+// "৳12,500.00 Dr" — a balance with its side; zero has none. Moved here from routes/ledger.tsx in
+// step 15a: a customer's statement shows its balances the same way.
+export function useBalanceText(): (value: string) => string {
+  const { t, format } = useLocale();
+  return useCallback(
+    (value: string) => {
+      const { amount, side } = balanceSide(value);
+      const money = format.money(amount, { decimals: 2 });
+      if (side === null) return money;
+      return t(side === 'debit' ? 'ledger.debitBalance' : 'ledger.creditBalance', {
+        amount: money,
+      });
+    },
+    [t, format],
+  );
+}
+
 // Draft, Posted, or Reversed (a posted entry that a later entry undid). Never colour alone: each
 // has its icon and its word.
 export function JournalStatusPill({ entry }: { entry: JournalEntrySummary }) {
@@ -122,5 +140,8 @@ export function useJournalRefresh() {
   return async (saved?: JournalEntry) => {
     if (saved) queryClient.setQueryData(journalEntryQuery(tenantId, saved.id).queryKey, saved);
     await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
+    // A line on the receivable changes what a customer owes (step 15a): the customer list and
+    // pages show the balance
+    await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
   };
 }
```

- **`useBalanceText` moved here from `routes/ledger.tsx`.** The customer's statement shows balances the same way
  ("৳12,500.00 Dr"). A route file is its own lazy chunk; if `routes/customer.tsx` imported from
  `routes/ledger.tsx`, the whole ledger page would be pulled into the customer page's chunk. `journal-parts.tsx`
  is the shared file for this reason (its own first comment says so).
- **`useJournalRefresh` also invalidates `['customers', tenantId]`.** A posted line on the receivable changes what
  a customer owes, and the customer list and page show that balance. Without this line, the list would show the
  old balance until its cache went stale.

### `lib/customers.ts` (new)

```ts
import { absMoney, isNegativeMoney, isZeroMoney, type PartyRef } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { useMemo } from 'react';

// "C-00042 · Rahman Traders": how a line's customer reads (the journal, the picker's choice). Here,
// not in customer-picker.tsx: the entry view shows it without loading the picker.
export function partyLabel(party: PartyRef): string {
  return `${party.code} · ${party.name}`;
}

// "RT" for Rahman Traders: the avatar tile of the list's first column (CLAUDE.md → Table). The
// first letter of the first two words; Array.from splits by code point, so a Bangla name gives
// whole letters, not halves of a surrogate pair.
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
}

// How a customer's terms, limit and balance read: the list and the customer's page say them the
// same way. `decimals`: the list shows whole taka, the page's KPIs too (CLAUDE.md → Money).
export function useCustomerText() {
  const { t, format } = useLocale();
  return useMemo(
    () => ({
      // 0 days = due on receipt
      terms: (days: number) =>
        days === 0 ? t('customers.onReceipt') : t('customers.termsDays', { count: days }),
      // null = no limit; "0.0000" = a real limit of nothing, i.e. cash only
      creditLimit: (limit: string | null) =>
        limit === null
          ? t('customers.noLimit')
          : isZeroMoney(limit)
            ? t('customers.cashOnly')
            : format.money(limit),
      // Debit balance = the customer owes; credit = they paid ahead (an advance, an overpayment)
      balance: (balance: string) =>
        isZeroMoney(balance)
          ? t('customers.settled')
          : isNegativeMoney(balance)
            ? t('customers.inAdvance', { amount: format.money(absMoney(balance)) })
            : t('customers.owes', { amount: format.money(balance) }),
    }),
    [t, format],
  );
}
```

- **`partyLabel` is here, not in the picker's file.** The journal entry view shows a line's customer as
  "C-00042 · Rahman Traders". If it imported the function from `customer-picker.tsx`, the view's chunk would load
  that module and, with it, the combobox and the search query, which a read-only page never uses.
- **`initialsOf` uses `Array.from(word)[0]`**, not `word[0]`. `word[0]` is one UTF-16 unit. For most Bangla letters
  that is a whole letter, but for characters outside the basic plane it is half of one, and the tile would show a
  broken glyph. `Array.from` splits by code point.
- **`useCustomerText` is one place for three readings**: terms (`0` → "On receipt"), credit limit (`null` → "No
  limit", `"0.0000"` → "Cash only", see 15a.5) and balance (positive → "Owes ৳…", negative → "৳… in advance",
  zero → "Nothing owed"). The list and the customer page must say the same thing; written twice, they would drift.
  `useMemo` on `[t, format]` keeps the object stable, so the list's `columns` memo does not rebuild on every render.
- **No decimals here.** Lists and KPIs show whole taka (CLAUDE.md → Money). The statement, an accounting document,
  shows paisa through `useBalanceText`.

### `components/customer-picker.tsx` (new)

```tsx
import { UserIcon } from '@hugeicons/core-free-icons';
import type { PartyRef } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Combobox, type ComboboxOption } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type Ref, useMemo, useState } from 'react';

import { partyLabel } from '../lib/customers';
import { customerSearchQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

interface CustomerPickerProps {
  id: string;
  name?: string;
  // The chosen customer's id, or '' for none
  value: string;
  // The customer the line was saved with, so the box can name it before any search ran
  saved: PartyRef | null;
  onChange: (value: string) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLButtonElement>;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
}

// The customer box of a journal line and of the opening balances (step 15a): ui's Combobox with
// the search on the server. Active customers only, like the API takes them on a new line.
// `...box`: id, name, onBlur, ref and the aria props go to the Combobox as they came. Spread, not
// one by one: with exactOptionalPropertyTypes, `name={name}` would pass an explicit undefined.
export function CustomerPicker({ value, saved, onChange, ...box }: CustomerPickerProps) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const { data, isFetching } = useQuery(customerSearchQuery(tenantId, settled));
  // The label of what was picked here. A row keeps its own picker (React's key), so a removed row
  // never hands its label to the next one.
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);

  const options = useMemo<ComboboxOption[]>(
    () =>
      (data ?? []).map((customer) => ({
        value: customer.id,
        label: customer.name,
        detail: [customer.code, customer.phone].filter((part) => part !== null).join(' · '),
      })),
    [data],
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
        const customer = data?.find((item) => item.id === next);
        setPicked({ value: next, label: customer ? partyLabel(customer) : option.label });
        onChange(next);
      }}
      // Searching for the next word: the old matches stay, marked busy
      loading={isFetching}
      icon={UserIcon}
      placeholder={t('journal.customerPlaceholder')}
      searchPlaceholder={t('customers.pickerSearch')}
      emptyText={t('customers.pickerEmpty')}
    />
  );
}
```

The app's wrapper around 15a.5's `Combobox`: it knows the API, the combobox does not.

- **`...box` is spread, not passed prop by prop.** The workspace uses `exactOptionalPropertyTypes`: writing
  `name={name}` when `name` may be `undefined` is a type error, because the combobox's `name?: string` does not
  accept an explicit `undefined`. A rest object leaves out what was not given, so the spread passes only what
  exists. This is the same reason `FormField` hands its control props as one object.
- **`saved` names the customer the line was saved with.** The options are only the last search's matches. A saved
  draft's line has its customer as `{ id, code, name }` (15a.1's `partyRef`), and without this prop the button
  would show nothing until the person searched for that customer.
- **`picked` remembers the label of a choice made here.** After a choice, the next search may not include that
  customer any more, and `saved` holds the old one. `picked` is checked first, and only when its `value` is the
  current value: if the form clears the field (the account changed), the old label is not shown.
- **The label is taken from `data`, not parsed from the option.** The option's `label` is the name and its
  `detail` is "code · phone". Building "C-00042 · Rahman Traders" from the customer object avoids splitting text
  that a phone number could break.
- **Active customers only**, by the query. The server refuses an archived customer on a line
  (`journal_party_invalid`), so offering one would only lead to an error.

### `router.tsx` and `routes/app-shell.tsx`: the Sales pages

```diff
@@ -332,6 +332,51 @@ const stockReorderRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/stock-reorder'), 'StockReorderPage'),
 });
 
+// Sales (step 15a): customers, their groups, price lists. '/customers/new' beats
+// '/customers/$customerId', like the products. The new and edit pages have a file of their own
+// (routes/customer-edit.tsx), so the form does not load the statement's table and date pickers.
+const customersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/customers',
+  component: lazyRouteComponent(() => import('./routes/customers'), 'CustomersPage'),
+});
+
+const newCustomerRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/customers/new',
+  component: lazyRouteComponent(() => import('./routes/customer-edit'), 'NewCustomerPage'),
+});
+
+const customerRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/customers/$customerId',
+  component: lazyRouteComponent(() => import('./routes/customer'), 'CustomerPage'),
+});
+
+const editCustomerRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/customers/$customerId/edit',
+  component: lazyRouteComponent(() => import('./routes/customer-edit'), 'EditCustomerPage'),
+});
+
+const customerGroupsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/customer-groups',
+  component: lazyRouteComponent(() => import('./routes/customer-groups'), 'CustomerGroupsPage'),
+});
+
+const priceListsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/price-lists',
+  component: lazyRouteComponent(() => import('./routes/price-lists'), 'PriceListsPage'),
+});
+
+const priceListRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/price-lists/$priceListId',
+  component: lazyRouteComponent(() => import('./routes/price-list'), 'PriceListPage'),
+});
+
 const customFieldsRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/custom-fields',
@@ -410,6 +455,13 @@ const routeTree = rootRoute.addChildren([
     stockRevaluationsRoute,
     newStockRevaluationRoute,
     stockRevaluationRoute,
+    customersRoute,
+    newCustomerRoute,
+    customerRoute,
+    editCustomerRoute,
+    customerGroupsRoute,
+    priceListsRoute,
+    priceListRoute,
     customFieldsRoute,
     teamRoute,
     rolesRoute,
```

- **`/customers/new` beats `/customers/$customerId`**: TanStack ranks a fixed segment above a parameter, as with
  the products. `/customers/$customerId/edit` is a route of its own, so the customer's page reads without the
  form's code, and the browser's Back button goes from the form to the page.
- **New and edit have a file of their own, `routes/customer-edit.tsx`**, apart from the page (`routes/customer.tsx`).
  The products keep all three in one file, but the customer's page has a statement with a data table and two date
  pickers, which the form never uses. With the three in one file, opening "Add customer" loaded all of that too, and
  the form's route measured 121.5 KB against the 100 KB budget (`pnpm test:bundle-size`, found in 15a.8). Split,
  it is 66.8 KB (the new and edit pages' own chunk 22.8 KB). The form itself stays a lazy chunk (like the product form), so the page, the most common view,
  loads without react-hook-form and the money input.

```diff
@@ -25,11 +25,14 @@ import {
   Settings02Icon,
   Store01Icon,
   TableIcon,
+  Tag01Icon,
   TaskEdit01Icon,
   TextIcon,
   UnfoldMoreIcon,
   UserCircleIcon,
+  UserGroup03Icon,
   UserGroupIcon,
+  UserMultiple02Icon,
   WarehouseIcon,
   WorkHistoryIcon,
 } from '@hugeicons/core-free-icons';
@@ -291,6 +294,19 @@ export function AppShell() {
               </NavLink>
             </NavGroup>
           )}
+          {/* Sales (step 15a): everyone reads the customers and the price lists — every sales
+              document picks them. Changing them is checked on the pages and by the API. */}
+          <NavGroup label={t('nav.sales')}>
+            <NavLink to="/customers" icon={UserMultiple02Icon}>
+              {t('nav.customers')}
+            </NavLink>
+            <NavLink to="/customer-groups" icon={UserGroup03Icon}>
+              {t('nav.customerGroups')}
+            </NavLink>
+            <NavLink to="/price-lists" icon={Tag01Icon}>
+              {t('nav.priceLists')}
+            </NavLink>
+          </NavGroup>
           {/* Every member reads products (every sales and stock line picks one); imports change
               them, so only managers see that page */}
           <NavGroup label={t('nav.inventory')}>
```

- **A Sales group between Reports and Inventory.** Steps 15b–15d add quotations, orders, invoices and returns to
  it. Selling comes before the stock pages in a distributor's day.
- **No permission check on the links.** Reading customers and price lists needs no permission (15a.1): every sales
  document picks them. The pages hide what the person may not do.
- **No `exact` on Customers.** `/customers/…` (a customer's page) keeps the item active. `/customer-groups` is a
  different first segment, so it never matches Customers.

### `routes/customers.tsx` (new): the list

```tsx
import { PlusSignIcon, Search01Icon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CUSTOMER_STATUSES,
  type CustomerSort,
  type CustomerStatus,
  type CustomerSummary,
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

import { initialsOf, useCustomerText } from '../lib/customers';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery, customerListQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

const column = dataTableColumns<CustomerSummary>();

// The customer column sorts by name; the server keeps a stable order (name, then id)
function sortOf(state: SortingState): CustomerSort {
  const [first] = state;
  return first?.id === 'name' && first.desc ? '-name' : 'name';
}

export function CustomersPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canManage = can('sales.customer.manage');
  // The column is left out without the permission, instead of a column of dashes
  const canSeeBalance = can('sales.customer.balance');
  const text = useCustomerText();
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState<CustomerStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const settled = useDebounced(search.trim());
  const filter = { search: settled, groupId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    customerListQuery(tenantId, filter),
  );
  const groups = useQuery(customerGroupsQuery(tenantId)).data;
  const customers = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
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
          header: t('customers.columns.customer'),
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
          header: t('customers.columns.phone'),
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
          header: t('customers.columns.group'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const id = getValue();
            return id === null ? '—' : (groupName.get(id) ?? '—');
          },
        }),
        column.accessor('paymentTermsDays', {
          header: t('customers.columns.terms'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => text.terms(getValue()),
        }),
        column.accessor('creditLimit', {
          header: t('customers.columns.creditLimit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => text.creditLimit(getValue()),
        }),
        ...(canSeeBalance
          ? [
              column.accessor((customer) => customer.balance ?? '0', {
                id: 'balance',
                header: t('customers.columns.balance'),
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
        title={t('customers.noMatchTitle', { query: settled })}
        description={t('customers.noMatchBody')}
      />
    ) : status === 'archived' ? (
      <EmptyState
        icon={UserMultiple02Icon}
        title={t('customers.archivedEmptyTitle')}
        description={t('customers.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={UserMultiple02Icon}
        title={t('customers.emptyTitle')}
        description={t('customers.emptyBody')}
        action={
          canManage &&
          groupId === '' && (
            <Button onClick={() => void navigate({ to: '/customers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customers.add')}
            </Button>
          )
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('customers.title')}
        description={t('customers.description')}
        actions={
          canManage && (
            <Button onClick={() => void navigate({ to: '/customers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customers.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('customers.searchLabel')}
            placeholder={t('customers.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('customers.group')}
            options={[
              { value: '', label: t('customers.allGroups') },
              ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
            ]}
            value={groupId}
            onChange={(event) => {
              setGroupId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('customers.show')}
          value={status}
          options={CUSTOMER_STATUSES.map((value) => ({
            value,
            label: t(`customers.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('customers.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('customers.loadFailed')}</p>}
      {customers && (
        <DataTable
          label={t('customers.title')}
          data={customers}
          columns={columns}
          getRowId={(customer) => customer.id}
          sorting={{ state: sorting, onChange: setSorting }}
          onRowClick={(customer) =>
            void navigate({ to: '/customers/$customerId', params: { customerId: customer.id } })
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

The products list of step 12, with the customer's own columns.

- **`canSeeBalance` removes the Balance column**, not just its values. Without `sales.customer.balance` the server
  sends `balance: null` for every row; a column of dashes would take room and still hint at a number.
- **One sortable column, by name.** The customer cell shows the code under the name, so sorting by code would sort
  by something the column does not lead with. The server keeps a stable order (name, then id), so pages never
  overlap.
- **The first column is the avatar tile** (CLAUDE.md → Table): 30px, `brand-soft` with `brand` initials,
  `aria-hidden` because the name next to it already says it.
- **The phone cell carries the contact person** as a sub-line. A sales officer looks for "the dealer whose manager
  is Kamal"; the search finds the contact person too (15a.2's trigram index).
- **`groupName` is a `Map`**, built once per groups load, so each row's group lookup is not a search through the
  array.
- **The empty state's "Add customer" shows only with no group filter.** With a filter, "no customers" means "none
  in this group", and adding one from there would not put it in the group.

### `components/customer-form.tsx` (new)

```tsx
import {
  Call02Icon,
  Delete02Icon,
  Mail01Icon,
  PlusSignIcon,
  TruckDeliveryIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADDRESS_KINDS,
  contractErrorMap,
  type Customer,
  type CustomerGroup,
  MAX_CUSTOMER_ADDRESSES,
  MAX_PAYMENT_TERMS_DAYS,
  type PriceList,
  routes,
  updateCustomerInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { applyApiError } from '../lib/field-errors';
import { call } from '../lib/api';
import { rowPath } from '../lib/products';
import { customerQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The customer form: a chunk of its own (loaded by routes/customer.tsx), like the product form.
// The schema is the contract's own, so the form refuses what the API refuses, in the same words.

type FormValues = z.input<typeof updateCustomerInputSchema>;
type AddressValues = FormValues['addresses'][number];

// A customer as the form holds it: '' for every empty box. A new customer is due on receipt and
// has no limit until someone sets them.
function valuesOf(customer: Customer | null): FormValues {
  return {
    code: customer?.code ?? '',
    name: customer?.name ?? '',
    groupId: customer?.groupId ?? '',
    contactPerson: customer?.contactPerson ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    bin: customer?.bin ?? '',
    paymentTermsDays: customer?.paymentTermsDays ?? 0,
    // "0.0000" stays: a limit of nothing is cash only, not "no limit"
    creditLimit: customer?.creditLimit ?? '',
    priceListId: customer?.priceListId ?? '',
    notes: customer?.notes ?? '',
    addresses:
      customer?.addresses.map((address) => ({
        id: address.id,
        // An unknown kind from a newer server reads as shipping, the harmless one
        kind: ADDRESS_KINDS.find((kind) => kind === address.kind) ?? 'shipping',
        label: address.label ?? '',
        address: address.address,
        phone: address.phone ?? '',
      })) ?? [],
    // A new customer has no version; 1 passes the schema, and the create route never reads it
    version: customer?.version ?? 1,
  };
}

// Every field the server may name in an error, so it lands under the right box
function fieldNames(addressCount: number): Path<FormValues>[] {
  return [
    'code',
    'name',
    'groupId',
    'contactPerson',
    'phone',
    'email',
    'bin',
    'paymentTermsDays',
    'creditLimit',
    'priceListId',
    'notes',
    'addresses',
    ...Array.from({ length: addressCount }, (_, index) => [
      rowPath('addresses', index, 'kind'),
      rowPath('addresses', index, 'label'),
      rowPath('addresses', index, 'address'),
      rowPath('addresses', index, 'phone'),
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

export function CustomerForm({
  customer,
  groups,
  priceLists,
  canManage,
}: {
  customer: Customer | null;
  groups: CustomerGroup[];
  // All of them, archived ones too: the customer's own list stays in the select if it was
  // archived since (like an archived unit on a product), and the server keeps it on save
  priceLists: PriceList[];
  canManage: boolean;
}) {
  const { t, errorText } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateCustomerInputSchema, { error: contractErrorMap }),
    defaultValues: valuesOf(customer),
  });
  const addressArray = useFieldArray({ control, name: 'addresses' });
  const addresses = useWatch({ control, name: 'addresses' });
  // The first shipping address is the default on a delivery (step 15b): the form says so
  const defaultShipping = addresses.findIndex((address) => address.kind === 'shipping');

  const priceListOptions = [
    { value: '', label: t('customers.fields.noPriceList') },
    ...priceLists
      .filter((list) => list.archivedAt === null || list.id === customer?.priceListId)
      .map((list) => ({ value: list.id, label: list.name })),
  ];

  // The first address is the billing one; after that, shipping addresses (one billing only)
  const newAddress = (): AddressValues => ({
    id: null,
    kind: addresses.some((address) => address.kind === 'billing') ? 'shipping' : 'billing',
    label: '',
    address: '',
    phone: '',
  });

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = customer
        ? await call(routes.customers.update, {
            params: { id: customer.id },
            body: { ...values, version },
          })
        : await call(routes.customers.create, { body: values });
      queryClient.setQueryData(customerQuery(tenantId, saved.id).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      toast(t(customer ? 'customers.updated' : 'customers.created', { name: saved.name }));
      // To the customer's page; replace: Back from there goes to the list, not to the form
      void navigate({
        to: '/customers/$customerId',
        params: { customerId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(getValues('addresses').length), setError);
    }
  });

  const addressesError = errors.addresses?.root?.message ?? errors.addresses?.message;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      {customer ? (
        <Link
          to="/customers/$customerId"
          params={{ customerId: customer.id }}
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {customer.name}
        </Link>
      ) : (
        <Link
          to="/customers"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('customers.back')}
        </Link>
      )}
      <PageHeader
        title={
          customer ? t('customers.editTitle', { code: customer.code }) : t('customers.newTitle')
        }
        description={customer?.name}
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('customers.readOnly')}</p>}
      <form noValidate onSubmit={(event) => void onSubmit(event)}>
        {/* Without the permission the same page reads, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}

          <SectionCard title={t('customers.sections.basics')}>
            <TextField
              label={t('customers.fields.name')}
              icon={UserIcon}
              placeholder={t('customers.fields.namePlaceholder')}
              {...register('name')}
              error={errors.name?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('customers.fields.code')}
                hint={customer ? undefined : t('customers.fields.codeHint')}
                optional={!customer}
                autoCapitalize="characters"
                spellCheck={false}
                {...register('code')}
                error={errors.code?.message}
              />
              <SelectField
                label={t('customers.fields.group')}
                options={[
                  { value: '', label: t('customers.fields.noGroup') },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                ]}
                {...register('groupId')}
                error={errors.groupId?.message}
              />
              <TextField
                label={t('customers.fields.contactPerson')}
                optional
                placeholder={t('customers.fields.contactPersonPlaceholder')}
                {...register('contactPerson')}
                error={errors.contactPerson?.message}
              />
              <TextField
                label={t('customers.fields.phone')}
                optional
                type="tel"
                icon={Call02Icon}
                placeholder="01711-234567"
                {...register('phone')}
                error={errors.phone?.message}
              />
              <TextField
                label={t('customers.fields.email')}
                optional
                type="email"
                icon={Mail01Icon}
                placeholder="accounts@rahmantraders.com.bd"
                {...register('email')}
                error={errors.email?.message}
              />
              <TextField
                label={t('customers.fields.bin')}
                optional
                inputMode="numeric"
                hint={t('customers.fields.binHint')}
                placeholder="000123456-0101"
                {...register('bin')}
                error={errors.bin?.message}
              />
            </div>
            <TextAreaField
              label={t('customers.fields.notes')}
              optional
              placeholder={t('customers.fields.notesPlaceholder')}
              {...register('notes')}
              error={errors.notes?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('customers.sections.terms')}
            subtitle={t('customers.sections.termsHint')}
            className="sm:grid-cols-2 sm:gap-x-4"
          >
            <TextField
              label={t('customers.fields.paymentTerms')}
              hint={t('customers.fields.paymentTermsHint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_PAYMENT_TERMS_DAYS}
              suffix={t('customers.fields.days')}
              // valueAsNumber: the contract takes a number of days, not the box's text
              {...register('paymentTermsDays', { valueAsNumber: true })}
              error={errors.paymentTermsDays?.message}
            />
            <FormField
              control={control}
              name="creditLimit"
              label={t('customers.fields.creditLimit')}
              hint={t('customers.fields.creditLimitHint')}
              optional
            >
              {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
            </FormField>
            <SelectField
              label={t('customers.fields.priceList')}
              options={priceListOptions}
              {...register('priceListId')}
              error={errors.priceListId?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('customers.sections.addresses')}
            subtitle={t('customers.sections.addressesHint')}
          >
            {addressArray.fields.length === 0 && (
              <p className="text-body-sm text-ink-3">{t('customers.addresses.empty')}</p>
            )}
            {addressArray.fields.length > 0 && (
              <ul aria-label={t('customers.sections.addresses')} className="grid gap-3">
                {addressArray.fields.map((row, index) => {
                  const number = index + 1;
                  const rowErrors = errors.addresses?.[index];
                  return (
                    <li
                      key={row.id}
                      role="group"
                      aria-label={t('customers.addresses.number', { number })}
                      className="grid grid-cols-1 gap-4 rounded-control border border-line p-4 sm:grid-cols-2 sm:gap-x-4"
                    >
                      <div className="flex items-center justify-between gap-3 sm:col-span-2">
                        <span className="flex flex-wrap items-center gap-2 text-label font-medium text-ink-2">
                          {t('customers.addresses.number', { number })}
                          {index === defaultShipping && (
                            <Pill tone="brand" icon={TruckDeliveryIcon}>
                              {t('customers.addresses.defaultShipping')}
                            </Pill>
                          )}
                        </span>
                        <IconButton
                          icon={Delete02Icon}
                          label={t('customers.addresses.remove', { number })}
                          onClick={() => {
                            addressArray.remove(index);
                          }}
                        />
                      </div>
                      <SelectField
                        id={rowPath('addresses', index, 'kind')}
                        label={t('customers.addresses.kind')}
                        options={ADDRESS_KINDS.map((kind) => ({
                          value: kind,
                          label: t(`customers.addresses.kinds.${kind}`),
                        }))}
                        {...register(rowPath('addresses', index, 'kind'))}
                        error={rowErrors?.kind?.message}
                      />
                      <TextField
                        id={rowPath('addresses', index, 'label')}
                        label={t('customers.addresses.label')}
                        optional
                        placeholder={t('customers.addresses.labelPlaceholder')}
                        {...register(rowPath('addresses', index, 'label'))}
                        error={rowErrors?.label?.message}
                      />
                      <div className="sm:col-span-2">
                        <TextAreaField
                          id={rowPath('addresses', index, 'address')}
                          label={t('customers.addresses.address')}
                          placeholder="House 12, Road 7, Sector 4, Uttara, Dhaka 1230"
                          {...register(rowPath('addresses', index, 'address'))}
                          error={rowErrors?.address?.message}
                        />
                      </div>
                      <TextField
                        id={rowPath('addresses', index, 'phone')}
                        label={t('customers.addresses.phone')}
                        optional
                        type="tel"
                        icon={Call02Icon}
                        {...register(rowPath('addresses', index, 'phone'))}
                        error={rowErrors?.phone?.message}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {addressesError && <p className="text-label text-crit">{errorText(addressesError)}</p>}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={addressArray.fields.length >= MAX_CUSTOMER_ADDRESSES}
                onClick={() => {
                  addressArray.append(newAddress());
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('customers.addresses.add')}
              </Button>
            </div>
          </SectionCard>

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void (customer
                    ? navigate({
                        to: '/customers/$customerId',
                        params: { customerId: customer.id },
                      })
                    : navigate({ to: '/customers' }))
                }
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('common.saving')
                  : customer
                    ? t('customers.save')
                    : t('customers.create')}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}
```

- **The resolver is `updateCustomerInputSchema`** (the contract's schema plus `version`), for new customers too.
  A new customer gets `version: 1`, which passes the schema, and the create route never reads it. One form, one
  type (`FormValues`), and the billing rule (`superRefine`) runs before anything is sent.
- **`valuesOf` turns `null` into `''`** for every box: an `<input>` cannot hold `null`. The contract turns `''`
  back into `null` (`optionalText`, `optionalIdSchema`). `creditLimit` keeps `"0.0000"`: zero is "cash only", and
  turning it into `''` would save "no limit" instead.
- **An unknown address kind reads as `shipping`.** `kind` is a plain string in the response (a newer server may
  add a kind). Shipping is the harmless choice: a second "billing" would make the form refuse to save.
- **`fieldNames` lists every path the server can name**, including `addresses.N.kind` for each row. The server's
  `customer_billing_twice` and `customer_address_required` then land under the right box instead of the top.
- **`paymentTermsDays` uses `valueAsNumber`.** The contract takes a number of days. Without it, react-hook-form
  would send the box's text ("30") and the schema would refuse it.
- **The price list select keeps the customer's own list if it was archived** (`list.id === customer?.priceListId`).
  Otherwise the select would silently show "The products' own prices", and saving would remove the list. The
  server accepts an unchanged archived list (15a.3).
- **`newAddress` makes the first address billing and the rest shipping.** One billing address is the rule; the
  person rarely has to change the kind.
- **`defaultShipping` is the first shipping row in the form's current order.** The pill moves when the person
  changes a kind, so it always says which address a delivery (15b) will start with.
- **After saving, `navigate(…, replace: true)` to the customer's page.** The saved customer goes into its query's
  cache first (`setQueryData`), so the page shows it at once. `replace` keeps Back from returning to the form.
- **`<fieldset disabled={!canManage}>`**: someone without the permission who opens the address sees every box
  disabled, the same way the product form works.

### `components/customer-parts.tsx` (new)

```tsx
import { AlertCircleIcon, ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { useSession } from '../lib/session-store';

// Shared by the customer's page and its form pages. Here, not in a route file: a route file is its
// own lazy chunk, and importing from one would pull that whole page into the others.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

export function BackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/customers"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('customers.back')}
    </Link>
  );
}

export function CustomerNotFound() {
  const { t } = useLocale();
  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <EmptyState
        icon={AlertCircleIcon}
        title={t('customers.title')}
        description={t('customers.notFound')}
      />
    </div>
  );
}
```

The back link, the "doesn't exist" view and `useTenantId()` are used by the customer's page and by its form pages.
They live here, not in either route file, for the reason `stock-parts.tsx` gives: a route file is its own lazy
chunk, and importing from it pulls that whole page into the other one. This is exactly how the form's route went
over budget (see `router.tsx` above).

### `routes/customer-edit.tsx` (new): the new and edit pages

```tsx
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { CustomerNotFound, useTenantId } from '../components/customer-parts';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery, customerQuery, priceListsQuery } from '../lib/queries';

// The new and edit pages, apart from the customer's page (routes/customer.tsx): that page's
// statement brings the data table and the date pickers, which the form never uses. In one file,
// the form's route went over its 100 KB budget (121.5 KB).

// The page loads the data; the form is a lazy chunk of its own (the form library and the money
// input are only needed to write), like the product form
const CustomerForm = lazy(async () => ({
  default: (await import('../components/customer-form')).CustomerForm,
}));

// What the form needs besides the customer: the groups and the price lists to pick from
function useFormData() {
  const tenantId = useTenantId();
  const groups = useQuery(customerGroupsQuery(tenantId)).data;
  const priceLists = useQuery(priceListsQuery(tenantId)).data;
  return { groups, priceLists };
}

export function NewCustomerPage() {
  const canManage = useCan()('sales.customer.manage');
  const { groups, priceLists } = useFormData();
  if (!groups || !priceLists) return null;
  return (
    <Suspense fallback={null}>
      <CustomerForm customer={null} groups={groups} priceLists={priceLists} canManage={canManage} />
    </Suspense>
  );
}

export function EditCustomerPage() {
  const { customerId = '' } = useParams({ strict: false });
  const canManage = useCan()('sales.customer.manage');
  const { groups, priceLists } = useFormData();
  const { data: customer, isError } = useQuery({
    ...customerQuery(useTenantId(), customerId),
    enabled: customerId !== '',
  });
  if (isError) return <CustomerNotFound />;
  if (!customer || !groups || !priceLists) return null;
  return (
    <Suspense fallback={null}>
      {/* key: a customer saved elsewhere comes back with a new version; start from it again */}
      <CustomerForm
        key={`${customer.id}-${String(customer.version)}`}
        customer={customer}
        groups={groups}
        priceLists={priceLists}
        canManage={canManage}
      />
    </Suspense>
  );
}
```

- **Two exports, one small chunk.** `NewCustomerPage` and `EditCustomerPage` load what the form needs (the groups
  and all price lists) and render the lazy `CustomerForm`. Nothing here imports the statement's table or date
  pickers.
- **`key={`${customer.id}-${version}`}` on the edit form**: if the customer is saved elsewhere and refetched, the
  form starts again from the new version instead of keeping stale values and failing with `version_conflict`.

### `routes/customer.tsx` (new): the customer's page

```tsx
import {
  Archive02Icon,
  Location01Icon,
  Notebook02Icon,
  PencilEdit02Icon,
  TruckDeliveryIcon,
  UserSwitchIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Customer,
  DEFAULT_SETTINGS,
  type LedgerLine,
  routes,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  FormAlert,
  KpiStrip,
  PageHeader,
  Pill,
  SectionHeader,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { BackLink, CustomerNotFound, useTenantId } from '../components/customer-parts';
import { failureOf, useBalanceText, useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { useCustomerText } from '../lib/customers';
import { fiscalYearStart } from '../lib/journal';
import { useCan } from '../lib/permissions';
import {
  customerGroupsQuery,
  customerQuery,
  customerStatementQuery,
  priceListsQuery,
  settingsQuery,
} from '../lib/queries';

// One label and its value in the details card; an empty value is a dash, so the rows line up
function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-1 gap-0.5">
      <dt className="text-label text-ink-3">{label}</dt>
      <dd className="text-body-sm break-words text-ink">{value ?? '—'}</dd>
    </div>
  );
}

const column = dataTableColumns<LedgerLine>();

// The customer's receivable lines with a running balance: the ledger of one account, cut down
// to one customer. Dates as on the ledger: this fiscal year to today until the person picks.
function Statement({ customerId }: { customerId: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const canReadJournal = useCan()('accounting.journal.read');
  const showDate = useIsoDate();
  const balanceText = useBalanceText();
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
    customerStatementQuery(tenantId, customerId, from, to),
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
    <section className="grid grid-cols-1 gap-4" aria-label={t('customers.statementTitle')}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeader
          title={t('customers.statementTitle')}
          subtitle={t('customers.statementSubtitle')}
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
      {isError && <p className="text-body-sm text-crit">{t('customers.statementLoadFailed')}</p>}
      {lines && (
        <DataTable
          label={t('customers.statementTitle')}
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
              title={t('customers.statementEmptyTitle')}
              description={t('customers.statementEmptyBody')}
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

function CustomerView({ customer }: { customer: Customer }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const can = useCan();
  const canManage = can('sales.customer.manage');
  const text = useCustomerText();
  const [confirming, setConfirming] = useState(false);
  const groups = useQuery(customerGroupsQuery(tenantId)).data;
  const priceLists = useQuery(priceListsQuery(tenantId)).data;
  const group = groups?.find((item) => item.id === customer.groupId);
  const priceList = priceLists?.find((item) => item.id === customer.priceListId);

  const toggle = useMutation({
    mutationFn: () =>
      call(customer.archivedAt === null ? routes.customers.archive : routes.customers.restore, {
        params: { id: customer.id },
        body: { version: customer.version },
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(customerQuery(tenantId, saved.id).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      toast(
        t(saved.archivedAt === null ? 'customers.restoredToast' : 'customers.archivedToast', {
          name: saved.name,
        }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.customers.remove, {
        params: { id: customer.id },
        query: { version: customer.version },
      }),
    onSuccess: async () => {
      // To the list first: the deleted customer's own query would otherwise refetch into a 404
      await navigate({ to: '/customers' });
      queryClient.removeQueries({ queryKey: customerQuery(tenantId, customer.id).queryKey });
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      toast(t('customers.deleted', { name: customer.name }));
    },
  });
  // customer_in_use, version_conflict: they belong to no field
  const failure = failureOf(toggle.error) ?? failureOf(remove.error);
  const busy = toggle.isPending || remove.isPending;

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <PageHeader
        title={customer.name}
        description={<span className="font-mono tabular-nums">{customer.code}</span>}
        actions={
          canManage && (
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
                  ? t('customers.confirmDelete', { code: customer.code })
                  : t('customers.delete')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  toggle.mutate();
                }}
              >
                {customer.archivedAt === null ? t('customers.archive') : t('customers.restore')}
              </Button>
              <Button
                onClick={() =>
                  void navigate({
                    to: '/customers/$customerId/edit',
                    params: { customerId: customer.id },
                  })
                }
              >
                <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
                {t('customers.edit')}
              </Button>
            </>
          )
        }
      />
      {confirming && <p className="text-body-sm text-ink-2">{t('customers.deleteWarning')}</p>}
      {failure && <FormAlert message={failure} />}
      {(customer.archivedAt !== null || customer.isSupplier) && (
        <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
          {customer.archivedAt !== null && (
            <>
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('customers.statuses.archived')}
              </Pill>
              <span>{t('customers.archivedNotice')}</span>
            </>
          )}
          {customer.isSupplier && (
            <Pill tone="brand" icon={UserSwitchIcon}>
              {t('customers.alsoSupplier')}
            </Pill>
          )}
        </div>
      )}
      <KpiStrip
        cells={[
          // Without sales.customer.balance the server sends null: the group takes the place
          customer.balance === null
            ? { label: t('customers.fields.group'), value: group?.name ?? '—' }
            : { label: t('customers.kpis.balance'), value: text.balance(customer.balance) },
          { label: t('customers.kpis.creditLimit'), value: text.creditLimit(customer.creditLimit) },
          { label: t('customers.kpis.terms'), value: text.terms(customer.paymentTermsDays) },
        ]}
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('customers.details')} />
          <dl className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <Detail label={t('customers.fields.contactPerson')} value={customer.contactPerson} />
            <Detail label={t('customers.fields.phone')} value={customer.phone} />
            <Detail label={t('customers.fields.email')} value={customer.email} />
            <Detail label={t('customers.fields.bin')} value={customer.bin} />
            <Detail label={t('customers.fields.group')} value={group?.name ?? null} />
            <Detail
              label={t('customers.fields.priceList')}
              value={priceList?.name ?? t('customers.fields.noPriceList')}
            />
            {customer.notes && (
              <div className="sm:col-span-2">
                <Detail label={t('customers.fields.notes')} value={customer.notes} />
              </div>
            )}
          </dl>
        </Card>
        <Card>
          <CardHeader title={t('customers.sections.addresses')} />
          {customer.addresses.length === 0 ? (
            <p className="p-5 text-body-sm text-ink-3">{t('customers.noAddresses')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 p-5">
              {customer.addresses.map((address) => {
                // The billing address comes first (the server's order), then the shipping ones;
                // the first shipping address is the default on a delivery
                const isDefault =
                  address.kind === 'shipping' &&
                  customer.addresses.find((item) => item.kind === 'shipping') === address;
                return (
                  <li key={address.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                    <HugeiconsIcon
                      icon={address.kind === 'billing' ? Location01Icon : TruckDeliveryIcon}
                      size={18}
                      strokeWidth={1.5}
                      className="mt-0.5 text-ink-3"
                    />
                    <div className="grid gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-body-sm font-medium">
                        {address.kind === 'billing' || address.kind === 'shipping'
                          ? t(`customers.addresses.kinds.${address.kind}`)
                          : address.kind}
                        {address.label && <span className="text-ink-3">· {address.label}</span>}
                        {isDefault && (
                          <Pill tone="brand" icon={TruckDeliveryIcon}>
                            {t('customers.addresses.defaultShipping')}
                          </Pill>
                        )}
                      </span>
                      <span className="text-body-sm whitespace-pre-line text-ink-2">
                        {address.address}
                      </span>
                      {address.phone && (
                        <span className="text-caption text-ink-3 tabular-nums">
                          {address.phone}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      {/* The same rule as the balance: what a customer owes is not every cashier's business */}
      {can('sales.customer.balance') && <Statement customerId={customer.id} />}
    </div>
  );
}

export function CustomerPage() {
  const { customerId = '' } = useParams({ strict: false });
  const { data: customer, isError } = useQuery({
    ...customerQuery(useTenantId(), customerId),
    enabled: customerId !== '',
  });
  if (isError) return <CustomerNotFound />;
  if (!customer) return null;
  return <CustomerView customer={customer} />;
}
```

- **The KPI strip always has three cells.** Without `sales.customer.balance` the balance is `null`, and the group
  takes its place: `KpiStrip` lays out three or four cells, and two would leave a hole.
- **Delete takes two clicks**, like products and units: it cannot be undone. On success the page first navigates
  to the list, then removes the customer's query. In the other order, the still-mounted page would refetch the
  deleted customer and flash "doesn't exist".
- **Archive and restore update the cache with the response** (`setQueryData`), so the archived notice appears
  without waiting for a refetch.
- **The addresses card marks the default shipping address** the same way the form does: the first `shipping` in
  the server's order (billing first, then shipping in the order saved, 15a.3).
- **`Statement` is the ledger page cut down to one customer.** Same columns, same default dates (this fiscal year
  to today, in the company's time zone), the same opening/closing card. A row opens its journal entry only for
  someone with `accounting.journal.read`: a sales officer may see what a customer owes, but not the journal.
- **The statement shows only with `sales.customer.balance`.** The route needs that permission (15a.1); without the
  check, the person would see a "couldn't load" error instead of no section.

### `routes/customer-groups.tsx` (new)

```tsx
import { PlusSignIcon, UserGroup03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CustomerGroup,
  customerGroupInputSchema,
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
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<CustomerGroup>();
const FIELD_NAMES = customerGroupInputSchema.keyof().options;

// One form for both: a new group (none given) and a rename. A rename sends the version the dialog
// opened with; the name is all a group has.
function GroupForm({ group, onDone }: { group: CustomerGroup | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(customerGroupInputSchema, { error: contractErrorMap }),
    defaultValues: { name: group?.name ?? '' },
  });

  // ['customers', tenantId]: the list's group column and filter read the groups too
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });

  const remove = useMutation({
    mutationFn: (target: CustomerGroup) =>
      call(routes.customerGroups.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async (_, target) => {
      await refresh();
      toast(t('customerGroups.deleted', { name: target.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = group
        ? await call(routes.customerGroups.update, {
            params: { id: group.id },
            body: { ...values, version: group.version },
          })
        : await call(routes.customerGroups.create, { body: values });
      await refresh();
      toast(t(group ? 'customerGroups.updated' : 'customerGroups.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // customer_group_in_use, version_conflict: they belong to no field
  const failure = errors.root?.server?.message ?? failureOf(remove.error);

  return (
    <DialogContent
      title={
        group ? t('customerGroups.editTitle', { name: group.name }) : t('customerGroups.newTitle')
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
                ? t('customerGroups.confirmDelete', { name: group.name })
                : t('customerGroups.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="customer-group-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : group ? t('common.save') : t('customerGroups.add')}
          </Button>
        </>
      }
    >
      <form
        id="customer-group-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && (
          <p className="text-body-sm text-ink-2">{t('customerGroups.deleteWarning')}</p>
        )}
        <TextField
          label={t('customerGroups.name')}
          icon={UserGroup03Icon}
          placeholder={t('customerGroups.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | CustomerGroup;

export function CustomerGroupsPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('sales.customer.manage');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery(customerGroupsQuery(tenantId));

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('customerGroups.columns.name'),
          meta: { card: 'title' },
          cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
        }),
        column.accessor('customerCount', {
          header: t('customerGroups.columns.customers'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) =>
            t('customerGroups.customerCount', {
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
        title={t('customerGroups.title')}
        description={t('customerGroups.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customerGroups.add')}
            </Button>
          )
        }
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('customerGroups.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('customerGroups.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('customerGroups.title')}
          data={data}
          columns={columns}
          getRowId={(group) => group.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            <EmptyState
              icon={UserGroup03Icon}
              title={t('customerGroups.emptyTitle')}
              description={t('customerGroups.emptyBody')}
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

- **Delete, not archive** (15a.1's decision): a group is only a label. The button is in the dialog's footer, on the
  left, away from Save, and takes two clicks.
- **`customer_group_in_use` shows in the dialog's alert**: the API refuses a group that holds any customer, and the
  message (15a.5) says to move them first. `failureOf` turns the mutation's error into that code.
- **The rename sends `group.version`** from the row that was clicked. Two people renaming one group get
  `version_conflict`, not a silent overwrite.
- **`customerCount` uses `formatted`**: the plural form needs `count` as a number, and the text needs it in the
  current language's digits.

### `components/price-list-form.tsx` (new) and `routes/price-lists.tsx` (new)

```tsx
import { Tag01Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, type PriceList, priceListInputSchema, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  FormAlert,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { priceListQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

const FIELD_NAMES = priceListInputSchema.keyof().options;

// The name and description of a price list: a new one from the list page, a change (with
// Archive or Restore) from the list's own page. Here, not in a route file: both pages use it, and
// a route file is a lazy chunk of its own.
export function PriceListForm({
  priceList,
  onDone,
}: {
  priceList: PriceList | null;
  onDone: (saved: PriceList) => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(priceListInputSchema, { error: contractErrorMap }),
    defaultValues: { name: priceList?.name ?? '', description: priceList?.description ?? '' },
  });

  // The saved list straight into its page's cache, then every price list query refreshed (the
  // list page, and the customer form's select)
  const refresh = async (saved: PriceList) => {
    queryClient.setQueryData(priceListQuery(tenantId, saved.id).queryKey, saved);
    await queryClient.invalidateQueries({ queryKey: ['price-lists', tenantId] });
  };

  const toggle = useMutation({
    mutationFn: (current: PriceList) =>
      call(current.archivedAt === null ? routes.priceLists.archive : routes.priceLists.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh(saved);
      toast(
        t(saved.archivedAt === null ? 'priceLists.restoredToast' : 'priceLists.archivedToast', {
          name: saved.name,
        }),
      );
      onDone(saved);
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = priceList
        ? await call(routes.priceLists.update, {
            params: { id: priceList.id },
            body: { ...values, version: priceList.version },
          })
        : await call(routes.priceLists.create, { body: values });
      await refresh(saved);
      toast(t(priceList ? 'priceLists.updated' : 'priceLists.created', { name: saved.name }));
      onDone(saved);
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={
        priceList ? t('priceLists.editTitle', { name: priceList.name }) : t('priceLists.newTitle')
      }
      footer={
        <>
          {priceList && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(priceList);
              }}
            >
              {priceList.archivedAt === null ? t('priceLists.archive') : t('priceLists.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="price-list-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : priceList ? t('common.save') : t('priceLists.add')}
          </Button>
        </>
      }
    >
      <form
        id="price-list-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('priceLists.name')}
          icon={Tag01Icon}
          placeholder={t('priceLists.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <TextAreaField
          label={t('priceLists.about')}
          optional
          placeholder={t('priceLists.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}
```

- **A component file, not inside a route.** The list page creates lists with it, and the list's own page edits
  them. A route file is its own lazy chunk; importing one route from another would load both pages.
- **`onDone(saved)` hands the saved list back.** The list page uses it to open the new list's page at once: a new
  list is empty, and the next thing to do is add prices.
- **`refresh` writes the list into `priceListQuery`'s cache, then invalidates the prefix.** The open price list
  page shows the new name or the archived notice at once.

```tsx
import { Archive02Icon, PlusSignIcon, Tag01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PriceList } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { PriceListForm } from '../components/price-list-form';
import { useCan } from '../lib/permissions';
import { priceListsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<PriceList>();

// The API sends every list at once (a workspace has a few): active and archived are split here
const STATUSES = ['active', 'archived'] as const;
type Status = (typeof STATUSES)[number];

export function PriceListsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('sales.price_list.manage');
  const [status, setStatus] = useState<Status>('active');
  const [adding, setAdding] = useState(false);
  const { data, isError } = useQuery(priceListsQuery(tenantId));
  const visible = useMemo(
    () => data?.filter((list) => (list.archivedAt === null) === (status === 'active')),
    [data, status],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('priceLists.columns.name'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[28rem]">
              <span className="truncate font-medium">{row.original.name}</span>
              {row.original.description && (
                <span className="truncate text-caption text-ink-3">{row.original.description}</span>
              )}
            </span>
          ),
        }),
        column.accessor('itemCount', {
          header: t('priceLists.columns.prices'),
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
        column.accessor('customerCount', {
          header: t('priceLists.columns.customers'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
      ]),
    [t, format],
  );

  return (
    <div className="grid max-w-4xl gap-5">
      <PageHeader
        title={t('priceLists.title')}
        description={t('priceLists.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('priceLists.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('priceLists.show')}
          value={status}
          options={STATUSES.map((value) => ({
            value,
            label: t(`priceLists.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('priceLists.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('priceLists.loadFailed')}</p>}
      {visible && (
        <DataTable
          label={t('priceLists.title')}
          data={visible}
          columns={columns}
          getRowId={(list) => list.id}
          // Everyone opens a list: a salesperson looks up the dealer price there
          onRowClick={(list) =>
            void navigate({ to: '/price-lists/$priceListId', params: { priceListId: list.id } })
          }
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('priceLists.archivedEmptyTitle')}
                description={t('priceLists.archivedEmptyBody')}
              />
            ) : (
              <EmptyState
                icon={Tag01Icon}
                title={t('priceLists.emptyTitle')}
                description={t('priceLists.emptyBody')}
              />
            )
          }
        />
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <PriceListForm
            priceList={null}
            // A new list is empty: straight to its page to add the prices
            onDone={(saved) => {
              setAdding(false);
              void navigate({ to: '/price-lists/$priceListId', params: { priceListId: saved.id } });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **Active and archived are split in the browser.** The API sends every list at once (a workspace has a few), so
  the segmented control filters the array; it does not ask the server again.
- **Every row opens its list, permission or not.** A salesperson looks up the dealer price there before quoting it.

### `routes/price-list.tsx` (new): the prices in a list

```tsx
import {
  AlertCircleIcon,
  Archive02Icon,
  ArrowLeft01Icon,
  Delete02Icon,
  PackageSearchIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Search01Icon,
  Tag01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareMoney,
  MAX_PRICE_LIST_CHANGES,
  type PriceList,
  type PriceListItem,
  type Product,
  type ProductSummary,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  FormAlert,
  IconButton,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { LineError } from '../components/journal-parts';
import { PriceListForm } from '../components/price-list-form';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import {
  priceListItemsQuery,
  priceListQuery,
  productQuery,
  productSearchQuery,
  settingsQuery,
  unitsQuery,
} from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

// One row of the page: a price the list holds (from the server), or an item just added from the
// picker that has no price yet. A price is per variant and per unit.
interface Row {
  key: string;
  variantId: string;
  unitId: string;
  productName: string;
  sku: string;
  optionValues: string[];
  // The saved price, or '' for a new row
  price: string;
  isNew: boolean;
}

// A change waiting for "Save prices". price '' takes the item out of the list.
interface Change {
  variantId: string;
  unitId: string;
  price: string;
}

const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

function rowOf(item: PriceListItem): Row {
  return {
    key: keyOf(item.variantId, item.unitId),
    variantId: item.variantId,
    unitId: item.unitId,
    productName: item.productName,
    sku: item.sku,
    optionValues: item.optionValues,
    price: item.price,
    isNew: false,
  };
}

// A product from the picker → one row per active version and per unit it is sold in (the base
// unit and every pack): a carton is often priced apart from 24 single pieces
function rowsOf(product: Product): Row[] {
  const unitIds = [product.baseUnitId, ...product.units.map((pack) => pack.unitId)];
  return product.variants
    .filter((variant) => variant.archivedAt === null)
    .flatMap((variant) =>
      unitIds.map((unitId) => ({
        key: keyOf(variant.id, unitId),
        variantId: variant.id,
        unitId,
        productName: product.name,
        sku: variant.sku,
        optionValues: variant.optionValues,
        price: '',
        isNew: true,
      })),
    );
}

// "Napa 500 mg" or "Polo shirt · M / Navy blue"
function rowName(row: Row): string {
  return row.optionValues.length === 0
    ? row.productName
    : `${row.productName} · ${row.optionValues.join(' / ')}`;
}

// The server names a refused change by its place in the batch ("changes.3.unitId"); the page
// needs the row it came from
const CHANGE_FIELD = /^changes\.(\d+)\./;

// Item, unit, price, remove: one template for the header and every row, so the columns line up
const ROW = '@3xl:grid-cols-[minmax(0,1fr)_7rem_12rem_2.25rem] @3xl:items-start';

// "Add items": search the products, then add one; each of its versions gets a row for every unit
function ItemPicker({ onAdd }: { onAdd: (product: Product) => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const { data: products } = useQuery(productSearchQuery(tenantId, settled));

  // The list sends a summary; the versions and the packs come with the product itself
  const add = async (summary: ProductSummary) => {
    setLoading(summary.id);
    try {
      onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
      setAdded((before) => new Set(before).add(summary.id));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('priceLists.pickerTitle')}
      description={t('priceLists.pickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('priceLists.pickerSearch')}
          placeholder={t('priceLists.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        {products?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t('priceLists.pickerEmpty')}
            description={t('priceLists.pickerDescription')}
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
                  {added.has(product.id) ? t('priceLists.pickerAdded') : t('priceLists.pickerAdd')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

function PriceListView({ priceList }: { priceList: PriceList }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const mayManage = useCan()('sales.price_list.manage');
  // An archived list keeps its prices but takes no new ones (the API refuses them): restore it
  // first, from the Edit dialog
  const canManage = mayManage && priceList.archivedAt === null;
  const pricesIncludeVat = useQuery(settingsQuery(tenantId)).data?.pricesIncludeVat;
  const units = useQuery(unitsQuery(tenantId)).data;
  const unitCode = useMemo(() => new Map(units?.map((unit) => [unit.id, unit.code])), [units]);
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim());
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    priceListItemsQuery(tenantId, priceList.id, settled),
  );
  // The page's own state, until "Save prices": the rows added from the picker, the changed
  // prices, and the server's errors by row
  const [added, setAdded] = useState<Row[]>([]);
  const [changes, setChanges] = useState<ReadonlyMap<string, Change>>(new Map());
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);

  const saved = useMemo(() => data?.pages.flatMap((page) => page.items.map(rowOf)) ?? [], [data]);
  // New rows on top, and never twice: an item the list already holds keeps its own row
  const rows = useMemo(() => {
    const known = new Set(saved.map((row) => row.key));
    return [...added.filter((row) => !known.has(row.key)), ...saved];
  }, [added, saved]);
  // One save sends at most this many: past it, finish this batch first
  const full = changes.size >= MAX_PRICE_LIST_CHANGES;

  // The next page when the end of the list scrolls into view
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = end.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Typing the saved price back is no change at all: the row leaves the count
  const setPrice = (row: Row, price: string) => {
    setChanges((before) => {
      const next = new Map(before);
      const same =
        price === '' ? row.price === '' : row.price !== '' && compareMoney(price, row.price) === 0;
      if (same) next.delete(row.key);
      else next.set(row.key, { variantId: row.variantId, unitId: row.unitId, price });
      return next;
    });
  };

  // A new row goes away; a saved one keeps its row with an empty box, and "Save prices" takes it
  // out of the list
  const removeRow = (row: Row) => {
    if (row.isNew) {
      setAdded((before) => before.filter((item) => item.key !== row.key));
      setChanges((before) => {
        const next = new Map(before);
        next.delete(row.key);
        return next;
      });
    } else {
      setPrice(row, '');
    }
  };

  const discard = () => {
    setAdded([]);
    setChanges(new Map());
    setRowErrors(new Map());
    setFailure(null);
  };

  const save = async () => {
    const batch = [...changes.entries()];
    setSaving(true);
    setFailure(null);
    try {
      const result = await call(routes.priceLists.setItems, {
        params: { id: priceList.id },
        body: { changes: batch.map(([, change]) => change) },
      });
      queryClient.setQueryData(priceListQuery(tenantId, priceList.id).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ['price-lists', tenantId] });
      discard();
      toast(t('priceLists.pricesSaved'));
    } catch (error) {
      // All or nothing: nothing was saved. Each error goes under its row; the rest on top.
      const byRow = new Map<string, string>();
      let other: string | null = null;
      if (error instanceof ApiRequestError) {
        for (const [field, codes] of Object.entries(error.problem.fieldErrors ?? {})) {
          const index = CHANGE_FIELD.exec(field)?.[1];
          const key = index === undefined ? undefined : batch[Number(index)]?.[0];
          const code = codes[0];
          if (key !== undefined && code !== undefined) byRow.set(key, code);
        }
        if (byRow.size === 0) other = error.code;
      } else {
        other = 'unknown_error';
      }
      setRowErrors(byRow);
      setFailure(other);
    } finally {
      setSaving(false);
    }
  };

  const filtered = settled !== '';

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <Link
        to="/price-lists"
        className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
        {t('priceLists.back')}
      </Link>
      <PageHeader
        title={priceList.name}
        description={priceList.description}
        actions={
          mayManage && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
                {t('priceLists.edit')}
              </Button>
              {canManage && (
                <Button
                  disabled={full}
                  onClick={() => {
                    setPicking(true);
                  }}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                  {t('priceLists.addItems')}
                </Button>
              )}
            </>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
        {/* The workspace setting the prices follow (Settings → Sales) */}
        {pricesIncludeVat !== undefined && (
          <Pill tone="neutral" icon={Tag01Icon}>
            {pricesIncludeVat ? t('priceLists.withVat') : t('priceLists.withoutVat')}
          </Pill>
        )}
        {priceList.archivedAt !== null && (
          <>
            <Pill tone="neutral" icon={Archive02Icon}>
              {t('priceLists.statuses.archived')}
            </Pill>
            <span>{t('priceLists.archivedNotice')}</span>
          </>
        )}
      </div>
      {!mayManage && <p className="text-body-sm text-ink-3">{t('priceLists.readOnly')}</p>}
      <div className="max-w-md">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('priceLists.searchLabel')}
          placeholder={t('priceLists.searchPlaceholder')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>
      {failure && <FormAlert message={failure} />}
      {isError && <p className="text-body-sm text-crit">{t('priceLists.itemsLoadFailed')}</p>}
      {data &&
        (rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Search01Icon}
              title={t('priceLists.itemsNoMatchTitle', { query: settled })}
              description={t('priceLists.itemsNoMatchBody')}
            />
          ) : (
            <EmptyState
              icon={Tag01Icon}
              title={t('priceLists.itemsEmptyTitle')}
              description={t('priceLists.itemsEmptyBody')}
              action={
                canManage && (
                  <Button
                    onClick={() => {
                      setPicking(true);
                    }}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                    {t('priceLists.addItems')}
                  </Button>
                )
              }
            />
          )
        ) : (
          <Card
            className="@container grid grid-cols-1 overflow-hidden"
            aria-label={t('priceLists.title')}
          >
            <div
              aria-hidden="true"
              className={cn(
                'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
                ROW,
              )}
            >
              <span>{t('priceLists.itemColumns.item')}</span>
              <span>{t('priceLists.itemColumns.unit')}</span>
              <span className="text-right">{t('priceLists.itemColumns.price')}</span>
            </div>
            <ul className="grid grid-cols-1">
              {rows.map((row) => {
                const change = changes.get(row.key);
                const name = rowName(row);
                const unit = unitCode.get(row.unitId) ?? '';
                const id = `price-${row.key}`;
                const error = rowErrors.get(row.key);
                return (
                  <li
                    key={row.key}
                    role="group"
                    aria-label={name}
                    className={cn(
                      'grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-line px-5 py-3 first:border-t-0',
                      ROW,
                    )}
                  >
                    <div className="grid min-w-0 content-start gap-0.5 @3xl:pt-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-body-sm font-medium">{name}</span>
                        {row.isNew && (
                          <Pill tone="brand" icon={PlusSignIcon}>
                            {t('priceLists.new')}
                          </Pill>
                        )}
                      </span>
                      <span className="truncate font-mono text-caption text-ink-3">{row.sku}</span>
                    </div>
                    <span className="self-start pt-2 font-mono text-body-sm text-ink-2">
                      {unit}
                    </span>
                    <div className="col-span-2 grid grid-cols-1 gap-1.5 @3xl:col-span-1">
                      <MoneyInput
                        id={id}
                        aria-label={t('priceLists.priceOf', { name, unit })}
                        placeholder={t('priceLists.pricePlaceholder')}
                        value={change?.price ?? row.price}
                        disabled={!canManage || (full && change === undefined)}
                        invalid={error !== undefined}
                        aria-describedby={error ? `${id}-error` : undefined}
                        onChange={(value) => {
                          setPrice(row, value);
                        }}
                      />
                      <LineError id={id} error={error} />
                    </div>
                    {canManage && (
                      <IconButton
                        icon={Delete02Icon}
                        label={t('priceLists.remove', { name, unit })}
                        className="col-span-2 justify-self-end @3xl:col-span-1"
                        disabled={!row.isNew && (change?.price ?? row.price) === ''}
                        onClick={() => {
                          removeRow(row);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            <div ref={end} />
            {isFetchingNextPage && (
              <p className="border-t border-line px-5 py-3 text-caption text-ink-3">
                {t('common.loadingMore')}
              </p>
            )}
          </Card>
        ))}

      {/* Shows only while something changed (CLAUDE.md → Permission matrix's save bar) */}
      {changes.size + added.length > 0 && (
        <Card className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 px-5 py-3 shadow-md">
          <span className="text-body-sm text-ink-2 tabular-nums">
            {full
              ? t('priceLists.tooMany', { max: format.number(MAX_PRICE_LIST_CHANGES) })
              : t('priceLists.unsaved', { count: changes.size })}
          </span>
          <span className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={saving} onClick={discard}>
              {t('priceLists.discard')}
            </Button>
            <Button disabled={saving || changes.size === 0} onClick={() => void save()}>
              {saving ? t('common.saving') : t('priceLists.savePrices')}
            </Button>
          </span>
        </Card>
      )}

      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && (
          <PriceListForm
            priceList={priceList}
            onDone={() => {
              setEditing(false);
            }}
          />
        )}
      </Dialog>
      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            onAdd={(product) => {
              setAdded((before) => {
                const known = new Set(before.map((row) => row.key));
                return [...rowsOf(product).filter((row) => !known.has(row.key)), ...before];
              });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

export function PriceListPage() {
  const { t } = useLocale();
  const { priceListId = '' } = useParams({ strict: false });
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data: priceList, isError } = useQuery({
    ...priceListQuery(tenantId, priceListId),
    enabled: priceListId !== '',
  });
  if (isError) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <Link
          to="/price-lists"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('priceLists.back')}
        </Link>
        <EmptyState
          icon={AlertCircleIcon}
          title={t('priceLists.title')}
          description={t('priceLists.notFound')}
        />
      </div>
    );
  }
  if (!priceList) return null;
  // key: another list opened from here starts with no pending changes
  return <PriceListView key={priceList.id} priceList={priceList} />;
}
```

This page edits many prices and saves them in one batch (15a.1's `setItems`).

- **Rows, not a `DataTable`.** Every row holds a money input. The data table virtualizes its rows: an input that
  scrolls out of view is unmounted, and its focus and half-typed value would be lost. A plain list inside a card,
  100 rows a page, keeps each input alive. The same `@container` layout as the stock lines makes it a two-line
  card on a narrow screen.
- **The page keeps three things until "Save prices"**: `added` (rows from the picker that have no price yet),
  `changes` (a `Map` from `variantId:unitId` to the change) and `rowErrors`. Nothing is saved row by row: a
  distributor changes a hundred prices at once, and one request is all or nothing.
- **`setPrice` drops a change that equals the saved price.** Typing the old price back is no change, so the count
  in the save bar goes down. `compareMoney` compares the decimals; comparing strings would think "120.00" and
  "120.0000" differ.
- **Remove empties the box on a saved row**, and saving sends `price: ''`, which takes the item out of the list
  (15a.1). The row stays until then, with "Product price" as its placeholder, so the person sees what the customer
  will pay. A new row just goes away.
- **New rows go on top and never twice.** `rows` filters out a picked row that the loaded pages already hold, and
  `onAdd` filters out one already added. An item on a page not loaded yet may still be added; saving it is an
  upsert on the server, so nothing breaks.
- **`full` stops new changes at 500** (`MAX_PRICE_LIST_CHANGES`). Boxes that have no change yet are disabled, "Add
  items" too, and the save bar says to save first. Rows already changed stay editable.
- **Errors come back by batch position** (`changes.3.unitId`). `CHANGE_FIELD` reads the position, and `batch` (the
  entries in the order they were sent) gives the row's key. Each error then shows under its own row. An error
  without a position (`price_list_invalid` on an archived list, a lost network) goes to the alert on top.
- **The next page loads when the end of the card comes into view**, with an `IntersectionObserver` on an empty
  `<div>`. The data table does this inside itself; a plain list needs these few lines.
- **An archived list is read-only here** (`canManage` includes `archivedAt === null`). The API refuses prices on
  an archived list. "Edit" stays, because its dialog is where the list is restored.
- **The pill shows the workspace's VAT setting.** The same "৳120" means a different price with and without VAT
  inside it; the person typing prices must know which one the list holds.
- **The save bar is sticky at the bottom**, like the permission matrix's: it appears only when something is
  waiting, with Discard and Save.

The "Add items" dialog (`ItemPicker` in this file) searches products, not stock: a price is set for items with no
stock yet. A product's versions and packs are not in the list's summary, so the button fetches the product with
`queryClient.query(productQuery(…))`. That fills the same cache the product page uses, so opening a product
twice costs one request. `rowsOf` makes one row per active version and per unit (the base unit and every pack),
because a carton usually has its own price, cheaper than 24 single pieces.

### Settings: the Sales card and the VAT rates

```diff
@@ -22,5 +22,6 @@ export function settingsToForm(settings: Settings): SettingsFormValues {
     fiscalYearStartMonth: settings.fiscalYearStartMonth,
     timezone: settings.timezone,
     allowNegativeStock: settings.allowNegativeStock,
+    pricesIncludeVat: settings.pricesIncludeVat,
   };
 }
```

```diff
@@ -39,6 +39,7 @@ import { type ChangeEvent, useMemo, useRef } from 'react';
 import { Controller, useForm } from 'react-hook-form';
 
 import { StockAccountsCard } from '../components/stock-accounts-card';
+import { TaxRatesCard } from '../components/tax-rates-card';
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { settingsQuery } from '../lib/queries';
@@ -240,6 +241,29 @@ function SettingsForm({ settings, canManage }: { settings: Settings; canManage:
             </p>
           </div>
         </Card>
+
+        {/* Step 15a. Saved with the company settings, like the stock rule above. */}
+        <Card>
+          <CardHeader title={t('settings.salesTitle')} subtitle={t('settings.salesSubtitle')} />
+          <div className="grid gap-2 p-5">
+            <Controller
+              control={control}
+              name="pricesIncludeVat"
+              render={({ field }) => (
+                <Checkbox
+                  id="pricesIncludeVat"
+                  label={t('settings.pricesIncludeVat')}
+                  checked={field.value}
+                  disabled={!canManage}
+                  onCheckedChange={(checked) => {
+                    field.onChange(checked === true);
+                  }}
+                />
+              )}
+            />
+            <p className="pl-[27px] text-label text-ink-3">{t('settings.pricesIncludeVatHint')}</p>
+          </div>
+        </Card>
       </fieldset>
 
       {canManage ? (
@@ -409,6 +433,8 @@ export function SettingsPage() {
           <SettingsForm key={tenantId} settings={data} canManage={canManage} />
           {/* Step 14: where stock documents post — its own form, saved by its own endpoint */}
           <StockAccountsCard key={`stock-${tenantId}`} tenantId={tenantId} canManage={canManage} />
+          {/* Step 15a: the VAT rates — a list of their own, each saved by itself */}
+          <TaxRatesCard key={`tax-${tenantId}`} tenantId={tenantId} canManage={canManage} />
         </>
       )}
     </div>
```

- **"Prices include VAT" is part of the company settings form.** It is one field of `PUT /settings` (15a.1), so it
  saves with the rest, with the same version check. A checkbox, not a switch, for that reason (like "Allow negative
  stock").
- **The VAT rates are a card of their own, below the stock accounts.** Each rate saves through its own dialog and
  route. Putting them inside the settings form would mean one Save for two different things.
- **`settingsToForm` gets the field too.** The onboarding wizard sends the whole profile through the same function,
  so it keeps the setting unchanged.

```ts
import type { TaxRate } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { SelectOption } from '@omnivo/ui';
import { useCallback } from 'react';

// "7.50" → "7.5", "15.00" → "15": a rate as people write it. Postgres sends NUMERIC(5,2) with both
// decimals; only a number with a point loses its trailing zeros ("10" must stay "10").
export function plainRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate;
}

// "7.5%", with Bangla digits in Bangla
export function useRateText(): (rate: string) => string {
  const { t, format } = useLocale();
  return useCallback(
    (rate: string) => {
      const plain = plainRate(rate);
      const decimals = plain.split('.')[1]?.length ?? 0;
      return t('taxRates.percent', { rate: format.number(plain, decimals) });
    },
    [t, format],
  );
}

// The rates a product can pick: the active ones, plus its own if it was archived since (the select
// would otherwise silently show another rate; the server keeps an unchanged archived rate)
export function taxRateOptions(
  rates: readonly TaxRate[],
  rateText: (rate: string) => string,
  keep: string | null,
): SelectOption[] {
  return rates
    .filter((rate) => rate.archivedAt === null || rate.id === keep)
    .map((rate) => ({ value: rate.id, label: `${rate.name} · ${rateText(rate.rate)}` }));
}
```

- **`plainRate` strips trailing zeros only after a point.** Postgres sends "7.50" and "15.00"; people write "7.5"
  and "15". Without the `includes('.')` check, the regex would turn "10" into "1".
- **`useRateText` formats with the right number of decimals**, so Bangla shows "৭.৫%" and English "7.5%".
- **`taxRateOptions` keeps the product's own rate if it was archived**, like the units and the price lists.

```tsx
import {
  Archive02Icon,
  CheckmarkCircle02Icon,
  PercentIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  TAX_RATE_KINDS,
  type TaxRate,
  type TaxRateKind,
  updateTaxRateInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  Pill,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { taxRatesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { plainRate, useRateText } from '../lib/tax-rates';
import { failureOf } from './journal-parts';

// Settings → VAT rates (step 15a): a card on the settings page, not a page of its own — a
// workspace has a handful of rates and changes them when the NBR does. Each rate is saved by its
// own dialog, apart from the company settings above.

const FIELD_NAMES = updateTaxRateInputSchema.keyof().options;

function isKind(value: string): value is TaxRateKind {
  return TAX_RATE_KINDS.some((kind) => kind === value);
}

// The two kinds that charge nothing
const ZERO_KINDS: readonly TaxRateKind[] = ['zero_rated', 'exempt'];

function RateForm({ rate, onDone }: { rate: TaxRate | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateTaxRateInputSchema, { error: contractErrorMap }),
    defaultValues: {
      name: rate?.name ?? '',
      kind: rate && isKind(rate.kind) ? rate.kind : 'standard',
      // "7.50" reads "7.5" in the box
      rate: rate ? plainRate(rate.rate) : '',
      isDefault: rate?.isDefault ?? false,
      version: rate?.version ?? 1,
    },
  });
  const kind = useWatch({ control, name: 'kind' });
  // The default is moved by making another rate the default, never switched off (the server
  // refuses it: one rate is always the default)
  const lockedDefault = rate?.isDefault === true;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tax-rates', tenantId] });

  const toggle = useMutation({
    mutationFn: (current: TaxRate) =>
      call(current.archivedAt === null ? routes.taxRates.archive : routes.taxRates.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'taxRates.restoredToast' : 'taxRates.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = rate
        ? await call(routes.taxRates.update, {
            params: { id: rate.id },
            body: { ...values, version },
          })
        : await call(routes.taxRates.create, { body: values });
      // A new default takes the flag from the old one: the whole list refetches
      await refresh();
      toast(t(rate ? 'taxRates.updated' : 'taxRates.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // tax_rate_default_archived, version_conflict: they belong to no field
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={rate ? t('taxRates.editTitle', { name: rate.name }) : t('taxRates.newTitle')}
      footer={
        <>
          {rate && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(rate);
              }}
            >
              {rate.archivedAt === null ? t('taxRates.archive') : t('taxRates.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="tax-rate-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : rate ? t('common.save') : t('taxRates.add')}
          </Button>
        </>
      }
    >
      <form
        id="tax-rate-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('taxRates.name')}
          placeholder={t('taxRates.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_9rem] sm:gap-x-4">
          <SelectField
            label={t('taxRates.kind')}
            hint={t(`taxRates.kindHints.${kind}`)}
            options={TAX_RATE_KINDS.map((value) => ({
              value,
              label: t(`taxRates.kinds.${value}`),
            }))}
            {...register('kind', {
              // Zero-rated and exempt are always 0%; moving away from them empties the box, so
              // a "standard 0%" is never saved by accident
              onChange: () => {
                const next = getValues('kind');
                if (ZERO_KINDS.includes(next)) setValue('rate', '0');
                else if (getValues('rate') === '0') setValue('rate', '');
              },
            })}
            error={errors.kind?.message}
          />
          <TextField
            label={t('taxRates.rate')}
            hint={t('taxRates.rateHint')}
            inputMode="decimal"
            suffix="%"
            readOnly={ZERO_KINDS.includes(kind)}
            {...register('rate')}
            error={errors.rate?.message}
          />
        </div>
        <div className="grid gap-2">
          <Controller
            control={control}
            name="isDefault"
            render={({ field }) => (
              <Checkbox
                id="isDefault"
                label={t('taxRates.makeDefault')}
                checked={field.value}
                disabled={lockedDefault}
                onCheckedChange={(checked) => {
                  field.onChange(checked === true);
                }}
              />
            )}
          />
          {lockedDefault && (
            <p className="pl-[27px] text-label text-ink-3">{t('taxRates.defaultLocked')}</p>
          )}
        </div>
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | TaxRate;

export function TaxRatesCard({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const { t } = useLocale();
  const rateText = useRateText();
  const [editing, setEditing] = useState<Editing>(null);
  const { data: rates, isError } = useQuery(taxRatesQuery(tenantId));

  return (
    <Card>
      <CardHeader
        title={t('taxRates.title')}
        subtitle={t('taxRates.subtitle')}
        actions={
          canManage && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('taxRates.add')}
            </Button>
          )
        }
      />
      <div className="p-5 pt-4">
        {isError && <p className="text-body-sm text-crit">{t('taxRates.loadFailed')}</p>}
        {rates?.length === 0 && (
          <EmptyState
            icon={PercentIcon}
            title={t('taxRates.emptyTitle')}
            description={t('taxRates.emptyBody')}
          />
        )}
        {rates && rates.length > 0 && (
          <ul className="grid grid-cols-1 divide-y divide-line overflow-hidden rounded-control border border-line">
            {rates.map((rate) => {
              const content = (
                <>
                  <span className="grid min-w-0 flex-1 text-left">
                    <span className="truncate text-body-sm font-medium text-ink">{rate.name}</span>
                    <span className="truncate text-caption text-ink-3">
                      {isKind(rate.kind) ? t(`taxRates.kinds.${rate.kind}`) : rate.kind}
                    </span>
                  </span>
                  {rate.isDefault && (
                    <Pill tone="brand" icon={CheckmarkCircle02Icon}>
                      {t('taxRates.default')}
                    </Pill>
                  )}
                  {rate.archivedAt !== null && (
                    <Pill tone="neutral" icon={Archive02Icon}>
                      {t('taxRates.archived')}
                    </Pill>
                  )}
                  <span className="w-16 text-right text-body-sm font-medium tabular-nums">
                    {rateText(rate.rate)}
                  </span>
                </>
              );
              return (
                <li key={rate.id}>
                  {canManage ? (
                    // A real button: the whole row opens the rate, by mouse or keyboard
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-subtle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                      onClick={() => {
                        setEditing(rate);
                      }}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <RateForm
            key={editing === 'new' ? 'new' : editing.id}
            rate={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}
```

- **Rows are real buttons.** A row opens its rate by mouse or keyboard. Without the permission, the same content
  is a plain `<div>`, so nothing looks clickable.
- **Picking zero-rated or exempt sets the rate to 0 and makes the box read-only**; moving back to standard or
  reduced empties it. The contract refuses a "standard 0%" (`tax_rate_kind_rate`); this way the person cannot type
  one by accident.
- **The default's checkbox is locked on the default rate.** The server refuses switching the default off
  (`tax_rate_default_needed`): one rate is always the default. The hint says how to move it: make another rate the
  default.
- **After any save, the whole list refetches.** Making a rate the default takes the flag from the old one, and only
  a refetch shows both changes.
- **`tax_rate_default_archived`** (archiving the default) shows in the dialog's alert.

### Products: a VAT rate on the form

```diff
@@ -11,7 +11,9 @@ import {
   productCategoriesQuery,
   productFieldsQuery,
   productQuery,
+  settingsQuery,
   setupQuery,
+  taxRatesQuery,
   unitsQuery,
 } from '../lib/queries';
 import { useSession } from '../lib/session-store';
@@ -22,14 +24,17 @@ const ProductForm = lazy(async () => ({
   default: (await import('../components/product-form')).ProductForm,
 }));
 
-// What both pages need: the units, the categories, the active custom fields, and the business
-// type (a pharma company's new products start with batch tracking)
+// What both pages need: the units, the categories, the active custom fields, the business type (a
+// pharma company's new products start with batch tracking), and from step 15a the VAT rates and
+// whether prices include VAT
 function useProductData() {
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const units = useQuery(unitsQuery(tenantId)).data;
   const categories = useQuery(productCategoriesQuery(tenantId)).data;
   const allFields = useQuery(productFieldsQuery(tenantId)).data;
   const industry = useQuery(setupQuery(tenantId)).data?.industry ?? null;
+  const taxRates = useQuery(taxRatesQuery(tenantId)).data;
+  const pricesIncludeVat = useQuery(settingsQuery(tenantId)).data?.pricesIncludeVat;
   const fields = useMemo(
     () => allFields?.filter((field) => field.archivedAt === null),
     [allFields],
@@ -39,14 +44,16 @@ function useProductData() {
     units,
     categories,
     fields,
+    taxRates,
+    pricesIncludeVat,
     defaults: trackingDefault(industry !== null && isIndustry(industry) ? industry : null),
   };
 }
 
 export function NewProductPage() {
   const canManage = useCan()('inventory.product.manage');
-  const { units, categories, fields, defaults } = useProductData();
-  if (!units || !categories || !fields) return null;
+  const { units, categories, fields, taxRates, pricesIncludeVat, defaults } = useProductData();
+  if (!units || !categories || !fields || !taxRates || pricesIncludeVat === undefined) return null;
   return (
     <Suspense fallback={null}>
       <ProductForm
@@ -55,6 +62,8 @@ export function NewProductPage() {
         categories={categories}
         fields={fields}
         defaults={defaults}
+        taxRates={taxRates}
+        pricesIncludeVat={pricesIncludeVat}
         canManage={canManage}
       />
     </Suspense>
@@ -65,7 +74,8 @@ export function ProductPage() {
   const { t } = useLocale();
   const { productId = '' } = useParams({ strict: false });
   const canManage = useCan()('inventory.product.manage');
-  const { tenantId, units, categories, fields, defaults } = useProductData();
+  const { tenantId, units, categories, fields, taxRates, pricesIncludeVat, defaults } =
+    useProductData();
   const { data: product, isError } = useQuery({
     ...productQuery(tenantId, productId),
     enabled: productId !== '',
@@ -87,7 +97,9 @@ export function ProductPage() {
       </div>
     );
   }
-  if (!product || !units || !categories || !fields) return null;
+  if (!product || !units || !categories || !fields || !taxRates || pricesIncludeVat === undefined) {
+    return null;
+  }
   return (
     <Suspense fallback={null}>
       {/* key: a saved product comes back with a new version, and the form starts from it again */}
@@ -98,6 +110,8 @@ export function ProductPage() {
         categories={categories}
         fields={fields}
         defaults={defaults}
+        taxRates={taxRates}
+        pricesIncludeVat={pricesIncludeVat}
         canManage={canManage}
       />
     </Suspense>
```

```diff
@@ -1,6 +1,7 @@
 import {
   Alert02Icon,
   Archive02Icon,
+  Calendar03Icon,
   Delete02Icon,
   GridViewIcon,
   PlusSignIcon,
@@ -20,6 +21,7 @@ import {
   PRODUCT_TYPES,
   routes,
   standardFactor,
+  type TaxRate,
   TRACKING_MODES,
   type TrackingMode,
   type Unit,
@@ -32,7 +34,6 @@ import {
   CardHeader,
   Checkbox,
   cn,
-  DatePicker,
   FormAlert,
   FormField,
   IconButton,
@@ -49,7 +50,7 @@ import {
 } from '@omnivo/ui';
 import { useMutation, useQueryClient } from '@tanstack/react-query';
 import { Link, useNavigate } from '@tanstack/react-router';
-import { useMemo, useState } from 'react';
+import { lazy, Suspense, useMemo, useState } from 'react';
 import {
   type Control,
   Controller,
@@ -72,8 +73,12 @@ import {
 } from '../lib/products';
 import { productQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
+import { taxRateOptions, useRateText } from '../lib/tax-rates';
 import { LineError } from './journal-parts';
 
+// Loaded the first time a date custom field shows (date-input.tsx says why)
+const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
+
 // The product form: a chunk of its own (loaded by routes/product.tsx). The schema is the
 // contract's own fields and rules, with the workspace's custom fields put in — so the form refuses
 // exactly what the API refuses, in the same words, before anything is sent.
@@ -113,6 +118,8 @@ function valuesOf(
       purchaseUnitId: '',
       tracking: defaults.tracking,
       hasExpiry: defaults.hasExpiry,
+      // '' = the workspace's default rate, which follows the default when it changes
+      taxRateId: '',
       options: [],
       variants: [emptyVariant()],
       units: [],
@@ -131,6 +138,7 @@ function valuesOf(
     purchaseUnitId: product.purchaseUnitId ?? '',
     tracking: TRACKING_MODES.find((mode) => mode === product.tracking) ?? 'none',
     hasExpiry: product.hasExpiry,
+    taxRateId: product.taxRateId ?? '',
     options: product.options,
     variants: product.variants.map((variant) => ({
       id: variant.id,
@@ -167,6 +175,7 @@ function fieldNames(
     'purchaseUnitId',
     'tracking',
     'hasExpiry',
+    'taxRateId',
     'variants',
   ];
   values.variants.forEach((_, index) => {
@@ -272,11 +281,14 @@ function CustomFieldInput({
     return (
       <FormField control={control} name={name} label={field.label} optional={optional}>
         {(box) => (
-          <DatePicker
-            {...box}
-            value={typeof box.value === 'string' ? box.value : ''}
-            onChange={box.onChange}
-          />
+          // The same box, empty and disabled, for the moment the chunk loads
+          <Suspense fallback={<Input id={box.id} icon={Calendar03Icon} disabled />}>
+            <DatePicker
+              {...box}
+              value={typeof box.value === 'string' ? box.value : ''}
+              onChange={box.onChange}
+            />
+          </Suspense>
         )}
       </FormField>
     );
@@ -332,11 +344,17 @@ export function ProductForm({
   categories,
   fields,
   defaults,
+  taxRates,
+  pricesIncludeVat,
   canManage,
 }: {
   product: Product | null;
   units: Unit[];
   categories: ProductCategory[];
+  // Archived ones too: a product keeps its own rate if it was archived since
+  taxRates: TaxRate[];
+  // Settings → Sales: the price boxes say whether they hold the VAT
+  pricesIncludeVat: boolean;
   // The workspace's active custom fields for products
   fields: CustomFieldDefinition[];
   defaults: { tracking: TrackingMode; hasExpiry: boolean };
@@ -486,6 +504,11 @@ export function ProductForm({
   const variantsError = errors.variants?.root?.message ?? errors.variants?.message;
   const unitWord = base?.code ?? '';
   const { errorText } = useLocale();
+  const rateText = useRateText();
+  const defaultRate = taxRates.find((rate) => rate.isDefault);
+  const priceHint = pricesIncludeVat
+    ? t('products.fields.priceWithVat')
+    : t('products.fields.priceWithoutVat');
 
   return (
     <div className="grid max-w-5xl grid-cols-1 gap-5">
@@ -546,15 +569,36 @@ export function ProductForm({
                 error={errors.type?.message}
               />
             </div>
-            <SelectField
-              label={t('products.fields.category')}
-              options={[
-                { value: '', label: t('products.fields.noCategory') },
-                ...categoryOptions(categories),
-              ]}
-              {...register('categoryId')}
-              error={errors.categoryId?.message}
-            />
+            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
+              <SelectField
+                label={t('products.fields.category')}
+                options={[
+                  { value: '', label: t('products.fields.noCategory') },
+                  ...categoryOptions(categories),
+                ]}
+                {...register('categoryId')}
+                error={errors.categoryId?.message}
+              />
+              {/* Step 15a. The first option follows the workspace default: changing the default
+                  later moves every product that kept it, without editing them one by one. */}
+              <SelectField
+                label={t('products.fields.taxRate')}
+                hint={t('products.fields.taxRateHint')}
+                options={[
+                  {
+                    value: '',
+                    label: t('products.fields.defaultTaxRate', {
+                      name: defaultRate
+                        ? `${defaultRate.name} · ${rateText(defaultRate.rate)}`
+                        : '—',
+                    }),
+                  },
+                  ...taxRateOptions(taxRates, rateText, product?.taxRateId ?? null),
+                ]}
+                {...register('taxRateId')}
+                error={errors.taxRateId?.message}
+              />
+            </div>
             <TextAreaField
               label={t('products.fields.description')}
               optional
@@ -749,6 +793,7 @@ export function ProductForm({
                   control={control}
                   name="variants.0.salePrice"
                   label={t('products.fields.price', { unit: unitWord })}
+                  hint={priceHint}
                   optional
                 >
                   {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
@@ -859,6 +904,7 @@ export function ProductForm({
                     variantArray.remove(index);
                   }}
                 />
+                <p className="text-label text-ink-3">{priceHint}</p>
               </>
             )}
             {variantsError && (
```

- **The page waits for the rates and the settings** before it renders the form. The form's `defaultValues` are read
  once; a select that got its options later would show the first option.
- **The first option is the workspace default, by name**: "Workspace default: VAT 15%". It sends `''`, which the
  contract turns into `null`, so the product follows the default if it changes later. Picking "VAT 15%" itself
  would tie the product to that rate.
- **The price hint comes from the setting**: "Includes VAT" or "Before VAT", under the simple product's price and
  under the variants table. The same number means two different prices.
- **`taxRateId` is in `fieldNames`**, so `tax_rate_invalid` (an archived rate picked in another tab) shows under the
  select.
- **The date picker of a date custom field is lazy now.** With the VAT select, the form's route measured 100.5 KB
  against its 100 KB budget (`pnpm test:bundle-size`, found in 15a.8). The biggest part the form rarely needs is
  the date picker's popover (about 23 KB gz): only a workspace with a custom field of type date shows one. So the
  form loads it from `date-input.tsx` the first time such a field shows, the way step 14's adjustment form loads
  its cost box. The fallback is the same box, empty and disabled, so nothing jumps when the chunk arrives.

```tsx
// The product form's date picker as a chunk of its own (step 15a), like cost-input.tsx in step 14.
// DatePicker brings the popover (about 23 KB gz with its focus and scroll helpers); the form needs
// it only for a custom field of type date, and with it inside, the form's chunk went over its
// 100 KB budget once the VAT rate came in. A module of its own is what makes the bundler split it off.
export { DatePicker } from '@omnivo/ui';
```

A module whose only line re-exports `DatePicker`. `lazy(() => import('@omnivo/ui'))` would not split anything:
`@omnivo/ui` is already in the form's chunk. A file of the app's own is a new module, and the bundler gives every
module that is only reached through `import()` a chunk of its own. The form now measures 81.0 KB.

### The journal: a customer on receivable lines

```diff
@@ -11,7 +11,9 @@ import {
   type Account,
   type Branch,
   contractErrorMap,
+  isPartyAccountPurpose,
   type JournalEntry,
+  type PartyRef,
   routes,
   updateJournalEntryInputSchema,
 } from '@omnivo/contracts';
@@ -42,6 +44,7 @@ import { call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { balanceSide, formAmount, ledgerOptions, linePath, totalsOf } from '../lib/journal';
 import { useCan } from '../lib/permissions';
+import { CustomerPicker } from './customer-picker';
 import { BackLink, failureOf, LineField, useJournalRefresh } from './journal-parts';
 
 // The entry form: a chunk of its own (loaded by routes/journal-entry.tsx), because the form
@@ -60,7 +63,7 @@ const LINE_COLUMNS = {
 } as const;
 
 function emptyLine(): LineValues {
-  return { accountId: '', branchId: '', description: '', debit: '', credit: '' };
+  return { accountId: '', branchId: '', partyId: '', description: '', debit: '', credit: '' };
 }
 
 // The server's field names for the errors it can send — one set per line
@@ -72,6 +75,7 @@ function fieldNames(lineCount: number): Path<FormValues>[] {
     ...Array.from({ length: lineCount }, (_, index) => [
       linePath(index, 'accountId'),
       linePath(index, 'branchId'),
+      linePath(index, 'partyId'),
       linePath(index, 'debit'),
       linePath(index, 'credit'),
     ]).flat(),
@@ -101,6 +105,8 @@ export function EntryForm({
     control,
     handleSubmit,
     setError,
+    setValue,
+    getValues,
     formState: { errors, isSubmitting },
   } = useForm({
     resolver: zodResolver(updateJournalEntryInputSchema, { error: contractErrorMap }),
@@ -111,6 +117,7 @@ export function EntryForm({
         ? entry.lines.map((line) => ({
             accountId: line.accountId,
             branchId: line.branchId ?? '',
+            partyId: line.party?.id ?? '',
             description: line.description ?? '',
             debit: formAmount(line.debit),
             credit: formAmount(line.credit),
@@ -138,6 +145,24 @@ export function EntryForm({
     [branches, t],
   );
   const showBranch = branches.length > 0;
+  // The receivable (step 15a): a line on it names its customer. The server checks it too.
+  const partyAccounts = useMemo(
+    () =>
+      new Set(
+        accounts
+          .filter((account) => isPartyAccountPurpose(account.purpose))
+          .map((account) => account.id),
+      ),
+    [accounts],
+  );
+  // The customers the draft was saved with, so each box names its customer before any search
+  const savedParties = useMemo(
+    () =>
+      new Map<string, PartyRef>(
+        entry?.lines.flatMap((line) => (line.party ? [[line.party.id, line.party]] : [])) ?? [],
+      ),
+    [entry],
+  );
   const columns = showBranch ? LINE_COLUMNS.withBranch : LINE_COLUMNS.withoutBranch;
 
   const save = (post: boolean) =>
@@ -250,7 +275,7 @@ export function EntryForm({
                   </span>
                   {removeButton}
                 </div>
-                <div className="col-span-2 @3xl:col-span-1">
+                <div className="col-span-2 grid grid-cols-1 gap-2 @3xl:col-span-1">
                   <LineField
                     id={linePath(index, 'accountId')}
                     label={t('journal.account')}
@@ -263,9 +288,45 @@ export function EntryForm({
                       aria-describedby={
                         lineErrors?.accountId ? `${linePath(index, 'accountId')}-error` : undefined
                       }
-                      {...register(linePath(index, 'accountId'))}
+                      {...register(linePath(index, 'accountId'), {
+                        // Another account takes no customer: the server would refuse the line
+                        // (journal_party_not_allowed), and the box is gone, so it could not be
+                        // seen to clear it
+                        onChange: () => {
+                          if (!partyAccounts.has(getValues(linePath(index, 'accountId')))) {
+                            setValue(linePath(index, 'partyId'), '');
+                          }
+                        },
+                      })}
                     />
                   </LineField>
+                  {/* Under the account, not in a column of its own: only receivable lines have
+                      it, and a column empty on most lines would squeeze the others */}
+                  {partyAccounts.has(lines[index]?.accountId ?? '') && (
+                    <Controller
+                      control={control}
+                      name={linePath(index, 'partyId')}
+                      render={({ field, fieldState }) => (
+                        <LineField
+                          id={field.name}
+                          label={t('journal.customer')}
+                          error={fieldState.error?.message}
+                        >
+                          <CustomerPicker
+                            id={field.name}
+                            name={field.name}
+                            ref={field.ref}
+                            value={field.value ?? ''}
+                            saved={savedParties.get(field.value ?? '') ?? null}
+                            onChange={field.onChange}
+                            onBlur={field.onBlur}
+                            invalid={fieldState.error !== undefined}
+                            aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
+                          />
+                        </LineField>
+                      )}
+                    />
+                  )}
                 </div>
                 <div className="col-span-2 @3xl:col-span-1">
                   <LineField
```

- **The customer box sits under the account, not in a column.** Only receivable lines have a customer. A column
  for it would be empty on nearly every line and would squeeze the description on the rest.
- **`partyAccounts` comes from the chart** (`isPartyAccountPurpose`, 15a.1), so the form follows the server's rule
  without a list of its own. Step 17 adds payables to that list, and the form follows.
- **Changing the account clears the customer** when the new account takes none. The box then disappears, so the
  person could not see or clear the old value, and the server would refuse the line
  (`journal_party_not_allowed`).
- **`savedParties` names the draft's customers.** It is keyed by party id, not by line index: after a line is
  removed, the indexes move, but a customer id still finds its name.
- **`partyId` is in `fieldNames`** for every line, so `journal_party_required` lands under the right line's box.

```diff
@@ -6,6 +6,7 @@ import {
   type Branch,
   contractErrorMap,
   isJournalSource,
+  isPartyAccountPurpose,
   isStockJournalSource,
   type JournalEntry,
   reverseJournalEntryInputSchema,
@@ -30,6 +31,7 @@ import { useMemo, useState } from 'react';
 import { useForm } from 'react-hook-form';
 
 import { call } from '../lib/api';
+import { partyLabel } from '../lib/customers';
 import { applyApiError } from '../lib/field-errors';
 import { totalsOf } from '../lib/journal';
 import { useCan } from '../lib/permissions';
@@ -268,6 +270,24 @@ export function EntryView({
                     ) : (
                       '—'
                     )}
+                    {/* The receivable's customer (step 15a), linked to their page. A line posted
+                        before customers were kept says so. */}
+                    {line.party ? (
+                      <Link
+                        to="/customers/$customerId"
+                        params={{ customerId: line.party.id }}
+                        className="block w-fit text-caption text-brand underline-offset-3 hover:underline"
+                      >
+                        {partyLabel(line.party)}
+                      </Link>
+                    ) : (
+                      account &&
+                      isPartyAccountPurpose(account.purpose) && (
+                        <span className="block text-caption text-ink-3">
+                          {t('journal.noCustomer')}
+                        </span>
+                      )
+                    )}
                     {line.description && (
                       <span className="block text-caption text-ink-3">{line.description}</span>
                     )}
```

- **A line's customer links to the customer's page.** A receivable line with no customer (posted before this step)
  says "No customer"; other accounts show nothing.

```diff
@@ -1,5 +1,10 @@
 import { Book02Icon, Notebook02Icon } from '@hugeicons/core-free-icons';
-import { DEFAULT_SETTINGS, type LedgerLine, todayIn } from '@omnivo/contracts';
+import {
+  DEFAULT_SETTINGS,
+  isPartyAccountPurpose,
+  type LedgerLine,
+  todayIn,
+} from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
   Card,
@@ -15,30 +20,14 @@ import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
 import { useNavigate, useSearch } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { useIsoDate } from '../components/journal-parts';
-import { balanceSide, fiscalYearStart, ledgerOptions } from '../lib/journal';
+import { useBalanceText, useIsoDate } from '../components/journal-parts';
+import { fiscalYearStart, ledgerOptions } from '../lib/journal';
 import { useCan } from '../lib/permissions';
 import { accountsQuery, ledgerQuery, settingsQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
 const column = dataTableColumns<LedgerLine>();
 
-// "৳12,500.00 Dr" — a balance with its side; zero has none
-function useBalanceText(): (value: string) => string {
-  const { t, format } = useLocale();
-  return useCallback(
-    (value: string) => {
-      const { amount, side } = balanceSide(value);
-      const money = format.money(amount, { decimals: 2 });
-      if (side === null) return money;
-      return t(side === 'debit' ? 'ledger.debitBalance' : 'ledger.creditBalance', {
-        amount: money,
-      });
-    },
-    [t, format],
-  );
-}
-
 export function LedgerPage() {
   const { t, format } = useLocale();
   const navigate = useNavigate();
@@ -64,12 +53,16 @@ export function LedgerPage() {
     to: today,
   };
   const account = accounts?.find((item) => item.id === accountId);
+  // The receivable's ledger (step 15a) shows whose each line is
+  const byParty = account !== undefined && isPartyAccountPurpose(account.purpose);
 
   const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
     ...ledgerQuery(tenantId, accountId, from, to),
     enabled: canRead && account !== undefined,
   });
   const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
+  // A line posted before customers were kept has none: say once, above the table, how to fix it
+  const unassigned = byParty && lines?.some((line) => line.party === null) === true;
   const first = data?.pages[0];
 
   const loadMore = useCallback(() => {
@@ -104,7 +97,19 @@ export function LedgerPage() {
         header: t('journal.columns.narration'),
         enableSorting: false,
         meta: { card: 'subtitle' },
-        cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
+        cell: ({ row, getValue }) => {
+          const { party } = row.original;
+          return (
+            <span className="grid min-w-0">
+              <span className="truncate">{getValue() || '—'}</span>
+              {byParty && (
+                <span className="truncate text-caption text-ink-3">
+                  {party ? `${party.code} · ${party.name}` : t('ledger.noCustomer')}
+                </span>
+              )}
+            </span>
+          );
+        },
       }),
       column.accessor('debit', {
         header: t('ledger.columns.debit'),
@@ -125,7 +130,7 @@ export function LedgerPage() {
         cell: ({ getValue }) => <span className="font-medium">{balanceText(getValue())}</span>,
       }),
     ]);
-  }, [t, format, showDate, balanceText]);
+  }, [t, format, showDate, balanceText, byParty]);
 
   if (!canRead) {
     return (
@@ -194,6 +199,7 @@ export function LedgerPage() {
             ))}
           </Card>
           {isError && <p className="text-body-sm text-crit">{t('ledger.loadFailed')}</p>}
+          {unassigned && <p className="text-body-sm text-ink-2">{t('ledger.noCustomerHint')}</p>}
           {lines && (
             <DataTable
               label={t('ledger.title')}
```

- **The receivable's ledger shows the customer** as a sub-line of the description. Other ledgers are unchanged
  (`byParty`).
- **One hint above the table, not on each line**, when any loaded line has no customer. The hint (15a.5) says how
  to fix it: reverse the entry and post it again with a customer. This is the display 15a.3 chose instead of a
  made-up "Unassigned" customer.

### `routes/opening-balances.tsx`: the receivable split by customer

```diff
@@ -1,10 +1,14 @@
+import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
+import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
   type Account,
   ACCOUNT_TYPES,
   contractErrorMap,
+  isPartyAccountPurpose,
   type OpeningBalances,
   openingBalancesInputSchema,
+  type PartyRef,
   routes,
   shiftIsoDate,
 } from '@omnivo/contracts';
@@ -16,6 +20,7 @@ import {
   DatePicker,
   FormAlert,
   FormField,
+  IconButton,
   MoneyInput,
   PageHeader,
   toast,
@@ -23,9 +28,10 @@ import {
 import { useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
 import { useMemo } from 'react';
-import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
+import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
 import type { z } from 'zod';
 
+import { CustomerPicker } from '../components/customer-picker';
 import { LineError, LineField, useIsoDate } from '../components/journal-parts';
 import { call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
@@ -35,6 +41,7 @@ import { accountsQuery, openingBalancesQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
 type FormValues = z.input<typeof openingBalancesInputSchema>;
+type LineValues = FormValues['lines'][number];
 
 // Name, Debit, Credit — the same template for the header, every row and the totals
 const ROW = '@3xl:grid-cols-[minmax(0,1fr)_10rem_10rem] @3xl:items-start';
@@ -44,12 +51,49 @@ function fieldNames(count: number): Path<FormValues>[] {
     'goLiveDate',
     ...Array.from({ length: count }, (_, index) => [
       linePath(index, 'accountId'),
+      linePath(index, 'partyId'),
       linePath(index, 'debit'),
       linePath(index, 'credit'),
     ]).flat(),
   ];
 }
 
+function emptyLine(accountId: string): LineValues {
+  return { accountId, partyId: '', debit: '', credit: '' };
+}
+
+// The form's lines: one per account, and on the receivable one per customer (step 15a). A
+// receivable with nothing saved starts with one empty customer row, ready to fill.
+function linesOf(
+  saved: OpeningBalances,
+  rows: readonly Account[],
+  partyAccounts: ReadonlySet<string>,
+): LineValues[] {
+  return rows.flatMap((account) => {
+    const own = saved.lines.filter((line) => line.accountId === account.id);
+    if (!partyAccounts.has(account.id)) {
+      const [line] = own;
+      return [
+        {
+          accountId: account.id,
+          partyId: '',
+          debit: formAmount(line?.debit ?? ''),
+          credit: formAmount(line?.credit ?? ''),
+        },
+      ];
+    }
+    if (own.length === 0) return [emptyLine(account.id)];
+    // A line saved before step 15a has no customer: it stays, with its amount, until the person
+    // picks one or splits it
+    return own.map((line) => ({
+      accountId: account.id,
+      partyId: line.party?.id ?? '',
+      debit: formAmount(line.debit),
+      credit: formAmount(line.credit),
+    }));
+  });
+}
+
 function OpeningForm({
   saved,
   rows,
@@ -65,7 +109,21 @@ function OpeningForm({
   const queryClient = useQueryClient();
   const showDate = useIsoDate();
   const canPost = useCan()('accounting.journal.post');
-  const savedOf = new Map(saved.lines.map((line) => [line.accountId, line]));
+  const partyAccounts = useMemo(
+    () =>
+      new Set(
+        rows.filter((account) => isPartyAccountPurpose(account.purpose)).map((item) => item.id),
+      ),
+    [rows],
+  );
+  // The customers saved before, so each box names its customer before any search ran
+  const savedParties = useMemo(
+    () =>
+      new Map<string, PartyRef>(
+        saved.lines.flatMap((line) => (line.party ? [[line.party.id, line.party]] : [])),
+      ),
+    [saved],
+  );
   const {
     control,
     handleSubmit,
@@ -77,34 +135,170 @@ function OpeningForm({
       goLiveDate: saved.goLiveDate ?? '',
       replaces: saved.entry?.id ?? null,
       // Every row is in the form, empty or not; the server drops the empty ones
-      lines: rows.map((account) => ({
-        accountId: account.id,
-        debit: formAmount(savedOf.get(account.id)?.debit ?? ''),
-        credit: formAmount(savedOf.get(account.id)?.credit ?? ''),
-      })),
+      lines: linesOf(saved, rows, partyAccounts),
     },
   });
+  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
   const lines = useWatch({ control, name: 'lines' });
   const goLiveDate = useWatch({ control, name: 'goLiveDate' });
   const totals = totalsOf(lines);
   // Opening balance equity takes the other side of the difference, so the entry balances
   const gap = balanceSide(totals.difference);
+  // Where each account's lines are in the form. "Add a customer" appends at the end, so a
+  // receivable's rows are not next to each other in the array; the page shows them together.
+  const indexesOf = useMemo(() => {
+    const map = new Map<string, number[]>();
+    lines.forEach((line, index) => {
+      map.set(line.accountId, [...(map.get(line.accountId) ?? []), index]);
+    });
+    return map;
+  }, [lines]);
 
   const onSubmit = handleSubmit(async (values) => {
     try {
       const result = await call(routes.openingBalances.save, { body: values });
       queryClient.setQueryData(openingBalancesQuery(tenantId).queryKey, result);
       await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
+      // The customers' balances come from these lines too
+      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
       toast(
         result.entry ? t('opening.saved', { number: result.entry.number }) : t('opening.cleared'),
       );
     } catch (error) {
-      applyApiError(error, fieldNames(rows.length), setError);
+      applyApiError(error, fieldNames(lines.length), setError);
     }
   });
 
   const money = (value: string) => format.money(value, { decimals: 2 });
 
+  // Debit and credit of one line, with a label that names the row for a screen reader
+  const amounts = (index: number, label: string) =>
+    (['debit', 'credit'] as const).map((side) => (
+      <Controller
+        key={side}
+        control={control}
+        name={linePath(index, side)}
+        render={({ field, fieldState }) => (
+          <LineField
+            id={field.name}
+            label={`${t(`opening.${side}`)}, ${label}`}
+            error={fieldState.error?.message}
+          >
+            <MoneyInput
+              id={field.name}
+              name={field.name}
+              ref={field.ref}
+              value={field.value}
+              onChange={field.onChange}
+              onBlur={field.onBlur}
+              disabled={!canPost}
+              invalid={fieldState.error !== undefined}
+              aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
+            />
+          </LineField>
+        )}
+      />
+    ));
+
+  const accountName = (account: Account) => (
+    <span className="block truncate text-body-sm text-ink">
+      <span className="font-mono text-ink-3 tabular-nums">{account.code}</span> {account.name}
+    </span>
+  );
+
+  // The receivable: a row per customer, each with its picker, and "Add a customer"
+  const partyRows = (account: Account) => {
+    const indexes = indexesOf.get(account.id) ?? [];
+    return (
+      <div key={account.id} role="group" aria-label={`${account.code} ${account.name}`}>
+        <div className="grid gap-0.5 px-5 pt-2">
+          {accountName(account)}
+          <span className="text-caption text-ink-3">{t('opening.receivableHint')}</span>
+        </div>
+        {indexes.map((index, position) => {
+          const number = position + 1;
+          const label = t('opening.customerLine', { account: account.code, number });
+          const start = fields[index];
+          // Saved with an amount and no customer: from before customers were kept
+          const unassigned =
+            start !== undefined &&
+            (start.partyId ?? '') === '' &&
+            (start.debit !== '' || start.credit !== '') &&
+            (lines[index]?.partyId ?? '') === '';
+          return (
+            <div
+              key={start?.id ?? index}
+              role="group"
+              aria-label={label}
+              className={cn('grid grid-cols-2 gap-x-3 gap-y-2 py-2 pr-5 pl-9', ROW)}
+            >
+              <div className="col-span-2 grid min-w-0 gap-1.5 @3xl:col-span-1">
+                <div className="flex items-start gap-2">
+                  <div className="min-w-0 flex-1">
+                    <Controller
+                      control={control}
+                      name={linePath(index, 'partyId')}
+                      render={({ field, fieldState }) => (
+                        <LineField
+                          id={field.name}
+                          label={t('opening.customer')}
+                          error={fieldState.error?.message}
+                        >
+                          <CustomerPicker
+                            id={field.name}
+                            name={field.name}
+                            ref={field.ref}
+                            value={field.value ?? ''}
+                            saved={savedParties.get(field.value ?? '') ?? null}
+                            onChange={field.onChange}
+                            onBlur={field.onBlur}
+                            disabled={!canPost}
+                            invalid={fieldState.error !== undefined}
+                            aria-label={`${t('opening.customer')}, ${label}`}
+                            aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
+                          />
+                        </LineField>
+                      )}
+                    />
+                  </div>
+                  {canPost && (
+                    <IconButton
+                      icon={Delete02Icon}
+                      label={t('opening.removeCustomer', { account: account.code, number })}
+                      // Level with the box once its label is hidden (wide card)
+                      className="mt-[26px] @3xl:mt-0.5"
+                      onClick={() => {
+                        remove(index);
+                      }}
+                    />
+                  )}
+                </div>
+                {unassigned && (
+                  <span className="text-caption text-ink-3">{t('opening.noCustomerHint')}</span>
+                )}
+              </div>
+              {amounts(index, label)}
+            </div>
+          );
+        })}
+        {canPost && (
+          <div className="py-2 pr-5 pl-9">
+            <Button
+              variant="secondary"
+              size="sm"
+              onClick={() => {
+                append(emptyLine(account.id));
+              }}
+            >
+              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
+              {t('opening.addCustomer')}
+            </Button>
+          </div>
+        )}
+      </div>
+    );
+  };
+
   return (
     <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid grid-cols-1 gap-5">
       {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
@@ -151,53 +345,27 @@ function OpeningForm({
               <h2 className="border-t border-line px-5 pt-4 pb-1 text-caption font-medium text-ink-3">
                 {t(`accounts.types.${type}`)}
               </h2>
-              {rows.map((account, index) =>
-                account.type !== type ? null : (
+              {rows.map((account) => {
+                if (account.type !== type) return null;
+                if (partyAccounts.has(account.id)) return partyRows(account);
+                const index = indexesOf.get(account.id)?.[0];
+                if (index === undefined) return null;
+                return (
                   <div
                     key={account.id}
                     className={cn('grid grid-cols-2 gap-x-3 gap-y-2 px-5 py-2', ROW)}
                   >
                     <div className="col-span-2 min-w-0 self-center @3xl:col-span-1">
-                      <span className="block truncate text-body-sm text-ink">
-                        <span className="font-mono text-ink-3 tabular-nums">{account.code}</span>{' '}
-                        {account.name}
-                      </span>
+                      {accountName(account)}
                       <LineError
                         id={linePath(index, 'accountId')}
                         error={errors.lines?.[index]?.accountId?.message}
                       />
                     </div>
-                    {(['debit', 'credit'] as const).map((side) => (
-                      <Controller
-                        key={side}
-                        control={control}
-                        name={linePath(index, side)}
-                        render={({ field, fieldState }) => (
-                          <LineField
-                            id={field.name}
-                            label={`${t(`opening.${side}`)}, ${account.code}`}
-                            error={fieldState.error?.message}
-                          >
-                            <MoneyInput
-                              id={field.name}
-                              name={field.name}
-                              ref={field.ref}
-                              value={field.value}
-                              onChange={field.onChange}
-                              onBlur={field.onBlur}
-                              disabled={!canPost}
-                              invalid={fieldState.error !== undefined}
-                              aria-describedby={
-                                fieldState.error ? `${field.name}-error` : undefined
-                              }
-                            />
-                          </LineField>
-                        )}
-                      />
-                    ))}
+                    {amounts(index, account.code)}
                   </div>
-                ),
-              )}
+                );
+              })}
             </section>
           ),
         )}
@@ -265,10 +433,12 @@ export function OpeningBalancesPage() {
     const list = openingAccounts(accounts);
     // An account that holds a saved balance but was archived since stays on the page, so its
     // amount never disappears without a word; the server then asks to restore it or clear it
-    const extra = saved.lines.flatMap((line) => {
+    const extra = new Set<Account>();
+    for (const line of saved.lines) {
       const account = accounts.find((item) => item.id === line.accountId);
-      return account && !list.includes(account) ? [account] : [];
-    });
+      // A Set: the receivable has a line per customer (step 15a), but one row block
+      if (account && !list.includes(account)) extra.add(account);
+    }
     return [...list, ...extra];
   }, [accounts, saved]);
   const equity = accounts?.find((account) => account.purpose === 'opening_balance_equity');
```

- **The lines are now a field array.** Before, there was one line per account, and the row index was the line
  index. Now the receivable has a line per customer, and "Add a customer" appends at the end of the array, so
  `indexesOf` maps each account to its line indexes. The page shows a receivable's rows together; the array order
  only matters for the server's error paths, which use the array index.
- **`linesOf` builds the starting lines.** An account without a party has one line, as before. The receivable has
  its saved lines, or one empty customer row so the page shows where to start. A line saved before this step has
  no customer: it stays with its amount, and the page shows `noCustomerHint` under it. Saving then answers
  `journal_party_required` under that row, until a customer is picked or the amount is split.
- **`unassigned` is read from the row's starting values** (`fields[index]`), not from the current ones. The hint is
  about a line saved before customers were kept; a new row where the amount is typed before the customer is not
  that, and needs no hint.
- **Each customer row is a `role="group"` named "1140: line 2"** (`opening.customerLine`, with the account's code), and the
  picker and the amounts carry that name in their labels. Several rows belong to one account, and a screen reader
  must tell them apart (CLAUDE.md → Line editor).
- **`extra` is a `Set`.** It adds archived accounts that still hold a saved balance. With a line per customer, one
  archived receivable has several saved lines; a plain array would show its block once per line.
- **The save also invalidates `['customers', tenantId]`**: opening dues are part of each customer's balance.

### `routes/kitchen-sink.tsx`: the combobox

```diff
@@ -20,6 +20,7 @@ import {
   Card,
   CardHeader,
   Checkbox,
+  Combobox,
   DataTable,
   dataTableColumns,
   DatePicker,
@@ -190,6 +191,7 @@ const lcSchema = z.object({
   // MoneyInput সবসময় "" অথবা ঠিক ২ ঘর দশমিক দেয়
   amount: z.string().regex(/^\d+\.\d{2}$/, 'Enter the LC amount.'),
   shipBy: z.string().min(1, 'Pick the latest shipment date.'),
+  buyer: z.string().min(1, 'Pick the buyer who opens the LC.'),
   bank: z.string().trim(),
   partialShipment: z.boolean(),
 });
@@ -202,8 +204,20 @@ function LetterOfCreditForm() {
     formState: { errors },
   } = useForm({
     resolver: zodResolver(lcSchema),
-    defaultValues: { lcNumber: '', amount: '', shipBy: '', bank: '', partialShipment: false },
+    defaultValues: {
+      lcNumber: '',
+      amount: '',
+      shipBy: '',
+      buyer: '',
+      bank: '',
+      partialShipment: false,
+    },
   });
+  // The Combobox demo searches a fixed list here; the app searches the server (customer picker)
+  const [buyerSearch, setBuyerSearch] = useState('');
+  const buyerOptions = BUYERS.filter((buyer) =>
+    buyer.toLowerCase().includes(buyerSearch.trim().toLowerCase()),
+  ).map((buyer) => ({ value: buyer, label: buyer, detail: 'Buyer · EUR' }));
 
   const onSubmit = handleSubmit((values) => {
     toast(`${values.lcNumber} saved as draft`);
@@ -232,6 +246,19 @@ function LetterOfCreditForm() {
         <FormField control={control} name="shipBy" label="Latest shipment date">
           {(field) => <DatePicker {...field} />}
         </FormField>
+        <FormField control={control} name="buyer" label="Applicant (buyer)">
+          {(field) => (
+            <Combobox
+              {...field}
+              selectedLabel={field.value === '' ? null : field.value}
+              options={buyerOptions}
+              search={buyerSearch}
+              onSearchChange={setBuyerSearch}
+              placeholder="Pick a buyer"
+              searchPlaceholder="Search buyers"
+            />
+          )}
+        </FormField>
       </div>
       <Controller
         control={control}
```

The kitchen sink shows every control of `@omnivo/ui`. The letter of credit demo gets an "Applicant (buyer)"
field: the combobox inside `FormField`, with a fixed list filtered in the browser. It shows the control without
the API, and that it works with react-hook-form's errors ("Pick the buyer who opens the LC").

> **What we checked in this part.** The app type-checks, except `src/mocks/` (part 15a.7 adds the new routes and
> fields there). ESLint and Prettier are clean on every file this part touched. The app's unit tests pass (45),
> and so do the i18n tests (11) and the contract tests (107, one new: empty opening lines may repeat). The pages
> were not opened in a browser in this part: without the mocks or a running API they have no data. Part 15a.7 runs
> them in Playwright.

## 15a.7 — `apps/app`: the mock API and the end-to-end tests

The app's end-to-end tests (Playwright) run on the mock API: MSW answers the app's requests inside the browser,
so the tests need no API, Postgres or Docker. The mock follows the contract (every reply is checked with the
route's response schema), and it copies the API's rules where the screens show their errors. Without this part,
the 15a.6 screens would have no data in `pnpm dev:mock`, and the type check would still fail in `src/mocks/`.

What changes:

- a new `mocks/sales-data.ts`: VAT rates, customers, groups and price lists, and the API's rules for them;
- the mock journal learns the party rule, the customer's statement and the customer on each line;
- the seeded workspaces get customers, and the seeded export sales name them;
- products get a VAT rate, settings get `pricesIncludeVat`;
- `handlers.ts` answers the 25 new routes;
- two new Playwright specs, and new tests in three old ones.

### `mocks/sales-data.ts` (new)

```ts
import {
  type Customer,
  type CustomerGroup,
  type CustomerInput,
  type CustomerSort,
  type CustomerStatus,
  type CustomerSummary,
  defaultNumberFormat,
  type ErrorCode,
  formatDocumentNumber,
  type PartyRef,
  periodOf,
  type PriceList,
  type PriceListItem,
  type SetPriceListItemsInput,
  subtractMoney,
  sumMoney,
  type TaxRate,
  type TaxRateInput,
  todayIn,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import type { MockCatalog } from './product-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 15a: VAT rates, customers and their groups, price lists. The API's rules
// (tax-rates.service.ts, customers.service.ts, price-lists.service.ts) on plain arrays, so
// `pnpm dev:mock` and the e2e tests walk the same paths as the real API.

// A customer as stored: the balance is worked out from the books on every read, like the API's
// subquery, so a posted entry shows up in it at once
export type MockCustomer = Omit<Customer, 'balance'>;
export type MockGroup = Omit<CustomerGroup, 'customerCount'>;
export type MockPriceList = Omit<PriceList, 'itemCount' | 'customerCount'>;

// One price: the API's price_list_items row. The product's name, code and SKU are looked up on
// read, so a renamed product shows its new name.
export interface MockPriceItem {
  priceListId: string;
  productId: string;
  variantId: string;
  unitId: string;
  price: string;
  updatedAt: string;
}

export interface MockSales {
  taxRates: TaxRate[];
  groups: MockGroup[];
  customers: MockCustomer[];
  priceLists: MockPriceList[];
  priceItems: MockPriceItem[];
  // The last number given from the 'sales.customer' series
  lastCode: number;
}

function now(): string {
  return new Date().toISOString();
}

// "15" → "15.00", "18500" → "18500.0000": the way Postgres sends NUMERIC(5,2) and NUMERIC(19,4)
function percent(value: string): string {
  return Number(value).toFixed(2);
}

function money(value: string): string {
  return Number(value).toFixed(4);
}

export function emptySales(): MockSales {
  return { taxRates: [], groups: [], customers: [], priceLists: [], priceItems: [], lastCode: 0 };
}

// The API's TAX_RATES template (apps/api/src/setup/templates.ts): what the setup job gives a new
// workspace, and what migration 0026 gave the old ones
export function startingTaxRates(): TaxRate[] {
  const rate = (name: string, kind: string, value: string, isDefault = false): TaxRate => ({
    id: crypto.randomUUID(),
    name,
    kind,
    rate: percent(value),
    isDefault,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  });
  return [
    rate('VAT 15%', 'standard', '15', true),
    rate('VAT 10%', 'reduced', '10'),
    rate('VAT 7.5%', 'reduced', '7.5'),
    rate('VAT 5%', 'reduced', '5'),
    rate('Zero-rated', 'zero_rated', '0'),
    rate('Exempt', 'exempt', '0'),
  ];
}

// --- Seed ---------------------------------------------------------------------------------------

function group(name: string): MockGroup {
  return { id: crypto.randomUUID(), name, version: 1, updatedAt: now() };
}

function priceList(name: string, description: string | null): MockPriceList {
  return {
    id: crypto.randomUUID(),
    name,
    description,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

interface CustomerParts {
  name: string;
  group: MockGroup | null;
  contactPerson?: string;
  phone?: string;
  email?: string;
  bin?: string;
  paymentTermsDays: number;
  creditLimit: string | null;
  priceList?: MockPriceList;
  billing?: string;
  shipping?: [label: string, address: string][];
  archived?: boolean;
}

function customer(sales: MockSales, parts: CustomerParts): MockCustomer {
  sales.lastCode += 1;
  return {
    id: crypto.randomUUID(),
    code: formatDocumentNumber(defaultNumberFormat('sales.customer'), '', sales.lastCode),
    name: parts.name,
    groupId: parts.group?.id ?? null,
    contactPerson: parts.contactPerson ?? null,
    phone: parts.phone ?? null,
    email: parts.email ?? null,
    bin: parts.bin ?? null,
    paymentTermsDays: parts.paymentTermsDays,
    creditLimit: parts.creditLimit === null ? null : money(parts.creditLimit),
    priceListId: parts.priceList?.id ?? null,
    notes: null,
    addresses: [
      ...(parts.billing === undefined
        ? []
        : [
            {
              id: crypto.randomUUID(),
              kind: 'billing',
              label: null,
              address: parts.billing,
              phone: null,
            },
          ]),
      ...(parts.shipping ?? []).map(([label, address]) => ({
        id: crypto.randomUUID(),
        kind: 'shipping',
        label,
        address,
        phone: null,
      })),
    ],
    isSupplier: false,
    archivedAt: parts.archived ? now() : null,
    version: 1,
    updatedAt: now(),
  };
}

// A price for every active variant of a product, in one of its units
function pricesFor(
  catalog: MockCatalog,
  list: MockPriceList,
  code: string,
  unitCode: string,
  price: string,
): MockPriceItem[] {
  const product = catalog.products.find((item) => item.code === code);
  const unit = catalog.units.find((item) => item.code === unitCode);
  if (!product || !unit) throw new Error(`The mock catalog has no ${code} in ${unitCode}`);
  return product.variants.map((variant) => ({
    priceListId: list.id,
    productId: product.id,
    variantId: variant.id,
    unitId: unit.id,
    price: money(price),
    updatedAt: now(),
  }));
}

// Real-looking buyers (CLAUDE.md → Content). The garments workspace sells to export buyers, whose
// receivable lines are in its seeded journal (seedJournal names H&M and Primark), and to a few
// local ones. The pharma workspace sells to pharmacies and hospitals at a pharmacy price, with
// medicine exempt from VAT.
export function seedSales(data: WorkspaceData, garments: boolean): void {
  const sales = data.sales;
  sales.taxRates = startingTaxRates();
  if (garments) {
    const exportBuyers = group('Export buyers');
    const local = group('Local buyers');
    const houses = group('Buying houses');
    const fob = priceList('Export FOB', 'FOB Chattogram prices for export buyers, before VAT');
    const wholesale = priceList('Local wholesale', null);
    sales.groups = [exportBuyers, local, houses];
    sales.priceLists = [fob, wholesale];
    sales.priceItems = [
      ...pricesFor(data.catalog, fob, 'ST-118', 'pcs', '585'),
      ...pricesFor(data.catalog, fob, 'ST-118', 'dozen', '6900'),
      ...pricesFor(data.catalog, wholesale, 'P-00001', 'pcs', '290'),
      ...pricesFor(data.catalog, wholesale, 'P-00004', 'carton', '2750'),
    ];
    sales.customers = [
      customer(sales, {
        name: 'H&M Hennes & Mauritz GBC AB',
        group: exportBuyers,
        contactPerson: 'Anna Lindqvist',
        phone: '+46 8 796 55 00',
        email: 'sourcing.dhaka@hm.com',
        paymentTermsDays: 90,
        creditLimit: '50000000',
        priceList: fob,
        billing: 'Mäster Samuelsgatan 46A, 106 38 Stockholm, Sweden',
        shipping: [['Chattogram port', 'CFS shed 3, Chattogram port, Chattogram 4100']],
      }),
      customer(sales, {
        name: 'Primark Stores Ltd.',
        group: exportBuyers,
        contactPerson: 'Ciara Byrne',
        phone: '+353 1 888 0400',
        paymentTermsDays: 120,
        creditLimit: null,
        priceList: fob,
        billing: 'Arthur Ryan House, 22-24 Parnell Street, Dublin 1, Ireland',
      }),
      customer(sales, {
        name: 'Aarong',
        group: local,
        contactPerson: 'Mahmudul Hasan',
        phone: '+880 1713-045678',
        bin: '0003456780202',
        paymentTermsDays: 30,
        creditLimit: '500000',
        priceList: wholesale,
        billing: 'Plot 446/F, Tejgaon Industrial Area, Dhaka 1208',
        shipping: [
          ['Central warehouse', 'Aarong central warehouse, Jamgora, Ashulia, Savar'],
          ['Uttara outlet', 'House 2, Road 7, Sector 3, Uttara, Dhaka 1230'],
        ],
      }),
      customer(sales, {
        name: 'Bengal Buying House Ltd.',
        group: houses,
        contactPerson: 'Rafiqul Islam',
        phone: '+880 1819-223344',
        paymentTermsDays: 0,
        creditLimit: '0',
        billing: 'House 9, Road 4, Gulshan 1, Dhaka 1212',
      }),
      customer(sales, {
        name: 'Sonar Bangla Traders',
        group: local,
        phone: '+880 1552-667788',
        paymentTermsDays: 15,
        creditLimit: '100000',
        archived: true,
      }),
    ];
    return;
  }
  const pharmacies = group('Pharmacies');
  const hospitals = group('Hospitals');
  const pharmacy = priceList('Pharmacy', 'Trade price for retail pharmacies, VAT included');
  sales.groups = [pharmacies, hospitals, group('Distributors')];
  sales.priceLists = [pharmacy];
  sales.priceItems = [
    ...pricesFor(data.catalog, pharmacy, 'P-00001', 'pcs', '1.08'),
    ...pricesFor(data.catalog, pharmacy, 'P-00001', 'strip', '10.50'),
    ...pricesFor(data.catalog, pharmacy, 'P-00001', 'box', '102'),
  ];
  sales.customers = [
    customer(sales, {
      name: 'Lazz Pharma Ltd.',
      group: pharmacies,
      contactPerson: 'Shamim Ahmed',
      phone: '+880 1711-556677',
      paymentTermsDays: 15,
      creditLimit: '300000',
      priceList: pharmacy,
      billing: '64/3 Lake Circus, Kalabagan, Dhaka 1205',
      shipping: [['Kalabagan branch', '64/3 Lake Circus, Kalabagan, Dhaka 1205']],
    }),
    customer(sales, {
      name: 'Square Hospitals Ltd.',
      group: hospitals,
      contactPerson: 'Dr. Nazmul Karim',
      phone: '+880 2-8144400',
      bin: '0004567890303',
      paymentTermsDays: 45,
      creditLimit: '2000000',
      billing: '18/F Bir Uttam Qazi Nuruzzaman Sarak, West Panthapath, Dhaka 1205',
    }),
    customer(sales, {
      name: 'Tamanna Pharmacy',
      group: pharmacies,
      phone: '+880 1913-778899',
      paymentTermsDays: 0,
      creditLimit: '0',
      priceList: pharmacy,
      billing: 'Shop 12, Mirpur 10 Circle, Dhaka 1216',
    }),
  ];
  // Paracetamol is exempt from VAT: the product picks its own rate instead of the default
  const exempt = sales.taxRates.find((rate) => rate.kind === 'exempt');
  const napa = data.catalog.products.find((item) => item.code === 'P-00001');
  if (napa && exempt) napa.taxRateId = exempt.id;
}

// --- VAT rates ----------------------------------------------------------------------------------

function rateNameTaken(rates: readonly TaxRate[], name: string, except?: string): boolean {
  return rates.some((rate) => rate.id !== except && rate.name.toLowerCase() === name.toLowerCase());
}

// The API's order: the default first, then the highest rate, then by name
export function sortedTaxRates(sales: MockSales): TaxRate[] {
  return sales.taxRates.toSorted(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      Number(b.rate) - Number(a.rate) ||
      a.name.localeCompare(b.name),
  );
}

export function findTaxRate(sales: MockSales, id: string): TaxRate {
  const found = sales.taxRates.find((rate) => rate.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function clearDefault(sales: MockSales): void {
  for (const rate of sales.taxRates) {
    if (rate.isDefault) Object.assign(rate, { isDefault: false, version: rate.version + 1 });
  }
}

// The first rate of a workspace is its default, whatever the form said: exactly one rate is
export function createTaxRate(sales: MockSales, input: TaxRateInput): TaxRate {
  if (rateNameTaken(sales.taxRates, input.name)) {
    throw new MockProblem(409, 'tax_rate_name_taken', { name: ['tax_rate_name_taken'] });
  }
  const isDefault = input.isDefault || !sales.taxRates.some((rate) => rate.isDefault);
  if (isDefault) clearDefault(sales);
  const created: TaxRate = {
    id: crypto.randomUUID(),
    name: input.name,
    kind: input.kind,
    rate: percent(input.rate),
    isDefault,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
  sales.taxRates.push(created);
  return created;
}

export function updateTaxRate(
  sales: MockSales,
  target: TaxRate,
  input: TaxRateInput & { version: number },
): void {
  if (target.version !== input.version) throw new MockProblem(409, 'version_conflict');
  if (target.isDefault && !input.isDefault) {
    throw new MockProblem(409, 'tax_rate_default_needed', {
      isDefault: ['tax_rate_default_needed'],
    });
  }
  if (input.isDefault && target.archivedAt !== null) {
    throw new MockProblem(409, 'tax_rate_default_archived', {
      isDefault: ['tax_rate_default_archived'],
    });
  }
  if (rateNameTaken(sales.taxRates, input.name, target.id)) {
    throw new MockProblem(409, 'tax_rate_name_taken', { name: ['tax_rate_name_taken'] });
  }
  if (input.isDefault && !target.isDefault) clearDefault(sales);
  Object.assign(target, {
    name: input.name,
    kind: input.kind,
    rate: percent(input.rate),
    isDefault: input.isDefault,
    version: target.version + 1,
    updatedAt: now(),
  });
}

export function setTaxRateArchived(target: TaxRate, version: number, archived: boolean): void {
  if (target.version !== version) throw new MockProblem(409, 'version_conflict');
  if ((target.archivedAt !== null) === archived) return;
  if (archived && target.isDefault) {
    throw new MockProblem(409, 'tax_rate_default_archived', {
      isDefault: ['tax_rate_default_archived'],
    });
  }
  Object.assign(target, {
    archivedAt: archived ? now() : null,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// A product's rate: an active one, or the archived one it already had (products.service.ts)
export function assertProductTaxRate(
  sales: MockSales,
  taxRateId: string | null,
  kept: string | null,
): void {
  if (taxRateId === null) return;
  const rate = sales.taxRates.find((item) => item.id === taxRateId);
  if (!rate || (rate.archivedAt !== null && taxRateId !== kept)) {
    throw new MockProblem(400, 'invalid_input', { taxRateId: ['tax_rate_invalid'] });
  }
}

// --- Customers ----------------------------------------------------------------------------------

function isReceivable(data: WorkspaceData, accountId: string): boolean {
  return data.accounts.some(
    (account) => account.id === accountId && account.purpose === 'accounts_receivable',
  );
}

// What the customer owes: debit − credit of its posted receivable lines
function balanceOf(data: WorkspaceData, partyId: string): string {
  const lines = data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) => entry.lines)
    .filter((line) => line.party?.id === partyId && isReceivable(data, line.accountId));
  return subtractMoney(
    sumMoney(lines.map((line) => line.debit)),
    sumMoney(lines.map((line) => line.credit)),
  );
}

// The owner sees every balance; a mock signed in without sales.customer.balance would get null
export function toCustomer(data: WorkspaceData, stored: MockCustomer): Customer {
  return { ...stored, balance: balanceOf(data, stored.id) };
}

export function customerSummaryOf(data: WorkspaceData, stored: MockCustomer): CustomerSummary {
  return {
    id: stored.id,
    code: stored.code,
    name: stored.name,
    groupId: stored.groupId,
    contactPerson: stored.contactPerson,
    phone: stored.phone,
    paymentTermsDays: stored.paymentTermsDays,
    creditLimit: stored.creditLimit,
    balance: balanceOf(data, stored.id),
    archivedAt: stored.archivedAt,
    updatedAt: stored.updatedAt,
  };
}

export function findCustomer(sales: MockSales, id: string): MockCustomer {
  const found = sales.customers.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The API's filters and orders, on an array. The cursor is an offset, like the mock's other lists.
export function listCustomers(
  sales: MockSales,
  query: {
    search?: string | undefined;
    groupId?: string | undefined;
    status: CustomerStatus;
    sort: CustomerSort;
  },
): MockCustomer[] {
  const search = query.search?.toLowerCase() ?? '';
  const lower = (value: string | null) => value?.toLowerCase() ?? '';
  const found = sales.customers.filter(
    (item) =>
      (query.status === 'archived') === (item.archivedAt !== null) &&
      (query.groupId === undefined || item.groupId === query.groupId) &&
      (search === '' ||
        lower(item.name).includes(search) ||
        lower(item.code).includes(search) ||
        lower(item.contactPerson).includes(search) ||
        // The phone as typed, like the API: digits have no case
        (item.phone ?? '').includes(query.search ?? '')),
  );
  const by = {
    name: (a: MockCustomer, b: MockCustomer) => lower(a.name).localeCompare(lower(b.name)),
    '-name': (a: MockCustomer, b: MockCustomer) => lower(b.name).localeCompare(lower(a.name)),
    code: (a: MockCustomer, b: MockCustomer) => lower(a.code).localeCompare(lower(b.code)),
    '-code': (a: MockCustomer, b: MockCustomer) => lower(b.code).localeCompare(lower(a.code)),
    '-updated': (a: MockCustomer, b: MockCustomer) => b.updatedAt.localeCompare(a.updatedAt),
  };
  return found.sort(by[query.sort]);
}

function fieldProblem(status: number, code: ErrorCode, field: string): MockProblem {
  return new MockProblem(status, status === 409 ? code : 'invalid_input', { [field]: [code] });
}

// The next free code from the 'sales.customer' series; a code someone typed by hand is skipped
function newCode(data: WorkspaceData): string {
  const format = data.series.get('sales.customer') ?? defaultNumberFormat('sales.customer');
  const period = periodOf(
    todayIn(data.settings.timezone),
    format.yearStyle,
    data.settings.fiscalYearStartMonth,
  );
  for (;;) {
    data.sales.lastCode += 1;
    const code = formatDocumentNumber(format, period, data.sales.lastCode);
    if (!data.sales.customers.some((item) => item.code.toLowerCase() === code.toLowerCase())) {
      return code;
    }
  }
}

// Create (no `existing`) or update. The addresses sent replace the old ones; one sent back with
// its id keeps it, one with an id that is not this customer's becomes a new address. The billing
// address comes first, then the shipping ones in the order sent.
export function saveCustomer(
  data: WorkspaceData,
  input: CustomerInput,
  existing?: MockCustomer,
): MockCustomer {
  const { sales } = data;
  if (input.groupId !== null && !sales.groups.some((item) => item.id === input.groupId)) {
    throw fieldProblem(400, 'customer_group_invalid', 'groupId');
  }
  if (input.priceListId !== null) {
    const list = sales.priceLists.find((item) => item.id === input.priceListId);
    const kept = existing?.priceListId === input.priceListId;
    if (!list || (list.archivedAt !== null && !kept)) {
      throw fieldProblem(400, 'price_list_invalid', 'priceListId');
    }
  }
  const code = input.code ?? existing?.code ?? newCode(data);
  const taken = sales.customers.some(
    (item) => item.id !== existing?.id && item.code.toLowerCase() === code.toLowerCase(),
  );
  if (taken) throw fieldProblem(409, 'customer_code_taken', 'code');
  const own = new Set(existing?.addresses.map((address) => address.id));
  const addresses = input.addresses.map((address) => ({
    id: address.id !== null && own.has(address.id) ? address.id : crypto.randomUUID(),
    kind: address.kind,
    label: address.label,
    address: address.address,
    phone: address.phone,
  }));
  return {
    id: existing?.id ?? crypto.randomUUID(),
    code,
    name: input.name,
    groupId: input.groupId,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email,
    bin: input.bin,
    paymentTermsDays: input.paymentTermsDays,
    creditLimit: input.creditLimit === null ? null : money(input.creditLimit),
    priceListId: input.priceListId,
    notes: input.notes,
    addresses: [
      ...addresses.filter((address) => address.kind === 'billing'),
      ...addresses.filter((address) => address.kind !== 'billing'),
    ],
    isSupplier: existing?.isSupplier ?? false,
    archivedAt: existing?.archivedAt ?? null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
}

// The journal keeps a party's code and name on each line (the API joins them on read): after a
// rename the lines show the new name, like the API's
export function refreshPartyRefs(data: WorkspaceData, saved: MockCustomer): void {
  for (const entry of data.journal.entries) {
    for (const line of entry.lines) {
      if (line.party?.id === saved.id)
        line.party = { id: saved.id, code: saved.code, name: saved.name };
    }
  }
}

// Only a customer no entry names, drafts included (the API's journal_lines_party_fk)
export function assertCustomerUnused(data: WorkspaceData, id: string): void {
  const used = data.journal.entries.some((entry) =>
    entry.lines.some((line) => line.party?.id === id),
  );
  if (used) throw new MockProblem(409, 'customer_in_use');
}

// A line's customer as the journal shows it. Unknown, archived (unless allowArchived) or not a
// customer: undefined, and checkParties() answers journal_party_invalid.
export function partyRefOf(
  sales: MockSales,
  partyId: string,
  allowArchived = false,
): PartyRef | undefined {
  const found = sales.customers.find((item) => item.id === partyId);
  if (!found || (found.archivedAt !== null && !allowArchived)) return undefined;
  return { id: found.id, code: found.code, name: found.name };
}

// --- Customer groups ----------------------------------------------------------------------------

export function toGroup(sales: MockSales, stored: MockGroup): CustomerGroup {
  return {
    ...stored,
    // Archived customers count too: they keep their group
    customerCount: sales.customers.filter((item) => item.groupId === stored.id).length,
  };
}

export function findGroup(sales: MockSales, id: string): MockGroup {
  const found = sales.groups.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertGroupNameFree(sales: MockSales, name: string, except?: string): void {
  const taken = sales.groups.some(
    (item) => item.id !== except && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new MockProblem(409, 'customer_group_name_taken', {
      name: ['customer_group_name_taken'],
    });
  }
}

// --- Price lists --------------------------------------------------------------------------------

export function toPriceList(sales: MockSales, stored: MockPriceList): PriceList {
  return {
    ...stored,
    itemCount: sales.priceItems.filter((item) => item.priceListId === stored.id).length,
    customerCount: sales.customers.filter((item) => item.priceListId === stored.id).length,
  };
}

export function findPriceList(sales: MockSales, id: string): MockPriceList {
  const found = sales.priceLists.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertPriceListNameFree(sales: MockSales, name: string, except?: string): void {
  const taken = sales.priceLists.some(
    (item) => item.id !== except && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new MockProblem(409, 'price_list_name_taken', { name: ['price_list_name_taken'] });
  }
}

// The prices of a list with what each row shows, by product name (then variant and unit, the
// API's cursor order), searched by product name, code or SKU
export function priceItemsOf(
  data: WorkspaceData,
  listId: string,
  search: string | undefined,
): PriceListItem[] {
  const term = search?.toLowerCase() ?? '';
  return data.sales.priceItems
    .filter((item) => item.priceListId === listId)
    .flatMap((item) => {
      const product = data.catalog.products.find((row) => row.id === item.productId);
      const variant = product?.variants.find((row) => row.id === item.variantId);
      if (!product || !variant) return [];
      const row: PriceListItem = {
        variantId: item.variantId,
        unitId: item.unitId,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        sku: variant.sku,
        optionValues: variant.optionValues,
        price: item.price,
        updatedAt: item.updatedAt,
      };
      const found =
        term === '' ||
        product.name.toLowerCase().includes(term) ||
        product.code.toLowerCase().includes(term) ||
        variant.sku.toLowerCase().includes(term);
      return found ? [row] : [];
    })
    .sort(
      (a, b) =>
        a.productName.toLowerCase().localeCompare(b.productName.toLowerCase()) ||
        a.variantId.localeCompare(b.variantId) ||
        a.unitId.localeCompare(b.unitId),
    );
}

// A batch of prices, all or nothing: every change must be a known variant in a unit its product
// is sold in (the base unit or a pack). '' (null) takes the price out of the list.
export function setPriceItems(
  data: WorkspaceData,
  list: MockPriceList,
  input: SetPriceListItemsInput,
): { set: number; removed: number } {
  if (list.archivedAt !== null) throw new MockProblem(409, 'price_list_invalid');
  const fieldErrors: Record<string, ErrorCode[]> = {};
  const rows = input.changes.flatMap((change, index) => {
    const product = data.catalog.products.find((item) =>
      item.variants.some((variant) => variant.id === change.variantId),
    );
    if (!product) {
      fieldErrors[`changes.${String(index)}.variantId`] = ['product_variant_unknown'];
      return [];
    }
    const sold =
      product.baseUnitId === change.unitId ||
      product.units.some((pack) => pack.unitId === change.unitId);
    if (!sold) {
      fieldErrors[`changes.${String(index)}.unitId`] = ['price_list_unit_invalid'];
      return [];
    }
    return [{ ...change, productId: product.id }];
  });
  const [first] = Object.values(fieldErrors).flat();
  if (first !== undefined) throw new MockProblem(409, first, fieldErrors);

  const same = (item: MockPriceItem, row: { variantId: string; unitId: string }) =>
    item.priceListId === list.id && item.variantId === row.variantId && item.unitId === row.unitId;
  let set = 0;
  let removed = 0;
  for (const row of rows) {
    const existing = data.sales.priceItems.find((item) => same(item, row));
    if (row.price === null) {
      // Counted like the API's audit row: what was asked, not what was there
      removed += 1;
      data.sales.priceItems = data.sales.priceItems.filter((item) => !same(item, row));
    } else if (existing) {
      Object.assign(existing, { price: money(row.price), updatedAt: now() });
      set += 1;
    } else {
      data.sales.priceItems.push({
        priceListId: list.id,
        productId: row.productId,
        variantId: row.variantId,
        unitId: row.unitId,
        price: money(row.price),
        updatedAt: now(),
      });
      set += 1;
    }
  }
  return { set, removed };
}

// After a product is saved or deleted: the prices of a variant it no longer has, or of a unit it is
// no longer sold in, go (the API's cascade and products.service.ts's delete)
export function dropStalePrices(data: WorkspaceData): void {
  data.sales.priceItems = data.sales.priceItems.filter((item) => {
    const product = data.catalog.products.find((row) => row.id === item.productId);
    return (
      product !== undefined &&
      product.variants.some((variant) => variant.id === item.variantId) &&
      (product.baseUnitId === item.unitId ||
        product.units.some((pack) => pack.unitId === item.unitId))
    );
  });
}
```

- **The rules live here, the handlers only call them.** This is how `product-data.ts` and `stock-data.ts` are
  built: `handlers.ts` reads the request, calls one function, writes the audit row and replies. A rule written
  inside a handler could not be reused (the journal needs `partyRefOf()`, the products need
  `assertProductTaxRate()`).
- **`MockCustomer` has no `balance`.** The API works the balance out from the posted receivable lines on every
  read. A stored balance would have to be changed by every handler that posts an entry (journal, opening balances,
  year-end, reversals), and one forgotten place would show a wrong number. `balanceOf()` sums the lines instead,
  so a posted entry shows in the balance at once. The same goes for `customerCount` and `itemCount`: they are
  counted on read.
- **`percent()` and `money()` format numbers like Postgres sends them**: `"15.00"` for NUMERIC(5,2) and
  `"500000.0000"` for NUMERIC(19,4). The app is written against the real API, so the mock must send the same
  strings: `plainRate()` (15a.6) strips trailing zeros only because the API sends them.
- **`startingTaxRates()` repeats the API's `TAX_RATES` template.** The mock runs in the browser and cannot import
  server code, so the six rates are copied. The setup job (`setup-data.ts`) uses the same function for a new
  workspace.
- **`seedSales()` uses real-looking buyers** (CLAUDE.md → Content): export buyers, a local retailer and a buying
  house for the garments workspace; pharmacies and a hospital for the pharma one. Each customer shows something
  the list has to handle: "No limit", "Cash only" (`creditLimit: '0'`), "On receipt" (0 days), several shipping
  addresses, and one archived customer. Codes come from the `sales.customer` series format, so they look like the
  API's (`C-00001`).
- **The pharma workspace gives Napa the Exempt rate.** Paracetamol is exempt, and it shows a product with its own
  rate next to the many that follow the default.
- **`createTaxRate()` makes the first rate the default** whatever the form said, and `clearDefault()` takes the
  flag off the old default before setting the new one. This is the API's rule: exactly one default. The old
  default's version goes up, like in the API, so a settings page still holding it must reload.
- **`updateTaxRate()` checks in the API's order**: version, then "the default cannot be switched off", then
  "an archived rate cannot become the default", then the name. The order decides which error a person sees when
  two rules break at once, and the e2e tests should see what the real API would answer.
- **`assertProductTaxRate()` keeps an archived rate the product already has** (`kept`). Without it, archiving a
  rate would make every product that uses it unsavable until someone picks a new rate.
- **`listCustomers()` matches the phone as typed**, not lowercased, like the API: digits have no case, and "1811"
  finds "+880 1811-445566".
- **`saveCustomer()` keeps an address id only if it is this customer's.** An id from another customer becomes a
  new address. In the API, this protects a delivery (15b) that points at an address: it can never be moved to
  another customer by a crafted request. The billing address is put first, as the API reads them.
- **`refreshPartyRefs()`** exists because the mock stores the customer's code and name on each journal line,
  while the API joins them on read. After a rename, the API's journal shows the new name; this loop makes the
  mock do the same.
- **`assertCustomerUnused()` looks at drafts too.** The API's foreign key (`journal_lines_party_fk`) is on every
  line, posted or not.
- **`partyRefOf(…, allowArchived)`** answers "is this a usable customer?". A new line needs an active one; a
  reversal re-posts old lines, whose customer may be archived since.
- **`setPriceItems()` is all or nothing.** All changes are checked first; only then is anything written. A
  half-saved batch would leave the page's "N prices changed" out of step with the list. `removed` counts the
  rows asked to be removed, like the API's audit row.
- **`dropStalePrices()`** removes prices of a variant or unit a product no longer has, and of a deleted product.
  In the API, the variant's foreign key cascades and `ProductsService.update` deletes prices of dropped packs.

### `mocks/journal-data.ts`: the party rule, the statement, the customer on each line

```diff
@@ -7,11 +7,13 @@ import {
   fiscalYearOf,
   formatDocumentNumber,
   isNegativeMoney,
+  isPartyAccountPurpose,
   isStockJournalSource,
   isZeroMoney,
   type JournalEntry,
   type JournalEntrySummary,
   type JournalLineInput,
+  type JournalLine,
   type JournalSource,
   type LedgerPage,
   negateMoney,
@@ -26,6 +28,7 @@ import {
 } from '@omnivo/contracts';
 
 import { MockProblem } from './mock';
+import { partyRefOf } from './sales-data';
 import type { WorkspaceData } from './workspace-data';
 
 // The mock's books: the API's rules (journal.service.ts, posting.service.ts) on plain arrays, so
@@ -44,7 +47,10 @@ export function emptyJournal(): MockJournal {
   return { entries: [], lockDate: null, lockVersion: 0, counters: new Map() };
 }
 
-type LineIn = Pick<JournalLineInput, 'accountId' | 'branchId' | 'description' | 'debit' | 'credit'>;
+type LineIn = Pick<
+  JournalLineInput,
+  'accountId' | 'branchId' | 'partyId' | 'description' | 'debit' | 'credit'
+>;
 
 // "18500" → "18500.0000", the way Postgres sends NUMERIC(19,4)
 function fixed(value: string): string {
@@ -72,11 +78,47 @@ export function stockAccountIds(data: WorkspaceData): Set<string> {
   );
 }
 
+type PartyCode = 'journal_party_required' | 'journal_party_not_allowed' | 'journal_party_invalid';
+
+// The party rule (step 15a, the API's checkParties()): a line on the receivable names a customer,
+// and no other line names anyone. Each wrong line gets its own code under lines.N.partyId, so the
+// form marks every row at once. allowMissing: a draft, or a reversal of an entry from before 15a.
+export function partyIssues(
+  data: WorkspaceData,
+  lines: readonly { accountId: string; partyId: string | null }[],
+  { allowMissing = false, allowArchived = false } = {},
+): { index: number; code: PartyCode }[] {
+  return lines.flatMap((line, index): { index: number; code: PartyCode }[] => {
+    const account = data.accounts.find((item) => item.id === line.accountId);
+    const perParty = isPartyAccountPurpose(account?.purpose ?? null);
+    if (line.partyId === null) {
+      return perParty && !allowMissing ? [{ index, code: 'journal_party_required' }] : [];
+    }
+    if (!perParty) return [{ index, code: 'journal_party_not_allowed' }];
+    return partyRefOf(data.sales, line.partyId, allowArchived)
+      ? []
+      : [{ index, code: 'journal_party_invalid' }];
+  });
+}
+
+export function partyProblem(issues: readonly { index: number; code: PartyCode }[]): MockProblem {
+  return new MockProblem(
+    409,
+    issues[0]?.code ?? 'journal_party_invalid',
+    Object.fromEntries(
+      issues.map((issue) => [`lines.${String(issue.index)}.partyId`, [issue.code]]),
+    ),
+  );
+}
+
 export function checkLines(
   data: WorkspaceData,
-  lines: readonly LineIn[],
-  allowArchived = false,
-  allowStock = false,
+  lines: readonly Pick<LineIn, 'accountId' | 'branchId' | 'partyId'>[],
+  {
+    allowArchived = false,
+    allowStock = false,
+    allowMissingParty = false,
+  }: { allowArchived?: boolean; allowStock?: boolean; allowMissingParty?: boolean } = {},
 ): void {
   const badAccounts = lines.flatMap((line, index) => {
     const account = data.accounts.find((item) => item.id === line.accountId);
@@ -97,6 +139,27 @@ export function checkLines(
     return branch && (allowArchived || branch.archivedAt === null) ? [] : [index];
   });
   if (badBranches.length > 0) throw linesProblem('journal_branch_invalid', 'branchId', badBranches);
+  const parties = partyIssues(data, lines, { allowMissing: allowMissingParty, allowArchived });
+  if (parties.length > 0) throw partyProblem(parties);
+}
+
+// The stored lines: the customer's code and name kept with its id (refreshPartyRefs() keeps them
+// current after a rename). Checked before this, so an id that finds nothing is not expected.
+function toLines(data: WorkspaceData, lines: readonly LineIn[]): JournalLine[] {
+  return lines.map((line) => ({
+    id: crypto.randomUUID(),
+    accountId: line.accountId,
+    branchId: line.branchId,
+    party: line.partyId === null ? null : (partyRefOf(data.sales, line.partyId, true) ?? null),
+    description: line.description,
+    debit: fixed(line.debit),
+    credit: fixed(line.credit),
+  }));
+}
+
+// A stored line back as input: what a reversal or a post re-checks
+function asInput(line: JournalLine): LineIn {
+  return { ...line, partyId: line.party?.id ?? null };
 }
 
 function assertOpen(data: WorkspaceData, date: string): void {
@@ -168,20 +231,14 @@ export function writeDraft(
     postedAt: null,
     version: 1,
     updatedAt: now,
-    lines: input.lines.map((line) => ({
-      id: crypto.randomUUID(),
-      accountId: line.accountId,
-      branchId: line.branchId,
-      description: line.description,
-      debit: fixed(line.debit),
-      credit: fixed(line.credit),
-    })),
+    lines: toLines(data, input.lines),
   };
   data.journal.entries.push(entry);
   return entry;
 }
 
 export function replaceDraft(
+  data: WorkspaceData,
   entry: JournalEntry,
   input: { date: string; narration: string | null; lines: readonly LineIn[] },
 ): void {
@@ -191,14 +248,7 @@ export function replaceDraft(
     total: sumMoney(input.lines.map((line) => line.debit)),
     version: entry.version + 1,
     updatedAt: new Date().toISOString(),
-    lines: input.lines.map((line) => ({
-      id: crypto.randomUUID(),
-      accountId: line.accountId,
-      branchId: line.branchId,
-      description: line.description,
-      debit: fixed(line.debit),
-      credit: fixed(line.credit),
-    })),
+    lines: toLines(data, input.lines),
   });
 }
 
@@ -209,7 +259,12 @@ export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
   const credits = sumMoney(entry.lines.map((line) => line.credit));
   if (debits !== credits) throw new MockProblem(409, 'journal_unbalanced');
   const oldWork = entry.source === 'reversal' || entry.source === 'year_close';
-  checkLines(data, entry.lines, oldWork, oldWork || isStockJournalSource(entry.source));
+  checkLines(data, entry.lines.map(asInput), {
+    allowArchived: oldWork,
+    allowStock: oldWork || isStockJournalSource(entry.source),
+    // A reversal of an entry posted before step 15a: its receivable line had no customer
+    allowMissingParty: entry.source === 'reversal',
+  });
   Object.assign(entry, {
     status: 'posted',
     number: nextNumber(data, entry.date),
@@ -241,7 +296,11 @@ export function reverseEntry(
     {
       date,
       narration: `Reversal of ${entry.number ?? ''}`,
-      lines: entry.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
+      lines: entry.lines.map((line) => ({
+        ...asInput(line),
+        debit: line.credit,
+        credit: line.debit,
+      })),
     },
     'reversal',
     { id: entry.id, number: entry.number ?? '' },
@@ -273,28 +332,51 @@ export function postNew(
   return entry;
 }
 
-export function ledgerOf(
-  data: WorkspaceData,
-  accountId: string,
-  query: {
-    from?: string | undefined;
-    to?: string | undefined;
-    cursor?: string | undefined;
-    limit: number;
-  },
-): LedgerPage {
+interface LedgerQuery {
+  from?: string | undefined;
+  to?: string | undefined;
+  cursor?: string | undefined;
+  limit: number;
+}
+
+export function ledgerOf(data: WorkspaceData, accountId: string, query: LedgerQuery): LedgerPage {
   if (!data.accounts.some((account) => account.id === accountId)) {
     throw new MockProblem(404, 'not_found');
   }
+  return pageOf(data, (line) => line.accountId === accountId, query);
+}
+
+// A customer's statement (step 15a): the same page over the receivable lines that name it
+export function statementOf(data: WorkspaceData, partyId: string, query: LedgerQuery): LedgerPage {
+  if (!data.sales.customers.some((item) => item.id === partyId)) {
+    throw new MockProblem(404, 'not_found');
+  }
+  const receivable = new Set(
+    data.accounts
+      .filter((account) => account.purpose === 'accounts_receivable')
+      .map((account) => account.id),
+  );
+  return pageOf(
+    data,
+    (line) => line.party?.id === partyId && receivable.has(line.accountId),
+    query,
+  );
+}
+
+// The posted lines that match, in date order, with the running balance and the balances around
+// the dates asked for
+function pageOf(
+  data: WorkspaceData,
+  matches: (line: JournalLine) => boolean,
+  query: LedgerQuery,
+): LedgerPage {
   const order = new Map(data.journal.entries.map((entry, index) => [entry.id, index]));
   const all = data.journal.entries
     .filter((entry) => entry.status === 'posted')
     .toSorted(
       (a, b) => a.date.localeCompare(b.date) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
     )
-    .flatMap((entry) =>
-      entry.lines.filter((line) => line.accountId === accountId).map((line) => ({ entry, line })),
-    );
+    .flatMap((entry) => entry.lines.filter(matches).map((line) => ({ entry, line })));
   const before = all.filter(({ entry }) => query.from !== undefined && entry.date < query.from);
   const inRange = all.filter(
     ({ entry }) =>
@@ -322,6 +404,7 @@ export function ledgerOf(
         date: entry.date,
         narration: entry.narration,
         description: line.description,
+        party: line.party,
         debit: line.debit,
         credit: line.credit,
         balance,
@@ -355,7 +438,12 @@ export function openingOf(data: WorkspaceData): OpeningBalances {
     entry: { id: entry.id, number: entry.number },
     lines: entry.lines
       .filter((line) => line.accountId !== equity?.id)
-      .map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })),
+      .map((line) => ({
+        accountId: line.accountId,
+        party: line.party,
+        debit: line.debit,
+        credit: line.credit,
+      })),
   };
 }
 
@@ -397,11 +485,23 @@ export function saveOpening(data: WorkspaceData, input: OpeningBalancesInput): v
       ),
     );
   }
+  // Step 15a: the receivable is split by customer. Checked on the page's rows, not on the posted
+  // entry, whose lines have no zero rows and an extra equity line.
+  const parties = partyIssues(data, filled);
+  if (parties.length > 0) {
+    throw partyProblem(
+      parties.flatMap((issue) => {
+        const line = filled[issue.index];
+        return line ? [{ ...issue, index: line.index }] : [];
+      }),
+    );
+  }
   if (current) reverseEntry(data, current, current.date);
   if (filled.length === 0) return;
   const lines: LineIn[] = filled.map((line) => ({
     accountId: line.accountId,
     branchId: null,
+    partyId: line.partyId,
     description: null,
     debit: line.debit,
     credit: line.credit,
@@ -416,6 +516,7 @@ export function saveOpening(data: WorkspaceData, input: OpeningBalancesInput): v
     lines.push({
       accountId: equity.id,
       branchId: null,
+      partyId: null,
       description: null,
       debit: negative ? amount : '0',
       credit: negative ? '0' : amount,
@@ -454,6 +555,7 @@ export function postStockEntry(
       return {
         accountId: sum.accountId,
         branchId: sum.branchId,
+        partyId: null,
         description: null,
         debit: debit ? sum.total : '0',
         credit: debit ? '0' : negateMoney(sum.total),
@@ -510,9 +612,22 @@ export function seedJournal(data: WorkspaceData): void {
     return found.id;
   };
   const factory = data.branches.find((branch) => branch.code === 'GZP')?.id ?? null;
-  const line = (code: string, debit: string, credit: string, branchId: string | null = null) => ({
+  // Step 15a: a receivable line names its customer, by name (seedSales() made them)
+  const customer = (name: string) => {
+    const found = data.sales.customers.find((item) => item.name.startsWith(name));
+    if (!found) throw new Error(`The mock has no customer ${name}`);
+    return found.id;
+  };
+  const line = (
+    code: string,
+    debit: string,
+    credit: string,
+    branchId: string | null = null,
+    partyId: string | null = null,
+  ) => ({
     accountId: id(code),
     branchId,
+    partyId,
     description: null,
     debit,
     credit,
@@ -523,7 +638,7 @@ export function seedJournal(data: WorkspaceData): void {
   postNew(data, {
     date: lastYearDay(45),
     narration: 'Export sale to H&M, Stockholm',
-    lines: [line('1140', '3850000', '0'), line('4110', '0', '3850000')],
+    lines: [line('1140', '3850000', '0', null, customer('H&M')), line('4110', '0', '3850000')],
   });
   postNew(data, {
     date: lastYearDay(120),
@@ -569,7 +684,10 @@ export function seedJournal(data: WorkspaceData): void {
   postNew(data, {
     date: day(3),
     narration: 'Export sale to Primark, Dublin',
-    lines: [line('1140', '2450000', '0', factory), line('4110', '0', '2450000', factory)],
+    lines: [
+      line('1140', '2450000', '0', factory, customer('Primark')),
+      line('4110', '0', '2450000', factory),
+    ],
   });
   writeDraft(data, {
     date: day(2),
```

- **`partyIssues()` is the API's `checkParties()`**, on arrays: a receivable line needs a customer
  (`journal_party_required`), any other line must not have one (`journal_party_not_allowed`), and an unknown or
  archived customer is refused (`journal_party_invalid`). `partyProblem()` puts each code under
  `lines.N.partyId`, so the form marks every wrong row at once, as with the real API.
- **`checkLines()` now takes an options object.** It had two boolean parameters and needed a third
  (`allowMissingParty`). `checkLines(data, lines, true, false, true)` cannot be read without looking up the
  signature; `{ allowMissingParty: true }` can.
- **`postDraft()` allows a missing customer only on a reversal.** That is the exception migration 0026 makes: a
  reversal of an entry posted before step 15a copies its receivable line, which had no customer.
- **`asInput()` turns a stored line back into input** (`party` → `partyId`). `postDraft()` re-checks stored lines,
  and `reverseEntry()` copies them with debit and credit swapped. Both now carry the customer, so a reversal takes
  the amount off the same customer.
- **`toLines()` stores the customer's ref with `allowArchived = true`.** The lines were checked just before; here
  the ref is only looked up. A reversal may name an archived customer, and its ref must still be stored.
- **`ledgerOf()` and `statementOf()` share `pageOf()`.** A statement is a ledger over other lines: the receivable
  lines that name the customer. The running balance, the paging and the opening and closing balances are the same
  code, as in the API's `LedgerService`.
- **`saveOpening()` checks the customers on the page's rows**, before reversing the old opening entry. The posted
  entry has no zero rows and an extra equity line, so its line numbers are not the page's rows; the issue's index
  is mapped back to `line.index`.
- **The seeded export sales name H&M and Primark.** From this step on, a posted receivable line without a customer
  is refused, so the seed would throw on start. It also gives the customers' list and statement something to
  show.

### The rest of the mock: workspace, setup, products, year-end close

```diff
@@ -28,6 +28,7 @@ import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import type { MockExport } from './report-data';
+import { emptySales, type MockSales, seedSales } from './sales-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
@@ -52,6 +53,8 @@ export interface WorkspaceData {
   stock: MockStock;
   // The accounts stock documents post to, besides the inventory account (step 14)
   stockAccounts: StockAccounts;
+  // VAT rates, customers and their groups, price lists (step 15a)
+  sales: MockSales;
 }
 
 function now(): string {
@@ -85,6 +88,8 @@ function seed(workspace: Workspace): WorkspaceData {
       ...DEFAULT_SETTINGS,
       logo: null,
       allowNegativeStock: false,
+      // The pharmacy sells at the printed MRP, VAT included; the garments maker quotes before VAT
+      pricesIncludeVat: !garments,
       version: 1,
     },
     branches: garments
@@ -108,8 +113,11 @@ function seed(workspace: Workspace): WorkspaceData {
     exports: [],
     catalog: garments ? garmentsCatalog() : pharmaCatalog(),
     stock: emptyStock(),
+    sales: emptySales(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
+  // Before the journal: its receivable lines name the customers
+  seedSales(data, garments);
   if (garments) seedJournal(data);
   seedStock(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
@@ -171,6 +179,8 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.exports = [];
   // Like the chart: the setup job brings the units and categories (settleSetup)
   data.catalog = emptyCatalog();
+  // The VAT rates come with the setup job too (settleSetup); customers are the company's own
+  data.sales = emptySales();
   // Sign-up gives a new workspace its Main store, in its one branch (like auth.service.ts)
   data.stock = emptyStock();
   const [first] = data.branches;
@@ -241,6 +251,7 @@ function usedNumbers(data: WorkspaceData, documentType: DocumentType, period: st
   if (documentType === 'inventory.adjustment') return data.stock.counters.adjustment;
   if (documentType === 'inventory.transfer') return data.stock.counters.transfer;
   if (documentType === 'inventory.revaluation') return data.stock.counters.revaluation;
+  if (documentType === 'sales.customer') return data.sales.lastCode;
   return 0;
 }
 
@@ -254,7 +265,8 @@ export function seriesList(data: WorkspaceData): NumberSeries[] {
       documentType,
       ...format,
       version: saved?.version ?? 0,
-      // Journal entries and stock documents get numbers in the mock; the rest start at 1
+      // Journal entries, stock documents and customer codes get numbers in the mock; the rest
+      // start at 1
       nextNumber: formatDocumentNumber(
         format,
         period(format),
```

- **`seedSales()` runs before `seedJournal()`**: the journal's receivable lines need the customers to exist.
- **`pricesIncludeVat`**: on for the pharma workspace (it sells at the printed MRP), off for the garments one. The
  two workspaces then show both texts ("Prices include VAT" and "Prices before VAT").
- **A signed-up workspace starts with no VAT rates.** The real setup job brings them, so the mock's does too.
- **`usedNumbers()` knows the customer series**, so the Numbering page shows the right next code.

```diff
@@ -3,6 +3,7 @@ import type { Industry, Setup } from '@omnivo/contracts';
 import { seedAccounts, seedStockAccounts } from './accounting-data';
 import { MockProblem } from './mock';
 import { startingCatalog } from './product-data';
+import { startingTaxRates } from './sales-data';
 import { record, type WorkspaceData } from './workspace-data';
 
 // How long the pretend setup job takes — long enough to see "Preparing the roles…"
@@ -59,6 +60,8 @@ export function settleSetup(data: WorkspaceData): void {
     data.stockAccounts = seedStockAccounts(data.accounts, industry);
   }
   if (data.catalog.units.length === 0) data.catalog = startingCatalog(industry);
+  // Step 15a: the VAT rates, like the API's TaxRatesHandler (skipped if there are any)
+  if (data.sales.taxRates.length === 0) data.sales.taxRates = startingTaxRates();
   data.setup = { status: 'ready', industry };
   data.setupReadyAt = null;
   record(data, 'workspace.provisioned', 'workspace', crypto.randomUUID(), {
```

The pretend setup job adds the six rates, but only if there are none, like the API's `TaxRatesHandler`: the job
can run again, and must not add the rates twice.

```diff
@@ -216,6 +216,8 @@ function product(
     type: 'goods',
     categoryId,
     description: null,
+    // The workspace's default VAT rate (step 15a)
+    taxRateId: null,
     baseUnitId: unitId(parts.base),
     salesUnitId: null,
     purchaseUnitId: parts.packs?.[0] ? unitId(parts.packs[0][0]) : null,
@@ -527,6 +529,7 @@ export function saveProduct(
     type: input.type,
     categoryId: input.categoryId,
     description: input.description,
+    taxRateId: input.taxRateId,
     baseUnitId: input.baseUnitId,
     salesUnitId: input.salesUnitId === input.baseUnitId ? null : input.salesUnitId,
     purchaseUnitId: input.purchaseUnitId === input.baseUnitId ? null : input.purchaseUnitId,
```

A seeded product follows the workspace default (`taxRateId: null`); a saved one keeps what the form sent.

```diff
@@ -311,6 +311,8 @@ export function closeYear(data: WorkspaceData, end: string): FiscalYear {
   const lines = [...balances].map(([accountId, balance]) => ({
     accountId,
     branchId: null,
+    // Income and expense accounts: never kept per customer
+    partyId: null,
     description: null,
     debit: isNegativeMoney(balance) ? absMoney(balance) : '0',
     credit: isNegativeMoney(balance) ? '0' : balance,
@@ -320,6 +322,7 @@ export function closeYear(data: WorkspaceData, end: string): FiscalYear {
     lines.push({
       accountId: retained.id,
       branchId: null,
+      partyId: null,
       description: null,
       debit: isNegativeMoney(profit) ? absMoney(profit) : '0',
       credit: isNegativeMoney(profit) ? '0' : profit,
```

The year-end close posts to income, expense and retained earnings accounts. None of them is kept per customer, so
its lines say `partyId: null` on purpose (`LineIn` requires the field, like the API's `LineInput`).

### `mocks/handlers.ts`: the new routes

```diff
@@ -47,6 +47,7 @@ import {
   saveOpening,
   setLockDate,
   sortedEntries,
+  statementOf,
   summaryOf,
   writeDraft,
 } from './journal-data';
@@ -72,6 +73,30 @@ import {
   productSummaryOf,
   toImport,
 } from './product-data';
+import {
+  assertCustomerUnused,
+  assertGroupNameFree,
+  assertPriceListNameFree,
+  assertProductTaxRate,
+  createTaxRate,
+  customerSummaryOf,
+  dropStalePrices,
+  findCustomer,
+  findGroup,
+  findPriceList,
+  findTaxRate,
+  listCustomers,
+  priceItemsOf,
+  refreshPartyRefs,
+  saveCustomer,
+  setPriceItems,
+  setTaxRateArchived,
+  sortedTaxRates,
+  toCustomer,
+  toGroup,
+  toPriceList,
+  updateTaxRate,
+} from './sales-data';
 import { settleSetup, startSetup } from './setup-data';
 import {
   batchReport,
@@ -155,6 +180,7 @@ function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
 function editable(settings: Settings) {
   return {
     allowNegativeStock: settings.allowNegativeStock,
+    pricesIncludeVat: settings.pricesIncludeVat,
     companyName: settings.companyName,
     legalName: settings.legalName,
     bin: settings.bin,
@@ -807,7 +833,8 @@ export const handlers = [
     guarded(async ({ request }) => {
       const body = await readBody(routes.journal.create.body, request);
       const data = current();
-      checkLines(data, body.lines);
+      // A draft may leave the customer for later; posting needs it (the API's allowMissingParty)
+      checkLines(data, body.lines, { allowMissingParty: !body.post });
       const entry = body.post ? postNew(data, body) : writeDraft(data, body);
       record(data, 'journal.created', 'journal_entry', entry.id);
       if (body.post) {
@@ -829,10 +856,10 @@ export const handlers = [
       const entry = findEntry(data, id);
       if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
       checkVersion(entry.version, version);
-      checkLines(data, fields.lines);
+      checkLines(data, fields.lines, { allowMissingParty: !post });
       // All or nothing, like the API's transaction: post a copy, keep it only if it posts
       const before = structuredClone(entry);
-      replaceDraft(entry, fields);
+      replaceDraft(data, entry, fields);
       if (post) {
         try {
           postDraft(data, entry);
@@ -1429,6 +1456,7 @@ export const handlers = [
     guarded(async ({ request }) => {
       const body = await readBody(routes.products.create.body, request);
       const data = current();
+      assertProductTaxRate(data.sales, body.taxRateId, null);
       const saved = saveProduct(data.catalog, body);
       data.catalog.products.push(saved);
       record(
@@ -1451,8 +1479,12 @@ export const handlers = [
       const data = current();
       const target = findProduct(data.catalog, id);
       checkVersion(target.version, version);
+      // An archived rate the product already has is kept, like an archived unit
+      assertProductTaxRate(data.sales, body.taxRateId, target.taxRateId);
       const saved = saveProduct(data.catalog, body, target);
       data.catalog.products = data.catalog.products.map((item) => (item.id === id ? saved : item));
+      // A dropped pack or variant takes its price-list prices with it
+      dropStalePrices(data);
       record(
         data,
         'product.updated',
@@ -1494,6 +1526,7 @@ export const handlers = [
       const target = findProduct(data.catalog, id);
       checkVersion(target.version, version);
       data.catalog.products = data.catalog.products.filter((item) => item.id !== id);
+      dropStalePrices(data);
       record(data, 'product.deleted', 'product', id, diff({ name: target.name }, { name: null }));
       return reply(routes.products.remove, undefined);
     }),
@@ -1972,4 +2005,386 @@ export const handlers = [
       return reply(routes.stockAccounts.update, data.stockAccounts);
     }),
   ),
+
+  // ---------------------------------------------------------------------------------------------
+  // VAT rates, customers, customer groups and price lists (step 15a)
+
+  mock(routes.taxRates.list, () =>
+    reply(routes.taxRates.list, { items: sortedTaxRates(current().sales) }),
+  ),
+
+  mock(
+    routes.taxRates.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.taxRates.create.body, request);
+      const data = current();
+      const created = createTaxRate(data.sales, body);
+      record(
+        data,
+        'tax_rate.created',
+        'tax_rate',
+        created.id,
+        diff({}, { name: created.name, kind: created.kind, rate: created.rate }),
+      );
+      return reply(routes.taxRates.create, created);
+    }),
+  ),
+
+  mock(
+    routes.taxRates.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.taxRates.update.params.parse(params);
+      const body = await readBody(routes.taxRates.update.body, request);
+      const data = current();
+      const target = findTaxRate(data.sales, id);
+      const before = { name: target.name, kind: target.kind, rate: target.rate };
+      updateTaxRate(data.sales, target, body);
+      record(
+        data,
+        'tax_rate.updated',
+        'tax_rate',
+        id,
+        diff(before, { name: target.name, kind: target.kind, rate: target.rate }),
+      );
+      return reply(routes.taxRates.update, target);
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.taxRates[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.taxRates[action].params.parse(params);
+        const { version } = await readBody(routes.taxRates[action].body, request);
+        const data = current();
+        const target = findTaxRate(data.sales, id);
+        setTaxRateArchived(target, version, action === 'archive');
+        record(
+          data,
+          action === 'archive' ? 'tax_rate.archived' : 'tax_rate.restored',
+          'tax_rate',
+          id,
+        );
+        return reply(routes.taxRates[action], target);
+      }),
+    ),
+  ),
+
+  mock(routes.customers.list, async ({ request }) => {
+    const query = readQuery(routes.customers.list.query, request);
+    const data = current();
+    const start = query.cursor === undefined ? 0 : Number(query.cursor);
+    const all = listCustomers(data.sales, query);
+    const items = all
+      .slice(start, start + query.limit)
+      .map((item) => customerSummaryOf(data, item));
+    const end = start + items.length;
+    if (start > 0) await delay(300);
+    return reply(routes.customers.list, {
+      items,
+      nextCursor: end < all.length ? String(end) : null,
+    });
+  }),
+
+  mock(
+    routes.customers.get,
+    guarded(({ params }) => {
+      const { id } = routes.customers.get.params.parse(params);
+      const data = current();
+      return reply(routes.customers.get, toCustomer(data, findCustomer(data.sales, id)));
+    }),
+  ),
+
+  mock(
+    routes.customers.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.customers.create.body, request);
+      const data = current();
+      const saved = saveCustomer(data, body);
+      data.sales.customers.push(saved);
+      record(
+        data,
+        'customer.created',
+        'customer',
+        saved.id,
+        diff({}, { code: saved.code, name: saved.name }),
+      );
+      await delay();
+      return reply(routes.customers.create, toCustomer(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.customers.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.customers.update.params.parse(params);
+      const { version, ...body } = await readBody(routes.customers.update.body, request);
+      const data = current();
+      const target = findCustomer(data.sales, id);
+      checkVersion(target.version, version);
+      const saved = saveCustomer(data, body, target);
+      data.sales.customers = data.sales.customers.map((item) => (item.id === id ? saved : item));
+      refreshPartyRefs(data, saved);
+      record(
+        data,
+        'customer.updated',
+        'customer',
+        id,
+        diff(
+          { code: target.code, name: target.name, paymentTermsDays: target.paymentTermsDays },
+          { code: saved.code, name: saved.name, paymentTermsDays: saved.paymentTermsDays },
+        ),
+      );
+      await delay();
+      return reply(routes.customers.update, toCustomer(data, saved));
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.customers[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.customers[action].params.parse(params);
+        const { version } = await readBody(routes.customers[action].body, request);
+        const data = current();
+        const target = findCustomer(data.sales, id);
+        checkVersion(target.version, version);
+        // Archiving an archived customer changes nothing, like the API
+        if ((target.archivedAt !== null) !== (action === 'archive')) {
+          Object.assign(target, {
+            archivedAt: action === 'archive' ? new Date().toISOString() : null,
+            version: version + 1,
+            updatedAt: new Date().toISOString(),
+          });
+          record(
+            data,
+            action === 'archive' ? 'customer.archived' : 'customer.restored',
+            'customer',
+            id,
+          );
+        }
+        return reply(routes.customers[action], toCustomer(data, target));
+      }),
+    ),
+  ),
+
+  mock(
+    routes.customers.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.customers.remove.params.parse(params);
+      const { version } = readQuery(routes.customers.remove.query, request);
+      const data = current();
+      const target = findCustomer(data.sales, id);
+      checkVersion(target.version, version);
+      assertCustomerUnused(data, id);
+      data.sales.customers = data.sales.customers.filter((item) => item.id !== id);
+      record(
+        data,
+        'customer.deleted',
+        'customer',
+        id,
+        diff({ code: target.code, name: target.name }, { code: null, name: null }),
+      );
+      return reply(routes.customers.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.customers.statement,
+    guarded(({ request, params }) => {
+      const { id } = routes.customers.statement.params.parse(params);
+      const query = readQuery(routes.customers.statement.query, request);
+      return reply(routes.customers.statement, statementOf(current(), id, query));
+    }),
+  ),
+
+  mock(routes.customerGroups.list, () => {
+    const { sales } = current();
+    return reply(routes.customerGroups.list, {
+      items: sales.groups
+        .toSorted((a, b) => a.name.localeCompare(b.name))
+        .map((item) => toGroup(sales, item)),
+    });
+  }),
+
+  mock(
+    routes.customerGroups.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.customerGroups.create.body, request);
+      const data = current();
+      assertGroupNameFree(data.sales, body.name);
+      const created = {
+        id: crypto.randomUUID(),
+        name: body.name,
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.sales.groups.push(created);
+      record(data, 'customer_group.created', 'customer_group', created.id, {
+        name: { from: null, to: created.name },
+      });
+      return reply(routes.customerGroups.create, toGroup(data.sales, created));
+    }),
+  ),
+
+  mock(
+    routes.customerGroups.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.customerGroups.update.params.parse(params);
+      const { version, name } = await readBody(routes.customerGroups.update.body, request);
+      const data = current();
+      const target = findGroup(data.sales, id);
+      checkVersion(target.version, version);
+      assertGroupNameFree(data.sales, name, id);
+      const before = target.name;
+      Object.assign(target, { name, version: version + 1, updatedAt: new Date().toISOString() });
+      record(
+        data,
+        'customer_group.updated',
+        'customer_group',
+        id,
+        diff({ name: before }, { name }),
+      );
+      return reply(routes.customerGroups.update, toGroup(data.sales, target));
+    }),
+  ),
+
+  mock(
+    routes.customerGroups.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.customerGroups.remove.params.parse(params);
+      const { version } = readQuery(routes.customerGroups.remove.query, request);
+      const data = current();
+      const target = findGroup(data.sales, id);
+      checkVersion(target.version, version);
+      // Archived customers count too (the API's parties_customer_group_fk)
+      if (data.sales.customers.some((item) => item.groupId === id)) {
+        throw new MockProblem(409, 'customer_group_in_use');
+      }
+      data.sales.groups = data.sales.groups.filter((item) => item.id !== id);
+      record(data, 'customer_group.deleted', 'customer_group', id, {
+        name: { from: target.name, to: null },
+      });
+      return reply(routes.customerGroups.remove, undefined);
+    }),
+  ),
+
+  mock(routes.priceLists.list, () => {
+    const { sales } = current();
+    return reply(routes.priceLists.list, {
+      items: sales.priceLists
+        .toSorted((a, b) => a.name.localeCompare(b.name))
+        .map((item) => toPriceList(sales, item)),
+    });
+  }),
+
+  mock(
+    routes.priceLists.get,
+    guarded(({ params }) => {
+      const { id } = routes.priceLists.get.params.parse(params);
+      const { sales } = current();
+      return reply(routes.priceLists.get, toPriceList(sales, findPriceList(sales, id)));
+    }),
+  ),
+
+  mock(
+    routes.priceLists.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.priceLists.create.body, request);
+      const data = current();
+      assertPriceListNameFree(data.sales, body.name);
+      const created = {
+        id: crypto.randomUUID(),
+        ...body,
+        archivedAt: null,
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.sales.priceLists.push(created);
+      record(
+        data,
+        'price_list.created',
+        'price_list',
+        created.id,
+        diff({}, { name: created.name, description: created.description }),
+      );
+      return reply(routes.priceLists.create, toPriceList(data.sales, created));
+    }),
+  ),
+
+  mock(
+    routes.priceLists.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.priceLists.update.params.parse(params);
+      const { version, ...fields } = await readBody(routes.priceLists.update.body, request);
+      const data = current();
+      const target = findPriceList(data.sales, id);
+      checkVersion(target.version, version);
+      assertPriceListNameFree(data.sales, fields.name, id);
+      const before = { name: target.name, description: target.description };
+      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
+      record(data, 'price_list.updated', 'price_list', id, diff(before, fields));
+      return reply(routes.priceLists.update, toPriceList(data.sales, target));
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.priceLists[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.priceLists[action].params.parse(params);
+        const { version } = await readBody(routes.priceLists[action].body, request);
+        const data = current();
+        const target = findPriceList(data.sales, id);
+        checkVersion(target.version, version);
+        if ((target.archivedAt !== null) !== (action === 'archive')) {
+          Object.assign(target, {
+            archivedAt: action === 'archive' ? new Date().toISOString() : null,
+            version: version + 1,
+            updatedAt: new Date().toISOString(),
+          });
+          record(
+            data,
+            action === 'archive' ? 'price_list.archived' : 'price_list.restored',
+            'price_list',
+            id,
+          );
+        }
+        return reply(routes.priceLists[action], toPriceList(data.sales, target));
+      }),
+    ),
+  ),
+
+  mock(
+    routes.priceLists.items,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.priceLists.items.params.parse(params);
+      const query = readQuery(routes.priceLists.items.query, request);
+      const data = current();
+      findPriceList(data.sales, id);
+      const start = query.cursor === undefined ? 0 : Number(query.cursor);
+      const all = priceItemsOf(data, id, query.search);
+      const items = all.slice(start, start + query.limit);
+      const end = start + items.length;
+      if (start > 0) await delay(300);
+      return reply(routes.priceLists.items, {
+        items,
+        nextCursor: end < all.length ? String(end) : null,
+      });
+    }),
+  ),
+
+  mock(
+    routes.priceLists.setItems,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.priceLists.setItems.params.parse(params);
+      const body = await readBody(routes.priceLists.setItems.body, request);
+      const data = current();
+      const target = findPriceList(data.sales, id);
+      const counts = setPriceItems(data, target, body);
+      record(data, 'price_list.prices_changed', 'price_list', id, diff({}, counts));
+      await delay();
+      return reply(routes.priceLists.setItems, toPriceList(data.sales, target));
+    }),
+  ),
 ];
```

- **The journal's create and update allow a missing customer only for a draft** (`allowMissingParty: !post`).
  This is the fix 15a.4 found in the API: a draft may leave the customer for later, but a save that also posts
  must have it, or the error comes back in a second round.
- **`replaceDraft()` now takes `data`**: it looks up the customer's ref for each line.
- **Products check the VAT rate before saving**, and an update or delete drops the prices that no longer fit.
- **`editable()` includes `pricesIncludeVat`**, so the audit log shows the change of that setting.
- **Each new handler is the same shape as the old ones**: parse the params and body with the contract's schemas,
  run the rule in `sales-data.ts`, write the audit row, reply through `reply()` (which checks the response with the
  route's schema). `guarded()` turns a thrown `MockProblem` into the API's problem response.
- **Archive and restore are idempotent.** Archiving an archived customer or price list changes nothing and writes
  no audit row, like the API.
- **The customer group delete counts archived customers too**, like the API's foreign key: the archived customer
  still points at the group.
- **Paged lists use an offset as the cursor** (like the mock's other lists), and wait 300 ms on later pages, so
  "Loading more" can be seen while scrolling.

### `e2e/customers.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

// Step 15a in the mock garments workspace: five customers (C-00001 to C-00005, the last one
// archived). H&M owes ৳38,50,000 from last year's export sale, Primark ৳24,50,000 from this
// year's; both are receivable lines in the seeded journal.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const address = (page: Page, number: number) =>
  page.getByRole('group', { name: `Address ${String(number)}` });

test("lists the customers with what they owe, and opens one's statement", async ({ page }) => {
  await openFromNav(page, 'Customers');
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toContainText('৳38,50,000');
  await expect(listItem(page, /Bengal Buying House/)).toContainText('Cash only');
  await expectNoSideScroll(page);

  await listItem(page, /Primark Stores/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Primark Stores Ltd.' })).toBeVisible();
  await expect(page.getByText('Owes ৳24,50,000')).toBeVisible();
  await expect(page.getByText('120 days').first()).toBeVisible();
  // The statement: this year's sale, with the running balance
  await expect(page.getByText('Export sale to Primark, Dublin')).toBeVisible();
  await expectNoSideScroll(page);
});

test('adds a customer with a billing and a shipping address, and finds it by phone', async ({
  page,
}) => {
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New customer' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Chattogram Fashion House');
  await page.getByLabel('Group').selectOption({ label: 'Local buyers' });
  await page.getByLabel('Phone (optional)', { exact: true }).fill('+880 1811-445566');
  await page.getByLabel('Payment terms').fill('45');
  await page.getByLabel('Credit limit').fill('250000');
  await page.getByLabel('Price list').selectOption({ label: 'Local wholesale' });

  await page.getByRole('button', { name: 'Add an address' }).click();
  await address(page, 1).getByLabel('Address', { exact: true }).fill('42 Agrabad C/A, Chattogram');
  await page.getByRole('button', { name: 'Add an address' }).click();
  // The second address starts as a shipping one. Made a billing one, the form refuses it before
  // saving: the invoice prints one billing address.
  await expect(address(page, 2).getByLabel('Kind')).toHaveValue('shipping');
  await address(page, 2).getByLabel('Address', { exact: true }).fill('Agrabad depot, Chattogram');
  await address(page, 2).getByLabel('Kind').selectOption({ label: 'Billing' });
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(
    page.getByText('A customer has one billing address. Make this one a shipping address.'),
  ).toBeVisible();
  await address(page, 2).getByLabel('Kind').selectOption({ label: 'Shipping' });
  await address(page, 2).getByLabel('Label (optional)').fill('Agrabad depot');
  await page.getByRole('button', { name: 'Add customer' }).click();

  await expect(page.getByText('Chattogram Fashion House added')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Chattogram Fashion House' }),
  ).toBeVisible();
  // The next number of the series, after the five seeded customers
  await expect(page.getByText('C-00006').first()).toBeVisible();
  await expect(page.getByText('Default for deliveries')).toBeVisible();
  await expect(page.getByText('Nothing owed')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: 'Customers' }).first().click();
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('1811');
  await expect(listItem(page, /Chattogram Fashion House/)).toBeVisible();
  await expect(listItem(page, /H&M Hennes & Mauritz/)).toHaveCount(0);
});

test('archives a customer with entries, and deletes one without', async ({ page }) => {
  await openFromNav(page, 'Customers');
  await listItem(page, /H&M Hennes & Mauritz/).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'H&M Hennes & Mauritz GBC AB' }),
  ).toBeVisible();
  // Two clicks: the first asks
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete C-00001' }).click();
  await expect(
    page.getByText('Entries use this customer, so it cannot be deleted. Archive it instead.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('H&M Hennes & Mauritz GBC AB archived')).toBeVisible();
  await expect(page.getByText(/^This customer is archived/)).toBeVisible();
  // Its balance stays: the money is still owed
  await expect(page.getByText('Owes ৳38,50,000')).toBeVisible();

  await page.getByRole('link', { name: 'Customers' }).first().click();
  await listItem(page, /Bengal Buying House/).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete C-00004' }).click();
  await expect(page.getByText('Bengal Buying House Ltd. deleted')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
  await expect(listItem(page, /Bengal Buying House/)).toHaveCount(0);
});

test('keeps a group that holds customers, and deletes an empty one', async ({ page }) => {
  await openFromNav(page, 'Customer groups');
  await expect(listItem(page, /Export buyers/)).toContainText('2 customers');

  await page.getByRole('button', { name: 'Add group' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add group' });
  await dialog.getByLabel('Name').fill('Dealers');
  await dialog.getByRole('button', { name: 'Add group' }).click();
  await expect(page.getByText('Dealers added')).toBeVisible();
  await expect(listItem(page, /Dealers/)).toContainText('0 customers');

  await listItem(page, /Export buyers/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Export buyers' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Export buyers' }).click();
  await expect(
    dialog.getByText('Customers are in this group. Move them to another group first.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await listItem(page, /Dealers/).click();
  dialog = page.getByRole('dialog', { name: 'Edit Dealers' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete Dealers' }).click();
  await expect(page.getByText('Dealers deleted')).toBeVisible();
  await expect(listItem(page, /Dealers/)).toHaveCount(0);
  await expectNoSideScroll(page);
});
```

Each test runs on the desktop (1280 px) and on a phone (390 px). Below 860 px a table becomes a list of cards, so
`listItem()` finds a row or a card. Every test ends with `expectNoSideScroll()`: the page body must never scroll
sideways (CLAUDE.md → Page gutters).

- **The list shows what each customer owes** (from the seeded journal) and the "Cash only" text for a limit of 0.
- **Primark's page shows the balance and this year's sale on the statement.** H&M's sale is from last year, so on
  H&M's page it is in the statement's opening balance, not in its lines.
- **The add test walks the address rules.** The second address starts as Shipping (the form's own default, once
  there is a billing address). The test makes it Billing on purpose, and the form refuses it before anything is
  sent (the contract's `superRefine`). The new customer then gets `C-00006`, the next number after the five
  seeded ones, and the first shipping address is marked "Default for deliveries".
- **Labels with "(optional)" are part of the accessible name**, so the test asks for `'Phone (optional)'` with
  `exact: true`. Without `exact`, `getByLabel('Phone')` would also find "Phone at this address".
- **Search by phone** ("1811") checks the API's rule that the phone is matched as typed.
- **Delete, then archive.** H&M has entries, so the delete is refused (`customer_in_use`) and the customer is
  archived instead; the balance stays on the page, because the money is still owed. Bengal Buying House has no
  entries and is deleted.
- **The group test** checks that a group with customers cannot be deleted, and an empty one can.

### `e2e/price-lists.e2e.ts` (new)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

// Step 15a in the mock garments workspace: "Export FOB" (the polo shirt's six versions, per piece
// and per dozen) and "Local wholesale" (the crew-neck T-shirt per piece, poly mailers per carton)

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('adds an item in each of its units, prices it, and takes a price out', async ({ page }) => {
  await openFromNav(page, 'Price lists');
  await listItem(page, /Local wholesale/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Local wholesale' })).toBeVisible();
  // The garments workspace quotes before VAT (Settings → Sales)
  await expect(page.getByText('Prices before VAT')).toBeVisible();

  // One product, two rows: its base unit and its pack (a gross of 144 buttons)
  await page.getByRole('button', { name: 'Add items' }).click();
  const picker = page.getByRole('dialog', { name: 'Add items' });
  await picker.getByRole('searchbox', { name: 'Search products' }).fill('P-00003');
  await expect(picker.getByText('Shirt buttons 4-hole 18L')).toBeVisible();
  await picker.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByLabel('Price of Shirt buttons 4-hole 18L per pcs', { exact: true }).fill('0.45');
  await page.getByLabel('Price of Shirt buttons 4-hole 18L per gross', { exact: true }).fill('60');
  await expect(page.getByText('2 prices changed')).toBeVisible();
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Prices saved')).toBeVisible();
  await expect(page.getByText(/prices? changed/)).toBeHidden();

  // An empty price takes the item out of the list: it sells at its own sale price again
  await page
    .getByRole('button', { name: 'Remove the price of Basic crew-neck T-shirt per pcs' })
    .click();
  await expect(page.getByText('1 price changed')).toBeVisible();
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Prices saved')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search the prices' }).fill('crew-neck');
  await expect(page.getByText('No price matches "crew-neck"')).toBeVisible();
  await expectNoSideScroll(page);
});

test('archives a price list, and its prices can no longer be changed', async ({ page }) => {
  await openFromNav(page, 'Price lists');
  await listItem(page, /Export FOB/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Export FOB' })).toBeVisible();
  await expect(
    page.getByLabel('Price of Pique polo shirt · M / Navy blue per dozen', { exact: true }),
  ).toBeVisible();
  // Archive sits in the edit dialog, with the name and description
  await page.getByRole('button', { name: 'Edit' }).click();
  await page
    .getByRole('dialog', { name: 'Edit Export FOB' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(page.getByText('Export FOB archived')).toBeVisible();
  await expect(page.getByText(/^This price list is archived/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add items' })).toHaveCount(0);
  await expect(
    page.getByLabel('Price of Pique polo shirt · M / Navy blue per dozen', { exact: true }),
  ).toBeDisabled();
  await expectNoSideScroll(page);
});
```

- **One product, two rows.** Shirt buttons are sold per piece and per gross, so "Add" gives a row for each unit.
- **`exact: true` on the price labels.** Playwright's `getByLabel()` matches part of the name and ignores case, so
  "Price of Shirt buttons… per pcs" also matched the remove button "Remove the price of Shirt buttons… per pcs".
- **The save bar counts the changes** and goes away after a save. An empty price (the remove button) takes the
  item out of the list; the search then finds nothing for it.
- **Archive is in the edit dialog**, next to the name and the description. An archived list is read only: no "Add
  items", and the price boxes are disabled.

### `e2e/journal.e2e.ts`, `e2e/settings.e2e.ts`, `e2e/products.e2e.ts`: new tests

```diff
@@ -141,3 +141,57 @@ test('closes the books up to today, and then refuses to post into it', async ({
     page.getByText('The books are closed for this date. Pick a date after the lock date.'),
   ).toBeVisible();
 });
+
+// Step 15a: the receivable is kept per customer. The API answers a line without one per row.
+test('asks for the customer on a receivable line, and the customer then owes it', async ({
+  page,
+}) => {
+  await openFromNav(page, 'Journal');
+  await page.getByRole('button', { name: 'New entry' }).click();
+  await page.getByLabel('Narration').fill('Sample yardage sold to Aarong');
+  await line(page, 1).getByLabel('Account').selectOption({ label: '1140 · Accounts receivable' });
+  await line(page, 1).getByLabel('Debit').fill('42000');
+  await line(page, 2).getByLabel('Account').selectOption({ label: '4110 · Export sales' });
+  await line(page, 2).getByLabel('Credit').fill('42000');
+  await page.getByRole('button', { name: 'Post entry' }).click();
+  await expect(line(page, 1).getByText('Pick the customer this amount belongs to.')).toBeVisible();
+
+  await line(page, 1).getByLabel('Customer').click();
+  await page.getByRole('combobox', { name: 'Search customers' }).fill('aarong');
+  await page.getByRole('option', { name: /Aarong/ }).click();
+  await page.getByRole('button', { name: 'Post entry' }).click();
+  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();
+  await expect(page.getByText('Aarong').first()).toBeVisible();
+
+  await openFromNav(page, 'Customers');
+  await expect(listItem(page, /Aarong/)).toContainText('৳42,000');
+  await expectNoSideScroll(page);
+});
+
+test('splits the opening receivable by customer', async ({ page }) => {
+  await openFromNav(page, 'Opening balances');
+  await page.getByRole('button', { name: 'First day on Omnivo' }).click();
+  await page.locator('td[data-today] button').click();
+  await page.getByLabel('Debit, 1140: line 1').fill('150000');
+  await page.getByRole('button', { name: 'Post opening balances' }).click();
+  // Without a customer the amount belongs to nobody: the row says so
+  await expect(
+    page
+      .getByRole('group', { name: '1140: line 1' })
+      .getByText('Pick the customer this amount belongs to.'),
+  ).toBeVisible();
+
+  await page.getByLabel('Customer, 1140: line 1').click();
+  await page.getByRole('combobox', { name: 'Search customers' }).fill('C-00003');
+  await page.getByRole('option', { name: /Aarong/ }).click();
+  await page.getByRole('button', { name: 'Add a customer' }).click();
+  await page.getByLabel('Customer, 1140: line 2').click();
+  await page.getByRole('combobox', { name: 'Search customers' }).fill('bengal');
+  await page.getByRole('option', { name: /Bengal Buying House/ }).click();
+  await page.getByLabel('Debit, 1140: line 2').fill('60000');
+  // The account's total is the customers' lines together
+  await expect(page.getByText('৳2,10,000.00').first()).toBeVisible();
+  await page.getByRole('button', { name: 'Post opening balances' }).click();
+  await expect(page.getByText(/^Opening balances posted as JV-/)).toBeVisible();
+  await expectNoSideScroll(page);
+});
```

- **A receivable line without a customer is refused by the server**, and the error shows under that line. The rule
  is not in the contract (only the server knows which account is the receivable), so this test checks the whole
  path: the mock's `partyIssues()`, the `lines.0.partyId` field error, and the form putting it under line 1. We
  turned the mock's check off on purpose, and this test failed.
- **After the post, the customer owes the amount**: the entry, the customer's balance and the list agree.
- **The opening balances test** leaves the first receivable row without a customer, sees the error under that
  row, then splits the amount over two customers. The account's total is the sum of its rows.

```diff
@@ -48,3 +48,50 @@ test('shows the regional defaults for Bangladesh', async ({ page }) => {
   await expect(page.getByLabel('Fiscal year starts in')).toHaveValue('7');
   await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Dhaka');
 });
+
+// Step 15a: the VAT rates card. The mock workspace has the six NBR rates, VAT 15% the default.
+test('adds a VAT rate, makes it the default, and keeps the default from being archived', async ({
+  page,
+}) => {
+  await expect(page.getByRole('button', { name: /^VAT 15%/ })).toContainText('Default');
+  await page.getByRole('button', { name: 'Add rate' }).click();
+  const dialog = page.getByRole('dialog', { name: 'Add VAT rate' });
+  await dialog.getByLabel('Name').fill('VAT 2.4%');
+  await dialog.getByLabel('Kind').selectOption({ label: 'Reduced' });
+  // A reduced rate charges something: 0% would put the sale in the wrong box of the return
+  await dialog.getByLabel('Rate', { exact: true }).fill('0');
+  await dialog.getByRole('button', { name: 'Add rate' }).click();
+  await expect(
+    dialog.getByText(
+      'Standard and reduced rates are above 0%. Zero-rated and exempt rates are 0%.',
+    ),
+  ).toBeVisible();
+  await dialog.getByLabel('Rate', { exact: true }).fill('2.4');
+  await dialog.getByText('Use it for products without their own rate').click();
+  await dialog.getByRole('button', { name: 'Add rate' }).click();
+  await expect(page.getByText('VAT 2.4% added')).toBeVisible();
+  // One default: the new one took it over
+  await expect(page.getByRole('button', { name: /^VAT 2\.4%/ })).toContainText('Default');
+  await expect(page.getByRole('button', { name: /^VAT 15%/ })).not.toContainText('Default');
+
+  await page.getByRole('button', { name: /^VAT 2\.4%/ }).click();
+  const edit = page.getByRole('dialog', { name: 'Edit VAT 2.4%' });
+  await expect(
+    edit.getByText('This is the default. To change it, make another rate the default.'),
+  ).toBeVisible();
+  await edit.getByRole('button', { name: 'Archive' }).click();
+  await expect(
+    edit.getByText('The default rate cannot be archived. Make another rate the default first.'),
+  ).toBeVisible();
+  await expectNoSideScroll(page);
+});
+
+test('says whether the prices include VAT', async ({ page }) => {
+  const box = page.getByLabel('Prices include VAT');
+  // The garments workspace quotes before VAT
+  await expect(box).not.toBeChecked();
+  await page.getByText('Prices include VAT', { exact: true }).click();
+  await page.getByRole('button', { name: 'Save changes' }).click();
+  await expect(page.getByText('Settings saved')).toBeVisible();
+  await expect(box).toBeChecked();
+});
```

- **A reduced rate of 0% is refused by the form** (the contract's `refine`), before anything is sent.
- **The new default takes the badge from VAT 15%**: exactly one default.
- **The default cannot be archived**: the server's error shows in the dialog.
- **`getByLabel('Rate', { exact: true })`**: the checkbox "Use it for products without their own rate" also
  contains the word "rate".
- **"Prices include VAT"** is saved with the rest of the settings form.

```diff
@@ -132,9 +132,18 @@ test('adds a custom field, which the product form then shows', async ({ page })
   await dialog.getByLabel('Choices').fill('Hand wash\nMachine wash 30°C');
   await dialog.getByRole('button', { name: 'Add field' }).click();
   await expect(page.getByText('Wash care added')).toBeVisible();
+  // A date field: the form loads its picker as a chunk of its own (date-input.tsx, step 15a)
+  await page.getByRole('button', { name: 'Add field' }).click();
+  await dialog.getByLabel('Label').fill('Lab dip approved on');
+  await dialog.getByLabel('Type').selectOption({ label: 'Date' });
+  await dialog.getByRole('button', { name: 'Add field' }).click();
+  await expect(page.getByText('Lab dip approved on added')).toBeVisible();
 
   await newProduct(page);
   await expect(page.getByLabel('Wash care')).toBeVisible();
+  await page.getByLabel('Lab dip approved on').click();
+  await expect(page.getByRole('grid')).toBeVisible();
+  await page.keyboard.press('Escape');
   await page.getByLabel('GSM').fill('heavy');
   await page.getByLabel('Name').fill('Rib cuff sweatshirt');
   await page.getByRole('button', { name: 'Add product' }).click();
@@ -175,3 +184,21 @@ test('imports a CSV file, or lists what to fix in it', async ({ page }) => {
   await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
   await expectNoSideScroll(page);
 });
+
+// Step 15a: a product follows the workspace's VAT rate unless it is given its own
+test('keeps the workspace VAT rate, or gives a product its own', async ({ page }) => {
+  await openFromNav(page, 'Products');
+  await page.getByRole('searchbox', { name: 'Search products' }).fill('pique');
+  await listItem(page, /Pique polo shirt/).click();
+  await expect(page.getByRole('heading', { level: 1, name: 'Edit ST-118' })).toBeVisible();
+  const rate = page.getByLabel('VAT rate');
+  await expect(rate).toHaveValue('');
+  await expect(rate.locator('option:checked')).toHaveText('Workspace default: VAT 15% · 15%');
+  // The garments workspace types its prices before VAT
+  await expect(page.getByText('Before VAT').first()).toBeVisible();
+
+  await rate.selectOption({ label: 'VAT 5% · 5%' });
+  await page.getByRole('button', { name: 'Save product' }).click();
+  await expect(page.getByText('Pique polo shirt saved')).toBeVisible();
+  await expect(rate.locator('option:checked')).toHaveText('VAT 5% · 5%');
+});
```

The product form's first VAT option names the workspace default ("Workspace default: VAT 15% · 15%"), and its
value is `''`. A product given its own rate keeps it after the save.

The custom field test also adds a date field ("Lab dip approved on") and opens its calendar on the product form.
Since 15a.8 the form loads that picker lazily (`date-input.tsx`, see 15a.6), and no other test opens a date
picker on it, so without this check a broken lazy import would only show in a workspace with a date field.

> **What we checked in this part.** The app type-checks, now including `src/mocks/` and `e2e/`. ESLint and
> Prettier are clean on the mocks and the e2e tests. The app's unit tests pass (45). The whole Playwright suite
> passes once: 114 tests (92 old, 22 new), desktop and phone. Break on purpose: with the mock's party check
> turned off, the journal test "asks for the customer on a receivable line" fails. We also took screenshots of
> every new screen (customers list, customer page, customer form, groups, price lists, a price list, opening
> balances, journal form, settings) in light and dark, on desktop and phone, and found no layout problems: the
> customer page's three buttons wrap under the title on a phone, price rows stack on a phone, and the remove
> button of an opening-balance customer row lines up with its picker on both sizes.

---

## 15a.8 — Root files and the OpenAPI document

No root file changes: no new package, no new script, no new `.env` line. Generate the API document again and
commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 111 paths (95 before)
```

The 16 new paths are `/tax-rates` (list, create, one, archive, restore), `/customers` (the same five, plus
`/customers/{id}/statement`), `/customer-groups` (list, create, one) and `/price-lists` (the same five, plus
`/price-lists/{id}/items`). `pnpm test:openapi` fails if the committed file and the routes disagree, so a route
added later without running this command is caught in CI.

The Drizzle snapshots (`migrations/meta/0025_snapshot.json`, `0026_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

---

## 15a.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", a new bullet after "Select (bare)". 15a.5 promised it: the design system lists
every control, and a control that is not listed there does not exist for the next screen.

> - **Combobox:** `Combobox` from `@omnivo/ui`, for picking one of many rows the server searches (a customer).
>   The button looks exactly like an input (17px leading icon, an `ArrowDown01` icon on the right, the chosen
>   label or the placeholder in `ink-3`). It opens a popover as wide as the button, at least 288px, with a search
>   box on top and the matches below: 13.5px label, a 12px `ink-3` detail line (code · phone), highlighted
>   `subtle`, the chosen one with a `brand` `Tick02` icon. "Searching…" and "Nothing matches" (or the page's own
>   text, "No active customer matches") are a `role="status"` line. The focus stays in the search box (the ARIA
>   combobox pattern). The page owns the search and runs it on the server; use a native select for short fixed
>   lists.

And under "Content and formatting", after "Stock values":

> - **A customer's balance:** "Owes ৳1,15,000" when the customer owes the company, "৳20,000 in advance" when the
>   company owes the customer (an advance or an overpayment), "Nothing owed" at zero. Shown only with
>   `sales.customer.balance`; without it the balance column is left out.
> - **VAT rates:** a rate is shown with its name and percent ("VAT 15% · 15%", "Exempt · 0%"). Zero-rated and
>   exempt are different rates, even though both are 0%.

**build-plan.bn.md** — after the table of "পর্ব ৫", before "**দেখবেন:**":

> #### ধাপ ১৫: Sales — চারটা গাইডে
>
> **১৫a (customers, price lists, VAT):** একটা `parties` টেবিল (`is_customer` / `is_supplier`), কাস্টমার গ্রুপ, একাধিক
> ঠিকানা, payment terms, credit limit (চেক ১৫c-তে); AR একটাই control account, প্রতিটা AR লাইনে `party_id` — কাস্টমারের
> balance ও statement সেখান থেকে; opening balances পেজে AR কাস্টমার ধরে ভাগ; VAT rates টেবিল (standard, reduced,
> zero-rated, exempt; একটা default), workspace সেটিং "prices include VAT"; নামসহ price list (variant + unit ধরে দাম)।
> **১৫b** quotation → order → delivery · **১৫c** invoice, payment, credit limit · **১৫d** return ও credit note।

**COMMANDS.md** — in the database section, after the stock queries:

````markdown
```sh
# receivable lines posted without a customer, per workspace (from before step 15a; decision 15 of the guide)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(*) AS lines, sum(l.debit - l.credit) AS amount FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id JOIN tenants t ON t.id = l.tenant_id WHERE a.purpose = 'accounts_receivable' AND e.status = 'posted' AND l.party_id IS NULL GROUP BY t.slug"
# the 20 customers who owe the most (posted lines only)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.code, p.name, sum(l.debit - l.credit) AS balance FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id JOIN tenants t ON t.id = l.tenant_id WHERE e.status = 'posted' GROUP BY t.slug, p.code, p.name ORDER BY balance DESC LIMIT 20"
```
````

And in "Worker and queues", after the chart lines:

````markdown
```sh
# VAT rates per workspace (0 rates = the VAT rates job has not run yet; defaults is always 1 after it)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(r.id) AS rates, count(*) FILTER (WHERE r.is_default) AS defaults FROM tenants t LEFT JOIN tax_rates r ON r.tenant_id = t.id AND r.archived_at IS NULL GROUP BY t.slug"
# ask the worker to make the starting VAT rates again (it does nothing if the workspace has any rate)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "INSERT INTO outbox_events (id, tenant_id, type, payload) SELECT gen_random_uuid(), id, 'workspace.tax_rates_requested', '{}' FROM tenants WHERE slug = '<slug>'"
```
````

---

## 15a.10 — Run it

```bash
pnpm install
pnpm db:migrate                               # 0025 + 0026: the tables, the party rule, the VAT rates job
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it, the worker too: it picks up the VAT rates job
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('tax_rates', 'customer_groups', 'parties', 'party_addresses', 'price_lists', 'price_list_items');  -- t
SELECT name, kind, rate, is_default FROM tax_rates;   -- six rates once the worker has run the job, VAT 15% the default
```

### What you will see

1. **Your existing roles do not have the new permissions.** As the owner you have them all. For your sales team:
   Roles → Sales → tick "Add, edit and archive customers and their groups", and "See what customers owe, and their
   statements" for the people who chase dues.
2. **Settings → VAT rates**: six rates, VAT 15% marked default. Settings → Sales: "Prices include VAT" (off).
3. **Products → edit one**: "VAT rate" says "Workspace default: VAT 15% · 15%". Pick Exempt for a medicine.
4. **Sales → Customer groups → Add group**: "Export buyers". **Sales → Customers → Add customer**: name, group,
   30 days, a credit limit, a billing and a shipping address. Save: code `C-00001`.
5. **Accounting → Journal → New entry**: Dr Accounts receivable ৳1,15,000 / Cr Sales. Without a customer, "Save
   and post" is refused under that line. Pick the customer under the account, and post.
6. **The customer's page**: "Owes ৳1,15,000", and the entry in the statement. Change the dates: the opening balance
   moves with them.
7. **Your old receivable entries** (if you have any) show "No customer" on the receivable's ledger. Reverse one and
   enter it again with a customer, or save the opening balances again, split by customer (decision 15).
8. **Sales → Price lists → Add price list** "Local wholesale" → open it → **Add items**: a product with packs gives
   a row per unit. Type prices, **Save prices**. Give the list to the customer on its form.
9. **Bangla** and **390px**: the customers list becomes cards, the price rows stack, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 265: contracts 107 + api 76 + app 45 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 256 — 37 new
pnpm test:tenant-leak        # 50 — 5 new
pnpm test:e2e                # 114: 57 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 185.5 KB gz; customer form 66.8, product form 81.0, journal 99.7, revaluation form 99.7
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **The migration's foreign keys came before their indexes** (15a.2). The sixth step in a row: `drizzle-kit` always
  writes them in this order.
- **`.extend()` on a refined Zod object throws at run time** in Zod 4. The VAT rate's update schema uses
  `.safeExtend()` (15a.1).
- **Every customer read answered 500, and two counts were always 0.** A correlated subquery named the outer table
  through Drizzle (`${parties.id}`), which Drizzle prints as a bare `"id"` in a one-table select. Plain SQL with the
  table's name fixes it (15a.3). Watch for this in every list with a count or a sum.
- **"Save and post" reported a missing customer only in a second round**: the draft rule (customer may be missing)
  was used for a post too (15a.3).
- **The race test passed without the lock.** Two requests sent together rarely overlap; a third connection now
  holds the row until both wait (15a.4).
- **The old tests built product and settings forms without the new fields** and got 400s. Both fields are required
  on purpose (15a.4).
- **Two empty opening-balance rows on the receivable were "twice"**: the duplicate rule now skips lines with no
  amount (15a.6, a contract change).
- **A price box lost its value while scrolling**: the DataTable unmounts rows that leave the screen. The prices page
  uses plain rows (15a.6).
- **Playwright found two boxes for one label**: "Rate" also matched the default checkbox's label, and "Price of …"
  also matched the remove button "Remove the price of …". Exact labels fix both (15a.7).
- **The customer form's route went over its 100 KB budget** (121.5 KB): new, edit and the customer's page shared
  one route file, so "Add customer" also loaded the statement's data table and date pickers. New and edit moved to
  `routes/customer-edit.tsx`, and what both use to `components/customer-parts.tsx` (15a.6).
- **The product form's route went over too** (100.5 KB): the VAT select was the last half kilobyte. The date
  picker of a date custom field now loads lazily (`date-input.tsx`), like step 14's cost box: 81.0 KB.
- **The full test runs timed out on a busy laptop.** At a load of 20–40, seven API test files missed the 120-second
  container start-up limit, and twelve `[phone]` Playwright tests their 30-second limit. Each passed when run again
  on its own; none failed an assertion.

---

## Notes left for later steps

**Step 15b (quotation → order → delivery):**

- **The price lookup**: the customer's list for that variant and unit, else the product's sale price; an archived
  list is skipped. Write it as a service with its endpoint, next to the forms that call it (decision 19).
- **Each line keeps a snapshot** of the name, the unit, the price, the VAT rate (`kind` and `rate`) and the
  workspace's `pricesIncludeVat` at that moment. VAT is worked out with `decimal.js` from the snapshot, never from
  today's rate.
- **A delivery is an outflow at the average cost** (step 14's note): Dr Cost of goods sold / Cr Inventory.
- **The customer picker is ready**: `components/customer-picker.tsx` on top of `Combobox`.

**Step 15c (invoice, payment, credit limit):**

- **An invoice's receivable line names its customer** — the party rule is already enforced, so an invoice that
  forgets it is refused by `PostingService` and by the trigger.
- **The due date** is the invoice date plus the customer's `paymentTermsDays`.
- **The credit limit**: `creditLimit` `null` = no limit, `"0"` = cash only. Add `sales.credit.override`, and write
  each override to the audit log (decision 9).

**Step 17 (purchases):**

- **Suppliers are `parties` with `is_supplier`.** Add `accounts_payable` to `PARTY_ACCOUNT_PURPOSES`, and replace
  `journal_entries_balanced()` once more so the party rule covers it. A supplier's group is not its customer group
  (`customer_groups` is for customers only).

**Notes for any step:**

- **A list with a count or a sum in a subquery**: name the outer table in plain SQL (see "What we found").
- **Three chunks sit at the edge of the 100 KB budget**: the journal list (99.7 KB), the revaluation form (99.7 KB)
  and the opening balances page (94.4 KB). The next feature on any of them needs a lazy split first, the way the
  product form's date picker and step 14's cost box got one.
- **Customer CSV import, custom fields on customers, quantity breaks, aging** — all later, none needs a new table
  column today except the custom fields JSONB.
