import { Inject, Injectable } from '@nestjs/common';
import {
  type Customer,
  type CustomerInput,
  type CustomerPage,
  type CustomerSort,
  type ErrorCode,
  todayIn,
  type UpdateCustomerInput,
} from '@omnivo/contracts';
import {
  customerGroups,
  journalEntries,
  journalLines,
  ledgerAccounts,
  parties,
  partyAddresses,
  priceLists,
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
import { BalanceAccess } from './balance-access.js';

type PartyRow = typeof parties.$inferSelect;

// What a customer owes: debit − credit of the posted receivable lines that name it. A correlated
// subquery on the parties row it is selected with, run for the rows of one page only;
// journal_lines_tenant_party_idx finds the lines. Drafts are left out: they are not in the books.
// The account filter keeps a supplier's payable lines out from step 17 on.
// The outer table by its name, like the stock documents' line count (step 14): in a select from
// one table, Drizzle prints ${parties.id} as a bare "id", which here is ambiguous.
const balance = sql<string>`(
  SELECT round(coalesce(sum(l.debit - l.credit), 0), 4)::text
    FROM ${journalLines} l
    JOIN ${journalEntries} e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
    JOIN ${ledgerAccounts} a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
   WHERE l.tenant_id = parties.tenant_id AND l.party_id = parties.id
     AND e.status = 'posted' AND a.purpose = 'accounts_receivable'
)`;

// The list's orders: one key and then the id, so a cursor says exactly where the next page starts.
// Each has an index: parties_customer_name_idx, parties_tenant_code_idx, parties_customer_updated_idx.
const ORDERS = {
  name: { key: sql`lower(${parties.name})`, desc: false },
  '-name': { key: sql`lower(${parties.name})`, desc: true },
  code: { key: sql`lower(${parties.code})`, desc: false },
  '-code': { key: sql`lower(${parties.code})`, desc: true },
  '-updated': { key: sql`${parties.updatedAt}`, desc: true },
} satisfies Record<CustomerSort, { key: SQL; desc: boolean }>;

// The sort key as text: updated_at::text keeps the microseconds, which a JavaScript Date would
// round away (a cursor a few microseconds off skips or repeats a row)
const cursorSchema = z.tuple([z.string(), z.uuid()]);

// What the audit log shows of a customer: what a person would recognise, not ids
interface Snapshot {
  [field: string]: string | number | null;
  code: string;
  name: string;
  group: string | null;
  phone: string | null;
  bin: string | null;
  paymentTermsDays: number;
  creditLimit: string | null;
  priceList: string | null;
  addresses: number;
}

function codeTaken(): AppError {
  return new AppError(409, 'customer_code_taken', 'Another customer uses this code.', {
    fieldErrors: { code: ['customer_code_taken'] },
  });
}

function fieldError(code: ErrorCode, field: string): AppError {
  return new AppError(400, code, 'Check the highlighted fields and try again.', {
    fieldErrors: { [field]: [code] },
  });
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly access: BalanceAccess,
  ) {}

  async list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    groupId?: string | undefined;
    status: 'active' | 'archived';
    sort: CustomerSort;
  }): Promise<CustomerPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const order = ORDERS[query.sort];
    const canSeeBalance = await this.access.canSee();
    const conditions: (SQL | undefined)[] = [
      eq(parties.tenantId, tenantId),
      eq(parties.isCustomer, true),
      query.status === 'active'
        ? isNull(parties.archivedAt)
        : sql`${parties.archivedAt} IS NOT NULL`,
      query.groupId === undefined ? undefined : eq(parties.customerGroupId, query.groupId),
    ];
    if (query.search !== undefined && query.search !== '') {
      const pattern = containsPattern(query.search);
      // The four trigram indexes of migration 0026. The phone is matched as typed: digits have no
      // case, and "1711" finds 01711-234567.
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
          // Not even worked out without the permission: it is not just hidden, it is not read
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
          groupId: row.party.customerGroupId,
          contactPerson: row.party.contactPerson,
          phone: row.party.phone,
          paymentTermsDays: row.party.paymentTermsDays,
          creditLimit: row.party.creditLimit,
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

  async get(id: string): Promise<Customer> {
    const canSeeBalance = await this.access.canSee();
    return this.withTenant((tx) => this.read(tx, id, canSeeBalance));
  }

  async create(input: CustomerInput): Promise<Customer> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        await this.checkLinks(tx, input, null);
        const code = input.code ?? (await this.newCode(tx));
        if (await this.codeUsed(tx, code, null)) throw codeTaken();
        const [row] = await tx
          .insert(parties)
          .values({
            tenantId: getTenantId(),
            code,
            isCustomer: true,
            ...this.fields(input),
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning({ id: parties.id });
        if (!row) throw new Error('Customer insert returned no row');
        await this.saveAddresses(tx, row.id, input.addresses);
        const customer = await this.read(tx, row.id, canSeeBalance);
        await audit(tx, {
          action: 'customer.created',
          entityType: 'customer',
          entityId: row.id,
          changes: created(await this.snapshot(tx, customer)),
        });
        return customer;
      });
    } catch (error) {
      // Two saves with the same code at the same moment: both passed codeUsed()
      if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateCustomerInput): Promise<Customer> {
    const canSeeBalance = await this.access.canSee();
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await this.checkLinks(tx, input, before);
        const old = await this.read(tx, id, canSeeBalance);
        // An empty code keeps the one it has, like a product's
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
        await this.saveAddresses(tx, id, input.addresses);
        const customer = await this.read(tx, id, canSeeBalance);
        await audit(tx, {
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, customer)),
        });
        return customer;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'parties_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  // Archived: hidden from new documents. Its entries, its balance and its statement stay; a
  // customer who still owes money can be archived, and the money is still owed.
  async setArchived(id: string, version: number, archived: boolean): Promise<Customer> {
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
          action: archived ? 'customer.archived' : 'customer.restored',
          entityType: 'customer',
          entityId: id,
        });
      }
      return this.read(tx, id, canSeeBalance);
    });
  }

  // Only a customer nothing uses yet: one added by mistake. Step 17 will keep a party that is also
  // a supplier, as a supplier.
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        // Its addresses go with it (ON DELETE CASCADE)
        await tx
          .delete(parties)
          .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
        await audit(tx, {
          action: 'customer.deleted',
          entityType: 'customer',
          entityId: id,
          changes: diff({ code: before.code, name: before.name }, { code: null, name: null }),
        });
      });
    } catch (error) {
      // No "is it used?" query first: the FK is the check. Step 15b adds the sales documents' FKs.
      if (isForeignKeyViolation(error, 'journal_lines_party_fk')) {
        throw new AppError(
          409,
          'customer_in_use',
          'This customer has entries. Archive it instead.',
        );
      }
      throw error;
    }
  }

  // The columns the form sets, the same on create and update
  private fields(input: CustomerInput) {
    return {
      name: input.name,
      customerGroupId: input.groupId,
      contactPerson: input.contactPerson,
      phone: input.phone,
      email: input.email,
      bin: input.bin,
      paymentTermsDays: input.paymentTermsDays,
      creditLimit: input.creditLimit,
      priceListId: input.priceListId,
      notes: input.notes,
    };
  }

  // The group must exist; the price list must exist and be in use. A customer whose list was
  // archived since keeps it on a save (like a product's archived unit): its prices fall back to
  // the products' own until the list is restored (step 15b).
  private async checkLinks(tx: Transaction, input: CustomerInput, before: PartyRow | null) {
    const tenantId = getTenantId();
    if (input.groupId !== null) {
      const [group] = await tx
        .select({ id: customerGroups.id })
        .from(customerGroups)
        .where(and(eq(customerGroups.tenantId, tenantId), eq(customerGroups.id, input.groupId)))
        // A group being deleted right now waits for us, or we wait for it and find it gone
        .for('share');
      if (!group) throw fieldError('customer_group_invalid', 'groupId');
    }
    if (input.priceListId !== null) {
      const [list] = await tx
        .select({ archivedAt: priceLists.archivedAt })
        .from(priceLists)
        .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, input.priceListId)));
      const kept = before?.priceListId === input.priceListId;
      if (!list || (list.archivedAt !== null && !kept)) {
        throw fieldError('price_list_invalid', 'priceListId');
      }
    }
  }

  // Any party's code counts (a supplier's too, from step 17): one code is one party
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

  // The next free code from the 'sales.customer' series (C-00042). A number someone already typed
  // by hand is skipped, not refused — like product codes.
  private async newCode(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');
    for (;;) {
      const code = await this.numbering.next(tx, 'sales.customer', today);
      if (!(await this.codeUsed(tx, code, null))) return code;
    }
  }

  // The addresses sent replace the ones the customer had. An address sent back with its id is
  // changed in place, so its id stays (a delivery in step 15b points at it); one whose id is not
  // this customer's — another customer's, or made up — is added as a new address, never moved.
  // The order matters because of party_addresses_billing_idx, checked on every row: first the
  // removed ones go, then the kept ones that are no longer billing are changed, then the one that
  // is billing now, and last the new ones. At no moment are there two billing addresses.
  private async saveAddresses(
    tx: Transaction,
    partyId: string,
    addresses: CustomerInput['addresses'],
  ): Promise<void> {
    const tenantId = getTenantId();
    const ofParty = and(eq(partyAddresses.tenantId, tenantId), eq(partyAddresses.partyId, partyId));
    const existing = await tx.select({ id: partyAddresses.id }).from(partyAddresses).where(ofParty);
    const own = new Set(existing.map((row) => row.id));
    const rows = addresses.map((address, position) => ({
      id: address.id !== null && own.has(address.id) ? address.id : null,
      fields: {
        kind: address.kind,
        position,
        label: address.label,
        address: address.address,
        phone: address.phone,
      },
    }));
    const kept = rows.flatMap(({ id, fields }) => (id === null ? [] : [{ id, fields }]));
    await tx.delete(partyAddresses).where(
      kept.length === 0
        ? ofParty
        : and(
            ofParty,
            notInArray(
              partyAddresses.id,
              kept.map((row) => row.id),
            ),
          ),
    );
    const billingLast = [
      ...kept.filter((row) => row.fields.kind !== 'billing'),
      ...kept.filter((row) => row.fields.kind === 'billing'),
    ];
    for (const row of billingLast) {
      await tx
        .update(partyAddresses)
        .set(row.fields)
        .where(and(ofParty, eq(partyAddresses.id, row.id)));
    }
    const added = rows.flatMap(({ id, fields }) => (id === null ? [fields] : []));
    if (added.length > 0) {
      await tx
        .insert(partyAddresses)
        .values(added.map((fields) => ({ tenantId, partyId, ...fields })));
    }
  }

  private async lock(tx: Transaction, id: string): Promise<PartyRow> {
    const [row] = await tx
      .select()
      .from(parties)
      .where(
        and(eq(parties.tenantId, getTenantId()), eq(parties.id, id), eq(parties.isCustomer, true)),
      )
      .for('update');
    if (!row) throw notFound('Customer');
    return row;
  }

  private async read(tx: Transaction, id: string, canSeeBalance: boolean): Promise<Customer> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select({ party: parties, balance: canSeeBalance ? balance : sql<null>`NULL` })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.id, id), eq(parties.isCustomer, true)));
    if (!row) throw notFound('Customer');
    const { party } = row;
    const addresses = await tx
      .select()
      .from(partyAddresses)
      .where(and(eq(partyAddresses.tenantId, tenantId), eq(partyAddresses.partyId, id)))
      // The billing address first, then the shipping ones in the order the person put them
      .orderBy(sql`${partyAddresses.kind} = 'billing' DESC`, asc(partyAddresses.position));
    return {
      id: party.id,
      code: party.code,
      name: party.name,
      groupId: party.customerGroupId,
      contactPerson: party.contactPerson,
      phone: party.phone,
      email: party.email,
      bin: party.bin,
      paymentTermsDays: party.paymentTermsDays,
      creditLimit: party.creditLimit,
      priceListId: party.priceListId,
      notes: party.notes,
      addresses: addresses.map((address) => ({
        id: address.id,
        kind: address.kind,
        label: address.label,
        address: address.address,
        phone: address.phone,
      })),
      isSupplier: party.isSupplier,
      balance: row.balance,
      archivedAt: party.archivedAt?.toISOString() ?? null,
      version: party.version,
      updatedAt: party.updatedAt.toISOString(),
    };
  }

  private async snapshot(tx: Transaction, customer: Customer): Promise<Snapshot> {
    const tenantId = getTenantId();
    const [[group], [list]] = await Promise.all([
      customer.groupId === null
        ? [undefined]
        : tx
            .select({ name: customerGroups.name })
            .from(customerGroups)
            .where(
              and(eq(customerGroups.tenantId, tenantId), eq(customerGroups.id, customer.groupId)),
            ),
      customer.priceListId === null
        ? [undefined]
        : tx
            .select({ name: priceLists.name })
            .from(priceLists)
            .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, customer.priceListId))),
    ]);
    return {
      code: customer.code,
      name: customer.name,
      group: group?.name ?? null,
      phone: customer.phone,
      bin: customer.bin,
      paymentTermsDays: customer.paymentTermsDays,
      creditLimit: customer.creditLimit,
      priceList: list?.name ?? null,
      addresses: customer.addresses.length,
    };
  }
}
