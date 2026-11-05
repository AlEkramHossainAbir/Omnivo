import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  // AuthModule: গ্রহণের সময় অ্যাকাউন্ট তৈরি/পাসওয়ার্ড যাচাই আর session — লগইনের একই কোড
  imports: [AuthModule, RbacModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
