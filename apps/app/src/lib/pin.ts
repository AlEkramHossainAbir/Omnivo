import { errorCode } from '@omnivo/contracts';
import { isPin, PIN_LENGTH } from '@omnivo/sync';
import { z } from 'zod';

// Step 19b: the device PIN's rules, for the lock screen and the PIN dialog. The PIN never leaves
// the device, so no contract has a schema for it: the rules live here, and their messages are the
// codes 19b.3 added to ERROR_CODES.

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

// What a PIN box keeps of what was typed: ASCII digits, at most six. A Bangla keyboard types
// Bangla digits, which become ASCII ones (the money input's rule); anything else (a space, a
// letter typed by mistake) is dropped as it is typed, so the box never holds what isPin refuses.
export function pinDigits(raw: string): string {
  return raw
    .replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
    .replace(/[^0-9]/g, '')
    .slice(0, PIN_LENGTH);
}

// Decision 30: six of the same digit (000000), or a straight run up or down (123456, 987654).
// A run that wraps (890123) is not refused: nobody guesses it first.
export function isEasyPin(pin: string): boolean {
  // Six ASCII digits (isPin ran first), so the characters are the digits
  const digits = Array.from({ length: pin.length }, (_, index) => Number(pin.charAt(index)));
  const steps = digits.slice(1).map((digit, index) => digit - (digits[index] ?? digit));
  const [first = 0] = steps;
  return Math.abs(first) <= 1 && steps.every((step) => step === first);
}

const pinSchema = z.string().refine(isPin, errorCode('pin_format'));

// The lock screen checks the format only: a PIN set before is never "too easy" to type
export const unlockFormSchema = z.object({ pin: pinSchema });

const newPinSchema = pinSchema.refine((pin) => !isEasyPin(pin), errorCode('pin_too_easy'));

// The dialog. A new PIN on a device without one (or after "Forgot PIN?") is set with the server's
// key, online; a change needs the current PIN (decision 16), checked by the device, not here.
export function pinFormSchema(change: boolean) {
  return z
    .object({
      current: change ? pinSchema : z.literal(''),
      pin: newPinSchema,
      repeat: z.string(),
    })
    .refine((values) => values.pin === values.repeat, {
      error: errorCode('pin_mismatch'),
      path: ['repeat'],
    });
}
