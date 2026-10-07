import { Injectable } from '@nestjs/common';
import {
  type ErrorCode,
  isPartyAccountPurpose,
  isStockJournalSource,
  type JournalSource,
  sumMoney,
} from '@omnivo/contracts';
import {
  branches,
  journalEntries,
  journalLines,
  ledgerAccounts,
  parties,
  stockAccounts,
} from '@omnivo/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId, tenantStorage } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { assertPeriodOpen } from './period-lock.service.js';

export type EntryRow = typeof journalEntries.$inferSelect;

// One debit or credit as the API and later modules hand it in: amounts are decimal strings, one
// of them "0"
export interface LineInput {
  accountId: string;
  branchId: string | null;
  // Step 15a: the customer on a receivable line; null on every other line
  partyId: string | null;
  description: string | null;
  debit: string;
  credit: string;
}

export interface NewEntry {
  date: string;
  narration: string | null;
  source: JournalSource;
  // Only for source 'reversal'
  reversalOfId?: string;
  // Only for a stock document's entry (step 14): the document that made it
  document?: { id: string; number: string };
  lines: readonly LineInput[];
}

// "Every line with a wrong X" as field errors under each such line: lines.2.accountId
function lineErrors(code: ErrorCode, field: string, indexes: readonly number[]): AppError {
  return new AppError(409, code, `Lines ${indexes.join(', ')} have an invalid ${field}.`, {
    fieldErrors: Object.fromEntries(
      indexes.map((index) => [`lines.${String(index)}.${field}`, [code]]),
    ),
  });
}

type PartyCode = 'journal_party_required' | 'journal_party_not_allowed' | 'journal_party_invalid';

// One line that breaks the party rule, by its index in the caller's list
export interface PartyIssue {
  index: number;
  code: PartyCode;
}

// The party problems as the API's answer: each line's own code under lines.N.partyId, so the form
// marks every wrong row at once
export function partyError(issues: readonly PartyIssue[]): AppError {
  const first = issues[0]?.code ?? 'journal_party_invalid';
  return new AppError(409, first, 'Some lines have a wrong customer, or need one.', {
    fieldErrors: Object.fromEntries(
      issues.map((issue) => [`lines.${String(issue.index)}.partyId`, [issue.code]]),
    ),
  });
}

// The party rule (step 15a): a line on an account kept per party (the receivable) names a
// customer, and no other line names anyone. Migration 0026 checks the same at posting, as a safety
// net; here a person gets an answer per line instead of one database error.
// purposeOf: each line's account → its purpose, from a query the caller already made.
// allowMissing: the receivable line may have no customer yet — a draft (the person picks the
// customer before posting), or a reversal of an entry posted before step 15a, which had none.
// allowArchived: a reversal undoes old work, even for a customer archived since.
// FOR SHARE on the parties, like the accounts: nobody archives one until we commit.
export async function checkParties(
  tx: Transaction,
  lines: readonly { accountId: string; partyId: string | null }[],
  purposeOf: ReadonlyMap<string, string | null>,
  { allowMissing = false, allowArchived = false } = {},
): Promise<PartyIssue[]> {
  const partyIds = [
    ...new Set(lines.flatMap((line) => (line.partyId === null ? [] : [line.partyId]))),
  ];
  const found =
    partyIds.length === 0
      ? []
      : await tx
          .select({ id: parties.id })
          .from(parties)
          .where(
            and(
              eq(parties.tenantId, getTenantId()),
              inArray(parties.id, partyIds),
              // Step 17 adds suppliers: a payable line will need is_supplier instead
              eq(parties.isCustomer, true),
              allowArchived ? undefined : isNull(parties.archivedAt),
            ),
          )
          .for('share');
  const usable = new Set(found.map((party) => party.id));
  return lines.flatMap((line, index): PartyIssue[] => {
    const perParty = isPartyAccountPurpose(purposeOf.get(line.accountId) ?? null);
    if (line.partyId === null) {
      return perParty && !allowMissing ? [{ index, code: 'journal_party_required' }] : [];
    }
    if (!perParty) return [{ index, code: 'journal_party_not_allowed' }];
    // Unknown, archived, not a customer, another tenant's: one answer, like the accounts
    return usable.has(line.partyId) ? [] : [{ index, code: 'journal_party_invalid' }];
  });
}

