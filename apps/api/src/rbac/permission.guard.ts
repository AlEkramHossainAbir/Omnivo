import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@omnivo/db';

import { AppError } from '../common/http/app-error.js';
import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { PermissionService } from './permission.service.js';
import { REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator.js';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    // AuthGuard আগে চলে, তাই এখানে principal থাকবেই; না থাকলে @Public + @RequirePermission একসাথে — bug
    const granted = await this.permissions.forPrincipal(currentPrincipal());
    const missing = required.filter((key) => !granted.has(key));
    if (missing.length > 0) {
      const permissions = missing.join(', ');
      // params: UI অনুবাদের ভেতরে কোন অনুমতি লাগবে সেটা বসায় ("You need the {{permissions}} …")
      throw new AppError(403, 'permission_missing', `Missing permission: ${permissions}.`, {
        params: { permissions },
      });
    }
    return true;
  }
}
