import { Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { CleaningMinimumStock } from '../settings/cleaning-priority-settings.service';
import { validSalesMatch } from '../sales/sales-query-policy';

export type CleaningPrioritySourceType = 'branch' | 'central';

export interface CleaningPriorityDataSource {
  databaseName: string;
  alias: string;
  branchId: string;
  sourceType: CleaningPrioritySourceType;
}

interface CentralStockRow extends Document {
  _id: string;
  units: number;
  weightedUnits: number;
  weight: number;
  rowsWithoutWeight: number;
}

interface BranchBuybackRow extends Document {
  _id: string;
  weight: number;
  weightedRows: number;
  rowsWithoutWeight: number;
  oldestBuybackAt?: Date | string | null;
}

interface BranchStockRow extends Document {
  _id: string;
  weight: number;
  rowsWithoutWeight: number;
}

interface BranchSalesRow extends Document {
  _id: { jenis?: string; period?: 'current' | 'previous' };
  weight: number;
  rowsWithoutWeight: number;
}

interface OpenIncomingRow extends Document {
  _id: { branchId?: string; jenis?: string };
  weight: number;
  rowsWithoutWeight: number;
}

interface BuybackJenisSnapshot {
  weight: number;
  weightedRows: number;
  rowsWithoutWeight: number;
  oldestBuybackAt: string | null;
  oldestBuybackAgeDays: number | null;
}

interface BranchSalesJenisSnapshot {
  currentWeight: number;
  previousWeight: number;
  currentRowsWithoutWeight: number;
  previousRowsWithoutWeight: number;
}

interface BranchSnapshot {
  source: CleaningPriorityDataSource;
  buybackByJenis: Map<string, BuybackJenisSnapshot>;
  stockByJenis: Map<string, { weight: number; rowsWithoutWeight: number }>;
  salesByJenis: Map<string, BranchSalesJenisSnapshot>;
  openIncomingByJenis: Map<string, { weight: number; rowsWithoutWeight: number }>;
  buybackAvailable: boolean;
  stockAvailable: boolean;
  salesAvailable: boolean;
  unavailableReason?: string;
}

export interface CleaningPrioritySalesWindow {
  month: string;
  currentFrom: string;
  currentThrough: string;
  previousFrom: string;
  previousThrough: string;
  currentDays: number;
  previousDays: number;
  remainingDays: number;
  monthEnd: string;
}

export interface CleaningPriorityBranchShortage {
  alias: string;
  branchId: string;
  jenis: { kode: string; nama: string };
  currentMonthSalesWeight: number;
  previousYearMonthSalesWeight: number;
  referenceSalesWeight: number;
  referencePeriod: 'current-month' | 'previous-year' | 'tie';
  referenceDays: number;
  dailyDemandWeight: number;
  remainingDays: number;
  projectedDemandWeight: number;
  physicalStockWeight: number;
  openIncomingWeight: number;
  availableWeight: number;
  shortageWeight: number;
  allocatedBuybackWeight: number;
  unfulfilledWeight: number;
  coverageDays: number | null;
  rowsWithoutWeight: number;
}

export interface CleaningPriorityRequest {
  priority: number;
  from: { alias: string; branchId: string };
  to: { alias: string; branchId: string; type: 'central' | 'branch' };
  purpose: 'central-safety-stock' | 'branch-month-end-shortage';
  jenis: { kode: string; nama: string };
  estimatedWeight: number;
  oldestBuybackAt: string | null;
  oldestBuybackAgeDays: number | null;
}

export interface CleaningPriorityJenisSummary {
  jenis: { kode: string; nama: string };
  centralSafetyStockConfigured: boolean;
  centralStockWeight: number;
  centralTargetWeight: number;
  centralShortageWeight: number;
  branchShortageWeight: number;
  totalRequiredWeight: number;
  availableBuybackWeight: number;
  estimatedRequestedWeight: number;
  unfulfilledWeight: number;
  centralTargetEstimatedFromAverage: boolean;
  centralWeightEstimateUnavailable: boolean;
  branchShortages: CleaningPriorityBranchShortage[];
  buybackRowsWithoutWeight: number;
}

export interface CleaningPriorityResult {
  mode: 'buyback-cleaning-priority';
  generatedAt: string;
  central: { alias: string; branchId: string };
  salesWindow: CleaningPrioritySalesWindow;
  summary: {
    deficientJenisCount: number;
    totalCentralStockWeight: number;
    totalCentralTargetWeight: number;
    totalCentralShortageWeight: number;
    centralTargetEstimatedCount: number;
    centralWeightEstimateUnavailableCount: number;
    totalBranchShortageWeight: number;
    totalRequiredWeight: number;
    totalAvailableBuybackWeight: number;
    totalEstimatedRequestedWeight: number;
    totalUnfulfilledWeight: number;
    branchCount: number;
    analyzedBranchCount: number;
    branchesWithIncompleteWeightData: number;
    centralRowsWithoutWeight: number;
    buybackRowsWithoutWeight: number;
  };
  jenis: CleaningPriorityJenisSummary[];
  branchShortages: CleaningPriorityBranchShortage[];
  requests: CleaningPriorityRequest[];
  omittedJenisCount: number;
  omittedRequestCount: number;
  omittedBranchShortageCount: number;
  cacheStatus: 'hit' | 'miss' | 'coalesced';
  rules: {
    centralStock: string;
    branchBuyback: string;
    sales: string;
    branchStock: string;
    openIncoming: string;
    projection: string;
    allocation: string;
    weight: string;
  };
}

export class CleaningPriorityError extends Error {}

const MAX_SOURCES = 100;
const MAX_CONFIGURED_JENIS = 300;
const MAX_ANALYZED_JENIS = 500;
const MAX_VISIBLE_JENIS = 100;
const MAX_REQUEST_ROWS = 500;
const QUERY_MAX_TIME_MS = 45_000;
const SOURCE_CONCURRENCY = 4;

@Injectable()
export class CleaningPriorityService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  async recommend(
    sources: CleaningPriorityDataSource[],
    configuredMinimumStocks: CleaningMinimumStock[],
  ): Promise<CleaningPriorityResult> {
    if (!sources.length) throw new CleaningPriorityError('Belum ada sumber database aktif untuk Agent.');
    if (sources.length > MAX_SOURCES) throw new CleaningPriorityError(`Analisis dibatasi maksimal ${MAX_SOURCES} sumber aktif.`);

    const centralSources = sources.filter((source) => source.sourceType === 'central');
    const branches = sources.filter((source) => source.sourceType === 'branch');
    if (centralSources.length !== 1) {
      throw new CleaningPriorityError(centralSources.length === 0
        ? 'Tandai satu sumber data sebagai Pusat sebelum memeriksa stok minimum Jenis.'
        : 'Terdapat lebih dari satu sumber yang ditandai sebagai Pusat. Sisakan tepat satu sumber Pusat.');
    }
    if (!branches.length) throw new CleaningPriorityError('Belum ada sumber Cabang aktif untuk mencari barang buyback yang perlu dicuci.');
    if (!configuredMinimumStocks.length) {
      throw new CleaningPriorityError('Batas safety stock belum diatur. Buka Pengaturan → Prioritas cuci buyback, lalu atur batas unit dan/atau berat untuk setiap Jenis.');
    }
    if (configuredMinimumStocks.length > MAX_CONFIGURED_JENIS) {
      throw new CleaningPriorityError(`Batas analisis maksimal ${MAX_CONFIGURED_JENIS} Jenis.`);
    }

    const thresholds = configuredMinimumStocks
      .map(({ kodeDept, minimumStock, minimumWeight }) => ({
        kodeDept: kodeDept.trim(),
        minimumStock,
        minimumWeight: Number.isFinite(minimumWeight) && minimumWeight > 0 ? minimumWeight : 0,
      }))
      .filter((item) => item.kodeDept && ((Number.isSafeInteger(item.minimumStock) && item.minimumStock > 0) || item.minimumWeight > 0))
      .sort((left, right) => left.kodeDept.localeCompare(right.kodeDept));
    if (!thresholds.length) {
      throw new CleaningPriorityError('Belum ada batas safety stock Pusat yang valid. Atur batas unit dan/atau berat pada Pengaturan → Prioritas cuci buyback.');
    }
    const salesWindow = getSalesWindow();
    const sourceKey = sources
      .map(({ databaseName, alias, branchId, sourceType }) => ({ databaseName, alias, branchId, sourceType }))
      .sort((left, right) => left.sourceType.localeCompare(right.sourceType) || left.branchId.localeCompare(right.branchId));
    const cacheKey = 'agent:cleaning-priority:v6:' + JSON.stringify({ thresholds, sources: sourceKey, salesWindow });

    const { value, cacheStatus } = await this.cache.getOrLoadWithStatus(cacheKey, () =>
      this.buildRecommendation(centralSources[0], branches, thresholds, salesWindow),
    );
    return { ...value, cacheStatus };
  }

  private async buildRecommendation(
    central: CleaningPriorityDataSource,
    branches: CleaningPriorityDataSource[],
    thresholds: CleaningMinimumStock[],
    salesWindow: CleaningPrioritySalesWindow,
  ): Promise<Omit<CleaningPriorityResult, 'cacheStatus'>> {
    const configuredCodes = thresholds.map((item) => item.kodeDept);
    const names = await this.readJenisNames(central.databaseName);
    const codes = [...new Set([...configuredCodes, ...names.keys()])].sort((left, right) => left.localeCompare(right));
    if (codes.length > MAX_ANALYZED_JENIS) {
      throw new CleaningPriorityError(`Analisis pencucian dibatasi maksimal ${MAX_ANALYZED_JENIS} Jenis aktif.`);
    }
    let centralRows: CentralStockRow[];
    try {
      centralRows = await this.mongo.getDatabase(central.databaseName)
        .collection('tm_barang')
        .aggregate<CentralStockRow>(centralStockPipeline(configuredCodes), { maxTimeMS: QUERY_MAX_TIME_MS, allowDiskUse: true })
        .toArray();
    } catch {
      throw new CleaningPriorityError(`Stok Pusat di ${central.alias} belum dapat dibaca dari tm_barang. Periksa koneksi, koleksi, dan field stok.`);
    }

    const centralStockByJenis = new Map(centralRows.map((row) => [String(row._id), {
      units: finiteNumber(row.units),
      weightedUnits: finiteNumber(row.weightedUnits),
      weight: finiteNumber(row.weight),
    }]));
    const snapshots = await mapWithConcurrency(branches, SOURCE_CONCURRENCY, (source) =>
      this.readBranchSnapshot(source, codes, salesWindow),
    );
    const missingProjectionSources = snapshots.filter((snapshot) => !snapshot.stockAvailable || !snapshot.salesAvailable);
    if (missingProjectionSources.length) {
      const list = missingProjectionSources.map((snapshot) => snapshot.source.alias + ' (' + snapshot.source.branchId + ')').join(', ');
      throw new CleaningPriorityError('Analisis dihentikan karena data penjualan atau stok Cabang tidak dapat dibaca pada: ' + list + '. Pastikan tt_jual_detail dan tm_barang tersedia agar proyeksi tidak menganggap data kosong sebagai stok atau penjualan nol.');
    }

    const openIncomingByBranch = await this.readOpenIncoming(branches.map((source) => source.branchId), codes);
    snapshots.forEach((snapshot) => {
      snapshot.openIncomingByJenis = openIncomingByBranch.get(snapshot.source.branchId) ?? new Map();
    });
    const centralRowsWithoutWeight = centralRows.reduce((sum, row) => sum + positive(row.rowsWithoutWeight), 0);
    const branchesWithIncompleteWeightData = snapshots.filter((snapshot) => codes.some((code) => {
      const sales = snapshot.salesByJenis.get(code);
      return (sales?.currentRowsWithoutWeight ?? 0) + (sales?.previousRowsWithoutWeight ?? 0) > 0
        || (snapshot.stockByJenis.get(code)?.rowsWithoutWeight ?? 0) > 0
        || (snapshot.openIncomingByJenis.get(code)?.rowsWithoutWeight ?? 0) > 0;
    })).length;

    const thresholdsByCode = new Map(thresholds.map((threshold) => [threshold.kodeDept, threshold]));
    const preliminary = codes.map((kodeDept) => {
      const threshold = thresholdsByCode.get(kodeDept) ?? { kodeDept, minimumStock: 0, minimumWeight: 0 };
      const centralSafetyStockConfigured = thresholdsByCode.has(kodeDept);
      const stock = centralStockByJenis.get(kodeDept) ?? { units: 0, weightedUnits: 0, weight: 0 };
      const centralUnitShortage = Math.max(0, Math.ceil(threshold.minimumStock - stock.units));
      const branchShortages = snapshots.flatMap((snapshot) => {
        const sales = snapshot.salesByJenis.get(kodeDept) ?? emptySalesSnapshot();
        const physical = snapshot.stockByJenis.get(kodeDept) ?? { weight: 0, rowsWithoutWeight: 0 };
        const open = snapshot.openIncomingByJenis.get(kodeDept) ?? { weight: 0, rowsWithoutWeight: 0 };
        const currentDaily = sales.currentWeight / salesWindow.currentDays;
        const previousDaily = sales.previousWeight / salesWindow.previousDays;
        const currentReference = sales.currentWeight >= sales.previousWeight;
        const referenceWeight = currentReference ? sales.currentWeight : sales.previousWeight;
        const referenceDays = currentReference ? salesWindow.currentDays : salesWindow.previousDays;
        const dailyDemandWeight = referenceDays > 0 ? referenceWeight / referenceDays : Math.max(currentDaily, previousDaily);
        const projectedDemandWeight = dailyDemandWeight * salesWindow.remainingDays;
        const physicalStockWeight = positive(physical.weight);
        const openIncomingWeight = positive(open.weight);
        const availableWeight = physicalStockWeight + openIncomingWeight;
        const shortageWeight = round3(Math.max(0, projectedDemandWeight - availableWeight));
        if (shortageWeight <= 0) return [];
        return [{
          alias: snapshot.source.alias,
          branchId: snapshot.source.branchId,
          jenis: { kode: kodeDept, nama: names.get(kodeDept) ?? kodeDept },
          currentMonthSalesWeight: round3(sales.currentWeight),
          previousYearMonthSalesWeight: round3(sales.previousWeight),
          referenceSalesWeight: round3(referenceWeight),
          referencePeriod: sales.currentWeight === sales.previousWeight ? 'tie' as const : currentReference ? 'current-month' as const : 'previous-year' as const,
          referenceDays,
          dailyDemandWeight: round3(dailyDemandWeight),
          remainingDays: salesWindow.remainingDays,
          projectedDemandWeight: round3(projectedDemandWeight),
          physicalStockWeight: round3(physicalStockWeight),
          openIncomingWeight: round3(openIncomingWeight),
          availableWeight: round3(availableWeight),
          shortageWeight,
          allocatedBuybackWeight: 0,
          unfulfilledWeight: 0,
          coverageDays: dailyDemandWeight > 0 ? round3(availableWeight / dailyDemandWeight) : null,
          rowsWithoutWeight: positive(sales.currentRowsWithoutWeight + sales.previousRowsWithoutWeight)
            + positive(physical.rowsWithoutWeight) + positive(open.rowsWithoutWeight),
        }];
      }).sort((left, right) =>
        (left.coverageDays ?? Number.POSITIVE_INFINITY) - (right.coverageDays ?? Number.POSITIVE_INFINITY)
        || right.shortageWeight - left.shortageWeight
        || left.alias.localeCompare(right.alias),
      );
      const centralWeightShortage = round3(Math.max(0, threshold.minimumWeight - stock.weight));
      return {
        kodeDept,
        threshold,
        centralSafetyStockConfigured,
        stock,
        centralUnitShortage,
        centralWeightShortage,
        branchShortages,
        centralNeedsBuybackEstimate: centralUnitShortage > 0,
      };
    });

    const codesNeedingBuyback = preliminary
      .filter((item) => item.centralWeightShortage > 0 || item.centralNeedsBuybackEstimate || item.branchShortages.length > 0)
      .map((item) => item.threshold.kodeDept);
    if (!codesNeedingBuyback.length) {
      return buildResult(central, branches.length, salesWindow, [], [], [], snapshots, 0, 0, branchesWithIncompleteWeightData, centralRowsWithoutWeight);
    }

    const buybackFailures = await mapWithConcurrency(snapshots, SOURCE_CONCURRENCY, async (snapshot) => {
      const rows = await this.readBranchBuyback(snapshot.source, codesNeedingBuyback);
      snapshot.buybackAvailable = rows !== null;
      snapshot.buybackByJenis = new Map((rows ?? []).map((row) => [String(row._id), {
        weight: positive(row.weight),
        weightedRows: positive(row.weightedRows),
        rowsWithoutWeight: positive(row.rowsWithoutWeight),
        oldestBuybackAt: toIsoDate(row.oldestBuybackAt),
        oldestBuybackAgeDays: ageInDays(row.oldestBuybackAt),
      }]));
      return snapshot.buybackAvailable ? null : snapshot.source.alias + ' (' + snapshot.source.branchId + ')';
    });
    const missingBuybackSources = buybackFailures.filter((item): item is string => Boolean(item));
    if (missingBuybackSources.length) {
      throw new CleaningPriorityError('Data kandidat tt_beli_detail tidak dapat dibaca pada: ' + missingBuybackSources.join(', ') + '. Analisis dihentikan agar daftar sumber pencucian tidak keliru.');
    }

    const needs = preliminary.flatMap((item) => {
      const candidates = snapshots.map((snapshot) => snapshot.buybackByJenis.get(item.threshold.kodeDept) ?? emptyBuybackSnapshot());
      const candidateWeight = candidates.reduce((sum, row) => sum + row.weight, 0);
      const weightedRows = candidates.reduce((sum, row) => sum + row.weightedRows, 0);
      const candidateAverageWeight = weightedRows > 0 ? candidateWeight / weightedRows : 0;
      const centralAverageWeight = item.stock.weightedUnits > 0 ? item.stock.weight / item.stock.weightedUnits : candidateAverageWeight;
      const unitTargetWeight = item.threshold.minimumStock > 0 && centralAverageWeight > 0
        ? item.threshold.minimumStock * centralAverageWeight
        : 0;
      const centralTargetWeight = round3(Math.max(item.threshold.minimumWeight, unitTargetWeight));
      const centralShortageWeight = round3(Math.max(0, centralTargetWeight - item.stock.weight));
      const centralWeightEstimateUnavailable = item.centralSafetyStockConfigured
        && item.threshold.minimumStock > 0
        && centralAverageWeight <= 0;
      const branchShortageWeight = round3(item.branchShortages.reduce((sum, row) => sum + row.shortageWeight, 0));
      const totalRequiredWeight = round3(centralShortageWeight + branchShortageWeight);
      if (totalRequiredWeight <= 0 && !centralWeightEstimateUnavailable) return [];
      return [{
        jenis: { kode: item.threshold.kodeDept, nama: names.get(item.threshold.kodeDept) ?? item.threshold.kodeDept },
        centralSafetyStockConfigured: item.centralSafetyStockConfigured,
        centralStockWeight: round3(item.stock.weight),
        centralTargetWeight,
        centralShortageWeight,
        centralTargetEstimatedFromAverage: item.centralSafetyStockConfigured
          && item.threshold.minimumStock > 0
          && unitTargetWeight > item.threshold.minimumWeight,
        centralWeightEstimateUnavailable,
        branchShortages: item.branchShortages,
        branchShortageWeight,
        totalRequiredWeight,
        candidates: snapshots.map((snapshot) => ({
          snapshot,
          available: snapshot.buybackByJenis.get(item.threshold.kodeDept) ?? emptyBuybackSnapshot(),
        })).sort((left, right) =>
          right.available.weight - left.available.weight
          || compareOldestFirst(left.available.oldestBuybackAt, right.available.oldestBuybackAt)
          || left.snapshot.source.alias.localeCompare(right.snapshot.source.alias),
        ),
      }];
    }).sort((left, right) =>
      right.totalRequiredWeight - left.totalRequiredWeight || left.jenis.kode.localeCompare(right.jenis.kode),
    );

    const requests: CleaningPriorityRequest[] = [];
    const jenisSummaries: CleaningPriorityJenisSummary[] = [];
    const allBranchShortages: CleaningPriorityBranchShortage[] = [];
    for (const need of needs) {
      const availableBuybackWeight = round3(need.candidates.reduce((sum, candidate) => sum + candidate.available.weight, 0));
      const remainingBySource = new Map(need.candidates.map((candidate) => [candidate.snapshot.source.branchId, candidate.available.weight]));
      const typeRequests: CleaningPriorityRequest[] = [];
      let unfulfilledWeight = 0;
      const allocate = (
        requestedWeight: number,
        purpose: CleaningPriorityRequest['purpose'],
        destination: CleaningPriorityRequest['to'],
        branchNeed?: CleaningPriorityBranchShortage,
      ) => {
        let remaining = requestedWeight;
        for (const candidate of need.candidates) {
          if (remaining <= 0) break;
          const sourceId = candidate.snapshot.source.branchId;
          const available = remainingBySource.get(sourceId) ?? 0;
          if (available <= 0) continue;
          const allocation = round3(Math.min(remaining, available));
          if (allocation <= 0) continue;
          typeRequests.push({
            priority: requests.length + typeRequests.length + 1,
            from: { alias: candidate.snapshot.source.alias, branchId: sourceId },
            to: destination,
            purpose,
            jenis: need.jenis,
            estimatedWeight: allocation,
            oldestBuybackAt: candidate.available.oldestBuybackAt,
            oldestBuybackAgeDays: candidate.available.oldestBuybackAgeDays,
          });
          remainingBySource.set(sourceId, round3(available - allocation));
          remaining = round3(Math.max(0, remaining - allocation));
        }
        const allocated = round3(requestedWeight - remaining);
        unfulfilledWeight = round3(unfulfilledWeight + remaining);
        if (branchNeed) {
          branchNeed.allocatedBuybackWeight = allocated;
          branchNeed.unfulfilledWeight = remaining;
        }
        return allocated;
      };

      let estimatedRequestedWeight = 0;
      if (need.centralShortageWeight > 0) {
        estimatedRequestedWeight += allocate(
          need.centralShortageWeight,
          'central-safety-stock',
          { alias: central.alias, branchId: central.branchId, type: 'central' },
        );
      }
      for (const branchNeed of need.branchShortages) {
        estimatedRequestedWeight += allocate(
          branchNeed.shortageWeight,
          'branch-month-end-shortage',
          { alias: branchNeed.alias, branchId: branchNeed.branchId, type: 'branch' },
          branchNeed,
        );
        allBranchShortages.push(branchNeed);
      }
      requests.push(...typeRequests);
      const buybackRowsWithoutWeight = need.candidates.reduce((sum, candidate) => sum + candidate.available.rowsWithoutWeight, 0);
      jenisSummaries.push({
        jenis: need.jenis,
        centralSafetyStockConfigured: need.centralSafetyStockConfigured,
        centralStockWeight: need.centralStockWeight,
        centralTargetWeight: need.centralTargetWeight,
        centralShortageWeight: need.centralShortageWeight,
        branchShortageWeight: need.branchShortageWeight,
        totalRequiredWeight: need.totalRequiredWeight,
        availableBuybackWeight,
        estimatedRequestedWeight: round3(estimatedRequestedWeight),
        unfulfilledWeight: round3(unfulfilledWeight),
        centralTargetEstimatedFromAverage: need.centralTargetEstimatedFromAverage,
        centralWeightEstimateUnavailable: need.centralWeightEstimateUnavailable,
        branchShortages: need.branchShortages,
        buybackRowsWithoutWeight,
      });
    }

    const omittedRequestCount = Math.max(0, requests.length - MAX_REQUEST_ROWS);
    const omittedBranchShortageCount = Math.max(0, allBranchShortages.length - MAX_REQUEST_ROWS);
    const buybackRowsWithoutWeight = jenisSummaries.reduce((sum, item) => sum + item.buybackRowsWithoutWeight, 0);
    return buildResult(
      central,
      branches.length,
      salesWindow,
      jenisSummaries,
      allBranchShortages.slice(0, MAX_REQUEST_ROWS),
      requests.slice(0, MAX_REQUEST_ROWS),
      snapshots,
      omittedRequestCount,
      omittedBranchShortageCount,
      branchesWithIncompleteWeightData,
      centralRowsWithoutWeight,
      buybackRowsWithoutWeight,
    );
  }

  private async readBranchSnapshot(
    source: CleaningPriorityDataSource,
    codes: string[],
    salesWindow: CleaningPrioritySalesWindow,
  ): Promise<BranchSnapshot> {
    const database = this.mongo.getDatabase(source.databaseName);
    const [stockRows, salesRows] = await Promise.all([
      database.collection('tm_barang')
        .aggregate<BranchStockRow>(branchStockPipeline(codes), { maxTimeMS: QUERY_MAX_TIME_MS, allowDiskUse: true })
        .toArray()
        .catch(() => null),
      database.collection('tt_jual_detail')
        .aggregate<BranchSalesRow>(branchSalesPipeline(codes, salesWindow), { maxTimeMS: QUERY_MAX_TIME_MS, allowDiskUse: true })
        .toArray()
        .catch(() => null),
    ]);
    return {
      source,
      buybackAvailable: false,
      stockAvailable: stockRows !== null,
      salesAvailable: salesRows !== null,
      buybackByJenis: new Map(),
      openIncomingByJenis: new Map(),
      stockByJenis: new Map((stockRows ?? []).map((row) => [String(row._id), {
        weight: finiteNumber(row.weight),
        rowsWithoutWeight: finiteNumber(row.rowsWithoutWeight),
      }])),
      salesByJenis: salesRows === null ? new Map() : salesByJenisMap(salesRows),
    };
  }

  private async readBranchBuyback(source: CleaningPriorityDataSource, codes: string[]): Promise<BranchBuybackRow[] | null> {
    try {
      return await this.mongo.getDatabase(source.databaseName)
        .collection('tt_beli_detail')
        .aggregate<BranchBuybackRow>(branchBuybackPipeline(codes), { maxTimeMS: QUERY_MAX_TIME_MS, allowDiskUse: true })
        .toArray();
    } catch {
      return null;
    }
  }

  private async readOpenIncoming(branchIds: string[], codes: string[]) {
    const result = new Map<string, Map<string, { weight: number; rowsWithoutWeight: number }>>();
    try {
      const database = this.mongo.getDatabase(env.shipmentSourceDatabaseName);
      const exists = await database.listCollections({ name: 'tt_kirim_barang' }, { nameOnly: true }).hasNext();
      if (!exists) throw new Error('collection missing');
      const rows = await database.collection('tt_kirim_barang').aggregate<OpenIncomingRow>(openIncomingPipeline(branchIds, codes), {
        maxTimeMS: QUERY_MAX_TIME_MS,
        allowDiskUse: true,
      }).toArray();
      rows.forEach((row) => {
        const branchId = String(row._id?.branchId ?? '');
        const jenis = String(row._id?.jenis ?? '');
        if (!branchId || !jenis) return;
        const byJenis = result.get(branchId) ?? new Map<string, { weight: number; rowsWithoutWeight: number }>();
        byJenis.set(jenis, { weight: finiteNumber(row.weight), rowsWithoutWeight: finiteNumber(row.rowsWithoutWeight) });
        result.set(branchId, byJenis);
      });
      return result;
    } catch {
      throw new CleaningPriorityError('Kiriman OPEN tidak dapat dibaca dari ' + env.shipmentSourceDatabaseName + '. Periksa koleksi tt_kirim_barang di sumber Pusat; data OPEN diperlukan untuk proyeksi Cabang.');
    }
  }

  private async readJenisNames(databaseName: string, codes?: string[]): Promise<Map<string, string>> {
    try {
      const match = codes?.length ? { kode_dept: { $in: codes } } : { kode_dept: { $type: 'string', $ne: '' } };
      const rows = await this.mongo.getDatabase(databaseName)
        .collection<Document & { kode_dept?: unknown; nama_dept?: unknown }>('tm_dept')
        .find(match, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
        .limit(MAX_ANALYZED_JENIS + 1)
        .toArray();
      if (rows.length > MAX_ANALYZED_JENIS) {
        throw new CleaningPriorityError(`Daftar tm_dept melebihi batas ${MAX_ANALYZED_JENIS} Jenis yang dapat dianalisis.`);
      }
      return new Map(rows.flatMap((row) => typeof row.kode_dept === 'string'
        ? [[row.kode_dept, decryptDepartmentName(row.nama_dept) ?? row.kode_dept] as [string, string]]
        : []));
    } catch (error) {
      if (error instanceof CleaningPriorityError) throw error;
      throw new CleaningPriorityError(`Daftar Jenis tidak dapat dibaca dari ${databaseName}. Pastikan koleksi tm_dept tersedia untuk analisis semua Cabang.`);
    }
  }
}

function centralStockPipeline(codes: string[]): Document[] {
  const units = { $convert: { input: '$stock_on_hand', to: 'double', onError: 0, onNull: 0 } };
  const itemWeight = { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } };
  return [
    { $match: {
      status_hancur: false,
      stock_on_hand: { $gt: 0 },
      kode_dept: { $in: codes },
    } },
    { $project: {
      jenis: '$kode_dept',
      units,
      weight: { $multiply: [itemWeight, units] },
      hasWeight: { $gt: [itemWeight, 0] },
    } },
    { $match: { units: { $gt: 0 } } },
    { $group: {
      _id: '$jenis',
      units: { $sum: '$units' },
      weight: { $sum: '$weight' },
      weightedUnits: { $sum: { $cond: ['$hasWeight', '$units', 0] } },
      rowsWithoutWeight: { $sum: { $cond: ['$hasWeight', 0, 1] } },
    } },
  ];
}

