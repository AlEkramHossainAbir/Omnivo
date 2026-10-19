import { Injectable } from '@nestjs/common';
import {
  compareMoney,
  type EntryRef,
  isZeroMoney,
  negateMoney,
  type PurchaseJournalSource,
  sumMoney,
} from '@omnivo/contracts';
import {
  journalEntries,
  journalLines,
  ledgerAccounts,
  stockAccounts,
  tenantSettings,
} from '@omnivo/db';
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

// One amount of a bill's entry before the lines are summed: + debit, − credit
interface Amount {
  accountId: string;
  branchId: string;
  partyId: string | null;
  amount: string;
}

// What a bill's entry is made of, as BillsService works it out from the stored lines
export interface BillPosting {
  supplierId: string;
  branchId: string;
  vat: string;
  total: string;
  // Each goods line (a receipt line, or a line of its own once its receipt is made): what its goods
  // receipt booked on "goods received not billed" (orderValue), with that receipt's branch, and
  // what the bill's net differs from it by
  goods: readonly { receiptBranchId: string; orderValue: string; difference: string }[];
  // Each service line and expense: its account and its net
  costs: readonly { accountId: string; net: string }[];
}

function missing(what: string): AppError {
  return new AppError(
    409,
    'purchase_account_invalid',
    `No usable account for "${what}". Choose one in Settings → Purchase or Settings → Inventory.`,
    { params: { use: what } },
  );
}

// The journal half of the purchase documents (step 17c), like SalesBooksService for the sales
// ones: it builds the entry and posts it through the journal's PostingService, inside the
// document's own transaction, so the document and the books change together or not at all. The
// payable line always names the supplier (the party rule of step 17a): that is what makes the
// supplier's balance and statement add up.
@Injectable()
export class PurchaseBooksService {
  constructor(private readonly posting: PostingService) {}

  // A bill (decision 2):
  //   Dr Goods received not billed  what the goods receipts booked (the order's price), each with
  //                                 its receipt's branch, so that account clears to zero branch
  //                                 by branch (decision 20)
  //   Dr / Cr Purchase price diff.  the bill's net less that, with the bill's branch (decision 8)
  //   Dr each expense account       a service line's or an expense's net, with the bill's branch
  //   Dr VAT input                  the VAT
  //   Cr Accounts payable           the total, with the supplier
  // Lines are summed per account and branch: a bill of 300 receipt lines is a five-line entry. A
  // bill of ৳0 has no entry, like an invoice of ৳0.
  async bill(tx: Transaction, document: DocumentRef, input: BillPosting): Promise<EntryRef | null> {
    if (isZeroMoney(input.total)) return null;
    const accounts = await this.billAccounts(tx, input);
    const amounts: Amount[] = [
      ...input.goods.flatMap((line) => [
        {
          accountId: accounts.receivedNotBilled(),
          branchId: line.receiptBranchId,
          partyId: null,
          amount: line.orderValue,
        },
        // Only a line that differs needs the account: a bill at the order's prices (or of its own
        // goods only) posts with none chosen
        ...(isZeroMoney(line.difference)
          ? []
          : [
              {
                accountId: accounts.priceDifference(),
                branchId: input.branchId,
                partyId: null,
                amount: line.difference,
              },
            ]),
      ]),
      ...input.costs.map((cost) => ({
        accountId: cost.accountId,
        branchId: input.branchId,
        partyId: null,
        amount: cost.net,
      })),
      { accountId: accounts.vatInput, branchId: input.branchId, partyId: null, amount: input.vat },
      {
        accountId: accounts.payable,
        branchId: input.branchId,
        partyId: input.supplierId,
        amount: negateMoney(input.total),
      },
    ];
    return this.write(tx, document, 'purchase_bill', `Bill ${document.number}`, summed(amounts));
  }

  // A supplier payment: Dr Accounts payable (the supplier) / Cr the cash, bank or wallet account,
  // both with the payment's branch. The payable comes down whether or not the money is applied to
  // a bill: what the company owes is the books' number, not the bills'.
  async payment(
    tx: Transaction,
    document: DocumentRef,
    input: { supplierId: string; branchId: string; accountId: string; amount: string },
  ): Promise<EntryRef> {
    const payable = await this.purposeAccount(tx, 'accounts_payable');
    const entry = await this.write(tx, document, 'purchase_payment', `Payment ${document.number}`, [
      {
        accountId: payable,
        branchId: input.branchId,
        partyId: input.supplierId,
        description: null,
        debit: input.amount,
        credit: '0',
      },
      {
        accountId: input.accountId,
        branchId: input.branchId,
        partyId: null,
        description: null,
        debit: '0',
        credit: input.amount,
      },
    ]);
    if (entry === null) throw new Error('A payment entry has no lines');
    return entry;
  }

  // A voided payment: the journal's own reversal of its entry (source 'reversal'), dated the day
  // the cheque bounced. The same as SalesBooksService.reverse(), written again here so the
  // purchase module needs nothing from the sales module.
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

