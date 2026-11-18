import { Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import type { CacheFetchStatus } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { validSalesMatch } from '../sales/sales-query-policy';

export type StockoutRiskHorizon = 'next-week' | 'next-month';

export interface StockoutRiskDataSource {
  databaseName: string;
  alias: string;
  branchId: string;
  sourceType: 'branch' | 'central';
}

export class StockoutRiskError extends Error {}

type RiskTiming = 'already-out' | 'before-window' | 'in-window' | 'after-window' | 'no-demand' | 'incomplete';

export interface RiskPeriod {
  asOfDate: string;
  selectedMonth: string;
  selectedSalesFrom: string;
  selectedSalesThrough: string;
  selectedSalesDays: number;
  comparisonMonth: string;
  comparisonSalesFrom: string;
  comparisonSalesThrough: string;
  comparisonSalesDays: number;
  forecastStart: string;
  windowStart: string;
  windowEnd: string;
  daysBeforeWindow: number;
  windowDays: number;
  forecastDays: number;
  horizon: StockoutRiskHorizon;
  horizonLabel: string;
}

interface SalesAggregateRow extends Document {
  _id: { jenis?: unknown; period?: 'selected-month' | 'comparison-month' };
  weight: number;
  rowsWithoutWeight: number;
}

interface WeightAggregateRow extends Document {
  _id: string;
  weight: number;
  rowsWithoutWeight: number;
}

interface OpenIncomingAggregateRow extends Document {
  _id: { branchId?: unknown; jenis?: unknown };
  weight: number;
  rowsWithoutWeight: number;
}

interface BranchSnapshot {
  source: StockoutRiskDataSource;
  stock: Map<string, WeightValue>;
  sales: Map<string, {
    selectedMonthWeight: number;
    comparisonMonthWeight: number;
    selectedMonthRowsWithoutWeight: number;
    comparisonMonthRowsWithoutWeight: number;
  }>;
  jenisNames: Map<string, string>;
  unavailableReason?: string;
}

interface WeightValue {
  weight: number;
  rowsWithoutWeight: number;
}

interface OpenIncomingSnapshot {
  byBranchAndJenis: Map<string, Map<string, WeightValue>>;
  unavailableReason?: string;
}

export interface StockoutJenisResult {
  kode: string;
  nama: string;
  selectedMonthSalesWeight: number;
  comparisonMonthSalesWeight: number;
  referenceSalesWeight: number;
  referencePeriod: 'selected-month' | 'comparison-month' | 'tie';
  referenceDays: number;
  dailyDemandWeight: number;
  physicalStockWeight: number;
  openIncomingWeight: number;
  availableWeight: number;
  stockAtWindowStartWeight: number;
  demandDuringWindowWeight: number;
  projectedRemainingWeight: number;
  projectedDeficitWeight: number;
  coverageDays: number | null;
  daysUntilStockout: number | null;
  expectedStockoutDate: string | null;
  riskTiming: RiskTiming;
  weightDataQuality: {
    selectedSalesRowsWithoutWeight: number;
    comparisonSalesRowsWithoutWeight: number;
    stockRowsWithoutWeight: number;
    openIncomingRowsWithoutWeight: number;
    openIncomingSourceUnavailable: boolean;
  };
}

export interface StockoutBranchResult {
  branchId: string;
  alias: string;
  status: 'at-risk' | 'sufficient' | 'no-demand' | 'incomplete' | 'unavailable';
  atRiskJenisCount: number;
  atRiskBeforeWindowCount: number;
  atRiskInWindowCount: number;
  incompleteJenisCount: number;
  worstCoverageDays: number | null;
  atRiskJenis: StockoutJenisResult[];
  omittedAtRiskJenisCount: number;
  incompleteJenis: Array<Pick<StockoutJenisResult, 'kode' | 'nama' | 'weightDataQuality'>>;
  unavailableReason?: string;
}

export interface StockoutRiskAnalysisResult {
  mode: 'stockout-risk';
  period: RiskPeriod;
  policy: Record<string, string>;
  summary: {
    branchSources: number;
    branchesAnalyzed: number;
    branchesAtRisk: number;
    branchesAtRiskBeforeWindow: number;
    branchesAtRiskInWindow: number;
    branchesWithIncompleteData: number;
    branchesUnavailable: number;
    incompleteOpenIncomingSource: boolean;
  };
  branches: StockoutBranchResult[];
  unavailableSources: Array<{ alias: string; branchId: string; reason: string }>;
  openIncomingUnavailableReason: string | null;
  note: string;
  cacheStatus: CacheFetchStatus;
}

const MAX_SOURCE_COUNT = 100;
const MAX_CONCURRENT_SOURCES = 4;
const QUERY_MAX_TIME_MS = 45_000;
const MAX_RISK_JENIS_PER_BRANCH = 20;

@Injectable()
export class StockoutRiskService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  async analyze(
    sources: StockoutRiskDataSource[],
    horizon: StockoutRiskHorizon,
  ): Promise<StockoutRiskAnalysisResult> {
    const branches = sources.filter((source) => source.sourceType === 'branch');
    if (branches.length === 0) throw new StockoutRiskError('Belum ada sumber cabang aktif untuk dianalisis.');
    if (branches.length > MAX_SOURCE_COUNT) {
      throw new StockoutRiskError(`Analisis dibatasi maksimal ${MAX_SOURCE_COUNT} sumber cabang aktif.`);
    }

    const period = buildRiskPeriod(horizon);
    const sourceKey = branches
      .map(({ databaseName, alias, branchId }) => ({ databaseName, alias, branchId }))
      .sort((left, right) => left.branchId.localeCompare(right.branchId));
    const key = `agent:stockout-risk:v1:${JSON.stringify({ period, sources: sourceKey })}`;
    const { value, cacheStatus } = await this.cache.getOrLoadWithStatus(key, () =>
      this.buildRiskAnalysis(branches, period),
    );
    return { ...value, cacheStatus };
  }

  private async buildRiskAnalysis(sources: StockoutRiskDataSource[], period: RiskPeriod) {
    const branchIds = sources.map((source) => source.branchId);
    const [snapshots, openIncoming] = await Promise.all([
      mapWithConcurrency(sources, MAX_CONCURRENT_SOURCES, (source) => this.readBranch(source, period)),
      this.readOpenIncoming(branchIds),
    ]);

    const branches = snapshots.map((snapshot) => this.analyzeBranch(snapshot, period, openIncoming));
    const atRiskBranches = branches.filter((branch) => branch.atRiskJenisCount > 0);
    const branchesAtRiskBeforeWindow = branches.filter((branch) => branch.atRiskBeforeWindowCount > 0);
    const branchesAtRiskInWindow = branches.filter((branch) => branch.atRiskInWindowCount > 0);
    const incompleteBranches = branches.filter((branch) => branch.incompleteJenisCount > 0 || branch.status === 'unavailable');
    const unavailableBranches = branches.filter((branch) => branch.status === 'unavailable');

    return {
      mode: 'stockout-risk' as const,
      period,
      policy: {
        sales: 'tt_jual_detail dengan status_kembali=OPEN dan status_valid=DONE; status_tukar=true dan trs_barang_tukar=true dikecualikan. Field berat dijumlahkan per baris sebagai gram.',
        demand: 'Per Jenis, pilih berat penjualan yang lebih besar antara bulan berjalan sampai hari ini dan tanggal kalender yang sama pada bulan yang sama tahun lalu. Bagi dengan jumlah hari pada periode acuan yang menang.',
        stock: 'tm_barang dengan status_hancur=false dan stock_on_hand>0; gram stok = berat × stock_on_hand. Tidak menggunakan deleted_by sebagai filter.',
        incoming: 'db_pntspst2.tt_kirim_barang dengan status_terima=OPEN dan tujuan sama dengan cabang; berat dijumlahkan dalam gram per baris.',
        risk: 'Risiko dinilai per Jenis. Cakupan hari = (stok fisik + OPEN masuk) ÷ kebutuhan gram harian. Proyeksi memperhitungkan konsumsi sampai akhir periode yang diminta.',
        horizonInterpretation: period.horizon === 'next-month'
          ? 'Bulan depan berarti dari awal bulan kalender berikutnya sampai hari terakhir bulan tersebut. Stok juga diproyeksikan melewati sisa hari bulan berjalan; risiko sebelum bulan depan ditampilkan terpisah.'
          : 'Minggu depan berarti tujuh hari sejak besok, setelah penjualan sampai tanggal analisis diperhitungkan.',
      },
      summary: {
        branchSources: sources.length,
        branchesAnalyzed: snapshots.filter((snapshot) => !snapshot.unavailableReason).length,
        branchesAtRisk: atRiskBranches.length,
        branchesAtRiskBeforeWindow: branchesAtRiskBeforeWindow.length,
        branchesAtRiskInWindow: branchesAtRiskInWindow.length,
        branchesWithIncompleteData: incompleteBranches.length,
        branchesUnavailable: unavailableBranches.length,
        incompleteOpenIncomingSource: Boolean(openIncoming.unavailableReason),
      },
      branches,
      unavailableSources: unavailableBranches.map(({ alias, branchId, unavailableReason }) => ({
        alias,
        branchId,
        reason: unavailableReason ?? 'Sumber tidak tersedia.',
      })),
      openIncomingUnavailableReason: openIncoming.unavailableReason ?? null,
      note: period.horizon === 'next-month'
        ? 'Risiko sebelum awal bulan depan dipisahkan dari risiko yang diperkirakan terjadi selama bulan depan. Data berat yang tidak lengkap tidak diperlakukan sebagai kepastian aman atau berisiko.'
        : 'Risiko dihitung dari cakupan gram stok per Jenis dibanding kebutuhan gram harian untuk tujuh hari sejak besok. Data berat yang tidak lengkap ditandai agar tidak menghasilkan kesimpulan pasti.',
    };
  }

  private analyzeBranch(
    snapshot: BranchSnapshot,
    period: RiskPeriod,
    openIncoming: OpenIncomingSnapshot,
  ): StockoutBranchResult {
    if (snapshot.unavailableReason) {
      return {
        branchId: snapshot.source.branchId,
        alias: snapshot.source.alias,
        status: 'unavailable',
        atRiskJenisCount: 0,
        atRiskBeforeWindowCount: 0,
        atRiskInWindowCount: 0,
        incompleteJenisCount: 0,
        worstCoverageDays: null,
        atRiskJenis: [],
        omittedAtRiskJenisCount: 0,
        incompleteJenis: [],
        unavailableReason: snapshot.unavailableReason,
      };
    }

    const inbound = openIncoming.byBranchAndJenis.get(snapshot.source.branchId) ?? new Map<string, WeightValue>();
    const codes = new Set([
      ...snapshot.jenisNames.keys(),
      ...snapshot.sales.keys(),
      ...snapshot.stock.keys(),
      ...inbound.keys(),
    ]);
    const projections: StockoutJenisResult[] = [];

    for (const code of codes) {
      const sales = snapshot.sales.get(code) ?? {
        selectedMonthWeight: 0,
        comparisonMonthWeight: 0,
        selectedMonthRowsWithoutWeight: 0,
        comparisonMonthRowsWithoutWeight: 0,
      };
      const stock = snapshot.stock.get(code) ?? { weight: 0, rowsWithoutWeight: 0 };
      const incoming = inbound.get(code) ?? { weight: 0, rowsWithoutWeight: 0 };
      const currentWeight = positive(sales.selectedMonthWeight);
      const comparisonWeight = positive(sales.comparisonMonthWeight);
      const selectedReference = currentWeight >= comparisonWeight;
      const referenceWeight = selectedReference ? currentWeight : comparisonWeight;
      const referenceDays = selectedReference ? period.selectedSalesDays : period.comparisonSalesDays;
      const dailyDemandWeight = referenceDays > 0 ? referenceWeight / referenceDays : 0;
      const physicalStockWeight = positive(stock.weight);
      const openIncomingWeight = positive(incoming.weight);
      const availableWeight = physicalStockWeight + openIncomingWeight;
      const daysUntilStockout = dailyDemandWeight > 0
        ? availableWeight <= 0 ? 0 : Math.ceil(availableWeight / dailyDemandWeight)
        : null;
      const expectedStockoutDate = daysUntilStockout === null
        ? null
        : daysUntilStockout === 0
          ? period.asOfDate
          : addDays(period.forecastStart, daysUntilStockout - 1);
      const projectedRemainingWeight = availableWeight - dailyDemandWeight * period.forecastDays;
      const complete = sales.selectedMonthRowsWithoutWeight <= 0
        && sales.comparisonMonthRowsWithoutWeight <= 0
        && stock.rowsWithoutWeight <= 0
        && incoming.rowsWithoutWeight <= 0
        && !openIncoming.unavailableReason;
      const riskTiming = assessRiskTiming({
        dailyDemandWeight,
        availableWeight,
        complete,
        expectedStockoutDate,
        windowStart: period.windowStart,
        windowEnd: period.windowEnd,
      });

      projections.push({
        kode: code,
        nama: snapshot.jenisNames.get(code) ?? code,
        selectedMonthSalesWeight: roundWeight(currentWeight),
        comparisonMonthSalesWeight: roundWeight(comparisonWeight),
        referenceSalesWeight: roundWeight(referenceWeight),
        referencePeriod: currentWeight === comparisonWeight ? 'tie' : selectedReference ? 'selected-month' : 'comparison-month',
        referenceDays,
        dailyDemandWeight: roundWeight(dailyDemandWeight),
        physicalStockWeight: roundWeight(physicalStockWeight),
        openIncomingWeight: roundWeight(openIncomingWeight),
        availableWeight: roundWeight(availableWeight),
        stockAtWindowStartWeight: roundWeight(Math.max(0, availableWeight - dailyDemandWeight * period.daysBeforeWindow)),
        demandDuringWindowWeight: roundWeight(dailyDemandWeight * period.windowDays),
        projectedRemainingWeight: roundWeight(projectedRemainingWeight),
        projectedDeficitWeight: roundWeight(Math.max(0, -projectedRemainingWeight)),
        coverageDays: dailyDemandWeight > 0 ? roundWeight(availableWeight / dailyDemandWeight) : null,
        daysUntilStockout,
        expectedStockoutDate,
        riskTiming,
        weightDataQuality: {
          selectedSalesRowsWithoutWeight: positive(sales.selectedMonthRowsWithoutWeight),
          comparisonSalesRowsWithoutWeight: positive(sales.comparisonMonthRowsWithoutWeight),
          stockRowsWithoutWeight: positive(stock.rowsWithoutWeight),
          openIncomingRowsWithoutWeight: positive(incoming.rowsWithoutWeight),
          openIncomingSourceUnavailable: Boolean(openIncoming.unavailableReason),
        },
      });
    }

    const atRiskJenis = projections
      .filter((jenis) => ['already-out', 'before-window', 'in-window'].includes(jenis.riskTiming))
      .sort((left, right) => (left.daysUntilStockout ?? Number.MAX_SAFE_INTEGER)
        - (right.daysUntilStockout ?? Number.MAX_SAFE_INTEGER)
        || right.dailyDemandWeight - left.dailyDemandWeight);
    const incompleteJenis = projections
      .filter((jenis) => jenis.riskTiming === 'incomplete')
      .map(({ kode, nama, weightDataQuality }) => ({ kode, nama, weightDataQuality }));
    const sellingJenis = projections.filter((jenis) => jenis.dailyDemandWeight > 0);
    const completeCoverages = sellingJenis
      .filter((jenis) => jenis.riskTiming !== 'incomplete' && jenis.coverageDays !== null)
      .map((jenis) => jenis.coverageDays as number);
    const atRiskBeforeWindowCount = atRiskJenis.filter((jenis) => jenis.riskTiming === 'already-out' || jenis.riskTiming === 'before-window').length;
    const atRiskInWindowCount = atRiskJenis.filter((jenis) => jenis.riskTiming === 'in-window').length;
    const status: StockoutBranchResult['status'] = atRiskJenis.length > 0
      ? 'at-risk'
      : incompleteJenis.length > 0
        ? 'incomplete'
        : sellingJenis.length > 0
          ? 'sufficient'
          : 'no-demand';

    return {
      branchId: snapshot.source.branchId,
      alias: snapshot.source.alias,
      status,
      atRiskJenisCount: atRiskJenis.length,
      atRiskBeforeWindowCount,
      atRiskInWindowCount,
      incompleteJenisCount: incompleteJenis.length,
      worstCoverageDays: completeCoverages.length ? roundWeight(Math.min(...completeCoverages)) : null,
      atRiskJenis: atRiskJenis.slice(0, MAX_RISK_JENIS_PER_BRANCH),
      omittedAtRiskJenisCount: Math.max(0, atRiskJenis.length - MAX_RISK_JENIS_PER_BRANCH),
      incompleteJenis,
    };
  }

  private async readBranch(source: StockoutRiskDataSource, period: RiskPeriod): Promise<BranchSnapshot> {
    const snapshot: BranchSnapshot = {
      source,
      stock: new Map(),
      sales: new Map(),
      jenisNames: new Map(),
    };

    try {
      const db = this.mongo.getDatabase(source.databaseName);
      const requiredCollections = ['tt_jual_detail', 'tm_barang', 'tm_dept'];
      const present = await db.listCollections({ name: { $in: requiredCollections } }, { nameOnly: true }).toArray();
      const presentNames = new Set(present.map((collection) => collection.name));
      const missing = requiredCollections.filter((collection) => !presentNames.has(collection));
      if (missing.length) {
        snapshot.unavailableReason = `Koleksi tidak tersedia: ${missing.join(', ')}.`;
        return snapshot;
      }

      const [sales, stock, departments] = await Promise.all([
        db.collection('tt_jual_detail').aggregate<SalesAggregateRow>(salesPipeline(period), {
          allowDiskUse: true,
          maxTimeMS: QUERY_MAX_TIME_MS,
        }).toArray(),
        db.collection('tm_barang').aggregate<WeightAggregateRow>(stockPipeline(), {
          allowDiskUse: true,
          maxTimeMS: QUERY_MAX_TIME_MS,
        }).toArray(),
        db.collection('tm_dept')
          .find({ status_aktif: true }, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
          .maxTimeMS(10_000)
          .toArray(),
      ]);

      sales.forEach((row) => {
        const code = cleanString(row._id?.jenis);
        if (!code) return;
        const current = snapshot.sales.get(code) ?? {
          selectedMonthWeight: 0,
          comparisonMonthWeight: 0,
          selectedMonthRowsWithoutWeight: 0,
          comparisonMonthRowsWithoutWeight: 0,
        };
        if (row._id?.period === 'selected-month') {
          current.selectedMonthWeight += positive(row.weight);
          current.selectedMonthRowsWithoutWeight += positive(row.rowsWithoutWeight);
        } else {
          current.comparisonMonthWeight += positive(row.weight);
          current.comparisonMonthRowsWithoutWeight += positive(row.rowsWithoutWeight);
        }
        snapshot.sales.set(code, current);
      });
      stock.forEach((row) => {
        const code = cleanString(row._id);
        if (code) snapshot.stock.set(code, {
          weight: positive(row.weight),
          rowsWithoutWeight: positive(row.rowsWithoutWeight),
        });
      });
      departments.forEach((row) => {
        const code = cleanString(row.kode_dept);
        if (!code) return;
        const name = decryptDepartmentName(row.nama_dept);
        snapshot.jenisNames.set(code, name || code);
      });
    } catch {
      snapshot.unavailableReason = 'Sumber cabang gagal dibaca atau melewati batas waktu.';
    }

    return snapshot;
  }

  private async readOpenIncoming(branchIds: string[]): Promise<OpenIncomingSnapshot> {
    const result: OpenIncomingSnapshot = { byBranchAndJenis: new Map() };
    if (branchIds.length === 0) return result;

    try {
      const db = this.mongo.getDatabase(env.shipmentSourceDatabaseName);
      const collectionExists = await db.listCollections({ name: 'tt_kirim_barang' }, { nameOnly: true }).hasNext();
      if (!collectionExists) {
        result.unavailableReason = 'Koleksi tt_kirim_barang tidak ditemukan pada sumber pengiriman Pusat.';
        return result;
      }
      const rows = await db.collection('tt_kirim_barang').aggregate<OpenIncomingAggregateRow>([
        {
          $match: {
            status_terima: 'OPEN',
            tujuan: { $in: branchIds },
            kode_dept: { $type: 'string', $ne: '' },
          },
        },
        {
          $project: {
            branchId: '$tujuan',
            jenis: '$kode_dept',
            weight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
          },
        },
        {
          $group: {
            _id: { branchId: '$branchId', jenis: '$jenis' },
            weight: { $sum: '$weight' },
            rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } },
          },
        },
      ], { allowDiskUse: true, maxTimeMS: QUERY_MAX_TIME_MS }).toArray();

      rows.forEach((row) => {
        const branchId = cleanString(row._id?.branchId);
        const code = cleanString(row._id?.jenis);
        if (!branchId || !code) return;
        const byJenis = result.byBranchAndJenis.get(branchId) ?? new Map<string, WeightValue>();
        byJenis.set(code, { weight: positive(row.weight), rowsWithoutWeight: positive(row.rowsWithoutWeight) });
        result.byBranchAndJenis.set(branchId, byJenis);
      });
    } catch {
      result.unavailableReason = 'Kiriman OPEN dari sumber pengiriman Pusat gagal dibaca.';
    }

    return result;
  }
}