function branchStockPipeline(codes: string[]): Document[] {
  const units = { $convert: { input: '$stock_on_hand', to: 'double', onError: 0, onNull: 0 } };
  const itemWeight = { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } };
  return [
    { $match: {
      status_hancur: false,
      is_consignment_barang: false,
      kode_gudang: 'TOKO',
      stock_on_hand: { $gt: 0 },
      kode_dept: { $in: codes },
    } },
    { $project: {
      jenis: '$kode_dept',
      weight: { $multiply: [itemWeight, units] },
      hasWeight: { $gt: [itemWeight, 0] },
    } },
    { $group: {
      _id: '$jenis',
      weight: { $sum: '$weight' },
      rowsWithoutWeight: { $sum: { $cond: ['$hasWeight', 0, 1] } },
    } },
  ];
}

function branchBuybackPipeline(codes: string[]): Document[] {
  const inputDate = {
    $ifNull: [
      { $convert: { input: '$input_date', to: 'date', onError: null, onNull: null } },
      { $convert: { input: '$tgl_system', to: 'date', onError: null, onNull: null } },
    ],
  };
  return [
    { $match: {
      status_sortir: false,
      status_hancur: false,
      status_valid: { $ne: 'CANC' },
      kode_dept: { $in: codes },
    } },
    { $project: {
      jenis: '$kode_dept',
      weight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
      candidateDate: inputDate,
    } },
    { $group: {
      _id: '$jenis',
      weight: { $sum: '$weight' },
      weightedRows: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 1, 0] } },
      rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } },
      oldestBuybackAt: { $min: '$candidateDate' },
    } },
  ];
}

