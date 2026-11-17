import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { SHOP_HOST_HEADER } from '@omnivo/contracts';
import type { FastifyRequest } from 'fastify';

// The X-Shop-Host header as it came, or undefined. Node joins a header sent twice with ", ", which
// is then no host at all and gets the same 404 as any other: subdomainOf (shop-host.ts) is what
// reads it, never this
export const ShopHost = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<FastifyRequest>().headers[SHOP_HOST_HEADER];
  return typeof value === 'string' ? value : undefined;
});
