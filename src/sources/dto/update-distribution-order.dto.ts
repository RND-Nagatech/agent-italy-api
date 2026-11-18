import { ArrayMaxSize, ArrayUnique, IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateDistributionOrderDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(40, { each: true })
  X!: string[];

  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(40, { each: true })
  XB!: string[];
}
