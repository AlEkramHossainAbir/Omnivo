import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/http/app-error.js';
import { routeOf } from '../common/http/endpoint.js';
import { tenantStorage } from '../common/tenant/tenant-context.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Step 27a: a route the contract marks auth: 'shop' is called by the shop's server, not by a
    // person, so it has no token to look for. ShopKeyGuard, the next guard, checks its key instead
    if (routeOf(context)?.auth === 'shop') return true;

    // method-এর decorator আগে, না থাকলে class-এর
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    if (!tenantStorage.getStore()?.principal) {
      throw new AppError(401, 'sign_in_required', 'This route needs a valid access token.');
    }
    return true;
  }
}
