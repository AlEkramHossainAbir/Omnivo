import { Injectable } from '@nestjs/common';

import { PermissionService } from '../rbac/permission.service.js';

// Who may see what the company owes its suppliers (step 17a): purchase.supplier.balance. Like
// BalanceAccess for customers (step 15a): reading suppliers needs no permission, so the list and
// the detail go to everyone, with the balance set to null for someone without it.
@Injectable()
export class PayableAccess {
  constructor(private readonly permissions: PermissionService) {}

  async canSee(): Promise<boolean> {
    const access = await this.permissions.ofCurrentUser();
    return access.permissions.includes('purchase.supplier.balance');
  }
}
