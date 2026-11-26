import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

class KadarOverrideDto {
  @IsMongoId() referenceId!: string;
  @IsInt() @Min(0) @Max(299) rowIndex!: number;
  @IsNumber() @Min(0.001) @Max(1000) kadar!: number;
}

export class PriceAuditScopeDto {
  @IsMongoId() sessionId!: string;
  @IsString() @MaxLength(20000) prompt!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(8) @IsMongoId({ each: true }) attachmentIds!: string[];
}
export class PriceReadDto {
  @IsMongoId() sessionId!: string;
  @IsMongoId() attachmentId!: string;
}

export class PriceWindowDto {
  @IsString() @MaxLength(10) date!: string;
  @IsString() @MaxLength(5) fromTime!: string;
  @IsString() @MaxLength(5) toTime!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(8) @IsMongoId({ each: true }) attachmentIds!: string[];
}
export class PriceAuditDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => PriceWindowDto) windows!: PriceWindowDto[];
  @IsOptional() @IsNumber() @Min(0) @Max(10000) toleranceRp?: number;
  @IsOptional() @IsBoolean() buybackRatesFinal?: boolean;
  @IsOptional() @IsBoolean() buybackAutoBatch?: boolean;
  @IsOptional() @IsBoolean() salesAutoBatch?: boolean;
  @IsOptional() @IsBoolean() salesMarketplaceOnly?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => KadarOverrideDto) kadarOverrides?: KadarOverrideDto[];
}
