import { BadRequestException, Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { MongoService } from '../database/mongo.service';

export interface CleaningMinimumStock {
  kodeDept: string;
  minimumStock: number;
  minimumWeight: number;
}

interface CleaningPrioritySettingsDocument extends Document {
  _id: 'cleaning-priority-minimum-stocks';
  items: CleaningMinimumStock[];
  updatedAt: Date;
}

interface DepartmentDocument extends Document {
  kode_dept?: unknown;
  nama_dept?: unknown;
}

export interface CleaningPrioritySettingsResponse {
  items: Array<CleaningMinimumStock & { namaDept: string }>;
  availableJenis: Array<{ kode: string; nama: string }>;
  centralSourceAvailable: boolean;
  updatedAt: Date | null;
}

@Injectable()
export class CleaningPrioritySettingsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  async get(): Promise<CleaningPrioritySettingsResponse> {
    const [settings, central] = await Promise.all([
      this.collection.findOne({ _id: 'cleaning-priority-minimum-stocks' }),
      this.mongo.db.collection('shipment_sources').findOne(
        { active: true, sourceType: 'central' },
        { projection: { databaseName: 1 } },
      ),
    ]);

    let availableJenis: Array<{ kode: string; nama: string }> = [];
    if (central && typeof central.databaseName === 'string') {
      try {
        const rows = await this.mongo.getDatabase(central.databaseName)
          .collection<DepartmentDocument>('tm_dept')
          .find({ kode_dept: { $type: 'string', $ne: '' } }, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
          .limit(500)
          .toArray();
        const departments = new Map<string, string>();
        for (const row of rows) {
          if (typeof row.kode_dept !== 'string') continue;
          const code = row.kode_dept.trim();
          if (!code) continue;
          const name = decryptDepartmentName(row.nama_dept) ?? code;
          departments.set(code, name);
        }
        availableJenis = [...departments]
          .map(([kode, nama]) => ({ kode, nama }))
          .sort((left, right) => left.kode.localeCompare(right.kode));
      } catch {
        availableJenis = [];
      }
    }

    const names = new Map(availableJenis.map((item) => [item.kode, item.nama]));
    const items = (settings?.items ?? []).map((item) => ({
      kodeDept: item.kodeDept,
      namaDept: names.get(item.kodeDept) ?? item.kodeDept,
      minimumStock: item.minimumStock,
      minimumWeight: item.minimumWeight ?? 0,
    }));

    return {
      items,
      availableJenis,
      centralSourceAvailable: Boolean(central),
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  async getConfiguredMinimums(): Promise<CleaningMinimumStock[]> {
    const settings = await this.collection.findOne(
      { _id: 'cleaning-priority-minimum-stocks' },
      { projection: { items: 1 } },
    );
    return (settings?.items ?? []).map(({ kodeDept, minimumStock, minimumWeight }) => ({
      kodeDept,
      minimumStock,
      minimumWeight: minimumWeight ?? 0,
    }));
  }

  async update(items: Array<Pick<CleaningMinimumStock, 'kodeDept' | 'minimumStock'> & { minimumWeight?: number }>): Promise<CleaningPrioritySettingsResponse> {
    if (items.length > 300) throw new BadRequestException('Maksimal 300 Jenis dapat diatur.');
    const normalized = items.map(({ kodeDept, minimumStock, minimumWeight }) => ({
      kodeDept: kodeDept.trim(),
      minimumStock,
      minimumWeight: minimumWeight ?? 0,
    }));
    const codes = new Set<string>();
    for (const item of normalized) {
      if (!item.kodeDept || !Number.isSafeInteger(item.minimumStock) || item.minimumStock < 1 || item.minimumStock > 1_000_000) {
        throw new BadRequestException('Kode Jenis dan batas stok minimum tidak valid. Batas harus bilangan bulat 1 sampai 1.000.000.');
      }
      if (!Number.isFinite(item.minimumWeight) || item.minimumWeight < 0 || item.minimumWeight > 1_000_000 || Number(item.minimumWeight.toFixed(3)) !== item.minimumWeight) {
        throw new BadRequestException('Batas berat minimum harus angka 0 sampai 1.000.000 dengan maksimal 3 angka desimal.');
      }
      if (codes.has(item.kodeDept)) throw new BadRequestException(`Kode Jenis ${item.kodeDept} tidak boleh diatur lebih dari sekali.`);
      codes.add(item.kodeDept);
    }

    const updatedAt = new Date();
    await this.collection.updateOne(
      { _id: 'cleaning-priority-minimum-stocks' },
      { $set: { items: normalized, updatedAt } },
      { upsert: true },
    );
    this.cache.clearByPrefix('agent:cleaning-priority:');
    return this.get();
  }

  private get collection() {
    return this.mongo.db.collection<CleaningPrioritySettingsDocument>('app_settings');
  }
}
