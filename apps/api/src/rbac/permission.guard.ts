import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { accessRevoked, AppError } from '../common/http/app-error.js';
import { routeOf } from '../common/http/endpoint.js';
import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { PermissionService } from './permission.service.js';

// AuthGuard-এর পরে চলে (app.module.ts-এর ক্রম): সেখানে "টোকেন আছে কি না", এখানে "এই workspace-এ এখনো
// আছে কি না, আর এই কাজের অনুমতি আছে কি না"। কোন permission লাগবে সেটা চুক্তিতে (route.permission) —
// আলাদা decorator নেই, তাই চুক্তি, OpenAPI আর আসল পাহারা কখনো আলাদা হতে পারে না
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly permissions: PermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = routeOf(context);
    // চুক্তির বাইরের রুট (/docs) আর public রুট (লগইন) — এখানে দেখার কিছু নেই
    if (!route || route.auth === 'public') return true;

    // প্রতিটা লগইন-করা request-এ, permission চাক বা না চাক: বাদ পড়া সদস্যের টোকেন আরও ১৫ মিনিট বৈধ,
    // কিন্তু সে সেই সময়ে ব্রাঞ্চের তালিকাও পড়তে পারবে না। দাম: প্রতি request-এ একটা Redis GET
    const access = await this.permissions.forPrincipal(currentPrincipal());
    if (!access) throw accessRevoked();

    if (route.permission !== undefined && !access.permissions.includes(route.permission)) {
      // params: UI অনুবাদের ভেতরে কোন অনুমতি লাগবে সেটা বসায় ("You need the {{permissions}} …")
      throw new AppError(403, 'permission_missing', `Missing permission: ${route.permission}.`, {
        params: { permissions: route.permission },
      });
    }
    return true;
  }
}
