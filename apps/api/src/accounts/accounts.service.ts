import { Inject, Injectable } from '@nestjs/common';
import type { Account, CreateAccountInput, UpdateAccountInput } from '@omnivo/contracts';
import { ledgerAccounts } from '@omnivo/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type AccountRow = typeof ledgerAccounts.$inferSelect;

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    type: row.type,
    isGroup: row.isGroup,
    purpose: row.purpose,
    description: row.description,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows: the form's fields, with the group as its code — an id would mean
// nothing to the person reading the log
function snapshot(row: Pick<AccountRow, 'code' | 'name' | 'description'>, parent: string | null) {
  return { code: row.code, name: row.name, description: row.description, parent };
}

function codeTaken(code: string): AppError {
  return new AppError(409, 'account_code_taken', `Account code ${code} is already used.`, {
    fieldErrors: { code: ['account_code_taken'] },
  });
}

// The same answer for "no such group", "another tenant's group", "a posting account", "archived"
// and "another type": the form shows one message under the Group field, and nothing leaks
function parentInvalid(): AppError {
  return new AppError(409, 'account_parent_invalid', 'The parent must be an active group.', {
    fieldErrors: { parentId: ['account_parent_invalid'] },
  });
}

function locked(): AppError {
  return new AppError(
    409,
    'account_locked',
    'Top-level groups and system accounts cannot be archived or deleted.',
  );
}

