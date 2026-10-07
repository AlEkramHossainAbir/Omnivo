import { Module } from '@nestjs/common';

import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BalanceAccess } from './balance-access.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomerGroupsController, CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { PriceListsController } from './price-lists.controller.js';
import { PriceListsService } from './price-lists.service.js';

// Sales (step 15): customers, their groups and the price lists in 15a; quotations, orders,
// deliveries, invoices and returns join in 15b–15d. NumberingModule gives the customer codes
// (C-00042), JournalModule the LedgerService behind a customer's statement, RbacModule the
// permission check of BalanceAccess.
@Module({
  imports: [NumberingModule, JournalModule, RbacModule],
  controllers: [CustomersController, CustomerGroupsController, PriceListsController],
  providers: [CustomersService, CustomerGroupsService, PriceListsService, BalanceAccess],
})
export class SalesModule {}
