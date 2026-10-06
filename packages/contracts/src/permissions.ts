// সিস্টেম-জোড়া permission-এর একমাত্র তালিকা। API-র guard, DB-র catalog, UI-র matrix আর অনুবাদ —
// সবাই এখান থেকে টাইপ পায়। নতুন permission = এখানে এক লাইন + en.ts/bn.ts-এ তার লেখা (না লিখলে
// typecheck fail) + packages/db-র বিবরণ। নাম: module.resource.action (system-design §৩.১০)
export const PERMISSION_KEYS = [
  'core.user.read',
  'core.user.invite',
  'core.user.manage',
  'core.role.manage',
  'core.settings.manage',
  'core.branch.manage',
  'core.audit.read',
  'accounting.account.manage',
  'accounting.journal.read',
  'accounting.journal.create',
  'accounting.journal.post',
  'accounting.period.close',
  'accounting.report.read',
  'inventory.product.manage',
  'inventory.warehouse.manage',
  'inventory.stock.adjust',
  'inventory.stock.transfer',
  'inventory.stock.value',
  'inventory.stock.revalue',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// me.permissions আর role.permissions তারে z.string() (নতুন সার্ভারের নতুন key পুরনো অফলাইন ক্লায়েন্টে
// parse ভাঙে না) — UI এই guard দিয়ে চেনা key-তে নামায়, cast ছাড়া
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEYS.some((key) => key === value);
}

// matrix-এর সারি কোন দলে: key-র মাঝের অংশ (resource) দিয়ে না, হাতে বাছা — "Team" দলে user আর role
// দুটোই থাকে, কারণ মানুষ দুটোকে একই কাজ ভাবে। Record<PermissionKey, …>: নতুন key দল ছাড়া থাকতে পারে না
export const PERMISSION_GROUPS = ['team', 'workspace', 'accounting', 'inventory'] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export const PERMISSION_GROUP_OF = {
  'core.user.read': 'team',
  'core.user.invite': 'team',
  'core.user.manage': 'team',
  'core.role.manage': 'team',
  'core.settings.manage': 'workspace',
  'core.branch.manage': 'workspace',
  'core.audit.read': 'workspace',
  'accounting.account.manage': 'accounting',
  'accounting.journal.read': 'accounting',
  'accounting.journal.create': 'accounting',
  'accounting.journal.post': 'accounting',
  'accounting.period.close': 'accounting',
  'accounting.report.read': 'accounting',
  'inventory.product.manage': 'inventory',
  'inventory.warehouse.manage': 'inventory',
  'inventory.stock.adjust': 'inventory',
  'inventory.stock.transfer': 'inventory',
  'inventory.stock.value': 'inventory',
  'inventory.stock.revalue': 'inventory',
} as const satisfies Record<PermissionKey, PermissionGroup>;
