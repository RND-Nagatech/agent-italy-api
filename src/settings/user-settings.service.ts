import { Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { ShipmentPeriod } from '../shipments/shipment.types';

type UserSettingsDocument = Document & {
  userId: string;
  shipmentDefaultPeriod: ShipmentPeriod;
  updatedAt: Date;
};

@Injectable()
export class UserSettingsService {
  constructor(private readonly mongo: MongoService) {}

  async get(userId: string) {
    const settings = await this.collection.findOne(
      { userId },
      { projection: { shipmentDefaultPeriod: 1, updatedAt: 1 } },
    );
    return {
      shipmentDefaultPeriod: settings?.shipmentDefaultPeriod ?? ShipmentPeriod.ThisMonth,
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  async update(userId: string, shipmentDefaultPeriod: ShipmentPeriod) {
    const updatedAt = new Date();
    await this.collection.updateOne(
      { userId },
      { $set: { shipmentDefaultPeriod, updatedAt } },
      { upsert: true },
    );
    return { shipmentDefaultPeriod, updatedAt };
  }

  private get collection() {
    return this.mongo.db.collection<UserSettingsDocument>('user_settings');
  }
}
