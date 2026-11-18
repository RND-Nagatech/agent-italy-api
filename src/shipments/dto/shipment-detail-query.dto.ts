import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class ShipmentDetailQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  itemLimit = 100;

  @IsOptional()
  @Matches(/^[a-fA-F0-9]{24}$/)
  itemCursor?: string;
}
