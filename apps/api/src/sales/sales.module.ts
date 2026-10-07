import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BalanceAccess } from './balance-access.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomerGroupsController, CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { PriceListsController } from './price-lists.controller.js';
import { PriceListsService } from './price-lists.service.js';
import { PriceLookupService } from './price-lookup.service.js';
import { QuotationsService } from './quotations.service.js';
import {
  DeliveriesController,
  QuotationsController,
  SalesOrdersController,
  SalesPricesController,
} from './sales-documents.controller.js';
import { SalesOrdersService } from './sales-orders.service.js';

// Sales (step 15): customers, their groups and the price lists in 15a; quotations, orders,
// deliveries and the price lookup in 15b; invoices and returns join in 15c–15d. NumberingModule
// gives the codes and document numbers (C-00042, QT-, SO-, DC-), JournalModule the LedgerService
// behind a customer's statement, RbacModule the permission check of BalanceAccess. InventoryModule
// (15b) gives a delivery what every stock document uses: StockPostingService moves the stock,
// StockBooksService books its cost, ValueAccess hides that cost without inventory.stock.value.
@Module({
  imports: [NumberingModule, JournalModule, RbacModule, InventoryModule],
  controllers: [
    CustomersController,
    CustomerGroupsController,
    PriceListsController,
    SalesPricesController,
    QuotationsController,
    SalesOrdersController,
    DeliveriesController,
  ],
  providers: [
    CustomersService,
    CustomerGroupsService,
    PriceListsService,
    BalanceAccess,
    PriceLookupService,
    QuotationsService,
    SalesOrdersService,
    DeliveriesService,
  ],
})
export class SalesModule {}
