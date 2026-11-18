import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { AgentDataSourceConfig } from '../sources/source.types';
import { NetworkRestockSettingsService } from '../settings/network-restock-settings.service';
import { validSalesMatch } from './sales-query-policy';
import { Role } from '../users/roles';
import { AuthPrincipal } from '../users/user.types';
import { StockVsSalesBranchResult, StockVsSalesJenisRow, StockVsSalesResult } from './stock-vs-sales.types';

interface StockAnalysisSource {
  databaseName: string;
  alias: string;
  branchId: string;
}

interface StockAggregateRow {
  _id: string;
  weight: number;
  rowsWithoutWeight: number;
}

interface SalesAggregateRow {
  _id: string;
  weight: number;
  lineCount: number;
  rowsWithoutWeight: number;
}

interface OpenIncomingAggregateRow {
  _id: { branchId?: unknown; jenis?: unknown };
  weight: number;
  rowsWithoutWeight: number;
}

interface WeightedSnapshot {
  weight: number;
  rowsWithoutWeight: number;
}

interface BranchSnapshot {
  source: StockAnalysisSource;
  stock: Map<string, WeightedSnapshot>;
  sales: Map<string, WeightedSnapshot & { lineCount: number }>;
  jenisNames: Map<string, string>;
}

const MAX_CONCURRENT_BRANCH_QUERIES = 4;
const QUERY_MAX_TIME_MS = 45_000;
const RESERVED_DATABASES = new Set(['admin', 'local', 'config']);

