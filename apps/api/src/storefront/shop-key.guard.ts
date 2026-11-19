import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { SHOP_KEY_HEADER } from '@omnivo/contracts';
import type { FastifyRequest } from 'fastify';

import { routeOf } from '../common/http/endpoint.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { shopKeyInvalid, shopKeyMatches } from './shop-key.js';

// Step 27a: the guard of the routes the contract marks auth: 'shop' (27a's decision 13). Global,
// between AuthGuard and PermissionGuard (app.module.ts), like them read from the contract: a route
// is guarded because its contract says 'shop', never because someone remembered a decorator. Every
// other route passes straight through. It runs before the body is parsed, so a call without the
// key costs no database work and learns nothing about the shop.
@Injectable()
export class ShopKeyGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext): boolean {
    if (routeOf(context)?.auth !== 'shop') return true;
    const sent = context.switchToHttp().getRequest<FastifyRequest>().headers[SHOP_KEY_HEADER];
    // A header sent twice arrives as an array, which is no key at all
    if (
      !shopKeyMatches(typeof sent === 'string' ? sent : undefined, this.config.storefront.shopKey)
    ) {
      throw shopKeyInvalid();
    }
    return true;
  }
}
