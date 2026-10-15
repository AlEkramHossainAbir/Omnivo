import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { SalesModule } from '../sales/sales.module.js';
import {
  DocumentOutputController,
  PublicDocumentsController,
} from './document-output.controller.js';
import { DocumentOutputService } from './document-output.service.js';
import { DocumentFiles } from './files.js';
import { DocumentModels } from './models.service.js';
import { PublicDocumentsService } from './public-documents.service.js';

// Step 16: a document goes out — its PDF, an email, a share link and the public page behind it.
// SalesModule gives the four services whose get() the PDF's model is built from (the same reads
// as the document's page), RbacModule the PermissionService behind the send permission. The
// worker's half (drawing, sending) is in file.handler.ts and email.handler.ts.
@Module({
  imports: [SalesModule, RbacModule],
  controllers: [DocumentOutputController, PublicDocumentsController],
  providers: [DocumentModels, DocumentFiles, DocumentOutputService, PublicDocumentsService],
})
export class DocumentsModule {}