@Injectable()
export class StockVsSalesService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
    private readonly settings: NetworkRestockSettingsService,
  ) {}

  async analyze(principal: AuthPrincipal, refresh = false): Promise<StockVsSalesResult> {
    const branchScope = principal.role === Role.Branch ? principal.branchId?.trim() ?? '' : null;
    if (principal.role === Role.Branch && !branchScope) {
      throw new ForbiddenException('Branch account has no branch scope');
    }

    const sourceFilter: Document = {
      active: true,
      sourceType: { $ne: 'central' },
      databaseName: { $nin: [...RESERVED_DATABASES, env.systemDatabaseName] },
    };
    if (branchScope) sourceFilter.branchId = branchScope;

    const sources = await this.mongo.db.collection<AgentDataSourceConfig>('shipment_sources')
      .find(sourceFilter, { projection: { _id: 0, databaseName: 1, alias: 1, branchId: 1 } })
      .sort({ branchId: 1, alias: 1 })
      .toArray() as StockAnalysisSource[];

    if (branchScope && sources.length === 0) {
      throw new ForbiddenException('No active data source configured for this branch');
    }

    const safeStockDays = await this.settings.getSafeStockDays();
    const periodBase = currentMonthPeriodDateBounds();
    const period: StockVsSalesResult['period'] = {
      month: periodBase.dateFrom.slice(0, 7),
      ...periodBase,
      safeStockDays,
      timezone: 'Asia/Jakarta',
    };
    const key = `sales:stock-vs-sales:v3:${JSON.stringify({
      dateFrom: period.dateFrom,
      dateThrough: period.dateThrough,
      safeStockDays,
      role: principal.role,
      branchScope,
      sources: sources.map(({ databaseName, alias, branchId }) => ({ databaseName, alias, branchId })),
    })}`;

    if (refresh) this.cache.clearByPrefix(key);

    return this.cache.getOrLoad(key, () => this.loadAnalysis(sources, period));
  }

  private async loadAnalysis(
    sources: StockAnalysisSource[],
    period: StockVsSalesResult['period'],
  ): Promise<StockVsSalesResult> {
    if (!sources.length) return buildResult(period, [], []);

    const branchIds = new Set(sources.map((source) => source.branchId));
    const [snapshots, openIncoming] = await Promise.all([
      mapWithConcurrency(sources, MAX_CONCURRENT_BRANCH_QUERIES, (source) => this.readBranch(source, period)),
      this.readOpenIncoming([...branchIds]),
    ]);
    const codes = new Set<string>();
    const namesByCode = new Map<string, string>();
    snapshots.forEach((snapshot) => {
      snapshot.jenisNames.forEach((name, code) => {
        codes.add(code);
        if (name && !namesByCode.has(code)) namesByCode.set(code, name);
      });
      snapshot.stock.forEach((_stock, code) => codes.add(code));
      snapshot.sales.forEach((_sales, code) => codes.add(code));
    });
    openIncoming.forEach((byJenis) => byJenis.forEach((_incoming, code) => codes.add(code)));

    const sortedCodes = [...codes].sort((left, right) => left.localeCompare(right));
    const branches = snapshots.map((snapshot) => {
      const rows = sortedCodes.map((code) => {
        const stock = snapshot.stock.get(code);
        const incoming = openIncoming.get(snapshot.source.branchId)?.get(code);
        const sales = snapshot.sales.get(code);
        return buildJenisRow(
          code,
          namesByCode.get(code) ?? code,
          stock?.weight ?? 0,
          incoming?.weight ?? 0,
          sales?.weight ?? 0,
          sales?.lineCount ?? 0,
          sales?.rowsWithoutWeight ?? 0,
          stock?.rowsWithoutWeight ?? 0,
          incoming?.rowsWithoutWeight ?? 0,
          period.elapsedDays,
          period.safeStockDays,
        );
      });
      return buildBranchResult(snapshot.source, rows, period.safeStockDays);
    });

    return buildResult(period, branches, sortedCodes);
  }

  private async readBranch(source: StockAnalysisSource, period: StockVsSalesResult['period']): Promise<BranchSnapshot> {
    try {
      const db = this.mongo.getDatabase(source.databaseName);
      const [sales, stock, departments] = await Promise.all([
        db.collection('tt_jual_detail').aggregate<SalesAggregateRow>([
          {
            $match: {
              ...validSalesMatch(),
              tgl_system: { $gte: period.dateFrom, $lte: period.dateThrough },
              kode_dept: { $type: 'string', $ne: '' },
            },
          },
          {
            $project: {
              jenis: '$kode_dept',
              weight: { $convert: { input: '$berat', to: 'double', onError: 0, onNull: 0 } },
              hasSale: { $gt: [{ $convert: { input: '$qty', to: 'double', onError: 0, onNull: 0 } }, 0] },
            },
          },
          { $match: { $or: [{ hasSale: true }, { weight: { $gt: 0 } }] } },
          { $group: {
            _id: '$jenis',
            weight: { $sum: '$weight' },
            lineCount: { $sum: 1 },
            rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } },
          } },
        ], { allowDiskUse: true, maxTimeMS: QUERY_MAX_TIME_MS }).toArray(),
        db.collection('tm_barang').aggregate<StockAggregateRow>([
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
          { $group: {
            _id: '$jenis',
            weight: { $sum: '$stockWeight' },
            rowsWithoutWeight: { $sum: '$rowWithoutWeight' },
          } },
        ], { allowDiskUse: true, maxTimeMS: QUERY_MAX_TIME_MS }).toArray(),
        db.collection('tm_dept')
          .find({ status_aktif: true }, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
          .maxTimeMS(10_000)
          .toArray(),
      ]);

      const snapshot: BranchSnapshot = {
        source,
        stock: new Map(),
        sales: new Map(),
        jenisNames: new Map(),
      };
      stock.forEach((row) => {
        const code = cleanString(row._id);
        if (code) snapshot.stock.set(code, {
          weight: positive(row.weight),
          rowsWithoutWeight: positive(row.rowsWithoutWeight),
        });
      });
      sales.forEach((row) => {
        const code = cleanString(row._id);
        if (code) snapshot.sales.set(code, {
          weight: positive(row.weight),
          lineCount: positive(row.lineCount),
          rowsWithoutWeight: positive(row.rowsWithoutWeight),
        });
      });
      departments.forEach((row) => {
        const code = cleanString(row.kode_dept);
        if (!code) return;
        const name = decryptDepartmentName(row.nama_dept);
        if (name) snapshot.jenisNames.set(code, name);
        else if (!snapshot.jenisNames.has(code)) snapshot.jenisNames.set(code, code);
      });
      return snapshot;
    } catch {
      throw new ServiceUnavailableException(
        `Analisis stok vs penjualan gagal membaca sumber cabang ${source.alias} (${source.branchId}). Periksa koneksi dan koleksi tt_jual_detail, tm_barang, serta tm_dept.`,
      );
    }
  }

  private async readOpenIncoming(branchIds: string[]): Promise<Map<string, Map<string, WeightedSnapshot>>> {
    if (!branchIds.length) return new Map();

    try {
      const db = this.mongo.getDatabase(env.shipmentSourceDatabaseName);
      const exists = await db.listCollections({ name: 'tt_kirim_barang' }, { nameOnly: true }).hasNext();
      if (!exists) {
        throw new ServiceUnavailableException(
          `Koleksi tt_kirim_barang tidak ditemukan pada sumber pengiriman Pusat (${env.shipmentSourceDatabaseName}).`,
        );
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

      const result = new Map<string, Map<string, WeightedSnapshot>>();
      rows.forEach((row) => {
        const branchId = cleanString(row._id?.branchId);
        const code = cleanString(row._id?.jenis);
        if (!branchId || !code) return;
        const byJenis = result.get(branchId) ?? new Map<string, WeightedSnapshot>();
        byJenis.set(code, {
          weight: positive(row.weight),
          rowsWithoutWeight: positive(row.rowsWithoutWeight),
        });
        result.set(branchId, byJenis);
      });
      return result;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        'Analisis stok vs penjualan gagal membaca kiriman OPEN dari sumber pengiriman Pusat. Periksa koneksi dan koleksi tt_kirim_barang.',
      );
    }
  }
}

