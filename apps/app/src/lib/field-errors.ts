import { isErrorCode } from '@omnivo/contracts';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiRequestError } from './api';

// সার্ভারের error → react-hook-form: fieldErrors থাকলে সেই ফিল্ডের নিচে, নয়তো ফর্মের উপরে
// ('root.server' — পরের submit-এ react-hook-form নিজেই মুছে দেয়)। message-এ code রাখা হয়,
// লেখা না: ui-র Field/FormAlert সেটা বর্তমান ভাষায় দেখায়, ভাষা বদলালে সাথে সাথে বদলায়
export function applyApiError<TValues extends FieldValues>(
  error: unknown,
  // schema.keyof().options থেকে — সার্ভারের পাঠানো string নামকে টাইপ-চেকড ফিল্ড নামে মেলাতে
  fieldNames: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
): void {
  // ApiRequestError না = আমাদের নিজের কোডের bug (নেটওয়ার্কও ApiRequestError হয়ে আসে)
  if (!(error instanceof ApiRequestError)) {
    setError('root.server', { message: 'unknown_error' });
    return;
  }
  let placed = false;
  for (const [field, codes] of Object.entries(error.problem.fieldErrors ?? {})) {
    // find: cast ছাড়াই string → Path<TValues>; ফর্মে নেই এমন নাম বাদ পড়ে
    const name = fieldNames.find((candidate) => candidate === field);
    const code = codes[0];
    if (name && code !== undefined) {
      setError(name, { message: isErrorCode(code) ? code : 'invalid_value' });
      placed = true;
    }
  }
  if (!placed) setError('root.server', { message: error.code });
}
