import { Type } from 'class-transformer';
import { BankSelectionDto } from './banking.dto';
import { PriceAuditDto } from './price-audit.dto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class AgentMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(20_000)
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsMongoId({ each: true })
  attachmentIds?: string[];
}

export class AgentChatDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceAuditDto)
  priceAudit?: PriceAuditDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BankSelectionDto)
  banking?: BankSelectionDto;

  @IsOptional()
  @IsMongoId()
  sessionId?: string;

  @IsOptional()
  @IsUUID('4')
  requestId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AgentMessageDto)
  messages!: AgentMessageDto[];
}
