import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ShipmentPeriod, ShipmentStatus } from '../shipment.types';

export class ListShipmentsQueryDto {
  @IsOptional()
  @IsIn(['lastInputAt', 'recordCount', 'totalWeight'])
  sortBy: 'lastInputAt' | 'recordCount' | 'totalWeight' = 'lastInputAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDirection: 'asc' | 'desc' = 'desc';

  @IsOptional()
  @IsIn(['1'])
  debug?: '1';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @IsOptional()
  @IsEnum(ShipmentPeriod)
  period?: ShipmentPeriod;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  pageSize = 20;
}
