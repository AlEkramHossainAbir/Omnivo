import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { ledgerPageSchema, ledgerQuerySchema } from './journal.js';
import { priceSchema } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { optionalCode } from './products.js';
import { binSchema, optionalEmailSchema } from './settings.js';

// A customer is a party: one row in the parties table, which step 17 also uses for suppliers. A
// distributor that both buys from a company and sells to it is one party with one statement, not
// two records that have to be netted by hand.

export const ADDRESS_KINDS = ['billing', 'shipping'] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

// The longest payment term a form accepts: a year. Garments buyers pay at 90–120 days.
export const MAX_PAYMENT_TERMS_DAYS = 365;

// A dealer with depots in a few districts, a pharmacy chain with its outlets
export const MAX_CUSTOMER_ADDRESSES = 20;

// ---------------------------------------------------------------------------------------------
// What the API sends

export const customerAddressSchema = z.object({
  id: z.uuid(),
  // z.string(), not the enum: the rule of account purposes and error codes
  kind: z.string(),
  // "Mirpur depot", "Head office"; null for a customer with one address
  label: z.string().nullable(),
  address: z.string(),
  // The phone at that address (the depot's store keeper), when it is not the customer's own
  phone: z.string().nullable(),
});
export type CustomerAddress = z.infer<typeof customerAddressSchema>;

export const customerSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  groupId: z.uuid().nullable(),
  contactPerson: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  // The customer's VAT registration number: printed on the VAT invoice (Mushak 6.3)
  bin: z.string().nullable(),
  // Days from the invoice date to its due date. 0 = due on receipt.
  paymentTermsDays: z.number().int(),
  // The most the customer may owe, a decimal string. null = no limit; "0.0000" = cash only.
  creditLimit: z.string().nullable(),
  // null = the products' own sale prices
  priceListId: z.uuid().nullable(),
  notes: z.string().nullable(),
  // The billing address first (if there is one), then the shipping addresses in the order the
  // person put them. The first shipping address is the default on a delivery.
  addresses: z.array(customerAddressSchema),
  // The same party is also a supplier (step 17)
  isSupplier: z.boolean(),
  // What the customer owes now: debit minus credit of the receivable lines that carry this party.
  // null when the person may not see balances (sales.customer.balance).
  balance: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

// One row of the list: no addresses or notes — a page of 50 stays small
export const customerSummarySchema = customerSchema.pick({
  id: true,
  code: true,
  name: true,
  groupId: true,
  contactPerson: true,
  phone: true,
  paymentTermsDays: true,
  creditLimit: true,
  balance: true,
  archivedAt: true,
  updatedAt: true,
});
export type CustomerSummary = z.infer<typeof customerSummarySchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// The form's "None" options send '' for "not chosen"
const optionalIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

const customerAddressInputSchema = z.object({
  // An existing address keeps its id: a delivery (step 15b) points at the address it went to
  id: z.uuid().nullable(),
  kind: z.enum(ADDRESS_KINDS),
  label: optionalText(60),
  address: z.string().trim().min(5, errorCode('customer_address_required')).max(300),
  phone: optionalText(30),
});
export type CustomerAddressInput = z.input<typeof customerAddressInputSchema>;

export const customerInputSchema = z
  .object({
    // null = the next number from the 'sales.customer' series (C-00042)
    code: optionalCode('customer_code_format'),
    name: z.string().trim().min(2, errorCode('customer_name_required')).max(120),
    groupId: optionalIdSchema,
    contactPerson: optionalText(80),
    phone: optionalText(30),
    email: optionalEmailSchema,
    bin: binSchema,
    paymentTermsDays: z.number().int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
    // '' = no limit, like a product's empty sale price: "0" is a real limit (cash only)
    creditLimit: priceSchema,
    priceListId: optionalIdSchema,
    notes: optionalText(500),
    addresses: z.array(customerAddressInputSchema).max(MAX_CUSTOMER_ADDRESSES),
  })
  // One billing address: the invoice prints exactly one. The error sits on the second one, the
  // one to change.
  .superRefine((input, ctx) => {
    let billing = 0;
    input.addresses.forEach((address, index) => {
      if (address.kind !== 'billing') return;
      billing += 1;
      if (billing > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['addresses', index, 'kind'],
          message: errorCode('customer_billing_twice'),
        });
      }
    });
  });
