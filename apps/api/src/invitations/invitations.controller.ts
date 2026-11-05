import { Controller, Header, Inject, Res } from '@nestjs/common';
import { type AuthSession, type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
import type { FastifyReply } from 'fastify';

import { sessionResponse } from '../auth/refresh-cookie.js';
import { Endpoint } from '../common/http/endpoint.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { InvitationsService } from './invitations.service.js';

type Routes = typeof routes.invitations;

@Controller()
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Endpoint(routes.invitations.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.invitations.list() };
  }

  @Endpoint(routes.invitations.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.invitations.create(body);
  }

  @Endpoint(routes.invitations.resend)
  resend({ params, body }: RouteInput<Routes['resend']>): Promise<RouteResponse<Routes['resend']>> {
    return this.invitations.resend(params.id, body.version);
  }

  @Endpoint(routes.invitations.revoke)
  revoke({ params, query }: RouteInput<Routes['revoke']>): Promise<void> {
    return this.invitations.revoke(params.id, query.version);
  }

  @Endpoint(routes.invitations.lookup)
  @Header('Cache-Control', 'no-store')
  lookup({ body }: RouteInput<Routes['lookup']>): Promise<RouteResponse<Routes['lookup']>> {
    return this.invitations.lookup(body.token);
  }

  // লগইনের মতোই: cookie-তে refresh token, JSON-এ access token
  @Endpoint(routes.invitations.accept)
  @Header('Cache-Control', 'no-store')
  async accept(
    { body }: RouteInput<Routes['accept']>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return sessionResponse(reply, await this.invitations.accept(body), this.config.secureCookies);
  }
}
