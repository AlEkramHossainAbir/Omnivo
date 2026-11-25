import { Injectable } from '@nestjs/common';
import { type EntryRef, isZeroMoney } from '@omnivo/contracts';
import { journalEntries, journalLines } from '@omnivo/db';
import { and, asc, eq } from 'drizzle-orm';

import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { type LineInput, PostingService } from '../../journal/posting.service.js';

// What the entry needs from the payout: the accounts it copied, its branch and its three sums
export interface PayoutPosting {
  branchId: string;
  bankAccountId: string;
  codAccountId: string;
  chargeAccountId: string | null;
  collected: string;
  charges: string;
  net: string;
}

function line(accountId: string, branchId: string, debit: string, credit: string): LineInput {
  return { accountId, branchId, partyId: null, description: null, debit, credit };
}

// A found entry as a reference; a posted entry always has its number
function toRef(entry: { id: string; number: string | null }): EntryRef {
  if (entry.number === null) throw new Error('A posted entry has no number');
  return { id: entry.id, number: entry.number };
}

// Step 28c: the journal half of a courier's payout (decision 3), like SalesBooksService for the
// sales documents: it builds the entry and posts it through the journal's PostingService, inside
// the payout's own transaction, so the payout, its parcels and the books change together or not at
// all. Its own class, not a method on SalesBooksService: the payout is no sales document, and its
// source is the storefront group's (mine 23), which the journal's Reverse refuses on its own.
@Injectable()
export class PayoutBooks {
  constructor(private readonly posting: PostingService) {}

  // Dr the bank for what reached it / Dr the charges account for the courier's charges / Cr the COD
  // account for what the riders collected, every line with the payout's branch. A side of ৳0 has no
  // line: a payout whose charges ate all the cash has no bank line (decision 3), and one with no
  // charges has no charges line. The collected side is never 0: with nothing collected the net is
  // below zero, which create() refuses first
  async post(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: PayoutPosting,
  ): Promise<EntryRef> {
    const lines: LineInput[] = [];
    if (!isZeroMoney(input.net)) {
      lines.push(line(input.bankAccountId, input.branchId, input.net, '0'));
    }
    if (!isZeroMoney(input.charges)) {
      if (input.chargeAccountId === null) throw new Error('A payout with charges has no account');
      lines.push(line(input.chargeAccountId, input.branchId, input.charges, '0'));
    }
    lines.push(line(input.codAccountId, input.branchId, '0', input.collected));
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration: `Courier payout ${document.number}`,
      source: 'storefront_payout',
      document: { id: document.id, number: document.number },
      lines,
    });
    return toRef(entry);
  }

  // The payout's own entry. Posted: a reversal leaves it posted, and has its own source
  async entryOf(tx: Transaction, payoutId: string): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, getTenantId()),
          eq(journalEntries.documentId, payoutId),
          eq(journalEntries.source, 'storefront_payout'),
          eq(journalEntries.status, 'posted'),
        ),
      );
    return row === undefined ? null : toRef(row);
  }

  // The reversal of the payout's entry, once it is voided
  async reversalOf(tx: Transaction, entryId: string): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.reversalOfId, entryId)),
      );
    return row === undefined ? null : toRef(row);
  }

  // A voided payout: the journal's own reversal of its entry (source 'reversal', pointing back at
  // it), dated the void date, the same lines with debit and credit swapped, as a voided receipt's.
  // The COD account gets the money back, so Holds counts the parcels again once they are freed
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
      lines: lines.map((row) => ({ ...row, debit: row.credit, credit: row.debit })),
    });
    return toRef(posted);
  }
}
