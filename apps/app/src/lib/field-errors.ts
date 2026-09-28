import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiRequestError } from './api';

// সার্ভারের error → react-hook-form: fieldErrors থাকলে সেই ফিল্ডের নিচে, নয়তো ফর্মের উপরে
// ('root.server' — পরের submit-এ react-hook-form নিজেই মুছে দেয়)
export function applyApiError<TValues extends FieldValues>(
  error: unknown,
  // schema.keyof().options থেকে — সার্ভারের পাঠানো string নামকে টাইপ-চেকড ফিল্ড নামে মেলাতে
  fieldNames: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
): void {
  if (!(error instanceof ApiRequestError)) {
    setError('root.server', {
      message: 'Could not reach the server. Check your connection and try again.',
    });
    return;
  }
  let placed = false;
  for (const [field, messages] of Object.entries(error.body.fieldErrors ?? {})) {
    // find: cast ছাড়াই string → Path<TValues>; ফর্মে নেই এমন নাম বাদ পড়ে
    const name = fieldNames.find((candidate) => candidate === field);
    const message = messages[0];
    if (name && message) {
      setError(name, { message });
      placed = true;
    }
  }
  if (!placed) setError('root.server', { message: error.body.message });
}
