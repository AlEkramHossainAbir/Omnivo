import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MeController } from './me.controller.js';
import { VerificationLimits } from './verification-limits.js';

@Module({
  imports: [RbacModule],
  controllers: [AuthController, MeController],
  providers: [AuthService, VerificationLimits],
  exports: [AuthService],
})
export class AuthModule {}
