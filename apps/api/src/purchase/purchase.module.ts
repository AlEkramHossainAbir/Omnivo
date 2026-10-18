import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ApprovalRulesController, ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';
import { CostLookupService } from './cost-lookup.service.js';
import { PayableAccess } from './payable-access.js';
import { PurchaseCostsController, RequisitionsController } from './requisitions.controller.js';
import { RequisitionsService } from './requisitions.service.js';
import { SupplierGroupsService } from './supplier-groups.service.js';
import { SupplierGroupsController, SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

// Purchase (step 17): suppliers, their groups, the approvals engine, requisitions and the cost
// lookup in 17a. NumberingModule gives the codes and numbers (S-00042, PR-), JournalModule the
// LedgerService behind a supplier's statement, RbacModule the permission check of PayableAccess,
// InventoryModule the ValueAccess that hides the average cost without inventory.stock.value.
// The approvals engine lives here because every document that needs one is a purchase document.
@Module({
  imports: [NumberingModule, JournalModule, RbacModule, InventoryModule],
  controllers: [
    SuppliersController,
    SupplierGroupsController,
    ApprovalRulesController,
    ApprovalsController,
    RequisitionsController,
    PurchaseCostsController,
  ],
  providers: [
    SuppliersService,
    SupplierGroupsService,
    PayableAccess,
    ApprovalsService,
    RequisitionsService,
    CostLookupService,
  ],
})
export class PurchaseModule {}
