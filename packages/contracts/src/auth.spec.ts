import { describe, expect, it } from 'vitest';

import { loginInputSchema, newWorkspaceSlugSchema, signUpInputSchema } from './auth.js';

describe('auth contracts', () => {
  it('normalizes email and slug before validating', () => {
    const parsed = signUpInputSchema.parse({
      companyName: ' Rahman Garments Ltd. ',
      workspaceSlug: ' Rahman-Garments ',
      fullName: 'Farhana Rahman',
      email: ' Farhana@RahmanGarments.com ',
      password: 'Gazipur-knit-2026',
    });
    expect(parsed.email).toBe('farhana@rahmangarments.com');
    expect(parsed.workspaceSlug).toBe('rahman-garments');
    expect(parsed.companyName).toBe('Rahman Garments Ltd.');
  });

  it('rejects reserved and malformed workspace addresses', () => {
    expect(newWorkspaceSlugSchema.safeParse('admin').success).toBe(false);
    expect(newWorkspaceSlugSchema.safeParse('rahman--garments').success).toBe(false);
    expect(newWorkspaceSlugSchema.safeParse('-rahman').success).toBe(false);
    expect(newWorkspaceSlugSchema.safeParse('ra').success).toBe(false);
  });

  it('lets login use any well-formed slug, reserved or not', () => {
    const result = loginInputSchema.safeParse({
      workspace: 'admin',
      email: 'a@b.co',
      password: 'x',
      keepSignedIn: true,
    });
    expect(result.success).toBe(true);
  });
});