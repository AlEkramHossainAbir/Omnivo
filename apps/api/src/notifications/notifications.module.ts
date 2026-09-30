import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

// Reading and clearing notifications. Creating them is the worker's job (notify.ts), inside the
// same transaction as the work they report on.
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