function salesPipeline(period: RiskPeriod): Document[] {
  return [
    {
      $match: {
        ...validSalesMatch(),
        kode_dept: { $type: 'string', $ne: '' },
        $or: [
          { tgl_system: { $gte: period.selectedSalesFrom, $lte: period.selectedSalesThrough } },
          { tgl_system: { $gte: period.comparisonSalesFrom, $lte: period.comparisonSalesThrough } },
        ],
      },
    },
    {
      $project: {
        jenis: '$kode_dept',
        period: {
          $cond: [{ $gte: ['$tgl_system', period.selectedSalesFrom] }, 'selected-month', 'comparison-month'],
        },
        weight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
        quantity: { $convert: { input: '$qty', to: 'double', onError: 0, onNull: 0 } },
      },
    },
    { $match: { $or: [{ quantity: { $gt: 0 } }, { weight: { $gt: 0 } }] } },
    {
      $group: {
        _id: { jenis: '$jenis', period: '$period' },
        weight: { $sum: '$weight' },
        rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } },
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
        jenis: '$kode_dept',
        weight: {
          $multiply: [
            { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
            { $convert: { input: '$stock_on_hand', to: 'double', onError: 0, onNull: 0 } },
          ],
        },
        hasWeight: { $gt: [{ $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } }, 0] },
      },
    },
    {
      $group: {
        _id: '$jenis',
        weight: { $sum: '$weight' },
        rowsWithoutWeight: { $sum: { $cond: ['$hasWeight', 0, 1] } },
      },
    },
  ];
}