  // The posted entry a document made with this source: a bill or a payment makes one at most
  async entryOf(
    tx: Transaction,
    documentId: string,
    source: PurchaseJournalSource,
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
    source: PurchaseJournalSource,
    narration: string,
    lines: readonly LineInput[],
  ): Promise<EntryRef | null> {
    if (lines.length < 2) return null;
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration,
      source,
      document: { id: document.id, number: document.number },
      lines,
    });
    return toRef(entry);
  }

  // The accounts a bill posts to. The payable and VAT input by their purpose (every chart has
  // them). "Goods received not billed" from Settings → Inventory (step 17b) and the price difference
  // account from Settings → Purchase, else Cost of goods sold (decision 17), each asked for only
  // when a line needs it: a utility bill posts without either. FOR SHARE, like every posting:
  // nobody archives them before we commit.
  private async billAccounts(tx: Transaction, input: BillPosting) {
    const tenantId = getTenantId();
    const purposes = await tx
      .select({ id: ledgerAccounts.id, purpose: ledgerAccounts.purpose })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          inArray(ledgerAccounts.purpose, ['accounts_payable', 'vat_input', 'cost_of_goods_sold']),
        ),
      )
      .for('share');
    const idOf = (purpose: string): string | undefined =>
      purposes.find((row) => row.purpose === purpose)?.id;
    const payable = idOf('accounts_payable');
    const vatInput = idOf('vat_input');
    // A workspace whose chart the setup job has not made yet: nobody can write a bill there
    if (payable === undefined || vatInput === undefined) {
      throw new Error('The chart has no payable or VAT input account yet');
    }
    const needsDifference = input.goods.some((line) => !isZeroMoney(line.difference));
    const [receivedNotBilled, priceDifference] = await Promise.all([
      input.goods.length === 0 ? null : this.receivedNotBilled(tx),
      needsDifference ? this.priceDifferenceAccount(tx, idOf('cost_of_goods_sold')) : null,
    ]);
    return {
      payable,
      vatInput,
      receivedNotBilled: () => {
        if (receivedNotBilled === null) throw missing('received_not_billed');
        return receivedNotBilled;
      },
      priceDifference: () => {
        if (priceDifference === null) throw missing('price_difference');
        return priceDifference;
      },
    };
  }

  // Settings → Inventory's choice, which every goods receipt credited (17b). A choice archived or
  // removed since is refused like the stock documents refuse it, with the same code.
  private async receivedNotBilled(tx: Transaction): Promise<string> {
    const [row] = await tx
      .select({ id: stockAccounts.accountId })
      .from(stockAccounts)
      .innerJoin(
        ledgerAccounts,
        and(
          eq(ledgerAccounts.tenantId, stockAccounts.tenantId),
          eq(ledgerAccounts.id, stockAccounts.accountId),
        ),
      )
      .where(
        and(
          eq(stockAccounts.tenantId, getTenantId()),
          eq(stockAccounts.use, 'received_not_billed'),
          eq(ledgerAccounts.isGroup, false),
          isNull(ledgerAccounts.archivedAt),
        ),
      )
      .for('share', { of: ledgerAccounts });
    if (!row) {
      throw new AppError(
        409,
        'stock_account_missing',
        'No usable account is chosen for "received_not_billed" in Settings → Inventory.',
        { params: { use: 'received_not_billed' } },
      );
    }
    return row.id;
  }

  // Settings → Purchase's price difference account, or Cost of goods sold when none is chosen
  // (decision 17). AccountsService refuses to archive or delete the chosen one
  // (account_used_by_purchase), so an unusable one is only a safety net.
  private async priceDifferenceAccount(
    tx: Transaction,
    costOfGoodsSold: string | undefined,
  ): Promise<string> {
    const tenantId = getTenantId();
    const [settings] = await tx
      .select({ accountId: tenantSettings.purchasePriceDifferenceAccountId })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const accountId = settings?.accountId ?? null;
    if (accountId === null) {
      if (costOfGoodsSold === undefined) throw missing('price_difference');
      return costOfGoodsSold;
    }
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
    if (!usable) throw missing('price_difference');
    return usable.id;
  }

  private async purposeAccount(tx: Transaction, purpose: 'accounts_payable'): Promise<string> {
    const [row] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.purpose, purpose)))
      .for('share');
    if (!row) throw new Error(`No account has the ${purpose} purpose yet`);
    return row.id;
  }
}

// The amounts summed per account, branch and party, each sum a debit or a credit line; the sums of
// ৳0 dropped (a bill at exactly the order's price has no price difference line)
function summed(amounts: readonly Amount[]): LineInput[] {
  const sums = new Map<string, Amount[]>();
  for (const amount of amounts) {
    const key = `${amount.accountId}|${amount.branchId}|${amount.partyId ?? ''}`;
    sums.set(key, [...(sums.get(key) ?? []), amount]);
  }
  return [...sums.values()].flatMap((group) => {
    const [first] = group;
    if (!first) return [];
    const total = sumMoney(group.map((amount) => amount.amount));
    if (isZeroMoney(total)) return [];
    const debit = compareMoney(total, '0') > 0;
    return [
      {
        accountId: first.accountId,
        branchId: first.branchId,
        partyId: first.partyId,
        description: null,
        debit: debit ? total : '0',
        credit: debit ? '0' : negateMoney(total),
      },
    ];
  });
}

// A found entry as a reference; null if it has no number (only a draft has none)
function postedRef(entry: { id: string; number: string | null }): EntryRef | null {
  return entry.number === null ? null : { id: entry.id, number: entry.number };
}

function toRef(entry: { id: string; number: string | null }): EntryRef {
  if (entry.number === null) throw new Error('A posted entry has no number');
  return { id: entry.id, number: entry.number };
}
