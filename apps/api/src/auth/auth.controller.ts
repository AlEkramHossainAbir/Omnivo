import { Controller, Header, Inject, Req, Res } from '@nestjs/common';
import type { IssuedTokens } from '@omnivo/auth';
import { type AuthSession, type MeResponse, type RouteInput, routes } from '@omnivo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../common/http/app-error.js';
import { Endpoint } from '../common/http/endpoint.js';
import { currentPrincipal } from '../common/tenant/tenant-context.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { AuthService } from './auth.service.js';
import { clearRefreshCookie, REFRESH_COOKIE, sessionResponse } from './refresh-cookie.js';

// path আর status চুক্তিতে (routes.auth.*), তাই @Controller()-এ prefix নেই
@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Endpoint(routes.auth.signUp)
  @Header('Cache-Control', 'no-store')
  async signUp(
    { body }: RouteInput<typeof routes.auth.signUp>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.signUp(body));
  }

  @Endpoint(routes.auth.login)
  @Header('Cache-Control', 'no-store')
  async login(
    { body }: RouteInput<typeof routes.auth.login>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.login(body));
  }

  @Endpoint(routes.auth.refresh)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    try {
      return this.startSession(
        reply,
        await this.authService.refresh(request.cookies[REFRESH_COOKIE]),
      );
    } catch (error) {
      // অচল cookie ব্রাউজারে রেখে লাভ নেই; কিন্তু DB down-এর মতো 5xx-এ cookie রেখে দেওয়া
      if (error instanceof AppError && error.status === 401) {
        clearRefreshCookie(reply, this.config.secureCookies);
      }
      throw error;
    }
  }

  // bearer: কে switch করছে সেটা access token বলে, আর cookie দিয়ে session rotate হয়
  @Endpoint(routes.auth.switchTenant)
  @Header('Cache-Control', 'no-store')
  async switchTenant(
    { body }: RouteInput<typeof routes.auth.switchTenant>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const tokens = await this.authService.switchTenant(
      currentPrincipal(),
      request.cookies[REFRESH_COOKIE],
      body.tenantId,
    );
    return this.startSession(reply, tokens);
  }

  @Endpoint(routes.auth.logout)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logout(request.cookies[REFRESH_COOKIE]);
    clearRefreshCookie(reply, this.config.secureCookies);
  }

  @Endpoint(routes.auth.me)
  me(): Promise<MeResponse> {
    return this.authService.me(currentPrincipal());
  }

  private startSession(reply: FastifyReply, tokens: IssuedTokens): AuthSession {
    return sessionResponse(reply, tokens, this.config.secureCookies);
  }
}
