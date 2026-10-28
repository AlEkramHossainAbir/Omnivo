import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { amountSchema, isZeroMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A draft can still be edited or deleted; a posted entry is in the books for good. A mistake in a
// posted entry is undone by a reversal (a new entry with the sides swapped), never by an edit.
export const JOURNAL_STATUSES = ['draft', 'posted'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

// Where an entry comes from. Each later module that posts (sales invoice, bill, stock receipt)
// adds its own source here. The response sends it as z.string() — like an account's purpose — so a
// newer server's new source does not break an older offline client.
// year_close: the closing entry of a fiscal year (step 11), which moves income and expenses into
// retained earnings. The profit and loss leaves it out, or every closed year would show zero profit.
// stock_adjustment, stock_transfer, stock_revaluation (step 14): the entry a stock document makes
// when it is posted. It points back at its document (document), and only another stock document
// can change it — the journal's Reverse refuses it, or the books and the stock would disagree.
// sales_delivery (step 15b): a delivery challan's cost of goods sold. A stock document like the
// others: it moves stock and its value together.
// sales_invoice, sales_receipt (step 15c): an invoice's sale (receivable, sales, VAT) and a money
// receipt (cash or bank, receivable). They point at their document like a stock document's entry.
// sales_return (step 15d): goods a customer sent back come into stock at what they cost (Dr
// Inventory / Cr Cost of goods sold). A stock document like a delivery.
// sales_credit_note, sales_refund (step 15d): a credit note takes a sale back (sales returns, VAT,
// receivable) and a refund pays a customer's advance back out of a cash or bank account.
// purchase_receipt (step 17b): a goods receipt brings stock in at the purchase order's price (Dr
// Inventory / Cr Goods received not billed). A stock document like a delivery.
// purchase_bill, purchase_payment (step 17c): a supplier's bill (goods received not billed or the
// expense, VAT input, the payable) and a supplier payment (the payable, a cash or bank account).
// purchase_return (step 17d): goods sent back to a supplier leave stock at what they came in at (Dr
// Goods received not billed / Cr Inventory). A stock document like a goods receipt.
// purchase_debit_note, purchase_refund (step 17d): a debit note takes money off what the company
// owes a supplier (the payable, goods received not billed, the price difference, VAT input), and a
// supplier refund is money a supplier paid back into a cash or bank account.
// pos_sale (step 20a): a POS sale books everything in one entry: Dr each payment's account, Cr Sales
// and VAT payable, and Dr Cost of goods sold / Cr Inventory for its goods. It moves stock, so it is
// a stock document's entry too: only a POS return (step 20c) undoes it.
export const JOURNAL_SOURCES = [
  'manual',
  'opening_balance',
  'reversal',
  'year_close',
  'stock_adjustment',
  'stock_transfer',
  'stock_revaluation',
  'sales_delivery',
  'sales_invoice',
  'sales_receipt',
  'sales_return',
  'sales_credit_note',
  'sales_refund',
  'purchase_receipt',
  'purchase_bill',
  'purchase_payment',
  'purchase_return',
  'purchase_debit_note',
  'purchase_refund',
  'pos_sale',
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export function isJournalSource(value: string): value is JournalSource {
  return JOURNAL_SOURCES.some((source) => source === value);
}

// The sources a stock document posts: their entries are made and undone by stock documents only
export const STOCK_JOURNAL_SOURCES = [
  'stock_adjustment',
  'stock_transfer',
  'stock_revaluation',
  'sales_delivery',
  'sales_return',
  'purchase_receipt',
  'purchase_return',
  'pos_sale',
] as const satisfies readonly JournalSource[];
export type StockJournalSource = (typeof STOCK_JOURNAL_SOURCES)[number];

export function isStockJournalSource(value: string): value is StockJournalSource {
  return STOCK_JOURNAL_SOURCES.some((source) => source === value);
}

// The sources a sales document posts (step 15c). Their entries are not reversed from the journal
// either: an invoice is corrected by a credit note (15d), a receipt or a refund by voiding it on its
// own page, so the document and the books never disagree. A credit note is never undone.
export const SALES_JOURNAL_SOURCES = [
  'sales_invoice',
  'sales_receipt',
  'sales_credit_note',
  'sales_refund',
] as const satisfies readonly JournalSource[];
export type SalesJournalSource = (typeof SALES_JOURNAL_SOURCES)[number];

export function isSalesJournalSource(value: string): value is SalesJournalSource {
  return SALES_JOURNAL_SOURCES.some((source) => source === value);
}

// The sources a purchase document posts (step 17c). Like the sales ones, the journal's Reverse
// refuses them (journal_is_purchase): a bill is corrected by a debit note (17d), a payment or a
// supplier refund by voiding it on its own page. A debit note is never undone.
export const PURCHASE_JOURNAL_SOURCES = [
  'purchase_bill',
  'purchase_payment',
  'purchase_debit_note',
  'purchase_refund',
] as const satisfies readonly JournalSource[];
export type PurchaseJournalSource = (typeof PURCHASE_JOURNAL_SOURCES)[number];

export function isPurchaseJournalSource(value: string): value is PurchaseJournalSource {
  return PURCHASE_JOURNAL_SOURCES.some((source) => source === value);
}

// Every source whose entry points at the document that made it (journal_entries_document_check in
// the database holds the same list)
export const DOCUMENT_JOURNAL_SOURCES = [
  ...STOCK_JOURNAL_SOURCES,
  ...SALES_JOURNAL_SOURCES,
  ...PURCHASE_JOURNAL_SOURCES,
] as const satisfies readonly JournalSource[];

// '2026-07-01' and -1 → '2026-06-30'. The arithmetic runs in UTC, so no time zone can move the
// day (the same reason periodOf() reads the parts of the string, numbering.ts).
export function shiftIsoDate(isoDate: string, days: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// A real entry has a handful of lines; a payroll a few hundred at most
export const MAX_JOURNAL_LINES = 200;

// The opening balances are one entry, but with a line per customer who owed money (step 15a)
export const MAX_OPENING_BALANCE_LINES = 5000;

// A posted entry as another page links to it: "JV-2026-27-0042"
export const entryRefSchema = z.object({ id: z.uuid(), number: z.string() });
export type EntryRef = z.infer<typeof entryRefSchema>;

// The customer or supplier a line belongs to, as a page shows it. Sent with its code and name
// because a workspace has too many parties for the app to load them all, the way it loads the
// chart of accounts.
export const partyRefSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });
export type PartyRef = z.infer<typeof partyRefSchema>;

export const journalLineSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  branchId: z.uuid().nullable(),
  // A customer on every line of the receivable account (step 15a), a supplier on every line of the
  // payable (step 17a), and nobody on any other line
  party: partyRefSchema.nullable(),
  description: z.string().nullable(),
  // Decimal strings with 4 places, as Postgres sends NUMERIC(19,4): "18500.0000". One side is
  // always "0.0000".
  debit: z.string(),
  credit: z.string(),
});
export type JournalLine = z.infer<typeof journalLineSchema>;

