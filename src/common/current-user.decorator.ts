import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthPrincipal } from '../users/user.types';

type AuthenticatedRequest = FastifyRequest & { user: AuthPrincipal };

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPrincipal =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
