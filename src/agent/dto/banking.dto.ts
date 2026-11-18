import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

export class BankingScopeDto {
  @IsString() @MaxLength(20_000) prompt!: string;
  @IsOptional() @IsMongoId() sessionId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsMongoId({ each: true }) attachmentIds?: string[];
}

export class BankSelectionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(100, { each: true }) branchIds!: string[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(200, { each: true }) accountIds!: string[];
  @IsISO8601({ strict: true }) from!: string;
  @IsISO8601({ strict: true }) to!: string;
  @IsIn(['TRANSFER', 'ALL']) method!: 'TRANSFER' | 'ALL';
  @IsIn(['ALL', 'PENJUALAN', 'PEMBELIAN']) category!: 'ALL' | 'PENJUALAN' | 'PEMBELIAN';
  @IsArray() @ArrayMaxSize(3) @IsMongoId({ each: true }) statementIds!: string[];
}
