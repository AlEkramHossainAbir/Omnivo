import { Module } from '@nestjs/common';

import { TaxRatesController } from './tax-rates.controller.js';
import { TaxRatesService } from './tax-rates.service.js';

// The workspace's VAT rates (step 15a). Their own module, not part of sales: purchases (step 17)
// charge the same rates, and the VAT return reads them. The starting rates are made by the setup
// job and TaxRatesHandler (setup/), like the chart of accounts.
@Module({
  controllers: [TaxRatesController],
  providers: [TaxRatesService],
})
export class TaxModule {}
