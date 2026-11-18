import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
export class BranchSalesDto {
  @IsString() @MaxLength(10) from!: string;
  @IsString() @MaxLength(10) to!: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(80, { each: true }) branchIds?: string[];
  @IsOptional() @IsString() @MaxLength(80) jenisCode?: string;
  @IsOptional() @IsString() @MaxLength(80) salesCode?: string;
  @IsOptional() @IsBoolean() includeJenis?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) pageSize?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100000) jenisPage?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) jenisPageSize?: number;
}
