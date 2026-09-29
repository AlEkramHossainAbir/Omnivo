import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

export const branchSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  // null = চালু। archive করা ব্রাঞ্চ মোছা হয় না: পরে ইনভয়েস আর স্টক তাকে রেফার করবে
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Branch = z.infer<typeof branchSchema>;

// ছোট কোড (HO, GZP, CTG1) — রিপোর্টের কলামে আর পরে ডকুমেন্ট নম্বরে বসার মতো। বড় হাতের অক্ষরে
// রাখা: "gzp" আর "GZP" আলাদা ব্রাঞ্চ হয়ে unique index এড়িয়ে যেত
const branchCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, errorCode('branch_code_format'));

export const branchInputSchema = z.object({
  code: branchCodeSchema,
  name: z.string().trim().min(2, errorCode('branch_name_required')).max(120),
  phone: optionalText(30),
  address: optionalText(300),
});
export type BranchInput = z.infer<typeof branchInputSchema>;

export const updateBranchInputSchema = branchInputSchema.extend({ version: versionSchema });

// archive/restore-ও version চায়: কেউ নাম বদলানোর সাথে সাথে অন্যজন পুরনো পাতা থেকে archive চাপলে
// সে জানুক যে ব্রাঞ্চটা বদলে গেছে
export const branchVersionInputSchema = z.object({ version: versionSchema });

export const BRANCH_STATUSES = ['active', 'archived'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export const branchListQuerySchema = z.object({
  status: z.enum(BRANCH_STATUSES).default('active'),
});

// ব্রাঞ্চ গোনা কয়েকটা (বড় কোম্পানিতেও কয়েক ডজন) — তাই keyset পাতা না, পুরো তালিকা একবারে।
// নিয়ম: অসীম তালিকা (সদস্য, audit log, প্রোডাক্ট) পাতায় পাতায়; ছোট master তালিকা একবারে
export const branchListSchema = z.object({ items: z.array(branchSchema) });

const branchParamsSchema = z.object({ id: z.uuid() });

export const branchRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/branches',
    summary: 'Branches and locations of the active workspace',
    auth: 'bearer',
    status: 200,
    query: branchListQuerySchema,
    response: branchListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/branches/:id',
    summary: 'One branch',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    response: branchSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/branches',
    summary: 'Add a branch',
    auth: 'bearer',
    status: 201,
    body: branchInputSchema,
    response: branchSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/branches/:id',
    summary: 'Edit a branch',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    body: updateBranchInputSchema,
    response: branchSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/branches/:id/archive',
    summary: 'Archive a branch; at least one branch stays active',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    body: branchVersionInputSchema,
    response: branchSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/branches/:id/restore',
    summary: 'Bring an archived branch back',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    body: branchVersionInputSchema,
    response: branchSchema,
  }),
};
