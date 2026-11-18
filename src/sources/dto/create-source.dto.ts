import { DistributionPriority, DISTRIBUTION_PRIORITIES } from '../distribution-priority';
import { ITEM_CATEGORIES, ItemCategory } from '../item-category';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateSourceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  databaseName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  alias!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  branchId!: string;

  @IsOptional()
  @IsIn(['branch', 'central'])
  sourceType?: 'branch' | 'central';

  @IsOptional()
  @IsIn(DISTRIBUTION_PRIORITIES)
  distributionPriority?: DistributionPriority;

  @IsOptional()
  @IsIn(ITEM_CATEGORIES)
  itemCategory?: ItemCategory;
}
