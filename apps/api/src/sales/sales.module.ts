import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BalanceAccess } from './balance-access.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomerGroupsController, CustomersController } from './customers.controller.js';
import { CreditNotesService } from './credit-notes.service.js';
import { CreditService } from './credit.service.js';
import { CustomersService } from './customers.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { InvoicesService } from './invoices.service.js';
import { PriceListsController } from './price-lists.controller.js';
import { PriceListsService } from './price-lists.service.js';
import { PriceLookupService } from './price-lookup.service.js';
import { QuotationsService } from './quotations.service.js';
import { ReceiptsService } from './receipts.service.js';
import { RefundsService } from './refunds.service.js';
import { SalesAccountsController } from './sales-accounts.controller.js';
import { SalesAccountsService } from './sales-accounts.service.js';
import { SalesBooksService } from './sales-books.service.js';
import {
  CreditNotesController,
  DeliveriesController,
  InvoicesController,
  QuotationsController,
  ReceiptsController,
  RefundsController,
  SalesOrdersController,
  SalesPricesController,
  SalesReturnsController,
} from './sales-documents.controller.js';
import { SalesOrdersService } from './sales-orders.service.js';
import { SalesReturnsService } from './sales-returns.service.js';

// Sales (step 15): customers, their groups and the price lists in 15a; quotations, orders,
// deliveries and the price lookup in 15b; invoices, money receipts and the credit limit in 15c;
// sales returns, credit notes, refunds and the sales returns account in 15d. NumberingModule gives
// the codes and document numbers (C-00042, QT-, SO-, DC-, INV-, MR-, SR-, CN-, RF-), JournalModule
// the LedgerService behind a customer's statement and the PostingService behind SalesBooksService,
// RbacModule the permission checks of BalanceAccess and CreditService. InventoryModule (15b) gives
// a delivery and a sales return what every stock document uses: StockPostingService moves the
// stock, StockBooksService books its cost, ValueAccess hides that cost without
// inventory.stock.value.
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
    SalesReturnsController,
    CreditNotesController,
    RefundsController,
    SalesAccountsController,
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
    SalesReturnsService,
    CreditNotesService,
    RefundsService,
    SalesAccountsService,
  ],
  // Step 16: the PDF of a quotation, an invoice, a receipt or a credit note is built from what
  // their get() returns (documents/models.service.ts)
  exports: [QuotationsService, InvoicesService, ReceiptsService, CreditNotesService],
})
export class SalesModule {}