// What the list shows: the entry without its lines
export const journalEntrySummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: the number is given when the entry is posted, so the numbers have no gaps
  number: z.string().nullable(),
  // The business date, without time or time zone (system-design §10)
  date: z.iso.date(),
  narration: z.string().nullable(),
  status: z.enum(JOURNAL_STATUSES),
  source: z.string(),
  // The sum of the debits (= the sum of the credits once posted)
  total: z.string(),
  // This entry undoes reversalOf; reversedBy undid this entry
  reversalOf: entryRefSchema.nullable(),
  reversedBy: entryRefSchema.nullable(),
  // The document that made this entry (a stock document, step 14; an invoice or a receipt, step
  // 15c): its id and number. Which kind of document it is follows from the source. null for every
  // other entry.
  document: z.object({ id: z.uuid(), number: z.string() }).nullable(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type JournalEntrySummary = z.infer<typeof journalEntrySummarySchema>;

export const journalEntrySchema = journalEntrySummarySchema.extend({
  lines: z.array(journalLineSchema),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

// The form's "No branch" and empty "Customer" options send ''
const optionalIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

// Exactly one side has an amount. Both empty or both filled is the same mistake for the person:
// "put the amount on one side". The error sits under Debit, where the eye starts.
export const journalLineInputSchema = z
  .object({
    // The form's empty "Account" select sends '' — "not chosen", not a broken id
    accountId: z.uuid(errorCode('journal_account_required')),
    branchId: optionalIdSchema,
    // Required on the receivable account, refused on every other account. Only the server knows
    // which account is which, so that rule is checked there (journal_party_required / _not_allowed).
    // May be left out (= null): an app from before step 15a still sends its lines without it.
    partyId: optionalIdSchema.default(null),
    description: optionalText(200),
    debit: amountSchema,
    credit: amountSchema,
  })
  .refine((line) => isZeroMoney(line.debit) !== isZeroMoney(line.credit), {
    error: errorCode('journal_line_amount'),
    path: ['debit'],
  });
export type JournalLineInput = z.infer<typeof journalLineInputSchema>;

export const journalEntryInputSchema = z.object({
  date: z.iso.date(errorCode('journal_date_required')),
  narration: optionalText(300),
  lines: z
    .array(journalLineInputSchema)
    .min(2, errorCode('journal_lines_too_few'))
    .max(MAX_JOURNAL_LINES),
  // true = the form's "Post": save and post in one step, or nothing at all. Needs both
  // accounting.journal.create and accounting.journal.post. false = keep it a draft.
  post: z.boolean(),
});
export type JournalEntryInput = z.infer<typeof journalEntryInputSchema>;

export const updateJournalEntryInputSchema = journalEntryInputSchema.extend({
  version: versionSchema,
});
export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntryInputSchema>;

export const journalVersionInputSchema = z.object({ version: versionSchema });

export const reverseJournalEntryInputSchema = z.object({
  version: versionSchema,
  // Usually today, or the original's date to cancel it in the same period
  date: z.iso.date(errorCode('journal_date_required')),
});

export const deleteJournalEntryQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const journalListQuerySchema = pageQuerySchema.extend({
  status: z.enum(JOURNAL_STATUSES).optional(),
});

export const journalPageSchema = pageOf(journalEntrySummarySchema);

const entryParamsSchema = z.object({ id: z.uuid() });

export const journalRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/journal-entries',
    summary: 'Journal entries, newest date first',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    query: journalListQuerySchema,
    response: journalPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/journal-entries/:id',
    summary: 'One journal entry with its lines',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    params: entryParamsSchema,
    response: journalEntrySchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/journal-entries',
    summary: 'Write a journal entry as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'accounting.journal.create',
    status: 201,
    body: journalEntryInputSchema,
    response: journalEntrySchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/journal-entries/:id',
    summary: 'Change a draft, and optionally post it',
    auth: 'bearer',
    permission: 'accounting.journal.create',
    status: 200,
    params: entryParamsSchema,
    body: updateJournalEntryInputSchema,
    response: journalEntrySchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/journal-entries/:id',
    summary: 'Delete a draft (a posted entry is reversed instead)',
    auth: 'bearer',
    permission: 'accounting.journal.create',
    status: 204,
    params: entryParamsSchema,
    query: deleteJournalEntryQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/journal-entries/:id/post',
    summary: 'Post a draft as it is: it gets its number and enters the books',
    auth: 'bearer',
    permission: 'accounting.journal.post',
    status: 200,
    params: entryParamsSchema,
    body: journalVersionInputSchema,
    response: journalEntrySchema,
  }),
  reverse: defineRoute({
    method: 'POST',
    path: '/journal-entries/:id/reverse',
    summary: 'Undo a posted entry with a new entry that swaps its debits and credits',
    auth: 'bearer',
    permission: 'accounting.journal.post',
    status: 201,
    params: entryParamsSchema,
    body: reverseJournalEntryInputSchema,
    response: journalEntrySchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// The ledger of one account: its posted lines in date order, with a running balance

export const ledgerQuerySchema = pageQuerySchema.extend({
  // Both included. Without `from`, the ledger starts at the first entry.
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

// Every balance is debit minus credit: positive = a debit balance ("Dr"), negative = a credit
// balance ("Cr"). The sign does not depend on the account's type, so the app shows Dr/Cr and
// never has to guess what "plus" means for a liability.
export const ledgerLineSchema = z.object({
  lineId: z.uuid(),
  entryId: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  narration: z.string().nullable(),
  description: z.string().nullable(),
  // The receivable account's ledger shows whose line it is (step 15a); null on other accounts
  party: partyRefSchema.nullable(),
  debit: z.string(),
  credit: z.string(),
  balance: z.string(),
});
export type LedgerLine = z.infer<typeof ledgerLineSchema>;

export const ledgerPageSchema = pageOf(ledgerLineSchema).extend({
  // The balance before `from`, and after `to` — the same on every page
  openingBalance: z.string(),
  closingBalance: z.string(),
});
export type LedgerPage = z.infer<typeof ledgerPageSchema>;

export const ledgerRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/accounts/:id/ledger',
    summary: "An account's posted lines in date order, with the running balance",
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    params: z.object({ id: z.uuid() }),
    query: ledgerQuerySchema,
    response: ledgerPageSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Opening balances: what each balance sheet account held the day before the company moved its
// books to Omnivo. Saved as one posted journal entry; the difference goes to the account whose
// purpose is 'opening_balance_equity'.

// The receivable account's opening balance is split by customer (step 15a): one line per customer
// who owed money on the go-live date. The payable is split by supplier the same way (step 17a): one
// line per supplier the company owed. Every other account has one line, without a party.
export const openingBalanceLineSchema = z.object({
  accountId: z.uuid(),
  party: partyRefSchema.nullable(),
  debit: z.string(),
  credit: z.string(),
});

export const openingBalancesSchema = z.object({
  // The first day on Omnivo. The entry is dated the day before.
  goLiveDate: z.iso.date().nullable(),
  // The posted entry that holds them now; null before the first save
  entry: entryRefSchema.nullable(),
  // Without the opening balance equity line: the server makes that one
  lines: z.array(openingBalanceLineSchema),
});
export type OpeningBalances = z.infer<typeof openingBalancesSchema>;

export const openingBalancesInputSchema = z.object({
  goLiveDate: z.iso.date(errorCode('opening_date_required')),
  // The entry the page was opened with. If someone saved other opening balances since, the
  // server answers version_conflict instead of reversing an entry this person never saw.
  replaces: z.uuid().nullable(),
  // Zero on both sides = no opening balance for that account; such lines are dropped. A
  // distributor moving to Omnivo may bring a few thousand customers with dues, hence the limit.
  lines: z
    .array(
      z
        .object({
          accountId: z.uuid(),
          partyId: optionalIdSchema.default(null),
          debit: amountSchema,
          credit: amountSchema,
        })
        .refine((line) => isZeroMoney(line.debit) || isZeroMoney(line.credit), {
          error: errorCode('journal_line_amount'),
          path: ['debit'],
        }),
    )
    .max(MAX_OPENING_BALANCE_LINES)
    // One line per account, and per party on the receivable and the payable: two lines for the same
    // customer would be added up silently, and the person would not see the number they typed.
    // Empty lines do not count: the server drops them, and the page may hold a few party rows not
    // filled in yet (step 15a.6).
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, index) => {
        if (isZeroMoney(line.debit) && isZeroMoney(line.credit)) return;
        const key = `${line.accountId}:${line.partyId ?? ''}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'debit'],
            message: errorCode('opening_balance_twice'),
          });
        }
        seen.add(key);
      });
    }),
});
export type OpeningBalancesInput = z.infer<typeof openingBalancesInputSchema>;

export const openingBalanceRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/opening-balances',
    summary: 'The opening balances and the go-live date',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    response: openingBalancesSchema,
  }),
  save: defineRoute({
    method: 'PUT',
    path: '/opening-balances',
    summary: 'Post the opening balances, reversing the ones posted before',
    auth: 'bearer',
    permission: 'accounting.journal.post',
    status: 200,
    body: openingBalancesInputSchema,
    response: openingBalancesSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// The lock date: the books are closed up to and including this day. Nothing is posted or
// reversed on or before it. Closing September = setting it to 30 September.

export const periodLockSchema = z.object({
  lockDate: z.iso.date().nullable(),
  // 0 = never set (no row yet), like the number series
  version: z.number().int().min(0),
});
export type PeriodLock = z.infer<typeof periodLockSchema>;

export const periodLockInputSchema = z.object({
  // The date picker sends '' for "no lock": the books are open again
  lockDate: z
    .union([z.iso.date(), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  version: z.number().int().min(0),
});
export type PeriodLockInput = z.infer<typeof periodLockInputSchema>;

export const periodLockRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/period-lock',
    summary: 'The date up to which the books are closed',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    response: periodLockSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/period-lock',
    summary: 'Close the books up to a date, or open them again',
    auth: 'bearer',
    permission: 'accounting.period.close',
    status: 200,
    body: periodLockInputSchema,
    response: periodLockSchema,
  }),
};
