import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { IssuedTokens } from '@omnivo/auth';
import {
  type AuthSession,
  type LoginInput,
  loginInputSchema,
  type MeResponse,
  type SignUpInput,
  signUpInputSchema,
  type SwitchTenantInput,
  switchTenantInputSchema,
} from '@omnivo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './refresh-cookie.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Public()
  @Post('sign-up')
  @Header('Cache-Control', 'no-store')
  async signUp(
    @Body(new ZodValidationPipe(signUpInputSchema)) body: SignUpInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.signUp(body));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body(new ZodValidationPipe(loginInputSchema)) body: LoginInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.login(body));
  }

  // access token-এর মেয়াদ শেষ হতে পারে, তাই Public — প্রমাণ হিসেবে শুধু refresh cookie
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
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
      if (error instanceof UnauthorizedException) {
        clearRefreshCookie(reply, this.config.secureCookies);
      }
      throw error;
    }
  }

  // Public না: কে switch করছে সেটা access token বলে, আর cookie দিয়ে session rotate হয়
  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async switchTenant(
    @Body(new ZodValidationPipe(switchTenantInputSchema)) body: SwitchTenantInput,
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

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logout(request.cookies[REFRESH_COOKIE]);
    clearRefreshCookie(reply, this.config.secureCookies);
  }

  @Get('me')
  me(): Promise<MeResponse> {
    return this.authService.me(currentPrincipal());
  }

  // refresh token শুধু httpOnly cookie-তে; JSON-এ শুধু access token — JS কখনো refresh token দেখে না
  private startSession(reply: FastifyReply, tokens: IssuedTokens): AuthSession {
    setRefreshCookie(
      reply,
      tokens.refreshToken,
      tokens.refreshTokenExpiresAt,
      this.config.secureCookies,
    );
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    };
  }
}
