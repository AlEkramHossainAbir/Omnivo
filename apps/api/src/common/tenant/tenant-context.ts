import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@omnivo/auth';

export interface TenantStore {
  tenantId: string;
  // HTTP request-এ AuthMiddleware বসায়; background job-এ (ধাপ ৮) শুধু tenantId থাকবে
  principal?: Principal;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function getTenantId(): string {
  const store = tenantStorage.getStore();
  if (!store) {
    throw new Error('No tenant context — did AuthMiddleware run for this request?');
  }
  return store.tenantId;
}

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId }, fn);
}

export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
  return tenantStorage.run({ tenantId: principal.tenantId, principal }, fn);
}

export function currentPrincipal(): Principal {
  const principal = tenantStorage.getStore()?.principal;
  if (!principal) {
    throw new Error('No principal — is this route marked @Public()?');
  }
  return principal;
}
