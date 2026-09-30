import { Controller, Inject } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
import { auditLogs, users } from '@omnivo/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { Endpoint } from '../common/http/endpoint.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type ListRoute = typeof routes.audit.list;

@Controller()
export class AuditController {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  @Endpoint(routes.audit.list)
  list({ query }: RouteInput<ListRoute>): Promise<RouteResponse<ListRoute>> {
    const tenantId = getTenantId();
    // cursor = [শেষ রো-র created_at, টেক্সট হিসেবে; তার id]। Date না: Postgres মাইক্রোসেকেন্ড রাখে, JS-এর
    // Date মিলিসেকেন্ড। Date-এ গোল করলে একই মিলিসেকেন্ডের পরের রো-গুলো (.123456 > .123000) "আগের পাতায়"
    // পড়ে বাদ যেত
    const after = decodeCursor(query.cursor, z.tuple([z.string().max(64), z.uuid()]));

    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          payload: auditLogs.payload,
          ipAddress: auditLogs.ipAddress,
          requestId: auditLogs.requestId,
          createdAt: auditLogs.createdAt,
          createdAtText: sql<string>`${auditLogs.createdAt}::text`,
          actorId: users.id,
          actorName: users.fullName,
        })
        .from(auditLogs)
        // users-এ RLS নেই — কিন্তু join শুধু এই টেন্যান্টের audit রো-র actor-এ, তাই বাইরের কেউ আসে না
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(
          and(
            eq(auditLogs.tenantId, tenantId),
            // `&&` না: entityId-র টাইপ string, আর '' && … মানে '' — SQL না। and() undefined বাদ দেয়
            query.entityType === undefined ? undefined : eq(auditLogs.entityType, query.entityType),
            query.entityId === undefined ? undefined : eq(auditLogs.entityId, query.entityId),
            // নতুন আগে: (created_at, id) জোড়া দিয়ে "এর চেয়ে পুরনো"; index-এর কলাম-ক্রম হুবহু এটাই।
            // ::text::timestamptz: প্যারামিটার text হয়ে হুবহু পৌঁছায়, রূপান্তর Postgres-এর ভেতরে। শুধু
            // ::timestamptz লিখলে Postgres প্যারামিটারকে timestamptz ধরে, আর খালি postgres.js সেটা JS Date
            // হয়ে পাঠায় — মাইক্রোসেকেন্ড কাটে (যাচাই করা: .123400 → .123)। drizzle নিজের driver-এ সেই
            // serializer বদলে দেয় বলে এখানে দুটোই চলে; text-cast driver-এর এই খুঁটিনাটির উপর নির্ভর করে না
            after &&
              sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${after[0]}::text::timestamptz, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(query.limit + 1);

      const page = toPage(rows, query.limit, (last) => [last.createdAtText, last.id]);
      return {
        items: page.items.map((row) => ({
          id: row.id,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          actor:
            row.actorId !== null && row.actorName !== null
              ? { id: row.actorId, fullName: row.actorName }
              : null,
          changes: row.payload?.changes ?? {},
          ipAddress: row.ipAddress,
          requestId: row.requestId,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}
