import { Body, Controller, Get, Header, Patch, Post } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { Roles } from '../common/roles.decorator';
import { Role } from '../users/roles';
import { CacheManagementService } from './cache-management.service';

class UpdateCacheSettingsDto {
  @IsInt()
  @Min(5)
  @Max(3600)
  ttlSeconds!: number;
}

@Controller('cache')
@Roles(Role.Admin)
export class CacheController {
  constructor(private readonly cache: CacheManagementService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  stats() {
    return this.cache.getStats();
  }

  @Patch('settings')
  @Header('Cache-Control', 'no-store')
  updateSettings(@Body() dto: UpdateCacheSettingsDto) {
    return this.cache.updateTtl(dto.ttlSeconds);
  }

  @Post('clear')
  @Header('Cache-Control', 'no-store')
  clear() {
    this.cache.clear();
    return this.cache.getStats();
  }
}
