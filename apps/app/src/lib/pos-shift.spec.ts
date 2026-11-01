import { cashCountSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  boxesTotal,
  countValues,
  differenceKind,
  EMPTY_NOTES,
  leftOpen,
  noteAmount,
  noteDigits,
} from './pos-shift';

describe('the count', () => {
  it('keeps whole ASCII digits in a note box, from a Bangla keyboard too', () => {
    expect(noteDigits('১২')).toBe('12');
    expect(noteDigits('4.5')).toBe('45');
    expect(noteDigits('-3')).toBe('3');
    expect(noteDigits('1234567')).toBe('12345');
  });

  it('sends the notes with their own total, which the schema accepts', () => {
    const boxes = { ...EMPTY_NOTES, '1000': '4', '500': '2', '10': '' };
    const values = countValues('notes', boxes, '999');
    expect(values.total).toBe('5000.00');
    expect(values.notes?.['1000']).toBe(4);
    expect(values.notes?.['10']).toBe(0);
    expect(cashCountSchema.safeParse(values).success).toBe(true);
    expect(boxesTotal(boxes)).toBe('5000.00');
    expect(noteAmount('500', '2')).toBe('1000.0000');
  });

  it('sends a total alone as it is typed; an empty one is refused', () => {
    expect(countValues('total', { ...EMPTY_NOTES, '1000': '4' }, '7640.50')).toEqual({
      notes: null,
      total: '7640.50',
    });
    const empty = cashCountSchema.safeParse(countValues('total', EMPTY_NOTES, ''));
    expect(empty.error?.issues[0]?.message).toBe('pos_count_required');
    // An empty drawer is a count
    expect(cashCountSchema.safeParse(countValues('notes', EMPTY_NOTES, '')).success).toBe(true);
  });
});

describe('the result', () => {
  it('reads a difference as even, over or short', () => {
    expect(differenceKind('0.0000')).toBe('even');
    expect(differenceKind('120.0000')).toBe('over');
    expect(differenceKind('-50.0000')).toBe('short');
  });

  it('finds a shift left open since an earlier day', () => {
    expect(leftOpen('2026-10-28', '2026-10-29')).toBe(true);
    expect(leftOpen('2026-10-29', '2026-10-29')).toBe(false);
  });
});
