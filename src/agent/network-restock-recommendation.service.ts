import { DistributionPriority, normalizeDistributionPriority, compareDistributionPriority } from '../sources/distribution-priority';
import type { ItemCategory } from '../sources/item-category';
import { StockBaselineService, BaselineSnapshot, EMPTY_BASELINES, baselineFor } from '../stock-baselines/stock-baseline.service';
import { weeklyRestockPeriod } from './restock-period';
import { Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { validSalesMatch } from '../sales/sales-query-policy';
import type { ProductDistributionCategory } from '../sources/product-category';
import type { DistributionFulfillmentMethod } from '../settings/network-restock-settings.service';

export type NetworkRestockSourceType = 'branch' | 'central';

export interface NetworkRestockDataSource {
  databaseName: string;
  alias: string;
  branchId: string;
  sourceType: NetworkRestockSourceType;
  distributionPriority?: DistributionPriority;
  itemCategory?: ItemCategory;
}

export class NetworkRestockRecommendationError extends Error {}

type SalesPeriod = 'last-seven-days' | 'previous-month';

interface SalesAggregateRow extends Document {
  _id: { jenis?: string; period?: SalesPeriod };
  soldUnits: number;
  soldWeight: number;
  soldRows: number;
  rowsWithoutWeight: number;
}

interface StockAggregateRow extends Document {
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
  _id: { branchId?: unknown; jenis?: unknown };
  units: number;
  weight: number;
  rowsWithoutWeight: number;
}

interface AnalysisPeriod {
  month: string;
  forecastFrom: string;
  forecastThrough: string;
  selectedFrom: string;
  selectedThrough: string;
  projectionAsOf: string;
  comparisonMonth: string;
  comparisonFrom: string;
  comparisonThrough: string;
  comparisonDaysInMonth: number;
  comparisonElapsedDays: number;
  monthEnd: string;
  elapsedDays: number;
  remainingDays: number;
  daysInMonth: number;
}

interface SourceSnapshot {
  source: NetworkRestockDataSource;
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
  stock: Map<string, { units: number; weight: number; rowsWithoutWeight: number }>;
  jenisNames: Map<string, string>;
  unavailableReason?: string;
}

interface BranchJenisState {
  source: NetworkRestockDataSource;
  kode: string;
  nama: string;
  selectedSales: number;
  comparisonSales: number;
  selectedSalesWeight: number;
  comparisonSalesWeight: number;
  referenceSalesWeight: number;
  referencePeriod: SalesPeriod | 'tie';
  weightPerUnit: number;
  dailyDemand: number;
  dailyDemandWeight: number;
  targetStock: number;
  baselinePcs: number;
  baselineConfigured: boolean;
  weeklyDemandTargetUnits: number;
  targetStockWeight: number;
  physicalStock: number;
  physicalStockWeight: number;
  openIncoming: number;
  openIncomingWeight: number;
  projectedStock: number;
  projectedStockWeight: number;
  coverageDays: number | null;
  shortage: number;
  shortageWeight: number;
  surplus: number;
  surplusWeight: number;
  surplusBeforeTransfers: number;
  surplusWeightBeforeTransfers: number;
  unfilled: number;
  unfilledWeight: number;
  weightDataQuality: {
    salesRowsWithoutWeight: number;
    stockRowsWithoutWeight: number;
    openShipmentRowsWithoutWeight: number;
  };
}

export interface TransferRecommendation {
  priority: number;
  from: { alias: string; branchId: string; sourceType: NetworkRestockSourceType };
  to: { alias: string; branchId: string; distributionPriority?: DistributionPriority };
  jenis: { kode: string; nama: string };
  quantity: number;
  estimatedUnits: number;
  estimatedWeight: number;
}

interface OpenShipmentSnapshot {
  byBranchAndJenis: Map<string, Map<string, { units: number; weight: number; rowsWithoutWeight: number }>>;
  byJenis: Map<string, { units: number; weight: number; rowsWithoutWeight: number }>;
  openRows: number;
  unitsToUnconfiguredDestinations: number;
}

const SOURCE_CONCURRENCY = 4;
const QUERY_MAX_TIME_MS = 45_000;
const MAX_SOURCE_COUNT = 100;
const MAX_TRANSFER_ROWS = 300;
const MAX_UNFILLED_ROWS = 300;
const MAX_JENIS_ROWS = 100;
const MAX_BRANCHES_PER_JENIS_POSITION = 5;
const REQUIRED_BRANCH_COLLECTIONS = ['tt_jual_detail', 'tm_barang', 'tm_dept'];
const REQUIRED_CENTRAL_COLLECTIONS = ['tm_barang', 'tm_dept'];

export interface NetworkRestockOptions {
  jenisCode?: string;
  sourceBranchId?: string;
  availablePcs?: number;
  productCategory?: ProductDistributionCategory;
  fulfillmentMethod?: DistributionFulfillmentMethod;
  distributionOrders?: { X: string[]; XB: string[] };
  includeAllSurplusBranches?: boolean;
  includeTargetTransfersForBranchId?: string;
}

@Injectable()
export class NetworkRestockRecommendationService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
    private readonly baselines: StockBaselineService,
  ) {}

  async recommend(sources: NetworkRestockDataSource[], requestedMonth?: string, options: NetworkRestockOptions = {}) {
    if (!sources.length) {
      throw new NetworkRestockRecommendationError('Belum ada sumber data Agent AI yang aktif.');
    }
    if (sources.length > MAX_SOURCE_COUNT) {
      throw new NetworkRestockRecommendationError(`Analisis dibatasi maksimal ${MAX_SOURCE_COUNT} sumber aktif.`);
    }

    const branches = sources.filter((source) => source.sourceType === 'branch');
    const centralSources = sources.filter((source) => source.sourceType === 'central');
    if (centralSources.length !== 1) {
      throw new NetworkRestockRecommendationError(
        centralSources.length === 0
          ? 'Tandai satu sumber data sebagai Pusat sebelum membuat rencana distribusi gabungan.'
          : 'Ada lebih dari satu sumber yang ditandai sebagai Pusat. Sisakan tepat satu sumber Pusat.',
      );
    }
    if (!branches.length) {
      throw new NetworkRestockRecommendationError('Belum ada sumber cabang aktif untuk dibandingkan dengan stok Pusat.');
    }

    const jenisCode = options.jenisCode?.trim();
    const sourceBranchId = options.sourceBranchId?.trim();
    if (options.availablePcs !== undefined && (!Number.isSafeInteger(options.availablePcs) || options.availablePcs < 1 || options.availablePcs > 1_000_000)) {
      throw new NetworkRestockRecommendationError('Jumlah stok ditawarkan harus pcs bulat antara 1 dan 1.000.000.');
    }
    if ((sourceBranchId || options.availablePcs !== undefined || options.productCategory !== undefined)
      && (!jenisCode || !sourceBranchId || options.availablePcs === undefined || !options.productCategory)) {
      throw new NetworkRestockRecommendationError('Alokasi stok tertentu memerlukan jenisCode, sourceBranchId, availablePcs, dan kategori barang X, XB, atau B.');
    }
    if (sourceBranchId && !sources.some(source => source.branchId === sourceBranchId)) {
      throw new NetworkRestockRecommendationError('Sumber pengirim tidak termasuk sumber aktif yang diizinkan.');
    }
    const allocationOptions = {
      jenisCode,
      sourceBranchId,
      availablePcs: options.availablePcs,
      productCategory: options.productCategory,
      fulfillmentMethod: options.fulfillmentMethod ?? 'branch-first',
      distributionOrders: options.distributionOrders,
    };
    const baselineSnapshot = await this.baselines.snapshot();
    const period = analysisPeriod(requestedMonth);
    const safeStockDays = 7;
    const includeAllSurplusBranches = options.includeAllSurplusBranches === true;
    const includeTargetTransfersForBranchId = options.includeTargetTransfersForBranchId?.trim() || undefined;
    const sourceKey = sources
      .map(({ databaseName, alias, branchId, sourceType, distributionPriority, itemCategory }) => ({ databaseName, alias, branchId, sourceType, distributionPriority: normalizeDistributionPriority(distributionPriority), itemCategory }))
      .sort((left, right) => left.sourceType.localeCompare(right.sourceType) || left.branchId.localeCompare(right.branchId));
    const key = 'agent:network-restock:priority-pcs-v12:' + JSON.stringify({
      baselineRevision: baselineSnapshot.revision,
      month: period.month,
      projectionAsOf: period.projectionAsOf,
      safeStockDays,
      sources: sourceKey,
      includeAllSurplusBranches,
      includeTargetTransfersForBranchId,
      ...allocationOptions,
    });
    const { value, cacheStatus } = await this.cache.getOrLoadWithStatus(key, () =>
      this.buildRecommendation(branches, centralSources[0], period, safeStockDays, includeAllSurplusBranches, includeTargetTransfersForBranchId, allocationOptions, baselineSnapshot),
    );

    return { ...value, cacheStatus };
  }

  private async buildRecommendation(
    branches: NetworkRestockDataSource[],
    central: NetworkRestockDataSource,
    period: AnalysisPeriod,
    safeStockDays: number,
    includeAllSurplusBranches: boolean,
    includeTargetTransfersForBranchId: string | undefined,
    allocationOptions: Pick<NetworkRestockOptions, 'jenisCode' | 'sourceBranchId' | 'availablePcs' | 'productCategory' | 'fulfillmentMethod' | 'distributionOrders'>,
    baselineSnapshot: BaselineSnapshot,
  ) {
    const restockTargetDays = 7;
    const [branchSnapshots, centralSnapshot, openShipments] = await Promise.all([
      mapWithConcurrency(branches, SOURCE_CONCURRENCY, (source) => this.readSource(source, period)),
      this.readSource(central, period),
      this.readOpenShipments(new Set(branches.map((source) => source.branchId))),
    ]);

    const unavailable = [...branchSnapshots, centralSnapshot]
      .filter((snapshot) => snapshot.unavailableReason)
      .map((snapshot) => ({
        alias: snapshot.source.alias,
        branchId: snapshot.source.branchId,
        sourceType: snapshot.source.sourceType,
        reason: snapshot.unavailableReason,
      }));
    if (unavailable.length) {
      const sourceNames = unavailable.map((source) => `${source.alias} (${source.branchId})`).join(', ');
      throw new NetworkRestockRecommendationError(
        `Rencana gabungan dihentikan karena data sumber belum lengkap: ${sourceNames}. Perbaiki koneksi atau koleksi sumber lalu coba lagi.`,
      );
    }

    const allSnapshots = [centralSnapshot, ...branchSnapshots];
    const namesByJenis = new Map<string, string>();
    allSnapshots.forEach((snapshot) => snapshot.jenisNames.forEach((name, code) => {
      if (!namesByJenis.has(code)) namesByJenis.set(code, name);
    }));

    const codes = new Set<string>([
      ...baselineSnapshot.items.filter(row => row.active && branches.some(branch => branch.branchId === row.branchId)).map(row => row.jenisCode),
      ...centralSnapshot.stock.keys(),
      ...openShipments.byJenis.keys(),
      ...branchSnapshots.flatMap((snapshot) => [
        ...snapshot.sales.keys(),
        ...snapshot.stock.keys(),
      ]),
    ]);
    if (allocationOptions.jenisCode) {
      const requestedCode = allocationOptions.jenisCode.toLocaleUpperCase('en-US');
      const matchingCode = [...codes].find(code => code.toLocaleUpperCase('en-US') === requestedCode);
      if (!matchingCode) throw new NetworkRestockRecommendationError('Jenis yang diminta tidak ditemukan pada penjualan, stok, atau kiriman sumber aktif.');
      codes.clear(); codes.add(matchingCode);
    }
    let remainingBudget = allocationOptions.availablePcs ?? Number.POSITIVE_INFINITY;
    let sourceAvailablePcs = 0;
    let offeredEligibleRecipientBranchIds: string[] = [];
    let offeredEligibleRecipientShortagePcs = 0;
    let offeredUnfilledEligibleShortagePcs = 0;
    let offeredExcludedRecipientBranchCount = 0;
    const transfers: TransferRecommendation[] = [];
    const unfilledNeeds: Array<{
      branchId: string;
      alias: string;
      distributionPriority?: DistributionPriority;
      jenis: { kode: string; nama: string };
      units: number;
      estimatedUnits: number;
      estimatedWeight: number;
      coverageDays: number | null;
    }> = [];
    const perBranchStates = new Map<string, BranchJenisState[]>();
    const jenisSummaries: Array<Record<string, unknown>> = [];
    let priority = 0;

    for (const code of [...codes].sort((left, right) => left.localeCompare(right))) {
      const transferStartIndex = transfers.length;
      const name = namesByJenis.get(code) ?? code;
      const centralStock = centralSnapshot.stock.get(code) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
      const centralOutbound = openShipments.byJenis.get(code) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
      const centralPhysical = positive(centralStock.units);
      const centralPhysicalWeight = positive(centralStock.weight);
      const centralWeightPerUnit = centralPhysical > 0 ? centralPhysicalWeight / centralPhysical : 0;
      const centralCommitted = positive(centralOutbound.units);
      const centralCommittedWeight = positive(centralOutbound.weight);
      const centralWeightComplete = positive(centralStock.rowsWithoutWeight) === 0
        && positive(centralOutbound.rowsWithoutWeight) === 0;
      let centralAvailable = Math.max(0, Math.floor(centralPhysical - centralCommitted));
      let centralAvailableWeight = centralWeightComplete
        ? Math.max(0, centralPhysicalWeight - centralCommittedWeight)
        : 0;
      let jenisBranchSurplus = 0;
      let jenisBranchSurplusWeight = 0;
      let jenisShortage = 0;
      let jenisShortageWeight = 0;
      let jenisDemandPerDay = 0;
      let jenisDemandWeightPerDay = 0;
      let jenisBufferStock = 0;
      let jenisBufferStockWeight = 0;
      let jenisPhysicalBranchStock = 0;
      let jenisPhysicalBranchStockWeight = 0;
      let jenisIncoming = 0;
      let jenisIncomingWeight = 0;
      let jenisAllocated = 0;
      let jenisAllocatedWeight = 0;
      let branchesWithShortage = 0;
      let branchesWithSurplus = 0;

      const states: BranchJenisState[] = branchSnapshots.map((snapshot) => {
        const sales = snapshot.sales.get(code) ?? {
          recent: 0, comparison: 0, recentWeight: 0, comparisonWeight: 0,
          recentRows: 0, comparisonRows: 0, recentRowsWithoutWeight: 0, comparisonRowsWithoutWeight: 0,
        };
        const selectedSales = positive(sales.recent);
        const comparisonSales = positive(sales.comparison);
        const selectedWeight = positive(sales.recentWeight);
        const comparisonWeight = positive(sales.comparisonWeight);
        const selectedIsReference = selectedSales >= comparisonSales;
        const referenceWeight = Math.max(selectedWeight, comparisonWeight);
        const referenceSales = Math.max(selectedSales, comparisonSales);
        const referencePeriod: BranchJenisState['referencePeriod'] = selectedSales === comparisonSales
          ? 'tie'
          : selectedIsReference ? 'last-seven-days' : 'previous-month';
        const weightPerUnit = referenceSales > 0 ? referenceWeight / referenceSales : 0;
        const demandElapsedDays = selectedIsReference ? period.elapsedDays : period.comparisonElapsedDays;
        const dailyDemand = demandElapsedDays > 0 ? referenceSales / demandElapsedDays : 0;
        const dailyDemandWeight = demandElapsedDays > 0 ? referenceWeight / demandElapsedDays : 0;
        const { baselinePcs, baselineConfigured } = baselineFor(baselineSnapshot, snapshot.source.branchId, code);
        const weeklyDemandTargetUnits = Math.max(0, Math.ceil(dailyDemand * restockTargetDays - 1e-9));
        const targetStock = baselinePcs + weeklyDemandTargetUnits;
        const targetStockWeight = dailyDemandWeight * restockTargetDays;
        const salesRowsWithoutWeight = selectedWeight > comparisonWeight
          ? positive(sales.recentRowsWithoutWeight)
          : comparisonWeight > selectedWeight
            ? positive(sales.comparisonRowsWithoutWeight)
            : positive(sales.recentRowsWithoutWeight) + positive(sales.comparisonRowsWithoutWeight);
        const stock = snapshot.stock.get(code) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
        const physicalStock = positive(stock.units);
        const physicalStockWeight = positive(stock.weight);
        const stockWeightPerUnit = physicalStock > 0 ? physicalStockWeight / physicalStock : 0;
        const open = openShipments.byBranchAndJenis.get(snapshot.source.branchId)?.get(code) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
        const openIncoming = positive(open.units);
        const openIncomingWeight = positive(open.weight);
        const projectedStock = physicalStock + openIncoming;
        const projectedStockWeight = physicalStockWeight + openIncomingWeight;
        const weightDemandAssessable = salesRowsWithoutWeight === 0
          && positive(stock.rowsWithoutWeight) === 0
          && positive(open.rowsWithoutWeight) === 0;
        const shortageWeight = weightDemandAssessable ? Math.max(0, targetStockWeight - projectedStockWeight) : 0;
        const surplusWeight = weightDemandAssessable ? Math.max(0, physicalStockWeight - targetStockWeight) : 0;
        const shortage = Math.max(0, Math.ceil(targetStock - projectedStock));
        const surplus = Math.max(0, Math.floor(physicalStock - targetStock));
        const coverageDays = dailyDemand > 0 ? projectedStock / dailyDemand : null;
        const weightDataQuality = {
          salesRowsWithoutWeight,
          stockRowsWithoutWeight: positive(stock.rowsWithoutWeight),
          openShipmentRowsWithoutWeight: positive(open.rowsWithoutWeight),
        };
        jenisBranchSurplus += surplus;
        jenisBranchSurplusWeight += surplusWeight;
        jenisShortage += shortage;
        jenisShortageWeight += shortageWeight;
        jenisDemandPerDay += dailyDemand;
        jenisDemandWeightPerDay += dailyDemandWeight;
        jenisBufferStock += targetStock;
        jenisBufferStockWeight += targetStockWeight;
        jenisPhysicalBranchStock += physicalStock;
        jenisPhysicalBranchStockWeight += physicalStockWeight;
        jenisIncoming += openIncoming;
        jenisIncomingWeight += openIncomingWeight;
        if (shortage > 0) branchesWithShortage += 1;
        if (surplus > 0) branchesWithSurplus += 1;
        const branchStates = perBranchStates.get(snapshot.source.branchId) ?? [];
        branchStates.push({
          source: snapshot.source,
          kode: code,
          nama: name,
          selectedSales,
          comparisonSales,
          selectedSalesWeight: selectedWeight,
          comparisonSalesWeight: comparisonWeight,
          referenceSalesWeight: referenceWeight,
          referencePeriod,
          weightPerUnit,
          dailyDemand,
          dailyDemandWeight,
          targetStock, baselinePcs, baselineConfigured, weeklyDemandTargetUnits,
          targetStockWeight,
          physicalStock,
          physicalStockWeight,
          openIncoming,
          openIncomingWeight,
          projectedStock,
          projectedStockWeight,
          coverageDays,
          shortage,
          shortageWeight,
          surplus,
          surplusWeight,
          surplusBeforeTransfers: surplus,
          surplusWeightBeforeTransfers: surplusWeight,
          unfilled: shortage,
          unfilledWeight: shortageWeight,
          weightDataQuality,
        });
        perBranchStates.set(snapshot.source.branchId, branchStates);
        return {
          source: snapshot.source,
          kode: code,
          nama: name,
          selectedSales,
          comparisonSales,
          selectedSalesWeight: selectedWeight,
          comparisonSalesWeight: comparisonWeight,
          referenceSalesWeight: referenceWeight,
          referencePeriod,
          weightPerUnit,
          dailyDemand,
          dailyDemandWeight,
          targetStock, baselinePcs, baselineConfigured, weeklyDemandTargetUnits,
          targetStockWeight,
          physicalStock,
          physicalStockWeight,
          openIncoming,
          openIncomingWeight,
          projectedStock,
          projectedStockWeight,
          coverageDays,
          shortage,
          shortageWeight,
          surplus,
          surplusWeight,
          surplusBeforeTransfers: surplus,
          surplusWeightBeforeTransfers: surplusWeight,
          unfilled: shortage,
          unfilledWeight: shortageWeight,
          weightDataQuality,
        };
      });

      const offeredProductX = allocationOptions.availablePcs !== undefined && allocationOptions.productCategory === 'X';
      const offeredProductRestrictedToBasic = allocationOptions.availablePcs !== undefined
        && (allocationOptions.productCategory === 'B' || allocationOptions.productCategory === 'XB');
      const isEligibleOfferedRecipient = (state: BranchJenisState) => !offeredProductRestrictedToBasic
        || ((state.source.itemCategory ?? 'BIASA') === 'BIASA'
          && normalizeDistributionPriority(state.source.distributionPriority) !== 'profit_bagus');
      const eligibleOfferedRecipients = states.filter(isEligibleOfferedRecipient);
      if (offeredProductRestrictedToBasic) {
        offeredEligibleRecipientBranchIds = eligibleOfferedRecipients.map((state) => state.source.branchId);
        offeredEligibleRecipientShortagePcs = eligibleOfferedRecipients.reduce((sum, state) => sum + state.shortage, 0);
        offeredExcludedRecipientBranchCount = states.length - eligibleOfferedRecipients.length;
      }
      const explicitRecipientOrder = allocationOptions.productCategory === 'X' || allocationOptions.productCategory === 'XB'
        ? allocationOptions.distributionOrders?.[allocationOptions.productCategory] ?? []
        : [];
      const explicitRecipientRank = new Map(explicitRecipientOrder.map((branchId, index) => [branchId, index]));
      const recipients = eligibleOfferedRecipients
        .filter((state) => state.shortage > 0)
        .sort((left, right) =>
          (offeredProductX ? Number(left.source.itemCategory !== 'X') - Number(right.source.itemCategory !== 'X') : 0)
          || (offeredProductX && left.source.itemCategory !== 'X' ? 0 :
            (explicitRecipientRank.get(left.source.branchId) ?? Number.POSITIVE_INFINITY)
              - (explicitRecipientRank.get(right.source.branchId) ?? Number.POSITIVE_INFINITY))
          || compareDistributionPriority(left.source, right.source)
          || (left.coverageDays ?? Number.POSITIVE_INFINITY) - (right.coverageDays ?? Number.POSITIVE_INFINITY)
          || right.shortage - left.shortage
          || left.source.branchId.localeCompare(right.source.branchId),
        );
      const branchDonors = states
        .filter((state) => state.surplus > 0)
        .sort((left, right) => right.surplus - left.surplus || left.source.branchId.localeCompare(right.source.branchId));
      const donors = [
        ...(centralAvailable > 0 ? [{ source: central, kind: 'central' as const }] : []),
        ...branchDonors.map((state) => ({ source: state.source, kind: 'branch' as const })),
      ];
      const donorCapacity = donors.reduce((sum, donor) => {
        if (allocationOptions.sourceBranchId && donor.source.branchId !== allocationOptions.sourceBranchId) return sum;
        const donorState = donor.kind === 'branch'
          ? branchDonors.find((state) => state.source.branchId === donor.source.branchId)
          : undefined;
        return sum + (donor.kind === 'central' ? centralAvailable : positive(donorState?.surplus));
      }, 0);
      let recipientTargets: Map<string, number>;
      if (allocationOptions.fulfillmentMethod === 'even') {
        const allocatableUnits = Math.min(remainingBudget, donorCapacity);
        if (offeredProductX) {
          const preferredRecipients = recipients.filter((recipient) => recipient.source.itemCategory === 'X');
          const fallbackRecipients = recipients.filter((recipient) => recipient.source.itemCategory !== 'X');
          const preferredNeed = preferredRecipients.reduce((sum, recipient) => sum + recipient.unfilled, 0);
          const preferredBudget = Math.min(allocatableUnits, preferredNeed);
          const preferredTargets = allocateEvenly(preferredRecipients, preferredBudget);
          const fallbackTargets = allocateEvenly(fallbackRecipients, Math.max(0, allocatableUnits - preferredBudget));
          recipientTargets = new Map([...preferredTargets, ...fallbackTargets]);
        } else {
          recipientTargets = allocateEvenly(recipients, allocatableUnits);
        }
      } else {
        recipientTargets = new Map(recipients.map((recipient) => [recipient.source.branchId, recipient.unfilled]));
      }

      if (allocationOptions.sourceBranchId) {
        sourceAvailablePcs = allocationOptions.sourceBranchId === central.branchId
          ? centralAvailable
          : (states.find(state => state.source.branchId === allocationOptions.sourceBranchId)?.surplus ?? 0);
      }
      for (const recipient of recipients) {
        let recipientAllocation = recipientTargets.get(recipient.source.branchId) ?? 0;
        for (const donor of donors) {
          if (allocationOptions.sourceBranchId && donor.source.branchId !== allocationOptions.sourceBranchId) continue;
          if (recipientAllocation <= 0 || recipient.unfilled <= 0) break;
          const donorState = donor.kind === 'branch'
            ? branchDonors.find((state) => state.source.branchId === donor.source.branchId)
            : undefined;
          const donorAvailableUnits = donor.kind === 'central' ? centralAvailable : positive(donorState?.surplus);
          if (donorAvailableUnits <= 0 || donor.source.branchId === recipient.source.branchId) continue;
          const estimatedUnits = Math.floor(Math.min(recipientAllocation, recipient.unfilled, donorAvailableUnits, remainingBudget));
          if (estimatedUnits <= 0) continue;
          const donorWeightPerUnit = donor.kind === 'central'
            ? centralWeightPerUnit
            : (donorState && donorState.physicalStock > 0 ? donorState.physicalStockWeight / donorState.physicalStock : 0);
          const transferWeight = estimatedUnits * donorWeightPerUnit;

          remainingBudget -= estimatedUnits;
          priority += 1;
          transfers.push({
            priority,
            from: { alias: donor.source.alias, branchId: donor.source.branchId, sourceType: donor.source.sourceType },
            to: { alias: recipient.source.alias, branchId: recipient.source.branchId, distributionPriority: normalizeDistributionPriority(recipient.source.distributionPriority) },
            jenis: { kode: code, nama: name },
            quantity: roundUnits(estimatedUnits),
            estimatedUnits: roundUnits(estimatedUnits),
            estimatedWeight: roundWeight(transferWeight),
          });
          recipient.unfilledWeight = Math.max(0, roundWeight(recipient.unfilledWeight - transferWeight));
          recipient.unfilled = Math.max(0, recipient.unfilled - estimatedUnits);
          recipientAllocation = Math.max(0, recipientAllocation - estimatedUnits);
          jenisAllocated += estimatedUnits;
          jenisAllocatedWeight += transferWeight;
          if (donor.kind === 'central') {
            centralAvailableWeight = Math.max(0, roundWeight(centralAvailableWeight - transferWeight));
            centralAvailable = Math.max(0, centralAvailable - estimatedUnits);
          } else {
            if (donorState) {
              donorState.surplusWeight = Math.max(0, roundWeight(donorState.surplusWeight - transferWeight));
              donorState.surplus = Math.max(0, donorState.surplus - estimatedUnits);
            }
          }
        }
        if (recipient.unfilled > 0) {
          unfilledNeeds.push({
            branchId: recipient.source.branchId,
            alias: recipient.source.alias,
            distributionPriority: normalizeDistributionPriority(recipient.source.distributionPriority),
            jenis: { kode: code, nama: name },
            units: roundUnits(recipient.unfilled),
            estimatedUnits: roundUnits(recipient.unfilled),
            estimatedWeight: roundWeight(recipient.unfilledWeight),
            coverageDays: recipient.coverageDays === null ? null : roundUnits(recipient.coverageDays),
          });
        }
      }

      branchDonors.forEach((donorState) => {
        const original = perBranchStates.get(donorState.source.branchId)?.find((state) => state.kode === code);
        if (original) {
          original.surplus = donorState.surplus;
          original.surplusWeight = donorState.surplusWeight;
        }
      });
      recipients.forEach((recipient) => {
        const original = perBranchStates.get(recipient.source.branchId)?.find((state) => state.kode === code);
        if (original) {
          original.unfilled = recipient.unfilled;
          original.unfilledWeight = recipient.unfilledWeight;
        }
      });
      if (offeredProductRestrictedToBasic) {
        offeredUnfilledEligibleShortagePcs = recipients.reduce((sum, recipient) => sum + recipient.unfilled, 0);
      }

      const centralAvailableBeforeTransfers = Math.max(0, Math.floor(centralPhysical - centralCommitted));
      const totalUnfilled = states.reduce((sum, state) => sum + (state.shortage > 0
        ? (recipients.find((recipient) => recipient.source.branchId === state.source.branchId)?.unfilled ?? state.shortage)
        : 0), 0);
      const totalUnfilledWeight = states.reduce((sum, state) => sum + (state.shortage > 0
        ? (recipients.find((recipient) => recipient.source.branchId === state.source.branchId)?.unfilledWeight ?? state.shortageWeight)
        : 0), 0);
      const shortagePositions = states
        .filter((state) => state.shortage > 0)
        .sort((left, right) =>
          compareDistributionPriority(left.source, right.source)
          || (left.coverageDays ?? Number.POSITIVE_INFINITY) - (right.coverageDays ?? Number.POSITIVE_INFINITY)
          || right.shortage - left.shortage,
        );
      const surplusPositions = states
        .filter((state) => state.surplusBeforeTransfers > 0)
        .sort((left, right) => right.surplusBeforeTransfers - left.surplusBeforeTransfers);
      jenisSummaries.push({
        kode: code,
        nama: name,
        recentSalesUnits: roundUnits(states.reduce((sum, state) => sum + state.selectedSales, 0)),
        comparisonSalesUnits: roundUnits(states.reduce((sum, state) => sum + state.comparisonSales, 0)),
        demandReferenceUnits: roundUnits(states.reduce((sum, state) => sum + Math.max(state.selectedSales, state.comparisonSales), 0)),
        recentSalesWeight: roundWeight(states.reduce((sum, state) => sum + state.selectedSalesWeight, 0)),
        comparisonSalesWeight: roundWeight(states.reduce((sum, state) => sum + state.comparisonSalesWeight, 0)),
        demandReferenceWeight: roundWeight(states.reduce((sum, state) => sum + state.referenceSalesWeight, 0)),
        demandUnitsPerDay: roundUnits(jenisDemandPerDay),
        estimatedDemandUnitsPerDay: roundUnits(jenisDemandPerDay),
        demandWeightPerDay: roundWeight(jenisDemandWeightPerDay),
        estimatedDemandWeightPerDay: roundWeight(jenisDemandWeightPerDay),
        baselinePcs: states.reduce((sum, state) => sum + state.baselinePcs, 0),
        weeklyDemandTargetUnits: states.reduce((sum, state) => sum + state.weeklyDemandTargetUnits, 0),
        targetStockUnits: roundUnits(jenisBufferStock),
        targetStockWeight: roundWeight(jenisBufferStockWeight),
        estimatedTargetWeight: roundWeight(jenisBufferStockWeight),
        branchPhysicalStock: roundUnits(jenisPhysicalBranchStock),
        branchPhysicalStockWeight: roundWeight(jenisPhysicalBranchStockWeight),
        openIncomingToBranches: roundUnits(jenisIncoming),
        openIncomingToBranchesWeight: roundWeight(jenisIncomingWeight),
        shortageBeforeTransfers: roundUnits(jenisShortage),
        shortageWeightBeforeTransfers: roundWeight(jenisShortageWeight),
        estimatedShortageWeightBeforeTransfers: roundWeight(jenisShortageWeight),
        branchSurplusBeforeTransfers: roundUnits(jenisBranchSurplus),
        branchSurplusWeightBeforeTransfers: roundWeight(jenisBranchSurplusWeight),
        estimatedBranchSurplusWeightBeforeTransfers: roundWeight(jenisBranchSurplusWeight),
        centralPhysicalStock: roundUnits(centralPhysical),
        centralPhysicalStockWeight: roundWeight(centralPhysicalWeight),
        centralOpenOutbound: roundUnits(centralCommitted),
        centralOpenOutboundWeight: roundWeight(centralCommittedWeight),
        centralAvailableBeforeTransfers: roundUnits(centralAvailableBeforeTransfers),
        centralAvailableWeightBeforeTransfers: roundWeight(centralWeightComplete ? Math.max(0, centralPhysicalWeight - centralCommittedWeight) : 0),
        centralAvailableAfterPlan: roundUnits(centralAvailable),
        centralAvailableWeightAfterPlan: roundWeight(centralAvailableWeight),
        recommendedTransferUnits: roundUnits(jenisAllocated),
        recommendedTransferWeight: roundWeight(jenisAllocatedWeight),
        estimatedTransferWeight: roundWeight(jenisAllocatedWeight),
        unfilledShortageUnits: roundUnits(totalUnfilled),
        unfilledShortageWeight: roundWeight(totalUnfilledWeight),
        estimatedUnfilledShortageWeight: roundWeight(totalUnfilledWeight),
        branchesWithShortage,
        branchesWithSurplus,
        shortageBranches: shortagePositions.slice(0, MAX_BRANCHES_PER_JENIS_POSITION).map((state) => ({
          alias: state.source.alias,
          distributionPriority: normalizeDistributionPriority(state.source.distributionPriority),
          branchId: state.source.branchId,
          coverageDays: state.coverageDays === null ? null : roundUnits(state.coverageDays),
          recentSalesUnits: roundUnits(state.selectedSales),
          comparisonSalesUnits: roundUnits(state.comparisonSales),
          demandReferenceUnits: roundUnits(Math.max(state.selectedSales, state.comparisonSales)),
          dailyDemandUnits: roundUnits(state.dailyDemand),
          baselinePcs: state.baselinePcs, baselineConfigured: state.baselineConfigured, weeklyDemandTargetUnits: state.weeklyDemandTargetUnits,
          targetStockUnits: state.targetStock,
          physicalStockUnits: roundUnits(state.physicalStock),
          projectedStockUnits: roundUnits(state.projectedStock),
          recentSalesWeight: roundWeight(state.selectedSalesWeight),
          comparisonSalesWeight: roundWeight(state.comparisonSalesWeight),
          demandReferenceWeight: roundWeight(state.referenceSalesWeight),
          demandReferencePeriod: state.referencePeriod,
          dailyDemandWeight: roundWeight(state.dailyDemandWeight),
          targetStockWeight: roundWeight(state.targetStockWeight),
          projectedStockWeight: roundWeight(state.projectedStockWeight),
          shortageBeforeTransfersUnits: roundUnits(state.shortage),
          shortageWeightBeforeTransfers: roundWeight(state.shortageWeight),
          estimatedShortageWeightBeforeTransfers: roundWeight(state.shortageWeight),
          unfilledShortageUnits: roundUnits(state.unfilled),
          unfilledShortageWeight: roundWeight(state.unfilledWeight),
          estimatedUnfilledShortageWeight: roundWeight(state.unfilledWeight),
          openIncomingUnits: roundUnits(state.openIncoming),
          openIncomingWeight: roundWeight(state.openIncomingWeight),
          weightDataQuality: state.weightDataQuality,
        })),
        omittedShortageBranchCount: Math.max(0, shortagePositions.length - MAX_BRANCHES_PER_JENIS_POSITION),
        surplusBranches: surplusPositions.slice(0, includeAllSurplusBranches ? MAX_SOURCE_COUNT : MAX_BRANCHES_PER_JENIS_POSITION).map((state) => ({
          alias: state.source.alias,
          distributionPriority: normalizeDistributionPriority(state.source.distributionPriority),
          branchId: state.source.branchId,
          coverageDays: state.coverageDays === null ? null : roundUnits(state.coverageDays),
          recentSalesUnits: roundUnits(state.selectedSales),
          comparisonSalesUnits: roundUnits(state.comparisonSales),
          demandReferenceUnits: roundUnits(Math.max(state.selectedSales, state.comparisonSales)),
          dailyDemandUnits: roundUnits(state.dailyDemand),
          baselinePcs: state.baselinePcs, baselineConfigured: state.baselineConfigured, weeklyDemandTargetUnits: state.weeklyDemandTargetUnits,
          targetStockUnits: state.targetStock,
          physicalStockUnits: roundUnits(state.physicalStock),
          projectedStockUnits: roundUnits(state.projectedStock),
          recentSalesWeight: roundWeight(state.selectedSalesWeight),
          comparisonSalesWeight: roundWeight(state.comparisonSalesWeight),
          demandReferenceWeight: roundWeight(state.referenceSalesWeight),
          demandReferencePeriod: state.referencePeriod,
          dailyDemandWeight: roundWeight(state.dailyDemandWeight),
          targetStockWeight: roundWeight(state.targetStockWeight),
          physicalStockWeight: roundWeight(state.physicalStockWeight),
          surplusBeforeTransfersUnits: roundUnits(state.surplusBeforeTransfers),
          surplusWeightBeforeTransfers: roundWeight(state.surplusWeightBeforeTransfers),
          estimatedSurplusWeightBeforeTransfers: roundWeight(state.surplusWeightBeforeTransfers),
          surplusAfterPlanUnits: roundUnits(state.surplus),
          surplusWeightAfterPlan: roundWeight(state.surplusWeight),
          estimatedSurplusWeightAfterPlan: roundWeight(state.surplusWeight),
          weightDataQuality: state.weightDataQuality,
        })),
        omittedSurplusBranchCount: Math.max(0, surplusPositions.length - (includeAllSurplusBranches ? MAX_SOURCE_COUNT : MAX_BRANCHES_PER_JENIS_POSITION)),
        ...(includeTargetTransfersForBranchId ? {
          targetTransfers: transfers.slice(transferStartIndex)
            .filter((transfer) => transfer.to.branchId === includeTargetTransfersForBranchId)
            .map(({ from, to, quantity, estimatedUnits, estimatedWeight }) => ({ from, to, quantity, estimatedUnits, estimatedWeight })),
        } : {}),
      });
    }

    const branchSummaries = branchSnapshots.map((snapshot) => {
      const states = perBranchStates.get(snapshot.source.branchId) ?? [];
      return {
        branchId: snapshot.source.branchId,
        alias: snapshot.source.alias,
        itemCategory: snapshot.source.itemCategory ?? 'BIASA',
        distributionPriority: normalizeDistributionPriority(snapshot.source.distributionPriority),
        dailyDemandUnits: roundUnits(states.reduce((sum, state) => sum + state.dailyDemand, 0)),
        dailyDemandWeight: roundWeight(states.reduce((sum, state) => sum + state.dailyDemandWeight, 0)),
        estimatedDailyDemandWeight: roundWeight(states.reduce((sum, state) => sum + state.dailyDemandWeight, 0)),
        baselinePcs: states.reduce((sum, state) => sum + state.baselinePcs, 0),
        weeklyDemandTargetUnits: states.reduce((sum, state) => sum + state.weeklyDemandTargetUnits, 0),
        targetStockUnits: roundUnits(states.reduce((sum, state) => sum + state.targetStock, 0)),
        targetStockWeight: roundWeight(states.reduce((sum, state) => sum + state.targetStockWeight, 0)),
        estimatedTargetWeight: roundWeight(states.reduce((sum, state) => sum + state.targetStockWeight, 0)),
        physicalStockUnits: roundUnits(states.reduce((sum, state) => sum + state.physicalStock, 0)),
        physicalStockWeight: roundWeight(states.reduce((sum, state) => sum + state.physicalStockWeight, 0)),
        openIncomingUnits: roundUnits(states.reduce((sum, state) => sum + state.openIncoming, 0)),
        openIncomingWeight: roundWeight(states.reduce((sum, state) => sum + state.openIncomingWeight, 0)),
        projectedStockUnits: roundUnits(states.reduce((sum, state) => sum + state.projectedStock, 0)),
        projectedStockWeight: roundWeight(states.reduce((sum, state) => sum + state.projectedStockWeight, 0)),
        surplusBeforeTransfersUnits: roundUnits(states.reduce((sum, state) => sum + state.surplusBeforeTransfers, 0)),
        surplusWeightBeforeTransfers: roundWeight(states.reduce((sum, state) => sum + state.surplusWeightBeforeTransfers, 0)),
        estimatedSurplusWeightBeforeTransfers: roundWeight(states.reduce((sum, state) => sum + state.surplusWeightBeforeTransfers, 0)),
        surplusAfterPlanUnits: roundUnits(states.reduce((sum, state) => sum + state.surplus, 0)),
        surplusWeightAfterPlan: roundWeight(states.reduce((sum, state) => sum + state.surplusWeight, 0)),
        estimatedSurplusWeightAfterPlan: roundWeight(states.reduce((sum, state) => sum + state.surplusWeight, 0)),
        shortageBeforeTransfersUnits: roundUnits(states.reduce((sum, state) => sum + state.shortage, 0)),
        shortageWeightBeforeTransfers: roundWeight(states.reduce((sum, state) => sum + state.shortageWeight, 0)),
        estimatedShortageWeightBeforeTransfers: roundWeight(states.reduce((sum, state) => sum + state.shortageWeight, 0)),
        unfilledShortageUnits: roundUnits(states.reduce((sum, state) => sum + state.unfilled, 0)),
        unfilledShortageWeight: roundWeight(states.reduce((sum, state) => sum + state.unfilledWeight, 0)),
        estimatedUnfilledShortageWeight: roundWeight(states.reduce((sum, state) => sum + state.unfilledWeight, 0)),
        weightDataQuality: {
          salesRowsWithoutWeight: states.reduce((sum, state) => sum + state.weightDataQuality.salesRowsWithoutWeight, 0),
          stockRowsWithoutWeight: states.reduce((sum, state) => sum + state.weightDataQuality.stockRowsWithoutWeight, 0),
          openShipmentRowsWithoutWeight: states.reduce((sum, state) => sum + state.weightDataQuality.openShipmentRowsWithoutWeight, 0),
        },
        jenisWithSurplus: states.filter((state) => state.surplusBeforeTransfers > 0).length,
        jenisWithSurplusAfterPlan: states.filter((state) => state.surplus > 0).length,
        jenisWithShortage: states.filter((state) => state.shortage > 0).length,
      };
    }).sort((left, right) => left.branchId.localeCompare(right.branchId));

    const totalBranchSurplusBeforeTransfers = branchSummaries.reduce((sum, branch) => sum + branch.surplusBeforeTransfersUnits, 0);
    const totalBranchSurplusAfterPlan = branchSummaries.reduce((sum, branch) => sum + branch.surplusAfterPlanUnits, 0);
    const totalShortage = branchSummaries.reduce((sum, branch) => sum + branch.shortageBeforeTransfersUnits, 0);
    const totalShortageWeight = branchSummaries.reduce((sum, branch) => sum + branch.estimatedShortageWeightBeforeTransfers, 0);
    const totalUnfilled = branchSummaries.reduce((sum, branch) => sum + branch.unfilledShortageUnits, 0);
    const totalUnfilledWeight = branchSummaries.reduce((sum, branch) => sum + branch.estimatedUnfilledShortageWeight, 0);
    const totalTransfers = transfers.reduce((sum, transfer) => sum + transfer.quantity, 0);
    const totalTransferWeight = transfers.reduce((sum, transfer) => sum + transfer.estimatedWeight, 0);
    const centralPhysicalTotal = [...codes].reduce((sum, code) => sum + positive(centralSnapshot.stock.get(code)?.units), 0);
    const centralPhysicalWeightTotal = [...codes].reduce((sum, code) => sum + positive(centralSnapshot.stock.get(code)?.weight), 0);
    const centralCommittedTotal = [...codes].reduce((sum, code) => sum + positive(openShipments.byJenis.get(code)?.units), 0);
    const centralCommittedWeightTotal = [...codes].reduce((sum, code) => sum + positive(openShipments.byJenis.get(code)?.weight), 0);
    const centralAvailableTotal = [...codes].reduce((sum, code) =>
      sum + Math.max(0, Math.floor(positive(centralSnapshot.stock.get(code)?.units) - positive(openShipments.byJenis.get(code)?.units))), 0);
    const centralAvailableWeightTotal = [...codes].reduce((sum, code) =>
      sum + (positive(centralSnapshot.stock.get(code)?.rowsWithoutWeight) === 0
        && positive(openShipments.byJenis.get(code)?.rowsWithoutWeight) === 0
        ? Math.max(0, positive(centralSnapshot.stock.get(code)?.weight) - positive(openShipments.byJenis.get(code)?.weight))
        : 0), 0,
    );
    const outputJenis = jenisSummaries
      .sort((left, right) => numericField(right, 'shortageBeforeTransfers') - numericField(left, 'shortageBeforeTransfers')
        || numericField(right, 'recommendedTransferUnits') - numericField(left, 'recommendedTransferUnits')
        || String(left.kode).localeCompare(String(right.kode)));
    const sortedUnfilled = unfilledNeeds.sort((left, right) =>
      compareDistributionPriority(left, right)
      || (left.coverageDays ?? Number.POSITIVE_INFINITY) - (right.coverageDays ?? Number.POSITIVE_INFINITY)
      || right.units - left.units,
    );

    return {
      mode: 'network-restock-plan',
      baselineRevision: baselineSnapshot.revision,
      quantityUnit: 'pcs',
      fulfillmentMethod: allocationOptions.fulfillmentMethod,
      fulfillmentMethodLabel: allocationOptions.fulfillmentMethod === 'even' ? 'Dibagi merata' : 'Penuhi per cabang',
      filters: { jenisCode: allocationOptions.jenisCode ?? null },
      ...(allocationOptions.sourceBranchId && allocationOptions.availablePcs !== undefined ? {
        allocation: {
          jenisCode: [...codes][0], sourceBranchId: allocationOptions.sourceBranchId,
          productCategory: allocationOptions.productCategory,
          ...(allocationOptions.productCategory === 'X' ? { recipientGroupOrder: ['X', 'BIASA'] } : {}),
          fulfillmentMethod: allocationOptions.fulfillmentMethod,
          fulfillmentMethodLabel: allocationOptions.fulfillmentMethod === 'even' ? 'Dibagi merata' : 'Penuhi per cabang',
          recipientOrder: allocationOptions.productCategory === 'X' || allocationOptions.productCategory === 'XB'
            ? allocationOptions.distributionOrders?.[allocationOptions.productCategory] ?? []
            : [],
          sourceAlias: [central, ...branches].find(source => source.branchId === allocationOptions.sourceBranchId)?.alias,
          offeredPcs: allocationOptions.availablePcs,
          sourceAvailablePcs,
          usablePcs: Math.min(allocationOptions.availablePcs, sourceAvailablePcs),
          allocatedPcs: totalTransfers,
          remainingOfferedPcs: allocationOptions.availablePcs - totalTransfers,
          ...(allocationOptions.productCategory === 'B' || allocationOptions.productCategory === 'XB' ? {
            recipientScope: 'BIASA tanpa flag Exclusive',
            eligibleRecipientBranchIds: offeredEligibleRecipientBranchIds,
            eligibleRecipientBranchCount: offeredEligibleRecipientBranchIds.length,
            excludedRecipientBranchCount: offeredExcludedRecipientBranchCount,
            eligibleRecipientShortagePcs: roundUnits(offeredEligibleRecipientShortagePcs),
            unfilledEligibleShortagePcs: roundUnits(offeredUnfilledEligibleShortagePcs),
          } : {}),
        },
      } : {}),
      period: {
        windowDays: 7, comparisonMode: 'previous-month-same-dates',
        forecast: { from: period.forecastFrom, through: period.forecastThrough },
        month: period.month,
        selectedSales: { from: period.selectedFrom, through: period.selectedThrough },
        projectionAsOf: period.projectionAsOf,
        comparisonMonth: period.comparisonMonth,
        comparisonSales: {
          from: period.comparisonFrom,
          through: period.comparisonThrough,
          completeMonth: false,
        },
        elapsedDaysForDemand: period.elapsedDays,
        comparisonElapsedDaysForDemand: period.comparisonElapsedDays,
        forecastDays: 7,
        safeStockDays,
        restockTargetDays,
        // Compatibility alias for the fixed weekly horizon.
        bufferDays: safeStockDays,
      },
      policy: {
        demand: 'Pcs acuan = max(qty terjual 7 hari terakhir, qty tanggal sama bulan sebelumnya); kebutuhan harian = pcs acuan / hari aktual acuan.',
        branchTarget: 'Target pcs = patokan stok dasar + ceil(kebutuhan harian × 7). Kekurangan = max(0, target - stok fisik - OPEN). Surplus donor = max(0, floor(stok fisik - target)).',
        stock: 'tm_barang stock_on_hand>0, status_hancur=false. Jumlah pcs dijumlahkan dari stock_on_hand.',
        pendingShipment: 'OPEN dari db_pntspst2.tt_kirim_barang; satu dokumen satu pcs. Menambah stok proyeksi penerima dan mengurangi stok bebas Pusat. Jangan tambahkan CLOS.',
        donorOrder: 'Pusat dahulu, kemudian donor cabang dengan surplus pcs terbesar. Cadangan penjualan cabang tetap disisakan.',
        fulfillment: allocationOptions.fulfillmentMethod === 'even'
          ? 'Kebutuhan penerima yang kekurangan dibagi seimbang. Urutan prioritas hanya memutuskan sisa pcs pembagian yang tidak dapat dibagi rata.'
          : 'Penuhi kebutuhan per cabang secara berurutan. Cabang berikutnya menerima alokasi setelah kebutuhan cabang sebelumnya dipenuhi semampu stok donor.',
        recipientOrder: allocationOptions.productCategory === 'X'
          ? 'Untuk stok yang ditawarkan berkategori produk X: kelompok cabang X menerima lebih dahulu sesuai Urutan Distribusi X. Setelah seluruh kebutuhan kelompok X terpenuhi, sisa penawaran dialokasikan ke kelompok BIASA. Penerima dalam kelompok mengikuti metode pemenuhan dan prioritas cabang.'
          : allocationOptions.productCategory === 'XB' || allocationOptions.productCategory === 'B'
            ? 'Untuk stok yang ditawarkan berkategori produk XB atau B, penerima dibatasi hanya ke kelompok cabang BIASA yang tidak berflag Exclusive (profit_bagus). Cabang kelompok X dan cabang BIASA berflag Exclusive tidak boleh menerima; sisa pcs tetap menjadi sisa penawaran. Produk XB mengikuti Urutan Distribusi XB hanya di antara penerima yang memenuhi syarat; selanjutnya Opening, Boost, lalu tanpa flag. Produk B memakai urutan prioritas Opening, Boost, lalu tanpa flag.'
          : 'Hanya cabang kekurangan yang menerima. Urutan: Exclusive (profit_bagus) → opening → boost → tanpa flag; dalam flag sama, cakupan stok pcs terendah lalu kekurangan pcs terbesar dan branchId.',
        execution: 'Rekomendasi pcs bulat, bukan transaksi. Berat tidak dipakai sebagai pengganti jumlah barang.',
      },
      sources: {
        central: { alias: central.alias, branchId: central.branchId, sourceType: central.sourceType },
        branches: branchSnapshots.map(({ source }) => ({ alias: source.alias, branchId: source.branchId, sourceType: source.sourceType, itemCategory: source.itemCategory ?? 'BIASA', distributionPriority: normalizeDistributionPriority(source.distributionPriority) })),
      },
      totals: {
        branchesAnalyzed: branchSnapshots.length,
        jenisAnalyzed: codes.size,
        totalBranchDailyDemandUnits: roundUnits(branchSummaries.reduce((sum, branch) => sum + branch.dailyDemandUnits, 0)),
        totalBranchDailyDemandWeight: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.dailyDemandWeight, 0)),
        estimatedBranchDailyDemandWeight: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.estimatedDailyDemandWeight, 0)),
        totalBranchTargetStockUnits: roundUnits(branchSummaries.reduce((sum, branch) => sum + branch.targetStockUnits, 0)),
        totalBranchTargetStockWeight: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.targetStockWeight, 0)),
        estimatedBranchTargetWeight: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.estimatedTargetWeight, 0)),
        totalBranchPhysicalStockUnits: roundUnits(branchSummaries.reduce((sum, branch) => sum + branch.physicalStockUnits, 0)),
        totalBranchPhysicalStockWeight: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.physicalStockWeight, 0)),
        totalOpenIncomingToBranches: roundUnits(branchSummaries.reduce((sum, branch) => sum + branch.openIncomingUnits, 0)),
        totalOpenIncomingWeightToBranches: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.openIncomingWeight, 0)),
        centralPhysicalStockUnits: roundUnits(centralPhysicalTotal),
        centralPhysicalStockWeight: roundWeight(centralPhysicalWeightTotal),
        centralOpenOutboundUnits: roundUnits(centralCommittedTotal),
        centralOpenOutboundWeight: roundWeight(centralCommittedWeightTotal),
        centralAvailableStockUnits: roundUnits(centralAvailableTotal),
        centralAvailableStockWeight: roundWeight(centralAvailableWeightTotal),
        branchSurplusBeforeTransfersUnits: roundUnits(totalBranchSurplusBeforeTransfers),
        branchSurplusBeforeTransfersWeight: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.surplusWeightBeforeTransfers, 0)),
        estimatedBranchSurplusWeightBeforeTransfers: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.estimatedSurplusWeightBeforeTransfers, 0)),
        branchSurplusAfterPlanUnits: roundUnits(totalBranchSurplusAfterPlan),
        branchSurplusAfterPlanWeight: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.surplusWeightAfterPlan, 0)),
        estimatedBranchSurplusWeightAfterPlan: roundWeight(branchSummaries.reduce((sum, branch) => sum + branch.estimatedSurplusWeightAfterPlan, 0)),
        shortageBeforeTransfersUnits: roundUnits(totalShortage),
        shortageBeforeTransfersWeight: roundWeight(totalShortageWeight),
        estimatedShortageWeightBeforeTransfers: roundWeight(totalShortageWeight),
        recommendedTransferUnits: roundUnits(totalTransfers),
        recommendedTransferWeight: roundWeight(totalTransferWeight),
        estimatedTransferWeight: roundWeight(totalTransferWeight),
        unfilledShortageUnits: roundUnits(totalUnfilled),
        unfilledShortageWeight: roundWeight(totalUnfilledWeight),
        estimatedUnfilledShortageWeight: roundWeight(totalUnfilledWeight),
        branchesWithSurplus: branchSummaries.filter((branch) => branch.surplusBeforeTransfersUnits > 0).length,
        branchesWithShortage: branchSummaries.filter((branch) => branch.shortageBeforeTransfersUnits > 0).length,
        transferRouteCount: transfers.length,
        openShipmentRows: openShipments.openRows,
        openShipmentUnitsToUnconfiguredDestinations: openShipments.unitsToUnconfiguredDestinations,
        weightDataQuality: {
          salesRowsWithoutWeight: branchSummaries.reduce((sum, branch) => sum + branch.weightDataQuality.salesRowsWithoutWeight, 0),
          branchStockRowsWithoutWeight: branchSummaries.reduce((sum, branch) => sum + branch.weightDataQuality.stockRowsWithoutWeight, 0),
          openIncomingRowsWithoutWeight: branchSummaries.reduce((sum, branch) => sum + branch.weightDataQuality.openShipmentRowsWithoutWeight, 0),
          centralStockRowsWithoutWeight: [...centralSnapshot.stock.values()].reduce((sum, stock) => sum + positive(stock.rowsWithoutWeight), 0),
          openOutboundRowsWithoutWeight: [...openShipments.byJenis.values()].reduce((sum, shipment) => sum + positive(shipment.rowsWithoutWeight), 0),
        },
      },
      branches: branchSummaries,
      jenis: outputJenis.slice(0, MAX_JENIS_ROWS),
      omittedJenisCount: Math.max(0, outputJenis.length - MAX_JENIS_ROWS),
      transfers: transfers.slice(0, MAX_TRANSFER_ROWS),
      omittedTransferCount: Math.max(0, transfers.length - MAX_TRANSFER_ROWS),
      unfilledNeeds: sortedUnfilled.slice(0, MAX_UNFILLED_ROWS),
      omittedUnfilledNeedCount: Math.max(0, sortedUnfilled.length - MAX_UNFILLED_ROWS),
      complete: true,
    };
  }

  private async readSource(source: NetworkRestockDataSource, period: AnalysisPeriod): Promise<SourceSnapshot> {
    const snapshot: SourceSnapshot = {
      source,
      sales: new Map(),
      stock: new Map(),
      jenisNames: new Map(),
    };

    try {
      const db = this.mongo.getDatabase(source.databaseName);
      const required = source.sourceType === 'branch' ? REQUIRED_BRANCH_COLLECTIONS : REQUIRED_CENTRAL_COLLECTIONS;
      const present = await db.listCollections({ name: { $in: required } }, { nameOnly: true }).toArray();
      const presentNames = new Set(present.map(({ name }) => name));
      const missing = required.filter((name) => !presentNames.has(name));
      if (missing.length) {
        snapshot.unavailableReason = 'koleksi tidak ada: ' + missing.join(', ');
        return snapshot;
      }

      const salesQuery = source.sourceType === 'branch'
        ? db.collection('tt_jual_detail').aggregate<SalesAggregateRow>(salesPipeline(period), {
          allowDiskUse: true,
          maxTimeMS: QUERY_MAX_TIME_MS,
        }).toArray()
        : Promise.resolve([] as SalesAggregateRow[]);
      const [sales, stock, jenis] = await Promise.all([
        salesQuery,
        db.collection('tm_barang').aggregate<StockAggregateRow>(stockPipeline(), {
          allowDiskUse: true,
          maxTimeMS: QUERY_MAX_TIME_MS,
        }).toArray(),
        db.collection<DepartmentDocument>('tm_dept')
          .find({ status_aktif: true }, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
          .maxTimeMS(10_000)
          .toArray(),
      ]);

      sales.forEach((row) => {
        const code = cleanString(row._id?.jenis);
        if (!code) return;
        const current = snapshot.sales.get(code) ?? {
          recent: 0, comparison: 0, recentWeight: 0, comparisonWeight: 0,
          recentRows: 0, comparisonRows: 0, recentRowsWithoutWeight: 0, comparisonRowsWithoutWeight: 0,
        };
        if (row._id?.period === 'last-seven-days') {
          current.recent += positive(row.soldUnits);
          current.recentWeight += positive(row.soldWeight);
          current.recentRows += positive(row.soldRows);
          current.recentRowsWithoutWeight += positive(row.rowsWithoutWeight);
        }
        if (row._id?.period === 'previous-month') {
          current.comparison += positive(row.soldUnits);
          current.comparisonWeight += positive(row.soldWeight);
          current.comparisonRows += positive(row.soldRows);
          current.comparisonRowsWithoutWeight += positive(row.rowsWithoutWeight);
        }
        snapshot.sales.set(code, current);
      });
      stock.forEach((row) => {
        const code = cleanString(row._id);
        if (code) snapshot.stock.set(code, {
          units: positive(row.stockUnits),
          weight: positive(row.stockWeight),
          rowsWithoutWeight: positive(row.rowsWithoutWeight),
        });
      });
      jenis.forEach((row) => {
        const code = cleanString(row.kode_dept);
        const name = decryptDepartmentName(row.nama_dept);
        if (code && name) snapshot.jenisNames.set(code, name);
      });
    } catch {
      snapshot.unavailableReason = 'pembacaan data gagal atau melewati batas waktu';
    }
    return snapshot;
  }

  private async readOpenShipments(branchIds: Set<string>): Promise<OpenShipmentSnapshot> {
    const db = this.mongo.getDatabase(env.shipmentSourceDatabaseName);
    const exists = await db.listCollections({ name: 'tt_kirim_barang' }, { nameOnly: true }).hasNext();
    if (!exists) {
      throw new NetworkRestockRecommendationError(
        `Koleksi tt_kirim_barang tidak ditemukan pada sumber pengiriman Pusat (${env.shipmentSourceDatabaseName}).`,
      );
    }

    const rows = await db.collection('tt_kirim_barang').aggregate<OpenShipmentAggregateRow>([
      {
        $match: {
          status_terima: 'OPEN',
          kode_dept: { $type: 'string', $ne: '' },
        },
      },
      {
        $group: {
          _id: { branchId: '$tujuan', jenis: '$kode_dept' },
          units: { $sum: 1 },
          weight: { $sum: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } } },
          rowsWithoutWeight: { $sum: { $cond: [{ $gt: [{ $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } }, 0] }, 0, 1] } },
        },
      },
    ], { allowDiskUse: true, maxTimeMS: QUERY_MAX_TIME_MS }).toArray();

    const byBranchAndJenis = new Map<string, Map<string, { units: number; weight: number; rowsWithoutWeight: number }>>();
    const byJenis = new Map<string, { units: number; weight: number; rowsWithoutWeight: number }>();
    let openRows = 0;
    let unitsToUnconfiguredDestinations = 0;
    rows.forEach((row) => {
      const code = cleanString(row._id?.jenis);
      if (!code) return;
      const units = positive(row.units);
      const weight = positive(row.weight);
      const rowsWithoutWeight = positive(row.rowsWithoutWeight);
      openRows += units;
      const totalByJenis = byJenis.get(code) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
      totalByJenis.units += units;
      totalByJenis.weight += weight;
      totalByJenis.rowsWithoutWeight += rowsWithoutWeight;
      byJenis.set(code, totalByJenis);
      const branchId = cleanString(row._id?.branchId);
      if (!branchId || !branchIds.has(branchId)) unitsToUnconfiguredDestinations += units;
      if (!branchId) return;
      const byJenisForBranch = byBranchAndJenis.get(branchId) ?? new Map<string, { units: number; weight: number; rowsWithoutWeight: number }>();
      const branchTotal = byJenisForBranch.get(code) ?? { units: 0, weight: 0, rowsWithoutWeight: 0 };
      branchTotal.units += units;
      branchTotal.weight += weight;
      branchTotal.rowsWithoutWeight += rowsWithoutWeight;
      byJenisForBranch.set(code, branchTotal);
      byBranchAndJenis.set(branchId, byJenisForBranch);
    });
    return { byBranchAndJenis, byJenis, openRows, unitsToUnconfiguredDestinations };
  }
}

