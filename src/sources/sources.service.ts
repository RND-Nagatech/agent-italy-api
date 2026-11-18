import { CacheManagementService } from '../cache/cache-management.service';
import { DISTRIBUTION_PRIORITIES, DistributionPriority, normalizeDistributionPriority } from './distribution-priority';
import { inferItemCategory, ItemCategory, ITEM_CATEGORIES, normalizeItemCategory } from './item-category';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { CreateSourceDto } from './dto/create-source.dto';
import { UpdateSourceDto } from './dto/update-source.dto';
import { AgentDataSourceConfig, PublicAgentDataSource, toPublicAgentDataSource } from './source.types';

const DISTRIBUTION_ORDER_ID = 'default';
const DEFAULT_X_DISTRIBUTION_ORDER = ['VDC', 'GMC', 'CSB', 'GCM', 'MID', 'GRT', 'GCP', 'FCL', 'CWK', 'BIP'];

interface DistributionOrderRecord {
  _id: string;
  X: string[];
  XB: string[];
  updatedAt: Date;
}

export interface DistributionOrderListing {
  orders: { X: string[]; XB: string[] };
  branches: Array<{ branchId: string; alias: string; active: boolean }>;
  updatedAt: Date | null;
}

@Injectable()
export class SourcesService {
  constructor(private readonly mongo: MongoService, private readonly cache: CacheManagementService) {}

  private get sources() {
    // Keep the existing collection name so saved configurations remain available.
    return this.mongo.db.collection<AgentDataSourceConfig>('shipment_sources');
  }

  private get distributionOrders() {
    return this.mongo.db.collection<DistributionOrderRecord>('agent_distribution_orders');
  }

  async list(): Promise<{ items: PublicAgentDataSource[] }> {
    const items = await this.sources.find({}).sort({ alias: 1, _id: 1 }).toArray();
    return { items: items.map(toPublicAgentDataSource) };
  }

  async getDistributionOrder(): Promise<DistributionOrderListing> {
    const [record, sourceConfigs] = await Promise.all([
      this.distributionOrders.findOne({ _id: DISTRIBUTION_ORDER_ID }),
      this.sources.find({ sourceType: { $ne: 'central' } }, { projection: { branchId: 1, alias: 1, active: 1 } })
        .sort({ alias: 1, branchId: 1 }).toArray(),
    ]);
    const branches = sourceConfigs.map(source => ({ branchId: source.branchId, alias: source.alias, active: source.active }));
    const knownBranchIds = new Set(branches.map(branch => branch.branchId));
    const defaultX = DEFAULT_X_DISTRIBUTION_ORDER.filter(branchId => knownBranchIds.has(branchId));
    return {
      orders: {
        X: normalizeBranchOrder(record?.X ?? defaultX, knownBranchIds),
        XB: normalizeBranchOrder(record?.XB ?? [], knownBranchIds),
      },
      branches,
      updatedAt: record?.updatedAt ?? null,
    };
  }

  async updateDistributionOrder(dto: { X: string[]; XB: string[] }): Promise<DistributionOrderListing> {
    const xOrder = normalizeSubmittedBranchOrder(dto.X, 'X');
    const xbOrder = normalizeSubmittedBranchOrder(dto.XB, 'XB');
    const overlappingBranches = xOrder.filter(branchId => xbOrder.includes(branchId));
    if (overlappingBranches.length) {
      throw new BadRequestException(`Cabang tidak boleh muncul di urutan X dan XB sekaligus: ${overlappingBranches.join(', ')}.`);
    }
    const branchIds = [...new Set([...xOrder, ...xbOrder])];
    const configuredBranches = branchIds.length
      ? await this.sources.find({ branchId: { $in: branchIds }, sourceType: { $ne: 'central' } }, { projection: { branchId: 1 } }).toArray()
      : [];
    const knownBranchIds = new Set(configuredBranches.map(source => source.branchId));
    const unknown = branchIds.filter(branchId => !knownBranchIds.has(branchId));
    if (unknown.length) throw new BadRequestException(`Cabang tidak ditemukan pada Sumber Agent: ${unknown.join(', ')}.`);

    await this.distributionOrders.updateOne(
      { _id: DISTRIBUTION_ORDER_ID },
      { $set: { X: xOrder, XB: xbOrder, updatedAt: new Date() } },
      { upsert: true },
    );
    this.invalidateRecommendations();
    return this.getDistributionOrder();
  }

