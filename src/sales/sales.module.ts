import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SalesReportService } from './sales-report.service';
import { StockVsSalesService } from './stock-vs-sales.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  controllers: [SalesController],
  imports: [SettingsModule],
  providers: [SalesService, SalesReportService, StockVsSalesService],
  exports: [SalesReportService, StockVsSalesService],
})
export class SalesModule {}