function salesPipeline(period: AnalysisPeriod): Document[] {
  return [
    {
      $match: {
        ...validSalesMatch(),
        kode_dept: { $type: 'string', $ne: '' },
        $or: [
          { tgl_system: { $gte: period.selectedFrom, $lte: period.selectedThrough } },
          { tgl_system: { $gte: period.comparisonFrom, $lte: period.comparisonThrough } },
        ],
      },
    },
    {
      $project: {
        jenis: '$kode_dept',
        period: { $cond: [{ $gte: ['$tgl_system', period.selectedFrom] }, 'last-seven-days', 'previous-month'] },
        soldUnits: { $convert: { input: '$qty', to: 'double', onError: 0, onNull: 0 } },
        soldWeight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
      },
    },
    { $match: { $or: [{ soldUnits: { $gt: 0 } }, { soldWeight: { $gt: 0 } }] } },
    { $group: {
      _id: { jenis: '$jenis', period: '$period' },
      soldUnits: { $sum: '$soldUnits' },
      soldWeight: { $sum: '$soldWeight' },
      soldRows: { $sum: 1 },
      rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$soldWeight', 0] }, 0, 1] } },
    } },
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
        jenis: '$kode_dept',
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
        _id: '$jenis',
        stockUnits: { $sum: '$stockUnits' },
        stockWeight: { $sum: '$stockWeight' },
        rowsWithoutWeight: { $sum: '$rowWithoutWeight' },
      },
    },
  ];
}