function branchSalesPipeline(codes: string[], salesWindow: CleaningPrioritySalesWindow): Document[] {
  return [
    { $match: {
      ...validSalesMatch(),
      kode_dept: { $in: codes },
      $or: [
        { tgl_system: { $gte: salesWindow.currentFrom, $lte: salesWindow.currentThrough } },
        { tgl_system: { $gte: salesWindow.previousFrom, $lte: salesWindow.previousThrough } },
      ],
    } },
    { $project: {
      jenis: '$kode_dept',
      period: { $cond: [{ $gte: ['$tgl_system', salesWindow.currentFrom] }, 'current', 'previous'] },
      weight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
    } },
    { $group: {
      _id: { jenis: '$jenis', period: '$period' },
      weight: { $sum: '$weight' },
      rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } },
    } },
  ];
}

function openIncomingPipeline(branchIds: string[], codes: string[]): Document[] {
  return [
    { $match: { status_terima: 'OPEN', tujuan: { $in: branchIds }, kode_dept: { $in: codes } } },
    { $project: {
      branchId: '$tujuan',
      jenis: '$kode_dept',
      weight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
    } },
    { $group: {
      _id: { branchId: '$branchId', jenis: '$jenis' },
      weight: { $sum: '$weight' },
      rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } },
    } },
  ];
}

