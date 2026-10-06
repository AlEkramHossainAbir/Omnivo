import { Injectable } from '@nestjs/common';

import { PermissionService } from '../rbac/permission.service.js';

// Who may see what stock costs (step 14): inventory.stock.value. Reading stock needs no permission
// (step 13), so the same answers go to everyone — with every cost and value worked out from the
// books set to null for someone without it. A shop's cashier sees how many are left, not what the
// owner paid for them. A cost a person typed on a document stays on it: it is part of the document.
@Injectable()
export class ValueAccess {
  constructor(private readonly permissions: PermissionService) {}

  async canSee(): Promise<boolean> {
    const access = await this.permissions.ofCurrentUser();
    return access.permissions.includes('inventory.stock.value');
  }
}