function analysisPeriod(requestedMonth?: string): AnalysisPeriod {
  try { const period = weeklyRestockPeriod(requestedMonth); return { ...period,  }; }
  catch (error) { throw new NetworkRestockRecommendationError(error instanceof Error ? error.message : 'Periode tidak valid.'); }
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned : undefined;
}

function positive(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function allocateEvenly(
  recipients: Array<{ source: { branchId: string }; unfilled: number }>,
  availableUnits: number,
): Map<string, number> {
  const allocations = new Map(recipients.map((recipient) => [recipient.source.branchId, 0]));
  let remaining = Math.min(
    Number.isFinite(availableUnits) ? Math.max(0, Math.floor(availableUnits)) : 0,
    recipients.reduce((sum, recipient) => sum + Math.max(0, recipient.unfilled), 0),
  );

  while (remaining > 0) {
    const active = recipients.filter((recipient) => (allocations.get(recipient.source.branchId) ?? 0) < recipient.unfilled);
    if (!active.length) break;

    const evenShare = Math.floor(remaining / active.length);
    if (evenShare === 0) {
      for (const recipient of active) {
        if (remaining === 0) break;
        const branchId = recipient.source.branchId;
        allocations.set(branchId, (allocations.get(branchId) ?? 0) + 1);
        remaining -= 1;
      }
      break;
    }

    let distributed = 0;
    for (const recipient of active) {
      const branchId = recipient.source.branchId;
      const alreadyAllocated = allocations.get(branchId) ?? 0;
      const amount = Math.min(evenShare, Math.max(0, recipient.unfilled - alreadyAllocated));
      allocations.set(branchId, alreadyAllocated + amount);
      distributed += amount;
    }
    if (distributed === 0) break;
    remaining -= distributed;
  }

  return allocations;
}

function roundUnits(value: number): number {
  return Number(value.toFixed(3));
}

function roundWeight(value: number): number {
  return Number(value.toFixed(3));
}

function sumMapField(values: Map<string, { units: number; weight: number }>, field: 'units' | 'weight'): number {
  return [...values.values()].reduce((sum, value) => sum + positive(value[field]), 0);
}

function numericField(value: Record<string, unknown>, field: string): number {
  return positive(value[field]);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = index;
      index += 1;
      results[current] = await task(values[current]);
    }
  }));
  return results;
}
