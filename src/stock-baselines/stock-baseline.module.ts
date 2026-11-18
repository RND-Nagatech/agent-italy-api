import { Module } from '@nestjs/common';
import { StockBaselineService } from './stock-baseline.service';
import { StockBaselineController } from './stock-baseline.controller';
@Module({ providers: [StockBaselineService], controllers: [StockBaselineController], exports: [StockBaselineService] })
export class StockBaselineModule {}
