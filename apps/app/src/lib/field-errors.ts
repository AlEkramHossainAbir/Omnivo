import { isErrorCode, type SyncCommandError } from '@omnivo/contracts';
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
  placeErrors(error.code, error.problem.fieldErrors, fieldNames, setError);
}

// Step 18b: a refused command's error, when the person opens the command to fix it (decision 22).
// The same paths as the form's, so it lands under the same boxes. `rename` turns a path the
// server wrote by an address's id ("addresses.<id>.kind") into the form's place in the list.
export function applyCommandError<TValues extends FieldValues>(
  error: SyncCommandError,
  fieldNames: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
  rename: (path: string) => string = (path) => path,
): void {
  const fieldErrors = Object.fromEntries(
    Object.entries(error.fieldErrors ?? {}).map(([path, codes]) => [rename(path), codes]),
  );
  // The command's code comes from the server: one this app does not know reads as unknown_error
  placeErrors(
    isErrorCode(error.code) ? error.code : 'unknown_error',
    fieldErrors,
    fieldNames,
    setError,
  );
}

function placeErrors<TValues extends FieldValues>(
  code: string,
  fieldErrors: Record<string, string[]> | undefined,
  fieldNames: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
): void {
  let placed = false;
  for (const [field, codes] of Object.entries(fieldErrors ?? {})) {
    // find: cast ছাড়াই string → Path<TValues>; ফর্মে নেই এমন নাম বাদ পড়ে
    const name = fieldNames.find((candidate) => candidate === field);
    const first = codes[0];
    if (name && first !== undefined) {
      setError(name, { message: isErrorCode(first) ? first : 'invalid_value' });
      placed = true;
    }
  }
  if (!placed) setError('root.server', { message: code });
}