function buildJenisRow(
  code: string,
  name: string,
  physicalStockWeight: number,
  openIncomingWeight: number,
  soldWeightMonth: number,
  soldLinesMonth: number,
  salesLinesWithoutWeight: number,
  stockRecordsWithoutWeight: number,
  openShipmentLinesWithoutWeight: number,
  elapsedDays: number,
  safeStockDays: number,
): StockVsSalesJenisRow {
  const availableWeight = roundWeight(physicalStockWeight + openIncomingWeight);
  const averageSalesWeightPerDay = elapsedDays > 0 ? roundWeight(soldWeightMonth / elapsedDays) : 0;
  const coverageDays = averageSalesWeightPerDay > 0 ? roundWeight(availableWeight / averageSalesWeightPerDay) : null;
  let status: StockVsSalesJenisRow['status'];
  let recommendation: string;

  if (salesLinesWithoutWeight > 0 && soldWeightMonth === 0) {
    status = 'weight-missing';
    recommendation = `${formatCount(salesLinesWithoutWeight)} baris penjualan valid tidak memiliki berat positif; total penjualan gram belum dapat dipastikan.`;
  } else if (soldWeightMonth > 0 && coverageDays !== null && coverageDays <= safeStockDays) {
    status = 'restock-review';
    recommendation = `Terjual ${formatWeight(soldWeightMonth)} gram bulan ini. Stok fisik + OPEN ${formatWeight(availableWeight)} gram; cakupan sekitar ${formatWeight(coverageDays)} hari, di bawah stok aman ${safeStockDays} hari.`;
  } else if (soldWeightMonth > 0 && physicalStockWeight <= 0 && openIncomingWeight > 0) {
    status = 'incoming';
    recommendation = `Terjual ${formatWeight(soldWeightMonth)} gram bulan ini; stok fisik kosong dan ${formatWeight(openIncomingWeight)} gram sedang dikirim. Pantau penerimaan.`;
  } else if (soldWeightMonth > 0) {
    recommendation = `Terjual ${formatWeight(soldWeightMonth)} gram bulan ini. Stok fisik + OPEN ${formatWeight(availableWeight)} gram; cakupan sekitar ${formatWeight(coverageDays ?? 0)} hari.`;
    status = 'healthy';
  } else if (availableWeight > 0) {
    status = 'no-sales';
    recommendation = `Belum ada penjualan gram yang tercatat bulan ini, sementara stok fisik + OPEN ${formatWeight(availableWeight)} gram.`;
  } else {
    status = 'no-activity';
    recommendation = 'Belum ada stok atau penjualan gram tercatat bulan ini; cek kebutuhan sebelum mengirim barang.';
  }

  const missingDataNotes = [
    stockRecordsWithoutWeight > 0 ? `${formatCount(stockRecordsWithoutWeight)} catatan stok tanpa berat` : '',
    openShipmentLinesWithoutWeight > 0 ? `${formatCount(openShipmentLinesWithoutWeight)} baris OPEN tanpa berat` : '',
    salesLinesWithoutWeight > 0 && soldWeightMonth > 0 ? `${formatCount(salesLinesWithoutWeight)} baris penjualan tanpa berat` : '',
  ].filter(Boolean);
  if (missingDataNotes.length) recommendation += ` Data berat belum lengkap: ${missingDataNotes.join(', ')}.`;

  return {
    kode: code,
    nama: name,
    physicalStockWeight: roundWeight(physicalStockWeight),
    openIncomingWeight: roundWeight(openIncomingWeight),
    availableWeight,
    soldWeightMonth: roundWeight(soldWeightMonth),
    soldLinesMonth: roundCount(soldLinesMonth),
    salesLinesWithoutWeight: roundCount(salesLinesWithoutWeight),
    stockRecordsWithoutWeight: roundCount(stockRecordsWithoutWeight),
    openShipmentLinesWithoutWeight: roundCount(openShipmentLinesWithoutWeight),
    averageSalesWeightPerDay,
    coverageDays,
    status,
    recommendation,
  };
}

