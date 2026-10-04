import { Injectable } from '@nestjs/common';
import type { OutboxEventType } from '@omnivo/db';

import type { EventHandler } from '../common/outbox/outbox.js';
import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
import { ProductImportHandler } from '../products/import.handler.js';
import { ReportExportHandler } from '../reports/export.handler.js';
import { CatalogHandler } from '../setup/catalog.handler.js';
import { ChartHandler } from '../setup/chart.handler.js';
import { ProvisioningHandler } from '../setup/provisioning.handler.js';
import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';

// Which handler runs for which event — the one place to look. The mapped type ties each key to a
// handler of exactly that event, so wiring the invitation handler to 'member.joined' (or leaving
// an event out) does not compile. One handler per event for now; when an event needs a second
// consumer, the value becomes a list and the job id gets the handler's name.
type HandlerMap = { [T in OutboxEventType]: EventHandler<T> };

@Injectable()
export class EventHandlers {
  private readonly byType: HandlerMap;

  constructor(
    welcome: WelcomeEmailHandler,
    provisioning: ProvisioningHandler,
    invitationEmail: InvitationEmailHandler,
    memberJoined: MemberJoinedHandler,
    chart: ChartHandler,
    reportExport: ReportExportHandler,
    catalog: CatalogHandler,
    productImport: ProductImportHandler,
  ) {
    this.byType = {
      'workspace.created': welcome,
      'workspace.setup_requested': provisioning,
      'invitation.issued': invitationEmail,
      'member.joined': memberJoined,
      'workspace.chart_requested': chart,
      'report.export_requested': reportExport,
      'workspace.catalog_requested': catalog,
      'product.import_requested': productImport,
    };
  }

  for<T extends OutboxEventType>(type: T): EventHandler<T> {
    return this.byType[type];
  }
}
