import { BadRequestException, Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { MongoService } from '../database/mongo.service';

const DEFAULT_SAFE_STOCK_DAYS = 7;
const DEFAULT_FULFILLMENT_METHOD: DistributionFulfillmentMethod = 'branch-first';

export type DistributionFulfillmentMethod = 'branch-first' | 'even';

interface NetworkRestockSettingsDocument extends Document {
  _id: 'network-restock-settings';
  safeStockDays: number;
  fulfillmentMethod?: DistributionFulfillmentMethod;
  updatedAt: Date;
}

export interface NetworkRestockSettingsResponse {
  safeStockDays: number;
  fulfillmentMethod: DistributionFulfillmentMethod;
  updatedAt: Date | null;
}

@Injectable()
export class NetworkRestockSettingsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  async get(): Promise<NetworkRestockSettingsResponse> {
    const settings = await this.collection.findOne(
      { _id: 'network-restock-settings' },
      { projection: { safeStockDays: 1, fulfillmentMethod: 1, updatedAt: 1 } },
    );
    const safeStockDays = settings?.safeStockDays;
    return {
      safeStockDays: typeof safeStockDays === 'number'
        && Number.isInteger(safeStockDays)
        && safeStockDays >= 1
        && safeStockDays <= 365
        ? safeStockDays
        : DEFAULT_SAFE_STOCK_DAYS,
      fulfillmentMethod: settings?.fulfillmentMethod === 'even' || settings?.fulfillmentMethod === 'branch-first'
        ? settings.fulfillmentMethod
        : DEFAULT_FULFILLMENT_METHOD,
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  async getSafeStockDays(): Promise<number> {
    return (await this.get()).safeStockDays;
  }

  async update(
    safeStockDays?: number,
    fulfillmentMethod?: DistributionFulfillmentMethod,
  ): Promise<NetworkRestockSettingsResponse> {
    if (safeStockDays !== undefined && (!Number.isInteger(safeStockDays) || safeStockDays < 1 || safeStockDays > 365)) {
      throw new BadRequestException('Buffer stok aman harus bilangan bulat antara 1 dan 365 hari.');
    }
    if (fulfillmentMethod !== undefined && !['branch-first', 'even'].includes(fulfillmentMethod)) {
      throw new BadRequestException('Metode pemenuhan stok tidak valid.');
    }
    if (safeStockDays === undefined && fulfillmentMethod === undefined) {
      throw new BadRequestException('Pilih setidaknya satu pengaturan untuk disimpan.');
    }

    await this.collection.updateOne(
      { _id: 'network-restock-settings' },
      {
        $set: {
          ...(safeStockDays === undefined ? {} : { safeStockDays }),
          ...(fulfillmentMethod === undefined ? {} : { fulfillmentMethod }),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    this.cache.clearByPrefix('agent:network-restock:');
    this.cache.clearByPrefix('agent:restock:');
    this.cache.clearByPrefix('sales:stock-vs-sales:');
    return this.get();
  }

  async getFulfillmentMethod(): Promise<DistributionFulfillmentMethod> {
    return (await this.get()).fulfillmentMethod;
  }

  private get collection() {
    return this.mongo.db.collection<NetworkRestockSettingsDocument>('app_settings');
  }
}
