import { IsEnum } from 'class-validator';
import { ShipmentPeriod } from '../../shipments/shipment.types';

export class UpdateUserSettingsDto {
  @IsEnum(ShipmentPeriod)
  shipmentDefaultPeriod!: ShipmentPeriod;
}
