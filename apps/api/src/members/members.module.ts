import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [RbacModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
