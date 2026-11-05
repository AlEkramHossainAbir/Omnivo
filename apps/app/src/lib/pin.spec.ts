import { describe, expect, it } from 'vitest';

import { isEasyPin, pinDigits, pinFormSchema, unlockFormSchema } from './pin';

// Step 19b: the PIN box's rules, and the forms of the lock screen and the PIN dialog

describe('pinDigits', () => {
  it('turns Bangla digits into ASCII ones', () => {
    expect(pinDigits('৪৮০৯১৫')).toBe('480915');
    expect(pinDigits('৪8০9১5')).toBe('480915');
  });

  it('drops what is not a digit, and stops at six', () => {
    expect(pinDigits(' 48-09 15 ')).toBe('480915');
    expect(pinDigits('4809157')).toBe('480915');
    expect(pinDigits('pin')).toBe('');
  });

  it('drops digits of other scripts, which isPin would refuse', () => {
    // Arabic-Indic and Devanagari digits: a Bangla keyboard never types them
    expect(pinDigits('٤٨٠९१५')).toBe('');
  });
});

describe('isEasyPin (decision 30)', () => {
  it('refuses six of the same digit and straight runs both ways', () => {
    for (const pin of ['000000', '777777', '123456', '012345', '456789', '987654', '543210']) {
      expect(isEasyPin(pin), pin).toBe(true);
    }
  });

  it('accepts everything else, a run that wraps too', () => {
    for (const pin of ['480915', '135790', '112233', '123457', '890123', '246802']) {
      expect(isEasyPin(pin), pin).toBe(false);
    }
  });
});

describe('the forms', () => {
  it('unlocks with any six digits, an easy PIN set before too', () => {
    expect(unlockFormSchema.safeParse({ pin: '123456' }).success).toBe(true);
    expect(unlockFormSchema.safeParse({ pin: '12345' }).error?.issues[0]).toMatchObject({
      path: ['pin'],
      message: 'pin_format',
    });
  });

  it('refuses an easy new PIN, and two PINs that differ under the second box', () => {
    const form = pinFormSchema(false);
    expect(form.safeParse({ current: '', pin: '480915', repeat: '480915' }).success).toBe(true);
    expect(
      form.safeParse({ current: '', pin: '123456', repeat: '123456' }).error?.issues[0],
    ).toMatchObject({ path: ['pin'], message: 'pin_too_easy' });
    expect(
      form.safeParse({ current: '', pin: '480915', repeat: '480916' }).error?.issues[0],
    ).toMatchObject({ path: ['repeat'], message: 'pin_mismatch' });
  });

  it('needs the current PIN for a change, and only then', () => {
    const change = pinFormSchema(true);
    expect(
      change.safeParse({ current: '', pin: '480915', repeat: '480915' }).error?.issues[0],
    ).toMatchObject({
      path: ['current'],
      message: 'pin_format',
    });
    expect(change.safeParse({ current: '135790', pin: '480915', repeat: '480915' }).success).toBe(
      true,
    );
    // A new PIN after "Forgot PIN?": no current one to type
    expect(
      pinFormSchema(false).safeParse({ current: '135790', pin: '480915', repeat: '480915' })
        .success,
    ).toBe(false);
  });
});