function buildRiskPeriod(horizon: StockoutRiskHorizon): RiskPeriod {
  const asOfDate = jakartaToday();
  const [year, month, day] = asOfDate.split('-').map(Number);
  const monthStart = `${year}-${pad2(month)}-01`;
  const selectedSalesDays = day;
  const comparisonYear = year - 1;
  const comparisonLastDay = daysInMonth(comparisonYear, month);
  const comparisonDay = Math.min(day, comparisonLastDay);
  const comparisonSalesFrom = `${comparisonYear}-${pad2(month)}-01`;
  const comparisonSalesThrough = `${comparisonYear}-${pad2(month)}-${pad2(comparisonDay)}`;
  const comparisonSalesDays = comparisonDay;
  const forecastStart = addDays(asOfDate, 1);

  if (horizon === 'next-week') {
    const windowEnd = addDays(forecastStart, 6);
    return {
      asOfDate,
      selectedMonth: `${year}-${pad2(month)}`,
      selectedSalesFrom: monthStart,
      selectedSalesThrough: asOfDate,
      selectedSalesDays,
      comparisonMonth: `${comparisonYear}-${pad2(month)}`,
      comparisonSalesFrom,
      comparisonSalesThrough,
      comparisonSalesDays,
      forecastStart,
      windowStart: forecastStart,
      windowEnd,
      daysBeforeWindow: 0,
      windowDays: 7,
      forecastDays: 7,
      horizon,
      horizonLabel: '7 hari ke depan',
    };
  }

  const nextMonthStart = monthStartForNextMonth(year, month);
  const [nextYear, nextMonth] = nextMonthStart.split('-').map(Number);
  const nextMonthEnd = `${nextYear}-${pad2(nextMonth)}-${pad2(daysInMonth(nextYear, nextMonth))}`;
  const daysBeforeWindow = Math.max(0, daysBetween(forecastStart, nextMonthStart));
  const windowDays = daysInMonth(nextYear, nextMonth);
  const forecastDays = daysBeforeWindow + windowDays;
  return {
    asOfDate,
    selectedMonth: `${year}-${pad2(month)}`,
    selectedSalesFrom: monthStart,
    selectedSalesThrough: asOfDate,
    selectedSalesDays,
    comparisonMonth: `${comparisonYear}-${pad2(month)}`,
    comparisonSalesFrom,
    comparisonSalesThrough,
    comparisonSalesDays,
    forecastStart,
    windowStart: nextMonthStart,
    windowEnd: nextMonthEnd,
    daysBeforeWindow,
    windowDays,
    forecastDays,
    horizon,
    horizonLabel: `bulan depan (${nextMonthStart}–${nextMonthEnd})`,
  };
}

function assessRiskTiming(input: {
  dailyDemandWeight: number;
  availableWeight: number;
  complete: boolean;
  expectedStockoutDate: string | null;
  windowStart: string;
  windowEnd: string;
}): RiskTiming {
  if (!input.complete) return 'incomplete';
  if (input.dailyDemandWeight <= 0) return 'no-demand';
  if (input.availableWeight <= 0) return 'already-out';
  if (!input.expectedStockoutDate) return 'no-demand';
  if (input.expectedStockoutDate < input.windowStart) return 'before-window';
  if (input.expectedStockoutDate <= input.windowEnd) return 'in-window';
  return 'after-window';
}

function jakartaToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(isoDate: string, amount: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthStartForNextMonth(year: number, month: number): string {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${pad2(nextMonth)}-01`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
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
