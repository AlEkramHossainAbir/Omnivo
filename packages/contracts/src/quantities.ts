import { z } from 'zod';

import { errorCode } from './errors.js';

// A quantity of stock is a decimal string end to end, like money: the database column is
// NUMERIC(19,4) ("24.0000"), and a unit allows at most 4 decimals (units.decimals). A JavaScript
// number would turn 0.1 + 0.2 kg into 0.30000000000000004 kg.
const QUANTITY = /^\d{1,13}(?:\.\d{1,4})?$/;
const SIGNED = /^(-?)(\d+)(?:\.(\d{1,10}))?$/;

// The arithmetic below works in ten-thousandths, as BigInt — exact, and contracts stays on zod
// alone (the contracts-only-zod boundary), the same way money.ts does it.
const SCALE = 10_000n;
const MICRO = 1_000_000n;

function toUnits(value: string): bigint {
  const match = SIGNED.exec(value);
  const whole = match?.[2];
  if (match === null || whole === undefined) throw new Error(`Not a quantity: "${value}"`);
  const fraction = (match[3] ?? '').padEnd(4, '0').slice(0, 4);
  const units = BigInt(whole) * SCALE + BigInt(fraction);
  return match[1] === '-' ? -units : units;
}

// Always 4 decimals, like Postgres sends NUMERIC(19,4), so two results compare as plain strings.
// Zero has no minus sign.
function fromUnits(units: bigint): string {
  const size = units < 0n ? -units : units;
  return `${units < 0n ? '-' : ''}${String(size / SCALE)}.${String(size % SCALE).padStart(4, '0')}`;
}

export function isQuantity(value: string): boolean {
  return QUANTITY.test(value) && toUnits(value) > 0n;
}

// What a line's quantity box sends: a positive number with at most 4 decimals. Zero is not a
// quantity: a line that moves nothing is a mistake, not a line.
export const quantitySchema = z
  .string()
  .trim()
  .refine((value) => isQuantity(value), errorCode('quantity_format'));

// What arrived of a transfer line: zero is a real answer (the carton never came)
export const receivedQuantitySchema = z
  .string()
  .trim()
  .refine((value) => QUANTITY.test(value), errorCode('quantity_format'));

// A level (a reorder point): zero is allowed ("tell me when it runs out"), '' = no level
export const levelSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || QUANTITY.test(value), errorCode('quantity_format'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

export function addQuantity(a: string, b: string): string {
  return fromUnits(toUnits(a) + toUnits(b));
}

export function subtractQuantity(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

export function sumQuantity(values: readonly string[]): string {
  return fromUnits(values.reduce((total, value) => total + toUnits(value), 0n));
}

export function negateQuantity(value: string): string {
  return fromUnits(-toUnits(value));
}

// -1, 0 or 1, like a sort comparator: compareQuantity(onHand, wanted) < 0 = not enough
export function compareQuantity(a: string, b: string): number {
  const difference = toUnits(a) - toUnits(b);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

export function isZeroQuantity(value: string): boolean {
  return toUnits(value) === 0n;
}

// "1.50" fits a unit with 1 decimal (the trailing zero means nothing); "1.25" does not. A box or
// a piece allows 0 decimals: 1.5 boxes is a typing mistake, not half a box.
export function fitsDecimals(value: string, decimals: number): boolean {
  const fraction = (value.split('.')[1] ?? '').replace(/0+$/, '');
  return fraction.length <= decimals;
}

// A quantity typed in a pack, in the product's base unit: quantity × factor, rounded half up to
// the decimals the base unit allows. A carton of 24 → 3 cartons = 72 pcs, exact. A yard is
// 0.9144 m and metres keep 2 decimals → 3 yards = 2.7432 m = 2.74 m: the line shows "= 2.74 m"
// before it is saved, so nobody is surprised. The result has 4 decimals, like the column.
export function toBaseQuantity(quantity: string, factor: string, decimals: number): string {
  // quantity in ten-thousandths × factor in millionths = 10^10ths
  const [whole = '0', fraction = ''] = factor.split('.');
  const factorMicro = BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  const product = toUnits(quantity) * factorMicro;
  // Down to `decimals` places: divide by 10^(10 - decimals), half up (quantities are positive)
  const step = 10n ** BigInt(10 - decimals);
  const rounded = (product + step / 2n) / step;
  // Back to ten-thousandths: × 10^(4 - decimals)
  return fromUnits(rounded * 10n ** BigInt(4 - decimals));
}

// A serial-tracked line counts whole items: one serial number per base unit
export function isWholeQuantity(value: string): boolean {
  return toUnits(value) % SCALE === 0n;
}

export function wholeCount(value: string): number {
  return Number(toUnits(value) / SCALE);
}

// "24.0000" → "24", "2.7400" → "2.74": for a sentence or an audit row. Tables use the unit's
// decimals with format.number instead, so the column lines up.
export function plainQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
