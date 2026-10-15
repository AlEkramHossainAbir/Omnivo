import { Controller, Header } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DocumentOutputService } from './document-output.service.js';
import { PublicDocumentsService } from './public-documents.service.js';

type Routes = typeof routes.documentOutput;
type PublicRoutes = typeof routes.publicDocuments;

@Controller()
export class DocumentOutputController {
  constructor(private readonly output: DocumentOutputService) {}

  @Endpoint(routes.documentOutput.file)
  file({ params, body }: RouteInput<Routes['file']>): Promise<RouteResponse<Routes['file']>> {
    return this.output.file(params.kind, params.id, body.language);
  }

  @Endpoint(routes.documentOutput.getFile)
  getFile({ params }: RouteInput<Routes['getFile']>): Promise<RouteResponse<Routes['getFile']>> {
    return this.output.getFile(params.kind, params.id, params.fileId);
  }

  @Endpoint(routes.documentOutput.emailDraft)
  emailDraft({
    params,
    query,
  }: RouteInput<Routes['emailDraft']>): Promise<RouteResponse<Routes['emailDraft']>> {
    return this.output.emailDraft(params.kind, params.id, query.language);
  }

  @Endpoint(routes.documentOutput.emails)
  emails({ params }: RouteInput<Routes['emails']>): Promise<RouteResponse<Routes['emails']>> {
    return this.output.emails(params.kind, params.id);
  }

  @Endpoint(routes.documentOutput.sendEmail)
  sendEmail({
    params,
    body,
  }: RouteInput<Routes['sendEmail']>): Promise<RouteResponse<Routes['sendEmail']>> {
    return this.output.sendEmail(params.kind, params.id, body);
  }

  @Endpoint(routes.documentOutput.shares)
  shares({ params }: RouteInput<Routes['shares']>): Promise<RouteResponse<Routes['shares']>> {
    return this.output.shares(params.kind, params.id);
  }

  // The link is in this answer only (decision 13): never kept by a cache
  @Endpoint(routes.documentOutput.createShare)
  @Header('Cache-Control', 'no-store')
  createShare({
    params,
    body,
  }: RouteInput<Routes['createShare']>): Promise<RouteResponse<Routes['createShare']>> {
    return this.output.createShare(params.kind, params.id, body.language);
  }

  @Endpoint(routes.documentOutput.revokeShare)
  revokeShare({ params }: RouteInput<Routes['revokeShare']>): Promise<void> {
    return this.output.revokeShare(params.kind, params.id, params.shareId);
  }
}

@Controller()
export class PublicDocumentsController {
  constructor(private readonly publicDocuments: PublicDocumentsService) {}

  // no-store, like the invitation lookup: the answer carries a signed download link, and a phone's
  // cache must not keep showing a link after it was turned off
  @Endpoint(routes.publicDocuments.get)
  @Header('Cache-Control', 'no-store')
  get({ params }: RouteInput<PublicRoutes['get']>): Promise<RouteResponse<PublicRoutes['get']>> {
    return this.publicDocuments.get(params.token);
  }
}
