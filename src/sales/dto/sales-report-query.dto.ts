import { IsBooleanString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class SalesReportQueryDto {
  @Matches(ISO_DATE)
  from!: string;

  @Matches(ISO_DATE)
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  branchId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,32}$/)
  jenisCode?: string;

  @IsOptional()
  @IsBooleanString()
  refresh?: string;
}
