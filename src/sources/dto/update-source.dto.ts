import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSourceDto } from './create-source.dto';

export class UpdateSourceDto extends CreateSourceDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
