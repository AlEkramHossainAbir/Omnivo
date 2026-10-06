import { Inject, Injectable } from '@nestjs/common';
import {
  isStockJournalSource,
  type JournalEntry,
  type JournalEntryInput,
  type JournalEntrySummary,
  type JournalStatus,
  sumMoney,
  type UpdateJournalEntryInput,
} from '@omnivo/contracts';
import { journalEntries, journalLines } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { type EntryRow, type LineInput, PostingService } from './posting.service.js';

// The entry that reverses this one, and the entry this one reverses — two joins on the same table
const reversal = alias(journalEntries, 'reversal');
const original = alias(journalEntries, 'original');

// The sum of the debits, from the lines. round(…, 4): an entry without lines still reads
// "0.0000", like every other amount, instead of "0".
const total = sql<string>`(
  SELECT round(coalesce(sum(l.debit), 0), 4) FROM ${journalLines} l
   WHERE l.tenant_id = ${journalEntries.tenantId} AND l.entry_id = ${journalEntries.id}
)`;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

function notDraft(): AppError {
  return new AppError(
    409,
    'journal_not_draft',
    'Only a draft can be changed. Reverse a posted entry instead.',
  );
}

// What the audit log shows for an entry: the header and the size of the entry, not every line
function snapshot(entry: { date: string; narration: string | null }, lines: readonly LineInput[]) {
  return {
    date: entry.date,
    narration: entry.narration,
    total: sumMoney(lines.map((line) => line.debit)),
    lines: lines.length,
  };
}

