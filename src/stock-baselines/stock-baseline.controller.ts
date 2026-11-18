import { Body, Controller, Get, Header, Patch } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { Role } from '../users/roles';
import { AuthPrincipal } from '../users/user.types';
import { StockBaselineService } from './stock-baseline.service';
class BaselineItemDto {
  @IsString() @MaxLength(64) branchId!: string;
  @IsString() @MaxLength(64) jenisCode!: string;
  @IsInt() @Min(0) @Max(1_000_000) baselinePcs!: number;
  @IsBoolean() active!: boolean;
  @IsString() @MaxLength(300) note!: string;
}
class UpdateBaselinesDto {
  @IsInt() @Min(0) revision!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => BaselineItemDto) changes!: BaselineItemDto[];
}
@Controller('stock-baselines')
@Roles(Role.Admin, Role.Central)
export class StockBaselineController {
  constructor(private readonly baselines: StockBaselineService) {}
  @Get() @Header('Cache-Control', 'no-store') get() { return this.baselines.get(); }
  @Get('history') @Header('Cache-Control', 'no-store') history() { return this.baselines.history(); }
  @Patch() @Header('Cache-Control', 'no-store') update(@Body() dto: UpdateBaselinesDto, @CurrentUser() principal: AuthPrincipal) { return this.baselines.update(dto.revision, dto.changes, principal.sub); }
}
