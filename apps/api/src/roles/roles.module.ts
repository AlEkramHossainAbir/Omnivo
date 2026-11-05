import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';

@Module({
  imports: [RbacModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