// The accounts only stock documents post to (step 14): the inventory account and the goods in
// transit account. A manual entry or an opening balance on them would make the books say one value
// and the stock another, with nothing to bring them back together. Stock comes in through an
// adjustment (opening stock too), and a wrong value is put right by a revaluation.
export async function stockAccountIds(tx: Transaction): Promise<Set<string>> {
  const tenantId = getTenantId();
  const [inventory, inTransit] = await Promise.all([
    tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.purpose, 'inventory'))),
    tx
      .select({ id: stockAccounts.accountId })
      .from(stockAccounts)
      .where(and(eq(stockAccounts.tenantId, tenantId), eq(stockAccounts.use, 'in_transit'))),
  ]);
  return new Set([...inventory, ...inTransit].map((row) => row.id));
}

// Who did it: the person behind the request, or nobody (a background job) — like audit()
function actorId(): string | null {
  return tenantStorage.getStore()?.principal?.userId ?? null;
}

// The one way into the books. The journal's own endpoints use it, and so will every module that
// posts later (a sales invoice in step 15, a bill, a stock receipt): they build a NewEntry and
// call postNew() inside their own transaction, so the document and its entry commit together or
// not at all. Every rule of posting lives here once.
@Injectable()
export class PostingService {
  constructor(private readonly numbering: NumberingService) {}

  // Each line's account must be an active ledger of this tenant, and its branch (if any) an
  // active branch. FOR SHARE: until we commit, nobody archives or deletes them (AccountsService
  // locks FOR UPDATE), while other postings to the same account go on in parallel.
  // allowArchived: a reversal undoes an entry exactly, even if one of its accounts was archived
  // since — archiving hides an account from new work, it must not block fixing old work.
  // allowStock: the entry may post to the inventory and goods in transit accounts — a stock
  // document's entry, or a reversal or closing entry of old work. Every other entry may not.
  // allowMissingParty: see checkParties() — a draft, or a reversal.
  async checkLines(
    tx: Transaction,
    lines: readonly LineInput[],
    {
      allowArchived = false,
      allowStock = false,
      allowMissingParty = false,
    }: { allowArchived?: boolean; allowStock?: boolean; allowMissingParty?: boolean } = {},
  ): Promise<void> {
    const tenantId = getTenantId();
    const accountIds = [...new Set(lines.map((line) => line.accountId))];
    const accounts = await tx
      .select({
        id: ledgerAccounts.id,
        isGroup: ledgerAccounts.isGroup,
        purpose: ledgerAccounts.purpose,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, tenantId), inArray(ledgerAccounts.id, accountIds)))
      .for('share');
    const usable = new Set(
      accounts
        .filter((account) => !account.isGroup && (allowArchived || account.archivedAt === null))
        .map((account) => account.id),
    );
    const badAccounts = lines.flatMap((line, index) => (usable.has(line.accountId) ? [] : [index]));
    // The same answer for "not a ledger", "archived", "no such id" and "another tenant's":
    // the form shows one sentence, and nothing about other tenants leaks
    if (badAccounts.length > 0)
      throw lineErrors('journal_account_invalid', 'accountId', badAccounts);
    if (!allowStock) {
      const stock = await stockAccountIds(tx);
      const onStock = lines.flatMap((line, index) => (stock.has(line.accountId) ? [index] : []));
      if (onStock.length > 0) throw lineErrors('journal_account_stock', 'accountId', onStock);
    }
    // After the accounts: the rule depends on each line's account, which is valid by now
    const partyIssues = await checkParties(
      tx,
      lines,
      new Map(accounts.map((account) => [account.id, account.purpose])),
      { allowMissing: allowMissingParty, allowArchived },
    );
    if (partyIssues.length > 0) throw partyError(partyIssues);

