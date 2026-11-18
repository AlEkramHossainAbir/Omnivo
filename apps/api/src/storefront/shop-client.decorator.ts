import { isIP } from 'node:net';

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { SHOP_CLIENT_ADDRESS_HEADER } from '@omnivo/contracts';
import type { FastifyRequest } from 'fastify';

// Step 27a: the shopper's own address (27a's decision 14), for the order and /track limits. The
// shop's server sends it in SHOP_CLIENT_ADDRESS_HEADER. Only the order routes read it, and
// ShopKeyGuard has checked the shop's key before this runs, so a stranger cannot pick an address to
// be counted under. Anything that is not one IP address (a list, a name, nothing) is not used: the
// limits then count the caller itself, the shop's server, which is stricter, never looser
export const ShopClient = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  const value = request.headers[SHOP_CLIENT_ADDRESS_HEADER];
  return typeof value === 'string' && isIP(value.trim()) !== 0 ? value.trim() : request.ip;
});
