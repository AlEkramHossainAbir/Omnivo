import { Module } from '@nestjs/common';

import { MembersController } from './members.controller.js';

@Module({
  controllers: [MembersController],
})
export class MembersModule {}
