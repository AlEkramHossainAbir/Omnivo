import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { Auth } from '@omnivo/auth';

import { runWithPrincipal } from '../common/tenant/tenant-context.js';
import { AUTH } from '../infra/tokens.js';

// RFC 6750: `Authorization: Bearer <token>`; scheme case-insensitive
const BEARER = /^Bearer\s+(\S+)$/i;

@Injectable()
export class AuthMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  // পুরো Auth না, শুধু getPrincipal — টেস্টে DB ছাড়াই একটা verifier দিয়ে চালানো যায়
  constructor(@Inject(AUTH) private readonly auth: Pick<Auth, 'getPrincipal'>) {}

  async use(req: IncomingMessage, _res: ServerResponse, next: () => void): Promise<void> {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const principal = token ? await this.auth.getPrincipal(token) : null;

    if (principal) {
      // tenant আসে শুধু যাচাই করা টোকেন থেকে — header/body/query থেকে কখনো না
      runWithPrincipal(principal, next);
      return;
    }

    // টোকেন নেই বা ভুল: context ছাড়াই এগোনো; পাবলিক রুট চলবে, বাকিগুলো AuthGuard 401 দেবে
    next();
  }
}