  async create(dto: CreateSourceDto): Promise<PublicAgentDataSource> {
    const databaseName = dto.databaseName.trim();
    const alias = dto.alias.trim();
    const branchId = dto.branchId.trim();
    const sourceType = dto.sourceType === 'central' ? 'central' : 'branch';
    assertNames(alias, branchId);
    const distributionPriority = assertPriority(dto.distributionPriority, sourceType);
    const itemCategory = sourceType === 'branch' ? assertItemCategory(dto.itemCategory, branchId) : undefined;
    await this.ensureUnique(databaseName, branchId, undefined, sourceType);
    const now = new Date();
    const source: AgentDataSourceConfig = {
      _id: new ObjectId(),
      databaseName,
      alias,
      branchId,
      sourceType,
      distributionPriority,
      ...(itemCategory ? { itemCategory } : {}),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.sources.insertOne(source);
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException('Nama database dan branch ID harus unik.');
      throw error;
    }
    this.invalidateRecommendations();
    return toPublicAgentDataSource(source);
  }

  async update(id: string, dto: UpdateSourceDto): Promise<PublicAgentDataSource> {
    const sourceId = parseObjectId(id);
    const existing = await this.sources.findOne({ _id: sourceId });
    if (!existing) throw new NotFoundException('Data source not found');

    const databaseName = dto.databaseName.trim();
    const alias = dto.alias.trim();
    const branchId = dto.branchId.trim();
    const sourceType = dto.sourceType ?? existing.sourceType ?? 'branch';
    const distributionPriority = assertPriority(dto.distributionPriority ?? (sourceType === 'central' ? 'none' : existing.distributionPriority), sourceType);
    const itemCategory = sourceType === 'branch'
      ? assertItemCategory(dto.itemCategory ?? existing.itemCategory, branchId)
      : undefined;
    assertNames(alias, branchId);
    await this.ensureUnique(databaseName, branchId, sourceId, sourceType);
    let result: AgentDataSourceConfig | null;
    try {
      result = await this.sources.findOneAndUpdate(
        { _id: sourceId },
        {
          $set: {
            databaseName,
            alias,
            branchId,
            sourceType,
            distributionPriority,
            ...(itemCategory ? { itemCategory } : {}),
            active: dto.active ?? existing.active,
            updatedAt: new Date(),
          },
          ...(sourceType === 'central' ? { $unset: { itemCategory: '' } } : {}),
        },
        { returnDocument: 'after' },
      );
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException('Nama database dan branch ID harus unik.');
      throw error;
    }
    if (!result) throw new NotFoundException('Data source not found');
    this.invalidateRecommendations();
    return toPublicAgentDataSource(result);
  }

  async updateDistributionPriorityByBranchId(branchIdValue: string, value: unknown): Promise<{ item: PublicAgentDataSource; previousPriority: DistributionPriority }> {
    const result = await this.updateDistributionPriorities([{ branchId: branchIdValue, priority: value }]);
    const { previousPriority, ...item } = result.items[0];
    return { item, previousPriority };
  }

