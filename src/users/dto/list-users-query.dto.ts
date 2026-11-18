import { IsInt, IsOptional, IsString, Max, MaxLength, Min, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class ListUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsString()
  @Matches(/^[a-fA-F0-9]{24}$/)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}