export type CustomerInput = z.infer<typeof customerInputSchema>;
export type CustomerFormValues = z.input<typeof customerInputSchema>;

export const updateCustomerInputSchema = customerInputSchema.safeExtend({
  version: versionSchema,
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerInputSchema>;

export const customerVersionInputSchema = z.object({ version: versionSchema });

export const deleteCustomerQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// ---------------------------------------------------------------------------------------------
// The list

export const CUSTOMER_SORTS = ['name', '-name', 'code', '-code', '-updated'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const CUSTOMER_STATUSES = ['active', 'archived'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const customerListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code, the contact person or the phone number
  search: z.string().trim().max(100).optional(),
  groupId: z.uuid().optional(),
  status: z.enum(CUSTOMER_STATUSES).default('active'),
  sort: z.enum(CUSTOMER_SORTS).default('name'),
});
export type CustomerListQuery = z.input<typeof customerListQuerySchema>;

export const customerPageSchema = pageOf(customerSummarySchema);
export type CustomerPage = z.infer<typeof customerPageSchema>;

const customerParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like products: every sales document picks a customer. The balance
// inside a customer is shown only with sales.customer.balance (null otherwise), and the statement
// needs it too: what a customer owes is not every cashier's business.
export const customerRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/customers',
    summary: 'Customers, a page at a time, searched, filtered and sorted on the server',
    auth: 'bearer',
    status: 200,
    query: customerListQuerySchema,
    response: customerPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/customers/:id',
    summary: 'One customer with its addresses',
    auth: 'bearer',
    status: 200,
    params: customerParamsSchema,
    response: customerSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/customers',
    summary: 'Add a customer',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 201,
    body: customerInputSchema,
    response: customerSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/customers/:id',
    summary: 'Change a customer: the addresses sent replace the ones it had',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerParamsSchema,
    body: updateCustomerInputSchema,
    response: customerSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/customers/:id/archive',
    summary: 'Hide a customer from new documents; its history and balance stay',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerParamsSchema,
    body: customerVersionInputSchema,
    response: customerSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/customers/:id/restore',
    summary: 'Bring an archived customer back',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerParamsSchema,
    body: customerVersionInputSchema,
    response: customerSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/customers/:id',
    summary: 'Delete a customer that no entry or document uses yet',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 204,
    params: customerParamsSchema,
    query: deleteCustomerQuerySchema,
    response: z.void(),
  }),
  // The receivable lines of this customer, like an account's ledger: opening balance, the lines in
  // date order with a running balance, closing balance. Debit = the customer owes more.
  statement: defineRoute({
    method: 'GET',
    path: '/customers/:id/statement',
    summary: "A customer's posted receivable lines in date order, with the running balance",
    auth: 'bearer',
    permission: 'sales.customer.balance',
    status: 200,
    params: customerParamsSchema,
    query: ledgerQuerySchema,
    response: ledgerPageSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Customer groups: Dealer, Retailer, Corporate — for filtering the list and, later, the reports

export const customerGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  // Archived customers count too: a group that holds any customer cannot be deleted
  customerCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type CustomerGroup = z.infer<typeof customerGroupSchema>;

export const customerGroupInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('customer_group_name_required')).max(60),
});
export type CustomerGroupInput = z.infer<typeof customerGroupInputSchema>;

export const updateCustomerGroupInputSchema = customerGroupInputSchema.extend({
  version: versionSchema,
});

export const deleteCustomerGroupQuerySchema = deleteCustomerQuerySchema;

// A handful of groups: the whole list at once
export const customerGroupListSchema = z.object({ items: z.array(customerGroupSchema) });

const customerGroupParamsSchema = z.object({ id: z.uuid() });

export const customerGroupRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/customer-groups',
    summary: 'The customer groups of the workspace',
    auth: 'bearer',
    status: 200,
    response: customerGroupListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/customer-groups',
    summary: 'Add a customer group',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 201,
    body: customerGroupInputSchema,
    response: customerGroupSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/customer-groups/:id',
    summary: 'Rename a customer group',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 200,
    params: customerGroupParamsSchema,
    body: updateCustomerGroupInputSchema,
    response: customerGroupSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/customer-groups/:id',
    summary: 'Delete a customer group that holds no customer',
    auth: 'bearer',
    permission: 'sales.customer.manage',
    status: 204,
    params: customerGroupParamsSchema,
    query: deleteCustomerGroupQuerySchema,
    response: z.void(),
  }),
};
