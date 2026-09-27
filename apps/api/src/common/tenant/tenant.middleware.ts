import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';

import { runWithTenant } from './tenant-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    // TODO ধাপ ৩: JWT-এর tenant_id claim এলে এই header-ভিত্তিক এক্সট্র্যাকশন সরিয়ে দিন
    const header = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(header) ? header[0] : header;

    if (tenantId && UUID_RE.test(tenantId)) {
      runWithTenant(tenantId, next);
      return;
    }

    next();
  }
}