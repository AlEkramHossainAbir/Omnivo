import { describe, expect, it } from 'vitest';

import { createAccountInputSchema, updateAccountInputSchema } from './accounts.js';

const valid = {
  parentId: '01939d1c-0000-7000-8000-000000000001',
  code: '1121',
  name: 'Dutch-Bangla Bank CD A/C 1234',
  isGroup: false,
  description: '',
};

describe('account input', () => {
  it('takes codes of digits, split by dots or hyphens', () => {
    for (const code of ['1121', '1-1-21', '11.21', ' 1121 ']) {
      expect(createAccountInputSchema.safeParse({ ...valid, code }).success).toBe(true);
    }
  });

  it('refuses letters, spaces inside and a trailing separator, with a field code', () => {
    for (const code of ['CASH', '11 21', '1121-', '', '1'.repeat(21)]) {
      const result = createAccountInputSchema.safeParse({ ...valid, code });
      expect(result.error?.issues[0]).toMatchObject({
        path: ['code'],
        message: 'account_code_format',
      });
    }
  });

  it('reads an empty parent select as "not chosen"', () => {
    const result = createAccountInputSchema.safeParse({ ...valid, parentId: '' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['parentId'],
      message: 'account_parent_required',
    });
  });

  it('stores an empty description as null', () => {
    expect(createAccountInputSchema.parse(valid).description).toBeNull();
  });

  it('lets only an update keep the parent empty (a top-level group)', () => {
    const top = { parentId: null, code: '1000', name: 'Assets', description: '', version: 3 };
    expect(updateAccountInputSchema.parse(top).parentId).toBeNull();
    expect(createAccountInputSchema.safeParse({ ...valid, parentId: null }).success).toBe(false);
  });
});
