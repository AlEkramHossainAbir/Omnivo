import { Module } from '@nestjs/common';

import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

// The API half of the setup: read the status, start it, retry it. The work itself is the worker's
// ProvisioningHandler, wired in worker/worker.module.ts.
@Module({
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