function buildBranchResult(
  source: StockAnalysisSource,
  jenis: StockVsSalesJenisRow[],
  safeStockDays: number,
): StockVsSalesBranchResult {
  const soldWeightMonth = roundWeight(jenis.reduce((sum, row) => sum + row.soldWeightMonth, 0));
  const topSellingJenis = jenis
    .filter((row) => row.soldWeightMonth > 0)
    .sort((left, right) => right.soldWeightMonth - left.soldWeightMonth || left.kode.localeCompare(right.kode))
    .slice(0, 5)
    .map((row) => ({
      kode: row.kode,
      nama: row.nama,
      soldWeightMonth: row.soldWeightMonth,
      shareOfBranchWeightPercent: soldWeightMonth > 0 ? roundWeight((row.soldWeightMonth / soldWeightMonth) * 100) : 0,
    }));
  const lowCoverageWithSales = jenis
    .filter((row) => row.soldWeightMonth > 0 && row.coverageDays !== null && row.coverageDays <= safeStockDays)
    .sort((left, right) => (left.coverageDays ?? 0) - (right.coverageDays ?? 0) || right.soldWeightMonth - left.soldWeightMonth)
    .slice(0, 5)
    .map((row) => ({
      kode: row.kode,
      nama: row.nama,
      soldWeightMonth: row.soldWeightMonth,
      availableWeight: row.availableWeight,
      coverageDays: row.coverageDays ?? 0,
    }));
  const stockWithoutSales = jenis
    .filter((row) => row.availableWeight > 0 && row.soldWeightMonth === 0)
    .sort((left, right) => right.availableWeight - left.availableWeight || left.kode.localeCompare(right.kode))
    .slice(0, 5)
    .map((row) => ({ kode: row.kode, nama: row.nama, availableWeight: row.availableWeight }));
  const suggestions: string[] = [];

  if (topSellingJenis.length) {
    const best = topSellingJenis[0];
    suggestions.push(`Jenis ${best.kode} (${best.nama}) paling laku bulan ini: ${formatWeight(best.soldWeightMonth)} gram, setara ${formatWeight(best.shareOfBranchWeightPercent)}% dari berat terjual cabang.`);
  } else if (jenis.some((row) => row.salesLinesWithoutWeight > 0)) {
    suggestions.push('Ada transaksi valid bulan ini yang beratnya tidak tercatat; lengkapi data berat sebelum menyimpulkan tidak ada penjualan.');
  } else {
    suggestions.push('Belum ada penjualan gram valid bulan ini; seluruh Jenis tetap ditampilkan, termasuk yang bernilai nol.');
  }
  if (lowCoverageWithSales.length) {
    suggestions.push(`Tinjau stok aman ${safeStockDays} hari untuk Jenis ${lowCoverageWithSales.slice(0, 3).map((row) => `${row.kode} (cakupan sekitar ${formatWeight(row.coverageDays)} hari)`).join(', ')}.`);
  }
  if (stockWithoutSales.length) {
    suggestions.push(`Tinjau stok Jenis ${stockWithoutSales.slice(0, 3).map((row) => row.kode).join(', ')} yang belum memiliki penjualan gram tercatat bulan ini sebelum menambah kiriman.`);
  }

  return {
    branchId: source.branchId,
    alias: source.alias,
    totals: {
      physicalStockWeight: roundWeight(jenis.reduce((sum, row) => sum + row.physicalStockWeight, 0)),
      openIncomingWeight: roundWeight(jenis.reduce((sum, row) => sum + row.openIncomingWeight, 0)),
      availableWeight: roundWeight(jenis.reduce((sum, row) => sum + row.availableWeight, 0)),
      soldWeightMonth,
      salesLinesWithoutWeight: jenis.reduce((sum, row) => sum + row.salesLinesWithoutWeight, 0),
      stockRecordsWithoutWeight: jenis.reduce((sum, row) => sum + row.stockRecordsWithoutWeight, 0),
      openShipmentLinesWithoutWeight: jenis.reduce((sum, row) => sum + row.openShipmentLinesWithoutWeight, 0),
      jenisWithSales: jenis.filter((row) => row.soldWeightMonth > 0).length,
      jenisWithNoSales: jenis.filter((row) => row.soldWeightMonth === 0 && row.salesLinesWithoutWeight === 0).length,
      jenisWithIncompleteSalesWeight: jenis.filter((row) => row.salesLinesWithoutWeight > 0).length,
    },
    analysis: { topSellingJenis, lowCoverageWithSales, stockWithoutSales, suggestions },
    jenis: jenis.sort((left, right) => right.soldWeightMonth - left.soldWeightMonth || left.kode.localeCompare(right.kode)),
  };
}

