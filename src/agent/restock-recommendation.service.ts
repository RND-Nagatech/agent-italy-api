import { DistributionPriority, normalizeDistributionPriority, compareDistributionPriority } from '../sources/distribution-priority';
import { StockBaselineService, BaselineSnapshot, EMPTY_BASELINES, baselineFor } from '../stock-baselines/stock-baseline.service';
import { weeklyRestockPeriod } from './restock-period';
import { Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { validSalesMatch } from '../sales/sales-query-policy';

export interface RestockDataSource {
  distributionPriority?: DistributionPriority;
  databaseName: string;
  alias: string;
  branchId: string;
}

export class RestockRecommendationError extends Error {}

type SalesPeriod = 'last-seven-days' | 'previous-month';

interface SalesAggregateRow extends Document {
  _id: { department?: string; period?: SalesPeriod };
  soldUnits: number;
  soldWeight: number;
  soldRows: number;
  rowsWithoutWeight: number;
}

interface DepartmentStockRow extends Document {
  _id: string;
  stockUnits: number;
  stockWeight: number;
  rowsWithoutWeight: number;
}

interface DepartmentDocument extends Document {
  kode_dept?: unknown;
  nama_dept?: unknown;
}

interface OpenShipmentAggregateRow extends Document {
  _id: { branchId?: string; department?: string };
  units: number;
  weight: number;
  rowsWithoutWeight: number;
}

interface MonthPeriod {
  month: string;
  forecastFrom: string;
  forecastThrough: string;
  selectedSalesFrom: string;
  selectedSalesThrough: string;
  comparisonMonth: string;
  comparisonFrom: string;
  comparisonThrough: string;
  comparisonDaysInMonth: number;
  comparisonElapsedDays: number;
  monthEnd: string;
  daysInMonth: number;
  elapsedDays: number;
  remainingDays: number;
  isCurrentMonth: boolean;
}

interface BranchSnapshot {
  source: RestockDataSource;
  sales: Map<string, {
    recent: number;
    comparison: number;
    recentWeight: number;
    comparisonWeight: number;
    recentRows: number;
    comparisonRows: number;
    recentRowsWithoutWeight: number;
    comparisonRowsWithoutWeight: number;
  }>;
  stocks: Map<string, { units: number; weight: number; rowsWithoutWeight: number }>;
  departmentNames: Map<string, string>;
  openIncoming: Map<string, { units: number; weight: number; rowsWithoutWeight: number }>;
  unavailableReason?: string;
}

interface DepartmentProjection {
  kodeDept: string;
  namaDept: string;
  recentSalesUnits: number;
  recentSalesWeight: number;
  comparisonSalesUnits: number;
  comparisonSalesWeight: number;
  demandReferenceUnits: number;
  demandReferenceWeight: number;
  demandReferencePeriod: SalesPeriod | 'tie';
  estimatedDailyDemandUnits: number;
  dailyDemandWeight: number;
  targetStockWeight: number;
  targetStockUnits: number;
  baselinePcs: number;
  baselineConfigured: boolean;
  weeklyDemandTargetUnits: number;
  stockOnHandUnits: number;
  stockOnHandWeight: number;
  openIncomingUnits: number;
  openIncomingWeight: number;
  availableUnits: number;
  availableWeight: number;
  estimatedWeightPerUnit: number;
  stockCoverageDays: number | null;
  stockCoverageDaysIncludingOpenShipments: number | null;
  stockCoverageUnitDays: number | null;
  stockCoverageUnitDaysIncludingOpenShipments: number | null;
  stockMayRunOutWithinForecast: boolean;
  coverageShortfallDays: number;
  forecastDays: number;
  forecastDemandUnits: number;
  forecastDemandWeight: number;
  recommendedRestockUnits: number;
  recommendedRestockWeight: number;
  estimatedRestockWeight: number;
  weightDataQuality: {
    salesRowsWithoutWeight: number;
    stockRowsWithoutWeight: number;
    openShipmentRowsWithoutWeight: number;
  };
}

interface BranchProjection {
  source: RestockDataSource;
  departments: DepartmentProjection[];
  departmentsWithRestockNeed: number;
  totalDailyDemandWeight: number;
  totalRecentSalesUnits: number;
  totalRecentSalesWeight: number;
  totalComparisonSalesUnits: number;
  totalComparisonSalesWeight: number;
  totalStockOnHandUnits: number;
  totalStockOnHandWeight: number;
  totalOpenIncomingUnits: number;
  totalOpenIncomingWeight: number;
  totalForecastDemandUnits: number;
  totalForecastDemandWeight: number;
  totalRecommendedRestockUnits: number;
  totalEstimatedRestockWeight: number;
}

const SOURCE_CONCURRENCY = 4;
const QUERY_MAX_TIME_MS = 45_000;
const MAX_DEPARTMENT_ROWS_PER_BRANCH = 100;
const MAX_DEPARTMENT_ROWS_FOR_ALL_BRANCHES = 5;
const REQUIRED_BRANCH_COLLECTIONS = ['tt_jual_detail', 'tm_barang', 'tm_dept'];

@Injectable()
export class RestockRecommendationService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
    private readonly baselines: StockBaselineService,
  ) {}

  async recommend(sources: RestockDataSource[], targetBranchId?: string, requestedMonth?: string) {
    if (!sources.length) throw new RestockRecommendationError('Tidak ada sumber cabang aktif untuk dianalisis.');

    const baselineSnapshot = await this.baselines.snapshot();
    const period = monthPeriod(requestedMonth);
    const safeStockDays = 7;
    const target = targetBranchId
      ? sources.find((source) => source.branchId === targetBranchId)
      : undefined;
    if (targetBranchId && !target) {
      throw new RestockRecommendationError('Branch ID tujuan tidak ditemukan pada sumber aktif yang dapat diakses.');
    }

    const analysisSources = target ? [target] : sources;
    const sourceKey = analysisSources
      .map(({ databaseName, alias, branchId, distributionPriority }) => ({ databaseName, alias, branchId, distributionPriority: normalizeDistributionPriority(distributionPriority) }))
      .sort((left, right) => left.branchId.localeCompare(right.branchId));
    const key = 'agent:restock:baseline-pcs-v8:' + JSON.stringify({
      baselineRevision: baselineSnapshot.revision,
      targetBranchId: target?.branchId ?? 'all',
      month: period.month,
      projectionAsOf: period.selectedSalesThrough,
      safeStockDays,
      sources: sourceKey,
    });
    const { value, cacheStatus } = await this.cache.getOrLoadWithStatus(key, () =>
      this.buildRecommendation(analysisSources, target, period, safeStockDays, baselineSnapshot),
    );

    return { ...value, cacheStatus };
  }

  private async buildRecommendation(
    sources: RestockDataSource[],
    target: RestockDataSource | undefined,
    period: MonthPeriod,
    safeStockDays: number,
    baselineSnapshot: BaselineSnapshot,
  ) {
    const [snapshots, openByBranchAndDepartment] = await Promise.all([
      mapWithConcurrency(sources, SOURCE_CONCURRENCY, (source) => this.readBranch(source, period)),
      this.readOpenShipments(sources.map((source) => source.branchId)),
    ]);

    snapshots.forEach((snapshot) => {
      snapshot.openIncoming = openByBranchAndDepartment.get(snapshot.source.branchId) ?? new Map();
    });

    const unavailableSources = snapshots
      .filter((snapshot) => snapshot.unavailableReason)
      .map((snapshot) => ({
        branchId: snapshot.source.branchId,
        alias: snapshot.source.alias,
        reason: snapshot.unavailableReason,
      }));
    const completeSnapshots = snapshots.filter((snapshot) => !snapshot.unavailableReason);

    if (target && !completeSnapshots.some((snapshot) => snapshot.source.branchId === target.branchId)) {
      const unavailable = unavailableSources.find((source) => source.branchId === target.branchId);
      throw new RestockRecommendationError(
        unavailable
          ? 'Data ' + target.alias + ' belum lengkap: ' + unavailable.reason
          : 'Data ' + target.alias + ' belum dapat dianalisis.',
      );
    }
    if (!completeSnapshots.length) {
      throw new RestockRecommendationError('Koleksi penjualan, stok, dan Jenis tidak tersedia pada sumber aktif.');
    }

    const branchPlans = completeSnapshots.map((snapshot) => this.createBranchProjection(snapshot, period, safeStockDays, baselineSnapshot));
    branchPlans.sort((left, right) =>
      compareDistributionPriority(left.source, right.source)
      || right.totalRecommendedRestockUnits - left.totalRecommendedRestockUnits
      || left.source.branchId.localeCompare(right.source.branchId),
    );

    const totalRecommendedRestockUnits = branchPlans.reduce(
      (total, branch) => total + branch.totalRecommendedRestockUnits,
      0,
    );
    const totalProjectedDemandUnits = branchPlans.reduce(
      (total, branch) => total + branch.totalForecastDemandUnits,
      0,
    );
    const totalRecentSalesWeight = branchPlans.reduce(
      (total, branch) => total + branch.totalRecentSalesWeight,
      0,
    );
    const totalComparisonSalesWeight = branchPlans.reduce(
      (total, branch) => total + branch.totalComparisonSalesWeight,
      0,
    );
    const totalForecastDemandWeight = branchPlans.reduce(
      (total, branch) => total + branch.totalForecastDemandWeight,
      0,
    );
    const totalEstimatedRestockWeight = branchPlans.reduce(
      (total, branch) => total + branch.totalEstimatedRestockWeight,
      0,
    );

    return {
      baselineRevision: baselineSnapshot.revision,
      period: {
        windowDays: 7, comparisonMode: 'previous-month-same-dates',
        forecast: { from: period.forecastFrom, through: period.forecastThrough },
        month: period.month,
        selectedSales: {
          from: period.selectedSalesFrom,
          through: period.selectedSalesThrough,
          completeMonth: false,
        },
        comparisonMonth: period.comparisonMonth,
        comparisonSales: {
          from: period.comparisonFrom,
          through: period.comparisonThrough,
          completeMonth: false,
        },
        daysInMonth: period.daysInMonth,
        elapsedDaysForDailyDemand: period.elapsedDays,
        comparisonElapsedDaysForDailyDemand: period.comparisonElapsedDays,
        forecastDays: 7,
        projectionAsOf: period.selectedSalesThrough,
        safeStockDays,
        restockTargetDays: 7,
      },
      mode: target ? 'single-branch' : 'all-branches',
      targetBranch: target ? { branchId: target.branchId, alias: target.alias } : null,
      quantityUnit: 'pcs',
      policies: {
        demand: 'Acuan pcs = jumlah qty penjualan terbesar antara 7 hari terakhir dan tanggal sama bulan sebelumnya; kebutuhan harian = pcs acuan / hari aktual periode acuan.',
        inventory: 'tm_barang status_hancur=false, stock_on_hand>0; jumlah pcs dari stock_on_hand.',
        pendingInbound: 'Kiriman OPEN dari db_pntspst2.tt_kirim_barang ke cabang; satu dokumen = satu pcs. CLOS tidak ditambahkan.',
        recommendedRestock: 'Target pcs = patokan stok dasar + ceil(kebutuhan harian × 7). Restock = max(0, target pcs - stok fisik pcs - OPEN pcs). Semua rute mutasi dalam pcs bulat; bukan konversi dari gram.',
        sales: 'status_kembali=OPEN, status_valid=DONE; transaksi tukar dikecualikan. Laporan penjualan tersendiri tetap gram dan rupiah.',
      },
      totals: {
        scope: target ? 'target-branch' : 'all-branches',
        branchesAnalyzed: completeSnapshots.length,
        branchesUnavailable: unavailableSources.length,
        branchesWithRestockNeed: branchPlans.filter((branch) => branch.totalRecommendedRestockUnits > 0).length,
        dailyDemandUnits: roundUnits(branchPlans.reduce((sum, branch) => sum + branch.departments.reduce((total, row) => total + row.estimatedDailyDemandUnits, 0), 0)),
        dailyDemandWeight: roundWeight(branchPlans.reduce((sum, branch) => sum + branch.totalDailyDemandWeight, 0)),
        recentSalesUnits: roundUnits(branchPlans.reduce((sum, branch) => sum + branch.totalRecentSalesUnits, 0)),
        recentSalesWeight: roundWeight(totalRecentSalesWeight),
        comparisonSalesUnits: roundUnits(branchPlans.reduce((sum, branch) => sum + branch.totalComparisonSalesUnits, 0)),
        comparisonSalesWeight: roundWeight(totalComparisonSalesWeight),
        forecastDemandUnits: roundUnits(totalProjectedDemandUnits),
        forecastDemandWeight: roundWeight(totalForecastDemandWeight),
        recommendedRestockUnits: roundUnits(totalRecommendedRestockUnits),
        recommendedRestockWeight: roundWeight(totalEstimatedRestockWeight),
        estimatedRestockWeight: roundWeight(totalEstimatedRestockWeight),
      },
      branches: branchPlans.map((branch) => this.serializeBranch(
        branch,
        target ? MAX_DEPARTMENT_ROWS_PER_BRANCH : MAX_DEPARTMENT_ROWS_FOR_ALL_BRANCHES,
      )),
      unavailableSources,
      jenisLimitPerBranch: target ? MAX_DEPARTMENT_ROWS_PER_BRANCH : MAX_DEPARTMENT_ROWS_FOR_ALL_BRANCHES,
      note: 'Horizon restock adalah nilai terbesar antara sisa hari bulan dan ' + safeStockDays + ' hari stok aman. Saran restock = max(0, kebutuhan berat harian × horizon restock - stok fisik - kiriman OPEN).',
    };
  }

  private async readBranch(source: RestockDataSource, period: MonthPeriod): Promise<BranchSnapshot> {
    const snapshot: BranchSnapshot = {
      source,
      sales: new Map(),
      stocks: new Map(),
      departmentNames: new Map(),
      openIncoming: new Map(),
    };

    try {
      const db = this.mongo.getDatabase(source.databaseName);
      const present = await db
        .listCollections({ name: { $in: REQUIRED_BRANCH_COLLECTIONS } }, { nameOnly: true })
        .toArray();
      const presentNames = new Set(present.map(({ name }) => name));
      const missing = REQUIRED_BRANCH_COLLECTIONS.filter((name) => !presentNames.has(name));
      if (missing.length) {
        snapshot.unavailableReason = 'koleksi tidak ada: ' + missing.join(', ');
        return snapshot;
      }

      const [sales, stocks, departments] = await Promise.all([
        db.collection('tt_jual_detail').aggregate<SalesAggregateRow>(salesPipeline(period), {
          allowDiskUse: true,
          maxTimeMS: QUERY_MAX_TIME_MS,
        }).toArray(),
        db.collection('tm_barang').aggregate<DepartmentStockRow>(stockPipeline(), {
          allowDiskUse: true,
          maxTimeMS: QUERY_MAX_TIME_MS,
        }).toArray(),
        db.collection<DepartmentDocument>('tm_dept')
          .find({ status_aktif: true }, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
          .maxTimeMS(10_000)
          .toArray(),
      ]);

      sales.forEach((row) => {
        const department = cleanCode(row._id?.department);
        if (!department) return;
        const salesByMonth = snapshot.sales.get(department) ?? {
          recent: 0, comparison: 0, recentWeight: 0, comparisonWeight: 0,
          recentRows: 0, comparisonRows: 0, recentRowsWithoutWeight: 0, comparisonRowsWithoutWeight: 0,
        };
        if (row._id?.period === 'last-seven-days') {
          salesByMonth.recent += numeric(row.soldUnits);
          salesByMonth.recentWeight += numeric(row.soldWeight);
          salesByMonth.recentRows += numeric(row.soldRows);
          salesByMonth.recentRowsWithoutWeight += numeric(row.rowsWithoutWeight);
        }
        if (row._id?.period === 'previous-month') {
          salesByMonth.comparison += numeric(row.soldUnits);
          salesByMonth.comparisonWeight += numeric(row.soldWeight);
          salesByMonth.comparisonRows += numeric(row.soldRows);
          salesByMonth.comparisonRowsWithoutWeight += numeric(row.rowsWithoutWeight);
        }
        snapshot.sales.set(department, salesByMonth);
      });

      stocks.forEach((row) => {
        const department = cleanCode(row._id);
        if (department) snapshot.stocks.set(department, {
          units: numeric(row.stockUnits),
          weight: numeric(row.stockWeight),
          rowsWithoutWeight: numeric(row.rowsWithoutWeight),
        });
      });

      departments.forEach((department) => {
        const code = cleanCode(department.kode_dept);
        const name = decryptDepartmentName(department.nama_dept);
        if (code && name) snapshot.departmentNames.set(code, name);
      });
    } catch {
      snapshot.unavailableReason = 'pembacaan data gagal atau melewati batas waktu';
    }
    return snapshot;
  }

  private async readOpenShipments(branchIds: string[]): Promise<Map<string, Map<string, { units: number; weight: number; rowsWithoutWeight: number }>>> {
    const result = new Map<string, Map<string, { units: number; weight: number; rowsWithoutWeight: number }>>();
    const db = this.mongo.getDatabase(env.shipmentSourceDatabaseName);
    const exists = await db.listCollections({ name: 'tt_kirim_barang' }, { nameOnly: true }).hasNext();
    if (!exists) {
      throw new RestockRecommendationError(
        'Koleksi tt_kirim_barang tidak ditemukan di sumber pengiriman Pusat (' + env.shipmentSourceDatabaseName + ').',
      );
    }

    if (!branchIds.length) return result;
    const rows = await db.collection('tt_kirim_barang').aggregate<OpenShipmentAggregateRow>([
      {
        $match: {
          tujuan: { $in: branchIds },
          status_terima: 'OPEN',
          kode_dept: { $type: 'string', $ne: '' },
        },
      },
      {
        $group: {
          _id: { branchId: '$tujuan', department: '$kode_dept' },
          units: { $sum: 1 },
          weight: { $sum: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } } },
          rowsWithoutWeight: { $sum: { $cond: [{ $gt: [{ $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } }, 0] }, 0, 1] } },
        },
      },
    ], { allowDiskUse: true, maxTimeMS: QUERY_MAX_TIME_MS }).toArray();

    rows.forEach((row) => {
      const branchId = cleanCode(row._id?.branchId);
      const department = cleanCode(row._id?.department);
      if (!branchId || !department) return;
      const byDepartment = result.get(branchId) ?? new Map<string, { units: number; weight: number; rowsWithoutWeight: number }>();
      byDepartment.set(department, {
        units: numeric(row.units),
        weight: numeric(row.weight),
        rowsWithoutWeight: numeric(row.rowsWithoutWeight),
      });
      result.set(branchId, byDepartment);
    });
    return result;
  }

  private createBranchProjection(snapshot: BranchSnapshot, period: MonthPeriod, safeStockDays: number, baselineSnapshot: BaselineSnapshot = EMPTY_BASELINES): BranchProjection {
    const departmentCodes = new Set([
      ...snapshot.sales.keys(),
      ...snapshot.stocks.keys(),
      ...snapshot.openIncoming.keys(),
      ...baselineSnapshot.items.filter(row => row.active && row.branchId === snapshot.source.branchId).map(row => row.jenisCode),
    ]);
    const departments: DepartmentProjection[] = [];

    departmentCodes.forEach((kodeDept) => {
      const sales = snapshot.sales.get(kodeDept) ?? {
        recent: 0, comparison: 0, recentWeight: 0, comparisonWeight: 0,
        recentRows: 0, comparisonRows: 0, recentRowsWithoutWeight: 0, comparisonRowsWithoutWeight: 0,
      };
      const selectedSales = Math.max(0, numeric(sales.recent));
      const comparisonSales = Math.max(0, numeric(sales.comparison));
      const selectedWeight = Math.max(0, numeric(sales.recentWeight));
      const previousWeight = Math.max(0, numeric(sales.comparisonWeight));
      const selectedIsReference = selectedSales >= comparisonSales;
      const demandReferenceWeight = Math.max(selectedWeight, previousWeight);
      const demandReferenceUnits = Math.max(selectedSales, comparisonSales);
      const demandReferencePeriod: DepartmentProjection['demandReferencePeriod'] = selectedSales === comparisonSales
        ? 'tie'
        : selectedIsReference ? 'last-seven-days' : 'previous-month';
      const estimatedWeightPerUnit = demandReferenceUnits > 0 ? demandReferenceWeight / demandReferenceUnits : 0;
      const demandElapsedDays = selectedIsReference ? period.elapsedDays : period.comparisonElapsedDays;
      const dailyDemandUnits = demandElapsedDays > 0 ? demandReferenceUnits / demandElapsedDays : 0;
      const dailyDemandWeight = demandElapsedDays > 0 ? demandReferenceWeight / demandElapsedDays : 0;
      const stock = snapshot.stocks.get(kodeDept) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
      const incoming = snapshot.openIncoming.get(kodeDept) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
      const stockUnits = Math.max(0, Math.floor(numeric(stock.units)));
      const stockWeight = Math.max(0, numeric(stock.weight));
      const incomingUnits = Math.max(0, Math.floor(numeric(incoming.units)));
      const incomingWeight = Math.max(0, numeric(incoming.weight));
      const available = stockUnits + incomingUnits;
      const availableWeight = stockWeight + incomingWeight;
      const stockCoverageDays = dailyDemandUnits > 0 ? Math.floor(stockUnits / dailyDemandUnits) : null;
      const stockCoverageDaysIncludingOpenShipments = dailyDemandUnits > 0
        ? Math.floor(available / dailyDemandUnits)
        : null;
      const stockMayRunOutWithinForecast = stockCoverageDaysIncludingOpenShipments !== null
        && stockCoverageDaysIncludingOpenShipments < period.remainingDays;
      const coverageShortfallDays = stockCoverageDaysIncludingOpenShipments === null
        ? 0
        : Math.max(0, period.remainingDays - stockCoverageDaysIncludingOpenShipments);
      const stockCoverageUnitDays = dailyDemandUnits > 0 ? Math.floor(stockUnits / dailyDemandUnits) : null;
      const stockCoverageUnitDaysIncludingOpenShipments = dailyDemandUnits > 0
        ? Math.floor(available / dailyDemandUnits)
        : null;
      const projectedDemandUnits = dailyDemandUnits * period.remainingDays;
      const projectedDemandWeight = dailyDemandWeight * period.remainingDays;
      const restockTargetDays = 7;
      const { baselinePcs, baselineConfigured } = baselineFor(baselineSnapshot, snapshot.source.branchId, kodeDept);
      const weeklyDemandTargetUnits = Math.max(0, Math.ceil(dailyDemandUnits * restockTargetDays - 1e-9));
      const targetStockUnits = baselinePcs + weeklyDemandTargetUnits;
      const targetStockWeight = dailyDemandWeight * restockTargetDays;
      const recommendedRestockUnits = Math.max(0, targetStockUnits - available);
      const recommendedRestockWeight = Math.max(0, targetStockWeight - availableWeight);
      const salesRowsWithoutWeight = selectedWeight > previousWeight
        ? numeric(sales.recentRowsWithoutWeight)
        : previousWeight > selectedWeight
          ? numeric(sales.comparisonRowsWithoutWeight)
          : numeric(sales.recentRowsWithoutWeight) + numeric(sales.comparisonRowsWithoutWeight);
      if (baselinePcs <= 0 && demandReferenceUnits <= 0 && demandReferenceWeight <= 0 && stockUnits <= 0 && incomingUnits <= 0) return;
      departments.push({
        kodeDept,
        namaDept: snapshot.departmentNames.get(kodeDept) ?? kodeDept,
        recentSalesUnits: roundUnits(selectedSales),
        recentSalesWeight: roundWeight(selectedWeight),
        comparisonSalesUnits: roundUnits(comparisonSales),
        comparisonSalesWeight: roundWeight(previousWeight),
        demandReferenceUnits: roundUnits(demandReferenceUnits),
        demandReferenceWeight: roundWeight(demandReferenceWeight),
        demandReferencePeriod,
        estimatedDailyDemandUnits: roundUnits(dailyDemandUnits),
        dailyDemandWeight: roundWeight(dailyDemandWeight),
        targetStockWeight: roundWeight(targetStockWeight),
        baselinePcs, baselineConfigured, weeklyDemandTargetUnits,
        targetStockUnits,
        stockOnHandUnits: roundUnits(stockUnits),
        stockOnHandWeight: roundWeight(stockWeight),
        openIncomingUnits: roundUnits(incomingUnits),
        openIncomingWeight: roundWeight(incomingWeight),
        availableUnits: roundUnits(available),
        availableWeight: roundWeight(availableWeight),
        estimatedWeightPerUnit: roundWeight(estimatedWeightPerUnit),
        stockCoverageDays,
        stockCoverageDaysIncludingOpenShipments,
        stockCoverageUnitDays,
        stockCoverageUnitDaysIncludingOpenShipments,
        stockMayRunOutWithinForecast,
        coverageShortfallDays,
        forecastDays: period.remainingDays,
        forecastDemandUnits: roundUnits(projectedDemandUnits),
        forecastDemandWeight: roundWeight(projectedDemandWeight),
        recommendedRestockUnits: roundUnits(recommendedRestockUnits),
        recommendedRestockWeight: roundWeight(recommendedRestockWeight),
        estimatedRestockWeight: roundWeight(recommendedRestockWeight),
        weightDataQuality: {
          salesRowsWithoutWeight,
          stockRowsWithoutWeight: numeric(stock.rowsWithoutWeight),
          openShipmentRowsWithoutWeight: numeric(incoming.rowsWithoutWeight),
        },
      });
    });

    departments.sort((left, right) =>
      right.recommendedRestockUnits - left.recommendedRestockUnits
      || (left.stockCoverageDays ?? Number.POSITIVE_INFINITY) - (right.stockCoverageDays ?? Number.POSITIVE_INFINITY)
      || right.dailyDemandWeight - left.dailyDemandWeight
      || left.kodeDept.localeCompare(right.kodeDept),
    );

    return {
      source: snapshot.source,
      departments,
      departmentsWithRestockNeed: departments.filter((department) => department.recommendedRestockUnits > 0).length,
      totalDailyDemandWeight: roundWeight(departments.reduce((sum, department) => sum + department.dailyDemandWeight, 0)),
      totalRecentSalesUnits: roundUnits(departments.reduce((sum, department) => sum + department.recentSalesUnits, 0)),
      totalRecentSalesWeight: roundWeight(departments.reduce((sum, department) => sum + department.recentSalesWeight, 0)),
      totalComparisonSalesUnits: roundUnits(departments.reduce((sum, department) => sum + department.comparisonSalesUnits, 0)),
      totalComparisonSalesWeight: roundWeight(departments.reduce((sum, department) => sum + department.comparisonSalesWeight, 0)),
      totalStockOnHandUnits: roundUnits(departments.reduce((sum, department) => sum + department.stockOnHandUnits, 0)),
      totalStockOnHandWeight: roundWeight(departments.reduce((sum, department) => sum + department.stockOnHandWeight, 0)),
      totalOpenIncomingUnits: roundUnits(departments.reduce((sum, department) => sum + department.openIncomingUnits, 0)),
      totalOpenIncomingWeight: roundWeight(departments.reduce((sum, department) => sum + department.openIncomingWeight, 0)),
      totalForecastDemandUnits: roundUnits(departments.reduce(
        (sum, department) => sum + department.forecastDemandUnits,
        0,
      )),
      totalForecastDemandWeight: roundWeight(departments.reduce(
        (sum, department) => sum + department.forecastDemandWeight,
        0,
      )),
      totalRecommendedRestockUnits: roundUnits(departments.reduce(
        (sum, department) => sum + department.recommendedRestockUnits,
        0,
      )),
      totalEstimatedRestockWeight: roundWeight(departments.reduce(
        (sum, department) => sum + department.estimatedRestockWeight,
        0,
      )),
    };
  }

  private serializeBranch(branch: BranchProjection, departmentLimit: number) {
    return {
      branchId: branch.source.branchId,
      alias: branch.source.alias,
      distributionPriority: normalizeDistributionPriority(branch.source.distributionPriority),
      jenisWithRestockNeed: branch.departmentsWithRestockNeed,
      baselinePcs: branch.departments.reduce((sum, row) => sum + row.baselinePcs, 0),
      weeklyDemandTargetUnits: branch.departments.reduce((sum, row) => sum + row.weeklyDemandTargetUnits, 0),
      dailyDemandUnits: roundUnits(branch.departments.reduce((sum, row) => sum + row.estimatedDailyDemandUnits, 0)),
      dailyDemandWeight: branch.totalDailyDemandWeight,
      recentSalesUnits: branch.totalRecentSalesUnits,
      recentSalesWeight: branch.totalRecentSalesWeight,
      comparisonSalesUnits: branch.totalComparisonSalesUnits,
      comparisonSalesWeight: branch.totalComparisonSalesWeight,
      stockOnHandUnits: branch.totalStockOnHandUnits,
      stockOnHandWeight: branch.totalStockOnHandWeight,
      openIncomingUnits: branch.totalOpenIncomingUnits,
      openIncomingWeight: branch.totalOpenIncomingWeight,
      forecastDemandUnits: branch.totalForecastDemandUnits,
      forecastDemandWeight: branch.totalForecastDemandWeight,
      recommendedRestockUnits: branch.totalRecommendedRestockUnits,
      recommendedRestockWeight: branch.totalEstimatedRestockWeight,
      estimatedRestockWeight: branch.totalEstimatedRestockWeight,
      jenis: branch.departments.slice(0, departmentLimit).map(({ kodeDept, namaDept, ...metrics }) => ({
        kode: kodeDept,
        nama: namaDept,
        ...metrics,
      })),
      omittedJenisCount: Math.max(0, branch.departments.length - departmentLimit),
    };
  }
}

