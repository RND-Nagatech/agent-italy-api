import { IsIn } from 'class-validator';
import type { StockoutRiskHorizon } from '../stockout-risk.service';

export class StockoutRiskDto {
  @IsIn(['next-week', 'next-month'])
  horizon!: StockoutRiskHorizon;
}
