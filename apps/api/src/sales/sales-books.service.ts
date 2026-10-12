import { Injectable } from '@nestjs/common';
import { type EntryRef, isZeroMoney, type SalesJournalSource } from '@omnivo/contracts';
import { journalEntries, journalLines, ledgerAccounts, tenantSettings } from '@omnivo/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { type LineInput, PostingService } from '../journal/posting.service.js';

// A posted document, as its entry names it
interface DocumentRef {
  id: string;
  number: string;
  date: string;
}

// The accounts the sales documents post to, found by their purpose: every chart has exactly one of
// each (templates.spec.ts), and an account with a purpose can be neither archived nor deleted
// (AccountsService → locked). So only a workspace whose chart the setup job has not made yet can
// miss one, and nobody can write an invoice there: a plain error is enough.
interface Accounts {
  receivable: string;
  sales: string;
  vatOutput: string;
}

// One debit or one credit, on a line without a description
function debit(accountId: string, branchId: string, partyId: string | null, amount: string) {
  return { accountId, branchId, partyId, description: null, debit: amount, credit: '0' };
}

function credit(accountId: string, branchId: string, partyId: string | null, amount: string) {
  return { accountId, branchId, partyId, description: null, debit: '0', credit: amount };
}

// The journal half of the sales documents (step 15c; credit notes and refunds in step 15d), like
// StockBooksService for the stock documents: it builds the entry and posts it through the journal's PostingService, inside the
// document's own transaction, so the document and the books change together or not at all.
// The receivable line always names the customer (the party rule of step 15a): that is what makes
// the customer's balance, statement and credit check add up.
@Injectable()
export class SalesBooksService {
  constructor(private readonly posting: PostingService) {}

  // An invoice: Dr Accounts receivable (the customer) for the total / Cr Sales for the net / Cr
  // Output VAT for the VAT — every line with the invoice's branch, so the profit and loss by branch
  // shows the sale where it was made. The cost of the goods is not here: the challan booked it
  // (15b). An invoice of ৳0 (a free sample) has no entry: there is nothing to owe.
  async invoice(
    tx: Transaction,
    document: DocumentRef,
    input: { customerId: string; branchId: string; net: string; vat: string; total: string },
  ): Promise<EntryRef | null> {
    if (isZeroMoney(input.total)) return null;
    const accounts = await this.accounts(tx);
    const lines: LineInput[] = [
      debit(accounts.receivable, input.branchId, input.customerId, input.total),
      credit(accounts.sales, input.branchId, null, input.net),
      credit(accounts.vatOutput, input.branchId, null, input.vat),
    ];
    // A line of ৳0 says nothing: an exempt sale has no VAT line
    return this.write(
      tx,
      document,
      'sales_invoice',
      `Invoice ${document.number}`,
      lines.filter((line) => !isZeroMoney(line.debit) || !isZeroMoney(line.credit)),
    );
  }

  // A money receipt: Dr the cash, bank or wallet account / Cr Accounts receivable (the customer),
  // both with the receipt's branch. The receivable comes down whether or not the money is applied
  // to an invoice: what the customer owes is the books' number, not the invoices'.
  async receipt(
    tx: Transaction,
    document: DocumentRef,
    input: { customerId: string; branchId: string; accountId: string; amount: string },
  ): Promise<EntryRef> {
    const accounts = await this.accounts(tx);
    return this.write(tx, document, 'sales_receipt', `Money receipt ${document.number}`, [
      debit(input.accountId, input.branchId, null, input.amount),
      credit(accounts.receivable, input.branchId, input.customerId, input.amount),
    ]);
  }

  // A credit note (step 15d): the invoice's entry the other way round, for what it takes back. Dr
  // the sales returns account (Settings → Sales; the Sales account itself when none is chosen) for
  // the net / Dr Output VAT for the VAT / Cr Accounts receivable (the customer) for the total, all
  // with the invoice's branch, so the sale comes off where it was made. A credit note of ৳0 has no
  // entry, like an invoice of ৳0.
  async creditNote(
    tx: Transaction,
    document: DocumentRef,
    input: { customerId: string; branchId: string; net: string; vat: string; total: string },
  ): Promise<EntryRef | null> {
    if (isZeroMoney(input.total)) return null;
    const accounts = await this.accounts(tx);
    const returns = (await this.returnsAccount(tx)) ?? accounts.sales;
    const lines: LineInput[] = [
      debit(returns, input.branchId, null, input.net),
      debit(accounts.vatOutput, input.branchId, null, input.vat),
      credit(accounts.receivable, input.branchId, input.customerId, input.total),
    ];
    return this.write(
      tx,
      document,
      'sales_credit_note',
      `Credit note ${document.number}`,
      lines.filter((line) => !isZeroMoney(line.debit) || !isZeroMoney(line.credit)),
    );
  }

