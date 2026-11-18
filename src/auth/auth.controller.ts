import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Header,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Throttle } from '@nestjs/throttler';
import { env } from '../config/env';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthPrincipal } from '../users/user.types';
import { Public } from '../common/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

type RequestWithCookies = FastifyRequest & { cookies: Record<string, string | undefined> };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login(dto.email, dto.password);
    this.setSessionCookies(reply, result.refreshCookie, result.csrfToken);
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(
    @Req() request: RequestWithCookies,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.refresh(
      request.cookies.pnt_refresh,
      request.cookies.pnt_csrf,
      readHeaderToken(request.headers['x-csrf-token']),
    );
    this.setSessionCookies(reply, result.refreshCookie, result.csrfToken);
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async logout(
    @Req() request: RequestWithCookies,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(
      request.cookies.pnt_refresh,
      request.cookies.pnt_csrf,
      readHeaderToken(request.headers['x-csrf-token']),
    );
    this.clearSessionCookies(reply);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  async me(@CurrentUser() currentUser: AuthPrincipal) {
    return this.auth.getCurrentUser(currentUser.sub);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @CurrentUser() currentUser: AuthPrincipal,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.changePassword(currentUser.sub, dto.currentPassword, dto.newPassword);
    this.clearSessionCookies(reply);
  }

  private setSessionCookies(reply: FastifyReply, refreshCookie: string, csrfToken: string): void {
    const sharedOptions = {
      secure: env.isProduction,
      sameSite: 'strict' as const,
      path: '/',
      maxAge: env.refreshTokenTtlDays * 24 * 60 * 60,
    };
    reply.setCookie('pnt_refresh', refreshCookie, {
      ...sharedOptions,
      httpOnly: true,
      path: '/api/v1/auth',
    });
    reply.setCookie('pnt_csrf', csrfToken, {
      ...sharedOptions,
      httpOnly: false,
    });
  }

  private clearSessionCookies(reply: FastifyReply): void {
    const sharedOptions = {
      secure: env.isProduction,
      sameSite: 'strict' as const,
    };
    reply.clearCookie('pnt_refresh', { ...sharedOptions, path: '/api/v1/auth' });
    reply.clearCookie('pnt_csrf', { ...sharedOptions, path: '/' });
  }
}

function readHeaderToken(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
