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

export function negateMoney(value: string): string {
  return fromUnits(-toUnits(value));
}

// -1, 0 or 1, like a sort comparator
export function compareMoney(a: string, b: string): number {
  const difference = toUnits(a) - toUnits(b);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------
// Stock values (step 14). A value is rounded to the paisa (2 decimals), because the journal shows
// 2 and its totals must visibly add up; a unit cost keeps 4, because a tablet costs ৳0.8512.

const PAISA = 100n;

// numerator ÷ denominator, rounded half away from zero (a negative value rounds like a positive
// one: −0.005 → −0.01). The denominator is always positive here.
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const half = denominator / 2n;
  return numerator < 0n ? -((-numerator + half) / denominator) : (numerator + half) / denominator;
}

// quantity × price, to the paisa: 3 cartons × ৳1,200.50 = ৳3,601.50. Both have at most 4 decimals,
// so the exact product has 8; it is rounded once, at the end.
export function multiplyMoney(quantity: string, price: string): string {
  const exact = toUnits(quantity) * toUnits(price);
  // exact is in 10^-8 taka; one paisa is 10^6 of those
  return fromUnits(divideRounded(exact, 1_000_000n) * PAISA);
}

// The share of a value that goes with part of a quantity: value × part ÷ whole, to the paisa. Taking
// 30 of the 40 pieces worth ৳1,000 takes ৳750. The whole must be positive.
export function prorateMoney(value: string, part: string, whole: string): string {
  const wholeUnits = toUnits(whole);
  if (wholeUnits <= 0n) throw new Error(`Cannot share a value over "${whole}"`);
  // value (10^-4) × part (10^-4) ÷ whole (10^-4) = 10^-4 taka; ÷ 100 more for the paisa
  return fromUnits(divideRounded(toUnits(value) * toUnits(part), wholeUnits * PAISA) * PAISA);
}

// A value cut into `count` pieces that add up to it exactly: ৳100 over 3 serial numbers is 33.33,
// 33.33 and 33.34. The last piece takes what rounding left over.
export function splitMoney(value: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Cannot split into ${String(count)}`);
  const total = toUnits(value);
  const piece = divideRounded(total, BigInt(count) * PAISA) * PAISA;
  return Array.from({ length: count }, (_, index) =>
    fromUnits(index === count - 1 ? total - piece * BigInt(count - 1) : piece),
  );
}

// What one unit costs: value ÷ quantity, to 4 decimals (৳1,000 for 3 pieces = ৳333.3333). The
// quantity must be positive.
export function unitCostOf(value: string, quantity: string): string {
  const quantityUnits = toUnits(quantity);
  if (quantityUnits <= 0n) throw new Error(`No unit cost for a quantity of "${quantity}"`);
  // value (10^-4) × 10^4 ÷ quantity (10^-4) = 10^-4 taka per unit
  return fromUnits(divideRounded(toUnits(value) * 10_000n, quantityUnits));
}
