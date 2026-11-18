import { Global, Module } from '@nestjs/common';
import { CacheController } from './cache.controller';
import { CacheManagementService } from './cache-management.service';

@Global()
@Module({
  controllers: [CacheController],
  providers: [CacheManagementService],
  exports: [CacheManagementService],
})
export class CacheModule {}
