import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

// The home page's numbers (step 21a). RbacModule gives PermissionService: each card checks its own
// permission. The queries read other modules' tables directly, like the reports, and change nothing.
@Module({
  imports: [RbacModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
