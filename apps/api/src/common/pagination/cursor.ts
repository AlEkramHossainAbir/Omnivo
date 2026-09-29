import type { z } from 'zod';

import { AppError } from '../http/app-error.js';

// cursor = শেষ রো-র sort-কলামগুলোর মান, JSON → base64url। ক্লায়েন্টের কাছে অস্বচ্ছ; ভেতরের আকার
// বদলালেও (নতুন sort কলাম) ক্লায়েন্টের কোড বদলাতে হয় না
export function encodeCursor(values: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

// ক্লায়েন্টের পাঠানো cursor বিশ্বাস করা হয় না: schema দিয়ে যাচাই। নাহলে ভাঙা uuid সোজা SQL-এ
// গিয়ে Postgres-এর cast error → 500 হতো, 400 না
export function decodeCursor<TSchema extends z.ZodType>(
  cursor: string | undefined,
  schema: TSchema,
): z.output<TSchema> | undefined {
  if (cursor === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = schema.safeParse(json);
  if (!result.success) throw invalidCursor();
  return result.data;
}

// limit + 1টা রো আনা হয়: একটা বেশি পেলে বোঝা যায় পরের পাতা আছে — আলাদা COUNT(*) লাগে না
export function toPage<TRow>(
  rows: TRow[],
  limit: number,
  cursorOf: (last: TRow) => readonly unknown[],
): { items: TRow[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}
