import { ADDRESS_KINDS, LANGUAGE_CODES } from '@omnivo/contracts';
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

// Step 17a: the same for suppliers (Fabric mills, Accessories, Packaging). A table of its own and
// not a kind column on customer_groups: the two lists are managed on different pages, by people
// with different permissions, and a group of one side must never be offered on the other.
export const supplierGroups = pgTable(
  'supplier_groups',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
  },
  (table) => [
    uniqueIndex('supplier_groups_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    uniqueIndex('supplier_groups_tenant_id_idx').on(table.tenantId, table.id),
  ],
);

// Everyone the company trades with on credit (step 15a): customers, and suppliers from step 17a.
// One row per business, so a distributor that is both has one code and one statement. The name,
// contact, phone, email, BIN, language and addresses are the party's; the group, the terms (and a
// customer's limit and price list) belong to one side, and stay empty while the party is not on it.
// deleted_at is not used: a party is deleted for real (only while nothing uses it) or archived.
export const parties = pgTable(
  'parties',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // C-00042 from the 'sales.customer' series, S-00042 from 'purchase.supplier', or the
    // company's own. A party that becomes both keeps the code it was made with.
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
    // Days from an invoice to its due date (step 15c). The customer's terms.
    paymentTermsDays: smallint('payment_terms_days').notNull().default(0),
    // NULL = no limit; 0 = cash only. NUMERIC(19,4) like every amount.
    creditLimit: numeric('credit_limit', { precision: 19, scale: 4 }),
    // NULL = the products' own sale prices
    priceListId: uuid('price_list_id'),
    // Step 16: the language of the PDFs, emails and links this party gets. The default fills the
    // parties that already exist.
    documentLanguage: text('document_language', { enum: LANGUAGE_CODES }).notNull().default('en'),
    // Step 17a: the supplier's side. Its terms are what the supplier gives the company, often not
    // what the company gives the same party as a customer, so they are a column of their own.
    supplierGroupId: uuid('supplier_group_id'),
    supplierPaymentTermsDays: smallint('supplier_payment_terms_days').notNull().default(0),
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
    // The same two orders for the supplier list (step 17a)
    index('parties_supplier_name_idx')
      .on(table.tenantId, sql`lower(${table.name})`, table.id)
      .where(sql`${table.isSupplier}`),
    index('parties_supplier_updated_idx')
      .on(table.tenantId, table.updatedAt, table.id)
      .where(sql`${table.isSupplier}`),
    // A group's customers (the filter, customerCount), and the FK's check when a group is deleted
    index('parties_tenant_group_idx').on(table.tenantId, table.customerGroupId),
    index('parties_tenant_supplier_group_idx').on(table.tenantId, table.supplierGroupId),
    index('parties_tenant_price_list_idx').on(table.tenantId, table.priceListId),
    // No ON DELETE: a group that still holds a customer cannot be deleted (customer_group_in_use)
    foreignKey({
      name: 'parties_customer_group_fk',
      columns: [table.tenantId, table.customerGroupId],
      foreignColumns: [customerGroups.tenantId, customerGroups.id],
    }),
    // The same for supplier groups: supplier_group_in_use
    foreignKey({
      name: 'parties_supplier_group_fk',
      columns: [table.tenantId, table.supplierGroupId],
      foreignColumns: [supplierGroups.tenantId, supplierGroups.id],
    }),
    foreignKey({
      name: 'parties_price_list_fk',
      columns: [table.tenantId, table.priceListId],
      foreignColumns: [priceLists.tenantId, priceLists.id],
    }),
    check('parties_role_check', sql`${table.isCustomer} OR ${table.isSupplier}`),
    // 365 = the contract's MAX_PAYMENT_TERMS_DAYS
    check(
      'parties_terms_check',
      sql`${table.paymentTermsDays} BETWEEN 0 AND 365 AND ${table.supplierPaymentTermsDays} BETWEEN 0 AND 365`,
    ),
    // A side the party is not on keeps its defaults. Removing the customer side of a party that is
    // both (step 17a) must clear it, so "Make customer too" later starts fresh (decision 10), and
    // a customer group never counts, nor blocks, a party that is no longer a customer.
    check(
      'parties_customer_side_check',
      sql`${table.isCustomer} OR (${table.customerGroupId} IS NULL AND ${table.paymentTermsDays} = 0 AND ${table.creditLimit} IS NULL AND ${table.priceListId} IS NULL)`,
    ),
    check(
      'parties_supplier_side_check',
      sql`${table.isSupplier} OR (${table.supplierGroupId} IS NULL AND ${table.supplierPaymentTermsDays} = 0)`,
    ),
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

// Step 17a: the bank accounts a supplier is paid into (decision 8). The payment screen (17c) shows
// them, so a cashier copies the number from the system and not from an old invoice. Rows of their
// own, like the addresses: 17c's payment may point at the one it was sent to.
// Bangladesh needs no IBAN or SWIFT here: a local transfer (BEFTN, RTGS) takes the account number
// and the branch's 9-digit routing number.
export const partyBankAccounts = pgTable(
  'party_bank_accounts',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    partyId: uuid('party_id').notNull(),
    // The order the form shows them in, from 0; the first is the one a payment suggests
    position: smallint('position').notNull(),
    bankName: text('bank_name').notNull(),
    branchName: text('branch_name'),
    // As the bank has it, which is often not the trading name
    accountName: text('account_name').notNull(),
    // Digits only, as the contract cleaned them (spaces and dashes removed)
    accountNumber: text('account_number').notNull(),
    routingNumber: text('routing_number'),
  },
  (table) => [
    // A party's accounts, and the target of a later FK: an account of THIS supplier
    uniqueIndex('party_bank_accounts_party_id_idx').on(table.tenantId, table.partyId, table.id),
    foreignKey({
      name: 'party_bank_accounts_party_fk',
      columns: [table.tenantId, table.partyId],
      foreignColumns: [parties.tenantId, parties.id],
    }).onDelete('cascade'),
    // The contract's formats again, so a row written by other code is still a usable account
    check(
      'party_bank_accounts_number_check',
      sql`${table.accountNumber} ~ '^[0-9]{6,20}$' AND (${table.routingNumber} IS NULL OR ${table.routingNumber} ~ '^[0-9]{9}$')`,
    ),
  ],
);