function buildResult(
  central: CleaningPriorityDataSource,
  branchCount: number,
  salesWindow: CleaningPrioritySalesWindow,
  jenis: CleaningPriorityJenisSummary[],
  branchShortages: CleaningPriorityBranchShortage[],
  requests: CleaningPriorityRequest[],
  snapshots: BranchSnapshot[],
  omittedRequestCount = 0,
  omittedBranchShortageCount = 0,
  branchesWithIncompleteWeightData = 0,
  centralRowsWithoutWeight = 0,
  buybackRowsWithoutWeight = 0,
): Omit<CleaningPriorityResult, 'cacheStatus'> {
  const visibleJenis = jenis.slice(0, MAX_VISIBLE_JENIS);
  return {
    mode: 'buyback-cleaning-priority',
    generatedAt: new Date().toISOString(),
    central: { alias: central.alias, branchId: central.branchId },
    salesWindow,
    summary: {
      deficientJenisCount: jenis.length,
      totalCentralStockWeight: round3(jenis.reduce((sum, item) => sum + item.centralStockWeight, 0)),
      totalCentralTargetWeight: round3(jenis.reduce((sum, item) => sum + item.centralTargetWeight, 0)),
      totalCentralShortageWeight: round3(jenis.reduce((sum, item) => sum + item.centralShortageWeight, 0)),
      centralTargetEstimatedCount: jenis.filter((item) => item.centralTargetEstimatedFromAverage).length,
      centralWeightEstimateUnavailableCount: jenis.filter((item) => item.centralWeightEstimateUnavailable).length,
      totalBranchShortageWeight: round3(jenis.reduce((sum, item) => sum + item.branchShortageWeight, 0)),
      totalRequiredWeight: round3(jenis.reduce((sum, item) => sum + item.totalRequiredWeight, 0)),
      totalAvailableBuybackWeight: round3(jenis.reduce((sum, item) => sum + item.availableBuybackWeight, 0)),
      totalEstimatedRequestedWeight: round3(jenis.reduce((sum, item) => sum + item.estimatedRequestedWeight, 0)),
      totalUnfulfilledWeight: round3(jenis.reduce((sum, item) => sum + item.unfulfilledWeight, 0)),
      branchCount,
      analyzedBranchCount: snapshots.filter((snapshot) => snapshot.salesAvailable && snapshot.stockAvailable).length,
      branchesWithIncompleteWeightData,
      centralRowsWithoutWeight,
      buybackRowsWithoutWeight,
    },
    jenis: visibleJenis,
    branchShortages,
    requests,
    omittedJenisCount: Math.max(0, jenis.length - visibleJenis.length),
    omittedRequestCount,
    omittedBranchShortageCount,
    rules: {
      centralStock: 'Stok fisik Pusat berasal dari tm_barang per Jenis, stock_on_hand>0, dan status_hancur=false. Berat stok = berat × stock_on_hand; deleted_by bukan filter. Target safety stock Pusat hanya berlaku pada Jenis yang diatur dan dihitung sebagai nilai terbesar antara batas berat dan batas unit × rata-rata berat. Jika target bergantung pada batas unit, target gram adalah estimasi dari rata-rata berat stok Pusat atau kandidat buyback.',
      branchBuyback: 'Kandidat berasal dari tt_beli_detail Cabang dengan status_sortir=false, status_hancur=false, status_valid tidak sama dengan CANC, dan Jenis yang memiliki kebutuhan. Hanya berat tercatat yang dihitung. Tanggal tertua memakai input_date, lalu tgl_system jika tersedia.',
      sales: 'Penjualan Cabang berasal dari tt_jual_detail dengan status_kembali=OPEN dan status_valid=DONE; status_tukar=true atau trs_barang_tukar=true dikecualikan. Penjualan bulan ini dibandingkan dengan bulan yang sama tahun lalu sampai tanggal kalender yang sama; nilai berat terbesar dipakai sebagai acuan.',
      branchStock: 'Stok fisik jual Cabang di tm_barang memakai kode_gudang=TOKO, is_consignment_barang=false, stock_on_hand>0, dan status_hancur=false. Berat fisik = berat × stock_on_hand.',
      openIncoming: 'Berat kiriman OPEN dibaca dari sumber Pusat db_pntspst2.tt_kirim_barang berdasarkan tujuan Cabang dan kode Jenis. CLOS tidak ditambahkan karena barang yang diterima sudah tercermin pada tm_barang Cabang.',
      projection: 'Kebutuhan harian = berat penjualan acuan ÷ hari yang tercakup pada periode acuan pemenang. Kekurangan Cabang sampai akhir bulan = max(0, kebutuhan harian × hari tersisa − stok fisik tm_barang − kiriman OPEN dari Pusat). Total pencucian = kekurangan safety stock Pusat + kekurangan proyeksi Cabang per Jenis.',
      allocation: 'Kebutuhan Pusat dialokasikan lebih dahulu, lalu kekurangan Cabang diurutkan menurut cakupan stok terendah. Kandidat buyback dari Jenis yang sama diambil dari Cabang dengan berat eligible terbesar; tanggal tertua menjadi pemecah seri. Alokasi berdasarkan total berat agregat dan perlu diverifikasi melalui penimbangan saat pencucian. Rencana ini tidak membuat transaksi atau mengubah stok.',
      weight: 'Seluruh kebutuhan, kandidat, proyeksi, dan alokasi ditampilkan dalam gram. Baris tanpa berat tercatat tidak menambah alokasi gram dan membuat hasil ditandai tidak lengkap.',
    },
  };
}

