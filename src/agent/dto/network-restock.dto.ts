import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PRODUCT_DISTRIBUTION_CATEGORIES, ProductDistributionCategory } from '../../sources/product-category';
import type { DistributionFulfillmentMethod } from '../../settings/network-restock-settings.service';

export class NetworkRestockDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  targetMonth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  jenisCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceBranchId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  availablePcs?: number;

  @IsOptional()
  @IsIn(PRODUCT_DISTRIBUTION_CATEGORIES)
  productCategory?: ProductDistributionCategory;

  @IsOptional()
  @IsIn(['branch-first', 'even'])
  fulfillmentMethod?: DistributionFulfillmentMethod;
}
