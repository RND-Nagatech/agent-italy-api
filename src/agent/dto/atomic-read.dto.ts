import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
export class AtomicReadDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(80, { each: true })
  branchIds?: string[];
  @IsOptional() @IsString() @MaxLength(64) jenisCode?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsIn(['OPEN', 'CLOS', 'all']) shipmentStatus?: 'OPEN' | 'CLOS' | 'all';
}
