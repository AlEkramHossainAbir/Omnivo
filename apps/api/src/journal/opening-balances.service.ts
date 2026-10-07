import { Inject, Injectable } from '@nestjs/common';
import {
  isNegativeMoney,
  isZeroMoney,
  type OpeningBalances,
  type OpeningBalancesInput,
  absMoney,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { journalEntries, journalLines, ledgerAccounts, parties } from '@omnivo/db';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { audit, created } from '../common/audit/audit.js';
import { AppError, versionConflict } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  checkParties,
  type LineInput,
  partyError,
  PostingService,
  stockAccountIds,
} from './posting.service.js';

const reversal = alias(journalEntries, 'reversal');

// Balance sheet accounts only. Income and expenses start at zero on the go-live day; the profit
// of the years before is already inside Retained earnings, which is equity.
const OPENING_TYPES = ['asset', 'liability', 'equity'] as const;

function invalidLines(
  code: 'opening_account_invalid' | 'journal_account_stock',
  indexes: number[],
) {
  return new AppError(409, code, 'Some lines cannot take an opening balance.', {
    fieldErrors: Object.fromEntries(
      indexes.map((index) => [`lines.${String(index)}.accountId`, [code]]),
    ),
  });
}

@Injectable()
export class OpeningBalancesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
  ) {}

  get(): Promise<OpeningBalances> {
    return this.withTenant((tx) => this.read(tx));
  }

  // One posted entry holds the opening balances. Saving again reverses it (dated as it was) and
  // posts a new one: the journal keeps the whole history, and nothing posted is ever edited.
  save(input: OpeningBalancesInput): Promise<OpeningBalances> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // Two saves at once would both see "no entry yet" and post two opening entries. The
      // advisory lock makes the second wait, then fail the `replaces` check below.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`opening_balances:${tenantId}`}, 0))`,
      );
      const current = await this.current(tx);
      if ((current?.id ?? null) !== input.replaces) throw versionConflict();

      // Keep each line's index in the request, so an error lands under the right row of the page
      // The same account (and customer) twice is refused by the contract (opening_balance_twice)
      const filled = input.lines.flatMap((line, index) =>
        isZeroMoney(line.debit) && isZeroMoney(line.credit) ? [] : [{ ...line, index }],
      );

      const accounts = await tx
        .select({
          id: ledgerAccounts.id,
          type: ledgerAccounts.type,
          isGroup: ledgerAccounts.isGroup,
          purpose: ledgerAccounts.purpose,
          archivedAt: ledgerAccounts.archivedAt,
        })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.tenantId, tenantId));
      const equity = accounts.find((account) => account.purpose === 'opening_balance_equity');
      // Every chart has it (step 9's templates and backfill), and it cannot be deleted
      if (!equity) throw new Error(`No opening balance equity account in tenant ${tenantId}`);
      const allowed = new Set(
        accounts
          .filter(
            (account) =>
              OPENING_TYPES.some((type) => type === account.type) &&
              !account.isGroup &&
              account.archivedAt === null &&
              account.id !== equity.id,
          )
          .map((account) => account.id),
      );
      const invalid = filled.flatMap((line) => (allowed.has(line.accountId) ? [] : [line.index]));
      if (invalid.length > 0) throw invalidLines('opening_account_invalid', invalid);
      // Step 14: opening stock is an adjustment (reason "Opening stock"), which values each item and
      // posts it — a number typed here would be a value with no stock behind it
      const stock = await stockAccountIds(tx);
      const onStock = filled.flatMap((line) => (stock.has(line.accountId) ? [line.index] : []));
      if (onStock.length > 0) throw invalidLines('journal_account_stock', onStock);
      // Step 15a: the receivable is split by customer, and only the receivable names one. Checked
      // here and not only when the entry is posted below: the posted entry has no zero lines and an
      // extra equity line, so its line numbers are not the page's rows.
      const partyIssues = await checkParties(
        tx,
        filled,
        new Map(accounts.map((account) => [account.id, account.purpose])),
      );
      if (partyIssues.length > 0) {
        // An issue's index is its place in `filled`; the page needs the row it came from
        throw partyError(
          partyIssues.flatMap((issue) => {
            const line = filled[issue.index];
            return line ? [{ ...issue, index: line.index }] : [];
          }),
        );
      }

      if (current) {
        const lines = await this.linesOf(tx, current.id);
        await this.posting.postNew(tx, {
          date: current.date,
          narration: `Reversal of opening balances ${current.number ?? ''}`,
          source: 'reversal',
          reversalOfId: current.id,
          lines: lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
        });
      }

      let number: string | null = null;
      if (filled.length > 0) {
        const lines: LineInput[] = filled.map((line) => ({
          accountId: line.accountId,
          branchId: null,
          partyId: line.partyId,
          description: null,
          debit: line.debit,
          credit: line.credit,
        }));
        // What the books are out by goes to Opening balance equity, on the side that closes the
        // gap. Once everything is entered it should read zero (step 9's template note).
        const difference = subtractMoney(
          sumMoney(lines.map((line) => line.debit)),
          sumMoney(lines.map((line) => line.credit)),
        );
        if (!isZeroMoney(difference)) {
          const amount = absMoney(difference);
          lines.push({
            accountId: equity.id,
            branchId: null,
            partyId: null,
            description: null,
            debit: isNegativeMoney(difference) ? amount : '0',
            credit: isNegativeMoney(difference) ? '0' : amount,
          });
        }
        const entry = await this.posting.postNew(tx, {
          // The day before go-live: the balances as the old books ended
          date: shiftIsoDate(input.goLiveDate, -1),
          narration: 'Opening balances',
          source: 'opening_balance',
          lines,
        });
        number = entry.number;
      }

      await audit(tx, {
        action: 'journal.opening_balances_saved',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({
          goLiveDate: filled.length > 0 ? input.goLiveDate : null,
          accounts: new Set(filled.map((line) => line.accountId)).size,
          // How many customers' dues came in with it (step 15a)
          customers: filled.filter((line) => line.partyId !== null).length,
          entry: number,
        }),
      });
      return this.read(tx);
    });
  }

  // The opening entry that is still in force: posted, and not reversed
  private async current(tx: Transaction) {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number, date: journalEntries.date })
      .from(journalEntries)
      .leftJoin(
        reversal,
        and(
          eq(reversal.tenantId, journalEntries.tenantId),
          eq(reversal.reversalOfId, journalEntries.id),
        ),
      )
      .where(
        and(
          eq(journalEntries.tenantId, getTenantId()),
          eq(journalEntries.source, 'opening_balance'),
          eq(journalEntries.status, 'posted'),
          isNull(reversal.id),
        ),
      )
      .orderBy(desc(journalEntries.postedAt))
      .limit(1);
    return row;
  }

  private linesOf(tx: Transaction, entryId: string) {
    return tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, entryId)))
      .orderBy(asc(journalLines.lineNo));
  }

  private async read(tx: Transaction): Promise<OpeningBalances> {
    const current = await this.current(tx);
    if (!current?.number) return { goLiveDate: null, entry: null, lines: [] };
    const equity = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, getTenantId()),
          eq(ledgerAccounts.purpose, 'opening_balance_equity'),
        ),
      );
    const equityIds = new Set(equity.map((account) => account.id));
    const lines = await tx
      .select({ line: journalLines, partyCode: parties.code, partyName: parties.name })
      .from(journalLines)
      .leftJoin(
        parties,
        and(eq(parties.tenantId, journalLines.tenantId), eq(parties.id, journalLines.partyId)),
      )
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, current.id)))
      .orderBy(asc(journalLines.lineNo));
    return {
      goLiveDate: shiftIsoDate(current.date, 1),
      entry: { id: current.id, number: current.number },
      // The equity line is the server's own; the page shows it as "the difference"
      lines: lines
        .filter(({ line }) => !equityIds.has(line.accountId))
        .map(({ line, partyCode, partyName }) => ({
          accountId: line.accountId,
          party:
            line.partyId !== null && partyCode !== null && partyName !== null
              ? { id: line.partyId, code: partyCode, name: partyName }
              : null,
          debit: line.debit,
          credit: line.credit,
        })),
    };
  }
}
