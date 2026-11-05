import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { AttachmentsService } from './attachments.service.js';

type Routes = typeof routes.attachments;

@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // এখন একটাই কাজ (লোগো), তাই চুক্তিতে সেটার permission। ইনভয়েসের PDF-এর মতো নতুন কাজ এলে permission
  // আসবে purpose থেকে (ATTACHMENT_RULES-এ) — তখন চুক্তির permission-এর জায়গায় service-এ চেক
  @Endpoint(routes.attachments.createUpload)
  async createUpload({
    body,
  }: RouteInput<Routes['createUpload']>): Promise<RouteResponse<Routes['createUpload']>> {
    return this.attachments.createUpload(body);
  }

  @Endpoint(routes.attachments.complete)
  complete({ params }: RouteInput<Routes['complete']>): Promise<RouteResponse<Routes['complete']>> {
    return this.attachments.complete(params.id);
  }

  @Endpoint(routes.attachments.download)
  async download({
    params,
  }: RouteInput<Routes['download']>): Promise<RouteResponse<Routes['download']>> {
    const signed = await this.attachments.download(params.id);
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
