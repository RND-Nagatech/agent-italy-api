import { KnowledgeModule } from './knowledge/knowledge.module';
import { AgentUsageModule } from './agent-usage/agent-usage.module';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { AccessTokenGuard } from './auth/access-token.guard';
import { RolesGuard } from './common/roles.guard';
import { MongoModule } from './database/mongo.module';
import { HealthController } from './health.controller';
import { UsersModule } from './users/users.module';
import { ShipmentsModule } from './shipments/shipments.module';
import { CacheModule } from './cache/cache.module';
import { SourcesModule } from './sources/sources.module';
import { SettingsModule } from './settings/settings.module';
import { SalesModule } from './sales/sales.module';
import { AgentModule } from './agent/agent.module';

@Module({
  imports: [
    MongoModule,
    AuthModule,
    UsersModule,
    ShipmentsModule,
    CacheModule,
    SourcesModule,
    SettingsModule,
    SalesModule,
    AgentModule,
    KnowledgeModule,
    AgentUsageModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
