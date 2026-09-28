import { z } from 'zod';

import { ApiRequestError } from './api';

export type FieldErrors = Partial<Record<string, string>>;

// ক্লায়েন্টে একই Zod schema — সার্ভারে যাওয়ার আগেই একই মেসেজ দেখানো
export function validate<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): { data: z.output<TSchema> } | { errors: FieldErrors } {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data };
  const errors: FieldErrors = {};
  for (const [field, messages] of Object.entries(z.flattenError(result.error).fieldErrors)) {
    if (Array.isArray(messages) && typeof messages[0] === 'string') errors[field] = messages[0];
  }
  return { errors };
}

// সার্ভারের error → ফিল্ডের পাশে (fieldErrors থাকলে) নয়তো ফর্মের উপরে
export function fromApiError(error: unknown): { fields: FieldErrors; form: string | null } {
  if (!(error instanceof ApiRequestError)) {
    return { fields: {}, form: 'Could not reach the server. Check your connection and try again.' };
  }
  const fields: FieldErrors = {};
  for (const [field, messages] of Object.entries(error.body.fieldErrors ?? {})) {
    if (messages[0]) fields[field] = messages[0];
  }
  return { fields, form: Object.keys(fields).length > 0 ? null : error.body.message };
}
