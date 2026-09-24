import { timestamp, uuid, integer } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

export function baseColumns() {
  return {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
    version: integer('version').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  };
}
