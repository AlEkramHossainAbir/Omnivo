import { z } from 'zod';

import { errorCode } from './errors.js';

// Money is a decimal string end to end, never a JavaScript number (CLAUDE.md → Money). The
// database column is NUMERIC(19,4): at most 15 digits before the point and 4 after it.
const MONEY = /^\d{1,15}(?:\.\d{1,4})?$/;

// One side of a journal line, as a form sends it: '' (an empty box) means nothing on this side.
// The API stores '0' for it, so the database never holds two kinds of "nothing".
export const amountSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || MONEY.test(value), errorCode('money_format'))
  .transform((value) => (value === '' ? '0' : value));

// A price that may be left out (step 12: a variant's sale price). '' (an empty box) is "no fixed
// price" — a garments factory prices each buyer's PO — and is stored as NULL, never as 0, because a
// price of zero is a real price (a free sample).
export const priceSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || MONEY.test(value), errorCode('money_format'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

// The arithmetic below works in ten-thousandths of a taka, as BigInt: "18450.5" is 184505000n.
// Exact like decimal.js for what the journal does — adding and subtracting amounts with at most
// 4 decimals, so nothing is ever rounded — and it keeps this package on zod alone (the
// contracts-only-zod boundary: the API and the browser both load it). Rounding, when a later step
// multiplies (VAT, quantity × price), stays with decimal.js where that happens.
const UNITS_PER_TAKA = 10_000n;
const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

function toUnits(value: string): bigint {
  const match = AMOUNT.exec(value);
  const whole = match?.[2];
  if (match === null || whole === undefined) throw new Error(`Not a money amount: "${value}"`);
  const fraction = (match[3] ?? '').padEnd(4, '0');
  const units = BigInt(whole) * UNITS_PER_TAKA + BigInt(fraction);
  return match[1] === '-' ? -units : units;
}

// Always 4 decimals, like Postgres sends NUMERIC(19,4), so two results compare as plain strings.
// Zero has no minus sign.
function fromUnits(units: bigint): string {
  const size = units < 0n ? -units : units;
  const fraction = String(size % UNITS_PER_TAKA).padStart(4, '0');
  return `${units < 0n ? '-' : ''}${String(size / UNITS_PER_TAKA)}.${fraction}`;
}

// '' counts as 0, so a half-filled form can be totalled while it is typed
export function isZeroMoney(value: string): boolean {
  return value === '' || toUnits(value) === 0n;
}

export function sumMoney(values: readonly string[]): string {
  return fromUnits(
    values.reduce((total, value) => total + (value === '' ? 0n : toUnits(value)), 0n),
  );
}

// a − b: the difference between the debit and the credit total, and the running balances
export function subtractMoney(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

export function addMoney(a: string, b: string): string {
  return fromUnits(toUnits(a) + toUnits(b));
}

export function isNegativeMoney(value: string): boolean {
  return toUnits(value) < 0n;
}

// |value|: a ledger shows "৳1,200 Cr", not "-৳1,200"
export function absMoney(value: string): string {
  const units = toUnits(value);
  return fromUnits(units < 0n ? -units : units);
}
