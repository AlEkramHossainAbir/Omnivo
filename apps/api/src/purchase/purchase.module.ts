import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ApprovalRulesController, ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';
import {
  BillsController,
  PurchaseAccountsController,
  SupplierPaymentsController,
} from './bills.controller.js';
import { BillsService } from './bills.service.js';
import { CostLookupService } from './cost-lookup.service.js';
import { GoodsReceiptsService } from './goods-receipts.service.js';
import { PayableAccess } from './payable-access.js';
import { PurchaseAccountsService } from './purchase-accounts.service.js';
import { PurchaseBooksService } from './purchase-books.service.js';
import { GoodsReceiptsController, PurchaseOrdersController } from './purchase-orders.controller.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { PurchaseCostsController, RequisitionsController } from './requisitions.controller.js';
import { RequisitionsService } from './requisitions.service.js';
import { SupplierGroupsService } from './supplier-groups.service.js';
import { SupplierPaymentsService } from './supplier-payments.service.js';
import { SupplierGroupsController, SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

// Purchase (step 17): suppliers, their groups, the approvals engine, requisitions and the cost
// lookup in 17a; purchase orders and goods receipts in 17b; bills, supplier payments and Settings →
// Purchase in 17c. NumberingModule gives the codes and numbers (S-00042, PR-, PO-, GRN-, BILL-,
// PV-), JournalModule the LedgerService behind a supplier's statement and the PostingService behind
// PurchaseBooksService, RbacModule the permission check of PayableAccess, InventoryModule the
// ValueAccess that hides the average cost without inventory.stock.value and, for the goods receipt
// (and a bill's own goods), the stock posting and its books. The approvals engine lives here because every document that needs one is
// a purchase document. PurchaseOrdersService is exported for the documents module (its PDF).
@Module({
  imports: [NumberingModule, JournalModule, RbacModule, InventoryModule],
  controllers: [
    SuppliersController,
    SupplierGroupsController,
    ApprovalRulesController,
    ApprovalsController,
    RequisitionsController,
    PurchaseCostsController,
    PurchaseOrdersController,
    GoodsReceiptsController,
    BillsController,
    SupplierPaymentsController,
    PurchaseAccountsController,
  ],
  providers: [
    SuppliersService,
    SupplierGroupsService,
    PayableAccess,
    ApprovalsService,
    RequisitionsService,
    CostLookupService,
    PurchaseOrdersService,
    GoodsReceiptsService,
    PurchaseBooksService,
    PurchaseAccountsService,
    BillsService,
    SupplierPaymentsService,
  ],
  exports: [PurchaseOrdersService],
})
export class PurchaseModule {}
