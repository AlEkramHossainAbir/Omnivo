import { Module } from '@nestjs/common';

import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';

// The workspace's own fields (system-design §4.8). Products use them from step 12; customers and
// suppliers will, when they come. The values are checked where each record is saved.
@Module({
  controllers: [CustomFieldsController],
  providers: [CustomFieldsService],
})
export class CustomFieldsModule {}
