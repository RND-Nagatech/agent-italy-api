import { BadRequestException, Controller, Get, Header, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { Role } from '../users/roles';
import { AuthPrincipal } from '../users/user.types';
import { SalesSummaryQueryDto } from './dto/sales-summary-query.dto';
import { SalesReportQueryDto } from './dto/sales-report-query.dto';
import { SalesService } from './sales.service';
import { SalesReportError, SalesReportService } from './sales-report.service';
import { StockVsSalesService } from './stock-vs-sales.service';

@Controller('sales')
@Roles(Role.Admin, Role.Central, Role.Branch)
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly salesReport: SalesReportService,
    private readonly stockVsSales: StockVsSalesService,
  ) {}

  @Get('summary')
  @Header('Cache-Control', 'no-store')
  summary(
    @Query() query: SalesSummaryQueryDto,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.sales.summary(query, principal);
  }

  @Get('report')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 6, ttl: 60_000, getTracker: salesUserTracker } })
  async report(
    @Query() query: SalesReportQueryDto,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    try {
      const { refresh, ...reportQuery } = query;
      return await this.salesReport.report(reportQuery, principal, refresh === 'true');
    } catch (error) {
      if (error instanceof SalesReportError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get('stock-vs-sales')
  @Header('Cache-Control', 'no-store')
  stockVsSalesAnalysis(
    @CurrentUser() principal: AuthPrincipal,
    @Query('refresh') refresh?: string,
  ) {
    return this.stockVsSales.analyze(principal, refresh === 'true');
  }
}

function salesUserTracker(request: Record<string, unknown>): string {
  const user = request.user;
  if (typeof user === 'object' && user !== null && 'sub' in user && typeof user.sub === 'string') {
    return `user:${user.sub}`;
  }
  return typeof request.ip === 'string' ? request.ip : 'unknown';
}
