import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [RbacModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