  // A refund (step 15d): a receipt the other way round. Dr Accounts receivable (the customer) / Cr
  // the cash, bank or wallet account the money left from, both with the refund's branch. The
  // customer's advance was a credit on the receivable; paying it out brings the receivable back to
  // what the customer really owes.
  async refund(
    tx: Transaction,
    document: DocumentRef,
    input: { customerId: string; branchId: string; accountId: string; amount: string },
  ): Promise<EntryRef> {
    const accounts = await this.accounts(tx);
    return this.write(tx, document, 'sales_refund', `Refund ${document.number}`, [
      debit(accounts.receivable, input.branchId, input.customerId, input.amount),
      credit(input.accountId, input.branchId, null, input.amount),
    ]);
  }

  // A voided receipt or refund: the journal's own reversal of its entry (source 'reversal',
  // pointing back at it), dated the day the money turned out not to be there. The same lines with debit and credit
  // swapped, each keeping its branch and customer, so the receivable goes back up on the same
  // customer. The unique index on reversal_of_id lets an entry be reversed once, whatever happens.
  async reverse(
    tx: Transaction,
    entry: EntryRef,
    input: { date: string; narration: string },
  ): Promise<EntryRef> {
    const lines = await tx
      .select({
        accountId: journalLines.accountId,
        branchId: journalLines.branchId,
        partyId: journalLines.partyId,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, entry.id)))
      .orderBy(asc(journalLines.lineNo));
    const posted = await this.posting.postNew(tx, {
      date: input.date,
      narration: input.narration,
      source: 'reversal',
      reversalOfId: entry.id,
      lines: lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
    });
    return toRef(posted);
  }

  // The posted entry a document made with this source: every sales document makes one at most
  async entryOf(
    tx: Transaction,
    documentId: string,
    source: SalesJournalSource,
  ): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, getTenantId()),
          eq(journalEntries.documentId, documentId),
          eq(journalEntries.source, source),
          eq(journalEntries.status, 'posted'),
        ),
      );
    return row === undefined ? null : postedRef(row);
  }

  // The reversal of an entry, if it has one (a voided receipt's or refund's)
  async reversalOf(tx: Transaction, entryId: string): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.reversalOfId, entryId)),
      );
    return row === undefined ? null : postedRef(row);
  }

  private async write(
    tx: Transaction,
    document: DocumentRef,
    source: SalesJournalSource,
    narration: string,
    lines: readonly LineInput[],
  ): Promise<EntryRef> {
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration,
      source,
      document: { id: document.id, number: document.number },
      lines,
    });
    return toRef(entry);
  }

  // FOR SHARE, like the stock accounts: nobody changes them before we commit, while other postings
  // to the same accounts go on in parallel
  private async accounts(tx: Transaction): Promise<Accounts> {
    const rows = await tx
      .select({ id: ledgerAccounts.id, purpose: ledgerAccounts.purpose })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, getTenantId()),
          inArray(ledgerAccounts.purpose, ['accounts_receivable', 'sales', 'vat_output']),
        ),
      )
      .for('share');
    const idOf = (purpose: string): string => {
      const id = rows.find((row) => row.purpose === purpose)?.id;
      if (id === undefined) throw new Error(`No account has the ${purpose} purpose yet`);
      return id;
    };
    return {
      receivable: idOf('accounts_receivable'),
      sales: idOf('sales'),
      vatOutput: idOf('vat_output'),
    };
  }

  // The account chosen in Settings → Sales for sales returns (step 15d), or null when none is
  // chosen. FOR SHARE like the others. AccountsService refuses to archive or delete the chosen
  // account (account_used_by_sales), so an unusable one is only a safety net: the person is sent
  // to the setting, like stock_account_missing, and nothing is posted.
  private async returnsAccount(tx: Transaction): Promise<string | null> {
    const tenantId = getTenantId();
    const [settings] = await tx
      .select({ accountId: tenantSettings.salesReturnsAccountId })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const accountId = settings?.accountId ?? null;
    if (accountId === null) return null;
    const [usable] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          eq(ledgerAccounts.id, accountId),
          eq(ledgerAccounts.isGroup, false),
          isNull(ledgerAccounts.archivedAt),
        ),
      )
      .for('share');
    if (!usable) {
      throw new AppError(
        409,
        'sales_account_invalid',
        'The sales returns account cannot be used. Choose another one in Settings → Sales.',
      );
    }
    return usable.id;
  }
}

// A found entry as a reference; null if it has no number (only a draft has none)
function postedRef(entry: { id: string; number: string | null }): EntryRef | null {
  return entry.number === null ? null : { id: entry.id, number: entry.number };
}

function toRef(entry: { id: string; number: string | null }): EntryRef {
  if (entry.number === null) throw new Error('A posted entry has no number');
  return { id: entry.id, number: entry.number };
}
