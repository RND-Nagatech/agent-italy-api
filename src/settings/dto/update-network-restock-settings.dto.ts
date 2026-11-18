import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { DistributionFulfillmentMethod } from '../network-restock-settings.service';

export class UpdateNetworkRestockSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  safeStockDays?: number;

  @IsOptional()
  @IsIn(['branch-first', 'even'])
  fulfillmentMethod?: DistributionFulfillmentMethod;
}
