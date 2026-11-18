import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';

export class CleaningMinimumStockItemDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,63}$/)
  kodeDept!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  minimumStock!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1_000_000)
  minimumWeight?: number;
}

export class UpdateCleaningPrioritySettingsDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => CleaningMinimumStockItemDto)
  items!: CleaningMinimumStockItemDto[];
}