  async updateDistributionPriorities(changesValue: unknown): Promise<{ items: Array<PublicAgentDataSource & { previousPriority: DistributionPriority }> }> {
    if (!Array.isArray(changesValue) || changesValue.length < 1 || changesValue.length > 50) {
      throw new BadRequestException('Daftar perubahan harus berisi 1–50 cabang.');
    }
    const changes = changesValue.map((value) => {
      if (typeof value !== 'object' || value === null || !('branchId' in value) || !('priority' in value)) {
        throw new BadRequestException('Setiap perubahan wajib memiliki branchId dan priority.');
      }
      const entry = value as { branchId: unknown; priority: unknown };
      if (typeof entry.branchId !== 'string' || !entry.branchId.trim()) throw new BadRequestException('ID cabang wajib diisi.');
      return { branchId: entry.branchId.trim(), priority: assertPriority(entry.priority, 'branch') };
    });
    const branchIds = changes.map(change => change.branchId);
    if (new Set(branchIds).size !== branchIds.length) throw new BadRequestException('Satu cabang hanya boleh muncul sekali dalam daftar perubahan.');

    const session = this.mongo.mongoClient.startSession();
    let updatedItems: Array<PublicAgentDataSource & { previousPriority: DistributionPriority }> = [];
    try {
      await session.withTransaction(async () => {
        const currentSources = await this.sources.find(
          { branchId: { $in: branchIds }, active: true },
          { session },
        ).toArray();
        if (currentSources.length !== changes.length || currentSources.some(source => source.sourceType === 'central')) {
          throw new NotFoundException('Satu atau beberapa cabang aktif tidak ditemukan. Gunakan branchId dari daftar sumber Agent.');
        }
        const sourcesByBranchId = new Map(currentSources.map(source => [source.branchId, source]));
        const now = new Date();
        const operations = changes.map(change => {
          const source = sourcesByBranchId.get(change.branchId);
          if (!source) throw new NotFoundException(`Cabang ${change.branchId} tidak ditemukan.`);
          return {
            updateOne: {
              filter: { _id: source._id, branchId: change.branchId, active: true },
              update: { $set: { distributionPriority: change.priority, updatedAt: now } },
            },
          };
        });
        const result = await this.sources.bulkWrite(operations, { session, ordered: true });
        if (result.matchedCount !== changes.length) throw new ConflictException('Daftar prioritas berubah saat penyimpanan. Muat ulang lalu coba kembali.');
        updatedItems = changes.map(change => {
          const source = sourcesByBranchId.get(change.branchId)!;
          return {
            ...toPublicAgentDataSource({ ...source, distributionPriority: change.priority, updatedAt: now }),
            previousPriority: normalizeDistributionPriority(source.distributionPriority),
          };
        });
      });
    } finally {
      await session.endSession();
    }
    this.invalidateRecommendations();
    return { items: updatedItems };
  }

  private invalidateRecommendations() {
    this.cache.clearByPrefix('agent:network-restock:');
    this.cache.clearByPrefix('agent:restock:');
  }

  private async ensureUnique(
    databaseName: string,
    branchId: string,
    excludingId?: ObjectId,
    sourceType: 'branch' | 'central' = 'branch',
  ): Promise<void> {
    if (sourceType === 'central') {
      const existingCentral = await this.sources.findOne({
        _id: excludingId ? { $ne: excludingId } : { $exists: true },
        sourceType: 'central',
      }, { projection: { _id: 1 } });
      if (existingCentral) {
        throw new ConflictException('Hanya satu sumber Pusat yang dapat ditandai aktif atau tersimpan.');
      }
    }

    const conflict = await this.sources.findOne({
      _id: excludingId ? { $ne: excludingId } : { $exists: true },
      $or: [{ databaseName }, { branchId }],
    }, { projection: { _id: 1 } });
    if (conflict) {
      throw new ConflictException('Nama database dan branch ID harus unik.');
    }
  }
}

function normalizeBranchOrder(values: unknown, knownBranchIds: Set<string>): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    if (typeof value !== 'string' || !knownBranchIds.has(value) || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizeSubmittedBranchOrder(values: unknown, category: 'X' | 'XB'): string[] {
  if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new BadRequestException(`Urutan penerima ${category} harus berisi maksimal 100 ID cabang yang valid.`);
  }
  const normalized = values.map(value => (value as string).trim().toUpperCase());
  if (new Set(normalized).size !== normalized.length) throw new BadRequestException(`Satu cabang hanya boleh muncul sekali pada urutan ${category}.`);
  return normalized;
}

function parseObjectId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) throw new NotFoundException('Data source not found');
  return new ObjectId(id);
}

function assertNames(alias: string, branchId: string): void {
  if (!alias || !branchId) throw new BadRequestException('Alias dan ID sumber wajib diisi.');
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function assertPriority(value: unknown, sourceType: 'branch' | 'central'): DistributionPriority {
  if (value !== undefined && !DISTRIBUTION_PRIORITIES.includes(value as DistributionPriority)) throw new BadRequestException('Flag prioritas harus Exclusive (profit_bagus), opening, boost, atau none.');
  const priority = normalizeDistributionPriority(value);
  if (sourceType === 'central' && priority !== 'none') throw new BadRequestException('Flag prioritas penerima hanya berlaku untuk cabang, bukan Pusat.');
  return priority;
}

function assertItemCategory(value: unknown, branchId: string): ItemCategory {
  if (value === undefined) return inferItemCategory(branchId);
  if (!ITEM_CATEGORIES.includes(value as ItemCategory)) {
    throw new BadRequestException('Kelompok cabang harus X (mall) atau BIASA (cabang lainnya).');
  }
  return normalizeItemCategory(value, branchId);
}
