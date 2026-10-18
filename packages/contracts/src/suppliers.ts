import { z } from 'zod';

import { MAX_PAYMENT_TERMS_DAYS } from './customers.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { ledgerPageSchema, ledgerQuerySchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { LANGUAGE_CODES } from './preferences.js';
import { optionalCode } from './products.js';
import { binSchema, optionalEmailSchema } from './settings.js';
import { optionalIdSchema } from './stock.js';

// A supplier is a party, like a customer (step 15a): the same row in the parties table with
// is_supplier set. A distributor that both sells to the company and buys from it is one party with
// one code, and its customer and supplier pages edit the same name, phone and address.

// A company pays a supplier into one of a few accounts: a current account for cheques, another
// bank for BEFTN transfers
export const MAX_SUPPLIER_BANK_ACCOUNTS = 5;

// ---------------------------------------------------------------------------------------------
// What the API sends

// Where the company pays the supplier. The payment screen (step 17c) shows the first one.
export const supplierBankAccountSchema = z.object({
  id: z.uuid(),
  bankName: z.string(),
  // The bank's branch ("Motijheel"); null when the person did not type one
  branchName: z.string().nullable(),
  // The name on the account, which may differ from the supplier's trade name
  accountName: z.string(),
  accountNumber: z.string(),
  // The 9-digit BEFTN routing number of the branch; null when not typed
  routingNumber: z.string().nullable(),
});
export type SupplierBankAccount = z.infer<typeof supplierBankAccountSchema>;

export const supplierSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  // The supplier group, not the customer group: a party that is both has one of each
  groupId: z.uuid().nullable(),
  contactPerson: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  // The language of the purchase orders the supplier gets (step 17b), shared with the customer side
  documentLanguage: z.enum(LANGUAGE_CODES),
  bin: z.string().nullable(),
  // Days from a bill's date to its due date (step 17c). The supplier's own terms: a party that is
  // also a customer has separate customer terms.
  paymentTermsDays: z.number().int(),
  // The party's billing address: what a purchase order prints. null = none typed.
  address: z.string().nullable(),
  bankAccounts: z.array(supplierBankAccountSchema),
  notes: z.string().nullable(),
  // The same party is also a customer
  isCustomer: z.boolean(),
  // What the company owes the supplier now: credit minus debit of the payable lines that carry this
  // party. null when the person may not see balances (purchase.supplier.balance).
  balance: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Supplier = z.infer<typeof supplierSchema>;

// One row of the list: no bank accounts, address or notes
export const supplierSummarySchema = supplierSchema.pick({
  id: true,
  code: true,
  name: true,
  groupId: true,
  contactPerson: true,
  phone: true,
  paymentTermsDays: true,
  isCustomer: true,
  balance: true,
  archivedAt: true,
  updatedAt: true,
});
export type SupplierSummary = z.infer<typeof supplierSummarySchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// What a cheque book prints: "0123-4567890-01". Spaces and hyphens are dropped, so the same account
// typed two ways is one number.
const accountNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => /^\d{6,20}$/.test(value), errorCode('bank_account_number_format'));

const routingNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => value === '' || /^\d{9}$/.test(value), errorCode('routing_number_format'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

const supplierBankAccountInputSchema = z.object({
  // An existing account keeps its id: a payment (step 17c) remembers which account it went to
  id: z.uuid().nullable(),
  bankName: z.string().trim().min(2, errorCode('supplier_bank_name_required')).max(80),
  branchName: optionalText(80),
  accountName: z.string().trim().min(2, errorCode('supplier_account_name_required')).max(120),
  accountNumber: accountNumberSchema,
  routingNumber: routingNumberSchema,
});
export type SupplierBankAccountInput = z.input<typeof supplierBankAccountInputSchema>;

export const supplierInputSchema = z.object({
  // null = the next number from the 'purchase.supplier' series (S-00042)
  code: optionalCode('supplier_code_format'),
  name: z.string().trim().min(2, errorCode('supplier_name_required')).max(120),
  groupId: optionalIdSchema,
  contactPerson: optionalText(80),
  phone: optionalText(30),
  email: optionalEmailSchema,
  documentLanguage: z.enum(LANGUAGE_CODES),
  bin: binSchema,
  paymentTermsDays: z.number().int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
  address: optionalText(300),
  bankAccounts: z.array(supplierBankAccountInputSchema).max(MAX_SUPPLIER_BANK_ACCOUNTS),
  notes: optionalText(500),
});
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export type SupplierFormValues = z.input<typeof supplierInputSchema>;

export const updateSupplierInputSchema = supplierInputSchema.extend({ version: versionSchema });
export type UpdateSupplierInput = z.infer<typeof updateSupplierInputSchema>;

export const supplierVersionInputSchema = z.object({ version: versionSchema });

export const deleteSupplierQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// ---------------------------------------------------------------------------------------------
// The list

export const SUPPLIER_SORTS = ['name', '-name', 'code', '-code', '-updated'] as const;
export type SupplierSort = (typeof SUPPLIER_SORTS)[number];

export const SUPPLIER_STATUSES = ['active', 'archived'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const supplierListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code, the contact person or the phone number
  search: z.string().trim().max(100).optional(),
  groupId: z.uuid().optional(),
  status: z.enum(SUPPLIER_STATUSES).default('active'),
  sort: z.enum(SUPPLIER_SORTS).default('name'),
});
export type SupplierListQuery = z.input<typeof supplierListQuerySchema>;

