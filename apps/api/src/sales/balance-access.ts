import { Injectable } from '@nestjs/common';

import { PermissionService } from '../rbac/permission.service.js';

// Who may see what customers owe (step 15a): sales.customer.balance. Reading customers needs no
// permission — every sales document picks one — so the list and the detail go to everyone, with
// the balance set to null for someone without it. Like ValueAccess for stock values (step 14).
@Injectable()
export class BalanceAccess {
  constructor(private readonly permissions: PermissionService) {}

  async canSee(): Promise<boolean> {
    const access = await this.permissions.ofCurrentUser();
    return access.permissions.includes('sales.customer.balance');
  }
}
