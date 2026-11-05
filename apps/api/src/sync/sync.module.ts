import { Module } from '@nestjs/common';

import { PosModule } from '../pos/pos.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncPushService } from './sync-push.service.js';

// Step 18a: the read half of the sync engine (devices and the pull). SyncLogCleanup is not here:
// it is the worker's (WorkerModule), on the worker's database role. Step 18b: the push, which
// runs a device's commands with the sales services (SalesModule) and checks each command's
// permission (RbacModule). Step 18c: the device lists, rename, move and revoke (DevicesController),
// which also read the person's permissions. Step 20a: the push posts a device's POS sales
// (PosModule).
@Module({
  imports: [RbacModule, SalesModule, PosModule],
  controllers: [SyncController, DevicesController],
  providers: [DevicesService, SyncService, SyncPushService],
})
export class SyncModule {}
