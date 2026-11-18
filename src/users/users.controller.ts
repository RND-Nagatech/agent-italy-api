import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { AuthPrincipal } from './user.types';
import { Role } from './roles';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UsersService } from './users.service';

@Controller('users')
@Roles(Role.Admin)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() currentUser: AuthPrincipal,
  ) {
    return this.users.update(id, dto, currentUser.sub);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  remove(@Param('id') id: string, @CurrentUser() currentUser: AuthPrincipal) {
    return this.users.remove(id, currentUser.sub);
  }

  @Patch(':id/role')
  @Header('Cache-Control', 'no-store')
  updateRole(@Param('id') id: string, @Body() dto: UpdateUserRoleDto) {
    return this.users.updateRole(id, dto);
  }

  @Patch(':id/status')
  @Header('Cache-Control', 'no-store')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() actor: AuthPrincipal,
  ) {
    return this.users.updateStatus(id, dto.active, actor.sub);
  }
}
