import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
export class KnowledgeMetadataDto {
  @IsString() @MinLength(1) @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description = '';
  @IsOptional() @IsString() @MaxLength(80) category = 'Umum';
  @IsIn(['global', 'branches']) visibility!: 'global' | 'branches';
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(80, { each: true }) branchIds!: string[];
  @IsOptional() @IsString() @MaxLength(24) replacesId?: string;
}
export class KnowledgePatchDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsIn(['global', 'branches']) visibility?: 'global' | 'branches';
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(80, { each: true }) branchIds?: string[];
}
export class KnowledgeSearchDto {
  @IsString() @MinLength(2) @MaxLength(1000) query!: string;
}
export class MemoryProposalDto {
  @IsString() @MinLength(1) @MaxLength(160) title!: string;
  @IsString() @MinLength(10) @MaxLength(4000) text!: string;
}
