import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role, roleValues } from '../roles';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsEnum(Role, { message: `role must be one of: ${roleValues.join(', ')}` })
  role?: Role;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  branchId?: string;
}
