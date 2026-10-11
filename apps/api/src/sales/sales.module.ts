import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BalanceAccess } from './balance-access.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomerGroupsController, CustomersController } from './customers.controller.js';
import { CreditService } from './credit.service.js';
import { CustomersService } from './customers.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { InvoicesService } from './invoices.service.js';
import { PriceListsController } from './price-lists.controller.js';
import { PriceListsService } from './price-lists.service.js';
import { PriceLookupService } from './price-lookup.service.js';
import { QuotationsService } from './quotations.service.js';
import { ReceiptsService } from './receipts.service.js';
import { SalesBooksService } from './sales-books.service.js';
import {
  DeliveriesController,
  InvoicesController,
  QuotationsController,
  ReceiptsController,
  SalesOrdersController,
  SalesPricesController,
} from './sales-documents.controller.js';
import { SalesOrdersService } from './sales-orders.service.js';

// Sales (step 15): customers, their groups and the price lists in 15a; quotations, orders,
// deliveries and the price lookup in 15b; invoices, money receipts and the credit limit in 15c;
// returns join in 15d. NumberingModule gives the codes and document numbers (C-00042, QT-, SO-,
// DC-, INV-, MR-), JournalModule the LedgerService behind a customer's statement and the
// PostingService behind SalesBooksService, RbacModule the permission checks of BalanceAccess and
// CreditService. InventoryModule (15b) gives a delivery what every stock document uses:
// StockPostingService moves the stock, StockBooksService books its cost, ValueAccess hides that
// cost without inventory.stock.value.
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
    InvoicesController,
    ReceiptsController,
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
    CreditService,
    SalesBooksService,
    InvoicesService,
    ReceiptsService,
  ],
})
export class SalesModule {}
