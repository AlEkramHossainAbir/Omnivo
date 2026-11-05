import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { AppError } from '../http/app-error.js';
import { decodeCursor, encodeCursor, toPage } from './cursor.js';

const position = z.tuple([z.string(), z.uuid()]);
const id = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c3d';

describe('cursor', () => {
  it('round-trips the position of the last row', () => {
    const cursor = encodeCursor(['Farhana Rahman', id]);
    expect(decodeCursor(cursor, position)).toEqual(['Farhana Rahman', id]);
  });

  it('means "first page" when there is no cursor', () => {
    expect(decodeCursor(undefined, position)).toBeUndefined();
  });

  it('rejects a tampered cursor with a 400, never letting it reach SQL', () => {
    for (const cursor of ['not-base64-json', encodeCursor(['Farhana', 'not-a-uuid'])]) {
      expect(() => decodeCursor(cursor, position)).toThrow(AppError);
    }
  });
});

describe('toPage', () => {
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];

  it('uses the extra row only to know that another page exists', () => {
    const page = toPage(rows, 2, (last) => [last.n]);
    expect(page.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decodeCursor(page.nextCursor ?? undefined, z.tuple([z.number()]))).toEqual([2]);
  });

  it('ends the list with a null cursor', () => {
    expect(toPage(rows, 3, (last) => [last.n]).nextCursor).toBeNull();
  });
});
