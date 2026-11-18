import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role, roleValues } from '../roles';

export class CreateUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @IsEnum(Role, { message: `role must be one of: ${roleValues.join(', ')}` })
  role!: Role;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  branchId?: string;
}
