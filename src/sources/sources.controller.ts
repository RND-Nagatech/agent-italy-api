import { Body, Controller, Get, Header, Param, Patch, Post, Put } from '@nestjs/common';
import { Roles } from '../common/roles.decorator';
import { Role } from '../users/roles';
import { CreateSourceDto } from './dto/create-source.dto';
import { UpdateSourceDto } from './dto/update-source.dto';
import { UpdateDistributionOrderDto } from './dto/update-distribution-order.dto';
import { SourcesService } from './sources.service';

@Controller('sources')
@Roles(Role.Admin)
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.sources.list();
  }

  @Get('distribution-order')
  @Header('Cache-Control', 'no-store')
  getDistributionOrder() {
    return this.sources.getDistributionOrder();
  }

  @Put('distribution-order')
  @Header('Cache-Control', 'no-store')
  updateDistributionOrder(@Body() dto: UpdateDistributionOrderDto) {
    return this.sources.updateDistributionOrder(dto);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body() dto: CreateSourceDto) {
    return this.sources.create(dto);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id') id: string, @Body() dto: UpdateSourceDto) {
    return this.sources.update(id, dto);
  }
}
