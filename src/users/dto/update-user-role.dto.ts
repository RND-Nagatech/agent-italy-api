import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role, roleValues } from '../roles';

export class UpdateUserRoleDto {
  @IsEnum(Role, { message: `role must be one of: ${roleValues.join(', ')}` })
  role!: Role;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  branchId?: string;
}