    const branchIds = [
      ...new Set(lines.flatMap((line) => (line.branchId === null ? [] : [line.branchId]))),
    ];
    if (branchIds.length === 0) return;
    const active = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, tenantId),
          inArray(branches.id, branchIds),
          allowArchived ? undefined : isNull(branches.archivedAt),
        ),
      )
      .for('share');
    const known = new Set(active.map((branch) => branch.id));
    const badBranches = lines.flatMap((line, index) =>
      line.branchId === null || known.has(line.branchId) ? [] : [index],
    );
    if (badBranches.length > 0) throw lineErrors('journal_branch_invalid', 'branchId', badBranches);
  }

  // Lines in the order they were written: line_no 1, 2, 3…
  async writeLines(tx: Transaction, entryId: string, lines: readonly LineInput[]): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.entryId, entryId)));
    await tx.insert(journalLines).values(
      lines.map((line, index) => ({
        tenantId,
        entryId,
        lineNo: index + 1,
        accountId: line.accountId,
        branchId: line.branchId,
        partyId: line.partyId,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
      })),
    );
  }

  async insertDraft(
    tx: Transaction,
    entry: Omit<NewEntry, 'lines'>,
    lines: readonly LineInput[],
  ): Promise<EntryRow> {
    const [row] = await tx
      .insert(journalEntries)
      .values({
        tenantId: getTenantId(),
        date: entry.date,
        narration: entry.narration,
        source: entry.source,
        reversalOfId: entry.reversalOfId ?? null,
        documentId: entry.document?.id ?? null,
        documentNumber: entry.document?.number ?? null,
        createdBy: actorId(),
        updatedBy: actorId(),
      })
      .returning();
    if (!row) throw new Error('Journal entry insert returned no row');
    await this.writeLines(tx, row.id, lines);
    return row;
  }

  // Turns a draft into a posted entry: every rule, then the number, then the status. The caller
  // has locked the draft (FOR UPDATE). The database checks the balance once more at COMMIT
  // (migration 0016) — this is where a person gets a readable error instead.
  async post(tx: Transaction, entry: EntryRow): Promise<EntryRow> {
    const tenantId = getTenantId();
    await assertPeriodOpen(tx, entry.date);
    const lines = await tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.entryId, entry.id)))
      .orderBy(asc(journalLines.lineNo));
    if (lines.length < 2) {
      throw new AppError(409, 'journal_lines_too_few', 'An entry needs at least two lines.');
    }
    const debits = sumMoney(lines.map((line) => line.debit));
    const credits = sumMoney(lines.map((line) => line.credit));
    if (debits !== credits) {
      throw new AppError(
        409,
        'journal_unbalanced',
        `The debits (${debits}) and credits (${credits}) must be equal.`,
      );
    }
    // A reversal undoes old work, and a year-end close empties every income and expense account
    // that holds a balance: both must reach an account that was archived since
    await this.checkLines(tx, lines, {
      allowArchived: entry.source === 'reversal' || entry.source === 'year_close',
      allowStock:
        entry.source === 'reversal' ||
        entry.source === 'year_close' ||
        isStockJournalSource(entry.source),
      // The same exception as migration 0026's: only a reversal, which copies its original's lines
      allowMissingParty: entry.source === 'reversal',
    });

    // In the same transaction: if anything after this fails, the number goes back (step 6)
    const number = await this.numbering.next(tx, 'accounting.journal', entry.date);
    const [row] = await tx
      .update(journalEntries)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: actorId(),
        version: sql`${journalEntries.version} + 1`,
        updatedBy: actorId(),
      })
      .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.id, entry.id)))
      .returning();
    if (!row) throw new Error('Journal entry post returned no row');
    return row;
  }

  // postJournal(): a new entry straight into the books. It is written as a draft first and then
  // posted, inside the caller's transaction — so the lines are always added to a draft (the
  // database refuses new lines on a posted entry), and every rule of post() applies.
  async postNew(tx: Transaction, entry: NewEntry): Promise<EntryRow> {
    const draft = await this.insertDraft(tx, entry, entry.lines);
    return this.post(tx, draft);
  }
}
