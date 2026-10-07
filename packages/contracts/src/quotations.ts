import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { documentRefSchema, salesDocumentFieldsSchema, salesLineSchema } from './sales.js';
import { optionalDateSchema } from './stock.js';

// A quotation is an offer: these items at these prices, valid until a date. It moves no stock and
// posts nothing, so it is numbered as soon as it is saved (QT-2026-27-0001): the customer quotes
// that number back. It stays open (and can be changed) until the customer answers: an order made
// from it accepts it, "Declined" closes it. An open quotation past its date shows as expired; no
// job changes it, so it can still be accepted if the customer agrees late.
export const QUOTATION_STATUSES = ['open', 'accepted', 'declined'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const quotationSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // null = no end date
  validUntil: z.iso.date().nullable(),
  customer: partyRefSchema,
  status: z.enum(QUOTATION_STATUSES),
  // The sums of the lines (sales.ts → documentTotals)
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type QuotationSummary = z.infer<typeof quotationSummarySchema>;

export const quotationSchema = quotationSummarySchema.extend({
  // The workspace setting when it was written: the lines' prices are read this way for good
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  note: z.string().nullable(),
  lines: z.array(salesLineSchema),
  // The order made from it, once accepted
  order: documentRefSchema.nullable(),
});
export type Quotation = z.infer<typeof quotationSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const quotationFieldsSchema = salesDocumentFieldsSchema.extend({
  validUntil: optionalDateSchema,
});

type QuotationRuleInput = z.output<typeof quotationFieldsSchema>;

function quotationRules(input: QuotationRuleInput, ctx: z.RefinementCtx<QuotationRuleInput>) {
  // ISO dates compare as strings
  if (input.validUntil !== null && input.validUntil < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: errorCode('quotation_valid_until'),
    });
  }
}

export const quotationInputSchema = quotationFieldsSchema.superRefine(quotationRules);
export type QuotationInput = z.infer<typeof quotationInputSchema>;

export const updateQuotationInputSchema = quotationFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(quotationRules);
export type UpdateQuotationInput = z.infer<typeof updateQuotationInputSchema>;
export type QuotationFormValues = z.input<typeof updateQuotationInputSchema>;

export const quotationVersionInputSchema = z.object({ version: versionSchema });

export const deleteQuotationQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const quotationListQuerySchema = pageQuerySchema.extend({
  status: z.enum(QUOTATION_STATUSES).optional(),
  customerId: z.uuid().optional(),
});
export type QuotationListQuery = z.input<typeof quotationListQuerySchema>;

export const quotationPageSchema = pageOf(quotationSummarySchema);
export type QuotationPage = z.infer<typeof quotationPageSchema>;

const quotationParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the stock documents: a store keeper may look up what was
// offered. Writing needs sales.quotation.manage.
export const quotationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/quotations',
    summary: 'Quotations, newest date first',
    auth: 'bearer',
    status: 200,
    query: quotationListQuerySchema,
    response: quotationPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/quotations/:id',
    summary: 'One quotation with its lines',
    auth: 'bearer',
    status: 200,
    params: quotationParamsSchema,
    response: quotationSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/quotations',
    summary: 'Write a quotation; it gets its number at once',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 201,
    body: quotationInputSchema,
    response: quotationSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/quotations/:id',
    summary: 'Change an open quotation',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 200,
    params: quotationParamsSchema,
    body: updateQuotationInputSchema,
    response: quotationSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/quotations/:id',
    summary: 'Delete an open quotation',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 204,
    params: quotationParamsSchema,
    query: deleteQuotationQuerySchema,
    response: z.void(),
  }),
  decline: defineRoute({
    method: 'POST',
    path: '/quotations/:id/decline',
    summary: 'Mark an open quotation as declined by the customer',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 200,
    params: quotationParamsSchema,
    body: quotationVersionInputSchema,
    response: quotationSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/quotations/:id/reopen',
    summary: 'Open a declined quotation again',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 200,
    params: quotationParamsSchema,
    body: quotationVersionInputSchema,
    response: quotationSchema,
  }),
};
