import {
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { Role } from '../users/roles';
import { AuthPrincipal } from '../users/user.types';
import { ListShipmentsQueryDto } from './dto/list-shipments-query.dto';
import { ShipmentDetailQueryDto } from './dto/shipment-detail-query.dto';
import { ShipmentsService } from './shipments.service';

@Controller('shipments')
@Roles(Role.Admin, Role.Central, Role.Branch)
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Post('refresh-cache')
  @Header('Cache-Control', 'no-store')
  refreshCache() {
    return this.shipments.refreshCache();
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query() query: ListShipmentsQueryDto,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.shipments.list(query, principal);
  }

  @Get(':noKirim')
  @Header('Cache-Control', 'no-store')
  detail(
    @Param('noKirim') noKirim: string,
    @Query() query: ShipmentDetailQueryDto,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.shipments.detail(noKirim, query, principal);
  }
}
