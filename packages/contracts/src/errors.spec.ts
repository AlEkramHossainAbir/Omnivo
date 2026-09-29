import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { signUpInputSchema } from './auth.js';
import { contractErrorMap, ERROR_CODES, isErrorCode } from './errors.js';

// ফিল্ডের নাম → প্রথম issue-এর মেসেজ (যা এখন একটা code)
function codesOf(schema: z.ZodType, value: unknown): Record<string, string | undefined> {
  const result = schema.safeParse(value, { error: contractErrorMap });
  if (result.success) return {};
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  );
}

describe('error codes', () => {
  it('turns every sign-up rule into a known code instead of English text', () => {
    const codes = codesOf(signUpInputSchema, {
      companyName: 'R',
      workspaceSlug: 'admin',
      fullName: 'x'.repeat(121),
      email: 'not-an-email',
      password: 'short',
    });
    expect(codes).toEqual({
      companyName: 'company_name_required',
      workspaceSlug: 'slug_reserved',
      // .max(120)-এ নিজস্ব code নেই — contractErrorMap সাধারণ code দেয়
      fullName: 'too_long',
      email: 'email_invalid',
      password: 'password_too_short',
    });
    for (const code of Object.values(codes)) expect(isErrorCode(code)).toBe(true);
  });

  it('reports a missing field as required and a wrong type as invalid', () => {
    const schema = z.object({ qty: z.number() });
    expect(codesOf(schema, {})).toEqual({ qty: 'required' });
    expect(codesOf(schema, { qty: 'ten' })).toEqual({ qty: 'invalid_value' });
  });

  it('has no duplicate codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});
