import { Inject, Injectable } from '@nestjs/common';
import type { NotificationPage } from '@omnivo/contracts';
import { notifications } from '@omnivo/db';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// Every query here filters by the signed-in user as well as the tenant. RLS only knows the tenant:
// without the user filter, anyone in the workspace could read or clear a colleague's notifications.
function mine() {
  return and(
    eq(notifications.tenantId, getTenantId()),
    eq(notifications.userId, currentPrincipal().userId),
  );
}

@Injectable()
export class NotificationsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // Newest first, keyset on (created_at, id) — the same cursor as the audit log, created_at as
  // text so the microseconds survive the round trip (see audit.controller.ts)
  list(query: { limit: number; cursor?: string | undefined }): Promise<NotificationPage> {
    const after = decodeCursor(query.cursor, z.tuple([z.string().max(64), z.uuid()]));
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({
          id: notifications.id,
          type: notifications.type,
          params: notifications.params,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
          createdAtText: sql<string>`${notifications.createdAt}::text`,
        })
        .from(notifications)
        .where(
          and(
            mine(),
            after &&
              sql`(${notifications.createdAt}, ${notifications.id}) < (${after[0]}::text::timestamptz, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1);

      const page = toPage(rows, query.limit, (last) => [last.createdAtText, last.id]);
      return {
        items: page.items.map((row) => ({
          id: row.id,
          type: row.type,
          params: row.params,
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // Served by the partial "unread" index: only unread rows are in it, so this stays cheap however
  // many old notifications a person has
  async unreadCount(): Promise<number> {
    const [row] = await this.withTenant((tx) =>
      tx
        .select({ count: count() })
        .from(notifications)
        .where(and(mine(), isNull(notifications.readAt))),
    );
    return row?.count ?? 0;
  }

  // Idempotent: marking a read notification again keeps its first read time (coalesce) and still
  // succeeds. 404 only when the row is not this user's — someone else's id looks like no id.
  async markRead(id: string): Promise<void> {
    const updated = await this.withTenant((tx) =>
      tx
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(and(mine(), eq(notifications.id, id)))
        .returning({ id: notifications.id }),
    );
    if (updated.length === 0) throw notFound('Notification');
  }

  async markAllRead(): Promise<void> {
    await this.withTenant((tx) =>
      tx
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(and(mine(), isNull(notifications.readAt))),
    );
  }
}
