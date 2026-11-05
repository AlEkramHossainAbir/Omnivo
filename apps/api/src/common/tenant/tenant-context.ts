import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@omnivo/auth';

export interface TenantStore {
  tenantId: string;
  // HTTP request-এ AuthMiddleware বসায়; background job-এ (ধাপ ৮) শুধু tenantId থাকবে
  principal?: Principal;
  // Step 18b: the device a sync command came from. The audit rows its work writes carry it.
  deviceId?: string;
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

// Step 18b: run one pushed command as the device's work. The tenant and the person stay as they
// are; only the device is added, so every audit row the command's services write names it without
// each service passing it on.
export function runFromDevice<T>(deviceId: string, fn: () => T): T {
  const store = tenantStorage.getStore();
  if (!store) throw new Error('No tenant context — runFromDevice needs a signed-in request');
  return tenantStorage.run({ ...store, deviceId }, fn);
}

export function currentDeviceId(): string | null {
  return tenantStorage.getStore()?.deviceId ?? null;
}