// Every change to a tenant's chart takes this lock first, so the changes to one chart run one after
// another (other tenants never wait). A chart is edited a few times a month, so the wait is
// nothing, and it removes two races that row locks alone leave open:
// - Two moves in opposite directions (A under B, B under A). Each locks its own row, then the
//   parent FK needs a share lock on the other's row: a deadlock. Postgres aborts one after a
//   second, and that person sees an error. With this lock the second move simply waits, then its
//   loop check sees the first move and refuses.
// - A new account under a group that is being archived. The insert only waits for the archive to
//   commit (the FK checks that the group exists, not that it is active), then adds an active
//   account under an archived group.
// An advisory lock is a lock on a number instead of a row; the _xact_ kind is released at commit or
// rollback by itself. hashtextextended turns the text into that number; the prefix keeps it apart
// from any other advisory lock added later.
async function lockChart(tx: Transaction): Promise<void> {
  const key = `ledger_accounts:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

@Injectable()
export class AccountsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<Account[]> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.tenantId, tenantId))
        .orderBy(asc(ledgerAccounts.code));
      return rows.map(toAccount);
    });
  }

  get(id: string): Promise<Account> {
    return this.withTenant(async (tx) => toAccount(await this.lock(tx, id, false)));
  }

  async create(input: CreateAccountInput): Promise<Account> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        await lockChart(tx);
        const parent = await this.parent(tx, input.parentId);
        const [row] = await tx
          .insert(ledgerAccounts)
          .values({
            tenantId,
            parentId: parent.id,
            // Never from the request: an account's type is always its group's
            type: parent.type,
            isGroup: input.isGroup,
            code: input.code,
            name: input.name,
            description: input.description,
            createdBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Account insert returned no row');
        await audit(tx, {
          action: 'account.created',
          entityType: 'account',
          entityId: row.id,
          changes: created(snapshot(row, parent.code)),
        });
        return toAccount(row);
      });
    } catch (error) {
      // Caught outside the transaction, after its rollback (the branches pattern, step 6)
      if (isUniqueViolation(error, 'ledger_accounts_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    try {
      return await this.withTenant(async (tx) => {
        await lockChart(tx);
        const before = await this.lock(tx, id, true);
        if (before.version !== input.version) throw versionConflict();
        const parentBefore = await this.codeOf(tx, before.parentId);
        const parentAfter =
          input.parentId === before.parentId
            ? parentBefore
            : await this.move(tx, before, input.parentId);
        const after = await this.write(tx, id, {
          parentId: input.parentId,
          code: input.code,
          name: input.name,
          description: input.description,
        });
        await audit(tx, {
          action: 'account.updated',
          entityType: 'account',
          entityId: id,
          changes: diff(snapshot(before, parentBefore), snapshot(after, parentAfter)),
        });
        return toAccount(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ledger_accounts_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  archive(id: string, version: number): Promise<Account> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      await lockChart(tx);
      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt !== null) return toAccount(before);
      if (before.parentId === null || before.purpose !== null) throw locked();
      if (before.isGroup) {
        // The chart lock keeps a new or restored child from appearing before we commit
        const [child] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.tenantId, tenantId),
              eq(ledgerAccounts.parentId, id),
              isNull(ledgerAccounts.archivedAt),
            ),
          )
          .limit(1);
        if (child) {
          throw new AppError(
            409,
            'account_has_active_children',
            'Archive the accounts under this group first.',
          );
        }
      }
      const after = await this.write(tx, id, { archivedAt: new Date() });
      await audit(tx, { action: 'account.archived', entityType: 'account', entityId: id });
      return toAccount(after);
    });
  }

  restore(id: string, version: number): Promise<Account> {
    return this.withTenant(async (tx) => {
      await lockChart(tx);
      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt === null) return toAccount(before);
      // An active account under an archived group would be hidden with its group, yet usable
      if (before.parentId !== null) {
        const [parent] = await tx
          .select({ archivedAt: ledgerAccounts.archivedAt })
          .from(ledgerAccounts)
          .where(
            and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, before.parentId)),
          );
        if (parent?.archivedAt !== null) {
          throw new AppError(
            409,
            'account_parent_archived',
            'Restore the group above this account first.',
          );
        }
      }
      const after = await this.write(tx, id, { archivedAt: null });
      await audit(tx, { action: 'account.restored', entityType: 'account', entityId: id });
      return toAccount(after);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    try {
      await this.withTenant(async (tx) => {
        await lockChart(tx);
        const before = await this.lock(tx, id, true);
        if (before.version !== version) throw versionConflict();
        if (before.parentId === null || before.purpose !== null) throw locked();
        const parent = await this.codeOf(tx, before.parentId);
        await tx
          .delete(ledgerAccounts)
          .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.id, id)));
        await audit(tx, {
          action: 'account.deleted',
          entityType: 'account',
          entityId: id,
          changes: diff(snapshot(before, parent), {
            code: null,
            name: null,
            description: null,
            parent: null,
          }),
        });
      });
    } catch (error) {
      // No "has children?" query first: the parent FK is the check. A group with accounts under
      // it (archived ones too) cannot be deleted. From step 10 the journal lines' FK adds "has
      // entries" the same way.
      if (isForeignKeyViolation(error, 'ledger_accounts_parent_fk')) {
        throw new AppError(
          409,
          'account_has_children',
          'Move or delete the accounts under this group first.',
        );
      }
      throw error;
    }
  }

  // The group a new or moved account goes under. No row lock needed: the caller holds the chart
  // lock, so nobody archives, deletes or moves this group before we commit.
  private async parent(tx: Transaction, id: string): Promise<AccountRow> {
    const [row] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)));
    if (!row?.isGroup || row.archivedAt !== null) throw parentInvalid();
    return row;
  }

  // Checks a move and returns the new group's code, for the audit log
  private async move(
    tx: Transaction,
    account: AccountRow,
    parentId: string | null,
  ): Promise<string> {
    // A top-level group stays at the top; every other account stays under some group
    if (account.parentId === null || parentId === null) throw parentInvalid();

    const parent = await this.parent(tx, parentId);
    // The parent FK would refuse this too, but as an error nobody can read
    if (parent.type !== account.type) throw parentInvalid();

    // Walk up from the new group to the top. Meeting the account on the way means the new group
    // is the account itself or sits under it — the move would cut the branch off into a loop.
    // The chart lock makes sure no other move is half done while we look.
    const loop = await tx.execute(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM ledger_accounts
         WHERE tenant_id = ${account.tenantId} AND id = ${parent.id}
        UNION ALL
        SELECT a.id, a.parent_id FROM ledger_accounts a
          JOIN up ON a.id = up.parent_id
         WHERE a.tenant_id = ${account.tenantId}
      )
      SELECT 1 FROM up WHERE id = ${account.id} LIMIT 1`);
    if (loop.length > 0) {
      throw new AppError(409, 'account_parent_loop', 'A group cannot go under its own accounts.', {
        fieldErrors: { parentId: ['account_parent_loop'] },
      });
    }
    return parent.code;
  }

  private async codeOf(tx: Transaction, id: string | null): Promise<string | null> {
    if (id === null) return null;
    const [row] = await tx
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)));
    return row?.code ?? null;
  }

  // FOR UPDATE on the account itself: the chart lock only stops other chart edits. From step 10,
  // posting a journal line locks its account FOR SHARE, so it cannot land on an account that is
  // being archived or deleted at that moment. tenant filter + RLS: another tenant's id is "not
  // there" — 404, never 403.
  private async lock(tx: Transaction, id: string, forUpdate: boolean): Promise<AccountRow> {
    const query = tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Account');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<AccountRow, 'parentId' | 'code' | 'name' | 'description' | 'archivedAt'>>,
  ): Promise<AccountRow> {
    const [row] = await tx
      .update(ledgerAccounts)
      .set({
        ...fields,
        version: sql`${ledgerAccounts.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)))
      .returning();
    if (!row) throw notFound('Account');
    return row;
  }
}
