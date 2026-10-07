import { ADDRESS_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { priceLists } from './price-lists.js';
import { tenants } from './tenants.js';

// Dealer, Retailer, Corporate: a label for filtering customers. Customer groups and not party
// groups: a party that is both has one group as a customer and (step 17) another as a supplier.
// deleted_at is not used: a group is deleted for real, only while no customer is in it.
export const customerGroups = pgTable(
  'customer_groups',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
  },
  (table) => [
    uniqueIndex('customer_groups_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    uniqueIndex('customer_groups_tenant_id_idx').on(table.tenantId, table.id),
  ],
);

// Everyone the company trades with on credit (step 15a): customers now, suppliers from step 17.
// One row per business, so a distributor that is both has one code and one statement. The
// customer's columns (group, terms, limit, price list) mean nothing for a supplier-only party.
// deleted_at is not used: a party is deleted for real (only while nothing uses it) or archived.
export const parties = pgTable(
  'parties',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // C-00042 from the 'sales.customer' series, or the company's own
    code: text('code').notNull(),
    name: text('name').notNull(),
    isCustomer: boolean('is_customer').notNull().default(false),
    isSupplier: boolean('is_supplier').notNull().default(false),
    customerGroupId: uuid('customer_group_id'),
    contactPerson: text('contact_person'),
    phone: text('phone'),
    email: text('email'),
    // 13 digits, cleaned by the contract's binSchema
    bin: text('bin'),
    // Days from an invoice to its due date (step 15c)
    paymentTermsDays: smallint('payment_terms_days').notNull().default(0),
    // NULL = no limit; 0 = cash only. NUMERIC(19,4) like every amount.
    creditLimit: numeric('credit_limit', { precision: 19, scale: 4 }),
    // NULL = the products' own sale prices
    priceListId: uuid('price_list_id'),
    notes: text('notes'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // One code means one party, in any case, whether customer or supplier
    uniqueIndex('parties_tenant_code_idx').on(table.tenantId, sql`lower(${table.code})`),
    // The target of the composite FKs from addresses and journal lines
    uniqueIndex('parties_tenant_id_idx').on(table.tenantId, table.id),
    // The customer list's keyset orders: by name, and by last change. By code uses the index
    // above. Partial: suppliers (step 17) never appear in the customer list.
    index('parties_customer_name_idx')
      .on(table.tenantId, sql`lower(${table.name})`, table.id)
      .where(sql`${table.isCustomer}`),
    index('parties_customer_updated_idx')
      .on(table.tenantId, table.updatedAt, table.id)
      .where(sql`${table.isCustomer}`),
    // A group's customers (the filter, customerCount), and the FK's check when a group is deleted
    index('parties_tenant_group_idx').on(table.tenantId, table.customerGroupId),
    index('parties_tenant_price_list_idx').on(table.tenantId, table.priceListId),
    // No ON DELETE: a group that still holds a customer cannot be deleted (customer_group_in_use)
    foreignKey({
      name: 'parties_customer_group_fk',
      columns: [table.tenantId, table.customerGroupId],
      foreignColumns: [customerGroups.tenantId, customerGroups.id],
    }),
    foreignKey({
      name: 'parties_price_list_fk',
      columns: [table.tenantId, table.priceListId],
      foreignColumns: [priceLists.tenantId, priceLists.id],
    }),
    check('parties_role_check', sql`${table.isCustomer} OR ${table.isSupplier}`),
    // 365 = the contract's MAX_PAYMENT_TERMS_DAYS
    check('parties_terms_check', sql`${table.paymentTermsDays} BETWEEN 0 AND 365`),
    check(
      'parties_credit_limit_check',
      sql`${table.creditLimit} IS NULL OR ${table.creditLimit} >= 0`,
    ),
  ],
);

// A party's addresses: at most one billing address (the one the invoice prints) and any number
// of shipping addresses (depots, outlets). Rows of their own and not a JSON list, because from
// step 15b a delivery points at the address it went to.
export const partyAddresses = pgTable(
  'party_addresses',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    partyId: uuid('party_id').notNull(),
    kind: text('kind', { enum: ADDRESS_KINDS }).notNull(),
    // The order the form shows them in; the first shipping address is the default on a delivery
    position: smallint('position').notNull(),
    label: text('label'),
    address: text('address').notNull(),
    phone: text('phone'),
  },
  (table) => [
    // A party's addresses, and the target of 15b's FK: an address of THIS customer
    uniqueIndex('party_addresses_party_id_idx').on(table.tenantId, table.partyId, table.id),
    // One billing address per party, whatever the code does
    uniqueIndex('party_addresses_billing_idx')
      .on(table.tenantId, table.partyId)
      .where(sql`${table.kind} = 'billing'`),
    // Deleting a party (only while nothing uses it) deletes its addresses
    foreignKey({
      name: 'party_addresses_party_fk',
      columns: [table.tenantId, table.partyId],
      foreignColumns: [parties.tenantId, parties.id],
    }).onDelete('cascade'),
  ],
);