@Injectable()
export class JournalService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
    private readonly permissions: PermissionService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: JournalStatus | undefined;
  }): Promise<{ items: JournalEntrySummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.status === undefined ? undefined : eq(journalEntries.status, query.status),
          after === undefined
            ? undefined
            : sql`(${journalEntries.date}, ${journalEntries.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<JournalEntry> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: JournalEntryInput): Promise<JournalEntry> {
    if (input.post) await this.assertCanPost();
    return this.withTenant(async (tx) => {
      await this.posting.checkLines(tx, input.lines);
      let row = await this.posting.insertDraft(
        tx,
        { date: input.date, narration: input.narration, source: 'manual' },
        input.lines,
      );
      await audit(tx, {
        action: 'journal.created',
        entityType: 'journal_entry',
        entityId: row.id,
        changes: created(snapshot(input, input.lines)),
      });
      if (input.post) row = await this.postAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  async update(id: string, input: UpdateJournalEntryInput): Promise<JournalEntry> {
    if (input.post) await this.assertCanPost();
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      await this.posting.checkLines(tx, input.lines);
      const [updated] = await tx
        .update(journalEntries)
        .set({
          date: input.date,
          narration: input.narration,
          version: sql`${journalEntries.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.id, id)))
        .returning();
      if (!updated) throw notFound('Journal entry');
      await this.posting.writeLines(tx, id, input.lines);
      await audit(tx, {
        action: 'journal.updated',
        entityType: 'journal_entry',
        entityId: id,
        changes: diff(snapshot(before, linesBefore), snapshot(input, input.lines)),
      });
      if (input.post) await this.postAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(journalEntries)
        .where(and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.id, id)));
      await audit(tx, {
        action: 'journal.deleted',
        entityType: 'journal_entry',
        entityId: id,
        changes: diff(snapshot(before, lines), {
          date: null,
          narration: null,
          total: null,
          lines: null,
        }),
      });
    });
  }

  post(id: string, version: number): Promise<JournalEntry> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  async reverse(id: string, input: { version: number; date: string }): Promise<JournalEntry> {
    try {
      return await this.withTenant(async (tx) => {
        const entry = await this.lock(tx, id);
        if (entry.status !== 'posted') {
          throw new AppError(409, 'journal_not_posted', 'Only a posted entry can be reversed.');
        }
        if (entry.source === 'reversal') {
          // Reversing a reversal would put the mistake back. Post a new, correct entry instead.
          throw new AppError(409, 'journal_is_reversal', 'A reversal cannot be reversed.');
        }
        if (entry.source === 'year_close') {
          // A closing entry is undone by reopening its year (FiscalYearsService.reopen), which
          // also moves the lock date and dates the reversal on the year's last day
          throw new AppError(
            409,
            'journal_is_year_close',
            'A closing entry is undone by reopening its year.',
          );
        }
        if (isStockJournalSource(entry.source)) {
          // A stock document's entry moves with its stock (step 14): reversing it alone would
          // leave the stock worth one thing and the books another. Another stock document puts it
          // right — an adjustment the other way, or a revaluation.
          throw new AppError(
            409,
            'journal_is_stock',
            'This entry belongs to a stock document. Post another stock document to correct it.',
          );
        }
        if (entry.version !== input.version) throw versionConflict();
        const [already] = await tx
          .select({ id: reversal.id })
          .from(reversal)
          .where(and(eq(reversal.tenantId, getTenantId()), eq(reversal.reversalOfId, id)));
        if (already) throw alreadyReversed();
        if (input.date < entry.date) {
          throw new AppError(
            409,
            'journal_reversal_date',
            'A reversal cannot be dated before the entry it reverses.',
            { fieldErrors: { date: ['journal_reversal_date'] } },
          );
        }

        // The same lines with debit and credit swapped: together the two entries add up to zero
        const lines = await this.linesOf(tx, id);
        const reversed = await this.posting.postNew(tx, {
          date: input.date,
          narration: `Reversal of ${entry.number ?? ''}`,
          source: 'reversal',
          reversalOfId: id,
          lines: lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
        });
        await audit(tx, {
          action: 'journal.reversed',
          entityType: 'journal_entry',
          entityId: id,
          changes: created({ reversal: reversed.number, date: input.date }),
        });
        return this.read(tx, reversed.id);
      });
    } catch (error) {
      // Two people pressed Reverse at the same moment: both passed the check above, the unique
      // index let only one insert through. Caught outside, after the rollback (step 6's pattern).
      if (isUniqueViolation(error, 'journal_entries_tenant_reversal_idx')) throw alreadyReversed();
      throw error;
    }
  }

  // "Save and post" needs both permissions. The route checked accounting.journal.create; the
  // post half is checked here, with the same answer the PermissionGuard gives.
  private async assertCanPost(): Promise<void> {
    const access = await this.permissions.forPrincipal(currentPrincipal());
    if (!access?.permissions.includes('accounting.journal.post')) {
      throw new AppError(
        403,
        'permission_missing',
        'Missing permission: accounting.journal.post.',
        {
          params: { permissions: 'accounting.journal.post' },
        },
      );
    }
  }

  private async postAndLog(tx: Transaction, draft: EntryRow): Promise<EntryRow> {
    const posted = await this.posting.post(tx, draft);
    await audit(tx, {
      action: 'journal.posted',
      entityType: 'journal_entry',
      entityId: posted.id,
      changes: created({ number: posted.number }),
    });
    return posted;
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lock(tx: Transaction, id: string): Promise<EntryRow> {
    const [row] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.id, id)))
      .for('update');
    if (!row) throw notFound('Journal entry');
    return row;
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<EntryRow> {
    const row = await this.lock(tx, id);
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, entryId: string) {
    return tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, entryId)))
      .orderBy(asc(journalLines.lineNo));
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<JournalEntrySummary[]> {
    const rows = await tx
      .select({
        entry: journalEntries,
        total,
        reversedById: reversal.id,
        reversedByNumber: reversal.number,
        reversalOfNumber: original.number,
      })
      .from(journalEntries)
      .leftJoin(
        reversal,
        and(
          eq(reversal.tenantId, journalEntries.tenantId),
          eq(reversal.reversalOfId, journalEntries.id),
        ),
      )
      .leftJoin(
        original,
        and(
          eq(original.tenantId, journalEntries.tenantId),
          eq(original.id, journalEntries.reversalOfId),
        ),
      )
      .where(and(eq(journalEntries.tenantId, getTenantId()), where))
      .orderBy(desc(journalEntries.date), desc(journalEntries.id))
      .limit(limit);
    return rows.map(({ entry, ...refs }) => ({
      id: entry.id,
      number: entry.number,
      date: entry.date,
      narration: entry.narration,
      status: entry.status,
      source: entry.source,
      total: refs.total,
      // A reversal is always posted, so it always has a number; the join makes both nullable
      reversalOf:
        entry.reversalOfId !== null && refs.reversalOfNumber !== null
          ? { id: entry.reversalOfId, number: refs.reversalOfNumber }
          : null,
      reversedBy:
        refs.reversedById !== null && refs.reversedByNumber !== null
          ? { id: refs.reversedById, number: refs.reversedByNumber }
          : null,
      document:
        entry.documentId !== null && entry.documentNumber !== null
          ? { id: entry.documentId, number: entry.documentNumber }
          : null,
      postedAt: entry.postedAt?.toISOString() ?? null,
      version: entry.version,
      updatedAt: entry.updatedAt.toISOString(),
    }));
  }

  private async read(tx: Transaction, id: string): Promise<JournalEntry> {
    const [summary] = await this.summaries(tx, eq(journalEntries.id, id), 1);
    if (!summary) throw notFound('Journal entry');
    const lines = await this.linesOf(tx, id);
    return {
      ...summary,
      lines: lines.map((line) => ({
        id: line.id,
        accountId: line.accountId,
        branchId: line.branchId,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
      })),
    };
  }
}

function alreadyReversed(): AppError {
  return new AppError(409, 'journal_already_reversed', 'This entry has been reversed already.');
}