function salesPipeline(period: MonthPeriod): Document[] {
  return [
    {
      $match: {
        ...validSalesMatch(),
        kode_dept: { $type: 'string', $ne: '' },
        $or: [
          {
            tgl_system: {
              $gte: period.selectedSalesFrom,
              $lte: period.selectedSalesThrough,
            },
          },
          {
            tgl_system: {
              $gte: period.comparisonFrom,
              $lte: period.comparisonThrough,
            },
          },
        ],
      },
    },
    {
      $project: {
        department: '$kode_dept',
        period: {
          $cond: [
            { $gte: ['$tgl_system', period.selectedSalesFrom] },
            'last-seven-days',
            'previous-month',
          ],
        },
        soldUnits: { $convert: { input: '$qty', to: 'double', onError: 0, onNull: 0 } },
        soldWeight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
      },
    },
    { $match: { $or: [{ soldUnits: { $gt: 0 } }, { soldWeight: { $gt: 0 } }] } },
    {
      $group: {
        _id: { department: '$department', period: '$period' },
        soldUnits: { $sum: '$soldUnits' },
        soldWeight: { $sum: '$soldWeight' },
        soldRows: { $sum: 1 },
        rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$soldWeight', 0] }, 0, 1] } },
      },
    },
  ];
}

function stockPipeline(): Document[] {
  return [
    {
      $match: {
        status_hancur: false,
        stock_on_hand: { $gt: 0 },
        kode_dept: { $type: 'string', $ne: '' },
      },
    },
    {
      $project: {
        department: '$kode_dept',
        stockUnits: { $convert: { input: '$stock_on_hand', to: 'double', onError: 0, onNull: 0 } },
        stockWeight: {
          $multiply: [
            { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
            { $convert: { input: '$stock_on_hand', to: 'double', onError: 0, onNull: 0 } },
          ],
        },
        rowWithoutWeight: {
          $cond: [
            { $gt: [{ $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } }, 0] },
            0,
            1,
          ],
        },
      },
    },
    { $match: { stockUnits: { $gt: 0 } } },
    {
      $group: {
        _id: '$department',
        stockUnits: { $sum: '$stockUnits' },
        stockWeight: { $sum: '$stockWeight' },
        rowsWithoutWeight: { $sum: '$rowWithoutWeight' },
      },
    },
  ];
}

function monthPeriod(requestedMonth?: string): MonthPeriod {
  try { const period = weeklyRestockPeriod(requestedMonth); return { ...period, selectedSalesFrom: period.selectedFrom, selectedSalesThrough: period.selectedThrough, }; }
  catch (error) { throw new RestockRecommendationError(error instanceof Error ? error.message : 'Periode tidak valid.'); }
}

function cleanCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned : undefined;
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundUnits(value: number): number {
  return Number(value.toFixed(3));
}

function roundWeight(value: number): number {
  return Number(value.toFixed(3));
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

