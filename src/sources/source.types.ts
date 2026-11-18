import { DistributionPriority, normalizeDistributionPriority } from './distribution-priority';
import { ItemCategory, normalizeItemCategory } from './item-category';
import { ObjectId } from 'mongodb';

export interface AgentDataSourceConfig {
  _id: ObjectId;
  databaseName: string;
  alias: string;
  branchId: string;
  sourceType?: 'branch' | 'central';
  distributionPriority?: DistributionPriority;
  itemCategory?: ItemCategory;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicAgentDataSource {
  id: string;
  databaseName: string;
  alias: string;
  branchId: string;
  sourceType: 'branch' | 'central';
  distributionPriority: DistributionPriority;
  itemCategory?: ItemCategory;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeSourceType(value: unknown): 'branch' | 'central' {
  return value === 'central' ? 'central' : 'branch';
}

export function toPublicAgentDataSource(source: AgentDataSourceConfig): PublicAgentDataSource {
  const sourceType = normalizeSourceType(source.sourceType);
  return {
    id: source._id.toHexString(),
    databaseName: source.databaseName,
    alias: source.alias,
    branchId: source.branchId,
    sourceType,
    distributionPriority: sourceType === 'central' ? 'none' : normalizeDistributionPriority(source.distributionPriority),
    ...(sourceType === 'branch' ? { itemCategory: normalizeItemCategory(source.itemCategory, source.branchId) } : {}),
    active: source.active,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}