export const supplierPageSchema = pageOf(supplierSummarySchema);
export type SupplierPage = z.infer<typeof supplierPageSchema>;

const supplierParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like customers: a requisition and a purchase order pick a supplier.
// The balance is shown only with purchase.supplier.balance, and the statement needs it too.
export const supplierRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/suppliers',
    summary: 'Suppliers, a page at a time, searched, filtered and sorted on the server',
    auth: 'bearer',
    status: 200,
    query: supplierListQuerySchema,
    response: supplierPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/suppliers/:id',
    summary: 'One supplier with its address and bank accounts',
    auth: 'bearer',
    status: 200,
    params: supplierParamsSchema,
    response: supplierSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/suppliers',
    summary: 'Add a supplier',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 201,
    body: supplierInputSchema,
    response: supplierSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/suppliers/:id',
    summary: 'Change a supplier: the bank accounts sent replace the ones it had',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: updateSupplierInputSchema,
    response: supplierSchema,
  }),
  // A customer the company starts buying from: the same party, now also a supplier, with the
  // supplier's own fields at their defaults (no group, terms 0, no bank account)
  fromCustomer: defineRoute({
    method: 'POST',
    path: '/customers/:id/make-supplier',
    summary: 'Make a customer a supplier too',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: supplierVersionInputSchema,
    response: supplierSchema,
  }),
  // Archived = the party: a party that is also a customer is hidden from sales documents too
  archive: defineRoute({
    method: 'POST',
    path: '/suppliers/:id/archive',
    summary: 'Hide a supplier from new documents; its history and balance stay',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: supplierVersionInputSchema,
    response: supplierSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/suppliers/:id/restore',
    summary: 'Bring an archived supplier back',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierParamsSchema,
    body: supplierVersionInputSchema,
    response: supplierSchema,
  }),
  // A supplier that is also a customer stays as a customer: only the supplier side goes
  remove: defineRoute({
    method: 'DELETE',
    path: '/suppliers/:id',
    summary: 'Delete a supplier that no entry or document uses yet',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 204,
    params: supplierParamsSchema,
    query: deleteSupplierQuerySchema,
    response: z.void(),
  }),
  // The payable lines of this supplier, like a customer's statement. Credit = the company owes more.
  statement: defineRoute({
    method: 'GET',
    path: '/suppliers/:id/statement',
    summary: "A supplier's posted payable lines in date order, with the running balance",
    auth: 'bearer',
    permission: 'purchase.supplier.balance',
    status: 200,
    params: supplierParamsSchema,
    query: ledgerQuerySchema,
    response: ledgerPageSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Supplier groups: Local, Importer, Raw material, Packaging — for filtering the list

export const supplierGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  // Archived suppliers count too: a group that holds any supplier cannot be deleted
  supplierCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type SupplierGroup = z.infer<typeof supplierGroupSchema>;

export const supplierGroupInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('supplier_group_name_required')).max(60),
});
export type SupplierGroupInput = z.infer<typeof supplierGroupInputSchema>;

export const updateSupplierGroupInputSchema = supplierGroupInputSchema.extend({
  version: versionSchema,
});

export const deleteSupplierGroupQuerySchema = deleteSupplierQuerySchema;

// A handful of groups: the whole list at once
export const supplierGroupListSchema = z.object({ items: z.array(supplierGroupSchema) });

const supplierGroupParamsSchema = z.object({ id: z.uuid() });

export const supplierGroupRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/supplier-groups',
    summary: 'The supplier groups of the workspace',
    auth: 'bearer',
    status: 200,
    response: supplierGroupListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/supplier-groups',
    summary: 'Add a supplier group',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 201,
    body: supplierGroupInputSchema,
    response: supplierGroupSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/supplier-groups/:id',
    summary: 'Rename a supplier group',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 200,
    params: supplierGroupParamsSchema,
    body: updateSupplierGroupInputSchema,
    response: supplierGroupSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/supplier-groups/:id',
    summary: 'Delete a supplier group that holds no supplier',
    auth: 'bearer',
    permission: 'purchase.supplier.manage',
    status: 204,
    params: supplierGroupParamsSchema,
    query: deleteSupplierGroupQuerySchema,
    response: z.void(),
  }),
};
