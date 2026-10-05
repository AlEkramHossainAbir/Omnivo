import {
  compareQuantity,
  isQuantity,
  plainQuantity,
  subtractQuantity,
  toBaseQuantity,
  type Unit,
} from '@omnivo/contracts';
import type { SelectOption } from '@omnivo/ui';

import { plainFactor } from './products';

// The pure parts of the stock pages: no React, so they are unit-tested (stock.spec.ts) and shared
// by the forms and the views.

// "Polo shirt · M / Navy" — a simple product is just its name
export function variantName(ref: { productName: string; optionValues: readonly string[] }): string {
  return ref.optionValues.length === 0
    ? ref.productName
    : `${ref.productName} · ${ref.optionValues.join(' / ')}`;
}

// The units a line can be counted in: the base unit, then the product's packs with their size —
// "case = 24 pcs". The base unit's code is the same in every language, like the units page shows it.
export function unitChoices(
  item: { baseUnitId: string; units: readonly { unitId: string; factor: string }[] },
  units: readonly Unit[],
): SelectOption[] {
  const code = (id: string) => units.find((unit) => unit.id === id)?.code ?? '?';
  return [
    { value: item.baseUnitId, label: code(item.baseUnitId) },
    ...item.units.map((pack) => ({
      value: pack.unitId,
      label: `${code(pack.unitId)} = ${plainFactor(pack.factor)} ${code(item.baseUnitId)}`,
    })),
  ];
}

// What a line typed in a pack is in the base unit, the way the server will count it; null while
// the quantity is not a quantity yet, or the line is already in the base unit (nothing to show)
export function basePreview(
  item: { baseUnitId: string; units: readonly { unitId: string; factor: string }[] },
  unitId: string,
  quantity: string,
  units: readonly Unit[],
): string | null {
  if (unitId === item.baseUnitId || !isQuantity(quantity.trim())) return null;
  const pack = item.units.find((candidate) => candidate.unitId === unitId);
  const decimals = units.find((unit) => unit.id === item.baseUnitId)?.decimals;
  if (!pack || decimals === undefined) return null;
  return toBaseQuantity(quantity.trim(), pack.factor, decimals);
}

// First expiry, first out: how much of each batch to take for `wanted`, from the batch that
// expires first. The batches come from the stock card already in that order. What is left over
// (not enough in all batches together) is returned too, so the form can say so.
export function fefoSplit(
  batches: readonly { batchId: string; quantity: string }[],
  wanted: string,
): { picks: { batchId: string; quantity: string }[]; missing: string } {
  const picks: { batchId: string; quantity: string }[] = [];
  let left = wanted;
  for (const batch of batches) {
    if (compareQuantity(left, '0') <= 0) break;
    if (compareQuantity(batch.quantity, '0') <= 0) continue;
    const take = compareQuantity(batch.quantity, left) >= 0 ? left : batch.quantity;
    picks.push({ batchId: batch.batchId, quantity: plainQuantity(take) });
    left = subtractQuantity(left, take);
  }
  return { picks, missing: compareQuantity(left, '0') > 0 ? left : '0.0000' };
}

// Whole days from `today` to `iso` (both ISO dates): negative once expired. Counted on UTC dates,
// so no time zone and no summer time can make a day 23 hours long.
export function daysUntil(iso: string, today: string): number {
  const day = (value: string) =>
    Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Math.round((day(iso) - day(today)) / 86_400_000);
}

export type ExpiryTone = 'crit' | 'warn' | 'neutral';

// Expired is a problem; within a month is a warning (time to sell it or send it back to the
// principal); later is just a date
export function expiryTone(expiresOn: string | null, today: string): ExpiryTone {
  if (expiresOn === null) return 'neutral';
  const days = daysUntil(expiresOn, today);
  if (days < 0) return 'crit';
  return days <= 30 ? 'warn' : 'neutral';
}

// The serial number box: one per line (a scanner ends each with Enter), commas and spaces work too
export function parseSerials(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((serial) => serial.trim())
    .filter((serial) => serial !== '');
}

// The routes a stock card's row links to, by its kind (unknown kinds from a newer server: none)
export function documentRoute(
  kind: string,
): '/stock/adjustments/$adjustmentId' | '/stock/transfers/$transferId' | null {
  if (kind === 'adjustment') return '/stock/adjustments/$adjustmentId';
  if (kind === 'transfer_out' || kind === 'transfer_in') return '/stock/transfers/$transferId';
  return null;
}

// The first error message inside a form error, however deep: a line's serial numbers keep one
// error per number (lines.0.serialNumbers.3), the form shows the first under the box. unknown in,
// narrowed here: react-hook-form's error types differ per form, this works for every one of them.
export function firstMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('message' in error && typeof error.message === 'string' && error.message !== '') {
    return error.message;
  }
  for (const value of Object.values(error)) {
    // `ref` is the input element itself; never walk into the DOM
    if (value instanceof Object && !('nodeType' in value)) {
      const found = firstMessage(value);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// "lines.2.serialNumbers.1": where the server puts an error about one serial number. The cast
// only narrows a string built from two numbers to the template type it is (like rowPath).
export function serialPath(
  index: number,
  serial: number,
): `lines.${number}.serialNumbers.${number}` {
  return `lines.${String(index)}.serialNumbers.${String(serial)}` as `lines.${number}.serialNumbers.${number}`;
}
