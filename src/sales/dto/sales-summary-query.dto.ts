import { IsEnum, IsOptional } from 'class-validator';
import { ShipmentPeriod } from '../../shipments/shipment.types';

export class SalesSummaryQueryDto {
  @IsOptional()
  @IsEnum(ShipmentPeriod)
  period?: ShipmentPeriod;
}
