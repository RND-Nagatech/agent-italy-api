import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      secret: env.jwtAccessSecret,
      signOptions: {
        algorithm: 'HS256',
        issuer: 'pantes-tracking-api',
        audience: 'pantes-tracking-client',
        expiresIn: env.accessTokenTtlSeconds,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  // AppModule registers the global access guard, which also needs JwtService.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
