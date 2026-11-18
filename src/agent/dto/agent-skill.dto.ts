import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

const skillRoles = ['admin', 'pusat', 'cabang'] as const;

export class CreateAgentSkillDto {
  @IsString()
  @Length(2, 80)
  name!: string;

  @IsString()
  @MaxLength(240)
  description!: string;

  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  triggerKeywords!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn(skillRoles, { each: true })
  roles!: Array<(typeof skillRoles)[number]>;

  @IsString()
  @Length(10, 4_000)
  instructions!: string;

  @IsBoolean()
  alwaysApply!: boolean;

  @IsBoolean()
  enabled!: boolean;
}

export class UpdateAgentSkillDto {
  @IsOptional() @IsString() @Length(2, 80)
  name?: string;

  @IsOptional() @IsString() @MaxLength(240)
  description?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(64, { each: true })
  triggerKeywords?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsIn(skillRoles, { each: true })
  roles?: Array<(typeof skillRoles)[number]>;

  @IsOptional() @IsString() @Length(10, 4_000)
  instructions?: string;

  @IsOptional() @IsBoolean()
  alwaysApply?: boolean;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}
