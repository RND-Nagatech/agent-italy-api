import { Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { MongoService } from '../database/mongo.service';

export interface InventoryDataSource {
  databaseName: string;
  alias: string;
  branchId: string;
  sourceType: 'branch' | 'central';
}

type LocationStatus = 'available' | 'unavailable';

interface InventoryAggregateRow extends Document {
  _id: unknown;
  pcs: number;
  weight: number;
  recordsWithoutWeight: number;
}

interface DepartmentRow extends Document {
  kode_dept?: unknown;
  nama_dept?: unknown;
}

interface LocationSnapshot {
  source: InventoryDataSource;
  status: LocationStatus;
  stock: Map<string, { pcs: number; weight: number; recordsWithoutWeight: number }>;
  jenisNames: Map<string, string>;
  departmentNamesUnavailable: boolean;
  unavailableReason?: string;
}

export interface InventoryLocationSummary {
  alias: string;
  branchId: string;
  sourceType: 'branch' | 'central';
  status: LocationStatus;
  physicalStockPcs: number | null;
  physicalStockWeight: number | null;
  jenisWithStockCount: number | null;
  recordsWithoutWeight: number | null;
  departmentNamesUnavailable: boolean;
  unavailableReason?: string;
}

export interface InventoryJenisLocation {
  alias: string;
  branchId: string;
  sourceType: 'branch' | 'central';
  status: LocationStatus;
  physicalStockPcs: number | null;
  physicalStockWeight: number | null;
  recordsWithoutWeight: number | null;
}

export interface InventoryJenisSummary {
  kode: string;
  nama: string;
  centralStockPcs: number;
  branchStockPcs: number;
  networkStockPcs: number;
  centralStockWeight: number;
  branchStockWeight: number;
  networkStockWeight: number;
  branchLocationsWithStock: number;
  locations: InventoryJenisLocation[];
}

export interface InventorySummaryResult {
  mode: 'inventory-summary';
  asOf: string;
  policy: {
    source: string;
    stockFilter: string;
    quantityFormula: string;
    weightFormula: string;
    deletedByFilter: string;
    incomingShipments: string;
  };
  summary: {
    locationCount: number;
    availableLocationCount: number;
    unavailableLocationCount: number;
    branchCount: number;
    centralSourceCount: number;
    totalPhysicalStockWeight: number;
    centralPhysicalStockWeight: number;
    branchPhysicalStockWeight: number;
    totalPhysicalStockPcs: number;
    centralPhysicalStockPcs: number;
    branchPhysicalStockPcs: number;
    jenisCount: number;
    jenisWithStockCount: number;
    locationsWithIncompleteWeight: number;
    recordsWithoutWeight: number;
    departmentNamesUnavailableCount: number;
  };
  locations: InventoryLocationSummary[];
  jenis: InventoryJenisSummary[];
  unavailableSources: Array<{ alias: string; branchId: string; sourceType: 'branch' | 'central'; reason: string }>;
  note: string;
  cacheStatus: 'hit' | 'miss' | 'coalesced';
}

export class InventorySummaryError extends Error {}

const MAX_SOURCE_COUNT = 100;
const MAX_CONCURRENT_SOURCES = 4;
const QUERY_MAX_TIME_MS = 45_000;

@Injectable()
export class InventorySummaryService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  async summarize(sources: InventoryDataSource[]): Promise<InventorySummaryResult> {
    if (!sources.length) throw new InventorySummaryError('Belum ada sumber Pusat atau cabang aktif untuk Inventory.');
    if (sources.length > MAX_SOURCE_COUNT) {
      throw new InventorySummaryError(`Analisis Inventory dibatasi maksimal ${MAX_SOURCE_COUNT} sumber aktif.`);
    }

    const orderedSources = [...sources].sort((left, right) => {
      if (left.sourceType !== right.sourceType) return left.sourceType === 'central' ? -1 : 1;
      return left.branchId.localeCompare(right.branchId);
    });
    const sourceKey = orderedSources.map(({ databaseName, alias, branchId, sourceType }) => ({
      databaseName,
      alias,
      branchId,
      sourceType,
    }));
    const key = `agent:inventory-summary:v2:${JSON.stringify(sourceKey)}`;
    const { value, cacheStatus } = await this.cache.getOrLoadWithStatus(key, () => this.buildSummary(orderedSources));
    return { ...value, cacheStatus };
  }

  private async buildSummary(sources: InventoryDataSource[]) {
    const snapshots = await mapWithConcurrency(sources, MAX_CONCURRENT_SOURCES, (source) => this.readLocation(source));
    const codes = new Set<string>();
    const preferredNames = new Map<string, string>();

    for (const snapshot of snapshots) {
      snapshot.stock.forEach((_value, code) => codes.add(code));
      snapshot.jenisNames.forEach((name, code) => {
        codes.add(code);
        if (!preferredNames.has(code) || (snapshot.source.sourceType === 'central' && name !== code)) {
          preferredNames.set(code, name || code);
        }
      });
    }

    const locations: InventoryLocationSummary[] = snapshots.map((snapshot) => {
      if (snapshot.status === 'unavailable') {
        return {
          alias: snapshot.source.alias,
          branchId: snapshot.source.branchId,
          sourceType: snapshot.source.sourceType,
          status: snapshot.status,
          physicalStockPcs: null,
          physicalStockWeight: null,
          jenisWithStockCount: null,
          recordsWithoutWeight: null,
          departmentNamesUnavailable: snapshot.departmentNamesUnavailable,
          unavailableReason: snapshot.unavailableReason,
        };
      }

      let totalPcs = 0;
      let totalWeight = 0;
      let recordsWithoutWeight = 0;
      let jenisWithStockCount = 0;
      snapshot.stock.forEach((entry) => {
        totalPcs += positive(entry.pcs);
        totalWeight += positive(entry.weight);
        recordsWithoutWeight += positive(entry.recordsWithoutWeight);
        if (entry.pcs > 0) jenisWithStockCount += 1;
      });
      return {
        alias: snapshot.source.alias,
        branchId: snapshot.source.branchId,
        sourceType: snapshot.source.sourceType,
        status: snapshot.status,
        physicalStockPcs: roundCount(totalPcs),
        physicalStockWeight: roundWeight(totalWeight),
        jenisWithStockCount,
        recordsWithoutWeight,
        departmentNamesUnavailable: snapshot.departmentNamesUnavailable,
      };
    });

    const jenis: InventoryJenisSummary[] = [...codes].sort((left, right) => left.localeCompare(right)).map((code) => {
      let centralStockPcs = 0;
      let branchStockPcs = 0;
      let centralStockWeight = 0;
      let branchStockWeight = 0;
      let branchLocationsWithStock = 0;
      const byLocation = snapshots.map((snapshot): InventoryJenisLocation => {
        const stock = snapshot.stock.get(code);
        const pcs = snapshot.status === 'available' ? positive(stock?.pcs) : null;
        const weight = snapshot.status === 'available' ? positive(stock?.weight) : null;
        if (pcs !== null) {
          if (snapshot.source.sourceType === 'central') centralStockPcs += pcs;
          else branchStockPcs += pcs;
        }
        if (weight !== null) {
          if (snapshot.source.sourceType === 'central') centralStockWeight += weight;
          else {
            branchStockWeight += weight;
            if (weight > 0) branchLocationsWithStock += 1;
          }
        }
        return {
          alias: snapshot.source.alias,
          branchId: snapshot.source.branchId,
          sourceType: snapshot.source.sourceType,
          status: snapshot.status,
          physicalStockPcs: pcs === null ? null : roundCount(pcs),
          physicalStockWeight: weight === null ? null : roundWeight(weight),
          recordsWithoutWeight: snapshot.status === 'available' ? positive(stock?.recordsWithoutWeight) : null,
        };
      });

      return {
        kode: code,
        nama: preferredNames.get(code) || code,
        centralStockPcs: roundCount(centralStockPcs),
        branchStockPcs: roundCount(branchStockPcs),
        networkStockPcs: roundCount(centralStockPcs + branchStockPcs),
        centralStockWeight: roundWeight(centralStockWeight),
        branchStockWeight: roundWeight(branchStockWeight),
        networkStockWeight: roundWeight(centralStockWeight + branchStockWeight),
        branchLocationsWithStock,
        locations: byLocation,
      };
    }).sort((left, right) => right.networkStockPcs - left.networkStockPcs || left.kode.localeCompare(right.kode));

    const centralLocations = locations.filter((location) => location.sourceType === 'central' && location.status === 'available');
    const branchLocations = locations.filter((location) => location.sourceType === 'branch' && location.status === 'available');
    const unavailableSources = snapshots.flatMap((snapshot) => snapshot.unavailableReason ? [{
      alias: snapshot.source.alias,
      branchId: snapshot.source.branchId,
      sourceType: snapshot.source.sourceType,
      reason: snapshot.unavailableReason,
    }] : []);
    const recordsWithoutWeight = locations.reduce((total, location) => total + (location.recordsWithoutWeight ?? 0), 0);
    const locationsWithIncompleteWeight = locations.filter((location) => (location.recordsWithoutWeight ?? 0) > 0).length;
    const totalWeight = locations.reduce((total, location) => total + (location.physicalStockWeight ?? 0), 0);
    const centralStockWeight = centralLocations.reduce((total, location) => total + (location.physicalStockWeight ?? 0), 0);
    const branchStockWeight = branchLocations.reduce((total, location) => total + (location.physicalStockWeight ?? 0), 0);
    const totalPcs = locations.reduce((total, location) => total + (location.physicalStockPcs ?? 0), 0);
    const centralStockPcs = centralLocations.reduce((total, location) => total + (location.physicalStockPcs ?? 0), 0);
    const branchStockPcs = branchLocations.reduce((total, location) => total + (location.physicalStockPcs ?? 0), 0);

    return {
      mode: 'inventory-summary' as const,
      asOf: new Date().toISOString(),
      policy: {
        source: 'tm_barang pada setiap sumber aktif yang ditandai sebagai Pusat atau Cabang.',
        stockFilter: 'status_hancur=false dan jumlah pcs > 0; pcs memakai stock_on_hand, dengan fallback qty hanya jika stock_on_hand null/tidak tersedia. Semua Jenis aktif dari tm_dept disertakan, termasuk yang tidak memiliki stok.',
        quantityFormula: 'Jumlah stok dalam pcs = stock_on_hand; jika null/tidak tersedia, gunakan qty.',
        weightFormula: 'Berat stok fisik = berat × jumlah pcs; semua nilai berat dalam gram.',
        deletedByFilter: 'deleted_by tidak digunakan sebagai filter.',
        incomingShipments: 'Kiriman OPEN tidak dihitung sebagai stok fisik dan tidak dimasukkan ke total Inventory.',
      },
      summary: {
        locationCount: sources.length,
        availableLocationCount: snapshots.filter((snapshot) => snapshot.status === 'available').length,
        unavailableLocationCount: unavailableSources.length,
        branchCount: sources.filter((source) => source.sourceType === 'branch').length,
        centralSourceCount: sources.filter((source) => source.sourceType === 'central').length,
        totalPhysicalStockWeight: roundWeight(totalWeight),
        centralPhysicalStockWeight: roundWeight(centralStockWeight),
        branchPhysicalStockWeight: roundWeight(branchStockWeight),
        totalPhysicalStockPcs: roundCount(totalPcs),
        centralPhysicalStockPcs: roundCount(centralStockPcs),
        branchPhysicalStockPcs: roundCount(branchStockPcs),
        jenisCount: jenis.length,
        jenisWithStockCount: jenis.filter((item) => item.networkStockPcs > 0).length,
        locationsWithIncompleteWeight,
        recordsWithoutWeight,
        departmentNamesUnavailableCount: snapshots.filter((snapshot) => snapshot.departmentNamesUnavailable).length,
      },
      locations,
      jenis,
      unavailableSources,
      note: 'Inventory ini hanya menunjukkan stok fisik saat pembacaan. Pcs dihitung dari stock_on_hand atau qty bila stock_on_hand null/tidak tersedia. Record tanpa berat tetap masuk hitungan pcs, tetapi tidak menambah total gram. Kiriman OPEN dipisahkan agar tidak tercampur dengan barang yang sudah berada di lokasi.',
    };
  }

  private async readLocation(source: InventoryDataSource): Promise<LocationSnapshot> {
    const snapshot: LocationSnapshot = {
      source,
      status: 'available',
      stock: new Map(),
      jenisNames: new Map(),
      departmentNamesUnavailable: false,
    };
    try {
      const db = this.mongo.getDatabase(source.databaseName);
      const hasStockCollection = await db.listCollections({ name: 'tm_barang' }, { nameOnly: true }).hasNext();
      if (!hasStockCollection) {
        snapshot.status = 'unavailable';
        snapshot.unavailableReason = 'Koleksi tm_barang tidak ditemukan.';
        return snapshot;
      }

      const stockRows = await db.collection('tm_barang').aggregate<InventoryAggregateRow>(stockPipeline(), {
        allowDiskUse: true,
        maxTimeMS: QUERY_MAX_TIME_MS,
      }).toArray();
      stockRows.forEach((row) => {
        const code = cleanString(row._id);
        if (!code) return;
        snapshot.stock.set(code, {
          pcs: positive(row.pcs),
          weight: positive(row.weight),
          recordsWithoutWeight: positive(row.recordsWithoutWeight),
        });
      });

      try {
        const hasDepartmentsCollection = await db.listCollections({ name: 'tm_dept' }, { nameOnly: true }).hasNext();
        if (!hasDepartmentsCollection) {
          snapshot.departmentNamesUnavailable = true;
        } else {
          const departments = await db.collection('tm_dept')
            .find({ status_aktif: true }, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
            .maxTimeMS(10_000)
            .toArray() as DepartmentRow[];
          departments.forEach((department) => {
            const code = cleanString(department.kode_dept);
            if (!code) return;
            const decryptedName = decryptDepartmentName(department.nama_dept);
            snapshot.jenisNames.set(code, decryptedName || code);
          });
        }
      } catch {
        snapshot.departmentNamesUnavailable = true;
      }
    } catch {
      snapshot.status = 'unavailable';
      snapshot.unavailableReason = 'Sumber Inventory gagal dibaca atau melewati batas waktu.';
      snapshot.stock.clear();
      snapshot.jenisNames.clear();
    }
    if ([...snapshot.stock.keys()].some((code) => !snapshot.jenisNames.has(code))) {
      snapshot.departmentNamesUnavailable = true;
    }
    return snapshot;
  }
}

function stockPipeline(): Document[] {
  const pcs = { $convert: { input: { $ifNull: ['$stock_on_hand', '$qty'] }, to: 'double', onError: 0, onNull: 0 } };
  return [
    {
      $match: {
        status_hancur: false,
        $or: [{ stock_on_hand: { $gt: 0 } }, { stock_on_hand: null, qty: { $gt: 0 } }],
        kode_dept: { $type: 'string', $ne: '' },
      },
    },
    {
      $project: {
        jenis: '$kode_dept',
        inventoryPcs: pcs,
        inventoryWeight: {
          $multiply: [
            { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
            pcs,
          ],
        },
        hasWeight: { $gt: [{ $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } }, 0] },
      },
    },
    {
      $group: {
        _id: '$jenis',
        pcs: { $sum: '$inventoryPcs' },
        weight: { $sum: '$inventoryWeight' },
        recordsWithoutWeight: { $sum: { $cond: ['$hasWeight', 0, 1] } },
      },
    },
  ];
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positive(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function roundWeight(value: number): number {
  return Number(value.toFixed(3));
}

function roundCount(value: number): number {
  return Math.round(value);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
