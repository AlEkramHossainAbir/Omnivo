import { Module } from '@nestjs/common';

import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  // Step 26g: the storefront's photo routes use its upload and its check
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