function buildResult(
  period: StockVsSalesResult['period'],
  branches: StockVsSalesBranchResult[],
  codes: string[],
): StockVsSalesResult {
  return {
    period,
    policy: {
      stock: 'tm_barang: status_hancur=false dan stock_on_hand>0; gram stok = berat gram × stock_on_hand, dijumlahkan per Jenis.',
      weight: 'Penjualan dan kiriman menjumlahkan field berat per baris sebagai gram; stok dikalikan dengan stock_on_hand. Nilai barang tanpa berat positif ditandai terpisah.',
      openIncoming: 'db_pntspst2.tt_kirim_barang dengan status_terima=OPEN dan tujuan sama dengan branchId; yang dihitung hanya gram dari field berat.',
      sales: 'tt_jual_detail bulan berjalan, status_kembali=OPEN, status_valid=DONE, dan transaksi tukar dikecualikan. Jumlah gram berasal dari field berat, bukan qty × berat.',
      coverage: `Cakupan = (gram stok fisik + gram kiriman OPEN) ÷ rata-rata gram terjual per hari. Perlu ditinjau bila cakupan ≤ ${period.safeStockDays} hari stok aman dari Pengaturan.`,
    },
    totals: {
      branchCount: branches.length,
      jenisCount: codes.length,
      physicalStockWeight: roundWeight(branches.reduce((sum, branch) => sum + branch.totals.physicalStockWeight, 0)),
      openIncomingWeight: roundWeight(branches.reduce((sum, branch) => sum + branch.totals.openIncomingWeight, 0)),
      availableWeight: roundWeight(branches.reduce((sum, branch) => sum + branch.totals.availableWeight, 0)),
      soldWeightMonth: roundWeight(branches.reduce((sum, branch) => sum + branch.totals.soldWeightMonth, 0)),
      salesLinesWithoutWeight: branches.reduce((sum, branch) => sum + branch.totals.salesLinesWithoutWeight, 0),
      stockRecordsWithoutWeight: branches.reduce((sum, branch) => sum + branch.totals.stockRecordsWithoutWeight, 0),
      openShipmentLinesWithoutWeight: branches.reduce((sum, branch) => sum + branch.totals.openShipmentLinesWithoutWeight, 0),
      jenisWithSales: branches.reduce((sum, branch) => sum + branch.totals.jenisWithSales, 0),
      jenisWithNoSales: branches.reduce((sum, branch) => sum + branch.totals.jenisWithNoSales, 0),
      jenisWithIncompleteSalesWeight: branches.reduce((sum, branch) => sum + branch.totals.jenisWithIncompleteSalesWeight, 0),
    },
    branches,
  };
}

function currentMonthPeriodDateBounds(): { dateFrom: string; dateThrough: string; elapsedDays: number } {
  const jakartaNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const year = jakartaNow.getUTCFullYear();
  const month = jakartaNow.getUTCMonth();
  const elapsedDays = jakartaNow.getUTCDate();
  return {
    dateFrom: `${year}-${String(month + 1).padStart(2, '0')}-01`,
    dateThrough: `${year}-${String(month + 1).padStart(2, '0')}-${String(elapsedDays).padStart(2, '0')}`,
    elapsedDays,
  };
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positive(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function roundWeight(value: number): number {
  return Number(value.toFixed(3));
}

function roundCount(value: number): number {
  return Math.round(positive(value));
}

function formatWeight(value: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(value);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(value);
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let failure: unknown;
  let hasFailure = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!hasFailure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        failure = error;
        hasFailure = true;
      }
    }
  });
  await Promise.all(workers);
  if (hasFailure) throw failure;
  return results;
}
