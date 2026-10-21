import { Module } from '@nestjs/common';

import { DevicesService } from './devices.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

// Step 18a: the read half of the sync engine (devices and the pull). SyncLogCleanup is not here:
// it is the worker's (WorkerModule), on the worker's database role.
@Module({
  controllers: [SyncController],
  providers: [DevicesService, SyncService],
})
export class SyncModule {}
