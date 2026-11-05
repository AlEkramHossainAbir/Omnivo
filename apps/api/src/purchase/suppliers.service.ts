import { Inject, Injectable } from '@nestjs/common';
import {
  type ErrorCode,
  type Supplier,
  type SupplierInput,
  type SupplierPage,
  type SupplierSort,
  todayIn,
  type UpdateSupplierInput,
} from '@omnivo/contracts';
import {
  bills,
  goodsReceipts,
  journalEntries,
  journalLines,
  ledgerAccounts,
  parties,
  partyAddresses,
  partyBankAccounts,
  purchaseOrders,
  supplierGroups,
  supplierPayments,
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
import { PayableAccess } from './payable-access.js';

type PartyRow = typeof parties.$inferSelect;

// What the company owes a supplier: credit − debit of the posted payable lines that name it (step
// 17a), the customer's balance (step 15a) turned round. A correlated subquery on the parties row,
// run for the rows of one page only. The account filter keeps the receivable lines of a party that
// is also a customer out: what the customer owes is not netted with what is owed to it.
const balance = sql<string>`(
  SELECT round(coalesce(sum(l.credit - l.debit), 0), 4)::text
    FROM ${journalLines} l
    JOIN ${journalEntries} e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
    JOIN ${ledgerAccounts} a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
   WHERE l.tenant_id = parties.tenant_id AND l.party_id = parties.id
     AND e.status = 'posted' AND a.purpose = 'accounts_payable'
)`;

// The list's orders, like the customers'. Each has an index: parties_supplier_name_idx,
// parties_tenant_code_idx, parties_supplier_updated_idx.
const ORDERS = {
  name: { key: sql`lower(${parties.name})`, desc: false },
  '-name': { key: sql`lower(${parties.name})`, desc: true },
  code: { key: sql`lower(${parties.code})`, desc: false },
  '-code': { key: sql`lower(${parties.code})`, desc: true },
  '-updated': { key: sql`${parties.updatedAt}`, desc: true },
} satisfies Record<SupplierSort, { key: SQL; desc: boolean }>;

const cursorSchema = z.tuple([z.string(), z.uuid()]);

// What the audit log shows of a supplier. The bank accounts by their last four digits: enough to
// see which one changed, without copying every account number into the log.
interface Snapshot {
  [field: string]: string | number | null;
  code: string;
  name: string;
  group: string | null;
  phone: string | null;
  bin: string | null;
  paymentTermsDays: number;
  address: string | null;
  bankAccounts: string | null;
}

function codeTaken(): AppError {
  return new AppError(409, 'supplier_code_taken', 'Another customer or supplier uses this code.', {
    fieldErrors: { code: ['supplier_code_taken'] },
  });
}

function supplierInUse(): AppError {
  return new AppError(
    409,
    'supplier_in_use',
    'Entries or purchase documents use this supplier. Archive it instead.',
  );
}

function fieldError(code: ErrorCode, field: string): AppError {
  return new AppError(400, code, 'Check the highlighted fields and try again.', {
    fieldErrors: { [field]: [code] },
  });
}

// Rows that hold on to a supplier-only party, so its delete is refused (supplier_in_use). 17b–17d
// add their documents.
const SUPPLIER_IN_USE = [
  'journal_lines_party_fk',
  // step 17b
  'purchase_orders_supplier_fk',
  'goods_receipts_supplier_fk',
  // step 17c
  'bills_supplier_fk',
  'supplier_payments_supplier_fk',
  // step 17d
  'purchase_returns_supplier_fk',
  'debit_notes_supplier_fk',
  'supplier_refunds_supplier_fk',
] as const;

// Suppliers (step 17a): the same parties table as the customers, with is_supplier set. This
// service only reads and writes the supplier's side and the fields both sides share (decision 9);
// the customer's columns are CustomersService's.
@Injectable()
export class SuppliersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly access: PayableAccess,
  ) {}

  async list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    groupId?: string | undefined;
    status: 'active' | 'archived';
    sort: SupplierSort;
  }): Promise<SupplierPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const order = ORDERS[query.sort];
    const canSeeBalance = await this.access.canSee();
    const conditions: (SQL | undefined)[] = [
      eq(parties.tenantId, tenantId),
      eq(parties.isSupplier, true),
      query.status === 'active'
        ? isNull(parties.archivedAt)
        : sql`${parties.archivedAt} IS NOT NULL`,
      query.groupId === undefined ? undefined : eq(parties.supplierGroupId, query.groupId),
    ];
    if (query.search !== undefined && query.search !== '') {
      // The same trigram indexes as the customers' search (migration 0026): they cover the table
      const pattern = containsPattern(query.search);
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
          groupId: row.party.supplierGroupId,
          contactPerson: row.party.contactPerson,
          phone: row.party.phone,
          paymentTermsDays: row.party.supplierPaymentTermsDays,
          isCustomer: row.party.isCustomer,
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

  async get(id: string): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    return this.withTenant((tx) => this.read(tx, id, canSeeBalance));
  }

  async create(input: SupplierInput): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        await this.checkGroup(tx, input.groupId);
        const code = input.code ?? (await this.newCode(tx));
        if (await this.codeUsed(tx, code, null)) throw codeTaken();
        const [row] = await tx
          .insert(parties)
          .values({
            tenantId: getTenantId(),
            code,
            isSupplier: true,
            ...this.fields(input),
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning({ id: parties.id });
        if (!row) throw new Error('Supplier insert returned no row');
        await this.saveAddress(tx, row.id, input.address);
        await this.saveBankAccounts(tx, row.id, input.bankAccounts);
        const supplier = await this.read(tx, row.id, canSeeBalance);
        await audit(tx, {
          action: 'supplier.created',
          entityType: 'supplier',
          entityId: row.id,
          changes: created(await this.snapshot(tx, supplier)),
        });
        return supplier;
      });
    } catch (error) {
      throw this.mapSaveError(error);
    }
  }

  async update(id: string, input: UpdateSupplierInput): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        // The party row first, FOR UPDATE: two saves of one supplier take turns, so they cannot
        // both add a fifth bank account (decision 24), and a customer save of the same party waits
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await this.checkGroup(tx, input.groupId);
        const old = await this.read(tx, id, canSeeBalance);
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
        await this.saveAddress(tx, id, input.address);
        await this.saveBankAccounts(tx, id, input.bankAccounts);
        const supplier = await this.read(tx, id, canSeeBalance);
        await audit(tx, {
          action: 'supplier.updated',
          entityType: 'supplier',
          entityId: id,
          changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, supplier)),
        });
        return supplier;
      });
    } catch (error) {
      throw this.mapSaveError(error);
    }
  }

  // A customer the company starts buying from (decision 10): the same party, now also a supplier.
  // The supplier's own fields start at their defaults (no group, terms 0, no bank account), which
  // the database kept them at while it was not a supplier (parties_supplier_side_check).
  async fromCustomer(id: string, version: number): Promise<Supplier> {
    const canSeeBalance = await this.access.canSee();
    return this.withTenant(async (tx) => {
      const [before] = await tx
        .select()
        .from(parties)
        .where(
          and(
            eq(parties.tenantId, getTenantId()),
            eq(parties.id, id),
            eq(parties.isCustomer, true),
          ),
        )
        .for('update');
      if (!before) throw notFound('Customer');
      if (before.version !== version) throw versionConflict();
      if (before.isSupplier) {
        throw new AppError(409, 'party_role_exists', 'This customer is already a supplier.');
      }
      await tx
        .update(parties)
        .set({
          isSupplier: true,
          version: sql`${parties.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
      const supplier = await this.read(tx, id, canSeeBalance);
      await audit(tx, {
        action: 'supplier.created',
        entityType: 'supplier',
        entityId: id,
        changes: created(await this.snapshot(tx, supplier)),
      });
      return supplier;
    });
  }

  // Archived = the party (decision 10): one business, hidden from sales and purchase documents
  // alike. Its entries, balance and statement stay.
  async setArchived(id: string, version: number, archived: boolean): Promise<Supplier> {
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
          action: archived ? 'supplier.archived' : 'supplier.restored',
          entityType: 'supplier',
          entityId: id,
        });
      }
      return this.read(tx, id, canSeeBalance);
    });
  }

  // Only a supplier nothing uses yet. A party that is also a customer stays, as a customer: only
  // its supplier side goes (decision 10), like CustomersService.remove the other way round.
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        if (before.isCustomer) {
          await this.dropSupplierSide(tx, before);
        } else {
          // Its addresses and bank accounts go with it (ON DELETE CASCADE)
          await tx
            .delete(parties)
            .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
        }
        await audit(tx, {
          action: 'supplier.deleted',
          entityType: 'supplier',
          entityId: id,
          changes: diff({ code: before.code, name: before.name }, { code: null, name: null }),
        });
      });
    } catch (error) {
      if (SUPPLIER_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
        throw supplierInUse();
      }
      throw error;
    }
  }

  // The party stays, so no foreign key speaks up: what uses the supplier side is looked for here,
  // in one UNION ALL query like the customers' (the tables of SUPPLIER_IN_USE, and the payable
  // lines that name it; 17d adds its documents). A draft bill or payment counts too: it was
  // written for this supplier, and its supplier must stay one. The row is locked FOR UPDATE (lock()),
  // and every posting and every purchase order locks it FOR SHARE first (checkParties,
  // assertSupplier), so a line or an order written at the same moment is either seen here or
  // finds no supplier. A goods receipt needs an order of the supplier, which is found already. The supplier's own columns go back to their defaults in the same UPDATE
  // (parties_supplier_side_check), and its bank accounts go. The billing address is the party's,
  // and the customer keeps it.
  private async dropSupplierSide(tx: Transaction, party: PartyRow): Promise<void> {
    const tenantId = getTenantId();
    const documents = [purchaseOrders, goodsReceipts, bills, supplierPayments].map(
      (table) =>
        sql`SELECT 1 FROM ${table} WHERE tenant_id = ${tenantId}::uuid AND supplier_id = ${party.id}::uuid`,
    );
    const used = await tx.execute(sql`
      ${sql.join(documents, sql` UNION ALL `)}
      UNION ALL
      SELECT 1 FROM ${journalLines} l
        JOIN ${ledgerAccounts} a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE l.tenant_id = ${tenantId}::uuid AND l.party_id = ${party.id}::uuid
         AND a.purpose = 'accounts_payable'
      LIMIT 1`);
    if (used.length > 0) throw supplierInUse();
    await tx
      .update(parties)
      .set({
        isSupplier: false,
        supplierGroupId: null,
        supplierPaymentTermsDays: 0,
        version: sql`${parties.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, party.id)));
    await tx
      .delete(partyBankAccounts)
      .where(
        and(eq(partyBankAccounts.tenantId, tenantId), eq(partyBankAccounts.partyId, party.id)),
      );
  }

  // The columns the form sets, the same on create and update. The supplier's own group and terms;
  // the rest is the party's, shared with its customer side.
  private fields(input: SupplierInput) {
    return {
      name: input.name,
      supplierGroupId: input.groupId,
      contactPerson: input.contactPerson,
      phone: input.phone,
      email: input.email,
      documentLanguage: input.documentLanguage,
      bin: input.bin,
      supplierPaymentTermsDays: input.paymentTermsDays,
      notes: input.notes,
    };
  }

  // A code taken while we save, a group deleted while we save: the database's answers, put the
  // way the form shows them
  private mapSaveError(error: unknown): unknown {
    if (isUniqueViolation(error, 'parties_tenant_code_idx')) return codeTaken();
    if (isForeignKeyViolation(error, 'parties_supplier_group_fk')) {
      return fieldError('supplier_group_invalid', 'groupId');
    }
    return error;
  }

  // FOR SHARE: a group being deleted right now waits for us, or we wait for it and find it gone
  private async checkGroup(tx: Transaction, groupId: string | null): Promise<void> {
    if (groupId === null) return;
    const [group] = await tx
      .select({ id: supplierGroups.id })
      .from(supplierGroups)
      .where(and(eq(supplierGroups.tenantId, getTenantId()), eq(supplierGroups.id, groupId)))
      .for('share');
    if (!group) throw fieldError('supplier_group_invalid', 'groupId');
  }

  // Any party's code counts, a customer's too: one code is one party
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

  // The next free code from the 'purchase.supplier' series (S-00042), skipping one typed by hand
  private async newCode(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');
    for (;;) {
      const code = await this.numbering.next(tx, 'purchase.supplier', today);
      if (!(await this.codeUsed(tx, code, null))) return code;
    }
  }

  // The supplier's one address is the party's billing address (decision 9). The text is changed in
  // place, so the label and phone a customer page gave it stay; null removes it, from both sides.
  // The party row is locked, so nobody adds a second billing address meanwhile (and
  // party_addresses_billing_idx would refuse it anyway).
  private async saveAddress(tx: Transaction, partyId: string, address: string | null) {
    const tenantId = getTenantId();
    const billing = and(
      eq(partyAddresses.tenantId, tenantId),
      eq(partyAddresses.partyId, partyId),
      eq(partyAddresses.kind, 'billing'),
    );
    if (address === null) {
      await tx.delete(partyAddresses).where(billing);
      return;
    }
    const [current] = await tx
      .select({ id: partyAddresses.id })
      .from(partyAddresses)
      .where(billing);
    if (current) {
      await tx.update(partyAddresses).set({ address }).where(billing);
    } else {
      await tx
        .insert(partyAddresses)
        .values({ tenantId, partyId, kind: 'billing', position: 0, address });
    }
  }

  // The accounts sent replace the ones the supplier had. One sent back with its id is changed in
  // place, so its id stays (a payment in 17c points at it); an id that is not this supplier's is
  // added as a new account, never moved from another party. position = the form's order.
  private async saveBankAccounts(
    tx: Transaction,
    partyId: string,
    accounts: SupplierInput['bankAccounts'],
  ): Promise<void> {
    const tenantId = getTenantId();
    const ofParty = and(
      eq(partyBankAccounts.tenantId, tenantId),
      eq(partyBankAccounts.partyId, partyId),
    );
    const existing = await tx
      .select({ id: partyBankAccounts.id })
      .from(partyBankAccounts)
      .where(ofParty);
    const own = new Set(existing.map((row) => row.id));
    const rows = accounts.map((account, position) => ({
      id: account.id !== null && own.has(account.id) ? account.id : null,
      fields: {
        position,
        bankName: account.bankName,
        branchName: account.branchName,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        routingNumber: account.routingNumber,
      },
    }));
    const kept = rows.flatMap(({ id, fields }) => (id === null ? [] : [{ id, fields }]));
    await tx.delete(partyBankAccounts).where(
      kept.length === 0
        ? ofParty
        : and(
            ofParty,
            notInArray(
              partyBankAccounts.id,
              kept.map((row) => row.id),
            ),
          ),
    );
    for (const row of kept) {
      await tx
        .update(partyBankAccounts)
        .set(row.fields)
        .where(and(ofParty, eq(partyBankAccounts.id, row.id)));
    }
    const added = rows.flatMap(({ id, fields }) => (id === null ? [fields] : []));
    if (added.length > 0) {
      await tx
        .insert(partyBankAccounts)
        .values(added.map((fields) => ({ tenantId, partyId, ...fields })));
    }
  }

  private async lock(tx: Transaction, id: string): Promise<PartyRow> {
    const [row] = await tx
      .select()
      .from(parties)
      .where(
        and(eq(parties.tenantId, getTenantId()), eq(parties.id, id), eq(parties.isSupplier, true)),
      )
      .for('update');
    if (!row) throw notFound('Supplier');
    return row;
  }

  private async read(tx: Transaction, id: string, canSeeBalance: boolean): Promise<Supplier> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select({ party: parties, balance: canSeeBalance ? balance : sql<null>`NULL` })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, id), eq(parties.isSupplier, true)));
    if (!row) throw notFound('Supplier');
    const { party } = row;
    const [[address], accounts] = await Promise.all([
      tx
        .select({ address: partyAddresses.address })
        .from(partyAddresses)
        .where(
          and(
            eq(partyAddresses.tenantId, tenantId),
            eq(partyAddresses.partyId, id),
            eq(partyAddresses.kind, 'billing'),
          ),
        ),
      tx
        .select()
        .from(partyBankAccounts)
        .where(and(eq(partyBankAccounts.tenantId, tenantId), eq(partyBankAccounts.partyId, id)))
        .orderBy(asc(partyBankAccounts.position), asc(partyBankAccounts.id)),
    ]);
    return {
      id: party.id,
      code: party.code,
      name: party.name,
      groupId: party.supplierGroupId,
      contactPerson: party.contactPerson,
      phone: party.phone,
      email: party.email,
      documentLanguage: party.documentLanguage,
      bin: party.bin,
      paymentTermsDays: party.supplierPaymentTermsDays,
      address: address?.address ?? null,
      bankAccounts: accounts.map((account) => ({
        id: account.id,
        bankName: account.bankName,
        branchName: account.branchName,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        routingNumber: account.routingNumber,
      })),
      notes: party.notes,
      isCustomer: party.isCustomer,
      balance: row.balance,
      archivedAt: party.archivedAt?.toISOString() ?? null,
      version: party.version,
      updatedAt: party.updatedAt.toISOString(),
    };
  }

  private async snapshot(tx: Transaction, supplier: Supplier): Promise<Snapshot> {
    const [group] =
      supplier.groupId === null
        ? []
        : await tx
            .select({ name: supplierGroups.name })
            .from(supplierGroups)
            .where(
              and(
                eq(supplierGroups.tenantId, getTenantId()),
                eq(supplierGroups.id, supplier.groupId),
              ),
            );
    return {
      code: supplier.code,
      name: supplier.name,
      group: group?.name ?? null,
      phone: supplier.phone,
      bin: supplier.bin,
      paymentTermsDays: supplier.paymentTermsDays,
      address: supplier.address,
      bankAccounts:
        supplier.bankAccounts.length === 0
          ? null
          : supplier.bankAccounts
              .map((account) => `${account.bankName} …${account.accountNumber.slice(-4)}`)
              .join(', '),
    };
  }
}
