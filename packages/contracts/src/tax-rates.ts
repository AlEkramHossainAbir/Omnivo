import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// The four kinds of sale the VAT return (Mushak 9.1) counts apart. standard: 15%. reduced: a lower
// rate set by the NBR (10%, 7.5%, 5%). zero_rated: taxable at 0% (exports), so input VAT can still
// be claimed. exempt: outside VAT (rice, medicine in some cases), no input VAT. The last two are both
// 0%, but the return needs to know which one a sale was, so they are kinds, not just a rate.
export const TAX_RATE_KINDS = ['standard', 'reduced', 'zero_rated', 'exempt'] as const;
export type TaxRateKind = (typeof TAX_RATE_KINDS)[number];

// A rate the workspace charges. A sales line copies the rate it used (step 15b), so changing a rate
// when the NBR changes it touches only new documents, never an invoice already written.
export const taxRateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  // z.string(), not the enum: a newer server's new kind must not break an older offline client
  kind: z.string(),
  // A percentage as a decimal string with 2 places, as Postgres sends NUMERIC(5,2): "7.50"
  rate: z.string(),
  // The rate a product without its own rate uses. Exactly one rate is the default.
  isDefault: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type TaxRate = z.infer<typeof taxRateSchema>;

// 0 to 99.99, at most 2 decimals: "15", "7.5". VAT is never 100% or more.
const RATE = /^\d{1,2}(?:\.\d{1,2})?$/;

export const taxRateInputSchema = z
  .object({
    name: z.string().trim().min(2, errorCode('tax_rate_name_required')).max(60),
    kind: z.enum(TAX_RATE_KINDS),
    rate: z.string().trim().regex(RATE, errorCode('tax_rate_format')),
    isDefault: z.boolean(),
  })
  // standard and reduced charge something; zero_rated and exempt charge nothing. A "standard 0%"
  // would put a sale in the wrong box of the VAT return.
  .refine(
    (input) => (input.kind === 'standard' || input.kind === 'reduced') === Number(input.rate) > 0,
    {
      error: errorCode('tax_rate_kind_rate'),
      path: ['rate'],
    },
  );
export type TaxRateInput = z.infer<typeof taxRateInputSchema>;
export type TaxRateFormValues = z.input<typeof taxRateInputSchema>;

export const updateTaxRateInputSchema = taxRateInputSchema.safeExtend({ version: versionSchema });
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateInputSchema>;

export const taxRateVersionInputSchema = z.object({ version: versionSchema });

// A workspace has a handful of rates: the whole list at once, archived ones too (the settings page
// shows them greyed out; the pickers leave them out)
export const taxRateListSchema = z.object({ items: z.array(taxRateSchema) });

const taxRateParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: every product form and sales line picks a rate. Changing them is a
// workspace setting.
export const taxRateRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/tax-rates',
    summary: 'The VAT rates of the workspace',
    auth: 'bearer',
    status: 200,
    response: taxRateListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/tax-rates',
    summary: 'Add a VAT rate',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 201,
    body: taxRateInputSchema,
    response: taxRateSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/tax-rates/:id',
    summary: "Change a VAT rate's name, kind, rate, or make it the default",
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: taxRateParamsSchema,
    body: updateTaxRateInputSchema,
    response: taxRateSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/tax-rates/:id/archive',
    summary: 'Hide a VAT rate from new products and documents',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: taxRateParamsSchema,
    body: taxRateVersionInputSchema,
    response: taxRateSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/tax-rates/:id/restore',
    summary: 'Bring an archived VAT rate back',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: taxRateParamsSchema,
    body: taxRateVersionInputSchema,
    response: taxRateSchema,
  }),
};
