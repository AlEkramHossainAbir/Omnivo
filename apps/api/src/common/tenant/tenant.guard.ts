import { type CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

import { tenantStorage } from './tenant-context.js';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(): boolean {
    if (!tenantStorage.getStore()) {
      throw new ForbiddenException('This route requires a tenant context (x-tenant-id header)');
    }
    return true;
  }
}