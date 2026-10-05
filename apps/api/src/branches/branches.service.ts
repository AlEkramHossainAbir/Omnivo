import { Inject, Injectable } from '@nestjs/common';
import type { Branch, BranchInput, BranchStatus } from '@omnivo/contracts';
import { branches, warehouses } from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type BranchRow = typeof branches.$inferSelect;

// DB-র রো → চুক্তির আকার: তারিখ ISO string, আর চুক্তির বাইরের কলাম (tenant_id, created_by) বাদ
function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    address: row.address,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// audit-এ যা দেখা যায় — ফর্মের ঘরগুলো
function snapshot(row: Pick<BranchRow, 'code' | 'name' | 'phone' | 'address'>) {
  return { code: row.code, name: row.name, phone: row.phone, address: row.address };
}

function codeTaken(code: string): AppError {
  return new AppError(409, 'branch_code_taken', `Branch code ${code} is already used.`, {
    fieldErrors: { code: ['branch_code_taken'] },
  });
}

@Injectable()
export class BranchesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(status: BranchStatus): Promise<Branch[]> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(branches)
        .where(
          and(
            eq(branches.tenantId, tenantId),
            status === 'active' ? isNull(branches.archivedAt) : isNotNull(branches.archivedAt),
          ),
        )
        .orderBy(asc(branches.code));
      return rows.map(toBranch);
    });
  }

  get(id: string): Promise<Branch> {
    return this.withTenant(async (tx) => toBranch(await this.lock(tx, id, false)));
  }

  async create(input: BranchInput): Promise<Branch> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(branches)
          .values({ tenantId, ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Branch insert returned no row');
        await audit(tx, {
          action: 'branch.created',
          entityType: 'branch',
          entityId: row.id,
          changes: created(snapshot(row)),
        });
        return toBranch(row);
      });
    } catch (error) {
      // unique index-এর error transaction-কে অচল করে দেয় — তাই ধরা হয় withTenant-এর বাইরে, rollback
      // হয়ে যাওয়ার পরে। আগে SELECT করে দেখে নিলে দুজন একসাথে একই কোড দিলে দুজনেই পার পেত
      if (isUniqueViolation(error, 'branches_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  async update(id: string, input: BranchInput & { version: number }): Promise<Branch> {
    try {
      return await this.withTenant(async (tx) => {
        const { version, ...fields } = input;
        const before = await this.lock(tx, id, true);
        if (before.version !== version) throw versionConflict();
        const after = await this.write(tx, id, fields);
        await audit(tx, {
          action: 'branch.updated',
          entityType: 'branch',
          entityId: id,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return toBranch(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'branches_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  archive(id: string, version: number): Promise<Branch> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // টেন্যান্টের সব চালু ব্রাঞ্চ lock — শুধু নিজেরটা না। নাহলে দুজন একসাথে শেষ দুটো ব্রাঞ্চ archive
      // করলে দুজনেই "আরেকটা তো চালু আছে" দেখত, দুজনেই পার পেত, আর চালু ব্রাঞ্চ থাকত শূন্য (write skew)।
      // ORDER BY id: সবাই একই ক্রমে lock নেয়, তাই দুই transaction একে অন্যের জন্য আটকে deadlock হয় না
      const active = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), isNull(branches.archivedAt)))
        .orderBy(asc(branches.id))
        .for('update');

      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt !== null) return toBranch(before);
      if (active.every((branch) => branch.id === id)) {
        throw new AppError(
          409,
          'branch_last_active',
          'A workspace needs at least one active branch.',
        );
      }
      // Step 13: a warehouse lives in a branch. Archive (or move) its warehouses first, so no
      // stock is left in a branch nobody can pick any more. FOR UPDATE: a warehouse being created in
      // this branch right now holds the branch FOR SHARE, so one of the two waits for the other.
      const [warehouse] = await tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, tenantId),
            eq(warehouses.branchId, id),
            isNull(warehouses.archivedAt),
          ),
        )
        .limit(1);
      if (warehouse) {
        throw new AppError(
          409,
          'branch_has_warehouses',
          'Archive or move the warehouses of this branch first.',
        );
      }

      const after = await this.write(tx, id, { archivedAt: new Date() });
      await audit(tx, { action: 'branch.archived', entityType: 'branch', entityId: id });
      return toBranch(after);
    });
  }

  restore(id: string, version: number): Promise<Branch> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt === null) return toBranch(before);
      const after = await this.write(tx, id, { archivedAt: null });
      await audit(tx, { action: 'branch.restored', entityType: 'branch', entityId: id });
      return toBranch(after);
    });
  }

  // id দিয়ে একটা রো; forUpdate হলে transaction শেষ না হওয়া পর্যন্ত আর কেউ বদলাতে পারে না।
  // tenant filter + RLS: অন্য টেন্যান্টের id দিলে "নেই" — 404, 403 না
  private async lock(tx: Transaction, id: string, forUpdate: boolean): Promise<BranchRow> {
    const query = tx
      .select()
      .from(branches)
      .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Branch');
    return row;
  }

  // প্রতিটা লেখায় version এক বাড়ে — পুরনো version হাতে থাকা যে কারো পরের লেখা 409 পাবে
  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<BranchRow, 'code' | 'name' | 'phone' | 'address' | 'archivedAt'>>,
  ): Promise<BranchRow> {
    const [row] = await tx
      .update(branches)
      .set({
        ...fields,
        version: sql`${branches.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, id)))
      .returning();
    if (!row) throw notFound('Branch');
    return row;
  }
}
