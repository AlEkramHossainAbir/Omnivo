import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// A tree like the chart of accounts, but simpler: no types, no codes, no groups-only rule. A
// category may hold products and other categories at the same time ("Tablets" under "Medicine").
export const productCategorySchema = z.object({
  id: z.uuid(),
  // null = a top-level category
  parentId: z.uuid().nullable(),
  name: z.string(),
  // Products directly in it (not in its sub-categories), archived ones included
  productCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type ProductCategory = z.infer<typeof productCategorySchema>;

const categoryNameSchema = z.string().trim().min(1, errorCode('category_name_required')).max(80);

// The form's "Top level" option sends ''
const parentIdSchema = z
  .union([z.uuid(errorCode('category_parent_invalid')), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const createProductCategoryInputSchema = z.object({
  parentId: parentIdSchema,
  name: categoryNameSchema,
});
export type CreateProductCategoryInput = z.infer<typeof createProductCategoryInputSchema>;

// A new parentId moves the category with everything under it
export const updateProductCategoryInputSchema = createProductCategoryInputSchema.extend({
  version: versionSchema,
});
export type UpdateProductCategoryInput = z.infer<typeof updateProductCategoryInputSchema>;

export const deleteProductCategoryQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// Tens to a few hundred categories: the whole tree at once, like the chart
export const productCategoryListSchema = z.object({ items: z.array(productCategorySchema) });

const categoryParamsSchema = z.object({ id: z.uuid() });

export const productCategoryRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/product-categories',
    summary: 'The product categories of the workspace, as a flat list with parent ids',
    auth: 'bearer',
    status: 200,
    response: productCategoryListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/product-categories',
    summary: 'Add a category, at the top or under another one',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: createProductCategoryInputSchema,
    response: productCategorySchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/product-categories/:id',
    summary: 'Rename a category or move it under another one',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: categoryParamsSchema,
    body: updateProductCategoryInputSchema,
    response: productCategorySchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/product-categories/:id',
    summary: 'Delete a category that holds no products and no categories',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 204,
    params: categoryParamsSchema,
    query: deleteProductCategoryQuerySchema,
    response: z.void(),
  }),
};
