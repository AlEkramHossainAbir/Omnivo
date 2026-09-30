import { describe, expect, it } from 'vitest';

import {
  acceptInvitationInputSchema,
  createInvitationInputSchema,
  invitationLink,
} from './invitations.js';
import { isPermissionKey, PERMISSION_GROUP_OF, PERMISSION_KEYS } from './permissions.js';

describe('invitation contracts', () => {
  it('puts the token after #, so it never reaches a server log', () => {
    expect(invitationLink('https://app.omnivo.app', 'abc')).toBe(
      'https://app.omnivo.app/invite#abc',
    );
  });

  it('normalizes the email like sign-up does, and needs at least one role', () => {
    const parsed = createInvitationInputSchema.safeParse({
      email: ' Tanvir@RahmanGarments.com ',
      roleIds: [],
    });
    expect(parsed.success).toBe(false);
    expect(
      createInvitationInputSchema.parse({
        email: ' Tanvir@RahmanGarments.com ',
        roleIds: ['01920000-0000-7000-8000-000000000000'],
      }).email,
    ).toBe('tanvir@rahmangarments.com');
  });

  it('asks a new account for a name and a strong password, an existing one only for its password', () => {
    const token = 'x'.repeat(43);
    expect(
      acceptInvitationInputSchema.safeParse({ account: 'new', token, password: 'Konabari-2026' })
        .success,
    ).toBe(false);
    expect(
      acceptInvitationInputSchema.safeParse({
        account: 'new',
        token,
        fullName: 'Tanvir Hossain',
        password: 'short',
      }).success,
    ).toBe(false);
    expect(
      acceptInvitationInputSchema.safeParse({ account: 'existing', token, password: 'x' }).success,
    ).toBe(true);
  });
});

describe('permission catalog', () => {
  it('knows its own keys and puts every key in a group', () => {
    expect(isPermissionKey('core.user.read')).toBe(true);
    expect(isPermissionKey('core.user.delete')).toBe(false);
    expect(Object.keys(PERMISSION_GROUP_OF).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
});