function salesByJenisMap(rows: BranchSalesRow[]): Map<string, BranchSalesJenisSnapshot> {
  const result = new Map<string, BranchSalesJenisSnapshot>();
  for (const row of rows) {
    const code = row._id?.jenis;
    if (typeof code !== 'string') continue;
    const item = result.get(code) ?? emptySalesSnapshot();
    if (row._id.period === 'current') {
      item.currentWeight += finiteNumber(row.weight);
      item.currentRowsWithoutWeight += finiteNumber(row.rowsWithoutWeight);
    } else if (row._id.period === 'previous') {
      item.previousWeight += finiteNumber(row.weight);
      item.previousRowsWithoutWeight += finiteNumber(row.rowsWithoutWeight);
    }
    result.set(code, item);
  }
  return result;
}

function emptySalesSnapshot(): BranchSalesJenisSnapshot {
  return { currentWeight: 0, previousWeight: 0, currentRowsWithoutWeight: 0, previousRowsWithoutWeight: 0 };
}

function emptyBuybackSnapshot(): BuybackJenisSnapshot {
  return { weight: 0, weightedRows: 0, rowsWithoutWeight: 0, oldestBuybackAt: null, oldestBuybackAgeDays: null };
}

function getSalesWindow(now = new Date()): CleaningPrioritySalesWindow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const [year, month, day] = today.split('-').map(Number);
  const previousYear = year - 1;
  const previousMonthLastDay = new Date(Date.UTC(previousYear, month, 0)).getUTCDate();
  const previousDay = Math.min(day, previousMonthLastDay);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month: today.slice(0, 7),
    currentFrom: today.slice(0, 7) + '-01',
    currentThrough: today,
    previousFrom: String(previousYear).padStart(4, '0') + '-' + today.slice(5, 7) + '-01',
    previousThrough: String(previousYear).padStart(4, '0') + '-' + today.slice(5, 7) + '-' + String(previousDay).padStart(2, '0'),
    currentDays: day,
    previousDays: previousDay,
    remainingDays: Math.max(0, daysInMonth - day),
    monthEnd: today.slice(0, 7) + '-' + String(daysInMonth).padStart(2, '0'),
  };
}

function positive(value: number): number {
  return Math.max(0, finiteNumber(value));
}

function toIsoDate(value: Date | string | null | undefined): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function ageInDays(value: Date | string | null | undefined, now = new Date()): number | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

function compareOldestFirst(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function finiteNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}
