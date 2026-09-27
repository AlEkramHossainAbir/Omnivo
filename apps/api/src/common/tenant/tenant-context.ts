import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantStore {
  tenantId: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function getTenantId(): string {
  const store = tenantStorage.getStore();
  if (!store) {
    throw new Error('No tenant context — did TenantMiddleware run for this request?');
  }
  return store.tenantId;
}

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId }, fn);
}
