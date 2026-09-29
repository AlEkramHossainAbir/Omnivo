import type { AuditAction, AuditChanges, AuditEntityType, AuditValue } from '@omnivo/contracts';
import { auditLogs } from '@omnivo/db';
import { sql } from 'drizzle-orm';

import { currentRequest } from '../request/request-context.js';
import { tenantStorage } from '../tenant/tenant-context.js';
import type { Transaction } from '../tenant/with-tenant.js';

export interface AuditEvent {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  changes?: AuditChanges;
  // লগইন আর সাইনআপ public রুট — principal নেই, তাই কে করল সেটা caller বলে দেয়
  actorUserId?: string;
}

// বদলের সাথে একই transaction-এ audit রো: বদল commit হলে audit থাকবেই, rollback হলে দুটোই যায়।
// interceptor দিয়ে response-এর পরে লিখলে দুটো সমস্যা ছিল — পুরনো মান জানা যেত না, আর commit আর
// audit-এর মাঝে process পড়ে গেলে বদল থাকত কিন্তু তার কোনো রেকর্ড থাকত না
export async function audit(tx: Transaction, event: AuditEvent): Promise<void> {
  const request = currentRequest();
  await tx.insert(auditLogs).values({
    // টেন্যান্ট আসে transaction-এর নিজের context থেকে, ALS থেকে না: যে টেন্যান্টে বদলটা হচ্ছে ঠিক
    // সেখানেই audit — ভুল হওয়ার উপায় নেই। context ছাড়া ডাকলে NULL → NOT NULL-এ জোরে ভাঙে
    tenantId: sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    actorUserId: event.actorUserId ?? tenantStorage.getStore()?.principal?.userId ?? null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    payload: { changes: event.changes ?? {} },
    requestId: request?.id ?? null,
    ipAddress: request?.ipAddress ?? null,
    userAgent: request?.userAgent ?? null,
  });
}

type Snapshot = Record<string, AuditValue>;

// শুধু যা সত্যিই বদলেছে: নাম একই রেখে "Save" চাপলে audit-এ খালি changes, ভুয়া "বদল" না
export function diff(before: Snapshot, after: Snapshot): AuditChanges {
  const changes: AuditChanges = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

// নতুন কিছু তৈরি: আগে কিছু ছিল না
export function created(after: Snapshot): AuditChanges {
  return diff({}, after);
}
