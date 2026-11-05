import { z } from 'zod';

import { uploadTicketSchema } from './attachments.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A CSV file of products, checked and saved by the worker: every row is right and every product
// is created, or nothing is (you chose "all or nothing"). Fixing a file and importing it again is
// then always safe — there is never a half-imported file to clean up first.

// uploading = the row and the upload address exist, the file is on its way to storage
// queued      = the file is in storage and the worker has been asked
// done        = every product was created
// failed      = nothing was created; `errors` says what to fix
export const PRODUCT_IMPORT_STATUSES = ['uploading', 'queued', 'done', 'failed'] as const;
export type ProductImportStatus = (typeof PRODUCT_IMPORT_STATUSES)[number];

// 10,000 rows of products is about 2 MB; 5 MB leaves room for long names and many custom fields
export const PRODUCT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMPORT_MAX_ROWS = 10_000;
// A file with a wrong unit in every row would list 10,000 errors. The first 100 say what to fix.
export const PRODUCT_IMPORT_MAX_ERRORS = 100;

// The columns, in the template's order. Only name and unit must be there; a missing column is the
// same as an empty one. Rows with the same code are the variants of one product.
export const PRODUCT_IMPORT_COLUMNS = [
  'code',
  'name',
  'type',
  'category',
  'unit',
  'sale_price',
  'sku',
  'barcode',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'option3_name',
  'option3_value',
  'sales_unit',
  'purchase_unit',
  'pack1_unit',
  'pack1_factor',
  'pack1_barcode',
  'pack2_unit',
  'pack2_factor',
  'pack2_barcode',
  'tracking',
  'expiry',
  'description',
] as const;
export type ProductImportColumn = (typeof PRODUCT_IMPORT_COLUMNS)[number];

export const PRODUCT_IMPORT_REQUIRED_COLUMNS = ['name', 'unit'] as const;

// A custom field's column is its key after this prefix: cf_generic_name
export const CUSTOM_FIELD_COLUMN_PREFIX = 'cf_';

// A category path in one cell: "Fabrics > Knit"
export const CATEGORY_PATH_SEPARATOR = '>';

export const createProductImportInputSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((name) => name.toLowerCase().endsWith('.csv'), errorCode('import_file_type')),
  sizeBytes: z.number().int().positive().max(PRODUCT_IMPORT_MAX_BYTES, errorCode('file_too_large')),
});
export type CreateProductImportInput = z.infer<typeof createProductImportInputSchema>;

// One thing to fix. row is the spreadsheet's row number (the header is row 1, as Excel shows it);
// null = the whole file (a missing column, a file that is not UTF-8). column is the CSV column.
export const productImportErrorSchema = z.object({
  row: z.number().int().nullable(),
  column: z.string().nullable(),
  // An error code like the API's (z.string(): the same rule as everywhere), with its values
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type ProductImportError = z.infer<typeof productImportErrorSchema>;

export const productImportSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(PRODUCT_IMPORT_STATUSES),
  // Set by the worker: the data rows read, and the products made from them (done only)
  rowCount: z.number().int().nullable(),
  productCount: z.number().int().nullable(),
  // How many problems were found; the detail route lists the first 100
  errorCount: z.number().int(),
  requestedBy: z.object({ id: z.uuid(), fullName: z.string() }),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ProductImport = z.infer<typeof productImportSchema>;

export const productImportDetailSchema = productImportSchema.extend({
  errors: z.array(productImportErrorSchema),
});
export type ProductImportDetail = z.infer<typeof productImportDetailSchema>;

// The import row, plus where to PUT the file: the same short-lived address as an attachment's
export const productImportTicketSchema = z.object({
  import: productImportSchema,
  upload: uploadTicketSchema.shape.upload,
});

export const productImportPageSchema = pageOf(productImportSchema);

const importParamsSchema = z.object({ id: z.uuid() });

// The whole workspace's imports, not only your own (unlike report exports): an import changes the
// product list everybody works with, so whoever manages products sees what came in and from whom
export const productImportRoutes = {
  create: defineRoute({
    method: 'POST',
    path: '/product-imports',
    summary: 'Describe a CSV file of products and get a short-lived URL to upload it',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: createProductImportInputSchema,
    response: productImportTicketSchema,
  }),
  start: defineRoute({
    method: 'POST',
    path: '/product-imports/:id/start',
    summary: 'Confirm the upload and ask the worker to check and import the file',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: importParamsSchema,
    response: productImportSchema,
  }),
  list: defineRoute({
    method: 'GET',
    path: '/product-imports',
    summary: 'The product imports of the workspace, newest first',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    query: pageQuerySchema,
    response: productImportPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/product-imports/:id',
    summary: 'One import, with the first 100 problems found in its file',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: importParamsSchema,
    response: productImportDetailSchema,
  }),
};
