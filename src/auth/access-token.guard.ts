import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { AuthPrincipal } from '../users/user.types';
import { Role } from '../users/roles';

type AuthenticatedRequest = FastifyRequest & { user: AuthPrincipal };

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Authentication required');
    }

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        role: Role;
        branchId: string | null;
        type: string;
      }>(token, {
        secret: env.jwtAccessSecret,
        issuer: 'pantes-tracking-api',
        audience: 'pantes-tracking-client',
        algorithms: ['HS256'],
      });

      if (
        payload.type !== 'access' ||
        typeof payload.sub !== 'string' ||
        !Object.values(Role).includes(payload.role)
      ) {
        throw new UnauthorizedException('Invalid access token');
      }

      request.user = {
        sub: payload.sub,
        role: payload.role,
        branchId: typeof payload.branchId === 'string' ? payload.branchId : null,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
